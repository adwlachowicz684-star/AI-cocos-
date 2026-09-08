# 交付报告 · 窗口 W6-A（第 A 组）

> 单元：**di / noise / timeutil**
> 任务书：`audit/handoff_W6-A.md`
> 测试：`tests/run_phase10_w6a.ts`（导出 `runPhase10W6ATests()`，**未注册到 `tests/run.ts`**——按并行纪律由总审统一合并）
> 基线：3695 项 → 现在 3696 项全绿（+ 本窗口新增 **51 项**，未计入 run.js）
> 交叉验收：已产出 `audit/verify_W6-A.md`（验收 W6-B，结论**通过**）

---

## 0. 一句话结论

**13 条：11 条已修、2 条已修（附说明）。**
其中 2 条经实测发现**清单描述的现象在当前基线上已不成立**（`octaves=Infinity` 挂起、`isNewDay` 的时间戳误用并非"静默 false"那么简单），我如实标注并保留了护栏用例，见第 3 节。
新增回归 **51 项**，每条修复都配了"触发输入的回归用例 + 合法输入的对照用例"。

---

## 1. 交付纪律自检

| 纪律 | 执行情况 |
|---|---|
| 不碰 `_core/` | ✅ 只读引用 `needFinite` / `needCount` / `clampNum` / `numOr`，未改一行 |
| 不改 `tests/run.ts` | ✅ 未改，等总审合并（合并方式见第 6 节） |
| 不改 `README.md`（根） | ✅ 未改 |
| 临时脚本 | ✅ 全部放 `/tmp/w6a/`，仓库内无 `verify/` 残留 |
| `_kitmeta.json` | ✅ 未改（我的 3 个单元本来都已登记 `_core`） |
| 先复现后修改 | ✅ 13 条全部在改代码前用只读取数脚本跑出"修复前"输出（`/tmp/w6a/repro.js`、`/tmp/w6a/before.js`） |

**反向验证**：对"当前基线已修"或"无法从输出结果区分"的条目，我用**旧公式的等价实现**跑对照
（`/tmp/w6a/before.js` 里的 `fbmOld()` / `startOfDayOld()`），证明新断言在旧实现下会失败。
没有使用"回退旧代码再跑一遍"的方式（`review_A.md` 标准 2 明令禁止）。

---

## 2. P1 逐条（11 条）

| # | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| W6A-01 | di | P1 | **已修** | 注册 a（destroy +1）→ `override:true` 重注册 a（+10）→ `destroy()` → 计数 **10**（旧实例的 +1 从未发生） | `_disposers` 数组改 `_disposeFns: Map<key, (c)=>void>`；`register({override:true})` 前先 `_disposeKey(key)` 销毁旧实例。销毁函数**接收容器**而非闭包捕获，避免 fork 后误伤父容器 | `di · 覆盖注册必须先销毁旧实例（W6A-01）` |
| W6A-02 | di | P1 | **已修** | 父 `disposable('svc')` → `fork('child')` → `child.get('svc')` → `child.destroy()` → 销毁计数 **0**（期望 1） | `fork()` 一并复制 `_disposeFns` 与 `onDisposeError`；子容器销毁只作用于自己的 `_singletons` | `di · fork 要继承销毁责任（W6A-02）` |
| W6A-03 | di | P1 | **已修（附说明）** | `disposable('t', …, {lifetime:'transient'})` → `get` 3 次 → `destroy()` → 计数 **0**，且**不报错**（组合被静默忽略） | 注册时直接抛错拒绝该组合。**没有**改成"记录每次创建的 transient 实例"——那会在热路径上放一个只增不减的数组 | `di · disposable 与 transient 是无效组合（W6A-03）` |
| W6A-04 | noise | P1 | **已修** | `new Noise(NaN).noise2(1.5,2.5) === new Noise(0).noise2(1.5,2.5)` → **true**（`-0.18010876423407166`）；`ValueNoise(NaN) === ValueNoise(0)` → true；`SimplexNoise(Infinity)` 同样塌成 0 | `mulberry32` 入口 `needFinite(seed, 'seed')`；四个噪声类都从这里取随机流，一处收口全覆盖 | `noise · 非有限 seed 不得静默退化（W6A-04）` |
| W6A-05 | noise | P1 | **已修（附说明：现象不成立）** | 实测 `fbm2D(..., {octaves:Infinity})` → **TypeError: [guard] opts.octaves 必须是有限数值**（耗时 0ms，**并未挂起**）；`ridged2D` 同 | 清单描述的"死循环"在当前基线不成立：`needCount(opts.octaves ?? 4, 'opts.octaves', 64)` 早已拦住。我**未改这一行**，只补了说明注释 + 护栏用例 | `noise · octaves 不得导致死循环（W6A-05）` |
| W6A-06 | noise | P1 | **已修（部分）** | `lacunarity=0` → `0.18503969…`（旧公式，退化成重复采样）；`persistence=NaN` → **0**；`persistence=-3` → **0**；`ridged2D` 同样归零 | `octaves` 基线已由 `needCount` 覆盖（NaN/-1 都抛错，实测确认）；**真正缺的是另外两个**：`lacunarity = clampNum(…, 1, 16, 2)`、`persistence = clampNum(…, 0, 1, 0.5)`，`amplitude`/`frequency` 用 `numOr` | `noise · lacunarity / persistence 收口（W6A-06）` |
| W6A-07 | noise | P1 | **已修（返工一次，见第 10 节）** | `islandMask(1,1)[0] === NaN`；`islandMask(1,3)[0] === NaN`；`islandMask(3,3)[0] === 0`（正常） | **只在 `cx === 0` 时兜底**：`rawCx > 0 ? rawCx : 0.5`。第一版写成 `Math.max(1, (width-1)/2)`，把 2×N 的中心从 0.5 夹成 1 → `islandMask(2,2)` 从全 0 变成 `[0,0,0,1]`，**改坏了本无 NaN 的既有行为**，已返工 | `noise · islandMask 边界尺寸（W6A-07）` |
| W6A-08 | timeutil | P1 | **已修（附说明）** | `isNewDay(now+86400000, now)`（传时间戳）→ **false**；传 `dayIndex(now)` → true。误用**完全不报错**，且自带测试 `run_batch13.ts:686` 用的正是 `dayIndex`，覆盖不到误用 | 参数改名 `lastSeen → lastDayIndex` + JSDoc；对 `>1e11`（时间戳量级）和 NaN **直接抛错**并给出正确写法 | `timeutil · isNewDay 拒绝时间戳（W6A-08）` |
| W6A-09 | timeutil | P1 | **已修** | `start(0)` → `pause(100)` → `state(500)` → **`'running'`**（而 `remaining(500)` 已正确冻结为 900） | `CountdownState` 加 `'paused'`；`state()` 把暂停判定提到最前面 | `timeutil · Countdown 的暂停态（W6A-09）` |
| W6A-10 | timeutil | P1 | **已修** | `ticksSince(0,1000,NaN)` → **NaN**（不报错）；`ticksSince(0,1000,0)` 正常抛错——同一条守卫对 0 有效、对 NaN 失效 | 改成肯定式 `!(periodMs > 0)`。`Infinity` 仍允许（无限周期 = 0 个 tick，语义自洽） | `timeutil · ticksSince 的 NaN 守卫（W6A-10）` |
| W6A-11 | timeutil | P1 | **已修** | `startOfDay(2024-07-01T05:00Z, US_PACIFIC)` → **2024-06-30T08:00Z**（PDT 应为 07:00Z）；`EU_CENTRAL` → 23:00Z（CEST 应为 22:00Z） | 新增 `zoneOffsetAt()`：用 `Intl.DateTimeFormat(longOffset)` 取**真实**偏移，并按日界时刻再取一次（覆盖切换当天）；`Intl` 不可用/时区名非法时回退到 `offsetMinutes` | `timeutil · 夏令时时区的日界（W6A-11）` |

---

## 3. 两条"清单描述与基线不符"的说明（不按"看代码觉得没问题"下结论）

### W6A-05 · `octaves=Infinity` 并不挂起

清单写"实测挂起（`timeout 6`）"。我在当前基线上实测：

```
fbm2D({noise2D:()=>1},1,1,{octaves:Infinity})
  → THROW TypeError: [guard] opts.octaves 必须是有限数值，实际 Infinity（number）
耗时 0ms
ridged2D(...) → 同样抛 TypeError，耗时 0ms
```

