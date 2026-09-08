# 交付报告 · 窗口 W4-B（第 B 组）

> 单元 7 个：dialogue / fov / joystick-mover / mover / rebind / reddot / shop
> 清单 15 条（P1 12 + P2 3 组），实际处理 **16 条**（多的 1 条见 W4-B-16）。
> 测试：`tests/run_phase10_w4b.ts`，导出 `runPhase10W4BTests()`，**71 项**，独立运行全绿。

## 基线与自检

| 项 | 结果 |
|---|---|
| 开工基线 | 构建通过、3695 项测试全绿 |
| 交付时全量 | **3695 项通过 / 0 失败**（条数未跌） |
| **验收返工后** | 全量 **3696 项 / 1 失败**（该失败属 `binary` 单元的 W8-B 窗口，与本批无关）；W4-B 测试 **73 项全绿** |
| W4-B 新增测试 | **73 项通过 / 0 失败**（原 71 项 + 验收返工新增 2 条） |
| 六项校验脚本 | 见文末"附"，其中 check-links 有 1 处**既有**断链（非本窗口引入，已由 W3-B 修复） |

**测试有效性验证方法**：把 7 个单元的源码换成仓库 HEAD 原版（`/tmp/orig`，来自 `main` 分支 tarball），
单独编译后跑同一份 `run_phase10_w4b.ts`：

```
通过 35 项，失败 36 项     ← 失败的 36 条全部是 ⚠️ 回归用例
```

即：**36 条回归用例在修复前确实会失败，35 条对照用例修复前后都通过**（后者正是"防止矫枉过正"的证据）。
没有一条用例是"传个正常值断言它正常"的空转。

> 📌 **验收后返工**：W4-A 的验收报告（`audit/verify_W4-A.md`）标红 1 处、建议补 4 处。
> 本窗口已全部处理，详见文末 **§验收后返工**。测试从 71 项增至 **73 项**。

---

