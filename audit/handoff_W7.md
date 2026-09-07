# 精审返工任务书 · 窗口 W7

> 本文件是**第二次精审 273 条**中分配给窗口 W7 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **28**（P1 28 / P2 0） |
| 单元 | **18** 个 |
| 来源批次 | batch5 |
| 并行窗口 | 共 8 个（W1~W8），**单元零重叠** |

---

## 0. 一句话任务

按第 3 节的清单，逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

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

**`_core/` 不在任何窗口的清单里，严禁修改。** 它被 55 个单元依赖，你改一行会同时影响另外 7 个窗口。

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

### 3.1 你的单元（18 个，与其它窗口零重叠）

```
builder  cheatcode  craft  crash  currency  dialogue  gesture  inventory  joystick-mover  matchops  quest  ranking  reddot  shop  signal  skill-queue  stats  turn
```

---


## 【P1】先做这批

### P1 · [builder] `PlaceResult.missing` 声明了但从未被填充

- **位置**：`builder/Builder.ts:133`（接口里 `readonly missing?: Readonly<Record<ResourceId, number>>`）、`:366-380`（`preview` 里 `missing` 是**局部变量**，返回对象里没有它）、`:398-403`（`place` 失败时只透传 `error`/`detail`）
- **证据**：`place` 与 `preview` 在资源不足时均返回 `error: 'insufficient-resources'`，`missing` 实测为 `undefined`。
- **后果**：契约说谎。调用方照着类型定义写 `if (r.missing?.wood)` 来做"还差多少木头"的提示，运行时永远走不到，功能静默失效（玩家点了建造没反应，也没提示）。比没有这个字段更糟——类型检查是过的。
- **建议**：`preview` 的返回里带上 `missing`，`place` 失败时透传。

### P1 · [builder] `rotateCell` 对非法角度静默返回原值

- **位置**：`builder/Builder.ts:187-194`（`default: return c;`）
- **证据**：`rotateCell({x:1,y:0}, 45 as never)` → `{x:1,y:0}`（正确应是抛错或至少不静默）。
- **后果**：`Direction` 是 `0|90|180|270` 的字面量联合，TS 层能挡住；但蓝图配置从 JSON 反序列化后是 `number`，`rot` 传 45 时建筑**不旋转也不报错**，占位与预览对不上，玩家看到的是"我选了旋转但它没转"。
- **建议**：`default: throw new Error(...)`，或在配置解析层校验。

其他复核：`remove` 的返还率（`:479-481`）正确区分了"未完工全额退 / 已完成按比例"；`_counts` 用 `Math.max(0, ...)` 防负数（`:477`、`:550`）；`validate()` 的前置/升级目标/空占位/返还率四项校验完整；`place` 先 `preview` 再 `spend`，预览与落地的判据一致（只有 upgrade 例外）。依赖只到 `_core/math`，无 rule6 违规。**无 `destroy()`**（有 `clear()`，见共性问题）。

---

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

### P1 · [craft] `totalMaterials` 递归时忽略子配方的产出倍率，材料需求被高估

- **位置**：`craft/CraftSystem.ts:246-283`，关键在 `:275`（`this.totalMaterials(sub.id, need, inv, visiting, out)`）
  递归时把"需要 `need` 个产物"直接当成"需要做 `need` 次子配方"，但子配方一次产出 `output.count` 个（这里是 4 个）。
- **证据**：
  ```
  配方 plank: 2 木 → 4 板
  配方 house: 8 板 → 1 房
  实际：8 板 ÷ 4 板/次 = 2 次合成 × 2 木 = 4 木
  totalMaterials('house', 1) = {"wood": 16}    ← 高估 4 倍（正好等于产率）
  ```
- **后果**："材料清单"UI 让玩家去攒 4 倍的材料；更糟的是自动 crafting/代工系统照着这个数去执行合成，会多做 4 倍的中间产物，材料消耗远超预期。数字看起来"合理"（都是正整数），不会触发任何校验。
- **建议**：`:275` 改成 `this.totalMaterials(sub.id, Math.ceil(need / (sub.output.count ?? 1)), ...)`；注意有 `variants` 时产率不定，应取最大产率或注明是上界。

### P1 · [craft] 副产物被背包丢弃时静默消失

- **位置**：`craft/CraftSystem.ts:351-358`（`const got = bp.count * count - leftover; if (got > 0) byproducts.push(...)`）
- **证据**：构造一个放不下 `slag` 的背包，实测
  ```
  craft -> {"ok":true,"produced":[{"itemId":"sword","count":1}],"byproducts":[]}
  ```
  `ok: true`，`byproducts` 是空数组，没有任何字段表示"有副产物被丢了"。
