/**
 * dungeon —— 地牢 / 关卡生成
 *
 * 【它解决什么】
 *
 * 随机生成关卡，但必须保证**可玩**：
 * - 所有房间都连通（不能有玩家到不了的房间）
 * - 房间不能重叠
 * - 走廊要能走通
 * - 门/宝箱/出生点有合理的放置位置
 *
 * 【收录四种算法】
 * | 算法 | 特点 | 适用 |
 * |---|---|---|
 * | `BSPDungeon` | **推荐**。房间规整、天然连通、可控房间数 | 标准地牢、Roguelike 层 |
 * | `RoomDungeon` | 随机撒房间，用走廊连。最经典 | 简单场景 |
 * | `CellularDungeon` | 元胞自动机，洞穴感 | 天然洞穴、沼泽 |
 * | `MazeDungeon` | 完美迷宫（无环） | 迷宫关卡 |
 *
 * 【关键：生成后必须自检】
 * 生成器一定会偶尔产出死图（有房间不可达）。
 * **上线前跑 10000 次自检**，统计死图率，目标 0%。
 * 这是唯一可靠的验证方式——手测几十次根本碰不到极端情况。
 *
 * 【使用示例：BSP】
 * ```typescript
 * const gen = new BSPDungeon({
 *   width: 60, height: 40,
 *   minRoomSize: 5,
 *   maxDepth: 4,
 *   seed: 12345,
 * });
 *
 * gen.generate();
 * gen.tileAt(x, y);            // 0=墙 1=地板 2=门
 * gen.rooms;                   // 房间列表
 * gen.isFullyConnected();      // true ← 必须检查
 * gen.findFarthestRoom(0);     // 离 0 号房最远的房（放 Boss/出口）
 * ```
 *
 * 【无引擎依赖】RNG 内部用可复现的 mulberry32
 */

import { DisjointSet } from '../ds/DataStructures';
import { clampNum, numOr } from '../_core/math';

/**
 * 格子类型
 *
 * 【⚠️ 为什么是普通 enum 而不是 const enum】
 *
 * `const enum` 在编译期被**内联**，运行时的 JS 里根本不存在这个对象。
 * 对本库内部使用没问题，但对**下游项目**是致命的：
 *
 * ```typescript
 * import { Tile } from './dungeon/Dungeon';
 * if (d.tileAt(x, y) === Tile.Floor) { ... }   // ← const enum 下会报错
 * ```
 *
 * 实测：编译产物里 `Dungeon.Tile === undefined`。
 * 下游只能硬编码 `=== 1`，而那是"魔法数字"的所有缺点。
 *
 * 普通 enum 会生成一个真实对象，代价是每个值多约 20 字节——
 * 相比可复用性，这个代价可以忽略。
 */
export enum Tile {
  Wall = 0,
  Floor = 1,
  Door = 2,
}

/**
 * 【⚠️ 全库有 3 个同名 `Rect`，坐标系不同，别混用】
 *
 * | 模块 | 字段 | 表示法 |
 * |---|---|---|
 * | **本模块** | x / y / w / h | 位置+尺寸 |
 * | camera | minX/minY/maxX/maxY | 角点 |
 *
 * 都叫 `Rect`。调用方会自然地以为 `Rect` 就是 `Rect`，
 * 于是写出 `x + w` 却拿到 `minX/maxX` 的语义——
 * **不报错**，只是算出错误的矩形。这正是最难查的那类问题。
 *
 * `_core/types.ts` 现在提供了无歧义的名字和互转函数，新代码请用它们：
 *
 * ```typescript
 * import { IRect, IRectSized, toCorners, toSized } from '../_core/types';
 * ```
 *
 * 本模块的 `Rect` 保留原样是为了不破坏已有代码，
 * 等价于 `_core` 的 `IRectSized`。
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Room extends Rect {
  readonly id: number;
  /** 房间中心 */
  readonly cx: number;
  readonly cy: number;
}

export function rectCenter(r: Rect): { cx: number; cy: number } {
  return { cx: Math.floor(r.x + r.w / 2), cy: Math.floor(r.y + r.h / 2) };
}

/**
 * 两个矩形是否重叠（**相切不算重叠**）
 *
 * 【⚠️ 为什么这里用 `<` 而别处用 `<=`：三份实现的语义差异是刻意的】
 *
 * 全库有三份"矩形相交"，语义分两套：
 *
 * | 实现 | 判定 | 相切（边距刚好为 0） |
 * |---|---|---|
 * | **本函数**（dungeon 房间摆放） | `a.x < b.x + b.w` | **不算重叠** |
 * | `ds.rectsOverlap` | 严格相交 | 不算重叠 |
 * | `_core.rectOverlaps` | `<=` | **算重叠** |
 *
 * 这不是笔误，是**用途决定语义**：
 *
 * - 房间摆放要的是"两个房间能不能同时存在"。
 *   两个房间**紧贴着共用一道墙**是完全合法的地牢布局
 *   （共用墙既能省空间，走廊也更好连）。
 *   若按 `<=` 判定，这类布局会被全部拒绝，房间数骤减。
 * - 碰撞检测要的是"两个 AABB 是否接触"。物理上贴在一起就是接触，
 *   按 `<` 判定会让"贴着墙站"被判成"没碰到"。
 *
 * **两套都对。** 这里的判断必须与 `spacing` 参数一起读：
 * 调用方用 `padding` 表达"至少隔开多远"，`padding = 0` 时允许贴边。
 * 改这里的 `<` 会让所有房间的可选位置集体变少，且症状是"地图变得空旷"，
 * 不会报错——所以特意写在这，防止有人"统一三份实现"时误改。
 *
 * 【padding 的 NaN 同样拦不住】
 * `a.x - NaN < b.x + b.w` 恒 false → **任何两个房间都不重叠** →
 * 房间会互相叠在一起。调用方传进来的 spacing 已在本文件构造期收口，
 * 这里不再重复收口（热路径，房间数 × 尝试次数会被放大）。
 */
export function rectsOverlap(a: Rect, b: Rect, padding = 0): boolean {
  return (
    a.x - padding < b.x + b.w &&
    a.x + a.w + padding > b.x &&
    a.y - padding < b.y + b.h &&
    a.y + a.h + padding > b.y
  );
}

// ============================================================
// 内部 RNG（不依赖 rng 插件，保持本插件零依赖）
// ============================================================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly _next: () => number;

  constructor(seed: number) {
    this._next = mulberry32(seed);
  }

  next(): number {
    return this._next();
  }

  /** [min, max] 闭区间整数 */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ============================================================
// 基类：提供自检能力
// ============================================================

export abstract class DungeonBase {
  protected readonly _w: number;
  protected readonly _h: number;
  protected _tiles: Uint8Array;
  protected _rooms: Room[] = [];
  protected readonly _rng: Rng;

