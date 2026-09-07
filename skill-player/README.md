# SkillPlayer

时间轴驱动的技能播放器。整个库里**最像「轮子」**的插件。

## 为什么值得单独立一个插件

「在什么时间发生什么事」是所有游戏都有的需求：
技能、演出、过场、UI 动画、新手引导、Boss 阶段转换。

做成数据驱动的时间轴后：
- 加一个技能 = 加一份配置，不改代码
- 编辑器可以直接读写它（可视化编辑 + 拖动预览）
- 主项目的技能编辑器直接就有了运行时支撑

## 用法

```typescript
import { Track } from './skill-player/Track';
import { SkillPlayer } from './skill-player/SkillPlayer';
import { Cooldown } from './skill-player/Cooldown';

// 1. 定义技能（纯数据，可存 JSON）
const heavyAttack = new Track({
  duration: 1.2,
  cancellable: true,     // 可被冲刺取消（手感关键）
  cancelAfter: 0.5,      // 0.5 秒后才允许取消
  events: [
    { t: 0.00, type: 'anim',  data: { name: 'attack_heavy' } },
    { t: 0.00, type: 'sfx',   data: { name: 'swing' } },
    { t: 0.35, type: 'hitbox',data: { shape: 'sector', radius: 2.5, damage: 20 } },
    { t: 0.35, type: 'vfx',   data: { name: 'slash_arc' } },
    { t: 0.60, type: 'projectile', data: { speed: 12 } },
  ],
});

// 2. 注册事件处理器
const player = new SkillPlayer();
player.register('anim', (d) => anim.play(d!.name));
player.register('sfx',  (d) => audio.play(d!.name));
player.register('hitbox', (d, ctx) => spawnHitbox(d, ctx as ICaster));
player.register('vfx',  (d) => vfx.play(d!.name));
// 注册你自己的类型 —— 核心代码一行都不用改
player.register('custom_shake', () => camera.shake(0.3));

// 3. 播放
const handle = player.play(heavyAttack, caster);
handle.onEnd = (cancelled) => { if (!cancelled) onSkillComplete(); };

// 4. 每帧推进（dt 必须是缩放后的时间！）
update(dt: number) {
  player.tick(dt);
}

// 5. 中断（被控制技能打断 / 角色死亡）
handle.cancel();
```

## 三个关键设计

### ① 时间源外部注入

`tick(dt)` 的 dt 必须是**经过 timeScale 缩放后的时间**。
这样暂停（scale=0）、慢动作、顿帧全部自动生效，无需额外代码。

> 反例：用 `setTimeout` 排事件 → 暂停时技能还在放。

### ② 事件类型开放注册

内置类型永远不够用。用注册表而不是 switch，
意味着调用方自己扩展，核心代码永远不变。

### ③ 区间查询，不是当前帧匹配

一帧可能跨过多个事件（卡顿、倍速、seek）。
用「当前时间精确匹配」会漏事件——这是时间轴播放器的经典 bug。

## 与美术协作：判定帧对齐

美术给你的标注是「第 15 帧出判定」，你需要换算成秒：

```typescript
Track.frameToTime(15, 30);   // 0.5 秒（30fps）
```

> **判定与动画差 3 帧，玩家就会觉得「打空了」。**
> 这是动作游戏手感的第一杀手，而且程序自己很难发现——
> 因为你知道判定在哪一帧，会不自觉地适应。
>
> 验证方法：录自己的游玩视频，0.25 倍速逐帧看；
> 或者做个调试工具把判定框画出来。

## 序列化

```typescript
const json = track.toJSON();       // { version: 1, data: {...} }
const back = Track.fromJSON(json); // 往返无损

// 保存前校验（一次报出所有错误，不是遇到一个就停）
const errors = Track.validate(data);
if (errors.length > 0) console.error(errors);
```

## Cooldown 的坑

