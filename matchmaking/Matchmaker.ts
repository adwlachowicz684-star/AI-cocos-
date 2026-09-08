/**
 * matchmaking/Matchmaker.ts —— 撮合队列
 *
 * 【它解决什么】
 *
 * "把分数接近的人放到一起"听起来是个排序问题，
 * 实际是个**时间与质量的取舍**：
 *
 * - 窗口太窄 → 等 10 分钟排不到人
 * - 窗口太宽 → 300 分和 2000 分排到一起，两边都不爽
 *
 * 所以真实的匹配器必须做三件事：
 *
 * 1. **窗口随等待时间放宽**
 *    刚进队列只接受 ±50 分；等了 60 秒放宽到 ±200；
 *    等太久就不管分数了（宁可质量差也不能让人干等）。
 *
 * 2. **范围必须双向成立**
 *    ⚠️ 这是最常见的 bug：只检查"A 能接受 B"，
 *    结果刚进队列的 2000 分大佬被等了 5 分钟、窗口已放宽到 ±800 的 500 分新手"捞"进去。
 *    大佬当场退出游戏。
 *
 * 3. **组队不可拆**
 *    三个人组队排进去，必须进同一个队。
 *    如果队伍塞不下，宁可继续等，也不能拆散。
 *
 * 【零业务依赖】
 * 它不认识"玩家"，只认识"带分数的条目"。
 * 分数从哪来（ELO / Glicko 保守分 / 你自己算的）由你决定。
 */

import { clamp, maxOf, minOf } from '../_core/math';

// ==================== 类型 ====================

export interface QueueEntry {
  /** 唯一标识 */
  readonly id: string;
  /**
   * 匹配用分数
   *
   * 【⚠️ 建议传 Glicko 的保守分 `rating - 2*rd`】
   * 直接传真实分的话，新号（真实水平未知）会被当成固定水平的玩家，
   * 导致他第一局就炸鱼或者被虐。
   */
  readonly rating: number;
  /**
   * 组队标识。相同 partyId 的条目**必定进同一队**
   *
   * 【为什么用 id 而不是数组】
   * 让调用方自己决定"谁和谁一队"，
   * 匹配器不需要知道队伍是怎么组成的。
   */
  readonly partyId?: string;
  /** 位置偏好（坦克/输出/辅助…）。留空表示无所谓 */
  readonly role?: string;
  /** 附加数据（等级、地区、模式…），原样透传到 match 里 */
  readonly meta?: unknown;
}

export interface MatchmakerConfig {
  /** 每队人数 */
  readonly teamSize: number;
  /** 每场几队（2 = 对称对抗，8 = 吃鸡式混战） */
  readonly teamsPerMatch?: number;

  /** 初始可接受分差（默认 50） */
  readonly initialRange?: number;
  /** 每秒放宽多少分（默认 3） */
  readonly rangeGrowthPerSec?: number;
  /** 分差上限（默认 500） */
  readonly maxRange?: number;

  /**
   * 等待多久后强制撮合（毫秒，默认 180000 = 3 分钟）
   *
   * 【为什么必须有】
   * 凌晨 3 点在线人数少，严格按分数匹配可能永远排不到。
   * 超时后忽略分数限制，先开局再说。
   */
  readonly guaranteedAfterMs?: number;

  /**
   * 是否做队伍平衡（默认 true）
   *
   * false = 按进队顺序简单切分（快，但两队强度可能差很多）
   */
  readonly balanceTeams?: boolean;

  /** 质量下限：撮合出来的对局质量低于此值时宁可继续等（0~1） */
  readonly minQuality?: number;
}

export interface Match {
  /** 每个队是一组条目 */
  readonly teams: readonly QueueEntry[][];
  /** 质量评分 0~1，1 = 所有人分数完全相同 */
  readonly quality: number;
  /** 本场中等待最久的人等了多久（毫秒） */
  readonly maxWaitMs: number;
  readonly avgWaitMs: number;
  /** 是否因超时放宽了限制（UI 上可提示"快速匹配"） */
  readonly relaxed: boolean;
  /** 各队平均分，用于调试与展示 */
  readonly teamRatings: readonly number[];
}

