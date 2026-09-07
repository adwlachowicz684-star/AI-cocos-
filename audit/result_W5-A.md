# 第二次精审 · 窗口 W5-A 修复报告

| 项 | 值 |
|---|---|
| 窗口 | W5-A（第 A 组） |
| 条目 | 15（P1 9 / P2 6） |
| 单元 | 9 个：`behavior-tree` `fsm` `number-roller` `quest` `signal` `skill-queue` `steering` `telemetry` `turn` |
| 基线 | 构建通过、**3695 项测试全绿**、6 项校验脚本全过 |
| 交付 | 源码改动 + `tests/run_phase10_w5a.ts`（**52 项，全绿**） + 本报告 |
| 状态 | **全部 15 条已处理**：已修 13、已修（附说明）2；其中 1 条子项标"需总审裁决" |

> ⚠️ **`tests/run.ts` 未改动**（任务书 §6 要求由总审统一合并注册）。
> 因此 `node .build/tests/run.js` 的条数仍为 3695；本窗口新增的 52 项需总审合并后才计入。
> 独立运行：
> `node -e "require('./.build/tests/run_phase10_w5a.js').runPhase10W5ATests(); require('./.build/tests/_framework.js').summary();"`

---

## 一、逐条结果

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| 1 | behavior-tree | P1 | 已修 | `Wait(0.1)` 600 帧 Success **85** 次；`Wait(NaN)` Success **0** 次、状态恒 `Running`（`elapsed` 已累加到 10.0 仍不返回）；`Cooldown(NaN)` 10 帧子节点执行 **10** 次，对照 `Cooldown(1)` 只执行 **1** 次 | 构造函数用 `fixSeconds()` 收口（NaN/负数 → 0，放行 `Infinity`）。`Wait(NaN)` 不再卡死；`Cooldown(NaN)` 的 `remain` 为可观测的有限数 | `run_phase10_w5a.ts` › behavior-tree · Wait 的秒数收口 / CooldownDecorator 的秒数收口 |
| 2 | number-roller | P1 | 已修 | `snapTo(NaN)` → `display = NaN`、`formatted = 'NaN'`，且 `update()` 后仍为 NaN、**永不自愈**；对照 `set(NaN)` 抛 `[NumberRollerCore] 目标值必须是有限数` | `snapTo` 增加与 `set` 相同的 `Number.isFinite` 校验，非法值直接抛（口径统一） | › number-roller · snapTo 的有限性校验 |
| 3 | quest | P1 | 已修 | `import([{ id:'q1', status:'garbage', progress:['a'] }])` → `skipped = 0`、`status = 'garbage'`、`progress = ['a']`，且 `available/active/completed` **三个 getter 全为空**（任务从 UI 消失） | `import` 校验 `status` 属于枚举白名单（不合法整条计入 `skipped`），`progress` 元素非有限数收口为 0（不丢整条存档） | › quest · import 的字段校验 |
| 4 | signal | P1 | 已修 | 场景 A：`once` + `add` 同一函数 → `listenerCount=2` → `emit()` → `n=1`、`listenerCount=0`（add 那条被连坐删除）；场景 B：回调里 `off()` 自己 → 第二次 `emit` 另一个监听者**不再被调用**（`m` 停在 11） | 每条注册分配自增 `id`，取消闭包捕获自己的 id，`_pendingRemoval` 存 `Set<number>`。场景 A 后 `listenerCount=1`；场景 B 第二次 `emit` 仍触发另一个监听者（`m=21`） | › signal · 同一函数注册多次时的取消 |
| 5 | skill-queue | P1 | 已修（附说明） | 构造 `window: NaN` → `q.window = NaN`，`request()` 后立刻 `tick` → `count=0`、`rejected=1`（对照 `window=1.0` 时 `count=1`）；运行时 `q.window = NaN` 后 `q.window` 变成 **0**（旧 setter 用 `clampNum(v,0,1e6,0)` 兜底到 0），下一帧排队项同样被清空 | 构造函数改用 `Math.max(0, numOr(...))`；setter 改为**非法值保持旧值**（见下方说明） | › skill-queue · window 的收口 |
| 6 | steering | P1 | 已修 | `mass = 0` 后 `integrate` → `pos = {"x":null,"y":null}`、`vel = {"x":null,"y":null}`（NaN 序列化结果） | `integrate` 对除数收口（非法质量 → 1，下限 1e-6）；`createAgent` 的 `needPositive` 已挡住构造路径，这里补运行时改 `agent.mass` 的路径 | › steering · 除零与收口 |
| 7 | steering | P1 | 已修 | `rand = Math.random`（旧默认）时连续两次 `wander` 结果不同：`{"x":49.87,"y":-5.18}` vs `{"x":49.81,"y":6.15}`；注入固定 rand 后两次完全相同 | `rand` 改为**必填**参数（未注入时编译期即报错），与库内 loot/card/gacha 的随机源口径一致 | › steering · wander 的随机源 |
| 8 | telemetry | P1 | 已核（原已修） | sender 恒失败、两次 `flush()` 后：`maxRetries=''` → `buffered = 1`，对照 `maxRetries=3` → `buffered = 1`，两者一致 | 现状 `clampNum(opts.maxRetries, 0, 100, 3)` **已正确收口**（`''` 被 numOr 判为缺失 → 回落 3）。原报告描述的"第一次失败即丢弃"在当前代码上不成立，已补回归测试锁住 | › telemetry · 配置收口与统计 |
| 9 | turn | P1 | 已修 | 6 个同先攻单位，`start(true)` / `start(false)` / `start()` **三种调用全部输出 `u0,u1,u2,u3,u4,u5`** | 拆成两条路：不传 `rng` 时行为与修复前完全一致；传 `rng` 且 `shuffleEqual=true` 时对同先攻段做 Fisher-Yates 真打乱，同序列可复现 | › turn · start 的同先攻顺序 |
| 10 | behavior-tree | P2 | 已修（附说明） | `trackedNodes.size = 0`（内置节点一个都不调 `recordNode`）；`Repeater(0)` 子节点仍执行 **1** 次；`Repeater(NaN)` 100 帧执行 **100** 次且恒 `Running`；`Parallel` 3 帧把已 Success 的子节点 tick **3** 次；`Selector` 含同一子节点两次 → `destroy` 调用 **2** 次 | 见下方说明 | › behavior-tree · Repeater / Parallel / destroy |
| 11 | fsm | P2 | 已修 | `transitions={walk:['run']}`、当前态 `idle`（表中缺项）→ `can('jump') = true`、`can('teleport') = true` | 区分"未配置 transitions"（允许任意）与"配置了但缺项"（一个都不许转）；`findUnreachable` 共用同一口径 | › fsm · can 的白名单语义 |
| 12 | fsm | P2 | 已修 | `start()` 调用两次 → `enter` 触发 **2** 次；`reset()` 后 `onChange` 记录只有 `["a->b"]`（重置那次未通知） | `start` 幂等（`_started` 标志）；`reset` 增加 `_transitioning` 拦截并触发 `onChange` | › fsm · start 幂等与 reset 通知 |
| 13 | number-roller | P2 | 已修 | `duration.min = NaN` → `isRolling = false`、`display = 5000`（动画静默失效、直接跳终值），对照 `isRolling = true`、`display = 0`；`decimals = -1` → `formatted` 输出 `1`（配置被静默吞）；`formatted(-0.4)` → `"-0"`；`overshoot = 0.5` 下冲不生效 | 配置项统一走 `numOr`/`Math.max(0, …)`；`decimals` 夹到 ≥0；负号按**展示值**判定；过冲分支改为 `!== 1`，下冲对称生效 | › number-roller · 配置项收口 |
| 14 | steering | P2 | 已修（附说明） | `circleFormation(0,0,10)` → `{"x":null,"y":null}`；`formationOffset` 的 `columns=0` 同理；`integrate(agent, dt, maxSpeed=NaN)` → `vel.x` 保持 **1e9**（限速静默失效） | 阵型函数的除零收口；`integrate` 的 `limit` 走 `numOr`；`createAgent` 的 `maxSpeed/maxForce` 收口。向量工具的"就地操作"注释**只更正不重构**（见说明） | › steering · 除零与收口 |
| 15 | telemetry | P2 | 已修 | `flushIntervalMs = NaN` → `shouldFlush() = true`（对照 `false`）；`sampleRate = 'abc'` → 20 次 capture 成功 **0** 次（全量静默丢失）；重试超限丢弃后 `stats.dropped` 仍为 **0**；`typeof f.destroy === 'undefined'` | `flushIntervalMs` 收口；`sampleRate` 先 `numOr` 再 `clamp01`；重试超限丢弃计入 `dropped`；新增 `destroy()` 断开 sender | › telemetry · 配置收口与统计 |

