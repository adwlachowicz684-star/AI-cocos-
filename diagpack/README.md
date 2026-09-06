# diagpack · 诊断包生成

```typescript
import { DiagCollector, safeStringify, redact, collectEnvironment } from './diagpack/DiagPack';
```

- 依赖：**无**
- 引擎耦合：**无**
- 测试：48 项

---

## 它解决什么

玩家反馈"游戏卡住了"，复现不了时唯一能依靠的就是诊断包。
手写的收集有三个典型缺陷：

**1. 信息不全，且每次都缺不同的东西**
第一次发现没记日志，加上日志，下次又发现没记设备信息……
**每次都是在最需要的时候才发现少收集了东西。**

**2. 没脱敏**
日志里有手机号、邮箱、登录 token。诊断包被发到群里、贴到工单系统——
**这是一次数据泄露事故**，而且它发生得很安静。

**3. 收集过程本身会崩**
遍历带循环引用的对象，`JSON.stringify` 直接抛 TypeError。
于是"生成诊断包"这个操作自己成了新的崩溃源：
玩家点"发送" → 崩 → 再点 → 再崩。

---

## 用法

```typescript
const diag = new DiagCollector({
  appId: 'my-game',
  version: '1.0.3',
  maxSectionChars: 20000,
  maxTotalChars: 200000,
  extraRedactions: [
    { name: 'pid', valuePattern: /PID-\d+/g, replacement: '[PID]' },
  ],
});

// 注册时才不执行，generate() 时才跑（避免为永远用不到的东西付费）
diag.section('environment', () => collectEnvironment(myEnv));
diag.section('save', () => readSaveData());
diag.section('logs', () => logger.recent(200));

// 生成
const report = diag.generate();
const json = diag.generateJson(undefined, false);   // pretty=false 便于上传
console.log(diag.summarize());                       // 贴工单发这个
```

**分区管理**：

| 成员 | 说明 |
|---|---|
| `section(name, fn)` | 注册分区（**注册时不执行**，`generate()` 时才跑） |
| `removeSection(name)` | 移除分区，返回是否成功 |
| `sectionNames` | 已注册的分区名列表 |

> ⚠️ **`removeSection()` 返回布尔，不是抛错。**
> 移除不存在的分区返回 `false`——
> 表现为"我明明移除了怎么还在报告里"。

> **`sectionNames` 是排查"报告里少了一块"的第一手工具。**
> 先看分区有没有注册上，
> 再查 `generate()` 的 `warnings` 里有没有被配额丢弃的记录。

---

## 分区设计

每个分区独立 try/catch：
- 一区收集失败 → 记入 `error` 字段，其他区照常产出
- 序列化失败 → 同上
- **`generate()` 永不抛错**

配额外，还有两层配额：
- `maxSectionChars`：单区超限截断，标 `[truncated]`
- `maxTotalChars`：全包超限，后续分区被丢弃并记入 warnings

---

## 安全序列化

`safeStringify` 处理四种会让 `JSON.stringify` 抛错或丢数据的情况：

| 情况 | 处理 |
|---|---|
| 循环引用 | → `[Circular]` |
| BigInt | → `123n` |
| 函数 / Symbol | → `[Function]` / `String(v)` |
| NaN / Infinity | → 字符串（**JSON 会变 null 丢信息**） |
| 超深嵌套 | → `[DeepObject]`（防爆栈） |

另外 `Map` / `Set` / `Date` / `Error` / TypedArray 都有对应处理。
`Error` 展开为 `{ name, message, stack }`。

---

## ⚠️ 脱敏在序列化之后做

```typescript
redact(safeStringify(data));
```

**不是**先脱敏再序列化。原因：脱敏要在**最终文本**上做。
在对象上做的话，那些被 `String(v)` 转成的字符串
（比如 `Error.stack`）里的手机号就漏掉了。

而 `stack` 恰恰是最容易带敏感信息的地方
（`POST /api/user/13800138000`）。

### 默认规则

`password` / `token` / `email` / `phone-cn` / `id-card` /
`credit-card` / `ip` / `jwt`

⚠️ 手机号正则 `1[3-9]\d{9}` 会误伤 11 位订单号。
但宁可误伤——诊断包里少一个数字不影响排查，
漏掉一个手机号是一次事故。

**实测（哪些会中招）：**

| 输入 | 输出 | 说明 |
|---|---|---|
| `{"phone":"13812345678"}` | `{"phone":"[REDACTED]"}` | ✅ 该脱 |
| `{"orderId":13812345678}` | `{"orderId":[REDACTED]}` | ⚠️ **误伤**（以 138 开头） |
| `{"orderId":12345678901}` | `{"orderId":12345678901}` | 未中招（第二位是 2，不在 `[3-9]`） |
| `{"playerId":"15901234567"}` | `{"playerId":"[REDACTED]"}` | ⚠️ **误伤**（11 位玩家 ID） |

判定只看"是否连续 11 位且前两位是 `1[3-9]`"，不看 key 叫什么。
所以**订单号 / 玩家 ID / 时间戳只要撞上这个形状就会被脱掉**。
排查"报告里某个数字不见了"时先想到这条。

