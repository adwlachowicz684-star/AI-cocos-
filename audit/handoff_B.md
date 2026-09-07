# 精审返工任务书 · 窗口 B

> 本文件是**第二次精审 273 条**中，分配给窗口 B 的剩余条目。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、3695 项测试全绿、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

---

## 0. 一句话任务

按下面第 3 节的清单，逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

---

## 1. 角色与纪律

你是**执行者**，不是审查者。拿到清单 → 复现 → 修 → 写测试 → 自检。

### 1.1 三条硬纪律

1. **不要顺手重构。** 只改清单里指出的那一行/那一处。
   这个库大量"看起来别扭"的写法都带长注释解释原因；
   你在某个单元里"顺手优化"的代码，很可能是另一个单元赖以正确工作的前提。
   我自己就在 `prewarm` 上犯过这个错——顺手把预热数夹到 `maxSize` 以内，
   结果既有测试立刻变红，因为那两个是**独立的契约**。

2. **改之前必须先复现。** 写个最小脚本跑出"修复前"的现象，
   把真实输出贴进你的报告。没有复现就不要改——
   报告里的"证据"是别的窗口写的，你要自己验证一遍。

3. **注释要写"为什么"，不是"改了什么"。**
   重点写：这个坑的表现是什么、为什么原写法会中招、为什么新写法是对的。
   这个库最大的价值就是这些注释——很多坑会换个地方重新长出来，
   注释是唯一能拦住下一个人的东西。

### 1.2 一个反直觉但很重要的口径

**注释/文档如果主动论证"这是设计如此"，你要格外警惕，而不是格外放心。**

这个项目里已经出现过多次：代码有坑，而旁边的注释写了一段看似合理的论证说明它没问题。
真实案例：

- `perception` 的抖动注释写"只影响观感，不需要可复现"——实测抖动值直接喂进了 `alert` 累积，**注释的前提是假的**。
- `_core` 的 `smoothDamp` 曾把失效的 maxSpeed 记成"Unity 标准行为，非 bug"，还附了实测数据和权威叙事——**数据为真、归因为假**。
- README 曾把已修的缺陷记成"设计如此"，导致后来的人看到文档就不去修了。

所以：**文档说"没问题"不等于真没问题。** 按证据判断，不按注释判断。

---

## 2. 代码库速览

### 2.1 位置与基本命令

```bash
cd /data/workspace/AI-cocos--main
bash build.sh                    # 编译到 .build/（不要跳过）
node .build/tests/run.js         # 全量回归
```

`build.sh` 有产物自愈与**逐文件比对**（不是只比总数——总数校验抓不到"tests 少 23 个"的情况）。

### 2.2 七条铁律（违反会导致构建/校验失败）

| 铁律 | 内容 |
|---|---|
| 1 | **无引擎依赖**：不得 `import 'cc'`，只能用注入的适配器。唯一例外是 `adapters/CocosAdapter.ts` |
| 2 | **不 import 引擎类型**：连 `import type { Node } from 'cc'` 也不行 |
| 3 | **运行时依赖 0**：不得 import 任何第三方包 |
| 4 | **配置驱动**：数值不得硬编码，要可配 |
| 5 | **可卸载**：有 `install` 必须有对应的 `uninstall`/`destroy` |
| 6 | **禁止横向 import**：单元之间不得互相 import（`_core` 例外） |
| 7 | **复制即可用**：使用者拷走目录后改 0 行 |

### 2.3 现成的共享工具（`_core/`，**直接用，不要自己造**）

| 工具 | 用途 |
|---|---|
| `clampNum(v, lo, hi, def)` | 数值收口，**NaN 会回落到 def** |
| `numOr(v, def)` | 非有限值回落 |
| `safeDt(dt)` | dt 守卫（挡 NaN / 负数 / 过大） |
| `needCount(n, max?)` | 无界 count 守卫（挡 Infinity / NaN） |
| `hasOwn(obj, k)` | 原型链安全的 `in` |
| `assertSafePath(p)` | 路径写入的原型污染防护 |
| `MathRandomSource` | 唯一允许的随机源 |

**`_core/` 不在你的清单里，严禁修改它。** 它被 55 个单元依赖，你改一行会同时影响另外两个窗口。

### 2.4 六个校验脚本（提交前全部要过）

```bash
node scripts/check-deps.js        # 依赖分层
node scripts/check-links.js       # 内部链接
python3 scripts/scan-dt-guard.py  # dt 守卫
python3 scripts/scan-num-guard.py # 数值收口
python3 scripts/check-random-source.py  # 随机源
python3 scripts/check-dup-exports.py    # 重复导出
```

⚠️ **临时验证脚本放在 `verify/` 下会导致 `check-deps.js` 报错**（该目录没有登记分层）。
用完请删除 `verify/`，或改放 `/tmp` 下。

---

## 3. 本批清单（85 条：P1 {n_p1} / P2 {n_p2}）

覆盖批次：batch2 / batch5。涉及 39 个单元。
**本批单元与其它两个窗口完全不重叠**（已核验：无单元跨批次）。

### 单元清单

```
affix  autoquality  binary  blessing  builder  cheatcode  config  craft  crash  currency  curse  daily  diagpack  dialogue  gesture  interact  inventory  joystick-mover  leaderboard  logger  loot  matchops  meta  quest  ranking  reddot  room-graph  runscope  scheduler  scheduling  score  shop  signal  skill-queue  snapshot  stats  turn  tween  wave-spawner
```

---


## 【P1】先做这批

### P1 · [affix] 区间宽度小于一个精度单位时，roll 出的值落在 [min, max] 之外

- **位置**：`affix/AffixSystem.ts:309-330`（`lo = Math.ceil(rawLo*f)/f`、`hi = Math.floor(rawHi*f)/f`、L319-321 `if (hi <= lo) v = lo`、L329-330 收口）
- **现象**：`lo` 向上取整、`hi` 向下取整，区间窄于一个精度单位时 `hi < lo`，取 `v = lo` 后又被 L330 的 `if (v > hi) v = hi` 拉到 `hi`——两个边界都不在配置区间内。
- **证据**：`verify/b2_v2.ts` §4 实测：
  ```
  def.min=1.2 max=1.4 precision=0 → 实际值 = 1   （不在 [1.2,1.4] 内）
  def.min=0.05 max=0.07 precision=1 → 实际值 = 0  （不在 [0.05,0.07] 内）
  ```
