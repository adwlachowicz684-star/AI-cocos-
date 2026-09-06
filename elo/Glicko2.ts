/**
 * elo/Glicko2.ts —— Glicko-2 评分
 *
 * ============================================================
 * ⚠️ 本目录两个文件导出了同名函数 `expectedScore`，参数完全不同
 * ============================================================
 *
 * | | 本文件 `expectedScore` | `Elo.ts` 的 `expectedScore` |
 * |---|---|---|
 * | 参数 | `(p: GlickoPlayer, opponent: GlickoPlayer)` | `(ratingA: number, ratingB: number, cfg?)` |
 * | 输入 | **两个玩家对象**（含 r / RD） | **两个分数**（数字） |
 * | 公式 | Glicko-2 的 E 函数（**含对手 RD 衰减**） | `1 / (1 + 10^((b-a)/scale))` |
 * | 用途 | Glicko-2 对局 | ELO 对局 |
 *
 * ⚠️ **传错不会报错，会静默得到 `NaN`。**
 *
 * 把两个数字传进本函数时，读 `opponent.phi` 得到 `undefined`，
 * 整个期望值变 `NaN`，后续所有评分计算都是 `NaN`。
 *
 * **只 import 你正在用的那一个文件**，别两个都引。
 *
 * ============================================================
 *
 * 【为什么有了 ELO 还要这个】
 *
 * ELO 只有一个数字，它隐含假设：**你对自己的估计是确定的**。
 * 但一个 3 年没打的玩家和一个每天打 10 局的玩家，
 * 同样显示 1500 分，可信度天差地别。
 *
 * Glicko-2 用三个量描述一个玩家：
 *
 * | 量 | 含义 | 直觉 |
 * |---|---|---|
 * | **r** |  rating 分数 | 水平估计值 |
 * | **RD** | Rating Deviation 偏差 | 这个估计有多不确定。**越大越不确定** |
 * | **σ** | sigma 波动率 | 发挥有多不稳定 |
 *
 * 带来的三个关键能力：
 *
 * 1. **新号快速定级**：新号 RD=350（极不确定），
 *    赢一局可能加 100 分；打十几局后 RD 降到 60，加减速就正常了。
 *    ELO 里这需要"定级赛"这种额外机制。
 *
 * 2. **久未登录自动降置信**：半年没打，RD 会自己涨回去，
 *    系统不再"确定"你还是那个水平。
 *
 * 3. **对局结果影响对称**：打赢一个 RD 很小的对手（水平确定）
 *    比打赢一个 RD 很大的对手加分更多——
 *    因为后者的分数本来就不可信。
 *
 * 【代价】
 * 计算比 ELO 重（每人每期要跑一次迭代），
 * 且**必须按"评分周期"批量结算**，不能每局实时算。
 *
 * 【零业务依赖】
 */

import { clamp } from '../_core/math';

// ==================== 常量 ====================

/**
 * Glicko-2 内部尺度换算因子
 *
 * 算法在 μ/φ 空间里运算（数值更稳定），
 * 展示时再换回 r/RD 空间。
 */
const Q = 173.7178;

/** 默认初始分 */
export const GLICKO_DEFAULT_RATING = 1500;
/** 新号默认偏差：350 = 完全不确定 */
export const GLICKO_DEFAULT_RD = 350;
/** 默认波动率 */
export const GLICKO_DEFAULT_SIGMA = 0.06;

// ==================== 类型 ====================

export interface GlickoPlayer {
  readonly rating: number;
  /** Rating Deviation，越大越不确定 */
  readonly rd: number;
  /** 波动率 σ */
  readonly sigma: number;
}

/** 一个对手及其对局结果 */
export interface GlickoResult {
  readonly opponent: GlickoPlayer;
  /** 1 胜 / 0.5 平 / 0 负 */
  readonly score: number;
}

