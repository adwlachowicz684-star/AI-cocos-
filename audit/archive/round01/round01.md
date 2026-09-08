# 精审第 1 轮 · 依赖层级 L0 + L1 地基

单元：`_core` · `ds` · `event-bus` · `pool` · `rng`
代码量：2157 行（原始），逐行精读 + 缺陷脚本实测验证
日期：2026-09-06

---

## 总览

| 项 | 数 |
|---|---|
| 确认并修复的缺陷 | **13** |
| 更正错误文档 | 2 处（README 的错误归因 + CameraFollow 注释） |
| 新增回归用例 | 3 |
| 既有测试受影响 | 2 条断言被推翻（详见下方「测试争议」） |
| 全量回归 | 3453 项通过，0 失败 |

**这批地基的整体质量很高**——注释体系完整，很多坑都写清了"为什么"。
发现的问题几乎全在「实现与注释不一致」或「边界条件」上，
其中最严重的一个被 README **当成标准行为记录了下来**（见 C1）。

---

## A. `_core/math.ts`（395 行）

### 已修

**C1 · `smoothDamp` 的 maxSpeed 完全失效（严重）**

缺了 Unity 原版的 `target = current - change` 一行。限速只把「偏差」夹住了，
却仍以**原始 target** 为基准插值，于是：

```
current=0, target=100, maxSpeed=5, dt=1/60
  修前 → 首帧跳到 99.01（不限速时反而只走到 1.22）
  修后 → 首帧走到 0.0122（上限 maxSpeed*dt = 0.083）
```

症状极具迷惑性：**设了最大速度，目标瞬移时反而闪现得更远**。
`camera/CameraFollow` 是唯一真实调用方，它已在外部二次 clamp 绕过。

> ⚠️ **这份代码库的 `_core/README.md` 把该行为记为「Unity 标准行为，非 bug」，
> 还附了实测数据 995.00 和一段"修正自另一份引擎报告"的权威叙事。**
> 实测数据为真，**归因为假**。这种"数据真、结论假"的记录比没有记录更危险——
> 它会让下一个看到的人打消修复的念头。已在 README 与 CameraFollow 注释里更正。

附带修了两处：`smoothTime` 为 NaN 时整条链路变 NaN 且不可自愈；
防抖分支 `(output - target) / dt` 在 dt=0 时是 0/0，会把 velRef 永久写坏。

**C2 · `easing()` 原型链污染**

`(Easing as Record<string, fn>)[name]` 会取到 Object.prototype 上的方法：

```
easing('toString')(0.5)     → "[object Undefined]"   ← 字符串
easing('constructor')(0.5)  → 一个对象
```

缓动名来自配置表/存档，属于外部输入。返回值不是数字 → 下游 `x + 结果` 立刻 NaN
→ 角色瞬移到 (NaN, NaN) 消失，无报错。已改用 `hasOwnProperty` 挡一层。

**C3 · `clampNum` / `numOr` 把 null 当成 0**

`Number(null) === 0`、`Number('') === 0`、`Number([]) === 0`。
而它们恰好是「配置缺失」最常见的三种形态（JSON 的 `null`、表里留空、误传数组）。
后果对容量字段最致命：`limit = 0` 意味着撤销栈/对象池容量归零，不报错不告警。
已在数值转换前显式拦截。

### 仅报告（未改）

- `wrapAngle` 遇 Infinity 返回 NaN，而同文件的 `normalizeAngleRad` 有非有限值保护——**两个归一化函数行为不一致**
- `approximately(a, b, 1e-6)` 用绝对误差，坐标量级到 1e5 时恒为 false（需相对误差版）
- `Easing` 各函数不把 t 夹到 [0,1]，t<0 时 outExpo 返回负值

---

## B. `_core/string.ts`（171 行）

**已修 · similarity 的文档与实现错位**

`similarity` 的 JSDoc 后面被 `tokenize` 的整段 JSDoc 插队，
导致 `similarity` 函数体上挂着的是 **tokenize 的文档**。
不影响运行，但 IDE 悬浮提示会显示完全错误的说明。
已把函数体移到它自己的注释之后。

算法本身复核无误：`editDistance` 滚动数组正确；`shuffle` Fisher-Yates 无偏；
`tokenize` 的空参数 `""` 保留、未闭合引号抛错、`\s` 覆盖 NBSP/全角空格均正确。

---

## C. `_core/types.ts`（212 行）

