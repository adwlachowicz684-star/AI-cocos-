# signal — 轻量信号

## 与 EventBus 的区别

| | EventBus | Signal |
|---|---|---|
| 作用域 | 全局，按字符串名 | 局部，是一个对象 |
| 类型安全 | 弱（字符串 key） | **强**（每个 Signal 签名固定） |
| 典型用途 | "玩家升级了"这种全局广播 | "这个按钮被点了"这种一对一 |
| 发现性 | 要查字符串常量 | 是对象属性，`btn.onClick.add(fn)` 一目了然 |

> **经验法则**：跨模块、不知道谁会监听 → EventBus；
> 有明确所有者（一个按钮、一个角色、一个技能）→ **Signal**。

## 用法

```typescript
import { Signal } from './signal/Signal';

class Button {
  readonly onClick = new Signal<() => void>();
  readonly onHover = new Signal<(enter: boolean) => void>();
}

const btn = new Button();
const off = btn.onClick.add(() => console.log('点了'));
btn.onClick.once(() => console.log('只触发一次'));

btn.onClick.emit();
off();

btn.onClick.listenerCount;   // 只增不减 = 泄漏
```

## 特性

**① 返回取消函数**（同 EventBus）
传统 `off(fn)` 需要调用方保存 fn 引用；本模块 `add(fn)` 直接**返回**取消函数，
可以随手丢进 dispose 数组。

> ⚠️ **本模块没有 `off()` 方法。**
> 真正的公有方法只有：`add` / `once` / `emit` / `clear` / `destroy`。
> 早期文档提到的 `off(fn)` 是拿它跟"传统写法"做对比，
> 但写在反引号里容易被当成真实 API——照着调会报
> `Property 'off' does not exist`。
>
> ```typescript
> const cancel = sig.add(fn);   // ← 取消订阅用这个
> cancel();
>
> sig.clear();                  // 或者一次性全清
> ```

**② 支持在回调里取消自己**
"只处理第一次命中"——emit 中移除被延迟到遍历结束，不会破坏迭代。

**③ 单个监听者抛异常不中断其他监听者**
一个 UI 回调写错了，不该导致伤害逻辑收不到事件。

**④ 拦截递归 emit**
回调里 emit 同一个信号会造成无限循环，被拦截并告警。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 忘了取消监听 | 内存泄漏（对象永不释放） | 用返回的取消函数 |
| 回调里 emit 同一个信号 | 无限循环 | 被拦截 |
| 监听者抛异常 | 其他监听者收不到 | 被 try/catch 隔离 |
| 用 Signal 做全局广播 | 要持有引用，不方便 | 用 EventBus |

## API

| 成员 | 说明 |
|---|---|
| `add(fn)` | 添加监听，返回取消函数 |
| `once(fn)` | 一次性监听 |
| `emit(...args)` | 触发 |
| `clear()` | 移除所有监听 |
| `listenerCount` | 监听者数量（**排查泄漏**） |

---

## `destroy()`

> ⚠️ **`destroy()` 等价于 `clear()`，但语义上"只能调一次"。**
> 它清掉所有监听。
> 对象销毁时**必须**调——监听持有外部引用（闭包捕获了节点），
> 不调的话节点销毁了但监听还在，
> 下次 `emit` 会去操作已销毁的节点。
>
> 这是"事件监听导致对象永不释放"这类泄漏的标准处理。
