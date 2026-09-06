# anticheat/AntiCheat · 基础反作弊

> 这一层做的**不是**反外挂（那是驱动级对抗），而是"数据明显不合理"的检测。

## 1. 五分钟上手

```typescript
import { SpeedChecker, binomialZ, isStatisticalOutlier,
         intervalRegularity, looksLikeScript, suspicionScore } from './anticheat/AntiCheat';

// ① 速度
const c = new SpeedChecker({ maxSpeed: 10, tolerance: 1.15, strikeThreshold: 3 });
c.push({ x: 0, y: 0, t: 0 });
c.push({ x: 100, y: 0, t: 1000 });   // → { speed: 100, flagged: false, strikes: 1 }

// ② 统计离群
binomialZ(80, 100, 0.3);                    // → 10.9
isStatisticalOutlier(80, 100, 0.3, 100);    // → false（样本不足 100）

// ③ 行为指纹
intervalRegularity([200, 200, 200]);        // → 0（完美精确 = 脚本）

// 综合
suspicionScore({ speedViolations: 10, accuracyZ: 6 });
// → { score: 70, action: 'review', breakdown: {...} }
```

## 2. 三条原则

### 原则一：宁可漏过，不可误判

误判一个正常玩家的代价远大于放过一个作弊者。
被误封的玩家会永远流失，还会在社区里说你游戏烂。
所以阈值留大幅余量，且要求**连续多次**触发。

### 原则二：小样本一律不定罪

10 发子弹全中，Z 分数高得离谱——但那完全可能是运气。
所有统计类检测都有**样本量门槛**，不够就不判。

`intervalRegularity` 样本不足时返回 **1**（很不规律）而非 0（完美规律）：
返回 0 会被解读成"像脚本"，新玩家直接被定罪。

### 原则三：只输出可疑度，不做处罚

是否封号由人工或上层策略决定。
把判定和处罚写在一起，会让你不敢调阈值。

## 3. ⚠️ 单项证据不足以封号

```
封禁阈值  85
速度上限  40  ← 光靠速度永远封不掉
命中率上限 30
指纹上限  25
举报上限  15
新号        5
```

要求多证据交叉，误判率会下降一个数量级。
任何单一检测器都可能被特殊情况触发（服务器回滚、网络重传、某个技能机制）。

## 4. ⚠️ accuracyZ 为负不产生贡献

低于平均水平是正常的，不能变成负分抵消其他证据——
那等于奖励菜鸡作弊。

## 5. 动作建议

| 分数 | 动作 | 含义 |
|---|---|---|
| 0–29 | none | 不处理 |
| 30–59 | watch | 仅记录，提高采样频率 |
| 60–84 | review | 进人工复核队列 |
| 85+ | ban | 建议封禁 |

`actionFor(score)` 就是这个映射的函数形式。

> **阈值为什么这么高**：这是"宁可漏过，不可误判"原则的直接体现。
> 宁可让 10 个作弊者多玩几天，也不能封错 1 个正常玩家。

---

## 6. API

### 顶层函数

| 函数 | 说明 |
|---|---|
| `actionFor(score)` | 分数 → 建议动作 |
| `normalizeScore(...)` | 归一化到 **0~1**（与 `clamp01` 同义，此处为语义清晰） |
| `binomialZ(k, n, p)` | 命中率的 Z 分数（**原则二要用**） |
| `isStatisticalOutlier(...)` | 是否统计离群 |
| `intervalRegularity(intervals)` | 点击间隔规律性（**脚本特征**） |
| `looksLikeScript(...)` | 是否像脚本 |

### 类型

| 类型 | 字段 |
|---|---|
| `SpeedSample` | `x` / `y` / `t`（毫秒） |
| `SpeedViolation` | `speed` / `allowed` / `exceeded` / `flagged` / 连续异常次数 |
| `CheatEvidence` | `speedViolations?` / `accuracyZ?` / `intervalCv?` / `reportScore?` |
| `SuspicionBreakdown` | `speed` / `accuracy` / `interval` / `report` / `account` |

> ⚠️ **`CheatEvidence` 的字段全是可选的。**
> 只传有的那几项证据——缺失的项**不参与加权**，
> 而不是当作 0 分。这跟原则三一致：**没有证据 ≠ 证据表明清白**。

### `SpeedChecker`（有状态）

**`SpeedCheckerConfig`**：

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxSpeed` | 必填 | 合法最大速度（单位/秒） |
| `tolerance` | 1.15 | 容忍系数 |
| `minDistance` | 0 | 最小位移 |
| `strikeThreshold` | 3 | 连续异常几次才算 `flagged` |

> ⚠️ **`tolerance` 默认留 15% 余量，别改成 1.0。**
> 网络抖动、客户端预测、插值误差都会让实测值偏高，
> 系数设 1.0 的话正常玩家会被大量误判。

> ⚠️ **`minDistance` 默认 0，建议设成 0.5 左右。**
> 位移极小时，时间测量的相对误差会被放大成**巨大的速度**——
> 表现为"站着不动被判定瞬移"。设个下限能滤掉这类噪声。



| 成员 | 说明 |
|---|---|
| `push(sample)` | 上报一次位置，返回 `SpeedViolation` 或 `null` |
| `strikes` | 当前连续异常次数 |
| `maxObserved` | **观测到的最大速度**（调阈值用） |
| `reset()` | 重置 |

> ⚠️ **`push` 在首次调用和样本无效时返回 `null`。**
> 第一个样本没有"上一个点"可比，算不出速度。
> 忘了判空的话 `violation.exceeded` 会抛 TypeError。

> **`maxObserved` 是拿来调阈值的。**
> 上线后先看一段真实数据：如果正常玩家的 `maxObserved` 就接近上限，
> 说明阈值设太紧了，会误判。**先观测再定罪。**

### `SuspicionResult`

| 字段 | 说明 |
|---|---|
| `score` | 可疑度总分 0~100 |
| `action` | `'none'` / `'watch'` / `'review'` / `'ban'` |
| `breakdown` | 各项得分（`SuspicionBreakdown`） |

> **各项有上限**（速度 40 / 命中 30 / 间隔 25 …），
> 防止单一证据直接定罪。这是原则三的落地：
> 哪怕某一项爆表，也只贡献它那部分权重。

> **`SpeedViolation.exceeded` 与 `flagged` 是两回事：**
> `exceeded` 是单次超速，`flagged` 是**连续异常达到阈值**。
> 定罪的依据应该是 `flagged`——单次超速完全可能是网络抖动。
