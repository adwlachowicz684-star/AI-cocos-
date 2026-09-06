/**
 * matchops/Spectate.ts —— 观战
 *
 * 【它解决什么】
 *
 * 观战看起来是"把画面转给第三个人看"，纯表现层的活。
 * 但它有一个必须做对的安全问题：
 *
 * > **观战延迟不够 = 官方作弊通道。**
 *
 * 观战者能看到被观战者的实时画面。
 * 如果延迟是 0，他只要开个语音就能实时报点：
 * "对面打龙了""辅助在草里蹲你"。
 * 这比任何外挂都难查，因为**他什么外挂都没开**。
 *
 * 所以观战系统真正要处理的是：
 *
 * 1. **延迟**：给多少秒才安全？
 *    - 0 秒：能实时报点，等于作弊
 *    - 30 秒：局面早就变了，报点没意义
 *    - 常见值：职业比赛 3~10 分钟，好友观战 30~120 秒
 *
 * 2. **可见性**：观战者能不能看到对方的视野/战争迷雾？
 *    如果游戏有战争迷雾，观战者能看到全图的话，
 *    他可以告诉朋友"人在哪" —— 同样是作弊。
 *
 * 3. **谁能观战**：好友？所有人？对手？
 *    对手能观战 = 能看到你的出装和位置。
 *
 * 4. **人数上限**：不限制的话，热门对局会被几百人挤爆。
 *
 * 【零业务依赖】
 */

// ==================== 类型 ====================

export type SpectatorVisibility =
  /** 只看被观战方视野（安全，推荐） */
  | 'team-only'
  /** 看全场（含对方位置），**必须在延迟足够时才能开** */
  | 'all'
  /** 导演视角，自动切换画面 */
  | 'director';

export interface SpectateConfig {
  /**
   * 观战延迟（毫秒，默认 120000 = 2 分钟）
   *
   * 【怎么选】
   * - 有战争迷雾的游戏：至少 30 秒
   * - 无迷雾但位置重要的（MOBA / 战术射击）：至少 60 秒
   * - 棋牌类（信息全公开）：可以 0
   *
   * 【⚠️ 别设 0】
   * 设 0 等于开放实时报点。
   */
  readonly delayMs?: number;

  /**
   * 允许"全场可见"所需的最小延迟（毫秒，默认 300000 = 5 分钟）
   *
   * 【原理】
   * 全场可见 + 零延迟 = 完美的作弊工具。
   * 全场可见 + 足够延迟 = 只是个解说视角。
   *
   * 所以这个阈值要远高于普通延迟。
   */
  readonly allVisionMinDelayMs?: number;

  /** 同时观战人数上限（默认 100） */
  readonly maxSpectators?: number;

  /** 是否允许对手观战（默认 false） */
  readonly allowOpponentSpectate?: boolean;

  /** 默认可见性（默认 'team-only'） */
  readonly defaultVisibility?: SpectatorVisibility;

  /**
   * 观战者是否出现在被观战者可见的列表里（默认 false）
   *
   * 【为什么默认 false】
   * 玩家知道自己被 50 个人盯着会紧张，发挥失常。
   * 而且能被看到的话，就可能被针对（场外干扰）。
   */
  readonly revealSpectators?: boolean;
}

export interface Spectator {
  readonly id: string;
  /** 观战谁（队伍索引或 'director'） */
  readonly target: number | 'director';
  /** 加入时刻 */
  readonly joinedAt: number;
  readonly visibility: SpectatorVisibility;
}

export type JoinError =
  | 'full'
  | 'duplicate'
  | 'not-started'
  | 'ended'
  | 'opponent-forbidden'
  | 'visibility-forbidden';

// ==================== 默认值 ====================

const DEFAULTS = {
  delayMs: 120_000,
  allVisionMinDelayMs: 300_000,
  maxSpectators: 100,
  allowOpponentSpectate: false,
  defaultVisibility: 'team-only' as SpectatorVisibility,
  revealSpectators: false,
};

