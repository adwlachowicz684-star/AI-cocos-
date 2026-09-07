/**
 * Grid —— 二维网格 + 建造放置 + 六边形坐标
 *
 * 【它解决什么】
 *
 * 三个完全不同的需求，但底层是同一套"格子"抽象：
 *
 * **① 通用网格**（棋盘、地图片、贪吃蛇、扫雷）
 * 需要：边界检查、邻居查询、坐标↔索引互转、区域填充
 *
 * **② 建造放置**（塔防、模拟经营、城市建造）
 * 需要：一个建筑占多格、能不能放、旋转、拆除、越界检测
 *
 * **③ 六边形网格**（战棋、4X）
 * 需要：axial 坐标、六邻居、距离、像素↔格子互转
 *
 * 【为什么不用二维数组直接写】
 * 直接写 `arr[y][x]` 的话，「越界」「占多格」「旋转」这三件事
 * 会在业务代码里重复十几遍，而且每次都容易写错边界。
 *
 * 【使用示例：通用网格】
 * ```typescript
 * const g = new Grid<string>(10, 8);
 * g.set(3, 4, '树');
 * g.get(3, 4);              // '树'
 * g.get(99, 99);            // undefined（不崩）
 * g.inBounds(3, 4);         // true
 *
 * g.neighbors4(3, 4);       // 上下左右四个 {x, y, value}
 * g.neighbors8(3, 4);       // 八个方向
 *
 * for (const cell of g) { ... }   // 可迭代
 * g.fill(0, 0, 5, 5, '水');
 * g.find((v) => v === '树');        // ⚠️ 回调第一个参数是**值本身**，不是 cell 对象
 * ```
 *
 * 【使用示例：建造放置】
 * ```typescript
 * const place = new GridPlacement(20, 20);
 *
 * place.define('house', { w: 2, h: 2 });
 * place.define('road', { w: 1, h: 1 });
 *
 * place.canPlace('house', 5, 5);        // true / false
 * place.place('house', 5, 5, 'house#1');
 * place.at(5, 5);                       // 'house#1'
 * place.at(6, 6);                       // 'house#1'（占了 2×2）
 *
 * place.canPlace('road', 5, 5);         // false（被房子占了）
 * place.remove('house#1');              // 拆除，格子全部释放
 * ```
 *
 * 【使用示例：六边形】
 * ```typescript
 * const h = hexDistance({q:0,r:0}, {q:3,r:-1});   // 3
 * hexNeighbors({q:0,r:0});                        // 六个邻居
 * hexToPixel({q:2,r:-1}, 10);                     // { x, y }
 * pixelToHex(25, -8, 10);                         // { q, r }
 * ```
 *
 * 【无引擎依赖】
 */

import { IVec2 } from '../_core/types';

// ============================================================
// Grid<T> —— 通用二维网格
// ============================================================

export interface Cell<T> {
  readonly x: number;
  readonly y: number;
  value: T | undefined;
}

/** 八方向偏移（上、右上、右、右下、下、左下、左、左上） */
const DIR8: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

