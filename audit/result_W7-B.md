# 交付报告 · 窗口 W7-B（第 B 组）

| 项 | 值 |
|---|---|
| 单元 | `achievement` / `curve` / `expression` |
| 条目 | 12（P1 × 10，P2 × 2） |
| 来源批次 | batch4 |
| 基线 | 构建通过、**3696 项测试全绿**、6 项校验脚本全过 |
| 交付后 | 构建通过、**3696 项全绿**；本批 46 条新用例临时注册后跑出 **3742 全绿**（见 §5.2） |
| 源码改动 | `achievement/Achievement.ts`、`curve/Curve.ts`、`expression/Expression.ts` + 三个单元 README |
| 测试 | `tests/run_phase10_w7b.ts`（导出 `runPhase10W7BTests()`，未改 `tests/run.ts`） |
| 交叉验收 | `audit/verify_W7-B.md`（验收 W7-A；**已重写为第 2 版**，见 §8） |
| 被验收 | `audit/verify_W7-A.md`（W7-A 验收 W7-B）—— **结论：通过**，收尾见 §8 |

---

## 0. 复现方法

所有"修复前"输出都由 `/tmp` 下的复现脚本实测得到（直接跑 `.build/` 下的编译产物），
**没有一条是照抄任务书里的证据**。脚本放 `/tmp`，不入库——
避免 `check-deps.js` 报"未登记目录"。

---

## 1. 逐条结果

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| P1-A1 | achievement | P1 | 已修 | `importState(['a'])` → 1；再 `importState(['b'])` → **2**（期望 1） | 替换语义：先 `clear()` 再写入，第二次导入后 = 1；另开 `mergeState()` 表达追加 | `run_phase10_w7b.ts` › W7-B · achievement（P1-A1） |
| P1-A2 | achievement | P1 | 已修 | onProgress → `check()`（1 次）→ `revoke()` → `check()` → 回调仍是 **1** 次（期望 2） | `revoke()` 一并清 `_lastProgress`，回调恢复为 2 次 | 同上 ›（P1-A2） |
| P1-A3 | achievement | P1 | 已修 | `target: NaN` → `current = NaN, target = NaN`；`target: 0` → `current = 0, done = true`（秒达成） | `clampNum(target, 1, 1e12, 1)` 收口；NaN/0/Infinity 均回落 1，未填仍为 1 | 同上 ›（P1-A3） |
| P1-A4 | achievement | P1 | 已修 | A（无前置）、B（`requires:['A']`）：`unlock('B')` → **true**，`isUnlocked('B')` true，而 `requirementsMet('B')` 仍 false | `unlock(id, bypassRequires?)` 默认校验前置，返回 false；需绕过时显式 `unlock('B', true)` | 同上 ›（P1-A4） |
| P1-C1 | curve | P1 | 已修 | `evaluate(NaN)` → **NaN**（对照 `evaluate(Infinity)` → 10，clamp 正常） | 入口挡 NaN，按"时间未定义"返回起点值；±Infinity 仍按方向 clamp | `run_phase10_w7b.ts` › W7-B · curve（P1-C1） |
| P1-C2 | curve | P1 | 已修 | 空曲线 `minValue` → **Infinity**、`maxValue` → **-Infinity**；归一化 `(1-min)/(max-min)` → **NaN** | 空曲线返回 0（非空曲线行为不变，既有 `run_batch3` 用例仍绿） | 同上 ›（P1-C2） |
| P1-C3 | curve | P1 | **需总审裁决**（现状已修，本窗口只上锁） | 实测**不死循环也不静默返回 0**：`integrate(Infinity)` 抛 `samples 必须是有限数值`，`integrate(0)` 抛 `samples 必须为正` | 保持抛错；按任务书建议改成静默 `clampNum` 会与既有用例冲突，理由见 §3 | 同上 ›（P1-C3） |
| P1-E1 | expression | P1 | 已修 | `1 ? -5 : -7` → 抛 `意外的符号 "-"（位置 4）`；`hp > 0 ? -dmg : 0` → 同错（位置 9）；`1 ? 5 : 7` → 5（正常） | `isUnary` 前导集合补 `question` / `colon`；扣血类公式可用 | 同上 › W7-B · expression（P1-E1） |
| P1-E2 | expression | P1 | 已修 | `toString()` → 抛 `函数 toString() 的结果不是有限数：[object Undefined]`；`hasOwnProperty()` → 抛 `Cannot convert undefined or null to object` | 查表改 `Object.prototype.hasOwnProperty.call(BUILTIN, name)`，一律报"未知函数" | 同上 ›（P1-E2） |
| P1-E3 | expression | P1 | 已修（附说明） | `missingVar + 1` → 1；`arr=[]` → 1；`n=null` → 1；与"确实填了 0"完全无法区分 | 返回值仍为 0（改抛错会 breaking），新增可卸载告警出口 `setExpressionWarningHandler()`，每个表达式每个键只报一次 | 同上 ›（P1-E3） |
| P2-C4 | curve | P2 | 已修 | `destroy()` 后 `evaluate(0.5)` → **0**（`keyCount` 也是 0，不抛错），与 README"destroy 之后不能再 evaluate"相反 | 置 `_destroyed`，再 evaluate 抛错；新增 `destroyed` 只读属性；`clone()` 出的副本不受影响 | 同上 › W7-B · curve（P2-C4） |
| P2-E2 | expression | P2 | 已修（文档化，不改代码） | `10 / 0` → 0、`10 % 0` → 0 | 行为不变，README 显式写下"除零得 0"规则 + 用例如锁 | 同上 ›（P2-E2） |

