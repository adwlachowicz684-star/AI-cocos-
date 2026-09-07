# rarity · 稀有度

---

## 它解决什么

稀有度不只是个排序——还牵扯掉落权重、UI 颜色、保底归属、排序比较。

手写是到处 `if (rarity === 'legendary')`，加一个档位要改十几个地方。

## 用法

```typescript
const r = new Rarity(CommonRarity);   // 5 档预设，也有 SimpleRarity 3 档

r.isRarer('epic', 'rare');      // true
r.atLeast('legendary', 'epic'); // true
r.weight('legendary', 1);       // 1
r.roll(rng);                    // 按权重抽
r.rollAmong(['epic','legendary'], rng);   // 宝箱只出史诗以上
r.best(['common','rare']);      // rare
r.tally(['common','rare','common']);   // {common:2, rare:1, ...}

ids.sort(r.compare.bind(r));    // 最稀有的在前
```

自定义档位：

```typescript
new Rarity([
  { id: 'common', name: '普通', weight: 200, order: 1, color: '#9E9E9E' },
  { id: 'legendary', name: '传说', weight: 1, order: 5, color: '#FF9800' },
]);
```

## 保底归属

```typescript
{ id: 'event', name: '活动专属', weight: 5, order: 6, countsForPity: false }
```

活动专属稀有度**不该推进常规保底**，否则玩家抽活动池会"偷走"常规池的保底进度。

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **未知 id 回退到最低档** | 存档里有已删除的稀有度时，UI 不该崩。静默降级比抛错好 |
| **`order` 重复会导致排序不确定** | 构造即报错 |
| **`weight` 必须为正** | 权重 0 会让 `roll` 永远选不到它，通常是配表笔误 |
| **`tally` 未出现的也有键** | 方便 UI 直接遍历，不用做存在性判断 |
| **`best([])` 返回 null** | 不是 undefined |
| **`order` 必须是有限数** | NaN 会让比较器返回 NaN，排序结果**由引擎实现决定**（实测保持原序）→ `highest` / `lowest` / `compare` / `best` 全错且不报错。保底按 `highest` 判定档位，排序错就会给错档 |
| **`tally` 支持 `__proto__` 这类键** | 用 `{}` 字面量累加时 `out['__proto__'] += 1` 会走原型的 setter，赋值被静默忽略 → 计数整条丢失（实测 `tally(['__proto__','__proto__','b'])` 只剩 `{"b":1}`）。现在按"自有属性"写入 |

## API 补充

| 成员 | 说明 |
|---|---|
| `all` | 全部稀有度（**按声明顺序**） |
| `allAscending` | 全部稀有度，**按 `order` 升序** |
| `highest` / `lowest` | 最高 / 最低档 |
| `getOrFallback(id)` | 取值，未知 id **回退到最低档**（不抛错） |
| `pityEligible()` | 参与保底的稀有度（`countsForPity` 为真的那些） |

> ⚠️ **`all` 与 `allAscending` 的顺序不同。**
> 做稀有度筛选 UI 要用 `allAscending`——
> `all` 是配置里的声明顺序，通常不是"从低到高"。

### 查询静默降级，构造直接抛错

这两件事文档容易混为一谈，实际是**两个时机**：

| 时机 | 行为 | 例子 |
|---|---|---|
| **构造时** | 非法配置**直接抛错** | `weight <= 0`、缺 `order` |
| **查询时** | 未知 id **静默回退**到最低档 | `get('不存在的id')` |

```typescript
new Rarity([{ id: 'r', name: 'R', weight: 0, order: 1 }]);   // ✗ 构造就抛
new Rarity([...]).get('typo');                                // → 返回最低档
```

> 别以为"本模块对异常很宽容"——
> 配置错了它会在**第一次加载配表时**崩，这是有意的（早失败好过数据悄悄错）；
> 只有"查询一个没配过的 id"才降级，那是给存档兼容用的。

## 测试

**27 项**，含 20000 次采样验证权重分布递减、空集合 rollAmong 返回 fallback。
