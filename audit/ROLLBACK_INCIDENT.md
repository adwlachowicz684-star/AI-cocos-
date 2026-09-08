# ⚠️ 基线回退事故记录（2026-09-08 04:22~04:28）

**记录人**：主审核人（元宝）　｜　**发现时间**：2026-09-08 04:30（归档推送后的复核中）
**性质**：**大面积源码回退**，非误删、非冲突丢失，是"旧版覆盖新版"
**当前状态**：✅ **已修复**（`0118fc72f6`，2026-09-08 06:2x）。
`tsc --noEmit` 0 错误 · 全量回归 **4,667 通过 / 0 失败** · 6 个校验脚本全过。详见 §9。

---

## 0. 一句话

我推送终审裁决（提交 `5efe0031` 04:12）约 10 分钟后，一批 `chore: 同步 X.ts` 提交
（04:22~04:28，约 170 个）把**第二轮审结后的源码整体覆盖回了开工前的旧版**，
第二轮 16 个窗口的修复大面积丢失。

**这不是任何人的恶意操作，是"本地旧副本 → 远程"的单向同步覆盖了别人的新成果。**

---

## 1. 事故经过

| 时间 | 事件 |
|---|---|
| 04:12 | 我推送 `5efe0031`（终审裁决 + 注册 16 个 phase10 套件 + check-deps 归零 + 测试数 4,653） |
| 04:22~04:28 | 约 170 个 `chore: 同步 <文件>` 提交涌入 |
| 04:28 | 出现 `chore: 同步 tests/run_phase11.ts`（第三轮内容，属新增，没问题） |
| 04:30 | 我推送归档（`631e06cb`）时触发非快进，重试后发现 main 已变 |
| 04:35 | 拉取最新快照复核 → **189 个编译错误** |

### 直接证据

```
$ curl .../compare/5efe0031...main
ahead_by: 171   behind_by: 0       ← 171 个新提交，全在我之后
差异文件 229 个，其中源码/配置 112 个
```

逐文件看增删比，**110 个源码文件净减**，前十：

| 文件 | 增 | 删 | 净减 |
|---|---|---|---|
| `dungeon/Dungeon.ts` | +29 | −377 | −348 |
| `diagpack/DiagPack.ts` | +43 | −288 | −245 |
| `replay/ReplayRecorder.ts` | +29 | −227 | −198 |
| `meta/MetaProgression.ts` | +15 | −202 | −187 |
| `runscope/ScopedStore.ts` | +10 | −188 | −178 |
| `timeutil/TimeUtil.ts` | +10 | −185 | −175 |
| `scheduling/FrameScheduler.ts` | +16 | −179 | −163 |
| `curse/Curse.ts` | +8 | −161 | −153 |
| `analytics/ABTest.ts` | +13 | −165 | −152 |
| `expression/Expression.ts` | +15 | −165 | −150 |

**"净减"不是重构精简**——对比内容可见是整段整段消失，且消失的正是第二轮新增的守卫与注释。

---

## 2. 损坏面：189 个编译错误，分布在 16 个测试文件

```
tests/run_phase10_w3a.ts   31 处
tests/run_phase10_w2a.ts   30 处
tests/run_phase10_w2b.ts   26 处
tests/run_phase10_w8a.ts   18 处
tests/run_phase10_w1a.ts   18 处
tests/run_phase10_w6a.ts   14 处
tests/run_phase10_w4b.ts   10 处
tests/run_phase10_w4a.ts   10 处
tests/run_phase10_w7b.ts    7 处
tests/run_phase10_w5b.ts    6 处
tests/run_phase10_w5a.ts    6 处
tests/run_phase10_w6b.ts    5 处
tests/run_phase10_w3b.ts    4 处
tests/run_phase10_w7a.ts    2 处
tests/run_phase10_w8b.ts    1 处
examples/accessibility-usage.ts  1 处
```

**错误形态全部是"测试引用的 API 在源码里不存在"**——即测试在第二轮审结时是绿的，
现在源码退回去了，测试留在原地，于是全体失配。这反过来证明：**丢的是源码，测试没丢**。