- **后果**：策划配了一条"1.2~1.4 的暴击倍率"，实际 roll 出 1.0。数值被悄悄改小且不报错，平衡性分析全部失真；`validateAffixPool` 也不报这个（只报稀有度倒挂），所以配置期发现不了。
- **建议**：`lo`/`hi` 用同一个方向取整（都 floor 或都 round），并在 `hi < lo` 时把值取 `Math.min(Math.max(lo, ...), hi)` 后再校验落在 `[min, max]`；或在 `validateAffixPool` 里加一条"区间宽度 < 精度单位"的 warning。

### P1 · [affix] `lastRerollDegraded` 只会置 true，从不复位

- **位置**：`affix/AffixSystem.ts:207-209`（仅 `this.lastRerollDegraded = true;`），字段声明 L109
- **证据**：`verify/b2_v2.ts` §5 实测：第一次 `rerollAll` 后置 true，**再跑 2 次后仍是 true**。
- **后果**：字段名与 README 语义是"本次 reroll 是否降级"，实际语义是"历史是否曾降级"。UI 用它提示"这次洗练亏了"会一直亮着，玩家会误以为每次都在亏。
- **建议**：在 `rerollAll` 入口先置 `false`，再在降级处置 true。

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

### P1 · [binary] uint/int 在 31、32 位时范围计算溢出，契约声称支持 32 位但实际不可用

- **位置**：`uint` L22（`const max = (1 << bits) - 1;`）、`int` L44（`const half = 1 << (bits - 1);`）、`writeBits` L278（`if (bits < 32 && v >= 1 << bits)`）
- **现象**：`1 << 31` 为负数、`1 << 32` 绕回 `1 << 0`，导致 31/32 位的合法区间被算成空区间或负区间。
- **证据**：实测 describe 与写入：
  ```
  uint(31) describe => uint31[0..-2147483649]
  uint(32) describe => uint32[0..0]
  int(32)  describe => int32[2147483648..-2147483649]
  uint(31).write(1) => THROW: [Binary] uint31 越界：1（范围 0..-2147483649）
  BitWriter.writeBits(1,31) => THROW: [Binary] 值 1 需要超过 31 位表示
  ```
- **后果**：README §6① 明确写"位宽上限 32…schema 构造时就校验"，§8 声称测试覆盖"32 位边界（0xffffffff）"。按文档去定义一个 32 位 ID/哈希字段，运行期必然抛错或（写入路径）静默出错，属于文档与实现对不上。
- **建议**：用 `2 ** bits` 的乘方语义替换 `1 << bits`，并对 32 位单独处理无符号上界 `0xffffffff`。
- **影响面**：与 P0-1 同源，建议一并修。

### P1 · [binary] float 量化位数用 floor 算、用 round 写，(max-min)/step 小数部分 ≥0.5 时写最大值抛错

- **位置**：L81（`levels = Math.floor((max-min)/step)+1`）、L82（`bits = ceil(log2(levels))`）vs L94（`q = Math.round((clamped - min) / step)`）
- **证据**：实测 `float(0, 1.8, 0.5)` describe 为 `float[0..1.8/0.5] (2bit)`，`.write(1.8)` 抛 `[Binary] 值 4 需要超过 2 位表示`。
- **后果**：配置里只要 `(max-min)/step` 不是整数就可能触发（如 0~1.8 步长 0.5）。写入端抛错尚可查，但读端 `read()`（L97）能表示的最大值会超出 `max`，两端不对称。
- **建议**：`levels = Math.floor((max - min) / step + 1e-9) + 1` 并在 write 里对 `q` 做 `Math.min(q, (1<<bits)-1)` 收口。

### P1 · [binary] float.write 对越界值静默 clamp，违反 README §6③"越界值绝不静默截断"

- **位置**：L93 `const clamped = Math.min(max, Math.max(min, v));`
- **证据**：实测 `float(0,10,1)` 写入 999 后读回 **10**，无任何报错；而 `uint/int` 同场景是抛错。
- **后果**：坐标/血量类字段写入超范围值时被悄悄改小，调用方以为写成功了。float 是本库最可能承载坐标的类型，静默截断会让"位置飘移"类 bug 极难定位。
- **建议**：与 uint/int 对齐，越界即抛；或增加 `clamp: boolean` 配置项显式声明。
- **影响面**：见"存疑"第 1 条（是否升 P0）。

### P1 · [blessing] `remove(id, n)` 的负数参数会加层，`add(id, NaN)` 让层数变成 NaN

- **位置**：`blessing/Blessing.ts:133-136`（`const actual = Math.min(cur, n); const next = cur - actual;`）、L121（`const actual = Math.min(n, ...)`）
- **证据**：`verify/b2_v4.ts` §D 实测：
  ```
  add 3 层后 stacks = 3
  remove(b, -5) 后 stacks = 8   （负数应当被忽略，实际变成加层）
  add(b, NaN) 后 stacks = NaN   effectiveStacks = NaN
  ```
- **后果**：调用方用"当前层数 - 目标层数"算差值（很常见的写法）得到负数时，remove 变成 add；NaN 一旦进 `_stacks`，`effectiveStacks` → NaN → `effectsOf` 的 `perStack * eff` → NaN，玩家属性直接变 NaN 且不报错。
- **建议**：入口收口 `n = Math.max(0, Math.floor(numOr(n, 0)))`，`add` 同理。

### P1 · [blessing] `set` 类型的效果被层数缩放

- **位置**：`blessing/Blessing.ts:184`（`value: e.op === 'mul' ? Math.pow(e.perStack, eff) : e.perStack * eff`）
- **现象**：`set` 的语义是"设为固定值"，但走的是与 `add` 相同的乘层数分支。
- **后果**：2 层的 "set maxHp 100" 变成 200。`curse`（L270-274）与 `meta`（L328）是同款写法，见"跨单元共性问题"第 4 条。
- **建议**：`case 'set'` 单独返回 `e.perStack`。

