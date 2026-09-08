# 交付报告 · 窗口 W5-B（第 B 组）

> 单元：accessibility / analytics / feedback / input / mmr / rarity / scenerouter
> 条目：**14**（P1 7 / P2 7）
> 基线：构建通过、**3695 项测试全绿**
> 交付：7 个单元源码改动 + `tests/run_phase10_w5b.ts`（53 项）+ `examples/accessibility-usage.ts` + 7 份 README 同步

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| P1 | 7 / 7 已修 |
| P2 | 7 / 7 已修（其中 2 条为"只改文档"，已注明理由） |
| 新增测试 | **55 项**（独立运行全绿；初版 53，收尾时补 2 条，见 §6） |
| 反向验证 | 同一份测试跑在**修复前**的源码上：**26 过 / 27 失败** |
| 全量回归 | **3696 项 / 失败 1 项**（该失败为 W8-B 遗留，与本窗口无关，见 §4） |
| 合并后预期总数 | **3750**（= 3695 + 55，见下方说明） |
| 校验脚本 | 5 项 PASS；`check-deps` 剩 6 条**均为其它窗口的单元**（见 §6.4） |
| 需总审裁决 | 1 条（scenerouter 单位是否整体改秒制） |

**"修复前会失败"不是推断**：我把 `tests/run_phase10_w5b.ts` 原样拷到未修改的原始仓库上编译运行，
得到 26 过 / 27 失败——失败明细逐条对应下面 §1/§2 的复现用例。
（原报告的"证据"是别的窗口写的，我自己重跑了一遍，其中 4 条与报告描述有出入，已逐条注明。）

> ⚠️ **给总审的对账提示**：全量回归显示 3695 而不是 3748，是因为**我没动 `tests/run.ts`**（任务书 §5.2 明令由总审统一合并）。
> 我的 53 项目前只通过独立驱动跑，未计入全量。合并后总数应为 **3695 + 53 = 3748**，
> 且应当**全绿**——如果合并后这个数字对不上或有失败项，请优先查 §1/§2 里那 2 条"只改文档"的条目是否与其他窗口的改动撞了。

---

## 1. P1 逐条

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| P1-1 | accessibility | P1 | 已修 | `new Accessibility({fontScale:NaN})` **未抛错**，`fontScale = NaN`，`fontSize(16) = NaN`；`{shakeScale:5}` 构造得 **5**，`setShakeScale(5)` 得 **1**；`{longPressMs:NaN}` 得 **NaN** | NaN 抛错；`shakeScale=5→1`、`-3→0`；`longPressMs=NaN→600`、`99999→3000` | `run_phase10_w5b.ts` › 构造与 setter 同口径 |
| P1-2 | analytics | P1 | 已修（附说明） | `variance([1e9+7,+9,+11])` = **0**（精确 4）；`variance([1e8+1..+5])` = **2**（精确 2.5） | 分别得 **4** 与 **2.5** | › variance 的两遍算法 |
| P1-3 | feedback | P1 | 已修 | `update(Infinity)` 后 `activeCount` **1 → 0**（所有打击反馈同帧消失） | `activeCount` 保持 **1** | › update 的 dt 守卫 |
| P1-4 | mmr | P1 | 已修 | `strategy='average'` → `base = undefined`、`effective = **NaN**`，**不抛错** | 抛错并列出合法取值 | › 未知 strategy 必须失败得出来 |
| P1-5 | mmr | P1 | 已修 | 一人 `rating=NaN` → `base/effective/spread` 全 **NaN**；`weightBase=NaN` → **NaN**；`validateParty` 放行含 NaN 的队伍 | 带玩家 id 抛错；`weightBase=NaN` 回落 0.7；`validateParty` 返回 `{ok:false, reason:'rating'}` | › rating 的有限性校验 |
| P1-6 | rarity | P1 | 已修（附说明） | `order` = 1/NaN/3 时 `highest.id` = **a**（应 c），`all` = **a,b,c**（未排序） | 构造即抛错 `order 必须是有限数` | › order 的有限性校验 |
| P1-7 | scenerouter | P1 | 已修（附说明 / **需总审裁决**） | `outMs=inMs=300`：按**秒**传 `1/60` → **36000 帧 ≈ 600 秒**；按**毫秒**传 `16.67` → **36 帧 ≈ 0.6 秒** | 参数改名 `tick(dtMs)` + JSDoc 首行写明单位（**单位本身未改**） | › tick 的毫秒单位 |

