# 验收报告 · W6-B 验收 W6-A

> 被验收窗口：**W6-A**（单元 `di` / `noise` / `timeutil`，13 条 = P1 11 + P2 2）
> 任务书：`audit/handoff_W6-A.md`　交付报告：`audit/result_W6-A.md`
> 交付物：`tests/run_phase10_w6a.ts`（490 行，导出 `runPhase10W6ATests()`，45 项）
> 验收依据：`audit/review_B.md` 五条硬标准
> 验收时间基准：远程 `main` HEAD = `6b1c1babe1`（W6-A 的修复提交为 `52b0415e2a`，其父提交 `ac0ef30909` 即 W6-A 开工前基线）

---

## 0. 我做了什么（验收方式）

上一版这份报告写的是"无法验收 —— 交付物缺失"。**W6-A 现在已交付**，本报告全部推翻重写。
我没有采用"看代码觉得对"的方式，而是做了三件独立取证：

| # | 手段 | 说明 |
|---|---|---|
| ① | **回退实验（在独立目录）** | 把 `di/DIContainer.ts`、`noise/Noise.ts`、`timeutil/TimeUtil.ts` 三个文件换成**开工前基线 `ac0ef30909`** 的版本，**保留 W6-A 的新版测试**原样跑一遍。全程在独立目录 `/data/workspace/rb/` 进行，**未碰主工作目录的 `.build/`**，规避 `review_B.md` 标准 2 明令禁止的"回退旧代码污染产物"风险 |
| ② | **独立只读取数探针（新旧对照）** | 自写脚本 `probe_w6a.js`，20 组公开 API 调用，分别在「旧源码产物」和「当前 main 产物」上跑同一组输入，输出逐行对照 |
| ③ | **全库回归 + 6 个校验脚本** | 在完整仓库副本上 `bash build.sh` 后跑全量与 6 个脚本 |

**验收过程中未改动 W6-A 的任何代码**（发现的问题只写进本报告）。

---

## 1. 结论

## **有条件通过**

| 项 | 结果 |
|---|---|
| 13 条清单 | **12 条已修**（11 P1 + 1 P2），**1 条判定"现象不成立"且证据充分**（W6A-05） |
| 回退实验 | 45 项在旧源码上 **通过 23 / 失败 22**；其中 19 条"⚠️ 回归用例"在修复前**确实会红** |
| 对照用例 | 22 条 ✓ 用例全部是"合法输入不受影响"的反向断言，逐条读过 |
| 顺手重构 | 未发现超出任务书范围的改动（详见 §3.4） |
| 误判设计 | 未发现。`PerlinNoise` 没删、伪 3D 没改、相切/单位元类陷阱本批不涉及 |

**条件（1 条，必修）**：`timeutil/README.md` 有 **4 处**仍在描述被本次修复推翻的行为
（最关键的一处是白纸黑字写"没有 `'paused'` 状态……**别指望 `state()`**"，而修复后 `state()` 恰恰会返回 `'paused'`）。
按本库自己的口径——**"文档与实现不一致默认判 P1""写错的文档比没文档更糟"**——这条必须补，
否则下一个人读到 README 会继续自己维护 `paused` 标记，等于修复白做。详见 §4.1。

另有 1 项**需总审裁决**（`fork` 继承销毁责任后引出的新边界，§4.2）与 3 项建议补（§4.3~4.5）。

---

## 2. 逐条验收

判定符号：✅ 通过 / ⚠️ 有保留（已在备注说明）/ ❌ 不通过

