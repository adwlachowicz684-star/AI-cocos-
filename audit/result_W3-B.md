# 精审返工结果 · 窗口 W3-B（第 B 组）

> 本窗口 9 个单元：`cheatcode` `currency` `daily` `inventory` `ranking` `room-graph` `snapshot` `stats` `wave-spawner`
> 任务书：`audit/handoff_W3-B.md`（18 条 = P1 14 / P2 4 组）
> 测试：`tests/run_phase10_w3b.ts`（**40 项，全绿**；导出 `runPhase10W3BTests()`，**未注册进 `tests/run.ts`，等总审统一合并**）
> 基线：3695 项全绿 → 交付时仍 3695 项全绿（我的 40 项是新增，尚未并入 run.ts）

## 交付前自检

| 项 | 结果 |
|---|---|
| `bash build.sh` | TSC OK（212 个 .js，比基线 +1 = 新增的 `run_phase10_w3b`） |
| `node .build/tests/run.js` | **通过 3695 项，失败 0 项**（与基线持平，未跌） |
| `node /tmp/w3b/run.js`（本窗口 40 项） | 通过 40 项，失败 0 项 |
| `node scripts/check-deps.js` | 全部通过 ✓ |
| `node scripts/check-links.js` | **断链 1 处（基线既有，非本次引入）** — 见文末说明 |
| `python3 scripts/scan-dt-guard.py` | 命中 0 处 ✓ |
| `python3 scripts/scan-num-guard.py` | 命中 0 处 ✓ |
| `python3 scripts/check-random-source.py` | OK ✓ |
| `python3 scripts/check-dup-exports.py` | 无待处理冲突 ✓ |
| `_core/` | **未改动**（严守纪律） |
| `tests/run.ts` | **未改动**（等总审统一注册） |
| `README.md`（根） | 未改动 |
| 临时脚本 | 全部放 `/tmp/w3b/`，未建 `verify/` |

### 关于"修复前会失败"的验证方式

按 `review_B.md` 标准 2 的警告，**我没有用"改回旧代码重跑"的方式**（那会动 `.build/`，已真实发生过产物被覆盖的事故）。
我用的是：把关键的 5 处修复在 `.build/` 产物里**临时改回旧写法** → 用**独立只读脚本**跑出修复前输出 → 立刻从备份还原 → 重跑 `build.sh` 重建。

实测拿到的"修复前"输出：

```
[inventory 修复前] remainingSpaceFor = 9 | add(5) leftover = 5 | count = 1
[ranking   修复前] update(1450) progress= 0.000 | update(1490) progress= 0.000 toNext= 150 (分数涨了40)
[ranking   修复前] 宗师在前 dist = gm:10%,bronze:90%
[ranking   修复前] 诊断 = ["最高段位占比 90.0%，超过 5%"]      ← 把青铜的 90% 当成了最高段位
[room-graph修复前] truncated = true | total = NaN | path.length = 6
[wave      修复前] cleared + timeout=5 跑 20 秒：兜底 = null | state = fighting
```

---

## 逐条结果

### P1（14 条）

| # | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| 1 | cheatcode | P1 | 已修 | `historyLimit=NaN → history.length=2000`（0/-5 碰巧安全，唯独 NaN 穿透） | `=50`（`clampNum(...,0,1e5,50)`） | `run_phase10_w3b.ts` › cheatcode · historyLimit 的收口 |
| 2 | currency | P1 | 已修 | `logOf('gold',0).length = 5`（`slice(-0)` ≡ `slice(0)`） | `=0`；`logOf(id,2)=2`、`logOf(id)=5` 不变 | › currency · logOf(0) 与 netChange 的语义 |
| 3 | currency | P1 | 已修 | `logLimit=5` 下 20 次 `add(10)`：余额=200 **netChange=50** | `netChange=200`（改独立累加器，早于日志裁剪） | 同上 |
| 4 | currency | P1 | 已修 | `precision=400` → 初始余额=`NaN`，`add(5)` → `NaN` | `=100`，`add(5)=5`；`canAfford` 正常 | › currency · precision 越界不再让余额变 NaN |
| 5 | daily | P1 | **已修（附说明）** | 第 156 天撞车：`2026-06-06` 与 `2026-05-18` 共用 `ASH-ECHO-61` | 400 天**零撞车**；`seedToText` 覆盖 32 位（单射） | › daily · 种子文本空间与存档校验 |
| 6 | inventory | P1 | 已修 | `add('sword',1,0)` 后 `remainingSpaceFor=9`，但 `add('sword',5)` → leftover=5、count=1 | `remainingSpaceFor=0`（与 `add` 的 `!==undefined` 对齐） | › inventory · 堆叠查询口径 |
| 7 | inventory | P1 | **已修（附说明）** | `compact()` 返回 `void`，丢弃多少没有任何出口 | 返回被丢弃数量；被测场景报 `6`（10 个只装下 4 个） | › inventory · compact 的静默丢弃 |
| 8 | ranking | P1 | 已修 | 宗师在前 → `dist=[gm:10%, bronze:90%]`；青铜在前 → `[bronze:90%, gm:10%]` | 两种顺序都得到 `bronze,gm` | › ranking · 分布顺序 |
| 9 | ranking | P1 | 已修 | `update(1450) progress=0.000` → `update(1490) progress=0.000 toNext=150`（涨 40 分，进度条不动） | `update(1490) progress=0.267 toNext=110` = `tierOf(1490)` | › ranking · 段位未变时的进度 |
| 10 | room-graph | P1 | 已修 | `truncated=true  total=NaN  path.length=6` | `total=15`，且 `=== path.reduce(score)`（自洽） | › room-graph · 截断返回值 |
| 11 | snapshot | P1 | 已修 | `Uint8Array` 克隆后 `instanceof Uint8Array = false`，`constructor = Object`；类实例 `double 方法 = undefined` | 仍为 `Uint8Array`；类实例 `double() = 42` | › snapshot · deepClone 的原型与 TypedArray |
| 12 | stats | P1 | **不成立（附证据）** | 见下 | 见下 | › stats · 原型链查表（守护用例） |
| 13 | stats | P1 | **不成立（附证据）** | 见下 | 见下 | › stats · NaN 入参（守护用例） |
| 14 | wave-spawner | P1 | 已修 | `nextOn:'cleared'` + `wave.timeout=5`（全局 60）跑 20 秒 → 兜底 `null`、`state=fighting` | 兜底 `wave-timeout`、`state=cleared` | › wave-spawner · cleared 模式下的波次 timeout |

---

### P1-12 / P1-13 判定"不成立"的证据

按纪律"没有复现就不要改"，我先用只读脚本实测，两条的**现象均不存在**（已被别的窗口修掉）：

```
[stats 现状] get("toString")       -> throw: [Stats] 未定义的指标：toString（已定义：kills）
[stats 现状] get("hasOwnProperty") -> throw: ...未定义的指标：hasOwnProperty
[stats 现状] get("toLocaleString") -> throw: ...未定义的指标：toLocaleString
[stats 现状] tryGet / display       -> 0 / 0
[stats 现状] record('score', NaN)   -> throw: [guard] Stats.record(score).value 必须是有限数值，实际 NaN
[stats 现状] 再 record('score',10)  -> get = 10
```

- **P1-12**：`Stats.get()` 已经用 `hasOwn(this._derived, id)`（`stats/Stats.ts:229`），`derived()` 同步用了 `hasOwn`（`:273`）。`'toString' in derived` 那条路径不存在。
- **P1-13**：`record()` / `set()` 都已用 `needFinite(...)`（`stats/Stats.ts:188`、`:206`），且 JSDoc 里已经写了"实测 `record('hit', NaN)` 后 `display` 显示成 0"这个坑——**这条缺陷连同它的注释都已经在库里了**。

**我没有改这两处的任何代码**，只补了两条**守护用例**：
一旦有人把 `hasOwn` 改回 `in`、或删掉 `needFinite`，用例立刻变红。
按任务书 §8 第 4 条，此判定**报总审裁决**。

---

### P1-5 的修法与审查建议不同（需要总审知悉）

审查建议是「`seed` 直接用 `hashDateKey(date)`，只在展示时用 `seedToText`」。

**我没有采用**，理由是它会破坏本文件最重要的保证：

```
fromText(entryFor(d).seedText).seed === entryFor(d).seed
```

（`daily/README.md` §4「分享回填：文本必须是种子的真身」+ `tests/run_batch11.ts` 的既有回归用例）
种子一旦不再由文本派生，玩家分享出去的码就还原不出同一张图——**用一个新的静默不一致去换一个旧的**。