典型：

```
tests/run_phase10_w2a.ts(148,16): Property 'lastRollbackErrors' does not exist on type 'CommandStack'
tests/run_phase10_w1a.ts(607,52): 'rethrow' does not exist in type 'DebugConsoleOptions'
tests/run_phase10_w1a.ts(101,18): Property 'missing' does not exist on type 'PlacePreview'
tests/run_phase10_w1a.ts(898,13): Property 'ignoredVotes' does not exist on type 'SurrenderStatus'
tests/run_phase10_w2a.ts(38,26): Module '"../scheduling/FrameScheduler"' has no exported member 'NO_TASK'
```

### 逐单元抽查（确认是"回退"而非"改坏了"）

| 检查项 | 5efe0031 | 当前 main | 结论 |
|---|---|---|---|
| `command/CommandStack.ts` 的 `lastRollbackErrors` | 有 | **无** | 回退 |
| `debug-console/DebugConsole.ts` 的 `rethrow` | 有 | **无** | 回退 |
| `cutscene/Cutscene.ts` 的 `_lastStart`（并行修复） | 有 | 有 | **幸存** |
| `binary/BinarySerializer.ts` 的越界抛错 | 有 | 有 | **幸存** |
| `_core/guard.ts` | 存在 | 存在 | 幸存 |
| `di/DIContainer.ts` 的 `_disposeFns` | 有 | **无**（变成 `_disposers` 数组） | 回退到更早实现 |

`di` 这一条最能说明性质：当前版本用的是 `_disposers: Array<() => void>`
和单参数 `constructor(public readonly name = 'root')`，
而第二轮修复后是 `_disposeFns: Map` + 双参数构造（`onDisposeError`）。
**不是同一份代码的两种写法，是两代实现。**

---

## 3. 分类检测：我做了逐行子集比对

对 `5efe0031` 与当前 `main` 的每个非测试文件做"当前版本是否 ⊆ 基准版本"的检测：

| 类别 | 数量 | 含义 | 处置 |
|---|---|---|---|
| **纯回退** | **28** | 当前版本每一行都能在基准里找到，**零冲突，可直接整文件恢复** | 可自动化 |
| **含新内容** | **135** | 当前有基准没有的行 → 第三轮真新增混在回退里 | 需三方合并 |
| **第三轮新增文件** | **0** | 基准里完全没有的新文件 | — |

**"含新内容"的 135 个文件里，独有行普遍只有 10~20 行**，说明是
"旧版文件 + 少量第三轮补丁"，不是全新重写。典型：

- `mover/CharacterMover.ts` 独有 81 行 —— 是第三轮的 `turnRate` 平滑转向（**真新增，必须保留**）
- `timeutil/TimeUtil.ts` 独有 10 行 —— `isNewDay` / `CountdownState` 相关
- `di/DIContainer.ts` 独有 18 行 —— 旧版实现的结构差异

⚠️ **注意**："独有行"里也混入了不少**注释与格式差异**，
不能简单按行合并，否则会把两代实现的注释搅在一起。**这 135 个必须人工/窗口逐个确认。**

---

## 4. 与我此前记录的另一次事故的对比

台账 `README.md` 第 96 行记过一次基线错位（2026-09-06）：
那次是**改了没推送**，文档声称已修而仓库没有。

这次方向相反：**推送了，但被更旧的副本覆盖回去**。

| | 2026-09-06 | 2026-09-08（本次） |
|---|---|---|
| 方向 | 本地新 → 远程旧（没推） | 本地旧 → 远程新（覆盖了） |
| 根因 | 文档与代码分批推 | **单向同步，没有先拉取再推** |
| 后果 | 5 个窗口白干一轮 | 110 个文件回退，main 编译失败 |
| 共同点 | **都是"本地副本与远程基线不一致时直接写远程"** | |

**流程教训（写进铁律）**：

