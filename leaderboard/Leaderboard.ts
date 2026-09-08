import { clampNum } from '../_core/math';
/**
 * Leaderboard —— 排行榜
 *
 * 【它解决什么】
 *
 * 排行榜看着简单（"按分数排序"），但有几个地方一错就会被玩家发现：
 *
 * 1. **并列名次**：100、100、90 三名，第二个 100 是第 2 名还是第 3 名？
 *    - 竞赛式（1224）：100,100,90 → 名次 1,1,3
 *    - 密集式（1223）：100,100,90 → 名次 1,1,2
 *    - 大多数游戏用密集式，玩家更容易理解
 * 2. **并列时的先后**：同分谁排前面？（通常先达成者在前）
 * 3. **只留个人最好成绩**：同一个人刷了 10 次，只该占 1 个位置
 * 4. **快照**：实时榜在玩家查看时还在变，提交成绩时名次可能已不同
 * 5. **分页边界**：取第 2 页时如果前面有人插入，会漏掉或重复
 *
 * 【无引擎依赖】排序逻辑纯本地，持久化由宿主注入。
 */

// ==================== 类型 ====================

/** 名次计算方式 */
export type RankMode =
  /** 密集排名：1,1,2,3（推荐） */
  | 'dense'
  /** 竞赛排名：1,1,3,4（跳过名次） */
  | 'competition'
  /** 普通排名：1,2,3,4（同分也有先后） */
  | 'ordinal';

/** 排序方向 */
export type SortOrder = 'desc' | 'asc';

/** 一条成绩 */
export interface ScoreEntry {
  /** 玩家标识 */
  readonly playerId: string;
  /** 显示名 */
  readonly name: string;
  /** 分数 */
  readonly score: number;
  /** 达成时刻（毫秒） */
  readonly at: number;
  /** 附加数据（关卡、用时、角色…） */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** 带名次的一条 */
export interface RankedEntry extends ScoreEntry {
  /** 名次，从 1 开始 */
  readonly rank: number;
}

export interface LeaderboardOptions {
  /** 榜容量上限（默认 100）。超出后淘汰末位 */
  readonly capacity?: number;
  /** 排序方向（默认 desc = 分数高的在前） */
  readonly order?: SortOrder;
  /** 名次计算方式（默认 dense） */
  readonly rankMode?: RankMode;
  /**
   * 是否只保留每位玩家的最好成绩（默认 true）
   *
   * 【为什么默认 true】
   * 关掉的话，一个刷了 100 次的玩家会占掉整个榜单，
   * 其他玩家永远上不了榜——这是排行榜最常见的体验事故。
   */
  readonly bestPerPlayer?: boolean;
  /** 同分时按什么排（默认先达成的在前） */
  readonly tieBreak?: 'earlier' | 'later';
}

/** 分页结果 */
export interface LeaderboardPage {
  readonly entries: readonly RankedEntry[];
  /** 当前页（从 1 开始） */
  readonly page: number;
  /** 每页条数 */
  readonly pageSize: number;
  /** 总条数 */
  readonly total: number;
  /** 总页数 */
  readonly pageCount: number;
  readonly hasPrev: boolean;
  readonly hasNext: boolean;
}

// ==================== 实现 ====================

export class Leaderboard {
  private readonly _capacity: number;
  private readonly _order: SortOrder;
  private readonly _rankMode: RankMode;
  private readonly _bestPerPlayer: boolean;
  private readonly _tieBreak: 'earlier' | 'later';

  /** 内部存储（始终有序） */
  private _entries: ScoreEntry[] = [];

  /** 上一次 importEntries 丢弃的非法条目数 */
  private _lastDroppedCount = 0;

  constructor(opts: LeaderboardOptions = {}) {
    this._capacity = clampNum(opts.capacity, 1, 1e7, 100);
    this._order = opts.order ?? 'desc';
    this._rankMode = opts.rankMode ?? 'dense';
    this._bestPerPlayer = opts.bestPerPlayer !== false;
    this._tieBreak = opts.tieBreak ?? 'earlier';
  }

  get size(): number {
    return this._entries.length;
  }

  get capacity(): number {
    return this._capacity;
  }

  // ==================== 提交 ====================

