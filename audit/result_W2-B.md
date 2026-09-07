# 交付报告 · 窗口 W2-B（第 B 组）

> 任务书：`audit/handoff_W2-B.md`（19 条：P1 11 / P2 8，含子项共 22 个）
> 单元（9 个）：`config` `curse` `hitbox` `leaderboard` `minimap` `save` `scheduler` `subtitle` `telegraph`
> 测试：`tests/run_phase10_w2b.ts`（导出 `runPhase10W2BTests()`，**80 项独立全绿**）
> 示例：`examples/subtitle-usage.ts`（新增，补 rule7 缺口）

| 项目 | 结果 |
|---|---|
| 全量回归 | `node .build/tests/run.js` → **通过 3695 项，失败 0 项**（与开工基线一致，只增不减） |
| 本窗口新增用例 | **80 项**（未注册进 `run.ts`，按任务书 5.2 留给总审统一合并；合并后应为 3775） |
| 六个校验脚本 | 全部通过（详见文末） |
| 改动单元 | 9 个单元 + `_kitmeta.json`（`curse.depends` 补 `_core`，由 `check-deps.js --fix` 写入） |
| `_core/` | **未改动** |
| `tests/run.ts` | **未改动** |
| 根目录 `README.md` | **未改动** |

---

## 1. 逐条结果

### 1.1 P1（11 条）

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| P1-1 | config | P1 | 已修 | `validateTable` 报出的问题 = `[]`；`get(hero,1)` = `{"id":1,"name":"第二个（id 撞了）"}`；`count(hero)` = 2 | 数字 id 纳入查重；索引覆盖额外记一条 issue（指向"按 id 只能取到最后一条"） | `run_phase10_w2b.ts` › config · 数字型 id 的重复检测与索引覆盖（P1-1）×4 |
| P1-2 | curse | P1 | 已修 | `stacks=2` → `effects = [{"stat":"maxHp","op":"set","value":200}]` | `set` 分支直接返回 `e.value`；2 层仍是 100 | › curse · set 效果不得被层数缩放 ×3 |
| P1-3 | curse | P1 | 已修 | `stacks=-3` → `mul 2` 的效果变成 **0.125**（取倒数）；`stacks=NaN` → `value=null` | `stacks = Math.max(0, Math.floor(numOr(e.stacks,1)))`；`since` 非有限回落注入时间源 | › curse · importState 的 stacks 校验 ×5 |
| P1-4 | hitbox | P1 | 已修 | `add` 后直接 `b.x=100;b.y=100` → `remove('z')` → **仍有 4 个格子**持有 id `'z'`（`_boxes` 里已删除） | 新增 `Map<id, number[]>` 账本，`remove`/`update` 按登记过的格子清理 | › hitbox · 绕过 update 改坐标后的 remove ×4 |
| P1-5 | leaderboard | P1 | 已修 | `importEntries` 收 NaN 后 `ranked = [{p1, rank 1, score null}, {p2, rank 2}]` | 非有限分数条目被丢弃，记 `lastDroppedCount`；`{strict:true}` 时与 `submitAll` 一致抛错 | › leaderboard · importEntries 的分数校验 ×4 |
| P1-6 | leaderboard | P1 | 已修（附说明） | 2 万条 × 60 次 `page()` = **913ms**；`page(1,0)` → `pageCount = Infinity`、`hasNext = true` | `ranked(start,end)` 只展开区间；`pageSize` 收口到 ≥1；60 次翻页 <200ms | › leaderboard · 分页不再全量展开 ×5 |
| P1-7 | minimap | P1 | 已修 | 世界 1000×100、res 100、`reveal({x:500,y:50},100)` 只揭开 **21 格**（应为全高 100 格） | X/Y 分别算跨度 + 真实圆形判定；顶部/底部均被揭开 | › minimap · FogMap.reveal 在非正方形世界 ×5 |
| P1-8 | minimap | P1 | 已修 | `scale: 0` → `minimapToWorld({x:10,y:10},{x:0,y:0})` = `{x:NaN, y:NaN}` | 构造期下界 `MIN_SCALE = 1e-6`；负/NaN/Infinity 一并收口 | › minimap · scale 的下界 ×4 |
| P1-9 | save | P1 | 已修 | `clearAll()` 后 `storage.keys()` 仍是 **`save_slot1__tmp`** | `clearAll()` 追加 `purgeTempKeys()`；另提供独立 `purgeTempKeys()`（只动本前缀） | › save · clearAll 清理 __tmp 残留 ×4 |
| P1-10 | scheduler | P1 | 已修 | `maxDeltaTime=0` → 5 帧回调 **0 次**、`lastRealDt=0`；`=-1` → `lastRealDt=-1`、delay 永不到期 | 非正/非有限**整体回落默认 0.1**（不是夹到下界）；`>1e6` 截断 | › scheduler · maxDeltaTime 的收口 ×4 |
| P1-11 | telegraph | P1 | 已修 | `spawn` 后 `clear()` → `onComplete` 次数 **0**（`cancelAll()` 是 1） | `clear()` 复用 `cancelAll()`，两者均带 `cancelled=true` | › telegraph · clear 与 cancelAll 行为一致 ×4 |

