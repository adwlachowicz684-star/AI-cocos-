/**
 * mmr/TeamMMR.ts —— 队伍分数计算
 *
 * 【它解决什么】
 *
 * 单人匹配时，一个玩家 = 一个分数，没有歧义。
 * 组队之后，"这支队伍值多少分"突然变成一个没有标准答案的问题：
 *
 * 1. **用平均分？**
 *    2000 分带 800 分的朋友，平均 1400。
 *    但他们的实际强度远高于 1400 —— 大佬会 carry。
 *    按 1400 匹配，对手会被打崩。
 *
 * 2. **用最高分？**
 *    五人队里有一个 2500，其余四个 1000。
 *    按 2500 匹配，四个人会被打崩。
 *
 * 3. **组队天然更强**
 *    五连坐开语音，配合碾压五个互不相识的散人。
 *    这是客观事实，不是玄学 —— 所有竞技游戏都观测到了这一点。
 *    所以匹配时要给组队加一个"隐藏分惩罚"，让他们去打更强的对手。
 *
 * 4. **分差限制**
 *    2500 和 500 组队，要么是代练，要么是在炸鱼。
 *    两种都要限制。
 *
 * 【零业务依赖】
 */

import { clamp, maxOf, minOf } from '../_core/math';

// ==================== 类型 ====================

export interface MmrPlayer {
  readonly id: string;
  readonly rating: number;
  /** 是否在同一语音（影响配合度，可选） */
  readonly inVoice?: boolean;
}

/**
 * 队伍分计算策略
 *
 * | 策略 | 公式 | 特点 |
 * |---|---|---|
 * | `'avg'` | 算术平均 | 最保守，适合队伍分差小的时候 |
 * | `'weighted'` | 高分权重更大 | **推荐**，反映 carry 效应 |
 * | `'max'` | 取最高分 | 最激进，适合"一个大哥带四躺"的极端场景 |
 * | `'topHalf'` | 较高的一半求平均 | 折中 |
 */
export type MmrStrategy = 'avg' | 'weighted' | 'max' | 'topHalf';

export interface TeamMmrConfig {
  /** 计算策略（默认 'weighted'） */
  readonly strategy?: MmrStrategy;

  /**
   * 加权策略的权重基准（默认 0.7）
   *
   * 【含义】
   * 排序后，第 i 名的权重 = base^i。
   * base=0.7 时，五人队权重约为 1 / 0.7 / 0.49 / 0.343 / 0.24。
   *
   * - 接近 1 → 退化成平均分
   * - 接近 0 → 退化成最高分
   */
  readonly weightBase?: number;

  /**
   * 分差限制：队伍内最高与最低的差值上限
   *
   * 【为什么需要】
   * 2500 和 500 组队，要么是代练，要么在炸鱼。
   * 不限制的话，低段位会被大量"大佬带小号"污染。
   *
   * 【常见值】
   * - 排位模式：300~500（严格）
   * - 休闲模式：不限制（undefined）
   */
  readonly maxSpread?: number;

  /**
   * 组队协作惩罚：每个"额外队友"增加多少隐藏分
   *
   * 【原理】
   * 组队有配合优势，所以匹配时按"比实际更强"来对待。
   * 这样他们会匹配到更强的对手，抵消掉配合优势。
   *
   * 【⚠️ 常见错误】
   * 惩罚一次性加满（`penalty × (n-1)`）会让 5 人队被加到天上。
   * 应该用**递减**：第 2 人 +full，第 3 人 +0.7×full，第 4 人 +0.5×full…
   * 因为配合的边际收益是递减的。
   */
  readonly partyPenalty?: number;
  /** 递减系数（默认 0.7） */
  readonly penaltyDecay?: number;
  /** 惩罚上限（防止极端情况） */
  readonly penaltyCap?: number;

  /** 语音加成系数（默认 1.5）。全队在语音时惩罚按此放大 */
  readonly voiceMultiplier?: number;
}

export interface TeamMmrResult {
  /** 基础队伍分（未加惩罚） */
  readonly base: number;
  /** 组队协作惩罚 */
  readonly penalty: number;
  /** 最终匹配分 = base + penalty */
  readonly effective: number;
  /** 队内分差 */
  readonly spread: number;
  readonly size: number;
  /** 是否触发了分差限制 */
  readonly overSpread: boolean;
}

// ==================== 默认值 ====================

const DEFAULTS = {
  strategy: 'weighted' as MmrStrategy,
  weightBase: 0.7,
  maxSpread: undefined as number | undefined,
  partyPenalty: 0,
  penaltyDecay: 0.7,
  penaltyCap: Infinity,
  voiceMultiplier: 1.5,
};

