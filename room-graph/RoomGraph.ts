/**
 * room-graph/RoomGraph.ts —— 房间图生成（Roguelike 关卡结构）
 *
 * 【它解决什么】
 *
 * 肉鸽关卡不只是"一堆随机房间"，它有**结构**：
 *
 * ```
 *   入口 ──┬── 战斗 ──┬── 精英 ──┐
 *          │          ├── 商店 ──┼── Boss
 *          └── 事件 ──┴── 休息 ──┘
 * ```
 *
 * 玩家在分叉口做选择（"打精英拿遗物"还是"去商店买血"），
 * **这个选择本身**就是肉鸽的核心乐趣之一。
 *
 * 本模块负责生成这张图：
 * - 分层 DAG（有向无环图），从入口到 Boss
 * - 路径**不交叉**（否则地图变成一团乱麻，看不清）
 * - 房间类型分配（战斗/精英/宝箱/商店/休息/事件/Boss）
 * - 保证连通性（每个房间可达，且都能走到 Boss）
 * - 路径分析（关键路径、节点热度）
 *
 * 【零业务依赖】
 *
 * 它不认识「骷髅兵」「金币」「遗物」。
 * 房间类型只是**字符串**，业务自己定义。
 * 生成的图只有 `id / depth / type / next / prev`，
 * 具体房间长什么样、里面放什么，是业务层的事。
 *
 * 【不 import 任何其他插件】
 *
 * 随机源通过 `IRandomSource` 接口注入（第 0 层 `_core`）。
 * 所以能接 RNG（可复现），也能接 Math.random（快速原型）。
 */

import { IRandomSource, MathRandomSource } from '../_core/types';
import { clampNum, maxOf } from '../_core/math';

// ============================================================
// 常见房间类型（仅供参考，业务可自由扩展）
// ============================================================

/**
 * 预定义的常见房间类型
 *
 * 【为什么不是枚举】
 * 枚举会把类型写死。不同游戏的房间类型差别很大
 * （有的有"锻造房"，有的有"赌房"，有的有"挑战房"）。
 *
 * 这里只提供**命名常量**作为默认词汇表，类型是开放的 `string`。
 */
export const RoomTypes = {
  /** 入口（第一层） */
  ENTRY: 'entry',
  /** 普通战斗 */
  COMBAT: 'combat',
  /** 精英战斗（高风险高回报） */
  ELITE: 'elite',
  /** Boss（最后一层） */
  BOSS: 'boss',
  /** 宝箱 */
  TREASURE: 'treasure',
  /** 商店 */
  SHOP: 'shop',
  /** 休息（回血） */
  REST: 'rest',
  /** 随机事件 */
  EVENT: 'event',
} as const;

// ============================================================
// 数据结构
// ============================================================

/** 图中的一个房间节点 */
export interface RoomNode {
  /** 唯一 id（0 开始，按生成顺序） */
  readonly id: number;
  /**
   * 层号（0 = 入口层）
   *
   * 【语义】depth 相同的房间，玩家只能经过其中一个
   * （因为路径不交叉）。所以 depth 就是"进度"。
   */
  readonly depth: number;
  /** 在本层内的索引（0 开始，用于布局与不交叉判断） */
  readonly slot: number;
  /** 房间类型（开放字符串） */
  type: string;
  /** 出边：指向下一层的节点 id */
  readonly next: number[];
  /** 入边：指向上一层的节点 id */
  readonly prev: number[];
  /**
   * 布局坐标（供 UI 画地图用）
   *
   * 【注意】这是**示意坐标**，不是游戏内世界坐标。
   * 真正把房间摆到世界里是关卡生成的事。
   */
  readonly x: number;
  readonly y: number;
  /** 业务数据（不参与任何算法，原样透传） */
  data?: unknown;
}

/** 生成的图 */
export interface RoomGraphData {
  readonly nodes: RoomNode[];
  /** 总层数 */
  readonly depth: number;
  /** 每层的节点 id 列表 */
  readonly layers: number[][];
}

// ============================================================
// 配置
// ============================================================

/** 每层节点数的配置 */
export type LayerWidth =
  | number
  | { min: number; max: number }
  /** 按层号与总层数动态决定 */
  | ((depth: number, totalDepth: number) => number | { min: number; max: number });

export interface RoomGraphOptions {
  /** 总层数（含入口层与 Boss 层）。最小 3 */
  depth: number;
  /** 每层节点数。默认 2~4 */
  width?: LayerWidth;
  /** 随机源。不传则用不可复现的默认源 */
  rng?: IRandomSource;
  /**
   * 允许"跨层跳跃"（捷径）
   *
   * 【默认 false】
   * 开了会让地图出现跨越两层的连线，
   * 好处是地图更有机质感，坏处是**路径长度方差变大**，
   * 玩家可能"运气好"少打两个房间直接到 Boss——破坏难度曲线。
   */
  allowSkip?: boolean;
  /**
   * 最大出度（每个房间最多连到几个下一层房间）
   *
   * 【默认 2】
   * 1 = 纯树状（没有汇合，路径永不交叉，但地图很"瘦"）
   * 2 = 经典分叉（推荐）
   * 3+ = 非常密集，玩家几乎没什么选择感
   */
  maxOutDegree?: number;
  /**
   * 最小出度（每个房间至少连几个）
   *
   * 【默认 1】
   * 设为 0 会出现死路（走进去就没了）——
   * 除非你想做"隐藏房间"，否则不要设 0。
   */
  minOutDegree?: number;
}

