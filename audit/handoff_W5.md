# 精审返工任务书 · 窗口 W5

> 本文件是**第二次精审 273 条**中分配给窗口 W5 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **28**（P1 18 / P2 10） |
| 单元 | **10** 个 |
| 来源批次 | batch2 |
| 并行窗口 | 共 8 个（W1~W8），**单元零重叠** |

---

## 0. 一句话任务

按第 3 节的清单，逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

---

## 1. 角色与纪律

你是**执行者**，不是审查者。拿到清单 → 复现 → 修 → 写测试 → 自检。

### 1.1 三条硬纪律

1. **不要顺手重构。** 只改清单指出的那一行/那一处。
   这个库大量"看起来别扭"的写法都带长注释解释原因；你"顺手优化"的代码，
   很可能是另一个单元赖以正确工作的前提。
   我自己就在 `prewarm` 上犯过——顺手把预热数夹到 `maxSize` 以内，
   既有测试立刻变红，因为那两个是**独立的契约**。

2. **改之前必须先复现。** 写个最小脚本跑出"修复前"的现象，把真实输出贴进报告。
   没有复现就不要改——报告里的"证据"是别的窗口写的，你要自己验证一遍。

3. **注释要写"为什么"，不是"改了什么"。**
   重点写：坑的表现是什么、为什么原写法会中招、为什么新写法是对的。
   这个库最大的价值就是这些注释——很多坑会换个地方重新长出来。

### 1.2 一个反直觉但很重要的口径

**注释/文档如果主动论证"这是设计如此"，你要格外警惕，而不是格外放心。**

真实案例：

- `perception` 的抖动注释写"只影响观感，不需要可复现"——实测抖动值直接喂进了 `alert` 累积，**注释前提是假的**。
- `_core` 的 `smoothDamp` 曾把失效的 maxSpeed 记成"Unity 标准行为，非 bug"，还附了实测数据和权威叙事——**数据为真、归因为假**。
- README 曾把已修的缺陷记成"设计如此"，导致后来的人看到文档就不去修。

**文档说"没问题"不等于真没问题。按证据判断，不按注释判断。**

---

## 2. 代码库速览

```bash
cd /data/workspace/AI-cocos--main
bash build.sh                    # 编译到 .build/（不要跳过）
node .build/tests/run.js         # 全量回归
```

`build.sh` 有产物自愈与**逐文件比对**（不是只比总数——总数校验抓不到"tests 少 23 个"的情况）。

### 2.1 七条铁律（违反会导致构建/校验失败）

| 铁律 | 内容 |
|---|---|
| 1 | **无引擎依赖**：不得 `import 'cc'`，只能用注入的适配器。唯一例外 `adapters/CocosAdapter.ts` |
| 2 | **不 import 引擎类型**：连 `import type { Node } from 'cc'` 也不行 |
| 3 | **运行时依赖 0**：不得 import 任何第三方包 |
| 4 | **配置驱动**：数值不得硬编码，要可配 |
| 5 | **可卸载**：有 `install` 必须有对应的 `uninstall`/`destroy` |
| 6 | **禁止横向 import**：单元之间不得互相 import（`_core` 例外） |
| 7 | **复制即可用**：使用者拷走目录后改 0 行 |

### 2.2 现成共享工具（`_core/`，**直接用，不要自己造**）

| 工具 | 用途 |
|---|---|
| `clampNum(v, lo, hi, def)` | 数值收口，**NaN 会回落到 def** |
| `numOr(v, def)` | 非有限值回落 |
| `safeDt(dt)` | dt 守卫（挡 NaN / 负数 / 过大） |
| `needCount(n, max?)` | 无界 count 守卫（挡 Infinity / NaN） |
| `hasOwn(obj, k)` | 原型链安全的 `in` |
| `assertSafePath(p)` | 路径写入的原型污染防护 |
| `MathRandomSource` | 唯一允许的随机源 |

**`_core/` 不在任何窗口的清单里，严禁修改。** 它被 55 个单元依赖，你改一行会同时影响另外 7 个窗口。

### 2.3 六个校验脚本（提交前全部要过）

