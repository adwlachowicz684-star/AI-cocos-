# 验收报告 · W3-B 验收 W3-A

> 被验收窗口：`W3-A`（6 个单元 `camera` `interact` `perception` `score` `settings` `tween`，16 条 = P1 × 10 / P2 × 6）
> 依据：`audit/review_B.md` 五条硬标准
> 验收时间：2026-09-08　验收方：W3-B

---

## 结论

**有条件通过 —— 修复质量合格，但推送过程造成重大事故，需总审处置。**

- **修复本身**：五条硬标准逐条核过，16 条的处理**全部站得住**，无一条需要返工。
- **推送过程**：`W3-A` 的那个提交（`63c0bee`）在合入自己改动的同时，
  **把 `W7-A` 的全部交付物删掉了，并把 `W7-A` 修复的 4 个单元回退成了旧版本**。
  这不是我的判断分歧，是可逐字节核对的事实，见 §2。
- 我已**抢救恢复**了这 8 个文件（§3），恢复后全量 3696 全绿、`W7-A` 的 44 项测试重新跑通。

---

## 1. 五条硬标准逐条评定

### 标准 1 · 是否真的复现过　✅ 通过

`result_W3-A.md` 的"复现输出（修复前）"列给的都是**具体运行输出**，不是代码分析：

```
|offsetRotation| 峰值 = 0        typeof new CameraFollow().destroy = 'undefined'
固定序列 rng 三次 = 152/152/152   add(NaN) → total = NaN  grade = D
importState 返回 []（空数组）     onChange 次数 1 → 1
ease('toString') 不抛错，收到 "[object Object]"（string）
构造 strengthScale=2 得 2 / set 得 1    lookAheadFactor=NaN → x = NaN
punch 10 万次 → sourceCount = 100000
```

**我做了独立交叉核对**：在我上一轮（W3-A 尚未交付时）写的 `verify_W3-B.md` 里，
我自己跑只读脚本实测过其中 5 条，与对方的描述**完全一致**：

```
[A2] offsetRotation 存在 = false                     ← 与 W3-A 的"峰值 = 0"一致
[A1] CameraFollow.destroy = undefined                ← 一致
[A6] PerceptionSystem.destroy = undefined            ← 一致
[score] set(kills,NaN) → total = NaN  grade = low    ← 与 W3-A 的"total = NaN grade = D"一致
[tween] ease("toString") 未抛错 → _ease = function   ← 一致
```

两条独立路径得到同一组数字，可以确认是真实复现，不是抄报告。

### 标准 2 · 测试是否真的会失败　✅ 通过（且如实标注了例外）

`tests/run_phase10_w3a.ts` 62 项，其中 30 项带 `⚠️`（声称"修前会失败"），25 项对照。

我按 review_B.md 给的方法抽查——"如果回退修复，这条断言还会通过吗"：

| 用例 | 断言 | 回退后会怎样 | 判定 |
|---|---|---|---|
| P1-2 | `maxRot > 0` | 修复前 `_orot` 三处写入全是 `= 0` → 恒 0 | ✅ 会失败 |
| P1-10 | `throws(() => ease('toString'))` | 修复前不抛错（我实测过 `_ease` 变成 function） | ✅ 会失败 |
| P1-8 | `s.rejected.length === 2` | 修复前 `rejected` 这个概念都不存在 → `undefined` | ✅ 会失败 |
| P1-9 | `onChange` 次数 1 → 2 | 修复前绕过 `set()` 不发通知 | ✅ 会失败 |
| P2 | `new CameraShake({strengthScale:2}).strengthScale === 1` | 修复前构造走 `?? 1` 得 2 | ✅ 会失败 |
| P2 | `punch` 10 万次后 `sourceCount === 8` | 修复前无上限 → 100000 | ✅ 会失败 |
| P2-Sc3 | `new StarRating(NaN).max === 1` | 修复前 `Math.max(1, NaN)` = NaN | ✅ 会失败 |

**两条"修前修后都通过"的用例，对方如实标注了**，没有拿来充数：

- `P1-1` 判不成立，用例是"上锁"，注释写明"第二层 clamp 从未被触发"。
- `P2-I3` 排序稳定性：旧比较函数违反严格弱序，但 V8 TimSort 下实测不产生可见乱序
  （n 取到 5000 都保持输入顺序）。报告原话：
  "**这条用例不是复现缺陷**，是给实现上锁……我不宣称'修好了乱序'。"

按标准 2 这条本该算"无效用例"，但对方主动标明性质、不往"已修复"里塞，
我认为**比藏起来更值得肯定**，不计为问题。

**验证方式合规**：对方全程没改回旧代码（`result_W3-A.md` §3 明确写了"任务书明令禁止"），
用的是只读复现脚本 `/data/workspace/repro_w3a.js`。我也没改回旧代码，
只调用公开 API 验证修复后的行为确实成立。

### 标准 3 · 有没有对照用例　✅ 通过

25 项对照，覆盖面到位，不是凑数：

