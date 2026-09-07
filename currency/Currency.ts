/**
 * currency/Currency.ts —— 多货币钱包（**实现之二**）
 *
 * ============================================================
 * ⚠️ 本目录有两套钱包实现，别 import 错了
 * ============================================================
 *
 * | | 本文件 `Wallet` | `CurrencyWallet.ts` |
 * |---|---|---|
 * | 主打 | **多货币原子支付**（`spendAll` / `addAll`） | **精度与上下限**（`precision` / `floor`） |
 * | 单货币消费 | `spend()` 返回 `boolean` | `spend()` 返回 `SpendResult`（**带 need/have**） |
 * | 精度 | ❌ 只支持整数 | ✅ `precision` 小数位 |
 * | 负债 | ❌ | ✅ `floor` 可为负 |
 * | 多货币原子 | ✅ `canAfford(costs[])` / `spendAll` | ❌ 只有 `exchange`（1:1） |
 * | 测试 / 文档 | ❌ **均无** | ✅ 36 项测试，README 已覆盖 |
 * | 流水 | `log` / `logOf` / `netChange` | `ledger` / `ledgerOf` |
 *
 * **选哪个**：
 * - 要"付 100 金币 + 5 钻石"这种**多货币原子支付** → 本文件
 * - 要体力带小数、或要欠款设计 → `CurrencyWallet.ts`
 *
 * ⚠️ **两个文件都导出了 `CurrencyDef`，字段完全不同：**
 *
 * ```
 * 本文件:        { id, name, max,      premium,  trackLog, desc }
 * CurrencyWallet: { id, name, initial, cap, floor, precision, tracked, data }
 * ```
 *
 * 只 import 其中一个文件就不会冲突；
 * 两边都 import 会得到同名不同类型的 `CurrencyDef`。
 *
 * ⚠️ **本实现没有测试覆盖、README 也未记录。**
 * 用之前先看上面的对比，并自行补测试。
 *
 * ============================================================
 *
 * 【它解决什么】
 *
 * 【它解决什么】
 *
 * 游戏里几乎总有不止一种货币：金币、钻石、体力、赛季代币。
 * 手写的做法是几个散落变量：
 *
 * ```typescript
 * let gold = 0;
 * let gem = 0;
 * gold -= 50;   // 忘了判断够不够 → 金币变负数
 * ```
 *
 * 加到四五种货币后，问题开始出现：
 *
 * 1. **扣成负数**：忘了 `if (gold >= cost)`，或者判断了但先扣了再判断
 * 2. **多货币支付只扣了一部分**：需要 100 金 + 5 钻，金币不够但钻石已经扣了
 * 3. **溢出静默丢失**：金币超上限，多出来的部分直接消失，玩家不知道
 * 4. **对不上账**：不知道钱是哪来的，查 bug 只能靠猜
 *
 * 【设计原则】
 *
 * 这一版最重要的三条：
 *
 * 1. **金额必须是整数**。浮点货币是灾难（0.1 + 0.2 !== 0.3），
 *    `add()` 传入小数直接抛错——早失败好过后期对不上账。
 *    要显示"12.5 元"就用最小单位（分）存，展示层再除。
 * 2. **多货币支付是原子的**。要么全扣，要么一分不动。
 * 3. **每一笔都可追溯**。可选流水记录，出问题时能回放。
 *
 * 【零依赖】本模块不认识"玩家""商店""背包"，
 * 它只知道"某种 id 的整数余额"。换任何游戏直接复制目录。
 *
 * 【使用示例】
 * ```typescript
 * const wallet = new Wallet({
 *   defs: [
 *     { id: 'gold', name: '金币', max: 999999 },
 *     { id: 'gem',  name: '钻石', max: 9999 },
 *   ],
 *   initial: { gold: 100 },
 * });
 *
 * wallet.add('gold', 50, 'quest');     // 返回实际到账数（超上限会截断）
 * wallet.spend('gold', 30, 'shop');    // true
 * wallet.spend('gold', 1e9, 'shop');   // false —— 余额不足
 * wallet.get('gold');                  // 120
 * wallet.isFull('gem');                // 是否已达上限
 * ```
 *
 * 【⚠️ add 返回实际到账数，不是 void】
 * 超过 `max` 时会被截断，调用方必须读返回值才能知道真实到账量——
 * 直接忽略会导致"发了 100 但玩家只拿到 20 且无提示"。
 */

