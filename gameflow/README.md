# gameflow · 流程状态机

**主菜单 → 游戏中 → 暂停 → 结算 → 回主菜单**

---

## 它解决什么

每个游戏都有这条链路。手写的做法是散落各处的 `setState('menu')`，
配上每个状态里的 `if (currentState === ...)`。

三五个状态还能忍，加上设置、图鉴、商店、二次确认之后：

- 从暂停直接跳结算，忘了清理战斗数据
- 结算界面按返回，回到了**还是暂停着的**界面
- 两次快速点击，同一个状态被进入了两次

本模块把「状态」和「允许的转换」显式列出来，非法转换**直接拒绝**，
而不是留下一个诡异的中间态。

## 用法

```typescript
const flow = new GameFlow<Ctx>({
  defs: [
    { id: 'boot',    enter: loadSave,  transitions: [{ to: 'menu', when: (c) => c.saveLoaded }] },
    { id: 'menu',    enter: showMenu,  transitions: [{ to: 'playing', when: () => true }] },
    { id: 'playing', enter: startRun,  transitions: [
        { to: 'paused', when: () => true },
        { to: 'result', when: () => true },
      ]},
    { id: 'paused',  enter: pauseGame, transitions: [{ to: 'playing', when: () => true }] },
    { id: 'result',  enter: showResult, transitions: [{ to: 'menu', when: () => true }] },
  ],
  initial: 'boot',
  context: gameContext,
  onChange: (from, to) => console.log(from, '→', to),
});

flow.goTo('menu');        // 返回 false 表示非法转换
flow.canGoTo('result');   // 只查询不改变状态
flow.force('menu');       // 无视转换表（调试/紧急恢复）
flow.back();              // 回到上一个状态（也检查合法性）
flow.update(dt);          // 驱动 auto 转换 + 累计 timeInState
```

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **初始状态也触发 enter** | 不触发的话，boot 里的加载逻辑永远不执行——表现为"第一次进游戏黑屏，第二次就好了" |
| **转换中的嵌套切换被拒绝** | 在 `enter` 回调里调 `goTo` 会导致 exit/enter 顺序错乱，直接返回 false |
| **`back()` 也检查转换合法性** | 它不是无条件的撤销。result 只能回 menu，不能回 playing |
| **负 dt 不让 timeInState 倒流** | 切后台、时间校准都可能给负 dt |
| **history 有上限** | 默认 32，且保留初始状态，防内存增长 |
| **`goTo` 同一状态默认无操作** | 需要重入用 `{ allowSelf: true }` |

## 完整接口

| 成员 | 说明 |
|---|---|
| `goTo(to, opts?)` | 切换，返回是否成功（**非法转换返回 false**） |
| `canGoTo(to)` | 只查询不改变状态 |
| `force(to)` | **无视转换表**（调试 / 紧急恢复） |
| `back()` | 回到上一个状态（**也检查合法性**，见设计章节） |
| `update(dt?)` | 驱动 auto 转换 + 累计 `timeInState` |
| `current()` | 当前状态 id |
| `context()` | 上下文对象（`when` 回调的入参） |
| `history()` | 历史栈（**有上限，默认 32**） |
| `timeInState()` | 在当前状态停留了多久 |
| `states()` | 全部状态定义 |
| `get(id)` | 取某个状态定义（`undefined` = 不存在） |
| `availableTargets()` | 当前状态**所有合法**的下一站 |
| `isTransitioning()` | 是否正在切换中 |
| `reset()` | 回到初始状态 |

> ⚠️ **`availableTargets()` 是做"流程调试面板"的关键。**
> 它列出当前能去哪，比翻转换表直观得多。
> 用它还能做"灰色不可达按钮"——在 `canGoTo()` 之前就知道该不该显示。

> ⚠️ **`isTransitioning()` 为 true 时 `goTo` 一定返回 false。**
> 这是坑表格里"嵌套切换被拒绝"的检测手段：
> 在 `enter` 回调里调 `goTo` 时，它还是 true。
> 想在 enter 里跳转的话，改用 auto 转换（`when` 返回 true）。

> ⚠️ **`history()` 有上限（默认 32）且会丢最老的。**
> 长流程里 `back()` 可能回不到最初的状态——
> 它保留初始状态（坑表格里那条），
> 但中间的会被挤掉。

> **`timeInState()` 在切换时归零**，
> 做"在这个状态待够 N 秒就自动 XX"的逻辑时直接用它，
> 不用自己记时间戳。

### 类型

**`FlowStateDef`**：

```typescript
{
  id: string;
  enter?: (ctx, from) => void;        // 进入时（from 为 null 表示初始状态）
  exit?:  (ctx, to) => void;          // 离开时
  update?:(ctx, dt) => void;          // 每帧
  transitions?: readonly FlowTransition<Ctx>[];
  desc?: string;                       // 描述（调试面板用）
}
```

**`FlowTransition`**：

```typescript
{
  to: string;
  when: (ctx) => boolean;   // 是否允许这个转换
  auto?: boolean;           // true = 条件满足时自动切（不用手动 goTo）
  desc?: string;
}
```

> ⚠️ **`auto` 的转换在 `update()` 里检查，不调 `update()` 就永远不触发。**
> 忘了每帧调 `update(dt)` 的表现是"状态机卡住不动"——
> 而手动 `goTo` 是正常的，很容易误判成转换表写错了。

> ⚠️ **`enter` 的 `from` 在初始状态时是 `null`。**
> 想区分"第一次进入"和"从别处切回来"就判它。
> 不判的话，读档进游戏和从菜单进游戏会走同一段逻辑。

**`GameFlowOptions`**：

| 字段 | 说明 |
|---|---|
| `defs` / `initial` / `context` | 状态定义 / 初始状态 / 上下文（**都必填**） |
| `onChange(from, to)` | 切换回调 |
| `historyLimit` | 历史上限（默认 32）。**合法区间 `[1, 10000]`**，`0` 不代表"不限制" |

> ⚠️ **`historyLimit` 传 0 / 1 / NaN 都不会得到"不保留历史"。**
> 这些值曾让裁剪逻辑反向生效（历史每次切换还多涨 1~2 条，长会话下无限增长）。
> 现在统一夹到 `[1, 10000]`：非法值回落 32，**最小只能设到 1**。
> 想要"不保留历史"就不要用 `back()`，或自己维护一个长度 1 的历史。

**`GoToOptions`**：

```typescript
{ force?: boolean; allowSelf?: boolean }
```

> ⚠️ **`allowSelf` 默认 false——切换到当前状态是"无操作"。**
> 需要重入（比如"重新开始这一关"）必须显式传 `{ allowSelf: true }`，
> 否则 `goTo` 返回 false，你会以为转换表没配对。

> ⚠️ **`force` 只在紧急恢复时用。**
> 它绕过所有 `when` 检查和业务约束，
> 生产代码里出现它基本等于"这里有个没想清楚的转换"。

## 设计：为什么 `back()` 要走转换检查

它是"回到上一个状态"，不是"撤销上一步"。

`result → playing` 在转换表里不存在（结算了就不能回到战斗），
所以 `back()` 必须拒绝——哪怕 history 里上一项确实是 playing。

无条件回退会绕过所有业务约束，这正是手写状态机最容易出的那类 bug。

## 测试

**41 项**，覆盖 exit/enter 顺序、嵌套切换保护、历史上限、auto 转换优先级、
timeInState 归零与负 dt、四条构造校验、以及"结算不能直接回暂停"这条真实场景。