实际改法：**让 `seedToText` 无损覆盖 32 位**
`4bit(词A) + 4bit(词B) + 24bit(数字段) = 32bit`，于是 `seedToText` 是**单射**，
撞车只可能来自 `hashDateKey` 自身的 32 位碰撞（约 180 年一次，属已知全局议题），
25600 这个额外瓶颈消失。

代价：数字段从固定 2 位变成 2~8 位（`FROST-HALO-5217489`）。
`isValidSeedText` 同步放宽到 `{2,8}`，**旧的短码（如 `IRON-WOLF-42`）依然合法且映射到同一种子**——
因为种子是 `hash(text)`，文本字符串本身才是种子的来源，与编码规则无关。

### P1-7 只补出口，没有改丢弃行为

`compact()` 现在返回被丢弃的数量，但**仍然会丢弃**。
"整理不丢东西"要重新设计容量语义，属于另一个议题；
"丢了几个"必须让调用方知道，才能提示玩家或拒绝执行。

---

### P2（4 组）

| # | 单元 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|
| D3 | daily | 已修 | best 模式下 `submit(date, NaN, ...)` 静默返回 `false`，与"这次分不够"无法区分；更糟的是首次提交会把 `score:NaN` 写进记录，而 NaN 比较恒 false → **这条记录永远不会被更好的成绩覆盖** | 抛 `[guard] ...score 必须是有限数值` | › daily · submit(NaN) 不再静默丢弃 |
| D4 | daily | 已修 | `importState` 无条件 `set()`：`score:NaN` / `attempts:-3` / `date:'乱码'` 全部原样进入 | 逐条校验并**返回跳过条数**（实测 4 条坏数据 → `skipped=4`）；日期键按 `YYYY-MM-DD` 形状校验 | › daily · importState 拒绝坏存档 |
| D5 | daily | 已修 | xorshift32 的不动点是 0：`seed===0` 时三轮异或后仍为 0，加权抽取恒取池子第 0 项 | `seed===0` 时换成 `0x9e3779b9`；**其余 seed 的行为逐位不变**（加盐会改变所有历史日期的 modifiers，属于不可接受的 breaking） | › daily · 种子为 0 时不再退化 |
| D6 | daily | **需总审裁决** | `hasPlayedToday(now = Date.now())` 时间源未注入 | 未改 —— 见下 | — |
| D7 | daily | **不修（附证据）** | 报告称"`_attempts` 只增不减（只能靠 `prune` 手动清理）" | **已有出口**：`prune(beforeDateKey)` 同时清 `_records` 与 `_attempts`（`daily/DailyChallenge.ts:346`），且带 3650 天安全阀。属"已解决"，不重复修 | — |
| R2 | room-graph | **已修（附说明）** | `if (emptyType > 0 && emptyType < nodes.length) { }` —— 空 if 块 | 见下 | › room-graph · diagnose 暴露未分配类型数 |
| R3 | room-graph | **不修（附说明）** | `assignTypes` 每节点复制 weights 与 ctx，O(节点 × 类型 × 规则) | 纯性能项，改法涉及 probe 构造逻辑，风险 > 收益（非正确性缺陷） | — |
| R4 | room-graph | 已修 | `fixed:{3:'shop'}` 被 `ensureRestBeforeBoss` 无差别改写成 `rest` | fixed 指定的层**跳过**兜底；未设 fixed 时 Boss 前仍保证有休息房 | › room-graph · fixed 优先 |
| R5 | room-graph | **不修（附说明）** | `diagnose` 的 crossings 检测是 O(E²) | 同 R3，纯性能；且本单元已有 `maxPaths` 之类的配额保护 | — |
| R6 | room-graph | **需总审裁决** | `generateRoomGraph` 在 `diagnose` 不 ok 时整体抛错，无重试/降级 | 见下 | — |
| Sn3 | snapshot | **不修（附证据）** | `depthOf` 用 `[.[\]]` 计数，数组路径记 2、对象路径记 1 | 报告自己写"是 P0-2 的根因之一"，而 **P0-2 已由 `compareRemoveOrder` 修掉**（`snapshot/Snapshot.ts:323`）。`depthOf` 现在只用于 `applyPatch` 的 set 排序，改它会动到已修好的删除顺序 | — |
| Sn4 | snapshot | **不修（附说明）** | `deepClone` 递归无深度上限，深层链表会 RangeError | 加深度上限会**截断合法深层数据**（比 RangeError 更难查）；本单元的 `seen` 已能挡住循环引用 | — |
| Sn5 | snapshot | 已修 | `maxDepth=0 / -1 / NaN` → 根节点就 `depth>=maxDepth`，整棵树被当成"一个变化"，路径为空串 | `clampNum(maxDepth,1,1e4,10)`；实测三种坏值下路径都不再为空 | › snapshot · maxDepth 被收口 |
| Sn6 | snapshot | 已修 | 达到 maxDepth 时把**原对象引用**存进 `from/to` | 存 `deepClone` 副本；实测改动副本后原对象 `after.a.b.c.deep` 仍为 2 | › snapshot · 不再存原引用 |
| Sn7 | snapshot | **不修（附证据）** | 数组 diff 按下标比较，中间插入让后面全报 changed | 报告自己写"**语义正确**但噪声大"——不是缺陷，改了反而丢失"第 i 项变了"这个信息 | — |
| W2 | wave-spawner | **已修（注释归因纠正）** | 老注释："返回 null 也要计数，否则**生成失败会让 `_spawnDone` 永远不成立**" | **这条因果是错的**：`_spawnDone` 判定的是 `_pending.length === 0`，从不读 `_spawnedCount`。结论（要计数）对，归因错。已把注释改成真实口径："`_spawnedCount` = 已处理的 pending 数，`_plannedCount` = 计划数，两者之差 = 生成失败数" | — |
| W3 | wave-spawner | **不修（附说明）** | `_pending.shift()` 是 O(n²) | 纯性能；`_pending` 按 `at` 排序后从头部取，改成索引游标会动到 `_spawnDone` 的判定路径 | — |
| W4 | wave-spawner | **不修（附证据）** | `opts.rng` 注入后仅通过 protected getter 暴露，内部从未使用 | 已有注释"未使用的 rng 保留给未来的随机波次特性"（`wave-spawner/WaveSpawner.ts:730`），是**有意保留**的扩展点，不是死代码 | — |
| W5 | wave-spawner | **需总审裁决** | `FallbackInfo.aliveCount` 实际存的是 `killed.length` | 见下 | — |
| W6 | wave-spawner | **不修（附说明）** | 无 `destroy()` | 共性议题 6 已明确：本单元为纯逻辑无监听/定时器，建议"文档声明 N/A"而非硬凑空 `destroy()`。`abort()` 可作替代 | — |

