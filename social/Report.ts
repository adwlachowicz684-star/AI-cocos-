/**
 * social/Report.ts —— 举报系统
 *
 * 【它解决什么】
 *
 * 举报看起来是最简单的功能：填个表，存数据库。
 * 但做不好会有两个方向的灾难：
 *
 * 1. **举报无效**
 *    玩家举报了 10 次，从没收到过任何反馈。
 *    结论是"这游戏没人管"，然后**他自己也开始违规**。
 *    这是社区崩坏的开始。
 *
 * 2. **举报被滥用**
 *    输了就举报对面开挂。
 *    如果系统无脑处理，高手会被举报到封号 ——
 *    这在任何竞技游戏里都真实发生过。
 *
 * 所以举报系统真正要解决的是三件事：
 *
 * - **去重**：同一个人短时间内不能反复举报同一个人
 * - **加权**：信誉好的玩家的举报权重更高
 * - **反击**：恶意举报要能被识别并处罚
 *
 * 【零业务依赖】
 */

import { clamp, clampNum } from '../_core/math';

// ==================== 类型 ====================

export type ReportReason =
  | 'cheating'
  | 'griefing'      // 故意送/挂机
  | 'abusive-chat'  // 辱骂
  | 'afk'
  | 'inappropriate-name'
  | 'other';

export interface ReportTicket {
  readonly id: string;
  readonly reporterId: string;
  readonly targetId: string;
  readonly reason: ReportReason;
  /** 附加说明 */
  readonly comment?: string;
  readonly at: number;
  /** 举报人的信誉分（0~100），决定权重 */
  readonly reporterCredibility: number;
  /** 对局 id（可选，用于关联回放） */
  readonly matchId?: string;
}

export interface ReportConfig {
  /**
   * 同一举报人对同一目标的冷却（毫秒，默认 3600000 = 1 小时）
   *
   * 【为什么需要】
   * 输了就举报，一局举报三次。
   * 不冷却的话一个人能刷出几百条，淹没真实举报。
   */
  readonly cooldownMs?: number;

  /**
   * 每人每天可举报次数（默认 5）
   *
   * 【为什么需要】
   * 没有上限的话，有人会举报一整个服务器。
   * 这个上限也间接保护了"举报"这个动作本身的严肃性。
   */
  readonly dailyLimit?: number;

  /** 举报人信誉分低于此值时权重降为最低（默认 40） */
  readonly lowCredibilityThreshold?: number;

  /** 最低举报权重（默认 0.2），避免完全无效 */
  readonly minWeight?: number;

  /** 触发处理所需的最低加权分（默认 3） */
  readonly actionThreshold?: number;

  /** 短期内恶意举报多少次会被标记（默认 5） */
  readonly abuseThreshold?: number;

  /**
   * 工单队列上限（默认 10000）
   *
   * 【为什么需要】
   * 早期版本**没有上限也没有清空方法**，工单只增不减。
   * 实测 5 万次举报后堆到 50000 条（+14 MB），且没有任何 API 能删掉。
   * 万人在线的服里这个数没有理论上限。
   *
   * 超出后**淘汰最旧的**，而不是拒绝新举报——
   * 漏掉一条新举报比丢掉一条陈年旧账更危险。
   */
  readonly maxTickets?: number;
}

export type SubmitResult =
  | 'accepted'
  | 'cooldown'
  | 'daily-limit'
  | 'self-report'
  | 'duplicate';

export interface ReportStats {
  readonly total: number;
  readonly byReason: Readonly<Record<ReportReason, number>>;
  /** 加权总分 */
  readonly weighted: number;
  /** 唯一举报人数 */
  readonly uniqueReporters: number;
}

// ==================== 默认值 ====================

const DEFAULTS = {
  cooldownMs: 3_600_000,
  dailyLimit: 5,
  lowCredibilityThreshold: 40,
  minWeight: 0.2,
  actionThreshold: 3,
  abuseThreshold: 5,
  maxTickets: 10_000,
};