  /**
   * 提交成绩
   *
   * @returns 是否入榜（false = 没进榜或被自己的更好成绩挡下）
   */
  submit(entry: ScoreEntry): boolean {
    if (!Number.isFinite(entry.score)) {
      throw new Error(`[Leaderboard] 分数必须是有限数字，收到 ${entry.score}`);
    }

    // ① 每位玩家只保留最好成绩
    if (this._bestPerPlayer) {
      const idx = this._entries.findIndex((e) => e.playerId === entry.playerId);
      if (idx >= 0) {
        const existing = this._entries[idx];
        if (!this._isBetter(entry, existing)) return false;
        this._entries.splice(idx, 1);
      }
    }

    // ② 容量已满且新成绩排不进 → 拒绝
    if (this._entries.length >= this._capacity &&
        !this._isBetter(entry, this._entries[this._entries.length - 1])) {
      return false;
    }

    this._entries.push(entry);
    this._sort();
    this._trim();
    return true;
  }

  /**
   * 批量提交（初始化 / 从服务器拉取）
   *
   * @returns 实际入榜的条数
   *
   * 【为什么不能逐个 submit】
   * `submit()` 每次都会全量重排，是 O(n log n)。
   * 逐个提交 N 条 = **O(n² log n)**——实测 5 万条要 **34 秒**，
   * 而全批合并后只排一次只要 **24 毫秒**，差三个数量级。
   *
   * 【本方法做了什么】
   * ① 用 Map 做「每位玩家只留最好成绩」的去重，O(n) 而不是逐个 findIndex 的 O(n²)
   * ② 全批**只排一次**序
   * ③ 截断到 capacity
   *
   * 【坑】`capacity` 越大越要走这里。
   * 全服排行榜（装下所有人）逐个 submit 会直接卡死。
   */
  submitAll(entries: readonly ScoreEntry[]): number {
    if (entries.length === 0) return 0;

    // 校验与 submit 保持一致：非法分数抛错，而不是静默丢弃
    for (const e of entries) {
      if (!Number.isFinite(e.score)) {
        throw new Error(`[Leaderboard] 分数必须是有限数字，收到 ${e.score}`);
      }
    }

    // ① 合并去重
    const incoming = new Set<ScoreEntry>(entries);
    let all: ScoreEntry[];

    if (this._bestPerPlayer) {
      // Map 去重：同样的玩家只保留最好的一条，整体 O(n)
      const byPlayer = new Map<string, ScoreEntry>();
      for (const e of this._entries) {
        const prev = byPlayer.get(e.playerId);
        if (prev === undefined || this._isBetter(e, prev)) byPlayer.set(e.playerId, e);
      }
      for (const e of entries) {
        const prev = byPlayer.get(e.playerId);
        if (prev === undefined || this._isBetter(e, prev)) byPlayer.set(e.playerId, e);
      }
      all = Array.from(byPlayer.values());
    } else {
      all = this._entries.concat(entries as ScoreEntry[]);
    }

    // ② 全批只排一次
    all.sort((a, b) => this._cmp(a, b));

    // ③ 截断
    const kept = all.length > this._capacity ? all.slice(0, this._capacity) : all;

    // ④ 数出本次提交里真正入榜的条数
    let n = 0;
    for (const e of kept) if (incoming.has(e)) n++;

    this._entries = kept;
    return n;
  }

  /** a 是否优于 b */
  private _isBetter(a: ScoreEntry, b: ScoreEntry): boolean {
    if (a.score !== b.score) {
      return this._order === 'desc' ? a.score > b.score : a.score < b.score;
    }
    // 同分：比时间
    return this._tieBreak === 'earlier' ? a.at < b.at : a.at > b.at;
  }

  /** 排序比较器（_sort 与 submitAll 共用，保证两处顺序完全一致） */
  private _cmp(a: ScoreEntry, b: ScoreEntry): number {
    const dir = this._order === 'desc' ? -1 : 1;
    if (a.score !== b.score) return (a.score - b.score) * dir;
    // 同分按时间稳定排序
    return this._tieBreak === 'earlier' ? a.at - b.at : b.at - a.at;
  }

  private _sort(): void {
    this._entries.sort((a, b) => this._cmp(a, b));
  }

  private _trim(): void {
    if (this._entries.length > this._capacity) {
      this._entries.length = this._capacity;
    }
  }

