# 精审返工任务书 · 窗口 W8-B（第 B 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W8-B 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **11**（P1 8 / P2 3） |
| 单元 | **3** 个 |
| 来源批次 | batch2 |
| 所属组 | **第 B 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W8-A**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_B.md` 验收 **W8-A**。

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
affix  binary  blessing
```

---


## 【P1】先做这批

### P1 · [affix] 区间宽度小于一个精度单位时，roll 出的值落在 [min, max] 之外

- **位置**：`affix/AffixSystem.ts:309-330`（`lo = Math.ceil(rawLo*f)/f`、`hi = Math.floor(rawHi*f)/f`、L319-321 `if (hi <= lo) v = lo`、L329-330 收口）
- **现象**：`lo` 向上取整、`hi` 向下取整，区间窄于一个精度单位时 `hi < lo`，取 `v = lo` 后又被 L330 的 `if (v > hi) v = hi` 拉到 `hi`——两个边界都不在配置区间内。
- **证据**：`verify/b2_v2.ts` §4 实测：
  ```
  def.min=1.2 max=1.4 precision=0 → 实际值 = 1   （不在 [1.2,1.4] 内）
  def.min=0.05 max=0.07 precision=1 → 实际值 = 0  （不在 [0.05,0.07] 内）
  ```
- **后果**：策划配了一条"1.2~1.4 的暴击倍率"，实际 roll 出 1.0。数值被悄悄改小且不报错，平衡性分析全部失真；`validateAffixPool` 也不报这个（只报稀有度倒挂），所以配置期发现不了。
- **建议**：`lo`/`hi` 用同一个方向取整（都 floor 或都 round），并在 `hi < lo` 时把值取 `Math.min(Math.max(lo, ...), hi)` 后再校验落在 `[min, max]`；或在 `validateAffixPool` 里加一条"区间宽度 < 精度单位"的 warning。

### P1 · [affix] `lastRerollDegraded` 只会置 true，从不复位

- **位置**：`affix/AffixSystem.ts:207-209`（仅 `this.lastRerollDegraded = true;`），字段声明 L109
- **证据**：`verify/b2_v2.ts` §5 实测：第一次 `rerollAll` 后置 true，**再跑 2 次后仍是 true**。
- **后果**：字段名与 README 语义是"本次 reroll 是否降级"，实际语义是"历史是否曾降级"。UI 用它提示"这次洗练亏了"会一直亮着，玩家会误以为每次都在亏。
- **建议**：在 `rerollAll` 入口先置 `false`，再在降级处置 true。

### P1 · [binary] uint/int 在 31、32 位时范围计算溢出，契约声称支持 32 位但实际不可用

- **位置**：`uint` L22（`const max = (1 << bits) - 1;`）、`int` L44（`const half = 1 << (bits - 1);`）、`writeBits` L278（`if (bits < 32 && v >= 1 << bits)`）
- **现象**：`1 << 31` 为负数、`1 << 32` 绕回 `1 << 0`，导致 31/32 位的合法区间被算成空区间或负区间。
- **证据**：实测 describe 与写入：
  ```
  uint(31) describe => uint31[0..-2147483649]
  uint(32) describe => uint32[0..0]
  int(32)  describe => int32[2147483648..-2147483649]
  uint(31).write(1) => THROW: [Binary] uint31 越界：1（范围 0..-2147483649）
  BitWriter.writeBits(1,31) => THROW: [Binary] 值 1 需要超过 31 位表示
  ```
- **后果**：README §6① 明确写"位宽上限 32…schema 构造时就校验"，§8 声称测试覆盖"32 位边界（0xffffffff）"。按文档去定义一个 32 位 ID/哈希字段，运行期必然抛错或（写入路径）静默出错，属于文档与实现对不上。
- **建议**：用 `2 ** bits` 的乘方语义替换 `1 << bits`，并对 32 位单独处理无符号上界 `0xffffffff`。
- **影响面**：与 P0-1 同源，建议一并修。

### P1 · [binary] float 量化位数用 floor 算、用 round 写，(max-min)/step 小数部分 ≥0.5 时写最大值抛错

- **位置**：L81（`levels = Math.floor((max-min)/step)+1`）、L82（`bits = ceil(log2(levels))`）vs L94（`q = Math.round((clamped - min) / step)`）
- **证据**：实测 `float(0, 1.8, 0.5)` describe 为 `float[0..1.8/0.5] (2bit)`，`.write(1.8)` 抛 `[Binary] 值 4 需要超过 2 位表示`。
- **后果**：配置里只要 `(max-min)/step` 不是整数就可能触发（如 0~1.8 步长 0.5）。写入端抛错尚可查，但读端 `read()`（L97）能表示的最大值会超出 `max`，两端不对称。
- **建议**：`levels = Math.floor((max - min) / step + 1e-9) + 1` 并在 write 里对 `q` 做 `Math.min(q, (1<<bits)-1)` 收口。

### P1 · [binary] float.write 对越界值静默 clamp，违反 README §6③"越界值绝不静默截断"

