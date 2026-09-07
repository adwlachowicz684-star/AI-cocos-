# 交叉验收任务书 · 第 A 组

> 你已完成自己那批的修复。**现在验收第 B 组。**
> 每人验收**同编号**的那个窗口：
>
> - `W1-A` 验收 `W1-B`
> - `W2-A` 验收 `W2-B`
> - `W3-A` 验收 `W3-B`
> - `W4-A` 验收 `W4-B`
> - `W5-A` 验收 `W5-B`
> - `W6-A` 验收 `W6-B`
> - `W7-A` 验收 `W7-B`
> - `W8-A` 验收 `W8-B`

---

## 0. 你要做什么

对分配给你的那一个窗口的**全部交付物**做一次独立验收，产出
`audit/verify_W{1..8}-A.md`。

**验收不是"看一遍觉得对"，是逐条独立验证。** 下面第 2 节五条硬标准，每条都要给出判断依据。

⚠️ **验收方不直接改对方代码** —— 会和对方窗口冲突。
发现问题写进报告，回报给对方窗口或总审，由对方改。

---

## 1. 你要验收的对象

### 全组 8 个窗口一览

| 被验收窗口 | 条目 | P1 | P2 | 单元 | 单元名 |
|---|---|---|---|---|---|
| `W1-B` | 20 | 13 | 7 | 7 | `anticheat audio buff collision condition skill-player spatial` |
| `W2-B` | 19 | 11 | 8 | 9 | `config curse hitbox leaderboard minimap save scheduler subtitle telegraph` |
| `W3-B` | 18 | 14 | 4 | 9 | `cheatcode currency daily inventory ranking room-graph snapshot stats wave-spawner` |
| `W4-B` | 15 | 12 | 3 | 7 | `dialogue fov joystick-mover mover rebind reddot shop` |
| `W5-B` | 14 | 7 | 7 | 7 | `accessibility analytics feedback input mmr rarity scenerouter` |
| `W6-B` | 12 | 8 | 4 | 4 | `adapters dungeon pathfind replay` |
| `W7-B` | 12 | 10 | 2 | 3 | `achievement curve expression` |
| `W8-B` | 11 | 8 | 3 | 3 | `affix binary blessing` |

各自的完整任务书：`audit/handoff_W1-B.md` ~ `audit/handoff_W8-B.md`
应产出：`audit/result_W{1..8}-B.md` + `tests/run_phase10_w{1..8}b.ts`

### 逐条清单（用于核对"是否每条都处理了"）


#### W1-B（20 条）

- `P1` `anticheat` — `SpeedChecker` 的 dt 守卫 `dtSec <= 0` 挡不住 NaN，导致连续违规计数 `_strikes` 被清零
- `P1` `audio` — `masterVolume` 非法值穿透，`effectiveVolume` 返回 NaN
- `P1` `audio` — 全部通道被 `loop` 占满时，新音效被**永久拒绝**
- `P1` `audio` — `BgmStack.setState()` 用 `in` 操作符，命中 `Object.prototype` 上的键
- `P1` `buff` — `import()` 不恢复 `_independent`，独立叠层 buff 读档后层信息丢失
- `P1` `buff` — `import()` 不校验 `remain` / `stacks`，`remain = NaN` 会产出永不消失的永久 buff
- `P1` `collision` — `raycastAabb` 起点在盒内时返回 miss，而同单元的 `raycastCircle` 起点在圆内返回 hit——同一 `raycast()` 入口下两种形状语义不一致
- `P1` `condition` — `setStat` 校验有限性但 `addStat` 不校验，NaN 一旦进 stats 就毒化整个引擎
- `P1` `condition` — `evaluate()` 对 `c.value` 为 NaN 的配置返回 NaN 进度
- `P1` `skill-player` — 循环播放时 `t = 0` 的事件只在首次 `play()` 触发，后续每轮丢失
- `P1` `skill-player` — 旧的 `SkillHandle.cancel()` 会停掉**当前正在播放的**新轨道
- `P1` `spatial` — `_findEntry` 是全表 O(n) 线性扫描，`queryNearest` 退化成 O(k·n)——第 2 节点名的 queryCircle 同类问题的新实例
- `P1` `spatial` — 配置项 `capacity` 声明后从未被使用（契约不一致）
- `P2` `anticheat` — （见正文）
- `P2` `audio` — `describe()` 的字符串拼接缺分隔符
- `P2` `buff` — （见正文）
- `P2` `collision` — （见正文）
- `P2` `condition` — `onComplete` 只支持单个监听器
- `P2` `skill-player` — `tick()` 对非有限 dt 用 `step = 0` 兜底，静默吞帧
- `P2` `spatial` — （见正文）

#### W2-B（19 条）

