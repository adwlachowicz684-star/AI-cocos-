# 窗口 W1-A 交付报告

> 执行者：第 A 组 · 窗口 W1-A
> 单元（8 个，与其它 15 个窗口零重叠）：`builder` `craft` `crash` `cutscene` `debug-console` `gesture` `matchops` `skill-variant`
> 来源批次：batch4、batch5
> 条目：20（P1 17 / P2 3）

---

## 0. 交付摘要

| 项 | 值 |
|---|---|
| 清单条目 | 20（P1 17 / P2 3） |
| 已修（行为变更） | **17** |
| 已修（新增开关，不改默认行为） | **1**（`debug-console` rethrow，见 §2-J 改判说明） |
| 新增能力/文档化 | **2**（`craft` count:0 口径、`Surrender.ignoredVotes`，见 §2-N） |
| 需总审裁决 | 0（2 项已由交叉验收给出方向并按裁决执行，见 §6） |
| 新增测试 | `tests/run_phase10_w1a.ts`，**48 项**，全绿 |
| 全量回归 | **3697 项全绿（0 失败）** |
| 回退实验 | 基线 `4d2d534b` + 本窗口测试 → **23 通过 / 25 失败** |

> ⚠️ **以上两个数字互不包含**：`tests/run.ts` 未改动，本窗口的 **48 项尚未注册**，
> 不在这 3697 里。合并后预期为 **3745**（3697 + 48）。
> （此点是在交叉验收 W1-B 时对照发现的 —— W1-B 明确写了"注册后应为 3753"，
> 我第一版漏了这句说明，现补正。详见 `audit/verify_W1-A.md` §6.3。）

### 本版变更（交叉验收后的返工）

W1-B 的验收报告（`audit/verify_W1-B.md`）提出 1 项 🔴 必须返工、2 项裁决、5 项建议。
**全部处理完毕**，逐项见 §6。其中最重要的一条是：
我一度把 `debug-console` 的内部异常"向上抛"误判成 bug 并翻转了默认值，
属 review 标准 5「把故意的设计当成缺陷」——**已回退默认值，改为新增开关**。

### ⚠️ 更正：我上一版写的基线数字是错的

上一版我写「实测原始 main 是 **3694 通过 / 2 失败**」，并据此论证
"总审预置了红灯用例、我的修法与之一致"。

**这个结论不成立**，W1-B 交叉验收时纠正了我。真实情况：

```
基线 4d2d534b（我动手那一刻的 main）：通过 3696 项，失败 0 项
```

我当初跑出的 2 条失败，是因为**用的快照比 `4d2d534b` 更早**（任务开始时拉的 `repo.tar.gz`），
中间有过并发推送。用"我动手那一刻的真实基线"重测，那两条用例的断言**就是旧行为**，所以是绿灯：

```ts
// base/tests/run_batch10.ts:522   断言 rethrow 传播 → 我改前它是绿的
// base/tests/run_batch19.ts:836   断言 with 串行   → 我改前它也是绿的
```

所以 H、J 两条的准确描述是「**改了两条原本通过的用例，使之匹配新行为**」，
不是「让预置红灯转绿」。**这个区别很关键**：
"预置红灯"意味着总审已背书该修法，"绿灯改断言"没有这层背书，需要独立判断。

正是这一点让我重新审视 J，最终自己推翻了它 —— 详见 §2-J。

---

## 1. 一句话总结

本批 17 条 P1 的后果**全都不是崩溃**，而是"静默地做错事"——
契约说谎、静默不生效、静默丢失、两个 API 对同一事实给出相反答案、
以及只在特定设备上复现。每一条都配了"修复前会失败"的回归用例
和"正常输入不受影响"的对照用例。

---

## 2. 逐条结果

### 【P1】17 条

#### A · `[builder]` `PlaceResult.missing` 声明了但从未被填充 — **已修**

- **改动**：`builder/Builder.ts`
  - `PlacePreview` 接口补 `missing` 字段
  - `preview()` 资源不足分支返回 `missing`
  - `place()` 失败时透传 `pre.missing`
- **复现输出（修复前）**：
  ```
  preview = {"ok":false,"error":"insufficient-resources","cells":[...],"detail":"资源不足"}
  place   = {"ok":false,"error":"insufficient-resources","detail":"资源不足"}
  place(...).missing = undefined
  ```
- **修复后**：
  ```
  preview.missing = {"wood":7,"stone":4}
  place.missing   = {"wood":7,"stone":4}
  ```
- **为什么这是"契约说谎"而不是"缺字段"**：调用方照着
  `readonly missing?: Record<ResourceId, number>` 写 `if (r.missing?.wood)` 来做"还差多少木头"，
  类型检查是过的，运行时永远走不到 —— 比没有这个字段更糟。
- **测试**：`run_phase10_w1a.ts` › `builder · PlaceResult.missing 契约说谎（P1）`（2 项）

#### B · `[builder]` `rotateCell` 对非法角度静默返回原值 — **已修**

