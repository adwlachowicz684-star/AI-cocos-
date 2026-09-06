# pathfinding — 网格寻路（GridGraph 版）

> ## ⚠️ 与 `pathfind/PathFinder` 怎么选
>
> 本库现在有**两套**寻路，API 不同：
>
> | | `pathfinding/GridGraph`（本文件） | `pathfind/AStar` |
> |---|---|---|
> | 地图表示 | `GridGraph` 类（`setWalkable` 等） | `number[][]` 裸数组 |
> | 路径平滑 | 内置 `smoothPath()` | 独立 `PathSmoother` 类 |
> | 流场 | ❌ | ✅ `FlowField`（多单位共用） |
> | 地形代价 | ❌ | ✅ `costOf` |
> | 自定义通行 | ❌ | ✅ `isWalkable`（飞行单位等） |
> | 测试覆盖 | 有 | 更全（含多次寻路、斜穿墙角等） |
>
> **新代码怎么选**：
> - 单个单位简单找路 → 两者都行，本文件更省事（自带 GridGraph）
> - 需要流场 / 地形代价 / 飞行单位 → 用 `pathfind/`
> - **新项目建议直接用 `pathfind/`**，它是 superset 且测试更全
>
> 保留本文件是因为 `examples/batch3-usage.ts` 依赖它。

# pathfinding — 网格寻路（A*）

## 性能设计

**① 开放列表用二叉堆**，不是每次 `sort()`：O(log n) vs O(n log n)，100×100 地图上差几十倍。

**② 节点数据用扁平 TypedArray**，不用 `Map<string, Node>`（避免拼字符串 key）。

**③ 用 generation 数组代替每次清空**：`visitedGen[i] === gen` 判断，省掉 O(n) 的 fill。

## 用法

```typescript
import { GridGraph, findPath, smoothPath } from './pathfinding/GridGraph';

const grid = new GridGraph(50, 50);
grid.setWalkableRect(5, 5, 3, 3, false);   // 放一堵墙

const path = findPath(grid, { x: 0, y: 0 }, { x: 49, y: 49 }, {
  allowDiagonal: true,
  heuristic: 'octile',
  maxNodes: 5000,          // 必须有上限，防止卡死
});

if (path) for (const p of path) moveTowards(p);
// 找不到返回 null（目标被围住是正常情况，不是错误）

const smooth = smoothPath(grid, path);   // 去掉锯齿
```

## 格子坐标 ↔ 世界坐标

GridGraph 只认识整数格子，转换由调用方做：

```typescript
const CELL = 1;   // 每个格子代表多少世界单位
toGrid(wx: number, wy: number) { return { x: Math.floor(wx / CELL), y: Math.floor(wy / CELL) }; }
toWorld(gx: number, gy: number) { return { x: (gx + 0.5) * CELL, y: (gy + 0.5) * CELL }; }
```

## 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `allowDiagonal` | true | 允许八向移动 |
| `allowCornerCutting` | false | **false = 不会从墙角缝钻过去** |
| `heuristic` | `'octile'` | manhattan（4向）/ octile（8向）/ euclidean / none |
| `weight` | 1 | >1 更快但可能非最优（1.2~1.5 常用） |
| `maxNodes` | 全部格子 | **必须有上限**，否则封闭大地图上会卡住 |
| `costFn` | — | 地形代价（沼泽、道路） |

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 没有 `maxNodes` | 封闭大地图上寻路跑几百毫秒，开门时卡住 | 设上限 |
| 允许切角 | 敌人从墙角缝里钻过去，很出戏 | `allowCornerCutting: false` |
| 地形代价 ∞ | 该格被当作不可走 | 用 `Infinity` 表示不可走是符合预期的 |
| 高代价 ≠ 不可走 | 沼泽仍可通行，别误以为会返回 null | 想封死请用 `setWalkable(false)` |
| 每帧对每个敌人寻路 | 几十个敌人同时寻路会掉帧 | 分帧/节流，或缓存路径 |
| 忘记 `smoothPath` | 敌人沿格子边缘锯齿移动，很机械 | 用 `smoothPath` |

## 生命周期

`destroy()` —— 清空网格与内部 A* 缓存。

> A* 的开放列表会在多次寻路间**复用同一块内存**（这是性能设计）。
> 不 `destroy()` 的话那块内存一直挂着，
> 大地图上单次峰值可能就有几 MB。

## API

| 成员 | 说明 |
|---|---|
| `new GridGraph(w, h)` | 创建网格（默认全部可走） |
| `setWalkable(x, y, v)` / `setWalkableRect(x,y,w,h,v)` | 设置可走性 |
| `setCost(x, y, c)` / `getCost(x, y)` | 地形代价（默认 1） |
| `findPath(grid, start, goal, opts?)` | **A*，找不到返回 `null`** |
| `smoothPath(grid, path)` | 视线检查合并共线点 |

### 网格维护

| 成员 | 说明 |
|---|---|
| `inBounds(x, y)` | 坐标是否在范围内 |
| `fillWalkable(v)` | 整体填充（**初始化时先全设 false 再挖房间**） |
| `walkableCount` | 可走格子数（**自检用**：为 0 说明地图生成有问题） |
| `size` | 总格子数 `w × h` |
| `clear()` | 清空 |

`push` / `pop` 是内部二叉堆的方法，**不要用**——它们不做堆序维护的边界检查。

> ⚠️ **`fillWalkable(false)` 是"先全封死再挖通"的关键一步。**
> 反过来（默认全通再封墙）在房间生成有 bug 时，
> 会得到一张**看起来正常但有暗道**的地图——
> 敌人从你以为走不通的地方过来，而地图渲染是对的。
>
> 用 `walkableCount` 自检：明显偏大说明有多余的连通区域。