- **位置**：L93 `const clamped = Math.min(max, Math.max(min, v));`
- **证据**：实测 `float(0,10,1)` 写入 999 后读回 **10**，无任何报错；而 `uint/int` 同场景是抛错。
- **后果**：坐标/血量类字段写入超范围值时被悄悄改小，调用方以为写成功了。float 是本库最可能承载坐标的类型，静默截断会让"位置飘移"类 bug 极难定位。
- **建议**：与 uint/int 对齐，越界即抛；或增加 `clamp: boolean` 配置项显式声明。
- **影响面**：见"存疑"第 1 条（是否升 P0）。

### P1 · [blessing] `remove(id, n)` 的负数参数会加层，`add(id, NaN)` 让层数变成 NaN

- **位置**：`blessing/Blessing.ts:133-136`（`const actual = Math.min(cur, n); const next = cur - actual;`）、L121（`const actual = Math.min(n, ...)`）
- **证据**：`verify/b2_v4.ts` §D 实测：
  ```
  add 3 层后 stacks = 3
  remove(b, -5) 后 stacks = 8   （负数应当被忽略，实际变成加层）
  add(b, NaN) 后 stacks = NaN   effectiveStacks = NaN
  ```
- **后果**：调用方用"当前层数 - 目标层数"算差值（很常见的写法）得到负数时，remove 变成 add；NaN 一旦进 `_stacks`，`effectiveStacks` → NaN → `effectsOf` 的 `perStack * eff` → NaN，玩家属性直接变 NaN 且不报错。
- **建议**：入口收口 `n = Math.max(0, Math.floor(numOr(n, 0)))`，`add` 同理。

### P1 · [blessing] `set` 类型的效果被层数缩放

- **位置**：`blessing/Blessing.ts:184`（`value: e.op === 'mul' ? Math.pow(e.perStack, eff) : e.perStack * eff`）
- **现象**：`set` 的语义是"设为固定值"，但走的是与 `add` 相同的乘层数分支。
- **后果**：2 层的 "set maxHp 100" 变成 200。`curse`（L270-274）与 `meta`（L328）是同款写法，见"跨单元共性问题"第 4 条。
- **建议**：`case 'set'` 单独返回 `e.perStack`。

### P1 · [blessing] `importState` 不校验数值、不触发 onChange

- **位置**：`blessing/Blessing.ts:277-285`
- **现象**：`this._stacks.set(id, Math.min(n, cap));` 未做有限性/符号校验；导入后 `_onChange` 不触发。
- **后果**：存档被篡改或版本迁移残留负数/NaN 层数直接进入系统（与 P1-14 同样的 NaN 链路）；UI 在导入后仍显示旧层数，直到下次变更才同步。
- **建议**：校验 + 导入结束后对全部 key 触发一次 onChange。


## 【P2】P1 完成后再做

### P2 · [affix] （见正文）

- **A3** 稀有度 `weight` 为 NaN 时不报错（L119 只查 `< 0`），`_pickRarity` 的 `total` 变 NaN → 所有比较失效 → 恒返回最后一个稀有度（静默偏斜）。
- **A4** `rarity.valueScale` 未校验（L306-307）：负数/NaN 会让所有词条值反向或变 NaN。
- **A5** `roll` 的 `usedGroups` 冲突组判定用的是 `_record` 后的累计（L300-303），与 `_pickDef` 的过滤（L278）一致 ✓；但 `_pickDef` 每次调用都全量扫 defs（L274），N 个词条 = O(N·M)。
- **A6** 无 `destroy()`（纯逻辑，N/A）。

---

### P2 · [binary] （见正文）

- **B5** `enum` 越界索引静默回默认（L122 `values[i] ?? def`）：README §7 坑表写的是"返回 undefined…退化为默认值"，实现返回 `def`，说法对不上（`bits = ceil(log2(n))` 天然留出无效索引，属设计意图，仅文档瑕疵）。
- **B6** `SchemaOptions.version`（L183）不进字节流、`decode` 也读不回，但 README §5/§7 要求"读取时判断要不要迁移"——只有 bytes 时做不到。
- **B7** `utf8Decode`（L432）遇到非法字节 `i++; continue;` 静默跳过。
- **B8** `utf8Encode` 对孤立代理项输出 WTF-8 三字节序列（L409）。
- **B9** 无 `destroy()`：本单元为纯函数，N/A。

---

### P2 · [blessing] （见正文）

- **B10** `_validate` 里 `softCap` 无 `falloff` 的分支是**空 if**（L81-84）：意图不明（应警告/抛错/给默认），实际静默走 `falloff ?? 0.5`（L171）。
- **B11** `pick()` 用 `pool.filter((_, i) => i !== idx)`（L266）：每次抽取 O(n) 重建数组，整体 O(n²)。
- **B12** `weight` 为 NaN 时 `total` 为 NaN → 恒取池子最后一个（L255-263，静默偏斜）。
- **B13** 无 `destroy()`（无监听/定时器，N/A）。

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

新建 `tests/run_phase10_w8b.ts`，并**在文件内导出** `runPhase10W8BTests()`：

```ts
export function runPhase10W8BTests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W8-B.md`，每条一行：

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
| **文件命名** | `run_phase10_w8b.ts` / `result_W8-B.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 B 组**。修完之后，按 `audit/review_B.md` 验收 **W8-A**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W8-B.md`，
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
