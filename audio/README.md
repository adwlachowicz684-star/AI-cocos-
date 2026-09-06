# audio · 音频

两个独立模块：`AudioManager`（音效）与 `BGMStack`（分层背景音乐）。

```typescript
import { AudioManager, PRIORITY } from './audio/AudioManager';
import { BgmStack } from './audio/BGMStack';
```

- 依赖：`_core/math`
- 引擎耦合：**无**（播放由调用方接引擎的 AudioSource）
- 测试：39 项

---

## AudioManager · 音效

### 它解决什么

朴素写法 `audio.play('hit')` 的四个坑：

**1. 同帧叠加爆音** — 5 个怪同时被击中，波形叠加后音量爆表。

**2. 并发上限** — 30 个音效占满通道，**关键音效反而排不上队**。
预警音被爆炸声挤掉 = 玩家死得莫名其妙。

**3. 优先级** — 解法不是限制总数，而是"重要的先播"。

**4. 音量混合** — 主音量 × 分类音量 × 单次音量。
拖滑块时正在播的音效也要跟着变，所以**不能缓存**，查询时才合成。

### 用法

```typescript
const audio = new AudioManager({
  maxVoices: 32,
  maxSameSoundPerFrame: 3,
  categoryVolumes: { sfx: 0.8, ui: 1, bgm: 0.6 },
});

// 主循环（用真实时间，暂停时延迟音效才不会卡住）
audio.update(Date.now());

// 播放
audio.play('explosion', { priority: PRIORITY.HIGH, category: 'sfx' });

// 预警音必须是最高优先级
audio.play('telegraph', { priority: PRIORITY.CRITICAL });

// 密集触发去重（机关枪、连续命中）
audio.play('machinegun', { dedupeMs: 60 });

// 查询实际音量（不缓存，随时反映滑块变化）
const v = audio.effectiveVolume(handle.id);
```

### 优先级常量

| 常量 | 值 | 用途 |
|---|---|---|
| `AMBIENT` | -20 | 环境音、脚步 |
| `LOW` | -10 | 一般打击、UI |
| `NORMAL` | 0 | 默认 |
| `HIGH` | 10 | 爆炸、技能 |
| `CRITICAL` | 20 | **预警音** |

### 抢占规则

1. 只抢优先级**更低**的（同级不抢，避免抖动）
2. 同级里抢**最早开始**的
3. **循环音效不抢**（它是持续状态，抢掉会听出来"断了"）

### 坑

| 坑 | 后果 |
|---|---|
| `update` 用了游戏时间 | 暂停时延迟音效永远不触发，恢复后一次性涌出 |
| 预警音没设 CRITICAL | 被爆炸音挤掉，玩家死得莫名其妙 |
| 缓存 `effectiveVolume` | 拖了音量滑块但正在播的音效没变 |
| 场景切换忘了 `stopAll()` | 上个场景的循环音效跟着进新场景 |
| `maxVoices` 设得比引擎通道数大 | 超出后行为不可预测（不是排队） |

### 排查"音效听不见了"

```typescript
console.log(audio.describe());
// 活跃 8/8  待播 0
// 被拒 19（通道满且无可抢占）  去重 0  抢占 1
```

一眼区分是"没调用"还是"被拒了"。

### `AudioManager` 完整接口

| 成员 | 说明 |
|---|---|
| `update(now)` | 用**真实时间**推进（见坑表格） |
| `tick(deltaMs)` | 按增量推进（与 `update` 二选一） |
| `now()` / `frame()` | 当前时间与帧号 |
| `play(soundId, opts?)` | 播放，返回 `AudioHandle \| null`（**被拒时是 null**） |
| `stop(id)` | 按句柄 id 停 |
| `stopSound(soundId)` | 按 soundId 停**所有**同名实例，返回停掉的数量 |
| `stopCategory(cat)` | 停一整类，返回停掉的数量 |
| `stopAll()` | 全停 |
| `setMasterVolume(v)` / `masterVolume` | 主音量 |
| `setCategoryVolume(cat, v)` / `getCategoryVolume(cat)` | 分类音量 |
| `effectiveVolume(id)` | 该实例的**实际**音量（主 × 分类 × 实例） |
| `activeCount` / `pendingCount` | 活跃数 / 待播数 |
| `countByCategory()` | 各分类分别占了几条 |
| `active` | 全部活跃句柄 |
| `isPlaying(soundId)` | 该 soundId 是否正在播 |
| `stats()` / `resetStats()` | 统计（被拒 / 去重 / 抢占次数） |
| `describe()` | 一行诊断文本 |

