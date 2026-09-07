# 精审返工任务书 · 窗口 A

> 本文件是**第二次精审 273 条**中，分配给窗口 A 的剩余条目。
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

## 3. 本批清单（90 条：P1 {n_p1} / P2 {n_p2}）

覆盖批次：batch4 / batch3。涉及 35 个单元。
**本批单元与其它两个窗口完全不重叠**（已核验：无单元跨批次）。

### 单元清单

```
accessibility  achievement  anticheat  attribute  audio  buff  camera  collision  command  condition  curve  cutscene  debug-console  di  difficulty  expression  gameflow  hitbox  indicator  input  matchmaking  minimap  noise  pathfinding  perception  save  settings  skill-caster  skill-player  skill-variant  social  spatial  subtitle  telegraph  timeutil
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

### P1 · [achievement] `importState()` 是追加而非替换，重复读档会叠加幽灵解锁

- **位置**：`achievement/Achievement.ts:229-233`
- **现象**：`for (const id of ids) if (this._defs.has(id)) this._unlocked.add(id);` —— 只 add，从不 clear。
- **证据**：实测（`b4_v3.ts`）：`importState(['a'])` 后再 `importState(['b'])` → `unlockedCount === 2`。存档里第 2 个槽位只写了 1 个成就，读出来却有 2 个。
- **后果**：换槽位 / 重连后重新载入存档，旧槽位的解锁状态被带进新槽位。玩家看到"没达成的成就已点亮"，且 `points` 虚高。不报错，只在数值上体现，排查时没人会怀疑 importState。
- **建议**：函数开头 `this._unlocked.clear(); this._lastProgress.clear();`，或另开 `mergeState()` 表达追加语义。
- **影响面**：`save` 单元（本批）与本单元组合使用时必踩；`exportState/importState` 是成对 API，任何存档接入方都会用到。

### P1 · [achievement] `revoke()` 后 `_lastProgress` 未清，进度回调永久丢失一次

- **位置**：`achievement/Achievement.ts:213-220`（`revoke` 与 `reset` 不对称：`reset` 清了 `_lastProgress`，`revoke` 没清）
- **现象**：`_progressOf` 的去重靠 `last !== p.current`，revoke 后 `current` 没变，`check()` 判定"进度没变化"，跳过 `onProgress`。
- **证据**：实测：注册 onProgress → `check()`（回调 1 次）→ `revoke('a')` → `check()` → 回调仍为 1 次（期望 2）。
- **后果**：GM 工具 / 测试里撤销成就后重新观察，UI 进度条不再更新，看起来像"回调丢了"。只在 revoke 之后发生，极难关联。
- **建议**：`revoke` 里补 `this._lastProgress.delete(id);`。

### P1 · [achievement] `target` 非有限值时进度变 NaN，且零目标成就瞬间达成

- **位置**：`achievement/Achievement.ts:238, 251-252`（`const target = def.target ?? 1;` 未做有限性检查；`Math.min(target, current)` 对 NaN 返回 NaN）
- **证据**：实测：`new Achievement({defs:[{id:'x',name:'x',target:NaN,progress:()=>5}]}).progressOf('x',...).current === NaN`。`target=0` 时 `Math.min(0,5)=0` 且 `done = 0>=0 = true`，零目标成就瞬间达成。
- **后果**：配置表里 target 漏填（undefined→1）或填了 0/NaN，成就进度条显示 NaN 或直接秒解锁，无异常抛出。
- **建议**：构造期或 `_progressOf` 入口用 `clampNum(def.target, 1, 1e12, 1)` 收口。

### P1 · [achievement] `unlock()` 不校验 `requires`，可绕过前置链

- **位置**：`achievement/Achievement.ts:199-210`（对比 `checkOne` 在 170-171 行显式校验了 `requirementsMet`）
- **证据**：实测：`A`（无前置）、`B`（requires:['A']），直接 `unlock('b')` 返回 `true`，`isUnlocked('b') === true`，而 A 未解锁。
- **后果**：后台补发奖励、GM 命令调 `unlock()` 会产出违反依赖图的存档，后续 `requirementsMet()` 对 A 的判定仍为 false，导致 UI 出现"已解锁但前置未完成"的矛盾态。
- **建议**：`unlock()` 增加 `bypassRequires` 开关，默认走 `requirementsMet` 校验。

---

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

### P1 · [attribute] `clearModifiers()` 不触发 `onChange`，UI 在"移除 buff"时不刷新

- **位置**：`attribute/AttributeSet.ts:188-202`（两条路径都只 `_bump()`，没有 `_notifyIf`；对比 `removeWhere` 在 179-183 行正确调用了 `_notifyIf`）
- **证据**：实测（`b4_v1.ts`）：注册 onChange 计数 → `add()` → 计数 1 → `clearModifiers('atk')` → 计数仍为 **1** → `clearModifiers()` → 计数仍为 **1**。
- **后果**：`removeBySource` / `clearByTag` 走 `removeWhere`，有通知；而 `clearModifiers` 没有。同一语义的两个 API 行为不一致，调用方用 `clearModifiers` 清 debuff 时，血条/面板停在旧数值上，直到下一次别的操作才刷新。这正是 C 类"契约不一致"。
- **建议**：`clearModifiers(attr)` 分支补 `this._notifyIf(attr, old)`；无参分支对所有受影响属性逐个通知（注意兼容 `suspendNotify`）。

### P1 · [attribute] `override` 与 `add` 的叠加顺序写成了"三元左右相等"的死代码

- **位置**：`attribute/AttributeSet.ts:269`（`v = overridden ? v + add : v + add;`）
- **证据**：代码直读 + 实测：base=10、override=100、add=50 → `get('atk') === 150`（override 之后仍叠加 add）。三元两个分支完全相同，说明作者在这里犹豫过但没做区分，留下误导性代码。
- **后果**：维护者读到这行会以为存在"override 时是否忽略 add"的分支逻辑（多数属性系统的惯例是 override 定终值），实际没有。后续若要改语义，这行是必错点。
- **建议**：二选一后写清楚：若要"override 定终值"改为 `v = overridden ? v : v + add;`；若要"override 后仍叠加 add"直接写 `v = v + add;` 并在 README 明确。（语义本身见「存疑-1」）

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

### P1 · [command] `rollback()` 里的空 catch 吞掉 undo 异常

- **位置**：`command/CommandStack.ts:206-212`（`try { buffer[i].undo(); } catch { }`）
- **证据**：代码直读（扫描命中「空 catch ×1」）。
- **后果**：回滚失败（例如 undo 依赖的资源已释放）时完全无声，事务回滚后状态可能仍是错的，但调用方拿到的是"回滚成功"的返回。这正是 A 类清单里的"空 catch / 静默降级"。
- **建议**：至少 `console.error`，或收集到 `rollback(): { rolledBack: number; errors: Error[] }` 的返回里。

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

### P1 · [curve] `evaluate(NaN)` 返回 NaN 且无守卫，一个 NaN 帧污染整条曲线

- **位置**：`curve/Curve.ts:90`（`Math.min(Math.max(time, keys[0].time), keys[keys.length-1].time)`）
- **现象**：`clamp` 系列对 NaN 一律返回 NaN（`_core` 已确认：`clamp(NaN,0,1) === NaN`）。本单元在 `addKey` 里对关键帧做了 `Number.isFinite` 校验（45 行），却在 `evaluate` 的入参上漏了。
- **证据**：实测：`new Curve([{time:0,value:0},{time:10,value:10}]).evaluate(NaN) === NaN`。对照 `addKey(NaN, 0)` 会正常抛异常。
- **后果**：上游时间轴一旦产出 NaN（例如除零的 `t/duration`），曲线返回值变 NaN，接着污染坐标/伤害值，**一个 NaN 帧让后续所有帧永久为 NaN**，与本库最痛恨的 A 类静默错误完全同构。
- **建议**：`evaluate` 入口加 `if (!Number.isFinite(time)) return keys[0].value;`。

### P1 · [curve] `minValue` / `maxValue` 在空曲线上返回 ∓Infinity

- **位置**：`curve/Curve.ts:76-82`（`reduce(..., Infinity)` / `reduce(..., -Infinity)`）
- **证据**：实测：`new Curve().minValue === Infinity`、`maxValue === -Infinity`。
- **后果**：调用方拿 `minValue/maxValue` 做归一化（`(v-min)/(max-min)`）时得到 `0/0 = NaN`；拿它们做 UI 坐标轴范围时得到 Infinity 轴。空曲线在"配置未加载完就先建对象"的场景很常见，且不报错。
- **建议**：`if (this._keys.length === 0) return 0;`，并把返回类型标注为 `number | undefined` 或明确文档化。

### P1 · [curve] `integrate(Infinity)` 死循环，`integrate(0)` 静默返回 0

- **位置**：`curve/Curve.ts:117-127`（`samples` 未做有限性与上界收口）
- **证据**：实测（`b4_v4.ts`，`timeout 6` 包裹）：`integrate(Infinity)` → **6 秒内无输出，判定为挂起**；`integrate(0)` → `0`（`step = (e-s)/0 = Infinity`，循环体执行 0 次）。
- **后果**：`samples` 若来自配置或上游计算（如 `duration / dt` 且 dt 为 0 → Infinity），直接冻结主线程。这是"配置驱动"铁律下最典型的失控输入。
- **建议**：`const n = clampNum(samples, 1, 1e5, 64);` 收口。

### P1 · [cutscene] `Timeline.with()` 与 README 不符：实测是"紧接播放"而非"与上一个同时开始"

- **位置**：`cutscene/Cutscene.ts:345-360`（`with` 的 `start = this._lastStart()` 返回 `this._cursor`，而 `add` 已经把 cursor 推进到 `start + duration`）
- **证据**：实测（`b4_v2.ts`）：`tl.add('a', 1000); tl.with('b', 1000);` → `build().steps` 的 start 为 **`a:0, b:1000`**。README 第 136 行写的是「`with(id, dur, data)` 并行添加（与上一个同时开始，**总时长取 max**）」，第 141-142 行还专门强调了这个语义。
- **后果**：按 README 编排"音效与动画同时起"的演出，实际变成串行的两段，整个演出时长翻倍、节奏全错。因为 `with` 的名字和文档都指向并行，调用方不会去验证 start 值。
- **建议**：`with` 应记录上一条 step 的 start（额外存 `_lastAddedStart`）：`const start = this._lastAddedStart;`，然后 `this._cursor = Math.max(this._cursor, start + duration);`（后半句现有代码已正确）。修好后 README 才成立。

### P1 · [cutscene] `update(dtMs)` 无 dt 守卫，NaN / 负 dt 静默丢弃时间

- **位置**：`cutscene/Cutscene.ts:132-193`（入口无 `safeDt`；`remaining = dtMs` 直接参与后续比较）
- **证据**：实测（`b4_v3.ts`）：`update(NaN)` → `time` 保持 **0**、`state` 为 `playing`、返回 0 个 cut；`update(-50)` → 同样停在 0。对照 `update(16)` → `time === 16`。另：`b4_v2.ts` 里 `update(NaN)` 之后再正常跑 10 帧 16ms，累计只到 **112** 而非 160，说明 NaN 帧还额外造成时间损失。
- **后果**：某一帧 dt 异常时演出"卡一下"且不报错；异常 dt 连续出现时演出永久停滞但状态仍是 `playing`，上层"等演出结束"的等待逻辑永久挂起。
- **建议**：入口加 `if (!safeDt(dtMs)) return [];`

### P1 · [debug-console] `execute()` 把命令内部异常 **rethrow 给调用方**，与"控制台捕获一切"的定位相反

- **位置**：`debug-console/DebugConsole.ts:247-257`（`catch` 里对 `CommandError` 友好输出，对其他异常输出 `✗ 命令内部错误：<堆栈>` 然后 `throw e`）
- **证据**：实测（`b4_v5.ts`）：注册 `run: () => { throw new Error('内部炸了') }` → `dc.execute('boom')` **向外抛出异常**（调用方必须 try/catch，否则崩在输入处理链路里）。
- **后果**：控制台是"运行时调试"的最后一道防线，本应吞掉一切异常并转成一行红字。现在它把异常抛回给 UI 的输入事件处理器 —— 一行打错的命令就能让整个输入系统崩溃，而此时错误已经被打印过一次（重复暴露）。
- **建议**：去掉 `throw e`，或增加 `opts.rethrow?: boolean`（默认 false）。

### P1 · [debug-console] `_coerce` 的 `int` 用 `Number.isInteger(Number(token))`，空串/空白被当成 0

- **位置**：`debug-console/DebugConsole.ts:442-455`（`const n = Number(token);` —— `Number('') === 0`、`Number(' ') === 0`，且 `Number.isInteger(0) === true`）
- **证据**：代码推导 + 与第 2 节「`Number(null)/''/[]` 当成 0」同类。虽然 `tokenize` 会过滤空白，但引号内空串（`""`）会作为合法 token 传入。
- **后果**：输入 `set_hp ""` 得到 0 而不是"参数错误"，静默把血量设为 0。调试命令的破坏力因此被放大。
- **建议**：`if (token.trim() === '') throw new CommandError(...)`。

### P1 · [di] `register(..., {override:true})` 覆盖后，旧单例**不会被 destroy**

- **位置**：`di/DIContainer.ts:33-44`（`this._singletons.delete(key)` 只是丢弃引用）+ `57-74`（disposer 闭包在销毁时 `this._singletons.get(key)`）
- **现象**：`disposable()` 把 disposer 压进 `_disposers` 数组，数组按**注册顺序**而非 key 索引；覆盖注册同一 key 时，旧 disposer 仍在数组里，销毁时它 `get(key)` 拿到的是被 `register` 删掉后又重新写入的**新**实例（或空），旧实例永远拿不到引用。
- **证据**：实测（`b4_v1.ts`）：注册 `a`（destroy 计数 +1）→ `get('a')` → 以 `override:true` 重新注册 `a`（destroy 计数 +10）→ `get('a')` → `destroy()` → 计数为 **10**（只有新 disposer 生效，旧实例的 +1 从未发生）。
- **后果**：热重载 / 测试里覆盖注册一个持有事件监听或定时器的服务，旧实例连同它的监听一起泄漏，且**销毁阶段看起来是正常执行的**（还调了一次 destroy），最有欺骗性。
- **建议**：`_disposers` 改为 `Map<string, () => void>`，`register` 时若 key 已存在且有 disposer，先执行旧 disposer 再覆盖。

### P1 · [di] `fork()` 不复制 `_disposers`，子容器 destroy 时父注册的可销毁服务一个都不销毁

- **位置**：`di/DIContainer.ts:125-130`（只复制 `_regs` 和 `_singletons`）
- **证据**：实测（`b4_v3.ts`）：父容器 `disposable('svc', ...)` → `fork('child')` → `child.get('svc')` → `child.destroy()` → 销毁计数为 **0**（期望 1）。
- **后果**：按作用域 fork（关卡容器 / 战斗容器）是 DI 的标准用法，子容器销毁时本应连带销毁它现场创建的单例，结果全部泄漏。README 没有提示这个差异。
- **建议**：`fork` 同时复制 disposer 引用，或在 README 明确"fork 出的容器不继承销毁责任"，二选一但必须明确。

### P1 · [di] `disposable()` 配 `lifetime:'transient'` 时永不销毁，且无任何提示

- **位置**：`di/DIContainer.ts:57-74`（`if ((opts.lifetime ?? 'singleton') === 'singleton')` 才压 disposer）
- **证据**：实测（`b4_v5.ts`）：`disposable('t', ..., {lifetime:'transient'})` → `get` 三次 → `destroy()` → 销毁计数 **0**。README 第 59 行把 `disposable` 描述为"注册带 destroy() 的**单例**"。
- **后果**：调用方写了 `disposable(..., {lifetime:'transient'})`，心理预期是"每次取的临时对象也会被回收"，实际容器完全不持有 transient 实例，销毁阶段无从下手。这是**配置组合静默失效**，编译期和运行时都不报错。
- **建议**：要么遇到 transient 直接抛错（拒绝无效组合），要么改为记录每次创建的 transient 实例并在 destroy 时统一销毁。

### P1 · [expression] 三元表达式的分支里写负数字面量会直接解析失败

- **位置**：`expression/Expression.ts:191-203`（`isUnary` 的判定只认 `prev.type === 'op' | 'lparen' | 'comma'`）
- **现象**：`?` 和 `:` 后面的 `-` 不在"允许一元负号"的前导集合里，被当成二元运算符，走到 `parsePrimary` 抛"意外的符号 -"。
- **证据**：实测（`b4_v1.ts`）：
  - `1 ? -5 : -7` → **`[Expression] 意外的符号 "-"（位置 4）`**
  - `1 ? 5 : 7` → `5`（正常）
  - `0 ? -5 : -7` → 同样抛错
  - `hp > 0 ? -dmg : 0` → 同样抛错（配置里写"治疗/扣血"这类公式时必然踩到）
- **后果**：配置驱动的公式里，只要三元分支出现负值（扣血、减速、反向修正）就在**构造期抛错**。抛错发生在 `new Expression()`，表层现象是"配了一张表，模块初始化失败"，而错误信息指向 `-` 的位置，与"三元"毫无字面关联，排查成本高。
- **建议**：`isUnary` 的前导集合加上 `question` 和 `colon` 两种 token 类型。

### P1 · [expression] `BUILTIN` 是裸 `Record<string, Function>`，按键查表命中 `Object.prototype`

- **位置**：`expression/Expression.ts:53-68, 424-429`（`const fn = BUILTIN[node.name]`）
- **现象**：`BUILTIN['toString']` 取到 `Object.prototype.toString`（一个函数），`!fn` 判定通过，于是"成功调用"了它。
- **证据**：实测：`new Expression('toString()').evaluate({})` → 抛 `[Expression] 函数 toString() 的结果不是有限数：[object Undefined]`。异常信息里出现 `[object Undefined]`，正是 `Object.prototype.toString.call(undefined)` 的产物。
- **后果**：**这是第 2 节点名过的 `easing()` 原型链污染在本批的新实例**。表达式名字来自配置（外部输入），一旦配置里出现 `constructor` / `toString` / `valueOf`，行为不可预测且错误信息完全指错方向。本例最终抛了错（结果不是数字），但 `hasOwnProperty` 这类返回 boolean 的成员会被 `Number()` 转成数字继续算，那才是真正的静默错误。
- **建议**：查表改为 `Object.prototype.hasOwnProperty.call(BUILTIN, node.name)`，或把 `BUILTIN` 换成 `Map` / `Object.create(null)`。

### P1 · [expression] 非 strict 模式下 `null` / `[]` / 未定义变量一律被当成 0

- **位置**：`expression/Expression.ts:398-407`（`cur === undefined` → 返回 0；`Number(cur)` 对 `null` 得 0、对 `[]` 得 0）
- **证据**：实测（`b4_v5.ts`）：
  - `missingVar + 1` → `1`（未定义变量当 0）
  - `arr + 1`（`arr = []`）→ `1`
  - `n + 1`（`n = null`）→ `1`
  - 另：`toString`（命中原型方法）→ `0`
- **后果**：**第 2 节「clampNum / numOr 把 null/''/[] 当成 0」在本批的新实例**。配置里的公式拼错变量名时，结果是"算出来一个偏小的数字"而不是报错，伤害公式、掉落权重静默偏低。`evaluateStrict()` 已提供正确行为，但默认入口是宽松的那个。
- **建议**：至少把"未定义变量"与"值不是有限数"区分对待：未定义变量在非 strict 下也应 warn 一次，不要与"值确为 0"混淆。

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

### P1 · [hitbox] 外部直接改 `box.x/y` 后 `remove()` 留下僵尸条目（格子里的 id 永不清除）

- **位置**：`hitbox/Hitbox.ts:435-447`（`remove` 按**当前**坐标算 `_cellsFor` 去删格子；若调用方绕过 `update` 直接改坐标，删的是新位置的格，旧位置的格里的 id 留着）
- **证据**：实测（`b4_v2.ts`）：`add` 一个 box 后直接改 `b.x=100; b.y=100`（绕过 `update`）→ `remove('z')` → 遍历 `_cells`，仍有 **4 个格子**持有 id `'z'`，而 `_boxes` 里已经没有它。
- **后果**：`query` 遍历到这些格子时 `this._boxes.get(id)` 返回 `undefined`，被 `if (!b || ...) continue` 挡住，**不会崩但持续浪费遍历**；更糟的是这些 Set 不会被 `set.size === 0` 回收，形成**与第 2 节「SpatialHash 空桶不回收」同构的泄漏**。因为 `Hitbox` 是可变对象（`x`/`y`/`rotation` 都是可写字段），调用方直接改坐标是**被 API 允许**的写法。
- **建议**：额外维护 `Map<id, number[]>` 记录每个 id 当前占用的格子，`remove` 时按记录清理。

### P1 · [indicator] `compute()` 返回的中心与 `centerFor()` 返回的中心不一致（同一套配置两个答案）

- **位置**：`indicator/SkillIndicator.ts:168-184`（`aimed` 分支：中心 = 施法者 + 位移向量，即**瞄准点/射程末端**）+ `272-285`（`centerFor`：中心 = 施法者 + `length/2` 方向偏移，即**线段中点**）
- **证据**：实测（`b4_v2.ts`）：`{kind:'line', length:6, width:1, range:10, aimed:true}`，面向 0°、瞄准 (6,0)：
  - `compute(0,0,0, 6,0).x === 6`（射程末端）
  - `centerFor(0,0,0) === {x:3, y:0}`（半长处）
- **后果**：对 `line`/`direction` 这类"从施法者延伸出去"的形状，两个 API 给出的中心差了整整 `length/2`。调用方若用 `centerFor` 画指示器、用 `compute` 做判定（或反之），**画的圈和实际打到的位置完全错开**。README 没有说明二者语义差异，是典型的"同义不同值"。
- **建议**：统一为同一语义（建议都以"形状几何中心"为准），并让 `compute` 内部调用 `centerFor`；`aimX/aimY` 字段保留瞄准点语义即可。

### P1 · [minimap] `FogMap.reveal(world, radius)` 用 **X 轴**尺寸去换算 **Y 轴**的格子跨度，非正方形世界迷雾形状错误

- **位置**：`minimap/Minimap.ts:328`（`const step = (radius / this._worldSize.x) * this._res;` —— 只用了 `worldSize.x`）+ `332-338`（`dy` 与 `dx` 用同一个 `cells` 跨度）
- **现象**：格子在 X/Y 两个方向的"世界单位/格"不同（非正方形世界），但代码统一按 X 方向的密度算 Y 方向该扩多少格。
- **证据**：实测（`b4_v2.ts`）：
  - 世界 `1000 × 100`、分辨率 100：每格 = 世界 `10 × 1`。`reveal({x:500,y:50}, 100)` 半径 100 世界单位 → Y 方向本应覆盖全部 100 格（半径 100 ≥ 世界高度 100），实测只揭开 **21 格**（`step = 100/1000*100 = 10` 格）。
  - 对照组：世界 `100 × 100`、`reveal({x:50,y:50}, 10)` → 揭开 **21 格**（= 2×10+1，正确）。
- **后果**：**窄长地图（绝大多数横版/长条关卡）的迷雾严重揭不全**：玩家走过的地方在小地图上仍是黑的，`coverage` 统计也偏小，进而影响"探索度 X%"这类进度显示。全程静默，且用正方形地图自测时完全测不出来（对照组成立只是巧合）。
- **建议**：分别计算 `cellsX = Math.ceil((radius / worldSize.x) * res)`、`cellsY = Math.ceil((radius / worldSize.y) * res)` 再双重循环；更严谨的做法是按真实圆形判定 `((dx*cellW)² + (dy*cellH)² <= r²)`。

### P1 · [minimap] `scale` 为 0 时 `minimapToWorld` 除零，返回 NaN 坐标

- **位置**：`minimap/Minimap.ts:160-161, 168`（`(m.x - viewSize.x/2) / this._scale`）
- **现象**：`scale: 0` 是合法配置输入（"不缩放"），但构造期无校验；`_autoScale` 在 `mode==='follow'` 时返回硬编码 1，只有显式传 0 才触发除零。
- **证据**：实测：`new Minimap({..., mode:'follow', scale: 0}).minimapToWorld({x:10,y:10}, {x:0,y:0})` → `{x: NaN, y: NaN}`。
- **后果**：小地图点击定位（点哪走哪）返回 NaN 坐标，角色瞬移到 NaN 或不动，且不报错。
- **建议**：构造期加下界 `Math.max(1e-6, ...)`，或显式拒绝 `scale <= 0`。

### P1 · [noise] 非有限 seed 静默退化为 seed 0，所有"随机地图"变成同一张

- **位置**：`noise/Noise.ts:7-16`（`mulberry32`：`let a = seed >>> 0`，`NaN >>> 0 === 0`、`undefined >>> 0 === 0`）+ `218-228`、`339-348`、`455-463`
- **证据**：实测（`b4_v1.ts`）：`new Noise(NaN).noise2(1.5,2.5) === new Noise(0).noise2(1.5,2.5)` → **true**；`new ValueNoise(NaN).noise2D(1.3,2.7) === new ValueNoise(0).noise2D(1.3,2.7)` → **true**。
- **后果**：seed 来自配置、存档或字符串 hash 时一旦为 NaN/undefined，所有地图/怪物分布/掉落抖动全部退化成 seed 0 的同一份结果。表现为"每次进游戏地形一模一样，但代码里明明传了不同 seed"。
- **建议**：构造函数入口 `clampNum(seed, 0, 0xffffffff, 0)` 收口，或对非有限值抛错（与"确定性"这一核心卖点相称）。

### P1 · [noise] `fbm2D` / `ridged2D` 的 `octaves` 为 Infinity 时死循环

- **位置**：`noise/Noise.ts:279-297`（`for (let i = 0; i < octaves; i++)`，`octaves = opts.octaves ?? 4` 无收口）、`307-323`（ridged 同）
- **证据**：实测（`b4_v4.ts`，`timeout 6`）：`fbm2D({noise2D:()=>1}, 1, 1, {octaves: Infinity})` → **挂起**；`ridged2D(..., {octaves: Infinity})` → **挂起**。
- **后果**：`octaves` 来自配置表时（例如 `1/dt` 的派生值，或 JSON 里写了 `1e999`）主线程直接冻结。属于 E 类"无限循环"清单项的典型命中。
- **建议**：`const octaves = clampNum(opts.octaves, 1, 32, 4);`

### P1 · [noise] `fbm2D` 对 `octaves=NaN`、`octaves=-1`、`lacunarity=0` 无校验，静默返回 0 或退化

- **位置**：`noise/Noise.ts:279-297`（`i < NaN` 立即为 false → 循环 0 次 → `maxValue = 0` → 第 297 行 `return maxValue > 0 ? ... : 0`）
- **证据**：实测：`fbm(1,1,NaN) → 0`、`fbm(1,1,-1) → 0`、`fbm(1,1,4,0)`（lacunarity=0）→ `0.2544…`（频率逐层归零，退化为同一层重复采样）。
- **后果**：地形高度全 0（一片平原）或出现诡异的重复纹理，且**完全不报错**。与 P1-16 组合时表现为"配了地形生成器，出来的图是空的"。
- **建议**：`octaves` / `lacunarity` / `persistence` 统一用 `clampNum` 收口（lacunarity 下界 > 0、persistence ∈ (0,1]）。

### P1 · [noise] `islandMask(1, 1)` 返回 NaN

- **位置**：`noise/Noise.ts:429-443`（`cx = (width-1)/2 = 0` → `(x-cx)/cx = 0/0 = NaN` → `Math.min(1, NaN) = NaN`）
- **证据**：实测：`islandMask(1,1)[0] === NaN`；`islandMask(3,3)[0] === 0`（正常）。
- **后果**：width 或 height 为 1 时（边界尺寸、单列采样）整张 mask 变 NaN，再与高度图相乘 → 全图 NaN。静默。
- **建议**：`const cx = Math.max(1, (width - 1) / 2);`（cy 同理）。

### P1 · [pathfinding] `findPath` 只校验终点可走，不校验**起点**可走，起点在墙里照样返回路径

- **位置**：`pathfinding/GridGraph.ts:161-172`（`if (!grid.isWalkable(goal.x, goal.y)) return null;` 之后对 start 没有任何检查）
- **证据**：实测（`b4_v2.ts`）：5×5 网格，把 (0,0) 设为不可走，`findPath(g, {x:0,y:0}, {x:4,y:4})` → 返回 **长度 5 的完整路径**（起点是墙）。
- **后果**：单位被推挤进墙里、或地形动态变化把脚下变成障碍时，寻路依然"成功"并给出一条从墙内出发的路径，单位沿路径移动会穿墙。调用方通常以"返回非 null"作为"可达"的依据，于是永远不触发兜底逻辑。
- **建议**：补 `if (!grid.isWalkable(sx, sy)) return null;`（与终点对称）；若需要"起点在墙里时找最近合法格"的容错，应作为独立选项。

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

### P1 · [save] `clearAll()` 不清理 `__tmp` 备份键，存储里永久残留垃圾

- **位置**：`save/SaveManager.ts:245-251`（`listSlots()` 显式 `!k.endsWith('__tmp')` 过滤掉临时键）+ `265-267`（`clearAll` 基于 `listSlots`）
- **证据**：实测（`b4_v5.ts`）：`write('slot1')` → 手动写入 `save_slot1__tmp`（模拟写入中断留下的备份）→ `clearAll()` → `storage.keys()` 仍为 **`save_slot1__tmp`**。
- **后果**：**与第 2 节「SpatialHash 空桶不回收」同构的清理不彻底**。每次写入中断（崩溃、kill 进程）都会留一个 `__tmp`，`clearAll()` 清不掉，`listSlots()` 又看不见，于是存储占用只增不减，而开发者用 `listSlots()` 自查时看不到任何异常。在 localStorage 配额紧张的环境里，这直接导致"存不进去"的诡异失败。
- **建议**：`clearAll()` 遍历 `keys()` 时把前缀匹配且 `endsWith('__tmp')` 的也一并 remove；或提供 `purgeTempKeys()`。

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

### P1 · [skill-caster] `resetCooldown()` 把充能数留在旧值，导致 `chargesLeft` 变负、技能可用性错乱

- **位置**：`skill-caster/SkillCaster.ts:290-297`（只把 `_cd` 置 0，**不动 `_charges`**）+ `344-346`（`const left = (this._charges.get(id) ?? 1) - 1;`）
- **证据**：实测（`b4_v2.ts`）：`charges: 2` → 施放 2 次（各 cancel 一次）→ `chargesLeft === 0` → `resetCooldown('s')` → `chargesLeft` 仍为 **0**（期望回到 2）→ 再施放一次 → `chargesLeft === -1`。
- **后果**：`chargesLeft` 变负后 `left <= 0` 恒真 → 每次施放都重置冷却为完整 CD，但充能数继续下降，同时 `_cd` 的恢复逻辑（458-463 行 `if (cur < max)`）会把负数一路加回来 —— 技能可用性完全错乱。GM 命令"重置冷却"在带充能的技能上必然踩到。
- **建议**：`resetCooldown(id)` 同时把 `_charges` 重置为 `def.charges ?? 1`；并在 `tryCast` 里对 `left` 做 `Math.max(0, ...)` 兜底。

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

### P1 · [skill-variant] `applyPatch` 的 switch 无 default，未知 op 静默无操作

- **位置**：`skill-variant/SkillVariant.ts:314-360`（`switch (p.op)` 只有 7 个 case，无 default）
- **证据**：实测（`b4_v3.ts`）：`{op:'nope' as never, path:'dmg', value:1}` → `apply` 返回 `{result:{dmg:5}, applied:['w']}` —— **补丁被算作"已应用"，但值没变**。
- **后果**：配置里 op 拼错（`'multiply'` 而非 `'mul'`），变体显示"已生效"但技能数值毫无变化。玩家和策划都认为是"数值没配够"，不会想到是 op 名错了。
- **建议**：加 `default: throw new Error(...)`

### P1 · [skill-variant] 数值 op 未校验结果有限性，`mul: NaN` 把技能数据污染成 NaN

- **位置**：`skill-variant/SkillVariant.ts:319-337`（`add`/`mul`/`max`/`min` 只校验**旧值**是有限数，不校验**结果**）+ `363-371`（`assertNumber` 同样只管输入）
- **证据**：实测（`b4_v3.ts`）：`{op:'mul', path:'dmg', value:NaN}` 作用于 `{dmg:5}` → 结果 `dmg: NaN`（序列化为 `null`）。
- **后果**：NaN 进入技能定义后，伤害计算、UI 显示、存档全部变成 NaN/null。而 `apply` 返回的 `applied` 列表里这个变体是"成功应用"的。
- **建议**：`add`/`mul` 之后补 `if (!Number.isFinite(cur[last])) throw ...`；`max`/`min` 的 NaN value 在 `_validate` 阶段就拒绝。

### P1 · [skill-variant] 互斥检查只处理"第一个冲突者"，三变体互斥场景漏检

- **位置**：`skill-variant/SkillVariant.ts:201-221`（`const blockedBy = final.find(...)` 只找**第一个**冲突者，然后只替换这一个）
- **证据**：实测（`b4_v3.ts`）：A（prio 1）、B（prio 1）、C（prio 10，`excludes:['A','B']`）→ `apply(..., ['A','B','C'])` → `applied === ["B","C"]`。C 明确排除了 A 和 B，正确结果应只剩 C，但 B 被留下了。
- **后果**：互斥规则（"这两个遗物不能同时改造同一技能"）部分失效，产生规则外的组合。因为 A 确实被移除了，表面上看"互斥是生效的"，更具欺骗性。
- **建议**：改为收集**所有**冲突者，若新变体优先级更高则全部移除，否则跳过新变体。

### P1 · [social] `statsOf().byReason` 是残缺对象，未出现的 reason 读到 `undefined`，参与运算得 NaN

- **位置**：`social/Report.ts:185-188`（`const byReason = {} as Record<ReportReason, number>;` 用 `as` 断言绕过类型系统，然后只填充出现过的 key）
- **证据**：实测（`b4_v1.ts`）：只有一条 `cheating` 举报时，`byReason` = `{"cheating":1}`，`byReason['afk']` = **`undefined`**，`byReason['afk'] + 1` = **NaN**。
- **后果**：类型签名承诺 `Record<ReportReason, number>`（每个 reason 都有数字），实际是 `Partial`。调用方按签名直接做加法/比较，得到 NaN 或错误排序，且 TS 编译期**不会报错**（`as` 断言骗过了检查）。这是 C 类"契约说谎"里最典型的一种。
- **建议**：初始化时把所有 `ReportReason` 都填 0，或把返回类型改为 `Partial<Record<ReportReason, number>>`。

### P1 · [social] `abuseThreshold` 等阈值配置未收口，NaN 让"恶意举报识别"永久失效

- **位置**：`social/Report.ts:101-109`（只有 `maxTickets` 用了 `clampNum`，其余 6 个配置全是裸 `??`）
- **证据**：实测：`new ReportCenter({abuseThreshold: NaN}).isAbusiveReporter('x')` → **false**（`rejectedCount(0) >= NaN` 恒为 false）。同理 `actionThreshold: NaN` 会让 `needsAction` 恒 false。
- **后果**：配置里阈值缺失/非法 → 恶意举报识别、自动处罚全部静默关闭，运营侧看到"系统从不自动处理"，而配置看起来是填了的。
- **建议**：7 个阈值统一收口（`maxTickets` 是容量类，已正确用 `clampNum`；其余是普通配置，用 `numOr` 即可）。

---

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

### P1 · [telegraph] `clear()` 不触发 `onComplete`，与 `cancelAll()` 行为不一致

- **位置**：`telegraph/Telegraph.ts:204-206`（`clear()` 直接 `this._list.length = 0`，无回调）对比 `190-202`（`cancelAll()` 逐个调 `onComplete(t, true)`）
- **证据**：实测（`b4_v2.ts`）：spawn 一个带 `onComplete` 的 telegraph → `clear()` → 回调次数 **0**。
- **后果**：外部状态机（例如"预警期间锁住 AI""显示地面圈"）依赖 `onComplete` 做清理。场景切换调用 `clear()` 时收不到回调，预警圈残留、AI 锁死。而 `cancelAll()` 路径是好的，于是 bug 只在"切场景/重置"时出现。
- **建议**：`clear()` 内部复用 `cancelAll()` 的逻辑（两个 API 名字相近，强烈建议统一而非仅文档化）。

### P1 · [timeutil] `isNewDay(now, lastSeen)` 的参数名与实现语义不符，按参数名传时间戳将**永远返回 false**

- **位置**：`timeutil/TimeUtil.ts:45-48`（`return dayIndex(now, zone) > lastSeen;`）
- **现象**：参数名 `lastSeen` 暗示"上次登录的时间戳"，但实现要求传入 `dayIndex()`（约 1.9 万量级的天序号）。传 `Date.now()`（约 1.7 万亿）时，`dayIndex > 1.7e12` 恒为 false。
- **证据**：实测（`b4_v1.ts`）：
  - `isNewDay(now + 86_400_000, now)`（传时间戳）→ **false**（隔了一整天，应为 true）
  - `isNewDay(now + 86_400_000, dayIndex(now))`（传天序号）→ **true**
  - 仓库自带测试 `tests/run_batch13.ts:686-690` 用的正是 `dayIndex`，所以现有测试覆盖不到这个误用。
- **后果**：调用方按参数名直觉传 `lastLoginAt`（时间戳）→ **每日任务/每日奖励/每日商店永不刷新**，且返回值是 false 而非报错，表现为"第二天上线，任务还是昨天那批"。这是典型的"注释说谎比没注释更糟"。
- **建议**：参数改名 `lastDayIndex` 并在 JSDoc 写明；或内部改为 `dayIndex(now) > dayIndex(lastSeen)` 兼容两种传法（但会破坏现有正确用法，见存疑）。

### P1 · [timeutil] `Countdown.pause()` 后 `state()` 仍返回 `'running'`

- **位置**：`timeutil/TimeUtil.ts:212-215`（`state` 只看 `_endAt === null && _pausedRemain === null` 判 waiting，其余一律 `isFinished ? 'finished' : 'running'`）
- **证据**：实测：`start(0)` → `pause(100)` → `state(500)` → **`'running'`**（`remaining` 正确地返回 900）。
- **后果**：`CountdownState` 类型只声明了三态，没有 `'paused'`；调用方无法用 `state()` 区分"在跑"和"暂停中"，只能自己额外记标志。UI 上表现为暂停后倒计时仍在转。
- **建议**：`state` 增加暂停分支 `if (this._pausedRemain !== null) return 'paused';`，类型同步加 `'paused'`（破坏性变更，请总审裁决）。

### P1 · [timeutil] `ticksSince(periodMs = NaN)` 返回 NaN，且只挡了 `<= 0`

- **位置**：`timeutil/TimeUtil.ts:57-67`（`if (periodMs <= 0) throw` —— NaN 不满足 `<= 0`，穿透）
- **证据**：实测：`ticksSince(0, 1000, NaN) === NaN`；`ticksSince(0, 1000, 0)` 正常抛异常。
- **后果**：体力/能量按 `periodMs` 恢复，配置里 period 缺失变 NaN → `Math.floor((now-since)/NaN) = NaN` → 补发体力数量 NaN → 玩家体力变 NaN 且**不报错**。
- **建议**：改为 `if (!(periodMs > 0)) throw ...`（与第 2 节 dt 守卫同一套写法），或用 `numOr` 收口。

### P1 · [timeutil] 固定 `offsetMinutes` 无法表达夏令时，欧美时区在半年里日界错 1 小时

- **位置**：`timeutil/TimeUtil.ts:13-22`（`Zones` 用常量 `offsetMinutes`）+ `28-32`（`startOfDay` 直接用常量偏移）
- **证据**：实测：`startOfDay(Date.UTC(2024,6,1,5,0), Zones.US_PACIFIC)` → `2024-06-30T08:00:00Z`。2024 年 7 月 1 日洛杉矶处于 PDT（UTC-7），正确结果应为 `07:00Z`，**实差 1 小时**。
- **后果**：日界错 1 小时意味着美服玩家在 23:00–24:00 这一小时内的行为被算到"第二天"（或反之），每日任务/赛季结算边界错乱，且只有半年会出现，极难复现。
- **建议**：改用 `Intl.DateTimeFormat` 的 `timeZoneName:'shortOffset'` 动态取偏移，或在 `Zone` 接口加 DST 描述；若不打算支持，请在 README 明确写"仅支持固定偏移时区，欧美夏令时期间日界会偏 1 小时"。


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

### P2 · [condition] `onComplete` 只支持单个监听器

- **位置**：`condition/ConditionEngine.ts:183-188`（`this._onComplete = fn` 直接覆盖）
- **证据**：代码推导：第二次 `onComplete` 会顶掉第一次，且第一次拿到的取消函数此后 `this._onComplete === fn` 为 false，形同失效。
- **后果**：成就系统和任务系统同时监听时，先注册的那个静默失联。
- **建议**：改为监听器数组 + 返回带 id 的取消函数。

---

### P2 · [curve] `destroy()` 后对象仍可用，与 README「destroy 之后不能再 evaluate」的契约靠自觉

- **位置**：`curve/Curve.ts:140-142`
- **证据**：代码推导：`destroy()` 只 `_keys.length = 0`，`evaluate` 走 `keys.length === 0 → return 0`，不抛错。README 第 89/97 行明确写"destroy() 之后不能再 evaluate"。
- **后果**：文档承诺了不可用，实际静默返回 0，曲线值突然变 0 而没人知道为什么。
- **建议**：加 `_destroyed` 标志并在 `evaluate` 抛错，或修正 README 措辞。

---

### P2 · [cutscene] `update` 的 `guard < 64` 上限是魔法数

- **位置**：`cutscene/Cutscene.ts:141`（同类魔法数在 `skill-caster:493`、`telegraph:144` 也有，都是 8）
- **证据**：代码直读。
- **后果**：门控步骤极多时一帧推进不完，演出变慢。属于 rule4 的轻度违反。
- **建议**：提为构造配置 `maxGatesPerTick`。

---

### P2 · [debug-console] `_history` 的"去重"只看上一条

- **位置**：`debug-console/DebugConsole.ts:211-214`（`if (this._history[this._history.length - 1] !== body)`）
- **证据**：代码直读：连续输入 A、B、A 会存 3 条（只与上一条比）。
- **后果**：不算 bug（多数 shell 也是这个行为），但与"去重"的直觉有偏差。
- **建议**：在 README 说明"仅避免与上一条完全相同的记录"。

### P2 · [debug-console] `list()` 每次调用都 `sort`，且 `_resolve` 是 O(n) 遍历（无 alias 索引）

- **位置**：`debug-console/DebugConsole.ts:174-181`（`list()` 末尾 `.sort()`）+ `379-387`（`_resolve` 遍历所有命令比对 alias）
- **证据**：代码推导：`complete()` 每次按键都会调 `list()` → 每次全量排序；命令数量大时（几百条）补全有卡顿。
- **后果**：补全输入延迟。
- **建议**：缓存排序结果，或为 alias 建 `Map<string, Entry>` 索引。

### P2 · [di] `destroy()` 里的 `console.error`

- **位置**：`di/DIContainer.ts:171`
- **证据**：代码直读（扫描命中 console 输出 ×1）。
- **后果**：库内直接 `console.error` 会打乱宿主项目的日志格式；销毁失败应当通过回调/返回值暴露。
- **建议**：改为收集到 `destroy(): string[]` 的返回值里，或提供 `onDisposeError` 钩子。

---

### P2 · [difficulty] （见正文）

- `multiplier()` 无 `destroy()`；`onAdjust` 回调需外部清理。
- **存疑**：`CURRENCY_GAIN` 被放进 `PLAYER_FAVORING`（`:154-159`），意味着"玩家表现好 → 金币收益下降"。这是惩罚性 DDA，与"下调难度帮玩家"的直觉相反。若是有意为之（防刷）请补注释，否则建议移出。

---

### P2 · [expression] 除零与取模零静默返回 0

- **位置**：`expression/Expression.ts:451-454`
- **证据**：实测：`10 / 0 → 0`、`10 % 0 → 0`。
- **后果**：配置里写 `a/b` 而 b 计算为 0 时，公式结果变 0（通常是"不生效"），比 Infinity 更难发现。这属于已知取舍，但建议在 README 显式写下"除零得 0"这条规则。
- **建议**：文档化即可，不改代码。

---

### P2 · [gameflow] （见正文）

- `_findTransition()`（`:185-198`）第一个 `for` 循环里的 `t.to === this._current` 分支永不 `return`（内层还要求 `t.to === to`），整个第一循环等价于第二循环——冗余死代码，建议删除。
- `update(dt = 0)`（`:150`）用 `if (dt > 0)` 累加 `timeInState`，挡不住 `Infinity`（`Infinity > 0` 为真 → `timeInState` 一步变 Infinity）。建议改用 `safeDt(dt)`。对比同批 `tutorial`（`:211` 注释明确说明"为什么不是 dt > 0：Infinity > 0 为 true"），本单元漏了这条。

---

### P2 · [hitbox] `sector`/`capsule` 组合走采样近似，精度依赖硬编码采样数

- **位置**：`hitbox/Hitbox.ts:157-183`（sector 用 `N = 8`，capsule 用 `N = 6`）
- **证据**：代码直读。
- **后果**：细长 capsule 与窄 sector 的相交可能漏检（采样点落在缝隙里）。属于 rule4 违反 + 精度隐患。
- **建议**：采样数提为配置，或对 capsule/capsule 这类有闭式解的组合补解析解。

### P2 · [indicator] `ring` 类型的 `innerRadius` 在 `_buildShape()` 里被丢弃

- **位置**：`indicator/SkillIndicator.ts:233-237`（`case 'ring'` 直接返回 `{kind:'circle', radius: cfg.radius ?? 1}`）
- **证据**：实测：`{kind:'ring', radius:5, innerRadius:4}` → `compute(...).shape === {kind:'circle', radius:5}`。README 第 46-53 行已说明"ring 需要调用方用 `inRing()` 二次过滤"，**文档是对的**，但 API 层收下 `innerRadius` 却不用，容易误用。
- **后果**：直接把 `toQueryArgs(result)` 丢给 `HitboxWorld.query` 会得到**实心圆**判定，环形技能打中心的人。
- **建议**：在 `compute` 结果里带上 `innerRadius` 供调用方使用（当前 `IndicatorResult` 没有这个字段），或在 README 顶部加醒目警告。

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

### P2 · [noise] `SimplexNoise.noise3D` 是"伪 3D"，且 `PerlinNoise` 导出后无人使用

- **位置**：`noise/Noise.ts:196-206`（用两个 2D 切片 lerp，切片间距硬编码 `37.7`）+ `48-103`（`PerlinNoise` 类）
- **证据**：代码推导：`noise3D(x,y,z)` = `lerp(noise2D(x, y + iz*37.7), noise2D(x, y + (iz+1)*37.7), fade(fz))`，z 方向是切片插值而非真 3D 单纯形；`Noise` 类（455 行起）只用 `SimplexNoise`，`PerlinNoise` 未被任何内部代码引用。两份 `GRAD3` 梯度表（53-57 与 114-118 行）逐字重复。
- **后果**：用户按 `noise3D` 的名字做 3D 地形/云体积，得到的是各向异性的结果（z 方向梯度与 xy 不一致），且 `37.7` 是硬编码魔法数（违反 rule4）。
- **建议**：`37.7` 提成命名常量；梯度表合并为模块级常量。详见「存疑」。

---

### P2 · [perception] （见正文）

- `:466-470` 的 `if (st.targetId !== bestTarget && st.targetId >= 0) { st.targetId = bestTarget; } else { st.targetId = bestTarget; }`——两支完全相同，是冗余死代码；且切换目标时不发 `lost` 事件（旧目标静默丢失）。
- `_pendingAlerts` 的 `delivered: Set<number>`（`:78`）只增不减，但 alert 出队后整体丢弃，随对象回收，不构成长期泄漏。

---

### P2 · [save] `write()` 失败时只 `console.error` 并返回 false，调用方极易忽略返回值

- **位置**：`save/SaveManager.ts:131-164`（4 处 `console.error`）
- **证据**：代码直读（扫描命中 console 输出 ×4）。
- **后果**：存档失败时游戏继续跑，玩家以为存上了。库内 `console.error` 还会污染宿主日志。
- **建议**：把错误收集到 `lastError` 字段或 `onError` 回调里，README 强调必须检查返回值。

### P2 · [settings] （见正文）

- `snapshot()`（`:246-256`）的 `pendingRestart` 收集**所有** `needRestart` 的 key，不判断值是否真被改过 → UI 会列出一堆根本没动过的"待重启项"。
- 无 `destroy()`（持有 `onChange` 回调）。
- `cycle()`（`:110-118`）当前值不在 `options` 时 `indexOf` 得 -1，静默跳到 `opts[0]`——降级合理，但建议注释说明。

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

### P2 · [subtitle] rule7 不满足：本单元**缺示例**

- **位置**：`subtitle/` 目录下无示例（任务书第 21 号单元详情明确标注「示例：**无**」）
- **证据**：任务书清单 + 仓库文件树（`examples/` 下 17 个 batch 示例文件，无 subtitle 引用）。
- **后果**：违反 rule7「每个插件自带 README + 测试 + 示例」，也是本批 25 个单元里**唯一**不满足的。
- **建议**：补一个示例片段，或在 README 里加完整可运行示例。

### P2 · [subtitle] `at()` 是 O(n) 全数组扫描

- **位置**：`subtitle/Subtitle.ts:74-93`（每个 `at()` 从头遍历直到 `l.start > time`）
- **证据**：代码推导：复杂度 O(n)，未做"上次位置"缓存或二分。
- **后果**：电影级长字幕（3000+ 行）× 60fps 查询 = 每秒 18 万次遍历，虽不致命但可优化。
- **建议**：已排序数组上做二分查找起点，或从上次索引继续扫描。

---


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

新建 `tests/run_phase10_a.ts`，并在 `tests/run.ts` 里注册：

```ts
setSuite('精审返工 · 窗口A');
runPhase10ATests();
```

⚠️ 注册后务必跑一次全量，确认 `run.ts` 能被构建到（沙盒曾出现过文件被写入重复 import 行的事故）。

### 5.3 报告

完成后产出 `audit/handoff_A_result.md`，每条一行：

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
| **`tests/run.ts`** | 三个窗口都要改它 → **最后合并时由总审统一处理**，你只管写自己的 `run_phase10_a.ts` |
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
