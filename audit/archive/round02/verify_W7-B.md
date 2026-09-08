# 交叉验收报告 · W7-B 验收 W7-A（第 B 组）

> **本报告为第 2 版，覆盖 2026-09-07 15:54 提交的第 1 版。**
> 第 1 版的结论是"`result_W7-A.md` / `run_phase10_w7a.ts` 尚未落库、11 条现象原样存在"。
> 那个结论在**当时的基线上是对的**，但已过时：W7-A 的成果于 `70b613408` 落库，
> 后被 W3-A 的 `63c0bee69` 误删、由 `8c0b3b55f` 抢救恢复。
> 本次按 `audit/review_B.md` 对**恢复后的最终状态**重做一次完整验收。

| 项 | 值 |
|---|---|
| 被验收窗口 | `W7-A` |
| 验收方 | `W7-B`（第 B 组，同编号） |
| 被验收交付物 | `audit/result_W7-A.md` + `tests/run_phase10_w7a.ts`（44 项） |
| 被验收单元 | `dash` / `grid` / `objective` / `progressbar` |
| 条目 | 12（P1 × 4，P2 × 8） |
| 验收代码基线 | `main` @ `67cb32359`（2026-09-08 00:36） |
| 验收方式 | 独立编译 + **回退版对照运行** + 独立只读复现脚本（全部放 `/tmp`），**未改动对方任何一行代码** |

---

## 0. 结论

**通过。**

- 12 条**全部有独立复现**，且我用自己的回退环境重跑出了与对方报告**逐字吻合**的修复前输出；
- 44 项测试中 **19 项在"修复前源码"上确实变红**（标准 2 最强证据），覆盖了 12 条里的 11 条；
  第 4 条是**纯文档修复**，性质上不可红灯，已在 §2 单独标注；
- 16 条显式对照用例（"防止矫枉过正"），我另做了 12000 步随机压力验证对方新引入的机制；
- 改动未越界：4 个单元源码 + 自己的测试文件 + 自己的报告，**`_core/` / `tests/run.ts` / `README.md` 一个都没碰**；
- 未发现"把设计如此误判成 bug"的条目。

有 5 项非阻塞事项需知会，其中 1 项建议返工（补 README），见 §5。
另有 3 处 W7-A 自己标了"需总审裁决"，我在 §6 给出倾向性意见但**不拍板**。

---

## 1. 交付物核对

| 应交付 | 实际 | 判定 |
|---|---|---|
| `audit/result_W7-A.md` | 在（6947 字节，12 行逐条表 + 3 处裁决项） | ✅ |
| `tests/run_phase10_w7a.ts` | 在（31028 字节，导出 `runPhase10W7ATests()`） | ✅ |
| 44 项测试全绿 | 实测 **通过 44 / 失败 0**（独立 runner 直接调 `.build/tests/run_phase10_w7a.js`） | ✅ |
| `tests/run.ts` 注册 | **未注册** | ✅ 符合纪律（总审统一合并） |
| 4 个单元源码修复 | 已检出，与报告 §"改动范围"清单一致 | ✅ |
| 未越界 | `70b613408` 的文件清单只有 4 个单元 + 2 份自己的 audit 文档 + 1 个测试文件 | ✅ |

---

## 2. 回退验证（标准 1 + 标准 2 的核心证据）

我没有只读对方报告，而是**重建了一个"修复前"环境**来验证：

```
1. 从 GitHub 取 W7-A 开工前（dash/grid/objective @ 7c46ddc41、progressbar @ 310a72d96）
   的 4 份原始源码
2. 复制当前 main，仅把上述 4 个文件替换成旧版（其余一律不动）
3. 独立 tsc 编译到 /tmp/orig/.build
4. 用**同一份** run_phase10_w7a.ts 去跑
```

结果：

```
==================================================
通过 25 项，失败 19 项
```

**与 W7-A 报告自述的"通过 25 项，失败 19 项"完全一致** —— 说明对方报告里的复现数字是自己实跑出来的，不是抄原报告的。

19 项红灯的原文摘录（节选，完整 19 条见附录 A）：

