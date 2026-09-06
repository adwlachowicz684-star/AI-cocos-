/**
 * elo/Elo.ts —— ELO 评分
 *
 * ============================================================
 * ⚠️ 本目录两个文件导出了同名函数 `expectedScore`，参数完全不同
 * ============================================================
 *
 * | | 本文件 `expectedScore` | `Glicko2.ts` 的 `expectedScore` |
 * |---|---|---|
 * | 参数 | `(ratingA: number, ratingB: number, cfg?)` | `(p: GlickoPlayer, opponent: GlickoPlayer)` |
 * | 输入 | **两个分数**（数字） | **两个玩家对象**（含 r / RD） |
 * | 公式 | `1 / (1 + 10^((b-a)/scale))` | Glicko-2 的 E 函数（**含对手 RD 衰减**） |
 * | 用途 | ELO 对局 | Glicko-2 对局 |
 *
 * ⚠️ **传错不会报错，会静默得到 `NaN`。**
 *
 * 把 Glicko2 的玩家对象传进本函数：
 * 数字运算作用在对象上得到 `NaN`，一路算下去全是 `NaN`，
 * 表现为"评分结果有点怪"，不会有任何异常。
 *
 * **只 import 你正在用的那一个文件**，别两个都引。
 *
 * ============================================================
 *
 * 【它解决什么】
 *
 * "赢加分、输扣分"谁都会写。真正麻烦的是六件事：
 *
 * 1. **新手定级慢**
 *    固定 K=32 的话，一个真实水平 2000 的玩家从 1200 起步要打近百局才到位。
 *    这几十局里他把每个对手都打崩，体验极差。
 *    → 新手用高 K（快速收敛），老手用低 K（稳定）。
 *
 * 2. **分数地板**
 *    没有下限的话连输的玩家会掉到负数，
 *    然后需要赢回几十局才能回到 0 —— 这是"我弃坑了"的头号原因。
 *
 * 3. **多人对局**
 *    8 人吃鸡不是 7 次 1v1。要按名次算，且**总变化量必须为 0**。
 *
 * 4. **平局**
 *    S = 0.5，但很多人忘了平局对双方期望分也要按 0.5 处理。
 *
 * 5. **零和性被破坏**
 *    双方 K 不同（新手 vs 老手）时，一方加的分不等于另一方扣的分。
 *    这不是 bug，是**设计选择**——但必须知道自己在选什么。
 *
 * 6. **取整让零和失效**
 *    各自四舍五入后再相加，100 局后会累积出可观的分数漂移。
 *
 * 【零业务依赖】
 * 它不知道"玩家"是什么，只吃数字。
 */

import { clamp } from '../_core/math';

// ==================== 类型 ====================

export interface EloConfig {
  /**
   * 基础 K 值（默认 32）
   *
   * 【怎么选】
   * - K 大：分数变化快，能快速反映真实水平，但波动大
   * - K 小：稳定，但定级慢
   * - 国际象棋：高手 10、普通 15~20、新手 40
   * - 游戏常用：24~32
   */
  readonly baseK?: number;

  /**
   * 定级局数：低于这个局数算"新手"，用 provisionalK
   *
   * 【为什么需要】
   * 让新账号快速接近真实水平。
   * 缺点是分数波动大，所以要在 UI 上显示"定级中"。
   */
  readonly provisionalGames?: number;
  readonly provisionalK?: number;

  /** 高分段阈值与对应 K（高手分数更稳定） */
  readonly masterThreshold?: number;
  readonly masterK?: number;

  /**
   * 分数地板（默认 100）
   *
   * 【为什么必须有】
   * 没有地板的话，连输玩家会掉到极低的分数，
   * 之后要赢几十局才能回到正常区间 —— 这是弃坑的头号原因。
   */
  readonly ratingFloor?: number;
  readonly ratingCeiling?: number;

  /**
   * 分差常数（默认 400）
   *
   * 含义：分差 400 时，强手胜率期望约 91%（10:1）。
   * 调小 → 分差影响更剧烈；调大 → 分差影响更平缓。
   */
  readonly scale?: number;

  /** 初始分（默认 1200） */
  readonly initialRating?: number;

  /** 是否允许分数为小数（默认 false，取整存储） */
  readonly allowDecimal?: boolean;
}

export interface EloPlayer {
  readonly rating: number;
  /** 已完成的对局数（决定 K 值） */
  readonly games?: number;
}

/** 对局结果（从 a 的视角） */
export type EloOutcome =
  /** a 胜 */
  | 1
  /** 平局 */
  | 0.5
  /** a 负 */
  | 0;

