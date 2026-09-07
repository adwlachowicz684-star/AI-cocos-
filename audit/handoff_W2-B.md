# 精审返工任务书 · 窗口 W2-B（第 B 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W2-B 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **19**（P1 11 / P2 8） |
| 单元 | **9** 个 |
| 来源批次 | batch2、batch4 |
| 所属组 | **第 B 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W2-A**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_B.md` 验收 **W2-A**。

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
config  curse  hitbox  leaderboard  minimap  save  scheduler  subtitle  telegraph
```

---


## 【P1】先做这批

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

### P1 · [hitbox] 外部直接改 `box.x/y` 后 `remove()` 留下僵尸条目（格子里的 id 永不清除）

- **位置**：`hitbox/Hitbox.ts:435-447`（`remove` 按**当前**坐标算 `_cellsFor` 去删格子；若调用方绕过 `update` 直接改坐标，删的是新位置的格，旧位置的格里的 id 留着）
- **证据**：实测（`b4_v2.ts`）：`add` 一个 box 后直接改 `b.x=100; b.y=100`（绕过 `update`）→ `remove('z')` → 遍历 `_cells`，仍有 **4 个格子**持有 id `'z'`，而 `_boxes` 里已经没有它。
- **后果**：`query` 遍历到这些格子时 `this._boxes.get(id)` 返回 `undefined`，被 `if (!b || ...) continue` 挡住，**不会崩但持续浪费遍历**；更糟的是这些 Set 不会被 `set.size === 0` 回收，形成**与第 2 节「SpatialHash 空桶不回收」同构的泄漏**。因为 `Hitbox` 是可变对象（`x`/`y`/`rotation` 都是可写字段），调用方直接改坐标是**被 API 允许**的写法。
- **建议**：额外维护 `Map<id, number[]>` 记录每个 id 当前占用的格子，`remove` 时按记录清理。

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

### P1 · [minimap] `FogMap.reveal(world, radius)` 用 **X 轴**尺寸去换算 **Y 轴**的格子跨度，非正方形世界迷雾形状错误

- **位置**：`minimap/Minimap.ts:328`（`const step = (radius / this._worldSize.x) * this._res;` —— 只用了 `worldSize.x`）+ `332-338`（`dy` 与 `dx` 用同一个 `cells` 跨度）
- **现象**：格子在 X/Y 两个方向的"世界单位/格"不同（非正方形世界），但代码统一按 X 方向的密度算 Y 方向该扩多少格。
- **证据**：实测（`b4_v2.ts`）：
  - 世界 `1000 × 100`、分辨率 100：每格 = 世界 `10 × 1`。`reveal({x:500,y:50}, 100)` 半径 100 世界单位 → Y 方向本应覆盖全部 100 格（半径 100 ≥ 世界高度 100），实测只揭开 **21 格**（`step = 100/1000*100 = 10` 格）。
  - 对照组：世界 `100 × 100`、`reveal({x:50,y:50}, 10)` → 揭开 **21 格**（= 2×10+1，正确）。
- **后果**：**窄长地图（绝大多数横版/长条关卡）的迷雾严重揭不全**：玩家走过的地方在小地图上仍是黑的，`coverage` 统计也偏小，进而影响"探索度 X%"这类进度显示。全程静默，且用正方形地图自测时完全测不出来（对照组成立只是巧合）。
- **建议**：分别计算 `cellsX = Math.ceil((radius / worldSize.x) * res)`、`cellsY = Math.ceil((radius / worldSize.y) * res)` 再双重循环；更严谨的做法是按真实圆形判定 `((dx*cellW)² + (dy*cellH)² <= r²)`。

### P1 · [minimap] `scale` 为 0 时 `minimapToWorld` 除零，返回 NaN 坐标

- **位置**：`minimap/Minimap.ts:160-161, 168`（`(m.x - viewSize.x/2) / this._scale`）
- **现象**：`scale: 0` 是合法配置输入（"不缩放"），但构造期无校验；`_autoScale` 在 `mode==='follow'` 时返回硬编码 1，只有显式传 0 才触发除零。
- **证据**：实测：`new Minimap({..., mode:'follow', scale: 0}).minimapToWorld({x:10,y:10}, {x:0,y:0})` → `{x: NaN, y: NaN}`。
- **后果**：小地图点击定位（点哪走哪）返回 NaN 坐标，角色瞬移到 NaN 或不动，且不报错。
- **建议**：构造期加下界 `Math.max(1e-6, ...)`，或显式拒绝 `scale <= 0`。

### P1 · [save] `clearAll()` 不清理 `__tmp` 备份键，存储里永久残留垃圾

- **位置**：`save/SaveManager.ts:245-251`（`listSlots()` 显式 `!k.endsWith('__tmp')` 过滤掉临时键）+ `265-267`（`clearAll` 基于 `listSlots`）
- **证据**：实测（`b4_v5.ts`）：`write('slot1')` → 手动写入 `save_slot1__tmp`（模拟写入中断留下的备份）→ `clearAll()` → `storage.keys()` 仍为 **`save_slot1__tmp`**。
- **后果**：**与第 2 节「SpatialHash 空桶不回收」同构的清理不彻底**。每次写入中断（崩溃、kill 进程）都会留一个 `__tmp`，`clearAll()` 清不掉，`listSlots()` 又看不见，于是存储占用只增不减，而开发者用 `listSlots()` 自查时看不到任何异常。在 localStorage 配额紧张的环境里，这直接导致"存不进去"的诡异失败。
- **建议**：`clearAll()` 遍历 `keys()` 时把前缀匹配且 `endsWith('__tmp')` 的也一并 remove；或提供 `purgeTempKeys()`。

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