---

## 2. 改动清单（只改必要的那几行）

| 文件 | 改动 |
|---|---|
| `achievement/Achievement.ts` | 新增 `import { clampNum }`；`_progressOf` 的 target 收口；`revoke` 清进度缓存；`unlock` 加 `bypassRequires` 并校验前置；`importState` 改替换语义 + 新增 `mergeState` |
| `curve/Curve.ts` | 新增 `_destroyed` 与 `destroyed` getter；`evaluate` 挡 NaN + destroy 守卫；`minValue` / `maxValue` 空曲线返回 0；`destroy` 置标志 |
| `expression/Expression.ts` | `tokenize` 的 `isUnary` 补 `question` / `colon`；新增 `setExpressionWarningHandler` / `EvalContext` / `warnOnce`；`evalNode` 改走 ctx，变量分支补留痕；`BUILTIN` 查表改自有属性判定 |
| `achievement/README.md` | 坑表补 target 收口；`unlock` 签名与前置校验说明；`importState` 替换语义 + `mergeState` |
| `curve/README.md` | 坑表补 NaN / 空曲线极值 / `integrate` 采样数；API 表补 `destroyed` 与三处限定；`destroy` 段落说明"为什么是抛错" |
| `expression/README.md` | 坑表补三元负号与原型链函数名；新增"除零与取模零：返回 0（已知取舍）"小节；新增"非 strict 模式下的静默降级：会留痕"小节与 `setExpressionWarningHandler` API 行 |
| `_kitmeta.json` | `achievement` 的 depends 补 `_core`（由 `check-deps.js --fix` 写入） |

`_core/` 未改动。`tests/run.ts` 未改动（总审统一合并）。

---

## 3. 需总审裁决的一条：curve 的 `integrate(samples)`

**事实**：本窗口开工前实测，`integrate(Infinity)` 与 `integrate(0)` **都已经抛错**，
缺陷已由 `needCount()` 修掉（`tests/run_phase3.ts` 里有两条对应用例在守）。

**任务书建议**改成 `clampNum(samples, 1, 1e5, 64)` 静默收口。**我没有照做**，两个理由：

