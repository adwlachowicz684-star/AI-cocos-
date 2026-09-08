# 验收报告 · W8-B 验收 W8-A（**第 3 版 · 终版**）

> **版本链**：第 1 版 `a315ede8`（结论「无法验收 · 零交付」，已作废）
> → 第 2 版 `1d28f325`（重写为逐条验收，结论「通过」）
> → **本版（第 3 版）**：在主审核人 `CHIEF_FINAL_VERDICT.md` 之后出具，
> 补回落实验原始输出、更正我第 2 版的两处数字，并**回应终审 C9 / C10 两条与本窗口直接相关的裁决**。
> **A3 指派（重写为逐条验收）已在第 2 版完成，本版为收口版。**

| 项 | 值 |
|---|---|
| 验收方 | `W8-B`（第 B 组，同编号） |
| 被验收 | `W8-A` —— 单元 `autoquality` / `loot` / `meta`，12 条（P1 × 9 / P2 展开 12 条子项） |
| 标准 | `audit/review_B.md` 第 2 节五条硬标准 |
| 开工基线 | `fbd27f60`（W8-A 首个修复提交 `bf7072a6` 的父提交） |
| 验收基线 | `main` @ 主审核人终审后（16 套件已注册，**4,653 项 / 0 失败**） |
| 验收方式 | 按 SHA 取前置基线做**回退实验** + 仓库外只读复现；全程未改动对方一行代码 |

---

## 结论

# ✅ 通过

五条硬标准逐条独立验证，**全部成立**。详见 §六。

> 本版新增的不是结论，是**两条需要主审核人回看的冲突**（§七）：
> 终审 C9 / C10 两条裁决，依据的是我第 1 版里**已经被我自己撤回**的意见，
> 而依据的原文（任务书）与当前代码状态都指向相反方向。我不自行改代码，据实上报。

---

## 一、交付物核查（补第 1 版的方法说明）

第 1 版我用 GitHub API 按路径直查 main，确认 `result_W8-A.md` 与 `run_phase10_w8a.ts` 均 404，
三个单元最后提交早于窗口起点 → 判「零交付」。**该结论在其时点正确**，主审核人 §2.1 亦予认可。

第 2 版起，交付物已存在：

| 交付物 | 现状 |
|---|---|
| `audit/result_W8-A.md` | 20,775 字节，12 条逐条含"复现输出（修复前）" |
| `tests/run_phase10_w8a.ts` | 1,033 行，**42 项，实测 0 失败**（已随终审 §4.1 进入全量回归） |

**本版基线的取法**（这一步值得写清，因第 1 版就栽在快照上）：
本沙盒多窗口共享，本地副本会被别的窗口覆盖，所以**不依赖本地快照**——
按 SHA 从 GitHub 取：`autoquality` 路径提交历史 → W8-A 首个修复提交 `bf7072a6`
→ 其父提交 `fbd27f60` 的 tarball。校验：三单元行数与第 1 版实测一致，
且不含 `_fpsOrIdle` / `unknownRequires` / `MAX_CACHE` 任何一个新符号。

---

## 二、标准 1 · 是否真的复现过 → ✅ 成立

我第 1 版代为复现过 21 条，W8-A 交付时自跑了 12 条。两份独立输出逐条对照，全部对得上。
两条"不成立"的判定（P1-3 子表循环 / Lo7 非保底）是**不同窗口、不同时间各自跑出来的同一结论**，可信度最高。

| 条目 | 我的实测 | W8-A 自报 | 一致 |
|---|---|---|---|
| P1-1 `setManualLevel` | `{"from":0,"to":0}`、`from === to ? true` | 同 | ✅ |
| P1-2 `FpsMeter(NaN)` | `THROW: Invalid array length` | `RangeError: Invalid array length` | ✅ |
| P1-3 子表循环 | 抛业务错误（环检测），**非栈溢出** → 判不成立 | 同 | ✅ |
| P1-4 `pickUnique` + `setWeight(v,0)` | `THROW: 权重必须为正，实际 0` | 同 | ✅ |
| P1-5 `PRD._cache` | `0 → 5000`（入口 `fromChance`） | 同 | ✅ |
| P1-6 `Chest.importState` 越界 | 产出 `undefined` 选项、状态已 `taken` | `["sword",null,null]` | ✅ |
| P1-7 `requires` 未知 id | 实测真能一路解锁 | 同 | ✅ |
| P1-8 `set` 被等级缩放 | Lv2 → 100 | Lv2 → 100、Lv3 → 150 | ✅ |
| P1-9 `setLevel(NaN)` | `effectOf.add = NaN`、`compute = NaN` | 同 | ✅ |

