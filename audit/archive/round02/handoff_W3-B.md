# 精审返工任务书 · 窗口 W3-B（第 B 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W3-B 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **18**（P1 14 / P2 4） |
| 单元 | **9** 个 |
| 来源批次 | batch2、batch5 |
| 所属组 | **第 B 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W3-A**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_B.md` 验收 **W3-A**。

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
cheatcode  currency  daily  inventory  ranking  room-graph  snapshot  stats  wave-spawner
```

---


## 【P1】先做这批

### P1 · [cheatcode] `historyLimit` 未用 `clampNum` 收口，`NaN` 让历史记录无限增长

- **位置**：`cheatcode/CheatCode.ts:206`（`this._historyLimit = opts.historyLimit ?? 50`）、`:453-459`（`_pushHistory`）
- **现象**：`??` 只挡 `undefined`，不挡 `NaN / Infinity / 负数`。`_pushHistory` 里 `if (this._history.length > this._historyLimit)` 对 `NaN` 恒为 false，裁剪永不触发。
- **证据**：实测 `new CheatCode({ historyLimit: NaN })` 后执行 2000 条命令：
  ```
  historyLimit=NaN -> history.length=2000
  historyLimit=0   -> history.length=0      （负数/0 恰好安全）
  historyLimit=-5  -> history.length=0
  默认(50)         -> history.length=50
  ```
  注意 `0` 和负数**碰巧安全**（`length > 0` 为真即裁剪），唯独 `NaN` 失效——这正是"缺值被当成 0"的反面案例，最难被发现。
- **后果**：配置从 JSON/存档反序列化时 `historyLimit` 字段缺失或类型错误 → 控制台历史只增不减。作弊码历史通常还保存了玩家输入的原始字符串（含 GM 指令参数），长期会话下是持续的内存增长，且**没有任何报错**。
- **建议**：`this._historyLimit = clampNum(opts.historyLimit, 0, 1e5, 50);`（与 `crash.breadcrumbLimit`、`skill-queue.capacity` 的写法对齐）
- **影响面**：`cheatcode` 是 L1 纯工具，下游无调用方依赖其历史长度；但它是全库唯一"开发期入口"，常和 `debug-console` 同屏使用。

其他复核：`register` 的别名冲突检测（`:259-266`）在注册主名**之后**才查别名，若别名与主名重名会误报，属可接受；`execute` 空输入（`:338`）正确返回 `handled:false`；`_suggest` 的编辑距离阈值合理。未发现 rule1/rule6 违规（只依赖 `_core/string`）。

---

### P1 · [currency] `logOf(id, 0)` 返回全部流水（`slice(-0)` 陷阱）

- **位置**：`currency/Currency.ts:430`（`return Number.isFinite(n) ? out.slice(-n) : out;`）
- **证据**：`logOf('gold', 0).length = 5`（期望 0），`logOf('gold', 2).length = 2`。`Number.isFinite(0)` 为真，但 `slice(-0)` 等价于 `slice(0)`，即"从 0 切到末尾"= 全部。
- **后果**："最近 0 条流水"的 UI（比如刚清空筛选条件的瞬间）会渲染整个数组；更糟的是如果调用方用 `logOf(id, n)` 做分页取尾部，n 由外部配置驱动时行为在 0 处突变。
- **建议**：`n > 0 ? out.slice(-n) : []`。

### P1 · [currency] `netChange()` 的语义被日志裁剪悄悄改变

- **位置**：`currency/Currency.ts:434-437`（基于 `_log` 求和）对照 `:512-520`（`_record` 的裁剪）
- **证据**：`logLimit: 5` 下连续 20 次 `add(gold, 10)`：
  ```
  余额=200  netChange=50     ← 两者差 4 倍
  ```
- **后果**：`netChange` 字面意思是"净变化"，实际是"**日志里还剩下的**净变化"。`logLimit` 一旦被调小（默认 200），本局盈亏统计就系统性偏低。UI 把 `netChange` 当"本局赚了多少"显示会给出错误数字，且数字看起来完全合理（只是小了）。
- **建议**：要么在 JSDoc 写明"受 logLimit 限制"，要么改为独立的累加计数器（不受裁剪影响）。