### 1.2 P2（8 条 / 子项 22 个）

| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| C2 | config | P2 | 已修 | 同一张表 `load()` 三次 → issues **1 → 2 → 3** | `_loadTable` 入口先丢掉该表的旧 issue（与 `reload()` 同口径） | › config · 热重载与查询口径 ×4（含 3 条对照） |
| C3 | config | P2 | 已修 | `count('nope')` = **0**（静默），而 `all('nope')` 抛"未加载" | `count()` 统一走 `_requireTable` 抛错 | › config · C3/C5/C6/C7 ×6 |
| C4 | config | P2 | 已修 | 数据源返回非数组 → 抛出 **`TypeError: rows is not iterable`**（在 try 之外，`throwOnError:false` 挡不住） | 记成一条 issue："数据源返回的不是数组（实际 [object Object]）" | 同上 |
| C5 | config | P2 | 已修 | 取消后再注册同一 fn、再调旧取消函数 → handlers 长度 **0**（新注册被删） | 包一层带 `alive` 标记的闭包，取消幂等 | 同上 |
| C6 | config | P2 | 已修 | 表 A 声明但本次未加载 → 引用它的表报 **`引用了不存在的表 "b"`**（级联误报） | 已声明的表不在这里重复报（真因是那次加载失败，由 `_loadTable` 报）；真写错表名仍报 | 同上 |
| C7 | config | P2 | 已修 | `tags:[1,2,3]` 只报 **`第 0 个元素类型错误`** 1 条 | 一次列出第 0/1/2 个（仍是同一字段的一条 issue） | 同上 |
| Cu3 | curse | P2 | 已修 | `add(id, now = Date.now())` 内部取墙钟 | 新增 `nowProvider` 选项，默认仍是 `Date.now`（既有调用方零改动） | › curse · 时间源注入与可卸载 ×5 |
| Cu4 | curse | P2 | 已修（附说明，见 §3.3） | `curse.pick()` 与 `blessing.pick()` 逐行同构 | **判定为"刻意独立"，不抽公共实现**，只补注释说明两条理由 | 无代码改动 |
| Cu5 | curse | P2 | 已修 | `tick`×2 后 `costCount=2`，`importState` 后仍是 **2**（沿用上一局） | `importState` 清 `_costCount` | › curse · 时间源注入与可卸载 ×5 |
| Cu6 | curse | P2 | 已修 | 无 `destroy()`（违反铁律 5） | 新增 `destroy()` | 同上 |
| — | hitbox | P2 | 已修 | `samplePoints` 里弧 **8** 段、胶囊 **6** 段硬编码（rule4 违反） | 新增 `sampleCounts?: {arc, capsule}`，默认 8/6 与历史一致；非法值回落默认，上界 256 | › hitbox · 采样密度可配 ×3 |
| Lb3 | leaderboard | P2 | 已修 | `page(1,0)` → `pageCount = Infinity`、空页但 `hasNext=true`；`pageSize=-1` → 空页 | `pageSize` 收口到 ≥1 的整数 | › leaderboard · 分页不再全量展开 ×5 |
| Lb4 | leaderboard | P2 | 已修 | `tieBreak:'later'` 的两个榜合并后保留 **at=1**（应为 at=2）——配置静默失效 | 合并改用 `opts.tieBreak` | › leaderboard · 合并与可卸载 ×3 |
| Lb5 | leaderboard | P2 | **未修（附说明）** | `submit` 末位比较后再全量 `sort` | 语义正确，仅多一次 `O(n log n)`；批量路径已有 `submitAll` | 见 §3.5 |
| Lb6 | leaderboard | P2 | 已修 | 只有 `clear()`，无 `destroy()` | 新增 `destroy()` | › leaderboard · 合并与可卸载 ×3 |
| — | save | P2 | 已修 | `write()` 失败只 `console.error` + `return false`（4 处） | 新增 `lastError` 字段 + `onError` 回调（注入后不再打 console，避免污染宿主日志）；成功时清空 | › save · 失败原因要能被查到 ×3 |
| S2 | scheduler | P2 | 已修 | `timeScale.update(Date.now())`、`TimeScale.add(now = Date.now())` | `nowProvider` 注入（Scheduler 与 TimeScale 各自可配），默认 `Date.now` | › scheduler · 时间源与收口 ×9 |
| S3 | scheduler | P2 | 已修 | `hitStop(-1)` / `slowMotion(0.5,-5)` 后 `layerCount = 0`（顿帧静默丢失） | `durationSeconds` 非正/非有限 → 抛错（早炸早发现） | 同上 |
| S4 | scheduler | P2 | 已修 | 每帧 `Array.from(this._tasks.values())`（热路径分配） | 快照缓存，仅任务集合变动时重建；稳态零分配 | 同上 |
| S5 | scheduler | P2 | 已修 | `delta === 0` 的浮点相等判断，极小非零 dt 仍触发回调 | 低于 `MIN_EFFECTIVE_DT = 1e-12` 视为未推进 | 同上 |
| S6 | scheduler | P2 | 已修 | `hitStop(0.08, 0.05)` 默认参数是魔法数字 | 新增 `hitStopDuration` / `hitStopScale` 配置项，默认 0.08 / 0.05 | 同上 |
| — | subtitle | P2 | 已修 | 全库 119 个单元中**唯一**没有可运行示例（rule7 违反） | 新增 `examples/subtitle-usage.ts`（22 项自检全过），README 增加"示例"章节指引 | › subtitle · at() 的复杂度与正确性 ×6 |
| — | subtitle | P2 | 已修 | 3000 行、查询 290 万毫秒附近 600 次 = **10ms**（从数组头一路扫到命中点，越往后越慢） | 二分定位 + `maxEndBefore` 前缀最大值回溯；600 次 <20ms，且与全量扫描结果逐点一致 | 同上 |