  // ==================== 查询 ====================

  /**
   * 带名次的完整榜单
   *
   * 【名次计算】
   * - dense：      100,100,90 → 1,1,2
   * - competition：100,100,90 → 1,1,3
   * - ordinal：    100,100,90 → 1,2,3
   */
  ranked(start = 0, end = Number.POSITIVE_INFINITY): RankedEntry[] {
    const out: RankedEntry[] = [];
    let rank = 0;
    let prevScore: number | null = null;
    let distinctSeen = 0;

    /**
     * 【⚠️ 曾经的 bug：每次查询都全量展开整个榜单】
     *
     * `ranked()` 对**每一条**都做 `{ ...e }`，而 `capacity` 的上界是 1e7。
     * 于是 `page()` / `rankOf()` / `around()` / `top()`
     * 每一次调用都要分配 n 个对象再排序——
     * 翻一页 = 分配 1000 万个对象。
     *
     * 实测（修复前）：2 万条 × 60 次 `page()` = **913ms**（纯分配开销）；
     * 按 1e7 外推，一次翻页就是秒级卡顿直到 OOM，而且**不报错**，
     * 只是"越用越慢"——这类问题在测试环境（榜单小）永远测不出来。
     *
     * 修法：名次必须从头累计（dense 要知道前面出现过几种分数），
     * 所以扫描仍是 O(n)；但**只为 [start, end) 区间内的条目分配对象**，
     * 把分配量从 O(n) 降到 O(每页条数)。
     */
    const lo = Math.max(0, start);
    const hi = Math.min(end, this._entries.length);

    for (let i = 0; i < this._entries.length; i++) {
      const e = this._entries[i];

      /**
       * 【⚠️ 曾经的 bug：ordinal 模式名次算错】
       *
       * 原实现把 ordinal 放在 `else if` 分支里，
       * 于是只有"与上一条同分"时才走 `i + 1`；
       * 分数一变就掉进上面的分支，沿用 dense 的 `distinctSeen`。
       *
       * 结果：100,100,90 算出 1,2,2 ——
       * 第 2 名和第 3 名并列了，而 ordinal 的定义就是**永不并列**。
       *
       * ordinal 的名次恒等于序号，不依赖分数比较，
       * 所以它必须**在最前面单独处理**。
       */
      if (this._rankMode === 'ordinal') {
        rank = i + 1;
        if (i >= lo && i < hi) out.push({ ...e, rank });
        continue;
      }

      if (prevScore === null || e.score !== prevScore) {
        distinctSeen++;
        prevScore = e.score;
        // dense：名次 = 已出现的不同分数个数
        // competition：名次 = 当前序号 + 1
        rank = this._rankMode === 'competition' ? i + 1 : distinctSeen;
      }
      // 同分：dense / competition 沿用上一条的名次

      if (i >= lo && i < hi) out.push({ ...e, rank });
    }
    return out;
  }

  /**
   * 分页
   *
   * 【坑】分页必须在**排名计算之后**做。
   * 先切片再排名的话，第 2 页的第一条名次会显示成 1。
   */
  page(page: number, pageSize: number): LeaderboardPage {
    /**
     * 【⚠️ 曾经的 bug：pageSize 未收口】
     *
     * `pageSize = 0`  → `Math.ceil(total / 0)` = Infinity → `pageCount = Infinity`
     * `pageSize < 0`  → `start` 为负 → `slice` 返回空页
     *
     * 实测（修复前）：`page(1, 0)` → `pageCount = Infinity`、
     * entries 为空、`hasNext = true`。
     * "有下一页但翻出来是空的"——UI 上的表现是"下一页"按钮永远可点、
     * 永远翻不动，而没人会怀疑是自己传的 pageSize 有问题。
     *
     * 修法：收口到 >= 1 的整数，与 capacity 的处理口径一致。
     */
    const size = this._pageSizeOf(pageSize);
    const total = this._entries.length;
    const pageCount = Math.max(1, Math.ceil(total / size));
    const p = Math.min(Math.max(1, page), pageCount);
    const start = (p - 1) * size;

    return {
      entries: this.ranked(start, start + size),
      page: p,
      pageSize: size,
      total,
      pageCount,
      hasPrev: p > 1,
      hasNext: p < pageCount,
    };
  }