---

## 二、"已修（附说明）"的三条

### 编号 5 · skill-queue 的 `window` setter：兜底到 0 是**错的**

原报告的建议是 `Math.max(0, numOr(v, 0.25))`。实测发现当前代码已经用了
`clampNum(v, 0, 1e6, 0)`，注释还写着"0 = 不过期，与 `Math.max(0, …)` 的既有语义一致"
——**这个前提是假的**。

过期判定是 `waited <= this._opts.window`：

- `window = 0` 时只有 `waited === 0` 的项能活下来，也就是**除了入队那一帧之外全部立即过期**；
- 实测把 `window` 设成 NaN 后 `q.window = 0`，下一帧排队项就被 `rejected`（`rejected=1`），
  和没修之前的表现**完全一样**。

所以改成：非法值 **保持旧值**（`Math.max(0, numOr(v, this._opts.window))`）。
`window` 允许运行时热更新（难度自适应、不同角色手感），一次热更新传 NaN 时，
让窗口维持上一次的有效值，至少不会把已经配好的手感一键清空。

> 这条正好是任务书 §1.2 说的那种情况：注释主动论证"这是设计如此"，
> 而且是照着"下界是 0"倒推出来的结论，没有真的跑一遍过期路径。

### 编号 10 · behavior-tree 的四个 P2 子项