// ==================== 实现 ====================

export class SpectateSession {
  private readonly _delayMs: number;
  private readonly _allVisionMinDelayMs: number;
  private readonly _maxSpectators: number;
  private readonly _allowOpponent: boolean;
  private readonly _defaultVisibility: SpectatorVisibility;
  private readonly _revealSpectators: boolean;

  private readonly _spectators = new Map<string, Spectator>();
  private _started = false;
  private _ended = false;
  private _startedAt = 0;

  constructor(cfg: SpectateConfig = {}) {
    this._delayMs = cfg.delayMs ?? DEFAULTS.delayMs;
    this._allVisionMinDelayMs =
      cfg.allVisionMinDelayMs ?? DEFAULTS.allVisionMinDelayMs;
    this._maxSpectators = cfg.maxSpectators ?? DEFAULTS.maxSpectators;
    this._allowOpponent = cfg.allowOpponentSpectate ?? DEFAULTS.allowOpponentSpectate;
    this._defaultVisibility = cfg.defaultVisibility ?? DEFAULTS.defaultVisibility;
    this._revealSpectators = cfg.revealSpectators ?? DEFAULTS.revealSpectators;

    if (this._delayMs < 0) {
      throw new Error(`[Spectate] 延迟不能为负，收到 ${this._delayMs}`);
    }
  }

  // ==================== 生命周期 ====================

  start(now: number): void {
    this._started = true;
    this._startedAt = now;
  }

  end(): void {
    this._ended = true;
  }

  get isActive(): boolean {
    return this._started && !this._ended;
  }

  // ==================== 加入 / 离开 ====================

  /**
   * 加入观战
   *
   * @param target 观战哪一方；'director' = 导演视角（自动切画面）
   * @param opts.isOpponent 是否为对局参与者（对手观战）
   * @param opts.visibility 请求的可见性
   */
  join(
    id: string,
    now: number,
    opts: {
      target?: number | 'director';
      isOpponent?: boolean;
      visibility?: SpectatorVisibility;
    } = {}
  ): { ok: true; effectiveVisibility: SpectatorVisibility; delayMs: number }
    | { ok: false; error: JoinError } {
    if (!this._started) return { ok: false, error: 'not-started' };
    if (this._ended) return { ok: false, error: 'ended' };
    if (this._spectators.has(id)) return { ok: false, error: 'duplicate' };
    if (this._spectators.size >= this._maxSpectators) {
      return { ok: false, error: 'full' };
    }
    if (opts.isOpponent && !this._allowOpponent) {
      return { ok: false, error: 'opponent-forbidden' };
    }

    const requested = opts.visibility ?? this._defaultVisibility;

    /**
     * 【⚠️ 全场可见需要足够延迟】
     *
     * 这是整个模块的安全核心：
     * 请求"看全场"但延迟不够时，不是报错拒绝，
     * 而是**静默降级**为 team-only 并告诉调用方实际给了什么。
     *
     * 为什么不报错？因为报错会让调用方疑惑
     * "我明明配了 all，为什么说不行"。
     * 降级 + 明确返回实际值，调用方可以按实际情况渲染。
     */
    let effective = requested;
    if (requested === 'all' && this._delayMs < this._allVisionMinDelayMs) {
      effective = 'team-only';
    }

    this._spectators.set(id, {
      id,
      target: opts.target ?? 'director',
      joinedAt: now,
      visibility: effective,
    });

    return { ok: true, effectiveVisibility: effective, delayMs: this._delayMs };
  }

  leave(id: string): boolean {
    return this._spectators.delete(id);
  }

  switchTarget(id: string, target: number | 'director'): boolean {
    const s = this._spectators.get(id);
    if (!s) return false;
    this._spectators.set(id, { ...s, target });
    return true;
  }

  // ==================== 查询 ====================

  get count(): number {
    return this._spectators.size;
  }

  get capacity(): number {
    return this._maxSpectators;
  }

  get delayMs(): number {
    return this._delayMs;
  }