### P1-2 说明：报告给的"精确值"有误

报告写 `variance([1e8+1 .. 1e8+5])` 精确值为 **2**，实测该样本**样本方差（n−1）精确值是 2.5**
（总体方差 10/5 = 2）。修复前实测得 2，是"消去后恰好落在总体方差附近"，误差 20%，
并非完全抹平；真正被彻底抹平的是第二组（精确 4 → 实测 **0**）。
两条都已修到精确值，但报告里的"精确值 2"会误导后来人，故在此更正。

### P1-6 说明："全错"只成立于涉及 NaN 项的场合

报告称 `highest` / `lowest` / `compare` / `best` "全错"。实测：
`isRarer('c','a')` = **true**（正确）、`best(['a','c'])` = **c**（正确）——
因为这两个比较都没碰到那个 order 为 NaN 的 `b`。
真实范围是：**只要比较涉及 NaN 项，比较器返回 NaN，排序结果由引擎实现决定（实测保持原序）**，
于是 `highest` 错位。修法不变（构造期拒绝 NaN），但"影响面"应以上述为准。
另：文件头 `:30` 自称"排序稳定"，在脏数据下确实不成立，此点报告属实。

### P1-7 说明：为什么只改参数名不改单位

改成秒制（`outSeconds`）会**改变所有宿主的调用**——这是 breaking change，
且本单元内部（配置 ms、tick 收 ms、README 示例 `dtMs`）是自洽的。
所以我选择代价最小且立刻生效的一招：**把参数名从 `dt` 改成 `dtMs`**。
参数名会在每次调用的 IDE 提示里出现，JSDoc 得靠人去翻。

⚠️ **需总审裁决**：任务书作者倾向"整体改成秒制与全库统一"，我倾向"只改名"。
两者只能取其一，请总审定夺；若选秒制，改动面会波及 README 示例、JSDoc 与所有宿主，
建议单开一个窗口统一处理，不要混在 P1 修里。

---

## 2. P2 逐条

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| P2-1 | accessibility | P2 | 已修 | `shouldPlay` 中 `shake/sway/flash` 与 `transition/autoCamera` 两支都 `return false`；无 `destroy()`；缺示例 | 合并为一条规则；补 `destroy()`；补 `examples/accessibility-usage.ts` | › shouldPlay 与卸载 |
| P2-2 | analytics | P2 | 已修 | `assign` 的 `treatmentPercent=NaN` → 200 人 **0** 个进实验组；`twoProportionZTest` 的 `p = **NaN**`；`recordValue(NaN)` → `sum` 变 NaN；`requiredSampleSize(NaN, 0.1)` 返回 **NaN** 不抛错；`Experiment` 无 `destroy()` | 分别回落 50% / `p=1` / 丢弃该样本 / 抛错 / 补 `destroy()` | › 公开函数的收口与卸载 |
| P2-3 | feedback | P2 | 已修（附说明） | `popup` 40 帧采样恒定 **0.50**（JSDoc 却写"进度 1→0"）；`maxIntensity=NaN` → `shake = NaN`、`flash = NaN`（对照 0.4 / 0.6）；无 `destroy()` | `popup` **只改文档**；`maxIntensity` 收口；补 `destroy()` | › 强度收口与卸载 |
| P2-4 | input | P2 | 已修（**返工过一次**，见 §6.1） | `maxQueue=NaN` → 连按 50 次后队列长度 **50**（永不裁剪）；`window=NaN` → 存 NaN；`setter` 传 NaN → **NaN** | 队列回落到 6；构造 `numOr` 回落 0.15；setter 非法值**保持旧值**（初版兜 0 是错的：0 等于缓冲失效） | › 缓冲参数的收口 |
| P2-5 | mmr | P2 | 已修 | `suggestedWindow(team, -100)` = **-100**（min > max，clamp 语义颠倒） | 落在真实区间 **[-300, -100]**（实测 -120） | › 窗口与补人 |
| P2-6 | rarity | P2 | 已修 | `tally(['__proto__','__proto__','b'])` = **{"b":1}**（计数整条丢失） | 得到 `{"__proto__":2,"b":1}`，且是自有属性 | › tally 的键 |
| P2-7 | scenerouter | P2 | 已修（附说明） | 无 `destroy()`；`skipPhase()` 后 `progress = 0`，JSDoc 未说明 load 进度由谁驱动 | 补 `destroy()`；JSDoc 写明 **load 阶段 progress 恒为 0** | › 卸载与加载进度 |

