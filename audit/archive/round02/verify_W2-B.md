# 验收报告 · W2-B 验收 W2-A

> 验收对象：`W2-A`（19 条：P1 14 / P2 5，单元 `attribute` `command` `diagpack` `indicator`
> `logger` `pathfinding` `runscope` `scheduling` `skill-caster` `social`）
> 依据：`audit/review_B.md` 五条硬标准
> 验收人：窗口 **W2-B**
> 核实基准：远程 `main` @ `5e55ba01`（含 W5-B / W6-A / W7-A 等最新改动）
> 回退实验基准：`8521b0cc`（W2-A 开工前的 main，即"修复前"）

---

## 结论

**通过。**

19 条全部有交付物、全部经我独立复现、五条硬标准逐条有依据。
本轮不是"看一遍觉得对"：我把对方 62 条核心断言搬到修复前基线 `8521b0cc` 上重跑，
**48 条在修复前失败**——这是"标准 2 · 测试真的会失败"的硬证据，不是读代码推断。

同时标出 **1 条测试无效（需补强，已给出并验证过有效的替代断言）** 与 **4 项建议**，
均不改变结论；另有 2 项沿用 W2-A 自己提出的、需总审裁决的既有事项。

### 交付物齐备性

| 交付物 | 状态 |
|---|---|
| `audit/result_W2-A.md` | ✅ 存在（326 行，含推送后复核 §8、全库发现 §9、自证 §10） |
| `tests/run_phase10_w2a.ts` | ✅ 存在（948 行，独立运行 **80 项全绿**） |

> 上一版 `verify_W2-B.md` 写的是"对方尚未交付、无法验收"。
> 那是我在旧快照上得出的结论——**已在本次全部推翻并重做**。
> 教训与 W2-A §7 记载的相同：判断远端状态必须实时查远端。

### 一句话总评

W2-A 这一批的质量高于五条标准的要求线：**它在报告 §10 主动做了"把验收别人的尺子量回自己"的
源码回退实验，并列出 5 条自己拿不出"修复前会红"用例的条目**。
自曝短板比自证清白更难，这一节是本批最值得其它窗口抄的部分。

---

## 1. 我的验证方法（先说方法，再说结论）

### 1.1 双副本独立复现（不是复用对方的 `.build/`）

```
副本 A = 远程 main 最新快照（修复后）      → 构建 → 跑 W2-A 套件、全量回归、6 个校验脚本
副本 B = 8521b0cc（W2-A 开工前，修复前）   → 构建 → 跑同一批评测脚本取"修复前"真实输出
```

两个副本各自完整 `bash build.sh`，**没有**用"改回旧代码再 build"的方式——
`review_B.md` §2 标准 2 明确警告过：`build.sh` 整体替换 `.build/`，
已真实发生过一次把 P0-3 修复误删的事故。

复现脚本只调公开 API、只读、不改动任何源码（遵守"验收方不直接改对方代码"）。

### 1.2 标准 2 的判据：把断言搬回基线

对每条修复，我从 `run_phase10_w2a.ts` 里抽出核心断言，在**副本 B**上执行：

- **FAIL** = 修复前不成立 → 这条用例真的会失败 → 标准 2 通过
- **PASS** = 修复前就成立 → 该断言不具区分力 → 需要给出解释或补强

共 **63 条**，结果 **48 FAIL / 15 PASS**。15 条 PASS 的逐条交代见 §3。

---

## 2. 逐条验收（19 条 × 五条硬标准）

图例：✅ 通过 · ⚠️ 有问题 · ➖ 不适用（该条性质上不改变运行期行为）

