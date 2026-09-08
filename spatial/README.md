# spatial — 空间哈希（存泛型对象版）

> ## ⚠️ 与 `ds/SpatialHash` 怎么选
>
> 本库现在有**两个**空间哈希，API 不同，用途不同：
>
> | | `spatial/SpatialHash<T>`（本文件） | `ds/SpatialHash` |
> |---|---|---|
> | id 类型 | `string` | `number` |
> | 存什么 | **存泛型对象本身** | 只存 id，对象你自己用数组管 |
> | 额外方法 | `queryNearest(x, y, k)`、`get(id)` | — |
> | 负坐标 | 支持 | 支持（Cantor 配对） |
> | 配套 | 独立 | 同目录还有 `QuadTree`、`BinaryHeap`、`DisjointSet` |
>
> **新代码怎么选**：
> - 要"找出最近的 3 个敌人"→ 用本文件（`queryNearest`）
> - 要"找出周围所有单位"且 id 是数字 → 用 `ds/SpatialHash`，更轻量
> - 要和其他数据结构配套用 → 用 `ds/`（一次引入四个）
>
> 两者都通过了测试。保留两个是因为 API 差异较大，
> 强行合并会破坏 `examples/batch3-usage.ts`（它依赖本文件）。

# spatial — 空间哈希

## 它解决什么

"找出半径 5 米内的所有敌人"——朴素做法是 O(n) 遍历。
同屏 200 个敌人 × 每帧一次范围查询 = 40000 次距离计算，移动端实打实掉帧。

空间哈希把空间切成格子，只检查目标格子及其邻居。

## 什么时候用

| | |
|---|---|
| ✅ 用 | 元素 > 100 且查询频繁（子弹碰撞、AOE 选取、屏幕剔除） |
| ✅ 用 | 元素分布比较均匀 |
| ❌ 不用 | 元素 < 50（直接遍历更快，哈希有常数开销） |
| ❌ 不用 | 元素挤在极少数格子（退化成 O(n)，改用四叉树） |

## 格子大小怎么选

**约等于典型查询半径的 1~2 倍**。
太小 → 一次查询要检查很多格子；太大 → 每格元素太多，过滤成本高。

## 用法

```typescript
import { SpatialHash } from './spatial/SpatialHash';

const hash = new SpatialHash<Enemy>({ cellSize: 5 });

// 每帧：移动后必须 update
for (const e of enemies) {
  e.update(dt);
  hash.update(e.id, e.x, e.y);
}

const hits = hash.queryCircle(px, py, 8);        // 爆炸伤害
const visible = hash.queryRect(l, b, r, t);     // 屏幕剔除
const nearest3 = hash.queryNearest(x, y, 3);    // 最近的 3 个
```

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 元素移动后忘了 `update` | **"明明站在爆炸里却没受伤"**，极难定位 | 移动后立即 update |
| 不清理空格子 | 开放世界积累几万个空 Map 项 | 已自动清理 |
| cellSize 选得离查询半径差太远 | 性能退化 | 取查询半径的 1~2 倍 |
| 元素 < 50 也用 | 反而更慢 | 直接遍历 |

## API

| 成员 | 说明 |
|---|---|
| `insert(id, item, x, y)` | 插入 |
| `update(id, x, y, item?)` | **更新位置（移动后必须调用）** |
| `remove(id)` | 移除 |
| `queryCircle(cx, cy, r)` | 圆形范围查询 |
| `queryRect(minX, minY, maxX, maxY)` | 矩形查询 |
| `queryNearest(x, y, k, maxRadius?)` | 最近的 K 个 |
| `itemCount` / `cellCount` | 统计（调试用） |
| `clear()` | 清空全部条目**和格子**（`_cells.clear()` + `_items.clear()`） |
| `destroy()` | 等价于 `clear()`（实现就一行 `this.clear()`） |

> ⚠️ **`clear()` 与 `destroy()` 当前没有区别。**
>
> 实测（`cellSize=10`，插入 2 个后）：
>
> | 操作 | `itemCount` | `cellCount` | 之后能否 `insert` |
> |---|---|---|---|
> | 插入 2 个后 | 2 | 2 | — |
> | `clear()` | 0 | **0** | ✅ 能 |
> | `destroy()` | 0 | 0 | ✅ **也能** |
>
> `destroy()` 的实现只有 `this.clear()`，没有"失效"标记——
> 调完之后**照样能 `insert`**，不会抛错，也不会静默丢弃。
>
> 这里曾经写过"`clear()` 格子保留、`destroy()` 之后整个结构失效"，
> 两句都是错的（实测推翻）。本表按实测重写。
>
> 换关卡用哪个都行，因为两者等价。
> 但**别依赖"`destroy()` 之后会报错"来做防御**——它不会报错。

> **`cellCount` 是判断"格子设得对不对"的关键。**
>
> 它是**实际占用的格子数**，不是"总格子数"——
> `_removeFromCell` 会在格子空了时立刻 `_cells.delete(key)`，
> 所以空格子不计数。
>
> 比值 `cellCount / itemCount` 的含义：
>
> | 比值 | 含义 | 症状 |
> |---|---|---|
> | 接近 1（每格约 1 个） | 格子**偏小** | 范围查询要扫很多个格子 |
> | 远小于 1（每格很多个） | 格子**偏大** | 同格内退化成线性遍历 |
>
> 两种极端都会退化，原因不同。
> 这里曾经只写了"接近 1 = 太小 = 退化成线性查找"，
> 把"格子偏小"和"线性查找"绑在一起——
> 但格子偏大的症状才是同格内线性遍历。
> 详见"格子大小怎么选"一节。
