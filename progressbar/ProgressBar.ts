/**
 * progressbar/ProgressBar.ts —— 进度条（纯逻辑层）
 *
 * 【它解决什么】
 *
 * 血条不是"画一个矩形"这么简单。真正麻烦的三种：
 *
 * 1. **延迟条（damage trail）**
 *    受击时主条立刻掉，后面留一条红色的"残影"缓慢跟上。
 *    玩家因此能看清"刚才这一下掉了多少血"。
 *    没有它，快速连续受击时玩家只知道血少了，不知道掉了多少。
 *
 * 2. **分段血条（segmented）**
 *    Boss 血条分成 3 段，每打掉一段有明确的视觉节点。
 *    分段要处理"当前在第几段""段间空隙""最后一段不满"的边界。
 *
 * 3. **缓动跟随**
 *    经验条从 0.7 涨到 0.9，直接跳变很生硬，平滑过去才好看。
 *
 * 【它不做什么】
 *
 * 本模块不画任何东西，只算数字：
 * `mainRatio` / `trailRatio` / `segmentIndex` / `displayValue`。
 * 渲染由你套到引擎的 Sprite / Graphics 上。
 */

import { clamp, clamp01, clampNum, numOr, safeDt, lerp } from '../_core/math';

// ==================== 类型 ====================

export type FillDirection = 'ltr' | 'rtl' | 'ttb' | 'btt';

export interface ProgressBarOptions {
  readonly min?: number;
  readonly max?: number;
  readonly value?: number;

  /** 分段数（0 或 1 = 不分段） */
  readonly segments?: number;
  /** 段间空隙占比（0~0.2），相对于整条宽度 */
  readonly segmentGap?: number;

  /** 是否启用延迟条 */
  readonly trail?: boolean;
  /** 延迟条等待多久开始跟随（秒） */
  readonly trailDelay?: number;
  /** 延迟条跟随速度（每秒移动的比例） */
  readonly trailSpeed?: number;

  /** 显示值缓动速度（每秒），0 表示不缓动 */
  readonly easeSpeed?: number;

  /** 低于此比值时进入 low 状态（UI 变红） */
  readonly lowThreshold?: number;
  /** 高于此比值时进入 high 状态 */
  readonly highThreshold?: number;
  /** 进入/离开阈值时的滞回，防止在边界反复横跳 */
  readonly thresholdHysteresis?: number;

  readonly direction?: FillDirection;
}

export type BarState = 'normal' | 'low' | 'high' | 'empty' | 'full';

export interface BarSnapshot {
  /** 实际值 */
  readonly value: number;
  /** 实际值占比 0~1 */
  readonly ratio: number;
  /** 用于渲染的占比（缓动后）0~1 */
  readonly displayRatio: number;
  /** 延迟条占比 0~1（未启用时等于 displayRatio） */
  readonly trailRatio: number;
  /** 当前处于第几段（0 基；不分段时为 0） */
  readonly segmentIndex: number;
  /** 当前段内的填充比例 0~1 */
  readonly segmentFill: number;
  readonly state: BarState;
}

// ==================== 实现 ====================

const DEFAULTS = {
  min: 0,
  max: 100,
  segments: 0,
  segmentGap: 0.02,
  trail: false,
  trailDelay: 0.35,
  trailSpeed: 0.5,
  easeSpeed: 0,
  lowThreshold: 0.25,
  highThreshold: 1,
  hysteresis: 0.02,
};

export class ProgressBar {
  private readonly _min: number;
  private readonly _max: number;
  private _value: number;

  private readonly _segments: number;
  private readonly _segGap: number;
  private readonly _trail: boolean;
  private readonly _trailDelay: number;
  private readonly _trailSpeed: number;
  private readonly _easeSpeed: number;
  private readonly _lowThreshold: number;
  private readonly _highThreshold: number;
  private readonly _hysteresis: number;
  private readonly _direction: FillDirection;

  /** 缓动后的显示比例 */
  private _display: number;
  /** 延迟条比例 */
  private _trailValue: number;
  /** 延迟条等待计时 */
  private _trailWait = 0;
  private _state: BarState = 'normal';

