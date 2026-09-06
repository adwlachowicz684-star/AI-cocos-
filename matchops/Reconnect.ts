/**
 * matchops/Reconnect.ts —— 断线重连
 *
 * 【它解决什么】
 *
 * 玩家断线看着只是"网络问题"，但它连接着三件很脏的事：
 *
 * 1. **拖延战术**
 *    快输了就拔网线。反正重连上来局面没变，
 *    或者干脆不重连让对手干等。
 *
 * 2. **队友连坐**
 *    4v5 打了一分钟，掉线的人判负，剩下 4 个人要不要扣满？
 *    全额扣 → 玩家觉得"队友掉线凭什么我买单"，弃坑。
 *    不扣 → 有人会开小号故意掉线保大号。
 *
 * 3. **宽限期的计时口径**
 *    游戏暂停时，宽限期还在走吗？
 *    用游戏时间 → 掉线的人只要让局面暂停就永远不判负。
 *    **必须用真实时间。**
 *
 * 【零业务依赖】
 */

import { clamp } from '../_core/math';

// ==================== 类型 ====================

export interface ReconnectConfig {
  /**
   * 宽限期（毫秒，默认 120000 = 2 分钟）
   *
   * 【怎么选】
   * - 太短：正常网络波动就被判负
   * - 太长：对手干等 5 分钟，体验极差
   * - MOBA 通常 3~5 分钟（因为一局长）
   * - 快节奏对战 60~120 秒
   */
  readonly graceMs?: number;

  /**
   * 最大重连次数（默认 3）
   *
   * 【为什么需要】
   * 不限制的话可以无限次断线重连，把一局拖到天荒地老。
   */
  readonly maxAttempts?: number;

  /**
   * 每次重连后宽限期的递减系数（默认 0.6）
   *
   * 【原理】
   * 第一次给足 2 分钟（可能是真断网），
   * 第二次只给 1.2 分钟（大概率是故意的），
   * 第三次 43 秒。
   *
   * 递增惩罚能有效区分"真断网"和"拔网线"。
   */
  readonly graceDecay?: number;
  /** 宽限期下限（默认 30000） */
  readonly minGraceMs?: number;

  /**
   * 队友的扣分减免（0~1，默认 0.5）
   *
   * 1 = 全额扣（队友连坐）
   * 0 = 完全不扣（可能被滥用）
   * 0.5 = 扣一半（推荐）
   */
  readonly teammatePenaltyRate?: number;

  /**
   * 自动判负阈值（毫秒，默认 = graceMs）
   *
   * 超过这个时间没重连 → 该玩家判负。
   * 但**对局不一定结束** —— 可能继续 4v5，也可能直接结束。
   * 这个决策留给上层，本模块只负责告诉你是"还没到"还是"到了"。
   */
  readonly forfeitAfterMs?: number;

  /**
   * 是否允许"对局结束后重连"（默认 false）
   *
   * 结束后重连没有意义，只会让结算画面卡住。
   */
  readonly allowAfterMatchEnd?: boolean;
}

export type ReconnectState =
  /** 在线 */
  | 'online'
  /** 断线中，宽限期内 */
  | 'disconnected'
  /** 已判负（超时未重连） */
  | 'forfeited'
  /** 重连次数用尽 */
  | 'exhausted';

export interface ReconnectEntry {
  readonly id: string;
  readonly state: ReconnectState;
  /** 本次断线的开始时刻（真实时间毫秒） */
  readonly disconnectedAt: number | null;
  /** 已重连次数 */
  readonly attempts: number;
  /** 本次宽限期长度（会因次数递减） */
  readonly currentGraceMs: number;
  /** 累计断线时长 */
  readonly totalOfflineMs: number;
}

export interface ReconnectVerdict {
  /** 重连是否成功 */
  readonly ok: boolean;
  /** 失败原因 */
  readonly reason?: 'not-disconnected' | 'expired' | 'exhausted' | 'after-end';
  /** 判负后队友的扣分比例 */
  readonly teammatePenaltyRate: number;
}

// ==================== 默认值 ====================

const DEFAULTS = {
  graceMs: 120_000,
  maxAttempts: 3,
  graceDecay: 0.6,
  minGraceMs: 30_000,
  teammatePenaltyRate: 0.5,
  forfeitAfterMs: undefined as number | undefined,
  allowAfterMatchEnd: false,
};

// ==================== 实现 ====================

