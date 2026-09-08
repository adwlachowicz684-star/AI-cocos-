# 验收报告 · W5-B 验收 W5-A

> **版本**：第二版（完整独立验收）。第一版结论「不通过 —— 交付物缺失」作废：
> 当时 `result_W5-A.md` 与 `tests/run_phase10_w5a.ts` 尚未推送，本窗口据此判定为"未交付"。
> 现两个交付物均已在 main 上（`8521b0c` / `fc3e280` / `af835cd`），本报告为重新验收。
>
> **验收对象**：`audit/handoff_W5-A.md` 的 15 条（P1 9 / P2 6），9 个单元
> `behavior-tree fsm number-roller quest signal skill-queue steering telemetry turn`
>
> **验收方法（双副本对照）**
> - 修复前副本：`main @ df65fca`（W5-A 推送 8521b0c 的父提交），完整 `build.sh` 构建 → 224 个 .js
> - 修复后副本：`main @ 630b638`（当前最新），完整 `build.sh` 构建 → 227 个 .js
> - 复现脚本 `/tmp/repro_before.js`、`/tmp/repro_after.js`，**只调公开 API**，
>   全程未改任何源码、未回退任何修复、未动 `.build/`（遵守 `review_B.md` §2 标准 2 的禁令）
> - 逐条比对"报告声称的修复前现象"与"我在 df65fca 上实测的现象"，不一致的直接标出

---

## 结论

**有条件通过。**

- **15 条修复本身全部生效**：我在 df65fca / 630b638 两套构建上逐条复现，
  除 3 条"本就正确 / 行为无差别"的条目外，现象均按报告描述消失，且对照用例显示正常输入未受影响。
- **改动范围干净**：W5-A 三个提交只动了 9 个自己单元的源码 + 自有测试 + 自有报告，
  未碰 `_core/`、`tests/run.ts`、根 `README.md`、其它窗口单元（commit files 列表已核）。
- **但有 3 项需要返工 / 说明**（🔴 标红），另有 5 项建议补（🟡）：

| 级别 | 条数 | 内容 |
|---|---|---|
| 🔴 标红（必须处理） | 3 | ① `signal` 场景 B 的复现输出与基线不符、用例回退仍通过<br>② `number-roller` 下冲用例断言过弱、回退仍通过<br>③ `_kitmeta.json` 越界删除了 3 个非本窗口单元的 `_core` 登记 |
| 🟡 建议补 | 5 | 4 处单元 README 与实现不一致（其中 `steering.wander` 的 `rand?` 一条最要紧）、<br>2 条"锁现状"用例报告未标注、`Cooldown(NaN)` 修复后语义需在报告写明 |
| ⚠️ 需总审裁决 | 2 | `wander` 的 `rand` 改必填（breaking）；`skill-queue.window` 非法值"保持旧值"是否静默 |

**给总审的一句话**：修复质量本身在 16 个窗口里属上乘——尤其编号 5 识破了
`skill-queue` 那句"0 = 不过期"的伪设计注释（有实测反证）。问题集中在
**"测试写得太乐观"**（4 条断言回退修复后照样通过）与**"只改源码不改 README"**。

---

## 1. 逐条验收

判定符号：✅ 通过 / ❌ 不通过 / ⚠️ 有保留 / — 不适用

