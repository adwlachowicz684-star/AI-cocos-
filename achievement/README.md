# achievement · 成就系统

---

## 它解决什么

成就看起来简单：`if (kills >= 100) unlock('kill100')`。

真正麻烦的是三件事：

1. **重复触发**：每帧检查一次，解锁回调被调用几百次
2. **前置依赖**：隐藏成就要先解锁前置
3. **进度展示**：`1234/1000` 不能超目标、不能为负、不能是 NaN

## 用法

```typescript
const a = new Achievement({
  defs: [
    { id: 'kill100', name: '百人斩', target: 100,
      progress: (c) => c.get('kills') },
    { id: 'boss', name: '击败 Boss',
      isDone: (c) => c.get('bossKilled') > 0 },
    { id: 'secret', name: '隐藏成就', hidden: true,
      requires: ['kill100'], progress: (c) => c.get('secrets'), target: 3 },
  ],
  onUnlock: (d) => showToast(d.name),
});

const newly = a.check(ctx);   // 只返回**本次新解锁**的
a.progressOf('kill100', ctx); // { current, target, done, locked }
```

`ctx` 由你提供（`{ get(key) => number }`），本模块不知道数据在哪。

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **重复解锁** | `check()` 里跳过已解锁的，`onUnlock` 只调一次 |
| **循环前置在构造时报错** | `a→b→a` 会无限递归，DFS 三色标记检测 |
| **进度夹到 [0, target]** | 展示时不该显示 "1234/1000"，NaN 也要夹成 0 |
| **`target` 被收口到 [1, 1e12]** | `target: 0` 会让成就秒达成（`0 >= 0`），`target: NaN` 会让进度变 NaN，两者都不报错；未填则回落 1 |
| **隐藏成就仍占位** | `visible()` 返回全部，否则玩家能从"总数"察觉隐藏成就存在 |
| **同批内前置与本体同时达成** | 按声明顺序遍历，前置声明在前才能过 |
| **导入未知 id 静默跳过** | 旧存档兼容 |

## API

### 检查与解锁

| 成员 | 说明 |
|---|---|
| `check(ctx)` | 检查**全部**成就，返回**本次新解锁的**列表 |
| `checkOne(id, ctx)` | 只检查一个，返回**本次是否新解锁** |
| `progressOf(id, ctx)` | 查进度，**不触发解锁**（做进度条用） |
| `requirementsMet(id)` | 前置成就是否都达成了 |
| `unlock(id, bypassRequires?)` | 手动解锁（**默认校验前置**；传 `true` 可绕过） |
| `revoke(id)` | **撤销**解锁（调试 / 重置） |

> ⚠️ **`unlock(id)` 默认校验 `requires`。**
> `checkOne()` 校验前置，`unlock()` 曾经不校验——同一个"解锁"动作两条路径两套规则，
> GM 命令 / 后台补发一调 `unlock('b')` 就造出违反依赖图的存档：
> B 已解锁而 A 没有，`requirementsMet('b')` 却仍返回 `false`，
> UI 出现"已解锁但前置未完成"的矛盾态。
> 确实要绕过依赖时显式写 `unlock('b', true)`，让这件事在调用点看得见。

> ⚠️ **`check` / `checkOne` 的返回值是"本次新解锁的"，不是"已解锁的"。**
> 已经解锁过的**不会出现在返回值里**。
> 想查"某个成就是否已解锁"用 `isUnlocked(id)`。

> ⚠️ **`checkOne` 遇到未定义的 id 返回 `false`，而 `unlock` / `progressOf` 会抛错。**
> 同一个"id 不存在"的错误，三个方法三种反应——
> 拼写错的成就 id 在 `checkOne` 里是**静默失败**（永远解锁不了，也不报错）。

### 查询（成就列表 UI）

| 成员 | 说明 |
|---|---|
| `isUnlocked(id)` | 是否已解锁 |
| `unlocked()` | 已解锁的成就定义列表 |
| `unlockedCount` | 已解锁数量 |
| `points` / `totalPoints` | 已获得 / 全部点数 |
| `completion` | 完成度 0..1 |

### 存档与重置

| 成员 | 说明 |
|---|---|
| `exportState()` | 导出**已解锁 id 的数组**（不是完整对象） |
| `importState(ids)` | 导入（**替换**语义：先清空再写入；静默跳过未定义的 id） |
| `mergeState(ids)` | **合并**导入（追加语义：不清空，只并入） |
| `reset()` | 清空全部解锁记录 |

> ⚠️ **`importState` 是"替换"，不是"追加"。**
> 存档是某一时刻的**完整快照**，不是增量补丁。
> 早先版本只 `add` 从不 `clear`，于是换槽位、断线重连后重新载入存档，
> 旧槽位的解锁状态被叠加进来（实测：导入 `['a']` 再导入 `['b']` → `unlockedCount === 2`），
> 玩家看到"没达成的成就已点亮"，且 `points` 虚高——**整个过程不抛错**。
> 需要取并集（多份存档合并）请用 `mergeState()`。

> ⚠️ **`importState` 静默跳过配置里已删除的成就 id。**
> 这是给"版本更新删了几个成就"用的——读档不该因为少一条就崩。
> 但副作用是：`importState` 之后 `unlockedCount` 可能小于传入的数组长度。

```typescript
ui.text = `${a.unlockedCount}/${total}　${(a.completion * 100).toFixed(0)}%`;
```

## API 补充

### 查询（做成就列表 UI）

| 成员 | 说明 |
|---|---|
| `unlocked()` | 已解锁的成就定义列表 |
| `isUnlocked(id)` | 单个是否已解锁 |
| `unlockedCount` | 已解锁数量 |
| `completion` | 完成度 0..1（**进度条**） |
| `points` / `totalPoints` | 已获得 / 总点数 |
| `requirementsMet(id)` | 条件是否满足（**灰显未达成项**） |

```typescript
// 「成就 42/100 · 68%」
ui.text  = `${ach.unlockedCount}/${total}`;
ui.bar   = ach.completion;
```

### 单项检查

`checkOne(id, ctx)` —— 单独检查一个成就，返回是否**本次新解锁**。

> 全量检查用 `check(ctx)`；只想验证某一条（比如"击杀 Boss"事件到达时）用 `checkOne`，避免每次事件都扫全表。

### 撤销

| 成员 | 说明 |
|---|---|
| `revoke(id)` | 撤销**单个**成就，返回是否真的撤了 |
| `reset()` | 清空全部 |

> ⚠️ **`revoke` 只清"已解锁"标记，不回滚奖励。**
> 发出去的货币、道具不会退回来——它**不是"撤销"而是"重新上锁"**。
> 名字有点误导，实际用途是**调试和重测**（"让我再触发一次这个成就"）。
>
> 真要回滚奖励，得在业务侧自己记账。

## 测试

**44 项**，覆盖重复解锁、循环前置、进度去重通知、NaN/负数夹取、前置锁定。

---

## 返回值结构

### `AchievementProgress`

```typescript
interface AchievementProgress {
  current: number;    // 当前进度
  target:  number;    // 目标值
  done:    boolean;   // 是否达成
  locked:  boolean;   // 是否锁定（前置未满足）
}
```

> ⚠️ **`locked` 为 true 时 `current` 可能已经在涨。**
> 这是刻意的：前置达成后能立刻看到进度，
> 而不是从头开始。做进度条时判 `locked` 决定灰不灰，
> 别因为 `locked` 就把 `current` 显示成 0。