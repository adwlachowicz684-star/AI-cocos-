# command · 命令模式 + 撤销重做

> 把「做」和「撤」绑在一起，避免撤销只撤一半。

## 1. 它解决什么

撤销功能散落在业务里写，典型结果是**撤销了一半**：

- 撤销建造，但资源没退还
- 撤销删除，但选中状态没恢复
- 连点两下撤销，状态错乱（没有事务边界）

根本原因是**一个操作的「做」和「撤」写在两处**，加新功能时很容易只改一半。

命令模式把它们绑在一个对象里：

```typescript
stack.do({
  name: '建造箭塔',
  execute: () => { world.place(id, x, y); gold -= 50; },
  undo:    () => { world.remove(id);      gold += 50; },
});
```

## 2. 五分钟上手

```typescript
import { CommandStack, setValueCommand } from './command/CommandStack';

const stack = new CommandStack({ limit: 100 });

// ① 基本撤销
stack.do({ name: '改为 5', execute: () => set(5), undo: () => set(0) });
stack.undo();     // 回到 0
stack.redo();     // 回到 5

// ② 属性面板（占撤销需求的 80%）
stack.do(setValueCommand('血量', () => hp, v => hp = v, 200));

// ③ 事务：多条子命令合并成一条
stack.transact('移动 3 个物件', () => {
  for (const o of selected) stack.do(moveCmd(o, dx, dy));
});
// 撤销一次 → 三个全部归位
```

## 3. 四个核心能力

### 事务（transact）

「移动一个物体」可能由多条子命令组成。事务让它们合并成一条，**撤销一次全部回退**。

支持嵌套，只有最外层提交时才入栈。

```typescript
stack.transact('批量操作', () => {
  stack.do(cmdA);
  stack.do(cmdB);
  throw new Error('中途失败');   // → 已执行的自动回滚
});
```

### 命令合并（mergeKey）

拖动滑块会连续产生几十条命令。带 `mergeKey` 时它们合并成一条：

```
拖动前 x = 10
产生命令：10→11, 11→12, 12→13
合并后：  一条「10→13」
撤销一次：回到 10   ← 玩家期望的
```

合并的做法是**让旧命令采用新值**，而不是把新命令入栈。

### 不可逆命令（undoable: false）

提交订单、播放过场这类操作：清 redo 栈，但自己不进 undo 栈。

### 栈深度上限

`limit`（默认 100）。超出后丢弃最早的，避免长会话内存无限增长。

## 4. 与 snapshot 的区别

| | CommandStack | snapshot |
|---|---|---|
| 原理 | 行为反演 | 状态快照（diff + 补丁） |
| 适合 | 撤销一个用户动作 | 存档、回滚一大片 |
| 体积 | 极小 | 较大 |
| 名字 | 有（「撤销 建造箭塔」） | 无 |

**判据**：你能写出 undo 的逻辑吗？
- 能 → 用 CommandStack（精确、小、可带名字）
- 不能（一次复杂模拟）→ 用 snapshot

## 5. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| `commit()` 里又执行一次 `execute()` | 建造一次扣 100 金币而不是 50 | 事务内的命令在 `do()` 时**已执行过**，入栈的是「已完成的集合」，只有重做才重放 |
| 清理时调用会触发副作用的方法 | 清理函数若逐个调用释放逻辑，被释放者会让后面的补位，残留一个从未收到通知的令牌 | 先静默摘除，再统一通知 |
| 用 `oldValue === undefined` 判断"是否已记录" | T 本身可为 undefined 时，undo 永远失效 | 用独立布尔标志 |
| 事务中途抛错不回滚 | 界面显示失败，世界已改一半 | 用 `transact()`，它自带 try/catch |
| 撤销顺序错了 | 有关联的操作上出问题 | 逆序撤销 |

## 5.5 `CommandStack` 完整接口

