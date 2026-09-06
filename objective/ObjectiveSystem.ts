/**
 * objective/ObjectiveSystem.ts —— 关卡目标
 *
 * 【它解决什么】
 *
 * "清光所有怪"只是关卡目标的一种。玩家很快会腻。
 * 真正让关卡有记忆点的是目标多样化：
 *
 * | 类型 | 玩家在做什么 |
 * |---|---|
 * 清怪 | 战斗 |
 * 生存 | 走位、躲避（不能躲角落，有压力） |
 * 护送 | 保护 NPC，走位 + 战斗 |
 * 收集 | 探索地图 |
 * 到达 | 跑图、绕过障碍 |
 * 限时 | 竞速，逼玩家优化路线 |
 *
 * 【本模块的核心价值：可组合】
 *
 * 单个目标很简单，难的是组合：
 * "先清光了 A 区，**然后**护送 NPC 到终点，**同时**别让他死"。
 * 用 if 写会变成一团，用组合器（And/Or/Sequence）则清晰可测。
 *
 * 【零业务依赖】
 *
 * 它不认识"怪""NPC"。进度通过 `setProgress(id, value)` 外部驱动，
 * 本模块只负责判定与状态机。
 */
import { safeDt } from '../_core/math';

// ============================================================
// 目标类型
// ============================================================

export type ObjectiveKind =
  /** 计数达标（击杀 20 个、收集 5 个） */
  | 'count'
  /** 生存/坚持 N 秒 */
  | 'survive'
  /** 限时内完成（倒计时，超时失败） */
  | 'timed'
  /** 到达区域（布尔，一旦为 true 即完成） */
  | 'reach'
  /** 保护对象存活（进度反向：掉到 0 就失败） */
  | 'protect';

export type ObjectiveStatus = 'inactive' | 'active' | 'completed' | 'failed';

export interface ObjectiveDef {
  readonly id: string;
  readonly kind: ObjectiveKind;
  /** UI 标题（原样透传，建议用 i18n key） */
  readonly title?: string;
  /**
   * 目标值
   * - count：需要多少
   * - survive：需要多少秒
   * - timed：限时多少秒
   * - protect：初始"血量"（进度从 target 递减到 0 失败）
   * - reach：忽略（用 1）
   */
  readonly target: number;
  /**
   * 前置目标 id（完成后才激活）
   *
   * 【用途】分阶段关卡："先开门，再清场"
   */
  readonly requires?: readonly string[];
  /**
   * 失败时是否整个关卡失败。默认 true
   *
   * false 用于"可选目标"：完成了有奖励，失败不惩罚。
   */
  readonly critical?: boolean;
  /** 业务数据 */
  readonly data?: unknown;
}

/** 运行时状态 */
export interface ObjectiveState {
  readonly def: ObjectiveDef;
  status: ObjectiveStatus;
  /** 当前进度（语义随 kind 而定） */
  progress: number;
  /** 已用时（秒） */
  elapsed: number;
}

// ============================================================
// 事件
// ============================================================

export interface ObjectiveEvent {
  readonly type: 'activated' | 'completed' | 'failed' | 'progress';
  readonly id: string;
  readonly progress: number;
  readonly target: number;
}

// ============================================================
// 配置
// ============================================================

export interface ObjectiveSystemOptions {
  readonly objectives: readonly ObjectiveDef[];
  /**
   * 完成模式（多个目标时）
   *
   * - `'all'`（默认）：全部完成才算通关
   * - `'any'`：任一完成即通关
   * - `'all-critical'`：所有 critical 的完成即可（可选目标不影响）
   */
  mode?: 'all' | 'any' | 'all-critical';
  onEvent?: (e: ObjectiveEvent) => void;
  /** 全部完成 */
  onAllComplete?: (totalTime: number) => void;
  /** 失败 */
  onFailed?: (failedId: string) => void;
}

// ============================================================
// 实现
// ============================================================

export class ObjectiveSystem {
  private readonly _states = new Map<string, ObjectiveState>();
  private readonly _order: string[] = [];
  private readonly _mode: 'all' | 'any' | 'all-critical';
  private _time = 0;
  private _finished = false;
  private _failed = false;
  private _failedId = '';

  onEvent?: (e: ObjectiveEvent) => void;
  onAllComplete?: (totalTime: number) => void;
  onFailed?: (failedId: string) => void;

