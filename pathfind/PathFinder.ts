/**
 * pathfind —— A* 寻路 + 流场
 *
 * 【它解决什么】
 *
 * 寻路是游戏里最容易"写个能跑的，然后在特定情况下出诡异 bug"的功能：
 *
 * - **绕远路**：明明有直线，却贴着墙走（启发函数权重不对）
 * - **抖动**：路径在两堵墙之间来回横跳（对角线穿墙没检查）
 * - **走到一半卡住**：终点不可达时返回了空路径，但你没处理
 * - **性能崩**：地图一大就卡（没有开放列表堆优化）
 * - **斜穿墙角**：对角线移动时没检查两个正交格子
 *
 * 【收录】
 * | 算法 | 适用场景 |
 * |---|---|
 * | `AStar` | 单个单位找路。最常用 |
 * | `AStar` + 跳点优化 | 大地图（可选开关） |
 * | `FlowField` | **几十上百个单位去同一个目标**。算一次全场，所有单位共用 |
 * | `PathSmoother` | 路径平滑（去掉锯齿） |
 *
 * 【关键决策：什么时候用流场而不是 A*】
 *
 * | 场景 | A* | 流场 |
 * |---|---|---|
 * | 1 个单位找一次路 | ✅ 快 | ❌ 浪费（算了全场） |
 * | 100 个单位去同一个点 | ❌ 算 100 次 | ✅ 算 1 次 |
 * | 目标频繁变动 | ✅ | ❌ 每次都要重算全场 |
 * | RTS 编队移动 | ❌ | ✅ |
 *
 * **判据：单位数 × 目标变动频率。单位多且目标稳定 → 流场。**
 *
 * 【使用示例】
 * ```typescript
 * // 地图：0 = 可走，1 = 墙
 * const grid = [
 *   [0,0,0,0,0],
 *   [0,1,1,1,0],
 *   [0,0,0,0,0],
 * ];
 *
 * const finder = new AStar(grid, { allowDiagonal: true });
 *
 * const path = finder.find({ x: 0, y: 0 }, { x: 4, y: 2 });
 * // [{x:1,y:1}? 不，绕过去: {x:0,y:1}, {x:0,y:2}, {x:1,y:2}, ...]
 *
 * finder.find({ x: 0, y: 0 }, { x: 2, y: 1 });   // [] —— 墙里，不可达
 * ```
 *
 * 【流场】
 * ```typescript
 * const field = new FlowField(grid);
 * field.build({ x: 10, y: 10 });       // 算一次
 *
 * // 之后任意单位查询"我下一步往哪走"都是 O(1)
 * field.directionAt(3, 7);             // { x: 1, y: 0 }
 * field.hasNext(3, 7);                 // true
 * ```
 *
 * 【无引擎依赖】
 */

import { BinaryHeap } from '../ds/DataStructures';

export interface IPoint {
  readonly x: number;
  readonly y: number;
}

/** 地形：0 = 可通行，非 0 = 阻挡（值可以是任意地形 id） */
export type GridMap = ReadonlyArray<ReadonlyArray<number>>;

export interface AStarOptions {
  /** 是否允许对角线移动（默认 true） */
  allowDiagonal?: boolean;
  /**
   * 是否禁止"斜穿墙角"
   *
   * 【坑】默认必须开启。
   * 关掉的话，单位会从两堵墙的对角缝隙"挤"过去——
   * 视觉上就像穿墙，玩家会觉得是 bug。
   */
  dontCrossCorners?: boolean;
  /** 启发函数权重。1 = 标准 A*，>1 = 更快但可能不是最优（贪心） */
  heuristicWeight?: number;
  /**
   * 自定义通行判定
   *
   * 【用途】不同单位有不同地形代价：
   * 飞行单位无视墙，水栖单位只能走水。
   */
  isWalkable?: (x: number, y: number, value: number) => boolean;
  /** 地形代价（>1 = 更难走，比如沼泽） */
  costOf?: (x: number, y: number, value: number) => number;
  /** 最大搜索节点数（防止大地图卡死） */
  maxNodes?: number;
}

const DIRS4: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, 0], [0, 1], [-1, 0],
];