| 条目 | 标准1<br>复现 | 标准2<br>测试有效 | 标准3<br>对照用例 | 标准4<br>无顺手重构 | 标准5<br>未误判设计 | 备注 |
|---|---|---|---|---|---|---|
| **P1-1** attribute `clearModifiers` 不通知 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：add→1 次，clear 后**仍 1 次**。A1/A2/A3 三条断言基线全 FAIL |
| **P1-2** attribute `override` 死三元 | ✅ | ➖ | ✅ | ✅ | ✅ | **行为不变的澄清性修复**（见 §3.1） |
| **P1-3** command `rollback` 空 catch | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：`lastRollbackErrors` = undefined，回滚期 `console.error` 调用 **0 次** |
| **P1-4** diagpack 共享引用误判 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：`{"a":{"hp":100},"b":"[Circular]"}` |
| **P1-5** diagpack 脱敏破坏 JSON | ✅ | ✅ | ✅ | ⚠️ | ✅ | 复现：多一个 `}`、`JSON.parse` 失败；改动面偏大，见 §4.1 |
| **P1-6** indicator 两 API 中心不一致 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：`compute.x=6` vs `centerFor.x=3`，差 `length/2` |
| **P1-7** logger Silent 空 if 块 | ✅ | ✅ | ✅ | ✅ | ✅ | **标准 5 关键条目**，见 §3.2 |
| **P1-8** pathfinding 起点不校验 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：起点在墙里仍返回**长度 5** 的路径 |
| **P1-9** runscope 原型链键 | ✅ | ⚠️ | ✅ | ✅ | ✅ | 复现：`scopeOf('toString')` = **undefined**；两条断言无区分力，见 §3.3 |
| **P1-10** runscope `getOr` 吞越界 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：`getOr` 返回 0 而 `get` 抛「在局外读取局内数据」 |
| **P1-11** scheduling `elapsed` 恒 0 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：任务内 `ctx.elapsed` = **0** |
| **P1-12** skill-caster 充能残留 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：reset 后仍 0，再施放 → **-1** |
| **P1-13** social `byReason` 残缺 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：`byReason={cheating:1}`，`afk+1` = **NaN** |
| **P1-14** social 阈值未收口 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：`abuseThreshold:NaN`→恒 false；`-1`→**对所有人 true** |
| **P2-di** diagpack Di3/Di4/Di5/Di6 | ✅ | ⚠️ | ✅ | ✅ | ✅ | D8 一条无区分力，见 §3.4；其余 3 项子断言基线全 FAIL |
| **P2-in** indicator `ring.innerRadius` | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：结果里 `'innerRadius' in r` = **false** |
| **P2-lo** logger L2/L3/L4 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：重复取消后 sink **0 次**（期望 1）、destroy 后旧配置仍生效 |
| **P2-ru** runscope Ru3/Ru4/Ru5/Ru6 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：导入 `gold:NaN` 后 `get` = **NaN**；`add(NaN)` 不报错 |
| **P2-sc** scheduling Sch2–Sch7 | ✅ | ✅ | ✅ | ✅ | ✅ | 复现：`hardLimitMs=0` 不报错、`NaN` 时值为 undefined、`onError` 不存在 |

**19 条全部"已处理"，无一条漏项，无一条判为"不成立"。**

---

## 3. 15 条"基线 PASS"断言的逐条交代（标准 2 的诚实账）

这 15 条在修复前就通过，按 `review_B.md` 标准 2 的口径需要交代清楚。
我逐条归类，**没有一条是蒙混过关**：

### 3.1 8 条是对照用例——本来就应 PASS ✅

`A4-ctrl` `D9-ctrl` `I4-ctrl` `I5-ctrl` `L2-ctrl` `P3-ctrl` `R8-ctrl` `S6-ctrl`

这 8 条正是标准 3 要求的"正常输入不受影响"用例。
它们在基线上 PASS 恰恰证明**对方的收口没有把合法输入一起拦掉**
（例如 `hardLimitMs:1` 仍能中断本帧、`add('gold',-3)` 仍可用、
`maxSectionChars:10` 仍会截断）。**是加分项，不是缺陷。**

### 3.2 P1-2 `override` 死三元：行为不变，无需"会红"的用例 ➖

`A5` 在基线上 PASS（=150）。原因不是用例偷懒，是**这条修复本就不改变运行期行为**：

原代码 `v = overridden ? v + add : v + add` 两分支完全相同，
删掉死变量后结果恒为 150，与修复前一致。
想让测试变红，必须改成"override 定终值"（=100）——
但那会推翻 README 第 27 行已论证的公式：

```
base' = 最后一个 override?.value ?? base
v     = base' + Σadd        ← add 在 override 之后仍然叠加
v     = v × (1 + Σmul)
```

**我核实过 README 第 24–29 行，与 W2-A 选择的"保留语义、只删死代码"完全一致。**
为了凑一条会红的用例去改语义，才是真正的矫枉过正（标准 5 的反面）。
W2-A 在 §10.3 主动列出了这一条——**判定正确**。

### 3.3 P1-9 的两条"现状上锁"断言 ⚠️（建议项，不影响结论）

`R1`（`has('toString') = false`）与 `R2`（`get('toString')` 抛错）在基线上都 PASS。

