/**
 * difficulty/DifficultySystem.ts —— 难度系统（显式 + 动态）
 *
 * 【它解决什么】
 *
 * 难度有两套完全不同的东西，经常被混为一谈：
 *
 * | | 显式难度 | 动态难度（DDA） |
 * |---|---|---|
 * 谁控制 | **玩家** | 系统 |
 * 玩家是否知道 | 知道（菜单里选的） | **不知道** |
 * 目的 | 让玩家选适合自己的挑战 | 让水平不同的玩家都能通关 |
 * 失败时怪谁 | 怪自己选错了 | 怪游戏（所以要藏起来） |
 *
 * 本模块两个都做，但**态度完全不同**。
 *
 * 【DDA 的三条铁律】
 *
 * 1. **幅度受限**：±15% 以内。超过就不是"微调"了，是在替玩家玩游戏
 * 2. **永远隐形**：绝不显示"检测到你很艰难，已降低难度"
 *    —— 玩家一旦发现游戏在放水，通关的成就感会**立刻崩塌**，
 *    而且会怀疑之前所有的胜利都是施舍的
 * 3. **可以关掉**：设置里必须有开关（无障碍需求）
 *
 * 【零业务依赖】
 *
 * 它不认识"敌人血量""伤害"。
 * 只有**命名的倍率键**（`'enemyHp'` / `'enemyDamage'` / ...），
 * 由业务去查并应用。
 */

import { clamp, clamp01, lerp, safeDt } from '../_core/math';
import { hasOwn } from '../_core/guard';

// ============================================================
// 显式难度
// ============================================================

export interface DifficultyTier {
  readonly id: string;
  /** UI 名称（建议 i18n key） */
  readonly name?: string;
  /** 各项倍率 */
  readonly multipliers: Readonly<Record<string, number>>;
  /**
   * 是否允许 DDA 介入。默认 true
   *
   * 【⚠️ 必须用 `=== false` 判断，不能用 `!x`】
   * 这个字段在配置里经常**不写**（表示"用默认 true"），
   * 此时它是 `undefined`，而 `!undefined === true`——
   * 写成 `if (!tier.allowDDA) return;` 会让所有没配这个字段的档位
   * 全部失去 DDA，且**没有任何报错**，只是"DDA 好像没生效"。
   *
   * 这是 opt-out 布尔字段的经典陷阱。
   *
   * 【什么时候关】
   * - "简单"档：本来就简单，不需要再放水
   * - "噩梦"档：玩家明确要求"别管我"，DDA 会冒犯他
   */
  readonly allowDDA?: boolean;
  /** 业务数据（比如解锁条件、奖励倍率） */
  readonly data?: unknown;
}

/** 常见倍率键（约定，业务可扩展） */
export const MultiplierKeys = {
  ENEMY_HP: 'enemyHp',
  ENEMY_DAMAGE: 'enemyDamage',
  ENEMY_COUNT: 'enemyCount',
  ENEMY_SPEED: 'enemySpeed',
  PLAYER_DAMAGE: 'playerDamage',
  PLAYER_HP: 'playerHp',
  HEAL_RATE: 'healRate',
  CURRENCY_GAIN: 'currencyGain',
  RESPAWN_COST: 'respawnCost',
} as const;

export const DEFAULT_TIERS: readonly DifficultyTier[] = [
  { id: 'story', name: '故事', multipliers: { enemyHp: 0.7, enemyDamage: 0.6, healRate: 1.5 }, allowDDA: false },
  { id: 'normal', name: '普通', multipliers: { enemyHp: 1, enemyDamage: 1 } },
  { id: 'hard', name: '困难', multipliers: { enemyHp: 1.35, enemyDamage: 1.3, currencyGain: 1.2 } },
  { id: 'nightmare', name: '噩梦', multipliers: { enemyHp: 1.8, enemyDamage: 1.6, currencyGain: 1.5 }, allowDDA: false },
];

// ============================================================
// 动态难度（DDA）
// ============================================================

/** DDA 观察的信号 */
export interface PerformanceSignal {
  /**
   * 玩家当前表现，归一化到 0~1
   *
   * 1 = 表现极好（无伤、快速清场）
   * 0 = 表现极差（一直挨打、死了好几次）
   *
   * 【怎么算】业务决定。典型组合：
   * ```
   * score = 0.4 × (1 - 受伤率) + 0.3 × (1 - 死亡率) + 0.3 × 清怪速度
   * ```
   */
  readonly performance: number;
}

export interface DDAOptions {
  /**
   * 最大调整幅度。默认 0.15（±15%）
   *
   * 【⚠️ 不要调大】
   * 20% 以上玩家能明显感觉到"怪突然变肉了/变脆了"，
   * 那不是"适应"，是"难度在乱跳"，会让玩家不安。
   */
  maxAdjust?: number;
  /**
   * 响应速度（每秒向目标靠拢的比例）。默认 0.15
   *
   * 【为什么要平滑】
   * 直接跳到目标值的话，玩家死一次 → 难度立刻降 →
   * 下一场明显变简单 → 玩家察觉 → 成就感崩塌。
   *
   * 慢速平滑让变化隐藏在"这一局我状态好"的自我解释里。
   */
  responsiveness?: number;
  /**
   * 采样窗口（秒）。默认 30
   *
   * 太短会被单次失误带偏（一次手滑就降难度，不合理）
   */
  windowSize?: number;
  /** 全局开关（对应设置项） */
  enabled?: boolean;
  onAdjust?: (value: number) => void;
}

