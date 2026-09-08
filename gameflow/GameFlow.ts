/**
 * gameflow/GameFlow.ts —— 流程状态机
 *
 * 【它解决什么】
 *
 * 每个游戏都有这条链路：
 *
 * ```
 * 启动 → 加载 → 主菜单 → 游戏中 → 暂停 → 结算 → 回主菜单
 * ```
 *
 * 手写的做法是散落各处的 `setState('menu')`，
 * 配上每个状态里的 `if (currentState === ...)`。
 * 三五个状态还能忍，加上设置界面、图鉴、商店、二次确认弹窗之后，
 * 你会遇到这些问题：
 *
 * - 从暂停直接跳到结算，忘了清理战斗数据
 * - 结算界面按返回，回到了暂停界面（还是暂停着的）
 * - 两次快速点击，同一个状态被进入了两次
 *
 * 本模块把「状态」和「允许的转换」显式列出来，
 * 非法转换**直接拒绝**，而不是留下一个诡异的中间态。
 *
 * 【三个必须处理的真实问题】
 *
 * 1. **转换中的重入**：在 enter 回调里又调 goTo，会导致 exit/enter 顺序错乱
 * 2. **历史栈无限增长**：跑一小时游戏，历史里几千条
 * 3. **时间倒流**：update 传入负 dt
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

/** 一条转换规则 */
export interface FlowTransition<Ctx> {
  readonly to: string;
  /**
   * 转换条件
   *
   * 【为什么是条件而不是"允许列表"】
   * "存档加载完才能进主菜单"这类判断需要读运行时状态，
   * 静态列表表达不了。
   */
  readonly when: (ctx: Ctx) => boolean;
  /**
   * 是否自动转换（update 时自动走）
   *
   * 【用途】loading → ready 这类"条件满足就自己往下走"的状态。
   */
  readonly auto?: boolean;
  readonly desc?: string;
}

export interface FlowStateDef<Ctx> {
  readonly id: string;
  readonly enter?: (ctx: Ctx, from: string | null) => void;
  readonly exit?: (ctx: Ctx, to: string) => void;
  /** 每帧更新（只有当前状态会被调用） */
  readonly update?: (ctx: Ctx, dt: number) => void;
  readonly transitions?: readonly FlowTransition<Ctx>[];
  readonly desc?: string;
}

export interface GameFlowOptions<Ctx> {
  readonly defs: readonly FlowStateDef<Ctx>[];
  readonly initial: string;
  readonly context: Ctx;
  readonly onChange?: (from: string, to: string) => void;
  /**
   * 历史记录上限
   *
   * 【为什么需要】
   * 游戏跑一小时，状态来回切几百次，
   * 不限制的话历史数组会一直增长。
   */
  readonly historyLimit?: number;
}

export interface GoToOptions {
  /** 无视转换表强制切换（调试/紧急恢复用） */
  readonly force?: boolean;
  /** 允许转换到当前状态（重入，会触发 exit + enter） */
  readonly allowSelf?: boolean;
}

// ==================== 实现 ====================

export class GameFlow<Ctx> {
  private readonly _states = new Map<string, FlowStateDef<Ctx>>();
  private readonly _context: Ctx;
  private readonly _onChange?: (from: string, to: string) => void;
  private readonly _historyLimit: number;
  private readonly _initial: string;

  private _current: string;
  private _history: string[] = [];
  private _timeInState = 0;
  private _transitioning = false;

  constructor(opts: GameFlowOptions<Ctx>) {
    this._context = opts.context;
    this._onChange = opts.onChange;
    this._historyLimit = opts.historyLimit ?? 32;
    this._initial = opts.initial;

    for (const d of opts.defs) {
      if (this._states.has(d.id)) {
        throw new Error(`[GameFlow] 状态 id 重复：${d.id}`);
      }
      this._states.set(d.id, d);
    }

    // 校验转换目标都存在
    for (const d of opts.defs) {
      for (const t of d.transitions ?? []) {
        if (!this._states.has(t.to)) {
          throw new Error(
            `[GameFlow] 状态 "${d.id}" 的转换目标 "${t.to}" 不存在`
          );
        }
      }
    }

    if (!this._states.has(opts.initial)) {
      throw new Error(
        `[GameFlow] 初始状态 "${opts.initial}" 不存在` +
        `（已定义：${[...this._states.keys()].join(', ')}）`
      );
    }

    this._current = opts.initial;
    this._history.push(opts.initial);

    // 初始状态也要触发 enter
    this._enter(opts.initial, null);
  }

  // ==================== 查询 ====================

  get current(): string {
    return this._current;
  }