// ==================== 实现 ====================

export class ReportCenter {
  private readonly _cooldownMs: number;
  private readonly _dailyLimit: number;
  private readonly _lowCred: number;
  private readonly _minWeight: number;
  private readonly _actionThreshold: number;
  private readonly _abuseThreshold: number;
  private readonly _maxTickets: number;

  private _tickets: ReportTicket[] = [];
  /** reporterId → targetId → lastAt */
  private readonly _lastReport = new Map<string, number>();
  /** reporterId → 当日计数 */
  private readonly _dailyCount = new Map<string, { day: number; n: number }>();
  /** 被判为无效（驳回）的举报数 */
  private readonly _rejected = new Map<string, number>();

  private _nextId = 1;

  constructor(cfg: ReportConfig = {}) {
    this._cooldownMs = cfg.cooldownMs ?? DEFAULTS.cooldownMs;
    this._dailyLimit = cfg.dailyLimit ?? DEFAULTS.dailyLimit;
    this._lowCred = cfg.lowCredibilityThreshold ?? DEFAULTS.lowCredibilityThreshold;
    this._minWeight = cfg.minWeight ?? DEFAULTS.minWeight;
    this._actionThreshold = cfg.actionThreshold ?? DEFAULTS.actionThreshold;
    this._abuseThreshold = cfg.abuseThreshold ?? DEFAULTS.abuseThreshold;
    this._maxTickets = clampNum(cfg.maxTickets, 1, 1e6, DEFAULTS.maxTickets);
  }

  // ==================== 提交 ====================

  /**
   * 提交举报
   *
   * @param reporterCredibility 举报人的信誉分 0~100
   */
  submit(
    reporterId: string,
    targetId: string,
    reason: ReportReason,
    now: number,
    opts: {
      credibility?: number;
      comment?: string;
      matchId?: string;
    } = {}
  ): { result: SubmitResult; ticket?: ReportTicket } {
    /**
     * 【⚠️ now 必须是有限数，否则会造出"永远清不掉"的记录】
     *
     * `now` 是必填位置参数，TS 调用方不会漏传，
     * 但 JS 调用方、或 `someApi(...args)` 展开调用时可能传成 undefined/NaN。
     *
     * 后果不是报错，而是**永久性泄漏**：
     * - `_lastReport.set(key, NaN)` → 之后 `now - at >= cooldownMs` 是 `NaN >= x`，
     *   恒为 false → 这条记录**永远不会被 prune 清掉**
     * - 实测：漏传 now 提交 1 次后，无论 prune 多大时间戳，表里始终残留 1 条
     *
     * 这与本单元原 bug（`cooldownMs === 0` 导致 `_lastReport` 只增不减）
     * 是同一个失效模式的不同入口：坏时间戳 → 清理逻辑失效 → 无界增长。
     *
     * 【为什么抛错而不是兜底成 Date.now()】
     * 兜底成"当前时间"会掩盖调用方的 bug，
     * 且让冷却判定的基准时间变得不可预测。
     * 时间戳是这类系统的地基，坏了就应该响亮失败。
     */
    if (!Number.isFinite(now)) {
      throw new Error(
        `[Report] submit 的 now 必须是有限时间戳，收到 ${now}`
      );
    }

    if (reporterId === targetId) {
      return { result: 'self-report' };
    }

    // 冷却：同一对 (举报人, 目标)
    const key = `${reporterId}→${targetId}`;
    const last = this._lastReport.get(key);
    if (last !== undefined && now - last < this._cooldownMs) {
      return { result: 'cooldown' };
    }

    // 每日上限
    const day = Math.floor(now / 86_400_000);
    const rec = this._dailyCount.get(reporterId);
    if (rec && rec.day === day && rec.n >= this._dailyLimit) {
      return { result: 'daily-limit' };
    }

    const ticket: ReportTicket = {
      id: `R${this._nextId++}`,
      reporterId,
      targetId,
      reason,
      comment: opts.comment,
      at: now,
      reporterCredibility: clamp(opts.credibility ?? 100, 0, 100),
      matchId: opts.matchId,
    };

    this._tickets.push(ticket);

    /**
     * 【⚠️ 没有冷却就不记录上次举报时间】
     * 记录它的唯一用途是"冷却期内禁止重复举报"（见上文的 `last !== undefined` 判断）。
     * `cooldownMs <= 0` 时这个判断永不成立，记录的只是纯垃圾，
     * 却会让 `_lastReport` 无限增长（笛卡尔积量级）。
     */
    if (this._cooldownMs > 0) this._lastReport.set(key, now);

    if (rec && rec.day === day) rec.n++;
    else this._dailyCount.set(reporterId, { day, n: 1 });

    // 冷却记录过期后就没有意义了，顺手清掉，避免无界增长
    this.prune(now);
    // 工单超上限时淘汰最旧的
    if (this._tickets.length > this._maxTickets) {
      this._tickets = this._tickets.slice(this._tickets.length - this._maxTickets);
    }

    return { result: 'accepted', ticket };
  }