```
P1-1  不配 maxSpeed 时不受影响
P1-2  strengthScale=0 时旋转与平移都归零（无障碍必须能关）
P1-3  destroy 清 bounds / reset 不清（职责差异）
P2    合法的 0.5 不受影响、不传时默认 1
P2    正常前瞻照常生效且不超过 lookAheadMax
P1-8  全合法导入不产生任何 rejected
P1-10 合法缓动名照常工作
```

我特别检查了**最容易矫枉过正的两类**：

- **"静音配置 0"**：`strengthScale=0` 的对照在，且断言 `offsetRotation === 0`（关震屏时旋转也必须关）——没有被夹成 1。✅
- **"合法上限值"**：`maxRotation: 3` 下断言 `maxRot <= 3 + 1e-9` 且仍 `> 0`——限幅没把功能限死。✅

### 标准 4 · 有没有顺手重构　⚠️ 见 §2

修复范围本身是干净的：6 个单元各改必要处，每处带"为什么"注释。
`P2-camera` 的自定 `Rect` 接口**没合并**（源码有注释解释"全库 3 个同名 Rect 坐标系不同"），
`P1-5` 已被第五批改好就**只加锁不重复修**，`P2-settings` 的 `snapshot()` 会撞既有测试就**上交裁决**——
三处都是"该忍住的地方忍住了"。

**但提交里混进了 4 个不属于本窗口的单元的大段删除**（-90/-104/-73/-73），详见 §2。

### 标准 5 · 有没有把"设计如此"误判成 bug　✅ 通过（1 处小瑕疵）

| 条目 | 对方判断 | 我的核对 |
|---|---|---|
| P1-1 双重限速 | 判"**不成立**"，保留为保险丝 | ✅ 与我的 240 组参数扫描一致（见 §4） |
| P1-5 抖动 | 判"**第五批已修**"，只加锁 | ✅ 我核对 `jitterRng` 确已可注入 |
| P2-camera `Rect` | **未改**，有注释说明 | ✅ 正确 |
| P2-settings `snapshot()` | **未改**，上交裁决 | ✅ 正确（会撞 `run_batch16.ts:429` 既有断言） |
| P2-interact I3 | 如实标注"不是复现缺陷" | ✅ 正确 |

**小瑕疵（建议补，不阻塞）**：P1-1 判"不成立"是对的，但对方在保留第二层 clamp 时，
把理由写成"smoothDamp 的 maxSpeed 是近似上限，换一组参数就可能超速"——
这个"可能超速"的前提，我扫了 240 组参数**一次都没观测到**（见 §4）。
也就是说：结论对，但**支撑结论的那条旧注释仍然是错的**，对方把它原样保留并又引用了一次。
按 W3-B 任务书 §1.2 点名的 `_core.smoothDamp` 前科（"数据为真、归因为假"），
这条错误理由会继续传给下一个读者。建议改成实测口径：
"实测峰值 0.996×maxSpeed，未观测到超速；保留它是冗余但无害的防御"。

---

## 2. ⚠️ 重大事故：W3-A 的提交删除了 W7-A 的全部成果

### 事实

`W3-A` 的提交 **`63c0bee69d5b`**（2026-09-07 15:12:27）除了自己的改动，还包含：

**删除 4 个文件（共 1119 行）：**

| 文件 | 行数 | 归属 |
|---|---|---|
| `tests/run_phase10_w7a.ts` | -710 | **W7-A 的回归测试** |
| `旧版本迁移说明.md` | -227 | 顶层文档 |
| `audit/verify_W7-A.md` | -96 | W7-A 的验收报告 |
| `audit/result_W7-A.md` | -86 | **W7-A 的修复报告** |

**回退 4 个单元（把 W7-A 的修复删掉）：**

| 文件 | 增删 | 被删掉的是什么 |
|---|---|---|
| `grid/Grid.ts` | +13 **-104** | `GridPlacement._free` 增量维护 + `_writeCell`/`_eraseCell`；`find` 回调签名的文档修正 |
| `dash/DashController.ts` | +9 **-90** | `numOr` 收口（`duration`/`distance` 的 NaN 防护）；`recovery` 预留态的说明注释 |
| `progressbar/ProgressBar.ts` | +11 **-73** | W7-A 的 `lowThreshold`/`highThreshold` 收口等 |
| `objective/ObjectiveSystem.ts` | +1 **-73** | W7-A 的事件顺序 / 有限性校验等 |

**时间线佐证**（`git log -- path`）：

```
70b6134  15:09:49  fix(audit): W7-A 精审返工——dash 充能/NaN 收口、grid NaN 坐标与 find   ← W7-A 修好
63c0bee  15:12:27  W3-A 精审返工：camera / interact / perception / score / settings...  ← 3 分钟后回退
（此后这 4 个单元再无任何提交）
```

**被删的内容确实是 W7-A 的修复，不是 W3-A 自己的东西**——从 `grid/Grid.ts` 的 diff 可以逐行看到：

