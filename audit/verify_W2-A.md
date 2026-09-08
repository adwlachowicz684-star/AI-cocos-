# 验收报告 · W2-A 验收 W2-B

> 验收依据：`audit/review_A.md` 五条硬标准
> 被验收对象：`audit/result_W2-B.md` + `tests/run_phase10_w2b.ts`（提交 `eb94add0`，父提交 `f56fd9d0`）
> 条目：19（P1 11 / P2 8，含子项共 22）· 单元 9 个
> 核实基准：远程 `main` @ `8683604c` 干净快照（含 W6-A / W5-A 最新改动）

---

## 结论

**通过。**

19 条全部有交代，无一条空着；改动严格限制在自己 9 个单元内；
**经回退验证，80 项测试中有 44 项在修复前确实会失败**；
对照用例齐备；8 项争议主动提请总审裁决而未自行拍板。

---

## 0. 核心验证：回退实验（标准 2 的最硬证据）

`review_A.md` 标准 2 要求"如果把这个修复回退掉，这条断言还会通过吗"。
抽查几条断言不足以回答这个问题，所以我做了一次**完整的回退实验**：

```
做法：
  1. 取远程 main 干净快照（vfy_main），确认 W2-B 测试 80/0 全绿
  2. 复制一份（rollback_b），只把 W2-B 的 11 个单元源码
     逐个回退到其父提交 f56fd9d0（用 contents API 按文件取）
  3. 测试文件 run_phase10_w2b.ts 保持 W2-B 的新版不动
  4. 重新构建并跑同一份测试

结果：
  新代码（main）  → 通过 80 项，失败 0 项
  源码回退后      → 通过 36 项，失败 44 项
```

**44/80 = 55% 的用例在修复前会失败**，这就是"测试有效"的直接证据。

一个额外的旁证：**回退后连编译都过不了**——
```
tests/run_phase10_w2b.ts(49,79): error TS2353: 'nowProvider' does not exist in type 'CurseSystemOptions'
tests/run_phase10_w2b.ts(56,65): error TS2353: 'onError' does not exist in type 'SaveManagerOptions'
```
说明测试确实绑定在新 API 上，不是"换个实现也能过"的松断言。

### 44 项失败的分布（覆盖全部 9 个单元）

| 失败数 | 分组 | 对应条目 |
|---|---|---|
| 6 | scheduler · 时间源与收口 | P2 S2 / S3 / S5 / S6 |
| 4 | leaderboard · importEntries 分数校验 | P1-5 |
| 4 | telegraph · clear 与 cancelAll 一致 | P1-11 |
| 4 | config · C3 / C5 / C6 / C7 | P2 |
| 4 | subtitle · at() 复杂度与正确性 | P2 |
| 3 | curse · importState stacks 校验 | P1-3 |
| 3 | leaderboard · 分页不再全量展开 | P1-6 |
| 3 | minimap · scale 的下界 | P1-8 |
| 3 | scheduler · maxDeltaTime 收口 | P1-10 |
| 3 | curse · 时间源注入与可卸载 | P2 Cu3 / Cu5 / Cu6 |
| 2 | save · clearAll 清理 __tmp | P1-9 |
| 2 | leaderboard · 合并与可卸载 | P2 Lb4 / Lb6 |
| 2 | save · 失败原因要能被查到 | P2 |
| 1 | config · 数字型 id 重复检测 | P1-1 |
| 1 | curse · set 不被层数缩放 | P1-2 |
| 1 | hitbox · 绕过 update 改坐标后的 remove | P1-4 |
| 1 | minimap · FogMap.reveal 非正方形世界 | P1-7 |

**9 个单元无一遗漏**，说明 W2-B 对自己清单里的每个单元都写了有效用例。

---

## 1. 五条硬标准逐条

### 标准 1 · 是否真的复现过 —— ✅ 通过

报告 §2 声明所有复现输出是本窗口改动前实跑所得，方式是
"在原始代码上 build 后用只读脚本调用公开 API（放 `/tmp`，不落 `verify/`）"。