/** 队列中的内部条目 */
interface Queued {
  readonly entry: QueueEntry;
  readonly joinedAt: number;
  readonly partySize: number;
}

/**
 * 撮合单位：要么是一个人，要么是一整个队伍
 *
 * 【为什么需要这层抽象】
 * 组队的人必须同进同出，不能按个体计算。
 * 抽象成"单位"之后，分队逻辑就能统一处理两者。
 */
interface Group {
  readonly key: string;
  readonly members: readonly Queued[];
  readonly joinedAt: number;
  readonly rating: number;
}

// ==================== 默认值 ====================

const DEFAULTS = {
  teamsPerMatch: 2,
  initialRange: 50,
  rangeGrowthPerSec: 3,
  maxRange: 500,
  guaranteedAfterMs: 180_000,
  balanceTeams: true,
  minQuality: 0,
};

// ==================== 实现 ====================

export class Matchmaker {
  private readonly _teamSize: number;
  private readonly _teamsPerMatch: number;
  private readonly _initialRange: number;
  private readonly _growthPerSec: number;
  private readonly _maxRange: number;
  private readonly _guaranteedAfterMs: number;
  private readonly _balance: boolean;
  private readonly _minQuality: number;

  private _queue: Queued[] = [];

  /** 统计：累计撮合场次 */
  private _matchesMade = 0;

  constructor(cfg: MatchmakerConfig) {
    if (!Number.isInteger(cfg.teamSize) || cfg.teamSize < 1) {
      throw new Error(`[Matchmaker] teamSize 必须是正整数，收到 ${cfg.teamSize}`);
    }
    const teams = cfg.teamsPerMatch ?? DEFAULTS.teamsPerMatch;
    if (!Number.isInteger(teams) || teams < 1) {
      throw new Error(`[Matchmaker] teamsPerMatch 必须是正整数，收到 ${teams}`);
    }

    this._teamSize = cfg.teamSize;
    this._teamsPerMatch = teams;
    this._initialRange = cfg.initialRange ?? DEFAULTS.initialRange;
    this._growthPerSec = cfg.rangeGrowthPerSec ?? DEFAULTS.rangeGrowthPerSec;
    this._maxRange = cfg.maxRange ?? DEFAULTS.maxRange;
    this._guaranteedAfterMs = cfg.guaranteedAfterMs ?? DEFAULTS.guaranteedAfterMs;
    this._balance = cfg.balanceTeams ?? DEFAULTS.balanceTeams;
    this._minQuality = cfg.minQuality ?? DEFAULTS.minQuality;
  }

  // ==================== 查询 ====================

  /** 每场需要的总人数 */
  get matchSize(): number {
    return this._teamSize * this._teamsPerMatch;
  }

  get queueSize(): number {
    return this._queue.length;
  }

  /** 队列中的玩家 id（按入队顺序） */
  get waiting(): string[] {
    return this._queue.map((q) => q.entry.id);
  }

  get matchesMade(): number {
    return this._matchesMade;
  }

  /** 某人的等待时长（毫秒），不在队列中返回 -1 */
  waitOf(id: string, now: number): number {
    const q = this._queue.find((x) => x.entry.id === id);
    return q ? now - q.joinedAt : -1;
  }

  // ==================== 入队 / 出队 ====================

  /**
   * 加入队列
   *
   * @param entries 一个人，或一整个队伍（必须同 partyId 且一起传入）
   */
  enqueue(entries: readonly QueueEntry[], now: number): boolean {
    if (entries.length === 0) return false;

    /**
     * 【⚠️ 队伍不能超过 teamSize】
     * 5v5 里塞进一个 6 人黑店，永远撮合不出来。
     * 必须在入队时就拒绝，而不是让他在队列里干等。
     */
    if (entries.length > this._teamSize) {
      throw new Error(
        `[Matchmaker] 队伍 ${entries.length} 人超过每队上限 ${this._teamSize}，永远撮合不出来。` +
        `（如果这些人并非组队，请改用 enqueueAll）`
      );
    }

    const ids = new Set(entries.map((e) => e.id));
    if (ids.size !== entries.length) {
      throw new Error('[Matchmaker] 入队条目中有重复 id');
    }
    for (const e of entries) {
      if (this._queue.some((q) => q.entry.id === e.id)) {
        throw new Error(`[Matchmaker] ${e.id} 已在队列中`);
      }
    }

    const partySize = entries.length;
    for (const e of entries) {
      this._queue.push({ entry: e, joinedAt: now, partySize });
    }
    return true;
  }

