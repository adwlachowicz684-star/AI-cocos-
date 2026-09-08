# debug-console · 运行时调试控制台

> 把「验证这个遗物生效了吗」从 5 分钟压缩到 3 秒。

## 1. 它解决什么

没有调试控制台时，你想验证「这个遗物到底有没有生效」，流程是：
改代码 → 重新编译 → 重启游戏 → 打三分钟到那个场景 → 看日志。

有了控制台，流程是：按 ` 键 → 输入 `add_relic crit_boost` → 回车。

## 2. 五分钟上手

```typescript
import { DebugConsole } from './debug-console/DebugConsole';

const con = new DebugConsole();
con.onOutput(line => panel.append(line));   // 宿主决定怎么显示
con.onClear(() => panel.clear());

con.register({
  name: 'give',
  alias: ['g'],
  args: [
    { name: 'item',  type: 'string' },
    { name: 'count', type: 'int', optional: true, default: 1, min: 1, max: 999 },
  ],
  help: '给玩家物品',
  group: '物品',
  run: (a) => {
    bag.add(a.getString('item'), a.getInt('count'));
    return `已发放`;
  },
});

con.execute('give 火焰之剑 3');     // → "已发放"
con.execute('give "破损的 盾牌"');  // 引号内的空格不拆分
con.complete('gi');                  // → "give"（Tab 补全）
```

### API

**注册与查询**

| 成员 | 说明 |
|---|---|
| `register(def)` / `registerAll(defs)` | 注册（**返回 `this`，可链式**） |
| `unregister(name)` | 注销，返回是否真的删了 |
| `has(name)` | 是否已注册 |
| `list(includeHidden?)` | 命令列表。**默认不含 `hidden` 的** |

> ⚠️ **`list()` 默认排除了隐藏命令。**
> 自己做命令面板时传 `list(true)` 才能拿到全部——
> 不然"彩蛋命令"在面板里找不到，会以为是注册失败。

**执行与输出**

| 成员 | 说明 |
|---|---|
| `execute(line)` | 执行一行，返回**是否被识别为命令** |
| `onOutput(fn)` / `onClear(fn)` | 订阅输出 / 清屏 |

> ⚠️ **`execute` 返回的是"有没有这个命令"，不是"执行成功没有"。**
> 命令找到了但参数校验失败，返回值仍是 `true`——
> 错误信息走 `onOutput`。
> 判断成败要看输出内容，不能只看返回值。

**补全与历史**

| 成员 | 说明 |
|---|---|
| `complete(line)` | Tab 补全（返回补全后的整行） |
| `completeCandidates(line)` | 候选列表（**给下拉面板用**） |
| `historyPrev(current)` / `historyNext()` | 上翻 / 下翻 |
| `clearHistory()` | 清空历史 |

> **`complete` 和 `completeCandidates` 的分工**：
> 前者直接给"补全后的整行"（Tab 键用），
> 后者给"所有候选"（画下拉框用）。
> 用前者做下拉框只能显示一个选项。

## 3. 能力清单

| 能力 | 说明 |
|---|---|
| 参数类型 | `int` / `float` / `string` / `bool` / `enum` |
| 校验 | 范围（min/max）、类型、必填/可选、参数个数 |
| 引号 | `give "火焰 之剑" 5` —— 手写的 `split(' ')` 会拆成两个 |
| 补全 | Tab 补命令名（公共前缀）与 enum 值；`completeCandidates()` 给下拉用 |
| 历史 | ↑/↓，**仅避免与上一条完全相同的记录**（A / B / A 记为 3 条），越过头回到**草稿** |
| 模糊建议 | 编辑距离（不是子串匹配），`ad_relic` 能提示 `add_relic` |
| 内置命令 | `help`（`h` / `?`）/ `history` / `clear`（`cls`）/ `find` |

只有这四个，别多也别少——**`alias` 和 `set` 没有实现**。
源码 JSDoc 里曾经列过它们，实际从未注册，输入会得到"未知命令"。
| 隐藏命令 | `hidden: true` —— 不出现在 help 与补全，但可执行 |
| 错误分级 | `CommandError`（用户输入错，打印提示）vs 内部异常（**默认向上抛**，可 `rethrow: false` 改为只打印） |

## 4. 三条设计约定

**① 不画任何东西。**
UI 完全由宿主实现，本模块只负责「输入一行文本 → 输出结果」。
所以它在命令行、引擎内、网络远程调试里都能用。

**② 用户输入错误 ≠ 内部崩溃。**

```typescript
throw new CommandError('参数 <v> 需要整数');   // 打印红字，程序继续
// 其他任何异常 → 向上传播，交给 CrashReporter
```

混在一起的话，真 bug 会被当成"玩家输错了"而静默吞掉。

> ⚠️ **`rethrow` 开关（默认 `true`，即上面的历史行为）**
>
> 内部异常默认向上抛，是为了让崩溃上报链路抓得到。
> 但在**输入框 / 调试期**场景下，异常会落进 UI 的输入事件处理器——
> **一行打错的命令就能让整个输入系统崩掉**，而错误此时已经被打印过一次。
> 这类调用方显式传 `rethrow: false` 即可只打印红字、不向外抛：
>
> ```typescript
> const c = new DebugConsole({ rethrow: false });
> ```
>
> 【为什么默认值是 `true` 而不是反过来】
> 翻默认值属于**破坏性变更**：已经按本约定接入 CrashReporter 的调用方
> 会在毫不知情的情况下静默丢掉全部内部异常。
> 而"崩掉输入链路"是调用方**自己能规避**的（传一个参数）。
> 一个能自己规避的风险，不该用破坏性变更去替所有人规避。

**③ 构造时校验配置。**
`enum` 没给 `values`、`optional` 没给 `default` —— 注册时就抛错，
而不是等 Boss 战打到一半才发现。

## 5. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| `rest === ''` 时令 `argParts = []` | 输入 `"mode "` 后按 Tab 无反应 | 语义上玩家**正在输入第 0 个参数**，放空串占位 |
| `Number('')` 是 0 | 空参数被当成合法的 0 | 靠 `tokenize` 挡住，别用 `Number()` 判空 |
| 报"越界"但值在范围内 | 排查方向跑偏（去查 schema 而不是传进来的值） | 区分"类型不对"和"数值超限" |
| 子串匹配做建议 | `ad_relic` 提示不出 `add_relic` | 用编辑距离 |
| 重复注册静默覆盖 | 两个插件抢同一个命令名 | 直接抛错 |

## 6. 与 CheatCode 的关系

控制台是「通用命令入口」；作弊码是「控制台里的一类命令」。
作弊码单独抽出来是因为它需要**权限控制**（正式版要禁用），
而控制台本身在正式版也可能需要保留（只读的诊断命令）。

> ⚠️ **两者的 `CommandDef` 字段名不同，别复制粘贴。**
> CheatCode 用 `aliases` / `desc`，本模块用 `alias` / `help`；
> `run` 的签名也不同（CheatCode 是 `run(ctx)`，参数是 `ctx.args` 数组）。
> 完整对照见 [`cheatcode/README.md`](../cheatcode/README.md)。

## 6.5 类型与工具函数

### `CommandDef`

```typescript
{ name, alias?, args?, help, group?, hidden?, run(args, ctx) }
```

| 字段 | 说明 |
|---|---|
| `alias` | 简写（如 `'h'` 对应 `'help'`） |
| `group` | 分组（`help` 里按组展示） |
| `hidden` | 不在 help 与补全里出现，**但可执行**（内部命令、彩蛋） |
| `run` | 执行体。返回字符串会输出到控制台 |

### `ArgDef`

```typescript
{ name, type, optional?, default?, values?, help?, min?, max? }
```

| 字段 | 说明 |
|---|---|
| `type` | `ArgType`：`'int'` / `'float'` / `'string'` / `'bool'` / `'enum'` |
| `optional` | 默认 **true 是必需**。**可选参数必须排在必需参数之后** |
| `values` | `enum` 类型的候选值，**`type === 'enum'` 时必填** |
| `min` / `max` | 数值范围（只对 `int` / `float` 生效） |

> ⚠️ **可选参数必须排在必需参数之后。**
> 写成 `[a?] [b]` 的话，解析会错位——
> 表现为"传了两个参数，第二个却拿到默认值"。

### `ParsedArgs`

解析后的参数，**已按类型转好**：

| 成员 | 说明 |
|---|---|
| `raw` | 原始字符串数组 |
| `get(name)` | 按名字取（类型 `unknown`） |
| `getInt` / `getFloat` / `getString` / `getBool` / `getEnum` | 带类型的取值，**都可传 fallback** |

### `CommandContext`

`run` 的第二个参数：

| 成员 | 说明 |
|---|---|
| `print(line)` | 输出一行（**多行输出用它**，返回值只能给一行） |
| `clear()` | 清空屏幕 |
| `now` | 发起命令的时间（毫秒） |

### 工具函数

| 函数 | 说明 |
|---|---|
| `usageOf(def)` | 生成用法串：`give <item:string> [count:int]` |
| `tokenize(s)` | 分词（**支持引号**） |
| `similarity(a, b)` | 编辑距离相似度 **0~1** |

> **`similarity` 用编辑距离而不是 `includes`，是有实测理由的。**
> 玩家漏打一个字符（`ad_relic` → `add_relic`），
> 子串匹配下两者互不包含 → **给不出建议**。
> 编辑距离能兜住这类拼写错误。

### `DebugConsoleOptions`

| 字段 | 默认 | 说明 |
|---|---|---|
| `prefix` | 空 | 命令前缀。设为 `'/'` 后，只有以 `/` 开头的输入才当命令 |
| `historyLimit` | 100 | 历史上限 |
| `builtins` | true | 是否注册内置命令 |
| `suggestionThreshold` | 0.5 | 模糊建议阈值（0~1） |
| `rethrow` | true | 命令内部异常是否继续向上抛（传 `false` 则只打印红字） |

## 7. 测试覆盖

45 项。重点覆盖：
- 引号切分（含未闭合）
- 五种参数类型的校验与边界
- 补全（命令名公共前缀、enum、`"mode "` 空参数）
- 历史的草稿保护
- 模糊建议对漏字符有效

## 8. 依赖

零依赖，纯逻辑。
