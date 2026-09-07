# 验收报告 · W1-B 验收 W1-A

> 被验收窗口：`W1-A`（单元 `builder` `craft` `crash` `cutscene` `debug-console` `gesture` `matchops` `skill-variant`，20 条：P1 17 / P2 3）
> 验收人：窗口 `W1-B`
> 验收时间：本次推送时点的 main 分支快照

---

## 结论

**无法验收（被验收方交付物缺失）** —— 不是"不通过"。

`review_B.md` 要求验收的**两份交付物在仓库中都不存在**：

| 应产出 | 实际 |
|---|---|
| `audit/result_W1-A.md` | ❌ 不存在（`audit/` 下无任何 `result_*` 文件） |
| `tests/run_phase10_w1a.ts` | ❌ 不存在（`tests/` 下无任何 `w1a` 文件） |

因此五条硬标准（复现、测试有效、对照用例、无顺手重构、未误判设计）
**一条都无法按流程执行**——它们全都建立在"有一份对方的报告和测试可读"这个前提上。

我没有据此判"不通过"，因为 16 个窗口并行、各自推送，交付物未到齐是**正常的时序问题**，
不是 W1-A 的质量问题。**待 W1-A 推送后，本次验收需要重做。**

---

## 我做了什么替代工作

为了让这次验收不空手而归，我按 `review_B.md` 第 2 节的"⚠️ 不要用改回旧代码的方式验证，
写独立只读脚本调用公开 API"这一条，对 W1-A 的 20 条做了**当前基线的独立现状核查**。

这份核查的价值在于：

1. 告诉 W1-A 窗口**哪些条目的现象确实还在**（可以直接拿去做复现输出，省一遍功夫）；
2. 告诉总审**哪些条目的描述已经和当前代码不符**（需要重新确认，避免 W1-A 白修一条不存在的 bug）；
3. 顺带发现了一个**校验脚本的覆盖缺口**（影响全库，见文末）。

⚠️ 以下判断**只针对"当前基线"**，不构成对 W1-A 交付物的验收结论。

---

## 逐条现状核查

标注说明：`实测` = 我跑了独立只读脚本的真实输出；`代码检视` = grep + 源码阅读；`—` = 未能独立确认。