### P1 · [currency] `CurrencyWallet` 的 `precision` 未收口，越界值让余额变 `NaN`

- **位置**：`currency/CurrencyWallet.ts:151`（`precision: d.precision ?? 0`）、`:118-122`（`quantize`）
- **证据**：
  ```
  precision=400 初始余额=NaN     （10**400 → Infinity → Math.round(100*Infinity)/Infinity = NaN）
  precision=-1  初始余额=100     （恰好走 precision<=0 分支，安全）
  ```
  `precision=400` 之后所有 `add/spend` 都会把余额推成 `NaN`，而 `_assertAmount` 只在 `Wallet` 里有，`CurrencyWallet` 的 `add` 只查 `Number.isFinite(amount)`（`:216`），不查 `Number.isFinite(next)`。
- **后果**：配置表把 `precision` 写成 `4`（小数位）还是 `400`（手误多打两个 0），差别是整个钱包静默变 `NaN`。玩家余额显示 `NaN`，所有 `canAfford` 返回 false（`cur < amount` 对 NaN 恒 false 时反而通过，行为不可预测）。
- **建议**：构造时用 `clampNum(d.precision, 0, 10, 0)`，`quantize` 内对结果做 `Number.isFinite` 兜底。

其他复核：`Wallet._clampToMax`（`:506-510`）用 `clamp` 正确；`_record` 的裁剪用 `splice(0, len - limit)` 正确（不是循环 shift）；`add` 的返回值是"实际到账"，溢出被 `void overflow`（`:249`）刻意丢弃，见存疑节。

---

### P1 · [daily] 种子文本只有 25600 种组合，约半年就会撞车（两个不同日期生成完全相同的每日挑战）

- **位置**：`daily/DailyChallenge.ts:297-302`（`SEED_WORDS_A/B` 各 16 个、`n = (seed >>> 16) % 100`）、L92-93（`seedText = seedToText(hashDateKey(date))` → `seed = hashDateKey(seedText)`）
- **现象**：`seedToText` 的输出空间是 16 × 16 × 100 = 25600，而日期是无限的；`entryFor` 用 `seedToText` 的结果再哈希当种子，于是"两个日期的 seedText 相同" ⇒ "两个日期的挑战完全相同"。
- **证据**：`verify/b2_v4.ts` §P 实测：
  ```
  第 156 天就撞车：2026-06-06 与 2026-05-18 共用种子文本 ASH-ECHO-61
  seedText 理论空间 = 16 × 16 × 100 = 25600
  ```
  （生日悖论下 25600 桶在约 188 天时有 50% 碰撞概率，实测 156 天首次撞车，量级吻合。）
- **后果**：玩家在半年内某天会遇到"今天的挑战和 19 天前一模一样"，社区会当成"每日挑战不刷新"的 bug 报上来；因为日期键是对的、种子文本是对的，只有内容重复，排查时不会想到是文本空间太小。
- **建议**：`seed` 直接用 `hashDateKey(date)`（32 位），只在**展示/分享**时用 `seedToText`；回填路径 `fromText` 需保证与 `seed = hashDateKey(text)` 一致（实测已一致 ✓）。
- **影响面**：与已知全局问题"Seed.daily() 只有 3200 个桶"同源不同处——这是 daily 单元自己的文本空间限制，按"新实例要报"处理（见存疑第 2 条）。

### P1 · [inventory] `remainingSpaceFor` 用 falsy 判断 `data`，与 `add` 的 `!== undefined` 判断不一致

- **位置**：`inventory/Inventory.ts:168`（`else if (s.def.id === id && !s.data) space += ...`）对照 `:197`（`if (s.data !== undefined || data !== undefined) continue;`）
- **证据**：
  ```
  size=1，add('sword', 1, 0)   // data = 0，是 falsy 但不是 undefined
  remainingSpaceFor('sword') = 9      ← 认为还能堆 9 个
  add('sword', 5)              -> leftover=5, count=1   ← 实际一个都堆不进去
  ```