  constructor(width: number, height: number, seed: number) {
    /**
     * 【⚠️ 为什么写 `!(width >= 5)` 而不是 `width < 5`】
     *
     * JS 里 NaN 与任何值比较都返回 false，所以**否定式条件天然漏掉 NaN**：
     *
     * ```
     * NaN < 5        === false   // 旧写法：校验通过，NaN 直接穿透
     * !(NaN >= 5)    === true    // 新写法：正确拒绝
     * ```
     *
     * 穿透之后的实测现象：
     * ```typescript
     * new BSPDungeon({ width: NaN, height: 40, seed: 1 })
     *   // 构造通过，generate() 无异常
     *   // tileAt(0,0) === undefined、floorCount === 0、isFullyConnected() === false
     * ```
     *
     * 根因在下一步：`new Uint8Array(NaN * NaN)` 得到的是 **length = 0 的数组**
     * （NaN 被转成 0），于是"生成成功"了一张不存在的地图。
     *
     * 为什么这个后果特别严重：尺寸常常来自关卡配置表，配错一格就产出空地图；
     * 而 `isFullyConnected()` 恒 false 会触发宿主的"死图重生成"策略——
     * 如果策略是"重试 N 次"，就会**连续重试 N 次全部失败**，
     * 表现为"进关卡卡在加载"或"反复重生成直到超时"，且日志里没有任何异常。
     */
    if (!(width >= 5) || !(height >= 5)) {
      throw new Error(
        `[Dungeon] 尺寸至少 5×5，实际 ${String(width)}×${String(height)}。` +
          `（NaN / undefined 会在这里被拦住：NaN 参与 < 比较恒为 false，靠旧写法是拦不住的）`
      );
    }
    this._w = width;
    this._h = height;
    this._tiles = new Uint8Array(width * height);
    this._rng = new Rng(seed);
  }

  get width(): number {
    return this._w;
  }

  get height(): number {
    return this._h;
  }

  get rooms(): readonly Room[] {
    return this._rooms;
  }

  get roomCount(): number {
    return this._rooms.length;
  }

  tileAt(x: number, y: number): Tile {
    if (x < 0 || y < 0 || x >= this._w || y >= this._h) return Tile.Wall;
    return this._tiles[y * this._w + x] as Tile;
  }

  setTile(x: number, y: number, t: Tile): void {
    if (x < 0 || y < 0 || x >= this._w || y >= this._h) return;
    this._tiles[y * this._w + x] = t;
    // 地形变了 → 地板列表 / BFS 距离缓存失效
    this._invalidateCaches();
  }

  /**
   * 缓存失效
   *
   * 【为什么必须显式失效】
   * `randomFloor` / `roomDistance` 原来每次调用都全扫一遍地图（见各自注释）。
   * 加了缓存就必须有明确的失效点，否则会读到旧地形——
   * 那比慢更糟：在已经变成墙的格子上刷怪。
   */
  protected _invalidateCaches(): void {
    this._floorCache = null;
    this._bfsCache = null;
  }

  /** 地板索引缓存（含 Door，与 isFullyConnected 同口径） */
  private _floorCache: number[] | null = null;
  /** BFS 距离缓存：起点索引 → 距离数组 */
  private _bfsCache: Map<number, Int32Array> | null = null;

  isWalkable(x: number, y: number): boolean {
    const t = this.tileAt(x, y);
    return t === Tile.Floor || t === Tile.Door;
  }

  /**
   * 地板格子总数（**含 Door**）
   *
   * 【⚠️ 为什么要把 Door 也算进来】
   *
   * 原来这里只数 `Tile.Floor`，而 `isFullyConnected()` 数的是 `Floor + Door`。
   * **同一个"地板"概念，两个口径**——于是这条判断是错的：
   *
   * ```typescript
   * if (d.floorCount > 0 && !d.isFullyConnected()) 重生成();
   * ```
   *
   * 有了门之后，`floorCount` 会比连通性检查统计的总数少，
   * 表现为"明明全连通，却被判成死图反复重生成"。
   * 而且 `isWalkable()` 认定 `Door` 可走、`floodFill` 也从 Door 上走过去——
   * 只数 Floor 的那一个才是口径不一致的一方。
   *
   * 【Door 目前是"死类型"吗】
   * 是的：当前四个生成器**都没有写过 Door**（走廊直接用地板连通）。
   * 所以在现有生成器下这个改动**不改变任何数值**（实测 floorCount 前后一致）。
   * 但 Door 是公开枚举值，调用方完全可以自己 `setTile(x, y, Tile.Door)`，
   * 那时两个口径就会立刻分叉。统一到"可走格 = 地板 + 门"。
   */
  get floorCount(): number {
    let n = 0;
    for (let i = 0; i < this._tiles.length; i++) {
      const t = this._tiles[i];
      if (t === Tile.Floor || t === Tile.Door) n++;
    }
    return n;
  }

  abstract generate(): void;

  // ==================== 自检（关键） ====================

