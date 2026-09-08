# matchmaking · 撮合 / 分队 / 房间

> 匹配系统的 bug 没有一个是"崩溃"，全是"这游戏匹配有问题"。

## 1. 三个模块的分工

| 模块 | 负责 | 输入 | 输出 |
|---|---|---|---|
| **Matchmaker** | 从队列里**挑人** | 带分数的条目 | 一批对局 |
| **TeamBalancer** | 把挑出来的人**分队** | 带分数的玩家 | 若干支实力接近的队 |
| **Lobby** | 朋友之间**组队** | 玩家 | 房间状态 |

典型链路：`Lobby` 组队 → 整体入 `Matchmaker` 队列 → 撮合后用 `TeamBalancer` 分队 → 开局。

---

## 2. Matchmaker

### 五分钟上手

```typescript
import { Matchmaker } from './matchmaking/Matchmaker';

const mm = new Matchmaker({
  teamSize: 5,              // 每队 5 人
  teamsPerMatch: 2,         // 5v5
  initialRange: 50,         // 初始只接受 ±50 分
  rangeGrowthPerSec: 3,     // 每秒放宽 3 分
  maxRange: 400,
  guaranteedAfterMs: 120_000,   // 等 2 分钟后无视分数，先开局
});

// ⚠️ 散人用 enqueueAll，组队用 enqueue
mm.enqueueAll(soloPlayers, Date.now());
mm.enqueue([p1, p2, p3], Date.now());     // 这一批是一支队伍

// 每秒调一次
setInterval(() => {
  for (const m of mm.tick(Date.now())) startGame(m);
}, 1000);
```

### ⚠️ enqueue vs enqueueAll

| 方法 | 语义 | 传 10 个散人会怎样 |
|---|---|---|
| `enqueue(entries)` | **这一批人是一支队伍** | 报错：10 人超过每队上限 |
| `enqueueAll(entries)` | 按 `partyId` 分组，无 partyId 的各自独立 | 正确入队 |

这是最容易踩的 API 坑。传错的话会收到一条
"队伍 N 人超过每队上限"的报错，而你的本意是塞 10 个互不认识的人。

### 三个关键机制

**① 窗口随等待时间放宽**

刚进队列只接受 ±50 分 → 等 60 秒放宽到 ±230 → 设了上限就不再涨。
不放宽的话，凌晨人少时永远排不到人。

**② 范围必须双向成立**

```
A 等了 5 分钟，窗口 ±400
B 刚进队列，窗口 ±50
分差 400

只看 A → 撮合成功 → B 被分差 400 的对手打崩
正确   → min(400, 50) = 50 → 不撮合
```

只检查单边的后果：新手刚点"开始匹配"就被大佬捞走，当场退出游戏。

**③ 超时兜底要在两处都放开**

`relaxed` 标志算出来之后，**候选收集**和**候选筛选**两道都得跳过范围检查。
只放开一处的话，前一道把候选筛没了，后一道拿到空数组，兜底完全失效——
凌晨排到超时也进不去游戏，而这恰恰是兜底唯一该起作用的场景。

### 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| **只检查单边范围** | 新手被等了很久的大佬捞走 | 取两者窗口的较小值 |
| **数"组"而不是数"人"** | 3 人黑店 + 3 散人 = 4 组 6 人，`4+1 < 6` 判定人不够 → 永远撮不出来 | 累加 `members.length` |
| **兜底只放开一处** | 排队超时也进不去 | 两处都放开 |
| **队伍超容量才报错** | 5v5 塞进 6 人黑店，队列里干等 | 入队时立即拒绝 |
| **撮合后不清队列** | 同一批人被撮进两场 | `_removeAll` |
| **组队的人退出只退自己** | 剩下的人被当成残缺队伍撮合出去 | 按 `partyId` 整队退出 |
| **每 tick 只撮一场** | 队列 50 人时每秒才撮一场 | `tick` 内部循环到撮不出为止 |

### 队伍平衡

```typescript
// 关闭平衡 = 按进队顺序简单切分
new Matchmaker({ teamSize: 5, balanceTeams: false });
```

开启后会在贪心（LPT）基础上做局部搜索。实测：

```
[2000, 1500, 1500, 1000]
  蛇形 (2000,1500) vs (1500,1000) → 两队差 500
  LPT  (2000,1000) vs (1500,1500) → 两队差 0
```

### API（Matchmaker）

| 成员 | 说明 |
|---|---|
| `enqueue(...entries)` | **一个队伍**进队列（这批人必定同队） |
| `enqueueAll(entries)` | 多个**独立**的人进队列 |
| `dequeue(id)` / `clear()` | 取消排队 / 清空队列 |
| `tick(now)` | 推进（**撮合在内部自动发生**，没有单独的公开入口） |

