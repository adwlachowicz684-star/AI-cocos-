# timeutil · 时间工具

**时区 / 日界 / 体力周期 / 服务器时间校准 / 倒计时**

---

## 它解决什么

游戏里所有"时间"需求，坑都比看起来深：

| 需求 | 坑 |
|---|---|
| 每日 0 点刷新 | **哪个时区？** 玩家改系统时间怎么办？ |
| 体力 5 分钟回 1 点 | 切后台再回来，按真实时间还是游戏时间？ |
| 活动倒计时 | 客户端时间不准，显示"剩 -3 秒" |
| 赛季结算 | 跨时区玩家同时看到不同结果 |

## 用法

```typescript
// ① 每日刷新（明确指定时区，不用本地时区）
const idx = dayIndex(now, Zones.CN);
if (isNewDay(now, lastSeenDay, Zones.CN)) giveDailyReward();

// ② 体力恢复（maxTicks 夹紧，防离线一天回来补满）
const gained = ticksSince(lastClaim, now, 300_000, 20);

// ③ 服务器时间校准（一次握手，之后本地推算）
const clock = new ClockSync();
clock.sync(serverTime, localAtRequest, localAtResponse);
const now = clock.now();

// ④ 倒计时（remaining 永不为负）
const cd = new Countdown(60_000);
cd.start(now);
cd.remaining(now2);   // 后台回来按真实时间推进
```

## API

### 每日刷新（都要显式传时区）

| 函数 | 说明 |
|---|---|
| `dayIndex(now, zone)` | 第几天（从 epoch 起）。存它，别存时间戳 |
| `isNewDay(now, lastSeen, zone)` | 跨天了吗。每日奖励、每日任务用它 |
| `startOfDay(now, zone)` | 当天 00:00 的时间戳 |
| `startOfNextDay(now, zone)` | 次日 00:00（做**倒计时终点**用这个） |
| `msUntilNextDay(now, zone)` | 距次日 00:00 还有多少毫秒 |

> ⚠️ **存"第几天"而不是"时间戳"。**
> 存时间戳的话，玩家改系统时间就能反复领每日奖励；
> `dayIndex` 是基于 UTC 偏移算的，改时区只影响判定在哪一刻翻页，不影响唯一性。

```typescript
// UI 上"距刷新还有 02:13:45"
const left = msUntilNextDay(now, Zones.CN);
showCountdown(formatDuration(left));
```

### 体力 / 离线收益

`ticksSince(lastClaim, now, intervalMs, maxTicks)` —— 已经过去几个周期，
**夹在 `maxTicks` 以内**。防"离线一天回来补满"。

### 时间源

| 函数 | 说明 |
|---|---|
| `monotonicNow()` | 单调时钟（不受系统时间回拨影响）。**算间隔用它**，不要用 `Date.now()` |

`ClockSync` 用于服务器时间校准：一次握手，之后本地推算。

| 成员 | 说明 |
|---|---|
| `sync(serverTime, localAtRequest, localAtResponse)` | **标准校准**，补偿半个 RTT |
| `syncSimple(serverTime, localTime)` | 简化校准，**忽略 RTT** |
| `now()` | 估算的服务器时间 |
| `synced` | 是否已校准 |
| `offset` | 偏移量（服务器时间 − 本地时间） |
| `detectClockJump(toleranceMs?)` | 本地时钟是否被大幅改动（默认容差 60 秒） |
| `reset()` | 重置为未同步（**重新登录时调**） |

**`sync` 与 `syncSimple` 的区别**：

`sync` 要传**两个**本地时间（请求时 / 响应时），取中点补偿半个 RTT。
`syncSimple` 只接受一个时间戳，直接算差值——
用于**拿不到 RTT 的场景**（比如从存档里读到的服务器时间）。

> ⚠️ **未同步时 `now()` 回退到 `Date.now()`，不报错。**
>
> ```typescript
> now(): number {
>   if (!this._synced) return Date.now();   // ← 静默回退
>   ...
> }
> ```
>
> 这意味着"忘记校准"不会崩，但**防作弊能力完全失效**——
> 玩家改系统时间照样能绕过倒计时。
> 关键判定前用 `if (!clock.synced)` 拦一道。

> ⚠️ **`reset()` 之后 `synced` 变 false，但 `now()` 仍能调用。**
> 换账号重新登录时如果不重新 `sync()`，
> 拿到的会是本地时间而不是服务器时间——**不报错，只是悄悄变差了**。

> **单靠客户端挡不住改时间。**
> `detectClockJump` 只是提高门槛，真正的关键判定（发奖、领奖励）必须在服务器做。

### 导出常量与类型