- **后果**：主产物成功了，副产物因为背包满被 `Inventory.add` 吞掉，玩家完全不知情。带概率的稀有副产物（比如 5% 出橙装）丢掉时，运营侧看到的是"掉率异常低"，代码侧一切正常。
- **建议**：加 `lost` 或 `discarded` 字段，或在 `got < bp.count * count` 时返回 `reason: 'output_failed'` 之外的警告。

### P1 · [craft] 全部 `consume:false` 的配方，`canCraft` 返回 `ok:true` 但 `maxCount:0`

- **位置**：`craft/CraftSystem.ts:211-220`（`maxCount` 只在 `input.consume !== false && per > 0` 时更新，否则保持 `Infinity`），`:220`（`maxCount: Number.isFinite(maxCount) ? maxCount : 0`）
- **证据**：单输入 `{consume:false}` 的配方 → `canCraft` 返回 `{"ok":true,"missing":[],"maxCount":0}`。
- **后果**：UI 拿 `maxCount` 做"最多能做几个"滑块的取值上限，会得到 0，滑块直接禁用；但 `craft()` 本身能成功。两个 API 对同一事实给出相反答案。
- **建议**：无消耗输入时 `maxCount` 应返回 `Infinity`（或引入 `unlimited: true` 标志），而不是 0。

其他复核：`craft` 的原子性做得**正确**——先产出后扣料（`:328-348`），产出失败时把已加入的部分全部 `remove` 回滚（`:339-342`）；`_pickVariant` 的权重轮盘（`:385-398`）在无 rng 时退化为取第一个（`:386`），有 rng 时实现正确；`totalMaterials` 的 `visiting` 集合（`:250`/`:255`/`:281`）防循环依赖，但注意它在递归结束后 `delete`（`:281`）意味着同一个配方在**不同分支**上会被重复计入——对"总需求"语义是对的，对"依赖树"语义是错的，属设计取舍。

---

### P1 · [crash] `_seen` 指纹表只增不减，且 `dedupeWindow` 过期后不清理

- **位置**：`crash/CrashReporter.ts:177`（`private readonly _seen = new Map(...)`）、`:290`（每次 capture 都 `set`）、`:407-411`（`reset()` 是唯一的清理入口，但用户不会在运行时调）
- **证据**：`dedupeWindow: 1` 的配置下，抓 1000 个**不同指纹**的异常 → `stats().length = 1000`。（对照：同指纹 500 次 → 只有 1 条，去重本身是有效的。）
- **后果**：指纹由 `name + 首个堆栈帧` 构成（`:477-481`），线上一个复杂应用的去重后指纹数可以上万。每条还带着 `{count, lastSent}`，长期运行的会话（尤其是崩溃风暴时）会持续膨胀。更实际的问题是 `stats()`（`:401-405`）每次都要 `[...entries].map().sort()` 全表排序，随指纹数线性劣化。
- **建议**：给 `_seen` 加容量上限（LRU）或在 `capture` 时顺带清理 `now - lastSent > dedupeWindow * K` 的陈旧条目。

### P1 · [crash] 采样用裸 `Math.random`，不可复现、不可测试

- **位置**：`crash/CrashReporter.ts:294`（`if (Math.random() > this._sampleRate) return false;`）
- **证据**：`sampleRate: 0.5` 下 200 次不同异常发送 105 次——比例对，但每次运行结果都不同（实测多次不一致）。
- **后果**：违反 F 类"随机数走 `IRandomSource` 注入"。`sampleRate` 相关的单元测试无法稳定断言（只能写"大致 50%"），且线上无法用固定种子复现某次采样决策，排查"为什么这条崩溃没上报"时无从下手。这是本批唯一一处裸 `Math.random`（我已 grep 全批 23 单元确认）。
- **建议**：构造函数加 `random?: IRandomSource` 选项，默认用 `Math.random` 包装，测试时注入固定序列。