### R2 的修法：暴露计数，而不是补 `issues.push`

审查建议是"明显漏写了 `issues.push(...)`"。

**直接补 push 会造成必崩**：`generateRoomGraph` 生成的图**全部节点 `type===''`**，
而它在 `diagnose().ok === false` 时**直接抛错**。一旦把 emptyType 计入 issues，生成函数 100% 抛错——
修一个静默 bug 换来一个必崩 bug。

实际改法：`Diagnosis` 新增 `untyped: number` 字段把数量暴露出来，由调用方按场景判断
（"只生成结构"是合法用法，跟"我明明分配了类型却漏了几个"是两回事）。
实测：`generateRoomGraph` 后 `untyped === nodes.length`；`assignTypes` 后 `untyped === 0`。

---

## 需总审裁决的 3 条

### ① D6 · `daily.hasPlayedToday(now = Date.now())` 时间源未注入

- **改法 A**：去掉默认参数，强制调用方传 `now`。
  - 利：与"统一时间源"的铁律一致（`todayKey(now)` / `today(now)` 都已是这个口径）。
  - 弊：**breaking**——所有 `d.hasPlayedToday()` 的调用点都要改；本库其他单元的同类默认参数（`curse.add` L134、`scheduler` L66）也是共性议题 8 的一部分，单改 daily 会造成口径不齐。
- **改法 B**：保留默认参数，在 JSDoc 写明"不传则取 `Date.now()`，测试请注入"。
  - 利：零风险。
  - 弊：与铁律的字面要求仍有距离。
- **我的倾向**：**B**，并且由总审在共性议题 8 里统一裁决（4 处一起改或一起豁免），单个窗口先动会造成新的不一致。

### ② R6 · `generateRoomGraph` 无重试/降级