  /**
   * 批量入队（每个人独立，按 partyId 自动成组）
   *
   * 【为什么需要它，而 enqueue 不够】
   * `enqueue(entries)` 的语义是"这一批人是一支队伍"——
   * 传 10 个散人进去会被当成一个 10 人黑店，直接触发超限报错。
   *
   * 而 `enqueueAll` 会按 partyId 分组：
   * - 有 partyId 的 → 同组，必须同队
   * - 没有 partyId 的 → 各自独立
   *
   * 【原子性】
   * 任何一个条目非法或超限，则**一个都不加**。
   * 加一半失败会让队列处于部分状态，调用方很难处理。
   *
   * @returns 成功入队的人数
   */
  enqueueAll(entries: readonly QueueEntry[], now: number): number {
    if (entries.length === 0) return 0;

    // ① 先分组并校验，确认无误再写入
    const groups = new Map<string, QueueEntry[]>();
    for (const e of entries) {
      const key = e.partyId ?? `#solo:${e.id}`;
      const arr = groups.get(key);
      if (arr) arr.push(e);
      else groups.set(key, [e]);
    }

    for (const [key, members] of groups) {
      if (members.length > this._teamSize) {
        throw new Error(
          `[Matchmaker] 队伍 "${key}" 有 ${members.length} 人，超过每队上限 ` +
          `${this._teamSize}，永远撮合不出来`
        );
      }
    }

    const existing = new Set(this._queue.map((q) => q.entry.id));
    for (const e of entries) {
      if (existing.has(e.id)) {
        throw new Error(`[Matchmaker] ${e.id} 已在队列中`);
      }
      existing.add(e.id);
    }

    // ② 全部校验通过，写入
    let count = 0;
    for (const [, members] of groups) {
      for (const e of members) {
        this._queue.push({ entry: e, joinedAt: now, partySize: members.length });
        count++;
      }
    }
    return count;
  }

  /** 离开队列 */
  dequeue(id: string): boolean {
    const i = this._queue.findIndex((q) => q.entry.id === id);
    if (i < 0) return false;

    /**
     * 【⚠️ 组队的人退了，全队一起退】
     * 只退他一个的话，剩下的人会被当成一个残缺的队伍撮合出去，
     * 表现为"队友掉线了但游戏还是开了"。
     */
    const partyId = this._queue[i].entry.partyId;
    if (partyId) {
      this._queue = this._queue.filter((q) => q.entry.partyId !== partyId);
    } else {
      this._queue.splice(i, 1);
    }
    return true;
  }

  clear(): void {
    this._queue = [];
  }

  // ==================== 撮合 ====================

  /**
   * 每帧/每秒调用一次
   *
   * @returns 本轮撮合出的对局（可能为空数组）
   *
   * 【典型用法】
   * ```typescript
   * setInterval(() => {
   *   for (const m of mm.tick(Date.now())) startGame(m);
   * }, 1000);
   * ```
   */
  tick(now: number): Match[] {
    const matches: Match[] = [];

    /**
     * 【为什么循环而不是只撮合一局】
     * 队列里有 50 人时，一轮应该撮出 5 场，而不是每秒一场。
     */
    for (;;) {
      const m = this._tryMatch(now);
      if (!m) break;
      matches.push(m);
      this._matchesMade++;
    }
    return matches;
  }

  // ==================== 内部 ====================

