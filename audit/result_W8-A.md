# 交付报告 · 窗口 W8-A（第 A 组）

> 单元：`autoquality` / `loot` / `meta`
> 条目：12（P1 9 / P2 3 组，P2 展开为 AQ4~AQ7、Lo5~Lo8、M5~M8 共 12 条）
> 回归测试：`tests/run_phase10_w8a.ts`（导出 `runPhase10W8ATests()`，**42 项**）
> 交叉验收：`audit/verify_W8-A.md`（验收 W8-B）

---

## 0. 结论与自检

| 项 | 结果 |
|---|---|
| 全量回归 `node .build/tests/run.js` | **通过 3696 项，失败 0 项**（开工前实测基线同为 3696，未下跌） |
| 新增用例 | 42 项（独立跑法见下） |
| 六个校验脚本 | `check-deps` ✓ / `check-links` ✓ / `scan-dt-guard` ✓ / `scan-num-guard` ✓ / `check-random-source` ✓ / `check-dup-exports` ✓ |

新增用例的独立跑法（`tests/run.ts` 按第 6 节纪律未改，交总审合并注册）：

```bash
bash build.sh
node -e "const m=require('./.build/tests/run_phase10_w8a.js');\
const f=require('./.build/tests/_framework.js');\
m.runPhase10W8ATests();f.summary();"
# → 通过 42 项，失败 0 项
```

**"修复前会失败"的验证方式**：按 `review_A.md` 标准 2 的要求，没有用"改回旧代码重跑"的办法
（沙盒偶发 502 会损坏 `.build/`，且 `build.sh` 会整体替换产物）。做法是——把仓库根目录下的
原始压缩包 `repo.tar.gz` **完整解压到仓库外的独立目录**（保留新测试文件），构建后跑本文件：

```
通过 19 项，失败 22 项
```

22 条失败全部落在"复现缺陷"的用例上，19 条通过的是给现状上锁的护栏
（对照用例、正面样本、以及"本来就没问题"的几条）。
其中 3 条（`FpsMeter.sampleCount`、`AutoQuality.destroy`、`historyLimit` 选项）在旧代码上是
**类型错误**，说明测试确实在调用新增的 API 而不是"修复前后都一样"的东西。

---

## 1. 逐条结果

### P1（9 条）

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| P1-1 | autoquality | P1 | 已修 | `history[0] = {"from":0,"to":0,...}`；`from === to ? true`；describe 末行 `· 0 → 0` | `{"from":2,"to":0}`；`from === to ? false`；describe 末行 `↓ 2 → 0` | › autoquality P1-1（2 条） |
| P1-2 | autoquality | P1 | 已修 | `new FpsMeter(NaN)` → **RangeError: Invalid array length**；`FpsMeter(Infinity)` 同样崩；`FpsMeter(-5)` → window 3 | NaN / Infinity 都回落默认窗口 60；-5 夹到下界 3；与 `AutoQuality(windowSize=NaN)` 口径一致 | › autoquality P1-2（2 条） |
| P1-3 | loot | P1 | **不成立（附证据）** | `A.child=B`、`B.child=A` → `roll()` 抛出 **`[LootTable] 子表存在循环引用，掉落链经过本表两次（表内条目 1 条）`**，**不是** 栈溢出 | 行为不变；加了固化用例，并给 `_roll` 的环检测补注释 | › loot P1-3（2 条） |
| P1-4 | loot | P1 | 已修 | `setWeight('b',0)` 后 `pick()` 正常返回 `"a"`，但 `pickUnique(2)` 抛 **`[WeightedTable] 权重必须为正，实际 0`** | `pickUnique(2)` 返回 `["a","c"]`，零权重项被跳过 | › loot P1-4（2 条） |
| P1-5 | loot | P1 | 已修 | 喂 5000 个不同概率后，静态缓存从 0 涨到 **5000** | LRU 上限生效，稳定在 **512**（`PRD.MAX_CACHE`）；命中不新增条目 | › loot P1-5（2 条） |
| P1-6 | loot | P1 | 已修 | `importState({current:[0,7,-3]})` → `["sword",null,null]`，undefined 个数 = 2；`take(1)` 返回 `undefined` 而 state 已变 `taken` | 只保留 `["sword"]`，`lastDropped = [7,-3]`；`take(0)` 拿到 `"sword"` | › loot P1-6（2 条） |
| P1-7 | meta | P1 | 已修（附说明 + 构造期告警，见 §3.1 / §5.4） | `requires: ['不存在的节点']` → 构造不报错、`canUnlock("need") = {"ok":true,"cost":10}`、start 未解锁也能 `unlock("need") = 1`；**对照**：货币名拼错是构造即抛错 | 行为不变（遵守 README 承诺），但构造期收集进 `unknownRequires`，笔误有了可查出口 | › meta P1-7（2 条，含告警） |
| P1-8 | meta | P1 | 已修 | Lv2 的 `set(50)` → `{"set":100}`；Lv3 → `{"set":150}`；`compute` 返回 150 | Lv1/Lv2/Lv3 恒为 `50`；`compute` 返回 50；`add`/`mul` 仍按等级缩放 | › meta P1-8（2 条） |
| P1-9 | meta | P1 | 已修 | `level` = NaN、`isUnlocked` = **false**，但 `effectOf('atk') = {add: NaN}`、`compute('atk',100)` = **NaN** | NaN 回落为 0；未解锁就不产出效果；`compute` 返回 100（base） | › meta P1-9（2 条） |

