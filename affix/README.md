# affix — AffixSystem（词条系统）

## 它解决什么

装备上的随机属性：

```
锈蚀长剑
  +15 攻击力
  +8% 暴击率
  击中时 20% 概率流血
```

词条是 ARPG / 肉鸽构筑深度的核心来源——
同一把剑，roll 出不同词条就是完全不同的 build。

本模块负责：**Roll、冲突控制、槽位限制、聚合、配置校验**。

## 零业务依赖

它不认识"攻击力""暴击率"。
`stat` 是开放字符串，`slots` 也是开放字符串。
具体含义由业务解释。

## 用法

```typescript
import { AffixSystem, validateAffixPool } from './affix/AffixSystem';

const DEFS: AffixDef[] = [
  { id: 'atk_c', stat: 'atk', op: 'add', min: 3, max: 8,  rarity: 'common', group: 'atk', slots: ['weapon'] },
  { id: 'atk_r', stat: 'atk', op: 'add', min: 8, max: 16, rarity: 'rare',   group: 'atk', slots: ['weapon'] },
  { id: 'crit_c', stat: 'crit', op: 'add', min: 0.02, max: 0.06, rarity: 'common', group: 'crit', precision: 3, percent: true },
  { id: 'dmg_r', stat: 'dmgMul', op: 'mul', min: 0.06, max: 0.14, rarity: 'rare', group: 'dmg', precision: 3, percent: true, slots: ['weapon', 'ring'] },
];

// 启动时校验一次（发现问题比游戏上线后好）
const v = validateAffixPool(DEFS, undefined, { maxAffixes: 4, slots: ['weapon', 'ring'] });
if (!v.ok) throw new Error(v.errors.join('; '));
console.warn(v.warnings);

const sys = new AffixSystem({ defs: DEFS, rng, maxAffixes: 4 });

// roll 一件武器
const rolled = sys.roll('weapon', 4);
for (const a of rolled) console.log(sys.describe(a));

// 聚合后套到基础值上
const finalAtk = sys.compute(rolled, 'atk', 20);
```

## slots 的语义（容易搞错）

| 写法 | 含义 |
|---|---|
| `slots: ['weapon']` | 只能在 weapon 槽位出现 |
| **不写 slots** | **通用词条，任何槽位都能出** |

第二条的后果：给 `boots` 槽位 roll 时，
那些没写 `slots` 的通用词条（暴击、生命）也会出现。
所以"boots 只有 2 个专属词条"不等于"只能 roll 出 2 条"。

## 两个必须配的字段

### group（冲突组）

没有冲突组，一件装备可能 roll 出
"+8% 暴击率" 和 "+12% 暴击率"，
玩家会觉得"这是在占词条位"——
明明 4 个词条位，实际只有 3 条有效属性。

同组词条在一件装备里最多出现一个。

### precision（小数位）

**百分比类词条（暴击率、吸血）必须设 1~3 位小数。**
取整的话 "+8% 暴击率" 和 "+12%" 之间只有 5 个可能值，
构筑深度直接消失。

`validateAffixPool` 会对"标记了 percent 但 precision=0"发警告。

## 稀有度：权重 + 倍率

```typescript
const DefaultRarities = [
  { id: 'common',    weight: 100, valueScale: 1.0,  tier: 0 },
  { id: 'rare',      weight: 30,  valueScale: 1.25, tier: 1 },
  { id: 'epic',      weight: 8,   valueScale: 1.5,  tier: 2 },
  { id: 'legendary', weight: 2,   valueScale: 1.8,  tier: 3 },
];
```

- **weight** 决定"抽到什么品质"
- **valueScale** 决定"数值放大多少"

有了 valueScale，同一个词条定义（min=5, max=10）在 legendary 版本会变成 7.5~15，
**不需要为每个稀有度重复配一遍词条表**。

## ⚠️ 曾经的 bug：四舍五入让值超出上界

