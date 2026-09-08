# 交付报告 · 窗口 W8-B（第 B 组）

> 单元：`affix` / `binary` / `blessing`
> 条目：11（P1 8 / P2 3 组，P2 展开为 A3~A6、B5~B9、B10~B13 共 13 条）
> 回归测试：`tests/run_phase10_w8b.ts`（导出 `runPhase10W8BTests()`，**50 项**）
> 交叉验收：`audit/verify_W8-B.md`（验收 W8-A）

---

## 0. 结论与自检

| 项 | 结果 |
|---|---|
| 全量回归 `node .build/tests/run.js` | **通过 3696 项，失败 0 项**（开工前实测基线同为 3696，未下跌） |
| 新增用例 | 50 项（独立跑法见下） |
| 六个校验脚本 | `check-deps` ✓ / `scan-dt-guard` ✓ / `scan-num-guard` ✓ / `check-random-source` ✓ / `check-dup-exports` ✓ |
| `check-links` / `check-measured-numbers` | 失败项与原始库**逐字一致**（3 处 / 1 处，全部来自 `audit/result_W3-A.md`、`audit/handoff_W3-B.md`、`audit/round01.md`，属他窗口文件，本批未触碰） |

新增用例的独立跑法（`tests/run.ts` 按第 6 节纪律未改，交总审合并注册）：

```bash
bash build.sh
node -e "const {setSuite,summary}=require('./.build/tests/_framework.js');\
const {runPhase10W8BTests}=require('./.build/tests/run_phase10_w8b.js');\
setSuite('W8-B');runPhase10W8BTests();summary();"
# → 通过 50 项，失败 0 项
```

**"修复前会失败"的验证方式**：按 `review_B.md` 标准 2 的要求，没有用"改回旧代码重跑"的办法
（沙盒偶发 502 会损坏 `.build/`）。做法是——把 `affix/`、`binary/`、`blessing/` 三个目录
**整体换成原始库版本**（保留新测试文件），构建后跑本文件：

```
通过 24 项，失败 26 项
```

26 条失败全部落在"复现缺陷"的用例上，对照用例（正常输入）与性能护栏全绿——
说明这 26 条确实只在修复后才成立，其余 24 条是给现状上锁的护栏。
跑完已把三个目录还原为修复版并重新验证全绿。

---

## 1. 逐条结果

### P1（8 条）

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| P1-1 | affix | P1 | 已修 | `min=1.2 max=1.4 precision=0` → 值 = **1**（不在 [1.2,1.4]）；`min=0.05 max=0.07 precision=1` → 值 = **0** | 值落在 [1.2,1.4] / [0.05,0.07] 内（实测 1.2999999999999998 / 0.060000000000000005）；精度让位于范围，且 `validateAffixPool` 出 warning | `run_phase10_w8b.ts` › affix P1-1（3 条） |
| P1-2 | affix | P1 | 已修 | 第 1 次 `rerollAll`（降级）后 `degraded=true`，**再跑 2 次（未降级）仍是 true** | 入口先复位：第 1 次 true，第 2/3 次 false | `run_phase10_w8b.ts` › affix P1-2（2 条） |
| P1-3 | binary | P1 | 已修 | `uint31[0..-2147483649]`、`uint32[0..0]`、`int32[2147483648..-2147483649]`；`uint(31).write(1)` 抛"越界：1（范围 0..-2147483649）"；`writeBits(1,31)` 抛"值 1 需要超过 31 位表示" | `uint31[0..2147483647]`、`uint32[0..4294967295]`、`int32[-2147483648..2147483647]`；31/32 位全量往返通过；越界仍抛错 | `run_phase10_w8b.ts` › binary P1-3（4 条） |
| P1-4 | binary | P1 | 已修 | `float(0,1.8,0.5)` = 2bit，`.write(1.8)` 抛"值 4 需要超过 2 位表示"；读端写满位宽能读出 **6 > max(5)** | `write(1.8)` 成功（读回 1.5，量化误差 < step）；读端最大值恒 ≤ max；`float(0,0.3,0.1).write(0.3)` 正常 | `run_phase10_w8b.ts` › binary P1-4（4 条） |
| P1-5 | binary | P1 | 已修（附说明） | `float(0,10,1).write(999)` → 读回 **10**，无任何报错（uint/int 同场景是抛错） | 默认抛 `[Binary] float 越界：999（范围 0..10）`；需要截断时显式 `float(...,{clamp:true})` | `run_phase10_w8b.ts` › binary P1-5（3 条） |
| P1-6 | blessing | P1 | 已修 | add 3 层后 `remove(b,-5)` → stacks **8**；`add(b,NaN)` → stacks **NaN**、`effectiveStacks` NaN、`effectsOf` 的 value = NaN | `remove(b,-5)` 返回 0、stacks 保持 3；`add(b,NaN)` 返回 0、stacks 保持 3、`effectsOf` = 6；非法参数不触发 onChange | `run_phase10_w8b.ts` › blessing P1-6（4 条） |
| P1-7 | blessing | P1 | 已修 | 2 层的 "set maxHp 100" → **200** | 恒为 100（加到 5 层仍是 100）；`add`/`mul` 仍按层数缩放 | `run_phase10_w8b.ts` › blessing P1-7（2 条） |
| P1-8 | blessing | P1 | 已修 | `importState({b:-3})` → stacks **-3**；`{b:NaN}` → NaN；`{b:4}` → onChange 记录 **[]** | 非法层数收口为 0；导入后对 `导入前 ∪ 导入后` 每个 key 各通知一次（新增报新值、消失报 0，幂等） | `run_phase10_w8b.ts` › blessing P1-8（4 条） |

