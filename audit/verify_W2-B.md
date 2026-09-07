# 验收报告 · W2-B 验收 W2-A

> 验收对象：`W2-A`（19 条：P1 14 / P2 5，单元 `attribute` `command` `diagpack` `indicator`
> `logger` `pathfinding` `runscope` `scheduling` `skill-caster` `social`）
> 依据：`audit/review_B.md`
> 验收人：窗口 W2-B
> 核实基准：远程 `main`（含 W1-B / W2-B / W3-A / W3-B / W4-A / W4-B / W5-B / W7-B / W8-B 的最新改动）

---

## 结论

**无法给出验收结论 —— 对方尚未交付。**

| 交付物 | 状态 |
|---|---|
| `audit/result_W2-A.md` | **不存在** |
| `tests/run_phase10_w2a.ts` | **不存在** |

`review_B.md` 的五条硬标准全都建立在"读到对方的报告与测试代码"之上：
标准 1 要看对方的复现输出、标准 2 要读测试断言、标准 3 找对照用例、
标准 4 比对改动范围、标准 5 看对方有没有推翻原注释的论证。
**没有交付物，五条都无从判定**，因此不填"通过/不通过"。

> 参照 `verify_W1-B.md` 的口径：这不是"验收不通过"，是**没有可验收的对象**。

### 已确认：W2-A 一行代码都还没开始改

我用文件 SHA 逐一比对了 W2-A 的 10 个单元在远程 `main` 上与我的开工基线
（`70b6134`）的内容，**全部一致**：

```
attribute/AttributeSet.ts     OK
command/CommandStack.ts       OK
diagpack/DiagPack.ts          OK
indicator/SkillIndicator.ts   OK
logger/Logger.ts              OK
logger/Assert.ts              OK
pathfinding/GridGraph.ts      OK
runscope/ScopedStore.ts       OK
scheduling/FrameScheduler.ts  OK
skill-caster/SkillCaster.ts   OK
social/Report.ts              OK
```

即 W2-A 尚未开始改动，下文的复现结果对当前远程代码**全部有效**。

---

## 已做的核查（不等同于验收）

在"对方未交付"的前提下，我对 **W2-A 清单的全部条目逐条写了复现脚本**
（只读、只调公开 API，**没有改动 W2-A 的任何一行代码** —— `review_B.md` 明确禁止验收方改对方代码）。

覆盖度：**P1 14 条 + P2 5 条（含 17 个子项）= 31 项检查**，与 `verify_W1-B.md` 的全量口径一致。

### 结果总览

| 范围 | 检查项 | ⚠ 仍在 | ✓ 已不成立 / 已处理 | ? 无法判定 |
|---|---|---|---|---|
| P1 | 14 | **12** | 2 | 0 |
| P2（子项） | 17 | **17** | 0 | 0 |
| 合计 | **31** | **29** | 2 | 0 |

---

## P1 逐条（14 条）

| # | 单元 | 条目 | 判定 | 实测输出 / 依据 |
|---|---|---|---|---|
| 1 | attribute | `clearModifiers()` 不触发 `onChange` | ⚠ 仍在 | `add` 后 1 次 → `clearModifiers('atk')` 后**仍 1 次** |
| 2 | attribute | `override` 三元两分支相同（死代码） | ⚠ 仍在 | 源码仍是 `overridden ? v + add : v + add` |
| 3 | command | `rollback()` 空 catch 吞 undo 异常 | ✓ 已不成立 | 源码已无空 `catch {}` |
| 4 | diagpack | `safeStringify` 共享引用误判循环 | ⚠ 仍在 | `{"a":{"hp":100},"b":"[Circular]"}` |
| 5 | diagpack | 脱敏把 JSON 结构改坏 | ⚠ 仍在 | 结果 `{"password": "[REDACTED]"},"nested":1}` — 多一个 `}`，`JSON.parse` 失败 |
| 6 | indicator | `compute()` 与 `centerFor()` 中心不一致 | ⚠ 仍在 | `compute.x=6` vs `centerFor.x=3`，差整整 `length/2=3` |
| 7 | logger | Silent 判断无 `return`，仍在写缓冲 | ⚠ 仍在 | Silent 分支**无 `return`**；200 条后内部状态 12614B |
| 8 | pathfinding | `findPath` 不校验起点可走 | ⚠ 仍在 | 起点 (0,0) 设为不可走，仍返回 **5 步路径** |
| 9 | runscope | 原型链键 `has()` 返回 true 而 `get` 崩 | ✓ 已不成立 | `has('toString')` 现返回 `false`（`get` 抛错是"未声明键"的默认行为，二者一致） |
| 10 | runscope | `getOr` 吞掉 strict 越界保护 | ⚠ 仍在 | `get` 抛 = true（期望），`getOr` 抛 = **false** |
| 11 | scheduling | `StepContext.elapsed` 恒为 0 | ⚠ 仍在 | 任务内 `ctx.elapsed = 0` |
| 12 | skill-caster | `resetCooldown()` 不恢复充能 | ⚠ 仍在 | 函数体**完全不触碰** `_charges`（只置 `_cd=0`） |
| 13 | social | `statsOf().byReason` 残缺 | ⚠ 仍在 | `byReason={"cheating":1}`，`byReason['afk']=undefined` → `+1` 得 NaN |
| 14 | social | `abuseThreshold` 未收口 | ⚠ 仍在 | `abuseThreshold: NaN` 时 `isAbusiveReporter('x')` = **false** |