export class ReconnectTracker {
  private readonly _graceMs: number;
  private readonly _maxAttempts: number;
  private readonly _graceDecay: number;
  private readonly _minGraceMs: number;
  private readonly _teammatePenaltyRate: number;
  private readonly _forfeitAfterMs: number;
  private readonly _allowAfterEnd: boolean;

  private readonly _entries = new Map<string, {
    state: ReconnectState;
    disconnectedAt: number | null;
    attempts: number;
    totalOfflineMs: number;
  }>();

  private _matchEnded = false;

  constructor(cfg: ReconnectConfig = {}) {
    this._graceMs = cfg.graceMs ?? DEFAULTS.graceMs;
    this._maxAttempts = cfg.maxAttempts ?? DEFAULTS.maxAttempts;
    this._graceDecay = cfg.graceDecay ?? DEFAULTS.graceDecay;
    this._minGraceMs = cfg.minGraceMs ?? DEFAULTS.minGraceMs;
    this._teammatePenaltyRate = cfg.teammatePenaltyRate ?? DEFAULTS.teammatePenaltyRate;
    this._forfeitAfterMs = cfg.forfeitAfterMs ?? cfg.graceMs ?? DEFAULTS.graceMs;
    this._allowAfterEnd = cfg.allowAfterMatchEnd ?? DEFAULTS.allowAfterMatchEnd;

    if (this._teammatePenaltyRate < 0 || this._teammatePenaltyRate > 1) {
      throw new Error(
        `[Reconnect] teammatePenaltyRate 必须在 0~1，收到 ${this._teammatePenaltyRate}`
      );
    }
  }

  // ==================== 注册 / 查询 ====================

  register(ids: readonly string[]): void {
    for (const id of ids) {
      if (!this._entries.has(id)) {
        this._entries.set(id, {
          state: 'online',
          disconnectedAt: null,
          attempts: 0,
          totalOfflineMs: 0,
        });
      }
    }
  }

  has(id: string): boolean {
    return this._entries.has(id);
  }

  stateOf(id: string): ReconnectState {
    return this._entries.get(id)?.state ?? 'online';
  }

  /** 当前宽限期长度（随次数递减） */
  graceFor(id: string): number {
    const e = this._entries.get(id);
    if (!e) return this._graceMs;
    return this._computeGrace(e.attempts);
  }

  /** 剩余宽限时间（毫秒）。在线或不计时返回 Infinity */
  remainingMs(id: string, now: number): number {
    const e = this._entries.get(id);
    if (!e || e.state !== 'disconnected' || e.disconnectedAt === null) {
      return Infinity;
    }
    const grace = this._computeGrace(e.attempts);
    return Math.max(0, e.disconnectedAt + grace - now);
  }

  /** 所有条目 */
  snapshot(): readonly ReconnectEntry[] {
    return [...this._entries.entries()].map(([id, e]) => ({
      id,
      state: e.state,
      disconnectedAt: e.disconnectedAt,
      attempts: e.attempts,
      currentGraceMs: this._computeGrace(e.attempts),
      totalOfflineMs: e.totalOfflineMs,
    }));
  }

  /** 当前断线的人数 */
  get disconnectedCount(): number {
    let n = 0;
    for (const e of this._entries.values()) {
      if (e.state === 'disconnected') n++;
    }
    return n;
  }

  /** 已判负的人数 */
  get forfeitedCount(): number {
    let n = 0;
    for (const e of this._entries.values()) {
      if (e.state === 'forfeited' || e.state === 'exhausted') n++;
    }
    return n;
  }

  // ==================== 状态迁移 ====================

  /** 标记断线 */
  markDisconnected(id: string, now: number): boolean {
    const e = this._entries.get(id);
    if (!e) return false;
    if (e.state !== 'online') return false;   // 已断线/已判负，忽略重复

    /**
     * 【⚠️ 次数用尽 → 直接判负，不再给宽限期】
     *
     * 如果还走 disconnected 状态，玩家会看到"等待重连"的提示，
     * 但实际上他再连上来也会被拒 —— 这是最糟的反馈。
     */
    if (e.attempts >= this._maxAttempts) {
      e.state = 'exhausted';
      e.disconnectedAt = now;
      return true;
    }

    e.state = 'disconnected';
    e.disconnectedAt = now;
    return true;
  }