## 逐条结果

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| W4-B-01 | dialogue | P1 | 已修 | `choices=0:false,1:false`；`choose(0)=false choose(1)=false advance()=false isDone=false`（进退两难）；`advanceToChoice()=true` 仍卡住 | 新增 `hasEnabledChoice()`；`advanceToChoice` 遇"有选项但无一可选"按终态 `end()`：`advanceToChoice()=false isDone=true` | `run_phase10_w4b.ts:43 / :54`；对照 `:63 / :85` |
| W4-B-02 | fov | P1 | 已修 | `compute(10,10,6)` 后 `explored=113`；调一次 `isSymmetric(10,10,13,10,6)` 后 `explored=148`（多点亮 35 格），且 `visible` 停在 B 的视野 | 进 `isSymmetric` 前快照两张图、出口还原：`explored` 保持 113，`visible` 仍是 A 的视野 | `:109 / :118`；对照 `:129 / :143` |
| W4-B-03 | fov | P1 | **不成立 + 加固**（原写"已修（附说明）"，已按验收意见更正） | 把入口守卫与迭代上限**去掉还原成报告描述的形态**后，`compute(NaN,NaN,4)` **8 秒超时被杀，退出码 124**（死循环成立）；当前 HEAD 上已带守卫，直接跑返回 0 | **现象在当前基线不成立，实现未改**；本窗口的贡献是补三条测试把现状锁住（NaN 起点 / Infinity 起点 / 半径 NaN 由 `needFinite` 拒绝） | `:159 / :168 / :175`；对照 `:183 / :190` |
| W4-B-04 | joystick-mover | P1 | 已修 | `a===b → true`；`a.magnitude` 从 0.5 被改写成 1；`a.dir===b.dir → true` | 保留 `evaluate()` 的零分配语义（不 breaking），新增 `snapshot()` / `evaluateInto()`，并在 `JoystickOutput` 与 `evaluate()` 顶部写醒目警示 | `:239 / :250`；对照 `:260 / :271` |
| W4-B-05 | mover | P1 | 已修 | 连续 3 次 `addImpulse(10,0)` → `externalSpeed=30`（纯累加，JSDoc 承诺的"限总强度"完全落空） | 默认上限改为 `maxSpeed×5`（NaN 也回落到此值，`Infinity` 显式传入仍表示不设限）：4 次 → 30，10 次 → 30 | `:285 / :291 / :297`；对照 `:303 / :309` |
| W4-B-06 | mover | P1 | 已修 | `moveBy(5,0,NaN)` → 位置 `(NaN,NaN)`；`moveBy(5,0,-1)` → 位置 `-5`（倒着走） | `moveBy` 入口加 `safeDt`：三种异常 dt 全部拒绝，位置保持 0 | `:321 / :330 / :339`；对照 `:346` |
| W4-B-07 | mover | P1 | 已修 | `externalDamping=NaN` → 一次 update 后 `externalSpeed=NaN`、`x=NaN`；`turnBoost=NaN` → 掉头后 `vx=NaN, vy=NaN` | 全部配置改 `numOr` 收口：`externalSpeed=8.7985`、`x=0.1408`；`turnBoost=NaN` → `vx=-6`（与默认配置一致） | `:356 / :364`；对照 `:373 / :381` |
| W4-B-08 | rebind | P1 | 已修 | `importState({jump:'+',attack:'k'})` 抛 `TypeError: ...reading 'trim'`，且 `has('attack')=false`（**后续正确条目一条没进**） | `decodeBinding` 解析不出主键即抛错；整条解析链进 try：不抛错、`has('attack')=true`、`jump` 保持原绑定 | `:459 / :466 / :472`；对照 `:476` |
| W4-B-09 | rebind | P1 | 已修 | `importState({a:'k',b:'k'})` → `a=undefined`（被彻底解绑）、`b={key:'k'}`；`onChange` 触发 `[]` | 重复时**保留前者、跳过后进**并触发 `onChange`：`a={key:'k'}`、`b` 无绑定、`onChange=['a']` | `:490 / :497`；对照 `:504 / :511` |
| W4-B-10 | rebind | P1 | 已修 | `prettyKey('constructor')` → `typeof 'function'`，值 `function Object() { [native code] }` | 改用 `hasOwn(PRETTY, k)`：返回 `'Constructor'`（字符串）；`formatBinding` 同步收口 | `:521 / :529`；对照 `:534` |
| W4-B-11 | reddot | P1 | 已修 | n=1000 → 9ms；n=2000 → 48ms；n=4000 → **147ms**（n 翻倍耗时 3~5 倍，二次增长） | 单次遍历建前缀累加表：n=500/1000/2000/4000 **全部 2ms**，且与 `get()` 结果逐条一致 | `:588 / :598`；对照 `:616 / :630` |
| W4-B-12 | shop | P1 | 已修 | 连续 5000 次购买后 `log.length=5000`（只增不减） | 新增 `ShopOptions.logLimit`（`clampNum` 收口，默认 200，与 `currency` 对齐）：5000 次后 `log.length=200`，保留最近的；卖出侧同样受约束 | `:649 / :656 / :675 / :684 / :695`；对照 `:666` |
| W4-B-13 | fov | P2 | 已修（**对照用例已按验收意见重写**） | `new Raycasting(0,10)` 静默成功；`new Raycasting(-5,10)` 抛 `Invalid typed array length: -50`（信息里没有单元名）；`compute` 每次 `toArray()` 导出全图 + perimeter 新建数组与 N 个对象 | 构造补尺寸校验（统一文案 `[Raycasting] 尺寸必须为正`）；`explored` 同步改 `mergeFrom` 按位合并；perimeter 改为直接发射线（**已与写死的期望格表逐格比对，并和重构前实现对拍确认 0 差异**） | `:201 / :205`；对照 `:210`（期望表） |
| W4-B-14 | mover | P2 | 已修（**一版误判设计，已返工为"同帧合成"**） | 三次 `addImpulse(2.5,0)` 合成 7.5 但 `knocked=false`；显式 `knockbackThreshold=0` 被静默改写成 1.5；`stoppingTime(1e9,1)=1e6`（假答案）；无 `destroy()` | knocked 改用**同一帧内**的合成力判断（同帧 3×2.5=7.5 → true，传送带的每帧 0.5~2 → false）；阈值只在**未传**时推导，显式 0 保持语义；`stoppingTime` 去掉 1e6 夹取；补 `destroy()` | `:390 / :405 / :430 / :441`；对照 `:399 / :421 / :434` **+ 新增 2 条** `:415 / :445` |
| W4-B-15 | rebind | P2 | 已修 | `bind('custom')` 后 `resetToDefault()` → `has('custom')=false` 但只通知了 `['jump']`（静默丢弃）；`destroy()` 不存在（rule5）；`_removeRaw` 里 `encodeBinding` 重复调用两次 | 无默认值的动作被清掉时补发 `onChange`；新增 `destroy()`；`_removeRaw` 只算一次编码 | `:547 / :567`；对照 `:558 / :578` |
| W4-B-16 | shop | P2（附带） | 已修 | `stockRange:[5,1]` → `stockOf('a')=2`；`stockRange:[0,-5]` → `stockOf('b')=-4`，而 **-1 在本单元是"无限库存"** → 配错区间被静默翻译成"永远卖不完" | 新增 `normalizeRange`：顺序写反时交换、非数值回落、库存下界夹到 0：`[5,1]` → 5，`[0,-5]` → 0 | `:715 / :722 / :729`；对照 `:735 / :743` |