**这不是 W2-A 的问题，是任务书描述过时**：`handoff_W2-A.md` 写的是
「`has('toString') = true`（原型链命中，应为 false）」，
但我实测基线 `8521b0cc` 上 **`has('toString')` 已经是 `false`**，
`get('toString')` 也已经抛错（只是错误信息是
`Cannot read properties of undefined (reading 'get')`，指不到根因）。

W2-A 在 `result_W2-A.md` §2 P1-9 一行里如实写的是
「`has('toString')` = false；`get` 抛 `Cannot read...`；`scopeOf` = **undefined**」——
**它没有照抄任务书的 "has = true"，这点很诚实。**

真正有区分力的是 `R3`（`scopeOf('toString')` 从 `undefined` → `null`，基线 FAIL）
和 `_defFor()` 统一查表入口（把"指不到根因"的崩溃换成"未声明键"的统一口径）。

**建议**：给 P1-9 补一条断言 `get('toString')` 的**错误信息内容**，
而不只是"抛错"——这样才锁得住"根因可读"这一半修复。
属于锦上添花，不返工。

### 3.4 P2-di 的 D8：这一条确实无区分力 ⚠️（**需补强**）

**这是本轮唯一一条我认为必须改的用例。**

```ts
// tests/run_phase10_w2a.ts:319
test('⚠️ NaN 配额不应让截断失效（修复后回落到默认值）', () => {
  const c = new DiagCollector({ appId: 't', version: '1', maxSectionChars: NaN });
  c.section('s', () => ({ big: 'x'.repeat(50) }));
  assert(r.sections[0].chars > 0, 'NaN 应回落到默认配额，而不是永不截断');  // ← 断言太弱
});
```

**问题**：`chars > 0` 在修复前后都成立，测的是"内容没被清空"，
而这条用例的标题说的是"**不该永不截断**"——**断言与意图不匹配**。

实测（副本 B，修复前）：`maxSectionChars=NaN` + 50 字符 → `chars=60, truncated=false`。
修复后同样喂 50 字符 → 也不截断（默认配额 20000）。**两者都 PASS，用例等于没写。**

**我验证过有效的替代断言**（喂超长内容，直接看截断）：

```
输入：maxSectionChars: NaN + 'x'.repeat(30000)
修复前：truncated = false   （NaN 让配额彻底失效）
修复后：truncated = true, chars = 20012   （回落到默认 20000）
```

只需把断言从 `chars > 0` 改成"喂 30000 字符后 `truncated === true`"，
**这条用例立刻具备区分力**。建议 W2-A 顺手改掉。

### 3.5 4 条是性能组/重复覆盖（行为不变，符合预期）✅

| 断言 | 说明 |
|---|---|
| `P2` 起终点都在墙里 | 基线上终点在墙里**已经** return null，这条覆盖的是终点逻辑，与起点无关。有 P1（起点在墙里，基线 FAIL）兜底，重复覆盖无害 |
| `S9` flush 50 个任务 | Sch6 是 O(n²)→O(n) 的**性能**修复，行为本就不变。W2-A §10.3 已主动坦白这条拿不出"会红"的用例 |
| `S10` 批量注册保持优先级 | Sch5 同理（二分插入替代全量 sort，顺序不变）。这条是**防矫枉过正**的上锁用例——正因为改了插入方式，才更该锁住顺序 |

`S9`/`S10` 的性质与 §3.2 相同：**性能修复无外部可观测行为**。
W2-A 在 §10.3 列出了 Sch4/Sch5/Sch6 三条（外加 P1-2、Ru5 共 5 条）并说明
"是 5 条，其中 Sch4/Sch5/Sch6 同属 scheduling 性能组"，还主动提出
"如果总审认为现状上锁不达标，可以补性能护栏"。**我认为现状上锁是正确的处理，
但按任务书 §8，判定权在总审**，在此转呈。

---

## 4. 标准 4 · 有没有顺手重构

### 4.1 改动范围核对 ✅（仅 1 处需说明）

从提交 `ef2d2649` 的文件清单核对：

```
修改  attribute/AttributeSet.ts   command/CommandStack.ts   diagpack/DiagPack.ts
      indicator/SkillIndicator.ts logger/Assert.ts          logger/Logger.ts
      pathfinding/GridGraph.ts    runscope/ScopedStore.ts   scheduling/FrameScheduler.ts
      skill-caster/SkillCaster.ts social/Report.ts
新增  tests/run_phase10_w2a.ts    audit/result_W2-A.md
附带  _kitmeta.json（依赖登记，见 §6.2）
```

