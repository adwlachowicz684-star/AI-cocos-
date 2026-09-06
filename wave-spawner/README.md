# wave-spawner — WaveSpawner（波次刷怪）

## 它解决什么

进入房间 → 刷第一波怪 → 打完 → 刷第二波 → 打完 → 开门。

听起来简单，实际是一堆琐事：
一波几个、间隔多久、什么时候开始下一波、
一帧里生成 20 个会不会卡、
**怪卡在地图外了永远清不完门打不开怎么办**。

最后一条是**每个动作游戏都会遇到的 bug**，
而且开发期很难复现（要怪正好卡进墙缝），
上线后一定被玩家撞到，然后卡死在一个房间里。

## 核心承诺：永远不会卡住

三重兜底（⚠️ **开箱只启用第 ① 重**）

| 兜底 | 配置项 | 默认值 | 说明 |
|---|---|---|---|
| ① 波次超时 | `waveTimeout` | **60** ✅ 开箱生效 | 一波打太久就强制进下一波 |
| ② 单体超时 | `entityTimeout` | **0 = 关闭** ⚠️ | 单只怪存在太久就清除 |
| ③ 总超时 | `totalTimeout` | **0 = 关闭** ⚠️ | 整个流程的总时限 |

默认 0 是刻意的（不打扰正常玩法），但**生产环境建议显式开启 ②**——
它能兜住"怪卡在墙缝里"这类只有运行时才会遇到的情况。

【坑】这三个参数对 0 的处理曾经不一致：
`waveTimeout` 传 0 会**每帧都满足超时**（语义反转），
而另两个传 0 是关闭。现在统一为「> 0 才生效」。

，任一触发都会让流程继续：

| 兜底 | 触发条件 | 解决什么 |
|---|---|---|
| **单体超时** `entityTimeout` | 某个实体存活超过 N 秒 | 一波里只有 1 个卡住，玩家追着它满地图跑 |
| **波次超时** `waveTimeout` | 一波超过 N 秒没清完 | 整波卡住 |
| **总超时** `totalTimeout` | 整场超过 N 秒 | 限时挑战的硬上限 |

### 超时怎么设

- `waveTimeout`：正常打完这波的 2~3 倍。一波普通怪通常 20~40 秒，默认 60。
  太短 = 玩家打得慢就被赶着走；太长 = 卡住时要等很久。
- `entityTimeout`：建议设为 `waveTimeout` 的 1/2。
  波次超时只解决"整波卡住"，单个怪卡住需要单独处理。

## 零业务依赖

它不认识「敌人」「怪物」。生成的只是 `entryId`（字符串），
生成动作和存活判定全部通过 `ISpawnSink` 接口注入。

所以同一套波次逻辑能用于：地牢刷怪、塔防出兵、弹幕发射、甚至是"生成掉落物"。

## 用法

```typescript
import { WaveSpawner, type ISpawnSink, type SpawnHandle } from './wave-spawner/WaveSpawner';

const sink: ISpawnSink = {
  spawn(entryId, indexInEntry, waveIndex, data) {
    const enemy = createEnemy(entryId);
    const h: SpawnHandle = { id: nextId++, alive: true, age: 0, waveIndex };
    handles.set(h.id, { handle: h, enemy });
    return h;
  },
  forceKill(h, reason) {
    // 【必须实现】淡出 + 销毁，或把卡住的怪传送到场地中央
    fadeOutAndDestroy(handles.get(h.id).enemy);
  },
};

const ws = new WaveSpawner({
  waves: [
    // preDelay：玩家刚进房间先看清场地，别一进门就被贴脸
    { id: 'w1', entries: [{ id: 'bat', count: 3, interval: 0.25 }], preDelay: 0.4 },
    // delay：远程兵晚点出，给玩家反应时间
    { id: 'w2', entries: [{ id: 'slime', count: 2 }, { id: 'archer', count: 1, delay: 0.6 }] },
  ],
  spawn: sink,
  waveTimeout: 30,
  entityTimeout: 15,
  maxSpawnsPerFrame: 3,
  onAllClear: () => openDoor(),
  onFallback: (info) => reportToServer(info),   // ← 需要报警的信号
});

ws.start();
// 每帧
ws.tick(dt);
```

