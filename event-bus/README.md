# EventBus

类型安全的发布订阅。

## 适用 / 不适用

**适合**：状态广播、跨层通知、生命周期事件（一对多、发送方不关心结果）。

**不适合**：
- 需要返回值的场景（用直接调用）
- 严格顺序依赖（用直接调用）
- 每帧高频（>100/s，用直接调用或 Signal）

> 判据：**一个事件如果只有一个监听者，那它应该是直接调用，不是事件。**

## 用法

```typescript
import { EventBus } from './event-bus/EventBus';

interface GameEvents {
  'hp:change': { cur: number; max: number };
  'enemy:died': { id: string; by: string };
}

const bus = new EventBus<GameEvents>({ trace: false });

// 订阅 —— on() 返回取消函数
const off = bus.on('hp:change', (d) => ui.updateHp(d.cur, d.max));

// 发布
bus.emit('hp:change', { cur: 3, max: 10 });

// 只听一次
bus.once('enemy:died', (d) => console.log('首个敌人死亡', d));

// 取消
off();
```

## 设计要点

**① `on()` 返回取消函数，而不是 `off(name, fn)`**

`off(name, fn)` 要求调用方保留 `fn` 的引用。如果你写成
`bus.on('x', () => {...})` 然后 `bus.off('x', () => {...})`，
那是两个不同的函数对象——取消会静默失败。这是最常见的事件泄漏原因。

返回取消函数把这件事变成必然正确。

**② 快照遍历**

监听器 A 执行后把自己 off 掉，如果用普通数组遍历就会跳过后续监听器
甚至越界。这里每次 emit 都拷贝一份快照。

**③ 错误隔离**

默认某个监听器抛异常不会中断其他监听器（`swallowErrors: true`）。
开发期可设为 `false` 以便快速暴露问题。

## 坑

- **忘记取消订阅**：组件销毁后仍被调用，经典内存泄漏。用 `off()` 或 `destroy()`
- **事件名无规范**：同一件事出现 `die` / `death` / `onDie` 三种写法。统一用 `域:动作`
- **用事件替代返回值**：逻辑顺序无法保证，别这么做
- **没人维护事件清单**：想知道谁在监听只能全局搜索。建议建一份事件文档

## API

| 方法 | 说明 |
|---|---|
| `on(name, fn)` | 订阅，返回取消函数（幂等） |
| `once(name, fn)` | 只触发一次 |
| `emit(name, payload)` | 发布（快照遍历 + 错误隔离） |
| `off(name)` | 移除该事件的所有监听器 |
| `offAll()` | 移除全部 |
| `has(name)` | 是否有监听器 |
| `listenerCount` | 监听器总数（排查泄漏） |
| `destroy()` | 清空 |
