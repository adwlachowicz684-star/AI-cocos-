# 阶段 0 完成通报 · 共享守卫已就位

总审：元宝　｜　日期：2026-09-06　｜　新基线：`4431e188e5`
全量回归：**3492 项通过，0 失败**

---

## 0. 我犯了一个错，先说它

`prewarm` 我第一版写成 `Math.min(needCount(...), this._maxSize)`，
顺手把预热数夹到了 `maxSize` 以内。全量测试立刻红了——
既有测试断言 `prewarm(20)` 配 `maxSize: 3` 应得 `idle === 20`，
理由是"预热就是要预分配，不该被 maxSize 截断"。

**这个既有设计是对的，我的"顺手"是错的。**

`maxSize` 管的是**归还时**的回收上限，`prewarm` 管的是预分配，
两者是独立契约。我要防的是 Infinity 导致 OOM，不是要重新定义预热与容量的关系。

已回退：上界用 `needCount` 的默认值 1e6，不碰 `maxSize`。
并补了一条用例「预热数不受 maxSize 截断」防止再改回去。

**这正好是我在裁决书里写的返工纪律第 1 条**（不要顺手重构）——
我自己第一版就踩了。写出来是因为：如果总审自己都不遵守，这条纪律对你们就没有约束力。

---

## 1. 交付内容

### 新增 `_core/guard.ts`（278 行，零依赖纯函数）

| 守卫 | 用途 | 拦什么 |
|---|---|---|
| `needFinite(v, field)` | 有限数值 | NaN / ±Infinity / 非 number |
| `needInt(v, field)` | 在其之上再要求整数 | 小数 |
| **`needCount(v, field, max?)`** | **循环次数（最高频）** | 负数、非整数、**超上界**（默认 1e6） |
| `needPositive(v, field)` | 除数 / 尺寸 / 比例 | ≤ 0（**允许小数**，故不能用 needCount 代替） |
| `hasOwn(obj, key)` | 自有属性判定 | 原型链误取 |
| `safeRead(table, key, fb)` | 安全查表 | 同上，返回 fallback |
| `isSafeKey(key)` / `assertSafePath(segs, raw?)` | 路径写入 | `__proto__` / `prototype` / `constructor` |

**三个设计决策，请务必按这个口径用**：

1. **一律抛错，不做静默兜底。** 这些守的是"调用方传错"，不是"数据该有默认值"。
   内部计算中间值的兜底请用 `math.ts` 的 `numOr` / `clampNum`——那是另一回事。
2. **`constructor` 必须和 `__proto__` 一起挡。** 只挡 `__proto__` 挡不住
   `obj.constructor.prototype` 这条替代入口。
3. **`needCount` 的默认上界 1e6 可覆盖**，但覆盖时要写清为什么。
   1e6 次循环是毫秒级，任何合理业务值都远低于它，也远低于会 OOM 的量级。

### 新增 `tests/run_guard.ts`（329 行，39 条用例）

每条用例都**在守卫缺失时会失败**——这是有效性标准。
比如删掉 `needCount` 的上界检查，`Infinity` 那条立刻变红。

### 其余

- `maxOf/minOf`：改用 `found` 标志区分空集与合法 ±Infinity（B0-02）
- `Pool.prewarm`：加计数上界（B0-08 子项）
- `scripts/check-deps.js`：`audit/` 加入跳过清单，退出码不再为 1
- `_kitmeta.json`：`pool` 登记 `_core` 依赖（因为 import 了 guard）
- `README.md`：测试数 3,447 → 3,492
- `_core/README.md`：补充 guard.ts 文档（4 个模式对照表 + 两条警告）

---

## 2. 现在可以开工了 · 各批次对照表

**先拉最新基线 `4431e188e5`，然后按下面的映射改。**

### 模式 B · 无界 count（约 12 处）→ `needCount`

| 批次 | 单元 | 字段 |
|---|---|---|
| 1 | `fov` | radius |
| 1 | `bullet-pattern` | count |
| 1 | `steering` | 相关计数 |
| 2 | `loot` ShuffleBag | count |
| 2 | `wave-spawner` | wave count |
| 3 | `buff` | stacks |
| 3 | `damage-pipeline` simulate | 次数 |
| 4 | `curve` integrate | 采样数 |
| 4 | `noise` | octaves / 尺寸 |
| 4 | `projectile` | 数量 |
| 5 | `craft` | 次数 |
| 5 | `gacha` pullN | n |
| 5 | `inventory` | 数量 |