export interface GlickoConfig {
  /**
   * 系统常数 τ（默认 0.5）
   *
   * 【怎么选】
   * 约束波动率的变化幅度。Glickman 建议 0.3~1.2。
   * - 小（0.2）：默认玩家发挥稳定
   * - 大（1.2）：允许波动率大幅变化
   *
   * ⚠️ 太大（>1.5）会让分数震荡，玩家会觉得"系统乱给分"。
   */
  readonly tau?: number;

  /**
   * 迭代收敛阈值（默认 1e-6）
   */
  readonly convergenceTolerance?: number;
  /** 最大迭代次数（防御性，正常 20 次内收敛） */
  readonly maxIterations?: number;

  /** 分数区间 */
  readonly ratingFloor?: number;
  readonly ratingCeiling?: number;
  /** RD 上限（久未登录时不无限膨胀） */
  readonly maxRd?: number;
}

// ==================== 默认值 ====================

const DEFAULTS = {
  tau: 0.5,
  tolerance: 1e-6,
  maxIterations: 100,
  ratingFloor: 100,
  ratingCeiling: 4000,
  maxRd: GLICKO_DEFAULT_RD,
};

function resolve(cfg?: GlickoConfig) {
  return {
    tau: cfg?.tau ?? DEFAULTS.tau,
    tolerance: cfg?.convergenceTolerance ?? DEFAULTS.tolerance,
    maxIterations: cfg?.maxIterations ?? DEFAULTS.maxIterations,
    ratingFloor: cfg?.ratingFloor ?? DEFAULTS.ratingFloor,
    ratingCeiling: cfg?.ratingCeiling ?? DEFAULTS.ratingCeiling,
    maxRd: cfg?.maxRd ?? DEFAULTS.maxRd,
  };
}

/** 造一个新玩家 */
export function createGlickoPlayer(
  rating = GLICKO_DEFAULT_RATING,
  rd = GLICKO_DEFAULT_RD,
  sigma = GLICKO_DEFAULT_SIGMA
): GlickoPlayer {
  return { rating, rd, sigma };
}

// ==================== 尺度换算 ====================

function toGlicko2Scale(p: GlickoPlayer): { mu: number; phi: number; sigma: number } {
  return {
    mu: (p.rating - GLICKO_DEFAULT_RATING) / Q,
    phi: p.rd / Q,
    sigma: p.sigma,
  };
}

function fromGlicko2Scale(
  mu: number,
  phi: number,
  sigma: number,
  c: ReturnType<typeof resolve>
): GlickoPlayer {
  return {
    rating: clamp(Q * mu + GLICKO_DEFAULT_RATING, c.ratingFloor, c.ratingCeiling),
    rd: clamp(Q * phi, 0.01, c.maxRd),
    sigma,
  };
}

// ==================== 核心：单期结算 ====================

/**
 * 结算一个评分周期
 *
 * @param player 待结算的玩家
 * @param results 本周期内该玩家的所有对局。**空数组 = 本期未参赛**（只涨 RD）
 */