## 双保险：两种死亡通知都可以

```typescript
// 方式 A：主动通知
ws.notifyDead(handle.id);

// 方式 B：只置 alive = false，spawner 每帧轮询清理
handle.alive = false;
```

**两种方式都支持**。只靠通知的话，业务某处忘了调就永远清不掉——
这是最经典的卡关来源。所以加了轮询兜底。

## ⚠️ 两个必设的参数

### maxSpawnsPerFrame

一波 20 个怪同时生成时，实体创建、组件初始化、寻路计算全挤在一帧，
表现为"进房间时卡一下"。设 3~5 个/帧，玩家看到的是"陆续冒出来"，
**反而更有压迫感**。

### interval（每个条目内的间隔）

一次性涌出 10 个近战会瞬间围死玩家。
给 0.15s 间隔，玩家能逐个应对。

## forceKill 为什么必须实现

怪卡在地图外时玩家打不到它，
必须有一种方式让它消失——`forceKill` 就是。

常见实现：淡出 + 销毁。或者对卡住的怪直接传送到场地中央
（后者更自然，玩家会觉得"它自己跑出来了"）。

## nextOn 的三种模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `'cleared'`（默认） | 全灭才进下一波 | 普通战斗房 |
| `'timeout'` | 固定时间后进入 | 防守、护送 |
| `'cleared-or-timeout'` | 先满足哪个算哪个 | **最稳** |

注意：`'cleared'` 模式**也有** `waveTimeout` 兜底——
否则怪卡住就永远过不去。这个兜底无法关闭。

## 调试：forceClearWave()

绑定到快捷键，测试关卡流程时不用真的打完每一波。

## onFallback 是要报警的

兜底触发说明**有东西出问题了**（生成点被占用、寻路失败、伤害为 0）。
正常游戏里它应该永远不触发。所以：

- 开发期：直接打日志 + 弹窗
- 上线后：上报服务器

如果线上频繁触发，说明有系统性 bug 而不是偶发。

## API

### 状态查询（**做波次 UI 全靠这几个**）

| 成员 | 说明 |
|---|---|
| `state` | 当前状态（`idle` / `spawning` / `fighting` / `cleared` …） |
| `currentWaveIndex` | 当前第几波（**从 0 还是 1 开始，看配置**） |
| `aliveCount` | 存活敌人数 |
| `pendingCount` | 还没生成的敌人数 |
| `finished` | 全部波次是否结束 |
| `aborted` | 是否已中止 |
| `aliveHandles()` | 存活敌人的句柄列表（**批量加 buff / 全体强制击杀用**） |

```typescript
// 波次 UI：「第 3/8 波 · 剩余 5」
ui.text = `第 ${ws.currentWaveIndex + 1}/${total} 波 · 剩余 ${ws.aliveCount}`;
```

> ⚠️ **判断"这一波打完"用 `aliveCount === 0 && pendingCount === 0`。**
> 只看 `aliveCount` 的话，还有敌人没生成完时会**提前进入下一波**，
> 表现为"第二波和第一波混在一起出"。

### 类型

```typescript
type WaveState = 'idle' | 'pre-delay' | 'spawning' | 'fighting' | 'cleared' | 'aborted';
type RemoveReason = 'dead' | 'wave-timeout' | 'stuck' | 'total-timeout' | 'abort';
```

> ⚠️ **`WaveState` 有 6 个值，别只处理 3 个。**
> 尤其 `pre-delay` 和 `cleared` 是独立的中间态——
> 做波次 UI 时漏掉它们会看到"波次间 UI 闪烁"或"清完场不进下一波"。

> ⚠️ **`RemoveReason` 区分了 `dead` 和 `wave-timeout`。**
> 前者是敌人真死了，后者是这一波超时被强制移除——
> 统计"击杀数"时只认 `dead`，
> 否则超时清场会虚增击杀数。

