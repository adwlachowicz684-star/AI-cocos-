/**
 * ShuffleBag —— 洗牌袋（无放回抽取）
 *
 * 【它解决什么】
 *
 * 纯随机会出现「连续 5 次都是同一个」的聚集现象。
 * 很多场景下这很糟：
 * - 随机音效：连着 5 次同一声，听感廉价
 * - 关卡房间：连着 5 个战斗房，节奏单调
 * - 掉落：连着 5 次都是金币，玩家觉得敷衍
 *
 * ShuffleBag 的保证：**一轮之内每个元素恰好出现一次**。
 * 仍然是随机的（顺序随机），但没有聚集。
 *
 * 【与"洗牌后依次取"的区别】
 * 朴素做法：shuffle 一遍，取完再 shuffle。
 * 问题：两轮交界处可能出现「上一轮最后一个 = 下一轮第一个」的重复。
 * ShuffleBag 默认避免这个（`avoidEdgeRepeat`）。
 *
 * 【使用示例】
 * ```typescript
 * const bag = new ShuffleBag<string>();
 * bag.add('hit1', 1); bag.add('hit2', 1); bag.add('hit3', 1);
 *
 * bag.draw(rng);   // 'hit2'
 * bag.draw(rng);   // 'hit1'
 * bag.draw(rng);   // 'hit3'
 * bag.draw(rng);   // 自动重洗，且保证 ≠ 'hit3'
 * ```
 *
 * 【无引擎依赖】随机源通过 IRandomSource 注入。
 */

import { IRandomSource } from '../_core/types';
import { needCount } from '../_core/guard';

export interface ShuffleBagOptions {
  /**
   * 重洗时避免与上一轮最后一个重复
   *
   * 【为什么默认开】
   * 交界处的重复最容易被玩家察觉（"又是这个"），
   * 而避免它几乎不损失随机性。
   */
  avoidEdgeRepeat?: boolean;
}

interface Entry<T> {
  value: T;
  count: number;
}

export class ShuffleBag<T> {
  private readonly _entries: Entry<T>[] = [];
  private _bag: T[] = [];
  private _lastDrawn: T | undefined;
  private readonly _avoidEdgeRepeat: boolean;

  constructor(opts: ShuffleBagOptions = {}) {
    this._avoidEdgeRepeat = opts.avoidEdgeRepeat ?? true;
  }

  /** 添加元素（count = 权重，占几个格子） */
  add(value: T, count = 1): this {
    /**
     * 【⚠️ count 必须有上界】
     *
     * `count` 就是 `_refill` 里 `for (let i = 0; i < e.count; i++)` 的次数。
     * 实测 `bag.add('a', Infinity)` 后调用 `next()` → 退出码 124，进程卡死。
     *
     * 老实现只有 `count <= 0` 的检查：
     * - Infinity 畅通无阻 → 无限 push
     * - NaN 也畅通（`NaN <= 0` 为 false）→ 权重变 NaN，之后洗牌索引全乱
     *
     * `needCount` 同时拦住这两种，并要求整数（权重本就是"占几个格子"）。
     */
    const n = needCount(count, 'count');
    if (n === 0) throw new Error(`[ShuffleBag] count 必须为正，实际 ${count}`);

    const exist = this._entries.find((e) => e.value === value);
    if (exist) exist.count += n;
    else this._entries.push({ value, count: n });
    this._bag.length = 0; // 内容变了，缓存失效
    return this;
  }

  /** 移除元素 */
  remove(value: T): boolean {
    const i = this._entries.findIndex((e) => e.value === value);
    if (i < 0) return false;
    this._entries.splice(i, 1);
    this._bag.length = 0;
    return true;
  }

  clear(): void {
    this._entries.length = 0;
    this._bag.length = 0;
    this._lastDrawn = undefined;
  }

  /** 理论上的总格子数 */
  get capacity(): number {
    return this._entries.reduce((s, e) => s + e.count, 0);
  }

  /** 当前袋子剩余（0 表示下次 draw 会重洗） */
  get remaining(): number {
    return this._bag.length;
  }

  /**
   * 抽一个
   *
   * 【坑】袋子空了会自动重洗。如果你需要「明确的轮次」语义
   * （比如"这一轮刷怪池"），不要靠 remaining 判断，
   * 而应该在新轮次开始时显式调用 `reshuffle()`。
   */
  draw(rng: IRandomSource): T | undefined {
    if (this._bag.length === 0) this._refill(rng);
    if (this._bag.length === 0) return undefined;

    const value = this._bag.pop()!;
    this._lastDrawn = value;
    return value;
  }

  /** 抽多个（不重洗则受剩余数量限制） */
  drawMany(n: number, rng: IRandomSource): T[] {
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      const v = this.draw(rng);
      if (v === undefined) break;
      out.push(v);
    }
    return out;
  }

  /** 手动重洗（新轮次开始时用） */
  reshuffle(rng: IRandomSource): void {
    this._bag.length = 0;
    this._refill(rng);
  }

  private _refill(rng: IRandomSource): void {
    for (const e of this._entries) {
      for (let i = 0; i < e.count; i++) this._bag.push(e.value);
    }

    if (this._bag.length === 0) return;

    // Fisher–Yates 洗牌
    for (let i = this._bag.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = this._bag[i];
      this._bag[i] = this._bag[j];
      this._bag[j] = tmp;
    }

    /**
     * 避免交界重复：如果新的"下一个"（数组末尾）等于上一轮最后一个，
     * 就把它和随机一个位置交换。
     *
     * 【坑】只有一种元素时无法避免（交换了也一样），
     * 所以必须先检查 length > 1，否则会死循环或无效操作。
     */
    if (this._avoidEdgeRepeat && this._bag.length > 1 && this._lastDrawn !== undefined) {
      if (this._bag[this._bag.length - 1] === this._lastDrawn) {
        const j = Math.floor(rng.next() * (this._bag.length - 1));
        const tmp = this._bag[this._bag.length - 1];
        this._bag[this._bag.length - 1] = this._bag[j];
        this._bag[j] = tmp;
      }
    }
  }

  /** 上次抽到的元素（调试用） */
  get lastDrawn(): T | undefined {
    return this._lastDrawn;
  }

  destroy(): void {
    this.clear();
  }
}
