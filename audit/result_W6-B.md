# 交付报告 · 窗口 W6-B（第 B 组）

> 单元：**adapters / dungeon / pathfind / replay**
> 任务书：`audit/handoff_W6-B.md`
> 测试：`tests/run_phase10_w6b.ts`（导出 `runPhase10W6BTests()`，**尚未注册到 `tests/run.ts`**——按并行纪律由总审统一合并）
> 基线：3695 项 → 现在 3695 项全绿（+ 本窗口新增 84 项，见第 5 节）

---

## 0. 一句话结论

**8 条 P1 全部已修；16 项 P2 中 15 项已修、1 项判定不成立（附证据）。**
新增回归 **84 项**，其中 **32 项在原始仓库上真实失败**（用只读取数脚本在**未修改的原始代码**上跑过，见第 4 节）。

---

## 1. 交付纪律自检

| 纪律 | 执行情况 |
|---|---|
| 不碰 `_core/` | ✅ 只读引用 `numOr` / `clampNum`，未改一行 |
| 不改 `tests/run.ts` | ✅ 未改，测试文件独立导出，等总审合并 |
| 不改 `README.md` | ✅ 未改 |
| 临时脚本 | ✅ 全部放在 `/data/workspace/`（仓库外），仓库内无 `verify/` 残留 |
| `_kitmeta.json` | ⚠️ **改了**：新增 3 条 `_core` 依赖登记（见第 6 节，不改则 `check-deps.js` 报错） |

**先复现后修改**：所有 24 条都在改代码前用只读取数脚本跑出过"修复前"输出，逐条写进下面表格的第 5 列。
**反向验证**：把新测试文件原样放到**未修改的原始仓库**上编译运行，得到 **32 项失败**（第 4 节有完整清单），证明这些用例不是"恒通过"。

---

## 2. P1 逐条（8 条，全部已修）

| # | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|---|---|
| 1 | adapters | P1 | **已修** | `toFlatGrid` 喂 `[-1, 300]` → `[255, 44]`（-1 变 255 号地形，300 变 44） | 默认收口到 `[0, 255]`；`{clamp:false}` 时抛 RangeError 并指明坐标与值 | `adapters · toFlatGrid 静默截断值域（P1）` |
| 2 | adapters | P1 | **已修** | `[[0,1],[1,0]]`：adapters `(0,0)=true / (1,0)=false`，fov 恰好相反 → **四处结论全部相反** | 默认值统一为 `[1]`，与 `fov.makeWallTest` 一致；显式传 `[0]` 仍保留旧语义 | `adapters · wallTestFrom2D 与 fov.makeWallTest 默认值（P1）` |
| 3 | dungeon | P1 | **已修** | `new BSPDungeon({width: NaN, height: 40, seed: 1})` **构造通过**，`generate()` 无异常，`floorCount = 0`，`isFullyConnected() = false` | `!(w >= 5) \|\| !(h >= 5)` → 抛错并说明"NaN 参与 `<` 比较恒为 false"。四种生成器共用基类，全部覆盖 | `dungeon · 尺寸校验拦不住 NaN（P1）` |
| 4 | dungeon | P1 | **已修** | `minRoomSize: NaN` → `roomCount = 16`，首个房间 `cx = NaN`，`allRoomsReachable() = false` | `numOr` 收口后再保留"小于 3 抛错"契约；`maxDepth`/`roomPadding`/`corridorWidth` 同样收口。NaN 与"省略参数"现在生成**同一张图** | `dungeon · minRoomSize=NaN 产生 NaN 房间（P1）` |
| 5 | pathfind | P1 | **已修** | 40×40 空地图 `(0,0)→(39,39)`：默认路径长 **39**、探索 40；`hw = NaN` → 路径长 **77**（腰折）、探索 79 | `numOr(opts.heuristicWeight, 1)`；NaN 与默认逐项一致。`hw = 2`（贪心）仍允许非最优——那是它的设计目的 | `pathfind · heuristicWeight=NaN 静默返回非最优路径（P1）` |
| 6 | pathfind | P1 | **已修** | 320×320 不可达：`maxNodes = NaN` 探索 **102391**（搜完整张图）；默认上限下应为 100001 | `clampNum(opts.maxNodes, 1, 1e7, 100000)`；负数收口到 1 | `pathfind · maxNodes=NaN 让防卡死上限失效（P1）` |
| 7 | replay | P1 | **已修** | 不传 seed 时 `load({...data, seed: 999999})` **不报错**；传 `seed: 1` 才正确抛出 | 默认**开启**校验（未指定种子按 0 校验），新增 `verifySeed: false` 显式关闭口子 | `replay · 默认 seed=0 让种子校验被跳过（P1）` |
| 8 | replay | P1 | **已修** | `playback(100)` 返回 `{jump:true}`，紧接着 `playback(50)` 返回 `{}`（应为第 0 帧的 `{jump:false}`） | 改用**二分查找**定位关键帧，彻底去掉"必须顺序调用"的隐含前提 | `replay · 倒带取帧静默返回空输入（P1）` |