1. **会让既有用例变红**：`run_phase3.ts` 的两条断言的是 `throws`，改成静默收口后它们必然失败，
   违反"测试条数只增不减"；
2. **方向相反**：`samples = Infinity` 是配置算错的信号（典型是 `duration / dt` 且 dt 为 0）。
   静默取 64 会把"配置错了"变成"积分结果悄悄偏了"——
   与本库"宁可抛错，也不要静默错误"的取向相反。

两种选择：

| 方案 | 利 | 弊 |
|---|---|---|
| A. 维持抛错（现状） | 错误在源头暴露；与既有用例一致 | 调用方若未捕获会中断加载流程 |
| B. 改成静默收口 | 加载永不中断 | 既有 2 条用例要改；配置错误被吞成"数值偏差" |

**我的建议是 A**。本文件只给现状上锁（将来谁改回静默，这两条会立刻变红）。

---

## 4. 另两处"修法与直觉不同"的说明

1. **P1-E3 没有把"未定义变量"改成抛错。**
   宽松语义是刻意设计（配置常引用"现在还没设置"的变量），改成抛错会让既有配置全线加载失败，
   属于 breaking。所以只补一条**可卸载**的告警：不装 handler 时行为与修复前**完全一致**，
   装了才能收到"哪个变量没定义"。

2. **P1-A2 的进度缓存清理放在 `if (ok)` 外面。**
   撤销一个"本来就没解锁"的成就时 `ok === false`，但宿主意图同样是"退回未解锁并重新观察"
   ——GM 工具正是这么用的。只在这里清一半，等于给最常用的那条路径留了一份过期缓存。

---

## 5. 自检结果

### 5.1 全量回归

```
bash build.sh          → TSC OK（产物校验通过：212 个 .js）
node .build/tests/run.js → 通过 3696 项，失败 0 项
```

### 5.2 本批新用例（46 条）

`tests/run.ts` 由总审统一合并，本窗口不改它。
验证时临时注册跑了一次（跑完已还原 `run.ts`）：

```
setSuite('精审返工 · W7-B（achievement / curve / expression）');
runPhase10W7BTests();

→ 通过 3742 项，失败 0 项        （3696 + 46）
```

每条修复都配了：一条**修复前会失败**的用例 + 一条**防止矫枉过正**的对照用例。
失败信息在文件注释里逐条写明了"修复前"的真实数值。

### 5.3 六个校验脚本

| 脚本 | 结果 |
|---|---|
| `node scripts/check-deps.js` | 全部通过 ✓（`achievement → _core` 已由 `--fix` 补登记；**该登记后被并发推送冲掉，已在 §7.2 重新修复**） |
| `node scripts/check-links.js` | 断链均来自其它窗口的交付物，本窗口未新增 |
| `python3 scripts/scan-dt-guard.py` | 命中 0 处 ✓ |
| `python3 scripts/scan-num-guard.py` | 命中 0 处 ✓ |
| `python3 scripts/check-random-source.py` | 未发现自建随机源 ✓ |
| `scripts/check-dup-exports.js` | **该脚本在库中不存在**（任务书 §2.3 列出的第 6 个脚本缺失），无法执行 |

---

## 6. 遗留与提示

1. `scripts/check-dup-exports.js` 不存在，任务书 §2.3 与实际脚本目录对不上，请总审确认是漏提交还是已废弃。
2. `check-links.js` 的断链全部来自其它窗口的交付物，不属于本批单元，未擅自修改。

---

## 7. 推送后复核（在远程最新代码上重跑）

首次推送完成后，远端 `main` 又被 W2-B / W3-B / W4-B / W8-B 等窗口推进了若干提交。
本节是在**合并了这些提交之后**的最新代码上重跑的结果——
上面的 §5 是"我自己的基线上"的结果，两者不是一回事。

### 7.1 我的交付物是否还在