### P1 · [blessing] `importState` 不校验数值、不触发 onChange

- **位置**：`blessing/Blessing.ts:277-285`
- **现象**：`this._stacks.set(id, Math.min(n, cap));` 未做有限性/符号校验；导入后 `_onChange` 不触发。
- **后果**：存档被篡改或版本迁移残留负数/NaN 层数直接进入系统（与 P1-14 同样的 NaN 链路）；UI 在导入后仍显示旧层数，直到下次变更才同步。
- **建议**：校验 + 导入结束后对全部 key 触发一次 onChange。

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

### P1 · [config] 数字型 id 不参与重复检测，且索引静默覆盖

- **位置**：`config/Validator.ts:86`（`if (typeof r.id === 'string') {`），索引构建 `config/ConfigLoader.ts:102-110`
- **现象**：重复 id 检测只在 `typeof id === 'string'` 时执行；而 `_rowId`（Validator L111-113）、`checkReferences` 的 idSets（L212）、ConfigLoader 索引（L106）都接受 number。
- **证据**：`verify/b2_v3.ts` §6 实测：
  ```
  hero 表两行 id 都是 1 → validateTable 报出的问题 = []
  get(hero, 1) 实际拿到 = {"id":1,"name":"第二个（id 撞了）"}
  count(hero) = 2 （表里有 2 行，索引只留下 1 条）
  ```
- **后果**：用数字 id 的策划表（自动生成 id 很常见）出现重复时，启动校验全绿、行数也是对的，但按 id 取到的永远是后一条。表现为"某条配置改了不生效"，排查时会先怀疑热重载或缓存。
- **建议**：把 L86 的判断改成与 L212/L106 一致的 `typeof id === 'string' || typeof id === 'number'`，并在索引构建处对已存在的 key 记 issue。
- **影响面**：所有以 `get(table,id)` 取配置的 L2 单元（loot / affix / meta 等配置驱动单元都要走这条路）。

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

### P1 · [curse] `effects()` 把 `set` 效果乘以层数

- **位置**：`curse/Curse.ts:270-274`
- **证据**：`verify/b2_v4.ts` §E 实测：2 层的 `set maxHp 100` → `effects = [{"stat":"maxHp","op":"set","value":200}]`。
- **后果**：叠加型诅咒的"固定值"增益被放大，与实际数值设计不符（curse 的 effects 通常是"最大生命减半"这类固定值）。与 blessing P1-15、meta P1-25 同款。
- **建议**：`set` 分支直接返回 `e.value`。

### P1 · [curse] `importState` 不校验 `stacks`，负数会走 `Math.pow(value, -n)` 取倒数

- **位置**：`curse/Curse.ts:327-338`（`stacks: e.stacks ?? 1`）
- **现象**：`stacks` 为 -3 时，`effects()` 里 `Math.pow(e.value, -3)` 把值变成倒数。
- **后果**：损坏存档/被篡改的存档让诅咒效果反向（减益变增益），无报错。
- **建议**：`stacks: Math.max(0, Math.floor(numOr(e.stacks, 1)))`，并对 `since` 做有限性校验。

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

### P1 · [diagpack] `safeStringify` 把"共享引用"误判成循环引用，静默丢数据

- **位置**：`diagpack/DiagPack.ts:119-120`（`if (seen.has(o)) return '[Circular]'; seen.add(o);`），`seen` 在 `walk` 全程只增不回溯
- **证据**：`verify/b2_v4.ts` §L 实测：
  ```
  safeStringify({a: shared, b: shared}) = {"a":{"hp":100},"b":"[Circular]"}
  ```
- **后果**：同一个配置对象被两个字段引用（游戏中极常见：全局配置表被多个系统持有）时，诊断包里第二个字段变成 `"[Circular]"`。 crash 上报丢的是最关键的那份上下文，且看起来像"数据结构有问题"，实际是序列化器的问题。
- **建议**：`seen` 改成"路径栈"语义——进入时 `add`、递归返回时 `delete`（真正的环才会被拦下）。

### P1 · [diagpack] 脱敏把 JSON 结构改坏（且失败时空 catch 静默跳过）

- **位置**：`diagpack/DiagPack.ts:163-171`（keyPattern 的正则 `"[^"]*(?:src)[^"]*"\s*:\s*(?:"[^"]*"|[^,}\]]+)`）、L173-175（空 `catch {}`）
- **证据**：`verify/b2_v4.ts` §L 实测：
  ```
  redact 结果 = {"password": "[REDACTED]","nested":1}}     ← 多出一个 }，JSON 已损坏
  JSON.parse 失败 = Unexpected non-whitespace character after JSON at position 3
  诊断包里该分区 data 类型 = string  内容 = "{\"password\": \"[REDACTED]\"}}"
  ```
- **后果**：敏感字段的值是对象/数组时，脱敏后的报告不是合法 JSON，服务端解析失败 → 整个诊断包作废（"永不抛错"的承诺保住了，但上报内容不可用）。更严重的是 L173 的空 catch：任何正则异常都会让**脱敏被静默跳过**，而 README 承诺"序列化后脱敏"——这是可能把明文密码/token 报上去的路径。
- **建议**：脱敏改在**结构化数据上**做（在 `walk` 里按 key 匹配替换值），不要对 JSON 字符串做正则；catch 里至少 push 一条 warning。
- **影响面**：见存疑第 5 条（是否升 P0）。

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

### P1 · [interact] `Interactable` 接口没有 `pos` 字段，实现却靠双重强转去取——类型系统与文档对不上

- **位置**：`interact/Interact.ts:162`（`const pos = (item as unknown as { pos?: InteractContext['pos'] }).pos;`），接口定义 L6-26 无 `pos`
- **现象**：按接口类型写 `register({ id, data, radius })` 完全合法，此时 `evaluate` 走 L165-167 分支，返回 `distance: 0, alignment: 1, inRange: true`。
- **证据**：`verify/b2_v4.ts` §O 实测：
  ```
  相距无穷远（接口里没有 pos 字段）→ 候选数 = 1  distance = 0  inRange = true  valid = true
  ```
