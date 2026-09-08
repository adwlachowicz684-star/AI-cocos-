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
import { safeDt, numOr } from '../_core/math';

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

  /**
   * 过冲/下冲系数（1 = 不过冲，1.15 = 冲到 115% 再回落，0.85 = 先只到 85% 再补上）
   *
   * 【为什么 <1 也生效】
   * 旧代码只在 `> 1` 时走特殊分支，于是 0.85 这种"下冲"被静默当成 1（不过冲），
   * 而 JSDoc 只写了"1 = 不过冲"，让人以为 0~1 之间也是合法输入。
   * 现在 `!== 1` 都走同一条插值公式，<1 时前半段只到 os 倍、后半段补到 1，
   * 与 >1 完全对称。
   */
  private _overshoot = 1;

  private readonly _opts: Required<
    Pick<NumberRollerOptions, 'duration' | 'bigDelta' | 'easing' | 'separator' | 'showSign' | 'decimals'>
  >;

  constructor(opts: NumberRollerOptions = {}) {
    // 【为什么配置项要逐个收口，而不是 `?? 默认值` 了事】
    // `??` 只挡 null/undefined，挡不住 NaN。而这几个值一旦是 NaN：
    //   - duration.min = NaN  → _computeDuration 返回 NaN → `_rolling = NaN > 0` 为 false
    //     → **滚动动画静默失效**，数字直接跳到终值（实测 display 从 0 直跳 5000）；
    //   - bigDelta = NaN      → `bigDelta <= 0` 为 false，t = delta / NaN = NaN，同样静默失效；
    //   - decimals = NaN      → `decimals > 0` 为 false，退化成 0 位，配置被无声吞掉。
    // 三者的共同点是"不报错、不告警，只是功能悄悄没了"——排查时没人会怀疑配置对象。
    // 所以这里统一用 numOr 收口，非法值回落到文档默认值。
    const rawDuration = opts.duration;
    const durMin = Math.max(0, numOr(rawDuration?.min, 0.25));
    const durMax = Math.max(0, numOr(rawDuration?.max, 1.0));
    this._opts = {
      // max < min 时（配表填反）按 min 走，避免算出负时长。
      duration: { min: durMin, max: durMax < durMin ? durMin : durMax },
      bigDelta: numOr(opts.bigDelta, 10000),
      easing: opts.easing ?? easeOutCubic,
      separator: opts.separator ?? '',
      showSign: opts.showSign ?? false,
      // 负的 decimals 没有语义（且 `decimals > 0` 判定会静默把它当 0），夹到 0。
      decimals: Math.max(0, numOr(opts.decimals, 0)),
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
    // overshoot 来自调用方（暴击时传 1.15 之类），NaN/负数都要收口：
    // NaN 会让下面 `os + (1 - os) * easing(u)` 整个变成 NaN，
    // 负数则会让 eased 变负，数字先往反方向跑一段再回来——两种都不是"过冲"。
    this._overshoot = Math.max(0, numOr(opts?.overshoot, 1));
    this._duration = this._computeDuration(Math.abs(value - this._from));
    this._rolling = this._duration > 0;

    if (!this._rolling) {
      this._current = value;
    }
  }

  /**
   * 立即到目标（跳过动画）
   *
   * 【为什么这里必须和 set 一样校验】
   * set() 在入口就 throw 掉非有限值，但 snapTo 曾经是"裸写"：
   * 直接把 value 赋给 _current，然后 `_rolling = false`。
   * 而 update() 开头是 `if (!this._rolling) return;`——
   * **写入 NaN 之后再也没有任何路径能把它改回来**，
   * UI 上永久显示 "NaN"，玩家截图投诉，开发去查伤害公式，
   * 实际源头只是这个入口漏了校验（伤害/金币来自服务端返回，偶发 null 是常态）。
   * 口径与 set 保持一致：非法值直接抛，让问题在调用点就暴露。
   */
  snapTo(value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`[NumberRollerCore] 目标值必须是有限数，实际 ${value}`);
    }
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

    // 过冲：先冲过头，再回落（os < 1 时是下冲：先只到 os 倍，后半段补到 1）
    if (this._overshoot !== 1) {
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
    const abs = Math.abs(v);

    // 【为什么要先算"展示值"再决定负号】
    // 旧的写法是 `const neg = v < 0`，于是 -0.4 在 decimals = 0 时会输出 "-0"
    // ——因为 Math.round(0.4) 是 0，负号却已经加上了。
    // 玩家看到血量显示 "-0" 会以为数值系统坏了。
    // 判据应该是"展示出来的这个数是不是 0"，而不是"内部值是不是负数"。
    const shown =
      this._opts.decimals > 0 ? Number(abs.toFixed(this._opts.decimals)) : Math.round(abs);
    const neg = v < 0 && shown > 0;

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
   *
   * 【⚠️ 缩写的小数位数固定为 1，不受 opts.decimals 影响】
   * 这是**故意**的，不是漏配：缩写单位（K/M/B）本身就是"粗略量级"的表达，
   * `1.2M` 比 `1.23M` 更好读，也让列宽稳定。
   * 曾考虑改成跟随 opts.decimals，但默认值 0 会把既有表现从 '1.2K' 变成 '1K'
   * （精度反而不如现在），属于对既有使用方的静默破坏。
   * 需要更精细的缩写时，请自己读 `display` 格式化。
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