其他复核：`BreadcrumbRing` 的环形裁剪（`:146-150`）正确（`_limit` 由 `clampNum(opts.breadcrumbLimit, 1, 1e6, 30)` 收口，是本批**唯一用 `clampNum` 收口容量的地方**，值得作为范本）；`_collectLogs` 的 `try/catch`（`:415-421`）吞掉日志源异常是**正确的**（采集崩溃时不能再抛）；`safeStringify` 用 `WeakSet` 处理循环引用（`:590-596`）实现正确；`normalize` 对 string/object/unknown 四种输入的处理完整。**P2**：`uninstall()` 把 `onerror` 设成 `null` 而不是删除属性（`:362` `?? null` 把 `undefined` 转成了 `null`），浏览器语义等价，Node 下会新增一个值为 null 的属性。

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

### P1 · [dialogue] 所有选项条件都不满足时，对话进入无法前进也无法退出的死锁

- **位置**：`dialogue/DialogueGraph.ts:272-285`（`advance`：有 choices 就直接 `return false`）、`:293-307`（`choose`：条件不满足 `return false`）、`:319-324`（`end` 存在但没有"无路可走"的自动退出）
- **证据**：
  ```
  节点 n1 有两个选项，condition 都是 () => false
  choices=[{index:0,enabled:false},{index:1,enabled:false}]
  choose(0)=false  choose(1)=false  advance()=false
  isDone=false     ← 既不能选、也不能进、也不能结束
  ```
- **后果**：条件对话（"需要钥匙""需要好感度≥80"）是标配。当玩家状态不满足任何分支时，UI 会显示两个灰掉的按钮加一个点了没反应的"继续"。`showDisabled` 字段（`:73`）说明作者考虑过禁用态，但没考虑"全禁用"。玩家只能杀进程。
- **建议**：`advance()` 在"有 choices 但无一 enabled"时返回 false 的**同时**提供 `hasEnabledChoice()` 之类的查询，或在 `advanceToChoice`（`:335-345`）里把"无可用选项"视为终态并 `end()`。至少要让调用方能检测到这个状态。

其他复核：`validate()`（`:147-164`）对 choices 与 next 的悬空引用检查完整、且正确区分了"有 choices 时不校验 next"；`findUnreachable` 用 BFS + `seen` 集合，无死循环；`_history` 只增不减（`:358`），超长对话（galgame 式）会累积——**P2**。`destroy()` 在 Graph 与 Runner 上都有，清得干净。

---

### P1 · [gesture] `maxPoints` 裁剪丢弃轨迹起点，长按时长被算短 → 长按判不出来

- **位置**：`gesture/Gesture.ts:333-360`（`down`/`move`）、`:356-359`（`if (this._pts.length > this._opts.maxPoints) this._pts.shift();`）、`:382-389`（`isLongPressSoFar`）
- **现象**：`maxPoints` 是**滑动窗口**，`shift()` 丢的是**最早的点**，而"按了多久"恰恰由最早的点决定。
- **证据**：`maxPoints: 8`、静止按住 1 秒（20 个采样点，`t` 从 0 到 1000）：
  ```
  pointCount=8 首点 t=650        ← 起点 0 被丢，窗口里最早的点已经是 650ms
  isLongPressSoFar(1000)=false   ← 长按阈值 600ms，实际按了 1000ms，判不出来
  up -> {"kind":"tap","distance":0,"speed":0}   ← 长按被识别成单击
  ```
- **后果**：长按时如果手指有轻微抖动（产生 >maxPoints 个采样点，默认 64 通常够，但高刷屏 + 小 maxPoints 配置就会触发），"长按 1 秒"被识别成"点击"。玩家的表现是"我明明按住了却触发了普通点击"，且**只在特定设备上复现**（采样率越高越容易），极难定位。
- **建议**：`down()` 时单独记 `this._downT = p.t`，`isLongPressSoFar` 与 `up()` 的时长判定都用它，而不是 `this._pts[0].t`。轨迹裁剪照旧。

其他复核：`dt` 的守卫（`:211-214`）`Number.isFinite(rawDt) && rawDt > 0` 正确挡住了 `NaN/Infinity`；`recognizePinch` 的 `d0 <= 1e-6` 除零守卫到位；`dirOf` 的 `yDown` 处理正确。零依赖、无泄漏、无业务耦合。

---

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

### P1 · [joystick-mover] `evaluate()` 返回内部复用的同一个可变对象，调用方持有的引用会被后续帧改写

- **位置**：`joystick-mover/JoystickCore.ts:102`（`private readonly _out`）、`:210-249`（每次 `evaluate` 都是写这个 `_out` 并 `return o`）
- **证据**：
  ```js
  const a = j.evaluate();   // 此时 magnitude 0.5
  j.onMove(1, 100, 0);
  const b = j.evaluate();   // magnitude 1
  a === b        → true
  a.magnitude    → 1        ← a 被改写成了 b 的值
  a.dir === b.dir → true
  ```
