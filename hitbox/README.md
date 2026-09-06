# hitbox — 判定形状与重叠检测

## 它解决什么

「这一刀砍到了谁」是动作游戏最核心的判定。
但它不该认识「敌人」——同一套判定要能用于：

玩家砍怪、怪撞玩家、子弹命中、AOE 选取、拾取范围、陷阱触发、视线遮挡。

这里只有三样东西：**形状、变换、层**。

## 零业务依赖

没有 Enemy / Player / Damage。命中返回 `Hitbox` 本身，
它的 `data` 字段由调用方塞入（通常指向你的实体），检测逻辑不解释它。

## ⚠️ 先看这个：它和 `collision` 不是一回事

库里还有 `collision/`，很容易误以为重复。区别是**需求完全不同**：

| | `hitbox`（本模块） | `collision` |
|---|---|---|
| 回答什么 | "这个攻击打中了谁" | "这个角色能不能走到这儿" |
| 要什么结果 | 布尔：重叠 / 不重叠 | **MTV**：推开多少、朝哪个方向 |
| 重叠时 | 造成伤害 | **不允许重叠**，要分离 |
| 典型形状 | 扇形、矩形（攻击范围） | 胶囊、AABB（身体、墙） |

一句话记忆：**hitbox 管"打到"，collision 管"撞到"。**

### ⚠️ 同时 import 两边会报 TS2300

5 个同名导出：`Shape` / `ShapeKind` / `circle` / `capsule` / `boundingRadius`。

用带 `Hit` 前缀的别名即可共存（本模块已导出）：

```typescript
import { HitShape, hitCircle, hitCapsule, hitBoundingRadius, HitShapeKind }
  from '.../hitbox/Hitbox';
import { ColShape, colCircle } from '.../collision/Collision';
```

两套 Shape 不通用，参数含义也不同（本模块的 `circle(r, offsetX?, offsetY?)` 是相对偏移，
collision 的 `circle(x, y, r)` 是世界坐标）。

---

## 四种形状

| 形状 | 参数 | 典型用途 |
|---|---|---|
| `circle` | radius | 子弹、爆炸、拾取范围 |
| `rect` | halfW / halfH | 剑气矩形、平台 |
| `sector` | radius + angleDeg | **扇形挥砍**（近战最常用） |
| `capsule` | radius + height | 角色体积、激光 |

## 检测精度

| 组合 | 精度 |
|---|---|
| circle × 任意 | **精确** |
| rect × rect | **精确**（OBB SAT） |
| capsule × rect/capsule | **精确** |
| **sector × rect/capsule/sector** | **近似**（采样点） |

扇形参与的复杂组合用采样，是因为 SAT 处理不了弧形边，
而精确解（圆弧与多边形求交）的复杂度收益比太低。

实际游戏里扇形几乎总是**攻击方**，目标是圆/矩形/胶囊——那些组合是精确的。

## 用法

```typescript
const world = new HitboxWorld({ cellSize: 4 });

world.add({
  id: 'bat#1', shape: circle(0.5),
  x: 3, y: 0, rotation: 0,
  layer: LAYER_ENEMY, mask: 0, data: batEntity,
});

const hits = world.query(sector(2, 100), px, py, facingDeg, MASK_HIT_ENEMY);
for (const h of hits) {
  pipeline.apply({ raw: atk, hitId: `${swingId}:${h.hitbox.id}` }, h.hitbox.data);
}
```

### offset：形状中心相对实体原点

角色原点通常在脚底，但受击框中心在身体中部。
`offsetX/offsetY` 是**局部坐标**，会跟随 `rotation` 一起旋转。

这个偏移对**攻击方（查询形状）也生效**：

```typescript
// 剑气：矩形半长 1，沿朝向前移 2 米 → 覆盖身前 1~3 米
const jab: Shape = { kind: 'rect', halfW: 1, halfH: 0.3, offsetX: 2 };
```

### layer / mask 是单向的

命中条件：**`( 查询mask & 目标layer ) !== 0`**

不是双向检查——受击框通常只声明 `layer` 而不关心 `mask`，
双向检查会让它们永远打不到。

## 四个坑

