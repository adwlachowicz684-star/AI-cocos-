# 验收报告 · W2-B 验收 W2-A

> 验收对象：`W2-A`（19 条：P1 14 / P2 5，单元 `attribute` `command` `diagpack` `indicator`
> `logger` `pathfinding` `runscope` `scheduling` `skill-caster` `social`）
> 依据：`audit/review_B.md`
> 验收人：窗口 W2-B
> 核实基准：远程 `main`（提交 `fdd2c8c7`，含 W1-B / W3-A / W3-B / W4-A / W4-B / W7-B 的最新改动）

---

## 结论

**无法验收 —— 对方尚未交付。**

按 `review_B.md` 第 1 节，W2-A 应产出两份交付物：

| 交付物 | 状态 |
|---|---|
| `audit/result_W2-A.md` | **不存在** |
| `tests/run_phase10_w2a.ts` | **不存在** |

五条硬标准（是否复现过 / 测试是否有效 / 有无对照用例 / 有无顺手重构 / 有无误判设计）
**全部需要读到对方的报告与测试代码才能判断**，因此无法给出逐条结论。

### 进度背景（修正我上一版报告的错误）

我上一版报告写"全库只有 W7-A 一个 A 组窗口已交付"——**这句是错的**，
因为当时我核的是自己开工时拉的旧快照（`70b6134`），而期间别人一直在推。
在远程 `main` 上重新核实，A 组实际进度是：

| 窗口 | `result` 报告 | `tests/run_phase10_*.ts` |
|---|---|---|
| W1-A | ✗ | ✗ |
| **W2-A（我的验收对象）** | **✗** | **✗** |
| W3-A | ✓ | ✓ |
| W4-A | ✓ | ✓ |
| W5-A | ✗ | ✗ |
| W6-A | ✗ | ✗ |
| W7-A | ✓ | ✗ |
| W8-A | ✗ | ✗ |

也就是说：**同组其它 A 窗口已有交付，唯独 W2-A 没有**。这一点请总审留意。

---

## 已做的核查（不等同于验收）

在"对方未交付"的前提下，我做了件仍有价值的事：**在最新远程代码上，
对 W2-A 清单的 14 条 P1 逐条写复现脚本**（只读、只调公开 API，
**没有改动 W2-A 的任何一行代码** —— `review_B.md` 明确禁止验收方改对方代码）。

### 结果：14 条 P1 中，**12 条现象在当前代码里仍然可复现**

| # | 单元 | 条目 | 是否仍存在 | 实测输出 |
|---|---|---|---|---|
| 1 | attribute | `clearModifiers()` 不触发 `onChange` | **⚠ 仍存在** | `add` 后计数 1 → `clearModifiers('atk')` 后**仍 1** |
| 2 | attribute | `override` 三元两分支相同（死代码） | **⚠ 仍存在** | 源码仍是 `v = overridden ? v + add : v + add` |
| 3 | command | `rollback()` 空 catch 吞 undo 异常 | ✓ 已不存在 | 源码已无空 `catch {}` |
| 4 | diagpack | `safeStringify` 共享引用误判循环 | **⚠ 仍存在** | `{"a":{"hp":100},"b":"[Circular]"}` |
| 5 | diagpack | 脱敏把 JSON 结构改坏 | **⚠ 仍存在** | 结果 `{"password": "[REDACTED]"},"nested":1}` — 多一个 `}`，`JSON.parse` 失败 |
| 6 | indicator | `compute()` 与 `centerFor()` 中心不一致 | **⚠ 仍存在** | `compute.x=6`、`centerFor.x=3`，差整整 `length/2=3` |
| 7 | logger | Silent 判断是空 if 块，仍在写缓冲 | **⚠ 仍存在** | Silent 分支**无 `return`**；200 条后内部状态 12614B |
| 8 | pathfinding | `findPath` 不校验起点可走 | **⚠ 仍存在** | 起点 (0,0) 设为不可走，仍返回 **5 步路径** |
| 9 | runscope | 原型链键 `has()` 返回 true | ✓ 已不存在 | `has('toString')` 现返回 `false`（`get` 抛错是"未声明键"的默认行为，一致） |
| 10 | runscope | `getOr` 吞掉 strict 越界保护 | **⚠ 仍存在** | `get` 抛 = true（期望），`getOr` 抛 = **false** |
| 11 | scheduling | `StepContext.elapsed` 恒为 0 | **⚠ 仍存在** | 任务内 `ctx.elapsed = 0` |
| 12 | skill-caster | `resetCooldown()` 不恢复充能 | **⚠ 仍存在** | 函数体**完全不触碰** `_charges`（只置 `_cd=0`） |
| 13 | social | `statsOf().byReason` 残缺 | **⚠ 仍存在** | `byReason={"cheating":1}`，`byReason['afk']=undefined` → `+1` 得 NaN |
| 14 | social | `abuseThreshold` 未收口 | **⚠ 仍存在** | `new ReportCenter({abuseThreshold:NaN}).isAbusiveReporter('x')` = **false** |

