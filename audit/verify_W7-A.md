# 交叉验收报告 · W7-A 验收 W7-B

> 验收对象：`audit/handoff_W7-B.md`（12 条：P1 10 / P2 2；单元 `achievement` `curve` `expression`）
> 验收标准：`audit/review_A.md` 第 2 节五条硬标准

---

## 0. 结论先说

**W7-B 尚未交付**：仓库里既没有 `audit/result_W7-B.md`，也没有 `tests/run_phase10_w7b.ts`。
所以标准 1~4（复现、用例有效性、对照用例、改动范围）**目前无从验收**——没有对象可验。

为了不让这条结论停在"查无此人"，我按 `review_A.md` 的要求做了**独立只读复现**：
用公开 API 跑了一遍 W7-B 清单里的 12 条，确认**这些缺陷在当前代码上确实存在**。
下面第 2 节是实跑输出，可直接作为对方窗口的复现素材，也可用于日后复核"修没修干净"。

⚠️ 我没有改 `achievement/` `curve/` `expression/` 下任何一行代码（验收方不直接改对方代码）。

---

## 1. 五条硬标准

| 标准 | 判断 | 依据 |
|---|---|---|
| 1 · 是否真的复现过 | **暂不适用** | 无 `result_W7-B.md` 可查；下方第 2 节是我自己的实跑输出 |
| 2 · 测试是否真的会失败 | **暂不适用** | 无 `tests/run_phase10_w7b.ts` 可查 |
| 3 · 有无对照用例 | **暂不适用** | 同上 |
| 4 · 有无顺手重构 | **暂不适用** | 无改动可比对 |
| 5 · 有无把"设计如此"误判成 bug | 见第 3 节 | 其中 1 条我判断需要总审裁决 |

---

## 2. 独立复现（只读脚本，跑公开 API）

脚本位置：运行时生成在 `/tmp/verify_w7b.js`（未放进仓库，避免 `check-deps.js` 报未登记目录）。

### achievement

| 清单条目 | 实跑输出 | 与清单描述是否一致 |
|---|---|---|
| `importState()` 是追加而非替换 | 连续 `importState(['x'])` → `(['x','y'])` → `(['y'])` 后 `unlockedCount=2`；再 `importState([])` 后**仍是 2**（期望 0） | ✅ 一致（空存档清不掉 = 追加语义） |
| `revoke()` 后 `_lastProgress` 未清 | `check({n:2})` 触发一次 `progress/2` 后 `revoke('k')`，再 `check({n:2})` → **回调 0 次**（永久丢失一次） | ✅ 一致 |
| `target` 非有限 / 零目标 | `target=NaN` → `progressOf` 返回 `{current:null, target:null, done:false}`（NaN 被 JSON 序列化成 null）、**未解锁**；`target=0` → **瞬间解锁**；`progress=NaN` → 未解锁 | ✅ 一致（零目标瞬间达成已确认） |
| `unlock()` 不校验 `requires` | 前置 `a` 未解锁时 `unlock('b')` 返回 **true**，`isUnlocked('b')=true` | ✅ 一致（可绕过前置链） |

> 补充观察：`target=NaN` 这一条的**表现与清单措辞略有出入**——清单写"进度变 NaN"，
> 我实测 `done` 恒为 false（不会解锁），真正会"瞬间达成"的是 `target=0`。
> 两者都是缺陷，但修法不同（NaN 是收口，0 是语义），请对方窗口分别处理，别合并成一条修。

### curve

| 清单条目 | 实跑输出 | 与清单描述是否一致 |
|---|---|---|
| `evaluate(NaN)` 返回 NaN | `evaluate(NaN)=NaN`（对照 `evaluate(0.5)=5`） | ✅ 一致 |
| 空曲线 `minValue` / `maxValue` | 空曲线 `minValue=Infinity`、`maxValue=-Infinity` | ✅ 一致 |
| `integrate(0)` / `integrate(Infinity)` | `integrate(0)` → 抛 `RangeError: samples 必须为正，实际 0`；`integrate(Infinity)` → 抛 `[guard] samples 必须是有限数值`，**1ms 返回，未死循环** | ⚠️ **部分不一致**：`integrate(0)` 不是"静默返回 0"而是抛错；`integrate(Infinity)` 已有 guard，不会死循环 |

> 这两条请对方窗口**重新复现后再决定修不修**。
> 我倾向于：`integrate(0)` 从"抛错"改成"用默认采样数"是合理的（抛错对调用方不友好），
> 但清单里"静默返回 0"的描述与当前代码不符，照那个描述去修会修错地方。
> `integrate(Infinity)` 已经安全，建议直接判"不成立"（附本报告输出为证）。

### expression

| 清单条目 | 实跑输出 | 与清单描述是否一致 |
|---|---|---|
| 三元分支里的负数字面量 | `a > 0 ? -1 : -2` → 抛 `[Expression] 意外的符号 "-"（位置 8）`；对照 `0 - 1` → `-1` 正常 | ✅ 一致（仅在三元分支内失败） |
| `BUILTIN` 裸对象命中原型链 | `constructor(1)` → 抛"结果不是有限数：1"；`toString(1)` → 抛"结果不是有限数：[object Undefined]"；`hasOwnProperty(1)` → 抛 `Cannot convert undefined or null to object` | ⚠️ **描述需修正**：不是"被当成函数正常返回"，而是**取到了原型上的函数、调用后抛非受控异常**（`hasOwnProperty` 那条甚至不是本单元的 Error 类型） |
| 非 strict 模式 `null` / `[]` / 未定义变量当 0 | 未定义 `a` → `a+1 = 1`；`a=null → 1`；`a=[] → 1`；`evaluateStrict({})` → 抛 `[Expression] 未定义的变量：a` | ✅ 一致（strict 分支已经正确） |
| P2 · 除零 / 取模零静默返回 0 | `1/0 → 0`；`1%0 → 0` | ✅ 一致 |
| P2 · `destroy()` 后对象仍可用 | `destroy()` 后 `evaluate(0.5)=0`（README 承诺"不能再 evaluate"） | ✅ 一致（且不抛错，是静默给 0） |

---

## 3. 需要总审裁决的一条

**`expression` 的 `BUILTIN` 原型链问题，修法有分歧**：

- 方案 A：把 `BUILTIN` 换成 `Object.create(null)` + 显式 `hasOwn` 查表。
  这是全库"模式 A / Record 查表原型链"的统一修法，与 `audio` 的 `BgmStack.setState()` 同源。
- 方案 B：保留裸对象，只在查表前加 `Object.prototype.hasOwnProperty.call(...)`。

两者对外行为一致，但 A 会改变 `BUILTIN` 这个**导出符号**的对象原型。
我没有查到其他单元是否直接引用 `BUILTIN`（本窗口单元边界之外），
所以不判断——请总审或 W7-B 窗口确认后统一。

---

## 4. 给 W7-B 窗口的交接建议

1. 交付物命名：`audit/result_W7-B.md` + `tests/run_phase10_w7b.ts`（导出 `runPhase10W7BTests()`）。
2. 第 2 节表格可直接作为"复现输出（修复前）"列的素材，但**请自己重跑一遍**——
   验收标准 1 明确要求"对方自己跑出来的输出"，抄我的不算。
3. `curve` 那两条与清单描述不符的（`integrate(0)` / `integrate(Infinity)`），
   建议先在报告里标"不成立（附证据）"或"已修（附说明）"，不要照清单硬修。
4. 临时脚本放 `/tmp`，不要放 `verify/`（会让 `check-deps.js` 报未登记分层）。