import { clamp, clampNum } from '../_core/math';

// ==================== 类型 ====================

/** 货币种类定义 */
export interface CurrencyDef {
  readonly id: string;
  readonly name: string;
  /**
   * 上限。`null` 表示不限制。
   *
   * 【为什么需要】
   * 体力上限 120 是设计的一部分；
   * 而金币不设上限时，溢出应该被记录而不是静默丢弃。
   */
  readonly max?: number | null;
  /**
   * 是否为付费货币
   *
   * 【为什么区分】
   * 付费货币的变动口径完全不同：
   * - 只能由充值流程增加（`earn` 会拒绝）
   * - 会记录流水用于审计和对账
   * - 不允许被"清空存档"之类操作误清
   */
  readonly premium?: boolean;
  /** 是否记录流水（默认 true；高频货币可关掉省内存） */
  readonly trackLog?: boolean;
  readonly desc?: string;
}

/** 一笔流水 */
export interface CurrencyEntry {
  readonly currencyId: string;
  /** 变化量（正为收入，负为支出） */
  readonly delta: number;
  /** 变化后的余额 */
  readonly balance: number;
  readonly reason: string;
  readonly at: number;
}

/** 支付是否可行 */
export interface AffordResult {
  readonly ok: boolean;
  /** 不够的部分（ok 为 true 时是空对象） */
  readonly missing: Readonly<Record<string, number>>;
}

export interface WalletOptions {
  readonly defs: readonly CurrencyDef[];
  /** 初始余额（未指定的为 0） */
  readonly initial?: Readonly<Record<string, number>>;
  readonly now?: () => number;
  /** 流水上限（防内存增长） */
  readonly logLimit?: number;
  readonly onChange?: (id: string, delta: number, balance: number, reason: string) => void;
}

/** 一次支付里某一项 */
export interface Cost {
  readonly currencyId: string;
  readonly amount: number;
}

// ==================== 实现 ====================

const DEFAULT_LOG_LIMIT = 200;

export class Wallet {
  private readonly _defs = new Map<string, CurrencyDef>();
  private readonly _balances = new Map<string, number>();
  private readonly _log: CurrencyEntry[] = [];
  /** 净变化累加器：独立于 `_log`，不受 logLimit 裁剪影响（见 netChange 注释） */
  private readonly _net = new Map<string, number>();
  private readonly _logLimit: number;
  private readonly _now: () => number;
  private readonly _onChange?: WalletOptions['onChange'];

  constructor(opts: WalletOptions) {
    if (opts.defs.length === 0) {
      throw new Error('[Wallet] 至少需要一种货币');
    }

    for (const d of opts.defs) {
      if (this._defs.has(d.id)) {
        throw new Error(`[Wallet] 货币 id 重复：${d.id}`);
      }
      if (d.max !== undefined && d.max !== null) {
        if (!Number.isInteger(d.max) || d.max < 0) {
          throw new Error(`[Wallet] 货币 ${d.id} 的上限必须是非负整数，收到 ${d.max}`);
        }
      }
      this._defs.set(d.id, d);
      this._balances.set(d.id, 0);
    }

    for (const [id, v] of Object.entries(opts.initial ?? {})) {
      const def = this._defs.get(id);
      if (!def) {
        throw new Error(
          `[Wallet] 初始余额里有未定义的货币：${id}（已定义：${[...this._defs.keys()].join(', ')}）`
        );
      }
      this._assertAmount(v, id);
      this._balances.set(id, this._clampToMax(def, v).value);
    }

    this._now = opts.now ?? (() => Date.now());
    this._logLimit = clampNum(opts.logLimit, 0, 1e7, DEFAULT_LOG_LIMIT);
    this._onChange = opts.onChange;
  }