| 文件 | 状态 |
|---|---|
| `audit/result_W7-B.md` | 在（9470 字节） |
| `audit/verify_W7-B.md` | 在（7351 字节） |
| `tests/run_phase10_w7b.ts` | 在（26643 字节） |
| `achievement/Achievement.ts`、`curve/Curve.ts`、`expression/Expression.ts` | 与本地推送版本**逐字节相同** |
| 三个单元 README | 逐字节相同 |
| `_core/` | 无人改动 ✓ |

### 7.2 ⚠️ 发现一次并发覆盖：`_kitmeta.json` 的登记被冲掉

推送时我用 `check-deps.js --fix` 写入的 `achievement → ['_core']`
在远端最新代码上**变回了 `[]`**——别的窗口基于旧树推的那份把我的改动盖了回去。

这是本库"多窗口同时推同一个文件"的典型失效：
`_kitmeta.json` 是**全库共享**的登记文件，不在任何窗口的单元边界内，
用 API 按 `base_tree` 提交时，谁的 base 旧谁就会把别人的改动抹掉。

**已重新修复**（在最新树上改回 `['_core']`）并再次推送。

> 提示总审：**合并期结束前，`_kitmeta.json` 建议由总审统一跑一次 `--fix`**，
> 否则这个字段会被各窗口反复冲掉。复核时残留的未登记项（属于其它窗口的单元）：
> `i18n` / `curse` / `rebind` / `gameflow` → `_core`。本窗口未越界代改。

### 7.3 合并后的全量回归

```
bash build.sh             → TSC OK（产物校验通过：219 个 .js）
node .build/tests/run.js  → 通过 3696 项，失败 0 项
```

基线未跌（3696 = 我开工时的数字）。

> 注：各窗口的新测试文件都**没有**注册进 `tests/run.ts`（按第 6 节纪律，由总审统一合并），
> 所以总数仍是 3696——这不代表别人的测试没跑，只是没挂上入口。

### 7.4 八窗口联跑（集成验证）

为了确认"别人的改动没打穿我的单元、我的也没影响别人"，
我把当前已交付的全部 phase10 测试文件临时挂上跑了一次（跑完已还原 `run.ts`）：

```
runPhase10W1BTests / W2B / W3A / W3B / W4A / W4B / W7B / W8B

→ 通过 4174 项，失败 0 项
```

其中本窗口 `W7-B` 的 46 条**全部通过，0 失败**。
说明三个单元的修复与其它 7 个窗口的改动**无冲突**。

### 7.5 合并后的校验脚本

| 脚本 | 结果 |
|---|---|
| `scan-dt-guard.py` | 命中 0 处 ✓ |
| `scan-num-guard.py` | 命中 0 处 ✓ |
| `check-random-source.py` | 未发现自建随机源 ✓ |
| `check-deps.js` | 本窗口单元已通过；残留 4 条属其它窗口（见 §7.2） |
| `check-links.js` | 断链 8 处，**全部来自** `handoff_W3-B.md` / `result_W1-B.md` / `result_W2-B.md` / `result_W3-B.md` / `verify_W3-B.md`——**本窗口的 `result_W7-B.md` / `verify_W7-B.md` 未产生任何断链** |
| `check-dup-exports.js` | 脚本不存在（见 §6.1） |

---

# 8. 验收后的收尾（回应 `verify_W7-A.md`）

> W7-A 于 `2026-09-08 00:36`（提交 `67cb32359`）给出验收结论：**通过**。
> 12 条全部独立复现属实、11 个代码修复点逐个回退后都变红、每条都有对照用例、
> 三处"看起来像 bug 实为设计"判断正确。
>
> 验收报告另提 **3 项非阻塞知会**。本节逐项给出处理结果与证据。
> 收尾只动了**本窗口自己的 3 个单元**，未触碰 `_core/` / `tests/run.ts` / 其它窗口的文件。

## 8.0 收尾总览

