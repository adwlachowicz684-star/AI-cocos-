/**
 * matchops/Surrender.ts —— 投降投票
 *
 * 【它解决什么】
 *
 * 投降是"认输"的正规出口。做不好的话，玩家会选择更糟的出口：
 * 挂机、送人头、拔网线。
 *
 * 五个容易写错的地方：
 *
 * 1. **票数基数的分母是谁**
 *    5 人队走了 1 个，剩下 4 人投票。
 *    需要 3 票（按 5 算的多数）还是 2 票（按 4 算的多数）？
 *
 *    **应该按在线人数算。** 按 5 算的话，
 *    掉线那个人等于永远投了反对票，剩下的人永远投不出去 ——
 *    于是他们只能挂机，这恰恰是投降功能要防止的事。
 *
 * 2. **弃权票算什么**
 *    超时没投票 = 弃权。弃权算赞成还是反对？
 *    **算反对**（不投票 = 还想打），否则挂机的人会被自动投降。
 *
 * 3. **最早可投降时间**
 *    开局 10 秒就能投降的话，有人会一直点。
 *    但设成 20 分钟又太晚（局面早就崩了）。
 *
 * 4. **重复投票**
 *    用数组存票数的话，同一个人点两次就算两票。
 *
 * 5. **被拒绝后的冷却**
 *    投票失败后立刻能再发起的话，会有人一直骚扰。
 *
 * 【零业务依赖】
 */

// ==================== 类型 ====================

export type SurrenderVote = 'yes' | 'no' | 'abstain';

export interface SurrenderConfig {
  /** 队伍人数 */
  readonly teamSize: number;

  /**
   * 赞成比例阈值（默认 0.5，即超过半数）
   *
   * 【常见设置】
   * - 0.5：多数通过（4 人需 3 票）→ 太容易，容易误投
   * - 0.66：三分之二（推荐，5 人需 4 票）
   * - 1.0：全票通过 → 太难，几乎投不出去
   */
  readonly threshold?: number;

  /**
   * 最早可发起时间（毫秒，默认 300000 = 5 分钟）
   */
  readonly minMatchMs?: number;

  /**
   * 投票持续时长（毫秒，默认 60000）
   *
   * 到期后未投票的计为弃权。
   */
  readonly voteDurationMs?: number;

  /**
   * 被拒绝后的冷却（毫秒，默认 120000）
   */
  readonly cooldownMs?: number;

  /**
   * 弃权是否算赞成（默认 false）
   *
   * 【⚠️ 默认必须是 false】
   * 设成 true 的话，挂机/掉线的人会被自动算作赞成，
   * 一局可能在没有一个人明确同意的情况下被投降掉。
   */
  readonly abstainAsYes?: boolean;

  /**
   * 是否要求全员都已连接（默认 true）
   *
   * 有人掉线时不允许发起 —— 那个人的意见无法表达。
   */
  readonly requireAllConnected?: boolean;
}

export type SurrenderState =
  /** 未发起 */
  | 'idle'
  /** 投票中 */
  | 'voting'
  /** 冷却中 */
  | 'cooldown';

export interface SurrenderStatus {
  readonly state: SurrenderState;
  /** 已投赞成的人数 */
  readonly yes: number;
  /** 已投反对的人数 */
  readonly no: number;
  /** 有效票数分母（在线人数） */
  readonly eligible: number;
  /** 还需要几票才能通过 */
  readonly needMore: number;
  /** 投票截止时刻 */
  readonly deadline: number | null;
  /** 冷却结束时刻 */
  readonly cooldownUntil: number | null;
  readonly initiator: string | null;
}

export type SurrenderError =
  | 'too-early'
  | 'already-voting'
  | 'in-cooldown'
  | 'not-connected'
  | 'not-in-team'
  | 'not-voting';

// ==================== 实现 ====================

export class Surrender {
  private readonly _teamSize: number;
  private readonly _threshold: number;
  /** 本次投票所需的赞成票数（start 时冻结） */
  private _frozenNeed = 1;
  private readonly _minMatchMs: number;
  private readonly _voteDurationMs: number;
  private readonly _cooldownMs: number;
  private readonly _abstainAsYes: boolean;
  private readonly _requireAllConnected: boolean;

  private readonly _team = new Set<string>();
  private readonly _connected = new Set<string>();
  private readonly _votes = new Map<string, SurrenderVote>();

  private _state: SurrenderState = 'idle';
  private _deadline: number | null = null;
  private _cooldownUntil: number | null = null;
  private _initiator: string | null = null;
  private _matchStartedAt = 0;

