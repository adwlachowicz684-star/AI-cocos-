# inventory — 背包与物品栏

## 它解决什么

背包看起来简单（"就是个数组"），但真做起来有一堆细节：
堆叠、溢出、交换（目标格有东西怎么办）、拆分、
不可堆叠物品、排序整理、改了要通知 UI。

手写这些，每个游戏都要重写一遍，而且每次都会在**交换**的边界情况上出 bug。

## 用法

```typescript
const bag = new Inventory({ size: 20 });

bag.define({ id: 'arrow', name: '箭', maxStack: 99 });
bag.define({ id: 'sword', name: '铁剑', maxStack: 1 });

bag.add('arrow', 150);        // 返回 0（全部放入）
bag.count('arrow');           // 150
const leftover = bag.add('arrow', 500);   // 返回放不下的数量

bag.slots[0];                 // { def, count }
bag.swap(0, 1);
bag.split(0, 5);              // 从第 0 格分 5 个出来
bag.remove('arrow', 30);      // 跨格子扣
bag.compact();                // 整理
```

## move 的三种情况

| 目标格 | 行为 |
|---|---|
| 空 | 直接搬过去 |
| 同类且装得下 | 合并 |
| 不同类 / 装不下 | **交换** |

> 第 3 种为什么是交换而不是失败？
> 玩家拖东西到已占用的格子，期待的是"换位置"。
> 返回失败会让玩家以为操作没生效。

`swap()` 是语义明确的强制交换版本（即使同类也对调，不合并）。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 交换写成了覆盖 | **物品凭空消失**（玩家最愤怒的 bug） | 用本类的 `move`/`swap` |
| `add` 的返回值当布尔用 | 不知道还差多少空间 | 返回的是**放不下的数量** |
| 带 `data` 的物品被自动合并 | 两把不同词缀的剑合成一把 | 有 data 的格子不参与自动合并 |
| 导入时未知物品抛错 | 版本更新删了物品，玩家进不去游戏 | 已处理：跳过并告警 |
| 每帧全量刷新 UI | 浪费 | 用 `onChange` 的 `slots` 只刷新受影响的格子 |

## 生命周期

`destroy()` —— 清空背包、物品定义与订阅者。

> ⚠️ **它会连 `define()` 注册的定义一起清。**
> 只想清空物品的话用 `clear()`——
> 用错的话下一个场景要重新注册全部物品定义，
> 表现为"进新地图后所有道具没有名字和图标"。

## API

| 成员 | 说明 |
|---|---|
| `define(def)` | 注册物品定义（**必须带 name**） |
| `add(id, amount, data?)` | 添加，返回**放不下的数量** |
| `remove(id, amount)` | 跨格子移除，返回实际移除数 |
| `removeAt(index, amount?)` | 移除指定格 |
| `move(from, to)` | 移动 / 合并 / 交换（自动判断） |
| `swap(from, to)` | 强制交换 |
| `split(index, amount, to?)` | 拆分，返回目标格下标（-1 = 失败） |
| `count(id)` / `has(id, n)` | 查询 |
| `remainingSpaceFor(id)` | 还能放多少 |
| `compact()` | 整理（合并同类并压紧） |
| `resize(n)` / `clear()` | 容量管理 |
| `onChange(fn)` | 订阅变更（**slots 是受影响的格子**） |
| `export()` / `import()` | 存档（import 返回丢失的物品数） |

### 容量查询（做背包 UI 用）

| 成员 | 说明 |
|---|---|
| `getDef(id)` | 取物品定义（**拿 name / icon / stackable**） |
| `usedSlots` | 已占用格数 |
| `isFull` / `isEmpty` | 满 / 空 |
| `firstEmpty` | 第一个空格下标（**-1 = 满了**） |
| `slotsUsedBy(id)` | 某物品占了几格 |

```typescript
// 「8/20 格」
ui.text = `${inv.usedSlots}/${capacity}`;

// 拾取前先判断
if (inv.firstEmpty === -1) showToast('背包已满');
```

> ⚠️ **`usedSlots` ≠ 物品种类数。**
> 不可堆叠的物品每个占一格，堆叠的按堆算——
> 想显示"有多少种物品"要自己数，别拿 `usedSlots` 当种数用。