### P1 · [telegraph] `clear()` 不触发 `onComplete`，与 `cancelAll()` 行为不一致

- **位置**：`telegraph/Telegraph.ts:204-206`（`clear()` 直接 `this._list.length = 0`，无回调）对比 `190-202`（`cancelAll()` 逐个调 `onComplete(t, true)`）
- **证据**：实测（`b4_v2.ts`）：spawn 一个带 `onComplete` 的 telegraph → `clear()` → 回调次数 **0**。
- **后果**：外部状态机（例如"预警期间锁住 AI""显示地面圈"）依赖 `onComplete` 做清理。场景切换调用 `clear()` 时收不到回调，预警圈残留、AI 锁死。而 `cancelAll()` 路径是好的，于是 bug 只在"切场景/重置"时出现。
- **建议**：`clear()` 内部复用 `cancelAll()` 的逻辑（两个 API 名字相近，强烈建议统一而非仅文档化）。


## 【P2】P1 完成后再做

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

### P2 · [hitbox] `sector`/`capsule` 组合走采样近似，精度依赖硬编码采样数

- **位置**：`hitbox/Hitbox.ts:157-183`（sector 用 `N = 8`，capsule 用 `N = 6`）
- **证据**：代码直读。
- **后果**：细长 capsule 与窄 sector 的相交可能漏检（采样点落在缝隙里）。属于 rule4 违反 + 精度隐患。
- **建议**：采样数提为配置，或对 capsule/capsule 这类有闭式解的组合补解析解。

### P2 · [leaderboard] （见正文）

- **Lb3** `pageSize` 未收口（L233）：0 → `pageCount = Infinity`、返回空页但 `hasNext = true`；负数 → 空页。
- **Lb4** `mergeLeaderboards`（L335-338）固定用 `e.at < prev.at` 做 tie-break，忽略 `opts.tieBreak`：与本类的 `tieBreak` 配置不一致。
- **Lb5** `submit` 用 `_entries[this._entries.length - 1]`（L114）与最后一名比较后再排序：语义正确但多一次全量 `sort`（L119），可用二分插入。
- **Lb6** 无 `destroy()`（`clear()` 存在）。

---

### P2 · [save] `write()` 失败时只 `console.error` 并返回 false，调用方极易忽略返回值

- **位置**：`save/SaveManager.ts:131-164`（4 处 `console.error`）
- **证据**：代码直读（扫描命中 console 输出 ×4）。
- **后果**：存档失败时游戏继续跑，玩家以为存上了。库内 `console.error` 还会污染宿主日志。
- **建议**：把错误收集到 `lastError` 字段或 `onError` 回调里，README 强调必须检查返回值。

### P2 · [scheduler] （见正文）

- **S2** 时间源未注入（rule2）：L66 `this.timeScale.update(Date.now())`、`TimeScale.add` 默认参数 `now = Date.now()`（TimeScale.ts L32）。模块内部主动去"找"墙钟时间，导致回放/确定性测试无法控制时间推进。
- **S3** `TimeScale.add` 不校验 `durationSeconds`（L39）：`hitStop(-1)` / `slowMotion(0.5, -5)` 实测后 `layerCount = 0`，顿帧/慢动作静默丢失（`expiresAt = now - 1000` 立即过期）。
- **S4** 每帧 `Array.from(this._tasks.values())`（L82）：热路径分配，可用"迭代时快照只在有增删时才重建"规避。
- **S5** `delta === 0` 的浮点相等判断（L90）：极小非零 dt 仍会触发回调。
- **S6** `hitStop(0.08, 0.05)` 默认参数是魔法数字（L201），未进配置对象。

---

### P2 · [subtitle] rule7 不满足：本单元**缺示例**

- **位置**：`subtitle/` 目录下无示例（任务书第 21 号单元详情明确标注「示例：**无**」）
- **证据**：任务书清单 + 仓库文件树（`examples/` 下 17 个 batch 示例文件，无 subtitle 引用）。
- **后果**：违反 rule7「每个插件自带 README + 测试 + 示例」，也是本批 25 个单元里**唯一**不满足的。
- **建议**：补一个示例片段，或在 README 里加完整可运行示例。

### P2 · [subtitle] `at()` 是 O(n) 全数组扫描

- **位置**：`subtitle/Subtitle.ts:74-93`（每个 `at()` 从头遍历直到 `l.start > time`）
- **证据**：代码推导：复杂度 O(n)，未做"上次位置"缓存或二分。
- **后果**：电影级长字幕（3000+ 行）× 60fps 查询 = 每秒 18 万次遍历，虽不致命但可优化。
- **建议**：已排序数组上做二分查找起点，或从上次索引继续扫描。

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

新建 `tests/run_phase10_w2b.ts`，并**在文件内导出** `runPhase10W2BTests()`：

```ts
export function runPhase10W2BTests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W2-B.md`，每条一行：

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
| **文件命名** | `run_phase10_w2b.ts` / `result_W2-B.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 B 组**。修完之后，按 `audit/review_B.md` 验收 **W2-A**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W2-B.md`，
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