export interface Elo1v1Result {
  readonly a: number;
  readonly b: number;
  readonly deltaA: number;
  readonly deltaB: number;
  /** 使用的 K 值（调试/展示用） */
  readonly kA: number;
  readonly kB: number;
  /** a 的期望得分（0~1） */
  readonly expectedA: number;
}

// ==================== 默认值 ====================

const DEFAULTS = {
  baseK: 32,
  provisionalGames: 10,
  provisionalK: 64,
  masterThreshold: 2400,
  masterK: 16,
  ratingFloor: 100,
  ratingCeiling: 4000,
  scale: 400,
  initialRating: 1200,
  allowDecimal: false,
};

function resolve(cfg?: EloConfig) {
  return {
    baseK: cfg?.baseK ?? DEFAULTS.baseK,
    provisionalGames: cfg?.provisionalGames ?? DEFAULTS.provisionalGames,
    provisionalK: cfg?.provisionalK ?? DEFAULTS.provisionalK,
    masterThreshold: cfg?.masterThreshold ?? DEFAULTS.masterThreshold,
    masterK: cfg?.masterK ?? DEFAULTS.masterK,
    ratingFloor: cfg?.ratingFloor ?? DEFAULTS.ratingFloor,
    ratingCeiling: cfg?.ratingCeiling ?? DEFAULTS.ratingCeiling,
    scale: cfg?.scale ?? DEFAULTS.scale,
    initialRating: cfg?.initialRating ?? DEFAULTS.initialRating,
    allowDecimal: cfg?.allowDecimal ?? DEFAULTS.allowDecimal,
  };
}

// ==================== 核心公式 ====================

/**
 * a 对 b 的期望得分（0~1）
 *
 * E = 1 / (1 + 10^((Rb - Ra) / scale))
 */
export function expectedScore(
  ratingA: number,
  ratingB: number,
  cfg?: EloConfig
): number {
  const c = resolve(cfg);
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / c.scale));
}

/**
 * 达到该期望得分所需的分差
 *
 * 【用途】
 * 匹配系统想知道"要让强手胜率 60%，双方该差多少分"——
 * 这是 expectedScore 的反函数。
 */
export function ratingGapFor(expected: number, cfg?: EloConfig): number {
  const c = resolve(cfg);
  if (expected <= 0 || expected >= 1) {
    throw new Error(`[Elo] 期望得分必须在 (0,1) 开区间，收到 ${expected}`);
  }
  return -c.scale * Math.log10(1 / expected - 1);
}

/** K 值：新手高、高手低 */
export function kFactor(player: EloPlayer, cfg?: EloConfig): number {
  const c = resolve(cfg);
  const games = player.games ?? 0;
  if (games < c.provisionalGames) return c.provisionalK;
  if (player.rating >= c.masterThreshold) return c.masterK;
  return c.baseK;
}

// ==================== 1v1 ====================

/**
 * 1v1 结算
 *
 * @param outcome 从 a 的视角：1 胜 / 0.5 平 / 0 负
 */
export function rate1v1(
  a: EloPlayer,
  b: EloPlayer,
  outcome: EloOutcome,
  cfg?: EloConfig
): Elo1v1Result {
  const c = resolve(cfg);

  if (outcome !== 0 && outcome !== 0.5 && outcome !== 1) {
    throw new Error(`[Elo] 结果必须是 1 / 0.5 / 0，收到 ${outcome}`);
  }

  const expectedA = expectedScore(a.rating, b.rating, c);
  const kA = kFactor(a, c);
  const kB = kFactor(b, c);

  const deltaA = kA * (outcome - expectedA);
  const deltaB = kB * ((1 - outcome) - (1 - expectedA));

  return {
    a: finalize(a.rating + deltaA, c),
    b: finalize(b.rating + deltaB, c),
    deltaA,
    deltaB,
    kA,
    kB,
    expectedA,
  };
}

// ==================== 多人对局 ====================

/**
 * 多人对局结算（吃鸡、赛车、大乱斗）
 *
 * 【算法】
 * 把 N 人局看成 N-1 次两两比较：
 *
 * - `E_i = Σ(j≠i) expected(r_i, r_j)` —— 期望总胜场，范围 0..N-1
 * - `S_i = Σ(j≠i) S_ij` —— 实际总胜场，范围 0..N-1
 *   其中 S_ij = 1（名次更靠前）/ 0.5（并列）/ 0（更靠后）
 * - `Δ_i = K * (S_i - E_i) / (N-1)` —— 除以 N-1 让幅度与 1v1 可比
 *
 * 【⚠️ 为什么能保证零和】
 * 对任意一对 (i, j)：S_ij + S_ji = 1，且 E_ij + E_ji = 1。
 * 所以 Σ_i (S_i - E_i) = Σ_{i<j} [(S_ij + S_ji) - (E_ij + E_ji)] = 0。
 *
 * 前提是**所有人 K 相同**。K 不同时零和会被打破，见下方注释。
 *
 * @param players 按任意顺序传入
 * @param ranks 名次，**0 = 第一名**，并列用相同数字（如 [0,0,2]）
 * @returns 与 players 同序的新分数
 */
