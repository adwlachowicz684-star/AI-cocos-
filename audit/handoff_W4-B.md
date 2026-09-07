# 精审返工任务书 · 窗口 W4-B（第 B 组）

> 本文件是**第二次精审 273 条**中分配给窗口 W4-B 的部分。
> 30 个 P0 已全部修复并推送（基线已验证：构建通过、**3695 项测试全绿**、6 项校验脚本全过）。
> **本批只处理 P1 / P2，不要再碰已修的 P0。**

| 项 | 值 |
|---|---|
| 条目 | **15**（P1 12 / P2 3） |
| 单元 | **7** 个 |
| 来源批次 | batch1、batch5 |
| 所属组 | **第 B 组**（全库 16 窗口 = 2 组 × 8 窗） |
| 交叉验收 | 你修完后，验收 **W4-A**（同编号的另一组窗口） |

---

## 0. 一句话任务

按第 3 节清单逐条修**你这一批**的 P1（先做）和 P2（后做）。
**每条修复必须配一条"修复前会失败"的回归测试**，外加一条"防止矫枉过正"的对照用例。

完工后按 `audit/review_B.md` 验收 **W4-A**。

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
dialogue  fov  joystick-mover  mover  rebind  reddot  shop
```

---


## 【P1】先做这批

### P1 · [dialogue] 所有选项条件都不满足时，对话进入无法前进也无法退出的死锁

- **位置**：`dialogue/DialogueGraph.ts:272-285`（`advance`：有 choices 就直接 `return false`）、`:293-307`（`choose`：条件不满足 `return false`）、`:319-324`（`end` 存在但没有"无路可走"的自动退出）
- **证据**：
  ```
  节点 n1 有两个选项，condition 都是 () => false
  choices=[{index:0,enabled:false},{index:1,enabled:false}]
  choose(0)=false  choose(1)=false  advance()=false
  isDone=false     ← 既不能选、也不能进、也不能结束
  ```
- **后果**：条件对话（"需要钥匙""需要好感度≥80"）是标配。当玩家状态不满足任何分支时，UI 会显示两个灰掉的按钮加一个点了没反应的"继续"。`showDisabled` 字段（`:73`）说明作者考虑过禁用态，但没考虑"全禁用"。玩家只能杀进程。
- **建议**：`advance()` 在"有 choices 但无一 enabled"时返回 false 的**同时**提供 `hasEnabledChoice()` 之类的查询，或在 `advanceToChoice`（`:335-345`）里把"无可用选项"视为终态并 `end()`。至少要让调用方能检测到这个状态。

其他复核：`validate()`（`:147-164`）对 choices 与 next 的悬空引用检查完整、且正确区分了"有 choices 时不校验 next"；`findUnreachable` 用 BFS + `seen` 集合，无死循环；`_history` 只增不减（`:358`），超长对话（galgame 式）会累积——**P2**。`destroy()` 在 Graph 与 Runner 上都有，清得干净。

---

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

### P1 · [joystick-mover] `evaluate()` 返回内部复用的同一个可变对象，调用方持有的引用会被后续帧改写

- **位置**：`joystick-mover/JoystickCore.ts:102`（`private readonly _out`）、`:210-249`（每次 `evaluate` 都是写这个 `_out` 并 `return o`）
- **证据**：
  ```js
  const a = j.evaluate();   // 此时 magnitude 0.5
  j.onMove(1, 100, 0);
  const b = j.evaluate();   // magnitude 1
  a === b        → true
  a.magnitude    → 1        ← a 被改写成了 b 的值
  a.dir === b.dir → true
  ```
- **后果**：本意是"每帧零分配"（热路径优化，意图是对的），但 `JoystickOutput` 是导出接口，调用方天然会认为它是**值**。典型踩法：`this.lastDir = core.evaluate().dir`（存了个引用做方向平滑或比较"方向是否变化"）——下一帧这个引用就被覆盖了，平滑失效、比较恒等。Cocos 侧 `JoystickMover._updateVisual`（`:225-232`）自己是用 `_lastX/_lastY` 逐字段缓存的，**侥幸**避开了，但这说明陷阱确实存在且库作者自己都在防。
- **建议**：JSDoc 顶部用醒目文字写明"返回的对象每帧复用，需要保存请自行拷贝 `dir`"，或提供 `evaluateInto(out)` 与 `snapshot()` 两个方法。
- **影响面**：`JoystickMover.output`（`:83-85`）直接透出这个对象，是整个单元对外的主入口，风险面最大。

其他复核：`onDown` 的 `EXTERNAL_DRIVE_ID = -1`（`:41`、`:131`、`:279`）把"手柄/键盘驱动"与"触摸驱动"分流，设计干净；`_snap` 的方向吸附（`:251-256`）用 `Math.round(a/step)*step`，正确；`onUp`/`reset` 在 dynamic 模式下重置 center（`:198-201`）正确；`onDestroy`（`:242-254`）把四个 `Node.EventType` 监听全部 `off`、清空三个回调、销毁 core——是本批**生命周期处理最规范**的一处（`reddot`/`crash` 都该照这个改）。引擎耦合 `cc` 只出现在 `JoystickMover.ts`，`JoystickCore` 保持纯逻辑，分层符合 `_kitmeta` 的 `engineCoupled: true` 声明。

---

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

### P1 · [reddot] `activePaths()` 是 O(n²)：对每个叶子做一次全表 `get()`

- **位置**：`reddot/RedDot.ts:167-169`（`[...this._leaf.keys()].filter((p) => this.get(p) > 0)`）对照 `:115-135`（`get` 内部 `for (const [p, n] of this._leaf)` 全表扫描）
- **证据**：实测耗时随叶子数呈二次增长
  ```
  n=500  -> 5ms
  n=1000 -> 5ms
  n=2000 -> 28ms    （n 翻倍，耗时 5.6 倍）
  n=4000 -> 95ms    （n 再翻倍，耗时 3.4 倍）
  ```
- **后果**：红点树在 UI 层通常每帧或每次数据变更时全量刷新一次。一个中等复杂度的红点树（邮件 / 任务 / 商店 / 成就 / 好友，每类几百个叶子）轻松到几千节点，`activePaths` 一次 100ms 会直接掉帧。而且它是**静默劣化**：开发期红点少，上线后内容变多才暴露。
- **建议**：单次遍历建前缀累加表（`Map<string, number>`，对每个叶子把其所有祖先加上 n），O(n·depth) 一次算出所有节点的值；或给 `get` 加按前缀分层的缓存。

其他复核：`get` 的 `hasOwnProperty` 式误匹配问题已用 `path + sep` 前缀规避（实测 `get('mail')=3` 不含 `mailbox` 的 100），正确；`set` 的 `Number.isFinite` 守卫（`:67-69`）到位，`add(NaN)` 会抛错而不是静默；`override` 的 `null` 语义正确。**无 `destroy()`**（见跨单元共性问题 C-3）。

---

### P1 · [shop] `_log` 无容量上限，长期运行无限增长

- **位置**：`shop/Shop.ts:128-134`（声明）、`:315`/`:338`（push）、`:407-409`（只有 `clearLog`）
- **证据**：连续 5000 次购买后 `log.length = 5000`（对照 `currency` 的 `logLimit` 默认 200 且可裁剪）。
- **后果**：商店流水是服务器常驻进程里增长最快的日志之一（每个玩家每次购买一条）。没有上限意味着一次会话累积几十万条后内存与 `netSpent()` 的遍历（`:391-397` 每次全表扫描）同步劣化。
- **建议**：加 `logLimit` 选项并用 `clampNum` 收口，与 `Wallet` 对齐。

其他复核：`stock.count` 的 `-1 = 无限库存` 语义在三处（`:297`、`:313`、`:336`）一致且正确；`preview` 与 `buy` 的判据一致（不会预览通过但购买失败）；`restock` 的 `stockRange` / `markupRange` 未校验 `min > max`（会产生负数 count → 恰好等于"无限库存"）——**P2**。`destroy()`（`:411-416`）清理完整。零依赖，无 rule6 违规。

---


## 【P2】P1 完成后再做

### P2 · [fov] （见正文）

- `Raycasting` 构造函数缺尺寸校验（`Shadowcasting` 在 `:182` 有 `throw`），两个实现标准不一致。
- `compute` 每次 `toArray()` 导出全图（O(w·h) + 分配）；`Raycasting.compute` 的 perimeter 每次新建数组与对象（`:466`~`:473`）。

### P2 · [mover] （见正文）

- `addImpulse` `:240`~`:241` 用**单次冲量**的 `mag2` 而非合成后的总外力判断 `knocked` → 多个小击退合成很大时 `knocked` 仍为 false，玩家在明显被推开时仍有完全控制权。
- `knockbackThreshold` 用 `<= 0` 判断是否"未指定"，显式传 0 会被静默改写成 `maxSpeed * 0.25`；`stoppingTime` 硬编码 1e6 上界；无 `destroy()`。

### P2 · [rebind] （见正文）

- `resetToDefault` `:308`~`:324` 对"当前有绑定但没有默认值"的动作静默丢弃（先 clear 再只填有 default 的）。
- 缺 `destroy()`（rule5）；`_removeRaw` 里 `:393`/`:394` 重复调用了 `encodeBinding`。


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

新建 `tests/run_phase10_w4b.ts`，并**在文件内导出** `runPhase10W4BTests()`：

```ts
export function runPhase10W4BTests(): void {
  // ...
}
```

⚠️ **`tests/run.ts` 由总审统一合并注册，你不要改它。**
（16 个窗口同时改同一个文件必然冲突。）你只需保证自己的文件能独立通过 `tsc`。

### 5.3 报告

完成后产出 `audit/result_W4-B.md`，每条一行：

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
| **文件命名** | `run_phase10_w4b.ts` / `result_W4-B.md`，带窗口号，避免撞名 |

---

## 7. 完工后的交叉验收

你属于**第 B 组**。修完之后，按 `audit/review_B.md` 验收 **W4-A**（同编号的另一组窗口）。

验收时**不要直接改对方的代码**（会和对方窗口冲突）。发现问题写进 `audit/verify_W4-B.md`，
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