  /** 尝试撮合一场 */
  private _tryMatch(now: number): Match | null {
    if (this._queue.length < this.matchSize) return null;

    // ① 打包成"组"：一个组要么是一个人，要么是一整个队伍
    const groups = this._packGroups();

    // ② 等待最久的组优先当锚点（他最有资格挑对手）
    groups.sort((a, b) => a.joinedAt - b.joinedAt);

    for (const anchor of groups) {
      const range = this._rangeFor(anchor, now);
      const relaxed = now - anchor.joinedAt >= this._guaranteedAfterMs;

      // ③ 收集候选：⚠️ 必须双向可达（除非已超时兜底）
      const candidates = groups.filter(
        (g) =>
          g !== anchor &&
          (relaxed || this._mutuallyAcceptable(anchor, g, now, range))
      );

      /**
       * 【⚠️ 这里必须数"人"，不能数"组"】
       *
       * 写成 `candidates.length + 1 < matchSize` 的话，
       * 全是散人时组数恰好等于人数，看不出问题；
       * 一旦有组队（3 人黑店 + 3 个散人 = 4 组 6 人），
       * 4 + 1 = 5 < 6 会被判定"人不够"，永远撮合不出来。
       *
       * 这是本批测试抓到的第二个实现 bug。
       */
      const anchorCount = anchor.members.length;
      const candidateCount = candidates.reduce((a, g) => a + g.members.length, 0);
      if (candidateCount + anchorCount < this.matchSize) continue;

      // ④ 候选可能远多于需要的人数，只取最合适的一批
      const picked = this._pickBest(anchor, candidates, range, relaxed);
      if (!picked) continue;

      // ⑤ 分队（可能因为塞不下而失败）
      const teams = this._formTeams(picked);
      if (!teams) continue;

      const flat = teams.flat();
      const quality = matchQuality(flat.map((q) => q.entry.rating), this._teamSize);
      if (quality < this._minQuality && !relaxed) continue;

      // ⑥ 从队列移除，避免被下一轮重复撮合
      const usedIds = new Set(flat.map((q) => q.entry.id));
      this._removeAll(usedIds);

      const waits = picked.map((g) => now - g.joinedAt);

      return {
        teams: teams.map((t) => t.map((q) => q.entry)),
        quality,
        // 【为什么用 maxOf】waits 为空时 Math.max(...[]) 返回 -Infinity，
        // 下游 `if (maxWaitMs > 阈值)` 会恒为 false——"等待超时"逻辑永远不触发。
        maxWaitMs: maxOf(waits, 0),
        // 【为什么顺带改这里】waits 为空时 reduce 得 0，0 / 0 = NaN。
        // NaN 的 avgWaitMs 会让任何"平均等待"的比较恒为 false。
        avgWaitMs: waits.length > 0 ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
        relaxed,
        teamRatings: teams.map((t) => avg(t.map((q) => q.entry.rating))),
      };
    }

    return null;
  }

  /**
   * 打包成组
   *
   * 组队的人共享一个 joinedAt（取全队最早的），
   * 否则"队伍里有人先按了准备"会让整队获得不公平的优先级。
   */
  private _packGroups(): Group[] {
    const byParty = new Map<string, Queued[]>();

    for (const q of this._queue) {
      const key = q.entry.partyId ?? `#solo:${q.entry.id}`;
      const arr = byParty.get(key);
      if (arr) arr.push(q);
      else byParty.set(key, [q]);
    }

    const out: Group[] = [];
    for (const [key, members] of byParty) {
      out.push({
        key,
        members,
        // 【为什么用 minOf】members 来自 Map 的值，理论上非空；
        // 但"理论非空"正是空数组 bug 的温床——一旦上游改成分组后再过滤，
        // 这里就会静默返回 Infinity（早于任何时间戳），把队首判定搞反。
        joinedAt: minOf(members.map((m) => m.joinedAt), 0),
        rating: avg(members.map((m) => m.entry.rating)),
      });
    }
    return out;
  }

  /** 当前可接受的分差窗口 */
  private _rangeFor(group: Pick<Group, 'joinedAt'>, now: number): number {
    const waitSec = Math.max(0, (now - group.joinedAt) / 1000);
    return Math.min(this._maxRange, this._initialRange + this._growthPerSec * waitSec);
  }

  /**
   * 双向可达判断
   *
   * 【⚠️ 这是整个匹配器最关键的方法】
   *
   * 只判断一边的话：
   * - A 等了 5 分钟，窗口 ±800
   * - B 刚进队列，窗口 ±50
   * - A 觉得 B 可以接受（|Ra - Rb| < 800）
   * - 于是撮合成功，B 当场被分差 700 的对手打崩
   *
   * 正确做法是取两者窗口的**较小值**——
   * 只有当双方都觉得对方可以接受时才撮合。
   */
  private _mutuallyAcceptable(
    a: Group,
    b: Group,
    now: number,
    rangeA: number
  ): boolean {
    const rangeB = this._rangeFor(b, now);
    const allowed = Math.min(rangeA, rangeB);
    return Math.abs(a.rating - b.rating) <= allowed;
  }

