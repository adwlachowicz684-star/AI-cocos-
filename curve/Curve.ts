/**
 * Curve —— 关键帧曲线
 *
 * 【与 Easing 的区别】
 * - **Easing** 是固定的数学函数（easeInQuad、easeOutBack…），表达"0→1 的变化节奏"
 * - **Curve** 是**任意形状**的曲线：你可以指定 (0, 0) → (0.3, 100) → (1, 50)，
 *   表达"伤害随时间先升后降"这种自定义形状
 *
 * 【典型用途】
 * - 冲刺速度曲线：起步爆发，末端衰减（比匀速自然得多）
 * - 技能伤害窗口：第 10 帧 100% 伤害，其余帧 0
 * - 掉落物抛物线：先上后下
 * - 难度曲线：第 1 层敌人 1.0 倍血量，第 10 层 2.3 倍
 *
 * 【使用示例】
 * ```typescript
 * const dashSpeed = new Curve([
 *   { time: 0,    value: 25 },   // 起步 25 m/s
 *   { time: 0.15, value: 18 },
 *   { time: 0.4,  value: 2  },   // 末端几乎停住
 * ]);
 *
 * dashSpeed.evaluate(0.1);        // 约 20.6（线性插值）
 * dashSpeed.evaluate(0.1, 'smooth'); // 平滑插值
 *
 * // 从配置加载
 * const c = Curve.fromArray([[0,0], [0.5,1], [1,0]]);
 * ```
 *
 * 【无引擎依赖】
 */

import { needCount } from '../_core/guard';

export type InterpMode = 'linear' | 'step' | 'smooth';

export interface Keyframe {
  readonly time: number;
  readonly value: number;
}

/** 用于插值的切线模式（平滑插值时用） */
export type TangentMode = 'auto' | 'linear' | 'flat';

function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class Curve {
  private readonly _keys: { time: number; value: number }[] = [];

  constructor(keys: readonly Keyframe[] = []) {
    for (const k of keys) this.addKey(k.time, k.value);
    this._sort();
  }

  /** 便捷构造：[[time, value], ...] */
  static fromArray(arr: readonly (readonly [number, number])[]): Curve {
    return new Curve(arr.map(([t, v]) => ({ time: t, value: v })));
  }

  /** 常数值曲线 */
  static constant(value: number): Curve {
    return new Curve([{ time: 0, value }]);
  }

  /** 线性 0→1 */
  static linear01(): Curve {
    return new Curve([{ time: 0, value: 0 }, { time: 1, value: 1 }]);
  }

  addKey(time: number, value: number): this {
    if (!Number.isFinite(time) || !Number.isFinite(value)) {
      throw new Error(`[Curve] 关键帧必须是有限数：time=${time} value=${value}`);
    }
    this._keys.push({ time, value });
    this._sort();
    return this;
  }

  private _sort(): void {
    this._keys.sort((a, b) => a.time - b.time);
  }

  get keyCount(): number {
    return this._keys.length;
  }

  /** 曲线的时间范围 */
  get duration(): number {
    if (this._keys.length === 0) return 0;
    return this._keys[this._keys.length - 1].time - this._keys[0].time;
  }

  get startTime(): number {
    return this._keys.length > 0 ? this._keys[0].time : 0;
  }

  get endTime(): number {
    return this._keys.length > 0 ? this._keys[this._keys.length - 1].time : 0;
  }

  /** 最大值 / 最小值（调试与归一化用） */
  get minValue(): number {
    return this._keys.reduce((m, k) => Math.min(m, k.value), Infinity);
  }

  get maxValue(): number {
    return this._keys.reduce((m, k) => Math.max(m, k.value), -Infinity);
  }

  /**
   * 求值
   *
   * @param time 时间（会被 clamp 到曲线范围）
   * @param mode 插值方式
   *
   * 【坑】超出范围时**clamp 而不是抛错**。
   * 动画播放超出一帧、浮点误差导致 time = 1.0000001——
   * 抛错会让游戏在极偶然的情况下崩溃，这是最难复现的一类 bug。
   */
  evaluate(time: number, mode: InterpMode = 'linear'): number {
    const keys = this._keys;
    if (keys.length === 0) return 0;
    if (keys.length === 1) return keys[0].value;

    const t = Math.min(Math.max(time, keys[0].time), keys[keys.length - 1].time);

    // 找到 t 所在的区间
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].time <= t) i++;

    const a = keys[i];
    const b = keys[i + 1];

    if (mode === 'step') return a.value;

    const span = b.time - a.time;
    let u = span <= 1e-9 ? 0 : (t - a.time) / span;

    if (mode === 'smooth') u = smoothStep(clamp01(u));

    return a.value + (b.value - a.value) * u;
  }

  /**
   * 归一化求值（time 传入 0–1，映射到曲线的时间范围）
   *
   * 【用途】"技能播放到 60% 时的伤害倍率是多少"——
   * 调用方不需要知道曲线的具体时间跨度。
   */
  evaluateNormalized(u: number, mode: InterpMode = 'linear'): number {
    const s = this.startTime;
    const e = this.endTime;
    return this.evaluate(s + (e - s) * clamp01(u), mode);
  }

  /** 曲线下的积分（近似）——用于"总位移"之类的计算 */
  integrate(samples = 64, mode: InterpMode = 'linear'): number {
    /**
     * 【⚠️ samples 必须有上界，且不能为 0】
     *
     * 实测 `integrate(Infinity)` → 退出码 124（卡死）。
     * `samples = 0` 也不该允许：`step = (e-s)/0 = Infinity`，
     * 结果是 0 或 NaN，而调用方期待的是积分值。
     *
     * 采样数常来自"按曲线长度自适应"的计算，可能因除零产生 Infinity。
     */
    const n = needCount(samples, 'samples');
    if (n === 0) throw new RangeError('[Curve] samples 必须为正，实际 0');

    if (this._keys.length < 2) return 0;
    const s = this.startTime;
    const e = this.endTime;
    const step = (e - s) / n;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const t = s + step * (i + 0.5);
      sum += this.evaluate(t, mode) * step;
    }
    return sum;
  }

  /** 导出（配置存盘） */
  toKeyframes(): Keyframe[] {
    return this._keys.map((k) => ({ time: k.time, value: k.value }));
  }

  /** 克隆（用于"基于模板改几个值"，避免污染共享曲线） */
  clone(): Curve {
    return new Curve(this.toKeyframes());
  }

  destroy(): void {
    this._keys.length = 0;
  }
}
