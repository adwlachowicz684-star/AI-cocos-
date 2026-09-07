# 精审返工任务书 · 窗口 W2

> 本文件是**第二次精审 273 条**中分配给窗口 W2 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **34**（P1 22 / P2 12） |
| 单元 | **12** 个 |
| 来源批次 | batch1 |
| 并行窗口 | 共 8 个（W1~W8），**单元零重叠** |

---

## 0. 一句话任务

按第 3 节的清单，逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

---

## 1. 角色与纪律

你是**执行者**，不是审查者。拿到清单 → 复现 → 修 → 写测试 → 自检。

### 1.1 三条硬纪律

1. **不要顺手重构。** 只改清单指出的那一行/那一处。
   这个库大量"看起来别扭"的写法都带长注释解释原因；你"顺手优化"的代码，
   很可能是另一个单元赖以正确工作的前提。
   我自己就在 `prewarm` 上犯过——顺手把预热数夹到 `maxSize` 以内，
   既有测试立刻变红，因为那两个是**独立的契约**。

2. **改之前必须先复现。** 写个最小脚本跑出"修复前"的现象，把真实输出贴进报告。
   没有复现就不要改——报告里的"证据"是别的窗口写的，你要自己验证一遍。

3. **注释要写"为什么"，不是"改了什么"。**
   重点写：坑的表现是什么、为什么原写法会中招、为什么新写法是对的。
   这个库最大的价值就是这些注释——很多坑会换个地方重新长出来。

### 1.2 一个反直觉但很重要的口径

**注释/文档如果主动论证"这是设计如此"，你要格外警惕，而不是格外放心。**

真实案例：

- `perception` 的抖动注释写"只影响观感，不需要可复现"——实测抖动值直接喂进了 `alert` 累积，**注释前提是假的**。
- `_core` 的 `smoothDamp` 曾把失效的 maxSpeed 记成"Unity 标准行为，非 bug"，还附了实测数据和权威叙事——**数据为真、归因为假**。
- README 曾把已修的缺陷记成"设计如此"，导致后来的人看到文档就不去修。

**文档说"没问题"不等于真没问题。按证据判断，不按注释判断。**

---

## 2. 代码库速览

```bash
cd /data/workspace/AI-cocos--main
bash build.sh                    # 编译到 .build/（不要跳过）
node .build/tests/run.js         # 全量回归
```

`build.sh` 有产物自愈与**逐文件比对**（不是只比总数——总数校验抓不到"tests 少 23 个"的情况）。

### 2.1 七条铁律（违反会导致构建/校验失败）

| 铁律 | 内容 |
|---|---|
| 1 | **无引擎依赖**：不得 `import 'cc'`，只能用注入的适配器。唯一例外 `adapters/CocosAdapter.ts` |
| 2 | **不 import 引擎类型**：连 `import type { Node } from 'cc'` 也不行 |
| 3 | **运行时依赖 0**：不得 import 任何第三方包 |
| 4 | **配置驱动**：数值不得硬编码，要可配 |
| 5 | **可卸载**：有 `install` 必须有对应的 `uninstall`/`destroy` |
| 6 | **禁止横向 import**：单元之间不得互相 import（`_core` 例外） |
| 7 | **复制即可用**：使用者拷走目录后改 0 行 |

### 2.2 现成共享工具（`_core/`，**直接用，不要自己造**）

| 工具 | 用途 |
|---|---|
| `clampNum(v, lo, hi, def)` | 数值收口，**NaN 会回落到 def** |
| `numOr(v, def)` | 非有限值回落 |
| `safeDt(dt)` | dt 守卫（挡 NaN / 负数 / 过大） |
| `needCount(n, max?)` | 无界 count 守卫（挡 Infinity / NaN） |
| `hasOwn(obj, k)` | 原型链安全的 `in` |
| `assertSafePath(p)` | 路径写入的原型污染防护 |
| `MathRandomSource` | 唯一允许的随机源 |

**`_core/` 不在任何窗口的清单里，严禁修改。** 它被 55 个单元依赖，你改一行会同时影响另外 7 个窗口。

### 2.3 六个校验脚本（提交前全部要过）

```bash
node scripts/check-deps.js        # 依赖分层
node scripts/check-links.js       # 内部链接
python3 scripts/scan-dt-guard.py  # dt 守卫
python3 scripts/scan-num-guard.py # 数值收口
python3 scripts/check-random-source.py  # 随机源
python3 scripts/check-dup-exports.py    # 重复导出
```

⚠️ **临时验证脚本放 `verify/` 会导致 `check-deps.js` 报错**（该目录未登记分层）。
用完请删除 `verify/`，或直接放 `/tmp` 下。

---

## 3. 本批清单

### 3.1 你的单元（12 个，与其它窗口零重叠）

```
adapters  analytics  dungeon  feedback  fov  mmr  mover  pathfind  rarity  rebind  replay  scenerouter
```