---

## 三、标准 2 · 测试是否真的会失败 → ✅ 成立（附回退实验原始输出）

把 `fbd27f60` 的 `autoquality/` `loot/` `meta/` 换进最新 main，**保留 W8-A 全部 42 项新测试**后重建：

```
$ tsc -p tsconfig.json
tests/run_phase10_w8a.ts(115,13): error TS2339: Property 'sampleCount' does not exist on type 'FpsMeter'
tests/run_phase10_w8a.ts(267,31): error TS2339: Property 'MAX_CACHE' does not exist on type 'typeof PRD'
tests/run_phase10_w8a.ts(504,9):  error TS2353: 'historyLimit' does not exist in type 'AutoQualityConfig'
tests/run_phase10_w8a.ts(609,10): error TS2339: Property 'destroy' does not exist on type 'AutoQuality'
tests/run_phase10_w8a.ts(928,10): error TS2339: Property 'destroy' does not exist on type 'MetaProgression'

$ node -e "...runPhase10W8ATests()...summary()"
通过 20 项，失败 22 项
```

**5 处 TSC 报错反证测试绑定新增 API**，不是"修复前后都一样"的松断言。**无恒通过用例**，标准 2 成立。

### 3.1 更正我第 2 版的一处数字

第 2 版我写「22 条失败全部落在复现缺陷的用例上」——**不严谨**。逐条看实际报错：

| 类别 | 条数 | 说明 |
|---|---|---|
| 缺陷被复现（断言值与报告一致） | **15** | 如 `历史应不超过上限 5，实际 79`、`Lv2 仍应是 50 期望 50，实际 100` |
| 新增 API 在旧代码上不存在 | **7** | `unknownRequires` / `lastDropped` / `sampleCount` / `destroy` ×3 |

7 条里部分是 W8-A 自报的"3 条类型错误"（它只统计了编译期，我按运行期算 7 条）。
**不影响标准 2 成立**，但按 22 统计"修复点数量"会偏大。同类问题 W8-A 验收我时也指出过
（我的 B5/B6/A6/B9/B13 有 5 条是"现状上锁"而非"复现"），两边同一个毛病，已一并报总审统一口径。

---

## 四、标准 3 · 对照用例 → ✅ 成立（一处纯度问题）

12 组修复每组都配"正常输入不受影响"的对照。一处瑕疵：

**3 条标着"（防止矫枉过正）"的对照用例，在修复前也会失败**（已计入上表 22 条）：

| 用例 | 为什么在旧代码上也红 |
|---|---|
| P1-4 对照 | 末段断言"全零权重返回空不抛错"，这本身依赖修复 |
| P1-6 对照 | 读 `lastDropped`（新增字段），旧代码 `undefined.length` |
| M6 对照 | 断言 `respec(5)` 夹到 1，属修复的一部分 |

三条在修复后均通过、对照断言均成立，结论不受影响；但标注为"防止矫枉过正"却不纯，建议改为"附加上锁"。

---

## 五、标准 4 · 无顺手重构 → ✅ 成立

5 个改动源文件（`AutoQuality.ts` / `Chest.ts` / `PRD.ts` / `WeightedTable.ts` / `MetaProgression.ts`）
+ 1 个新增测试 + `_kitmeta.json`（`meta → _core`）。`_core/` 与 `tests/run.ts` 逐文件比对**完全相同**。

### 5.1 逐行核查（过滤注释后的纯代码改动）

