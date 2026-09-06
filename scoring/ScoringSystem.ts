import { numOr } from '../_core/math';
/**
 * scoring/ScoringSystem.ts —— 战斗评分与评级
 *
 * 【它解决什么】
 *
 * 打完一场给个评价：S / A / B / C / D。
 *
 * 听起来只是个结算界面，但它的作用远不止展示：
 *
 * 1. **给玩家目标**：不只是"打赢"，而是"打得漂亮"
 * 2. **教学**：玩家看到"受伤 -20 分"，自然学会去躲
 * 3. **重玩动力**：S 评级是肉鸽/动作游戏最有效的重复挑战钩子
 * 4. **平衡诊断**：如果全场玩家都拿 D，说明难度设计有问题
 *
 * 【核心难点：指标方向不统一】
 *
 * | 指标 | 方向 | 问题 |
 * |---|---|---|
 * | 通关时间 | **越低越好** | 和"得分越高越好"相反 |
 * | 受伤次数 | **越低越好** | 同上 |
 * | 连击数 | 越高越好 | — |
 * | 命中率 | 越高越好 | 但要处理 0/0 |
 *
 * 最常见的 bug 就是把 lower-better 的指标按 higher-better 算，
 * 结果"打得越快分越低"——而且**不会报错**，只是玩家觉得评级莫名其妙。
 *
 * 本模块用 `direction: 'lower-better' | 'higher-better'` 显式声明，
 * 并在测试里锁定方向。
 *
 * 【零业务依赖】
 *
 * 它不认识"击杀""连击""受伤"。
 * 指标只是 `{ id, value }`，含义由业务定义。
 */

// ============================================================
// 数据结构
// ============================================================

/** 指标方向 */
export type MetricDirection =
  /** 数值越小越好（用时、受伤次数） */
  | 'lower-better'
  /** 数值越大越好（击杀数、连击数） */
  | 'higher-better';

/** 指标定义 */
export interface MetricDef {
  readonly id: string;
  /** 方向（**必须显式声明**，见上面的说明） */
  readonly direction: MetricDirection;
  /**
   * 满分线：达到这个值得满分
   *
   * 【lower-better】低于或等于它得满分（如 60 秒内）
   * 【higher-better】高于或等于它得满分（如 50 连击）
   */
  readonly par: number;
  /**
   * 零分线：差到这个程度得 0 分
   *
   * 【⚠️ lower-better 时它必须 > par】
   * 写反会导致得分恒为 0 或恒为满分，且**不报错**。
   * 构造时会校验。
   */
  readonly zero: number;
  /**
   * 权重（默认 1）
   *
   * 【用途】"击杀数"权重高、"拾取金币"权重低
   */
  readonly weight?: number;
  /**
   * 归一化曲线（默认 'linear'）
   *
   * - `linear`：均匀
   * - `ease-out`：接近满分线时变难（**推荐用于时间**——
   *   从 120s 优化到 90s 容易，从 65s 优化到 60s 难）
   * - `ease-in`：刚开始就很难拿分
   */
  readonly curve?: 'linear' | 'ease-out' | 'ease-in';
  readonly title?: string;
}

/** 指标原始值 */
export interface MetricValue {
  readonly id: string;
  readonly value: number;
}

/** 单个指标的评分结果 */
export interface MetricScore {
  readonly id: string;
  readonly raw: number;
  /** 归一化到 0~1 */
  readonly normalized: number;
  /** 乘以权重后的得分 */
  readonly score: number;
  readonly weight: number;
}

/** 评级 */
export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

/** 评分结果 */
export interface ScoreResult {
  /** 总分（0~100） */
  readonly total: number;
  readonly grade: Grade;
  /** 各指标明细（按得分降序） */
  readonly metrics: readonly MetricScore[];
  /** 每项距离满分还差多少（用于 UI 提示"再快 8 秒就是 S"） */
  readonly gaps: Readonly<Record<string, number>>;
}

