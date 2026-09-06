# pathfind — A* 寻路 + 流场

> ## ⚠️ 库里有两套寻路，本目录是**推荐**的那套
>
> 另有一套 `pathfinding/GridGraph`（旧的，API 不同）。
> 区别在于它自带 `GridGraph` 容器，而这里吃 `number[][]` 裸数组。
>
> **[`pathfinding/README.md`](../pathfinding/README.md) 顶部有完整对比表。**
>
> 为什么还留着旧的：`examples/batch3` 与 `tests/run_batch3` 仍在用，
> 删掉要连带改示例与测试。**新代码一律用本目录。**

## 怎么选

| 场景 | A* | 流场 |
|---|---|---|
| 1 个单位找一次路 | ✅ 快 | ❌ 浪费（算了全场） |
| 100 个单位去同一个点 | ❌ 算 100 次 | ✅ 算 1 次 |
| 目标频繁变动 | ✅ | ❌ 每次重算全场 |
| RTS 编队移动 | ❌ | ✅ |

**判据：单位数 × 目标变动频率。单位多且目标稳定 → 流场。**

实测（56×26 地图）：A* 一次 2ms；流场构建 2ms，之后每个单位 O(1)。

## A*

```typescript
const finder = new AStar(map, { allowDiagonal: true });
const r = finder.find({ x: 0, y: 0 }, { x: 10, y: 10 });

r.found;    // **一定要检查**
r.path;     // 不含起点，含终点
r.cost;     // 总代价
```

**返回约定**：
- `found: false` 时 `path` 是空数组。不检查就 `path[0]` 会读到 `undefined`
- 起点 == 终点：`found: true`，`path` 为空
- 起点/终点不可走：`found: false`

### 自定义地形

```typescript
new AStar(map, {
  // 不同单位不同地形能力
  isWalkable: (x, y, v) => v !== 1,          // 飞行单位：() => true
  costOf: (x, y, v) => (v === 2 ? 10 : 1),   // 沼泽代价 10
  maxNodes: 100000,                           // 防卡死
});
```

> ⚠️ **`costOf` 必须配 `isWalkable` 一起用。**
> 只传 `costOf` 的话，默认判定仍要求 `v === 0`，
> 于是沼泽格被当成墙，直接找不到路。

## 坑

### ① A* 实例的缓冲区复用（最隐蔽的一个）

内部用 `stamp` 机制避免每次寻路都清空数组。
**`closed` 也必须存 stamp 值，不能存布尔**：

```typescript
// ❌ 错：起点在新一轮开始时就带上了上一轮的 closed=1
if (closed[ci] === 1 && stamps[ci] === stamp) continue;
// ✅ 对
if (closed[ci] === stamp) continue;
```

现象：**同一个实例，第一次 `find` 成功，第二次开始永远失败。**
不抛异常，只是返回空路径。

### ② 斜穿墙角

对角线移动时两个正交邻居必须至少一个能走，
否则单位会从两堵墙的对角缝隙"挤"过去——视觉上像穿墙。

默认开启（`dontCrossCorners: true`）。**别关它。**

### ③ seek vs arrive

网格 A* 出来的路径是锯齿状的，单位走起来像抽搐。
用 `PathSmoother` 去掉冗余拐点（实测 58 步 → 21 步）。

## PathSmoother

```typescript
const smoother = new PathSmoother((x, y) => isWalkable(x, y));
smoother.smooth(start, path);
smoother.hasLineOfSight(x0, y0, x1, y1);   // 单独用也行
```

原理：如果 `a` 能直线看到 `c`，那 `a→b→c` 里的 `b` 就是多余的。
用 Bresenham 画线，**对角线步进时会检查两个正交邻居**（否则会擦着墙角过去）。

## FlowField

```typescript
const field = new FlowField(map, true);
field.build({ x: 10, y: 10 });      // 算一次

field.directionAt(x, y);            // { x, y } 单位位移，O(1)
field.distanceAt(x, y);             // 到目标的距离
field.hasNext(x, y);                // 是否已到达
field.tracePath(x, y);              // 完整路径（调试用）
```

### 为什么用 Dijkstra 而不是 BFS

对角线代价是 √2，不是均匀图。纯 BFS 会给出错误结果
（把对角线 1 步和直线 1 步当成等价）。

## API

### AStar
`find(start, goal) → PathResult`
`inBounds` / `at(x,y)` / `isWalkable(x,y)` / `width` / `height`

`PathResult = { path, found, nodesExplored, cost }`

### PathSmoother
`smooth(start, path)` / `hasLineOfSight(x0,y0,x1,y1)`

### FlowField
`build(goal)` / `directionAt` / `distanceAt` / `reachable` / `hasNext` / `tracePath` / `destroy`
`isBuilt` —— 是否已构建。**`directionAt` 在未构建时返回零向量，不报错**

> ⚠️ **忘了 `build()` 就调 `directionAt()` 不会崩。**
> 它返回零向量，于是所有单位静止不动——
> 表现为"编队命令下了但没人动"，而且没有任何错误信息。
> 用 `isBuilt` 在下达移动命令前断言一次。
