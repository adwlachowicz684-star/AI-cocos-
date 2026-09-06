# perception — 感知系统（敌人的眼睛和耳朵）

## 它解决什么

敌人什么时候发现玩家？

朴素做法 `if (dist(enemy, player) < 10) chase()` 会让玩家极其难受：

- 隔着墙也能「看见」你
- 从背后走过去它也能立刻察觉
- 一旦进入范围就永久锁定，躲到天涯海角也甩不掉
- 一个怪发现你，全场怪**瞬间**都知道

感知系统把这些拆开：

| 通道 | 特性 |
|---|---|
| **视觉** | 距离 + 视野角度 + 视线遮挡 |
| **听觉** | 声音事件，穿墙但衰减 |
| **记忆** | 目标消失后还记得最后位置一段时间 |
| **警觉度** | 0→1 累积条，满了才进入战斗 |
| **传播** | 同伴**延迟**一段时间后才响应 |

潜行玩法、包抄 AI、背刺手感全建立在这上面。
它是「敌人聪明」和「敌人开挂」的分界线。

## 零业务依赖

它不认识玩家、不认识敌人。感知者与被感知者都只是**带位置的数字 id**。
视线检测用 `ILineOfSight` 接口注入——可接 `fov/` 的 Shadowcasting，也可自己实现。

## 用法

```typescript
import { PerceptionSystem, PerceptionPresets, OpenLineOfSight } from './perception/Perception';

const sys = new PerceptionSystem({
  los: OpenLineOfSight,
  jitter: 0.3,
  allyAlertDelay: 0.8,     // 同伴延迟 0.8 秒才知道
  onEvent: (e) => console.log(e.type, e.selfId),
});

sys.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);   // id, 配置, x, y, facing
sys.addTarget(100, 5, 0);                                    // 玩家

// 每帧
sys.setPosition(1, ex, ey, facing);
sys.setPosition(100, px, py);
sys.tick(dt);

// 发出声音（跑步、开枪、打碎东西）
sys.emitSound(100, px, py, /* intensity */ 1.0, /* radius */ 25);
```

### 查询

```typescript
sys.isAware(1)              // 是否已发现
sys.alertOf(1)              // 警觉度 0~1
sys.targetOf(1)             // 锁定的目标 id，-1 为无
sys.lastKnownPosition(1)    // 最后已知位置（null = 已忘记）
sys.stateOf(1)              // 完整状态（上面几个的底层，一次取全）
```

> ⚠️ **`lastKnownPosition` 在记忆过期后返回 `null`**，
> 而 `stateOf` 里的 `lastKnownX/Y` **仍然有值**（是最后一次看到的坐标，不会被清空）。
>
> 判断"敌人还记不记得玩家在哪"用 `lastKnownPosition` 是否为 `null`；
> 直接读 `lastKnownX/Y` 会拿到过期坐标——
> 表现为"敌人冲向玩家三分钟前的位置"。

`stateOf` 返回 `PerceptionState`：

```typescript
interface PerceptionState {
  alert:            number;   // 警觉度 0~1
  aware:            boolean;  // 是否已达"发现"阈值
  targetId:         number;   // 锁定目标，-1 = 无
  lastKnownX:       number;   // 最后已知位置（**过期不清空**）
  lastKnownY:       number;
  memoryLeft:       number;   // 记忆剩余时间
  visibleTime:      number;   // 连续可见时长（做"确认"延迟）
  suspiciousFired:  boolean;  // suspicious 事件是否已发过
}
```

> **`visibleTime` 是"连续"可见时长，一旦脱离视线就归零。**
> 它存在的意义是做**确认延迟**——看到玩家 0.3 秒才真正发现，
> 避免"擦肩而过就被发现"的僵硬感。
> 用 `alert` 代替的话，反应会瞬间触发。

> **`suspiciousFired` 防止"察觉"事件每帧刷屏。**
> 它只在 `alert` 归零时重置，所以同一次发现过程只提示一次。
> 自己用 `alert > 阈值` 做判断的话会每帧触发——
> 表现为敌人一直重复播放转头动画。

### 刺激：`Stimulus`

```typescript
type StimulusType = 'sight' | 'sound' | 'damage' | 'ally-alert';

interface Stimulus {
  type:     StimulusType;
  sourceId: number;   // 来源实体（听觉/伤害时是发出者）
  x, y:     number;   // 世界坐标
  strength: number;   // 强度 0~1
}
```

**强度典型值**：走路 0.2 / 跑步 0.6 / 开枪 1.0 / 爆炸 1.0。
视觉刺激的强度由**可见度**决定（距离、角度、遮挡）。

> ⚠️ **`damage` 是无条件察觉**，不看强度。
> 挨打了还不知道被谁打的，是最让玩家困惑的体验之一。
>
> **`ally-alert`（队友警报）是主动调用才有的**——
> 本模块不会自动传播。想做"一个发现，全队警戒"，
> 要在 `spotted` 事件里手动给附近的同伴推一个 `ally-alert` 刺激。

### 事件：`PerceptionEvent`

| 类型 | 何时 | 附带 |
|---|---|---|
| `spotted` | **首次**发现目标 | `targetId` + 位置 |
| `lost` | 目标离开感知（进入记忆） | `targetId` + 最后位置 |
| `forgot` | 记忆彻底过期（回去巡逻） | `targetId` |
| `suspicious` | 被刺激影响但还没发现 | **只有位置，没有 targetId** |

