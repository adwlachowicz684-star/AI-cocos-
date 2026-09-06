# cheatcode · 作弊码 / 命令系统

---

## 它解决什么

开发期你一定需要：跳关、加钱、无敌、解锁全部。

手写是散落各处的 `if (DEBUG && key === 'F1')`，然后**忘了删就上线了**。

本模块把作弊集中成一张命令表，一行开关全部关掉。

## 用法

```typescript
const cc = new CheatCode({ enabled: !IS_PRODUCTION });

cc.registerAll([
  { name: 'god', aliases: ['gm'], desc: '无敌',
    run: () => { god = !god; return `god=${god}`; } },

  { name: 'setgold', desc: '设金币',
    args: [{ name: 'amount', type: 'int' }],
    run: ({ args }) => { player.gold = args[0]; return `gold=${args[0]}`; } },

  { name: 'nuke', desc: '清场', hidden: true, run: () => 'boom' },
]);

cc.execute('setgold 999');
cc.execute('/god');           // 前缀模式
cc.prevHistory();             // 上方向键
```

## API

| 成员 | 说明 |
|---|---|
| `register(def)` / `registerAll(defs)` | 注册 |
| `unregister(name)` | 注销，返回是否真的删了 |
| `has(name)` / `commands` | 是否已注册 / 命令列表 |
| `execute(raw)` | 执行，返回 `ExecuteResult` |
| `complete(prefix)` | 前缀补全候选 |
| `help(showHidden?)` | 生成帮助文本。**默认不含 `hidden`** |
| `history` / `prevHistory()` / `nextHistory()` / `clearHistory()` | 历史 |
| `enabled` | 总开关状态 |

> ⚠️ **`help()` 默认排除了 `hidden` 命令**——
> 隐藏命令仍可执行，只是不出现在帮助里。
> 传 `help(true)` 才能看到全部（调试时用）。

### `ExecuteResult`

| 字段 | 说明 |
|---|---|
| `handled` | 是否识别并**尝试**执行了命令 |
| `output?` | 命令的返回值 |
| `error?` | 错误信息 |

> ⚠️ **`handled === true` 不代表执行成功。**
> 命令找到了但参数校验失败（如 `setgold abc`），
> `handled` 仍是 `true`，错误在 `error` 里。
> 判成败要看 `error`，不能只看 `handled`。

### 类型与工具函数

| 导出 | 说明 |
|---|---|
| `ArgType` | `'int'` / `'number'` / `'string'` / `'bool'` |
| `ArgDef` | `{ name, type?, optional?, default?, desc? }` |
| `CommandDef` | `{ name, aliases?, desc?, args?, hidden?, run }` |
| `CommandContext` | `{ args, raw }` —— **`args` 是数组，按位置取** |
| `tokenize(input)` | 分词（**支持引号**） |
| `levenshtein(a, b)` | 编辑距离（**整数，不是 0~1 的相似度**） |

> ⚠️ **`levenshtein` 返回的是"改几个字符"，越小越像。**
> DebugConsole 的 `similarity` 返回 0~1，**越大越像**。
> 两个模块这项指标方向相反，别混用。

> **`ArgDef.optional` 后面不能跟必填参数**，
> 和 DebugConsole 一样——可选参数必须排在最后。

## 和 DebugConsole 的分工

| | CheatCode | DebugConsole |
|---|---|---|
| 定位 | 游戏内作弊 | 开发期调试面板 |
| 典型命令 | god / setgold / jumpfloor | reload / spawn / profile |

两者可并存：DebugConsole 把未知命令转发给 CheatCode。

### ⚠️ 但两者的 `CommandDef` 长得像，字段却不一样

这是库里最容易踩的一个坑：**两个模块都有命令、都有参数定义，
但字段名和 `run` 的签名完全不同。**

| | CheatCode | DebugConsole |
|---|---|---|
| 命令别名 | `aliases` | `alias` |
| 帮助文本 | `desc` | `help` |
| 参数类型 | `int` / `number` / `string` / `bool` | `int` / `float` / `string` / `bool` / `enum` |
| `run` 签名 | `run(ctx)`，**参数在 `ctx.args`** | `run(args, ctx)`，**参数在 `args`** |
| 取参数 | `ctx.args[0]`（**数组**） | `args.getString('item')`（**按名字**） |

实测同一个 `give sword 5`：

```typescript
// CheatCode
run: (ctx) => { /* ctx.args = ["sword", 5]  ← 位置数组 */ }

// DebugConsole
run: (a) => { /* a.getString('item') = "sword" ← 按名字取 */ }
```

> **复制粘贴命令定义会静默失效。**
> `alias` 少个 `s` 不报错，只是别名不生效；
> `desc` 写成 `help` 不报错，只是帮助文本空白。
> 这类问题不会崩，只会"功能好像没生效"，调试时极难联想到字段名。

> **参数取值方式也不同**：CheatCode 靠**位置**，DebugConsole 靠**名字**。
> 加一个参数就要改所有下标——这是 CheatCode 的代价，
> 换来的是更轻的实现（不做命名映射）。

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **`parseInt('12abc')` 返回 12** | 静默接受脏输入。用正则 `/^-?\d+$/` 全匹配 |
| **发布开关要真正零副作用** | `enabled=false` 时直接 return，不解析不执行不改状态 |
| **历史到底要进草稿态** | 标准 shell 语义：翻到最旧后再按上键回到空白输入 |
| **相同命令不重复记录** | 否则按上键要按十几次才翻到上一条不同的 |
| **命令名是精确匹配，不是前缀匹配** | 见下 |

### ⚠️ 命令名是精确匹配，没有"短码优先"

**这一条曾经写反过**：旧文档说"`GOLD` 和 `GOLDEN` 同时存在时，短码优先触发"——
源码里**从来没有任何前缀匹配逻辑**，这句话是凭印象写的。

实测（`gold` / `golden` / `gol` 都注册了 `gold` 与 `golden`）：

```
输入 "gold"    → 执行 GOLD
输入 "golden"  → 执行 GOLDEN
输入 "gol"     → 未知命令：gol。你是不是想找 "gold"？
```

查找就是 `this._byName.get(name.toLowerCase())`，**精确匹配，一步到位**。
所以：

- 不存在"短码抢占长码"的问题——`gold` 永远不会误触发 `golden`
- 但也不支持"输入前缀自动补全执行"，`gol` 只会报未知命令（**附带拼写建议**）

> 顺带说清"前缀"在本模块里的意思：
> 它指 `CheatCodeOptions.prefix`（默认空，可设为 `'/'`），
> 是**命令前导符**，跟命令名之间的前缀匹配毫无关系。

## 测试

**44 项**，覆盖参数类型校验（`setgold abc` 不执行）、拼写建议、别名、隐藏命令、历史导航的完整语义。