> W4-B-16 不在清单编号里，来自任务书 W4-B-12 的"其他复核"（*`restock` 的 `stockRange`/`markupRange` 未校验 `min > max`*）。
> 它是**经济系统的静默失效**（负库存恰好等于"无限库存"），且同一次改动就能收口，故一并处理。

---

## 需要总审裁决的 2 处

**① `dialogue` 的"全禁用即终态"是行为变更（可能 breaking）**

`advanceToChoice()` 过去在"有选项"节点恒返回 `true`，现在全禁用时返回 `false` 并 `end()`。
两种选择：

- 维持现状（推荐）：调用方的 `isDone` 分支能正常收尾，死锁可解；代价是依赖旧返回值的调用方需要适配。
- 只加 `hasEnabledChoice()`、不改 `advanceToChoice`：零 breaking，但自动播放流程仍会卡死——死锁**依然存在**。

我选前者，因为"能检测到但解不开"不算修复。

**② `mover.addImpulse` 的默认上限取 `maxSpeed × 5` 是经验值**

任务书建议 `maxSpeed × 2`。我取 5 的理由：常见击退配法本身就是 `maxSpeed` 的 3~5 倍，
取 2 会把一次正常强力击退削成挠痒痒（比"叠成火箭"隐蔽，因为没人会想到默认值在削自己）。
若总审认为"宁可削，不可飞"，改成 2 只需改一个数字。

---

## 附：全库校验结果

```
bash build.sh                        TSC OK（产物校验通过：212 个 .js）
node .build/tests/run.js             通过 3695 项，失败 0 项，全部通过 ✓
node /tmp/run_w4b.js（本批独立跑）    通过 71 项，失败 0 项，全部通过 ✓

node scripts/check-deps.js           全部通过 ✓
node scripts/check-links.js          44 条内部链接，断链 1 处
python3 scripts/scan-dt-guard.py     扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py    扫描 0 处命中 ✓
python3 scripts/check-random-source.py  [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py [OK] 无待处理的冲突 ✓
```

### 两处需要说明的校验结果（**已被后续提交改变，最新状态见 §推送后复核**）

1. **check-deps 曾报 `rebind → _core` 未登记**：本窗口为收口 `prettyKey` 的原型链，
   在 `rebind/Rebind.ts` 引入了 `_core/guard` 的 `hasOwn`。已用脚本自带的
   `node scripts/check-deps.js --fix` 登记（`_kitmeta.json` 里 rebind 的
   `depends: [] → ["_core"]`）。**这是本窗口对 `_kitmeta.json` 的唯一改动**，
   与别的窗口无重叠。
   ⚠️ **但该登记已被后续窗口的提交覆盖回 `[]`** —— 详见 §推送后复核。

2. **check-links 的 1 处断链不在本窗口**：位于 `audit/handoff_W3-B.md`（解析为 `audit/...` 的占位链接）。
   该文件是 W3-B 的交付物，本窗口未改动、也未修（避免与对方窗口冲突）。
   ✅ **已由 W3-B 修好**：W3-B 在 `87b2a889` 修掉了 `check-links.js` 对行内代码
   `](` 的误判，现在全库断链为 **0**（详见 §推送后复核）。本条已闭环。

---

## 推送后复核（在远程最新代码上重跑）