```bash
node scripts/check-deps.js        # 依赖分层
node scripts/check-links.js       # 内部链接
python3 scripts/scan-dt-guard.py  # dt 守卫
python3 scripts/scan-num-guard.py # 数值收口
python3 scripts/check-random-source.py  # 随机源
python3 scripts/check-dup-exports.py    # 重复导出
```

⚠️ **临时验证脚本放 `verify/` 会导致 `check-deps.js` 报错**（该目录未登记分层）。
用完请删除 `verify/`，或直接放 `/tmp` 下。

---

## 3. 本批清单

### 3.1 你的单元（10 个，与其它窗口零重叠）

```
autoquality  diagpack  interact  logger  loot  meta  runscope  scheduling  score  tween
```

---


## 【P1】先做这批

### P1 · [autoquality] `setManualLevel` 写入的 history 记录 from === to，切换前档位丢失

- **位置**：`autoquality/AutoQuality.ts:248`（`this._level = level;`）与 L253（`from: this._level`）——先赋值再取旧值
- **证据**：`verify/b2_v4.ts` §C 实测：`history = [{"from":0,"to":0,"reason":"玩家手动设置"}]`，`from === to` 为 true。
- **后果**：`describe()`（L324-326）里所有手动切换都显示成 `· 2 → 2`，看不出玩家从哪档切过来；排查"为什么画质降了"时这段历史是废数据。
- **建议**：在 L248 之前先 `const from = this._level;`。

### P1 · [autoquality] `FpsMeter` 的窗口大小未收口，NaN 直接构造数组崩溃

- **位置**：`autoquality/AutoQuality.ts:375`（`this._window = Math.max(3, windowSize);`）
- **证据**：`verify/b2_v4.ts` §B 实测：`FpsMeter(NaN)` 抛 `Invalid array length`（`new Array(NaN)`）。
- **后果**：同一个文件里 `AutoQuality` 用 `clampNum`（L100）而 `FpsMeter` 用裸 `Math.max`，配置来源相同时一个安全一个崩溃。崩溃点在构造函数，堆栈不会指向配置。
- **建议**：统一 `clampNum(windowSize, 3, 1e6, 60)`。

### P1 · [diagpack] `safeStringify` 把"共享引用"误判成循环引用，静默丢数据

- **位置**：`diagpack/DiagPack.ts:119-120`（`if (seen.has(o)) return '[Circular]'; seen.add(o);`），`seen` 在 `walk` 全程只增不回溯
- **证据**：`verify/b2_v4.ts` §L 实测：
  ```
  safeStringify({a: shared, b: shared}) = {"a":{"hp":100},"b":"[Circular]"}
  ```
- **后果**：同一个配置对象被两个字段引用（游戏中极常见：全局配置表被多个系统持有）时，诊断包里第二个字段变成 `"[Circular]"`。 crash 上报丢的是最关键的那份上下文，且看起来像"数据结构有问题"，实际是序列化器的问题。
- **建议**：`seen` 改成"路径栈"语义——进入时 `add`、递归返回时 `delete`（真正的环才会被拦下）。

### P1 · [diagpack] 脱敏把 JSON 结构改坏（且失败时空 catch 静默跳过）

- **位置**：`diagpack/DiagPack.ts:163-171`（keyPattern 的正则 `"[^"]*(?:src)[^"]*"\s*:\s*(?:"[^"]*"|[^,}\]]+)`）、L173-175（空 `catch {}`）
- **证据**：`verify/b2_v4.ts` §L 实测：
  ```
  redact 结果 = {"password": "[REDACTED]","nested":1}}     ← 多出一个 }，JSON 已损坏
  JSON.parse 失败 = Unexpected non-whitespace character after JSON at position 3
  诊断包里该分区 data 类型 = string  内容 = "{\"password\": \"[REDACTED]\"}}"
  ```
- **后果**：敏感字段的值是对象/数组时，脱敏后的报告不是合法 JSON，服务端解析失败 → 整个诊断包作废（"永不抛错"的承诺保住了，但上报内容不可用）。更严重的是 L173 的空 catch：任何正则异常都会让**脱敏被静默跳过**，而 README 承诺"序列化后脱敏"——这是可能把明文密码/token 报上去的路径。
- **建议**：脱敏改在**结构化数据上**做（在 `walk` 里按 key 匹配替换值），不要对 JSON 字符串做正则；catch 里至少 push 一条 warning。
- **影响面**：见存疑第 5 条（是否升 P0）。

