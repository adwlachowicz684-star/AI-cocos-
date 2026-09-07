# 验收报告 · W5-B 验收 W5-A

> 验收对象：`audit/handoff_W5-A.md` 的 **15 条**（P1 9 / P2 6），9 个单元
> 被验收单元：`behavior-tree fsm number-roller quest signal skill-queue steering telemetry turn`
> 验收方式：**只读脚本调用公开 API** 复现当前 main 的行为
>（按任务书 §2 的明确要求：*不要*用"改回旧代码跑一遍"的方式验证，未动 `.build/`、未改任何源码）

---

## 结论

**不通过 —— 但原因不是"修错了"，而是"尚未交付"。**

截至我的基线快照（拉取 main 时刻）：

- ❌ `audit/result_W5-A.md` **不存在**
- ❌ `tests/run_phase10_w5a.ts` **不存在**

因此 §2 五条标准里的**标准 1（是否复现过）与标准 2（测试是否真的会失败），在交付物层面无法评审**——没有报告可读、没有测试可跑。

我改为**直接对 9 个单元的源码做独立只读复现**（15 条逐条跑），据此给出判断：

| 判断 | 条数 | 条目 |
|---|---|---|
| 源码已修，现象消失 | **2** | steering·mass、telemetry·maxRetries |
| **半修，且引入新问题（标红）** | **1** | skill-queue·window |
| 口径与建议不同，需确认 | **1** | steering·mass（抛错 vs 兜底） |
| 源码未修，现象仍在 | **11** | 见 §2 表格 |

**给总审的建议**：W5-A 大概率仍在并行施工中，本次"不通过"应理解为**"该窗口交付物缺失"**，
而非"对方工作质量不合格"。下面 §3 标红的那条是唯一需要对方返工的实质问题，
其余请等对方提交后重新验收。

---

## 1. 逐条实测（只读脚本输出）

复现脚本放 `/tmp/verify_w5a*.js`，只调公开 API，不写任何仓库文件。

### P1

| 条目 | 实测输出（当前 main） | 原报告声称 | 判断 |
|---|---|---|---|
| behavior-tree · `Wait` 秒数 | `Wait(NaN)` 600 帧 Success = **0**，状态恒 `Running`；对照 `Wait(0.1)` = 85 | 0 / 85 | **未修**（现象完全复现） |
| behavior-tree · `CooldownDecorator` 秒数 | `CooldownDecorator(NaN)` 10 帧子节点执行 **10** 次；对照 `_seconds=1` 执行 **1** 次 | 10 / 1 | **未修** |
| number-roller · `snapTo` | `snapTo(NaN)` → `display = NaN`、`formatted = "NaN"`；对照 `set(NaN)` 抛错 | 一致 | **未修** |
| quest · `import()` 校验 | `import([{status:'garbage', progress:['a']}])` → `skipped = **0**`、`status = 'garbage'`、`progress = ["a"]` | 一致 | **未修** |
| signal · 同名连坐删除 | `once(fn)` + `add(fn)` → `listenerCount = 2`；`emit()` 后 `n = 1` 但 `listenerCount = **0**`（期望 1） | 一致 | **未修** |
| skill-queue · `window` | setter：`window = NaN` → **0**；tick 后 `count = **0**`（排队项被清空）。构造：`new SkillQueue({window:NaN})` → `window = **NaN**` | — | **半修 + 新引入问题（见 §3）** |
| steering · `mass` | `createAgent({mass:0})` 抛错 `[guard] agent.mass 必须为正，实际 0` | 产出 Infinity 坐标 | **已修**（口径不同，见 §4） |
| steering · `wander` 随机源 | 不注入 `rand`：两次 wander = `{x:98.80,y:6.39}` vs `{x:99.00,y:-0.57}`，**不同**；注入固定 rand → 相同 | 一致 | **未修** |
| telemetry · `maxRetries` | `maxRetries = ''` 两次 flush 后 `buffered = **1**`；对照 `3` → `1` | 原为 0 / 1 | **已修** |
| turn · `start(shuffleEqual)` | `start(true)` 与 `start(false)` 顺序**均为** `u0,u1,u2,u3,u4,u5` | 三种调用全同 | **未修**（见 §4） |

### P2

| 条目 | 实测输出（当前 main） | 判断 |
|---|---|---|
| behavior-tree · `trackedNodes` 死功能 | tick 后 `trackedNodes.size = **0**` | **未修** |
| fsm · `can()` 转换表缺项 | 当前态 `idle`（表中缺项）：`can('jump') = **true**`、`can('teleport') = **true**`；当前态 `walk`：`can('jump') = false`、`can('run') = true` | **未修**（现象完全复现） |
| number-roller · `duration.min = NaN` | `isRolling = **false**`、`display = **5000**`（直接跳终值）；对照默认 `isRolling = true`、`display = 0` | **未修** |
| steering · `circleFormation` 的 count=0 | `circleFormation(0, 0, 10)` = `{x: null, y: null}`（JSON 化的 NaN） | **未修** |
| telemetry · `flushIntervalMs = NaN` | `shouldFlush() = **true**`；对照 5000 → `false` | **未修** |

