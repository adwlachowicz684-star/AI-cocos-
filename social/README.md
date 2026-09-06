# social/Report · 举报系统

> 举报写起来是"插一条数据库记录"，难点全在三个地方。

## 1. 五分钟上手

```typescript
import { ReportCenter, severityWeighted, updateCredibility } from './social/Report';

const rc = new ReportCenter({ actionThreshold: 5, dailyLimit: 5 });

const r = rc.submit('p1', 'cheater', 'cheating', Date.now(), { credibility: 100 });
// → { result: 'accepted', ticket: {...} }

rc.statsOf('cheater');        // → { total: 3, weighted: 3.0, ... }
rc.needsAction('cheater');    // → false（3.0 < 5）
rc.remainingToAction('cheater');  // → 2.0
```

## 2. ⚠️ credibility 是 0~100 量纲

```typescript
{ credibility: 1 }     // ❌ 会被 minWeight(0.2) 兜住，演示不出差异
{ credibility: 100 }   // ✅
```

传错不会报错，只会让所有举报的权重都变成同一个值。

## 3. ⚠️ 两套"权重"口径完全不同

| | `weightOf()` 实例方法 | `severityWeighted()` 函数 |
|---|---|---|
| 公式 | `credibility / 100` | `credibility / 100 × 理由权重` |
| 范围 | 0.2 ~ 1.0 | 0.2 ~ 5.0 |
| 含理由 | ❌ | ✅ |
| **用途** | **判定是否处理** | **排序审核队列** |

`actionThreshold` 比的是 `weightOf` 的累加值，
也就是"有几个可信的人举报"，**与理由无关**。

拿 `severityWeighted` 的返回值去比 `actionThreshold`，
会让"1 条作弊举报"（5.0）越过"3 个可信玩家"（3.0）的门槛——
这不是设计意图，是口径错配。

**为什么两个都要有**：判定门槛必须只看"举报人可不可信"
（理由严重程度是主观的，而且会让"大家都说开挂"自动触发处罚）；
但排序时确实该让开挂排在挂机前面。

## 4. 低信誉举报者不再细分

```typescript
if (t.reporterCredibility < lowCredibilityThreshold) return minWeight;
```

信誉 40 的人和信誉 5 的人，在"可不可信"上没有区别——都不可信。
按比例给（0.4 vs 0.2）等于承认"信誉 5 的人说的话还有 20% 参考价值"，
而这 20% 会让高频恶意举报者逐渐累积出可观的权重。

## 5. 信誉分变化不对称

```typescript
updateCredibility(50, +10);   // → 55（加 5）
updateCredibility(50, -10);   // → 40（扣 10）
```

加分慢、扣分快。如果一样快，玩家可以
"违规 → 被扣 → 老实几天 → 恢复 → 再违规"循环。

## 6. `ReportCenter` 完整接口

| 成员 | 说明 |
|---|---|
| `submit(...)` | 提交举报，返回 `{ result, ticket }` |
| `weightOf(ticket)` | 单条举报的权重（**受举报者信誉影响**） |
| `statsOf(targetId)` | 该目标的汇总统计 |
| `needsAction(targetId)` | 是否已达到处理阈值 |
| `remainingToAction(targetId)` | 还差多少权重才触发处理 |
| `reject(ticketId)` | 驳回某条举报，返回是否成功 |
| `rejectedCount(reporterId)` | 该举报者被驳回过多少次 |
| `isAbusiveReporter(reporterId)` | **是否属于滥用举报** |
| `clearFor(targetId)` | 清除某目标的所有记录，返回清了几条 |
| `size()` | 当前票据总数 |
| `cooldownRemaining(reporterId, targetId)` | 举报同一个目标的冷却剩余 |
| `remainingToday(reporterId, now)` | 当日剩余可举报次数 |

> ⚠️ **`needsAction` 看的是加权权重，不是举报条数。**
> 5 条低信誉玩家的举报可能还没到阈值，
> 而 1 条高信誉玩家的举报加上 2 条普通的就够了。
> 直接数条数会漏掉真正的作弊者，也会冤枉被批量恶意举报的人。

