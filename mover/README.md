# mover · 角色移动控制器

```typescript
import { CharacterMover, MoverPresets, NullSolver, clampSpeed } from './mover/CharacterMover';
import type { IMoveSolver } from './mover/CharacterMover';
```

- 依赖：`_core/math`
- 引擎耦合：**无**（碰撞通过 `IMoveSolver` 注入）
- 测试：**26 项**（实测）

---

## 它补的是什么缺口

库里已有 `joystick-mover/JoystickCore`（摇杆 → 方向向量）
和 `dash/DashController`（冲刺），
但**从"方向"到"角色真的动起来"这一段是空的**。

直接写 `pos += dir * speed * dt` 的角色，玩起来像贴纸在冰上滑：

| 缺失 | 玩家感受 |
|---|---|
| 加速度 | 按下瞬间就到最高速，"贴纸在滑" |
| decel 与 accel 分开 | 要么太黏（停不下来）要么太滑（刹不住） |
| 转身插值 | 掉头是瞬间的，角色没有"重量" |
| 撞墙投影 | 斜着推摇杆撞墙，角色**完全停住** |
| 外力衰减 | 连续挨打会被弹到地图外 |
| 低速归零 | 站定后角色还在微微滑动 |

---

## 用法

```typescript
// ① 最简单的用法（无碰撞）
const m = new CharacterMover({ maxSpeed: 6, accel: 60, decel: 90 });

// ② 接上碰撞（把 collision 模块的 moveAndSlide 包一层）
const solver: IMoveSolver = {
  move: (x, y, dx, dy) => {
    const r = moveAndSlide(x, y, radius, dx, dy, walls, { skin: 0.01 });
    return { x: r.x, y: r.y, collided: r.collided, nx: r.nx, ny: r.ny };
  },
};
const m2 = new CharacterMover({ maxSpeed: 6, solver });

// ③ 主循环（⚠️ dt 用**缩放**时间，暂停时角色该停）
m.update(scaledDt, dirX, dirY);

// ④ 击退
m.addImpulse(knockX, knockY, maxExternal);

// ⑤ 与 Dash 配合：冲刺期间绕过加速度，直接接管速度
m.moveBy(dashVX, dashVY, dt);
```

**为什么碰撞用接口注入而不是直接依赖 `collision`**：
铁律是禁止插件间横向依赖，而且不同项目的碰撞方案差异极大
（网格、tilemap、物理引擎、无碰撞），写死一种会让这个模块报废。

---

## 六个关键设计

### ① `update` 里会归一化输入

键盘的 `(1, 1)` 长度是 1.414，不归一化的话**斜着走快 41%**。
这是最经典的手感 bug，玩家只会说"感觉有点飘"，说不出哪里不对。

**⚠️ 但只有长度 > 1 才归一。**
手柄摇杆传来的 `0.3` 表示"轻轻推"，除以长度会把它放大成全速——
模拟量必须保留强度，数字量才归一化。

### ② decel 要显著大于 accel

相同的话，要么"起步肉、刹车也肉"，要么"起步灵、停不住"。
经验值：`decel ≈ accel × 1.5 ~ 2.5`，让刹车比起步更干脆。

### ③ turnBoost：掉头比起步快

输入方向与当前速度反向时，用 `accel × turnBoost` 加速。
不特殊处理的话，从全速向左改成向右要先减速到 0 再加速，
中间有个明显的"卡顿"，玩家会觉得角色不听话。

典型值 3~5。

### ④ 撞墙后必须把速度投影掉

**这是最容易被漏掉、后果又最严重的一条。**

不投影的话：玩家一直推着摇杆顶墙 → 位移是 0，但**速度值持续涨**。
一旦绕过墙角，累积的速度让角色"嗖"地弹射出去。

**表面完全看不出问题**（位置一直贴在墙上），
只在特定几何下触发，极难复现——所以必须有测试锁住。

外力（`_exX/_exY`）同样要投影，否则击退会把角色按在墙上持续施力。

### ⑤ 外力必须衰减，且要限制总强度

- **不衰减**：连续被击退两次就叠成火箭，玩家被弹到地图外，不报错
- **不限制强度**：`addImpulse(30) × 10` 变成 300

`addImpulse` 的第三个参数是强度上限，**缺省 `maxSpeed × 5`**。

> ⚠️ 旧版本这里写的是"建议设为 `maxSpeed × 4` 左右"，而默认参数是 `Infinity`
> （等于完全没有上限）。现在默认值已改成 `maxSpeed × 5`——取 5 而不是 2，
> 是因为常见击退配法本身就是 `maxSpeed` 的 3~5 倍，
> 取 2 会把一次正常强力击退削成挠痒痒，而这个"削"是**看不见的**：
> 没人会想到默认值在削自己。需要真的不设限时，显式传 `Infinity`。

### ⑥ 击退态解除 ≠ 外力归零

这是本模块最容易写错的地方，单独说：

