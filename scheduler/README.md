# Scheduler · TimeScale

统一时间源。**这是整个库最关键的插件，没有之一。**

## 它解决什么

「暂停时 buff 仍在倒计时」是游戏开发最经典、最让玩家愤怒的 bug。
根因永远是同一个：某个系统偷偷用了 `setTimeout` / `Date.now()` / 引擎自带的 `schedule`，
它们不受 timeScale 控制。

Scheduler 的做法：**所有计时都必须向它注册，由它统一分发 dt。**
这样暂停、慢动作、顿帧自动生效，不需要每个系统各自处理——
也就没有"某个系统忘了处理"的可能。

## 两条通道（必须理解）

| 通道 | 受 timeScale 影响 | 用途 |
|---|---|---|
| `everyFrame(fn)` | ✅ | **游戏逻辑**：移动、冷却、buff、AI |
| `everyFrameUnscaled(fn)` | ❌ | **UI 动画、暂停菜单、网络心跳** |

> **坑：为什么必须有 unscaled 通道**
> 暂停时 scale = 0，如果暂停菜单自己的淡入动画也走缩放通道，
> 那菜单会卡在半透明状态永远淡不进来——**暂停菜单自己被暂停了**。
> 这个 bug 几乎所有新手都会遇到一次。

## 用法

```typescript
import { Scheduler } from './scheduler/Scheduler';

const sched = new Scheduler();

// 主循环 —— 整个项目应该只有一处调用 update
update(deltaTime: number) {
  sched.update(deltaTime);
}

// 游戏逻辑（受暂停影响）
sched.everyFrame((dt) => {
  player.move(dt);
  buffSystem.tick(dt);
});

// UI（不受暂停影响）
sched.everyFrameUnscaled((dt) => menuAnim.tick(dt));

// 延时（游戏内时间：暂停时不推进）
sched.delay(3, () => spawnEnemy());

// 延时（墙钟时间：网络超时用）
sched.delayUnscaled(5, () => onTimeout());

// 定时重复
sched.repeat(1.0, () => regen(), 5);   // 每秒 1 次，共 5 次

// 顿帧（打击感的关键）
sched.hitStop(0.08);      // 命中瞬间卡 80ms

// 慢动作
sched.slowMotion(0.5, 2); // 半速，持续 2 秒
```

## 顿帧为什么能提升打击感

命中瞬间卡住 60–110ms，玩家的视觉系统会把这一刻标记为"重要事件"。
没有顿帧的攻击，手感是「滑过去」的；有了顿帧，是「砸中」的。

> **这是投入产出比最高的手感优化**——几行代码，质感提升一个档次。

参考数值：

| 场景 | 时长 |
|---|---|
| 轻击 | 60ms |
| 重击 | 110ms |
| 暴击 | 140ms |
| 击杀 | 180ms |

超过 200ms 会明显感觉「卡」，不再是「有力」。

## TimeScale：为什么必须多层

单一 scale 变量会遇到经典的覆盖问题：

```
玩家开技能 → scale = 0.5（慢动作）
打中敌人   → scale = 0.05（顿帧）
顿帧结束   → scale = ?   ← 该恢复成 0.5 还是 1？
```

单一变量会丢失「慢动作还在生效」这个信息。多层结构下，
顿帧层到期自动移除，慢动作层不受影响。

**合成规则：各层相乘。**（这个规则在单测里锁死，
团队里如果有人以为"取最小"或"取最后添加的"，数值就会对不上，
而且这种错误**没有任何报错**。）

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 某系统用 `setTimeout` / `Date.now()` | **暂停时它仍在走** | 所有计时走 Scheduler |
| 暂停菜单用缩放通道 | 菜单自己被暂停 | 用 `everyFrameUnscaled` |
| 忘了 `endFrame()`（InputManager） | 按一次攻击连放好几次 | 帧末必须调用 |
| 顿帧用缩放时间计时 | 80ms 顿帧变成 1.6 秒卡顿 | 层的到期判定走**真实时间** |
| 不 clamp realDt | 切后台回来角色瞬移穿墙 | 默认 clamp 到 0.1s |
| 多处调用 `update()` | 同样 3 秒冷却，有的快有的慢 | 整个项目只调一次 |

## API

### Scheduler
| 成员 | 说明 |
|---|---|
| `update(realDt)` | **主循环唯一入口** |
| `everyFrame(fn)` / `everyFrameUnscaled(fn)` | 每帧回调，返回取消函数 |
| `delay(s, fn)` / `delayUnscaled(s, fn)` | 延时，返回取消函数 |
| `repeat(interval, fn, times?)` | 定时重复 |
| `repeatUnscaled(interval, fn, times?)` | 定时重复（**不受 timeScale 影响**） |
| `pause()` / `unpause()` | 暂停 |
| `hitStop(dur?, scale?)` | 顿帧 |
| `slowMotion(scale, dur?)` / `clearSlowMotion()` | 慢动作 |
| `timeScale` | 底层 TimeScale，可直接操作 |
| `scaledTime` / `unscaledTime` | 累计时间 |
| `taskCount` | 任务数（**只增不减 = 泄漏**） |
| `lastRealDt` | 上一帧的**真实** dt（未缩放） |
| `lastScaledDt` | 上一帧的**缩放后** dt |
| `destroy()` | 清空 |

> ⚠️ **`lastRealDt` 与 `lastScaledDt` 别混用。**
>
> | 用途 | 该用哪个 |
> |---|---|
> | UI 动画、冷却读秒（受顿帧影响） | `lastScaledDt` |
> | 网络超时、真实耗时统计、FPS 计算 | `lastRealDt` |
>
> 顿帧时 `timeScale` 接近 0，`lastScaledDt` 也接近 0——
> 用错的话表现为"顿帧期间网络超时计时器不走了"。

### TimeScale
| 成员 | 说明 |
|---|---|
| `add(id, scale, durationSec?, now?)` | 添加层（同 id 覆盖） |
| `remove(id)` / `has(id)` / `get(id)` | 查询与移除 |
| `suspend(id)` / `resume(id)` | 挂起（保留但不生效） |
| `pause()` / `unpause()` / `paused` | 显式暂停（优先于所有层） |
| `update(now?)` | 推进真实时间，清理过期层 |
| `value` | 合成后的缩放值（各层相乘） |
| `dump()` | 调试输出（排查「游戏莫名变慢」） |
| `layerCount` | 当前活跃层数（**调试用**） |
| `destroy()` | 清空 |

> **`layerCount` 是「游戏莫名变慢」的第一现场。**
> 典型 bug：加了 5 个慢动作层忘了移除，画面慢得像幻灯片——
> 打印 `layerCount` 一眼就能看到是 5 而不是 1。
> `dump()` 会列出每一层的 id 和 scale，进一步定位是哪一处加的。