/** 类型分配规则 */
export interface TypeRule {
  /**
   * 约束：该类型能否放在这个位置
   *
   * @returns true = 允许
   */
  allow?: (ctx: TypeRuleContext) => boolean;
  /**
   * 权重覆盖：返回该位置的权重
   *
   * 【为什么返回类型是 `Partial<Record<...>>` 而不是 `Record<...>`】
   * 绝大多数规则只想改**一两个**类型的权重，
   * 却不得不返回完整的权重表：
   *
   * ```typescript
   * // 只想提高商店权重，却被逼着写全表
   * weight: (ctx) => ({ combat: 55, elite: 15, shop: 25, ... })   // ← 冗余
   * weight: (ctx) => ({ shop: 25 })                                // ← 这才是想要
   * ```
   *
   * 返回 `{}`（不想改）时，用 `Record<string, number>` 声明会报类型错
   * （`{}` 不可赋值给非空索引签名），逼调用方写 `as never` 这类逃逸。
   * 允许 `undefined` 值即可自然表达"部分覆盖"。
   */
  weight?: (ctx: TypeRuleContext) => number | Partial<Record<string, number>>;
}

export interface TypeRuleContext {
  /** 当前节点 */
  readonly node: RoomNode;
  /** 已分配的上一层节点（depth-1，slot 最接近的） */
  readonly prevNodes: readonly RoomNode[];
  /** 图数据（只读） */
  readonly graph: RoomGraphData;
  /** 总层数 */
  readonly totalDepth: number;
}

export interface TypeSpec {
  /** 默认权重表 */
  weights: Record<string, number>;
  /** 强制指定：depth → type（覆盖权重随机） */
  fixed?: Record<number, string>;
  /** 额外规则（按顺序应用） */
  rules?: TypeRule[];
}

// ============================================================
// 默认随机源（不可复现，仅用于快速原型）
// ============================================================

/** 默认随机源：不可复现，仅用于快速原型 */

/**
 * 基于 `IRandomSource.next()` 的辅助函数
 *
 * 【为什么不要求 IRandomSource 提供 int/range/chance】
 * `_core` 的 `IRandomSource` 刻意只声明 `next()` 一个方法——
 * 接口越小，实现它的成本越低（测试里传个固定数组就行）。
 *
 * 所以这些便利方法在这里本地实现，
 * 而不是去扩展第 0 层的接口。
 */
function rInt(rng: IRandomSource, n: number): number {
  return Math.floor(rng.next() * n);
}

function rRange(rng: IRandomSource, min: number, max: number): number {
  return min + rng.next() * (max - min);
}

function rChance(rng: IRandomSource, p: number): boolean {
  return rng.next() < p;
}

// ============================================================
// 生成
// ============================================================

/** 解析每层宽度配置 */
function resolveWidth(
  width: LayerWidth | undefined,
  depth: number,
  totalDepth: number,
  rng: IRandomSource,
): number {
  if (width === undefined) {
    const w = rRange(rng, 2, 4.999);
    return Math.max(1, Math.floor(w));
  }
  if (typeof width === 'number') return Math.max(1, Math.floor(width));

  const v = typeof width === 'function' ? width(depth, totalDepth) : width;
  if (typeof v === 'number') return Math.max(1, Math.floor(v));

  const lo = Math.max(1, Math.floor(v.min));
  const hi = Math.max(lo, Math.floor(v.max));
  return lo + rInt(rng, hi - lo + 1);
}

/**
 * 生成房间图
 *
 * 【算法保证】
 * 1. 每个非最后一层节点**至少**有 `minOutDegree` 条出边
 * 2. 每个非第一层节点**至少**有一条入边
 * 3. 路径**不交叉**（见下）
 * 4. 因此：入口可达所有节点，所有节点可达 Boss
 *
 * 【什么是不交叉】
 * 若节点 a（depth d, slot i）连到 slot j，
 * 节点 b（depth d, slot i', i' > i）连到 slot j'，
 * 则必须 j' >= j。
 *
 * 违反会怎样：地图上出现 X 形交叉的连线，
 * 玩家分不清"走上面这条路会到哪"——**地图的可读性崩塌**。
 * 这是《杀戮尖塔》地图看起来清爽的根本原因。
 *
 * ⚠️【副作用】它会把 `graph` 的 `next`/`prev` 填好。
 */