```
外力按指数衰减，从 30 衰减到 0.01 需要约 1.33 秒。
但外力剩 1.5 时，角色每秒只移动 1.5 像素——完全不可感知，
而玩家的**控制权却还被锁着**。
表现为"被击退之后有 1 秒多操作不灵"。
```

所以有两个阈值：

| 阈值 | 管什么 | 默认值 |
|---|---|---|
| `stopEpsilon` | **数值归零**（数学问题） | 0.01 |
| `knockbackThreshold` | **解除击退态**（体感问题） | `maxSpeed × 0.25` |

**混用一个常量，就会多锁将近一秒的操作。**

### ⑦ `knocked` 的判据是"同一帧内的合成力"

进入击退态的条件是**同一帧内**累计施加的冲量超过 `maxSpeed × 0.5`。
"同一帧"这三个字是踩过坑才加上的，两种"多段推力"必须分开看：

| 形态 | 例子 | 跨帧合成？ | 期望 |
|---|---|---|---|
| **同帧多次** | 连击、多重爆炸、弹幕推挤 | ✅ 要合成 | 判击退 |
| **每帧一小次** | 传送带、风力、持续推挤 | ❌ 不合成 | **不**判击退 |

只看单次冲量会漏判（3 次 `addImpulse(2.5)` 合成 7.5，但每次 2.5 < 阈值 3）；
看跨帧合成后的总外力又会误判——持续小外力会收敛到稳态
（每帧 0.5 → 稳态 3.51，每帧 1.0 → 稳态 7.01），**全都超过阈值 3**，
于是玩家一踏上传送带，操作权就从 100% 掉到 `knockbackControl`（默认 0.3），
只要还在上面就一直不恢复。

所以"一帧"由调用方定义：**相邻两次 `update()` 之间**。
调用方应在每帧内先施加冲量、再 `update()`。

---

## 配置

```typescript
new CharacterMover({
  maxSpeed: 6,           // 最高速（单位/秒）
  accel: 60,             // 加速度
  decel: 90,             // 减速度（建议 1.5~2.5 倍 accel）
  turnBoost: 3,          // 掉头加速度倍率
  friction: 0,           // 无输入时的额外摩擦
  externalDamping: 8,    // 外力衰减速率（每秒衰减到 e^-8）
  stopEpsilon: 0.01,     // 数值归零阈值
  knockbackThreshold: 0, // 解除击退阈值（0 = 用 maxSpeed×0.25）
  knockbackControl: 0.3, // 击退期间的输入权重（0~1）
  solver: NullSolver,    // 碰撞解算器
  x: 0, y: 0,            // 初始位置
});
```

**⚠️ `maxSpeed` / `accel` / `decel` 必须为正，构造时即抛错。**
这些是配置错误，不是运行时意外——
等到玩家发现"角色不动了"再去查，成本是几十倍。

---

## 手感预设

```typescript
new CharacterMover({ ...MoverPresets.snappy() });      // 俯视角射击
new CharacterMover({ ...MoverPresets.heavy() });       // ARPG / 魂类
new CharacterMover({ ...MoverPresets.icy() });         // 冰面
new CharacterMover({ ...MoverPresets.platformer() });  // 横版平台
```

实测对比（maxSpeed 统一 6，向右推 1 秒后松开）：

| 预设 | 起步 0.1s | 松手 0.2s | 完全静止 |
|---|---|---|---|
| snappy | 6.00（已满速） | 0.00 | 0.00s |
| platformer | 6.00（已满速） | 0.00 | 0.00s |
| heavy | 2.50 | 0.00 | 0.00s |
| icy | 1.50 | 4.90 | 0.90s |

选哪个不是"哪个更好"，而是"你的游戏要什么"：
魂类要 `heavy`（决策有代价），射击要 `snappy`（容错高）。

---

## API

| 成员 | 说明 |
|---|---|
| `update(dt, dirX, dirY)` | 主循环（⚠️ 缩放时间） |
| `addImpulse(ix, iy, max?)` | 施加外力（击退、爆炸、传送带），`max` 缺省 `maxSpeed × 5` |
| `moveBy(vx, vy, dt)` | 直接接管速度（冲刺用，绕过 maxSpeed） |
| `teleport(x, y)` | 瞬移并清空速度 |
| `stop()` | 只清速度，不动位置 |
| `setVelocity(vx, vy)` | 直接设置速度 |
| `clearImpulse()` | 清空外力与击退态 |
| `destroy()` | 卸载：清空位置、速度与外力（rule5） |
| `x` / `y` | 位置 |
| `speed` / `totalSpeed` | 不含外力 / 含外力的速度大小 |
| `facing` | 朝向（弧度；静止时保持上一次） |
| `knocked` / `blocked` | 是否击退中 / 是否贴墙 |
| `lastNX` / `lastNY` | 上一帧接触法线 |
| `describe()` | 诊断输出 |
| `externalSpeed` | 外力大小（**诊断用**） |
| `hasExternal` | 是否有明显外力在作用 |

