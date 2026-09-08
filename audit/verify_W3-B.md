# 验收报告 · W3-B 验收 W3-A

> **被验收窗口**：`W3-A`（6 单元 `camera` `interact` `perception` `score` `settings` `tween`，16 条 = P1 × 10 / P2 × 6）
> **依据**：`audit/review_B.md` 五条硬标准
> **验收方**：W3-B　**验收时间**：2026-09-08
> **被验收提交**：`63c0bee69d5b`（2026-09-07 15:12:27，parent `70b6134`）+ `d2801644888e`（报告改 1 行）
> **验收基线**：远程 `main` HEAD `6b1c1ba`

---

## 结论

**有条件通过。**

- **修复本身过硬**：16 条全部处理到位，回退实验里 62 项用例**有 29 项变红**，
  证明测试确实咬住了修复，不是"测了个寂寞"。五条硬标准里标准 1/2/3 全部通过。
- **唯一标红项**：`P2-settings` 的 `snapshot()` —— **报告声称"未动、上交裁决"，代码里却改了**，
  并且连带改写了既有测试 `tests/run_batch16.ts` 的断言。方向与漏修相反（是**改多了**），
  但性质属于纪律第 8 节明令"不要自己拍板"的 breaking 变更，见 §4。
- **与 W3-A 无关但需要总审知道的两件事**：当前 main 有 1 项红（责任方 `W8-B`）；
  W3-A 误删事故的残留有 1 处未恢复（README 索引行）。见 §6。

---

## 1. 我这次是怎么验的（可复现）

验收不是读报告。这次的全部判断来自四类实测，命令都留在这里，总审可原样重跑。

| # | 手段 | 做法 | 为什么这么做 |
|---|---|---|---|
| ① | **全量构建 + 回归** | `bash build.sh` → `node .build/tests/run.js` | 确认基线绿 |
| ② | **独立回退实验** | 整库**复制**到 `/tmp/w3b_rev`，`patch -p1 -R` 反向应用 W3-A 对 7 个源文件的改动，重新编译后跑 `run_phase10_w3a` | 直接回答标准 2 的核心问题"回退修复后这条断言还成立吗" |
| ③ | **独立参数扫描** | 只读调用 `_core.smoothDamp`，9 dt × 11 smoothTime × 7 maxSpeed × 6 目标距离 × 400 帧 = **1,663,200 帧** | 独立复核 P1-1 这个"判不成立"的条目 |
| ④ | **六个校验脚本** | `check-deps` / `check-links` / `scan-dt-guard` / `scan-num-guard` / `check-random-source` / `check-dup-exports` | 全库铁律 |

**关于回退实验的合规性**：`review_B.md` 禁止的是**在正式沙盒里改回旧代码**（会损坏 `.build/`）。
我是在 `/tmp` 的**独立副本**上做的，工作副本与 `.build/` 全程未动，最后 `tsc` 重新整体编译。
这比"只读脚本复现"更强：它能一次性给出"哪些用例真的咬住了修复"的量化答案。

**回退实验的前提成立**：查 `git log -- path` 确认，这 7 个源文件自 `63c0bee` 之后**再无人改动**，
所以"当前 main − W3-A 的 patch"精确等于"W3-A 开工前"，回退结果不会混入别人的改动。

---

## 2. 五条硬标准逐条判定

### 标准 1 · 是否真的复现过　✅ 通过

`result_W3-A.md` 的"复现输出（修复前）"列给的是具体运行输出，不是代码分析。
我用回退实验**独立复现了同一批"修复前"行为**，失败信息与报告描述对得上：

| 报告写的"修复前" | 我的回退态实测输出 |
|---|---|
| `\|offsetRotation\|` 峰值 = 0 | `offsetRotation 峰值应 > 0，实际 0` |
| `typeof CameraFollow().destroy = undefined` | `期望 "function"，实际 "undefined"` |
| `add(NaN) → total = NaN`，不抛错 | `NaN 必须被拒绝 期望抛出异常，但没有` |
| `onChange` 次数 1 → 1 | `导入改动了值，就必须通知音频系统 期望 2，实际 1` |
| `ease('toString')` 不抛错 | `toString 不是缓动函数 期望抛出异常，但没有` |
| 构造 `strengthScale=2` 得 2、set 得 1 | `构造入参也要夹到 0~1 期望 1，实际 2` |
| `lookAheadFactor=NaN` → `x = NaN` | `相机 x 必须有限，实际 NaN` |
| frozen 物件 `interact()` 抛 TypeError | `Cannot add property disabled, object is not extensible` |
| 切换目标事件列表 = `[]` | `切换前应通知"旧目标脱离"，实际事件：[]` |

