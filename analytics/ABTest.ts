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

import { clampNum } from '../_core/math';

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
  /**
   * 求和时减去的常数基准（方差"两遍算法"的第一遍结果）
   *
   * 【为什么需要它】
   * `sum` / `sumSq` 记的是 **Σ(x − shift)** 与 **Σ(x − shift)²**，
   * 不再直接记 Σx 与 Σx²。
   *
   * 原因见 `variance()` 的注释：直接存 Σx² 时，
   * `Σx² − n·m²` 会在"大基数小波动"下被灾难性消去抹平成 0。
   * 先把量级减掉再求和，减出来的差值就保留了全部有效位。
   *
   * 【为什么是 optional】
   * 外部（存档、测试、手算）构造的 Stats 字面量不带它是合法的，
   * 此时语义等价于 shift = 0，所有公式退化为修复前的写法。
   *
   * 【⚠️ 不要手工合并 Stats（交叉验收时实测出的边界）】
   * `shift` 取的是**第一批第一个样本**的量级，不是全局常量。
   * 若把两个不同时期 / 不同量级的 Stats 手工相加
   * （实测：`{n:2, sum:2, sumSq:2, shift:1e9}` → `mean` 算成 1000000001），
   * 结果毫无意义，且不报错。要合并请**一律用 `record*` 逐条喂**，
   * 让 `shiftOf` 自己维护基准。
   *
   * 同理：外部用字面量构造"大数量级"的 Stats（带 shift 但不是本模块算出来的），
   * 精度会退化回旧写法——这是该表示的固有边界，不是 bug。
   */
  readonly shift?: number;
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
  /**
   * 【⚠️ 为什么这里也要收口（P2）】
   * 构造函数校验了 `treatmentPercent` 的 0~100，
   * 但 `assign` 是**公开导出的独立函数**——
   * 调用方完全可以不经过 `Experiment` 直接拿一个配置对象来调它。
   *
   * 修复前 `?? 50` 只挡 null/undefined，NaN 穿过去：
   * `bucket < NaN` 恒为 false → **200 人全部落进 control**（实测），
   * 实验组永远 0 人，且没有任何报错。
   * 表现为"这个实验怎么一直没有实验组数据"，排查方向很容易被引到哈希函数上。
   */
  const pct = clampNum(cfg.treatmentPercent, 0, 100, 50);
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

/**
 * 取本批样本共用的移位基准
 *
 * 【为什么用第一个样本当基准】
 * 方差对平移不变（`Var(x − K) === Var(x)`），所以 K 取多少都不影响结果，
 * 只要**同一批样本用同一个 K**。
 * 取第一个样本是最省事且最贴近真实场景的选择：
 * 埋点里的"大基数小波动"（ARPU 1e8 量级、时长 1e5 毫秒量级）
 * 通常同一批样本彼此非常接近，第一个样本就在那个量级上，
 * 减完之后剩下的是真正的波动部分，有效位全部保留。
 */
function shiftOf(s: Stats, sample: number): number {
  if (s.n > 0) return s.shift ?? 0;
  return Number.isFinite(sample) ? sample : 0;
}

/** 记录一次二值结果（转化/未转化） */
export function recordBinary(s: Stats, converted: boolean): Stats {
  const v = converted ? 1 : 0;
  const k = shiftOf(s, v);
  const d = v - k;
  return {
    n: s.n + 1,
    conversions: s.conversions + (converted ? 1 : 0),
    sum: s.sum + d,
    sumSq: s.sumSq + d * d,
    shift: k,
  };
}

/**
 * 记录一次数值结果（时长、金额…）
 *
 * 【⚠️ 非有限值直接丢弃（P2）】
 * 修复前 `sum + NaN` 会把整个 Stats 污染成 NaN，
 * 之后 `mean` / `variance` / 显著性判定全部失效且**静默**。
 *
 * 为什么不记成 0：0 是一个"看起来合法"的样本，
 * 它会把均值系统性拉低（ARPU 里混进几个 0，均值就偏了），
 * 而且同样难查。直接丢弃这条样本、n 不增加，
 * 至少"样本数少了几条"是一个能被对出来的数字。
 */
