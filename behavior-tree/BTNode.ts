/**
 * BTNode —— 行为树节点定义
 *
 * 【为什么行为树比 if-else 好】
 *
 * 一个稍微复杂点的敌人 AI 用 if-else 写出来是这样：
 * ```
 * if (visible && dist < atkRange) attack();
 * else if (visible && dist < chaseRange) chase();
 * else if (heard) investigate();
 * else if (hp < 30%) flee();
 * else patrol();
 * ```
 * 问题：加一条"血量低于 20% 时优先逃跑"就要重排整个 if 链，
 * 而且优先级隐式地藏在书写顺序里，改一处可能影响全部。
 *
 * 行为树把优先级变成**显式的树结构**：
 * ```
 * Selector
 * ├─ Sequence [血量<30%, 逃跑]
 * ├─ Sequence [可见, 距离<攻击范围, 攻击]
 * ├─ Sequence [可见, 追击]
 * └─ 巡逻
 * ```
 * 加一条规则 = 插一个节点，不影响其他分支。
 *
 * 【三种返回状态】
 * - Success：做完了
 * - Failure：做不了
 * - Running：还在做（下一帧继续）
 *
 * Running 是关键——它让"追击中"这种持续行为有了自然表达。
 */

import { IDisposable } from '../_core/types';
import { safeDt, numOr } from '../_core/math';

/**
 * 秒数（等待时长 / 冷却时长）的收口
 *
 * 【为什么不能直接用 numOr】
 * numOr 把 **±Infinity 也算作非有限值**并回落到默认值。
 * 但 `Infinity` 在"等待/冷却"这个语境里是**合法且有用**的语义：
 *   - `Wait(Infinity)`      = 永远等待（等外部条件打断）
 *   - `Cooldown(Infinity)`  = 一次性技能，放完就永久进 CD
 * 直接回落成 0 会把这两种意图反过来变成"立刻通过 / 完全没有冷却"，
 * 属于静默改变既有行为。所以这里只收口 NaN 与负数，放行 Infinity。
 */
function fixSeconds(v: number): number {
  if (v === Infinity) return Infinity;
  return Math.max(0, numOr(v, 0));
}

export enum BTStatus {
  Success = 0,
  Failure = 1,
  Running = 2,
}

/** 黑板：节点间共享的数据 */
export type Blackboard = Record<string, unknown>;

/** 节点接口 */
export interface IBTNode<C = unknown> extends IDisposable {
  readonly name: string;
  tick(ctx: C, bb: Blackboard, dt: number): BTStatus;
  reset(): void;
}

/** 节点工厂：用于构建树 */
export type BTChild<C> = IBTNode<C>;

// ============================================================
// 组合节点（Composite）
// ============================================================

/**
 * Selector（选择节点）：依次尝试，第一个非 Failure 的结果作为结果
 * 语义："做 A，不行就做 B，再不行做 C"
 */
/**
 * 【⚠️ 为什么 destroy 要去重】
 * 同一个节点实例被挂在多个位置是常见写法（比如"公共的前置检查"节点）。
 * 老实现 `for (const c of this._children) c.destroy()` 会把它 destroy 两遍
 * ——实测 Selector 里放两个相同子节点，destroy 计数是 2。
 * 而 destroy 通常是"注销监听 / 归还对象池"，跑两遍可能二次归还同一个对象，
 * 属于那种"当时不报错、以后随机崩"的问题。
 */
function destroyAllUnique(children: ReadonlyArray<IBTNode<unknown>>): void {
  const seen = new Set<IBTNode<unknown>>();
  for (const c of children) {
    if (seen.has(c)) continue;
    seen.add(c);
    (c as IBTNode<unknown>).destroy();
  }
}

export class Selector<C> implements IBTNode<C> {
  private _runningIndex = -1;

  constructor(
    public readonly name: string,
    private readonly _children: BTChild<C>[]
  ) {}

  tick(ctx: C, bb: Blackboard, dt: number): BTStatus {
    for (let i = 0; i < this._children.length; i++) {
      const status = this._children[i].tick(ctx, bb, dt);
      if (status !== BTStatus.Failure) {
        if (status === BTStatus.Running) this._runningIndex = i;
        return status;
      }
    }
    this._runningIndex = -1;
    return BTStatus.Failure;
  }