---


## 【P1】先做这批

### P1 · [adapters] `toFlatGrid` 静默截断值域，且 JSDoc 未声明 0~255 约束

- **位置**：`Adapters.ts:89`~`:96`
- **现象**：用 `Uint8Array` 存 tile 值，越界值静默 mod 256。地牢/网格里 `-1` 常表示"未生成 / 未知"。
- **证据**：`tileAt` 返回 `-1` → 得到 **255**；返回 `300` → 得到 **44**（`b1_v3` [22]）。
- **后果**："未生成"的格子被当成 255 号地形传给渲染器或网络包，表现为地图上出现不存在的地形块；存档回读后地形错乱。不报错。
- **建议**：JSDoc 显式声明值域，并在写入前 `clampNum` 或对负值抛错（建议：`-1` 这类哨兵值应在适配层显式映射，而不是靠 mod 兜底）。

### P1 · [adapters] `wallTestFrom2D` 与 `fov.makeWallTest` 的默认"墙值"完全相反

- **位置**：`Adapters.ts:112` 默认 `wallValues = [0]`；`fov/FOV.ts:521` 默认 `[1]`
- **现象**：同一张图、同一个"墙"概念，两个函数的默认值相反。而不传参正是最常用的调用方式。
- **证据**：同一张图 `[[0,1],[1,0]]`：`(0,0)` 处 adapters 判定 **true（是墙）**，fov 判定 **false（不是墙）**；`(1,0)` 处 adapters **false**，fov **true**——**两处结论全部相反**（`b1_v3` [22]）。
- **后果**：`adapters` 的注释 `:102`~`:108` 专门对比了 `makeWallTest` 却没提默认值相反。照抄用法会导致视野从实体墙里穿出去、或从空地撞上看不见的墙；两个模块各自跑通、接在一起就全错，且没有任何报错。
- **建议**：统一默认值为 `[1]`，并在注释里明确写出"默认值与 fov.makeWallTest 一致"。

### P1 · [analytics] `variance` 用单次 `sumSq - n·m²`，大数值小方差时被灾难性消去抹平

- **位置**：`ABTest.ts:249`
- **现象**：`Math.max(0, v)` 把消去产生的负数直接压成 0，掩盖了精度崩溃。
- **证据**：`variance([1e8+1 .. 1e8+5])` 返回 **0**（精确值 2）；`variance([1e9+7, 1e9+9, 1e9+11])` 返回 **0**（精确值 4）（`b1_v3` [39]）。
- **后果**：埋点金额、时长这类"大基数小波动"指标，方差被算成 0 → 置信区间为 0、t 检验失效 → 结论"差异显著"或"无差异"都不可信。典型场景是 ARPU 类实验。
- **建议**：改用两遍算法（先算均值，再累加 `(x - m)²`），或 Welford 在线算法。

### P1 · [dungeon] 尺寸校验用 `< 5` 挡不住 NaN → 生成一张"空地图"且不报错

- **位置**：`Dungeon.ts:176` `if (width < 5 || height < 5) throw`
- **现象**：NaN 比较恒 false → 校验通过 → `new Uint8Array(NaN * NaN)` 得到 **length = 0** 的空地图。
- **证据**：`new BSPDungeon({ width: NaN, height: 40, seed: 1 })` **构造通过**，`generate()` 无异常；`tileAt(0,0) = undefined`，`isFullyConnected() = false`，`floorCount = 0`（`b1_v2` [16]）。
- **后果**：尺寸来自关卡配置表时，一次填错就产出空地图；`isFullyConnected()` 恒 false 会触发"死图重生成"逻辑——如果宿主的策略是"重试 N 次"，就会**连续重试 N 次都失败**，表现为"进关卡卡在加载"或"反复重生成直到超时"。
- **建议**：`if (!(width >= 5) || !(height >= 5)) throw`（取反式守卫能覆盖 NaN）。

### P1 · [dungeon] `minRoomSize = NaN` → 生成 NaN 坐标的房间，连通性判定全错

- **位置**：`Dungeon.ts:436`（`if (minRoomSize < 3) throw`）、`:493`~`:503`（房间尺寸计算）
- **现象**：同样挡不住 NaN → `rw/rh/rx/ry` 全为 NaN → 一个 NaN 房间被 `push` 进 `_rooms`（`_carveRoom` 因 NaN 循环不执行，地图上并没有真的房间）。
- **证据**：`minRoomSize = NaN` 时 `roomCount = 16`，首个房间 **`cx = NaN`**，`allRoomsReachable() = false`（`b1_v2` [16]）。
- **后果**：`findFarthestRoom`（常用于放 Boss 房/出生点）基于 NaN 距离算出错误结果；连通性判定失败同样触发死图重生成。**全文件的 `minRoomSize` / `maxDepth` / `roomPadding` / `corridorWidth` 都是 `?? 默认值`，未收口。**
- **建议**：全部改 `numOr`，尺寸类再用 `clampNum` 定上界。