### 需要总审裁决的 P1 改动（2 处，都是对外行为变更）

| 条目 | 变更 | 为什么必须改 | 代价 |
|---|---|---|---|
| #2 | `wallTestFrom2D` 默认墙值 `[0] → [1]` | 清单明确要求统一；不传参是最常用调用方式，默认值相反会让两个模块"各自单测全绿、接在一起全错" | 依赖旧默认值 `[0]` 的调用方**必须显式传 `[0]`**。已写进 JSDoc 并配了对照用例 |
| #7 | `ReplayRecorder.get seed()` 返回类型 `number → number \| null`；默认开始校验种子 | 0 是合法种子却兼任"不校验"哨兵，导致文件头承诺在默认配置下完全落空 | 依赖 `rec.seed === 0` 判断的代码需改；`ReplayData.seed` 导出仍是 number（未指定时写 0，加载侧按 null 判定，语义不冲突） |

两者我都选了"宁可让调用方立刻发现，也不要继续静默出错"，并保留了显式退回旧行为的口子（`[0]` / `verifySeed: false`）。若总审认为不可接受，请指示改回。

---

## 3. P2 逐项（16 项，15 已修 / 1 不成立）

### adapters（3 项）

| 项 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|
| `nearestCasterHits` 的 `n` 未收口 | **已修** | `n = NaN` 返回 **0** 个；`n = 1` 返回 1 个。`n <= 0` 对 NaN 恒 false，靠 `Math.min(NaN, len)` 的 NaN 传播"恰好"不循环 | `numOr` 收口 + `!(count > 0)` 否定式判定；`Infinity` 同样收口为 0 | `adapters · nearestCasterHits 的 n 未收口（P2）` |
| `toCasterHits` 的 `out` 复用语义未说明 | **已修（只补文档）** | 复用同一 `out` 时，上一次返回的数组会被清空并写入新结果（`a === b` 为 true） | JSDoc 写清"下次调用会清空上次返回的同一数组"，并给了踩坑示例 | `adapters · toCasterHits 的 out 复用语义（P2）` |
| `flattenDrops` 递归无深度限制 | **已修** | `const a = {...}; a.children = [a]` → `RangeError: Maximum call stack size exceeded`（**崩溃**，且发生在打死 Boss 正要结算那一刻） | 默认 32 层上限，超限时抛带路径的 RangeError；`A→B→A` 的环同样被拦；合法 ≤32 层嵌套正常展开 | `adapters · flattenDrops 递归无深度限制（P2）` |

### dungeon（6 项）

| 项 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|
| `rectsOverlap` 平行实现 | **不成立（附证据）** | — | 见下方"判定依据"，只补了说明性注释，**未改语义** | `dungeon · rectsOverlap 的相切语义（P2）` |
| `MazeDungeon` 热路径分配 | **已修** | 每个格子 `shuffle([4 个对象字面量])`，512² 迷宫约 26 万次分配 | 复用 4 个方向对象（每轮重置顺序后洗牌）。**同种子生成逐格相同的迷宫**：255×255 / seed=13 的 `floorCount` 修复前后都是 **34652** | `dungeon · Maze 热路径的逐个格子分配（P2）` |
| `randomFloor` 每次 O(n) 全扫 | **已修** | 512² 地图调用 300 次 → **294ms**（主线程阻塞，正好卡在进关卡那一刻） | 地板索引缓存 + `setTile`/`generate` 显式失效；实测 **5ms** | `dungeon · randomFloor / roomDistance 的 O(n) 热路径（P2）` |
| `roomDistance` 每次一次 BFS | **已修** | 512² 地图调用 100 次 → **446ms** | 按起点索引缓存 BFS 距离场；实测 **14ms**。同种子调用序列与缓存前逐次一致 | 同上 |
| `floorCount` 与 `isFullyConnected` 口径不一致 | **已修** | 一个 Floor 改成 Door 后，`floorCount` 少 1，而 `isFullyConnected` 统计 Floor+Door → 两个口径 | 全文件统一"可走 = Floor 或 Door"；`isFullyConnected` 的**起点查找**也补上 Door（原只找 Floor，一张"起点区是门"的图会被判成死图） | `dungeon · floorCount 与 isFullyConnected 口径不一致（P2）` |
| `Cellular._smoothBuf` 重入 | **已修** | 同实例开两个 generator 交替推进 → 各自跑完 47 步，**产出缝合地图且不报错** | 重入检测直接抛错；`try/finally` 保证任何出口清空缓冲（异常退出时 w×h 内存不再驻留）；`g.return()` 后可重新开始 | `dungeon · Cellular 的 _smoothBuf 重入（P2）` |
| `RoomDungeon` 未校验 `maxRoomSize` | **已修** | `min 900 / max 999` 配 24×24 地图 → 房间 `w=919, h=985`，`cx=460, cy=493`（**中心在地图外**）；`setTile` 静默截断，但 `room.w` 仍记原值 | 按 `短边 - 4` 收口上下界；房间中心必然落在地图内 | `dungeon · RoomDungeon 未校验房间尺寸（P2）` |