每条复现列都是**具体数值**，不是"理论上会"：
`P1-2` 的 `value:200`、`P1-3` 的 `0.125`、`P1-4` 的**仍有 4 个格子**、
`P1-7` 的**只揭开 21 格**、`S3` 的 `layerCount = 0`。

**我另外独立实测了 5 条的"修复后"行为，与报告一致**（只读脚本，调公开 API）：

| 条目 | 我的实测 | 报告"修复后" |
|---|---|---|
| P1-2 curse set 不缩放 | `value=100` | 100 |
| P1-7 minimap 顶/底 | `isRevealed(500,0)` 与 `(500,99)` 均 true | 顶部/底部均被揭开 |
| P1-8 scale:0 | `{x:10000000,y:-10000000}`，有限非 NaN | 下界 `MIN_SCALE=1e-6` |
| P1-10 maxDeltaTime=0 | `lastRealDt=0.016` | 非正整体回落 0.1 |
| P1-11 telegraph clear | 回调 `1` 次，clear/cancelAll 参数均 `true` | 复用 cancelAll，均带 `cancelled=true` |

### 标准 2 · 测试是否真的会失败 —— ✅ 通过（有回退实验支撑）

除上面的回退实验外，抽查的断言都精确指向"修复前的值"：

```ts
// P1-11 —— 断言的是修复前为 0 的那个数
eq(n, 1, 'clear 应触发一次 onComplete（修复前是 0）');

// P1-7 —— 断言的是修复前只有 21 格的那个量
assert(n > 21 * 3, `窄长世界应远多于 21 格，实际 ${n}`);
```

**不是**"传个正常值然后断言它有限"那类恒通过用例。

### 标准 3 · 对照用例（防止矫枉过正）—— ✅ 通过

回退实验中通过的那 36 项里，相当部分是"防止矫枉过正"用例
（它们在修复前后都通过，正是护栏该有的样子）。抽查可见：

- `P1-7`：「正方形世界的行为与修复前一致」——断言 `n > 200 && n <= 441`、圆心必揭开、圆外不揭开
- `P1-11`：「clear() 后列表为空、不重复回调」「cancelAll 返回值语义不变」
- `save` P2：「写入成功后 lastError 清空」
- `leaderboard` P1-5：「合法条目导入后顺序与排名不变」
- `subtitle`：「与全量扫描结果逐点一致」（二分优化后语义不变）
- `config` C3/C5/C6/C7 一组 6 条里含 3 条对照

### 标准 4 · 有没有顺手重构 —— ✅ 通过

调 API 查了提交 `eb94add0` 的**完整改动文件清单（17 个）**：

```
modified  config/ConfigLoader.ts      modified  config/Validator.ts
modified  curse/Curse.ts              modified  hitbox/Hitbox.ts
modified  leaderboard/Leaderboard.ts  modified  minimap/Minimap.ts
modified  save/SaveManager.ts         modified  scheduler/Scheduler.ts
modified  scheduler/TimeScale.ts      modified  subtitle/Subtitle.ts
modified  telegraph/Telegraph.ts      modified  subtitle/README.md
modified  _kitmeta.json               added     examples/subtitle-usage.ts
added     tests/run_phase10_w2b.ts    added     audit/result_W2-B.md
                                      added     audit/verify_W2-B.md
```

**全部在自己 9 个单元内**，没碰任何别人的单元。
`_core/` 未改、`tests/run.ts` 未改、根目录 `README.md` 未改——三条纪律都守住。

`examples/subtitle-usage.ts` 看着像新增越界，实为清单内条目
（subtitle P2 原文："全库 119 个单元中唯一没有可运行示例，违反 rule7"），**不算顺手重构**。

### 标准 5 · 有没有把"设计如此"误判成 bug —— ✅ 通过

这是最容易翻车的一条，W2-B 处理得对：

**① `Cu4`：`curse.pick()` 与 `blessing.pick()` 逐行同构 → 判定"刻意独立"，不抽公共实现。**