export function generateRoomGraph(opts: RoomGraphOptions): RoomGraphData {
  const totalDepth = opts.depth;

  /**
   * 【为什么必须校验有限性】
   *
   * `Infinity < 3` 是 `false` → 原校验放行 → `for (let d = 0; d < Infinity; d++)`
   * 永不终止，而循环体每层都在 `nodes.push(...)` 分配内存 → **进程 OOM 崩溃**。
   * 实测：13 秒内堆涨到 2GB 被系统杀掉。
   *
   * `NaN < 3` 同样是 `false`，也会放行，随后产出空图并在下游崩溃。
   *
   * 【为什么还要有上界】
   * 有限但巨大的值（如 `1e9`）不会死循环，但同样会把内存吃光。
   * 1000 层已是极端值（实测 3021 节点 / 17ms），
   * 超过它几乎一定是配置写错或表达式算错。
   */
  if (!Number.isFinite(totalDepth) || totalDepth < 3) {
    throw new Error(`[RoomGraph] 层数至少 3（入口 + 中间 + Boss）且必须为有限值，实际 ${totalDepth}`);
  }
  if (totalDepth > 1000) {
    throw new Error(`[RoomGraph] 层数过大（${totalDepth}），上限 1000`);
  }

  const rng = opts.rng ?? MathRandomSource;
  const maxOut = clampNum(opts.maxOutDegree, 1, 1e4, 2);
  // clampNum 已含下界裁剪，外层只需再保证 minOut <= maxOut
  const minOut = Math.min(clampNum(opts.minOutDegree, 0, 1e4, 1), maxOut);

  // ① 生成每层的节点（第二层起至少 2 个，否则太单调）
  const layers: number[][] = [];
  const nodes: RoomNode[] = [];
  let nextId = 0;

  for (let d = 0; d < totalDepth; d++) {
    const isLast = d === totalDepth - 1;
    const isFirst = d === 0;

    let w = resolveWidth(opts.width, d, totalDepth, rng);

    /**
     * 【首尾层默认为 1】
     * 语义上 depth 0 是"入口"、depth max 是"Boss"——
     * 单个入口、单个 Boss 是最常见的设计。
     *
     * 显式传了 `width` 配置时尊重用户的意图。
     */
    if (opts.width === undefined && (isFirst || isLast)) w = 1;

    /**
     * 【宽度比例约束】
     *
     * 相邻层的节点数不能相差太多。为什么：
     *
     * 1. **可读性**：从 2 条路突然变 8 条，玩家看不清地图
     * 2. **可连接性**：上层 n 个、下层 m 个，要覆盖 m 个节点，
     *    平均每个上层节点需要 m/n 条出边。
     *    m/n > maxOutDegree 时必然有节点出度超限 → 地图变成扇子形。
     *
     * 所以把 m 限制在 [ceil(n/maxOut), n×maxOut] 内，绝对上限 6
     * （超过 6 条并行路线，玩家已经无法在脑中比较了）。
     *
     * 【只在默认宽度下应用】
     * 用户显式传了 `width` 配置时不干预——他知道自己要什么。
     * 万一配出了病态结构，`diagnose()` 会在生成后抛错兜底。
     *
     * 【首末层不应用】
     * Boss 层要从多个分支**收缩**到 1 个，这是刻意的，不能被比例约束挡住。
     */
    if (opts.width === undefined && !isFirst && !isLast) {
      const prev = layers[d - 1].length;
      const hi = Math.max(1, Math.min(prev * maxOut, 6));
      const lo = Math.max(1, Math.ceil(prev / Math.max(1, maxOut)));
      w = Math.max(lo, Math.min(w, hi));
    }
    // 中间层至少 2 个：只有 1 条路的话玩家就没有选择了
    if (!isFirst && !isLast && w < 2) w = 2;
    if (w < 1) w = 1;

    const layer: number[] = [];
    for (let s = 0; s < w; s++) {
      const id = nextId++;
      nodes.push({
        id,
        depth: d,
        slot: s,
        type: '',
        next: [],
        prev: [],
        x: d,
        y: s,
      });
      layer.push(id);
    }
    layers.push(layer);
  }

  // ② 逐层连接
  for (let d = 0; d < totalDepth - 1; d++) {
    connectLayers(nodes, layers[d], layers[d + 1], rng, minOut, maxOut, opts.allowSkip ?? false, totalDepth);
  }

  const graph: RoomGraphData = { nodes, depth: totalDepth, layers };

  // ③ 自检（开发期立刻发现算法 bug，而不是等到玩家卡关）
  //
  // minOutDegree=0 时用户主动要求"可以有死路"，
  // 此时连通性不是硬性要求，只检查结构合法性（如交叉）。
  const diag = diagnose(graph, { requireReachable: minOut > 0 });
  if (!diag.ok) {
    throw new Error(`[RoomGraph] 生成失败：${diag.issues.join('; ')}`);
  }

  return graph;
}

/**
 * 连接相邻两层
 *
 * 【核心：如何同时满足"全覆盖"和"不交叉"】
 *
 * 步骤：
 * 1. **保证下一层每个节点都有入边**
 *    用比例分配：下一层第 j 个节点 ← 上一层第 `round(j·n/m)` 个节点
 *    （n = 上层数，m = 下层数）
 * 2. **保证上一层每个节点都有出边**
 *    上一层第 i 个节点 → 下一层第 `round(i·m/n)` 个节点
 * 3. **补充随机出边**（在不超过 maxOut 且不交叉的前提下）
 *
 * 步骤 1、2 用的都是**单调映射**，天然不交叉。
 */