**共同形态**：`if (n <= 0) return/throw` 或 `Math.max(1, n)`
——**都拦不住 Infinity，也都被 NaN 静默穿透**。全部换成 `needCount(n, '字段名')`。

### 模式 C · 角度/坐标归一化死循环（4 处）

| 批次 | 单元 |
|---|---|
| 2 | `perception`（B3-02） |
| 4 | `indicator` snapAngle（B4-05） |
| 1 | `fov` 半径（同时属模式 B） |
| 4 | `minimap`（B4-06） |

**统一修法**：先 `needFinite` 拒绝非有限值，再**改用常数时间取模**。
`_core/math.ts` 的 `normalizeAngleRad` 已经是正确实现，**直接复用它的写法**，
不要用 while 加 guard（加 guard 能避免卡死，但取模是 O(1) 且结构上不可能死循环）。

### 模式 A · Record 查表原型链（7 处）→ `hasOwn` / `safeRead`

`fsm`（B1-03）`telemetry`（B1-04）`difficulty`（B3-03）`stats`（B5-02）
`audio` BGM（B4-01）`runscope`（B2-07）`config`（B2-01）

**统一修法**：配置类 Record **在构造期**复制进 `Map`（或 `Object.create(null)`），
读取一律走自有属性。**不要在每个读取点零散加 `hasOwn`——会漏。**
改不动结构的存量代码用 `safeRead` 兜底。

### 模式 D · 路径写入原型污染（2 处）→ `assertSafePath`

| 批次 | 单元 | 编号 |
|---|---|---|
| 2 | `snapshot` applyPatch | **B2-02** |
| 4 | `skill-variant` applyPatch | **B4-09** |

**本轮最高优先级，建议这两个窗口最先做。**
调用时机：**split 之后、写入之前**。

---

## 3. 模式之外 · 各窗口单独处理（12 条）

| 批次 | 编号 | 内容 | 备注 |
|---|---|---|---|
| 5 | B5-05 | shop 负数量 | 0 金币买 -2 个 → 钱包变 20、库存 5→7 |
| 5 | B5-06 | shop 币种原型链 | `currency='toString'` 空钱包买成 |
| 5 | B5-03 | stats makeKey 碰撞 | `{a:'1,b=2'}` 与 `{a:'1',b:'2'}` 同 key |
| 5 | B5-04 | stats 接受 NaN | raw=NaN 而 display=0，坏数据被藏 |
| 1 | B1-05 | steering 零质量 | 质量 0 → 位置 Infinity/NaN 不可恢复 |
| 1 | B1-07 | team-mmr weightBase | 分母 `1+(-1)=0` → Infinity 匹配分 |
| 3 | B3-01 | perception 随机源 | **注释必须一起改**，见下 |
| 4 | B4-03 | expression spread | min/max 改循环归约，不用 spread |
| 4 | B4-10 | skill-variant 数值操作数 | |
| 4 | B4-11 | debug-console 默认开 | **不翻转默认值**，只强化警告 |
| 5 | B5-01 | cheatcode 默认开 | 同上 |
| 1/3/4/5 | B1-09 等 | 缺示例 ×10 | **等 P0/P1 清完再做** |

**B3-01 特别提醒**：那条注释写着"抖动只影响观感，不需要可复现"，
但抖动后的 `bestVisibility` 直接喂进了 `st.alert` 累积和状态阈值——
**注释的前提是假的**。修的时候必须删掉或改写旧注释，留着会误导下一个人。

---

## 4. 返工纪律（重申）

1. **一个 PR 一个议题**，不要顺手重构——我自己刚踩了，别学我
2. **每修一条补一条回归测试**，且测试要能**在修复前失败**（先写失败用例再修）
3. **注释写清"为什么"**，特别是被驳回过的设计意图（B3-01）
4. **报错信息带字段名**，如 `[ShuffleBag] count 必须是有限正整数，实际 Infinity`
5. **不要动 `_core/` 和 `ds/`** —— 阶段 0 已完成，有需要喊我
6. 修完跑 `bash build.sh && node .build/tests/run.js`，基线 **3492 通过 0 失败**

---

## 5. 待我处理（阶段 2 合并时）

- `pathfinding` 标记 deprecated（B4-07 只加 fail-fast）
- `spatial` vs `ds.SpatialHash` 的 README 选择矩阵
- 示例专项（10 个单元）
- 跨批次一致性检查：报错文案 / 守卫调用风格 / 注释口径