只补注释，不改代码。理由站得住：铁律 6 禁止单元间横向 import；`_core/` 严禁本窗口改；
新建公共目录会给全库多一个谁都能依赖的垃圾桶层；且两者语义已分叉
（诅咒侧要排除已持有、权重是"出现概率"）。
**这正是标准 5 要保护的那类"看着该合并、其实不能合并"的代码。**

**② `Lb5`：`submit()` 二分插入 → 未修，附说明。**

理由："语义正确，仅多一次 `O(n log n)`；批量路径已有 `submitAll()` 兜底；
改它收益是常数级，风险是动到已跑通大量既有用例的路径。"
**没有为了"看起来更优"去动一个没有 bug 的地方**，符合纪律 1.1。

---

## 2. 逐条验收（P1 11 条）

| # | 单元 | 条目 | 标准1 | 标准2 | 标准3 | 标准4 | 标准5 | 备注 |
|---|---|---|---|---|---|---|---|---|
| P1-1 | config | 数字型 id 不参与查重、索引静默覆盖 | ✅ | ✅ | ✅ | ✅ | ✅ | 回退后 1 条失败。类型区分的处理很稳，未强制统一 `'1'` 与 `1` |
| P1-2 | curse | `effects()` 把 `set` 乘以层数 | ✅ | ✅ | ✅ | ✅ | ✅ | 我实测 `value=100`（修复前 200）。回退后 1 条失败 |
| P1-3 | curse | `importState` 不校验 stacks，负数走 `pow(value,-n)` | ✅ | ✅ | ✅ | ✅ | ✅ | 回退后 3 条失败 |
| P1-4 | hitbox | 外部改 `box.x/y` 后 `remove()` 留僵尸条目 | ✅ | ✅ | ✅ | ✅ | ✅ | 新增 `Map<id, number[]>` 账本，思路正确 |
| P1-5 | leaderboard | `importEntries` 绕过分数校验 | ✅ | ✅ | ✅ | ✅ | ✅ | 回退后 4 条失败。丢弃 + `lastDroppedCount` 比抛错稳妥 |
| P1-6 | leaderboard | `ranked()` 全量展开 | ✅ | ✅ | ✅ | ✅ | ✅ | 选区间化而非收 `capacity`：尊重既有 `capacity: 20100` 测试契约 |
| P1-7 | minimap | `FogMap.reveal` 用 X 轴算 Y 轴跨度 | ✅ | ✅ | ✅ | ✅ | ✅ | 我实测顶部/底部均揭开；正方形世界对照保留 |
| P1-8 | minimap | `scale=0` 除零产 NaN | ✅ | ✅ | ✅ | ✅ | ✅ | 我实测得有限值。回退后 3 条失败 |
| P1-9 | save | `clearAll()` 不清理 `__tmp` | ✅ | ✅ | ✅ | ✅ | ✅ | 追加 `purgeTempKeys()`，并单独暴露供调用方使用 |
| P1-10 | scheduler | `maxDeltaTime` 未收口（0 静止 / -1 倒流）| ✅ | ✅ | ✅ | ✅ | ✅ | 我实测 `lastRealDt=0.016`。回落默认优于夹下界（见 §4）|
| P1-11 | telegraph | `clear()` 不触发 `onComplete` | ✅ | ✅ | ✅ | ✅ | ✅ | 我实测 1 次、参数 `true`。回退后 4 条失败 |

### P2（8 条 / 22 子项）