**✅ 未改 `tests/run.ts`**（任务书 5.2、台账"总审合并注意点 1"明令禁止）
——我实测 `grep run_phase10_w2a tests/run.ts` 无命中，W2-A 报告 §5 也自陈"误改过已 checkout 回退"。
**✅ 未改 `README.md`**（测试总数由总审统一更新）。
**✅ 未碰 `_core/`**。

### 4.2 ⚠️ 唯一值得讨论的一处：`diagpack` 的脱敏重写（+288 / −43）

`P1-5` 的任务书建议是「脱敏改在**结构化数据上**做（在 `walk` 里按 key 匹配替换值），
不要对 JSON 字符串做正则」。

**W2-A 没有照做**，它选了另一条路：保留"对 JSON 字符串操作"的架构，
但把"值"这一段从**正则匹配**换成**字符扫描**（新增 `skipJsonValue` / `isJsonWs` /
`replaceKeysByPattern`），并修正 key 的正则（`"[^":]*"` 替代 `"[^"]*"`，
避免 key 跨过冒号逗号一路吃下去）。

**我的判定：这不是顺手重构，是合理的路径选择。**

- 结果达标：`redact('{"password": {"a":1},"nested":1}')` 修复后 `JSON.parse` 成功、
  `nested` 保住 1（我实测确认）；数组值同样修好。
- 改动有边界：只重写了 `redact` 的值定位部分，没有动 `safeStringify` 之外的其它结构。
- **改动大的原因不是"顺手"，而是原方案错了**——正则无法确定嵌套值的边界，
  这是必须换实现的硬约束。

**但我提示一个真实风险**：这条路比"结构化脱敏"更依赖手写扫描器的正确性。
`skipJsonValue` 要正确处理字符串内的转义引号、嵌套 `{}`/`[]`、数字/字面量。
我抽查了对象值与数组值两类（修复后均正确），
**建议 W2-A 补 2 条边界用例**（键名含引号的转义、值里嵌套多层），
把这个新扫描器的边界锁住。不返工，但值得补。

### 4.3 一个被我重点怀疑、最后判定为正确的点

`indicator` 新增了 `_extendsFromCaster()` 私有方法，并让 `_finish()` 里
落点校验的坐标从 `cx,cy` 改成 `shapeCx,shapeCy`。
**这看起来像"顺手改了不该改的地方"**（标准 4 的典型形态）。

我核对后的结论是**必须改、且改对了**：中心从 6 变成 3 之后，
`_placement.isValid()` 如果还拿旧坐标校验，就会出现"形状画在 A、合法性判在 B"。
中心变了，落点校验自然要跟着变——这是修复的组成部分，不是超范围。

另外我验证了 `_extendsFromCaster()` 只覆盖 `line`/`direction`，
**与 `centerFor()` 内部的判据完全一致**（`centerFor` 对其它类型直接返回 `casterX/casterY`），
没有"加了新类型只改一边"的隐患。

---

## 5. 标准 5 · 有没有把"设计如此"误判成 bug

这是本项目最易复发的一类，我按 `review_B.md` §2 标准 5 逐个查了原代码的注释与 README。
**四条高风险条目，W2-A 全部判断正确。**

| 条目 | 原代码有注释论证吗 | W2-A 的处理 | 我的核实 |
|---|---|---|---|
| **logger** Silent 仍写缓冲 | 有。`logger/README.md` 第 155 行：「低于级别的日志**仍然进缓冲**——这是刻意的：崩溃时要能导出崩溃前的 Trace 级日志」 | 判定为**刻意设计**，不补 `return`；消除空块 + 新增 `bufferWhileSilent` 开关（默认 true） | ✅ **正确**。我逐字核对了 README 145–155 行。任务书推测"明显是漏写 return"——**这个推测是错的**，W2-A 没有盲从 |
| **attribute** override 语义 | 有。`attribute/README.md` 第 27 行公式 | 保留"override 后仍叠加 add"，只删死三元 | ✅ **正确**，见 §3.2 |
| **indicator** 以哪个中心为准 | 有。`indicator/README.md` 第 40 行：「形状中心应在前方半个长度处，用 `centerFor` 算」 | 统一到 `centerFor`，`compute` 复用它 | ✅ **正确**。我核对了 README 36–42 行 |
| **runscope** `getOr` 吞异常 | 有。`runscope/README.md` 第 75 行把 `getOr` 列为「不抛错」的三个逃生舱之一；`tests/run_batch11.ts` 也断言了这点 | **默认保持兼容**，新增 `{swallowCrossScope:false}` 显式开关，并把"是否翻转默认值"上报总审 | ✅ **正确**。翻转是 breaking change，会同时动到既有测试与 README，超出"修这一条"的范围。按任务书 §8，不自己拍板是对的 |