| 回退后的实际输出 | 对方报告写的修复前输出 | 是否吻合 |
|---|---|---|
| `第 1、2 段应等宽 期望 ≈0.3133，实际 0.3233` | `0.3233 / 0.3133 / 0.3233` | ✅ |
| `完成事件后不应再补 progress 期望 "activated/0 \| completed/10"，实际 "activated/0 \| completed/10 \| progress/10"` | `completed/10 \| progress/10` | ✅ |
| `NaN 坐标必须拒绝`（`canPlace(NaN)` 返回 true） | `canPlace('h', NaN, 3)=true` | ✅ |
| `用掉一层就该启动冷却（旧实现这里是 0）` | `用掉 1 层后 chargesLeft=1 cdLeft=0` | ✅ |
| `位移必须是有限数，实际 (NaN, NaN)` | `deltaX=NaN deltaY=NaN` | ✅ |
| `sys.destroy is not a function` | `typeof sys.destroy === 'undefined'` | ✅ |

### 12 条的红灯覆盖情况

| 条目 | 回退后红灯数 | 说明 |
|---|---|---|
| 1 dash 多层充能 | 2 | |
| 2 dash duration/distance | 2 | |
| 3 grid NaN 坐标 | 1 | |
| 4 grid `find` 文档签名 | **0** | ⚠️ 纯文档修复，实现未改，**性质上不可能红灯**（详见下） |
| 5 dash 状态机与衰减 | 1 | `falloff=-1` 红；`recovery` 死状态、`canCancel` 冗余是"锁现状"型用例 |
| 6 grid 六边形与计数 | 1 | `size=0` 红；`hexRing` 注释为文档，`freeCount` 改 O(1) 为性能（另有我的压力验证） |
| 7 objective 事件顺序 | 2 | |
| 8 objective 进度有限性 | 3 | |
| 9 objective destroy/reset | 1 | |
| 10 progressbar 阈值 | 1 | |
| 11 progressbar 分段空隙 | 1 | |
| 12 progressbar 构造校验 | 4 | |

**关于第 4 条（唯一 0 红灯）**：这条的修复是"改文档示例 + 源码 JSDoc 注释，保留 `find` 的实现"。
改注释无法让任何断言变红，所以标准 2 在此条**不适用**，不是对方的疏漏。
对方的做法也是对的——按文档那样把 `find` 改成传 cell 对象是 breaking，他选择了改文档。
该条目的两个用例价值在于**反向锁死**：一个断言"按真实签名能命中"，一个断言"按旧文档写法恒 0 条"，
防止后来的人为了让文档对而改实现。我认可这种写法。

---

## 3. 五条硬标准 · 逐条判定

| # | 条目 | 标准1 复现 | 标准2 测试有效 | 标准3 对照用例 | 标准4 无顺手重构 | 标准5 未误判设计 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | P1 dash 多层充能冷却 | ✅ 回退红灯 ×2 | ✅ | ✅ `单层充能行为不变` | ✅ 只改 `tryStart` 一行冷却逻辑 | ✅ JSDoc 明写"可连冲两次"，实现与承诺矛盾 | |
| 2 | P1 dash duration/distance NaN | ✅ ×2 | ✅ | ✅ `正常配置的位移总量与曲线不变` | ✅ 构造函数字段收口 | ✅ 无"设计如此"注释 | 见 §5.2 |
| 3 | P1 grid NaN 坐标 | ✅ ×1 | ✅ | ✅ `正常放置/拆除/移动回滚时 freeCount 精确` | ✅ `canPlace` 前置校验 | ✅ | |
| 4 | P1 grid `find` 文档签名 | ✅ 报告给了 0 条 vs 1 条的实测 | ➖ 不适用（纯文档） | ✅ `find 的第 2/3 参数是坐标` | ✅ 只动注释与 README | ✅ 判定"改文档不改实现"正确 | 见 §2 |
| 5 | P2 dash 状态机与衰减 | ✅ ×1 | ✅（falloff） | ✅ `falloff=0 匀速仍是合法语义` | ✅ `canCancel` 委托 `ready` | ✅ 未把"预留态"当 bug 强行实现 | 裁决项，见 §6.1 |
| 6 | P2 grid 六边形与计数 | ✅ ×1 | ✅（size=0） | ✅ `正常 size 的像素互转可往返` | ⚠️ 改动面最大，见 §4 | ✅ `hexRing` 确实是环（注释说谎） | |
| 7 | P2 objective 事件顺序 | ✅ ×2 | ✅ | ✅ `未完成的进度仍照常上报 progress` | ✅ `setProgress` 内加终态早退 | ✅ 原 JSDoc 未约定顺序，属契约缺失 | |
| 8 | P2 objective 进度有限性 | ✅ ×3 | ✅ | ✅ `正常 setProgress/addProgress 行为不变` | ✅ 入口加 `Number.isFinite` | ✅ 拒绝而非"收口成 0"，避免进度被清零 | |
| 9 | P2 objective destroy/reset | ✅ ×1 | ✅ | ✅ `reset() 不触发任何 onEvent` | ✅ 新增 `destroy()` | ✅ `reset` 静默写进 JSDoc，未擅自改成发事件 | 裁决项，见 §6.3 |
| 10 | P2 progressbar 阈值 | ✅ ×1 | ✅ | ✅ `默认阈值行为不变` + `滞回仍生效` | ✅ 两个字段换 `clampNum` | ✅ 与同构造函数内 `numOr+Math.max` 统一 | |
| 11 | P2 progressbar 分段空隙 | ✅ ×1 | ✅ | ✅ `段间确有空隙` / `gap=0 时 = 1/n` / `越界仍抛错` | ✅ 只换算法，未动字段 | ✅ 首末段贴边、等宽，符合"分段血条"直觉 | |
| 12 | P2 progressbar 构造校验 | ✅ ×4 | ✅ | ✅ `区间确实非法时仍抛错` | ✅ `numOr` 收口 + 新增 `destroy()` | ✅ 保留了 `max<=min` 抛错传统 | 裁决项，见 §6.2 |

