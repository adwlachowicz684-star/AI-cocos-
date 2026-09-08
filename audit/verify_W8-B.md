# 验收报告 · W8-B 验收 W8-A

> 验收方：`W8-B`（第 B 组，同编号）
> 被验收：`W8-A` —— 单元 `autoquality` / `loot` / `meta`，条目 12（P1 × 9 / P2 × 3 组，P2 展开为 21 条子项）
> 标准：`audit/review_B.md` 第 2 节五条硬标准
> 基线：`6b1c1bab`（2026-09-08T00:52:21Z，main HEAD）
> 验收方式：**GitHub API 直查 main** + 独立只读复现脚本（脚本在仓库外，未改动对方任何一行代码）

---

## 结论

# ❌ 无法验收 —— 对方零交付

若总审需要形式判定，记为 **不通过（未交付）**。

### 交付物核查（GitHub API 直查 `main`，非本地快照）

| 应产出（`review_B.md` §1） | API 结果 |
|---|---|
| `audit/result_W8-A.md` | **404 Not Found** |
| `tests/run_phase10_w8a.ts` | **404 Not Found** |
| 逐条列出 `audit/` 下全部 `w8` 文件 | 只有 `handoff_W8-A.md` / `handoff_W8-B.md` / `result_W8-B.md` / `verify_W8-B.md` |
| `tests/` 下全部 `w8` 文件 | 只有 `run_phase10_w8b.ts`（**w1a~w7b 均已就位，唯独缺 w8a**） |

### 零交付佐证：三个单元在本轮窗口期内**没有任何提交**

本轮返工的提交区间为 `2026-09-07T12:58:43Z`（`2b413ab9`）→ `2026-09-08T00:52:21Z`（`6b1c1bab`）。
按路径查三个单元的最后一次提交：

| 单元 | 最后一次提交 | 时间 | 是否落在本轮窗口内 |
|---|---|---|---|
| `autoquality` | `535a92a7` chore: 同步 autoquality/AutoQuality.ts | 2026-09-07T11:37:34Z | ❌ 早于窗口起点 12:58 |
| `loot` | `cc0288f4` chore: 同步 loot/LootTable.ts | 2026-09-07T12:12:31Z | ❌ 早于窗口起点 12:58 |
| `meta` | `72054550` chore: 同步 meta/MetaProgression.ts | 2026-09-07T11:38:02Z | ❌ 早于窗口起点 12:58 |

即 W8-A 的 3 个单元源码**与开工基线逐字节一致**，12 条**一条都还没动**。

> 注：`loot` 上的 `fix(loot): add 权重加上界`（`d0ed3fcc`，2026-09-06T13:44）与 `loot` 的环检测代码，
> 均早于本轮窗口，属原始库既有实现，**不是 W8-A 的成果**。

---

## 一、五条硬标准（针对 W8-A 的交付物）

没有交付物 → 标准 1~5 **无对象可验**，全部记为「待交付后验」。

| 标准 | 状态 | 依据 |
|---|---|---|
| 1 是否真的复现过 | ⏸ 待交付后验 | 无 `result_W8-A.md`，无从比对"对方自己跑出来的输出" |
| 2 测试是否真的会失败 | ⏸ 待交付后验 | 无 `run_phase10_w8a.ts`，无法做回退验证 |
| 3 有没有对照用例 | ⏸ 待交付后验 | 同上 |
| 4 有没有顺手重构 | ⏸ 待交付后验 | 无 diff 可看 |
| 5 有没有把"设计如此"误判成 bug | ⚠️ **已可预警 6 条** | 见第三节「开工前必读」，有 2 条原报告描述与源码设计意图正面冲突 |

---

## 二、我代为复现的 21 条（W8-A 开工后请直接对表）

> 目的：原报告的证据是别的窗口写的。**我在当前基线上逐条自己跑了一遍**，
> 一方面提前筛掉"报告描述的现象其实不存在"的条目，另一方面 W8-A 可直接拿去当"修复前输出"。
>
> 脚本：`/data/workspace/repro_w8b_verify.js`（**仓库外**，不进 `verify/`，不被 `check-deps.js` 扫到）
> 随机源：自研确定性 LCG（可复现），未使用裸 `Math.random`。

