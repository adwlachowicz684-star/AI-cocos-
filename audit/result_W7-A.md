# 精审返工结果 · 窗口 W7-A（第 A 组）

> 单元：`dash` `grid` `objective` `progressbar`
> 条目：12（P1 4 / P2 8）
> 测试：`tests/run_phase10_w7a.ts`（**44 项，全绿**）
> 基线：`bash build.sh` 通过；`node .build/tests/run.js` **3695 → 3695**（既有全绿，一条没掉）
> 校验：check-deps / check-links / scan-dt-guard / scan-num-guard / check-random-source 全过
>
> 两点环境说明：
> - `scripts/check-dup-exports.js` **在仓库里不存在**（基线就跑不了），未列入自检；
> - `check-links` 报的 1 处断链在 `audit/handoff_W3-B.md`，我用原始包跑过，**基线上就有**，不是本窗口引入的。

---

## 交付清单

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| 1 | dash | P1 | 已修 | 用掉 1 层后 `chargesLeft=1 cdLeft=0`；等 5 秒后 `chargesLeft=1`（期望 2） | 用掉一层即启动冷却，5 秒后 `chargesLeft=2` | `run_phase10_w7a.ts` › dash · 多层充能的冷却启动时机 |
| 2 | dash | P1 | 已修 | `duration=NaN → deltaX=NaN deltaY=NaN`；`distance=NaN → deltaX=NaN` | 两者均回落到默认，位移恒为有限数 | `run_phase10_w7a.ts` › dash · duration / distance 的有限性收口 |
| 3 | grid | P1 | 已修 | `canPlace('h', NaN, 3)=true`；`place` 返回 `h#1`，全图扫描占用格数 `0`，`freeCount=100`，二次 `place` 返回 `null` | `canPlace` 返回 false、`place` 返回 null、`placedCount=0`、`freeCount=100` | `run_phase10_w7a.ts` › grid · NaN 坐标的放置校验 |
| 4 | grid | P1 | 已修 | 照文档写 `c.value==='树'` → **0 条**；按实现 `v==='树'` → 1 条 | 文档与 JSDoc 改为真实签名（保留实现，避免 breaking） | `run_phase10_w7a.ts` › grid · find 回调签名与文档一致 |
| 5 | dash | P2 | 已修（附说明） | 一次冲刺全程只出现 `dashing`，`recovery` 从未被赋值；`canCancel()` 与 `ready` 逐字重复；`falloff=-1` 首帧 `deltaX=0`（全程 0 位移 + 末帧瞬移） | 补注释标明 recovery 是预留态；`canCancel` 委托 `ready`；falloff 夹紧到 0 | `run_phase10_w7a.ts` › dash · 状态机与衰减指数 |
| 6 | grid | P2 | 已修（附说明） | `hexRing(center,1).length=6`（注释写"含中心"）；`pixelToHex(25,-8,0)` 产出 ±Infinity；`freeCount` 每次全扫（50×50 读 2000 次约 8ms） | 注释改正；size 非法返回原点；`freeCount` 改 O(1) 增量维护 | `run_phase10_w7a.ts` › grid · 六边形与计数 |
| 7 | objective | P2 | 已修 | 事件序列 `activated/0 \| completed/10 \| progress/10`（完成后补发进度） | `activated/0 \| completed/10`，终态后不再补 progress | `run_phase10_w7a.ts` › objective · 事件顺序 |
| 8 | objective | P2 | 已修 | `setProgress(NaN)` → `status=active progress=NaN`，并上报 `progress/NaN` | 非有限值拒绝写入，保留上一次有效进度，不上报 NaN | `run_phase10_w7a.ts` › objective · 进度的有限性校验 |
| 9 | objective | P2 | 已修（附说明） | `typeof sys.destroy === 'undefined'`；`reset()` 不触发任何事件 | 补 `destroy()` 断开三个回调；`reset()` 保持静默并写进 JSDoc | `run_phase10_w7a.ts` › objective · 可卸载与重置语义 |
| 10 | progressbar | P2 | 已修 | `lowThreshold=NaN, value=5% → state=normal`（对照组默认阈值 → `low`） | 回落默认 0.25 → `state=low` | `run_phase10_w7a.ts` › progressbar · 阈值的有限性收口 |
| 11 | progressbar | P2 | 已修 | 3 段 gap=0.02 段宽 `0.3233 / 0.3133 / 0.3233`（中间段窄 gap/2） | 三段等宽 `0.32 / 0.32 / 0.32`，首末贴边 | `run_phase10_w7a.ts` › progressbar · 分段空隙的对称分摊 |
| 12 | progressbar | P2 | 已修（附说明） | `max=NaN` 构造不抛错且 `ratio=NaN`；`typeof bar.destroy === 'undefined'` | min/max 用 `numOr` 收口（NaN/Infinity 回落默认），ratio 恒有限；补 `destroy()` | `run_phase10_w7a.ts` › progressbar · 构造校验与可卸载 |

