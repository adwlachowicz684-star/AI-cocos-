/**
 * ranking/SeasonReward.ts —— 赛季结算与发奖
 *
 * 【它解决什么】
 *
 * 赛季结束发奖励，听起来是"查表 + 发邮件"两行代码。
 * 但它有一个必须做对的地方：
 *
 * > **发奖必须幂等。**
 *
 * 发奖是这个系统里唯一**有外部副作用**的操作
 * （扣款、发道具、写邮件）。如果重复执行：
 * - 玩家领两次 → 经济系统通胀
 * - 玩家没领到 → 愤怒的客服工单
 *
 * 而"重复执行"几乎一定会发生：
 * - 服务器重启后重跑结算任务
 * - 管理员手动补发
 * - 消息队列重投
 *
 * 所以这个模块的核心不是"怎么发"，而是**"怎么保证不重复发"**。
 *
 * 另外两个真实的坑：
 *
 * 1. **结算时用的是快照分，不是当前分**
 *    赛季结束那一刻的分数要冻结。
 *    如果结算任务跑了一小时，中间玩家的分数还在变，
 *    用"当前分"发奖就会有人钻空子（结算前疯狂冲分）。
 *
 * 2. **段位边界的玩家归属**
 *    1499 分和 1500 分差 1 分，但奖励可能差一个档次。
 *    玩家会为此吵翻天——这不是 bug，但要在文档里说清楚。
 *
 * 【零业务依赖】
 */

import { tierOf, type RankTierConfig, type TierInfo } from './RankTier';

// ==================== 类型 ====================

export interface RewardTier {
  /** 匹配的段位 id；'*' 表示兜底 */
  readonly tierId: string;
  /** 奖励内容（由上层解释，本模块不关心结构） */
  readonly rewards: readonly unknown[];
  /** 展示用名称 */
  readonly label?: string;
}

/**
 * 匹配模式
 *
 * - `'highest'`：按**达到过的**最高段位发（宽容，推荐）
 * - `'final'`：按赛季结束时的段位发（严格）
 */
export type RewardBasis = 'highest' | 'final';

export interface SeasonRewardConfig {
  /** 段位配置（与 RankTier 共用） */
  readonly rankConfig: RankTierConfig;
  /** 奖励表 */
  readonly rewards: readonly RewardTier[];
  /** 结算口径（默认 'highest'） */
  readonly basis?: RewardBasis;
  /**
   * 最低参与局数（默认 0）
   *
   * 【为什么需要】
   * 打 1 局就拿到赛季奖励的话，有人会开小号刷。
   * 设个门槛（比如 10 局）能有效过滤。
   */
  readonly minGames?: number;
}

export interface SeasonPlayer {
  readonly id: string;
  /** 赛季结束时刻的分数（快照） */
  readonly finalRating: number;
  /** 本赛季达到过的最高分数 */
  readonly peakRating: number;
  /** 本赛季参与局数 */
  readonly games: number;
}

export interface RewardGrant {
  readonly playerId: string;
  readonly tierId: string;
  readonly tierLabel: string;
  readonly rewards: readonly unknown[];
  /** 是否因参与局数不足而被跳过 */
  readonly skipped: boolean;
  readonly skipReason?: 'too-few-games';
}

// ==================== 实现 ====================

export class SeasonRewardDistributor {
  private readonly _cfg: SeasonRewardConfig;
  private readonly _basis: RewardBasis;
  private readonly _minGames: number;

  /** 已发放记录：seasonId → Set<playerId> */
  private readonly _granted = new Map<string, Set<string>>();

  constructor(cfg: SeasonRewardConfig) {
    this._cfg = cfg;
    this._basis = cfg.basis ?? 'highest';
    this._minGames = cfg.minGames ?? 0;

    const hasFallback = cfg.rewards.some((r) => r.tierId === '*');
    if (!hasFallback) {
      /**
       * 【⚠️ 必须有兜底档】
       * 没有的话，低于最低段位奖励档的玩家会拿到 undefined，
       * 然后在上层崩溃或静默丢奖励。
       * 后者更糟：玩家不知道自己"应该有"奖励。
       */
      throw new Error('[SeasonReward] 奖励表必须包含 tierId="*" 的兜底档');
    }
  }