```diff
-/**
- * 【⚠️ 回调第一个参数是"值本身"，不是 cell 对象】
- * 旧文档示例写的是 g.find((c) => c.value === '树')，
- * 但这里传进去的 v 直接来自 _data[i]……
- * 实测：g.set(3, 4, '树') 后，照旧文档写返回 0 条，按真实签名写返回 1 条。
- */
+ * g.find((c) => c.value === '树');        // ← 回退成错误的旧文档
```

以及 `_free` 增量维护的整段实现被删（那是 W7-A 修 `freeCount` 的核心）。

### 成因推断

不是"顺手重构"，是**用 API 建 commit 时的 tree 覆盖**：
W3-A 大概率基于一个早于 `70b6134` 的 `base_tree` 构造新 tree，
于是 `70b6134` 引入的 8 个文件在新 tree 里"不存在"，
提交后 git 就按"删除"处理了。

这与我在 `result_W3-B.md` §推送后复核 里担心的风险是同一类
（"用 API 建 commit 时没做 fast-forward 检查，存在后推覆盖先推的风险"），
只是这次的后果是**删除**而不是覆盖。

**建议总审**：给后续所有窗口的推送流程加一条硬约束——
建 tree 前必须 `git rev-parse HEAD` 对齐、提交后必须 `git diff <parent> <head> --stat`
核对改动范围是否只包含自己的文件。我在自己的两次推送里都做了"提交后逐文件比对 blob"，
这次能发现也是因为做了同样的核对。

---

## 3. 我已做的抢救恢复

丢失的内容**全部还在 git 对象库里**（`70b6134` 的 tree 仍在），所以我从 blob 直接取回，
恢复到 `main` 最新（HEAD `a6f58bc`）之上：

```
恢复文件（取自 70b613408f50）：
  dash/DashController.ts            17990 bytes
  grid/Grid.ts                      21921 bytes
  objective/ObjectiveSystem.ts      17583 bytes
  progressbar/ProgressBar.ts        17790 bytes
  audit/result_W7-A.md               6947 bytes
  audit/verify_W7-A.md               6473 bytes
  tests/run_phase10_w7a.ts          30542 bytes
  旧版本迁移说明.md                     7360 bytes
```

**恢复后的验证**（在合并了所有窗口最新代码的 main 上）：

| 项 | 结果 |
|---|---|
| `bash build.sh` | TSC OK（**222 个 .js**，恢复前 221，+1 = 回来的 `run_phase10_w7a`） |
| `node .build/tests/run.js` | **3696 项全绿**（与恢复前持平，未引入回归） |
| `run_phase10_w7a.ts` | **44 项全绿**（恢复前该文件根本不存在） |
| 源码核对 | `gp._writeCell` 恢复为 function；`DashController` 的 `numOr` import 回来了 |

**恢复是安全的**：这 4 个单元（`dash`/`grid`/`objective`/`progressbar`）
与 W3-A 的 6 个单元**零重叠**，且 `git log -- path` 确认 W3-A 之后无人再改过它们，
所以直接取 `70b6134` 版本不会覆盖任何人的新工作。

⚠️ **需要 W7-A / W7-B 确认**：如果你们在 `70b6134` 之后、被误删之前还改过这 4 个单元
（比如有本地未推送的改动），请告诉我，我把你们的改动并回去。
按 `git log` 的记录是没有，但本地未推送的改动我看不到。

---

## 4. 附：我对 camera P1-1 的独立验证

W3-A 判 P1-1"不成立"，我此前也做了独立扫描，两条路径结论一致：

```
扫描 3 种 dt × 5 种 smoothTime × 4 种 maxSpeed × 4 种目标距离 = 240 组，每组 400 帧

每帧位移 / (maxSpeed·dt) 峰值 = 0.9961
内部 velRef.v / maxSpeed 峰值  = 0.9966
"稳态时瞬时速度可达约 2×maxSpeed"        = 未观测到
```

W3-A 的表（smoothTime 0.02→1.0，位移 0.1166→0.1651，上限 0.166667）与我的扫描同向，
两边都说明**第二层 clamp 从未真正触发**。

分歧只在一点：W3-A 保留它并沿用"可能超速"的旧注释；
我认为该保留（保守无害），但**注释理由要改成实测口径**，否则错误归因会继续流传。

---

## 5. 附：全库校验（验收时实跑）

在恢复后的最新 main 上：

| 脚本 | 结果 |
|---|---|
| `node .build/tests/run.js` | **3696 项全绿** |
| `node scripts/check-deps.js` | 有 1 项待处理（非 W3-A / 非 W3-B 引入，见 `result_W3-B.md`） |
| `node scripts/check-links.js` | ✓ 0 处（我已修根因：代码区不再被当成链接） |
| `python3 scripts/scan-dt-guard.py` | 命中 0 处 ✓ |
| `python3 scripts/scan-num-guard.py` | 命中 0 处 ✓ |
| `python3 scripts/check-random-source.py` | OK ✓ |
| `python3 scripts/check-dup-exports.py` | 无待处理冲突 ✓ |