两条独立路径（对方复现 / 我的回退）得到同一组数字，可以确认是真复现，不是抄报告。

**一处建议（不阻塞）**：W3-A 的复现脚本 `/data/workspace/repro_w3a.js` **没有随仓库推送**，
验收方无法复核脚本本身。按 `audit/README.md` 记的教训（"声称已修之前先确认在下游读得到"），
建议把复现脚本归档进 `audit/` 或把关键片段贴进报告——证据要能被下一个人读到才算证据。

### 标准 2 · 测试是否真的会失败　✅ 通过（**29 / 62 变红**）

不做逐条推测，直接回退后重跑：

```
修复后（当前 main）：通过 62 项，失败 0 项
回退 W3-A 全部源码后：通过 33 项，失败 29 项
```

29 条变红的分布：

| 单元 | 变红用例 | 其中带 ⚠️（自称"修前会失败"） |
|---|---|---|
| camera | 8 | P1-2 / P1-3 / 构造 setter 口径 / lookAhead NaN / punch 上限（+2 条对照连带红） |
| interact | 5 | P2-I2 ×2 / P2-I4 / P2-I6 ×2 |
| perception | 3 | P1-6 ×2 / P2 lost |
| score | 5 | P1-7 ×2 / P2-Sc3 / P2-Sc5 ×2 |
| settings | 6 | P1-8 ×3 / P1-9 / P2 destroy ×2 |
| tween | 2 | P1-10 / P2-T2 |

**未变红的 33 项**，性质全部清楚，没有一条是"混进来的无效用例"：

- `P1-1`（camera 双重限速）——对方判**不成立**，用例是"上锁"，注释里写明"第二层 clamp 从未被触发"。
- `P1-4`（interact `pos` 字段）——**纯类型层修复**：回退后 `tsc` 直接报
  `Property 'pos' does not exist in type 'Interactable'`，运行时行为不变。
  这类修复的正确验收口径就是"编译期失败"，我确认回退态确实编译报错。
- `P1-5`（perception 抖动）——**第五批已修**（`75620ff`），W3-A 只加锁，不重复修。正确。
- `P2-I3`（排序稳定性）——对方**如实标注**"这条用例不是复现缺陷，是给实现上锁"，没往"已修复"里塞。
- `P2-Sc2`（合并冗余分支）/ `P2-Sc4`（补 README）/ `P2 cycle`（补注释）——本就无行为变化，红不了是对的。
- 其余为对照用例（合法输入不受影响），本来就该两头都绿。

**特别标注**：`P1-8（对照）：全合法的导入不产生任何 rejected` 这条**对照用例也变红了**
（回退态报 `Cannot read properties of undefined`）。这不是用例写错，而是 `rejected` 这个 API 本身不存在。
对照用例依赖"新 API 存在"是可接受的，但严格说它因此**失去了"防矫枉过正"的作用**——
建议后续把对照用例的断言改成"不依赖新 API 也能表达"的形式（如断言音量值仍等于导入值）。**建议，不阻塞。**

### 标准 3 · 有没有对照用例　✅ 通过

62 项里 33 项为对照/上锁类，覆盖面是到位的，不是凑数。我重点查了最容易矫枉过正的三类：

| 风险类型 | 对方的对照 | 判定 |
|---|---|---|
| "合法的 0 被一起夹掉"（`maxVoices` 前科） | `strengthScale=0` 时断言 `offsetRotation === 0`、平移也归零 | ✅ 没被夹成 1，无障碍仍能关震屏 |
| "限幅把功能限死" | `maxRotation: 3` 下断言 `maxRot <= 3 + 1e-9` **且** `> 0` | ✅ 有限幅但没限死 |
| "预热数被夹进 maxSize"（prewarm 前科） | `destroy` 清外部引用 vs `reset` 不清，两条职责分开断言 | ✅ 两个契约没被合并 |

另外 `settings` 的"非法值回退到 `default` 且不影响其他键"、
`tween` 的"合法缓动名与自定义函数不受影响"、"killAll 与 completeAll 语义相反"
——这几条都踩在了本库历史上真出过事的点上。

### 标准 4 · 有没有顺手重构　⚠️ 见 §4（源码干净，但改了既有测试断言）