/** 四方向偏移（上、右、下、左） */
const DIR4: ReadonlyArray<readonly [number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export class Grid<T> implements Iterable<Cell<T>> {
  private readonly _data: Array<T | undefined>;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number, fill?: T) {
    if (width <= 0 || height <= 0) throw new Error('[Grid] 宽高必须为正');
    this.width = width;
    this.height = height;
    // 同样要 fill：稀疏数组会让 filter/map 静默跳过
    this._data = new Array<T | undefined>(width * height).fill(undefined);
    if (fill !== undefined) this._data.fill(fill);
  }

  /** 坐标 → 一维下标（-1 = 越界） */
  index(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): T | undefined {
    const i = this.index(x, y);
    return i < 0 ? undefined : this._data[i];
  }

  /**
   * 设置
   *
   * @returns 是否成功（越界返回 false，**不抛异常**）
   *
   * 【为什么越界不抛错】
   * 网格查询经常发生在"扫描周围一圈"的场景，
   * 边缘格子必然会越界。抛错会逼你每次都先 inBounds，
   * 而返回 undefined 让"扫描邻居"的写法干净很多。
   */
  set(x: number, y: number, value: T | undefined): boolean {
    const i = this.index(x, y);
    if (i < 0) return false;
    this._data[i] = value;
    return true;
  }

  /** 强制设置（越界抛错，用于发现逻辑错误） */
  setStrict(x: number, y: number, value: T | undefined): void {
    if (!this.set(x, y, value)) {
      throw new Error(`[Grid] 坐标越界：(${x}, ${y})，网格 ${this.width}×${this.height}`);
    }
  }

  /** 清空为 undefined */
  clear(): void {
    this._data.fill(undefined);
  }

  /** 全部填充 */
  fillAll(value: T): void {
    this._data.fill(value);
  }

  /** 填充矩形区域 */
  fill(x0: number, y0: number, w: number, h: number, value: T): void {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) this.set(x, y, value);
    }
  }

  // ---- 邻居 ----

  /** 四邻居（存在的才返回） */
  neighbors4(x: number, y: number): Array<{ x: number; y: number; value: T | undefined }> {
    return this._neighbors(x, y, DIR4);
  }

  /** 八邻居 */
  neighbors8(x: number, y: number): Array<{ x: number; y: number; value: T | undefined }> {
    return this._neighbors(x, y, DIR8);
  }

  private _neighbors(
    x: number,
    y: number,
    dirs: ReadonlyArray<readonly [number, number]>
  ): Array<{ x: number; y: number; value: T | undefined }> {
    const out: Array<{ x: number; y: number; value: T | undefined }> = [];
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (!this.inBounds(nx, ny)) continue;
      out.push({ x: nx, y: ny, value: this._data[this.index(nx, ny)] });
    }
    return out;
  }

  // ---- 查询 ----

  /**
   * 按条件查找所有匹配的格子
   *
   * 【⚠️ 回调第一个参数是"值本身"，不是 cell 对象】
   *
   * 旧文档示例写的是 `g.find((c) => c.value === '树')`，
   * 但这里传进去的 `v` 直接来自 `_data[i]`，就是 `set(x, y, v)` 时的那个值。
   * 对 `Grid<string>` 来说它是字符串，`c.value` 恒为 `undefined`，
   * `undefined === '树'` 恒 false → **`find` 静默返回空数组**。
   *
   * 实测：`g.set(3, 4, '树')` 后，照旧文档写返回 0 条，按真实签名写返回 1 条。
   * 调用方会以为"地图里没有树"，去查数据生成逻辑，永远查不到。
   *
   * （也考虑过让 find 传 cell 对象以匹配文档，但那会破坏所有现存调用方，
   * 属于 breaking 改动——所以改文档而不是改实现。）
   */
  find(predicate: (value: T, x: number, y: number) => boolean): Array<{ x: number; y: number; value: T }> {
    const out: Array<{ x: number; y: number; value: T }> = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const v = this._data[y * this.width + x];
        if (v !== undefined && predicate(v, x, y)) out.push({ x, y, value: v });
      }
    }
    return out;
  }

  count(predicate: (value: T) => boolean): number {
    let n = 0;
    for (const v of this._data) if (v !== undefined && predicate(v)) n++;
    return n;
  }

  forEach(fn: (value: T | undefined, x: number, y: number) => void): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        fn(this._data[y * this.width + x], x, y);
      }
    }
  }

  *[Symbol.iterator](): Iterator<Cell<T>> {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        yield { x, y, value: this._data[i] };
      }
    }
  }

  /** 导出为二维数组（存档用） */
  toRows(): Array<Array<T | undefined>> {
    const rows: Array<Array<T | undefined>> = [];
    for (let y = 0; y < this.height; y++) {
      rows.push(this._data.slice(y * this.width, (y + 1) * this.width));
    }
    return rows;
  }

  static fromRows<T>(rows: ReadonlyArray<ReadonlyArray<T | undefined>>): Grid<T> {
    if (rows.length === 0) throw new Error('[Grid] 空数据');
    const w = rows[0].length;
    const g = new Grid<T>(w, rows.length);
    for (let y = 0; y < rows.length; y++) {
      if (rows[y].length !== w) throw new Error(`[Grid] 第 ${y} 行长度不一致`);
      for (let x = 0; x < w; x++) g.setStrict(x, y, rows[y][x]);
    }
    return g;
  }
}

// ============================================================
// GridPlacement —— 建造放置
// ============================================================

