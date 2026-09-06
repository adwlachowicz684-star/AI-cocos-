# attribute — 属性容器（基础值 + 修正器）

## 它解决什么

游戏里几乎每个数值都是「基础值 + 一堆临时加成」：

```
攻击力 = (基础 20 + 武器 5 + 力量buff 10) × (1 + 狂暴 30% + 遗物 20%)
```

现场算会散落各处；把结果写死，buff 结束时又不知道该减回多少。

AttributeSet 收在一处：**存基础值和修正器列表，用时算，并缓存。**

## 零业务依赖

它不认识「攻击力」「血量」「暴击率」。属性 id 是开放字符串：

```typescript
attrs.define({ id: 'atk', base: 20 });
attrs.define({ id: 'critRate', base: 0.05, min: 0, max: 1 });
```

## 计算公式

```
base' = 最后一个 override?.value ?? base
v     = base' + Σadd
v     = v × (1 + Σmul)
v     = clamp(v, min, max)
```

### 为什么多个 mul 相加而不是连乘

两个 +50%：

| 做法 | 结果 |
|---|---|
| 连乘 | 1.5 × 1.5 = **2.25x** |
| **相加**（本库） | 1 + (0.5+0.5) = **2.0x** |

相加更好：玩家能心算，且不会出现「叠得越多收益越爆炸」的失控。

## 用法

```typescript
const attrs = new AttributeSet([{ id: 'atk', base: 20 }]);

const off = attrs.add({ attr: 'atk', type: 'add', value: 5, source: 'sword', tag: 'equip' });
attrs.add({ attr: 'atk', type: 'mul', value: 0.3, tag: 'buff' });

attrs.get('atk');            // (20+5) × 1.3 = 32.5
attrs.clearByTag('buff');    // buff 到期
attrs.get('atk');            // 25
off();                       // 脱下武器
attrs.get('atk');            // 20

attrs.removeBySource('sword');   // 按来源批量移除
attrs.dump('atk');               // 调试明细
```

### source 为什么必须有

换装备时要精确移除「这把武器」的贡献，
**不能靠值来匹配**——两件装备可能都是 +5。

## `summarizeModifiers`（做装备面板时用）

```typescript
summarizeModifiers(ms)   // → { atk: {add, mul, override}, ... }
```

把一组修正器**按属性分组**统计。UI 上「装备总共提供了多少攻击力」用它一行搞定，
不用自己遍历 `modifiers`。

```typescript
const s = summarizeModifiers(equipMods);
面板显示：`攻击 +${s.atk.add}  攻击力 +${s.atk.mul * 100}%`
```

> `override` 是「直接覆盖」，返回 `number | null`（没有覆盖时是 null）。
> 展示时**必须判 null**——`override ?? 0` 会把「没覆盖」显示成「覆盖为 0」。

## API

### 基础值

| 成员 | 说明 |
|---|---|
| `get(id)` / `set(id, v)` | 读写**最终值**（含修正器） |
| `getBase(id)` / `setBase(id, v)` | 读写**基础值**（不含修正器） |
| `has(id)` | 是否定义过 |
| `ids()` | 全部属性 id |
| `snapshot()` | 取全部当前值的快照（`Record<string, number>`） |

> **存档存 `snapshot()` 读出来的最终值还是基础值？——基础值。**
> 存最终值的话，读档后修正器再加一遍就翻倍了。

### 修正器

| 成员 | 说明 |
|---|---|
| `add(m)` | 添加一个，返回**移除函数** |
| `addAll(ms)` | 批量添加，返回**一次性移除全部**的函数 |
| `removeById(source)` | 按 source 移除（换装备用这个） |
| `removeWhere(attr, predicate)` | 按条件移除，返回移除数量 |
| `clearModifiers(attr?)` | 清空（不传 attr = 全清），返回移除数量 |

```typescript
// 换装备：一次性摘掉旧装备的全部贡献
const off = attrs.addAll(swordMods);
// ...
off();   // 换装时调这一个
```

> ⚠️ **`add` 返回的移除函数只能调一次。**
> 调第二次会误删别人的修正器——
> 而症状是「换了一件装备，另一件的加成没了」，极难联想到这里。

## 三个坑

**① 条件修正会禁用缓存**
带 `condition` 的修正无法缓存（条件可能随时变），
整个 AttributeSet 会退化为每次 `get` 都重算。
只在确实需要时用。

**② 不要在 onChange 回调里修改属性**
会触发递归通知。

**③ 批量修改要挂起通知**
穿 6 件装备会触发 6 次通知、UI 重绘 6 次：

```typescript
attrs.suspendNotify();
for (const m of equipmentMods) attrs.add(m);
attrs.resumeNotify();       // 只发一次，且是最终值
```

## 与 damage-pipeline/ModifierSet 的区别

| | ModifierSet | AttributeSet |
|---|---|---|
| 用途 | 一次伤害结算的**瞬时**修正 | **长期持有**的属性修正 |
| 生命周期 | 一次计算 | 贯穿游戏进程 |
| 缓存 | 不需要 | 需要（版本失效） |

两者同属第 1 层，按规则不能横向依赖，所以 AttributeSet 自带轻量实现。
**这个重复是必要的。**

| `destroy()` | 释放（**之后监听不再触发**） |

> ⚠️ **`destroy()` 之后 `onChange` 不再触发。**
> 换场景时只 `clear()` 不 `destroy()` 的话，
> 旧的属性监听还挂着——新场景里改属性会触发上一局的刷新逻辑。

## 测试

12 项。重点覆盖缓存失效（最容易出的 bug）。

文件：`AttributeSet.ts`
