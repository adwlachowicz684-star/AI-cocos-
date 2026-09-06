/**
 * rarity/Rarity.ts —— 稀有度
 *
 * 【它解决什么】
 *
 * 每个有掉落的游戏都有稀有度：普通 / 精良 / 稀有 / 史诗 / 传说。
 * 但"稀有度"不只是个排序——它还牵扯到：
 *
 * - 掉落权重
 * - UI 颜色
 * - 保底计数（哪些档位算数）
 * - 排序与比较
 *
 * 手写的做法是到处 `if (rarity === 'legendary')`，
 * 加一个新档位要改十几个地方。
 *
 * 本模块把稀有度做成**数据驱动的排序表**：
 *
 * ```typescript
 * const r = new Rarity(CommonRarity);
 * r.isRarer('epic', 'rare');    // true
 * r.weight('legendary', 1);     // 1
 * r.roll(rng);                  // 按权重抽一个
 * ```
 *
 * 【三个必须处理的真实问题】
 *
 * 1. **未知 id**：存档里有已删除的稀有度，UI 不该崩
 * 2. **保底归属**：有些档位不该计入保底（比如活动专属）
 * 3. **排序稳定**：`order` 重复会导致排序不确定
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

export interface RarityDef {
  readonly id: string;
  /** UI 显示名 */
  readonly name: string;
  /** 基础掉落权重（越大越常见） */
  readonly weight: number;
  /**
   * 稀有度序号，越大越稀有
   *
   * 【为什么不直接用数组顺序】
   * 配表时中间插入一档，序号可以保持连续语义
   * （"3 是稀有"这种认知不会变）。
   */
  readonly order: number;
  /** UI 颜色（十六进制或 CSS 颜色，由宿主解释） */
  readonly color?: string;
  /**
   * 是否计入保底（默认 true）
   *
   * 【用途】活动专属稀有度不该推进常规保底，
   * 否则玩家抽活动池会"偷走"常规池的保底进度。
   */
  readonly countsForPity?: boolean;
  readonly desc?: string;
}

/** 通用五档预设 */
export const CommonRarity: readonly RarityDef[] = [
  { id: 'common', name: '普通', weight: 200, order: 1, color: '#9E9E9E' },
  { id: 'uncommon', name: '精良', weight: 80, order: 2, color: '#4CAF50' },
  { id: 'rare', name: '稀有', weight: 30, order: 3, color: '#2196F3' },
  { id: 'epic', name: '史诗', weight: 8, order: 4, color: '#9C27B0' },
  { id: 'legendary', name: '传说', weight: 1, order: 5, color: '#FF9800' },
];

/** 简化的三档预设（小游戏 / Demo 用） */
export const SimpleRarity: readonly RarityDef[] = [
  { id: 'junk', name: '粗糙', weight: 60, order: 1 },
  { id: 'normal', name: '普通', weight: 30, order: 2 },
  { id: 'rare', name: '稀有', weight: 10, order: 3 },
];

/** 抽取用的随机源（与 RNG 解耦） */
export interface RandomSource {
  next(): number;
}

// ==================== 实现 ====================

export class Rarity {
  private readonly _defs: readonly RarityDef[];
  private readonly _byId = new Map<string, RarityDef>();
  private readonly _sorted: readonly RarityDef[];
  private readonly _ascending: readonly RarityDef[];

  constructor(defs: readonly RarityDef[]) {
    if (defs.length === 0) {
      throw new Error('[Rarity] 至少需要一个稀有度');
    }

    for (const d of defs) {
      if (this._byId.has(d.id)) {
        throw new Error(`[Rarity] 稀有度 id 重复：${d.id}`);
      }
      if (!(d.weight > 0)) {
        throw new Error(`[Rarity] 稀有度 "${d.id}" 的 weight 必须为正，实际 ${d.weight}`);
      }
      this._byId.set(d.id, d);
    }

    // order 唯一性校验
    const orders = new Set<number>();
    for (const d of defs) {
      if (orders.has(d.order)) {
        throw new Error(
          `[Rarity] order 重复：${d.order}（"${d.id}" 与其他稀有度冲突）`
        );
      }
      orders.add(d.order);
    }

    this._defs = [...defs];
    this._sorted = [...defs].sort((a, b) => b.order - a.order);
    this._ascending = [...defs].sort((a, b) => a.order - b.order);
  }