  /**
   * 从候选里挑最合适的一批
   *
   * 【策略】优先挑分差小的，其次挑等待久的。
   *
   * 注意这里不能简单"按分差排序取前 N 个"——
   * 那样会让等待最久的人永远排在后面（因为他分差大）。
   */
  private _pickBest(
    anchor: Group,
    candidates: readonly Group[],
    range: number,
    relaxed: boolean
  ): Group[] | null {
    const needed = this.matchSize - anchor.members.length;
    if (needed < 0) return null;

    // 先按分差排序（质量优先）
    let sorted = candidates
      .slice()
      .sort((x, y) => {
        const dx = Math.abs(x.rating - anchor.rating);
        const dy = Math.abs(y.rating - anchor.rating);
        if (dx !== dy) return dx - dy;
        // 同分差时，等得久的优先
        return x.joinedAt - y.joinedAt;
      });

    /**
     * 【⚠️ 超时兜底要在两处都放开】
     *
     * 第一处在候选收集（`_mutuallyAcceptable` 之前短路），
     * 第二处在这里的 filter。
     *
     * 只放开一处的后果：前一道把候选筛没了，
     * 后一道拿到空数组，兜底完全失效 ——
     * 凌晨人少时玩家排队到超时也进不去游戏，
     * 而这恰恰是"保证撮合"唯一该起作用的场景。
     */
    if (!relaxed) {
      sorted = sorted.filter((g) => Math.abs(g.rating - anchor.rating) <= range);
    }

    // 贪心填充：优先选能正好填满的组合
    const picked: Group[] = [];
    let count = 0;
    for (const g of sorted) {
      if (count + g.members.length > needed) continue;
      picked.push(g);
      count += g.members.length;
      if (count === needed) break;
    }

    if (count !== needed) return null;
    return [anchor, ...picked];
  }

  /**
   * 把一批组分到各队
   *
   * 【算法】
   * 1. 按组分降序，蛇形分配（1,2,3 | 3,2,1 | 1,2,3…）
   * 2. 若开启平衡，再做局部交换优化
   *
   * 蛇形分配保证了"每队都有一个最强的人"，
   * 比顺序切分（前 5 名一队）公平得多。
   */
  private _formTeams(groups: readonly Group[]): Queued[][] | null {
    const teams: Queued[][] = Array.from({ length: this._teamsPerMatch }, () => []);
    const sizes = new Array(this._teamsPerMatch).fill(0);

    // 大队伍先放（否则会出现"剩 2 个空位但来了个 3 人黑店"）
    const sorted = groups
      .slice()
      .sort((a, b) => b.members.length - a.members.length || b.rating - a.rating);

    for (const g of sorted) {
      // 找一个塞得下的、当前人数最少的队
      let best = -1;
      for (let t = 0; t < this._teamsPerMatch; t++) {
        if (sizes[t] + g.members.length > this._teamSize) continue;
        if (best < 0 || sizes[t] < sizes[best]) best = t;
      }
      if (best < 0) return null;   // 塞不下

      teams[best].push(...g.members);
      sizes[best] += g.members.length;
    }

    if (sizes.some((s) => s !== this._teamSize)) return null;

    if (this._balance) {
      this._balanceTeams(teams);
    }
    return teams;
  }

