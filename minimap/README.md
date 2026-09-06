# minimap · 小地图

```typescript
import { Minimap, FogMap } from './minimap/Minimap';
```

- 依赖：`_core/math`
- 引擎耦合：**无**（只算坐标，不画）
- 测试：34 项

---

## 它解决什么

功能完整的小地图要处理六件事：

1. **坐标映射** — 世界坐标 → 小地图像素，含 Y 轴翻转
2. **跟随模式** — 固定（整张地图）vs 跟随（玩家居中）
3. **旋转模式** — 北朝上 vs 随视角转
4. **边界外实体** — 直接不画的话，玩家看不到背后的威胁
5. **图标大小** — 地图缩放时图标不能跟着缩
6. **战争迷雾** — 只显示已探索区域

本模块只做**坐标计算与布局**，输出"每个实体画在哪、多大、
什么朝向、是否钳制"，由调用方渲染。

---

## 用法

```typescript
const mm = new Minimap({
  worldSize: { x: 1000, y: 1000 },
  viewSize: { x: 200, y: 200 },   // 外接盒；圆形内切于它
  mode: 'follow',
  shape: 'rect',                   // 或 'circle'
  scale: 1,
  rotateWithView: false,
});

const icons = mm.layout(entities, playerPos, playerRot, (w) => fog.isRevealed(w));

for (const ic of icons) {
  if (!ic.visible) continue;
  sprite.setPosition(ic.x, ic.y);
  // ⚠️ rotation 约定见下
  sprite.angle = (Math.PI / 2 - ic.rotation) * 180 / Math.PI;
  sprite.color = ic.clamped ? EDGE_COLOR : NORMAL_COLOR;
}
```

### 坐标变换（可单独用）

| 成员 | 说明 |
|---|---|
| `worldToMinimap(world, viewer, viewRot?)` | 世界 → 小地图坐标 |
| `minimapToWorld(m, viewer, viewRot?)` | 小地图 → 世界坐标（**点击传送 / 标记用**） |
| `isInView(p)` | 某点是否在可视范围内 |
| `layout(entities, viewerPos, viewerRot, isRevealed?)` | 一次算出全部图标 |
| `config` | 当前配置 |

> ⚠️ **`worldToMinimap` 内部做了 Y 轴翻转，调用方直接用即可。**
>
> 世界坐标 Y 向上，屏幕坐标 Y 向下，这里在最后一步取负。
> 自己手写变换的话，最容易漏的就是这一步——
> 症状是"小地图上下颠倒"，而左右是对的。

> **`minimapToWorld` 是反向变换**，用于"点击小地图传送 / 打标记"。
> 它和 `worldToMinimap` 互为逆运算，有测试锁住。
> 自己实现反向变换时记得也要翻 Y——**两个方向的翻转是同一个**。

> ⚠️ **`layout` 的钳制在圆形和矩形下算法不同。**
>
> 圆形用**等比例缩放到半径上**；矩形用**分别 clamp x/y**。
> 圆形下如果也分别 clamp，会得到方形边界——
> 图标出现在圆外的四个角上，很怪。

### `FogMap`

| 成员 | 说明 |
|---|---|
| `new FogMap(worldSize, resolution)` | 构造。`resolution` 是**格子数**，不是像素 |
| `resolution` | 格子数（`Math.max(1, resolution)`） |
| `clear()` | 清空（**新一局调用**） |

> ⚠️ **`resolution` 是迷雾网格的分辨率，别设成小地图像素数。**
> 设成 200×200 就是 40000 个格子，而实际只需要几十×几十——
> 内存浪费几十倍，更新也慢。
> 迷雾是"探索记录"，不需要和小地图一样精细。

---

## ⚠️ 朝向约定：`rotation` 以小地图的"上"为 0，顺时针为正

两种模式都遵循这个约定，所以公式一眼可读：

| 模式 | 公式 | 含义 |
|---|---|---|
| 旋转 | `viewRot - entityRot` | 与观察者同向 → 0（朝上） |
| 非旋转 | `π/2 - entityRot` | 朝北 → 0（朝上） |

换算成引擎角度（Cocos 是 0=+X、逆时针为正）：

```typescript
node.angle = degrees(π/2 - ic.rotation);
```

**为什么不直接返回屏幕数学角度？** 那样旋转模式下会多出一个 `-π/2`
常数（因为"观察者前方"被映射到"上"而不是"右"），
调用方拿到 `-π/2` 必然要查文档才敢用。

---

## 坐标变换

```
follow 模式：观察者永远在小地图中心
fixed  模式：整张地图铺进盒子并居中（与观察者无关）
```

旋转分支里**同时完成了 Y 翻转**：
- 非旋转：北（+Y）朝上 → `dy = -dy`
- 旋转：观察者前方朝上 → `(dx, dy) = (-lateral, -forward)`

⚠️ 早期版本在旋转分支后又统一做了 `my = -my`，等于翻了两次。
表现为**正前方的物体显示在右边**，整张小地图转了 90°，
玩家完全没法用，但说不出哪里不对。

---

## 边界钳制