### P1 · [interact] `Interactable` 接口没有 `pos` 字段，实现却靠双重强转去取——类型系统与文档对不上

- **位置**：`interact/Interact.ts:162`（`const pos = (item as unknown as { pos?: InteractContext['pos'] }).pos;`），接口定义 L6-26 无 `pos`
- **现象**：按接口类型写 `register({ id, data, radius })` 完全合法，此时 `evaluate` 走 L165-167 分支，返回 `distance: 0, alignment: 1, inRange: true`。
- **证据**：`verify/b2_v4.ts` §O 实测：
  ```
  相距无穷远（接口里没有 pos 字段）→ 候选数 = 1  distance = 0  inRange = true  valid = true
  ```
- **后果**：README §L61 说明"不提供 pos 时视为全局可交互（UI 按钮等）"，所以**运行时行为符合文档**；但 README §L19 的示例 `sys.register({ id:'chest', data:{...}, radius:3, pos:{x,y} })` 在 `strict` 下会因多余属性检查编译失败——用户必须自己 `as any` 才能照文档用。真正的风险是：按接口实现的调用方（不传 pos）会得到一个"永远可交互"的物体，而这在类型层面完全看不出来。
- **建议**：把 `pos?: { x: number; y: number; z?: number }` 正式加进 `Interactable`，去掉 L162 的双重强转。
- **影响面**：无下游（零依赖单元），但影响所有接入方的写法。

### P1 · [logger] `log()` 里的 Silent 判断是空 if 块，Silent 下仍在分配对象并写环形缓冲

- **位置**：`logger/Logger.ts:104-106`
  ```ts
  if (this._level === LogLevel.Silent && !this._moduleLevels.has(module)) {
  }
  ```
- **现象**：明显的漏写 `return`。结果是不管级别如何，每次 `log()` 都会构造 `entry` 对象（含 `Date.now()`）并 `_push` 进环形缓冲。
- **证据**：`verify/b2_v3.ts` §8 实测：`level=Silent` 下打 2 条日志 → `buffered = 2`，`export().length = 2`。
- **后果**：把日志级别设为 Silent（上线/压测常见）后，日志的对象分配、时间戳调用、缓冲写入一项都没省；同时环形缓冲被 Silent 期的日志占满，真正崩溃前的关键日志反而被挤出——与本单元"保留崩溃现场"的核心价值直接冲突。
- **建议**：补 `return;`（若希望 Silent 仍保留缓冲，请改写成显式注释 + 配置项，而不是留一个空块）。
- **影响面**：logger 是地基级单元，所有单元的日志开销都受影响。

### P1 · [loot] 子表互相引用时 `roll()` 无限递归栈溢出

- **位置**：`loot/LootTable.ts:151-154`（`e.child.roll(rng)`），`entry()`（L51-59）未做环检测
- **证据**：`verify/b2_v4.ts` §I 实测：A.child=B、B.child=A 时 `a.roll()` 抛 `Maximum call stack size exceeded`。
- **后果**：配置里把两张表配成互相包含（改表时的常见手误）会让掉落逻辑在运行时直接崩；`entry()` 阶段不报错，所以只在"玩家开箱那一刻"暴露。
- **建议**：`entry()` 时用一个 Set 记录已见 child 链，或在 `roll` 里传入深度上限。

### P1 · [loot] `pickUnique` 与 `setWeight(v, 0)` 语义冲突，直接抛错

- **位置**：`loot/WeightedTable.ts:91-92`（`work.add(it.value, it.weight)`）vs L25（`setWeight` 允许 `weight >= 0`）vs L17（`add` 要求 `weight > 0`）
- **证据**：`verify/b2_v4.ts` §H 实测：表里有被 `setWeight('b', 0)` 的项时，`pickUnique` 抛 `[WeightedTable] 权重必须为正，实际 0`。
- **后果**：调用方用 `setWeight(x, 0)` 临时下架一个掉落（很自然的操作）之后，再调 `pickUnique` 就崩；而 `pick()` 在同一状态下是正常工作的——同一份数据两个 API 行为不一致。
- **建议**：`pickUnique` 建临时表时跳过 `weight <= 0` 的项，不要用 `add` 硬塞。