> ⚠️ **`isAbusiveReporter()` 是保护正常玩家的最后一道闸。**
> 某人被驳回次数多到一定程度后，他的举报权重会下降——
> 不做这个的话，"组队恶意举报"能让任何玩家被误封。

> ⚠️ **`cooldownRemaining` 是"举报同一目标"的冷却，不是全局冷却。**
> 举报 A 之后立刻举报 B 是允许的——
> 当全局冷却用的话，玩家举报第一个人之后就再也举报不了了。

> **`remainingToday` 要传 `now`**（不由模块内部取时间），
> 这样测试可以注入固定时间，
> 也不会受服务器/客户端时钟差异影响。

### 类型

```typescript
type ReportReason =
  | 'cheating' | 'griefing'      // 作弊 / 故意送·挂机
  | 'abusive-chat' | 'afk'       // 辱骂 / 挂机
  | 'inappropriate-name'         // 不当昵称
  | 'other';

type SubmitResult =
  | 'accepted' | 'cooldown' | 'daily-limit'
  | 'self-report' | 'duplicate';
```

> ⚠️ **`submit()` 返回的 `result` 是 `SubmitResult`，不是布尔。**
> `'cooldown'` / `'daily-limit'` / `'duplicate'` 都是**正常情况**，
> 不是错误。当作异常处理会污染日志，
> 而且玩家看到"举报失败"会以为系统坏了——
> 实际上应该提示"你最近已举报过该玩家"。

**`ReportTicket`**：

```typescript
{
  id, reporterId, targetId, reason,
  comment?, at, reporterCredibility, matchId?
}
```

> **`reporterCredibility` 是提交时快照的举报者信誉**，
> 不是实时查询。事后该玩家信誉变了，**这条票据的权重不变**——
> 这是刻意的，否则历史统计会随信誉波动而反复变化。

**`ReportStats`**（`statsOf()` 的返回）：

```typescript
{
  total: number;                                    // 总条数
  byReason: Readonly<Record<ReportReason, number>>;  // 按原因分组
  weighted: number;                                  // 加权总分
  uniqueReporters: number;                           // 唯一举报人数
}
```

> ⚠️ **`total` 和 `weighted` 是两个口径。**
> `needsAction()` 看的是 `weighted`。
> 做"已有 N 人举报"的提示 UI 时用 `uniqueReporters`——
> 用 `total` 的话，同一个人反复举报会把数字刷得很高，
> 反而让玩家觉得"这么多人举报怎么还不处理"。

**`ReportConfig`**（构造参数）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `cooldownMs` | 3,600,000（1 小时） | 举报同一目标的冷却 |
| `dailyLimit` | 5 | 每日上限 |
| `lowCredibilityThreshold` | 40 | 低于此值视为低信誉 |
| `minWeight` | 0.2 | 单条最小权重（**兜底**） |
| `actionThreshold` | 3 | 触发处理的加权阈值 |
| `abuseThreshold` | 5 | 被驳回多少次算滥用 |

### `REASON_SEVERITY`

```typescript
{
  'cheating': 5,              // 作弊 —— 最重
  'griefing': 2,              // 故意送 / 挂机
  'abusive-chat': 2,          // 辱骂
  'inappropriate-name': 1.5,  // 不当昵称
  'afk': 1,
  'other': 1,
}
```

> ⚠️ **这是"排序用"的严重度，不是 `actionThreshold` 的权重。**
> 第 3 节说的两套权重就是指这个——
> `severityWeighted()` 用它算"严重度总分"（排序/展示），
> 而 `needsAction()` 用的是"信誉 × minWeight"那套。
> 两个数字量纲不同，**不能互相比较**。

> ⚠️ **`minWeight` 是 0.2，它会兜住极低的信誉值。**
> 所以写 `{ credibility: 1 }` 想演示"低信誉权重低"是演示不出来的——
> 1 和 10 和 30 都会被夹到 0.2。详见第 2 节。