- **后果**：`data` 用来存装备的随机数/强化等级，`0` 和 `''` 都是合法值（比如"强化 +0"、种子 0）。此时"还能放多少"的查询给出错误的上界，UI 显示"可堆叠"但实际拒绝。带堆叠上限的背包会因此卡住自动拾取流程。
- **建议**：`:168` 改成 `s.data === undefined`，与 `add` 对齐。

### P1 · [inventory] `compact()` 在容量不足时静默丢弃物品

- **位置**：`inventory/Inventory.ts:437-448`（`while (left > 0 && idx < this._slots.length)` —— `idx` 用尽后循环退出，剩余的 `left` 直接丢掉，无事件、无返回值）
- **现象**：`compact()` 返回 `void`，没有任何"丢弃了多少"的出口。
- **证据**：`add` 阶段的溢出会通过返回值 `leftover` 报告（实测 `add('c',10)` 返回 10），但 `compact` 阶段没有对应出口。构造"槽位被外部/存档写成超量"的场景后 compact 会静默截断。
- **后果**：整理背包是玩家高频操作。若存档恢复后槽位数据与 `maxStack` 不一致（跨版本改了 `maxStack`），一次"整理"就把超出部分无声吞掉。物品消失是最严重的运营事故类型之一，且不可回滚。
- **建议**：`compact()` 返回被丢弃的数量，或提供 `dryRun` 预览。

其他复核：`move`（`:286-344`）的三种分支（空位移动 / 同物合并 / 交换）都正确处理了 `data` 的搬移与 `delete`；`resize` 缩容（`:455-463`）会截断尾部的槽位——这是**有意的**但同样静默（无返回值、无警告），**P2**；`import`（`:499-514`）对未知物品 `console.warn` 并累加 `skipped`，实测脏数据（`NaN`/`-3`/`1e9`）不会污染（返回 `skipped=999999985`），正确；`onChange` 是覆盖式单回调（见共性问题 C-4）。`destroy()`（`:516-520`）清理完整。

---

### P1 · [ranking] `diagnoseDistribution` 用数组下标判断"最高/最低段位"，结论随输入顺序变化

- **位置**：`ranking/SeasonReward.ts:348`（`const first = dist[0]!`）、`:355`（`const last = dist[dist.length-1]!`）
  而 `tierDistribution`（`:301-323`）用 `Map` 按**首次出现顺序**累积，顺序完全由 `players` 数组顺序决定。
- **证据**：同一批 10 名玩家（1 个宗师 + 9 个青铜），只改数组顺序：
  ```
  宗师在前 -> dist=["grandmaster:0.1","bronze:0.9"]
             diagnose: ["最高段位占比 90.0%，超过 5%"]     ← 把青铜的 90% 当成了"最高段位"

  青铜在前 -> dist=["bronze:0.9","grandmaster:0.1"]
             diagnose: ["最低段位占比 90.0%，超过 50%","最高段位占比 10.0%，超过 5%"]  ← 这才是正确结论
  ```
- **后果**：赛季健康度诊断是本库的"运营决策输入"。结论随玩家列表排序（可能来自数据库返回顺序、分页、并发写入顺序）而变化，会给出**完全错误**的诊断——上面第一次输出会说"最强段位人太多"，实际是最弱段位人太多。数值全部"看起来合理"，不会报错。
- **建议**：`diagnoseDistribution` 内部按 `rankConfig.tiers` 的顺序重排 `dist`，或要求入参带 `tierIndex` 字段；`tierDistribution` 也应固定按 `tiers` 顺序输出。

### P1 · [ranking] `RankProgress.update()` 在段位未变时返回**陈旧**的 `TierInfo`，进度条卡住不动

- **位置**：`ranking/RankTier.ts:371-377`（未升未降的分支 `return { info: previous, ... }`）
  `previous` 是**上一次 update 时算出来的** `TierInfo`，其 `progress`/`toNext`/`floor`/`ceiling` 都基于旧 rating。
