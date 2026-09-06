# cutscene · 演出编排

```typescript
import { Cutscene, Timeline } from './cutscene/Cutscene';
```

- 依赖：`_core/math`
- 引擎耦合：**无**
- 测试：23 项

---

## 它解决什么

过场动画手写起来是一堆嵌套 `setTimeout`。四个必然出现的问题：

**1. 没法暂停** — setTimeout 不受 timeScale 控制，暂停了演出还在走。

**2. 没法跳过** — 跳过要把所有未完成步骤的**最终状态**都应用上，
否则镜头停半路、角色卡在走位中间。而 setTimeout 你根本不知道剩多少。

**3. 没法拖动进度** — 调试时想跳到第 3 秒看镜头对不对，做不到。

**4. 清理困难** — 中途退出，那一串 setTimeout 还是会触发。

本模块是**纯时间轴**：只负责"现在该执行哪些 step"，
具体做什么由注册的回调决定。所以它能被完整测试。

---

## 用法

```typescript
const tl = new Timeline('boss_intro')
  .add('camera', 1200, { to: 'boss' })      // 串行
  .with('sfx', 400, { id: 'roar' })          // 与上一个并行
  .add('dialogue', 1500, { text: '凡人……' })
  .wait('press', () => playerPressed, 30000) // 门控（必须配超时！）
  .add('shake', 300, { power: 0.8 });

const cs = new Cutscene(tl.build());

cs.on('camera', (step, localT, isSeek) => {
  // 只做插值，不播一次性音效（isSeek 时）
});

cs.play();
cs.update(scaledDtMs);      // ⚠️ 用缩放时间，暂停时演出该停
```

---

## 三个关键行为

### skip 是"快进到结尾"，不是"停止播放"

```typescript
cs.skip();   // 所有 step 的最终状态都被应用
```

写成 `stop()` 的话，镜头会停在半路，玩家看到一个很怪的中间画面。

### seek 必须重放之前的 step

```typescript
cs.seek(2000);
```

**不能**只应用当前时刻活跃的 step —— 之前所有 step 的效果全丢了
（镜头没移动，因为"移动到 A"那个 handler 没被调用过）。
正确做法是按序重放 `start <= t` 的所有 step，用 `isSeek=true`
告诉回调"这是一次性补状态，别播音效"。

### 门控（waitFor）会拦住时间

```typescript
{ id: 'press', kind: 'press', duration: 0, waitFor: () => pressed, timeoutMs: 30000 }
```

时间**停在门的起点**，不会越过去。这是最容易写错的地方——
早期实现先 `time += dt` 再检查阻塞，由于 wait step 时长为 0，
它会在进入的同一帧被标记结束，门根本拦不住。

**⚠️ `waitFor` 必须配 `timeoutMs`**，否则玩家不按就永远卡住。

---

## API

| 方法 | 说明 |
|---|---|
| `on(kind, handler)` | 注册某类 step 的回调 |
| `play()` / `update(dt)` | 播放 / 推进 |
| `seek(t)` | 跳到指定时刻（重放之前的 step） |
| `skip()` | 快进到结尾 |
| `stop()` | 停止（**不**应用终态） |
| `activeSteps()` | 当前活跃的 step |
| `blockingStep()` | 当前挡路的门 |
| `timedOut` | 是否曾因超时而放行 |

## API（续）：未列出的成员

| 成员 | 说明 |
|---|---|
| `def()` | 演出定义（只读） |
| `state()` | 当前状态（`CutsceneState`） |
| `time()` | 当前时间（毫秒） |
| `duration()` | 总时长（毫秒） |
| `progress()` | 进度 0~1 |
| `finished()` | 是否已播完 |
| `timedOut()` | 是否曾因超时而放行 |

> ⚠️ **`progress()` 在有门控时会卡住不动。**
> 门控期间时间**停在门的起点**（见上文"门控会拦住时间"），
> 所以进度条也停住。这是正确行为，
> 但拿它做"演出加载进度"的话会显示卡死。

> ⚠️ **`timedOut()` 是"曾经"超时，不是"当前"超时。**
> 一旦某道门超时放行，它会一直是 `true`。
> 想判断"当前有没有卡住"用 `blockingStep()`。

> ⚠️ **`stop()` 与 `skip()` 的区别是生与死级别的。**
> `skip()` 应用所有 step 的终态（玩家看到演出结束的正确画面）；
> `stop()` 什么都不应用（镜头停在半路）。
> "跳过演出"按钮必须用 `skip()`——坑表格里那条就是这么来的。

> **`blockingStep()` 返回 `null` 表示没有门在挡。**
> 做"点击继续"提示时判这个：
> 非 null 说明正等着玩家操作，该显示提示。

## Timeline 构建器

| 方法 | 说明 |
|---|---|
| `add(id, dur, data)` | 串行添加（接在上一个之后） |
| `with(id, dur, data)` | 并行添加（与上一个同时开始，**总时长取 max**） |
| `wait(id, fn, timeout)` | 门控 |
| `gap(ms)` | 空档 |
| `build()` | 生成 `CutsceneDef` |

> ⚠️ **`with()` 的总时长取 max，不是累加。**
> 一个 1000ms 的 step 后面 `with` 一个 3000ms 的，
> 这一段总时长是 3000 不是 4000——
> 想让后面的 step 等两者都结束，这是对的；
> 想串行就用 `add()`。

> ⚠️ **`build()` 之后 Timeline 不该再用。**
> 它是构建器，不是运行时的容器。
> 重复 `build()` 得到的定义是独立的（可以复用同一个 Timeline 构造多个 def），
> 但继续 `add()` 会影响**后续**的 build，不影响已经 build 出来的。

### 类型

| 类型 | 说明 |
|---|---|
| `CutsceneDef` | 演出定义（`build()` 的产物，也是构造参数） |
| `CutsceneStep` | 单个 step |
| `StepKind` | step 类型（`on(kind, handler)` 的 kind） |
| `StepHandler` | step 回调，签名 `(step, ctx) => void` |
| `CutsceneState` | 播放状态 |
| `CutsceneCut` | `update()` / `seek()` / `skip()` 的返回（本帧的变更） |

> ⚠️ **`CutsceneCut` 是"本帧发生了什么"，不是"当前状态"。**
> `update()` 返回它，你得把它应用到你的场景上
> （移动镜头、播音效、显示字幕）。
> 只读返回值而不应用的话，演出在逻辑上跑完了，画面什么都没变。

> **`on()` 返回 `this`，可以链式注册多个 kind 的 handler。**
> 没注册的 kind 不会报错——只是那个 step 什么都不做，
> 表现为"演出里某一段没效果"。
## 坑

| 坑 | 后果 |
|---|---|
| `update` 用真实时间 | 暂停时演出还在走（与 BGM 相反） |
| 用 `stop()` 实现跳过 | 镜头停在半路 |
| seek 只应用当前 step | 之前的效果全丢 |
| `waitFor` 不配 `timeoutMs` | 玩家不按就永远卡住 |
| 时长为 0 的 step 被当普通 step | 门在放行同帧被重新武装，演出播不下去 |
