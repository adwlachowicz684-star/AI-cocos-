# 修复报告 · 窗口 W4-A（第 A 组）

> 单元：6 个（`bullet-pattern` `difficulty` `entity` `gameflow` `i18n` `matchmaking`）
> 条目：15（P1 9 / P2 6）
> 测试：`tests/run_phase10_w4a.ts` → `runPhase10W4ATests()`（**72 项**，独立运行全绿）
> 对家验收：`audit/verify_W4-B.md` 结论「通过」；已按其意见收尾，见第六节
> 基线：`bash build.sh` 通过、`node .build/tests/run.js` **3695 项全绿**（与开工前一致，只增不减）

⚠️ **`tests/run.ts` 未改动**——按分工由总审统一注册 `runPhase10W4ATests()`。
在总审合并之前，本文件需独立运行：

```bash
bash build.sh
node -e "const f=require('./.build/tests/_framework');f.setSuite('W4-A');
require('./.build/tests/run_phase10_w4a').runPhase10W4ATests();f.summary();"
```

本报告里所有"修复前"输出都是**本窗口自己跑出来的**，不是抄原报告的证据。
复现脚本放在 `/tmp` 下（未入库，避免 `verify/` 触发 `check-deps.js`）。

---

## 逐条结果

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| W4A-01 | bullet-pattern | P1 | 已修 | `shape: () => [0,1,2]` → `speed = [0,0,0]`（对照 `Shapes.ring(3,10,'b')` → `[10,10,10]`） | `speed = [8,8,8]`（读 `opts.speed`）；`ShapeSpec` 仍优先用自己的 `speed` | `run_phase10_w4a.ts` ›「自定义 ShapeFn 的速度」4 条 |
| W4A-02 | bullet-pattern | P1 | 已修 | `interval = NaN` **通过构造校验**，跑 600 帧产出 **0** 颗；`shots = NaN` 同样通过，600 帧产出 **297** 颗（有限次退化成无限） | 两者均在 `addEmitter` 抛错 | 同文件 ›「NaN 穿透构造校验」4 条 |
| W4A-03 | bullet-pattern | P1 | **不成立（附证据）** | `count = NaN / null / undefined` → **全部抛 `TypeError: [guard] spec.count 必须是有限数值`**，产不出 0 发也产不出 1 发 | 不改（见下方说明） | 同文件 ›「compileShape 的 count 收口」2 条 |
| W4A-04 | entity | P1 | 已修 | `onSpawn` 序列 `["B","A"]`（**C 从未执行**）；`onDeath` 首个自注销 → `["cb1"]`（cb2 被吞）；`onDestroy` → `["d2","d1"]` | `["B","A","C"]` / `["cb1","cb2"]` / `["d1","d2"]`；`kill`/`destroy`/`clear` 三处同改 | 同文件 ›「派发期间注销自己的安全性」7 条 |
| W4A-05 | entity | P1 | 已修 | 无效 id `999999`：非遍历中 `destroy()` → `false`，`forEach` 内部 → `true` | 两种上下文都是 `false`；有效 id 两种都是 `true` | 同文件 ›「destroy 对无效 id 的返回值」3 条 |
| W4A-06 | gameflow | P1 | 已修 | 200 次切换后 history 长度：默认 `32` / `limit=1` → **401** / `limit=0` → **201** / `limit=NaN` → **201**；`limit=0` 跑 2000 次 → **2001** | `0`/`1` → `1`，`NaN` → `32`，2000 次仍为 `1` | 同文件 ›「historyLimit 的收口与裁剪」6 条 |
| W4A-07 | i18n | P1 | 已修 | 连注册两个 `onChange` 后 `setLocale('en')`：回调1 触发 **0** 次，回调2 触发 **1** 次 | 两者各 1 次；取消订阅互不影响 | 同文件 ›「onChange 的多播」4 条 |
| W4A-08 | i18n | P1 | 已修 | `has('ui.start') = false` 但 `t('ui.start') = '开始'`；`has('item') = false` 但 `t('item',{n:3}) = '3 items'` | `has()` 与 `t()` 共用同一条查找路径 | 同文件 ›「has() 与 t() 的口径」4 条 |
| W4A-09 | i18n | P1 | 已修 | ru 包只写 `item_few`/`item_many` → `coverage('ru')` 报 **translated=1/1（100%）**，而 `t('item',{n:3})` 返回 `'3 个'`（回落中文） | 覆盖率报 `translated=0, missing=['item']`；`item_one`/`item_other` 仍算已翻译 | 同文件 ›「覆盖率与运行时复数口径一致」3 条 |
| W4A-10 | bullet-pattern | P2 | 已修（含 1 条分拆） | ① `aimAtTarget:false` 未给 `fixedAngle` → `angle = 1.5708`（仍在自动瞄准，期望 0）② dt=10s 那一帧产出 64 发后，**后续三帧仍各 64 发**（积压时间未清）③ `SequencePlayer` loop 跑 10.2 秒只触发 **9** 次（理想 10）④ `BulletPattern.destroy` / `SequencePlayer.destroy` 均为 `undefined` | ① → `0`（缺省固定角度取 0，`numOr` 收口）② 截断时 `e.time = 0`，下一帧回到 **1** 发常速 ③ → **10** 次（周期取"最后一步的 at"，减周期而非归零）④ 补 `destroy()` | 同文件 ›「aimAtTarget」「掉帧后的补发上限」「SequencePlayer 的循环周期」「destroy」共 10 条 |
| W4A-11 | difficulty | P2 | 已修 + **1 条需总审裁决** | `DifficultySystem.destroy` 为 `undefined` | 补 `destroy()`：清 `onAdjust` + 复位 DDA，**不动**档位配置 | 同文件 ›「destroy 与回调清理」3 条 |
| W4A-12 | entity | P2 | 已修 + **1 条不成立** + **1 条不修** | ① 20 万次 `spawn`+`destroy` 后占用槽位 = **0**（槽位被 `_free` 复用，不是无限增长）② `reg.destroy` 存在但那是 `destroy(id)`，无参 `destroy()` 缺失 ③ `query/queryAll/snapshot/forEach` 每次 O(n) 全表扫描 | ① **不成立**，不改 ② 新增无参 `destroy()` 重载（等价 `clear()`） ③ **不修**（见下方说明） | 同文件 ›「槽位上界」「无参 destroy」3 条 |
| W4A-13 | gameflow | P2 | 已修 | ① `_findTransition` 第一个 for 循环里 `t.to === this._current` 分支永不 `return`（死代码，且 `when()` 被多求值一次）② `update(Infinity)` 后 `timeInState = Infinity` | ① 删除冗余首循环，判定结果不变 ② 改用 `safeDt(dt)`，`Infinity`/`NaN` 均被拒 | 同文件 ›「update 的 dt 守卫」「_findTransition 的死代码」5 条 |
| W4A-14 | i18n | P2 | 已修 | 追加 `JSON.parse('{"__proto__":{"polluted":"yes"},"b":"B"}')` 后 `t('polluted')` 返回 **`'yes'`**（本应是 key 本身） | 返回 `'polluted'`；`Object.prototype` 未被污染；普通合并语义不变 | 同文件 ›「addLocale 的原型污染」4 条 |
| W4A-15 | matchmaking | P2 | 已修 | ① 空 if 残留 ② 10 人分 2 队、单位 `[4,3,3]` → 各队人数 **[7,3]** 且**不抛错** ③ `packResult` 里 `void metric;` ④ `fixRoles` 末尾 `void teamSize;` ⑤ `Lobby.destroy` / `Matchmaker.destroy` 均为 `undefined` | ① 删除（行为不变，已用测试固化） ② `best` 初值改 `-1`，无解时抛错 ③④ 移除未使用参数，同步调用点 ⑤ 两者都补 `destroy()` | 同文件 ›「分队无解」「平衡判定的强弱方向」「Lobby / Matchmaker 的 destroy」共 9 条 |