  /**
   * 洪水填充，返回连通区域
   *
   * 【用途】生成后检查"是否所有地板都连通"。
   * 这是发现死图的唯一可靠手段。
   */
  floodFill(sx: number, sy: number): Set<number> {
    const seen = new Set<number>();
    if (!this.isWalkable(sx, sy)) return seen;

    const stack: number[] = [sy * this._w + sx];
    seen.add(sy * this._w + sx);

    while (stack.length > 0) {
      const cur = stack.pop()!;
      const cx = cur % this._w;
      const cy = (cur / this._w) | 0;

      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.isWalkable(nx, ny)) continue;
        const ni = ny * this._w + nx;
        if (seen.has(ni)) continue;
        seen.add(ni);
        stack.push(ni);
      }
    }

    return seen;
  }

  /** 所有地板是否连通成一个区域 */
  isFullyConnected(): boolean {
    /**
     * 【起点必须按"可走格"找，不能只找 Floor】
     *
     * 同一个函数里原本有两套口径：
     * 找起点只认 `Tile.Floor`，而下面统计 floorTotal 用的是 `Floor + Door`。
     *
     * 于是一张"起点区恰好是门"或"全是门"的地图会走到 `start < 0`
     * → return false，即**明明全连通却被判成死图**，
     * 触发宿主的"死图重生成"逻辑。
     *
     * 这与 `floorCount` 的口径问题是同一处根因的两面，一起修：
     * 全文件统一"可走 = Floor 或 Door"。
     */
    let start = -1;
    for (let i = 0; i < this._tiles.length; i++) {
      const t = this._tiles[i];
      if (t === Tile.Floor || t === Tile.Door) {
        start = i;
        break;
      }
    }
    if (start < 0) return false;

    const reached = this.floodFill(start % this._w, (start / this._w) | 0);

    // 数一下地板总数
    let floorTotal = 0;
    for (let i = 0; i < this._tiles.length; i++) {
      if (this._tiles[i] === Tile.Floor || this._tiles[i] === Tile.Door) floorTotal++;
    }

    return reached.size === floorTotal;
  }

  /**
   * 所有房间中心是否互相可达
   *
   * 【比 isFullyConnected 更快】
   * 只检查房间之间，不用遍历每个地板格。
   */
  allRoomsReachable(): boolean {
    if (this._rooms.length <= 1) return true;

    const r0 = this._rooms[0];
    const reached = this.floodFill(r0.cx, r0.cy);

    for (const room of this._rooms) {
      if (!reached.has(room.cy * this._w + room.cx)) return false;
    }
    return true;
  }

  /** 离指定房间最远的房间（放置出口/Boss 用） */
  findFarthestRoom(fromId: number): number {
    if (this._rooms.length <= 1) return fromId;

    const from = this._rooms.find((r) => r.id === fromId);
    if (!from) return fromId;

    const dist = this._bfsDistances(from.cx, from.cy);

    let best = fromId;
    let bestDist = -1;

    for (const room of this._rooms) {
      if (room.id === fromId) continue;
      const d = dist[room.cy * this._w + room.cx];
      if (d >= 0 && d > bestDist) {
        bestDist = d;
        best = room.id;
      }
    }

    return best;
  }

  /**
   * 从 (sx, sy) 出发的 BFS 距离场
   *
   * 【⚠️ 原来是"每问一次就重算一遍全场 BFS"】
   *
   * `roomDistance(a, b)` 每次调用都做一次完整 BFS。
   * 典型用法是"算一遍房间两两距离表"（n 个房间 = n(n-1)/2 次调用），
   * 或者"每帧问一次出生点到 Boss 房还有多远"，于是：
   *
   * ```
   * 512×512 地图，roomDistance 调用 100 次 → 实测 446ms
   * 按起点缓存后 → 实测 < 10ms
   * ```
   *
   * 【缓存键为什么是"起点索引"】
   * 一次 BFS 的结果就是"起点到全场各点的距离"，
   * 同一个起点的所有查询（问不同的终点）复用同一份结果即可。
   *
   * 【失效】`setTile` / `generate` 会清空（见 `_invalidateCaches`）。
   */
  private _bfsDistances(sx: number, sy: number): Int32Array {
    const start = sy * this._w + sx;
    if (this._bfsCache === null) this._bfsCache = new Map<number, Int32Array>();
    const hit = this._bfsCache.get(start);
    if (hit !== undefined) return hit;

    const dist = new Int32Array(this._w * this._h).fill(-1);
    if (!this.isWalkable(sx, sy)) {
      this._bfsCache.set(start, dist);
      return dist;
    }

    dist[start] = 0;
    const queue: number[] = [start];
    let head = 0;

    while (head < queue.length) {
      const cur = queue[head++];
      const cx = cur % this._w;
      const cy = (cur / this._w) | 0;

      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.isWalkable(nx, ny)) continue;
        const ni = ny * this._w + nx;
        if (dist[ni] >= 0) continue;
        dist[ni] = dist[cur] + 1;
        queue.push(ni);
      }
    }

    this._bfsCache.set(start, dist);
    return dist;
  }

  /** 房间之间的距离（步数） */
  roomDistance(aId: number, bId: number): number {
    const a = this._rooms.find((r) => r.id === aId);
    const b = this._rooms.find((r) => r.id === bId);
    if (!a || !b) return -1;
    return this._bfsDistances(a.cx, a.cy)[b.cy * this._w + b.cx];
  }

  /** 导出为二维数组 */
  toGrid(): number[][] {
    const out: number[][] = [];
    for (let y = 0; y < this._h; y++) {
      out.push(Array.from(this._tiles.subarray(y * this._w, (y + 1) * this._w)));
    }
    return out;
  }

  /** ASCII 可视化（调试神器） */
  toString(): string {
    let s = '';
    for (let y = 0; y < this._h; y++) {
      for (let x = 0; x < this._w; x++) {
        const t = this.tileAt(x, y);
        s += t === Tile.Wall ? '#' : t === Tile.Door ? '+' : '.';
      }
      s += '\n';
    }
    return s;
  }

  /**
   * 随机一个地板格（放道具/怪物）
   *
   * 【⚠️ 原来是 O(n)，刷怪循环里是 O(n²)】
   *
   * 原实现每次调用都**全扫一遍地图并重建 floors 数组**。
   * 单个调用看不出问题，但它的典型用法是"刷 200 只怪，每只找一个落点"：
   *
   * ```
   * 512×512 地图，调用 300 次 → 实测 294ms（每次扫 26 万个格子）
   * 加缓存后 → 同一个种子、同样的调用序列，实测 < 5ms
   * ```
   *
   * 这 294ms 是**纯主线程阻塞**，正好卡在"进入关卡 / 刷一波怪"的那一刻。
   *
   * 【为什么缓存不会破坏可复现性】
   * 缓存只是**复用同一个按固定顺序构建的 floors 数组**，
   * `this._rng.int(0, floors.length - 1)` 的调用次数与取值都不变，
   * 所以相同种子下的随机序列与改前**逐帧一致**（测试里有对照）。
   *
   * 【失效时机】`setTile` / `generate` 会清缓存（见 `_invalidateCaches`）。
   */
  randomFloor(): { x: number; y: number } | null {
    const floors = this._floorList();
    if (floors.length === 0) return null;
    const pick = floors[this._rng.int(0, floors.length - 1)];
    return { x: pick % this._w, y: (pick / this._w) | 0 };
  }

  /** 地板索引列表（缓存，与 floorCount 同口径：Floor + Door） */
  private _floorList(): number[] {
    const cached = this._floorCache;
    if (cached !== null) return cached;
    const floors: number[] = [];
    for (let i = 0; i < this._tiles.length; i++) {
      const t = this._tiles[i];
      if (t === Tile.Floor || t === Tile.Door) floors.push(i);
    }
    this._floorCache = floors;
    return floors;
  }
}

// ============================================================
// BSPDungeon —— 二叉空间分割（推荐）
// ============================================================

export interface BSPOptions {
  width: number;
  height: number;
  seed: number;
  /** 房间最小尺寸（含墙） */
  minRoomSize?: number;
  /** 分割最大深度。越大房间越多越小 */
  maxDepth?: number;
  /** 房间在各自格子内的最小边距 */
  roomPadding?: number;
  /** 走廊宽度 */
  corridorWidth?: number;
}

interface BSPNode {
  x: number;
  y: number;
  w: number;
  h: number;
  left: BSPNode | null;
  right: BSPNode | null;
  room: Room | null;
  depth: number;
}

export class BSPDungeon extends DungeonBase {
  private readonly _opts: Required<Omit<BSPOptions, 'width' | 'height' | 'seed'>>;
  private _root: BSPNode | null = null;

