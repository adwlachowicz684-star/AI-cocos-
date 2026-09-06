# ds — 游戏开发常用数据结构

## 为什么需要这一层

用 `Array` 现搓这些数据结构的后果：

| 现搓方案 | 后果 |
|---|---|
| 每次 `sort()` 取最大值 | O(n log n) → A* 开放列表慢 10 倍 |
| 两两比较做碰撞检测 | 1000 个敌人 = 50 万次判断/帧 |
| 用数组找连通分量 | 查不出"有房间没连上" |

## 四个结构

| 结构 | 解决什么 | 典型场景 |
|---|---|---|
| `BinaryHeap` | O(log n) 取最值 | A* 开放列表、事件队列、伤害排序 |
| `DisjointSet` | 连通性判定 | 房间连通、迷宫生成、区域划分 |
| `QuadTree` | 空间查询 | 视野剔除、碰撞粗筛、范围技能 |
| `SpatialHash` | 均匀网格索引 | 大量同尺寸物体的邻居查询 |

## ⚠️ 库里有两套空间哈希，别选错

`ds/SpatialHash` 和 `spatial/SpatialHash` **同名但完全不同**，API 不兼容：

| | `ds/SpatialHash`（本模块） | `spatial/SpatialHash<T>` |
|---|---|---|
| 存什么 | **只能存 number id** | 泛型，任意对象 |
| 构造 | `new SpatialHash(64)` | `new SpatialHash({ cellSize: 64 })` |
| 插入 | `insert(id, x, y)` | `insert(item, x, y)` |
| 计数 | `count` | `itemCount` / `cellCount` |
| 查邻域 | `queryNeighbors(x, y, r)` | `queryRect` / `queryCircle` |

**新代码用 `spatial/`** —— 它是泛型版，能力更全，还能查圆形/矩形范围。
本模块这份是早期实现，只存 id，为了不破坏已有代码保留着。

场景举例：
- 「一堆子弹里找出附近的」→ 用 `spatial/`，能直接拿到子弹对象
- 「只关心哪些 id 在附近，对象我自己管」→ 两份都行，`ds/` 这份更轻

## 用法

```typescript
// 优先队列
const heap = new BinaryHeap<{ p: number; name: string }>((a, b) => a.p - b.p);
heap.push({ p: 5, name: '普通' });
heap.push({ p: 1, name: '暴击' });
heap.pop();              // { p: 1, name: '暴击' }

// 并查集
const uf = new DisjointSet(5);
uf.union(0, 1); uf.union(1, 2);
uf.connected(0, 2);      // true
uf.componentCount;       // 3

// 四叉树
const qt = new QuadTree<Enemy>({ x: 0, y: 0, w: 800, h: 600 });
qt.insert(x, y, enemy);
qt.query({ x: 0, y: 0, w: 100, h: 100 });

// 空间哈希
const sh = new SpatialHash(64);
sh.insert(id, x, y);
sh.queryNeighbors(x, y, 1);   // 周围 3×3 格
```

## 坑

### ① QuadTree 分裂时重复计数

`_split` 会把已有的项重新分配到子节点，**不能**再调用 `_insert`（那会二次 `++_count`）。

现象：插入 50 个对象，`count` 却是 95。不抛异常，但 `count` 常被用来做"还能加几个"的判断，于是行为变得随机。

已修复：`_split` 用不计数的 `_place()`。

### ② rectsOverlap 的 padding 只加一侧

```typescript
// ❌ 错：只扩了左边
a.x - padding < b.x + b.w && a.x + a.w > b.x
// ✅ 对：两侧都扩
a.x - padding < b.x + b.w && a.x + a.w + padding > b.x
```

判定不对称 → "房间左边不重叠但右边重叠"，极难排查。

### ③ SpatialHash 的 key 冲突

用 `cx * 100000 + cy` 在负数和大数时会撞。这里用 **Cantor 配对 + zigzag 编码**，支持任意整数。

### ④ BinaryHeap 不是稳定排序

同优先级的元素顺序不确定。需要稳定的话，在比较函数里加递增序号做 tie-breaker（`LazyHeap` 就是这么做的）。

## LazyHeap：A* 专用

A* 中"发现更短路径"要更新已入队节点的代价。标准二叉堆不支持 O(log n) 的 decrease-key，常见做法是再 push 一个重复项 + 标记旧的失效。

```typescript
const h = new LazyHeap<string>();
const handle = h.push('node', 10);
h.remove(handle);      // O(1) 标记删除，比真的移除快
h.pop();               // 自动跳过失效项
```

> **不跳过失效项**会返回"找到更短路径之前的旧记录"，
> 表现为"明明有近路却走了远的"。

## API

### BinaryHeap\<T\>
`push` / `pop` / `peek` / `remove(item)` / `removeWhere(fn)` / `drain()` / `toArray()` / `clear()` / `size` / `isEmpty`

批量构造是 **O(n)**（自底向上建堆），不是 O(n log n)。

### LazyHeap\<T\>
`push(item, priority) → handle` / `pop()` / `remove(handle)` / `clear()`

### DisjointSet
`find`（带路径压缩）/ `union`（按秩合并）/ `connected` / `groups()` / `componentSize` / `reset()` / `componentCount`

### QuadTree\<T\>
`insert(x, y, data)` / `query(rect)` / `queryCircle(cx, cy, r)` / `remove(data)` / `clear()` / `count`

构造参数 `(bounds, maxItems = 8, maxDepth = 8)`。

### SpatialHash
`insert(id, x, y)` / `update(id, x, y)` / `remove(id)` / `queryNeighbors(x, y, r)` / `queryRect(...)` / `queryCell(x, y)` / `clear()`

移动时旧的格子会被自动清理，不会重复计数。

> ⚠️ **`queryNeighbors(x, y, r)` 的 `r` 是「格子数」，不是世界距离。**
>
> `r = 1` 表示"以所在格为中心的 3×3 格"，不是"半径 1 米"。
> 参数名叫 `radius` 极易被误解——写模糊测试时我自己就按世界距离写了，
> 结果全军覆没。
>
> 它返回的是**粗筛超集**，不是精确圆：
> 方格区域内的所有 id 都会返回，包括那些距离远大于你预期点。
>
> ```typescript
> // 想要"世界距离 100 以内"，得先换算
> const cellR = Math.ceil(100 / hash.cellSize);
> const rough = hash.queryNeighbors(x, y, cellR);        // 粗筛
> const exact = rough.filter(id => dist(x, y, id) <= 100); // 再精判
> ```
>
> 这条由 `tests/run_fuzz.ts` 的对拍测试盯着（粗筛 vs 暴力解）。

---

## 附：自由函数

### 自由函数

上面的结构之外，还有几个直接可用的几何/工具函数：

| 函数 | 说明 |
|---|---|
| `pointInRect(px, py, r)` | 点是否在矩形内 |

> 这些是给 QuadTree / SpatialHash 内部用的，
> 但因为**零依赖**也一并导出——你的代码里需要判断点是否在矩形内时，
> 直接用它，不用自己写一遍边界比较。

---

## `SpatialHash.cellSize`

> ⚠️ **`cellSize` 只有 getter 没有 setter。**
> `h.cellSize = 32` **不报错但也不生效**（严格模式下才报错）。
> 想换尺寸必须重新 `new`。
> 表现为"我明明调小了格子，性能没变"。