- **后果**：README §L61 说明"不提供 pos 时视为全局可交互（UI 按钮等）"，所以**运行时行为符合文档**；但 README §L19 的示例 `sys.register({ id:'chest', data:{...}, radius:3, pos:{x,y} })` 在 `strict` 下会因多余属性检查编译失败——用户必须自己 `as any` 才能照文档用。真正的风险是：按接口实现的调用方（不传 pos）会得到一个"永远可交互"的物体，而这在类型层面完全看不出来。
- **建议**：把 `pos?: { x: number; y: number; z?: number }` 正式加进 `Interactable`，去掉 L162 的双重强转。
- **影响面**：无下游（零依赖单元），但影响所有接入方的写法。

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

### P1 · [leaderboard] `importEntries` 是 `submit` 的旁路，绕过了分数有限性校验

- **位置**：`leaderboard/Leaderboard.ts:290-294`（只做浅拷贝 + 排序 + 裁剪），对比 `submit` L98-100 有 `Number.isFinite` 校验
- **证据**：`verify/b2_v4.ts` §N 实测：`importEntries` 接受 `score: NaN` 后 `ranked = [{"id":"p1","rank":1},{"id":"p2","rank":2}]`，NaN 分数静默混进榜单。
- **后果**：存档/服务端下发的榜单数据带 NaN 时，NaN 会参与排序（比较恒 false），名次顺序不可预测，玩家看到"分数是空的/乱序"；因为 `submit` 有校验而 `importEntries` 没有，排查方向会被引到"提交逻辑"。
- **建议**：`importEntries` 复用与 `submitAll`（L129-133）相同的校验，或提供 `{ strict }` 选项返回被丢弃的条目。

### P1 · [leaderboard] `ranked()` 每次调用全量展开，`capacity` 上限却允许 1e7

- **位置**：`leaderboard/Leaderboard.ts:79`（`clampNum(opts.capacity, 1, 1e7, 100)`）、L199-227（`ranked()` 对每个 entry 做 `{ ...e }`）、L231（`page()` 每次调用 `ranked()`）
- **现象**：`page()` / `rankOf()` / `around()` / `top()` 每次都先全量 ranked（O(n) 分配 n 个对象 + 排序），没有按页切片。
- **后果**：`capacity` 配到 1e7 时，翻一页就要分配 1000 万个对象——配置允许、实现不可用，是一次性卡死级别的陷阱，且不报错（只是越来越慢直到 OOM）。
- **建议**：`capacity` 上界收到 1e5 量级，或给 `ranked()` 加 `[start, end)` 参数让 `page()` 只展开当页。

### P1 · [logger] `log()` 里的 Silent 判断是空 if 块，Silent 下仍在分配对象并写环形缓冲

- **位置**：`logger/Logger.ts:104-106`
  ```ts
  if (this._level === LogLevel.Silent && !this._moduleLevels.has(module)) {
  }
  ```
- **现象**：明显的漏写 `return`。结果是不管级别如何，每次 `log()` 都会构造 `entry` 对象（含 `Date.now()`）并 `_push` 进环形缓冲。
- **证据**：`verify/b2_v3.ts` §8 实测：`level=Silent` 下打 2 条日志 → `buffered = 2`，`export().length = 2`。
- **后果**：把日志级别设为 Silent（上线/压测常见）后，日志的对象分配、时间戳调用、缓冲写入一项都没省；同时环形缓冲被 Silent 期的日志占满，真正崩溃前的关键日志反而被挤出——与本单元"保留崩溃现场"的核心价值直接冲突。
- **建议**：补 `return;`（若希望 Silent 仍保留缓冲，请改写成显式注释 + 配置项，而不是留一个空块）。
- **影响面**：logger 是地基级单元，所有单元的日志开销都受影响。

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

### P1 · [room-graph] `findBestPath` 因超配额截断时返回 `total: NaN`

- **位置**：`room-graph/RoomGraph.ts:756-759`（`return { path: findPath(graph, score), total: NaN, considered, truncated };`）
- **证据**：`verify/b2_v4.ts` §J 实测：`truncated = true  total = NaN`。
- **后果**：调用方拿到 `truncated: true` 的同时拿到 `total: NaN`，若直接把 `total` 用于比较或显示（"最优路线得分"），NaN 会静默传播到路线推荐/难度评估；正确做法要么返回已找到的最优解的分数，要么让 `total` 为 `null` 并在类型上体现。
- **建议**：截断时返回 `bestScore`（哪怕不是全局最优）或把 `total` 类型改为 `number | null`。

### P1 · [runscope] 用原型链上的键访问时 `has()` 返回 true 但 `get/set` 崩溃（已知 easing() 原型污染的新实例）

- **位置**：`runscope/ScopedStore.ts:103`（`return key in this._schema || ...`）、L149（`const def = this._schema[key];`）
- **证据**：`verify/b2_v4.ts` §K 实测：
  ```
  has('toString') = true           （原型链命中，应为 false）
  get('toString') 抛错 = Cannot read properties of undefined (reading 'get')
  set('valueOf', 1) 抛错 = Cannot read properties of undefined (reading 'set')
  ```
  （`def` 取到 `Object.prototype.toString`，`def.scope` 为 `undefined`，`this._data[undefined]` 为 undefined。）
- **后果**：键名来自外部输入（存档字段、配置表键、RPC 字段名）时，`has('toString')` 与 `get('toString')` 行为不一致——先 `has` 再 `get` 的标准写法会崩在 `get` 上，且错误信息 `Cannot read properties of undefined (reading 'get')` 完全指不到根因。
- **建议**：所有 schema 查表改用 `Object.prototype.hasOwnProperty.call(this._schema, key)`（L103、L107、L149、L195），或在构造时把 schema 复制进 `Map`。

### P1 · [runscope] `getOr` 用 try/catch 吞掉了 strict 模式的核心保护

- **位置**：`runscope/ScopedStore.ts:119-126`（`try { ... } catch { return fallback; }`）
- **现象**：strict 模式下"局外读局内数据"会抛错（L170），而 `getOr` 把异常吞掉返回 fallback。
- **后果**：本单元存在的意义就是"让串档 bug 立刻炸出来"，而 `getOr` 是唯一一个静默绕过的入口。调用方图省事全用 `getOr` 时，整个防串档机制失效且无感知。
- **建议**：`getOr` 只吞"键不存在"，把"越界访问"继续抛（或加 `getOr(key, fallback, { swallowCrossScope: false })`）。