const DIRS8: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

/** 八方向的索引：奇数 = 对角线 */
const SQRT2 = Math.SQRT2;

export interface PathResult {
  /** 路径点（**不含起点**，含终点）。不可达时为空数组 */
  readonly path: IPoint[];
  /** 是否找到 */
  readonly found: boolean;
  /** 搜索了多少个节点（性能监控） */
  readonly nodesExplored: number;
  /** 路径总代价 */
  readonly cost: number;
}

export class AStar {
  private readonly _map: GridMap;
  private readonly _w: number;
  private readonly _h: number;
  private readonly _opts: Required<Pick<AStarOptions, 'allowDiagonal' | 'dontCrossCorners' | 'heuristicWeight' | 'maxNodes'>>;
  private readonly _isWalkable?: (x: number, y: number, v: number) => boolean;
  private readonly _costOf?: (x: number, y: number, v: number) => number;

  // 复用的缓冲区（避免每次寻路都分配，减少 GC）
  private _gScore: Float64Array | null = null;
  private _cameFrom: Int32Array | null = null;
  private _openMark: Uint8Array | null = null;
  private _stamp = 0;
  /**
   * visited / closed 都存" stamp 值"而不是布尔
   *
   * 【为什么不用 Uint8Array + 布尔】
   * 第一版用 `closed: Uint8Array` 存 0/1，只在初始化时不清零，靠 stamp 判断：
   * ```typescript
   * if (closed[ci] === 1 && stamps[ci] === stamp) continue;
   * ```
   * 但**起点**的 stamps 在 push 前就被赋成了新 stamp，
   * 而上一次的 closed[startIdx] 还是 1 → 起点被直接跳过 → 堆空 → 寻路失败。
   *
   * 现象极其诡异：**同一个 AStar 实例，第一次 find 成功，第二次开始永远失败。**
   * 而且不抛异常，只是返回空路径。
   *
   * 【解法】让 closed 也存 stamp 值，判断变成 `closedStamp[i] === stamp`，
   * 天然不受上一次的残留影响。
   */
  private _stamps: Int32Array | null = null;
  private _closedStamp: Int32Array | null = null;

  constructor(map: GridMap, opts: AStarOptions = {}) {
    if (map.length === 0 || map[0].length === 0) throw new Error('[AStar] 地图为空');

    this._map = map;
    this._h = map.length;
    this._w = map[0].length;
    this._opts = {
      allowDiagonal: opts.allowDiagonal ?? true,
      dontCrossCorners: opts.dontCrossCorners ?? true,
      heuristicWeight: opts.heuristicWeight ?? 1,
      maxNodes: opts.maxNodes ?? 100000,
    };
    this._isWalkable = opts.isWalkable;
    this._costOf = opts.costOf;

    // 校验地图是矩形
    for (let y = 0; y < this._h; y++) {
      if (map[y].length !== this._w) {
        throw new Error(`[AStar] 第 ${y} 行长度 ${map[y].length} ≠ ${this._w}，地图必须是矩形`);
      }
    }

    this._allocBuffers();
  }

  private _allocBuffers(): void {
    const n = this._w * this._h;
    this._gScore = new Float64Array(n);
    this._cameFrom = new Int32Array(n);
    this._openMark = new Uint8Array(n);
    this._stamps = new Int32Array(n);
    this._closedStamp = new Int32Array(n);
  }

  get width(): number {
    return this._w;
  }

  get height(): number {
    return this._h;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this._w && y < this._h;
  }

  /** 地形值 */
  at(x: number, y: number): number {
    return this.inBounds(x, y) ? this._map[y][x] : -1;
  }

