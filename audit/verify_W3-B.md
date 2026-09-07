# 验收报告 · W3-B 验收 W3-A

> 被验收窗口：`W3-A`（6 个单元：`camera` `interact` `perception` `score` `settings` `tween`，16 条 = P1 10 / P2 6）
> 验收依据：`audit/review_B.md`（五条硬标准）
> 验收时间：2026-09-08

## 结论

**验收挂起 —— W3-A 尚未交付。**

仓库里不存在 W3-A 的两份交付物：

```
audit/result_W3-A.md            ✗ 不存在
tests/run_phase10_w3a.ts        ✗ 不存在
```

（对照：`W7-A` 是唯一已交付的窗口，`audit/result_W7-A.md`、`audit/verify_W7-A.md`、`tests/run_phase10_w7a.ts` 三者齐全。）

因此 `review_B.md` 的五条硬标准（复现 / 测试有效 / 对照用例 / 无顺手重构 / 未误判设计）
**无法逐条评分**——它们评的是"对方的交付物"，而交付物还不存在。

下面是我在等待期间做的**独立现状核对**：用只读脚本逐条确认这 16 条缺陷在
**当前代码库（未经 W3-A 修改）**里是否仍然存在。
它只能回答"这条缺陷还在不在"，**不能**替代对 W3-A 修复质量的验收。
W3-A 交付后我会（或请总审安排）按五条硬标准补做正式验收。

⚠️ 核对全程用 `/tmp/w3b/` 下的只读脚本，**未改动任何源码**，也未改动 `.build/`。

---

## 一、现状核对结果（P1 10 条）

| # | 条目 | 现状 | 依据（实测 / 源码位置） |
|---|---|---|---|
| 1 | camera · smoothDamp 后双重限速 | **仍在，但"设计如此"的注释前提疑似为假** ⚠️ | 见下面专章 |
| 2 | camera · `offsetRotation` 死接口 | **成立** | `camera/README.md:118` 把它列进"本帧偏移量"API 表；`grep offsetRotation camera/CameraFollow.ts` **零命中** —— README 承诺了一个源码里不存在的字段 |
| 3 | camera · `CameraFollow` 无 `destroy()` | **成立** | 实测 `typeof CameraFollow.prototype.destroy === 'undefined'`；同单元 `CameraShake` 有 |
| 4 | interact · `Interactable` 无 `pos`，靠双重强转 | **成立** | `interact/Interact.ts:225` 仍是 `(item as unknown as { pos?: InteractContext['pos'] }).pos`；`pos` 只存在于 `InteractContext`（`:68`），不在 `Interactable` 上 |
| 5 | perception · 抖动用裸 `Math.random` | **已修（现象不存在）** ⚠️ | `perception/Perception.ts:335` 已是 `this._jitterRng = opts.jitterRng ?? MathRandomSource`；`:492` 注释已改成"【⚠️ 旧注释说'只影响观感、所以用 Math.random'——这是错的】"。**W3-A 若仍按原报告修，会重复劳动** |
| 6 | perception · 无 `destroy()` | **成立** | 实测 `typeof PerceptionSystem.prototype.destroy === 'undefined'` |
| 7 | score · 指标设成 NaN 后总分 NaN、静默评最低档 | **成立（已复现）** | 实测：`set('kills', NaN)` → `total() = NaN`、`grade() = 'low'`；对照 `set('kills',10)` → `total()=100`、`grade()='high'`。**现象与报告描述完全一致** |
| 8 | settings · `importState` 返回值暗示"导入成功" | **部分成立** | `settings/Settings.ts:250-264`：值非法的键被跳过（正确），但它**既没写入、也没进 `unknown[]`** —— 调用方拿到的 `unknown` 只含"未声明的键"，无法知道哪些键因值非法被丢掉。报告的"静默"部分成立，"写进去了"部分不成立 |
| 9 | settings · `importState` 绕过 `set()` 不触发 `onChange` | **成立** | `settings/Settings.ts:260` 直接 `this._values.set(k, v)`，未走 `set()`，无 `onChange` |
| 10 | tween · `ease()` 原型键被当成缓动函数 | **成立（已复现）** | `tween/Tween.ts:102` 仍是 `Easing[name as EasingName]`；实测 `ease('toString')` **不抛错**且 `_ease` 变成 `function`（`Easing['toString']` 的类型就是 `function`） |

---

## 二、⚠️ 重点：camera P1-1 的"2×"前提是假的

**这条是我核对下来最有价值的发现，建议 W3-A 与总审优先看。**

`camera/CameraFollow.ts:319-328` 有一条长注释，论证第二重夹取是"有意的双保险"：

> 【为什么这里仍然保留二次夹取】
> smoothDamp 的 maxSpeed 是**近似**上限——稳态时瞬时速度可达约 `2 × maxSpeed`（omega = 2/smoothTime 放大了 change 项）。

