/**
 * ds —— 游戏开发常用数据结构
 *
 * 【为什么需要这一层】
 *
 * 用 `Array` 现搓这些数据结构的后果：
 * - **优先队列**：每次取最大值都 O(n) 扫描 → A* 寻路慢 10 倍，节点一多就卡
 * - **四叉树**：每次碰撞检测都遍历全部对象 → 1000 个敌人是 50 万次判断/帧
 * - **并查集**：用数组找连通分量 → 地牢生成时"房间都连上了吗"查不出来
 *
 * 【收录四个】
 * | 结构 | 解决什么 | 典型场景 |
 * |---|---|---|
 * | `BinaryHeap` | O(log n) 取最值 | A* 开放列表、事件队列、伤害排序 |
 * | `DisjointSet` | 连通性判定 | 房间连通、迷宫生成、区域划分 |
 * | `QuadTree` | 空间查询 | 视野剔除、碰撞粗筛、范围技能 |
 * | `SpatialHash` | 均匀网格索引 | 大量同尺寸物体的邻居查询 |
 *
 * 【使用示例】
 * ```typescript
 * // 优先队列（默认最小堆）
 * const heap = new BinaryHeap<{ k: number; v: string }>((a, b) => a.k - b.k);
 * heap.push({ k: 3, v: 'c' });
 * heap.push({ k: 1, v: 'a' });
 * heap.pop();                    // { k: 1, v: 'a' }
 *
 * // 并查集
 * const uf = new DisjointSet(5);
 * uf.union(0, 1);
 * uf.union(1, 2);
 * uf.connected(0, 2);            // true
 * uf.componentCount;             // 3
 *
 * // 四叉树
 * const qt = new QuadTree({ x: 0, y: 0, w: 800, h: 600 });
 * qt.insert({ x: 10, y: 10, data: enemy });
 * qt.query({ x: 0, y: 0, w: 100, h: 100 });   // 范围内的对象
 *
 * // 空间哈希
 * const sh = new SpatialHash(64);
 * sh.insert(id, x, y);
 * sh.queryNeighbors(x, y, 1);    // 周围 3×3 格里的所有 id
 * ```
 *
 * 【无引擎依赖】
 */

// ============================================================
// BinaryHeap —— 二叉堆（优先队列）
// ============================================================

/**
 * 比较函数，同 `Array.sort` 的语义：
 * 返回负数 = a 排前面（先被 pop 出来）
 */
export type CompareFn<T> = (a: T, b: T) => number;

export class BinaryHeap<T> {
  private _data: T[] = [];
  private readonly _compare: CompareFn<T>;

  constructor(compare: CompareFn<T>, items?: readonly T[]) {
    this._compare = compare;
    if (items) {
      /**
       * 【批量建堆：O(n) 而不是 O(n log n)】
       * 从最后一个非叶子节点往下 siftDown。
       * 逐个 push 是 O(n log n)，批量是 O(n)——
       * 初始化 10000 个元素时差别很明显。
       */
      this._data = items.slice();
      for (let i = (this._data.length >> 1) - 1; i >= 0; i--) this._siftDown(i);
    }
  }

  get size(): number {
    return this._data.length;
  }

  get isEmpty(): boolean {
    return this._data.length === 0;
  }

  /** 查看堆顶（不移除） */
  peek(): T | undefined {
    return this._data[0];
  }

  /** 入堆 O(log n) */
  push(item: T): this {
    this._data.push(item);
    this._siftUp(this._data.length - 1);
    return this;
  }

  /** 出堆 O(log n) */
  pop(): T | undefined {
    if (this._data.length === 0) return undefined;

    const top = this._data[0];
    const last = this._data.pop()!;

    if (this._data.length > 0) {
      this._data[0] = last;
      this._siftDown(0);
    }

    return top;
  }

  /**
   * 移除特定元素 O(n)
   *
   * 【用途】A* 里更新已入队节点的代价后，需要重新调整位置。
   * 标准做法是 push 一个新的重复项并标记旧的为失效（更省事），
   * 但那样堆会膨胀。这里提供真正的移除。
   *
   * @returns 是否找到并移除
   */
  remove(item: T): boolean {
    const idx = this._data.indexOf(item);
    if (idx < 0) return false;
    this._removeAt(idx);
    return true;
  }