| 知会项 | 性质 | 我的处理 | 是否动代码 |
|---|---|---|---|
| §5.1 `_kitmeta.json` 的 `achievement → _core` 未登记 | **共享文件，反复被并发推送冲掉** | **不越界代改**，留可执行方案给总审 | ❌ 不改 |
| §5.2 `unlock()` 默认校验前置是 breaking | 需总审知会 | README 早已覆盖（补位置索引）；**新增 §8.2 把它正式列为裁决项**（这是原报告漏列的一节） | ❌ 不改（仅补报告） |
| §5.3 `setExpressionWarningHandler` 是模块级全局 | 措辞易误读 + 一处前瞻风险 | 补注释澄清"handler 全局 / 去重按实例"两个粒度，并**写进 README + 用 3 条用例上锁** | ✅ 只加注释与测试，行为零变化 |

---

## 8.1 §5.1 —— `_kitmeta.json` 的登记：不代改，交总审

**当前状态**（本次收尾时再跑一次 `check-deps.js`，与 W7-A 验收时一致）：

```
✗ import 了但没登记 8 条：
    i18n / blessing / curse / rarity / achievement / rebind / gameflow / accessibility → _core
```

其中只有 `achievement` 属本窗口。**这一条我已经修过两次，两次都被并发推送冲掉**
（第一次见 §5.3，第二次见 §7.2），现在第三次查看仍是未登记。

**我不做第三次单方面修复**，理由与验收方一致：
`_kitmeta.json` 是全库共享登记文件，不在任何窗口的单元边界内，
谁基于旧树推谁就会把别人的改动抹掉——继续各写各的，只会让"谁在覆盖谁"更难追溯。

**留给总审的可执行方案**：合并期结束前统一跑一次

```bash
node scripts/check-deps.js --fix
```

它会一次性修掉全部 8 条（不是只修 `achievement`）。请注意这一点：
单窗口执行 `--fix` 会顺带把别的窗口的登记也写上，属于事实上的越界，所以必须由总审来做。

---

## 8.2 §5.2 —— `unlock()` 的行为变更：README 已覆盖，正式补列为裁决项

**先说结论：这条建议要的"在 README 里点一句、并提示改用 `unlock(id, true)`"，交付时就已经做了**，位置：

- `achievement/README.md:58` —— API 表：`unlock(id, bypassRequires?)` ／"**默认校验前置**；传 `true` 可绕过"
- `achievement/README.md:61-66` —— 独立警告块，写清了"同一个解锁动作两条路径两套规则"的矛盾、
  "已解锁但前置未完成"的后果，以及确实要绕过时写 `unlock('b', true)`

**但验收方指出的一点我确实漏了**：`result_W7-B.md` 的"需总审裁决"章节里只有 P1-C3 一条，
**没有把 `unlock()` 的对外行为变更列为知会项**。文档写了、报告没标，总审扫报告时会漏掉。
在此正式补上：

> ### 补充裁决项 · `unlock()` 默认校验前置（breaking）
>
> **变更**：`unlock('B')` 在前置 `A` 未达成时，由返回 `true` 改为返回 `false`。
> 这是任务书 P1-A4 要求修的（原实现能造出违反依赖图的存档），方向正确。
>
> **风险面**：任何"先解锁后补前置"的既有下游代码——补发脚本、GM 工具、老存档迁移——
> 现在会**静默失败**（返回 false 且不抛错）。
>
> **库内影响：无。** 基线 3696 项里没有用例依赖旧行为（实测全绿）。
> **下游影响：可能有。** 本库之外的使用者不受本库测试保护。
>
> **两种选择**：
>
> | 方案 | 利 | 弊 |
> |---|---|---|
> | A. 维持默认校验（现状） | 依赖图不再被绕过，与 `checkOne()` 口径一致 | 下游"先解锁后补前置"的代码会静默失败 |
> | B. 回退成默认不校验 | 下游零改动 | 任务书 P1-A4 的缺陷原样保留：GM 一调就造出矛盾存档 |
>
> **我的建议是 A**，与验收方一致。若总审担心下游，可选 A′：保持默认校验，
> 但在前置未达成时**额外走一次告警出口**（不抛错），让"静默失败"变成"看得见的失败"。