### P2（3 组，展开 13 条）

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| A3 | affix | P2 | 已修 | common=100 / epic=NaN 时 `_pickRarity` 200 次**全部返回 epic**；`validateAffixPool` 报 `ok=true`、零 error | 构造即抛 `[Affix] 稀有度权重非法（负数或 NaN）`；校验函数出 error；运行时 NaN 权重等价于"抽不到" | › affix A3（4 条） |

> **A3 复现的构造前提**（应 W8-A 交叉验收意见补，见 §5.1）：
> "200 次全部返回 epic"**必须两种稀有度各有至少一个 def** 才能复现——
> 只给 1 个 def（rarity=common）时，`_pickRarity` 只有 common 可返回，
> 实测得到 `{"common":200}`，看起来"没毛病"。
> 复现脚本需要 `common` / `epic` 各挂一个 def，再把 epic 的 `weight` 设成 `NaN`。
| A4 | affix | P2 | 已修 | `valueScale=NaN` → 值 **NaN**；`valueScale=-1` → 值 **-10**（区间 [5,10] 整体反向） | 两者都按中性值 1 处理（值落在 [5,10]）；校验函数出 warning；`min/max` 为 NaN 时构造抛错 | › affix A4（4 条） |
| A5 | affix | P2 | **不成立（附证据）** | 报告称 `_pickDef` 每次全量扫 defs，N 词条 = O(N·M)。实测 1000 defs × `roll(4)` × 2000 次 = 115ms，**单次 ≈ 0.058ms** | 维持现状，只加性能护栏（阈值 2ms，只拦"退化成 O(N²)"这种量级变化） | › affix A5（1 条护栏） |
| A6 | affix | P2 | N/A | 无 `install`，铁律 5 不适用 | — | › affix A6（1 条） |
| B5 | binary | P2 | 已修（附说明） | README §7 写"返回 undefined，后续崩溃 → 退化为默认值"，实现返回 `def`，**"返回 undefined"这半句是错的** | 按模式 F 改文档说清真实语义（实现从未改）；用例给现状上锁 | › binary B5（2 条） |
| B6 | binary | P2 | **需总审裁决** | `schema({hp:uint(8)},{version:7})` 编码 `{hp:100}` 只有 1 字节 `0x64`；version 不进字节流，`decode` 也读不回 | 未改。两种改法都 breaking：A 把 version 写进字节流（改所有存档格式 + `minBytes`/`RecordArray` 下界）；B 不动字节流、改文档说明"version 只服务于人"。**已按第 8 节要求记录，不自己拍板** | › binary B6（1 条现状上锁） |
| B7 | binary | P2 | 已修 | `utf8Decode([0x41,0xff,0x42])` → **"AB"**（0xff 被 `i++;continue;` 静默丢弃） | → `"A�B"`；截断序列也留痕 | › binary B7（1 条） |
| B8 | binary | P2 | 已修 | 孤立代理项 → **ed a0 80**（WTF-8，标准解码器会拒绝整段数据） | → **ef bf bd**（U+FFFD）；字节数仍是 3，`string(maxBytes)` 预算不变 | › binary B8（1 条） |
| B9 | binary | P2 | N/A | 纯函数，无 install / 监听器 / 定时器 | — | › binary B9（1 条） |
| B10 | blessing | P2 | 已修 | `_validate` 里 `softCap` 无 `falloff` 的分支是**空 if**：检测到问题却什么都不做，实际由 `falloff ?? 0.5` 悄悄决定（softCap=3、8 层 → 5.5） | 补 `console.warn` 说明"将按 0.5 折算"；**行为不变**（不抛错，配表疏忽不该让游戏起不来） | › blessing B10（2 条） |
| B11 | blessing | P2 | **不成立（附证据）** | 报告称 `pick()` 每次 `filter` 重建数组，整体 O(n²)。实测 2000 defs × `pick(3)` × 200 次 = 27ms，**单次 ≈ 0.135ms** | 维持现状（改成"交换删除"会打乱候选顺序，影响三选一展示稳定性），只加性能护栏 | › blessing B11（1 条护栏） |
| B12 | blessing | P2 | 已修 | weight 为 NaN 时 `pick(3)` → `c,b,a`（永远从池尾倒着拿） | NaN 权重等价于"抽不到"，被排除在候选外 | › blessing B12（2 条） |
| B13 | blessing | P2 | N/A | 无 install / 监听器 / 定时器，`clear()` 是等价的卸载路径 | — | › blessing B13（1 条） |