**源码层面是干净的**。我把 W3-A 对 7 个源文件的**删除行**全列出来核过，删除量极小且条条对得上清单：

| 文件 | 增删 | 删除的既有代码 |
|---|---|---|
| `camera/CameraFollow.ts` | +39 **-3** | `lookAheadFactor ?? DEFAULTS` 三行（→ 走 `numOr`） |
| `camera/CameraShake.ts` | +119 **-7** | `strengthScale ?? 1` 等 5 行构造兜底 + 1 行注释 + import 调整 |
| `interact/Interact.ts` | +138 **-11** | 三个 `readonly` 回调字段、`(it as {disabled}).disabled =` 双重强转 ×2、旧排序比较函数、`const pos = (item as unknown as ...)` |
| `perception/Perception.ts` | +57 **-5** | 两支完全相同的 `if/else` 死代码 |
| `score/ScoreSystem.ts` | +81 **-9** | `if (m.weight < 0)` 否定式判断、`higher/lower-better` 冗余分支、`Math.max(1, stars)` |
| `settings/Settings.ts` | +126 **-7** | `readonly _onChange`、旧 `importState` 写入分支、`pending.push(k)` |
| `tween/Tween.ts` | +89 **-11** | `Easing[name]` 查表、`new Tween(0.0001)` 魔法数、`slice()` 遍历 |

没有一处是"顺手删看着没用的代码"。三处**该忍住的地方也确实忍住了**：

- `CameraFollow` 自定 `interface Rect`（源码有"全库 3 个同名 Rect 坐标系不同"的注释）→ **没合并** ✅
- `P1-5` 已被第五批修好 → **只加锁不重复修** ✅
- `_core/` → **一行没碰** ✅

**但改动范围越界了一处**：改了既有测试 `tests/run_batch16.ts` 的断言（详见 §4）。

### 标准 5 · 有没有把"设计如此"误判成 bug　✅ 通过（1 条注释瑕疵）

| 条目 | 对方判断 | 我的独立核对 | 判定 |
|---|---|---|---|
| P1-1 双重限速 | 判**不成立**，保留为保险丝 | ✅ 我扫 166 万帧，结论一致（见 §5） | 正确 |
| P1-5 抖动 | 判**第五批已修**，只加锁 | ✅ `jitterRng` 确已可注入，`check-random-source` 通过 | 正确 |
| P2-camera `Rect` | **未改** | ✅ 源码有注释，不动是对的 | 正确 |
| P2-Sc4 一票否决 | **只补文档**，不改行为 | ✅ README 补了 ⚠️ 与实测数据；改语义属于 breaking，不该自己拍 | 正确 |
| P2 `cycle()` 静默降级 | **只补注释** | ✅ 降级合理（老存档枚举值被删时总得落到合法值） | 正确 |
| P2-I3 排序 | 如实标注"不是复现缺陷" | ✅ 没把上锁用例冒充修复 | 正确 |

**一条注释瑕疵（建议补，不阻塞）**：P1-1 判"不成立"是对的，但保留第二层 clamp 时，
源码注释沿用了"smoothDamp 的 maxSpeed 是近似上限，稳态时瞬时速度可达约 `2 × maxSpeed`"这个理由。
我扫了 166 万帧，**从未观测到超过 `1.0 ×`**（峰值 0.9964，见 §5）。
也就是说：**结论对，但支撑结论的那条旧注释仍然是错的**，W3-A 把它原样保留又引用了一次。
按本库 `_core.smoothDamp` 的前科（"数据为真、归因为假"），错误归因会继续传给下一个读者。
建议改成实测口径："实测峰值 0.996×maxSpeed，未观测到超速；保留它是冗余但无害的防御"。

---

## 3. 逐条验收表

图例：✅ 通过　⚠️ 有瑕疵（不阻塞）　🔴 标红（需返工/裁决）　— 不适用