推送完成后 `main` 上又合入了其它窗口（W5-B、W2-B、W7-B、W3-B、W4-A…）的改动。
为确认本窗口的 7 个单元在**合入后的真实仓库**里仍然成立，我从远程 `main`
重新拉了一份干净快照重跑全部校验（本轮复核时间：2026-09-08）：

```
$ ./node_modules/typescript/bin/tsc -p tsconfig.json
exit 0

$ node .build/tests/run.js
通过 3696 项，失败 0 项                # 开工基线 3695，+1 来自其它窗口，只增不减
全部通过 ✓

$ node -e "...runPhase10W4BTests()"    # 本窗口 71 项独立运行
通过 71 项，失败 0 项
全部通过 ✓

$ node scripts/check-links.js
[OK] 内部链接 42 条，断链 0 处（扫描 178 个 .md 文件）   ← 已归零，见上文第 2 条

$ python3 scripts/scan-dt-guard.py        扫描 146 个文件，命中 0 处 ✓
$ python3 scripts/scan-num-guard.py       扫描 0 处命中 ✓
$ python3 scripts/check-random-source.py  [OK] 未发现自建随机源 ✓
$ python3 scripts/check-dup-exports.py    [OK] 无待处理的冲突 ✓

$ node scripts/check-deps.js
[✗] import 了但没登记 6 条：i18n / curse / rarity / rebind / gameflow / accessibility → _core
```

**本窗口的 7 个单元源码未被任何后续提交触碰**（已逐个核对 `c8c1c0f` 之后的
13 个提交：只有 `_kitmeta.json` 被反复覆盖，7 个单元 0 处改动）。71 项测试全绿，
说明本批修复在合入后的真实仓库里**依然成立**。

### ⚠️ `_kitmeta.json` 的并发覆盖：已用实测证明"各自 --fix 无效"

本窗口推送时已把 `rebind → _core` 登记进去，现在**它又回到了未登记列表**。
未登记数从本窗口推送时的 1 条（`rebind`）涨到现在的 **6 条**：

| 单元 | 谁引入的 `_core` import | 本窗口推送时 | 现在 |
|---|---|---|---|
| `rebind` | 本窗口（`hasOwn`） | ✅ 已登记 | ❌ 被覆盖回 `[]` |
| `i18n` / `gameflow` | W4-A | 未登记 | 未登记 |
| `curse` / `rarity` / `accessibility` | 其它窗口 | 未登记 | 未登记 |

**根因**：16 个窗口并行提交，每个都整份写回 `_kitmeta.json`，后提交的覆盖先提交的。
`_kitmeta.json` 不是文本文件意义上的冲突——Git 能合并，但**合并结果取决于谁最后写**。

**本窗口本次不执行 `--fix`**，理由与 W2-B 的报告一致：`--fix` 会把 5 个其它窗口的
登记混进本窗口这次提交，反而让"哪个窗口负责哪几条"变得不可追溯。
且上面这张表本身就是证据——**各自 fix 会被下一次提交冲掉，只能由总审统一 fix 一次**。

**请总审在全部窗口交付完毕后执行一次 `node scripts/check-deps.js --fix`。**
这一条不阻塞本窗口交付：未登记只影响"复制单元时会漏文件"，不影响编译与测试。

### 未触碰的文件（按并行纪律）

`_core/**`、`tests/run.ts`、`README.md`、`build.sh`、其它窗口的单元与文档，均未改动。
本窗口改动的文件：

```
dialogue/DialogueGraph.ts
fov/FOV.ts
joystick-mover/JoystickCore.ts
mover/CharacterMover.ts
rebind/Rebind.ts
reddot/RedDot.ts
shop/Shop.ts
_kitmeta.json                 （仅 rebind.depends 一项，由 check-deps --fix 写入；
                               ⚠️ 该项已被后续窗口的提交覆盖回 []，见 §推送后复核）
tests/run_phase10_w4b.ts      （新增）
audit/result_W4-B.md          （新增）
audit/verify_W4-B.md          （新增）
```

---

## 验收后返工（回应 `audit/verify_W4-A.md`）

验收方 W4-A 的结论是**有条件通过**：1 处标红（W4-B-14）+ 4 处建议补。
本窗口全部接受，逐项处理如下。

### ❌ 标红项 · W4-B-14 的 `knocked` 判据 —— 已返工