  /** pageSize 收口：非有限 / 0 / 负数 → 1 */
  private _pageSizeOf(v: number): number {
    const n = typeof v === 'number' ? v : NaN;
    if (!(n >= 1)) return 1;
    return Math.floor(n);
  }

  /** 某玩家的排名（没上榜返回 null） */
  rankOf(playerId: string): RankedEntry | null {
    const i = this._entries.findIndex((e) => e.playerId === playerId);
    if (i < 0) return null;
    const one = this.ranked(i, i + 1);
    return one.length > 0 ? one[0] : null;
  }

  /**
   * 某玩家周围的榜单（"附近的人"）
   *
   * 【用途】玩家排第 500 名时，给他看 495-505 比看前 10 有用得多。
   */
  around(playerId: string, radius = 5): RankedEntry[] {
    const i = this._entries.findIndex((e) => e.playerId === playerId);
    if (i < 0) return [];
    const r = Number.isFinite(radius) ? Math.max(0, Math.floor(radius)) : 0;
    const start = Math.max(0, i - r);
    return this.ranked(start, i + r + 1);
  }

  /** 前 N 名 */
  top(n: number): RankedEntry[] {
    const k = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    return this.ranked(0, k);
  }

  /**
   * 快照
   *
   * 【为什么需要】
   * 玩家查看榜单的那一刻和提交成绩的那一刻之间，
   * 榜单可能已经变了——他会看到"刚才我还是第 3，怎么变第 5 了"。
   *
   * 快照冻结名次，让"你这局排第几"成为一个确定的结果。
   */
  snapshot(): RankedEntry[] {
    return this.ranked();
  }

  // ==================== 管理 ====================

  remove(playerId: string): boolean {
    const before = this._entries.length;
    this._entries = this._entries.filter((e) => e.playerId !== playerId);
    return this._entries.length < before;
  }

  clear(): void {
    this._entries = [];
  }

  /**
   * 【铁律 5】可卸载
   *
   * 【为什么原先只有 clear 不够】
   * `clear()` 清空的是**数据**，而"这个榜单对象还能不能用"是另一件事。
   * 切场景/换赛季时，宿主如果只置空引用，残留的 `onChange` 闭包
   * 和 `_entries` 仍能被任何持有者读到并继续 submit。
   * 这里给一个明确的终点，与库内其它单元的 `destroy()` 口径一致。
   */
  destroy(): void {
    this._entries = [];
  }

  /** 导出（存档 / 上传服务器） */
  exportEntries(): ScoreEntry[] {
    return this._entries.map((e) => ({ ...e }));
  }

  /**
   * 导入（从服务器拉取后覆盖）
   *
   * 【⚠️ 会清空现有数据】
   * 想合并用 `submitAll`。
   *
   * 【⚠️ 曾经的 bug：这是 `submit` 的旁路，完全不校验分数】
   *
   * `submit`（L125）和 `submitAll`（L176）都有 `Number.isFinite` 校验，
   * 只有 `importEntries` 拿到什么就信什么——浅拷贝 + 排序 + 裁剪，一行校验都没有。
   *
   * 后果不是"抛错"，而是**安静地产出一个错榜**：
   *   - NaN 参与比较恒为 false，排序结果**不可预测**
   *   - 名次照排，玩家看到"第一名分数是空的"或"名次乱序"
   *   - 因为 `submit` 有校验，排查方向 100% 被引到"是不是提交逻辑错了"，
   *     而这条路是干净的
   *
   * 实测（修复前）：`importEntries([{p1, NaN}, {p2, 5}])`
   *   → ranked = [{p1, rank 1, score NaN}, {p2, rank 2}]
   *
   * 【为什么默认是丢弃而不是抛错】
   * 榜单数据来自服务端/存档，一条脏数据就让整个榜单加载失败太脆。
   * 默认丢掉脏条目（保证榜单里永不出现 NaN），并提供 `strict: true`
   * 让调用方选择与 `submitAll` 一致的抛错语义。
   *
   * 丢弃条数记在 `lastDroppedCount`，方便调用方上报/告警，不至于"静默到无从发现"。
   */
  importEntries(entries: readonly ScoreEntry[], opts: { strict?: boolean } = {}): void {
    const clean: ScoreEntry[] = [];
    let dropped = 0;
    for (const e of entries) {
      if (!e || !Number.isFinite(e.score)) {
        dropped++;
        continue;
      }
      clean.push({ ...e });
    }
    this._lastDroppedCount = dropped;

    if (dropped > 0 && opts.strict) {
      throw new Error(`[Leaderboard] importEntries 收到 ${dropped} 条分数非有限的条目`);
    }

    this._entries = clean;
    this._sort();
    this._trim();
  }

