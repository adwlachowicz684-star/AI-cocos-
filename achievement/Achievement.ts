/**
 * achievement/Achievement.ts —— 成就系统
 *
 * 【它解决什么】
 *
 * 成就看起来简单：`if (kills >= 100) unlock('kill100')`。
 *
 * 真正麻烦的是这三件事：
 *
 * 1. **重复触发**：每帧检查一次，解锁回调被调用几百次
 * 2. **前置依赖**：隐藏成就要先解锁前置，否则玩家能从"总数"察觉隐藏成就存在
 * 3. **进度展示**：`1234/1000` 这种显示不能超目标、不能为负、不能是 NaN
 *
 * 本模块把它们做对：
 *
 * ```typescript
 * const a = new Achievement({
 *   defs: [
 *     { id: 'kill100', name: '百人斩', target: 100, progress: (c) => c.get('kills') },
 *   ],
 *   onUnlock: (d) => showToast(d.name),
 * });
 * const newly = a.check(ctx);   // 只返回本次新解锁的
 * ```
 *
 * 【⚠️ 它不知道你的游戏数据长什么样】
 * `check(ctx)` 的 ctx 由你提供，成就定义里的 `progress(ctx)` 负责取值。
 * 这样本模块不依赖任何具体的数据结构（Stats、存档、玩家对象都行）。
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

/** 进度查询上下文（由宿主提供，本模块不解释） */
export interface AchievementContext {
  get(key: string): number;
}

export interface AchievementDef {
  readonly id: string;
  readonly name: string;
  readonly desc?: string;
  /**
   * 目标值
   *
   * 用 `isDone` 时不填则默认 1（布尔型成就）。
   */
  readonly target?: number;
  /**
   * 进度取值
   *
   * 【为什么注入函数而不是静态配置】
   * 进度可能来自 Stats、存档、运行时状态……
   * 本模块不该知道数据在哪。
   */
  readonly progress?: (ctx: AchievementContext) => number;
  /**
   * 自定义达成判定（覆盖默认的 `progress >= target`）
   *
   * 【用途】"一局内击败全部 3 个 Boss"这类复合条件。
   */
  readonly isDone?: (ctx: AchievementContext) => boolean;
  /** 前置成就 id */
  readonly requires?: readonly string[];
  /** 成就点数 */
  readonly points?: number;
  /** 隐藏成就（达成前不显示详情） */
  readonly hidden?: boolean;
}

export interface AchievementProgress {
  /** 当前进度（已夹到 [0, target]） */
  readonly current: number;
  readonly target: number;
  /** 是否已达成 */
  readonly done: boolean;
  /** 是否因前置未完成而锁定 */
  readonly locked: boolean;
}

export interface AchievementOptions {
  readonly defs: readonly AchievementDef[];
  readonly onUnlock?: (def: AchievementDef) => void;
  readonly onProgress?: (def: AchievementDef, current: number, target: number) => void;
}

// ==================== 实现 ====================

export class Achievement {
  private readonly _defs = new Map<string, AchievementDef>();
  private readonly _order: string[] = [];
  private readonly _unlocked = new Set<string>();
  private readonly _onUnlock?: (def: AchievementDef) => void;
  private readonly _onProgress?: (def: AchievementDef, current: number, target: number) => void;

  /** 上次通知过的进度（避免重复回调） */
  private readonly _lastProgress = new Map<string, number>();

  constructor(opts: AchievementOptions) {
    for (const d of opts.defs) {
      if (this._defs.has(d.id)) {
        throw new Error(`[Achievement] 成就 id 重复：${d.id}`);
      }
      this._defs.set(d.id, d);
      this._order.push(d.id);
    }

    // 前置必须存在
    for (const d of opts.defs) {
      for (const r of d.requires ?? []) {
        if (!this._defs.has(r)) {
          throw new Error(
            `[Achievement] 成就 "${d.id}" 的前置 "${r}" 不存在`
          );
        }
      }
    }

    this._detectCycle();
    this._onUnlock = opts.onUnlock;
    this._onProgress = opts.onProgress;
  }

  // ==================== 查询 ====================

  def(id: string): AchievementDef | undefined {
    return this._defs.get(id);
  }

  isUnlocked(id: string): boolean {
    return this._unlocked.has(id);
  }

  get unlockedCount(): number {
    return this._unlocked.size;
  }

  /** 全部成就（含隐藏的——占位用，否则玩家能从总数察觉隐藏成就） */
  visible(): AchievementDef[] {
    return this._order.map((id) => this._defs.get(id)!);
  }

  unlocked(): AchievementDef[] {
    return this._order
      .filter((id) => this._unlocked.has(id))
      .map((id) => this._defs.get(id)!);
  }

  /** 已获得点数 */
  get points(): number {
    let n = 0;
    for (const id of this._unlocked) n += this._defs.get(id)!.points ?? 0;
    return n;
  }