  constructor(opts: ProgressBarOptions = {}) {
    this._min = opts.min ?? DEFAULTS.min;
    this._max = opts.max ?? DEFAULTS.max;
    if (this._max <= this._min) {
      throw new Error(`[ProgressBar] max 必须大于 min（收到 min=${this._min}, max=${this._max}）`);
    }

    // 【为什么 clampNum 包在 Math.floor 内层】分段数是渲染用的，
    // Infinity 会让绘制循环永远跑不完；NaN 会让 Math.max(0, NaN) 直接穿透。
    this._segments = Math.floor(clampNum(opts.segments, 0, 1e5, DEFAULTS.segments));
    this._segGap = clamp(opts.segmentGap ?? DEFAULTS.segmentGap, 0, 0.2);
    if (this._segments > 1 && this._segGap > 0 && this._segments * this._segGap >= 1) {
      throw new Error('[ProgressBar] 段间空隙过大：段数 × 空隙 不能 >= 1');
    }

    this._trail = opts.trail ?? DEFAULTS.trail;
    this._trailDelay = Math.max(0, numOr(opts.trailDelay, DEFAULTS.trailDelay));
    this._trailSpeed = Math.max(0.01, numOr(opts.trailSpeed, DEFAULTS.trailSpeed));
    this._easeSpeed = Math.max(0, numOr(opts.easeSpeed, DEFAULTS.easeSpeed));
    this._lowThreshold = clamp01(opts.lowThreshold ?? DEFAULTS.lowThreshold);
    this._highThreshold = clamp01(opts.highThreshold ?? DEFAULTS.highThreshold);
    this._hysteresis = Math.max(0, numOr(opts.thresholdHysteresis, DEFAULTS.hysteresis));
    this._direction = opts.direction ?? 'ltr';

    const initial = opts.value ?? this._min;
    this._value = this._clampValue(initial);
    this._display = this.ratio;
    this._trailValue = this._display;
    this._state = this._computeState(this._display, 'normal');
  }

  // ==================== 查询 ====================

  get value(): number {
    return this._value;
  }

  get min(): number {
    return this._min;
  }

  get max(): number {
    return this._max;
  }

  /** 实际占比 0~1 */
  get ratio(): number {
    return clamp01((this._value - this._min) / (this._max - this._min));
  }

  get displayRatio(): number {
    return this._display;
  }

  get trailRatio(): number {
    return this._trail ? this._trailValue : this._display;
  }

  get isEmpty(): boolean {
    return this._value <= this._min;
  }

  get isFull(): boolean {
    return this._value >= this._max;
  }

  get state(): BarState {
    return this._state;
  }

  get segmentCount(): number {
    return this._segments;
  }

  get direction(): FillDirection {
    return this._direction;
  }

  /** 是否反向填充（rtl / btt 需要翻转渲染方向） */
  get reversed(): boolean {
    return this._direction === 'rtl' || this._direction === 'btt';
  }

  get vertical(): boolean {
    return this._direction === 'ttb' || this._direction === 'btt';
  }

  // ==================== 修改 ====================

  /** 直接设置（读档、初始化用） */
  set(v: number): void {
    const prevDisplay = this._display;
    this._value = this._clampValue(v);
    const r = this.ratio;

    /**
     * 【⚠️ 增加时不该有延迟条】
     *
     * 延迟条是"受伤残影"，用于展示刚掉的血。
     * 回血时如果也延迟，玩家会看到血条先涨、红色残影追上来——
     * 那是"扣血"的视觉语言，出现在回血场景是完全错误的。
     */
    if (r > prevDisplay) {
      this._trailValue = r;
      this._trailWait = 0;
    }

    /**
     * 【⚠️ 不缓动时 display 必须立刻生效】
     *
     * 否则 `bar.set(50)` 之后不调 update 直接读 displayRatio，
     * 拿到的还是上一次 update 时的旧值。
     * UI 在设置界面预览血条时经常这么用。
     *
     * 有缓动时 display 由 update 推进——这样经验条增长才有动画。
     */
    if (this._easeSpeed <= 0) {
      this._display = r;
    }

    this._state = this._computeState(r, this._state);
  }

  add(delta: number): void {
    this.set(this._value + delta);
  }

  /** 填满 */
  fill(): void {
    this.set(this._max);
  }

  /** 清空 */
  empty(): void {
    this.set(this._min);
  }

  // ==================== 驱动 ====================

  /**
   * 每帧更新
   *
   * @param dt 帧间隔（秒）
   */
  update(dt: number): void {
    if (!safeDt(dt)) return;

    const target = this.ratio;

    // ① 显示值缓动
    if (this._easeSpeed > 0) {
      const step = this._easeSpeed * dt;
      const diff = target - this._display;
      if (Math.abs(diff) <= step) this._display = target;
      else this._display += Math.sign(diff) * step;
    } else {
      this._display = target;
    }

    // ② 延迟条
    if (this._trail) {
      /**
       * 【⚠️ 用真实 ratio 判断，而不是 display】
       *
       * 开启缓动后，回血时 display 还在慢慢追，
       * 表面上 trail > display——如果据此开始"下降追赶"，
       * 玩家会看到红色残影跟着血条一起涨，语义完全反了。
       *
       * 判断"是否真的掉血了"要看真实值：只有 target < trail 才是掉血。
       */
      if (this._trailValue > target) {
        if (this._trailWait < this._trailDelay) {
          this._trailWait += dt;
        } else {
          this._trailValue = Math.max(
            target,
            this._trailValue - this._trailSpeed * dt
          );
        }
      } else {
        this._trailValue = Math.max(this._trailValue, this._display);
        this._trailWait = 0;
      }
    }

    this._state = this._computeState(this._display, this._state);
  }