  // ==================== 加权 ====================

  /**
   * 举报权重
   *
   * 【原理】
   * 信誉分高的玩家，其举报更有可信度。
   *
   * ```
   * weight = max(minWeight, credibility / 100)
   * ```
   *
   * 【⚠️ 下限的意义】
   * 不设下限的话，信誉 0 的玩家权重是 0，
   * 他的举报完全无效——哪怕他是真的被挂机坑了。
   * 这会让人觉得"系统根本不听我说话"。
   * 所以保留 0.2 的下限。
   */
  weightOf(t: ReportTicket): number {
    /**
     * 【⚠️ 低于阈值的一律按最低权重，不再区分】
     *
     * 信誉 40 的人举报和信誉 5 的人举报，
     * 在"可不可信"这件事上没有区别 —— 都不可信。
     *
     * 如果按比例给（0.4 vs 0.2 打底），
     * 等于承认"信誉 5 的人说的话还有 20% 参考价值"，
     * 而这 20% 会让高频恶意举报者逐渐累积出可观的权重。
     */
    if (t.reporterCredibility < this._lowCred) return this._minWeight;
    return Math.max(this._minWeight, t.reporterCredibility / 100);
  }

  // ==================== 查询 ====================

  /** 某人的举报统计 */
  statsOf(targetId: string): ReportStats {
    const list = this._tickets.filter((t) => t.targetId === targetId);

    const byReason = {} as Record<ReportReason, number>;
    for (const t of list) {
      byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;
    }

    let weighted = 0;
    for (const t of list) weighted += this.weightOf(t);

    return {
      total: list.length,
      byReason,
      weighted,
      uniqueReporters: new Set(list.map((t) => t.reporterId)).size,
    };
  }

  /**
   * 该玩家是否需要处理
   *
   * 【⚠️ 用加权分而不是条数】
   *
   * 只看条数的话，10 个信誉 10 分的人联名举报，
   * 权重和 10 × 0.2 = 2.0 < 3，不该处理；
   * 但如果按条数算，10 条已经"很多了"。
   *
   * 反过来，2 个信誉 100 的人举报 = 2.0，也不够；
   * 3 个才是 3.0。
   *
   * 【这个设计的意图】
   * 让"高手被多人举报"不会自动触发处罚 ——
   * 因为举报他的人往往信誉不高（输了乱举报）。
   */
  needsAction(targetId: string): boolean {
    return this.statsOf(targetId).weighted >= this._actionThreshold;
  }

  /** 距离"需要处理"还差多少加权分 */
  remainingToAction(targetId: string): number {
    return Math.max(0, this._actionThreshold - this.statsOf(targetId).weighted);
  }

  // ==================== 恶意举报 ====================