| # | 单元 · 条目 | 标准1 复现 | 标准2 测试有效 | 标准3 对照 | 标准4 无顺手重构 | 标准5 未误判设计 | 我的独立实测（前 → 后） |
|---|---|---|---|---|---|---|---|
| 1 | behavior-tree · Wait/Cooldown 秒数收口 (P1) | ✅ | ✅ | ✅ | ✅ | ✅ | `Wait(NaN)` 100 帧 Success **0 → 100** 次；`Wait(0.1)` 600 帧 **85 → 85**（不受影响）；`Cooldown(NaN)` remain **NaN → 0**；`Cooldown(Infinity)` 10 帧 **1 → 1** 次 |
| 2 | number-roller · snapTo 有限性 (P1) | ✅ | ✅ | ✅ | ✅ | ✅ | `snapTo(NaN)`：**display NaN → 抛 `[NumberRollerCore] 目标值必须是有限数`**；`snapTo(999)` → `999 / '999'`（对照不变） |
| 3 | quest · import 字段校验 (P1) | ✅ | ✅ | ✅ | ✅ | ✅ | `status:'garbage'`：**skipped 0、status='garbage' → skipped 1、status='available'**；`progress:['a']`：收口后可正常完成（前：report 5 次仍 active）；合法存档往返 `skipped=0 / current=3` |
| 4 | signal · 同名函数取消 (P1) | ❌ | ❌ | ✅ | ✅ | ✅ | 场景 A ✅：`listenerCount 2 → 0`（前）改为 `→ 1`（后）；**场景 B ❌：报告称"m 停在 11"，我在 df65fca 实测 `m=21`、中途 `listenerCount=1`**，与修复后完全一致 → 见 R1 |
| 5 | skill-queue · window 收口 (P1) | ✅ | ✅ | ✅ | ✅ | ✅✅ | 构造 `window:NaN`：**NaN、count 0、rejected 1 → 0.25、count 1、rejected 0**；运行时设 NaN：**旧代码兜到 0（count 立刻 0）→ 保持 1.0（count 1）**；`window=0.2` 仍正常过期。原注释"0 = 不过期，与 Math.max 语义一致"经实测为假，W5-A 的反驳成立 |
| 6 | steering · mass 除零 (P1) | ✅ | ✅ | ✅ | ✅ | ✅ | `mass=0` 后 integrate：pos/vel **全 NaN → 有限（(1.18,1.18) / (70.7,70.7)，限速生效）**；且 W5-A 正确指出构造路径已被 `needPositive` 挡住（`createAgent mass=0` 基线即抛错），改的是运行时改 `agent.mass` 这条路径 |
| 7 | steering · wander 随机源 (P1) | ✅ | ⚠️ | ✅ | ✅ | ✅ | 基线不注入时两次结果不同（`49.05,-13.73` vs `49.07,-13.57`）→ 现 `rand` 必填，不传运行时 `THROW rand is not a function`；注入同一 rand 两次完全相同。⚠️见 Y4：测试断言"注入后确定"在修复前也成立，修复点由**编译期**保证而非断言 |
| 8 | telemetry · maxRetries (P1) | ✅ | ⚠️ | ✅ | ✅ | ✅ | 基线 `maxRetries:''` 两次 flush 后 `buffered=1`（与 `3` 一致）→ **原报告"第一次失败即丢弃"在基线就不成立**，W5-A 判"已核（原已修）"正确。⚠️ 该用例属"锁现状"，回退后仍通过（报告已标注，可接受） |
| 9 | turn · start 同先攻打乱 (P1) | ✅ | ✅ | ✅ | ✅ | ✅ | 不传 rng：`u0..u5`（与基线一致，兼容）；传固定 rng：**`u3,u1,u4,u2,u0,u5`，两次同种子完全一致**；不同先攻 `fast` 仍在最前 |
| 10 | behavior-tree · P2 四子项 | ⚠️ | ❌ | ✅ | ✅ | ✅ | `Repeater(0)`：子节点执行 **1 → 0** ✅；`Parallel` 默认 5 帧仍 5 次、`skipCompleted=true` → 1 次 ✅；共享子节点 destroy **2 → 1** ✅；trackedNodes 保持 0（只更正文档，合理）。❌ `Repeater(NaN)`：修复前后**都是 50 帧 50 次、恒 Running**（NaN→Infinity 后 `_count >= Infinity` 与 `_count >= NaN` 同为恒 false）→ 行为无差别，用例回退仍通过，见 Y2 |
| 11 | fsm · can 白名单 (P2) | ✅ | ✅ | ✅ | ✅ | ✅ | `idle`（表中缺项）：`can('jump')`/`can('teleport')` **true → false**；未配置 transitions 仍 `true`；表中有项时白名单正常 |
| 12 | fsm · start 幂等 / reset 通知 (P2) | ✅ | ✅ | ✅ | ✅ | ✅ | 重复 start 的 enter 次数 **2 → 1**；reset 的 onChange **[] → ['b->a']** |
| 13 | number-roller · 配置项收口 (P2) | ✅ | ❌ | ✅ | ✅ | ✅ | `duration.min=NaN`：**isRolling false、display 5000 → true、0** ✅；`formatted(-0.4)`：**'-0' → '0'** ✅（`snapTo(-5.4)` 仍 '-5'）✅；❌ 下冲用例见 R2；`decimals=-1` 修复前后同为 `'1'`（行为未变，见 Y3） |
| 14 | steering · 除零与收口 (P2) | ✅ | ✅ | ✅ | ✅ | ✅ | `circleFormation(0,0,10)` **NaN → (10,0)**；`formationOffset(0,10,0)` **NaN → (-20,0)**；`maxSpeed=NaN` **1e9 → 100**；对照 `circleFormation(1,4,10)=(0,10)`、`mass:2` 时 `a=F/m` 未变；向量工具"就地操作"注释只更正不重构 ✅（符合 §1.1 第 1 条） |
| 15 | telemetry · 配置与统计 (P2) | ✅ | ✅ | ✅ | ✅ | ✅ | `flushIntervalMs=NaN`：**shouldFlush true → false** ✅；`sampleRate='abc'`：**20 次 capture 成功 0 → 20** ✅；重试超限 `dropped` **0 → 2** ✅；`destroy()` **undefined → function**（destroy 后 flush 不再发送）✅。⚠️ `willSample('toString')` 用例属"锁现状"（基线已用 `hasOwn`，返回 true），报告未标注，见 Y2 |

