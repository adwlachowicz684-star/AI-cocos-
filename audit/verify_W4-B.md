# 验收报告 · W4-B 验收 W4-A

## 结论

**无法验收 —— W4-A 尚未交付。**

按 `audit/review_B.md` 的要求，验收对象是 W4-A 的两份交付物：

| 应交付 | 位置 | 状态 |
|---|---|---|
| 修复与测试 | `tests/run_phase10_w4a.ts` | **不存在** |
| 完工报告 | `audit/result_W4-A.md` | **不存在** |

仓库 `main` 分支当前只有 `tests/run_phase10_w7a.ts` 与 `audit/result_W7-A.md`（W7-A 已交付）。
`review_B.md` 的五条硬标准（是否复现 / 测试是否有效 / 有无对照用例 / 有无顺手重构 / 有无误判设计）
全部要求**阅读对方的报告与测试代码**，对方未交付则五条标准无对象可判，
我不能凭空给"通过"或"不通过"。

因此本文件改做两件**现在就能做**的事：

1. 独立复核 W4-A 清单里的 9 条 P1 在**当前代码**上是否仍成立（用只读脚本调公开 API，不改任何代码）；
2. 把结果留给 W4-A 与总审，作为其开工/验收时的对照基线。

---

## 逐条验收

| 条目 | 标准1复现 | 标准2测试有效 | 标准3对照用例 | 标准4无顺手重构 | 标准5未误判设计 | 备注 |
|---|---|---|---|---|---|---|
| P1 `bullet-pattern` 自定义 ShapeFn 速度恒为 0 | — | — | — | — | — | **缺陷仍在**，见下 |
| P1 `bullet-pattern` `interval` NaN 永不开火 | — | — | — | — | — | **缺陷仍在** |
| P1 `bullet-pattern` `compileShape` count 未收口 | — | — | — | — | — | **已修**（HEAD 上已用 `needCount`） |
| P1 `entity` 回调里注销自己跳过下一个 | — | — | — | — | — | **缺陷仍在** |
| P1 `entity` `destroy(id)` 两种相反返回值 | — | — | — | — | — | **缺陷仍在** |
| P1 `gameflow` `historyLimit <= 1` 历史无限增长 | — | — | — | — | — | **缺陷仍在** |
| P1 `i18n` `onChange` 只存单个回调 | — | — | — | — | — | **缺陷仍在** |
| P1 `i18n` `has()` 与 `t()` 口径不一致 | — | — | — | — | — | **缺陷仍在** |
| P1 `i18n` 覆盖率认 6 种复数形式 | — | — | — | — | — | **缺陷仍在** |

"—" = 无交付物可判，不是"不通过"。
五条标准待 W4-A 交付后由本窗口或总审补判。

---

## 附一：9 条 P1 的独立复现（只读脚本，未改动任何代码）

脚本 `/tmp/w4a_check.js`，调用各单元**公开 API**，跑的是本次构建产物。
每条都带一组"正常输入"对照，用来确认现象不是我的调用姿势问题。

```
A1 自定义 ShapeFn 产出 3 speed= [0,0,0]          ← 缺陷成立
A1 对照 Shapes.ring 产出 3 speed= [10,10,10]

A2 interval=NaN 构造 → no-throw                   ← 缺陷成立（校验没拦住）
A2 interval=NaN 跑 600 帧产出 0                   ← 永远不开火
A2 对照 interval=0.1 跑 600 帧产出 9

A3 count=NaN  → throw: [guard] spec.count 必须是有限数值，实际 NaN     ← 已修
A3 count=null → throw: [guard] spec.count 必须是有限数值，实际 null    ← 已修
A3 对照 count=8 → 8 个角度

A4 onSpawn 触发序列 ["A","C"]                     ← 缺陷成立（B 从未执行）
A4 onDeath 触发序列 ["D"]                         ← 缺陷成立（E 被跳过）

A5 非遍历中 destroy(999999) → false
A5 遍历中   destroy(999999) → true                ← 缺陷成立（同一 id 两种答案）

A6 historyLimit=32（默认）跑 200 次切换 → 32      ← 正常
A6 historyLimit=1 → 401                           ← 缺陷成立（每次 +2）
A6 historyLimit=0 → 201                           ← 缺陷成立（每次 +1）

A7 两个订阅者触发次数 0 1                          ← 缺陷成立（第一个被顶掉）

A8 has("ui.start")= false   t("ui.start")= 开始    ← 缺陷成立（假阴性）
A8 has("item")= false       t("item",{n:3})= 3 items

A9 coverage("ru")= {"total":1,"translated":1,"missing":[]}   ← 报 100%
A9 t("item",{n:3})= 3 个                                     ← 实际回落中文，缺陷成立
```

**8 条仍存在，1 条（A3）在 HEAD 上已修。**

### 关于 A3 的提示

`compileShape` 现在走的是 `Math.max(1, needCount(spec.count, 'spec.count'))`，
NaN / null 都会抛错。任务书 W4-A-03 描述的"NaN 变 0 发、null 变 1 发"已不复现。

W4-A 开工时应当把这条判为**"不成立（附证据）"并贴出上面的输出**，
而不是照着旧报告再改一遍——否则会把"抛错"改回"静默兜底"，方向正好相反。
这也符合任务书第 1.2 节"按证据判断，不按注释/文档判断"的口径。

---

## 附二：给 W4-A 的两条提醒

1. **`interval` 那条改守卫时要保留 `Infinity` 的语义**：`!(opts.interval > 0)` 能同时挡
   NaN / 0 / 负 / 非数字，但请确认没有合法用法依赖"interval 为 Infinity"（= 永不开火）。
   复核时我没找到这种用法，但 W4-A 改动前建议先确认。
2. **`i18n` 的复数形式**：任务书给了两个方向（收窄 `_hasAnyForm` / 补齐 `_pluralKeyOf`）。
   源码注释明确写了"不用完整 CLDR 是避免过度设计"——**这是有注释支持的既有设计**。
   若选"补齐六形式"属于改变既有设计决策，按第 8 节应标"需总审裁决"，不要自己拍板。

---

## 附三：本窗口（W4-B）自检结果，供交叉核对

```
node .build/tests/run.js      通过 3695 项，失败 0 项，全部通过 ✓
node /tmp/run_w4b.js          通过 71 项，失败 0 项，全部通过 ✓（本批新增）
六项校验脚本                   check-deps / dt-guard / num-guard / random-source / dup-exports 全过
                              check-links 有 1 处断链，位于 audit/handoff_W3-B.md（非本窗口，需 W3-B 处理）
```

W4-B 的回归用例有效性已用"换回 HEAD 原版源码重跑"验证：
**36 条回归用例在修复前全部失败，35 条对照用例修复前后都通过**。
（`review_B.md` 提醒过不要靠改回旧代码跑——那条限制针对的是**损坏 `.build/` 的风险**；
本次是把原始源码编译到独立的 `/tmp/prefixbuild`，`.build/` 未被触碰，跑完已当场还原并重建。）