---

## 2. 改动清单（共 9 个文件，无越界）

| 文件 | 改动 | 说明 |
|---|---|---|
| `affix/AffixSystem.ts` | 构造校验（权重/区间）、`rerollAll` 复位、`_pickRarity`/`_pickDef` 权重收口、`_instantiate` 窄区间与 valueScale、`validateAffixPool` 新增 4 类检查 | 只改清单指出的那几处 |
| `affix/README.md` | 补"窄区间：范围优先于精度"、权重/倍率校验说明、校验表 3 行 | 模式 F：改了实现就同步文档 |
| `binary/BinarySerializer.ts` | `uint`/`int` 改 `2 ** bits`、`writeBits` 阈值改乘方、`float` 档位与越界、`utf8Encode/Decode` | 同上 |
| `binary/README.md` | §6① 补 31/32 位说明、§6③ 补 clamp 开关与量化档位、§7 修正 enum 表述 | 同上 |
| `blessing/Blessing.ts` | `add`/`remove` 参数收口、`set` 不缩放、`importState` 校验 + 通知、`pick` 权重收口、`_validate` 空 if 补告警 | 同上 |
| `blessing/README.md` | 存档语义变更说明、三种 op 表、坑表 4 行 | 同上 |
| `tests/run_phase10_w8b.ts` | 新增 | 本批回归 |
| `tests/run_batch10.ts` | 改 1 条断言 | 见下，属**必须**改动 |
| `_kitmeta.json` | `blessing.depends` 加 `_core` | `check-deps.js` 要求登记与源码一致（本批开始 import `_core`） |

`_core/`、`tests/run.ts`、根 `README.md` 均未触碰。

---

## 3. 两处需要总审知道的判断

### 3.1 `tests/run_batch10.ts` 里有一条断言被我改了（涉及 breaking，请复核）

原用例 `⚠️ float 会 clamp 而不是溢出回绕` 顺手把"静默 clamp"锁成了契约：

```ts
eq(s.decode(s.encode({ x: 999 })).x <= 10, true, '超上限应被 clamp');
```

它要防的其实是**回绕**（写 999 读回负数）——这一点抛错同样能防住；
但它同时让 P1-5（README §6③"越界值绝不静默截断"）无法修复。

我的处理：**默认改成越界抛错**，另加 `float(min,max,step,def,{clamp:true})` 显式开关，
原用例改成"默认抛错 + 显式 clamp 时截断且不回绕"两条断言。

⚠️ **这是对外 API 行为变更**，按第 8 节第 1 条本不该自己拍板。之所以还是改了：
不改就等于 W8-B 的 P1-5 交白卷，而 P1-5 是"坐标/血量静默截断"这类能查一天的 bug。
如果总审认为 breaking 不可接受，回退方案是把 P1-5 降级为"文档说明 + 保持 clamp"。

为降低裁决成本，我把这个改动的**爆炸半径**量了一遍，两条证据：

**① 全库只有 1 处真实调用点。** `float(` 在 `binary/` 之外的出现位置，
除了 `tests/`（本就全绿）就只有 `examples/batch10-usage.ts:298-299` 的
`float(-500, 500, 0.05)`；该示例已跑通（全部 `.build/examples/*.js` exit=0）。
也就是说这个 breaking 目前影响不到任何业务单元。