### P1 · [feedback] `update` 的 dt 守卫是 `!(realDt > 0)`，挡不住 Infinity

- **位置**：`HitFeedback.ts:321`（`update(realDt)`）
- **现象**：守卫写成 `!(realDt > 0)`，`!(Infinity > 0)` = false → Infinity 穿透，把所有实例的 `elapsed` 推到 Infinity 并全部清除。
- **证据**：`update(Infinity)` 后 `activeCount = 0`（期望 1）——**当前所有打击反馈瞬间消失**（`b1_v2` [2]）。
- **后果**：任务书 A 类点名的写法。切后台再回来、断点续跑、时间戳异常时 dt 可能是巨大值，表现为"所有震屏/闪白/飘字同时消失"。
- **建议**：改用 `_core` 的 `safeDt`（该单元其他部分已用，此处漏）。

### P1 · [fov] `isSymmetric()` 把 B 的视野永久写进 `explored`

- **位置**：`FOV.ts:355`~`:363`；`compute` 内标记 explored 在 `:236`~`:237`
- **现象**：`isSymmetric` 内部连调两次 `compute()`。第二次 `compute(bx, by, ...)` 会把 **B 的视野写进 `explored`**，且调用结束后 `this.visible` 停在 B 的视野上。
- **证据**：`compute(10,10,6)` 后 explored = **113** 格；调用一次 `isSymmetric(10,10,13,10,6)` 后 explored = **148** 格；调用后 `visible.has(10,10) === true`（即 visible 已是 (13,10) 的视野）（`b1_v3` [27]）。
- **后果**：探测"双方是否互见"这个**纯查询动作**不可逆地污染战争迷雾——玩家没去过的区域被点亮。而 `explored` 只能靠 `resetExplored()` 全清（换关级操作），中途无法撤销。AI 每次做对称性检查都点亮一小片地图，几场战斗后迷雾基本失效。
- **建议**：`isSymmetric` 内部先快照 `explored`，算完恢复；或提供 `computeInto(map, x, y, r, { recordExplored: false })`。
- **影响面**：任何"怪物是否看得见我"的 AI 判定都会误伤迷雾系统。

### P1 · [fov] Raycasting 的 `_castRay` 在 NaN 坐标下永不退出

- **位置**：`FOV.ts:492`~`:509`
- **现象**：越界检查写成 `x < 0 || y < 0 || x >= w || y >= h`，**NaN 参与比较恒为 false**，拦不住；步进条件 `e2 > -dy` / `e2 < dx` 在 `e2 = NaN` 时同样恒 false → `x/y` 恒为 NaN → `for(;;)` 死循环。
- **证据**：按源码逐步模拟 4 步：越界拦截恒 `false`，`x=NaN y=NaN e2=NaN`，前进 X/Y 恒 `false`（`b1_v2` [17]）。对比 `Shadowcasting._blocked` 用 `!_inBounds(...)`，NaN 能被正确拦住。
- **后果**：起点坐标算成 NaN（目标被销毁后 `atan2(NaN)`、除零等）时，一次射线投射直接冻死主线程，无异常、无日志，表现是"游戏卡住"。
- **建议**：改用 `!this._inBounds(x, y)`（取反能覆盖 NaN），并在函数入口加 `Number.isFinite` 校验。

### P1 · [mmr] `baseRating` 的 switch 没有 default 分支 → 非法 strategy 静默返回 undefined

- **位置**：`TeamMMR.ts:183`~`:215`
- **现象**：TS 的穷尽性检查只覆盖类型内取值，挡不住运行时的脏字符串。未枚举到的 strategy 使所有 case 都不匹配 → 函数返回 `undefined` → `effective = NaN`。
- **证据**：`strategy = 'average'`（配置里很容易写成 average / Weighted 这类大小写或别名）→ `base = undefined`、`effective = **NaN**`，**不抛错**（`b1_v2` [10]）。
- **后果**：匹配分恒为 NaN → 玩家被分进任意对局或被匹配系统丢弃，表现为"排不到人"或"分局实力悬殊"。配置改一个字符串就能触发，且没有任何提示。
- **建议**：加 `default:` 分支，对未知 strategy 抛错（快速失败）或回落 `'weighted'` 并告警。

### P1 · [mmr] `MmrPlayer.rating` 未做有限性校验 → 一个 NaN 传染整局匹配分

- **位置**：`TeamMMR.ts`（`rating` 直接参与 `maxOf`/`minOf`/加权）
- **证据**：任一玩家 `rating = NaN` → `base = NaN`、`effective = **NaN**`（`b1_v2` [10]）。
- **后果**：rating 来自服务端返回或新玩家默认值，出现一次 null/NaN 就让整队的匹配分失效，且 NaN 会传染到分差校验、窗口计算，最终可能让 `validateParty` 放行本应拒绝的队伍。`weightBase` 同样用 `?? 0.7`（NaN → 所有权重 NaN；负数 → 分母可能为 0 除零）。
- **建议**：入口对 ratings 做一次 `Number.isFinite` 过滤或抛错；`weightBase` 用 `clampNum`。