| # | 单元 | 条目 | 判断依据 | 基线现状 |
|---|---|---|---|---|
| 1 | builder | `PlaceResult.missing` 声明但从未被填充 | 代码检视 | **现象存在**：`:133` 声明字段，`:356-359` 只做 `requires.filter(...)` 得到局部数组并返回 `error:'missing-requirement'`，全文未见 `missing:` 赋值 |
| 2 | builder | `rotateCell` 对非法角度静默返回原值 | 实测 | **现象存在**：`rotateCell(c,1)` / `(c,99)` / `(c,NaN)` 三次调用返回值完全相同 `{"x":1,"y":2,"rot":0,"level":1}` —— 合法旋转也没生效，需 W1-A 确认 `rot` 的预期语义 |
| 3 | craft | `totalMaterials` 忽略子配方产出倍率 | — | 待 W1-A 交付（`:246` 声明、`:275` 递归，未独立复现） |
| 4 | craft | 副产物被背包丢弃时静默消失 | — | 待 W1-A 交付 |
| 5 | craft | 全部 `consume:false` 时 `canCraft` ok:true / maxCount:0 | — | 待 W1-A 交付 |
| 6 | crash | `_seen` 只增不减，`dedupeWindow` 过期后不清理 | 代码检视 | **现象存在**：`:177` 声明，`:303`/`:308` 只 `set`，全文件唯一的清理是 `:453` 的 `_seen.clear()`（reset 路径），未见按 `lastSent` 过期淘汰 |
| 7 | crash | 采样用裸 `Math.random` | 实测 + 代码检视 | **现象存在**：`:312` `if (Math.random() > this._sampleRate) return false;` —— 不可复现、不可注入。**附带发现：见文末** |
| 8 | cutscene | `Timeline.with()` 与 README 不符 | — | 待 W1-A 交付 |
| 9 | cutscene | `update(dtMs)` 无 dt 守卫 | 实测 | **现象部分成立**：`update(100)` → `time=100`；`update(NaN)` → `time` 仍 `100`；`update(-50)` → `time` 仍 `100`。即**非法 dt 被静默丢弃**（符合报告描述），但**没有污染 `_time`**（`Number.isFinite` 为 true）。修的时候请注意别把"丢弃"改成"放行" |
| 10 | debug-console | `execute()` 把命令内部异常 rethrow | 代码检视 | **现象存在**：`:399` 裸 `throw e;` |
| 11 | debug-console | `_coerce` 的 `int` 把空串/空白当成 0 | — | 待 W1-A 交付 |
| 12 | gesture | `maxPoints` 裁剪丢弃轨迹起点 | 代码检视 | **现象存在**：`:357-358` `this._pts.shift()` —— 丢弃的是**头部**（起点），报告描述准确 |
| 13 | matchops | `graceMs`/`graceDecay` 为 NaN 时宽限期永不过期 | 实测 | **现象存在且严重**：`graceMs:NaN` 时 `graceFor(p1)=NaN`、`remainingMs(p1,0)=NaN`，推进 100 秒后 `remainingMs(p1,100000)` **仍是 NaN**、`stateOf` 停在 `'disconnected'`；对照组 `graceMs:5000` 同样推进后 `remainingMs=0`。NaN 参与 `<= 0` 比较恒 false → 永不过期，报告描述准确 |
| 14 | matchops | `Surrender.vote` 对掉线玩家返回 ok:true 但票不计入 | — | 待 W1-A 交付 |
| 15 | skill-variant | `applyPatch` 的 switch 无 default，未知 op 静默无操作 | 实测 | **现象存在**：`applyPatch({speed:10}, {op:'no_such_op', path:'speed', value:999})` 不抛错，`speed` 仍为 10 |
| 16 | skill-variant | 数值 op 未校验，`mul: NaN` 污染技能数据 | 实测 | ⚠️ **与报告描述不符**：`applyPatch({speed:10},{op:'mul',path:'speed',value:NaN})` **抛错** `mul 要求 value 是有限数字…`。`:521` 的 `assertOperand` 已在 `add`/`mul`/`max`/`min` 四个分支前全部调用（`:454/460/466/472`）。建议 W1-A 先重新确认这条是否已失效，避免"修一条不存在的 bug" |
| 17 | skill-variant | 互斥检查只处理第一个冲突者 | — | 待 W1-A 交付 |
| 18 | cutscene | `update` 的 `guard < 64` 是魔法数（P2） | — | 待 W1-A 交付 |
| 19 | debug-console | `_history` 的去重只看上一条（P2） | — | 待 W1-A 交付 |
| 20 | debug-console | `list()` 每次 sort、`_resolve` 无 alias 索引（P2） | — | 待 W1-A 交付 |

**已独立确认现象存在的：9 条（#1 #2 #6 #7 #9 #10 #12 #13 #15，其中 #9 部分成立）**
**与报告描述不符、需重新确认的：1 条（#16）**
**未能独立确认的：9 条**

---

## 给 W1-A 窗口的两点提醒

1. **#16（skill-variant 数值 op）请先复现再动手。**
   我看到的是"已经会抛错"。如果 W1-A 也复现出抛错，这条应标"不成立"并贴出实测输出，
   而不是照着原报告加一道重复校验——加重复校验属于"顺手改了没必要改的地方"（标准 4）。

2. **#2（builder rotateCell）的现象比报告描述的更宽。**
   我实测连**合法**的 `rotateCell(c, 1)` 返回值的 `rot` 也是 0。
   请在复现时确认 `rot` 字段的预期语义再定修法，
   否则很可能把"本就返回新对象、rot 由调用方填"的设计当成 bug（标准 5 的误判风险）。

---

## 附带上报：`check-random-source.py` 有覆盖缺口（影响全库）

核查 #7 时发现：`crash/CrashReporter.ts:312` 是裸 `Math.random()`，
但 `python3 scripts/check-random-source.py` 报 **[OK] 未发现自建随机源**。

即这条形态的裸 `Math.random` **没被扫描到**。我这次提交的 6 项校验里这一项是"通过"的，
但它是**假通过**——说明扫描脚本的匹配形态有缺口（可能是只扫了 `Math.random()` 直接赋值
或 `new Random(...)` 之类，漏掉了"比较表达式里直接调用"的形态）。

**建议总审单独派一票修扫描脚本**，否则这个缺口会让后续所有窗口的随机源校验都形同虚设。
（按并行纪律我没有改 `scripts/`，它不在我单元的清单里。）

---

## 待办

- [ ] W1-A 推送 `result_W1-A.md` + `tests/run_phase10_w1a.ts` 后，**重做本次验收**（五条硬标准逐条给判断）
- [ ] 总审确认 #16 是否从清单中移除
- [ ] 总审派票修 `scripts/check-random-source.py` 的覆盖缺口