### 【P1】9 条

| 编号 | 单元 | 报告描述 | 我的独立复现输出 | 判断 |
|---|---|---|---|---|
| P1-1 | `autoquality` | `setManualLevel` 的 history `from === to` | 初始档位 2 → `setManualLevel(0)` → 记录 `{"from":0,"to":0,"reason":"玩家手动设置"}`，`from===to` 为 **true**（真实切换应为 2→0） | ✅ **现象成立**（比原报告更精确：丢失的是**旧值 2**） |
| P1-2 | `autoquality` | `FpsMeter` 窗口未收口 | `new FpsMeter(NaN)` → `THROW: Invalid array length` | ✅ **现象成立**，逐字一致 |
| P1-3 | `loot` | 子表互相引用 → 无限递归栈溢出 | `a.roll()` → `THROW: [LootTable] 子表存在循环引用，掉落链经过本表两次（表内条目 1 条）` | ⚠️ **现象已不存在**——基线已有环检测（`_roll` 带 `visiting` Set + 长注释说明为何在 roll 时检测）。**请勿按原描述返工**，改为写一条"互引用时抛环检测错误"的断言锁住现状 |
| P1-4 | `loot` | `pickUnique` 与 `setWeight(v,0)` 冲突 | `pickUnique` → `THROW: [WeightedTable] 权重必须为正，实际 0` | ✅ **现象成立**，逐字一致 |
| P1-5 | `loot` | `PRD._cache` 只增不减 | 5000 次 `PRD.fromChance((i+1)/20000)` → 缓存 `0 → 5000`；重复同一概率 100 次 → 增量 **0**；实例置 null 后条目**仍在**；源码无任何 `delete/clear/淘汰` 逻辑 | ✅ **现象成立**（**注意入口是 `fromChance` 不是 `new PRD`**，见第三节纠错 2） |
| P1-6 | `loot` | `Chest.importState` 越界索引 | `importState({current:[99,1]})` → `current = [undefined,"shield"]`，`take(0)` 返回 `undefined`，`state` 已置 `'taken'` | ✅ **现象成立**——宝箱被消耗且拿不到东西，不可恢复 |
| P1-7 | `meta` | `requires` 写不存在的节点 id → 依赖静默跳过 | `canUnlock = {"ok":true,"cost":0}`，`unlock()` 返回 `1`，`isUnlocked = true` | ✅ **现象成立，且比报告更严重**——实测**真能解锁**，不只是"校验静默" |
| P1-8 | `meta` | `set` 效果被等级缩放 | Lv2 的 `set(50)` → `{"add":0,"mul":0,"set":100}`，`compute = 100` | ✅ **现象成立**，逐字一致（模式 D，与 `blessing` P1-7 同源） |
| P1-9 | `meta` | `setLevel` 的 NaN 自相矛盾 | `setLevel('n', NaN)` → `isUnlocked=false`，`level="NaN"`，`effects.atk.add="NaN"`，`compute="NaN"` | ✅ **现象成立**——"未解锁"却在产出 NaN，污染整条属性链 |

**P1 汇总**：9 条中 **8 条现象成立**，**1 条（P1-3 子表循环）基线已修、现象不存在**。

### 【P2】12 条子项

