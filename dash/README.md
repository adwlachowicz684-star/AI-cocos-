# dash — 冲刺控制器

## 它解决什么

冲刺（Dash）是哈迪斯式动作游戏的灵魂。
它同时承担三件事：**位移、无敌帧、取消后摇**。

## 三个关键手感点

### ① 位移必须用衰减曲线，不是匀速

匀速位移看起来像「滑行」，没有爆发感。
正确做法：初速度很高，然后快速衰减。

```
v = v0 · (1 - t/duration)^p     p ≈ 2
```

前 20% 的时间走完 60% 的距离——这就是「冲」的感觉。

### ② 冲刺必须能取消攻击后摇

这是最重要的一条。攻击硬直中玩家按冲刺想跑，
如果被拒绝，角色会「不听话」——**动作游戏最致命的手感问题**。

所以提供 `canCancel()`：几乎任何阶段都能触发。

### ③ 无敌帧的时机

无敌帧不是整个冲刺都无敌（那样太强），而是**前中段**（如前 70%）。
末尾留一点破绽，否则玩家会无脑冲刺躲一切。

## 参考数值

| 参数 | 建议 | 说明 |
|---|---|---|
| `distance` | 角色身高的 2~3 倍 | 哈迪斯约 4 米（角色高 1.8） |
| `duration` | 0.18 ~ 0.30s | < 0.15 看不清；> 0.4 有失控感 |
| `invulnerableRatio` | 0.6 ~ 0.8 | 1.0 太强；< 0.5 感受不到 |
| `falloff` | 2 | 1 太平缓；3 几乎瞬移 |
| `exitMomentum` | 0（战斗）/ 0.3（探索） | 0 = 急停，走位精确 |

## 用法

```typescript
const dash = new DashController({
  distance: 4, duration: 0.22,
  invulnerableRatio: 0.7,
  cooldown: 0.6, charges: 2,
});

if (dash.tryStart(dirX, dirY, facingDeg, px, py)) { /* 播音效、生成残影 */ }

// 每帧：先 tick 再取 delta
dash.tick(dt);
if (dash.active) {
  character.x += dash.deltaX;
  character.y += dash.deltaY;
  character.invulnerable = dash.invulnerable;
}
```

**先 tick 再取 delta**——否则拿到的是上一帧的值。

## 零向量处理

摇杆没推 / 方向键没按时传 `(0, 0)`，
不处理会得到 NaN 方向，角色坐标变 NaN。
这种情况用 `fallbackDeg`（通常取角色朝向）。

## 位移曲线为什么这样实现

基础曲线 `s(u) = 1 - (1-u)^(p+1)` 是速度 `v(u) = (1-u)^p` 的积分。
**直接算 s 而不是累加 v**，所以总距离严格等于配置值，
且与帧率无关（1/30、1/60、1/144 都得到相同结果）。

### ⚠️ 末段减速不能对位移打折

早期实现是「末段对位移乘一个递减因子」，
结果位移先冲到 4.26m 又退回 4.03m——**终点处抖一下**。

正确做法：让衰减指数 `p` 在末段**平滑增大**（用 `k²` 保证导数为 0 处连续）。

```
s(u) = 1 - (1-u)^p(u)
ds/du = (1-u)^p · [ p/(1-u) − p'·ln(1-u) ]
```

`p > 0` 且 `p' ≥ 0`，而 `ln(1-u) < 0`，所以中括号内恒为正 → **ds/du > 0**。
速度衰减更快，但位移只增不减。

## 残影

```typescript
shouldSpawnGhost(dash.progress, lastGhostProgress, 0.15);
```

残影是「让冲刺有速度感」的关键，纯视觉但数据来自逻辑层。

## API

| 成员 | 说明 |
|---|---|
| `tryStart(dirX, dirY, facingDeg, px, py)` | 尝试起跳，返回 `boolean` |
| `tick(dt)` | 推进（**先 tick 再取 delta**） |
| `cancel()` | 取消冲刺，返回是否真的取消了 |
| `reset()` / `destroy()` | 重置 / 销毁 |
| `active` | 是否在冲刺中 |
| `deltaX` / `deltaY` | 本帧位移 |
| `invulnerable` | 当前是否无敌（**按 `invulnerableRatio` 算**） |
| `progress` | 0..1 进度 |
| `state` | 状态（`idle` / `dashing` / `cooldown` …） |
| `cooldownLeft` / `chargesLeft` | 剩余 CD / 剩余充能 |
| `ready` | 现在能不能冲 |
| `dashCount` | 累计冲刺次数（**统计用**） |
| `exitVelocity()` | 冲刺结束时的速度（**衔接惯性**） |

```typescript
// 冲刺 UI：两格充能，第三格显示 CD 转圈
for (let i = 0; i < maxCharges; i++) {
  slots[i].fill = i < dash.chargesLeft ? 1 : 0;
}
```

> ⚠️ **`exitVelocity()` 是"冲刺结束该保留多少速度"。**
> 冲刺一结束就把速度清零，玩家会觉得"冲完像撞墙"；
> 保留全部速度又会导致连冲越冲越快。
> 用它做衔接，手感是"冲出去还能滑一小段"。

## 测试

14 项。重点覆盖总距离精确、帧率无关、单调不回缩、无敌帧窗口。

文件：`DashController.ts`