  /**
   * 局部交换优化
   *
   * 【为什么蛇形之后还要优化】
   * 蛇形是贪心，遇到 [2000, 1900, 1000, 900] 这种分布时会给出
   * (2000,1000) vs (1900,900)，两队都差 100 —— 已经很好。
   * 但遇到 [2000, 1500, 1500, 1000] 时蛇形给出
   * (2000,1500) vs (1500,1000)，差 500 —— 而最优是
   * (2000,1000) vs (1500,1500)，差 0。
   *
   * 局部搜索能修掉这类情况。
   */
  private _balanceTeams(teams: Queued[][]): void {
    const ratingOf = (t: readonly Queued[]): number => avg(t.map((q) => q.entry.rating));

    let improved = true;
    let guard = 0;
    while (improved && guard < 200) {
      improved = false;
      guard++;

      const ratings = teams.map(ratingOf);
      let worstI = 0;
      let worstJ = 0;
      let maxDiff = -1;
      for (let i = 0; i < ratings.length; i++) {
        for (let j = i + 1; j < ratings.length; j++) {
          const d = Math.abs(ratings[i] - ratings[j]);
          if (d > maxDiff) { maxDiff = d; worstI = i; worstJ = j; }
        }
      }
      if (maxDiff < 1e-9) break;

      // 在最强和最弱两队之间找一个能缩小差距的交换
      const hi = worstI;
      const lo = worstJ;
      if (ratings[hi] < ratings[lo]) { /* 保证 hi 更强 */ }
      const strong = ratings[hi] >= ratings[lo] ? hi : lo;
      const weak = strong === hi ? lo : hi;

      let bestSwap: { a: number; b: number; gain: number } | null = null;
      for (let a = 0; a < teams[strong].length; a++) {
        for (let b = 0; b < teams[weak].length; b++) {
          const ra = teams[strong][a].entry.rating;
          const rb = teams[weak][b].entry.rating;
          const newStrong = ratings[strong] * teams[strong].length - ra + rb;
          const newWeak = ratings[weak] * teams[weak].length - rb + ra;
          const before = Math.abs(ratings[strong] - ratings[weak]);
          const after =
            Math.abs(newStrong / teams[strong].length - newWeak / teams[weak].length);
          const gain = before - after;
          if (gain > 1e-9 && (!bestSwap || gain > bestSwap.gain)) {
            bestSwap = { a, b, gain };
          }
        }
      }

      if (bestSwap) {
        const tmp = teams[strong][bestSwap.a];
        teams[strong][bestSwap.a] = teams[weak][bestSwap.b];
        teams[weak][bestSwap.b] = tmp;
        improved = true;
      }
    }
  }

  private _removeAll(ids: ReadonlySet<string>): void {
    this._queue = this._queue.filter((q) => !ids.has(q.entry.id));
  }
}

// ==================== 辅助（也对外暴露） ====================

function avg(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * 对局质量评分 0~1
 *
 * 【怎么算】
 * 用队伍平均分的相对离散度。
 * 所有人分数相同 → 1；分差极大 → 接近 0。
 *
 * 【用途】
 * - 撮合时设 minQuality 卡质量
 * - 结算时展示"本局匹配质量"
 * - A/B 测试不同匹配参数的效果
 */
export function matchQuality(ratings: readonly number[], teamSize: number): number {
  if (ratings.length === 0) return 0;
  const mean = avg(ratings);
  if (ratings.length === 1) return 1;

  let variance = 0;
  for (const r of ratings) variance += (r - mean) * (r - mean);
  variance /= ratings.length;
  const sd = Math.sqrt(variance);

  /**
   * 用 teamSize 做尺度：
   * 标准差达到 300 分（约等于 ELO 里 85% 胜率的分差）时质量记为 0。
   */
  const scale = 200 + 20 * teamSize;
  return clamp(1 - sd / scale, 0, 1);
}

/**
 * 估算等待时间（毫秒）
 *
 * 【用途】UI 上显示"预计等待 45 秒"
 *
 * 【怎么估】
 * 基于当前队列人数与历史撮合速率。
 * 这是个粗略估计，给玩家的是"数量级感受"而不是精确承诺——
 * 精确承诺做不到，而且做不到的承诺比不给更糟。
 */
export function estimateWaitMs(
  queueSize: number,
  matchSize: number,
  avgMatchesPerMinute: number
): number {
  if (avgMatchesPerMinute <= 0) return Number.POSITIVE_INFINITY;
  const peoplePerMinute = avgMatchesPerMinute * matchSize;
  const aheadOfYou = Math.max(0, Math.floor(queueSize / matchSize) * matchSize);
  return (aheadOfYou / peoplePerMinute) * 60_000;
}