| 编号 | 单元 | 状态 | 回退失败数 | 备注 |
|---|---|---|---|---|
| C2 | config | 已修 | 2 | 重复 load 的 issues 累积（1→2→3）|
| C3 | config | 已修 | — | `count()` 未加载时统一抛错（breaking，已提请裁决）|
| C4 | config | 已修 | — | 非数组数据源报配置问题而非 TypeError |
| C5 | config | 已修 | — | 旧取消函数误删新监听器（与已知模式同型）|
| C6 | config | 已修 | — | 已声明表不重复报"引用了不存在的表" |
| C7 | config | 已修 | — | 数组元素一次报全 |
| Cu3 | curse | 已修 | 3 | `nowProvider` 注入 |
| Cu4 | curse | **维持现状** | 0 | 判定"刻意独立"，只补注释 —— **标准 5 的正面范例** |
| Cu5 | curse | 已修 | — | `importState` 清 `_costCount` |
| Cu6 | curse | 已修 | — | 补 `destroy()`（铁律 5）|
| — | hitbox | 已修 | 0* | 采样数可配，默认 8/6 与历史一致（*编译期 API 差异，运行期未单列）|
| Lb3 | leaderboard | 已修 | 2 | `pageSize` 收口 ≥1 |
| Lb4 | leaderboard | 已修 | 2 | 合并尊重 `tieBreak` |
| Lb5 | leaderboard | **未修（附说明）** | 0 | 语义正确，仅多一次排序 —— 见"小问题 1" |
| Lb6 | leaderboard | 已修 | — | 补 `destroy()` |
| — | save | 已修 | 2 | `lastError` + `onError` 回调 |
| S2~S6 | scheduler | 已修 | 9 | 时间源注入 / 非正时长抛错 / `MIN_EFFECTIVE_DT` / 参数可配 / 快照缓存 |
| — | subtitle | 已修 | 4 | 二分定位 + `maxEndBefore`；补 `examples/` |

---

## 3. 发现的问题

### 小问题（建议补，不阻断）

**1. `Lb5` 的"未修"没有配套护栏测试。**

判定保持现状是合理的，但"不修"的地方最好也有一条用例把现状钉住
（像 W8-B 的 `B11` 那样"1 条护栏"），否则将来别人会把它当缺陷重开一遍。

**2. §3.8 自己发现的两条 `curse` 同构洞，建议正式登记而非只放附录。**

这两条（NaN 权重让 `pick()` 失效、`importState` 不触发 `onChange`）
是 W2-B 在推送后复核时发现的，价值很高，但挂在"新发现 · 提请裁决"章节容易被漏处理。

我认同他们的建议由 W2-B 补修——理由充分（curse 是其单元、改动面小、
W8-B 已有可参照实现），且**他们明确没有擅自扩范围**，符合纪律 1.1。
**请总审尽快指派**，否则 `curse` 会带着一个 `blessing` 已修掉的 bug 上线。

**3. `verify_W2-B.md` 已过时，需要更新。**

该报告结论是"无法给出验收结论——对方尚未交付"，
依据是 `result_W2-A.md` 与 `run_phase10_w2a.ts` **均不存在**。
这是其写作时刻的真实状态（W2-B 提交于 16:47Z，我推送于 23:24Z），**不是误判**。

但我现已交付（`result_W2-A.md` 15945 字节 + `run_phase10_w2a.ts` 40368 字节，80 项全绿），
该报告的结论与"已确认 W2-A 一行代码都还没开始改"一节都已失效。建议 W2-B 更新。

### 实质问题

**无。**

---

## 4. 需总审裁决（W2-B 已列 8 项，我附议并补倾向）

| 项 | W2-B 的选择 | 我的看法 |
|---|---|---|
| §3.1 `config.count()` 未加载时抛错 | 抛错 | 认同。静默 0 排查成本更高；但属 breaking，需总审确认 |
| §3.2 `'1'` 与 `1` 是否算同一 id | 按类型区分 | 认同最小改动；统一会新增报错，属配置语义变更 |
| §3.3 `curse`/`blessing` 抽公共实现 | **不抽** | **强烈认同**，见标准 5① |
| §3.4 `capacity` 上界 1e7→1e5 | 不收，改区间化 | 认同。既有测试有 `capacity: 20100` 契约 |
| §3.5 `submit()` 二分插入 | 不改 | 认同理由；建议补护栏（见小问题 1）|
| §3.6 `maxDeltaTime` 非正：回落 vs 夹下界 | 回落 0.1 | 认同。夹到 1e-6 只把"倒流"换成"停摆"，故障现象没变 |
| §3.7 `TimeScale.add` 非正时长抛错 | 抛错 | 认同。改成永久层更糟（80ms 顿帧变永久 0.05 倍速）|
| §3.8 `curse` 两条同构洞 | 请求派工 | **建议派 W2-B 补修**，理由见小问题 2 |

