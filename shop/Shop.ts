/**
 * Shop —— 商店与经济
 *
 * 【它解决什么】
 *
 * 商店不只是"花钱换东西"。真做起来要处理：
 * - **价格浮动**：同一个东西在不同商店 / 不同时间价格不同
 * - **折扣**：会员、促销、砍价技能
 * - **库存**：限量商品卖完就没了
 * - **刷新**：Roguelike 里每层重刷一次货架
 * - **回购**：卖出去的东西能原价买回来吗？（通常买回要加价）
 * - **买不起的原因**：是钱不够，还是背包满了——提示不一样
 * - **经济平衡**：玩家卖打怪掉的东西能赚多少，直接决定金币是否通胀
 *
 * 【设计：价格计算是可插拔的函数】
 * 不做成"折扣字段"，因为折扣规则千奇百怪
 * （会员 9 折 + 促销 8 折 是相乘还是相加？满 100 减 20 怎么算？）。
 * 给一个 `pricing` 钩子，让业务自己决定。
 *
 * 【使用示例】
 * ```typescript
 * const shop = new Shop();
 *
 * shop.defineItem({ id: 'potion', name: '药水', basePrice: 50 });
 * shop.defineItem({ id: 'sword', name: '铁剑', basePrice: 300 });
 *
 * // 上架（带库存）
 * shop.stock('potion', 10);
 * shop.stock('sword', 1);
 *
 * // 询价
 * shop.priceOf('potion', 'buy');     // 50（买入价）
 * shop.priceOf('potion', 'sell');    // 25（卖出价，默认 50%）
 *
 * // 购买
 * const r = shop.buy('potion', 2, { gold: 200 });
 * // { ok: true, total: 100, change: { gold: 100 } }
 *
 * // 买不起
 * shop.buy('sword', 1, { gold: 10 });
 * // { ok: false, reason: 'insufficient_funds', need: 300, have: 10 }
 *
 * // 库存不足
 * shop.buy('potion', 999, { gold: 99999 });
 * // { ok: false, reason: 'out_of_stock', available: 8 }
 * ```
 *
 * 【价格钩子】
 * ```typescript
 * // 全局折扣 + 议价技能
 * shop.setPricing((base, ctx) => {
 *   let p = base;
 *   if (ctx.side === 'buy') p *= 0.9;        // 会员 9 折
 *   if (ctx.itemId === 'sword') p *= 0.8;    // 剑类促销
 *   return Math.max(1, Math.round(p));
 * });
 * ```
 *
 * 【无引擎依赖】
 */

export type TradeSide = 'buy' | 'sell';

export interface ShopItem {
  readonly id: string;
  readonly name: string;
  /** 基准价格 */
  readonly basePrice: number;
  /** 卖出价 = basePrice × sellRatio（默认 0.5） */
  readonly sellRatio?: number;
  /** 是否可出售给商店（任务物品通常禁止） */
  readonly sellable?: boolean;
  /** 分类（用于筛选和分类折扣） */
  readonly category?: string;
}

export interface PriceContext {
  readonly itemId: string;
  readonly side: TradeSide;
  /** 本次交易数量（用于批量折扣） */
  readonly quantity: number;
}

export type PricingFn = (basePrice: number, ctx: PriceContext) => number;

export interface StockEntry {
  readonly itemId: string;
  /** 剩余数量。-1 = 无限 */
  count: number;
  /** 该商品的价格倍率（商店个性化） */
  readonly markup: number;
}

export type BuyFailureReason =
  | 'unknown_item'
  | 'out_of_stock'
  | 'insufficient_funds'
  | 'cannot_sell';

export interface TradeResult {
  readonly ok: boolean;
  /** 单价（经过 pricing 计算后） */
  readonly unitPrice?: number;
  /** 总价 */
  readonly total?: number;
  /** 失败原因 */
  readonly reason?: BuyFailureReason;
  /** 还需要多少（钱不够时） */
  readonly need?: number;
  /** 当前有多少（钱不够时） */
  readonly have?: number;
  /** 还剩多少（库存不足时） */
  readonly available?: number;
}

export class Shop {
  private readonly _items = new Map<string, ShopItem>();
  private readonly _stock = new Map<string, StockEntry>();
  private _pricing: PricingFn | null = null;

  /**
   * 交易流水（用于统计与反作弊）
   *
   * 【为什么必须记 currency】
   * 第一版没记，结果 `netSpent(currency)` 拿不到货币类型，
   * 多货币游戏（金币/钻石/荣誉点）里所有流水的账会混在一起算。
   */
  private readonly _log: Array<{
    itemId: string;
    side: TradeSide;
    qty: number;
    total: number;
    currency: string;
  }> = [];