export function rateMultiplayer(
  players: readonly EloPlayer[],
  ranks: readonly number[],
  cfg?: EloConfig
): number[] {
  const c = resolve(cfg);
  const n = players.length;

  if (n < 2) {
    throw new Error(`[Elo] 多人对局至少需要 2 人，收到 ${n}`);
  }
  if (ranks.length !== n) {
    throw new Error(`[Elo] 名次数组长度 ${ranks.length} 与人数 ${n} 不符`);
  }
  for (const r of ranks) {
    if (!Number.isFinite(r) || r < 0 || Math.floor(r) !== r) {
      throw new Error(`[Elo] 名次必须是非负整数，收到 ${r}`);
    }
  }

  // ① 两两比对，累加期望胜场与实际胜场
  const expected: number[] = new Array(n).fill(0);
  const actual: number[] = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const e = expectedScore(players[i].rating, players[j].rating, c);
      expected[i] += e;
      expected[j] += 1 - e;

      const ri = ranks[i];
      const rj = ranks[j];
      if (ri < rj) {
        actual[i] += 1;
      } else if (ri > rj) {
        actual[j] += 1;
      } else {
        // 并列：各得一半
        actual[i] += 0.5;
        actual[j] += 0.5;
      }
    }
  }

  // ② 应用变化量
  return players.map((p, i) => {
    const k = kFactor(p, c);
    const delta = (k * (actual[i] - expected[i])) / (n - 1);
    return finalize(p.rating + delta, c);
  });
}

/**
 * 多人对局（返回明细）
 *
 * @returns 与 players 同序
 */
export function rateMultiplayerDetailed(
  players: readonly EloPlayer[],
  ranks: readonly number[],
  cfg?: EloConfig
): {
  readonly rating: number;
  readonly delta: number;
  readonly expected: number;
  readonly actual: number;
  readonly k: number;
}[] {
  const c = resolve(cfg);
  const n = players.length;
  const before = players.map((p) => p.rating);
  const after = rateMultiplayer(players, ranks, c);

  const expected: number[] = new Array(n).fill(0);
  const actual: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const e = expectedScore(players[i].rating, players[j].rating, c);
      expected[i] += e;
      expected[j] += 1 - e;
      if (ranks[i] < ranks[j]) actual[i] += 1;
      else if (ranks[i] > ranks[j]) actual[j] += 1;
      else { actual[i] += 0.5; actual[j] += 0.5; }
    }
  }

  return players.map((p, i) => ({
    rating: after[i],
    delta: after[i] - before[i],
    expected: expected[i],
    actual: actual[i],
    k: kFactor(p, c),
  }));
}

// ==================== 内部 ====================

/**
 * 收尾：夹取区间 + 取整
 *
 * 【⚠️ 取整会破坏零和】
 * 各自四舍五入后，总和可能不再为 0。
 * 单局偏差 ≤1 分，但累积上千局后会漂移。
 *
 * 想严格零和就用 `allowDecimal: true`（内部保留小数），
 * 只在展示时取整。
 */
function finalize(rating: number, c: ReturnType<typeof resolve>): number {
  const clamped = clamp(rating, c.ratingFloor, c.ratingCeiling);
  return c.allowDecimal ? clamped : Math.round(clamped);
}

// ==================== 便捷工具 ====================

/** 从分数反推"大约能赢多少"的直观描述（调试/UI 用） */
export function describeMatchup(a: number, b: number, cfg?: EloConfig): string {
  const e = expectedScore(a, b, cfg);
  return `${a} vs ${b}：前者胜率 ${(e * 100).toFixed(1)}%`;
}

/**
 * 一组玩家的平均分
 *
 * 【用途】组队匹配时，队伍强度用平均分而非总分——
 * 否则 5 人队天然比 2 人队分高，永远排不到一起。
 */
export function averageRating(players: readonly EloPlayer[]): number {
  if (players.length === 0) return 0;
  let sum = 0;
  for (const p of players) sum += p.rating;
  return sum / players.length;
}