### P1 · [loot] `PRD._cache` 是静态 Map，只增不减无上限

- **位置**：`loot/PRD.ts:36`（`PRD._cache.set(chance, c)`）、L92（`private static readonly _cache = new Map()`）
- **证据**：`verify/b2_v5.ts` §R 实测：用 5000 个不同概率 → 缓存条目 `0 → 5000`。
- **后果**：概率是动态计算的场景（难度曲线每局微调、按玩家等级插值）会让缓存无限增长；每个条目虽小，但进程生命周期内永不释放，是典型的长期运行泄漏。
- **建议**：改成 LRU（上限如 512）或按量化后的概率做 key。

### P1 · [loot] `Chest.importState` 不校验索引，越界时静默产出 `undefined` 选项

- **位置**：`loot/Chest.ts:123-129`（`this._currentIndices = snap.current.slice();` → `_applyIndices()` L134 `this._items[i]`）
- **现象**：物品表改过（数量变少）或存档被改时，`_current[i]` 为 `undefined`，`take()` 返回 `undefined` 但仍把状态置为 `'taken'`。
- **后果**：玩家点宝箱拿到"空"，且宝箱状态已消耗——不可恢复的静默错误。
- **建议**：导入时过滤 `i >= 0 && i < this._items.length`，并记录被丢弃的索引。

### P1 · [meta] `requires` 里写了不存在的节点 id 时，依赖被静默跳过

- **位置**：`meta/MetaProgression.ts:219`（`if (!this._nodes.has(req)) continue;`），`_findCycle` 同样 L426
- **证据**：`verify/b2_v4.ts` §F 实测：节点 `need` 的 `requires: ['不存在的节点']` → `canUnlock = {"ok":true,"cost":0}`，构造时不报错。
- **后果**：依赖名拼错（货币拼错会抛错、节点拼错不抛）→ 前置条件形同虚设，玩家可以直接解锁终局节点。这是"防呆不对称"：同一个构造函数里货币校验是严格的，节点依赖校验是静默的。
- **建议**：构造期就校验所有 `requires` 必须存在，不存在即抛。

### P1 · [meta] `set` 效果被等级缩放（与 blessing/curse 同款）

- **位置**：`meta/MetaProgression.ts:328`（`e.set = e.set === undefined ? eff.value * lv : Math.max(e.set, eff.value * lv)`）
- **证据**：`verify/b2_v4.ts` §G 实测：Lv2 的 `set(50)` → `{"set":100}`。
- **后果**："设为固定值"的节点在 Lv2/Lv3 给出 2 倍/3 倍的值，数值曲线与设计完全不符。
- **建议**：`case 'set'` 直接用 `eff.value`。

### P1 · [meta] `setLevel` 的 NaN 让"是否解锁"与"是否生效"自相矛盾

- **位置**：`meta/MetaProgression.ts:275`（`Math.max(0, Math.min(level, this.maxLevel(nodeId)))`）
- **现象**：`level` 为 NaN → `Math.min(NaN, mx)` = NaN → `Math.max(0, NaN)` = NaN。`isUnlocked`（L180）判定 `NaN > 0` = false（未解锁），但 `effects()`（L314 `if (lv <= 0) continue`）中 `NaN <= 0` 也是 false → 进入计算 → `eff.value * NaN` = NaN。
- **后果**：一个"看起来没解锁"的节点却在产出 NaN 效果，污染整条属性聚合链（`compute` 返回 NaN）。
- **建议**：`setLevel` 入口收口 level 为有限非负整数。

### P1 · [runscope] 用原型链上的键访问时 `has()` 返回 true 但 `get/set` 崩溃（已知 easing() 原型污染的新实例）

