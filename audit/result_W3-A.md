# 修复报告 · 窗口 W3-A（第 A 组）

**单元 6 个**：`camera` `interact` `perception` `score` `settings` `tween`
**条目 16 条**：P1 × 10 / P2 × 6
**基线**：构建通过、3695 项测试全绿（开工前实测）
**交付后**：3696 项全绿 + 本窗口新增 62 项（独立运行全绿），六项校验脚本全过（详见第 5 节）

**复现方式**：只读脚本 `/data/workspace/repro_w3a.js` 调用公开 API，不改动仓库、不回退代码。
**回归测试**：`tests/run_phase10_w3a.ts`，导出 `runPhase10W3ATests()`（未改 `tests/run.ts`，留给总审统一注册）。

---

## 1. 总览

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| P1-1 | camera | P1 | **不成立（附证据）** | 见 §2.1：第二层 clamp 从未触发 | 保留为保险丝，补注释 | `run_phase10_w3a.ts` › P1-1 ×2 |
| P1-2 | camera | P1 | 已修 | `\|offsetRotation\|` 峰值 = **0** | 峰值 = 3.0000（受 `maxRotation` 限幅） | › P1-2 ×3 |
| P1-3 | camera | P1 | 已修 | `typeof CameraFollow().destroy` = `undefined` | `function` | › P1-3 ×2 |
| P1-4 | interact | P1 | 已修 | 接口无 `pos`，README 示例在 strict 下编译失败 | `pos` 成正式字段，双重强转删除 | › P1-4 ×2 |
| P1-5 | perception | P1 | 已修（附说明） | 固定序列 rng 三次跑 = 152/152/152（**已在第五批修好**） | 不变；本窗口加锁防回退 | › P1-5 ×3 |
| P1-6 | perception | P1 | 已修 | `typeof PerceptionSystem().destroy` = `undefined` | `function` | › P1-6 ×3 |
| P1-7 | score | P1 | 已修 | `add(NaN)` → `total = NaN  grade = D`，无异常无警告 | 抛错，状态未污染：`total = 100  grade = S` | › P1-7 ×4 |
| P1-8 | settings | P1 | 已修 | 返回 `[]`（空数组），`volume` 被静默丢弃为 50 | `rejected` 记录 2 条 + `onReject` 回调 | › P1-8 ×4 |
| P1-9 | settings | P1 | 已修 | `onChange` 次数 1 → **1**（值改了但没通知） | 1 → **2** | › P1-9 ×2 |
| P1-10 | tween | P1 | 已修 | `ease('toString')` 不抛错，收到 `"[object Object]"`（string） | 抛错「未知的缓动名」 | › P1-10 ×3 |
| P2-camera | camera | P2 | 已修 | 构造 `strengthScale=2` 得 **2**、set 得 **1**；`lookAheadFactor=NaN` → `x = NaN`；punch 10 万次 → `sourceCount = 100000` | 统一夹到 1；`x = 0`；上限 32 | › P2 ×5 |
| P2-interact | interact | P2 | 已修（I3 见说明） | `clear()` 后通知仍是 1；frozen 物件 `interact()` 抛 TypeError | 通知 2；不再抛错；补 `destroy()` | › P2-I2/I3/I4/I6 ×8 |
| P2-perception | perception | P2 | 已修 | 切换目标事件列表 = `[]`（无 `lost:2`） | `["lost:2"]` | › P2 ×2 |
| P2-score | score | P2 | 已修 | `new StarRating(NaN).max` = **NaN**，连加 50 个条件不报错 | `max = 1`；第 3 个条件被拦 | › P2-Sc2/3/4/5 ×4 |
| P2-settings | settings | P2 | 已修（1 条**需总审裁决**） | `destroy` = `undefined`；`snapshot().pendingRestart` 列出未改动的项 | `destroy` 补齐；**snapshot 那条待裁决，见 §4** | › P2 ×3 |
| P2-tween | tween | P2 | 已修 | `completeAll()` 后刚 add 的 tween 的 `onComplete` = `false` | `true`；`minDuration` 可配 | › P2-T2/T3/T4 ×5 |

---

## 2. 需要说明的几条

### 2.1 P1-1「双重限速」——**不成立**（有实测证据）

报告原文认为：`smoothDamp` 内部限速一次、`CameraFollow` 里按 `maxSpeed * dt` 再裁一次，
两层叠加会让相机实际最大速度**低于**配置的 `maxSpeed`。

