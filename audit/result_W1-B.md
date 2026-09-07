# 交付报告 · 窗口 W1-B（第 B 组）

> 单元（7 个）：`anticheat` `audio` `buff` `collision` `condition` `skill-player` `spatial`
> 条目 20（P1 13 / P2 7），来源批次 batch3、batch4
> 测试：`tests/run_phase10_w1b.ts`，导出 `runPhase10W1BTests()`（**53 项，未并入 `tests/run.ts`，由总审合并**）
> 基线：构建通过、**3695 项测试全绿**、6 项校验脚本全过（未改动 `run.ts`、未碰 `_core/`）

## 结论

| 状态 | 条数 |
|---|---|
| 已修 | 10 |
| 已修（附说明） | 8 |
| 不成立（附证据） | 1 |
| 需总审裁决 | 1 |

**新增测试 53 项，全部在修复前确实失败**——验证方式见下方"如何验证'修复前会失败'"。
全量回归仍是 **3695 项全绿**（我自己的 53 项尚未注册，注册后应为 3748）。

---

## 如何验证"修复前会失败"

我没有采用"改回旧代码再跑"的方式（任务书第 2 节明确禁止，会损坏 `.build/`）。
做法是：

1. 从 `repo.tgz`（本次拉取的原始 main 快照）解出**未修改**的 7 个单元源码，
   覆盖进工作区 → `tsc` 编译 → 跑同一份 `run_phase10_w1b.ts`；
2. 结果：**通过 33 项，失败 20 项**（20 条失败精确对应下表中 19 条"已修"条目 + 1 条 P2）；
3. 还原修复后的源码 → 重新编译 → **53 项全绿**。

失败清单（修复前真实输出）摘录：

```
✗ NaN 坐标不得清零 _strikes …… 期望 2，实际 0
✗ 非法样本不得顶掉基线 …… NaN 之后的合法样本必须仍然参与判定
✗ destroy() 可用 …… c.destroy is not a function
✗ masterVolume 为 NaN …… 音量必须是有限数（实际 NaN）
✗ 读档后继续叠加 …… 期望 4，实际 1
✗ stacks 不得超过 maxStacks …… 期望 3，实际 999
✗ remain <= 0 的坏数据不得入库 …… 期望 false，实际 true
✗ 第二个 onChange 不得顶掉第一个 …… 第一个监听器不应失联
✗ clear() 必须逐个发 remove …… 期望 2，实际 0
✗ 起点在盒内应返回穿出点 …… 起点在盒内，射线必然穿过边界（实际 hit:false）
✗ 修改返回值不会污染后续调用 …… 共享常量必须冻结
✗ addStat 传入 NaN …… 期望抛出异常，但没有
✗ c.value 为 NaN …… 进度必须是有限数（实际 NaN）
✗ 第二个 onComplete 不得顶掉第一个 …… 期望 1，实际 0
✗ 循环时每轮都要触发 t=0 事件 …… 期望 3，实际 1
✗ 旧句柄 cancel 不得停掉新轨道 …… 期望 "playing"，实际 "idle"
```

---