**额外确认**：W2-A 在 `result_W2-A.md` §1 里专门写了一段
"任务书推测是漏写 return，但 README 说这是刻意的，我实测了两个方向"——
这是 `handoff_W2-A.md` §1.2「注释主动论证设计如此时要格外警惕」的正确用法：
**警惕不等于推翻，是要求拿证据。它两个方向都测了。**

---

## 6. 附：全库校验结果（远程 main @ `5e55ba01` 干净快照）

### 6.1 构建与回归

```
$ bash build.sh
TSC OK（产物校验通过：227 个 .js）

$ node .build/tests/run.js
通过 3696 项，失败 1 项

$ node -e "...runPhase10W2ATests()"     # W2-A 套件独立运行
通过 80 项，失败 0 项
全部通过 ✓
```

**那 1 项失败与本窗口无关** —— 我做了独立鉴定：

```
失败项：第九批 › BinarySerializer › ⚠️ float 会 clamp 而不是溢出回绕
       [Binary] float 越界：999（范围 -10..10）

在副本 B（8521b0cc，W2-A 开工前）上重跑全量回归：
通过 3696 项，失败 1 项   ← 完全相同的同一条
```

**基线未修时这条就已经是红的**，数字与失败项一字不差 → 排除 W2-A 责任。
根因与 W2-A §9.1 的鉴定一致：`binary` 属 **W8-B** 单元，
其 `result_W8-B.md` P1-5 把 float 越界从"静默 clamp"改成"默认抛错"，
但漏改了 `tests/run_batch10.ts` 里依赖旧 clamp 行为的既有测试。
**建议由 W8-B 对齐该旧测试**（我不代改——`binary` 与 `batch10` 都不在我窗口内）。

> W2-A 用的鉴定方法（下载未改动的纯净远端副本单独构建跑测）与我用的（修复前基线快照）
> 殊途同归，结论一致。

### 6.2 六个校验脚本

| 脚本 | 结果 |
|---|---|
| `node scripts/check-deps.js` | **1 项待处理** ⚠️（见下） |
| `node scripts/check-links.js` | [OK] 内部链接 42 条，**断链 0 处**（扫描 191 个 .md） ✓ |
| `python3 scripts/scan-dt-guard.py` | 扫描 146 个文件，命中 **0 处** ✓ |
| `python3 scripts/scan-num-guard.py` | 命中 **0 处** ✓ |
| `python3 scripts/check-random-source.py` | [OK] 未发现自建随机源 ✓ |
| `python3 scripts/check-dup-exports.py` | [OK] 无待处理冲突 ✓ |

**`check-deps.js` 那 1 项**是 8 条未登记依赖：

```
i18n / blessing / curse / rarity / achievement / rebind / gameflow / accessibility → _core
```

**全部属于其它窗口**（W2-A 的 10 个单元一个都不在其中，
`diagpack → _core` 已由 W2-A 自己登记到位）。
按"验收方不直接改对方代码"，我不代劳。

> 我完全同意 W2-A §9.2 与 `verify_W2-B.md` 上一版的共同观察：
> **`_kitmeta.json` 是 16 个窗口共写的单点文件，并发推送必然互相覆盖**，
> 已实际发生至少三次（W2-B 的 `curse`、W2-A 的 `turn`、以及本次的 8 条）。
> 建议总审在合并阶段统一跑一次 `node scripts/check-deps.js --fix`，
> 而不是要求各窗口各自保证——**并发下各自保证做不到**。

---

## 7. 给 W2-A 的建议（按优先级，均不返工）