  constructor(opts: ObjectiveSystemOptions) {
    this._mode = opts.mode ?? 'all';
    this.onEvent = opts.onEvent;
    this.onAllComplete = opts.onAllComplete;
    this.onFailed = opts.onFailed;

    const ids = new Set<string>();
    for (const d of opts.objectives) {
      if (ids.has(d.id)) throw new Error(`[Objective] 目标 id 重复：${d.id}`);
      ids.add(d.id);
      if (d.kind !== 'reach' && d.target <= 0) {
        throw new Error(`[Objective] 目标 ${d.id} 的 target 必须为正，实际 ${d.target}`);
      }
      this._states.set(d.id, {
        def: d,
        status: 'inactive',
        progress: d.kind === 'protect' ? d.target : 0,
        elapsed: 0,
      });
      this._order.push(d.id);
    }

    // 【构造时检测循环依赖】
    // 否则两个互为前置的目标会永远 inactive，
    // 玩家面对一个"什么都没发生"的关卡。
    const cycle = this._findCycle();
    if (cycle.length > 0) {
      throw new Error(`[Objective] 前置形成循环：${cycle.join(' → ')}`);
    }
  }

  // ---- 查询 ----

  status(id: string): ObjectiveStatus {
    return this._states.get(id)?.status ?? 'inactive';
  }

  progress(id: string): number {
    return this._states.get(id)?.progress ?? 0;
  }

  /** 归一化进度 0~1（UI 进度条用） */
  ratio(id: string): number {
    const s = this._states.get(id);
    if (!s) return 0;
    const t = s.def.target;
    if (t <= 0) return 0;
    if (s.def.kind === 'protect') return Math.max(0, Math.min(1, s.progress / t));
    if (s.def.kind === 'timed') return Math.max(0, Math.min(1, 1 - s.progress / t));
    return Math.max(0, Math.min(1, s.progress / t));
  }

  get finished(): boolean {
    return this._finished;
  }

  get failed(): boolean {
    return this._failed;
  }

  get failedId(): string {
    return this._failedId;
  }

  get totalTime(): number {
    return this._time;
  }

  /** 当前激活的目标（UI 显示用） */
  active(): ObjectiveState[] {
    const out: ObjectiveState[] = [];
    for (const id of this._order) {
      const s = this._states.get(id)!;
      if (s.status === 'active') out.push(s);
    }
    return out;
  }

  /** 主目标（进度条显示第一个激活的） */
  primary(): ObjectiveState | null {
    for (const id of this._order) {
      const s = this._states.get(id)!;
      if (s.status === 'active') return s;
    }
    return null;
  }

  all(): ObjectiveState[] {
    return this._order.map((id) => this._states.get(id)!);
  }

  // ---- 控制 ----

  /**
   * 设置进度（外部驱动）
   *
   * 【为什么是"设置"而不是"增加"】
   * 设置是幂等的：业务每帧算一次当前值（比如"场上还剩几个怪"）
   * 然后 setProgress，不需要自己维护增量。
   * 增量容易算错（同一帧重复加、漏减）。
   */
  setProgress(id: string, value: number): void {
    const s = this._states.get(id);
    if (!s || s.status !== 'active') return;
    if (s.progress === value) return;

    s.progress = value;
    this._check(s);
    this.onEvent?.({ type: 'progress', id, progress: s.progress, target: s.def.target });

    /**
     * 【⚠️ 曾经的 bug：这里没有 _checkAll()】
     *
     * 完成判定只写在 `tick()` 里，于是：
     * - 玩家打死最后一个怪 → 目标 completed
     * - 但 `finished` 仍是 false
     * - 门不开、结算不弹、BGM 不切
     * - **直到下一帧 tick 才通关**
     *
     * 单看这一帧延迟无害，但它让"击杀最后一怪"和"通关"
     * 变成了两个不同时刻的事件——
     * 任何在击杀回调里检查 `finished` 的逻辑都会拿到 false：
     * "为什么打死最后一个怪，成就没解锁？"
     *
     * 所以每个可能改变完成状态的操作后都要重新判定。
     */
    this._checkAll();
  }

  /** 增加进度（count 类目标常用） */
  addProgress(id: string, delta: number): void {
    const s = this._states.get(id);
    if (!s || s.status !== 'active') return;
    this.setProgress(id, s.progress + delta);
  }

  /** 标记到达（reach 类目标） */
  markReached(id: string): void {
    this.setProgress(id, 1);
  }

  /** 手动激活（跳过前置，调试用） */
  forceActivate(id: string): void {
    const s = this._states.get(id);
    if (!s || s.status !== 'inactive') return;
    s.status = 'active';
    this.onEvent?.({ type: 'activated', id, progress: s.progress, target: s.def.target });
  }

  /** 重置 */
  reset(): void {
    this._time = 0;
    this._finished = false;
    this._failed = false;
    this._failedId = '';
    for (const id of this._order) {
      const s = this._states.get(id)!;
      s.status = 'inactive';
      s.progress = s.def.kind === 'protect' ? s.def.target : 0;
      s.elapsed = 0;
    }
  }

  // ---- 主循环 ----