**`rectsOverlap` 判"不成立"的依据**（不因为"看代码觉得没问题"就下结论）：

1. `ds/DataStructures.ts:470-490` 已有注释**明确论证**了这套双语义：`ds.rectsOverlap` 用 `<`（相切不算，服务空间索引）、`_core.rectOverlaps` 用 `<=`（含相切，通用 AABB），并写明"两者都对，别混用"。
2. `audit/review_B.md` 的**标准 5** 把"相切语义"列为**最容易复发的误判案例**，明确写"两者都对，不能统一"，且"已有一条断言'两者结果必须不同'在守着，谁对齐成一致谁测试变红"。
3. 实测：dungeon 版与 `ds.rectsOverlap` 语义**相同**（都是 `<`），并不存在"三份实现"里的第三份分歧。

所以这里真正缺的是**说明**（后来的人会以为是笔误而去"统一"）。我只补了注释：写清为什么房间摆放必须允许"紧贴共用一道墙"，并配一条"spacing=2 时不得有任何房间相交"的对照用例看守。**未改任何判定逻辑。**

### pathfind（4 项）

| 项 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|
| `_openMark` 死代码 | **已修（删除）** | 全文 4 处写入、**0 处读取**，stamp 机制早已接管 | 删除字段与写入。危险不在性能而在误导：它只在 push 时写、pop 时从不清除，"标记"永远为真 | `pathfind · 删除死代码 _openMark（P2）` |
| `FlowField.destroy` 后 `distanceAt` 返回 `undefined` | **已修** | destroy 后 `distanceAt(0,0)` → `undefined`（typeof `'undefined'`），违反 JSDoc 的 `-1` 承诺 | 显式返回 `-1`。注意 `reachable()` 不受影响（`undefined >= 0` 恰好也是 false），所以这 bug 只在**直接拿返回值做数值运算**时显形 | `pathfind · FlowField.destroy 后 distanceAt 返回 undefined（P2）` |
| `PathSmoother.hasLineOfSight` 越界 `TypeError` | **已修** | `for(;;)` 只靠 `_walkable` 拦越界；传常见写法 `(x,y) => grid[y][x] === 0` 时，垂直方向 `grid[3]` 整个是 undefined → **TypeError**（水平方向恰好不崩，所以"有时崩有时不崩"） | 构造新增**可选** `bounds`；传了就在调用 walkable 前判越界。**不传时行为与原来完全一致**，不 breaking | `pathfind · PathSmoother 越界 TypeError（P2）` |
| `FlowField.build` 每次 `new Uint8Array(n)` | **已修** | `_dist/_dirs` 复用、`done` 每次新分配，**两处策略不一致** | `done` 也复用（`fill(0)`）。反复 `build` 同一目标的结果**逐格一致**（有对照用例守着脏值） | `pathfind · FlowField.build 每次新分配标记数组（P2）` |

### replay（3 项）