---

## 2. 🔴 标红项（必须返工 / 说明）

### R1 · 编号 4 `signal`：场景 B 的复现输出与基线不符，且用例回退修复后照样通过

**报告原文**（`result_W5-A.md` 编号 4）：
> 场景 B：回调里 `off()` 自己 → 第二次 `emit` 另一个监听者**不再被调用**（`m` 停在 11）

**我在 df65fca 上的实测**（与 W5-A 测试完全同构：A 自增 1 并自我取消、B 自增 10）:

```
m = 21，第一次 emit 后 listenerCount = 1，第二次 emit 后 = 1
```

`m=21` 意味着 B 在第二次 emit 中**照常被调用**——与"停在 11"相反，也与修复后的 `21` 完全相同。
即 `run_phase10_w5a.ts` 中 `signal · emit 回调里取消自己` 这条用例（`eq(m, 21)` + `eq(listenerCount, 1)`）
**在修复前就通过**，按 `review_B.md` 标准 2 属无效用例。

**根因**（读基线 `signal/Signal.ts:79-123`）：连坐只发生在 `_pendingRemoval` 里存在**相同函数引用**时。
场景 B 的两个监听者是不同引用（一个 `selfRemoving`、一个匿名箭头），`Set<F>` 按值去重删不掉 B；
真正的连坐场景是**同一函数注册多次**，也就是场景 A——那一条是有效的。

**请对方二选一**：
1. 把场景 B 改成能真正触发的形态（同一函数 `add` 两次、在回调里只取消自己那一条），让断言回退即失败；或
2. 保留它但改名为"对照用例"，并在报告里更正场景 B 的复现输出（`m=21`，不是 11）。

### R2 · 编号 13 `number-roller`：下冲用例的断言过弱，回退修复后照样通过

测试断言：`overshoot: 0.5` 时 `update(0.5)` 后 `assert(r.display < 100)`。

**实测**：修复前（走"不过冲"分支）中途值 = **87.5**，同样 `< 100`；修复后 = **49.77**。
断言在两种实现下都成立 → 无效用例。

**建议改法**（把"下冲 vs 不过冲"直接对照起来，回退必红）：

```ts
const a = new NumberRollerCore({ duration: { min: 1, max: 1 } });
a.set(100);              a.update(0.5);   // 不过冲：87.5
const b = new NumberRollerCore({ duration: { min: 1, max: 1 } });
b.set(100, { overshoot: 0.5 }); b.update(0.5);   // 下冲：49.77
assert(b.display < a.display - 1e-6, `下冲应比不过冲更慢，实际 ${b.display} vs ${a.display}`);
```

### R3 · `_kitmeta.json` 越界：删掉了 3 个非本窗口单元的 `_core` 登记

`8521b0c` 的 `_kitmeta.json` patch（+6/−8）除登记 `turn → _core` 外，还删除了三处**不属于 W5-A** 的登记：