  constructor(opts: BSPOptions) {
    super(opts.width, opts.height, opts.seed);
    /**
     * 【⚠️ 为什么每个参数都要 numOr / clampNum，光 `?? 默认值` 不够】
     *
     * `??` 只挡 `null` 和 `undefined`，**不挡 NaN**——而 NaN 恰恰是配置表漏填、
     * 或上游算错了之后最常见的形态（比如 `width / 0`、`parseFloat('')`）。
     *
     * 实测 `minRoomSize: NaN`：
     * ```
     * roomCount = 16，首个房间 cx = NaN，allRoomsReachable() = false
     * ```
     *
     * 根因链：`_split` 里 `minSize = NaN` → `node.w < NaN * 2` 恒 false
     * → 分割条件永远成立 → `rng.int(NaN, NaN)` 返回 NaN
     * → 子节点坐标全 NaN → `_createRooms` 造出 NaN 房间 push 进 `_rooms`
     * → `_carveRoom` 的 `for (y = NaN; y < NaN; y++)` 一次都不执行，
     *    **地图上其实没有这个房间**，但 `_rooms` 里记了一个。
     *
     * 后果：`findFarthestRoom`（放 Boss 房/出生点）基于 NaN 距离算出错误结果；
     * `allRoomsReachable()` 恒 false 触发死图重生成。
     *
     * 【上界怎么定】
     * - `minRoomSize` / `roomPadding` / `corridorWidth` 是"格子数"，
     *   不可能超过地图短边，超过就是配错，直接夹到短边。
     * - `maxDepth` 是递归深度，深度 d 最多产生 2^d 个节点，
     *   32 层在实践中不可能用到（且会栈溢出），夹到 16 足够。
     */
    const shortSide = Math.min(opts.width, opts.height);

    /**
     * 【为什么这里用 numOr 之后再抛错，而不是一路 clampNum】
     *
     * 先用 `numOr` 把 NaN / 非有限值落回默认值 6（这就是本次要修的点：
     * NaN 原本会一路穿成 NaN 房间），**再**保留"小于 3 就抛错"的既有契约。
     *
     * 【为什么不能直接 clampNum(v, 3, ...】
     * 试过：那样 `minRoomSize: 2` 会被静默夹成 3，不再抛错，
     * 既有测试 `minRoomSize 过小抛错` 立刻变红。
     *
     * 这里体现的是本文件反复出现的那条纪律：
     * **"小于下界"是调用方填错，要报错；"填了 NaN"是值缺失，要兜底。**
     * 两类情况不能合并成同一种处理——合并了就一定会漏掉其中一类。
     */
    const minRoomSize = numOr(opts.minRoomSize, 6);
    if (!(minRoomSize >= 3)) throw new Error('[BSP] minRoomSize 至少为 3');

    this._opts = {
      // 上界夹到地图短边：比地图还大的房间根本放不下
      minRoomSize: Math.min(minRoomSize, shortSide),
      maxDepth: clampNum(opts.maxDepth, 1, 16, 4),
      roomPadding: clampNum(opts.roomPadding, 0, Math.max(0, Math.floor(shortSide / 2)), 1),
      corridorWidth: clampNum(opts.corridorWidth, 1, Math.max(1, Math.floor(shortSide / 2)), 1),
    };
  }

  generate(): void {
    this._tiles.fill(Tile.Wall);
    this._rooms = [];
    // 整块重写地形（fill 不走 setTile）→ 缓存必须显式失效
    this._invalidateCaches();

    this._root = { x: 0, y: 0, w: this._w, h: this._h, left: null, right: null, room: null, depth: 0 };
    this._split(this._root);
    this._createRooms(this._root);
    this._connectRooms();
  }

  private _split(node: BSPNode): void {
    if (node.depth >= this._opts.maxDepth) return;

    // 太小了不能再分
    const minSize = this._opts.minRoomSize + this._opts.roomPadding * 2;
    if (node.w < minSize * 2 && node.h < minSize * 2) return;

    let horizontal: boolean;

    /**
     * 【沿长边分割】
     * 宽 > 高就竖着切（分成左右），否则横着切（分成上下）。
     * 这样房间形状才规整，不会出现细长条。
     *
     * 【长宽比 > 1.25 时强制沿长边】
     * 否则会出现 5×40 这种怪异房间。
     */
    const ratio = node.w / node.h;
    if (ratio > 1.25) horizontal = false;        // 竖切
    else if (ratio < 0.8) horizontal = true;     // 横切
    else horizontal = this._rng.next() < 0.5;

    if (horizontal) {
      // 横切：分成上下
      if (node.h < minSize * 2) return;
      const cut = this._rng.int(minSize, node.h - minSize);
      node.left = { x: node.x, y: node.y, w: node.w, h: cut, left: null, right: null, room: null, depth: node.depth + 1 };
      node.right = { x: node.x, y: node.y + cut, w: node.w, h: node.h - cut, left: null, right: null, room: null, depth: node.depth + 1 };
    } else {
      // 竖切：分成左右
      if (node.w < minSize * 2) return;
      const cut = this._rng.int(minSize, node.w - minSize);
      node.left = { x: node.x, y: node.y, w: cut, h: node.h, left: null, right: null, room: null, depth: node.depth + 1 };
      node.right = { x: node.x + cut, y: node.y, w: node.w - cut, h: node.h, left: null, right: null, room: null, depth: node.depth + 1 };
    }

    this._split(node.left);
    this._split(node.right);
  }

  private _createRooms(node: BSPNode): void {
    if (node.left === null && node.right === null) {
      // 叶子：造房间
      const pad = this._opts.roomPadding;
      const maxW = node.w - pad * 2;
      const maxH = node.h - pad * 2;

      if (maxW < 3 || maxH < 3) return;   // 太小，放弃这个叶子

      const rw = this._rng.int(Math.min(3, maxW), maxW);
      const rh = this._rng.int(Math.min(3, maxH), maxH);
      const rx = node.x + pad + this._rng.int(0, maxW - rw);
      const ry = node.y + pad + this._rng.int(0, maxH - rh);

      const room: Room = { id: this._rooms.length, x: rx, y: ry, w: rw, h: rh, cx: 0, cy: 0 };
      const c = rectCenter(room);
      (room as { cx: number; cy: number }).cx = c.cx;
      (room as { cx: number; cy: number }).cy = c.cy;

      node.room = room;
      this._rooms.push(room);
      this._carveRoom(room);
      return;
    }

    if (node.left) this._createRooms(node.left);
    if (node.right) this._createRooms(node.right);
  }