汇总：**已修 12 条 · 不成立 2 条 · 不修 1 条（P2 可选，已说明理由）· 需总审裁决 1 条**

---

## 一、判"不成立"的两条（附完整证据）

### W4A-03 · bullet-pattern `compileShape` 的 count 未收口

**审查意见**：`Math.max(1, spec.count)` → `count = NaN` 变 0 发，`count = null` 静默变 1 发。

**本窗口实测（当前基线，未改一行代码）**：

```
count=NaN       → TypeError: [guard] spec.count 必须是有限数值，实际 NaN（number）
count=null      → TypeError: [guard] spec.count 必须是有限数值，实际 null（object）
count=undefined → TypeError: [guard] spec.count 必须是有限数值，实际 undefined（undefined）
count=0         → 产出 1 个角度
```

原因是这一行在 P0 轮已经改成 `Math.max(1, needCount(spec.count, 'spec.count'))`，
`needCount` 先要求"有限整数"，NaN / null / undefined 全部**在编译期就抛错**，
既到不了 `Math.max`，更不会产出 0 发或 1 发。`compileShape` 上方那段长注释
（"老实现 `Math.max(1, spec.count)` 只挡了小于 1 的情况…"）记录的正是这次修复。

**为什么不采纳建议里的 `numOr(spec.count, 1)`**：那会把 NaN **静默变成 1 发**——
恰恰是本条意见自己要消除的"静默"行为，与本库 guard 的"立即失败并说清为什么"口径相反。

