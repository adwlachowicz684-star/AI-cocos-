# 精审返工任务书 · 窗口 C

> 本文件是**第二次精审 273 条**中，分配给窗口 C 的剩余条目。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、3695 项测试全绿、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

---

## 0. 一句话任务

按下面第 3 节的清单，逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

---

## 1. 角色与纪律

你是**执行者**，不是审查者。拿到清单 → 复现 → 修 → 写测试 → 自检。

### 1.1 三条硬纪律

1. **不要顺手重构。** 只改清单里指出的那一行/那一处。
   这个库大量"看起来别扭"的写法都带长注释解释原因；
   你在某个单元里"顺手优化"的代码，很可能是另一个单元赖以正确工作的前提。
   我自己就在 `prewarm` 上犯过这个错——顺手把预热数夹到 `maxSize` 以内，
   结果既有测试立刻变红，因为那两个是**独立的契约**。

2. **改之前必须先复现。** 写个最小脚本跑出"修复前"的现象，
   把真实输出贴进你的报告。没有复现就不要改——
   报告里的"证据"是别的窗口写的，你要自己验证一遍。

3. **注释要写"为什么"，不是"改了什么"。**
   重点写：这个坑的表现是什么、为什么原写法会中招、为什么新写法是对的。
   这个库最大的价值就是这些注释——很多坑会换个地方重新长出来，
   注释是唯一能拦住下一个人的东西。

### 1.2 一个反直觉但很重要的口径

**注释/文档如果主动论证"这是设计如此"，你要格外警惕，而不是格外放心。**

这个项目里已经出现过多次：代码有坑，而旁边的注释写了一段看似合理的论证说明它没问题。
真实案例：

- `perception` 的抖动注释写"只影响观感，不需要可复现"——实测抖动值直接喂进了 `alert` 累积，**注释的前提是假的**。
- `_core` 的 `smoothDamp` 曾把失效的 maxSpeed 记成"Unity 标准行为，非 bug"，还附了实测数据和权威叙事——**数据为真、归因为假**。
- README 曾把已修的缺陷记成"设计如此"，导致后来的人看到文档就不去修了。

所以：**文档说"没问题"不等于真没问题。** 按证据判断，不按注释判断。

---

## 2. 代码库速览

### 2.1 位置与基本命令

```bash
cd /data/workspace/AI-cocos--main
bash build.sh                    # 编译到 .build/（不要跳过）
node .build/tests/run.js         # 全量回归
```

`build.sh` 有产物自愈与**逐文件比对**（不是只比总数——总数校验抓不到"tests 少 23 个"的情况）。

### 2.2 七条铁律（违反会导致构建/校验失败）

| 铁律 | 内容 |
|---|---|
| 1 | **无引擎依赖**：不得 `import 'cc'`，只能用注入的适配器。唯一例外是 `adapters/CocosAdapter.ts` |
| 2 | **不 import 引擎类型**：连 `import type { Node } from 'cc'` 也不行 |
| 3 | **运行时依赖 0**：不得 import 任何第三方包 |
| 4 | **配置驱动**：数值不得硬编码，要可配 |
| 5 | **可卸载**：有 `install` 必须有对应的 `uninstall`/`destroy` |
| 6 | **禁止横向 import**：单元之间不得互相 import（`_core` 例外） |
| 7 | **复制即可用**：使用者拷走目录后改 0 行 |

### 2.3 现成的共享工具（`_core/`，**直接用，不要自己造**）

| 工具 | 用途 |
|---|---|
| `clampNum(v, lo, hi, def)` | 数值收口，**NaN 会回落到 def** |
| `numOr(v, def)` | 非有限值回落 |
| `safeDt(dt)` | dt 守卫（挡 NaN / 负数 / 过大） |
| `needCount(n, max?)` | 无界 count 守卫（挡 Infinity / NaN） |
| `hasOwn(obj, k)` | 原型链安全的 `in` |
| `assertSafePath(p)` | 路径写入的原型污染防护 |
| `MathRandomSource` | 唯一允许的随机源 |

**`_core/` 不在你的清单里，严禁修改它。** 它被 55 个单元依赖，你改一行会同时影响另外两个窗口。

### 2.4 六个校验脚本（提交前全部要过）

```bash
node scripts/check-deps.js        # 依赖分层
node scripts/check-links.js       # 内部链接
python3 scripts/scan-dt-guard.py  # dt 守卫
python3 scripts/scan-num-guard.py # 数值收口
python3 scripts/check-random-source.py  # 随机源
python3 scripts/check-dup-exports.py    # 重复导出
```

⚠️ **临时验证脚本放在 `verify/` 下会导致 `check-deps.js` 报错**（该目录没有登记分层）。
用完请删除 `verify/`，或改放 `/tmp` 下。

---

## 3. 本批清单（68 条：P1 {n_p1} / P2 {n_p2}）

覆盖批次：batch1。涉及 24 个单元。
**本批单元与其它两个窗口完全不重叠**（已核验：无单元跨批次）。

### 单元清单