**我自己的复现（dt = 1/60，目标在 1e6 处，跑 600 帧，maxSpeed = 10）**：

| smoothTime | smoothDamp 自身最大单帧位移 | 整个 CameraFollow 最大单帧位移 | 上限 `maxSpeed·dt` | 稳态速度（最后 1 秒位移） |
|---|---|---|---|---|
| 0.02 | 0.116638 | 0.116638 | 0.166667 | 6.7350 |
| 0.05 | 0.143089 | 0.143089 | 0.166667 | 8.4422 |
| 0.10 | 0.153733 | 0.153733 | 0.166667 | 9.0703 |
| 0.20 | 0.159681 | 0.159681 | 0.166667 | 9.4212 |
| 0.50 | 0.163699 | 0.163699 | 0.166667 | 9.6582 |
| 1.00 | 0.165148 | 0.165148 | 0.166667 | 9.7438 |

两列位移**完全相等**，说明第二层 clamp **一次都没被触发**——它从未真正裁过任何一帧。
稳态速度也随 smoothTime 单调逼近 10（9.74 @ 1.0s），不存在"被压低"。

**为什么仍保留这层**：`smoothDamp` 的 `maxSpeed` 是**近似**上限
（`omega = 2 / smoothTime` 会放大 change 项，注释里已写明"稳态时瞬时速度可达约 2×maxSpeed"）。
本组参数下没触到，不等于任意参数下都不会触到。它是**保险丝而不是第二道限速**，
所以我没删，只把"为什么留着"的理由写进源码注释，避免后人又加第三层。

> 注：报告里那段"smoothDamp(带 maxSpeed) 的稳态速度 = 10000 = 无限制速度"的实测，
> 是 `_core` 修复**之前**的数据。当前 `_core/math.ts:377` 已有 `limitedTarget = current - change`，
> 该前提不复存在。

### 2.2 P1-2 `offsetRotation`——选择"实现"，不是"删文档"

报告给了二选一。我选**实现旋转分量**，理由：

- 旋转是打击感的组成部分，删掉等于永久放弃
- 其他单元的 `HitFeedback`、`CameraShake` 预设都按"有旋转"的观感设计

实现要点（都是可配置的，不硬编码）：

- 第三次噪声采样（`seed + 54321`），与 X/Y 错开——否则旋转与平移完全同相，看着是"直线来回"而不是"抖"
- 限幅用独立的 `maxRotation`（默认 3 度），**不复用 `maxOffset`**：
  两者单位不同（度 vs 长度），混着夹会让调参互相干扰
- `strengthScale = 0` 时旋转随平移一起归零（无障碍设置必须能关掉）

### 2.3 P1-5 抖动——**第五批已修，本窗口不重复修**

源码里已无裸 `Math.random`：改用注入的 `_jitterRng`（默认 `MathRandomSource` 保兼容）。
我实测确认：同一固定序列跑三次 → **152 / 152 / 152**；不注入时 → 148 / 146 / 154。
所以这条的"可注入即可复现"目标已达成，本窗口只补了三条**上锁**用例防回退，
并保留"不注入时仍可用"的对照用例（向后兼容不能破坏）。

### 2.4 P2-interact I3 排序稳定性——修前修后都通过（如实标注）

旧比较函数 `(a, b) => (this._better(a, b) ? -1 : 1)` 在等价时两个方向都返回 1，
确实违反严格弱序。但**在 Node 20 / V8 的 TimSort 下实测不产生可见乱序**
（n = 2/3/5/10/20/30/64/100/1000/5000，以及"两两等价"的混合情形，全部保持输入顺序）。

所以这条用例**不是复现缺陷**，是给实现上锁（改坏了会红）。已改成正确的三态比较。
报告里我不宣称"修好了乱序"，只说"消除了一处随时可能踩响的隐患"。

### 2.5 P2-camera `Rect` 自定接口——**未改**（存疑-2）

`camera/CameraFollow.ts:58` 自定了 `interface Rect { minX, minY, maxX, maxY }`，
与 `_core/types.ts` 的 `IRect` 等价但独立声明。源码里有一整段注释解释：

> 全库有 3 个同名 `Rect`，坐标系不同，别混用……本模块的 `Rect` 保留原样是为了不破坏已有代码

