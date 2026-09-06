/**
 * minimap/Minimap.ts —— 小地图坐标与布局
 *
 * 【它解决什么】
 *
 * 小地图看起来是"把大地图缩小画出来"，
 * 但功能完整的实现要处理六件事：
 *
 * 1. **坐标映射**
 *    世界坐标（可能是 0~10000）→ 小地图坐标（0~200 像素）。
 *    缩放系数、中心点、Y 轴翻转（世界 Y 向上，屏幕 Y 向下）。
 *
 * 2. **跟随模式**
 *    - 固定：整张地图缩到小地图里，玩家是个移动的点
 *    - 跟随：玩家永远居中，地图在动
 *
 * 3. **旋转模式**
 *    - 北朝上：小地图方向固定
 *    - 镜头朝向：小地图随玩家转向，需要**逆旋转变换**
 *
 * 4. **边界外实体**
 *    敌人在小地图范围外时，直接不画的话玩家就看不到威胁了。
 *    常见做法是**钳制到边缘**并标记方向。
 *
 * 5. **图标大小**
 *    地图缩放时图标不能跟着缩——
 *    否则把地图缩小到 25% 时，敌人图标只剩 1 像素。
 *
 * 6. **战争迷雾**
 *    只显示已探索区域。迷雾通常是一张低分辨率位图，
 *    需要与小地图坐标对齐。
 *
 * 【设计】
 * 本模块只做**坐标计算与布局**，不画任何东西。
 * 输出的是"每个实体该画在哪、多大、什么朝向、是否钳制"，
 * 由调用方拿去渲染。这样它可以被完整测试。
 */

import { normalizeAngleRad, clamp } from '../_core/math';

// ==================== 类型 ====================

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
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export type MinimapMode =
  /** 固定：整张地图完整显示 */
  | 'fixed'
  /** 跟随：玩家居中，地图滚动 */
  | 'follow';

export type MinimapShape =
  /** 矩形（适合方形关卡） */
  | 'rect'
  /** 圆形（适合开放世界，视野是圆） */
  | 'circle';

export interface MinimapConfig {
  /**
   * 世界尺寸（宽高）
   *
   * 【⚠️ 这是世界的完整尺寸，不是当前关卡】
   * 开放世界里它可能是 10000×10000。
   */
  readonly worldSize: Vec2;
  /**
   * 小地图尺寸（像素，正方形的一半 *
   *
   * 对于 rect：这是 {width, height}
   * 对于 circle：只用 x 作为半径
   */
  readonly viewSize: Vec2;
  /** 模式（默认 'follow'） */
  readonly mode?: MinimapMode;
  /** 形状（默认 'rect'） */
  readonly shape?: MinimapShape;
  /**
   * 缩放（默认自动计算）
   *
   * fixed 模式下默认"刚好装下整个世界"；
   * follow 模式下默认 1（1 世界单位 = 1 小地图像素）。
   *
   * 【手动指定的用途】
   * follow 模式下想看得更远，就设 0.5（缩小一半）；
   * 想看得更细，就设 2。
   */
  readonly scale?: number;
  /**
   * 是否随玩家朝向旋转（默认 false）
   *
   * true 时小地图会转，玩家永远朝上。
   * 【注意】这让"北方"不再固定，玩家容易迷失方向。
   * 多数游戏默认关闭，只在载具/飞行类里打开。
   */
  readonly rotateWithView?: boolean;
  /**
   * 边界外实体是否钳制到边缘（默认 true）
   *
   * 【为什么默认开】
   * 关掉的话，小地图范围外的敌人完全不显示，
   * 玩家会觉得"背后突然冒出来一个人"。
   */
  readonly clampToEdge?: boolean;
  /**
   * 钳制时的内缩量（像素，默认 4）
   *
   * 让钳制后的图标不要压在小地图边框上。
   */
  readonly edgePadding?: number;
}

