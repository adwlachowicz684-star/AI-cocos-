# InputBuffer — 输入缓冲（+ CoyoteTimer）

> 本文件属于 `input/` 插件目录，与 `InputManager` 配套使用。
>
> ⚠️ **这份只讲 InputBuffer 与 CoyoteTimer。**
> 键盘/鼠标/手柄的统一抽象在 **[`README.md`](./README.md)**（InputManager）。
>
> 目录里有两份文档是有代价的——只看一份会以为另一半功能没有文档。
> **所以两边都放了索引，改动时记得一起看。**

## 它解决什么

玩家在攻击后摇的第 3 帧按下了攻击键。
此时角色还在硬直中，输入被丢弃 → 玩家觉得「我按了没反应」。

输入缓冲把这次按键**记住一小段时间**（通常 100~150ms），
等硬直一结束立刻执行。

**这是动作游戏手感的第一块地基。**
哈迪斯、空洞骑士、鬼泣都靠它。没有它，连招会变得「粘滞」——
玩家必须精确卡帧才能接上。

## 两个相关概念

| | 作用 |
|---|---|
| **Input Buffer** | 当前**不能**执行时，记下来稍后执行 |
| **Input Queue** | 记下**连续**的输入序列，用于搓招（↓↘→ + A） |

两者都提供。

## 窗口时长参考

| 动作 | 窗口 |
|---|---|
| 攻击 | 0.10 ~ 0.15s |
| 跳跃 | 0.08 ~ 0.12s |
| 格挡/闪避 | 0.12s（容错要更高，按早了就死） |

超过 0.2s 玩家会觉得输入「太黏」，出现误操作。

## 用法

```typescript
const buf = new InputBuffer({ window: 0.15 });

buf.press('attack');       // 玩家按下
buf.tick(dt);              // 每帧

if (!busy && buf.consume('attack')) doAttack();   // 硬直结束

buf.consumeAny(['attack', 'jump']);               // 取最早按下的
buf.consumeSequence(['down', 'right', 'attack']); // 搓招
```

## 完整接口

| 成员 | 说明 |
|---|---|
| `press(action, force?)` | 记录一次输入 |
| `peek(action)` | **只查询不消费**（与 `consume` 的唯一区别） |
| `consume(action)` | 消费，返回是否有 |
| `consumeAny(actions)` | 从一组里取**最早按下**的，返回 action 名 |
| `clear(action?)` | 清除某个（**不传则全清**） |
| `tick(dt)` | 推进老化（**暂停时传 0**，见坑 ①） |
| `window` | 窗口时长（**可读写**） |
| `pendingCount` | 当前缓冲了几个输入（**调试用**） |
| `queue()` | 全部缓冲项（含时间戳） |
| `clearQueue()` | 清空整个队列 |
| `matchSequence(pattern, maxSpan?)` | 搓招匹配（**只匹配不消费**） |
| `consumeSequence(pattern, maxSpan?)` | 搓招匹配并消费 |
| `destroy()` | 释放 |

> ⚠️ **`peek()` 与 `consume()` 的区别，是 `skill-queue` 能工作的前提。**
>
> 朴素写法是"先消费再尝试施放"：
>
> ```typescript
> if (buf.consume('fire')) caster.tryCast('fire', ctx);   // ✗
> ```
>
> 但 `consume()` 一调用就把缓冲清了，它**不知道技能会不会成功**——
> CD 还差 0.1 秒时输入直接丢失，玩家点了没反应。
>
> 正确写法是先 `peek()`、尝试、成功了才 `consume()`：
>
> ```typescript
> if (!buf.peek('fire')) return;
> const r = caster.tryCast('fire', ctx);
> if (r.ok) buf.consume('fire');
> else if (r.reason !== 'cooldown') buf.consume('fire');   // 真失败才丢
> ```
>
> 这段逻辑已封装进 `skill-queue`，直接用那个模块即可。

> ⚠️ **`window` 必须大于你想容忍的提前量。**
> 想在 CD 剩 0.1 秒时点击也能生效，窗口就得 > 0.1。
> 默认 0.15 够用，但要容忍 0.2 秒就得显式调大——
> 窗口先过期的话，输入照样丢，且没有任何提示。

> **`pendingCount` 是排查"输入丢了"的第一手工具。**
> 它是 0 说明根本没进缓冲（检查 `press()` 有没有调）；
> 非 0 说明是 `consume` 时机的问题。

### `CoyoteTimer` 完整接口