**① 包围圆必须算上 offset**
曾经没算，带 `offsetX: 2` 的剑气在快速排除阶段就被判掉，
表现为「剑明明伸出去很远却打不到人」。

**② 跨格的判定框要去重**
一个框可以同时落在多个哈希格里，`query` 用 `seen` 集合保证只返回一次。

**③ 元素少于 50 时线性扫描更快**
空间哈希有常数开销。小场景用它反而慢。

**④ cellSize 约等于典型判定框直径的 2~4 倍**
太小 → 一个框跨多格，更新成本高；
太大 → 一格几百个框，退化成线性扫描。

## 便利函数

```typescript
circle(radius, offsetX?, offsetY?)
rect(halfW, halfH, offsetX?, offsetY?)
sector(radius, angleDeg, offsetX?, offsetY?)
capsule(radius, height, offsetX?, offsetY?)
```

## 几何函数（可单独用）

这 6 个是上面形状系统的底层，但**零依赖、可单独 import**——
你的代码里需要做几何判断时直接用，不用自己写一遍。

| 函数 | 说明 |
|---|---|
| `shapesOverlap(a, ax, ay, aRot, b, bx, by, bRot)` | 两个形状是否重叠（**含旋转**，检测逻辑本体） |
| `containsPoint(s, cx, cy, px, py, rot?)` | 点是否在形状内 |
| `applyShapeOffset(s, x, y, rot)` | 把 `offset` 按朝向旋转后加到位置上，返回实际中心 |
| `hitboxCenter(b, out?)` | 取判定框的实际中心（`out` 可选，复用对象避免分配） |
| `boundingRadius(s)` | 外接圆半径（**粗筛用**：先比距离再算精确相交，快很多） |
| `samplePoints(s, cx, cy, rot?)` | 取形状的采样点（调试画线、自定义判定用） |

```typescript
// 粗筛：先比外接圆，省掉大量精确计算
if (Math.abs(dx) > boundingRadius(a) + boundingRadius(b)) continue;
if (shapesOverlap(a, ax, ay, aRot, b, bx, by, bRot)) { /* 命中 */ }
```

> **`applyShapeOffset` 是最容易自己写错的一个。**
> offset 的含义是「相对实体原点、随朝向旋转」——
> 直接 `x + offsetX` 的话，角色转身后判定框不会跟着转，
> 表现为「背对着也能打到身前的怪」。

## 视线检测

`world` 上直接有一个：

```typescript
world.lineOfSightBlocked(x0, y0, x1, y1, mask)   // → 被挡住了吗
```

用**细胶囊近似线段**做检测，比逐点采样便宜，且**不会穿薄墙**——
逐点采样在墙比采样间距还薄时会直接漏过去。

```typescript
// 敌人能不能看见玩家（还要结合 FOV 的视野判定）
if (!world.lineOfSightBlocked(ex, ey, px, py, LAYER_WALL)) {
  // 视线通畅
}
```

> ⚠️ **别去 `fov/` 里找两点连线。**
> `Shadowcasting.hasLineOfSight()` 确实存在且正确，
> 但要先构造 `new Shadowcasting(w, h, isWall)` —— **没人会去"视野类"里找连线检测**。
> 而 `shadowcasting` 的 `hasLineOfSight` 是**格子级**的，
> 这里这个是**连续坐标**的，两者不是一回事。

## 世界管理（换关卡时）

| 成员 | 说明 |
|---|---|
| `add(id, ...)` / `remove(id)` | 增删 |
| `update(id, x, y, rotation?)` | 更新位置与朝向 |
| `setEnabled(id, enabled)` | 启停单个判定框（**比反复 add/remove 便宜**） |
| `get(id)` | 取判定框 |
| `count` | 判定框总数（**调试用**：只增不减 = 实体死了没 `remove`） |
| `clear()` / `destroy()` | 清空 / 销毁 |

> ⚠️ **实体死亡必须 `remove(id)`。**
> 不移除的话查询会一直扫到它，
> 表现为「打空气也有命中反馈」，而 `count` 缓慢上涨。

## 测试

16 项。重点覆盖旋转后的偏移、跨格移动、负坐标、去重。

文件：`Hitbox.ts`
