# 精审返工任务书 · 窗口 W5-A（第 A 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W5-A 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **15**（P1 9 / P2 6） |
| 单元 | **9** 个 |
| 来源批次 | batch1、batch5 |
| 所属组 | **第 A 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W5-B**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_A.md` 验收 **W5-B**。

---

## 1. 角色与纪律

你是**执行者**，不是审查者。拿到清单 → 复现 → 修 → 写测试 → 自检。

### 1.1 三条硬纪律

1. **不要顺手重构。** 只改清单指出的那一行/那一处。
   这个库大量"看起来别扭"的写法都带长注释解释原因；你"顺手优化"的代码，
   很可能是另一个单元赖以正确工作的前提。
   我自己就在 `prewarm` 上犯过——顺手把预热数夹到 `maxSize` 以内，
   既有测试立刻变红，因为那两个是**独立的契约**。

2. **改之前必须先复现。** 写个最小脚本跑出"修复前"的现象，把真实输出贴进报告。
   没有复现就不要改——报告里的"证据"是别的窗口写的，你要自己验证一遍。

3. **注释要写"为什么"，不是"改了什么"。**
   重点写：坑的表现是什么、为什么原写法会中招、为什么新写法是对的。
   这个库最大的价值就是这些注释——很多坑会换个地方重新长出来。

### 1.2 一个反直觉但很重要的口径

**注释/文档如果主动论证"这是设计如此"，你要格外警惕，而不是格外放心。**

真实案例：

- `perception` 的抖动注释写"只影响观感，不需要可复现"——实测抖动值直接喂进了 `alert` 累积，**注释前提是假的**。
- `_core` 的 `smoothDamp` 曾把失效的 maxSpeed 记成"Unity 标准行为，非 bug"，还附了实测数据和权威叙事——**数据为真、归因为假**。
- README 曾把已修的缺陷记成"设计如此"，导致后来的人看到文档就不去修。

**文档说"没问题"不等于真没问题。按证据判断，不按注释判断。**

---

## 2. 代码库速览

```bash
cd /data/workspace/AI-cocos--main
bash build.sh                    # 编译到 .build/（不要跳过）
node .build/tests/run.js         # 全量回归
```

`build.sh` 有产物自愈与**逐文件比对**（不是只比总数——总数校验抓不到"tests 少 23 个"的情况）。

### 2.1 七条铁律（违反会导致构建/校验失败）

| 铁律 | 内容 |
|---|---|
| 1 | **无引擎依赖**：不得 `import 'cc'`，只能用注入的适配器。唯一例外 `adapters/CocosAdapter.ts` |
| 2 | **不 import 引擎类型**：连 `import type { Node } from 'cc'` 也不行 |
| 3 | **运行时依赖 0**：不得 import 任何第三方包 |
| 4 | **配置驱动**：数值不得硬编码，要可配 |
| 5 | **可卸载**：有 `install` 必须有对应的 `uninstall`/`destroy` |
| 6 | **禁止横向 import**：单元之间不得互相 import（`_core` 例外） |
| 7 | **复制即可用**：使用者拷走目录后改 0 行 |

### 2.2 现成共享工具（`_core/`，**直接用，不要自己造**）

| 工具 | 用途 |
|---|---|
| `clampNum(v, lo, hi, def)` | 数值收口，**NaN 会回落到 def** |
| `numOr(v, def)` | 非有限值回落 |
| `safeDt(dt)` | dt 守卫（挡 NaN / 负数 / 过大） |
| `needCount(n, max?)` | 无界 count 守卫（挡 Infinity / NaN） |
| `hasOwn(obj, k)` | 原型链安全的 `in` |
| `assertSafePath(p)` | 路径写入的原型污染防护 |
| `MathRandomSource` | 唯一允许的随机源 |

**`_core/` 不在任何窗口的清单里，严禁修改。** 它被 55 个单元依赖，你改一行会影响另外 15 个窗口。

### 2.3 六个校验脚本（提交前全部要过）

```bash
node scripts/check-deps.js        # 依赖分层
node scripts/check-links.js       # 内部链接
python3 scripts/scan-dt-guard.py  # dt 守卫
python3 scripts/scan-num-guard.py # 数值收口
python3 scripts/check-random-source.py  # 随机源
python3 scripts/check-dup-exports.py    # 重复导出
```

⚠️ **临时验证脚本放 `verify/` 会导致 `check-deps.js` 报错**（该目录未登记分层）。
用完请删除 `verify/`，或直接放 `/tmp` 下。

---

## 3. 本批清单

### 3.1 你的单元（9 个，与其它 15 个窗口零重叠）

```
behavior-tree  fsm  number-roller  quest  signal  skill-queue  steering  telemetry  turn
```

---


## 【P1】先做这批

### P1 · [behavior-tree] `Wait` / `CooldownDecorator` 的秒数未收口：一个 NaN 让 AI 永久卡死或让冷却彻底失效

- **位置**：`BTNode.ts:365`（`_elapsed >= _seconds`）、`:285`（`_remain = _seconds`）、`:278`（`_remain > 0`）
- **现象**：`_seconds` 为 NaN 时，`_elapsed >= NaN` 恒 false → `Wait` 永远返回 `Running`；`_remain = NaN` 后 `NaN > 0` 恒 false → 冷却永不生效。两者都没用 `numOr` 收口，而 `_seconds` 通常来自配表。
- **证据**：600 帧内 `Wait(0.1s)` 返回 Success **85** 次，而 `Wait(NaN)` 返回 Success **0** 次（状态始终为 `Running`）（`b1_v4` [36]）。`CooldownDecorator(NaN)` 在 10 帧内让子节点执行 **10** 次，对照组 `_seconds = 1` 只执行 **1** 次（`b1_v3` [23]）。
- **后果**：配表里漏填/填错一个等待时长（`null` / `''` / NaN），对应 AI 分支**永久停在 Running**，整棵树的后续节点再也不执行——怪物站着不动、Boss 不放技能，且不报错、不看日志完全定位不到。冷却失效则表现为技能每帧释放。
- **建议**：两个构造函数里用 `numOr(_seconds, 默认值)` 收口，或在 tick 入口对 `_seconds` 做一次有限性检查后降级。

### P1 · [number-roller] `snapTo` 缺有限性校验，一个 NaN 让计数器永久显示 "NaN"

- **位置**：`NumberRollerCore.ts:129`~`:136`
- **现象**：`set()` 在 `:105`~`:107` 对非有限值 `throw`，但 `snapTo()` 没有任何校验，直接写 `_current`。写入后 `_rolling = false`，`update()` 开头直接 `return`，**永远无法自愈**。
- **证据**：`snapTo(NaN)` 后 `display = NaN`、`formatted = 'NaN'`（`b1_v2` [8]）。对照：`set(NaN)` 会 throw `[NumberRollerCore] 目标值必须是有限数`（`b1_v2` [8]）。
- **后果**：金币/伤害数字来自服务端返回或伤害结算，偶尔出现 null/NaN 时，UI 上永久显示 "NaN" 且不再滚动。玩家截图投诉，开发查伤害公式，实际源头是这个入口漏了校验。
- **建议**：`snapTo` 开头加与 `set` 相同的 `Number.isFinite` 校验（抛出或静默忽略需统一口径，建议抛出，与 `set` 一致）。

### P1 · [quest] `import()` 不校验 `status` 与 `progress` 元素类型

- **位置**：`quest/QuestSystem.ts:408-427`（`status: e.status` 直接写入，`progress[i] ?? 0` 不校验类型）
- **证据**：`import([{ id:'q1', status:'garbage', progress:['a'] }])` → `skipped=0`，`status='garbage'`，`progress=['a']`。
- **后果**：存档被篡改或跨版本后，任务进入一个枚举外的状态——`available`/`active`/`completed` 三个 getter 都查不到它，任务从 UI 上"消失"，但 `_defs` 里还在，`_refreshLocks` 每帧遍历它。更隐蔽的是 `progress=['a']` 让 `_isAllDone` 判定为已完成（`‘a’ < 5` 为 false），下次任何 `setProgress` 都会触发 completed + 发奖。
- **建议**：`import` 时校验 `status` 属于 `QuestStatus` 枚举、`progress` 元素是有限数，否则计入 `skipped`。

其他复核：`claim` 的防重复领奖（`:340-341` 查 `status==='completed'` 且 `!claimed`）正确，`repeatable` 任务在领奖后重置为 `available`（`:345-353`）且 `claimed` 归零，语义完整；`_unlockDependents` + `_refreshLocks` 双路径解锁（有冗余但都正确，且 `_refreshLocks` 在 `report` 末尾兜底）；`_matches` 的 `custom` 类型走 `test` 回调、其余比对 `type` 与 `target`，正确。`destroy()`（`:440-445`）清理完整。依赖为空（零依赖），无 rule6 违规。

---

### P1 · [signal] 同一函数注册多次时，一次取消会把所有同名注册项全部删掉

- **位置**：`signal/Signal.ts:79-91`（`_remove` 用 `findIndex((l) => l.fn === fn)`）、`:116-123`（收尾 `this._listeners.filter((l) => !this._pendingRemoval.has(l.fn))`）
- **现象**：`_pendingRemoval` 是 `Set<F>`，按**函数值**去重，而 `_listeners` 是"每个注册一条"的数组。收尾的 `filter` 会把**所有** `fn` 相同的条目一起删掉，与 `_remove` 的"只删一个"语义冲突。
- **证据**：
  ```
  场景 A（once + add 同一函数）：
    listenerCount=2 → emit() → n=1, listenerCount=0   ← add 的那条被连坐删除

  场景 B（emit 回调内取消）：
    emit 中 off() 后 listenerCount=0（期望 1）→ 再 emit 一次 n=0   ← 后续再也不会被调用
  ```
- **后果**：第 2 节"EventBus 旧取消函数误删同名新监听器"的**同类新实例**。典型踩法：`onScoreChange` 这类匿名性不强的回调被两个模块各注册一次（或用同一个具名函数注册到两个不同用途），任何一个模块取消订阅，另一个模块的回调也一起消失。表现为"某个 UI 突然不刷新了"，而代码里看不到任何错误。
- **建议**：`_listeners` 每条带唯一 `id`，`once`/`add` 返回闭包捕获自己的 `id`，`_pendingRemoval` 存 `Set<number>`（id）而不是 `Set<F>`。
- **影响面**：`signal` 是 L1 通用件，谁都可能用；目前库内无调用方（我 grep 过），但作为对外 API 风险最高。

其他复核：`emit` 的递归保护（`:100-103`）只 `console.warn` 就 return——外层调用方拿到的是"我 emit 成功了"，内层事件被丢弃。我列 P2/存疑（见存疑节）。`emit` 对监听者异常做了 try/catch + `console.error`（`:111-115`），一个坏监听者不会打断其他监听者，正确。

---

### P1 · [skill-queue] `window` 的 setter 用 `Math.max(0, v)`，传 `NaN` 会让所有排队项立即过期

- **位置**：`skill-queue/SkillQueue.ts:220-222`（`set window(v) { this._opts.window = Math.max(0, v); }`）
  `Math.max(0, NaN)` = `NaN`，且**这个分支只在 setter 上**——构造函数里 `:203` 是裸的 `opts.window ?? 0.25`，连 `Math.max` 都没有。
- **证据**：
  ```
  window=1.0，request('s1')，tick(0.1) -> count=1     （正常：还在窗口内）
  把 window 设成 NaN 再 tick(0.1)     -> count=0     （排队项被立即清空）
  stats.rejected = 1
  ```
  原因在 `:309`：`if (waited <= this._opts.window) continue;` —— `waited <= NaN` 恒为 false，所有项都被当成超时丢弃。
- **后果**：`window` 是可以在运行时用配置热更新的（比如难度自适应、不同角色手感不同）。一次热更新传入 `NaN`（配置解析失败、单位换算错误），结果是**整个输入缓冲静默失效**：玩家提前按的技能再也不会被缓存补发，手感瞬间变差，而 `describe()` 里显示 `窗口 NaNs`，日志里只有一条 `onReject('expired')`。这是本单元主打的核心功能（"提前点击自动延后释放"）。
- **建议**：`set window(v) { this._opts.window = numOr(v, 0.25); }`，构造函数里也用 `numOr`；或至少 `Math.max(0, numOr(v, this._opts.window))`（拒绝非法值、保持旧值）。

其他复核：`_pickVictim` 的优先级 + seq 淘汰策略（`:278-287`）正确（优先淘汰低优先级、同优先级淘汰最早的）；`tick` 的"先过期扫描 → 再按优先级尝试施放 → 非可重试立即丢弃"三段式（`:299-357`）逻辑清晰；`request` 里 `replaceSame` 的替换（`:248-256`）在容量检查**之前**，避免了"先挤掉别人再发现自己该替换"的顺序问题；`poll` 的 `peek`/`consume` 分离（`:369-377`）正确（只在 `request` 成功时才 consume）。依赖 `skill-caster` 属于 `依赖规则v2` 明确承认的唯一前置模块关系（文档 `:276` 的 `skill-queue(L3) → skill-caster(L2)`），**不算 rule6 违规**。**无 `destroy()`**（有 `clear()`）。

---

## 跨单元共性问题

### P1 · [steering] `mass` 未校验 → mass=0 直接产出 Infinity 坐标

- **位置**：`Steering.ts:553` `agent.force.x / agent.mass`；`createAgent` `:115` `mass: opts.mass ?? 1`（只兜 undefined/null）
- **证据**：`mass = 0` 时施加力后 `integrate` → `pos = (Infinity, NaN)`、`vel = (Infinity, NaN)`（`b1_v2` [9]）。
- **后果**：质量来自配置表或" massless 单位"（如子弹、纯运动学体）时填 0 是自然的想法，一旦填 0，单位坐标瞬间变 Infinity/NaN 并传染给所有依赖它的系统（Flock 邻居计算、避障）。扫描命中 23 处"除零风险"的典型一例。
- **建议**：`numOr(opts.mass, 1)` 后再 `Math.max(mass, 1e-6)`。

### P1 · [steering] `wander` 默认走裸 `Math.random`，与 F 类"随机数注入"直接冲突

- **位置**：`Steering.ts:238` 默认参数 `rand: () => number = Math.random`
- **证据**：不注入时连续两次 `wander` 返回不同结果（`{x:98.98, y:1.79}` vs `{x:98.35, y:-11.37}`）；注入固定 `rand` 后两次完全相同（`b1_v3` [29]）。
- **后果**：默认路径不可复现、不可测试——回放、录像、确定性 lockstep、单元测试全部失效。同类问题见 `telemetry.randomId`。这是 F 类明确要求"随机数走 `IRandomSource` 注入"的违反项。
- **建议**：把 `rand` 改为必填参数，或默认改成"未注入时首次调用抛错/告警"（与 `IRandomSource` 的用法对齐）。

### P1 · [telemetry] `maxRetries` 未收口 → 第一次发送失败就永久丢数据，与 JSDoc 矛盾

- **位置**：`Telemetry.ts:141`（`?? 3`）、`:276`（`if (this._retries <= this._maxRetries)`）
- **现象**：`maxRetries` 为 `''` / NaN 时，`_retries <= ''` 中 `''` 被转成 0，`1 <= 0` 恒 false → 第一次失败即丢弃，永不重试。
- **证据**：sender 恒失败、两次 `flush()` 后：`maxRetries = ''` → `buffered = **0**`；对照 `maxRetries = 3` → `buffered = **1**`（`b1_v3` [21]）。JSDoc `:270`~`:271` 明确写"超过上限才丢"。
- **后果**：配置来自远端下发或存档（`''`、null 极常见）时，一次网络抖动就永久丢失整批埋点。埋点缺口表现为"某天数据突然少一截"，无法回溯。
- **建议**：`clampNum(opts.maxRetries ?? 3, 0, 10)`。

### P1 · [turn] `start(shuffleEqual = true)` 声称打乱同先攻单位，实际完全不打乱

- **位置**：`turn/TurnSystem.ts:205`（`return shuffleEqual ? 0 : a.id.localeCompare(b.id);`）
  `Array.prototype.sort` 的比较函数返回 `0` 时保持原序（ES2019 起稳定排序），所以 `shuffleEqual=true` 的结果是**按添加顺序**。而且整个函数没有注入随机源。
- **证据**：6 个同先攻单位，三种调用全部输出 `u0,u1,u2,u3,u4,u5`。
- **后果**：README（`:72`）写 `start(shuffleEqual?)` 是"开始（排序）"，参数名暗示"打乱同分"。回合制里同先攻单位谁先手通常决定胜负（先手秒杀），配置为 `true` 的游戏实际永远是"先加入的先手"——一个**系统性的先手优势**，玩家会投诉"为什么总是他先打我"。
- **建议**：要么注入 `IRandomSource` 做真随机（与库内 `card`/`gacha` 的口径一致），要么把参数改名为 `stableOrder` 并更正文档。

其他复核：`_advance` 的 `guard`/`maxGuard` 防死循环（`:266-273`）到位；`_doRemove` 的 `if (idx <= this._cursor) this._cursor--`（`:324`）正确维护了游标；`orderPreview` 的取模遍历（`:387-391`）正确；`destroy()`（`:400-407`）清理完整。**P2**：`spendAP(-5)` 会让 AP 增加（实测 3 → 8），`:340` 应改为 `if (!(n > 0) || e.ap < n) return false;`。零依赖，无 rule6 违规。

---


## 【P2】P1 完成后再做

### P2 · [behavior-tree] （见正文）

- `trackedNodes` 是死功能：`BehaviorTree.ts:80`~`:81` 注释说"每个节点最近一次的状态（调试面板用）"，但内置节点（Selector/Sequence/Condition/Action/Wait）**一个都不调用 `recordNode`**。实测 tick 后 `trackedNodes.size = **0**`（`b1_v3` [23]）。调试面板恒空，JSDoc 措辞暗示自动追踪。
- `Repeater` `:239`~`:253` 把子节点 Failure 转成 Running（只有次数用尽才 Success），JSDoc `:225` 未说明吞掉 Failure；`_times = 0` 仍会执行 1 次；`_times = NaN` 退化成"无限"。
- `Parallel` `:152`~`:165` 每帧 tick 所有子节点，包括已 Success 的（会重复触发动作）。
- `_runningIndex`（Selector `:77` / Sequence `:115`）只写不读，纯装饰；`destroy` 对共享子节点会重复调用。

---

### P2 · [fsm] `can()` 在"转换表存在但当前状态缺项"时返回 true，白名单形同虚设

- **位置**：`StateMachine.ts:112`~`:116`
- **证据**：`transitions = { walk: ['run'] }`、当前态 `idle`（表中缺项）→ `can('jump') = true`、`can('teleport') = true`；对照组当前态 `walk`（表中有项）→ `can('jump') = false`、`can('run') = true`（`b1_v3` [24]）。
- **后果**：新增状态时忘了在 `transitions` 里补一行，该状态就**允许转换到任意状态**，且 `can()` 的返回值让宿主以为校验通过了。JSDoc `:62`~`:63` 只说"不填 = 允许任意"，没说"填了但缺项"也允许任意。
- **建议**：区分"未配置 transitions"与"配置了但缺项"，后者应返回 false（或按 `strict` 抛错）。

### P2 · [fsm] `reset()` 不检查 `_transitioning`、不触发 `onChange`；`start()` 可重复调用

- **位置**：`StateMachine.ts:201`~`:210`、`:98`
- **后果**：`enter` 回调抛异常时 `_current` 已切换、`_timeInState` 已归零，异常向上传播后状态机停在"已进入但未初始化"的中间态。

---

### P2 · [number-roller] （见正文）

- `duration.min/max/bigDelta/decimals` 全用 `?? 默认值`，未走 `numOr`。证据：`duration.min = NaN` → `isRolling = false`、`display = 5000`（直接跳到终值，**滚动动画静默失效**），对照组 `isRolling = true`、`display = 0`（`b1_v3` [20]）。
- `decimals = -1` → `toFixed(-1)` 抛 `RangeError`；`abbreviated` 硬编码 `toFixed(1)` 忽略 `opts.decimals`；`_overshoot < 1`（下冲）不生效但 JSDoc 只说"1 = 不过冲"。
- `formatted` 对 `-0.4` 输出 `"-0"`。

### P2 · [steering] （见正文）

- **注释说谎**：`:120` 注释写"向量工具（**就地操作**，避免 GC）"，但 `scale/add/sub/normalize` `:131`~`:151` **全部 `return v2(...)` 新建对象**，一个就地操作都没有。后果①：boids 每帧每单位数十次分配，与注释承诺的性能目标相反；后果②：调用方若按"就地修改"语义使用（`normalize(v); use(v)`）会拿到未归一化的 `v`。**注：这几个函数未导出，无法在运行时验证，此处为行号推导。**
- `circleFormation` `:514` 的 `index / count`，`count = 0` → `angle = NaN` → 返回 `{x: NaN, y: NaN}`。证据：`circleFormation(0, 0, 10)` 返回 `{"x": null, "y": null}`（JSON 序列化后的 NaN）（`b1_v2` [9]）。`formationOffset` 的 `columns = 0` 同理。
- `integrate` 的 `maxSpeed = NaN` → `speed > NaN` 恒 false → 不限速。

### P2 · [telemetry] （见正文）

- `flushIntervalMs = NaN` → `shouldFlush()` 恒 `true`（`:236` 的 `now - last < NaN` 为 false）。实测 `true` vs 对照组 `false`（`b1_v3` [21]）。后果：宿主轮询时每条事件都触发一次网络请求，流量与电量上升。
- `willSample` `:187` 直接查 `_eventSampleRates[name]`（默认 `{}`），`'constructor'` 等原型键会取到函数 → 采样判定恒 false。
- 无 `destroy()`（rule5）；`_stats.dropped` 不统计"重试超限丢弃"，与 JSDoc 口径不符；`flushSync` 名为 Sync 实为 async。
- `sampleRate` 未收口：**仅限非数字串**。实测 `sampleRate = '0.5'`（数字字符串）仍正常工作（50 次 capture 成功 32 次，符合 50% 采样）；但 `sampleRate = 'abc'` → 成功 **0** 次，全量静默丢失（`b1_v3` [38]）。


---

## 4. 贯穿全库的六个共享模式

这些模式在多个单元重复出现。**按模式统一修法，不要每个单元各写一套。**

### 模式 A · 否定式条件拦不住 NaN（最高频）

```ts
// ✗ 错：NaN 参与 <= 比较恒为 false，直接穿透
if (x <= 0) return;
if (amount >= s.count) return -1;

