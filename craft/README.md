# craft — 合成 / 打造系统

## 头号事故：材料凭空消失

扣了材料 → 发现背包满 → 产出失败 → **材料已经没了**。
玩家会认为你在偷他东西。这是所有合成系统的头号事故。

本实现用固定的五步顺序杜绝它：

```
1. 检查材料（不扣）
2. 决定产出（可能在品质表里 roll）
3. 先尝试产出 ← 关键
4. 产出成功 → 扣材料
5. 产出失败 → 把刚加进去的拿回来，材料分毫未动
```

## 用法

```typescript
const craft = new CraftSystem(new RNG(1));   // rng 用于品质 roll

craft.define({
  id: 'iron_ingot', name: '铁锭',
  inputs: [{ itemId: 'iron_ore', count: 2 }],
  output: { itemId: 'iron_ingot', count: 1 },
});

craft.define({
  id: 'iron_sword', name: '铁剑',
  inputs: [
    { itemId: 'iron_ingot', count: 3 },
    { itemId: 'wood', count: 1 },
  ],
  output: { itemId: 'iron_sword', count: 1 },
});

craft.canCraft('iron_sword', inv);
// { ok: false, missing: [{itemId:'iron_ingot', need:3, have:1}], maxCount: 0 }

craft.craft('iron_sword', inv);     // 原子操作

craft.findCraftable(inv);           // 反向查询：现在能做什么
craft.totalMaterials('iron_sword'); // { iron_ore: 6, wood: 1 }（展开嵌套）
```

**背包通过 `IInventory` 接口接入**（只需 `count` / `remove` / `add` 三个方法），
所以不绑死任何具体背包实现。

## 嵌套合成树

```
铁剑 = 3 铁锭 + 1 木头
铁锭 = 2 矿石
────────────────────
铁剑 = 6 矿石 + 1 木头    ← totalMaterials 的结果
```

传 `inv` 进去会**抵扣已有的中间产物**：
已有 1 个铁锭 → 只报 4 个矿石。

合成树里有环（A 需要 B，B 需要 A）不会栈溢出——
用 visiting 集合检测，发现环就当原始材料。

> ⚠️ **子配方的产率要换算成"做几次"**
> 递归时不能把"需要 8 个板"当成"要做 8 次板配方"——
> 板配方一次产出 4 个时，正确算法是 `ceil(8 / 4) = 2 次`。
> 老实现直接递归，需求被高估整整一个产率倍数
> （实测 `plank: 2木→4板` + `house: 8板` 得到 `{wood:16}`，实际只需 4）。
> 有 `variants` 时产率不定，这里取**最小产率**，保证"照清单备料一定够"。

## 其他能力

| 能力 | 字段 |
|---|---|
| 品质随机 | `output.variants: [{itemId, weight, count?}]` |
| 副产物 | `byproducts: [{itemId, count, chance?}]` |
| 不消耗的材料（铁砧） | `inputs[].consume: false` |
| 图纸解锁 | `requiresUnlock: true` + `unlock(id)` |
| 工作台分类 | `station: 'forge'` |

> 无 rng 时 `_pickVariant` 取**第一个**变体（不是权重最大的），保证确定性。

> ⚠️ **副产物放不下要看 `lost`，不能只看 `byproducts`**
> 主产物成功、副产物因背包满被丢弃时，`ok` 仍是 `true`，
> 被丢掉的部分记在 `lost` 里（没丢时该字段为 `undefined`）。
> 只看 `byproducts` 的话，稀有副产物（5% 出橙装）被丢掉时
> 运营侧只看到"掉率异常低"，代码侧一切正常——两边都查不出问题。
> 这里**不**为了赠品回滚主产物：副产物是附赠的，不是交易对价。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| **先扣材料后产出** | 材料凭空消失 | 已处理：先产出后扣料，失败回滚 |
| 部分材料够就扣 | 够了的材料也消失 | 已处理：全部检查通过才扣 |
| 合成树成环 | 栈溢出 | 已处理：visiting 检测 |
| maxCount 取平均而非最小 | 产能算多，做到一半失败 | 已处理：取所有材料的最小值 |
| 无消耗型材料时 `maxCount` 归零 | 滑块被禁用，但 `craft()` 能成功 | 已处理：`unlimited: true` + `maxCount: Infinity` |
| 消耗型/检查型材料混淆 | 铁砧被消耗掉 | 用 `consume: false` |
| 无 rng 时期望按权重 | 测试不可复现 | 明确语义：取第一个 |

## API

| 成员 | 说明 |
|---|---|
| `define(recipe)` / `defineAll(recipes)` | 定义配方 |
| `unlock(id)` / `isUnlocked(id)` | 图纸 |
| `byStation(station)` | 按工作台筛选 |
| `canCraft(id, inv, count?)` | 检查，返回 `{ok, missing, maxCount, unlimited}` |
| `craft(id, inv, count?)` | 合成（**原子**） |
| `findCraftable(inv, station?)` | 反向查询 |
| `totalMaterials(id, count?, inv?)` | 展开材料树 |
| `setRNG(rng)` | 设置随机源 |

## API 补充

| 成员 | 说明 |
|---|---|
| `recipeIds` | 全部配方 id |
| `destroy()` | 清空配方与状态 |

> **热重载配方表时先 `destroy()` 再重新注册**，
> 否则同名配方会叠加成两份。
