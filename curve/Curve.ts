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

  /** 是否已释放（see `destroy()` 与 `evaluate()` 里的守卫） */
  private _destroyed = false;

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

  /**
   * 最大值 / 最小值（调试与归一化用）
   *
   * 【⚠️ 空曲线返回 0，不返回 ∓Infinity】
   *
   * `reduce(fn, Infinity)` 在空数组上直接返回初始值，
   * 于是空曲线上 `minValue === Infinity`、`maxValue === -Infinity`。
   * 两个值各自都"像是有效数字"，直到被用起来：
   *
   * - 归一化 `(v - min) / (max - min)` → `0 / 0 = NaN`，静默污染整条数据链
   * - 拿它们做 UI 坐标轴范围 → 得到一个 Infinity 轴，画不出任何东西
   *
   * "配置还没加载完就先 new 了一个 Curve" 是很常见的时序，
   * 而这两行既不抛错也不告警。
   *
   * 【为什么返回 0 而不是 undefined】
   * 返回 `number | undefined` 是更诚实的签名，但会让所有调用方多一层判空，
   * 属于 breaking 变更（本批不改对外类型）。0 是"空曲线上唯一无争议的中性值"：
   * 空曲线上 `min === max === 0`，归一化分母为 0 的情形调用方仍需自己挡，
   * 但至少不会拿到 Infinity。
   */
  get minValue(): number {
    if (this._keys.length === 0) return 0;
    return this._keys.reduce((m, k) => Math.min(m, k.value), Infinity);
  }

  get maxValue(): number {
    if (this._keys.length === 0) return 0;
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
    /**
     * 【⚠️ destroy() 之后必须抛错，而不是静默返回 0】
     *
     * README 明确写了"destroy() 之后不能再 evaluate()"，
     * 但实现上 destroy 只做了 `_keys.length = 0`，
     * evaluate 于是走"空曲线返回 0"分支——**文档承诺了不可用，实现却在静默降级**。
     *
     * 静默返回 0 的后果：曲线值突然全变 0，而 0 是一个完全合法的输出值，
     * 没有任何东西能区分"曲线本来就是 0"和"曲线已经被释放了"。
     * 抛错把"用了已释放的曲线"这件事钉在调用点。
     */
    if (this._destroyed) {
      throw new Error('[Curve] 曲线已 destroy()，不能再 evaluate()。如需复用请重新构造或 clone()');
    }

    const keys = this._keys;
    if (keys.length === 0) return 0;

    /**
     * 【⚠️ NaN 必须单独挡，不能指望下面的 clamp】
     *
     * `Math.min(Math.max(NaN, lo), hi)` 的每一步都返回 NaN
     * （NaN 与任何值比较都是 false，`Math.max(NaN, lo)` 仍是 NaN）。
     * 本单元在 `addKey()` 里对关键帧做了 `Number.isFinite` 校验，
     * 却在 `evaluate()` 的入参上漏了——同一个口子只堵了一半。
     *
     * 后果：上游时间轴一旦产出一次 NaN（`t / duration` 且 duration 为 0 是最常见的来源），
     * 返回值变 NaN，接着污染坐标 / 伤害值，
     * **一个 NaN 帧让后续所有帧永久为 NaN**。这类错误没有任何异常，只有一个错误的数。
     *
     * 【为什么只挡 NaN，不挡 ±Infinity】
     * Infinity 有方向：+Inf 明确表示"远超末端"，−Inf 表示"早于起点"，
     * clamp 到对应端点是唯一合理的解释。
     * NaN 没有方向，clamp 到哪个端点都没有依据，
     * 只能按"时间未定义"处理，返回起点值——这是唯一不引入新 NaN 的选择。
     */
    if (Number.isNaN(time)) return keys[0].value;

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

  /** 是否已释放 */
  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   * 释放
   *
   * 【⚠️ 之后不能再 evaluate()】
   * 以前只清了关键帧数组，`evaluate()` 走"空曲线返回 0"分支静默返回 0。
   * 现在置 `_destroyed`，`evaluate()` 会抛错——兑现 README 的承诺。
   */
  destroy(): void {
    this._keys.length = 0;
    this._destroyed = true;
  }
}