**已修 · 删除遮蔽全局 `Partial<T>` 的死代码**

与 TS 内置 `Partial` 同名，一旦被 import 就遮蔽全局版本。
全库 **0 处引用**——纯负收益。README 曾记载这个陷阱，等于把陷阱固化成了契约。已删除并同步 README。

### 仅报告（需你决策，影响面大）

**⚠️ 矩形坐标系定义自相矛盾**

- `IRect` 注释写的是「**左下** + 右上」
- `IRectSized` 注释写的是「**左上**角 + 宽高」
- 而 `toCorners()` 直接把 `x, y` 当成 `minX, minY`

屏幕坐标（y 向下）下"左上角"确实是 minY，成立；
但 `camera` 用世界坐标（y 向上），其 IRect 的 minY 是**数学下边**。
两边一旦通过 `toCorners/toSized` 互转，矩形会上下翻转，**不报错**。

目前这两个函数只有测试在调用（camera/ds/dungeon 里只是注释示例），
所以**还没有造成实际 bug**——但注释正在教人踩这个坑。
需要你定一个统一口径（建议统一为 y 向下 = 屏幕/UI 语义，或给函数改名区分），再动。

---

## D. `ds/DataStructures.ts`（744 行 · 本轮问题最多）

### 已修

**D1 · `QuadTree.queryCircle` 退化成 O(k·n)（严重）**

实现是 `query(...).filter(d => this._findItem(this._root, d))`——
先取出一批 data，再对**每一个** data 从根节点全树遍历反查坐标。
实测 2000 个对象时单次查询触发 **2529 次 `_findItem`**，每次都是一次树遍历。

四叉树存在的意义就是避开这种遍历，结果"范围查询"成了全库最容易踩的性能陷阱，
而从 API 名字上完全看不出来。已改为粗筛阶段直接保留 `QuadItem`（自带 x/y）。
实测 20000 对象 × 200 次查询：9ms。反查用的 `_findItem` 已删除（O(n)，留着就是陷阱）。

**D2 · 落在分割线上的点 100% 滞留在根节点**

`_quadrantOf` 遇到 `px === midX` 就返回 -1，调用方把它留在当前节点；
而 `_place` 的 children 分支**没有再次检查是否需要分裂**，
于是这些项无限堆积在内部节点。实测 50 个点全插在 x=midX：**50 个全部滞留**，
四叉树退化成数组，query 变 O(n)。

这不是罕见边界——网格对齐的整数坐标恰好落在分割线上很常见
（bounds 800 宽 → midX = 400，而物体坐标常常就是 400）。
子象限 bounds 本就是闭开区间且完整覆盖父节点，不需要"-1"这个第三态，已移除。

**D3 · `SpatialHash` 空桶永不回收（内存泄漏）**

从桶里删 id 后不删空桶。实测插入 200 个格子再全部 remove，`_cells.size` 仍是 **200**。
子弹/粒子/大量怪物每帧 update 的场景下，几分钟就能攒出几万个空桶，
内存单调上涨不回落——不报错、不卡顿，只在长时间运行后 OOM。已修。

**D4 · `LazyHeap` 的 size / isEmpty 与 pop 语义不一致（严重）**

`size` 数的是堆内条目数（**含已标记删除的陈旧项**）。
当堆里只剩已删除项时：`isEmpty` 返回 false，`pop()` 却返回 undefined。
A* 主循环 `while (!open.isEmpty) { const n = open.pop(); ... }` 会拿到 undefined
继续访问字段 → 崩溃或死循环。已改为独立 `_live` 计数。

同时挡掉了两种"扣错计数"：迟到的 remove（句柄已出队）和重复 remove
都会让 size 偏小 → isEmpty 提前为真 → A\* **提前结束、漏搜**（漏搜不报错）。

### 复核后确认**不是** bug（记录以免有人再查一遍）

- `BinaryHeap._removeAt` 的 `siftUp` + `siftDown(旧idx)` 看着像错用了陈旧索引，
  实际正确：siftUp 移动后路径上各位置仍满足堆性质，旧 idx 处的新值也 ≤ 其子树。已推导验证。
- `DisjointSet.find` 的两趟路径压缩、`union` 按秩合并均正确。

### 仅报告（未改）

- **相切语义不一致**：`ds.rectsOverlap` 用 `<`（相切不算相交），
  `_core/types.rectOverlaps` 用 `<=`（相切算相交）。同名概念两套判定。
