# collision · 碰撞检测与解析

```typescript
import {
  circle, aabb, obb, capsule, makeCollider, canCollide,
  intersects, satOverlap, sweepCircleAabb, moveAndSlide, separate,
  raycast, CollisionGrid, LAYER,
} from './collision/Collision';
```

- 依赖：`_core/math`
- 引擎耦合：**无**（只算坐标，不画）
- 测试：**46 项**（实测）

---

## ⚠️ 先看这个：它和 `hitbox` 不是一回事

库里已有 `hitbox/`，很容易误以为重复。区别是**需求完全不同**：

| | `hitbox`（已有） | `collision`（本模块） |
|---|---|---|
| 回答什么 | "这个攻击打中了谁" | "这个角色能不能走到这儿" |
| 要什么结果 | 布尔：重叠 / 不重叠 | **MTV**：推开多少、朝哪个方向 |
| 重叠时 | 造成伤害 | **不允许重叠**，要分离 |
| 典型形状 | 扇形（攻击范围） | 胶囊、AABB（身体、墙） |

硬塞进一个模块的话，扇形也要实现 MTV——而那没有意义。

一句话记忆：**hitbox 管"打到"，collision 管"撞到"。**

### ⚠️ 同时 import 两边会报 TS2300

两个模块有 5 个同名导出：
`Shape` / `ShapeKind` / `circle` / `capsule` / `boundingRadius`。

同一个文件里 `import { circle } from '.../collision'` 又 `import { circle } from '.../hitbox'`，
编译器直接报 `TS2300 Duplicate identifier` × 5。

**用带 `Col` 前缀的别名**（本模块已导出，不需要自己 `as`）：

```typescript
import { ColShape, colCircle, colCapsule, colBoundingRadius, ColShapeKind }
  from '.../collision/Collision';
import { HitShape, hitCircle, hitCapsule, hitBoundingRadius, HitShapeKind }
  from '.../hitbox/Hitbox';
```

**两套 Shape 不通用，要自己写转换**：

| | collision（`ColShape`） | hitbox（`HitShape`） |
|---|---|---|
| 取值 | `circle` / `aabb` / `obb` / `capsule` | `circle` / `rect` / `sector` / `capsule` |
| 坐标 | 世界坐标（`circle(x, y, r)`） | 相对偏移（`circle(r, offsetX?, offsetY?)`） |

这是刻意的：两者算法差异大，强行统一不合理。**别看名字一样就混用。**

---

## 它解决什么

**1. 高速穿墙（tunneling）**
子弹速度 2000/秒，一帧移动 33 像素，而墙只有 10 像素厚。
逐帧点检测的起点和终点都在墙外 → 完全漏掉。
表现为"子弹偶尔穿墙，无法复现"——
而它是不是漏，取决于速度和墙厚的比例，**随机性极强**。

**2. 沿墙滑动**
斜向撞墙时如果不把速度投影到墙面切线，
玩家会觉得"我明明在推摇杆，角色却不动"。
**这是动作游戏手感的头号杀手。**

**3. 角落卡住**
同时撞到两面墙，分别应用两个 MTV 会让角色在两个方向上来回弹，
最终卡死在内角。

---

## 用法

```typescript
const walls: Collider[] = [
  makeCollider(1, aabb(100, 0, 5, 50), { layer: LAYER.WALL }),
  makeCollider(2, circle(50, 50, 20), { layer: LAYER.WALL }),
  makeCollider(3, aabb(0, 30, 10, 2), { layer: LAYER.WALL, trigger: true }),
];

// ① 带滑动的移动（核心 API）
const r = moveAndSlide(px, py, radius, dx, dy, walls, {
  layer: LAYER.PLAYER,
  skin: 0.01,
});
// r.x / r.y 是可走到的位置；r.collided 是否撞到；r.nx/r.ny 接触法线

// ② 静态分离（把已陷进墙里的角色挤出来）
const s = separate(px, py, radius, walls);

// ③ 射线（瞄准辅助、视线检测）
const hit = raycast(ox, oy, 1, 0, walls, 200);
```

---

## 形状

```typescript
circle(x, y, r)                 // 圆
aabb(x, y, hw, hh)              // 轴对齐矩形（⚠️ 是半宽半高）
obb(x, y, hw, hh, rot)          // 旋转矩形，rot 为弧度
capsule(x0, y0, x1, y1, r)      // 胶囊（线段 + 半径）
aabbFromSize(cx, cy, w, h)      // 由全长构造 AABB
```