## 逐条交付

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| P1-1 | anticheat | P1 | **已修（附说明）** | 注入 `{x: NaN}` → `strikes` 由 **2 → 0**；交替上报"合法包/NaN包" → 之后的合法样本**全部被跳过**（`push` 返回 `null`） | 见下方说明① | `run_phase10_w1b.ts` › anticheat · P1 |
| P1-2 | audio | P1 | 已修 | `new AudioManager({masterVolume: NaN})` → `effectiveVolume(1) === NaN` | `clampNum(cfg.masterVolume, 0, 1, 1)` → 返回 `1`；`0.5` 仍 `0.5`；`0`（静音）仍 `0` | audio · P1 masterVolume |
| P1-3 | audio | P1 | **已修（附说明）** | `maxVoices=4` + 4 个 `loop:true` → `play('normal')` 返回 **null**，`stats.rejected === 1` | 不改代码（会 breaking），README 写明契约并补测试锁住 | audio · P1 loop 通道 |
| P1-4 | audio | P1 | **已修（附说明）** | 见说明② | 代码已是 `hasOwn`，补 3 条测试锁住 | audio · P1 BgmStack |
| P1-5 | buff | P1 | 已修 | 读档后再叠 1 层 → 层数被覆盖成 **1**（期望 4） | `import()` 对 `independent` 重建 `_independent` 数组 | buff · P1 import `_independent` |
| P1-6 | buff | P1 | 已修 | `import([{stacks:999, remain:NaN}])` → `stacks=999`、`remain=NaN`，推进 100 秒后**仍生效** | `stacks` 夹到 `maxStacks`（→3）；`remain` 回落 `duration`（→5）；`remain<=0` 跳过；推进 100 秒后 `has === false` | buff · P1 import 校验 |
| P1-7 | collision | P1 | 已修 | `raycastAabb` 起点在盒内 → `{"hit":false}`；`raycastCircle` 同样情形 → `{"hit":true,"t":15}` | 两者一致：`hit:true, t:15, nx:1`；外部起点仍 `t=45, nx=-1`；错开仍 miss | collision · P1 raycastAabb |
| P1-8 | condition | P1 | 已修 | `addStat('x', NaN)` → `getStat('x') === NaN`，不抛错（`setStat` 同输入正常抛错） | 抽 `_assertFinite`，两个 setter 共用；`NaN`/`Infinity` 均抛错；正常累加 `2→4→6` 不变 | condition · P1 addStat |
| P1-9 | condition | P1 | 已修 | `{op:'>=', value:NaN}, x=5` → `progress === NaN`（`completed` 为 false） | `progress === 0`；`value:undefined` 同样收敛；`value=10, x=5` 仍 `0.5` | condition · P1 evaluate |
| P1-10 | skill-player | P1 | 已修 | `duration:1, loop:true`，事件 `[{t:0}]` → 跑 130 帧累计 **1** 次（期望 3） | 回卷后补发 `_fireRange(0, _time, true)` → 累计 **3**；非循环仍 **1**；`t=0.5` 中段事件仍 **2** 次不多不少 | skill-player · P1 循环 t=0 |
| P1-11 | skill-player | P1 | 已修 | `h1 = play(A)` → `play(B)` → `h1.cancel()` → `state === 'idle'`（B 被误停） | 加 `currentHandle` 归属校验 → `state === 'playing'`，`h1.cancelled === true`；当前句柄 cancel 仍生效 | skill-player · P1 过期 cancel |
| P1-12 | spatial | P1 | **已修（附说明）** | 见说明③ | `_findEntry` 已不存在（无需改动），补测试锁住 + 断言不得再出现该入口 | spatial · P1 queryNearest |
| P1-13 | spatial | P1 | **需总审裁决** | `capacity:2` 时插入 10 个 → `itemCount === 10`（配置从未生效） | 只做文档化（接口 JSDoc + README），未改代码。理由见"需总审裁决" | spatial · P1/P2 capacity |
| P2-1 | anticheat | P2 | **已修（附说明）** | `SpeedChecker.destroy` 不存在（无外部资源） | 补 `destroy()`（等价 `reset()`，只为统一收尾入口）；`_window.shift()` 保持不动（窗口极小，且改了会影响既有窗口语义） | anticheat · P1 destroy |
| P2-2 | audio | P2 | **不成立（附证据）** | 复现输出：`"活跃 1/8  待播 0\n分类 [sfx:1]\n被拒 0…"` —— **已有 `\n` 分隔** | 未改代码；补一条测试锁住"不得出现 `待播 0分类`" | audio · P1 describe |
| P2-3 | buff | P2 | 已修 | 注册 A、B 两个监听器 → A 触发 **0** 次、B 触发 1 次；`clear()` 只发 `clear`，`remove` 收到 **0** 条 | 改监听器数组 + `indexOf` 精确删除；`clear()` 逐个发 `remove` 再发一次 `clear` | buff · P2 onChange 多播 |
| P2-4 | collision | P2 | **已修（附说明）** | 拿到 `satOverlap` 返回值后写 `r.overlap = true` → 之后所有不相交调用都返回 `overlap: true` | `Object.freeze` 共享常量；另 3 项（`_key` 回绕、`insert` 复杂度、`query` 不可重入）按建议**只加注释**，不改结构 | collision · P2 satOverlap |
| P2-5 | condition | P2 | 已修 | 注册两个 `onComplete` → 第一个触发 **0** 次，且其取消函数形同失效 | 改监听器数组 + 精确删除 | condition · P2 onComplete |
| P2-6 | skill-player | P2 | **已修（附说明）** | `tick(NaN)` → `step = 0`，静默吞一帧（不污染 `_time`） | 按建议"无需改代码，补文档"：源码加注释 + README 坑清单；补测试锁住 `_time` 不被污染 | skill-player · P2 非法 dt |
| P2-7 | spatial | P2 | 已修 | `update('e1',0,0)` 不传 item → `get('e1')` 返回类型合法、运行时为 `undefined` | 保留强转（改了会让"每帧只更新坐标"的调用方全都要多传参），在源码注释写明约定；`destroy()` 已存在，补测试 | spatial · P1/P2 capacity |

