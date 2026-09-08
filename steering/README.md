# steering — 转向行为（单体 + 群体 boids）

## 为什么不用"直接设速度朝目标"

那样所有单位会**挤成一坨**，而且到达时会**抖动**（冲过头再折返）。

## 核心设计：输出"转向力"，不是速度

每个行为返回一个**力**（加速度），多个行为的力加权相加，
再由调用方积分成速度。

好处：
1. 多个行为平滑叠加，不会互相覆盖
2. 用 `maxForce` / `maxSpeed` 限制，行为自然
3. **本库不碰 dt**，调用方完全掌管物理积分

## 单体行为

| 行为 | 用途 |
|---|---|
| `seek` | 全速接近。**不要在到达时用**，会抖动 |
| `flee` | 逃离（带恐慌距离） |
| **`arrive`** | **到达，带减速。日常用这个** |
| `pursuit` | 追击，预判目标未来位置（抄近路拦截） |
| `evade` | 预判版逃跑 |
| `wander` | 游荡（伪随机但平滑） |
| `obstacleAvoid` | 反应式避障 |

```typescript
const agent = createAgent(v2(0, 0), v2(), { maxSpeed: 100, maxForce: 200 });

applyForce(agent, arrive(agent, targetPos, 50));
integrate(agent, dt);
```

## 群体行为（boids）

三条经典规则加权叠加：

1. **分离** separation — 太挤了就散开
2. **聚集** cohesion — 离群了就靠拢
3. **对齐** alignment — 和邻居保持同向

```typescript
const flock = new Flock({
  separationRadius: 15,
  cohesionRadius: 60,
  separationWeight: 1.5,
  fieldOfView: Math.PI * 1.5,   // 背后的同伴不影响行为
});

for (const a of agents) applyForce(a, flock.compute(a, agents));
for (const a of agents) integrate(a, dt);
```

**邻居查询请用 `SpatialHash` 或 `QuadTree`**，
不要用 O(n²) 两两比较（100 个单位就是 10000 次）。

**实测（8 单位 × 8 个种子，`Flock` 默认参数，3 秒 @60fps = 180 帧，初始散布 ±50）：**

| 配置 | 末帧最近间距（8 种子） | 均值 |
|---|---|---|
| **有分离**（`separationWeight=1.5`，默认） | 12.33 ~ 19.60 | **17.64** |
| **无分离**（`separationWeight=0`） | 0.03 ~ 1.22 | **0.37** |

关掉分离后单位会挤成一团（间距趋向 0），开启后稳态间距维持在 17.6 量级
——大致等于 `separationRadius` 默认值 20 的 88%，符合预期。

> #### ⚠️ 这个 17.64 **依赖初始条件**，换条件会得到完全不同的数
>
> 2026-09-06 引擎实测（Cocos Creator 3.8.8）在另一套初始条件下测出 **92.49**，
> 与这里的 17.64 差 5 倍。经 Node 侧复现比对，**积分方式一致，不是 bug**——
> 差在"单位密度"：
>
> | 初始条件 | 区域 | 有分离均值 | 无分离均值 | 分离力是否可见 |
> |---|---|---|---|---|
> | **聚拢**（0~50 散布） | 600×600 | **15.66** | 0.25 | ✅ **差 60 倍，效果显著** |
> | **散开**（100~900 散布） | 1000×1000 | 76.90 | 74.43 | ❌ **几乎无差异** |
>
> 同一套 LCG、8 单位 × 8 种子 × 180 帧，只改初始分布。
>
> **为什么散开时分离力"看不见"**：`separationRadius` 默认 **20**，
> 而 8 个单位散在 1000×1000 里平均间距约 350——**远超感知半径**，
> 彼此根本不在邻居范围内，分离力恒为 0。
>
> **更关键的是：散开时它们压根不会聚拢。** 继续跑到 60 秒：
>
> | 帧数 | 有分离 | 无分离 |
> |---|---|---|
> | 180（3 秒） | 76.90 | 74.43 |
> | 1800（30 秒） | 92.35 | 84.48 |
> | 3600（60 秒） | 104.39 | 91.92 |
>
> 间距**不降反升**，说明 cohesion 也没克服初始散布。
> **散开的初始条件测不出分离力，只能测出"还没聚拢"这个中间态。**
>
> **结论**：要验证分离力，必须用**单位密度足够高**的初始分布
> （初始间距 ≲ `cohesionRadius` 默认 60）。
> 上面 17.64 用的是 0~50 散布，符合这个要求，是**稳态值**；
> 引擎实测的 92.49（8 单位 × 8 种子 × 180 帧，100~900 散布）用的是散开条件，
> 是**未收敛态**，两者不可直接比较。
>
> 【顺带纠一处我自己的推理】
> 我曾写"无分离组会重叠到 <2.5，证明分离力确实在起作用"——
> 这个推理只在**聚拢条件**下成立。散开条件下无分离组也不重叠
> （Node 实测最小 8.17，8 单位 × 8 种子 × 180 帧，100~900 散布），因为它们根本没靠近过。
> **"没重叠"不等于"分离力生效"。**

