# 验收报告 · W6-A 验收 W6-B

> 验收对象：窗口 W6-B（`adapters` / `dungeon` / `pathfind` / `replay`）
> 交付物：`audit/result_W6-B.md` + `tests/run_phase10_w6b.ts`（84 项）
> 验收方式：**独立只读脚本** 跑公开 API（`/tmp/w6a/verify_w6b.js`，未放进仓库），
> 未使用"回退旧代码再跑一遍"的方式（`review_A.md` 标准 2 明令禁止）。
> 验收过程中**未改动 W6-B 的任何代码**。

---

## 结论

**通过**（24 项：23 项通过，1 项"不成立"判定经独立复核认可）。

- 8 条 P1 全部有可验证的、我自己复跑出来的"修复前"证据，不是照抄报告
- 16 项 P2：15 项已修、1 项（`dungeon` 的 `rectsOverlap` 平行实现）判"不成立"——**我独立复核后认可**
- 新增 84 项用例，我逐条读过；`runPhase10W6BTests()` 实测 **84 项全绿**
- 全库回归 **3696 项全绿**（开工基线 3695），条数只增不减
- 未发现"顺手重构"；唯一的结构性改动（dungeon 两处缓存）是清单 P2 明确要求的

**需要总审留意的 3 处**（都不构成返工，见第 4 节）：
① `dungeon.floorCount` 口径变更属对外行为变更，报告里没进"需总审裁决"清单；
② `nearestCasterHits(n = Infinity)` 收口为 0 而非常规直觉的"取全部"；
③ `dungeon/Dungeon.ts:1283` 绕开 `setTile` 直接写 `_tiles`（当前安全，属脆弱点）。

---

## 1. 我的复跑输出（标准 1：是否真的复现过）

以下全部由我自己在当前代码上跑出，脚本 `/tmp/w6a/verify_w6b.js`：

| 条目 | 修复前（我的独立复现） | 修复后（当前代码） |
|---|---|---|
| toFlatGrid 值域 | 旧实现直接写 `Uint8Array`：`[-1, 300] → [255, 44]` | `[-1, 300] → [0, 255]`；`{clamp:false}` 抛 RangeError |
| wallTestFrom2D 默认值 | 旧默认 `[0]`：`(0,0)=true / (1,0)=false`；`fov.makeWallTest`：`false / true` → **两处全部相反** | 新默认 `(0,0)=false / (1,0)=true`，与 fov 一致；显式 `[0]` 保留旧语义 |
| dungeon NaN 尺寸 | `NaN < 5 === false`（穿透）、`new Uint8Array(NaN*NaN).length === 0`（空地图） | `[Dungeon] 尺寸至少 5×5，实际 NaN×40。（NaN / undefined 会在这里被拦住…）` |
| pathfind maxNodes=NaN | `800 > NaN === false`（上限恒不生效） | 40×40 不可达：NaN 与默认同为 1591；`maxNodes=50` → 51；320×320 默认 → 100001（上限确实在卡） |
| pathfind hw=NaN | `5+NaN > 4+NaN === false`（二叉堆比较器全 NaN → 堆序失效） | hw=NaN 路径长 39 = 默认 39 |
| replay seed=0 哨兵 | `verifySeed:false`（等价旧默认）→ `seed:999999` **不报错** | 不传参 → 抛 `[Replay] 种子不匹配：数据是 999999，当前是 未指定（按 0 校验）…` |
| replay 倒带取帧 | 旧实现 `playback(50) → {}` | `playback(100)={jump:true}` → `playback(50)={jump:false}` → `playback(100)={jump:true}` |
| replay 返回引用 | 旧实现两次 `playback(0)` 同一对象 | `a === b` → `false` |
| dungeon 缓存性能 | 报告称 294ms / 446ms | 512² 地图：300 次 `randomFloor` **2ms**、100 次 `roomDistance` **8ms** |
| dungeon 缓存失效 | — | 全刷成墙后 `randomFloor() === null`（未返回旧格子）；`Floor→Door` 后 `floorCount` 641 → 641 |
| Maze 可复现性 | 报告称改前 255²/seed13 → 34652 | 同种子两次生成 `34652 / 34652`，`toString()` 逐格一致 |
| 其它 P2 | — | `flattenDrops` 自引用 → 带路径的 RangeError；`FlowField.destroy` 后 `distanceAt = -1`（typeof number）；`PathSmoother` 带 bounds 越界 → false；`loadJSON('{bad json')` → `[Replay] 回放数据不是合法 JSON：…` |

