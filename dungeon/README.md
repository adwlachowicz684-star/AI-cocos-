# dungeon — 地牢 / 关卡生成

## 四种算法

| 算法 | 特点 | 适用 |
|---|---|---|
| **`BSPDungeon`** | **推荐**。房间规整、天然连通、房间数可控 | 标准地牢、Roguelike 层 |
| `RoomDungeon` | 随机撒房间 + 走廊连接。最经典 | 简单场景 |
| `CellularDungeon` | 元胞自动机，天然洞穴感 | 洞穴、沼泽 |
| `MazeDungeon` | 完美迷宫（无环） | 迷宫关卡 |

## 生成后必须自检

生成器**一定会**偶尔产出死图（有房间不可达）。

```typescript
dungeon.generate();
dungeon.isFullyConnected();     // 所有地板连成一块？
dungeon.allRoomsReachable();    // 所有房间中心互相可达？
```

**上线前跑 10000 次自检，统计死图率，目标 0%。**
手测几十次根本碰不到极端情况。

本库测试里跑了 100 次 BSP（种子 1–100），死图率 0。

## 用法

```typescript
const gen = new BSPDungeon({ width: 60, height: 40, seed: 12345 });
gen.generate();

gen.tileAt(x, y);              // Tile.Wall / Floor / Door
gen.isWalkable(x, y);
gen.rooms;                     // 房间列表
gen.findFarthestRoom(0);       // 离 0 号房最远的房 → 放出口 / Boss
gen.randomFloor();             // 随机一个地板格（放道具/怪）
gen.toString();                // ASCII 可视化，调试神器
```

> ⚠️ **`randomFloor()` 返回 `{x,y} | null`，不是 `{x,y}`。**
>
> 没有任何地板时（一个房间都没放下，或还没 `generate()`）返回 `null`。
>
> ```typescript
> const p = gen.randomFloor();
> spawn(p.x, p.y);        // ← 地图生成失败时在 p.x 上抛 TypeError
> ```
>
> 正确写法：
> ```typescript
> const p = gen.randomFloor();
> if (p === null) {
>   // 地图没生成出来，重来一次或降级处理，不要静默跳过
>   return regenerate();
> }
> spawn(p.x, p.y);
> ```

> ⚠️ **`generate()` 不重置 RNG——同一个实例重复生成，结果会变。**
>
> 实测（`CellularDungeon`，40×30，seed=1）：
>
> ```
> new → generate() → floorCount 780
>     → generate() → floorCount 796   ← 不一样
>     → generate() → floorCount 843   ← 又不一样
> ```
>
> 原因是 `_rng` 在**构造函数**里创建，`generate()` 只是继续往下消费。
>
> 所以"同种子可复现"这句话只对**第一次** `generate()` 成立。
> 想做"按 R 重开这一层"，必须 new 一个新实例：
>
> ```typescript
> // ✗ 布局会变
> dungeon.generate();
>
> // ✓ 重新 new，同种子才保证一致
> dungeon = new CellularDungeon({ width, height, seed });
> dungeon.generate();
> ```
>
> `MazeDungeon` 更隐蔽：`floorCount` 恰好都是 211（迷宫总会走满），
> 但**格子布局不同**。用 floorCount 做断言会误以为它可复现。

> ⚠️ **`randomFloor()` 会推进内部 RNG，可复现性依赖调用顺序。**
>
> 内部用 mulberry32（不 import `rng/`，保持本模块零插件依赖）。
> 同种子 + 同调用顺序 = 完全相同的序列，这点已实测确认。
>
> 但这意味着：**多调一次 `randomFloor()`，后面所有随机就全变了。**
>
> ```typescript
> // 场景：先放道具，再放怪
> const spot1 = gen.randomFloor();   // 道具位
> const spot2 = gen.randomFloor();   // 怪位
>
> // 后来改成先放怪再放道具 → 两个位置都变了
> ```
>
> 要独立控制，自己用 `rng/` 从 `gen.rooms` 里挑，不要用 `randomFloor()`。

## 各算法的内部保证

### BSP：为什么死图率是 0

沿 BSP 树**向上回溯连接兄弟节点的房间**。
递归上去后，整棵树必然连通——这是它比其他生成器可靠的核心原因。

长宽比 > 1.25 时强制沿长边分割，否则会出现 5×40 这种怪异房间。

### Room：为什么用并查集

直接"每个房间连最近的"会产生孤岛环。
用并查集先建最小生成树（保证连通且不绕），再随机加约 15% 的环路
（避免地图只有一条主路太单调）。

### Cellular：孤岛必须清理

元胞自动机**几乎必然**产生孤岛。不清理的话：
- 玩家看到走不到的区域
- 宝箱生成在里面导致无法通关

策略：找出所有连通区域 → 保留最大的 → 小的填成墙，大的用隧道连到主区。
边界强制为墙（迭代可能把边界打开）。

### Cellular：运行时生成要分帧

`generate()` 一次性跑完，实测耗时：

| 边长 | CellularDungeon | BSPDungeon |
|---|---|---|
| 64  | 11ms | <1ms |
| 128 |  6ms | <1ms |
| 256 | 14ms |  1ms |
| 512 | **62ms（≈3.7 帧）** |  1ms |

算法固有成本：随机填充 1 遍 + 平滑 5 遍，每遍 O(w×h) 且每格数 8 个邻居。
512² × 6 遍 ≈ 160 万格、1300 万次邻居统计。

- **加载期用 `generate()`**（有 loading 画面遮着）
- **运行时动态生成用 `generateSteps()`** 分帧
- 或者干脆换 `BSPDungeon`——同样尺寸快 60 倍

