/**
 * gesture/Gesture.ts —— 手势识别
 *
 * 【它解决什么】
 *
 * 移动端游戏需要：滑动、拖拽、点击、长按、画圈、双指缩放。
 *
 * 手写的做法是监听 touch 事件然后自己算，常见 bug：
 *
 * - **抖动被当成滑动**：手指微动几个像素就翻页了
 * - **圆圈被当成长按**：圆圈首尾重合，首尾直线距离≈0，
 *   先命中"基本没动"分支就返回 longPress，走不到画圈判定
 * - **累积转角不分正负**：来回抖动累加出很大的角度，被判成画圈
 * - **双指起始距离为 0**：`scale = d1 / d0` 得到 Infinity
 *
 * 本模块把这些坑都处理掉：
 *
 * ```typescript
 * const g = recognize(points);
 * // g.kind: 'swipe' | 'drag' | 'tap' | 'longPress' | 'circle' | 'none'
 * // g.dir:  'left' | 'right' | 'up' | 'down'
 * ```
 *
 * 【⚠️ 关于坐标系】
 *
 * 屏幕坐标 Y 向下（y 减小 = 上），世界坐标 Y 向上。
 * 用 `yDown` 选项切换。默认 `true`（屏幕坐标）。
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

export interface Point {
  readonly x: number;
  readonly y: number;
  /** 时间戳（毫秒） */
  readonly t: number;
}

export type GestureKind =
  | 'swipe'
  | 'drag'
  | 'tap'
  | 'longPress'
  | 'circle'
  | 'pinch'
  | 'none';

export type Direction = 'left' | 'right' | 'up' | 'down';

export interface Gesture {
  readonly kind: GestureKind;
  /** 方向（swipe / drag） */
  readonly dir?: Direction;
  /** 累计转角（弧度，带符号）。画圈约 ±2π */
  readonly turns?: number;
  /** 缩放倍数（pinch） */
  readonly scale?: number;
  /** 位移距离 */
  readonly distance?: number;
  /** 平均速度（像素/毫秒） */
  readonly speed?: number;
}

export interface RecognizeOptions {
  /** Y 轴是否向下（屏幕坐标）。默认 true */
  readonly yDown?: boolean;
  /** 判定为 swipe 的最小速度（像素/毫秒）。默认 0.3 */
  readonly swipeSpeed?: number;
  /** 判定为有效移动的最小距离（像素）。默认 10 */
  readonly minDistance?: number;
  /** 长按时长（毫秒）。默认 600 */
  readonly longPressMs?: number;
  /** 判定为画圈的最小累计转角（弧度）。默认 5 */
  readonly circleTurns?: number;
  /** 画圈的最小路径长度。默认 60 */
  readonly circleMinPath?: number;
}

const DEFAULTS: Required<RecognizeOptions> = {
  yDown: true,
  swipeSpeed: 0.3,
  minDistance: 10,
  longPressMs: 600,
  circleTurns: 5,
  circleMinPath: 60,
};

// ==================== 工具函数 ====================

/** 路径总长度 */
export function pathLength(pts: readonly Point[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += dist(pts[i - 1], pts[i]);
  }
  return d;
}

/**
 * 累计转角（弧度，带符号）
 *
 * 【⚠️ 必须带符号】
 * 不区分方向地累加绝对值的话，来回抖动会累加出很大的值
 * （抖 20 次每次 180°，累加就是 20π）。
 * 带符号累加后正负抵消，抖动的总转角接近 0。
 */
export function totalTurn(pts: readonly Point[]): number {
  if (pts.length < 3) return 0;

  let sum = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a1 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
    const a2 = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
    let d = a2 - a1;
    // 归一化到 (-π, π]
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    sum += d;
  }
  return sum;
}