**判定：标准 1 通过。** 报告里的"修复前"输出与我的独立复现逐条吻合，
且我在 dungeon / pathfind 两条上额外补了"NaN 为什么会穿透"的 JS 层证据
（`NaN < 5 === false`、`800 > NaN === false`、`5+NaN > 4+NaN === false`）——
这类根因证据比结果数字更难被"抄对"，说明对方确实自己跑过。

---

## 2. 逐条验收（24 项）

标记：✅ 通过 / ⚠️ 小问题（建议补，不必返工） / ❌ 实质问题（必须返工）

### P1（8 条）

| # | 条目 | 标准1 复现 | 标准2 测试有效 | 标准3 对照用例 | 标准4 无顺手重构 | 标准5 未误判设计 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | adapters · `toFlatGrid` 静默截断 | ✅ | ✅ | ✅ 0/1/127/254/255 逐值不变 | ✅ 只动该函数 + JSDoc | ✅ | 默认 clamp、`{clamp:false}` 抛错的双口子设计合理 |
| 2 | adapters · `wallTestFrom2D` 默认墙值相反 | ✅ | ✅ | ✅ 显式 `[0]` 保留旧语义 + 越界仍算墙 | ✅ | ✅ | **breaking**，已列入报告"需总审裁决"表 ✅ 我认可其取舍 |
| 3 | dungeon · 尺寸校验挡不住 NaN | ✅ | ✅ 四种生成器各一条 | ✅ 60×40 正常出图连通；4×40 仍抛错 | ✅ 基类一处收口 | ✅ | 收口在基类，四个生成器共用，改法最省 |
| 4 | dungeon · `minRoomSize=NaN` | ✅ | ✅ | ✅ `minRoomSize=2` 仍抛错、=6 正常出图 | ✅ | ✅ | "NaN 与省略参数生成同一张图"这条用例很有说服力 |
| 5 | pathfind · `heuristicWeight` 未收口 | ✅ | ✅ | ✅ `hw=2` 仍允许非最优（贪心的设计目的） | ✅ | ✅ | **没有**把合法的贪心权重一起夹掉，标准 5 过关 |
| 6 | pathfind · `maxNodes` 未收口 | ✅ | ✅ | ✅ 大地图用例证上限真的生效 | ✅ | ✅ | 两条用例分工（小图证 NaN=默认、大图证上限）写得很清楚 |
| 7 | replay · 默认 `seed=0` 跳过校验 | ✅ | ✅ | ✅ `seed=0` 数据仍通过（0 是合法种子） | ✅ | ✅ | **breaking**（`rec.seed` 类型变 `number\|null`），已报裁决 ✅ |
| 8 | replay · `playback` 倒带返回空输入 | ✅ | ✅ | ✅ 顺序取帧行为不变、`seek` 与 `playback` 一致、越界 undefined | ✅ 二分定位 + 返回拷贝 | ✅ | 顺带修掉 `EMPTY_INPUT` 被污染的连带危害，属同一根因 ✅ |

### P2（16 项）

