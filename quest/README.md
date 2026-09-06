# quest — 任务系统

## 设计：上报，而不是注册监听

常见做法是给每个任务注册一堆事件监听（`onKill` / `onCollect`...）。
问题是任务多了以后，监听的注册/注销时机极易出错，漏注销还会泄漏。

这里反过来：**游戏里发生一件事就调 `report()`，系统内部匹配哪些目标关心它**。
加新任务不用改任何游戏代码。

## 用法

```typescript
const q = new QuestSystem();

q.define({
  id: 'kill_slimes',
  name: '清理史莱姆',
  objectives: [{ type: 'kill', target: 'slime', count: 5 }],
  rewards: { exp: 100, gold: 50 },
});

q.define({
  id: 'boss',
  name: '讨伐史莱姆王',
  requires: ['kill_slimes'],        // ← 前置
  objectives: [{ type: 'kill', target: 'slime_king', count: 1 }],
});

q.accept('kill_slimes');
q.report({ type: 'kill', target: 'slime', n: 3 });   // 3/5
q.status('kill_slimes');            // 'active'
q.completionRatio('kill_slimes');   // 0.6

q.report({ type: 'kill', target: 'slime', n: 2 });   // → completed
q.available;                        // ['boss'] 前置完成，解锁了

q.claim('kill_slimes');             // { exp:100, gold:50 }
q.claim('kill_slimes');             // null（**只能领一次**）
```

## 四种状态流转

```
locked --前置完成--> available --accept--> active --全部目标完成--> completed --claim--> claimed
                        ↑                    │
                        └──── abandon ───────┤
                                             └── fail --> failed
```

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 完成后继续累加 | 进度显示 **7/5** | 已处理：达标的目标不再累加 |
| 奖励发两次 | 玩家刷奖励 | 已处理：`claimed` 标记，`claim()` 返回 null |
| 前置没完成就显示 | 玩家看到不该看的任务 | 已处理：`locked` 状态 |
| 存档的目标数量变了 | 读档后进度错位 | 已处理：import 时补齐/截断 |
| 未知任务 id 抛错 | 删了任务后玩家进不去游戏 | 已处理：跳过并返回跳过数 |

## 为什么"完成"和"领奖"分开

让玩家手动领奖有两个好处：
1. 能弹"任务完成 + 奖励列表"界面，给正反馈
2. 奖励发放失败（比如背包满）可以稍后重试，而不是丢掉

## 自定义目标

```typescript
objectives: [{
  type: 'custom',
  target: '',
  test: (e) => e.type === 'levelup' && (e.n ?? 0) >= 10,
}]
```

## API

| 成员 | 说明 |
|---|---|
| `define(def)` / `defineAll(defs)` | 定义（后者返回错误列表，会校验前置） |
| `accept(id)` / `abandon(id)` / `fail(id)` | 流转 |
| `report(event)` | **上报游戏事件**，返回受影响的任务数 |
| `setProgress(id, objIdx, v)` | 直接设进度（调试/回档） |
| `claim(id)` | 领奖，返回奖励或 null |
| `status(id)` / `isClaimed(id)` | 状态查询 |
| `available` / `active` / `completed` | 列表 |
| `objectiveProgress(id, i)` | `{current, need}` |
| `completionRatio(id)` | 0~1 |
| `onComplete` / `onProgress` | 回调 |
| `export()` / `import()` / `reset()` | 存档 |

## API 补充

`destroy()` —— 清空全部任务与进度。换存档时调。

---

## 返回值结构

### `QuestProgress`

```typescript
interface QuestProgress {
  defId:    string;
  status:   QuestStatus;          // 任务状态
  progress: readonly number[];    // **各目标分别的进度**
  claimed:  boolean;              // 奖励是否已领取
}
```

> ⚠️ **`progress` 是数组，一个目标一项。**
> "击杀 10 只哥布林 + 采集 5 个草药"就是 `[7, 2]`。
> 当成单一数字读会只拿到第一个目标的进度，
> 表现为"第二个目标永远 0%"。

> ⚠️ **`claimed` 和 `status === 'done'` 是两回事。**
> 完成了但没领奖是常态——
> 只判 `status` 的话玩家会重复领奖。