> ⚠️ **本模块没有公开的 `tryMatch()`。**
> 源码里的 `_tryMatch()` 是**私有方法**（前缀下划线），由 `tick()` 内部调用。
> 早期文档把它写成了公开 API，照着调会报
> `Property 'tryMatch' does not exist`。
>
> 想手动控制撮合时机的话：不调 `tick()` 就不会撮合——
> `tick(now)` 里既推进等待计时，也执行撮合，两者不分开。

| `queueSize` | 队列中的**人数** |
| `matchSize` | 一局需要几人（`teamSize × teamsPerMatch`） |
| `waiting` | 等待中的 id 列表 |
| `waitOf(id, now)` | 某人已等待毫秒（**UI 显示"已等待 1:23"**） |
| `matchesMade` | 累计撮合成功次数（统计用） |

> ⚠️ **`queueSize` 数的是"人"不是"组"。**
> 3 人黑店 + 3 个散人 = **6**（不是 4）。
> 早期版本按组数判断 `candidates.length + 1 < matchSize`，
> 导致有组队时永远撮不出来——这个 bug 已修，测试锁住了。

> **撮合结果 `MatchResult` 的字段**：
> `teams`（分好的队）、`quality`（质量 0~1）、
> `maxWaitMs` / `avgWaitMs`（等待时长统计）、
> `relaxed`（**是否走了超时兜底**）、`teamRatings`（各队平均分）。
>
> `relaxed === true` 意味着这局是"放宽条件硬凑的"，
> 可以据此决定是否提示玩家"当前在线人数较少"。

---

## 3. TeamBalancer

撮合器负责挑人，分队器负责怎么分。

```typescript
import { balanceTeams, validateTeamAssignment } from './matchmaking/TeamBalancer';

const r = balanceTeams(players, {
  teamCount: 2,
  metric: 'sum',                              // 'sum' | 'top' | 'both'
  roleQuota: { tank: 1, dps: 2, support: 2 }, // 可选
});

r.spread;      // 平均分最大差距
r.fairness;    // 0~1
validateTeamAssignment(r.teams.map(t => t.players));   // 硬约束校验
```

### ⚠️ 黑店是硬约束

同 `partyId` 的人**必定同队**。这意味着均衡度会下降——
两个 2000 分的人组队，对面必然吃亏。这不是算法不够好，是约束的代价。

### metric 怎么选

| 口径 | 比较什么 | 适合 |
|---|---|---|
| `sum` | 各队总分 | 默认，大多数场景 |
| `top` | 各队最强者 | 避免"一队有个大哥" |
| `both` | 两者各半 | 两者都重要时 |

```
(2500, 500) vs (1500, 1500) —— 总分都是 3000，sum 口径认为完美均衡
但 top 口径下差 1000 —— 实际是"一个人 carry 四个拖油瓶"
```

---

## 4. Lobby

### 五分钟上手

```typescript
import { Lobby } from './matchmaking/Lobby';

const l = new Lobby({ capacity: 4, minPlayers: 4 });
l.join({ id: 'a', name: 'Alice' });
l.setReady('a', true);
l.startBlockReason();    // → "还需要 3 人"
l.beginStart();          // 条件不足时返回 false
```

### API（Lobby）

**查询**（房间面板 UI）

| 成员 | 说明 |
|---|---|
| `size` / `capacity` | 当前人数 / 上限 |
| `isFull` / `isEmpty` | 满 / 空 |
| `players` / `slots` | 玩家列表 / **槽位列表**（含 `ready`、`isHost`、`joinedAt`） |
| `hostId` | 房主 id，**空房间是 `null`** |
| `state` | `'open'` / `'starting'` / `'closed'` |
| `has(id)` / `isReady(id)` / `isHost(id)` | 单项查询 |
| `readyCount` | 已准备人数 |
| `hasPassword` | 是否设了密码 |
| `revision` | **版本号，每次状态变化 +1**（脏检查用） |
| `snapshot()` | 快照 |

> **`slots` 和 `players` 的区别**
> `players` 只有玩家数据；`slots` 是 `LobbySlot`，
> 额外带 `ready` / `isHost` / `joinedAt`。
> 画房间界面（谁准备了、谁是房主）用 **`slots`**。

> **`revision` 是给客户端做脏检查的。**
> 版本号没变就不用重绘 UI——房间界面轮询时省掉大量无谓刷新。

**操作**

