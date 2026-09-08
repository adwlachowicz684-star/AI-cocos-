# fov — 视野计算与战争迷雾

## 三种算法怎么选

| 算法 | 特点 | 适用 |
|---|---|---|
| **`Shadowcasting`** | **推荐**。快、无盲点、墙可见 | 绝大多数情况 |
| `Raycasting` | 简单直观，但有盲点 | 调试对照、半径 ≤3 |
| （严格对称需求） | Shadowcasting **不完全对称** | 见下文"对称性" |

### 实测数据（11×11 空房间，半径 5，理论 81 格）

| 算法 | 可见格数 |
|---|---|
| Shadowcasting | **81**（全部） |
| Raycasting | 21（只有圆周附近） |

差了近 4 倍——这就是盲点的代价。**别拿 Raycasting 做主视野。**

## 用法

```typescript
const fov = new Shadowcasting(width, height, isWall);

const n = fov.compute(playerX, playerY, 8);   // 返回可见格数

fov.canSee(x, y);         // 当前帧可见
fov.hasExplored(x, y);    // 曾经看到过（战争迷雾 → 灰暗显示）
fov.hasLineOfSight(x0, y0, x1, y1);   // 两点视线（远程攻击、AI 发现玩家）
```

**战争迷雾**：`explored` 会累积，走到新地方后原来的区域
从 `canSee = false` 变成 `hasExplored = true`。

地图辅助：
```typescript
import { makeWallTest } from './fov/FOV';
const isWall = makeWallTest(map);            // 默认 1 是墙
const isWall2 = makeWallTest(map, [2, 3]);   // 自定义墙值
```

## 坑

### ① 八分体矩阵抄错（本库踩过，最值得记住的一个）

第一版把手写的坐标映射函数当作变换：

```typescript
// ❌ 错：参数顺序混乱，4 个八分体的 Y 符号写反
(y, x) => ({ x: y, y: -x })
```

现象：**不报错、不崩溃**，只是视野从圆形变成菱形，81 格只看到 47 格。
肉眼看"好像也挺合理"，直到写出"空房间应该全部可见"的测试才暴露。

**教训**：手写坐标变换极易搞混参数顺序。
直接抄标准 2×2 矩阵（`OCTANT_MATRIX`），矩阵写错了测试能抓到，
手写映射写错了只能靠形状看——而形状你未必盯得出来。

### ② 斜率判断用 startSlope，不是 nextStartSlope

```typescript
if (start < rSlope) continue;   // ✅ start 是循环内会被更新的当前光锥边界
```

用 `nextStartSlope` 会让光锥边缘的格子被误跳过 → 圆形视野缺一圈。

### ③ 边界外必须视为墙

`_blocked()` 在越界时返回 `true`，否则视野会"漏"出地图外。

### ④ ⚠️ `canSee` 与 `hasLineOfSight` 是两套算法，别混用

```typescript
fov.canSee(x, y);                       // Shadowcasting：扇形扫描，宽松
fov.hasLineOfSight(x0, y0, x1, y1);     // Bresenham：走直线，严格
```

**实测（40 张随机地图，30% 墙密度）：约 59% 的可见格上两者答案不同。**

原因是判定规则不同：Bresenham 走对角线时要求
**两个正交邻格都通**（禁止擦墙角），而 Shadowcasting 只要
扇形扫到就算可见，宽松得多。

> 注意方向：**`canSee` 为真但 `hasLineOfSight` 为假**是主要情况。
> 即"看得见，但严格意义的直线被墙角挡住"。

**后果**：如果你用 `canSee` 画视野、用 `hasLineOfSight` 判"能不能射击"：

```
玩家：明明看得见那个敌人，为什么打不到？
或者：我藏在这儿它怎么发现我的？
```

**结论：同一件事只用一套判定。**

| 用途 | 用哪个 |
|---|---|
| 战争迷雾、可见性渲染 | `canSee`（扇区算法，形状自然） |
| 远程攻击、AI 发现玩家 | `hasLineOfSight`（几何直线，可预测） |
| 两者都要 | **用 `hasLineOfSight` 作为唯一真相**，`canSee` 只管画面 |

> 这条由 `tests/run_fuzz.ts` 盯着：它会断言"分歧率 > 10%"。
> 哪天这两个算法被改成一致了，那个测试会失败，提醒你同步本文。

### ⑤ 对称性

Shadowcasting **不是严格对称的**：可能出现
"A 能看见 B，但 B 看不见 A"。

玩家会觉得"怪物在作弊"。两种解法：
- 游戏逻辑层补偿："只要有一方能看见就视为互相可见"（推荐，简单）
- 用更慢的 Permissive 算法

`isSymmetric(ax, ay, bx, by, radius)` 可以检测特定两点是否对称。

> ⚠️ **它是纯查询，调用前后 `explored` / `visible` 必须完全一致。**
> 修复前它连调两次 `compute()`，第二次会把 B 的视野**写进 `explored`**，
> 而且结束后 `visible` 停在 B 的视野上。
> 实测（30×30 空地图）：`compute(10,10,6)` → `explored = 113`，
> 调一次 `isSymmetric` 后变成 **148**。
> 于是"探测双方是否互见"这个只读动作**不可逆地点亮了迷雾**，
> AI 每查一次就点亮一小片，几场战斗后迷雾基本失效。
> `explored` 只能靠 `resetExplored()` 全清（换关级操作），中途无法撤销。
>
> 现在两张图都快照、都还原。快照用 `Uint8Array.slice()`（零对象分配），
> 而不是 `toArray()` + 逐格 `mark()`——后者会为每个可见格分配一个对象，
> 在"每帧每怪都要判一次"的热路径上实测慢 **1.5~1.8 倍**，
> 而且随 `explored` 累积越来越贵。

## API

### Shadowcasting
`compute(ox, oy, radius) → 可见格数`
`canSee` / `hasExplored` / `hasLineOfSight` / `isSymmetric` / `resetExplored`
`visible` / `explored`：两个 `VisibilityMap`

### Raycasting
`compute(ox, oy, radius)` / `canSee`

构造要求 `width` / `height` 为正，非正尺寸抛 `[Raycasting] 尺寸必须为正`
（修复前 `new Raycasting(-5, 10)` 抛的是 `Invalid typed array length`，信息里没有单元名）。

### VisibilityMap
`mark(x,y)` / `set(x,y,bool)` / `has(x,y)` / `clear()` / `count` / `toArray()`
`mergeFrom(other)` / `snapshot()` / `restore(snap)`

> `snapshot()` / `restore()` 是**零对象分配**的保存/还原（底层 `Uint8Array` 切片），
> 用于 `isSymmetric` 这类"改完要还原"的场景。
> `toArray()` 会为每个可见格分配一个对象，别在热路径上用它做快照。

越界访问全部安全（返回 `false`）。

`inBounds(x, y)` —— 坐标是否在范围内。
**`set` 内部已经判了 `inBounds`，越界写入会被静默忽略。**

> ⚠️ 这是"安全"也是"陷阱"：
> 算错坐标时不会报错，只是**那一片永远是黑的**。
> 排查"某个区域不显示"时，先确认坐标没超界，再去查算法。
