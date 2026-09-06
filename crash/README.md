# crash · 崩溃捕获与上报

> 玩家只说"闪退了"。这个模块负责还原"他到底遇到了什么"。

## 1. 它解决什么

没有崩溃上报，「游戏闪退了」这类问题只有一个解决路径：
等它再次发生，并且刚好被你撞上。

本模块把崩溃现场打包成一份**可用的报告**：

```
错误堆栈 + 最近 30 条日志 + 玩家操作面包屑 + 设备/版本信息 + 当前关卡
```

## 2. 五分钟上手

```typescript
import { CrashReporter, reportText } from './crash/CrashReporter';
import { Logger } from './logger/Logger';

const crash = new CrashReporter({
  transport: { send: r => http.post('/crash', reportText(r)) },
  breadcrumbLimit: 30,
  dedupeWindow: 60000,
});

crash.setContext({ version: '1.2.3', platform: 'iOS 17.5' });
crash.bindLogSource(() => logger.export());   // 注入，不直接持有

// 关键节点留痕
crash.leave('flow',   '进入主菜单');
crash.leave('combat', '遭遇精英怪 ×4');
crash.leave('loot',   '拾取遗物：暴击强化');
crash.install();     // 接管全局异常
```

> ### 为什么 `depends` 里没有 `logger`
>
> 上面示例用到了 `Logger`，但本单元在 `_kitmeta.json` 里的 `depends` 是空的——**这是对的，别去补**。
>
> 示例里的 import 发生在**你的业务代码**里，不是本模块里。
> 本模块只要求"能喂进来一个返回 `ILogEntryLike[]` 的函数"，
> 具体是 `logger`、自己的日志系统、还是硬编码的数组，它都不关心。
>
> **`depends` 登记的是"本模块的源码 import 了什么"，
> 不是"它通常会和谁一起用"。** 后者写在本文的"日志注入"一节里。
>
> 这条由 `node scripts/check-deps.js` 的第 5 项自动检查。
> 源码注释里曾写过 `import { LogEntry } from '../logger/Logger'` 作为**反例**
> （解释为什么不能这么写），早期登记时被误当成真实依赖写进了 `depends`——已移除。

### API

**上报**

| 成员 | 说明 |
|---|---|
| `install()` / `uninstall()` | 接管 / 还原全局异常处理 |
| `capture(error, severity?)` | 手动上报异常，返回**是否真的发送了** |
| `captureMessage(msg, severity?)` | 上报一条消息（**主动埋点用**） |

> ⚠️ **`capture` 返回 `false` 不代表失败——是被去重/采样/过滤拦下了。**
> 排查"为什么没收到上报"时先看返回值：
> 连着报同一个错，第二次起就是 `false`，这是**预期行为**。

**面包屑**

| 成员 | 说明 |
|---|---|
| `leave(category, message, level?, data?)` | 留痕 |
| `breadcrumbs` / `breadcrumbCount` | 读取 / 数量 |
| `clearBreadcrumbs()` | 清空（**换关卡 / 换账号时调**） |

> ⚠️ **不 `clearBreadcrumbs()`，上一局的痕迹会带进下一局。**
> 表现为"这局崩溃了，但面包屑里全是上局的操作"——
> 排查方向被带偏。

**上下文**

| 成员 | 说明 |
|---|---|
| `setContext(ctx)` | 整体替换 |
| `setContextValue(key, value)` | 单个设置 |
| `removeContextValue(key)` | 单个移除 |
| `context` | 读取（只读） |

> `setContext` 是**整体替换**而不是合并——
> 想增量修改用 `setContextValue`。

**日志注入**

| 成员 | 说明 |
|---|---|
| `bindLogSource(fn)` | 绑定日志源（**注入，不直接持有 Logger**） |
| `setMinLogLevel(level)` | 只收集此级别以上的日志 |

**诊断与生命周期**

| 成员 | 说明 |
|---|---|
| `installed` | 是否已接管全局异常 |
| `stats()` | 指纹统计（`{ fingerprint, count }[]`，按次数降序） |
| `reset()` | 清空去重表与统计（**测试 / 换账号用**） |

> **`stats()` 是排查"上报被吞"的入口。**
> 某个错误的 `count` 是 1 但你觉得它发生了很多次 →
> 去重生效了，这是对的；`count` 很大但没收到上报 → 检查 transport。

> ⚠️ **`reset()` 会清掉去重表**，之后同一个错误会**重新上报一次**。
> 生产环境别随便调——测试里用它保证用例之间互不干扰。

> **`bindLogSource` 接受一个函数而不是数组**，
> 是刻意的：崩溃发生在**上报那一刻**才去取日志，
> 而不是注册时取快照。这样崩溃前的最后几条日志也在里面。

## 3. 三个核心机制

### 面包屑

堆栈只告诉你"哪里炸了"，不告诉你"怎么走到这的"。
面包屑记录最近的操作链——**这一条的价值通常超过堆栈本身**。

### 去重

同一个 bug 被 1000 个玩家触发，你不该收到 1000 封报告。
用「错误类型 + 首个堆栈帧」做指纹，窗口内只上报首次，之后只累加计数。

### 采样

高频崩溃会打爆服务器。`sampleRate` 只对非致命错误生效——
**崩溃（fatal）永远上报**。

## 4. 指纹：一个修了三次才对的地方

这条逻辑值得单独说，因为它错了三次，且每次都不报错。

**第一版**：`错误类型 : 首个堆栈帧`。但 Node 的堆栈第一行是
`TypeError: Cannot read properties...`，不是 `at ...`。
只跳过 `Error` 开头的话，`TypeError` **跳不过去**，
指纹变成 `TypeError:TypeError: Cannot read properties...`。