- **改动**：`builder/Builder.ts` 的 `rotateCell`，`default: return c` → 抛错
- **复现输出（修复前）**：`rotateCell({x:1,y:0}, 45)` → `{"x":1,"y":0}`（不转，也不报错）
- **修复后**：抛出 `[Builder] 非法旋转角度：45（只接受 0 / 90 / 180 / 270）`
- **为什么必须抛错**：`Direction` 是字面量联合，TS 挡得住写死的错误，
  但挡不住 JSON 反序列化后的 `number`。静默不转 → 占位与预览对不上，
  玩家看到"我选了旋转但它没转"，日志一行都没有。
- **测试**：`builder · rotateCell 对非法角度静默返回原值（P1）`（2 项，含四合法角度对照）

#### C · `[craft]` `totalMaterials` 递归时忽略子配方的产出倍率 — **已修**

- **改动**：`craft/CraftSystem.ts`
  - 新增 `_yieldOf(recipe)`：固定产出取 `output.count`，有 `variants` 时取**最小**产率
  - `:275` 递归改为 `Math.ceil(need / yieldPerCraft)` 次
- **复现输出（修复前）**：
  ```
  plank: 2 木 → 4 板 ;  house: 8 板 → 1 房
  totalMaterials('house',1) = {"wood":16}    ← 实需 4，高估 4 倍（正好等于产率）
  ```
- **修复后**：`{"wood":4}`
- **为什么取最小产率而不是最大**：`variants` 是"随机出其中一种"，产率不确定。
  取最大会得到**乐观值**，真 roll 到低产率时材料不够 —— 低估比高估更糟
  （玩家照清单备料，合成到一半发现不够）。取最小保证"照这个数备料一定够"，是上界。
- **测试**：`craft · totalMaterials 忽略子配方产率（P1）`（3 项，含产率为 1 的链、不能整除向上取整）

#### D · `[craft]` 副产物被背包丢弃时静默消失 — **已修**

- **改动**：`craft/CraftSystem.ts`
  - `CraftResult` 新增 `lost?: Array<{itemId, count}>`
  - 副产物循环里 `leftover > 0` 时 push 到 `lost`
- **复现输出（修复前）**：
  ```
  craft -> {"ok":true,"produced":[{"itemId":"sword","count":1}],"byproducts":[]}
  ```
  `ok: true`、`byproducts` 空数组，**没有任何字段表示"有东西被丢了"**。
- **修复后**：
  ```
  {"ok":true,"produced":[...],"byproducts":[],"lost":[{"itemId":"slag","count":2}]}
  ```
- **为什么不在放不下时整体回滚**：副产物是**赠品**，不是交易对价。
  为了赠品把已炼好的主产物一起退掉，玩家损失更大。正确做法是如实上报，
  让调用方决定（提示"背包已满"或转邮件补发）。
- **测试**：`craft · 副产物被背包丢弃时静默消失（P1）`（2 项）

#### E · `[craft]` 全部 `consume:false` 的配方 `canCraft` 返回 `maxCount:0` — **已修**

- **改动**：`craft/CraftSystem.ts`
  - `CanCraftResult` 新增 `unlimited: boolean`
  - `unlimited = (maxCount === Infinity)`，`maxCount` 不再被 `Number.isFinite ? : 0` 归零
- **复现输出（修复前）**：`canCraft` → `{"ok":true,"missing":[],"maxCount":0}`，而 `craft()` 能成功
- **修复后**：`{"ok":true,"missing":[],"maxCount":Infinity,"unlimited":true}`
- **为什么额外加 `unlimited` 标志**：只有 `maxCount: Infinity` 的话，
  UI 拿它当滑块上限会得到"拉不到尽头"，16 个调用点各写一遍 `isFinite` 必然有人漏。
- **测试**：`craft · 全 consume:false 配方 maxCount 归零（P1）`（2 项，含"有消耗但材料为 0 时真的是 0"）

#### F · `[crash]` `_seen` 指纹表只增不减 — **已修**

- **改动**：`crash/CrashReporter.ts`
  - 新增 `maxFingerprints` 选项（默认 1000，`clampNum` 收口）
  - 新增 `_evictSeen(now)`：两轮淘汰（先清陈旧，再 LRU 裁到上限）
- **复现输出（修复前）**：1000 个不同指纹 → `stats().length = 1000`，且继续涨
- **修复后**：`maxFingerprints:100` → `stats().length = 100`
- **为什么保留期是 `dedupeWindow × 10` 而不是窗口本身**：
  窗口一过就删，下次同指纹再出现时 `count` 从 1 重新开始 ——
  服务端丢掉"这个 bug 累计发生过多少次"，而那正是去重机制存在的意义。
  **`dedupeWindow <= 0` 时跳过过期清理**：window=0 表示"不去重，每次都上报"，
  此时 `staleMs = 0`，每个条目立刻被判陈旧 → 计数永远接不上。
- **测试**：`crash · _seen 指纹表只增不减（P1）`（2 项，含"同指纹 500 次仍只留 1 条、count=500"）