| 文件 | 改动 | 对应条目 |
|---|---|---|
| `AutoQuality.ts` | `setManualLevel` 先取旧档位 | P1-1 |
| | `FpsMeter` 窗口走 `clampNum` 收口 | P1-2 |
| | 内部持有 `FpsMeter` + `_fpsOrIdle` 委托三个统计量 | AQ6 |
| | `_history` 走 `_pushHistory`（带上限）+ `historyLimit` 配置 | AQ4 |
| | 排序结果缓存（`tick()` 写脏） | AQ5 |
| | 新增 `destroy()`（清历史与采样，不清配置） | AQ7 |
| `WeightedTable.ts` | `pickUnique` 建临时表时跳过权重 ≤ 0 | P1-4 |
| `PRD.ts` | 静态缓存改 LRU + `MAX_CACHE = 512` | P1-5 |
| `Chest.ts` | `importState` 逐项校验索引 + `lastDropped` 留痕 | P1-6 |
| | `_count` 改用 `clampNum` | Lo5 |
| | `destroy()` 置空 `owned` 引用 | Lo6 |
| `MetaProgression.ts` | 构造期收集 `unknownRequires` + getter + `console.warn` | P1-7 |
| | `case 'set'` 不乘等级 | P1-8 |
| | `setLevel` 用 `clampNum + floor` | P1-9 |
| | `respec` 比例收口到 [0,1] | M6 |
| | `topoOrder` 改游标指针 | M7 |
| | 新增 `destroy()` | M8 |

**每一行都能对应到清单条目**，无改名、无调结构、无删"看着没用"的代码。

### 5.2 三条复杂度类：我建议"别做"，对方做了 —— 我认可

我第 1 版建议 AQ5 / AQ6 / M7 统一"判不成立 + 留护栏"。对方做了 AQ5、AQ6、M7。逐条复核：

| 条目 | 我的原建议 | 对方处理 | 复核意见 |
|---|---|---|---|
| **AQ6** | 判不成立（担心空态 60 被改坏） | 已合并 | ✅ **它是对的，我错了** —— 任务书 `handoff_W8-A.md:194` **明文指令**"应合并（AutoQuality 内部持有 FpsMeter 即可）"。我第 1 版只看到重构风险，没回去读任务书原文（详见 §七 C9） |
| **AQ5** | 判不成立 + 护栏 | 加排序缓存 | ✅ ≤10 行，不改算法结构，读数不变，有用例锁 |
| **M7** | 判不成立 + 护栏 | 改游标指针 | ✅ 3 行，顺序与完整性有用例锁 |

三条实测耗时我都复核过（AQ5 单次 0.0057ms、M7 2000 节点 1.6ms），**确实不构成瓶颈**；
对方做 AQ6 的理由也不是"它慢"，而是"两份实现意味着修 bug 要修两遍"——这个理由成立。

---

## 六、标准 5 · 未把"设计如此"误判成 bug → ✅ 成立

### 6.1 AQ6 合并成功避开了我预警的陷阱（本条是我重点核的）

我第 1 版 §三纠错 3 写过：`AutoQuality` 与 `FpsMeter` 空态返回值不同（60 vs 0），
60 是防"开机首帧无数据 → 判性能差 → 画质降到最低档"的刻意设计，
按"内部持有 FpsMeter 即可"去合并，**会把 60 变成 0，改变对外行为**。

对方用 `_fpsOrIdle()` 保住了：

```ts
private _fpsOrIdle(v: number): number {
  return this._meter.sampleCount === 0 ? 60 : v;
}
```

实测复核（最新 main）：

| | `AutoQuality` | `FpsMeter` |
|---|---|---|
| 空态 median / average / lowFps1Percent | **60 / 60 / 60** ✅ | 0 / 0 / 0 |
| 有采样时（10 次） | 52.632 / 52.632 / 35.714 | 52.632 / 52.632 / 35.714（一致） |

**没有引入回归。** 且 `run_phase10_w8a.ts:587` 专门写了
「⚠️ 空窗口时的读数口径（AutoQuality 返回 60，FpsMeter 返回 0）」把差异钉住——
这正是终审 C9 要求补的"各写一条断言锁住自己的空态值"，**W8-A 已经做了**。