- **改法 A**：加"重试 N 次，仍失败则降级为最简结构（每层 1 节点直连）"。
  - 利：与 wave-spawner 的"兜底哲学"一致，生成器永不失败。
  - 弊：`diagnose` 不 ok 目前**只可能来自 crossings**（随机结果有交叉），而 crossings 恰恰说明算法在某些种子下有结构缺陷——降级会**把这个信号彻底藏起来**，变成一个更难发现的静默问题。
- **改法 B**：保持抛错（现状），但在错误信息里带上 seed 与 issues，方便复现。
  - 利：错误响亮、可复现，符合本库"宁可报错不要静默"的整体取向。
  - 弊：调用方需要自己 try/catch。
- **我的倾向**：**B + 错误信息带上 seed**。理由是 R6 与 wave-spawner 的情况性质不同：
  wave-spawner 兜底的是"外部世界的不确定性"（怪卡住），room-graph 抛错的是"自己算法的确定性缺陷"，
  后者藏起来只会让 bug 活得更久。

### ③ W5 · `FallbackInfo.aliveCount` 名实不符

字段名叫 `aliveCount`，实际存的是 `killed.length`（被强制清除的数量）。
- **改法 A**：改字段名 → **breaking**，所有读 `info.aliveCount` 的调用点都要改。
- **改法 B**：保留字段名，加 JSDoc 说明真实语义 + 另加一个语义正确的字段。
- **改法 C**：把值改成真正的存活数（与 `get aliveCount()` 一致）。
  - ⚠️ 这条**有风险**：`onFallback` 的消费者可能已经在用这个数字做"清了多少怪"的统计，改成存活数会静默改变它们的含义。
- **我的倾向**：**B**（加注释 + 新增 `killedCount`，`aliveCount` 标 deprecated），给调用方一个迁移窗口。

---

## 关于 `check-links.js` 的 1 处断链（基线既有）

```
[✗] 内部链接 44 条，断链 1 处：
  audit/handoff_W3-B.md
      → ](...)  解析为 audit/...
```

来源：任务书 `audit/handoff_W3-B.md` **第 268 行**的行内代码

    `if (id in this._derived) { return this._derived[id](...) }`

其中的 `](...)` 被 markdown 解析成了链接语法。
**这是评审报告文件的既有内容，不是我引入的**（我在动手前跑基线时它就已经存在）。
按纪律我不改任务书文件，也未改 `check-links.js`。**请总审决定**：是修正任务书的行内代码写法，还是让 `check-links.js` 跳过代码块。

---

## 本窗口新增的测试

`tests/run_phase10_w3b.ts`，导出 `runPhase10W3BTests()`，**40 项全绿**。

覆盖了 9 个单元 × 「复现用例 + 对照用例」：

```
cheatcode · historyLimit 的收口          (3)
currency  · logOf(0) / netChange / precision (5)
daily     · 种子空间 / 回填 / submit / importState (7)
inventory · 堆叠查询口径 / compact 丢弃  (4)
ranking   · 分布顺序 / 进度条陈旧        (4)
room-graph· 截断 / 空 if / fixed 优先    (5)
snapshot  · deepClone / maxDepth / 引用  (5)
stats     · 原型链 / NaN（守护）         (3)
wave-spawner · cleared 模式 timeout      (4)
```

⚠️ **`tests/run.ts` 由总审统一合并注册，我未改动**（16 个窗口同时改必然冲突）。
注册后总数应为 3695 + 40 = **3735**。

---

# 推送后复核（在远程最新代码上重跑）

推送时远程 HEAD 是 `c8c1c0f`。推送完成后，W2-B（4 个提交）与 W8-B（2 个提交）
又陆续合入。所以我在**合并后的最新代码**（HEAD `81f05b0`）上重新拉了一份，
从头 `build.sh` + 全量测试 + 本窗口测试 + 六脚本校验，确认我的修复与别人的改动**不冲突**。

## 一、我的交付物是否还在

13 个文件逐个比对 blob sha，**全部与远程一致，未被覆盖**：

```
OK  cheatcode/CheatCode.ts        OK  ranking/RankTier.ts
OK  currency/Currency.ts          OK  ranking/SeasonReward.ts
OK  currency/CurrencyWallet.ts    OK  room-graph/RoomGraph.ts
OK  daily/DailyChallenge.ts       OK  snapshot/Snapshot.ts
OK  inventory/Inventory.ts        OK  wave-spawner/WaveSpawner.ts
OK  tests/run_phase10_w3b.ts      OK  audit/result_W3-B.md
OK  audit/verify_W3-B.md
```

