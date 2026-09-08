# 交叉验收任务书 · 第 B 组

> 你已完成自己那批的修复。**现在验收第 A 组。**
> 每人验收**同编号**的那个窗口：
>
> - `W1-B` 验收 `W1-A`
> - `W2-B` 验收 `W2-A`
> - `W3-B` 验收 `W3-A`
> - `W4-B` 验收 `W4-A`
> - `W5-B` 验收 `W5-A`
> - `W6-B` 验收 `W6-A`
> - `W7-B` 验收 `W7-A`
> - `W8-B` 验收 `W8-A`

---

## 0. 你要做什么

对分配给你的那一个窗口的**全部交付物**做一次独立验收，产出
`audit/verify_W{1..8}-B.md`。

**验收不是"看一遍觉得对"，是逐条独立验证。** 下面第 2 节五条硬标准，每条都要给出判断依据。

⚠️ **验收方不直接改对方代码** —— 会和对方窗口冲突。
发现问题写进报告，回报给对方窗口或总审，由对方改。

---

## 1. 你要验收的对象

### 全组 8 个窗口一览

| 被验收窗口 | 条目 | P1 | P2 | 单元 | 单元名 |
|---|---|---|---|---|---|
| `W1-A` | 20 | 17 | 3 | 8 | `builder craft crash cutscene debug-console gesture matchops skill-variant` |
| `W2-A` | 19 | 14 | 5 | 10 | `attribute command diagpack indicator logger pathfinding runscope scheduling skill-caster social` |
| `W3-A` | 16 | 10 | 6 | 6 | `camera interact perception score settings tween` |
| `W4-A` | 15 | 9 | 6 | 6 | `bullet-pattern difficulty entity gameflow i18n matchmaking` |
| `W5-A` | 15 | 9 | 6 | 9 | `behavior-tree fsm number-roller quest signal skill-queue steering telemetry turn` |
| `W6-A` | 13 | 11 | 2 | 3 | `di noise timeutil` |
| `W7-A` | 12 | 4 | 8 | 4 | `dash grid objective progressbar` |
| `W8-A` | 12 | 9 | 3 | 3 | `autoquality loot meta` |

各自的完整任务书：`audit/handoff_W1-A.md` ~ `audit/handoff_W8-A.md`
应产出：`audit/result_W{1..8}-A.md` + `tests/run_phase10_w{1..8}a.ts`

### 逐条清单（用于核对"是否每条都处理了"）


#### W1-A（20 条）

- `P1` `builder` — `PlaceResult.missing` 声明了但从未被填充
- `P1` `builder` — `rotateCell` 对非法角度静默返回原值
- `P1` `craft` — `totalMaterials` 递归时忽略子配方的产出倍率，材料需求被高估
- `P1` `craft` — 副产物被背包丢弃时静默消失
- `P1` `craft` — 全部 `consume:false` 的配方，`canCraft` 返回 `ok:true` 但 `maxCount:0`
- `P1` `crash` — `_seen` 指纹表只增不减，且 `dedupeWindow` 过期后不清理
- `P1` `crash` — 采样用裸 `Math.random`，不可复现、不可测试
- `P1` `cutscene` — `Timeline.with()` 与 README 不符：实测是"紧接播放"而非"与上一个同时开始"
- `P1` `cutscene` — `update(dtMs)` 无 dt 守卫，NaN / 负 dt 静默丢弃时间
- `P1` `debug-console` — `execute()` 把命令内部异常 **rethrow 给调用方**，与"控制台捕获一切"的定位相反
- `P1` `debug-console` — `_coerce` 的 `int` 用 `Number.isInteger(Number(token))`，空串/空白被当成 0
- `P1` `gesture` — `maxPoints` 裁剪丢弃轨迹起点，长按时长被算短 → 长按判不出来
- `P1` `matchops` — `ReconnectTracker` 的 `graceMs` / `graceDecay` 为 `NaN` 时，重连宽限期变成"永不过期"
- `P1` `matchops` — `Surrender.vote` 对掉线玩家返回 `ok:true`，但票不被计入
- `P1` `skill-variant` — `applyPatch` 的 switch 无 default，未知 op 静默无操作
- `P1` `skill-variant` — 数值 op 未校验结果有限性，`mul: NaN` 把技能数据污染成 NaN
- `P1` `skill-variant` — 互斥检查只处理"第一个冲突者"，三变体互斥场景漏检
- `P2` `cutscene` — `update` 的 `guard < 64` 上限是魔法数
- `P2` `debug-console` — `_history` 的"去重"只看上一条
- `P2` `debug-console` — `list()` 每次调用都 `sort`，且 `_resolve` 是 O(n) 遍历（无 alias 索引）

#### W2-A（19 条）

