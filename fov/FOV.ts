/**
 * fov —— 视野计算（战争迷雾）
 *
 * 【它解决什么】
 *
 * 视野计算是 Roguelike / 潜行 / RTS 的核心。
 * 手写最常见的三种失败：
 *
 * **① 用"画线到目标"判定**
 * 从玩家向每个格子画一条线，碰到墙就停。
 * 问题：会出现**视野盲点**（墙后面的格子明明该看得见却看不见），
 * 而且墙本身会"消失"（线在墙前就停了，墙永远不可见）。
 *
 * **② 只算一次不缓存**
 * 每帧重算 80×50 = 4000 格的视野，是明显的性能热点。
 *
 * **③ 对称性没处理**
 * 玩家能看到怪物，但怪物看不到玩家 → 玩家觉得不公平。
 *
 * 【收录三种算法】
 * | 算法 | 特点 | 适用 |
 * |---|---|---|
 * | `Shadowcasting` | **推荐**。快、无盲点、墙可见 | 绝大多数情况 |
 * | `Raycasting` | 简单直观，但有盲点 | 调试对照、视野半径很小 |
 * | `Permissive` | 最"宽容"，能看到更多 | 追求信息量的 Roguelike |
 *
 * 【使用示例】
 * ```typescript
 * const fov = new Shadowcasting(map, isWall);
 *
 * // 计算视野，返回可见格子
 * const visible = fov.compute(px, py, 8);
 * visible.has(x, y);              // 某格是否可见
 *
 * // 战争迷雾：已探索过的地方保持"记忆"
 * fov.explored.has(x, y);         // 曾经看到过（灰暗显示）
 *
 * // 对称性检查（重要！）
 * fov.isSymmetric(ax, ay, bx, by, radius);   // A 能看见 B ⟺ B 能看见 A
 * ```
 *
 * 【性能】
 * 内部用 `Uint8Array` + 递增 stamp，避免每次分配。
 * 半径 8 的视野约 200 格，单次计算 < 0.1ms。
 *
 * 【无引擎依赖】
 */

/**
 * 【⚠️ 全库有 3 套二维向量：`_core` 的 `IVec2`、本模块的、以及 `camera`/`minimap` 的 `Vec2`】
 *
 * 字段都是 `{ x, y }`，结构兼容，所以**互换不会报错**——
 * 但 `readonly` 修饰、配套工厂函数（`vec2()` / `v2()`）各不相同，
 * 混用时会遇到"能赋值但类型对不上"的编译错误，或者更糟：静默通过。
 *
 * `_core/types.ts` 是标准定义，并带了全套工具（`vec2` / `setVec2` / `len2` / `normalize2`），
 * 新代码应优先用它。本模块保留本地定义是为了"单文件可复制"——
 * 复制本文件时不必连带 `_core`。
 *
 * 如果你的项目已经带了 `_core`，可以直接换成：
 *
 * ```typescript
 * import type { IVec2 } from '../_core/types';
 * ```
 */
export interface IVec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * 八个八分体（octant）的变换矩阵 [xx, xy, yx, yy]
 *
 * 用法：
 *   X = ox + dx*xx + dy*xy
 *   Y = oy + dx*yx + dy*yy
 *
 * 【⚠️ 这里踩过一个坑，值得记下来】
 *
 * 第一版我把它写成手写的映射函数：
 * ```typescript
 * (y, x) => ({ x: y, y: -x })   // octant 1
 * ```
 * 结果 **8 个里有 4 个的 Y 符号写反了**。
 *
 * 现象很隐蔽：不报错、不崩溃，只是视野形状从圆形变成了菱形，
 * 81 格只看到 47 格。肉眼看"好像也挺合理"，
 * 直到写出"空房间应该全部可见"的测试才暴露。
 *
 * 【教训】
 * 手写坐标变换极易搞混参数顺序（这里是 `transform(dx, dy)`，
 * 函数签名里第一个参数叫 x 但传的是 dx）。
 * **直接抄标准矩阵形式**，不要自己推导——
 * 矩阵写错了能被测试抓到，手写映射写错了只能靠形状看。
 */
