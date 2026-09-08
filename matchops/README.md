# matchops · 对局运营三件套

> 断线、投降、观战——三个看起来是"小功能"，实则决定玩家信任度的模块。

## 1. Reconnect · 断线重连

### grace 与 forfeit 是两个阈值

```
grace        = 重连窗口（超时就回不来了）
forfeitAfter = 判负阈值（超时才算逃兵）
```

中间那段是**缓冲带**：玩家连不上来，但系统还没判他负，
队友可以选择继续等，而不是被系统推着走。

### 宽限期递减

```typescript
const rc = new ReconnectTracker({
  graceMs: 60_000, forfeitAfterMs: 120_000,
  maxAttempts: 5, graceDecay: 0.6,
});
// 第 1 次 60s → 第 2 次 36s → 第 3 次 21.6s → 触底 minGraceMs
```

防止"反复断线重连拖延时间"。

### ⚠️ 必须用真实时间

用游戏时间的话，掉线的人只要让局面暂停，宽限期就永远走不完。
本模块只接受 `Date.now()` 一类的单调真实时钟。

### API（ReconnectTracker）

| 成员 | 说明 |
|---|---|
| `register(ids)` | 登记本局玩家 |
| `markDisconnected(id, now)` / `reconnect(id, now)` | 标记断线 / 重连 |
| `tick(now)` | 推进，返回**本帧新判负的 id 列表** |
| `stateOf(id)` / `graceFor(id)` / `remainingMs(id, now)` | 单项查询 |
| `snapshot()` | 全部条目（**做重连倒计时 UI**） |
| `endMatch()` | 结束对局（之后再重连返回 `after-end`） |
| `disconnectedCount` / `forfeitedCount` | 统计 |
| `penaltyRates` | 扣分比例配置 |
| `isActive` | 对局是否还在进行 |

> ⚠️ **`tick` 返回的是"本帧新判负的"，不是"所有已判负的"。**
> 每帧拿它去全量处理会重复扣分。
> 想知道谁已经判负了，用 `stateOf(id)` 或 `snapshot()`。

> ⚠️ **`endMatch()` 之后重连会返回 `reason: 'after-end'`。**
> 不调它的话，对局结束了宽限期还在走——
> 表现为"比赛都结束了还在提示等待玩家重连"。

## 2. Surrender · 投降投票

### ⚠️ 分母是在线人数，不是队伍人数

```
5 人队走 2 个，剩 3 人，threshold = 0.66
按 5 算：ceil(5×0.66) = 4 票 → 3 个人永远投不出来 → 只能挂机
按 3 算：ceil(3×0.66) = 2 票 → 2 票就能投出去 ✓
```

用队伍人数当分母，等于让掉线的人投了永远的反对票——
**而投降功能存在的意义，恰恰是防止玩家只能挂机。**

### ⚠️ 所需票数在发起时冻结

5 人开局需要 3 票，投到一半掉 2 人，分母变 3、需求降到 2——
一个"本来通不过"的投票因为掉线而通过了。

更糟的是这**可以被主动利用**：想投降的人让队友"掉线"就能降低门槛。
所以 `start()` 时把需求冻结，掉线只会减少票数，不会降低需求。

### 弃权默认算反对

`abstainAsYes: false`。设成 true 的话，挂机的人被自动算作赞成，
一局可能在没有一个人明确同意的情况下被投降掉。

### API（SurrenderManager / 投票器）

| 成员 | 说明 |
|---|---|
| `setTeam(ids)` / `setConnected(ids)` | 设置队伍 / **更新在线名单** |
| `markMatchStart(now)` | 标记开局时刻（**`too-early` 判定靠它**） |
| `start(id, now)` / `vote(id, choice, now)` | 发起 / 投票 |
| `cancel()` / `clear()` | 取消投票 / 清空状态 |
| `status()` | 当前状态（`SurrenderStatus`） |

> ⚠️ **不调 `markMatchStart` 就没有"开局多久内不能投降"的限制。**
> 表现为"刚进游戏就能投降"——
> 而这正是 `SurrenderError` 里 `'too-early'` 存在的意义。

> ⚠️ **`setConnected` 要每帧或每次掉线时更新。**
> 它需要在线名单来算分母（见本节第一条）。
> 忘了更新的话，掉线的人仍占着分母，票永远投不出去。

> ⚠️ **掉线玩家的票会被 `vote()` 直接拒绝（`not-connected`），与 `start()` 口径一致。**
> 老实现里 `vote` 只查队伍与状态、不查在线，而计票时又把掉线者的票跳过：
> 玩家看到"投票成功"，票数却一动不动，于是反复点、以为是网络问题。
> 配合 `requireAllConnected: true`（默认）时，只要有一人掉线，
> 投降永远无法达成，对局被拖到超时。
> `status().ignoredVotes` 给出"已投但未被计入"的票数，UI 可据此提示。

