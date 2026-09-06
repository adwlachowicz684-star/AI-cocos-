/**
 * QuestSystem —— 任务系统
 *
 * 【它解决什么】
 *
 * 任务（Quest）至少要做对这四件事，每一件手写都容易漏：
 *
 * - **目标追踪**：杀 5 只史莱姆 / 收集 3 个矿石 / 到达某处 / 和某人对话。
 *   这些目标的**完成条件完全不同**，但对外要有一致的接口。
 * - **进度持久化**：中途退出，回来还要是这个进度。
 * - **任务链**：B 任务要在 A 完成后才出现（前置依赖）。
 * - **奖励发放**：完成时给经验/金币/物品，**且只能发一次**。
 *
 * 【最容易出的 bug】
 * ① 同一个击杀被两个任务同时计数时算错（应该都算，除非标记了独占）
 * ② 任务完成后还能继续计数，导致进度显示 7/5
 * ③ 奖励发了两次（网络重连、存档回档）
 * ④ 前置任务没完成但任务已经显示在列表里
 *
 * 【设计：目标由"计数器"驱动，而不是回调】
 * 常见做法是给每个任务注册一堆事件监听（onKill / onCollect...）。
 * 问题是任务多了以后，监听的注册/注销时机很容易错。
 *
 * 这里反过来：游戏里发生一件事就调 `report(event)`，
 * 系统内部去匹配哪些目标关心它。**加任务不用改游戏代码**。
 *
 * 【使用示例】
 * ```typescript
 * const q = new QuestSystem();
 *
 * q.define({
 *   id: 'kill_slimes',
 *   name: '清理史莱姆',
 *   objectives: [
 *     { type: 'kill', target: 'slime', count: 5 },
 *   ],
 *   rewards: { exp: 100, gold: 50 },
 * });
 *
 * q.define({
 *   id: 'boss',
 *   name: '讨伐史莱姆王',
 *   requires: ['kill_slimes'],        // ← 前置
 *   objectives: [{ type: 'kill', target: 'slime_king', count: 1 }],
 *   rewards: { exp: 500 },
 * });
 *
 * q.accept('kill_slimes');
 * q.available;                        // ['boss'] 还不可接（前置未完成）
 *
 * q.report({ type: 'kill', target: 'slime' });     // 1/5
 * q.report({ type: 'kill', target: 'slime', n: 4 }); // 5/5 → 自动完成
 *
 * q.status('kill_slimes');            // 'completed'
 * q.available;                        // ['boss'] 现在可接了
 *
 * q.claim('kill_slimes');             // 领奖（只能领一次）
 * q.claim('kill_slimes');             // false（已领过）
 * ```
 *
 * 【无引擎依赖】
 */

export type QuestStatus = 'locked' | 'available' | 'active' | 'completed' | 'claimed' | 'failed';

/** 目标类型（可扩展：加新类型只需在 _matches 里加一个分支） */
export type ObjectiveType = 'kill' | 'collect' | 'reach' | 'talk' | 'custom';

export interface Objective {
  readonly type: ObjectiveType;
  /** 目标对象 id（怪物 id / 物品 id / 地点 id / NPC id） */
  readonly target: string;
  /** 需要多少个（默认 1） */
  readonly count?: number;
  /** 描述（可选，用于 UI） */
  readonly desc?: string;
  /** 自定义判定（type='custom' 时用） */
  readonly test?: (event: QuestEvent) => boolean;
}

export interface QuestDef {
  readonly id: string;
  readonly name: string;
  readonly desc?: string;
  /** 目标列表（全部完成才算任务完成） */
  readonly objectives: readonly Objective[];
  /** 前置任务 id */
  readonly requires?: readonly string[];
  /** 奖励 */
  readonly rewards?: Record<string, number>;
  /** 是否自动接取（不需要手动 accept） */
  readonly autoAccept?: boolean;
  /** 是否可重复完成 */
  readonly repeatable?: boolean;
}

/** 游戏里发生的事件 */
export interface QuestEvent {
  readonly type: ObjectiveType | string;
  readonly target?: string;
  /** 数量（默认 1） */
  readonly n?: number;
}