### 6.2 两条主动判"不成立"，与我独立复现一致

- **P1-3（子表循环）**：基线已有环检测，抛业务错误而非栈溢出 → 未改动 `LootTable` 一行，只加固化用例
- **Lo7（LootTable "抽一条"）**：核实 **README 从未声明"只抽一条"** → 定性"文档没写"而非"文档与实现矛盾"

### 6.3 P1-7 没有自行拍板，且采纳了我的折中方案（终审 C8 已采纳）

构造期 `console.warn` + 只读 `unknownRequires` + 运行期保持跳过。
我实测：合法配置 **0 告警**、笔误配置 **1 告警**，行为不 breaking。

### 6.4 我认领一处错误：Lo8 的归因是我错了

我第 1 版实测 `add x,y → draw → add z → draw,draw` 得到 `first=x, second=z, third=x`，
判断"x 在一轮内出现两次，违反 README『一轮之内每个元素恰好出现一次』"。

**归因错了。** `add()` 本身就是轮次边界。复核：

```
构造 A：add x,y → draw(x) → add z → draw,draw
   first=x   remaining(抽1次后)=1   add('z')后 remaining=0   second=z third=x
构造 B：add 之后连抽 3 次 = ["z","x","y"]  去重数量 = 3     ← 新一轮内仍恰好一次
构造 C：全程不 add，一轮连抽 3 次 = ["y","z","x"]  去重 = 3 ← README 承诺的本体，未被违反
```

正确定性是"**README 没说明 add 是轮次边界**"（补文档），不是"实现违反承诺"（改实现）。
**我的复现数据是真的，但归因错了**——判"现象成立"之后还要判"边界在哪"，我少了后一步。

---

## 七、⚠️ 两条需要主审核人回看的冲突（本版新增，不自行处置）

### 7.1 C9（`autoquality` AQ6 不合并）—— **与任务书明文指令冲突，且已被代码与测试闭环**

终审 C9 裁决「**不合并**」，来源标注为「W8-B 裁决2」——
即**我第 1 版里那条已经被我自己撤回的意见**（第 1 版 §三纠错 3）。我在第 2 版 §3.1 已更正。

三条事实，供主审核人复核：

**① 任务书是明文指令，不是窗口自选。** `audit/handoff_W8-A.md:194`：

> **AQ6** `AutoQuality.median/average/lowFps1Percent` 与 `FpsMeter.median/average/lowFps1Percent`
> 是同一份逻辑的两份实现（L216-242 vs L386-411）：**应合并（AutoQuality 内部持有 FpsMeter 即可）**。

这是审查给定条目的原文。第 1 版我写"未实测（属重构项，不在复现范围）"时**没有回去读任务书**，
这是我的疏漏；但裁决若以我的疏漏为依据，会让 W8-A 因执行任务书而被判违规。

**② 合并已经落地且全绿。** 当前 main：`AutoQuality` 持有 `_meter`、三处 getter 委托。
全量回归 **4,653 / 0**（含 W8-A 的 42 项），终审 §1 已实测确认。

**③ C9 要求的安全措施，W8-A 已经做了。** C9 原文要求"补交叉注释 + 各写一条断言锁住自己的空态值（60 / 0 是有意差异）"。
`run_phase10_w8a.ts:587` 的用例标题就是「空窗口时的读数口径（AutoQuality 返回 60，FpsMeter 返回 0）」，
且 `_fpsOrIdle` 的注释写明了 60 的用意。**C9 担心的"合并把 60 抹成 0"没有发生。**

**我的建议（不拍板）**：C9 维持"不合并"需要同时做三件事——回退 W8-A 已交付并通过验收的 AQ6、
改任务书条目、并接受"两份实现继续各修各的"。若仅因"平行实现保留两套"的通用口径，
建议改裁为「**维持已合并现状，保留 60/0 差异断言**」，与 C1/C6 的"breaking 留主版本"口径一致。
**无论怎么裁，我都不自行改代码**——`autoquality` 不是我的单元。

### 7.2 C10（`Chest.destroy()` 不释放 `owned`）—— 裁决已被采纳，但有一处新副作用需记录

