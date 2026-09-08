/**
 * BehaviorTree —— 行为树运行器
 *
 * 【为什么需要运行器】
 * 树本身只是结构。运行器负责：
 * - 每帧 tick
 * - 记录上帧状态，检测「某个节点刚开始/刚结束」
 * - 统计（调试时看 AI 卡在哪个节点）
 * - 优雅地重置
 *
 * 【使用示例】
 * ```typescript
 * const tree = new BehaviorTree(
 *   new Selector<EnemyCtx>('root', [
 *     // 血低了跑
 *     new Sequence('flee', [
 *       new Condition('hp低', (c) => c.hp / c.maxHp < 0.3),
 *       new Action('逃跑', (c, bb, dt) => { c.moveAwayFrom(c.player); return BTStatus.Running; }),
 *     ]),
 *     // 能打就打
 *     new Sequence('attack', [
 *       new Condition('在射程内', (c) => c.distToPlayer < c.atkRange),
 *       new CooldownDecorator('攻击CD',
 *         new Action('攻击', (c, bb, dt) => c.attack()), 1.5),
 *     ]),
 *     // 否则追
 *     new Sequence('chase', [
 *       new Condition('看得见', (c) => c.canSeePlayer),
 *       new Action('追击', (c, bb, dt) => { c.moveTo(c.player); return BTStatus.Running; }),
 *     ]),
 *     // 兜底：巡逻
 *     new Action('巡逻', (c, bb, dt) => { c.patrol(); return BTStatus.Running; }),
 *   ])
 * );
 *
 * // 每帧
 * tree.tick(enemyCtx, dt);
 *
 * // 调试
 * tree.lastStatus;   // BTStatus.Running
 * tree.blackboard;   // 跨节点共享数据
 * ```
 *
 * 【无引擎依赖】上下文类型由调用方定义。
 */

import {
  IBTNode,
  BTStatus,
  Blackboard,
} from './BTNode';
import { IDisposable } from '../_core/types';

export interface BehaviorTreeOptions {
  /** 调试：打印每次 tick 的结果 */
  readonly debug?: boolean;
  /**
   * 树返回 Success 或 Failure 后是否自动 reset
   *
   * 【为什么要这个选项】
   * 默认 true：树"完成"后回到初始状态，下次 tick 从头开始。
   * 但如果你的根节点返回 Success 表示"这一轮决策完成"（比如一次攻击打完），
   * 你通常希望它下一帧重新开始——所以默认 true 是对的。
   *
   * 设为 false 的场景：你想在外部控制 reset 时机。
   */
  readonly autoReset?: boolean;
}

export class BehaviorTree<C> implements IDisposable {
  private readonly _root: IBTNode<C>;
  private readonly _debug: boolean;
  private readonly _autoReset: boolean;

  public readonly blackboard: Blackboard = {};

  private _lastStatus: BTStatus = BTStatus.Failure;
  private _tickCount = 0;

  /** 每个节点最近一次的状态（调试面板用） */
  private readonly _nodeStatus = new Map<string, BTStatus>();

  constructor(root: IBTNode<C>, opts: BehaviorTreeOptions = {}) {
    this._root = root;
    this._debug = opts.debug ?? false;
    this._autoReset = opts.autoReset ?? true;
  }

  get root(): IBTNode<C> {
    return this._root;
  }

  get lastStatus(): BTStatus {
    return this._lastStatus;
  }

  get tickCount(): number {
    return this._tickCount;
  }

  /**
   * 每帧推进
   *
   * 【坑】必须传 dt。用固定值（比如总是传 1）会导致
   * 所有「等待 N 秒」的节点在不同帧率下表现不同——
   * 高刷屏上 AI 会反应快一倍。
   */
  tick(ctx: C, dt: number): BTStatus {
    const status = this._root.tick(ctx, this.blackboard, dt);
    this._tickCount++;

    // 检测状态变化
    if (this._debug && status !== this._lastStatus) {
      console.log(`[BT] ${this._root.name}: ${BTStatus[this._lastStatus]} → ${BTStatus[status]}`);
    }
    this._lastStatus = status;

    // 完成后重置，让下一帧从头决策
    if (this._autoReset && (status === BTStatus.Success || status === BTStatus.Failure)) {
      this.reset();
    }

    return status;
  }

  /** 重置树（切换 AI 类型、死亡复活时） */
  reset(): void {
    this._root.reset();
    this._lastStatus = BTStatus.Failure;
  }

  /** 清空黑板 */
  clearBlackboard(): void {
    for (const k of Object.keys(this.blackboard)) delete this.blackboard[k];
  }

  /**
   * 记录节点状态（由节点或调试包装器调用）
   *
   * 【⚠️ 内置节点**不会**自动记录：它是手动接口，不是自动追踪】
   *
   * 字段上方的注释曾经写"每个节点最近一次的状态（调试面板用）"，
   * 让人以为 tick 之后 `trackedNodes` 会自动填满。
   * 实测：跑完一次 tick，`trackedNodes.size = 0`——
   * Selector / Sequence / Condition / Action / Wait **一个都不调用 recordNode**。
   * 调试面板恒空，而注释措辞暗示它应该自动工作。
   *
   * 【为什么没有直接改成自动追踪】
   * 节点接口 `IBTNode` 不暴露 children，运行器无法通用地遍历整棵树；
   * 给每个内置节点加 tree 反向引用会破坏"节点是可独立复制的纯对象"这个前提。
   * 需要调试面板时，请自己在 Action/Condition 的回调里调
   * `tree.recordNode(name, status)`，或包一层调试节点。
   *
   * 【用途】调试面板显示"AI 现在卡在哪个节点"。
   * 当 AI 行为异常时，这个比看日志快十倍。
   */
  recordNode(name: string, status: BTStatus): void {
    this._nodeStatus.set(name, status);
  }

  getNodeStatus(name: string): BTStatus | undefined {
    return this._nodeStatus.get(name);
  }

  get trackedNodes(): ReadonlyMap<string, BTStatus> {
    return this._nodeStatus;
  }

  destroy(): void {
    this._root.destroy();
    this.clearBlackboard();
    this._nodeStatus.clear();
  }
}

// 重新导出节点类型，方便使用方只 import 一个文件
export * from './BTNode';