> **`hasExternal` 与 `externalSpeed > 0` 不是一回事。**
> 前者按 `stopEpsilon` 判断，后者是原始数值。
> 外力衰减到 0.001 时 `externalSpeed` 仍 > 0，
> 但这时角色每秒只移动 0.001 像素，**完全不可感知**。
> 判断"击退是否结束"用 `hasExternal`，别用 `externalSpeed > 0`。

**`moveBy` 与 `update` 的分工**：
冲刺速度通常远超 `maxSpeed`。如果走 `update`，加速度机制会在冲刺
结束的瞬间把速度"拉回" maxSpeed，玩家感觉冲刺被硬生生截断。
所以冲刺期间用 `moveBy`（mover 只负责位移与碰撞，不干预速度），
冲刺结束后用 `clampSpeed` 收回到正常速度。

### 三个速度工具函数

| 函数 | 说明 |
|---|---|
| `clampSpeed(vx, vy, max)` | 把速度限制在 `max` 内，**按比例缩放** |
| `lerpVelocity(vx, vy, tvx, tvy, t)` | 速度朝目标插值（进/出载具的过渡） |
| `stoppingTime(speed, decel)` | 从当前速度刹停还需多久（AI 预判、刹车距离 UI） |

> ⚠️ **`clampSpeed` 按比例缩放，不是分别 clamp。**
> 分别 clamp 会把斜向速度变成**方形**——
> 斜着跑的速度上限变大了，方向也歪了。
> 这种偏差很小，玩家说不出哪里怪，只会觉得"手感不跟手"。

```typescript
// 冲刺结束：收回超速
[vx, vy] = clampSpeed(vx, vy, cfg.maxSpeed);

// AI 预判：这个距离内它停不住
if (distToLedge < speed * stoppingTime(speed, cfg.decel)) brake();
```

## 坑

| 坑 | 后果 |
|---|---|
| **`dt` 传了 NaN / Infinity** | **角色坐标永久变 NaN，角色消失**（详见下） |
| `dt` 用真实时间 | 暂停时角色还在动 |
| 输入未归一化 | 斜着走快 41% |
| decel = accel | 要么太黏要么太滑 |
| 撞墙不投影速度 | 贴墙走然后突然飞出去 |
| 外力不衰减 | 连续挨打被弹到地图外 |
| 解除击退用 `stopEpsilon` | 多锁 1 秒控制权 |
| 冲刺走 `update` | 冲刺结束被硬截断 |
| 用 `if (!opts.x)` 判断可选布尔 | `undefined` 和 `false` 混为一谈 |

## ⚠️ 异常 dt 被静默丢弃（不是抛错）

```typescript
mover.update(NaN, 1, 0);        // 什么都不做
mover.update(Infinity, 1, 0);   // 什么都不做
mover.update(-1, 1, 0);         // 什么都不做
```

**为什么不抛错地丢弃**：这是全库后果最直观的一处污染。

```
正常移动 10 帧    → x = 0.7066
update(NaN)      → x = NaN
再正常 update 100 次 → x 仍然是 NaN（NaN + 任何数 === NaN）
```

角色**从游戏中消失**，且：

1. 渲染节点位置为 NaN → 角色不见或卡在原点
2. 所有碰撞/距离/拾取判定基于 NaN → 恒为 false → 打不中、走不动、拾不到
3. `vx/vy` 也变 NaN → 任何基于速度的逻辑全废
4. **不抛错、不告警、不可自愈**

`Infinity` 同理（速度变 Infinity，位置爆掉）。负 `dt` 会让角色**倒退**。

**守卫写法必须是 `safeDt(dt)`，不能是 `dt <= 0`**——
`NaN <= 0` 是 `false`，`dt <= 0` 挡不住 NaN。详见 `_core/README.md`。

## 测试抓到的 2 个真 bug

| # | 缺陷 | 现象 |
|---|---|---|
| 1 | **击退态解除复用了 `stopEpsilon`**（已修：新增 `knockbackThreshold`） | 外力剩 0.07 时角色每秒只移动 0.07 像素（完全不可感知），但控制权还锁着。实测（跑了 61 帧，dt=1/60，`maxSpeed=8`、`externalDamping=8`、外力 30）：
外力降到 0.07（完全不可感知）要 0.767s，外力完全归零要 1.017s，
而用 `knockbackThreshold`（= `maxSpeed × 0.25` = 2）时控制权 **0.350s** 就交还了。
若复用 `stopEpsilon`(0.01)，控制权要到 1.017s——**多锁 0.667s**，
正是"被打之后角色不听话"的来源。 |
| 2 | **`_approach` 在接近目标时振荡** | 写成"朝目标走 maxDelta"会在 `d` 略大于 `maxDelta` 时来回过冲，表现为接近最高速时速度在抖。改为 `d <= maxDelta` 时直接赋值 |