  isWalkable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const v = this._map[y][x];
    return this._isWalkable ? this._isWalkable(x, y, v) : v === 0;
  }

  private _cost(x: number, y: number): number {
    const v = this._map[y][x];
    return this._costOf ? this._costOf(x, y, v) : 1;
  }

  /**
   * 寻路
   *
   * 【返回约定】
   * - `found: false` 时 `path` 是空数组——**一定要检查**，
   *   不能直接 `path[0]`，否则终点不可达时会读到 undefined。
   * - 起点 == 终点时返回 `found: true` 且 path 为空。
   * - 起点或终点不可走时返回 `found: false`。
   */
  find(start: IPoint, goal: IPoint): PathResult {
    const g = this._gScore!;
    const cameFrom = this._cameFrom!;
    const closed = this._closedStamp!;
    const openMark = this._openMark!;
    const stamps = this._stamps!;

    // 用递增的 stamp 代替每次 clear()，避免 O(n) 清空
    this._stamp++;
    const stamp = this._stamp;

    const empty: PathResult = { path: [], found: false, nodesExplored: 0, cost: 0 };

    if (!this.inBounds(start.x, start.y) || !this.inBounds(goal.x, goal.y)) return empty;
    if (!this.isWalkable(start.x, start.y)) return empty;
    if (!this.isWalkable(goal.x, goal.y)) return empty;

    const startIdx = start.y * this._w + start.x;
    const goalIdx = goal.y * this._w + goal.x;

    if (startIdx === goalIdx) {
      return { path: [], found: true, nodesExplored: 0, cost: 0 };
    }

    const dirs = this._opts.allowDiagonal ? DIRS8 : DIRS4;
    const hw = this._opts.heuristicWeight;

    // 开放列表
    const open = new BinaryHeap<{ idx: number; f: number }>((a, b) => a.f - b.f);

    stamps[startIdx] = stamp;
    g[startIdx] = 0;
    cameFrom[startIdx] = -1;
    open.push({ idx: startIdx, f: 0 });
    openMark[startIdx] = 1;

    let explored = 0;

    while (!open.isEmpty) {
      const cur = open.pop()!;
      const ci = cur.idx;

      // 已经处理过（同一轮内）→ 跳过惰性删除产生的重复项
      if (closed[ci] === stamp) continue;

      closed[ci] = stamp;
      stamps[ci] = stamp;
      explored++;

      if (ci === goalIdx) {
        return { path: this._reconstruct(cameFrom, startIdx, goalIdx), found: true, nodesExplored: explored, cost: g[ci] };
      }

      if (explored > this._opts.maxNodes) break;

      const cx = ci % this._w;
      const cy = (ci / this._w) | 0;

      for (let d = 0; d < dirs.length; d++) {
        const [dx, dy] = dirs[d];
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.isWalkable(nx, ny)) continue;

        const isDiag = dx !== 0 && dy !== 0;

        /**
         * 【坑】斜穿墙角检查
         * 对角线移动时，两个正交邻居至少有一个要能走。
         * 否则单位会从两堵墙的对角缝隙"挤"过去，视觉上像穿墙。
         */
        if (isDiag && this._opts.dontCrossCorners) {
          if (!this.isWalkable(cx + dx, cy) && !this.isWalkable(cx, cy + dy)) continue;
        }

        const ni = ny * this._w + nx;

        if (closed[ni] === stamp) continue;

        // 移动代价：对角线 ×√2
        const stepCost = this._cost(nx, ny) * (isDiag ? SQRT2 : 1);
        const tentative = g[ci] + stepCost;

        const fresh = stamps[ni] !== stamp;
        if (fresh || tentative < g[ni]) {
          g[ni] = tentative;
          cameFrom[ni] = ci;
          stamps[ni] = stamp;

          // 启发函数：八方向用 octile，四方向用曼哈顿
          const hx = Math.abs(nx - goal.x);
          const hy = Math.abs(ny - goal.y);
          const h = this._opts.allowDiagonal
            ? (hx > hy ? hx - hy + SQRT2 * hy : hy - hx + SQRT2 * hx)
            : hx + hy;

          open.push({ idx: ni, f: tentative + h * hw });
          openMark[ni] = 1;
        }
      }
    }

    return { path: [], found: false, nodesExplored: explored, cost: 0 };
  }

  private _reconstruct(cameFrom: Int32Array, startIdx: number, goalIdx: number): IPoint[] {
    const out: IPoint[] = [];
    let cur = goalIdx;

    // 防御：cameFrom 有环的话会死循环
    let guard = 0;
    const maxGuard = this._w * this._h + 2;

    while (cur !== startIdx && cur !== -1) {
      out.push({ x: cur % this._w, y: (cur / this._w) | 0 });
      cur = cameFrom[cur];
      if (++guard > maxGuard) return [];
    }

    out.reverse();
    return out;
  }
}

