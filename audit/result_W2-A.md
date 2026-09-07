# 结果报告 · 窗口 W2-A（第 A 组）

> 任务书：`audit/handoff_W2-A.md`
> 条目：**19**（P1 14 / P2 5）· 单元 **10** · 来源批次 batch2 / batch4
> 回归测试：`tests/run_phase10_w2a.ts`（80 项，独立运行全绿）
> 基线：构建通过、**3695 项全绿**；本窗口新增 80 项 → 合并后 3775 项

---

## 0. 一句话结论

**19 条全部处理完毕：17 条已修、2 条「已修（附说明）」。无一条判为「不成立」。**

两条附说明的是：

- `runscope` 的 `getOr` 严格化 —— 翻转默认值是 breaking change，做成显式开关，**默认值是否翻转交总审裁决**
- `logger` 的 Silent 语义 —— 实测确认「Silent 仍写缓冲」是**刻意设计**（README 已论证），不是漏写 `return`，因此保留行为、消除空块、新增显式开关

---

## 1. 关于复现（纪律 1.2）

**任务书里所有证据我都自己重跑了一遍**，没有直接采信原报告。

复现方式：把 11 个单元源码 `git checkout` 回基线 `e8f7245`，单独编译到 `.build.base/`，
用**独立只读脚本调用公开 API** 取修复前的真实输出。
（没有用"改回旧代码再 build.sh"的方式——`build.sh` 整体替换 `.build/`，已发生过一次误删产物的事故。）

一个与直觉相反、值得单独说的发现：

> **`logger` 的空 if 块不是"漏写 return"的 bug，是注释骗人。**
> 任务书推测"明显是漏写 `return`"。但 README 第 155 行明确写着
> 「低于级别的日志**仍然进缓冲**——这是刻意的：崩溃时要能导出崩溃前的 Trace 级日志」。
> 也就是说"Silent 仍写缓冲"与文档一致，与"漏写 return"矛盾。
> 按纪律 1.2「文档说没问题不等于真没问题」，我实测了两个方向：
> ① `buffered` 确实是 2（现象属实）；② 但**任何级别都进缓冲**，不是 Silent 特有的——
> 所以"Silent 期日志把关键日志挤出缓冲"这个后果不成立，有级别时它们一样被挤出。
> 真正的问题是**空块 + 两行互相矛盾的注释**让人无法判断作者意图，
> 以及"想省掉 entry 分配"这个合理需求没有出口。详见 P1-7。

---