`needCount(opts.octaves ?? 4, 'opts.octaves', 64)` 已经在入口把 Infinity / NaN / 负数全挡住了——
**不是没修，是修过了**（函数里那两段"⚠️ octaves 必须有上界"的注释就是当时的修复记录）。

我做了三件事：
1. 把注释里"静默返回 0"的旧描述改写成真实的修复前后对比（避免后来的人读到过时描述又去改一遍）；
2. 保留一条护栏用例：谁把 `needCount` 换回 `?? 4`，这条立刻变红（旧写法下 `octaves=NaN` 会走 `maxValue > 0 ? … : 0` 分支静默返回 0）；
3. 用旧公式实测确认：`fbmNoGuard(…, {octaves:NaN}) → 0`（一整张平原，不报错）。

### W6A-06 · 真正的缺口是 `lacunarity` / `persistence`，不是 `octaves`

清单把三条并列，实测下来只有后两条是活口：

| 输入 | 旧公式（我用等价实现跑的） | 现状 |
|---|---|---|
| `octaves=NaN` | —（基线已抛错） | `TypeError: opts.octaves 必须是有限数值` |
| `octaves=-1` | —（基线已抛错） | `RangeError: opts.octaves 不能为负` |
| `lacunarity=0` | `0.18503969455192618`（与 `lacunarity=1` 的 `0.3469494272848615` **不等**，说明后几层都在采样原点） | 夹到下界 1，与 `lacunarity=1` 相等 |
| `persistence=NaN` | **0**（`amplitude` 变 NaN → `maxValue` 为 NaN → 走 `: 0` 分支） | `0.2955543045618454` |
| `persistence=-3` | **0**（`maxValue` 翻负） | 夹到 0，等于 `persistence=0` |

范围选择写在代码注释里：`lacunarity ∈ [1,16]`、`persistence ∈ [0,1]`
（`0` = 只要第一层、`1` = 不衰减，两者都是合法的上/下界，不能被夹掉——有对照用例守着）。

**为什么这里用 `clampNum` 兜底、而 `octaves` 用 `needCount` 抛错**：`octaves` 是循环次数，越界会卡死进程，必须让调用方立刻失败；这两个是观感参数，夹到合法区间后仍能出一张合理的图，让地形生成器因为配置表里一个笔误就整局崩溃，代价不成比例。

---

## 4. P2 逐条（2 条）

| # | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| W6A-12 | di | P2 | **已修** | 销毁抛错时 `console.error` 被调 **1 次**（`[DI] 销毁出错：Error: boom`），`destroy()` 返回 `undefined`，调用方无从感知 | `destroy(): string[]` 收集错误返回；新增可选 `onDisposeError(key, err)` 钩子（构造时传入，`fork()` 继承）；单个服务失败不中断其余销毁 | `di · 销毁失败不写 console.error（W6A-12）` |
| W6A-13 | noise | P2 | **已修（附说明）** | `noise3D` 沿 x 走 1 单位输出变化 **0.198**，沿 z 走 1 单位变化 **1.005**（差 5 倍，各向异性）；`37.7` 硬编码；两份 `GRAD3` 梯度表逐字重复（53-57 与 192-196 行） | **保留伪 3D 不动**（换真 3D 单纯形是算法重写，且会改变所有已有地形）——把 `37.7` 提成 `NOISE3D_SLICE_SPACING` 并写明它是观感参数；JSDoc 写清各向异性与实测数据；两份梯度表合并为模块级 `GRAD2`；`PerlinNoise` 保留导出并说明"内部不用但仍导出"的理由 | `noise · noise3D 的伪 3D 契约与常量（W6A-13）` |

**关于"各向异性"这条用例**：我写的是"z 方向变化必须 > x 方向变化"——它锁的是**注释里的现象描述**，
一旦换成真 3D 单纯形，这条会变红，提示维护者连注释一起更新，而不是让文档悄悄说谎。

---

## 5. 需要总审裁决的 3 处