- **位置**：`runscope/ScopedStore.ts:103`（`return key in this._schema || ...`）、L149（`const def = this._schema[key];`）
- **证据**：`verify/b2_v4.ts` §K 实测：
  ```
  has('toString') = true           （原型链命中，应为 false）
  get('toString') 抛错 = Cannot read properties of undefined (reading 'get')
  set('valueOf', 1) 抛错 = Cannot read properties of undefined (reading 'set')
  ```
  （`def` 取到 `Object.prototype.toString`，`def.scope` 为 `undefined`，`this._data[undefined]` 为 undefined。）
- **后果**：键名来自外部输入（存档字段、配置表键、RPC 字段名）时，`has('toString')` 与 `get('toString')` 行为不一致——先 `has` 再 `get` 的标准写法会崩在 `get` 上，且错误信息 `Cannot read properties of undefined (reading 'get')` 完全指不到根因。
- **建议**：所有 schema 查表改用 `Object.prototype.hasOwnProperty.call(this._schema, key)`（L103、L107、L149、L195），或在构造时把 schema 复制进 `Map`。

### P1 · [runscope] `getOr` 用 try/catch 吞掉了 strict 模式的核心保护

- **位置**：`runscope/ScopedStore.ts:119-126`（`try { ... } catch { return fallback; }`）
- **现象**：strict 模式下"局外读局内数据"会抛错（L170），而 `getOr` 把异常吞掉返回 fallback。
- **后果**：本单元存在的意义就是"让串档 bug 立刻炸出来"，而 `getOr` 是唯一一个静默绕过的入口。调用方图省事全用 `getOr` 时，整个防串档机制失效且无感知。
- **建议**：`getOr` 只吞"键不存在"，把"越界访问"继续抛（或加 `getOr(key, fallback, { swallowCrossScope: false })`）。

### P1 · [scheduling] `StepContext.elapsed` 恒为 0，接口承诺的字段从不赋值

- **位置**：`scheduling/FrameScheduler.ts:193-196`（`const ctx: StepContext = { hasTimeLeft: ..., elapsed: 0 };`），接口声明 L23-28
- **证据**：`verify/b2_v3.ts` §7 实测：`StepContext.elapsed 实际值 = 0`（任务执行到一半、跨多帧时仍是 0）。`flush()`（L151）同样写死 `elapsed: 0`。
- **后果**：调用方按接口用 `ctx.elapsed` 做"已耗时"判断或进度条，永远得到 0——静默的错误读数，且类型检查完全看不出来。
- **建议**：改成 `elapsed: this._now() - this._frameStart`（或让 `elapsed` 成为 getter）。

### P1 · [score] 指标被设成 NaN 后总分变 NaN，静默评为最低档

- **位置**：`score/ScoreSystem.ts:124-129`（`set` 无校验）→ L238（`inverseLerp`）→ L242/244（`clamp01(t) * 100`）→ L209-213（`grade()` 的 `s >= g.minScore`）
- **证据**：`verify/b2_v4.ts` §M 实测：`total = NaN  grade = D`（无异常、无警告）。
- **后果**：一次 `add('kills', NaN)`（例如从 UI/网络拿到的未初始化值）之后，玩家结算永远是最低档。因为 `grade()` 的兜底是"返回最后一档"，看起来"评级功能正常"，实际是 NaN 短路。
- **建议**：`set/add` 入口 `if (!Number.isFinite(value)) throw`（或忽略并 warn），并在 `total()` 里对 NaN 做兜底上报。

### P1 · [tween] `ease()` 用 Record 查表，原型键被当成缓动函数（已知 easing() 原型污染的新实例）

- **位置**：`tween/Tween.ts:41-45`（`const fn = Easing[name as EasingName]; if (!fn) { ... throw }`）
- **现象**：缓动名来自外部输入（配置表/存档）时，`Easing['toString']` 拿到的是 `Object.prototype.toString`，truthy 通过校验。
- **证据**：`verify/b2_v2.ts` §3 实测：
  ```
  Easing['toString'] = function toString() { [native code] }
  未抛错；onUpdate 收到 = "[object Object]"  类型 = string
  ```
- **后果**：配置里缓动名拼错成 `toString`/`valueOf`/`constructor` 时，动画进度变成字符串而不是数字，`onUpdate` 里做算术立刻得到 NaN——NaN 会一路污染到坐标，表现为"物体瞬间消失/卡死"，且不会有任何报错。
- **建议**：用 `Object.prototype.hasOwnProperty.call(Easing, name)` 或把 `Easing` 换成 `Map`。
- **影响面**：与已审结 `_core` 的 `easing()` 修复同源，属同类写法在本批的唯一新实例（另见 runscope P1-22）。