```
min=0.05, max=0.15, rarity=rare(valueScale=1.25), precision=2
→ 原始范围 [0.0625, 0.1875]
→ 最大可能值 0.1875，四舍五入到 2 位 = 0.19
→ 0.19 > 0.1875  ← 超出上界
```

单看这条几乎无害（多了 0.0025），
但它让"数值范围"这条契约失效——
平衡计算、配置校验、UI 显示"最大值"全部对不上。

**解法**：先把边界按同一精度**向内**对齐再随机
（`lo` 向上取整、`hi` 向下取整），
这样 `lo`/`hi` 本身已满足精度，随机值取整后不会越界。

## ⚠️ 曾经的 bug：已用记录从未更新

第一版在 `roll()` 里创建了 `usedDefs` / `usedGroups`，
却**从来没有往里面 add**。

三条症状同时出现，且都不报错：
- 同一件装备 roll 出两条 `crit2`——`allowDuplicate: false` 形同虚设
- 同组的两条词条（两个暴击率）同时出现
- 池子"永远抽不干"，因为每次都在全池里选

这类 bug 靠读代码很难发现（变量声明了、也传进去了），
只有断言"同组不共存"才能逼出来。

## 池子抽干时不会死循环

`fallbackOnEmpty`（默认 true）会在目标稀有度的池子空了时，
降级为"不限稀有度"再试。
真的没有了就停——**宁可少一条词条，也不要死循环**。

有 `maxTries = want * 20` 双重保护。

## 聚合公式

```
final = (base + Σadd) × (1 + Σmul)
```

**和 `attribute`、`meta` 两个插件完全一致。**
`mul` 是**相加不是连乘**：两条 +20% 伤害 = +40%，不是 +44%。

三处公式必须统一，否则玩家会发现"面板和实际对不上"。

## 重铸

```typescript
// 保持稀有度，只重摇数值（默认）
sys.reroll(affix);

// 赌一把：可能换到更好或更差的词条
sys.reroll(affix, 'weapon', { keepRarity: false });

// 整件重铸
const out = sys.rerollAll(weapon, 'weapon');
if (sys.lastRerollDegraded) showConfirm('品质下降，保留吗？');
```

**不做"保证不变差"的保底**——
那样玩家会无脑洗到满意为止，重铸货币失去意义。
只把信息暴露出去（`lastRerollDegraded`），让玩家自己选。

## 配置校验 validateAffixPool

在**启动时**跑一次。配置错误在游戏里表现为
"玩家拿到垃圾装备但看不出为什么"，**而且不会报错**——数值只是不太好。

| 检查 | 表现 |
|---|---|
| 稀有词条上限 < 普通词条下限 | 玩家拿到橙装，属性不如蓝装 |
| 某槽位可选词条 < maxAffixes | 该槽位永远凑不满词条 |
| 所有稀有度权重为 0 | 永远只出 common |
| 标记 percent 但 precision=0 | 可选值太少 |
| 冲突组只有 1 个成员 | 限制形同虚设（可能是笔误） |

前两条是 `warning` 不是 `error`——有时是刻意设计。

## API 补充

| 成员 | 说明 |
|---|---|
| `defCount` | 已注册的词缀定义数 |
| `aggregate(affixes)` | 把一组词缀的效果**聚合成** `Map<属性, 数值>` |

```typescript
// 装备面板："这把武器总共 +了多少攻击"
const totals = AffixSystem.aggregate(sword.affixes);
```

> **它是实例方法**（`sys.aggregate(...)`），不是静态的。
> 但它**不改任何状态**——传进来的词缀算完就返回，
> 所以可以安全地用它预览"还没装上的装备"。
>
> （上一版这里写成了"静态方法，不用先有实例"，是错的。
> 直接 `AffixSystem.aggregate(...)` 会报"不是函数"。）

## 测试

55 项。重点覆盖：
- 冲突组同组不共存（100 种子）
- 不出现重复词条（100 种子）
- 数值不超出范围（200 种子）
- precision 生效（50 种子）
- 池子抽干不死循环、完全为空返回空数组
- **1000 次 roll 全部合法**

文件：`AffixSystem.ts`