- `P1` `attribute` — `clearModifiers()` 不触发 `onChange`，UI 在"移除 buff"时不刷新
- `P1` `attribute` — `override` 与 `add` 的叠加顺序写成了"三元左右相等"的死代码
- `P1` `command` — `rollback()` 里的空 catch 吞掉 undo 异常
- `P1` `diagpack` — `safeStringify` 把"共享引用"误判成循环引用，静默丢数据
- `P1` `diagpack` — 脱敏把 JSON 结构改坏（且失败时空 catch 静默跳过）
- `P1` `indicator` — `compute()` 返回的中心与 `centerFor()` 返回的中心不一致（同一套配置两个答案）
- `P1` `logger` — `log()` 里的 Silent 判断是空 if 块，Silent 下仍在分配对象并写环形缓冲
- `P1` `pathfinding` — `findPath` 只校验终点可走，不校验**起点**可走，起点在墙里照样返回路径
- `P1` `runscope` — 用原型链上的键访问时 `has()` 返回 true 但 `get/set` 崩溃（已知 easing() 原型污染的新实例）
- `P1` `runscope` — `getOr` 用 try/catch 吞掉了 strict 模式的核心保护
- `P1` `scheduling` — `StepContext.elapsed` 恒为 0，接口承诺的字段从不赋值
- `P1` `skill-caster` — `resetCooldown()` 把充能数留在旧值，导致 `chargesLeft` 变负、技能可用性错乱
- `P1` `social` — `statsOf().byReason` 是残缺对象，未出现的 reason 读到 `undefined`，参与运算得 NaN
- `P1` `social` — `abuseThreshold` 等阈值配置未收口，NaN 让"恶意举报识别"永久失效
- `P2` `diagpack` — （见正文）
- `P2` `indicator` — `ring` 类型的 `innerRadius` 在 `_buildShape()` 里被丢弃
- `P2` `logger` — （见正文）
- `P2` `runscope` — （见正文）
- `P2` `scheduling` — （见正文）

#### W3-A（16 条）

- `P1` `camera` — `CameraFollow.update()` 在 `smoothDamp` 之后又做了一次 `maxSpeed` 限速，构成双重限速
- `P1` `camera` — `offsetRotation` 是对外承诺但恒为 0 的死接口（README 已列出该 API）
- `P1` `camera` — `CameraFollow` 没有 `destroy()`，而同单元的 `CameraShake` 有
- `P1` `interact` — `Interactable` 接口没有 `pos` 字段，实现却靠双重强转去取——类型系统与文档对不上
- `P1` `perception` — 抖动用裸 `Math.random` 参与警觉度累积，而注释声称"只影响观感"——与实际不符
- `P1` `perception` — `PerceptionSystem` 无 `destroy()`
- `P1` `score` — 指标被设成 NaN 后总分变 NaN，静默评为最低档
- `P1` `settings` — `importState()` 对非法值静默跳过，返回值却暗示"导入成功"
- `P1` `settings` — `importState()` 直接写 `_values`，绕过 `set()`，不触发 `onChange`
- `P1` `tween` — `ease()` 用 Record 查表，原型键被当成缓动函数（已知 easing() 原型污染的新实例）
- `P2` `camera` — （见正文）
- `P2` `interact` — （见正文）
- `P2` `perception` — （见正文）
- `P2` `score` — （见正文）
- `P2` `settings` — （见正文）
- `P2` `tween` — （见正文）

#### W4-A（15 条）

- `P1` `bullet-pattern` — 用自定义 `ShapeFn` 时，所有子弹速度恒为 0
- `P1` `bullet-pattern` — `interval` 的 `<= 0` 校验挡不住 NaN → 发射器永远不开火
- `P1` `bullet-pattern` — `compileShape` 的 `count` 未收口：NaN 变 0 发，null 变 1 发
- `P1` `entity` — 回调里注销自己 → 下一个回调被静默跳过
- `P1` `entity` — `destroy(id)` 对无效 id 有两种相反返回值
- `P1` `gameflow` — `historyLimit <= 1` 时历史裁剪失效，`_history` 无限增长（内存泄漏）
- `P1` `i18n` — `onChange` 只存单个回调，第二个订阅者静默顶掉第一个
- `P1` `i18n` — `has()` 与 `t()` 判定口径不一致
- `P1` `i18n` — 覆盖率统计认 6 种复数形式，运行时只认 2 种
- `P2` `bullet-pattern` — （见正文）
- `P2` `difficulty` — （见正文）
- `P2` `entity` — （见正文）
- `P2` `gameflow` — （见正文）
- `P2` `i18n` — （见正文）
- `P2` `matchmaking` — （见正文）

#### W5-A（15 条）