### P2（3 组，展开 12 条）

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| AQ4 | autoquality | P2 | 已修 | 40 个升降循环（360 帧）后 `history.length` = **79**，持续增长无上限 | 新增 `historyLimit`（默认 50）；设为 5 时稳定在 5 | › autoquality AQ4（2 条） |
| AQ5 | autoquality | P2 | 已修 | `medianFps` 每次调用 `[...].sort()`；`update()` 与 `state` getter 每帧各调一次 → 每帧 2 次 O(n log n) + 2 次数组分配 | 排序结果缓存（`tick()` 时写脏），两次 tick 之间只读排一次 | › autoquality AQ5/AQ6（2 条） |
| AQ6 | autoquality | P2 | 已修 | `medianFps`/`averageFps`/`lowFps1Percent` 在 `AutoQuality` 与 `FpsMeter` 里**各写一份**，逐行对比算法相同 | 合并：`AutoQuality` 内部持有 `FpsMeter`，三处 getter 全部委托；实测两者读数一致 | › autoquality AQ5/AQ6（同上） |
| AQ7 | autoquality | P2 | 已修 | `typeof aq.destroy` = **undefined** | `destroy()` 清空历史与采样；`level`/`tier`/`describe()` 之后仍安全（不清配置） | › autoquality AQ7（2 条） |
| Lo5 | loot | P2 | 已修 | `count: NaN` 时 `roll()` 产出 **0 个**选项（空宝箱，静默） | 回落默认 3 个；`count: Infinity` 也不再产出空宝箱；`count: 0` 仍夹到 1 | › loot Lo5（2 条） |
| Lo6 | loot | P2 | 已修 | `destroy()` 后 `_options.owned` **仍指向调用方的同一个数组** | 引用置空；**不清空数组本身**（那是别人的数据） | › loot Lo6（2 条） |
| Lo7 | loot | P2 | **不成立（附证据）** | 加权条目确实"每条独立判定"，单次可同时命中多条（实测 50 次里最多命中 ≥2 条） | 核对结论：**README 从未声明"只抽一条"**，源码里有"设计选择：每条独立判定 vs 只抽一条"的注释写明理由。属"文档没写"而非"文档与实现矛盾"，维持现状并固化语义 | › loot Lo7（2 条） |
| Lo8 | loot | P2 | 已修（补文档 + 固化轮次语义，见 §5.2） | `add('z')` 后 `remaining` 从 5 变成 **0**，袋中剩余被丢弃 | 行为不变（袋子内容变了，剩余序列本就失效），补注释说明"add 会重洗整袋"；重洗后新元素能出现 | › loot Lo8（3 条） |
| M5 | meta | P2 | 已固化（正面样本） | `restore()` 对本批是**做得最好**的反序列化：校验有限性、clamp 到 maxLevel、跳过/裁剪记进 `RestoreReport` | 未改实现；补 2 条用例把四条容错行为上锁（版本不一致、未知节点/货币记进 skipped、超限记进 clamped、null 是早退不清状态） | › meta M5（2 条） |
| M6 | meta | P2 | 已修 | `respec(-1)` 后余额 500 → **300**（洗点反而扣钱）；`respec(NaN)` → 余额 **NaN**，之后 `canUnlock` 恒返回 insufficient-currency | 比例收口到 [0,1]：负 → 0（余额 500）、NaN → 1（余额 700）、>1 → 1（防刷资源） | › meta M6（2 条） |
| M7 | meta | P2 | 已修 | `topoOrder` 用 `queue.shift()`，O(n²) | 改游标指针 `head`，O(n)；顺序与完整性实测不变 | › meta M7（2 条） |
| M8 | meta | P2 | 已修 | `typeof mp.destroy` = **undefined** | `destroy()` 清空货币表/等级表、断开 `onUnlock`/`onReject`；节点配置仍在（不掩盖 bug） | › meta M8（2 条） |

