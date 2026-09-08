# 验收报告 · W5-A 验收 W5-B

> 验收对象：`audit/result_W5-B.md`（14 条）+ `tests/run_phase10_w5b.ts`（53 项）+ 7 个单元源码改动
> 验收基准：远端 main @ `8683604`（含 W6-A 等后续提交）
> 反向验证基准：`81f05b0` = W5-B 首个提交 `bad1537e` 的父提交（**修复前**）

⚠️ **本报告第二版**。第一版误判"W5-B 尚未交付"——我在陈旧的本地副本上 `ls audit/`。
第二版纠正了交付状态但反向验证是采信对方结论。**本版是完整独立验收：
两个副本、两套构建、报告里每条"复现输出"都由我自己重跑一遍。**

---

## 结论

**有条件通过。**

| | 结果 |
|---|---|
| 标准 1 · 是否真的复现过 | ✅ **14 条全部独立复现成功**，报告里每个数字我这边都对得上 |
| 标准 2 · 测试是否真的会失败 | ✅ 反向验证成立（我独立跑出 25 过 / **28 失败**）。但 ⚠️ 报告 §3 的"原样编译运行"**做不到**，见 §2 |
| 标准 3 · 对照用例 | ✅ 16 条，14 个分组每组都有 |
| 标准 4 · 无顺手重构 | ⚠️ 2 处算法改写需总审视（P1-2 / P2-5），不判违规但要看一眼 |
| 标准 5 · 未误判设计 | ✅ 两条"只改文档"（popup / load progress）判断准确且处理得当 |
| **🔴 返工项** | **1 条：P2-4 · input 的 `window` setter**（实质问题） |

---

## §1 标准 1 · 逐条独立复现（我在 `81f05b0` 修复前代码上跑的实测值）

下表左列是**报告声称**的修复前输出，右列是**我自己跑出来**的。
（JSON 里 `null` 即 NaN——`JSON.stringify(NaN)` 的结果。）

| 条目 | 报告声称（修复前） | 我独立复现 | |
|---|---|---|---|
| P1-1 | `fontScale=NaN` 不抛错，`fontSize(16)=NaN` | `{"fontScale":null,"fontSize16":null}` 未抛错 | ✅ |
| P1-1 | 构造 `shakeScale:5` 得 **5**，`setShakeScale(5)` 得 **1** | `{"ctor":5,"setter":1}` | ✅ |
| P1-1 | `longPressMs:NaN` 存 NaN | `null` | ✅ |
| P1-2 | `variance(1e9+7,+9,+11)` = **0**（精确 4） | `0` | ✅ |
| P1-2 | `variance(1e8+1..+5)` = **2**（精确 2.5） | `2` | ✅ |
| P1-3 | `update(Infinity)` → `activeCount` **1 → 0** | `{"before":1,"after":0}` | ✅ |
| P1-4 | `strategy='average'` → `base=undefined`、`effective=NaN` | `base` 字段缺失（undefined）、`effective:null` | ✅ |
| P1-5 | 一人 rating=NaN → base/effective/spread 全 NaN | 全 `null` | ✅ |
| P1-5 | `weightBase=NaN` → NaN | `null` | ✅ |
| P1-5 | `validateParty` 放行含 NaN 队伍 | `{"ok":true}` | ✅ |
| P1-6 | order=1/NaN/3 → `highest.id=a`、`all=a,b,c` | `{"highest":"a","all":"a,b,c"}` | ✅ |
| P1-6 | （对方更正）`isRarer('c','a')`=true、`best(['a','c'])`='c' 其实是**对的** | `{"isRarer_c_a":true,"best_ac":"c"}` | ✅ 更正属实 |
| P1-7 | 按秒传 `1/60` → **36000 帧**；按毫秒 `16.67` → **36 帧** | `36000` / `36` | ✅ |
| P1-7 | 参数名是 `dt` | `"tick(dt) {\n        i"` | ✅ |
| P2-2 | `treatmentPercent=NaN` → **0/200** | `0` | ✅ |
| P2-2 | `twoProportionZTest` 的 `p` = NaN | `null` | ✅ |
| P2-2 | `recordValue(NaN)` → `n` 仍 +1、`sum` 变 NaN | `{"n":1,"sum":null}` | ✅ |
| P2-2 | `requiredSampleSize(NaN, 0.1)` 返回 NaN 不抛错 | `null` | ✅ |
| P2-3 | `popup` 40 帧采样恒定 **0.50** | `[0.5]`（40 帧去重后只有一个值） | ✅ |
| P2-3 | `maxIntensity=NaN` → `shake`/`flash` = NaN | `{"shake":null,"flash":null}` | ✅ |
| P2-4 | `maxQueue=NaN` → 连按 50 次后长度 **50** | `50` | ✅ |
| P2-4 | `window=NaN` 存 NaN；setter 传 NaN → NaN | `null` / `null` | ✅ |
| P2-5 | `suggestedWindow(team,-100)` = **-100** | `-100` | ✅ |
| P2-6 | `tally(['__proto__','__proto__','b'])` = **`{"b":1}`** | `{"b":1}` | ✅ |

