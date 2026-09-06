# dialogue — 对话系统

## 为什么用图而不是树

用图（节点 + 跳转）而不是树，因为对话经常需要**回到之前的节点**
（"让我再想想"→ 回到选项列表），这在树里要复制整棵子树。

## 用法

```typescript
interface S { gold: number; hasQuest: boolean }

const g = new DialogueGraph<S>();

g.node('start', {
  speaker: '铁匠',
  text: '想打造点什么？',
  choices: [
    { text: '打造武器', next: 'craft', condition: (s) => s.gold >= 100, lockedHint: '需要 100 金币' },
    { text: '闲聊', next: 'smalltalk' },
    { text: '再见', next: null },
  ],
});
g.node('craft', {
  speaker: '铁匠', text: '好嘞',
  onEnter: (s) => { s.gold -= 100; },
  next: 'start',
});
g.node('smalltalk', { speaker: '铁匠', text: '今天天气不错', next: 'start' });

// 校验（启动时跑一次）
const errors = g.validate();          // 跳转到不存在的节点
const dead = g.findUnreachable('start'); // 没人能到达的节点

// 运行
const runner = g.start('start', state);
runner.current;       // { speaker, text, choices: [{text, enabled, hint}] }
runner.choose(0);     // 选第一个（条件不满足返回 false）
runner.advance();     // 单句节点推进
runner.isDone;
```

## 图是静态的，Runner 是会话

`DialogueGraph` 是所有玩家共享的**静态数据**；
`DialogueRunner` 是**会话状态**（每个玩家一段对话一个）。
分开后才能多人/多次同时对话而互不干扰。

## 两个体检方法

| 方法 | 发现什么 |
|---|---|
| `validate()` | 跳转到不存在的节点（运行时表现为"对话说到一半卡住"，且只在特定分支触发） |
| `findUnreachable(startId)` | 死内容（写了但没人能到达的对话） |

建议**启动时跑一次**，这两类错误靠手动测试很难覆盖全。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| choices 是空数组 | 语义不明 | `validate()` 会报；应改用 `next` |
| `next` 成环 | `advanceToChoice` 死循环 | 已加安全上限 |
| 有选项的节点用 `advance()` | 推不动，玩家以为卡了 | 有选项必须用 `choose()` |
| 状态类型被拒绝 | 编译器报错 | 泛型约束是 `object` 不是 `Record<string,unknown>`（见源码注释） |

## API

### DialogueGraph
| 成员 | 说明 |
|---|---|
| `node(id, def)` / `nodes(defs)` | 注册（重复 id 抛错） |
| `validate()` | 返回错误列表 |
| `findUnreachable(startId)` | 返回不可达节点 |
| `start(startId, state)` | 创建运行器 |

### DialogueRunner
| 成员 | 说明 |
|---|---|
| `current` | 当前展示内容（渲染层直接读） |
| `choose(index)` | 选选项，返回是否成功 |
| `advance()` | 单句推进，返回是否成功 |
| `advanceToChoice(maxSteps?)` | 连续播到有选项的节点（**有安全上限**） |
| `jumpTo(id)` | 强制跳转（任务系统插入对话） |
| `end()` | 强制结束 |
| `currentNodeId` | 当前节点 id（**存档用**：恢复对话时 `jumpTo` 回来） |
| `destroy()` | 清空 |

### 存档与恢复

```typescript
save.dialogueNode = runner.currentNodeId;
// 读档
const runner = graph.start(save.dialogueNode ?? startId, state);
```

> ⚠️ **存 `currentNodeId` 而不是"第几句"。**
> 对话图是**图不是树**——同一个节点可以从多条路径到达，
> "第几句"在不同分支上指的是完全不同的内容。

### 图查询

| 成员 | 说明 |
|---|---|
| `nodeIds` | 全部节点 id |
| `getNode(id)` | 取节点定义 |
| `isDone` / `history` | 状态与走过的路径 |
