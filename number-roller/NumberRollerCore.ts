/**
 * NumberRollerCore —— 数字滚动的核心逻辑（纯逻辑，无渲染）
 *
 * 【为什么又要拆核心与渲染】
 * 与 JoystickMover 同样的思路：
 * - **核心（本文件）**：从当前显示值滚到目标值，纯数字逻辑 → 可完整单测
 * - **渲染层**：Cocos 组件，每帧读核心的 `display` 写到 Label 上 → 约 30 行
 *
 * 【它解决的关键问题】
 *
 * **问题 1：连续设置值时从哪开始滚**
 * 玩家连续捡金币，100 → 150 → 220。
 * 如果每次都从"上一个目标值"开始，会看到数字跳跃；
 * 正确做法是**从当前显示值继续滚**。
 *
 * **问题 2：大数字的显示**
 * 1234567 要显示成 "1,234,567" 还是 "1.2M"？
 * 这个格式化逻辑和滚动逻辑应该分开，但要有默认实现。
 *
 * **问题 3：滚动速度**
 * 从 10 滚到 10000，固定速度会太慢；
 * 固定时长则小变化显得拖沓。合理做法是时长随差值缩放，但设上下限。
 *
 * 【使用示例】
 * ```typescript
 * const roller = new NumberRollerCore({ duration: { min: 0.3, max: 1.2 } });
 *
 * roller.set(100);            // 目标 100
 * roller.set(250);            // 从当前显示值继续滚到 250（不跳变）
 *
 * // 每帧
 * roller.update(dt);
 * label.string = roller.formatted;
 *
 * // 立即到位（跳过动画）
 * roller.snapTo(999);
 *
 * // 暴击时想让数字先冲过头再回落
 * roller.set(500, { overshoot: 1.15 });
 * ```
 *
 * 【无引擎依赖】
 */
import { safeDt } from '../_core/math';