/** 世界中的一个实体 */
export interface MinimapEntity {
  readonly id: string;
  readonly pos: Vec2;
  /** 朝向（弧度，0 = +X 方向） */
  readonly rotation?: number;
  /**
   * 类型（调用方自定义）
   *
   * 常见：'player' / 'enemy' / 'ally' / 'objective' / 'shop'
   */
  readonly kind: string;
  /**
   * 是否始终显示（默认 false）
   *
   * true 的话即使在小地图范围外也不钳制、不隐藏。
   * 用于任务目标这类"必须让玩家知道方向"的实体。
   */
  readonly alwaysShow?: boolean;
}

/** 小地图上的一个图标 */
export interface MinimapIcon {
  readonly id: string;
  readonly kind: string;
  /** 小地图坐标（以小地图中心为原点的像素偏移） */
  readonly x: number;
  readonly y: number;
  /** 屏幕朝向（已应用旋转模式） */
  readonly rotation: number;
  /** 是否在可视范围内（未被钳制） */
  readonly inView: boolean;
  /** 是否被钳制到了边缘 */
  readonly clamped: boolean;
  /** 距离玩家的世界距离 */
  readonly distance: number;
  /** 是否应该显示 */
  readonly visible: boolean;
}

// ==================== 实现 ====================

/** 把角度规范到 (-π, π] */
export function normalizeAngle(a: number): number {
  /**
   * 【⚠️ 非有限值必须归一到 0，不能返回 NaN】
   *
   * 原实现 `a % TWO_PI`：`Infinity % 2π` → **NaN**。
   * 实测 `normalizeAngle(Infinity)` → NaN。
   *
   * 这个返回值会直接进小地图图标的 `rotation` 字段。
   * NaN 旋转在渲染层表现为"图标消失"或"朝向乱转"，
   * 且不报错——玩家只会觉得小地图有问题。
   *
   * 复用了 `_core.normalizeAngleRad`（O(1) 取模 + 非有限值归 0），
   * 这里保留同名导出以免破坏既有调用方。
   */
  return normalizeAngleRad(a);
}

export class Minimap {
  private readonly _cfg: Required<Omit<MinimapConfig, 'scale'>> & { scale: number | null };
  private readonly _scale: number;

  constructor(cfg: MinimapConfig) {
    this._cfg = {
      worldSize: cfg.worldSize,
      viewSize: cfg.viewSize,
      mode: cfg.mode ?? 'follow',
      shape: cfg.shape ?? 'rect',
      scale: cfg.scale ?? null,
      rotateWithView: cfg.rotateWithView ?? false,
      clampToEdge: cfg.clampToEdge ?? true,
      edgePadding: cfg.edgePadding ?? 4,
    };

    this._scale = cfg.scale ?? this._autoScale();
  }

  private _autoScale(): number {
    if (this._cfg.mode === 'fixed') {
      // 刚好装下整个世界
      const sx = this._cfg.viewSize.x / Math.max(1, this._cfg.worldSize.x);
      const sy = this._cfg.viewSize.y / Math.max(1, this._cfg.worldSize.y);
      return Math.min(sx, sy);
    }
    return 1;
  }

  get scale(): number {
    return this._scale;
  }

  get config(): MinimapConfig {
    return { ...this._cfg, scale: this._scale };
  }

  // ==================== 核心：坐标变换 ====================

  /**
   * 世界坐标 → 小地图坐标
   *
   * @param world 世界坐标
   * @param viewer 观察者位置（通常是玩家）
   * @param viewRot 观察者朝向（弧度）
   * @returns 以小地图中心为原点的像素偏移
   *
   * 【⚠️ Y 轴翻转】
   * 世界坐标 Y 向上，屏幕坐标 Y 向下。
   * 这里在最后一步取负，调用方直接用即可。
   */
  worldToMinimap(world: Vec2, viewer: Vec2, viewRot = 0): Vec2 {
    if (this._cfg.mode === 'fixed') {
      /**
       * 固定模式：与观察者无关，整张地图铺进盒子并居中。
       *
       * 【⚠️ 早期版本在 fixed 模式下也减去了 viewer】
       * 于是"固定"小地图会跟着玩家抖——
       * 它本该是静止的。
       */
      const dxIn = world.x - this._cfg.worldSize.x / 2;
      const dyIn = world.y - this._cfg.worldSize.y / 2;
      const [dx, dy] = this._orient(dxIn, dyIn, viewRot);
      return {
        x: dx * this._scale + this._cfg.viewSize.x / 2,
        y: dy * this._scale + this._cfg.viewSize.y / 2,
      };
    }

    // 跟随模式：观察者永远在小地图中心
    const [dx, dy] = this._orient(world.x - viewer.x, world.y - viewer.y, viewRot);
    return { x: dx * this._scale, y: dy * this._scale };
  }

