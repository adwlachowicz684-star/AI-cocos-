# camera/CameraFollow · 相机跟随

> 本目录下的 `README.md` 讲 CameraShake，这份讲 CameraFollow。
>
> ⚠️ **写完代码必须同时完成三件事**：① 测试 ② README ③ 登记进 `_kitmeta.json`
> 本插件曾因测试文件被覆盖而变成孤儿，第五次同类事故。

---

## 它解决什么

`camera.x = player.x` 是能跑的，但玩起来很难受：

- 角色每次微调方向相机都跟着动，画面抖得让人眼晕 → 需要**死区**
- 高速跑时右侧空间不够，来不及反应 → 需要**前瞻**
- 地图边缘露出黑边 → 需要**边界钳制**
- 回城时相机掠过大半个地图 → 需要**瞬移检测**

## 用法

```typescript
const f = new CameraFollow({
  deadZone: { x: 60, y: 40 },     // 屏幕宽度的 8%~15%
  smoothTime: 0.2,                // 0.15~0.3，0 = 硬跟随
  lookAheadFactor: 0.5,
  lookAheadMax: { x: 120 },
  bounds: computeCameraBounds(mapRect, viewW, viewH),
  teleportThreshold: 500,
});

// 每帧
const s = f.update(dt, player.x, player.y, player.vx, player.vy);
camera.setPosition(s.x, s.y);

// 震屏叠加在跟随之"上"
f.addOffset(shakeX, shakeY);
```

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **首次 update 直接吸附** | 不吸附的话第一帧相机会从 (0,0) 飞向角色，表现为"进游戏时画面从地图角落滑过来" |
| **bounds 传的是相机中心的范围，不是地图边界** | 直接传地图边界会露出黑边。用 `computeCameraBounds()` 换算 |
| **地图比视口小时要取中点** | `clamp(v, min, max)` 在 max < min 时返回 max，相机会贴在角落 |
| **maxSpeed 限制的是滞后距离不是速度** | smoothDamp 沿用 Unity 语义，夹的是 `current - target`。目标瞬移 10000 时相机一帧就跳到只剩 1 像素——所以本模块在末尾又夹了一次真实位移 |
| **瞬移后要清阻尼记忆** | 否则相机会继续朝原方向漂移一段 |
| **dt ≤ 0 不推进** | 切后台回来、时间校准都可能给负 dt |

## 完整接口

| 成员 | 说明 |
|---|---|
| `update(dt, tx, ty, vx?, vy?)` | 每帧推进，返回 `FollowSnapshot` |
| `x` / `y` | 相机当前位置 |
| `lookAheadX` / `lookAheadY` | 前瞻偏移量（**按速度方向提前一点**） |
| `inDeadZone()` | 目标是否在死区内（在死区内相机不动） |
| `bounds()` / `setBounds(b)` | 边界（**是相机中心的范围**，见坑表格） |
| `snapTo(tx, ty)` | 瞬移到位并**清阻尼记忆** |
| `addOffset(ox, oy)` | 叠加外部偏移（**震屏加在这里**） |
| `reset()` | 回到初始状态 |

> ⚠️ **`snapTo()` 不只是"移动到位"，它还会清阻尼记忆。**
> 直接改 `x`/`y` 或传一个大 `teleportThreshold` 也能瞬移，
> 但相机会**继续朝原方向漂移一段**——
> 表现为"传送后镜头自己又滑了一下"。
> 这是坑表格里"瞬移后要清阻尼记忆"那条的正规解法。

> ⚠️ **`addOffset` 是叠加"在跟随之上的偏移"，不是改跟随目标。**
> 震屏必须走这里。写进目标坐标的话，
> 死区和前瞻会一起跟着抖，手感完全不对。

> **`inDeadZone()` 是做"角色小范围移动时镜头完全不动"的。**
> 死区太小会让画面持续微动（晕），
> 太大则角色走出屏幕才追。推荐屏幕宽度的 8%~15%。

### `FollowSnapshot`

`update()` 的返回，包含本帧的位置、前瞻偏移、
是否命中边界、是否在死区内等信息。

> **每帧用 `update()` 的返回值，别读 `x`/`y` 再自己算。**
> 返回值里已经包含了前瞻和边界钳制的结果。

### 类型

```typescript
interface Vec2 { x: number; y: number }
```

**`FollowOptions`**：

| 字段 | 说明 |
|---|---|
| `deadZone` | 死区半宽 / 半高（`Partial<Vec2>`，只填一个轴也行） |
| `smoothTime` | 平滑时间（秒）。`0.15~0.3`，**`0` = 硬跟随** |
| `lookAheadFactor` | 前瞻系数（按速度提前量） |
| `lookAheadMax` | 前瞻上限（`Partial<Vec2>`） |
| `bounds` | 相机中心的可行范围（**不是地图边界**，见坑表格） |
| `teleportThreshold` | 超过这个距离判定为瞬移 |
| `maxSpeed` | 限制滞后距离（**不是速度**，见坑表格） |

> ⚠️ **`smoothTime` 填 `0` 是合法的，表示硬跟随（相机锁死角色）。**
> 想要"跟得很紧"就填一个很小的值（如 `0.05`），
> 填 0 会完全失去平滑，角色任何抖动都直接传给画面。

> ⚠️ **`maxSpeed` 这个名字是误导性的。**
> 它沿用 Unity `smoothDamp` 的语义，夹的是**滞后距离**
> （`current - target`），不是每帧位移。
> 目标瞬移 10000 像素时，相机一帧就跳到只剩 `maxSpeed` 的距离——
> 本模块在末尾又夹了一次真实位移来兜底。

**`FollowSnapshot`**（`update()` 的返回）：

```typescript
{ x, y, lookAheadX, lookAheadY, inDeadZone, ... }
```

> 位置已包含前瞻与边界钳制。**渲染直接用它**。

## 帧率无关性

`lerp(a, b, 0.1)` 是帧率相关的：120Hz 下跟随比 60Hz 紧一倍。
这是很多"感觉不对但说不上来"的手感问题的根源。

本模块用 `smoothDamp`（dt 参与计算），有测试验证
60fps 跑 1 秒与 240fps 跑 1 秒的结果一致。

## 测试

**32 项**，覆盖吸附、死区、前瞻上限、瞬移、边界（含 max<min）、
帧率无关性、addOffset 叠加、maxSpeed。
