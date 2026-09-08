# 总审答复 · 五批报告裁决与返工指令

总审：元宝　｜　日期：2026-09-06　｜　新基线：`6a81324e9c`

---

## 0. 先说最重要的事：基线错位（我的责任）

第 0 批复核报告 9 条里有 **8 条判定"源码仍保留被宣称已修的问题"——这个判断本身是对的，错的是我**。

**根因**：我第 0 批的 13 项修复只改在本地沙盒 `/data/workspace/AI-cocos--main`，
**从未推送到 GitHub**。我只上传了 `audit/` 下的文档，并据此在五份任务书里写了"已修复"。
于是你们五个窗口从 GitHub 拉到的仍是修复前的代码，第 0 批窗口据此复核，
得出的"仍存在"完全正确。

**我的错误有两层**，都要记下来：

1. **流程错误**：改了代码没同步，却让下游基于旧代码工作。
2. **更严重的是**：我在 `audit/README.md` 里白纸黑字写了"已修掉 13 个缺陷"，
   而公开仓库里一个都没有——这正是我在同一份台账里批评过的那类问题：
   *"文档声称已修、实际未修，会阻止下一个人去修"*。我自己犯了。

**已处理**：15 个文件已推送，新基线 `6a81324e9c`。验证方式：

```bash
grep -n "limitedTarget" _core/math.ts          # 应有输出（smoothDamp 已修）
grep -n "_dropFromCell" ds/DataStructures.ts   # 应有输出（空桶回收已修）
grep -n "hasOwnProperty" _core/math.ts         # 应有输出（easing 已修）
```

**请五个窗口全部重新拉取基线后再动手。** 第 0 批窗口请按下面第 1 节重新核对那 8 条。

---

## 1. 裁决总表

图例：**✅采纳** 维持原级　|　**⬇降级** 采纳但降严重度　|　**✅已修** 第 0 批遗留，本轮结案　|　**❌驳回**

### 第 0 批（9 条）

| 编号 | 原级 | 裁决 | 说明 |
|---|---|---|---|
| B0-01 clampNum/numOr 空值 | P0 | **✅已修** | 已推送。实测 `clampNum(null,1,9,7)===7`、`numOr('',7)===7` |
| B0-02 maxOf/minOf 极值哨兵 | P0 | **⬇P2** | 成立但降级。合法 `±Infinity` 入参极罕见；修复零成本，并入统一守卫顺手做 |
| B0-03 smoothDamp maxSpeed | P0 | **✅已修** | 实测首帧位移 0.0173（上限 0.1）；dt=0 时 velRef 不再变 NaN |
| B0-04 easing 原型链 | P0 | **✅已修** | 实测 `easing('toString')(0.5)===0.5` |
| B0-05 LazyHeap size | P1 | **✅已修** | 实测 remove 后 `size===0 && isEmpty===true` |
| B0-06 queryCircle O(k·n) | P1 | **✅已修** | `_findItem` 已删除，粗筛直接保留 QuadItem |
| B0-07 SpatialHash 空桶 | P0 | **✅已修** | `_dropFromCell` 已落地 |
| B0-08 Pool | P0 | **⬇拆分** | 见下 |
| B0-09 RNG.sample 负数 | P0 | **✅已修** | 实测 `sample([1,2,3,4],-1)===[]` |

**B0-08 拆分裁决**（原报告把三件事合成一条，后果量级差很远）：

| 子项 | 裁决 | 理由 |
|---|---|---|
| active 减成负数 | **✅已修** | 已夹到 0 |
| 外来对象 `put` | **⬇P2** | 调用方 bug。`active` 不再失真，混入外部对象的后果是"get 可能拿到它"——可恢复、可观测，不构成静默错误 |
| `prewarm(Infinity)` 无界 | **✅采纳 P1** | 与第 1~5 批的"无界 count"是同一模式，并入统一守卫 |

### 第 0 批的台账纠正 —— **✅采纳，我错了**

> `Seed.daily()` 只有 3200 个桶 —— 这个说法不准确。

成立。`daily()` 直接返回 32 位 FNV-1a（`h >>> 0`），
`CAPACITY = 3200` 只约束 `encode()` 的分享码。
我把编码容量错误归因给了 daily 本身，**已在台账更正**。

顺带说明：这条纠正没有削弱原议题的价值，只是换了个落点——
真正的风险是"daily 种子再 encode 成分享码"时会折叠到 3200 个值。
这属于使用方式问题，不是 `daily()` 的缺陷，**议题关闭**。

### 第 1 批（9 条）