### 两条要单独说

**#7 logger：注释与实现相反，属于任务书 §1.2 点名的那类。**
`log()` 里那段现在长这样：

```ts
// 静默级别：连缓冲都不写
if (this._level === LogLevel.Silent && !this._moduleLevels.has(module)) {
  // 仍写入缓冲（便于事后分析），但不输出
}
```

注释写"连缓冲都不写"，块里**没有 `return`**，实际照样写缓冲。
这正是任务书 §1.2 警告的形态——"注释主动论证这是设计如此，要格外警惕，而不是格外放心"。
**请 W2-A 修复时一并把注释改对**，否则下一个人看到注释会以为行为是对的。

> 检测方法提醒：这条不能用"空 if 块"正则去扫（块里有注释，匹配不到）。
> 我第一次就是这么判的，得出了错误的"已修"。必须判"分支内有没有 `return`"。

**#9 runscope 的 `getOr`：标准 5 的高风险条目。**
`getOr` 用 try/catch 究竟是"吞掉保护"还是"刻意降级"，取决于 strict 模式的定义。
我实测 `get` 抛而 `getOr` 不抛，说明**当前实现确实绕过了 strict**。
但 W2-A 若要改，建议先读该文件注释确认 strict 的契约边界再动手——
这条最容易改过头（把"键不存在"也一起抛出去，会让正常调用方全线崩溃）。

---

## P2 逐条（5 条 / 17 个子项）

| # | 单元 | 条目 | 判定 | 实测输出 / 依据 |
|---|---|---|---|---|
| Di3 | diagpack | `safeStringify` 的 replacer 是恒等函数 | ⚠ 仍在 | 源码 `const replacer = (_key, v) => { return v; }` |
| Di4 | diagpack | `maxSectionChars` / `maxTotalChars` 未收口 | ⚠ 仍在 | `maxSectionChars: 0` → 分区被截成 **12 字符** `…[truncated]`，不报错 |
| Di5 | diagpack | `collectEnvironment` 直连 `new Date` / `Intl` | ⚠ 仍在（**可接受**） | 内部直接调用；任务书自己注明"环境采集，可接受"，仅与"可注入"原则不一致 |
| Di6 | diagpack | 无 `destroy()` | ⚠ 仍在 | `_providers` 持有外部闭包，卸载时不清会阻止 GC |
| — | indicator | `ring` 的 `innerRadius` 在结果里被丢弃 | ⚠ 仍在 | `compute().shape = {"kind":"circle","radius":5}`，结果**不带** `innerRadius` |
| L2 | logger | `addSink` 旧取消函数误删新监听器 | ⚠ 仍在 | 再调一次旧取消函数后，sinks 长度 = **0**（期望 1） |
| L3 | logger | 环形缓冲持有 `data` 引用 | ⚠ 仍在 | `export()` 返回的条目仍持有原对象引用 |
| L4 | logger | `Assert.soft()` 未接入 sink 体系 | ⚠ 仍在 | `soft()` 直接 `console.warn`，无法重定向到上报通道 |
| Ru3 | runscope | `importSave` 不校验存档值 | ⚠ 仍在 | 导入 `gold: NaN` 后 `get('gold')` = **NaN** |
| Ru4 | runscope | `add(key, delta)` 不校验 delta | ⚠ 仍在 | `add('gold', NaN)` 后值 = **NaN**（未收口） |
| Ru5 | runscope | `StoreSchema` 含 `any` | ⚠ 仍在（**类型层，低优先**） | `Record<string, KeyDef<any>>` |
| Ru6 | runscope | 无 `destroy()` | ⚠ 仍在 | 只有 `reset()` |
| Sch2 | scheduling | `hardLimitMs` 未收口 | ⚠ 仍在 | `hardLimitMs: 0` → 注册 5 个任务，一次 `update` 只执行 **1 个** |
| Sch3 | scheduling | 任务抛异常被当完成、无 `onError` | ⚠ 仍在 | 任务抛错：不向外抛，**`onDone` 触发 1 次**（无法区分"做完了"和"做炸了"） |
| Sch4 | scheduling | 每帧新建 `ctx` 与 `hasTimeLeft` 闭包 | ⚠ 仍在 | 热路径分配（源码检视） |
| Sch5 | scheduling | `schedule()` 每次全量排序 | ⚠ 仍在 | `schedule()` 内调用 `_sort()`；循环注册 N 个 = O(N² log N) |
| Sch6 | scheduling | `flush()` 用 `_tasks.shift()` | ⚠ 仍在 | `flush()` 内 `this._tasks.shift()`（O(n²)） |
| Sch7 | scheduling | `scheduleBatch([])` 返回 id `0` | ⚠ 仍在 | 返回 **0**，与"有效 id 从 1 开始"冲突 |