export interface QuestProgress {
  readonly defId: string;
  readonly status: QuestStatus;
  /** 每个目标的当前进度 */
  readonly progress: readonly number[];
  /** 是否已领奖 */
  readonly claimed: boolean;
}

export class QuestSystem {
  private readonly _defs = new Map<string, QuestDef>();
  private readonly _progress = new Map<string, QuestProgress>();

  /** 完成回调（用于发放奖励、弹提示） */
  private _onComplete: ((defId: string, rewards?: Record<string, number>) => void) | null = null;
  private _onProgress: ((defId: string, objIndex: number, current: number, need: number) => void) | null = null;

  constructor() {}

  // ==================== 定义 ====================

  define(def: QuestDef): this {
    if (this._defs.has(def.id)) throw new Error(`[Quest] 任务 "${def.id}" 已存在`);
    if (def.objectives.length === 0) throw new Error(`[Quest] ${def.id}: 至少要有一个目标`);

    this._defs.set(def.id, def);
    this._progress.set(def.id, {
      defId: def.id,
      status: (def.requires?.length ?? 0) > 0 ? 'locked' : 'available',
      progress: def.objectives.map(() => 0),
      claimed: false,
    });

    if (def.autoAccept) this.accept(def.id);
    return this;
  }

  /** 批量定义（会自动校验前置是否存在） */
  defineAll(defs: readonly QuestDef[]): string[] {
    const errors: string[] = [];
    for (const d of defs) {
      if (this._defs.has(d.id)) {
        errors.push(`任务 "${d.id}" 重复定义`);
        continue;
      }
      this._defs.set(d.id, d);
      this._progress.set(d.id, {
        defId: d.id,
        status: (d.requires?.length ?? 0) > 0 ? 'locked' : 'available',
        progress: d.objectives.map(() => 0),
        claimed: false,
      });
    }
    // 校验前置
    for (const d of defs) {
      for (const req of d.requires ?? []) {
        if (!this._defs.has(req)) errors.push(`任务 "${d.id}" 的前置 "${req}" 不存在`);
      }
    }
    for (const d of defs) if (d.autoAccept) this.accept(d.id);
    return errors;
  }

  // ==================== 状态 ====================

  status(defId: string): QuestStatus | undefined {
    return this._progress.get(defId)?.status;
  }

  get(defId: string): QuestProgress | undefined {
    return this._progress.get(defId);
  }

  /** 可接（前置已完成，还没接） */
  get available(): string[] {
    const out: string[] = [];
    for (const [id, p] of this._progress) {
      if (p.status === 'available') out.push(id);
    }
    return out;
  }

  get active(): string[] {
    const out: string[] = [];
    for (const [id, p] of this._progress) {
      if (p.status === 'active') out.push(id);
    }
    return out;
  }

  get completed(): string[] {
    const out: string[] = [];
    for (const [id, p] of this._progress) {
      if (p.status === 'completed' || p.status === 'claimed') out.push(id);
    }
    return out;
  }

  /** 是否已领奖（**发奖励前必须查这个**，这是防重复发奖的唯一可靠依据） */
  isClaimed(defId: string): boolean {
    return this._progress.get(defId)?.claimed ?? false;
  }

  // ==================== 接取与流转 ====================

  /** 接取 */
  accept(defId: string): boolean {
    const p = this._progress.get(defId);
    if (!p) return false;
    if (p.status !== 'available') return false;

    this._setStatus(defId, 'active');
    return true;
  }

  /** 放弃（进度清零） */
  abandon(defId: string): boolean {
    const p = this._progress.get(defId);
    if (!p) return false;
    if (p.status !== 'active' && p.status !== 'failed') return false;

    this._progress.set(defId, {
      ...p,
      status: 'available',
      progress: p.progress.map(() => 0),
      claimed: false,
    });
    return true;
  }

  /** 失败（限时任务超时） */
  fail(defId: string): boolean {
    const p = this._progress.get(defId);
    if (!p || p.status !== 'active') return false;
    this._setStatus(defId, 'failed');
    return true;
  }