```
adapters  analytics  behavior-tree  bullet-pattern  dash  dungeon  entity  feedback  fov  fsm  grid  i18n  mmr  mover  number-roller  objective  pathfind  progressbar  rarity  rebind  replay  scenerouter  steering  telemetry
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

### P1 · [behavior-tree] `Wait` / `CooldownDecorator` 的秒数未收口：一个 NaN 让 AI 永久卡死或让冷却彻底失效

- **位置**：`BTNode.ts:365`（`_elapsed >= _seconds`）、`:285`（`_remain = _seconds`）、`:278`（`_remain > 0`）
- **现象**：`_seconds` 为 NaN 时，`_elapsed >= NaN` 恒 false → `Wait` 永远返回 `Running`；`_remain = NaN` 后 `NaN > 0` 恒 false → 冷却永不生效。两者都没用 `numOr` 收口，而 `_seconds` 通常来自配表。
- **证据**：600 帧内 `Wait(0.1s)` 返回 Success **85** 次，而 `Wait(NaN)` 返回 Success **0** 次（状态始终为 `Running`）（`b1_v4` [36]）。`CooldownDecorator(NaN)` 在 10 帧内让子节点执行 **10** 次，对照组 `_seconds = 1` 只执行 **1** 次（`b1_v3` [23]）。
- **后果**：配表里漏填/填错一个等待时长（`null` / `''` / NaN），对应 AI 分支**永久停在 Running**，整棵树的后续节点再也不执行——怪物站着不动、Boss 不放技能，且不报错、不看日志完全定位不到。冷却失效则表现为技能每帧释放。
- **建议**：两个构造函数里用 `numOr(_seconds, 默认值)` 收口，或在 tick 入口对 `_seconds` 做一次有限性检查后降级。

### P1 · [bullet-pattern] 用自定义 `ShapeFn` 时，所有子弹速度恒为 0

- **位置**：`BulletPattern.ts:461` `const speed = spec ? speedAt(spec, i) : 0;`（`:459` 处 `spec` 在函数形态下被置为 `null`）
- **现象**：`shape` 传函数时 `spec` 为 null，速度直接取 0，而 `BulletSpawn.speed` 是 README `:36` 明列的产出字段。且没有 `setSpeed` 之类的补救 API。
- **证据**：`shape: () => [0,1,2]` 的发射器产出 3 颗，`speed = [0, 0, 0]`；对照组 `Shapes.ring(3, 10, 'b')` 产出 3 颗，`speed = [10, 10, 10]`（`b1_v3` [18]）。
- **后果**：Boss 弹幕一旦用自定义形状（这是弹幕玩法的核心扩展点），打出的子弹全部**原地不动**堆在发射点。视觉上是"贴脸一团静止的弹幕"，玩家不会觉得是 bug 而是"这 Boss 有问题"，开发查碰撞/渲染都查不到源头。
- **建议**：`EmitterOptions` 增加可选 `speed` 字段，`_fire` 里 `const speed = spec ? speedAt(spec, i) : (opts.speed ?? 0)`，并同步更新 README。

### P1 · [bullet-pattern] `interval` 的 `<= 0` 校验挡不住 NaN → 发射器永远不开火

- **位置**：`BulletPattern.ts:283`~`:284`
- **现象**：`if (opts.interval <= 0) throw`，NaN 比较恒 false → 校验通过；tick 里 `while (e.time >= NaN)` 恒 false → 永不开火。
- **证据**：`interval = NaN` **通过构造校验**，之后跑 600 帧共产出 **0** 颗（`b1_v2` [7]）。与 `:282` 注释"配置错误现在就报，别等到 Boss 战打一半"直接矛盾。同理 `shots < 0` 挡不住 NaN → 有限次退化成无限。
- **后果**：配表漏填 interval 时发射器静默罢工，Boss 战打一半突然不弹幕了。
- **建议**：改用 `!(opts.interval > 0)` 守卫（能同时挡 NaN / 0 / 负 / 非数字）。

### P1 · [bullet-pattern] `compileShape` 的 `count` 未收口：NaN 变 0 发，null 变 1 发

- **位置**：`BulletPattern.ts:117` `Math.max(1, spec.count)`
- **现象**：`Math.max(1, NaN) = NaN` → 循环不执行 → 0 颗；`Math.max(1, null) = 1` → 静默变单发。
- **证据**：`count = NaN` → 产出 **0** 个角度；`count = null` → 产出 **1** 颗（`b1_v2` [7]）。
- **后果**：配表 count 字段缺失时，弹幕从"环形 8 发"静默变成"1 发"或"0 发"，数值同学看配置是对的，实际手感完全变了。
- **建议**：`numOr(spec.count, 1)` 后再 `Math.max(1, ...)`。

### P1 · [dash] 多层充能永远回不满：只有充能耗尽到最后一层才启动冷却

- **位置**：`DashController.ts:285`~`:286` `if (this._charges <= 0 && this._cdLeft <= 0) this._cdLeft = this._cooldown;`
- **现象**：`charges = 2` 时用掉第 1 层（剩 1）不设 CD → tick `:343` 的 `if (_cdLeft > 0)` 永不执行 → 第二层充能**永远无法恢复**。
- **证据**：`charges = 2`，用掉 1 层后 `chargesLeft = 1`；等 **5 秒**（远超 cooldown 0.5s）后 `chargesLeft` 仍为 **1**（期望回到 2）（`b1_v2` [3]）。
- **后果**：JSDoc `:86` 明确写"充能层数（哈迪斯可以连续冲两次）"。实际表现是：连冲两次后，之后每次只能用一层、且这一层要靠"耗尽后的 CD"恢复——双冲刺退化成单冲刺。手感差异玩家能察觉但说不清，数值同学看配置 `charges: 2` 是对的。
- **建议**：每消耗一层就启动/续上冷却：`this._charges--; if (this._cdLeft <= 0) this._cdLeft = this._cooldown;`

### P1 · [dash] `duration` / `distance` 未收口 → 一个 NaN 让角色坐标永久变 NaN

- **位置**：`DashController.ts:169`~`:170`（`?? 4` / `?? 0.22`）、`:379`（`clamp(_t / _duration, 0, 1)`）
- **现象**：`_duration = NaN` 时 `clamp(0 / NaN)` = NaN → `d0/d1` 为 NaN → `deltaX/deltaY` 为 NaN，直接写进角色位移。
- **证据**：`duration = NaN` → 1 帧后 `deltaX = NaN, deltaY = NaN`；`distance = NaN` → 同样 `NaN`（`b1_v3` [19]）。
- **后果**：配表里 duration/distance 填错一次，角色坐标永久变 NaN，之后所有碰撞、渲染、寻路全部失效且不可恢复（NaN 会传染），表现为"角色突然消失、游戏半瘫"。这是任务书 A 类点名的"一个 NaN 帧让坐标永久变 NaN"的实锤。
- **建议**：两个字段用 `numOr` 收口，或对 `duration` 用 `!(x > 0)` 守卫（该单元在别处已有这类守卫，此处漏了）。

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

### P1 · [entity] 回调里注销自己 → 下一个回调被静默跳过

- **位置**：`EntityRegistry.ts:228`（`onSpawn` 派发）、`:349`（`onDeath`）、`:383`、`:422`；注销实现 `:489`~`:505`
- **现象**：派发用 `for (const fn of this._onSpawn)` 直接遍历实时数组，回调内部调用自己返回的取消函数会 `splice` 数组，下标前移一位，**紧跟其后的那个回调被整个跳过**。
- **证据**：注册 A/B/C 三个 `onSpawn`，A 内部注销自己 → 实测触发序列 `[A,C]`，**B 从未执行**（`b1_v4` [31]）。换用 `onDeath` 复测：回调1 触发 1 次、回调2 触发 **0 次**（`b1_v2` [11]）。
- **后果**："一次性监听"（触发即注销）是回调最常见的写法。只要它不是最后一个注册的，它后面所有监听者在本次事件里全部静默失效——掉落、计分、成就、死亡动画漏触发，且不报错、不复现规律（取决于注册顺序），是最难查的一类。
- **建议**：派发前 `const list = this._onSpawn.slice()`，遍历副本；或倒序 `for (let i = list.length - 1; i >= 0; i--)`。
- **影响面**：所有 `on*()` 返回的取消函数都受影响；下游 `objective` / `achievement` 若用一次性监听会漏事件。

### P1 · [entity] `destroy(id)` 对无效 id 有两种相反返回值

- **位置**：`EntityRegistry.ts:361`~`:368`
- **现象**：非遍历中走 `_destroyNow` 返回 `false`；遍历中（`_iterating > 0`）走"延迟销毁"分支，对**已不存在的 id 也返回 `true`**。
- **证据**：同一个无效 id `999999`：非遍历中 `destroy()` 返回 `false`，`forEach` 内部调用返回 `true`（`b1_v2` [11]）。
- **后果**：调用方常用 `if (reg.destroy(id))` 判断"实体确实被销毁了"来做资源释放/计数，在遍历上下文里会得到假阳性，导致重复释放或统计偏大。
- **建议**：延迟分支先 `isValid` 再入队，不入队时返回 `false`。

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

### P1 · [grid] NaN 坐标能"放置成功"但成为幽灵建筑，且 `freeCount` 不减

- **位置**：`Grid.ts:308`~`:322`（`canPlace`）、`:341`~`:345`（`place`）
- **现象**：边界检查 `x < 0 || y < 0 || x + w > W || y + h > H` 对 NaN 全为 false → `canPlace` 返回 **true**。`place` 把 id 写进 `this._cells[NaN]`——这是数组的 `"NaN"` 字符串属性，**不进入 `length`**。
- **证据**：`canPlace('h', NaN, 3)` = **true**；`place` 返回 `h#1`；`at(NaN,3)` 能查到 `h#1`；但**按坐标全图扫描 10×10 看到的占用格数 = 0**；`freeCount = 100`（对照组正常放置 2×2 后 = **96**）；同位置第二次 `place` 返回 `null`（`b1_v2` [6]、`b1_v4` [37]）。
- **后果**：坐标来自 UI 拖拽 / 网络包 / 存档反序列化时一旦出现 NaN，建筑"放置成功"扣了费、占了 `placedCount`，但渲染层遍历 `length` 永远画不出它，玩家看到"钱扣了地是空的"；`freeCount` 不减还会让"剩余空间"UI 偏大。不报错、不崩溃。
- **建议**：`canPlace` 改用 `Number.isFinite(x) && Number.isFinite(y)` 前置校验，并把 `x >= 0` 类判断统一换成"取反"式守卫。
- **影响面**：`adapters.toFlatGrid` / 建造类玩法 / 存档校验链路。

