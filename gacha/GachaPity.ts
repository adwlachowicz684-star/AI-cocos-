/**
 * gacha/GachaPity.ts —— 抽卡与保底
 *
 * 【它解决什么】
 *
 * 抽卡是很多游戏的核心商业模式，也是**口碑雷区**。
 * 保底系统的目的是在"随机性"和"玩家不会永远抽不到"之间取平衡。
 *
 * 【⚠️ 和 loot/PRD 的区别】
 *
 * 这两个容易被混为一谈，但语义完全不同：
 *
 * | | loot/PRD | gacha |
 * |---|---|---|
 * 计数维度 | **每次 roll 独立** | **跨抽累计** |
 * 语义 | "连续 N 次没出，第 N+1 次概率飙升" | "抽满 N 次必定出" |
 * 重置时机 | 每次判定后立即重置 | 出货后才重置 |
 * 玩家感知 | 无感（平滑） | 强烈（"还差 10 抽保底"） |
 * 典型用途 | 掉落、暴击 | 抽卡、招募 |
 *
 * 用错的表现：拿 PRD 做抽卡，玩家会觉得"这游戏根本没保底"；
 * 拿保底做掉落，玩家会觉得"掉率忽高忽低"。
 *
 * 【零业务依赖】
 *
 * 它不认识"五星角色""武器"。
 * 只有**稀有度 id**（开放字符串）和权重表。
 */

import { IRandomSource } from '../_core/types';
import { clamp01 } from '../_core/math';

// ============================================================
// 数据结构
// ============================================================

export interface GachaItem {
  readonly id: string;
  readonly rarity: string;
  /** 池内权重 */
  readonly weight?: number;
  /**
   * 是否为"限定"（50/50 机制用）
   *
   * 【语义】只有标记为 limited 的条目才参与 50/50 判定。
   */
  readonly limited?: boolean;
  readonly data?: unknown;
}

export interface RarityConfig {
  readonly id: string;
  /** 基础概率（0~1） */
  readonly baseRate: number;
  /**
   * 软保底起始抽数
   *
   * 【什么是软保底】
   * 从第 N 抽开始概率**线性/指数上升**，
   * 到第 M 抽（hardPity）时达到 100%。
   *
   * 好处：玩家感觉"运气好提前出了"，
   * 而不是"每次都是第 90 抽才出"——后者的保底感太生硬。
   */
  readonly softPity?: number;
  /** 硬保底抽数（达到必出） */
  readonly hardPity?: number;
  /** 软保底每抽增加的概率 */
  readonly rampPerPull?: number;
  /** UI 排序（越大越稀有） */
  readonly tier?: number;
}

/** 抽卡结果 */
export interface PullResult {
  readonly item: GachaItem;
  readonly rarity: string;
  /** 这是本次的第几抽（从上次出货算起） */
  readonly pityCount: number;
  /** 是否触发硬保底 */
  readonly fromHardPity: boolean;
  /** 是否触发软保底（概率提升中） */
  readonly fromSoftPity: boolean;
  /** 50/50 是否获胜（仅 limited 池有意义） */
  readonly wonFiftyFifty?: boolean;
}

// ============================================================
// 配置
// ============================================================

export interface GachaOptions {
  readonly items: readonly GachaItem[];
  readonly rarities: readonly RarityConfig[];
  readonly rng: IRandomSource;
  /**
   * 十连保底：每 10 抽至少出一个 >= 这个稀有度的
   *
   * 【常见设定】"十连必出四星及以上"
   */
  readonly tenPullGuarantee?: string;
  /**
   * 是否启用 50/50。默认 false
   *
   * 【什么是 50/50】
   * 出金时有 50% 是限定角色，50% 是常驻。
   * 这次歪了（拿到常驻）的话，**下次出金必定是限定**。
   *
   * 这是"保证玩家最多歪一次"的机制。
   */
  readonly fiftyFifty?: boolean;
  /** 50/50 胜率。默认 0.5 */
  readonly fiftyFiftyRate?: number;
  onPull?: (r: PullResult) => void;
}

// ============================================================
// 实现
// ============================================================