  reset(): void {
    this._runningIndex = -1;
    for (const c of this._children) c.reset();
  }

  get runningIndex(): number {
    return this._runningIndex;
  }

  destroy(): void {
    destroyAllUnique(this._children as ReadonlyArray<IBTNode<unknown>>);
  }
}

/**
 * Sequence（顺序节点）：依次执行，遇到第一个非 Success 就返回
 * 语义："先做 A，A 成了再做 B，B 成了再做 C；任何一步失败就整体失败"
 */
export class Sequence<C> implements IBTNode<C> {
  private _runningIndex = -1;

  constructor(
    public readonly name: string,
    private readonly _children: BTChild<C>[]
  ) {}

  tick(ctx: C, bb: Blackboard, dt: number): BTStatus {
    for (let i = 0; i < this._children.length; i++) {
      const status = this._children[i].tick(ctx, bb, dt);
      if (status !== BTStatus.Success) {
        if (status === BTStatus.Running) this._runningIndex = i;
        return status;
      }
    }
    this._runningIndex = -1;
    return BTStatus.Success;
  }

  /** 当前正在 Running 的子节点下标（-1 = 无） */
  get runningIndex(): number {
    return this._runningIndex;
  }

  reset(): void {
    this._runningIndex = -1;
    for (const c of this._children) c.reset();
  }

  destroy(): void {
    destroyAllUnique(this._children as ReadonlyArray<IBTNode<unknown>>);
  }
}

/**
 * Parallel（并行节点）：每帧 tick 所有子节点
 *
 * @param policy 何时返回 Success：
 *   'all'  —— 全部成功（默认）
 *   'any'  —— 任一成功
 */
export class Parallel<C> implements IBTNode<C> {
  /** 已返回过 Success 的子节点下标（仅在 skipCompleted 时使用） */
  private readonly _done = new Set<number>();

  constructor(
    public readonly name: string,
    private readonly _children: BTChild<C>[],
    private readonly _policy: 'all' | 'any' = 'all',
    /**
     * 已 Success 的子节点是否不再 tick（默认 false = 保持既有行为）
     *
     * 【⚠️ 默认为什么不开】
     * 默认行为是每帧 tick **所有**子节点，包括已经 Success 的——
     * 实测：一个已 Success 的 Action 在 3 帧内被重复执行 3 次。
     * 若子节点是"播放音效""发射子弹"这类动作，就会被反复触发。
     * 但 Parallel 也常被用来跑"需要每帧持续生效"的并行行为，
     * 直接改成跳过会改变现有树的行为，所以做成可选项：
     * 需要"一次性动作"语义时显式传 true。
     */
    private readonly _skipCompleted = false
  ) {}

  tick(ctx: C, bb: Blackboard, dt: number): BTStatus {
    let successCount = 0;
    let anyRunning = false;

    for (let i = 0; i < this._children.length; i++) {
      if (this._skipCompleted && this._done.has(i)) {
        successCount++;
        continue;
      }
      const s = this._children[i].tick(ctx, bb, dt);
      if (s === BTStatus.Success) {
        successCount++;
        if (this._skipCompleted) this._done.add(i);
      } else if (s === BTStatus.Running) {
        anyRunning = true;
      }
    }

    if (this._policy === 'any' && successCount > 0) return BTStatus.Success;
    if (this._policy === 'all' && successCount === this._children.length) return BTStatus.Success;
    return anyRunning ? BTStatus.Running : BTStatus.Failure;
  }

  reset(): void {
    this._done.clear();
    for (const c of this._children) c.reset();
  }

  destroy(): void {
    destroyAllUnique(this._children as ReadonlyArray<IBTNode<unknown>>);
  }
}

// ============================================================
// 装饰节点（Decorator）
// ============================================================

/** Inverter：反转子节点的成功/失败 */
export class Inverter<C> implements IBTNode<C> {
  constructor(
    public readonly name: string,
    private readonly _child: BTChild<C>
  ) {}