  // ==================== 商品定义 ====================

  defineItem(item: ShopItem): this {
    if (item.basePrice < 0) throw new Error(`[Shop] ${item.id}: 价格不能为负`);
    this._items.set(item.id, item);
    return this;
  }

  defineAll(items: readonly ShopItem[]): this {
    for (const i of items) this.defineItem(i);
    return this;
  }

  hasItem(id: string): boolean {
    return this._items.has(id);
  }

  getItem(id: string): ShopItem | undefined {
    return this._items.get(id);
  }

  // ==================== 定价 ====================

  /**
   * 设置价格计算钩子
   *
   * 【为什么是函数而不是字段】
   * 折扣规则千奇百怪：会员 9 折 + 促销 8 折是相乘还是相加？
   * 满 100 减 20 怎么叠加？做成字段永远覆盖不全。
   */
  setPricing(fn: PricingFn | null): void {
    this._pricing = fn;
  }

  /**
   * 计算单价
   *
   * 【顺序】basePrice → markup（商店个性化）→ sellRatio（卖出时）→ pricing 钩子 → 取整
   *
   * 【坑】取整要在最后。中途取整会让多次折扣累积出偏差。
   */
  priceOf(itemId: string, side: TradeSide, quantity = 1): number {
    const item = this._items.get(itemId);
    if (!item) return 0;

    let p = item.basePrice;

    // 商店个性倍率
    const stock = this._stock.get(itemId);
    if (stock) p *= stock.markup;

    // 卖出折价
    if (side === 'sell') p *= item.sellRatio ?? 0.5;

    // 自定义钩子
    if (this._pricing) p = this._pricing(p, { itemId, side, quantity });

    return Math.max(0, Math.round(p));
  }

  /** 批量总价（考虑批量折扣的话，pricing 里能拿到 quantity） */
  totalPriceOf(itemId: string, side: TradeSide, quantity: number): number {
    return this.priceOf(itemId, side, quantity) * quantity;
  }

  // ==================== 库存 ====================

  /**
   * 上架
   *
   * @param count -1 = 无限供应
   * @param markup 价格倍率（1 = 原价，1.2 = 贵 20%）
   */
  stock(itemId: string, count: number, markup = 1): boolean {
    if (!this._items.has(itemId)) return false;
    this._stock.set(itemId, { itemId, count, markup });
    return true;
  }

  /** 下架 */
  unstock(itemId: string): boolean {
    return this._stock.delete(itemId);
  }

  /** 剩余库存（-1 = 无限） */
  stockOf(itemId: string): number {
    return this._stock.get(itemId)?.count ?? 0;
  }

  /** 是否上架了 */
  isStocked(itemId: string): boolean {
    return this._stock.has(itemId);
  }

  /** 所有在售商品 */
  get stockedItems(): string[] {
    return Array.from(this._stock.values())
      .filter((s) => s.count !== 0)
      .map((s) => s.itemId);
  }

  /** 清空货架（换层、刷新前） */
  clearStock(): void {
    this._stock.clear();
  }

  /**
   * 随机补货（Roguelike 每层刷新货架）
   *
   * @param rng 随机源（**必须注入**，保证可复现）
   * @param pool 候选池（不填 = 全部已定义商品）
   */
  restock(
    rng: { next(): number },
    count: number,
    pool?: readonly string[],
    opts: { markupRange?: [number, number]; stockRange?: [number, number] } = {}
  ): string[] {
    const candidates = pool ?? Array.from(this._items.keys());
    if (candidates.length === 0) return [];

    const [mkMin, mkMax] = opts.markupRange ?? [1, 1];
    const [stMin, stMax] = opts.stockRange ?? [1, 1];

    const picked: string[] = [];
    const bag = candidates.slice();

    for (let i = 0; i < count && bag.length > 0; i++) {
      const idx = Math.floor(rng.next() * bag.length);
      const id = bag.splice(idx, 1)[0];

      const markup = mkMin + rng.next() * (mkMax - mkMin);
      const n = stMin + Math.floor(rng.next() * (stMax - stMin + 1));

      this.stock(id, n, markup);
      picked.push(id);
    }

    return picked;
  }

  // ==================== 交易 ====================

