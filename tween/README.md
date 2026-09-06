# tween — 补间动画（纯逻辑）

## 为什么不用引擎自带的 tween

Cocos 的 `tween(node)` 很好用，但它**绑在节点上**，这意味着：
- 无法对纯数值做补间（比如"把伤害从 10 平滑到 25"）
- 无法脱离引擎单测
- 暂停语义受引擎调度控制

本实现只做一件事：**给你一个从 0 到 1 的进度 t，你用它算任何值。**

## 设计：Tween 不持有目标对象

这是可复用的关键。引擎 tween 是 `tween(node).to(...)`，必须认识 node。
而这里：

```typescript
new Tween(0.5).onUpdate((p) => {
  panel.opacity = 255 * p;              // 你决定用 p 做什么
  enemy.health = lerp(0, 100, p);
});
```

它能补间任何东西——数值、颜色、位置、音量、UI 布局。

## 用法

```typescript
import { Tween, TweenRunner } from './tween/Tween';

const runner = new TweenRunner();

runner.add(
  new Tween(0.4).delay(0.3).ease('outBack')
    .onUpdate((p) => { icon.x = lerp(startX, endX, p); })
    .onComplete(() => console.log('到位'))
);

runner.to(0.5, (p) => { label.opacity = 255 * p; });   // 便捷写法
runner.delay(1, () => spawn());                         // 延时执行

// 每帧（用 Scheduler 的 unscaled 通道，UI 动画不该受暂停影响）
runner.update(dt);

// 循环呼吸效果
new Tween(1).loop('pingpong').onUpdate((p) => glow.intensity = p);
```

## 缓动名（拼错会抛错）

```
linear  inQuad  outQuad  inOutQuad
inCubic  outCubic  inOutCubic
outQuart  inOutQuart  outExpo
outBack  outElastic  outBounce
```

> **拼错名字会立刻抛错，而不是静默退化成线性。**
> 静默退化的话，你的动画会"看起来不太对劲"但没有任何报错，
> 然后你会花一小时调时长调曲线，最后才发现名字写成了 `easeOutQuad`（正确是 `outQuad`）。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| UI 动画走缩放通道 | 暂停时动画卡住 | 用 Scheduler 的 `everyFrameUnscaled` |
| 缓动名拼错 | 静默变线性，花一小时排查 | 已改为抛错 |
| 循环节点忘记上限 | 永远不结束 | `loop(mode, times)` |
| 回调里创建新 Tween | 破坏遍历 | TweenRunner 用快照，安全 |
| 复用 Tween 对象不 reset | 状态残留 | 用 `reset()` |

## API

### Tween
| 成员 | 说明 |
|---|---|
| `delay(seconds)` | 延迟开始（**溢出会补偿，不丢时间**） |
| `ease(name \| fn)` | 缓动（拼错抛错） |
| `loop(mode, times?)` | `'none'` / `'repeat'` / `'pingpong'` |
| `onUpdate((p, raw) => void)` | 每帧回调（p=缓动后，raw=线性） |
| `onComplete(fn)` | 完成回调（只触发一次） |
| `complete()` | 跳到终态并触发完成 |
| `kill()` | 终止（不触发完成、不跳终态） |
| `progress` / `done` / `reset()` | 状态查询与复用 |
| `killed` | 是否被 `kill()` 终止过 |
| `destroy()` | 释放 |

> ⚠️ **`killed` 与 `done` 是两个不同的终态。**
> `kill()` 之后 `killed` 为 true 而 `done` 为 false
> （它没有"完成"，是被中止的）。
> 只判 `done` 的话，被 kill 的 tween 会被当成"还在跑"——
> 表现为"对象销毁了但 tween 还在改它的属性"。
>
> 正确做法：
> ```typescript
> if (tw.killed || tw.done) { /* 不要再用了 */ }
> ```

> ⚠️ **`reset()` 之后 `killed` 会归 false，可以复用。**
> 但 `destroy()` 之后不能——
> 复用 tween 用 `reset()`，丢弃用 `destroy()`。

### TweenRunner
| 成员 | 说明 |
|---|---|
| `add(tween)` / `to(dur, fn)` / `delay(s, fn)` | 添加 |
| `update(dt)` | 每帧推进，自动清理完成的 |
| `killAll()` / `completeAll()` | 批量操作 |
| `destroy()` | 释放 |

> ⚠️ **`killAll()` 与 `completeAll()` 都会清空 runner。**
> 前者不触发完成回调（对象停在半路），后者触发（对象跳到终态）。
> 切场景时用 `completeAll()`——
> 用 `killAll()` 的话 UI 会停在动画中间的状态。

### 类型

```typescript
type LoopMode = 'none' | 'repeat' | 'pingpong';
```

| 模式 | 行为 |
|---|---|
| `none` | 播一次就结束 |
| `repeat` | 重复播放（**每次从头开始**） |
| `pingpong` | 往复（去→回→去，不会跳变） |

> ⚠️ **`repeat` 每次都从头开始，`pingpong` 是倒着播回来。**
> 做"呼吸效果"要用 `pingpong`——
> 用 `repeat` 的话每次循环结束会瞬间跳回起点，
> 表现为"闪一下"。

> ⚠️ **`loop()` 的第二个参数 `times` 省略表示无限循环。**
> 无限循环的 tween **永远不会 `done`**，
> 也不会被 runner 自动清理——
> 忘了 kill 的话会一直累积（内存泄漏）。
| `count` | 数量（**只增不减 = 泄漏**） |