  /** 按条件移除第一个匹配的元素 */
  removeWhere(predicate: (item: T) => boolean): boolean {
    const idx = this._data.findIndex(predicate);
    if (idx < 0) return false;
    this._removeAt(idx);
    return true;
  }

  private _removeAt(idx: number): void {
    const last = this._data.pop()!;

    if (idx >= this._data.length) return; // 删的就是最后一个

    this._data[idx] = last;
    // 既可能要上浮也可能要下沉，两个都试（只有一个会真正生效）
    this._siftUp(idx);
    this._siftDown(idx);
  }

  private _siftUp(i: number): void {
    const d = this._data;
    const item = d[i];

    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._compare(item, d[parent]) >= 0) break;
      d[i] = d[parent];
      i = parent;
    }

    d[i] = item;
  }

  private _siftDown(i: number): void {
    const d = this._data;
    const n = d.length;
    const item = d[i];

    for (;;) {
      let child = (i << 1) + 1;
      if (child >= n) break;

      // 选两个孩子里更优先的那个
      const right = child + 1;
      if (right < n && this._compare(d[right], d[child]) < 0) child = right;

      if (this._compare(d[child], item) >= 0) break;

      d[i] = d[child];
      i = child;
    }

    d[i] = item;
  }

  /**
   * 堆化后按序取出全部（会**清空**堆）
   *
   * 【为什么不能保证稳定】
   * 堆排序不稳定——同优先级的元素顺序不确定。
   * 需要稳定的话，在比较函数里加一个递增的序号作 tie-breaker。
   */
  drain(): T[] {
    const out: T[] = [];
    while (this._data.length > 0) out.push(this.pop()!);
    return out;
  }

  toArray(): T[] {
    return this._data.slice();
  }

  clear(): void {
    this._data.length = 0;
  }
}

/**
 * 带失效标记的优先队列（A* 专用优化）
 *
 * 【为什么需要】
 * A* 中"发现更短路径"时要更新已入队节点的代价。
 * 标准二叉堆不支持 O(log n) 的 decrease-key，
 * 常见做法是再 push 一个重复项，用一个 `removed` 标记使旧的失效。
 *
 * 这样堆会膨胀（同一节点多次入队），但避免了 O(n) 的 remove，
 * 实测在 A* 上更快。
 */
export class LazyHeap<T> {
  private readonly _heap: BinaryHeap<{ item: T; priority: number; seq: number }>;
  private readonly _removed = new Set<number>();
  private _seq = 0;

  constructor() {
    this._heap = new BinaryHeap<{ item: T; priority: number; seq: number }>((a, b) => {
      const d = a.priority - b.priority;
      return d !== 0 ? d : a.seq - b.seq;   // seq 做 tie-breaker
    });
  }

  get size(): number {
    return this._heap.size;
  }

  get isEmpty(): boolean {
    return this._heap.isEmpty;
  }

  /** 入队，返回句柄（用于后续的 remove） */
  push(item: T, priority: number): number {
    const seq = this._seq++;
    this._heap.push({ item, priority, seq });
    return seq;
  }

  /**
   * 出队
   *
   * 【关键】跳过所有被标记删除的项。
   * 如果不跳过，会弹出已经失效的旧记录，
   * 表现为"明明找到了更短路径却返回了旧的"。
   */
  pop(): T | undefined {
    for (;;) {
      const top = this._heap.pop();
      if (top === undefined) return undefined;
      if (this._removed.has(top.seq)) {
        this._removed.delete(top.seq);
        continue;
      }
      return top.item;
    }
  }

  /** 标记删除（O(1)，比真的从堆里移除快） */
  remove(handle: number): void {
    this._removed.add(handle);
  }

  clear(): void {
    this._heap.clear();
    this._removed.clear();
  }
}

// ============================================================
// DisjointSet —— 并查集
// ============================================================

export class DisjointSet {
  private readonly _parent: number[];
  private readonly _rank: number[];
  private _components: number;

  constructor(size: number) {
    if (size < 0) throw new Error('[DisjointSet] 大小不能为负');
    this._parent = new Array<number>(size);
    this._rank = new Array<number>(size).fill(0);
    for (let i = 0; i < size; i++) this._parent[i] = i;
    this._components = size;
  }