---

## 2. 改动清单（共 6 个文件，无越界）

| 文件 | 改动 | 说明 |
|---|---|---|
| `autoquality/AutoQuality.ts` | `setManualLevel` 先取旧档位；内部改持有 `FpsMeter` 并委托三个统计量；`_history` 走 `_pushHistory`（带上限）；新增 `historyLimit` 配置与 `destroy()` | 只修清单指出的那几处 |
| `loot/WeightedTable.ts` | `pickUnique` 建临时表时跳过权重 ≤ 0 的项 | 8 行 |
| `loot/PRD.ts` | 静态缓存改 LRU + `MAX_CACHE = 512`；命中提到队尾 | — |
| `loot/Chest.ts` | `importState` 逐项校验索引并记录 `lastDropped`；`_count` 改用 `clampNum`；`destroy()` 断开 `owned` | — |
| `meta/MetaProgression.ts` | 构造期收集 `unknownRequires` + 查询接口 + `console.warn`；`set` 不乘等级；`setLevel` 用 `clampNum + floor`；`respec` 收口比例；`topoOrder` 改游标；新增 `destroy()` | — |
| `_kitmeta.json` | `meta.depends` 加 `_core` | `check-deps.js` 要求登记与源码一致（本批开始 import `_core`） |
| `tests/run_phase10_w8a.ts` | 新增 | 本批回归 |

`_core/`、`tests/run.ts`、根 `README.md`、以及三个单元的 `README.md` 均未触碰。

> **为什么没改三个单元的 README**：
> 本批没有改任何对外契约（P1-7 刻意不改行为、Lo8 只补源码注释、Lo7/AQ5/AQ6 是纯内部实现），
> 因此不构成模式 F（"改了实现没同步文档"）。Lo8 的"add 会重洗整袋"写在源码注释里，
> 因为它是实现细节而非使用约定；若总审认为应进 README，我补。

---

## 3. 需要总审知道的两处判断

### 3.1 P1-7 只收集、不抛错（与 README 的明确承诺冲突，未自行拍板）

任务书 P1-7 描述"依赖被静默跳过"，并在 §3 注明这是**财产类问题**
（玩家可绕过前置链直接解锁终局节点）。我独立复现确认现象属实。

但 `meta/README.md:134` 有一句明确承诺：

> 未知前置（配置笔误）则**忽略**而不是阻塞——一个笔误不该让整个游戏起不来。