## 2. 逐条结果

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| P1-1 | attribute | P1 | 已修 | `add()` 后 onChange 计数 = 1；`clearModifiers('atk')` 后仍 = **1**；`clearModifiers()` 后仍 = **1** | 2 / 2，且无参分支对两个属性各通知一次 | `run_phase10_w2a.ts` › W2-A · attribute · clearModifiers 触发 onChange |
| P1-2 | attribute | P1 | 已修 | `v = overridden ? v + add : v + add;` 两分支完全相同（`overridden` 只被写不被读） | 删掉死变量与死三元，写明"override 后仍叠加 add"并注明与 README 一致 | 同上 › override 与 add 的叠加语义 |
| P1-3 | command | P1 | 已修 | 回滚中 `undo()` 抛错 → 完全无声；无 `lastRollbackErrors` API（返回 `undefined`） | 新增 `onRollbackError` 回调 + `lastRollbackErrors`，单条失败记录但不中断其余撤销 | › W2-A · command · rollback 不再静默吞掉 undo 异常 |
| P1-4 | diagpack | P1 | 已修 | `safeStringify({a:shared,b:shared})` = `{"a":{"hp":100},"b":"[Circular]"}`；数组版 = `[{"hp":100},"[Circular]"]` | `{"a":{"hp":100},"b":{"hp":100}}`；真环仍拦下 | › W2-A · diagpack · safeStringify 不再误判共享引用 |
| P1-5 | diagpack | P1 | 已修 | `redact('{"password": {"a":1},"nested":1}')` → `{"password": "[REDACTED]"},"nested":1}`，`JSON.parse` 失败：`Unexpected non-whitespace character after JSON at position 26` | `{"password": "[REDACTED]","nested":1}`，`JSON.parse` 成功 | › W2-A · diagpack · 脱敏不得破坏 JSON 结构 |
| P1-6 | indicator | P1 | 已修 | `compute(0,0,0,6,0).x` = **6**；`centerFor(0,0,0).x` = **3**（相差 length/2） | 两者均为 3，`aimX/aimY` 仍为瞄准点语义 | › W2-A · indicator · compute 与 centerFor 中心一致 |
| P1-7 | logger | P1 | **已修（附说明）** | `level=Silent` 打 2 条 → `buffered = 2`；模块级例外场景 `buffered = 2`（期望 1） | 空块消除；新增 `bufferWhileSilent` 开关；模块级例外不再被误判为静默 | › W2-A · logger · Silent 语义显式化 |
| P1-8 | pathfinding | P1 | 已修 | 5×5 网格把 (0,0) 设为不可走 → `findPath` 返回**长度 5 的完整路径**（起点是墙） | 返回 `null` | › W2-A · pathfinding · 起点不可走也要返回 null |
| P1-9 | runscope | P1 | 已修 | `has('toString')` = false；`get('toString')` 抛 `Cannot read properties of undefined (reading 'get')`；`scopeOf('toString')` = **undefined** | `get/set` 走统一"未声明的键"口径；`scopeOf` 返回 `null` | › W2-A · runscope · 原型链键不再让 has/get/set 打架 |
| P1-10 | runscope | P1 | **已修（附说明）** | 局外 `getOr('gold', 0)` = `0`（越界异常被吞），而同键 `get('gold')` 抛「在局外读取局内数据」 | 新增 `swallowCrossScope` 选项；**默认保持兼容**，传 `false` 即抛 | 同上 |
| P1-11 | scheduling | P1 | 已修 | `StepContext.elapsed` 实测 = `[0]`（任务执行到一半、跨多帧均恒 0）；`flush()` 同样写死 0 | 改为 getter：单帧 5、跨帧每帧重算（10/20/30）、flush 内同样有效 | › W2-A · scheduling · StepContext.elapsed 与若干 P2 |
| P1-12 | skill-caster | P1 | 已修 | `charges:2` 施放 2 次 → `chargesLeft` = 0 → `resetCooldown('s')` → 仍 **0**（期望 2）→ 再施放 → **-1** | 重置为满充能 2；再施放得 1 | › W2-A · skill-caster · resetCooldown 不留下错乱的充能数 |
| P1-13 | social | P1 | 已修 | 仅一条 cheating 举报时 `byReason` = `{"cheating":1}`；`byReason['afk'] + 1` = **NaN** | 6 个 reason 全部初始化为 0，`+1` = 1 | › W2-A · social · statsOf().byReason 完整且阈值收口 |
| P1-14 | social | P1 | 已修 | `abuseThreshold: NaN` → 驳回 5 次后 `isAbusiveReporter` 仍 = **false**；`abuseThreshold: -1` → 对所有人返回 **true** | NaN 回落默认 5；`-1`/`0` 夹到 1（不再误伤全员） | 同上 |
| P2-di | diagpack | P2 | 已修 | Di3 恒等 replacer `(_key,v)=>v` 占位未实现；Di4 `maxSectionChars:0` 截成 0 字符、`maxTotalChars:-1` 丢弃全部分区；Di5 `collectEnvironment` 直连 `new Date()`/`Intl`；Di6 无 `destroy()` | 4 项全修：replacer 可注入、配额 `positiveCapOr` 收口、环境可注入、补 `destroy()` | › W2-A · diagpack · 配额收口与 destroy |
| P2-in | indicator | P2 | 已修 | `{kind:'ring',radius:5,innerRadius:4}` → `'innerRadius' in result` = **false**（配置收下却不用） | `IndicatorResult.innerRadius` 随结果给出 | › W2-A · indicator（ring 用例） |
| P2-lo | logger | P2 | 已修 | L2 同一函数注册两次、取消一次后剩余 sink 数错误（旧 `indexOf` 会误删后来者）；`destroy()` 不清 `_moduleLevels`；L3 缓冲持 `data` 引用；L4 `Assert.soft` 直连 `console.warn` | 4 项全修：token 化注销 + 遍历副本、destroy 清模块级、`bufferData` 开关、`setSoftHandler` | › W2-A · logger（L2/L3/L4 用例） |
| P2-ru | runscope | P2 | 已修 | Ru3 `importSave({gold:NaN})` → `gold` = **NaN**；Ru4 `add('gold',NaN)` 不报错 → `gold` = **NaN**；Ru5 `StoreSchema` 含 `any`；Ru6 `typeof destroy` = **undefined** | 4 项全修：存档回退初始值、delta 拒绝非有限、`any`→`unknown`、补 `destroy()` | › W2-A · runscope（Ru3/Ru4/Ru6 用例） |
| P2-sc | scheduling | P2 | 已修 | Sch2 `hardLimitMs: NaN` 构造成功且硬限制失效、`:0` 静默退化；Sch3 只有 `onDone` 无 `onError`；Sch4 每任务每帧新建 ctx+闭包；Sch5 每次 `schedule()` 全量 `sort`；Sch6 `flush()` 用 `shift()`；Sch7 空批次返回 id `0` | 6 项全修：收口 + 只读暴露、`onError`、ctx 按帧复用、二分插入、游标遍历、`NO_TASK` 常量 | › W2-A · scheduling（Sch2/Sch3/Sch6/Sch7 用例） |

---

## 3. 两处需要总审留意

### 3.1 `runscope.getOr` 的默认值是否翻转（**需总审裁决**）

现状（我选的）：**默认保持兼容**——越界仍返回 fallback；
想守住防串档线的调用方显式传 `{ swallowCrossScope: false }`。

为什么不直接翻转：

- 既有测试 `tests/run_batch11.ts`「getOr 不抛错」明确断言
  `s.getOr('gold', -1) === -1`，注释写的是"局外读 run 域应返回兜底值"
