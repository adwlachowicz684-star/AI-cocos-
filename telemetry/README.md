# telemetry · 埋点上报

---

## 它解决什么

游戏上线后你要知道：玩家卡在第几关？哪个遗物从没人选？

手写 `fetch('/track')` 的问题：

- 一局几百个事件，每个都发请求 → 流量和电量爆炸
- 网络失败就丢了 → 数据不准
- 采样用 `Math.random()` → 同一会话里"关卡开始"上报了、"关卡结束"没上报

## ⚠️ 最重要的一条：采样必须在会话内确定性

朴素的 `Math.random() < 0.1` 会导致数据里出现大量
**"有 level_start 但没有 level_end"** 的关卡——你永远算不出通关率。

本模块用 `hashString(sessionId + ':' + eventName) < rate` 决策，
同一会话内对同一事件的决策**永远一致**。

```typescript
t.willSample('level_start');   // 同一会话内 50 次调用结果完全相同
```

## 用法

```typescript
const t = new Telemetry({
  sender: async (batch) => { await fetch('/track', {...}); return true; },
  batchSize: 20,
  flushIntervalMs: 5000,
  commonProps: { version: '1.0.2' },
  sampleRate: 0.1,
  eventSampleRates: { 'frame_spam': 0 },   // 高频事件全丢
});

t.capture('level_start', { level: 3 });
t.newSession();      // 换会话时序号归零
await t.flush();     // 退出前尽力发一次
```

| 成员 | 说明 |
|---|---|
| `capture(name, props?)` | 上报一条 |
| `flush()` | 尽力发送 |
| `shouldFlush()` | 是否**该**发了（攒够条数或超时） |
| `newSession()` | 换会话（序号归零） |
| `useClock(fn)` | **注入时间源** |
| `enabled` | 总开关 |
| `buffered` | 当前缓冲条数 |
| `stats` | 四个计数 |
| `clear()` | 清空缓冲与统计 |
| `sessionId` | 当前会话 id |
| `flushSync()` | 页面关闭前尽力发一次（**注意：它是 async**） |
| `destroy()` | 卸载：断开 sender 并清空缓冲（rule5） |

> ⚠️ **`flushSync` 叫 Sync 但返回 Promise。**
> 名字是历史遗留——它表达的是"现在就发"，不是"同步返回"。
> 调用方务必 `await`（或在 `pagehide` 里 fire-and-forget）。

> ⚠️ **卸载时要调 `destroy()`，不是只调 `clear()`。**
> `sender` 闭包通常持有页面级对象，只清缓冲不断引用，实例会一直驻留。
> `destroy()` 之后 `flush()` 不再触发网络。

> **`shouldFlush()` 是给你自己的主循环用的。**
> 本模块不自带定时器——
> `flushIntervalMs` 只在 `shouldFlush()` 被调用时才起作用。
> 忘了每帧（或每隔几秒）调它，"超时自动发送"就不会发生。

> ⚠️ **`useClock` 在测试里是必需的，不是可选项。**
> 源码注释直接写了"测试必需"：
> 不注入时间源的话，`flushIntervalMs` 依赖真实时间流逝，
> 测试会因为机器快慢而时好时坏。

> **`buffered` 持续增长说明 sender 太慢。**
> 它撞到 `maxBuffer` 之后就开始丢最旧的事件——
> 监控这个值是发现上报瓶颈最直接的手段。

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **失败要放回队首** | 丢一次就是数据缺口。但超过 `maxRetries` 就真丢，防内存无限涨 |
| **缓冲满时丢最旧的** | 最近的行为更有价值（玩家在哪一关退出，比他开局做了什么重要） |
| **并发 flush 会重复发** | 用 `_flushing` 挡住 |
| **没配 sender 时 flush 清空** | 而不是无限堆积 |
| **事件属性覆盖通用属性** | `{...commonProps, ...props}` |

## API

### 类型

| 类型 | 说明 |
|---|---|
| `TelemetryEvent` | `{ name, props, seq, t }`。**`props` 已合并通用属性** |
| `TelemetrySender` | `(batch) => Promise<boolean> \| boolean`，返回**是否成功** |
| `TelemetryStats` | `captured` / `sent` / `failed` / `dropped` |
| `hashString(s)` | 字符串哈希到 **[0, 1)**（采样用） |

> ⚠️ **`TelemetrySender` 的返回值决定重试。**
> 返回 `false`（或 Promise resolve 成 `false`）会触发"放回队首重试"，
> 超过 `maxRetries` 才真丢。**抛异常和返回 false 是两回事**——
> 抛异常走的是错误处理路径。

> **`hashString` 的两个硬性要求**：
> 1. **确定性**——同样输入永远同样输出，否则同一会话的采样会飘
> 2. **分布均匀**——采样率 50% 时要真的约一半被选中
>
> 用 FNV-1a 变体（32 位）。有测试专门验证：
> 同会话调 50 次结果一致，不同会话的采样率确实接近 50%。

### `TelemetryOptions`

| 字段 | 说明 |
|---|---|
| `sender` | 发送函数 |
| `batchSize` / `flushIntervalMs` | 攒够 N 条发 / 距上次发送超过这么久发 |
| `commonProps` | 每条事件都带的属性 |
| `sampleRate` | 全局采样率 0~1 |
| `eventSampleRates` | **按事件名覆盖**采样率 |
| `maxRetries` | 失败重试次数（超过则丢弃） |
| `maxBuffer` | 缓冲区上限（超出丢最旧的） |
| `sessionId` | 会话 id |

> ⚠️ **`eventSampleRates` 只对指定事件名生效，未指定的走 `sampleRate`。**
> 想让"关键付费事件"100% 上报而"普通行为"只采 10%，
> 就靠这个——`sampleRate: 0.1` + `eventSampleRates: { purchase: 1 }`。

> **`TelemetryStats` 的四个计数不等价**：
> `captured`（采集）不等于 `sent`（已发送），
> 差额在 `dropped`（缓冲满丢弃）和 `failed`（重试耗尽）。
> 监控埋点健康度要看 `dropped`——它涨了说明sender 太慢或批次太小。

## 测试

**37 项**，含一条专门验证采样确定性（同会话 50 次调用结果一致），
以及一条验证不同会话的采样率确实接近 50%。