export interface PlacementDef {
  readonly id: string;
  /** 占地宽（格） */
  readonly w: number;
  /** 占地高（格） */
  readonly h: number;
  /** 是否允许旋转（旋转后 w/h 互换） */
  readonly rotatable?: boolean;
}

export interface Placed {
  readonly defId: string;
  /** 实例 id（唯一，用于拆除） */
  readonly instanceId: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 旋转了 90° */
  readonly rotated: boolean;
}

export class GridPlacement {
  /** 每格存该格所属的实例 id */
  private readonly _cells: Array<string | undefined>;
  private readonly _placed = new Map<string, Placed>();
  private readonly _defs = new Map<string, PlacementDef>();

  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('[GridPlacement] 宽高必须为正');
    this.width = width;
    this.height = height;
    /**
     * 【坑】必须 fill(undefined)，不能直接 new Array(n)。
     *
     * `new Array(n)` 创建的是**稀疏数组**（holes，不是 undefined 值）。
     * 稀疏数组上调用 filter / map / forEach 会**跳过空洞**：
     * ```typescript
     * new Array(100).filter(() => true).length   // 0  ← 不是 100！
     * ```
     * 结果就是 freeCount 永远返回 0，而且不抛任何异常。
     *
     * 保险起见这里显式填充，避免以后有人再用 filter 踩同一个坑。
     */
    this._cells = new Array<string | undefined>(width * height).fill(undefined);
    this._free = width * height;
  }

  /**
   * 空闲格计数（**增量维护**，不每次全扫）
   *
   * 【为什么不用"getter 里 for 一遍"】
   * 原实现每次读 `freeCount` 都全扫 `_cells`。建造类 UI 的典型用法是
   * "每次放置/拆除后刷新剩余空间"，甚至每帧读一次来更新文本，
   * 那就变成了 O(n) × 帧率。50×50 的网格一次全扫 2500 格、2000 次约 8ms，
   * 地图再大一个量级就是实打实的帧时间。
   *
   * 【为什么不干脆缓存一个值、脏了就置 null】
   * 惰性缓存要求"每个改动点都记得置脏"，漏一处就返回一个**错误的数字**，
   * 而且错得安静——比慢更危险。这里改成所有写入/清除都走
   * `_writeCell` / `_eraseCell` 两个出口，计数在出口里同步增减，
   * 没有"忘记置脏"这个失败模式。
   */
  private _free: number;

  private _writeCell(idx: number, id: string): void {
    if (this._cells[idx] === undefined) this._free--;
    this._cells[idx] = id;
  }

  private _eraseCell(idx: number, id: string): void {
    if (this._cells[idx] === id) this._free++;
    this._cells[idx] = undefined;
  }

  define(def: PlacementDef): this {
    if (def.w < 1 || def.h < 1) throw new Error(`[GridPlacement] ${def.id}: 尺寸必须 ≥1`);
    this._defs.set(def.id, def);
    return this;
  }

  /** 旋转后的尺寸 */
  private _size(def: PlacementDef, rotated: boolean): { w: number; h: number } {
    return rotated ? { w: def.h, h: def.w } : { w: def.w, h: def.h };
  }

  /**
   * 能否放置
   *
   * 【检查三件事】越界 / 已被占用 / 定义不存在
   */
  canPlace(defId: string, x: number, y: number, rotated = false): boolean {
    const def = this._defs.get(defId);
    if (!def) return false;
    if (rotated && !def.rotatable) return false;

    const { w, h } = this._size(def, rotated);
    /**
     * 【为什么必须先用 Number.isFinite 前置校验】
     *
     * 下面那串"否定式"边界判断（`x < 0 || x + w > W || ...`）对 NaN **全部为 false**——
     * NaN 与任何值比较都是 false。于是 `canPlace('h', NaN, 3)` 返回 **true**，
     * `place` 也就"成功"了。
     *
     * 而 `_cells[NaN]` 在 JS 里是数组的 `"NaN"` **字符串属性**，
     * 不进入 `length`、不参与遍历。于是：
     * - `at(NaN, 3)` 能查到 `h#1`（写入确实发生了）
     * - 按坐标全图扫描看到的占用格数 = **0**（渲染层永远画不出它）
     * - `freeCount` 不减（幽灵建筑不占地方）
     * - 同位置第二次 `place` 返回 null（看起来"已占用"）
     *
     * 玩家看到的是"钱扣了、地是空的"，且不报错、不崩溃。
     * 坐标来自 UI 拖拽 / 网络包 / 存档反序列化时，NaN 是完全可能进来的。
     *
     * 【为什么顺手把 `x >= 0` 换成 `!(x >= 0)`】
     * 这是全库"模式 A"：否定式条件天然漏 NaN。
     * 有了 isFinite 前置后两者等价，但统一成"取反式"能让后来的人
     * 一眼看出这里是"不满足就拒绝"，不会再被 NaN 穿透。
     */
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (!(x >= 0) || !(y >= 0)) return false;
    if (!(x + w <= this.width) || !(y + h <= this.height)) return false;

    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (this._cells[(y + dy) * this.width + (x + dx)] !== undefined) return false;
      }
    }
    return true;
  }

  /**
   * 放置
   *
   * @returns 实例 id，失败返回 null
   */
  place(defId: string, x: number, y: number, rotated = false, instanceId?: string): string | null {
    if (!this.canPlace(defId, x, y, rotated)) return null;

    const def = this._defs.get(defId)!;
    const { w, h } = this._size(def, rotated);
    const id = instanceId ?? `${defId}#${++GridPlacement._counter}`;

    if (this._placed.has(id)) return null;

    const p: Placed = { defId, instanceId: id, x, y, w, h, rotated };
    this._placed.set(id, p);

    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this._writeCell((y + dy) * this.width + (x + dx), id);
      }
    }

    return id;
  }

  private static _counter = 0;

  /** 某格被谁占用 */
  at(x: number, y: number): string | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return this._cells[y * this.width + x];
  }

  /** 某格是否空着 */
  isFree(x: number, y: number): boolean {
    return this.at(x, y) === undefined;
  }

  /**
   * 拆除
   *
   * 【坑】必须按 Placed 记录的 w/h 清，
   * 不能"扫描全图找这个 id"——那样会误删别的建筑恰好同 id 的格子
   * （虽然 id 唯一，但扫描是 O(n²) 且逻辑绕）。
   */
  remove(instanceId: string): boolean {
    const p = this._placed.get(instanceId);
    if (!p) return false;

    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) {
        const idx = (p.y + dy) * this.width + (p.x + dx);
        if (this._cells[idx] === instanceId) this._eraseCell(idx, instanceId);
      }
    }

    this._placed.delete(instanceId);
    return true;
  }

  /** 移动到新位置（拖动已放置的建筑） */
  move(instanceId: string, nx: number, ny: number): boolean {
    const p = this._placed.get(instanceId);
    if (!p) return false;

    // 先清掉旧的，再试放，失败则还原
    const cells = this._cellsOf(p);
    for (const i of cells) this._eraseCell(i, instanceId);

    if (!this.canPlace(p.defId, nx, ny, p.rotated)) {
      for (const i of cells) this._writeCell(i, instanceId);
      return false;
    }

    const def = this._defs.get(p.defId)!;
    const { w, h } = this._size(def, p.rotated);
    const np: Placed = { ...p, x: nx, y: ny, w, h };
    this._placed.set(instanceId, np);

    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this._writeCell((ny + dy) * this.width + (nx + dx), instanceId);
      }
    }
    return true;
  }

  private _cellsOf(p: Placed): number[] {
    const out: number[] = [];
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) out.push((p.y + dy) * this.width + (p.x + dx));
    }
    return out;
  }

  get(instanceId: string): Placed | undefined {
    return this._placed.get(instanceId);
  }

  get placedCount(): number {
    return this._placed.size;
  }

  /** 空闲格子数（O(1)，由 `_writeCell` / `_eraseCell` 增量维护） */
  get freeCount(): number {
    return this._free;
  }

  /** 找出所有能放下的位置（UI 高亮用） */
  findSpots(defId: string, rotated = false): Array<{ x: number; y: number }> {
    const def = this._defs.get(defId);
    if (!def) return [];
    const { w, h } = this._size(def, rotated);
    const out: Array<{ x: number; y: number }> = [];

    for (let y = 0; y <= this.height - h; y++) {
      for (let x = 0; x <= this.width - w; x++) {
        if (this.canPlace(defId, x, y, rotated)) out.push({ x, y });
      }
    }
    return out;
  }

  clear(): void {
    this._cells.fill(undefined);
    this._placed.clear();
    this._free = this._cells.length;
  }

  destroy(): void {
    this.clear();
    this._defs.clear();
  }
}