  /** 跳过所有缓动，立刻到位（切场景、跳过动画用） */
  snap(): void {
    this._display = this.ratio;
    this._trailValue = this._display;
    this._trailWait = 0;
  }

  // ==================== 分段 ====================

  /**
   * 当前处于第几段（0 基）
   *
   * 【语义：血量"覆盖"到第几段】
   *
   * 3 段血条、总血 300 时：
   *
   * | 血量 | 占比 | 覆盖段数 | 段索引 | 段内填充 |
   * |---|---|---|---|---|
   * | 300 | 1.00 | 3.0 | 2 | 100% |
   * | 250 | 0.83 | 2.5 | 2 | 50%  |
   * | 200 | 0.67 | 2.0 | **1** | 100% |
   * | 150 | 0.50 | 1.5 | 1 | 50%  |
   *
   * 关键是 200 血这一行：它覆盖**满两段**，应该显示在第 2 段（索引 1）且填满，
   * 而不是"进入第 3 段、填充 0%"。后者会让玩家看到三段血条都在，
   * 但第三段是空的——看起来像"还有血"，与直觉相反。
   *
   * 所以用 `ceil(covered) - 1` 而不是 `floor(covered)`。
   */
  get segmentIndex(): number {
    if (this._segments <= 1) return 0;
    const covered = this._display * this._segments;
    // 容差：covered 恰好是整数时，浮点误差不该让它多跳一段
    const idx = Math.ceil(covered - 1e-9) - 1;
    return clamp(idx, 0, this._segments - 1);
  }

  /** 当前段内的填充比例 0~1 */
  get segmentFill(): number {
    if (this._segments <= 1) return this._display;
    const covered = this._display * this._segments;
    return clamp01(covered - this.segmentIndex);
  }

  /**
   * 计算某一段的渲染区间（0~1，相对整条）
   *
   * 【为什么要算这个】
   * 分段血条有两种画法：
   * - 画 N 个独立块（简单，但每块要单独建节点）
   * - 画一条，用空隙贴图遮罩（省节点，但要算准区间）
   *
   * 这个方法给出每段的位置，两种画法都能用。
   */
  segmentBounds(index: number): { start: number; end: number } {
    if (this._segments <= 1) return { start: 0, end: 1 };
    if (index < 0 || index >= this._segments) {
      throw new Error(
        `[ProgressBar] 段索引越界：${index}（共 ${this._segments} 段）`
      );
    }
    const each = 1 / this._segments;
    const gap = each * this._segGap * this._segments;
    const start = index * each + (index === 0 ? 0 : gap / 2);
    const end = (index + 1) * each - (index === this._segments - 1 ? 0 : gap / 2);
    return { start, end };
  }

  // ==================== 输出 ====================

  snapshot(): BarSnapshot {
    return {
      value: this._value,
      ratio: this.ratio,
      displayRatio: this._display,
      trailRatio: this.trailRatio,
      segmentIndex: this.segmentIndex,
      segmentFill: this.segmentFill,
      state: this._state,
    };
  }

  /** 格式化文本（"80 / 100"） */
  text(digits = 0): string {
    const fmt = (n: number) => (digits > 0 ? n.toFixed(digits) : String(Math.round(n)));
    return `${fmt(this._value)} / ${fmt(this._max)}`;
  }

  // ==================== 内部 ====================

  private _clampValue(v: number): number {
    if (!Number.isFinite(v)) {
      throw new Error(`[ProgressBar] 值必须是有限数，收到 ${v}`);
    }
    return clamp(v, this._min, this._max);
  }

  /**
   * 状态判定（带滞回）
   *
   * 【为什么需要滞回】
   * 血线在 25% 上下反复时（比如持续掉血又被小回复拉回），
   * 没有滞回会让血条颜色每帧闪一次，非常刺眼。
   */
  private _computeState(r: number, prev: BarState): BarState {
    if (r <= 0) return 'empty';
    if (r >= 1) return 'full';

    const h = this._hysteresis;
    const wasLow = prev === 'low';
    const lowAt = wasLow ? this._lowThreshold + h : this._lowThreshold;
    if (r <= lowAt) return 'low';

    const wasHigh = prev === 'high';
    const highAt = wasHigh ? this._highThreshold - h : this._highThreshold;
    if (r >= highAt && this._highThreshold < 1) return 'high';

    return 'normal';
  }
}

/**
 * 把进度条画到 [0, width] 像素区间
 *
 * 【抽出来是因为它总被写错】
 * 反向填充（rtl）时是 `width * (1 - ratio)`，
 * 很多人写成 `width - width * ratio` 之后再取绝对值，
 * 结果进度条在负值区间乱跑。
 */
export function fillPixels(ratio: number, width: number, reversed: boolean): number {
  const r = clamp01(ratio);
  return reversed ? lerp(width, 0, r) : lerp(0, width, r);
}
