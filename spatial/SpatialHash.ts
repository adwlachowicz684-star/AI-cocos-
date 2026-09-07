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
  /**
   * 初始容量提示
   *
   * 【⚠️ 当前**未实现**：传了不会有任何效果】
   *
   * 全文检索确认 `capacity` 只在接口定义处出现，
   * 构造函数与所有方法都没有读取它（README 也从未提及）。
   *
   * 这比"没有这个配置"更糟——调用方以为传了 `capacity` 就有了容量保护，
   * 实际上 `update()` 会无上限地往里塞，内存只增不减。
   * 在**这里明确写出来**，避免有人靠这个字段做内存预算。
   *
   * 【去留待总审裁决】两种改法都会改变对外契约：
   *   A. 实现为硬上限（满了拒绝或淘汰最旧）→ 改变 `update()` 的行为；
   *   B. 从接口删除 → 传过 `capacity` 的调用方编译报错。
   * 本窗口不自行拍板，详见 `audit/result_W1-B.md`。
   */
  readonly capacity?: number;
}

interface Cell {
  readonly items: Set<string>;
}

/** 一条登记记录：对象 + 它当前的坐标 + 所在格子 key */
interface SpatialEntry<T> {
  item: T;
  x: number;
  y: number;
  key: string;
}

export class SpatialHash<T> {
  private readonly _cellSize: number;
  private readonly _inv: number;
  private readonly _cells = new Map<string, Cell>();
  private readonly _items = new Map<string, SpatialEntry<T>>();

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

    /**
     * 【⚠️ 首次 update 不传 item 时，`item` 字段会是 undefined】
     *
     * 这里的 `as T` 是**类型层面的谎言**：
     * `update('e1', 0, 0)` 不传 item，`entry.item` 运行时就是 `undefined`，
     * 但类型上仍是 `T`。之后 `get('e1')` 返回的是类型合法、值为 undefined 的结果
     * ——调用方的 `T` 方法调用会在运行时炸，而编译期毫无提示。
     *
     * 保留这个强转是因为：`update()` 的常用形态是"每帧只更新坐标"，
     * 强制要求带 item 会让所有调用方多传一个参数。
     * 【约定】首次登记请用 `insert(id, item, x, y)` 或带上 item 参数。
     */
    const entry = existing ?? ({ item: item as T } as SpatialEntry<T>);
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
    return this._queryCircleEntries(cx, cy, radius).map((e) => e.item);
  }

  /**
   * 圆形范围查询，返回**带坐标**的 entry
   *
   * 【为什么要单独留一个返回 entry 的版本】
   * `queryNearest` 拿到结果后要按距离排序，需要每个对象的坐标。
   * 若像原实现那样先拿 `T[]` 再用 `_findEntry` 反查，就是 O(k·n)。
   * 让粗筛阶段直接把 entry 传出来，排序阶段零反查。
   */
  private _queryCircleEntries(
    cx: number,
    cy: number,
    radius: number
  ): readonly SpatialEntry<T>[] {
    if (!(radius >= 0)) return [];
    const r2 = radius * radius;

    const minX = cx - radius;
    const minY = cy - radius;
    const maxX = cx + radius;
    const maxY = cy + radius;

    const out: SpatialEntry<T>[] = [];
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
          if (dx * dx + dy * dy <= r2) out.push(e);
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
    if (!Number.isFinite(k)) return [];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];

    /**
     * 【⚠️ maxRadius 默认为 Infinity 时，原实现会死循环】
     *
     * 原循环：
     * ```ts
     * while (results.length < k && radius <= Math.max(maxRadius, this._cellSize)) {
     *   results = this.queryCircle(x, y, Math.min(radius, maxRadius));
     *   if (radius >= maxRadius) break;
     *   radius *= 2;
     * }
     * ```
     * `maxRadius = Infinity` 时：
     * - 循环条件 `radius <= Infinity` **恒真**
     * - 退出条件 `radius >= Infinity` **永不满足**（有限数翻倍到不了 Infinity）
     * → `radius` 无限翻倍，每轮 `queryCircle` 扫 `(2·radius/cellSize)²` 个格子：
     *   cellSize=64 时第 10 轮就到 4.2e6 个格子，之后继续爆炸。
     *
     * 实测（修复前）：插入 1 个点、`queryNearest(0,0,5)`（附近不足 5 个）
     * → **20 秒内未返回，主线程 100% 卡死，不抛错**。
     *
     * 这不是边缘调用——"找最近的 5 个敌人"是默认参数下的常见用法，
     * 玩家站在角落或场上存活单位不足 k 个时立即触发。
     *
     * 【修法】把 Infinity 换成一个"能覆盖全部数据"的**有限**上界。
     * 计算代价 O(n) 一次，远低于原实现的指数爆炸。
     */
    const cap = Number.isFinite(maxRadius)
      ? Math.max(0, maxRadius)
      : this._maxDistFrom(x, y);

    let radius = this._cellSize;
    let entries: readonly SpatialEntry<T>[] = [];

    /**
     * 【⚠️ 循环必须保证"在上限处也查一次"】
     *
     * 第一版我写成 `while (entries.length < k && radius <= Math.max(cap, cellSize))`，
     * 半径按 2 倍增长会**越过** cap：
     * cap=25、cellSize=8 时序列是 8 → 16 → 32，
     * 而 32 <= 25 为假 → 循环在查过 16 之后就退出了，
     * **从没以 25 为半径查过**，实测少返回 1 个本该命中的点。
     *
     * 改成"先夹到 cap 再翻倍"，并在 radius 到达 cap 后查完再退出：
     * 8 → 16 → 25（查）→ 退出。既收敛又不漏。
     */
    for (;;) {
      entries = this._queryCircleEntries(x, y, Math.min(radius, cap));
      if (entries.length >= k) break;
      if (radius >= cap) break;
      radius = Math.min(radius * 2, cap);
    }

    if (entries.length <= k) return entries.map((e) => e.item);

    /**
     * 【⚠️ 这里原本用 `_findEntry(item)` 反查坐标，是 O(k·n)】
     *
     * 每个结果都要遍历整个 `_items` Map 找回自己的坐标——
     * 2000 个对象时单次查询触发 2529 次全表遍历。
     * 这与 `_core` 的 `QuadTree.queryCircle` 是同一个反模式
     * （"先取出结果再逐个反查"）。
     *
     * 改成粗筛阶段直接保留 entry（坐标已在其中），省掉整轮反查。
     */
    const withDist = entries.map((e) => {
      const dx = e.x - x;
      const dy = e.y - y;
      return { item: e.item, d2: dx * dx + dy * dy };
    });
    withDist.sort((a, b) => a.d2 - b.d2);
    return withDist.slice(0, k).map((r) => r.item);
  }

  /**
   * 从 (x,y) 出发、能覆盖全部已插入对象的最小半径
   *
   * 【为什么需要它】`maxRadius = Infinity` 时必须换成有限上界，
   * 否则"翻倍到 Infinity"永远到不了，循环不收敛。
   *
   * 代价 O(n) 一次；空表返回 0（调用方会立刻终止循环）。
   */
  private _maxDistFrom(x: number, y: number): number {
    let maxD2 = 0;
    for (const e of this._items.values()) {
      const dx = e.x - x;
      const dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > maxD2) maxD2 = d2;
    }
    return Math.sqrt(maxD2);
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