/** 轨迹包围盒 */
export function boundsOf(pts: readonly Point[]): {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
} {
  if (pts.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * 由位移判断方向
 *
 * 【边界】dx 和 dy 绝对值相等时归为水平方向。
 */
export function dirOf(dx: number, dy: number, yDown = true): Direction {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  // yDown 时 y 减小是"上"
  return (dy < 0) === yDown ? 'up' : 'down';
}

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ==================== 识别 ====================

/**
 * 识别单指手势
 *
 * 【判定顺序很重要】
 * 画圈必须最先判定——因为圆圈首尾重合，
 * 首尾直线距离≈0，如果先判"基本没动"就会被吃掉。
 */
export function recognize(
  pts: readonly Point[],
  opts: RecognizeOptions = {}
): Gesture {
  const o = { ...DEFAULTS, ...opts };
  if (pts.length === 0) return { kind: 'none' };
  if (pts.length === 1) {
    return { kind: 'tap', distance: 0, speed: 0 };
  }

  const first = pts[0];
  const last = pts[pts.length - 1];
  const straight = dist(first, last);
  const path = pathLength(pts);
  /**
   * 【为什么不能只写 `Math.max(1, last.t - first.t)`】
   *
   * 它挡住 0 和负数，但挡不住 NaN：
   *
   *   Math.max(1, NaN) === NaN
   *     → speed = path / NaN = NaN
   *     → `speed >= o.swipeSpeed` 恒为 false
   *     → **所有手势分支全部落空，识别静默失效**
   *
   * 时间戳反了（last.t < first.t）时更隐蔽：
   * rawDt 为负 → 被 `Math.max` 兜到 1 → speed 放大上百倍，
   * 表现为"轻轻一划被判成快速滑动"。
   * 这是**数据错误伪装成了正常输入**，比直接失效更难发现。
   *
   * 所以先判断"dt 是否可信"，不可信时 speed 记 0
   * （落到 tap / longPress 分支，即"当作没有速度信息"），
   * 而不是让 NaN 或虚高值参与判定。
   */
  const rawDt = last.t - first.t;
  const dtValid = Number.isFinite(rawDt) && rawDt > 0;
  // 有效时保留 `Math.max(1, ...)`：防除零，也防 rawDt 极小时 speed 爆炸
  const dt = dtValid ? Math.max(1, rawDt) : 0;
  /** dt 不可信时记 0（"速度未知"），避免 NaN 穿透与虚高 */
  const speedOf = (d: number): number => (dtValid ? d / dt : 0);

  // ① 画圈（最先判：用路径总长而不是首尾距离）
  const turns = totalTurn(pts);
  if (
    Math.abs(turns) >= o.circleTurns &&
    path >= o.circleMinPath
  ) {
    return { kind: 'circle', turns, distance: path, speed: speedOf(path) };
  }

  // ② 基本没动 → 点击或长按
  if (path < o.minDistance) {
    const held = dt >= o.longPressMs;
    return {
      kind: held ? 'longPress' : 'tap',
      distance: path,
      speed: speedOf(path),
    };
  }

  // ③ 有位移 → 滑动或拖拽
  const speed = speedOf(straight);
  const dx = last.x - first.x;
  const dy = last.y - first.y;

  return {
    kind: speed >= o.swipeSpeed ? 'swipe' : 'drag',
    dir: dirOf(dx, dy, o.yDown),
    distance: straight,
    speed,
  };
}

/**
 * 识别双指缩放
 *
 * @param a0 b0 起始时两指位置
 * @param a1 b1 结束时两指位置
 */
export function recognizePinch(
  a0: Point,
  b0: Point,
  a1: Point,
  b1: Point,
  opts: { readonly minScaleDelta?: number } = {}
): Gesture {
  const minDelta = opts.minScaleDelta ?? 0.2;

  const d0 = Math.sqrt((a0.x - b0.x) ** 2 + (a0.y - b0.y) ** 2);
  const d1 = Math.sqrt((a1.x - b1.x) ** 2 + (a1.y - b1.y) ** 2);

  /**
   * 【⚠️ 起始距离为 0 时不除零】
   * 两指起始重合时 d0 = 0，d1/d0 得到 Infinity。
   * 退化成 1（表示"没变化"）。
   */
  if (d0 <= 1e-6) {
    return { kind: 'none', scale: 1 };
  }

  const scale = d1 / d0;
  if (Math.abs(scale - 1) < minDelta) {
    return { kind: 'none', scale };
  }
  return { kind: 'pinch', scale };
}

// ==================== 识别器 ====================

export interface RecognizerOptions extends RecognizeOptions {
  /** 采样点上限（防止长轨迹占内存） */
  readonly maxPoints?: number;
  /** 相邻点去抖：位移小于此值且时间小于 minDt 则忽略 */
  readonly minMove?: number;
  readonly minDt?: number;
  /** 静止超过这么久自动结束 */
  readonly idleTimeoutMs?: number;
}

/**
 * 增量式识别器
 *
 * ```
 * rec.down(p); rec.move(p); rec.move(p); const g = rec.up(p);
 * ```
 */
export class GestureRecognizer {
  private readonly _opts: Required<
    Pick<RecognizerOptions, 'maxPoints' | 'minMove' | 'minDt' | 'idleTimeoutMs'>
  > &
    RecognizeOptions;
  private _pts: Point[] = [];
  private _active = false;
  /**
   * 按下的时刻（`down()` 的那个点的时间戳）
   *
   * 【⚠️ 为什么必须单独记，不能读 `_pts[0].t`】
   * `maxPoints` 是**滑动窗口**：超限时 `shift()` 丢的是**最早的点**，
   * 而"按了多久"恰恰由最早的点决定。静止按住 1 秒产生 20 个采样点、
   * `maxPoints: 8` 时，窗口里最早的点已经是第 650ms 的那个，
   * 于是"按了 1000ms"被算成"按了 350ms"——长按阈值 600ms 判不出来，
   * 1 秒的长按被识别成**单击**。
   *
   * 更麻烦的是它**只在特定设备上复现**：采样率越高、maxPoints 配得越小，
   * 越容易触发。玩家的表现是"我明明按住了却触发了普通点击"。
   */
  private _downT: number | null = null;

  constructor(opts: RecognizerOptions = {}) {
    this._opts = {
      maxPoints: opts.maxPoints ?? 64,
      minMove: opts.minMove ?? 1,
      minDt: opts.minDt ?? 16,
      idleTimeoutMs: opts.idleTimeoutMs ?? Infinity,
      ...opts,
    };
  }

  get active(): boolean {
    return this._active;
  }

  get pointCount(): number {
    return this._pts.length;
  }

  get points(): readonly Point[] {
    return this._pts;
  }

  down(p: Point): void {
    this._pts = [p];
    this._active = true;
    this._downT = p.t;
  }

  move(p: Point): void {
    if (!this._active) return;

    // ① 静止超时
    const last = this._pts[this._pts.length - 1];
    if (last && p.t - last.t > this._opts.idleTimeoutMs) {
      this._active = false;
      return;
    }

    // ② 去抖：位移太小且时间太短
    if (last) {
      const moved = Math.sqrt((p.x - last.x) ** 2 + (p.y - last.y) ** 2);
      if (moved < this._opts.minMove && p.t - last.t < this._opts.minDt) {
        return;
      }
    }

    this._pts.push(p);
    if (this._pts.length > this._opts.maxPoints) {
      this._pts.shift();
    }
  }

  up(p: Point): Gesture {
    if (!this._active) return { kind: 'none' };
    this.move(p);
    /**
     * 【⚠️ 起点的时间戳要用真实的按下时刻，不能用窗口里最早的点】
     *
     * 只把 `_pts[0]` 的 **t** 换成 `_downT`、坐标保持不动：
     * 这样 `recognize` 算出的 dt 是真实按住时长，
     * 而 `pathLength` / `totalTurn`（只依赖坐标）完全不受影响。
     *
     * 【为什么不在 move() 裁剪时"不丢起点"】
     * 那会让窗口失去意义（轨迹无限增长），
     * 而位移类判定（滑动距离、画圈）本来就该只看最近的一段。
     * 时长与轨迹是两种语义，就该分开存。
     */
    if (this._downT !== null && this._pts.length > 0 && this._pts[0].t > this._downT) {
      this._pts[0] = { x: this._pts[0].x, y: this._pts[0].y, t: this._downT };
    }
    const g = recognize(this._pts, this._opts);
    this._pts = [];
    this._active = false;
    this._downT = null;
    return g;
  }

  cancel(): void {
    this._pts = [];
    this._active = false;
    this._downT = null;
  }

  /**
   * 当前是否已构成长按（用于长按进度提示）
   *
   * 【移动过就不算长按】
   * 长按的语义是"按住不动"，移动超过阈值就不该再触发。
   */
  isLongPressSoFar(now: number): boolean {
    if (!this._active || this._pts.length === 0) return false;
    // 用真实的按下时刻，而不是 `_pts[0].t`（它可能被 maxPoints 裁掉）
    const startT = this._downT ?? this._pts[0].t;
    if (now - startT < (this._opts.longPressMs ?? DEFAULTS.longPressMs)) {
      return false;
    }
    return pathLength(this._pts) < (this._opts.minDistance ?? DEFAULTS.minDistance);
  }
}

// ==================== 双击检测 ====================

export class DoubleTapDetector {
  private readonly _maxGapMs: number;
  private readonly _maxDist: number;
  private _last: Point | null = null;

  constructor(
    opts: { readonly maxGapMs?: number; readonly maxDist?: number } = {}
  ) {
    this._maxGapMs = opts.maxGapMs ?? 300;
    this._maxDist = opts.maxDist ?? 30;
  }

  /**
   * 记录一次点击，返回是否构成双击
   *
   * 【⚠️ 三连击只算一次】
   * 第二次返回 true 后清空记录，第三次的点击重新开始计。
   */
  tap(p: Point): boolean {
    if (this._last === null) {
      this._last = p;
      return false;
    }

    const inTime = p.t - this._last.t <= this._maxGapMs;
    const inPlace =
      Math.sqrt((p.x - this._last.x) ** 2 + (p.y - this._last.y) ** 2) <=
      this._maxDist;

    if (inTime && inPlace) {
      this._last = null;   // 消费掉
      return true;
    }

    this._last = p;
    return false;
  }

  reset(): void {
    this._last = null;
  }
}
