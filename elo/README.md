# elo · 评分（ELO + Glicko-2）

> 同一份 1500 分，新号和老号的可信度天差地别。

## 1. 两个模块，怎么选

| | ELO | Glicko-2 |
|---|---|---|
| **初始分** | **1200** | **1500** |
| 状态 | 一个数字（rating） | 三个量（r / RD / σ） |
| 定级 | 需要额外的"定级赛"机制 | **自带**：新号 RD 大，自动快速收敛 |
| 久未登录 | 分数不变，但可信度也不变（不合理） | **RD 自动上涨**，系统不再"确定"你 |
| 计算 | 每局实时算，极轻 | 必须**按周期批量结算** |

> ## ⚠️ 两套系统导出了同名函数 `expectedScore`
>
> | | `Elo.ts` | `Glicko2.ts` |
> |---|---|---|
> | 签名 | `expectedScore(ratingA, ratingB, cfg?)` | `expectedScore(p, opponent)` |
> | 入参 | **两个数字** | **两个玩家对象**（含 r / RD） |
> | 公式 | `1 / (1 + 10^((b−a)/scale))` | Glicko-2 的 E 函数（**含对手 RD 衰减**） |
>
> ⚠️ **传错不报错，会静默得到 `NaN`。**
>
> 把 Glicko2 的玩家对象传给 ELO 版本：数字运算作用在对象上得 `NaN`；
> 反过来把两个数字传给 Glicko2 版本：读 `opponent.phi` 得 `undefined`。
> 两种情况**都不抛异常**，评分结果一路都是 `NaN`，
> 表现为"分数算出来有点怪"，极难定位。
>
> **只 import 你正在用的那一个文件**，别两个都引。
>
> 实测（两种错法都**不抛异常**）：
>
> ```
> ELO 正确用法  (1500, 1400) → 0.6400649998028851
> ELO 传对象    (player, player) → NaN
> Glicko 传数字 (1500, 1400)    → NaN
> ```
>
> `NaN` 会一路传染——下一局的 rating 也是 `NaN`，
> 再下一局还是，直到存档里写满 `NaN`。
> 等发现时，历史数据已经没法用了。

> ⚠️ **两套系统的初始分不一样：ELO 是 1200，Glicko-2 是 1500。**
>
> 同一个目录里两套默认值，很容易记混。
> 想统一的话在各自的配置里显式传：
>
> ```typescript
> new EloSystem({ initialRating: 1500 });        // ELO 改成 1500
> createGlickoPlayer({ rating: 1200 });          // Glicko 改成 1200
> ```
>
> 混用的后果：玩家在两个榜单上看到的"初始分"不同，
> 而两边的分数**不能直接比较**（量纲都不同）。
| 适合 | 快节奏、每局独立、玩家量大 | 定级重要、玩家会长期离开再回来 |

**简单判据**：如果你需要在 UI 上显示"定级中"，用 Glicko-2。

---

## 2. ELO

### 五分钟上手

```typescript
import { rate1v1, rateMultiplayer, expectedScore, ratingGapFor } from './elo/Elo';

// 1v1
const r = rate1v1({ rating: 1500, games: 100 }, { rating: 1600, games: 100 }, 1);
// → { a: 1518, b: 1582, deltaA: +18.2, deltaB: -18.2, kA: 32, kB: 32 }

// 多人（吃鸡、赛车）：ranks 用 0 = 第一名，并列写相同数字
const after = rateMultiplayer(
  [p1, p2, p3, p4, p5, p6, p7, p8],
  [0, 1, 2, 3, 4, 5, 6, 7]
);

// 期望胜率 / 反查分差
expectedScore(1600, 1200);        // → 0.909
ratingGapFor(0.75);               // → 191（要让强手 75% 胜率，该差 191 分）
```

### K 值的三段设计

```typescript
const cfg = {
  baseK: 32,               // 常规
  provisionalGames: 10,    // 前 10 局算新手
  provisionalK: 64,        // 新手用高 K，快速靠近真实水平
  masterThreshold: 2400,   // 高分段
  masterK: 16,             // 高手分数更稳定
};
```