  tick(ctx: C, bb: Blackboard, dt: number): BTStatus {
    const s = this._child.tick(ctx, bb, dt);
    if (s === BTStatus.Success) return BTStatus.Failure;
    if (s === BTStatus.Failure) return BTStatus.Success;
    return s;
  }

  reset(): void {
    this._child.reset();
  }

  destroy(): void {
    this._child.destroy();
  }
}

/** Succeeder：无论子节点结果如何都返回 Success */
export class Succeeder<C> implements IBTNode<C> {
  constructor(
    public readonly name: string,
    private readonly _child: BTChild<C>
  ) {}

  tick(ctx: C, bb: Blackboard, dt: number): BTStatus {
    const s = this._child.tick(ctx, bb, dt);
    return s === BTStatus.Running ? BTStatus.Running : BTStatus.Success;
  }

  reset(): void {
    this._child.reset();
  }

  destroy(): void {
    this._child.destroy();
  }
}

/**
 * Repeater：重复执行子节点 N 次（times = Infinity 表示无限）
 *
 * 【⚠️ 子节点返回 Failure 时不会被上报，而是转成 Running】
 * 只有次数用尽才返回 Success。也就是说挂在 Repeater 下的子节点
 * 永远看不到 Failure 往外传——想让 Failure 终止循环，
 * 得在 Repeater 外面套一层来判断。这里保持既有语义（改了会让现有树行为突变），
 * 只把这条写清楚。
 *
 * 【⚠️ times = 0 表示"一次都不执行"】
 * 老实现先 tick 子节点、再 `_count++ >= _times` 判定，
 * 于是 times = 0 时子节点**仍会执行一次**才返回 Success。
 * 现在在 tick 入口就判定，0 次 = 真的一次都不跑。
 *
 * 【坑】无限 Repeater 下的子节点必须会返回 Success/Failure，
 * 如果永远 Running，Repeater 就永远计数不到，AI 会卡住。
 */
export class Repeater<C> implements IBTNode<C> {
  private _count = 0;
  private readonly _times: number;

  constructor(
    public readonly name: string,
    private readonly _child: BTChild<C>,
    times: number = Infinity
  ) {
    /**
     * 【⚠️ times = NaN 会退化成"无限"】
     * `_count >= NaN` 恒为 false，于是 Repeater 永不结束——
     * 实测 100 帧内子节点被执行 100 次且状态始终是 Running。
     * 次数来自配表（"重复 3 次攻击"），NaN 是漏填时的典型值，
     * 用 numOr 收口成文档默认值 Infinity（与"不传参"一致）。
     */
    this._times = numOr(times, Infinity);
  }

  tick(ctx: C, bb: Blackboard, dt: number): BTStatus {
    // 0 次（或负数）= 不执行，直接算完成。
    // 用肯定式取反写，NaN 也一并落在这一支（虽然构造时已收口）。
    if (!(this._times > 0)) return BTStatus.Success;

    const s = this._child.tick(ctx, bb, dt);

    if (s === BTStatus.Running) return BTStatus.Running;

    this._count++;
    if (this._count >= this._times) {
      this.reset();
      return BTStatus.Success;
    }

    // 子节点完成了一轮，重置它以便下一轮
    this._child.reset();
    return BTStatus.Running;
  }

  reset(): void {
    this._count = 0;
    this._child.reset();
  }

  destroy(): void {
    this._child.destroy();
  }
}

/**
 * Cooldown：子节点成功后进入冷却，冷却期内直接返回 Failure
 *
 * 【典型用法】"冲刺"这种有 CD 的行为
 */
export class CooldownDecorator<C> implements IBTNode<C> {
  private _remain = 0;
  private readonly _seconds: number;

  constructor(
    public readonly name: string,
    private readonly _child: BTChild<C>,
    seconds: number
  ) {
    // 【为什么要在构造函数里就把 _seconds 收口】
    // 这个秒数来自配表（JSON/Excel 解析出来的 number），漏填时是 null、''、undefined。
    // 原写法把它原样存下来：`_remain = NaN` 之后 `_remain > 0` 恒为 false
    // —— 冷却**永不生效**，表现为技能每帧释放，而 `remain` 读到 NaN，
    // 日志里也看不出异常。NaN 一旦进到 _remain 就没有自愈机会（后续只做减法）。
    // 收口成"NaN / 负数 = 0 秒（即无冷却）"，让 remain 至少是个可观测的有限数。
    // Infinity 保留原语义（放一次后永久冷却 = 一次性技能），见 fixSeconds。
    this._seconds = fixSeconds(seconds);
  }