function connectLayers(
  nodes: RoomNode[],
  from: number[],
  to: number[],
  rng: IRandomSource,
  minOut: number,
  maxOut: number,
  allowSkip: boolean,
  totalDepth: number,
): void {
  const n = from.length;
  const m = to.length;

  /** 不交叉检查：新增边 (i → j) 是否合法 */
  const canAdd = (i: number, j: number): boolean => {
    // 同层的其他边
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const nb = nodes[from[k]].next;
      for (const tid of nb) {
        const tj = nodes[tid].slot;
        if (k < i && tj > j) return false;   // 左边的连得更右 → 交叉
        if (k > i && tj < j) return false;   // 右边的连得更左 → 交叉
      }
    }
    return true;
  };

  /**
   * 新增一条边
   *
   * 【⚠️ 曾经的 bug：出度会超过 maxOutDegree】
   * 步骤①用单调映射 `i = round(j·n/m)` 分配入边，
   * 当 m > n 时同一个 i 会被分配到多次——
   * 于是它的出度变成 3、4，maxOutDegree 形同虚设。
   *
   * 症状：地图右侧出现"扇子形"的密集连线，
   * 玩家看到的是一张乱网，"选择哪条路"变得毫无意义。
   *
   * 所以在 addEdge 里统一检查出度上限，满了就返回 false，
   * 由调用方向邻近位置回退。
   */
  const addEdge = (i: number, j: number): boolean => {
    if (i < 0 || i >= n || j < 0 || j >= m) return false;
    const a = nodes[from[i]];
    const b = nodes[to[j]];
    if (a.next.includes(b.id)) return false;
    if (a.next.length >= maxOut) return false;      // ← 出度上限
    if (!canAdd(i, j)) return false;
    a.next.push(b.id);
    b.prev.push(a.id);
    return true;
  };

  /**
   * 强制连一条边（**绕过 maxOut 限制**）
   *
   * 【为什么需要两个版本的 addEdge】
   *
   * 覆盖率是**正确性**要求，maxOut 是**美观**要求，二者冲突时
   * 正确性必须优先。
   *
   * 反例：入口层 1 个节点、第二层 4 个节点、maxOut=2。
   * 若死守 maxOut，最多只能连 2 个 → 另 2 个节点永远不可达 →
   * 玩家看到一张有房间却走不到的地图。
   *
   * 所以：保证覆盖用 forceEdge，补充分支用 addEdge。
   * 有了宽度比例约束后，forceEdge 实际上很少会突破 maxOut。
   */
  const forceEdge = (i: number, j: number): boolean => {
    if (i < 0 || i >= n || j < 0 || j >= m) return false;
    const a = nodes[from[i]];
    const b = nodes[to[j]];
    if (a.next.includes(b.id)) return false;
    if (!canAdd(i, j)) return false;
    a.next.push(b.id);
    b.prev.push(a.id);
    return true;
  };

  /** 在 i 附近找一个能连到 j 的上层节点（保证覆盖时允许超出 maxOut） */
  const connectFrom = (i0: number, j: number): boolean => {
    if (forceEdge(i0, j)) return true;
    for (let d = 1; d <= n; d++) {
      if (forceEdge(i0 - d, j)) return true;
      if (forceEdge(i0 + d, j)) return true;
    }
    return false;
  };

  /**
   * ① 下一层每个节点至少一个入边
   *
   * 【⚠️ 曾经的 bug：用 Math.round 分配不均】
   * n=4, m=6 时 `round(j·n/m)` 得到 0,1,1,2,3,3 → i=1 和 i=3 各 2 条 ✓
   * 但 n=2, m=5 时得到 0,0,1,1,2→1 → i=1 有 **3 条**，超出 maxOut=2。
   *
   * 症状：地图上出现"某个房间分出 3 条路"的扇子形，
   * maxOutDegree 配置形同虚设。
   *
   * 改用 `floor(j·n/m)` 后是**均匀分块**：
   * 每个 i 负责连续的 ⌈m/n⌉ 或 ⌊m/n⌋ 个，最大出度 = ⌈m/n⌉。
   * 配合宽度比例约束（m ≤ n·maxOut），最大出度 ≤ maxOut。
   */
  for (let j = 0; j < m; j++) {
    const i = Math.min(n - 1, Math.floor((j * n) / Math.max(1, m)));
    connectFrom(i, j);
  }

  // ② 上一层每个节点至少一个出边
  //
  // 【minOut = 0 时跳过】
  // 曾经无条件执行，导致 `minOutDegree: 0` 配了也没用——
  // 想要死路（隐藏房间）的场景永远实现不了。
  if (minOut >= 1) {
    for (let i = 0; i < n; i++) {
      if (nodes[from[i]].next.length > 0) continue;
      const j = Math.min(m - 1, Math.floor((i * m) / Math.max(1, n)));
      // 理想位置被占了就向两侧找
      let added = addEdge(i, j);
      for (let d = 1; !added && d <= m; d++) {
        added = addEdge(i, j - d) || addEdge(i, j + d);
      }
    }
  }

  // ③ 补充到 minOut
  if (minOut > 1) {
    for (let i = 0; i < n; i++) {
      const a = nodes[from[i]];
      let guard = 0;
      while (a.next.length < minOut && guard++ < m * 2) {
        const cur = a.next.length === 0 ? -1 : nodes[a.next[a.next.length - 1]].slot;
        const j = Math.min(m - 1, Math.max(0, cur + 1));
        if (!addEdge(i, j)) break;
      }
    }
  }

  // ④ 随机补充额外分支（不超过 maxOut）
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) candidates.push(i);
  // 洗牌，避免总是前面的节点连得多
  for (let i = candidates.length - 1; i > 0; i--) {
    const k = rInt(rng, i + 1);
    const t = candidates[i];
    candidates[i] = candidates[k];
    candidates[k] = t;
  }
  for (const i of candidates) {
    const a = nodes[from[i]];
    if (a.next.length >= maxOut) continue;   // 出度上限（addEdge 内也会查）
    if (!rChance(rng, 0.45)) continue;
    const cur = a.next.length === 0 ? -1 : nodes[a.next[0]].slot;
    const j = Math.min(m - 1, Math.max(0, cur + (rChance(rng, 0.5) ? 1 : -1)));
    addEdge(i, j);
  }

  // ⑤ 可选：跨层捷径
  if (allowSkip) {
    const d = nodes[from[0]].depth;
    const skipTo = d + 2;
    if (skipTo < totalDepth) {
      const target = layersOfDepth(nodes, skipTo);
      if (target.length > 0) {
        const i = rInt(rng, n);
        const j = rInt(rng, target.length);
        const a = nodes[from[i]];
        const b = nodes[target[j]];
        if (!a.next.includes(b.id)) {
          a.next.push(b.id);
          b.prev.push(a.id);
        }
      }
    }
  }
}

