# 精审返工任务书 · 窗口 W4-A（第 A 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W4-A 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **15**（P1 9 / P2 6） |
| 单元 | **6** 个 |
| 来源批次 | batch1、batch3 |
| 所属组 | **第 A 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W4-B**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_A.md` 验收 **W4-B**。

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
bullet-pattern  difficulty  entity  gameflow  i18n  matchmaking
```

---


## 【P1】先做这批

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


## 【P2】P1 完成后再做

### P2 · [bullet-pattern] （见正文）

- `aimAtTarget = false` 但未给 `fixedAngle` 时仍自动瞄准目标，与 JSDoc `:208`~`:214`"false = 用固定角度"不符。证据：目标在正上方 (0,100)，`angle = 1.5708`（即 π/2，仍在自动瞄准），而非期望的 0（`b1_v3` [18]）。
- `tick` 的 `guard++ < 64` 静默截断（掉帧时丢弹幕）；`SequencePlayer` loop 时 `_time = 0` 丢弃余量造成周期漂移；`BulletPattern` 无 `destroy()`。

### P2 · [difficulty] （见正文）

- `multiplier()` 无 `destroy()`；`onAdjust` 回调需外部清理。
- **存疑**：`CURRENCY_GAIN` 被放进 `PLAYER_FAVORING`（`:154-159`），意味着"玩家表现好 → 金币收益下降"。这是惩罚性 DDA，与"下调难度帮玩家"的直觉相反。若是有意为之（防刷）请补注释，否则建议移出。

---

### P2 · [entity] （见正文）

- `spawn` 无槽位上限守卫（`:190`~`:199`）：`index = this._slots.length` 无上限，而 `makeId = index + generation * SLOT_CAPACITY`（`:90`）、`idIndex = id % SLOT_CAPACITY`（`:70`）。**推导**：槽位超过 1048576 后 `idIndex === 0` → `isValidId` 恒 false → 实体静默查不到。需 >100 万次 spawn，仅挂机/无尽模式可达。
- 只有 `clear()` 没有无参 `destroy()`（实测 `typeof reg.destroy === 'function'`，但那是 `destroy(id)` 删实体）。rule5 的语义由 `clear()` 覆盖，属于命名不符。
- `query/queryAll/snapshot/forEach` 每次 O(n) 全表扫描并新分配数组（`:306`~`:325`、`:450`、`:472`）。

### P2 · [gameflow] （见正文）

- `_findTransition()`（`:185-198`）第一个 `for` 循环里的 `t.to === this._current` 分支永不 `return`（内层还要求 `t.to === to`），整个第一循环等价于第二循环——冗余死代码，建议删除。
- `update(dt = 0)`（`:150`）用 `if (dt > 0)` 累加 `timeInState`，挡不住 `Infinity`（`Infinity > 0` 为真 → `timeInState` 一步变 Infinity）。建议改用 `safeDt(dt)`。对比同批 `tutorial`（`:211` 注释明确说明"为什么不是 dt > 0：Infinity > 0 为 true"），本单元漏了这条。

---

### P2 · [i18n] （见正文）

- `addLocale` 非 override 分支 `:89` 用 `Object.assign(exist, table)`，会触发 `__proto__` setter。实测追加 `JSON.parse('{"__proto__":{"polluted":"yes"},"b":"B"}')` 后，`t('polluted')` 返回 **`'yes'`**（本应是未翻译的 key 本身）（`b1_v5` [43]）。override 分支用 spread，不触发。**与已修的 `easing()` 原型链污染同类，是新实例。**

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

新建 `tests/run_phase10_w4a.ts`，并**在文件内导出** `runPhase10W4ATests()`：

```ts
export function runPhase10W4ATests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W4-A.md`，每条一行：

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
| **文件命名** | `run_phase10_w4a.ts` / `result_W4-A.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 A 组**。修完之后，按 `audit/review_A.md` 验收 **W4-B**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W4-A.md`，
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