| 编号 | 原级 | 裁决 | 备注 |
|---|---|---|---|
| B1-01 FOV radius=Infinity | P0 | **✅采纳** | 实测 `timeout 5` 退出码 124，确认卡死 |
| B1-02 bullet-pattern count | P0 | **✅采纳** | 同模式 |
| B1-03 fsm 原型链 | P0 | **✅采纳** | 实测：`initial='toString'` 构造+start 成功，current=toString |
| B1-04 telemetry 采样表 | P0 | **✅采纳** | 同 B1-03 模式 |
| B1-05 steering 零质量 | P0 | **✅采纳** | 质量 0 → 位置/速度 Infinity/NaN，不可恢复 |
| B1-06 steering 阵型除数 | P1 | **✅采纳** | |
| B1-07 team-mmr weightBase | P0 | **✅采纳** | 分母 `1+(-1)=0` → Infinity 匹配分 |
| B1-08 grid 尺寸/六边形 | P1 | **✅采纳** | |
| B1-09 缺示例 ×5 | P2 | **✅采纳，延后** | 与 B3-06/B4-12/B5-10 合并为专项，共 10 个单元 |

### 第 2 批（7 条）

| 编号 | 原级 | 裁决 | 备注 |
|---|---|---|---|
| B2-01 config 查表 | P1 | **✅采纳** | |
| B2-02 snapshot 原型污染 | P0 | **✅采纳（最高优先）** | 实测 `({}).snapshotPolluted === true`，**进程级污染** |
| B2-03 snapshot 数组删除顺序 | P0 | **✅采纳** | 实测删 `[1][2]` 得 `['a','c']`，期望 `['a']` |
| B2-04 snapshot 点号 key | P0 | **⬇P1 + 改修法** | 见第 3 节，不做破坏性协议改造，先 fail-fast |
| B2-05 loot 无界 | P0 | **✅采纳** | 实测 ShuffleBag `add('a', Infinity)` → 退出码 124 |
| B2-06 wave-spawner 无界 | P0 | **✅采纳** | |
| B2-07 runscope 原型链 | P0 | **✅采纳** | 实测 `has('toString') === true` |

### 第 3 批（6 条）

| 编号 | 原级 | 裁决 | 备注 |
|---|---|---|---|
| B3-01 perception Math.random | P0 | **✅采纳，从重** | 见下 |
| B3-02 perception 角度死循环 | P0 | **✅采纳** | |
| B3-03 difficulty 原型链 | P0 | **✅采纳** | 实测 `multiplier('toString')` 返回 NaN（违反有限数契约） |
| B3-04 buff stacks 无界 | P0 | **✅采纳** | 实测 `apply('x', Infinity)` → 退出码 124 |
| B3-05 damage-pipeline simulate | P0 | **✅采纳** | |
| B3-06 缺示例 ×3 | P2 | **✅采纳，延后** | 并入示例专项 |

**B3-01 特别说明（本轮最有价值的一条）**

这条不只是"用了 Math.random"，而是**注释主动论证了不该修**：

> 抖动用 `Math.random` 而不是注入的 rng：它只影响观感，不需要可复现，
> 也不该消耗 rng 序列（否则会打乱其他依赖 rng 的逻辑，让回放对不上）。

但实测代码路径里，抖动后的 `bestVisibility` **直接喂进了 `st.alert` 累积和状态阈值**。
所以注释的前提（"只影响观感"）是假的——它会影响警觉/发现的确切帧，
回放、锁步、反作弊复核都会分叉。

这正好命中我在台账里定的从严口径：**文档把缺陷记为设计意图，默认判 P0**，
因为它会让下一个人读到注释就打消修复念头。请连同注释一起改，并写清为什么改。

### 第 4 批（12 条）

| 编号 | 原级 | 裁决 | 备注 |
|---|---|---|---|
| B4-01 BGM 状态表原型链 | P0 | **✅采纳** | |
| B4-02 curve integrate | P0 | **✅采纳** | |
| B4-03 expression spread 栈溢出 | P1 | **✅采纳** | min/max 改循环归约，不用 spread |
| B4-04 noise octaves/尺寸 | P0 | **✅采纳** | |
| B4-05 indicator snapAngle | P0 | **✅采纳** | |
| B4-06 minimap 分辨率 | P1 | **✅采纳** | |
| B4-07 pathfinding GridGraph | P1 | **✅采纳** | 该单元已裁决退役（见第 5 节），**只做 fail-fast，不做完整加固** |
| B4-08 projectile 速度 | P0 | **✅采纳** | |
| B4-09 skill-variant 原型污染 | P0 | **✅采纳（最高优先）** | 实测 `({}).skillPolluted === true`，**进程级污染** |
| B4-10 skill-variant 数值操作数 | P0 | **✅采纳** | |
| B4-11 debug-console 默认开 | P1 | **✅采纳，注意 breaking** | 见下 |
| B4-12 subtitle 缺示例 | P2 | **✅采纳，延后** | 并入示例专项 |

