/**
 * WeightedTable —— 加权随机表
 *
 * 【它解决什么】
 * 掉落、刷怪、事件选择……本质都是「按权重抽一个」。
 * 手写这些逻辑会写出一堆 `let sum = 0; for(...) sum += w;` 的重复代码，
 * 而且每个人写出来的边界处理都不一样。
 *
 * 【为什么用前缀和优化】
 * 朴素做法每次抽都要遍历累加 O(n)。
 * 掉落调用频率不高，但**刷怪**每帧可能调用几十次，
 * 而且 n 可能是几百。前缀和 + 二分查找是 O(log n)。
 *
 * 【使用示例】
 * ```typescript
 * const table = new WeightedTable<string>();
 * table.add('金币', 70);
 * table.add('药水', 25);
 * table.add('传说武器', 5);
 *
 * table.pick(rng);              // '金币'
 * table.pickMany(3, rng);       // 可重复
 * table.pickUnique(3, rng);     // 不重复（用于"三选一"）
 *
 * // 动态调整权重（比如随难度提升传说概率）
 * table.setWeight('传说武器', 15);
 * ```
 *
 * 【无引擎依赖】随机源通过 IRandomSource 注入。
 */

import { IRandomSource } from '../_core/types';

interface Item<T> {
  value: T;
  weight: number;
}

export class WeightedTable<T> {
  private readonly _items: Item<T>[] = [];
  /** 前缀和缓存。null = 需要重算 */
  private _cumulative: number[] | null = null;
  private _total = 0;

  add(value: T, weight = 1): this {
    if (!(weight > 0)) throw new Error(`[WeightedTable] 权重必须为正，实际 ${weight}`);
    this._items.push({ value, weight });
    this._cumulative = null;
    return this;
  }

  /** 修改权重（值相同的第一个匹配项） */
  setWeight(value: T, weight: number): boolean {
    if (!(weight >= 0)) throw new Error(`[WeightedTable] 权重不能为负，实际 ${weight}`);
    const it = this._items.find((i) => i.value === value);
    if (!it) return false;
    it.weight = weight;
    this._cumulative = null;
    return true;
  }

  remove(value: T): boolean {
    const i = this._items.findIndex((i) => i.value === value);
    if (i < 0) return false;
    this._items.splice(i, 1);
    this._cumulative = null;
    return true;
  }

  clear(): void {
    this._items.length = 0;
    this._cumulative = null;
    this._total = 0;
  }

  get count(): number {
    return this._items.length;
  }

  get totalWeight(): number {
    this._rebuild();
    return this._total;
  }

  /**
   * 抽一个
   *
   * 【边界】总权重为 0（所有项都被设为 0）时返回 undefined，不崩溃。
   * 这个语义很重要：动态难度下可能所有项权重都归零，
   * 崩溃的话就是"难度调到某个值时游戏炸了"这种难复现的 bug。
   */
  pick(rng: IRandomSource): T | undefined {
    this._rebuild();
    if (this._total <= 0 || this._items.length === 0) return undefined;

    const target = rng.next() * this._total;
    const cum = this._cumulative!;

    // 二分查找第一个 > target 的位置
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid + 1;
      else hi = mid;
    }
    return this._items[lo].value;
  }

  /** 抽 n 个（可重复） */
  pickMany(n: number, rng: IRandomSource): T[] {
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      const v = this.pick(rng);
      if (v === undefined) break;
      out.push(v);
    }
    return out;
  }

  /**
   * 抽 n 个不重复的（三选一的核心）
   *
   * 【实现】复制到临时表，抽中后把权重设为 0 再抽下一个。
   * 【边界】请求数量 > 可选数量时，返回全部（不崩溃、不重复填充）。
   */
  pickUnique(n: number, rng: IRandomSource): T[] {
    const n2 = Math.max(0, Math.floor(n));
    if (n2 === 0 || this._items.length === 0) return [];

    const work = new WeightedTable<T>();
    /**
     * 【⚠️ 建临时表时必须跳过权重 ≤ 0 的项，不能直接 add】
     *
     * `setWeight(v, 0)` 是调用方"临时下架一个掉落"的自然写法，
     * 它本身是合法的（setWeight 只要求 `weight >= 0`）。
     * 但 `add()` 要求 `weight > 0`，于是：
     *
     *   同一个表：pick() 正常 → pickUnique() 抛
     *   `[WeightedTable] 权重必须为正，实际 0`
     *
     * **同一份数据、两个 API、两种行为**——
     * 而且炸的时机是"玩家点了三选一"，不是配表时。
     *
     * 【为什么用肯定式 `> 0` 而不是 `>= 0` 或 `!= 0`】
     * 权重被污染成 NaN 时，`NaN > 0` 为 false → 该项被跳过，
     * 不会带着 NaN 进前缀和（NaN 会让二分查找结果不可预期）。
     * 否定式写法（如 `!(w <= 0)`）会把 NaN 放进来。
     */
    for (const it of this._items) {
      if (it.weight > 0) work.add(it.value, it.weight);
    }

    const out: T[] = [];
    for (let i = 0; i < n2; i++) {
      const v = work.pick(rng);
      if (v === undefined) break; // 权重都耗尽了
      out.push(v);
      work.setWeight(v, 0); // 权重 0 的项不会被 pick 到（除了只剩它时——见下）
      work.removeZeroWeights();
    }
    return out;
  }

  private removeZeroWeights(): void {
    for (let i = this._items.length - 1; i >= 0; i--) {
      if (this._items[i].weight <= 0) this._items.splice(i, 1);
    }
    this._cumulative = null;
  }

  private _rebuild(): void {
    if (this._cumulative !== null) return;
    const cum: number[] = new Array(this._items.length);
    let sum = 0;
    for (let i = 0; i < this._items.length; i++) {
      sum += this._items[i].weight;
      cum[i] = sum;
    }
    this._cumulative = cum;
    this._total = sum;
  }

  /** 导出（调试与存档用） */
  toArray(): Array<{ value: T; weight: number }> {
    return this._items.map((i) => ({ value: i.value, weight: i.weight }));
  }

  destroy(): void {
    this.clear();
  }
}