> ⚠️ **`play()` 被拒时返回 `null`，不是句柄。**
> 不判空直接用 `handle.id` 会抛 `TypeError`——
> 而且在通道刚好占满时才复现，测试环境很难撞上。

> ⚠️ **`stopSound` / `stopCategory` 返回的是"停掉了几条"，不是布尔。**
> 返回 `0` 表示没有匹配项（可能是 id 拼错了）。
> 当布尔用的话 `if (audio.stopSound('bgm'))` 恒为 false（0 是假值）——
> 表现为"写了停止代码但从没执行过"的错觉。

> **`effectiveVolume` 要实时取，别缓存。**
> 玩家拖音量滑块时，正在播的音效要跟着变。
> 缓存了就是坑表格里"拖了滑块正在播的没变"那一条。

> **`countByCategory()` 是排查"某类音效把通道占满"的关键。**
> 战斗音效把 8 条通道全占了，UI 音效就永远被拒——
> 光看 `activeCount === 8` 看不出是谁占的。

---

## BGMStack · 分层背景音乐

### 它解决什么

"探索放 A、战斗放 B"的切歌式做法：

- **切换点突兀** — 音乐比画面早三秒，出戏
- **做不出层次** — Boss 血线 30% 该更紧张，但你只有两首歌

分层音乐（horizontal re-mixing）：一首曲子拆成若干层，
所有层**同步播放、同一 BPM**，按游戏状态决定每层多响。

### 用法

```typescript
const bgm = new BgmStack({
  layers: [
    { name: 'drums' },
    { name: 'bass' },
    { name: 'melody' },
    { name: 'choir', baseVolume: 0.5, alwaysOn: false },
  ],
  states: {
    explore: { drums: 0.5, bass: 0.3, melody: 1.0, choir: 0 },
    battle:  { drums: 1.0, bass: 0.8, melody: 0.6, choir: 0 },
    climax:  { drums: 1.0, bass: 1.0, melody: 0.3, choir: 1.0 },
  },
  initialState: 'explore',
  transitionMs: 800,
});

bgm.update(dtMs);        // ⚠️ 用真实时间，顿帧时音乐不该变慢 20 倍
bgm.setState('climax');
const v = bgm.layerVolume('choir');   // 交给引擎的 AudioSource
```

### 等功率交叉淡变

默认 `curve: 'equal-power'`，在**功率域**插值：

```
amplitude = √(from²·cos²θ + to²·sin²θ)
```

三种情况都成立：
- `from=1, to=0` → `cos θ`（标准 fade-out）
- `from=0, to=1` → `sin θ`（标准 fade-in）
- `from=0.5, to=0.5` → `0.5`（不变的层保持恒定 ✓）

**⚠️ 不能在"插值系数"上加曲线。** fade-out 层要 `k=1-cosθ`，
fade-in 层要 `k=sinθ`，单个 k 无法同时满足。
直接在系数上做曲线，两层都保持 0.8 的过渡会让音量中间涨到 1.13。

### 坑

| 坑 | 后果 |
|---|---|
| `update` 用了缩放时间 | 顿帧时音乐变慢 20 倍，像恐怖片音效 |
| 每帧调 `setState(当前状态)` | 早期版本会重启过渡，音量卡在 0（现已修：同状态一律返回 false） |
| 用 linear 曲线 | 过渡中间音量"变轻一下"，听感很廉价 |
| 配置漏了一格 | 表现为"某个状态下少了一层"，会去翻音频文件而不是配表 → 用 `validate()` |
| 层没设 `alwaysOn: false` | 静音的层一直占着音频通道 |

### 配表检查