### P1 · [mover] `addImpulse` 默认 `maxExternal = Infinity` → 默认就是纯累加，JSDoc 承诺落空

- **位置**：`CharacterMover.ts:224`（默认参数）、`:231`（`if (mag > maxExternal)`）
- **现象**：默认上限是 Infinity，判断恒 false → 外力只累加、从不限幅。
- **证据**：连续 3 次 `addImpulse(10, 0)` → `externalSpeed = **30**`（`b1_v2` [5]）。
- **后果**：JSDoc `:214`~`:222` 明确写"选的是按强度取较大者，不是简单相加：相加会让玩家被弹飞……实现里做的是向量合成后限制总强度"。默认参数让这条承诺**完全不成立**——多段击退（连击、多重爆炸）会把玩家加速到离谱速度并穿墙。这个"注释说是设计、实际是 bug"的形态，正是任务书第 2 节点名要抓的第二例之后的第三例。
- **建议**：默认改成有限值（如 `maxSpeed * 2`），并在 JSDoc 里写清默认值。

### P1 · [mover] `moveBy` 没有 `safeDt` 守卫，而 `update` 有

- **位置**：`CharacterMover.ts:491`（vs `update` 的 `:311`）
- **现象**：同一类公开 API 两套标准。`moveBy` 是给 `DashController` 冲刺配合用的公开 API。
- **证据**：`moveBy(5, 0, NaN)` 后位置 = `(NaN, NaN)`（`b1_v2` [5]）。
- **后果**：角色坐标永久变 NaN 且不可恢复，之后碰撞、渲染、寻路全崩。
- **建议**：`moveBy` 入口加 `safeDt`。

### P1 · [mover] `externalDamping` / `turnBoost` 未收口 → 速度/坐标永久变 NaN

- **位置**：`CharacterMover.ts:192`~`:200`（只有 `maxSpeed/accel/decel` 有 `!(x > 0)` 校验，其余全用 `?? 默认值`）
- **证据**：`externalDamping = NaN` → 一次 `update` 后 `externalSpeed = NaN`、`x = NaN`；`turnBoost = NaN` → 转向后 `vx = NaN, vy = NaN`。对照组默认配置下分别为 `8.7517` 和 `-2.0000`（`b1_v4` [32]）。
- **后果**：配表字段缺失即触发，同样是"坐标永久 NaN"级别的静默故障。
- **建议**：全部改 `numOr` 收口。

### P1 · [pathfind] `heuristicWeight` 未收口 → 静默返回非最优路径

- **位置**：`PathFinder.ts:163`（`heuristicWeight: opts.heuristicWeight ?? 1`）、`:250`（`const hw = this._opts.heuristicWeight`，参与 `f = tentative + h * hw`）
- **现象**：NaN 让所有 `f` 变成 NaN → 二叉堆比较器 `a.f - b.f` 全 NaN → **堆序失效**。
- **证据**：40×40 空地图 `(0,0) → (39,39)`：默认配置 `found = true`、路径长度 **39**、探索 40 节点；`heuristicWeight = NaN` → `found = true` 但路径长度 **77**（腰折路径，非最优）、探索 79 节点（`b1_v3` [26]）。
- **后果**：单位走明显的绕路（之字形），玩家觉得"AI 很蠢"。不报错、路径合法，所以没人会怀疑 A* 本身。
- **建议**：`numOr(opts.heuristicWeight ?? 1, 1)`。

### P1 · [pathfind] `maxNodes` 未收口 → 防卡死上限完全失效

- **位置**：`PathFinder.ts:164`（`maxNodes: opts.maxNodes ?? 100000`）、`:278`（`if (explored > this._opts.maxNodes) break;`）
- **现象**：NaN 时 `explored > NaN` 恒 false → 上限不生效。
- **证据**：40×40 中间一整列墙（不可达）：`maxNodes = 50` → 探索 **51** 节点即停；`maxNodes = NaN` → 探索 **800** 节点（搜完整张可达区域）（`b1_v3` [26]）。
- **后果**：这个字段存在的唯一目的就是"防止大地图/不可达时卡死"。配表漏填即失效——大地图上一次不可达查询要搜完整张图，帧率断崖，且越是"目标不可达"这种高频场景越容易触发。
- **建议**：`clampNum(opts.maxNodes ?? 默认值, 1, 大上界)`。

### P1 · [rarity] `order` 只查重复、不查有限性，一个 NaN 让全档位排序失效