  /**
   * 把"世界坐标系下的相对位移"转到"小地图像素坐标系"
   *
   * 【⚠️ 旋转分支里同时完成了 Y 翻转】
   *
   * 非旋转分支：北（+Y）朝上 → `dy = -dy`
   * 旋转分支：观察者前方朝上 → `(dx, dy) = (-lateral, -forward)`
   *
   * 早期版本在旋转分支后又统一做了一次 `my = -my`，
   * 等于翻了两次，Y 轴方向反而变回去了。
   */
  private _orient(dxIn: number, dyIn: number, viewRot: number): [number, number] {
    if (!this._cfg.rotateWithView) {
      // 北朝上：世界 Y 向上 → 屏幕 y 向下
      return [dxIn, -dyIn];
    }
    /**
     * 分解出"前后 / 左右"分量
     *
     * 观察者朝向 (cos rot, sin rot)，于是
     *   forward = 位移 · 朝向 = dx·cos + dy·sin
     *   lateral = 位移 · 左手法线 = -dx·sin + dy·cos
     *
     * 然后映射到屏幕：
     *   前方 → 上（屏幕 y 负） ⇒  screenY = -forward
     *   左手 → 左（屏幕 x 负） ⇒  screenX = -lateral
     */
    const c = Math.cos(viewRot);
    const s = Math.sin(viewRot);
    const forward = dxIn * c + dyIn * s;
    const lateral = -dxIn * s + dyIn * c;
    return [-lateral, -forward];
  }

  /** 小地图坐标 → 世界坐标（反向，用于点击小地图传送/标记） */
  minimapToWorld(m: Vec2, viewer: Vec2, viewRot = 0): Vec2 {
    if (this._cfg.mode === 'fixed') {
      const dxIn = (m.x - this._cfg.viewSize.x / 2) / this._scale;
      const dyIn = (m.y - this._cfg.viewSize.y / 2) / this._scale;
      const [dx, dy] = this._unorient(dxIn, dyIn, viewRot);
      return {
        x: dx + this._cfg.worldSize.x / 2,
        y: dy + this._cfg.worldSize.y / 2,
      };
    }
    const [dx, dy] = this._unorient(m.x / this._scale, m.y / this._scale, viewRot);
    return { x: viewer.x + dx, y: viewer.y + dy };
  }

  /** `_orient` 的逆变换 */
  private _unorient(sx: number, sy: number, viewRot: number): [number, number] {
    if (!this._cfg.rotateWithView) {
      return [sx, -sy];
    }
    const lateral = -sx;
    const forward = -sy;
    const c = Math.cos(viewRot);
    const s = Math.sin(viewRot);
    return [
      forward * c - lateral * s,
      forward * s + lateral * c,
    ];
  }

  // ==================== 边界判定 ====================

  /**
   * 半宽（像素）
   *
   * 矩形和圆形都是 `viewSize.x / 2`——
   * viewSize 描述的是**外接盒**，圆形内切于它。
   */
  private get _limitX(): number {
    return this._cfg.viewSize.x / 2;
  }

  private get _limitY(): number {
    return this._cfg.viewSize.y / 2;
  }