**B4-11 补充指令**：默认改 `false` 是 **breaking change**，会打断所有现有集成。
请**不要直接翻转默认值**，改为：保留默认 `true`，但在构造时若未显式传 `enabled`
则打印一条**明确的警告**（当前已有警告，请确认它说清了"生产环境必须显式关闭"）。
破坏性变更我会在下个主版本统一处理。B5-01（cheatcode）同理。

### 第 5 批（10 条）

| 编号 | 原级 | 裁决 | 备注 |
|---|---|---|---|
| B5-01 cheatcode 默认开 | P1 | **✅采纳，注意 breaking** | 同 B4-11 |
| B5-02 stats 派生表原型链 | P0 | **✅采纳** | 实测 `get('toString')` 返回 `"[object Object]"`（字符串） |
| B5-03 stats makeKey 碰撞 | P0 | **✅采纳** | 实测 `{a:'1,b=2'}` 与 `{a:'1',b:'2'}` 同 key |
| B5-04 stats 接受 NaN | P0 | **✅采纳** | 实测 `raw=NaN` 而 `display=0`，坏数据被展示层藏掉 |
| B5-05 shop 负数量 | P0 | **✅采纳（最高优先）** | 实测：0 金币买 `-2` 个 → ok，钱包变 20，库存 5→7 |
| B5-06 shop 币种原型链 | P0 | **✅采纳** | 实测：空钱包 + `currency='toString'` → 购买成功，钱包被写入 `toString: NaN` |
| B5-07 craft 无界 | P0 | **✅采纳** | |
| B5-08 gacha 无界 | P0 | **✅采纳** | 实测 `pullN` 仅 `n<=0` 拦截，Infinity 穿透 |
| B5-09 inventory NaN | P0 | **✅采纳** | |
| B5-10 reddot 缺示例 | P2 | **✅采纳，延后** | 并入示例专项 |

### 汇总

| 裁决 | 条数 |
|---|---|
| ✅ 采纳（维持原级） | 38 |
| ⬇ 降级 | 3（B0-02、B0-08 外来 put、B2-04） |
| ✅ 已修结案（第 0 批遗留） | 8 |
| ❌ 驳回 | **0** |
| 台账纠正采纳 | 1（Seed.daily） |

**零驳回**不是放水。我抽查复现了 12 条（FOV、buff、ShuffleBag、snapshot×3、
skill-variant、shop×2、stats×3、fsm、runscope、difficulty），**全部成立，
且实测输出与原报告描述一致**。这批报告的质量高于预期。

---

## 2. 驳回为零，但有三条我要改修法

### B2-04（snapshot 点号 key）—— 不做破坏性协议改造

原建议"换成 JSON Pointer / RFC 6901 或带转义的路径 token 数组"，
方向正确，但**那是协议变更**，会打断所有已有存档和同步对端。

**改指令**：本期只做 **fail-fast**——`createPatch` 遇到含 `.` `[` `]` 的 key 时
抛带 key 名的业务错误。先消灭"静默改造成另一棵对象树"这个最坏的后果。
路径编码协议列为独立议题，随下个主版本迁移。

### B4-07（pathfinding GridGraph）—— 只加 fail-fast，不做完整加固

该单元已裁决退役（见第 5 节）。投入产出比不划算。
**只加有限正整数校验让它别在底层抛 RangeError**，其余不动。

### B4-11 / B5-01（默认开启）—— 不翻转默认值

见第 1 节。保留默认、强化警告，破坏性变更留到下个主版本。

---

## 3. 关键判断：这不是 53 个独立 bug，是 4 个系统性模式

53 条里有 **41 条可以归进 4 个模式**。如果各窗口逐单元自己改，
会出现 5 套风格不同的守卫、互相冲突的报错文案，我合并不了。

**所以：共享守卫由我落地，各窗口等我推送后再改自己批次。**

### 模式 A · `Record` 直接查表受原型链污染（7 处）

`fsm` `telemetry` `difficulty` `stats` `BGM(audio)` `runscope` `config`

**统一修法**：配置类 Record **在构造期**复制进 `Map`（或 `Object.create(null)`），
读取一律走自有属性。不要在每个读取点零散加 `hasOwn`——会漏。

### 模式 B · 无界 count → 死循环 / OOM（约 12 处）

`fov` `bullet-pattern` `steering` `curve` `noise` `projectile` `buff` `loot`
`wave-spawner` `craft` `gacha` `damage-pipeline` `inventory` `pool.prewarm`

共同形态：`if (n <= 0) return/throw` 或 `Math.max(1, n)` —— **都拦不住 Infinity，
也都会被 NaN 静默穿透**。