**验收意见**：把判据从"单次冲量"改成"跨帧合成后的总外力"，
踩中了源码注释**明确警告要防**的传送带场景。

**本窗口独立复现，数字与验收方一致**：

| 每帧强度 | 稳态外力 | 一版修法 knocked 帧数 |
|---|---|---|
| 0.5 | 3.51 | **590 / 600** |
| 1.0 | 7.01 | **597 / 600** |
| 2.0 | 14.02 | **599 / 600** |

而 `update` 里 `control = knocked ? knockbackControl : 1`、默认 0.3——
玩家一踏上传送带，操作权从 100% 掉到 30%，只要还在上面就不恢复。
**这个标红是对的**，而且是本项目最难发现的那一类：不是漏修，是把设计当成缺陷修掉了。

**改法（采纳验收方给的方向 2）**：区分两种"多段推力"

| 形态 | 例子 | 跨帧合成？ |
|---|---|---|
| 同帧多次 `addImpulse` | 连击、多重爆炸、弹幕推挤 | ✅ 要合成 |
| 每帧一小次 | 传送带、风力、持续推挤 | ❌ 不合成 |

实现上新增 `_impulseX / _impulseY` 记录**同一帧内**的累计冲量，
由 `update()` 末尾清零（"一帧"的定义 = 相邻两次 `update()` 之间，
因为本类没有帧号，`dt` 是外部传入的）。

**修复后实测**：

| 每帧强度 | 稳态外力 | 一版修法 | **现实现** |
|---|---|---|---|
| 0.5 | 3.51 | 590 / 600 | **0 / 600** |
| 1.0 | 7.01 | 597 / 600 | **0 / 600** |
| 2.0 | 14.02 | 599 / 600 | **0 / 600** |
| 3.5 | 24.54 | 600 / 600 | **600 / 600**（单次就超阈值，本该判击退） |

对照组（该修的仍然修着）：

- 同帧 3 次 `addImpulse(2.5)` → `knocked = true` ✅
- 单次 `addImpulse(10)` → `knocked = true` ✅
- 分 3 帧各 `addImpulse(2.5)` → `knocked = false` ✅（传送带形态）

**为什么原来那条对照用例没抓到**：它测的是**单次** `addImpulse(1, 0)`，
单次合成外力才 1，两种实现都判 false。真正会翻脸的是"持续多帧累加"。

**新增 2 条测试**（`run_phase10_w4b.ts:415 / :445`），并已验证有效性——
把它们跑在**一版修法**上：

```
✗ ⚠️ 持续多帧小外力不得进入击退态（传送带）
   每帧 0.5：传送带形态不该判击退，实际 knocked 590/600 帧
✗ ⚠️ 同样的多段推力，分帧施加不算击退、同帧施加才算
   跨帧的持续推力不该合成： 期望 false，实际 true
通过 71 项，失败 2 项     ← 两条新用例在一版修法上确实会红
```

### ⚠️ 建议补 1 · W4-B-03 的状态标注 —— 已更正

原写"已修（附说明）"。验收方指出：守卫在 P0 轮就已就位
（`_inBounds` + `normalizeRadius` 内含 `needFinite`），
本窗口的复现方式是"把守卫去掉还原成报告描述的形态"——
所以准确结论是**现象在当前基线不成立**，贡献是"补 3 条测试锁住现状"。

已把表格状态改为 **"不成立 + 加固"**，实现确实一行未改。

### ⚠️ 建议补 2 · W4-B-13 的对照用例是恒通过的 —— 已重写

原写法拿**两个新实现的实例**互相逐格对拍，永远一致，什么也没防住。

已改成与**写死的期望格表**比对（11×11，`#` = 可见）：

```
'.....#.....',   // y=0..4
'###########',   // y=5  光源所在行
'.....#.....',   // y=6  墙行：只有墙格被点亮
'...........',   // y=7..10  墙的阴影
```

这张表是重构后跑出来的，并已与重构前的实现（父提交 `7c425d8` 的 `FOV.ts`）
逐格对拍确认**差异 0 处**，所以同时代表重构前后的行为。

**已验证它不是恒通过的**——把圆周裁剪条件 `> r*r` 改成 `>= r*r`
（模拟"改坏了圆周格子集合"）后重跑：