  /**
   * 标记一条举报为"驳回"（查证后确认无违规）
   *
   * 【为什么需要】
   * 只有能识别"举报错了"，才能反过来识别"恶意举报"。
   * 不做这一步的话，恶意举报和误报无法区分。
   */
  reject(ticketId: string): boolean {
    const t = this._tickets.find((x) => x.id === ticketId);
    if (!t) return false;
    this._rejected.set(t.reporterId, (this._rejected.get(t.reporterId) ?? 0) + 1);
    return true;
  }

  /** 某人被驳回的次数 */
  rejectedCount(reporterId: string): number {
    return this._rejected.get(reporterId) ?? 0;
  }

  /**
   * 是否为恶意举报者
   *
   * 【后果由上层决定】
   * 常见做法是：降低他的举报权重（而不是禁止举报），
   * 这样他真遇到挂机时仍有渠道，只是没那么容易被采纳。
   */
  isAbusiveReporter(reporterId: string): boolean {
    return this.rejectedCount(reporterId) >= this._abuseThreshold;
  }

  // ==================== 管理 ====================

  /** 清空某人的所有记录（比如解封后重置） */
  clearFor(targetId: string): number {
    const before = this._tickets.length;
    this._tickets = this._tickets.filter((t) => t.targetId !== targetId);
    return before - this._tickets.length;
  }

  get size(): number {
    return this._tickets.length;
  }

  /**
   * 清理过期的冷却记录
   *
   * 【为什么需要】
   * `_lastReport` 的 key 是「举报人→目标」组合，
   * 玩家换个目标举报就多一条，**没有理论上限**。
   * 冷却期一过这些记录就纯属垃圾，清掉不影响任何判定。
   *
   * 【什么时候调】
   * `submit()` 内部已经会顺带调用，所以正常用不需要手动调。
   * 长期不提交举报的服务端可以定期自己调一次。
   *
   * @returns 清理掉多少条
   */
  prune(now: number): number {
    /**
     * 【⚠️ 早退不能跳过 `_dailyCount` 的清理】
     *
     * 老实现把 `if (this._cooldownMs <= 0) return 0;` 放在函数**最开头**，
     * 于是下面的 `_lastReport` 清理和 `_dailyCount` 清理**一起被跳过**。
     *
     * 而 `cooldownMs: 0` 是完全合法的配置（"不限制冷却"）——
     * 一旦这么配，冷却记录表就再也不会被清理，
     * 而 `submit` 每次都会 `this._lastReport.set(key, now)`。
     *
     * 实测（修复前）：`new ReportCenter({cooldownMs: 0, dailyLimit: 5})`，
     * 50 个不同举报人各提交 1 次 → `_lastReport` 大小 = **50**（全部留存）。
     *
     * `_lastReport` 的规模是"举报人 × 被举报人"的笛卡尔积量级，
     * 大 DAU 下几周就能涨到百万级条目，
     * 且 `prune` 返回 0 看起来"很正常"，没有任何日志或指标提示。
     *
     * 【两条都做】
     * 1. 早退改为"只跳过冷却表，仍清每日计数"
     * 2. 更根本的：没有冷却就**不必记录**上次举报时间（见 submit 侧）
     */
    if (this._cooldownMs <= 0) {
      // 只清每日计数，冷却表在无冷却配置下本就不该有内容
      this._pruneDaily(now);
      return 0;
    }
    const before = this._lastReport.size;
    for (const [k, at] of this._lastReport) {
      if (now - at >= this._cooldownMs) this._lastReport.delete(k);
    }
    this._pruneDaily(now);
    return before - this._lastReport.size;
  }

  /** 清掉非今天的每日计数（跨天后旧数据没用了） */
  private _pruneDaily(now: number): void {
    const today = Math.floor(now / 86_400_000);
    for (const [k, v] of this._dailyCount) {
      if (v.day !== today) this._dailyCount.delete(k);
    }
  }

  /** 清空全部状态（换服 / 重置测试用） */
  clear(): void {
    this._tickets = [];
    this._lastReport.clear();
    this._dailyCount.clear();
    this._rejected.clear();
  }

  /** 同 clear()，符合铁律「可卸载」 */
  destroy(): void {
    this.clear();
  }