**统一修法**：入口一律 `needCount(v, '字段名', 上限)`。
上限按业务定，缺省给保守值并允许配置覆盖。

### 模式 C · 非有限值进入角度/坐标归一化 → 死循环（4 处）

`perception` `indicator` `fov`(半径) `minimap`

共同形态：`while (x > 2π) x -= 2π` —— `Infinity - 2π` 仍是 `Infinity`，条件恒真。

**统一修法**：先拒绝非有限值，再改用**常数时间取模**（不要用 while）。
`_core/math.ts` 的 `normalizeAngleRad` 已经是正确实现，直接复用它的写法。

### 模式 D · 路径写入导致原型污染（2 处）

`snapshot` `skill-variant` —— **本轮最高优先级**

**统一修法**：路径解析拒绝 `__proto__` / `prototype` / `constructor` 三段。

### 模式之外 · 各窗口单独处理（12 条）

`shop` 负数量与币种（B5-05/06）、`stats` key 碰撞与 NaN（B5-03/04）、
`steering` 零质量（B1-05）、`team-mmr` 权重（B1-07）、`perception` 随机源（B3-01）、
`expression` spread（B4-03）、`skill-variant` 数值操作数（B4-10）、
以及 4 条缺示例。

---

## 4. 返工分工与顺序

### 阶段 0 · 我来做（已开始，约 1 轮）

1. 建 `_core/guard.ts` 共享守卫：
   `needFinite` / `needInt` / `needCount` / `hasOwn` / `safeRead`
2. 修 `maxOf/minOf` 的极值哨兵（B0-02）
3. 修 `pool.prewarm` 上界（B0-08 子项）
4. 修 `scripts/check-deps.js` 的 `audit/` 未登记导致退出 1
5. 更正 README 里 3,447 → 3,451 的测试数

**各窗口：等我推送阶段 0 后再动自己批次。**

### 阶段 1 · 五窗口并行（各改各的批次）

- 第 0 批窗口：核对 8 条已修项 + 复测；`Seed.daily` 议题已关闭，不用再查
- 第 1 批窗口：B1-01~B1-08（模式 B/C + fsm/telemetry 属模式 A）
- 第 2 批窗口：**B2-02 原型污染最优先**，其次 B2-03，然后 B2-01/B2-05/B2-06/B2-07
- 第 3 批窗口：B3-01~B3-05
- 第 4 批窗口：**B4-09 原型污染最优先**，其次 B4-10，然后其余
- 第 5 批窗口：**B5-05/B5-06 经济漏洞最优先**，其次 B5-02~B5-04，然后 B5-07~B5-09
- 示例专项（10 个单元）：等 P0/P1 清完再做

### 阶段 2 · 我合并

全量回归 + 跨批次一致性检查（报错文案、守卫调用风格、注释口径）。

---

## 5. 架构裁决

| 议题 | 裁决 |
|---|---|
| `pathfind` vs `pathfinding` | **采纳第 1 批意见**：`pathfind` 为唯一推荐入口；`pathfinding` 标记 deprecated、只加 fail-fast（B4-07），迁移后退役 |
| `spatial.SpatialHash<T>` vs `ds.SpatialHash` | **采纳第 3 批意见**：保留两者、维持分工，README 加选择矩阵防第三套出现。`ds` 版空桶泄漏已修 |
| `pathfinding` vs `ds.QuadTree` | **采纳**：不合并，一图搜索一空间索引 |
| `audit/` 导致 check-deps 退出 1 | 我处理，加进忽略清单（它不是插件，不该被当插件扫） |

---

## 6. 修复纪律（返工时遵守）

1. **一个 PR 一个议题**，不要"顺手重构"。超出指令范围的改动一律回退
2. **每修一条，补一条回归测试**，测试要能**在修复前失败**（先写失败用例再修）
3. **注释要写清"为什么"**，特别是被驳回过的设计意图（如 B3-01），
   必须删掉或改写旧注释——留着会误导下一个人
4. **报错信息带字段名**，如 `[ShuffleBag] count 必须是有限正整数，实际 Infinity`
5. **不要动 `_core/` 和 `ds/`** —— 阶段 0 由我统一处理，避免冲突
6. 修完跑 `bash build.sh && node .build/tests/run.js`，基线 **3453 通过 0 失败**

---

## 7. 给第 0 批窗口的一句话

你的复核是对的，是我的流程出了错。8 条已推送修复，请重新拉取核对，
然后专注 B0-02（我降级为 P2）和 `prewarm` 上界这两条还没做的。
`Seed.daily` 那条纠正我采纳了，台账已改——**这条是全轮唯一推翻了总审结论的意见，
质量很高**。