> **`stuck` 是防卡死的**：敌人卡在不可达位置（生成点被堵）
> 时会被移除，否则永远打不完这一波。

**`WaveEntry` / `WaveDef`**：

```typescript
interface WaveEntry {
  id: string;
  count: number;        // 生成几个
  delay?: number;       // 这一项的延迟
  interval?: number;    // 逐个生成的间隔
  data?: unknown;       // 透传给 onSpawn
}

interface WaveDef {
  id: string;
  entries: readonly WaveEntry[];   // 这一波包含哪些敌人
  nextOn?: 'cleared' | 'timeout' | 'cleared-or-timeout';
  timeout?: number;      // nextOn 含 timeout 时用
  preDelay?: number;     // 波次开始前的准备时间
}
```

> ⚠️ **`nextOn` 决定"什么时候进下一波"，配错了节奏全乱。**
>
> | 值 | 行为 |
> |---|---|
> | `cleared` | 全灭才进（**最常见**，配合 `timeout` 兜底） |
> | `timeout` | 到点就进，不管死没死完（割草、防守） |
> | `cleared-or-timeout` | 哪个先到算哪个 |

> ⚠️ **`WaveEntry.data` 是 `unknown`，用之前要自己断言。**
> 不报错，但拿到的是 `unknown`——
> 直接读属性会编译失败。这是刻意的类型安全设计。

**`WaveSpawnerOptions`**：

| 字段 | 说明 |
|---|---|
| `waves` / `spawn` | 波次表 / 生成回调（**都必填**） |
| `rng` | 随机源（**注入便于复现**） |
| `waveTimeout` | 单波超时 |
| `entityTimeout` | 单个敌人存活超时（**防卡死**） |
| `totalTimeout` | 全局超时 |

> ⚠️ **三个 timeout 都是"兜底"，不是"正常节奏"。**
> 它们触发时会强制移除敌人（产生 `RemoveReason` 里的
> `wave-timeout` / `total-timeout`）——
> 如果你发现正常游戏里经常触发，说明节奏设计有问题，
> 不是超时配短了。

**`FallbackInfo`**（超时回调的入参）：

```typescript
{
  type: 'wave-timeout' | 'stuck' | 'total-timeout';
  waveIndex: number;  aliveCount: number;  elapsed: number;
  killed: readonly number[];
}
```

> **`killed` 是"本波已击杀的句柄列表"**，
> 超时回调里想补发奖励或记日志用得上。

### 控制

| 成员 | 说明 |
|---|---|
| `tick(dt)` | 推进 |
| `reset()` | 重置到第 0 波（**重开关卡**） |
| `nextHandleId()` | 分配一个唯一句柄 id |

> ⚠️ **`nextHandleId()` 是给 spawn 回调里造敌人 id 用的。**
>
> ```typescript
> onSpawn: (def) => spawnEnemy({ id: ws.nextHandleId(), def });
> ```
>
> **别在别处调它**——它会消耗序号，
> 导致你自己造的 id 和内部的对不上。
> 造敌人 id 只在 `onSpawn` 里调，一次一个。

> ⚠️ **句柄 id 是"序号"不是"数组下标"。**
> `reset()` 不会把它归零（避免和上一局的敌人撞 id），
> 所以别拿它当 `enemies[id]` 的索引——
> 第一局是 0~9，第二局从 10 开始，数组会全是空洞。
| `abort()` | 中止（**玩家逃跑、关卡被跳过时**） |
| `forceClearWave()` | 调试用：强制清完当前波 |

> **`reset()` 与 `abort()` 的区别**
> `reset` 回到初始状态，可以重新开始；
> `abort` 是"彻底停掉"，之后 `finished` 为 true 但**波次没有真正完成**——
> 结算界面要区分这两种，否则玩家逃跑也能拿通关奖励。

## 测试

38 项。重点覆盖：
- 怪卡住时超时强制推进（核心承诺）
- 单体超时只清卡住的那一个
- `spawn` 返回 null 不会卡死
- `interval = 0` 时一帧内全部生成，不漏
- **模拟 200 局随机战斗，全部能结束**

文件：`WaveSpawner.ts`