**无"不成立"条目。** 12 条全部独立复现成功（复现输出均为本窗口实跑，非抄原报告）。

---

## 复现方式（可重放）

修复前的输出是用**原始源码包**单独编译后跑出来的（不是读代码推断）：

```
tar -xzf 仓库包 → 原始 4 个源文件 + 测试副本 → tsc → node
结果：通过 25 项，失败 19 项
```

失败的 19 项覆盖上表全部 12 条修复点（其中"连冲两层不重置冷却""Infinity 坐标同样拒绝"
属于防回归补充用例，修复前的行为也一并记录）。修复后同一份用例 **44 项全过**。

---

## 改动范围（没有顺手重构）

| 文件 | 改动性质 |
|---|---|
| `dash/DashController.ts` | 构造函数 3 个字段收口 + `tryStart` 一行冷却逻辑 + `canCancel` 委托 + 注释 |
| `grid/Grid.ts` | `canPlace` 前置校验 + `find` 注释 + `hexRing` 注释 + `hexToPixel/pixelToHex` 守卫 + `freeCount` 增量维护 |
| `objective/ObjectiveSystem.ts` | `setProgress` 加有限性校验与终态早退 + 新增 `destroy()` + 注释 |
| `progressbar/ProgressBar.ts` | 构造函数 4 个字段收口 + `segmentBounds` 算法 + 新增 `destroy()` + 注释 |

`_core/` 未动；`tests/run.ts` 未动（按任务书交给总审统一合并注册）；
`README.md` 未动。

---

## 需总审裁决的三处

1. **dash 的 `recovery` 状态**（编号 5）
   两种选择：
   - A（本窗口做法）：保留类型成员、注释标明"预留位、当前不会赋值"。
     优点：不 breaking，所有 `state === 'idle'` 的调用方行为不变。
     缺点：类型与实际仍有落差，调用方可能写出永不执行的分支。
   - B：真的实现 `dashing → recovery → idle`。
     缺点：冲刺结束后 `state` 多一个非空值，会改变全部"能否再次冲刺 / 能否被打断 /
     动画机切回待机"的判定；且"恢复期时长"没有配置出处，硬编码违反铁律 4。
   我倾向 A，但 B 若与别的单元有约定（比如动画机已经按 recovery 写好了），请裁决。

2. **progressbar 的 `min` / `max` 为 NaN 是"回落默认"还是"抛错"**（编号 12）
   - A（本窗口做法）：`numOr` 收口到默认 0 / 100，与全库模式 B 一致。
     风险：配表填错被静默纠正，问题被藏起来。
   - B：构造时抛错。
     风险：血条建不出来 → 整块 UI 挂掉，把"一份配置错"升级成"功能不可用"。
   本单元已有 `max <= min` 的抛错传统，两者并不完全一致，请裁决。

3. **objective 的 `reset()` 静默**（编号 9）
   我保留了"不发事件"的行为并写进 JSDoc（理由：reset 是回到初始快照，不是状态迁移）。
   如果 UI 侧已经依赖"reset 后收到事件来刷新"，需要改成发事件——那要连事件类型一起定，
   属于跨单元约定，请裁决。
