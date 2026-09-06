# gacha — 抽卡与保底

## 它解决什么

抽卡是很多游戏的核心商业模式，也是**口碑雷区**。
保底系统在「随机性」和「玩家不会永远抽不到」之间取平衡。

## ⚠️ 和 loot/PRD 的区别

这两个容易被混为一谈，但语义完全不同：

| | loot / PRD | gacha |
|---|---|---|
| 计数维度 | **每次 roll 独立** | **跨抽累计** |
| 语义 | 连续 N 次没出，第 N+1 次概率飙升 | 抽满 N 次必定出 |
| 重置时机 | 每次判定后立即重置 | 出货后才重置 |
| 玩家感知 | 无感（平滑） | 强烈（「还差 10 抽保底」） |
| 典型用途 | 掉落、暴击 | 抽卡、招募 |

用错的表现：拿 PRD 做抽卡，玩家会觉得「这游戏根本没保底」；
拿保底做掉落，玩家会觉得「掉率忽高忽低」。

## 零业务依赖

它不认识「五星角色」「武器」。
只有**稀有度 id**（开放字符串）和 `baseRate`。

## 用法

```typescript
import { GachaPity, simulate } from './gacha/GachaPity';
import { RNG } from './rng/RNG';

const g = new GachaPity({
  items: [
    { id: '限定角色', rarity: 'r5', weight: 1, limited: true },
    { id: '常驻角色', rarity: 'r5', weight: 1 },
    { id: '四星武器', rarity: 'r4', weight: 1 },
    { id: '三星武器', rarity: 'r3', weight: 1 },
  ],
  rarities: [
    { id: 'r5', baseRate: 0.006, softPity: 74, hardPity: 90, rampPerPull: 0.06, tier: 2 },
    { id: 'r4', baseRate: 0.051, hardPity: 10, tier: 1 },
    { id: 'r3', baseRate: 0.943, tier: 0 },
  ],
  rng: new RNG(seed),
  tenPullGuarantee: 'r4',   // 十连必出四星及以上
  fiftyFifty: true,         // 50/50 机制
});

const r = g.pull();
// r.item / r.rarity / r.pityCount / r.fromHardPity / r.fromSoftPity / r.wonFiftyFifty

g.pityCount('r5');      // 已累计多少抽
g.toHardPity('r5');     // 距保底还差几抽（无硬保底返回 null）
g.currentRate('r5');    // 当前实际概率（含软保底加成）
```

### 存档

```typescript
const snap = g.snapshot();    // { pity, guaranteedLimited, totalPulls, ... }
g.restore(snap);              // restore(null) 是安全的
```

### 批量模拟（配平用）

```typescript
const report = simulate(opts, 100000);
// report.rates['r5']     实际出货率
// report.avgPity['r5']   平均出货抽数
// report.worstDry['r5']  最长连续未出货
```

## 关键设计

### 软保底

从第 74 抽开始概率线性上升，到第 90 抽达到 100%。

好处：玩家感觉「运气好提前出了」，
而不是「每次都是第 90 抽才出」——后者的保底感太生硬。

### 出货后「及以下」全部清零

出五星时，四星计数也要清零——
因为四星计数统计的是「距上次出四星及以上」。

### 50/50

出金时有 50% 是限定角色。这次歪了（拿到常驻）的话，
**下次出金必定是限定**——保证玩家最多歪一次。

## 坑

### ⚠️ 差一错误：硬保底在第 89 抽就触发

`_doPull()` 在判定**之前**已经把计数推进过了（第 N 抽时 `pityCount === N`），
而 `_rateFor()` 里若写成 `n + 1 >= hardPity`，
硬保底就会在**第 89 抽**触发，而不是承诺的第 90 抽。

有多隐蔽：

- 不报错、不崩溃
- 玩家几乎察觉不到（只差一抽）
- 但「抽满 90 必出」是写进规则的**承诺**，
  玩家数着抽数对照时会发现对不上 → 信任受损

**判据**：`pityCount` 的语义是「这是第几抽（含本次）」，
所以直接和 `hardPity` 比较，不再 +1。

### 干涸统计口径必须和保底语义一致

`worstDry[r]` 的正确语义是「连续多少抽没拿到 **r 及以上**」。
若写成「除了出货的那个稀有度，其余全部 +1」，
那么在「第 50 抽出了五星」时四星的 dry 会继续累加，
报出 `worstDry['r4'] = 23` 这种数字——
看起来像保底失效，但保底其实是好的。

玩家视角：抽到五星当然算「出货」，
不会有人抱怨「我 23 抽没出四星」（他明明出了更好的）。

### `baseRate` 是概率不是权重

`0.006` = 0.6%，不是「6 份」。
所有稀有度的 baseRate 之和建议为 1。

## API 补充

| 成员 | 说明 |
|---|---|
| `pullTen()` | 十连（**内部会走保底逻辑**，别自己循环 `pull()`） |
| `pullN(n)` | 任意次数连抽 |
| `reset()` | 清空保底计数（**换卡池时必须调**） |

> ⚠️ **十连用 `pullTen()`，不要写 `for (let i=0;i<10;i++) pull()`。**
> 两者结果可能不同——十连通常有"保底至少一张 SR"这类规则，
> 而单抽循环走的是单抽的保底。玩家会觉得"十连没保底"。

### 存档：`GachaSnapshot`

```typescript
snapshot(): GachaSnapshot    // 导出
restore(s: GachaSnapshot)    // 导入
```

```typescript
interface GachaSnapshot {
  pity:                    Record<string, number>;  // 每种稀有度的当前保底计数
  sinceTenPullGuarantee:   number;                  // 距上次十连保底过了多少抽
  guaranteedLimited:       boolean;                 // 下次是否必出限定
  totalPulls:              number;                  // 累计抽数
}
```

> ⚠️ **`pity` 是"每种稀有度各自一个计数"，不是单一数字。**
> 常见的设计是 SR 和 SSR 各有独立保底（10 抽 / 90 抽），
> 所以这里用 `Record<稀有度, 计数>`。
> 只存一个 `pity` 数字的话，多档保底会互相干扰。

> ⚠️ **换卡池必须 `reset()`，不能只 `restore()`。**
> 两个卡池的保底计数是独立的，
> 把 A 池的存档导进 B 池会让玩家"继承"了不该有的保底进度——
> 白嫖或吃亏都有可能，两边都会投诉。