- **后果**：本意是"每帧零分配"（热路径优化，意图是对的），但 `JoystickOutput` 是导出接口，调用方天然会认为它是**值**。典型踩法：`this.lastDir = core.evaluate().dir`（存了个引用做方向平滑或比较"方向是否变化"）——下一帧这个引用就被覆盖了，平滑失效、比较恒等。Cocos 侧 `JoystickMover._updateVisual`（`:225-232`）自己是用 `_lastX/_lastY` 逐字段缓存的，**侥幸**避开了，但这说明陷阱确实存在且库作者自己都在防。
- **建议**：JSDoc 顶部用醒目文字写明"返回的对象每帧复用，需要保存请自行拷贝 `dir`"，或提供 `evaluateInto(out)` 与 `snapshot()` 两个方法。
- **影响面**：`JoystickMover.output`（`:83-85`）直接透出这个对象，是整个单元对外的主入口，风险面最大。

其他复核：`onDown` 的 `EXTERNAL_DRIVE_ID = -1`（`:41`、`:131`、`:279`）把"手柄/键盘驱动"与"触摸驱动"分流，设计干净；`_snap` 的方向吸附（`:251-256`）用 `Math.round(a/step)*step`，正确；`onUp`/`reset` 在 dynamic 模式下重置 center（`:198-201`）正确；`onDestroy`（`:242-254`）把四个 `Node.EventType` 监听全部 `off`、清空三个回调、销毁 core——是本批**生命周期处理最规范**的一处（`reddot`/`crash` 都该照这个改）。引擎耦合 `cc` 只出现在 `JoystickMover.ts`，`JoystickCore` 保持纯逻辑，分层符合 `_kitmeta` 的 `engineCoupled: true` 声明。

---

### P1 · [matchops] `ReconnectTracker` 的 `graceMs` / `graceDecay` 为 `NaN` 时，重连宽限期变成"永不过期"

- **位置**：`matchops/Reconnect.ts:154-160`（`??` 收口，不挡 NaN）、`:385-388`（`_computeGrace`：`Math.max(this._minGraceMs, Math.round(NaN))` = NaN）、`:296`（`if (elapsed > grace)` 对 NaN 恒 false）、`:333`（`now - e.disconnectedAt > limit`）
- **证据**：
  ```
  graceDecay=NaN：
    第 1 次 grace=120000（Math.pow(NaN,0)===1，侥幸正确）
    重连后 attempts=1 → grace=NaN
    再断线，10 小时后 reconnect -> {"ok":true}   ← 永不过期
    tick(36e6) -> []                              ← 也永不判弃权

  graceMs=NaN：
    graceFor=NaN，断线 10 小时后 reconnect -> {"ok":true}
  ```
- **后果**：配置表把 `graceMs` 写成 `null`（`?? `会把 `null` 也兜掉，安全）或字符串数字（不安全）时，掉线玩家**任何时候**重连都能成功，且 `tick` 永远不会把他判为弃权。对局里出现"队友掉线 3 小时，比赛一直不结束"的悬挂对局。同时 `penaltyRates` 因为他既不是 forfeited 也不是 exhausted，队友也不会得到惩罚减免——整套惩罚逻辑静默失效。
- **建议**：`_computeGrace` 里 `const g = numOr(decayed, DEFAULTS.graceMs)`，或在构造时对 `graceMs`/`graceDecay` 做 `clampNum` + 有限性断言（`graceDecay` 应在 (0,1]）。

### P1 · [matchops] `Surrender.vote` 对掉线玩家返回 `ok:true`，但票不被计入

- **位置**：`matchops/Surrender.ts:249-270`（`vote` 只查 `_team.has(id)` 和 state/deadline，**不查 connected**）对照 `:391-402`（`_tally`：`if (!this._connected.has(id)) continue;` 把掉线玩家的票跳过）
- **证据**：
  ```
  3 人队，全员在线时 start 成功
  中途 setConnected(['a','b'])，c 掉线
  c 投票 -> {"ok":true}          ← 告诉 c "你投成功了"
  status -> {yes:1, ..., eligible:2, needMore:1}   ← c 的票没被计入
  ```