function resolve(cfg?: TeamMmrConfig) {
  return {
    strategy: cfg?.strategy ?? DEFAULTS.strategy,
    weightBase: cfg?.weightBase ?? DEFAULTS.weightBase,
    maxSpread: cfg?.maxSpread ?? DEFAULTS.maxSpread,
    partyPenalty: cfg?.partyPenalty ?? DEFAULTS.partyPenalty,
    penaltyDecay: cfg?.penaltyDecay ?? DEFAULTS.penaltyDecay,
    penaltyCap: cfg?.penaltyCap ?? DEFAULTS.penaltyCap,
    voiceMultiplier: cfg?.voiceMultiplier ?? DEFAULTS.voiceMultiplier,
  };
}

// ==================== 核心 ====================

/**
 * 计算队伍匹配分
 *
 * @throws 队伍为空时抛错
 */
export function teamMmr(
  players: readonly MmrPlayer[],
  cfg?: TeamMmrConfig
): TeamMmrResult {
  const c = resolve(cfg);

  if (players.length === 0) {
    throw new Error('[TeamMMR] 队伍为空');
  }

  const ratings = players.map((p) => p.rating);
  const spread = maxOf(ratings, 0) - minOf(ratings, 0);
  const base = baseRating(ratings, c.strategy, c.weightBase);
  const penalty = partyPenalty(players, c);

  return {
    base,
    penalty,
    effective: base + penalty,
    spread,
    size: players.length,
    overSpread: c.maxSpread !== undefined && spread > c.maxSpread,
  };
}

/** 基础分（不含惩罚） */
function baseRating(
  ratings: readonly number[],
  strategy: MmrStrategy,
  weightBase: number
): number {
  const n = ratings.length;
  if (n === 1) return ratings[0]!;

  switch (strategy) {
    case 'avg':
      return avg(ratings);

    case 'max':
      return maxOf(ratings, 0);

    case 'topHalf': {
      const sorted = ratings.slice().sort((a, b) => b - a);
      const take = Math.max(1, Math.ceil(n / 2));
      return avg(sorted.slice(0, take));
    }

    case 'weighted': {
      /**
       * 排序后按 base^i 加权。
       *
       * 【为什么要排序】
       * 必须**降序**排，让最高分拿到最大权重。
       * 不排序的话，权重会随机分配给任何人，结果毫无意义 ——
       * 这是本模块最容易写错的一行。
       */
      const sorted = ratings.slice().sort((a, b) => b - a);
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.pow(weightBase, i);
        num += sorted[i]! * w;
        den += w;
      }
      /**
       * 【⚠️ 分母可能为 0，除之前必须检查】
       *
       * 权重是 `weightBase^i`，逐项求和。当 base 为负时各项正负交替，
       * 分母可能正好抵消成 0。实测：
       * ```js
       * teamMmr([1500, 1600], { strategy: 'weighted', weightBase: -1 })
       * // den = 1 + (-1) = 0  →  base = Infinity
       * ```
       * 队的 MMR 变成 Infinity，之后所有匹配分、胜负概率、
       * 段位判定全部失效，且**没有任何报错**——
       * Infinity 是合法 number，能一路穿到 UI 上显示 "∞"。
       *
       * 为什么不让 needFinite 去拦 weightBase：
       * `weightBase = -1` 本身是"合法输入"（负权重在某些建模里有意义），
       * 真正的问题是这个特定算法下的分母消零。
       * 所以在除法处检查，而不是在入口限制取值范围。
       */
      if (den === 0) {
        /**
         * 退化到等权平均：分母为 0 意味着加权方案在这个 base 下无意义，
         * 而平均是"没有权重信息时"最中性的选择。
         * 这里不抛错是因为它发生在匹配链路里，
         * 抛错会让整场匹配失败——降级比中断更符合业务预期。
         */
        return avg(sorted);
      }
      return num / den;
    }
  }
}

/**
 * 组队协作惩罚
 *
 * 【⚠️ 递减而非线性累加】
 *
 * 线性累加 `p × (n-1)` 的问题：
 * 五人队一次性加 4p，如果 p=100 就是 +400 分。
 * 这会让五人队的匹配时间暴涨到无法接受。
 *
 * 递减累加（默认 decay=0.7）：
 * ```
 * n=2: p
 * n=3: p + 0.7p        = 1.70p
 * n=4: p + 0.7p + 0.49p = 2.19p
 * n=5: ...              = 2.53p
 * ```
 * 五人队实际只加了 2.53p 而不是 4p。
 *
 * 依据是**配合的边际收益递减**：
 * 从 1 人到 2 人的提升，远大于从 4 人到 5 人。
 */