终审 C10「追认不成立」采纳的是我的原判断，A9 指派 W8-A 补 README。——**这部分无异议**。

但当前代码里 W8-A 仍实现了 `this._options.owned = undefined`（只断引用、不清数组），
这带来一个**此前没人记录的静默行为**：

```
destroy 前 addOwned('b') → owned = ["a","b"]    正常写入
destroy 后 addOwned('c') → owned = ["a","b"]    静默吞掉，无报错
```

根因：`addOwned()` 的守卫是 `if (!this._options.owned) return;`，
destroy 之后该守卫把"已销毁"和"从未传 owned"当成一回事。

destroy 之后对象本就该废弃，可接受；但这是本库最忌的"静默"形态。
**建议（低优先级，不必现在改，随 A9 一起处理即可）**：
`addOwned` 在已 destroy 时给一次 `console.warn`，或置 `_destroyed` 标记区分两种情形。

---

## 八、小问题汇总（建议补，不阻塞）

| # | 问题 | 归属 |
|---|---|---|
| 1 | 测试项数：报告正文 41、实测 42（差 1 是收尾新增的 `unknownRequires` 告警用例） | W8-A 文档 |
| 2 | "22 条失败全部是缺陷复现"实为 15 复现 + 7 API 缺失（§3.1） | W8-A 文档 |
| 3 | "3 条类型错误"实为 5 处编译错误 / 7 条运行时 TypeError | W8-A 文档 |
| 4 | 3 条对照用例不纯，标"防止矫枉过正"却在修复前也失败（§四） | W8-A 文档 |
| 5 | `result_W8-A.md` §2 表头"共 6 个文件"，表内 7 行 | W8-A 文档 |
| 6 | destroy 后 `addOwned` 静默失效（§7.2） | W8-A（随 A9） |

---

## 九、附：本版验收的实测输出（`main` @ 终审后）

```
$ bash build.sh                    TSC OK（228 个 .js）
$ node .build/tests/run.js         通过 4,653 项，失败 0 项   ← 终审 §4.1 注册 16 套件后的口径
$ runPhase10W8ATests()             通过 42 项，失败 0 项
$ runPhase10W8BTests()             通过 50 项，失败 0 项

$ node scripts/check-deps.js            全部通过 ✓（终审 §4.2 统一 --fix 后归零）
$ node scripts/check-links.js           [OK] 42 条，断链 0 处（扫描 193 个 .md）
$ python3 scripts/scan-dt-guard.py      命中 0 处 ✓
$ python3 scripts/scan-num-guard.py     命中 0 处 ✓
$ python3 scripts/check-random-source.py [OK] ✓
$ python3 scripts/check-dup-exports.py   [OK] ✓
```

**回退实验**（`fbd27f60` 三单元 + W8-A 新测试）：`tsc` 5 处报错，`runPhase10W8ATests()` → **20 通过 / 22 失败**。

---

## 十、复核方式（可复现）

```bash
# 1. 取 W8-A 开工基线（首个修复提交的父提交）
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/adwlachowicz684-star/AI-cocos-/commits/bf7072a6" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['parents'][0]['sha'])"
# → fbd27f60d92c39a8dad3e4ec21f71a3c0807e40a

# 2. 三单元换成基线 + 保留新测试 → 通过 20 / 失败 22 + 5 处 TSC 报错
# 3. AQ6 空态：new AutoQuality({tiers}).medianFps 应为 60（而非 0）
# 4. Lo8 轮次：add 之后连抽 3 次，去重数量应为 3
```

---

## 验收人签字

`W8-B` / 五条硬标准逐条独立验证（回退实验 + 只读复现）/ 结论：**通过**

- **A3 已闭环**：第 2 版已完成"重写为逐条验收"，本版为收口版
- 不阻塞：§八 6 条小问题
- **提请回看**：§7.1（C9 与任务书明文冲突，建议改裁）、§7.2（C10 副作用，随 A9 处理）
- 自我更正：§3.1（失败条数口径）、§6.4（Lo8 归因）、§5.2（AQ6 建议错误，已于第 2 版更正）