function layersOfDepth(nodes: RoomNode[], d: number): number[] {
  const out: number[] = [];
  for (const n of nodes) if (n.depth === d) out.push(n.id);
  return out;
}

// ============================================================
// 类型分配
// ============================================================

/**
 * 给图的节点分配房间类型
 *
 * 【为什么单独一步】
 * 结构和内容是两件事。同一个图结构可以套不同的类型分配
 * （"这关多来点精英"），分开后可以各自测试。
 *
 * 【默认策略】
 * - depth 0 → entry
 * - 最后一层 → boss
 * - 倒数第二层 → 强制至少一个 rest（Boss 前给回血，这是玩家体验刚需）
 * - 其余按权重随机
 */
export function assignTypes(graph: RoomGraphData, spec: TypeSpec, rng?: IRandomSource): void {
  const r = rng ?? MathRandomSource;
  const last = graph.depth - 1;

  for (const node of graph.nodes) {
    const d = node.depth;

    // 固定层
    if (spec.fixed && spec.fixed[d] !== undefined) {
      node.type = spec.fixed[d];
      continue;
    }

    // 权重表（规则可覆盖）
    let weights: Record<string, number> = { ...spec.weights };
    const ctx: TypeRuleContext = {
      node,
      prevNodes: neighborsPrev(graph, node),
      graph,
      totalDepth: graph.depth,
    };

    let blocked: Set<string> | null = null;
    for (const rule of spec.rules ?? []) {
      if (rule.weight) {
        const w = rule.weight(ctx);
        if (typeof w !== 'number') {
          // 过滤掉显式 undefined 的项（允许用 `{ shop: undefined }` 表达"移除"）
          const patch: Record<string, number> = {};
          for (const [k, val] of Object.entries(w)) {
            if (typeof val === 'number') patch[k] = val;
          }
          weights = { ...weights, ...patch };
        }
      }
      if (rule.allow) {
        // 【用探测节点逐个试类型】
        // ctx.node 是 readonly，所以另建一个带候选类型的对象，
        // 而不是去改 ctx.node（那会污染后续规则看到的状态）。
        for (const t of Object.keys(weights)) {
          const probe: RoomNode = { ...node, type: t };
          if (!rule.allow({ ...ctx, node: probe })) {
            if (!blocked) blocked = new Set();
            blocked.add(t);
          }
        }
      }
    }

    // 过滤被禁止的
    let pool: Record<string, number> = weights;
    if (blocked && blocked.size > 0) {
      pool = {};
      for (const [k, v] of Object.entries(weights)) {
        if (!blocked.has(k)) pool[k] = v;
      }
    }

    node.type = pickWeighted(pool, r, d === 0 ? RoomTypes.ENTRY : d === last ? RoomTypes.BOSS : '');
  }

  // Boss 前必须有一个休息点（体验刚需）
  ensureRestBeforeBoss(graph, r);
}

function neighborsPrev(graph: RoomGraphData, node: RoomNode): RoomNode[] {
  const out: RoomNode[] = [];
  for (const id of node.prev) out.push(graph.nodes[id]);
  return out;
}