### P1 · [grid] README 与源码 JSDoc 的 `find` 示例签名是错的

- **位置**：源码 `Grid.ts:183` 签名 `find(predicate: (value: T, x, y) => boolean)`；README `:14` 与源码 JSDoc `:34` 都写 `g.find((c) => c.value === '树')`
- **现象**：回调第一个参数是**值本身**，不是 cell 对象。文档示例里的 `c.value` 恒为 `undefined`。
- **证据**：源码 `:183`~`:191` 实现为 `predicate(v, x, y)`，`v` 直接来自 `_data[i]`；文档示例按 `c.value` 取值（`b1` 源码核对）。
- **后果**：照文档写 → `undefined === '树'` 恒 false → `find` **静默返回空数组**。调用方会以为是"地图里没有树"，去查数据生成逻辑，永远查不到。
- **建议**：文档改为 `g.find((v) => v === '树')`，或让 `find` 真的传 cell 对象（后者破坏性大，建议改文档）。

### P1 · [i18n] `onChange` 只存单个回调，第二个订阅者静默顶掉第一个

- **位置**：`I18N.ts:135`~`:140`
- **现象**：`onChange` 是赋值而非追加，没有返回取消函数，也没有多播容器。
- **证据**：连续注册两个回调后 `setLocale('zh')` → 回调1 触发 **0** 次，回调2 触发 **1** 次（`b1_v5` [43]）。
- **后果**：多个 UI 组件各自订阅"语言变更"来刷新文本（最常见的用法），结果只有最后注册的那个刷新，其余组件停留在旧语言。不报错，玩家看到"一半界面换了语言"。
- **建议**：改成 `Set<callback>` 并返回取消函数。

