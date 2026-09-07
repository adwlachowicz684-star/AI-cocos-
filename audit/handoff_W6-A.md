# 精审返工任务书 · 窗口 W6-A（第 A 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W6-A 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **13**（P1 11 / P2 2） |
| 单元 | **3** 个 |
| 来源批次 | batch4 |
| 所属组 | **第 A 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W6-B**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_A.md` 验收 **W6-B**。

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
di  noise  timeutil
```

---


## 【P1】先做这批

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

### P2 · [di] `destroy()` 里的 `console.error`

- **位置**：`di/DIContainer.ts:171`
- **证据**：代码直读（扫描命中 console 输出 ×1）。
- **后果**：库内直接 `console.error` 会打乱宿主项目的日志格式；销毁失败应当通过回调/返回值暴露。
- **建议**：改为收集到 `destroy(): string[]` 的返回值里，或提供 `onDisposeError` 钩子。

---

### P2 · [noise] `SimplexNoise.noise3D` 是"伪 3D"，且 `PerlinNoise` 导出后无人使用

- **位置**：`noise/Noise.ts:196-206`（用两个 2D 切片 lerp，切片间距硬编码 `37.7`）+ `48-103`（`PerlinNoise` 类）
- **证据**：代码推导：`noise3D(x,y,z)` = `lerp(noise2D(x, y + iz*37.7), noise2D(x, y + (iz+1)*37.7), fade(fz))`，z 方向是切片插值而非真 3D 单纯形；`Noise` 类（455 行起）只用 `SimplexNoise`，`PerlinNoise` 未被任何内部代码引用。两份 `GRAD3` 梯度表（53-57 与 114-118 行）逐字重复。
- **后果**：用户按 `noise3D` 的名字做 3D 地形/云体积，得到的是各向异性的结果（z 方向梯度与 xy 不一致），且 `37.7` 是硬编码魔法数（违反 rule4）。
- **建议**：`37.7` 提成命名常量；梯度表合并为模块级常量。详见「存疑」。

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

新建 `tests/run_phase10_w6a.ts`，并**在文件内导出** `runPhase10W6ATests()`：

```ts
export function runPhase10W6ATests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W6-A.md`，每条一行：

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
| **文件命名** | `run_phase10_w6a.ts` / `result_W6-A.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 A 组**。修完之后，按 `audit/review_A.md` 验收 **W6-B**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W6-A.md`，
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