### P2-3 说明：`popup` 只改文档，不改实现

实测 `popup` 在整个 duration 内恒定 = `intensity × scale`，**是强度不是进度**。
把它改成真进度（1 → 0）是 breaking change：已按"强度"接的宿主会突然看到淡出动画。
按任务书 §4 模式 F（缺省配置与 JSDoc 承诺相反时，实现与文档必须对齐一个），
我选择**改文档说清真实语义**，并写了一条测试把"恒定"这个真实行为**钉住**——
免得将来有人照着旧文档把它"修"回去。

### P2-7 说明：load 阶段 progress 恒 0 是设计使然

`out` / `in` 是定时动画，模块知道总时长，能自己算进度；
`load` 的进度只有宿主的加载回调知道，模块拿不到，所以一律返回 0。
这不是"进度条卡住"，我把它写进 JSDoc 与 README，并补了测试固定该语义。

### 一条主动保留：`mmr` 的 `resolve(cfg)` 每次重建配置对象

任务书 P2 提到"`resolve(cfg)` 每次调用都重建配置对象"。
我**没有改**，理由是：`resolve` 收的是调用方传入的**可变对象**，
缓存它会让"改一次 cfg 再调用"这种热更新路径读到旧值——
`window` 可以运行时热更正是本单元的实际用法（见 P2-5 与 skill-queue 的同类场景）。
重建一个小对象的代价远小于脏读。
若总审认为仍需优化，请指明是否接受"缓存 + 浅比较"的复杂度。

---

## 3. 反向验证（测试确实会在修复前失败）

把 `tests/run_phase10_w5b.ts` 原样放到**未修改的原始仓库**上运行：

```
通过 26 项，失败 27 项
```

失败 27 项逐条对应上表的复现用例（含 P1 全部 7 条、P2 中 20 条）。
其余 26 项"通过"的是**对照用例**——它们断言的是修复前后都应成立的行为，
本来就不该失败（若对照用例也失败，说明我把合法输入一起拦了）。

> ⚠️ **复现这一步的正确姿势（W5-A 交叉验收时指出，原文措辞会坑人）**
> 直接 `bash build.sh` 会**失败退出、不产出 `.build/`**：`build.sh` 的逻辑是
> 「`tsc` 有任何输出就 `exit 1`」，而旧源码上这份测试必然报 6 个类型错误
> （`'PartyViolation' 与 '"rating"' 无重叠`、`Accessibility/Experiment/HitFeedback/SceneRouter` 上没有 `destroy`）。
> 正确做法是**绕过 `build.sh` 直接调 `tsc`**（类型报错仍会产出 js），再跑 `.build/tests/run_phase10_w5b.js`。
> W5-A 用同样方法独立跑出 **25 过 / 28 失败**——与我的 26/27 差 1 项，
> 差异来自 base 选取（他取我首个提交的父提交），不影响结论。

**28 条失败的分类**（供总审判断含金量，同样由 W5-A 提出）：

| 类别 | 数量 | 说明 |
|---|---|---|
| 真·缺陷复现（回退修复即失败） | 23 | 对应上表的复现用例，是标准 2 真正要的那部分 |
| "新 API 不存在"导致的失败 | 5 | `a.destroy / e.destroy / fb.destroy / rt.destroy ×2` → `is not a function` |

那 5 条 `destroy` 用例测的是"新增的卸载方法存在"（rule5 要求），不是"某个缺陷已修"——
回退后当然失败。对账时请与"缺陷复现"分开算。

> ⚠️ 反向验证只在 `/tmp` 的副本上做，未改动本仓库任何源码，也没动 `.build/`
> （任务书明确警告过沙盒 502 会损坏产物、build.sh 会整体替换）。

---

## 4. 提交前自检

```
bash build.sh                          → TSC OK（212 个 .js）
node .build/tests/run.js               → 通过 3695 项，失败 0 项   ← 与基线持平
node scripts/check-deps.js             → 全部通过 ✓
node scripts/check-links.js            → 断链 1 处（见下）
python3 scripts/scan-dt-guard.py       → 命中 0 处 ✓
python3 scripts/scan-num-guard.py      → 命中 0 处 ✓
python3 scripts/check-random-source.py → OK ✓
python3 scripts/check-dup-exports.py   → 无待处理冲突 ✓
```