| 项 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
|---|---|---|---|---|
| `maxFrames` 实际限制关键帧数 | **已修（更名）** | 录 20 个关键帧、`maxFrames = 5` → 保留 **5** 个关键帧；字段名与 JSDoc"最大帧数上限"不符 | 新增语义准确的 `maxKeyframes`（同时传时以它为准），`maxFrames` 作为别名保留；JSDoc 写清"限制的是关键帧数，不是帧数"；提示文案同步改成"关键帧数上限" | `replay · maxFrames 实际限制的是关键帧数（P2）` |
| `playback` 返回内部引用 | **已修** | 两次 `playback(0)` 返回**同一个对象**（`a === b` 为 true）；返回的 `EMPTY_INPUT` 是模块级共享常量 | 返回浅拷贝；`EMPTY_INPUT` 用 `Object.freeze` 冻结 | `replay · playback 返回内部引用（P2）` |
| `loadJSON` 无 try/catch | **已修** | `loadJSON('{bad json')` → 裸 `SyntaxError: Expected property name...`，看不出是回放文件损坏 | 包装成 `[Replay] 回放数据不是合法 JSON：...`；顶层不是对象（42 / null / "str"）也明确报错 | `replay · loadJSON 无 try/catch（P2）` |

**顺带发现的一个连带危害**（写在这里，因为它改变了对 P2"返回引用"严重性的判断）：
在**原始仓库**上跑我的用例时，一条"防止矫枉过正"的对照用例（`录制与导出仍然做拷贝`）竟然失败了——
原因是上一个用例往共享的 `EMPTY_INPUT` 上写了一个 `jump` 字段，**污染了模块级常量**，
导致后续所有 `ReplayRecorder` 实例的 `_lastInput` 初始值不再是空对象，
`sameInput` 判定"输入没变化" → **录制静默丢弃了第一条输入**。
这不是理论推演，是实测：`data.keyframes[0]` 直接是 `undefined`。
修复（拷贝 + 冻结）后这条对照用例恢复正常。

---

## 4. 测试有效性验证（关键）

**方法**：把 `tests/run_phase10_w6b.ts` **原样**复制到**未修改的原始仓库**（从 main 分支重新下载的干净副本），编译后运行。

| | 通过 | 失败 |
|---|---|---|
| 原始仓库（修复前） | 52 | **32** |
| 本窗口（修复后） | **84** | 0 |

**修复前失败的 32 项**中，包含全部 8 条 P1 的复现用例，以及 dungeon 性能（294ms / 446ms）、
`flattenDrops` 爆栈、`Cellular` 重入、`FlowField.destroy`、`PathSmoother` 越界、
`loadJSON`、`playback` 引用等 P2 用例。

**修复前就通过**的 52 项主要是"对照用例"（正常输入不受影响）和几条无法在小样本上区分的断言——
例如 40×40 地图上 `maxNodes = NaN` 与默认都搜完全图（约 1591 格），
这条断言只能证明"NaN 与默认一致"，**上限是否真的生效由 320×320 那条用例验证**（该条修复前失败：102391 vs 100001）。

**为何不用"回退旧代码再跑一遍"的方式验证**：`review_B.md` 标准 2 明确禁止
（沙盒偶发 502 会中断构建并损坏 `.build/`）。我用独立只读脚本调用公开 API 完成复现。

---

## 5. 测试怎么跑

`tests/run.ts` 按纪律未改，总审合并时加两行即可：

```ts
import { runPhase10W6BTests } from './run_phase10_w6b';
...
runPhase10W6BTests();
```

未合并前可用独立 runner 验证（脚本放仓库外，不入参）：

```
node -e "const{setSuite,summary,reset}=require('./.build/tests/_framework.js');
const{runPhase10W6BTests}=require('./.build/tests/run_phase10_w6b.js');
reset();setSuite('W6-B');runPhase10W6BTests();summary();"
→ 通过 84 项，失败 0 项
```

---

## 6. 提交前自检

```
bash build.sh                        → TSC OK（产物校验通过：212 个 .js）
node .build/tests/run.js             → 通过 3695 项，失败 0 项
node scripts/check-deps.js           → 全部通过 ✓
node scripts/check-links.js          → 44 条链接，断链 1 处（**非本窗口引入，见下**）
python3 scripts/scan-dt-guard.py     → 扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py    → 扫描 0 处命中 ✓
python3 scripts/check-random-source.py → [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py → [OK] 无待处理的冲突 ✓
```

**两处需要说明的：**

1. **`_kitmeta.json` 被修改**：我给 `adapters` / `dungeon` / `pathfind` 新增了 `_core` 依赖
   （用了现成的 `numOr` / `clampNum`），不登记会让 `check-deps.js` 报"import 了但没登记"。
   用 `node scripts/check-deps.js --fix` 自动补的，只动了这 3 个单元的 `depends` 数组，其他字段未变。