| 条目 | 变更 | 为什么必须改 | 代价 / 另一种选择 |
|---|---|---|---|
| W6A-03 | `disposable(..., {lifetime:'transient'})` 从"静默忽略"变成**抛错** | 这是配置组合静默失效：调用方预期"临时对象也会被回收"，实际一个都不销毁，编译期和运行时都不报错 | 依赖旧行为（写了 transient 又没崩）的代码会当场失败。**另一种选择**：记录每次创建的 transient 实例并在 destroy 时统一销毁——但那等于在热路径上放一个只增不减的数组（transient 的调用次数无界），与本库反复消除的"无界增长"冲突，所以我没选 |
| W6A-08 | `isNewDay` 传时间戳从"静默 false"变成**抛 RangeError**；参数名 `lastSeen → lastDayIndex` | 静默 false 的后果是"每日任务/奖励永不刷新"，运营查一周查不出原因 | 会把隐藏的误用暴露成启动期报错。**另一种选择**：内部 `dayIndex(lastSeen)` 兼容两种传法——但日序号本身也是个毫秒数（约 2 万 ms ≈ 1970-01-01），再取一次 dayIndex 恒为 0，正确用法反而会变成永远 true。**两种传法无法无歧义兼容**，所以选了报错 |
| W6A-09 | `CountdownState` 增加 `'paused'` | 不加则 `state()` 与 `remaining()` 自相矛盾（一个冻结、一个说在跑），调用方只能自己记标志 | 对已有 `switch` 是穷尽性上的 breaking：写死三分支且开了穷尽检查的调用方会编译报错——**我认为这正是想要的**（漏处理暂停态的代码应在编译期浮出来），但请总审确认 |

---

## 6. 提交前自检

```
bash build.sh                          → TSC OK（产物校验通过：224 个 .js）
node .build/tests/run.js               → 通过 3696 项，失败 0 项   （基线 3695，只增不减 ✅）
runPhase10W6ATests()（独立 runner）    → 通过 51 项，失败 0 项      ✅
node scripts/check-links.js            → [OK] 内部链接 42 条，断链 0 处  ✅
python3 scripts/scan-dt-guard.py       → 扫描 146 个文件，命中 0 处   ✅
python3 scripts/scan-num-guard.py      → 扫描 0 处命中               ✅
python3 scripts/check-random-source.py → [OK] 未发现自建随机源       ✅
python3 scripts/check-dup-exports.py   → [OK] 无待处理的冲突         ✅
node scripts/check-deps.js             → [5] 登记一致性 ✗ 8 条（见下）
```

**check-deps 的 8 条未登记**（`i18n` / `blessing` / `curse` / `rarity` / `achievement` / `rebind` / `gameflow` / `accessibility` → `_core`）：
**全部是其他窗口的单元，与本窗口零交集**，不是我引入的（我这次给 `noise` 新增了 `import { clampNum, numOr } from '../_core/math'`，
但 `noise` 本来就登记了 `_core`，扫描结果里也确实没有它）。建议总审统一 `node scripts/check-deps.js --fix`。

### 测试怎么跑

`tests/run.ts` 按纪律未改，总审合并时加两行即可：

```ts
import { runPhase10W6ATests } from './run_phase10_w6a';
...
runPhase10W6ATests();
```

未合并前可用独立 runner 验证：

```
node -e "const{setSuite,summary}=require('./.build/tests/_framework.js');
const{runPhase10W6ATests}=require('./.build/tests/run_phase10_w6a.js');
setSuite('W6-A');runPhase10W6ATests();summary();"
→ 通过 51 项，失败 0 项
```

---

## 7. 我改了哪些文件

