# replay — 输入录制与回放

## 为什么录输入而不是录状态

| | 录状态 | 录输入 |
|---|---|---|
| 体积 | 每帧几十 KB，10 分钟几百 MB | **一局可能就几 KB** |

## 前提条件（重要）

回放要能重现，游戏必须是**确定性**的：

| 要求 | 用哪个插件 |
|---|---|
| 所有随机走带种子的 RNG | `rng/RNG` |
| 不用 `Math.random` / `Date.now` 影响逻辑 | — |
| 帧率不影响逻辑（固定步长） | `scheduler/Scheduler` |

三者缺一，回放就会**漂移**——前 30 秒一致，之后越走越偏。

## 用法

```typescript
// 录制
const rec = new ReplayRecorder({ seed: 12345 });
rec.start();

for (let f = 0; f < 3600; f++) {
  const input = rec.playback(f) ?? pollRealInput();   // 回放优先
  world.step(input, FIXED_DT);
  rec.record(f, input);
}
const data = rec.export();      // 可序列化，几 KB

// 回放
const player = new ReplayRecorder({ seed: 12345 });
player.load(data);
for (let f = 0; f < data.frameCount; f++) {
  world.step(player.playback(f)!, FIXED_DT);
}
```

> 录制中调用 `playback()` 会返回 `undefined`，
> 所以主循环可以统一写 `rec.playback(f) ?? pollInput()`。

## deltaOnly（默认开启）

只在输入**变化**时记一条。玩家按住前进键 300 帧 → 1 条记录而不是 300 条。
能省掉 95% 的体积。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 种子不匹配 | **能播但结果不一样**——你以为回放是对的，实际是错的 | `load` 时校验种子，不匹配直接报错 |
| 版本不匹配 | 输入结构变了，行为诡异 | `load` 时校验 version |
| 只存关键帧不存 frameCount | 最后几秒没操作，回放提前结束 | 导出时带 `frameCount` |
| 想要任意 seek | 做不到（只录输入的固有代价） | 折中：每 N 帧额外存一个状态快照 |
| 无限录制 | 内存撑爆 | `maxFrames` 上限（默认 20 万帧 ≈ 55 分钟） |

## API

| 成员 | 说明 |
|---|---|
| `start()` / `stop()` | 开始/停止录制 |
| `record(frame, input)` | 记录一帧（**frame 必须是固定步长的逻辑帧**） |
| `export(meta?)` / `exportJSON(meta?)` | 导出 |
| `load(data)` / `loadJSON(s)` | 加载（**校验版本与种子**） |
| `playback(frame)` | 取某帧输入。录制中或超范围返回 undefined |
| `seek(frame)` | 跳转（**只能跳到关键帧，精确 seek 需从头模拟**） |
| `playbackDone` / `totalFrames` | 回放状态 |
| `estimateSize()` | 估算体积（字节） |

### 状态查询与清理

| 成员 | 说明 |
|---|---|
| `isRecording` | 是否正在录制（**UI 的录制指示灯**） |
| `isPlaying` | 是否已载入回放数据（`_data !== null`） |
| `recordedFrames` | 已录帧数 |
| `keyframeCount` | 关键帧数（**体积的直接指标**） |
| `reset()` | 清空全部录制数据 |
| `destroy()` | 同 `reset()` |

> ⚠️ **`isPlaying` 的含义是"载入了回放数据"，不是"正在播放"。**
> 回放是**按需取帧**的（`playback(frame)`），没有播放中的状态机。
> 想表达"正在播放"要看你自己的播放循环。

> ⚠️ **重开一局必须 `reset()`。**
> 不重置的话新一局的帧会**追加**到旧数据后面，
> 表现为"回放开头有一段上一局的录像"——而 `recordedFrames` 会一路涨上去。

### 关键帧数量 = 体积

`keyframeCount` 直接决定回放文件大小。玩家**每有一次输入变化**就产生一个关键帧，
所以操作越碎，体积越大。做体积预警时用这个数，别用 `recordedFrames`。