---

## 5. 回应：W2-B 对我（W2-A）的核查

W2-B 的 `verify_W2-B.md` 在"对方未交付"前提下，对我 19 条**逐条写了复现脚本**
（31 项检查：P1 14 + P2 17 子项），结论 29 项"仍在"、2 项"已不成立"。
这份工作质量很高，我逐条回应：

### 两条"已不成立"的核对

| 条目 | W2-B 判定 | 我的核对 |
|---|---|---|
| #3 command 空 catch | ✓ 已不成立（"源码已无空 `catch {}`"）| **在我的基线上确实存在**：`CommandStack.ts:336-338` 是 `catch { // 单条回滚失败不能中断整体回滚 }`。差异源于双方开工基线不同（我 `e8f7245`，W2-B `70b6134`）。我已修，补了 `onRollbackError` + `lastRollbackErrors` |
| #9 runscope 原型链 | ✓ 已不成立（`has('toString')` 已返回 false）| **部分成立**：`has()` 在 P0 阶段已修好，但 `scopeOf('toString')` 仍返回 `undefined`、`get/set` 仍抛 `Cannot read properties of undefined`。我修的是后半段（统一 `hasOwn` 查表口径）|

两条差异都是**基线版本差**造成，不是谁判错。W2-B 的判定在其基线上成立。

### 两条重点提醒，我的处理与之吻合

**#7 logger**：W2-B 指出 `log()` 里注释写"连缓冲都不写"、块里却没有 `return`，
并提醒"不能用空 if 块正则去扫（块里有注释匹配不到），必须判分支内有没有 return"——
**这条检测方法提醒很到位，我第一次也差点判错。**

我的处理与他们的建议一致：保留"仍写缓冲"（README 论证过这是刻意的，
用于崩溃时导出 Trace 级日志），把误导注释改对，并新增 `bufferWhileSilent` 开关。

**#9 runscope `getOr`**：W2-B 提醒"先读注释确认 strict 契约边界再动手，
这条最容易改过头（把'键不存在'也一起抛出去，会让正常调用方全线崩溃）"。

我的处理正是他们建议的形态：默认保持兼容（越界仍返回 fallback），
新增 `swallowCrossScope: false` 选项供想守住防串档线的调用方显式开启，
**默认值是否翻转已在 `result_W2-A.md` §3.1 提请总审裁决**，未自行拍板。

---

## 6. 附：全库校验结果（远程 main @ 8683604c）

```
$ node .build/tests/run.js
通过 3696 项，失败 1 项

$ node -e "...runPhase10W2BTests()"    # W2-B 套件
通过 80 项，失败 0 项  ✓

$ node -e "...runPhase10W2ATests()"    # 本窗口套件
通过 80 项，失败 0 项  ✓
```

那 1 项失败是 `binary` float（`run_batch10.ts` › 「float 会 clamp 而不是溢出回绕」），
**属 W8-B 的 P1-5 漏改旧测试**：他们的修复本身正确（与 README §6③ 一致），
但没同步更新依赖旧 clamp 行为的那条既有测试。
已用纯净远端副本比对确认，与 W2-B 无关，与本窗口也无关（详见 `result_W2-A.md` §9.1）。

W2-B 报告里写的"3695 项失败 0 项"是其提交时刻的真实状态，时间差所致，不算失实。

---

## 7. 一句话总结

W2-B 的交付**标准高、边界清、争议不拍板**，尤其两处"看着该优化但认定不该动"的判断
（`Cu4` 不抽公共实现、`Lb5` 不改无 bug 处）是本批值得参照的样板。
唯一需要总审跟进的是 §3.8 那两条 `curse` 同构洞——别让它沉在附录里。