> ⚠️ **两种脱敏的输出格式不一致**（实测）：
>
> ```
> keyPattern   → {"token": "[REDACTED]"}   冒号后**有空格**
> valuePattern → {"phone":"[REDACTED]"}    无空格
> ```
>
> 原因是 keyPattern 分支拼的模板是 `${keyPart} ${rep}`，
> 而 valuePattern 分支是直接 `replace(re, rep)`。
>
> 不影响 `JSON.parse`，但**字符串比对会失败**——
> 写测试断言时别用整串比对，用 `JSON.parse` 后再判。

**⚠️ 这些是最低限度，不是全部。**
每个项目的数据都不一样，务必用 `extraRedactions` 补充。

### 自定义规则

```typescript
{ name: 'pid', valuePattern: /PID-\d+/g, replacement: '[PID]' }
{ name: 'secret', keyPattern: /api[-_]?key/i }
```

⚠️ `valuePattern` 必须带 `g` 标志，否则只替换第一个。
（模块内部会自动补，但显式写上更清楚。）

---

## `collectEnvironment(env)`

```typescript
collectEnvironment({
  platform: 'iOS', os: '17.5', deviceModel: 'iPhone 15 Pro',
  memoryMB: 612, screenWidth: 2556, screenHeight: 1179,
});
```

**⚠️ 它接受 env 对象而不是直接访问全局。**
浏览器 / Cocos 原生 / Node 的环境 API 完全不同，
直接访问会让这个模块无法在 Node 里测试。

输出额外包含 `timezone` 与 `timezoneOffsetMin`——
玩家的"每天 0 点刷新"问题八成是时区理解不一致，
有了 offset 就能直接判断是客户端错了还是服务端错了。

---

## 类型

```typescript
type SectionName     = string;            // 分区名（就是字符串，没有枚举约束）
type SectionProvider = () => unknown;     // 分区提供者：返回任意可序列化数据
```

**`DiagPackConfig`**：

| 字段 | 说明 |
|---|---|
| `appId` / `version` | 应用标识与版本（**必填**，进报告头） |
| `maxSectionChars` | 单区字符上限（超限截断并标 `[truncated]`） |
| `maxTotalChars` | 全包上限（超限后续分区被丢弃，记入 warnings） |
| `extraRedactions` | **追加**的脱敏规则（不替换默认规则） |
| `includeTimestamp` | 是否带时间戳 |

> ⚠️ **`extraRedactions` 是"追加"，不是"替换"。**
> 默认的手机号、身份证规则**一直在**——
> 想关闭某条默认规则做不到，只能自己后处理。
> 这是刻意的安全设计。

**`RedactRule`**：

```typescript
{
  name: string;
  keyPattern?: RegExp;      // 匹配对象的 key
  valuePattern?: RegExp;    // 匹配值的文本
  replacement?: string;
}
```

> `keyPattern` 命中则整个值被替换；
> `valuePattern` 在字符串里做**部分**替换。

**`DEFAULT_REDACTIONS`**（导出，可读）：

| 规则 | 匹配 |
|---|---|
| `password` | key 含 password / pwd / secret |
| `token` | key 含 token / api-key / auth |
| `email` | 邮箱格式 |
| `phone-cn` | 中国大陆手机号 `1[3-9]\d{9}` |
| `id-card` | 18 位身份证 |
| `credit-card` | 银行卡号（4×4） |

> ⚠️ **`phone-cn` 会误伤 11 位的订单号 / ID。**
> 源码注释里明确写了"宁可误伤"——
> 诊断包里少一个数字不影响排查，漏一个手机号是一次事故。
> 看到报告里长数字串变成 `[phone-cn]` 别以为是 bug。

**`DiagnosticReport`**（`generate()` 的返回）：

```typescript
{
  schema: 'cocos-kit-diag/1';
  appId: string;  version: string;
  generatedAt: string;  generatedAtMs: number;
  sections: readonly DiagSection[];
  warnings: readonly string[];
  totalChars: number;
}
```

**`DiagSection`**：

```typescript
{
  name: SectionName;  data: unknown;
  error?: string;      // 该区收集失败时的错误信息
  truncated?: boolean; // 是否因超限被截断
  chars: number;
}
```

> ⚠️ **排查"报告里少了一块"要看两个地方**：
> `sections` 里该分区的 `error` 字段（收集失败），
> 以及顶层的 `warnings`（配额丢弃）。
> 只看 `sections.length` 会误判成"没注册"。

## 坑

| 坑 | 后果 |
|---|---|
| 先脱敏再序列化 | `stack` / URL 里的敏感信息漏掉 |
| 价值正则无 `g` 标志 | 只替换第一个手机号 |
| 循环引用未处理 | 生成诊断包时崩溃，玩家点一次崩一次 |
| 用 `JSON.stringify` | NaN/Infinity 变 null，排查时才发现少字段 |
| 收集过程无 try/catch | 一个分区崩掉整个包 |
| 直接访问全局环境 API | 无法在 Node 里测试 |
