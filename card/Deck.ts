/**
 * Deck —— 牌库 / 手牌 / 弃牌堆
 *
 * 【它解决什么】
 *
 * 卡牌构筑类（杀戮尖塔、月圆之夜）的核心循环：
 * ```
 * 抽牌堆 --draw--> 手牌 --play--> 弃牌堆
 *    ^                                 |
 *    +---------- 抽牌堆空时洗回 ---------+
 * ```
 * 这个循环看似简单，但细节不少：
 * - 抽牌堆空了要自动把弃牌堆洗回去
 * - 洗回去时要不要保留顺序？（"保留顺序"是某些卡的效果）
 * - 抽到手牌上限怎么办？（通常是抽不进来，或者直接烧掉）
 * - 消耗（exhaust）牌不进弃牌堆
 * - 本场战斗中临时加入的牌，战斗结束要移除
 *
 * 【设计：三个区域各自是一个数组】
 * 不做成一个大数组 + 状态标记，因为三个区域的语义和操作完全不同。
 *
 * 【使用示例】
 * ```typescript
 * const deck = new Deck<Card>({ handLimit: 10 });
 *
 * deck.setDeck(startingCards);          // 设置初始牌库
 * deck.shuffle(rng);
 *
 * deck.draw(5, rng);                    // 抽 5 张
 * deck.hand;                            // 手牌
 * deck.play(0, 'discard');              // 打出第 0 张 → 弃牌堆
 * deck.play(0, 'exhaust');              // 消耗掉（不进弃牌堆）
 *
 * deck.discardHand();                   // 回合结束弃掉所有手牌
 * deck.addToDrawPile(card, 'top');      // 放到抽牌堆顶（某些卡的效果）
 *
 * deck.piles;                           // { draw, hand, discard, exhaust }
 * ```
 *
 * 【无引擎依赖】随机源通过 IRandomSource 注入。
 */

import { IRandomSource } from '../_core/types';

export interface DeckOptions {
  /** 手牌上限（默认 10） */
  readonly handLimit?: number;
  /**
   * 抽牌堆和弃牌堆都空时怎么办
   * - 'ignore'：抽不到就算了（默认）
   * - 'error'：抛错（用于发现配置错误）
   */
  readonly onEmpty?: 'ignore' | 'error';
}

export type CardZone = 'draw' | 'hand' | 'discard' | 'exhaust';

export interface DeckSnapshot {
  readonly draw: readonly unknown[];
  readonly hand: readonly unknown[];
  readonly discard: readonly unknown[];
  readonly exhaust: readonly unknown[];
}

export class Deck<T> {
  private _draw: T[] = [];
  private _hand: T[] = [];
  private _discard: T[] = [];
  private _exhaust: T[] = [];

  /** 本次战斗/本局的初始牌库（用于重置与统计） */
  private _master: readonly T[] = [];

  private readonly _handLimit: number;
  private readonly _onEmpty: 'ignore' | 'error';

  private _onChange: (() => void) | null = null;

  constructor(opts: DeckOptions = {}) {
    this._handLimit = opts.handLimit ?? 10;
    this._onEmpty = opts.onEmpty ?? 'ignore';
  }

  get handLimit(): number {
    return this._handLimit;
  }

  get drawPile(): readonly T[] {
    return this._draw;
  }

  get hand(): readonly T[] {
    return this._hand;
  }

  get discardPile(): readonly T[] {
    return this._discard;
  }

  get exhaustPile(): readonly T[] {
    return this._exhaust;
  }

  /** 抽牌堆**顶部**（下一张要抽的）。数组末尾是顶部 */
  get top(): T | undefined {
    return this._draw[this._draw.length - 1];
  }

  get totalCards(): number {
    return this._draw.length + this._hand.length + this._discard.length + this._exhaust.length;
  }

  /** 手牌是否已满 */
  get isHandFull(): boolean {
    return this._hand.length >= this._handLimit;
  }