## 3. Spectate · 观战

### 延迟是安全要求，不是体验选项

观众能零延迟看到选手视野，就能开第二个屏幕报点：
"对面在 B 点下包""左边草丛有人"——这种作弊**无法用技术手段检测**。

### 全场可见会自动降级

```typescript
const j = spec.join('v1', now, { visibility: 'all' });
// 延迟不够时：j.effectiveVisibility === 'team-only'
```

**静默降级而非报错**。报错会让调用方疑惑"我明明配了 all 为什么说不行"；
降级并明确返回实际值，调用方按实际情况渲染即可。

### 各类型推荐延迟

| 类型 | 延迟 | 理由 |
|---|---|---|
| moba | 3 分钟 | 一个眼位信息就能决定团战胜负 |
| fps | 2 分钟 | — |
| rts | 5 分钟 | 全图信息 |

### API（SpectateSession）

| 成员 | 说明 |
|---|---|
| `join(id, now, opts?)` / `leave(id)` | 进出观战 |
| `switchTarget(id, target)` | 切换视角（`number` 选手位 / `'director'`） |
| `capacity` / `list()` | 观众上限 / 观众列表 |
| `visibilityOf(id)` | 某观众的**实际**可见性（**降级后返回降级值**） |
| `spectatorsVisible` | 被观战者能否看到观众列表 |
| `viewingTime(now)` | 观战者**应该看到的画面时刻** |
| `lagBehind(now)` | 距离"实时"还差多少 |

> ⚠️ **`viewingTime` 才是延迟的真正含义——这一点极易搞错。**
>
> 观战者拿到的是 `now - delay` 时刻的**快照**，
> 而不是"延迟 delay 秒才开始播放"。
>
> 区别很关键：中途加入的观战者应该**立刻**看到
> "当前时刻往前推 delay"的画面，
> 而不是从对局开头重新播放——后者要等很久才追得上。

> **`visibilityOf` 返回的是降级后的实际值**，
> 配置的 `visibility: 'all'` 在延迟不够时会降级成 `'team-only'`。
> 渲染按返回值来，别按配置来。
| battle-royale | 3 分钟 | — |
| card | **0** | 信息本就公开，无泄露可言 |

---

## 4. 顶层工具函数

这三个文件里有一些**可以单独用**的纯函数，
不必先创建 `ReconnectManager` / `SurrenderVote` / `SpectateManager`。

### 对局裁决

| 函数 | 说明 |
|---|---|
| `shouldAbortMatch(alivePerTeam, threshold?)` | 是否该直接结束对局（而不是继续少打多） |
| `forfeitMultiplier(forfeits, maxMultiplier?)` | 断线惩罚倍率（**信誉分系统用**） |
| `surrenderDiscount(elapsedMs, ...)` | 投降的扣分减免系数 |

> **`shouldAbortMatch` 的判据**：任一队剩余可战人数低于阈值就结束。
> 默认 `threshold = 1`（全灭才结束）。
> 继续少打多没有意义，不如尽早结束让大家重开。

> ⚠️ **投降必须比挂机扣得少，否则理性玩家会选挂机。**
>
> `surrenderDiscount` 就是为此存在的：投降和挂机结果一样（都是输），
> 但投降是**配合系统的行为**，挂机是**破坏行为**。
> 扣分相同的话，玩家会想"反正都要扣，不如边扣边刷手机"——
> 于是投降功能形同虚设，摆烂变多。

### 观战辅助

| 函数 | 说明 |
|---|---|
| `isDelaySafe(delayMs, hasFog)` | 该延迟是否安全（**配置校验用**） |
| `recommendDelay(genre)` | 按游戏类型推荐延迟 |
| `pickDirectorShot(candidates)` | 导演视角自动切换：**给每个画面打分取最高** |
| `popularityTier(count)` | 观战人数分档（UI 显示"热门对局"） |
| `formatDelay(ms)` | 延迟格式化成人类可读文本 |

> **`isDelaySafe` 是给配置校验用的。**
> 有人把 `delay` 配成 0 时它返回 `false`，
> 可以在启动时检查并报警，而不是等到有人作弊才发现。
> 有战争迷雾的游戏要求更高（`hasFog = true`）。

> ⚠️ **`pickDirectorShot` 返回的是索引，`-1` 表示无候选。**
> 直接拿返回值当索引用的话，`-1` 会取到数组最后一个元素——
> 不报错，只是切到了错误的画面。

---

## 5. 状态枚举与类型

这三个模块各有自己的状态机，**枚举值要照着写**：

| 类型 | 取值 |
|---|---|
| `ReconnectState` | `'online'` / `'disconnected'` / `'forfeited'` / `'exhausted'` |
| `SurrenderState` | `'idle'` / `'voting'` / `'cooldown'` |
| `SurrenderVote` | `'yes'` / `'no'` / `'abstain'` |
| `SpectatorVisibility` | 见第 3 节的降级说明 |
| `JoinError` | `'full'` / `'duplicate'` / `'not-started'` / `'ended'` / `'opponent-forbidden'` / `'visibility-forbidden'` |