  /**
   * 购买
   *
   * 【为什么返回结构化结果而不是 boolean】
   * "买不起"和"没库存"对玩家的提示完全不同：
   * 前者要显示"还差 XX 金币"，后者要显示"已售罄"。
   * 返回 boolean 会逼你再查一次状态，而这两次查询之间状态可能已经变了。
   *
   * 【原子性】要么全买，要么不买。不存在"买了 3 个但只有 2 个的钱"。
   */
  buy(itemId: string, quantity: number, wallet: Record<string, number>, currency = 'gold'): TradeResult {
    const item = this._items.get(itemId);
    if (!item) return { ok: false, reason: 'unknown_item' };

    const stock = this._stock.get(itemId);
    if (!stock) return { ok: false, reason: 'out_of_stock', available: 0 };

    // 库存检查（-1 = 无限）
    if (stock.count >= 0 && stock.count < quantity) {
      return { ok: false, reason: 'out_of_stock', available: stock.count };
    }

    const unit = this.priceOf(itemId, 'buy', quantity);
    const total = unit * quantity;
    const have = wallet[currency] ?? 0;

    if (have < total) {
      return { ok: false, reason: 'insufficient_funds', need: total, have };
    }

    // 扣钱
    wallet[currency] = have - total;

    // 扣库存
    if (stock.count > 0) stock.count -= quantity;

    this._log.push({ itemId, side: 'buy', qty: quantity, total, currency });
    return { ok: true, unitPrice: unit, total };
  }

  /**
   * 出售
   *
   * @param wallet 钱包（会**增加**钱）
   */
  sell(itemId: string, quantity: number, wallet: Record<string, number>, currency = 'gold'): TradeResult {
    const item = this._items.get(itemId);
    if (!item) return { ok: false, reason: 'unknown_item' };
    if (item.sellable === false) return { ok: false, reason: 'cannot_sell' };

    const unit = this.priceOf(itemId, 'sell', quantity);
    const total = unit * quantity;

    wallet[currency] = (wallet[currency] ?? 0) + total;

    // 卖出的东西进库存（可以买回）
    const stock = this._stock.get(itemId);
    if (stock && stock.count >= 0) stock.count += quantity;

    this._log.push({ itemId, side: 'sell', qty: quantity, total, currency });
    return { ok: true, unitPrice: unit, total };
  }

  /** 预览（不算交易，用于 UI 显示价格和灰化按钮） */
  preview(itemId: string, side: TradeSide, quantity: number, wallet: Record<string, number>, currency = 'gold'): TradeResult {
    const item = this._items.get(itemId);
    if (!item) return { ok: false, reason: 'unknown_item' };

    if (side === 'buy') {
      const stock = this._stock.get(itemId);
      if (!stock) return { ok: false, reason: 'out_of_stock', available: 0 };
      if (stock.count >= 0 && stock.count < quantity) {
        return { ok: false, reason: 'out_of_stock', available: stock.count };
      }
    } else if (item.sellable === false) {
      return { ok: false, reason: 'cannot_sell' };
    }

    const unit = this.priceOf(itemId, side, quantity);
    const total = unit * quantity;

    if (side === 'buy') {
      const have = wallet[currency] ?? 0;
      if (have < total) return { ok: false, reason: 'insufficient_funds', need: total, have };
    }

    return { ok: true, unitPrice: unit, total };
  }

  /** 能否买得起（UI 灰化） */
  canAfford(itemId: string, quantity: number, wallet: Record<string, number>, currency = 'gold'): boolean {
    return this.preview(itemId, 'buy', quantity, wallet, currency).ok;
  }

  // ==================== 统计 ====================

  get log(): ReadonlyArray<{
    itemId: string;
    side: TradeSide;
    qty: number;
    total: number;
    currency: string;
  }> {
    return this._log;
  }

  /**
   * 某货币的净支出（正 = 玩家净花钱，负 = 净赚钱）
   *
   * 【坑】必须按 currency 过滤。
   * 不过滤的话，花钻石买的东西会被算进金币账里。
   */
  netSpent(currency = 'gold'): number {
    let net = 0;
    for (const e of this._log) {
      if (e.currency !== currency) continue;
      net += e.side === 'buy' ? e.total : -e.total;
    }
    return net;
  }

  /** 某货币的流水条数（对账用） */
  countLog(currency?: string): number {
    return currency === undefined
      ? this._log.length
      : this._log.filter((e) => e.currency === currency).length;
  }

  clearLog(): void {
    this._log.length = 0;
  }

  destroy(): void {
    this._items.clear();
    this._stock.clear();
    this._log.length = 0;
    this._pricing = null;
  }
}