（用 API 建 commit 时没有做 fast-forward 检查，理论上存在"后推覆盖先推"的风险，
所以这一步是必查项，不是走形式。）

## 二、合并后的测试结果

| 项 | 结果 |
|---|---|
| `bash build.sh` | TSC OK（**219 个 .js**，比交付时的 212 多 7 = 其他窗口新增的测试文件） |
| `node .build/tests/run.js` | **通过 3696 项，失败 0 项**（交付时 3695，+1 为其他窗口新增） |
| `tests/run_phase10_w3b.ts` | **40 项全绿** —— 我的修复在合并后的代码上依然成立 |

## 三、合并后六脚本：两处红，一处已修、一处非我引入

| 脚本 | 交付时 | 合并后 | 说明 |
|---|---|---|---|
| `check-deps.js` | ✓ | **✗ 1 项** | 非我引入，见下 |
| `check-links.js` | ✗ 1 处 | **✓ 0 处** | **已修根因**，见下 |
| `scan-dt-guard.py` | ✓ | ✓ | 命中 0 处 |
| `scan-num-guard.py` | ✓ | ✓ | 命中 0 处 |
| `check-random-source.py` | ✓ | ✓ | OK |
| `check-dup-exports.py` | ✓ | ✓ | 无冲突 |

### ① `check-links.js` —— 我修了根因（工具 bug，非各窗口的写法问题）

合并后断链涨到 **8 处**，分布在 4 个窗口的文件里
（`handoff_W3-B` / `result_W1-B` / `result_W2-B` / `result_W3-B` ×3 / `verify_W3-B`），
全部是同一个模式：

```
审计/xxx.md
    → ](...)  解析为 audit/...
```

**根因**：脚本用正则 `/\]\((\.[^)\s]+)\)/g` 在**全文**匹配 `](...)`，
没有排除 markdown 的行内代码与围栏代码块。
而 markdown 规范里，代码区的内容是**字面文本**——
在报告里引用一段含 `](...)` 的源码（比如讲解 `_derived[id](...)` 查表），
那不是链接，却被当成链接去解析。

各窗口为了让它变绿而去改自己报告的写法是治标不治本，
而且每多写一份报告就多几处误报。

**修法**：新增 `stripCode()`，匹配前先把围栏代码块与行内代码替换成等长空格
（保持字符数不变，避免把被代码隔开的两段文本拼成一个假链接），只在"散文"里找链接。

**修完验证**（注入测试，确认没削弱检测能力）：

```
注入内容                          期望        实际
真断链 ](./not-exist-really.md)   报出        ✓ 报出
单反引号 `](./nope-single.md)`    忽略        ✓ 忽略
双反引号 ``](./nope-double.md)``  忽略        ✓ 忽略
```js 围栏内 ](./nope-fence.md)   忽略        ✓ 忽略
真链接 [README](../README.md)     通过        ✓ 通过
→ 断链 1 处（只有注入的那条真断链）
```

断链 8 → **0**，链接总数 44 → 40（减少的正是代码区里的"链接"）。

### ② `check-deps.js` —— 5 条 `_core` 未登记，**不是我引入的**

```
✗ import 了但没登记（复制时会漏文件）5 条：
    i18n → _core
    curse → _core
    achievement → _core
    rebind → _core
    gameflow → _core
