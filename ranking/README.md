# ranking · 段位与赛季

> 玩家看不懂 1847 分意味着什么，但能秒懂"黄金 II，还差 53 分升 I"。


## ⚠️ 批内去重由 `done` 集合统一承担

早期版本有一个 `_isDuplicateInBatch()`，它扫描整个数组判断"有没有重复"，
但对**每一次**出现都返回 `true`（包括首次），
结果同一次 `grant()` 里重复出现的 id 会被**整批跳过**，一个都拿不到奖励。

现在删掉了那个方法。批内去重天然成立，因为 `done.add()` 在循环内部执行：

```typescript
for (const p of players) {
  if (done.has(p.id)) continue;   // 跨调用 + 批内，两种去重一次搞定
  ...
  done.add(p.id);                 // 第一个 p1 处理完就进了 done
}
```

**教训**：那种"扫描整个数组判断有没有重复"的写法，
天然分不清"第一次"和"第二次"。要去重就边遍历边记账，不要事后扫描。

## 1. 它解决什么

段位系统是把**连续分数翻译成离散等级**的展示层。四个麻烦点：

| 问题 | 后果 |
|---|---|
| **边界反复横跳** | "我刚升段就掉回去了"，最劝退的体验之一 |
| **掉段保护的实现** | 保护期内赢了要不要取消保护？（要，否则可以卡边缘刷） |
| **赛季重置的方式** | 硬重置让老玩家愤怒，不重置让新人永远追不上 |
| **小段编号方向** | 黄金 IV 是最低还是最高？（**最低**）搞反了整个进度条方向都反 |

---

## 2. 五分钟上手

```typescript
import { tierOf, RankProgress, softReset, defaultRankConfig } from './ranking/RankTier';

const cfg = defaultRankConfig();   // 青铜→宗师，7 段，每段 3 小段

tierOf(1650, cfg);
// → { label: '黄金 II', division: 1, floor: 1600, ceiling: 1700,
//     toNext: 50, progress: 0.5, isApex: false }

const rp = new RankProgress(cfg, 1400);
rp.update(1450);   // → { event: 'promoted', info: {...}, shieldGames: 0 }
rp.update(1300);   // → { event: 'demoted', shieldGames: 3, shielded: false }

softReset(2800, { baseline: 1200, factor: 0.5 });   // → 2000（宗师 → 钻石 III）
```

## 3. ⚠️ 小段编号方向

```
division = 0  →  I    最高
division = 1  →  II
division = 2  →  III  最低
```

**编号越小越高。** 这样"升段"永远是 division 减小，进度条永远向右涨，
不会在不同段位之间来回时方向反掉。

外部要比较大小时用 `rankScore()`，它把方向翻正为"数值越大越强"：

```typescript
rankScore(tierOf(1500, cfg));   // 黄金 III
rankScore(tierOf(1700, cfg));   // 黄金 I —— 数值更大
```

## 4. 边界横跳与掉段保护

### 滞回（promotionMargin）

```typescript
defaultRankConfig({ promotionMargin: 30 });
// 要超过段位线 30 分才算真升段
```

实测效果（分数在 1400 上下反复）：

```
无余量：升段 3 次、掉段 4 次
  1405 → ↓1395 → ↑1410 → ↓1390 → ↑1415 → ↓1385 → ↑1420 → ↓1380

加 30 分余量：升段 0 次、掉段 1 次 ✓
  1405 → ↓1395 → 1410 → 1390 → 1415 → 1385 → 1420 → 1380
```

### 掉段保护

掉到段位线以下后给 N 局保护（默认 3），期间不掉段。

**⚠️ 保护期内如果分数回到段位线以上，保护立刻清零。**

为什么必须这样：不清零的话玩家可以卡在边缘——
掉下去拿保护 → 打回来 → 保护还在 → 再掉下去又不用掉段，
等于永久免掉段。

```
白银 II（1350）→ 掉到 1250（白银 III，获 3 局保护）
  → 掉到 1150：shielded ✓，剩 2 局
  → 掉到 1150：shielded ✓，剩 1 局
  → 掉到 1150：shielded ✓，剩 0 局
  → 掉到 1150：真掉段 → 青铜 I
```