### 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| **没有分数地板** | 连输玩家掉到负数，要赢几十局才回得来 → 弃坑头号原因 | `ratingFloor`（默认 100） |
| **取整让低分段"冻住"** | 150 分的人每局变化 0.0008 分，取整后永远 0 → 玩家怎么打都不涨分 | `allowDecimal: true`，只在展示时取整 |
| **K 不同会破坏零和** | 新手 vs 老手，一方加的不等于另一方扣的 | 这是设计选择，但要知道自己在选 |
| **地板也破坏零和** | 被夹取后，总分凭空多出来 | 同上，接受它或用 `allowDecimal` |
| **多人局用 N-1 次 1v1 累加** | 幅度会是 1v1 的 7 倍 | 本库已除以 `N-1` 归一化 |

### 多人局为什么能保证零和

对任意一对 `(i, j)`：`S_ij + S_ji = 1`，且 `E_ij + E_ji = 1`。

```
Σ_i (S_i − E_i) = Σ_{i<j} [(S_ij + S_ji) − (E_ij + E_ji)] = 0
```

**前提是所有人 K 相同。** K 不同时零和必然被打破。

---

## 3. Glicko-2

### 三个量

| 量 | 含义 | 直觉 |
|---|---|---|
| **r** | rating 分数 | 水平估计值 |
| **RD** | Rating Deviation | 这个估计有多不确定，**越大越不确定** |
| **σ** | sigma | 发挥有多不稳定 |

### 五分钟上手

```typescript
import {
  createGlickoPlayer, ratePeriod, decayRd,
  conservativeRating, confidenceInterval, isSettled,
} from './elo/Glicko2';

const p = createGlickoPlayer();          // 1500 / RD 350 / σ 0.06

// 结算一个评分周期（results 为空 = 本期未参赛，只涨 RD）
const after = ratePeriod(p, [
  { opponent: createGlickoPlayer(1400, 30), score: 1 },
  { opponent: createGlickoPlayer(1550, 100), score: 0 },
  { opponent: createGlickoPlayer(1700, 300), score: 0 },
]);

conservativeRating(p);      // 匹配用这个，不是 rating
confidenceInterval(p);      // { low, high }，95%
isSettled(p);               // RD <= 80 即已定级
```

### ⚠️ 匹配必须用保守分，不能用真实分

```
新号：1500分，RD 350 → 保守分 800，真实水平可能在 800~2200
老号：1500分，RD  50 → 保守分 1400，真实水平可能在 1400~1600
```

两个都是 1500 分。如果直接用 1500 匹配：
- 新号真实水平若是 2000，他会在低段位一路屠杀

用保守分 `r − 2·RD` 匹配，新号先跟弱对手打，几局就把 RD 打下来了。
**这是解决"新号炸鱼"最有效的手段。**

### 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| **每局实时结算** | Glicko-2 要求按周期批量算，实时算会失真 | 按天/按周跑一次 `ratePeriod` |
| **τ 设太大** | 分数震荡，玩家觉得"系统乱给分" | 0.3~1.2，默认 0.5 |
| **用真实分去匹配** | 新号炸鱼 | 用 `conservativeRating` |
| **忘记处理未参赛** | 半年没上线的人分数还被当成可信 | 定期跑 `decayRd(p, periods)` |
| **波动率迭代写错** | 不报错，只是给分幅度不对 | 已用论文标准算例锁住 |

### 实现正确性：Glickman 论文标准算例

波动率的 Illinois 迭代**没有任何"看起来对"的直觉判断标准**——
写错一个符号，分数照样动，玩家只会觉得"给分有点怪"。

所以测试里固化了 Glickman 论文《Example of the Glicko-2 system》的原始算例：

```
输入：r=1500, RD=200, σ=0.06, τ=0.5
  对手 1400(RD=30) 胜、1550(RD=100) 负、1700(RD=300) 负
论文结果：r'=1464.06, RD'=151.52, σ'=0.05999
```

改任何一行迭代代码，这条测试都会告诉你对不对。

---

## 4. 共同的坑

**取整会悄悄破坏不变量。** 单局偏差 ≤1 分看起来无害，
但上千局后会累积出可观的分数漂移。