---

## 2. 五条标准（交付物缺失，只能评标准 4/5）

| 标准 | 结论 | 依据 |
|---|---|---|
| 1 · 是否真的复现过 | **无法评审** | `result_W5-A.md` 不存在，没有"复现输出"列可读。我已自行逐条复现（§1），但那不能替代对方的产出 |
| 2 · 测试是否真的会失败 | **无法评审** | `run_phase10_w5a.ts` 不存在 |
| 3 · 有没有对照用例 | **无法评审** | 同上 |
| 4 · 有没有顺手重构 | ✅ 未发现 | `steering.mass` 改用 `_core` 的 `needPositive`、`telemetry.maxRetries` 改用 `clampNum`，都是**复用既有工具**，不是自己造轮子；改动集中在单字段，未见命名/结构调整 |
| 5 · 有没有误判设计 | ⚠️ 有 1 处需警惕 | 见 §3 |

---

## 3. 🔴 标红：skill-queue 的 `window` —— 修复后故障现象未消除

**这是我这次验收发现的唯一实质问题，必须返工。**

### 现状

`skill-queue/SkillQueue.ts:220` 的 setter 现在是：

```ts
this._opts.window = clampNum(v, 0, 1e6, 0);
```

上方注释写的是：

> 用 `numOr` 兜底到 0（**0 = 不过期**，与 `Math.max(0, ...)` 的既有语义一致）。

### 问题

注释说"0 = 不过期"，但过期判断在 `:309` 是 `if (waited <= this._opts.window) continue;`
——`window = 0` 时 `0.1 <= 0` 为 **false**，排队项被判定为**已超时**。

实测：

```
window = 1.0，request('s1')，tick(0.1)  → count = 1     （正常）
把 window 设成 NaN                       → window = 0
再 tick(0.1)                             → count = 0     ← 排队项被清空
```

**也就是说：传 NaN 之后的结果，与原 P1 描述的现象（"整个输入缓冲静默失效"）完全一致。**
修复只是把"比较数是 NaN"换成了"比较数是 0"，故障一模一样——
这属于任务书 §2 标准 2 点名的失效形态："如果把这个修复回退掉，这条断言还会通过吗？"
本例中把它回退掉，观察到的业务现象（排队项全丢）**不会有任何变化**。

### 附带两点

1. **注释与实现不是同一个函数**：注释写 `numOr`，代码写 `clampNum`。兜底值都是 0，所以行为一样，
   但这类注释会误导下一个人（本窗口 W5-B 在 `input` 单元就踩过 `numOr` / `clampNum` 的选择题）。
2. **构造函数没改**：`:203` 仍是裸的 `opts.window ?? 0.25`，
   实测 `new SkillQueue({ window: NaN })` → `window = **NaN**`。
   setter 收口了、构造没收口，正是本窗口 W5-B 在 `accessibility` 上修掉的那类"两条路径口径不一致"。

### 建议改法

原报告建议 `numOr(v, 0.25)` —— **兜到默认值 0.25 是对的**，
因为 0 在本单元的真实语义是"立即过期"，不是"不过期"。
若确实想保留"传 0 = 不过期"的语义，就得同时改 `:309` 的过期判断
（例如 `window <= 0` 时跳过超时检查），**不能只改一处**——
否则就是任务书 §4 模式 F 明确禁止的"只改一个又不动另一个"。

> 判据建议（供对方写测试用）：
> `window` 设成 NaN 之后，`count` 应与正常窗口一致（保持 1），而不是变 0。

---

## 4. 两处需总审裁决 / 请对方补说明

### 4.1 `steering.mass`：抛错 vs 兜底

- 原报告建议：`numOr(opts.mass, 1)` 后再 `Math.max(mass, 1e-6)`（**兜底**）
- 实际实现：`needPositive(opts.mass ?? 1, 'agent.mass')`（**抛错**）

我实测 `mass = 0` 现在会抛 `RangeError`，Infinity 坐标确实不再产生了，**P1 现象已消除**。

但两者口径不同，且原报告有一句关键论据：
> 质量来自配置表或"massless 单位"（如子弹、纯运动学体）时**填 0 是自然的想法**。

若这句话成立，抛错会让"填 0 表示无质量单位"这个**直觉用法直接崩在创建单位时**；
若团队口径是"0 就是非法输入"，那抛错反而更好（快速失败）。
**这不是我能拍板的**，请总审定，或请对方在报告里写明选择理由 + 补一条对照用例
（合法的 `mass = 0.5` 仍能正常 `integrate`）。

