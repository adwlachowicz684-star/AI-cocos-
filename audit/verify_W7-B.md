# 交叉验收报告 · W7-B 验收 W7-A（第 B 组）

| 项 | 值 |
|---|---|
| 被验收窗口 | `W7-A` |
| 验收方 | `W7-B`（第 B 组，同编号） |
| 被验收单元 | `dash` / `grid` / `objective` / `progressbar` |
| 条目 | 12（P1 × 4，P2 × 8） |
| 验收时间 | 本窗口自身修复完成之后 |
| 验收方式 | 逐条独立复现（脚本放 `/tmp`，直接跑 `.build/` 产物），**未改动对方任何代码** |

---

## 0. 一句话结论

**截至本次验收，`W7-A` 的交付物（`audit/result_W7-A.md`、`tests/run_phase10_w7a.ts`）尚未落库**，
源码也**未见对应修复**——12 条现象我逐条复现，**11 条原样存在**。

另有 **1 条现象描述与实测不符**（`dash` 的 `falloff = -1`），
**1 条已被修了一半**（`grid` 的 `find` 文档），详见 §2。

按纪律，我只写报告、不改对方代码。

---

## 1. 交付物核对

| 应交付 | 实际 |
|---|---|
| `audit/result_W7-A.md` | **不存在** |
| `tests/run_phase10_w7a.ts` | **不存在** |
| `tests/run.ts` 里的注册 | **不存在** |
| 源码修复（4 个单元） | **未检出**（12 条现象中 11 条原样复现） |

---

## 2. 逐条验收

### P1（4 条）

| # | 条目 | 复现结果 | 判定 |
|---|---|---|---|
| 1 | `dash` 多层充能永远回不满 | `charges=2`：`tryStart` → 跑完 → `chargesLeft=1`；再等 **5 秒**（cooldown 0.5s）→ **仍为 1**（期望 2）。对照组用掉 2 层后等 5 秒 → 恢复到 2 | **属实，未修** |
| 2 | `dash` `duration` / `distance` 未收口 | `duration=NaN` → `deltaX = NaN, deltaY = NaN`；`distance=NaN` → 同样 NaN。对照组 `deltaX = 0.8419595...`（有限） | **属实，未修** |
| 3 | `grid` NaN 坐标能"放置成功" | `canPlace('h', NaN, 3)` → **true**；`place(...)` 返回 `h#1`；`at(NaN,3)` 能查到；**全图 10×10 扫描到占用格数 = 0**；`freeCount = 100`。对照组正常放置 2×2 → 扫描到 4 格、`freeCount = 96` | **属实，未修**（与报告描述逐字吻合） |
| 4 | `grid` `find` 示例签名错误 | README 第 14 行**已是正确写法** `g.find((v) => v === '树')`；但 **`Grid.ts` 源码 JSDoc（第 34 行）仍是 `g.find((c) => c.value === '树')`**。实测回调第一个参数确为**值本身**：`find((v) => v==='树')` → 1 条；`find((c)=>c.value==='树')` → **0 条** | **属实，但只修了一半**——README 已改，源码 JSDoc 未改 |

### P2（8 条）