  /**
   * 圆形模式的半径（像素）
   *
   * 【⚠️ 是外接盒的一半，不是 viewSize.x】
   * viewSize = {200, 200} 表示小地图占 200×200 的盒子，
   * 内切圆半径是 100。
   * 早期版本直接用 viewSize.x 当半径，
   * 结果圆形小地图的实际可视范围是盒子的 4 倍，
   * 边界外的敌人图标全挤在角落上（因为 clampToEdge 用了另一个口径）。
   */
  private get _radius(): number {
    return Math.min(this._cfg.viewSize.x, this._cfg.viewSize.y) / 2;
  }

  /** 某点是否在可视范围内 */
  isInView(p: Vec2): boolean {
    if (this._cfg.shape === 'circle') {
      return Math.sqrt(p.x * p.x + p.y * p.y) <= this._radius;
    }
    return Math.abs(p.x) <= this._limitX && Math.abs(p.y) <= this._limitY;
  }

  /**
   * 钳制到边缘
   *
   * 【⚠️ 圆形用等比例缩放到半径上，矩形用分别 clamp】
   *
   * 矩形下分别 clamp x/y 是对的；
   * 但圆形下如果也分别 clamp，会得到一个方形边界——
   * 图标出现在圆外的四个角上，很怪。
   */
  clampToEdge(p: Vec2): { readonly pos: Vec2; readonly clamped: boolean } {
    /**
     * 【⚠️ 配置关闭时必须真的不钳制】
     * 早期版本这个方法无条件钳制，
     * 而 `layout()` 里又用 `clampToEdge` 的结果去判断 visible，
     * 于是 `clampToEdge: false` 被静默忽略——
     * 想关掉钳制的人发现关不掉。
     */
    if (!this._cfg.clampToEdge) return { pos: p, clamped: false };
    if (this.isInView(p)) return { pos: p, clamped: false };

    const pad = this._cfg.edgePadding;

    if (this._cfg.shape === 'circle') {
      const r = Math.sqrt(p.x * p.x + p.y * p.y) || 1;
      const maxR = Math.max(1, this._radius - pad);
      return {
        pos: { x: (p.x / r) * maxR, y: (p.y / r) * maxR },
        clamped: true,
      };
    }

    const maxX = Math.max(1, this._limitX - pad);
    const maxY = Math.max(1, this._limitY - pad);
    return {
      pos: { x: clamp(p.x, -maxX, maxX), y: clamp(p.y, -maxY, maxY) },
      clamped: true,
    };
  }

  // ==================== 布局 ====================

  /**
   * 计算全部实体的图标布局
   *
   * @param entities 世界中的实体
   * @param viewer 观察者位置
   * @param viewRot 观察者朝向
   * @param fog 迷雾（可选，返回 true 表示该点已探索）
   */
  layout(
    entities: readonly MinimapEntity[],
    viewer: Vec2,
    viewRot = 0,
    fog?: (world: Vec2) => boolean
  ): readonly MinimapIcon[] {
    const out: MinimapIcon[] = [];

    for (const e of entities) {
      const raw = this.worldToMinimap(e.pos, viewer, viewRot);
      const inView = this.isInView(raw);
      const { pos, clamped } = this._cfg.clampToEdge
        ? this.clampToEdge(raw)
        : { pos: raw, clamped: false };

      // 始终显示的实体：范围外也要显示（钳制后）
      let visible = true;
      if (!inView && !e.alwaysShow && !this._cfg.clampToEdge) {
        visible = false;
      }

      // 迷雾：未探索区域不显示
      if (visible && fog !== undefined && !fog(e.pos)) {
        visible = false;
      }

      const dx = e.pos.x - viewer.x;
      const dy = e.pos.y - viewer.y;

      out.push({
        id: e.id,
        kind: e.kind,
        x: pos.x,
        y: pos.y,
        /**
         * 【图标朝向：以小地图的"上"为 0，顺时针为正】
         *
         * 这个约定对两种模式都能给出一致的解释：
         *
         * - 旋转模式：观察者的前方朝上 → `viewRot - e`
         * - 非旋转模式：世界的北（+Y）朝上 → `π/2 - e`
         *
         * 【⚠️ 为什么不返回"屏幕数学角度"】
         * 若返回 0=+X 的屏幕角度，旋转模式下会多出一个 -π/2 常数
         * （因为"观察者前方"被映射到"上"，而不是"右"）。
         * 调用方拿到 -π/2 必然要查文档才敢用。
         * 用"上为 0"这个约定，两种模式的公式都是一眼可读的。
         *
         * 【换算成引擎角度（Cocos / 0=+X、逆时针为正）】
         * `node.angle = degrees(π/2 - rotation)`
         */
        rotation: normalizeAngle(this._cfg.rotateWithView
          ? viewRot - (e.rotation ?? 0)
          : Math.PI / 2 - (e.rotation ?? 0)),
        inView,
        clamped,
        distance: Math.sqrt(dx * dx + dy * dy),
        visible,
      });
    }

    return out;
  }

