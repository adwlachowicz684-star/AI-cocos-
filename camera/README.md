# camera — CameraShake（震屏）

> ⚠️ **本目录有两个插件，这份只讲 CameraShake。**
>
> 相机跟随看 **[`CameraFollow.md`](./CameraFollow.md)** —— 平滑跟随 / 前瞻 / 死区 /
> 边界钳制 / **maxSpeed 的真实语义**（它夹的是滞后距离，不是速度，见该文档）。
>
> 两者都是孤儿插件事故的重灾区：CameraFollow 曾因测试文件被覆盖而失去测试，
> 后来补回。**改动这个目录时，两份文档要一起看。**

## 它解决什么

打击感的三大件：**顿帧、震屏、粒子**。

震屏让「这一下打得很重」变得可感知——
同样的伤害数字，加震屏和不加震屏，玩家感受到的力量差一倍。

## 零业务依赖

只输出「这一帧相机应该偏移多少」，
不碰相机节点、不碰屏幕。适配层拿到偏移量去设相机位置。

## 三种噪声

| 类型 | 观感 | 适用 |
|---|---|---|
| **`perlin`**（默认） | 平滑、有惯性，像真实震动 | 绝大多数情况 |
| `random` | 高频抖动，生硬 | 电击、故障效果 |
| `decay-sine` | 有节奏的摆动 | 爆炸冲击波、心跳 |

**为什么默认不用 random**：每帧独立随机看起来像「信号不良」，
而不是「被撞了一下」。真实震动是**连续**的。

## 关键设计：衰减 + 频率分离

- **振幅**随时间衰减（指数或线性）→ 震完自然停下
- **频率**保持较高（15~30Hz）→ 有「抖」的感觉

只衰减振幅而不保持频率，会变成缓慢的「飘」——那不是震屏。

## ⚠️ 最重要的坑：震屏不能影响操作

相机偏移了，但**输入方向、瞄准点、UI 都不该跟着偏**。
玩家会觉得「我往左推它往右走」。

所以：

- 只偏移**相机节点**，不偏移世界和输入坐标系
- UI 用独立相机/独立节点，不跟着震
- 提供 `strengthScale` 让玩家在设置里关掉

**最后一条是可访问性需求，不是可选项。**
部分玩家（前庭功能敏感）会因震屏产生晕眩。

## 用法

```typescript
const shake = new CameraShake({ maxOffset: 0.5 });

shake.punch({ amplitude: 0.3, duration: 0.25 });
applyShakePreset(shake, 'crit');

// 每帧（用**未缩放**的 dt）
shake.tick(dt);
camera.setPosition(baseX + shake.offsetX, baseY + shake.offsetY);
```

### dt 要用未缩放的时间

顿帧时游戏时间变慢，但震屏应该照常——
否则顿帧期间震屏也被拉长，变成缓慢的漂移，失去冲击力。

## 预设

| 预设 | 振幅 | 时长 | 频率 |
|---|---|---|---|
| `lightHit` | 0.08 | 0.12s | 30Hz |
| `heavyHit` | 0.22 | 0.20s | 20Hz |
| `crit` | 0.35 | 0.26s | 18Hz |
| `playerHurt` | 0.30 | 0.22s | 22Hz |
| `land` | 0.12 | 0.15s | 16Hz |
| `explosion` | 0.60 | 0.45s | 12Hz |
| `ambient` | 0.04 | 0.50s | 14Hz |

用预设而不是每次手写数值，能让全项目的「重击感」保持一致。

## maxOffset 为什么必须有

多个震源叠加时（连续暴击、连环爆炸）振幅会累加，
不设上限相机会飞出屏幕，玩家瞬间失去视野。

## 方向性震动

```typescript
shake.punch({ amplitude: 0.3, duration: 0.22, dirX: dx, dirY: dy });
```

受击时朝「被击中的反方向」震，能传递方向信息。
不传则是全向随机（爆炸、落地）。

## 确定性

震屏轨迹是**完全确定性**的：给定同一串 `punch` 调用，
任何机器上都产出相同轨迹。

这和本库的 RNG、ReplayRecorder 保持同一哲学——
确定性让回放、测试、录像都能对得上。

需要「真随机」的话，在 `punch` 时传入随机的 `dirX/dirY`。

## `CameraShake` 完整接口

