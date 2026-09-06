# meta — MetaProgression（元进度 / 局外成长）

## 它解决什么

肉鸽的核心循环：

```
打一局 → 死了 → 用积累的资源解锁永久能力 → 下一局更强 → 打得更远
```

这个"死了也在变强"的机制，就是**元进度**。
它让失败不再是纯粹的挫败，而是进度的一部分——
这是肉鸽能让人连打几十小时的关键。

典型实现（《哈迪斯》）：
- 局内收集"黑暗" → 局外升级武器天赋
- 局内收集"宝石" → 局外装修主城（解锁新功能）
- 送"蜜露"给 NPC → 解锁剧情与遗物

## 零业务依赖

它不认识"灵魂""黑暗""金币"。
货币是开放字符串 id，效果作用对象（`stat`）也是开放字符串。
具体"+1 最大血量"是什么意思，由业务解释。

本模块只做三件事：**记账、聚合、存档**。
存档只产生纯数据，不依赖 save 插件。

## 用法

```typescript
import { MetaProgression } from './meta/MetaProgression';

const meta = new MetaProgression({
  nodes: [
    { id: 'vitality', maxLevel: 5, cost: [20, 45, 100, 220, 480],
      effects: [{ stat: 'maxHp', op: 'add', value: 8 }] },
    { id: 'purse', maxLevel: 3, cost: [40, 90, 200],
      effects: [{ stat: 'goldGain', op: 'mul', value: 0.15 }] },
    { id: 'shop', maxLevel: 1, cost: [150],
      effects: [{ stat: 'unlockShop', op: 'flag', value: 1 }] },
    { id: 'reroll', maxLevel: 1, cost: [300], requires: ['shop'],
      effects: [{ stat: 'unlockReroll', op: 'flag', value: 1 }] },
  ],
  currencies: ['soul'],
});

// 一局结束
meta.addCurrency(320);

// 解锁
const lv = meta.unlock('vitality');   // 返回新等级，失败返回 -1

// 应用到数值（业务自己解释 stat 的含义）
const maxHp = meta.compute('maxHp', 100);      // (100 + Σadd) × (1 + Σmul)
const hasShop = meta.hasFlag('unlockShop');

// 存档
const snap = meta.snapshot();       // 纯数据，可直接 JSON.stringify
meta.restore(snap);
```

## 四种效果运算

| op | 聚合方式 | 用途 |
|---|---|---|
| `add` | `Σ value × level` | +8 最大血量 |
| `mul` | `Σ value × level`（**相加不是连乘**） | +15% 金币获取 |
| `set` | 多个取**最大** | 覆盖某属性 |
| `flag` | 布尔开关 | 解锁商店、解锁重铸 |

```
final = (base + Σadd) × (1 + Σmul)
```

**这个公式和 `attribute`、`affix` 两个插件完全一致。**
三处用同一套公式——如果这里连乘、那里相加，
玩家会发现"面板显示和实际伤害对不上"，
这类 bug 极难排查，因为每一处单独看都是对的。

## ⚠️ 货币的两个坑

### 1. 单货币时可省略，多货币时必须显式指定

```typescript
// 单货币：节点不写 currency 就用它
new MetaProgression({ nodes: [{ id: 'a', cost: [10] }], currencies: ['soul'] });
meta.addCurrency(100);        // 可省略货币名
meta.currency();              // 可省略

// 多货币：不写 currency 是歧义 → 构造时立即抛错
new MetaProgression({ nodes: [{ id: 'a', cost: [10] }], currencies: ['soul', 'gem'] });
// Error: 节点 "a" 使用了未注册的货币 "default"
```

曾经的 bug：构造时注册 `currencies: ['soul']`，
节点没写 `currency`（默认 `'default'`），
而 `currency()` 对未知货币**静默返回 0**。
症状是玩家攒了 320 灵魂，点一个 20 灵魂的升级提示"货币不足"——
没有任何报错，查起来极其费劲。

所以现在构造时立即校验。

### 2. cost 数组越界时用最后一项，不是 0

`costAt([10, 20], 5)` 返回 `20` 而不是 `0`。
返回 0 意味着"免费"，会让所有后续升级白送。

## 成本曲线

默认 `100 × 1.5^level`：

```
100, 150, 225, 337, 506, 759, ...
```

**为什么默认用指数**：线性成本（100, 200, 300）在后期会变得"太便宜"——
玩家资源产出随熟练度增长，但成本不增长，
结果一周到头全解锁，游戏失去长期目标。

| growth | 适用 |
|---|---|
| 1.3 | 温和，20~40 小时的游戏 |
| **1.5**（默认） | 标准 |
| 1.8 | 陡峭，终极解锁非常稀有 |

## 循环依赖：构造时检测

A 需要 B、B 需要 A → 两个都永远解锁不了。
构造时做 DFS 检测，发现环直接抛错并打印环路径。