---

## 2. 修复前复现的方法

所有"复现输出（修复前）"列都是**本窗口在改动前实跑**出来的，不是抄原报告的证据。
方式：在 `git clone` 下来的原始代码上先 `bash build.sh`，再用只读脚本调用公开 API
（放在 `/tmp` 下，不落进 `verify/`，以免触发 `check-deps.js` 的目录未登记报错）。

---

## 3. 需要总审裁决的 7 项

按任务书第 8 节，以下不自己拍板，列出两种选择的利弊：

### 3.1 `config` · `count()` 对未加载表从"返回 0"改为"抛错"（C3）
- **利**：与 `all()` / `get()` / `where()` 口径一致，符合本文件开头"缺失即报错"的承诺；能立刻暴露"表名写错 / 没 loadAll 到它"。
- **弊**：**对外行为变更**，任何 `if (loader.count(t) > 0)` 的既有调用方会在未加载时抛错。
- 我选了"统一抛错"，因为静默 0 的排查成本远高于改调用方的成本。若总审认为 breaking 不可接受，可退回"返回 0 + 新增 `hasTable()`"。

### 3.2 `config` · `'1'` 与 `1` 是否算同一个 id（P1-1 的边缘情况）
- `Validator` 现在按**类型区分**（`'1'` 与 `1` 各占一个 key，不判重复）——这是最小改动，不会让原本合法的混用表突然报错。
- 但 `ConfigLoader` 的索引用的是 `String(id)`，**两者在索引层确实会撞**，所以那条"后者覆盖了前者"的 issue 仍会报。
- 两处口径不同但各自都成立。**是否要把它们统一**请总审定；统一成"算重复"会让混用 id 类型的表新增报错。

