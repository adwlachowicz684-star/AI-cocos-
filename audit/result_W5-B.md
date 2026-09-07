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
| 新增测试 | **53 项**（独立运行全绿） |
| 反向验证 | 同一份测试跑在**修复前**的源码上：**26 过 / 27 失败** |
| 全量回归 | **3695 项**（与基线持平，0 失败） |
| 校验脚本 | 5 项 PASS；`check-links` 1 处断链为 **W3-B 交接书既有问题**，与本窗口无关（见 §4） |
| 需总审裁决 | 1 条（scenerouter 单位是否整体改秒制） |

**"修复前会失败"不是推断**：我把 `tests/run_phase10_w5b.ts` 原样拷到未修改的原始仓库上编译运行，
得到 26 过 / 27 失败——失败明细逐条对应下面 §1/§2 的复现用例。
（原报告的"证据"是别的窗口写的，我自己重跑了一遍，其中 4 条与报告描述有出入，已逐条注明。）

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
| P2-4 | input | P2 | 已修 | `maxQueue=NaN` → 连按 50 次后队列长度 **50**（永不裁剪）；`window=NaN` → 存 NaN；`setter` 传 NaN → **NaN** | 队列回落到 6；构造 `numOr` 回落 0.15；setter 先 `numOr` 再 `Math.max(0,…)` | › 缓冲参数的收口 |
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

把 `tests/run_phase10_w5b.ts` 原样放到**未修改的原始仓库**上编译运行：

```
通过 26 项，失败 27 项
```

失败 27 项逐条对应上表的复现用例（含 P1 全部 7 条、P2 中 20 条）。
其余 26 项"通过"的是**对照用例**——它们断言的是修复前后都应成立的行为，
本来就不该失败（若对照用例也失败，说明我把合法输入一起拦了）。

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
| `input/InputBuffer.ts` | `maxQueue` → `clampNum`；`window` 构造 `numOr`、setter 先 `numOr` 再 `Math.max(0,…)` |
| `mmr/TeamMMR.ts` | `baseRating` 加 `default` 抛错；新增 `collectRatings` 入口校验；`weightBase` 用 `numOr`；`validateParty` 增 `rating` 拒因；`suggestedWindow` 修正 min/max；`fillFromPool` 先排序后校验 |
| `rarity/Rarity.ts` | `order` 增 `Number.isFinite` 校验；`tally` 用 `defineProperty` 写自有属性 |
| `scenerouter/SceneRouter.ts` | `tick` 参数改名 `dtMs` + 单位 JSDoc；`progress` 的 load 语义写进 JSDoc；补 `destroy()` |

**新增**

- `tests/run_phase10_w5b.ts` —— 53 项，导出 `runPhase10W5BTests()`（**未改 `tests/run.ts`**，留给总审合并）
- `examples/accessibility-usage.ts` —— rule7 三件套补齐（该单元此前 `hasDemo: false`）
- `audit/result_W5-B.md`（本文件）、`audit/verify_W5-B.md`（交叉验收 W5-A）

**文档同步**：`accessibility` / `analytics` / `feedback` / `mmr` / `rarity` / `scenerouter` / `input(README_InputBuffer.md)` 七份 README。

> 按并行纪律，**未改** `_core/`、`tests/run.ts`、根目录 `README.md`。