- `_pair` 用 Cantor 配对，坐标量级到 1e8 时超过 `MAX_SAFE_INTEGER`，不同格子会映射到同一 key
- `SpatialHash` 不存坐标，`queryNeighbors` 只能返回 id、无法做距离精筛
- `QuadTree.remove` 后不合并子节点（节点稀疏后树会退化）

---

## E. `event-bus/EventBus.ts`（156 行）

**已修 · 旧的取消函数会误删同名的新监听器**

取消函数末尾无条件执行 `_map.delete(name)`。场景：

```typescript
const off1 = bus.on('a', f1);
bus.off('a');            // 整条删掉，set1 变孤儿
bus.on('a', f2);         // 新建 set2
off1();                  // set1 删空 → 老实现把 _map['a'] 一起删掉
bus.emit('a', ...);      // f2 静默不执行
```

症状是"注册之后监听器莫名其妙不触发"，而注册和取消隔了很远。
已加 `this._map.get(name) === set` 校验，同时保证 fn 的引用一定被释放。

默认值兜底、`once`、快照遍历 + `set.has` 复查均已复核，正确。

### 仅报告

- 每次 `emit` 都 `Array.from(set)` 分配快照，无增删时是纯开销（头注释已声明不适合 >100/s，可接受）

---

## F. `pool/Pool.ts`（235 行）

**已修 · `active` 会被减成负数**

`destroy()` 把 active 归零，但此时借出的对象还在外部；
切场景后它们被归还就会一路减成负数（实测：get 两次 → destroy → put 两次 → **active === -2**）。
active 是泄漏检测的**唯一指标**，一旦为负就开始说谎：真泄漏 5 个时显示 -2，
而"负数"看起来比"正数增长"更不像故障。已夹到 0。

重复归还拦截、onPut 在超容时仍执行、泄漏追踪均已复核，正确。

### 仅报告

- `maxSize` 无有限性校验，传 NaN 时 `_idle.length < NaN` 恒 false，池静默失效
- `prewarm(n)` 不受 `maxSize` 限制
- `put` 里先 `active--` 再调 `_onPut`，`_onPut` 抛异常会留下不一致状态

---

## G. `rng/RNG.ts` + `Seed.ts`（244 行）

**已修 · `sample(arr, -1)` 返回几乎整个数组**

`slice(0, -1)` 在 JS 里是"去掉最后一个"，不是"取 0 个"。
实测 `sample([1,2,3,4,5], -1)` 返回 `[5,3,2,1]`——4 个元素。
n 常常是算出来的（如 `count - alreadyPicked`），减出负数是常事，
而返回值看起来完全合理。已夹下界。

mulberry32 实现、Fisher-Yates、`gaussian` 的 u/v 非零循环均复核正确。

### 仅报告（需你决策）

- **`Seed.daily()` 只有 3200 个桶**：`CAPACITY = 32 词 × 100 = 3200`。
  而每日挑战按日期哈希取值，一年 365 天落在 3200 个桶里，
  生日碰撞概率极高——**不同日期会出现同一张地图**，玩家会当成 bug 反馈。
  建议给 daily 单独一条不受 CAPACITY 约束的通路（它本来就返回数字，不需要 encode）。
- **`Seed.random()` 直接用 `Math.random()`**，而本单元自己的头注释强烈建议
  用 eslint 禁止 `Math.random`——自相矛盾（虽然生成种子确实不需要复现）
- `RNG` 没有 `implements IRandomSource`，只靠结构兼容，缺少编译期保障
- `rangeInt(5, 1)`（min > max）静默返回一个区间外的数，不报错

---

## 测试争议（需要你知道）

本轮有两处 **既有测试断言的就是被我判定为缺陷的行为**，我改了断言：

| 测试 | 原断言 | 处理 |
|---|---|---|
| `run_core` · guardDuplicate:false | `active === -1`（把负数当期望） | 改为断言"未拦截"的真正危害：同一对象两次进池、get 两次拿到同一引用 |
| `run_weak2` · LazyHeap size | `remove` 后 `size` 保持 2 | 改为 `size === 1`，并补 2 条用例（全删除后 isEmpty、迟到 remove 不误扣） |

两处原断言都属于"把故障表征固化成契约"。若你认为旧语义才是对的，可以回退，
但 A\* 主循环那两个用例会直接暴露问题。

---

## 下一轮预告（L1 地基续）

`logger` · `di` · `config` · `entity` · `timeutil`
