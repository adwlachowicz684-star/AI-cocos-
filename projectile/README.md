# projectile — 弹道系统（纯逻辑）

## 它解决什么

子弹、箭矢、火球、投掷物。共性是：
**沿轨迹移动 → 途中检测碰撞 → 命中或超时后消失**。

本模块只负责**运动与生命周期**，不负责渲染，也不负责碰撞的具体实现。

## 零业务依赖的两处关键设计

### ① 碰撞通过接口注入

```typescript
export interface ICollisionProvider {
  sweep(fromX, fromY, toX, toY, mask, exclude): CollisionHit | null;
}
```

弹道不知道碰撞是 HitboxWorld、瓦片地图还是简单圆列表。
传什么进来就用什么检测——所以同一套弹道能用于俯视角射击、横版、塔防、弹幕。

### ② 命中回调由调用方决定做什么

它不扣血、不播特效。命中只是回调，扣血请用 `damage-pipeline`。

## ⚠️ 为什么接口要 sweep 而不是 point

子弹一帧可能移动 14 × 0.016 ≈ 0.22 米。
如果墙只有 0.1 米厚，用点检测就会**直接穿过去**——
这是高速弹丸最经典的 bug，表现为「偶尔穿墙，无法复现」。

所以接口要求**扫掠检测**（线段），不是点检测。
即使你的碰撞方只支持点检测，也可以用 `maxStep` 把一帧位移切成小段来缓解。

## 五种运动模式

| 模式 | 说明 | 典型 |
|---|---|---|
| `linear` | 直线匀速 | 箭矢、子弹 |
| `accel` | 直线加/减速 | 蓄力炮、减速球 |
| `parabola` | 抛物线（给定落点自动算初速） | 投掷、炮弹 |
| `homing` | 追踪（带转向率上限） | 追踪弹 |
| `sine` | 沿主方向正弦摆动 | 魔法弹、波浪弹 |

## 用法

```typescript
const sys = new ProjectileSystem({
  collision: createHitboxSweepProvider(world),
  bounds: { minX: -50, minY: -50, maxX: 50, maxY: 50 },
  maxStep: 0.5,
});

sys.spawn({
  x: px, y: py, dirX: 1, dirY: 0,
  speed: 14, mode: 'linear',
  pierce: 1, lifetime: 3,
  mask: LAYER_ENEMY,
  onHit: (hit) => pipeline.apply({ raw: 20 }, hit.data),
});

sys.tick(dt);   // dt 来自 Scheduler，暂停时自动停
```

## 六个坑

**① `lifetime` 必填**
没有它，追踪失败的弹丸会永远飞。再加 `bounds` 做第二道保险。

**② 零向量方向会变 NaN**
调用方可能传 `(0,0)`（摇杆没推）。不处理会得到 NaN 速度，
坐标变 NaN 后**所有比较都是 false**，弹丸永久存在且看不见。本库内部已兜底。

**③ 穿透的排除集不能共享**
曾经把 `exclude` 做成实例字段，结果 A 打过的目标 B 也打不到。

**④ sine 要从 baseAngle 重算，不能从当前速度反推**
反推会让摆动量进入基准角，轨迹逐渐螺旋漂走。

**⑤ 弹跳后要推出表面**
不推的话下一帧还在墙里，会连续触发弹跳直到次数用尽。

**⑥ 追踪弹转向率过高会绕圈**
`turnRate` 限制每秒最多转多少度。目标很近时直接判定命中。

## 抛物线初速度反算

```
水平：dx = vx · t
竖直：dy = vy · t − ½g·t²
→ t = |dx| / speed，代入得 vy = (dy + ½g·t²) / t
```

坐标系：**Y 向上为正**（数学惯例）。
如果渲染是 Y 向下，在适配层翻转，别改这里。

## 接 HitboxWorld

```typescript
const provider = createHitboxSweepProvider(world, { segmentRadius: 0.1 });
```

用胶囊近似每一小段路径。放在本文件而不是 `hitbox/`，
是因为分层规则禁止插件横向依赖——两边都是「引用方」，不构成编译期依赖。

## API

| 成员 | 说明 |
|---|---|
| `spawn(spec)` | 发射一枚 |
| `tick(dt, provider)` | 推进并做扫掠检测（`provider` 见上） |
| `kill(id)` | 手动销毁一枚（**打中后要调**，否则它继续飞） |
| `all()` | 取全部（只读） |
| `count` | 存活数量（**调试用**：一直涨说明忘了 `kill`） |
| `clear()` / `destroy()` | 清空 / 销毁 |

> ⚠️ **`count` 只增不减 = 命中后没调 `kill()`。**
> 弹丸会在飞出边界后自动回收，所以不会崩，
> 只是内存缓慢上涨——**这是那种上线一周才被发现的问题**。

## 测试

16 项。重点覆盖高速穿墙、穿透去重、排除集隔离、sine 不漂移。

文件：`Projectile.ts`
