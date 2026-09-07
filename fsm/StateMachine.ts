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
    /**
     * 【⚠️ start 必须幂等】
     * 老实现每次调用都触发一次 enter。重复 start（生命周期管理里很常见：
     *  resumed / onEnable 里再调一次）会让 enter 跑两遍——
     *  实测两次 `start(ctx)` 后 enter 计数从 1 变 2。
     * enter 里通常是"播放动画 / 重置计时器 / 申请资源"这类副作用，
     * 跑两遍的表现是"动画从头播一次"或"资源申请两次"，不一定报错。
     */
    if (this._started) return;
    this._started = true;
    this._states.get(this._current)?.enter?.(ctx, null);
  }

  get current(): string {
    return this._current;
  }

  /** 在当前状态停留的时间（秒）。常用于"攻击后 0.3s 才能翻滚" */
  get timeInState(): number {
    return this._timeInState;
  }

  /**
   * 能否转换到目标状态
   *
   * 【⚠️ "配了转换表但当前状态缺项"必须按"一个都不许转"处理】
   *
   * 老实现是 `if (!allowed) return true` —— 缺项和"压根没配转换表"
   * 走的是同一条分支。于是：
   * ```js
   * transitions = { walk: ['run'] }，当前态 idle（表中缺项）
   * can('jump')     → true     ← 白名单形同虚设
   * can('teleport') → true     ← 甚至不存在的状态也放行
   * ```
   * 后果正是"新增状态时忘了在 transitions 里补一行"——
   * 该状态**允许转换到任意状态**，而 `can()` 返回 true 让宿主以为校验通过了
   * （实际 `transitionTo` 里还有 `_states.has(to)` 兜一道，
   * 所以只表现为"该状态意外地万能"，不崩，极难发现）。
   *
   * 现在区分两种情形：
   * - 未配置 `transitions` → 允许任意（文档承诺："不填 = 允许任意"）
   * - 配置了但当前状态缺项 → **一个都不许转**
   *   （既符合"白名单"的直觉，也让漏配在运行时立刻暴露）
   */
  can(to: string): boolean {
    if (!this._opts.transitions) return true;
    const allowed = this._transOf(this._current);
    if (!allowed) return false;
    return allowed.includes(to);
  }

  /**
   * 某状态能直接到达哪些状态（**can 与 findUnreachable 共用同一口径**）
   *
   * 【为什么要共用】
   * 之前 `can()` 宽松（缺项 = 任意）、`findUnreachable()` 也宽松（缺项 = 全部状态），
   * 修完 `can()` 之后如果 findUnreachable 还按宽松算，
   * 就会出现"报告说这个状态可达、`can()` 却永远拒绝"的自相矛盾。
   * 校验工具和运行时判定必须是同一套规则，否则工具反而误导人。
   */
  private _targetsOf(from: string): readonly string[] {
    if (!this._opts.transitions) return Array.from(this._states.keys());
    return this._transOf(from) ?? [];
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
      const nexts = this._targetsOf(cur);
      for (const n of nexts) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }

    return all.filter((s) => !seen.has(s));
  }

  /**
   * 回到初始状态
   *
   * 【⚠️ reset 之前既不检查 _transitioning，也不触发 onChange】
   *
   * ① 不检查 `_transitioning`：在 enter/exit 回调里调 reset 会打断正在进行的转换，
   *    `transitionTo` 的 finally 再把标志清掉，留下一个"已完成但顺序错乱"的状态。
   *    这里与 transitionTo 用同一个标志拦截（口径一致）。
   *
   * ② 不触发 `onChange`：onChange 是给调试与埋点用的，
   *    "状态从 run 被重置回 idle"是一次真实的状态变化，
   *    不通知的话埋点里会缺一段，UI 也不会刷新——
   *    这正是"读档/重置后状态对了但界面没更新"的成因。
   *
   * 【未处理（需总审裁决）】enter 回调抛异常时，`_current` 已经切换、
   * `_timeInState` 已归零，异常向上传播后状态机会停在"已进入但未初始化"的中间态。
   * 要修就得决定是**回滚**到 from 还是**标记 failed 并停住**，
   * 两种都会改变对外行为，且会影响 transitionTo，故只在此记录、不动代码。
   */
  reset(ctx: C): void {
    if (this._transitioning) {
      console.warn('[StateMachine] 正在转换中，忽略 reset（不要在 enter/exit 里重置状态机）');
      return;
    }
    if (this._current !== this._opts.initial) {
      const from = this._current;
      this._states.get(from)?.exit?.(ctx, this._opts.initial);
      this._current = this._opts.initial;
      this._timeInState = 0;
      this._states.get(this._current)?.enter?.(ctx, from);
      this._opts.onChange?.(from, this._current, ctx);
    } else {
      this._timeInState = 0;
    }
  }

  destroy(): void {
    /* 状态机不持有外部资源，无清理需求 */
  }

  private _transitioning = false;
  /** start 是否已执行过（保证幂等，见 start 的注释） */
  private _started = false;
}