| 形状 | 方式 |
|---|---|
| rect | 分别 clamp x/y |
| circle | **等比例缩放到半径上** |

⚠️ 圆形下分别 clamp 会得到方形边界，图标出现在圆外的四个角上。

半径 = `min(viewSize.x, viewSize.y) / 2`（viewSize 是外接盒）。
早期版本用 `viewSize.x` 当半径，可视范围变成 4 倍。

`clampToEdge: false` 时必须**真的不钳制**——
早期版本无条件钳制，导致配置开关被静默忽略。

---

## FogMap

```typescript
const fog = mm.createFogMap(64);   // ⚠️ 不要跟小地图像素对齐
fog.reveal(playerPos, 200);
fog.isRevealed(p);
fog.coverage;                       // 0~1
const bytes = fog.toBytes();        // 存档
```

用 `Uint8Array` 而非 `boolean[]`（后者每元素占 8 字节）。

**⚠️ 分辨率建议 32~128。** 迷雾是模糊色块，
跟 200×200 的小地图像素对齐纯属浪费，渲染时放大插值即可。

---

## 坑

| 坑 | 后果 |
|---|---|
| 旋转分支后重复翻 Y | 正前方显示在右边，整个地图转 90° |
| 圆形用分别 clamp | 图标出现在圆外的方角 |
| `clampToEdge:false` 被忽略 | 想关掉钳制的人发现关不掉 |
| 迷雾分辨率 = 小地图像素 | 内存浪费几十倍 |
| 图标跟着地图缩放 | 缩到 25% 时敌人图标只剩 1 像素 |
| 固定模式减了 viewer | "固定"小地图跟着玩家抖 |

---

## API

### 类型

| 类型 | 说明 |
|---|---|
| `Vec2` | `{ x, y }` |
| `MinimapMode` | `'fixed'`（整张地图完整显示）/ `'follow'`（玩家居中，地图滚动） |
| `MinimapShape` | `'rect'`（方形关卡）/ `'circle'`（开放世界，视野是圆） |
| `MinimapEntity` | 输入：`id` / `pos` / `rotation?` / `kind` / `alwaysShow?` |
| `MinimapIcon` | 输出：`id` / `kind` / `x` / `y` / `rotation` / `inView` / `clamped` / `distance` / 是否显示 |

> ⚠️ **`MinimapConfig.worldSize` 是"世界的完整尺寸"，不是当前关卡。**
> 开放世界里它可能是 10000×10000。
> 传成关卡尺寸的话，`follow` 模式下地图会滚动到错误的位置。

> **`MinimapIcon.x / y` 是"以小地图中心为原点的像素偏移"**，
> 不是绝对坐标。渲染时要自己加上小地图中心的屏幕位置。

> **`inView` 和 `clamped` 是两个独立的标志**：
> - `inView`：本来就在可视范围内
> - `clamped`：被钳制到了边缘
>
> 钳制后 `inView` 仍是 `false`（它本来在范围外），
> 但 `clamped` 是 `true`。
> 想区分"正常显示"和"边缘提示"，看 `clamped`。

**`MinimapEntity.alwaysShow`**：
设了它就不钳制、不隐藏——用于任务目标这类"必须让玩家知道方向"的实体。

### `MinimapConfig`

| 字段 | 默认 | 说明 |
|---|---|---|
| `worldSize` | 必填 | 世界完整尺寸 |
| `viewSize` | 必填 | 小地图尺寸。`rect` 用 `x`/`y`；**`circle` 只用 `x` 作半径** |
| `mode` | `'follow'` | 固定 / 跟随 |
| `shape` | `'rect'` | 矩形 / 圆形 |
| `scale` | 自动 | 见下 |
| `rotateWithView` | `false` | 是否随玩家朝向旋转 |
| `clampToEdge` | `true` | 范围外实体是否钳制到边缘 |
| `edgePadding` | 4 | 钳制时的内缩像素 |

> ⚠️ **`viewSize` 在圆形模式下只用 `x` 当半径，`y` 被忽略。**
> 传 `{x: 100, y: 100}` 和 `{x: 100, y: 50}` 效果完全一样。

**`scale` 的默认值**：
`fixed` 模式下"刚好装下整个世界"；`follow` 模式下 `1`（1 世界单位 = 1 小地图像素）。

手动指定的用途：follow 模式下想看得更远就设 `0.5`（缩小一半），想看得更细设 `2`。

> ⚠️ **`rotateWithView: true` 会让"北方"不再固定，玩家容易迷失方向。**
> 多数游戏默认关闭，只在载具 / 飞行类里打开。

> **图标不该跟着地图缩放。**
> 缩到 25% 时敌人图标只剩 1 像素，等于没有。
> 渲染时图标用**固定尺寸**，只让位置参与变换。

### 工具函数

| 函数 | 说明 |
|---|---|
| `normalizeAngle(a)` | 把角度规范到 **(-π, π]** |

> 角度累加（旋转、朝向插值）后必须归一化，
> 否则 `rotation` 会涨到 100π 这种值——
> 数学上等价，但做插值时会绕远路转好几圈。
