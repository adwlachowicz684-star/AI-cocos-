/**
 * StateMachine —— 有限状态机
 *
 * 【什么时候用它，什么时候用行为树】
 *
 * | | 状态机 | 行为树 |
 * |---|---|---|
 * | 适合 | 互斥的、数量少的状态 | 复杂的、可分层的决策 |
 * | 例子 | 角色：idle/run/jump/attack | AI：巡逻→发现→追击→攻击→撤退 |
 * | 状态数 | 5–15 个 | 任意 |
 * | 转换 | 显式声明 | 由节点返回值驱动 |
 *
 * **经验法则**：先用状态机。当状态超过 10 个、
 * 或者你开始写 "if (state === 'chase' && hasLineOfSight && hp > 30%)" 这种
 * 复合条件时，换成行为树。
 *
 * 【设计：为什么要显式声明转换】
 * 朴素写法是在 update 里 if-else 判断。问题是：
 * - 无法知道"从 A 能到哪些状态"
 * - 漏掉的组合会变成不可达状态（比如 attack 中永远跳不起来）
 * - 无法可视化
 *
 * 显式声明后，可以校验"是否存在不可达状态"。
 *
 * 【使用示例】
 * ```typescript
 * const fsm = new StateMachine<PlayerContext>({
 *   initial: 'idle',
 *   states: {
 *     idle:  { enter: (c) => c.anim.play('idle'),
 *              update: (c, dt) => { if (c.input.move) return 'run'; },
 *              exit: (c) => {} },
 *     run:   { update: (c, dt) => { if (!c.input.move) return 'idle';
 *                                   if (c.input.jump) return 'jump'; } },
 *     jump:  { enter: (c) => c.velocity.y = c.jumpForce,
 *              update: (c, dt) => { if (c.grounded) return 'idle'; } },
 *   }
 * });
 *
 * fsm.update(ctx, dt);
 * fsm.current;      // 'run'
 * fsm.can('jump');  // 当前状态能否转到 jump
 * ```
 *
 * 【无引擎依赖】上下文类型由调用方定义。
 */
import { safeDt } from '../_core/math';
import { hasOwn } from '../_core/guard';

export interface StateHooks<C> {
  /** 进入时调用一次 */
  enter?: (ctx: C, from: string | null) => void;
  /** 每帧调用，返回目标状态名则转换，返回 undefined 则保持 */
  update?: (ctx: C, dt: number) => string | undefined | void;
  /** 离开时调用一次 */
  exit?: (ctx: C, to: string) => void;
}

export interface StateMachineOptions<C> {
  readonly initial: string;
  readonly states: Readonly<Record<string, StateHooks<C>>>;
  /**
   * 允许的转换表。不填 = 允许任意转换。
   * { idle: ['run', 'jump'], run: ['idle', 'jump'] }
   */
  readonly transitions?: Readonly<Record<string, readonly string[]>>;
  /** 未知状态时是否抛错（默认 true，快速失败） */
  readonly strict?: boolean;
  /** 状态变化回调（调试与埋点用） */
  readonly onChange?: (from: string, to: string, ctx: C) => void;
}

export class StateMachine<C> {
  private readonly _opts: StateMachineOptions<C>;
  /**
   * 状态表（**构造期复制进 Map**）
   *
   * 【⚠️ 为什么不能直接查 `opts.states[name]`】
   *
   * 状态名是字符串，`Record<string, ...>` 的直接下标会命中**原型链**。实测：
   * ```js
   * new StateMachine({ states: {}, initial: 'toString' })   // 不报错！
   * sm.start({})                                            // enter 静默不触发
   * sm.current                                              // → 'toString'
   * ```
   * `opts.states['toString']` 取到的是 `Object.prototype.toString`，
   * 是个**函数**——于是 `if (!states[initial])` 的真假判断通过了，
   * 状态机带着一个不存在的状态正常启动，
   * 之后 `enter` / `exit` / `update` 全部静默不触发。
   *
   * 表现为"状态机配好了但什么都没发生"，且不抛任何错——
   * 排查时没人会想到源头在状态名字符串上。
   *
   * 复制进 Map 同时解决两件事：
   * ① 只认自有属性，原型链天然不可达
   * ② `Object.keys` 同款语义（`findUnreachable` 依赖它）
   */
  private readonly _states: ReadonlyMap<string, StateHooks<C>>;
  private _current: string;
  private _timeInState = 0;