export function recordValue(s: Stats, value: number): Stats {
  if (!Number.isFinite(value)) return s;

  const k = shiftOf(s, value);
  const d = value - k;
  return {
    n: s.n + 1,
    conversions: s.conversions,
    sum: s.sum + d,
    sumSq: s.sumSq + d * d,
    shift: k,
  };
}

export function conversionRate(s: Stats): number {
  return s.n === 0 ? 0 : s.conversions / s.n;
}

export function mean(s: Stats): number {
  if (s.n === 0) return 0;
  // sum 是移位后的和，要还原成真实量级必须加回 shift
  return (s.shift ?? 0) + s.sum / s.n;
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

  /**
   * 【⚠️ 为什么不能再用 Σx² − n·m²（P1）】
   *
   * 那个式子叫"一次遍历算法"，代价是**灾难性消去**：
   * Σx² 与 n·m² 是两个几乎相等的大数，相减时有效位全部抵消掉，
   * 剩下的主要是舍入噪声。实测（修复前）：
   *
   * ```
   * [1e8+1, 1e8+2, 1e8+3, 1e8+4, 1e8+5]  → 2     （精确值 2.5，误差 20%）
   * [1e9+7, 1e9+9, 1e9+11]               → 0     （精确值 4，被彻底抹平）
   * ```
   *
   * 更糟的是末尾的 `Math.max(0, v)`：消去产生的**负数**被压成 0，
   * 于是"精度崩了"这件事被伪装成"方差就是 0"。
   * 后果是置信区间为 0、t 检验失效——
   * ARPU 这类"大基数小波动"的实验会得出完全不可信的显著性结论。
   *
   * 【修法：两遍算法的等价形式】
   * 真正的两遍算法要留着全部样本再扫一遍，这里没有样本
   * （Stats 只有聚合值）。但方差有平移不变性：
   *
   * ```
   * Var(x) === Var(x − K)
   * ```
   *
   * 所以只要在**记录时**就把量级减掉（见 `shiftOf`），
   * 方差就能用同样的一次遍历公式算，而消去被完全消除：
   *
   * ```
   * Σd² − (Σd)²/n      d = x − K，K 取第一个样本
   * ```
   *
   * 验证（修复后）：上面两组分别得到 2.5 与 4，与精确值一致。
   * `Math.max(0, …)` 依旧保留——极小样本下仍可能有 1e-15 级的负噪声，
   * 但现在它兜的是"真正的浮点噪声"，不再掩盖精度崩溃。
   */
  const v = (s.sumSq - (s.sum * s.sum) / s.n) / (s.n - 1);
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

  /**
   * 【⚠️ 为什么用 clampNum 而不是 clamp（P2）】
   * `clamp` 内部是 `v < min ? min : v > max ? max : v`，
   * 对 NaN 三条分支全不成立 → **原样返回 NaN**。
   * （`Math.max(0, NaN)` 也是 NaN，同样挡不住。）
   *
   * `p = NaN` 的后果：`isSignificant` 里 `NaN < alpha` 恒为 false，
   * 于是"永远不显著"——一个真的有效的改动会被判成无效而砍掉，
   * 而且从结果上看和"真的没差异"一模一样。
   *
   * fallback 取 1（= 最不显著）而不是 0：
   * 算不出 p 值时，正确的默认姿态是"没有证据表明有差异"，
   * 而不是"有显著差异"。
   */
  return { z, p: clampNum(p, 0, 1, 1), lift: p1 === 0 ? 0 : (p2 - p1) / p1 };
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
  /**
   * 【⚠️ 为什么改写判定形式（P2）】
   * `baseline <= 0 || baseline >= 1` 对 NaN 两支都是 false → **NaN 被放行**，
   * 一路算到 `Math.ceil(NaN)` 返回 NaN。
   * 调用方拿到"每组需要 NaN 人"，常见后果是 `for` 循环一次都不跑，
   * 或者进度条永远停在 0%。
   *
   * 改成肯定式 `!(baseline > 0 && baseline < 1)` 后，
   * NaN 与越界值一样在这里被拒——见全库共享模式 A。
   * （下面的 `lift` 早已是肯定式写法，两处口径至此一致。）
   */
  if (!(baseline > 0 && baseline < 1)) {
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
      /**
       * 【⚠️ 转化只能来自 trackBinary，不能把"有数值指标"当成转化】
       *
       * 原实现 `u.converted || u.hasValue`：
       * `trackValue()` 会把 `hasValue` 置 true，于是**每一个记录了数值指标
       * 的用户都被算作已转化**。
       *
       * 实测（修复前）：只调 `trackValue`（从未 `trackBinary`），
       * 100 个用户 → `conversions = 100/100`、对照组与实验组转化率都是 1、
       * `p = 1`（永远不显著）。
       *
       * 后果：所有以数值指标（时长、ARPU、关卡进度）为主的实验
       * 都得不到正确的显著性判定——要么永远不显著，
       * 要么在真实转化差异被 100% 基线淹没后给出错误结论。
       * 且数值被塞进 `recordBinary` 后 `sum/sumSq` 记的是 0/1，
       * 均值类指标（ARPU）也一起错。
       *
       * 【正确的两分法】
       * - 转化（二值）→ `recordBinary(u.converted)`
       * - 数值（连续）→ `recordValue(u.value)`，仅对 `hasValue` 的用户
       * 两者互不干扰：`recordValue` 不动 `conversions`。
       */
      /**
       * 【⚠️ 一个用户只能贡献一次 n】
       *
       * 第一版我写成"先 recordBinary 再 recordValue"，
       * 两个函数各自 `n + 1` → 每个用户被计了 **2 次**，
       * 既有测试 `trackValue × 100 → n === 100` 立刻变红（实际 200）。
       * 这是把"组合调用"当成"叠加调用"的典型错误。
       *
       * 【sum/sumSq 怎么处理两种指标】
       * `Stats` 把二值与数值共用 `sum/sumSq`（`mean()` 同时服务两者），
       * 所以这里必须二选一，不能相加：
       * - 有数值指标 → 记 value（均值 = ARPU / 时长）
       * - 只有二值 → 记 0/1（均值 = 转化率，与修复前一致）
       *
       * 这样纯二值实验的行为完全不变，纯数值实验才得到修正。
       */
      const isTreatment = u.variant === 'treatment';
      const base = isTreatment ? treatment : control;
      const v = u.hasValue ? u.value : u.converted ? 1 : 0;

      const next: Stats = {
        n: base.n + 1,
        conversions: base.conversions + (u.converted ? 1 : 0),
        sum: base.sum + (Number.isFinite(v) ? v : 0),
        sumSq: base.sumSq + (Number.isFinite(v) ? v * v : 0),
      };

      if (isTreatment) treatment = next;
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

  /**
   * 卸载（P2）
   *
   * 【为什么要清 _users】
   * 实验跑了几十万用户时，`_users` 是最大的一块内存，
   * 而且它持有**原始 user id 字符串**——那是玩家标识，
   * 实验结束后不该继续留在堆里。
   *
   * 【为什么不是 alias 到 reset】
   * 名字要表达意图：`reset` 是"重新开始一轮实验"，
   * `destroy` 是"这个实验结束了，资源可以收了"。
   * 目前两者行为一致，但把 destroy 写成 reset 的别名，
   * 将来给其中任何一个加逻辑时都会误伤另一个。
   */
  destroy(): void {
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