## 【P2】P1 完成后再做

### P2 · [autoquality] （见正文）

- **AQ4** `_history`（L83-89）只增不减且无容量上限：长时间挂机 + 频繁切换会持续增长（容量类字段未收口）。
- **AQ5** `medianFps`（L218）每次调用都 `[...].sort()`，而 `update()`（L149）与 `state` getter（L288）每帧各调一次 → 每帧 2 次 O(n log n) + 数组分配。
- **AQ6** `AutoQuality.median/average/lowFps1Percent` 与 `FpsMeter.median/average/lowFps1Percent` 是同一份逻辑的两份实现（L216-242 vs L386-411）：应合并（AutoQuality 内部持有 FpsMeter 即可）。
- **AQ7** 无 `destroy()`：`_history` 与 `_samples` 需清理。

---

### P2 · [diagpack] （见正文）

- **Di3** `safeStringify` 的 `replacer`（L84-86）是恒等函数 `(_key, v) => v`，没有任何作用（疑似占位未实现）。
- **Di4** `maxSectionChars` / `maxTotalChars` 未收口（L191-192）：传 0 会让每个分区被截成 0 字符，传负数会让所有分区被丢弃，都不报错。
- **Di5** `collectEnvironment`（L337-357）内部 `new Date()` 与 `Intl` 直连：可接受（环境采集），但与"可注入"原则不一致。
- **Di6** 无 `destroy()`：`_providers` 持有外部闭包（通常捕获组件/场景对象），卸载时不清会阻止 GC。

---

### P2 · [interact] （见正文）

- **I2** `clear()`（L116-120）与 `resetAll()`（L234-240）清空焦点但不触发 `onFocusChange`：UI 上的交互提示不会消失。
- **I3** `candidates()` 排序比较函数在"相等"时返回 1 而非 0（L196）：排序不稳定，同距离物体的顺序不确定。
- **I4** `setDisabled` 用 `(it as { disabled?: boolean }).disabled = disabled`（L109）写入 readonly 字段：对 `Object.freeze` 的对象在严格模式下会抛 TypeError。
- **I5** 本地 `clamp`（L294-296）与 `_core.clamp` 重复实现（本单元为零依赖，可接受，建议注明）。
- **I6** 无 `destroy()`（`clear()` 不够，需清 `_items` 持有的外部对象）。

---

### P2 · [logger] （见正文）

- **L2** `addSink` 取消函数同样用 `indexOf`（L91-97），与已知"旧取消函数误删新监听器"同型，且 `destroy()` 未清 `_moduleLevels`（L226-229）。
- **L3** 环形缓冲持有 `data` 引用（L108-114）：若 `data` 是 Cocos 节点/大对象，缓冲里的 200 条会让它们在销毁后仍无法释放。
- **L4** `Assert.soft()` 直接 `console.warn`（Assert.ts L75），未接入 Logger 的 sink 体系，无法重定向到上报通道（与 README §sink 机制的承诺不一致）。

---

### P2 · [loot] （见正文）

- **Lo5** `Chest._count`（L216）用 `Math.max(1, count ?? 3)`：`count` 为 NaN 时 → NaN → 抽 0 个（空宝箱，静默）。
- **Lo6** `_spawnedCount` 统计问题在 wave-spawner；此处 `Chest.destroy()`（L219-222）不释放 `_options.owned` 引用（`addOwned` 会往里 push）。
- **Lo7** `LootTable.roll` 的非保底判定（L100）是"每个条目独立掷骰"：会同时命中多条，是否与 README 的"抽一条"一致需确认。
- **Lo8** `ShuffleBag.add()`（L31）会清空 `_bag`：中途加物品会丢弃当前袋中剩余（README 未说明）。

---

### P2 · [meta] （正面样本）