- **证据**（白银 I 区间 1400~1500）：
  ```
  update(1350) -> label=白银 II  progress=0.000  toNext=100
  update(1450) -> label=白银 I   progress=0.500  toNext=50
  update(1490) -> label=白银 I   progress=0.500  toNext=50   ← 分数涨了 40，进度条一动不动
  tierOf(1490).progress = 0.900                              ← 真实进度
  ```
- **后果**：进度条/分数显示是段位系统最外显的部分。玩家在白银 I 从 1450 打到 1499，进度条始终停在 50%，直到 1500 升段瞬间跳变。玩家反馈"进度条坏了"，而代码里确实"没坏"——它返回的是段位信息（没变），只是调用方 100% 会用它来画进度。
- **建议**：未升未降时返回 `info: actual`（本次 rating 算出的 `TierInfo`）而不是 `previous`；`previous` 已经在返回体的 `previous` 字段里了。

其他复核：`tierOf` 的段位表有序性校验（`:121-127`）与 division 的浮点边界处理（`:217` 的 `Math.floor(q + |q|*1e-9 + 1e-12)`）是精心写过的，我试了几个边界都正确；`softReset` 的 `factor` 范围校验到位；`SeasonRewardDistributor` 强制要求 `tierId:'*'` 兜底档（`:110-119`），`_findReward` 的降级查找（`:256-280`）逻辑完整；`importState`/`exportState` 对称。**P2**：`_granted` 是按 seasonId 累加的 `Map`，只增不减（实测 100 个赛季后 100 条），长运营的服务器进程需要 `pruneSeasons`。**无 `destroy()`**。

---

### P1 · [room-graph] `findBestPath` 因超配额截断时返回 `total: NaN`

- **位置**：`room-graph/RoomGraph.ts:756-759`（`return { path: findPath(graph, score), total: NaN, considered, truncated };`）
- **证据**：`verify/b2_v4.ts` §J 实测：`truncated = true  total = NaN`。
- **后果**：调用方拿到 `truncated: true` 的同时拿到 `total: NaN`，若直接把 `total` 用于比较或显示（"最优路线得分"），NaN 会静默传播到路线推荐/难度评估；正确做法要么返回已找到的最优解的分数，要么让 `total` 为 `null` 并在类型上体现。
- **建议**：截断时返回 `bestScore`（哪怕不是全局最优）或把 `total` 类型改为 `number | null`。

### P1 · [snapshot] deepClone 把 TypedArray 和类实例退化成普通对象

- **位置**：`snapshot/Snapshot.ts:38-43`（`const out: Record<string, unknown> = {};` 兜底分支）
- **证据**：`verify/b2_v2.ts` §2 实测：
  ```
  Uint8Array 克隆后是否还是 Uint8Array = false  实际 = {"0":1,"1":2,"3":3}  constructor = Object
  类实例克隆后 constructor = Object  有 double 方法 = undefined
  ```
- **后果**：`UndoStack.push()`（L251）对任何含 `Uint8Array`（binary 序列化结果、存档字节）、`Vec3`、自定义类的状态做深拷贝后，撤销回来的是"长得像但方法没了"的普通对象。崩溃点在很远的调用处（`x.double is not a function`），没人会想到是撤销栈干的。
- **建议**：在 `deepClone` 里按 `ArrayBuffer.isView` / `Object.getPrototypeOf` 分支处理，或明确文档声明"仅支持纯数据 + Date/Map/Set"。

### P1 · [stats] `get()` 用 `id in derived` 判定，键来自外部输入时会命中 `Object.prototype`

- **位置**：`stats/Stats.ts:173`（`if (id in this._derived) { return this._derived[id](...) }`）
- **现象**：`_derived` 是 `Record<string, DerivedFn>`，`in` 运算符会爬原型链。当 `id` 是 `'toString'`、`'constructor'`、`'valueOf'` 等原型键时，`'toString' in derived` 为 **true**，于是执行 `this._derived['toString'](get)` —— 即调用 `Object.prototype.toString`。
- **证据**：
  ```
  get("toString")        -> "[object Object]"    ← 不是抛错，是返回了一个字符串
  tryGet("toString")     -> "[object Object]"    ← tryGet 的 catch 完全兜不住
  get("hasOwnProperty")  -> "boolean"（typeof）
  get("toLocaleString")  -> "[object Object]"
  display("toString")    -> 0                    ← 被 Number.isFinite 兜成 0，最危险：看起来正常
  ```
  这是第 2 节 `easing()` 原型链污染的**同类新实例**（那条是"返回字符串不是数字"，这条是"返回数字的地方返回了字符串"）。
