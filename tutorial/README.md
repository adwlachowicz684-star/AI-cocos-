# tutorial · 新手引导

> ⚠️ **写完代码必须同时完成三件事**：① 测试 ② README ③ 登记进 `_kitmeta.json`

---

## 它解决什么

引导是玩家看到的第一段内容，也是最容易做砸的。
手写的 `if (step === 3 && player.moved) step = 4` 长链，
一旦中途要插入一步，后面所有编号都要改。

真正难的是五件事：

1. **推进条件要能等待** — "等玩家移动到某处"，不是点一下就下一步
2. **可跳过但要能续上** — 跳过后下次从断点继续，而不是从头再来
3. **不能卡死** — 条件永远不满足时玩家彻底卡住，必须超时兜底
4. **存档要容错** — 版本更新后步骤变了，旧存档指向不存在的步骤
5. **强制与软引导** — 前者锁输入，后者只是高亮提示

## 用法

```typescript
const t = new Tutorial<Ctx>({
  steps: [
    { id: 'move', kind: 'tap', text: '点击任意处开始' },
    {
      id: 'attack', kind: 'wait', text: '移动一下',
      until: (c) => c.moved,
      timeoutMs: 8000,
    },
    {
      id: 'bag', kind: 'waitAndTap', text: '打开背包',
      until: (c) => c.bagOpened, target: 'btn_bag',
    },
    { id: 'done', kind: 'tap', text: '完成', skipIf: (c) => c.isVeteran },
  ],
  context: ctx,
});

t.start();
t.update(dt);      // 驱动等待与超时
t.tap();           // 玩家点击

// 存档
const saved = t.exportState();     // { done, resumeAt, finished }
t2.importState(saved);             // 自动从 resumeAt 续上
```

## 三种 kind

| kind | 行为 | 点击 |
|---|---|---|
| `tap` | 等待点击 | 推进 |
| `wait` | 等条件满足（**自动推进**） | **忽略** |
| `waitAndTap` | 等条件满足后**再**点一下确认 | 条件不满足时无效 |

> ⚠️ 本节标题曾写作"四种 kind"，而 `TutorialEventKind` 实际只有 3 个取值，
> 表格也一直是 3 行。**是标题写错了，不是漏了一种**——
> 已核对源码的全部 kind 分支（`Tutorial.ts` 里只有 3 个判断），确认无误。

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **wait 步骤忽略点击** | 如果点击也能推进，玩家会在条件没达成时跳过教学 |
| **必须有超时兜底** | 条件永远不满足 = 玩家彻底卡死。宁可引导不完整也不能卡死 |
| **超时不作用于 tap 步骤** | 否则玩家看文案慢一点就被自动跳过 |
| **skipIf 由被跳过的那一步自己声明** | 不是写在前面的步骤上 |
| **被跳过的步骤也算"已完成"** | 否则统计和续引导会错位 |
| **startAt 找不到步骤时从头开始** | 版本更新后 id 变了，从头来一遍比对不上号崩溃好 |
| **modal 要谨慎用** | 强制引导让玩家觉得被剥夺控制权，只在最关键的第一步用 |

## 完整接口

| 成员 | 说明 |
|---|---|
| `start()` / `startAt(stepId)` | 从头开始 / 从指定步骤开始 |
| `update(dt)` | 驱动等待与超时（**每帧调**） |
| `tap()` | 玩家点击，返回是否被消费 |
| `skip()` / `skipStep()` | 跳过全部 / 跳过当前一步 |
| `state()` | 当前状态 |
| `index()` / `current()` | 当前步骤下标 / 步骤对象（**全完成时为 null**） |
| `progress()` | 完成进度 0~1 |
| `elapsed()` / `remaining()` | 当前步已用时 / 剩余时间（**无超时限制时为 Infinity**） |
| `done()` | 已完成步骤的 id 列表 |
| `isDone(stepId)` | 某步是否已完成 |
| `resumePoint()` | 断点续的位置（`null` = 无断点） |
| `exportState()` / `importState(s)` | 存档 |

> ⚠️ **`current()` 在全部完成时返回 `null`，不是最后一步。**
> 不判空直接读 `current().id` 会抛 `TypeError`——
> 而且只在引导走完的那一刻发生，测试时很容易漏。

> ⚠️ **`remaining()` 在没有 `timeoutMs` 的步骤上返回 `Infinity`。**
> 拿它做倒计时 UI 会显示 "Infinity"。
> 用之前先判断 `Number.isFinite()`。

> ⚠️ **`skip()` 和 `skipStep()` 不一样。**
> `skip()` 跳过**整个引导**并标记为已完成；
> `skipStep()` 只跳过当前这一步，继续下一步。
> 做"跳过引导"按钮要用 `skip()`——
> 用 `skipStep()` 的话玩家会一直看到引导在往下走。

> **`resumePoint()` 是断点续的关键。**
> 玩家中途退出后重新进入，从 `resumePoint()` 继续而不是从头——
> 重看一遍已经做过的引导是劝退的主要原因之一。

### `startAt` 与断点续的区别

`startAt(stepId)` 是**强制**从某步开始（调试、分支用）；
`importState()` 是**恢复**到存档时的位置。
前者会重置 `done` 列表的推进状态，后者不会。

### `TutorialEventKind`

```
'tap' | 'wait' | 'waitAndTap'
```

> ⚠️ **`wait` 和 `waitAndTap` 的 `until` 是必填的**（`tap` 不需要）。
> 不填会在 `start()` 时抛错——
> 这是构造期校验，不会等到运行时才发现。

### `TutorialStep`

```typescript
{
  id: string;              // 唯一 id（存档、isDone 用）
  kind: TutorialEventKind;
  text?: string;           // 提示文案
  target?: string;         // 要高亮的目标（UI 元素 id / 世界物体 id，业务自己解释）
  until?: (ctx) => boolean;// 完成条件（wait / waitAndTap 必填）
  timeoutMs?: number;      // 超时（毫秒）
  /* 还有：force / skipIf 等，见源码 */
}
```

> ⚠️ **`timeoutMs` 强烈建议填**。
> 条件永远不满足时玩家会彻底卡死，
> 超时后自动推进——宁可引导不完整也不能卡住。

### `TutorialOptions`

| 字段 | 说明 |
|---|---|
| `steps` | 步骤列表（**必填**） |
| `context` | 上下文对象，`until` 的参数（**必填**） |
| `onChange(step, index)` | 步骤变化回调（**刷新 UI 用这个**） |
| `onFinish()` | 全部完成回调 |
| `defaultTimeoutMs` | 全局默认超时（步骤没填 `timeoutMs` 时用） |

> **`onChange` 的 `step` 在全部完成时是 `null`**，
> 和 `current()` 一致。用它隐藏引导 UI 正好。

### `TutorialState`

```
'idle' | 'running' | 'finished'
```

> ⚠️ **没有 'skipped' 状态。**
> `skip()` 之后直接变成 `'finished'`——
> 想区分"正常完成"和"跳过"的话，
> 用 `done()` 的长度或者自己记一个标志。

## 设计：为什么 until 是函数而不是事件名

"玩家拥有 3 个遗物"、"玩家血量低于 30%" 这类条件用事件名表达不了，
而引导恰恰经常需要这种"状态型"条件。

函数让引导可以检查任意状态，代价是每帧调用——
所以条件函数必须**廉价且无副作用**。

## 测试

**35 项**，覆盖等待/超时/跳过/断点续/存档容错/skipIf 链。
