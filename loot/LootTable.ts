/**
 * LootTable —— 掉落表
 *
 * 【与 WeightedTable 的区别】
 * WeightedTable 抽「一个」；LootTable 抽「一组」：
 * - 每条可以有数量区间（掉 2–5 个金币）
 * - 支持嵌套（掉一个「宝箱」，宝箱里再抽）
 * - 支持必掉项与保底
 *
 * 【保底（pity）为什么必须有】
 * 稀有的 5% 掉落，玩家刷 20 次一次不出是完全正常的（35.8% 概率）。
 * 但玩家不会算概率，只会觉得「这游戏在耍我」。
 *
 * 保底机制：连续 N 次没出稀有，就强制给一个（或大幅提升权重）。
 * 这是**体验设计**，不是概率设计——它的作用是给玩家一个"确定的希望"。
 *
 * 【使用示例】
 * ```typescript
 * const bossLoot = new LootTable('boss')
 *   .entry({ id: 'gold',   weight: 100, min: 50, max: 120 })
 *   .entry({ id: 'potion', weight: 30,  min: 1,  max: 3 })
 *   .entry({ id: 'legendary', weight: 5, min: 1, max: 1, rare: true })
 *   .withPity({ rareKey: 'legendary', threshold: 10 });
 *
 * const drops = bossLoot.roll(rng);
 * // [{ id: 'gold', count: 87 }, { id: 'potion', count: 2 }]
 *
 * // 多次 roll 之间有状态（保底计数），所以每个玩家要有自己的实例
 * ```
 *
 * 【无引擎依赖】随机源通过 IRandomSource 注入。
 */

import { IRandomSource } from '../_core/types';

/** 掉落条目 */
export interface LootEntry {
  readonly id: string;
  /** 权重（必掉项忽略权重） */
  readonly weight: number;
  /** 最小数量 */
  readonly min: number;
  /** 最大数量 */
  readonly max: number;
  /**
   * 必掉（每次 roll 都会出现）
   * 用途：Boss 必掉通关道具
   */
  readonly guaranteed?: boolean;
  /**
   * 标记为稀有（参与保底统计）
   * 只有标记了 rare 的条目才会触发 pity
   */
  readonly rare?: boolean;
  /**
   * 嵌套子表（掉到这个条目时，继续在子表里 roll）
   * 【坑】嵌套层数过深会导致一次掉落产出几十个物品，
   * 建议最多 2 层，并在子表里控制数量。
   */
  readonly child?: LootTable;
}

/** 一次掉落的结果 */
export interface LootDrop {
  readonly id: string;
  readonly count: number;
  /** 由保底强制给出的（UI 可高亮显示） */
  readonly fromPity?: boolean;
  /** 嵌套子表产出的结果 */
  readonly children?: LootDrop[];
}

export interface PityOptions {
  /** 连续多少次没出稀有后强制给一个 */
  readonly threshold: number;
  /**
   * 保底触发时给哪个 id
   * 不填则给一个随机 rare 条目
   */
  readonly fallbackId?: string;
  /** 是否提升权重（true=软保底，false=硬保底）。默认硬保底 */
  readonly soft?: boolean;
}

export class LootTable {
  private readonly _entries: LootEntry[] = [];
  private _pity: PityOptions | null = null;

  /** 距离上次出稀有的 roll 次数 */
  private _sinceRare = 0;

  constructor(public readonly name = 'loot') {}

  /**
   * 添加条目（支持链式）
   *
   * 【校验】min > max 是最常见的配置错误，
   * 直接在这里拦下，避免表现为"掉负数个物品"。
   */
  entry(e: LootEntry): this {
    if (e.min > e.max) throw new Error(`[LootTable] ${e.id}: min(${e.min}) > max(${e.max})`);
    if (e.min < 0) throw new Error(`[LootTable] ${e.id}: min 不能为负`);
    if (!e.guaranteed && !(e.weight > 0)) {
      throw new Error(`[LootTable] ${e.id}: 非必掉项权重必须为正`);
    }
    this._entries.push(e);
    return this;
  }