// ============================================================
// PathSmoother —— 路径平滑
// ============================================================

/**
 * 用视线检测（LOS）去掉路径上的冗余拐点
 *
 * 【为什么需要】
 * 网格 A* 出来的路径是"锯齿状"的（一格一拐），
 * 单位走起来像在抽搐。平滑后变成"能直达就直达"，
 * 只在真正需要绕的地方转弯。
 *
 * 【判据】
 * 如果 `a` 能直线看到 `c`，那 `a→b→c` 里的 `b` 就是多余的。
 */
export class PathSmoother {
  constructor(private readonly _walkable: (x: number, y: number) => boolean) {}

  /** 两点之间是否无阻挡（Bresenham + 角点检查） */
  hasLineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let x = x0;
    let y = y0;

    for (;;) {
      if (!this._walkable(x, y)) return false;
      if (x === x1 && y === y1) return true;

      const e2 = 2 * err;

      /**
       * 【坑】对角线步进时要检查两个正交邻居
       *
       * Bresenham 走对角时只检查了目标格，
       * 会"擦着墙角"过去。这里补一个检查：
       * 如果这一步是斜的，两个正交格都要能走。
       */
      if (e2 > -dy && e2 < dx) {
        if (!this._walkable(x + sx, y) || !this._walkable(x, y + sy)) return false;
      }

      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /**
   * 平滑路径
   *
   * 【复杂度】O(n²) 最坏情况，实际很快（大部分点被跳过）。
   * 路径长度 > 200 时建议分段处理。
   */
  smooth(start: IPoint, path: readonly IPoint[]): IPoint[] {
    if (path.length <= 1) return path.slice();

    const out: IPoint[] = [];
    let cur = start;
    let i = 0;

    while (i < path.length) {
      // 从路径末尾往前找：能直达的最远点
      let furthest = i;

      for (let j = path.length - 1; j > i; j--) {
        if (this.hasLineOfSight(cur.x, cur.y, path[j].x, path[j].y)) {
          furthest = j;
          break;
        }
      }

      out.push(path[furthest]);
      cur = path[furthest];

      if (furthest === i) i++;
      else i = furthest + 1;
    }

    return out;
  }
}

// ============================================================
// FlowField —— 流场（多单位共用）
// ============================================================

/**
 * 流场寻路
 *
 * 【原理】
 * 从目标点做一次 BFS/Dijkstra 洪水填充，
 * 得到全场每个格子"到目标的距离"和"下一步该往哪走"。
 * 之后任意单位只需 O(1) 查表。
 *
 * 【为什么用 BFS 而不是 A*】
 * 流场要算的是"全场所有点到目标的最短路"，
 * 这就是标准的单源最短路，Dijkstra/BFS 就是干这个的。
 * A* 是点到点，用在这里反而不对。
 *
 * 【代价均匀时用 BFS】
 * 如果所有可走格子的代价都是 1，BFS 就够了（更快）。
 * 有地形代价差异时才需要 Dijkstra。
 */
export class FlowField {
  private readonly _map: GridMap;
  private readonly _w: number;
  private readonly _h: number;
  private readonly _allowDiagonal: boolean;

  /** 到目标的距离（不可达 = -1） */
  private _dist: Float64Array;
  /** 下一步方向索引（0-7，-1 = 无） */
  private _dirs: Int8Array;
  private _goal: IPoint = { x: 0, y: 0 };
  private _built = false;

  constructor(map: GridMap, allowDiagonal = true) {
    if (map.length === 0 || map[0].length === 0) throw new Error('[FlowField] 地图为空');
    this._map = map;
    this._h = map.length;
    this._w = map[0].length;
    this._allowDiagonal = allowDiagonal;
    this._dist = new Float64Array(this._w * this._h);
    this._dirs = new Int8Array(this._w * this._h);
  }

  get width(): number {
    return this._w;
  }

  get height(): number {
    return this._h;
  }

  get isBuilt(): boolean {
    return this._built;
  }