  private _carveRoom(r: Rect): void {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) this.setTile(x, y, Tile.Floor);
    }
  }

  /**
   * 连接房间
   *
   * 【沿 BSP 树向上回溯连接】
   * 这是 BSP 的精髓：兄弟节点的房间一定被连接，
   * 递归上去后**整棵树必然连通**。
   *
   * 所以 BSP 生成器的死图率是 0——
   * 这是它比其他生成器可靠的核心原因。
   */
  private _connectRooms(): void {
    if (this._root) this._connect(this._root);
  }

  private _connect(node: BSPNode): BSPNode | null {
    if (node.left === null && node.right === null) return node.room ? node : null;

    const leftNode = node.left ? this._connect(node.left) : null;
    const rightNode = node.right ? this._connect(node.right) : null;

    if (leftNode && rightNode) {
      const a = this._findRoomIn(leftNode);
      const b = this._findRoomIn(rightNode);
      if (a && b) this._carveCorridor(a, b);
    }

    // 向上返回一个带房间的节点
    if (leftNode) return leftNode;
    if (rightNode) return rightNode;
    return null;
  }

  private _findRoomIn(node: BSPNode): Room | null {
    if (node.room) return node.room;
    if (node.left) {
      const r = this._findRoomIn(node.left);
      if (r) return r;
    }
    if (node.right) return this._findRoomIn(node.right);
    return null;
  }

  /** L 形走廊 */
  private _carveCorridor(a: Room, b: Room): void {
    const horizontalFirst = this._rng.next() < 0.5;
    const w = this._opts.corridorWidth;

    if (horizontalFirst) {
      this._carveH(a.cx, b.cx, a.cy, w);
      this._carveV(a.cy, b.cy, b.cx, w);
    } else {
      this._carveV(a.cy, b.cy, a.cx, w);
      this._carveH(a.cx, b.cx, b.cy, w);
    }
  }

  private _carveH(x0: number, x1: number, y: number, w: number): void {
    const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0];
    for (let x = a; x <= b; x++) {
      for (let dy = 0; dy < w; dy++) {
        if (this.tileAt(x, y + dy) === Tile.Wall) this.setTile(x, y + dy, Tile.Floor);
      }
    }
  }

  private _carveV(y0: number, y1: number, x: number, w: number): void {
    const [a, b] = y0 < y1 ? [y0, y1] : [y1, y0];
    for (let y = a; y <= b; y++) {
      for (let dx = 0; dx < w; dx++) {
        if (this.tileAt(x + dx, y) === Tile.Wall) this.setTile(x + dx, y, Tile.Floor);
      }
    }
  }
}

// ============================================================
// RoomDungeon —— 随机撒房间
// ============================================================

export interface RoomDungeonOptions {
  width: number;
  height: number;
  seed: number;
  /** 尝试放置的房间数（实际会少一些） */
  roomCount?: number;
  minRoomSize?: number;
  maxRoomSize?: number;
  /** 房间之间的最小间隔 */
  spacing?: number;
}

export class RoomDungeon extends DungeonBase {
  private readonly _opts: Required<Omit<RoomDungeonOptions, 'width' | 'height' | 'seed'>>;

  constructor(opts: RoomDungeonOptions) {
    super(opts.width, opts.height, opts.seed);
    /**
     * 【⚠️ 为什么 maxRoomSize 必须按地图尺寸收口】
     *
     * 原实现直接用 `rng.int(minRoomSize, maxRoomSize)` 当房间宽高，
     * 完全不校验它是否放得进地图。实测 `minRoomSize: 900, maxRoomSize: 999`
     * 配 24×24 的地图：
     *
     * ```
     * 首个房间 w = 919、h = 985，cx = 460、cy = 493   ← 中心在地图外
     * ```
     *
     * 根因有两层，叠在一起才产生这么离谱的结果：
     *
     * 1. `Rng.int(min, max)` 在 `max < min` 时**返回 min**（不是抛错）。
     *    所以 `x = rng.int(1, this._w - w - 2)` 中 `24 - 919 - 2` 远小于 1，
     *    于是 x 被静默取成 1。
     * 2. `setTile` 对越界坐标**直接 return**（静默截断），
     *    于是地图上真的只画出了左上角那一小块；
     *    但 `room.w / room.h` 仍然记着 919 / 985 这两个原始值。
     *
     * 后果：`rectCenter` 按"记录值"算出 cx = 460，
     * 于是出生点、Boss 房、传送门全被放到地图外——
     * 表现为"传送到地图外 / 出生即卡在墙里"，且不报错。
     *
     * 【为什么是夹到短边而不是抛错】
     * 房间尺寸由配置表给出，写大了更可能是笔误而不是致命错误；
     * 夹到"能放得下"的最大值可以继续出图。
     * 真正放不下的情况（短边 < 5）已被基类构造拦住。
     */
    const shortSide = Math.min(opts.width, opts.height);
    // 房间必须缩进地图 1 格（边界留墙），再留 1 格余量给走廊
    const sizeCap = Math.max(3, shortSide - 4);
    const minRoomSize = clampNum(opts.minRoomSize, 3, sizeCap, 4);
    const maxRoomSize = clampNum(opts.maxRoomSize, minRoomSize, sizeCap, Math.min(10, sizeCap));

    this._opts = {
      roomCount: clampNum(opts.roomCount, 0, 1e6, 12),
      minRoomSize,
      maxRoomSize,
      spacing: clampNum(opts.spacing, 0, Math.max(0, Math.floor(shortSide / 2)), 2),
    };
  }

  generate(): void {
    this._tiles.fill(Tile.Wall);
    this._rooms = [];
    // 整块重写地形（fill 不走 setTile）→ 缓存必须显式失效
    this._invalidateCaches();

    const maxTries = this._opts.roomCount * 20;

    for (let i = 0; i < maxTries && this._rooms.length < this._opts.roomCount; i++) {
      const w = this._rng.int(this._opts.minRoomSize, this._opts.maxRoomSize);
      const h = this._rng.int(this._opts.minRoomSize, this._opts.maxRoomSize);
      const x = this._rng.int(1, this._w - w - 2);
      const y = this._rng.int(1, this._h - h - 2);

      const rect: Rect = { x, y, w, h };

      // 重叠检查
      let overlaps = false;
      for (const r of this._rooms) {
        if (rectsOverlap(rect, r, this._opts.spacing)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      const c = rectCenter(rect);
      const room: Room = { id: this._rooms.length, x, y, w, h, cx: c.cx, cy: c.cy };
      this._rooms.push(room);

      for (let ry = y; ry < y + h; ry++) {
        for (let rx = x; rx < x + w; rx++) this.setTile(rx, ry, Tile.Floor);
      }
    }

    this._connectAll();
  }

  /**
   * 连接所有房间
   *
   * 【策略：先连成生成树，再加几条环路】
   *
   * ① 按距离排序，用并查集连成最小生成树（保证连通且不绕）
   * ② 随机加几条额外连接（环路），避免地图只有一条主路太单调
   *
   * 【为什么用并查集】
   * 直接"每个房间连最近的"会产生孤岛环。
   * 并查集能确保最后**一定是一整块**。
   */
  private _connectAll(): void {
    if (this._rooms.length < 2) return;

    const n = this._rooms.length;
    const uf = new DisjointSet(n);

    // 所有房间对（按距离排序）
    const pairs: Array<{ a: number; b: number; d: number }> = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ra = this._rooms[i];
        const rb = this._rooms[j];
        pairs.push({ a: i, b: j, d: Math.abs(ra.cx - rb.cx) + Math.abs(ra.cy - rb.cy) });
      }
    }
    pairs.sort((p, q) => p.d - q.d);

    // 最小生成树
    for (const p of pairs) {
      if (uf.union(p.a, p.b)) {
        this._carveCorridor(this._rooms[p.a], this._rooms[p.b]);
      }
    }

    // 加几条环路（约 15%）
    const extraCount = Math.max(1, Math.floor(n * 0.15));
    const shuffled = this._rng.shuffle(pairs.slice());
    let added = 0;

    for (const p of shuffled) {
      if (added >= extraCount) break;
      if (uf.connected(p.a, p.b)) continue;   // 已经连通的跳过（上面的逻辑其实已全连通）
      this._carveCorridor(this._rooms[p.a], this._rooms[p.b]);
      uf.union(p.a, p.b);
      added++;
    }
  }