### P1 · [i18n] `has()` 与 `t()` 判定口径不一致

- **位置**：`I18N.ts:175`~`:177`
- **现象**：`has()` 只查**当前语言**、只查 **key 本身**，既不查 fallback 语言也不查复数变体；而 `t()` 两者都查。
- **证据**：`has('ui.start') = false`，但 `t('ui.start') = '开始'`（来自 fallback）；`has('item') = false`，但 `t('item',{n:3}) = '3 items'`（来自 `item_other`）（`b1_v2` [15]）。
- **后果**：UI 用 `has(key)` 决定"显示翻译 / 显示 key / 走兜底样式"，会得到大量假阴性——明明翻得出来却走了未翻译分支，本地化验收时表现为"翻译明明有却不生效"。
- **建议**：`has()` 复用 `t()` 的查找路径，返回"能否解析出非 key 本身的结果"。

### P1 · [i18n] 覆盖率统计认 6 种复数形式，运行时只认 2 种

- **位置**：`I18N.ts:199`~`:205`（`_hasAnyForm` 认 zero/one/two/few/many/other）vs `:195`（`_pluralKeyOf` 只生成 `_one` / `_other`）
- **现象**：语言包只写 `item_few` / `item_many` 时，覆盖率报告算"已翻译"，但 `t()` 永远命中不到这两个变体。
- **证据**：ru 语言包只写 `item_few`/`item_many` → `coverage('ru')` 报 **translated=1/1（100%）**，但 `t('item',{n:3})` 返回 `'3 个'`（回落中文）（`b1_v2` [15]）。
- **后果**：本地化质量看板全绿，验收通过；上线后俄语等复杂复数语言的复数全部显示错误/回落。这是"报告说谎导致决策错误"的典型。
- **建议**：`_hasAnyForm` 只认 `_pluralKeyOf` 能生成的两个后缀；或补齐 `_pluralKeyOf` 支持 CLDR 六形式。

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

### P1 · [number-roller] `snapTo` 缺有限性校验，一个 NaN 让计数器永久显示 "NaN"

- **位置**：`NumberRollerCore.ts:129`~`:136`
- **现象**：`set()` 在 `:105`~`:107` 对非有限值 `throw`，但 `snapTo()` 没有任何校验，直接写 `_current`。写入后 `_rolling = false`，`update()` 开头直接 `return`，**永远无法自愈**。
- **证据**：`snapTo(NaN)` 后 `display = NaN`、`formatted = 'NaN'`（`b1_v2` [8]）。对照：`set(NaN)` 会 throw `[NumberRollerCore] 目标值必须是有限数`（`b1_v2` [8]）。
- **后果**：金币/伤害数字来自服务端返回或伤害结算，偶尔出现 null/NaN 时，UI 上永久显示 "NaN" 且不再滚动。玩家截图投诉，开发查伤害公式，实际源头是这个入口漏了校验。
- **建议**：`snapTo` 开头加与 `set` 相同的 `Number.isFinite` 校验（抛出或静默忽略需统一口径，建议抛出，与 `set` 一致）。

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

### P1 · [steering] `mass` 未校验 → mass=0 直接产出 Infinity 坐标

- **位置**：`Steering.ts:553` `agent.force.x / agent.mass`；`createAgent` `:115` `mass: opts.mass ?? 1`（只兜 undefined/null）
- **证据**：`mass = 0` 时施加力后 `integrate` → `pos = (Infinity, NaN)`、`vel = (Infinity, NaN)`（`b1_v2` [9]）。
- **后果**：质量来自配置表或" massless 单位"（如子弹、纯运动学体）时填 0 是自然的想法，一旦填 0，单位坐标瞬间变 Infinity/NaN 并传染给所有依赖它的系统（Flock 邻居计算、避障）。扫描命中 23 处"除零风险"的典型一例。
- **建议**：`numOr(opts.mass, 1)` 后再 `Math.max(mass, 1e-6)`。

### P1 · [steering] `wander` 默认走裸 `Math.random`，与 F 类"随机数注入"直接冲突

- **位置**：`Steering.ts:238` 默认参数 `rand: () => number = Math.random`
- **证据**：不注入时连续两次 `wander` 返回不同结果（`{x:98.98, y:1.79}` vs `{x:98.35, y:-11.37}`）；注入固定 `rand` 后两次完全相同（`b1_v3` [29]）。
- **后果**：默认路径不可复现、不可测试——回放、录像、确定性 lockstep、单元测试全部失效。同类问题见 `telemetry.randomId`。这是 F 类明确要求"随机数走 `IRandomSource` 注入"的违反项。
- **建议**：把 `rand` 改为必填参数，或默认改成"未注入时首次调用抛错/告警"（与 `IRandomSource` 的用法对齐）。

