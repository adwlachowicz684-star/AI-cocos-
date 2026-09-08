# fsm — 有限状态机

## 状态机 vs 行为树

| | 状态机 | 行为树 |
|---|---|---|
| 适合 | 互斥的、数量少的状态 | 复杂、可分层的决策 |
| 例子 | 角色：idle/run/jump/attack | AI：巡逻→发现→追击→撤退 |
| 状态数 | 5–15 个 | 任意 |
| 转换 | 显式声明 | 由节点返回值驱动 |

> **经验法则**：先用状态机。当状态超过 10 个，或者你开始写
> `if (state === 'chase' && hasLineOfSight && hp > 30%)` 这种复合条件时，换成行为树。

## 用法

```typescript
import { StateMachine } from './fsm/StateMachine';

interface Ctx { moved: boolean; jumped: boolean }

const fsm = new StateMachine<Ctx>({
  initial: 'idle',
  transitions: { idle: ['run', 'jump'], run: ['idle', 'jump'], jump: ['idle'] },
  states: {
    idle: {
      enter: (c, from) => c.anim.play('idle'),
      update: (c, dt) => { if (c.moved) return 'run'; },
      exit: (c, to) => {},
    },
    run: {
      update: (c, dt) => {
        if (c.jumped) return 'jump';
        if (!c.moved) return 'idle';
      },
    },
    jump: { enter: (c) => c.vy = c.jumpForce },
  },
  onChange: (from, to, ctx) => log(from, to),
});

fsm.start(ctx);          // 触发初始状态的 enter
fsm.update(ctx, dt);
fsm.current;             // 'run'
fsm.can('jump');         // 当前状态能否转过去
fsm.timeInState;         // 在当前状态待了多久
```

## 三个设计要点

**① 构造时不触发 enter（重要）**

构造函数里没有 context，调用 enter 会传 `undefined` 进去——
表现是"游戏一启动就报 Cannot read properties of undefined"。
这是被测试抓到的真实缺陷。副作用留给显式的 `start(ctx)`。

**② 显式声明 transitions**

朴素写法（update 里 if-else）无法知道"从 A 能到哪些状态"，
也无法发现不可达状态。`findUnreachable()` 能在启动时报出
"某个状态永远进不去"——这类 bug 运行时表现为"某个功能死活不触发"。

**③ 转换中不再接受新转换**

在 `enter` 里再调 `transitionTo` 会破坏状态一致性，被拦截并告警。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 构造时就用 ctx | `undefined` 解引用崩溃 | 用 `start(ctx)` |
| 在 enter/exit 里转换状态 | 状态不一致 | 被拦截，改到 update 里做 |
| 转换表写漏 | 状态永远进不去 | `findUnreachable()` 体检 |
| 一帧内连锁转换 | 跳过中间状态 | 转换后本帧不再跑新状态的 update |

## API

| 成员 | 说明 |
|---|---|
| `start(ctx)` | 触发初始状态的 enter |
| `update(ctx, dt)` | 每帧推进，update 返回状态名则转换 |
| `transitionTo(to, ctx)` | 强制转换，受 transitions 约束 |
| `can(to)` | 能否转换 |
| `current` / `timeInState` | 当前状态 / 停留时长 |
| `findUnreachable()` | **返回不可达状态列表** |
| `reset(ctx)` | 回到初始状态 |
| `destroy()` | 释放（**之后 onChange 不再触发**） |

**`StateMachineOptions`**：

| 字段 | 说明 |
|---|---|
| `initial` / `states` | 初始状态 / 状态表（**都必填**） |
| `transitions` | 允许的转换（`{ from: [to...] }`）。**省略 = 任意转换都允许** |
| `strict` | 严格模式（非法转换抛错而不是静默失败） |
| `onChange(from, to, ctx)` | 转换回调 |

> ⚠️ **`transitions` 省略时任意转换都允许。**
> 这方便原型阶段，但上线前应该补上——
> 配合 `findUnreachable()` 能静态查出配错的状态。

> ⚠️ **`strict` 决定非法转换是"抛错"还是"静默失败"。**
> 默认非严格：非法转换什么都不做，你会以为状态切了。
> 开发期建议开 `strict`——
> 把"配置错误"变成"立刻崩溃"而不是"几个月后才发现"。

**`StateHooks`**（状态表里的每一项）：

```typescript
{
  enter?:  (ctx, from) => void;
  update?: (ctx, dt) => string | undefined | void;   // 返回状态名 → 转换
  exit?:   (ctx, to) => void;
}
```

> ⚠️ **`update` 返回状态名会触发转换，这是"自动转换"的写法。**
> 返回 `undefined` 或什么都不返回则留在当前状态。
> 注意返回空串 `''` 是**一个状态名**（虽然它没定义），
> 会触发一次到 `''` 的非法转换。

> ⚠️ **`enter` 的 `from` 在初始状态时是 `null`。**
> 同 `gameflow`——想区分"首次进入"和"从别处切回"就判它。

> ⚠️ **`destroy()` 之后回调不再触发。**
> 换场景时只 `reset()` 不 `destroy()` 的话，
> 旧状态机的监听还挂着——新场景里转换状态会触发上一局的副作用。