// ============================================================
// 六边形坐标（axial: q, r）
// ============================================================

export interface Hex {
  readonly q: number;
  readonly r: number;
}

export function hex(q: number, r: number): Hex {
  return { q, r };
}

/** 六邻居（axial，pointy-top） */
const HEX_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
];

export function hexAdd(a: Hex, b: Hex): Hex {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function hexEquals(a: Hex, b: Hex): boolean {
  return a.q === b.q && a.r === b.r;
}

export function hexNeighbors(h: Hex): Hex[] {
  return HEX_DIRS.map(([dq, dr]) => ({ q: h.q + dq, r: h.r + dr }));
}

/**
 * 六边形距离
 *
 * cube 坐标下：distance = (|dq| + |dr| + |dq+dr|) / 2
 */
export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/**
 * 半径 n 的**环**（只有环上的格子，**不含中心**）
 *
 * 【⚠️ 曾经的注释是错的】
 * 这里原来写"半径 n 内的所有格子（含中心）"，
 * 实测 `hexRing(center, 1).length === 6`（是环），
 * 而 `hexSpiral(center, 1).length === 7`（才是含中心的实心范围）。
 * 照注释写范围伤害/建造预览会**漏掉中心格**——而中心往往正是技能落点。
 */
export function hexRing(center: Hex, radius: number): Hex[] {
  if (radius <= 0) return [{ ...center }];

  const out: Hex[] = [];
  // 从中心走 radius 步到某个起点，然后沿六个方向各走 radius 步
  let cur: Hex = hexAdd(center, { q: HEX_DIRS[4][0] * radius, r: HEX_DIRS[4][1] * radius });

  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      out.push({ ...cur });
      cur = hexAdd(cur, { q: HEX_DIRS[side][0], r: HEX_DIRS[side][1] });
    }
  }
  return out;
}