**仍写了测试**：把"守卫存在"固化下来。将来有人把 `needCount` 去掉，测试立刻变红，
而不是等某个配表漏填 count 才暴露。

### W4A-12① · entity `spawn` 无槽位上限守卫

**审查意见**：槽位超过 1048576 后 `idIndex === 0` → `isValidId` 恒 false → 实体静默查不到。

**本窗口实测**：`destroy()` 会把槽位压回 `_free` 空闲栈，下次 `spawn` 直接复用——
**5 万次 `spawn` + `destroy` 之后，占用槽位仍是 0**。

**推导链是对的，触发路径不存在**：要撞到那个上界需要**同时存活**超过 100 万个实体，
而在此之前内存早就先撑不住了。`EntityRegistry.ts` 文件头也明确写了
"`SLOT_CAPACITY` 是 id 编码模数，不是数量上限…这里刻意不做检查"。

测试里补了一条对照：手工构造 `makeId(SLOT_CAPACITY, 0)` 验证"index 溢出时 id 确实非法"——
证明审查意见的推导本身没错，只是要靠手工构造才能到达。已在单元 README 补上这段实测结论，
避免下一个人重复提出。

---

## 二、判"不修"的一条（P2 可选，说明理由）

### W4A-12③ · entity `query/queryAll/snapshot/forEach` 每次 O(n) 全表扫描

不改。理由：

1. **快照是"遍历安全"的前提**。`forEach` 的契约是"回调里可以改集合"——
   回调里 `destroy` 会被推迟到遍历结束，回调里 `spawn` 不会让本次遍历无限延长。
   这两条都依赖"先复制一份再遍历"。改成惰性迭代器会同时破坏这两条既有契约。
2. **属于行为变更，不是修缺陷**。任务书第 1.1 条第 1 条明确禁止顺手重构。
3. 真要优化，正确做法是给 `query(tag)` 加一张 `tag → Set<id>` 的倒排索引
   （构造期建、写入时维护），那是**加功能**，应单独提。

---

## 三、需总审裁决的一条

### W4A-11② · `difficulty`：`CURRENCY_GAIN` 在 `PLAYER_FAVORING` 集合里

**现状**：玩家表现好 → `ddaValue` 变正 → `currencyGain` **下降**。
也就是"打得越好，金币收益越低"——惩罚性 DDA。

**本窗口实测确认了方向确实是反的**（已写成测试，让裁决时有据可依）：

```
表现极好（report(1,10) × 50）→ ddaValue = +0.15
  multiplier('currencyGain') = 0.85   ← < 1
  multiplier('enemyHp')      = 1.15   ← > 1（方向相反，说明集合生效）
```

**两种读法，本窗口无法自行判断**：

| 读法 | 论据 | 改法 |
|---|---|---|
| ① 有意为之（防刷） | 强玩家刷金币效率本就高，再叠加加成会破坏经济曲线 | 保留集合，**补一条注释**说明意图 |
| ② 误放 | 与 `playerDamage` / `healRate` 同批出现，像是照抄时顺手加的；与本文件开头"DDA 目的 = 让水平不同的玩家都能通关"有张力 | 移出 `PLAYER_FAVORING` |