- **位置**：`Rarity.ts:97`~`:116`
- **现象**：构造函数校验了 `weight`（`!(d.weight > 0)`），但 `order` 只做重复检测。比较器返回 NaN → 排序结果由引擎实现决定（实测保持原序）→ `highest` / `lowest` / `compare` / `best` 全错。
- **证据**：三条定义 order 分别为 1 / NaN / 3 → `highest.id` 返回 **`a`**（应为 `c`），`all` 顺序为 `a,b,c`（未排序）（`b1_v2` [12]）。
- **后果**：保底系统按 `highest` 判定"给不给最稀有档"，排序错 → 保底给错档位；掉落权重表按 order 排序展示，UI 顺序错乱。文件头 `:30` 自称"排序稳定"，实际在脏数据下完全不稳定，且不报错。
- **建议**：`order` 加 `Number.isFinite` 校验（与 `weight` 同一标准）。

### P1 · [rebind] `importState` 的坏数据会让**整批导入**中断，与 JSDoc 承诺相反

- **位置**：`Rebind.ts:351`~`:366`
- **现象**：JSDoc 承诺"坏数据跳过"，但 `decodeBinding('+')` 返回 `{ key: undefined }`（不抛），随后 `:359` 的 `isReserved(undefined)` 内部 `key.trim()` 抛 `TypeError`，**且该调用不在 try 内**。
- **证据**：`importState({ jump: '+' })` 抛出 `TypeError: Cannot read properties of undefined (reading 'trim')`；`importState({ jump: '+', attack: 'k' })` 抛异常后 `has('attack') = false`——**后续正确的 action 一条都没导入**（`b1_v2` [4]）。
- **后果**：玩家从云存档/配置文件恢复按键设置，只要其中**任意一条**是脏数据（老版本遗留、手改配置、剪贴板粘贴），整个按键设置恢复失败，游戏退回默认键位。用户感知是"云存档没生效"，且没有任何错误提示。
- **建议**：把 `isReserved` 调用移进 try；`decodeBinding` 解析失败时返回 `null` 而非 `{ key: undefined }`。

### P1 · [rebind] 重复 code 导入 → 前一个动作被彻底解绑，且不触发 onChange

- **位置**：`Rebind.ts:361`~`:365`
- **现象**：同一个 code 第二次出现时调 `_removeRaw(owner)` 把前一个 owner **彻底解绑**（不是恢复默认），且不触发 `onChange`。
- **证据**：`importState({ a: 'k', b: 'k' })` 后 `a` 无绑定、`b` 有绑定（`b1_v2` [4]）。
- **后果**：导入一份有重复键的配置后，靠前的动作静默失去绑定；因为不触发 `onChange`，**设置界面仍显示旧键位**，玩家点了没反应，以为键盘坏了。
- **建议**：重复时应保留前者、跳过后者（或按 JSDoc 显式约定），并触发 `onChange`。

### P1 · [rebind] `prettyKey` 原型链污染（与已修 `easing()` 同类的新实例）

- **位置**：`Rebind.ts:166`~`:170`
- **现象**：`if (PRETTY[k]) return PRETTY[k]`，`PRETTY` 是对象字面量，未用 `hasOwnProperty` 收口。
- **证据**：`prettyKey('constructor')` 返回类型为 **`function`**，值为 `function Object() { [native code] }`（`b1_v2` [4]）。
- **后果**：键名来自外部输入（导入配置、宏录制）时，UI 上会显示一段函数源码而非键名；若宿主把返回值当字符串做 `toUpperCase()` 等操作则直接抛错。**这是第 2 节点名要求排查的同类风险的新实例。**
- **建议**：改用 `Object.prototype.hasOwnProperty.call(PRETTY, k)`，或 `Object.create(null)`。

### P1 · [replay] 默认 `seed = 0` → 种子校验被完全跳过，JSDoc 承诺落空

- **位置**：`ReplayRecorder.ts:105`（`seed: opts.seed ?? 0`）、`:221`（`if (this._seed !== 0 && data.seed !== this._seed)`）
- **现象**：默认 seed 就是 0，而校验逻辑用 `_seed !== 0` 作为"是否启用校验"的开关 → **默认配置下种子校验永不执行**。
- **证据**：不传 seed（默认 0）时，`load({ ...data, seed: 999999 })` **不报错**；传 `seed = 1` 时正确抛出 `[Replay] 种子不匹配：数据是 999999...`（`b1_v2` [14]）。
- **后果**：JSDoc `:211`~`:214` 明确写"版本和种子不匹配要明确报错……否则回放能播但结果不一样"。默认配置下这条承诺落空——回放能播、但结果和录制时完全不同（因为随机种子不同），表现为"回放里那个人操作一样但结果不一样"，是录像/复盘/反作弊场景下最致命的一类错误，且极难定位。
- **建议**：用 `opts.seed ?? null` 表示"不校验"，或提供显式的 `verifySeed: boolean` 配置。

### P1 · [replay] `playback` 的关键帧指针只前进不回退 → 倒带取帧静默返回空输入