- **后果**：掉线重连的玩家（或网络抖动被短暂标记掉线的玩家）投了赞成票，UI 显示成功，但票数不变，投降永远差一票。玩家会反复点、以为是网络问题。配合 `requireAllConnected: true`（默认）时，只要有一人掉线，投降就**永远**无法发起或无法达成，对局被拖到超时。
- **建议**：`vote` 里对未连接的玩家返回 `{ ok:false, error:'not-connected' }`，与 `start`（`:217-219`）的口径一致；或在 `status` 里暴露 `ignoredVotes`，让 UI 能提示"你的票因掉线未计入"。

其他复核：`ReconnectTracker.reconnect` 的状态机（`:269-306`）顺序正确（先查 nonexistent → online → exhausted → matchEnded → forfeited → 超时）；`SpectateSession` 的 `maxSpectators`（`:183-185`）、`duplicate`、`not-started`/`ended`、`opponent-forbidden` 四道检查完整，实测第 3 人加入正确返回 `full`；`viewingTime` 的 `Math.max(startedAt, now - delay)`（`:273`）正确处理了开局初期"还没延迟够"的情况；`shouldAbortMatch`、`forfeitMultiplier`、`pickDirectorShot` 都是纯函数且无 NaN 风险（`pickDirectorShot` 用 `score > bestScore` 而非 `>=`，第一个候选必被选中，正确）。**三个类均无 `destroy()`**。

---

### P1 · [quest] `import()` 不校验 `status` 与 `progress` 元素类型

- **位置**：`quest/QuestSystem.ts:408-427`（`status: e.status` 直接写入，`progress[i] ?? 0` 不校验类型）
- **证据**：`import([{ id:'q1', status:'garbage', progress:['a'] }])` → `skipped=0`，`status='garbage'`，`progress=['a']`。
- **后果**：存档被篡改或跨版本后，任务进入一个枚举外的状态——`available`/`active`/`completed` 三个 getter 都查不到它，任务从 UI 上"消失"，但 `_defs` 里还在，`_refreshLocks` 每帧遍历它。更隐蔽的是 `progress=['a']` 让 `_isAllDone` 判定为已完成（`‘a’ < 5` 为 false），下次任何 `setProgress` 都会触发 completed + 发奖。
- **建议**：`import` 时校验 `status` 属于 `QuestStatus` 枚举、`progress` 元素是有限数，否则计入 `skipped`。

其他复核：`claim` 的防重复领奖（`:340-341` 查 `status==='completed'` 且 `!claimed`）正确，`repeatable` 任务在领奖后重置为 `available`（`:345-353`）且 `claimed` 归零，语义完整；`_unlockDependents` + `_refreshLocks` 双路径解锁（有冗余但都正确，且 `_refreshLocks` 在 `report` 末尾兜底）；`_matches` 的 `custom` 类型走 `test` 回调、其余比对 `type` 与 `target`，正确。`destroy()`（`:440-445`）清理完整。依赖为空（零依赖），无 rule6 违规。

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

### P1 · [reddot] `activePaths()` 是 O(n²)：对每个叶子做一次全表 `get()`

- **位置**：`reddot/RedDot.ts:167-169`（`[...this._leaf.keys()].filter((p) => this.get(p) > 0)`）对照 `:115-135`（`get` 内部 `for (const [p, n] of this._leaf)` 全表扫描）
- **证据**：实测耗时随叶子数呈二次增长
  ```
  n=500  -> 5ms
  n=1000 -> 5ms
  n=2000 -> 28ms    （n 翻倍，耗时 5.6 倍）
  n=4000 -> 95ms    （n 再翻倍，耗时 3.4 倍）
  ```
- **后果**：红点树在 UI 层通常每帧或每次数据变更时全量刷新一次。一个中等复杂度的红点树（邮件 / 任务 / 商店 / 成就 / 好友，每类几百个叶子）轻松到几千节点，`activePaths` 一次 100ms 会直接掉帧。而且它是**静默劣化**：开发期红点少，上线后内容变多才暴露。
- **建议**：单次遍历建前缀累加表（`Map<string, number>`，对每个叶子把其所有祖先加上 n），O(n·depth) 一次算出所有节点的值；或给 `get` 加按前缀分层的缓存。

其他复核：`get` 的 `hasOwnProperty` 式误匹配问题已用 `path + sep` 前缀规避（实测 `get('mail')=3` 不含 `mailbox` 的 100），正确；`set` 的 `Number.isFinite` 守卫（`:67-69`）到位，`add(NaN)` 会抛错而不是静默；`override` 的 `null` 语义正确。**无 `destroy()`**（见跨单元共性问题 C-3）。