export class GachaPity {
  private readonly _items: readonly GachaItem[];
  private readonly _rarityMap = new Map<string, RarityConfig>();
  private readonly _rarityOrder: string[] = [];
  private readonly _rng: IRandomSource;
  private readonly _tenPull: string | null;
  private readonly _fiftyFifty: boolean;
  private readonly _ffRate: number;

  /** 各稀有度的计数：距上次出货过了多少抽 */
  private readonly _pity = new Map<string, number>();
  /** 十连计数 */
  private _sinceTenPullGuarantee = 0;
  /** 上次 50/50 是否输了（输了下个金必定是限定） */
  private _guaranteedLimited = false;
  /** 总抽数 */
  private _totalPulls = 0;

  onPull?: (r: PullResult) => void;

  constructor(opts: GachaOptions) {
    this._items = opts.items;
    this._rng = opts.rng;
    this._tenPull = opts.tenPullGuarantee ?? null;
    this._fiftyFifty = opts.fiftyFifty ?? false;
    this._ffRate = clamp01(opts.fiftyFiftyRate ?? 0.5);
    this.onPull = opts.onPull;

    if (opts.rarities.length === 0) throw new Error('[Gacha] 至少需要一个稀有度');

    for (const r of opts.rarities) {
      if (this._rarityMap.has(r.id)) throw new Error(`[Gacha] 稀有度 id 重复：${r.id}`);
      if (r.baseRate < 0 || r.baseRate > 1) {
        throw new Error(`[Gacha] 稀有度 ${r.id} 的 baseRate 必须在 0~1，实际 ${r.baseRate}`);
      }
      if (r.hardPity !== undefined && r.softPity !== undefined && r.hardPity < r.softPity) {
        throw new Error(
          `[Gacha] 稀有度 ${r.id} 的 hardPity(${r.hardPity}) 不能小于 softPity(${r.softPity})`
        );
      }
      this._rarityMap.set(r.id, r);
      this._rarityOrder.push(r.id);
      this._pity.set(r.id, 0);
    }

    // 稀有度按 tier 降序（用于十连保底判定"及以上"）
    this._rarityOrder.sort(
      (a, b) => (this._rarityMap.get(b)?.tier ?? 0) - (this._rarityMap.get(a)?.tier ?? 0),
    );

    // 校验：所有 item 的 rarity 必须已定义
    for (const it of opts.items) {
      if (!this._rarityMap.has(it.rarity)) {
        throw new Error(
          `[Gacha] 物品 ${it.id} 引用了未定义的稀有度：${it.rarity}` +
          `（已定义：${[...this._rarityMap.keys()].join(', ')}）`
        );
      }
    }
  }

  // ---- 查询 ----

  /** 某稀有度距上次出货过多少抽 */
  pityCount(rarity: string): number {
    return this._pity.get(rarity) ?? 0;
  }

  /** 距硬保底还差几抽（无硬保底返回 null） */
  toHardPity(rarity: string): number | null {
    const r = this._rarityMap.get(rarity);
    if (!r?.hardPity) return null;
    return Math.max(0, r.hardPity - this.pityCount(rarity));
  }

  /** 当前出货概率（含软保底提升） */
  currentRate(rarity: string): number {
    const r = this._rarityMap.get(rarity);
    if (!r) return 0;
    return this._rateFor(r);
  }

  get totalPulls(): number {
    return this._totalPulls;
  }

  /** 下次出金是否必定是限定（50/50 保底） */
  get guaranteedLimited(): boolean {
    return this._guaranteedLimited;
  }

  // ---- 抽卡 ----

  /** 单抽 */
  pull(): PullResult {
    return this._doPull();
  }

  /** 十连 */
  pullTen(): PullResult[] {
    const out: PullResult[] = [];
    for (let i = 0; i < 10; i++) out.push(this._doPull());
    return out;
  }

  /** 抽 N 次 */
  pullN(n: number): PullResult[] {
    if (n <= 0) return [];
    const out: PullResult[] = [];
    for (let i = 0; i < n; i++) out.push(this._doPull());
    return out;
  }

  // ---- 存档 ----

  snapshot(): GachaSnapshot {
    const pity: Record<string, number> = {};
    for (const [k, v] of this._pity) pity[k] = v;
    return {
      pity,
      sinceTenPullGuarantee: this._sinceTenPullGuarantee,
      guaranteedLimited: this._guaranteedLimited,
      totalPulls: this._totalPulls,
    };
  }