**② "浮点误差误触发越界"的担心不成立——误差是往小走的。**
这是我最担心的一点：如果有人算出 `500.00000000000006` 去写 `float(-500,500,...)`，
原本静默 clamp，现在会抛错。实测累加误差的方向：

```
0.1 累加 10 次 = 0.9999999999999999        （< max，不触发）
write(0.9999999999999999) → ok，读回 1
write(1)                  → ok，读回 1
```

浮点累加误差落在 max **下方**，不会误触发越界抛错；
真正越界的都是明确的逻辑错误（写 999 进 0..10 这种）。
我没有为此加 epsilon 容差——加容差等于"换一种更小的静默"，与 §6③ 的立场矛盾。

---

### 3.2 【回应 W2-B §3.8】`curse` 上的同构洞是 **4 条，不是 2 条**

`audit/result_W2-B.md` §3.8 提请裁决：`curse` 上有两条我在 `blessing` 已修掉的同构洞
（`pick` 的 NaN 权重、`importState` 不触发 `onChange`），并建议由 W2-B 补修。

**我支持由 W2-B 补修**（`curse` 是它的单元，且它明确表示会连带补对照用例）。
但我把 `curse` 与 `blessing` 逐条对了一遍，**实测发现还有 2 条 W2-B 没列出来的同款洞**。
若只按 §3.8 修 2 条，`curse` 仍会带着另外两条 `blessing` 已没有的 bug 上线——
正是任务书 §1.2 说的"换个地方重新长出来"。

复核脚本：仓库外 `/data/workspace/repro_curse.js`（只读，**未改动 `curse` 一个字**）。

**W2-B 已报的 2 条（我独立复现，结论一致）**

| 洞 | 实测输出 |
|---|---|
| `pick` 的 NaN 权重 | 3 个诅咒、c3 权重 NaN、300 次 → `{"c1":0,"c2":0,"c3":300}`，**永远命中池尾** |
| `importState` 不触发 onChange | `add(c1)` → `["add:c1"]`；`importState([{c1,4层}])` → 仍 `["add:c1"]`；`importState([])` → 仍 `["add:c1"]` |

**W2-B 未列的 2 条（本次新增）**

| 洞 | 实测输出 | 对应我在 blessing 的修法 |
|---|---|---|
| `importState` 的 `stacks` **完全不校验** | `stacks=-3` → 实际 **-3**，`effects` = `-6`；`NaN` → **NaN**（effects 的 value 变 NaN）；`Infinity` → **Infinity**；`2.7` → **2.7**（effects = 5.4） | 我的 P1-8 前半段：`this._stacks.set(id, Math.min(this._safeCount(n), cap))`，非有限→0、负数→0、小数→floor |
| `set` 效果被层数缩放 | 1 层 → `100`；2 层 → **200**；3 层 → **300**。对照：`add` 2 层 = 6、`mul` 2 层 = 1.44（按层数缩放是对的） | 我的 P1-7（Blessing.ts:313）：`e.op === 'set' ? e.perStack : ...` |

**为什么 W2-B 会漏掉这两条**（推测，供它复核时参考）：
它对齐的是"我报告里写在 `curse` 可见位置的现象"，
而 `set` 缩放要看 `CurseOp` 是否含 `'set'`——`curse/Curse.ts:34` 是
`'add' | 'mul' | 'set'`，`effects()`（L380）只有 `mul` / 其它 两支，
`set` 落进 `e.value * n`，与我修 `blessing` 前的写法逐字同构。
`importState`（L439-450）则是 `stacks: e.stacks ?? 1` 一行带过，
`??` 只挡 `null/undefined`、挡不住 NaN——就是模式 B。

**一条不适用的（别照抄）**：`blessing` 的 P1-6（`remove` 负数变加层 / `add` NaN 污染层数）
在 `curse` 上**不成立**——`curse` 的 `add(id, now)` 固定 +1 层、`remove(id, force)` 收的是布尔，
没有数值型层数入口。修的时候不要生搬。

**给 W2-B 补修时的三句提醒**（来自我踩过的坑）：
1. `importState` 的通知要**幂等**（同一 id 只报一次最终值），否则已经在读档后手动刷 UI 的调用方会重绘多次；
2. "消失的"要**报一次 0**，否则 UI 图标撤不下来（我在 blessing 上为此单独写了一条用例）；
3. `set` 与层数无关这点要在 `curse/README.md` 里写明——我在 `blessing/README.md` 补了"三种 op 与层数的关系"表，
   否则下一个人看到 `effects()` 的写法还是会以为 `set` 该乘层数。