| 条目 | 单元 | ①复现 | ②测试有效 | ③对照用例 | ④无顺手重构 | ⑤未误判设计 | 备注 |
|---|---|---|---|---|---|---|---|
| W6A-01 | di · override 覆盖后旧实例不销毁 | ✅ | ✅ | ✅ | ✅ | ✅ | 探针：旧 **10** → 新 **11** |
| W6A-02 | di · fork 不继承销毁责任 | ✅ | ✅ | ✅ | ✅ | ✅ | 引入新边界，见 §4.2 |
| W6A-03 | di · disposable + transient 静默失效 | ✅ | ✅ | ✅ | ✅ | ✅ | 改抛错属 breaking，已报总审，我认可其取舍 |
| W6A-04 | noise · 非有限 seed 塌成 0 | ✅ | ✅ | ✅ | ✅ | ✅ | 四处收口在 `mulberry32` 一处 |
| W6A-05 | noise · `octaves=Infinity` 死循环 | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | **现象不成立**，见 §3.1 |
| W6A-06 | noise · lacunarity / persistence 无收口 | ✅ | ✅ | ✅ | ✅ | ✅ | 清单里三条并列，实测只有后两条是活口 |
| W6A-07 | noise · `islandMask(1,1)` 返回 NaN | ✅ | ✅ | ✅ | ✅ | ✅ | 旧 `NaN` → 新 `0` |
| W6A-08 | timeutil · `isNewDay` 传时间戳恒 false | ✅ | ✅ | ✅ | ✅ | ✅ | 秒级时间戳仍漏，见 §4.3 |
| W6A-09 | timeutil · 暂停后 `state()` 仍 running | ✅ | ✅ | ✅ | ✅ | ✅ | **README 未同步 → 条件项**，见 §4.1 |
| W6A-10 | timeutil · `ticksSince(NaN)` 返回 NaN | ✅ | ✅ | ✅ | ✅ | ✅ | 用例前缀瑕疵，见 §4.5 |
| W6A-11 | timeutil · 固定偏移无法表达夏令时 | ✅ | ✅ | ✅ | ✅ | ✅ | 见 §3.2 的实测对照 |
| W6A-12 | di · `destroy()` 里的 `console.error`（P2） | ✅ | ✅ | ✅ | ✅ | ✅ | 旧 1 次 → 新 0 次，错误回到返回值 |
| W6A-13 | noise · noise3D 伪 3D / PerlinNoise（P2） | ✅ | ⚠️ | ✅ | ✅ | ✅ | 记录性断言，非回归，见 §3.3 |

---

## 3. 几条需要展开说明的

### 3.1 W6A-05「`octaves=Infinity` 死循环」——我在两条基线上都复跑过，现象确实不成立

清单原文写"实测挂起（`timeout 6`）"。我在 **W6-A 开工前基线 `ac0ef30909`** 上直接跑：

```
fbm2D({noise2D:()=>1}, 1, 1, {octaves: Infinity})
  → THROW TypeError: [guard] opts.octaves 必须是有限数值，实际 Infinity（number）
  耗时 0 ms        ← 不是挂起
fbm2D(..., {octaves: NaN}) → 同样抛 TypeError，耗时 0 ms
```

结论与 W6-A 一致：`needCount(opts.octaves ?? 4, 'opts.octaves', 64)` 早就拦住了，
**不是没修，是修过了**（函数里"⚠️ octaves 必须有上界"那段注释就是当时的修复记录）。

**标准 2 怎么判**：这两条用例（第 250、265 行）在旧源码上**照样通过**——它们不是"修复前会失败"的回归用例，
而是**护栏/证据用例**：将来谁把 `needCount` 换回 `?? 4`，它们立刻变红。
W6-A 在文件头第 26~29 行已明确写出这层意图，**没有冒充回归用例**。
扣分点在于它沿用了 `⚠️` 前缀（本文件约定 `⚠️` = 修复前必然失败），与 W6A-10 那条是同类小瑕疵，见 §4.5。

**标准 4 怎么判**：它**没有改这一行**，只改了注释 + 加护栏。这个处理我认可——
比"为了让清单对上而动一行"更诚实。

### 3.2 独立探针的前后对照（这是我自己跑的，不是抄它的）

`probe_w6a.js` 在「旧源码产物 `rb/rbbuild`」与「当前 main 产物 `full2/.build`」上跑同一组输入：