> ⚠️ **`ReconnectState` 里 `'forfeited'` 和 `'exhausted'` 是两回事：**
> - `forfeited` = 超时未重连（**时间到**）
> - `exhausted` = 重连次数用尽（**次数到**）
>
> 两者的惩罚可以不同——`forfeited` 通常是"这局判负"，
> `exhausted` 常见于"反复掉线"的玩家，可能触发信誉分处罚。

> **`JoinError` 有六种，别只处理`'full'`。**
> 尤其 `'opponent-forbidden'`（不允许观战对手视角）
> 和 `'visibility-forbidden'`（延迟不够，不能全场可见）——
> 只判 `full` 的话，玩家会看到"加入失败"却不知道为什么。

### 类

| 类 | 说明 |
|---|---|
| `ReconnectTracker` | 断线追踪（**有状态**：宽限期剩余、重连次数） |
| `SurrenderVote`* | 这里是 `type`（投票值），投票器是 `SurrenderManager` |
| `SpectateSession` | 单场观战会话（延迟、可见性、观众上限） |

> **`SpectateSession` 是"一场对局"的观战会话**，
> 不是全局管理器。多场对局同时开放观战时，每场一个实例。

### `ReconnectVerdict`

重连尝试的返回值：

| 字段 | 说明 |
|---|---|
| `ok` | 是否成功 |
| `reason?` | `'not-disconnected'` / `'expired'` / `'exhausted'` / `'after-end'` |
| 队友扣分比例 | 判负后**队友**的扣分比例（见下） |

> ⚠️ **`teammatePenaltyRate` 默认 0.5，别设 0。**
>
> 队友无辜被坑，全扣会让他们愤怒；
> 但设 0（完全不扣）又会被滥用——
> "四黑轮流掉线帮第五个人上分"。
> 0.5 是折中：队友有损失，但只有主犯的一半。

### 配置类型

| 类型 | 关键字段 |
|---|---|
| `ReconnectConfig` | `graceMs`（默认 120s）、`maxAttempts`（默认 3）、`teammatePenaltyRate` |
| `ReconnectEntry` | `id` / `state` / `disconnectedAt` / `attempts` / 本次宽限期 |
| `SurrenderConfig` | `teamSize`、`threshold`（默认 0.5） |
| `SurrenderStatus` | `state` / `yes` / `no` / `eligible` / `needMore` / `ignoredVotes` |
| `SpectateConfig` | `delayMs`（默认 120s）、`allVisionMinDelayMs`（默认 300s）、`maxSpectators` |

> ⚠️ **`graceMs` / `graceDecay` 为 NaN 时会回落到默认值，不会变成"永不过期"。**
> `??` 只挡 `null` / `undefined`，挡不住 NaN。
> 配置表里 `graceDecay` 算成 NaN 时，第一次 `Math.pow(NaN, 0) === 1`（**侥幸正确**，
> 所以"第一次断线看起来是好的"），重连一次后宽限期直接变 NaN，
> 而 `elapsed > NaN` 恒为 false → **任何时候重连都成功**、`tick` **永不判弃权**。
> 后果是悬挂对局：队友掉线 3 小时，比赛一直不结束；
> 而他既不是 `forfeited` 也不是 `exhausted`，队友连扣分减免都拿不到。
> `graceDecay` 还会被限制在 `(0,1]`——大于 1 会让宽限期越重连越长，语义完全反了。

**`graceMs` 怎么选**：
太短 → 正常网络波动就被判负；太长 → 对手干等，体验极差。
MOBA 通常 3~5 分钟（一局长），快节奏对战 60~120 秒。

**`SurrenderConfig.threshold` 怎么选**：
- `0.5` 多数通过（4 人需 3 票）→ **太容易，容易误投**
- `0.66` 三分之二（推荐，5 人需 4 票）
- `1.0` 全票通过 → 太难，几乎投不出去

> ⚠️ **`SurrenderStatus.eligible` 是"在线人数"，不是队伍人数。**
> 这就是第 2 节那条坑：掉线的人不该算进分母，
> 否则人越少越难投降，被困在一局里出不去。

**`SurrenderError`**：
`'too-early'` / `'already-voting'` / `'in-cooldown'` / `'not-connected'` / `'not-in-team'` / `'not-voting'`

> 六个错误码对应六种玩家可见的提示。
> `too-early`（开局多久内不能投降）和 `in-cooldown`（刚投过）最容易被忽略——
> 只显示"投降失败"的话，玩家会一直点。
> 直接拿返回值当索引用的话，`-1` 会取到数组最后一个元素——
> 不报错，只是切到了错误的画面。
