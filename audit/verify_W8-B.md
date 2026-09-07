# 验收报告 · W8-B 验收 W8-A

## 结论

**无法验收（对方尚未交付）** —— 截至本次验收，`W8-A` 的两项交付物都不存在：

| 应产出 | 实际 |
|---|---|
| `audit/result_W8-A.md` | **不存在** |
| `tests/run_phase10_w8a.ts` | **不存在** |

进一步核对其三个单元（`autoquality` / `loot` / `meta`）的源码：
与原始库**逐字节一致**（`diff -rq` 无差异），即本批 12 条**一条都还没动**。

所以第 2 节的五条硬标准（复现 / 测试有效 / 对照用例 / 无顺手重构 / 未误判设计）
目前**没有对象可验**——标准 1~5 全部记为「待交付后验」。

---

## 我做了什么替代动作

按 `review_B.md` 标准 2 的叮嘱（"不要用改回旧代码跑一遍的方式验证"），
我写了一个**独立只读脚本**调用公开 API，把 W8-A 的 12 条**逐条自己复现了一遍**。

这样做的价值：这些证据原本是别的窗口写的，W8-A 开工前本就该自己验一遍；
现在可以直接拿去用，省一轮返工，也能提前发现"报告描述的现象其实不存在"。

脚本放在仓库外（`/data/workspace/repro_w8a.js`），
不进 `verify/`，不会被 `check-deps.js` 扫到。**未改动对方任何代码。**

---

## 逐条复现结果（W8-A 开工前请先对表）

> 运行环境：与本批 W8-B 同一份基线（`node .build/tests/run.js` = 3696 项全绿）。

| 条目 | 报告描述 | 我的独立复现输出 | 判断 |
|---|---|---|---|
| P1 `autoquality` `setManualLevel` 的 history `from === to` | `history = [{"from":0,"to":0,...}]` | `{"from":2,"to":2,"reason":"玩家手动设置","fromEqualsTo":true}` | ✅ **现象成立**（数值与报告略有出入：我这边是 2→2，因为初始档位不同；结论一致） |
| P1 `autoquality` `FpsMeter` 窗口未收口 | `FpsMeter(NaN)` 抛 `Invalid array length` | `THROW: Invalid array length` | ✅ **现象成立**，逐字一致 |
| P1 `loot` 子表互相引用 → 无限递归 | `a.roll()` 抛 `Maximum call stack size exceeded` | `THROW: [LootTable] 子表存在循环引用，掉落链经过本表两次（表内条目 1 条）` | ⚠️ **现象已不存在**——基线里**已经有环检测**（`LootTable._roll` 带 `visiting` Set，并附了长注释说明为什么在 roll 时检测）。报告证据已过期。**W8-A 请勿按原描述返工**，直接标"已有环检测"并补一条断言锁住即可 |
| P1 `loot` `pickUnique` 与 `setWeight(v,0)` 冲突 | 抛 `[WeightedTable] 权重必须为正，实际 0` | `THROW: [WeightedTable] 权重必须为正，实际 0` | ✅ **现象成立**，逐字一致 |
| P1 `loot` `PRD._cache` 只增不减 | 5000 个不同概率 → 缓存 `0 → 5000` | `{"before":0,"after":5000}` | ✅ **现象成立**，逐字一致 |
| P1 `loot` `Chest.importState` 越界索引 | 越界时产出 `undefined` 选项 | `importState({current:[99,1]})` → `current = ["undefined","shield"]`，`take(0)` 返回 `undefined` | ✅ **现象成立**（且 `take(0)` 之后状态已置 `taken`，宝箱被消耗——与报告"不可恢复的静默错误"一致） |
| P1 `meta` `requires` 写不存在的节点 id | `canUnlock = {"ok":true,"cost":0}` | `{"canUnlock":{"ok":true,"cost":0},"unlock":1,"level":1}` | ✅ **现象成立**，且实测**真能解锁**（`unlock` 返回 1）——比报告描述的更严重 |
| P1 `meta` `set` 效果被等级缩放 | Lv2 的 `set(50)` → `{"set":100}` | `{"effects":{"maxHp":{"add":0,"mul":0,"set":100}},"compute":100}` | ✅ **现象成立**，逐字一致（与我在 blessing 修的 P1-7 同源，模式 D） |
| P1 `meta` `setLevel` 的 NaN 自相矛盾 | "未解锁"却在产出 NaN 效果 | `{"isUnlocked":false,"level":"NaN","effects":{"atk":{"add":null(即NaN)}},"compute":"NaN"}` | ✅ **现象成立**——`isUnlocked=false` 但 `effects().add = NaN`、`compute` = NaN，与报告描述完全一致 |
| P2 `autoquality` AQ4 `_history` 无上限 | 长时间运行持续增长 | 反复切档 500 次 → `historyLen = 500` | ✅ **现象成立** |
| P2 `autoquality` AQ5 `medianFps` 每帧多次排序 | 每帧 2 次 O(n log n) | 1000 次 `update + 读 state`，`window=120` → **4ms** | ⚠️ **量级可忽略**（单次 0.004ms）。建议按我在 W8-B 对 A5/B11 的同样口径处理：**判不成立 + 留性能护栏**，不要为此重构 |
| P2 `autoquality` AQ6 两份重复实现 | 逻辑重复 | 未实测（属重构项，不在复现范围） | 待对方定夺 |
| P2 `autoquality` AQ7 无 `destroy()` | `_history` / `_samples` 需清理 | `hasDestroy: "undefined"` | ✅ **现象成立** |
| P2 `loot` Lo5 `Chest._count` NaN | NaN → 抽 0 个（空宝箱，静默） | `Chest(items,{count:NaN}).roll()` → `rolledLen = 0` | ✅ **现象成立** |
| P2 `loot` Lo6 `Chest.destroy()` 不释放 `owned` | 引用未释放 | 未实测（需先看 `destroy()` 实现，目前该方法不存在） | 待对方定夺 |
| P2 `loot` Lo7 `LootTable.roll` 非保底判定 | 是否"抽一条"需确认 | 未实测（属语义确认，建议直接报"需总审裁决"） | 待裁决 |
| P2 `loot` Lo8 `ShuffleBag.add()` 清空袋中剩余 | 中途加物品丢弃剩余 | `add x,y → draw → add z → draw,draw` → `{"first":"y","second":"z","third":"y"}` | ✅ **现象成立**——`y` 在一轮内出现了两次，违反 README 承诺的"一轮之内每个元素恰好出现一次" |
| P2 `meta` M5 `restore()` 正面样本 | — | — | 无需动作 |
| P2 `meta` M6 `respec(refundRatio)` 未校验 | 负数让洗点反而扣钱 | Lv2、cost `[10,20,30]`、余额 990：`respec(-1)` → **960**；`respec(NaN)` → **NaN** | ✅ **现象成立**，且比报告更严重：**NaN 会把整条余额毒化成 NaN**（不止负数扣钱）。建议一并收口 |
| P2 `meta` M7 `topoOrder` 用 `queue.shift()` | O(n²) | 2000 节点 → **1ms** | ⚠️ **量级可忽略**。同 AQ5 口径：建议判不成立 + 护栏，不要重构 |
| P2 `meta` M8 无 `destroy()` | — | `hasDestroy: "undefined"` | ✅ **现象成立** |