**现在抛错，好过上线后玩家发现"这个永远解锁不了"。**

未知前置（配置笔误）则**忽略**而不是阻塞——
一个笔误不该让整个游戏起不来。

## 存档容错：旧存档 ≠ 崩溃

更新游戏后经常发生：
1. 删掉某个节点 → 存档里还有它的 id
2. 新增节点 → 存档里没有
3. 节点被削弱（maxLevel 从 5 降到 3）→ 存档等级超限

严格模式会抛错、玩家进不去游戏、差评。所以：

| 情况 | 处理 |
|---|---|
| 未知节点 id | 静默跳过，记在 `skipped` |
| 未知货币 | 静默跳过，记在 `skipped` |
| 等级超限 | clamp 到当前上限，记在 `clamped` |
| 等级为负 | 归零 |
| 版本不一致 | 置 `versionMismatch`（不阻断） |

`restore()` 返回报告供日志用：

```typescript
const report = meta.restore(oldSave);
if (report.skipped.length > 0) console.warn('存档里有已删除的内容：', report.skipped);
if (report.clamped.length > 0) console.warn('等级被下调：', report.clamped);
```

## 洗点 respec

```typescript
meta.respec(1.0);    // 全额退款
meta.respec(0.75);   // 75% 退款（推荐）
```

全额退款会让玩家随意反复洗点试错。
0.7~0.8 是常见折中：**允许改错，但改错有代价**。

## API 补充

### 查询（技能树 UI）

| 成员 | 说明 |
|---|---|
| `allNodes()` | 全部节点 |
| `nodeCount` | 节点总数 |
| `isUnlocked(nodeId)` | 是否已解锁 |
| `nextCost(nodeId)` | 下一级的价格，**满级返回 `null`** |
| `canUnlock(nodeId)` | 能否解锁（含原因） |
| `effectOf(stat)` | 某属性的**聚合后**加成 |
| `topoOrder()` | 拓扑序（**按依赖顺序遍历**） |
| `describe()` | 诊断输出，**返回字符串数组**（每行一条） |

> ⚠️ **`nextCost` 满级时返回 `null`，不是 0。**
> `if (cost)` 会把 0 元（免费升级）也当成满级；
> 反过来，把 `null` 当数字用会得到 `NaN`——
> UI 上显示"升级需要 NaN 点"。
> 判满级用 `cost === null`。

```typescript
const cost = meta.nextCost(id);
btn.disabled = cost === null || !meta.canUnlock(id).ok;
btn.label = cost === null ? '已满级' : `${cost} 点`;
```

> **`effectOf` 返回的是聚合结果**（所有已解锁节点对该属性的加成之和）。
> 想知道"某个节点单独给多少"要自己算——
> 聚合值随解锁进度变化，不适合做"这个节点值不值"的对比。

### 手动操作

| 成员 | 说明 |
|---|---|
| `setLevel(nodeId, level)` | 直接设等级（**调试 / GM 指令用**） |
| `resetCurrency()` | 货币清零 |

### `defaultCostCurve(base?, growth?)`（可单独用）

默认的价格曲线：`100 × 1.5^level`。

```typescript
cost: defaultCostCurve(50, 1.3);   // 50 起，每级 ×1.3
```

不传 `cost` 就等于 `defaultCostCurve()`（100 起，×1.5）。
自己写价格表时用它当基线，再按需调整。

> ⚠️ **`setLevel` 会**绕过依赖检查**——
> 可以把还没解锁前置的节点直接拉满。
> 它是给调试和 GM 指令用的，**正常升级走 `unlock()`**。
> 误用会导致玩家在没解锁前置的情况下获得高级加成。

## 测试

45 项。重点覆盖：
- 循环依赖构造时抛错（含自引用）
- 多货币独立结算、单货币省略
- 旧存档含已删除节点 / 超限等级 / 未知货币时不崩溃
- snapshot / restore 往返一致
- 拓扑排序（UI 按依赖顺序展示）

文件：`MetaProgression.ts`

---

## 返回值结构

### `AggregatedEffect`

```typescript
interface AggregatedEffect {
  add:  number;              // 加法叠加总量
  mul:  number;              // 乘法叠加总量
  set:  number | undefined;  // 是否有人"直接设置"
  flag: boolean;             // 是否有标记类效果
}
```

> ⚠️ **`set` 是 `undefined` 而不是 0。**
> 有 `set` 时它**覆盖** `add` 和 `mul`；
> 没有时是 `undefined`。
> 判 `if (agg.set)` 的话，想设成 0 的情况会失效。

### `MetaSnapshot`

```typescript
interface MetaSnapshot {
  version:  number;
  currency: Record<string, number>;   // 元货币
  levels:   Record<string, number>;   // 各节点等级
}
```

> **`version` 是存档版本，用于迁移。**
> 读档时先比对，别直接 `Restore`——
> 老存档缺字段会静默用默认值，表现为"升级全没了"。