### P1 · [scheduler] `maxDeltaTime` 未做数值收口：0 让游戏静止、-1 让时间倒流

- **位置**：`scheduler/Scheduler.ts:51`（`this._maxDt = opts.maxDeltaTime ?? 0.1;`）、L62（`if (dt > this._maxDt) dt = this._maxDt;`）
- **证据**：`verify/b2_v3.ts` §10 实测：
  ```
  maxDeltaTime=0  → 每帧回调次数 = 0  lastRealDt = 0 （游戏静止且不报错）
  maxDeltaTime=-1 → 累计 0.16s 后 delay(1) 到期 = false  lastRealDt = -1（负 dt 让时间倒流）
  ```
- **后果**：配置里写错一个符号（或 JSON 里 `maxDeltaTime: -1`），所有计时任务永远不到期、动画不动，且不报任何错——"定时器不工作"是典型的最难查故障类别。`dt` 被 clamp 成负数后，`task.remaining -= delta` 会把剩余时间越减越多。
- **建议**：`this._maxDt = clampNum(opts.maxDeltaTime, 1e-6, 1e6, 0.1)`。
- **影响面**：Scheduler 是"唯一时间源"，任何依赖它的单元（tween / wave-spawner / scheduling）都会一起停摆。

### P1 · [scheduling] `StepContext.elapsed` 恒为 0，接口承诺的字段从不赋值

- **位置**：`scheduling/FrameScheduler.ts:193-196`（`const ctx: StepContext = { hasTimeLeft: ..., elapsed: 0 };`），接口声明 L23-28
- **证据**：`verify/b2_v3.ts` §7 实测：`StepContext.elapsed 实际值 = 0`（任务执行到一半、跨多帧时仍是 0）。`flush()`（L151）同样写死 `elapsed: 0`。
- **后果**：调用方按接口用 `ctx.elapsed` 做"已耗时"判断或进度条，永远得到 0——静默的错误读数，且类型检查完全看不出来。
- **建议**：改成 `elapsed: this._now() - this._frameStart`（或让 `elapsed` 成为 getter）。

### P1 · [score] 指标被设成 NaN 后总分变 NaN，静默评为最低档

- **位置**：`score/ScoreSystem.ts:124-129`（`set` 无校验）→ L238（`inverseLerp`）→ L242/244（`clamp01(t) * 100`）→ L209-213（`grade()` 的 `s >= g.minScore`）
- **证据**：`verify/b2_v4.ts` §M 实测：`total = NaN  grade = D`（无异常、无警告）。
- **后果**：一次 `add('kills', NaN)`（例如从 UI/网络拿到的未初始化值）之后，玩家结算永远是最低档。因为 `grade()` 的兜底是"返回最后一档"，看起来"评级功能正常"，实际是 NaN 短路。
- **建议**：`set/add` 入口 `if (!Number.isFinite(value)) throw`（或忽略并 warn），并在 `total()` 里对 NaN 做兜底上报。

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

### P1 · [turn] `start(shuffleEqual = true)` 声称打乱同先攻单位，实际完全不打乱

- **位置**：`turn/TurnSystem.ts:205`（`return shuffleEqual ? 0 : a.id.localeCompare(b.id);`）
  `Array.prototype.sort` 的比较函数返回 `0` 时保持原序（ES2019 起稳定排序），所以 `shuffleEqual=true` 的结果是**按添加顺序**。而且整个函数没有注入随机源。
- **证据**：6 个同先攻单位，三种调用全部输出 `u0,u1,u2,u3,u4,u5`。
- **后果**：README（`:72`）写 `start(shuffleEqual?)` 是"开始（排序）"，参数名暗示"打乱同分"。回合制里同先攻单位谁先手通常决定胜负（先手秒杀），配置为 `true` 的游戏实际永远是"先加入的先手"——一个**系统性的先手优势**，玩家会投诉"为什么总是他先打我"。
- **建议**：要么注入 `IRandomSource` 做真随机（与库内 `card`/`gacha` 的口径一致），要么把参数改名为 `stableOrder` 并更正文档。

其他复核：`_advance` 的 `guard`/`maxGuard` 防死循环（`:266-273`）到位；`_doRemove` 的 `if (idx <= this._cursor) this._cursor--`（`:324`）正确维护了游标；`orderPreview` 的取模遍历（`:387-391`）正确；`destroy()`（`:400-407`）清理完整。**P2**：`spendAP(-5)` 会让 AP 增加（实测 3 → 8），`:340` 应改为 `if (!(n > 0) || e.ap < n) return false;`。零依赖，无 rule6 违规。

---

### P1 · [tween] `ease()` 用 Record 查表，原型键被当成缓动函数（已知 easing() 原型污染的新实例）

- **位置**：`tween/Tween.ts:41-45`（`const fn = Easing[name as EasingName]; if (!fn) { ... throw }`）
- **现象**：缓动名来自外部输入（配置表/存档）时，`Easing['toString']` 拿到的是 `Object.prototype.toString`，truthy 通过校验。
- **证据**：`verify/b2_v2.ts` §3 实测：
  ```
  Easing['toString'] = function toString() { [native code] }
  未抛错；onUpdate 收到 = "[object Object]"  类型 = string
  ```
- **后果**：配置里缓动名拼错成 `toString`/`valueOf`/`constructor` 时，动画进度变成字符串而不是数字，`onUpdate` 里做算术立刻得到 NaN——NaN 会一路污染到坐标，表现为"物体瞬间消失/卡死"，且不会有任何报错。
- **建议**：用 `Object.prototype.hasOwnProperty.call(Easing, name)` 或把 `Easing` 换成 `Map`。
- **影响面**：与已审结 `_core` 的 `easing()` 修复同源，属同类写法在本批的唯一新实例（另见 runscope P1-22）。

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

### P2 · [affix] （见正文）