- `P1` `behavior-tree` — `Wait` / `CooldownDecorator` 的秒数未收口：一个 NaN 让 AI 永久卡死或让冷却彻底失效
- `P1` `number-roller` — `snapTo` 缺有限性校验，一个 NaN 让计数器永久显示 "NaN"
- `P1` `quest` — `import()` 不校验 `status` 与 `progress` 元素类型
- `P1` `signal` — 同一函数注册多次时，一次取消会把所有同名注册项全部删掉
- `P1` `skill-queue` — `window` 的 setter 用 `Math.max(0, v)`，传 `NaN` 会让所有排队项立即过期
- `P1` `steering` — `mass` 未校验 → mass=0 直接产出 Infinity 坐标
- `P1` `steering` — `wander` 默认走裸 `Math.random`，与 F 类"随机数注入"直接冲突
- `P1` `telemetry` — `maxRetries` 未收口 → 第一次发送失败就永久丢数据，与 JSDoc 矛盾
- `P1` `turn` — `start(shuffleEqual = true)` 声称打乱同先攻单位，实际完全不打乱
- `P2` `behavior-tree` — （见正文）
- `P2` `fsm` — `can()` 在"转换表存在但当前状态缺项"时返回 true，白名单形同虚设
- `P2` `fsm` — `reset()` 不检查 `_transitioning`、不触发 `onChange`；`start()` 可重复调用
- `P2` `number-roller` — （见正文）
- `P2` `steering` — （见正文）
- `P2` `telemetry` — （见正文）

#### W6-A（13 条）

- `P1` `di` — `register(..., {override:true})` 覆盖后，旧单例**不会被 destroy**
- `P1` `di` — `fork()` 不复制 `_disposers`，子容器 destroy 时父注册的可销毁服务一个都不销毁
- `P1` `di` — `disposable()` 配 `lifetime:'transient'` 时永不销毁，且无任何提示
- `P1` `noise` — 非有限 seed 静默退化为 seed 0，所有"随机地图"变成同一张
- `P1` `noise` — `fbm2D` / `ridged2D` 的 `octaves` 为 Infinity 时死循环
- `P1` `noise` — `fbm2D` 对 `octaves=NaN`、`octaves=-1`、`lacunarity=0` 无校验，静默返回 0 或退化
- `P1` `noise` — `islandMask(1, 1)` 返回 NaN
- `P1` `timeutil` — `isNewDay(now, lastSeen)` 的参数名与实现语义不符，按参数名传时间戳将**永远返回 false**
- `P1` `timeutil` — `Countdown.pause()` 后 `state()` 仍返回 `'running'`
- `P1` `timeutil` — `ticksSince(periodMs = NaN)` 返回 NaN，且只挡了 `<= 0`
- `P1` `timeutil` — 固定 `offsetMinutes` 无法表达夏令时，欧美时区在半年里日界错 1 小时
- `P2` `di` — `destroy()` 里的 `console.error`
- `P2` `noise` — `SimplexNoise.noise3D` 是"伪 3D"，且 `PerlinNoise` 导出后无人使用

#### W7-A（12 条）

- `P1` `dash` — 多层充能永远回不满：只有充能耗尽到最后一层才启动冷却
- `P1` `dash` — `duration` / `distance` 未收口 → 一个 NaN 让角色坐标永久变 NaN
- `P1` `grid` — NaN 坐标能"放置成功"但成为幽灵建筑，且 `freeCount` 不减
- `P1` `grid` — README 与源码 JSDoc 的 `find` 示例签名是错的
- `P2` `dash` — （见正文）
- `P2` `grid` — （见正文）
- `P2` `objective` — 事件顺序：先发 `completed`，再补发一个 `progress`
- `P2` `objective` — `setProgress` / `addProgress` 不校验有限性
- `P2` `objective` — 无 `destroy()`；`reset()` 不触发任何 `onEvent`
- `P2` `progressbar` — `lowThreshold` / `highThreshold` 未收口，同一构造函数里两套标准
- `P2` `progressbar` — `segmentBounds` 的 gap 分摊不对称
- `P2` `progressbar` — 构造校验挡不住 NaN；无 `destroy()`

#### W8-A（12 条）

- `P1` `autoquality` — `setManualLevel` 写入的 history 记录 from === to，切换前档位丢失
- `P1` `autoquality` — `FpsMeter` 的窗口大小未收口，NaN 直接构造数组崩溃
- `P1` `loot` — 子表互相引用时 `roll()` 无限递归栈溢出
- `P1` `loot` — `pickUnique` 与 `setWeight(v, 0)` 语义冲突，直接抛错
- `P1` `loot` — `PRD._cache` 是静态 Map，只增不减无上限
- `P1` `loot` — `Chest.importState` 不校验索引，越界时静默产出 `undefined` 选项
- `P1` `meta` — `requires` 里写了不存在的节点 id 时，依赖被静默跳过
- `P1` `meta` — `set` 效果被等级缩放（与 blessing/curse 同款）
- `P1` `meta` — `setLevel` 的 NaN 让"是否解锁"与"是否生效"自相矛盾
- `P2` `autoquality` — （见正文）
- `P2` `loot` — （见正文）
- `P2` `meta` — （正面样本）

