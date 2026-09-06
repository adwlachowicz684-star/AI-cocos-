/**
 * GridGraph + AStar —— 网格寻路
 *
 * 【为什么需要寻路】
 * 敌人不能直线冲向玩家——中间有墙的话会卡住或穿墙。
 * 网格 A* 是最常用的方案：简单、够快、行为可预测。
 *
 * 【性能要点】
 *
 * **① 开放列表用二叉堆，不要每次排序**
 * 朴素实现每次 `open.sort()` 是 O(n log n)，
 * 而堆是 O(log n)。地图 100×100 时差距是几十倍。
 *
 * **② 节点数据用扁平数组，不用 Map**
 * `Map<string, Node>` 每次要拼字符串 key，开销大。
 * 用 `index = y * width + x` 存进数组。
 *
 * **③ 用 generation 数组代替每次清空**
 * 每次寻路都 `new Array(n).fill(false)` 是 O(n)。
 * 用一个递增的 `generation` 标记，"访问过"判断改成
 * `visitedGen[i] === currentGen`。
 *
 * 【使用示例】
 * ```typescript
 * const grid = new GridGraph(50, 50);
 * grid.setWalkableRect(5, 5, 3, 3, false);   // 放一堵墙
 *
 * const path = AStar.find(grid, {x:0,y:0}, {x:49,y:49}, {
 *   allowDiagonal: true,
 *   heuristic: 'octile',
 * });
 *
 * if (path) for (const p of path) moveTowards(p);
 *
 * // 找不到路时返回 null（而不是抛错）——目标被围住是正常情况
 * ```
 *
 * 【无引擎依赖】
 */

export interface GridPoint {
  x: number;
  y: number;
}

export interface AStarOptions {
  /** 允许对角线移动 */
  readonly allowDiagonal?: boolean;
  /**
   * 允许"切角"（对角线移动时两侧都是墙也能过）
   * false = 更真实的移动（不会从墙角缝里钻过去）
   */
  readonly allowCornerCutting?: boolean;
  /** 启发函数：曼哈顿（4 向）或 八向（8 向） */
  readonly heuristic?: 'manhattan' | 'octile' | 'euclidean' | 'none';
  /** 启发函数权重。>1 = 更快但可能非最优（1.2~1.5 常用） */
  readonly weight?: number;
  /**
   * 最大搜索节点数（防止卡死）
   * 【坑】没有上限的话，在一个完全封闭的大地图上寻路会跑很久。
   * 表现为"打开某个门时游戏卡住半秒"。
   */
  readonly maxNodes?: number;
  /** 地形代价函数（返回该格的移动代价，不可走返回 Infinity） */
  readonly costFn?: (x: number, y: number) => number;
}

export class GridGraph {
  readonly width: number;
  readonly height: number;
  /** 是否可走。true = 可通行 */
  private readonly _walkable: Uint8Array;
  /** 每格的额外代价（默认 1） */
  private readonly _cost: Float32Array;

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('[GridGraph] 尺寸必须为正');
    this.width = width;
    this.height = height;
    this._walkable = new Uint8Array(width * height).fill(1);
    this._cost = new Float32Array(width * height).fill(1);
  }

  private _idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  isWalkable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this._walkable[this._idx(x, y)] === 1;
  }

  setWalkable(x: number, y: number, v: boolean): void {
    if (!this.inBounds(x, y)) return;
    this._walkable[this._idx(x, y)] = v ? 1 : 0;
  }

  /** 批量设置矩形区域 */
  setWalkableRect(x: number, y: number, w: number, h: number, v: boolean): void {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        this.setWalkable(i, j, v);
      }
    }
  }

  setCost(x: number, y: number, c: number): void {
    if (!this.inBounds(x, y)) return;
    this._cost[this._idx(x, y)] = c;
  }

  getCost(x: number, y: number): number {
    if (!this.inBounds(x, y)) return Infinity;
    return this._cost[this._idx(x, y)];
  }

  fillWalkable(v: boolean): void {
    this._walkable.fill(v ? 1 : 0);
  }

  /** 可走格子数（调试用） */
  get walkableCount(): number {
    let n = 0;
    for (let i = 0; i < this._walkable.length; i++) if (this._walkable[i]) n++;
    return n;
  }

  destroy(): void {
    // TypedArray 无需手动释放
  }
}

/** 最小二叉堆（A* 的开放列表） */
class MinHeap {
  private readonly _items: number[] = [];
  private readonly _f: Float32Array;

  constructor(fScore: Float32Array) {
    this._f = fScore;
  }

  get size(): number {
    return this._items.length;
  }

  push(idx: number): void {
    const a = this._items;
    a.push(idx);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._f[a[p]] <= this._f[a[i]]) break;
      const t = a[p];
      a[p] = a[i];
      a[i] = t;
      i = p;
    }
  }

  pop(): number | undefined {
    const a = this._items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this._f[a[l]] < this._f[a[m]]) m = l;
        if (r < a.length && this._f[a[r]] < this._f[a[m]]) m = r;
        if (m === i) break;
        const t = a[m];
        a[m] = a[i];
        a[i] = t;
        i = m;
      }
    }
    return top;
  }

  clear(): void {
    this._items.length = 0;
  }
}