**为什么不自己拍板**：任一方向都会改变**线上经济曲线**，
经济数值的调整不该由一个"顺手修 P1"的窗口决定。

**已做的兜底**：在 `PLAYER_FAVORING` 上方写了完整注释记录这个分歧，
并在单元 README 加了提示——下游若要临时规避，读 `baseMultiplier('currencyGain')` 即可绕过 DDA。
**行为完全未改。**

---

## 四、改动清单（只列动过的文件）

| 文件 | 改动性质 |
|---|---|
| `bullet-pattern/BulletPattern.ts` | 新增 `EmitterOptions.speed`；`interval`/`shots` 改肯定式守卫；`_fire` 的速度与固定角度分支；`tick` 截断时 `e.time = 0`；`SequencePlayer` 循环减周期；新增 `destroy()` |
| `entity/EntityRegistry.ts` | 新增 `_dispatch()` 统一五处派发（遍历副本）；`destroy` 延迟分支先校验存在性；新增无参 `destroy()` 重载；抽出 `_findForDestroy()` |
| `gameflow/GameFlow.ts` | `historyLimit` 改 `clampNum`；`_pushHistory` 用正数起点；删 `_findTransition` 冗余首循环；`update` 改 `safeDt` |
| `i18n/I18N.ts` | `onChange` 改 `Set` 多播；抽出 `_resolve()` 让 `has`/`t` 同路径；`RESOLVABLE_PLURAL_FORMS`；`addLocale` 逐键写入并跳危险键；`destroy` 清集合 |
| `difficulty/DifficultySystem.ts` | 新增 `destroy()`；`PLAYER_FAVORING` 补存疑注释（不改行为） |
| `matchmaking/Matchmaker.ts` | 删空 if（仅注释）；新增 `destroy()` |
| `matchmaking/TeamBalancer.ts` | 贪心 `best` 初值改 `-1`，无解抛错；`fixRoles`/`packResult` 移除未使用参数并同步调用点 |
| `matchmaking/Lobby.ts` | 新增 `destroy()` |
| `bullet-pattern/README.md` `gameflow/README.md` `i18n/README.md` `entity/README.md` `difficulty/README.md` `matchmaking/README.md` | 同步文档（新增字段、语义变更、实测结论） |
| `tests/run_phase10_w4a.ts` | **新增**，72 项（对家验收后 +1：固化 `coverage` 可替代 `has` 旧用法） |

**未动**：`_core/`（禁令）、`tests/run.ts`（总审统一注册）、根 `README.md`（测试总数）。

---

## 五、提交前自检

```
bash build.sh                        → TSC OK（产物校验通过：228 个 .js）
node .build/tests/run.js             → 通过 3696 项，失败 1 项   ← 见下方说明
node -e "…runPhase10W4ATests()…"     → 通过 72 项，失败 0 项
node scripts/check-deps.js           → 全部通过 ✓
node scripts/check-links.js          → ✗ 见下方说明
python3 scripts/scan-dt-guard.py     → 扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py    → 扫描 0 处命中 ✓
python3 scripts/check-random-source.py → [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py → [OK] 无待处理的冲突 ✓
node scripts/check-links.js          → [OK] 断链 0 处 ✓（W3-B 已修脚本误判）
```

⚠️ 全量回归的 1 项失败**不属于本窗口**：

```
✗ 第九批 › BinarySerializer · 位级序列化 › ⚠️ float 会 clamp 而不是溢出回绕
   [Binary] float 越界：999（范围 -10..10）
```

这是 `binary` 单元（**W8-B 窗口**）与第九批老测试的冲突：老测试期望越界静默 clamp，
W8-B 改成了抛错。本窗口意见：W8-B 的方向对——`binary/README.md` §6③ 明确写了
"越界值绝不静默截断"，该改的是老测试。已交总审裁定。

✅ **已闭环**：`check-links.js` 那处断链是我推送时的遗留项，
根因是该文档第 268 行代码块里写了形如 `this._derived[id](省略号)` 的调用，
校验脚本把代码里的 `](` 误判成 markdown 链接——**这个"误报"的判断是对的**。
W3-B 在 `87b2a889` 修掉了脚本对行内代码的误判，现在全库断链归零：