- **M5** `restore()`（L367-408）是本批**做得最好**的反序列化实现：校验 `Number.isFinite`、clamp 到 `maxLevel`、把跳过/裁剪记进 `RestoreReport`。建议把它作为其他单元 `importState` 的模板。
- **M6** `respec(refundRatio)`（L279-289）未校验比例：负数会让"洗点"反而扣钱。
- **M7** `topoOrder` 用 `queue.shift()`（L467）：O(n²)，节点数多时可换索引指针。
- **M8** 无 `destroy()`。

---

### P2 · [runscope] （见正文）

- **Ru3** `importSave`（L194-211）不校验存档值（与 meta.restore 的严谨形成对比）：`src[k]` 可以是任意类型/NaN。
- **Ru4** `add(key, delta)`（L135-145）不校验 delta：NaN 直接污染。
- **Ru5** `StoreSchema = Record<string, KeyDef<any>>`（L18）含 `any`。
- **Ru6** 无 `destroy()`（有 `reset()`）。

---

### P2 · [scheduling] （见正文）

- **Sch2** `hardLimitMs` 未收口（L54）：传 0 时每帧只执行 1 个任务（L216 的 break 在任务执行之后），退化为"每帧一个"但不报错；传 NaN 时硬限制完全失效（比较恒 false），两个方向都静默。
- **Sch3** 任务抛异常被当成完成并触发 `onDone`（L199-207）：README §7 第 63 行写明"已处理：出错即完成，不重试"，与文档一致；但只有 `onDone` 没有 `onError`，调用方无法区分"做完了"和"做炸了"。建议补 `onError`（或 `onDone(ok)`）。
- **Sch4** 每个任务每帧新建 `ctx` 对象与 `hasTimeLeft` 闭包（L193-196）：热路径分配。
- **Sch5** 每次 `schedule()` 都全量排序（L84）：循环注册 N 个任务是 O(N² log N)。
- **Sch6** `flush()` 用 `this._tasks.shift()`（L171）：O(n²)。
- **Sch7** `scheduleBatch` 空数组时返回 id `0`（L97），与"有效 id 从 1 开始"冲突。

---

### P2 · [score] （见正文）

- **Sc2** `_scoreOne`（L241-245）的 `higher-better` 与 `lower-better` 两个分支代码完全相同（`clamp01(t) * 100`）：因为方向已由 `zero/par` 的大小关系决定（构造时 L91-100 有校验），分支是冗余的，建议合并并加注释说明"方向隐含在 zero/par 中"。
- **Sc3** `StarRating(stars)`（L301）用 `Math.max(1, stars)`：`stars` 为 NaN 时 → NaN → `addCondition` 的 `length >= NaN` 恒 false → 可无限加条件 → 星级可以超过 max。
- **Sc4** `weighted-with-floor` 模式（L196-203）在有指标低于 floor 时直接返回 `Math.min(avg, 最后一档 minScore)`（通常是 0）：一票否决很严厉，README 需写明。
- **Sc5** 无 `destroy()`（有 `reset()`）。

---

### P2 · [tween] （见正文）

- **T2** `TweenRunner.completeAll()`（L224-228）只 complete `_tweens`，`_pending` 里的被直接丢弃：实测刚 `add` 的 tween 的 `onComplete` **不会**被调用（"completeAll"名不副实）。
- **T3** `TweenRunner.update` 每帧 `slice()`（L200）：热路径分配。
- **T4** `TweenRunner.delay()` 用 `new Tween(0.0001)`（L189）：魔法数字，建议走可配置的最小步长。

---


---

## 4. 贯穿全库的六个共享模式

这些模式在多个单元重复出现。**按模式统一修法，不要每个单元各写一套。**

### 模式 A · 否定式条件拦不住 NaN（最高频）

```ts
// ✗ 错：NaN 参与 <= 比较恒为 false，直接穿透
if (x <= 0) return;
if (amount >= s.count) return -1;

// ✓ 对：肯定式，NaN 时条件成立 → 正确拒绝
if (!(x > 0)) return;
if (!(amount < s.count)) return -1;
```

**本批最高频的错误形态。** JS 里 NaN 与任何值比较都为 false，否定式判断天然漏掉它。

### 模式 B · `??` 和 `Math.max` 都挡不住 NaN