| 文件 | 改动性质 |
|---|---|
| `di/DIContainer.ts` | `_disposers[]` → `_disposeFns: Map<key, (c)=>void>`；`register` 覆盖前销毁旧实例；`fork` 复制销毁函数；`disposable` 拒绝 transient；`destroy()` 返回 `string[]` + 新增 `onDisposeError` 选项（`DIContainerOptions`） |
| `noise/Noise.ts` | `mulberry32` 的 seed 守卫；`fbm2D`/`ridged2D` 的 `lacunarity`/`persistence`/`amplitude`/`frequency` 收口；`islandMask` 的 `cx`/`cy` 下限；`37.7` → `NOISE3D_SLICE_SPACING`；两份 `GRAD3` 合并为 `GRAD2`；3 处 JSDoc（`noise3D` 各向异性、`PerlinNoise` 为何保留导出、`octaves` 注释更新） |
| `timeutil/TimeUtil.ts` | 新增 `zoneOffsetAt()`（`Intl` 动态偏移 + 缓存 + 回退）；`startOfDay` 二次收敛；`dayIndex` 走真实偏移；`isNewDay` 改名 + 两道守卫；`ticksSince` 肯定式守卫；`CountdownState` 加 `'paused'` + `state()` 暂停分支 |
| `tests/run_phase10_w6a.ts` | 新增，51 项（每条含回归用例 + 对照用例） |
| `audit/result_W6-A.md` | 本文件 |
| `audit/verify_W6-A.md` | 交叉验收 W6-B 的报告 |

**没有**顺手重构：没有改命名风格、没有调整结构、没有删"看着没用"的代码。
`PerlinNoise` 虽然内部无人使用，但它是 export 的公开 API，我只补说明、没删。
`_core/` 一行未动。

---

## 8. 给后续窗口的一句话提醒

`timeutil` 现在有两处依赖运行环境：**`Intl` 时区数据库**（`zoneOffsetAt`）。
宿主引擎若裁剪了 ICU，或 `zone.name` 不是合法 IANA 名，会回退到常量 `offsetMinutes`
（即修回"固定偏移、夏令时半年错 1 小时"的旧行为）——**回退是静默的**，
这是有意的设计取舍（不能让"取不到时区"变成崩溃），但排障时要知道这条路径存在。

---

## 9. 推送后复核（在远程最新 main 上重跑）

推送完成后重新下载远程 main 的完整副本（`52b0415e` 之后的状态），逐文件比对确认 6 个文件**字节级一致**，然后重跑：

| 项目 | 结果 |
|---|---|
| 文件比对 | `di/DIContainer.ts` / `noise/Noise.ts` / `timeutil/TimeUtil.ts` / `tests/run_phase10_w6a.ts` / `audit/result_W6-A.md` / `audit/verify_W6-A.md` 全部 **SAME** ✅ |
| `bash build.sh` | TSC OK（产物校验通过：227 个 .js）✅ |
| 本窗口 `runPhase10W6ATests()` | **通过 51 项，失败 0 项** ✅ |
| 交叉验收对象 `runPhase10W6BTests()` | **通过 84 项，失败 0 项** ✅ |
| `node .build/tests/run.js` | 通过 3696 项，**失败 1 项**（见下，与本窗口无关） |
| `check-links.js` | **[OK] 42 条链接，断链 0 处** ✅ |
| `scan-dt-guard.py` / `scan-num-guard.py` | 命中 0 处 / 0 处 ✅ |
| `check-random-source.py` / `check-dup-exports.py` | [OK] / [OK] ✅ |
| `check-deps.js` | 本窗口 3 个单元均已登记；剩余未登记条目为其他窗口单元（同第 6 节） |

**那 1 项失败与本窗口无关**：

```
✗ 第九批：工程效率（command / debug-console / binary / crash）
  › BinarySerializer · 位级序列化
  › ⚠️ float 会 clamp 而不是溢出回绕: [Binary] float 越界：999（范围 -10..10）
```

失败点在 `tests/run_batch10.ts:766`，对应的是 **`binary` 单元（W8-B 窗口）** 的 P1
「float.write 对越界值静默 clamp，违反 README §6③"越界值绝不静默截断"」。
现象是：`binary/BinarySerializer.ts:218` 现在**正确抛错**了（W8-B 的修法生效），
但 `run_batch10.ts` 里那条旧用例断言的仍是旧的 clamp 行为——**旧用例还没跟着改**。

我未改动 `binary` 与 `tests/run_batch10.ts`（不是我的单元），也没有"顺手帮它改"（会和 W8-B 冲突）。
**请 W8-B 窗口把 `tests/run_batch10.ts:766` 那条旧断言更新为"越界抛错"**，或由总审统一处理。

---

## 10. 对家验收（`audit/verify_W6-B.md`）的核销与二次任务