  // ==================== 查询 ====================

  /** 全部稀有度（按稀有度降序，最稀有的在前） */
  get all(): readonly RarityDef[] {
    return this._sorted;
  }

  /** 升序（最普通的在前） */
  get allAscending(): readonly RarityDef[] {
    return this._ascending;
  }

  get highest(): RarityDef {
    return this._sorted[0];
  }

  get lowest(): RarityDef {
    return this._ascending[0];
  }

  get(id: string): RarityDef | undefined {
    return this._byId.get(id);
  }

  /**
   * 查询，未知 id 回退到最低稀有度
   *
   * 【为什么不抛错】
   * 存档里可能有已删除的稀有度。
   * 静默降级比让 UI 崩溃好——玩家看到的是"这个东西变成普通品质了"，
   * 而不是"游戏打不开了"。
   */
  getOrFallback(id: string): RarityDef {
    return this._byId.get(id) ?? this.lowest;
  }

  /** a 是否比 b 稀有 */
  isRarer(a: string, b: string): boolean {
    const da = this.getOrFallback(a);
    const db = this.getOrFallback(b);
    return da.order > db.order;
  }

  /** a 是否达到 b 的稀有度（含等于） */
  atLeast(a: string, b: string): boolean {
    const da = this.getOrFallback(a);
    const db = this.getOrFallback(b);
    return da.order >= db.order;
  }

  /**
   * 排序比较器（最稀有的在前）
   *
   * 用法：`ids.sort(r.compare.bind(r))`
   */
  compare(a: string, b: string): number {
    const da = this.getOrFallback(a);
    const db = this.getOrFallback(b);
    return db.order - da.order;
  }

  // ==================== 权重与抽取 ====================

  /**
   * 计算实际权重
   *
   * @param factor 系数。用于"这件传说比那件传说更稀有"
   */
  weight(id: string, factor = 1): number {
    return this.getOrFallback(id).weight * factor;
  }

  /** 按权重抽一个稀有度 */
  roll(rng: RandomSource): RarityDef {
    let total = 0;
    for (const d of this._defs) total += d.weight;
    if (total <= 0) return this.lowest;

    let r = rng.next() * total;
    for (const d of this._defs) {
      r -= d.weight;
      if (r < 0) return d;
    }
    return this._defs[this._defs.length - 1];
  }

  /**
   * 只在指定集合里抽
   *
   * 【用途】某个宝箱只出 epic 及以上。
   */
  rollAmong(ids: readonly string[], rng: RandomSource): RarityDef {
    const pool = ids
      .map((id) => this._byId.get(id))
      .filter((d): d is RarityDef => d !== undefined);

    if (pool.length === 0) return this.lowest;

    let total = 0;
    for (const d of pool) total += d.weight;
    if (total <= 0) return pool[pool.length - 1];

    let r = rng.next() * total;
    for (const d of pool) {
      r -= d.weight;
      if (r < 0) return d;
    }
    return pool[pool.length - 1];
  }

  // ==================== 保底 ====================

  /** 该稀有度是否计入保底 */
  countsForPity(id: string): boolean {
    return this.getOrFallback(id).countsForPity !== false;
  }

  /** 计入保底的稀有度列表 */
  pityEligible(): readonly RarityDef[] {
    return this._sorted.filter((d) => d.countsForPity !== false);
  }

  // ==================== 统计 ====================

  /**
   * 统计各稀有度出现次数
   *
   * 【未出现的也有键】方便 UI 直接遍历，不用做存在性判断。
   */
  tally(ids: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of this._defs) out[d.id] = 0;
    for (const id of ids) {
      out[this.getOrFallback(id).id] += 1;
    }
    return out;
  }

  /** 取一批里最稀有的（空数组返回 null） */
  best(ids: readonly string[]): RarityDef | null {
    if (ids.length === 0) return null;
    let best: RarityDef | null = null;
    for (const id of ids) {
      const d = this.getOrFallback(id);
      if (best === null || d.order > best.order) best = d;
    }
    return best;
  }
}