**关于 `check-links` 那条断链**：指向 `audit/handoff_W3-B.md` 内部的一个链接，
解析成 `audit/...`。该文件属于 **W3-B 窗口**，我未改动也未新增指向它的链接；
按并行纪律我不修别人的文件，故原样保留，请 W3-B 或总审处理。
（内部链接总数从 44 升到 45，多出来的那条是我给 accessibility README 加的示例链接，**解析正常**。）

**`_kitmeta.json` 的一处联动修改**：`rarity` 与 `accessibility` 新增了对 `_core` 的 import，
`check-deps.js` 报"import 了但没登记（复制时会漏文件）"。
这是脚本要求的登记口径（否则用户照着 depends 复制会少文件、编译失败），
我只给这两个单元追加了 `"_core"`，未触碰其它字段。

---

## 5. 改动清单

**源码（7 个单元）**

| 文件 | 改动 |
|---|---|
| `accessibility/Accessibility.ts` | 构造三字段走 `clampNum`（与 setter 同口径）；`shouldPlay` 合并分支；补 `destroy()` |
| `analytics/ABTest.ts` | `Stats` 增 `shift`；`variance` 改平移算法；`record*` 写入移位值并丢弃 NaN；`mean` 还原量级；`assign` / `twoProportionZTest` / `requiredSampleSize` 收口；补 `destroy()` |
| `feedback/HitFeedback.ts` | `update` 改 `safeDt`；`maxIntensity` 收口；`popup` 的 JSDoc 更正；补 `destroy()` |
| `input/InputBuffer.ts` | `maxQueue` → `clampNum`；`window` 构造 `numOr`、setter 非法值**保持旧值**再 `Math.max(0,…)`（收尾返工，见 §6.1） |
| `mmr/TeamMMR.ts` | `baseRating` 加 `default` 抛错；新增 `collectRatings` 入口校验；`weightBase` 用 `numOr`；`validateParty` 增 `rating` 拒因；`suggestedWindow` 修正 min/max；`fillFromPool` 先排序后校验 |
| `rarity/Rarity.ts` | `order` 增 `Number.isFinite` 校验；`tally` 用 `defineProperty` 写自有属性 |
| `scenerouter/SceneRouter.ts` | `tick` 参数改名 `dtMs` + 单位 JSDoc；`progress` 的 load 语义写进 JSDoc；补 `destroy()` |

**新增**

- `tests/run_phase10_w5b.ts` —— **55 项**，导出 `runPhase10W5BTests()`（**未改 `tests/run.ts`**，留给总审合并）
- `examples/accessibility-usage.ts` —— rule7 三件套补齐（该单元此前 `hasDemo: false`）
- `audit/result_W5-B.md`（本文件）、`audit/verify_W5-B.md`（交叉验收 W5-A）

**文档同步**：`accessibility` / `analytics` / `feedback` / `mmr` / `rarity` / `scenerouter` / `input(README_InputBuffer.md)` 七份 README。

> 按并行纪律，**未改** `_core/`、`tests/run.ts`、根目录 `README.md`。

---

## 6. 收尾：回应 W5-A 的交叉验收（`audit/verify_W5-A.md`）

W5-A 的结论是**有条件通过**，给了一条 🔴 返工项与两条非阻塞建议。**全部已处理**。

### 6.1 🔴 返工：P2-4 `input` 的 `window` setter 兜底到 0

**对方指出的实质问题**（我完全接受）：同一个字段两条路径兜底值不一致——
构造函数 `numOr(opts.window, 0.15)`，setter 却是 `Math.max(0, numOr(v, 0))`，
而 setter 上方我的注释还白纸黑字写着"与构造函数保持同一口径"。**注释声称同口径，实际一个 0.15 一个 0。**

更难堪的是：我在 P1-1（accessibility）里刚批评过
"构造时传 5 生效、之后重设被压到 1 —— 行为随调用路径变化"，
然后在 P2-4 里把**同一个毛病原样犯了一遍**。对方这条抓得准。

**改法（采用对方倾向的 B）**：

```ts
set window(v: number) {
  const next = numOr(v, this._window);   // 非法 / 非有限 → 保持旧值
  this._window = Math.max(0, next);
}
```

**为什么不是 A（回落到 0.15）**：`window` 允许运行时热更新，
"保持旧值"意味着一次热更传 NaN 只是**没生效**，不会把手感清空；
回落默认值则会把已经配好的窗口改成一个"库认为合理"的值。
与全库 `skill-queue` 的 `window` 收口口径一致。

**测试同步返工**（这是对方指出的第二层问题——`eq(ib.window, 0)` 会把错误兜底钉死）：