### 4.2 `turn.start(shuffleEqual)`：只改了默认值

现状：`start(shuffleEqual: boolean = false)` —— 默认值已从 `true` 改成 `false`。

- 默认 `false` 时走 `a.id.localeCompare(b.id)`，**按 id 排序 = 确定性**，与注释"保证确定性"一致 ✅
- 但传 `true` 时走 `return 0` → 保持原序 → **仍然不打乱**，参数名 `shuffleEqual` **仍在说谎**

实测 `start(true)` 与 `start(false)` 输出**完全相同**（都是 `u0..u5`）。

这属于任务书 §4 模式 F 的"改了一半"：原报告给了两条路
（① 注入 `IRandomSource` 做真随机；② 改名为 `stableOrder` 并更正文档），
现在看起来是"顺手把默认改成 false"，但两条路都没走完：
参数名没改、README `:72` 仍写 `start(shuffleEqual?)` 是"开始（排序）"、传 true 依旧无效。

**请对方二选一做完**（我倾向 ①：注入随机源，与库内 `card` / `gacha` 的口径一致；
若选 ② 则必须同时改参数名 + README，且这是 breaking）。

---

## 5. 一条给全库的提醒：`check-random-source.py` 覆盖面不足

### 现象

`steering.wander` 的默认参数仍是 `rand: () => number = Math.random`（实测不注入时两次结果不同），
但 `python3 scripts/check-random-source.py` 输出 `[OK] 未发现自建随机源`。

### 原因（不是脚本 bug，是覆盖面窄）

读 `scripts/check-random-source.py` 的正则，它**只查两种形态**：

1. `class X implements IRandomSource` 且方法体直接 `return Math.random()`
2. `next()` 方法体直接 `return Math.random()`

它**完全不查**"直接调用 `Math.random()`"和"默认参数值是 `Math.random`"。
而后者恰恰是本次验收里两条条目的成因。

### 全库实际清单（我逐条读上下文确认，排除注释、tests、examples）

| 位置 | 形态 | 归属 | 判断 |
|---|---|---|---|
| `crash/CrashReporter.ts:312` | 直接调用：`Math.random() > this._sampleRate` | **W1-A**（P1 在案） | ⚠️ 应被抓到：采样决定"这条崩溃报不报"，直接影响可复现与可测试 |
| `steering/Steering.ts:253` | 默认参数：`rand: () => number = Math.random` | **W5-A**（P1 未修） | ⚠️ 应被抓到：不注入就不可复现，回放与单测失效 |
| `telemetry/Telemetry.ts:339` | 直接调用：`randomId()` 里的 `Math.random` | **W5-A**（P2 在案） | ⚠️ 应被抓到（原报告也把 `telemetry.randomId` 列为同类） |
| `rng/Seed.ts:75,76` | 直接调用：`random()` 生成可读种子 | 无窗口 | ✅ **合理、不建议改**：种子生成本来就该不可预测，改了反而每次一样 |

另：`perception` 的同类问题（W3-A P1）已修，现注释写明"抖动用的是可注入的独立随机源"——
这条可以作为"修好了是什么样"的参考样本。

### 建议

给脚本补两条规则（**我没改脚本**——`scripts/` 是共享的，改了会影响其余 15 个窗口，
且脚本是否该扩大覆盖面属于总审决定）：

1. 生产代码里出现裸 `Math.random()` 调用 → 报错，白名单加 `rng/Seed.ts`（并注明"种子生成属例外"）
2. 函数/构造的**默认参数值**里出现 `Math.random` → 报错

补上之后，上表前三条会自动浮出来，无需等各窗口自己发现。

（这条已超出 W5-A 的验收范围，记在这里供总审参考，不计入 W5-A 的通过与否。）

---

## 附：全库校验结果（验收时跑）

```
node .build/tests/run.js               → 通过 3695 项，失败 0 项
node scripts/check-deps.js             → 全部通过 ✓
node scripts/check-links.js            → 断链 1 处（audit/handoff_W3-B.md，非 W5-A/非本窗口）
python3 scripts/scan-dt-guard.py       → 命中 0 处 ✓
python3 scripts/scan-num-guard.py      → 命中 0 处 ✓
python3 scripts/check-random-source.py → OK（但见 §5 的漏检提醒）
python3 scripts/check-dup-exports.py   → 无待处理冲突 ✓
```

> 说明：以上结果是在**我已完成 W5-B 全部修复**的代码上跑的。
> 全量回归 3695 项与基线持平，说明 W5-A 已有的那两处改动（steering.mass、telemetry.maxRetries）
> 没有伤到既有行为。