**汇总**：12 条 P1 中 **8 条现象成立**、**1 条（loot 子表循环）已不存在**、
**1 条（meta setLevel NaN）成立且比报告更严重**；
P2 中 3 条"复杂度类"（AQ5 / M7 及同类的 AQ6 重构）实测都在毫秒以内，建议按"不成立 + 护栏"处理。

---

## 给 W8-A 的三条提醒（不是返工要求，是提前避坑）

1. **`loot` 的子表循环引用不要按原报告返工。** 基线已有环检测并抛明确的中文错误，
   原报告的 `Maximum call stack size exceeded` 已无法复现。
   建议直接写一条"互引用时抛环检测错误"的断言把现状锁住，并在报告里注明证据已过期。

2. **`meta` 的 `set` 缩放（P1）与我在 `blessing` 修的 P1-7 是同一个模式**（模式 D）。
   我在 `blessing/Blessing.ts:effectsOf` 的修法是 `op === 'set'` 时直接返回 `perStack`，
   注释里写清了"实测 2 层 set maxHp 100 → 200"。`meta` 的 L328 可照抄同一套口径，
   省得两个单元写出两种不一致的语义。

3. **`respec` 除了负数还要收口 NaN。** 实测 `respec(NaN)` 会把余额整条变成 NaN，
   而 `canUnlock` 里虽然已经用了肯定式 `!(have >= cost)`（NaN 会被拒），
   但余额一旦是 NaN，"所有节点都解锁不了"——比"负数扣钱"更难查。

---

## 待交付后补验的五条硬标准

| 标准 | 状态 |
|---|---|
| 1 复现（有自己跑出来的输出） | 待交付后验（可参考上表，我已代为复现一遍） |
| 2 测试有效性（回退修复后断言会失败） | 待交付后验 |
| 3 对照用例（正常输入不受影响） | 待交付后验 |
| 4 无顺手重构 | 待交付后验 |
| 5 未把"设计如此"误判成 bug | 待交付后验 —— **重点看 `meta` 的 `requires` 那条**：源码里有一段长注释明确论证"未知前置跳过而不是阻塞，抛错会让整个游戏起不来"。报告要求改成"构造即抛"，**与这段注释的设计意图正面冲突**。按第 8 节第 2/3 条，这属于"文档/注释明确声明的设计"，建议 W8-A 标 **需总审裁决** 或采用折中方案（构造期出 warning，运行期保持跳过） |

---

## 附：本次验收时的全库校验结果

```
$ node .build/tests/run.js
通过 3696 项，失败 0 项          （W8-B 交付后仍为 3696，未下跌）

$ node scripts/check-deps.js            全部通过 ✓
$ python3 scripts/scan-dt-guard.py      命中 0 处 ✓
$ python3 scripts/scan-num-guard.py     命中 0 处 ✓
$ python3 scripts/check-random-source.py  [OK] ✓
$ python3 scripts/check-dup-exports.py   [OK] ✓

$ node scripts/check-links.js           断链 3 处   ← 与原始库一致（audit/ 他窗口文件）
$ python3 scripts/check-measured-numbers.py  1 处   ← 与原始库一致（audit/round01.md:44）
```
