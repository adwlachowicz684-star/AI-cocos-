/**
 * ranking/RankTier.ts —— 段位与赛季
 *
 * 【它解决什么】
 *
 * 玩家其实看不懂 1847 分意味着什么，
 * 但他们能秒懂"黄金 III，还差 53 分升黄金 II"。
 *
 * 所以段位系统是把**连续分数翻译成离散等级**的展示层。
 * 麻烦的地方在四个地方：
 *
 * 1. **段位边界反复横跳**
 *    玩家在 1500 分上下反复，段位每局变一次。
 *    表现为"我刚升段就掉回去了"，是最让人崩溃的体验之一。
 *    → 需要滞回 + 掉段保护。
 *
 * 2. **掉段保护怎么实现**
 *    常见做法是"掉出段位后给 N 局保护期"。
 *    这里最容易写错的是：**保护期内赢了要不要立刻取消保护？**
 *    （应该取消，否则玩家可以卡在段位边缘刷。）
 *
 * 3. **赛季重置**
 *    硬重置（所有人回到青铜）会让老玩家愤怒；
 *    不重置则新人永远追不上。
 *    → 软重置：向基准分收缩，保留一半差距。
 *
 * 4. **小段编号方向**
 *    "黄金 IV" 是黄金里最低还是最高？（是**最低**）
 *    这个搞反了，整个 UI 的进度条方向都会反。
 *
 * 【零业务依赖】
 */

import { clamp, clamp01 } from '../_core/math';

// ==================== 类型 ====================

export interface TierDef {
  readonly id: string;
  readonly name: string;
  /** 进入该段位的最低分 */
  readonly minRating: number;
  /**
   * 段位内的小段数量（默认 1）
   *
   * 【惯例】小段编号**越小越高**：I > II > III > IV
   */
  readonly divisions?: number;
  readonly meta?: unknown;
}

export interface RankTierConfig {
  /** 段位表，必须**按 minRating 升序** */
  readonly tiers: readonly TierDef[];
  /**
   * 晋级余量（默认 0）
   *
   * 超过阈值这么多分才真正升段。
   * 配合掉段保护使用，能有效消除"边界横跳"。
   */
  readonly promotionMargin?: number;
  /**
   * 掉段保护局数（默认 3）
   *
   * 掉到段位线以下后，这么多局内不掉段。
   */
  readonly demotionShieldGames?: number;
  /** 最高段位不再细分小段（如"最强王者"） */
  readonly apexTierId?: string;
}

export interface TierInfo {
  readonly tier: TierDef;
  readonly tierIndex: number;
  /** 小段索引，**0 = 最高**（I） */
  readonly division: number;
  /** 完整名称，如"黄金 II" */
  readonly label: string;
  /** 本小段的下限分 */
  readonly floor: number;
  /** 本小段的上限分（最高段位的最高小段为 Infinity） */
  readonly ceiling: number;
  /** 距离升到下个小段还差多少分 */
  readonly toNext: number;
  /** 本小段内进度 0~1 */
  readonly progress: number;
  readonly isApex: boolean;
}

/** 段位变化事件 */
export type RankEvent =
  /** 升段 */
  | 'promoted'
  /** 降段 */
  | 'demoted'
  /** 无变化 */
  | null;

export interface RankUpdate {
  readonly info: TierInfo;
  readonly event: RankEvent;
  readonly previous: TierInfo | null;
  /** 剩余保护局数（0 = 无保护） */
  readonly shieldGames: number;
  /** 本次是否触发了保护（掉到线以下但没掉段） */
  readonly shielded: boolean;
}

// ==================== 查询 ====================

/**
 * 分数 → 段位信息
 *
 * @throws 段位表为空、或未升序排列时抛错
 */