### P1 · [telemetry] `maxRetries` 未收口 → 第一次发送失败就永久丢数据，与 JSDoc 矛盾

- **位置**：`Telemetry.ts:141`（`?? 3`）、`:276`（`if (this._retries <= this._maxRetries)`）
- **现象**：`maxRetries` 为 `''` / NaN 时，`_retries <= ''` 中 `''` 被转成 0，`1 <= 0` 恒 false → 第一次失败即丢弃，永不重试。
- **证据**：sender 恒失败、两次 `flush()` 后：`maxRetries = ''` → `buffered = **0**`；对照 `maxRetries = 3` → `buffered = **1**`（`b1_v3` [21]）。JSDoc `:270`~`:271` 明确写"超过上限才丢"。
- **后果**：配置来自远端下发或存档（`''`、null 极常见）时，一次网络抖动就永久丢失整批埋点。埋点缺口表现为"某天数据突然少一截"，无法回溯。
- **建议**：`clampNum(opts.maxRetries ?? 3, 0, 10)`。


## 【P2】P1 完成后再做

### P2 · [adapters] （见正文）

- `nearestCasterHits` `:191` 的 `n = NaN` → `n <= 0` false、`Math.min(NaN, len)` = NaN → 循环不执行，返回空数组。实测返回 **0** 个，对照组 `n=1` 返回 1 个（`b1_v3` [22]）。后果：技能静默打不中任何目标。
- `toCasterHits` 的 `opts.out` 复用数组，JSDoc 未说明"下次调用会清空上次返回的同一数组"。
- `flattenDrops` 的 `walk` 递归无深度限制，children 自引用会爆栈。

### P2 · [analytics] （见正文）

- `assign()` `:170` 的 `treatmentPercent ?? 50` 未校验有限性/范围（构造函数 `:410`~`:417` 校验了，但 `assign` 是公开导出函数）→ NaN 时 `bucket < NaN` 恒 false，全落 control 且静默。
- `twoProportionZTest` `:318` 用 `clamp(p, 0, 1)` 而非 `clampNum` → `p` 为 NaN 时 `Math.max(0, NaN) = NaN`，`significant` 恒 false 且静默。
- `recordValue` / `requiredSampleSize` 未校验 `value` 有限性；`Experiment` 无 `destroy()`。

### P2 · [behavior-tree] （见正文）

- `trackedNodes` 是死功能：`BehaviorTree.ts:80`~`:81` 注释说"每个节点最近一次的状态（调试面板用）"，但内置节点（Selector/Sequence/Condition/Action/Wait）**一个都不调用 `recordNode`**。实测 tick 后 `trackedNodes.size = **0**`（`b1_v3` [23]）。调试面板恒空，JSDoc 措辞暗示自动追踪。
- `Repeater` `:239`~`:253` 把子节点 Failure 转成 Running（只有次数用尽才 Success），JSDoc `:225` 未说明吞掉 Failure；`_times = 0` 仍会执行 1 次；`_times = NaN` 退化成"无限"。
- `Parallel` `:152`~`:165` 每帧 tick 所有子节点，包括已 Success 的（会重复触发动作）。
- `_runningIndex`（Selector `:77` / Sequence `:115`）只写不读，纯装饰；`destroy` 对共享子节点会重复调用。

---

### P2 · [bullet-pattern] （见正文）

- `aimAtTarget = false` 但未给 `fixedAngle` 时仍自动瞄准目标，与 JSDoc `:208`~`:214`"false = 用固定角度"不符。证据：目标在正上方 (0,100)，`angle = 1.5708`（即 π/2，仍在自动瞄准），而非期望的 0（`b1_v3` [18]）。
- `tick` 的 `guard++ < 64` 静默截断（掉帧时丢弹幕）；`SequencePlayer` loop 时 `_time = 0` 丢弃余量造成周期漂移；`BulletPattern` 无 `destroy()`。

### P2 · [dash] （见正文）

- `DashState` 声明 `'idle' | 'dashing' | 'recovery'`（`:123`、状态机图 `:129`~`:133`），但全文件**从未给 `_state` 赋过 `'recovery'`**——死状态。
- `canCancel()` 与 `ready` 实现完全相同（冗余）；`_progressAt` 的 `norm = _progressAt(1) || 1` 在 `falloff = -1` 时 p=0 → norm 兜底为 1 → 位移恒 0。

### P2 · [dungeon] （见正文）

- **平行实现**：`:110`~`:117` 本地又定义了一份 `rectsOverlap(a, b, padding)`（用 `<`，相切不算相交），与 `ds.rectsOverlap`、`_core.rectOverlaps`（`<=`）形成**三份实现、两套语义**。
- **热路径分配**：`MazeDungeon.generate` `:1109`~`:1114` 每个格子都 `this._rng.shuffle([4 个对象字面量])`——512² 迷宫约 26 万次数组+对象分配。
- `randomFloor` `:383`~`:391` 每次 O(n) 全扫并重建 `floors` 数组（刷怪循环调用 → O(n²)）；`roomDistance` `:353`~`:358` 每次调用一次 BFS。
- `floorCount` 只数 `Floor`，而 `isFullyConnected` 数 `Floor + Door`，两个口径不一致（且 `Door` 实际从未被写入，是死类型）。
- `CellularDungeon._smoothBuf` 挂在实例上：同一实例并发/重入 `generateSteps` 会互相踩；异常退出时不清空（w×h 内存驻留）。
- `RoomDungeon` `:635`~`:638` 未校验 `maxRoomSize < width`，`int(1, w-w-2)` 在 max<min 时返回 min → 房间被 `setTile` 静默截断，但 `room.w` 仍记录原值 → `rectCenter` 算到地图外。