- **A3** 稀有度 `weight` 为 NaN 时不报错（L119 只查 `< 0`），`_pickRarity` 的 `total` 变 NaN → 所有比较失效 → 恒返回最后一个稀有度（静默偏斜）。
- **A4** `rarity.valueScale` 未校验（L306-307）：负数/NaN 会让所有词条值反向或变 NaN。
- **A5** `roll` 的 `usedGroups` 冲突组判定用的是 `_record` 后的累计（L300-303），与 `_pickDef` 的过滤（L278）一致 ✓；但 `_pickDef` 每次调用都全量扫 defs（L274），N 个词条 = O(N·M)。
- **A6** 无 `destroy()`（纯逻辑，N/A）。

---

### P2 · [autoquality] （见正文）

- **AQ4** `_history`（L83-89）只增不减且无容量上限：长时间挂机 + 频繁切换会持续增长（容量类字段未收口）。
- **AQ5** `medianFps`（L218）每次调用都 `[...].sort()`，而 `update()`（L149）与 `state` getter（L288）每帧各调一次 → 每帧 2 次 O(n log n) + 数组分配。
- **AQ6** `AutoQuality.median/average/lowFps1Percent` 与 `FpsMeter.median/average/lowFps1Percent` 是同一份逻辑的两份实现（L216-242 vs L386-411）：应合并（AutoQuality 内部持有 FpsMeter 即可）。
- **AQ7** 无 `destroy()`：`_history` 与 `_samples` 需清理。

---

### P2 · [binary] （见正文）

- **B5** `enum` 越界索引静默回默认（L122 `values[i] ?? def`）：README §7 坑表写的是"返回 undefined…退化为默认值"，实现返回 `def`，说法对不上（`bits = ceil(log2(n))` 天然留出无效索引，属设计意图，仅文档瑕疵）。
- **B6** `SchemaOptions.version`（L183）不进字节流、`decode` 也读不回，但 README §5/§7 要求"读取时判断要不要迁移"——只有 bytes 时做不到。
- **B7** `utf8Decode`（L432）遇到非法字节 `i++; continue;` 静默跳过。
- **B8** `utf8Encode` 对孤立代理项输出 WTF-8 三字节序列（L409）。
- **B9** 无 `destroy()`：本单元为纯函数，N/A。

---

### P2 · [blessing] （见正文）

- **B10** `_validate` 里 `softCap` 无 `falloff` 的分支是**空 if**（L81-84）：意图不明（应警告/抛错/给默认），实际静默走 `falloff ?? 0.5`（L171）。
- **B11** `pick()` 用 `pool.filter((_, i) => i !== idx)`（L266）：每次抽取 O(n) 重建数组，整体 O(n²)。
- **B12** `weight` 为 NaN 时 `total` 为 NaN → 恒取池子最后一个（L255-263，静默偏斜）。
- **B13** 无 `destroy()`（无监听/定时器，N/A）。

---

### P2 · [config] （见正文）

- **C2** `_issues` 只增不减（ConfigLoader L95 + L185）：实测同一张表 `load()` 三次，issues 从 1 累积到 3；只有 `reload()` 会过滤。长期热重载会缓慢增长。
- **C3** `count()` 对未加载表返回 0（L158-161），而 `all()/get()` 抛"未加载"——同为查询接口，一个静默 0、一个抛错，语义不一致。
- **C4** `throwOnError: false` 且数据源返回非数组对象时，L103 的 `for (const row of rows)` 会抛 TypeError（未在 try 内），错误信息与"配置校验"无关。
- **C5** `onReload` 取消函数用 `indexOf(fn)`（L193-199）：与已修的"EventBus 旧取消函数误删同名新监听器"同型——取消后重新注册同一 fn，再调用旧取消函数会删掉新注册。
- **C6** `_checkReferences` 对未加载表报"引用了不存在的表"（L239-247），级联误报（表 A 加载失败→引用 A 的表全报错）。
- **C7** 数组 `item` 校验遇到第一个错误就 `return`（Validator L165），一次只报一个元素。

---

### P2 · [curse] （见正文）

- **Cu3** `add(id, now = Date.now())`（L134）：时间源未注入（rule2），与 scheduler P2-S2 同型。
- **Cu4** `pick()`（L295-317）与 `blessing.pick()`（L243-269）逐行同构：应抽到公共实现或明确"两份是刻意独立"。
- **Cu5** `_fire` 的 `_costCount` 只在 `remove/clear` 时清（L170、L187），`importState` 不清（L328）→ 导入后代价计数归零但历史计数残留语义不清。
- **Cu6** 无 `destroy()`。

---

### P2 · [daily] （见正文）

- **D3** `submit` 的 `score` 为 NaN 时静默不写记录（L182 `score > prev.score`）：成绩丢失无提示。
- **D4** `importState`（L229-237）不校验 `date`/`score`/`attempts`：损坏存档直接进入，`attempts` 负数会让"今日次数"变负。
- **D5** `_pickModifiers` 的 xorshift（L126、136-138）以 seed 为状态，seed 恰为 0 时是不动点 → 永远取池子前 N 个（概率 1/2³²，极低）。
- **D6** `hasPlayedToday(now = Date.now())`（L168）时间源未注入。
- **D7** `_attempts` 只增不减（只能靠 `prune` 手动清理）。

---

### P2 · [diagpack] （见正文）

- **Di3** `safeStringify` 的 `replacer`（L84-86）是恒等函数 `(_key, v) => v`，没有任何作用（疑似占位未实现）。
- **Di4** `maxSectionChars` / `maxTotalChars` 未收口（L191-192）：传 0 会让每个分区被截成 0 字符，传负数会让所有分区被丢弃，都不报错。
- **Di5** `collectEnvironment`（L337-357）内部 `new Date()` 与 `Intl` 直连：可接受（环境采集），但与"可注入"原则不一致。
- **Di6** 无 `destroy()`：`_providers` 持有外部闭包（通常捕获组件/场景对象），卸载时不清会阻止 GC。

---

### P2 · [interact] （见正文）

