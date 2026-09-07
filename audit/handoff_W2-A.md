# 精审返工任务书 · 窗口 W2-A（第 A 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W2-A 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **19**（P1 14 / P2 5） |
| 单元 | **10** 个 |
| 来源批次 | batch2、batch4 |
| 所属组 | **第 A 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W2-B**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_A.md` 验收 **W2-B**。

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

**`_core/` 不在任何窗口的清单里，严禁修改。** 它被 55 个单元依赖，你改一行会影响另外 15 个窗口。

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

### 3.1 你的单元（10 个，与其它 15 个窗口零重叠）

```
attribute  command  diagpack  indicator  logger  pathfinding  runscope  scheduling  skill-caster  social
```

---


## 【P1】先做这批

### P1 · [attribute] `clearModifiers()` 不触发 `onChange`，UI 在"移除 buff"时不刷新

- **位置**：`attribute/AttributeSet.ts:188-202`（两条路径都只 `_bump()`，没有 `_notifyIf`；对比 `removeWhere` 在 179-183 行正确调用了 `_notifyIf`）
- **证据**：实测（`b4_v1.ts`）：注册 onChange 计数 → `add()` → 计数 1 → `clearModifiers('atk')` → 计数仍为 **1** → `clearModifiers()` → 计数仍为 **1**。
- **后果**：`removeBySource` / `clearByTag` 走 `removeWhere`，有通知；而 `clearModifiers` 没有。同一语义的两个 API 行为不一致，调用方用 `clearModifiers` 清 debuff 时，血条/面板停在旧数值上，直到下一次别的操作才刷新。这正是 C 类"契约不一致"。
- **建议**：`clearModifiers(attr)` 分支补 `this._notifyIf(attr, old)`；无参分支对所有受影响属性逐个通知（注意兼容 `suspendNotify`）。

### P1 · [attribute] `override` 与 `add` 的叠加顺序写成了"三元左右相等"的死代码

- **位置**：`attribute/AttributeSet.ts:269`（`v = overridden ? v + add : v + add;`）
- **证据**：代码直读 + 实测：base=10、override=100、add=50 → `get('atk') === 150`（override 之后仍叠加 add）。三元两个分支完全相同，说明作者在这里犹豫过但没做区分，留下误导性代码。
- **后果**：维护者读到这行会以为存在"override 时是否忽略 add"的分支逻辑（多数属性系统的惯例是 override 定终值），实际没有。后续若要改语义，这行是必错点。
- **建议**：二选一后写清楚：若要"override 定终值"改为 `v = overridden ? v : v + add;`；若要"override 后仍叠加 add"直接写 `v = v + add;` 并在 README 明确。（语义本身见「存疑-1」）

### P1 · [command] `rollback()` 里的空 catch 吞掉 undo 异常

- **位置**：`command/CommandStack.ts:206-212`（`try { buffer[i].undo(); } catch { }`）
- **证据**：代码直读（扫描命中「空 catch ×1」）。
- **后果**：回滚失败（例如 undo 依赖的资源已释放）时完全无声，事务回滚后状态可能仍是错的，但调用方拿到的是"回滚成功"的返回。这正是 A 类清单里的"空 catch / 静默降级"。
- **建议**：至少 `console.error`，或收集到 `rollback(): { rolledBack: number; errors: Error[] }` 的返回里。

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

### P1 · [indicator] `compute()` 返回的中心与 `centerFor()` 返回的中心不一致（同一套配置两个答案）

- **位置**：`indicator/SkillIndicator.ts:168-184`（`aimed` 分支：中心 = 施法者 + 位移向量，即**瞄准点/射程末端**）+ `272-285`（`centerFor`：中心 = 施法者 + `length/2` 方向偏移，即**线段中点**）
- **证据**：实测（`b4_v2.ts`）：`{kind:'line', length:6, width:1, range:10, aimed:true}`，面向 0°、瞄准 (6,0)：
  - `compute(0,0,0, 6,0).x === 6`（射程末端）
  - `centerFor(0,0,0) === {x:3, y:0}`（半长处）
- **后果**：对 `line`/`direction` 这类"从施法者延伸出去"的形状，两个 API 给出的中心差了整整 `length/2`。调用方若用 `centerFor` 画指示器、用 `compute` 做判定（或反之），**画的圈和实际打到的位置完全错开**。README 没有说明二者语义差异，是典型的"同义不同值"。
- **建议**：统一为同一语义（建议都以"形状几何中心"为准），并让 `compute` 内部调用 `centerFor`；`aimX/aimY` 字段保留瞄准点语义即可。

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

### P1 · [pathfinding] `findPath` 只校验终点可走，不校验**起点**可走，起点在墙里照样返回路径

- **位置**：`pathfinding/GridGraph.ts:161-172`（`if (!grid.isWalkable(goal.x, goal.y)) return null;` 之后对 start 没有任何检查）
- **证据**：实测（`b4_v2.ts`）：5×5 网格，把 (0,0) 设为不可走，`findPath(g, {x:0,y:0}, {x:4,y:4})` → 返回 **长度 5 的完整路径**（起点是墙）。
- **后果**：单位被推挤进墙里、或地形动态变化把脚下变成障碍时，寻路依然"成功"并给出一条从墙内出发的路径，单位沿路径移动会穿墙。调用方通常以"返回非 null"作为"可达"的依据，于是永远不触发兜底逻辑。
- **建议**：补 `if (!grid.isWalkable(sx, sy)) return null;`（与终点对称）；若需要"起点在墙里时找最近合法格"的容错，应作为独立选项。

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

### P1 · [skill-caster] `resetCooldown()` 把充能数留在旧值，导致 `chargesLeft` 变负、技能可用性错乱

- **位置**：`skill-caster/SkillCaster.ts:290-297`（只把 `_cd` 置 0，**不动 `_charges`**）+ `344-346`（`const left = (this._charges.get(id) ?? 1) - 1;`）
- **证据**：实测（`b4_v2.ts`）：`charges: 2` → 施放 2 次（各 cancel 一次）→ `chargesLeft === 0` → `resetCooldown('s')` → `chargesLeft` 仍为 **0**（期望回到 2）→ 再施放一次 → `chargesLeft === -1`。
- **后果**：`chargesLeft` 变负后 `left <= 0` 恒真 → 每次施放都重置冷却为完整 CD，但充能数继续下降，同时 `_cd` 的恢复逻辑（458-463 行 `if (cur < max)`）会把负数一路加回来 —— 技能可用性完全错乱。GM 命令"重置冷却"在带充能的技能上必然踩到。
- **建议**：`resetCooldown(id)` 同时把 `_charges` 重置为 `def.charges ?? 1`；并在 `tryCast` 里对 `left` 做 `Math.max(0, ...)` 兜底。

### P1 · [social] `statsOf().byReason` 是残缺对象，未出现的 reason 读到 `undefined`，参与运算得 NaN

- **位置**：`social/Report.ts:185-188`（`const byReason = {} as Record<ReportReason, number>;` 用 `as` 断言绕过类型系统，然后只填充出现过的 key）
- **证据**：实测（`b4_v1.ts`）：只有一条 `cheating` 举报时，`byReason` = `{"cheating":1}`，`byReason['afk']` = **`undefined`**，`byReason['afk'] + 1` = **NaN**。
- **后果**：类型签名承诺 `Record<ReportReason, number>`（每个 reason 都有数字），实际是 `Partial`。调用方按签名直接做加法/比较，得到 NaN 或错误排序，且 TS 编译期**不会报错**（`as` 断言骗过了检查）。这是 C 类"契约说谎"里最典型的一种。
- **建议**：初始化时把所有 `ReportReason` 都填 0，或把返回类型改为 `Partial<Record<ReportReason, number>>`。

### P1 · [social] `abuseThreshold` 等阈值配置未收口，NaN 让"恶意举报识别"永久失效

- **位置**：`social/Report.ts:101-109`（只有 `maxTickets` 用了 `clampNum`，其余 6 个配置全是裸 `??`）
- **证据**：实测：`new ReportCenter({abuseThreshold: NaN}).isAbusiveReporter('x')` → **false**（`rejectedCount(0) >= NaN` 恒为 false）。同理 `actionThreshold: NaN` 会让 `needsAction` 恒 false。
- **后果**：配置里阈值缺失/非法 → 恶意举报识别、自动处罚全部静默关闭，运营侧看到"系统从不自动处理"，而配置看起来是填了的。
- **建议**：7 个阈值统一收口（`maxTickets` 是容量类，已正确用 `clampNum`；其余是普通配置，用 `numOr` 即可）。

---


## 【P2】P1 完成后再做

### P2 · [diagpack] （见正文）

- **Di3** `safeStringify` 的 `replacer`（L84-86）是恒等函数 `(_key, v) => v`，没有任何作用（疑似占位未实现）。
- **Di4** `maxSectionChars` / `maxTotalChars` 未收口（L191-192）：传 0 会让每个分区被截成 0 字符，传负数会让所有分区被丢弃，都不报错。
- **Di5** `collectEnvironment`（L337-357）内部 `new Date()` 与 `Intl` 直连：可接受（环境采集），但与"可注入"原则不一致。
- **Di6** 无 `destroy()`：`_providers` 持有外部闭包（通常捕获组件/场景对象），卸载时不清会阻止 GC。

---

### P2 · [indicator] `ring` 类型的 `innerRadius` 在 `_buildShape()` 里被丢弃

- **位置**：`indicator/SkillIndicator.ts:233-237`（`case 'ring'` 直接返回 `{kind:'circle', radius: cfg.radius ?? 1}`）
- **证据**：实测：`{kind:'ring', radius:5, innerRadius:4}` → `compute(...).shape === {kind:'circle', radius:5}`。README 第 46-53 行已说明"ring 需要调用方用 `inRing()` 二次过滤"，**文档是对的**，但 API 层收下 `innerRadius` 却不用，容易误用。
- **后果**：直接把 `toQueryArgs(result)` 丢给 `HitboxWorld.query` 会得到**实心圆**判定，环形技能打中心的人。
- **建议**：在 `compute` 结果里带上 `innerRadius` 供调用方使用（当前 `IndicatorResult` 没有这个字段），或在 README 顶部加醒目警告。

---

### P2 · [logger] （见正文）

- **L2** `addSink` 取消函数同样用 `indexOf`（L91-97），与已知"旧取消函数误删新监听器"同型，且 `destroy()` 未清 `_moduleLevels`（L226-229）。
- **L3** 环形缓冲持有 `data` 引用（L108-114）：若 `data` 是 Cocos 节点/大对象，缓冲里的 200 条会让它们在销毁后仍无法释放。
- **L4** `Assert.soft()` 直接 `console.warn`（Assert.ts L75），未接入 Logger 的 sink 体系，无法重定向到上报通道（与 README §sink 机制的承诺不一致）。

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

新建 `tests/run_phase10_w2a.ts`，并**在文件内导出** `runPhase10W2ATests()`：

```ts
export function runPhase10W2ATests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W2-A.md`，每条一行：

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

## 6. 并行纪律（16 个窗口同时开工）

| 事项 | 约定 |
|---|---|
| **单元边界** | 16 个窗口**两两零重叠**，已程序化核验 |
| **分组** | 第 A 组 = `W*-A`，第 B 组 = `W*-B`。组间单元也零重叠（互补分工） |
| **`_core/`** | 谁都不要碰 |
| **`tests/run.ts`** | **总审统一合并**，你不要改 |
| **`README.md`** | 测试总数在变，**不要改**，总审统一更新 |
| **临时脚本** | 放 `/tmp` 或 `verify/`（用完删） |
| **`build.sh`** | 会整体替换 `.build/`；偶发 502 导致中断时**重跑一次**即可 |
| **文件命名** | `run_phase10_w2a.ts` / `result_W2-A.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 A 组**。修完之后，按 `audit/review_A.md` 验收 **W2-B**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W2-A.md`，
回报给对方窗口或总审。

---

## 8. 需要总审裁决的先记下来

遇到以下情况**不要自己拍板**，在报告里标"需总审裁决"并说明两种选择的利弊：

1. 修复会改变**对外 API 行为**（可能 breaking）
2. 报告建议的改法与单元 README 的**明确声明冲突**
3. 两处代码"看起来不一致但可能都是故意的"
   （例：相切语义——空间索引要求"不含相切"，通用 AABB 要求"含相切"，**两者都对**）
4. 你判断某条"不成立"

---

## 9. 最后一句

这个库现在 **3695 项测试全绿**，是你开工前的基线。
你交付时这个数字只能涨、不能跌——如果跌了，说明你的修复伤到了既有行为，
回去看第 1.1 节第 1 条。