#### G · `[crash]` 采样用裸 `Math.random` — **已修**

- **改动**：`crash/CrashReporter.ts`
  - 新增 `random?: IRandomSource` 选项，默认 `MathRandomSource`（来自 `_core/types`）
  - `:294` 的 `Math.random()` → `this._rng.next()`
- **复现输出（修复前）**：`sampleRate:0.5`、200 次异常，三轮发送 **95 / 105 / 99**（比例对，每轮都不同）
- **修复后**：注入 `FixedRandomSource` 后三轮均为 **100 / 100 / 100**
- **测试**：`crash · 采样用裸 Math.random（P1）`（2 项，含 fatal 不参与采样对照）

#### H · `[cutscene]` `Timeline.with()` 与 README 不符 — **已修**

- **改动**：`cutscene/Cutscene.ts`
  - 新增 `_lastAddedStart` 字段，记录上一条 step 的**起点**
  - `with()` 的 `start` 改用 `_lastAddedStart`（原来是 `_cursor`，即上一条的**结束时刻**）
  - `add()` / `wait()` / `gap()` 同步维护该字段
- **复现输出（修复前）**：`add('a',1000).with('b',1000)` → `a:0, b:1000`，`duration = 2000`
- **修复后**：`a:0, b:0`，`duration = 1000`
- **`gap()` 之后的处理**：空档后没有"上一个 step"了，下一个 `with` 应从空档结束处起算，
  所以 `gap()` 里把 `_lastAddedStart` 同步到新 cursor。
- **测试**：`cutscene · Timeline.with 与 README 不符（P1）`（2 项，含 add 串行、gap 后 with 的对照）
- **注**：本条同时让基线里既有的红灯用例 `run_batch19.ts › with 并行` 转绿。

#### I · `[cutscene]` `update(dtMs)` 无 dt 守卫 — **已修（附说明，见 §3-E）**

- **改动**：`cutscene/Cutscene.ts` 的 `update()` 入口加 `if (!safeDt(dtMs)) return [];`
- **测试**：`cutscene · update 无 dt 守卫（P1）`（4 项）

#### J · `[debug-console]` `execute()` 的内部异常传播 — **改判：不翻转默认值，改为新增开关**

> ⚠️ **这一条我最初修错了，交叉验收后被纠正，过程完整记录如下。**

**我最初的做法**（已废弃）：把 `rethrow` 默认值设成 `false`，让控制台默认吞掉异常。
理由是"控制台是运行时调试的最后一道防线，不该把异常抛回 UI 输入事件处理器"。

**W1-B 的验收意见**：这是 review 标准 5「把故意的设计当成缺陷」的典型形态，三条证据：

| 证据 | 内容 |
|---|---|
| 源码注释 | 「内部错误是真 bug，向上抛以便崩溃上报捕获」 |
| README | 「错误分级」把"内部异常向上抛"列为**设计约定**，并给了解释 |
| 既有测试 | `run_batch10.ts:522` 固化了该行为 |

**我复核后认同，并补一条自己找到的决定性理由**：

> **翻转默认值是破坏性变更。** 已经按 README 接入 CrashReporter 的调用方，
> 会在毫不知情的情况下**静默丢掉全部内部异常** —— 而这正是那条约定要防的事。
> 我原本担心的"崩掉输入链路"，调用方显式传一个参数就能规避。
> **一个能自己规避的风险，不该用破坏性变更去替所有人规避。**

**最终方案**：

- **改动**：`debug-console/DebugConsole.ts` 新增 `rethrow?: boolean`，**默认 `true`（保持历史行为）**
- **语义**：
  - 默认 `true` → 内部异常继续向上抛，交 CrashReporter（与历史完全一致）
  - 显式 `false` → 只打印一行红字、不向外抛（输入框 / 调试期场景适用）
- **既有测试**：`run_batch10.ts` 的原用例**原样恢复**（它断言默认向上抛，本来就是对的），
  另新增一条 `rethrow: false` 的对照
- **README**：「错误分级」恢复原文，新增 `rethrow` 开关说明与"为什么默认是 true"的论证
- **测试**：`debug-console · execute 的内部异常传播（P1 · 已按裁决改判）`（**3 项**）
  - `默认向上抛（README 既有约定，不得静默改动）` —— 钉住历史行为
  - `rethrow: false 时吞掉异常，但仍打印红字` —— 钉住新开关
  - `rethrow: true 与默认行为一致` —— 防止矫枉过正

**这一条的教训**（写给自己和后来的窗口）：
"看起来不合理"和"真的是 bug"之间隔着一层——**先查 README 有没有把它写成约定**。
我当时读了源码注释但没查 README 的设计约定章节，是这次返工的根因。

#### K · `[debug-console]` `_coerce` 的 `int` 把空串当 0 — **已修**