export function tierOf(rating: number, cfg: RankTierConfig): TierInfo {
  const tiers = cfg.tiers;
  if (tiers.length === 0) {
    throw new Error('[RankTier] 段位表为空');
  }
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minRating < tiers[i - 1].minRating) {
      throw new Error(
        `[RankTier] 段位表必须按 minRating 升序，第 ${i} 项 "${tiers[i].id}" 比前一项低`
      );
    }
  }

  // 找到最后一个 minRating <= rating 的段位
  let index = 0;
  for (let i = 0; i < tiers.length; i++) {
    if (rating >= tiers[i].minRating) index = i;
    else break;
  }

  const tier = tiers[index];
  const isApex = cfg.apexTierId !== undefined && tier.id === cfg.apexTierId;

  // 最高段位不再分小段
  const divisions = isApex ? 1 : Math.max(1, tier.divisions ?? 1);
  const nextFloor =
    index + 1 < tiers.length ? tiers[index + 1].minRating : Infinity;

  // 小段划分：把 [minRating, nextFloor) 均分
  const division = divisionIndexOf(rating, tier.minRating, nextFloor, divisions);
  const span = nextFloor === Infinity ? Infinity : (nextFloor - tier.minRating) / divisions;
  const floor =
    span === Infinity
      ? tier.minRating
      : tier.minRating + span * (divisions - 1 - division);
  const ceiling =
    span === Infinity ? Infinity : tier.minRating + span * (divisions - division);

  const toNext =
    span === Infinity ? Infinity : Math.max(0, ceiling - rating);

  const progress =
    span === Infinity || span === 0 ? (isApex ? 1 : 0) : clamp01((rating - floor) / span);

  return {
    tier,
    tierIndex: index,
    division,
    label: formatLabel(tier.name, division, divisions, isApex),
    floor,
    ceiling,
    toNext,
    progress,
    isApex,
  };
}

/**
 * 小段索引
 *
 * 【⚠️ 编号方向】
 * `division = 0` 表示该段位内**最高**的小段（显示 I）。
 * 这样"升段"永远是 division 减小，进度条永远向右涨，
 * 不会在不同段位间来回时方向反掉。
 */
function divisionIndexOf(
  rating: number,
  tierMin: number,
  nextTierMin: number,
  divisions: number
): number {
  if (nextTierMin === Infinity) return 0;
  const span = (nextTierMin - tierMin) / divisions;
  if (span <= 0) return 0;

  /**
   * 【⚠️ 必须补偿浮点误差，否则边界值会归到下一个小段】
   *
   * 实测（默认七段位、`divisions=3`）：
   *
   *   span = (1200 - 1000) / 3 = 66.66666666666667
   *   黄金 II 的 floor = 1500 + 66.66666666666667 × 1 = 1583.3333333333333
   *   反查：(1583.3333333333333 - 1500) / 66.66666666666667
   *        = 1.9999999999999987        ← 不是 2！
   *   Math.floor(...) = 1              → division = 3-1-1 = 1（黄金 II）
   *                                      期望 division = 1... 而这里又偏成 2（黄金 III）
   *
   * 后果（引擎实测报告第三轮 P1-3 抓到）：
   *   `exportState()` 存 `floor`，`importState()` 用 `tierOf(floor)` 重建，
   *   往返之后**小段降一级**——玩家存档重进，白银 I 显示成白银 II。
   *
   * 【为什么是相对 epsilon 而不是常数】
   * `span` 的量级取决于段位跨度配置（有人配 200 分一段，有人配 2000 分一段）。
   * 常数 epsilon 在 span 很大时会失效。
   * 这里取 `|q| × 1e-9`，即商值的 10 亿分之一——
   * 远大于浮点表示误差（约 1e-16 相对量级），
   * 又远小于任何真实分数差（分数通常是整数，1 分就差 1/span ≫ 1e-9）。
   *
   * `+ 1e-12` 是给 `q === 0` 的兜底（此时相对项为 0）。
   */
  const q = (rating - tierMin) / span;
  const offset = Math.floor(q + Math.abs(q) * 1e-9 + 1e-12);
  return clamp(divisions - 1 - offset, 0, divisions - 1);
}

/** 罗马数字（I / II / III / IV …） */
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

export function romanNumeral(n: number): string {
  if (n < 0 || !Number.isInteger(n)) {
    throw new Error(`[RankTier] 小段编号必须为非负整数，收到 ${n}`);
  }
  return ROMAN[n] ?? String(n + 1);
}

function formatLabel(
  tierName: string,
  division: number,
  divisions: number,
  isApex: boolean
): string {
  if (isApex || divisions <= 1) return tierName;
  return `${tierName} ${romanNumeral(division)}`;
}

// ==================== 进度追踪 ====================

/**
 * 段位追踪器
 *
 * 【为什么是类而不是纯函数】
 * 掉段保护需要**状态**（还剩几局保护）。
 * 纯函数做不到，所以这里必须持有状态。
 *
 * 【存档】用 exportState / importState。
 */
export class RankProgress {
  private readonly _cfg: RankTierConfig;
  private _current: TierInfo | null = null;
  private _shield = 0;
  /** 当前是否处于"已掉出段位线但在保护期内" */
  private _belowLine = false;
  /**
   * 最近一次的真实分数
   *
   * 【为什么需要单独记】
   * `_current` 只存 `TierInfo`，里面没有玩家分数——只有 `floor` / `ceiling`。
   * 而 `exportState()` 原先存的就是 `floor`，导致两个后果：
   *
   *   1. 段内进度归零：1600 分（黄金 II、进度 20%）存成 floor=1583.33，
   *      恢复后进度变 0%——玩家会以为自己掉分了。
   *   2. 配合浮点误差，小段会降一级（见 `divisionIndexOf` 的注释）。
   *
   * 存真实分数后两者都解决。
   */
  private _rating: number | null = null;

