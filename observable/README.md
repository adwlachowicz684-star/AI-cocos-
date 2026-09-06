# observable · 响应式数据

**UI 自动刷新的地基**

---

## 它解决什么

手写的 UI 刷新长这样：

```typescript
hp = 80;
refreshHpBar();      // 忘了这行 → 血条不动
refreshHpText();
checkDeath();
```

每加一处修改数值的地方就要记得补刷新调用。漏一处就是一个"数值变了但界面没变"的 bug。

响应式把关系倒过来：

```typescript
hp.value = 80;       // 订阅者自动收到通知
```

## 用法

```typescript
const hp = ref(100);
hp.subscribe(({ value, prev }) => updateHpBar(value));

const maxHp = ref(100);
const ratio = computed(() => hp.value / maxHp.value);   // 依赖自动收集

hp.value = 25;
ratio.value;   // 0.25
```

**依赖是运行期收集的**，所以条件分支能正确追踪：

```typescript
const pick = computed(() => (cond.value ? a.value : b.value));
// cond 变了之后，依赖从 {cond, a} 变成 {cond, b}
```

**批量**：

```typescript
batch(() => {
  hp.value = 80;
  shield.value = 0;
  rage.value = 30;
});   // UI 只刷一次
```

**订阅收集器**（面板关闭时一次性取消全部）：

```typescript
const sub = new Subscription();
sub.add(hp.subscribe(f1));
sub.add(mp.subscribe(f2));
// ... 面板关闭时
sub.unsubscribeAll();
```

| 成员 | 说明 |
|---|---|
| `add(stop)` | 加入一个取消函数 |
| `unsubscribeAll()` | 全部取消并关闭 |
| `size` | 已加入数量 |
| `closed` | 是否已关闭 |

> ⚠️ **对已关闭的 Subscription 调 `add` 会立即取消新订阅。**
> 这是刻意的——否则调用方以为"加上了"，实际永远不会被清掉。
> 排查"取消订阅没生效"时看 `closed`。

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **相同值不通知** | 否则每帧刷 UI 会导致整个界面重建 |
| **批内 10 次修改只通知 1 次** | 且 `prev` 是批量开始时的值（净变化 0→9），不是中间某步 |
| **批中抛错会泄漏** | 用 `try/finally` 保证 depth 归零，否则后续所有通知被吞 |
| **computed 链必须冒泡** | top→mid→base，base 变了 top 必须更新。只"登记"不真正订阅会导致断链 |
| **条件分支的依赖变化** | 构造时追踪一次的话，b 变了不会重算 |
| **已关闭的 Subscription 再 add** | 会立即取消新订阅，否则调用方以为加上了，实际泄漏 |

## API

### 创建与读取

| 成员 | 说明 |
|---|---|
| `ref(initial, opts?)` / `computed(fn)` | 创建。**用工厂函数，不用 `new`** |
| `.value` | 读写（**读会建立依赖**） |
| `.peek()` | 读取**但不建立依赖** |
| `.update(fn)` | 函数式更新：`r.update(v => v + 1)` |

> ⚠️ **`.value` 会建立依赖，`.peek()` 不会。**
>
> 在 `computed` 里读一个 ref：
> - 用 `.value` → 这个 ref 变了，computed 重算
> - 用 `.peek()` → **不追踪**，ref 变了 computed 也不重算
>
> 典型误用：写调试代码时顺手用 `.peek()`，
> 结果"数值变了但界面不更新"，而且很难联想到是这里。

### 订阅与生命周期

| 成员 | 说明 |
|---|---|
| `.subscribe(fn)` | 订阅，返回**取消函数** |
| `.dispose()` | 释放监听与依赖 |
| `.disposed` | 是否已释放 |
| `.listenerCount` | 当前监听者数量 |

### Computed 专属

| 成员 | 说明 |
|---|---|
| `.invalidate()` | 强制重算（**下次读取时生效**） |

> **`.invalidate()` 不会立即重算**，只是标脏。
> 值的计算推迟到下一次读 `.value` 时——
> 这是刻意的：连续标脏多次只算一次。
>
> 想立刻拿到新值，`invalidate()` 之后读一次 `.value`。

> ⚠️ **对已 `dispose` 的对象调 `subscribe` 会返回空函数，不报错、不生效。**
>
> ```typescript
> subscribe(fn) {
>   if (this._disposed) return () => {};   // ← 静默失败
>   ...
> }
> ```
>
> 排查"订阅了但回调不触发"时，先看 `disposed`。

> **`listenerCount` 是查内存泄漏的入口。**
> 反复打开/关闭同一界面，如果这个数一直涨，说明订阅没取消。

**回调收到的是 `Change<T>`，不是裸值**：

```typescript
interface Change<T> { readonly value: T; readonly prev: T; }
```

```typescript
hp.subscribe(({ value, prev }) => {
  if (value < prev) playDamageFlash();     // 掉血闪红，加血不闪
});
```

> 拿到 `prev` 才能区分"加血"和"掉血"。
> 只给新值的话，"回血时闪红"这种 bug 就藏不住也防不了。

**`ref(initial, opts?)` 的 `opts`**：

| 字段 | 说明 |
|---|---|
| `equals` | 自定义相等比较（默认 `===`）。**深比较放在这里** |
| `name` | 调试名 |

> ⚠️ **`equals` 决定"相同值不通知"的判定。**
> 存对象时默认 `===` 意味着**每次赋新对象都会通知**——
> 哪怕内容一模一样。存数组/对象且不希望频繁刷 UI，要自己传 `equals`。

### 批处理

| 函数 | 说明 |
|---|---|
| `batch(fn)` | 批内多次修改只通知一次 |
| `flush()` | **立即**执行队列中的通知（通常由 `batch` 自动调） |

> `flush()` 一般不用手动调——`batch` 结束时会自动调。
> 它暴露出来是为了测试和特殊时序需求。
>
> `batchSize()` 返回当前队列长度（**调试用**）。

### 类型名对照

用工厂函数创建，但你写类型标注时会遇到这些名字：

```typescript
ref<T>(initial: T, opts?: RefOptions<T>): Observable<T>
computed<T>(fn: () => T): Computed<T>
subscribe(fn: Listener<T>): Unsubscribe
```

| 类型 | 是什么 |
|---|---|
| `Observable<T>` | `ref()` 的返回类型 |
| `Computed<T>` | `computed()` 的返回类型 |
| `Listener<T>` | `(change: Change<T>) => void` |
| `Unsubscribe` | `() => void` |

> 文档用 `ref()` / `computed()` 而不是 `new Observable()`，
> 是因为工厂函数能省掉泛型参数推断的麻烦。
> **你不需要 `new`，也别 `new`。**

## 设计取舍

**为什么不用 `Proxy`（Vue 那样）**：TS 严格模式下类型体验差，且难以静态分析。
代价是必须用 `.value` 访问（多写 5 个字符），换来类型安全和无 Proxy 开销。

## 测试

**45 项**，覆盖批量去重、prev 语义、条件分支依赖切换、链式冒泡、订阅者抛错隔离、`once`、dispose。