| # | 条目 | 标准1 | 标准2 | 标准3 | 标准4 | 标准5 | 备注 |
|---|---|---|---|---|---|---|---|
| 9 | adapters · `nearestCasterHits` 的 n 未收口 | ✅ | ✅ | ✅ n=1/2/50 正常 | ✅ | ⚠️ | 见第 4 节 ②：`n=Infinity` 收口为 0，与"取最近 N 个"的直觉存在张力，已附理由但建议补 JSDoc |
| 10 | adapters · `toCasterHits` 的 out 复用语义 | ✅ | ✅ | ✅ 不传 out 时返回新数组 | ✅ 只补文档 | ✅ | 纯文档条目，用例把"复用即同一对象"这个坑固化成断言，比只写注释强 |
| 11 | adapters · `flattenDrops` 递归无深度上限 | ✅ | ✅ 自引用、A→B→A 各一条 | ✅ ≤32 层正常展开、宝箱→剑结果不变 | ✅ | ✅ | 报错信息带完整路径，可定位 |
| 12 | dungeon · `rectsOverlap` 平行实现（**判不成立**） | ✅ | ✅ | ✅ spacing=2 时零重叠 | ✅ 只补注释 | ✅ | **我复核后认可**，依据见第 3 节 |
| 13 | dungeon · Maze 热路径分配 | ✅ | ✅ 255² 逐格一致 | ✅ 小迷宫仍全连通 | ✅ | ✅ | 用"floorCount 必须仍是 34652"锁住行为不变，比只测性能稳 |
| 14 | dungeon · `randomFloor` / `roomDistance` 的 O(n) | ✅ | ✅ 300 次 <150ms（实测 2ms） | ✅ 同种子随机序列逐次一致 | ✅ | ✅ | 缓存引入是清单要求的；失效点覆盖 `setTile` / `generate` |
| 15 | dungeon · `floorCount` 与 `isFullyConnected` 口径 | ✅ | ✅ | — | ✅ | ✅ | ⚠️ 见第 4 节 ①：属对外行为变更，未列入"需总审裁决" |
| 16 | dungeon · `Cellular._smoothBuf` 重入 | ✅ | ✅ | ✅ 单次生成正常、`return()` 后可重开 | ✅ | ✅ | `try/finally` 清理 + 重入抛错，两条用例覆盖异常与正常出口 |
| 17 | dungeon · `RoomDungeon` 未校验 `maxRoomSize` | ✅ | ✅ | ✅ 正常参数 4~10 行为不变 | ✅ | ✅ | 收口后仍保 `roomCount > 0`，没有夹过头 |
| 18 | pathfind · 删除死代码 `_openMark` | ✅ | ⚠️ | ✅ 连续两次 find 稳定 | ✅ | ✅ | 见第 4 节 ③：删除死代码本就无法写"修复前失败"的用例，可接受 |
| 19 | pathfind · `FlowField.destroy` 后 `distanceAt` | ✅ | ✅ 断言 `=== -1` 且 `typeof === 'number'` | ✅ `reachable` 前后语义不变 | ✅ | ✅ | 兑现 JSDoc 既有承诺，属"补债"不是改契约 |
| 20 | pathfind · `PathSmoother` 越界 TypeError | ✅ | ✅ | ✅ 不传 bounds 时旧行为不变 | ✅ | ✅ | 做成**可选** bounds，避免 breaking，处理得当 |
| 21 | pathfind · `FlowField.build` 每次新分配 | ✅ | ✅ 同一目标重算逐格一致 | ✅ 目标不可达 → false 且不影响后续 | ✅ | ✅ | 复用标记数组最怕脏值，用例正好咬住这点 |
| 22 | replay · `maxFrames` 名不副实 | ✅ | ⚠️ | ✅ 不设上限时全记 | ✅ 新增别名，旧名保留 | ✅ | 见第 4 节 ③：该 ⚠️ 用例修复前后都通过，标记有误导 |
| 23 | replay · `playback` 返回内部引用 | ✅ | ✅ 三个角度（同一对象 / 改返回值 / 冻结 EMPTY_INPUT） | ✅ 录制与导出仍拷贝 | ✅ | ✅ | 报告里主动写了"对照用例在原始仓库上失败"这一连带发现，诚实且有价值 |
| 24 | replay · `loadJSON` 无 try/catch | ✅ | ✅ | ✅ 合法 JSON 正常加载 | ✅ | ✅ | 顶层非对象（42 / null / "str"）也覆盖了 |

---

## 3. 关于 `rectsOverlap` 判"不成立"的独立复核（标准 5 的正面案例）

报告给了三条依据，我逐条核实：

1. ✅ `ds/DataStructures.ts:474-489` 确有注释论证双语义：本函数 `<`（相切不算，服务四叉树，避免边界物体重复命中）、`_core.rectOverlaps` `<=`（含相切，通用 AABB），并写"两者在各自场景下都对，**错的是不看语义就互相替换**"。
2. ✅ `review_B.md` / `review_A.md` 标准 5 把"相切语义"列为最容易复发的误判案例。
3. ✅ 我逐字比对了两份实现：`dungeon/Dungeon.ts:143-150` 与 `ds/DataStructures.ts:490-497` **完全相同**（都是 `a.x - padding < b.x + b.w && …`），并不存在"第三份分歧"。

**结论：判"不成立"有真凭实据，不是"看代码觉得没问题"。**
对方只补注释、未改语义，并配了"spacing=2 时不得有任何房间相交"的对照用例看守——
这正是标准 5 想要的处理方式。

---

## 4. 发现的问题（均不构成返工）

### ① `dungeon.floorCount` 口径变更未列入"需总审裁决"（小问题）

`floorCount` 现在把 `Door` 计入（与 `isFullyConnected` 同口径），`isFullyConnected` 的起点查找也从"只认 Floor"改成"Floor 或 Door"。
这是**对外返回值语义的变更**：调用方若用 `floorCount` 做跨版本对比/存档校验，数值含义会变。