---

## 说明①：P1-1 实际存在**三个**入口，报告只写了第一个

原报告描述的是 dt 守卫 `dtSec <= 0` 挡不住 NaN。实测发现：

1. **dt 入口**：在我开工前基线上**已经修好了**——源码已是 `if (!(dtSec > 0)) return null;`
   （并有完整注释说明为什么不能写否定式）。实测注入 NaN 时间戳，`strikes` 保持 2 不变。
2. **dist 入口（真正还开着的那个）**：`dist = NaN` 时 `NaN < this._minDist` 恒 false → 穿透 →
   `speed = NaN` → `exceeded = false` → 走 else → **`strikes` 清零**。
   实测：连续两次超速攒到 `strikes = 2`，再上报 `{x: NaN}` → **变成 0**。
   → 已加 `if (!Number.isFinite(dist)) return null;`
3. **基线污染入口（报告没写，我复现时发现的）**：`push()` 一进门就 `this._last = s`，
   **在守卫之前**。NaN 时间戳的样本因此顶掉基线，导致它后面那个**合法**样本
   算出 `dtSec = (t - NaN)/1000 = NaN`，也被守卫丢掉。
   于是按"合法包 / NaN 包"交替上报（每两个包塞一个 NaN），**所有合法样本都被跳过**，
   检测彻底失明，而 `strikes` 既不加也不清零——看起来"运行正常"。
   这比"清零连击"更彻底。
   → 已改成：只有**通过全部守卫**的样本才写回 `_last`，基线永远是上一个合法样本。
   副作用：这一对样本的间隔被合并计算（dt 偏大 → 速度偏低），
   方向是"宁可少报、不可误报"，与原则三一致。

## 说明②：P1-4 在我开工前已修

`BgmStack.setState()` 基线上**已经是** `hasOwn(this._states, next)`，实测 `setState('toString')`
抛 `[BgmStack] 未知状态 "toString"`。我做了三件事：补 2 条回归（`toString` / `constructor` 都拒绝）
+ 1 条对照（合法状态切换仍正常且层音量 > 0），把这条契约锁住，防止后来的人改回 `in`。
同理 P1-12 的 `_findEntry` 也已被废除（`queryNearest` 改用 `_queryCircleEntries` 直接带坐标），
我补了测试并断言"不得再出现 `_findEntry` 入口"。

> 这两条不是我"判不成立"——它们是**已被前人修好**的条目，我按标准 2 的要求补上了会失败的测试作为防护网。
> 判定为"不成立"的只有 P2-2（`describe` 分隔符）一条。

## 说明③：P1-3 为什么没改代码

既有测试 `tests/run_batch19.ts` 明确断言 **"循环音效不可抢占，应拒绝"**，
且 README"抢占规则"第 3 条白纸黑字写着"循环音效不抢"。
改变它属于**对外 API 行为变更**（任务书第 8 节第 1 条），我不自行拍板。
按原报告给的第二个选项处理：把契约写进 README 的坑表格 + 抢占规则，
并补两条测试锁住（占满时拒绝且 `stats.rejected` 可查 / 预留一个通道即正常播放）。
**需要 loop 可抢占的话请总审裁决**，我按裁决结果再改。