- `P1` `config` — 数字型 id 不参与重复检测，且索引静默覆盖
- `P1` `curse` — `effects()` 把 `set` 效果乘以层数
- `P1` `curse` — `importState` 不校验 `stacks`，负数会走 `Math.pow(value, -n)` 取倒数
- `P1` `hitbox` — 外部直接改 `box.x/y` 后 `remove()` 留下僵尸条目（格子里的 id 永不清除）
- `P1` `leaderboard` — `importEntries` 是 `submit` 的旁路，绕过了分数有限性校验
- `P1` `leaderboard` — `ranked()` 每次调用全量展开，`capacity` 上限却允许 1e7
- `P1` `minimap` — `FogMap.reveal(world, radius)` 用 **X 轴**尺寸去换算 **Y 轴**的格子跨度，非正方形世界迷雾形状错误
- `P1` `minimap` — `scale` 为 0 时 `minimapToWorld` 除零，返回 NaN 坐标
- `P1` `save` — `clearAll()` 不清理 `__tmp` 备份键，存储里永久残留垃圾
- `P1` `scheduler` — `maxDeltaTime` 未做数值收口：0 让游戏静止、-1 让时间倒流
- `P1` `telegraph` — `clear()` 不触发 `onComplete`，与 `cancelAll()` 行为不一致
- `P2` `config` — （见正文）
- `P2` `curse` — （见正文）
- `P2` `hitbox` — `sector`/`capsule` 组合走采样近似，精度依赖硬编码采样数
- `P2` `leaderboard` — （见正文）
- `P2` `save` — `write()` 失败时只 `console.error` 并返回 false，调用方极易忽略返回值
- `P2` `scheduler` — （见正文）
- `P2` `subtitle` — rule7 不满足：本单元**缺示例**
- `P2` `subtitle` — `at()` 是 O(n) 全数组扫描

#### W3-B（18 条）

- `P1` `cheatcode` — `historyLimit` 未用 `clampNum` 收口，`NaN` 让历史记录无限增长
- `P1` `currency` — `logOf(id, 0)` 返回全部流水（`slice(-0)` 陷阱）
- `P1` `currency` — `netChange()` 的语义被日志裁剪悄悄改变
- `P1` `currency` — `CurrencyWallet` 的 `precision` 未收口，越界值让余额变 `NaN`
- `P1` `daily` — 种子文本只有 25600 种组合，约半年就会撞车（两个不同日期生成完全相同的每日挑战）
- `P1` `inventory` — `remainingSpaceFor` 用 falsy 判断 `data`，与 `add` 的 `!== undefined` 判断不一致
- `P1` `inventory` — `compact()` 在容量不足时静默丢弃物品
- `P1` `ranking` — `diagnoseDistribution` 用数组下标判断"最高/最低段位"，结论随输入顺序变化
- `P1` `ranking` — `RankProgress.update()` 在段位未变时返回**陈旧**的 `TierInfo`，进度条卡住不动
- `P1` `room-graph` — `findBestPath` 因超配额截断时返回 `total: NaN`
- `P1` `snapshot` — deepClone 把 TypedArray 和类实例退化成普通对象
- `P1` `stats` — `get()` 用 `id in derived` 判定，键来自外部输入时会命中 `Object.prototype`
- `P1` `stats` — `record(id, NaN)` 让该指标永久变 `NaN`
- `P1` `wave-spawner` — 波次自带的 `timeout` 在 `nextOn: 'cleared'` 时不生效——README 承诺的"三重兜底"实际只有两重
- `P2` `daily` — （见正文）
- `P2` `room-graph` — （见正文）
- `P2` `snapshot` — （见正文）
- `P2` `wave-spawner` — （见正文）

#### W4-B（15 条）

- `P1` `dialogue` — 所有选项条件都不满足时，对话进入无法前进也无法退出的死锁
- `P1` `fov` — `isSymmetric()` 把 B 的视野永久写进 `explored`
- `P1` `fov` — Raycasting 的 `_castRay` 在 NaN 坐标下永不退出
- `P1` `joystick-mover` — `evaluate()` 返回内部复用的同一个可变对象，调用方持有的引用会被后续帧改写
- `P1` `mover` — `addImpulse` 默认 `maxExternal = Infinity` → 默认就是纯累加，JSDoc 承诺落空
- `P1` `mover` — `moveBy` 没有 `safeDt` 守卫，而 `update` 有
- `P1` `mover` — `externalDamping` / `turnBoost` 未收口 → 速度/坐标永久变 NaN
- `P1` `rebind` — `importState` 的坏数据会让**整批导入**中断，与 JSDoc 承诺相反
- `P1` `rebind` — 重复 code 导入 → 前一个动作被彻底解绑，且不触发 onChange
- `P1` `rebind` — `prettyKey` 原型链污染（与已修 `easing()` 同类的新实例）
- `P1` `reddot` — `activePaths()` 是 O(n²)：对每个叶子做一次全表 `get()`
- `P1` `shop` — `_log` 无容量上限，长期运行无限增长
- `P2` `fov` — （见正文）
- `P2` `mover` — （见正文）
- `P2` `rebind` — （见正文）