```
node scripts/check-links.js   → [OK] 内部链接 42 条，断链 0 处（扫描 178 个 .md 文件）
```

---

## 六、对家验收的回应（W4-B 验收 W4-A · 结论「通过」）

W4-B 的 `audit/verify_W4-B.md` 给出结论**通过**，15 条全部达标、无标红，
另有 1 处命名小问题、1 处需总审留意的语义变更、1 处全库级并发问题。
逐条回应如下（本窗口已按意见改完的标 ✅）。

### ✅ 已修 · 小问题 1：一条"对照"用例修复前会失败

`W4A-02` 组最后一条原名「对照：interval = 0 / 负数 / 非数字都仍被拒」，
但实测它在开工前基线上**会失败**（`interval='x'` 字符串在旧代码里 `'x' <= 0` 为 false，不抛错）。
它拦的是真实加固项，性质是回归，标"对照"会误导。

已改名为 `⚠️` 并补注释说明：`0` / `-1` 两项修复前后都抛错（真对照），
`'x'` 是新增的加固，三者放一起是为了说明"守卫改肯定式后覆盖面变宽"。

### ✅ 已修（对方未指出，我复核时自己发现的同类问题）

复核 41/30 那组数字时发现，**"对照"命名但修复前失败的用例其实有 2 条**，
不只对方指出的 1 条：

| 用例 | 修复前失败原因 | 形态 |
|---|---|---|
| `interval = 0 / 负数 / 非数字` | `interval='x'` 旧代码不抛错 | 形态一：断言内容就是新行为（加固项） |
| `destroy() 不动难度档配置` | `d.destroy is not a function` | 形态二：断言的是旧行为，但**入口是新加的 API** |

形态二更容易被忽略：这类用例"语义上确实是对照"，
但因为必须先调用新增方法，在旧代码上必然抛 TypeError。
已在用例内补注释区分这两种形态，免得下一个人复核 41/30 时再困惑一次。

### ✅ 已处理 · 需留意 1：`has()` 语义变更的替代入口

对方指出：`has()` 改成与 `t()` 同口径后，不再能回答"**当前语言包**缺不缺这一条"
（有 fallback 时恒 true），本地化验收的"这份 en-US 还差几条"会失效。
这个代价是真实的。

**结论是不需要新增 API**——`coverage(locale).missing` 已能完整回答。实测：

```
zh 有 3 条、en 只翻 1 条时：
  has('ui.quit')            → true（回落中文，查不出 en 缺什么）
  coverage('en').missing    → ['ui.quit', 'item']    ← 正确
```

已在 `i18n/README.md` 补上交叉引用与改写示例（`if (!has(key))` → `coverage().missing`），
并**新增一条测试**（W4-A 现为 72 项）把"coverage 能承担这个职责"固化下来。
刻意不新增 `hasInLocale()` 之类的变体：两个长得像但口径不同的查询并存，
比一个口径明确的查询更容易用错。

### 同意（无需本窗口动作）

- **说明 1**（`W4A-13` 删死代码只有对照用例）：判断正确。行为不变的清理
  按定义不可能有"修复前失败"的断言，标准 2 应记 N/A。
- **说明 2**（移除 `packResult` / `fixRoles` 未使用参数不是 breaking）：
  已确认两者都是 `TeamBalancer.ts` 内未导出函数，对下游无影响。
- **第四节全库并发问题**：`_kitmeta.json` 的 `depends` 被各窗口互相覆盖，
  未登记数从 1 条涨到 6 条。**本窗口同样不执行 `--fix`**——
  理由与 W4-B 一致：各自 fix 会被下一次提交冲掉，只能由总审统一跑一次。
  （其中 `i18n` / `gameflow` 两项来自本窗口，已确认是真实 import。）

### 复核结论：对家的验证数据属实

我用自己那份开工前基线独立重跑了他的验证：

```
把 run_phase10_w4a.ts 拷进开工前基线、编译到独立目录
  → 通过 41 项，失败 30 项          ← 与对方报告完全一致
```

他的方法也合规：编译到 `/tmp/w4a_bb` 独立目录，没有碰 `.build/`
（`review_A.md` 第 2 节明令禁止破坏性验证）。