- **改动**：`debug-console/DebugConsole.ts` 的 `_coerce`，`int`/`float` 分支前加空串检查
- **复现输出（修复前）**：`set_hp ""` → 参数值 **0**（静默把血量设为 0）
- **修复后**：输出 `✗ 参数 <v> 需要数字，收到空值`，命令不执行
- **为什么必须拦**：`Number('') === 0`、`Number(' ') === 0`，且 `Number.isInteger(0) === true`。
  引号内空串是合法 token（`tokenize` 只过滤未加引号的空白）。
  调试命令本来就权限很大，这条会让一个手滑输入直接毁掉正在调试的局。
- **测试**：`debug-console · _coerce 的 int 把空串当 0（P1）`（2 项）

#### L · `[gesture]` `maxPoints` 裁剪丢弃轨迹起点 → 长按判不出来 — **已修**

- **改动**：`gesture/Gesture.ts`
  - 新增 `_downT` 字段，`down()` 时记录
  - `isLongPressSoFar()` 用 `_downT` 而非 `_pts[0].t`
  - `up()` 里把 `_pts[0]` 的 **t** 修正为 `_downT`（**坐标保持不动**）
- **复现输出（修复前）**（`maxPoints:8`，静止按住 1 秒 / 20 个采样点）：
  ```
  pointCount=8  首点 t=600        ← 起点 0 被丢，窗口里最早的点已是 600ms
  isLongPressSoFar(1000)=false    ← 阈值 600ms，实际按了 1000ms，判不出来
  up -> {"kind":"tap",...}        ← 长按被识别成单击
  ```
- **修复后**：`isLongPressSoFar(1000) = true`，`up -> {"kind":"longPress"}`
- **为什么只改 t 不改坐标**：`pathLength` / `totalTurn` 只依赖坐标，
  改 t 不会影响滑动距离与画圈判定；而 `recognize` 算出的 dt 变成真实按住时长。
  **时长与轨迹是两种语义，就该分开存** —— 所以也不该改成"裁剪时不丢起点"
  （那会让窗口失去意义，轨迹无限增长）。
- **测试**：`gesture · maxPoints 裁剪丢起点导致长按判不出来（P1）`（2 项，含短按 tap、快速滑动对照）

#### M · `[matchops]` `Reconnect` 的 `graceMs` / `graceDecay` 为 NaN → 永不过期 — **已修**

- **改动**：`matchops/Reconnect.ts`
  - 构造收口：`graceMs` / `minGraceMs` 用 `numOr`，`graceDecay` 用 `clampNum(v, 1e-6, 1, 0.6)`
  - `_computeGrace` 出口再兜一次 `numOr(decayed, DEFAULTS.graceMs)`（**两道都要有**）
  - `forfeitAfterMs` 用 `numOr` 兜底
- **复现输出（修复前）**：
  ```
  graceDecay=NaN：
    第 1 次 grace=120000（Math.pow(NaN,0)===1，侥幸正确）
    重连后 attempts=1 → grace=NaN
    再断线，10 小时后 reconnect -> {"ok":true}   ← 永不过期
    tick(36e6) -> []                              ← 也永不判弃权
  graceMs=NaN：graceFor=NaN，10 小时后 reconnect -> {"ok":true}
  ```
- **修复后**：
  ```
  graceDecay=NaN → 重连后 graceFor = 72000（有限）
  10 小时后 reconnect -> {"ok":false,"reason":"expired"}
  tick(36e6) -> ["a"]                    ← 正常判弃权
  ```
- **机制**：`elapsed > NaN` 恒为 false → "超时"这个判据彻底消失。
  连带后果是他既不是 forfeited 也不是 exhausted，**队友连扣分减免都拿不到**。
- **为什么 `graceDecay` 限制在 (0,1]**：它是"递减系数"，>1 会让宽限期越重连越长，语义完全反了。
- **测试**：`matchops · Reconnect 的 graceMs/graceDecay 为 NaN（P1）`（4 项，含正常递减对照 120000 → 72000）

#### N · `[matchops]` `Surrender.vote` 对掉线玩家返回 `ok:true` 但票不计入 — **已修**

- **改动**：`matchops/Surrender.ts` 的 `vote()`，增加 `if (!this._connected.has(id)) return {ok:false, error:'not-connected'}`
- **复现输出（修复前）**：
  ```
  c 投票 -> {"ok":true}                              ← 告诉 c "你投成功了"
  status -> {yes:1, eligible:2, needMore:1}          ← c 的票没被计入
  ```
- **修复后**：`c 投票 -> {"ok":false,"error":"not-connected"}`，`status.yes = 1`
- **为什么是"当场拒绝"而不是"收下再作废"**：`_tally()` 里本来就有
  `if (!this._connected.has(id)) continue` —— 系统从一开始就没打算收这张票。
  与 `start()` 的 `requireAllConnected` 保持同一口径。
- **测试**：`matchops · Surrender.vote 对掉线玩家返回 ok:true（P1）`（3 项）

##### 补充披露：`SurrenderStatus` 新增了 `ignoredVotes` 字段

