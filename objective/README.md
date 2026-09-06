# objective — 关卡目标

## 它解决什么

「击杀 10 个敌人」「保护村民」「60 秒内通过」这类关卡目标，
以及它们之间的**前置依赖**。

朴素做法是一堆散落的布尔标志，问题是：

- 分阶段关卡（先开门，再清场）的激活顺序容易乱
- 可选目标失败不该导致整关失败，但容易写成会的
- **循环依赖会让关卡永远不开始**，而且不报错

## 零业务依赖

目标只是 `{ id, kind, target }`。它不认识敌人、不认识区域。

## 用法

```typescript
import { ObjectiveSystem, Objectives } from './objective/ObjectiveSystem';

const os = new ObjectiveSystem({
  objectives: [
    Objectives.kill('clear', 10),                                  // 击杀 10 个
    Objectives.after(Objectives.protect('vip', 3), ['clear']),     // 击杀完后保护村民
    Objectives.optional(Objectives.timeLimit('speed', 90)),        // 可选：速通
  ],
  mode: 'all',
});

os.tick(dt);                 // ⚠️ 目标在 tick 中激活
os.addProgress('clear', 1);  // 击杀一个
os.markReached('exit');      // 到达型目标

if (os.finished) winLevel();
if (os.failed) loseLevel(os.failedId);
```

## 五种目标类型

| kind | 语义 | 初始进度 |
|---|---|---|
| `count` | 计数达标（击杀、收集） | 0 |
| `survive` | 生存 N 秒 | 0 |
| `timed` | 限时内完成（超时失败） | 0 |
| `reach` | 到达区域（布尔） | 0 |
| `protect` | 保护对象（掉到 0 失败） | **target** |

> ⚠️ `protect` 的初始进度 = target（满血），进度**反向**递减。
> 这是最容易写反的一种。

## 预设

```typescript
Objectives.kill(id, count)
Objectives.survive(id, seconds)
Objectives.timeLimit(id, seconds)
Objectives.reach(id)
Objectives.protect(id, hp)
Objectives.optional(def)          // critical = false
Objectives.after(def, requires)   // 带前置
```

## 关键设计

### 构造时检测循环依赖

两个互为前置的目标会永远 `inactive`，
玩家面对一个「什么都没发生」的关卡。

这是最难排查的一类 bug——配置看起来完全合理。
所以构造时立即抛错。

### `critical: false` = 可选目标

完成了有奖励，失败不惩罚。默认 `true`。

### 目标在 `tick()` 中激活

构造后状态是 `inactive`，第一次 `tick()` 才激活满足前置的那些。
测试里记得先 tick 一次。

## API

| 成员 | 说明 |
|---|---|
| `tick(dt)` | 推进（**目标在 tick 中激活**，见上） |
| `addProgress(id, n)` | 累加进度 |
| `setProgress(id, value)` | **直接设置**进度（不是累加） |
| `markReached(id)` | 到达型目标标记达成 |
| `finished` / `failed` / `failedId` | 结果查询 |
| `ratio(id)` | 某目标的进度比例 0..1（**做进度条**） |
| `status(id)` | 某目标的状态（`inactive` / `active` / `done` / `failed`） |
| `progress(id)` | 某目标的当前进度值 |

> ⚠️ **本模块没有 `state(id)`。**
> 早期文档在 `status(id)` 下面紧挨着写了一行 `state(id)`，
> 但源码从未实现过——照着调会报 `Property 'state' does not exist`。
>
> 想同时拿到状态和进度，分开取即可：
>
> ```typescript
> const st  = obj.status(id);      // 'inactive' / 'active' / 'done' / 'failed'
> const p   = obj.progress(id);    // 当前进度
> const r   = obj.ratio(id);       // 0..1，做进度条用这个
> ```
| `primary()` | 主目标（**UI 高亮的那个**） |
| `totalTime` | 已总用时 |
| `reset()` | 重置全部 |

```typescript
// 目标 UI：「击败敌人 7/10」
const st = os.state('clear');
ui.text = `击败敌人 ${st.progress}/10`;
ui.bar  = os.ratio('clear');
```

> ⚠️ **`addProgress` 与 `setProgress` 别用混。**
> `addProgress(id, 10)` 是"+10"；`setProgress(id, 10)` 是"设成 10"。
> 在"击杀数"上用错，表现为**进度条倒退**——
> 而且只在单帧击杀数超过之前累积值时才看得出来。

## 坑

1. **`mode: 'all'` 时可选目标也算**——如果不想让它影响 `finished`，
   用 `mode: 'critical'` 或手动检查。
2. **`target` 必须为正**（`reach` 除外）——构造时校验。
3. **`forceActivate()` 可以跳过前置**——用于调试或剧情强制推进。

---

## 返回值结构

### `ObjectiveState` / `ObjectiveStatus`

```typescript
interface ObjectiveState {
  def:      ObjectiveDef;      // 定义
  status:   ObjectiveStatus;   // 状态
  progress: number;            // 当前进度
  elapsed:  number;            // 已用时间（**限时目标用**）
}

interface ObjectiveStatus {
  id:       string;
  kind:     ObjectiveKind;
  title:    string;
  target:   number;
  requires: readonly string[];   // 前置目标 id
  critical: boolean;             // 失败即整局失败
  data:     unknown;
}
```

> ⚠️ **`elapsed` 只对限时目标有意义**，非限时目标它也在涨但没有上限。
> 拿它做倒计时前先确认 `kind` 是不是限时类。

> **`critical` 为 true 的目标失败 = 整局失败**（主线目标）。
> 支线目标通常是 `false`。
> 做"任务失败"判定只看 `critical`，
> 否则一个支线没完成就宣告失败，玩家会莫名其妙。