- `runscope/README.md` 第 75 行的三个逃生舱表格里，`getOr` 被标注为「**不抛错**」

翻转它是 breaking change，会同时动到既有测试与 README，超出"修这一条"的范围。
**如果总审认为防串档优先，翻默认值是一行改动 + 改那一条既有测试，我可以直接补。**

### 3.2 `logger` Silent 语义：不要按"漏写 return"修

任务书建议「补 `return;`」。实测确认这**会删掉崩溃现场**——
而"保留崩溃现场"正是 logger 这个单元存在的理由（README 第 155 行）。

我的处理：保留"Silent 仍写缓冲"，把空块换成显式说明，
另加 `bufferWhileSilent: false` 给真正想省掉分配的场景（压测）。
**如果总审认为"Silent 就该什么都不做"，请把默认改为 false 并同步改 README。**

---

## 4. 对照用例（防止矫枉过正）

每条修复都配了"正常输入不受影响"的用例，共 24 条，全部在 `tests/run_phase10_w2a.ts`。
几个容易被误伤的点，单独说明我是怎么守的：

| 修复 | 被误伤的风险 | 对照用例 |
|---|---|---|
| `social` 阈值收口 | 把合法的"关闭某阈值"也夹掉 | `abuseThreshold: 0/-1` 不再误判全员为恶意；正常阈值（1 / 3）行为不变 |
| `scheduling` hardLimitMs 收口 | 合法小值被拒 | `hardLimitMs: 1` 仍能在第一个任务后中断本帧 |
| `runscope` add 拒绝 NaN | 正常负数增量被拒 | `add('gold', -3)` 仍可用 |
| `runscope` importSave 校验 | 合法存档被回退 | `{gold: 999}` 照常恢复 |
| `logger` bufferData | 默认路径丢 data | 默认时 sink 与 `export()` 都拿得到 data |
| `indicator` 中心统一 | circle 的中心被误移 | circle 仍以目标点为中心；`aimX/aimY` 语义不变 |
| `diagpack` 配额收口 | 正常配额失效 | `maxSectionChars: 10` 仍会标记 `truncated` |
| `attribute` clearModifiers 通知 | 没变化时误报 | `clearModifiers` 清 0 条时不通知 |
| `pathfinding` 起点校验 | 正常寻路被拦 | 空旷地图仍找到路径；起点=终点仍返回单点 |

---

## 5. 我没有做的事（避免违反纪律）

- **没改 `tests/run.ts`**。任务书 5.2 明确"由总审统一合并注册，你不要改它"。
  我一开始误改过，已 `git checkout` 回退。
  独立运行方式：
  ```bash
  node -e "const fw=require('./.build/tests/_framework.js');
  const w=require('./.build/tests/run_phase10_w2a.js');
  fw.setSuite('W2-A'); w.runPhase10W2ATests(); fw.summary();"
  # → 通过 80 项，失败 0 项
  ```
- **没碰 `_core/`**。
- **没改 `README.md`**（测试总数在变，总审统一更新）。
- **没留临时脚本**：所有验证脚本用完即删，`verify/` 未创建。
- `_kitmeta.json` 有一处被动改动：`diagpack` 新增对 `_core` 的依赖登记
  （`check-deps.js` 报"import 了但没登记"，按其提示 `--fix` 写回）。

---

## 6. 自检结果

### 6.1 构建与回归

```
bash build.sh
→ TSC OK（产物校验通过：211 个 .js）

node .build/tests/run.js
→ 通过 3695 项，失败 0 项        （基线，W2-A 套件未注册）

W2-A 套件独立运行
→ 通过 80 项，失败 0 项
→ 合并后预期 3775 项
```

### 6.2 六个校验脚本

| 脚本 | 结果 |
|---|---|
| `node scripts/check-deps.js` | 全部通过 ✓（已 `--fix` 登记 diagpack→_core）|
| `node scripts/check-links.js` | **断链 1 处** ⚠️ |
| `python3 scripts/scan-dt-guard.py` | 扫描 146 个文件，命中 0 处 ✓ |
| `python3 scripts/scan-num-guard.py` | 扫描 0 处命中 ✓ |
| `python3 scripts/check-random-source.py` | 未发现自建随机源 ✓ |
| `python3 scripts/check-dup-exports.py` | 无待处理的冲突 ✓ |

**关于那 1 处断链**：位于 `audit/handoff_W3-B.md`（`→ ](...) 解析为 audit/...`）。
这是**基线既有文件**，属于另一个窗口（W3-B），我从未改动，也不在我的单元范围内。
本窗口新增/修改的文件没有引入任何断链。

---

## 7. 交叉验收 W2-B

**状态：未开始 —— W2-B 尚无任何交付物。**

已确认仓库中不存在 `audit/result_W2-B.md`，也不存在 `tests/run_phase10_w2b.ts`：

```
ls audit/           → 无 result_W2-B.md
ls tests/ | grep w2b → 空
```

按 `audit/review_A.md` 第 0 节，验收对象是对方的"全部交付物"；
对方未交付则无对象可验。**待 W2-B 产出后我再补 `audit/verify_W2-A.md`**，
或由总审另行指派。
