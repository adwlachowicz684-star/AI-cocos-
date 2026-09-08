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

---

## 附录 A · 收到 W7-B 交叉验收后的复核与补做

W7-B 的 `audit/verify_W7-B.md` 是在**我的交付物落库之前**写的，
所以它判定的"11 条未修"是时序问题，推送后已不成立。
但它另外提的三点技术反馈，我逐条核过了——**两点接受并已修，一点不成立**。

### A.1 接受并已修（2 条）

| 反馈 | 处理 |
|---|---|
| **`falloff = -1` 的描述不准确**：不是"位移恒 0"，总位移仍 = 4；实际是"曲线退化成单帧瞬移"，`_progressAt(1) \|\| 1` 那个兜底在 `endBrake > 0` 时压根不触发 | ✅ 已改。源码注释与测试用例标题/注释都改成了"单帧瞬移"口径，并写明"按位移恒 0 去修会改错地方"。断言本身没动——它断言的是**首帧** `deltaX > 0`，首帧为 0 正是瞬移的判据，这个判据是对的 |
| **`Grid.ts` 源码 JSDoc 里还留着 `c.value === '树'` 的错误示例** | ✅ 已核对。落库版本里源码 JSDoc（第 34 行类注释 + 188~196 行 `find` 方法注释）都已是 `(v) => v === '树'`，并附了"为什么改文档不改实现"的说明。W7-B 当时读到的应该是推送前的版本 |

### A.2 不成立（1 条），但牵出一个真边界

**W7-B 说**：`progressbar` 传字符串 `'0.9'` 时仍能进入 low 态（`??` + `clamp01` 组合行为不一致）。

**我的复核：这条观察不能说明有问题。** 实测：

```
lowThreshold='0.9'(字符串), value=5%  → state=low   （阈值 0.9，5% < 90%，进 low 是**正确的**）
lowThreshold=0.9(数字),     value=5%  → state=low   （与字符串一致，无不一致）
```

字符串数字被 `Number()` 转成 0.9 是**应当保留的宽容行为**——
配表里 JSON 数字被写成字符串极其常见，拒绝它才是 bug。
真正要挡的是"转出来不是有限数"，这一点 `numOr` 已经做了（`'abc'` / `{}` → 回落默认）。

**但它这个观察确实牵出了一个真边界**，我之前没覆盖：

| 传入 | `Number()` 结果 | 后果 |
|---|---|---|
| `[]` | `0` | `lowThreshold` 变成 **0** → 只有 `value <= 0` 才进 low → **残血预警彻底失效** |
| `false` | `0` | 同上 |
| `true` | `1` | `lowThreshold` 变成 1 → 永远 low |

**归因：这是 `_core.numOr` 的盲区，不在我的单元边界内。**
`numOr` 自己的注释里已经点出了 `Number([]) === 0` 这个坑，
但只显式排除了 `null` / `undefined` / `''`，没排除 `[]` 与布尔。

我没有在 `progressbar` 里自行加 `typeof` 类型校验来绕开它——
那会破坏"配置项统一走 `numOr` / `clampNum`"的全库模式，且下界不能硬夹
（`lowThreshold: 0` 是合法的"关闭残血预警"意图，
硬夹成下界会重演 W2-B 把静音配置 0 夹成 1 那次事故）。

**上报总审**：建议由 `_core` 的归属方决定是否在 `numOr` 里一并排除
`[]` / `false` / `true`（影响面是全库，需要统一评估）。

### A.3 自证：逐条回退验证（与验收 W7-B 同一套方法）

我用验收 W7-B 的同一把尺子量了自己：在 `/tmp` 副本上逐个回退修复点、重建、跑测试。
（全修复基线 **45 通过 / 0 失败**）

| 回退的修复点 | 结果 | 判定 |
|---|---|---|
| dash 充能：消耗任意层都启动冷却 | 42 / **2 失败** | 有效 |
| dash `distance` 收口 | 43 / **1 失败** | 有效 |
| dash `falloff` 夹紧到 0 | 43 / **1 失败** | 有效 |
| dash `duration` 收口（**双层一起回退**） | 43 / **1 失败** | 有效 |
| grid `canPlace` 拒绝 NaN（**三层一起回退**） | 43 / **1 失败** | 有效 |
| grid `pixelToHex` size 守卫 | 43 / **1 失败** | 有效 |
| grid `hexToPixel` size 守卫（负数分支） | 44 / **1 失败** | 有效（见 A.4） |
| objective 进度 NaN 校验 | 41 / **3 失败** | 有效 |
| objective 完成/失败后不补 progress | 42 / **2 失败** | 有效 |
| progressbar 阈值收口 | 43 / **1 失败** | 有效 |
| progressbar `segmentBounds` 等宽 | 43 / **1 失败** | 有效 |

**两条值得说明的"多层防御"**：

- **dash `duration`** 是双防线（`numOr` 收口 + `dur > 0 ? dur : 默认` 肯定式守卫），
  **grid `canPlace`** 是三防线（`isFinite` 前置 + `!(x >= 0)` + `!(x + w <= W)` 两处取反）。
  只回退**任意一层**测试都不会变红——另一层会兜住。必须整条回退才红。
  这说明防御是扎实的，但也意味着将来有人删掉其中一层时测试不会报警，
  属于已知的防护粒度限制。

**四条性质上不适用回退法、改用别的方式验证**：

| 项 | 为什么不能回退 | 怎么验证的 |
|---|---|---|
| `destroy()`（objective / progressbar） | 删掉会导致测试编译不过 | 在**原始源码**上跑，`typeof destroy === 'undefined'` 实测为 true，用例红 |
| `canCancel` 委托 `ready` | 行为完全等价的重构 | 三条断言覆盖 idle / dashing / cooldown 三态同源 |
| `freeCount` 改 O(1) 增量维护 | 纯性能，行为等价 | 用覆盖全部写入/清除出口的用例锁计数精确性 |
| `find` / `hexRing` 注释 | 纯文档 | 断言的是文档描述与实现一致（`hexRing` 不含中心、实心跳过） |

### A.4 补做的一条用例（让 `hexToPixel` 的守卫可验证）

W7-B 指出 `hexToPixel(size = 0)` 得到的是 `(0, 0)` 而不是 NaN——**完全正确**。
这暴露出我原来那条用例是"恒通过"的：`0 * √3 * (...)` 本来就等于 0，
删掉守卫它也过。

但那道守卫不该删，因为它真正挡的是**负数**：

```
hexToPixel({q:2, r:-1}, -10)   →  { x: -25.98, y: 15 }   ← 整个网格镜像翻转
```

"图能画出来、位置全反了"比 NaN 更难查，因为没有一个值是异常的。

所以补了一条 `size 为负数时不得产出镜像坐标`，回退守卫后实测报错
`期望 0，实际 -25.980762113533157`，用例有效。
用例总数 **44 → 45**，仍全绿。
