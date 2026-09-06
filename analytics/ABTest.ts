/**
 * analytics/ABTest.ts —— A/B 实验与统计显著性
 *
 * 【它解决什么】
 *
 * 改了匹配算法，留存从 42% 变成 43.5%。这是真的提升了吗？
 *
 * 大部分人凭直觉判断："涨了就是涨了"。
 * 但 1.5 个百分点的差异，在 1 万样本下可能纯属噪声——
 * 你上线了一个其实没用的改动，还以为自己优化成功了。
 *
 * 这个模块解决四件事：
 *
 * 1. **稳定分组**
 *    同一个用户每次刷新都必须落到同一组，
 *    否则他今天看到 A 明天看到 B，数据全废。
 *
 * 2. **实验间独立**
 *    ⚠️ 这是最容易被忽略的。
 *    不用 salt 的话，被分到 A 组的用户在**所有实验**里都是 A 组。
 *    这些用户会持续累积"实验组体验"，行为被系统性改变，
 *    实验之间互相污染，结论全部不可信。
 *
 * 3. **显著性检验**
 *    给出 p 值，告诉你"这个差异是噪声的概率有多大"。
 *
 * 4. **样本量预判**
 *    开实验之前就算好"要跑多久才可能有结论"，
 *    避免跑了两周才发现样本量根本不够。
 *
 * 【⚠️ 本模块的立场】
 *
 * **样本不足时，一律判定为"不显著"。**
 *
 * 小样本极其容易出现假阳性：10 个用户里 A 组 1/5 转化、B 组 4/5 转化，
 * 看起来是 20% vs 80% 的巨大差异，但只有 5+5 个样本，
 * 完全可能是运气。所以 `isSignificant` 用 `minSamples` 硬拦。
 *
 * 另一个重点是描述文案："不显著"**不等于**"没有提升"。
 * 这是 A/B 测试最常被误读的地方，
 * 所以在 `describeResult` 里显式写出来了。
 *
 * 【零业务依赖】
 */

import { clamp } from '../_core/math';

// ==================== 类型 ====================

export interface ExperimentConfig {
  readonly name: string;
  /** 实验组占比 0~100（默认 50） */
  readonly treatmentPercent?: number;
}

export type Variant = 'control' | 'treatment';

export interface Stats {
  readonly n: number;
  readonly conversions: number;
  /** 数值指标之和 */
  readonly sum: number;
  /** 数值指标平方和 */
  readonly sumSq: number;
}

export interface ZTestResult {
  readonly z: number;
  /** 双尾 p 值 */
  readonly p: number;
  /**
   * 相对提升（treatment 相对 control）
   *
   * 0.5 表示"提升了 50%"，-0.2 表示"下降了 20%"
   */
  readonly lift: number;
}

export interface ExperimentResult extends ZTestResult {
  readonly name: string;
  readonly control: Stats;
  readonly treatment: Stats;
  readonly significant: boolean;
  /** 样本量是否不足（不足时 significant 恒为 false） */
  readonly underpowered: boolean;
  /** 判定 underpowered 所用的门槛（展示用） */
  readonly minSamples: number;
}

export interface BalanceReport {
  readonly control: number;
  readonly treatment: number;
  /** 两组人数差占总人数的比例 */
  readonly skew: number;
  readonly ok: boolean;
}

// ==================== 分桶 ====================

/**
 * FNV-1a 32 位哈希 + murmur3 finalizer
 *
 * 【为什么用它】
 * - 无依赖（不用 crypto）
 * - 对短字符串分布均匀
 * - 各平台结果一致（同一个用户在不同服务器上同组）
 *
 * 【⚠️ 为什么必须有 finalizer】
 *
 * 裸的 FNV-1a 雪崩性不足：**输入的微小差异会留在高位**。
 * 分桶取的是 `h % 100`，而取模对高位差异不敏感——
 * 结果就是"只差一个字符的两个输入"会分到同一个桶。
 *
 * 实测（2 万个 id，只换 salt）：
 *
 * ```
 * 无 finalizer：expA vs expB 重合率 35.6%   ← 期望 50%
 *               expA vs expC 重合率 24.0%   ← 差得更远
 *               expB vs expC 重合率 64.2%
 * 有 finalizer：各对稳定在 49~51%
 * ```
 *
 * 后果很具体：两个"互相独立"的实验，分组却有 64% 重合，
 * 于是同一批用户在所有实验里都在实验组，
 * 他们的行为被系统性改变——**实验间互相污染，结论全部不可信**。
 *
 * 而且这不是随机波动：样本量从 1000 增到 20000，重合率稳定在 35%，
 * 说明是系统性的相关，加大样本也救不回来。
 */