```

**证据**：

1. 这 5 个单元**没有一个属于 W3-B**（我的 9 个单元登记是干净的）。
2. 我推送前跑过 `check-deps.js`，**exit=0 全过**——当时远程还是 `c8c1c0f`。
3. 差异出现在 `c8c1c0f` 之后的提交里：远程最新的 `achievement/Achievement.ts`
   比我开工时的基线多了一行 `import { clampNum } from '../_core/math';`，
   而 `_kitmeta.json` 的 `depends` 没同步——**import 加了、登记没跟上**。

**我没有替他们修**，理由：`_kitmeta.json` 是共享元数据，且这 5 个单元各有归属
（`i18n` / `gameflow` 属 W4-A 一侧，`curse` 与 W8-B 的 blessing 同构）。
他们可能打算补登记，也可能打算改成不依赖 `_core`——
我按其中一种改了，就会和另一种撞车。

**给总审的建议**：直接跑 `node scripts/check-deps.js --fix` 即可（脚本自带标准修复，
只是把确实存在的 import 补进 depends），或指派那几个窗口各自处理。

---

# 交叉验收收尾（W3-B 验收 W3-A · 已完成）

> 本节记录本窗口**验收阶段**的收尾，与上面的"推送后复核"（**修复阶段**）是两件事。

## 一、验收动作与产物

| 项 | 值 |
|---|---|
| 被验收窗口 | `W3-A`（6 单元 `camera` `interact` `perception` `score` `settings` `tween`，16 条） |
| 被验收提交 | `63c0bee`（2026-09-07 15:12:27）+ `d280164`（报告改 1 行） |
| 验收产物 | `audit/verify_W3-B.md`，提交 **`9e188aa`**（22484 字节，**仅此 1 个文件**） |
| 结论 | **有条件通过** |

**验收不是读报告**，三条硬手段都留下了可复现的命令：

1. **独立回退实验**——整库复制到 `/tmp`，`patch -p1 -R` 反向应用 W3-A 对 7 个源文件的改动，重新编译后跑它的 `run_phase10_w3a`。
   前提已核：这 7 个文件自 `63c0bee` 后**再无人改动**，所以"当前 main − W3-A 的 patch"精确等于"W3-A 开工前"。
   ⚠️ 采用的是**独立副本**回退，不是 `review_B.md` 禁止的"在正式沙盒里改回旧代码"（那会损坏 `.build/`）。
2. **166 万帧参数扫描**——只读调用 `_core.smoothDamp`（9 dt × 11 smoothTime × 7 maxSpeed × 6 距离 × 400 帧），独立复核 P1-1。
3. **逐行 patch 比对**——把 7 个源文件的删除行全部列出核过。

## 二、核心量化结论

| 指标 | 结果 | 说明 |
|---|---|---|
| 回退后变红用例 | **29 / 62** | 直接回答"回退修复后这条断言还成立吗"——测试真的咬住了修复 |
| 未变红的 33 项 | 性质全部清楚 | `P1-1` 判不成立（只上锁）、`P1-4` 纯类型修复（回退后 **tsc 报错**）、`P1-5` 第五批已修、其余为对照用例 |
| P1-1 扫描 | 峰值 **0.9964**，超速 **0** 帧 | 判"不成立"正确；但源码注释里"稳态可达 2×maxSpeed"**从未被观测到**——结论对、支撑理由错 |
| 源码删除行 | 7 个文件各 **-3 ~ -11** | 条条对得上清单，**无顺手重构**；`_core/` 一行没碰、自定 `Rect` 没合并 |

## 三、需要总审处置的清单（4 项，按优先级）

### ① 🔴 `P2-settings` 的 `snapshot()`——报告说"未动"，代码里改了（W3-A）

`result_W3-A.md` §4 写"本窗口**未动** `snapshot()`……需要总审定夺"，但 `63c0bee` 实际改了实现
（只列"当前值 ≠ 已生效值"）、新增 `markRestartApplied()`，并改写了既有测试 `tests/run_batch16.ts` 的断言。

- 这正是 `handoff_W3-A.md` §8 第 1 条要求上交的情形（**修复会改变对外 API 行为**），报告识别出来了，代码先落地了。
- 影响面已核：`pendingRestart` 只有 `settings` 内部与那一条既有测试在用，`examples/` 无引用，README 已同步，**技术自洽、全量没变红**。
- **我的倾向：追认**（新断言覆盖"没改 / 改了 / 改回原值"三种情形，比原断言更严），但请记进流程台账，并让 W3-A 把报告改成实情。

### ② ⚠️ main 当前红 1 项：`BinarySerializer`——责任方 **W8-B**，与 W3-A 无关

```
✗ 第九批 › BinarySerializer › ⚠️ float 会 clamp 而不是溢出回绕
  [Binary] float 越界：999（范围 -10..10）