> **⚠️ 这个数字被修正过。**
>
> 上一版写的是"最近间距**保持在 1.77**"。
> 实测稳态是 **17.64**（8 单位 × 8 种子 × 180 帧）——**恰好差 10 倍**，极可能是小数点位置写错。
>
> 更麻烦的是原话没标样本量和初始条件，所以无法复现、无法发现它是错的。
> **文档里每个实测数字都必须标样本量**（见 `scripts/check-measured-numbers.py`）。

## 物理积分

```typescript
applyForce(agent, force);   // 累加
integrate(agent, dt);       // 力 → 加速度 → 速度 → 位置，**并清零力**
constrain(agent, 0, 0, 800, 600, bounce);
```

### ⚠️ integrate 必须清零力

不清的话下一帧力会累积，单位越跑越快直到飞出地图。
`integrate` 内部已经做了，但如果你自己写积分，**别忘这一步**。

## 坑

### ① 撞墙要回退位置，不是只反向速度

```typescript
// ❌ 错：单位已经在墙里了，下一帧还从墙里出发
if (!walkable(x, y)) { vx *= -0.5; }

// ✅ 对：先回退到撞墙前，再处理速度
const px = pos.x, py = pos.y;
integrate(agent, dt);
if (!walkable(pos.x, pos.y)) { pos.x = px; pos.y = py; vx *= -0.3; }
```

只反向速度会让单位卡在墙里反复横跳，看起来像穿墙。

### ② obstacleAvoid 在障碍正前方时失效

`ahead` 恰好落在障碍中心 → 差向量是 (0,0) → `normalize` 返回 (0,0) → **避障力为 0**。

这是最容易遇到的情况（正面撞墙），却是最先失效的情况。
本库已修复：零向量时改用"垂直于前进方向的侧向力"。

### ③ wander 不要用"每帧随机改方向"

会产生高频抖动，看起来像抽搐。本库在速度前方放一个圆，
在圆周上**缓慢移动**一个点，转向就平滑了。

### ④ obstacleAvoid 是反应式的，不是寻路

复杂地形（凹形陷阱）会卡住，那种情况该用 A*。
它的价值是配合寻路处理路径上的小障碍，让移动不生硬。

## 队形

```typescript
formationOffset(index, spacing, columns);    // 网格阵型（RTS 编队）
circleFormation(index, count, radius);       // 环绕阵型（保护中心）
```

目标 = 队伍中心 + 自己的偏移，然后对每个单位自己的目标点做 `arrive`。

## API

### Agent
`{ pos, vel, force, maxSpeed, maxForce, mass, radius }`
`createAgent(pos, vel?, opts?)`

### 单体
`seek(agent, target)` / `flee(agent, threat, panicDist?)`
`arrive(agent, target, slowRadius?, stopRadius?)`
`pursuit(agent, targetAgent, lookAhead?)`
`evade(agent, pursuer, lookAhead?)`
`wander(agent, state, circleDist?, circleRadius?, angleChange?, rand?)`
`obstacleAvoid(agent, obstacles, lookAhead?)`

### 群体
`new Flock(opts)` → `compute(self, neighbors)`

### 物理
`applyForce` / `integrate(agent, dt, maxSpeed?)` / `constrain(...)`
`clearForce(agent)`（`integrate` 会自动调）