export function ratePeriod(
  player: GlickoPlayer,
  results: readonly GlickoResult[],
  cfg?: GlickoConfig
): GlickoPlayer {
  const c = resolve(cfg);

  for (const r of results) {
    if (r.score !== 0 && r.score !== 0.5 && r.score !== 1) {
      throw new Error(`[Glicko2] 结果必须是 1 / 0.5 / 0，收到 ${r.score}`);
    }
  }

  const { mu, phi, sigma } = toGlicko2Scale(player);

  /**
   * ① 未参赛：只增加不确定性
   *
   * φ* = sqrt(φ² + σ²)
   *
   * 这是 Glicko 相对 ELO 的核心优势之一：
   * 半年没打，系统不再"确定"你还是那个水平。
   */
  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return fromGlicko2Scale(mu, phiStar, sigma, c);
  }

  // ② 预计算 g 与 E
  const g: number[] = [];
  const E: number[] = [];
  for (const r of results) {
    const { mu: muj, phi: phij } = toGlicko2Scale(r.opponent);
    const gj = 1 / Math.sqrt(1 + (3 * phij * phij) / (Math.PI * Math.PI));
    const Ej = 1 / (1 + Math.exp(-gj * (mu - muj)));
    g.push(gj);
    E.push(Ej);
  }

  // ③ v = 估计方差的倒数
  let vSum = 0;
  for (let j = 0; j < results.length; j++) {
    vSum += g[j] * g[j] * E[j] * (1 - E[j]);
  }
  const v = 1 / vSum;

  // ④ Δ = 估计改进量
  let deltaSum = 0;
  for (let j = 0; j < results.length; j++) {
    deltaSum += g[j] * (results[j].score - E[j]);
  }
  const delta = v * deltaSum;

  // ⑤ 迭代求新波动率 σ'
  const sigmaPrime = computeNewVolatility(phi, v, delta, sigma, c);

  // ⑥ φ* = sqrt(φ² + σ'²)
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);

  // ⑦ 更新 φ 与 μ
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return fromGlicko2Scale(muPrime, phiPrime, sigmaPrime, c);
}

/**
 * 迭代求新波动率（Illinois 算法）
 *
 * 【为什么需要迭代】
 * 波动率的更新方程没有闭式解，只能数值求解。
 * Illinois 算法是 Glickman 论文里指定的方法，收敛快且稳定。
 *
 * ⚠️ 如果这里写错，表现不是崩溃，而是"分数变化幅度不对"——
 * 玩家会觉得系统给分很怪，但你查不出原因。
 */
function computeNewVolatility(
  phi: number,
  v: number,
  delta: number,
  sigma: number,
  c: ReturnType<typeof resolve>
): number {
  const a = Math.log(sigma * sigma);
  const tau = c.tau;
  const phi2 = phi * phi;
  const delta2 = delta * delta;

  const f = (x: number): number => {
    const ex = Math.exp(x);
    const denom = phi2 + v + ex;
    return (ex * (delta2 - phi2 - v - ex)) / (2 * denom * denom) - (x - a) / (tau * tau);
  };

  // 确定区间右端 B
  let B: number;
  if (delta2 > phi2 + v) {
    B = Math.log(delta2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) {
      k++;
      if (k > 1000) break;   // 防御：正常不会到
    }
    B = a - k * tau;
  }

  let A = a;
  let fA = f(A);
  let fB = f(B);

  let iter = 0;
  while (Math.abs(B - A) > c.tolerance && iter < c.maxIterations) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);

    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
    iter++;
  }

  return Math.exp(A / 2);
}

// ==================== 未参赛衰减 ====================

/**
 * 未参加评分的周期数 → 只涨 RD
 *
 * @param periods 连续未参赛的周期数
 *
 * 【典型用法】
 * 玩家 30 天没上线。如果评分周期是 1 天，就传 30。
 */
export function decayRd(
  player: GlickoPlayer,
  periods: number,
  cfg?: GlickoConfig
): GlickoPlayer {
  const c = resolve(cfg);
  if (!Number.isFinite(periods) || periods < 0) {
    throw new Error(`[Glicko2] 周期数必须非负，收到 ${periods}`);
  }
  let p = player;
  for (let i = 0; i < Math.floor(periods); i++) {
    p = ratePeriod(p, [], c);
  }
  return p;
}

/**
 * 未参赛衰减（闭式解，等价于连续调用 decayRd）
 *
 * φ*_n² = φ² + n·σ²
 *
 * 【为什么提供这个】
 * 玩家离线 365 天时循环 365 次没必要，
 * 但两者结果必须一致——有测试锁住这一点。
 */
export function decayRdClosedForm(
  player: GlickoPlayer,
  periods: number,
  cfg?: GlickoConfig
): GlickoPlayer {
  const c = resolve(cfg);
  const { mu, sigma } = toGlicko2Scale(player);
  const phiStar = Math.sqrt((player.rd / Q) ** 2 + periods * sigma * sigma);
  return fromGlicko2Scale(mu, phiStar, sigma, c);
}