const SQRT2 = Math.SQRT2;

/**
 * A* 寻路
 *
 * @returns 路径点数组（含起点与终点），**找不到返回 null**
 *
 * 【为什么返回 null 而不是空数组】
 * "找不到路"是正常情况（目标被墙围住），不是错误。
 * 返回 null 让调用方必须显式处理——
 * 空数组容易被误当成"路径为空 = 不用动"，导致敌人原地发呆。
 */
export function findPath(
  grid: GridGraph,
  start: GridPoint,
  goal: GridPoint,
  opts: AStarOptions = {}
): GridPoint[] | null {
  const W = grid.width;
  const H = grid.height;
  const N = W * H;

  if (!grid.inBounds(start.x, start.y) || !grid.inBounds(goal.x, goal.y)) return null;
  if (!grid.isWalkable(goal.x, goal.y)) return null;

  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  const gx = Math.floor(goal.x);
  const gy = Math.floor(goal.y);

  const startIdx = sy * W + sx;
  const goalIdx = gy * W + gx;

  if (startIdx === goalIdx) return [{ x: sx, y: sy }];

  const allowDiag = opts.allowDiagonal ?? true;
  const allowCorner = opts.allowCornerCutting ?? false;
  const weight = opts.weight ?? 1;
  const maxNodes = opts.maxNodes ?? N;
  const costFn = opts.costFn;

  // 启发函数
  const hFn = (x: number, y: number): number => {
    const dx = Math.abs(x - gx);
    const dy = Math.abs(y - gy);
    switch (opts.heuristic ?? 'octile') {
      case 'manhattan':
        return dx + dy;
      case 'euclidean':
        return Math.sqrt(dx * dx + dy * dy);
      case 'none':
        return 0;
      case 'octile':
      default:
        // 八向：对角线代价 √2，直线代价 1
        return dx < dy ? SQRT2 * dx + (dy - dx) : SQRT2 * dy + (dx - dy);
    }
  };

  const gScore = new Float32Array(N).fill(Infinity);
  const fScore = new Float32Array(N).fill(Infinity);
  const cameFrom = new Int32Array(N).fill(-1);
  const generation = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const gen = 1;

  const heap = new MinHeap(fScore);

  gScore[startIdx] = 0;
  fScore[startIdx] = hFn(sx, sy) * weight;
  generation[startIdx] = gen;
  heap.push(startIdx);

  let expanded = 0;

  while (heap.size > 0) {
    const cur = heap.pop()!;
    if (closed[cur]) continue;
    closed[cur] = 1;

    if (cur === goalIdx) return _reconstruct(cameFrom, cur, W);

    if (++expanded > maxNodes) return null; // 超限，放弃（防止卡死）

    const cx = cur % W;
    const cy = (cur / W) | 0;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const diagonal = dx !== 0 && dy !== 0;
        if (diagonal && !allowDiag) continue;

        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;

        const nIdx = ny * W + nx;

        if (!grid.isWalkable(nx, ny)) continue;
        if (closed[nIdx]) continue;

        // 不允许切角：对角线移动时，两侧至少有一个可走
        if (diagonal && !allowCorner) {
          if (!grid.isWalkable(cx + dx, cy) || !grid.isWalkable(cx, cy + dy)) continue;
        }

        const stepCost = diagonal ? SQRT2 : 1;
        const terrainCost = costFn ? costFn(nx, ny) : grid.getCost(nx, ny);
        if (!Number.isFinite(terrainCost)) continue;

        const tentative = gScore[cur] + stepCost * Math.max(0, terrainCost);

        if (generation[nIdx] !== gen || tentative < gScore[nIdx]) {
          cameFrom[nIdx] = cur;
          gScore[nIdx] = tentative;
          fScore[nIdx] = tentative + hFn(nx, ny) * weight;
          generation[nIdx] = gen;
          heap.push(nIdx);
        }
      }
    }
  }

  return null;
}

function _reconstruct(cameFrom: Int32Array, end: number, W: number): GridPoint[] {
  const out: GridPoint[] = [];
  let cur = end;
  while (cur !== -1) {
    out.push({ x: cur % W, y: (cur / W) | 0 });
    cur = cameFrom[cur];
  }
  out.reverse();
  return out;
}

/**
 * 路径平滑（视线检查，去掉不必要的中间点）
 *
 * 【为什么需要】
 * A* 在网格上走出来的路径是"锯齿状"的——
 * 明明能直线走过去，却要绕着格子边缘一格一格挪。
 * 敌人这样移动会看起来很机械。
 *
 * 用视线检查（Bresenham）合并共线的点。
 */
export function smoothPath(grid: GridGraph, path: readonly GridPoint[]): GridPoint[] {
  if (path.length <= 2) return path.slice();

  const out: GridPoint[] = [path[0]];
  let anchor = 0;

  for (let i = 2; i < path.length; i++) {
    if (!_hasLineOfSight(grid, path[anchor], path[i])) {
      out.push(path[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

function _hasLineOfSight(grid: GridGraph, a: GridPoint, b: GridPoint): boolean {
  let x0 = a.x;
  let y0 = a.y;
  const x1 = b.x;
  const y1 = b.y;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  for (;;) {
    if (!grid.isWalkable(x0, y0)) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}