  private _carveCorridor(a: Room, b: Room): void {
    const horizontalFirst = this._rng.next() < 0.5;

    if (horizontalFirst) {
      this._carveH(a.cx, b.cx, a.cy);
      this._carveV(a.cy, b.cy, b.cx);
    } else {
      this._carveV(a.cy, b.cy, a.cx);
      this._carveH(a.cx, b.cx, b.cy);
    }
  }

  private _carveH(x0: number, x1: number, y: number): void {
    const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0];
    for (let x = a; x <= b; x++) {
      if (this.tileAt(x, y) === Tile.Wall) this.setTile(x, y, Tile.Floor);
    }
  }

  private _carveV(y0: number, y1: number, x: number): void {
    const [a, b] = y0 < y1 ? [y0, y1] : [y1, y0];
    for (let y = a; y <= b; y++) {
      if (this.tileAt(x, y) === Tile.Wall) this.setTile(x, y, Tile.Floor);
    }
  }
}

// ============================================================
// CellularDungeon —— 元胞自动机洞穴
// ============================================================

export interface CellularOptions {
  width: number;
  height: number;
  seed: number;
  /** 初始随机填充的墙比例（0.45 效果最好） */
  initialWallChance?: number;
  /** 迭代次数 */
  iterations?: number;
  /** 邻居中墙数 > 此值则变墙 */
  birthLimit?: number;
  /** 邻居中墙数 < 此值则变地板 */
  deathLimit?: number;
}

export class CellularDungeon extends DungeonBase {
  private readonly _opts: Required<Omit<CellularOptions, 'width' | 'height' | 'seed'>>;

  constructor(opts: CellularOptions) {
    super(opts.width, opts.height, opts.seed);
    this._opts = {
      initialWallChance: opts.initialWallChance ?? 0.45,
      iterations: opts.iterations ?? 5,
      birthLimit: opts.birthLimit ?? 5,
      deathLimit: opts.deathLimit ?? 4,
    };
  }

  /**
   * 一次性生成（加载期用这个）
   *
   * 【⚠️ 耗时实测】
   *
   * | 边长 | 本模块 | `BSPDungeon` |
   * |---|---|---|
   * | 64  | 11ms | <1ms |
   * | 128 |  6ms | <1ms |
   * | 256 | 14ms |  1ms |
   * | 512 | **62ms（≈3.7 帧）** |  1ms |
   *
   * 算法固有成本：随机填充 1 遍 + 平滑 5 遍，每遍都是 O(w×h) 且每格数 8 个邻居。
   * 512² × 6 遍 ≈ 160 万格、1300 万次邻居统计。
   *
   * **加载期用完全没问题**（有 loading 画面遮着）。
   * **运行时动态生成请用 `generateSteps()` 分帧**，
   * 或者干脆换 `BSPDungeon`——同样的尺寸快 60 倍。
   */
  generate(): void {
    // 唯一实现是 generateSteps()，这里用超大步长一次跑完，
    // 避免出现两份逻辑各自演化（改了这边忘了那边）。
    const it = this.generateSteps(Number.POSITIVE_INFINITY);
    while (!it.next().done) { /* 一直跑到结束 */ }
  }

  /**
   * 分帧生成（运行时动态生成用这个）
   *
   * 【为什么需要】
   * 512×512 一次性生成 62ms ≈ 3.7 帧。加载期无所谓，
   * 运行时就是肉眼可见的卡顿。
   *
   * 【用法】用任何调度器驱动，每次 `next()` 只推进一小段：
   *
   * ```typescript
   * const it = dungeon.generateSteps();
   * scheduler.everyFrame(() => {
   *   if (it.next().done) { scheduler.stop(); onReady(); }
   * });
   * ```
   *
   * 【⚠️ 生成过程中地图处于中间状态】
   * 没跑完之前 `tileAt()` 拿到的是还没平滑完的噪声图，
   * 此时寻路/刷怪都会基于错误数据。要么等 `done` 再用，要么先挡住玩家输入。
   *
   * 【单次 next() 的成本】
   * 约 `rowsPerStep × width × 8` 次邻居统计。
   * 512 宽、每步 16 行 ≈ 6.5 万次 ≈ 0.3ms，远低于一帧预算。
   *
   * 【⚠️ 最后一步会稍长】
   * 前三个阶段（填充 / 平滑 / 封边）都按行切片，
   * 但第四阶段「孤岛清理」是一次性 floodFill——它要找连通区域，
   * 无法按行安全地切片（行与行之间的连通性是跨行的）。
   * 若连这一帧都不能掉，请把地图边长控制在 256 以内，或改用 `BSPDungeon`。
   *
   * @param rowsPerStep 每次 `next()` 处理多少行。越小越平滑，总耗时略增。
   * @yields 当前进度（0~1）
   */
  *generateSteps(rowsPerStep = 16): Generator<number, void, void> {
    /**
     * 【⚠️ 为什么 _smoothBuf 挂在实例上，以及它带来的三个坑】
     *
     * 缓冲必须**跨 yield 存活**（平滑是按行写的，一行写完就 yield 给主线程），
     * 所以不能是函数内的局部变量，只能挂实例。
     *
     * 但"挂实例"意味着这个缓冲是**实例级共享状态**，于是有三个坑：
     *
     * ① **重入 / 并发互相踩**：同一个实例同时开两个 generator
     *    （典型场景：玩家快速切层，上一层的生成还没跑完就起了下一层），
     *    两个 generator 交替 next 会往同一个 buffer 上写不同的行，
     *    产出一张"两层的缝合怪"地图 —— 不报错，且极难复现。
     *
     * ② **异常退出不清空**：迭代中途抛错（或调用方 break 后不调 `return()`）时，
     *    `w × h` 字节的缓冲会**一直挂在实例上不释放**。
     *    1024² 的图就是 1MB × 实例数，切几次关卡就堆起来了。
     *
     * ③ 因此这里做两件事：
     *    - 开头检测重入（第二个 generator 直接抛错，而不是默默产出坏地图）
     *    - `try/finally` 保证任何出口都清空缓冲
     *
     * 【调用方约定】丢弃 generator 前请 `g.return()`，
     * 否则 `finally` 要等到 GC 才执行（挂起的 generator 不会自己跑 finally）。
     */
    if (this._genRunning) {
      throw new Error(
        '[Cellular] 上一次 generateSteps 尚未结束，不能同时开第二个。' +
          '同一个实例的平滑缓冲是共享的，两个生成器交替推进会产出"缝合地图"。' +
          '请先把上一个跑完（或调用 g.return() 中止），或换一个实例。'
      );
    }
    this._genRunning = true;
    // 上一次半途而废留下的残留先清掉（否则 w×h 内存一直驻留）
    this._smoothBuf = null;
    this._rooms = [];
    this._invalidateCaches();

    try {
      yield* this._generateStepsInner(rowsPerStep);
    } finally {
      this._smoothBuf = null;
      this._genRunning = false;
    }
  }