/** 半径 n 内的所有格子（实心） */
export function hexSpiral(center: Hex, radius: number): Hex[] {
  const out: Hex[] = [];
  for (let q = -radius; q <= radius; q++) {
    const rMin = Math.max(-radius, -q - radius);
    const rMax = Math.min(radius, -q + radius);
    for (let r = rMin; r <= rMax; r++) {
      out.push({ q: center.q + q, r: center.r + r });
    }
  }
  return out;
}

/**
 * axial → 像素（pointy-top）
 *
 * 【⚠️ size 为什么必须守卫】
 * `size` 是格子半径，来自配置。它是 0 / NaN 时：
 * - `hexToPixel` 所有格子都被压到 `{x: 0, y: 0}`（一堆格子重叠在原点，看不出错）
 * - `pixelToHex` 是 **除以 size** → `±Infinity` → `hexRound` 喂进 `Math.round(Infinity)`
 *   得到 `{q: Infinity, r: -Infinity}`，这个坐标会被继续传给寻路/距离计算，
 *   把 Infinity 一路传染下去（`hexDistance` 返回 Infinity，比较恒真/恒假）。
 *
 * 不抛错的原因：像素互转通常在渲染/拾取循环里逐帧调用，
 * 抛错会打断整帧渲染，而问题根源只是一份配置值。
 * 所以非法 size 统一返回原点坐标，并在注释里写明"调用方应校验配置"。
 */
export function hexToPixel(h: Hex, size: number): IVec2 {
  if (!(size > 0)) return { x: 0, y: 0 };
  const x = size * Math.sqrt(3) * (h.q + h.r / 2);
  const y = size * 1.5 * h.r;
  return { x, y };
}

/** 像素 → axial（含取整到最近格子） */
export function pixelToHex(x: number, y: number, size: number): Hex {
  // 同上：size 非法时返回原点格，而不是让 Infinity 流进后续计算
  if (!(size > 0)) return { q: 0, r: 0 };
  const r = (2 / 3) * y / size;
  const q = (Math.sqrt(3) / 3 * x - (1 / 3) * y) / size;
  return hexRound(q, r);
}

/** 浮点 axial 坐标取整到最近的格子（cube round） */
export function hexRound(qf: number, rf: number): Hex {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  let s = Math.round(sf);

  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);

  // 保留偏差最大的那个分量由另外两个推出，保证 q + r + s = 0
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;

  return { q, r };
}