// ============================================================
// 配置
// ============================================================

export interface ScoringOptions {
  readonly metrics: readonly MetricDef[];
  /**
   * 评级阈值（降序）。默认 S=90, A=75, B=60, C=40, D=0
   *
   * 【怎么定】
   * 用真实玩家数据校准，别拍脑袋。
   * 如果 80% 的玩家都拿 S，评级就没有意义了。
   */
  readonly gradeThresholds?: Readonly<Record<Exclude<Grade, 'D'>, number>>;
  /**
   * 缺项指标的处理（默认 'skip'）
   *
   * - `'skip'`：忽略该指标，总分按剩余权重归一化
   *   （一场没有"受伤"数据的战斗不该因此扣分）
   * - `'zero'`：记 0 分
   *
   * 【推荐 skip】
   * 不同关卡的可用指标往往不同（Boss 战没有"击杀数"），
   * 用 zero 会让没法刷击杀的关卡天然低分。
   */
  readonly missingAs?: 'skip' | 'zero';
}

// ============================================================
// 归一化
// ============================================================

/**
 * 把原始值归一化到 0~1
 *
 * 【lower-better】
 * ```
 * value <= par  → 1.0
 * value >= zero → 0.0
 * 中间          → (zero - value) / (zero - par)
 * ```
 *
 * 【higher-better】
 * ```
 * value >= par  → 1.0
 * value <= zero → 0.0
 * 中间          → (value - zero) / (par - zero)
 * ```
 */
export function normalize(def: MetricDef, raw: number): number {
  const span = def.direction === 'lower-better'
    ? def.zero - def.par
    : def.par - def.zero;

  // span <= 0 说明配置写反了 —— 构造时已校验，这里是运行时兜底
  if (!(span > 0)) return raw >= def.par ? 1 : 0;

  let t: number;
  if (def.direction === 'lower-better') {
    if (raw <= def.par) return 1;
    if (raw >= def.zero) return 0;
    t = (def.zero - raw) / span;
  } else {
    if (raw >= def.par) return 1;
    if (raw <= def.zero) return 0;
    t = (raw - def.zero) / span;
  }

  // 曲线
  const curve = def.curve ?? 'linear';
  if (curve === 'ease-out') {
    // t=0.5 → 0.75：越接近满分越难
    t = 1 - (1 - t) * (1 - t);
  } else if (curve === 'ease-in') {
    t = t * t;
  }

  return Math.max(0, Math.min(1, t));
}

/** 距离满分还差多少原始值（0 表示已达满分） */
export function gapToPerfect(def: MetricDef, raw: number): number {
  if (def.direction === 'lower-better') {
    return raw <= def.par ? 0 : raw - def.par;
  }
  return raw >= def.par ? 0 : def.par - raw;
}

// ============================================================
// 评级
// ============================================================

export const DEFAULT_THRESHOLDS: Readonly<Record<Exclude<Grade, 'D'>, number>> = {
  S: 90,
  A: 75,
  B: 60,
  C: 40,
};

export function gradeOf(total: number, thresholds = DEFAULT_THRESHOLDS): Grade {
  if (total >= thresholds.S) return 'S';
  if (total >= thresholds.A) return 'A';
  if (total >= thresholds.B) return 'B';
  if (total >= thresholds.C) return 'C';
  return 'D';
}

/**
 * 距离下一级还差多少分（已是 S 返回 0）
 *
 * 【用途】结算界面显示"距离 A 级还差 7 分"——
 * 它把抽象的评级变成了具体的、可追赶的目标。
 */
export function toNextGrade(total: number, thresholds = DEFAULT_THRESHOLDS): number {
  const g = gradeOf(total, thresholds);
  switch (g) {
    case 'S': return 0;
    case 'A': return Math.max(0, thresholds.S - total);
    case 'B': return Math.max(0, thresholds.A - total);
    case 'C': return Math.max(0, thresholds.B - total);
    case 'D': return Math.max(0, thresholds.C - total);
  }
}