**⚠️ 矩形一律用 half extent（半宽半高），不是 width/height。**
物理计算里几乎全都要用半长，存全长的话每个函数第一行都得 `/ 2`。

**角色建议用胶囊而不是矩形**：矩形撞到墙角会被"角"卡住
（因为角是尖的），胶囊在任何方向都是圆角，能自然滑过去。
这是几乎所有 3D 角色控制器都用胶囊的原因。

### 类型

```typescript
type ShapeKind = 'circle' | 'aabb' | 'obb' | 'capsule';
type Shape     = CircleShape | AabbShape | ObbShape | CapsuleShape;
type AnyShape  = Shape | PolygonShape;
```

| 类型 | 字段 |
|---|---|
| `CircleShape` | `kind:'circle'`, `x`, `y`, `r` |
| `AabbShape` | `kind:'aabb'`, `x`, `y`, `hw`, `hh` |
| `ObbShape` | `kind:'obb'`, `x`, `y`, `hw`, `hh`, `rot`（弧度） |
| `CapsuleShape` | `kind:'capsule'`, `x0`,`y0`,`x1`,`y1`, `r` |
| `PolygonShape` | `kind:'polygon'`, `x`, `y`, `rot`, `pts`（**扁平数组**：`[x0,y0,x1,y1,...]`） |

> ⚠️ **`Shape` 不含 `PolygonShape`，`AnyShape` 才含。**
> 多边形是后加的（SAT 需要），为了不改动既有签名单独留了个联合类型。
> 给接受 `Shape` 的函数传多边形会编译报错——
> 这正是想要的（多边形不在那些函数的支持范围内）。

> ⚠️ **`PolygonShape.pts` 是扁平数字数组，不是 `{x,y}[]`。**
> 写成 `[{x:0,y:0}, ...]` 会静默出错——
> 拿到的是一堆 `undefined` 参与运算，结果全是 `NaN`。

> ⚠️ **`ObbShape.rot` 是弧度不是度。**
> 传 `45` 想表示 45° 的话实际转了 2578°。

**算法返回类型**：

| 类型 | 字段 |
|---|---|
| `SatResult` | `overlap`, `mtvX`, `mtvY`, `depth` |
| `SweepResult` | `hit`, `t`, `nx`, `ny` |
| `MoveResult` | `x`, `y`, `collided`, `nx`, `ny`, `hits` |
| `RaycastHit` | `hit`, `t`, `x`, `y`, `nx`, `ny`, `colliderId` |

> ⚠️ **`MoveResult` 的 `nx`/`ny` 是"最终合成的法线"，不是"第一次撞到的法线"。**
> `moveAndSlide` 可能滑多次，它返回的是最后一次接触面的法线。
> 想拿"第一次撞击"的信息得自己分步调。

> ⚠️ **`RaycastHit.colliderId` 是碰撞体 id，不是实体 id。**
> 和 `hitbox` 的 `Hitbox.id` 一样是"判定体 id"——
> 要拿到业务实体，得在创建时把实体塞进 `userData`。
> 详见本文档开头"它和 hitbox 不是一回事"一节。

---

## 三个核心算法

### `moveAndSlide` —— 带滑动的移动

```
1. sweep 求最早命中时刻 t
2. 移动到撞击点（留 skin 间隙）
3. 把剩余位移投影到墙面切线（滑动）
4. 重复，直到位移用完或到达迭代上限
```

三个必须注意的点：

**① skin（皮肤厚度）**
分离后必须留一点间隙，否则下一帧浮点误差又判为重叠，
角色会在墙上高频抖动。默认 0.01。

**② 迭代上限**
内角会让剩余位移反复被投影，理论上永不收敛。
不设上限会死循环——这是"游戏偶尔卡死一下"的常见原因。默认 4 次。

**③ 剩余量阈值**
剩余位移小于 `1e-6` 就停，否则会为 `1e-9` 的位移白跑一轮。

### `sweepCircleAabb` —— 扫掠

把圆半径"膨胀"到 AABB 上（Minkowski 和），
于是"圆扫过矩形"等价于"点扫过圆角矩形"。

这里简化为点 vs 膨胀后的 AABB（忽略圆角），
换来 O(1) 解析解。**圆角处误差最多 0.41×r**，对游戏碰撞完全够用。

### `satOverlap` —— 分离轴 + MTV

返回 `{ overlap, mtvX, mtvY, depth }`。
`depth` 是把 a 推离 b 所需的距离，`mtv` 是方向。

**⚠️ MTV 取所有轴里重叠量最小的那个。**
取最大的话会把物体推到错误方向（穿到另一边去）——
这也是 MTV 名字里 "minimum" 的含义。

