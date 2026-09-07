# scenerouter · 场景路由

> ⚠️ **写完代码必须同时完成三件事**：① 测试 ② README ③ 登记进 `_kitmeta.json`

---

## 它解决什么

"主菜单 → 关卡 → 结算 → 回主菜单"，中间夹着加载界面和转场动画。
手写的 `director.loadScene('game')` + 全局 `isLoading` 会遇到：

1. **并发切换** — 玩家连点两次，加载两次场景，第二个覆盖第一个
2. **转场没播完就切** — 淡出还没结束就 load，表现为黑屏闪一下
3. **进度条不动** — 加载回调被吞，进度条停在 0.9 卡住
4. **返回栈** — "返回上一场景"要记住来路，手写是一堆 `fromScene` 参数层层传

## 用法

```typescript
const r = new SceneRouter({ outMs: 300, inMs: 300, initial: 'menu' });

// 宿主的每帧循环里
function tick(dtMs: number) {
  switch (r.phase) {
    case 'out':  playFadeOut(r.state.progress); break;
    case 'load': /* 引擎加载中 */ break;
    case 'in':   playFadeIn(r.state.progress); break;
  }
  r.tick(dtMs);
}

// 宿主加载完成时
engine.loadScene(name, () => r.notifyLoaded());

r.goTo('game', { level: 3 });       // 入返回栈
r.go({ to: 'menu', pushHistory: false });  // 回程，不入栈
r.back();                            // 返回上一场景

// 查询
r.current;      // 当前场景名（未就绪时为 null）
r.busy();       // 是否正在切场
r.history();    // 返回栈
```

## 四个阶段

```
idle → out（旧场景退场）→ load（加载）→ in（新场景入场）→ idle
```

**本模块不认识任何引擎 API**，只管编排顺序与状态。
宿主在对应阶段去做引擎相关的事。

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **切换中拒绝新请求** | 连点两次会加载两次场景，表现为"关卡被创建了两份" |
| **加载必须有超时兜底** | 回调永远不来时玩家永远卡在加载界面 |
| **`pushHistory: false` 给回程用** | 结算回主菜单入栈的话，按返回键又会回到结算界面 |
| **back 至少保留一层** | 历史只剩当前场景时返回 false，而不是把当前场景 pop 掉 |
| **`notifyLoaded` 幂等** | 重复调用不造成状态错乱 |
| **非 load 阶段调 notifyLoaded 无副作用** | 还在播退场动画时不该提前切换 |
| **历史上限 32** | 防止来回切几百次后数组无限增长 |
| **`tick` 的单位是毫秒** | 全库其余单元的 `dt` 都是**秒**，只有这里是毫秒。参数名 `dtMs` 就是提示：`outMs = 300` 时按秒传 `1/60` 要走 600 秒，按毫秒传 `16.67` 只要 0.6 秒。按秒传**不报错**，只会表现为"转场慢到像卡住" |
| **`load` 阶段 `progress` 恒为 0** | 加载进度只有宿主的加载回调才知道，本模块拿不到。想做进度条请自己按引擎回调维护 0~1，资源就绪后调 `notifyLoaded()` |
| **不用了要 `destroy()`** | `onChange` 闭包通常持有场景节点 / 进度条 UI，不断开会泄漏 |

### 查询接口

| 成员 | 说明 |
|---|---|
| `current()` | 当前场景名（**未就绪时为 `null`**） |
| `busy()` | 是否正在切场（out / load / in 任一阶段） |
| `history()` | 返回栈（只读） |

> ⚠️ **`current()` 在切场过程中会变，不是"稳定的当前场景"。**
> 它在 `load` 阶段结束、`in` 阶段开始时切换。
> 想在转场黑幕期间读"目标场景"，应该用 `goTo` 的入参自己记，
> 而不是读 `current()`——
> 表现为"过场动画配错了场景"。

> ⚠️ **`busy()` 为 true 时 `goTo` 会被拒绝。**
> 这是"连点两次按钮导致切两次场景"的正规防线。
> 不看它的话，玩家快速连点会看到转场动画播两遍，
> 且第二次的目标场景可能是错的。

> ⚠️ **`history()` 是"返回栈"，不是"访问过的所有场景"。**
> `pushHistory: false` 的跳转不会进栈——
> 所以从菜单进游戏、再从游戏回菜单，
> `history()` 里**没有**菜单（那是回程）。

### 类型

**`RoutePhase`**：

```
'idle'   空闲
'out'    旧场景退场（播转出动画）
'load'   加载中
'in'     新场景入场（播转入动画）
```

> ⚠️ **四个阶段都要处理，尤其是 `load`。**
> 在 `load` 阶段宿主必须真正去加载场景并回调 `notifyLoaded()`——
> 不回调的话会一直卡在 load，
> 表现是"转场黑幕永远不散"。

**`RouteState`**（`state` 的完整结构）：

```typescript
{
  phase: RoutePhase;                 // 当前阶段
  current: string | null;            // 当前场景
  target: string | null;             // 目标场景（切场中才有意义）
  progress: number;                  // 当前阶段的进度 0~1
  history: readonly string[];        // 返回栈
  params: Readonly<Record<string, unknown>> | null;   // 传入的参数
}
```

> ⚠️ **`progress` 是"当前阶段"的进度，不是整个转场的。**
> 拿它画一条从 0 到 1 的总进度条会得到"走了四段 0→1"的抖动效果。
> 要总进度得自己按阶段加权。

> **`params` 在 `in` 阶段之后才有值。**
> 新场景想读传入的参数（示例里的 `{ level: 3 }`），
> 在 `out` / `load` 阶段读到的是 `null`。

**`RouteRequest`**（`go()` 的参数）：

```typescript
{
  to: string;                     // 目标场景
  pushHistory?: boolean;          // 是否入返回栈
  params?: Readonly<Record<string, unknown>>;
  outMs?: number; inMs?: number;  // 覆盖默认的转场时长
}
```

> ⚠️ **`goTo(to, params)` 是 `go()` 的简化版，它 `pushHistory` 恒为 true。**
> 想不入栈必须用 `go({ to, pushHistory: false })`——
> 用 `goTo` 回主菜单的话，返回栈里会堆积一堆菜单，
> 玩家按返回键会"回到"上一个菜单而不是退出游戏。

**`SceneRouterOptions`**：

| 字段 | 说明 |
|---|---|
| `outMs` / `inMs` | 转场动画时长（毫秒） |
| `loadTimeoutMs` | 加载超时（**超时会强制推进**） |
| `initial` | 初始场景名 |
| `onChange(phase, scene)` | 阶段变化回调（**驱动转场动画用这个**） |

> ⚠️ **`loadTimeoutMs` 是防卡死的兜底。**
> 宿主忘了调 `notifyLoaded()` 时，超时后强制进 `in` 阶段。
> 没有它的话，一次加载失败就让游戏永远停在黑幕里。

## 设计：为什么是"阶段机"而不是异步函数

```typescript
await fadeOut(); await load(); await fadeIn();   // 看起来更简洁
```

异步写法的问题是**无法中途取消**。
玩家在加载中途按了返回键、或者切后台回来，
异步链会继续跑到结束，然后切到一个已经不想要的场景。

阶段机让宿主每帧看到当前阶段，
可以随时 `skipPhase()` 或重新 `go()`（虽然切换中会被拒绝，但至少状态是可见的）。

## 测试

**28 项**，覆盖并发拒绝、返回栈截断、超时兜底、幂等、历史上限、参数透传。