---

## 8.3 §5.3 —— 告警 handler 的粒度：补注释 + 上锁（本次唯一的实质改动）

验收方说得很准确：**当前设计没问题**，但"每个表达式每个键只报一次"这句
容易被读成"全进程只报一次"，而且**handler 是模块级、去重却是按实例的——两个粒度不一样**。

本库的规矩是"写进文档的行为要有测试锁着"，所以我把这个差异**显式写清楚并上锁**，共三处：

### 8.3.1 源码注释（`expression/Expression.ts`）

在 `setExpressionWarningHandler` 的说明块里新增"【⚠️ handler 是模块级全局，去重却是按实例的】"一段，
点明：三个表达式用了同一个拼错的变量名会**各报一次**，不是全进程只报一次；
并补上验收方提到的前瞻风险——每帧 `new Expression()` 时去重会失效（每帧新实例、新 `_warned`），
真到那一步再改成"按表达式源码去重"，**现在不改**（本库用法是配置期编译一次、运行期反复 evaluate）。

`EvalContext.warned` 的字段注释也补了"**按实例**，不是全局"的指向。

**只加注释，逻辑一行未动。**

### 8.3.2 README（`expression/README.md`）

在"非 strict 模式下的静默降级：会留痕"小节末尾补一个警告块，
把"handler 全局 / 去重按实例"和"每帧 new 会去重失效、正确用法是长命实例"写进文档。

### 8.3.3 新增 3 条用例（`tests/run_phase10_w7b.ts`，46 → **49** 条）

| 用例 | 锁的是什么 |
|---|---|
| handler 是全局的——装一次，之后新建的实例同样生效 | 防止有人把 handler 改成实例级（那会让"装一次全局生效"失效） |
| 去重按实例——两个实例用同一个拼错的变量名，会各报一次 | 锁住"两个实例 → 2 条告警"这个粒度差异 |
| 每帧 new 表达式时去重失效（**记录现状**） | 锁住"5 次 new → 5 条告警"的真实行为；将来若改成按源码去重，这条会红，届时应连 README 一起改，而不是删断言 |

### 8.3.4 独立实测（`/tmp/v/verify_warn.js`，7 项全对）

```
1. 不装 handler：evaluate 5 次，console 输出 0 条          → 默认静默 ✅
2. 同一实例 evaluate 5 次 → 告警 1 条                      → 去重生效 ✅
3. 两个实例同名变量各 1 次 → 告警 2 条                     → 去重按实例 ✅
4. 装 handler 后才 new 的实例首次 evaluate → 告警 1 条      → handler 全局 ✅
5. 每帧 new 5 次 → 告警 5 条                               → 边界与文档一致 ✅
6. 卸载后不再告警；重新装上仍工作                           → 可卸载 ✅
7. 正常变量（critRate 已提供）→ 告警 0 条                   → 未误伤 ✅
```

### 8.3.5 回退验证：这 3 条新用例"真的会失败"

按标准 2，新加的用例必须经得起"改回/改掉实现后是否变红"。在 `/tmp` 副本上做了两次
（副本独立编译，未动主仓库 `.build/`）：

| 副本改动 | 结果 |
|---|---|
| **A**：把 `_warned` 从"每实例一份"改成"模块级一份"（模拟全局去重） | 通过 47 / **失败 2** —— 第 2、3 条红（第 1 条仍绿，符合预期：它验的是 handler 而非去重） |
| **B**：把 `_warnHandler` 从模块级改成实例字段（新实例不继承） | 通过 43 / **失败 6** —— 第 1 条红（"新实例无需各自注册 handler 期望 1，实际 0"） |