> ⚠️ **`suspicious` 事件没有 `targetId`**——因为还没确认是谁。
> 它给的是"去哪儿看看"的坐标（敌人转头、走过去查看）。
> 写成 `event.targetId` 会拿到 `undefined`。

> **四个事件的用途不同**：
> `spotted` 进战斗、`lost` 开始搜索最后位置、
> `forgot` 回巡逻、`suspicious` 播"察觉"表现。
> 只处理 `spotted` 的话，敌人发现玩家后一失去视线就呆立不动。

### 配置

**`PerceiverConfig`**（每个感知者）：

| 字段 | 说明 |
|---|---|
| `sightRange` | 视距 |
| `sightHalfAngle` | 视野**半角**（弧度） |
| `proximityRange` | **贴脸必定发现**的距离（背后贴身也能察觉） |
| `hearingScale` | 听觉灵敏度倍率 |
| `alertGain` / `alertDecay` | 警觉度上升 / 衰减速率 |
| `memoryTime` | 失去目标后的记忆时长 |

**`PerceptionSystemOptions`**（系统级）：

| 字段 | 说明 |
|---|---|
| `los` | 视线检测（**注入的接口**） |
| `jitter` | 随机抖动（避免所有敌人同步反应） |
| `awareThreshold` | 警觉度达到多少算"发现" |
| `allyAlertDelay` / `allyAlertRadius` | 队友警报的延迟与范围 |
| `onEvent` | 事件回调 |
| `time` | 系统累计时间（只读） |

> ⚠️ **`sightHalfAngle` 是半角，不是全角。**
> 想要 120° 视野得填 `Math.PI / 3`（60°）。
> 填成 `2π/3` 会变成 240° 视野——**比背后还宽**，
> 表现为"敌人背对着也能看见你"。

> **`proximityRange` 是绕过视野的兜底**。
> 没有它的话，贴着敌人背后走他毫无反应，
> 这是潜行游戏里最出戏的 bug 之一。

### 强制覆盖（剧情 / 作弊检测）

| 方法 | 说明 |
|---|---|
| `forceSpot(selfId, targetId, x, y)` | **强制发现**（剧情触发：守卫正好回头） |
| `forceForget(selfId)` | 强制遗忘（玩家躲进柜子、用了隐身） |

> 这两个是**剧情与调试**用的。
> 正常感知走 `tick(dt)`，不要拿 `forceSpot` 当"提高警觉度"用——
> 它绕过警觉度累积，直接跳到"已发现"，玩家会觉得莫名其妙。

### 增删（换关卡时）

`addPerceiver` / `addTarget` 之后，对应地有：

```typescript
sys.removePerceiver(id);
sys.removeTarget(id);
```

> ⚠️ **实体死了一定要移除。**
> 不移除的话 `_perceivers` 会一直持有已销毁实体的位置，
> `activeCount` 只增不减——表现为「换了几关之后感知越来越卡」。

## 四个预设

| 预设 | 特点 |
|---|---|
| `humanoid` | 半圆视野，中等警觉——标准人形敌人 |
| `sentry` | 视野远而窄，需要转身扫描 |
| `turret` | 全向，听力为 0——炮台、眼睛类 |
| `brute` | 反应慢，但记住你很久 |

## 关键设计

### 为什么同伴警报要延迟

立即传播 = 玩家一被发现，整个营地瞬间扑上来。
玩家会觉得「这游戏敌人会读心」。

给 0.5~1.5 秒延迟，玩家能听到敌人喊叫、看到它们**陆续**反应——
这个「陆续」就是紧张感的来源。

### 感知抖动（jitter）

没有抖动时，一排哨兵会在同一帧集体转身，看起来像机器而不是一群人。

默认 0.3（可见度 ±30%）。**它用 `Math.random` 而不是注入的 rng**——
抖动只影响观感，不需要可复现，也不该消耗 rng 序列
（否则会打乱其他依赖 rng 的逻辑，让回放对不上）。

### 声音衰减：近场不打折

```
响度
 1.0 ┤━━━━┓
     │    ┗━━┓
     │       ┗━━━┓
 0.0 ┼───────────┗━━━
     0   近场    radius
```

半径内侧 10% 视为**近场**，响度不打折；超出后按二次曲线滚降。

对应函数可以直接用：

```typescript
soundFalloff(dist, radius)   // → 0..1 的响度
```

**为什么需要近场**：完全连续的衰减曲线下，
「贴脸开枪」的响度是 0.99972，仍 < 1.0 的察觉阈值——
差 0.00028 却导致「贴着敌人开枪它也不理你」。
这种浮点边界问题极难排查：单看每个数字都合理，合起来结果完全错误。

## 坑

1. **视觉路径也要发 `suspicious` 事件**——只发 `spotted` 的话，
   「敌人转身看向玩家」这类最重要的预警表现没有触发时机。
2. **`aware` 时不要求 `alert === 1`**——记忆期内敌人一直在搜索，
   而警觉度会衰减。这是正确的设计，别写反了断言。
3. **朝向用弧度，0 = +X 方向**——和 `hitbox`、`dash` 保持一致。