  // ==================== 初始化 ====================

  /**
   * 设置牌库（会清空所有区域）
   *
   * @param cards 牌
   * @param saveMaster 是否记录为主牌库（用于 reset）
   */
  setDeck(cards: readonly T[], saveMaster = true): void {
    this._draw = cards.slice();
    this._hand = [];
    this._discard = [];
    this._exhaust = [];
    if (saveMaster) this._master = cards.slice();
    this._notify();
  }

  /** 重置回主牌库（不洗牌） */
  reset(): void {
    this.setDeck(this._master, true);
  }

  /** 洗抽牌堆（Fisher–Yates） */
  shuffle(rng: IRandomSource): void {
    for (let i = this._draw.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = this._draw[i];
      this._draw[i] = this._draw[j];
      this._draw[j] = t;
    }
    this._notify();
  }

  // ==================== 抽牌 ====================

  /**
   * 抽 n 张
   *
   * @returns 实际抽到的牌（可能少于 n）
   *
   * 【手牌满的处理】抽不进手牌的牌**留在抽牌堆**，
   * 而不是被丢弃——丢弃的话玩家会觉得"我的牌莫名其妙少了"。
   */
  draw(n: number, rng: IRandomSource): T[] {
    const drawn: T[] = [];

    for (let i = 0; i < n; i++) {
      if (this.isHandFull) break;

      // 抽牌堆空 → 弃牌堆洗回
      if (this._draw.length === 0) {
        if (this._discard.length === 0) {
          if (this._onEmpty === 'error') {
            throw new Error('[Deck] 抽牌堆和弃牌堆都空了');
          }
          break;
        }
        this._reshuffle(rng);
      }

      const card = this._draw.pop();
      if (card === undefined) break;
      this._hand.push(card);
      drawn.push(card);
    }

    if (drawn.length > 0) this._notify();
    return drawn;
  }

  /** 抽一张 */
  drawOne(rng: IRandomSource): T | undefined {
    return this.draw(1, rng)[0];
  }

  /**
   * 把弃牌堆洗回抽牌堆
   *
   * 【为什么公开】
   * 有些卡的效果是"立即洗牌"，或者你想在游戏逻辑里控制洗牌时机
   * （比如"每回合结束自动洗"而不是"抽不到才洗"）。
   */
  reshuffle(rng: IRandomSource): void {
    this._reshuffle(rng);
    this._notify();
  }

  private _reshuffle(rng: IRandomSource): void {
    this._draw = this._discard.slice();
    this._discard = [];
    for (let i = this._draw.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = this._draw[i];
      this._draw[i] = this._draw[j];
      this._draw[j] = t;
    }
  }

  // ==================== 打出 ====================

  /**
   * 打出第 index 张手牌
   *
   * @param to 打出去后去哪：'discard'（默认）/ 'exhaust' / 'drawTop' / 'drawBottom'
   * @returns 打出的牌
   */
  play(index: number, to: 'discard' | 'exhaust' | 'drawTop' | 'drawBottom' = 'discard'): T | undefined {
    if (index < 0 || index >= this._hand.length) return undefined;

    const [card] = this._hand.splice(index, 1);

    switch (to) {
      case 'discard':
        this._discard.push(card);
        break;
      case 'exhaust':
        this._exhaust.push(card);
        break;
      case 'drawTop':
        this._draw.push(card);
        break;
      case 'drawBottom':
        this._draw.unshift(card);
        break;
    }

    this._notify();
    return card;
  }

  /** 按引用打出（UI 拖拽时用这个更方便） */
  playCard(card: T, to: 'discard' | 'exhaust' | 'drawTop' | 'drawBottom' = 'discard'): boolean {
    const i = this._hand.indexOf(card);
    if (i < 0) return false;
    return this.play(i, to) !== undefined;
  }

  // ==================== 弃牌 ====================