2. **断链 1 处不是我引入的**：位于 `audit/handoff_W3-B.md:268`，是文档里一段示例代码里的
   文档里一段形如 `_derived` 加方括号取值的示例代码被链接扫描器当成 markdown 链接
   （本文件不重复出现那个写法，以免自己也踩同一个坑）。
   该文件属于 **W3-B 窗口**，我从未改动。对照：本窗口开工时（干净 main 副本）是 42 条链接 0 断链，
   现在 44 条 1 断链 —— 多出的 2 条链接和这 1 处断链都来自这期间其他窗口的推送。
   已报告，请 W3-B 窗口用反引号包一下那段代码即可。

---

## 7. 我改了哪些文件

| 文件 | 改动性质 |
|---|---|
| `adapters/Adapters.ts` | `toFlatGrid` 值域收口、`wallTestFrom2D` 默认值、`nearestCasterHits` 收口、`flattenDrops` 深度上限、3 处 JSDoc |
| `dungeon/Dungeon.ts` | 基类尺寸校验、BSP 四参数收口、`floorCount`/`isFullyConnected` 口径、地板与 BFS 缓存（含失效点）、Maze 方向缓冲复用、RoomDungeon 尺寸收口、Cellular 重入保护 + finally 清理、`rectsOverlap` 说明性注释 |
| `pathfind/PathFinder.ts` | `heuristicWeight`/`maxNodes` 收口、删除 `_openMark`、`distanceAt` 契约、`PathSmoother` 可选 bounds、`FlowField` 标记数组复用 |
| `replay/ReplayRecorder.ts` | seed 校验默认开启 + `verifySeed`、`playback` 二分定位 + 返回拷贝、`EMPTY_INPUT` 冻结、`loadJSON` 错误包装、`maxKeyframes` 更名 |
| `tests/run_phase10_w6b.ts` | 新增，84 项 |
| `_kitmeta.json` | 3 条 `_core` 依赖登记（脚本 --fix 生成） |

**没有**顺手重构：所有改动都对应清单里的一条，没有改命名风格、没有调整结构、没有删"看着没用"的代码
（唯一删除的 `_openMark` 是清单明确列出的死代码）。

---

## 7.1 推送后复核（在远程最新 main 上重跑）

推送完成后，重新下载远程 main 的完整副本，把本批改动**原样放进去**重跑一遍
（避免"本地是绿的、推上去就红"——这个仓库 16 个窗口在并行推，本地基线随时会过期）：

| 项目 | 结果 |
|---|---|
| `bash build.sh` | TSC OK（产物校验通过：222 个 .js） |
| `node .build/tests/run.js` | **通过 3696 项，失败 0 项**（基线 3695，其他窗口同期新增 1 项） |
| 本窗口 `runPhase10W6BTests()` | **通过 84 项，失败 0 项** |
| `check-deps.js` | 我的 4 个单元**已全部登记**；剩余 8 条未登记（i18n / blessing / curse / rarity / achievement / rebind / gameflow / accessibility）**均为其他窗口的单元**，与本批无关 |
| `check-links.js` | **[OK] 42 条链接，断链 0 处** |
| `scan-dt-guard.py` | 命中 0 处 ✓ |
| `scan-num-guard.py` | 命中 0 处 ✓ |
| `check-random-source.py` | [OK] ✓ |
| `check-dup-exports.py` | [OK] ✓ |

**关于第 6 节提到的断链**：验收时看到的那 1 处断链（`audit/handoff_W3-B.md:268`）
在推送时已由 **W3-B 窗口自己修好**，所以最终复核是 0 断链。本窗口从未改动该文件。

**推送方式说明**：本环境里 Git 的 smart-HTTP 端点（`git-upload-pack` / 推送通道）不可达，
只能通过 GitHub API 提交。已用 Git Data API 基于推送瞬间的 main（`d62db0f9`）
创建 tree + commit 并更新 ref（**non-force**，未强推），提交为 `a75973a9`。
只提交了本批 8 个文件，未整体覆盖仓库，其他窗口的并行推送不受影响。

---

## 8. 给后续窗口的一句话提醒

`dungeon` 现在有两处缓存（地板索引、BFS 距离场）。
**任何绕过 `setTile` 直接写 `_tiles` 的新代码，必须调 `_invalidateCaches()`**，
否则会读到旧地形——在已经变成墙的格子上刷怪，比慢更糟。
`generate()` 的三个入口已经处理了，新加生成器时别忘了。
