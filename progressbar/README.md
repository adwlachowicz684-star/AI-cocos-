# progressbar · 进度条

> ⚠️ **写完代码必须同时完成三件事**：① 测试 ② README ③ 登记进 `_kitmeta.json`
> 本插件曾因测试文件被覆盖而变成孤儿，第五次同类事故。

---

## 它解决什么

血条、经验条、加载条。看起来是"画一个矩形填到 ratio"，
但加成分段、延迟条、缓动、阈值变色之后，
每个都是独立实现就会各错各的。

## 用法

```typescript
const hp = new ProgressBar({
  max: 300, value: 300,
  segments: 3,          // 三段血条
  trail: true,          // 延迟条（红色残影）
  trailDelay: 0.35,
  easeSpeed: 0.8,       // 显示值缓动
  lowThreshold: 0.25,   // 低于 25% 变红
  thresholdHysteresis: 0.05,
});

hp.set(120);
hp.update(dt);
hp.state;              // 'low'
hp.segmentIndex;       // 0
hp.segmentFill;        // 0.2
hp.text();             // "120 / 300"
```

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **分段索引用 `ceil(covered)-1` 而不是 `floor`** | 3 段 300 血时，200 血覆盖满两段应显示在第 2 段且**填满**。用 floor 会显示"进入第 3 段、填充 0%"——玩家看到三段都在但第三段是空的，看起来像"还有血"，与直觉相反 |
| **浮点容差** | `1/3 * 3` 可能得到 1.0000000000000002，不加容差会多跳一段 |
| **延迟条用真实 ratio 判断，不是 display** | 开缓动后回血时 display 还在慢慢追，表面上看 trail > display。如果据此开始"下降追赶"，玩家会看到红色残影跟着血条一起涨——语义完全反了 |
| **阈值滞回** | 血线在 25% 上下反复时，没有滞回会让血条每帧闪一次，非常刺眼 |
| **empty / full 优先** | 血量 0 时是 'empty' 不是 'low'；满值时是 'full' 不是 'high' |
| **分段索引跟随 display 而非真实值** | 缓动中玩家看到的是 display，索引也应该对应它 |

## 完整接口

| 成员 | 说明 |
|---|---|
| `set(v)` / `add(delta)` | 设置 / 增减**真实值** |
| `fill()` / `empty()` | 直接拉满 / 清零 |
| `value` / `min` / `max` | 真实值与范围 |
| `ratio` | 真实值占比 0~1 |
| `displayRatio` | **显示值**占比（缓动后）——渲染用这个 |
| `trailRatio` | 延迟条占比 |
| `update(dt)` | 推进缓动与延迟条 |
| `snap()` | 让显示值**立刻追上**真实值 |
| `isEmpty()` / `isFull()` | 是否空 / 满 |
| `state()` | `'empty' \| 'low' \| 'normal' \| 'high' \| 'full'` |
| `segmentCount` / `segmentIndex` / `segmentFill` | 分段总数 / 当前段 / 该段填充度 |
| `segmentBounds(i)` | 第 i 段的渲染区间（见设计章节） |
| `direction` / `reversed` / `vertical` | 填充方向配置 |
| `snapshot()` | 完整状态快照 |
| `text(digits?)` | `"120 / 300"` 这样的文本 |

> ⚠️ **渲染必须用 `displayRatio`，不是 `ratio`。**
> 用 `ratio` 的话缓动完全不起作用——
> 血条会瞬间到位，而 `easeSpeed` 配了等于没配。

> ⚠️ **`snap()` 在初始化和读档时必调。**
> 新建或读档后真实值是满的，但显示值从 0 开始——
> 不 `snap()` 会看到血条从 0 涨到满，
> 玩家以为自己刚回满血。

> ⚠️ **`state()` 的 empty / full 优先于 low / high。**
> 血量 0 时是 `'empty'` 不是 `'low'`；满值时是 `'full'` 不是 `'high'`。
> 做"低血量报警"只判 `low` 的话，血量为 0 时报警反而停了。

> **`segmentIndex` 跟随的是 display 而非真实值**（见坑表格）。
> 缓动过程中玩家看到的是 display，索引对应它才不会出现
> "血条在涨但段数不变"的错位。

### 类型

```typescript
type FillDirection = 'ltr' | 'rtl' | 'ttb' | 'btt';   // 左→右 / 右→左 / 上→下 / 下→上
type BarState      = 'normal' | 'low' | 'high' | 'empty' | 'full';
```

> **`direction` 影响的是渲染方向，不影响数值逻辑。**
> 上下填充时 `vertical` 为 true，可以用来决定进度条节点的宽高比。

**`ProgressBarOptions`**：

| 字段 | 说明 |
|---|---|
| `min` / `max` / `value` | 范围与初值（默认 `0` / `100` / `min`） |
| `segments` / `segmentGap` | 分段数（`0` 或 `1` = 不分段）/ 段间空隙 |
| `trail` / `trailDelay` / `trailSpeed` | 延迟条开关 / 延迟时长 / 追赶速度 |
| `easeSpeed` | 显示值缓动速度（`0` = 不缓动） |
| `lowThreshold` / `highThreshold` | 低 / 高阈值（占比） |
| `thresholdHysteresis` | 阈值滞回量（**防闪烁**，见坑表格） |
| `direction` | 填充方向 |

> ⚠️ **`easeSpeed` 为 `0` 表示不缓动**，不是"无限慢"。
> 想要"瞬间到位"就填 0，想要很慢就填一个很小的正数。

**`BarSnapshot`**（`snapshot()` 的返回）：

```typescript
{ value, ratio, displayRatio, trailRatio,
  segmentIndex, segmentFill, state }
```

> **`snapshot()` 是做存档和回放的**——
> 七个字段正好覆盖渲染所需的全部状态。
> 自己拼的话容易漏掉 `trailRatio`，
> 表现为读档后延迟条位置不对。

## 辅助函数

```typescript
fillPixels(ratio, width, reversed);   // 反向填充总被写错，抽出来
```

反向（rtl）时是 `width * (1 - ratio)`，
很多人写成 `width - width * ratio` 再取绝对值，结果进度条在负值区间乱跑。

## 设计：为什么分段要提供 `segmentBounds`

分段血条有两种画法：

- 画 N 个独立块 — 简单，但每块要单独建节点
- 画一条 + 空隙贴图遮罩 — 省节点，但要算准区间

`segmentBounds(i)` 给出每段的渲染区间，两种画法都能用。

## 测试

**38 项**，覆盖分段语义（含 200/300 那条关键用例）、延迟条方向、
滞回、缓动、像素填充反向、状态优先级。
