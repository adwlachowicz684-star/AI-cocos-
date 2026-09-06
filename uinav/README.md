# uinav · UI 导航栈

---

## 它解决什么

打开背包 → 点物品 → 弹确认框。按返回键应该**退一层**，
而不是回到主菜单或把整个栈清空。

手写是 `if (currentPanel === 'bag') closeBag()`，加了设置/图鉴/商店/二次确认后
就是一坨互相矛盾的 if。

## 用法

```typescript
const nav = new UINav<string>({ transitionMs: 200, duplicate: 'popTo' });

nav.push('home');
nav.push('bag');
nav.push('confirm');
nav.current;         // 'confirm'

nav.pop();           // → 'bag'
nav.popTo('home');   // 直接回主界面
nav.reset(['home']); // 重建栈

// 事件：一次可能关多层（popTo / clear）
nav.onChange = ({ action, current, previous, closed }) => { ... };
```

## 三种重复策略

| 策略 | 行为 |
|---|---|
| `allow`（默认） | 允许同一个界面入栈多次 |
| `ignore` | 已在栈中就拒绝 |
| `popTo` | 回退到已存在的那一层 |

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **转场锁** | 转场动画期间连点会 push 出多层同样界面。`transitionMs: 0` 可关闭 |
| **`closed` 是数组** | `popTo`/`clear` 一次可能关多层 |
| **空栈 `pop()` 返回 null** | 不抛错，反复 pop 是安全的 |
| **`idOf` 默认 `String(item)`** | T 是字符串 id 时可以不传 |

## 完整接口

| 成员 | 说明 |
|---|---|
| `push(item)` | 入栈，返回是否成功（**转场锁期间返回 false**） |
| `pop()` | 出栈，返回弹出的项（**空栈返回 null**） |
| `replace(item)` | 替换栈顶（**空栈时等价 push**） |
| `popTo(id)` | 回退到指定界面，返回是否成功 |
| `popToDepth(depth)` | 回退到指定深度 |
| `clear()` / `reset(items)` | 清空 / 重建栈 |
| `current()` | 栈顶项（`null` = 空栈） |
| `depth()` | 当前深度 |
| `isEmpty()` | 是否空栈 |
| `stack()` | 整个栈（`readonly T[]`） |
| `locked()` | **是否处于转场锁** |
| `contains(id)` | 某界面是否在栈中 |
| `indexOf(id)` | 在栈中的位置（`-1` = 不在） |

> ⚠️ **`push()` 在转场锁期间返回 `false` 且不入栈。**
> 不看返回值的话，玩家连点会以为"点了没反应"——
> 实际上是被锁挡住了（这正是锁的目的）。
> 想给反馈的话依据返回值播放一个"无法操作"的提示。

> ⚠️ **`locked()` 是做"转场期间禁用按钮"的。** 
> 光靠 `push()` 返回 false 不够——
> 按钮的可点击状态应该跟着 `locked()` 变，
> 否则玩家会一直点一直没反应。

> **`contains(id)` / `indexOf(id)` 是 `duplicate: 'popTo'` 策略的基础。**
> 想自己实现"已在栈中就回退到它"的逻辑，用这两个查询。

> ⚠️ **`indexOf` 找不到时返回 `-1`，不是 `null` 或 `undefined`。**
> 当布尔用的话 `-1` 是**真值**——
> `if (nav.indexOf(id))` 在找不到时反而走进分支。
> 必须显式判 `>= 0`。

### 类型

```typescript
type NavAction = 'push' | 'pop' | 'replace' | 'popTo' | 'clear' | 'reset';
type DuplicatePolicy = 'allow' | 'ignore' | 'popTo';
```

**`NavChange`**（`onChange` 的参数）：

```typescript
{
  action:   NavAction;        // 发生了什么
  current:  T | null;         // 变化后的栈顶（清空时为 null）
  previous: T | null;         // 变化前的栈顶
  closed:   readonly T[];     // 本次关闭的（**是数组**，见坑表格）
}
```

> ⚠️ **`closed` 是数组，不是单个值。**
> `popTo` / `clear` 一次可能关掉多层。
> 只处理 `closed[0]` 的话会漏掉其余的关闭动画。

**`UINavOptions`**：

| 字段 | 说明 |
|---|---|
| `idOf(item)` | 从项取 id（**默认 `String(item)`**） |
| `transitionMs` | 转场锁时长（`0` = 关闭锁） |
| `duplicate` | 重复策略 |
| `onChange(change)` | 变化回调 |

> ⚠️ **`idOf` 在 T 是对象时必填。**
> 默认 `String(item)` 会得到 `'[object Object]'`——
> 所有界面 id 都一样，`popTo` / `contains` 全部失效。
> 表现为"popTo 到某个界面总是失败"。

### `useClock(fn)`

注入自定义时间源。默认用 `Date.now()`。

```typescript
nav.useClock(() => gameTime.now());   // 接游戏时间
```

> ⚠️ **默认时间源是 `Date.now()`（真实时间）。**
> 游戏暂停时转场锁照常倒计时——这通常是期望行为，
> 但如果你的暂停是真暂停（连 UI 都冻结），
> 就需要注入自己的时钟，否则暂停期间锁会失效。

## 测试

**32 项**，覆盖转场锁对 push/pop 的作用、replace 在空栈等价 push、popToDepth、事件里 `closed` 的顺序。