function pickWeighted(pool: Record<string, number>, rng: IRandomSource, fallback: string): string {
  const entries = Object.entries(pool).filter(([, w]) => w > 0);
  if (entries.length === 0) return fallback || RoomTypes.COMBAT;

  let total = 0;
  for (const [, w] of entries) total += w;
  let r = rng.next() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

/**
 * Boss 前一层强制至少一个休息房
 *
 * 【为什么是硬规则】
 * 玩家一路打过来血量必然见底。如果 Boss 前没有回血点，
 * 会遇到"明知道打不过但没有资源"的挫败——
 * 而且这不是玩家决策失误导致的，是关卡生成的锅。
 *
 * 《杀戮尖塔》《哈迪斯》都遵守这条。
 */
function ensureRestBeforeBoss(graph: RoomGraphData, rng: IRandomSource): void {
  const before = graph.depth - 2;
  if (before < 1) return;
  const layer = graph.layers[before];
  if (!layer || layer.length === 0) return;

  const has = layer.some((id) => graph.nodes[id].type === RoomTypes.REST);
  if (has) return;

  const pick = layer[rInt(rng, layer.length)];
  graph.nodes[pick].type = RoomTypes.REST;
}

// ============================================================
// 自检与诊断
// ============================================================

export interface Diagnosis {
  ok: boolean;
  issues: string[];
  /** 从入口可达的节点数 */
  reachableFromEntry: number;
  /** 能到达 Boss 的节点数 */
  canReachBoss: number;
  /** 死路（有入边但无出边，且不在最后一层） */
  deadEnds: number[];
  /** 交叉的路径对（不应有） */
  crossings: number;
}

/**
 * 图的完整性诊断
 *
 * 【上线前必跑】
 * 用 1000 个不同种子批量生成并诊断，全部 ok 才说明算法可靠。
 * 手测几十次碰不到极端情况。
 */
export function diagnose(graph: RoomGraphData, opts?: { requireReachable?: boolean }): Diagnosis {
  const requireReachable = opts?.requireReachable ?? true;
  const issues: string[] = [];
  const nodes = graph.nodes;

  // ① 从入口可达
  const entryLayer = graph.layers[0];
  const reachable = new Set<number>();
  const stack: number[] = [...entryLayer];
  for (const id of stack) reachable.add(id);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const nx of nodes[cur].next) {
      if (!reachable.has(nx)) {
        reachable.add(nx);
        stack.push(nx);
      }
    }
  }
  if (requireReachable && reachable.size !== nodes.length) {
    issues.push(`${nodes.length - reachable.size} 个节点从入口不可达`);
  }

  // ② 能到达 Boss（反向可达）
  const bossLayer = graph.layers[graph.depth - 1];
  const toBoss = new Set<number>();
  const stack2: number[] = [...bossLayer];
  for (const id of stack2) toBoss.add(id);
  while (stack2.length > 0) {
    const cur = stack2.pop()!;
    for (const pv of nodes[cur].prev) {
      if (!toBoss.has(pv)) {
        toBoss.add(pv);
        stack2.push(pv);
      }
    }
  }
  if (requireReachable && toBoss.size !== nodes.length) {
    issues.push(`${nodes.length - toBoss.size} 个节点无法到达 Boss`);
  }

  // ③ 死路（最后一层不算）
  const deadEnds: number[] = [];
  for (const n of nodes) {
    if (n.depth === graph.depth - 1) continue;
    if (n.next.length === 0) deadEnds.push(n.id);
  }
  /**
   * 【死路是不是错误，取决于配置意图】
   *
   * `minOutDegree: 0` 是用户明确要求"允许死路"（隐藏房间、支线尽头）。
   * 此时死路是**特性**而不是 bug，不该抛错。
   *
   * 反之 `minOutDegree >= 1`（默认）时，任何死路都说明连接算法有 bug。
   */
  if (requireReachable && deadEnds.length > 0) {
    issues.push(`${deadEnds.length} 个死路节点：${deadEnds.slice(0, 5).join(',')}`);
  }

  // ④ 路径交叉
  let crossings = 0;
  for (let d = 0; d < graph.depth - 1; d++) {
    const from = graph.layers[d];
    const edges: Array<{ i: number; j: number }> = [];
    for (let i = 0; i < from.length; i++) {
      const a = nodes[from[i]];
      for (const tid of a.next) {
        if (nodes[tid].depth === d + 1) edges.push({ i, j: nodes[tid].slot });
      }
    }
    for (let a = 0; a < edges.length; a++) {
      for (let b = a + 1; b < edges.length; b++) {
        const e1 = edges[a];
        const e2 = edges[b];
        if (e1.i < e2.i && e1.j > e2.j) crossings++;
        if (e1.i > e2.i && e1.j < e2.j) crossings++;
      }
    }
  }
  if (crossings > 0) issues.push(`${crossings} 处路径交叉`);

  // ⑤ 空类型
  const emptyType = nodes.filter((n) => n.type === '').length;
  if (emptyType > 0 && emptyType < nodes.length) {
    // 类型未分配不算结构错误（允许只生成结构）
  }

  return {
    ok: issues.length === 0,
    issues,
    reachableFromEntry: reachable.size,
    canReachBoss: toBoss.size,
    deadEnds,
    crossings,
  };
}

// ============================================================
// 路径分析（平衡用）
// ============================================================