| # | 优先级 | 内容 |
|---|---|---|
| 1 | **建议改** | §3.4：`run_phase10_w2a.ts:319` 的 D8 断言从 `chars > 0` 改为"喂 30000 字符后 `truncated === true`"。我已验证改后基线上会 FAIL，具备区分力 |
| 2 | 建议补 | §4.2：`skipJsonValue` 是全新手写扫描器，补 2 条边界用例（转义引号、多层嵌套值） |
| 3 | 建议补 | §3.3：P1-9 的断言锁住 `get('toString')` 的**错误信息内容**，而不仅是"抛错" |
| 4 | 可选 | §8 的新发现：`centerFor` 对非 `line`/`direction` 类型"原样返回传入坐标"，这个语义 README 未说明 |

---

## 8. 我在验收中的额外发现（不属于 W2-A，供总审参考）

### 8.1 任务书与实测不符一处（P1-9）

`handoff_W2-A.md` P1-9 写「`has('toString')` = **true**（原型链命中，应为 false）」，
实测基线 `8521b0cc` 上**已经是 `false`**。
即 `has()` 那一半在此前某个提交中已被修好，任务书描述的是更早的版本。

W2-A 没有被这份过时的证据带偏（它报告里写的是实测值 `false`），
**但其它窗口若照抄任务书，可能会去"修"一个已经不存在的 bug。**
建议总审留意：任务书里的"证据"也会被时间追上，复现仍然必需。

### 8.2 `indicator.centerFor` 对非 line/direction 类型的语义未文档化

我实测了 6 种（+2 种别名）类型在**修复后**的一致性：

| 类型 | `compute()` 中心 | `centerFor()` | 一致？ |
|---|---|---|---|
| `line` | (3.00, 0) | (3.00, 0) | ✅ |
| `direction` | (3.00, 0) | (3.00, 0) | ✅ |
| `circle` / `sector` / `ring` / `point` / `cone` / `capsule` | (6.00, 0) = 落点 | (0.00, 0) = 传入的 caster 坐标 | — |

后 6 种**不是 bug**：它们的形状中心就是落点，调用方把落点传给 `centerFor` 即可；
`centerFor` 只在 `line`/`direction` 上做前移，对其它类型原样返回。

但"**非 line/direction 时 `centerFor` 等于传入坐标**"这件事 README 没写。
刚被 P1-6 修过的地方，最容易长出下一个同类误解。建议在 README 补一句。
（P2 级，且不在 W2-A 必须修的范围内。）

---

## 9. 转呈总审裁决（沿用 W2-A §3，我不代为拍板）

| # | 事项 | W2-A 的选择 | 我的意见 |
|---|---|---|---|
| 1 | `runscope.getOr` 越界时**默认值是否翻转**为抛错 | 默认保持兼容，严格化做成显式开关 | 同意当前处理。翻转是 breaking change，会同时动既有测试与 README |
| 2 | `logger.bufferWhileSilent` 默认 true 还是 false | 默认 true（保留崩溃现场），需要省分配时显式关 | 同意。README 已论证"保留崩溃现场"是 logger 存在的理由 |
| 3 | §3.5 中 5 条"现状上锁"用例是否达标 | 已主动列出并说明 | 认为达标；性能修复与类型层修复在运行期不可观测，强行造红用例反而是矫枉过正 |
| 4 | `_kitmeta.json` 并发覆盖 | — | 建议合并阶段统一 `--fix`（见 §6.2） |
| 5 | `binary` float 既有红灯 | — | 建议派给 W8-B 对齐 `run_batch10.ts`（见 §6.1） |

---

## 10. 本次验收的自证（把尺子量回自己）

我要求对方"每条断言都要在修复前失败"，自己同样接受这条尺子的检验：

| 自查项 | 结果 |
|---|---|
| 复现是否独立重跑 | ✅ 双副本各自完整构建，**未复用对方 `.build/`**，31 项检查全部取到真实输出 |
| 是否改了对方代码 | ✅ 无。所有脚本只读、只调公开 API，放在 `/tmp`（不在库内留 `verify/`） |
| 是否基于实时远端判断 | ✅ 基准为 `5e55ba01`；上一版"对方未交付"的误判已推翻 |
| "源码检视"类结论是否复核 | ✅ 凡标注"源码检视"的判断（如 §4.3 的 `_extendsFromCaster`）都回源码核对了对应实现，未凭印象下笔 |

> 上一版 `verify_W2-B.md` 我在 §"复现方法上的教训"里写过：
> 「凡是"源码检视"得出的"已修"结论，都应回看一眼再下笔。」
> 本轮我自己的规则是：**凡是"基线 PASS"的结论，必须能说出它是对照用例还是无效用例**
> ——15 条逐条归类见 §3，没有一条含混带过。