  get size(): number {
    return this._parent.length;
  }

  /** 连通分量数（全部连通时为 1） */
  get componentCount(): number {
    return this._components;
  }

  /**
   * 找根（带路径压缩）
   *
   * 【路径压缩的作用】
   * 不压缩的话，链会很长，find 退化到 O(n)。
   * 压缩后近似 O(1)（严格说是反阿克曼函数）。
   */
  find(x: number): number {
    if (x < 0 || x >= this._parent.length) return -1;

    // 先找到根
    let root = x;
    while (this._parent[root] !== root) root = this._parent[root];

    // 再走一遍，把路径上所有节点直接挂到根下
    let cur = x;
    while (this._parent[cur] !== root) {
      const next = this._parent[cur];
      this._parent[cur] = root;
      cur = next;
    }

    return root;
  }

  /** 合并。返回是否已连通（true = 本次真的合并了） */
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra < 0 || rb < 0) return false;
    if (ra === rb) return false;   // 已连通

    // 按秩合并：矮树挂到高树下，避免树变高
    if (this._rank[ra] < this._rank[rb]) this._parent[ra] = rb;
    else if (this._rank[ra] > this._rank[rb]) this._parent[rb] = ra;
    else {
      this._parent[rb] = ra;
      this._rank[ra]++;
    }

    this._components--;
    return true;
  }

  /** 是否连通 */
  connected(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    return ra >= 0 && rb >= 0 && ra === rb;
  }

  /**
   * 所有连通分量
   *
   * 【用途】地牢生成后检查"有没有孤立的房间"。
   * 如果返回长度 > 1，说明有房间没连上。
   */
  groups(): number[][] {
    const map = new Map<number, number[]>();
    for (let i = 0; i < this._parent.length; i++) {
      const root = this.find(i);
      const arr = map.get(root);
      if (arr) arr.push(i);
      else map.set(root, [i]);
    }
    return Array.from(map.values());
  }

  /** 某个连通分量的大小 */
  componentSize(x: number): number {
    const root = this.find(x);
    if (root < 0) return 0;
    let n = 0;
    for (let i = 0; i < this._parent.length; i++) {
      if (this.find(i) === root) n++;
    }
    return n;
  }

  /** 重置为初始状态 */
  reset(): void {
    for (let i = 0; i < this._parent.length; i++) {
      this._parent[i] = i;
      this._rank[i] = 0;
    }
    this._components = this._parent.length;
  }
}

// ============================================================
// QuadTree —— 四叉树
// ============================================================

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

export interface QuadItem<T> {
  readonly x: number;
  readonly y: number;
  readonly data: T;
}

/**
 * 矩形重叠判定
 *
 * @param padding 给 a 四周各扩一圈再判定。
 *                用途：房间之间要留间隔时，用 padding = 间隔距离。
 *
 * 【坑】padding 必须**同时**加在 a 的两侧。
 * 只写 `a.x - padding < b.x + b.w` 而忘了右边，
 * 判定就不对称——表现为"房间左边不重叠但右边重叠"，极难排查。
 */