- **位置**：`ReplayRecorder.ts:245`~`:264`
- **现象**：先 `playback(1000)` 再 `playback(500)` 时，`while` 条件不满足、`_keyIndex` 停在后面，接着 `:261` 的 `keyframes[_keyIndex].frame > frame` 成立 → **返回空输入**，而不是历史上正确的那一帧输入。
- **证据**：`playback(100)` 返回 `{"jump":true}`，随后 `playback(50)` 返回 `{}`（期望沿用第 0 帧的 `{"jump":false}`）（`b1_v2` [14]）。`seek()` 会重置 `_keyIndex = 0`，所以只有"直接倒着 playback"才中招。
- **后果**：拖时间轴、倒带、跳章回顾、任何乱序取帧，都会让角色在回放中"突然失去所有输入"（表现为站住不动或被系统判 AFK）。不报错。
- **建议**：`playback` 检测到 `frame < 当前 keyframe` 时回退 `_keyIndex`（或用二分查找定位，彻底去掉顺序依赖）。

### P1 · [scenerouter] 时间单位与全库不一致：配置与 `tick` 都是毫秒，其余单元 `dt` 都是秒

- **位置**：`SceneRouter.ts:71`/`:75`（`outMs` / `inMs`，JSDoc 写明"毫秒"）、`:127`~`:129`（默认 300）、`:217`（`tick(dt)`，JSDoc 未写单位）；README `:23` 把参数命名为 `dtMs`
- **现象**：本单元内部自洽（配置 ms、tick 收 ms、README 叫 dtMs），但**参数名仍是 `dt`**，而全库其余 23 个单元的 `dt` 都是秒。
- **证据**：`outMs = 300`，按**秒**传 `dt = 1/60` → 离开 out 阶段用了 18000 帧 = **300.0 秒**（期望 0.3 秒）；按**毫秒**传 `dt = 16.67` → 18 帧 = **0.30 秒**（`b1_v2` [1]）。
- **后果**：宿主按全库惯例传秒，转场慢 1000 倍——表现为"点了开始，黑屏卡住五分钟"。而因为 JSDoc 没写单位、参数名叫 `dt`，不看 README 示例（`dtMs`）根本发现不了。这是"同名不同义"的典型。
- **建议**：参数改名为 `tick(dtMs)`，并在 JSDoc 首行写明"单位是毫秒，与其他单元的秒制 dt 不同"；或整体改成秒制 `outSeconds`，与全库统一（我倾向后者，但改动面大，请总审裁决）。


## 【P2】P1 完成后再做

### P2 · [adapters] （见正文）

- `nearestCasterHits` `:191` 的 `n = NaN` → `n <= 0` false、`Math.min(NaN, len)` = NaN → 循环不执行，返回空数组。实测返回 **0** 个，对照组 `n=1` 返回 1 个（`b1_v3` [22]）。后果：技能静默打不中任何目标。
- `toCasterHits` 的 `opts.out` 复用数组，JSDoc 未说明"下次调用会清空上次返回的同一数组"。
- `flattenDrops` 的 `walk` 递归无深度限制，children 自引用会爆栈。

### P2 · [analytics] （见正文）

- `assign()` `:170` 的 `treatmentPercent ?? 50` 未校验有限性/范围（构造函数 `:410`~`:417` 校验了，但 `assign` 是公开导出函数）→ NaN 时 `bucket < NaN` 恒 false，全落 control 且静默。
- `twoProportionZTest` `:318` 用 `clamp(p, 0, 1)` 而非 `clampNum` → `p` 为 NaN 时 `Math.max(0, NaN) = NaN`，`significant` 恒 false 且静默。
- `recordValue` / `requiredSampleSize` 未校验 `value` 有限性；`Experiment` 无 `destroy()`。

### P2 · [dungeon] （见正文）

- **平行实现**：`:110`~`:117` 本地又定义了一份 `rectsOverlap(a, b, padding)`（用 `<`，相切不算相交），与 `ds.rectsOverlap`、`_core.rectOverlaps`（`<=`）形成**三份实现、两套语义**。
- **热路径分配**：`MazeDungeon.generate` `:1109`~`:1114` 每个格子都 `this._rng.shuffle([4 个对象字面量])`——512² 迷宫约 26 万次数组+对象分配。
- `randomFloor` `:383`~`:391` 每次 O(n) 全扫并重建 `floors` 数组（刷怪循环调用 → O(n²)）；`roomDistance` `:353`~`:358` 每次调用一次 BFS。
- `floorCount` 只数 `Floor`，而 `isFullyConnected` 数 `Floor + Door`，两个口径不一致（且 `Door` 实际从未被写入，是死类型）。
- `CellularDungeon._smoothBuf` 挂在实例上：同一实例并发/重入 `generateSteps` 会互相踩；异常退出时不清空（w×h 内存驻留）。
- `RoomDungeon` `:635`~`:638` 未校验 `maxRoomSize < width`，`int(1, w-w-2)` 在 max<min 时返回 min → 房间被 `setTile` 静默截断，但 `room.w` 仍记录原值 → `rectCenter` 算到地图外。

