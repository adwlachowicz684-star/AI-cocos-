# combo — 连招输入

## 它解决什么

「轻、轻、重」出终结技，「轻、轻、轻」出三连击。

朴素做法是维护一个输入历史数组然后字符串匹配，
问题是**窗口管理**——什么时候该结算，什么时候该继续等。

## 零业务依赖

输入只是字符串（`'light'` / `'heavy'`），招式只是 `inputs` 数组。
它不认识攻击动作、不认识动画。

## 用法

```typescript
import { ComboSystem, validateCombos } from './combo/ComboSystem';

const c = new ComboSystem({
  moves: [
    { id: 'light1',   inputs: ['L'] },
    { id: 'light2',   inputs: ['L', 'L'] },
    { id: 'light3',   inputs: ['L', 'L', 'L'] },
    { id: 'finisher', inputs: ['L', 'L', 'H'], priority: 10 },
    { id: 'heavy',    inputs: ['H'] },
  ],
  inputWindow: 0.4,
  recovery: 0.08,
});

// 玩家按键
const move = c.input('L');
if (move) playMove(move.moveId);

// ⚠️ 每帧必须调用
const timedOut = c.tick(dt);
if (timedOut) playMove(timedOut.moveId);
```

## 核心机制

输入先进缓冲。若当前缓冲是某个**更长招式的前缀**，就等待；
否则立即触发能匹配的最长招式。窗口超时后强制结算。

```
L       → 是 L,L 的前缀      → 等待
L,L     → 是 L,L,L 和 L,L,H 的前缀 → 等待
L,L,H   → H 不是更长前缀     → 立即触发 finisher
```

这个「等一下」正是连招手感的来源。

### 优先级

同序列冲突时取 `priority` 大的。
**遗物强化了某个招式时，不用改配置顺序，只提优先级。**

### 条件

```typescript
{ id: 'air_slash', inputs: ['L'], priority: 20, condition: (ctx) => ctx.isAirborne }
```

条件不满足时该招式被跳过，回退到能匹配的次优招式。

## 参数怎么定

| `inputWindow` | 手感 |
|---|---|
| 0.25~0.3 | 硬核（鬼泣、忍者龙剑传） |
| **0.35~0.45**（默认） | 标准动作游戏 |
| 0.6+ | 休闲，几乎不会失败 |

> **宁可长一点。** 太短会让玩家「明明按了却没出招」，
> 而且玩家**不知道是自己手慢还是游戏有 bug**——
> 这会严重损害信任感。

`recovery` 是出招后到下一个序列开始的间隔，防止 A 招的输入被 B 招「吃掉」。

## API

| 成员 | 说明 |
|---|---|
| `input(key)` | 输入一个键，返回**已成立**的招式（没成立返回 null） |
| `tick(dt)` | 每帧推进，返回**因超时而结算**的招式 |
| `moveCount` | 已配置的招式数 |
| `pending` | 是否正在等待后续输入 |
| `bufferedInput` | 当前缓冲的输入（**调试用**：看连招卡在哪一步） |
| `cancel()` | 取消当前连招（被打断、切武器时） |
| `reset()` | 重置状态 |

> ⚠️ **`tick()` 的返回值别丢。**
> 招式可以在两种时机成立：① 输入即匹配（`input` 返回）
> ② 窗口超时后按最长匹配结算（`tick` 返回）。
> 只处理 `input` 的返回值，会丢掉「按了 L-L 之后停手」的那一下——
> 玩家会觉得「我明明按了两下，第三下没接上」。

## 坑

1. **`tick()` 必须每帧调用**——窗口超时只在这里判定。
   忘了调的话输入会永远挂在缓冲区里，
   表现为「过了一会儿自己出招」，非常诡异。
2. **`buffered` 是硬直期间的输入**——硬直结束的瞬间自动兑现，
   这是「输入缓冲」的核心，别在别处再实现一遍。
3. **`window` 是招式级的，覆盖全局 `inputWindow`**——
   升龙这类需要快速输入的招式给更短的窗口。
   但注意：**只有「需要等待」时窗口才有意义**，
   若某招式是叶子节点（没有更长的招式以它为前缀），它会立即触发。

---

## 返回值结构

### `MoveTriggered`

```typescript
interface MoveTriggered {
  moveId: string;     // 触发的招式 id
  length: number;     // 匹配到的输入序列长度
  data?:  unknown;    // 业务数据
}
```

> **`length` 是实际匹配的长度**，不是招式定义的长度。
> 做"连击数"显示时用它——
> 用招式定义长度的话，短序列也会显示成满段。