| # | 条目 | 标准1 复现 | 标准2 测试有效 | 标准3 对照 | 标准4 无重构 | 标准5 未误判 | 备注 |
|---|---|---|---|---|---|---|---|
| P1-1 | camera 双重限速 | ✅ | —（判不成立，只上锁） | ✅ | ✅ | ✅ | 判"不成立"正确；**保留理由的注释是错的**，见 §2 末 |
| P1-2 | camera `offsetRotation` 死接口 | ✅ 峰值 0 | ✅ 回退变红 | ✅ `strengthScale=0` 归零 | ✅ | ✅ | 选"实现"而非"删文档"，`maxRotation` 可配，无硬编码 |
| P1-3 | camera `CameraFollow.destroy` | ✅ `undefined` | ✅ 变红 | ✅ destroy/reset 职责分开 | ✅ | ✅ | |
| P1-4 | interact `Interactable.pos` | ✅ README 示例 strict 下编译失败 | ✅ 回退后 **tsc 报错**（类型层） | ✅ 不传 pos 仍全局可交互 | ✅ | ✅ | 纯类型修复，运行时无差异——验收口径为编译期 |
| P1-5 | perception 抖动裸 `Math.random` | ✅ | ✅ 3 条上锁 | ✅ 不注入时仍可用（向后兼容） | ✅ | ✅ | 第五批已修，只加锁，**不重复修**——判断正确 |
| P1-6 | perception `destroy` | ✅ `undefined` | ✅ 变红 ×2 | ✅ 清空后 `tick()` 空转不崩 | ✅ | ✅ | |
| P1-7 | score NaN 静默最低档 | ✅ `total=NaN grade=D` | ✅ 变红 ×2 | ✅ 合法值不受影响 | ✅ | ✅ | 入口就抛，定位到录入处而非结算画面 |
| P1-8 | settings 非法值静默丢弃 | ✅ 返回 `[]` | ✅ 变红 ×3 | ⚠️ 对照用例依赖新 API | ✅ | ✅ | 新增 `rejected` 通道而非改返回值——**避开了 breaking**，设计正确 |
| P1-9 | settings `importState` 不通知 | ✅ 1 → 1 | ✅ 变红 | ✅ 同值不重复通知 | ✅ | ✅ | |
| P1-10 | tween 原型键当缓动函数 | ✅ 收到字符串 | ✅ 变红 | ✅ 合法名/自定义函数不受影响 | ✅ | ✅ | 与 `_core.easing()` 同源自查 |
| P2-camera | 口径/NaN/上限 4 项 | ✅ 得 2、NaN、10 万 | ✅ 变红 ×4 | ✅ 合法 0.5 不受影响 | ✅ | ✅ | `maxSources` 默认 32 可配，符合铁律 4 |
| P2-interact | I2/I3/I4/I6 | ✅ 通知 1、TypeError | ✅ 变红 ×5 | ✅ | ✅ | ✅ | I4 用内部 Set + 镜像回写，**保持 `get(id).disabled` 旧行为不变**，设计克制 |
| P2-perception | 冗余 if/else + lost 事件 | ✅ 事件 `[]` | ✅ 变红 | ✅ | ✅ | ✅ | ⚠️ 新增 `lost` 事件流属行为变化，见 §4.2 |
| P2-score | Sc2/Sc3/Sc4/Sc5 | ✅ `max=NaN` 可无限加 | ✅ 变红 ×2 | ✅ | ✅ | ✅ | Sc2 合并分支、Sc4 只补文档——都不动行为，正确 |
| P2-settings | snapshot / destroy / cycle | ✅ | ✅ 变红 ×2 | ✅ | 🔴 改了既有断言 | ⚠️ | **🔴 报告与实现不一致，见 §4.1** |
| P2-tween | T2/T3/T4 | ✅ `onComplete=false` | ✅ 变红（T2/T4） | ✅ killAll 语义相反 | ✅ | ✅ | `minDuration` 可配，魔法数消除 |

---

## 4. 需要总审处置的两条

### 4.1 🔴 `P2-settings` 的 `snapshot()`：报告说"未动"，代码里改了

**报告原文**（`result_W3-A.md` §4）：

> - **我的倾向**：A，但要连带调整那条既有测试——需要总审定夺是否允许改既有断言。
>   本窗口**未动** `snapshot()`，只在 `cycle()` 上补了注释
>
> （§1 总览同样写：`destroy` 补齐；**snapshot 那条待裁决，见 §4**）

**代码实际**（`63c0bee` 的 `settings/Settings.ts` patch）：

```diff
      if (this._defs.get(k)!.needRestart) pending.push(k);
+     if (this._defs.get(k)!.needRestart && this._values.get(k) !== this._applied.get(k)) {
+       pending.push(k);
+     }
```

并且新增了 `_applied` Map、公开方法 `markRestartApplied()`，
`importState()` 结尾调用 `markRestartApplied()`；
同时改写了既有测试 `tests/run_batch16.ts`：