- **后果**：指标 id 通常来自配置表或存档（`importState` 直接吃外部 JSON）。一旦某个 key 是原型键——更现实的是 `derived` 由配置驱动、或者代码里 `get(someVarFromConfig)`——结算界面读到的是 `'[object Object]'`。`display()` 把它兜成 `0`，于是"本局击杀数"显示 0，玩家以为自己没杀人。**没有任何报错**。
- **建议**：`Object.prototype.hasOwnProperty.call(this._derived, id)`，或把 `_derived` 换成 `Map`。

### P1 · [stats] `record(id, NaN)` 让该指标永久变 `NaN`

- **位置**：`stats/Stats.ts:144-154`（`record` 无任何入参校验）、`:389-403`（`_apply` 的 `sum` 分支 `cur + value`）
- **证据**：
  ```
  record('score', NaN) → get=NaN  display=0
  再 record('score', 10) → get=NaN    ← 后续所有有效数据全部无效
  ```
- **后果**：一次 `NaN` 就污染一个指标终身。`display()` 把它显示成 `0`（`:203-206`），所以 UI 上是"这个统计一直是 0"，而 `get()` 拿到的是 `NaN`，任何二次计算（`derived` 指标如"K/D"）也全是 `NaN`。排查时没人会怀疑是三个月前某次伤害计算传了 `NaN`。
- **建议**：`record` 开头 `if (!Number.isFinite(value)) return;`（或抛错，按库的风格选）。

其他复核：`min` 聚合的初始值是 `Infinity`（`:98`），首次 `get` 返回 `Infinity`（`display` 兜 0）——**P2**，建议在 README 写明或让 `display` 对未记录过的指标返回 identity 而非 0。`makeKey` 用 `,` 拼接 tag，tag **值**里含逗号会被 `parseTags` 截断（实测 `{src:'a,b'}` → `tagCombos` 返回 `{src:'a'}`）——**P2**，建议对值做转义或改用 `JSON.stringify`。`_validateTags`（`:378-387`）正确拒绝了未声明的 tag。**无 `destroy()`**。

---

### P1 · [wave-spawner] 波次自带的 `timeout` 在 `nextOn: 'cleared'` 时不生效——README 承诺的"三重兜底"实际只有两重

- **位置**：`wave-spawner/WaveSpawner.ts:326`（`const waveTimeout = wave.timeout ?? this._waveTimeout;`）被 L327 使用，但 L332 用的是 `this._waveTimeout`
  ```ts
  if (mode !== 'cleared' && waveTimeout > 0 && this._waveTime >= waveTimeout) { ... }   // L327
  if (mode === 'cleared' && this._waveTimeout > 0 && this._waveTime >= this._waveTimeout) { ... }  // L332 ← 用了全局值
  ```
- **证据**：`verify/b2_v5.ts` §Q 实测：
  ```
  wave.timeout=5 / 全局 waveTimeout=60，跑 20 秒后是否触发兜底 = false   state = fighting
  同一配置改成 nextOn=timeout → 兜底类型 = wave-timeout
  ```
- **后果**：README §218 明确写 `cleared` = "全灭才进（**最常见**，配合 `timeout` 兜底）"，也就是波次自己的 timeout 应当在 cleared 模式下作为兜底。实际只有全局 `waveTimeout`（默认 60 秒）生效——波次卡住时要等 60 秒才推进，玩家表现为"打完怪但门不开"，而这恰恰是该单元要根除的问题。
- **建议**：L332 改用 `waveTimeout`（与 L327 合并成一个条件：`if (waveTimeout > 0 && this._waveTime >= waveTimeout)`）。
- **影响面**：关卡/刷怪流程；`cleared` 是最常用模式，影响面最大。