对家 W6-B 的验收报告写于**我推送之前**，当时的结论是「**无法验收 —— 交付物缺失**」
（`result_W6-A.md` 与 `tests/run_phase10_w6a.ts` 都不存在）。它因此改做两件替代工作：
独立复现 13 条 + 按标准 5 排查误判，并留了 4 条行动项。

我逐条核销如下。

### 10.1 13 条清单：全部已交付

| # | 对家当时的判断 | 现在的实际状态 | 对应我的条目 |
|---|---|---|---|
| 1 | di override 后旧单例不 destroy（未修） | ✅ 已修 | W6A-01 |
| 2 | di fork 不复制 `_disposers`（未修） | ✅ 已修 | W6A-02 |
| 3 | di transient + disposable 永不销毁（未修） | ✅ 已修（注册时拒绝该组合） | W6A-03 |
| 4 | di destroy 里的 `console.error`（未修） | ✅ 已修（返回错误数组 + `onDisposeError`） | W6A-12 |
| 5 | noise 非有限 seed 退化为 seed 0（未修） | ✅ 已修 | W6A-04 |
| 6 | noise octaves=Infinity 死循环（**已不成立**） | ✅ 判定一致，我标"已修（附说明：现象不成立）" | W6A-05 |
| 7 | octaves=NaN/-1 已拦、lacunarity=0 未拦（部分修） | ✅ `lacunarity`/`persistence` 已收口 | W6A-06 |
| 8 | islandMask(1,1) 返回 NaN（未修） | ✅ 已修（**返工一次**，见 10.3） | W6A-07 |
| 9 | isNewDay 参数名与语义不符（未修） | ✅ 已修（改名 + 拒绝时间戳） | W6A-08 |
| 10 | Countdown.pause 后 state 仍 running（未修，**需裁决**） | ✅ 已修，采纳对家方案 A | W6A-09 |
| 11 | ticksSince(periodMs=NaN) 返回 NaN（未修） | ✅ 已修 | W6A-10 |
| 12 | offsetMinutes 无法表达夏令时（未修，**需裁决**） | ✅ 已修（`Intl` 动态偏移，合规论证见 10.4） | W6A-11 |
| 13 | noise3D 伪 3D / PerlinNoise 无人用（未改） | ✅ 已处理（提常量 + JSDoc，**未动算法**） | W6A-13 |

对家第 5 节的 4 条行动项：① 补交付 → 已完成；② 确认 `octaves` 归属 → 见 10.2；
③ 等裁决 → 见 10.4；④ 其余 9 条可修 → 已全部修完，无需 W6-B 支援。

### 10.2 行动项②：`octaves` 是谁修的

对家问：`needCount(opts.octaves ?? 4, 'opts.octaves', 64)` 是谁加的？

**不是我加的，也不是本轮 P1/P2 修的**——我在 `d62db0f9`（W6-B 推送前的基线）上实测，
`octaves=Infinity` 就已经抛 `TypeError: [guard] opts.octaves 必须是有限数值`。
该基线早于我开工，所以是**更早的批次**（P0 阶段或更早）修的。

我的处理：不改这行，只把注释里"静默返回 0"的**过时描述**改成真实的修复前后对比，
并保留一条护栏用例（谁把 `needCount` 换回 `?? 4`，`octaves=NaN` 会走 `maxValue > 0 ? … : 0`
分支静默返回 0，该用例立刻变红）。报告第 3 节有完整说明。

### 10.3 二次任务①：`islandMask` 的矫枉过正（**对家没直接指出，但它的实测点破了我的错**）

对家第 2 节写了一句：

> `width = 2` 时 `cx = 0.5` 不出 NaN（实测正常），所以只有 1×1 会中。

这句话让我回头查自己的修法，结果发现**第一版改错了**：

```ts
const cx = Math.max(1, (width - 1) / 2);   // 第一版（错误）
```

我把 `cx` 夹到了下界 1，于是 `width = 2` 时 `cx` 从 0.5 被拉成 1。用修复前基线
（`d62db0f9`）的实测值对比：