| 成员 | 说明 |
|---|---|
| `join(player, password?, now?)` | 加入，返回 `LobbyJoinResult` |
| `leave(id)` / `kick(opId, targetId)` | 离开 / **踢人** |
| `transferHost(opId, targetId)` | 转移房主 |
| `setReady(id, ready)` / `toggleReady(id)` / `resetReady()` | 准备状态 |
| `canStart()` / `startBlockReason()` / `beginStart()` / `finishStart()` | 开局流程 |
| `close()` / `reopen()` | 关闭 / 重开 |
| `setPassword(opId, password?)` | 设/清密码（传 `undefined` 清除） |

> ⚠️ **`kick` 和 `transferHost` 都要求第一个参数是"操作者 id"。**
> 它们返回 `false` 表示操作不合法（不是房主、目标是自己、目标不存在）——
> **不抛错**。做权限校验时要自己看返回值。


### 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| **房主走了不迁移** | 剩下的人对着"开始"按钮点了半天没反应 | `leave` 里自动迁移给第一个人 |
| **准备状态用数组存** | 取消再准备 push 两次 → "还有人没准备" | 用 `Set` |
| **踢人后状态残留** | 已离开的人还占着 ready 位 | `leave` 里一并清 |
| **开局中放人进来** | 加载完发现队里多了个陌生人 | `starting` 状态拒绝加入 |
| **能重复开局** | 点两下加载两次场景 | `canStart` 检查 `state === 'open'` |
| **reopen 保留准备状态** | 连开第二局时有人根本没看 | `reopen` 清空准备 |

---

## 4.5 顶层工具函数

撮合质量与等待时间，都是**给玩家看**的指标：

| 函数 | 说明 |
|---|---|
| `matchQuality(ratings, teamSize)` | 对局质量 **0~1** |
| `estimateWaitMs(...)` | 估算等待毫秒（UI 显示"预计等待 45 秒"） |

**`matchQuality` 怎么算**：用队伍平均分的**相对离散度**。
所有人分数相同 → 1；分差极大 → 接近 0。

用途有三个：撮合时设 `minQuality` 卡质量、结算时展示"本局匹配质量"、
A/B 测试不同匹配参数的效果。

> ⚠️ **`estimateWaitMs` 是粗略估计，不是承诺。**
> 它基于当前队列人数与历史撮合速率算出"数量级感受"。
> 精确承诺做不到——**做不到的承诺比不给更糟**，
> 玩家看到"预计 45 秒"等了 3 分钟，比没看到这个数字更愤怒。

### 分队

| 函数 | 说明 |
|---|---|
| `balanceTeams(players, opts)` | 分队（**主力**） |
| `splitIntoTwoTeams(players)` | 简单对半分（**不保证均衡**） |
| `validateTeamAssignment(teams)` | 校验硬约束（黑店、人数、角色配额） |

> ⚠️ **`splitIntoTwoTeams` 不做均衡，只按顺序对半切。**
> 它是给"已经排好序、就是要对半分"的场景用的。
> 想分得公平用 `balanceTeams`——
> 用错的表现是"每次都是强队打弱队"，而且看不出规律（取决于入队顺序）。

## 4.6 类型速查

写类型标注时会遇到这些名字：

| 类型 | 是什么 |
|---|---|
| `QueueEntry` / `MatchmakerConfig` | 撮合：队列项 / 配置 |
| `BalancePlayer` / `BalanceOptions` / `BalancedTeam` / `BalanceResult` | 分队 |
| `LobbyPlayer` / `LobbyConfig` / `LobbyState` / `LobbySlot` | 房间 |

### `join()` 的失败原因有五种

```typescript
type LobbyJoinError = 'full' | 'duplicate' | 'closed' | 'wrong-password' | 'started';
interface LobbyJoinResult { readonly ok: boolean; readonly error?: LobbyJoinError }
```

> ⚠️ **`error` 是 `undefined` 而不是 `null`，且只有失败时才有值。**
> 想给玩家看具体原因（"房间已满"vs"密码错了"）必须判 `error`，
> 只判 `ok` 的话所有失败都只能显示"加入失败"。

### `balanceTeams` 返回的均衡指标

| 字段 | 说明 |
|---|---|
| `teams` | 分队结果 |
| `spread` | 平均分最大差距 |
| `totalSpread` | 总分最大差距 |
| `fairness` | 公平度 0~1（**1 = 完全均衡**） |
| `iterations` | 实际迭代次数（调试用） |

> **黑白配 vs 公平度**：`spread` 是绝对值（分差多少），
> `fairness` 是归一化的（0~1）。
> 做"这局均不均衡"的展示用 `fairness`，做数值分析用 `spread`。

## 5. 部署

```
复制 matchmaking/ 整个目录
依赖：'../_core/math'（clamp）
```

依赖图：第 1 层，只依赖 `_core`，零横向依赖。
