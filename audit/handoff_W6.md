# 精审返工任务书 · 窗口 W6

> 本文件是**第二次精审 273 条**中分配给窗口 W6 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **29**（P1 18 / P2 11） |
| 单元 | **11** 个 |
| 来源批次 | batch2 |
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

### 3.1 你的单元（11 个，与其它窗口零重叠）

```
affix  binary  blessing  config  curse  daily  leaderboard  room-graph  scheduler  snapshot  wave-spawner
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

### P1 · [room-graph] `findBestPath` 因超配额截断时返回 `total: NaN`

- **位置**：`room-graph/RoomGraph.ts:756-759`（`return { path: findPath(graph, score), total: NaN, considered, truncated };`）
- **证据**：`verify/b2_v4.ts` §J 实测：`truncated = true  total = NaN`。
- **后果**：调用方拿到 `truncated: true` 的同时拿到 `total: NaN`，若直接把 `total` 用于比较或显示（"最优路线得分"），NaN 会静默传播到路线推荐/难度评估；正确做法要么返回已找到的最优解的分数，要么让 `total` 为 `null` 并在类型上体现。
- **建议**：截断时返回 `bestScore`（哪怕不是全局最优）或把 `total` 类型改为 `number | null`。

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

### P1 · [snapshot] deepClone 把 TypedArray 和类实例退化成普通对象

- **位置**：`snapshot/Snapshot.ts:38-43`（`const out: Record<string, unknown> = {};` 兜底分支）
- **证据**：`verify/b2_v2.ts` §2 实测：
  ```
  Uint8Array 克隆后是否还是 Uint8Array = false  实际 = {"0":1,"1":2,"3":3}  constructor = Object
  类实例克隆后 constructor = Object  有 double 方法 = undefined
  ```
- **后果**：`UndoStack.push()`（L251）对任何含 `Uint8Array`（binary 序列化结果、存档字节）、`Vec3`、自定义类的状态做深拷贝后，撤销回来的是"长得像但方法没了"的普通对象。崩溃点在很远的调用处（`x.double is not a function`），没人会想到是撤销栈干的。
- **建议**：在 `deepClone` 里按 `ArrayBuffer.isView` / `Object.getPrototypeOf` 分支处理，或明确文档声明"仅支持纯数据 + Date/Map/Set"。

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

### P2 · [leaderboard] （见正文）

- **Lb3** `pageSize` 未收口（L233）：0 → `pageCount = Infinity`、返回空页但 `hasNext = true`；负数 → 空页。
- **Lb4** `mergeLeaderboards`（L335-338）固定用 `e.at < prev.at` 做 tie-break，忽略 `opts.tieBreak`：与本类的 `tieBreak` 配置不一致。
- **Lb5** `submit` 用 `_entries[this._entries.length - 1]`（L114）与最后一名比较后再排序：语义正确但多一次全量 `sort`（L119），可用二分插入。
- **Lb6** 无 `destroy()`（`clear()` 存在）。

---

### P2 · [room-graph] （见正文）

- **R2** `diagnose` 里又一处**空 if**（L584-586）：`if (emptyType > 0 && emptyType < nodes.length) { }` —— 明显漏写 `issues.push(...)`；结果是"部分节点没有类型"这一重要问题**永远不会被报出来**。
- **R3** `assignTypes`（L405、L423）每个节点都复制一次 weights 与 ctx（`{...spec.weights}`、`{...ctx, node: probe}`），且 `rule.allow` 对每个候选类型都构造一次 probe（L430-436）：O(节点 × 类型 × 规则)。
- **R4** `ensureRestBeforeBoss`（L477-488）会覆盖 `spec.fixed` 指定的类型：fixed 的语义应优先。
- **R5** `diagnose` 的 crossings 检测是 O(E²) 双重循环（L571-578）。
- **R6** `generateRoomGraph` 在 `diagnose` 不 ok 时整体抛错（L233-236）：生成器没有"重试"或"降级"路径，一旦某次随机结果有交叉就直接失败（与 wave-spawner 的兜底哲学相反）。

---

### P2 · [scheduler] （见正文）

- **S2** 时间源未注入（rule2）：L66 `this.timeScale.update(Date.now())`、`TimeScale.add` 默认参数 `now = Date.now()`（TimeScale.ts L32）。模块内部主动去"找"墙钟时间，导致回放/确定性测试无法控制时间推进。
- **S3** `TimeScale.add` 不校验 `durationSeconds`（L39）：`hitStop(-1)` / `slowMotion(0.5, -5)` 实测后 `layerCount = 0`，顿帧/慢动作静默丢失（`expiresAt = now - 1000` 立即过期）。
- **S4** 每帧 `Array.from(this._tasks.values())`（L82）：热路径分配，可用"迭代时快照只在有增删时才重建"规避。
- **S5** `delta === 0` 的浮点相等判断（L90）：极小非零 dt 仍会触发回调。
- **S6** `hitStop(0.08, 0.05)` 默认参数是魔法数字（L201），未进配置对象。

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

新建 `tests/run_phase10_w6.ts`，并**在文件内导出** `runPhase10W6Tests()`：

```ts
export function runPhase10W6Tests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（8 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W6.md`，每条一行：

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
| **文件命名** | `run_phase10_w6.ts` / `result_W6.md`，带你的窗口号，避免撞名 |

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