  tick(ctx: C, bb: Blackboard, dt: number): BTStatus {
    if (this._remain > 0) {
      if (safeDt(dt)) this._remain -= dt;
      return BTStatus.Failure;
    }
    const s = this._child.tick(ctx, bb, dt);
    if (s === BTStatus.Success) this._remain = this._seconds;
    return s;
  }

  get remain(): number {
    return this._remain;
  }

  reset(): void {
    this._remain = 0;
    this._child.reset();
  }

  destroy(): void {
    this._child.destroy();
  }
}

// ============================================================
// 叶子节点（条件 / 动作）
// ============================================================

/** 条件节点：predicate 返回 true → Success */
export class Condition<C> implements IBTNode<C> {
  constructor(
    public readonly name: string,
    private readonly _predicate: (ctx: C, bb: Blackboard) => boolean
  ) {}

  tick(ctx: C, bb: Blackboard): BTStatus {
    return this._predicate(ctx, bb) ? BTStatus.Success : BTStatus.Failure;
  }

  reset(): void {}
  destroy(): void {}
}

/**
 * 动作节点
 *
 * 【为什么返回 Running 而不是 void】
 * "攻击"不是一瞬间完成的——有前摇、判定、后摇。
 * 返回 Running 让动作能跨帧持续，行为树会每帧继续 tick 它。
 */
export class Action<C> implements IBTNode<C> {
  constructor(
    public readonly name: string,
    private readonly _fn: (ctx: C, bb: Blackboard, dt: number) => BTStatus
  ) {}

  tick(ctx: C, bb: Blackboard, dt: number): BTStatus {
    return this._fn(ctx, bb, dt);
  }

  reset(): void {}
  destroy(): void {}
}

/**
 * 等待 N 秒（期间返回 Running）
 *
 * 【典型用法】"发现玩家后先愣 0.5 秒再追"——
 * 这个短暂的停顿是让 AI 显得"有反应时间"的关键，
 * 瞬间反应的敌人会让人觉得不真实且难以应对。
 */
export class Wait<C> implements IBTNode<C> {
  private _elapsed = 0;
  /** 首次进入时是否重置计时器（默认 true） */
  private readonly _autoReset: boolean;
  private readonly _seconds: number;

  constructor(
    public readonly name: string,
    seconds: number,
    autoReset = true
  ) {
    this._autoReset = autoReset;
    // 【为什么要在构造函数里就把 _seconds 收口】
    // 等待时长通常直接来自配表。漏填/填错（null、''、NaN）时原写法会把 NaN 存进 _seconds，
    // 于是 tick 里的 `_elapsed >= this._seconds` 恒为 false ——
    // **这个节点永远返回 Running**，整棵树的后续节点再也不执行。
    // 表现为怪物站着不动、Boss 不放技能，而且不报错、不看日志完全定位不到
    // （实测：Wait(0.1) 600 帧内成功 85 次，Wait(NaN) 是 0 次，状态始终 Running）。
    // 收口成"非法值 = 0 秒"后，最坏情况是"不等待直接通过"，AI 退化但不会卡死。
    // 负数同理：负的等待时长语义不明，一并夹到 0。
    this._seconds = fixSeconds(seconds);
  }

  tick(_ctx: C, _bb: Blackboard, dt: number): BTStatus {
    if (safeDt(dt)) this._elapsed += dt;
    if (this._elapsed >= this._seconds) {
      const shouldReset = this._autoReset;
      if (shouldReset) this._elapsed = 0;
      return BTStatus.Success;
    }
    return BTStatus.Running;
  }

  reset(): void {
    this._elapsed = 0;
  }

  get elapsed(): number {
    return this._elapsed;
  }

  destroy(): void {}
}
