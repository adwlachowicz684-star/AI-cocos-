# 精审返工任务书 · 窗口 W7-B（第 B 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W7-B 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **12**（P1 10 / P2 2） |
| 单元 | **3** 个 |
| 来源批次 | batch4 |
| 所属组 | **第 B 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W7-A**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_B.md` 验收 **W7-A**。

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

### 3.1 你的单元（3 个，与其它 15 个窗口零重叠）

```
achievement  curve  expression
```

---


## 【P1】先做这批

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


## 【P2】P1 完成后再做

### P2 · [curve] `destroy()` 后对象仍可用，与 README「destroy 之后不能再 evaluate」的契约靠自觉

- **位置**：`curve/Curve.ts:140-142`
- **证据**：代码推导：`destroy()` 只 `_keys.length = 0`，`evaluate` 走 `keys.length === 0 → return 0`，不抛错。README 第 89/97 行明确写"destroy() 之后不能再 evaluate"。
- **后果**：文档承诺了不可用，实际静默返回 0，曲线值突然变 0 而没人知道为什么。
- **建议**：加 `_destroyed` 标志并在 `evaluate` 抛错，或修正 README 措辞。

---

### P2 · [expression] 除零与取模零静默返回 0

- **位置**：`expression/Expression.ts:451-454`
- **证据**：实测：`10 / 0 → 0`、`10 % 0 → 0`。
- **后果**：配置里写 `a/b` 而 b 计算为 0 时，公式结果变 0（通常是"不生效"），比 Infinity 更难发现。这属于已知取舍，但建议在 README 显式写下"除零得 0"这条规则。
- **建议**：文档化即可，不改代码。

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

新建 `tests/run_phase10_w7b.ts`，并**在文件内导出** `runPhase10W7BTests()`：

```ts
export function runPhase10W7BTests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W7-B.md`，每条一行：

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
| **文件命名** | `run_phase10_w7b.ts` / `result_W7-B.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 B 组**。修完之后，按 `audit/review_B.md` 验收 **W7-A**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W7-B.md`，
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