  /** 设置保底 */
  withPity(opts: PityOptions): this {
    if (opts.threshold < 1) throw new Error('[LootTable] 保底阈值至少为 1');
    this._pity = opts;
    return this;
  }

  get entryCount(): number {
    return this._entries.length;
  }

  /** 距离上次稀有的次数（调试/UI 显示"再 X 次必出"） */
  get sinceRare(): number {
    return this._sinceRare;
  }

  /** 距离保底还差几次（未启用保底返回 -1） */
  get pityRemaining(): number {
    if (!this._pity) return -1;
    return Math.max(0, this._pity.threshold - this._sinceRare);
  }

  /**
   * 掷一次掉落
   *
   * 【性能】rollCount 次遍历 + 二分，O(n log n)。
   * 掉落不是每帧调用，可接受。刷怪那种高频场景用 WeightedTable。
   */
  roll(rng: IRandomSource): LootDrop[] {
    const out: LootDrop[] = [];
    let gotRare = false;

    // ① 必掉项
    for (const e of this._entries) {
      if (e.guaranteed) out.push(this._makeDrop(e, rng, false));
    }

    // ② 加权项：每条独立判定
    const rollable = this._entries.filter((e) => !e.guaranteed);
    const total = rollable.reduce((s, e) => s + this._weightOf(e), 0);

    if (total > 0) {
      for (const e of rollable) {
        /**
         * 【设计选择：每条独立判定 vs 只抽一条】
         * 这里用独立判定——每条都掷一次，中了就掉。
         * 语义是"每个物品有自己的掉率"，这是大多数游戏的做法
         * （而不是"只掉一种"）。
         */
        if (rng.next() * total < this._weightOf(e)) {
          out.push(this._makeDrop(e, rng, false));
          if (e.rare) gotRare = true;
        }
      }
    }

    // ③ 保底
    if (this._pity && !gotRare) {
      this._sinceRare++;
      if (this._sinceRare >= this._pity.threshold) {
        const forced = this._forcePity(rng);
        if (forced) out.push(forced);
        this._sinceRare = 0;
      }
    } else if (gotRare) {
      this._sinceRare = 0;
    }

    return out;
  }

  private _weightOf(e: LootEntry): number {
    if (!this._pity || !this._pity.soft || !e.rare) return e.weight;
    // 软保底：越接近阈值，稀有权重越高
    const ratio = this._sinceRare / this._pity.threshold;
    return e.weight * (1 + ratio * 9); // 最高 10 倍
  }

  private _forcePity(rng: IRandomSource): LootDrop | null {
    const p = this._pity!;
    if (p.fallbackId) {
      const e = this._entries.find((x) => x.id === p.fallbackId);
      if (e) return this._makeDrop(e, rng, true);
    }
    const rares = this._entries.filter((e) => e.rare);
    if (rares.length === 0) return null;
    const e = rares[Math.floor(rng.next() * rares.length)];
    return this._makeDrop(e, rng, true);
  }

  private _makeDrop(e: LootEntry, rng: IRandomSource, fromPity: boolean): LootDrop {
    const span = e.max - e.min;
    const count = span <= 0 ? e.min : e.min + Math.floor(rng.next() * (span + 1));

    const drop: LootDrop = {
      id: e.id,
      count,
      ...(fromPity ? { fromPity: true } : {}),
    };

    if (e.child) {
      const children = e.child.roll(rng);
      return { ...drop, children };
    }
    return drop;
  }

  /** 重置保底计数（存档读取、换关时） */
  resetPity(): void {
    this._sinceRare = 0;
  }

  /** 序列化保底状态（存档用） */
  exportPity(): number {
    return this._sinceRare;
  }

  importPity(n: number): void {
    this._sinceRare = Math.max(0, Math.floor(n));
  }

  destroy(): void {
    this._entries.length = 0;
    this._pity = null;
  }
}