- **I2** `clear()`（L116-120）与 `resetAll()`（L234-240）清空焦点但不触发 `onFocusChange`：UI 上的交互提示不会消失。
- **I3** `candidates()` 排序比较函数在"相等"时返回 1 而非 0（L196）：排序不稳定，同距离物体的顺序不确定。
- **I4** `setDisabled` 用 `(it as { disabled?: boolean }).disabled = disabled`（L109）写入 readonly 字段：对 `Object.freeze` 的对象在严格模式下会抛 TypeError。
- **I5** 本地 `clamp`（L294-296）与 `_core.clamp` 重复实现（本单元为零依赖，可接受，建议注明）。
- **I6** 无 `destroy()`（`clear()` 不够，需清 `_items` 持有的外部对象）。

---

### P2 · [leaderboard] （见正文）

- **Lb3** `pageSize` 未收口（L233）：0 → `pageCount = Infinity`、返回空页但 `hasNext = true`；负数 → 空页。
- **Lb4** `mergeLeaderboards`（L335-338）固定用 `e.at < prev.at` 做 tie-break，忽略 `opts.tieBreak`：与本类的 `tieBreak` 配置不一致。
- **Lb5** `submit` 用 `_entries[this._entries.length - 1]`（L114）与最后一名比较后再排序：语义正确但多一次全量 `sort`（L119），可用二分插入。
- **Lb6** 无 `destroy()`（`clear()` 存在）。

---

### P2 · [logger] （见正文）

- **L2** `addSink` 取消函数同样用 `indexOf`（L91-97），与已知"旧取消函数误删新监听器"同型，且 `destroy()` 未清 `_moduleLevels`（L226-229）。
- **L3** 环形缓冲持有 `data` 引用（L108-114）：若 `data` 是 Cocos 节点/大对象，缓冲里的 200 条会让它们在销毁后仍无法释放。
- **L4** `Assert.soft()` 直接 `console.warn`（Assert.ts L75），未接入 Logger 的 sink 体系，无法重定向到上报通道（与 README §sink 机制的承诺不一致）。

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

### P2 · [room-graph] （见正文）

- **R2** `diagnose` 里又一处**空 if**（L584-586）：`if (emptyType > 0 && emptyType < nodes.length) { }` —— 明显漏写 `issues.push(...)`；结果是"部分节点没有类型"这一重要问题**永远不会被报出来**。
- **R3** `assignTypes`（L405、L423）每个节点都复制一次 weights 与 ctx（`{...spec.weights}`、`{...ctx, node: probe}`），且 `rule.allow` 对每个候选类型都构造一次 probe（L430-436）：O(节点 × 类型 × 规则)。
- **R4** `ensureRestBeforeBoss`（L477-488）会覆盖 `spec.fixed` 指定的类型：fixed 的语义应优先。
- **R5** `diagnose` 的 crossings 检测是 O(E²) 双重循环（L571-578）。
- **R6** `generateRoomGraph` 在 `diagnose` 不 ok 时整体抛错（L233-236）：生成器没有"重试"或"降级"路径，一旦某次随机结果有交叉就直接失败（与 wave-spawner 的兜底哲学相反）。

---

### P2 · [runscope] （见正文）

- **Ru3** `importSave`（L194-211）不校验存档值（与 meta.restore 的严谨形成对比）：`src[k]` 可以是任意类型/NaN。
- **Ru4** `add(key, delta)`（L135-145）不校验 delta：NaN 直接污染。
- **Ru5** `StoreSchema = Record<string, KeyDef<any>>`（L18）含 `any`。
- **Ru6** 无 `destroy()`（有 `reset()`）。

---

### P2 · [scheduler] （见正文）

- **S2** 时间源未注入（rule2）：L66 `this.timeScale.update(Date.now())`、`TimeScale.add` 默认参数 `now = Date.now()`（TimeScale.ts L32）。模块内部主动去"找"墙钟时间，导致回放/确定性测试无法控制时间推进。
- **S3** `TimeScale.add` 不校验 `durationSeconds`（L39）：`hitStop(-1)` / `slowMotion(0.5, -5)` 实测后 `layerCount = 0`，顿帧/慢动作静默丢失（`expiresAt = now - 1000` 立即过期）。
- **S4** 每帧 `Array.from(this._tasks.values())`（L82）：热路径分配，可用"迭代时快照只在有增删时才重建"规避。
- **S5** `delta === 0` 的浮点相等判断（L90）：极小非零 dt 仍会触发回调。
- **S6** `hitStop(0.08, 0.05)` 默认参数是魔法数字（L201），未进配置对象。

---

### P2 · [scheduling] （见正文）

- **Sch2** `hardLimitMs` 未收口（L54）：传 0 时每帧只执行 1 个任务（L216 的 break 在任务执行之后），退化为"每帧一个"但不报错；传 NaN 时硬限制完全失效（比较恒 false），两个方向都静默。
- **Sch3** 任务抛异常被当成完成并触发 `onDone`（L199-207）：README §7 第 63 行写明"已处理：出错即完成，不重试"，与文档一致；但只有 `onDone` 没有 `onError`，调用方无法区分"做完了"和"做炸了"。建议补 `onError`（或 `onDone(ok)`）。
- **Sch4** 每个任务每帧新建 `ctx` 对象与 `hasTimeLeft` 闭包（L193-196）：热路径分配。
- **Sch5** 每次 `schedule()` 都全量排序（L84）：循环注册 N 个任务是 O(N² log N)。
- **Sch6** `flush()` 用 `this._tasks.shift()`（L171）：O(n²)。
- **Sch7** `scheduleBatch` 空数组时返回 id `0`（L97），与"有效 id 从 1 开始"冲突。

---

### P2 · [score] （见正文）

- **Sc2** `_scoreOne`（L241-245）的 `higher-better` 与 `lower-better` 两个分支代码完全相同（`clamp01(t) * 100`）：因为方向已由 `zero/par` 的大小关系决定（构造时 L91-100 有校验），分支是冗余的，建议合并并加注释说明"方向隐含在 zero/par 中"。
- **Sc3** `StarRating(stars)`（L301）用 `Math.max(1, stars)`：`stars` 为 NaN 时 → NaN → `addCondition` 的 `length >= NaN` 恒 false → 可无限加条件 → 星级可以超过 max。
- **Sc4** `weighted-with-floor` 模式（L196-203）在有指标低于 floor 时直接返回 `Math.min(avg, 最后一档 minScore)`（通常是 0）：一票否决很严厉，README 需写明。
- **Sc5** 无 `destroy()`（有 `reset()`）。