**标准 3 汇总**：44 项里 16 项用例名带"防止矫枉过正"，另有若干条以"……行为不变"命名的同类用例，
每个改动点至少配 1 条。

**标准 5 汇总**：我逐处查了原代码的注释。这 12 条里，**没有一处**原代码带"这是设计如此"的论证性注释；
对方改动的 4 个文件中，新增注释全部是"为什么这么写"的坑位说明，没有删掉任何原有解释。

---

## 4. 本次改动里风险最大的一处：`grid` 的 `freeCount` 改增量维护

第 6 条把 `freeCount` 从"每次 O(n) 全扫"改成了 `_free` 增量维护，并新增
`_writeCell` / `_eraseCell` 两个写入出口，`place` / `remove` / `move` / `clear` 全部改走出口。

这是本次 12 条里**唯一引入新机制**的改动，也是最容易引入新 bug 的地方
（漏一个写入路径 → 计数静默漂移，比原来"慢"更危险）。所以我单独做了压力验证：

```javascript
// /tmp/v/stress_grid.js —— 12×9 网格，随机 place / remove / move / clear
[grid freeCount 压力] 操作 12000 步、校验 12000 次 → 不一致 0 次
[边界] 放置两个 2x2 后 freeCount=17（期望 25-8=17）
[边界] clear() 后 freeCount=25（期望 25）
[边界] destroy() 后 freeCount=25 placedCount=0 at(0,0)=undefined
[边界] 同格 放置→拆除→再放置: 15 → 15（应回到 15）
```

每一步都拿 `freeCount` 与"全图扫描的真实占用格数"对账，**12000 次零偏差**。
另核对了源码：所有 `this._cells[...]` 的写入点（327/328/332/333 行）确实只剩下
`_writeCell` / `_eraseCell` 两处，其余全是读取，`clear()` 也重置了 `_free`。

**判定：在清单范围内（P2 原文点名"`freeCount` 每次 O(n) 全扫"），且未引入计数漂移。**

---

## 5. 需知会的 5 项（非阻塞）

### 5.1 【建议返工】`objective/README.md` 的 API 表未同步新增的 `destroy()`

`destroy()` 是本批新加的对外方法，源码 JSDoc 写得很完整，
但 `objective/README.md` 第 86-111 行的成员表里只有 `reset()`，**没有 `destroy()`**。
本库规则是"每个插件自带 README"，且铁律 5「可卸载」的对外出口应当可见。

**建议**：在表里补一行 `| destroy() | 卸载：断开三个外部回调并复位 |`。
（同样是文档类，不影响测试，但属"新增 API 未登记"，与本次 12 条是同一批改动的连带项。）

### 5.2 【口径确认】`dash` 的 `distance` 允许负值

`duration` 做了 `> 0` 的肯定式守卫（因为要拿它做除数），`distance` 只做了 `numOr`（挡 NaN）：

```
distance=NaN   → 总位移 4（回落默认）   ✅
distance=-10   → 总位移 -10（原样保留）
distance=0     → 0（原样保留）
```

负 `distance` 的效果是"沿反方向冲刺"，方向由 `dirX/dirY` 决定，所以**它可能是合法配置**（向后闪避）。
我倾向"这是有意的"，但原任务书 P1-2 只说"未收口"，没说清负距离的语义。
**请 W7-A 或总审确认口径**：若设计上距离应为非负，补一个 `!(d >= 0)` 的守卫；
若允许反向，建议在 JSDoc 里写一句"负值＝反向冲刺"，免得下一个人当 bug 又来修一遍。

