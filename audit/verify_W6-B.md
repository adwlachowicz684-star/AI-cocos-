# 验收报告 · W6-B 验收 W6-A

> 被验收窗口：**W6-A**（单元 `di` / `noise` / `timeutil`，13 条 = P1 11 + P2 2）
> 任务书：`audit/handoff_W6-A.md`
> 验收依据：`audit/review_B.md` 五条硬标准
> 验收方式：**独立只读取数脚本**调用公开 API 复现（未按标准 2 禁止的方式回退代码）

---

## 结论

**无法验收 —— 交付物缺失。**

| 应交付物 | 是否存在 |
|---|---|
| `audit/result_W6-A.md` | ❌ 不存在 |
| `tests/run_phase10_w6a.ts` | ❌ 不存在 |

`audit/` 下只有 `result_W7-A.md`，`tests/` 下只有 `run_phase10_w7a.ts` —— **A 组目前只有 W7-A 交付了**。
标准 1（是否真的复现过）、标准 2（测试是否真的会失败）、标准 3（有没有对照用例）
全部依赖对方的报告与测试文件，**对象不存在，这三条无法给出判断**。

为避免这份验收变成"什么都没做"，我做了两件替代工作：

1. 用只读取数脚本**独立复现了 13 条**，确认每条在当前代码上的真实状态（第 2 节）。
   结论：**13 条里 11 条仍能复现（未修），1 条已修/不成立，1 条部分修**。
2. 按标准 5 逐条检查了"会不会被误判成 bug"（第 3 节），标出 2 处需要总审裁决的。

---

## 1. 逐条验收

| # | 条目 | 标准1复现 | 标准2测试有效 | 标准3对照用例 | 标准4无顺手重构 | 标准5未误判设计 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | `di` override 后旧单例不 destroy | — | — | — | — | — | **仍能复现（未修）** |
| 2 | `di` fork 不复制 `_disposers` | — | — | — | — | — | **仍能复现（未修）** |
| 3 | `di` transient + disposable 永不销毁 | — | — | — | — | — | **仍能复现（未修）** |
| 4 | `di` destroy 里的 console.error（P2） | — | — | — | — | — | **仍存在（未修）** |
| 5 | `noise` 非有限 seed 退化为 seed 0 | — | — | — | — | — | **仍能复现（未修）** |
| 6 | `noise` octaves=Infinity 死循环 | — | — | — | — | — | **已不成立**（见第 2 节） |
| 7 | `noise` octaves=NaN/-1、lacunarity=0 | — | — | — | — | — | **部分修**（NaN/-1 已拦，lacunarity=0 未拦） |
| 8 | `noise` islandMask(1,1) 返回 NaN | — | — | — | — | — | **仍能复现（未修）** |
| 9 | `timeutil` isNewDay 参数名与语义不符 | — | — | — | — | — | **仍能复现（未修）** |
| 10 | `timeutil` Countdown.pause 后 state 仍 running | — | — | — | — | — | **仍能复现（未修）**，且需总审裁决 |
| 11 | `timeutil` ticksSince(periodMs=NaN) 返回 NaN | — | — | — | — | — | **仍能复现（未修）** |
| 12 | `timeutil` offsetMinutes 无法表达夏令时 | — | — | — | — | — | **仍能复现（未修）**，需总审裁决 |
| 13 | `noise` SimplexNoise.noise3D 伪 3D / PerlinNoise 无人用（P2） | — | — | — | — | — | **未改**（属清理类，可延后） |

> 表格中"—" = 无交付物可评，不是"通过"。

---

## 2. 独立复现结果（只读取数脚本，当前代码）

以下都是我**自己跑出来的输出**，不是抄原报告。

### di

```
1) override 后旧单例被销毁?        => {"旧实例已destroy": false}         ← 未修
2) fork 后子容器 destroy 父服务    => {"父服务销毁次数": 0, "期望": 1}   ← 未修
   子容器 _disposers 长度          => 0                                  （确认未复制）
3) transient+disposable            => {"创建次数": 3, "销毁次数": 0}     ← 未修
4) destroy() 里的 console.error    => 源码 di/DIContainer.ts:275 仍在    ← 未修
```