---

### P1 · [shop] `_log` 无容量上限，长期运行无限增长

- **位置**：`shop/Shop.ts:128-134`（声明）、`:315`/`:338`（push）、`:407-409`（只有 `clearLog`）
- **证据**：连续 5000 次购买后 `log.length = 5000`（对照 `currency` 的 `logLimit` 默认 200 且可裁剪）。
- **后果**：商店流水是服务器常驻进程里增长最快的日志之一（每个玩家每次购买一条）。没有上限意味着一次会话累积几十万条后内存与 `netSpent()` 的遍历（`:391-397` 每次全表扫描）同步劣化。
- **建议**：加 `logLimit` 选项并用 `clampNum` 收口，与 `Wallet` 对齐。

其他复核：`stock.count` 的 `-1 = 无限库存` 语义在三处（`:297`、`:313`、`:336`）一致且正确；`preview` 与 `buy` 的判据一致（不会预览通过但购买失败）；`restock` 的 `stockRange` / `markupRange` 未校验 `min > max`（会产生负数 count → 恰好等于"无限库存"）——**P2**。`destroy()`（`:411-416`）清理完整。零依赖，无 rule6 违规。

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

### P1 · [turn] `start(shuffleEqual = true)` 声称打乱同先攻单位，实际完全不打乱

- **位置**：`turn/TurnSystem.ts:205`（`return shuffleEqual ? 0 : a.id.localeCompare(b.id);`）
  `Array.prototype.sort` 的比较函数返回 `0` 时保持原序（ES2019 起稳定排序），所以 `shuffleEqual=true` 的结果是**按添加顺序**。而且整个函数没有注入随机源。
- **证据**：6 个同先攻单位，三种调用全部输出 `u0,u1,u2,u3,u4,u5`。
- **后果**：README（`:72`）写 `start(shuffleEqual?)` 是"开始（排序）"，参数名暗示"打乱同分"。回合制里同先攻单位谁先手通常决定胜负（先手秒杀），配置为 `true` 的游戏实际永远是"先加入的先手"——一个**系统性的先手优势**，玩家会投诉"为什么总是他先打我"。
- **建议**：要么注入 `IRandomSource` 做真随机（与库内 `card`/`gacha` 的口径一致），要么把参数改名为 `stableOrder` 并更正文档。

其他复核：`_advance` 的 `guard`/`maxGuard` 防死循环（`:266-273`）到位；`_doRemove` 的 `if (idx <= this._cursor) this._cursor--`（`:324`）正确维护了游标；`orderPreview` 的取模遍历（`:387-391`）正确；`destroy()`（`:400-407`）清理完整。**P2**：`spendAP(-5)` 会让 AP 增加（实测 3 → 8），`:340` 应改为 `if (!(n > 0) || e.ap < n) return false;`。零依赖，无 rule6 违规。

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

新建 `tests/run_phase10_w7.ts`，并**在文件内导出** `runPhase10W7Tests()`：

```ts
export function runPhase10W7Tests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（8 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W7.md`，每条一行：

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

## 6. 并行纪律（8 个窗口同时开工）

| 事项 | 约定 |
|---|---|
| **单元边界** | 8 个窗口**零重叠**，已核验 |
| **`_core/`** | 谁都不要碰 |
| **`tests/run.ts`** | **总审统一合并**，你不要改 |
| **`README.md`** | 测试总数在变，**不要改**，总审统一更新 |
| **临时脚本** | 放 `/tmp` 或 `verify/`（用完删） |
| **`build.sh`** | 会整体替换 `.build/`；偶发 502 导致中断时**重跑一次**即可 |
| **文件命名** | `run_phase10_w7.ts` / `result_W7.md`，带你的窗口号，避免撞名 |

---

## 7. 需要总审裁决的先记下来

遇到以下情况**不要自己拍板**，在报告里标"需总审裁决"并说明两种选择的利弊：

1. 修复会改变**对外 API 行为**（可能 breaking）
2. 报告建议的改法与单元 README 的**明确声明冲突**
3. 两处代码"看起来不一致但可能都是故意的"
   （例：相切语义——空间索引要求"不含相切"，通用 AABB 要求"含相切"，**两者都对**）
4. 你判断某条"不成立"

---

## 8. 最后一句

这个库现在 **3695 项测试全绿**，是你开工前的基线。
你交付时这个数字只能涨、不能跌——如果跌了，说明你的修复伤到了既有行为，
回去看第 1.1 节第 1 条。