```typescript
// ❌ 乘法：50% 缩减 → 0.5 倍冷却；100% 缩减 → 冷却为 0（无限放技能！）
cd * (1 - reduction)

// ✅ 除法：50% 缩减 → 0.67 倍；100% 缩减 → 0.5 倍（永不为 0）
cd / (1 + reduction)
```

`Cooldown.applyReduction(duration, reduction)` 已实现正确版本。

## 坑清单

- **用 `setTimeout` 排事件** → 暂停时技能还在放
- **t=0 的事件不触发** → 起手特效/音效延迟一帧（约 16ms，打击感可感知）
  → 本实现在 `play()` 时立即触发 t=0 的事件，**循环播放时每一轮回卷也会补发一次**。
  早期只发第一次，于是持续施法/光环类技能"第一轮有音效、之后就哑了"，
  而事件数据本身看起来完全正常
- **旧句柄的 `cancel()` 晚一步执行** → 停掉**已经开始的下一个技能**
  → 现在 `cancel()` 会校验归属：过期句柄自动失效（只标记 `cancelled`，不碰当前轨道）。
  到达路径是动画回调 / 延迟调用 / 网络回包的时序偏差，
  表现为"连续放技能时莫名其妙中断"，只在特定时序下复现
- **`tick(dt)` 传了 NaN** → 这一帧被静默跳过（`step = 0`，播放状态不变）
  → 比让 `_time` 变成 NaN 好（那样所有区间比较恒 false，技能永久卡住），
  但这一帧确实丢了；调用方应自行保证 dt 有限
- **`seek()` 后期待事件被触发** → seek 只用于编辑器预览，不会触发路过的事件
- **冷却缩减用乘法** → 堆满后无限放技能，平衡崩坏
- **帧率换算写死 30fps** → 换帧率判定全错位
- **技能数据硬编码** → 加一个技能要改代码重编译

## API

### Track
| 成员 | 说明 |
|---|---|
| `new Track(data)` | 构造（自动按时间排序） |
| `query(from, to, out?)` | 区间查询（out 可复用，零分配） |
| `toJSON()` / `fromJSON()` | 序列化 |
| `static validate(data)` | 校验，返回全部错误 |
| `static frameToTime(f, fps)` | 帧 → 秒 |
| `progress(time)` | 归一化进度 |
| `cancellable` / `cancelAfter` | 取消窗口 |

### SkillPlayer
| 成员 | 说明 |
|---|---|
| `register(type, fn)` | 注册事件处理器 |
| `play(track, ctx)` | 播放，返回 handle |
| `tick(dt)` | 每帧推进（dt 需缩放） |
| `seek(time)` | 跳转（编辑器预览） |
| `pause()` / `resume()` / `stop(cancelled)` | 控制 |
| `canCancel` | 当前是否可被取消 |
| `unregister(type)` | 反注册事件处理器 |
| `state` | 当前状态（`idle` / `playing` / `paused`） |
| `currentTime` | 当前播放位置（秒） |
| `isPlaying` | 是否在播 |
| `destroy()` | 清空 |

### `SkillHandle`（`play()` 的返回值）

| 成员 | 说明 |
|---|---|
| `cancel()` | 取消这次播放（**过期句柄自动失效**，不会误停新轨道） |
| `cancelled` | 是否已被取消 |
| `pause()` / `resume()` | 单独控制这一条（**多个技能同时播时互不影响**） |
| `time` | 已播时间 |
| `progress` | 0..1 进度 |
| `onEnd?: (cancelled) => void` | 结束回调，**参数区分"正常播完"与"被取消"** |

```typescript
const handle = player.play(heavyAttack, caster);
handle.onEnd = (cancelled) => {
  if (!cancelled) consumeResource();   // 被取消时不该扣蓝
};
```

> ⚠️ **`onEnd` 的 `cancelled` 参数别忽略。**
> 不区分的话，被打断的技能照样扣蓝/进 CD——
> 玩家会觉得「我明明被打断了，为什么蓝没了」。