| 探针 | 旧（基线 `ac0ef30909`） | 新（W6-A 修复后） |
|---|---|---|
| override 后销毁计数 | **10** | **11** |
| fork 子容器销毁计数 | **0** | **1** |
| `disposable`+`transient` | 不抛错，`destroy()` 返回 `undefined` | 抛 `Error: [DI] disposable("t") 不支持 lifetime:'transient'` |
| 销毁抛错时 `console.error` | **1 次**，返回值 `undefined` | **0 次**，返回值 `["[DI] 销毁 \"bad\" 出错：boom"]` |
| `Noise(NaN)` vs `Noise(0)` | 完全相同（`-0.18010876423407166`） | 抛 `TypeError: [guard] seed 必须是有限数值` |
| `ValueNoise(NaN)` vs seed 0 | 相同（`0.3038572999969791`） | 抛 TypeError |
| `fbm` lacunarity=0 vs 1 | `0.18503969…` ≠ `0.34694942…`（退化） | 两者相等（已夹到下界 1） |
| `fbm` persistence=NaN | **0** | `0.2955543045618454` |
| `fbm` persistence=-3 | **0** | `0.34694942728486156` |
| `islandMask(1,1)[0]` | **NaN** | **0** |
| `islandMask(3,3)`（对照） | `[0,0,0,0,1,0,0,0,0]` | 完全相同 ✅ |
| `isNewDay(now+1天, 时间戳)` | **false**（隔了一整天却说不是新的一天） | 抛 `RangeError`，错误信息里给出正确写法 |
| `isNewDay` 传 `dayIndex`（对照） | 同一天 false / 第二天 true | 完全相同 ✅ |
| `pause` 后 `state(500)` | **'running'**（`remaining` 却已冻结成 900） | **'paused'**（`remaining` 仍 900） |
| `ticksSince(0,1000,NaN)` | **NaN**，不报错 | 抛 `Error: [TimeUtil] periodMs 必须为正` |
| `ticksSince(0,1000,0)`（对照） | 抛错 | 抛错（原行为保持）✅ |
| 洛杉矶 7/1 日界 | `2024-06-30T08:00:00Z` | **`2024-06-30T07:00:00Z`**（PDT，正确） |
| 柏林 7/1 日界 | `2024-06-30T23:00:00Z` | **`2024-06-30T22:00:00Z`**（CEST，正确） |
| 洛杉矶 1/15（对照·冬令时） | `2024-01-14T08:00:00Z` | 完全相同 ✅ |
| 东八区 6/15（对照·无夏令时） | `2024-06-14T16:00:00Z` | 完全相同 ✅ |

**13 条全部有我自己的复现输出**，没有一条是靠"读代码觉得应该是这样"。

### 3.3 标准 2 的量化：45 项在修复前到底红几条

回退实验原始结果（`/data/workspace/rb/`，旧源码 + 新测试）：

```
通过 23 项，失败 22 项
```

拆开看：

- 23 条 `⚠️` 回归用例 → **19 条在旧源码上失败**（有效）
- 剩下 4 条在旧源码上也通过，逐条核对后**都不是"测试无效"**：
  - W6A-05 的 2 条：护栏/证据用例（§3.1）
  - W6A-13 的第 352 行：`noise3D` 各向异性是**记录性断言**，锁的是"注释里描述的现象仍然成立"，
    一旦换成真 3D 单纯形就该变红去提醒人改注释。意图写在用例注释里，**认可**
  - W6A-10 的第 441 行：`⚠️ 0 与负数仍然抛错（原行为保持）`——断言的本来就是修复前后都成立的行为，
    **前缀用错了**（§4.5）
- 22 条 `✓` 对照用例 → 在旧源码上全部通过，符合"正常输入不受影响"的预期；
  其中 3 条（W6A-01 的 `destroy().length`、W6A-12 的两条）在旧源码上反而**失败**，
  原因是旧 `destroy()` 返回 `void`——这属于新增 API 的必然结果，不是矫枉过正

**没有发现"喂了不会触发 bug 的输入"的假用例。**

### 3.4 标准 4：有没有顺手重构

逐文件核过 diff（旧 3 文件 vs 新 3 文件，共 +458 / -65 行）：