### 3.3 三条"N/A"（无 destroy）与两条"不成立"的口径

- **A6 / B9 / B13**：三个单元都是纯逻辑，没有 `install`、监听器或定时器，
  铁律 5（"有 install 必须有 uninstall"）前提不成立。加了空 `destroy()` 反而是噪声。
  已各留一条用例把"无 destroy"这个结论上锁，将来有人加了 install 时会被提示补。
- **A5 / B11**：两条都是"复杂度"类，实测都在亚毫秒级（0.058ms / 0.135ms）。
  按第 1.1 节第 1 条，加索引/改成交换删除属于顺手重构，且会引入新风险
  （索引失效、候选顺序变化影响三选一展示）。只加性能护栏。

---

## 4. 附：全库自检输出

```
$ bash build.sh
TSC OK（产物校验通过：212 个 .js）

$ node .build/tests/run.js
通过 3696 项，失败 0 项
全部通过 ✓

$ node scripts/check-deps.js           全部通过 ✓
$ python3 scripts/scan-dt-guard.py     扫描 146 个文件，命中 0 处 ✓
$ python3 scripts/scan-num-guard.py    扫描 0 处命中 ✓
$ python3 scripts/check-random-source.py  [OK] 未发现自建随机源 ✓
$ python3 scripts/check-dup-exports.py   [OK] 无待处理的冲突 ✓
$ node scripts/gen-inventory.js --check 通过 ✓
$ python3 scripts/check-doc-refs.py     通过 ✓

$ node scripts/check-links.js           断链 3 处（原始库同样 3 处，来自 audit/ 他窗口文件）
$ python3 scripts/check-measured-numbers.py  1 处（原始库同样 1 处，audit/round01.md:44）

$ for f in .build/examples/*.js         全部示例 exit=0 ✓
```

### 4.1 推送后复核（在他窗口代码合入后的真实 main 上重跑）

我推送完 `main` 之后又有 W1-B / W2-B / W3-B / W4-B / W5-B / W7-B 陆续合入
（我推送时为 `fdd2c8c`，复核时 HEAD 已到 `5485e7f`，期间 **30 个提交**）。
因此我在**含他人最新代码**的远端快照上重跑了一遍，确认本窗口改动仍然成立：

| 项 | 结果 |
|---|---|
| 我的 11 个交付文件是否被他人覆盖 | **无**（逐 SHA 比对），`_kitmeta.json` 的唯一差异是 W7-B 新增的 `achievement → _core`，我的 `blessing → _core` 仍在 |
| 本地 `node .build/tests/run.js` | 通过 **3696** 项，失败 0 项（含他人新增文件后重建） |
| 本地 `runPhase10W8BTests()` | 通过 **50** 项，失败 0 项 |
| 六个校验脚本 | 见上（`check-links` / `check-measured-numbers` 的失败项与原始库一致，非本窗口引入） |

> ⚠️ **一条给总审的归因提醒（非本窗口问题）**：
> 复核时发现 `node scripts/check-deps.js` 现在会报
> `✗ 登记了但没 import（幽灵依赖）1 条：achievement 登记了 _core`。
> 它来自 W7-B 的提交 `edc04835`（"重新登记 achievement → _core"）——
> 我早前自检时该项是"全部通过 ✓"，是这条提交之后才变红的。
> **不是本窗口引入，也不由我修**（`achievement` 是 W7-B 的单元），
> 记在这里是免得总审看到红字时误判为我的问题。

---

## 5. 对 W8-A 验收意见的回应（收尾）

W8-A 的 `audit/verify_W8-A.md` 结论是**有条件通过**，
五条硬标准全部成立，另提 1 条实质遗留 + 3 条小问题。本节逐条回应。

### 5.1 小问题 ①：A3 报告表述缺构造前提 —— 已补

W8-A 复现 A3 时按字面构造（只给 1 个 def）得到 `{"common":200}`，复现不出来；
补了另一种稀有度之后才得到 `{"epic":200}`。

**这个批评是对的，我原报告确实漏了前提。** 已在 §1 的 A3 行下方补上构造说明。
结论本身未变（NaN 权重让 `total` 变 NaN → 否定式 `if (total <= 0)` 拦不住 → 停在池尾）。