```
dungeon      depends: ["ds","_core"] → ["ds"]
pathfinding  depends: ["ds","_core"] → ["ds"]
adapters     depends: ["_core"]      → []
```

这是 `check-deps.js --fix` 全量重写 `_kitmeta.json` 的连带效果（W5-A 在报告 §7 自己也提到
"`_kitmeta.json` 在反复被覆盖"）。后果是其它窗口的校验脚本在那一小段时间里假通过/报错，
且要由别的窗口去发现并补回（当前 main 上这三处**已被其它窗口恢复**，我比对 df65fca 与 630b638 的
`depends` 差异，只剩 `turn`（本窗口应加的）与 `diagpack`（W2-A 的）两项）。

**建议**（对全库，请总审转发）：`--fix` 之后先 `git diff _kitmeta.json`，
只保留自己那一条再提交；或改为手改自己单元那一个 `depends` 数组。

---

## 3. 🟡 建议补（不阻塞，但建议对方回一手）

### Y1 · 四处单元 README 与实现不一致（W5-A 一个 README 都没改）

总审台账口径：**文档与实现不一致 → 默认 P1**。以下四处均为本次改行为后未同步：

| 文件 | 现状 | 应为 |
|---|---|---|
| `steering/README.md:183` | `wander(agent, state, circleDist?, circleRadius?, angleChange?, rand?)` | `rand` 已是**必填**参。按 README 抄代码的人会撞 `rand is not a function`（我实测确认）。这条同时踩了 rule7「复制即可用」，**优先修** |
| `turn/README.md:72` | `start(shuffleEqual?)` 一行，无 `rng` | 需写明 `start(shuffleEqual?, rng?)`，并注明"**未注入 rng 时同先攻保持添加顺序**"——否则原 P1 的"参数暗示会打乱"在文档层面仍然存在（源码 JSDoc `:301-312` 写得很清楚，只是没同步到 README） |
| `fsm/README.md:94/98` | 只写"省略 = 任意转换都允许" | 需补"**配了 transitions 但当前状态缺项 = 一个都不许转**"，这是编号 11 改掉的语义 |
| `behavior-tree/README.md:80` | `tree.trackedNodes; // 调试面板显示"AI 现在卡在哪个节点"` | 与"手动接口、内置节点不自动记录（size 恒为 0）"冲突，需改（W5-A 已改源码注释，差 README 一步） |

另有 `telemetry/README.md` 的 API 表未列新增的 `destroy()`（rule5 可卸载相关），顺手补上。

### Y2 · 两条"锁现状"用例，报告里没标注

- `telemetry.willSample('toString')`：基线 `Telemetry.ts:215` **已经用了 `hasOwn`**，
  原精审报告 P2 说的"原型键取到函数 → 采样恒 false"在基线已不成立。该断言修复前后都通过。
  建议在 §四「不成立的核查」里补一行（编号 8 那条已写得很清楚，照抄格式即可）。
- `behavior-tree` 的 `Repeater(NaN)`：见上表 #10，修复前后行为完全一致（都是"无限 Repeater"），
  收口只把 `_times` 从 NaN 变成可观测的 Infinity。建议明确写成"**收口，行为不变**"，
  否则读者会以为 NaN 不再导致无限循环（实际上仍会，只是语义与"不传参"对齐了）。

### Y3 · `decimals = -1` 一条：报告写"夹到 ≥0"，实测修复前后输出相同

基线 `decimals:-1` → `formatted = '1'`；修复后也是 `'1'`（`-1` 夹到 `0` → `toFixed(0)`，
与原来走 `Math.round` 分支结果一致）。行为没变，属于"内部收口"。
同理 `abbreviated` 硬编码 `toFixed(1)` 忽略 `decimals` 一条只做了文档说明、未改行为——
这两条建议报告显式写"未改行为"，避免被总审当成已修。

### Y4 · 编号 7 `wander`：修复点由编译期保证，测试断言证明不了

测试断言"注入同一 rand 两次结果相同"在**修复前也成立**（旧签名同样接受第 6 个参数）。
真正被修掉的是"不传 rand 时默认 `Math.random`"这条路径——改成必填后，它只能由 `tsc` 保证，
运行时断言覆盖不到。这不是错，但建议在报告里写一句"本条的有效性来自类型系统，
运行时无法构造回退用例"，免得下一个人照着"有测试"以为它已被断言守住了。

