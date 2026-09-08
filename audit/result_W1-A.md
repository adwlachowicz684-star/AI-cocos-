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
| 已修 | **18** |
| 已修（附说明） | **2**（见 §3 的 D、E 两条，报告描述与实测有出入） |
| 不成立 | 0 |
| 需总审裁决 | 0 |
| 新增测试 | `tests/run_phase10_w1a.ts`，**44 项**，全绿 |
| 全量回归 | **3696 项全绿（0 失败）** |

> ⚠️ **以上两个数字互不包含**：`tests/run.ts` 未改动，本窗口的 **44 项尚未注册**，
> 不在这 3696 里。合并后预期为 **3740**（3696 + 44）。
> （此点是在交叉验收 W1-B 时对照发现的 —— W1-B 明确写了"注册后应为 3753"，
> 我第一版漏了这句说明，现补正。详见 `audit/verify_W1-A.md` §6.3。）
| 校验脚本 | 6 个全过（1 处断链为既有问题，与本窗口无关，见 §5） |

### ⚠️ 一处与任务书不符，需要总审知悉

任务书写「基线已验证：构建通过、**3695 项测试全绿**」。

**实测原始代码（未经任何修改的 main 分支）不是全绿**，而是：

```
通过 3694 项，失败 2 项

  ✗ DebugConsole · 调试控制台 › ⚠️ 命令内部异常默认被吞掉（不崩调用方）
  ✗ Cutscene · Timeline 构建器 › with 并行（与上一个同时开始，时长取 max）
```

这两条失败**恰好就是本窗口清单里的两条 P1**（`debug-console` 的 rethrow、`cutscene` 的 `with`）——
说明测试文件里已经预置了等着修复的红灯用例，只是基线数字没同步。

**好消息是**：我的修法与预置用例的期望**完全一致**，修完这两条自动转绿。
所以最终 3696 = 3694（原通过）+ 2（红灯转绿），比任务书基线 3695 多 1 条，符合"只增不减"。

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

#### J · `[debug-console]` `execute()` 把命令内部异常 rethrow — **已修**

- **改动**：`debug-console/DebugConsole.ts`
  - 新增 `rethrow?: boolean` 选项（默认 **false**）
  - `_runBody` 的 `throw e` → `if (this._rethrow) throw e`
- **复现输出（修复前）**：`dc.execute('boom')` **向外抛出** `Error: 内部炸了`
- **修复后**：默认吞掉并输出 `✗ 命令内部错误：...`；`rethrow:true` 时仍可上抛
- **为什么默认吞掉**：控制台是"运行时调试"的最后一道防线。
  它把异常抛回 UI 的输入事件处理器，一行打错的命令就能让整个输入系统崩溃，
  而此时错误**已经被打印过一次**（重复暴露）。
- **测试**：`debug-console · execute 把内部异常 rethrow（P1）`（2 项）
- **注**：本条同时让基线里既有的红灯用例 `run_batch10.ts › 命令内部异常默认被吞掉` 转绿。

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
- **测试**：`matchops · Surrender.vote 对掉线玩家返回 ok:true（P1）`（2 项，含在线者票照常计入）

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

原用例断言"命令内部异常向上传播（便于崩溃上报捕获）"，即把 rethrow 当作**正确行为**。
本批 P1 判定这是缺陷，新行为默认吞掉、由 `rethrow: true` 显式开启，
所以断言必须同步翻转。改后用例名 `⚠️ 命令内部异常默认被吞掉（不崩调用方）`，
并补了一条 `rethrow: true` 时仍上抛的对照。

> 两处都是"**既有测试断言了被判定为 bug 的旧行为**"，修复后不改必然红。
> 我认为属于必要连带修改，不是顺手重构；但判定权在总审。

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

为确认"每条用例在修复前确实会失败"，我把 8 个单元的源码**整体回退到 main 分支原始版本**，
重新编译后跑同一份测试：

```
通过 22 项，失败 20 项
```

20 条失败全部落在 §2 的 P1/P2 修复项上，对照用例（22 条）保持不变 ——
说明断言盯的确实是"修复后才会成立"的行为，不是"传 5 本来就不会 NaN"的无效用例。

（回退验证在临时目录 `/tmp` 下完成，未触碰 `.build/`，验证完已恢复修复版。）

---

## 5. 提交前自检结果

```
bash build.sh                        TSC OK（211 个 .js）
node .build/tests/run.js             通过 3696 项，失败 0 项   ← 基线 3695，涨 1
                                     （不含本窗口未注册的 44 项，合并后 3740）
node scripts/check-deps.js           全部通过 ✓
node scripts/check-links.js          44 条链接，断链 1 处（见下）
python3 scripts/scan-dt-guard.py     扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py    命中 0 处 ✓
python3 scripts/check-random-source.py  [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py [OK] 无待处理的冲突 ✓
```

### 关于 check-links 的 1 处断链

```
audit/handoff_W3-B.md  →  ](...)  解析为 audit/...
```

**与本次改动无关**：我在**未经修改的 main 分支原始代码**上跑同一个脚本，
得到完全相同的 1 处断链。指向的是 `W3-B` 窗口的任务书（非本窗口文件），
按第 7 节纪律我不直接改对方文件，回报总审 / W3-B 窗口处理。

---

## 6. 交叉验收（W1-B）

**结论：W1-B 尚未交付，本次无法验收。**

按第 7 节要求我验收同编号的 `W1-B`，但截至本次提交，远端 `main` 分支上：

- `audit/result_W1-B.md` —— **不存在**
- `tests/run_phase10_w1b.ts` —— **不存在**

`audit/` 下只有 `handoff_*` / `review_*` / `batch*` / `round01` 等前期文件，
没有任何 `result_*`。按 review_A 标准 1~5，验收对象是"对方的交付物"，
没有交付物则五条硬标准全部无从判断，硬凑一份"通过"是假验收。

详见 `audit/verify_W1-A.md`（已把 W1-B 的 20 条清单登记在案，
待对方交付后按五条硬标准逐条验收）。

---

## 7. 需要总审裁决的事项

1. **基线数字**：任务书说 3695 全绿，实测原始 main 是 3694 + 2 失败
   （且那 2 条正是本窗口的 P1）。最终 3696 全绿。请总审确认数字口径。
2. **`check-links` 的既有断链**（`handoff_W3-B.md`）不在本窗口范围，转 W3-B / 总审。
3. **`craft.totalMaterials` 的 `variants` 产率取最小**：这是个语义选择
   （取最小 = 上界"一定够"；取最大 = 下界"最乐观"）。我按"宁可多算不可少备"取了最小，
   如果总审认为该取最大或有别的口径，改一行即可（已封装在 `_yieldOf` 里）。