- `di/DIContainer.ts`：新增 `DIContainerOptions`、`_disposeFns` Map、`_disposeKey()`、`fork` 复制销毁函数、
  `disposable` 拒绝 transient、`destroy()` 改返回 `string[]`。**全部对应清单条目**，无额外改名/结构调整
- `noise/Noise.ts`：`mulberry32` 的 seed 守卫、`lacunarity`/`persistence`/`amplitude`/`frequency` 收口、
  `islandMask` 的 `cx`/`cy` 下限、`37.7` → `NOISE3D_SLICE_SPACING`、`GRAD3` → 模块级 `GRAD2`
  —— **唯一像重构的是合并梯度表**，但任务书 P2 原文就写着"梯度表合并为模块级常量"，
  且两份表逐字相同（我核对过），**在范围内，不判违规**
- `timeutil/TimeUtil.ts`：新增 `zoneOffsetAt()`、`startOfDay` 二次收敛、`dayIndex` 走真实偏移、
  `isNewDay` 改名 + 两道守卫、`ticksSince` 肯定式、`CountdownState` 加 `'paused'`。**全部对应清单条目**

`_core/` 一行未动；`tests/run.ts` 未动（16 个窗口的 phase10 测试目前都还没注册，符合并行纪律）；
`PerlinNoise` 虽然内部无人使用，但它是 export 的公开 API，**只补说明没删**——正确。

### 3.5 标准 5：有没有把"设计如此"误判成 bug

三个单元的原代码里，被改动的位置**都没有"这是故意的"这类注释**被无视的情况：

- 伪 3D `noise3D`：W6-A **没有**去改成真 3D（那才是误判），只把魔法数 37.7 提成常量 + 写清各向异性，
  并用实测数据（沿 x 变化 0.198，沿 z 变化 1.005，差 5 倍）把现象钉住。我复核了新旧两版的数值
  **`alongX=0.197788 / alongZ=1.004973` 完全一致**，证明行为没被改坏
- `PerlinNoise`：保留导出并说明"格子感本身是一种画风需求"，没删
- `Countdown` 的 'paused'：单元 README 原本确实把它写成"设计如此"（§4.1），
  但 W6-A **没有自己拍板**，在 `result_W6-A.md` §5 明确标了需总审裁决并列出两种选择的代价——**处理正确**

---

## 4. 发现的问题

### 4.1 🔴 必修（通过的条件）：`timeutil/README.md` 有 4 处与实现不一致

修复后代码已经变了，README 还停在修复前。**这是本库自己定义的最高优先级的文档缺陷**——
`audit/README.md` 第 62~63 行写着："文档与实现不一致 → 默认判 P1，因为写错的文档比没文档更糟"。

| 位置 | README 现状 | 修复后的实际行为 |
|---|---|---|
| `timeutil/README.md:115` | `CountdownState` = `'waiting'` / `'running'` / `'finished'`（**注意没有 paused**） | 现在是四态，含 `'paused'` |
| `timeutil/README.md:130`（状态机表） | `state(now)` → `'waiting'` / `'running'` / `'finished'` | 暂停中返回 `'paused'` |
| `timeutil/README.md:137-153` | 整段 `⚠️ 没有 'paused' 状态` + 一张"pause @10s → state=running"的实测表 + 结论"**得自己维护一个 paused 标记，别指望 `state()`**" | 这段现在是错的，且**会阻止使用者去用新加的 `paused`** |
| `timeutil/README.md:46` | `isNewDay(now, lastSeen, zone)` | 参数已改名 `lastDayIndex`，传时间戳会抛 `RangeError` |

**建议改法**：把 137~153 那段连同实测表一起更新成四态（pause 行改成 `state=paused`），
并补一句"传毫秒时间戳会抛错，正确写法 `isNewDay(now, dayIndex(lastLoginAt, zone), zone)`"。
`timeutil` 是 W6-A 自己的单元，改自己的单元 README 不越界。

### 4.2 🟡 需总审裁决：`fork` 继承销毁责任后，父容器已解析的实例会被子容器连带销毁