  // ==================== 进度上报（核心） ====================

  /**
   * 上报一个游戏事件
   *
   * 【为什么是"上报"而不是"注册监听"】
   * 注册监听的做法：每个任务自己 on('kill', handler)，
   * 任务多了以后监听的注册/注销时机极容易错，而且漏注销会导致对象泄漏。
   *
   * 上报的做法：游戏里发生一件事就调一次 report，
   * 系统内部遍历所有**进行中**的任务去匹配。
   * 加新任务不用改任何游戏代码。
   *
   * @returns 有多少个任务的进度因此发生了变化
   */
  report(event: QuestEvent): number {
    let changed = 0;
    const n = event.n ?? 1;

    // 拷贝一份，因为完成会触发回调，回调里可能接新任务
    const activeIds = this.active;

    for (const id of activeIds) {
      const def = this._defs.get(id)!;
      const p = this._progress.get(id)!;
      if (p.status !== 'active') continue;

      let anyChanged = false;
      const next = p.progress.slice();

      for (let i = 0; i < def.objectives.length; i++) {
        const obj = def.objectives[i];
        const need = obj.count ?? 1;

        // 已完成的目标不再累加（否则会显示 7/5）
        if (next[i] >= need) continue;

        if (this._matches(obj, event)) {
          next[i] = Math.min(need, next[i] + n);
          anyChanged = true;
          this._onProgress?.(id, i, next[i], need);
        }
      }

      if (anyChanged) {
        changed++;
        this._progress.set(id, { ...p, progress: next });

        // 检查是否全部完成
        if (this._isAllDone(def, next)) {
          this._setStatus(id, 'completed');
          this._onComplete?.(id, def.rewards);
          this._unlockDependents(id);
        }
      }
    }

    // autoAccept 的任务：locked → 检查前置
    this._refreshLocks();
    return changed;
  }

  /** 直接设置进度（调试 / 存档回档用） */
  setProgress(defId: string, objIndex: number, value: number): boolean {
    const p = this._progress.get(defId);
    const def = this._defs.get(defId);
    if (!p || !def) return false;
    if (objIndex < 0 || objIndex >= def.objectives.length) return false;

    const next = p.progress.slice();
    next[objIndex] = Math.max(0, value);
    this._progress.set(defId, { ...p, progress: next });

    if (this._isAllDone(def, next) && p.status === 'active') {
      this._setStatus(defId, 'completed');
      this._onComplete?.(defId, def.rewards);
      this._unlockDependents(defId);
    }
    return true;
  }

  // ==================== 领奖 ====================

  /**
   * 领取奖励
   *
   * 【为什么把"完成"和"领奖"分开】
   * 让玩家手动领奖有两个好处：
   * ① 能弹一个"任务完成 + 奖励列表"的界面，给正反馈
   * ② 万一奖励发放失败（比如背包满），可以稍后重试，而不是丢掉
   *
   * 【只能领一次】这是防重复发奖的最后一道闸。
   */
  claim(defId: string): Record<string, number> | null {
    const p = this._progress.get(defId);
    const def = this._defs.get(defId);
    if (!p || !def) return null;
    if (p.status !== 'completed') return null;
    if (p.claimed) return null;

    this._progress.set(defId, { ...p, claimed: true, status: 'claimed' });

    if (def.repeatable) {
      // 可重复任务：回到可接状态，进度清零
      this._progress.set(defId, {
        defId,
        status: 'available',
        progress: def.objectives.map(() => 0),
        claimed: false,
      });
    }

    return def.rewards ?? {};
  }

  // ==================== 查询与存档 ====================

  /** 目标的完成度（UI 显示 "3/5"） */
  objectiveProgress(defId: string, objIndex: number): { current: number; need: number } | null {
    const def = this._defs.get(defId);
    const p = this._progress.get(defId);
    if (!def || !p) return null;
    if (objIndex < 0 || objIndex >= def.objectives.length) return null;
    return { current: p.progress[objIndex], need: def.objectives[objIndex].count ?? 1 };
  }