// ============================================================
// 实现
// ============================================================

export class ScoringSystem {
  private readonly _defs = new Map<string, MetricDef>();
  private readonly _order: string[] = [];
  private readonly _thresholds: Readonly<Record<Exclude<Grade, 'D'>, number>>;
  private readonly _missingAs: 'skip' | 'zero';

  constructor(opts: ScoringOptions) {
    this._thresholds = opts.gradeThresholds ?? DEFAULT_THRESHOLDS;
    this._missingAs = opts.missingAs ?? 'skip';

    for (const d of opts.metrics) {
      if (this._defs.has(d.id)) {
        throw new Error(`[Scoring] 指标 id 重复：${d.id}`);
      }
      /**
       * 【⚠️ 校验 par / zero 的方向】
       *
       * 这是本模块最容易配错的地方，而且错得**很安静**：
       *
       * ```
       * // 时间：越低越好，par=60（60秒满分），zero 应该 > 60
       * { id: 'time', direction: 'lower-better', par: 60, zero: 30 }  // ← 写反了
       * ```
       *
       * 写反后 span = 30 - 60 = -30，
       * 兜底逻辑会让"60 秒"和"5 秒"都得 0 分——
       * 玩家会发现"我打得飞快却拿 D"，而代码不报任何错。
       *
       * 所以构造时立即抛错。
       */
      const span = d.direction === 'lower-better' ? d.zero - d.par : d.par - d.zero;
      if (!(span > 0)) {
        throw new Error(
          `[Scoring] 指标 "${d.id}" 的 par/zero 方向写反了：` +
          `${d.direction === 'lower-better' ? 'lower-better 要求 zero > par' : 'higher-better 要求 par > zero'}，` +
          `实际 par=${d.par}, zero=${d.zero}`
        );
      }
      /**
       * 【为什么不能只写 `(d.weight ?? 1) < 0`】
       *
       * `NaN < 0` 是 false，`Infinity < 0` 也是 false——
       * 所以这行**看起来**校验了权重，实际上 NaN 和 Infinity 全部放行。
       *
       * 放行之后运行期有一处 `numOr(def.weight, 1)` 兜底，
       * 会把 NaN 静默改成 1。于是：
       *
       *   weight: total / count     // count 为 0 → NaN
       *     → 构造不报错
       *     → 运行期按 weight=1 参与计分
       *     → 总分看起来完全正常，但权重结构已经不对了
       *
       * 这是**静默改配置**：用户以为自己配的权重生效了，
       * 实际拿到的是兜底值。比直接报错难查得多
       * （症状是"这个指标好像影响比分弱一点"，没人会想到权重坏了）。
       *
       * 这里显式要求"有限且非负"，把坏配置钉在构造期。
       */
      const w0 = d.weight ?? 1;
      if (!Number.isFinite(w0) || w0 < 0) {
        throw new Error(
          `[Scoring] 指标 "${d.id}" 的权重必须为非负有限数，实际 ${d.weight}` +
            `（NaN 通常是"动态计算权重时除零"的结果）`
        );
      }
      this._defs.set(d.id, d);
      this._order.push(d.id);
    }
  }

  get metricCount(): number {
    return this._defs.size;
  }