### P2 · [feedback] （见正文）

- `FeedbackOutput.popup` 的 JSDoc `:89` 写"进度 0~1（1=刚触发，0=结束）"，但实测在整个 duration 内**恒定不变**：40 帧采样恒为 `1.00`，`intensity = 0.5` 时恒为 `0.50`（`b1_v5` [44]）。它是**强度**不是进度，宿主若按进度做淡出，会看到飘字永不淡出、结束瞬间突降为 0。
- `maxIntensity` 用 `?? 1.5` 未收口：NaN → `eff = NaN` → `clamp01` 归 0 → 震屏/闪白静默失效。实测 `shake = NaN, flash = NaN`，对照组 `0.4 / 0.6`（`b1_v4` [35]）。
- 无 `destroy()`；`output` getter 每帧 new 对象。

### P2 · [fov] （见正文）

- `Raycasting` 构造函数缺尺寸校验（`Shadowcasting` 在 `:182` 有 `throw`），两个实现标准不一致。
- `compute` 每次 `toArray()` 导出全图（O(w·h) + 分配）；`Raycasting.compute` 的 perimeter 每次新建数组与对象（`:466`~`:473`）。

### P2 · [mmr] （见正文）

- `suggestedWindow` `:404` 的 `clamp(baseWindow * u, baseWindow, baseWindow * 3)` 在 `baseWindow < 0` 时 min > max，`clamp` 会返回 max（语义错误）。
- `fillFromPool` `:341`~`:351` 对 pool 每个候选都跑一次 `validateParty + teamMmr`（O(pool × party)）；`resolve(cfg)` 每次调用都重建配置对象。

### P2 · [mover] （见正文）

- `addImpulse` `:240`~`:241` 用**单次冲量**的 `mag2` 而非合成后的总外力判断 `knocked` → 多个小击退合成很大时 `knocked` 仍为 false，玩家在明显被推开时仍有完全控制权。
- `knockbackThreshold` 用 `<= 0` 判断是否"未指定"，显式传 0 会被静默改写成 `maxSpeed * 0.25`；`stoppingTime` 硬编码 1e6 上界；无 `destroy()`。

### P2 · [pathfind] （见正文）

- `_openMark` `:183` 在 `:259` / `:322` 被写入，全文件从未读取（stamp 机制取代了它）——死代码。
- `FlowField.destroy` `:619`~`:623` 把 `_dist/_dirs` 换成长度 0 的数组，之后 `distanceAt` 返回 `undefined` 而非 JSDoc `:570` 承诺的 `-1`（`reachable` 仍能正确返回 false，但类型契约破了）。
- `PathSmoother.hasLineOfSight` `:378`~`:403` 是 `for(;;)` 且只靠 `_walkable` 拦越界；调用方传入不检查越界的 `walkable`（常见写法 `(x,y) => grid[y][x] === 0`）会越界 `TypeError`。
- `FlowField.build` 每次 `new Uint8Array(n)`，而 `_dist/_dirs` 复用，两处不一致。

### P2 · [rarity] （见正文）

- `tally` `:252`~`:259` 用 `{}` 字面量累加。实测稀有度 id 为 `__proto__` 时，其计数**整条丢失**：`tally(['__proto__','__proto__','b'])` 返回 `{"b":1}`（`b1_v4` [33]）。`get('__proto__')` 仍可取到定义，属于"部分可用、计数丢失"的半失效状态。

### P2 · [rebind] （见正文）

- `resetToDefault` `:308`~`:324` 对"当前有绑定但没有默认值"的动作静默丢弃（先 clear 再只填有 default 的）。
- 缺 `destroy()`（rule5）；`_removeRaw` 里 `:393`/`:394` 重复调用了 `encodeBinding`。

### P2 · [replay] （见正文）

- `maxFrames` 实际限制的是**关键帧数**不是帧数。证据：录 20 个关键帧、`maxFrames = 5` → 实际保留 **5** 个关键帧（`b1_v5` [45]）。与字段名和 JSDoc `:70`"最大帧数上限"不符（好在内存只由 keyframes 决定，保护仍有效）。
- `playback` 返回 keyframes 内部 input 的**引用**：两次 `playback(0)` 返回**同一个对象**（`b1_v4` [40]），调用方修改会污染回放数据（`record`/`export` 都做了拷贝，唯独这里没有）。且返回共享的 `EMPTY_INPUT` 常量，风险更大。
- `loadJSON` 的 `JSON.parse` 无 try/catch。

### P2 · [scenerouter] （见正文）

- 无 `destroy()`；`load` 阶段的进度需要宿主自己推进，`skipPhase()` 后 `progress = 0`，JSDoc 未说明宿主该如何驱动加载进度。

---


---

## 4. 贯穿全库的六个共享模式