这是 W6A-02 修复**引出的新边界**，W6-A 的用例没覆盖（它的用例里父容器从未 `get()` 过）。

复现（只读脚本，未改任何代码）：

```js
const p = new DIContainer('p');
p.disposable('svc', () => ({ destroy() { destroyed += 1; } }));
const first = p.get('svc');        // ← 父容器先解析
const child = p.fork('child');
const fromChild = child.get('svc');
// 子容器拿到的是父容器那个实例吗 = true
child.destroy();
// 销毁次数 = 1
const again = p.get('svc');
// 父容器再次 get 拿到新实例吗 = false   ← 拿到的是**已销毁**的那个
```

**为什么会这样**：`fork()` 同时复制了 `_singletons`（父子共享同一实例引用）和 `_disposeFns`（新增）。
所以"子容器销毁"会销毁一个父容器仍在使用的实例，而父容器的 `_singletons` 里还留着它的引用，
后续 `get()` 拿到的是已销毁对象，且不会重建。

- **修复前**：这个场景是"泄漏"（子容器啥也不销毁）——也就是 W6A-02 要修的那个洞
- **修复后**：洞补上了，但父子共享实例这条路径变成"误伤"

`di/README.md:88` 把 `fork()` 称为"**测试里换依赖的正确姿势**"，
而测试里恰好常见"先建好 app 容器（已解析服务）→ 每个用例 `fork()` → 用完 `child.destroy()`"的写法，
这条路径是**会被踩到的**。

两种修法（我不拍板，请总审选）：

| 方案 | 做法 | 代价 |
|---|---|---|
| A | `fork()` 只复制 `_regs`，**不复制**父容器已解析的 `_singletons`（子容器按需自建） | 语义最干净："子容器只销毁自己创建的"。但改变了 `fork` 的既有行为——现在 `fork` 后子容器能直接拿到父容器已建好的单例，有些代码可能依赖这点 |
| B | 保持复制，但给"从父容器继承来的实例"打标记，销毁时跳过 | 行为兼容，但要多维护一个来源标记，DI 内部复杂度上升 |

### 4.3 🟢 建议补：`isNewDay` 的误用守卫挡不住秒级时间戳

`TIMESTAMP_LIKE_MIN = 1e11` 是按毫秒量级定的。实测：

```js
const now = Date.UTC(2024, 0, 1, 12, 0, 0);
const sec = Math.floor(now / 1000);              // 1704110400，约 1.7e9
isNewDay(now + DAY_MS, sec, Zones.CN)  →  false   // 静默，不抛错
```

秒级时间戳（不少后端 API 返回秒）比 1e11 小两个数量级，会**静默穿过守卫**，
表现与修复前一模一样：每日任务永不刷新，且不报错。

这条不算 W6-A 的过失（它挡住了清单指出的毫秒误用），但既然本条的目的就是"不让静默 false 发生"，
建议顺手把阈值下探一档（例如 `1e9`，即 2001 年之后的秒级时间戳也能拦），
或对该区间的值给出 warning。请 W6-A 补或总审裁决。

### 4.4 🟢 建议补：`di` / `noise` 两个单元 README 未同步新的抛错行为

| 单元 | 新增行为 | README 现状 |
|---|---|---|
| `di` | `destroy()` 返回 `string[]`；新增 `onDisposeError` 选项 | `di/README.md:67,104` 仍写"倒序调用 disposer 后清空"，未提返回值与钩子 |
| `di` | `disposable(..., {lifetime:'transient'})` 直接抛错 | `di/README.md:59` 只说"注册带 `destroy()` 的单例"，未说非 singleton 会被拒 |
| `noise` | 非有限 seed 抛 `TypeError` | 无说明（这是个 breaking，原来 `new Noise(NaN)` 是能跑的） |
| `noise` | `lacunarity ∈ [1,16]`、`persistence ∈ [0,1]` 夹紧 | `noise/README.md:48-50` 只有建议值，未说越界会被夹 |
| `timeutil` | `zoneOffsetAt` 依赖 `Intl`，ICU 缺失时**静默回退**到固定偏移 | 无说明（W6-A 已写进 `result_W6-A.md` §8，但那是审计报告，使用者看不到） |