  // ==================== 查询 ====================

  /** 该玩家应得哪档奖励（不发奖，只计算） */
  resolve(player: SeasonPlayer): RewardGrant {
    const rating = this._basis === 'highest' ? player.peakRating : player.finalRating;
    const info = tierOf(rating, this._cfg.rankConfig);

    if (player.games < this._minGames) {
      return {
        playerId: player.id,
        tierId: info.tier.id,
        tierLabel: info.label,
        rewards: [],
        skipped: true,
        skipReason: 'too-few-games',
      };
    }

    const match = this._findReward(info.tier.id);

    return {
      playerId: player.id,
      tierId: info.tier.id,
      tierLabel: info.label,
      rewards: match.rewards,
      skipped: false,
    };
  }

  // ==================== 发奖 ====================

  /**
   * 批量发放
   *
   * 【幂等保证】
   * 同一个 seasonId 下，同一个玩家只会发放一次。
   * 重复调用返回空数组，不会重复发。
   *
   * @param seasonId 赛季标识。**必须传入**，否则幂等无从谈起
   * @returns 本次**实际**发放的记录（已发过的不会出现在结果里）
   */
  grant(
    seasonId: string,
    players: readonly SeasonPlayer[]
  ): readonly RewardGrant[] {
    const done = this._granted.get(seasonId) ?? new Set<string>();
    const out: RewardGrant[] = [];

    for (const p of players) {
      /**
       * 【⚠️ `done` 同时承担两种去重，别再单独加"批内去重"】
       *
       * - 跨调用：上一次 grant 已发过的人（存档恢复后依然有效）
       * - 批内：同一次调用里重复出现的 id
       *
       * 批内去重之所以自动成立，是因为 `done.add()` 在循环内部执行——
       * 第一个 p1 处理完就进了 done，第二个 p1 在这里被拦下。
       *
       * 之前这里还有一个 `_isDuplicateInBatch()`，
       * 它对**每一次**出现都返回 true（包括首次），
       * 结果重复 id 会被整批跳过、一个都拿不到奖励。
       * 那种"扫描整个数组判断有没有重复"的写法，
       * 天然分不清"第一次"和"第二次"。
       */
      if (done.has(p.id)) continue;

      const g = this.resolve(p);
      if (g.skipped) {
        /**
         * 【⚠️ 跳过的也要记为已发放】
         *
         * 不记录的话，玩家事后补够局数再跑一次结算，
         * 会拿到奖励——但赛季已经结束了，他不该再有机会。
         *
         * 更重要的：不记录会导致每次重跑都会"尝试发放"一次，
         * 上层如果有日志，会刷出一堆重复记录。
         */
        done.add(p.id);
        out.push(g);
        continue;
      }

      done.add(p.id);
      out.push(g);
    }

    this._granted.set(seasonId, done);
    return out;
  }

  /**
   * 强制补发（管理员手动干预）
   *
   * 【为什么单独一个方法】
   * 它绕过幂等检查，所以必须**显式命名**为 force。
   * 藏在主流程里的"跳过幂等"参数是事故温床——
   * 某天有人传错参数，全服玩家领两次。
   */
  forceGrant(player: SeasonPlayer): RewardGrant {
    return this.resolve(player);
  }

  // ==================== 状态 ====================

  /** 该赛季是否已发放过 */
  isGranted(seasonId: string, playerId: string): boolean {
    return this._granted.get(seasonId)?.has(playerId) ?? false;
  }

  /** 已发放人数 */
  grantedCount(seasonId: string): number {
    return this._granted.get(seasonId)?.size ?? 0;
  }