export function rectsOverlap(a: Rect, b: Rect, padding = 0): boolean {
  return (
    a.x - padding < b.x + b.w &&
    a.x + a.w + padding > b.x &&
    a.y - padding < b.y + b.h &&
    a.y + a.h + padding > b.y
  );
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

interface QNode<T> {
  readonly bounds: Rect;
  items: Array<QuadItem<T>> | null;
  children: Array<QNode<T>> | null;
  depth: number;
}

export class QuadTree<T> {
  private readonly _root: QNode<T>;
  private readonly _maxItems: number;
  private readonly _maxDepth: number;
  private _count = 0;

  constructor(bounds: Rect, maxItems = 8, maxDepth = 8) {
    if (maxItems < 1) throw new Error('[QuadTree] maxItems 必须 ≥ 1');
    if (maxDepth < 1) throw new Error('[QuadTree] maxDepth 必须 ≥ 1');
    this._maxItems = maxItems;
    this._maxDepth = maxDepth;
    this._root = { bounds, items: [], children: null, depth: 0 };
  }

  get count(): number {
    return this._count;
  }

  /** 插入 */
  insert(x: number, y: number, data: T): boolean {
    if (!pointInRect(x, y, this._root.bounds)) return false;
    this._insert(this._root, { x, y, data });
    return true;
  }

  private _insert(node: QNode<T>, item: QuadItem<T>): void {
    // 计数只在这里加一次，_split 的重新分配不再计数
    this._count++;
    this._place(node, item);
  }

  private _split(node: QNode<T>): void {
    const { x, y, w, h } = node.bounds;
    const hw = w / 2;
    const hh = h / 2;

    node.children = [
      { bounds: { x: x + hw, y, w: hw, h: hh }, items: [], children: null, depth: node.depth + 1 }, // 右上
      { bounds: { x, y, w: hw, h: hh }, items: [], children: null, depth: node.depth + 1 },         // 左上
      { bounds: { x, y: y + hh, w: hw, h: hh }, items: [], children: null, depth: node.depth + 1 }, // 左下
      { bounds: { x: x + hw, y: y + hh, w: hw, h: hh }, items: [], children: null, depth: node.depth + 1 }, // 右下
    ];

    const items = node.items!;
    node.items = [];

    /**
     * 【坑】这里**不能**调用 _insert——那会再次 ++_count，
     * 导致同一个对象被计两次。
     *
     * 现象很隐蔽：insert 50 个对象，count 却是 95。
     * 不会抛异常，只是数字不对——
     * 而 count 常被用来做"还能加几个"的判断，于是行为变得随机。
     *
     * 分裂只是**重新分配**已有的项，总数不变，所以直接放，不计数。
     */
    for (const item of items) {
      const idx = this._quadrantOf(node, item.x, item.y);
      if (idx >= 0) this._place(node.children[idx], item);
      else node.items.push(item);
    }
  }

  /** 放置到子树（不增加计数），供 _insert 和 _split 共用 */
  private _place(node: QNode<T>, item: QuadItem<T>): void {
    if (node.children !== null) {
      const idx = this._quadrantOf(node, item.x, item.y);
      if (idx >= 0) {
        this._place(node.children[idx], item);
        return;
      }
      node.items!.push(item);
      return;
    }

    node.items!.push(item);
    if (node.items!.length > this._maxItems && node.depth < this._maxDepth) {
      this._split(node);
    }
  }

  private _quadrantOf(node: QNode<T>, px: number, py: number): number {
    const { x, y, w, h } = node.bounds;
    const midX = x + w / 2;
    const midY = y + h / 2;

    if (px === midX || py === midY) return -1;   // 在分割线上

    if (px >= midX) return py < midY ? 0 : 3;    // 右上 / 右下
    return py < midY ? 1 : 2;                     // 左上 / 左下
  }

  /** 矩形范围查询 */
  query(range: Rect): T[] {
    const out: T[] = [];
    this._query(this._root, range, out);
    return out;
  }

  private _query(node: QNode<T>, range: Rect, out: T[]): void {
    if (!rectsOverlap(node.bounds, range)) return;

    if (node.items) {
      for (const item of node.items) {
        if (pointInRect(item.x, item.y, range)) out.push(item.data);
      }
    }

    if (node.children) {
      for (const c of node.children) this._query(c, range, out);
    }
  }

  /** 圆形范围查询（半径） */
  queryCircle(cx: number, cy: number, radius: number): T[] {
    const r2 = radius * radius;
    const candidates = this.query({ x: cx - radius, y: cy - radius, w: radius * 2, h: radius * 2 });
    return candidates.filter((d) => {
      const it = this._findItem(this._root, d);
      if (!it) return false;
      const dx = it.x - cx;
      const dy = it.y - cy;
      return dx * dx + dy * dy <= r2;
    });
  }

  private _findItem(node: QNode<T>, data: T): QuadItem<T> | null {
    if (node.items) {
      for (const it of node.items) if (it.data === data) return it;
    }
    if (node.children) {
      for (const c of node.children) {
        const found = this._findItem(c, data);
        if (found) return found;
      }
    }
    return null;
  }

  /** 移除（按引用匹配） */
  remove(data: T): boolean {
    return this._remove(this._root, data);
  }

  private _remove(node: QNode<T>, data: T): boolean {
    if (node.items) {
      const idx = node.items.findIndex((it) => it.data === data);
      if (idx >= 0) {
        node.items.splice(idx, 1);
        this._count--;
        return true;
      }
    }
    if (node.children) {
      for (const c of node.children) {
        if (this._remove(c, data)) return true;
      }
    }
    return false;
  }

  clear(): void {
    this._root.items = [];
    this._root.children = null;
    this._count = 0;
  }
}

// ============================================================
// SpatialHash —— 空间哈希（均匀网格）
// ============================================================

export class SpatialHash {
  private readonly _cells = new Map<number, Set<number>>();
  private readonly _cellSize: number;
  /** 每个 id 当前所在的格子（用于快速更新） */
  private readonly _idToCell = new Map<number, number>();

  constructor(cellSize: number) {
    if (cellSize <= 0) throw new Error('[SpatialHash] 格子尺寸必须为正');
    this._cellSize = cellSize;
  }

  get cellSize(): number {
    return this._cellSize;
  }

  get count(): number {
    return this._idToCell.size;
  }

  private _key(cx: number, cy: number): number {
    /**
     * 格子坐标 → 单个数字
     *
     * 【坑】直接用 `cx * 100000 + cy` 会在负数和大数时冲突。
     * 用 Cantor 配对函数能保证一一对应（支持负数）。
     */
    return this._pair(cx, cy);
  }

  private _pair(a: number, b: number): number {
    // 先把整数映射到非负（zigzag）
    const na = a >= 0 ? 2 * a : -2 * a - 1;
    const nb = b >= 0 ? 2 * b : -2 * b - 1;
    // Cantor 配对
    return ((na + nb) * (na + nb + 1)) / 2 + nb;
  }

  private _cellOf(x: number, y: number): { cx: number; cy: number } {
    return { cx: Math.floor(x / this._cellSize), cy: Math.floor(y / this._cellSize) };
  }

  insert(id: number, x: number, y: number): boolean {
    const { cx, cy } = this._cellOf(x, y);
    const key = this._key(cx, cy);

    // 如果已经在表里，先移除旧的
    if (this._idToCell.has(id)) {
      const oldKey = this._idToCell.get(id)!;
      if (oldKey === key) return false;   // 位置没变
      this._cells.get(oldKey)?.delete(id);
    }

    let bucket = this._cells.get(key);
    if (!bucket) {
      bucket = new Set<number>();
      this._cells.set(key, bucket);
    }
    bucket.add(id);
    this._idToCell.set(id, key);
    return true;
  }

  /** 移动（每帧调用，内部会判断格子是否变化） */
  update(id: number, x: number, y: number): void {
    this.insert(id, x, y);
  }

  remove(id: number): boolean {
    const key = this._idToCell.get(id);
    if (key === undefined) return false;
    this._cells.get(key)?.delete(id);
    this._idToCell.delete(id);
    return true;
  }

  /** 查询周围 radius 格内的所有 id（含自己所在格） */
  queryNeighbors(x: number, y: number, radius = 1): number[] {
    const { cx, cy } = this._cellOf(x, y);
    const out: number[] = [];

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const bucket = this._cells.get(this._key(cx + dx, cy + dy));
        if (bucket) for (const id of bucket) out.push(id);
      }
    }

    return out;
  }

  /** 查询一个像素矩形范围内的 id */
  queryRect(minX: number, minY: number, maxX: number, maxY: number): number[] {
    const a = this._cellOf(minX, minY);
    const b = this._cellOf(maxX, maxY);
    const out = new Set<number>();

    for (let cy = a.cy; cy <= b.cy; cy++) {
      for (let cx = a.cx; cx <= b.cx; cx++) {
        const bucket = this._cells.get(this._key(cx, cy));
        if (bucket) for (const id of bucket) out.add(id);
      }
    }

    return Array.from(out);
  }

  /** 同格的所有 id */
  queryCell(x: number, y: number): number[] {
    const { cx, cy } = this._cellOf(x, y);
    const bucket = this._cells.get(this._key(cx, cy));
    return bucket ? Array.from(bucket) : [];
  }

  clear(): void {
    this._cells.clear();
    this._idToCell.clear();
  }
}