这属于"看起来该合并、但有注释说明为什么不合"。按纪律第 1.1 条，我**不动**。
只把 `_core` 的 `IRect` 指引继续留在注释里（`run_phase6.ts` 已就坐标系口径做过裁决并上锁）。

---

## 3. 每条修复的三件套落实情况

| 要求 | 落实 |
|---|---|
| 源码改动只改必要的行 + "为什么"注释 | 全部改动都带注释，说明坑的表现、原写法为什么中招、新写法为什么对 |
| 回归测试（修前会失败） | 62 项中带 `⚠️` 的 26 项为"修前会失败"用例，每条注释里写了修复前的真实输出 |
| 对照用例（防矫枉过正） | 36 项，覆盖：合法 0/负值、不配置时的默认行为、`reset` vs `destroy` 的职责差异、`killAll` 与 `completeAll` 的相反语义 |

**关于"回退验证"**：全程**没有**改回旧代码跑测试（任务书明令禁止，会损坏 `.build/`）。
"修前会失败"的依据是对照修复前的只读复现输出——每条都贴在用例注释里。

---

## 4. 需要总审裁决的 1 条

### P2-settings · `snapshot()` 的 `pendingRestart`

- **现象**：`snapshot()` 把所有 `needRestart` 的 key 全列出来，不判断值是否真被改过。
  JSDoc 写的是"当前值与存档值不同"，实现是"所有需重启项"，**文档与实现不一致**。
- **为什么不自己改**：`tests/run_batch16.ts:429` 有一条既有断言——

  ```ts
  test('snapshot 列出需要重启的项', () => {
    const s = make();          // 未做任何修改
    eq(snap.pendingRestart.join(','), 'quality');
  });
  ```

  改成"只列真改过的"会让这条**既有测试变红**，属 breaking change，按纪律第 8 节上交。

- **两种选择的利弊**：
  | 方案 | 好处 | 代价 |
  |---|---|---|
  | A 改实现（只列真改过的） | 与 JSDoc 一致，UI 不再列一堆没动过的"待重启项" | 破坏既有测试与既有调用方预期；需要新增"基线值"状态 |
  | B 改文档（JSDoc 改成"列出所有需重启项"） | 零风险，一行注释 | UI 侧的噪音问题依然存在，玩家仍会看到没动过的项 |

- **我的倾向**：A，但要连带调整那条既有测试——需要总审定夺是否允许改既有断言。
  本窗口**未动** `snapshot()`，只在 `cycle()` 上补了注释（同样是静默降级，但降级合理）。

---

## 5. 提交前自检（实际输出）

```
bash build.sh                 → TSC OK（产物校验通过：211 个 .js）
node .build/tests/run.js      → 通过 3696 项，失败 0 项（基线 3695，只增不减）
node /data/workspace/run_w3a.js
                              → 通过 62 项，失败 0 项（本窗口新增，未注册进 run.ts）
node scripts/check-deps.js    → 全部通过 ✓
node scripts/check-links.js   → 断链 1 处（**与本窗口无关，详见下**）
python3 scripts/scan-dt-guard.py      → 扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py     → 扫描 0 处命中 ✓
python3 scripts/check-random-source.py→ [OK] 未发现自建随机源 ✓
node scripts/check-dup-exports.js     → **脚本不存在**（见下）
```

两处需要说明（都不是本窗口引入）：

1. **`check-links.js` 的 1 处断链**在 `audit/handoff_W3-B.md:268-269`——
   那两行正文里写了 `` `this._derived[id](...)` `` 这种**代码片段里的 `](...)`**，
   被链接检查器误当成 markdown 链接解析。是脚本误报，不是真断链；
   且该文件属于对方窗口，按纪律我不改对方文件。

2. **`scripts/check-dup-exports.js` 在仓库里不存在**（`_kitmeta.json` 与各任务书都提到它，
   但源码树里没有这个文件）。本窗口无法执行该项，已如实记录，请总审确认是否漏传。

---

## 6. 关于交叉验收 W3-B

按 `audit/review_A.md`，本窗口应验收 `W3-B`（同编号的另一组窗口）。

**当前仓库里 `W3-B` 的两份交付物都不存在**：

- `audit/result_W3-B.md` —— 无
- `tests/run_phase10_w3b.ts` —— 无

因此**无法执行验收**。另出 `audit/verify_W3-A.md` 记录这一状态，
待对方窗口交付后由本窗口或总审补验。