  // ==================== 查询 ====================

  /** 余额（未知货币抛错——拼错 id 不该静默返回 0） */
  get(id: string): number {
    this._require(id);
    return this._balances.get(id)!;
  }

  /** 不抛错版本（UI 遍历用） */
  tryGet(id: string): number {
    return this._balances.get(id) ?? 0;
  }

  has(id: string): boolean {
    return this._defs.has(id);
  }

  def(id: string): CurrencyDef | undefined {
    return this._defs.get(id);
  }

  get currencyIds(): string[] {
    return [...this._defs.keys()];
  }

  /** 剩余空间（无上限的返回 Infinity） */
  space(id: string): number {
    const def = this._require(id);
    if (def.max == null) return Infinity;
    return Math.max(0, def.max - this._balances.get(id)!);
  }

  isFull(id: string): boolean {
    return this.space(id) === 0;
  }

  // ==================== 变动 ====================

  /**
   * 收入
   *
   * @returns 实际入账数量（可能因上限而少于 amount）
   *
   * 【⚠️ 返回实际值而不是布尔】
   * 体力从 118 恢复到 130 但上限 120，实际入账 2。
   * 如果只返回 true，调用方以为加了 12，UI 会显示错误的"+12"。
   */
  add(id: string, amount: number, reason = ''): number {
    const def = this._require(id);
    this._assertAmount(amount, id);
    this._assertNotPremium(def, 'earn');

    if (amount <= 0) {
      throw new Error(`[Wallet] ${id} 的 add 数量必须为正，收到 ${amount}`);
    }

    const cur = this._balances.get(id)!;
    const { value, overflow } = this._clampToMax(def, cur + amount);
    this._balances.set(id, value);

    const actual = value - cur;
    if (actual !== 0) {
      this._record(id, actual, value, reason);
      this._onChange?.(id, actual, value, reason);
    }

    // 溢出也要可观测，否则"体力满了但还在回复"这类问题查不到
    void overflow;
    return actual;
  }

  /**
   * 支付
   *
   * 【原子性】不够就一分不扣，返回 false。
   */
  spend(id: string, amount: number, reason = ''): boolean {
    const def = this._require(id);
    this._assertAmount(amount, id);

    if (amount <= 0) {
      throw new Error(`[Wallet] ${id} 的 spend 数量必须为正，收到 ${amount}`);
    }
    if (this._balances.get(id)! < amount) return false;

    const next = this._balances.get(id)! - amount;
    this._balances.set(id, next);
    this._record(id, -amount, next, reason);
    this._onChange?.(id, -amount, next, reason);

    void def;
    return true;
  }

  /** 强制设置（GM 指令、存档读取用） */
  set(id: string, value: number, reason = 'set'): void {
    const def = this._require(id);
    this._assertAmount(value, id);

    const cur = this._balances.get(id)!;
    const { value: next } = this._clampToMax(def, value);
    if (next === cur) return;

    this._balances.set(id, next);
    this._record(id, next - cur, next, reason);
    this._onChange?.(id, next - cur, next, reason);
  }

  // ==================== 多货币 ====================

