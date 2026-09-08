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

import { clampNum, safeDt } from '../_core/math';

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
    /**
     * 【⚠️ 为什么必须用 clampNum 而不是 `?? 32`】
     *
     * `historyLimit` 是**容量类字段**，而 `??` 只挡 `null`/`undefined`——
     * NaN 会原样穿过去（"模式 B"）。
     *
     * 更糟的是它和 `_pushHistory` 的裁剪写法叠加后，
     * 小值 / NaN 会让裁剪**反过来变成增长**。实测跑 200 次切换：
     *
     * ```
     * historyLimit = 32（默认） → history 长度 32    ← 正常
     * historyLimit = 1          → history 长度 401   ← 每次 +2
     * historyLimit = 0          → history 长度 201   ← 每次 +1
     * historyLimit = NaN        → history 长度 201   ← 每次 +1
     * ```
     *
     * 根因是 `slice(-(keep - 1))`：keep ≤ 1 时参数变成 `slice(0)` 或正数，
     * 退化成"几乎全量复制"，裁剪后长度不减反增。
     * 而 `length > NaN` 恒为 false 时连裁剪分支都进不去。
     *
     * 后果是长会话下 `_history` 单调增长（内存泄漏，无报错），
     * 且 `back()` 依赖 `history[length - 2]`，历史越长 `back()` 的语义越不可控。
     *
     * 【为什么下界是 1 而不是 0】
     * 有人会把 0 理解成"不限制"，有人理解成"不保留历史"——
     * 两种理解的实现完全不同，而这里的实现是第三种（无限增长）。
     * 显式夹到 [1, 1e4] 是为了让"0 不代表不限制"变成编译期就能看见的事实，
     * 避免出现第四种理解。
     */
    this._historyLimit = clampNum(opts.historyLimit, 1, 1e4, 32);
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
    /**
     * 【⚠️ 为什么用 safeDt(dt) 而不是 if (dt > 0)】
     *
     * `dt > 0` 挡得住负数和 0，但挡不住 **Infinity**
     * ——`Infinity > 0` 是 true，于是 `timeInState` 一步变成 Infinity，
     * 此后任何"停留 N 秒后自动跳过"的判断（`timeInState > 3`）
     * 全部恒真，auto 转换在同一帧里被反复触发。
     *
     * 实测：`update(Infinity)` 之后 `timeInState === Infinity`。
     *
     * 触发源是现成的：`performance.now()` 差值在时钟回拨/暂停恢复时
     * 可以算出 Infinity（除以 0 的 dt），而 Infinity 是**静默**的
     * ——它不报错，只是让所有时间判断永远成立。
     *
     * 同批的 `tutorial`（:211）注释里明确写了
     * "为什么不是 dt > 0：Infinity > 0 为 true"，本单元漏了这条。
     * 全库统一用 `safeDt`（只有"有限且为正"才通过）。
     */
    if (safeDt(dt)) {
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
    /**
     * 【⚠️ 为什么删掉了原来那个"第一个 for 循环"】
     *
     * 原实现的第一个循环写作：
     *
     * ```typescript
     * if (t.when(ctx) && (t.to === to || t.to === this._current)) {
     *   if (t.to === to) return t;      // ← 唯一能 return 的分支
     * }
     * ```
     *
     * 内层又要求 `t.to === to`，于是外层那个 `|| t.to === this._current`
     * **永远不会导致 return**——它唯一的两个作用是：
     * ① 让 `t.when()` 被多调用一次（有副作用的 when 会被执行两遍）；
     * ② 让读代码的人以为"self 转换在这里被特殊处理了"。
     *
     * 整个第一循环等价于"取第一个 when 成立且 to===to 的转换"，
     * 与第二循环**逐字等价**——是残留的死代码，且带误导性注释
     * （"force 时允许 self"，但本函数根本收不到 force 参数）。
     */
    const cur = this._states.get(this._current);
    if (!cur) return null;
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
    const keep = this._historyLimit;
    if (this._history.length > keep) {
      // 保留开头（初始状态）和最近的 keep - 1 条
      /**
       * 【⚠️ 为什么写成 `slice(length - (keep - 1))` 而不是 `slice(-(keep - 1))`】
       *
       * 负数参数的 `slice` 在 `keep <= 1` 时会变成另一个意思：
       * `slice(-0)` 等于 `slice(0)`（**整段复制**），
       * `slice(-(-1))` 等于 `slice(1)`（只砍掉开头一个）。
       * 两种情况下裁剪后的数组都比裁剪前更长或等长——
       * 裁剪代码变成了增长代码，而且没有任何报错。
       *
       * 用**正数起点**表达"取末尾 keep-1 条"没有这个歧义：
       * `keep` 已由 `clampNum` 夹到 ≥ 1，起点永远落在数组内。
       */
      this._history = [
        this._history[0],
        ...this._history.slice(this._history.length - (keep - 1)),
      ];
    }
  }
}