### Y5 · 编号 1 `Cooldown(NaN)` 修复后仍是"无冷却"

修复后 `Cooldown(NaN)` → `_seconds = 0` → 子节点仍是**每帧执行**（我实测 5 帧 5 次，与修复前一致），
变化的是 `remain` 从 NaN 变成可观测的 `0`。这个取舍我认为是对的（与 `Wait(NaN) = 0 秒` 同口径、
NaN 不再静默穿透），但报告"修复后"一列的措辞容易被读成"冷却不再失效"。
建议补一句：**NaN 退化为 0 秒冷却（可观测），不是"恢复成配表默认值"**。

---

## 4. ⚠️ 需总审裁决（我不拍板）

1. **`steering.wander` 的 `rand` 改必填 = breaking API**（任务书给了两个选项，W5-A 选了"必填"）。
   - 利：与 F 类"随机源一律注入"一致，默认路径不再不可复现；库内既有调用（`tests/run_batch6.ts:1670`）
     本来就传了 rand，实测未破坏任何既有测试。
   - 弊：外部使用者的 `wander(a, s, 20, 10, 0.5)` 会从"能跑但不可复现"变成编译失败；
     且 README 尚未同步（见 Y1），等于在文档没跟上的情况下先 breaking。
   - **我的倾向**：认可必填，但**必须先补 README 再合入**（否则违反 rule7）。
2. **`skill-queue.window` 非法值"保持旧值"**（编号 5，与任务书建议的"回落到 0.25"不同）。
   W5-A 的实测反证成立（兜底 0 等于把窗口清空，与没修一样），我认可其判断；
   但"保持旧值"是**完全静默**的——一次热更新传 NaN 后没有任何告警，配置错误会被藏住。
   建议裁决：保持旧值 + 一条 `console.warn`，还是改为回落默认值 0.25（可观测）。

---

## 5. 附：全库校验结果（在 `main @ 630b638` 上重跑）

```
bash build.sh                        TSC OK（产物校验通过：227 个 .js）
node .build/tests/run.js             通过 3696 项，失败 1 项
   ✗ 第九批 › BinarySerializer › float 会 clamp 而不是溢出回绕
     ← W8-B 修 P1-5 后漏改旧测试（W2-A 已定位认领），与 W5-A 无关
W5-A 52 项独立跑                     通过 52 项，失败 0 项
   node -e "require('./.build/tests/run_phase10_w5a.js').runPhase10W5ATests();
            require('./.build/tests/_framework.js').summary();"
node scripts/check-deps.js           有 1 项需要处理：accessibility → _core
                                     ← accessibility 属 **W5-B（本窗口）** 单元，非 W5-A 引入；
                                       W5-A 该登记的 turn → _core 已在位（对比 df65fca 确认）
node scripts/check-links.js          [OK] 42 条内部链接，断链 0 处
python3 scripts/scan-dt-guard.py     扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py    扫描 0 处命中 ✓
python3 scripts/check-random-source.py  [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py    [OK] 无待处理的冲突 ✓
```

**W5-A 的改动文件清单**（`8521b0c`，与报告 §五一致，无越界）：
`behavior-tree/{BTNode,BehaviorTree}.ts`、`fsm/StateMachine.ts`、
`number-roller/NumberRollerCore.ts`、`quest/QuestSystem.ts`、`signal/Signal.ts`、
`skill-queue/SkillQueue.ts`、`steering/Steering.ts`、`telemetry/Telemetry.ts`、
`turn/TurnSystem.ts`、`tests/run_phase10_w5a.ts`（新增 866 行）、`_kitmeta.json`（见 R3）、
`audit/{result_W5-A,verify_W5-A}.md`。
`fc3e280` / `af835cd` 两个后续提交**只改 `audit/` 下的文档**，未再动代码 ✓。

**未改**（符合并行纪律）：`_core/`、`tests/run.ts`（已确认未注册 `runPhase10W5ATests`，
52 项待总审统一合并）、根 `README.md`、任何其它窗口的单元代码。