// ============================================================
// 实现
// ============================================================

export class DifficultySystem {
  private readonly _tiers = new Map<string, DifficultyTier>();
  private readonly _order: string[] = [];
  // ---- DDA ----
  private readonly _maxAdjust: number;
  private readonly _responsiveness: number;
  private readonly _windowSize: number;
  private _ddaEnabled: boolean;
  private _ddaValue = 0;          // -maxAdjust .. +maxAdjust
  private _smoothPerf = 0.5;      // 平滑后的表现
  private _samples = 0;

  private _tierId: string;
  onAdjust?: (value: number) => void;

  constructor(opts?: {
    tiers?: readonly DifficultyTier[];
    defaultTier?: string;
    dda?: DDAOptions;
  }) {
    const tiers = opts?.tiers ?? DEFAULT_TIERS;
    if (tiers.length === 0) throw new Error('[Difficulty] 至少需要一个难度档');

    for (const t of tiers) {
      if (this._tiers.has(t.id)) throw new Error(`[Difficulty] 难度 id 重复：${t.id}`);
      this._tiers.set(t.id, t);
      this._order.push(t.id);
    }

    const d = opts?.dda ?? {};
    this._maxAdjust = clamp(Math.max(0, d.maxAdjust ?? 0.15), 0, 0.5);
    this._responsiveness = clamp01(d.responsiveness ?? 0.15);
    this._windowSize = Math.max(1, d.windowSize ?? 30);
    this._ddaEnabled = d.enabled ?? true;
    this.onAdjust = d.onAdjust;

    this._tierId = opts?.defaultTier ?? this._order[0];
    if (!this._tiers.has(this._tierId)) {
      throw new Error(
        `[Difficulty] 默认难度 "${this._tierId}" 不存在（可用：${this._order.join(', ')}）`
      );
    }
  }

  // ---- 显式难度 ----

  get currentTierId(): string {
    return this._tierId;
  }

  get currentTier(): DifficultyTier {
    return this._tiers.get(this._tierId)!;
  }

  tiers(): readonly DifficultyTier[] {
    return this._order.map((id) => this._tiers.get(id)!);
  }

  setTier(id: string): boolean {
    if (!this._tiers.has(id)) return false;
    this._tierId = id;
    // 换难度时重置 DDA——否则上一档的调节会"泄漏"到新档
    this.resetDDA();
    return true;
  }

  // ---- DDA ----

  get ddaEnabled(): boolean {
    return this._ddaEnabled;
  }

  setDDAEnabled(v: boolean): void {
    this._ddaEnabled = v;
    if (!v) this.resetDDA();
  }

  /** 当前 DDA 调节量（-maxAdjust .. +maxAdjust） */
  get ddaValue(): number {
    return this._ddaValue;
  }

  /** 平滑后的表现评估（调试用） */
  get smoothedPerformance(): number {
    return this._smoothPerf;
  }

  resetDDA(): void {
    this._ddaValue = 0;
    this._smoothPerf = 0.5;
    this._samples = 0;
  }

  /**
   * 上报一段游戏表现
   *
   * @param performance 0~1，1 = 表现极好
   * @param duration 这段表现的时长（秒）
   */
  report(performance: number, duration: number): void {
    if (!this._ddaEnabled) return;
    if (this.currentTier.allowDDA === false) return;
    if (!(duration > 0)) return;

    const p = clamp01(performance);

    /**
     * 【指数平滑 + 样本加权】
     *
     * 前几次采样权重低（还没摸清玩家水平），
     * 之后逐渐信任历史。这让开局不会因为一次失误就大幅调整。
     */
    this._samples++;
    const k = clamp01(duration / this._windowSize);
    const alpha = clamp01(k * this._responsiveness * (this._samples < 5 ? 0.5 : 1));
    this._smoothPerf = lerp(this._smoothPerf, p, alpha);

    this._applyDDA();
  }

  /** 每帧调用（平滑逼近目标） */
  tick(dt: number): void {
    if (!this._ddaEnabled) return;
    if (this.currentTier.allowDDA === false) return;
    if (!safeDt(dt)) return;
    this._applyDDA();
  }

  private _applyDDA(): void {
    /**
     * 表现 0.5 = 中性，不调整
     * 表现 0（很挣扎）→ -maxAdjust（降低难度）
     * 表现 1（很轻松）→ +maxAdjust（提高难度）
     */
    const target = (this._smoothPerf - 0.5) * 2 * this._maxAdjust;
    const step = this._responsiveness * 0.02;
    const next = this._ddaValue + (target - this._ddaValue) * clamp01(step * 50);

    const clamped = clamp(next, -this._maxAdjust, this._maxAdjust);
    if (Math.abs(clamped - this._ddaValue) > 1e-6) {
      this._ddaValue = clamped;
      this.onAdjust?.(clamped);
    }
  }

