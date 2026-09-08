/**
 * score/ScoreSystem.ts —— 战斗评分与评级
 *
 * 【它解决什么】
 *
 * "你赢了"和"你打得漂亮"是两件事。
 * 评级系统让后者可见，这是玩家反复挑战的核心动力。
 *
 * 设计良好的评级能：
 * - 给高手一个超越"通关"的目标（S 评级）
 * - 给新手一个明确的进步方向（"这次少挨点打就能拿 A"）
 * - 让重复刷同一关卡有新鲜感
 *
 * 【本模块的核心设计：多维度加权】
 *
 * 单一维度（只看时间）会导致玩法单一化——
 * 玩家只会速通，不会去研究连招或探索。
 *
 * 典型维度：
 *
 * | 维度 | 鼓励什么 |
 * |---|---|
 * 时间 | 效率 |
 * 受伤 | 技巧、走位 |
 * 连击 | 进攻性、熟练度 |
 * 击杀 | 不跳过战斗（反面：鼓励速通） |
 * 探索 | 探索地图（与"时间"天然冲突，需要权衡） |
 *
 * 【零业务依赖】
 *
 * 它不认识"连击""爆头"。
 * 指标是开放的命名数值，评级阈值是配置表。
 */

import { clamp, clamp01, numOr, safeDt, inverseLerp } from '../_core/math';

// ============================================================
// 数据结构
// ============================================================

/**
 * 指标方向
 *
 * - `'lower-better'`：越小越好（时间、受伤次数）
 * - `'higher-better'`：越大越好（连击、击杀数）
 */
export type MetricDirection = 'lower-better' | 'higher-better';

export interface MetricDef {
  readonly id: string;
  readonly direction: MetricDirection;
  /** 权重（参与总分计算） */
  readonly weight: number;
  /**
   * 及格线：达到这个值算 100 分
   *
   * 【语义】
   * - lower-better：≤ par 得满分，越大越差
   * - higher-better：≥ par 得满分，越小越差
   */
  readonly par: number;
  /**
   * 零分线：差到这个值算 0 分
   *
   * 【为什么需要】
   * 只有 par 的话，"超了 par 一点点"和"超了 10 倍"没区别，
   * 评级会失去区分度。
   */
  readonly zero: number;
  /**
   * 是否允许超出 100 分（超额奖励）。默认 true
   *
   * 【用途】"时间比 par 快一倍"应该给额外分。
   * 关掉则封顶 100。
   */
  readonly allowOvershoot?: boolean;
  /** 超额上限（allowOvershoot 时）。默认 150 */
  readonly maxScore?: number;
}

export interface GradeDef {
  readonly id: string;
  /** UI 名称 */
  readonly name?: string;
  /** 达到这个总分（0~100+）即可获得 */
  readonly minScore: number;
  /** 业务数据（奖励倍率、解锁条件等） */
  readonly data?: unknown;
}

// ============================================================
// 配置
// ============================================================

export interface ScoreSystemOptions {
  readonly metrics: readonly MetricDef[];
  /**
   * 评级表。**必须按 minScore 降序排列**
   *
   * 【为什么要求排序】
   * 不排序的话实现要做一次排序，
   * 而配置里的顺序本身就是一种文档——
   * 要求排序能让"哪个评级更高"一眼看明白。
   */
  readonly grades: readonly GradeDef[];
  /**
   * 评级方式
   *
   * - `'weighted'`（默认）：加权平均
   * - `'minimum'`：取最低分（木桶效应，硬核）
   * - `'weighted-with-floor'`：加权平均，但任一维度低于 floor 则降级
   */
  mode?: 'weighted' | 'minimum' | 'weighted-with-floor';
  /**
   * `weighted-with-floor` 模式的地板值。默认 20
   *
   * 任一维度低于它就封顶为最低评级。
   * 【用途】"时间满分但死了 20 次"不该拿 S
   */
  floor?: number;
  onGrade?: (grade: GradeDef, score: number, breakdown: MetricScore[]) => void;
}

/** 单个指标的得分 */
export interface MetricScore {
  readonly id: string;
  readonly raw: number;
  readonly score: number;
  readonly weight: number;
}

// ============================================================
// 默认评级
// ============================================================

export const DEFAULT_GRADES: readonly GradeDef[] = [
  { id: 'S', name: '完美', minScore: 95 },
  { id: 'A', name: '优秀', minScore: 80 },
  { id: 'B', name: '良好', minScore: 60 },
  { id: 'C', name: '及格', minScore: 40 },
  { id: 'D', name: '勉强', minScore: 0 },
];