1. **任何 `chore: 同步` 提交前，必须 `git pull` 并确认本地副本的基线不落后于远程**
2. **同步脚本不得无条件覆盖**——遇到远程比本地新（按提交时间或内容哈希）应中止并告警
3. **禁止逐文件批量同步**：一次 170 个文件的同步，出问题时无法定位是哪一批引入的
4. 编译失败必须在**推送前**被发现：推送前跑一次 `tsc --noEmit` 应成为同步脚本的硬门槛

---

## 5. 处置建议（按优先级）

### P0 · 立刻：让 main 恢复可编译

当前 189 个错误意味着**任何人拉取 main 都跑不了测试**。

- **方案甲（快）**：恢复 28 个纯回退文件（零冲突，可直接用 `5efe0031` 的版本覆盖），
  预计能消掉大部分错误；剩余 135 个逐个合并。
- **方案乙（稳）**：把 `tests/run_phase10_w*.ts` 这 16 个文件暂时移出编译范围，
  先让 main 绿，再逐个窗口认领恢复。**不推荐**——掩盖问题，且测试没丢，丢的是源码。

### P1 · 恢复我的 4 项基础设施

这 4 项随 `5efe0031` 推送，也一并被覆盖，与源码回退无关，**可独立重做、无冲突**：

| 项 | 5efe0031 状态 | 当前 main |
|---|---|---|
| `tests/run.ts` 注册 16 个 `runPhase10W*Tests()` | 有 | **0 处** |
| `scripts/check-links.js` 的 `stripCode()` | 有 | **被删**（−53 行） |
| `_kitmeta.json` 的 5 条 `_core` 登记 | 有 | **回到 `[]`** |
| 根 `README.md` 测试总数 | 4,653 | 3,709（第三轮另有更新，需重算） |

### P2 · 让第三轮窗口自查

`mover.turnRate`、`tests/run_phase11.ts` 等第三轮成果**混在被回退的文件里**。
请第三轮窗口确认自己的改动是否幸存——**不要假设幸存，要逐个验**。

---

## 6. 复现方式

```bash
# 1. 看差异规模
curl -H "Authorization: Bearer <token>" \
  "https://api.github.com/repos/adwlachowicz684-star/AI-cocos-/compare/5efe0031243c7270c4ae3cd346e6f46bf13af813...main" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('ahead', d['ahead_by'], 'files', len(d['files']))"

# 2. 看编译错误
bash build.sh
# 或
./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit | grep -c "error TS"   # → 189
```

**基准快照**：`5efe0031243c7270c4ae3cd346e6f46bf13af813`（第二轮审结后的完整状态，含全部修复）
**事故后快照**：`631e06cb82`（我的归档推送，落在已损坏的 main 之上，归档本身没问题）

---

## 7. 待办

- [x] 恢复 28 个纯回退文件（`5efe0031` 版本直接覆盖）
- [x] 135 个含新内容的文件：逐个人工/窗口三方合并
- [x] 重做 4 项基础设施（run.ts 注册 / stripCode / _kitmeta 登记 / README 测试数）
- [x] 复核第三轮成果（`mover.turnRate`、`run_phase11.ts`）并保留
- [x] 全量回归回到 0 失败，重算测试总数（4,667）并更新 README
- [ ] **修复同步流程**：加"推送前先拉 + `tsc --noEmit` 门禁" ← **唯一未结项，见 §9.4**

---

## 8. 一句记下来的话

我在这轮终审里写过：**"文档声称已修、实际未修，会阻止下一个人去修"**。

这次是它的镜像：**代码已经修好并推送了，却被一份更旧的副本悄悄覆盖回去**。
两者都指向同一件事——**没有单一的、被强制校验的事实来源，并行工作就是掷骰子**。

区别是这次代价更大：上次是 5 个窗口白看一轮文档，
这次是 110 个文件回退、189 个编译错误、整库不可构建。

---

# 9. 处置结果（2026-09-08 06:2x 补记）

**修复提交**：`0118fc72f6`（171 个文件）　｜　**基准**：`5efe0031`
**核验方式**：拉取 `main` 的全新 tarball → 本地构建 → 全量回归 → 六脚本，全部独立复跑。

## 9.1 恢复策略