  /**
   * 能否支付这组花费
   *
   * 【返回 missing 而不只是布尔】
   * UI 要显示"还差 30 金币"，只返回 false 的话
   * 每个调用方都要自己再算一遍差额——迟早算得不一样。
   */
  canAfford(costs: readonly Cost[]): AffordResult {
    /**
     * 【⚠️ 必须先按货币聚合总需求，再比较】
     *
     * 原实现逐项比较 `have < amount`，于是
     * "80 金 + 80 金"在只有 100 金时判定为**够**——
     * 因为每项单独看都够。
     *
     * 真实需求是 160，缺 60。
     * 这类 bug 只在"同一笔支付里同一货币出现多次"时触发，
     * 而多材料合成恰恰经常这样写。
     */
    const total: Record<string, number> = {};
    for (const c of costs) {
      this._require(c.currencyId);   // 拼错 id 早失败
      /**
       * 【⚠️ 必须校验金额，否则 canAfford 与 spendAll 语义不一致】
       *
       * canAfford 是给 UI 用的（决定购买按钮能不能点），
       * spendAll 才真正扣钱。早期版本 canAfford 没做金额校验，于是：
       *
       *   NaN / -50 / 0 / 10.5  →  canAfford 返回 ok=true（按钮点亮）
       *                            spendAll 直接抛异常
       *
       * 玩家看到的就是「这玩意儿能点，点了就报错」。
       * 金额常来自配置表或服务器下发，一个 `"cost": null` 就能稳定复现。
       *
       * 校验放在这里，非法金额在 UI 层就暴露为「不可购买」。
       */
      this._assertAmount(c.amount, c.currencyId);
      /**
       * 【⚠️ 必须为正】
       *
       * `_assertAmount` 只校验「有限数」和「整数」，不管正负。
       * 而 spendAll 多了一道 `amount <= 0` 抛错——
       * 不在这里补上同样一道，canAfford 就会对负数/0 返回 ok=true，
       * spendAll 却抛异常，「能点但点了就崩」。
       *
       * 判据与 spendAll 完全一致：花销金额必须是**正整数**。
       * 配方里允许有 0 成本的可选材料的话，调用前先自己过滤掉。
       */
      if (c.amount <= 0) {
        throw new Error(
          `[Wallet] 花费金额必须为正整数：${c.currencyId} 收到 ${c.amount}`
        );
      }
      total[c.currencyId] = (total[c.currencyId] ?? 0) + c.amount;
    }

    const missing: Record<string, number> = {};
    for (const [id, need] of Object.entries(total)) {
      const have = this._balances.get(id)!;
      if (have < need) missing[id] = need - have;
    }

    return { ok: Object.keys(missing).length === 0, missing };
  }

  /**
   * 支付这组花费（原子）
   *
   * 【为什么必须原子】
   * 花 100 金 + 5 钻，金币够、钻石不够——
   * 如果先扣了金币再发现钻石不够，玩家会看到金币少了但什么都没买到。
   * 这是所有商店系统最招投诉的 bug。
   */
  spendAll(costs: readonly Cost[], reason = ''): boolean {
    // ① 先全部检查（顺带校验 id 和金额，避免改到一半才发现拼错）
    const check = this.canAfford(costs);
    if (!check.ok) return false;

    for (const c of costs) {
      if (!Number.isInteger(c.amount) || c.amount <= 0) {
        throw new Error(
          `[Wallet] 花费金额必须是正整数：${c.currencyId} 收到 ${c.amount}`
        );
      }
    }

    // ② 再全部扣减
    for (const c of costs) {
      const next = this._balances.get(c.currencyId)! - c.amount;
      this._balances.set(c.currencyId, next);
      this._record(c.currencyId, -c.amount, next, reason);
      this._onChange?.(c.currencyId, -c.amount, next, reason);
    }
    return true;
  }

  /** 收入一组（非原子：单项溢出不影响其他项） */
  addAll(gains: readonly Cost[], reason = ''): Readonly<Record<string, number>> {
    const actual: Record<string, number> = {};
    for (const g of gains) {
      actual[g.currencyId] = this.add(g.currencyId, g.amount, reason);
    }
    return actual;
  }

