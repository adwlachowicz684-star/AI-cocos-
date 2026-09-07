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
| 交叉验收 | `audit/verify_W7-B.md`（验收 W7-A） |

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