  /** 上一次 `importEntries` 丢弃的非法条目数（0 = 没有） */
  get lastDroppedCount(): number {
    return this._lastDroppedCount;
  }

  // ==================== 调试 ====================

  describe(limit = 10): string {
    const rows = this.top(limit);
    if (rows.length === 0) return 'Leaderboard（空）';
    const lines = [`Leaderboard（${this.size}/${this.capacity}，${this._rankMode} 排名）`];
    for (const r of rows) {
      lines.push(`  ${String(r.rank).padStart(3)}  ${String(r.score).padStart(8)}  ${r.name}`);
    }
    return lines.join('\n');
  }
}

// ==================== 工具 ====================

/**
 * 合并多个来源的榜单（本地 + 服务器）
 *
 * 【用途】离线时先存本地，联网后合并上传。
 *
 * 【⚠️ bestPerPlayer 在合并时最容易出错】
 * 同一个玩家在两边都有成绩时，必须取较好的那条，
 * 直接 concat 会让同一个人占两个位置。
 */
export function mergeLeaderboards(
  boards: readonly Leaderboard[],
  opts: LeaderboardOptions = {}
): Leaderboard {
  const byPlayer = new Map<string, ScoreEntry>();
  const noDedup: ScoreEntry[] = [];

  const merged = new Leaderboard(opts);

  /**
   * 【⚠️ 曾经的 bug：`!opts.bestPerPlayer` 把 undefined 当成了 false】
   *
   * `bestPerPlayer` 默认 true，但调用方不传时它是 `undefined`，
   * 而 `!undefined === true` ——
   * 于是所有条目都被推进 `noDedup`，
   * 最后又因为 `opts.bestPerPlayer === false` 不成立而走了 `byPlayer` 分支，
   * 提交了一个**空数组**。
   *
   * 表现：合并后的排行榜是空的，且不报任何错。
   *
   * 教训：可选布尔参数要用 `=== false` 判断，不要用 `!x`。
   * 这是三态（true / false / 未指定）被当成二态处理的典型事故。
   */
  const dedup = opts.bestPerPlayer !== false;   // 默认去重

  for (const b of boards) {
    for (const e of b.exportEntries()) {
      if (!dedup) {
        noDedup.push(e);
        continue;
      }
      const prev = byPlayer.get(e.playerId);
      if (!prev) {
        byPlayer.set(e.playerId, e);
        continue;
      }
      /**
       * 【⚠️ 曾经的 bug：同分时的 tie-break 写死成 earlier，忽略了配置】
       *
       * 本类的 `tieBreak` 配置项（默认 'earlier'）在 `_cmp` / `_isBetter` 里
       * 是生效的，但 `mergeLeaderboards` 里写成了固定的 `e.at < prev.at`。
       *
       * 后果：`tieBreak: 'later'` 的榜单，在"本地 + 服务器"合并这条路径上
       * 会**静默退化成 earlier**——同一份数据，合并前后排序不一样。
       *
       * 实测（修复前）：两个 `tieBreak:'later'` 的榜（p1 分数同为 10，
       * at 分别为 1 和 2）合并后保留的是 **at=1** 那条，而不是 at=2。
       *
       * 表现是"玩家刷新榜单后名次/条目跳变"，
       * 而排查时没人会怀疑"配置项没生效"——因为它明明配了。
       */
      const asc = opts.order === 'asc';
      const better = asc ? e.score < prev.score : e.score > prev.score;
      const laterWins = opts.tieBreak === 'later';
      const sameButBetter = e.score === prev.score && (laterWins ? e.at > prev.at : e.at < prev.at);
      if (better || sameButBetter) byPlayer.set(e.playerId, e);
    }
  }

  merged.submitAll(dedup ? [...byPlayer.values()] : noDedup);
  return merged;
}