> 上一版报告只写了 `vote()` 加 connected 检查，**漏了这个接口变更**，W1-B 验收时指出，现补。

- **改动**：`SurrenderStatus` 新增**必填**字段 `readonly ignoredVotes: number`，`status()` 中计算
- **为什么需要它**：只把掉线者的票拒掉还不够 —— `_votes` 里仍存着 b **在线时**投的票，
  掉线期间被 `_tally` 跳过，于是 `yes` 会**凭空少一票**。
  调用方看到票数对不上，却没有任何字段能解释"少的那票去哪了"。
  `ignoredVotes` 就是这"消失的一票"的计数，UI 可据此提示"b 掉线中，其 1 票暂不计数"。
- **接口影响**：`SurrenderStatus` 的**必填**字段，构造该结构的调用方（其它窗口 / 业务层）会受影响
- **实测**：
  ```
  b 在线投票 → yes=2, ignored=0
  b 掉线     → yes=1, ignored=1
  b 重连     → yes=2, ignored=0    ← 票"复活"
  ```
- **测试**：`⚠️ ignoredVotes 让"已投但未计入"可见`（1 项，覆盖上述三步）

##### 已知取舍（W1-B 提出，本窗口认可，报总审知悉）

"票复活"现象仍在：掉线者的票不会被清除，重连后恢复计数，
**玩家可感知为"重连瞬间票数跳变、投降可能瞬间通过"**。
这是既有行为，不是本次引入的。本窗口选择**让它可见**（`ignoredVotes`）而非"掉线即清票"，
因为清票会引入新的状态同步问题，且原条目只要求"不该返回 `ok:true`"。
是否另立条目，由总审决定。

#### O · `[skill-variant]` `applyPatch` 的 switch 无 default — **已修**

- **改动**：`skill-variant/SkillVariant.ts` 的 `applyPatch`，补 `default: throw`
- **复现输出（修复前）**：`{op:'nope'}` → `apply` 返回 `{result:{dmg:5}, applied:['w']}`
  —— **补丁被算作已应用，但值没变**
- **修复后**：抛出 `未知补丁操作："nope"（只接受 set / add / mul / push / remove / max / min）`
- **测试**：`skill-variant · applyPatch 的 switch 无 default（P1）`（2 项，含七个合法 op 全量对照）

#### P · `[skill-variant]` 数值 op 未校验结果有限性 — **已修（附说明，见 §3-D）**

- **改动**：`skill-variant/SkillVariant.ts` 的 `applyPatch`，`add`/`mul`/`max`/`min` 之后校验结果有限性
- **测试**：`skill-variant · 数值 op 未校验结果有限性（P1）`（2 项）

#### Q · `[skill-variant]` 互斥检查只处理第一个冲突者 — **已修**

- **改动**：`skill-variant/SkillVariant.ts` 的 `_resolve`，`final.find(...)` → 收集**全部**冲突者
- **复现输出（修复前）**：A(prio 1)、B(prio 1)、C(prio 10, `excludes:['A','B']`)
  → `applied === ["B","C"]`。C 明确排除了 A 和 B，正确结果应只剩 C，但 B 被留下了。
- **修复后**：`applied === ["C"]`，`result.x === 3`
- **为什么这条特别危险**：因为 A 确实被移除了，表面上看"互斥是生效的"，更具欺骗性。
- **测试**：`skill-variant · 互斥检查只处理第一个冲突者（P1）`（2 项，含"低优先级者被跳过、高优先级保留"对照）

---

### 【P2】3 条

#### R · `[cutscene]` `update` 的 `guard < 64` 上限是魔法数 — **已修**

- **改动**：`cutscene/Cutscene.ts`
  - 构造新增 `opts.maxGatesPerTick`（`clampNum(v, 1, 1e6, 64)`）
  - 循环条件 `guard < 64` → `guard < this._maxGatesPerTick`
- **为什么必须提为配置**：它是"一帧最多解几道阻塞门"的上限。门极多时一帧推不完，
  演出**变慢**（不是卡死，但节奏被拉长），而调用方没有任何办法调整。
  数值埋在循环条件里，配置驱动这条铁律就落空了。
- **默认仍是 64**（保持原行为），需要时显式调大。
- **测试**：`cutscene · update 的 64 次门控上限是魔法数（P2）`（2 项）

#### S · `[debug-console]` `_history` 的"去重"只看上一条 — **已修（改文档 + 用测试钉住）**

- **判定**：**不改行为，只改文档**。
- **理由**：真的做成全局去重的话，调试时反复执行同一条命令
  （比如反复 `reload` 看效果）就再也翻不到历史，反而更难用。
  README 第 90 行已写明「**仅避免与上一条完全相同的记录**（A / B / A 记为 3 条）」，
  本条只需把它钉死，防止后人"顺手改成全局去重"。
- **测试**：`debug-console · 历史去重只看上一条（P2）`（1 项，断言 A-B-A 存 3 条、连续 A-A 只存 1 条）