  /**
   * 兑换（A → B）
   *
   * 【两阶段：先做完整预检，再动账】
   *
   * 老实现是"先 spend 成功、再 add"，一旦 `add()` 抛错，
   * 源货币已经扣掉且**没有任何回滚**——钱凭空消失。
   *
   * 实测（修复前）：
   * ```js
   * before: gold=1000 gem=0
   * exchange('gold', 500, 'gem', 10)
   *   → 抛 "gem 是付费货币，不能用 add() 增加"
   * after:  gold=500  gem=0   ← 500 金币消失，钻石没到账
   * ```
   * `premium: true`（线上充值货币的标准配置）是**必现**路径，
   * 不是边缘情况。玩家每点一次兑换白扣一次，
   * 且流水只记支出、客服无法对账。
   *
   * 【为什么用"预检"而不是"异常后回滚"】
   * 本方法原本的注释写着"先扣后加，B 加不进去 A 也不退——
   * 兑换是不可逆的经济行为，静默回滚会让玩家反复点击刷取"。
   * **那个设计意图仍然保留**：上限溢出（`add` 部分到账）不回滚。
   *
   * 预检只拦截"注定失败"的情况（目标货币不允许 `add` 增加、
   * 金额非法）——这些在动账**之前**就能判定，
   * 所以既修好了"钱消失"，又没有引入回滚，两条不冲突。
   */
  exchange(
    fromId: string,
    fromAmount: number,
    toId: string,
    toAmount: number,
    reason = 'exchange'
  ): boolean {
    this._require(fromId);
    this._require(toId);
    if (fromId === toId) {
      throw new Error(`[Wallet] 不能兑换成同一种货币：${fromId}`);
    }

    /**
     * 【阶段 1 · 预检】
     * 目标货币的可加性 + 金额合法性，全部在动账前判定。
     * 任一不通过 → 抛错，源货币一分不动。
     */
    const toDef = this._require(toId);
    this._assertNotPremium(toDef, 'earn');
    this._assertAmount(toAmount, toId);

    /** 【阶段 2 · 动账】预检已通过，这里不会再因目标货币抛错 */
    if (!this.spend(fromId, fromAmount, reason)) return false;
    this.add(toId, toAmount, reason);
    return true;
  }

  // ==================== 流水 ====================

  get log(): readonly CurrencyEntry[] {
    return this._log;
  }

  /**
   * 某一种货币的流水（取最后 n 条）
   *
   * 【⚠️ 为什么 `n > 0` 而不是 `Number.isFinite(n)`】
   *
   * `-0` 与 `0` 是同一个值，而 `Array.prototype.slice(-0)` 等价于 `slice(0)`，
   * 语义是"从 0 切到末尾" = **返回整个数组**，而不是"取最后 0 条" = 空数组。
   *
   * 实测（修复前）：
   * ```js
   * logOf('gold', 0).length  → 5   （期望 0）
   * logOf('gold', 2).length  → 2   （正确）
   * ```
   *
   * 后果：`n` 由外部配置/筛选条件驱动时，行为在 0 处**突变**——
   * "刚清空筛选条件"那一帧会渲染整份流水，而不是空列表。
   * 只判 `Number.isFinite(0)` 为真，正好漏掉这个唯一会出错的输入。
   *
   * 【为什么非有限值（NaN / ±Infinity）仍返回全部】
   * 默认值就是 `Infinity`（"不限制条数"），NaN 沿用同一分支是既有行为，
   * 本次只修 0 这一处，不做额外变更。
   */
  logOf(id: string, n = Infinity): CurrencyEntry[] {
    const out = this._log.filter((e) => e.currencyId === id);
    if (!Number.isFinite(n)) return out;
    return n > 0 ? out.slice(-n) : [];
  }