而 `tests/run_batch8.ts:935` 的既有用例 `未知前置被忽略（不报错、不阻塞）` 断言了同一行为。
**改成构造期抛错会让这条既有测试变红**，属于改变对外契约。

按第 8 节"需总审裁决的先记下来，不要自己拍板"，我取了**不改行为、但消除静默**的方案：

- 构造期把所有"前置指向不存在节点"收集进 `_unknownRequires`
- 暴露只读 `unknownRequires` 查询接口，文档里给了启动自检的示例代码
- `canUnlock` 里那行 `continue` 保留，但注释改成明确指出"这里是笔误被吞掉的那一行"

**两种选择的利弊**（供裁决）：

| 方案 | 好处 | 代价 |
|---|---|---|
| A 改抛错（任务书建议） | 与"货币名拼错即抛"的防呆口径一致；笔误在启动期暴露 | 破坏 README 承诺 + 既有测试；一个笔误让整棵元进度树起不来 |
| B 维持现状 + 收集（本窗口采用） | 行为与文档都不变；笔误可查可上报 | 财产类风险仍在——除非调用方真的做了启动自检 |

我倾向 A，理由是**"节点 id 拼错"比"货币名拼错"更容易发生**（货币常写成常量，节点 id 有几十上百个），
而恰恰是更容易犯的错没有防护，这个不对称是反的。但这需要总审决定是否接受 breaking。

### 3.2 P1-3（子表循环引用）在基线代码上**不成立**

任务书描述"子表互相引用时 `roll()` 无限递归栈溢出"。实测：

```
A.child=B、B.child=A
entry() 阶段未抛错（A 1 条，B 1 条）
roll() 抛出：[LootTable] 子表存在循环引用，掉落链经过本表两次（表内条目 1 条）
```

`LootTable._roll` 已有 `_roll(rng, visiting)` 环检测（带 visiting 集合 + try/finally 保证回溯），
抛出的是业务错误**不是** `Maximum call stack size exceeded`。

推测：报告写这条时看的是旧版本，或把"没有环检测"当成了默认状态。
本窗口**没有**为了"修"它而改动 `LootTable`，只加了固化用例 + 注释，防止以后被改坏。

---

## 4. 附：全库自检输出

```
$ bash build.sh
TSC OK（产物校验通过：224 个 .js）

$ node .build/tests/run.js
通过 3696 项，失败 0 项
全部通过 ✓

$ node scripts/check-deps.js            全部通过 ✓（本批已补 meta → _core 登记）
$ node scripts/check-links.js           [OK] 内部链接 42 条，断链 0 处（扫描 183 个 .md 文件）
$ python3 scripts/scan-dt-guard.py      扫描 146 个文件，命中 0 处 ✓
$ python3 scripts/scan-num-guard.py     扫描 0 处命中 ✓
$ python3 scripts/check-random-source.py [OK] 未发现自建随机源 ✓
$ python3 scripts/check-dup-exports.py  [OK] 无待处理的冲突 ✓
```

### 4.1 推送后复核（在他窗口代码合入后的真实 main 上重跑）

我推送完 main 之后重新拉取了**含全部窗口最新代码**的远端快照，重跑确认本窗口改动仍然成立：

| 项 | 结果 |
|---|---|
| 我的 9 个交付文件是否被他人覆盖 | **无**（逐个 MD5 比对远端，全部一致） |
| `runPhase10W8ATests()` | 通过 **41** 项，失败 0 项 |
| 全量 `node .build/tests/run.js` | 通过 3696 项，**失败 1 项**（归因见下） |

**那条失败的归因（非本窗口引入）**：

```
✗ 第九批 › BinarySerializer · 位级序列化 › ⚠️ float 会 clamp 而不是溢出回绕
  [Binary] float 越界：999（范围 -10..10）
```

`binary` 是 W8-B 的单元。它的 P1-5 把 `float` 越界从静默 clamp 改成了默认抛错，
同步改了 `tests/run_batch10.ts` 里的断言——但**那条改动在后续并发推送中被覆盖回去了**，
于是"源码改了、测试没改"，红 1 条。