// ============================================================
// 实现
// ============================================================

export class ScoreSystem {
  private readonly _metrics = new Map<string, MetricDef>();
  private readonly _order: string[] = [];
  private readonly _grades: readonly GradeDef[];
  private readonly _mode: 'weighted' | 'minimum' | 'weighted-with-floor';
  private readonly _floor: number;
  private readonly _values = new Map<string, number>();
  onGrade?: (grade: GradeDef, score: number, breakdown: MetricScore[]) => void;

  constructor(opts: ScoreSystemOptions) {
    if (opts.grades.length === 0) throw new Error('[Score] 至少需要一个评级');

    for (const m of opts.metrics) {
      if (this._metrics.has(m.id)) throw new Error(`[Score] 指标 id 重复：${m.id}`);
      if (m.weight < 0) throw new Error(`[Score] 指标 ${m.id} 的权重不能为负`);
      if (m.direction === 'lower-better' && m.zero <= m.par) {
        throw new Error(
          `[Score] 指标 ${m.id} 是 lower-better，zero(${m.zero}) 必须大于 par(${m.par})`
        );
      }
      if (m.direction === 'higher-better' && m.zero >= m.par) {
        throw new Error(
          `[Score] 指标 ${m.id} 是 higher-better，zero(${m.zero}) 必须小于 par(${m.par})`
        );
      }
      this._metrics.set(m.id, m);
      this._order.push(m.id);
      this._values.set(m.id, m.direction === 'higher-better' ? 0 : m.zero);
    }

    // 【校验排序】配置顺序错了是常见笔误，现在就报
    for (let i = 1; i < opts.grades.length; i++) {
      if (opts.grades[i].minScore >= opts.grades[i - 1].minScore) {
        throw new Error(
          `[Score] 评级表必须按 minScore 降序：` +
          `"${opts.grades[i - 1].id}"(${opts.grades[i - 1].minScore}) 应大于 ` +
          `"${opts.grades[i].id}"(${opts.grades[i].minScore})`
        );
      }
    }
    this._grades = opts.grades;
    this._mode = opts.mode ?? 'weighted';
    this._floor = Math.max(0, numOr(opts.floor, 20));
    this.onGrade = opts.onGrade;
  }

  // ---- 录入 ----

  set(id: string, value: number): void {
    if (!this._metrics.has(id)) {
      throw new Error(`[Score] 未定义的指标：${id}（已定义：${this._order.join(', ')}）`);
    }
    this._values.set(id, value);
  }

  add(id: string, delta: number): void {
    this.set(id, (this._values.get(id) ?? 0) + delta);
  }

  get(id: string): number {
    return this._values.get(id) ?? 0;
  }

  reset(): void {
    for (const id of this._order) {
      const m = this._metrics.get(id)!;
      this._values.set(id, m.direction === 'higher-better' ? 0 : m.zero);
    }
  }

  /** 从某个时间点开始计时（用于"用时"指标） */
  private _startTime = 0;

  startTimer(): void {
    this._startTime = 0;
  }

  /** 累加计时（外部传 dt） */
  tick(dt: number): void {
    // 【为什么不是 dt > 0】Infinity > 0 为 true，计时直接变 Infinity，
    // 之后的用时统计永远算不出有效值。
    if (safeDt(dt)) this._startTime += dt;
  }

  get elapsed(): number {
    return this._startTime;
  }

  // ---- 计算 ----

  /** 各指标得分明细 */
  breakdown(): MetricScore[] {
    const out: MetricScore[] = [];
    for (const id of this._order) {
      const m = this._metrics.get(id)!;
      const raw = this._values.get(id) ?? 0;
      out.push({ id, raw, score: this._scoreOne(m, raw), weight: m.weight });
    }
    return out;
  }

  /** 总分（0~100+，可能超过 100） */
  total(): number {
    const parts = this.breakdown();
    if (parts.length === 0) return 0;

    if (this._mode === 'minimum') {
      let min = Infinity;
      for (const p of parts) if (p.score < min) min = p.score;
      return min === Infinity ? 0 : min;
    }

    let sum = 0;
    let w = 0;
    for (const p of parts) {
      sum += p.score * p.weight;
      w += p.weight;
    }
    const avg = w > 0 ? sum / w : 0;

    if (this._mode === 'weighted-with-floor') {
      for (const p of parts) {
        if (p.score < this._floor) {
          // 木桶效应：任一维度太差则封顶为最低评级
          return Math.min(avg, this._grades[this._grades.length - 1].minScore);
        }
      }
    }
    return avg;
  }

