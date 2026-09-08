# 精审返工任务书 · 窗口 W1-A（第 A 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W1-A 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **20**（P1 17 / P2 3） |
| 单元 | **8** 个 |
| 来源批次 | batch4、batch5 |
| 所属组 | **第 A 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W1-B**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_A.md` 验收 **W1-B**。

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

### 3.1 你的单元（8 个，与其它 15 个窗口零重叠）

```
builder  craft  crash  cutscene  debug-console  gesture  matchops  skill-variant
```

---


## 【P1】先做这批

### P1 · [builder] `PlaceResult.missing` 声明了但从未被填充

- **位置**：`builder/Builder.ts:133`（接口里 `readonly missing?: Readonly<Record<ResourceId, number>>`）、`:366-380`（`preview` 里 `missing` 是**局部变量**，返回对象里没有它）、`:398-403`（`place` 失败时只透传 `error`/`detail`）
- **证据**：`place` 与 `preview` 在资源不足时均返回 `error: 'insufficient-resources'`，`missing` 实测为 `undefined`。
- **后果**：契约说谎。调用方照着类型定义写 `if (r.missing?.wood)` 来做"还差多少木头"的提示，运行时永远走不到，功能静默失效（玩家点了建造没反应，也没提示）。比没有这个字段更糟——类型检查是过的。
- **建议**：`preview` 的返回里带上 `missing`，`place` 失败时透传。

### P1 · [builder] `rotateCell` 对非法角度静默返回原值

- **位置**：`builder/Builder.ts:187-194`（`default: return c;`）
- **证据**：`rotateCell({x:1,y:0}, 45 as never)` → `{x:1,y:0}`（正确应是抛错或至少不静默）。
- **后果**：`Direction` 是 `0|90|180|270` 的字面量联合，TS 层能挡住；但蓝图配置从 JSON 反序列化后是 `number`，`rot` 传 45 时建筑**不旋转也不报错**，占位与预览对不上，玩家看到的是"我选了旋转但它没转"。
- **建议**：`default: throw new Error(...)`，或在配置解析层校验。

其他复核：`remove` 的返还率（`:479-481`）正确区分了"未完工全额退 / 已完成按比例"；`_counts` 用 `Math.max(0, ...)` 防负数（`:477`、`:550`）；`validate()` 的前置/升级目标/空占位/返还率四项校验完整；`place` 先 `preview` 再 `spend`，预览与落地的判据一致（只有 upgrade 例外）。依赖只到 `_core/math`，无 rule6 违规。**无 `destroy()`**（有 `clear()`，见共性问题）。

---

### P1 · [craft] `totalMaterials` 递归时忽略子配方的产出倍率，材料需求被高估

- **位置**：`craft/CraftSystem.ts:246-283`，关键在 `:275`（`this.totalMaterials(sub.id, need, inv, visiting, out)`）
  递归时把"需要 `need` 个产物"直接当成"需要做 `need` 次子配方"，但子配方一次产出 `output.count` 个（这里是 4 个）。
- **证据**：
  ```
  配方 plank: 2 木 → 4 板
  配方 house: 8 板 → 1 房
  实际：8 板 ÷ 4 板/次 = 2 次合成 × 2 木 = 4 木
  totalMaterials('house', 1) = {"wood": 16}    ← 高估 4 倍（正好等于产率）
  ```
- **后果**："材料清单"UI 让玩家去攒 4 倍的材料；更糟的是自动 crafting/代工系统照着这个数去执行合成，会多做 4 倍的中间产物，材料消耗远超预期。数字看起来"合理"（都是正整数），不会触发任何校验。
- **建议**：`:275` 改成 `this.totalMaterials(sub.id, Math.ceil(need / (sub.output.count ?? 1)), ...)`；注意有 `variants` 时产率不定，应取最大产率或注明是上界。

### P1 · [craft] 副产物被背包丢弃时静默消失

- **位置**：`craft/CraftSystem.ts:351-358`（`const got = bp.count * count - leftover; if (got > 0) byproducts.push(...)`）
- **证据**：构造一个放不下 `slag` 的背包，实测
  ```
  craft -> {"ok":true,"produced":[{"itemId":"sword","count":1}],"byproducts":[]}
  ```
  `ok: true`，`byproducts` 是空数组，没有任何字段表示"有副产物被丢了"。
- **后果**：主产物成功了，副产物因为背包满被 `Inventory.add` 吞掉，玩家完全不知情。带概率的稀有副产物（比如 5% 出橙装）丢掉时，运营侧看到的是"掉率异常低"，代码侧一切正常。
- **建议**：加 `lost` 或 `discarded` 字段，或在 `got < bp.count * count` 时返回 `reason: 'output_failed'` 之外的警告。

### P1 · [craft] 全部 `consume:false` 的配方，`canCraft` 返回 `ok:true` 但 `maxCount:0`

- **位置**：`craft/CraftSystem.ts:211-220`（`maxCount` 只在 `input.consume !== false && per > 0` 时更新，否则保持 `Infinity`），`:220`（`maxCount: Number.isFinite(maxCount) ? maxCount : 0`）
- **证据**：单输入 `{consume:false}` 的配方 → `canCraft` 返回 `{"ok":true,"missing":[],"maxCount":0}`。
- **后果**：UI 拿 `maxCount` 做"最多能做几个"滑块的取值上限，会得到 0，滑块直接禁用；但 `craft()` 本身能成功。两个 API 对同一事实给出相反答案。
- **建议**：无消耗输入时 `maxCount` 应返回 `Infinity`（或引入 `unlimited: true` 标志），而不是 0。

其他复核：`craft` 的原子性做得**正确**——先产出后扣料（`:328-348`），产出失败时把已加入的部分全部 `remove` 回滚（`:339-342`）；`_pickVariant` 的权重轮盘（`:385-398`）在无 rng 时退化为取第一个（`:386`），有 rng 时实现正确；`totalMaterials` 的 `visiting` 集合（`:250`/`:255`/`:281`）防循环依赖，但注意它在递归结束后 `delete`（`:281`）意味着同一个配方在**不同分支**上会被重复计入——对"总需求"语义是对的，对"依赖树"语义是错的，属设计取舍。

---

### P1 · [crash] `_seen` 指纹表只增不减，且 `dedupeWindow` 过期后不清理

- **位置**：`crash/CrashReporter.ts:177`（`private readonly _seen = new Map(...)`）、`:290`（每次 capture 都 `set`）、`:407-411`（`reset()` 是唯一的清理入口，但用户不会在运行时调）
- **证据**：`dedupeWindow: 1` 的配置下，抓 1000 个**不同指纹**的异常 → `stats().length = 1000`。（对照：同指纹 500 次 → 只有 1 条，去重本身是有效的。）
- **后果**：指纹由 `name + 首个堆栈帧` 构成（`:477-481`），线上一个复杂应用的去重后指纹数可以上万。每条还带着 `{count, lastSent}`，长期运行的会话（尤其是崩溃风暴时）会持续膨胀。更实际的问题是 `stats()`（`:401-405`）每次都要 `[...entries].map().sort()` 全表排序，随指纹数线性劣化。
- **建议**：给 `_seen` 加容量上限（LRU）或在 `capture` 时顺带清理 `now - lastSent > dedupeWindow * K` 的陈旧条目。

### P1 · [crash] 采样用裸 `Math.random`，不可复现、不可测试

- **位置**：`crash/CrashReporter.ts:294`（`if (Math.random() > this._sampleRate) return false;`）
- **证据**：`sampleRate: 0.5` 下 200 次不同异常发送 105 次——比例对，但每次运行结果都不同（实测多次不一致）。
- **后果**：违反 F 类"随机数走 `IRandomSource` 注入"。`sampleRate` 相关的单元测试无法稳定断言（只能写"大致 50%"），且线上无法用固定种子复现某次采样决策，排查"为什么这条崩溃没上报"时无从下手。这是本批唯一一处裸 `Math.random`（我已 grep 全批 23 单元确认）。
- **建议**：构造函数加 `random?: IRandomSource` 选项，默认用 `Math.random` 包装，测试时注入固定序列。

其他复核：`BreadcrumbRing` 的环形裁剪（`:146-150`）正确（`_limit` 由 `clampNum(opts.breadcrumbLimit, 1, 1e6, 30)` 收口，是本批**唯一用 `clampNum` 收口容量的地方**，值得作为范本）；`_collectLogs` 的 `try/catch`（`:415-421`）吞掉日志源异常是**正确的**（采集崩溃时不能再抛）；`safeStringify` 用 `WeakSet` 处理循环引用（`:590-596`）实现正确；`normalize` 对 string/object/unknown 四种输入的处理完整。**P2**：`uninstall()` 把 `onerror` 设成 `null` 而不是删除属性（`:362` `?? null` 把 `undefined` 转成了 `null`），浏览器语义等价，Node 下会新增一个值为 null 的属性。

---

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

### P1 · [gesture] `maxPoints` 裁剪丢弃轨迹起点，长按时长被算短 → 长按判不出来

- **位置**：`gesture/Gesture.ts:333-360`（`down`/`move`）、`:356-359`（`if (this._pts.length > this._opts.maxPoints) this._pts.shift();`）、`:382-389`（`isLongPressSoFar`）
- **现象**：`maxPoints` 是**滑动窗口**，`shift()` 丢的是**最早的点**，而"按了多久"恰恰由最早的点决定。
- **证据**：`maxPoints: 8`、静止按住 1 秒（20 个采样点，`t` 从 0 到 1000）：
  ```
  pointCount=8 首点 t=650        ← 起点 0 被丢，窗口里最早的点已经是 650ms
  isLongPressSoFar(1000)=false   ← 长按阈值 600ms，实际按了 1000ms，判不出来
  up -> {"kind":"tap","distance":0,"speed":0}   ← 长按被识别成单击
  ```
- **后果**：长按时如果手指有轻微抖动（产生 >maxPoints 个采样点，默认 64 通常够，但高刷屏 + 小 maxPoints 配置就会触发），"长按 1 秒"被识别成"点击"。玩家的表现是"我明明按住了却触发了普通点击"，且**只在特定设备上复现**（采样率越高越容易），极难定位。
- **建议**：`down()` 时单独记 `this._downT = p.t`，`isLongPressSoFar` 与 `up()` 的时长判定都用它，而不是 `this._pts[0].t`。轨迹裁剪照旧。

其他复核：`dt` 的守卫（`:211-214`）`Number.isFinite(rawDt) && rawDt > 0` 正确挡住了 `NaN/Infinity`；`recognizePinch` 的 `d0 <= 1e-6` 除零守卫到位；`dirOf` 的 `yDown` 处理正确。零依赖、无泄漏、无业务耦合。

---

### P1 · [matchops] `ReconnectTracker` 的 `graceMs` / `graceDecay` 为 `NaN` 时，重连宽限期变成"永不过期"

- **位置**：`matchops/Reconnect.ts:154-160`（`??` 收口，不挡 NaN）、`:385-388`（`_computeGrace`：`Math.max(this._minGraceMs, Math.round(NaN))` = NaN）、`:296`（`if (elapsed > grace)` 对 NaN 恒 false）、`:333`（`now - e.disconnectedAt > limit`）
- **证据**：
  ```
  graceDecay=NaN：
    第 1 次 grace=120000（Math.pow(NaN,0)===1，侥幸正确）
    重连后 attempts=1 → grace=NaN
    再断线，10 小时后 reconnect -> {"ok":true}   ← 永不过期
    tick(36e6) -> []                              ← 也永不判弃权

  graceMs=NaN：
    graceFor=NaN，断线 10 小时后 reconnect -> {"ok":true}
  ```
- **后果**：配置表把 `graceMs` 写成 `null`（`?? `会把 `null` 也兜掉，安全）或字符串数字（不安全）时，掉线玩家**任何时候**重连都能成功，且 `tick` 永远不会把他判为弃权。对局里出现"队友掉线 3 小时，比赛一直不结束"的悬挂对局。同时 `penaltyRates` 因为他既不是 forfeited 也不是 exhausted，队友也不会得到惩罚减免——整套惩罚逻辑静默失效。
- **建议**：`_computeGrace` 里 `const g = numOr(decayed, DEFAULTS.graceMs)`，或在构造时对 `graceMs`/`graceDecay` 做 `clampNum` + 有限性断言（`graceDecay` 应在 (0,1]）。

### P1 · [matchops] `Surrender.vote` 对掉线玩家返回 `ok:true`，但票不被计入

- **位置**：`matchops/Surrender.ts:249-270`（`vote` 只查 `_team.has(id)` 和 state/deadline，**不查 connected**）对照 `:391-402`（`_tally`：`if (!this._connected.has(id)) continue;` 把掉线玩家的票跳过）
- **证据**：
  ```
  3 人队，全员在线时 start 成功
  中途 setConnected(['a','b'])，c 掉线
  c 投票 -> {"ok":true}          ← 告诉 c "你投成功了"
  status -> {yes:1, ..., eligible:2, needMore:1}   ← c 的票没被计入
  ```
- **后果**：掉线重连的玩家（或网络抖动被短暂标记掉线的玩家）投了赞成票，UI 显示成功，但票数不变，投降永远差一票。玩家会反复点、以为是网络问题。配合 `requireAllConnected: true`（默认）时，只要有一人掉线，投降就**永远**无法发起或无法达成，对局被拖到超时。
- **建议**：`vote` 里对未连接的玩家返回 `{ ok:false, error:'not-connected' }`，与 `start`（`:217-219`）的口径一致；或在 `status` 里暴露 `ignoredVotes`，让 UI 能提示"你的票因掉线未计入"。

其他复核：`ReconnectTracker.reconnect` 的状态机（`:269-306`）顺序正确（先查 nonexistent → online → exhausted → matchEnded → forfeited → 超时）；`SpectateSession` 的 `maxSpectators`（`:183-185`）、`duplicate`、`not-started`/`ended`、`opponent-forbidden` 四道检查完整，实测第 3 人加入正确返回 `full`；`viewingTime` 的 `Math.max(startedAt, now - delay)`（`:273`）正确处理了开局初期"还没延迟够"的情况；`shouldAbortMatch`、`forfeitMultiplier`、`pickDirectorShot` 都是纯函数且无 NaN 风险（`pickDirectorShot` 用 `score > bestScore` 而非 `>=`，第一个候选必被选中，正确）。**三个类均无 `destroy()`**。

---

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


## 【P2】P1 完成后再做

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

新建 `tests/run_phase10_w1a.ts`，并**在文件内导出** `runPhase10W1ATests()`：

```ts
export function runPhase10W1ATests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W1-A.md`，每条一行：

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
| **文件命名** | `run_phase10_w1a.ts` / `result_W1-A.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 A 组**。修完之后，按 `audit/review_A.md` 验收 **W1-B**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W1-A.md`，
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