  tick(dt: number): void {
    if (this._finished || this._failed) return;
    if (!safeDt(dt)) return;

    this._time += dt;

    // ① 激活满足前置的目标
    for (const id of this._order) {
      const s = this._states.get(id)!;
      if (s.status !== 'inactive') continue;
      if (this._requirementsMet(s.def)) {
        s.status = 'active';
        this.onEvent?.({ type: 'activated', id, progress: s.progress, target: s.def.target });
      }
    }

    // ② 更新计时类目标
    for (const id of this._order) {
      const s = this._states.get(id)!;
      if (s.status !== 'active') continue;
      s.elapsed += dt;

      if (s.def.kind === 'survive') {
        s.progress += dt;
        this._check(s);
      } else if (s.def.kind === 'timed') {
        s.progress += dt;
        if (s.progress >= s.def.target) {
          s.status = 'failed';
          this.onEvent?.({ type: 'failed', id, progress: s.progress, target: s.def.target });
          this._fail(id);
          return;
        }
      }
    }

    // ③ 判定整体完成
    this._checkAll();
  }

  // ---- 内部 ----

  private _requirementsMet(def: ObjectiveDef): boolean {
    for (const req of def.requires ?? []) {
      const rs = this._states.get(req);
      if (!rs) return false;                    // 未知前置：不允许激活
      if (rs.status !== 'completed') return false;
    }
    return true;
  }

  private _check(s: ObjectiveState): void {
    if (s.status !== 'active') return;

    if (s.def.kind === 'protect') {
      // 保护类：进度掉到 0 失败
      if (s.progress <= 0) {
        s.status = 'failed';
        this.onEvent?.({ type: 'failed', id: s.def.id, progress: s.progress, target: s.def.target });
        this._fail(s.def.id);
      }
      return;
    }

    if (s.progress >= s.def.target) {
      s.status = 'completed';
      s.progress = s.def.target;   // clamp，UI 不会显示 21/20
      this.onEvent?.({ type: 'completed', id: s.def.id, progress: s.progress, target: s.def.target });
    }
  }

  private _fail(id: string): void {
    const s = this._states.get(id);
    // 非关键目标失败不影响整体
    if (s && s.def.critical === false) return;
    this._failed = true;
    this._failedId = id;
    this.onFailed?.(id);
  }

  private _checkAll(): void {
    if (this._finished || this._failed) return;

    let done: boolean;
    if (this._mode === 'any') {
      done = this._order.some((id) => this._states.get(id)!.status === 'completed');
    } else if (this._mode === 'all-critical') {
      const critical = this._order.filter((id) => this._states.get(id)!.def.critical !== false);
      done =
        critical.length > 0 &&
        critical.every((id) => this._states.get(id)!.status === 'completed');
    } else {
      done =
        this._order.length > 0 &&
        this._order.every((id) => this._states.get(id)!.status === 'completed');
    }

    if (done) {
      this._finished = true;
      this.onAllComplete?.(this._time);
    }
  }

  private _findCycle(): string[] {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this._order) color.set(id, WHITE);
    const stack: string[] = [];
    let found: string[] = [];

    const dfs = (id: string): boolean => {
      color.set(id, GRAY);
      stack.push(id);
      const def = this._states.get(id)!.def;
      for (const req of def.requires ?? []) {
        if (!this._states.has(req)) continue;
        const c = color.get(req);
        if (c === GRAY) {
          found = [...stack.slice(stack.indexOf(req)), req];
          return true;
        }
        if (c === WHITE && dfs(req)) return true;
      }
      stack.pop();
      color.set(id, BLACK);
      return false;
    };

    for (const id of this._order) {
      if (color.get(id) === WHITE && dfs(id)) break;
    }
    return found;
  }
}

// ============================================================
// 预设
// ============================================================

/** 常用目标构造（省得手写 kind/target） */
export const Objectives = {
  /** 击杀 N 个 */
  kill: (id: string, count: number, title?: string): ObjectiveDef => ({
    id, kind: 'count', target: count, ...(title !== undefined ? { title } : {}),
  }),

  /** 生存 N 秒 */
  survive: (id: string, seconds: number, title?: string): ObjectiveDef => ({
    id, kind: 'survive', target: seconds, ...(title !== undefined ? { title } : {}),
  }),

  /** 在 N 秒内完成（倒计时） */
  timeLimit: (id: string, seconds: number, title?: string): ObjectiveDef => ({
    id, kind: 'timed', target: seconds, ...(title !== undefined ? { title } : {}),
  }),

  /** 到达区域 */
  reach: (id: string, title?: string): ObjectiveDef => ({
    id, kind: 'reach', target: 1, ...(title !== undefined ? { title } : {}),
  }),

  /** 保护对象（hp 掉到 0 失败） */
  protect: (id: string, hp: number, title?: string): ObjectiveDef => ({
    id, kind: 'protect', target: hp, ...(title !== undefined ? { title } : {}),
  }),

  /** 可选目标（失败不惩罚） */
  optional: (def: ObjectiveDef): ObjectiveDef => ({ ...def, critical: false }),

  /** 带前置 */
  after: (def: ObjectiveDef, requires: readonly string[]): ObjectiveDef => ({
    ...def, requires,
  }),
};