  /** 评级 */
  grade(): GradeDef {
    const s = this.total();
    for (const g of this._grades) {
      if (s >= g.minScore) return g;
    }
    return this._grades[this._grades.length - 1];
  }

  /**
   * 结算
   *
   * @returns 评级、总分、明细；并触发 onGrade
   */
  settle(): { grade: GradeDef; score: number; breakdown: MetricScore[] } {
    const parts = this.breakdown();
    const score = this.total();
    const g = this.grade();
    this.onGrade?.(g, score, parts);
    return { grade: g, score, breakdown: parts };
  }

  /** 距离下一个评级还差多少（UI 显示"再快 5 秒就是 S"） */
  toNextGrade(): { next: GradeDef; need: number } | null {
    const s = this.total();
    const cur = this.grade();
    const idx = this._grades.findIndex((g) => g.id === cur.id);
    if (idx <= 0) return null;    // 已是最高级
    const next = this._grades[idx - 1];
    return { next, need: Math.max(0, next.minScore - s) };
  }

  // ---- 内部 ----

  private _scoreOne(m: MetricDef, raw: number): number {
    const t = inverseLerp(m.zero, m.par, raw);   // par 处 = 1，zero 处 = 0
    let s: number;

    if (m.direction === 'higher-better') {
      s = clamp01(t) * 100;
    } else {
      s = clamp01(t) * 100;
    }

    // 超额：越过 par 之后继续加分
    const overshoot = m.allowOvershoot !== false;
    if (overshoot && t > 1) {
      const cap = m.maxScore ?? 150;
      const extra = (t - 1) * 50;    // 每超过 par 100% 加 50 分
      s = Math.min(cap, 100 + Math.max(0, extra));
    }

    return clamp(s, 0, m.allowOvershoot === false ? 100 : m.maxScore ?? 150);
  }
}

// ============================================================
// 预设指标
// ============================================================

export const Metrics = {
  /** 用时（秒）。par = 目标时间，zero = 容忍上限 */
  time: (par: number, zero: number, weight = 1): MetricDef => ({
    id: 'time', direction: 'lower-better', weight, par, zero,
  }),

  /** 受伤次数。par=0（无伤满分），zero=5 次 */
  damage: (zeroAt = 5, weight = 1.5): MetricDef => ({
    id: 'damage', direction: 'lower-better', weight, par: 0, zero: zeroAt,
  }),

  /** 最大连击。par = 目标连击数 */
  combo: (par: number, weight = 1): MetricDef => ({
    id: 'combo', direction: 'higher-better', weight, par, zero: 0,
  }),

  /** 击杀数 */
  kills: (par: number, weight = 0.5): MetricDef => ({
    id: 'kills', direction: 'higher-better', weight, par, zero: 0,
  }),

  /** 剩余血量比例（0~1） */
  hpLeft: (weight = 1): MetricDef => ({
    id: 'hpLeft', direction: 'higher-better', weight, par: 1, zero: 0,
  }),

  /** 探索度（0~1） */
  exploration: (weight = 0.5): MetricDef => ({
    id: 'exploration', direction: 'higher-better', weight, par: 1, zero: 0,
  }),
};

/**
 * 星级评价（休闲游戏常用）
 *
 * 【和字母评级的区别】
 * 星级是"达成几个条件"，字母是"加权总分"。
 * 星级更适合玩家一眼看懂，字母更适合表达细腻差距。
 */
export class StarRating {
  private readonly _conditions: Array<(ctx: unknown) => boolean> = [];
  private readonly _stars: number;

  constructor(stars: number) {
    this._stars = Math.max(1, stars);
  }

  addCondition(fn: (ctx: unknown) => boolean): this {
    if (this._conditions.length >= this._stars) {
      throw new Error(`[StarRating] 最多 ${this._stars} 个条件`);
    }
    this._conditions.push(fn);
    return this;
  }

  evaluate(ctx: unknown): number {
    let n = 0;
    for (const c of this._conditions) if (c(ctx)) n++;
    return n;
  }

  get max(): number {
    return this._stars;
  }
}