## 【P2】P1 完成后再做

### P2 · [daily] （见正文）

- **D3** `submit` 的 `score` 为 NaN 时静默不写记录（L182 `score > prev.score`）：成绩丢失无提示。
- **D4** `importState`（L229-237）不校验 `date`/`score`/`attempts`：损坏存档直接进入，`attempts` 负数会让"今日次数"变负。
- **D5** `_pickModifiers` 的 xorshift（L126、136-138）以 seed 为状态，seed 恰为 0 时是不动点 → 永远取池子前 N 个（概率 1/2³²，极低）。
- **D6** `hasPlayedToday(now = Date.now())`（L168）时间源未注入。
- **D7** `_attempts` 只增不减（只能靠 `prune` 手动清理）。

---

### P2 · [room-graph] （见正文）

- **R2** `diagnose` 里又一处**空 if**（L584-586）：`if (emptyType > 0 && emptyType < nodes.length) { }` —— 明显漏写 `issues.push(...)`；结果是"部分节点没有类型"这一重要问题**永远不会被报出来**。
- **R3** `assignTypes`（L405、L423）每个节点都复制一次 weights 与 ctx（`{...spec.weights}`、`{...ctx, node: probe}`），且 `rule.allow` 对每个候选类型都构造一次 probe（L430-436）：O(节点 × 类型 × 规则)。
- **R4** `ensureRestBeforeBoss`（L477-488）会覆盖 `spec.fixed` 指定的类型：fixed 的语义应优先。
- **R5** `diagnose` 的 crossings 检测是 O(E²) 双重循环（L571-578）。
- **R6** `generateRoomGraph` 在 `diagnose` 不 ok 时整体抛错（L233-236）：生成器没有"重试"或"降级"路径，一旦某次随机结果有交叉就直接失败（与 wave-spawner 的兜底哲学相反）。

---

### P2 · [snapshot] （见正文）

- **Sn3** `depthOf`（L173-175）用 `[.[\]]` 计数：数组路径 `a[0]` 记 2、对象路径 `a.b` 记 1，深度排序因此不准（P0-2 的根因之一）。
- **Sn4** `deepClone` 递归无深度上限（L9）：深层链表结构会 RangeError。
- **Sn5** `diffSnapshots` 的 `maxDepth`（L67）未收口：0 或负数会让整个对象退化成引用比较。
- **Sn6** 达到 `maxDepth` 时把原始对象引用存进 `from/to`（L103-105）：调用方缓存 diff 结果会持有旧对象，阻碍 GC。
- **Sn7** 数组 diff 按下标比较：中间插入一个元素会让后面全部报 changed（语义正确但噪声大）。

---

### P2 · [wave-spawner] （见正文）

- **W2** `_spawnedCount++`（L401）在 `sink.spawn()` 返回 null（生成失败）时也会递增，与 `_plannedCount` 对不上；两者还在 L417-418 被 `void` 掉（未被任何查询接口使用）。
- **W3** `_pending.shift()`（L390）：O(n²)，大波次时明显。
- **W4** `opts.rng` 注入（L157）后仅通过 protected getter（L513）暴露，类内部从未使用：要么在生成逻辑里用上（如随机延迟），要么从选项里去掉，避免误导。
- **W5** `FallbackInfo.aliveCount`（L478）实际存的是 `killed.length`（被清除的数量），字段名与语义不符。
- **W6** 无 `destroy()`（`abort()` 可作替代，但持有 `_sink` 引用）。

---

## 跨单元共性问题

**1. 「状态写入口」普遍不校验，NaN 一旦进入就全程静默（本批头号问题，12 个单元中招）**
`blessing.add/remove`、`meta.setLevel/addCurrency`、`score.set/add`、`affix`（weight/valueScale）、`loot.Chest._count`、`runscope.add`、`scheduler.maxDt`、`FpsMeter(windowSize)`、`StarRating(stars)` 全部裸收数值。最严重的后果不是"值错了"，而是**校验被绕过**：`meta` 的 NaN 货币让"余额不足"判定恒假（P0-4）。反例是好的：`meta.restore`（校验 `Number.isFinite` + clamp + 报告）、`loot.importPity`（`Math.max(0, Math.floor(n))`）、`affix` 的 `clampNum/numOr` 用法——建议把这三种写法沉淀成统一规范。