```

- 用例在 `tests/run_batch10.ts:766`（**既有**断言，期望越界 float 被 clamp）
- `binary/BinarySerializer.ts` 最后一次改动是 `3d085d52`（**W8-B**，16:54），把越界 float 从"静默 clamp"改成"抛错"
- W3-A 提交于 15:12，**早于** W8-B 且 6 单元不含 `binary` → **W3-A 报告的"3696 全绿"在它那个时间点属实，不是谎报**
- 二选一：W8-B 同步既有断言（改法有 README §6③ 依据），或回退实现。**我不擅自改**（非本窗口单元）

### ③ ⚠️ README 文件索引行丢失（W3-A 误删事故的残留，唯一未恢复项）

`63c0bee` 误删 `旧版本迁移说明.md` 时顺带删了 `README.md` 里指向它的一行；
后续抢救提交（`8c0b3b5`）恢复了**文件**，但**索引行没补回**（现在 `grep 旧版本迁移说明 README.md` 仍 0 命中）。

需补回的那一行（放在 `异常数值修复计划.md` 那行之后）：

```
| `旧版本迁移说明.md` | **v0230 → v0.39.0 的接口变更**（`save` / `room-graph`），只影响早期拷贝出去的测试项目 | 复制分发，务必留 |
```

文件在、索引丢——恰好命中这行注释自己强调的场景（"复制分发，务必留"）。
根目录 `README.md` 按纪律由总审统一更新，**我不动**。

### ④ `check-deps.js` 8 条 `_core` 未登记

```
i18n / blessing / curse / rarity / achievement / rebind / gameflow / accessibility → _core
```

（比本窗口上一轮记录的 5 条多了 `blessing` `rarity` `accessibility`，是其他窗口新加的 import 没跟上登记。）
**这 8 个单元都不属于 W3-B**，本窗口 9 个单元的登记是干净的。建议 `node scripts/check-deps.js --fix`。

## 四、推送后复核（验收报告推送后，在最新 main 上重跑）

推送完 `verify_W3-B.md` 后，另有 4 个窗口（W5-B / W1-B / W7-B / W4-B）合入了验收报告。
已核：这 4 个提交**只改 `audit/*.md`，未动任何代码**，因此验收结论的代码基线未变。

在最新 main（HEAD `5e55ba0`）上重新拉代码、从头 `build.sh` 后实测：

| 项 | 结果 |
|---|---|
| `bash build.sh` | TSC OK（**227 个 .js**） |
| `node .build/tests/run.js` | **3696 通过 / 1 失败**（失败项即上文 ③ 的 binary，非本窗口） |
| `tests/run_phase10_w3b.ts`（本窗口） | **40 项全绿** —— 我的修复在合并后的代码上依然成立 |
| `tests/run_phase10_w3a.ts`（被验收方） | **62 项全绿** —— 验收结论建立在被测代码之上 |
| `tests/run_phase10_w7a.ts`（事故抢救复核） | **44 项全绿** —— 上一轮抢救的 W7-A 成果仍完好 |
| `check-links.js` | **0 处**（我的新报告含大量代码块/表格，已确认未引入误报） |
| `scan-dt-guard` / `scan-num-guard` / `check-random-source` / `check-dup-exports` | 均 ✓ |

**交付物 blob 比对**：本窗口 13 个交付物逐个比对远程 blob，
**12 / 12 一致，未被任何人的后续推送覆盖**（第 13 项 `audit/verify_W3-B.md` 的差异就是我本次推送的新版，属预期）。

## 五、本窗口提交总审的裁决项汇总（便于一次性处理）

| # | 来源 | 事项 | 我的倾向 |
|---|---|---|---|
| 1 | 修复阶段 | `D6` `daily.hasPlayedToday` 时间源未注入 | 改法 B（保留默认参数 + JSDoc），由总审在共性议题 8 里统一裁决 |
| 2 | 修复阶段 | `R6` `generateRoomGraph` 无重试/降级 | 改法 B（保持抛错 + 错误信息带 seed） |
| 3 | 修复阶段 | `W5` `FallbackInfo.aliveCount` 名实不符 | 改法 B（加注释 + 新增 `killedCount`，`aliveCount` 标 deprecated） |
| 4 | 修复阶段 | `P1-12` / `P1-13`（stats）判"**不成立**" | 已附实测证据，只补守护用例，未改代码 |
| 5 | **验收阶段新增** | W3-A `snapshot()` 报告与实现不一致 | **追认**改动 + 记进台账 + 报告改成实情 |

## 六、给后续窗口的一条经验（可复用）

本轮验收最有效的一招是**副本回退**：它把"标准 2 · 测试是否真的会失败"
从"逐条推测"变成了"一个数"（29/62），且不触碰正式沙盒的 `.build/`。
代价是整库复制 + 一次完整重编译（约 2 分钟），对 16 个窗口的交叉验收完全值得。
建议写进 `review_A.md` / `review_B.md` 作为可选项。