**24 项声称值，24 项对上，零出入。**

特别值得肯定的是 P1-6：原任务书写"highest/lowest/compare/best 全错"，
对方实测发现只有涉及 NaN 项的比较才错（`isRarer('c','a')` 和 `best(['a','c'])`
都绕开了那个 NaN 项，结果是对的），并主动更正了上游结论。**没有照抄报告。**

---

## §2 标准 2 · 反向验证：成立，但报告 §3 的措辞会让总审踩坑

### 我独立跑的结果

```
副本：81f05b0（W5-B 首个提交的父提交）+ 拷入 run_phase10_w5b.ts
结果：通过 25 项，失败 28 项
```

对方声称 **26 过 / 27 失败**，我跑出 **25 过 / 28 失败**，**差 1 项**。
差异大概率来自 base 选取（我用 `bad1537e` 的 parent，他们可能另有副本），
不影响结论——**28 条失败与我上表 24 项复现完全对应**。

### ⚠️ 但"原样编译运行"做不到

对方报告 §3 写：

> 把 `tests/run_phase10_w5b.ts` 原样放到**未修改的原始仓库**上编译运行

我实测：把测试文件拷进 `81f05b0` 后跑 `bash build.sh` 会**直接失败退出**：

```
TSC 失败:
tests/run_phase10_w5b.ts(257,23): error TS2367: ... 'PartyViolation' and '"rating"' have no overlap
tests/run_phase10_w5b.ts(407,9): error TS2339: Property 'destroy' does not exist on type 'Accessibility'
tests/run_phase10_w5b.ts(477,9): error TS2339: Property 'destroy' does not exist on type 'Experiment'
tests/run_phase10_w5b.ts(542,10): error TS2339: Property 'destroy' does not exist on type 'HitFeedback'
tests/run_phase10_w5b.ts(704,10): error TS2339: Property 'destroy' does not exist on type 'SceneRouter'
tests/run_phase10_w5b.ts(713,10): error TS2339: Property 'destroy' does not exist on type 'SceneRouter'
exit 1
```

`build.sh` 的逻辑是「tsc 有任何输出就 exit 1」，**不会产出 `.build/`**。
我是绕过 build.sh 直接调 `tsc`（它类型报错仍产出 js）才跑起来的。

**这不是造假，是表述不准。** 但总审若照 §3 复现会以为自己搞错了。
建议对方把 §3 改成"需绕过 build.sh 的 tsc 失败拦截（直接调 tsc 产出 js）后运行"。

### 28 条失败的分类（供总审判断"含金量"）

| 类别 | 数量 | 说明 |
|---|---|---|
| 真·缺陷复现（回退修复即失败） | **23** | 对应上表 24 项复现，是标准 2 要的那部分 |
| "新 API 不存在"导致的失败 | **5** | `a.destroy / e.destroy / fb.destroy / rt.destroy ×2` → `is not a function` |

那 5 条 `destroy` 用例严格说测的是"新增的卸载方法存在"，不是"某个缺陷已修"——
回退后它们当然失败（方法压根没有）。这不构成问题（rule5 要求有 destroy 是对的），
但总审对账时应知道这 5 条与"缺陷复现"不是一回事。

---

## §3 标准 3 · 对照用例：齐备

53 项 = **36 条回归**（`⚠️` 开头）+ **16 条对照**（`对照` 开头）+ 1 条其它。
14 个 describe 分组**每组至少 1 条对照**，无遗漏。

其中两条对照尤其到位，说明对方真的在防矫枉过正：

- P1-5 对照：显式断言 `weightBase = -1` **仍走 `den === 0` 的降级分支**（退化成等权平均）。
  负数权重是既有设计，收口只兜非有限值、不夹负数——**没有把设计当 bug 修**。
- P1-1 对照：显式断言 `fontScale = 0` **仍然抛错**，并写明"不能为了收口而把
  '传错就炸'的开发期保护变成静默夹取"。

---

## §4 标准 4 · 顺手重构：2 处需总审视（不判违规）