### 5.3 【与 W7-A 无关】全库当前有 1 项失败

```
通过 3696 项，失败 1 项
✗ 第九批：工程效率（command / debug-console / binary / crash）
  › BinarySerializer · 位级序列化 › ⚠️ float 会 clamp 而不是溢出回绕
```

**这一条不是 W7-A 引入的**：我在"修复前源码"的回退环境上跑全量，得到**完全相同**的
`3696 通过 / 1 失败`，同一条、同一个错误信息。`binary` 不在 W7-A 的 4 个单元里。
属第九批 P0 阶段的既有遗留，需总审另派窗口处理。

### 5.4 【与 W7-A 无关】`check-deps` 有 1 项待处理

`import 了但没登记` 共 8 条：`i18n` `blessing` `curse` `rarity` `achievement` `rebind`
`gameflow` `accessibility` → `_core`。**不含 dash / grid / objective / progressbar**，
是 `_kitmeta.json` 的并发推送被冲掉的老问题（W7-A 验收 W7-B 时也记录过 `achievement` 这一条）。

### 5.5 【顺带发现，非 W7-A 引入】`objective/README.md` 自相矛盾

第 96-108 行刚用警告框写明 **"本模块没有 `state(id)`"**，
紧接着第 113-118 行的示例代码就写了 `const st = os.state('clear');`。
照示例抄必然报错。`objective` 是 W7-A 的单元，但这段 README 不是本次改动引入的
（W7-A 未改 README）。记录在此，请总审决定派给谁。

---

## 6. 对方标的三处裁决项 · 我的倾向（不拍板）

### 6.1 dash 的 `recovery` 状态 —— **同意 A（保留类型 + 注释标注预留）**

不实现 recovery 是对的：一旦实现，冲刺结束后 `state` 多一个非空值，
所有 `state === 'idle'` 的调用方（能否再次冲刺、能否被 AI 打断、动画机切回待机）行为全变，
且"恢复期时长"没有配置出处，硬编码违反铁律 4。
对方把它写成"预留位、请勿依赖"的长注释，比默默删掉类型成员或贸然实现都更稳妥。

### 6.2 progressbar 的 `min`/`max` 为 NaN 是回落还是抛错 —— **同意 A（回落默认）**

血条是 UI 底层组件，"构造失败"的后果是整块 UI 挂掉，把"一份配置错"升级成"功能不可用"。
回落默认 + 保留 `max <= min` 抛错，兼顾了"能用"和"明显的错误仍然拦"。
代价（配表填错被静默纠正）比收益小。

### 6.3 objective 的 `reset()` 静默 —— **同意 A（保持静默 + 写进 JSDoc）**

`reset` 的语义是"回到初始快照"，不是"发生了一批状态迁移"。
若在此补发事件，重开关卡时订阅方会先收到一串历史状态，与真实推进过程混在一起。
对方在 JSDoc 里指明了替代方案（reset 后自行读 `all()` / `active()` 拉全量），这是完整的交代。

---

## 附 A · 回退环境下 19 项红灯的完整清单

```
✗ dash · 多层充能 › 用掉一层后第二层要能恢复: 用掉一层就该启动冷却（旧实现这里是 0）
✗ dash · 多层充能 › 连冲两层时第二层不把冷却重置回满: 第一层后冷却应在 (0, 0.5)，实际 0
✗ dash · duration/distance › duration = NaN 不得产出 NaN 位移: 实际 (NaN, NaN)
✗ dash · duration/distance › distance = NaN 不得产出 NaN 位移
✗ grid · NaN 坐标 › canPlace(NaN) 必须拒绝
✗ dash · 状态机与衰减 › falloff = -1 时不得退化成"单帧瞬移": 首帧也应有位移，实际 0
✗ grid · 六边形与计数 › size = 0 的像素互转: pixelToHex 应有限，实际 {"q":null,"r":null}
✗ objective · 事件顺序 › 完成后不得再补发同帧 progress: 实际 "activated/0 | completed/10 | progress/10"
✗ objective · 事件顺序 › 失败事件后同样不补 progress: 实际 "activated/5 | failed/0 | progress/0"
✗ objective · 有限性 › setProgress(NaN) 必须被拒绝: 期望 3，实际 null
✗ objective · 有限性 › addProgress(NaN) 不得污染已有进度: 期望 1，实际 null
✗ objective · 有限性 › protect 类的 NaN 同样拒绝: 期望 5，实际 null
✗ objective · 可卸载 › destroy() 必须存在: sys.destroy is not a function
✗ progressbar · 阈值 › lowThreshold = NaN 时残血仍要进入 low: 期望 "low"，实际 "normal"
✗ progressbar · 分段 › 首段与中间段必须等宽: 期望 ≈0.3133，实际 0.3233
✗ progressbar · 构造 › max = NaN 不得再产出 NaN 的 ratio: 期望 100，实际 null
✗ progressbar · 构造 › max 为 Infinity 时回落默认: 期望 100，实际 null
✗ progressbar · 构造 › min = NaN 回落默认 0: ratio 应有限，实际 NaN
✗ progressbar · 构造 › destroy() 后对外状态归零: b.destroy is not a function
```