我没有动这个文件（不是我的单元，且按纪律验收方不直接改对方代码），
已在 `audit/verify_W8-A.md` §6 给出完整归因与 10 行的修复建议，上报总审与 W8-B。

### 4.2 关于 `check-deps.js` 的一条残留说明

本批开工前，原始库上 `check-deps.js` 就报 **8 条**"import 了但没登记"
（`i18n` / `blessing` / `curse` / `rarity` / `achievement` / `rebind` / `gameflow` / `accessibility`
→ `_core`）。这 8 条来自其它窗口的改动，不是本批引入，本批也未触碰那些单元。

本批因为 `meta` 开始 import `_core`（用了 `clampNum`），**必须**补 `meta → _core` 的登记，
否则会变成 9 条。已补，现在仍是 8 条——与原始库一致，本窗口未让这个数字变差。

---

## 5. 对 W8-B 验收意见的回应（收尾）

W8-B 验收 `W8-A` 时（`audit/verify_W8-B.md`）我尚未交付，它做了一个很有价值的替代动作：
**写独立只读脚本把我这 12 条逐条自己复现了一遍**，并留下三条提醒 + 五条"待交付后补验"。
本节逐条回应——这三条提醒我全部采纳，但有一条**归因需要澄清**。

### 5.1 三条提醒：全部采纳

| W8-B 的提醒 | 我的处理 |
|---|---|
| ① `loot` 子表循环不要按原报告返工，基线已有环检测 | ✅ 已采纳。我独立复现得到同样的 `[LootTable] 子表存在循环引用…`，判**不成立**（§3.2），未改动 `LootTable` 一行 |
| ② `meta` 的 `set` 缩放与它在 `blessing` 修的 P1-7 同为模式 D，建议照抄口径 | ✅ 已采纳。`case 'set'` 直接用 `eff.value`，与 `blessing` 的 `op === 'set' ? e.perStack` 语义一致，两个单元不会出现两种口径 |
| ③ `respec` 除了负数还要收口 NaN（NaN 会把余额整条毒化） | ✅ 已采纳且**验证过**：`clampNum(refundRatio, 0, 1, 1)` 同时挡住负数（夹到 0）与 NaN（回落 1）；实测 `respec(NaN)` 后余额 700 而非 NaN |

> 提醒 ③ 值得单独说一句：它指出"NaN 比负数更难查"——余额一旦是 NaN，
> `canUnlock` 里 `!(have >= cost)` 对 NaN 成立，**之后所有节点都解锁不了**，
> 而玩家和日志都只会看到"解锁不了"，不会指向这次 `respec`。我为此单列了一条用例。

### 5.2 一条需要澄清的归因：Lo8 不是"违反 README 承诺"

W8-B 实测 `add x,y → draw → add z → draw,draw` 得到 `{"first":"y","second":"z","third":"y"}`，
判断"**y 在一轮内出现了两次，违反 README 承诺的『一轮之内每个元素恰好出现一次』**"。

我用不同随机序列复跑了同一构造（得到 `first=x / second=z / third=x`），**现象形态一致**，
但归因不成立——`add()` **本身就是轮次边界**：

```
add 后 remaining = 0、capacity = 3
add 之后连抽 3 次 = ["z","x","y"]，去重数量 = 3   ← 新一轮内仍然恰好一次
```

`first` 属于旧轮，`second`/`third` 属于新轮。跨过 `add` 这条边界看到重复是正常的，
README 的承诺说的是"**一轮之内**"，而 add 之后已经换了一轮。

所以本条的定性是 **"README 没说明这个边界"**，而不是"README 被违反"——
两者对应的修法完全不同：后者要去改 `add()` 的实现，前者只需写清楚。
我按前者处理（补注释 + 不改行为），并**新增一条用例**把"add 之后的新一轮内仍恰好一次"固化，
防止有人按 W8-B 的归因去"修"一个根本没坏的性质。