**2. 三处「空 if 块」死代码，都是"写了一半的校验"**
`logger/Logger.ts:104-106`（Silent 判断）、`blessing/Blessing.ts:81-84`（softCap 无 falloff）、`room-graph/RoomGraph.ts:584-586`（emptyType 检查）。其中 room-graph 那条后果最重：它让"部分节点没分配类型"这个本该报出来的问题永远静默。建议全库扫一遍 `{\s*}`。

**3. 原型链污染查表（已知 easing() 问题的新实例，2 处）**
`tween` L41 `Easing[name as EasingName]`（已实测产出字符串进度）、`runscope` L103/L107/L149 `in` + `Record` 查表（已实测 `has` 与 `get` 行为分裂）。建议统一改用 `hasOwnProperty` 或 `Map`。

**4. `set` 语义被层数/等级缩放（3 处同款 bug）**
`blessing:184`、`curse:270-274`、`meta:328` 都把 `set` 当成 `add` 处理（`value * n`）。三处的 `BlessingOp / CurseOp / EffectOp` 都声明了 `'set'`，说明是复制粘贴留下的。

**5. 反序列化路径普遍缺校验（8 处入口，仅 2 处合格）**
`blessing.importState`、`curse.importState`、`daily.importState`、`runscope.importSave`、`loot.Chest.importState`、`leaderboard.importEntries` 均未校验；合格的是 `meta.restore` 与 `loot.importPity`。其中 `leaderboard.importEntries` 特别危险——它是 `submit` 的旁路，绕过了唯一的一道分数校验（P1-23）。

**6. `destroy()` 覆盖不全（21 个单元中 14 个没有）**
真正需要补（持有外部引用或长期容器）的 4 个：`diagpack`（`_providers` 持有闭包）、`loot.Chest`（`_options.owned` 外部数组）、`leaderboard`（`_entries` 可达 1e7）、`autoquality`（`_history` 无上限）。其余（binary/config/logger/affix/blessing/curse/daily/interact/meta/room-graph/runscope/score/wave-spawner）为纯逻辑无监听/定时器，建议以"文档声明 N/A"方式豁免，而不是硬凑一个空 `destroy()`。

**7. 平行实现与命名不一致**
`AutoQuality.median/average/lowFps1Percent` 与 `FpsMeter` 的三份实现逐行同构（应合并）；`blessing.pick` 与 `curse.pick` 完全同构；`config` 的 `count()`（未加载返回 0）与 `all()/get()`（抛错）语义不一致；`snapshot` 的 `clamp` 本地实现（interact 也有）。

**8. 时间源未注入（rule2，3 处）**
`scheduler` L66 与 `TimeScale.add` L32 内部 `Date.now()`（违反"统一时间源"的立身之本）、`curse.add` L134 默认参数、`daily.hasPlayedToday` L168 默认参数。建议统一由调用方传入 `now`。

---

## 存疑（需总审裁决）