  restore(s: GachaSnapshot | null | undefined): void {
    if (!s) return;
    for (const id of this._rarityOrder) this._pity.set(id, 0);
    if (s.pity) {
      for (const [k, v] of Object.entries(s.pity)) {
        if (this._pity.has(k) && typeof v === 'number' && Number.isFinite(v)) {
          this._pity.set(k, Math.max(0, Math.floor(v)));
        }
      }
    }
    this._sinceTenPullGuarantee = Math.max(0, s.sinceTenPullGuarantee ?? 0);
    this._guaranteedLimited = !!s.guaranteedLimited;
    this._totalPulls = Math.max(0, s.totalPulls ?? 0);
  }

  reset(): void {
    for (const id of this._rarityOrder) this._pity.set(id, 0);
    this._sinceTenPullGuarantee = 0;
    this._guaranteedLimited = false;
    this._totalPulls = 0;
  }

  // ---- 内部 ----

  /**
   * 计算当前抽中该稀有度的概率
   *
   * 【⚠️ 曾经的 bug：多算了一次 +1】
   *
   * `_doPull()` 在判定**之前**已经把计数推进过了
   * （第 N 抽时 `pityCount === N`），
   * 而这里原本又写 `n + 1 >= hardPity`，
   * 结果硬保底在**第 89 抽**就触发，而不是承诺的第 90 抽。
   *
   * 症状有多隐蔽：
   * - 不报错、不崩溃
   * - 玩家几乎察觉不到（只差一抽）
   * - 但"抽满 90 必出"是写进规则的**承诺**，
   *   玩家数着抽数对照时会发现对不上，信任受损
   *
   * 差一错误在保底系统里尤其危险，
   * 因为它的输出（抽数）是玩家能直接数出来的。
   *
   * 【判据】`pityCount` 的语义是"这是第几抽（含本次）"，
   * 所以直接和 hardPity 比较，不再 +1。
   */
  private _rateFor(r: RarityConfig): number {
    const n = this.pityCount(r.id);

    // 硬保底：第 hardPity 抽（含）必定出货
    if (r.hardPity !== undefined && n >= r.hardPity) return 1;

    let rate = r.baseRate;

    // 软保底：从第 softPity 抽之后开始线性提升
    if (r.softPity !== undefined && n > r.softPity) {
      const ramp =
        r.rampPerPull ??
        (1 - r.baseRate) / Math.max(1, (r.hardPity ?? r.softPity + 10) - r.softPity);
      rate += (n - r.softPity) * ramp;
    }
    return clamp01(rate);
  }