```
✗ ⚠️ 去掉 perimeter 中间数组后，逐格结果与写死的期望表一致
   第 0 行的可见性应与期望表逐格一致： 期望 ".....#....."，实际 "..........."
```

**一处诚实说明**：这条用例守住的是"最终可见性格表"，**不是"遍历顺序"本身**。
因为 `_castRay` 的 `mark()` 是幂等的，改变发射顺序不改变结果——
所以任何用例都测不出"顺序变了但结果没变"这种情况。
它能抓住的是"圆周格子集合变了"（裁剪条件、半径计算被改坏），
这才是重构真正可能伤到的地方。

### ⚠️ 建议补 3 · `isSymmetric` 的快照用了刚批评过的 `toArray()` —— 已改

同一份文件里刚写过"toArray() 会为每个可见格分配一个对象"，
`isSymmetric` 的快照还原却正是这么写的，而且是两张图各一次。

已给 `VisibilityMap` 新增 `snapshot()` / `restore()`（`Uint8Array.slice()` / `.set()`，
零对象分配），`isSymmetric` 改用它们，并删掉因此失效的私有 `_restore()`。

**实测（60×60，1000 次平均）**：

| 半径 | toArray 方案 | 切片方案 | 倍数 |
|---|---|---|---|
| 6 | 0.0367 ms/次 | 0.0203 ms/次 | **1.81x** |
| 12 | 0.0407 ms/次 | 0.0269 ms/次 | **1.51x** |
| 20 | 0.0700 ms/次 | 0.0445 ms/次 | **1.57x** |

正确性对拍：200 次调用，两种方案结果**差异 0 处**。

### ⚠️ 建议补 4 · 7 个单元的 README 一处没同步 —— 已全部补上

| 单元 | 补的内容 |
|---|---|
| `mover` | ① 默认上限 `Infinity → maxSpeed×5`（原文写的"建议 ×4"与新默认值打架，已改）② API 表补 `destroy()` ③ 新增"⑦ `knocked` 的判据是同一帧内的合成力"，含同帧/跨帧对照表与传送带实测数据 |
| `shop` | ① 坑表补"流水无上限" ② 新增"构造参数"段说明 `logLimit`（默认 200、`NaN` 回落、超限时丢最老的，故 `netSpent()` 不是精确历史账本） |
| `joystick-mover` | ① API 表补 `snapshot()` / `evaluateInto()` ② 在"复用对象"一节说明"要存一份就用这两个，别手写展开"（`dir` 里还有 `magnitude`，少拷一个字段就是新坑） |
| `rebind` | ① API 表补 `destroy()` ② 补 `importState` 重复键语义（保留前者、跳过后进）③ 补 `resetToDefault()` 对无默认值动作补发 `onChange` |
| `dialogue` | API 表补 `hasEnabledChoice()`，并写清"全禁用即终态"的 breaking 语义 |
| `fov` | ① 补 `isSymmetric` 的"纯查询不得污染 explored"警告 + 快照方案的性能数据 ② API 表补 `mergeFrom` / `snapshot()` / `restore()` ③ 补 `Raycasting` 的尺寸校验 |

`reddot` 无新增 API，无需同步。

---

## 返工后的全库校验（2026-09-08）

```
bash build.sh                        → TSC OK（产物校验通过：227 个 .js）
node .build/tests/run.js             → 通过 3696 项，失败 1 项  ← binary 单元（W8-B 窗口），与本批无关
W4-B 独立运行                         → 通过 73 项，失败 0 项 ✓

node scripts/check-deps.js           → 8 条未登记（全库级并发问题，见 §推送后复核）
node scripts/check-links.js          → [OK] 断链 0 处（191 个 .md）
python3 scripts/scan-dt-guard.py     → 扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py    → 命中 0 处 ✓
python3 scripts/check-random-source.py → [OK] ✓
python3 scripts/check-dup-exports.py → [OK] ✓
```

**本窗口仍不执行 `check-deps --fix`**：8 条里只有 `rebind` 属于本窗口，
其余 7 条来自 W4-A 与其它窗口。整份写回会把别人的登记混进来，
反而让"哪个窗口负责哪几条"不可追溯，且会被下一次提交冲掉。
**请总审在全部窗口交付完毕后统一 fix 一次。**
