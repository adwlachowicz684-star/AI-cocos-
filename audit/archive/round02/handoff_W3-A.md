# 精审返工任务书 · 窗口 W3-A（第 A 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W3-A 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **16**（P1 10 / P2 6） |
| 单元 | **6** 个 |
| 来源批次 | batch2、batch3 |
| 所属组 | **第 A 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W3-B**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_A.md` 验收 **W3-B**。

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

### 3.1 你的单元（6 个，与其它 15 个窗口零重叠）

```
camera  interact  perception  score  settings  tween
```

---


## 【P1】先做这批

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

### P1 · [interact] `Interactable` 接口没有 `pos` 字段，实现却靠双重强转去取——类型系统与文档对不上

- **位置**：`interact/Interact.ts:162`（`const pos = (item as unknown as { pos?: InteractContext['pos'] }).pos;`），接口定义 L6-26 无 `pos`
- **现象**：按接口类型写 `register({ id, data, radius })` 完全合法，此时 `evaluate` 走 L165-167 分支，返回 `distance: 0, alignment: 1, inRange: true`。
- **证据**：`verify/b2_v4.ts` §O 实测：
  ```
  相距无穷远（接口里没有 pos 字段）→ 候选数 = 1  distance = 0  inRange = true  valid = true
  ```
- **后果**：README §L61 说明"不提供 pos 时视为全局可交互（UI 按钮等）"，所以**运行时行为符合文档**；但 README §L19 的示例 `sys.register({ id:'chest', data:{...}, radius:3, pos:{x,y} })` 在 `strict` 下会因多余属性检查编译失败——用户必须自己 `as any` 才能照文档用。真正的风险是：按接口实现的调用方（不传 pos）会得到一个"永远可交互"的物体，而这在类型层面完全看不出来。
- **建议**：把 `pos?: { x: number; y: number; z?: number }` 正式加进 `Interactable`，去掉 L162 的双重强转。
- **影响面**：无下游（零依赖单元），但影响所有接入方的写法。

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

### P1 · [score] 指标被设成 NaN 后总分变 NaN，静默评为最低档

- **位置**：`score/ScoreSystem.ts:124-129`（`set` 无校验）→ L238（`inverseLerp`）→ L242/244（`clamp01(t) * 100`）→ L209-213（`grade()` 的 `s >= g.minScore`）
- **证据**：`verify/b2_v4.ts` §M 实测：`total = NaN  grade = D`（无异常、无警告）。
- **后果**：一次 `add('kills', NaN)`（例如从 UI/网络拿到的未初始化值）之后，玩家结算永远是最低档。因为 `grade()` 的兜底是"返回最后一档"，看起来"评级功能正常"，实际是 NaN 短路。
- **建议**：`set/add` 入口 `if (!Number.isFinite(value)) throw`（或忽略并 warn），并在 `total()` 里对 NaN 做兜底上报。

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

### P1 · [tween] `ease()` 用 Record 查表，原型键被当成缓动函数（已知 easing() 原型污染的新实例）

- **位置**：`tween/Tween.ts:41-45`（`const fn = Easing[name as EasingName]; if (!fn) { ... throw }`）
- **现象**：缓动名来自外部输入（配置表/存档）时，`Easing['toString']` 拿到的是 `Object.prototype.toString`，truthy 通过校验。
- **证据**：`verify/b2_v2.ts` §3 实测：
  ```
  Easing['toString'] = function toString() { [native code] }
  未抛错；onUpdate 收到 = "[object Object]"  类型 = string
  ```
- **后果**：配置里缓动名拼错成 `toString`/`valueOf`/`constructor` 时，动画进度变成字符串而不是数字，`onUpdate` 里做算术立刻得到 NaN——NaN 会一路污染到坐标，表现为"物体瞬间消失/卡死"，且不会有任何报错。
- **建议**：用 `Object.prototype.hasOwnProperty.call(Easing, name)` 或把 `Easing` 换成 `Map`。
- **影响面**：与已审结 `_core` 的 `easing()` 修复同源，属同类写法在本批的唯一新实例（另见 runscope P1-22）。


## 【P2】P1 完成后再做

### P2 · [camera] （见正文）

- `CameraShake.strengthScale` 的 setter 用 `clamp01`（`:276-279`），构造函数用 `?? 1` 不 clamp（`:267`）——同一字段两种收口口径，构造传 2.0 合法、之后再 set 会被压到 1。
- `_laFactor = opts.lookAheadFactor ?? ...`（`:174`）未用 `numOr` 收口，NaN 会穿透到 `targetLaX`（`clamp` 挡不住 NaN）。
- `_sources` 无数量上限，`punch()` 可无限 push（rule4：应可配 `maxSources`）。
- `CameraFollow` 自定 `interface Rect { minX, minY, maxX, maxY }`（`:58`）——字段语义见"存疑-2"。

---

### P2 · [interact] （见正文）

- **I2** `clear()`（L116-120）与 `resetAll()`（L234-240）清空焦点但不触发 `onFocusChange`：UI 上的交互提示不会消失。
- **I3** `candidates()` 排序比较函数在"相等"时返回 1 而非 0（L196）：排序不稳定，同距离物体的顺序不确定。
- **I4** `setDisabled` 用 `(it as { disabled?: boolean }).disabled = disabled`（L109）写入 readonly 字段：对 `Object.freeze` 的对象在严格模式下会抛 TypeError。
- **I5** 本地 `clamp`（L294-296）与 `_core.clamp` 重复实现（本单元为零依赖，可接受，建议注明）。
- **I6** 无 `destroy()`（`clear()` 不够，需清 `_items` 持有的外部对象）。

---

### P2 · [perception] （见正文）

- `:466-470` 的 `if (st.targetId !== bestTarget && st.targetId >= 0) { st.targetId = bestTarget; } else { st.targetId = bestTarget; }`——两支完全相同，是冗余死代码；且切换目标时不发 `lost` 事件（旧目标静默丢失）。
- `_pendingAlerts` 的 `delivered: Set<number>`（`:78`）只增不减，但 alert 出队后整体丢弃，随对象回收，不构成长期泄漏。

---

### P2 · [score] （见正文）

- **Sc2** `_scoreOne`（L241-245）的 `higher-better` 与 `lower-better` 两个分支代码完全相同（`clamp01(t) * 100`）：因为方向已由 `zero/par` 的大小关系决定（构造时 L91-100 有校验），分支是冗余的，建议合并并加注释说明"方向隐含在 zero/par 中"。
- **Sc3** `StarRating(stars)`（L301）用 `Math.max(1, stars)`：`stars` 为 NaN 时 → NaN → `addCondition` 的 `length >= NaN` 恒 false → 可无限加条件 → 星级可以超过 max。
- **Sc4** `weighted-with-floor` 模式（L196-203）在有指标低于 floor 时直接返回 `Math.min(avg, 最后一档 minScore)`（通常是 0）：一票否决很严厉，README 需写明。
- **Sc5** 无 `destroy()`（有 `reset()`）。

---

### P2 · [settings] （见正文）

- `snapshot()`（`:246-256`）的 `pendingRestart` 收集**所有** `needRestart` 的 key，不判断值是否真被改过 → UI 会列出一堆根本没动过的"待重启项"。
- 无 `destroy()`（持有 `onChange` 回调）。
- `cycle()`（`:110-118`）当前值不在 `options` 时 `indexOf` 得 -1，静默跳到 `opts[0]`——降级合理，但建议注释说明。

---

### P2 · [tween] （见正文）

- **T2** `TweenRunner.completeAll()`（L224-228）只 complete `_tweens`，`_pending` 里的被直接丢弃：实测刚 `add` 的 tween 的 `onComplete` **不会**被调用（"completeAll"名不副实）。
- **T3** `TweenRunner.update` 每帧 `slice()`（L200）：热路径分配。
- **T4** `TweenRunner.delay()` 用 `new Tween(0.0001)`（L189）：魔法数字，建议走可配置的最小步长。

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

新建 `tests/run_phase10_w3a.ts`，并**在文件内导出** `runPhase10W3ATests()`：

```ts
export function runPhase10W3ATests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W3-A.md`，每条一行：

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
| **文件命名** | `run_phase10_w3a.ts` / `result_W3-A.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 A 组**。修完之后，按 `audit/review_A.md` 验收 **W3-B**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W3-A.md`，
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
