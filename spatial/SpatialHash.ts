/**
 * SpatialHash —— 空间哈希（均匀网格分区）
 *
 * 【它解决什么】
 *
 * "找出半径 5 米内的所有敌人"——朴素做法是遍历所有敌人 O(n)。
 * 同屏 200 个敌人 × 每个敌人每帧都做一次范围查询 = 40000 次距离计算，
 * 在移动端是实打实的掉帧。
 *
 * 空间哈希把空间切成格子，只检查目标格子及其邻居：O(邻域内元素数)。
 *
 * 【什么时候用，什么时候不用】
 * - ✅ 元素数量 > 100 且查询频繁（子弹碰撞、范围技能、AOE 选取）
 * - ✅ 元素分布比较均匀
 * - ❌ 元素 < 50 → 直接遍历更快（哈希有常数开销）
 * - ❌ 元素集中在极少数格子 → 退化成 O(n)，考虑四叉树
 *
 * 【格子大小怎么选】
 * **约等于典型查询半径**。
 * - 太小：一次查询要检查很多格子
 * - 太大：每个格子里元素太多，过滤成本高
 * 经验值：查询半径的 1~2 倍。
 *
 * 【使用示例】
 * ```typescript
 * const hash = new SpatialHash<Enemy>({ cellSize: 5 });
 *
 * // 每帧更新位置（移动后必须更新，否则查询结果是错的）
 * for (const e of enemies) {
 *   e.update(dt);
 *   hash.update(e.id, e.x, e.y);
 * }
 *
 * // 范围查询：爆炸伤害
 * const hits = hash.queryCircle(px, py, 8);
 * for (const e of hits) e.takeDamage(50);
 *
 * // 矩形查询：屏幕剔除
 * const visible = hash.queryRect(camLeft, camBottom, camRight, camTop);
 * ```
 *
 * 【无引擎依赖】
 */

export interface SpatialHashOptions {
  /** 格子边长（世界单位） */
  readonly cellSize: number;
  /** 初始容量提示 */
  readonly capacity?: number;
}

interface Cell {
  readonly items: Set<string>;
}

export class SpatialHash<T> {
  private readonly _cellSize: number;
  private readonly _inv: number;
  private readonly _cells = new Map<string, Cell>();
  private readonly _items = new Map<string, { item: T; x: number; y: number; key: string }>();

  constructor(opts: SpatialHashOptions) {
    if (!(opts.cellSize > 0)) throw new Error('[SpatialHash] cellSize 必须为正');
    this._cellSize = opts.cellSize;
    this._inv = 1 / opts.cellSize;
  }

  get itemCount(): number {
    return this._items.size;
  }

  get cellCount(): number {
    return this._cells.size;
  }