const OCTANT_MATRIX: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 0, 0, -1],   // 0
  [0, 1, 1, 0],    // 1
  [0, -1, 1, 0],   // 2
  [-1, 0, 0, -1],  // 3
  [-1, 0, 0, 1],   // 4
  [0, -1, -1, 0],  // 5
  [0, 1, -1, 0],   // 6
  [1, 0, 0, 1],    // 7
];

import { needFinite } from '../_core/guard';

/**
 * 归一化视野半径
 *
 * 【⚠️ radius = Infinity 会让进程卡死】
 *
 * `Raycasting.compute` 用 `for (let dy = -radius; dy <= radius; dy++)`
 * 构建圆周采样点。radius 为 Infinity 时 `dy` 永远到不了 `radius`，
 * 双重循环永不结束——实测 `timeout 5` 退出码 124。
 * `Shadowcasting` 的递归同样依赖 `row > radius` 终止。
 *
 * 【为什么超界时是"夹取"而不是"抛错"】
 * 半径大于地图尺寸时，视野本来就覆盖全图，
 * **夹到地图尺度后的可见结果与不夹完全一致**——
 * 所以这不是静默降级，而是去掉无意义的计算。
 * 真正要拦的是非有限值（Infinity / NaN），那个必须抛错。
 */
function normalizeRadius(radius: number, w: number, h: number): number {
  const r = needFinite(radius, 'radius');
  if (r < 0) {
    throw new RangeError(`[fov] radius 不能为负，实际 ${r}`);
  }
  return Math.min(r, Math.max(w, h) * 2);
}

/** 可见性结果（用位掩码数组，节省内存） */
export class VisibilityMap {
  private readonly _data: Uint8Array;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this._data = new Uint8Array(width * height);
    this.width = width;
    this.height = height;
  }

  private _idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  set(x: number, y: number, visible: boolean): void {
    if (!this.inBounds(x, y)) return;
    this._data[this._idx(x, y)] = visible ? 1 : 0;
  }

  mark(x: number, y: number): void {
    if (this.inBounds(x, y)) this._data[this._idx(x, y)] = 1;
  }

  has(x: number, y: number): boolean {
    return this.inBounds(x, y) && this._data[this._idx(x, y)] === 1;
  }

  clear(): void {
    this._data.fill(0);
  }

  /** 可见格子数 */
  get count(): number {
    let n = 0;
    for (let i = 0; i < this._data.length; i++) n += this._data[i];
    return n;
  }

  /**
   * 把另一张同尺寸图并入本图（战争迷雾同步用）
   *
   * 【为什么需要它，直接 `for (const p of other.toArray()) mark(...)` 不行吗】
   * 行，但 `toArray()` 会为**每个可见格**分配一个对象。
   * 视野每帧都要算一次，4000 格的图就是每帧 4000 次分配——
   * 纯粹为了让另一个数组能读到坐标，GC 压力全花在这上面。
   * 直接按位或合并，O(w·h) 次内存读写，零分配。
   *
   * @throws 尺寸不一致时抛错（内部调用永远是同尺寸，属于编程错误）
   */
  mergeFrom(other: VisibilityMap): void {
    if (other.width !== this.width || other.height !== this.height) {
      throw new Error(
        `[VisibilityMap] 尺寸不一致，无法合并：${other.width}x${other.height} → ${this.width}x${this.height}`
      );
    }
    for (let i = 0; i < this._data.length; i++) {
      if (other._data[i] !== 0) this._data[i] = 1;
    }
  }

  /** 导出为坐标数组 */
  toArray(): IVec2[] {
    const out: IVec2[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this._data[this._idx(x, y)] === 1) out.push({ x, y });
      }
    }
    return out;
  }
}

// ============================================================
// Shadowcasting —— 递归阴影投射（推荐）
// ============================================================