  private *_generateStepsInner(rowsPerStep = 16): Generator<number, void, void> {

    const w = this._w;
    const h = this._h;
    const total = h * (1 + this._opts.iterations) + h;
    let doneRows = 0;
    const step = Number.isFinite(rowsPerStep) && rowsPerStep > 0
      ? Math.floor(rowsPerStep)
      : h;
    const report = (): number => Math.min(1, doneRows / total);

    // ① 随机填充
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 边界强制为墙，否则会漏
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          this.setTile(x, y, Tile.Wall);
        } else {
          this.setTile(x, y, this._rng.next() < this._opts.initialWallChance ? Tile.Wall : Tile.Floor);
        }
      }
      doneRows++;
      if (y % step === step - 1) yield report();
    }

    // ② 迭代平滑
    for (let i = 0; i < this._opts.iterations; i++) {
      // 缓冲区要跨 yield 存活，所以挂在实例上
      this._smoothBuf = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        this._smoothRow(y);
        doneRows++;
        if (y % step === step - 1) yield report();
      }
      this._tiles = this._smoothBuf;
      this._smoothBuf = null;
    }

    // ③ 边界再封一次（迭代可能把边界打开）
    //    只有 2×(w+h) 次写入，一次性做完
    for (let x = 0; x < w; x++) {
      this.setTile(x, 0, Tile.Wall);
      this.setTile(x, h - 1, Tile.Wall);
    }
    for (let y = 0; y < h; y++) {
      this.setTile(0, y, Tile.Wall);
      this.setTile(w - 1, y, Tile.Wall);
    }

    // ④ 元胞自动机**必然产生孤岛**，必须清理
    //    见上面文档：这一步无法安全切片，一次性完成
    this._removeIsolated();
    doneRows += h;
    yield 1;
  }

  /** 平滑缓冲（跨 yield 存活，仅 generateSteps 期间非空） */
  private _smoothBuf: Uint8Array | null = null;
  /** generateSteps 是否正在跑（重入保护，见 generateSteps 注释） */
  private _genRunning = false;

  /** 平滑一行：把结果写进 _smoothBuf */
  private _smoothRow(y: number): void {
    const buf = this._smoothBuf;
    if (buf === null) return;
    for (let x = 0; x < this._w; x++) {
      const walls = this._countWallNeighbors(x, y);
      buf[y * this._w + x] = this.tileAt(x, y) === Tile.Wall
        ? (walls < this._opts.deathLimit ? Tile.Floor : Tile.Wall)
        : (walls > this._opts.birthLimit ? Tile.Wall : Tile.Floor);
    }
  }


  /** 八邻居里的墙数（含自己，越界算墙） */
  private _countWallNeighbors(x: number, y: number): number {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (this.tileAt(x + dx, y + dy) === Tile.Wall) n++;
      }
    }
    return n;
  }

  /**
   * 移除孤立的小区域
   *
   * 【关键】元胞自动机几乎必然产生孤岛。
   * 不清理的话，玩家可能在地图上看到一块走不到的地方，
   * 或者宝箱生成在里面导致无法通关。
   *
   * 【策略】
   * ① 找出所有连通区域
   * ② 保留最大的那个
   * ③ 其他区域：小的直接填成墙，大的用隧道连到主区
   */
  private _removeIsolated(): void {
    const visited = new Uint8Array(this._w * this._h);
    const regions: number[][] = [];

    for (let y = 0; y < this._h; y++) {
      for (let x = 0; x < this._w; x++) {
        const i = y * this._w + x;
        if (visited[i]) continue;
        if (!this.isWalkable(x, y)) continue;

        // BFS 收集这个区域
        const region: number[] = [];
        const stack = [i];
        visited[i] = 1;

        while (stack.length > 0) {
          const cur = stack.pop()!;
          region.push(cur);
          const cx = cur % this._w;
          const cy = (cur / this._w) | 0;

          for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (!this.isWalkable(nx, ny)) continue;
            const ni = ny * this._w + nx;
            if (visited[ni]) continue;
            visited[ni] = 1;
            stack.push(ni);
          }
        }

        regions.push(region);
      }
    }

    if (regions.length <= 1) return;

    // 按大小排序
    regions.sort((a, b) => b.length - a.length);
    const main = regions[0];

    for (let r = 1; r < regions.length; r++) {
      const region = regions[r];

      // 小于主区 5% 的直接填掉
      if (region.length < main.length * 0.05) {
        for (const i of region) this._tiles[i] = Tile.Wall;
        continue;
      }

      // 大的：连到主区
      this._tunnelToMain(region, main);
    }
  }

  /**
   * 【⚠️ 这里曾经是全库最严重的性能地雷，四份外部审查报告全部漏掉】
   *
   * 原实现是**两区全量两两比较**：
   *
   * ```typescript
   * for (const a of region) for (const b of main) { ... }   // O(|region| × |main|)
   * ```
   *
   * 只有"大次区"才会走到这里（小于主区 5% 的会直接填掉），
   * 所以常规参数下测不出来——但一旦出现两个大区：
   *
   * | 边长 | initialWallChance | 实测 |
   * |---|---|---|
   * | 128 | 0.55 | 60ms |
   * | 192 | 0.55 | 142ms |
   * | 256 | 0.55 | **418ms** |
   * | 384 | 0.55 | **1295ms ≈ 78 帧** |
   *
   * 增长远超面积增长（面积 ×1.5，耗时 ×2.4~30），确认是平方级。
   * 而且**它不在任何报告的结论里**——性能报告把 dungeon 的批量操作
   * 列为"未通过校验、不下结论"，所以这条从未被测量。
   *
   * 【为什么采样够用】
   * 目标是"把两个区连起来"，不是"找到数学上最近的一对"。
   * 采样步长 ≤ 256，误差最多是采样间距（几个格子）——
   * 隧道长一点短一点，玩法上没有任何区别。
   *
   * 【复杂度】O(SAMPLE²) = 常数，与地图大小无关。
   */
  private _tunnelToMain(region: readonly number[], main: readonly number[]): void {
    const SAMPLE = 256;
    const stepA = Math.max(1, Math.ceil(region.length / SAMPLE));
    const stepB = Math.max(1, Math.ceil(main.length / SAMPLE));

    let bestA = region[0];
    let bestB = main[0];
    let bestD = Infinity;

    // 两区各按步长采样，做 SAMPLE² 以内的比较
    for (let ia = 0; ia < region.length; ia += stepA) {
      const a = region[ia];
      const ax = a % this._w;
      const ay = (a / this._w) | 0;
      for (let ib = 0; ib < main.length; ib += stepB) {
        const b = main[ib];
        const bx = b % this._w;
        const by = (b / this._w) | 0;
        const d = (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
        if (d < bestD) {
          bestD = d;
          bestA = a;
          bestB = b;
        }
      }
    }

    const ax = bestA % this._w;
    const ay = (bestA / this._w) | 0;
    const bx = bestB % this._w;
    const by = (bestB / this._w) | 0;

    // L 形挖通
    for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) {
      if (this.tileAt(x, ay) === Tile.Wall) this.setTile(x, ay, Tile.Floor);
    }
    for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) {
      if (this.tileAt(bx, y) === Tile.Wall) this.setTile(bx, y, Tile.Floor);
    }
  }
}