#### T · `[debug-console]` `list()` 每次 `sort` + `_resolve` 是 O(n) — **已修**

- **改动**：`debug-console/DebugConsole.ts`
  - 新增 `_aliasIndex: Map<string, Entry>`，`register`/`unregister` 同步维护
  - `_resolve` 的别名遍历 → 索引查表（O(1)）
  - `list()` 的排序结果缓存到 `_listCache`，`register`/`unregister` 时置空
- **为什么敢缓存**：命令集合只在 register / unregister 时变化，
  这两处把缓存置空即可，不存在"缓存住了还在变"的窗口。
- **测试**：`debug-console · list() 每次排序 + _resolve 是 O(n)（P2）`（2 项，
  含 **unregister 后别名必须失效**的对照 —— 这条最容易在加索引时被漏掉）

### ⚠️ 补充披露：我改了 2 个既有测试文件

按 review_A 标准 4 的口径，改既有测试是敏感操作，**主动披露请总审核查**。
（改动只涉及断言与注释，未改测试结构与覆盖范围。）

#### 1. `tests/run_batch19.ts` › Cutscene · Timeline 构建器

原用例**名叫"with 并行"，断言却是串行**：

```ts
// 改前
test('with 并行（时长取 max）', () => {
  eq(d.steps[1]!.start, 1000, 'b 与 a 同时开始？不——应接在 cursor 后');
  eq(d.duration, 4000);
});
```

注释里那句"b 与 a 同时开始？不——应接在 cursor 后"说明：
**当年有人发现行为与预期不符，然后把错误行为固化进了断言**。

而 README 第 136 行写的是「`with(id, dur, data)` 并行添加（与上一个同时开始，总时长取 max）」，
第 141-142 行还专门强调过。文档与行为不一致，且测试站在行为那一边。

我按 README 的语义改了断言（`start === 0`、`duration === 3000` 取 max）。
**如果总审认为"串行才是设计如此、README 写错了"，请驳回 ——
但那样必须同时改 README，不能只留一个。**

#### 2. `tests/run_batch10.ts` › DebugConsole · 调试控制台

> **本版已回退**：上一版我把这条用例翻转成"默认吞掉"，并**夹带改了同文件里
> `binary` 单元的用例**（详见下方 §5）。现在原用例**原样恢复**，
> 只新增一条 `rethrow: false` 的对照（纯新增，不改动任何既有用例）。

#### 3. ⚠️ 上一版夹带改了 `binary` 单元 —— 已恢复（W1-B 判 🔴）

上一版的 `run_batch10.ts` 里除 `debug-console` 之外，**还改了 `binary` 单元的 float 用例**：

```diff
- test('⚠️ float 越界抛错，绝不静默截断 / 溢出回绕', ...)
+ test('⚠️ float 会 clamp 而不是溢出回绕', ...)
```

`binary` 既不在本窗口 8 个单元里，也不在 20 条清单里 —— **越界**。
而且被删掉的那段注释写明它是 **W8-B 的 P1-5**（float 静默截断会让坐标/血量"位置飘移"），
与 `binary/README.md` §6③「越界值绝不静默截断」配套。

W1-B 核对了两版实现的 md5 一致（`ba49a37e…`），确认**实现从未变过，是这条用例被改坏了**，
并使当前 main 从全绿变成 1 失败（唯一红灯）。

**已于本版完整恢复为基线 `4d2d534b` 的版本**，红灯消除（现 3697 全绿）。
`binary` 单元一行未动。

> 这三条的区别对总审很重要：
> **#1 是必要连带修改**（改了实现，断言必须同步）；
> **#2 是我判断失误后的回退**；
> **#3 是纯粹的越界**，没有任何理由，已恢复。

---

## 3. 两条"报告描述与实测有出入"的说明

> 任务书第 5.3 节要求："不成立要有真凭实据"。这两条**最终都修了**，
> 但**触发路径与报告描述不同**，按 §1.2 的口径（"按证据判断，不按注释判断"）如实记录。

### D · `[skill-variant]` "mul: NaN 污染技能数据" —— 报告给的触发方式已被挡住

报告原文：`{op:'mul', path:'dmg', value:NaN}` 作用于 `{dmg:5}` → 结果 `dmg: NaN`。

**实测不成立**。`assertOperand` 已经在入口拦下了操作数为 NaN / Infinity 的情况：

```
applyPatch({dmg:5}, {op:'mul', path:'dmg', value:NaN})
  → 抛错：mul 要求 value 是有限数字，"dmg" 的 value 实际是 null（number）
```

这条在更早的批次里已经修过了（对应注释「为什么需要它：`assertNumber` 只校验了目标字段」）。

**但同类的洞确实存在，只是入口不同**：老实现只校验**操作数**和**旧值**，**不校验结果**。
两个都合法的输入相乘可以溢出：

```
dmg: 1e308, mul: 10  →  Infinity
```

Infinity 进入技能定义后，伤害计算、UI 显示、存档全部变成 null
（JSON 序列化 Infinity 得 null），而 `applied` 列表里这个变体仍是"成功应用"的。

