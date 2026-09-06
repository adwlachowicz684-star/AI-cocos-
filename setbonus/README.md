# setbonus · 装备套装

> N 件套效果。含一个必须先做的设计选择：叠加还是只生效最高档。

## 1. 它解决什么

N 件套看着简单，但有几个分歧点，每个搞错都会让玩家觉得"数值不对"：

| 分歧 | 说明 |
|---|---|
| **部位去重** | 穿两个头盔算 2 件吗？（大多数游戏：不算） |
| **阈值叠加** | 4 件时生效「4 件档」还是「2 件档 + 4 件档」？ |
| **同名装备** | 两把相同的剑算 2 件吗？ |
| **效果回退** | 移除装备后效果要正确回退（最常见的 bug 来源） |

## 2. 五分钟上手

```typescript
const sets = new SetBonusSystem({
  sets: [{
    id: 'flame', name: '烈焰',
    thresholds: [
      { count: 2, effects: [{ stat: 'atk', op: 'mul', value: 1.10 }] },
      { count: 4, effects: [{ stat: 'atk', op: 'mul', value: 1.25 },
                            { stat: 'cdr', op: 'add', value: 0.15 }] },
    ],
  }],
  cumulative: false,     // false = 只生效最高档
});

sets.equip({ id: 'flame_head',  set: 'flame', slot: 'head' });
sets.equip({ id: 'flame_chest', set: 'flame', slot: 'chest' });
sets.summary();     // → { 'atk.mul': 1.10 }
```

## 3. 关键选择：cumulative

```
4 件时：
  仅最高档（WoW 式）  ×1.25
  叠加（暗黑 3 式）    ×1.10 × ×1.25 = ×1.375   ← 高出 10%
```

**配表时必须按叠加后的实际值来平衡**，只看单档数值会低估满套装的强度。

## 4. 部位去重的实现方式

`_equipped` 是 `slot → item` 的映射，**结构上就不可能**同槽位共存两件：

```typescript
sets.equip({ id: 'flame_head', set: 'flame', slot: 'head' });
const old = sets.equip({ id: 'plain_head', slot: 'head' });   // 返回被替换的
sets.countFor('flame');   // → 0，不是 1
```

如果同槽位能共存，卸下一件时另一件还在，效果就不会正确移除。

**同名装备占不同槽位时算 2 件**（双持武器）。若你的设计是"同名只算 1 件"，用 `countDistinctIds()`。

## 5. effects() 与 summary() 的区别

| | 返回 | 用途 |
|---|---|---|
| `effects()` | 原始效果列表 | 交给属性系统按自己的规则合并 |
| `summary()` | 已聚合的 `{'atk.mul': 1.375}` | 快速查看，不需要精细控制顺序时 |

**推荐用 `effects()`**：属性系统对 add/mul 的合并顺序有讲究
（通常是 `(base + Σadd) × (1 + Σmul)`），在这里算死会和它打架。

## 6. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| 档位乱序（4 写在 2 前面） | "只生效最高档"选错档，数值不对且**不报错** | 构造时校验递增 |
| 同槽位共存 | 卸下一件效果不消失 | 用 slot 映射（已内建） |
| 卸下后档位回退错误 | 4→3 件时应回退到 2 件档，不是无效果 | 每帧重算，不缓存 |
| 空档位 / 空效果 | 配置漏写，运行时静默无效果 | 构造时校验 |

## 6.5 API 补充

| 成员 | 说明 |
|---|---|
| `unequip(slot)` | 脱下某个槽位，返回被脱下的装备 |
| `unequipById(id)` | 按 id 脱下（**不知道在哪个槽时用**） |
| `clear()` | 全部脱下 |
| `activeThresholds()` | 当前**已激活**的档位 |
| `progressOf(setId)` | 某套装的进度（`null` = 没这套） |
| `allProgress()` | 全部套装进度 |
| `describe()` | 诊断输出 |

```typescript
// 套装进度 UI："暗影 2/4 → 下一档还差 2 件"
const p = sys.progressOf('shadow');
if (p) {
  ui.text = `${p.setName} ${p.equipped}/${p.required}`
         + (p.toNext !== null ? `　还差 ${p.toNext} 件` : '　已满');
}
```

`SetProgress` 的字段：`setId` / `setName` / `equipped` / `required` / `toNext` / `nextThreshold`。

> ⚠️ **`equipped` 数的是"不同部位"，不是件数。**
> 戴两个同为"戒指"部位的套装件，只算 1——
> 这是套装计数的通行规则（防止堆同一部位刷档位）。
> 早期版本数错这里时，表现为"明明穿了 4 件却只激活 2 件档"。

> **`toNext` 满级时是 `null`**（`0` 表示"还差 0 件就到下一档"，语义不同）。

> **`unequip` 与 `unequipById` 的区别**
> 前者按槽位（`'weapon'` / `'armor'`），后者按装备 id。
> 做"点击已装备的图标脱下"用后者——**UI 拿的是 id 不是槽位**。

## 7. 测试覆盖

28 项。重点覆盖：叠加/非叠加、部位替换、效果回退、构造校验、多套装共存。

## 7.5 API 补充

| 成员 | 说明 |
|---|---|
| `unequip(slot)` | 按部位卸下，返回被卸下的装备 |
| `unequipById(id)` | 按装备 id 卸下（**不知道它在哪个部位时用**） |
| `clear()` | 全部卸下（换角色 / 换存档） |
| `progressOf(setId)` | 单套进度（`null` = 没有这套） |
| `allProgress()` | 全部套装的进度（**套装图鉴 UI**） |
| `activeThresholds()` | 当前已激活的档位 |
| `describe()` | 诊断输出 |

### `SetProgress` 字段

```typescript
{
  setId, setName,
  equipped,          // 已装备的不同部位数
  required,          // 最高档需要的件数
  toNext,            // 距下一档还差几件（满了是 null）
  nextThreshold,     // 下一档的件数（满了是 null）
  activeThresholds,  // 已激活的档位列表
}
```

```typescript
// 「暗影套 2/4 · 再装 1 件激活 3 件效果」
const p = set.progressOf('shadow');
ui.text = `${p.setName} ${p.equipped}/${p.required}`;
ui.hint = p.toNext !== null ? `再装 ${p.toNext} 件激活 ${p.nextThreshold} 件效果` : '已满';
```

> ⚠️ **`toNext` 满了是 `null`，不是 0。**
> `if (p.toNext)` 在满级时会走 else 分支——
> 这看起来对，但 **`toNext` 为 0 的情况不存在**，
> 所以判空用 `!== null` 更不容易在改动后出错。

> ⚠️ **`equipped` 数的是"不同部位"，不是"件数"。**
> 同一部位装两件（如果有这种设计）只算 1 件。

## 8. 依赖

零依赖，纯逻辑。