  constructor(cfg: SurrenderConfig) {
    if (!Number.isInteger(cfg.teamSize) || cfg.teamSize < 1) {
      throw new Error(`[Surrender] teamSize 必须是正整数，收到 ${cfg.teamSize}`);
    }
    this._teamSize = cfg.teamSize;
    this._threshold = cfg.threshold ?? 0.5;
    this._minMatchMs = cfg.minMatchMs ?? 300_000;
    this._voteDurationMs = cfg.voteDurationMs ?? 60_000;
    this._cooldownMs = cfg.cooldownMs ?? 120_000;
    this._abstainAsYes = cfg.abstainAsYes ?? false;
    this._requireAllConnected = cfg.requireAllConnected ?? true;

    if (this._threshold <= 0 || this._threshold > 1) {
      throw new Error(`[Surrender] threshold 必须在 (0,1]，收到 ${this._threshold}`);
    }
  }

  // ==================== 成员管理 ====================

  setTeam(ids: readonly string[]): void {
    if (ids.length > this._teamSize) {
      throw new Error(
        `[Surrender] 队伍 ${ids.length} 人超过上限 ${this._teamSize}`
      );
    }
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      throw new Error('[Surrender] 队伍中有重复 id');
    }
    this._team.clear();
    for (const id of ids) this._team.add(id);
    // 离开队伍的人的票要一并清掉
    for (const id of [...this._votes.keys()]) {
      if (!this._team.has(id)) this._votes.delete(id);
    }
  }

  setConnected(ids: readonly string[]): void {
    this._connected.clear();
    for (const id of ids) this._connected.add(id);
  }

  markMatchStart(now: number): void {
    this._matchStartedAt = now;
  }

  // ==================== 发起 ====================

  /**
   * 发起投降投票
   *
   * @param now 当前时刻
   * @param matchElapsedMs 对局已进行时长（可选，不传则用 markMatchStart 计算）
   */
  start(initiator: string, now: number, matchElapsedMs?: number):
    | { ok: true }
    | { ok: false; error: SurrenderError } {
    if (!this._team.has(initiator)) {
      return { ok: false, error: 'not-in-team' };
    }
    if (this._state === 'voting') {
      return { ok: false, error: 'already-voting' };
    }
    if (this._state === 'cooldown' && this._cooldownUntil !== null
        && now < this._cooldownUntil) {
      return { ok: false, error: 'in-cooldown' };
    }

    const elapsed = matchElapsedMs ?? (now - this._matchStartedAt);
    if (elapsed < this._minMatchMs) {
      return { ok: false, error: 'too-early' };
    }

    if (this._requireAllConnected && this._connected.size < this._team.size) {
      return { ok: false, error: 'not-connected' };
    }

    this._state = 'voting';
    this._deadline = now + this._voteDurationMs;
    this._initiator = initiator;
    this._votes.clear();
    this._votes.set(initiator, 'yes');   // 发起人默认赞成

    /**
     * 【⚠️ 所需票数在发起时冻结，之后不再变化】
     *
     * 分母用的是**发起那一刻的在线人数**。
     * 不冻结的话会出两件事：
     *
     * 1. **门柱被移动**
     *    5 人开局需要 3 票，投到一半掉了 2 人，
     *    分母变成 3、需求降到 2，
     *    于是一个"本来通不过"的投票因为掉线而通过了。
     *
     * 2. **可被主动利用**
     *    想投降的人只要让队友"掉线"就能降低门槛。
     *    冻结之后这条路被堵死——掉线只会减少票数，不会降低需求。
     */
    this._frozenNeed = Math.max(1, Math.ceil(this._eligibleCount() * this._threshold));

    return { ok: true };
  }

  // ==================== 投票 ====================

  vote(id: string, choice: SurrenderVote, now: number):
    | { ok: true }
    | { ok: false; error: SurrenderError } {
    if (!this._team.has(id)) {
      return { ok: false, error: 'not-in-team' };
    }
    if (this._state !== 'voting') {
      return { ok: false, error: 'not-voting' };
    }
    if (this._deadline !== null && now > this._deadline) {
      // 超时后由 tick 处理，这里不接受新票
      return { ok: false, error: 'not-voting' };
    }

    /**
     * 【⚠️ 用 Map 而不是数组】
     * 数组的话同一个人点两次算两票，
     * 表现为"4 个人投了 5 票赞成"。
     */
    this._votes.set(id, choice);
    return { ok: true };
  }

  // ==================== 推进 ====================

  /**
   * 每帧/每秒调用
   *
   * @returns 投票是否通过（true = 投降成功）
   */
  tick(now: number): boolean {
    if (this._state !== 'voting') return false;

    const passed = this._checkPass();
    if (passed) {
      this._state = 'idle';
      this._votes.clear();
      this._deadline = null;
      this._initiator = null;
      return true;
    }

    // 超时未通过 → 进入冷却
    if (this._deadline !== null && now > this._deadline) {
      this._state = 'cooldown';
      this._cooldownUntil = now + this._cooldownMs;
      this._votes.clear();
      this._deadline = null;
      this._initiator = null;
    }
    return false;
  }

  /** 取消投票（比如有人重连回来了） */
  cancel(): void {
    this._state = 'idle';
    this._votes.clear();
    this._deadline = null;
    this._initiator = null;
  }

  // ==================== 查询 ====================

  status(now: number): SurrenderStatus {
    /**
     * 【冷却已过 → 状态回到 idle】
     *
     * 不处理的话，`state` 会一直停在 'cooldown'，
     * UI 上永远显示"冷却中"，即使时间早就过了。
     * 表现为"为什么我不能投降了"——而实际上是可以的。
     */
    if (
      this._state === 'cooldown' &&
      this._cooldownUntil !== null &&
      now >= this._cooldownUntil
    ) {
      this._state = 'idle';
      this._cooldownUntil = null;
    }

    const eligible = this._eligibleCount();
    const { yes, no } = this._tally();

    /**
     * 需要几票：`ceil(eligible * threshold)` 且至少 1 票。
     *
     * 【⚠️ 为什么用 ceil 而不是 floor】
     * floor 的话 4 人队 × 0.66 = 2.64 → 2 票就能通过，
     * 两个人在剩下两人明确反对的情况下投掉了这局。
     * ceil 给出 3 票，才是"三分之二"的真实含义。
     */
    /**
     * 需求票数用**发起时冻结**的值。
     *
     * `eligible` 仍然是当前在线人数（UI 展示用），
     * 但它不再参与需求计算——详见 start() 里的说明。
     */
    const need = this._frozenNeed;

    return {
      state: this._state,
      yes,
      no,
      eligible,
      needMore: Math.max(0, need - yes),
      deadline: this._deadline,
      cooldownUntil: this._state === 'cooldown' ? this._cooldownUntil : null,
      initiator: this._initiator,
    };
  }

  /** 剩余投票时间（毫秒） */
  remainingMs(now: number): number {
    if (this._state !== 'voting' || this._deadline === null) return 0;
    return Math.max(0, this._deadline - now);
  }

  get state(): SurrenderState {
    return this._state;
  }

  // ==================== 内部 ====================

  /**
   * 有效票分母 = **在线**的队伍成员数
   *
   * 【⚠️ 这是本模块最关键的一行】
   *
   * 用 `teamSize` 做分母的话，掉线的人等于永远投反对票。
   * 5 人队走 1 个，剩 4 人全票赞成 → 4/5 = 0.8 < 0.66？不，0.8 > 0.66 能过。
   * 但走 2 个时剩 3 人 → 3/5 = 0.6 < 0.66，**永远投不出去**。
   *
   * 于是剩下三个人只能挂机 —— 这正是投降功能要防止的事。
   */
  private _eligibleCount(): number {
    let n = 0;
    for (const id of this._team) {
      if (this._connected.has(id)) n++;
    }
    return n;
  }

  private _tally(): { yes: number; no: number } {
    let yes = 0;
    let no = 0;
    for (const [id, v] of this._votes) {
      // 掉线的人的票作废
      if (!this._connected.has(id)) continue;
      if (v === 'yes') yes++;
      else if (v === 'no') no++;
      else if (this._abstainAsYes) yes++;
    }
    return { yes, no };
  }

  private _checkPass(): boolean {
    if (this._eligibleCount() === 0) return false;
    const { yes } = this._tally();
    return yes >= this._frozenNeed;
  }
}

// ==================== 便捷 ====================

/**
 * 投降后的扣分减免系数
 *
 * 【为什么要减免】
 * 投降和挂机的结果一样（都是输），
 * 但投降是"配合系统的行为"，挂机是"破坏行为"。
 * 如果两者扣分相同，理性玩家会选择挂机——
 * 反正都要扣分，不如边扣边刷手机。
 *
 * 所以投降必须扣分更少，才能让"认输"比"摆烂"更划算。
 *
 * @param elapsedMs 对局已进行时长
 * @param fullMs 超过此时长视为打满（减免为 0，即全额）
 * @param maxDiscount 最大减免（默认 0.3，即最多少扣 30%）
 */
export function surrenderDiscount(
  elapsedMs: number,
  fullMs: number,
  maxDiscount = 0.3
): number {
  if (fullMs <= 0) return maxDiscount;
  const t = Math.min(1, Math.max(0, elapsedMs / fullMs));
  /**
   * 越早投降，减免越多（因为浪费的时间少）。
   * 线性递减：开局就投 → 满减免；打满时长 → 无减免。
   */
  return maxDiscount * (1 - t);
}