  private _doPull(): PullResult {
    this._totalPulls++;
    this._sinceTenPullGuarantee++;

    // ① 先推进所有计数（本抽算进去）
    for (const id of this._rarityOrder) {
      this._pity.set(id, this.pityCount(id) + 1);
    }

    // ② 从最高稀有度往下判定
    let chosen: string | null = null;
    let hardPity = false;
    let softPity = false;

    for (const id of this._rarityOrder) {
      const r = this._rarityMap.get(id)!;
      const rate = this._rateFor(r);
      if (this._rng.next() < rate) {
        chosen = id;
        hardPity = r.hardPity !== undefined && this.pityCount(id) >= r.hardPity;
        softPity = r.softPity !== undefined && this.pityCount(id) > r.softPity && !hardPity;
        break;
      }
    }

    // ③ 都没中 → 给最低稀有度
    if (chosen === null) {
      chosen = this._rarityOrder[this._rarityOrder.length - 1];
      const r = this._rarityMap.get(chosen)!;
      hardPity = r.hardPity !== undefined && this.pityCount(chosen) >= r.hardPity;
    }

    // ④ 十连保底：最后一个还没达到指定稀有度则强制给
    // 【坑】这里绝不能加「是不是批次最后一抽」的条件
    //
    // 早期版本写成 `isLastOfBatch && ... >= 10`，
    // 于是玩家一抽一抽地点时，这个条件**永远不成立**——
    // 实测 10 个种子各连抽 60 次单抽，承诺「每 10 抽必出」的四星**一次都没出**。
    // 玩家攒石头单抽是最常见的行为，这等同于虚假宣传。
    //
    // 承诺是「每 10 抽必出」，就得按**累计抽数**算，跟是不是一批无关。
    const tenApplies = this._tenPull !== null && this._sinceTenPullGuarantee >= 10;
    if (tenApplies && !this._isAtLeast(chosen, this._tenPull!)) {
      chosen = this._tenPull!;
      hardPity = false;
      softPity = false;
    }

    // ⑤ 选具体物品
    let item = this._pickItem(chosen, null);

    let wonFF: boolean | undefined;
    if (this._fiftyFifty && chosen === this._rarityOrder[0]) {
      const limitedPool = this._items.filter(
        (i) => i.rarity === chosen && i.limited === true,
      );
      if (limitedPool.length > 0) {
        if (this._guaranteedLimited) {
          // 上次歪了 → 这次必定限定
          item = this._pickItem(chosen, true);
          wonFF = true;
          this._guaranteedLimited = false;
        } else if (this._rng.next() < this._ffRate) {
          item = this._pickItem(chosen, true);
          wonFF = true;
          this._guaranteedLimited = false;
        } else {
          // 【坑】判负前必须确认「真的有常驻可歪」
          //
          // _pickItem(chosen, false) 在**非限定池为空**时会降级返回全池，
          // 也就是把限定物品发给了判负的玩家——
          // UI 播报「歪了」，实际拿到的是限定，自相矛盾。
          // 实测：池内 r5 全是 limited 时，100% 的判负都误发了限定。
          //
          // 所以这里先查一遍常驻池，没有就直接判胜。
          const stdPool = this._items.filter(
            (i) => i.rarity === chosen && i.limited !== true,
          );
          if (stdPool.length === 0) {
            // 没有常驻可歪 —— 判胜，不要「判负 + 发限定」
            item = this._pickItem(chosen, true);
            wonFF = true;
            this._guaranteedLimited = false;
          } else {
            item = this._pickItem(chosen, false);
            wonFF = false;
            this._guaranteedLimited = true;   // 下次必定限定
          }
        }
      }
    }

    // ⑥ 重置计数：出货稀有度**及以下**全部清零
    const chosenTier = this._rarityMap.get(chosen)?.tier ?? 0;
    for (const id of this._rarityOrder) {
      const t = this._rarityMap.get(id)?.tier ?? 0;
      // 【关键】出五星时，四星计数也要清零
      // （因为四星计数统计的是"距上次出四星"，而刚出的五星也算四星及以上）
      if (t <= chosenTier || id === chosen) this._pity.set(id, 0);
    }

    if (this._isAtLeast(chosen, this._tenPull ?? '')) {
      this._sinceTenPullGuarantee = 0;
    }

    const result: PullResult = {
      item,
      rarity: chosen,
      pityCount: this._pity.get(chosen) ?? 0,
      fromHardPity: hardPity,
      fromSoftPity: softPity,
      ...(wonFF !== undefined ? { wonFiftyFifty: wonFF } : {}),
    };
    this.onPull?.(result);
    return result;
  }

  /** rarity 是否 >= 目标稀有度 */
  private _isAtLeast(rarity: string, target: string): boolean {
    if (!target) return false;
    const a = this._rarityMap.get(rarity)?.tier ?? 0;
    const b = this._rarityMap.get(target)?.tier ?? 0;
    return a >= b;
  }

  /**
   * 从某稀有度里按权重选一个物品
   *
   * @param limitedOnly true = 只要限定的｜false = 只要非限定的｜null = 不限
   */
  private _pickItem(rarity: string, limitedOnly: boolean | null): GachaItem {
    const pool = this._items.filter((i) => {
      if (i.rarity !== rarity) return false;
      if (limitedOnly === null) return true;
      return limitedOnly ? i.limited === true : i.limited !== true;
    });

    // 【降级】限定池为空时退回全池，而不是崩溃或返回空
    const use = pool.length > 0 ? pool : this._items.filter((i) => i.rarity === rarity);
    if (use.length === 0) {
      // 该稀有度没有任何物品：配置错误，但宁可给个别的也不崩
      const any = this._items[0];
      if (!any) throw new Error('[Gacha] 物品池为空');
      return any;
    }

    let total = 0;
    for (const i of use) total += Math.max(0, i.weight ?? 1);
    if (total <= 0) return use[0];

    let x = this._rng.next() * total;
    for (const i of use) {
      x -= Math.max(0, i.weight ?? 1);
      if (x <= 0) return i;
    }
    return use[use.length - 1];
  }
}