  /** 弃一张手牌 */
  discard(index: number): T | undefined {
    return this.play(index, 'discard');
  }

  /** 弃掉全部手牌（回合结束） */
  discardHand(): T[] {
    const cards = this._hand;
    this._discard.push(...cards);
    this._hand = [];
    if (cards.length > 0) this._notify();
    return cards;
  }

  /** 随机弃 n 张（某些负面效果） */
  discardRandom(n: number, rng: IRandomSource): T[] {
    const out: T[] = [];
    for (let i = 0; i < n && this._hand.length > 0; i++) {
      const j = Math.floor(rng.next() * this._hand.length);
      const [card] = this._hand.splice(j, 1);
      this._discard.push(card);
      out.push(card);
    }
    if (out.length > 0) this._notify();
    return out;
  }

  // ==================== 加牌 ====================

  /**
   * 把一张牌加入抽牌堆
   *
   * @param where 'top'（下一张抽到）/ 'bottom' / 'random'
   *
   * 【典型用法】"把一张灼烧放到抽牌堆底"、"获得一张牌到手牌"
   */
  addToDrawPile(card: T, where: 'top' | 'bottom' | 'random' = 'top', rng?: IRandomSource): void {
    if (where === 'top') {
      this._draw.push(card);
    } else if (where === 'bottom') {
      this._draw.unshift(card);
    } else {
      const pos = rng ? Math.floor(rng.next() * (this._draw.length + 1)) : this._draw.length;
      this._draw.splice(pos, 0, card);
    }
    this._notify();
  }

  /** 加入手牌（受手牌上限限制） */
  addToHand(card: T): boolean {
    if (this.isHandFull) return false;
    this._hand.push(card);
    this._notify();
    return true;
  }

  addToDiscard(card: T): void {
    this._discard.push(card);
    this._notify();
  }

  /**
   * 从手牌移除（不进任何区域——用于"本场战斗结束时移除临时卡"）
   *
   * 【坑】临时卡（比如事件给的诅咒）必须在战斗结束时清掉，
   * 否则它们会留在主牌库里，第二次战斗又出现。
   * reset() 用的是 _master，所以天然解决了这个问题。
   */
  removeFromHand(card: T): boolean {
    const i = this._hand.indexOf(card);
    if (i < 0) return false;
    this._hand.splice(i, 1);
    this._notify();
    return true;
  }

  /** 从全局（所有区域）移除一张牌 */
  removeEverywhere(card: T): boolean {
    for (const pile of [this._draw, this._hand, this._discard, this._exhaust]) {
      const i = pile.indexOf(card);
      if (i >= 0) {
        pile.splice(i, 1);
        this._notify();
        return true;
      }
    }
    return false;
  }

  // ==================== 查询与存档 ====================

  /**
   * 从抽牌堆顶查看 n 张（不移除）
   *
   * 【用途】"查看抽牌堆顶 3 张，选一张加入手牌"
   */
  peek(n: number): T[] {
    return this._draw.slice(Math.max(0, this._draw.length - n)).reverse();
  }

  /** 搜索整个牌库（所有区域） */
  findAll(predicate: (card: T) => boolean): T[] {
    return [...this._draw, ...this._hand, ...this._discard, ...this._exhaust].filter(predicate);
  }

  /** 各区域快照（调试面板用） */
  get piles(): { draw: readonly T[]; hand: readonly T[]; discard: readonly T[]; exhaust: readonly T[] } {
    return {
      draw: this._draw,
      hand: this._hand,
      discard: this._discard,
      exhaust: this._exhaust,
    };
  }

  onChange(fn: () => void): () => void {
    this._onChange = fn;
    return () => {
      if (this._onChange === fn) this._onChange = null;
    };
  }

  destroy(): void {
    this._draw = [];
    this._hand = [];
    this._discard = [];
    this._exhaust = [];
    this._master = [];
    this._onChange = null;
  }

  private _notify(): void {
    this._onChange?.();
  }
}