---

### P2 · [snapshot] （见正文）

- **Sn3** `depthOf`（L173-175）用 `[.[\]]` 计数：数组路径 `a[0]` 记 2、对象路径 `a.b` 记 1，深度排序因此不准（P0-2 的根因之一）。
- **Sn4** `deepClone` 递归无深度上限（L9）：深层链表结构会 RangeError。
- **Sn5** `diffSnapshots` 的 `maxDepth`（L67）未收口：0 或负数会让整个对象退化成引用比较。
- **Sn6** 达到 `maxDepth` 时把原始对象引用存进 `from/to`（L103-105）：调用方缓存 diff 结果会持有旧对象，阻碍 GC。
- **Sn7** 数组 diff 按下标比较：中间插入一个元素会让后面全部报 changed（语义正确但噪声大）。

---

### P2 · [tween] （见正文）

- **T2** `TweenRunner.completeAll()`（L224-228）只 complete `_tweens`，`_pending` 里的被直接丢弃：实测刚 `add` 的 tween 的 `onComplete` **不会**被调用（"completeAll"名不副实）。
- **T3** `TweenRunner.update` 每帧 `slice()`（L200）：热路径分配。
- **T4** `TweenRunner.delay()` 用 `new Tween(0.0001)`（L189）：魔法数字，建议走可配置的最小步长。

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

## 4. 贯穿本批的六个共享模式

这些模式在多个单元里重复出现。**按模式统一修法，不要每个单元各写一套。**

### 模式 A · 否定式条件拦不住 NaN（最高频）

```ts
// ✗ 错：NaN 参与 <= 比较恒为 false，直接穿透
if (x <= 0) return;
if (amount >= s.count) return -1;

// ✓ 对：肯定式，NaN 时条件成立 → 正确拒绝
if (!(x > 0)) return;
if (!(amount < s.count)) return -1;
```

**这一条是本批最高频的错误形态。** 涉及 `inventory` / `anticheat` / `bullet-pattern` / `dungeon` / `timeutil` 等多个单元。
原因是 JS 里 NaN 与任何值比较都为 false，否定式判断天然漏掉它。

### 模式 B · `??` 和 `Math.max` 都挡不住 NaN

```ts
// ✗ 错：?? 只挡 null/undefined
this._maxRetries = opts.maxRetries ?? 3;      // NaN 直接存进去
Math.max(0, v)                                 // Math.max(0, NaN) === NaN

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

`blessing` / `curse` / `meta` 三个单元都有这个问题：
`set`（覆盖）语义的效果被乘上了层数/等级，与 `add`/`mul` 混为一谈。

### 模式 E · 遍历中修改集合

```ts
// ✗ 错：回调里注销自己会 splice 数组，下一个回调被跳过
for (const fn of this._onSpawn) fn();

// ✓ 对：遍历副本
for (const fn of [...this._onSpawn]) fn();
```

### 模式 F · 缺省配置与 JSDoc 承诺相反

`mover` 的 `maxExternal = Infinity`、`replay` 的 `seed = 0`、
`telemetry` 的 `maxRetries` 等——**默认值恰好让文档承诺的功能失效**。
改法要二选一：要么改默认值，要么改文档说清真实语义。
**不要只改其中一个又不动另一个。**

---

## 5. 交付要求

### 5.1 每条修复的产出

1. **源码改动**：只改必要的那几行，附"为什么"注释
2. **回归测试**：一条在修复前**确实会失败**的用例
3. **对照用例**：一条验证"正常输入不受影响"的用例（防止矫枉过正）

### 5.2 测试放哪

新建 `tests/run_phase10_b.ts`，并在 `tests/run.ts` 里注册：

```ts
setSuite('精审返工 · 窗口B');
runPhase10BTests();
```

⚠️ 注册后务必跑一次全量，确认 `run.ts` 能被构建到（沙盒曾出现过文件被写入重复 import 行的事故）。

### 5.3 报告

完成后产出 `audit/handoff_B_result.md`，每条一行：

```
| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
```

状态用：`已修` / `已修（附说明）` / `不成立（附证据）` / `需总审裁决`。

**"不成立"要有真凭实据**——贴出你的复现脚本和输出，说明为什么报告描述的现象不存在。
不要因为"看代码觉得没问题"就判不成立。

### 5.4 提交前自检

```bash
bash build.sh
node .build/tests/run.js                    # 必须全绿，且条数只增不减
node scripts/check-deps.js                  # 全部通过（记得删 verify/）
node scripts/check-links.js
python3 scripts/scan-dt-guard.py
python3 scripts/scan-num-guard.py
python3 scripts/check-random-source.py
python3 scripts/check-dup-exports.py
```

---

## 6. 并行纪律（三个窗口同时开工）

| 事项 | 约定 |
|---|---|
| **单元边界** | 三个窗口的单元**零重叠**，但 `_core/` 谁都不要碰 |
| **`tests/run.ts`** | 三个窗口都要改它 → **最后合并时由总审统一处理**，你只管写自己的 `run_phase10_b.ts` |
| **`README.md`** | 测试总数在变，**不要改**，由总审统一更新 |
| **临时脚本** | 放 `/tmp` 或 `verify/`（用完删） |
| **`build.sh`** | 会整体替换 `.build/`，**不要在别的窗口构建时跑**；失败就重跑一次 |

---

## 7. 需要总审裁决的先记下来

遇到以下情况**不要自己拍板**，在报告里标"需总审裁决"并说明两种选择的利弊：

1. 修复会改变**对外 API 行为**（可能 breaking）
2. 报告建议的改法与单元 README 的**明确声明冲突**
3. 两处代码"看起来不一致但可能都是故意的"
   （例如相切语义：空间索引要求"不含相切"，通用 AABB 要求"含相切"，**两者都对**）
4. 你判断某条"不成立"

---

## 8. 最后一句

这个库现在 **3695 项测试全绿**，是你开工前的基线。
你交付时这个数字只能涨、不能跌——如果跌了，说明你的修复伤到了既有行为，
回去看第 1.1 节的第 1 条。