```typescript
const issues = bgm.validate();
// ["状态 "battle" 缺少层 "choir" 的定义（将按 0 处理）"]

console.log(bgm.describeMatrix());   // 状态 × 层 的矩阵
```

### `BgmStack` 完整接口

| 成员 | 说明 |
|---|---|
| `setState(next)` | 切状态，返回是否真的切了（同状态返回 false） |
| `state` / `previousState` | 当前 / 上一个状态 |
| `inTransition()` | 是否在淡变中 |
| `transitionProgress()` | 淡变进度 0~1 |
| `update(dtMs)` | 推进淡变 |
| `layerVolume(name)` | 某一层**当前**的目标音量 |
| `layers()` | 全部层的状态 |
| `playingLayers()` / `silentLayers()` | 正在出声的层 / 静音的层 |
| `outputLevel()` | 总输出电平（**做音量表用**） |
| `setVolume(v)` / `volume` | 总音量 |
| `validate()` | 配表检查，返回问题列表 |
| `describeMatrix()` | 状态 × 层 的矩阵文本 |

> ⚠️ **`setState` 传当前状态返回 `false` 且不做任何事。**
> 想"重启当前状态的淡变"它不管——
> 要先切到别的状态再切回来。

> **`playingLayers()` vs `silentLayers()` 是排查配表的关键。**
> 期望战斗时 `choir` 在响，它却出现在 `silentLayers()` 里——
> 立刻知道是配表漏了（对应 `validate()` 报的那条），
> 而不是去翻音频文件。

> **`outputLevel()` 是做音量表（VU 表）用的**，
> 它反映所有层叠加后的实际电平。
> 拿 `volume` 画表的话，滑块动一下表就跳，看不出淡变过程。

### 类型

| 类型 | 说明 |
|---|---|
| `AudioCategory` | 音效分类（ui / sfx / bgm / voice …） |
| `AudioPriority` | 优先级常量（`LOW` / `NORMAL` / `HIGH` / `CRITICAL`） |
| `PlayOptions` | `play()` 的选项（音量 / 循环 / 延迟 / 优先级 …） |
| `AudioManagerConfig` | 构造配置（`maxVoices` / 分类默认音量 …） |
| `LayerName` / `StateName` | BGM 的层名与状态名（**由你的配表决定**） |
| `BgmLayerConfig` / `StateMix` | 层配置与状态混音表 |

> ⚠️ **`LayerName` 和 `StateName` 不是固定的枚举**，
> 它们由你传给 `BgmStack` 的配表决定。
> 写错层名不会报错——表现为"某个状态下少了一层"，
> 这正是 `validate()` 存在的理由。

> ⚠️ **`maxVoices` 别设得比引擎实际通道数大。**
> 超出后行为不可预测（**不是排队**）。
> 详见坑表格。

### `AudioHandle`（`play()` 的返回）

```typescript
interface AudioHandle {
  id:         number;          // 实例 id（stop(id) 用这个）
  soundId:    string;          // 资源 id
  category:   AudioCategory;
  priority:   AudioPriority;
  startedAt:  number;          // 开始时刻
  loop:       boolean;
  stopped:    boolean;         // 是否已停止
  baseVolume: number;
  pitch:      number;
  pan:        number;
}
```

> ⚠️ **`stop()` 要传 `handle.id`（实例 id），不是 `soundId`。**
> 传错会静默失败——`stop()` 返回 `false`，
> 而循环音效会一直播下去。

> **`stopped` 为 true 的句柄已经失效**，别再拿它调 `effectiveVolume`。

### 另外两个

```typescript
interface LayerState {
  name: LayerName; current: number;   // 当前音量
  target: number;  from: number;      // 目标 / 起始（淡变用）
  playing: boolean;
}

interface BgmStackConfig {
  layers:       readonly BgmLayerConfig[];
  states:       Readonly<Record<StateName, StateMix>>;
  initialState: StateName;
  transitionMs: number;
  volume:       number;
}
```

> ⚠️ **`states` 必须覆盖「每个状态 × 每一层」。**
> 漏一格不报错，按 0 处理——
> 表现为"某个状态下少了一层"。
> 排查时用 `validate()` 而不是去翻音频文件。