| # | 条目 | 复现结果 | 判定 |
|---|---|---|---|
| 5 | `dash` `'recovery'` 是死状态 | 跑满 120 帧，出现的状态只有 `['idle','dashing']`，从未出现 `recovery` | **属实，未修** |
| 6 | `dash` `canCancel()` 与 `ready` 冗余 | idle：`{canCancel:true, ready:true}`；dashing：`{canCancel:false, ready:false}`——两态下完全一致 | **属实，未修** |
| 7 | `dash` `falloff = -1` → `norm` 兜底为 1 → 位移恒 0 | **不成立（有实测证据）**：`falloff=-1` + 默认 `endBrake=0.15`，总位移 = **4**（与配置距离一致，不是 0）；`endBrake=0` 时总位移**同样是 4**。逐帧位移：`endBrake=0` → `[0×12, 4, 0, 0]`（**全部位移压在第 13 帧**）；`endBrake=0.15` → 位移集中在最后 15%（第 11、12 帧 2.347 / 1.653）。对照组 `falloff=2` → 前重后轻的正常曲线 | **现象描述不准确**：位移并未变成 0（`_progressAt(1)` 在 `endBrake>0` 时返回 1，兜底 `\|\| 1` 根本没触发）。**但 `falloff=-1` 确实让曲线退化成"单帧瞬移"**——建议改成在文档里约束 `falloff > -1`，而不是按"位移恒 0"去修 |
| 8 | `grid` `hexRing` 注释说谎 | 注释写"半径 n 内的**所有**格子（**含中心**）"；实测 `hexRing(c,1).length = 6`、`hexRing(c,2).length = 12`、`hexRing(c,0).length = 1`；`hexSpiral(c,1).length = 7` | **属实，未修** |
| 9 | `grid` `hexToPixel` / `pixelToHex` 的 `size = 0` | `hexToPixel({q:3,r:-2}, 0)` → `{x:0, y:0}`——**不是 NaN**（乘法不含除零）；`pixelToHex(10,10,0)` → `{q:Infinity, r:Infinity}` → 经 `hexRound` 后落为 NaN | **部分属实**：只有 `pixelToHex` 真会产出非有限值；`hexToPixel` 是**静默塌陷到原点**（同样需要防，但现象不是"除零得 NaN"）。建议修法写成"两个函数都加 `size` 正性校验" |
| 10 | `objective` 完成事件顺序颠倒 | `forceActivate('k')` → `setProgress('k',10)` → 事件序列 `["activated/0", "completed/10", "progress/10"]`——**completed 之后又补发一条 progress**。对照组中途进度：`["activated/0","progress/4"]`（正常） | **属实，未修** |
| 11 | `objective` `setProgress` / `addProgress` 不校验有限性 | `setProgress('k', NaN)` → 事件 `progress/NaN`，`status = 'active'`，`progress = NaN`；`addProgress('k', NaN)` 同样污染成 NaN | **属实，未修** |
| 12 | `objective` 无 `destroy()`；`reset()` 不触发 `onEvent` | `typeof o.destroy === 'undefined'`（确认缺失）；`reset()` 前后事件数 `2 → 2`，确实一条不发 | **属实，未修** |
| 13 | `progressbar` `lowThreshold` / `highThreshold` 未收口 | `max=100, value=5, lowThreshold=NaN` → `state = 'normal'`（**应为 low**）；对照组默认 0.25 → `state = 'low'`。另：传字符串 `'0.9'` 时仍能进入 low 态（`??` + `clamp01` 的组合行为不一致） | **属实，未修** |
| 14 | `progressbar` `segmentBounds` gap 分摊不对称 | `segments=3, gap=0.02`：三段宽度 `0.32333 / 0.31333 / 0.32333`——**两端比中间宽 gap/2 = 0.01** | **属实，未修** |
| 15 | `progressbar` 构造校验挡不住 NaN；无 `destroy()` | `new ProgressBar({min:0, max:NaN, value:5})` **构造成功**（`_max <= _min` 对 NaN 恒 false），`snapshot().ratio = NaN`；`typeof b.destroy === 'undefined'` | **属实，未修** |

> 说明：任务书把 `progressbar` 的三条记为 P2 三小项，这里拆成 3 行（#13~#15）逐条给证据；
> 单元条目总数仍为 12（#7 判不成立、#4 判"半修"）。

---

## 3. 需要回报给 W7-A / 总审的三点

1. **#7 的证据不成立，但问题本身存在。**
   建议 W7-A 改判为"已修（附说明）"或"需总审裁决"：
   `falloff = -1` 的实际后果是**位移曲线退化成单帧瞬移**（总距离仍正确），
   不是"位移恒 0"。按原描述去修会改错地方——
   `_progressAt(1) || 1` 那个兜底在 `endBrake > 0` 时压根不会触发。

2. **#9 的描述要收窄。**
   `hexToPixel` 在 `size=0` 时得到的是 `(0,0)` 而不是 NaN。
   如果验收按"两个函数都会除零得 NaN"来写用例，`hexToPixel` 那条会失败。

3. **#4 只修了 README，源码 JSDoc 还留着错误示例。**
   `Grid.ts` 第 34 行的 `g.find((c) => c.value === '树')` 是大多数人读文档的地方
   （源码 JSDoc 往往比 README 更常被 IDE 提示出来）。建议一并改掉。

---

## 4. 验收纪律声明

- 本次验收**没有修改** `dash` / `grid` / `objective` / `progressbar` 的任何一行源码、
  也没有改它们的 README——避免与 W7-A 窗口冲突。
- 所有复现脚本写在 `/tmp` 下，跑完即弃，未留在仓库内（放 `verify/` 会触发 `check-deps.js` 报错）。
- 本窗口自身改动仅涉及 `achievement` / `curve` / `expression` 三个单元，与被验收单元零重叠。