// ==================== 查询 ====================

/**
 * 期望得分
 *
 * 与 ELO 不同：这里**考虑对手的不确定性**。
 * 对手 RD 越大，g 越小，你的分数优势被"稀释"——
 * 因为你也不确定他到底什么水平。
 */
export function expectedScore(p: GlickoPlayer, opponent: GlickoPlayer): number {
  /**
   * 【⚠️ 为什么只取对手的 phi，不取自己的】
   *
   * 这不是漏写。Glicko-2 的期望得分公式里，
   * 衰减系数 g 只由**对手的**不确定度 φj 决定，
   * 自己的 φ 不参与。
   *
   * 直觉上说得通：
   * "我对自己有多不确定"不影响"我这一局的胜率期望"，
   * 它影响的是**这一局结束后我的分数该变多少**（见 ratePeriod 里的 v 和 φ'）。
   *
   * 两个概念别混：
   * - 期望得分 E  → 只跟对手有关
   * - 更新幅度   → 跟双方的 φ 都有关
   */
  const { mu } = toGlicko2Scale(p);
  const { mu: muj, phi: phij } = toGlicko2Scale(opponent);
  const g = 1 / Math.sqrt(1 + (3 * phij * phij) / (Math.PI * Math.PI));
  return 1 / (1 + Math.exp(-g * (mu - muj)));
}

/**
 * 置信区间（95%）
 *
 * 【用途】
 * UI 上显示 "1500 ±120"，或者在匹配时判断
 * "这个玩家的真实水平可能在 1380~1620 之间"。
 */
export function confidenceInterval(p: GlickoPlayer): { low: number; high: number } {
  return {
    low: p.rating - 2 * p.rd,
    high: p.rating + 2 * p.rd,
  };
}

/**
 * 保守分（匹配用）
 *
 * 【为什么需要】
 * 新号 RD 很大，真实水平可能在 1000~2000 之间。
 * 直接用 1500 去匹配，如果他是 2000 水平，就会一路屠杀新手。
 *
 * 用 `r - k·RD`（k 通常 1~2）作为匹配依据：
 * - 新号保守分很低 → 先跟弱一点的对手打 → 快速把 RD 打下来
 * - 打过很多局后 RD 小 → 保守分接近真实分
 *
 * 这是解决"新号炸鱼"最有效的手段。
 */
export function conservativeRating(p: GlickoPlayer, k = 2): number {
  return p.rating - k * p.rd;
}

/** 是否已充分定级（RD 足够小） */
export function isSettled(p: GlickoPlayer, threshold = 80): boolean {
  return p.rd <= threshold;
}

/**
 * 两个玩家水平是否"无法区分"
 *
 * 【用途】
 * 匹配时判断"这两个玩家分差虽大，但置信区间重叠，可以放一起"。
 */
export function ratingsOverlap(a: GlickoPlayer, b: GlickoPlayer): boolean {
  const ca = confidenceInterval(a);
  const cb = confidenceInterval(b);
  return ca.low <= cb.high && cb.low <= ca.high;
}

// ==================== 存档 ====================

export interface GlickoSave {
  readonly r: number;
  readonly rd: number;
  readonly sigma: number;
}

export function exportGlicko(p: GlickoPlayer): GlickoSave {
  return { r: p.rating, rd: p.rd, sigma: p.sigma };
}

/** 导入。非法值回退到默认，不抛错（手改存档不该让玩家进不去） */
export function importGlicko(s: Partial<GlickoSave>): GlickoPlayer {
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  return {
    rating: num(s.r, GLICKO_DEFAULT_RATING),
    rd: clamp(num(s.rd, GLICKO_DEFAULT_RD), 0.01, GLICKO_DEFAULT_RD),
    sigma: clamp(num(s.sigma, GLICKO_DEFAULT_SIGMA), 0.001, 1),
  };
}