| 条目 | 改了什么 | 我的判断 |
|---|---|---|
| P1-2 `variance` | 从 `Σx² − n·m²` 改成"移位两遍算法"，并给 `Stats` **新增可选字段 `shift`** | **必要**。精度问题只能换算法，加字段是换算法的必然后果。但我验证过一处隐患，见 §7 建议 1 |
| P2-5 `fillFromPool` | 从"遍历取最小差"改成"先按差值排序 + 取第一个通过校验的" | 我核过**行为等价**（原算法取合法候选中 d 最小者；ES2019+ 稳定排序下新算法对并列差值选取一致），性能更好。但严格说超出了"修 NaN 传染"的必要范围——光修 NaN 只需给 `Math.abs` 兜个 `numOr`。建议对方在报告里把"这是性能改写、已证明等价"写得更醒目，别埋在注释里 |

两处都**没有**动命名、没有删"看着没用"的代码、没有碰 `_core/`。
其余 12 条改动面都在"修这一条"的范围内。

---

## §5 标准 5 · 未误判设计：两条"只改文档"都判对了

| 条目 | 对方判断 | 我的核验 |
|---|---|---|
| P2-3 `feedback.popup` 恒定 0.50 | JSDoc 写"进度 1→0"，实现是"强度"；改成真进度是 breaking，故**改文档 + 写测试钉住真实行为** | 我在修复前实测 40 帧去重后只有一个值 `[0.5]` —— 判断准确。**这条处理是教科书式的**：既不 breaking，也不放着不管，还用测试防止后人照错误文档改回去 |
| P2-7 `scenerouter` load 阶段 progress 恒 0 | 不是"进度条卡住"，是模块拿不到宿主的加载进度，属设计使然 | 修复前该用例**通过**（即修复前后都是 0）——印证了"记录真实语义"而非"修 bug"。对方如实标注了这点 |
| P1-7 毫秒单位 | 只把参数名 `dt` 改成 `dtMs`，**单位本身未改**，并上报总审裁决 | 改单位会 breaking 所有宿主。处理得当，且主动上报了分歧而非自己拍板 |

另外 P2-1 的 `shouldPlay` 合并分支：原 switch 里两组 case 返回同一个值，
对方合并成一句 —— 这是**去重**不是**改行为**（修复前后行为完全一致，修复前该用例通过），
且有注释论证"新增 EffectKind 默认关掉而非放行"。不算顺手重构。

---

## 🔴 返工项：P2-4 · `input` 的 `window` setter 兜底到 0

### 问题：同一个字段的两条路径，兜底值不一致

```ts
// input/InputBuffer.ts:127  构造函数
this._window = numOr(opts.window, 0.15);     // NaN → 0.15（文档默认值）✅

// input/InputBuffer.ts:146  setter
this._window = Math.max(0, numOr(v, 0));     // NaN → 0  ❌
```

而 `:144` 的注释白纸黑字写着：

> 先用 `numOr` 把 NaN / Infinity 兜成 0，再夹掉负数，
> **与构造函数的 `numOr(opts.window, …)` 保持同一口径。**

**注释声称同口径，实际一个是 0.15、一个是 0。**

### 这次我拿到了行为级铁证（上一版只有数值断言）

在最新 main @ `8683604` 上实测：

```
默认 window                = 0.15
构造传 NaN   → window      = 0.15        ✅ 正确
setter 传 NaN → window     = 0           ❌ 不一致

setter 传 NaN 之后：
  press('attack') → 隔一帧 consume()  = false   ← 缓冲实际不工作
对照 window=0.15：
  press('attack') → 隔一帧 consume()  = true
```

`window = 0` 的判定是 `now - t <= 0`（`InputBuffer.ts:181`），
只有"同一时间戳"成立——对"按下后下一帧再消费"这个主力用法，**它就是死的**。

所以修复前后对比：

| | 修复前 | 修复后 |
|---|---|---|
| `ib.window = NaN` | 存 NaN → `now-t <= NaN` 恒 false → **死** | 存 0 → 除同一时刻外恒 false → **还是死** |

对方的修法把 `window` 变成了可观测的有限数（这是他们明写的目标，达到了），
但**缓冲依然不工作**，而构造函数那条路径（NaN → 0.15）是对的。

### 为什么必须返工而不是"小问题"

1. **他们自己就在修这类 bug**。P1-1 里有一段很漂亮的注释批评 accessibility
   "构造传 5 生效、setter 却夹到 1——行为随调用路径变化"，
   然后在 P2-4 里把**同一个毛病**又犯了一次。
2. **测试把这个错值钉死了**。`eq(ib.window, 0)` 这条断言会成为错误兜底的护栏——
   将来谁想改成 0.15，测试先变红。
3. **这踩的是全库已知的那个坑**。我这边（W5-A / skill-queue）踩过一模一样的：
   原注释同样论证"0 = 不过期，与 `Math.max(0, …)` 语义一致"，
   实测 `waited <= 0` 只有入队那一帧成立，等于立即过期。
   我在 `audit/result_W5-A.md` §二 专门写过，可直接对照。