  /**
   * 尝试重连
   *
   * @returns 是否成功
   */
  reconnect(id: string, now: number): ReconnectVerdict {
    const base: ReconnectVerdict = {
      ok: false,
      teammatePenaltyRate: this._teammatePenaltyRate,
    };
    const e = this._entries.get(id);
    if (!e) return { ...base, reason: 'not-disconnected' };

    if (e.state === 'online') {
      return { ...base, reason: 'not-disconnected' };
    }

    if (e.state === 'exhausted') {
      return { ...base, reason: 'exhausted' };
    }

    if (this._matchEnded && !this._allowAfterEnd) {
      return { ...base, reason: 'after-end' };
    }

    if (e.state === 'forfeited') {
      return { ...base, reason: 'expired' };
    }

    // 宽限期检查
    const grace = this._computeGrace(e.attempts);
    const elapsed = now - (e.disconnectedAt ?? now);
    if (elapsed > grace) {
      return { ...base, reason: 'expired' };
    }

    // 成功
    e.totalOfflineMs += elapsed;
    e.attempts++;
    e.state = 'online';
    e.disconnectedAt = null;
    return { ok: true, teammatePenaltyRate: this._teammatePenaltyRate };
  }

  /**
   * 推进时间，把超时的标为判负
   *
   * 【⚠️ 必须用真实时间】
   *
   * 用游戏时间的话，掉线的人只要让局面暂停（比如所有人都不动），
   * 宽限期就永远走不完，他永远不会被判负。
   *
   * @returns 本次新判负的人
   */
  tick(now: number): string[] {
    const forfeited: string[] = [];
    for (const [id, e] of this._entries) {
      if (e.state !== 'disconnected' || e.disconnectedAt === null) continue;

      /**
       * 【判负用 forfeitAfterMs，重连用 grace】
       *
       * 两者默认相等，但可以不同：
       * - grace = 120s（重连窗口）
       * - forfeitAfterMs = 180s（判负阈值）
       *
       * 中间那 60 秒是"缓冲带"：玩家连不上来，但对局还没判他负。
       * 这段时间里队友可以选择继续等，而不是被系统强行推着走。
       */
      const limit = Math.max(this._forfeitAfterMs, this._computeGrace(e.attempts));
      if (now - e.disconnectedAt > limit) {
        e.totalOfflineMs += now - e.disconnectedAt;
        e.state = 'forfeited';
        forfeited.push(id);
      }
    }
    return forfeited;
  }

  /** 对局结束 */
  endMatch(): void {
    this._matchEnded = true;
  }

  // ==================== 结算辅助 ====================

  /**
   * 计算每个玩家的扣分系数
   *
   * 【规则】
   * - 自己掉线判负 → 1.0（全额）
   * - 有队友掉线判负 → `teammatePenaltyRate`
   * - 全员在线 → 1.0
   *
   * @param teams 各队的成员 id
   * @returns id → 扣分系数
   */
  penaltyRates(teams: readonly (readonly string[])[]): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const team of teams) {
      const hasForfeit = team.some((id) => {
        const s = this.stateOf(id);
        return s === 'forfeited' || s === 'exhausted';
      });

      for (const id of team) {
        const s = this.stateOf(id);
        if (s === 'forfeited' || s === 'exhausted') {
          out.set(id, 1);                          // 自己掉线，全额
        } else if (hasForfeit) {
          out.set(id, this._teammatePenaltyRate);  // 队友掉线，减免
        } else {
          out.set(id, 1);
        }
      }
    }
    return out;
  }

  // ==================== 内部 ====================

  private _computeGrace(attempts: number): number {
    const decayed = this._graceMs * Math.pow(this._graceDecay, attempts);
    return Math.max(this._minGraceMs, Math.round(decayed));
  }
}

// ==================== 便捷 ====================

/**
 * 是否应该直接结束对局（而不是继续少打多）
 *
 * 【判据】
 * 任一队剩余可战人数低于阈值时，继续下去没有意义。
 *
 * @param alivePerTeam 各队当前在线人数
 * @param threshold 低于此人数就结束（默认 1，即全灭才结束）
 */
export function shouldAbortMatch(
  alivePerTeam: readonly number[],
  threshold = 1
): boolean {
  if (alivePerTeam.length === 0) return true;
  return alivePerTeam.some((n) => n < threshold);
}

/**
 * 断线惩罚的分数倍率
 *
 * 【用途】
 * 有些游戏对"频繁掉线"的玩家额外扣分（信誉分系统）。
 * 这里是那个倍率的计算，按 30 天内的判负次数递增。
 *
 * @param forfeits 近期判负次数
 * @param maxMultiplier 封顶倍率（默认 3）
 */
export function forfeitMultiplier(forfeits: number, maxMultiplier = 3): number {
  if (forfeits <= 0) return 1;
  return clamp(1 + (forfeits - 1) * 0.5, 1, maxMultiplier);
}