**3 条新用例全部对实现敏感，没有一条是"传了本来就不会出问题的输入"。**

---

## 8.4 闭环：W7-A 在 `verify_W7-A.md` §6 对我提的三点

W7-A 在验收报告末尾回应了我（上一版 `verify_W7-B.md`）提的三点反馈：

1. **`falloff = -1` 的措辞要收窄**（我实测总位移是 4 不是 0，真实现象是"位移堆到末尾→单帧瞬移"）
   —— W7-A **已接受并修正注释口径**。
   我在重写第 2 版 `verify_W7-B.md` 时复核了恢复后的版本：**措辞已改准**（"不是位移恒 0，而是曲线退化成单帧瞬移"）。✅ 闭环。

2. **`hexToPixel(size=0)` 得到的是 `(0,0)` 不是 NaN** —— W7-A 核对后确认两个函数都加了 `!(size > 0)` 正性守卫，
   已覆盖。我第 2 版验收里实测 `pixelToHex(25,-8,0)` 返回有限原点。✅ 闭环。

3. **`Grid.ts` 源码 JSDoc 里的旧示例 `c.value === '树'`** —— W7-A 确认已改。
   我第 2 版验收里核对：源码 JSDoc 与 README 现在都是 `(v) => v === '树'`。✅ 闭环。

---

## 8.5 收尾后的自检（全部重跑）

| 项目 | 结果 |
|---|---|
| `bash build.sh` | TSC OK（产物校验通过：**227** 个 .js） |
| `node .build/tests/run.js` | **通过 3696 项，失败 1 项** —— 唯一失败仍是 `binary › float 会 clamp 而不是溢出回绕`，属 W8-B 单元，与本窗口无关（W7-A 验收时已核对提交时间：W8-B 推于 16:54，晚于本窗口 15:54） |
| `runPhase10W7BTests()` 单独跑 | **通过 49 项，失败 0 项** ✅（46 → 49，只增不减） |
| `check-deps.js` | 本窗口单元无新增问题；残留 8 条属共享文件，见 §8.1 |
| `check-links.js` | **[OK] 内部链接 42 条，断链 0 处**（扫描 191 个 .md）—— 本窗口新增的 README 段落未引入断链 |
| `scan-dt-guard.py` | 命中 0 处 ✓ |
| `scan-num-guard.py` | 命中 0 处 ✓ |
| `check-random-source.py` | 未发现自建随机源 ✓ |
| `check-dup-exports.py` | [OK] 无待处理的冲突 ✓ |

> `check-dup-exports` 只有 `.py` 版本（`.js` 在库中不存在），这一点与 W7-A 报告里的说明一致。

## 8.6 收尾改动清单

| 文件 | 改动 |
|---|---|
| `expression/Expression.ts` | **只加注释**（handler 粒度说明 + `EvalContext.warned` 指向），逻辑零变化 |
| `expression/README.md` | 新增一处警告块（handler 全局 / 去重按实例 / 每帧 new 的边界） |
| `tests/run_phase10_w7b.ts` | 新增 3 条用例（46 → 49），锁住上面写进文档的粒度语义 |
| `audit/result_W7-B.md` | 本 §8 章节 + 表头补"被验收"一行 |

`_core/` 未动；`tests/run.ts` 未动（仍由总审统一合并注册）；
`achievement` / `curve` 的代码与 README **本次未动**（验收无意见，无需返工）。

## 8.7 本窗口的最终状态

- 12 条全部已修（含 P1-C3"只上锁不硬改"，待总审裁决）；
- 被 W7-A 验收 **通过**，3 项知会已按 §8.1~8.3 处理；
- 我方验收 W7-A 的报告已重写为第 2 版（旧版结论基于 W7-A 落库前的基线，已过时），结论同为 **通过**；
- 测试 **49 项全绿**，全量基线未跌。