export interface NumberRollerOptions {
  /**
   * 滚动时长范围（秒）
   * 根据实际差值在此范围内插值：小变化快，大变化慢但不拖沓
   */
  readonly duration?: { min: number; max: number };
  /**
   * 达到多大差值才算"最大时长"
   * 默认 10000（差 10000 以上都用 max 时长）
   */
  readonly bigDelta?: number;
  /** 缓动函数（默认 easeOutCubic） */
  readonly easing?: (t: number) => number;
  /** 千分位分隔符 */
  readonly separator?: string;
  /** 是否显示正负号（用于伤害数字 +100） */
  readonly showSign?: boolean;
  /** 小数位数 */
  readonly decimals?: number;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export class NumberRollerCore {
  private _current = 0;
  private _target = 0;
  private _from = 0;
  private _elapsed = 0;
  private _duration = 0;
  private _rolling = false;

  /** 过冲系数（1 = 不过冲，1.15 = 冲到 115% 再回落） */
  private _overshoot = 1;

  private readonly _opts: Required<
    Pick<NumberRollerOptions, 'duration' | 'bigDelta' | 'easing' | 'separator' | 'showSign' | 'decimals'>
  >;

  constructor(opts: NumberRollerOptions = {}) {
    this._opts = {
      duration: opts.duration ?? { min: 0.25, max: 1.0 },
      bigDelta: opts.bigDelta ?? 10000,
      easing: opts.easing ?? easeOutCubic,
      separator: opts.separator ?? '',
      showSign: opts.showSign ?? false,
      decimals: opts.decimals ?? 0,
    };
  }

  /**
   * 设置目标值
   *
   * 【关键】`_from` 取的是**当前显示值** `_current`，不是上一个目标值。
   * 这正是"连续捡金币不跳变"的实现方式。
   */
  set(value: number, opts?: { overshoot?: number; immediate?: boolean }): void {
    if (!Number.isFinite(value)) {
      throw new Error(`[NumberRollerCore] 目标值必须是有限数，实际 ${value}`);
    }

    if (opts?.immediate) {
      this.snapTo(value);
      return;
    }

    if (Math.abs(value - this._target) < 1e-9 && this._rolling === false) return;

    this._from = this._current;
    this._target = value;
    this._elapsed = 0;
    this._overshoot = opts?.overshoot ?? 1;
    this._duration = this._computeDuration(Math.abs(value - this._from));
    this._rolling = this._duration > 0;

    if (!this._rolling) {
      this._current = value;
    }
  }

  /** 立即到目标（跳过动画） */
  snapTo(value: number): void {
    this._current = value;
    this._target = value;
    this._from = value;
    this._elapsed = 0;
    this._duration = 0;
    this._rolling = false;
  }

  private _computeDuration(delta: number): number {
    const { min, max } = this._opts.duration;
    if (this._opts.bigDelta <= 0) return min;
    const t = Math.min(1, delta / this._opts.bigDelta);
    return min + (max - min) * t;
  }

  /** 每帧推进 */
  update(dt: number): void {
    if (!this._rolling) return;

    // 【为什么不是提前 return】_current 是本帧的显示值，
    // 即使 dt 异常，也应保持上一次的值而不是整个方法跳过。
    this._elapsed += safeDt(dt) ? dt : 0;
    const t = this._duration <= 0 ? 1 : Math.min(1, this._elapsed / this._duration);

    let eased = this._opts.easing(t);

    // 过冲：先冲过头，再回落
    if (this._overshoot > 1) {
      const os = this._overshoot;
      // 前半段冲到 os 倍，后半段回到 1
      if (t < 0.6) {
        eased = this._opts.easing(t / 0.6) * os;
      } else {
        const u = (t - 0.6) / 0.4;
        eased = os + (1 - os) * this._opts.easing(u);
      }
    }

    this._current = this._from + (this._target - this._from) * eased;

    if (t >= 1) {
      this._current = this._target;
      this._rolling = false;
    }
  }

  /** 当前显示值（可能带小数，渲染前用 formatted） */
  get display(): number {
    return this._current;
  }

  /** 取整后的显示值 */
  get displayInt(): number {
    return Math.round(this._current);
  }

  get target(): number {
    return this._target;
  }

  get isRolling(): boolean {
    return this._rolling;
  }

  /**
   * 格式化后的字符串（直接写进 Label）
   *
   * 【坑】负数与千分位：
   * -1234567 应显示 "-1,234,567" 而不是 "-,1234,567"
   */
  get formatted(): string {
    const v = this._current;
    const neg = v < 0;
    const abs = Math.abs(v);

    let body: string;
    if (this._opts.decimals > 0) {
      body = abs.toFixed(this._opts.decimals);
      const parts = body.split('.');
      parts[0] = this._groupDigits(parts[0]);
      body = parts.join('.');
    } else {
      body = this._groupDigits(String(Math.round(abs)));
    }

    if (neg) return '-' + body;
    return this._opts.showSign && v > 0 ? '+' + body : body;
  }

  private _groupDigits(s: string): string {
    const sep = this._opts.separator;
    if (!sep) return s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += sep;
      out += s[i];
    }
    return out;
  }

  /**
   * 大数字缩写（1.2K / 3.4M）
   *
   * 【阈值为什么是 1000】
   * 游戏里的通行做法是从 1K 开始缩写：1234 → "1.2K"。
   * 设成 10000 的话 1234~9999 会显示一长串数字，UI 放不下。
   *
   * 【为什么需要】
   * 肉鸽后期伤害是几十万，全写出来 UI 放不下。
   * 而且"1,234,567"这种长数字玩家根本不会读，缩写反而更易读。
   */
  get abbreviated(): string {
    const v = this._current;
    const neg = v < 0;
    const abs = Math.abs(v);

    let body: string;
    if (abs >= 1e9) body = (abs / 1e9).toFixed(1) + 'B';
    else if (abs >= 1e6) body = (abs / 1e6).toFixed(1) + 'M';
    else if (abs >= 1e3) body = (abs / 1e3).toFixed(1) + 'K';
    else body = String(Math.round(abs));

    return neg ? '-' + body : body;
  }

  reset(): void {
    this._current = 0;
    this._target = 0;
    this._from = 0;
    this._elapsed = 0;
    this._duration = 0;
    this._rolling = false;
  }

  destroy(): void {
    this.reset();
  }
}
