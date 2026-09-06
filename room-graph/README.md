# room-graph — RoomGraph（房间图生成）

## 它解决什么

肉鸽关卡不只是"一堆随机房间"，它有**结构**：

```
  入口 ──┬── 战斗 ──┬── 精英 ──┐
         │          ├── 商店 ──┼── Boss
         └── 事件 ──┴── 休息 ──┘
```

玩家在分叉口做选择（"打精英拿遗物"还是"去商店买血"），
**这个选择本身**就是肉鸽的核心乐趣之一。

本模块负责生成这张图：分层 DAG、路径不交叉、类型分配、路径分析。

## 零业务依赖

它不认识「骷髅兵」「金币」「遗物」。
房间类型只是**开放字符串**，`RoomTypes` 只是提供默认词汇表。
生成的图只有 `id / depth / slot / type / next / prev`，
具体房间长什么样、里面放什么，是业务层的事。

## 用法

```typescript
import { generateRoomGraph, assignTypes, diagnose, graphToString, RoomTypes } from './room-graph/RoomGraph';
import { RNG } from './rng/RNG';

// ① 生成结构
const g = generateRoomGraph({ depth: 9, rng: new RNG(12345) });

// ② 分配类型
assignTypes(g, {
  weights: {
    [RoomTypes.COMBAT]: 55,
    [RoomTypes.ELITE]: 15,
    [RoomTypes.TREASURE]: 8,
    [RoomTypes.SHOP]: 7,
    [RoomTypes.REST]: 5,
    [RoomTypes.EVENT]: 10,
  },
  fixed: { 0: RoomTypes.ENTRY },
  rules: [
    // 精英不出现在前两层
    { allow: (ctx) => (ctx.node.type === RoomTypes.ELITE ? ctx.node.depth >= 2 : true) },
    // 后期商店权重提高（前期没钱买）
    { weight: (ctx) => (ctx.node.depth >= 5 ? { [RoomTypes.SHOP]: 25 } : {}) },
  ],
}, new RNG(999));

// ③ 自检（上线前必跑）
const d = diagnose(g);
console.log(d.ok);   // true

// ④ 调试用 ASCII 图
console.log(graphToString(g));
```

## 三条硬保证

| 保证 | 违反会怎样 |
|---|---|
| **无死路** | 玩家走进房间后出不来，卡死 |
| **全连通** | 有房间永远走不到，玩家看不到内容 |
| **路径不交叉** | 地图变成 X 形乱麻，玩家分不清走哪条 |

最后一条是《杀戮尖塔》地图看起来清爽的根本原因。
交叉判据：若 `i < i'` 则必须 `j <= j'`。

## ⚠️ depth 的取值约束（会抛错）

```typescript
generateRoomGraph({ depth: 1001, rng })   // ✗ 抛 [RoomGraph] 层数过大
generateRoomGraph({ depth: Infinity, rng })  // ✗ 抛 [RoomGraph] 层数至少 3…且必须为有限值
```

| 约束 | 值 | 为什么 |
|---|---|---|
| 下界 | `>= 3`（入口 + 中间 + Boss） | 层数不足无法构成一局 |
| **必须为有限值** | 不接受 `NaN` / `±Infinity` | 见下 |
| 上界 | `<= 1000` | 防配置写错把内存吃光 |

**为什么必须拒绝 Infinity**：`Infinity < 3` 是 `false`，
原来的下界校验会放行它，随后 `for (let d = 0; d < Infinity; d++)`
永不终止，而循环体每层都在分配节点 → **进程 OOM 崩溃**（实测 13 秒内堆涨到 2GB）。

`NaN` 同样会放行，产出空图后在下游崩溃（报错是 `entryLayer is not iterable`，
离真正的病因有十万八千里）。

**来源**：`depth` 通常来自关卡配置表或编辑器导出。
JSON 里写 `null` 会反序列化成 `undefined`；算 `depth` 的表达式出错会得到 `NaN`——
这两条路径都比"有人手写了 Infinity"现实得多。

实测参考：`depth=1000` → 2995 节点，约 17ms。**正常游戏用不到两位数。**

## 宽度比例约束

相邻层节点数限制在 `[ceil(n/maxOut), n×maxOut]`，绝对上限 6。

两个理由：
- **可读性**：从 2 条路突然变 8 条，玩家看不清
- **可连接性**：`m/n > maxOutDegree` 时必然有节点出度超限 → 变成扇子形

显式传了 `width` 时不干预——用户知道自己要什么。
万一配出病态结构，`diagnose()` 会在生成后抛错兜底。

## ⚠️ 最反直觉的一点：Boss 前必有休息房

Boss 前一层强制至少一个 `REST`（`ensureRestBeforeBoss`）。

这是**硬规则**，不是配置项。玩家一路打过来血量必然见底，
如果 Boss 前没有回血点，会遇到"明知道打不过但没有资源"的挫败——
而且这不是玩家决策失误，是关卡生成的锅。

《杀戮尖塔》《哈迪斯》都遵守这条。

## 路径分析（平衡用）

### pathHeat — 每个房间被多少条路径经过

假设某个精英房 90% 的路径经过它，
那么它对玩家来说**实际上不是可选的**——
你觉得放了个精英，其实玩家必打。

反过来，某个宝箱房只有 5% 的路径经过，
那它基本等于不存在（玩家看不到，做了白做）。

算法是分层 DP：`经过 n 的路径数 = fromEntry[n] × toBoss[n]`。

### pathLengths — 路径长度分布

如果不同路径长度差太多（5 个房间 vs 11 个房间），
玩家的选择就不是"风险与收益"的权衡，而是"运气好运气坏"。

建议：所有路径长度差控制在 3 以内。

### findBestPath vs findPath — 平衡分析必须用前者

```typescript
const greedy = findBestPath(g, (n) => (n.type === RoomTypes.ELITE ? 10 : 0));
const safe   = findBestPath(g, (n) => (n.type === RoomTypes.ELITE ? -10 : 0));
```

**`findPath` 是贪心，会掉进局部最优**，实测：

| 策略 | 精英数 |
|---|---|
| 全局最优 · 稳健 | 0 个 |
| 贪心 · 稳健 | **2 个** ← 比"激进"策略还多 |

原因：走到某个房间后，它的 `next` 可能只剩不想要的分支，
此时策略完全失效。用不同策略调用 `findPath` 可能得到**完全相同**的结果，
让平衡分析彻底失效。

`findBestPath` 枚举所有路径再打分。有 `maxPaths`（默认 20000）保护，
超限时退化为贪心并置 `truncated = true`——**宁可给近似答案也不卡死**。

## minOutDegree = 0 是特性不是 bug

想做隐藏房间、支线尽头时设 `minOutDegree: 0`。
此时 `diagnose()` 不再要求连通（用 `requireReachable` 控制），
死路是用户意图而不是错误。

## 测试

62 项。重点覆盖：
- **500 个种子**零死图 / 零不连通 / 零交叉
- 300 个种子类型分配全部合法
- `n > m`（上层比下层多）时不产生死路
- `findBestPath` 与暴力枚举结果一致

文件：`RoomGraph.ts`

---

## 返回值结构

### `RoomGraphData`

```typescript
interface RoomGraphData {
  nodes:  RoomNode[];   // 房间节点
  depth:  number;       // 总层数
  layers: number[][];   // **分层索引**：每层包含哪些节点下标
}
```

> **`layers` 让你按顺序遍历**：`layers[d]` 是第 d 层的所有节点。
> 没有它就得自己从 `nodes` 里筛——
> 而且容易漏掉"跨层连接"的房间。