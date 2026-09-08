# 精审返工任务书 · 窗口 W5-B（第 B 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W5-B 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **14**（P1 7 / P2 7） |
| 单元 | **7** 个 |
| 来源批次 | batch1、batch3 |
| 所属组 | **第 B 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W5-A**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_B.md` 验收 **W5-A**。

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

### 3.1 你的单元（7 个，与其它 15 个窗口零重叠）

```
accessibility  analytics  feedback  input  mmr  rarity  scenerouter
```

---


## 【P1】先做这批

### P1 · [accessibility] `fontScale` 的构造校验挡不住 NaN；`shakeScale` 构造不 clamp 而 setter clamp（口径不一致）

- **位置**：`accessibility/Accessibility.ts:84-95`（构造）、`:147-150`（`setFontScale`）、`:172-176`（`setShakeScale`）
- **现象**：`if (this._fontScale <= 0) throw` 中 `NaN <= 0` 为 false → NaN 不被拦截；`setFontScale` 的 `Math.min(2, Math.max(0.8, v))` 对 NaN 同样穿透。另一方面 `shakeScale` 构造时原样接受任意值，setter 却 clamp 到 [0,1]。
- **证据**：实测（`verify/b3_v5.ts`）
  ```
  new Accessibility({fontScale: NaN}) 未抛错！
  fontSize(16) = NaN
  new Accessibility({shakeScale: 5}) 构造成功, shakeScale = 5
  setShakeScale(5) 后 shakeScale = 1        ← 被 clamp
  ```
- **后果**：`fontScale = NaN` 会让**全UI字号变成 NaN**（`fontSize()` 是 `base * _fontScale`），文本渲染异常或消失，且不报错——NaN 一旦进入布局要很久才回溯到这个配置项。`shakeScale` 口径不一致则导致"构造时传 5 生效、之后重设被压到 1"，行为随调用路径变化。
- **建议**：构造统一走 setter 语义并收口：
  ```ts
  this._fontScale  = clampNum(opts.fontScale,  0.8, 2,   1);
  this._shakeScale = clampNum(opts.shakeScale, 0,   1,   1);
  this._longPressMs = clampNum(opts.longPressMs, 200, 3000, 600);
  ```
  注意 `importState()`（`:179-201`）反而**做对了**（逐字段 `typeof` + `Number.isFinite` 校验），把它的校验强度提到构造函数即可。

### P1 · [analytics] `variance` 用单次 `sumSq - n·m²`，大数值小方差时被灾难性消去抹平

- **位置**：`ABTest.ts:249`
- **现象**：`Math.max(0, v)` 把消去产生的负数直接压成 0，掩盖了精度崩溃。
- **证据**：`variance([1e8+1 .. 1e8+5])` 返回 **0**（精确值 2）；`variance([1e9+7, 1e9+9, 1e9+11])` 返回 **0**（精确值 4）（`b1_v3` [39]）。
- **后果**：埋点金额、时长这类"大基数小波动"指标，方差被算成 0 → 置信区间为 0、t 检验失效 → 结论"差异显著"或"无差异"都不可信。典型场景是 ARPU 类实验。
- **建议**：改用两遍算法（先算均值，再累加 `(x - m)²`），或 Welford 在线算法。

### P1 · [feedback] `update` 的 dt 守卫是 `!(realDt > 0)`，挡不住 Infinity

- **位置**：`HitFeedback.ts:321`（`update(realDt)`）
- **现象**：守卫写成 `!(realDt > 0)`，`!(Infinity > 0)` = false → Infinity 穿透，把所有实例的 `elapsed` 推到 Infinity 并全部清除。
- **证据**：`update(Infinity)` 后 `activeCount = 0`（期望 1）——**当前所有打击反馈瞬间消失**（`b1_v2` [2]）。
- **后果**：任务书 A 类点名的写法。切后台再回来、断点续跑、时间戳异常时 dt 可能是巨大值，表现为"所有震屏/闪白/飘字同时消失"。
- **建议**：改用 `_core` 的 `safeDt`（该单元其他部分已用，此处漏）。

### P1 · [mmr] `baseRating` 的 switch 没有 default 分支 → 非法 strategy 静默返回 undefined

- **位置**：`TeamMMR.ts:183`~`:215`
- **现象**：TS 的穷尽性检查只覆盖类型内取值，挡不住运行时的脏字符串。未枚举到的 strategy 使所有 case 都不匹配 → 函数返回 `undefined` → `effective = NaN`。
- **证据**：`strategy = 'average'`（配置里很容易写成 average / Weighted 这类大小写或别名）→ `base = undefined`、`effective = **NaN**`，**不抛错**（`b1_v2` [10]）。
- **后果**：匹配分恒为 NaN → 玩家被分进任意对局或被匹配系统丢弃，表现为"排不到人"或"分局实力悬殊"。配置改一个字符串就能触发，且没有任何提示。
- **建议**：加 `default:` 分支，对未知 strategy 抛错（快速失败）或回落 `'weighted'` 并告警。

### P1 · [mmr] `MmrPlayer.rating` 未做有限性校验 → 一个 NaN 传染整局匹配分

- **位置**：`TeamMMR.ts`（`rating` 直接参与 `maxOf`/`minOf`/加权）
- **证据**：任一玩家 `rating = NaN` → `base = NaN`、`effective = **NaN**`（`b1_v2` [10]）。
- **后果**：rating 来自服务端返回或新玩家默认值，出现一次 null/NaN 就让整队的匹配分失效，且 NaN 会传染到分差校验、窗口计算，最终可能让 `validateParty` 放行本应拒绝的队伍。`weightBase` 同样用 `?? 0.7`（NaN → 所有权重 NaN；负数 → 分母可能为 0 除零）。
- **建议**：入口对 ratings 做一次 `Number.isFinite` 过滤或抛错；`weightBase` 用 `clampNum`。

### P1 · [rarity] `order` 只查重复、不查有限性，一个 NaN 让全档位排序失效

- **位置**：`Rarity.ts:97`~`:116`
- **现象**：构造函数校验了 `weight`（`!(d.weight > 0)`），但 `order` 只做重复检测。比较器返回 NaN → 排序结果由引擎实现决定（实测保持原序）→ `highest` / `lowest` / `compare` / `best` 全错。
- **证据**：三条定义 order 分别为 1 / NaN / 3 → `highest.id` 返回 **`a`**（应为 `c`），`all` 顺序为 `a,b,c`（未排序）（`b1_v2` [12]）。
- **后果**：保底系统按 `highest` 判定"给不给最稀有档"，排序错 → 保底给错档位；掉落权重表按 order 排序展示，UI 顺序错乱。文件头 `:30` 自称"排序稳定"，实际在脏数据下完全不稳定，且不报错。
- **建议**：`order` 加 `Number.isFinite` 校验（与 `weight` 同一标准）。

### P1 · [scenerouter] 时间单位与全库不一致：配置与 `tick` 都是毫秒，其余单元 `dt` 都是秒

- **位置**：`SceneRouter.ts:71`/`:75`（`outMs` / `inMs`，JSDoc 写明"毫秒"）、`:127`~`:129`（默认 300）、`:217`（`tick(dt)`，JSDoc 未写单位）；README `:23` 把参数命名为 `dtMs`
- **现象**：本单元内部自洽（配置 ms、tick 收 ms、README 叫 dtMs），但**参数名仍是 `dt`**，而全库其余 23 个单元的 `dt` 都是秒。
- **证据**：`outMs = 300`，按**秒**传 `dt = 1/60` → 离开 out 阶段用了 18000 帧 = **300.0 秒**（期望 0.3 秒）；按**毫秒**传 `dt = 16.67` → 18 帧 = **0.30 秒**（`b1_v2` [1]）。
- **后果**：宿主按全库惯例传秒，转场慢 1000 倍——表现为"点了开始，黑屏卡住五分钟"。而因为 JSDoc 没写单位、参数名叫 `dt`，不看 README 示例（`dtMs`）根本发现不了。这是"同名不同义"的典型。
- **建议**：参数改名为 `tick(dtMs)`，并在 JSDoc 首行写明"单位是毫秒，与其他单元的秒制 dt 不同"；或整体改成秒制 `outSeconds`，与全库统一（我倾向后者，但改动面大，请总审裁决）。


## 【P2】P1 完成后再做

### P2 · [accessibility] （见正文）

- `shouldPlay()`（`:129-146`）的 switch 中 `shake/sway/flash` 与 `transition/autoCamera` 两支都 `return false`，可合并为 `return kind === 'particle' || kind === 'loopAnim';`
- 无 `destroy()`（持有 `onChange`）。
- 缺示例（任务书标注"示例：无"）——rule7 判据要求 README+测试+示例三件套。

---

### P2 · [analytics] （见正文）

- `assign()` `:170` 的 `treatmentPercent ?? 50` 未校验有限性/范围（构造函数 `:410`~`:417` 校验了，但 `assign` 是公开导出函数）→ NaN 时 `bucket < NaN` 恒 false，全落 control 且静默。
- `twoProportionZTest` `:318` 用 `clamp(p, 0, 1)` 而非 `clampNum` → `p` 为 NaN 时 `Math.max(0, NaN) = NaN`，`significant` 恒 false 且静默。
- `recordValue` / `requiredSampleSize` 未校验 `value` 有限性；`Experiment` 无 `destroy()`。

### P2 · [feedback] （见正文）

- `FeedbackOutput.popup` 的 JSDoc `:89` 写"进度 0~1（1=刚触发，0=结束）"，但实测在整个 duration 内**恒定不变**：40 帧采样恒为 `1.00`，`intensity = 0.5` 时恒为 `0.50`（`b1_v5` [44]）。它是**强度**不是进度，宿主若按进度做淡出，会看到飘字永不淡出、结束瞬间突降为 0。
- `maxIntensity` 用 `?? 1.5` 未收口：NaN → `eff = NaN` → `clamp01` 归 0 → 震屏/闪白静默失效。实测 `shake = NaN, flash = NaN`，对照组 `0.4 / 0.6`（`b1_v4` [35]）。
- 无 `destroy()`；`output` getter 每帧 new 对象。

### P2 · [input] （见正文）

- `_maxQueue` 建议改 `clampNum(opts.maxQueue, 1, 64, 6)`；`_window`（`:109`）建议 `numOr`。

---

### P2 · [mmr] （见正文）

- `suggestedWindow` `:404` 的 `clamp(baseWindow * u, baseWindow, baseWindow * 3)` 在 `baseWindow < 0` 时 min > max，`clamp` 会返回 max（语义错误）。
- `fillFromPool` `:341`~`:351` 对 pool 每个候选都跑一次 `validateParty + teamMmr`（O(pool × party)）；`resolve(cfg)` 每次调用都重建配置对象。

### P2 · [rarity] （见正文）

- `tally` `:252`~`:259` 用 `{}` 字面量累加。实测稀有度 id 为 `__proto__` 时，其计数**整条丢失**：`tally(['__proto__','__proto__','b'])` 返回 `{"b":1}`（`b1_v4` [33]）。`get('__proto__')` 仍可取到定义，属于"部分可用、计数丢失"的半失效状态。

### P2 · [scenerouter] （见正文）

- 无 `destroy()`；`load` 阶段的进度需要宿主自己推进，`skipPhase()` 后 `progress = 0`，JSDoc 未说明宿主该如何驱动加载进度。

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

新建 `tests/run_phase10_w5b.ts`，并**在文件内导出** `runPhase10W5BTests()`：

```ts
export function runPhase10W5BTests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W5-B.md`，每条一行：

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
| **文件命名** | `run_phase10_w5b.ts` / `result_W5-B.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 B 组**。修完之后，按 `audit/review_B.md` 验收 **W5-A**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W5-B.md`，
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