export function bucketHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 乘以 FNV 素数 16777619，用移位实现避免浮点精度丢失
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }

  /**
   * murmur3 fmix32 收尾
   *
   * 把高位的差异彻底搅进低位，
   * 让"改一个字符"就能让输出的一半比特翻转。
   */
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;

  return h >>> 0;
}

/** 分桶到 0~99 */
export function bucketOf(id: string, salt: string): number {
  return bucketHash(`${id}:${salt}`) % 100;
}

/**
 * 分配实验组
 *
 * 【稳定性】
 * 只依赖 `id` 和 `name`，同一组合永远得到同一结果，
 * 不需要存数据库。
 *
 * 【salt 的作用】
 * `name` 本身就是 salt：不同实验用不同 name，
 * 分组互相独立，避免实验间的交叉污染。
 */
export function assign(id: string, cfg: ExperimentConfig): Variant {
  const pct = cfg.treatmentPercent ?? 50;
  const bucket = bucketOf(id, cfg.name);
  return bucket < pct ? 'treatment' : 'control';
}

/**
 * 检查分组是否均匀
 *
 * 【用途】
 * 实验开始前跑一次，确认哈希在你的用户 id 分布上没问题。
 * 分布倾斜说明哈希质量不够，或者 id 有规律（比如全是自增数字）。
 */
export function checkBalance(
  ids: readonly string[],
  cfg: ExperimentConfig
): BalanceReport {
  let control = 0;
  let treatment = 0;
  for (const id of ids) {
    if (assign(id, cfg) === 'treatment') treatment++;
    else control++;
  }
  const total = control + treatment;
  const skew = total === 0 ? 0 : Math.abs(control - treatment) / total;
  /**
   * 容差 5%：
   * 5000 人理想是 2500/2500，实际波动（二项分布标准差约 35）
   * 相对偏差约 1.4%，远小于 5%。
   * 5% 是个宽松但有意义的门槛——超过就说明哈希或 id 有问题。
   */
  return { control, treatment, skew, ok: skew <= 0.05 };
}

// ==================== 统计 ====================

export function emptyStats(): Stats {
  return { n: 0, conversions: 0, sum: 0, sumSq: 0 };
}

/** 记录一次二值结果（转化/未转化） */
export function recordBinary(s: Stats, converted: boolean): Stats {
  const v = converted ? 1 : 0;
  return {
    n: s.n + 1,
    conversions: s.conversions + (converted ? 1 : 0),
    sum: s.sum + v,
    sumSq: s.sumSq + v * v,
  };
}

/** 记录一次数值结果（时长、金额…） */
export function recordValue(s: Stats, value: number): Stats {
  return {
    n: s.n + 1,
    conversions: s.conversions,
    sum: s.sum + value,
    sumSq: s.sumSq + value * value,
  };
}

export function conversionRate(s: Stats): number {
  return s.n === 0 ? 0 : s.conversions / s.n;
}

export function mean(s: Stats): number {
  return s.n === 0 ? 0 : s.sum / s.n;
}

/**
 * 样本方差（除以 n−1）
 *
 * 【为什么是 n−1 不是 n】
 * n−1 是无偏估计。用 n 会系统性低估方差，
 * 在小样本时偏差尤其明显（n=3 时低估 1/3）。
 */
export function variance(s: Stats): number {
  if (s.n < 2) return 0;
  const m = mean(s);
  // 用 Σx² − n·m² 计算，避免二次遍历
  const v = (s.sumSq - s.n * m * m) / (s.n - 1);
  // 浮点误差可能让它轻微为负
  return Math.max(0, v);
}

// ==================== 显著性 ====================

/**
 * 标准正态分布累积函数
 *
 * 用 Abramowitz-Stegun 7.1.26 近似，最大误差约 1.5e-7，
 * 对 A/B 测试的精度要求绰绰有余。
 */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;

  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;

  const t = 1 / (1 + p * x);
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  const erf = 1 - poly * Math.exp(-x * x);

  return 0.5 * (1 + sign * erf);
}