  /**
   * 插入或更新元素
   *
   * 【坑】元素移动后**必须**调用 update。
   * 忘了更新的话，查询会基于旧位置返回错误结果——
   * 表现为"明明站在爆炸范围里却没受伤"，极难定位。
   */
  update(id: string, x: number, y: number, item?: T): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`[SpatialHash] 坐标必须是有限数：(${x}, ${y})`);
    }

    const key = this._keyOf(x, y);
    const existing = this._items.get(id);

    if (existing) {
      if (existing.key === key) {
        existing.x = x;
        existing.y = y;
        if (item !== undefined) existing.item = item;
        return;
      }
      this._removeFromCell(existing.key, id);
    }

    const entry = existing ?? ({ item: item as T } as { item: T; x: number; y: number; key: string });
    entry.x = x;
    entry.y = y;
    entry.key = key;
    if (item !== undefined) entry.item = item;

    this._items.set(id, entry);
    this._addToCell(key, id);
  }

  /** 插入（如果已存在则更新） */
  insert(id: string, item: T, x: number, y: number): void {
    this.update(id, x, y, item);
  }

  remove(id: string): boolean {
    const e = this._items.get(id);
    if (!e) return false;
    this._removeFromCell(e.key, id);
    this._items.delete(id);
    return true;
  }

  clear(): void {
    this._cells.clear();
    this._items.clear();
  }

  get(id: string): T | undefined {
    return this._items.get(id)?.item;
  }

  /**
   * 圆形范围查询
   *
   * 【实现】先按格子粗筛（矩形），再精确过滤（距离）。
   * 粗筛能排除掉绝大多数，精确过滤只在少量候选上做。
   */
  queryCircle(cx: number, cy: number, radius: number): T[] {
    if (!(radius >= 0)) return [];
    const r2 = radius * radius;

    const minX = cx - radius;
    const minY = cy - radius;
    const maxX = cx + radius;
    const maxY = cy + radius;

    const out: T[] = [];
    const seen = new Set<string>();

    const x0 = Math.floor(minX * this._inv);
    const y0 = Math.floor(minY * this._inv);
    const x1 = Math.floor(maxX * this._inv);
    const y1 = Math.floor(maxY * this._inv);

    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cell = this._cells.get(`${gx},${gy}`);
        if (!cell) continue;
        for (const id of cell.items) {
          if (seen.has(id)) continue;
          seen.add(id);
          const e = this._items.get(id);
          if (!e) continue;
          const dx = e.x - cx;
          const dy = e.y - cy;
          if (dx * dx + dy * dy <= r2) out.push(e.item);
        }
      }
    }
    return out;
  }

  /** 矩形范围查询（轴对齐） */
  queryRect(minX: number, minY: number, maxX: number, maxY: number): T[] {
    const out: T[] = [];
    const seen = new Set<string>();

    const x0 = Math.floor(minX * this._inv);
    const y0 = Math.floor(minY * this._inv);
    const x1 = Math.floor(maxX * this._inv);
    const y1 = Math.floor(maxY * this._inv);

    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cell = this._cells.get(`${gx},${gy}`);
        if (!cell) continue;
        for (const id of cell.items) {
          if (seen.has(id)) continue;
          seen.add(id);
          const e = this._items.get(id);
          if (!e) continue;
          if (e.x >= minX && e.x <= maxX && e.y >= minY && e.y <= maxY) out.push(e.item);
        }
      }
    }
    return out;
  }

  /** 查询最近的 K 个 */
  queryNearest(x: number, y: number, k: number, maxRadius = Infinity): T[] {
    if (k <= 0) return [];

    let radius = this._cellSize;
    let results: T[] = [];

    // 逐步扩大半径，直到找到 K 个或超过上限
    while (results.length < k && radius <= Math.max(maxRadius, this._cellSize)) {
      results = this.queryCircle(x, y, Math.min(radius, maxRadius));
      if (radius >= maxRadius) break;
      radius *= 2;
    }

    if (results.length <= k) return results;

    // 按距离排序取前 K 个
    const withDist = results.map((item) => {
      const e = this._findEntry(item);
      const dx = (e?.x ?? 0) - x;
      const dy = (e?.y ?? 0) - y;
      return { item, d2: dx * dx + dy * dy };
    });
    withDist.sort((a, b) => a.d2 - b.d2);
    return withDist.slice(0, k).map((r) => r.item);
  }

  private _findEntry(item: T): { x: number; y: number } | undefined {
    for (const e of this._items.values()) {
      if (e.item === item) return e;
    }
    return undefined;
  }

  // ==================== 内部 ====================

  private _keyOf(x: number, y: number): string {
    return `${Math.floor(x * this._inv)},${Math.floor(y * this._inv)}`;
  }

  private _addToCell(key: string, id: string): void {
    let cell = this._cells.get(key);
    if (!cell) {
      cell = { items: new Set<string>() };
      this._cells.set(key, cell);
    }
    cell.items.add(id);
  }

  private _removeFromCell(key: string, id: string): void {
    const cell = this._cells.get(key);
    if (!cell) return;
    cell.items.delete(id);
    // 空格子立即删除，避免 Map 无限增长（开放世界会积累几万个空格子）
    if (cell.items.size === 0) this._cells.delete(key);
  }

  destroy(): void {
    this.clear();
  }
}