| 成员 | 说明 |
|---|---|
| `punch(p)` | 打一拳（**方向性**：传 `dirX`/`dirY` 则定向，否则全向随机） |
| `addTrauma(amount)` | 按创伤值累加（**0~1，会平方**，更接近"越猛越夸张"） |
| `tick(dt)` | 推进（**用未缩放的 dt**，见上文） |
| `offsetX` / `offsetY` | 本帧平移偏移量（单位同相机坐标），直接加到相机位置上 |
| `offsetRotation` | 本帧旋转偏移量（**度**），加到相机 rotation 上。上限见 `maxRotation` |
| `active` | 是否还在震 |
| `sourceCount` | 当前叠加了几个震源 |
| `strengthScale` | 全局强度倍率（**可读写**）——接无障碍的 `shakeScale` |
| `stop()` | 立即停止 |
| `destroy()` | 释放（**之后不能再 tick**） |

> ⚠️ **`addTrauma` 与 `punch` 是两套机制，别混着用。**
> `punch` 是"打一拳"式的瞬时冲击（有明确时长）；
> `addTrauma` 是创伤值模型（持续衰减，适合"持续受伤"）。
> 同一个 `CameraShake` 上两个都用，叠加行为会变得难以预测。

> ⚠️ **`destroy()` 之后不能再调 `tick()`。**
> 切场景时如果只 `stop()` 不 `destroy()`，
> 内部计时器还在跑——下次 `tick` 会接着算。

> **`strengthScale` 是接无障碍设置的挂钩。**
> `accessibility.shakeScale` 直接赋给它即可：
> 玩家选 "减少动效" 时震屏整体减弱或归零。

> **`sourceCount` 是排查"震屏停不下来"的关键。**
> 它大于 0 说明还有震源没衰减完；
> 一直不降说明有地方在每帧 `punch`。

### 类型

```typescript
type ShakeNoise      = 'perlin' | 'random' | 'decay-sine';
type ShakePresetName = keyof typeof SHAKE_PRESETS;
```

**三种噪声**的选择：

| 噪声 | 手感 | 适合 |
|---|---|---|
| `perlin` | 连续、有"滚动感" | 爆炸、持续震动 |
| `random` | 细碎、高频 | 轻击命中 |
| `decay-sine` | 规律的正弦衰减 | 机械感、电子设备 |

**`ShakePunch`**：

```typescript
{ amplitude, duration, frequency?, dirX?, dirY?, directional?, seed? }
```

> ⚠️ **传了 `dirX`/`dirY` 还必须让 `directional` 为 true**（或省略由模块推断）。
> 只传方向不标 `directional` 的话可能走全向随机分支，
> 表现为"方向性震动时灵时不灵"。

**`CameraShakeOptions`**：

| 字段 | 说明 |
|---|---|
| `strengthScale` | 全局强度倍率（`0` = 关闭）。**接设置面板的震屏滑块**。构造与 setter 都收口到 `0~1` |
| `noise` | 噪声类型 |
| `frequency` | 默认频率 |
| `decay` | 衰减方式：`'exp'`（自然）/ `'linear'`（机械） |
| `maxOffset` | **必须有**，见上文 |
| `maxSources` | 震源数量上限（默认 `32`）。超限时**丢最老的** |
| `rotationScale` | 旋转强度：每 1 单位振幅对应多少度（默认 `6`） |
| `maxRotation` | 旋转偏移上限（度，默认 `3`） |

> ⚠️ **`strengthScale` 是"全局"的，`punch` 的 `amplitude` 是"单次"的。**
> 两者相乘才是实际强度。
> 只在 `punch` 里调强度的话，设置面板的滑块起不到作用。

### 预设：`SHAKE_PRESETS`

```
lightHit   轻击命中：细碎快速
heavyHit   重击命中
crit       暴击：更强且稍长
playerHurt 玩家受击：方向性
land       落地
explosion  爆炸 / Boss 大招
ambient    环境持续震动（地震、瀑布）
```

```typescript
applyShakePreset(shake, 'crit');
applyShakePreset(shake, 'explosion', 0.5);   // 第三个参数是强度倍率
```

> **`ambient` 的 duration 是 0.5 秒但 amplitude 只有 0.04**——
> 它是给"每帧重复触发"用的（地震、瀑布旁），
> 一次调用几乎看不出来。

## 测试

13 项。重点覆盖 strengthScale=0、maxOffset 上限、确定性、方向性。

文件：`CameraShake.ts`