复现脚本要点（便于总审自行复核，脚本未入库以免触发 `check-deps.js` 的目录登记检查）：

```js
// 例：diagpack 共享引用
safeStringify({ a: shared, b: shared })   // → {"a":{"hp":100},"b":"[Circular]"}
// 例：pathfinding 起点
const g = new GridGraph(5,5); g.setWalkable(0,0,false);
findPath(g, {x:0,y:0}, {x:4,y:4})         // → 5 步路径（起点是墙）
// 例：social 阈值
new ReportCenter({ abuseThreshold: NaN }).isAbusiveReporter('x')   // → false
```

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

**#9 runscope 的 `getOr`：标准 5 的高风险条目。**
`getOr` 用 try/catch 究竟是"吞掉保护"还是"刻意降级"，取决于 strict 模式的定义。
我实测 `get` 抛而 `getOr` 不抛，说明**当前实现确实绕过了 strict**。
但 W2-A 若要改，建议先读该文件注释确认 strict 的契约边界再动手——
这条最容易改过头（把"键不存在"也一起抛出去，会让正常调用方全线崩溃）。

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

3. **标准 4（顺手重构）**：`attribute` 的 `override` 死代码（#2）很 tempted 顺手"优化"
   ——但那是**语义未定的地方**（override 定终值 vs 仍叠加 add），
   只能二选一后写清楚，**不能当成"看起来没用"删掉**。任务书里也标了「存疑-1」。

4. **标准 5（别把设计判成 bug）**：`diagpack` 的 `redact` 对 JSON 字符串做正则，
   是"为了守住永不抛错的承诺"——改的时候别把这份承诺丢了。

---

## 附：本次验收时的全库校验结果

在远程 `main`（含 W2-B 改动）干净快照上重跑：

```
$ bash build.sh
TSC OK（产物校验通过：218 个 .js）

$ node .build/tests/run.js
通过 3696 项，失败 0 项
全部通过 ✓

$ python3 scripts/scan-dt-guard.py        扫描 146 个文件，命中 0 处 ✓
$ python3 scripts/scan-num-guard.py       扫描 0 处命中 ✓
$ python3 scripts/check-random-source.py  [OK] 未发现自建随机源 ✓
$ python3 scripts/check-dup-exports.py    [OK] 无待处理的冲突 ✓

$ node scripts/check-links.js
[✗] 断链 1 处：audit/handoff_W3-B.md（非 W2-A 文件，见 result_W2-B.md §4.3）

$ node scripts/check-deps.js
[✗] import 了但没登记 3 条：i18n / achievement / gameflow → _core
```

最后这 3 条 deps 告警**不是 W2-A 引入的**（也与我无关）。我按提交记录归因如下，
供总审派活：

| 单元 | 由哪次提交引入 | 归属 |
|---|---|---|
| `gameflow` | `9b7225bc` "fix(W4-A): 第二次精审返工" | **W4-A** |
| `achievement` | `85a367d9` "W7-B：achievement / curve / expression" | **W7-B** |
| `i18n` | 未定位到具体提交（该单元在远程无独立改动记录） | 待查 |

按 `review_B.md`「验收方不直接改对方代码」，我没有 `--fix`。