  constructor(cfg: RankTierConfig, initialRating?: number) {
    this._cfg = cfg;
    if (initialRating !== undefined) {
      this._current = tierOf(initialRating, cfg);
      this._rating = initialRating;
    }
  }

  get current(): TierInfo | null {
    return this._current;
  }

  get shieldGames(): number {
    return this._shield;
  }

  /**
   * 分数更新后调用
   *
   * @returns 变化详情
   */
  update(rating: number): RankUpdate {
    // 先记下真实分数——不管这次是升段 / 掉段 / 保护期，它都是"玩家现在多少分"
    this._rating = rating;
    const margin = this._cfg.promotionMargin ?? 0;
    const shieldGames = this._cfg.demotionShieldGames ?? 3;
    const previous = this._current;

    // 首次调用直接定级，不产生事件
    if (previous === null) {
      this._current = tierOf(rating, this._cfg);
      this._rating = rating;
      this._shield = 0;
      return {
        info: this._current,
        event: null,
        previous: null,
        shieldGames: 0,
        shielded: false,
      };
    }

    const actual = tierOf(rating, this._cfg);

    // ① 分数上涨方向：需要超过阈值 margin 才算真正升段
    if (actual.tierIndex > previous.tierIndex ||
        (actual.tierIndex === previous.tierIndex && actual.division < previous.division)) {
      // 有滞回要求时，检查是否真的越过了"阈值 + margin"
      const needMargin = margin > 0 && rating < actual.floor + margin;
      if (needMargin) {
        // 还没过滞回线，保持原段位
        return {
          info: previous,
          event: null,
          previous,
          shieldGames: this._shield,
          shielded: false,
        };
      }
      this._current = actual;
      this._shield = 0;
      this._belowLine = false;
      return { info: actual, event: 'promoted', previous, shieldGames: 0, shielded: false };
    }

    // ② 分数下降方向：掉段保护
    if (actual.tierIndex < previous.tierIndex ||
        (actual.tierIndex === previous.tierIndex && actual.division > previous.division)) {
      if (this._shield > 0) {
        // 保护期内：不掉段，但消耗一局保护
        this._shield--;
        this._belowLine = true;
        return {
          info: previous,
          event: null,
          previous,
          shieldGames: this._shield,
          shielded: true,
        };
      }
      this._current = actual;
      this._shield = shieldGames;   // 刚掉段后立刻给新的保护
      this._belowLine = true;
      return {
        info: actual,
        event: 'demoted',
        previous,
        shieldGames: this._shield,
        shielded: false,
      };
    }

    // ③ 段位没变，但分数已经回到段位线以上 → 保护应当失效
    if (this._belowLine && rating >= previous.floor) {
      this._belowLine = false;
      this._shield = 0;
    }

    /**
     * 【⚠️ 为什么这里必须返回 `actual` 而不是 `previous`】
     *
     * `previous` 是**上一次 update 时算出来的** TierInfo，
     * 它的 `progress` / `toNext` / `floor` / `ceiling` 都基于**旧 rating**。
     * 段位没变时直接把它原样返回，于是段位内涨分完全不体现：
     *
     * 实测（修复前），白银 I 区间 1400~1500：
     * ```
     * update(1350) -> 白银 II  progress=0.000  toNext=100
     * update(1450) -> 白银 I   progress=0.500  toNext=50
     * update(1490) -> 白银 I   progress=0.500  toNext=50   ← 涨了 40 分，进度条一动不动
     * tierOf(1490).progress = 0.900                        ← 真实进度
     * ```
     *
     * 后果：玩家从 1450 打到 1499，进度条始终停在 50%，直到 1500 升段瞬间跳变。
     * 反馈是"进度条坏了"，而代码确实"没坏"——它返回的是**段位信息**（确实没变），
     * 只是调用方 100% 会拿 `info` 去画进度条。
     *
     * 【为什么 `previous` 字段不需要动】
     * 上一次的段位信息已经在返回体的 `previous` 里了，
     * 调用方要判断升降段照样拿得到，这里只是让 `info` 反映"现在"。
     *
     * 【为什么同时更新 `_current`】
     * `get current()` 读的也是 `_current`，不更新的话
     * "从返回值读"和"从 current 读"会给出两个不同的进度。
     * 段位与小段都没变，所以这里更新 `_current` 不会影响任何升降段判定
     * （判定只看 `tierIndex` / `division` / `floor`，三者与 `previous` 相同）。
     */
    this._current = actual;
    return {
      info: actual,
      event: null,
      previous,
      shieldGames: this._shield,
      shielded: false,
    };
  }

