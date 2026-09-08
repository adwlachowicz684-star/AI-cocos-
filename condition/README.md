# condition — 条件引擎（成就 / 任务 / 解锁）

## 它解决什么

成就、任务、解锁条件本质都是同一件事：**"检查一组条件是否满足，并在某个时机触发"**。

手写的话：100 个成就 = 100 个 if，分散在代码各处，
无法在策划表里配置、无法在 UI 上显示进度、加新统计项要回头改所有成就。

条件引擎把条件**数据化**：

```typescript
{ id: 'slayer',
  logic: 'and',
  conditions: [
    { stat: 'kill:skeleton', op: '>=', value: 20 },
    { stat: 'floor',         op: '>=', value: 3 },
  ] }
```

## 与"成就系统"的边界

本引擎只管**条件是否满足 + 进度是多少**。
成就的展示、奖励发放由外部处理。职责单一，更好复用。

## 用法

```typescript
import { ConditionEngine } from './condition/ConditionEngine';

const engine = new ConditionEngine();

engine.register({ id: 'first_blood', conditions: [{ stat: 'kill:any', op: '>=', value: 1 }] });
engine.register({
  id: 'slayer',
  logic: 'and',
  conditions: [
    { stat: 'kill:skeleton', op: '>=', value: 20 },
    { stat: 'floor',         op: '>=', value: 3 },
  ],
});

// 游戏事件驱动
engine.addStat('kill:skeleton', 1);
engine.addStat('kill:any', 1);
engine.setStat('floor', 3);

const newly = engine.check();      // 返回**本次新完成**的 id
engine.progress('slayer');         // 0.3（UI 进度条）
engine.list();                     // 全部定义 + 进度（成就列表界面）
```

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 每次 check 都重复触发奖励 | 玩家刷奖励 | `check()` 只返回**新完成**的 |
| 统计项命名不一致 | 条件永远不满足 | 用统一前缀（`kill:xxx`、`floor`） |
| 混用 setStat / addStat | 计数被覆盖 | 累加用 `addStat` |
| 自定义逻辑塞进 stat | 表达不出来 | 用 `custom` 回调 |
| 成就数量多时每帧 check | 浪费 | 只在数据变化时 check |

## API

| 成员 | 说明 |
|---|---|
| `register(def)` | 注册定义 |
| `setStat(name, v)` / `addStat(name, d)` | 设置 / 累加统计项 |
| `check()` | 检查全部，**返回新完成的 id 数组** |
| `evaluate(id)` | 检查单个，返回 `{progress, completed}` |
| `progress(id)` | 进度 0–1（UI 用） |
| `list()` | 全部定义 + 进度 |
| `isCompleted(id)` | 是否已完成 |
| `onComplete(fn)` | 完成回调 |
| `export()` / `import()` | 存档 |

**未在上面列出的**：

| 成员 | 说明 |
|---|---|
| `unregister(id)` | 注销定义，返回是否成功 |
| `getStat(name)` | 读单个统计项（不存在返回 `0`，不抛错） |
| `stats()` | 全部统计项的只读快照 |
| `reset()` | 清空统计与完成记录 |
| `destroy()` | 释放（**之后不能再调**） |

> ⚠️ **`register()` 返回 `this`，可以链式调用。**
> 这不算 bug，但别拿它当"是否注册成功"的判断——
> 重复注册同一个 id 也返回 `this`（覆盖旧定义）。

> ⚠️ **`getStat()` 对不存在的项返回 `0` 而不是抛错。**
> 好处是条件不会崩；代价是**统计项名拼错时静默失败**——
> 条件永远不满足，而你看不出是拼错了还是没触发。
> 这正是坑表格里"统计项命名不一致"那条的成因。

> ⚠️ **`reset()` 会连完成记录一起清。**
> 只想重置统计、保留已完成成就的话，
> 要自己保存 `export()` 的结果再恢复。

> **`destroy()` 之后不能再用。**
> 换关卡时如果只 `reset()` 不 `destroy()`，
> 旧的完成回调还挂着——新关卡达成条件时会触发上一关的奖励。

## 支持的操作符

`>` `>=` `<` `<=` `==` `!=`，逻辑 `and` / `or`。

### 类型

```typescript
type CompareOp = '>' | '>=' | '<' | '<=' | '==' | '!=';
type LogicOp   = 'and' | 'or';
```

**`Condition`**（单个子条件）：

```typescript
{ stat: string; op: CompareOp; value: number }
```

**`ConditionDef`**：

```typescript
{
  id: string;
  conditions: readonly Condition[];   // 子条件列表
  logic?: LogicOp;                    // 多个子条件如何组合
  custom?: (stats) => boolean;        // 自定义逻辑
}
```

> ⚠️ **`logic` 省略时默认是 `'and'`。**
> 想表达"任一满足"必须显式写 `logic: 'or'`——
> 漏写的表现是"成就死活不解锁"，
> 而单个子条件时看不出区别（只有一个条件，and/or 等价）。

> ⚠️ **`custom` 的入参是"全部统计项"，不是单个值。**
> 它接收 `Readonly<Record<string, number>>`，
> 可以检查任意组合。与此相对，
> `conditions` 里只能做单个统计项的比较。
> 表达不出来的条件（"同时有 A 遗物和 B 遗物"的复杂判断）用它。

**`ConditionResult`**（`evaluate()` / `list()` 的返回）：

```typescript
{ id: string; progress: number; completed: boolean }
```

> **`progress` 无论完成与否都会算**，
> 已完成的条件返回 `1`。
> 做进度条 UI 时不用自己判断是否完成。
