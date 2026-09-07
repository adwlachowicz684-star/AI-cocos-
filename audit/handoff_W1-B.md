# 精审返工任务书 · 窗口 W1-B（第 B 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W1-B 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **20**（P1 13 / P2 7） |
| 单元 | **7** 个 |
| 来源批次 | batch3、batch4 |
| 所属组 | **第 B 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W1-A**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_B.md` 验收 **W1-A**。

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

**`_core/` 不在任何窗口的清单里，严禁修改。** 它被 55 个单元依赖，你改一行会影响另外 15 个窗口。

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

### 3.1 你的单元（7 个，与其它 15 个窗口零重叠）

```
anticheat  audio  buff  collision  condition  skill-player  spatial
```

---


## 【P1】先做这批

### P1 · [anticheat] `SpeedChecker` 的 dt 守卫 `dtSec <= 0` 挡不住 NaN，导致连续违规计数 `_strikes` 被清零

- **位置**：`anticheat/AntiCheat.ts:187`（守卫）、`201-212`（`exceeded` 判定与 `_strikes` 增减）
- **现象**：`NaN <= 0` 为 false，NaN 时间戳**不**被守卫拦下；继续算出 `speed = dist / NaN = NaN`，`exceeded = NaN > allowed = false`，于是走 `else` 分支 `_strikes = 0`。
- **证据**：实测（`verify/b3_v2.ts`）
  ```
  第2次超速: speed=100.0 strikes=1
  第3次超速: speed=100.0 strikes=2
  注入 1 次 NaN 时间戳前 strikes = 2
  NaN 时间戳那次返回: strikes=0
  → NaN 之后 strikes = 0
  ```
- **后果**：`strikeThreshold` 的意义是"连续 N 次超速才判定"。作弊者只要在**任意一次**上报里塞一个 NaN 时间戳，就能把连击清零、永远够不到阈值。这是可被主动利用的绕过（比 P0-1 更需要"配合"，但触发路径明确）。静默：返回的是正常 `SpeedViolation` 对象，看不出异常。
- **建议**：守卫改成 `if (!(dtSec > 0)) return null;`（同时挡 NaN/负数/0），并对 `dist` 加 `Number.isFinite` 检查后再进入判定，且把"不合法样本"与"合规样本"分开——不合法样本应 **跳过不计**（既不 ++ 也不清零）：
  ```ts
  if (!Number.isFinite(dtSec) || dtSec <= 0) return null;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (!Number.isFinite(dist) || dist < this._minDist) return null;
  ```
- **影响面**：同 P0-1。注意"跳过不计"与"清零"语义不同——清零是惩罚绕过点，跳过才是中性处理。

### P1 · [audio] `masterVolume` 非法值穿透，`effectiveVolume` 返回 NaN

- **位置**：`audio/AudioManager.ts:111`（`clamp(cfg.masterVolume ?? 1, 0, 1)`，`clamp` 不挡 NaN）+ `312-318`
- **证据**：实测：`new AudioManager({masterVolume: NaN})` → `effectiveVolume(1) === NaN`。根因是 `_core` 的 `clamp(NaN,0,1) === NaN`（已确认非 `_core` 的 bug，是调用方未收口）。
- **后果**：音量变 NaN 传给引擎，通常是静音或爆音，且不报错。
- **建议**：`this._master = clampNum(cfg.masterVolume, 0, 1, 1);`

### P1 · [audio] 全部通道被 `loop` 占满时，新音效被**永久拒绝**

- **位置**：`audio/AudioManager.ts:226-238`（`if (h.loop) continue;` —— 循环音永远不选为 victim）
- **证据**：实测（`b4_v6.ts`）：`maxVoices=4`，放 4 个 `loop:true` → 再 `play('normal')` → 返回 **null**，`stats.rejected === 1`。
- **后果**：环境音/BGM 层占了 loop 通道后，所有一次性音效（脚步、命中、UI）全部消失。设计上可能是有意的，但没有上限保护也没有文档说明，调用方会以为是"声音系统坏了"。
- **建议**：为 loop 保留一个可抢占的低优先级通道，或在 README 的"坑表格"里写明"loop 音不可被抢占，请为一次性音效预留通道"。

### P1 · [audio] `BgmStack.setState()` 用 `in` 操作符，命中 `Object.prototype` 上的键

- **位置**：`audio/BGMStack.ts:86, 114`（`if (!(cfg.initialState in cfg.states))`、`if (!(next in this._states))`）
- **证据**：实测（`b4_v1.ts`）：`setState('toString')` 返回 **true**（`_mixOf('toString')` 取到 `Object.prototype.toString`），后续 `mix[lc.name] ?? 0` 全部落到 0，**所有层音量被静默设成 0**。
- **后果**：**第 2 节 `easing()` 原型链污染的又一个新实例（本批第 2 例）**。状态名来自配置/外部输入时，`'constructor'`/`'toString'` 会把 BGM 全部拉到 0 且不报错。
- **建议**：改用 `Object.prototype.hasOwnProperty.call(this._states, next)`，或把 states 换成 `Map`。

### P1 · [buff] `import()` 不恢复 `_independent`，独立叠层 buff 读档后层信息丢失

- **位置**：`buff/BuffSystem.ts:347-360`（只写 `_active`），对比 `:107` 的 `_independent` 与 `:375-382` 的 `_syncIndependent`
- **现象**：`independent` 模式的 buff 在 `_independent` 里存实例数组，`_active` 里存聚合视图。`import()` 只重建 `_active`，`_independent` 为空。
- **证据**：行号推导——`import()` 全程无 `_independent.set`；而 `:375` 的 `_syncIndependent` 依赖 `this._independent.get(id)` 返回非空，否则直接 `return`，聚合视图再也不会被刷新。
- **后果**：读档后该类 buff 的 `stacks` 停在导入值，后续 `apply()` 走 `_independent` 分支时与 `_active` 不同步，出现"层数乱跳"。静默无报错。
- **建议**：`import()` 时对 `stackMode === 'independent'` 的 def 重建 `_independent` 数组（每层一个实例，`remain` 相同）。

### P1 · [buff] `import()` 不校验 `remain` / `stacks`，`remain = NaN` 会产出永不消失的永久 buff

- **位置**：`buff/BuffSystem.ts:347-360`（`import`）
  ```ts
  this._active.set(d.id, { def, stacks: d.stacks, remain: d.remain, tickTimer: ... });
  ```
- **现象**：`register()`（`:111-125`）对 `duration` / `maxStacks` / `tickInterval` 有严格校验，但 `import()` 完全绕过这些校验，直接把外部数据塞进 `_active`。
- **证据**：实测（`verify/b3_v3.ts`）
  ```
  import([{ id:'poison', stacks:999, remain:NaN }]) 后：
    stacks = 999     (maxStacks=3，未收口)
    remain = NaN
    推进 100 秒后 remain = NaN   是否仍生效 = true
  ```
  机制：`:306` 的 `inst.remain -= dt` 得 NaN，`:316` 的 `if (inst.remain <= 0)` 对 NaN 为 false → 永不进入过期分支。
- **后果**：存档被截断/篡改/版本升级字段缺失时，玩家读档后获得**永远不掉的中毒/眩晕**。不会报错，只会表现为"这个 buff 怎么一直在"。同理 `stacks` 可超过 `maxStacks`（实测 999 > 3），导致数值修正叠加失控。
- **建议**：`import()` 复用 `register()` 的校验并对每个字段收口：
  ```ts
  const stacks = clampNum(d.stacks, 1, def.maxStacks ?? 1, 1);
  const remain = numOr(d.remain, def.duration);
  if (!Number.isFinite(remain) || remain <= 0) continue;   // 或回退到 def.duration
  ```
- **影响面**：所有存档读档路径；`damage-pipeline/Modifier` 会据此重建数值修正，层数失控会直接放大伤害/治疗。

### P1 · [collision] `raycastAabb` 起点在盒内时返回 miss，而同单元的 `raycastCircle` 起点在圆内返回 hit——同一 `raycast()` 入口下两种形状语义不一致

- **位置**：`collision/Collision.ts:1075`（`if (tmax < tmin || tmax < 0 || tmin < 0) return _rayMiss;`），对比 `:1130-1145` 的 `raycastCircle`（`const t = t1 >= 0 ? t1 : t2;`）
- **现象**：起点在 AABB 内部时 `tmin < 0 < tmax`，`tmin < 0` 成立 → 判 miss。而 `raycastCircle` 在同样情形（起点在圆内，`cc < 0`）会取正根 `t2` 返回穿出点。
- **证据**：实测（`verify/b3_v3.ts`）
  ```
  raycastAabb   起点在盒内 (0,0)->(1,0): {"hit":false,...}
  raycastCircle 起点在圆内 (0,0)->(1,0): {"hit":true,"t":10,"x":10,"y":0,...}
  → 两者语义不一致
  ```
  同一文件内两个兄弟函数对"起点在内部"给出相反结论。
- **后果**：`raycast()`（`:1177-1205`）是统一入口，会根据 shape 类型分派。做视线检测（LOS）时，如果射线起点落在某个 AABB 障碍内部（角色贴墙、站在触发盒里、胶囊体起点偏移进墙），AABB 障碍被判"没挡住" → **敌人隔着墙看见玩家**；换成圆形障碍就正常。表现为"偶尔能穿墙看到人"，极难复现和定位。
- **建议**：统一语义。推荐与 `raycastCircle` 对齐（起点在内部时返回穿出点 `t = tmax`），即把守卫改为：
  ```ts
  if (tmax < tmin || tmax < 0) return _rayMiss;   // 去掉 tmin < 0
  if (tmin < 0) { /* 起点在内部：返回穿出点 */ tmin = tmax; ... }
  ```
  并在 README 明确写出"起点在形状内部时返回穿出点"这一契约。**若"起点在内部算 miss"是有意为之，请见"存疑-5"。**

### P1 · [condition] `setStat` 校验有限性但 `addStat` 不校验，NaN 一旦进 stats 就毒化整个引擎

- **位置**：`condition/ConditionEngine.ts:52-63`（`setStat` 抛异常，`addStat` 无检查）
- **证据**：实测：`addStat('x', NaN)` → `getStat('x') === NaN`；随后 `evaluate()` 的 `completed === false`、`progress === NaN`。`setStat('x', NaN)` 则正常抛异常。
- **后果**：同一份"必须有限"的契约在两个 setter 上不一致。调用方按 setStat 的心智用 addStat，NaN 静默入库，之后所有涉及该 stat 的条件永远 false，且不报错。
- **建议**：`addStat` 复用与 `setStat` 相同的有限性校验（或抽 `_assertFinite`）。

### P1 · [condition] `evaluate()` 对 `c.value` 为 NaN 的配置返回 NaN 进度

- **位置**：`condition/ConditionEngine.ts:100-101`（`c.value === 0` 挡不住 NaN，`actual / NaN = NaN`）
- **证据**：实测：`{stat:'x', op:'>=', value:NaN}`，`x=5` → `progress === NaN`。
- **后果**：配置表 value 字段缺失 → `undefined`，`undefined/… = NaN`，`Math.min(1, Math.max(0, NaN)) = NaN`，进度条渲染出 `NaN%`。
- **建议**：`register()` 时对每条 condition 校验 `Number.isFinite(c.value)`，或 `evaluate` 里用 `numOr` 收口。

### P1 · [skill-player] 循环播放时 `t = 0` 的事件只在首次 `play()` 触发，后续每轮丢失

- **位置**：`skill-player/SkillPlayer.ts:99`（`play` 里 `_fireRange(0, 0, true)` 用 `inclusiveFrom=true` 带上 t=0）+ `105-122`（`tick` 里 `this._time -= this._track.duration` 后**没有补发 t=0 事件**）+ `125-127`（`_fireRange` 默认 `inclusiveFrom=false`，范围是 `(from, to]`）
- **证据**：实测（`b4_v2.ts`）：`duration: 1, loop: true`，事件 `[{t: 0, type:'boom'}]` → `play()` 后触发 **1** 次；跑 130 帧（约 2.17 秒，跨 2 次循环）→ 累计仍为 **1** 次（期望 3 次：0s、1s、2s）。
- **后果**：循环技能（持续施法、光环、旋转攻击）把起始帧事件放在 `t=0` 时，**只有第一轮生效**。表现为"技能第一轮有音效/特效，之后就哑了"，而事件数据本身看起来完全正常。
- **建议**：`tick` 里 `_time -= duration` 之后补一次 `this._fireRange(0, this._time, true)`，保证每轮起始事件被触发。

### P1 · [skill-player] 旧的 `SkillHandle.cancel()` 会停掉**当前正在播放的**新轨道

- **位置**：`skill-player/SkillPlayer.ts:13-32`（`SkillHandle` 只持有 `player` 引用，`cancel()` 直接调 `this._player.stop(true)`，未校验归属）
- **证据**：实测（`b4_v2.ts`）：`h1 = play(trackA)` → `play(trackB)` → `h1.cancel()` → `player.state` 变为 **`idle`**（B 被停掉了）。
- **后果**：技能被打断/切换时，旧句柄如果因为异步（动画回调、延迟调用）晚一步执行 cancel，会把**已经开始的下一个技能**一起停掉。表现为"连续放技能时莫名其妙中断"，且时序相关，极难复现。
- **建议**：`SkillHandle.cancel()` 里加 `if (this._player.currentHandle !== this) return;`（player 需暴露 `currentHandle` getter），让过期句柄自动失效。

### P1 · [spatial] `_findEntry` 是全表 O(n) 线性扫描，`queryNearest` 退化成 O(k·n)——第 2 节点名的 queryCircle 同类问题的新实例

- **位置**：`spatial/SpatialHash.ts:227-233`（`_findEntry`），调用点 `:218`
- **现象**：`queryCircle` 返回的是 `T[]`（只有 item，没有坐标），`queryNearest` 为了排序不得不逐个元素反查坐标，而 `_findEntry` 用 `e.item === item` 遍历**整个** `_items` Map。
- **证据**：行号推导——`_findEntry` 是 `for (const e of this._items.values())`，单次 O(n)；`withDist = results.map(...)` 对 `results.length`（可达 k，也可能远大于 k）个元素各调一次 → O(k·n)。与第 2 节 `QuadTree.queryCircle` 退化成 O(k·n) 是同一模式。
- **后果**：实体数上千时，一次"找最近 5 个"变成几十万次引用比较。每帧调用会掉帧，且不报错——典型的"人少时没事、人多了就卡"。
- **建议**：让 `queryCircle` / `queryRect` 直接返回带坐标的条目（或在内部就完成距离排序），不要让调用方反查；或给 `SpatialHash` 增加 `queryNearestWithPos()` 返回 `{item,x,y,d2}[]`，彻底废除 `_findEntry`。
- **影响面**：同 P0-3。

### P1 · [spatial] 配置项 `capacity` 声明后从未被使用（契约不一致）

- **位置**：`spatial/SpatialHash.ts:49`（`readonly capacity?: number;`）
- **现象**：全文 grep，`capacity` 只在接口定义处出现一次，构造函数与所有方法均未读取。
- **证据**：`grep -n "capacity" spatial/SpatialHash.ts` 仅命中 `:49`；README 亦未提及。
- **后果**：调用方以为传 `capacity` 能限制内存/条目数，实际完全无效。属于"写了但没实现"的配置，比没有更糟——会让人误以为已做容量保护。
- **建议**：要么实现（`update()` 时若 `_items.size >= capacity` 则拒绝或淘汰最旧），要么从接口删除。


## 【P2】P1 完成后再做

### P2 · [anticheat] （见正文）

- `SpeedChecker` 无 `destroy()`（无外部资源，仅登记）。
- `_window.shift()` 为 O(n)，窗口通常很小，可接受。

---

### P2 · [audio] `describe()` 的字符串拼接缺分隔符

- **位置**：`audio/AudioManager.ts:371-374`
- **证据**：代码直读：打印出来是 `...待播 0分类 [sfx:3]`（"待播 0"与"分类"之间缺空白/换行）。
- **后果**：调试输出难读。
- **建议**：补 `\n` 或空格。

---

### P2 · [buff] （见正文）

- `onChange()`（`:349-354`）只保留**单个**监听器（`this._onChange = fn` 直接赋值），第二次注册会静默顶掉第一次。若文档承诺多播，需改为数组 + 精确删除的取消函数（参照 `damage-pipeline` 的 `onResult`，它用 `indexOf` 精确删除，是本批的正面样板）。
- `clear()`（`:239-245`）只发一次 `'clear'`，不逐个发 `'remove'`，依赖方若只监听 `remove` 会漏更新。

---

### P2 · [collision] （见正文）

- `CollisionGrid._key`（`:843-845`，`((cx & 0xffff) << 16) | (cy & 0xffff)`）坐标超出 16 位会 wrap，不同格子共享 key → 只是**多报**候选（不漏报），配合后续精确检测不会出错，但会让查询变慢。建议注释标注坐标有效范围。
- `insert()`（`:859-877`）用 `arr.some(e => e.id === c.id)` 去重，是 O(格子数 × 桶内元素数)；大物体跨多格时开销明显。可改用"记录上次 cell 集合，增量 diff"。
- `query()` 复用 `_scratchSeen`（`:880-...`）：若调用方在遍历 `out` 期间再次调用 `query()`，`seen` 被 clear 会导致外层结果错乱（可重入性问题）。建议注释标注"不可重入"。
- 无 `destroy()`——但本单元以纯函数为主，`CollisionGrid` 只有 Map，GC 可回收，判 P2。
- **`satOverlap` 返回共享常量 `_satEmpty`**（`:248, 257`）：若调用方修改返回值会污染全局。当前调用方只读，风险低，建议加 `Object.freeze` 或注释。

---

### P2 · [condition] `onComplete` 只支持单个监听器

- **位置**：`condition/ConditionEngine.ts:183-188`（`this._onComplete = fn` 直接覆盖）
- **证据**：代码推导：第二次 `onComplete` 会顶掉第一次，且第一次拿到的取消函数此后 `this._onComplete === fn` 为 false，形同失效。
- **后果**：成就系统和任务系统同时监听时，先注册的那个静默失联。
- **建议**：改为监听器数组 + 返回带 id 的取消函数。

---

### P2 · [skill-player] `tick()` 对非有限 dt 用 `step = 0` 兜底，静默吞帧

- **位置**：`skill-player/SkillPlayer.ts:105-108`（`const step = safeDt(dt) ? dt : 0;`）
- **证据**：代码直读 + 与 `projectile`/`telegraph`（直接 `return`）对比。
- **后果**：不会污染状态（比 NaN 穿透好），但会静默吞掉一帧。
- **建议**：无需改代码，补文档说明。

---

### P2 · [spatial] （见正文）

- `update()` 中 `item as T` 强转（`:60` 附近）：首次 `update(id,x,y)` 不传 item 时，`item` 为 undefined 被强转为 T，`get(id)` 会返回类型上合法、运行时为 undefined 的值。
- `destroy()` 存在 ✅（调用 `clear()`）。

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

新建 `tests/run_phase10_w1b.ts`，并**在文件内导出** `runPhase10W1BTests()`：

```ts
export function runPhase10W1BTests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W1-B.md`，每条一行：

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

## 6. 并行纪律（16 个窗口同时开工）

| 事项 | 约定 |
|---|---|
| **单元边界** | 16 个窗口**两两零重叠**，已程序化核验 |
| **分组** | 第 A 组 = `W*-A`，第 B 组 = `W*-B`。组间单元也零重叠（互补分工） |
| **`_core/`** | 谁都不要碰 |
| **`tests/run.ts`** | **总审统一合并**，你不要改 |
| **`README.md`** | 测试总数在变，**不要改**，总审统一更新 |
| **临时脚本** | 放 `/tmp` 或 `verify/`（用完删） |
| **`build.sh`** | 会整体替换 `.build/`；偶发 502 导致中断时**重跑一次**即可 |
| **文件命名** | `run_phase10_w1b.ts` / `result_W1-B.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 B 组**。修完之后，按 `audit/review_B.md` 验收 **W1-A**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W1-B.md`，
回报给对方窗口或总审。

---

## 8. 需要总审裁决的先记下来

遇到以下情况**不要自己拍板**，在报告里标"需总审裁决"并说明两种选择的利弊：

1. 修复会改变**对外 API 行为**（可能 breaking）
2. 报告建议的改法与单元 README 的**明确声明冲突**
3. 两处代码"看起来不一致但可能都是故意的"
   （例：相切语义——空间索引要求"不含相切"，通用 AABB 要求"含相切"，**两者都对**）
4. 你判断某条"不成立"

---

## 9. 最后一句

这个库现在 **3695 项测试全绿**，是你开工前的基线。
你交付时这个数字只能涨、不能跌——如果跌了，说明你的修复伤到了既有行为，
回去看第 1.1 节第 1 条。
