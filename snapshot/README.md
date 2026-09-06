# snapshot — 快照、差异、撤销

## 三个用途

| 用途 | 场景 |
|---|---|
| **撤销/重做** | 建造模式、捏脸、技能树加点 |
| **增量存档** | 大型存档只存变化，快一个数量级 |
| **状态同步** | 联机/回放只发变化的部分 |

## deepClone

```typescript
const copy = deepClone(state);
```

**为什么不用 `JSON.parse(JSON.stringify())`**：
- 丢失 `undefined`
- `Date` 变成字符串
- `Map` / `Set` 变成 `{}`
- **遇到循环引用直接抛异常**（游戏对象互相引用很常见）

**为什么不用 `structuredClone`**：老环境没有。本实现处理了
Date / Array / Map / Set / 循环引用。

## 差异比对

```typescript
const d = diffSnapshots(before, after, maxDepth = 10);
// { changed: [{path:'player.hp', from:100, to:80}], added: [], removed: [], hasChanges: true }
```

`maxDepth` 默认 10：深层嵌套的树比对很慢，而游戏状态通常不需要
精确到"第 8 层的某个数变了"——知道"这个对象变了"就够了。

## 补丁（增量存档）

```typescript
const patch = createPatch(before, after);   // { set: {path: value}, remove: [path] }
saveToDisk(patch);                          // 体积远小于全量

const restored = applyPatch(before, patch); // 不修改 before
```

支持数组下标路径：`items[3].hp`。

## 撤销栈

```typescript
const undo = new UndoStack<GameState>({ limit: 50 });

let state = { hp: 100 };
undo.push(state);           // ← 在改动**之前**记录
state = { hp: 80 };
undo.push(state);
state = { hp: 60 };

const back = undo.undo(state);       // → { hp: 80 }
const back2 = undo.undo({ hp: 80 }); // → { hp: 100 }
const fwd = undo.redo({ hp: 100 });  // → { hp: 80 }
```

> **push 应在改动之前调用**——它记录的是"可以回到这个状态"。
> 撤销后再做新操作，redo 栈会被清空（所有撤销系统的标准行为）。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 用 JSON 往返做深拷贝 | 循环引用直接崩、Date 变字符串 | 用 `deepClone` |
| applyPatch 的父路径不存在 | 写入失败 | 已处理：按深度排序，按需创建中间节点 |
| 删了父再删子 | 路径失效 | 已处理：删除从深到浅 |
| UndoStack push 时机搞反 | undo 返回的是当前状态，看起来"没生效" | push 在改动**之前** |
| 每帧都做 diff | 性能崩 | 只在需要时做（存档、同步、撤销点） |

## API

| 函数/类 | 说明 |
|---|---|
| `deepClone(v)` | 结构化深拷贝（**支持循环引用**） |
| `diffSnapshots(a, b, maxDepth?)` | 差异比对 |
| `createPatch(a, b, maxDepth?)` | 生成补丁 |
| `applyPatch(base, patch)` | 应用补丁（不改 base） |
| `UndoStack<T>` | 撤销栈。见下方完整接口 |

### `UndoStack` 完整接口

| 成员 | 说明 |
|---|---|
| `push(state)` | 记录一个可回到的状态（**在改动之前调**） |
| `undo(current)` | 撤销，返回上一个状态（**不能撤销时返回 `undefined`**） |
| `redo(current)` | 重做，返回下一个状态（同理） |
| `canUndo()` / `canRedo()` | 是否可撤销 / 重做 |
| `undoDepth()` / `redoDepth()` | 栈深度 |
| `clear()` | 清空两个栈 |
| `destroy()` | 释放 |

> ⚠️ **`undo()` / `redo()` 需要传入"当前状态"。**
> 这不是多余的参数——模块不知道你现在的 state 是什么，
> 需要它来把当前状态推入反向栈。
> 传错（比如传了上一个状态）会让 redo 栈内容错乱，
> 表现为"撤销几次后重做，跳到了一个没见过的状态"。

> ⚠️ **`undo()` 返回 `undefined` 表示到底了，不是抛错。**
> 必须判空：
>
> ```typescript
> const prev = undo.undo(state);
> if (prev !== undefined) state = prev;
> ```
>
> 不判空直接赋值的话，会把 `undefined` 写进 state，
> 之后的 diff / 存档全部崩掉——
> 而错误现场在很后面，看不出是撤销栈的锅。

> **`canUndo()` 判断 + `undo()` 取值是标准搭配**，
> 比直接调 `undo()` 判空语义更清晰：
>
> ```typescript
> if (undo.canUndo()) state = undo.undo(state)!;
> ```

> **撤销后再做新操作，redo 栈会被清空**（示例注释里提过）。
> 这是所有撤销系统的标准行为，不是 bug——
> 保留了的话，玩家会重做到一个"已经被抛弃的分支"上。

### 类型

**`DiffEntry`**：

```typescript
{ path: string; from: unknown; to: unknown }
```

**`DiffResult`**（`diffSnapshots()` 的返回）：

```typescript
{
  changed: readonly DiffEntry[];   // 值变了
  added:   readonly DiffEntry[];   // 新增的键
  removed: readonly DiffEntry[];   // 删除的键
  hasChanges: boolean;             // 三者是否全空
}
```

> ⚠️ **`hasChanges` 是唯一可靠的"有没有变化"判据。**
> 自己写 `changed.length + added.length + removed.length > 0` 也行，
> 但漏掉 `added` 或 `removed` 其中一个的话，
> 只增不删或只删不增的场景会误判成"没变"——
> 表现为"存档没写入"或"同步没触发"。

> **`path` 是点分路径**（`'a.b.c'`），不是数组下标链。
> 做补丁和定位时直接用字符串即可，不用自己拼。

**`UndoStackOptions`**：

```typescript
{ limit?: number }    // 栈上限，超出丢弃最老的
```

> ⚠️ **`limit` 超限丢弃最老的，不报错。**
> 同 `command` 的 `limit`——
> 表现为"撤销到一半突然不能撤了"。