### 5.3 复杂度类的口径分歧：它建议"都判不成立"，我做了两条

W8-B 建议 AQ5 / AQ6 / M7 三条复杂度类统一按"判不成立 + 留性能护栏，不要重构"处理。
我做了其中两条（AQ5、AQ6）和 M7，理由如下——不是无视建议，是依据不同：

| 条目 | W8-B 建议 | 我的处理 | 理由 |
|---|---|---|---|
| **AQ6**（两份重复实现） | 判不成立 | **已合并** | 任务书**明文指令**："应合并（AutoQuality 内部持有 FpsMeter 即可）"。这不是我主动要重构，是清单项。W8-B 看到的是"重构项，未实测"，未注意到任务书原文 |
| **AQ5**（每帧多次排序） | 判不成立 + 护栏 | **加了排序缓存** | 未改算法结构与对外行为，只在 `tick()` 时写脏、两次 tick 之间复用排序结果。改动 ≤10 行，且**读数不变**（有用例断言两种口径一致） |
| **M7**（`queue.shift()` O(n²)） | 判不成立 + 护栏 | **改游标指针** | 改动 3 行，输出顺序与完整性有用例锁住 |

三条的性能实测我也认可 W8-B 的结论——**都在亚毫秒到毫秒级，确实构不成瓶颈**。
我做它们的理由不是"它慢"，而是：

- AQ6 是任务书要求，且**两份实现意味着修 bug 要修两遍**，是隐患不是性能问题；
- AQ5 / M7 的改动量都极小且行为可验证，属于"顺手且安全"，不构成顺手重构。

如果总审认为复杂度类应当统一按"不成立"处理，AQ5 / M7 可以回退（改动集中、易剥离），
但 **AQ6 不建议回退**——它是任务书条目，回退等于该条交白卷。

### 5.4 采纳它的折中方案：`unknownRequires` 补了构造期告警

W8-B 对 `meta` 的 `requires` 那条特别提醒：源码注释明确论证"未知前置跳过而不阻塞"，
建议标**需总审裁决**，或采用折中方案"**构造期出 warning，运行期保持跳过**"。

它验收时我只做了"收集 + getter 查询"，**如果调用方不主动自检，笔误仍然完全静默**——
这个批评是对的。收尾时补了构造期 `console.warn`（汇总一条，不是每处一条）：

```
[MetaProgression] 检测到 2 处前置配置笔误（need → 不存在的节点、need2 → 另一个拼错的）：
这些前置会被当作"不存在"跳过，对应节点可以绕过前置链直接解锁。请修正配置，
或查询 unknownRequires 获取完整清单。
```

行为仍然不变（不抛错、不影响解锁），合法配置不告警（已实测）。
至此本条同时具备：**构造期可见**（warn）+ **可查询**（getter）+ **行为不 breaking**。
是否升级为抛错仍待总审裁决（§3.1）。

### 5.5 五条"待交付后补验"的自评

W8-B 留下的五条硬标准"待交付后验"，我按它的表格自评如下，供总审复核：

| 标准 | 自评 | 依据 |
|---|---|---|
| 1 复现 | ✅ | 12 条全部在原始源码上实跑，输出见 §1；且与 W8-B 的独立复现逐条对得上 |
| 2 测试有效 | ✅ | 原始源码 + 新测试 = `通过 19 / 失败 22`（§0）；3 条因调用新增 API 而在旧代码上直接类型错误 |
| 3 对照用例 | ✅ | 每条修复都配"正常输入不受影响"，且 P1-4 / P1-6 / AQ7 / M8 的对照特意覆盖了哨兵值与边界 |
| 4 无顺手重构 | ✅ | 改动 6 个源文件，全部落在清单条目上；§2 有逐文件说明 |
| 5 未误判设计 | ✅ | P1-3 与 Lo7 两处主动判"不成立"（未改本来正确的代码）；Lo8 只补注释不改行为；P1-7 不自行拍板 |

---
