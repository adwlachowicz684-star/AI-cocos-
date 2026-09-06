# Logger · Assert

分级日志 + 快速失败断言。

## Logger

### 为什么需要环形缓冲

生产环境的崩溃往往没有控制台。玩家只告诉你「游戏闪退了」，你什么线索都没有。

环形缓冲保留最近 N 条日志，**崩溃时能把它导出来**——这是唯一能还原现场的手段。

```typescript
import { Logger, LogLevel } from './logger/Logger';

const log = new Logger({ level: LogLevel.Debug, bufferSize: 200 });
const combat = log.module('combat');

combat.info('敌人生成', { id: 'slime', hp: 30 });
combat.error('伤害计算异常', { raw: NaN });

// 崩溃时导出（作为崩溃报告的附件）
crashReporter.attach(log.exportText());

// 生产环境关掉 debug/info
log.setLevel(LogLevel.Warn);
```

### 四个设计要点

**① 传数据对象，不要拼字符串**

```typescript
combat.debug('生成敌人 ' + JSON.stringify(e));   // ❌ 级别关掉时拼接开销仍在
combat.debug('生成敌人', e);                      // ✅ 不输出就不用序列化
```

**② 模块可单独设级别**

调试某个系统时把它的级别调低，其他系统保持安静：

```typescript
log.setLevel(LogLevel.Error);              // 全局只看错误
log.setModuleLevel('network', LogLevel.Debug);  // 但网络模块看调试
```

**③ sink 机制**

库不关心"输出到哪"——引擎控制台、文件、远程上报、UI 调试面板，由宿主决定：

```typescript
const off = log.addSink((e) => debugPanel.append(e));
```

**④ 导出是时间顺序**

环形缓冲的物理顺序不是时间顺序。直接按下标输出日志会是乱的——
排查问题时这比没有日志更糟（你会沿着错误的时间线推理）。`export()` 已处理好。

## Assert

### 核心理念：开发期的崩溃是朋友

```typescript
if (hp < 0) return;                    // ❌ 静默失败
Assert.isTrue(hp >= 0, 'HP 为负');     // ✅ 立刻崩在出错的那一行
```

第一种你会花三小时找「为什么敌人不动了」；第二种你花三秒改掉那行。

### 用法

```typescript
import { Assert } from './logger/Assert';

Assert.notNull(target, '伤害目标不能为空');
Assert.range(damage, 0, 9999, '伤害超出合理范围');
Assert.finite(value, '数值不能是 NaN');

// 兼具断言与类型收窄
const cfg = Assert.found(map.get(id), `配置 ${id} 不存在`);
// 此后 cfg 必定非空

// 穷尽性检查：加了新状态忘了处理 → 编译期报错
switch (state) {
  case 'idle': break;
  case 'run':  break;
  default: Assert.unreachable(state);
}
```

### 生产环境要 Strip

断言有运行时开销，而且生产环境崩溃比"带病运行"更糟
（玩家正在打 Boss 时崩溃，体验极差）。

约定：**断言只在开发期生效**，生产构建时通过压缩器移除。
判断依据用 `__DEV__` 之类的**编译期**常量，而不是运行时 if——
运行时 if 的话断言代码仍然会被打进包里。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 生产环境忘了关 debug | 字符串拼接开销 | 发布前 `setLevel(Warn)` |
| 日志无限增长 | 内存占用 | 环形缓冲，固定容量 |
| 错误日志没上下文 | 只有 "undefined is not an object" | 传 data 对象，写清模块名 |
| 用 `console.log` 而非分级 | 无法批量关闭 | 一律用 `log.debug/info/warn/error()` |
| 断言信息写 "assert failed" | 等于没写 | 写清「什么不该发生」 |
| 生产环境用断言掩盖逻辑错误 | 玩家体验崩溃 | 断言只用于开发期；生产期用软失败 + 上报 |

## API