| 子项 | 处理 | 理由 |
|---|---|---|
| `trackedNodes` 是死功能 | **只更正注释，不改行为** | 节点接口 `IBTNode` 不暴露 children，运行器无法通用遍历整棵树；给每个内置节点加 tree 反向引用会破坏"节点是可独立复制的纯对象"这个前提。已在 `BehaviorTree.recordNode` 上写明"它是手动接口，不是自动追踪"，并加测试锁住 `size = 0` 这一事实 |
| `Repeater` 吞 Failure | **保留语义，写入 JSDoc** | 改掉会让现有树行为突变。文档现在明确写"子节点 Failure 会转成 Running，只有次数用尽才 Success" |
| `Repeater` 的 `times = 0 / NaN` | **已修** | `0` 改为一次都不执行；`NaN` 收口成 `Infinity`（与"不传参"一致），行为可预期 |
| `Parallel` 重复 tick 已 Success 子节点 | **做成可选项**（第 4 参 `skipCompleted`，默认 false） | 直接改成跳过会改变现有树的行为；需要"一次性动作"语义时显式传 `true` |
| `destroy` 对共享子节点重复调用 | **已修** | 用 `destroyAllUnique` 去重，避免"归还对象池两次" |
| `_runningIndex` 只写不读 | **未改**（标需总审裁决） | 见第三节 |

### 编号 14 · steering 的向量工具注释

`:120` 的注释写"向量工具（**就地操作**，避免 GC）"，但 `scale/add/sub/normalize/truncate`
全部 `return v2(...)` 新建对象。

**只更正注释，没有改成真的就地操作**：这几个函数被本文件所有行为依赖，
就地改写会让 `add(a, b)` 意外改掉入参（它们常常就是 `agent.pos` / `neighbor.pos`），
属于会改变既有语义的重构。任务书 §1.1 第 1 条明确要求不顺手重构，
所以把"返回新对象"这件事写清楚，让后来的人不再按"零分配"做性能预算。

---

## 三、需总审裁决（2 项）

### 裁决 1 · `behavior-tree` 的 `_runningIndex` 只写不读（P2）

- **现状**：`Selector` / `Sequence` 在 tick 里写 `_runningIndex`，但**没有任何代码读它**——
  它只通过 `get runningIndex()` 对外暴露，是纯装饰。
- **两种选择**：
  - 删掉：内部字段确实无用；但 `runningIndex` 是**对外 getter**，删除是 breaking change，
    且库外可能有人在调试面板里读它。
  - 保留：无害，只是"看起来像在实现某个功能"。
- **我的倾向**：保留，本次不动。（删除的收益是省三个字段，风险是破坏对外 API。）

### 裁决 2 · `fsm` 的 `enter` 回调抛异常后的中间态（P2）

- **现状**：`transitionTo` 里 `_current` 已切换、`_timeInState` 已归零之后才调 `enter`。
  `enter` 抛异常 → 异常向上传播，状态机停在"已进入但未初始化"的中间态。
- **两种选择**：
  - 回滚到 `from`：语义干净，但 `exit` 已经跑过了，回滚需要再跑一次 `from.enter`，
    可能产生第二次副作用（播两次动画）。
  - 标记 `failed` 并停住：调用方能感知，但需要新增状态字段与对外语义。
- **我的倾向**：本次**只记录不动代码**，因为两种改法都会改变 `transitionTo` 的对外行为，
  属于任务书 §8 第 1 条（会改变对外 API 行为）。已在源码注释里写明。

---

## 四、"不成立"的核查