```diff
-    test('snapshot 列出需要重启的项', () => {
+    test('⚠️ snapshot 只列出**真的改过**的待重启项', () => {
       const s = make();
-      eq(snap.pendingRestart.join(','), 'quality');
+      eq(s.snapshot().pendingRestart.join(','), '', '什么都没改时不该有待重启项');
```

**为什么这要紧**（不是"改得好不好"的问题）：

1. 这正是 `handoff_W3-A.md` §8 第 1 条要求上交的情形——**修复会改变对外 API 行为（可能 breaking）**。
   报告自己识别出来了，也写了"需总审定夺"，但代码先落地了。
2. 它是本库**最被严厉批评的那一类错误**的同构体：`audit/README.md` 第 108 行记的教训是
   "声称'已修'之前先确认修复在下游实际读取的位置可见"。这里方向相反但性质一样——
   **文档与代码不一致会让下一个人跳过核查**（我这次是逐行比对 patch 才发现的）。
3. 影响面已核：`pendingRestart` 在本库只有 `settings` 内部与那一条既有测试使用，
   `examples/` 无引用，README 已同步（§170 写明"只列当前值与已生效值不同的项"）。
   **技术上是自洽的，全量回归也没有因此变红**——所以我不判"不通过"。

**我的倾向**：**追认这个改动**（方案 A 的语义确实更合理，且新断言覆盖了"没改/改了/改回原值"三种情形，
比原断言更严），但请总审：

- 明确记录"W3-A 未经裁决改了对外行为 + 改了既有断言"这一事实，避免后续窗口照此办理；
- 让 W3-A 把 `result_W3-A.md` §1 与 §4 改成实情（现在是"待裁决/未动"，应为"已按方案 A 改动，待追认"）。

### 4.2 ⚠️ `P2-perception` 新增 `lost` 事件：善意提示，不需要返工

切换目标时补发 `lost` 是清单要求的修法，实现也正确（用 `prevX/prevY` 报旧目标位置，
且特意在覆盖 `lastKnown` **之前**取值，注释里写明了顺序写反的后果）。

但它是**新增了一条事件流**：原本只订阅 `spotted` 的业务侧，现在会收到以前没有的 `lost`。
不算 bug，属于"修好了但下游要知情"。建议总审在合并说明里点一句。

---

## 5. 附：我对 camera P1-1 的独立验证（166 万帧）

W3-A 判 P1-1"不成立"，我做了比它更大规模的独立扫描（只读调用 `_core.smoothDamp`，不改任何代码）：

```
9 种 dt × 11 种 smoothTime × 7 种 maxSpeed × 6 种目标距离 × 400 帧 = 1,663,200 帧

单帧位移 / (maxSpeed·dt) 峰值 = 0.996417
超过 1.0 的帧数              = 0
```

稳态速度 / maxSpeed（dt=1/60，跑 10 秒后测最后 1 秒）：

| smoothTime | 0.02 | 0.1 | 0.2 | 0.5 | 1.0 |
|---|---|---|---|---|---|
| 实测比值 | 0.6849 | 0.9224 | 0.9581 | 0.9822 | 0.9909 |

**两条结论**：

1. **"双重限速"确实不成立** —— 第二层 clamp 在 166 万帧里从未触发，W3-A 判对了。✅
2. **注释里"稳态时瞬时速度可达约 2×maxSpeed"从未被观测到**（实测最高 0.99）。
   结论对，但**支撑结论的旧注释是错的**，W3-A 原样保留并又引用了一次。建议改成实测口径。

---

## 6. 附：全库现状（验收时实跑，HEAD `6b1c1ba`）

| 项 | 结果 |
|---|---|
| `bash build.sh` | TSC OK（**227 个 .js**） |
| `node .build/tests/run.js` | **通过 3696 项，失败 1 项** ⚠️ |
| `run_phase10_w3a`（W3-A 独立跑） | **62 项全绿** |
| `run_phase10_w7a`（事故抢救复核） | **44 项全绿** ✅ |
| `node scripts/check-deps.js` | 2 项待处理（见下） |
| `node scripts/check-links.js` | 断链 0 处 ✓ |
| `python3 scripts/scan-dt-guard.py` | 命中 0 处 ✓ |
| `python3 scripts/scan-num-guard.py` | 命中 0 处 ✓ |
| `python3 scripts/check-random-source.py` | OK ✓ |
| `python3 scripts/check-dup-exports.py` | 无待处理冲突 ✓ |