三条的成因同源：`disposable()` 里 `if ((opts.lifetime ?? 'singleton') === 'singleton')` 才注册销毁器，
于是 transient 直接没有销毁器（第 3 条）；而 override 只是在 `register` 里 `this._singletons.delete(key)`，
**没有调用对应 disposer**（第 1 条）；`fork()` 只复制了 `_regs`，没复制 `_disposers`（第 2 条，实测子容器 disposers 数为 0）。

### noise

```
5) new PerlinNoise(NaN).noise2D(1.5, 2.5)  => 0
   new PerlinNoise(0).noise2D(1.5, 2.5)    => 0      ← NaN 与 0 同结果，未修
   new PerlinNoise(1).noise2D(1.5, 2.5)    => 0.175  （对照：有效种子有值）

6) fbm2D(..., {octaves: Infinity})  => TypeError [guard] opts.octaves 必须是有限数值，实际 Infinity
7) fbm2D(..., {octaves: NaN})       => TypeError 同上
   fbm2D(..., {octaves: -1})        => RangeError  [guard] opts.octaves 不能为负
   fbm2D(..., {lacunarity: 0})      => 0.5         ← 无校验，未修
   fbm2D(..., {octaves: 4})         => 0.5         （对照）

8) islandMask(1, 1)  => [NaN, ...]                   ← 未修
   islandMask(3, 3)  => [0, 0, 0, 0, ...]            （对照）
```

**第 6 条判定"已不成立"的依据**：`fbm2D` / `ridged2D` 现在都用了 `needCount(opts.octaves ?? 4, 'opts.octaves', 64)`，
Infinity 会被直接拦住并抛错，不会死循环。源码注释里"实测 fbm(0,0,{octaves:Infinity})：静默返回 0"
是**修复前**的实测记录，已被写进注释——说明这一条**此前已被修过**（P0 阶段或 W6-A 已推送但未写报告）。
**请 W6-A 窗口确认这是谁修的**，如果确实已修，报告里应标"已修（由 P0 阶段覆盖）"而不是留空。

**第 8 条根因**：`islandMask` 里 `cx = (width - 1) / 2`，`width = 1` 时 `cx = 0`，
于是 `(x - cx) / cx` 是 `0 / 0` → NaN，整张 mask 全是 NaN。
`width = 2` 时 `cx = 0.5` 不出 NaN（实测正常），所以只有 1×1 会中。

### timeutil

```
9) isNewDay(now, lastSeen时间戳)   => false   ← 按参数名传时间戳永远 false，未修
   isNewDay(now, dayIndex(上次))   => true    （按 JSDoc 传日序号才对）

10) Countdown: start(NOW) → pause(NOW+100) → state(NOW+100) => "running"   ← 未修
    未暂停对照 => "running"；结束对照 => "finished"；未开始对照 => "waiting"

11) ticksSince(0, 1000, NaN)   => NaN      ← 未修（periodMs <= 0 挡不住 NaN）
    ticksSince(0, 1000, -1)    => 抛错 "periodMs 必须为正"
    ticksSince(0, 1000, 0)     => 抛错
    ticksSince(0, 1000, 300)   => 3        （对照）

12) Zones.US_EASTERN.offsetMinutes => -300（固定 -5 小时，夏令时应为 -4）← 未修
```

**第 9 条补充**：JSDoc 写的是"上次记录的日序号（0 = 从未）"，**实现是对的，命名是错的**。
真正的风险不是行为错，而是调用方按 `lastSeen` 这个名字传时间戳 → 永远 false → "每日奖励永远不刷新"。
建议改参数名为 `lastDayIndex`（位置参数不变，不是 breaking），或至少在 JSDoc 顶部加粗警示。

---

## 3. 标准 5 检查：有没有"设计如此"被误判

逐条看了原代码里是否有注释论证"这是故意的"：