### P2 · [entity] （见正文）

- `spawn` 无槽位上限守卫（`:190`~`:199`）：`index = this._slots.length` 无上限，而 `makeId = index + generation * SLOT_CAPACITY`（`:90`）、`idIndex = id % SLOT_CAPACITY`（`:70`）。**推导**：槽位超过 1048576 后 `idIndex === 0` → `isValidId` 恒 false → 实体静默查不到。需 >100 万次 spawn，仅挂机/无尽模式可达。
- 只有 `clear()` 没有无参 `destroy()`（实测 `typeof reg.destroy === 'function'`，但那是 `destroy(id)` 删实体）。rule5 的语义由 `clear()` 覆盖，属于命名不符。
- `query/queryAll/snapshot/forEach` 每次 O(n) 全表扫描并新分配数组（`:306`~`:325`、`:450`、`:472`）。

### P2 · [feedback] （见正文）

- `FeedbackOutput.popup` 的 JSDoc `:89` 写"进度 0~1（1=刚触发，0=结束）"，但实测在整个 duration 内**恒定不变**：40 帧采样恒为 `1.00`，`intensity = 0.5` 时恒为 `0.50`（`b1_v5` [44]）。它是**强度**不是进度，宿主若按进度做淡出，会看到飘字永不淡出、结束瞬间突降为 0。
- `maxIntensity` 用 `?? 1.5` 未收口：NaN → `eff = NaN` → `clamp01` 归 0 → 震屏/闪白静默失效。实测 `shake = NaN, flash = NaN`，对照组 `0.4 / 0.6`（`b1_v4` [35]）。
- 无 `destroy()`；`output` getter 每帧 new 对象。

### P2 · [fov] （见正文）

- `Raycasting` 构造函数缺尺寸校验（`Shadowcasting` 在 `:182` 有 `throw`），两个实现标准不一致。
- `compute` 每次 `toArray()` 导出全图（O(w·h) + 分配）；`Raycasting.compute` 的 perimeter 每次新建数组与对象（`:466`~`:473`）。

### P2 · [fsm] `can()` 在"转换表存在但当前状态缺项"时返回 true，白名单形同虚设

- **位置**：`StateMachine.ts:112`~`:116`
- **证据**：`transitions = { walk: ['run'] }`、当前态 `idle`（表中缺项）→ `can('jump') = true`、`can('teleport') = true`；对照组当前态 `walk`（表中有项）→ `can('jump') = false`、`can('run') = true`（`b1_v3` [24]）。
- **后果**：新增状态时忘了在 `transitions` 里补一行，该状态就**允许转换到任意状态**，且 `can()` 的返回值让宿主以为校验通过了。JSDoc `:62`~`:63` 只说"不填 = 允许任意"，没说"填了但缺项"也允许任意。
- **建议**：区分"未配置 transitions"与"配置了但缺项"，后者应返回 false（或按 `strict` 抛错）。

### P2 · [fsm] `reset()` 不检查 `_transitioning`、不触发 `onChange`；`start()` 可重复调用

- **位置**：`StateMachine.ts:201`~`:210`、`:98`
- **后果**：`enter` 回调抛异常时 `_current` 已切换、`_timeInState` 已归零，异常向上传播后状态机停在"已进入但未初始化"的中间态。

---

### P2 · [grid] （见正文）

- `hexRing` `:502` 注释写"半径 n 内的所有格子（含中心）"，实测 `hexRing(center,1).length = 6`（是环），`hexSpiral(center,1).length = 7`（才是实心）（`b1_v3` [30]）。注释说谎。
- `freeCount` `:429` 每次 O(n) 全扫；`findSpots` `:436`~`:447` 为 O(W·H·w·h)。
- `hexToPixel` / `pixelToHex` 的 `size = 0` → 除零得 NaN 坐标，无校验。

### P2 · [i18n] （见正文）

- `addLocale` 非 override 分支 `:89` 用 `Object.assign(exist, table)`，会触发 `__proto__` setter。实测追加 `JSON.parse('{"__proto__":{"polluted":"yes"},"b":"B"}')` 后，`t('polluted')` 返回 **`'yes'`**（本应是未翻译的 key 本身）（`b1_v5` [43]）。override 分支用 spread，不触发。**与已修的 `easing()` 原型链污染同类，是新实例。**

### P2 · [mmr] （见正文）

- `suggestedWindow` `:404` 的 `clamp(baseWindow * u, baseWindow, baseWindow * 3)` 在 `baseWindow < 0` 时 min > max，`clamp` 会返回 max（语义错误）。
- `fillFromPool` `:341`~`:351` 对 pool 每个候选都跑一次 `validateParty + teamMmr`（O(pool × party)）；`resolve(cfg)` 每次调用都重建配置对象。

### P2 · [mover] （见正文）

- `addImpulse` `:240`~`:241` 用**单次冲量**的 `mag2` 而非合成后的总外力判断 `knocked` → 多个小击退合成很大时 `knocked` 仍为 false，玩家在明显被推开时仍有完全控制权。
- `knockbackThreshold` 用 `<= 0` 判断是否"未指定"，显式传 0 会被静默改写成 `maxSpeed * 0.25`；`stoppingTime` 硬编码 1e6 上界；无 `destroy()`。

### P2 · [number-roller] （见正文）