```ts
// ✗ 错：?? 只挡 null/undefined；Math.max(0, NaN) === NaN
this._maxRetries = opts.maxRetries ?? 3;

// ✓ 对
this._maxRetries = clampNum(opts.maxRetries, 0, 100, 3);
numOr(v, 0)
```

### 模式 C · `importState` 绕过校验与事件

多个单元的存档导入直接写内部字段，**既不做数值校验、也不触发 `onChange`**，
导致"读档后状态对了但 UI 没更新"和"坏存档能写进任何值"。
涉及 `blessing` / `curse` / `settings` / `achievement` / `quest` / `leaderboard` / `buff`。

统一修法：导入走与 `set()` 相同的校验路径，并触发一次变更通知。

### 模式 D · `set` 类效果被层数/等级错误缩放

`blessing` / `curse` / `meta` 三个单元都有：`set`（覆盖）语义的效果被乘上层数/等级，与 `add`/`mul` 混为一谈。

### 模式 E · 遍历中修改集合

```ts
// ✗ 错：回调里注销自己会 splice 数组，下一个回调被跳过
for (const fn of this._onSpawn) fn();

// ✓ 对：遍历副本
for (const fn of [...this._onSpawn]) fn();
```

### 模式 F · 缺省配置与 JSDoc 承诺相反

`mover` 的 `maxExternal = Infinity`、`replay` 的 `seed = 0`、`telemetry` 的 `maxRetries` 等——
**默认值恰好让文档承诺的功能失效**。改法二选一：改默认值，或改文档说清真实语义。
**不要只改一个又不动另一个。**

---

## 5. 交付要求

### 5.1 每条修复的产出

1. **源码改动**：只改必要的那几行，附"为什么"注释
2. **回归测试**：一条在修复前**确实会失败**的用例
3. **对照用例**：一条验证"正常输入不受影响"的用例（防止矫枉过正）

### 5.2 测试放哪

新建 `tests/run_phase10_w5.ts`，并**在文件内导出** `runPhase10W5Tests()`：

```ts
export function runPhase10W5Tests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（8 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W5.md`，每条一行：

```
| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
```

状态用：`已修` / `已修（附说明）` / `不成立（附证据）` / `需总审裁决`。

**"不成立"要有真凭实据**——贴出复现脚本和输出，说明为什么报告描述的现象不存在。
不要因为"看代码觉得没问题"就判不成立。

### 5.4 提交前自检

```bash
bash build.sh
node .build/tests/run.js                    # 必须全绿，条数只增不减
node scripts/check-deps.js                  # 全部通过（记得删 verify/）
node scripts/check-links.js
python3 scripts/scan-dt-guard.py
python3 scripts/scan-num-guard.py
python3 scripts/check-random-source.py
python3 scripts/check-dup-exports.py
```

---

## 6. 并行纪律（8 个窗口同时开工）

| 事项 | 约定 |
|---|---|
| **单元边界** | 8 个窗口**零重叠**，已核验 |
| **`_core/`** | 谁都不要碰 |
| **`tests/run.ts`** | **总审统一合并**，你不要改 |
| **`README.md`** | 测试总数在变，**不要改**，总审统一更新 |
| **临时脚本** | 放 `/tmp` 或 `verify/`（用完删） |
| **`build.sh`** | 会整体替换 `.build/`；偶发 502 导致中断时**重跑一次**即可 |
| **文件命名** | `run_phase10_w5.ts` / `result_W5.md`，带你的窗口号，避免撞名 |

---

## 7. 需要总审裁决的先记下来

遇到以下情况**不要自己拍板**，在报告里标"需总审裁决"并说明两种选择的利弊：

1. 修复会改变**对外 API 行为**（可能 breaking）
2. 报告建议的改法与单元 README 的**明确声明冲突**
3. 两处代码"看起来不一致但可能都是故意的"
   （例：相切语义——空间索引要求"不含相切"，通用 AABB 要求"含相切"，**两者都对**）
4. 你判断某条"不成立"

---

## 8. 最后一句

这个库现在 **3695 项测试全绿**，是你开工前的基线。
你交付时这个数字只能涨、不能跌——如果跌了，说明你的修复伤到了既有行为，
回去看第 1.1 节第 1 条。