  /** 清空某赛季的发放记录（仅限测试/回滚） */
  resetSeason(seasonId: string): void {
    this._granted.delete(seasonId);
  }

  /** 存档 */
  exportState(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [k, v] of this._granted) out[k] = [...v];
    return out;
  }

  /** 读档 */
  importState(s: Record<string, readonly string[]>): void {
    this._granted.clear();
    for (const [k, v] of Object.entries(s)) this._granted.set(k, new Set(v));
  }

  // ==================== 内部 ====================

  private _findReward(tierId: string): RewardTier {
    const exact = this._cfg.rewards.find((r) => r.tierId === tierId);
    if (exact) return exact;

    /**
     * 【降级查找】
     * 奖励表可能只为部分段位配置了奖励。
     * 这时应该向下找"最近的、已有配置的、更低的段位"，
     * 而不是直接跳到兜底档——
     * 否则钻石玩家可能拿到和青铜一样的奖励。
     *
     * 最后才用 '*' 兜底。
     */
    const tiers = this._cfg.rankConfig.tiers;
    const idx = tiers.findIndex((t) => t.id === tierId);

    if (idx > 0) {
      for (let i = idx - 1; i >= 0; i--) {
        const lower = this._cfg.rewards.find((r) => r.tierId === tiers[i]!.id);
        if (lower) return lower;
      }
    }

    return this._cfg.rewards.find((r) => r.tierId === '*')!;
  }

  /**
   * 检查同一批次里是否有重复 id
   *
   * 【为什么需要】
   * 批量发奖时如果输入数组本身有重复，
   * 幂等检查（基于 Set）会拦住第二个——这本来是对的。
   * 但如果不显式处理，调用方会困惑"我传了 100 个人，为什么只发了 99 个"。
   */
}

// ==================== 便捷 ====================

/**
 * 段位分布统计
 *
 * 【用途】
 * 赛季结束时给策划看"玩家都卡在哪个段位"，
 * 用于调整下赛季的段位分数线。
 *
 * 【⚠️ 输出顺序按 `rankConfig.tiers` 固定，不按玩家出现顺序】
 *
 * 老实现是 `[...counts.entries()]`，而 `counts` 是 `Map`、
 * 按**首次出现顺序**累积——顺序完全由 `players` 数组的顺序决定
 * （数据库返回顺序、分页顺序、并发写入顺序都会影响它）。
 *
 * `diagnoseDistribution` 用 `dist[0]` 当最低段位、`dist[dist.length-1]` 当最高段位，
 * 于是**同一批玩家只改数组顺序，诊断结论就会完全颠倒**：
 *
 * 实测（修复前），1 个宗师 + 9 个青铜：
 * ```
 * 宗师在前 -> dist=["grandmaster:0.1","bronze:0.9"]
 *            诊断："最高段位占比 90.0%"        ← 把青铜的 90% 当成了最高段位
 * 青铜在前 -> dist=["bronze:0.9","grandmaster:0.1"]
 *            诊断："最低段位占比 90.0%"        ← 这才是正确结论
 * ```
 *
 * 后果：赛季健康度是**运营决策输入**。上面第一种情况会给出
 * "最强段位人太多"的结论，而实际是最弱段位人太多——
 * 数值全部"看起来合理"，不会报错，错的是决策方向。
 *
 * `tiers` 已经强制按 `minRating` 升序（`tierOf` 会校验），
 * 所以按它的顺序输出即得到"最低 → 最高"的稳定顺序。
 */