## 几何函数（可单独用）

上面三个是"怎么用这个库"，这一节是"库里还有什么"。
这 13 个都 export 了，零依赖，需要时直接 import，不用自己重写。

### 射线检测

| 函数 | 说明 |
|---|---|
| `raycastAabb(ox, oy, dx, dy, b)` | 射线 vs AABB（slab 方法），返回命中距离或 `null` |
| `raycastCircle(ox, oy, dx, dy, c)` | 射线 vs 圆 |

```typescript
const t = raycastAabb(px, py, dirX, dirY, wallAabb);
if (t !== null) { /* 命中，t 是距离 */ }
```

**射线检测的用途**：瞄准辅助线、视线检测、子弹命中预判、点击拾取。

> ⚠️ **`raycastCircle` 的判别式 < 0 不是 bug**，那只是"没打中"。
> 早年见过有人在判别式为负时 `throw`，
> 于是**瞄准辅助线扫到空处就崩**——
> 而扫到空处恰恰是绝大多数时候的情况。

> 📐 **契约：射线起点落在形状「内部」时，返回的是「穿出点」，不是 miss。**
>
> `raycastAabb` 与 `raycastCircle` 在这一点上语义**一致**：
> 起点在内部时返回射线穿出该形状的 `t`，法线朝外。
>
> 早期 `raycastAabb` 在这里判了 miss（守卫写的是 `tmin < 0`），
> 于是同一条射线、同样"起点在内部"的情形下，
> AABB 说没打中、圆说打中了——而 `raycast()` 是统一入口，按形状分派。
>
> 后果出现在视线检测（LOS）上：射线起点一旦落进某个 AABB 障碍内部
> （角色贴墙、站在触发盒里、胶囊体起点偏移进墙），
> 这个障碍就被判"没挡住" → **敌人隔着墙看见玩家**。
> 换成圆形障碍一切正常，于是表现为"偶尔能穿墙看到人"，极难复现。

### 相交判定（粗筛 → 精确）

| 函数 | 说明 |
|---|---|
| `circleCircle(a, b)` | 圆 vs 圆 |
| `aabbAabb(a, b)` | 矩形 vs 矩形 |
| `circleAabb(c, b)` | 圆 vs 矩形 |
| `circleCapsule(c, cap)` | 圆 vs 胶囊 |
| `pointInAabb(px, py, b)` | 点是否在矩形内 |
| `pointInCircle(px, py, c)` | 点是否在圆内 |

```typescript
// 粗筛：先比包围圆，省掉大量精确计算
if (distSq(a, b) > (boundingRadius(a) + boundingRadius(b)) ** 2) continue;
if (circleCapsule(a, b)) { /* 命中 */ }
```

### 辅助

| 函数 | 说明 |
|---|---|
| `boundingRadius(s)` | 包围圆半径（**粗筛用**） |
| `shapeCenter(s)` | 形状中心（排序、粗筛用） |
| `closestPointOnSegment(px, py, x0, y0, x1, y1, out)` | 点到线段的最近点（**写入 out，避免分配**） |
| `distSqPointSegment(px, py, x0, y0, x1, y1)` | 点到线段的**距离平方** |
| `describeShape(s)` | 形状的人类可读描述（**调试用**） |

> **`distSqPointSegment` 返回平方，不是距离。**
> 和距离阈值比较时要先平方：`if (distSq(...) < r * r)`。
> 多写一次 `Math.sqrt` 在每帧几千次调用的循环里是实打实的开销。

---

## 层与空间网格

```typescript
LAYER.PLAYER | LAYER.WALL | LAYER.ENEMY | LAYER.TRIGGER | ...
makeCollider(id, shape, { layer, mask, trigger, userData })
canCollide(a, b)   // 双向：我的 mask 认你的 layer，你的 mask 也认我的 layer
```

**用位掩码而不是字符串标签**：相交判断是一条 CPU 指令，
字符串要查表。高频路径（每帧几百次）上差别明显。

```typescript
const grid = new CollisionGrid(64);   // 格子尺寸
grid.insert(collider);
grid.query(x, y, r);                  // 已去重
grid.clear();                         // 每帧重建前调用
grid.bucketCount                      // 调试用，见下
grid.cellSize                         // 当前格子尺寸（只读）
grid.nextId()                         // 分配一个唯一 id
grid.destroy();                       // 换场景时调用（见下）
```