  /**
   * 评分
   *
   * @param values 各指标的原始值。缺失的指标按 `missingAs` 处理
   */
  evaluate(values: readonly MetricValue[]): ScoreResult {
    const provided = new Map<string, number>();
    for (const v of values) provided.set(v.id, v.value);

    const scores: MetricScore[] = [];
    const gaps: Record<string, number> = {};

    let weighted = 0;
    let totalWeight = 0;

    for (const id of this._order) {
      const def = this._defs.get(id)!;
      const w = Math.max(0, numOr(def.weight, 1));
      const has = provided.has(id);

      if (!has && this._missingAs === 'skip') {
        continue;   // 跳过，不计入总权重
      }

      const raw = has ? provided.get(id)! : def.zero;
      const n = normalize(def, raw);

      totalWeight += w;
      weighted += n * w;

      scores.push({ id, raw, normalized: n, score: n * w, weight: w });
      gaps[id] = gapToPerfect(def, raw);
    }

    /**
     * 【为什么除以 totalWeight 而不是配置的总权重】
     *
     * 用 skip 模式时，不同场次参与评分的指标可能不同
     * （Boss 战没有"击杀数"）。
     * 如果除以固定的配置总权重，
     * 缺项的场次会**天然低分**——
     * 玩家会困惑"为什么我打得很好却只有 B"。
     *
     * 按实际参与权重归一化，各场次之间才可比。
     */
    const total = totalWeight > 0 ? (weighted / totalWeight) * 100 : 0;

    scores.sort((a, b) => b.score - a.score);

    return {
      total,
      grade: gradeOf(total, this._thresholds),
      metrics: scores,
      gaps,
    };
  }

  /** 便捷：直接算总分 */
  score(values: readonly MetricValue[]): number {
    return this.evaluate(values).total;
  }

  /** 便捷：直接算评级 */
  grade(values: readonly MetricValue[]): Grade {
    return this.evaluate(values).grade;
  }

  /**
   * 诊断：哪些指标拖后腿
   *
   * 【用途】结算界面提示"再快 12 秒就能拿 S"——
   * 比干巴巴的"B 级"有用得多，它告诉玩家**该改什么**。
   */
  weakPoints(values: readonly MetricValue[], limit = 3): Array<{ id: string; normalized: number; gap: number }> {
    const r = this.evaluate(values);
    return r.metrics
      .filter((m) => m.normalized < 1)
      .sort((a, b) => a.normalized - b.normalized)
      .slice(0, limit)
      .map((m) => ({ id: m.id, normalized: m.normalized, gap: r.gaps[m.id] ?? 0 }));
  }

  /**
   * 批量统计（平衡用）
   *
   * 【用途】跑 1000 场模拟，看评级分布。
   * 如果 60% 都是 S → 阈值太松；如果 70% 都是 D → 太紧。
   */
  distribution(results: readonly number[]): Record<Grade, number> & { avg: number } {
    const out: Record<Grade, number> & { avg: number } = { S: 0, A: 0, B: 0, C: 0, D: 0, avg: 0 };
    let sum = 0;
    for (const t of results) {
      out[gradeOf(t, this._thresholds)]++;
      sum += t;
    }
    out.avg = results.length > 0 ? sum / results.length : 0;
    return out;
  }
}

// ============================================================
// 预设：动作游戏战斗结算
// ============================================================

/**
 * 常见战斗评分配置
 *
 * 【设计说明】
 * - `time` 用 ease-out：从 120s 优化到 90s 容易，从 65s 优化到 60s 难
 * - `damageTaken` 权重最高：鼓励玩家去学躲，而不是堆输出硬吃
 * - `maxCombo` 用 higher-better，par 设得较高（只有真正会连招的才满分）
 */
export const CombatMetrics: readonly MetricDef[] = [
  {
    id: 'time',
    direction: 'lower-better',
    par: 60,
    zero: 180,
    weight: 1,
    curve: 'ease-out',
    title: '通关时间',
  },
  {
    id: 'damageTaken',
    direction: 'lower-better',
    par: 0,
    zero: 300,
    weight: 3,
    title: '受到伤害',
  },
  {
    id: 'maxCombo',
    direction: 'higher-better',
    par: 30,
    zero: 0,
    weight: 2,
    title: '最高连击',
  },
  {
    id: 'kills',
    direction: 'higher-better',
    par: 40,
    zero: 0,
    weight: 1,
    title: '击杀数',
  },
];