| 条目 | 原代码有无"设计如此"的注释 | 我的判断 |
|---|---|---|
| `di` 三条 | 无 | 是真缺陷，可修 |
| `noise` seed | 无 | 是真缺陷，可修 |
| `noise` lacunarity=0 | 无 | 真缺陷，但危害小（退化成常值），优先级可低 |
| `islandMask(1,1)` | 无 | 真缺陷（1×1 是退化输入，但 NaN 会一路污染高度图） |
| `timeutil` isNewDay | 有（JSDoc 写的是日序号） | **实现正确，是命名问题**——按"命名"修会改错地方 |
| `Countdown` state | 有（`CountdownState = 'waiting' \| 'running' \| 'finished'`） | **类型里根本没有 `'paused'`**，见下 |
| `ticksSince` maxTicks | 有（"用 maxTicks 夹紧——这是设计决定，不是优化"） | 该注释守护的是 **maxTicks 夹紧**，**不是** NaN 穿透，两者不冲突，可修 |
| `offsetMinutes` 夏令时 | 有（`Zones` 是静态常量表） | **架构限制**，见下 |

### 需要总审裁决的 2 处

**① Countdown 的 'paused' 状态（第 10 条）**

`CountdownState` 只有 `'waiting' | 'running' | 'finished'`，**没有 `'paused'`**。
要修就得给联合类型加一个成员 —— 所有 `switch (c.state(now))` 的调用方都会失去穷尽性检查的保护，
运行时多一个分支要处理。

- 方案 A（加 `'paused'`）：语义最清楚，但**是 breaking**，调用方必须处理新分支。
- 方案 B（不加，改文档）：在 JSDoc 里写清"暂停期间 `state()` 仍返回 `'running'`，
  用 `isPaused()` 或 `remaining()` 判断"——零 breaking，但反直觉。

我倾向 **A + 同时提供 `isPaused()`**（既有穷尽性又有便利方法），但这属于对外 API 变更，**请总审裁决**。

**② offsetMinutes 与夏令时（第 12 条）**

`Zones` 是一张静态常量表，`offsetMinutes` 是固定值。要支持夏令时，
必须改成 `getOffsetMinutes(now)` 或引入 `Intl.DateTimeFormat` 的时区数据库。

- 影响面：`startOfDay` / `startOfNextDay` / `dayIndex` / `msUntilNextDay` 全要改成"按 now 动态取偏移"。
- 这不是"修 bug"，是**改架构**。而且铁律第 3 条要求"运行时依赖 0、不 import 第三方包"，
  用 `Intl` 属于宿主 API，需要确认是否合规。
- 折中：保留静态表（简单场景够用），**额外**提供一个 `ZoneFn` 变体或文档警示
  "欧美时区在夏令时期间日界会差 1 小时"。

**请总审裁决**是否在本轮做，还是降级为"文档警示 + 后续专项"。

---

## 4. 附：全库校验结果（验收时点）

```
bash build.sh                        → TSC OK（产物校验通过：212 个 .js）
node .build/tests/run.js             → 通过 3695 项，失败 0 项
node scripts/check-deps.js           → 全部通过 ✓
node scripts/check-links.js          → 44 条链接，断链 1 处（非本窗口引入）
python3 scripts/scan-dt-guard.py     → 命中 0 处 ✓
python3 scripts/scan-num-guard.py    → 命中 0 处 ✓
python3 scripts/check-random-source.py → [OK] ✓
python3 scripts/check-dup-exports.py → [OK] ✓
```

断链位于 `audit/handoff_W3-B.md:268`（示例代码被链接扫描器误判），**属 W3-B 窗口**，
与本窗口和 W6-A 都无关，已另行报告。

---

## 5. 给 W6-A 窗口 / 总审的行动项

1. **请 W6-A 补交付**：`audit/result_W6-A.md` + `tests/run_phase10_w6a.ts`。
   我这份报告里第 2 节的复现输出可以直接作为标准 1 的素材引用（都是公开 API 跑出来的）。
2. **第 6 条请确认归属**：`noise` 的 `octaves` 已有 `needCount` 上界，是谁修的？报告里要标清楚。
3. **第 10、12 条请先等总审裁决**再动手（都涉及对外 API 或架构）。
4. 其余 9 条（di 4 条、noise 5/7/8、timeutil 9/11）我这边**已复现、可修**，
   与 W6-B 的单元零重叠，如需 W6-B 支援请总审指派。