### Cooldown
| 成员 | 说明 |
|---|---|
| `new Cooldown({duration, charges})` | 构造 |
| `trigger()` | 消耗一个充能，返回是否成功 |
| `tick(dt, speedMul)` | 推进（dt 需缩放） |
| `ready` / `charges` / `progress` / `remaining` | 查询 |
| `normalized` | 归一化进度 0~1（**1 = 就绪**） |
| `reset()` | 立即充满 |
| `static applyReduction(d, r)` | 冷却缩减（除法公式） |

### 类型

```typescript
type SkillState  = 'idle' | 'playing' | 'paused' | 'done';
type TrackEventType = 'anim' | 'hitbox' | 'projectile' | 'sfx' | 'vfx' | 'buff' | 'custom';
```

> ⚠️ **`SkillState` 有 `paused` 这个独立状态。**
> 只判 `playing` / `done` 的话，暂停中的技能会被当成"已结束"——
> 表现为"暂停后技能自己放完了"。

> ⚠️ **`TrackEventType` 是"建议值"不是"枚举约束"。**
> `TrackEvent.type` 的类型是 `TrackEventType | string`——
> 自定义类型随便写。代价是拼错了不报错，
> 表现为"这个轨道事件永远没触发"。

**`TrackEvent`**（时间轴上的事件）：

```typescript
{
  t: number;                          // 触发时间（秒，从技能开始算）
  type: TrackEventType | string;      // 事件类型
  /* 还有载荷字段，见源码 */
}
```

> ⚠️ **`t` 是从技能开始的秒数，不是帧数也不是毫秒。**
> 写 `t: 30` 想表示"第 30 帧"的话，实际是第 30 秒——
> 技能早就放完了，事件永远不触发。

**`CooldownOptions`**：

```typescript
{ duration: number; maxCharges?: number }
```

> ⚠️ **`maxCharges` 省略是 1，不是无限。**
> 想要"多层充能"（比如闪现有 2 层）得显式写 `maxCharges: 2`。

**`EventHandler`**（轨道事件的处理器）：

```typescript
type EventHandler = (data: Record<string, unknown> | undefined, context: unknown) => void;
```

> ⚠️ **`data` 可能是 `undefined`。**
> 轨道事件没配载荷时就是这样——
> 不判空直接解构会抛 `TypeError`。

> ⚠️ **`register(type, handler, overwrite?)` 默认**不允许**覆盖。**
> 重复注册同一个 type 会抛错。
> 想替换（比如开发期热重载）要显式传 `overwrite = true`。

**`SkillPlayerOptions`**：

```typescript
{ ignoreUnknown?: boolean }
```

> ⚠️ **`ignoreUnknown` 默认 false——遇到没注册 handler 的事件会抛错。**
> 这是刻意的"早失败"设计：配表写了 `type: 'sft'`
> （想写 `sfx` 拼错了）时立刻炸，
> 而不是静默跳过让你以为音效播了。
>
> 只在"事件类型本来就可能超出当前版本"的场景（比如热更配表）
> 才打开它。

**`TRACK_SCHEMA_VERSION`**：导出的数据版本号（当前 `1`）。
`TrackData` / `TrackSchema` 是存档用的，
读档时先比对版本，不一致就别硬读。

> ⚠️ **画冷却遮罩必须用 `normalized`，不要用 `progress`。**
>
> 有"冷却缩减"增益时，两者会分叉：
> `progress` 是相对于**施放当时**的冷却长度算的，
> 增益一到期，同一个 `progress` 对应的剩余时间就变了——
> 表现为"遮罩走了一半突然跳回去"。
>
> `normalized` 是 `ready ? 1 : clamp01(progress)`，
> 它保证"就绪时一定是 1"，遮罩不会卡在 99%。

> ⚠️ **`normalized` 在就绪时是 `1`，不是"超过 1 继续涨"。**
> 它被 `clamp01` 夹住了。
> 想判断"是否就绪"用 `ready`，
> 别写 `normalized >= 1`——在充能没满但第一发已就绪时会误判。