/**
 * 经过每个节点的路径数（"热度"）
 *
 * 【用途：难度平衡的关键指标】
 *
 * 假设某个精英房有 90% 的路径经过它，
 * 那么它对玩家来说**实际上不是可选的**——
 * 你觉得放了个精英，其实玩家必打。
 *
 * 反过来，某个宝箱房只有 5% 的路径经过，
 * 那它基本等于不存在（玩家看不到，做了白做）。
 *
 * 【算法】分层 DP
 * fromEntry[n] = Σ fromEntry[所有前驱]
 * toBoss[n] = Σ toBoss[所有后继]
 * 经过 n 的路径数 = fromEntry[n] × toBoss[n]
 */
export function pathHeat(graph: RoomGraphData): Map<number, number> {
  const nodes = graph.nodes;
  const fromEntry = new Array<number>(nodes.length).fill(0);
  const toBoss = new Array<number>(nodes.length).fill(0);

  for (const layer of graph.layers) {
    for (const id of layer) {
      const n = nodes[id];
      if (n.depth === 0) {
        fromEntry[id] = 1;
      } else {
        let s = 0;
        for (const pv of n.prev) {
          if (nodes[pv].depth === n.depth - 1) s += fromEntry[pv];
        }
        fromEntry[id] = s;
      }
    }
  }

  for (let d = graph.depth - 1; d >= 0; d--) {
    for (const id of graph.layers[d]) {
      const n = nodes[id];
      if (n.depth === graph.depth - 1) {
        toBoss[id] = 1;
      } else {
        let s = 0;
        for (const nx of n.next) {
          if (nodes[nx].depth === n.depth + 1) s += toBoss[nx];
        }
        toBoss[id] = s;
      }
    }
  }

  const heat = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) heat.set(i, fromEntry[i] * toBoss[i]);
  return heat;
}

/**
 * 路径长度分布（从入口到 Boss，经过几个房间）
 *
 * 【为什么重要】
 * 如果不同路径长度差太多（比如 5 个房间 vs 11 个房间），
 * 玩家的选择就不是"风险与收益"的权衡，而是"运气好运气坏"。
 *
 * 理想：所有路径长度在 [depth, depth+2] 之间。
 */
export function pathLengths(graph: RoomGraphData): { min: number; max: number; avg: number; total: number } {
  const nodes = graph.nodes;
  const dist = new Array<number>(nodes.length).fill(0);
  const count = new Array<number>(nodes.length).fill(0);

  for (const id of graph.layers[0]) {
    dist[id] = 1;
    count[id] = 1;
  }

  for (let d = 1; d < graph.depth; d++) {
    for (const id of graph.layers[d]) {
      const n = nodes[id];
      let best = 0;
      let cnt = 0;
      for (const pv of n.prev) {
        if (nodes[pv].depth !== d - 1) continue;
        if (dist[pv] + 1 > best) best = dist[pv] + 1;
        cnt += count[pv];
      }
      dist[id] = best;
      count[id] = cnt;
    }
  }

  // 最后一层可能多个节点，取最长
  let total = 0;
  let min = Infinity;
  let max = 0;
  let sum = 0;
  for (const id of graph.layers[graph.depth - 1]) {
    total += count[id];
    min = Math.min(min, dist[id]);
    max = Math.max(max, dist[id]);
    sum += dist[id] * count[id];
  }

  return {
    min: min === Infinity ? 0 : min,
    max,
    avg: total > 0 ? sum / total : 0,
    total,
  };
}

/**
 * 贪心找一条路径（每层选当前层得分最高的）
 *
 * 【⚠️ 局限：会掉进局部最优】
 * 走到某个节点后可能只剩"不想要"的分支，此时策略无法体现。
 * 用不同策略调用它可能得到**完全相同**的结果。
 *
 * 【什么时候用】
 * - 快速演示 / 不需要精确比较
 * - 图很大，枚举会爆炸
 *
 * 【什么时候不该用】
 * 平衡分析（比较两种策略谁更优）——用 `findBestPath`。
 */
export function findPath(graph: RoomGraphData, prefer?: (node: RoomNode) => number): number[] {
  const nodes = graph.nodes;
  const entry = graph.layers[0];
  if (entry.length === 0) return [];

  // 起点
  let cur: number = prefer ? pickBest(entry, nodes, prefer) : entry[0];

  const path: number[] = [cur];
  let guard = 0;
  while (nodes[cur].depth < graph.depth - 1 && guard++ < graph.depth * 3) {
    const curDepth = nodes[cur].depth;
    const nx: number[] = nodes[cur].next.filter((id: number) => nodes[id].depth === curDepth + 1);
    if (nx.length === 0) break;
    cur = prefer ? pickBest(nx, nodes, prefer) : nx[0];
    path.push(cur);
  }
  return path;
}