**所以保留这条修复，把判据从"操作数 NaN"改成"结果非有限"** —— 后者才是真正堵住的洞。

### E · `[cutscene]` "NaN 帧额外造成时间损失（112 而非 160）" —— 实测不成立

报告原文：`update(NaN)` 之后再正常跑 10 帧 16ms，累计只到 **112** 而非 160，
说明 NaN 帧还额外造成时间损失。

**实测不成立**。修复前后 `time` 都是 **160**，没有 112 这回事。
原因是 NaN 帧根本走不到推进分支：`want = time + NaN = NaN`，
`NaN > time` 恒为 false → 不推进也**不损失**，这一帧被自然跳过了。

**但这条 P1 依然成立，只是危害点不同，而且严重得多**。
真正的坑在**门控（`waitFor`）已经激活之后**来一个异常帧 —— 此时走的是
`this._blockElapsed += dtMs`，NaN 一进来 `_blockElapsed` 就永久变成 NaN，
而 `NaN >= timeoutMs` 恒为 false → **超时机制彻底失效**。

实测（修复前，门控激活后插一帧异常 dt，再正常推进 3000ms）：

```
对照（正常帧 100）: {"state":"finished","timedOut":true,"time":200}
NaN 帧            : {"state":"blocked", "timedOut":false,"time":100}   ← 永久挂起
Infinity 帧       : {"state":"finished","timedOut":true,"time":null}   ← 时间轴被污染
```

这才是报告说的"上层等演出结束的等待逻辑永久挂起" ——
它只在**带门控的演出**上发生，且异常帧必须落在门控激活之后。
测试就是按这个场景写的。

---

## 4. 交付物清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `tests/run_phase10_w1a.ts` | 新增 | 导出 `runPhase10W1ATests()`，**44 项全绿** |
| `builder/Builder.ts` | 改 | P1 ×2 |
| `craft/CraftSystem.ts` | 改 | P1 ×3 |
| `crash/CrashReporter.ts` | 改 | P1 ×2 |
| `cutscene/Cutscene.ts` | 改 | P1 ×2 + P2 ×1 |
| `debug-console/DebugConsole.ts` | 改 | P1 ×2 + P2 ×1 |
| `gesture/Gesture.ts` | 改 | P1 ×1 |
| `matchops/Reconnect.ts`、`matchops/Surrender.ts` | 改 | P1 ×2 |
| `skill-variant/SkillVariant.ts` | 改 | P1 ×3 |
| 8 个单元的 `README.md` | 改 | 同步新增/变更的 API 语义（`missing` / `lost` / `unlimited` / `rethrow` / `maxGatesPerTick` / 随机源 / 宽限期收口） |
| `tests/run_batch10.ts`、`tests/run_batch19.ts` | **改** | 既有测试断言了被判定为 bug 的旧行为，见 §2 补充披露 |
| `audit/result_W1-A.md` | 新增 | 本文件 |
| `audit/verify_W1-A.md` | 新增 | 对 W1-B 的验收报告 |

**未改动**（按第 6 节并行纪律）：`tests/run.ts`、根 `README.md`、`_core/`、`build.sh`、其它窗口的单元。

> 单元 README 的改动属于本次修复的文档配套（任务书 P2 亦明确要求
> "在 README 说明"）。根 `README.md` 里的测试总数按纪律未动，留总审统一更新。

### 测试有效性验证（对应 review_A 标准 2）

为确认"每条用例在修复前确实会失败"，我把 8 个单元（9 个文件）的源码
**整体回退到基线 `4d2d534b`**（我动手那一刻的 main，即 `df65fca4` 的父提交），
重新编译后跑同一份测试：

```
基线代码 + 本窗口 48 项测试  →  通过 23 项，失败 25 项
当前代码 + 本窗口 48 项测试  →  通过 48 项，失败 0 项
```

25 条失败覆盖 §2 中**全部 19 个实质修复条目**（`craft.totalMaterials` 2 条、
`cutscene.update` 2 条、`cutscene.with` 2 条、`matchops.Reconnect` 2 条、
`matchops.Surrender` 2 条、`skill-variant` 3 条…… 其余各 1 条）。
23 条通过的全部是"对照"用例 —— **设计上就该前后都绿**。

> **计数口径更正**：上一版我写"22 通过 / 20 失败"（合计 42，与当时 44 项对不上）。
> W1-B 实测也是 22 / 22。本版因新增 4 项（J 改判 +1、ignoredVotes +1、
> craft count:0 +1、cutscene add→with→add +1）变为 48 项，重测为 **23 / 25**。

回退验证在独立副本（`/data/workspace/basetest2`）下完成，
**未触碰主 `.build/`**，规避了 README「已知风险」里那条"改回旧代码会损坏产物"。

---

## 5. 提交前自检结果