// ============================================================
// MazeDungeon —— 完美迷宫
// ============================================================

export interface MazeOptions {
  width: number;
  height: number;
  seed: number;
  /**
   * 打通比例（0 = 完美迷宫无环，0.1 = 打通 10% 的墙增加环路）
   *
   * 【为什么完美迷宫不好玩】
   * 完美迷宫只有唯一解，走错就要原路返回，非常挫败。
   * 加一点环路会好玩很多。
   */
  braidRatio?: number;
}

export class MazeDungeon extends DungeonBase {
  private readonly _opts: Required<Omit<MazeOptions, 'width' | 'height' | 'seed'>>;

  /**
   * 复用的方向缓冲（4 个对象，整个生命周期只有这 4 个）
   *
   * 【⚠️ 为什么不能继续在循环里 `shuffle([{dx,dy} × 4])`】
   *
   * 原写法是**每个格子**都新建一个数组 + 4 个对象字面量再洗牌。
   * 迷宫生成要访问每一个"房间格"，所以分配次数 ≈ 格子数：
   *
   * ```
   * 512×512 迷宫 → 约 6.5 万个房间格 × (1 数组 + 4 对象) ≈ 26 万次分配
   * ```
   *
   * 这些对象**活不过一次循环**（洗完牌、挑一个方向就扔），
   * 是典型的"新生代垃圾"：不 OOM，但会让 GC 在生成期反复触发，
   * 表现为"生成大迷宫时偶发掉帧"，且**只在大地图上出现**——
   * 小地图测多少次都不会卡，所以极难定位。
   *
   * 【为什么复用不会改变生成结果】
   * `shuffle` 的随机性只来自 `rng.next()` 的调用次数与取值，
   * 与数组里装的是新对象还是旧对象无关。
   * 只要每次洗牌前把顺序**重置成固定的 [上,右,下,左]**，
   * 洗牌算法的输入就与原来完全一致 —— 相同种子生成**逐格相同**的迷宫
   * （测试里有这条对照）。
   */
  private readonly _stepBuf: Array<{ dx: number; dy: number }> = [
    { dx: 0, dy: -2 },
    { dx: 2, dy: 0 },
    { dx: 0, dy: 2 },
    { dx: -2, dy: 0 },
  ];

  /** 取一个洗过牌的方向数组（复用缓冲，调用方不得保存引用） */
  private _nextStepOrder(): Array<{ dx: number; dy: number }> {
    const b = this._stepBuf;
    b[0].dx = 0; b[0].dy = -2;
    b[1].dx = 2; b[1].dy = 0;
    b[2].dx = 0; b[2].dy = 2;
    b[3].dx = -2; b[3].dy = 0;
    return this._rng.shuffle(b);
  }

  constructor(opts: MazeOptions) {
    super(opts.width, opts.height, opts.seed);
    // 与 BSP / Room 保持同样的收口口径：?? 挡不住 NaN，
    // 而 NaN 会让 `braidRatio <= 0` 恒为 false，环路一条都打不通（静默）。
    this._opts = { braidRatio: clampNum(opts.braidRatio, 0, 1, 0.1) };

    /**
     * 【坑】迷宫尺寸必须是奇数
     *
     * 迷宫用"格子 + 墙"的表示法：
     * 偶数坐标是墙，奇数坐标是房间。
     * 尺寸为偶数时最后一行/列会没有房间。
     */
    if (this._w % 2 === 0 || this._h % 2 === 0) {
      throw new Error(`[Maze] 尺寸必须为奇数，当前 ${this._w}×${this._h}`);
    }
  }

  generate(): void {
    this._tiles.fill(Tile.Wall);
    this._rooms = [];
    // 整块重写地形（fill 不走 setTile）→ 缓存必须显式失效
    this._invalidateCaches();

    // 递归回溯（迭代版，避免深递归爆栈）
    const stack: Array<{ x: number; y: number }> = [];
    const startX = 1;
    const startY = 1;

    this.setTile(startX, startY, Tile.Floor);
    stack.push({ x: startX, y: startY });

    while (stack.length > 0) {
      const cur = stack[stack.length - 1];

      // 找未访问的邻居（隔一格）
      const dirs = this._nextStepOrder();

      let moved = false;

      for (const d of dirs) {
        const nx = cur.x + d.dx;
        const ny = cur.y + d.dy;

        if (nx <= 0 || ny <= 0 || nx >= this._w - 1 || ny >= this._h - 1) continue;
        if (this.tileAt(nx, ny) !== Tile.Wall) continue;

        // 打通中间的墙
        this.setTile(cur.x + d.dx / 2, cur.y + d.dy / 2, Tile.Floor);
        this.setTile(nx, ny, Tile.Floor);
        stack.push({ x: nx, y: ny });
        moved = true;
        break;
      }

      if (!moved) stack.pop();
    }

    this._braid();
  }

  /** 随机打通一些墙，制造环路 */
  private _braid(): void {
    if (this._opts.braidRatio <= 0) return;

    const candidates: Array<{ x: number; y: number }> = [];

    for (let y = 1; y < this._h - 1; y++) {
      for (let x = 1; x < this._w - 1; x++) {
        if (this.tileAt(x, y) !== Tile.Wall) continue;
        // 只考虑"两侧是通路"的墙（打通它才有意义）
        const horizontal = this.isWalkable(x - 1, y) && this.isWalkable(x + 1, y);
        const vertical = this.isWalkable(x, y - 1) && this.isWalkable(x, y + 1);
        if (horizontal || vertical) candidates.push({ x, y });
      }
    }

    const count = Math.floor(candidates.length * this._opts.braidRatio);
    this._rng.shuffle(candidates);

    for (let i = 0; i < count && i < candidates.length; i++) {
      this.setTile(candidates[i].x, candidates[i].y, Tile.Floor);
    }
  }
}