export function tierDistribution(
  players: readonly SeasonPlayer[],
  rankConfig: RankTierConfig,
  basis: RewardBasis = 'highest'
): { tierId: string; label: string; count: number; ratio: number }[] {
  const counts = new Map<string, { label: string; n: number }>();

  for (const p of players) {
    const rating = basis === 'highest' ? p.peakRating : p.finalRating;
    const info: TierInfo = tierOf(rating, rankConfig);
    const cur = counts.get(info.tier.id);
    if (cur) cur.n++;
    else counts.set(info.tier.id, { label: info.tier.name, n: 1 });
  }

  const total = players.length || 1;
  const order = new Map<string, number>();
  rankConfig.tiers.forEach((t, i) => order.set(t.id, i));

  return [...counts.entries()]
    // 未登记在 tiers 里的段位排在最后，且保持原相对顺序
    .sort(
      (a, b) =>
        (order.get(a[0]) ?? rankConfig.tiers.length) -
        (order.get(b[0]) ?? rankConfig.tiers.length)
    )
    .map(([tierId, v]) => ({
      tierId,
      label: v.label,
      count: v.n,
      ratio: v.n / total,
    }));
}

/**
 * 段位分数线是否合理
 *
 * 【判据】
 * 健康的分布应该是"中间大两头小"：
 * - 最低段位占比过高 → 门槛太低，段位失去意义
 * - 最高段位占比过高 → 门槛太低，顶端没有区分度
 * - 最高段位占比为 0 → 门槛太高，玩家没有目标
 *
 * @param opts.tierOrder 段位 id 按**由低到高**排列（通常取 `rankConfig.tiers.map(t => t.id)`）。
 *   给了就按它重排后再取"最低/最高"，不给则沿用入参顺序（兼容老调用）。
 *
 * 【⚠️ 为什么必须重排】
 * `dist[0]` / `dist[dist.length-1]` 这两个下标判断隐含了
 * "入参已经按段位从低到高排好"这个**从未被校验过的前提**。
 * 而 `dist` 常常来自 `tierDistribution(players, ...)`，
 * 那里的顺序原本由玩家数组的顺序决定（见 `tierDistribution` 的注释）。
 *
 * 不传 `tierOrder` 时保持原行为，是因为本函数也接受手写的字面量数组
 * （既有回归用例就是这样调的，那些数组本身已经是有序的）。
 *
 * @returns 诊断信息
 */
export function diagnoseDistribution(
  dist: readonly { tierId: string; ratio: number }[],
  opts: { topHeavy?: number; bottomHeavy?: number; tierOrder?: readonly string[] } = {}
): { healthy: boolean; issues: string[] } {
  const issues: string[] = [];
  const topHeavy = opts.topHeavy ?? 0.05;
  const bottomHeavy = opts.bottomHeavy ?? 0.5;

  if (dist.length === 0) {
    return { healthy: false, issues: ['没有数据'] };
  }

  /**
   * 按段位高低重排的副本
   *
   * 不在 `tierOrder` 里的 id 统一排到末尾（判定为"最高"），
   * 这样配置表里漏登记一个新段位时，不会静默变成"最低段位"而颠倒结论。
   */
  const ordered =
    opts.tierOrder && opts.tierOrder.length > 0
      ? [...dist].sort((a, b) => {
          const ia = opts.tierOrder!.indexOf(a.tierId);
          const ib = opts.tierOrder!.indexOf(b.tierId);
          return (ia < 0 ? opts.tierOrder!.length : ia) - (ib < 0 ? opts.tierOrder!.length : ib);
        })
      : dist;

  const first = ordered[0]!;
  if (first.ratio > bottomHeavy) {
    issues.push(
      `最低段位占比 ${(first.ratio * 100).toFixed(1)}%，超过 ${(bottomHeavy * 100).toFixed(0)}%`
    );
  }

  const last = ordered[ordered.length - 1]!;
  if (dist.length > 1 && last.ratio > topHeavy) {
    issues.push(
      `最高段位占比 ${(last.ratio * 100).toFixed(1)}%，超过 ${(topHeavy * 100).toFixed(0)}%`
    );
  }
  if (dist.length > 1 && last.ratio === 0) {
    issues.push('最高段位无人达到，玩家缺少目标');
  }

  return { healthy: issues.length === 0, issues };
}