---

## 2. 五条硬标准（每条都要给判断依据）

### 标准 1 · 是否真的复现过

看对方 `result_W{n}-A.md` 里每条的"复现输出（修复前）"列。

- ✅ 通过：有具体的运行输出（数字、序列、报错信息），不是"理论上会……"
- ❌ 不通过：只写了"代码分析表明……"、或直接抄了原报告的证据

**注意**：原报告里的"证据"是别的窗口写的。你要看的是**对方自己跑出来的输出**。

### 标准 2 · 测试是否真的会失败

这是最容易糊弄过去的一条。常见失效形态：

```ts
// ✗ 恒通过：断言的是"修复前后都一样"的东西
test('NaN 不应毒化', () => {
  const x = compute(5);
  assert(Number.isFinite(x));   // 传 5 本来就不会 NaN —— 这用例测了个寂寞
});

// ✓ 有效：断言的是修复后才会成立的行为
test('NaN 不应毒化', () => {
  const x = compute(NaN);       // 关键：喂的是会触发 bug 的输入
  assert(Number.isFinite(x));
});
```

**怎么验**：读测试代码，找到断言，问一句——
"**如果把这个修复回退掉，这条断言还会通过吗？**"
如果答案是"照样通过"，这条用例是无效的。

⚠️ **不要用"改回旧代码跑一遍"的方式验证**。
沙盒偶发 502 会中断构建并损坏 `.build/`，且 `build.sh` 会整体替换产物
（已真实发生过一次，导致 P0-3 的修复被误删）。
要验证就写**独立只读脚本**调用公开 API，复现"修复前行为"。

### 标准 3 · 有没有对照用例（防止矫枉过正）

每条修复都要有一条"正常输入不受影响"的对照。没有的话，
说明对方可能把合法输入也一起拦了。

典型反例（真实发生过的）：

- 把 `maxVoices` 夹成 `[1,512]`，结果合法的"静音配置 0"也被夹成 1
- 把 `prewarm` 的预热数夹到 `maxSize` 以内，破坏了两者**独立的契约**

**怎么验**：看测试里有没有一组"正常值"的断言。

### 标准 4 · 有没有顺手重构

对比对方的改动范围是否超出"修这一条"的必要范围。

- ✅ 通过：只改了必要那几行
- ❌ 不通过：顺手改了命名、调整了结构、删了"看着没用"的代码

这个库大量"看起来别扭"的写法都带长注释解释原因。
顺手改掉，很可能破坏另一个单元赖以正确工作的前提。

### 标准 5 · 有没有把"设计如此"误判成 bug

这是本项目**最容易复发**的一类错误，方向与漏修相反：把故意的设计当成缺陷"修"掉了。

已知的真实案例：

- **相切语义**：`ds.rectsOverlap`（不含相切，服务空间索引）与
  `_core.rectOverlaps`（含相切，通用 AABB）——**两者都对，不能统一**。
  已有一条断言"两者结果必须不同"在守着，谁对齐成一致谁测试变红。
- **`display()` 用 0 兜底无记录**：那是合法单位元，不是 bug；要拦的是 NaN 进 record。
- **`prewarm` 不受 `maxSize` 限制**：预分配与回收上限是两个独立契约。

**怎么验**：看对方改动的地方，原代码有没有注释解释"为什么这么写"。
有注释而对方没反驳就改了 —— 重点怀疑。

---

## 3. 还要核的两件事

1. **全量回归仍然全绿**：`node .build/tests/run.js`，条数只增不减
2. **六个校验脚本全过**：
   ```bash
   node scripts/check-deps.js && node scripts/check-links.js
   python3 scripts/scan-dt-guard.py && python3 scripts/scan-num-guard.py
   python3 scripts/check-random-source.py && python3 scripts/check-dup-exports.py
   ```

---

## 4. 报告格式

产出 `audit/verify_W{1..8}-B.md`：

```
# 验收报告 · W{n}-B 验收 W{n}-A

## 结论
（通过 / 有条件通过 / 不通过）

## 逐条验收
| 条目 | 标准1复现 | 标准2测试有效 | 标准3对照用例 | 标准4无顺手重构 | 标准5未误判设计 | 备注 |
```

## 发现问题的处理
- **小问题**（注释不到位、缺对照用例）：直接标注，建议对方补
- **实质问题**（测试无效、误判设计、顺手重构）：**标红**，必须对方返工
- **不确定**：标"需总审裁决"，说明两种选择的利弊，**不要自己拍板**

## 附：全库校验结果
（贴出全量回归与 6 个校验脚本的输出）