/**
 * 双比例 Z 检验
 *
 * ```
 * 合并比例 p̄ = (x₁+x₂)/(n₁+n₂)
 * 标准误   se = sqrt(p̄(1−p̄)(1/n₁ + 1/n₂))
 * Z        = (p̂₂ − p̂₁) / se
 * ```
 *
 * @returns z / 双尾 p / 相对提升
 */
export function twoProportionZTest(control: Stats, treatment: Stats): ZTestResult {
  const n1 = control.n;
  const n2 = treatment.n;

  if (n1 === 0 || n2 === 0) {
    return { z: 0, p: 1, lift: 0 };
  }

  const p1 = control.conversions / n1;
  const p2 = treatment.conversions / n2;

  const pooled = (control.conversions + treatment.conversions) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));

  /**
   * 【se 为 0 的处理】
   * 两组转化率都是 0（或都是 1）时，pooled(1−pooled) = 0，se = 0。
   * 这时两组**完全一致**，差异就是 0，不该除出 Infinity。
   */
  if (se <= 0) {
    return { z: 0, p: 1, lift: p1 === 0 ? 0 : (p2 - p1) / p1 };
  }

  const z = (p2 - p1) / se;
  // 双尾 p 值
  const p = 2 * (1 - normalCdf(Math.abs(z)));

  return { z, p: clamp(p, 0, 1), lift: p1 === 0 ? 0 : (p2 - p1) / p1 };
}

/**
 * 是否显著
 *
 * @param alpha 显著性水平（通常 0.05）
 * @param minSamples 最小总样本量
 *
 * 【⚠️ minSamples 是硬性前置条件】
 * 样本不足时**直接返回 false**，不看 p 值。
 *
 * 原因：小样本的 p 值本身不可信。
 * 10 个用户出现"20% vs 80%"的巨大差异，p 值可能很小，
 * 但那纯粹是运气。
 */
export function isSignificant(
  control: Stats,
  treatment: Stats,
  alpha: number,
  minSamples: number
): boolean {
  if (control.n + treatment.n < minSamples) return false;
  return twoProportionZTest(control, treatment).p < alpha;
}

/**
 * 每组所需样本量
 *
 * @param baseline 基线转化率（如 0.1 = 10%）
 * @param lift 想检测的相对提升（如 0.05 = 想检测出 5% 的提升）
 *
 * ```
 * n = (z_{α/2} + z_β)² × [p₁(1−p₁) + p₂(1−p₂)] / (p₂−p₁)²
 * ```
 *
 * 取 α=0.05（双尾，z=1.96）、power=0.8（z=0.8416）。
 *
 * 【为什么值得在开实验前算】
 * 检测 5% 的相对提升，在 10% 基线下需要每组近 6 万人。
 * 如果日活只有 1 万，这个实验要跑 12 天才有结论——
 * 提前知道，就能改成检测更大的效应，或者干脆不做这个实验。
 */