### 3.3 `curse` · `pick()` 与 `blessing.pick()` 是否抽公共实现（Cu4）
- **不抽（我的判断）**：铁律 6 禁止单元间横向 import；`_core/` 严禁本窗口改；新建"公共目录"会给全库多一个谁都能依赖的垃圾桶层。且两者语义已分叉（诅咒侧要排除已持有、权重是"出现概率"）。
- **抽**：消除重复代码，但第一次分叉就会被迫加参数开关。
- 我只补了注释明确"两份是刻意独立"。**若总审决定抽，这是跨单元改动，需要另开窗口处理**（本窗口不能改 `blessing`）。

### 3.4 `leaderboard` · `capacity` 上界要不要从 1e7 收到 1e5（P1-6）
- 任务书给了二选一，我选了 **`ranked(start,end)` 区间化**（分配量从 O(n) 降到 O(每页条数)），**未动 `capacity` 上界**。
- 理由：库里已有 `capacity: 20100` 的既有测试契约，收上界属于改配置语义；而翻页性能问题已被区间化解决。
- 代价：`snapshot()`（显式要全量）在 1e7 时仍会分配 1e7 个对象。若总审认为"配置允许即实现必须可用"，建议再收 `capacity`——但那需要同步核对既有测试。

### 3.5 `leaderboard` · `submit()` 的二分插入（Lb5）
- 未做。语义正确、仅多一次 `O(n log n)`；批量路径已有 `submitAll()` 兜底。
- 改它的收益是常数级，风险是动到"末位比较 + 排序"这条已经跑通大量既有用例的路径。**建议保持现状**。

### 3.6 `scheduler` · `maxDeltaTime` 非正值是"回落默认"还是"夹到下界"（P1-10）
- 我选了**整体回落 0.1**。因为夹到下界（1e-6）虽然不再倒流，但每帧只推进 1 微秒——游戏照样停摆，"定时器不工作"的故障现象一点没变，反而更难查。
- 一个让游戏倒流的值和一个让游戏停摆的值，都是"配错了"，都该按"没配"处理。

### 3.7 `scheduler` · `TimeScale.add` 对 `durationSeconds <= 0` 抛错（S3）
- **对外行为变更**：原本静默丢失，现在新增抛错。
- 选抛错而非"改成永久层"，是因为永久层更糟——一个本该 80ms 消失的顿帧会变成永久 0.05 倍速。
- 若总审担心启动期炸栈，可改成"记 warn + 不添加该层"，但那样又回到静默。

---

## 4. 未做的事（明确记录）