```typescript
const it = dungeon.generateSteps();
scheduler.everyFrame(() => {
  if (it.next().done) { scheduler.stop(); onReady(); }
});
```

> ⚠️ **生成过程中地图处于中间状态**：没跑完之前 `tileAt()`
> 拿到的是还没平滑完的噪声图，此时寻路/刷怪都会基于错误数据。
>
> ⚠️ **最后一步会稍长**：填充/平滑/封边三个阶段都按行切片，
> 但「孤岛清理」是 floodFill，无法按行安全切片（连通性跨行），
> 一次性完成。若连这一帧都不能掉，把边长控制在 256 以内或改用 BSP。

### Maze：尺寸必须是奇数

用"格子 + 墙"表示法：偶数坐标是墙，奇数坐标是房间。
偶数尺寸会让最后一行/列没有房间 → 构造时抛错。

`braidRatio` 打通一些墙制造环路。**完美迷宫不好玩**——
只有唯一解，走错就要原路返回。

## 坑

### ⓪ `initialWallChance` 调到 0.55 会让生成慢 20 倍（已修）

曾经 `_tunnelToMain()` 用**两区全量两两比较**找最近点：

```typescript
for (const a of region) for (const b of main) { ... }   // O(|region| × |main|)
```

只有"大次区"才会走到这里（小于主区 5% 的会直接填掉），
所以默认参数（0.45）下完全测不出来。但 0.55 时大次区频繁出现：

| 边长 | 修复前 | 修复后 |
|---|---|---|
| 192 | 142ms | 21ms |
| 256 | 418ms | 31ms |
| 384 | **1295ms ≈ 78 帧** | **59ms** |

增长远超面积增长（面积 ×1.5，耗时 ×2.4~30），确认是平方级。
现改为两区各采样至多 256 个点，复杂度降为常数。

> **目标只是"把两个区连起来"，不是"找到数学上最近的一对"。**
> 采样误差最多几个格子，隧道长一点短一点，玩法上没有任何区别。

### ① 房间重叠检查要用带 padding 的判定

```typescript
rectsOverlap(a, b, spacing);   // ✅ 房间之间留间隔
rectsOverlap(a, b);            // ❌ 房间会贴在一起
```

padding 必须**两侧都加**，只加一侧会让判定不对称。

### ② 地形代价 vs 通行判定

（如果用 A* 在生成的地图上寻路）`costOf` 必须配 `isWalkable` 一起传，
只传 `costOf` 的话非 0 格仍被当成墙。

### ③ minRoomSize 太小

`BSPDungeon` 要求 `minRoomSize >= 3`，否则抛错。
太小会导致房间退化成走廊。

## API

### 所有生成器共有（继承 `DungeonBase`）
`generate()` / `tileAt(x,y)` / `setTile(x,y,t)` / `isWalkable(x,y)`
`rooms` / `roomCount` / `floorCount` / `width` / `height`
`floodFill(sx,sy)` / `isFullyConnected()` / `allRoomsReachable()`
`findFarthestRoom(id)` / `roomDistance(a,b)` / `randomFloor()`

> ⚠️ **这三个方法的参数是「房间 id」，且非法 id 是静默失败的。**
>
> | 方法 | 非法 id 时 | 后果 |
> |---|---|---|
> | `findFarthestRoom(999)` | 返回 `999` 本身 | 你拿到了一个根本不存在的房间号 |
> | `roomDistance(a, 999)` | 返回 `-1` | 当距离用会得到负数，排序时排到最前 |
>
> 两者都不抛错。房间 `id` 从 0 开始、等于 `rooms` 数组下标（已实测确认），
> 所以传下标也能工作——但别依赖这点，先用 `d.rooms.length` 校验一遍。
`toGrid()` / `toString()`

### 几何工具（可单独用）

| 函数 | 说明 |
|---|---|
| `rectCenter(r)` | 房间中心（**向下取整**，保证落在格子上） |
| `rectsOverlap(a, b, padding)` | 两矩形是否重叠（**`padding` 会加在两侧**，见下） |

> ⚠️ **`rectsOverlap` 的 `padding` 是向**两侧**各加一次。**
> 传 `spacing = 2` 得到的是 4 格间隔，不是 2 格。
> 想留 2 格得传 1——这个坑在"房间之间有缝但看着不对"时才会被发现。
>
> ```typescript
> rectsOverlap(a, b, spacing);   // 这是"每侧"的间隔
> ```

> **`rectCenter` 用 `Math.floor` 是有意的。**
> 房间宽高为偶数时，中心落在两格之间；
> 用 `round` 会让中心随房间位置**奇偶交替偏移**，
> 表现为"同样大小的房间，宝箱位置差一格"。

### BSPDungeon
`{ width, height, seed, minRoomSize=6, maxDepth=4, roomPadding=1, corridorWidth=1 }`

### RoomDungeon
`{ width, height, seed, roomCount=12, minRoomSize=4, maxRoomSize=10, spacing=2 }`

### CellularDungeon
`{ width, height, seed, initialWallChance=0.45, iterations=5, birthLimit=5, deathLimit=4 }`

除共有的 `generate()` 外，还多一个 **`generateSteps(rowsPerStep = 16)`**（分帧生成）。

### MazeDungeon
### MazeDungeon
`{ width, height, seed, braidRatio=0.1 }` — **尺寸必须为奇数**

---

## 返回值结构

### `Rect`

```typescript
interface Rect { x: number; y: number; w: number; h: number }
```

> **`w` / `h` 是宽高，不是右下角坐标。**
> 和 `x` / `y` 相加才是右下角——
> 当成 `(x, y, x2, y2)` 用会让房间尺寸翻倍。