  // ==================== 存档 ====================

  exportState(): { rating: number; shield: number; belowLine: boolean } | null {
    if (!this._current) return null;
    /**
     * 【存的是玩家真实分数，不是段位下边界】
     *
     * 曾经这里存 `this._current.floor`，有两个后果（均已修）：
     *   1. 段内进度归零（1600 分存成 1583.33，恢复后 progress 从 20% 变 0%）
     *   2. 小段降一级（floor 反查的浮点误差，详见 `divisionIndexOf`）
     *
     * 存真实分数后，`importState` 用 `tierOf(rating)` 能精确还原
     * 段位 + 小段 + 段内进度。
     */
    return {
      rating: this._rating ?? this._current.floor,
      shield: this._shield,
      belowLine: this._belowLine,
    };
  }

  importState(s: { rating: number; shield?: number; belowLine?: boolean }): void {
    this._current = tierOf(s.rating, this._cfg);
    this._rating = s.rating;
    this._shield = s.shield ?? 0;
    this._belowLine = s.belowLine ?? false;
  }
}

/**
 * 把段位折算成一个可比较的标量
 *
 * 【为什么 division 要用 999 减】
 * 小段编号是"越小越高"（I > II），
 * 但比较大小时需要"越高越大"（升段 = 数值变大）。
 * 所以这里翻转一次，让整个函数的语义统一为"数值越大越强"。
 *
 * 【用途】
 * 排行榜按段位排序、或判断两个玩家谁段位高。
 */
export function rankScore(info: TierInfo): number {
  return info.tierIndex * 1000 + (999 - info.division);
}

// ==================== 赛季重置 ====================

export interface SeasonResetConfig {
  /** 收缩基准分（通常取初始分，如 1200） */
  readonly baseline: number;
  /**
   * 收缩系数 0~1（默认 0.5）
   *
   * - 1 = 完全不重置
   * - 0 = 硬重置，所有人回到 baseline
   * - 0.5（推荐）= 保留一半差距
   */
  readonly factor?: number;
  /** 重置后是否给掉段保护 */
  readonly grantShield?: boolean;
}

/**
 * 软重置：向基准分收缩
 *
 * `r' = baseline + (r - baseline) × factor`
 *
 * 【为什么不用硬重置】
 * 硬重置（所有人回 1200）的后果：
 * 上赛季的王者这赛季要重新爬，
 * 前两周他在低段位屠杀，把新玩家全打跑了。
 *
 * 软重置保留了大部分差距，让匹配质量不至于在新赛季初崩掉，
 * 同时压缩了顶端，让追赶变得可能。
 */
export function softReset(rating: number, cfg: SeasonResetConfig): number {
  const factor = cfg.factor ?? 0.5;
  if (factor < 0 || factor > 1) {
    throw new Error(`[RankTier] 收缩系数必须在 0~1，收到 ${factor}`);
  }
  return cfg.baseline + (rating - cfg.baseline) * factor;
}

/** 批量重置（返回新数组，不改原数组） */
export function softResetAll(
  ratings: readonly number[],
  cfg: SeasonResetConfig
): number[] {
  return ratings.map((r) => softReset(r, cfg));
}

// ==================== 预设 ====================

/**
 * 一套常见的七段位配置
 *
 * 【尺度】跨度 1200~2800，与 ELO 默认初始分 1200 对应。
 */
export const DEFAULT_TIERS: readonly TierDef[] = [
  { id: 'bronze', name: '青铜', minRating: 0, divisions: 3 },
  { id: 'silver', name: '白银', minRating: 1200, divisions: 3 },
  { id: 'gold', name: '黄金', minRating: 1500, divisions: 3 },
  { id: 'platinum', name: '铂金', minRating: 1750, divisions: 3 },
  { id: 'diamond', name: '钻石', minRating: 2000, divisions: 3 },
  { id: 'master', name: '大师', minRating: 2300, divisions: 1 },
  { id: 'grandmaster', name: '宗师', minRating: 2600, divisions: 1 },
];

/** 便捷配置：用预设段位 + 保护 */
export function defaultRankConfig(overrides?: Partial<RankTierConfig>): RankTierConfig {
  return {
    tiers: DEFAULT_TIERS,
    promotionMargin: 0,
    demotionShieldGames: 3,
    apexTierId: 'grandmaster',
    ...overrides,
  };
}