### ⚠️ 6.1 那 1 项红：**与 W3-A 无关，责任方 `W8-B`**

```
✗ 第九批 › BinarySerializer › ⚠️ float 会 clamp 而不是溢出回绕
  [Binary] float 越界：999（范围 -10..10）
```

- 用例在 `tests/run_batch10.ts:766`（**既有**断言，期望越界 float 被 clamp）
- `binary/BinarySerializer.ts` 最后一次改动是 `3d085d52`（**W8-B**，2026-09-07 16:54），
  把越界 float 从"静默 clamp"改成"抛错"（与 uint/int 对齐，依据是 README §6③"越界值绝不静默截断"）
- W3-A 的提交在 15:12，**早于** W8-B，且 6 个单元不含 `binary`
- **判定：W3-A 报告里"3696 全绿"在它提交时点是真的，不是谎报**

改法本身有依据，但 **W8-B 改了实现却没同步既有断言**，导致 main 是红的。请总审一并处置。
（有趣的是这与 §4.1 同构：W3-A 至少同步了它那条断言并写了说明。）

### 6.2 `check-deps` 的 2 项（非 W3-A 引入）

- `[2d]` 目录 `bin` 不在 `LAYERS` 表里，其依赖永远不被检查
- `[5]` 8 条"import 了但没登记"：`i18n` `blessing` `curse` `rarity` `achievement` `rebind` `gameflow` `accessibility` → `_core`
  （`node scripts/check-deps.js --fix` 可修）

W3-A 的 6 个单元**都不在这 8 条里**，它自己的依赖登记是干净的。

### 6.3 澄清 W3-A 报告里的一处"疑似纰漏"，它是对的

`result_W3-A.md` §5 记"`scripts/check-dup-exports.js` 在仓库里不存在"。
我核了：**仓库里确实只有 `check-dup-exports.py`（3832 字节），没有 `.js` 版**。
是任务书/校验清单里把扩展名写错了。W3-A 如实记录，没有假装跑过——**这条应记为 W3-A 做对了**。

### 6.4 ⚠️ 事故残留 1 处：README 的文件索引行没恢复

`63c0bee` 误删 `旧版本迁移说明.md` 时，顺带删了 `README.md` 里指向它的一行：

```
-| `旧版本迁移说明.md` | **v0230 → v0.39.0 的接口变更**（`save` / `room-graph`）... | 复制分发，务必留 |
```

后续的抢救提交（`8c0b3b5`）把**文件本身**恢复了，但**README 里这行索引没补回来**
（我现在 `grep 旧版本迁移说明 README.md` 仍是 0 命中）。
文件在、索引丢——正是这行注释强调的"复制分发，务必留"的场景会漏文件。建议总审补回。

### 6.5 事故记录（沿用上一版结论，我复核属实）

`63c0bee`（W3-A）在合入自己改动的同时，把 `W7-A` 的交付物**整个删掉**并回退了 4 个单元的修复：

| 文件 | 增删 | 归属 |
|---|---|---|
| `tests/run_phase10_w7a.ts` | -710 | W7-A 回归测试 |
| `audit/result_W7-A.md` / `verify_W7-A.md` | -86 / -96 | W7-A 报告 |
| `旧版本迁移说明.md` | -227 | 顶层文档 |
| `grid/Grid.ts` / `dash/DashController.ts` / `progressbar/ProgressBar.ts` / `objective/ObjectiveSystem.ts` | +13-104 / +9-90 / +11-73 / +1-73 | W7-A 的修复被回退 |

成因是**用 API 建 commit 时 base_tree 未对齐**（parent 是 `70b6134`，内容却来自更早的树）。
**当前状态：已抢救且我复核有效** —— `run_phase10_w7a` 44 项全绿、`grid._writeCell` 已回来。

**给后续所有窗口的硬约束**（沿用并加严）：建 tree 前 `git rev-parse HEAD` 对齐；
提交后 `git diff <parent> <head> --stat` 核对改动范围**只包含自己的文件**。

---

## 7. 给总审的一句话总结

W3-A 这 16 条**可以合并**，修复质量在 16 个窗口里属于上游（62 项用例 29 项真的会红，
对照用例踩的都是本库真出过事的点）。

需要总审拍板的只有一件事：**`snapshot()` 那个"报告说没改、代码改了"的 breaking 改动，追认还是回退**——
我建议追认，但要记进流程台账，并把报告改成实情。

另请顺手处置：`W8-B` 的 binary 红项、README 丢失的索引行。