  list(): readonly Spectator[] {
    return [...this._spectators.values()];
  }

  has(id: string): boolean {
    return this._spectators.has(id);
  }

  visibilityOf(id: string): SpectatorVisibility | null {
    return this._spectators.get(id)?.visibility ?? null;
  }

  /** 被观战者能否看到观战者列表 */
  get spectatorsVisible(): boolean {
    return this._revealSpectators;
  }

  /**
   * 观战者当前应该看到的画面时刻
   *
   * 【⚠️ 这才是延迟的真正含义】
   *
   * 观战者拿到的数据是 `now - delay` 时刻的快照，
   * 而不是"延迟 delay 秒才开始播放"。
   *
   * 区别在于：中途加入的观战者应该立刻看到
   * "当前时刻往前推 delay" 的画面，
   * 而不是从对局开始重新播放（那要等很久才能追上）。
   */
  viewingTime(now: number): number {
    return Math.max(this._startedAt, now - this._delayMs);
  }

  /** 观战者距离"实时"还差多少 */
  lagBehind(now: number): number {
    return now - this.viewingTime(now);
  }

  clear(): void {
    this._spectators.clear();
  }
}

// ==================== 便捷 ====================

/**
 * 该延迟是否安全
 *
 * 【用途】
 * 配置项校验：如果有人把 delay 配成 0，这里会给警告。
 *
 * @param delayMs 观战延迟
 * @param hasFog 游戏是否有战争迷雾（有迷雾时要求更高）
 */
export function isDelaySafe(delayMs: number, hasFog: boolean): boolean {
  const min = hasFog ? 30_000 : 15_000;
  return delayMs >= min;
}

/**
 * 建议的观战延迟
 *
 * @param genre 游戏类型
 */
export function recommendDelay(
  genre: 'moba' | 'fps' | 'rts' | 'card' | 'battle-royale'
): number {
  switch (genre) {
    case 'moba': return 180_000;    // 3 分钟：位置信息极重要
    case 'fps': return 120_000;     // 2 分钟
    case 'battle-royale': return 180_000;
    case 'rts': return 300_000;     // 5 分钟：全图信息
    case 'card': return 0;          // 信息本就公开，无需延迟
  }
}

/**
 * 导演视角的自动切换评分
 *
 * 【它解决什么】
 * 导演视角要在多个画面间自动切换，
 * 切早了错过击杀，切晚了观众已经看完了。
 *
 * 这里给每个候选画面打分，取最高分。
 *
 * @param candidates 各画面的实时指标
 * @returns 索引，-1 表示无候选
 */
export function pickDirectorShot(
  candidates: readonly {
    /** 该画面附近的交战强度 0~1 */
    readonly combat: number;
    /** 距离上次切换的时间（秒） */
    readonly sinceSwitch: number;
    /** 是否是当前画面（给一点粘性，避免抖动） */
    readonly isCurrent: boolean;
  }[]
): number {
  if (candidates.length === 0) return -1;

  let best = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    let score = c.combat * 100;

    /**
     * 【粘性】
     * 当前画面加分，否则两个画面分数接近时会疯狂抖动 ——
     * 观众看到的是每秒切一次的幻灯片。
     */
    if (c.isCurrent) score += 15;

    /**
     * 【冷却惩罚】
     * 刚切过来的画面在 5 秒内不再被选中，
     * 否则会来回横跳。
     */
    if (c.sinceSwitch < 5) score -= (5 - c.sinceSwitch) * 20;

    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  return best;
}

/** 观战人数分档（用于 UI 显示"热门对局"） */
export function popularityTier(count: number): 'none' | 'few' | 'some' | 'hot' | 'viral' {
  if (count <= 0) return 'none';
  if (count < 5) return 'few';
  if (count < 50) return 'some';
  if (count < 1000) return 'hot';
  return 'viral';
}

/** 把延迟格式化成人类可读文本 */
export function formatDelay(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} 分钟` : `${m} 分 ${rest} 秒`;
}