- **binary / P1-3（float 静默 clamp）是否升 P0** —— 我倾向升：README §6③ 白纸黑字写"越界值绝不静默截断…存进去 300 读出来 44 这种 bug 能查一天"，而 `float.write` 正是这条禁令的唯一违反者（uint/int 都抛错）。但触发前提是调用方传了越界值，属"输入错误"，所以我按 P1 报，请总审定级。
- **daily / P1-19（seedText 25600 空间）是否算已知全局问题的同源** —— 已知台账里有"Seed.daily() 只有 3200 个桶，日期会碰撞"。我这处在 daily 单元内部，是"日期 → 文本（25600）→ 再哈希"的二次退化，与 rng 的 3200 桶是两套独立实现。我倾向算新实例（修 daily 不需要动 rng，反之亦然），但如果总审认为应合并到同一条台账，我按合并处理。
- **daily / streak 的夏令时** —— `streak()`（L198）用固定 `t -= 86400000` 往前推，在 DST 切换日（23/25 小时）理论上会多算或少算一天。我用 `TZ=America/New_York` 跑了 2026-03-08 前后的 4 天样本，实测结果仍是 4（未复现失败，因为样本时刻在中午，避开了午夜边界）。**没有实测到后果，所以没有报 P1**，但代码写法确实不 DST-aware，是否值得改为按日历日递减，请总审定夺。
- **interact / P1-22 的修法** —— 我倾向把 `pos` 正式加进 `Interactable` 接口并删掉 L162 的双重强转（当前 README 示例在 strict 下编译不过）。但"不传 pos = 全局可交互"是 README 明确的设计意图，如果总审认为应保持接口精简（用 `Interactable & { pos?: ... }` 的泛型扩展），请给口径。
- **diagpack / P1-21（脱敏破坏 JSON + 空 catch）是否升 P0** —— 破坏 JSON 这一半我判 P1（下游解析会报错，不静默）；但 `redact` 的空 catch 会让脱敏被静默跳过，可能把明文凭证报上去，这一半我有理由升 P0。因为空 catch 只在正则构造失败时触发（我未能构造出必现路径），证据链不完整，所以整体按 P1 报，请总审定级并指示是否要我补做正则异常的复现。
- **wave-spawner / P1-36 的修法** —— 把 L332 改用 `waveTimeout` 即可，但需确认：是否希望 `nextOn: 'cleared'` 时波次 timeout **完全不生效**（当前行为）？README §218 写的是"配合 timeout 兜底"，我按 README 判为 bug；若实际设计意图是"cleared 模式不接受波次超时"，则应改 README 而不是改代码。
- **14 个单元缺 `destroy()` 的处置口径** —— 我列了必须补的 4 个（diagpack / Chest / Leaderboard / AutoQuality），其余建议文档声明 N/A。若总审要求 rule5 一刀切（全部补齐空实现），请给指令，我在下一轮统一补。

---

## 交付前自检

- ✅ 报告中每个 P0/P1 都有"位置（文件:行）+ 证据（实测输出或行号推导）+ 后果（场景 + 症状 + 为什么难查）"三件套
- ✅ 没有把已审结地基单元（`_core` / `ds` / `event-bus` / `pool` / `rng`）的问题重复报（tween 的 `Easing` 查表与 runscope 的 schema 查表按"已知 easing() 原型污染的新实例"报，已在文中标注）
- ✅ 已知全局问题未当新发现报：`Seed.daily()` 3200 桶（已在存疑里说明与 daily 25600 空间的区别）、矩形坐标系歧义（本批无自定 Rect）、相切语义（本批无）、平行实现（pathfind/spatial 不在本批；本批内部发现的新平行实现已单列）
- ✅ 六类（A 静默错误 / B 生命周期 / C 契约 / D 铁律 / E 性能 / F 数值配置）全部覆盖：A 类 14 条、B 类 8 条、C 类 9 条、D 类 5 条、E 类 7 条、F 类 11 条
- ✅ 21 个单元每个都有结论（0 个 ✅ 通过 / 17 个 ⚠️ 有问题 / 4 个 ❌ 有 P0）——本批没有"零 P0/P1"的单元，故无 ✅
- ✅ 存疑 7 条单独列在最后一节，未混进 P0/P1
- ✅ 报告已写入 `/data/workspace/audit/batch2_review.md`
- ✅ 全程未执行 `build.sh`、未改动 `.build/`、未修改任何源码；验证产物仅落在 `verify/b2_v*.ts` 与 `verify/out2/`


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

新建 `tests/run_phase10_w3b.ts`，并**在文件内导出** `runPhase10W3BTests()`：

```ts
export function runPhase10W3BTests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W3-B.md`，每条一行：

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
| **文件命名** | `run_phase10_w3b.ts` / `result_W3-B.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 B 组**。修完之后，按 `audit/review_B.md` 验收 **W3-A**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W3-B.md`，
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
