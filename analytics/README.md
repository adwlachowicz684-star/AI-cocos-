# analytics/ABTest · A/B 实验

> 改了算法，留存从 42% 变成 43.5%。这是真的提升了吗？

## 1. 五分钟上手

```typescript
import { Experiment, assign, checkBalance,
         requiredSampleSize, describeResult } from './analytics/ABTest';

// 开实验前：算清楚要跑多久
requiredSampleSize(0.1, 0.05);   // 基线 10%，检测 5% 提升 → 每组 57,760 人

// 分组（稳定，无需存数据库）
assign('user-123', { name: 'new-matchmaker' });   // → 'control' | 'treatment'

const e = new Experiment({ name: 'new-matchmaker' }, { minSamples: 1000 });
for (...) e.trackBinary(userId, converted);
console.log(describeResult(e.result()));
```

## 2. ⚠️ 不能预先指定谁在哪个组

```typescript
// ❌ 以为 c 开头就是对照组 —— 分组由哈希决定，跟命名无关
for (...) e.trackBinary(`c${i}`, ...);
for (...) e.trackBinary(`t${i}`, ...);

// ✅ 用 variantOf 查询，再按组给不同待遇
const variant = e.variantOf(id);
e.trackBinary(id, rnd() < (variant === 'control' ? 0.05 : 0.15));
```

错误写法下，两组转化率几乎相同，怎么设置参数都测不出差异。

## 3. ⚠️ bucketHash 必须有 finalizer

裸 FNV-1a 的雪崩性不足，输入只差几个字符时高位相关性很强：

```
无 finalizer：expA vs expB 重合率 35.6%   ← 期望 50%
              expA vs expC 重合率 24.0%
              expB vs expC 重合率 64.2%
有 finalizer：各对稳定在 49~51%
```

后果：**两个"互相独立"的实验分组高度重合**，
同一批用户在所有实验里都在实验组，行为被系统性改变。

这不是随机波动——样本从 1000 增到 20000，重合率稳定在 35%，
加大样本也救不回来。本库用 murmur3 fmix32 收尾解决。

## 4. 样本不足一律判"不显著"

```typescript
isSignificant(control, treatment, 0.05, 1000);
// 总样本 < 1000 → 直接 false，不看 p 值
```

10 个用户：A 组 1/5 转化，B 组 4/5 转化。
看起来是 20% vs 80% 的巨大差异，p 值可能很小，
但只有 5+5 个样本，完全可能是运气。

## 5. "不显著"不等于"没有提升"

这是 A/B 测试最常被误读的地方，所以 `describeResult()` 会显式写出来：

```
⚪ 不显著（p = 0.4899）：观测到 提升 4.4%
⚠️ 不显著不等于没有提升，只说明当前样本无法确认
```

## 6. 样本量的量级感

```
基线 10%，检测 50% 提升 → 每组     683 人
基线 10%，检测 20% 提升 → 每组   3,839 人
基线 10%，检测  5% 提升 → 每组  57,760 人
```

检测微弱效应需要的样本量，是检测显著效应的约 100 倍。
**开实验前算清楚，才知道这个实验值不值得开。**

---

## 7. API 目录

### 分组

| 函数 | 说明 |
|---|---|
| `bucketHash(s)` | 哈希（带 finalizer，见第 3 节） |
| `bucketOf(id, salt)` | 分桶到 **0~99** |
| `assign(id, cfg)` | 分配 `'control'` / `'treatment'` |
| `checkBalance(...)` | 分组均衡性检查 |

> **`bucketOf` 返回 0~99 的整数**，不是 0~1 的比例。
> 想取"前 10% 进实验组"，判断是 `bucketOf(id, salt) < 10`。

### 统计

| 函数 | 说明 |
|---|---|
| `emptyStats()` | 空统计对象 |
| `recordBinary(s, converted)` | 记一次**二值**结果（转化 / 未转化） |
| `recordValue(s, value)` | 记一次**数值**结果（时长、金额） |
| `conversionRate(s)` | 转化率 |
| `mean(s)` / `variance(s)` | 均值 / **样本方差（除以 n−1）** |
| `normalCdf(z)` | 正态 CDF |
| `twoProportionZTest(c, t)` | 双比例 Z 检验 |
| `isSignificant(...)` | 是否显著 |
| `requiredSampleSize(baseline, lift)` | 需要的样本量 |

> ⚠️ **`Stats` 是只读的——`record*` 返回新对象，不改原来的。**
> 写成 `recordBinary(stats, true)` 而不接返回值，数据就丢了。

> ⚠️ **`conversionRate` 和 `mean` 在 `n === 0` 时返回 `0`，不抛错。**
> 空统计对象直接读会拿到 0 而不是 `NaN`——
> 好处是不会污染后续计算，坏处是"没数据"和"转化率真的是 0"**看起来一样**。
> 展示前先判 `s.n > 0`。

### 类型

`ExperimentConfig` / `Variant` / `Stats` / `ZTestResult` / `ExperimentResult` / `BalanceReport`

### `Experiment` 类（**有状态的实验对象**）

顶层函数是纯函数；`Experiment` 把"分组 + 记录 + 检验"串起来。

| 成员 | 说明 |
|---|---|
| `new Experiment(cfg, opts?)` | 构造。**`cfg.name` 为空会抛错** |
| `variantOf(userId)` | 分组查询（**幂等**） |
| `trackBinary(userId, converted)` | 记二值结果 |
| `trackValue(userId, value)` | 记数值结果 |
| `result()` | 出结论（`ExperimentResult`） |
| `reset()` | 清空参与记录 |
| `name` / `size` | 实验名 / **去重后**的参与人数 |

> ⚠️ **同一用户只计一次，这是刻意的去重语义：**
> - **二值**指标取"是否曾经转化"（OR）
> - **数值**指标取**首次**上报值
>
> 不这样做的话，玩家反复触发事件就能刷数据。
> 但副作用是：`trackValue` 第二次调用**不生效**——
> 想更新数值只能 `reset()` 或换 userId。

> ⚠️ **`size` 是去重后的人数，不是事件数。**
> 一个玩家触发 10 次事件，`size` 仍是 1。

**`ExperimentOptions`**：

| 字段 | 默认 | 说明 |
|---|---|---|
| `minSamples` | 1000 | 最小总样本量，**不足一律判"不显著"** |
| `alpha` | 0.05 | 显著性水平 |

> 第 5 节的"不显著 ≠ 没有提升"说的就是 `minSamples` 这道闸：
> 样本不足时返回不显著，是在**保护你别过早下结论**。

### `describeResult(r)`

把结果写成人类可读的结论。

> **A/B 测试最大的风险不是算错，是读错。**
> `p = 0.08` 被读成"没有提升"，然后一个真的有用的改动被砍掉。
> 用 `describeResult` 拿现成结论，别自己对着 p 值猜。

> **本目录同时是 `analytics` 和 `ABTest` 两个单元。**
> 轮子清单里登记为 `analytics`（含 `ABTest.ts`），
> 从 `abtest` 合并过来后保留了这个文件名，
> 所以 `import { ... } from '../analytics/ABTest'` 的路径里带 `ABTest`。
