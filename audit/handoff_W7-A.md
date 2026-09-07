# 精审返工任务书 · 窗口 W7-A（第 A 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W7-A 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **12**（P1 4 / P2 8） |
| 单元 | **4** 个 |
| 来源批次 | batch1 |
| 所属组 | **第 A 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W7-B**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_A.md` 验收 **W7-B**。

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

### 3.1 你的单元（4 个，与其它 15 个窗口零重叠）

```
dash  grid  objective  progressbar
```

---


## 【P1】先做这批

### P1 · [dash] 多层充能永远回不满：只有充能耗尽到最后一层才启动冷却

- **位置**：`DashController.ts:285`~`:286` `if (this._charges <= 0 && this._cdLeft <= 0) this._cdLeft = this._cooldown;`
- **现象**：`charges = 2` 时用掉第 1 层（剩 1）不设 CD → tick `:343` 的 `if (_cdLeft > 0)` 永不执行 → 第二层充能**永远无法恢复**。
- **证据**：`charges = 2`，用掉 1 层后 `chargesLeft = 1`；等 **5 秒**（远超 cooldown 0.5s）后 `chargesLeft` 仍为 **1**（期望回到 2）（`b1_v2` [3]）。
- **后果**：JSDoc `:86` 明确写"充能层数（哈迪斯可以连续冲两次）"。实际表现是：连冲两次后，之后每次只能用一层、且这一层要靠"耗尽后的 CD"恢复——双冲刺退化成单冲刺。手感差异玩家能察觉但说不清，数值同学看配置 `charges: 2` 是对的。
- **建议**：每消耗一层就启动/续上冷却：`this._charges--; if (this._cdLeft <= 0) this._cdLeft = this._cooldown;`

### P1 · [dash] `duration` / `distance` 未收口 → 一个 NaN 让角色坐标永久变 NaN

- **位置**：`DashController.ts:169`~`:170`（`?? 4` / `?? 0.22`）、`:379`（`clamp(_t / _duration, 0, 1)`）
- **现象**：`_duration = NaN` 时 `clamp(0 / NaN)` = NaN → `d0/d1` 为 NaN → `deltaX/deltaY` 为 NaN，直接写进角色位移。
- **证据**：`duration = NaN` → 1 帧后 `deltaX = NaN, deltaY = NaN`；`distance = NaN` → 同样 `NaN`（`b1_v3` [19]）。
- **后果**：配表里 duration/distance 填错一次，角色坐标永久变 NaN，之后所有碰撞、渲染、寻路全部失效且不可恢复（NaN 会传染），表现为"角色突然消失、游戏半瘫"。这是任务书 A 类点名的"一个 NaN 帧让坐标永久变 NaN"的实锤。
- **建议**：两个字段用 `numOr` 收口，或对 `duration` 用 `!(x > 0)` 守卫（该单元在别处已有这类守卫，此处漏了）。

### P1 · [grid] NaN 坐标能"放置成功"但成为幽灵建筑，且 `freeCount` 不减

- **位置**：`Grid.ts:308`~`:322`（`canPlace`）、`:341`~`:345`（`place`）
- **现象**：边界检查 `x < 0 || y < 0 || x + w > W || y + h > H` 对 NaN 全为 false → `canPlace` 返回 **true**。`place` 把 id 写进 `this._cells[NaN]`——这是数组的 `"NaN"` 字符串属性，**不进入 `length`**。
- **证据**：`canPlace('h', NaN, 3)` = **true**；`place` 返回 `h#1`；`at(NaN,3)` 能查到 `h#1`；但**按坐标全图扫描 10×10 看到的占用格数 = 0**；`freeCount = 100`（对照组正常放置 2×2 后 = **96**）；同位置第二次 `place` 返回 `null`（`b1_v2` [6]、`b1_v4` [37]）。
- **后果**：坐标来自 UI 拖拽 / 网络包 / 存档反序列化时一旦出现 NaN，建筑"放置成功"扣了费、占了 `placedCount`，但渲染层遍历 `length` 永远画不出它，玩家看到"钱扣了地是空的"；`freeCount` 不减还会让"剩余空间"UI 偏大。不报错、不崩溃。
- **建议**：`canPlace` 改用 `Number.isFinite(x) && Number.isFinite(y)` 前置校验，并把 `x >= 0` 类判断统一换成"取反"式守卫。
- **影响面**：`adapters.toFlatGrid` / 建造类玩法 / 存档校验链路。

### P1 · [grid] README 与源码 JSDoc 的 `find` 示例签名是错的