| 编号 | 单元 | 报告描述 | 我的独立复现输出 | 判断 |
|---|---|---|---|---|
| AQ4 | `autoquality` | `_history` 只增不减无上限 | 反复切档 500 次 → `historyLen = 500` | ✅ **现象成立** |
| AQ5 | `autoquality` | `medianFps` 每帧多次排序 | `window=120`，1000 次 `update + 读 medianFps` → **5.74 ms**（单次 0.0057 ms） | ⚠️ **量级可忽略**。建议按我在 W8-B 对 A5/B11 的同一口径：**判不成立 + 留性能护栏**，不要为此重构 |
| AQ6 | `autoquality` | `AutoQuality` 与 `FpsMeter` 两份重复实现 | 两处算法逐行同构（`medianFps` L369-378 ↔ `median` L580-589；`averageFps` ↔ `average`；`lowFps1Percent` ↔ `lowFps1Percent`） | ✅ **重复属实**，但**空态返回值不同**：`AutoQuality` 全返回 **60**，`FpsMeter` 全返回 **0**（见第三节纠错 3，合并有陷阱） |
| AQ7 | `autoquality` | 无 `destroy()` | `typeof aq.destroy === "undefined"` | ✅ **现象成立** |
| Lo5 | `loot` | `Chest._count` NaN → 抽 0 个 | `new Chest(['a','b','c'],{count:NaN}).roll()` → `rolledLen = 0` | ✅ **现象成立**（静默空宝箱） |
| Lo6 | `loot` | `Chest.destroy()` 不释放 `_options.owned` | `destroy()` **存在**（L345-348，只清 `_current`/`_currentIndices`）；`owned` 在 destroy 前后均为 `['a']`，`_options.owned` 仍是**同一个引用** | ❌ **判不成立（设计如此）**——见第三节纠错 1 与第四节裁决 3 |
| Lo7 | `loot` | `LootTable.roll` 非保底判定是否"抽一条" | 3 条各 weight 1、400 次掷骰 → 命中条数分布 `{0次:61, 1次:191, 2次:121, 3次:27}`，**37% 的掷骰同时命中多条** | ❌ **判不成立（设计如此）**——源码 L190-195 有长注释明确论证"每条独立判定 vs 只抽一条"并选定前者。**但 README 未写这条语义** → 属文档缺口，建议补文档而非改代码 |
| Lo8 | `loot` | `ShuffleBag.add()` 清空袋中剩余 | `add x,y → draw(x) → add z → draw(z), draw(x)` → `{"first":"x","second":"z","third":"x"}` | ✅ **现象成立**——`x` 在一轮内出现两次，违反"一轮之内每个元素恰好出现一次" |
| M5 | `meta` | `restore()` 正面样本 | `restore({currency:{default:NaN}, levels:{n:99}})` → `report={skipped:[],clamped:['n'],versionMismatch:false}`，`level=2`（clamp 到 maxLevel），`currency="0"`（NaN 未穿透） | ✅ **正面样本成立**，无需动作。建议 W8-A 把它当模板时**照抄这两条**：clamp 到 maxLevel + NaN 货币回落 0 |
| M6 | `meta` | `respec(refundRatio)` 未校验 | Lv2、cost `[10,20,30]`：余额 `970` → `respec(-1)` 后 **940**（洗点反而扣钱）；`respec(NaN)` 后余额 **NaN** | ✅ **现象成立，且比报告更严重**——NaN 会把整条余额毒化成 NaN，导致"所有节点都解锁不了"，比负数扣钱更难查 |
| M7 | `meta` | `topoOrder` 用 `queue.shift()` 是 O(n²) | 2000 节点链 → **1.60 ms** | ⚠️ **量级可忽略**。同 AQ5 口径：建议判不成立 + 护栏，不要重构 |
| M8 | `meta` | 无 `destroy()` | `typeof mp.destroy === "undefined"` | ✅ **现象成立** |

**P2 汇总**：12 条中 **6 条现象成立**、**2 条（Lo6/Lo7）判不成立（设计如此）**、
**3 条复杂度类（AQ5/AQ6/M7）量级在毫秒内**（AQ6 属"重复属实但合并有陷阱"，单独裁决）、**1 条（M5）为正面样本无需动作**。

---

## 三、对上一版 `verify_W8-B.md` 的三处更正

> 上一版是我（W8-B）自己写的。复核时发现三处不准确，先自我更正，避免 W8-A 照着错的结论返工。

### 纠错 1 · Lo6「`Chest.destroy()` 不存在」是错的