最后一行我认为**值得写进单元 README**：静默回退意味着"在某些宿主环境里夏令时修复不生效，且没有任何提示"，
排障时会非常困惑。

### 4.5 🟢 小瑕疵：两条用例的 `⚠️` 前缀与语义不符

本文件约定 `⚠️` = "修复前必然失败的回归用例"。但：

- `tests/run_phase10_w6a.ts:441` `⚠️ 0 与负数仍然抛错（原行为保持）` —— 断言的是**修复前后都成立**的行为，
  回退实验里它确实通过。应改成 `✓`（它其实是很好的对照用例）
- `tests/run_phase10_w6a.ts:250,265`（W6A-05）—— 是护栏用例，文件头已说明，但前缀同样是 `⚠️`

不改代码，只影响"数一下 ⚠️ 有几条"这种粗读方式，建议下一轮统一。

### 4.6 ⚪ 非本窗口（记录，供总审对账）

- **全量回归失败 1 项**：`第九批 › BinarySerializer › ⚠️ float 会 clamp 而不是溢出回绕`
  —— 失败点是 `tests/run_batch10.ts:766` 的**旧断言**没跟上 `binary/BinarySerializer.ts:218` 的新抛错行为。
  `binary` 属 **W8-B** 窗口，与 W6-A 无关（W6-A 在 `result_W6-A.md` §9 已主动指出，未越界改，处理正确）
- **`check-deps.js` 剩 8 条未登记**（`i18n`/`blessing`/`curse`/`rarity`/`achievement`/`rebind`/`gameflow`/`accessibility` → `_core`）
  —— 全部是**其他窗口**的单元，W6-A 的 3 个单元均已登记（`di`/`noise`/`timeutil` → `_core` 都在列表里）。
  建议总审统一 `node scripts/check-deps.js --fix`
- **根 `README.md` 仍写 3,695 项**，实测 3,696（另 W6-A 的 45 项按纪律未注册，合并后需总审统一更新）

---

## 5. 附：全库校验结果

在完整仓库副本（`main` HEAD `6b1c1babe1`）上实测：

```
bash build.sh                  → TSC OK（产物校验通过：227 个 .js）
node .build/tests/run.js       → 通过 3696 项，失败 1 项（binary，见 §4.6）
runPhase10W6ATests()（独立 runner）→ 通过 45 项，失败 0 项
```

回退实验（旧源码 + 新测试，独立目录）：

```
通过 23 项，失败 22 项
→ 19 条 ⚠️ 回归用例在修复前确实会红
```

六个校验脚本：

```
node scripts/check-deps.js        → [1]~[4] 全过；[5] 剩 8 条未登记（其他窗口单元，§4.6）
node scripts/check-links.js       → [OK] 内部链接 42 条，断链 0 处（扫描 191 个 .md）
python3 scripts/scan-dt-guard.py  → 扫描 146 个文件，命中 0 处
python3 scripts/scan-num-guard.py → 扫描 0 处命中
python3 scripts/check-random-source.py → [OK] 未发现自建随机源
python3 scripts/check-dup-exports.py   → [OK] 无待处理的冲突
```

受影响示例均可运行（未报错、正常收尾）：

```
node .build/examples/batch4-usage.js   → "容器销毁，所有 disposable 服务已清理" ✅
node .build/examples/batch13-usage.js  → 正常结束 ✅
```

---

## 6. 一句话给 W6-A

修得扎实：13 条里 12 条我拿到了"修复前 vs 修复后"的实测差值，45 项用例在旧代码上红掉 22 项，
对照用例把合法输入都守住了，没顺手重构、没把设计当 bug。

**唯一卡住通过的是文档**：`timeutil/README.md` 还在教使用者"别指望 `state()`"，
而这正是你这次修好的东西——把它改掉（§4.1 的 4 处），这份验收就是**通过**。
§4.2 的 `fork` 边界已上报总审，不阻塞你。