- **位置**：源码 `Grid.ts:183` 签名 `find(predicate: (value: T, x, y) => boolean)`；README `:14` 与源码 JSDoc `:34` 都写 `g.find((c) => c.value === '树')`
- **现象**：回调第一个参数是**值本身**，不是 cell 对象。文档示例里的 `c.value` 恒为 `undefined`。
- **证据**：源码 `:183`~`:191` 实现为 `predicate(v, x, y)`，`v` 直接来自 `_data[i]`；文档示例按 `c.value` 取值（`b1` 源码核对）。
- **后果**：照文档写 → `undefined === '树'` 恒 false → `find` **静默返回空数组**。调用方会以为是"地图里没有树"，去查数据生成逻辑，永远查不到。
- **建议**：文档改为 `g.find((v) => v === '树')`，或让 `find` 真的传 cell 对象（后者破坏性大，建议改文档）。


## 【P2】P1 完成后再做

### P2 · [dash] （见正文）

- `DashState` 声明 `'idle' | 'dashing' | 'recovery'`（`:123`、状态机图 `:129`~`:133`），但全文件**从未给 `_state` 赋过 `'recovery'`**——死状态。
- `canCancel()` 与 `ready` 实现完全相同（冗余）；`_progressAt` 的 `norm = _progressAt(1) || 1` 在 `falloff = -1` 时 p=0 → norm 兜底为 1 → 位移恒 0。

### P2 · [grid] （见正文）

- `hexRing` `:502` 注释写"半径 n 内的所有格子（含中心）"，实测 `hexRing(center,1).length = 6`（是环），`hexSpiral(center,1).length = 7`（才是实心）（`b1_v3` [30]）。注释说谎。
- `freeCount` `:429` 每次 O(n) 全扫；`findSpots` `:436`~`:447` 为 O(W·H·w·h)。
- `hexToPixel` / `pixelToHex` 的 `size = 0` → 除零得 NaN 坐标，无校验。

### P2 · [objective] 事件顺序：先发 `completed`，再补发一个 `progress`

- **位置**：`ObjectiveSystem.ts:244`~`:246`
- **证据**：`setProgress('k', 10)`（target=10）→ 事件序列为 `completed/10 | progress/10`（`b1_v3` [25]）。
- **后果**：订阅方先收到完成、再收到一条"进度 10"，容易把 UI 的"已完成"态覆盖回"进行中"。JSDoc `:93`~`:98` 未约定事件顺序。
- **建议**：完成时不补发 progress，或在 JSDoc 明确"completed 之后仍可能收到同帧 progress"。

### P2 · [objective] `setProgress` / `addProgress` 不校验有限性

- **位置**：`ObjectiveSystem.ts:239`、`:268`
- **证据**：`setProgress('k', NaN)` → `status = active`、`progress = NaN`，并上报 `progress/NaN` 事件（`b1_v3` [25]）。
- **后果**：进度来自外部计数（击杀数、采集数）时，一次 NaN 会让 UI 进度条显示 NaN 且无法自愈（`protect` 的 `progress <= 0` 也挡不住 NaN）。

### P2 · [objective] 无 `destroy()`；`reset()` 不触发任何 `onEvent`

- 该类持有 `onEvent` / `onAllComplete` / `onFailed` **三个外部回调**，rule5 要求可卸载。

---

### P2 · [progressbar] `lowThreshold` / `highThreshold` 未收口，同一构造函数里两套标准

- **位置**：`ProgressBar.ts:140`~`:141`（`clamp01(opts.x ?? 默认)`）
- **现象**：`clamp01` 只挡 NaN 的一部分路径，非数字会直接穿透 → `r <= NaN` 恒 false → **永远不进入 low 态**。
- **证据**：`value = 5`（5%）、`lowThreshold = NaN` → `state = **normal**`；对照组默认 `0.25` → `state = **low**`（`b1_v2` [13]）。
- **后果**：血条危险时不显示红色/闪烁，玩家在残血时得不到预警。这是血条最核心的功能之一，静默失效。
- **建议**：与同文件其他字段统一为 `Math.max(0, numOr(opts.x, 默认))`。

### P2 · [progressbar] `segmentBounds` 的 gap 分摊不对称

- **位置**：`ProgressBar.ts:370`~`:373`
- **现象**：首段/末段各只扣 `gap/2`，中间段扣 `gap` → **两端段比中间段宽 `gap/2`**。
- **后果**：分段血条/经验条视觉上格子不等宽，美术会当作渲染问题来查。

### P2 · [progressbar] 构造校验挡不住 NaN；无 `destroy()`

- `if (this._max <= this._min) throw` 对 NaN 恒 false（NaN 比较恒 false）。`snapshot()` 每帧 new 对象。

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

新建 `tests/run_phase10_w7a.ts`，并**在文件内导出** `runPhase10W7ATests()`：

```ts
export function runPhase10W7ATests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W7-A.md`，每条一行：

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
| **文件命名** | `run_phase10_w7a.ts` / `result_W7-A.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 A 组**。修完之后，按 `audit/review_A.md` 验收 **W7-B**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W7-A.md`，
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