// ✓ 对：肯定式，NaN 时条件成立 → 正确拒绝
if (!(x > 0)) return;
if (!(amount < s.count)) return -1;
```

**本批最高频的错误形态。** JS 里 NaN 与任何值比较都为 false，否定式判断天然漏掉它。

### 模式 B · `??` 和 `Math.max` 都挡不住 NaN

```ts
// ✗ 错：?? 只挡 null/undefined；Math.max(0, NaN) === NaN
this._maxRetries = opts.maxRetries ?? 3;

// ✓ 对
this._maxRetries = clampNum(opts.maxRetries, 0, 100, 3);
numOr(v, 0)
```

### 模式 C · `importState` 绕过校验与事件

多个单元的存档导入直接写内部字段，**既不做数值校验、也不触发 `onChange`**，
导致"读档后状态对了但 UI 没更新"和"坏存档能写进任何值"。
涉及 `blessing` / `curse` / `settings` / `achievement` / `quest` / `leaderboard` / `buff`。

统一修法：导入走与 `set()` 相同的校验路径，并触发一次变更通知。

### 模式 D · `set` 类效果被层数/等级错误缩放

`blessing` / `curse` / `meta` 三个单元都有：`set`（覆盖）语义的效果被乘上层数/等级，与 `add`/`mul` 混为一谈。

### 模式 E · 遍历中修改集合

```ts
// ✗ 错：回调里注销自己会 splice 数组，下一个回调被跳过
for (const fn of this._onSpawn) fn();