| 成员 | 说明 |
|---|---|
| `setGrounded(g)` | 每帧更新接地状态 |
| `tick(dt)` | 推进 |
| `canJump()` | 现在能不能跳（**不改变状态**） |
| `consumeJump()` | 能跳则消费（**一次离地只能跳一次**） |
| `left` | 剩余时间 |

> ⚠️ **查询用 `canJump()`，实际起跳用 `consumeJump()`。**
> 只调 `canJump()` 不消费的话，一次离地能跳两次——就是二段跳 bug。
> 反过来只调 `consumeJump()` 不看返回值也不行（它消费失败时返回 false）。

> **`left` 是做"边缘保护提示"用的**，
> 比如在土狼时间剩余时显示一个微妙的视觉提示。

### 类型

```typescript
interface BufferedInput  { action: string; at: number; /* ... */ }
interface InputBufferOptions { window?: number; /* ... */ }
```

> **`queue()` 返回的是 `BufferedInput[]`，带时间戳。**
> 做输入回放、搓招调试面板时用得到——
> 光看 action 名看不出时序问题。

## 与 InputManager 的分工

| | 职责 |
|---|---|
| `InputManager` | 物理输入 → 动作名（键盘/手柄/触摸 → `'attack'`） |
| `InputBuffer` | 动作名 → 记住/消费（时序容错） |

串联使用，互不依赖。

## 四个坑

**① 暂停时必须传 dt = 0**
否则暂停期间缓冲继续「老化」，恢复后输入已失效。
或者注入 `now` 时间源，接 `Scheduler` 的缩放时间。

**② 消费后必须清除**
同一次输入不能被消费两次。

**③ 搓招匹配后要清空队列**
否则 `↓↘→A` 触发后队列里还剩 `→A`，下一个招式 `→A` 会立刻被误触发。

**④ `maxQueue` / `window` 传 NaN 不会"按默认走"**
`??` 只挡 `null` / `undefined`，NaN 会原样存进去：

| 字段 | NaN 的后果 |
|---|---|
| `maxQueue` | 裁剪判定 `queue.length > NaN` 恒为 false → **队列永不裁剪**（实测连按 50 次后长度 50） |
| `window` | `now - t <= NaN` 恒为 false → `peek` 永远 false、`consume` 时灵时不灵 |

现在构造用 `clampNum(maxQueue, 1, 64, 6)` 与 `numOr(window, 0.15)`，
`window` 的 setter 是 **`numOr(v, this._window)` 后再 `Math.max(0, …)`**——
`Math.max(0, NaN)` 是 NaN，单独一个 `Math.max` 挡不住，所以必须先 `numOr`。

> ⚠️ **非法值是"保持旧值"，不是兜成 0。**
> 第一版 setter 写的是 `Math.max(0, numOr(v, 0))`，注释还论证"与构造函数同口径"——
> 这是假的：构造函数兜 0.15，setter 兜 0。而命中判定是 `now - t <= window`，
> `window = 0` 时只有"同一时间戳"成立，对"按下 → 下一帧消费"这个主力用法
> **缓冲等于死了**（实测 `press` 后隔一帧 `consume()` = false），与没修之前一样。
> 所以改成维持上一次的有效值：热更传 NaN 时至少不会把手感一键清空。
> 显式传 `0` 是合法意图（"不要缓冲"），照旧接受。

### 搓招允许中间有多余输入

`['down','right','attack']` 能匹配 `down, down-right, right, attack`——
玩家用摇杆划半圈会产生中间方向，严格要求连续会让搓招几乎不可能。

## CoyoteTimer（土狼时间）

输入缓冲的**镜像问题**：

| | 场景 |
|---|---|
| 输入缓冲 | **提前**按的键，稍后生效 |
| 土狼时间 | **延后**才生效的条件，现在仍算数 |

玩家刚走出平台边缘就按跳，但此时已「离地」，跳跃被拒绝 → 觉得「我按了没跳」。
土狼时间：离地后仍允许跳跃一小段时间（通常 80~120ms）。

```typescript
const coyote = new CoyoteTimer(0.1);
coyote.setGrounded(isOnGround);   // 每帧
coyote.tick(dt);
if (input.jump && coyote.consumeJump()) doJump();
```

**消费后必须作废**，否则一次离地能跳两次（变成二段跳 bug）。

## 测试

16 项。重点覆盖窗口过期、consumeAny 取最早、搓招容错、土狼时间防二段跳。

文件：`InputBuffer.ts`
