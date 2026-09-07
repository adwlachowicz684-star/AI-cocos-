# 精审返工任务书 · 窗口 W8-A（第 A 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W8-A 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **12**（P1 9 / P2 3） |
| 单元 | **3** 个 |
| 来源批次 | batch2 |
| 所属组 | **第 A 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W8-B**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_A.md` 验收 **W8-B**。

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

### 3.1 你的单元（3 个，与其它 15 个窗口零重叠）

```
autoquality  loot  meta
```

---


## 【P1】先做这批

### P1 · [autoquality] `setManualLevel` 写入的 history 记录 from === to，切换前档位丢失

- **位置**：`autoquality/AutoQuality.ts:248`（`this._level = level;`）与 L253（`from: this._level`）——先赋值再取旧值
- **证据**：`verify/b2_v4.ts` §C 实测：`history = [{"from":0,"to":0,"reason":"玩家手动设置"}]`，`from === to` 为 true。
- **后果**：`describe()`（L324-326）里所有手动切换都显示成 `· 2 → 2`，看不出玩家从哪档切过来；排查"为什么画质降了"时这段历史是废数据。
- **建议**：在 L248 之前先 `const from = this._level;`。

### P1 · [autoquality] `FpsMeter` 的窗口大小未收口，NaN 直接构造数组崩溃

- **位置**：`autoquality/AutoQuality.ts:375`（`this._window = Math.max(3, windowSize);`）
- **证据**：`verify/b2_v4.ts` §B 实测：`FpsMeter(NaN)` 抛 `Invalid array length`（`new Array(NaN)`）。
- **后果**：同一个文件里 `AutoQuality` 用 `clampNum`（L100）而 `FpsMeter` 用裸 `Math.max`，配置来源相同时一个安全一个崩溃。崩溃点在构造函数，堆栈不会指向配置。
- **建议**：统一 `clampNum(windowSize, 3, 1e6, 60)`。

### P1 · [loot] 子表互相引用时 `roll()` 无限递归栈溢出

- **位置**：`loot/LootTable.ts:151-154`（`e.child.roll(rng)`），`entry()`（L51-59）未做环检测
- **证据**：`verify/b2_v4.ts` §I 实测：A.child=B、B.child=A 时 `a.roll()` 抛 `Maximum call stack size exceeded`。
- **后果**：配置里把两张表配成互相包含（改表时的常见手误）会让掉落逻辑在运行时直接崩；`entry()` 阶段不报错，所以只在"玩家开箱那一刻"暴露。
- **建议**：`entry()` 时用一个 Set 记录已见 child 链，或在 `roll` 里传入深度上限。

### P1 · [loot] `pickUnique` 与 `setWeight(v, 0)` 语义冲突，直接抛错

- **位置**：`loot/WeightedTable.ts:91-92`（`work.add(it.value, it.weight)`）vs L25（`setWeight` 允许 `weight >= 0`）vs L17（`add` 要求 `weight > 0`）
- **证据**：`verify/b2_v4.ts` §H 实测：表里有被 `setWeight('b', 0)` 的项时，`pickUnique` 抛 `[WeightedTable] 权重必须为正，实际 0`。
- **后果**：调用方用 `setWeight(x, 0)` 临时下架一个掉落（很自然的操作）之后，再调 `pickUnique` 就崩；而 `pick()` 在同一状态下是正常工作的——同一份数据两个 API 行为不一致。
- **建议**：`pickUnique` 建临时表时跳过 `weight <= 0` 的项，不要用 `add` 硬塞。

### P1 · [loot] `PRD._cache` 是静态 Map，只增不减无上限

- **位置**：`loot/PRD.ts:36`（`PRD._cache.set(chance, c)`）、L92（`private static readonly _cache = new Map()`）
- **证据**：`verify/b2_v5.ts` §R 实测：用 5000 个不同概率 → 缓存条目 `0 → 5000`。
- **后果**：概率是动态计算的场景（难度曲线每局微调、按玩家等级插值）会让缓存无限增长；每个条目虽小，但进程生命周期内永不释放，是典型的长期运行泄漏。
- **建议**：改成 LRU（上限如 512）或按量化后的概率做 key。

### P1 · [loot] `Chest.importState` 不校验索引，越界时静默产出 `undefined` 选项

- **位置**：`loot/Chest.ts:123-129`（`this._currentIndices = snap.current.slice();` → `_applyIndices()` L134 `this._items[i]`）
- **现象**：物品表改过（数量变少）或存档被改时，`_current[i]` 为 `undefined`，`take()` 返回 `undefined` 但仍把状态置为 `'taken'`。
- **后果**：玩家点宝箱拿到"空"，且宝箱状态已消耗——不可恢复的静默错误。
- **建议**：导入时过滤 `i >= 0 && i < this._items.length`，并记录被丢弃的索引。

### P1 · [meta] `requires` 里写了不存在的节点 id 时，依赖被静默跳过

- **位置**：`meta/MetaProgression.ts:219`（`if (!this._nodes.has(req)) continue;`），`_findCycle` 同样 L426
- **证据**：`verify/b2_v4.ts` §F 实测：节点 `need` 的 `requires: ['不存在的节点']` → `canUnlock = {"ok":true,"cost":0}`，构造时不报错。
- **后果**：依赖名拼错（货币拼错会抛错、节点拼错不抛）→ 前置条件形同虚设，玩家可以直接解锁终局节点。这是"防呆不对称"：同一个构造函数里货币校验是严格的，节点依赖校验是静默的。
- **建议**：构造期就校验所有 `requires` 必须存在，不存在即抛。

### P1 · [meta] `set` 效果被等级缩放（与 blessing/curse 同款）

- **位置**：`meta/MetaProgression.ts:328`（`e.set = e.set === undefined ? eff.value * lv : Math.max(e.set, eff.value * lv)`）
- **证据**：`verify/b2_v4.ts` §G 实测：Lv2 的 `set(50)` → `{"set":100}`。
- **后果**："设为固定值"的节点在 Lv2/Lv3 给出 2 倍/3 倍的值，数值曲线与设计完全不符。
- **建议**：`case 'set'` 直接用 `eff.value`。

### P1 · [meta] `setLevel` 的 NaN 让"是否解锁"与"是否生效"自相矛盾

- **位置**：`meta/MetaProgression.ts:275`（`Math.max(0, Math.min(level, this.maxLevel(nodeId)))`）
- **现象**：`level` 为 NaN → `Math.min(NaN, mx)` = NaN → `Math.max(0, NaN)` = NaN。`isUnlocked`（L180）判定 `NaN > 0` = false（未解锁），但 `effects()`（L314 `if (lv <= 0) continue`）中 `NaN <= 0` 也是 false → 进入计算 → `eff.value * NaN` = NaN。
- **后果**：一个"看起来没解锁"的节点却在产出 NaN 效果，污染整条属性聚合链（`compute` 返回 NaN）。
- **建议**：`setLevel` 入口收口 level 为有限非负整数。


## 【P2】P1 完成后再做

### P2 · [autoquality] （见正文）

- **AQ4** `_history`（L83-89）只增不减且无容量上限：长时间挂机 + 频繁切换会持续增长（容量类字段未收口）。
- **AQ5** `medianFps`（L218）每次调用都 `[...].sort()`，而 `update()`（L149）与 `state` getter（L288）每帧各调一次 → 每帧 2 次 O(n log n) + 数组分配。
- **AQ6** `AutoQuality.median/average/lowFps1Percent` 与 `FpsMeter.median/average/lowFps1Percent` 是同一份逻辑的两份实现（L216-242 vs L386-411）：应合并（AutoQuality 内部持有 FpsMeter 即可）。
- **AQ7** 无 `destroy()`：`_history` 与 `_samples` 需清理。

---

### P2 · [loot] （见正文）

- **Lo5** `Chest._count`（L216）用 `Math.max(1, count ?? 3)`：`count` 为 NaN 时 → NaN → 抽 0 个（空宝箱，静默）。
- **Lo6** `_spawnedCount` 统计问题在 wave-spawner；此处 `Chest.destroy()`（L219-222）不释放 `_options.owned` 引用（`addOwned` 会往里 push）。
- **Lo7** `LootTable.roll` 的非保底判定（L100）是"每个条目独立掷骰"：会同时命中多条，是否与 README 的"抽一条"一致需确认。
- **Lo8** `ShuffleBag.add()`（L31）会清空 `_bag`：中途加物品会丢弃当前袋中剩余（README 未说明）。

---

### P2 · [meta] （正面样本）

- **M5** `restore()`（L367-408）是本批**做得最好**的反序列化实现：校验 `Number.isFinite`、clamp 到 `maxLevel`、把跳过/裁剪记进 `RestoreReport`。建议把它作为其他单元 `importState` 的模板。
- **M6** `respec(refundRatio)`（L279-289）未校验比例：负数会让"洗点"反而扣钱。
- **M7** `topoOrder` 用 `queue.shift()`（L467）：O(n²)，节点数多时可换索引指针。
- **M8** 无 `destroy()`。

---


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

新建 `tests/run_phase10_w8a.ts`，并**在文件内导出** `runPhase10W8ATests()`：

```ts
export function runPhase10W8ATests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W8-A.md`，每条一行：

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
| **文件命名** | `run_phase10_w8a.ts` / `result_W8-A.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 A 组**。修完之后，按 `audit/review_A.md` 验收 **W8-B**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W8-A.md`，
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