- `duration.min/max/bigDelta/decimals` 全用 `?? 默认值`，未走 `numOr`。证据：`duration.min = NaN` → `isRolling = false`、`display = 5000`（直接跳到终值，**滚动动画静默失效**），对照组 `isRolling = true`、`display = 0`（`b1_v3` [20]）。
- `decimals = -1` → `toFixed(-1)` 抛 `RangeError`；`abbreviated` 硬编码 `toFixed(1)` 忽略 `opts.decimals`；`_overshoot < 1`（下冲）不生效但 JSDoc 只说"1 = 不过冲"。
- `formatted` 对 `-0.4` 输出 `"-0"`。

### P2 · [objective] 事件顺序：先发 `completed`，再补发一个 `progress`

- **位置**：`ObjectiveSystem.ts:244`~`:246`
- **证据**：`setProgress('k', 10)`（target=10）→ 事件序列为 `completed/10 | progress/10`（`b1_v3` [25]）。
- **后果**：订阅方先收到完成、再收到一条"进度 10"，容易把 UI 的"已完成"态覆盖回"进行中"。JSDoc `:93`~`:98` 未约定事件顺序。
- **建议**：完成时不补发 progress，或在 JSDoc 明确"completed 之后仍可能收到同帧 progress"。

### P2 · [objective] `setProgress` / `addProgress` 不校验有限性

- **位置**：`ObjectiveSystem.ts:239`、`:268`
- **证据**：`setProgress('k', NaN)` → `status = active`、`progress = NaN`，并上报 `progress/NaN` 事件（`b1_v3` [25]）。
- **后果**：进度来自外部计数（击杀数、采集数）时，一次 NaN 会让 UI 进度条显示 NaN 且无法自愈（`protect` 的 `progress <= 0` 也挡不住 NaN）。

### P2 · [objective] 无 `destroy()`；`reset()` 不触发任何 `onEvent`

- 该类持有 `onEvent` / `onAllComplete` / `onFailed` **三个外部回调**，rule5 要求可卸载。

---

### P2 · [pathfind] （见正文）

- `_openMark` `:183` 在 `:259` / `:322` 被写入，全文件从未读取（stamp 机制取代了它）——死代码。
- `FlowField.destroy` `:619`~`:623` 把 `_dist/_dirs` 换成长度 0 的数组，之后 `distanceAt` 返回 `undefined` 而非 JSDoc `:570` 承诺的 `-1`（`reachable` 仍能正确返回 false，但类型契约破了）。
- `PathSmoother.hasLineOfSight` `:378`~`:403` 是 `for(;;)` 且只靠 `_walkable` 拦越界；调用方传入不检查越界的 `walkable`（常见写法 `(x,y) => grid[y][x] === 0`）会越界 `TypeError`。
- `FlowField.build` 每次 `new Uint8Array(n)`，而 `_dist/_dirs` 复用，两处不一致。

### P2 · [progressbar] `lowThreshold` / `highThreshold` 未收口，同一构造函数里两套标准

- **位置**：`ProgressBar.ts:140`~`:141`（`clamp01(opts.x ?? 默认)`）
- **现象**：`clamp01` 只挡 NaN 的一部分路径，非数字会直接穿透 → `r <= NaN` 恒 false → **永远不进入 low 态**。
- **证据**：`value = 5`（5%）、`lowThreshold = NaN` → `state = **normal**`；对照组默认 `0.25` → `state = **low**`（`b1_v2` [13]）。
- **后果**：血条危险时不显示红色/闪烁，玩家在残血时得不到预警。这是血条最核心的功能之一，静默失效。
- **建议**：与同文件其他字段统一为 `Math.max(0, numOr(opts.x, 默认))`。

### P2 · [progressbar] `segmentBounds` 的 gap 分摊不对称

- **位置**：`ProgressBar.ts:370`~`:373`
- **现象**：首段/末段各只扣 `gap/2`，中间段扣 `gap` → **两端段比中间段宽 `gap/2`**。
- **后果**：分段血条/经验条视觉上格子不等宽，美术会当作渲染问题来查。

### P2 · [progressbar] 构造校验挡不住 NaN；无 `destroy()`

- `if (this._max <= this._min) throw` 对 NaN 恒 false（NaN 比较恒 false）。`snapshot()` 每帧 new 对象。

---

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

### P2 · [steering] （见正文）

- **注释说谎**：`:120` 注释写"向量工具（**就地操作**，避免 GC）"，但 `scale/add/sub/normalize` `:131`~`:151` **全部 `return v2(...)` 新建对象**，一个就地操作都没有。后果①：boids 每帧每单位数十次分配，与注释承诺的性能目标相反；后果②：调用方若按"就地修改"语义使用（`normalize(v); use(v)`）会拿到未归一化的 `v`。**注：这几个函数未导出，无法在运行时验证，此处为行号推导。**
- `circleFormation` `:514` 的 `index / count`，`count = 0` → `angle = NaN` → 返回 `{x: NaN, y: NaN}`。证据：`circleFormation(0, 0, 10)` 返回 `{"x": null, "y": null}`（JSON 序列化后的 NaN）（`b1_v2` [9]）。`formationOffset` 的 `columns = 0` 同理。
- `integrate` 的 `maxSpeed = NaN` → `speed > NaN` 恒 false → 不限速。

### P2 · [telemetry] （见正文）