**注意演示分数要真的掉出段位线。** 白银 III 是 1200~1300，
用 1250 演示的话它本来就在区间内，系统认为"已回到线上"→ 保护立刻失效。

## 5. 赛季重置

```typescript
softReset(r, { baseline: 1200, factor: 0.5 });
// r' = 1200 + (r − 1200) × 0.5
```

| factor | 效果 |
|---|---|
| 1 | 完全不重置 |
| 0.5（推荐） | 保留一半差距 |
| 0 | 硬重置，全回 1200 |

**为什么不用硬重置**：上赛季的王者这赛季在低段位屠杀，前两周把新玩家全打跑了。

实测：

```
 800 → 1000   青铜 I    → 青铜 I
1200 → 1200   白银 III  → 白银 III
1800 → 1500   铂金 III  → 黄金 III
2500 → 1850   大师      → 铂金 II
2800 → 2000   宗师      → 钻石 III
```

排序保持不变（强者仍在前），但顶端被压缩，追赶变得可能。

## 6. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| **段位表未升序** | 查表结果错乱 | 构造时抛错检查 |
| **小段编号搞反** | 进度条方向反掉 | `division = 0` 恒为最高，用 `rankScore` 比较 |
| **没有滞回** | 边界反复横跳 | `promotionMargin` |
| **保护不清除** | 卡边缘永久免掉段 | 分数回到线上即清零 |
| **硬重置** | 赛季初新玩家被屠杀 | 软重置，保留一半差距 |
| **恰好在段位线上** | `1200` 是"白银 III"还是"白银 II 的最高位"？ | 是**白银 III**（进入新段的最低小段） |

## 6.5 API

### 段位（RankTier）

| 函数 | 说明 |
|---|---|
| `tierOf(rating, cfg)` | 分数 → 段位信息 |
| `rankScore(info)` | 段位 → 可比较的**标量**（**排序用这个**） |
| `romanNumeral(n)` | 转罗马数字，**n 是 0-based 索引**（`0 → I`、`1 → II`、`4 → V`） |
| `defaultRankConfig(overrides?)` | 默认配置 |

> ⚠️ **`romanNumeral(n)` 的 n 是小段索引（0-based），不是"第几段"。**
>
> 实测：`romanNumeral(0)='I'`、`1='II'`、`2='III'`、`3='IV'`、`4='V'`。
> 这里曾经写成"`1 → I`、`4 → IV`"——那是按 1-based 理解的，与实现相反，
> 照它算会让所有小段都偏移一位（division=1 你以为是 `I`，实际显示 `II`）。
>
> 另：`ROMAN` 表只有 10 个（`I`~`X`）。`n >= 10` 时返回 `String(n + 1)`——
> 也就是**退回阿拉伯数字**，且是 `n+1`（因为按 1-based 补的）。
> 段位超过 10 个小段时，label 会从"黄金 XI"变成"黄金 11"。
> 不抛错，静默降级。

> ⚠️ **比较段位高低要用 `rankScore()`，不要比 `tier` 字符串。**
> `rankScore` 把"大段 + 小段"压成一个数，
> 直接比字符串的话 `'Gold' > 'Silver'` 是字母序，
> 而 `'Bronze'` 和 `'Challenger'` 的相对关系完全是错的。

**类型**：`TierDef`（段位定义）/ `RankTierConfig`（配置）/ `TierInfo`（`tierOf` 的返回）/ `RankEvent` / `RankUpdate`

### 赛季重置

| 函数 | 说明 |
|---|---|
| `softReset(rating, cfg)` | 单个分数软重置 |
| `softResetAll(ratings, cfg)` | 批量，返回**新数组，不改原数组** |

**`SeasonResetConfig`**：

| 字段 | 说明 |
|---|---|
| `baseline` | 收缩基准分（通常取初始分，如 1200） |
| `factor` | 收缩系数 0~1（默认 0.5） |

- `1` = 完全不重置
- `0` = 硬重置，所有人回到 `baseline`
- `0.5`（推荐）= **保留一半差距**

> ⚠️ **硬重置（`factor: 0`）会让赛季初的新玩家被老玩家屠杀。**
> 所有人同一分起步，但实力天差地别，前两周的匹配体验是最差的。
> 保留一半差距是折中：新人有追赶空间，老玩家不至于从头碾压。