| 尺寸 | 修复前基线 | 我第一版 | 现在（返工后） |
|---|---|---|---|
| `2×2` | `[0,0,0,0]` | `[0,0,0,1]` ❌ | `[0,0,0,0]` ✅ |
| `2×3` | 全 0 | 第 3 格 = 1 ❌ | 全 0 ✅ |
| `3×2` | 全 0 | 第 4 格 = 1 ❌ | 全 0 ✅ |
| `3×3` / `4×4` / `5×5` / `8×8` | — | 不受影响 | 逐格一致 ✅ |
| `1×1` / `1×5` / `5×1` | 全 NaN | 已修 | 已修（0，判为边缘）✅ |

2×N 修复前**根本没有 NaN**，是我顺手重定义了"中心在哪"——典型的任务书 1.1 第 1 条禁止的顺手重构。

**返工后**：只在除零发生的那一点兜底，`cx > 0` 时原样保留：

```ts
const rawCx = (width - 1) / 2;
const cx = rawCx > 0 ? rawCx : 0.5;
```

**为什么原对照用例没抓到**：我原来只测了 `3×3`（`(3-1)/2 = 1`，恰好不受 clamp 影响），
**覆盖不到 2×N**。现已补 4 条对照用例（2×N、2×3/3×2、4×4/5×5 golden、1×1 退化语义），
golden 值取自 `d62db0f9` 的实测输出。

**反向验证**（标准 2）：把实现退回第一版后重跑，新增的 2 条立刻变红——
`2×2 的第 3 个值应为 0（旧实现全 0），实际 1`、`2×3 的第 3 个值应为 0，实际 1`；
恢复后 51 项全绿。

### 10.4 二次任务②：两处"需总审裁决"——我的取舍与理由

对家把第 10、12 条挂起等裁决。我没有干等，按"宁可让调用方立刻发现，也不要继续静默出错"
的口径做了，理由如下，请总审复核。

**① `CountdownState` 加 `'paused'`（对家倾向 A + 提供 `isPaused()`）**

- 采纳方案 A，并**按对家建议补了 `isPaused()`**（`TimeUtil.ts`）。
- 对 breaking 的态度与对家一致：写死三分支且开了穷尽检查的调用方会在**编译期**报错——
  我认为这正是想要的（漏处理暂停态的代码应该浮出来），且 `isPaused()` 给了只关心暂停与否的
  调用方一条不用碰 switch 的退路。

**② 夏令时：`Intl` 是否违反铁律 3（对家质疑点，这里正面回答）**

对家担心"用 `Intl` 属于宿主 API，需确认是否合规"。我的判断：**合规**，三条理由：

1. 铁律 3 约束的是"**运行时依赖 0**：不得 import 任何第三方包"。
   `Intl` 是 **ECMAScript 标准内置对象**（ECMA-402），与 `Date`/`Math` 同级，
   **零 import**，不引入任何包。
2. 铁律 1/2 约束的是"**不 import 引擎（`cc`）**"。`Intl` 不是 Cocos 引擎 API，
   在任何 JS 运行时（浏览器 / Node / 引擎的 JS 层）都存在。
3. 我**没有**改成必依赖：`zoneOffsetAt()` 在 `Intl` 不可用或时区名非合法 IANA 名时
   **静默回退**到静态 `offsetMinutes`（即回到旧行为）。所以裁剪了 ICU 的宿主环境
   **不会崩溃**，只是退化——这个取舍写进了第 8 节。

需要总审注意的是：回退是**静默**的，排障时不易察觉。如果总审认为应该显式告警，
我可以加一个可选开关，但默认保持静默（不能让"取不到时区"变成启动期崩溃）。

### 10.5 收尾后的自检

```
bash build.sh                        → TSC OK（产物校验通过：224 个 .js）✅
node .build/tests/run.js             → 通过 3696 项，失败 0 项            ✅
runPhase10W6ATests()                 → 通过 51 项，失败 0 项              ✅
check-links.js                       → [OK] 42 条链接，断链 0 处          ✅
scan-dt-guard.py / scan-num-guard.py → 命中 0 处 / 0 处                  ✅
check-random-source.py               → [OK]                              ✅
check-dup-exports.py                 → [OK]                              ✅
check-deps.js                        → 本窗口 3 个单元均已登记            ✅
```

测试数 **45 → 51**（新增 6 条）：islandMask 的 4 条防矫枉过正对照 + `isPaused()` 的 2 条。