### Logger
| 成员 | 说明 |
|---|---|
| `trace/debug/info/warn/error(module, msg, data?)` | 分级写入 |
| `module(name)` | 创建绑定模块的日志器（返回 `ModuleLogger`） |
| `setLevel(level)` / `setModuleLevel(m, level)` | 级别控制 |
| `addSink(fn)` | 添加输出目标，返回取消函数 |
| `export()` / `exportText()` | **按时间顺序**导出缓冲 |
| `buffered` | 缓冲条目数 |
| `clearBuffer()` | 只清缓冲，**保留级别与 sink 设置** |
| `clearModuleLevel(module)` | 取消某个模块的单独级别，回落到全局 |
| `destroy()` | 清空 |

> **`clearBuffer()` vs `destroy()`**
> 前者只清缓冲，级别和 sink 都留着——**崩溃上报后清空**用它，
> 免得同一批日志被上报两次。后者是彻底释放。

> ⚠️ **不 `clearBuffer()` 的话，环形缓冲会一直留着旧日志。**
> 崩溃时 `export()` 出来的是**最近 N 条**，
> 如果崩溃发生在启动阶段，导出的可能全是启动日志而不是崩溃前的现场。

> **`setModuleLevel` 设的单独级别要用 `clearModuleLevel` 才能取消。**
> 没有"重置全部模块级别"的 API——
> 想恢复默认只能记下自己设过哪些，逐个清。

### 导出类型

```typescript
interface LogEntry { level, module, message, data?, time }
```

`export()` 返回 `LogEntry[]`，`exportText()` 返回格式化文本。

**`LoggerOptions`**：

| 字段 | 说明 |
|---|---|
| `level` | 最低**输出**级别。**低于此级别的只写缓冲，不输出到控制台** |
| `bufferSize` | 环形缓冲大小 |

> ⚠️ **`level` 挡的是"输出到控制台"，不是"是否记录"。**
> 低于级别的日志**仍然进缓冲**——这是刻意的：
> 崩溃时要能导出崩溃前的 `Trace` 级日志，
> 如果低级别日志根本不记录，崩溃现场就丢了。

> **`bufferSize` 是固定内存开销。**
> 200 条 × 平均 200 字节 ≈ 40KB，移动端可接受；
> 设成 10000 就是 2MB 常驻，纯浪费。

### Assert
| 方法 | 说明 |
|---|---|
| `isTrue/false(cond, msg)` | 条件断言 |
| `notNull(v, msg)` | 非空 + 类型收窄 |
| `range(v, min, max, msg)` | 数值区间 |
| `finite(v, msg)` | **非 NaN / 非 Infinity** |
| `index(i, len, msg)` | 数组越界 |
| `found(v, msg)` | 查找必须成功，返回值 |
| `unreachable(never, msg)` | 穷尽性检查 |
| `soft(cond, msg)` | 只告警不抛出 |

### LogLevel
`Trace(0) < Debug(1) < Info(2) < Warn(3) < Error(4) < Silent(5)`

### ModuleLogger

`logger.module('combat')` 的返回类型。方法是**不带 module 参数**的同名版本：

```typescript
const log = logger.module('combat');
log.info('技能释放', { id: 'fire' });   // 不用再写 'combat'
```

它只有 `trace` / `debug` / `info` / `warn` / `error` 五个方法——
**级别控制、导出、缓冲这些都在主 `Logger` 上**。

### AssertionError

断言失败时抛出的是 **自定义错误类型**，不是普通 `Error`。

```typescript
export class AssertionError extends Error { name = 'AssertionError' }
```

> **为什么自定义**：便于在崩溃上报里区分「断言失败」和「普通异常」——
> 断言失败意味着**程序逻辑有 bug**，优先级最高，
> 和"玩家断网导致的异常"不该混在一起看。
>
> 上报侧判 `err.name === 'AssertionError'` 就能拿到这个区分。
>
> ⚠️ 源码注释里记了一条：继承内置 `Error` 时必须手动恢复原型链，
> 否则 ES5 编译目标下 `err instanceof AssertionError` 会返回 false。