后果不只是难看——错误标题常含动态内容，会让同一个 bug 炸出大量指纹。

**第二版**：只认 `at ` 开头。但没去掉行号，
指纹是 `bossPhaseTwo (game.js:343:15)`。
改一次代码行号就变 → 同一个 bug 被当成新 bug。

**第三版（当前）**：

```typescript
TypeError:bossPhaseTwo (game.js)
```

- 只认真正的帧格式（V8 的 `at ...`，Safari 的 `func@file:1:2`）
- 抹掉行号列号（每次构建都可能变）
- 只留文件名（dev 与 release 的路径不同）
- 找不到帧时退化为「类型 + 规范化消息」，消息里的数字被抹成 `#`

最后一条兜底很关键：`new Error('A')` 和 `new Error('B')` 若都没有 stack
（跨 realm 对象、被序列化过、某些小游戏环境），指纹都会变成 `"Error:"`——
**第二个错误会被去重逻辑吞掉，永远不上报**。
这类"上报系统自己把报告丢了"的问题极难发现。

## 5. 四条设计约定

**① 不做网络传输。**
传输由宿主注入（`ICrashTransport`）。写死 `fetch` 就绑死在浏览器上了。

**② 日志靠注入，不直接持有 Logger。**
`bindLogSource(() => logger.export())` —— 零横向依赖。

**③ 上报自己崩了是最糟的情况。**
玩家看到闪退，你却什么都收不到。所以：
- 循环引用用 `safeStringify` 兜住
- transport 抛异常被捕获，走 `onError`
- **异步 transport 的 Promise rejection 必须 `.catch()`**，
  否则变成 unhandledrejection，某些环境直接二次崩溃
- 日志源自己崩了不影响上报

**④ 没配 transport 时不静默吞掉。**
会 `console.error` 打出报告内容。

## ⚠️ `capture()` 返回 `false` 有两种含义

```
false = 被去重 / 采样 / 过滤器拦下   ← 正常，故意不发
false = 传输或序列化失败             ← 异常，本该发出去却没发成
```

源码注释写的是 `@returns 是否实际发送了（false = 被去重/采样/过滤拦下）`——
**只提了前者，没提后者。**

照着注释写监控会把上报故障记成"主动丢弃"：

```typescript
if (!crash.capture(e)) {
  metrics.incr('crash.dropped');   // ❌ 真故障也被算进"主动丢弃"
}
```

**区分方法**：用 `onError` 回调。它只在**真的出错**时触发，
去重和采样拦下不会触发：

```typescript
new CrashReporter({
  transport,
  onError: (e) => metrics.incr('crash.send_failed'),   // ✅ 只统计真故障
});
```

---

## 6. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| 去重窗口首次记录 `lastSent = 0` | `now - 0` 是天文数字，**去重完全失效**，同一 bug 每帧上报 | 首次上报也必须把 `lastSent` 设为 `now` |
| 依赖真实时间流逝做断言 | 机器快慢不同结果就不同 | 测试里窗口设 0，让每次都上报 |
| `install()` 覆盖别人的 handler | 另一个 SDK 失效 | 保存旧 handler 并链式调用 |
| 循环引用 | 上报代码先崩 | `safeStringify` |
| 指纹含行号/动态 id | 去重失效 | 见第 4 节 |

## 6.5 API 补充

### 可单独用的纯函数

| 函数 | 说明 |
|---|---|
| `makeFingerprint(e)` | 算指纹（**去重靠它**） |
| `normalizeMessage(msg)` | 消息规范化：抹掉数字与长十六进制 |
| `safeStringify(v, maxLen?)` | 安全序列化（循环引用 / BigInt / Date） |
| `reportText(r)` | 把报告格式化成可读文本 |

> ⚠️ **指纹里不能带行号，消息里的数字必须抹掉。**
>
> 两个极端都会让去重失效：
> - **带行号** → 代码改一行，同一个 bug 变成新指纹
> - **不抹数字** → `player 123 not found` / `player 456 not found` 炸出无数指纹
>
> 但**反过来也有坑**：指纹全用 `"Error:"` 这种空模板的话，
> 第二个完全不同的错误会被去重吞掉，**永远不上报**。
> 你看到第一个 bug 修完以为没事了，其实另一个一直没进视野——
> 这类"上报系统自己把报告丢了"的问题极难发现。

### 导出类型

| 类型 | 说明 |
|---|---|
| `CrashSeverity` | `'fatal'` / `'error'` / `'warning'` |
| `CrashReport` | 报告主体（含 `severity`、面包屑、指纹等） |
| `Breadcrumb` | 面包屑：`time` / `category` / `message` / `level` / `data?` |
| `ICrashTransport` | 上报通道接口（自己接 HTTP / 文件就实现它） |
| `CrashReporterOptions` | 构造配置 |
| `ILogEntryLike` | **只依赖 logger 的类型，不 import 实现** |

> **`Breadcrumb.data` 会被 JSON 序列化，别塞循环引用。**
> 上报代码自己先崩是最尴尬的失败方式——
> 要塞复杂对象先用 `safeStringify` 过一遍。

## 7. 测试覆盖

41 项。重点覆盖：
- 去重的窗口内/跨窗口/累加计数
- 指纹的三类格式与行号抹除
- 循环引用、BigInt、Date 的安全序列化
- 同步与异步 transport 的异常
- 日志源崩溃不影响上报

## 8. 依赖

`../logger/Logger`（仅类型 `LogEntry` 与 `LogLevel`）。