**建议**：内部一律 `allowDecimal: true`，只在展示时 `Math.round`。

---

## 4.5 API 目录

### ELO

| 函数 | 说明 |
|---|---|
| `rate1v1(a, b, result, cfg?)` | 1v1 结算 |
| `rateMultiplayer(players, ranks, cfg?)` | 多人结算，返回**新分数数组** |
| `rateMultiplayerDetailed(...)` | 多人结算的**明细**：`rating` / `delta` / `expected` / `actual` / `k` |
| `kFactor(player, cfg?)` | 当前玩家用的 K 值（新手/常规/高手三档） |
| `expectedScore(a, b)` / `ratingGapFor(winRate)` | 期望胜率 / 反查分差 |
| `averageRating(players)` | 组队平均分（**显示队伍实力**） |
| `describeMatchup(a, b)` | 从分数反推"大约能赢多少"的**直观描述**（调试 / UI 用） |

```typescript
// 结算面板："你 +18 分（预期 0.62，实际 1.0）"
const d = rateMultiplayerDetailed(players, ranks)[0];
```

> ⚠️ **`ranks` 从 0 开始，0 = 第一名**，并列填相同数字（`[0,0,2]` = 前两名并列）。
> 和"第 1 名"的直觉相反。

### Glicko-2

| 成员 | 说明 |
|---|---|
| `createGlickoPlayer(init?)` | 创建玩家 |
| `conservativeRating(p)` | **保守分**（匹配必须用这个，见 §2.3） |
| `ratingsOverlap(a, b)` | 两人的 95% 置信区间是否重叠 |
| `exportGlicko(p)` / `importGlicko(s)` | 存档 |
| `decayRdClosedForm(p, days)` | 未参赛衰减的**闭式解** |

> ⚠️ **本模块没有 `updateGlicko()` / `batchUpdate()`。**
> 早期文档列过这两个名字，但源码从未实现。
>
> 实际的更新入口按算法分在两个文件里，**名字都叫 `rateXxx`，不叫 update**：
>
> | 算法 | 文件 | 更新入口 |
> |---|---|---|
> | Elo | `Elo.ts` | `rate1v1(a, b, outcome, cfg?)` / `rateMultiplayer(players, ranks, cfg?)` |
> | Glicko-2 | `Glicko2.ts` | `ratePeriod(p, results, cfg?)` |
>
> **多人结算本身就是批量接口**（传数组），所以不需要单独的 `batchUpdate`。
> `rateMultiplayer` 接受的是 `ranks`（名次数组，不是胜负），
> 与 `rate1v1` 的 `outcome`（1 / 0.5 / 0）**参数含义不同**，别混用。

| `GLICKO_DEFAULT_RATING` / `GLICKO_DEFAULT_RD` / `GLICKO_DEFAULT_SIGMA` | 默认值常量（1500 / 350 / 0.06） |
| `GlickoSave` | 存档结构：`{ r, rd, sigma }` |

> **`decayRdClosedForm` 是 `decayRd` 的快进版。**
> 玩家离线 365 天时循环调用 365 次没必要，闭式解一步算出结果
> （`φ*_n² = φ² + n·σ²`）。两者结果**必须一致**，有测试锁住这一点。

```typescript
// 存档
const save = exportGlicko(p);        // { r, rd, sigma }
const back = importGlicko(save);     // 非法值回退默认，不抛错
```

> ⚠️ **`importGlicko` 静默容错，不抛错。**
> 手改存档（或旧版本存档）里的非法值会回退到默认值——
> 玩家不会进不去游戏，但**分数会莫名其妙变回 1500**。
> 排查"我明明打上去了怎么回去了"时看这里。

> **`ratingsOverlap` 与 `conservativeRating` 是两种不同的判据。**
> 前者问"两人的置信区间有没有交集"（基于 95% 区间），
> 后者给出"这个人至少有多少分"（默认 `rating - 2×RD`）。
> 做匹配窗口用前者，做保守分展示用后者。

## 5. 部署

```
复制 elo/ 整个目录到你的项目
依赖：'../_core/math'（clamp）
```

依赖图：第 1 层，只依赖 `_core`，零横向依赖。