  /** 全部点数（含未解锁） */
  get totalPoints(): number {
    let n = 0;
    for (const id of this._order) n += this._defs.get(id)!.points ?? 0;
    return n;
  }

  /** 完成度 0~1（空表返回 0，不除零） */
  get completion(): number {
    if (this._order.length === 0) return 0;
    return this._unlocked.size / this._order.length;
  }

  /** 前置是否全部满足 */
  requirementsMet(id: string): boolean {
    const def = this._defs.get(id);
    if (!def) return false;
    for (const r of def.requires ?? []) {
      if (!this._unlocked.has(r)) return false;
    }
    return true;
  }

  // ==================== 检查 ====================

  /**
   * 批量检查，返回本次新解锁的成就
   *
   * 【顺序很重要】
   * 按声明顺序遍历，所以"同一批里前置和本体同时达成"能正确工作
   * （前置声明在前时）。
   */
  check(ctx: AchievementContext): AchievementDef[] {
    const newly: AchievementDef[] = [];

    for (const id of this._order) {
      if (this._unlocked.has(id)) continue;
      if (!this.requirementsMet(id)) continue;

      const def = this._defs.get(id)!;

      // 进度通知（去重）
      const p = this._progressOf(def, ctx);
      const last = this._lastProgress.get(id);
      if (last !== p.current) {
        this._lastProgress.set(id, p.current);
        this._onProgress?.(def, p.current, p.target);
      }

      if (p.done) {
        this._unlocked.add(id);
        this._onUnlock?.(def);
        newly.push(def);
      }
    }

    return newly;
  }

  /** 只检查一个成就，返回是否是本次新解锁的 */
  checkOne(id: string, ctx: AchievementContext): boolean {
    const def = this._defs.get(id);
    if (!def) return false;
    if (this._unlocked.has(id)) return false;
    if (!this.requirementsMet(id)) return false;

    const p = this._progressOf(def, ctx);
    const last = this._lastProgress.get(id);
    if (last !== p.current) {
      this._lastProgress.set(id, p.current);
      this._onProgress?.(def, p.current, p.target);
    }

    if (p.done) {
      this._unlocked.add(id);
      this._onUnlock?.(def);
      return true;
    }
    return false;
  }

  /** 查询进度（不触发解锁） */
  progressOf(id: string, ctx: AchievementContext): AchievementProgress {
    const def = this._defs.get(id);
    if (!def) {
      throw new Error(`[Achievement] 未定义的成就：${id}`);
    }
    return this._progressOf(def, ctx);
  }

  // ==================== 手动操作 ====================

  unlock(id: string): boolean {
    const def = this._defs.get(id);
    if (!def) {
      throw new Error(
        `[Achievement] 未定义的成就：${id}（已定义：${this._order.join(', ')}）`
      );
    }
    if (this._unlocked.has(id)) return false;
    this._unlocked.add(id);
    this._onUnlock?.(def);
    return true;
  }

  /** 撤销（调试 / 重置用） */
  revoke(id: string): boolean {
    return this._unlocked.delete(id);
  }

  reset(): void {
    this._unlocked.clear();
    this._lastProgress.clear();
  }

  // ==================== 存档 ====================

  exportState(): string[] {
    return [...this._unlocked];
  }

  /** 导入（未知 id 静默跳过，兼容旧存档） */
  importState(ids: readonly string[]): void {
    for (const id of ids) {
      if (this._defs.has(id)) this._unlocked.add(id);
    }
  }

  // ==================== 内部 ====================

  private _progressOf(def: AchievementDef, ctx: AchievementContext): AchievementProgress {
    const target = def.target ?? 1;
    const locked = !this.requirementsMet(def.id);

    let current: number;
    if (def.isDone) {
      current = def.isDone(ctx) ? target : 0;
    } else if (def.progress) {
      current = def.progress(ctx);
    } else {
      current = 0;
    }

    /**
     * 【⚠️ NaN 和负数必须夹掉】
     * 进度来自业务计算（比如除零得到 NaN），
     * 不处理的话 UI 显示 "NaN/100"，进度条宽度算出来是 NaN。
     */
    if (!Number.isFinite(current)) current = 0;
    current = Math.max(0, Math.min(target, current));

    const done = def.isDone
      ? def.isDone(ctx)
      : def.progress !== undefined && (def.progress(ctx) ?? 0) >= target;

    return { current, target, done, locked };
  }

  /** 构造时检测循环前置 */
  private _detectCycle(): void {
    const state = new Map<string, 0 | 1 | 2>();   // 0=未访问 1=访问中 2=完成

    const visit = (id: string, path: string[]): void => {
      const s = state.get(id) ?? 0;
      if (s === 1) {
        throw new Error(
          `[Achievement] 检测到循环前置：${[...path, id].join(' → ')}`
        );
      }
      if (s === 2) return;

      state.set(id, 1);
      for (const r of this._defs.get(id)?.requires ?? []) {
        visit(r, [...path, id]);
      }
      state.set(id, 2);
    };

    for (const id of this._order) visit(id, []);
  }
}