export function partyPenalty(
  players: readonly MmrPlayer[],
  cfg?: TeamMmrConfig
): number {
  const c = resolve(cfg);
  const n = players.length;
  if (n < 2 || c.partyPenalty === 0) return 0;

  let sum = 0;
  for (let i = 1; i < n; i++) {
    sum += c.partyPenalty * Math.pow(c.penaltyDecay, i - 1);
  }

  // 全队在语音 → 配合优势更大，惩罚按比例放大
  const allVoice = players.every((p) => p.inVoice);
  if (allVoice && n >= 2) {
    sum *= c.voiceMultiplier;
  }

  return Math.min(sum, c.penaltyCap);
}

// ==================== 组队合法性 ====================

export type PartyViolation =
  | 'empty'
  | 'spread'
  | 'size'
  | 'duplicate';

/**
 * 校验组队是否合法
 *
 * 【用途】
 * 玩家点"开始匹配"时先跑这个，
 * 不合法就在 UI 上拦下来并给出原因，
 * 而不是让他排队排了五分钟才被拒绝。
 */
export function validateParty(
  players: readonly MmrPlayer[],
  cfg?: TeamMmrConfig,
  maxSize?: number
): { ok: true } | { ok: false; reason: PartyViolation; detail: string } {
  const c = resolve(cfg);

  if (players.length === 0) {
    return { ok: false, reason: 'empty', detail: '队伍为空' };
  }

  const ids = players.map((p) => p.id);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, reason: 'duplicate', detail: '队伍中有重复玩家' };
  }

  if (maxSize !== undefined && players.length > maxSize) {
    return {
      ok: false,
      reason: 'size',
      detail: `队伍 ${players.length} 人，超过上限 ${maxSize}`,
    };
  }

  // 【注意】本作用域没有 ratings 变量，必须现场 map。
  // 上一版直接写 ratings 是笔误——编译会报"找不到名称"，
  // 但如果这里恰好有个同名的外层变量，就会静默用错数据。
  const ratings = players.map((p) => p.rating);
  const spread = maxOf(ratings, 0) - minOf(ratings, 0);
  if (c.maxSpread !== undefined && spread > c.maxSpread) {
    return {
      ok: false,
      reason: 'spread',
      detail: `队内分差 ${spread}，超过上限 ${c.maxSpread}`,
    };
  }

  return { ok: true };
}

// ==================== 补齐散人 ====================

/**
 * 从散人池里挑一个补进队伍
 *
 * 【场景】
 * 4 人黑店排队，需要第 5 个人。
 * 挑谁？挑完队伍分变了，匹配窗口也得跟着变。
 *
 * @returns 补人后的队伍分，null 表示没有合适的
 */
export function fillFromPool(
  party: readonly MmrPlayer[],
  pool: readonly MmrPlayer[],
  cfg?: TeamMmrConfig
): { pick: MmrPlayer; result: TeamMmrResult } | null {
  const c = resolve(cfg);
  if (party.length === 0 || pool.length === 0) return null;

  const target = teamMmr(party, c).effective;

  let best: MmrPlayer | null = null;
  let bestDiff = Infinity;

  for (const p of pool) {
    // 补进来的人不能破坏分差限制
    const merged = [...party, p];
    if (!validateParty(merged, c).ok) continue;

    const d = Math.abs(p.rating - target);
    if (d < bestDiff) {
      bestDiff = d;
      best = p;
    }
  }

  if (!best) return null;
  return { pick: best, result: teamMmr([...party, best], c) };
}

// ==================== 便捷 ====================

function avg(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * 两队对抗的预期胜率
 *
 * 【用途】
 * - 撮合时评估"这局公不公平"
 * - 结算前给玩家显示"你们胜率 45%"
 * - 平衡性分析
 */
export function winProbability(
  teamA: readonly MmrPlayer[],
  teamB: readonly MmrPlayer[],
  cfg?: TeamMmrConfig,
  scale = 400
): number {
  const ra = teamMmr(teamA, cfg).effective;
  const rb = teamMmr(teamB, cfg).effective;
  return 1 / (1 + Math.pow(10, (rb - ra) / scale));
}

/**
 * 分差 → 建议的匹配窗口
 *
 * 【为什么需要】
 * 队伍分已经是加权算出来的了，
 * 直接拿它去和单人匹配会系统性偏移。
 * 这个函数给出"考虑到队伍不确定性后，窗口该放宽多少"。
 */
export function suggestedWindow(
  players: readonly MmrPlayer[],
  baseWindow: number,
  cfg?: TeamMmrConfig
): number {
  const r = teamMmr(players, cfg);
  /**
   * 队内分差越大，我们对"这支队伍到底多强"越不确定。
   * 分差每 100 分，窗口额外放宽 20%。
   */
  const uncertainty = 1 + r.spread / 500;
  return clamp(baseWindow * uncertainty, baseWindow, baseWindow * 3);
}