| 用例 | 改动 |
|---|---|
| `setter 传 NaN 不得再存 NaN` | `eq(ib.window, 0)` → `eq(ib.window, 0.15)`（保持旧值） |
| **新增** `setter 传 NaN 之后缓冲仍要能用` | **行为级断言**：`press` → 隔一帧 `peek / consume` 必须仍为 true |
| **新增** `窗口到期仍会过期` | 防矫枉过正：热更失败不等于窗口变无限 |

新增这 2 条后测试 53 → **55 项**。行为级断言的必要性我实测确认过：
兜底成 0 时 `press` 后隔一帧 `consume()` = **false**，
而 `window = 0.15` 时为 **true** —— 只断言字段值（数值断言）钉不住这个坑。

同步改了 `input/README_InputBuffer.md`（把"先 numOr 再 Math.max"的说法改成"保持旧值"，并写明 0 等于缓冲失效）。

### 6.2 建议 1 · `Stats.shift` 的混合使用隐患 —— 已补文档

在 `analytics/ABTest.ts` 的 `Stats.shift` JSDoc 与 `analytics/README.md` 各补一段：
`shift` 是**第一批样本**的量级、不是全局常量，手工合并不同量级的 `Stats` 会得出荒谬结果且不报错
（实测 `{n:2, sum:2, sumSq:2, shift:1e9}` 的 `mean` 是 1000000001）；
外部字面量构造的大数量级 `Stats` 会退化回旧算法精度——这是该表示的固有边界，写明不改代码。

### 6.3 建议 2 · 反向验证步骤要写全 —— 已改 §3

§3 现在写明了：需**绕过 `build.sh` 的 tsc 失败拦截**直接调 `tsc` 才能跑起来，
并补上了 28 条失败的**分类**（23 条真缺陷复现 + 5 条"新 API 不存在"）。

### 6.4 `_kitmeta.json`：`rarity` / `accessibility` 已重新登记

`rarity` 与 `accessibility` 是我自己这两个单元新增 `_core` import 后应补的登记，
初版已加过，但被后续的并发推送覆盖回去了（W5-A 在报告 §7 也报告过同一个现象）。

本次**只手改这两个节点的 `depends`**（用 json 解析后精准定位，未走 `--fix` 全量重写——
`--fix` 会连带改掉别人的条目，W5-A 的提交就误删过 `dungeon` / `pathfinding` / `adapters` 三处）。
改后 `check-deps` 未登记项从 8 条降到 **6 条**，剩下的
`i18n / blessing / curse / achievement / rebind / gameflow` **全都不是本窗口的单元**，按并行纪律不代改。

### 6.5 收尾后重跑的自检（远端最新 main 副本）

```
bash build.sh                             TSC OK（227 个 .js）
W5-B 55 项独立跑                          通过 55 项，失败 0 项 ✓
node .build/tests/run.js                  通过 3696 项，失败 1 项
   ✗ 第九批 › BinarySerializer › float 会 clamp 而不是溢出回绕
     ← W8-B 修 P1-5 后漏改旧测试，与本窗口无关（W2-A 已认领）
node scripts/check-links.js               [OK] 42 条内部链接，断链 0 处 ✓
python3 scripts/scan-dt-guard.py          146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py         0 处命中 ✓
python3 scripts/check-random-source.py    [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py      [OK] 无待处理的冲突 ✓
node scripts/check-deps.js                剩 6 条未登记，均为它窗口单元（见 §6.4）
```

### 6.6 反向：我对 W5-A 的验收（`audit/verify_W5-B.md`）

结论**有条件通过**，15 条修复全部生效，但也给了 3 项标红。其中两项与本窗口是**同一个坑的镜像**，
值得总审留意：

- 我在 `input.window` 上犯的"注释论证同口径、实际兜底值不一致"，
  正是 W5-A 在 `skill-queue.window` 上识别并修掉的那个坑（他们盯出了原注释"0 = 不过期"是假的）。
- 我给 W5-A 标的 R1（`signal` 场景 B 复现输出不真实、用例回退仍通过）与
  R2（`number-roller` 下冲断言过弱），属于**测试写得太乐观**——恰好也是对方指出我
  `eq(ib.window, 0)` 时的同一类问题。**双向都出现了，说明这不是某个窗口的疏漏，
  而是"数值断言替代行为断言"这个习惯在 16 个窗口里普遍存在**，建议总审在合并前统一扫一遍。