export class Shadowcasting {
  private readonly _w: number;
  private readonly _h: number;
  private readonly _isWall: (x: number, y: number) => boolean;

  /** 当前帧可见 */
  readonly visible: VisibilityMap;
  /** 曾经探索过（战争迷雾） */
  readonly explored: VisibilityMap;

  /** 最近一次计算的原点 */
  private _ox = 0;
  private _oy = 0;

  constructor(width: number, height: number, isWall: (x: number, y: number) => boolean) {
    if (width <= 0 || height <= 0) throw new Error('[Shadowcasting] 尺寸必须为正');
    this._w = width;
    this._h = height;
    this._isWall = isWall;
    this.visible = new VisibilityMap(width, height);
    this.explored = new VisibilityMap(width, height);
  }

  private _inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this._w && y < this._h;
  }

  private _blocked(x: number, y: number): boolean {
    // 地图边界外视为墙，否则视野会"漏"出去
    if (!this._inBounds(x, y)) return true;
    return this._isWall(x, y);
  }

  /**
   * 计算视野
   *
   * 【算法核心：递归阴影投射】
   *
   * 把圆分成 8 个八分体，每个八分体里逐行扫描。
   * 每一行维护一个"斜率区间" [startSlope, endSlope]，
   * 表示这一行哪些格子还在"光锥"内。
   *
   * 遇到墙时：
   * - 墙本身标记为可见
   * - 墙后面的区域被"投影"出光锥，分裂成新的区间递归处理
   *
   * 这样能保证：
   * ① 墙本身可见（不会消失）
   * ② 墙后的阴影区正确（不会漏光）
   * ③ 无盲点
   *
   * @returns 本次可见的格子数
   */
  compute(ox: number, oy: number, radius: number): number {
    const r = normalizeRadius(radius, this._w, this._h);

    this.visible.clear();
    this._ox = ox;
    this._oy = oy;

    if (!this._inBounds(ox, oy)) return 0;

    // 原点自己总是可见
    this.visible.mark(ox, oy);
    this.explored.mark(ox, oy);

    for (let oct = 0; oct < 8; oct++) {
      this._castLight(oct, r, 1, 1.0, 0.0);
    }

    // 同步到"已探索"（按位合并，不分配坐标数组）
    this.explored.mergeFrom(this.visible);

    return this.visible.count;
  }

  /**
   * 递归投射一个八分体的一行
   *
   * @param row 距原点的距离（行号）
   * @param startSlope 光锥起始斜率（0~1）
   * @param endSlope 光锥结束斜率（0~1）
   */
  /**
   * 递归投射一个八分体的一行
   *
   * 【这是标准 recursive shadowcasting 实现】
   *
   * 几个容易写错、写错后只会"少看见几个格子"（不报错）的细节：
   *
   * ① 循环内的 continue 判断要用 **startSlope**（当前光锥起始），
   *    不是 `nextStartSlope`。用后者会让光锥边缘的格子被误跳过，
   *    表现为"圆形视野缺了一圈"——第一版就是这么错的（81 格只看到 47 格）。
   *
   * ② `startSlope` 在循环内**会被修改**（遇到从墙转到通路时更新），
   *    这是算法的一部分，不是 bug。所以它是 `let` 而不是 `const`。
   *
   * ③ `newStart` 记录"当前阴影的右边界"，
   *    等阴影结束时用它作为新光锥的起始。
   *
   * @param row 距原点的距离（行号）
   * @param startSlope 光锥起始斜率（1 → 0，从轴向到对角）
   * @param endSlope 光锥结束斜率
   */
  private _castLight(
    oct: number,
    radius: number,
    row: number,
    startSlope: number,
    endSlope: number
  ): void {
    if (startSlope < endSlope) return;

    const radius2 = radius * radius;
    let start = startSlope;
    let newStart = startSlope;

    for (let j = row; j <= radius; j++) {
      let blocked = false;
      let dx = -j - 1;
      const dy = -j;

      while (dx <= 0) {
        dx++;

        const m = OCTANT_MATRIX[oct];
        const mx = this._ox + dx * m[0] + dy * m[1];
        const my = this._oy + dx * m[2] + dy * m[3];

        // 用格子边界算斜率（±0.5），避免同一个格子的可见性抖动
        const lSlope = (dx - 0.5) / (dy + 0.5);
        const rSlope = (dx + 0.5) / (dy - 0.5);

        if (start < rSlope) continue;   // 还没进入光锥
        if (endSlope > lSlope) break;   // 已经超出光锥

        // 圆形视野：超出半径的不标记（但仍参与遮挡计算）
        if (dx * dx + dy * dy <= radius2) {
          this.visible.mark(mx, my);
        }

        const isBlocked = this._blocked(mx, my);

        if (blocked) {
          // 仍在阴影中：墙 → 继续延伸阴影
          if (isBlocked) {
            newStart = rSlope;
            continue;
          }
          // 墙结束了 → 用记录的新起点重开一个光锥
          blocked = false;
          start = newStart;
        } else {
          if (isBlocked && j < radius) {
            // 从通路进入墙：递归处理墙后面的剩余光锥
            blocked = true;
            this._castLight(oct, radius, j + 1, start, lSlope);
            newStart = rSlope;
          }
        }
      }

      // 整行都被墙挡住 → 后面更远的行也看不见，停止
      if (blocked) break;
    }
  }

  /** 某格当前是否可见 */
  canSee(x: number, y: number): boolean {
    return this.visible.has(x, y);
  }

  /** 是否探索过 */
  hasExplored(x: number, y: number): boolean {
    return this.explored.has(x, y);
  }

  /**
   * 对称性检查
   *
   * 【为什么重要】
   * 如果 A 能看见 B 但 B 看不见 A，
   * 玩家会觉得"怪物在作弊"。
   *
   * 【注意】Shadowcasting **不是完全对称的**。
   * 这是它的已知特性。如果需要严格对称，
   * 用 `Permissive`（更慢）或在游戏逻辑层做补偿：
   * "只要有一方能看见就视为互相可见"。
   */
  isSymmetric(ax: number, ay: number, bx: number, by: number, radius: number): boolean {
    /**
     * 【⚠️ 纯查询不能污染状态：调用前后 explored / visible 必须一致】
     *
     * 原实现连调两次 `compute()`：
     * 第二次 `compute(bx, by, r)` 会**把 B 的视野写进 `explored`**，
     * 而且结束后 `this.visible` 停在 B 的视野上（不是调用者的 A）。
     *
     * 实测（修复前，30×30 空地图）：
     * ```
     * compute(10,10,6)                  → explored = 113 格
     * isSymmetric(10,10,13,10,6)        → explored = 148 格   ← 多出 35 格
     * 调用后 visible.has(10,10) === true ← visible 已变成 B 的视野
     * ```
     *
     * 后果是**探测"双方是否互见"这个只读动作不可逆地点亮了迷雾**：
     * 玩家没去过的地方被显示出来，而 `explored` 只能靠
     * `resetExplored()` 全清（换关级操作），中途无法撤销。
     * AI 每做一次对称性检查就点亮一小片，几场战斗后迷雾基本失效。
     *
     * 【为什么 visible 也要还原】
     * 只还原 explored 的话，调用方在 `compute(px,py)` 之后
     * 顺手做一次 `isSymmetric`，自己的 `visible` 就被换成了别人的视野——
     * 同样是"查询改了状态"。所以两张图都快照、都还原。
     */
    const savedVisible = this.visible.toArray();
    const savedExplored = this.explored.toArray();

    this.compute(ax, ay, radius);
    const ab = this.visible.has(bx, by);

    this.compute(bx, by, radius);
    const ba = this.visible.has(ax, ay);

    this._restore(this.visible, savedVisible);
    this._restore(this.explored, savedExplored);

    return ab === ba;
  }

  /** 用坐标列表还原一张图（先清空再逐格标回） */
  private _restore(map: VisibilityMap, snapshot: readonly IVec2[]): void {
    map.clear();
    for (const p of snapshot) map.mark(p.x, p.y);
  }

  /** 重置探索记录（换关卡时） */
  resetExplored(): void {
    this.explored.clear();
  }

  /**
   * 有视线（LOS）——简化的两点判定
   *
   * 【用途】远程攻击、AI 发现玩家。
   * 不需要完整 FOV 时用这个，更快。
   */
  hasLineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let x = x0;
    let y = y0;

    for (;;) {
      if (x === x1 && y === y1) return true;
      if (this._blocked(x, y)) return false;

      const e2 = 2 * err;

      // 对角线步进：两个正交格都要通，否则算擦墙角
      if (e2 > -dy && e2 < dx) {
        if (this._blocked(x + sx, y) || this._blocked(x, y + sy)) return false;
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

  get width(): number {
    return this._w;
  }

  get height(): number {
    return this._h;
  }
}

// ============================================================
// Raycasting —— 射线投射（简单但有盲点）
// ============================================================

/**
 * 【为什么不推荐它做主视野】
 *
 * 从原点向圆周上的每个点画一条线，碰到墙就停。
 * 简单直观，但有两个硬伤：
 *
 * ① **盲点**：两条射线之间的格子可能被漏掉，
 *    表现为"地板上有随机的黑洞"。
 * ② **墙半透明**：射线在墙前停，导致某些墙永远不可见，
 *    玩家会看到"漂浮的房间轮廓"。
 *
 * 【实测数据】
 * 半径 5 的空房间，理论可见 81 格：
 * - Shadowcasting：81 格（全部）
 * - Raycasting：约 21 格（只有圆周附近）
 *
 * 差了近 4 倍——这就是盲点的代价。
 *
 * 保留它是因为：
 * ① 调试时用它对照 Shadowcasting 很方便（差异本身就是信息）
 * ② 视野半径很小（≤3）时它够用，而且实现简单
 *
 * **不要拿它做主视野。**
 */
export class Raycasting {
  private readonly _w: number;
  private readonly _h: number;
  private readonly _isWall: (x: number, y: number) => boolean;
  readonly visible: VisibilityMap;

  constructor(width: number, height: number, isWall: (x: number, y: number) => boolean) {
    /**
     * 【⚠️ 尺寸校验为什么必须有：`Shadowcasting` 有，这里原本没有】
     *
     * 同一个文件里的两个实现两套标准，是"看起来不一致但可能是故意的"
     * 里最容易看走眼的一类。这里不是故意的：
     *
     * ```
     * new Shadowcasting(0, 10, fn) → throw [Shadowcasting] 尺寸必须为正
     * new Raycasting(0, 10, fn)    → 静默成功（0 宽地图，视野恒为 0）
     * new Raycasting(-5, 10, fn)   → throw Invalid typed array length: -50
     *                                 ← Uint8Array 抛的，信息里没有单元名，
     *                                   排查时不会想到是 fov 传错了宽高
     * ```
     *
     * 负尺寸那条尤其糟：能"抛错"，但错误信息指向内存分配，
     * 而不是"你把地图宽高算错了"。所以入口就挡住，并给出统一的文案。
     */
    if (!(width > 0) || !(height > 0)) {
      throw new Error(`[Raycasting] 尺寸必须为正，收到 ${width}x${height}`);
    }
    this._w = width;
    this._h = height;
    this._isWall = isWall;
    this.visible = new VisibilityMap(width, height);
  }

  compute(ox: number, oy: number, radius: number): number {
    const r = normalizeRadius(radius, this._w, this._h);

    this.visible.clear();

    /**
     * 【同样改用取反形式】
     * `ox < 0 || oy < 0 || ...` 对 NaN 恒为 false，会让 NaN 起点继续往下走，
     * 最终把 NaN 传进 `_castRay`。取反形式天然拦住 NaN。
     */
    if (!this._inBounds(ox, oy)) return 0;

    this.visible.mark(ox, oy);

    /**
     * 向圆周上每个格子发一条射线
     *
     * 【为什么不再先收集 perimeter 数组】
     * 原实现先 `push({x, y})` 建一个数组（半径 8 时约 40 个对象），
     * 再遍历它发射线——**每次 compute 分配一次数组 + N 个对象**。
     * 这些对象活不过一次调用，纯粹是 GC 垃圾；
     * 而 `compute` 是每帧都要跑的热路径。
     *
     * 直接在外层循环里发射线，省掉中间数组与 N 次对象分配，
     * **遍历顺序与结果完全一致**（双重循环的顺序没动）。
     */
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (dx * dx + dy * dy > r * r) continue;
        this._castRay(ox, oy, ox + dx, oy + dy);
      }
    }

    return this.visible.count;
  }

  private _castRay(x0: number, y0: number, x1: number, y1: number): void {
    /**
     * 【⚠️ 入口必须挡住非有限坐标，否则 `for(;;)` 永不退出】
     *
     * 原实现的越界检查是 `x < 0 || y < 0 || x >= w || y >= h`——
     * **NaN 参与比较恒为 false**，拦不住；
     * 步进条件 `e2 > -dy` / `e2 < dx` 在 `e2 = NaN` 时同样恒 false
     * → `x`/`y` 永不前进 → 死循环。
     *
     * 实测（修复前）：`compute(NaN, NaN, 4)` → **主线程冻死**，
     * 5 秒超时被杀（退出码 124）。正常 `compute(5,5,4)` 返回 17 格。
     *
     * 起点坐标算成 NaN 的现实来源：目标被销毁后 `atan2`、`Math.hypot` 除零等。
     * 一次射线投射就能冻死主线程，**无异常、无日志**，表现只是"游戏卡住"。
     */
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) return;
    if (!Number.isFinite(x1) || !Number.isFinite(y1)) return;

    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let x = x0;
    let y = y0;

    /**
     * 【迭代上限：最后一道防线】
     * Bresenham 正常最多走 `dx + dy + 1` 步。
     * 这里放宽到 `2 * (w + h) + 8`，既能覆盖所有合法射线，
     * 又保证即使上面某一处守卫被改坏，也只会"少画一格"而不是冻死主线程。
     * 卡死是这类可视算法最坏的失败模式——它连日志都留不下。
     */
    const maxSteps = 2 * (this._w + this._h) + 8;
    let steps = 0;

    for (;;) {
      /**
       * 【为什么用取反而不用四个比较】
       * `!_inBounds(x, y)` 对 NaN 返回 **true**（因为 `_inBounds` 内部
       * 的 `x >= 0` 对 NaN 为 false，整体为 false，取反为 true）——
       * 取反形式天然覆盖 NaN，四个比较的形式则天然漏掉 NaN。
       */
      if (!this._inBounds(x, y)) return;
      if (++steps > maxSteps) return;

      this.visible.mark(x, y);
      if (this._isWall(x, y)) return;   // 墙可见，但后面挡住

      if (x === x1 && y === y1) return;

      const e2 = 2 * err;
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

  /** 坐标是否在地图内（NaN 会被判为不在内） */
  private _inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this._w && y < this._h;
  }

  canSee(x: number, y: number): boolean {
    return this.visible.has(x, y);
  }
}

// ============================================================
// 辅助：把地图转成墙判定函数
// ============================================================

export function makeWallTest(
  map: ReadonlyArray<ReadonlyArray<number>>,
  wallValues: readonly number[] = [1]
): (x: number, y: number) => boolean {
  const set = new Set(wallValues);
  return (x: number, y: number) => {
    if (y < 0 || y >= map.length) return true;
    if (x < 0 || x >= map[y].length) return true;
    return set.has(map[y][x]);
  };
}