> **`bucketCount` 是判断格子尺寸对不对的唯一指标。**
>
> | bucketCount | 含义 |
> |---|---|
> | ≈ 碰撞体数量 | 健康（散列均匀） |
> | 远小于碰撞体数 | **退化成一个桶 = 暴力 O(n²)** |
> | 远大于碰撞体数 | cellSize 太小，内存与遍历都浪费 |
>
> `cellSize` 配错**不会报错**，只是莫名地慢。上线前看一眼这个数。

> ⚠️ **`grid.cellSize` 是只读的，构造后改不了。**
> 想换格子尺寸必须重新 `new`——
> 直接给 `grid.cellSize = 32` 赋值**不报错但也不生效**
> （它是 getter，没有 setter）。
> 表现为"我明明调小了格子，性能没变"。

> ⚠️ **`nextId()` 是网格自己分配 id 用的，不是给你造碰撞体 id 的。**
> 它由 `insert()` 内部调用（碰撞体没带 id 时自动分配）。
> 业务自己调它会**消耗掉一批序号**——
> 后果不严重（只是 id 不连续），
> 但如果你依赖 id 连续做数组索引就会出问题。
> 造碰撞体用 `makeCollider()` 并自己传 id。

> ⚠️ **`clear()` 是"清空重来"，`destroy()` 是"不用了"。**
>
> 两者当前都会清空桶，但语义不同：
> `clear()` 之后这个网格还要继续用（每帧重建就是这么干的）；
> `destroy()` 之后它**不该再被使用**。
>
> 不调 `destroy()` 的代价是内存：`_buckets` 是对碰撞体的**强引用**，
> 换场景时你销毁了实体，但网格还吊着它们 → **实体删了内存不降**。
> 这类泄漏不会报错，只在长时间游玩后表现为"越玩越卡"。
>
> 【为什么不重置 `_nextId`】调用方可能缓存着旧的碰撞体 id。
> 重置会让新碰撞体拿到与旧对象相同的号，
> 那种"同一个 id 指向两个不同对象"的错误极难定位。
> 单调递增的代价只是一个计数器。

> ⚠️ **`query()` 不可重入。** `seen` 去重集合是实例级的，
> 若你在遍历 `out` 期间又调了一次 `query()`（例如对每个碰撞体再做一次范围查询），
> 内层会把 `seen` 清空，外层循环继续跑时去重记录已经丢了 → **外层结果错乱**。
> 需要嵌套查询时，为内层单独 `new` 一个网格，或先 `out.slice()` 再遍历。

**⚠️ 跨格子的碰撞体在 `query` 里只返回一次。**
不去重的话，站在格子边界的角色会被检测两次，
分离力翻倍 → 抖动。

**为什么不用 `ds/` 里的 QuadTree**：
QuadTree 适合静态、分布不均的数据；碰撞体每帧都在动，
重建开销反而更大。均匀网格是"动态 + 尺寸相近"场景的经典选择。

---

## 坑

| 坑 | 后果 |
|---|---|
| 把矩形当 width/height 传 | 判定范围变成 4 倍 |
| `cellSize` 为 0 | 除零 → key 变 NaN → 全部塞进一个桶，退化成 O(n) 且**不报错**，只是莫名地慢 |
| 忘记 `grid.clear()` | 碰撞体越积越多，越来越慢 |
| sweep 的起点离墙太远 | 一帧根本没到墙 → 返回"未命中"，看起来像 sweep 失效 |
| `trigger: true` 的体参与 moveAndSlide | 拾取区把玩家挡住（trigger 会被自动跳过，但层掩码配错就不会） |
| 只用静态重叠检测 | 高速物体穿墙 |
| MTV 取最大重叠轴 | 物体被推穿到另一边 |

## 测试抓到的 3 个真 bug

| # | 缺陷 | 现象 |
|---|---|---|
| 1 | **`toPolygon` 返回局部坐标而非世界坐标** | 两个形状的原点不同，却把它们的局部顶点投影到同一条轴上比较——区间完全错位。**极隐蔽**：形状都在原点附近时结果正确，只有位置拉开后才出错，而单元测试很容易只测原点附近 |
| 2 | **SAT 分离判定用了 `<=`** | `maxA == minB` 是"刚好边贴边"，应算重叠（depth=0）。用 `<=` 判分离会让贴墙状态被误判为自由，角色下一帧就能挤进墙里一点点——累积起来就是"偶尔能穿墙" |
| 3 | **退化线段（长度为 0）产生 NaN** | 胶囊两端点重合时，除以长度得 NaN，然后一路传播到位置。表现为"角色突然消失"，不抛任何异常 |
