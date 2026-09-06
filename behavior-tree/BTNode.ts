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
import { safeDt } from '../_core/math';

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
    for (const c of this._children) c.destroy();
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
    for (const c of this._children) c.destroy();
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
  constructor(
    public readonly name: string,
    private readonly _children: BTChild<C>[],
    private readonly _policy: 'all' | 'any' = 'all'
  ) {}

  tick(ctx: C, bb: Blackboard, dt: number): BTStatus {
    let successCount = 0;
    let anyRunning = false;

    for (const c of this._children) {
      const s = c.tick(ctx, bb, dt);
      if (s === BTStatus.Success) successCount++;
      else if (s === BTStatus.Running) anyRunning = true;
    }

    if (this._policy === 'any' && successCount > 0) return BTStatus.Success;
    if (this._policy === 'all' && successCount === this._children.length) return BTStatus.Success;
    return anyRunning ? BTStatus.Running : BTStatus.Failure;
  }

  reset(): void {
    for (const c of this._children) c.reset();
  }

  destroy(): void {
    for (const c of this._children) c.destroy();
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
 * 【坑】无限 Repeater 下的子节点必须会返回 Success/Failure，
 * 如果永远 Running，Repeater 就永远计数不到，AI 会卡住。
 */
export class Repeater<C> implements IBTNode<C> {
  private _count = 0;

  constructor(
    public readonly name: string,
    private readonly _child: BTChild<C>,
    private readonly _times: number = Infinity
  ) {}

  tick(ctx: C, bb: Blackboard, dt: number): BTStatus {
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

  constructor(
    public readonly name: string,
    private readonly _child: BTChild<C>,
    private readonly _seconds: number
  ) {}

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

  constructor(
    public readonly name: string,
    private readonly _seconds: number,
    autoReset = true
  ) {
    this._autoReset = autoReset;
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