| 成员 | 说明 |
|---|---|
| `do(cmd)` | 执行并入栈（**已在 `do()` 内部执行过**） |
| `undo()` / `redo()` | 撤销 / 重做一步，返回是否成功 |
| `undoMany(n)` / `redoMany(n)` | 多步，返回**实际执行了几步** |
| `canUndo()` / `canRedo()` | 是否可撤销 / 重做 |
| `undoDepth()` / `redoDepth()` | 栈深度 |
| `nextUndoName()` / `nextRedoName()` | 下一步的名字（`null` = 没有） |
| `inTransaction()` | 是否在事务中 |
| `begin(name?)` / `commit()` / `rollback()` | 事务三件套 |
| `clear()` / `clearHistory()` | 清空（见下） |
| `snapshot()` | 返回 `CommandStackSnapshot` |

> ⚠️ **`clear()` 与 `clearHistory()` 不是一回事。**
> `clearHistory()` 只清历史，**当前状态保留**（玩家已放置的建筑不动）；
> `clear()` 是彻底重置。
> 换关卡应该用 `clearHistory()`——
> 用 `clear()` 的话，如果栈里还挂着待执行的引用，会一起丢掉。

> ⚠️ **`undoMany(n)` 返回的是实际步数，不是布尔。**
> 栈里只有 3 步时 `undoMany(10)` 返回 `3`。
> 当布尔用的话"部分成功"会被当成"完全失败"，逻辑就反了。

> **`nextUndoName()` 是做撤销菜单的正道。**
> 比 `snapshot().undoNames[0]` 直接——
> 不用判空数组，且语义明确（"下一步撤销什么"）。

### 事务：`transact()` vs `begin`/`commit`

文档第 3 节推荐用 `transact()`，因为它**自带 try/catch**：

```typescript
stack.transact('放置建筑', () => {
  stack.do(new PlaceCmd(...));
  stack.do(new SpendCmd(...));
});
// 抛错自动 rollback
```

手写 `begin()` / `commit()` 时，中途抛错**不会回滚**——
世界里已经改了一半，界面却显示"操作失败"。

> **`commit()` 返回合成的 `ICommand`，可以再 `do()` 一次。**
> 但坑表格里那条要记住：事务内的命令在 `do()` 时**已执行过**，
> `commit()` 不会重放，只有重做才重放。

### `CommandStackOptions`

| 字段 | 说明 |
|---|---|
| `limit` | 栈深度上限（超出丢弃**最老的**） |
| `onChange` | 栈变化时回调（**刷新撤销按钮的可用状态**） |
| `onLog` | `(action, cmd)` —— 每次 do/undo/redo 都回调 |
| `undoNames` / `redoNames` | 名字列表（**栈顶在前**，同 `snapshot()`） |

> ⚠️ **`limit` 超限丢弃的是最老的记录，不是拒绝新命令。**
> 超限时**不会**报错或返回 false——
> 只是最早的那些操作再也撤销不回去了。
> 表现为"撤销到一半突然不能撤了"。

> **`onChange` 是刷新 UI 的唯一正确时机。**
> 自己每帧轮询 `canUndo()` 也能用，
> 但只有 `onChange` 能保证按钮状态和栈**严格同步**——
> 轮询会有一帧的延迟，快速连点时能看到按钮闪一下。

## 6. 测试覆盖

33 项。重点覆盖：
- 事务的 commit / rollback / 嵌套
- 合并语义（含 T 可为 undefined 的边界）
- redo 后不覆盖最初记录的旧值
- 命令 execute 抛错时不入栈

## 7. 依赖

`../_core/types` 无。零依赖，纯逻辑。

---

## 返回值结构

### `CommandStackSnapshot`

```typescript
interface CommandStackSnapshot {
  undoNames: readonly string[];   // 可撤销的命令名（**栈顶在前**）
  redoNames: readonly string[];   // 可重做的命令名
}
```

> **做"撤销/重做"菜单时用这两个数组**——
> 玩家看到的应该是"撤销：放置城墙"这种带名字的条目，
> 而不是"撤销（3）"。
>
> ⚠️ **顺序是栈顶在前**，直接拿 `undoNames[0]` 显示"下一步撤销什么"是对的；
> 当成时间正序（最老的在前）会显示错。