> ⚠️ **复现方法上的教训（供其它窗口参考）**：Sch5 / Sch6 / Di3 我第一次判成了"已优化"，
> 是**假阴性**——源码切片窗口太窄（900/700 字符）没覆盖到真正的调用点，
> Di3 的正则又只匹配了 `=> v` 而漏掉 `=> { return v; }`。
> 放宽窗口与修正正则后三条全部翻转为"仍在"。
> **凡是"源码检视"得出的"已修"结论，都应回看一眼再下笔。**

---

## 给 W2-A 与总审的提醒（按 review_B.md 的五条标准）

等对方交付后，建议重点看这几点——它们是我这次在自己窗口（W2-B）里踩到、
且与 W2-A 清单高度相关的坑：

1. **标准 2（测试要真的会失败）**：W2-A 清单里有 6 条是"配置未收口"
   （`social` 的 `abuseThreshold`、`skill-caster` 的充能、`indicator` 的中心口径等）。
   这类用例最容易写成 `assert(Number.isFinite(compute(5)))`
   ——**喂的是永远不会触发 bug 的输入**，用例等于没写。
   必须喂 `NaN` / `Infinity` / `0` / 负数。

2. **标准 3（对照用例）**：收口类修复最典型的翻车是**收过头**。
   我自己在 `maxDeltaTime` 上就先踩了一次——最初按"夹到下界"修，
   `-1` 变成 `1e-6`，游戏照样停摆，"定时器不工作"的故障现象一点没变。
   后来改成"非正就整体回落默认 0.1"，并补了对照用例才站稳。

3. **标准 4（顺手重构）**：`attribute` 的 `override` 死代码（#2）很容易被顺手"优化"
   ——但那是**语义未定的地方**（override 定终值 vs 仍叠加 add），
   只能二选一后写清楚，**不能当成"看起来没用"删掉**。任务书里也标了「存疑-1」。

4. **标准 5（别把设计判成 bug）**：`diagpack` 的 `redact` 对 JSON 字符串做正则，
   是"为了守住永不抛错的承诺"——改的时候别把这份承诺丢了。
   `runscope` 的 `getOr` 同理（见上）。

---

## 附：本次验收时的全库校验结果

在远程 `main` 干净快照上重跑：

```
$ bash build.sh
TSC OK（产物校验通过：221 个 .js）

$ node .build/tests/run.js
通过 3696 项，失败 0 项
全部通过 ✓

$ node -e "...runPhase10W2BTests()"     # 本窗口 80 项独立运行
通过 80 项，失败 0 项
全部通过 ✓

$ node scripts/check-links.js
[OK] 内部链接 42 条，断链 0 处（扫描 178 个 .md 文件）   ← W3-B 已修好行内代码误判

$ python3 scripts/scan-dt-guard.py         扫描 146 个文件，命中 0 处 ✓
$ python3 scripts/scan-num-guard.py        扫描 0 处命中 ✓
$ python3 scripts/check-random-source.py   [OK] 未发现自建随机源 ✓
$ python3 scripts/check-dup-exports.py     [OK] 无待处理的冲突 ✓

$ node scripts/check-deps.js
[✗] import 了但没登记 6 条：i18n / curse / rarity / rebind / gameflow / accessibility → _core
```

### ⚠️ 一个并发推送导致的回归（已由我重新修回）

上面 6 条里的 **`curse` 是我这边的**：我原本已在提交 `eb94add0` 里登记过
`curse.depends = ["_core"]`，但后续 W5-B（`9e1661f7`）、W7-B（`edc04835`）
各自基于**自己的旧基底**推送了 `_kitmeta.json`，把我的登记覆盖回了 `[]`。

我已基于当前远程版本重新登记（只改 `curse` 一条，其余 5 条保持原样不动，
避免跨窗口代改）。

**请总审注意**：`_kitmeta.json` 是多个窗口的高频冲突点，
这种"后推的覆盖先推的"会反复发生。**建议在所有窗口收工后统一执行一次
`node scripts/check-deps.js --fix`**，而不是要求每个窗口各自保证——
各自保证在并发推送下是做不到的。