export interface GachaSnapshot {
  readonly pity: Record<string, number>;
  readonly sinceTenPullGuarantee: number;
  readonly guaranteedLimited: boolean;
  readonly totalPulls: number;
}

// ============================================================
// 模拟（平衡验证用）
// ============================================================

export interface SimulationReport {
  readonly pulls: number;
  readonly counts: Record<string, number>;
  readonly rates: Record<string, number>;
  /** 各稀有度的平均出货抽数（无硬保底则为 0） */
  readonly avgPity: Record<string, number>;
  /** 最长未出货记录 */
  readonly worstDry: Record<string, number>;
}

/**
 * 模拟大量抽卡，验证保底是否符合预期
 *
 * 【为什么必须做】
 * 保底配置的手感和实际分布差很远。
 * "90 抽保底、0.6% 基础率"听起来合理，
 * 但实际平均出货抽数可能是 62 抽——
 * 和你以为的"大部分人 90 抽才出"完全不同。
 *
 * **上线前跑 10 万次，看真实分布。**
 */
export function simulate(
  opts: GachaOptions,
  pulls: number,
): SimulationReport {
  const g = new GachaPity({ ...opts, onPull: undefined });
  const counts: Record<string, number> = {};
  const pitySums: Record<string, number> = {};
  const pityCounts: Record<string, number> = {};
  const worst: Record<string, number> = {};
  const curDry: Record<string, number> = {};

  for (const id of g['_rarityOrder'] as string[]) {
    counts[id] = 0;
    pitySums[id] = 0;
    pityCounts[id] = 0;
    worst[id] = 0;
    curDry[id] = 0;
  }

  for (let i = 0; i < pulls; i++) {
    const before: Record<string, number> = {};
    for (const id of Object.keys(counts)) before[id] = g.pityCount(id);

    const r = g.pull();
    counts[r.rarity] = (counts[r.rarity] ?? 0) + 1;

    const n = (before[r.rarity] ?? 0) + 1;
    pitySums[r.rarity] += n;
    pityCounts[r.rarity] += 1;

    /**
     * 【⚠️ 曾经的 bug：干涸统计口径与保底语义不一致】
     *
     * 原写法是"除了出货的那个稀有度，其余全部 +1"，
     * 于是在"第 50 抽出了五星"时，四星的 dry 也继续累加，
     * 最终报出 `worstDry['r4'] = 23` 这种数字——
     * 看起来像"四星保底失效了"，但保底其实是好的。
     *
     * 玩家视角：抽到五星当然算"出货"，
     * 不会有人抱怨"我 23 抽没出四星"（他明明出了更好的）。
     *
     * 【修法】与 `_doPull` 的重置口径保持一致：
     * 出货稀有度**及以下** tier 的干涸计数全部清零。
     * 这样 `worstDry[r]` 的语义是
     * "连续多少抽没拿到 r 及以上"，才是保底真正承诺的东西。
     */
    const gotTier = g['_rarityMap'].get(r.rarity)?.tier ?? 0;
    for (const id of Object.keys(counts)) {
      const t = g['_rarityMap'].get(id)?.tier ?? 0;
      if (id === r.rarity || t <= gotTier) {
        curDry[id] = 0;
      } else {
        curDry[id] += 1;
        if (curDry[id] > worst[id]) worst[id] = curDry[id];
      }
    }
  }

  const rates: Record<string, number> = {};
  const avgPity: Record<string, number> = {};
  for (const id of Object.keys(counts)) {
    rates[id] = pulls > 0 ? counts[id] / pulls : 0;
    avgPity[id] = pityCounts[id] > 0 ? pitySums[id] / pityCounts[id] : 0;
  }

  return { pulls, counts, rates, avgPity, worstDry: worst };
}
