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

import { needCount, hasOwn } from '../_core/guard';
import { numOr } from '../_core/math';

/**
 * 安全读取钱包余额
 *
 * 【⚠️ 为什么不能直接 `wallet[currency] ?? 0`】
 *
 * `??` 只挡 null / undefined，**挡不住原型链**。实测：
 * ```js
 * shop.buy('potion', 1, {}, 'toString')
 * // → { ok: true }，空钱包买成了，且钱包被写入 toString: NaN
 * ```
 * 因为 `wallet['toString']` 取到的是原型上的**函数**，
 * 不是 undefined，于是 `have = function`；
 * `function < 10` 是 NaN 比较、恒为 false → **资金检查被整个绕过**。
 *
 * 这个漏洞的杀伤力在于：currency 通常来自配置表或网络包（外部输入），
 * 而写回 `wallet[currency]` 时又会把 `toString` 变成自有属性，
 * 把污染固化进存档。
 *
 * 【为什么非有限值按 0 处理，而不是抛错】
 * 原语义就是 `?? 0`（"没有这个币种 = 没有钱"）。
 * 这里只是把"没有"扩展成"没有或不可用"，保持一致；
 * 数量这类**调用方写错**的参数才走 `needCount` 抛错。
 */
function readWallet(wallet: Record<string, number>, currency: string): number {
  if (!hasOwn(wallet, currency)) return 0;
  return numOr(wallet[currency], 0);
}

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
    return this._computePrice(itemId, side, quantity).price;
  }

  /**
   * 内部算价：同时给出"定价链是否健康"
   *
   * 【为什么要多返回一个 valid】
   * `priceOf` 对外只返回数字，坏定价被收口成 0——
   * 但"收口成 0"对 UI 展示是安全的，**对交易却是灾难**（0 元购）。
   * 所以交易路径必须能区分"这东西真的免费"和"定价算坏了"。
   */
  private _computePrice(
    itemId: string,
    side: TradeSide,
    quantity: number
  ): { price: number; valid: boolean } {
    const item = this._items.get(itemId);
    if (!item) return { price: 0, valid: false };

    let p = item.basePrice;

    // 商店个性倍率
    const stock = this._stock.get(itemId);
    if (stock) p *= stock.markup;

    // 卖出折价
    if (side === 'sell') p *= item.sellRatio ?? 0.5;

    // 自定义钩子
    if (this._pricing) p = this._pricing(p, { itemId, side, quantity });

    /**
     * 【⚠️ Math.max(0, NaN) 是 NaN，不是 0】
     *
     * 老实现靠 `Math.max(0, ...)` 兜底，但 `Math.max(0, NaN) === NaN`。
     * `PricingFn` 是用户注入的扩展点（折扣、会员价、动态定价），
     * 一次除零（`basePrice * (1 - discount/100)` 里 discount 是字符串）
     * 或查表未命中（`markupTable[vipLevel]` 为 undefined）就会返回 NaN。
     *
     * 实测（修复前）：`setPricing(() => NaN)` 后
     * `buy('sword', 1, wallet)` → `{ok:true}`，钱包余额被写成 **NaN**。
     *
     * 金币变 NaN 之后所有 `have < total` 判定恒为 false，
     * 意味着**什么都能买**——等价于无限金币。
     *
     * 【为什么对外收口成 0，交易侧却要拒绝】
     * - 对外收口成 0：UI 遍历商品列表时不至于因为一件商品崩掉整个面板
     * - 交易侧拒绝：`valid === false` 表示定价链不可信，
     *   此时放行就是 0 元购（白送），比崩面板严重得多
     */
    const rounded = Math.round(p);
    if (!Number.isFinite(rounded) || rounded < 0) {
      return { price: 0, valid: false };
    }
    return { price: rounded, valid: true };
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
    /**
     * 【⚠️ quantity 必须是非负有限整数】
     *
     * 老实现没有任何数量校验，实测：
     * ```js
     * shop.buy('potion', -2, { gold: 0 })
     * // → { ok: true, total: -20 }，钱包 0 → 20，库存 5 → 7
     * ```
     * 即**空手套白狼**：买 -2 个，反而倒赚 20 金币并凭空多出 2 件库存。
     * `stock.count < quantity`（5 < -2）为假，连库存检查都被绕过了。
     *
     * Infinity 同样要拦——`total = unit * Infinity` 会让扣款变 Infinity，
     * 后续所有算术被污染。
     */
    const qty = needCount(quantity, 'quantity');

    const item = this._items.get(itemId);
    if (!item) return { ok: false, reason: 'unknown_item' };

    const stock = this._stock.get(itemId);
    if (!stock) return { ok: false, reason: 'out_of_stock', available: 0 };

    // 库存检查（-1 = 无限）
    if (stock.count >= 0 && stock.count < qty) {
      return { ok: false, reason: 'out_of_stock', available: stock.count };
    }

    const { price: unit, valid } = this._computePrice(itemId, 'buy', qty);

    /**
     * 【⚠️ 定价链不可信时拒绝交易，而不是按 0 元放行】
     * 第一版我只收口了 `priceOf`（返回 0），实测结果是
     * `buy` 返回 `{ok:true, total:0}`——**玩家 0 元拿到商品**。
     * 这比"钱包变 NaN"温和，但同样是白送，属于经济损失。
     */
    if (!valid) {
      return { ok: false, reason: 'unknown_item' };
    }

    const total = unit * qty;
    const have = readWallet(wallet, currency);

    /**
     * 【⚠️ 总价必须是有限数，且用肯定式判定 `!(have >= total)`】
     *
     * 两道防线缺一不可：
     * 1. `total` 非有限 → 直接拒绝。否则 `have - NaN = NaN`，
     *    余额被永久写成 NaN，此后所有消费判定失效（等价无限金币）。
     * 2. `have < total` 改成 `!(have >= total)`：
     *    NaN 参与 `<` 恒为 false，老写法会让"余额不足"分支永不进入。
     *    肯定式下 NaN 走拒绝分支，天然安全。
     */
    if (!Number.isFinite(total)) {
      return { ok: false, reason: 'insufficient_funds', need: total, have };
    }

    if (!(have >= total)) {
      return { ok: false, reason: 'insufficient_funds', need: total, have };
    }

    // 扣钱
    wallet[currency] = have - total;

    // 扣库存
    if (stock.count > 0) stock.count -= qty;

    this._log.push({ itemId, side: 'buy', qty, total, currency });
    return { ok: true, unitPrice: unit, total };
  }

  /**
   * 出售
   *
   * @param wallet 钱包（会**增加**钱）
   */
  sell(itemId: string, quantity: number, wallet: Record<string, number>, currency = 'gold'): TradeResult {
    const qty = needCount(quantity, 'quantity');

    const item = this._items.get(itemId);
    if (!item) return { ok: false, reason: 'unknown_item' };
    if (item.sellable === false) return { ok: false, reason: 'cannot_sell' };

    /**
     * 【⚠️ 与 buy 同理：定价链不可信时拒绝】
     * 卖出侧若按 0 放行，玩家可以用"卖 0 金币"把物品刷进商店库存
     * （`stock.count += qty` 照常执行），等价于凭空造物。
     */
    const { price: unit, valid } = this._computePrice(itemId, 'sell', qty);
    if (!valid) {
      return { ok: false, reason: 'cannot_sell' };
    }
    const total = unit * qty;

    wallet[currency] = readWallet(wallet, currency) + total;

    // 卖出的东西进库存（可以买回）
    const stock = this._stock.get(itemId);
    if (stock && stock.count >= 0) stock.count += qty;

    this._log.push({ itemId, side: 'sell', qty, total, currency });
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