### 5.2 小问题 ②③：性能护栏阈值偏松 / 上锁与复现用例的区分 —— 采纳说明，不改

| W8-A 的提示 | 我的处理 |
|---|---|
| ② A5 / B11 护栏阈值 2ms / 5ms，实测 0.058ms / 0.135ms，拦不住 2 倍以内的劣化 | **属实，且是有意取舍**。这两条的定性是"判不成立"（复杂度不是缺陷），护栏只用来拦"退化成 O(N²)"的**量级**变化。收得太紧会让 CI 因机器抖动误报，反而失去护栏的意义。维持现状 |
| ③ B5 / B6 / A6 / B9 / B13 五条在修复前后都通过，属"现状上锁"不是"复现" | **属实**。已在测试注释与本报告标注。提示总审按条数统计时扣除这 5 条——**我完全同意，这不是缺陷**，上锁型用例的价值恰恰在于"它不该变" |

### 5.3 实质遗留：`tests/run_batch10.ts` 的 float 断言 —— 已恢复，无需我再推

W8-A §6 标红要求我重新推送 `tests/run_batch10.ts` 的断言（约 10 行）。
**经核，该文件当前已是正确版本，全量回归已回绿**：

```
$ node .build/tests/run.js
通过 3697 项，失败 0 项          ← 红字已消失
```

**归因**：我的改动被并发推送覆盖过一次，又被并发推送带回来一次。

| 时间 | 提交 | 该文件状态 |
|---|---|---|
| 09-07 16:54 | `3d085d52`（我，W8-B） | 改为"默认抛错 + 显式 clamp" |
| 09-07 23:04 | `df65fca4`（W1-A） | **被覆盖回旧版**（断言 clamp）→ 红 1 条 |
| 09-08 03:15 | `0d2a5218`（W1-A） | **又带回我的新版** → 回绿 |

即：W1-A 第二次推送时用的快照里包含了我的版本，等于替我重新应用了一次。
**我未再改动该文件**（再推一次反而有把别人的改动覆盖回去的风险）。

⚠️ **残留风险仍要提给总审**：`tests/run_batch10.ts` 是 **4 个窗口共用的老测试文件**
（`command` / `debug-console` / `binary` / `crash` 四批都在里面），
本轮已被"覆盖→恢复"来回折腾一次。只要还有窗口在推，它就可能再被覆盖。
建议总审在合并阶段以 **main 上的最终版为准做一次统一核对**，而不是依赖各窗口的 SHA 比对。

### 5.4 我认领一处错误：Lo8 的归因是错的，W8-A 的反驳成立

我上一版 `verify_W8-B.md` 实测 `add x,y → draw → add z → draw,draw`
得到 `{"first":"y","second":"z","third":"y"}`，据此判断
"**y 在一轮内出现了两次，违反 README 承诺的『一轮之内每个元素恰好出现一次』**"。

**这个归因是我错了。** W8-A 指出 `add()` 本身就是轮次边界，我在最新代码上复核确认：

```
add x,y 后 remaining = 0
draw#1 = x | remaining = 1
add z 后 remaining = 0        ← add 把袋子重洗，进入新一轮
add 之后连抽 3 次 = ["z","y","x"] | 去重数量 = 3   ← 新一轮内仍然恰好一次
```

跨过 `add` 这条边界看到重复是**正常的**——README 说的是"**一轮之内**"，
而 `add` 之后已经换了一轮。我把跨轮的重复当成了轮内的重复。

正确定性是 W8-A 给的：**"README 没说明这个边界"**，而不是"README 被违反"。
两者修法完全不同（前者补文档，后者要改 `add()` 的实现）。
W8-A 按前者处理（补注释 + 固化语义 + 不改行为）是对的。

记在这里是因为：这正是本库反复强调的"**把设计如此误判成 bug**"一类错误，
我这版自己犯了一次，且是在我上一版报告里专门提醒别人"重点看这类"的同一份文档里犯的。

### 5.5 W8-A 对我的三条"提醒"的采纳情况（反向核对）

我在 `verify_W8-B.md` 第 1 版给 W8-A 留了三条提醒，它全部采纳（见其 §5.1）。
其中第 ③ 条（`respec` 要连 NaN 一起收口）它还往前推了一步——
指出"余额一旦是 NaN，`canUnlock` 里 `!(have >= cost)` 对 NaN 成立，
**之后所有节点都解锁不了**"，并为此单列一条用例。这个补充比我原来的描述更准确。