| 导出 | 说明 |
|---|---|
| `DAY_MS` | 一天的毫秒数 |
| `CountdownState` | `'waiting'` / `'running'` / `'finished'`（**注意没有 paused**） |
| `Zone` / `Zones` | 时区偏移（`Zones.UTC` 等） |

### 倒计时

`Countdown(durationMs)`：`start(now)` / `remaining(now)`。
`remaining` **永不为负**，且按真实时间推进——切后台再回来读到的还是对的。

#### 完整状态机

| 成员 | 说明 |
|---|---|
| `start(now)` | 从头开始 |
| `startWith(remainMs, now)` | **从剩余时间开始**（存档恢复用） |
| `pause(now)` / `resume(now)` | 暂停 / 恢复 |
| `reset()` | 回到 `waiting` |
| `remaining(now)` | 剩余毫秒（**永不为负**） |
| `progress(now)` | 进度 0..1 |
| `isFinished(now)` | 是否结束 |
| `state(now)` | `'waiting'` / `'running'` / `'finished'` |
| `durationMs` | 总时长 |

> ⚠️ **没有 `'paused'` 状态——暂停时 `state()` 仍返回 `'running'`。**
>
> 实测（60 秒倒计时，暂停 50 秒）：
>
> ```
> 构造后          state=waiting   remaining=60000
> start           state=running   remaining=60000
> 走了 10s        state=running   remaining=50000
> pause @10s      state=running   remaining=50000   ← 状态没变
> 暂停中过了 50s    state=running   remaining=50000   ← 剩余也冻结，这是对的
> resume @60s     state=running   remaining=50000
> 恢复后再走 10s    state=running   remaining=40000
> ```
>
> `remaining` 在暂停期间**冻结**是对的（这正是暂停该有的行为），
> 但 `state()` 看不出暂停。UI 要做"已暂停"的显示，
> 得自己维护一个 `paused` 标记，别指望 `state()`。

> ⚠️ **`pause` / `resume` 对错误的状态是空操作，不报错。**
>
> - `pause`：已经暂停、或还没 `start` → 什么都不做
> - `resume`：没在暂停 → 什么都不做
>
> 这个设计让"重复调用"安全，但也让"忘记 start 就 pause"静默失效。

#### 存档恢复：用 `startWith`

```typescript
// 读档：把存档里的"剩余毫秒"接上，从当前时间继续
cd.startWith(savedRemainingMs, Date.now());
```

> ⚠️ **`startWith` 会把负数剩余夹成 0。**
> 存档里写了个负数（或时间已经跑过），倒计时会**立刻处于 finished**——
> 实测 `startWith(-5000, now)` 后 `state === 'finished'`、`remaining === 0`。
> 如果这是不期望的（比如存档损坏），要先自己校验。

#### `remaining` 在各状态下的值

| 状态 | `remaining(now)` |
|---|---|
| `waiting`（未开始 / reset 后） | **等于 `durationMs`** |
| 暂停中 | 暂停那一刻的剩余，**冻结不变** |
| `finished` | 0 |

> ⚠️ 未开始时 `remaining` 返回**满时长**，不是 0。
> 照着这个值直接驱动 UI，会看到"倒计时正在走"的假象——
> 实际它还没 `start`。判断有没有开始要看 `state() === 'running'`。

### 格式化

| 函数 | 说明 |
|---|---|
| `formatDuration(ms, opts?)` | `01:23:45`；`showHoursAlways` 控制是否总是显示小时 |
| `formatDurationCN(ms, maxUnits?)` | `1小时23分`；`maxUnits` 控制精度（默认 2 个单位） |

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **不能用本地时区** | 玩家改时区就能多领一次每日奖励。运营配"北京时间 0 点"必须用 `Zones.CN` |
| **`Date.now() + offset` 可被绕过** | 玩家改系统时间，推算出的"服务器时间"跟着跳。用单调时钟（`performance.now()`）推算 |
| **`ticksSince` 不夹紧会补满** | 离线一天回来直接满体力。用 `maxTicks`——这是设计决定不是优化 |
| **倒计时别用 `new Date(ms)` 格式化** | 超过 24 小时会进位成天数，显示 "1:00:00" 而不是 "24:00:00" |
| **`formatDuration` 的负数** | 已夹到 0，不会显示 "-1 秒" |

## 设计：时间源注入

所有函数都接受 `now` 参数，而不是内部调 `Date.now()`。

这不是洁癖——**不注入就没法测试**。"明天 3 点刷新对不对"这种逻辑，你不可能真的等到明天去验证。

## 测试

**48 项**，覆盖东八区/UTC 日界差异、RTT 中点补偿、时钟跳变检测、倒计时暂停恢复、格式化边界。