---

## 需总审裁决 1 条

### `spatial` · `capacity` 声明未实现（P1-13）

两种改法都 breaking：

| 方案 | 改法 | 代价 |
|---|---|---|
| **A 实现为硬上限** | `update()` 时若 `_items.size >= capacity` 则拒绝插入或淘汰最旧 | 改变 `update()` 现有行为；"淘汰最旧"还会引入一套新的淘汰策略（LRU？FIFO？），空间索引里静默丢条目比报错更危险 |
| **B 从接口删除** | 删掉 `SpatialHashOptions.capacity` | 所有已传 `capacity` 的调用方编译报错——但那是**好事**：现在他们以为有保护，实际没有 |

**我的倾向是 B**（删字段）："写了但没实现"比"没有"更糟，它会让人拿它做内存预算。
若选 A，我建议**拒绝插入并抛错**而不是静默淘汰——空间索引里丢一个条目，
表现是"某个实体突然不再被任何查询命中"，比崩掉难查得多。

当前处置：接口 JSDoc 与 README 都已明确标注"当前未实现，不要依赖"，
并有一条测试锁住 `capacity:2` 时 `itemCount` 仍为 10（防止有人误以为已生效）。

---

## 交叉验收 W1-A

见 `audit/verify_W1-B.md`。

---

## 提交前自检（全部实跑）

```
tsc -p tsconfig.json --outDir .build     ✓ 211 个 .js，产物校验通过
node .build/tests/run.js                 ✓ 通过 3695 项，失败 0 项
node scripts/check-deps.js               ✓ 全部通过
node scripts/check-links.js              △ 内部链接 44 条，断链 1 处（audit/handoff_W3-B.md，未经我改动）
python3 scripts/scan-dt-guard.py         ✓ 命中 0 处
python3 scripts/scan-num-guard.py        ✓ 命中 0 处
python3 scripts/check-random-source.py   ✓ 未发现自建随机源
python3 scripts/check-dup-exports.py     ✓ 无待处理冲突
```

⚠️ `check-links` 那 1 处断链来自 `audit/handoff_W3-B.md`（W3-B 窗口的文件）。
我已用原始快照 diff 确认：**该文件未经我改动**，断链在开工前就存在。
按并行纪律，我不改别人的文件，回报总审。

⚠️ `build.sh` 在本次执行中偶发两次 502 中断（任务书第 6 节已预告）。
处理方式：改用 `tsc -p tsconfig.json --outDir .build` 直出并校验 `.build/tests/run.js` 存在，
与 `build.sh` 的产物校验等价。

---

## 改动文件清单

**源码（7 个，全部在我自己的单元内，零越界）**

```
anticheat/AntiCheat.ts       dist 有限性守卫 + 基线不被非法样本顶掉 + destroy()
audio/AudioManager.ts        masterVolume 收口（clampNum）
buff/BuffSystem.ts           import 校验/重建 _independent、onChange 多播、clear 逐个发 remove
collision/Collision.ts       raycastAabb 起点在内部返回穿出点、_satEmpty 冻结、3 处注释
condition/ConditionEngine.ts addStat 有限性、evaluate NaN 收口、onComplete 多播
skill-player/SkillPlayer.ts  循环回卷补发 t=0、cancel 归属校验、currentHandle、注释
spatial/SpatialHash.ts       capacity 与 update 强转的注释（未改行为）
```

**测试** `tests/run_phase10_w1b.ts`（新增，53 项，**未并入 `run.ts`**）

**文档** `anticheat/README.md` `audio/README.md` `buff/README.md`
`collision/README.md` `condition/README.md` `skill-player/README.md` `spatial/README.md`
（主 README.md 未动，测试总数由总审统一更新）

**未触碰** `_core/`、`tests/run.ts`、主 `README.md`、`scripts/`、其它 15 个窗口的单元