- `flushIntervalMs = NaN` → `shouldFlush()` 恒 `true`（`:236` 的 `now - last < NaN` 为 false）。实测 `true` vs 对照组 `false`（`b1_v3` [21]）。后果：宿主轮询时每条事件都触发一次网络请求，流量与电量上升。
- `willSample` `:187` 直接查 `_eventSampleRates[name]`（默认 `{}`），`'constructor'` 等原型键会取到函数 → 采样判定恒 false。
- 无 `destroy()`（rule5）；`_stats.dropped` 不统计"重试超限丢弃"，与 JSDoc 口径不符；`flushSync` 名为 Sync 实为 async。
- `sampleRate` 未收口：**仅限非数字串**。实测 `sampleRate = '0.5'`（数字字符串）仍正常工作（50 次 capture 成功 32 次，符合 50% 采样）；但 `sampleRate = 'abc'` → 成功 **0** 次，全量静默丢失（`b1_v3` [38]）。


---

## 4. 贯穿本批的六个共享模式

这些模式在多个单元里重复出现。**按模式统一修法，不要每个单元各写一套。**

### 模式 A · 否定式条件拦不住 NaN（最高频）

```ts
// ✗ 错：NaN 参与 <= 比较恒为 false，直接穿透
if (x <= 0) return;
if (amount >= s.count) return -1;

// ✓ 对：肯定式，NaN 时条件成立 → 正确拒绝
if (!(x > 0)) return;
if (!(amount < s.count)) return -1;
```

**这一条是本批最高频的错误形态。** 涉及 `inventory` / `anticheat` / `bullet-pattern` / `dungeon` / `timeutil` 等多个单元。
原因是 JS 里 NaN 与任何值比较都为 false，否定式判断天然漏掉它。

### 模式 B · `??` 和 `Math.max` 都挡不住 NaN

```ts
// ✗ 错：?? 只挡 null/undefined
this._maxRetries = opts.maxRetries ?? 3;      // NaN 直接存进去
Math.max(0, v)                                 // Math.max(0, NaN) === NaN

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

`blessing` / `curse` / `meta` 三个单元都有这个问题：
`set`（覆盖）语义的效果被乘上了层数/等级，与 `add`/`mul` 混为一谈。

### 模式 E · 遍历中修改集合

```ts
// ✗ 错：回调里注销自己会 splice 数组，下一个回调被跳过
for (const fn of this._onSpawn) fn();

// ✓ 对：遍历副本
for (const fn of [...this._onSpawn]) fn();
```

### 模式 F · 缺省配置与 JSDoc 承诺相反

`mover` 的 `maxExternal = Infinity`、`replay` 的 `seed = 0`、
`telemetry` 的 `maxRetries` 等——**默认值恰好让文档承诺的功能失效**。
改法要二选一：要么改默认值，要么改文档说清真实语义。
**不要只改其中一个又不动另一个。**

---

## 5. 交付要求

### 5.1 每条修复的产出

1. **源码改动**：只改必要的那几行，附"为什么"注释
2. **回归测试**：一条在修复前**确实会失败**的用例
3. **对照用例**：一条验证"正常输入不受影响"的用例（防止矫枉过正）

### 5.2 测试放哪

新建 `tests/run_phase10_c.ts`，并在 `tests/run.ts` 里注册：

```ts
setSuite('精审返工 · 窗口C');
runPhase10CTests();
```

⚠️ 注册后务必跑一次全量，确认 `run.ts` 能被构建到（沙盒曾出现过文件被写入重复 import 行的事故）。

### 5.3 报告

完成后产出 `audit/handoff_C_result.md`，每条一行：

```
| 编号 | 单元 | 严重度 | 状态 | 复现输出（修复前） | 修复后 | 测试位置 |
```

状态用：`已修` / `已修（附说明）` / `不成立（附证据）` / `需总审裁决`。

**"不成立"要有真凭实据**——贴出你的复现脚本和输出，说明为什么报告描述的现象不存在。
不要因为"看代码觉得没问题"就判不成立。

### 5.4 提交前自检

```bash
bash build.sh
node .build/tests/run.js                    # 必须全绿，且条数只增不减
node scripts/check-deps.js                  # 全部通过（记得删 verify/）
node scripts/check-links.js
python3 scripts/scan-dt-guard.py
python3 scripts/scan-num-guard.py
python3 scripts/check-random-source.py
python3 scripts/check-dup-exports.py
```

---

## 6. 并行纪律（三个窗口同时开工）

| 事项 | 约定 |
|---|---|
| **单元边界** | 三个窗口的单元**零重叠**，但 `_core/` 谁都不要碰 |
| **`tests/run.ts`** | 三个窗口都要改它 → **最后合并时由总审统一处理**，你只管写自己的 `run_phase10_c.ts` |
| **`README.md`** | 测试总数在变，**不要改**，由总审统一更新 |
| **临时脚本** | 放 `/tmp` 或 `verify/`（用完删） |
| **`build.sh`** | 会整体替换 `.build/`，**不要在别的窗口构建时跑**；失败就重跑一次 |

---

## 7. 需要总审裁决的先记下来

遇到以下情况**不要自己拍板**，在报告里标"需总审裁决"并说明两种选择的利弊：

1. 修复会改变**对外 API 行为**（可能 breaking）
2. 报告建议的改法与单元 README 的**明确声明冲突**
3. 两处代码"看起来不一致但可能都是故意的"
   （例如相切语义：空间索引要求"不含相切"，通用 AABB 要求"含相切"，**两者都对**）
4. 你判断某条"不成立"

---

## 8. 最后一句

这个库现在 **3695 项测试全绿**，是你开工前的基线。
你交付时这个数字只能涨、不能跌——如果跌了，说明你的修复伤到了既有行为，
回去看第 1.1 节的第 1 条。