```
tsc -p tsconfig.json                 TSC OK（编译无错误）
node .build/tests/run.js             通过 3697 项，失败 0 项
                                     （不含本窗口未注册的 48 项，合并后 3745）
node .build 独立跑 run_phase10_w1a   通过 48 项，失败 0 项
node scripts/check-deps.js           有 1 项需要处理（见下，与本窗口无关）
node scripts/check-links.js          [OK] 42 条链接，断链 0 处
python3 scripts/scan-dt-guard.py     扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py    命中 0 处 ✓
python3 scripts/check-random-source.py  [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py [OK] 无待处理的冲突 ✓
```

### 两处需要说明的（都是并发推送造成的，非本窗口引入）

**1. `check-deps.js` 报 1 项**：`rebind` / `gameflow` 等 → `_core` 未登记。
这些单元**全都不是本窗口的 8 个单元**，属并发推送覆盖的已知问题（W1-B 的报告里也点到了）。
本窗口未新增任何跨单元 import，无需改 `_kitmeta.json`。

**2. `check-links.js` 的断链已消失**：上一版我报的 `handoff_W3-B.md` 断链，
现已被 W3-B 窗口修掉（现为 42 条 / 0 断链）。
顺带更正我上一版的判断 —— 我当初说它是"既有问题、与本窗口无关"，方向对；
但 W1-B 进一步查清了根因：那是**行内反引号里的 TypeScript 源码**（`this._derived[id](...)`）
被脚本当成了 markdown 链接语法，属脚本误报。**结论一致，根因以 W1-B 的为准。**

---

## 6. 对 W1-B 验收意见的处理（返工记录）

W1-B 的验收报告（`audit/verify_W1-B.md`）结论为**有条件通过**，
提出 1 项 🔴 必须返工、2 项裁决、5 项建议。**全部处理完毕**：

| # | W1-B 的意见 | 本窗口的处理 | 状态 |
|---|---|---|---|
| 🔴 §4.1 | 越界改了 `binary` 单元用例并制造唯一红灯 | **完整恢复**为基线版本，`binary` 一行未动 | ✅ 已返工 |
| ⚖️ §5.1 | `debug-console` rethrow 默认值该不该翻 | **采纳**：回退默认值到 `true`，改为新增开关 | ✅ 已改判 |
| ⚖️ §5.2 | `cutscene` `with()` 并行还是串行 | W1-B 倾向采纳我的修法（README 说"取 max"，只有并行才可能取 max） | ✅ 维持 |
| ⚠️ §4.2 | 基线数字写错（3694+2 不成立） | **采纳并更正**：基线实为 3696 全绿，见 §0 | ✅ 已更正 |
| ⚠️ §4.3 | `ignoredVotes` 新字段未披露、无断言 | **补披露 + 补断言**，见 §2-N | ✅ 已补 |
| ⚠️ §4.6 | 建议补 2 条对照（`craft` count:0、`cutscene` add→with→add） | **两条都补了** | ✅ 已补 |
| ℹ️ §4.4 | "票复活"现象 | 已在 §2-N 记录为**已知取舍**，报总审知悉 | ✅ 已记录 |

### 我自己的反省

这一轮最值得记的不是"改了哪几行"，而是 **J 这条为什么一开始判错**。

我当时读了源码注释（「向上抛以便崩溃上报捕获」），但**没去查 README 的设计约定章节**，
只凭"控制台不该把异常抛回 UI"这个直觉就翻了默认值。
而 README 里白纸黑字写着这是"三条设计约定"之一，还有既有测试固化。

**"看起来不合理"和"真的是 bug"之间隔着一层** —— 那层就是"有没有人把它写成过约定"。
按 review 标准 5 的口径，我这次踩的正是它点名的高风险形态。
W1-B 把它拦下来了，这是交叉验收机制真正起作用的一次。

---

## 7. 需要总审裁决的事项

1. **`cutscene` `with()` 的语义**（§2-H）：我按 README「与上一个同时开始，总时长取 max」
   改成了并行，并翻转了既有断言。W1-B 独立复核后**倾向采纳**（理由：串行实现下
   `add(a,1000).with(b,3000)` 的 duration 是 4000（累加），
   **只有并行才可能"取 max"**，串行实现根本走不到 README 描述的那个分支）。
   两个窗口独立得出同一结论，请总审确认后放行。
2. **`craft.totalMaterials` 的 `variants` 产率取最小**（§2-C）：语义选择
   （取最小 = 上界"照这个数备料一定够"；取最大 = 下界"最乐观"）。
   我按"宁可多算不可少备"取了最小，已封装在 `_yieldOf` 里，改口径成本一行。
3. **`Surrender` 的"票复活"现象**（§2-N）：掉线者的票不清、重连后恢复计数，
   玩家可感知为"重连瞬间票数跳变、投降可能瞬间通过"。
   本窗口让它**可见**（`ignoredVotes`）而非"掉线即清票"，是否另立条目由总审定。

**已无需裁决的**：`debug-console` rethrow 已按 W1-B 给出的方向改判（§2-J）；
`binary` 越界改动已恢复（§2 补充披露 #3）。