  // ---- 查询最终倍率 ----

  /**
   * 取某项倍率（已含 DDA 调节）
   *
   * @param key 倍率键
   * @returns 最终倍率
   *
   * 【DDA 的方向问题】
   *
   * 对玩家有利的键（playerDamage、healRate、currencyGain）
   * 和不利的键（enemyHp、enemyDamage）方向**相反**：
   *
   * 玩家表现好 → 应该变难 → enemyHp ↑、playerDamage ↓
   *
   * 用错方向会让 DDA 变成"强者愈强"，这是最典型的 DDA bug。
   * 所以这里显式列出"对玩家有利"的键。
   */
  multiplier(key: string): number {
    /**
     * 【⚠️ 倍率表必须只认自有属性】
     *
     * 实测：`multiplier('toString')` 返回 **NaN** 而不是 1。
     * 因为 `multipliers['toString']` 取到 `Object.prototype.toString`（函数），
     * `?? 1` 挡不住（函数不是 null/undefined），
     * 于是 `base * (1 + delta)` = NaN，再 `Math.max(0.05, NaN)` 仍是 NaN。
     *
     * 而本函数的返回类型声明是 `number`、契约上是"倍率"——
     * 调用方拿它去乘伤害/血量，**一个 NaN 就能让角色血量永久变 NaN**，
     * 且不抛错、不崩溃，只是伤害计算静默失效。
     *
     * 倍率键常来自配置表，属于外部输入。
     */
    const base = this._multOf(this.currentTier, key);
    if (!this._ddaEnabled || this.currentTier.allowDDA === false) return base;

    // DDA 正值 = 变难
    const delta = PLAYER_FAVORING.has(key) ? -this._ddaValue : this._ddaValue;
    return Math.max(0.05, base * (1 + delta));
  }

  /** 取所有倍率（批量，避免多次查表） */
  allMultipliers(): Record<string, number> {
    const out: Record<string, number> = {};
    const keys = new Set<string>();
    for (const k of Object.keys(this.currentTier.multipliers)) keys.add(k);
    for (const t of this._tiers.values()) {
      for (const k of Object.keys(t.multipliers)) keys.add(k);
    }
    for (const k of keys) out[k] = this.multiplier(k);
    return out;
  }

  /** 原始倍率（不含 DDA，UI 显示"困难：敌人血量 ×1.35"用） */
  baseMultiplier(key: string): number {
    return this._multOf(this.currentTier, key);
  }

  /**
   * 安全读取倍率（未命中返回 1）
   *
   * 统一走这里，保证 `multiplier` / `baseMultiplier` 两处口径一致——
   * 分散加 `hasOwn` 迟早会漏掉一处。
   */
  private _multOf(tier: { readonly multipliers: Readonly<Record<string, number>> }, key: string): number {
    const m = tier.multipliers;
    if (!hasOwn(m, key)) return 1;
    const v = m[key];
    return Number.isFinite(v) ? v : 1;
  }
}

/**
 * 对玩家有利的倍率键
 *
 * 这些键在 DDA 为正（变难）时应该**减小**。
 */
const PLAYER_FAVORING = new Set<string>([
  MultiplierKeys.PLAYER_DAMAGE,
  MultiplierKeys.PLAYER_HP,
  MultiplierKeys.HEAL_RATE,
  MultiplierKeys.CURRENCY_GAIN,
]);

// ============================================================
// 工具
// ============================================================

/**
 * 从若干信号计算综合表现
 *
 * 【为什么提供】
 * "表现好坏"怎么算是设计决策，但有几个信号几乎通用。
 * 给一个合理默认值，省得每个项目都从零调。
 */
export function computePerformance(parts: {
  /** 受伤率 0~1（1 = 一直在挨打） */
  hurtRatio?: number;
  /** 死亡次数 */
  deaths?: number;
  /** 清怪速度 0~1（1 = 极快） */
  clearSpeed?: number;
  /** 剩余资源比例 0~1（血量、道具） */
  resourceLeft?: number;
}): number {
  let sum = 0;
  let weight = 0;

  if (parts.hurtRatio !== undefined) {
    sum += (1 - clamp01(parts.hurtRatio)) * 0.35;
    weight += 0.35;
  }
  if (parts.deaths !== undefined) {
    // 0 死 = 1.0，1 死 = 0.6，2 死 = 0.3，3+ = 0
    sum += clamp01(1 - parts.deaths / 3) * 0.3;
    weight += 0.3;
  }
  if (parts.clearSpeed !== undefined) {
    sum += clamp01(parts.clearSpeed) * 0.2;
    weight += 0.2;
  }
  if (parts.resourceLeft !== undefined) {
    sum += clamp01(parts.resourceLeft) * 0.15;
    weight += 0.15;
  }

  return weight > 0 ? sum / weight : 0.5;
}