| 条目 | 结论 | 证据 |
|---|---|---|
| telemetry `maxRetries` 未收口（编号 8） | **当前代码已正确，原报告描述的"第一次失败即丢弃"不成立** | 现状是 `clampNum(opts.maxRetries, 0, 100, 3)`，`''` 被 `numOr` 判为缺失 → 回落 3。实测 `maxRetries=''` 与 `maxRetries=3` 两次 flush 后 `buffered` 均为 1、`failed` 均为 2。已补回归测试锁住（防止将来被改坏） |
| quest `import` 让 `progress=['a']` 被判为已完成 | **部分不成立** | `_isAllDone` 已是肯定式判定 `!(progress[i] >= need)`，`'a' >= 5` 为 false → 取反 → 立即 return false，**不会**被误判为完成（原报告说" `'a' < 5` 为 false → 判定完成"对应的是更老的实现）。但后续 `next[i] + n` 会 NaN，导致该目标永远无法完成——这一半成立，已修 |
| `steering` 的 `createAgent(mass=0)` | **构造路径已被挡住** | `createAgent` 用 `needPositive` 拦截，`mass: 0` 抛 `[guard] agent.mass 必须为正`、`mass: NaN` 抛 `[guard] agent.mass 必须是有限数值`。真正漏的是**运行时改 `agent.mass`** 这条路径（`Agent` 是公开可变对象），本次修的是这一条 |

---

## 五、改动文件清单

| 文件 | 改动性质 |
|---|---|
| `behavior-tree/BTNode.ts` | `fixSeconds` 收口（Wait / CooldownDecorator）；Repeater 次数收口与 0 次语义；Parallel 新增可选 `skipCompleted`；`destroy` 去重 |
| `behavior-tree/BehaviorTree.ts` | 更正 `recordNode` 的注释（声明为手动接口） |
| `fsm/StateMachine.ts` | `can()` 区分缺项；新增 `_targetsOf` 统一 `can` 与 `findUnreachable` 口径；`start` 幂等；`reset` 拦截 + `onChange` |
| `number-roller/NumberRollerCore.ts` | 配置项收口；`snapTo` 校验；`overshoot` 收口与下冲对称；`formatted` 的 `-0`；`abbreviated` 文档说明 |
| `quest/QuestSystem.ts` | 新增运行时状态白名单 `QUEST_STATUSES`；`import` 逐字段校验 |
| `signal/Signal.ts` | 注册项带唯一 id，`_pendingRemoval` 改存 id |
| `skill-queue/SkillQueue.ts` | 构造与 setter 的 `window` 收口（非法值保持旧值） |
| `steering/Steering.ts` | `wander` 的 `rand` 改必填；`integrate` 除数与限速收口；阵型除零；`createAgent` 的 `maxSpeed/maxForce` 收口；更正向量工具注释 |
| `telemetry/Telemetry.ts` | `flushIntervalMs` / `sampleRate` / `willSample` 收口；重试超限计入 `dropped`；新增 `destroy()`；`flushSync` 名称说明 |
| `turn/TurnSystem.ts` | `spendAP` / `grantAP` 的负数与 NaN；`start(shuffleEqual, rng)` 支持注入随机源 |
| `_kitmeta.json` | 由 `node scripts/check-deps.js --fix` 自动补上 `turn → _core`（脚本产出，非手改） |
| `tests/run_phase10_w5a.ts` | **新增**，52 项（每条修复 1 条回归 + 1 条对照） |

**没有改**：`_core/`（任务书明令禁止）、`tests/run.ts`（总审统一合并）、`README.md`（总审统一更新）、
`build.sh`、任何其它窗口的单元代码。

---

## 六、自检结果

```bash
bash build.sh                       # TSC OK（产物校验通过：211 个 .js）
node .build/tests/run.js            # 通过 3695 项，失败 0 项（条数未减）
                                    # 本窗口新增 52 项在 run_phase10_w5a.ts，待总审合并
node scripts/check-deps.js          # 全部通过 ✓（--fix 后）
node scripts/check-links.js         # 44 条内部链接，断链 1 处（见下）
python3 scripts/scan-dt-guard.py    # 扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py   # 扫描 0 处命中 ✓
python3 scripts/check-random-source.py  # [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py    # [OK] 无待处理的冲突 ✓
```

⚠️ **check-links 的 1 处断链不是本窗口引入的**：`audit/handoff_W3-B.md` 里有一条
Markdown 链接语法残缺（只剩右半边括号），被脚本解析成指向 `audit/` 目录的链接。
基线（我开工前第一次跑校验）时即存在，
且该文件属于 **W3-B** 窗口的任务书，本窗口不修改它。建议总审通知 W3-B 窗口处理。

## 七、给总审的一句话

编号 5（skill-queue 的 `window`）的现有注释是**主动论证过"这是设计如此"但结论为假**的典型，
建议把"兜底到 0"这个写法在全库扫一遍——同样的推理方式可能不止这一处。