### 建议修法（我倾向 B）

- **A**：setter 也回落 `0.15` —— 与构造函数完全一致，最省心；
- **B**：非法值**保持旧值**（`numOr(v, this._window)`）——与我在 skill-queue 的修法一致，
  适合"窗口允许运行时热更新"的场景，一次热更传 NaN 不会把手感清空；
- **C**：拒绝赋值并抛错。

无论选哪个，请**同步改掉 `eq(ib.window, 0)`**，并补一条行为级断言：
「setter 传 NaN 之后 `press` → 隔一帧 `consume` 仍能拿到」。
只断言字段值是数值断言，断言"缓冲还能用"才是行为断言。

---

## §7 建议（非阻塞）

### 建议 1 · `Stats.shift` 的混合使用隐患（P1-2）

我在最新 main 上验证了修复后的正确性，三种常规场景**全部正确**：

```
record 三条 1e9 量级 → mean = 1000000009   variance = 4          ✅（期望 1e9+9 / 4）
小数值 1,2,3,4       → mean = 2.5          variance = 1.6667     ✅
外部字面量(无 shift) → mean = 2.5          variance = 1.6667     ✅（退化为旧写法，正确）
```

但有一个边界：`shift` 取的是**第一批的第一个样本**，
若调用方把两个不同时期/不同量级的 `Stats` 手工合并，结果会失去意义：

```
手工构造 {n:2, sum:2, sumSq:2, shift:1e9} → mean = 1000000001    ← shift 被误用
```

建议在 JSDoc / README 里补一句「**不要手工合并 Stats，请一律用 `record*` 逐条喂**」，
以及「外部构造大数量级 Stats 仍会退化到旧算法的精度问题」。
这属于"无法两全"的设计边界，写明即可，不必改代码。

### 建议 2 · 报告 §3 的反向验证步骤要写全

见 §2：请注明需绕过 `build.sh` 的 tsc 拦截，否则总审照做会以为自己搞错了。
另外把 28 条失败里"5 条是 destroy 新 API 不存在"这个分类写进报告，对账更清楚。

---

## §8 附：全库校验结果（远端 main @ `8683604` 完整副本）

```bash
bash build.sh                       # TSC OK（227 个 .js）
W5-B 53 项独立跑                     # 通过 53 项，失败 0 项 ✓
W5-A 52 项独立跑                     # 通过 52 项，失败 0 项 ✓（我的，一并确认没被后续提交破坏）
node .build/tests/run.js            # 通过 3696 项，失败 1 项
                                    #   ✗ 第九批 › BinarySerializer › ⚠️ float 会 clamp 而不是溢出回绕
                                    #   ← W8-B 修 P1-5（越界 clamp→抛错）后漏改旧测试，
                                    #     W2-A 已在提交信息里定位认领，与 W5-B、W5-A 均无关
node scripts/check-links.js         # [OK] 42 条，断链 0 处 ✓
python3 scripts/scan-dt-guard.py    # 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py   # 0 处命中 ✓
python3 scripts/check-random-source.py  # [OK] ✓
python3 scripts/check-dup-exports.py    # [OK] ✓
node scripts/check-deps.js          # ⚠️ 8 条「import 了但没登记」
```

### check-deps 的 8 条：并发覆盖，不是 W5-B 的错

当前未登记清单：`i18n / blessing / curse / rarity / achievement / rebind / gameflow / accessibility → _core`。

其中 **`rarity` 与 `accessibility` 正是 W5-B 报告 §4 声明"已追加登记"的两条**——
现在又回到未登记状态，说明有窗口在此之后推送了基于旧 base 的 `_kitmeta.json`。
我自己的 `turn → _core`（W5-A 提交 `8521b0c` 用官方 `--fix` 登记）也经历过同样的事，
后来被某个窗口的登记带上去了（现在已不在清单里），说明这个文件在被反复覆盖。

**按并行纪律我不代改别人的单元。** 请总审：
1. 统一跑一次 `node scripts/check-deps.js --fix`；
2. 提醒各窗口**推送 `_kitmeta.json` 前先 rebase 到最新 main**——
   否则这个文件会一直在"你覆盖我、我覆盖你"的循环里。

### W5-A 自身改动完好性（顺带确认）

在 `8683604` 上逐项 grep，我 W5-A 的 8 个单元改动**全部仍在**：
`fixSeconds`(BTNode) / `_nextId`(Signal) / `QUEST_STATUSES`(Quest) /
turn 的 `rng` 参数 / fsm 的 `_started` / skill-queue 的 `numOr` /
steering 的 rand 必填 / telemetry 的 `destroy`。