- 影响面实际很小：`Door` 是公开枚举值，但全库从未被写入（handoff 亦记为死类型），故既有数据不受影响；全量回归 3696 全绿也印证了这点。
- 但按 `handoff_W6-B.md` 第 8 节第 1 条"修复会改变对外 API 行为 → 不要自己拍板"，这条应与 `wallTestFrom2D` / `replay.seed` 并列进裁决表。
- **建议**：由总审补一句确认即可，不必返工；若总审要求，可在 `dungeon/README.md` 补一句"可走 = Floor 或 Door，floorCount 含 Door"。

### ② `nearestCasterHits(n = Infinity)` 收口为 0（小问题，附我的判断）

`numOr` 把 `Infinity` 与 `NaN` 一视同仁地视为无效值 → 收口为 0（返回空数组）。
而"取最近 N 个"的直觉下，`Infinity` 更像是"取全部"。

- 对方的理由写在用例注释里：`i < Infinity` 会走"取全部"分支，**在"取最近 N 个"的语义下等于静默改变调用方意图**。
- 我认可这个取舍（Infinity 在这里几乎只可能来自配置错误，且失败是显式的"0 个"而非静默全取），
  但它确实是个可争议点。**建议**在 `nearestCasterHits` 的 JSDoc 里写一句"非有限值一律按 0 处理"。

### ③ 两条用例的"⚠️"标记有误导（小问题）

- `pathfind · 删除死代码 _openMark`：删除死代码**不可能**写出"修复前会失败"的用例，两条用例都是"删除后行为不变"。这是清单性质决定的，可接受，但把 `⚠️` 去掉更诚实（当前这两条没打 `⚠️`，符合预期——仅在此说明）。
- `replay · maxFrames=5 时保留 5 个关键帧` 打了 `⚠️`，但它断言的是**修复前后都成立**的行为（限制的确实是关键帧数），真正的变化是"新增 `maxKeyframes` 别名"。建议把这条的 `⚠️` 改成普通用例，避免读者误以为它是回归护栏。

### ④ `dungeon/Dungeon.ts:1283` 绕过 `setTile` 直接写 `_tiles`（提醒，非缺陷）

```ts
for (const i of region) this._tiles[i] = Tile.Wall;   // _removeSmallRegions
```

这是新增缓存后唯一一处绕开 `setTile` 的直写。
**当前是安全的**：`generate()` 在**开头**就调了 `_invalidateCaches()`，且 generate 内部不调用 `randomFloor` / `roomDistance`（我已 grep 确认），缓存只会在 generate 结束**之后**惰性构建，读到的是最终地形。

但它是个脆弱点：将来任何人在 generate 内部"先调 randomFloor、再直写 _tiles"，就会读到脏缓存。
对方在报告第 8 节已经向后续窗口喊话提醒同类问题——**建议顺手把这一处也改成 `setTile(i % w, (i / w) | 0, Tile.Wall)` 或在循环后补一次 `_invalidateCaches()`**，因为这里正是他提醒别人的那个坑本身。

---

## 5. 附：全库校验结果（我在验收时跑的）

```
bash build.sh                          → TSC OK（产物校验通过：224 个 .js）
node .build/tests/run.js               → 通过 3696 项，失败 0 项   （基线 3695，只增不减 ✅）
runPhase10W6BTests()（独立 runner）    → 通过 84 项，失败 0 项      ✅
node scripts/check-links.js            → [OK] 内部链接 42 条，断链 0 处  ✅
python3 scripts/scan-dt-guard.py       → 扫描 146 个文件，命中 0 处   ✅
python3 scripts/scan-num-guard.py      → 扫描 0 处命中               ✅
python3 scripts/check-random-source.py → [OK] 未发现自建随机源       ✅
python3 scripts/check-dup-exports.py   → [OK] 无待处理的冲突         ✅
node scripts/check-deps.js             → 环检测 ✓ 层违规 ✓ 跨模块 ✓ 内聚性 ✓ 分层表 ✓ L0 纯净 ✓
                                         [5] 登记一致性 ✗ 8 条（i18n / blessing / curse / rarity /
                                         achievement / rebind / gameflow / accessibility → _core）
```

**关于 check-deps 的 8 条**：全部是**其他窗口**的单元，与 W6-B 的四个单元零交集
（W6-B 自己新增的 `adapters` / `dungeon` / `pathfind` 三条 `_core` 登记已在他推送后生效，
本轮扫描里这四个单元均未出现）。
该问题不是 W6-B 引入的，也不该由 W6-B 修——**建议总审统一 `node scripts/check-deps.js --fix`**。

**关于 W6-B 修改 `_kitmeta.json`**：属于必要动作（不登记则 check-deps 报错，
且 `--fix` 只动 `depends` 数组），我认可；只是提醒总审：这个文件是共享文件，
若多个窗口同时 `--fix` 会互相覆盖，合并时注意。