// ✓ 对：遍历副本
for (const fn of [...this._onSpawn]) fn();
```

### 模式 F · 缺省配置与 JSDoc 承诺相反

`mover` 的 `maxExternal = Infinity`、`replay` 的 `seed = 0`、`telemetry` 的 `maxRetries` 等——
**默认值恰好让文档承诺的功能失效**。改法二选一：改默认值，或改文档说清真实语义。
**不要只改一个又不动另一个。**

---

## 5. 交付要求

### 5.1 每条修复的产出

1. **源码改动**：只改必要的那几行，附"为什么"注释
2. **回归测试**：一条在修复前**确实会失败**的用例
3. **对照用例**：一条验证"正常输入不受影响"的用例（防止矫枉过正）

### 5.2 测试放哪

新建 `tests/run_phase10_w5a.ts`，并**在文件内导出** `runPhase10W5ATests()`：

```ts
export function runPhase10W5ATests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W5-A.md`，每条一行：

```
| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
```

状态用：`已修` / `已修（附说明）` / `不成立（附证据）` / `需总审裁决`。

**"不成立"要有真凭实据**——贴出复现脚本和输出，说明为什么报告描述的现象不存在。
不要因为"看代码觉得没问题"就判不成立。

### 5.4 提交前自检

```bash
bash build.sh
node .build/tests/run.js                    # 必须全绿，条数只增不减
node scripts/check-deps.js                  # 全部通过（记得删 verify/）
node scripts/check-links.js
python3 scripts/scan-dt-guard.py
python3 scripts/scan-num-guard.py
python3 scripts/check-random-source.py
python3 scripts/check-dup-exports.py
```

---

## 6. 并行纪律（16 个窗口同时开工）

| 事项 | 约定 |
|---|---|
| **单元边界** | 16 个窗口**两两零重叠**，已程序化核验 |
| **分组** | 第 A 组 = `W*-A`，第 B 组 = `W*-B`。组间单元也零重叠（互补分工） |
| **`_core/`** | 谁都不要碰 |
| **`tests/run.ts`** | **总审统一合并**，你不要改 |
| **`README.md`** | 测试总数在变，**不要改**，总审统一更新 |
| **临时脚本** | 放 `/tmp` 或 `verify/`（用完删） |
| **`build.sh`** | 会整体替换 `.build/`；偶发 502 导致中断时**重跑一次**即可 |
| **文件命名** | `run_phase10_w5a.ts` / `result_W5-A.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 A 组**。修完之后，按 `audit/review_A.md` 验收 **W5-B**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W5-A.md`，
回报给对方窗口或总审。

---

## 8. 需要总审裁决的先记下来

遇到以下情况**不要自己拍板**，在报告里标"需总审裁决"并说明两种选择的利弊：

1. 修复会改变**对外 API 行为**（可能 breaking）
2. 报告建议的改法与单元 README 的**明确声明冲突**
3. 两处代码"看起来不一致但可能都是故意的"
   （例：相切语义——空间索引要求"不含相切"，通用 AABB 要求"含相切"，**两者都对**）
4. 你判断某条"不成立"

---

## 9. 最后一句

这个库现在 **3695 项测试全绿**，是你开工前的基线。
你交付时这个数字只能涨、不能跌——如果跌了，说明你的修复伤到了既有行为，
回去看第 1.1 节第 1 条。