  /** 整体完成度 0~1 */
  completionRatio(defId: string): number {
    const def = this._defs.get(defId);
    const p = this._progress.get(defId);
    if (!def || !p) return 0;

    let cur = 0;
    let need = 0;
    for (let i = 0; i < def.objectives.length; i++) {
      const n = def.objectives[i].count ?? 1;
      need += n;
      cur += Math.min(n, p.progress[i]);
    }
    return need === 0 ? 0 : cur / need;
  }

  onComplete(fn: (defId: string, rewards?: Record<string, number>) => void): () => void {
    this._onComplete = fn;
    return () => {
      if (this._onComplete === fn) this._onComplete = null;
    };
  }

  onProgress(fn: (defId: string, objIndex: number, current: number, need: number) => void): () => void {
    this._onProgress = fn;
    return () => {
      if (this._onProgress === fn) this._onProgress = null;
    };
  }

  export(): Array<{ id: string; status: QuestStatus; progress: number[]; claimed: boolean }> {
    return Array.from(this._progress.values()).map((p) => ({
      id: p.defId,
      status: p.status,
      progress: [...p.progress],
      claimed: p.claimed,
    }));
  }

  import(data: ReadonlyArray<{ id: string; status: QuestStatus; progress?: number[]; claimed?: boolean }>): number {
    let skipped = 0;
    for (const e of data) {
      const def = this._defs.get(e.id);
      if (!def) {
        skipped++;
        continue;
      }
      const progress = e.progress ?? def.objectives.map(() => 0);
      // 长度不匹配时补齐/截断（版本更新改了目标数量）
      const fixed = def.objectives.map((_, i) => progress[i] ?? 0);
      this._progress.set(e.id, {
        defId: e.id,
        status: e.status,
        progress: fixed,
        claimed: e.claimed ?? false,
      });
    }
    return skipped;
  }

  reset(): void {
    for (const [id, def] of this._defs) {
      this._progress.set(id, {
        defId: id,
        status: (def.requires?.length ?? 0) > 0 ? 'locked' : 'available',
        progress: def.objectives.map(() => 0),
        claimed: false,
      });
    }
  }

  destroy(): void {
    this._defs.clear();
    this._progress.clear();
    this._onComplete = null;
    this._onProgress = null;
  }

  // ==================== 内部 ====================

  private _matches(obj: Objective, event: QuestEvent): boolean {
    if (obj.type === 'custom') return obj.test ? obj.test(event) : false;
    if (obj.type !== event.type) return false;
    if (event.target !== undefined && obj.target !== event.target) return false;
    return true;
  }

  private _isAllDone(def: QuestDef, progress: readonly number[]): boolean {
    for (let i = 0; i < def.objectives.length; i++) {
      if (progress[i] < (def.objectives[i].count ?? 1)) return false;
    }
    return true;
  }

  private _setStatus(defId: string, status: QuestStatus): void {
    const p = this._progress.get(defId);
    if (!p) return;
    this._progress.set(defId, { ...p, status });
  }

  /** 某任务完成后，解锁以它为前置的任务 */
  private _unlockDependents(defId: string): void {
    for (const [id, def] of this._defs) {
      const p = this._progress.get(id);
      if (!p || p.status !== 'locked') continue;
      if (!def.requires?.includes(defId)) continue;

      if (this._requiresMet(def)) {
        this._setStatus(id, 'available');
        if (def.autoAccept) this.accept(id);
      }
    }
  }

  private _requiresMet(def: QuestDef): boolean {
    if (!def.requires || def.requires.length === 0) return true;
    return def.requires.every((reqId) => {
      const st = this._progress.get(reqId)?.status;
      return st === 'completed' || st === 'claimed';
    });
  }

  /** 刷新所有 locked 任务（因为可能有任务被 abandon/reset） */
  private _refreshLocks(): void {
    for (const [id, def] of this._defs) {
      const p = this._progress.get(id);
      if (!p) continue;
      if (p.status === 'locked' && this._requiresMet(def)) {
        this._setStatus(id, 'available');
        if (def.autoAccept) this.accept(id);
      }
    }
  }
}