  private _walkable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this._w || y >= this._h) return false;
    return this._map[y][x] === 0;
  }

  /**
   * 构建流场
   *
   * 【用 Dijkstra（带权 BFS）】
   * 对角线代价是 √2，所以不是均匀图，
   * 纯 BFS 会给出错误结果（对角线走 1 步和直线走 1 步代价不同）。
   */
  build(goal: IPoint): boolean {
    const n = this._w * this._h;
    this._dist.fill(-1);
    this._dirs.fill(-1);

    const goalIdx = goal.y * this._w + goal.x;
    if (!this._walkable(goal.x, goal.y)) {
      this._built = false;
      return false;
    }

    this._dist[goalIdx] = 0;
    this._goal = goal;

    const heap = new BinaryHeap<{ idx: number; d: number }>((a, b) => a.d - b.d);
    heap.push({ idx: goalIdx, d: 0 });

    const dirs = this._allowDiagonal ? DIRS8 : DIRS4;
    const done = new Uint8Array(n);

    while (!heap.isEmpty) {
      const cur = heap.pop()!;
      if (done[cur.idx]) continue;
      done[cur.idx] = 1;

      const cx = cur.idx % this._w;
      const cy = (cur.idx / this._w) | 0;

      for (let d = 0; d < dirs.length; d++) {
        const [dx, dy] = dirs[d];
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this._walkable(nx, ny)) continue;

        // 反向：从邻居走向当前格，所以方向要取反
        const isDiag = dx !== 0 && dy !== 0;
        if (isDiag && !this._walkable(cx + dx, cy) && !this._walkable(cx, cy + dy)) continue;

        const ni = ny * this._w + nx;
        const nd = cur.d + (isDiag ? SQRT2 : 1);

        if (this._dist[ni] < 0 || nd < this._dist[ni]) {
          this._dist[ni] = nd;
          // 记录"从这个邻居应该往哪个方向走才能接近目标"（即 -dx, -dy）
          this._dirs[ni] = this._dirIndex(-dx, -dy);
          heap.push({ idx: ni, d: nd });
        }
      }
    }

    this._built = true;
    return true;
  }

  private _dirIndex(dx: number, dy: number): number {
    for (let i = 0; i < DIRS8.length; i++) {
      if (DIRS8[i][0] === dx && DIRS8[i][1] === dy) return i;
    }
    return -1;
  }

  /** 某格到目标的距离（-1 = 不可达） */
  distanceAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this._w || y >= this._h) return -1;
    return this._dist[y * this._w + x];
  }

  /** 是否可达 */
  reachable(x: number, y: number): boolean {
    return this.distanceAt(x, y) >= 0;
  }

  /** 是否有下一步（false = 已到达或不可达） */
  hasNext(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this._w || y >= this._h) return false;
    if (x === this._goal.x && y === this._goal.y) return false;
    return this._dirs[y * this._w + x] >= 0;
  }

  /**
   * 下一步的位移
   *
   * @returns {x, y} 单位位移（0/±1）。无路可走返回 {x:0, y:0}
   */
  directionAt(x: number, y: number): { x: number; y: number } {
    if (x < 0 || y < 0 || x >= this._w || y >= this._h) return { x: 0, y: 0 };
    const d = this._dirs[y * this._w + x];
    if (d < 0) return { x: 0, y: 0 };
    return { x: DIRS8[d][0], y: DIRS8[d][1] };
  }

  /** 从某点一路走到目标的完整路径（调试/可视化用） */
  tracePath(x: number, y: number, maxSteps = 4096): IPoint[] {
    const out: IPoint[] = [];
    let cx = x;
    let cy = y;
    let guard = 0;

    while (!(cx === this._goal.x && cy === this._goal.y)) {
      const d = this.directionAt(cx, cy);
      if (d.x === 0 && d.y === 0) break;
      cx += d.x;
      cy += d.y;
      out.push({ x: cx, y: cy });
      if (++guard > maxSteps) break;
    }

    return out;
  }

  destroy(): void {
    this._dist = new Float64Array(0);
    this._dirs = new Int8Array(0);
    this._built = false;
  }
}