  constructor(opts: StateMachineOptions<C>) {
    this._opts = opts;
    this._states = new Map(
      Object.keys(opts.states)
        .filter((k) => hasOwn(opts.states, k))
        .map((k) => [k, opts.states[k]])
    );
    if (!this._states.has(opts.initial)) {
      throw new Error(`[StateMachine] 初始状态 "${opts.initial}" 不存在`);
    }
    this._current = opts.initial;
    /**
     * 【为什么构造时不调用 enter】
     * 构造函数里没有 context，调用 enter 会传 undefined 给它——
     * 表现是"游戏一启动就报 Cannot read properties of undefined"。
     *
     * 这是被测试抓到的真实缺陷。正确做法：构造函数只做校验，
     * 副作用（enter）留给显式的 `start(ctx)`。
     */
  }

  /**
   * 启动状态机：触发初始状态的 enter
   *
   * 【什么时候调用】拿到 context 之后、第一次 update 之前。
   */
  start(ctx: C): void {
    this._states.get(this._current)?.enter?.(ctx, null);
  }

  get current(): string {
    return this._current;
  }

  /** 在当前状态停留的时间（秒）。常用于"攻击后 0.3s 才能翻滚" */
  get timeInState(): number {
    return this._timeInState;
  }

  /** 能否转换到目标状态 */
  can(to: string): boolean {
    const allowed = this._transOf(this._current);
    if (!allowed) return true;
    return allowed.includes(to);
  }

  /**
   * 安全读取转换表
   *
   * 【同 `_states` 的理由】`transitions` 也是 `Record<string, ...>`，
   * `transitions['toString']` 会取到原型函数（truthy），
   * 于是 `.includes(to)` 在**函数**上调用 → TypeError 或恒 false。
   * 这里一样只认自有属性。
   */
  private _transOf(from: string): readonly string[] | undefined {
    const t = this._opts.transitions;
    if (!t || !hasOwn(t, from)) return undefined;
    return t[from];
  }

  /**
   * 强制切换到指定状态
   *
   * 【坑】转换过程中（enter/exit 回调里）不要再调用 transitionTo，
   * 会破坏状态一致性。这里用 _transitioning 标志拦截。
   */
  transitionTo(to: string, ctx: C): boolean {
    if (to === this._current) return false;

    if (!this._states.has(to)) {
      if (this._opts.strict !== false) {
        throw new Error(`[StateMachine] 目标状态 "${to}" 不存在`);
      }
      return false;
    }

    if (!this.can(to)) return false;
    if (this._transitioning) {
      console.warn(`[StateMachine] 正在转换中，忽略到 "${to}" 的请求（不要在 enter/exit 里转换状态）`);
      return false;
    }

    this._transitioning = true;
    const from = this._current;

    try {
      this._states.get(from)?.exit?.(ctx, to);
      this._current = to;
      this._timeInState = 0;
      this._states.get(to)?.enter?.(ctx, from);
      this._opts.onChange?.(from, to, ctx);
    } finally {
      this._transitioning = false;
    }
    return true;
  }

  /**
   * 每帧更新
   *
   * 【执行顺序】先跑当前状态的 update，如果它返回了目标状态就转换。
   * 注意：转换后**不会**再跑新状态的 update（下一帧才跑），
   * 这是有意的——避免"一帧内连续转好几个状态"的连锁反应。
   */
  update(ctx: C, dt: number): void {
    /**
     * 【为什么只保护内部计时，传给用户的仍是原始 dt】
     * _timeInState 是本模块自己的状态，NaN 会永久污染"状态停留时间"，
     * 让所有基于停留时间的转移条件永远判不成立。
     * 而传给业务 update 的 dt 由调用方自己决定怎么校验，这里不越权改。
     */
    this._timeInState += safeDt(dt) ? dt : 0;
    const next = this._states.get(this._current)?.update?.(ctx, dt);
    if (typeof next === 'string' && next.length > 0 && next !== this._current) {
      this.transitionTo(next, ctx);
    }
  }

  /**
   * 校验：找出不可达状态
   *
   * 【用途】启动时跑一次，能发现"某个状态永远进不去"的配置错误。
   * 这类 bug 在运行时表现为"某个功能死活不触发"，很难定位。
   */
  findUnreachable(): string[] {
    const all = Array.from(this._states.keys());
    const seen = new Set<string>([this._opts.initial]);
    const queue = [this._opts.initial];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const nexts = this._transOf(cur) ?? all;
      for (const n of nexts) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }

    return all.filter((s) => !seen.has(s));
  }

  reset(ctx: C): void {
    if (this._current !== this._opts.initial) {
      this._states.get(this._current)?.exit?.(ctx, this._opts.initial);
      this._current = this._opts.initial;
      this._timeInState = 0;
      this._states.get(this._current)?.enter?.(ctx, null);
    } else {
      this._timeInState = 0;
    }
  }

  destroy(): void {
    /* 状态机不持有外部资源，无清理需求 */
  }

  private _transitioning = false;
}