按 §3 的分类结果分三类处理，不做"一刀切覆盖"：

| 类别 | 数量 | 做法 |
|---|---|---|
| 纯回退（当前 ⊆ 基准） | 28 | 整文件恢复为 `5efe0031` 版本，零冲突 |
| 含新内容 | 131 | 恢复为第二轮基准版（其"独有行"经查为旧版残留，非第三轮新增） |
| 第三轮真新增 | 2 | `mover/CharacterMover.ts` + `mover/README.md` **三方合并** |
| 第三轮新文件 | 1 | `tests/run_phase11.ts` 原样保留 |

> **关于"含新内容的 131 个"为什么直接覆盖**：逐行检查过独有行的性质——
> 多数是旧版注释与旧实现残留（如 `command/CommandStack.ts` 独有 4 行全是被删掉的旧注释），
> 少数是旧版代码片段（`save/SaveManager.ts` 的 3 行 `console.error`）。
> **没有一行是第三轮的新能力**，所以覆盖是安全的。
> 唯一含真新能力的是 `mover`，走的是手工三方合并，未用覆盖。

## 9.2 `mover` 三方合并明细

`mover/CharacterMover.ts` 是唯一两代实现叠加的文件，手工合并 5 处：

1. `import` 合并：`clamp01, numOr, safeDt` + `angleDiffRad, normalizeAngleRad, clampNum`
2. 接口加 `turnRate?: number;`（含 21 行选型注释）
3. 构造配置加 `turnRate: clampNum(cfg.turnRate, 0, 1e4, 0)`
4. 加 `facing` setter + `_turnToward()` 私有方法（45 行）
5. **两处 `_facing = Math.atan2(...)` 改为 `_turnToward(Math.atan2(...), dt)`**

第 5 点是关键——漏了它 `turnRate` 就是个死配置：字段有、方法在，但没人调用。
合并后 `mover/README.md` 同样做了三方合并（补 `turnRate` 章节 39 行 + 配置示例行 + `facing` 表格行）。

**合并后验证**：`turnRate` 出现 6 次（第三轮能力在）+ `_impulseX` 5 次、`numOr` 14 次（第二轮修复在）。

## 9.3 顺带发现：3 个测试文件的断言也被回退了

恢复源码后全量回归仍失败 3 项，查下来**不是源码没恢复，是测试文件本身也被回退过**：

| 测试文件 | 被回退的断言 | 性质 |
|---|---|---|
| `tests/run_batch10.ts` | `binary` float 从"抛错"退回"静默 clamp" | 与终审 C30 裁决冲突 |
| `tests/run_batch16.ts` | `settings.snapshot()` 退回"无条件列出 pendingRestart" | 把已修 bug 固化回断言 |
| `tests/run_batch19.ts` | `cutscene.with()` 退回串行（`start === 1000`） | 把错误行为锁成契约 |

**这三条正是第二轮判定"断言把 bug 固化"而修掉的。** 一并恢复后，全量回归归零。

> 这条单独记一笔：**回退事故的隐蔽之处在于，它不只回退源码**。
> 如果只验"源码文件是否等于基准"就收工，这 3 条会一直红着，
> 且看起来像"第二轮修错了"，而不是"被覆盖回去了"。

## 9.4 唯一未结项：同步流程没有门禁

恢复的是**结果**，**成因还在**。只要 `chore: 同步` 仍是无条件单向覆盖，
下次还会发生，且可能覆盖的是第三轮的成果。

最小可行的两道闸（**建议在下一轮开工前装上**）：

```bash
# 闸 1：同步前先对齐，且不允许落后
git fetch origin main
LOCAL=$(git rev-parse HEAD)   REMOTE=$(git rev-parse origin/main)
git merge-base --is-ancestor "$REMOTE" "$LOCAL" || { echo "本地落后于远程，禁止同步"; exit 1; }

# 闸 2：推送前必须能编译
./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit || exit 1
```

闸 2 是这次最直接有效的——**189 个编译错误如果有一道 `tsc --noEmit` 门禁，
在推送那一刻就会被拦下，根本轮不到我发现**。