  /**
   * 净变化（本局盈亏，对账用）
   *
   * 【⚠️ 为什么不再基于 `_log` 求和】
   *
   * `_log` 受 `logLimit`（默认 200）裁剪，老流水会被 `splice` 掉。
   * 于是 `netChange` 的真实语义是"**日志里还剩下的**净变化"，与字面意思不符：
   *
   * 实测（修复前），`logLimit: 5` 下连续 20 次 `add(gold, 10)`：
   * ```
   * 余额 = 200    netChange = 50     ← 差 4 倍
   * ```
   *
   * 后果比"返回错误的数"更麻烦：数字**看起来完全合理**（只是偏小），
   * UI 把它当"本局赚了多少"显示，运营按它做对账，没人会想到是日志裁剪导致的。
   * 而且 `logLimit` 一旦被调小，偏差方向系统性偏低。
   *
   * 改为独立的累加计数器后不受裁剪影响；`clearLog()` 会一并归零，
   * 保持"流水与盈亏同步清零"的直觉。
   *
   * 【保持的既有语义】`trackLog === false` 的货币不记账，净变化仍为 0。
   */
  netChange(id: string): number {
    this._require(id);
    return this._net.get(id) ?? 0;
  }

  /**
   * 清空流水
   *
   * 【为什么连净变化一起清】
   * 净变化原本就是从流水里算出来的，调用方对两者的生命周期认知是一致的。
   * 若只清流水而留着累计值，会出现"流水空了但盈亏还有数"的矛盾状态。
   */
  clearLog(): void {
    this._log.length = 0;
    this._net.clear();
  }

  // ==================== 存档 ====================

  /** 导出全部余额 */
  exportState(): Record<string, number> {
    return Object.fromEntries(this._balances);
  }

  /**
   * 导入
   *
   * 【⚠️ 未知货币跳过，缺失的补 0】
   * 存档兼容是刚需：删掉一种货币后老存档不该崩，
   * 新增一种货币后老存档也该能用。
   */
  importState(state: Readonly<Record<string, number>>): void {
    for (const id of this._defs.keys()) {
      const v = state[id];
      if (v === undefined || !Number.isFinite(v)) {
        this._balances.set(id, 0);
        continue;
      }
      const def = this._defs.get(id)!;
      this._balances.set(id, this._clampToMax(def, Math.floor(v)).value);
    }
  }

  // ==================== 内部 ====================

  private _require(id: string): CurrencyDef {
    const def = this._defs.get(id);
    if (!def) {
      throw new Error(
        `[Wallet] 未定义的货币：${id}（已定义：${[...this._defs.keys()].join(', ')}）`
      );
    }
    return def;
  }

  /**
   * 【⚠️ 金额必须是整数】
   *
   * 浮点货币是账目对不上的头号原因。
   * 0.1 + 0.2 !== 0.3，累积几百次后差额会大到肉眼可见。
   */
  private _assertAmount(v: number, id: string): void {
    if (!Number.isFinite(v)) {
      throw new Error(`[Wallet] ${id} 的金额不是有限数：${v}`);
    }
    if (!Number.isInteger(v)) {
      throw new Error(
        `[Wallet] ${id} 的金额必须是整数（用最小单位存储），收到 ${v}`
      );
    }
  }

  private _assertNotPremium(def: CurrencyDef, op: string): void {
    if (def.premium && op === 'earn') {
      throw new Error(
        `[Wallet] ${def.id} 是付费货币，不能用 add() 增加（应走充值流程）`
      );
    }
  }

  private _clampToMax(def: CurrencyDef, v: number): { value: number; overflow: number } {
    if (def.max == null) return { value: v, overflow: 0 };
    const value = clamp(Math.floor(v), 0, def.max);
    return { value, overflow: v - value };
  }

  private _record(id: string, delta: number, balance: number, reason: string): void {
    const def = this._defs.get(id)!;
    if (def.trackLog === false) return;

    // 净变化在这里累加：早于日志裁剪，因此 logLimit 调小也不会让盈亏偏低
    this._net.set(id, (this._net.get(id) ?? 0) + delta);

    this._log.push({ currencyId: id, delta, balance, reason, at: this._now() });
    if (this._log.length > this._logLimit) {
      this._log.splice(0, this._log.length - this._logLimit);
    }
  }
}