  // ==================== 迷雾位图 ====================

  /**
   * 生成一个迷雾位图（每个 bit 代表一格是否探索）
   *
   * @param resolution 分辨率（建议 32~128，太大浪费内存）
   *
   * 【⚠️ 分辨率不要跟小地图像素对齐】
   * 小地图是 200×200 像素的话，迷雾用 200×200 太浪费——
   * 迷雾是模糊的色块，32×32 完全够用，
   * 渲染时放大插值即可。
   */
  createFogMap(resolution: number): FogMap {
    return new FogMap(this._cfg.worldSize, resolution);
  }
}

// ==================== 迷雾 ====================

/**
 * 迷雾位图
 *
 * 用 Uint8Array 而非 boolean[]——后者每个元素占 8 字节。
 */
export class FogMap {
  private readonly _worldSize: Vec2;
  private readonly _res: number;
  private readonly _cells: Uint8Array;

  constructor(worldSize: Vec2, resolution: number) {
    this._worldSize = worldSize;
    this._res = Math.max(1, resolution);
    this._cells = new Uint8Array(this._res * this._res);
  }

  get resolution(): number {
    return this._res;
  }

  /** 世界坐标 → 格子索引（-1 表示越界） */
  private _index(world: Vec2): number {
    const gx = Math.floor((world.x / this._worldSize.x) * this._res);
    const gy = Math.floor((world.y / this._worldSize.y) * this._res);
    if (gx < 0 || gy < 0 || gx >= this._res || gy >= this._res) return -1;
    return gy * this._res + gx;
  }

  /** 揭开某点周围 */
  reveal(world: Vec2, radius = 0): void {
    if (radius <= 0) {
      const i = this._index(world);
      if (i >= 0) this._cells[i] = 1;
      return;
    }
    const step = (radius / this._worldSize.x) * this._res;
    const cells = Math.max(1, Math.ceil(step));
    const cx = Math.floor((world.x / this._worldSize.x) * this._res);
    const cy = Math.floor((world.y / this._worldSize.y) * this._res);
    for (let dy = -cells; dy <= cells; dy++) {
      for (let dx = -cells; dx <= cells; dx++) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gy < 0 || gx >= this._res || gy >= this._res) continue;
        this._cells[gy * this._res + gx] = 1;
      }
    }
  }

  /** 某点是否已探索 */
  isRevealed(world: Vec2): boolean {
    const i = this._index(world);
    return i >= 0 && this._cells[i] === 1;
  }

  /** 已探索比例 0~1 */
  get coverage(): number {
    let n = 0;
    for (let i = 0; i < this._cells.length; i++) n += this._cells[i]!;
    return n / this._cells.length;
  }

  /** 清空（新一局） */
  clear(): void {
    this._cells.fill(0);
  }

  /** 序列化（存档用） */
  toBytes(): Uint8Array {
    return new Uint8Array(this._cells);
  }

  static fromBytes(worldSize: Vec2, resolution: number, bytes: Uint8Array): FogMap {
    const m = new FogMap(worldSize, resolution);
    if (bytes.length === m._cells.length) m._cells.set(bytes);
    return m;
  }
}
