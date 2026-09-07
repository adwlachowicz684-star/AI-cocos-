# 精审返工任务书 · 窗口 W8

> 本文件是**第二次精审 273 条**中分配给窗口 W8 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **27**（P1 15 / P2 12） |
| 单元 | **12** 个 |
| 来源批次 | batch3 |
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
accessibility  anticheat  buff  camera  collision  difficulty  gameflow  input  matchmaking  perception  settings  spatial
```

---


## 【P1】先做这批

### P1 · [accessibility] `fontScale` 的构造校验挡不住 NaN；`shakeScale` 构造不 clamp 而 setter clamp（口径不一致）

- **位置**：`accessibility/Accessibility.ts:84-95`（构造）、`:147-150`（`setFontScale`）、`:172-176`（`setShakeScale`）
- **现象**：`if (this._fontScale <= 0) throw` 中 `NaN <= 0` 为 false → NaN 不被拦截；`setFontScale` 的 `Math.min(2, Math.max(0.8, v))` 对 NaN 同样穿透。另一方面 `shakeScale` 构造时原样接受任意值，setter 却 clamp 到 [0,1]。
- **证据**：实测（`verify/b3_v5.ts`）
  ```
  new Accessibility({fontScale: NaN}) 未抛错！
  fontSize(16) = NaN
  new Accessibility({shakeScale: 5}) 构造成功, shakeScale = 5
  setShakeScale(5) 后 shakeScale = 1        ← 被 clamp
  ```
- **后果**：`fontScale = NaN` 会让**全UI字号变成 NaN**（`fontSize()` 是 `base * _fontScale`），文本渲染异常或消失，且不报错——NaN 一旦进入布局要很久才回溯到这个配置项。`shakeScale` 口径不一致则导致"构造时传 5 生效、之后重设被压到 1"，行为随调用路径变化。
- **建议**：构造统一走 setter 语义并收口：
  ```ts
  this._fontScale  = clampNum(opts.fontScale,  0.8, 2,   1);
  this._shakeScale = clampNum(opts.shakeScale, 0,   1,   1);
  this._longPressMs = clampNum(opts.longPressMs, 200, 3000, 600);
  ```
  注意 `importState()`（`:179-201`）反而**做对了**（逐字段 `typeof` + `Number.isFinite` 校验），把它的校验强度提到构造函数即可。

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

### P1 · [camera] `CameraFollow.update()` 在 `smoothDamp` 之后又做了一次 `maxSpeed` 限速，构成双重限速

- **位置**：`camera/CameraFollow.ts:323-333`（`update()` 尾段）
  ```ts
  this._x = smoothDamp(this._x, goalX, this._velX, this._smoothTime, dt, this._maxSpeed);
  ...
  if (this._maxSpeed < Infinity) {
    const lim = this._maxSpeed * dt;
    this._x = prevX + clamp(this._x - prevX, -lim, lim);
  }
  ```
- **现象**：限速被施加了两次——一次在 `smoothDamp` 内部（`_core/math.ts:318-320` 的 `change = clamp(change, -maxChange, maxChange)`），一次在 `CameraFollow` 里按 `maxSpeed * dt` 硬裁每帧位移。
- **证据**：实测（`verify/b3_v1.ts`，DT=1/60，目标极远）
  ```
  maxSpeed=10  smoothTime=0.2 → camera=9.9834   smoothDamp=10000   无限制=10000
  maxSpeed=50  smoothTime=0.2 → camera=49.9168  smoothDamp=10000   无限制=10000
  maxSpeed=100 smoothTime=0.5 → camera=99.8336  smoothDamp=10000   无限制=10000
  ```
  **注意这里的反直觉结果**：`smoothDamp(带 maxSpeed)` 的稳态速度 = 10000 = 无限制速度，即**当前代码里 `smoothDamp` 的 `maxSpeed` 参数实际并未限速**（原因见"存疑"第 1 条）；真正把速度压到 10 的，恰恰是 `CameraFollow` 这段"二次 clamp"。所以它不是多余的补丁，而是**当前唯一生效的那层限速**。
- **后果**：这层的语义（`maxSpeed * dt` 硬裁每帧位移）与 `smoothDamp` 的语义（限制"与目标的距离"间接限速）不同。若 `_core` 的 `smoothDamp` 日后修好，两层叠加会让相机实际最大速度**低于**配置的 `maxSpeed`，且 `smoothTime` 的表现与文档描述不符——表现为"相机跟随发黏、追不上目标"，调参时很难意识到是双重限速。
- **建议**：请先裁决"存疑-1"（`_core` 版本）。若 `smoothDamp` 已修好 → 删除 `:329-333` 这段二次 clamp，只保留 `smoothDamp` 的 `maxSpeed`；若未修 → 保留此段作为兜底，但加注释说明"这是给 `smoothDamp` 的 maxSpeed 打的补丁，待其修复后移除"，避免后人误删或再加一层。
- **影响面**：所有用 `CameraFollow` 且配了 `maxSpeed` 的项目。

### P1 · [camera] `offsetRotation` 是对外承诺但恒为 0 的死接口（README 已列出该 API）

- **位置**：`camera/CameraShake.ts:163`（`private _orot = 0`）、`:197-199`（getter）、`:266` 与 `:368`（仅清零，从不赋非零值）
- **现象**：`_orot` 只有三处写入，全是 `= 0`。`tick()` 里计算了 `totalX/totalY` 却从未计算旋转分量。
- **证据**：`grep -n "_orot" camera/CameraShake.ts` 命中 `:163, 183, 197, 198, 260, 266, 368`，其中 `:260` 是注释、`:183/266/368` 均为清零，无任何 `= 非0` 赋值。而 `camera/README.md:118` 明确写着：`| offsetX / offsetY / offsetRotation | 本帧偏移量，直接加到相机位置上 |`。
- **后果**：调用方按 README 把 `offsetRotation` 加到相机 rotation 上，永远是 +0——**震屏没有旋转分量**。不会报错，只是"打击感少了一块"，且因为 README 写了，没人会去查实现。属于典型的"文档写了但源码没实现"。
- **建议**：要么实现旋转分量（`totalRot` 用第三个噪声采样，同样参与 `maxOffset` 限幅），要么从 README 和类接口中移除 `offsetRotation`。二选一，不要留着。

### P1 · [camera] `CameraFollow` 没有 `destroy()`，而同单元的 `CameraShake` 有

- **位置**：`camera/CameraFollow.ts:41-216`（整个类，无 destroy）
- **现象**：`CameraShake` 提供了 `destroy()`（`:389-391`），`CameraFollow` 没有。
- **证据**：`grep -n "destroy" camera/*.ts` 只命中 `CameraShake.ts`。
- **后果**：违反 rule5。虽然 `CameraFollow` 当前只持有数值状态和一个 `bounds` 引用（无监听器/定时器，GC 可回收），但同单元两个类对外契约不一致，调用方会困惑"到底要不要 destroy"。
- **建议**：补一个语义明确的 `destroy()`（清 `bounds`、重置状态），或在与 `CameraShake` 统一的外壳类里提供一个总的 `destroy()`。

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

### P1 · [gameflow] `historyLimit <= 1` 时历史裁剪失效，`_history` 无限增长（内存泄漏）

- **位置**：`gameflow/GameFlow.ts:104`（`this._historyLimit = opts.historyLimit ?? 32;`）、`:310-320`（`_pushHistory`）
  ```ts
  this._history.push(id);
  if (this._history.length > this._historyLimit) {
    const keep = this._historyLimit;
    this._history = [this._history[0], ...this._history.slice(-(keep - 1))];
  }
  ```
- **现象**：`slice(-(keep - 1))` 在 `keep <= 1` 时参数变为 `slice(0)` 或 `slice(正数)`，退化成"几乎全量复制"，裁剪后长度反而**不减反增**。
- **证据**：实测（`verify/b3_v2.ts`）
  ```
  historyLimit=32 (默认) 跑 200 次切换 → history 长度: 32   ← 正常
  historyLimit=1           跑 200 次切换 → history 长度: 401 ← 每次 +2
  historyLimit=0           跑 200 次切换 → history 长度: 201 ← 每次 +1
  historyLimit=0 跑 2000 次切换 → history 长度: 2001        ← 无上限增长
  ```
- **后果**：`historyLimit` 是**容量类字段却用 `??` 而非 `clampNum` 收口**（第 2 节点名的同类风险）。配置成 0（有人会理解为"不限制"，有人理解为"不保留"）时，长会话下 `_history` 单调增长，且 `back()` 依赖 `history[length-2]`，历史越长 `back()` 的语义越不可控。静默：无报错，只是内存慢慢涨。
- **建议**：`this._historyLimit = clampNum(opts.historyLimit, 1, 1e4, 32);`，并把裁剪改为语义清晰的写法：
  ```ts
  if (this._history.length > keep) {
    this._history = [this._history[0], ...this._history.slice(this._history.length - (keep - 1))];
  }
  ```
  同时在 README 写明 `historyLimit` 的合法区间与"0 不代表不限制"。
- **影响面**：所有用 `GameFlow` 管理界面/关卡状态的下游；UI 栈越深增长越快。

### P1 · [perception] 抖动用裸 `Math.random` 参与警觉度累积，而注释声称"只影响观感"——与实际不符

- **位置**：`perception/Perception.ts:457`（`bestVisibility *= 1 - this._jitter + Math.random() * this._jitter * 2;`），注释在 `:452-456` 与 `:224-230`
- **现象**：注释写"抖动只影响观感，不需要可复现；而且消耗 rng 序列会打乱其他依赖 rng 的逻辑，让回放对不上"。但紧接下一行，`bestVisibility` 就进入 `st.alert = Math.min(this._threshold, st.alert + bestVisibility * gain * dt)`（`:465`），**直接决定警觉度累积速度和 `spotted` 事件的触发时机**。
- **证据**：行号推导链——`:457` 抖动 → `:465` `st.alert += bestVisibility * gain * dt` → `:475-478` `if (!st.aware && st.alert >= threshold) 触发 spotted`。实测层面：本批 `Math.random` 全库扫描仅此一处命中（`grep -rn "Math.random"` 在 21 个单元中只命中 `perception/Perception.ts:457`）。
- **后果**：两重问题。①**回放不一致**：警觉度是逻辑量不是观感量，`spotted` 时机不同会导致整场录像 diverge，而注释恰恰用"保证回放"来论证不用 rng——理由与效果相反（用注入 rng 才会让回放一致）。②**不可测试**：无法为"哨兵 3 秒发现玩家"写确定性断言。仓库里既有 `replay` 单元也有 `rng` 单元，回放一致性显然是被重视的目标。
- **建议**：改为注入 `IRandomSource`（默认给一个基于种子实例的实现），注释同步更正为"抖动影响 alert 累积，必须与回放一致，故走注入 rng"。若确实要保持不可复现，至少把抖动**只加在展示层**（如转身动画的随机延迟），不要进入 `alert` 数值。
- **影响面**：`replay` 单元、任何依赖 `spotted` 时机的战斗逻辑。

### P1 · [perception] `PerceptionSystem` 无 `destroy()`

- **位置**：`perception/Perception.ts:80-410`（类，无 destroy）
- **现象**：持有 `_perceivers` / `_targets` / `_pendingAlerts` 三个长期容器及 `onEvent` 回调，无卸载入口。
- **证据**：`grep -n "destroy" perception/Perception.ts` 无命中；`:310-336` 的 `_processPendingAlerts` 每帧遍历，`_pendingAlerts` 只按时间出队，若 `onEvent` 持续注册外部对象则引用长期存活。
- **后果**：换场景时若不手动 `removePerceiver` 逐个清理，整个感知图随系统对象一起滞留。`reset()`（`:390`）只清状态不清引用。
- **建议**：补 `destroy()`：`_perceivers.clear(); _targets.clear(); _pendingAlerts.length = 0; this._time = 0; this.onEvent = undefined;`

### P1 · [settings] `importState()` 对非法值静默跳过，返回值却暗示"导入成功"

- **位置**：`settings/Settings.ts:230-244`
  ```ts
  if (this._validate(d, v) === null) { this._values.set(k, v); }
  ```
  非法值既不写入，也不记录，也不报错。
- **证据**：实测（`verify/b3_v3.ts`）
  ```
  importState({volume:9999, quality:"ultra"}) 返回值 = []   ← 空数组，调用方以为一切正常
  实际 volume  = 50   (保持默认，玩家的 9999 被丢弃)
  实际 quality = high (玩家的 ultra 被丢弃)
  ```
  返回类型是 `string[]`（未定义的 key 列表），非法值根本不在返回结构里，调用方**没有任何渠道**知道导入失败。
- **后果**：玩家改了音量/画质，存盘再读档后被静默还原成默认值。表现为"设置存不住"，且因为不报错，常被误判成"存档没写成功"而去查存档系统。对比同批 `accessibility.importState`（`:179-201`）逐字段做类型+有限性校验，是本单元应当对齐的样板。
- **建议**：把"值非法"也纳入返回值（扩展为 `{ unknown: string[]; rejected: string[] }`），或至少对非法值回退到 `d.default` 并计入 rejected。`_validate` 已经算出了错误原因，直接丢掉很可惜。

### P1 · [settings] `importState()` 直接写 `_values`，绕过 `set()`，不触发 `onChange`

- **位置**：`settings/Settings.ts:236`（`this._values.set(k, v)`），对比 `:214-228` 的 `set()`
- **现象**：`set()` 会 `this._onChange?.(key, value, old)`，`importState()` 不会。
- **证据**：实测（`verify/b3_v3.ts`）
  ```
  set(80) 后 onChange 触发次数 = 1
  importState({volume:20}) 后 onChange 触发次数 = 1   ← 没有变成 2
  实际 volume = 20                                    ← 值确实改了
  ```
- **后果**：读档后音量数值已变成 20，但音频系统没收到通知 → **实际音量仍是 80**。UI 与真实状态不一致，且不报错。这是"值对了但通知没发"的静默不一致，比通知发了值没改更难查。
- **建议**：`importState()` 内部对每个成功写入的 key 调用 `this._onChange?.(k, v, old)`（或抽出 `_write()` 供 `set`/`importState` 共用）。

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

### P2 · [accessibility] （见正文）

- `shouldPlay()`（`:129-146`）的 switch 中 `shake/sway/flash` 与 `transition/autoCamera` 两支都 `return false`，可合并为 `return kind === 'particle' || kind === 'loopAnim';`
- 无 `destroy()`（持有 `onChange`）。
- 缺示例（任务书标注"示例：无"）——rule7 判据要求 README+测试+示例三件套。

---

### P2 · [anticheat] （见正文）

- `SpeedChecker` 无 `destroy()`（无外部资源，仅登记）。
- `_window.shift()` 为 O(n)，窗口通常很小，可接受。

---

### P2 · [buff] （见正文）

- `onChange()`（`:349-354`）只保留**单个**监听器（`this._onChange = fn` 直接赋值），第二次注册会静默顶掉第一次。若文档承诺多播，需改为数组 + 精确删除的取消函数（参照 `damage-pipeline` 的 `onResult`，它用 `indexOf` 精确删除，是本批的正面样板）。
- `clear()`（`:239-245`）只发一次 `'clear'`，不逐个发 `'remove'`，依赖方若只监听 `remove` 会漏更新。

---

### P2 · [camera] （见正文）

- `CameraShake.strengthScale` 的 setter 用 `clamp01`（`:276-279`），构造函数用 `?? 1` 不 clamp（`:267`）——同一字段两种收口口径，构造传 2.0 合法、之后再 set 会被压到 1。
- `_laFactor = opts.lookAheadFactor ?? ...`（`:174`）未用 `numOr` 收口，NaN 会穿透到 `targetLaX`（`clamp` 挡不住 NaN）。
- `_sources` 无数量上限，`punch()` 可无限 push（rule4：应可配 `maxSources`）。
- `CameraFollow` 自定 `interface Rect { minX, minY, maxX, maxY }`（`:58`）——字段语义见"存疑-2"。

---

### P2 · [collision] （见正文）

- `CollisionGrid._key`（`:843-845`，`((cx & 0xffff) << 16) | (cy & 0xffff)`）坐标超出 16 位会 wrap，不同格子共享 key → 只是**多报**候选（不漏报），配合后续精确检测不会出错，但会让查询变慢。建议注释标注坐标有效范围。
- `insert()`（`:859-877`）用 `arr.some(e => e.id === c.id)` 去重，是 O(格子数 × 桶内元素数)；大物体跨多格时开销明显。可改用"记录上次 cell 集合，增量 diff"。
- `query()` 复用 `_scratchSeen`（`:880-...`）：若调用方在遍历 `out` 期间再次调用 `query()`，`seen` 被 clear 会导致外层结果错乱（可重入性问题）。建议注释标注"不可重入"。
- 无 `destroy()`——但本单元以纯函数为主，`CollisionGrid` 只有 Map，GC 可回收，判 P2。
- **`satOverlap` 返回共享常量 `_satEmpty`**（`:248, 257`）：若调用方修改返回值会污染全局。当前调用方只读，风险低，建议加 `Object.freeze` 或注释。

---

### P2 · [difficulty] （见正文）

- `multiplier()` 无 `destroy()`；`onAdjust` 回调需外部清理。
- **存疑**：`CURRENCY_GAIN` 被放进 `PLAYER_FAVORING`（`:154-159`），意味着"玩家表现好 → 金币收益下降"。这是惩罚性 DDA，与"下调难度帮玩家"的直觉相反。若是有意为之（防刷）请补注释，否则建议移出。

---

### P2 · [gameflow] （见正文）

- `_findTransition()`（`:185-198`）第一个 `for` 循环里的 `t.to === this._current` 分支永不 `return`（内层还要求 `t.to === to`），整个第一循环等价于第二循环——冗余死代码，建议删除。
- `update(dt = 0)`（`:150`）用 `if (dt > 0)` 累加 `timeInState`，挡不住 `Infinity`（`Infinity > 0` 为真 → `timeInState` 一步变 Infinity）。建议改用 `safeDt(dt)`。对比同批 `tutorial`（`:211` 注释明确说明"为什么不是 dt > 0：Infinity > 0 为 true"），本单元漏了这条。

---

### P2 · [input] （见正文）

- `_maxQueue` 建议改 `clampNum(opts.maxQueue, 1, 64, 6)`；`_window`（`:109`）建议 `numOr`。

---

### P2 · [matchmaking] （见正文）

- `Matchmaker._balanceTeams()`（`matchmaking/Matchmaker.ts:545`）有一句**空的 if**：`if (ratings[hi] < ratings[lo]) {  }`。紧随其后的 `const strong = ratings[hi] >= ratings[lo] ? hi : lo;` 已经完整处理了大小关系，该 if 是残留死代码，直接删除。
- `TeamBalancer` 主分配循环（`:664-675`）：
  ```ts
  let best = 0;
  for (let t = 1; t < teamCount; t++) {
    if (sizes[t] + u.members.length > teamSize) continue;
    if (sizes[best] + u.members.length > teamSize || totals[t] < totals[best]) best = t;
  }
  ```
  当 `sizes[best]` 放不下时无条件改选 `t`（即使 `t` 更差），逻辑正确但可读性差；更重要的是**没有校验 `teams[0]` 初始可放**，极端 bin-packing 失败时会静默超载 `teams[0]`。建议分配后加断言 `sizes.every(s => s === teamSize)`。
- `packResult()`（`:837-859`）里 `void metric;`——`metric` 参数被完全忽略（`imbalance` 用了 metric，但最终结果没用）。若 `BalanceResult` 不打算暴露 metric 相关字段，建议从签名移除或真正使用它。
- `fixRoles()`（`:795-836`）末尾 `void teamSize;`——参数未使用，同样应移除或启用。
- `Lobby` / `Matchmaker` 均无 `destroy()`（无外部资源，P2）。

---

### P2 · [perception] （见正文）

- `:466-470` 的 `if (st.targetId !== bestTarget && st.targetId >= 0) { st.targetId = bestTarget; } else { st.targetId = bestTarget; }`——两支完全相同，是冗余死代码；且切换目标时不发 `lost` 事件（旧目标静默丢失）。
- `_pendingAlerts` 的 `delivered: Set<number>`（`:78`）只增不减，但 alert 出队后整体丢弃，随对象回收，不构成长期泄漏。

---

### P2 · [settings] （见正文）

- `snapshot()`（`:246-256`）的 `pendingRestart` 收集**所有** `needRestart` 的 key，不判断值是否真被改过 → UI 会列出一堆根本没动过的"待重启项"。
- 无 `destroy()`（持有 `onChange` 回调）。
- `cycle()`（`:110-118`）当前值不在 `options` 时 `indexOf` 得 -1，静默跳到 `opts[0]`——降级合理，但建议注释说明。

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

新建 `tests/run_phase10_w8.ts`，并**在文件内导出** `runPhase10W8Tests()`：

```ts
export function runPhase10W8Tests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（8 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W8.md`，每条一行：

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
| **文件命名** | `run_phase10_w8.ts` / `result_W8.md`，带你的窗口号，避免撞名 |

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