### 赛季发奖（`SeasonReward`）

`SeasonRewardDistributor` 负责按段位发奖。

**`RewardGrant` 的字段**：`playerId` / `tierId` / `tierLabel` / `rewards` / `skipped` / `skipReason`。

**`SeasonRewardConfig`**：

| 字段 | 说明 |
|---|---|
| `rankConfig` | 段位配置（**与 RankTier 共用**） |
| `rewards` | 奖励表（`RewardTier[]`） |
| `basis` | 结算口径（默认 `'highest'`，即**按赛季最高段位**而非结束时刻） |

`RewardTier`：`tierId`（`'*'` 表示兜底）/ `rewards` / `label?`。
`SeasonPlayer`：`id` / `finalRating`（结束时快照）/ `peakRating`（赛季最高）/ `games`。

> ⚠️ **默认按 `peakRating` 结算，不是 `finalRating`。**
> 玩家赛季末掉分不影响奖励——这是刻意的，
> 否则"冲上王者后故意掉分保号"会成为最优策略。

> ⚠️ **`skipped` 为 true 时 `rewards` 是空的，但记录仍然存在。**
> 跳过的原因是参与局数不足（`skipReason === 'too-few-games'`）——
> 发奖界面要区分"没获奖"和"没资格"，别把两者混成"没有奖励"。

### 分布诊断（**给策划看的**）

| 函数 | 说明 |
|---|---|
| `tierDistribution(players, cfg)` | 段位分布统计 |
| `diagnoseDistribution(...)` | 段位分数线是否合理 |

**健康分布是"中间大两头小"**：

| 现象 | 判据 |
|---|---|
| 最低段位占比过高 | 门槛太低，**段位失去意义** |
| 最高段位占比过高 | 门槛太低，**顶端没有区分度** |
| 最高段位占比为 0 | 门槛太高，**玩家没有目标** |

> 这两个函数不是给玩家用的，是赛季结束时给策划调分数线用的。
> `diagnoseDistribution` 直接给出诊断结论，不用自己看数字猜。

### 段位追踪器（RankTracker）

掉段保护需要**状态**（还剩几局保护），纯函数做不到，所以这里是个类。

| 成员 | 说明 |
|---|---|
| `current` | 当前段位信息，**保护期内返回"已掉出线但受保护"的状态** |
| `exportState()` / `importState(s)` | 存档 |

> ⚠️ **`current` 在保护期内返回的不是"实际分数对应的段位"。**
> 它返回的是**受保护后的显示段位**——玩家分数已经掉下去了，
> 但界面上仍显示原段位。
> 做"距离掉段还有 X 分"的提示要看这个，别自己拿 `tierOf()` 算。

### 发奖器的其余方法

| 成员 | 说明 |
|---|---|
| `resolve(player)` | 按赛季最高段位结算 |
| `forceGrant(player)` | **强制补发**（管理员手动干预） |
| `isGranted(seasonId, playerId)` | 该赛季是否已发放过 |
| `grantedCount(seasonId)` | 已发放数量 |
| `resetSeason(seasonId)` | 清空发放记录（**仅限测试/回滚**） |

> ⚠️ **`forceGrant` 绕过幂等检查，会发两次。**
>
> 它单独成一个方法、名字里带 `force`，是刻意的：
> 藏在主流程里的"跳过幂等"参数是事故温床——
> 某天有人传错参数，全服玩家领两次。
> **显式命名让调用点一眼可见。**

> **`isGranted` 是幂等的查询入口。**
> 正常流程用 `resolve` 就够了（它内部查幂等）；
> `isGranted` 是给"发奖前先看看有没有发过"的场景用的。

**`RewardBasis`**：`'highest'`（赛季最高）或 `'final'`（结束时刻）。
导出的 `DEFAULT_TIERS` 是默认段位表，可用 `defaultRankConfig()` 覆写。

## 7. 部署

```
复制 ranking/ 整个目录
依赖：'../_core/math'（clamp / clamp01）
```

依赖图：第 1 层，只依赖 `_core`，零横向依赖。
