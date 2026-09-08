# 交付报告 · 窗口 W8-A（第 A 组）

> 单元：`autoquality` / `loot` / `meta`
> 条目：12（P1 9 / P2 3 组，P2 展开为 AQ4~AQ7、Lo5~Lo8、M5~M8 共 12 条）
> 回归测试：`tests/run_phase10_w8a.ts`（导出 `runPhase10W8ATests()`，**41 项**）
> 交叉验收：`audit/verify_W8-A.md`（验收 W8-B）

---

## 0. 结论与自检

| 项 | 结果 |
|---|---|
| 全量回归 `node .build/tests/run.js` | **通过 3696 项，失败 0 项**（开工前实测基线同为 3696，未下跌） |
| 新增用例 | 41 项（独立跑法见下） |
| 六个校验脚本 | `check-deps` ✓ / `check-links` ✓ / `scan-dt-guard` ✓ / `scan-num-guard` ✓ / `check-random-source` ✓ / `check-dup-exports` ✓ |

新增用例的独立跑法（`tests/run.ts` 按第 6 节纪律未改，交总审合并注册）：

```bash
bash build.sh
node -e "const m=require('./.build/tests/run_phase10_w8a.js');\
const f=require('./.build/tests/_framework.js');\
m.runPhase10W8ATests();f.summary();"
# → 通过 41 项，失败 0 项
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
| P1-7 | meta | P1 | 已修（附说明，见 §3.1） | `requires: ['不存在的节点']` → 构造不报错、`canUnlock("need") = {"ok":true,"cost":10}`、start 未解锁也能 `unlock("need") = 1`；**对照**：货币名拼错是构造即抛错 | 行为不变（遵守 README 承诺），但构造期收集进 `unknownRequires`，笔误有了可查出口 | › meta P1-7（2 条） |
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
| Lo8 | loot | P2 | 已修（补文档） | `add('z')` 后 `remaining` 从 5 变成 **0**，袋中剩余被丢弃 | 行为不变（袋子内容变了，剩余序列本就失效），补注释说明"add 会重洗整袋"；重洗后新元素能出现 | › loot Lo8（2 条） |
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
| `meta/MetaProgression.ts` | 构造期收集 `unknownRequires` + 查询接口；`set` 不乘等级；`setLevel` 用 `clampNum + floor`；`respec` 收口比例；`topoOrder` 改游标；新增 `destroy()` | — |
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

### 4.1 关于 `check-deps.js` 的一条残留说明

本批开工前，原始库上 `check-deps.js` 就报 **8 条**"import 了但没登记"
（`i18n` / `blessing` / `curse` / `rarity` / `achievement` / `rebind` / `gameflow` / `accessibility`
→ `_core`）。这 8 条来自其它窗口的改动，不是本批引入，本批也未触碰那些单元。

本批因为 `meta` 开始 import `_core`（用了 `clampNum`），**必须**补 `meta → _core` 的登记，
否则会变成 9 条。已补，现在仍是 8 条——与原始库一致，本窗口未让这个数字变差。
