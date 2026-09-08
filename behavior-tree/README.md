# behavior-tree — 行为树

## 为什么不用 if-else

一个稍复杂的敌人 AI 用 if-else 写出来，加一条"血量低于 20% 时优先逃跑"
就要重排整个 if 链，优先级隐式地藏在**书写顺序**里，改一处可能影响全部。

行为树把优先级变成**显式的树结构**：加一条规则 = 插一个节点，不影响其他分支。

## 三种返回状态

| 状态 | 含义 |
|---|---|
| `Success` | 做完了 |
| `Failure` | 做不了 |
| `Running` | 还在做（下一帧继续） |

`Running` 是关键——它让"追击中"这种持续行为有了自然表达。

## 用法

```typescript
import {
  BehaviorTree, Selector, Sequence, Condition, Action, Wait,
  CooldownDecorator, Inverter, BTStatus,
} from './behavior-tree/BehaviorTree';

const tree = new BehaviorTree<EnemyCtx>(
  new Selector('root', [
    // 血低了跑（优先级最高）
    new Sequence('flee', [
      new Condition('血量低', (c) => c.hp / c.maxHp < 0.3),
      new Action('逃跑', (c) => { c.moveAway(c.player); return BTStatus.Running; }),
    ]),
    // 能打就打
    new Sequence('attack', [
      new Condition('在射程内', (c) => c.distToPlayer < c.atkRange),
      new CooldownDecorator('攻击CD',
        new Action('攻击', (c) => c.attack()), 1.5),
    ]),
    // 兜底：巡逻
    new Action('巡逻', (c) => { c.patrol(); return BTStatus.Running; }),
  ])
);

tree.tick(ctx, dt);       // 每帧
tree.blackboard;          // 跨节点共享数据
tree.lastStatus;
```

## 节点一览

**组合节点**

| 节点 | 语义 |
|---|---|
| `Selector` | 依次尝试，第一个非 Failure 的结果作为结果（"做 A，不行做 B"） |
| `Sequence` | 依次执行，任一失败则整体失败（"先 A，A 成了再 B"） |
| `Parallel` | 每帧 tick 所有子节点，策略 'all' / 'any' |

**装饰节点**：`Inverter`（反转）、`Succeeder`（永远成功）、
`Repeater`（重复 N 次）、`CooldownDecorator`（冷却）

**叶子节点**：`Condition`（条件）、`Action`（动作）、`Wait`（等待 N 秒）

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| `tick` 不传真实 dt | 高刷屏上 AI 反应快一倍 | 必须传 `dt` |
| 无限 Repeater 下的子节点永远 Running | AI 卡死 | 子节点必须会返回 Success/Failure |
| 忘了 `autoReset` 的语义 | 树完成后行为不对 | 默认 true：完成后下一帧从头决策 |
| 用 Selector 表达"全部做完" | 语义反了 | 那是 Sequence |
| 把"发现玩家后的愣神"省略 | AI 反应不真实、难以应对 | 加一个 `Wait(0.5)` |

## 调试

```typescript
tree.recordNode('attack', BTStatus.Running);
tree.trackedNodes;   // Map { 'attack' => Running }
tree.tickCount;
```

AI 行为异常时，看当前 Running 的节点比看日志快十倍。

> ⚠️ **`trackedNodes` 是手动接口，不是自动追踪。**
> 内置节点（Selector / Sequence / Condition / Action / Wait …）**一个都不会自动调用
> `recordNode`**——跑完一次 tick 后 `trackedNodes.size` 仍然是 `0`。
> 想用它做调试面板，请自己在 Action / Condition 的回调里调
> `tree.recordNode(name, status)`，或包一层调试节点。
>
> （为什么没做成自动：节点接口 `IBTNode` 不暴露 children，运行器无法通用地遍历整棵树；
> 给每个节点加 tree 反向引用会破坏"节点是可独立复制的纯对象"这个前提。）

## API

| 成员 | 说明 |
|---|---|
| `tick(ctx, dt)` | 每帧推进 |
| `reset()` | 重置树（切换 AI 类型、复活时） |
| `blackboard` | 共享数据对象 |
| `lastStatus` / `tickCount` | 状态与统计 |
| `recordNode` / `trackedNodes` | 调试追踪 |
| `getNodeStatus(name)` | 按名字取节点状态（**调试面板用**） |
| `runningIndex` | 当前 running 节点的位置 |
| `elapsed` / `remain` | 已用 / 剩余时间（`Timeout`/`Wait` 节点用） |
| `destroy()` | 递归销毁所有节点 |

### Blackboard

| 成员 | 说明 |
|---|---|
| `get(key)` / `set(key, v)` | 读写 |
| `has(key)` | 是否存在 |
| `delete(key)` | 删除 |
| `clear()` | 清空（**重置 AI 时调**，否则上一局的数据会带到下一局） |
| `size` | 条目数 |

> ⚠️ **`reset()` 不会清 Blackboard。**
> 复活一个怪时只 `reset()` 的话，它还记着上一条命的目标位置——
> 表现为「刚复活的怪径直走向玩家上次站的地方」。
> 要连数据一起清：`tree.reset(); tree.blackboard.clear()`。

---

## `clearBlackboard()`

清空黑板上的**所有**键。

> ⚠️ **它会连"共享黑板"一起清。**
> 构造时如果传了外部黑板对象，调它会把别人的数据也清掉——
> 多实体共用一块黑板时，一个实体清黑板会让其他实体的 AI 全部失忆。
>
> 只想清当前实体自己的变量，得自己维护一份私有黑板。