这些模式在多个单元重复出现。**按模式统一修法，不要每个单元各写一套。**

### 模式 A · 否定式条件拦不住 NaN（最高频）

```ts
// ✗ 错：NaN 参与 <= 比较恒为 false，直接穿透
if (x <= 0) return;
if (amount >= s.count) return -1;

// ✓ 对：肯定式，NaN 时条件成立 → 正确拒绝
if (!(x > 0)) return;
if (!(amount < s.count)) return -1;
```

**本批最高频的错误形态。** JS 里 NaN 与任何值比较都为 false，否定式判断天然漏掉它。

### 模式 B · `??` 和 `Math.max` 都挡不住 NaN

```ts
// ✗ 错：?? 只挡 null/undefined；Math.max(0, NaN) === NaN
this._maxRetries = opts.maxRetries ?? 3;

// ✓ 对
this._maxRetries = clampNum(opts.maxRetries, 0, 100, 3);
numOr(v, 0)
```

### 模式 C · `importState` 绕过校验与事件

多个单元的存档导入直接写内部字段，**既不做数值校验、也不触发 `onChange`**，
导致"读档后状态对了但 UI 没更新"和"坏存档能写进任何值"。
涉及 `blessing` / `curse` / `settings` / `achievement` / `quest` / `leaderboard` / `buff`。

统一修法：导入走与 `set()` 相同的校验路径，并触发一次变更通知。

### 模式 D · `set` 类效果被层数/等级错误缩放

`blessing` / `curse` / `meta` 三个单元都有：`set`（覆盖）语义的效果被乘上层数/等级，与 `add`/`mul` 混为一谈。

### 模式 E · 遍历中修改集合

```ts
// ✗ 错：回调里注销自己会 splice 数组，下一个回调被跳过
for (const fn of this._onSpawn) fn();

// ✓ 对：遍历副本
for (const fn of [...this._onSpawn]) fn();
```

### 模式 F · 缺省配置与 JSDoc 承诺相反

`mover` 的 `maxExternal = Infinity`、`replay` 的 `seed = 0`、`telemetry` 的 `maxRetries` 等——
**默认值恰好让文档承诺的功能失效**。改法二选一：改默认值，或改文档说清真实语义。
**不要只改一个又不动另一个。**

---

## 5. 交付要求

### 5.1 每条修复的产出

1. **源码改动**：只改必要的那几行，附"为什么"注释
2. **回归测试**：一条在修复前**确实会失败**的用例
3. **对照用例**：一条验证"正常输入不受影响"的用例（防止矫枉过正）

### 5.2 测试放哪

新建 `tests/run_phase10_w2.ts`，并**在文件内导出** `runPhase10W2Tests()`：

```ts
export function runPhase10W2Tests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（8 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W2.md`，每条一行：

```
| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
```

状态用：`已修` / `已修（附说明）` / `不成立（附证据）` / `需总审裁决`。

**"不成立"要有真凭实据**——贴出复现脚本和输出，说明为什么报告描述的现象不存在。
不要因为"看代码觉得没问题"就判不成立。

### 5.4 提交前自检

```bash
bash build.sh
node .build/tests/run.js                    # 必须全绿，条数只增不减
node scripts/check-deps.js                  # 全部通过（记得删 verify/）
node scripts/check-links.js
python3 scripts/scan-dt-guard.py
python3 scripts/scan-num-guard.py
python3 scripts/check-random-source.py
python3 scripts/check-dup-exports.py
```

---

## 6. 并行纪律（8 个窗口同时开工）

| 事项 | 约定 |
|---|---|
| **单元边界** | 8 个窗口**零重叠**，已核验 |
| **`_core/`** | 谁都不要碰 |
| **`tests/run.ts`** | **总审统一合并**，你不要改 |
| **`README.md`** | 测试总数在变，**不要改**，总审统一更新 |
| **临时脚本** | 放 `/tmp` 或 `verify/`（用完删） |
| **`build.sh`** | 会整体替换 `.build/`；偶发 502 导致中断时**重跑一次**即可 |
| **文件命名** | `run_phase10_w2.ts` / `result_W2.md`，带你的窗口号，避免撞名 |

---

## 7. 需要总审裁决的先记下来

遇到以下情况**不要自己拍板**，在报告里标"需总审裁决"并说明两种选择的利弊：

1. 修复会改变**对外 API 行为**（可能 breaking）
2. 报告建议的改法与单元 README 的**明确声明冲突**
3. 两处代码"看起来不一致但可能都是故意的"
   （例：相切语义——空间索引要求"不含相切"，通用 AABB 要求"含相切"，**两者都对**）
4. 你判断某条"不成立"

---

## 8. 最后一句

这个库现在 **3695 项测试全绿**，是你开工前的基线。
你交付时这个数字只能涨、不能跌——如果跌了，说明你的修复伤到了既有行为，
回去看第 1.1 节第 1 条。
