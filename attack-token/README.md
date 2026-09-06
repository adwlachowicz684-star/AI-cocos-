# attack-token — 攻击令牌（防止被围殴秒杀）

## 它解决什么

五个敌人同时扑向玩家，同一帧全部命中。
玩家血量 100，每个怪打 25 —— 瞬间归零，连反应机会都没有。

玩家不会觉得「我操作失误了」，只会觉得「这游戏不公平」。
因为它确实不公平：**人无法同时应对五个攻击**。

攻击令牌是业界标准解法（《阿卡姆》《荣耀战魂》《只狼》都在用）：

> 同一时刻只允许 **N 个**敌人处于「正在攻击」状态，其余排队等待。

效果：

- 敌人轮流上，玩家能逐个格挡 / 闪避
- 视觉上变成「围而不攻」的包抄圈，压迫感反而更强
- 玩家能读懂「谁要打我了」

### 为什么比「降低伤害」好

降低伤害会让战斗软绵绵（打半天不死）。
令牌保持单个伤害不变，只控制**并发数**——
难度来自节奏密度而非数值堆砌。

## 零业务依赖

它不认识敌人、不认识攻击动作。只有 id 和「我要攻击」「我用完了」。

## 用法

```typescript
import { AttackTokenSystem } from './attack-token/AttackToken';

const tokens = new AttackTokenSystem({
  maxConcurrent: 2,
  maxQueued: 32,
  holdTimeout: 3,          // ⚠️ 强烈建议设置，见下
  starvationAfter: 2,      // 等 2 秒后开始提升优先级
});

// 敌人想攻击
const state = tokens.request(enemyId, priority);
if (state === 'active')   startAttack(enemyId);
else if (state === 'queued')   waitInCircle(enemyId);
else /* rejected */       backOff(enemyId);

// 攻击结束
tokens.release(enemyId, 'finished');

// 实体死亡 —— 统一在销毁时调用，别指望每个死亡分支都记得
tokens.remove(enemyId);

// 每帧
tokens.tick(dt);
```

## 参数怎么定

| 参数 | 建议 |
|---|---|
| `maxConcurrent` | 1 = 回合感强（只狼式决斗）；**2 = 推荐**；3 = 混乱（只有杂兵海合适）；≥4 基本失去意义 |
| `maxQueued` | 队列太长时队尾的怪要等几十秒，看起来像发呆。超限直接拒绝，让它去做别的行为 |
| `holdTimeout` | **必须设**。建议「最长攻击动画时长 × 2」 |
| `starvationAfter` | 防止高优先级 Boss 反复抢令牌，小怪永远排不上 |

## 两个必须知道的坑

### ① `holdTimeout` 不设会导致全体永久失去攻击能力

某个敌人攻击动画卡住、或者它被冰冻但没释放令牌，
令牌就永远不归还 → **所有敌人再也无法攻击** →
玩家发现怪都站着不动，游戏废了。

这个 bug **不抛任何异常**。

### ② 死亡必须调 `remove()`

指望业务在每个死亡分支都记得 `release()` 是不现实的。
漏一次就永久少一个令牌，而且没有任何报错。

所以 `remove()` 默认会自动释放（`autoReleaseOnRemove: true`）。

### ③ `reset()` 曾经会残留令牌

原实现循环调用 `release()`，而 `release()` 内部会把队列里的补上来——

```
maxConcurrent=2，持有 {1,2}，队列 [3]
release(1) → 3 补位 → active={2,3}
release(2) → 队列已空     → active={3}   ← 残留！
```

第二层后果更严重：**3 号从未收到 `onRelease`**，
业务侧以为它还在攻击中，不清理状态。

现在的做法是先把所有请求静默摘下来，再统一通知。

## API

| 成员 | 说明 |
|---|---|
| `request(id)` / `release(id)` | 申请 / 释放令牌 |
| `hasToken(id)` | 是否已拿到令牌（**正在攻击中**） |
| `isQueued(id)` | 是否在排队 |
| `requestState(id)` | `'queued'` / `'holding'` / `null`（**没在等也没拿到**） |
| `activeIds()` | 当前持有令牌的实体 id 列表 |
| `activeCount` | 持有数量 |
| `queuedCount` | 排队数量 |
| `freeSlots` | 剩余可用令牌数（**调试用**：长期为 0 说明有泄漏） |
| `cancel(id)` | 取消排队（实体中途死了要调） |
| `reset()` / `silentReset()` | 重置。**两者区别见下** |

> **`reset()` 与 `silentReset()` 的选择**
>
> | | 触发 `onRelease` 回调 | 用途 |
> |---|---|---|
> | `reset()` | ✅ 会 | 波次之间（让业务侧知道令牌被收回了） |
> | `silentReset()` | ❌ 不会 | **切场景** |
>
> 切场景时用 `reset()` 会向已经销毁的实体发回调——
> 那些回调多半持有节点引用，于是「换场景后偶发空指针」。

### `requestState` 的三态

```typescript
requestState(id)   // 'queued' | 'holding' | null
```

**`null` 不是"没拿到"**，是"这个实体压根没在申请"。
判断"能不能攻击"要用 `hasToken(id)`，
用 `requestState(id) === 'holding'` 也行，但 `!requestState(id)` 是错的——
它把「排队中」和「没申请」混为一谈。

## 诊断

```typescript
const s = tokens.stats();
// { active, queued, maxConcurrent, avgWait, maxWait }
```

上线前跑一场战斗看 `avgWait`：

| avgWait | 含义 |
|---|---|
| < 1s | 流畅 |
| 1~3s | 正常（玩家能感到「轮流上」的节奏） |
| > 5s | 令牌太少或敌人太多，需要调 maxConcurrent |

---

## 返回值结构

### `TokenRequest`

```typescript
interface TokenRequest {
  entityId:    number;              // 请求者
  priority:    number;              // 优先级（越大越优先）
  requestedAt: number;              // 请求时刻
  state:       TokenRequestState;   // 'queued' | 'active' | 'rejected'
  grantedAt:   number;              // 获得令牌的时刻
}
```

> **优先级的典型用法**：Boss/精英 +50、距玩家越近 +(10−dist)、
> 已排队很久 +等待时间（**防止饿死**）。
>
> 最后一条最容易被漏：不加等待时间补偿的话，
> 低优先级的小怪在大批高优先级敌人面前**永远抢不到令牌**，
> 表现为"远处的杂兵站着不动"。

### `TokenStats`（监控用）

```typescript
interface TokenStats {
  active:        number;   // 当前持有令牌数
  queued:        number;   // 排队中
  maxConcurrent: number;   // 并发上限
  avgWait:       number;   // 平均等待（**秒**）
  maxWait:       number;   // 最长等待（秒）
}
```

> ⚠️ **`avgWait` / `maxWait` 单位是秒，不是毫秒。**
> 混用的话数值会差 1000 倍，看起来像"等待时间爆表"。

---

## `time`

系统内部累计时间。

> ⚠️ **`time` 的单位取决于你传给 `tick()` 的 dt 单位。**
> 模块不做换算——传秒它就是秒，传毫秒就是毫秒。
> 拿它和"某个具体秒数"比较前，先确认自己 tick 传的是什么。
>
> 它的主要用途是诊断（`TokenStats` 里的等待时长），
> 业务逻辑不该依赖它。