/**
 * 按策略找**全局最优**路径（枚举所有路径后打分）
 *
 * 【和 findPath 的区别】
 *
 * `findPath` 是**贪心**：每层选当前看起来最好的。
 * 它会掉进局部最优——
 *
 * ```
 * L6: #14(combat) → [#18:elite]        ← 只有这一条
 *     #15(shop)   → [#18:elite, #19:rest]
 *
 * "稳健"策略想避开精英，但走到 #14 之后已经没得选了。
 * 上一层选 #14 还是 #15 时两者都是 combat/shop，看不出区别。
 * ```
 *
 * 结果：激进和稳健两条策略走出**完全相同的路线**——
 * 这个结论是错的，会让平衡分析完全失效。
 *
 * `findBestPath` 枚举所有路径再打分，能得到真正的策略最优。
 *
 * 【代价与保护】
 * 路径数随层数指数增长，所以加了 `maxPaths` 上限（默认 20000）。
 * 超限时会退化成贪心并置 `truncated = true`——
 * **宁可给个近似答案，也不要卡死**。
 *
 * 【用途】
 * 平衡测试：比较"无脑打精英"和"稳健发育"两种策略的收益差。
 * 如果两者收益接近，说明风险没有对应回报，设计有问题。
 */
export function findBestPath(
  graph: RoomGraphData,
  score: (node: RoomNode) => number,
  maxPaths = 20000,
): { path: number[]; total: number; considered: number; truncated: boolean } {
  const nodes = graph.nodes;
  const lastDepth = graph.depth - 1;

  let best: number[] = [];
  let bestScore = -Infinity;
  let considered = 0;
  let truncated = false;

  const cur: number[] = [];

  const dfs = (id: number, acc: number): void => {
    if (truncated) return;
    cur.push(id);
    const total = acc + score(nodes[id]);

    if (nodes[id].depth === lastDepth) {
      considered++;
      if (considered > maxPaths) {
        truncated = true;
        cur.pop();
        return;
      }
      if (total > bestScore) {
        bestScore = total;
        best = [...cur];
      }
      cur.pop();
      return;
    }

    for (const nx of nodes[id].next) {
      if (nodes[nx].depth !== nodes[id].depth + 1) continue;
      dfs(nx, total);
      if (truncated) { cur.pop(); return; }
    }
    cur.pop();
  };

  for (const start of graph.layers[0]) dfs(start, 0);

  if (truncated || best.length === 0) {
    // 退化：用贪心兜底，保证永远有返回值
    return { path: findPath(graph, score), total: NaN, considered, truncated };
  }
  return { path: best, total: bestScore, considered, truncated: false };
}

function pickBest(ids: number[], nodes: RoomNode[], prefer: (n: RoomNode) => number): number {
  let best = ids[0];
  let bestScore = -Infinity;
  for (const id of ids) {
    const s = prefer(nodes[id]);
    if (s > bestScore) {
      bestScore = s;
      best = id;
    }
  }
  return best;
}

// ============================================================
// ASCII 可视化（调试神器）
// ============================================================

/** 把图画成 ASCII，直接打印到控制台 */
export function graphToString(graph: RoomGraphData, abbr?: (type: string) => string): string {
  const nodes = graph.nodes;
  const sym = (t: string): string => {
    if (abbr) return abbr(t);
    switch (t) {
      case RoomTypes.ENTRY: return 'S';
      case RoomTypes.COMBAT: return 'c';
      case RoomTypes.ELITE: return 'E';
      case RoomTypes.BOSS: return 'B';
      case RoomTypes.TREASURE: return '$';
      case RoomTypes.SHOP: return '@';
      case RoomTypes.REST: return 'R';
      case RoomTypes.EVENT: return '?';
      default: return '·';
    }
  };

  // 先渲染节点，再渲染连线（两层 canvas）
  const W = graph.depth * 6;
  // 【为什么用 maxOf】layers 为空时 Math.max(...[]) = -Infinity，
  // H 变成 -3，`for (let y = 0; y < H; y++)` 一次都不执行，
  // 返回空字符串——ASCII 图整个消失，而不是报错。
  const H = maxOf(graph.layers.map((l) => l.length), 0) * 4 + 1;
  const grid: string[][] = [];
  for (let y = 0; y < H; y++) grid.push(new Array(W).fill(' '));

  // 节点位置
  const pos = new Map<number, { x: number; y: number }>();
  for (let d = 0; d < graph.depth; d++) {
    const layer = graph.layers[d];
    for (let s = 0; s < layer.length; s++) {
      const x = d * 6;
      const y = s * 4;
      pos.set(layer[s], { x, y });
      grid[y][x] = sym(nodes[layer[s]].type);
    }
  }

  // 连线
  for (const n of nodes) {
    if (n.depth >= graph.depth - 1) continue;
    const a = pos.get(n.id)!;
    for (const tid of n.next) {
      if (nodes[tid].depth !== n.depth + 1) continue;
      const b = pos.get(tid)!;
      const midX = a.x + 3;
      grid[a.y][midX] = '-';
      grid[b.y][midX] = '-';
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      for (let y = lo; y <= hi; y++) {
        if (grid[y][midX] === ' ') grid[y][midX] = '|';
      }
      if (a.y === b.y) grid[a.y][midX] = '-';
      else {
        grid[a.y][midX] = a.y < b.y ? '\\' : '/';
        grid[b.y][midX] = a.y < b.y ? '\\' : '/';
      }
    }
  }

  return grid.map((r) => r.join('').replace(/\s+$/, '')).join('\n');
}