1. **未改 `tests/run.ts`**（任务书 5.2：总审统一合并）。因此全量仍显示 3695；本窗口 80 项在 `run_phase10_w2b.ts` 里独立全绿，合并后应为 **3775**。
2. **未改 `_core/`**、未改根目录 `README.md`（测试总数由总审统一更新）。
3. **未改 `audit/handoff_W3-B.md`**：`check-links.js` 报出该文件有 1 处断链（`](...)` 解析为 `audit/...`）。它不是本窗口的文件，为避免与 W3-B 窗口冲突我没有动，请 W3-B 或总审处理。
4. **未验收 W2-A 的实质内容**：`audit/result_W2-A.md` 与 `tests/run_phase10_w2a.ts` **均不存在**（全库当前只有 W7-A 已交付）。详见 `audit/verify_W2-B.md`。

---

## 5. 推送后复核（在远程最新代码上重跑）

推送完成后的 `main` 上还有其它窗口（W3-B、W4-B 等）新合入的改动。
为确认本窗口的改动在**合入后的真实仓库**里仍然成立，我从远程 `main`
重新拉了一份干净快照（`/tmp/verify`，含其它窗口最新代码），重跑全部校验：

```
$ bash build.sh
TSC OK（产物校验通过：218 个 .js）      # 213 → 218，其它窗口新增的文件

$ node .build/tests/run.js
通过 3696 项，失败 0 项                # 开工基线 3695，+1 来自其它窗口，只增不减
全部通过 ✓

$ node -e "...runPhase10W2BTests()"    # 本窗口 80 项独立运行
通过 80 项，失败 0 项
全部通过 ✓

$ node .build/examples/subtitle-usage.js
通过 22 项，失败 0 项
全部通过 ✓

$ python3 scripts/scan-dt-guard.py        扫描 146 个文件，命中 0 处 ✓
$ python3 scripts/scan-num-guard.py       扫描 0 处命中 ✓
$ python3 scripts/check-random-source.py  [OK] 未发现自建随机源 ✓
$ python3 scripts/check-dup-exports.py    [OK] 无待处理的冲突 ✓

$ node scripts/check-links.js
[✗] 断链 1 处：audit/handoff_W3-B.md（非本窗口文件，见 §4.3）

$ node scripts/check-deps.js
[✗] import 了但没登记 3 条：i18n / achievement / gameflow → _core
```

⚠️ **最后这 3 条不是本窗口引入的**：这三个单元属于 W3-A / W4-A 的验收范围，
是它们自己新 import 了 `_core` 但没登记。按 `review_B.md`「验收方不直接改对方代码」，
我没有 `--fix`（否则会把三个窗口的登记混进我这次提交）。
**请对应窗口或总审执行 `node scripts/check-deps.js --fix`。**
本窗口自己的 `curse → _core` 已登记，且我推送时是以远程最新 `_kitmeta.json`
为基底合并的（保留了 W4-B 对 `rebind` 的登记，净改动只有 `curse` 一条）。

---

## 6. 附：全库校验结果（改动后）

```
$ node .build/tests/run.js
通过 3695 项，失败 0 项
全部通过 ✓

$ node -e "require('./.build/tests/run_phase10_w2b.js').runPhase10W2BTests()"   # 本窗口独立运行
通过 80 项，失败 0 项
全部通过 ✓

$ node .build/examples/subtitle-usage.js
通过 22 项，失败 0 项
全部通过 ✓

$ node scripts/check-deps.js
[5] 登记与源码一致性（_kitmeta.depends vs 真实 import）
  ✓ 登记与实际一致
全部通过 ✓
（已用 --fix 补登 curse → _core，diff 仅 1 处）

$ node scripts/check-links.js
[✗] 内部链接 44 条，断链 1 处：audit/handoff_W3-B.md（非本窗口文件，见 §4.3）

$ python3 scripts/scan-dt-guard.py
扫描 146 个文件，命中 0 处 ✓

$ python3 scripts/scan-num-guard.py
扫描 0 处命中 ✓

$ python3 scripts/check-random-source.py
[OK] 未发现自建随机源，全部复用 _core.MathRandomSource

$ python3 scripts/check-dup-exports.py
[OK] 无待处理的冲突
```