（回退编译时另有 2 条预期的类型错误：`Property 'destroy' does not exist on type 'ObjectiveSystem' / 'ProgressBar'`
—— 这本身就是"修复前没有 `destroy()`"的编译级证据。）

## 附 B · 我的独立复现输出（当前基线，非抄对方）

```
=== dash ===
falloff=0   总位移 10，前 5 帧 [0.8333 × 5]        ← 匀速语义保留 ✅
falloff=-1  总位移 10，前 5 帧 [0.8333 × 5]        ← 被夹到 0，与 falloff=0 同曲线 ✅
falloff=NaN 总位移 10，前 5 帧 [2.2975, 1.9155, …] ← 回落默认 2（衰减）✅
duration ∈ {0, -1, NaN, undefined} → 均为 14 帧（= 回落 0.22s），总位移 10 ✅
distance=NaN → 4（回落默认）✅
charges=3：用掉 1 层 → chargesLeft=2；等 5 秒 → 3 ✅

=== objective ===
推进到 3   → activated/0 | progress/3
推进到 10  → activated/0 | progress/3 | completed/10      ← 完成后无补发 ✅
再 setProgress(NaN) → 事件无新增，progress 仍为 10 ✅
addProgress(NaN)    → progress 仍为 10 ✅
destroy() 后 setProgress → 新增事件 0 ✅
protect：初始 5 → setProgress(NaN) 仍为 5 → setProgress(0) → failed ✅

=== progressbar ===
lowThreshold=NaN, 5%  → low ✅（默认阈值同表现）
highThreshold=NaN, 95% → normal（DEFAULTS.highThreshold = 1，与默认行为一致，非缺陷）
3 段 gap=0.02 → [0.32, 0.32, 0.32]，首段 start=0、末段 end=1 ✅
max=Infinity → ratio 0.05（有限）✅
min=50 时 destroy() → value=50, ratio=0, state='empty' ✅
```

## 附 C · 全库校验结果（基线 `67cb32359`）

```
bash build.sh                    → TSC OK（产物校验通过：227 个 .js）
node .build/tests/run.js         → 通过 3696 项，失败 1 项（binary，与 W7-A 无关，见 §5.3）
   └ W7-A 自己的 44 项（未注册进 run.ts，独立运行）→ 通过 44 / 失败 0

node scripts/check-deps.js       → 有 1 项待处理（8 条 _core 未登记，均非 W7-A 单元，见 §5.4）
node scripts/check-links.js      → [OK] 内部链接 42 条，断链 0 处（扫描 191 个 .md）
python3 scripts/scan-dt-guard.py → 扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py→ 扫描 0 处命中 ✓
python3 scripts/check-random-source.py → [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py   → [OK] 无待处理的冲突 ✓
```

> 注 1：`check-dup-exports` **只有 `.py` 版本**，任务书与 W7-A 报告里写的 `.js` 在仓库中确实不存在
> —— W7-A 的这处环境说明属实，不是漏跑。
> 注 2：`check-links` 曾因 `bin/` 下 npm 残留的断链软链（指向已删除的 `lib/node_modules`）而 ENOENT，
> 清理后正常；W7-A 报告里"1 处断链在 `handoff_W3-B.md`"在当前基线已不存在（0 处）。
> 注 3：`node_modules` 为本验收环境自行安装（typescript 5.9.2），未入库。

---

## 附 D · 验收过程声明

- 全程**未修改** W7-A 的任何代码、测试与报告文件；
- 回退环境、压力脚本、复现脚本全部建在 `/tmp`（`/tmp/orig`、`/tmp/v/`），
  没有在仓库里新建 `verify/` 之类的目录（否则 `check-deps.js` 会报错）；
- 本次验收唯一写入仓库的文件：本报告 `audit/verify_W7-B.md`。
