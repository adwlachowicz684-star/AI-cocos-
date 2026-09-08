# shop — 商店与经济

## 它解决什么

商店不只是"花钱换东西"：

- 价格浮动（不同商店 / 不同时间）
- 折扣（会员、促销、砍价技能）
- 库存（限量商品）
- 刷新（Roguelike 每层重刷货架）
- 买不起的原因：**钱不够** 还是 **没库存**，提示完全不同
- 多货币（金币 / 钻石不能混着算账）

## 用法

```typescript
const shop = new Shop();
shop.defineItem({ id: 'potion', name: '药水', basePrice: 50, sellRatio: 0.5 });

shop.stock('potion', 10, 1.2);        // 上架 10 个，价格 ×1.2

shop.priceOf('potion', 'buy');        // 60
shop.priceOf('potion', 'sell');       // 25（50 × 1.2 × 0.5）

const r = shop.buy('potion', 2, wallet);
// { ok: true, unitPrice: 60, total: 120 }

shop.buy('sword', 1, { gold: 10 });
// { ok: false, reason: 'insufficient_funds', need: 300, have: 10 }
```

## 为什么返回结构化结果而不是 boolean

"买不起"和"没库存"对玩家的提示完全不同：
前者要显示"还差 XX 金币"，后者要显示"已售罄"。
返回 boolean 会逼你再查一次状态——而两次查询之间状态可能已经变了。

## 定价钩子

折扣规则千奇百怪（会员 9 折 + 促销 8 折是相乘还是相加？），
做成字段永远覆盖不全。给一个函数：

```typescript
shop.setPricing((base, ctx) => {
  let p = base;
  if (ctx.side === 'buy') p *= 0.9;          // 会员 9 折
  if (ctx.quantity >= 10) p *= 0.8;          // 批量 8 折
  return Math.max(1, Math.round(p));
});
```

计算顺序：`basePrice → markup → sellRatio → pricing 钩子 → 取整`

> **取整要在最后**。中途取整会让多次折扣累积出偏差。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 先扣钱后发现没库存 | 钱没了东西没到 | 已处理：先检查，通过了才扣 |
| 流水不记货币类型 | 多货币游戏的账混在一起算 | 已处理：log 带 currency，`netSpent()` 按货币过滤 |
| 中途取整 | 多次折扣累积偏差 | 已处理：只在最后取整 |
| 负价格 | 买了还倒赚 | 已处理：夹到 0 |
| 用真实时间做刷新 | 玩家改系统时间刷商店 | 用注入的 rng + 游戏内计数 |

## API

| 成员 | 说明 |
|---|---|
| `defineItem(item)` / `defineAll(items)` | 定义商品 |
| `stock(id, count, markup?)` | 上架。`count` 为 -1 = 无限 |
| `unstock(id)` / `clearStock()` | 下架 |
| `stockOf(id)` / `isStocked(id)` / `stockedItems` | 库存查询 |
| `restock(rng, count, pool?, opts?)` | 随机补货（**rng 必须注入**） |
| `priceOf(id, side, qty?)` | 单价 |
| `buy(id, qty, wallet, currency?)` | 购买（原子） |
| `sell(id, qty, wallet, currency?)` | 出售 |
| `preview(...)` | 预览，**不改变状态** |
| `canAfford(...)` | UI 灰化按钮用 |
| `log` / `netSpent(currency)` / `countLog(currency?)` | 流水与对账 |
| `setPricing(fn)` | 定价钩子 |

## API 补充

| 成员 | 说明 |
|---|---|
| `hasItem(id)` / `getItem(id)` | 查商品是否存在 / 取定义 |
| `totalPriceOf(itemId, side, quantity)` | 批量总价（`quantity` **必填**） |
| `clearLog()` | 清空交易日志 |
| `destroy()` | 清空商品与日志 |

> ⚠️ **算总价用 `totalPriceOf`，不要 `getItem(id).basePrice * n`。**
>
> 单价走 `priceOf(itemId, side, quantity)`，它叠加了三样东西：
> ① 商店个性倍率 `markup`；② 卖出折价 `sellRatio`（默认 0.5）；③ `pricing` 钩子。
> 自己拿 `basePrice` 去乘会漏掉全部三项。
>
> **批量折扣默认是没有的**——`priceOf` 收到 `quantity` 但默认实现不理会它。
> 想要"买得越多越贵"，在 `pricing` 钩子里用 `quantity` 自己算：
>
> ```typescript
> new ShopSystem({
>   pricing: (p, { quantity }) => Math.round(p * (1 + 0.05 * (quantity - 1))),
> });
> ```
>
> 一旦加了这种钩子，`basePrice * n` 和实际扣款就会**对不上**
> （显示 100，点下去扣 120），所以别图省事。