export function requiredSampleSize(baseline: number, lift: number): number {
  if (baseline <= 0 || baseline >= 1) {
    throw new Error(`[ABTest] 基线转化率必须在 (0,1) 开区间，收到 ${baseline}`);
  }
  if (!(lift > 0)) {
    throw new Error(`[ABTest] 提升幅度必须为正，收到 ${lift}`);
  }

  const zAlpha = 1.959964;
  const zBeta = 0.841621;
  const p1 = baseline;
  const p2 = Math.min(0.999999, baseline * (1 + lift));
  const diff = p2 - p1;

  const n =
    ((zAlpha + zBeta) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (diff * diff);

  return Math.ceil(n);
}

// ==================== Experiment ====================

export interface ExperimentOptions {
  /** 最小总样本量（默认 1000） */
  readonly minSamples?: number;
  /** 显著性水平（默认 0.05） */
  readonly alpha?: number;
}

/**
 * 一次完整的实验
 *
 * 【去重语义】
 * 同一用户只计一次，防止刷事件污染数据：
 * - 二值指标取"是否曾经转化"（OR）
 * - 数值指标取**首次**上报值
 */
export class Experiment {
  private readonly _cfg: ExperimentConfig;
  private readonly _opts: Required<ExperimentOptions>;
  private readonly _users = new Map<
    string,
    { variant: Variant; converted: boolean; value: number; hasValue: boolean }
  >();

  constructor(cfg: ExperimentConfig, opts: ExperimentOptions = {}) {
    if (!cfg.name) {
      throw new Error('[ABTest] 实验必须有 name');
    }
    if (
      cfg.treatmentPercent !== undefined &&
      (cfg.treatmentPercent < 0 || cfg.treatmentPercent > 100)
    ) {
      throw new Error(
        `[ABTest] treatmentPercent 必须在 0~100，收到 ${cfg.treatmentPercent}`
      );
    }
    this._cfg = cfg;
    this._opts = {
      minSamples: opts.minSamples ?? 1000,
      alpha: opts.alpha ?? 0.05,
    };
  }

  get name(): string {
    return this._cfg.name;
  }

  /** 参与人数（去重后） */
  get size(): number {
    return this._users.size;
  }

  /** 分组查询（幂等） */
  variantOf(userId: string): Variant {
    return assign(userId, this._cfg);
  }

  /** 记录二值结果 */
  trackBinary(userId: string, converted: boolean): void {
    const variant = this.variantOf(userId);
    const existing = this._users.get(userId);

    if (!existing) {
      this._users.set(userId, {
        variant,
        converted,
        value: 0,
        hasValue: false,
      });
      return;
    }

    /**
     * 【OR 语义】
     * 用户已经转化过 → 保持 true。
     * 转化是"是否发生过"，不是"最后一次的状态"。
     */
    if (converted && !existing.converted) {
      this._users.set(userId, { ...existing, converted: true });
    }
  }

  /** 记录数值结果（首次上报生效） */
  trackValue(userId: string, value: number): void {
    const variant = this.variantOf(userId);
    const existing = this._users.get(userId);

    if (!existing) {
      this._users.set(userId, { variant, converted: false, value, hasValue: true });
      return;
    }
    if (!existing.hasValue) {
      this._users.set(userId, { ...existing, value, hasValue: true });
    }
  }

  /** 汇总结果 */
  result(): ExperimentResult {
    let control: Stats = emptyStats();
    let treatment: Stats = emptyStats();

    for (const u of this._users.values()) {
      const converted = u.converted || u.hasValue;
      const next = recordBinary(
        u.variant === 'treatment' ? treatment : control,
        converted
      );
      if (u.variant === 'treatment') treatment = next;
      else control = next;
    }

    const total = control.n + treatment.n;
    const underpowered = total < this._opts.minSamples;
    const test = twoProportionZTest(control, treatment);

    return {
      name: this._cfg.name,
      control,
      treatment,
      ...test,
      significant: !underpowered && test.p < this._opts.alpha,
      underpowered,
      minSamples: this._opts.minSamples,
    };
  }

  reset(): void {
    this._users.clear();
  }
}

// ==================== 结果描述 ====================

/**
 * 把结果写成人类可读的结论
 *
 * 【为什么需要它】
 * A/B 测试最大的风险不是算错，是**读错**。
 * "p = 0.08" 被读成"没有提升"，然后一个真的有用的改动被砍掉。
 *
 * 所以不显著时，文案里明确写"不等于没有提升"。
 */
export function describeResult(r: ExperimentResult): string {
  const lines: string[] = [];

  lines.push(`实验「${r.name}」`);
  lines.push(
    `  对照组 ${r.control.conversions}/${r.control.n} ` +
    `(${(conversionRate(r.control) * 100).toFixed(1)}%)`
  );
  lines.push(
    `  实验组 ${r.treatment.conversions}/${r.treatment.n} ` +
    `(${(conversionRate(r.treatment) * 100).toFixed(1)}%)`
  );

  if (r.underpowered) {
    const total = r.control.n + r.treatment.n;
    const need = r.minSamples > 0 ? r.minSamples : 1000;
    lines.push(
      `  ⚠️ 样本不足：${total} / ${need}，` +
      '当前结论不可靠，继续积累数据'
    );
    lines.push('  ⚠️ 此时 p 值没有参考价值 —— 小样本极易出现假阳性');
    return lines.join('\n');
  }

  const pct = (r.lift * 100).toFixed(1);
  if (r.significant) {
    const dir = r.lift >= 0 ? '提升' : '下降';
    lines.push(`  ✅ 显著（p = ${r.p.toFixed(4)}）：${dir} ${Math.abs(Number(pct)).toFixed(1)}%`);
  } else {
    lines.push(
      `  ⚪ 不显著（p = ${r.p.toFixed(4)}）：` +
      `观测到 ${r.lift >= 0 ? '提升' : '下降'} ${Math.abs(Number(pct)).toFixed(1)}%`
    );
    lines.push('  ⚠️ 不显著不等于没有提升，只说明当前样本无法确认');
  }

  return lines.join('\n');
}
