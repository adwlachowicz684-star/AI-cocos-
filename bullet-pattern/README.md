# bullet-pattern — 弹幕发射器

## 它解决什么

Boss 的弹幕：环形、螺旋、扇形、三连发、镜像墙、随机散射。

手写这些的结果是**每个 Boss 一套重复的计时器代码**，
而且「Boss 阶段切换时开哪个关哪个」的逻辑会散落各处。

本模块把它拆成两层：

- **形状**（Shapes）：一次开火生成哪些子弹
- **编排**（SequencePlayer）：什么时候开、什么时候关

## 零业务依赖

它只输出 `BulletSpawn[]`——**纯数据**（角度 + 速度 + 类型 id）。
怎么变成屏幕上的实体，由业务决定。

## 用法

```typescript
import { BulletPattern, Shapes, SequencePlayer } from './bullet-pattern/BulletPattern';
import { RNG } from './rng/RNG';

const bp = new BulletPattern(new RNG(2024));

bp.addEmitter({ id: 'ring',   shape: Shapes.ring(12, 6, 'orb'),  interval: 1.2 });
bp.addEmitter({ id: 'spiral', shape: Shapes.spiral(3, 5, 'orb', 25), interval: 0.15, delay: 3 });
bp.addEmitter({ id: 'fan',    shape: Shapes.fan(5, 60, 9, 'orb'), interval: 2.0, delay: 6 });

bp.play();

// 每帧
for (const s of bp.tick(dt)) {
  // s.typeId / s.x / s.y / s.angle / s.speed / s.shotIndex
  spawnBullet(s);
}
```

### 序列编排（Boss 阶段切换）

```typescript
const seq = new SequencePlayer([
  { at: 0.0, action: 'start',   emitter: 'ring' },
  { at: 2.0, action: 'start',   emitter: 'spiral' },
  { at: 5.0, action: 'stop',    emitter: 'ring' },
  { at: 9.0, action: 'restart', emitter: 'spiral' },
]);
seq.start();
seq.tick(dt, (step) => {
  if (step.action === 'start') bp.setEmitterActive(step.emitter, true);
  // ...
});
```

## 内置形状

| 形状 | 说明 |
|---|---|
| `ring(count, speed, typeId)` | 环形：count 颗均匀分布在 360° |
| `spiral(count, speed, typeId, stepDeg)` | 螺旋：每次开火整体旋转 stepDeg 度 |
| `fan(count, spreadDeg, speed, typeId)` | 扇形散射 |
| `triple(typeId, speeds[])` | 平行多发，速度可递增 |
| `cross(count, spreadDeg, speed, typeId)` | 双向对称（左右各一份） |
| `scatter(count, spreadDeg, speed, typeId)` | 随机散射（霰弹） |

## 关键设计

### 速度是形状的一部分

速度在 `Shapes` 里配，不在 `EmitterOptions` 里——
因为「三连发速度递增」这类设计里，速度是形状的固有属性。

```typescript
Shapes.triple('bullet', [5, 8, 12])   // 第 n 颗取 speeds[n % len]
```

### `delay` 的精确语义

**第一发出现在 `delay + interval` 时刻。**
即 delay 是「进入发射节奏前的准备时间」，之后每隔 interval 发一次。

这与 Unity 粒子系统的 Start Delay 一致。

> ⚠️ `restartEmitter()` 曾经把 delay 丢了（写成 `e.time = 0`，
> 而构造和 `reset()` 写的是 `e.time = -delay`）。
> 于是同一个「三连发 + 0.5s 前摇」的招式，
> 第一次播放有前摇，restart 后再播**没有前摇**——
> 表现为「这个 Boss 的招式时快时慢」，而配置里明明写了 0.5。
>
> 这类 bug 的形态是**同一份配置在两个代码路径下行为不同**。
> 现在所有重置路径统一走 `_resetTime()`。

### 为什么用 `while` 而不是 `if`

`dt` 很大（掉帧）时可能跨过多次开火间隔。
用 `if` 会漏掉中间的几次——表现为「卡顿后弹幕缺了一段」。

## API

### `BulletSystem`（发射器集合）

| 成员 | 说明 |
|---|---|
| `addEmitter(spec)` | 添加一个发射器 |
| `play()` / `stop()` / `playing` | 整体启停 |
| `tick(dt)` | 推进（**整个项目只调一次**） |
| `setTypeId(emitterId, typeId)` | 运行中换弹型（**换阶段改弹幕外观**） |
| `setEmitterActive(id, active)` | 单独启用/停用某个发射器 |
| `restartEmitter(id)` | 重置并重新开始某个发射器 |
| `isEmitterDone(id)` | 该发射器是否已打完 |
| `allDone` | **全部**发射器是否已打完（波次结算用） |
| `reset()` | 全部重置 |

### `SequencePlayer`（时间轴编排）

| 成员 | 说明 |
|---|---|
| `start()` / `stop()` | 启停 |
| `tick(dt)` | 推进 |
| `running` / `finished` | 是否在播 / 是否播完 |

### 几何工具（可单独用）

| 函数 | 说明 |
|---|---|
| `lerpAngle(from, to, t)` | 角度插值，**走最短弧**（不会绕远） |
| `normalizeAngle2Pi(a)` | 归一化到 `[0, 2π)` |
| `speedAt(spec, index)` | 取第 index 发的速度（`speed` 可以是数组，做「逐发加速」） |
| `compileShape(spec)` | 形状编译成函数（自定义形状时用） |

> **`allDone` 是波次结算的正确判据。**
> 用「发射器数量 == 已完成数量」自己数会漏掉 `shots` 无限的那些。

## 坑

1. **`interval` 必须为正**——构造时会校验。想「每帧都发」用极小值（如 0.016）。
2. **`shots` 不填 = 无限**。无限弹幕一定要有 `stop()` 或 `shots`。
3. **`play()` 之前不生成**——这是特性，方便预配置后统一启动。
4. **方向用角度不是向量**——避免浮点累乘漂移。需要向量时用 `angleToVec(angle, speed)`。

---

## 返回值结构

### `ShapeSpec`

弹幕形状的**规格描述**（不是弹幕本身）：

```typescript
interface ShapeSpec {
  count:          number;            // 数量
  typeId:         string;
  fullCircle:     boolean;           // 是否 360° 全圆
  spreadDeg:      number;            // 扇形张角
  spiralStepDeg:  number;            // 螺旋每发旋转角
  perpendicular:  boolean;           // 是否垂直于发射方向
  jitterDeg:      number;            // 随机抖动角
  speed:          number | number[]; // 速度（数组 = 逐发不同）
  mirrored:       boolean;           // 是否镜像对称
  data:           unknown;
}
```

> ⚠️ **角度字段全是度，不是弧度。**
> 从 `Math.PI` 换算过来要 `* 180 / Math.PI`——
> 直接传弧度的话扇形会窄到几乎一条线。

> **`speed` 可以是数组**，逐发指定不同速度。
> 做"由快到慢"的扩散弹幕时用得上；
> 传单数字就是所有弹同速。