  /** 冷却记录条数（排查内存时用） */
  get cooldownSize(): number {
    return this._lastReport.size;
  }

  /** 某人的举报冷却剩余时间（毫秒） */
  cooldownRemaining(reporterId: string, targetId: string, now: number): number {
    const key = `${reporterId}→${targetId}`;
    const last = this._lastReport.get(key);
    if (last === undefined) return 0;
    return Math.max(0, last + this._cooldownMs - now);
  }

  /** 今日剩余可举报次数 */
  remainingToday(reporterId: string, now: number): number {
    const day = Math.floor(now / 86_400_000);
    const rec = this._dailyCount.get(reporterId);
    if (!rec || rec.day !== day) return this._dailyLimit;
    return Math.max(0, this._dailyLimit - rec.n);
  }
}

// ==================== 便捷 ====================

/**
 * 举报理由的默认权重
 *
 * 【用途】
 * 不同严重程度的举报不该一视同仁。
 * 开挂 1 条 ≈ 挂机 5 条。
 */
export const REASON_SEVERITY: Readonly<Record<ReportReason, number>> = {
  'cheating': 5,
  'griefing': 2,
  'abusive-chat': 2,
  'afk': 1,
  'inappropriate-name': 1.5,
  'other': 1,
};

/**
 * 按理由加权的总分（**排序用**，不要拿它和 actionThreshold 比较）
 *
 * 【⚠️ 两套"权重"的口径完全不同，别混用】
 *
 * | | `weightOf()`（实例方法） | `severityWeighted()`（本函数） |
 * |---|---|---|
 * | 公式 | `credibility / 100` | `credibility / 100 × 理由权重` |
 * | 范围 | 0.2 ~ 1.0 | 0.2 ~ 5.0 |
 * | 含理由 | ❌ 只看人可不可信 | ✅ 开挂 1 条 ≈ 挂机 5 条 |
 * | 用途 | **判定是否处理**（`needsAction`） | **排序审核队列**（先看谁） |
 *
 * `actionThreshold`（默认 3）比较的是 `weightOf` 的累加值，
 * 也就是"有几个可信的人举报"，与理由无关。
 *
 * 拿本函数的返回值去和 `actionThreshold` 比，
 * 会让"1 条作弊举报"（5.0）直接越过"3 个可信玩家"（3.0）的门槛——
 * 这不是设计意图，是口径错配。
 *
 * 【为什么两个都要有】
 * 判定门槛必须只看"举报人可不可信"（理由严重程度是主观的，
 * 而且会让"大家都说开挂"自动触发处罚）；
 * 但排序时确实该让开挂排在挂机前面。
 */
export function severityWeighted(
  tickets: readonly ReportTicket[],
  cfg?: ReportConfig
): number {
  const minWeight = cfg?.minWeight ?? DEFAULTS.minWeight;
  let sum = 0;
  for (const t of tickets) {
    const cred = Math.max(minWeight, t.reporterCredibility / 100);
    sum += cred * (REASON_SEVERITY[t.reason] ?? 1);
  }
  return sum;
}

/**
 * 信誉分更新
 *
 * 【设计原则】
 * - 信誉分**难降易升**（保护被误伤的玩家）
 * - 有下限，且下限不是 0（0 分的人没有动力变好）
 * - 长期无违规可以慢慢恢复
 *
 * @param current 当前信誉分 0~100
 * @param delta 变化量（正 = 加分，负 = 扣分）
 */
export function updateCredibility(current: number, delta: number): number {
  /**
   * 【⚠️ 不对称设计】
   * 扣分按 1.0 倍，加分按 0.5 倍。
   *
   * 理由：如果加分和扣分一样快，
   * 玩家可以"违规 → 被扣 → 老实几天 → 恢复 → 再违规"。
   * 让恢复比下降慢，才能让信誉分真正代表"长期表现"。
   */
  const effective = delta < 0 ? delta : delta * 0.5;
  return clamp(current + effective, 10, 100);
}