上一版写"需先看 `destroy()` 实现，目前该方法不存在"。**实际 `destroy()` 存在**（`loot/Chest.ts:345-348`）。
真正的问题是它只清 `_current` / `_currentIndices`，不碰 `_options.owned`——
但这是**对的**，理由见第四节裁决 3。

### 纠错 2 · P1-5 的复现入口不是 `new PRD(chance)`

`PRD._cache` **只在 `PRD.fromChance(chance)` 里写入**（`loot/PRD.ts:79`），`new PRD(c)` 走的是构造函数、不碰缓存。
上一版没写清入口；我第一次复现误用 `new PRD` 得到 `0 → 0`，差点误判成"不成立"。
**W8-A 复现时务必用 `PRD.fromChance()`**（这也正是 README 示例里的用法：`PRD.fromChance(0.25)`）。

### 纠错 3 · AQ6 不是"单纯去重"，两处空态语义不同

| | `AutoQuality` | `FpsMeter` |
|---|---|---|
| 无采样时 `median` | **60** | **0** |
| 无采样时 `average` | **60** | **0** |
| 无采样时 `lowFps1Percent` | **60** | **0** |

`AutoQuality` 返回 60 是**有意的**：无数据时不能判定"性能很差"，否则开机第一帧就会把画质降到最低档。
按 `handoff_W8-A.md` 建议"AutoQuality 内部持有 FpsMeter 即可"去合并，**会把 60 变成 0，改变对外行为**。
→ 已列入第四节裁决 2。

---

## 四、需总审裁决（3 项，我不自己拍板）

### 裁决 1 · `meta` 的 `requires` 未知 id：报告要求"构造即抛"，源码注释要求"静默跳过"

- 报告（P1-7）建议：**构造期校验所有 `requires` 必须存在，不存在即抛**。
- 源码 `meta/MetaProgression.ts` 里有一段长注释，明确论证"未知前置**跳过而不是阻塞**，抛错会让整个游戏起不来"。
- 我的复现：未知前置**确实能一路解锁**（`unlock()` 返回 1，`isUnlocked=true`），报告的担忧是真的；
  但源码注释的担忧（改配置时少写一个可选节点就整局起不来）也是真的。

**两种选择**：
- **A 严格**（照报告改）：拼错立即暴露，但任何"可选前置/灰度节点"配置都会让存档加载失败，是 **breaking**。
- **B 折中**（我倾向）：构造期出 `warning` 并把被跳过的 id 记进一个 `unknownRequires` 列表供排查；
  **运行期保持跳过**。既保留可观测性，又不阻塞启动。

### 裁决 2 · AQ6 两份重复实现是否合并

重复属实，但空态返回值 60 vs 0 是有意差异（见纠错 3）。
- **合并**：消除重复，但 `AutoQuality` 空态从 60 变 0 → 开机首帧可能误降档（对外行为变更）。
- **不合并**：维持现状，只补注释说明"两处空态默认值不同是有意的"。
- 我倾向：**不合并**，改为在两边补交叉注释 + 各写一条断言锁住自己的空态值。

### 裁决 3 · Lo6「`Chest.destroy()` 不释放 `owned`」我判**不成立**，请追认

理由（`loot/Chest.ts:56-80` 的注释是原话级证据）：
`owned` 是**跨批次**的已获得列表，由**调用方持有并传入**（`ChestOptions.owned`），
语义是"已经拿过的唯一遗物不再出现"。`addOwned()` 往里 push 是**功能本身**。
`destroy()` 若去清它，等于玩家一销毁宝箱就把"已获得的遗物记录"清空——
遗物会重新出现在下一个宝箱里，**直接破坏功能**。
且 `_options` 是 `readonly` 引用，本来也不该由 Chest 去改调用方的数组。

→ 建议 W8-A 标 **`不成立（附证据）`**，不要去"释放"。若担心长生命周期引用，
可在 README 补一句"`owned` 的生命周期由调用方管理，`destroy()` 不会触碰它"。

---