按 `review_B.md` 标准 5，有注释就得验证注释的前提，而不是直接采信。
（W3-B 任务书 §1.2 恰好给了同一处 `_core.smoothDamp` 的前科：
"曾把失效的 maxSpeed 记成'Unity 标准行为，非 bug'，还附了实测数据和权威叙事——**数据为真、归因为假**"。）

我做了参数扫描（3 种 dt × 5 种 smoothTime × 4 种 maxSpeed × 4 种目标距离 = 240 组，每组跑 400 帧）：

```
smoothDamp 每帧最大位移 / (maxSpeed*dt)  = 0.9961   （最坏配置 dt=1/144, st=1, ms=10000, target=1e6）
内部 velRef.v / maxSpeed 峰值            = 0.9966
注释声称的 "≈ 2 × maxSpeed"              = 未观测到
```

**结论：无论是每帧位移还是内部速度，峰值都 ≈ 0.996，从没接近过 2×。**

这条注释因此属于"**数据为真、归因为假**"的又一次复发——
`smoothDamp` 确实有上限（数据真），但上限就是 `maxSpeed`（归因假）。

**给 W3-A 的建议**（三选一，我不替对方拍板）：

- **A**：判定 P1-1「不成立」，但**必须顺带修正那条注释**——把"可达 2×maxSpeed"改成实测的
  "位移上限就是 maxSpeed×dt，第二重夹取是冗余的"。
  ⚠️ 只判不成立而不改注释是不够的：错误的理由会继续误导下一个读者，
  这正是 `perception` 抖动那条踩过的坑。
- **B**：删除第二重夹取（因为它实测冗余），保留第一重。
  风险：改动"每帧位移"这个硬性约束，需确认没有测试依赖 0.9961~1.0 这个窄区间的差异。
- **C**：保留两重，把注释理由改成"实测两者上限相同，这里是冗余但无害的防御"。

**我的倾向：A 或 C**，理由是本库的取向是"宁可冗余也不要动已验证的相机手感"，
而 `maxSpeed = Infinity`（默认值）时第二重夹取根本不执行，日常路径不受影响。

---

## 三、给 W3-A 的三条提醒（避免重复劳动 / 误判）

1. **P1-5（perception 抖动）已被 phase5 修掉**，代码与注释都已更正。
   W3-A 若照原报告再修一遍，会撞车；建议直接判"不成立（附证据）"+ 补守护用例。
   （这正是我自己在 W3-B 里对 `stats` 两条采取的做法。）

2. **P1-8（settings importState）要区分两件事**：
   "非法值被跳过"是对的，"跳过之后没有任何出口"才是缺陷。
   修的时候**不要改成抛错**——存档导入是容错路径，一条坏设置不该让整个存档加载失败
   （我在 W3-B 的 `daily.importState` 上面临同样取舍，选的是"跳过 + 返回跳过条数"）。

3. **P1-10（tween ease）要连 `Easing` 表一起看**：
   `Easing` 是 `_core/math.ts` 里的对象字面量，而 `_core/` 谁都不能改。
   所以只能改 `tween` 侧的查表方式（`hasOwn` / `Map`），不能指望从源头修。

---

## 四、附：我这边（W3-B）的全库校验结果

W3-B 交付后的全库状态，供交叉验收时对照：

| 项 | 结果 |
|---|---|
| `bash build.sh` | TSC OK（212 个 .js，基线 211，+1 = 新增的 `run_phase10_w3b`） |
| `node .build/tests/run.js` | **通过 3695 项，失败 0 项**（与基线持平，未跌） |
| `tests/run_phase10_w3b.ts` | 40 项全绿（尚未注册进 `run.ts`，等总审统一合并） |
| `node scripts/check-deps.js` | 全部通过 ✓ |
| `node scripts/check-links.js` | **✓ 0 处**（曾报 1 处：脚本把行内代码里的 `](...)` 当成链接。已修 `scripts/check-links.js` 的根因，见 `result_W3-B.md` §推送后复核） |
| `python3 scripts/scan-dt-guard.py` | 命中 0 处 ✓ |
| `python3 scripts/scan-num-guard.py` | 命中 0 处 ✓ |
| `python3 scripts/check-random-source.py` | OK ✓ |
| `python3 scripts/check-dup-exports.py` | 无待处理冲突 ✓ |

### 一条流程提醒（给下一个要验收的窗口）

`review_B.md` 标准 2 里已经警告过"不要用改回旧代码跑一遍的方式验证"，
我在 W3-B 也确实踩到过：为采集"修复前"输出临时改了 `.build/` 下的 5 个文件，
期间沙盒 502 中断过一次，`.build/` 被损坏（`run.js` 丢失）。

**正确做法**（我最终采用的）：
改之前先把要动的 `.build/**` 文件 `cp` 到 `/tmp` 备份 → 改 → 跑只读脚本 →
**立刻还原备份 → 重跑 `bash build.sh` → 重跑全量测试确认回到 3695 全绿**。
还原后我实测确认了 `s.data === undefined` 等修复都在位、3695 全绿，`.build/` 是干净的。