#### W5-B（14 条）

- `P1` `accessibility` — `fontScale` 的构造校验挡不住 NaN；`shakeScale` 构造不 clamp 而 setter clamp（口径不一致）
- `P1` `analytics` — `variance` 用单次 `sumSq - n·m²`，大数值小方差时被灾难性消去抹平
- `P1` `feedback` — `update` 的 dt 守卫是 `!(realDt > 0)`，挡不住 Infinity
- `P1` `mmr` — `baseRating` 的 switch 没有 default 分支 → 非法 strategy 静默返回 undefined
- `P1` `mmr` — `MmrPlayer.rating` 未做有限性校验 → 一个 NaN 传染整局匹配分
- `P1` `rarity` — `order` 只查重复、不查有限性，一个 NaN 让全档位排序失效
- `P1` `scenerouter` — 时间单位与全库不一致：配置与 `tick` 都是毫秒，其余单元 `dt` 都是秒
- `P2` `accessibility` — （见正文）
- `P2` `analytics` — （见正文）
- `P2` `feedback` — （见正文）
- `P2` `input` — （见正文）
- `P2` `mmr` — （见正文）
- `P2` `rarity` — （见正文）
- `P2` `scenerouter` — （见正文）

#### W6-B（12 条）

- `P1` `adapters` — `toFlatGrid` 静默截断值域，且 JSDoc 未声明 0~255 约束
- `P1` `adapters` — `wallTestFrom2D` 与 `fov.makeWallTest` 的默认"墙值"完全相反
- `P1` `dungeon` — 尺寸校验用 `< 5` 挡不住 NaN → 生成一张"空地图"且不报错
- `P1` `dungeon` — `minRoomSize = NaN` → 生成 NaN 坐标的房间，连通性判定全错
- `P1` `pathfind` — `heuristicWeight` 未收口 → 静默返回非最优路径
- `P1` `pathfind` — `maxNodes` 未收口 → 防卡死上限完全失效
- `P1` `replay` — 默认 `seed = 0` → 种子校验被完全跳过，JSDoc 承诺落空
- `P1` `replay` — `playback` 的关键帧指针只前进不回退 → 倒带取帧静默返回空输入
- `P2` `adapters` — （见正文）
- `P2` `dungeon` — （见正文）
- `P2` `pathfind` — （见正文）
- `P2` `replay` — （见正文）

#### W7-B（12 条）

- `P1` `achievement` — `importState()` 是追加而非替换，重复读档会叠加幽灵解锁
- `P1` `achievement` — `revoke()` 后 `_lastProgress` 未清，进度回调永久丢失一次
- `P1` `achievement` — `target` 非有限值时进度变 NaN，且零目标成就瞬间达成
- `P1` `achievement` — `unlock()` 不校验 `requires`，可绕过前置链
- `P1` `curve` — `evaluate(NaN)` 返回 NaN 且无守卫，一个 NaN 帧污染整条曲线
- `P1` `curve` — `minValue` / `maxValue` 在空曲线上返回 ∓Infinity
- `P1` `curve` — `integrate(Infinity)` 死循环，`integrate(0)` 静默返回 0
- `P1` `expression` — 三元表达式的分支里写负数字面量会直接解析失败
- `P1` `expression` — `BUILTIN` 是裸 `Record<string, Function>`，按键查表命中 `Object.prototype`
- `P1` `expression` — 非 strict 模式下 `null` / `[]` / 未定义变量一律被当成 0
- `P2` `curve` — `destroy()` 后对象仍可用，与 README「destroy 之后不能再 evaluate」的契约靠自觉
- `P2` `expression` — 除零与取模零静默返回 0

#### W8-B（11 条）

- `P1` `affix` — 区间宽度小于一个精度单位时，roll 出的值落在 [min, max] 之外
- `P1` `affix` — `lastRerollDegraded` 只会置 true，从不复位
- `P1` `binary` — uint/int 在 31、32 位时范围计算溢出，契约声称支持 32 位但实际不可用
- `P1` `binary` — float 量化位数用 floor 算、用 round 写，(max-min)/step 小数部分 ≥0.5 时写最大值抛错
- `P1` `binary` — float.write 对越界值静默 clamp，违反 README §6③"越界值绝不静默截断"
- `P1` `blessing` — `remove(id, n)` 的负数参数会加层，`add(id, NaN)` 让层数变成 NaN
- `P1` `blessing` — `set` 类型的效果被层数缩放
- `P1` `blessing` — `importState` 不校验数值、不触发 onChange
- `P2` `affix` — （见正文）
- `P2` `binary` — （见正文）
- `P2` `blessing` — （见正文）

---

## 2. 五条硬标准（每条都要给判断依据）

### 标准 1 · 是否真的复现过

看对方 `result_W{n}-B.md` 里每条的"复现输出（修复前）"列。

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

产出 `audit/verify_W{1..8}-A.md`：

```
# 验收报告 · W{n}-A 验收 W{n}-B

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