## 五、给 W8-A 的开工提醒（不是返工要求，是提前避坑）

1. **P1-3（子表循环）不要按原报告返工。** 基线已有环检测并抛明确中文错误，
   原报告的 `Maximum call stack size exceeded` 已无法复现。写一条"互引用时抛环检测错误"的断言锁住现状即可。

2. **P1-8（`meta` 的 `set` 缩放）与我在 `blessing` 修的 P1-7 是同一个模式（模式 D）。**
   `blessing/Blessing.ts:effectsOf` 的修法是 `op === 'set'` 时直接返回 `perStack`
   （注释里写清"实测 2 层 set maxHp 100 → 200"）。`meta` 的 L328 可照抄同一套口径，
   免得两个单元写出两种不一致的 `set` 语义。

3. **M6（`respec`）除了负数还要收口 NaN。** 实测 `respec(NaN)` 会把余额整条变 NaN，
   比"负数扣钱"严重得多（表现为所有节点都解锁不了）。

4. **Lo7 不要改代码。** 源码注释已论证"每条独立判定"是刻意设计；
   要补的是**文档**（README 未说明这条语义），不是实现。

5. **21 条里 3 条是"复杂度类"，实测都在毫秒级**（AQ5 0.0057ms/次、M7 1.6ms/2000 节点）。
   建议统一按"**不成立 + 留性能护栏**"处理，别为它们做重构——会踩标准 4「顺手重构」。

---

## 六、附：本次验收时的全库校验结果

```
$ node .build/tests/run.js
通过 3696 项，失败 1 项
  ✗ 第九批 › BinarySerializer · 位级序列化 › ⚠️ float 会 clamp 而不是溢出回绕
    [Binary] float 越界：999（范围 -10..10）
```

⚠️ **关于这 1 项红灯，如实说明**：它**属于我 W8-B 自己的窗口**，与 W8-A 无关，不应计入对 W8-A 的评价。
成因是 W8-B 的 P1-5 把 `binary` 的 float 越界从"静默 clamp"改为"抛错"（修复本身正确），
但漏改了旧测试 `run_batch10.ts` 里的这条断言。我会在本窗口内自行处理，不占用 W8-A 的返工额度。

```
$ node scripts/check-deps.js             1 项待处理（幽灵依赖，非 W8-A 单元）
$ node scripts/check-links.js             断链 0 处（扫描 191 个 .md）✓
$ python3 scripts/scan-dt-guard.py        命中 0 处 ✓
$ python3 scripts/scan-num-guard.py       命中 0 处 ✓
$ python3 scripts/check-random-source.py  [OK] ✓
$ python3 scripts/check-dup-exports.py    [OK] ✓
$ python3 scripts/check-measured-numbers.py  1 处（audit/round01.md:44，既有，非本批引入）

$ bash build.sh                           TSC OK（227 个 .js）
```

---

## 七、复核方式（可复现）

```bash
# 1. 确认 W8-A 零交付（需 token）
curl -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/adwlachowicz684-star/AI-cocos-/contents/audit/result_W8-A.md?ref=main
# → {"message":"Not Found"}

# 2. 确认三个单元在本轮窗口内无提交
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/adwlachowicz684-star/AI-cocos-/commits?path=loot&per_page=5"
# → 最新为 2026-09-07T12:12:31Z，早于窗口起点 12:58:43Z

# 3. 21 条独立复现
node /data/workspace/repro_w8b_verify.js
```

---

## 八、什么时候可以重新验收

W8-A 交付后，我会按同一口径补验五条硬标准，尤其是：

- **标准 2**：把 3 个单元源码回退到开工基线 `6b1c1bab`，保留 W8-A 的新测试重跑，
  统计"修复前会失败"的用例数（我在 W8-B 自己那批用的就是这个办法，可复用以保证两组口径一致）。
- **标准 5**：重点复核 P1-7（`meta` `requires`）——那条与源码注释正面冲突，改法必须能同时回答注释里的担忧。

**在那之前，本报告结论保持为「无法验收（零交付）」。**
