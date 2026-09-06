# transition · 场景转场

```typescript
import { Transition, overlayStyle } from './transition/Transition';
```

- 依赖：`_core/math`
- 引擎耦合：**无**（加载函数由调用方注入）
- 测试：17 项

---

## 它解决什么

朴素写法：

```typescript
await fadeOut(300);
await loadScene(scene);
await fadeIn(300);
```

五个不做就会出问题的地方：

**1. 重入** — 玩家途中又点一次 → 两个转场同时跑 → 场景被加载两次。

**2. 输入未锁** — 淡出完成、场景还在加载时，点击会打到**正在卸载的旧场景**上。

**3. 加载无超时** — 卡住就是永久黑屏，玩家以为游戏崩了。

**4. 异常时锁不释放** — 加载抛错但 `finally` 没写 → 输入永久锁死。
游戏看起来还在跑，但什么都不响应。

**5. 进度条假死** — 淡出 0.3 秒、加载 8 秒。
进度条按转场时长算的话会在 0.3 秒跳到 100% 然后卡 7.7 秒。

---

## 用法

```typescript
const tr = new Transition(
  (scene) => myLoader.loadAsync(scene),
  { outMs: 300, inMs: 300, loadTimeoutMs: 30000, outProgressCap: 0.9 }
);

// 发起（转场中再次调用返回 false）
tr.start('town');

// 主循环（⚠️ 用真实时间）
tr.update(dtMs);

const st = tr.state;
myOverlay.opacity = st.overlay;
myProgressBar.value = st.progress;
myInput.enabled = !tr.shouldLockInput;

if (st.phase === 'failed') {
  showRetryDialog(tr.error, () => tr.retry());
}
```

**⚠️ 加载与淡出并行启动**，不是串行。
总时长从 `淡出 + 加载` 变成 `max(淡出, 加载)`。

---

## 三段式

```
out（淡出）→ load（加载）→ in（淡入）→ done
                  ↓ 失败/超时
                failed（保持遮罩，等上层决定）
```

| 阶段 | overlay | progress |
|---|---|---|
| out | 0 → 1 | 0 → `outProgressCap` |
| load | 1 | `cap` → 趋向 1（**永不到 1**） |
| in | 1 → 0 | 1 |
| done | 0 | 1 |
| failed | 1（保持） | `cap` |

---

## API

| 成员 | 说明 |
|---|---|
| `start(scene)` | 发起，转场中返回 `false` |
| `update(dt)` | 推进（真实时间） |
| `state` | 完整状态快照 |
| `busy` | 是否转场中 |
| `shouldLockInput` | 是否应锁输入（**失败时也是 true**） |
| `retry()` | 重试失败的加载 |
| `reset()` | 回到 idle |
| `history` | — |

## `overlayStyle(overlay)`

```typescript
const { opacity, visible } = overlayStyle(st.overlay);
```

**⚠️ `overlay=0` 时 `visible` 必须是 `false`。**
只设 `opacity=0` 的话，全屏遮罩节点依然会吃掉触摸事件，
表现为"转场结束后点不动了"。

## 坑

| 坑 | 后果 |
|---|---|
| `update` 用游戏时间 | 转场期间游戏时间不流动，转场永远走不完 |
| 加载串行而非并行 | 白白多出一个淡出时长的等待 |
| 无 `loadTimeoutMs` | 永久黑屏 |
| 失败时不锁输入 | 玩家在全黑画面上乱点 |
| 失败时立刻放遮罩 | 玩家看到一闪而过的半成品场景 |
| 忘记 `visible=false` | 转场结束后点不动 |

## 与 `scenerouter` 的区别

| | `transition` | `scenerouter` |
|---|---|---|
| 管什么 | 一次转场的**时序与遮罩** | 界面栈的**进出与转场锁** |
| 层级 | 场景级 | UI 级 |

两者可以配合：`scenerouter` 管"该显示哪个界面"，
`transition` 管"切过去时的黑屏和进度"。

---

## `forceComplete()`

强制跳到完成态。

> ⚠️ **别在产品里用它"跳过转场"（源码注释原话）。**
> 它会跳过"加载完成"的等待——
> 资源没就绪就淡入，表现为"刚切场景 UI 是空的/闪一下"。
> 玩家主动跳过应该走"通知加载完成"的路径，不是这个。
>
> 它的正当用途是**测试**和**异常恢复**（转场状态卡死时兜底）。