  get context(): Ctx {
    return this._context;
  }

  get history(): readonly string[] {
    return this._history;
  }

  get timeInState(): number {
    return this._timeInState;
  }

  get states(): readonly FlowStateDef<Ctx>[] {
    return [...this._states.values()];
  }

  get isTransitioning(): boolean {
    return this._transitioning;
  }

  get(id: string): FlowStateDef<Ctx> | undefined {
    return this._states.get(id);
  }

  /** 当前状态可去哪些地方 */
  availableTargets(): string[] {
    const cur = this._states.get(this._current);
    if (!cur) return [];
    return (cur.transitions ?? [])
      .filter((t) => t.when(this._context))
      .map((t) => t.to);
  }

  /** 只查询，不改变状态 */
  canGoTo(to: string): boolean {
    return this._findTransition(to) !== null;
  }

  // ==================== 转换 ====================

  goTo(to: string, opts: GoToOptions = {}): boolean {
    if (!this._states.has(to)) {
      throw new Error(
        `[GameFlow] 未知状态："${to}"（已定义：${[...this._states.keys()].join(', ')}）`
      );
    }

    if (to === this._current && !opts.allowSelf) {
      return false;
    }

    if (!opts.force && this._findTransition(to) === null) {
      return false;
    }

    /**
     * 【⚠️ 转换中的重入保护】
     *
     * 如果在 enter 回调里又调 goTo，
     * 会导致 exit/enter 顺序错乱：
     *   期望 A.exit → B.enter
     *   实际 A.exit → B.enter → B.exit → A.enter（状态机自己都不知道在哪）
     *
     * 直接拒绝比留下错乱状态好。
     */
    if (this._transitioning) {
      return false;
    }

    this._perform(this._current, to);
    return true;
  }

  /** 强制切换（无视转换表） */
  force(to: string): boolean {
    return this.goTo(to, { force: true });
  }

  /** 回到上一个状态 */
  back(): boolean {
    if (this._history.length < 2) return false;
    const prev = this._history[this._history.length - 2];
    // 回退也要检查合法性（除非当前状态允许回去）
    return this.goTo(prev);
  }

  /** 重置到初始状态 */
  reset(): void {
    const from = this._current;
    this._states.get(from)?.exit?.(this._context, this._initial);
    this._current = this._initial;
    this._timeInState = 0;
    this._history = [this._initial];
    this._enter(this._initial, null);
  }

  // ==================== 驱动 ====================

  /**
   * 每帧更新
   *
   * 1. 累加停留时长
   * 2. 调用当前状态的 update
   * 3. 检查 auto 转换
   */
  update(dt = 0): void {
    if (dt > 0) {
      /**
       * 【⚠️ 负 dt 不倒退】
       * 切后台回来、时间校准、手滑传错，都可能给负 dt。
       * 让 timeInState 变成负数会让"停留 3 秒后自动跳过"这类逻辑永不触发。
       */
      this._timeInState += dt;
    }

    const cur = this._states.get(this._current);
    if (cur?.update) cur.update(this._context, dt);

    // auto 转换：取第一个满足的
    if (!this._transitioning) {
      for (const t of cur?.transitions ?? []) {
        if (t.auto && t.when(this._context)) {
          this._perform(this._current, t.to);
          break;
        }
      }
    }
  }

  // ==================== 内部 ====================

  private _findTransition(to: string): FlowTransition<Ctx> | null {
    const cur = this._states.get(this._current);
    if (!cur) return null;
    for (const t of cur.transitions ?? []) {
      // force 时允许 self，这里按声明顺序取第一个满足的
      if (t.when(this._context) && (t.to === to || t.to === this._current)) {
        if (t.to === to) return t;
      }
    }
    // 上面的写法对 self 转换有歧义，单独处理
    for (const t of cur.transitions ?? []) {
      if (t.to === to && t.when(this._context)) return t;
    }
    return null;
  }

  private _perform(from: string, to: string): void {
    this._transitioning = true;
    try {
      this._states.get(from)?.exit?.(this._context, to);
      this._current = to;
      this._timeInState = 0;
      this._pushHistory(to);
      this._enter(to, from);
      this._onChange?.(from, to);
    } finally {
      this._transitioning = false;
    }
  }

  private _enter(id: string, from: string | null): void {
    this._states.get(id)?.enter?.(this._context, from);
  }

  private _pushHistory(id: string): void {
    this._history.push(id);
    if (this._history.length > this._historyLimit) {
      // 保留开头（初始状态）和最近的记录
      const keep = this._historyLimit;
      this._history = [
        this._history[0],
        ...this._history.slice(-(keep - 1)),
      ];
    }
  }
}
