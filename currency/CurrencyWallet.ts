/**
 * currency/CurrencyWallet.ts —— 多货币钱包
 *
 * ============================================================
 * ⚠️ 本目录有两套实现，别 import 错了
 * ============================================================
 *
 * | | 本文件 `CurrencyWallet` | `Currency.ts` 的 `Wallet` |
 * |---|---|---|
 * | 主打 | **精度与上下限**（`precision` / `floor`） | **多货币原子支付**（`spendAll`） |
 * | 单货币消费 | `spend()` → `SpendResult`（**带 `need`/`have`**） | `spend()` → `boolean` |
 * | 小数精度 | ✅ `precision` | ❌ 只支持整数 |
 * | 负债（负数） | ✅ `floor` | ❌ |
 * | 多货币原子 | ❌ 仅 `exchange`（1:1） | ✅ `spendAll` / `addAll` / `canAfford(costs[])` |
 * | 测试 | ✅ 36 项 | ❌ **无** |
 *
 * ⚠️ **两个文件都导出 `CurrencyDef`，字段完全不同：**
 *
 * ```
 * 本文件:    { id, name, initial, cap, floor, precision, tracked, data }
 * Currency.ts: { id, name, max,      premium,  trackLog,  desc }
 * ```
 *
 ** 只 import 其中一个文件**，两边都引会得到同名不同类型的 `CurrencyDef`。
 *
 * ============================================================
 *
 * 【它解决什么】
 *
 * 游戏里几乎一定有金币、钻石、体力、活动代币……
 * 手写的做法是 `player.gold += 10`，配上散落各处的 `if (player.gold < cost)`。
 *
 * 三个必然出现的问题：
 *
 * 1. **货币名拼错静默失败**
 *    `add('diaomnd', 100)` —— 玩家没拿到钻石，但没人报错，
 *    排查时你只会看到"活动奖励没到账"。
 *
 * 2. **多货币混算**
 *    流水只记了数字没记货币类型，
 *    月底对账发现金币和钻石的账全混在一起。
 *
 * 3. **浮点累积误差**
 *    体力这类道具常有小数（1 小时回 5.5 点），
 *    反复加减后 `0.1 + 0.2 !== 0.3`，
 *    表现为"还差 0.0000001 点就能升级"。
 *
 * 【核心设计】
 *
 * 货币必须是**先声明后使用**的。
 * 未声明的货币在第一次访问时就抛错，而不是静默创建。
 *
 * 【零业务依赖】
 * 它不知道"钻石"是什么，只知道有一堆带上限和精度的计数器。
 */

// ==================== 类型 ====================

export interface CurrencyDef {
  readonly id: string;
  readonly name?: string;
  /** 初始数量 */
  readonly initial?: number;
  /** 上限。Infinity 表示无上限 */
  readonly cap?: number;
  /** 下限（通常 0，但"负债"设计可能需要负数） */
  readonly floor?: number;
  /**
   * 小数位数
   *
   * 【为什么需要】
   * 体力/能量这类常常带小数。
   * 不指定精度的话浮点误差会累积。
   */
  readonly precision?: number;
  /** 是否记入流水（高频变动的货币可关掉，省内存） */
  readonly tracked?: boolean;
  /** 业务数据（图标、是否付费货币等） */
  readonly data?: unknown;
}

export interface CurrencyOptions {
  readonly defs: readonly CurrencyDef[];
  readonly onChange?: (id: string, value: number, delta: number) => void;
  /**
   * 数量不足时的行为
   *
   * - `'reject'`（默认）：不做任何改动，返回失败原因
   * - `'clamp'`：扣到下限为止
   */
  readonly onShortage?: 'reject' | 'clamp';
  /** 流水上限（超出丢弃最旧的） */
  readonly ledgerLimit?: number;
}

export interface LedgerEntry {
  readonly id: string;
  readonly delta: number;
  readonly after: number;
  readonly reason?: string;
  readonly seq: number;
}

export type SpendFailureReason = 'unknown-currency' | 'insufficient' | 'invalid-amount';

export interface SpendResult {
  readonly ok: boolean;
  readonly reason?: SpendFailureReason;
  /** 失败时的缺口（还差多少） */
  readonly need?: number;
  /** 失败时当前的量 */
  readonly have?: number;
}

// ==================== 工具 ====================

/** 按精度取整（消除浮点误差） */
function quantize(v: number, precision: number): number {
  if (precision <= 0) return Math.round(v);
  const f = 10 ** precision;
  return Math.round(v * f) / f;
}

// ==================== 实现 ====================

export class CurrencyWallet {
  private readonly _defs = new Map<string, Required<CurrencyDef>>();
  private readonly _values = new Map<string, number>();
  private readonly _onChange?: (id: string, value: number, delta: number) => void;
  private readonly _onShortage: 'reject' | 'clamp';
  private readonly _ledgerLimit: number;

  private _ledger: LedgerEntry[] = [];
  private _seq = 0;

  constructor(opts: CurrencyOptions) {
    this._onChange = opts.onChange;
    this._onShortage = opts.onShortage ?? 'reject';
    this._ledgerLimit = opts.ledgerLimit ?? 200;

    for (const d of opts.defs) {
      if (this._defs.has(d.id)) {
        throw new Error(`[Currency] 货币 id 重复：${d.id}`);
      }
      const full: Required<CurrencyDef> = {
        id: d.id,
        name: d.name ?? d.id,
        initial: d.initial ?? 0,
        cap: d.cap ?? Infinity,
        floor: d.floor ?? 0,
        precision: d.precision ?? 0,
        tracked: d.tracked ?? true,
        data: d.data ?? null,
      };
      if (full.cap < full.floor) {
        throw new Error(
          `[Currency] 货币 "${d.id}" 的上限 ${full.cap} 小于下限 ${full.floor}`
        );
      }
      this._defs.set(d.id, full);
      this._values.set(d.id, quantize(full.initial, full.precision));
    }
  }

  // ==================== 查询 ====================

  has(id: string): boolean {
    return this._defs.has(id);
  }

  get ids(): string[] {
    return [...this._defs.keys()];
  }

  def(id: string): CurrencyDef | undefined {
    return this._defs.get(id);
  }

  get(id: string): number {
    this._require(id);
    return this._values.get(id)!;
  }

  /** 不抛错版本（UI 遍历用） */
  tryGet(id: string): number {
    const v = this._values.get(id);
    return v === undefined ? 0 : v;
  }

  cap(id: string): number {
    this._require(id);
    return this._defs.get(id)!.cap;
  }

  /** 是否已满（用于"体力满了别再领"） */
  isFull(id: string): boolean {
    const d = this._require(id);
    return this._values.get(id)! >= d.cap;
  }

  /** 距离上限还差多少 */
  room(id: string): number {
    const d = this._require(id);
    return Math.max(0, d.cap - this._values.get(id)!);
  }

  // ==================== 变更 ====================

  /**
   * 增加
   *
   * @returns 实际增加的数量（受上限约束，可能小于请求值）
   */
  add(id: string, amount: number, reason?: string): number {
    const d = this._require(id);
    if (!Number.isFinite(amount)) {
      throw new Error(`[Currency] add 的数量必须是有限数，收到 ${amount}`);
    }
    const cur = this._values.get(id)!;
    const target = quantize(cur + amount, d.precision);
    const next = Math.min(d.cap, Math.max(d.floor, target));
    const applied = quantize(next - cur, d.precision);

    if (applied !== 0) {
      this._values.set(id, next);
      this._record(id, applied, next, reason, d);
      this._onChange?.(id, next, applied);
    }
    return applied;
  }

  /**
   * 消费
   *
   * 【⚠️ 失败时一分钱都不扣】
   * 这是钱包最重要的契约：要么完全成功，要么完全没发生。
   */
  spend(id: string, amount: number, reason?: string): SpendResult {
    if (!this._defs.has(id)) {
      return { ok: false, reason: 'unknown-currency' };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, reason: 'invalid-amount' };
    }

    const d = this._defs.get(id)!;
    const cur = this._values.get(id)!;

    if (cur < amount) {
      if (this._onShortage === 'clamp') {
        // 扣到下限为止
        const applied = quantize(cur - d.floor, d.precision);
        if (applied > 0) {
          this._values.set(id, d.floor);
          this._record(id, -applied, d.floor, reason, d);
          this._onChange?.(id, d.floor, -applied);
        }
        return { ok: true };
      }
      return {
        ok: false,
        reason: 'insufficient',
        need: quantize(amount - cur, d.precision),
        have: cur,
      };
    }

    const next = quantize(cur - amount, d.precision);
    this._values.set(id, next);
    this._record(id, -amount, next, reason, d);
    this._onChange?.(id, next, -amount);
    return { ok: true };
  }

  /**
   * 只检查，不改变
   *
   * 【⚠️ 金额必须和 spend() 用同一套校验】
   *
   * canAfford 是给 UI 用的（决定购买按钮能不能点），spend 才真正扣钱。
   * 早期版本这里只比大小，于是：
   *
   *   amount = -50 / 0  →  `cur >= amount` 恒为 true（按钮点亮）
   *                        spend() 却返回 invalid-amount
   *
   * 玩家看到的就是「这玩意儿能点，点了没反应」。
   * 金额常来自配置表或服务器下发，一个 `"cost": null` 就能稳定复现。
   *
   * spend() 的判据是 `!Number.isFinite(amount) || amount <= 0`，这里保持一致。
   */
  canAfford(id: string, amount: number): boolean {
    if (!this._defs.has(id)) return false;
    if (!Number.isFinite(amount) || amount <= 0) return false;
    return this._values.get(id)! >= amount;
  }

  /** 直接设置（GM 指令、存档载入） */
  set(id: string, value: number, reason?: string): void {
    const d = this._require(id);
    const next = quantize(
      Math.min(d.cap, Math.max(d.floor, value)),
      d.precision
    );
    const cur = this._values.get(id)!;
    if (next !== cur) {
      this._values.set(id, next);
      this._record(id, quantize(next - cur, d.precision), next, reason, d);
      this._onChange?.(id, next, quantize(next - cur, d.precision));
    }
  }

  /**
   * 货币间兑换
   *
   * 【原子性】先扣后加，但扣失败则完全不执行。
   */
  exchange(fromId: string, toId: string, amount: number, rate: number, reason?: string): SpendResult {
    this._require(fromId);
    this._require(toId);

    /**
     * 【⚠️ 必须在扣款前预检：目标货币装不下时，钱会凭空消失】
     *
     * 老实现是"先 spend 成功，再 add"：
     * ```ts
     * const r = this.spend(fromId, amount, reason);
     * if (!r.ok) return r;
     * this.add(toId, quantize(amount * rate, precision), reason);  // 装不下就截断
     * ```
     * `add` 内部 `Math.min(d.cap, ...)` 会把超出 cap 的部分**静默截断**。
     *
     * 实测（修复前）：gold=1000、gem 上限 50，
     * `exchange('gold', 'gem', 500, 1)` → gold 变 **500**，而 gem 只到账 **50**
     * —— 450 金币蒸发，且 `exchange` 返回 `{ok: true}` 表示"成功了"。
     *
     * 这是最直接的经济事故：玩家用 500 金币买了 50 钻石，
     * 界面显示"兑换成功"，账上却少了 450。
     * 且因为是"合法路径"，流水里两条记录都正常，对账时发现不了。
     *
     * 【为什么预检而不是事后回滚】
     * 事后回滚要处理"add 部分成功后再撤销"的中间态，
     * 而这里 add 的截断量在扣款前就能算准，预检更简单也更可靠。
     *
     * 【溢出时的语义选择】
     * 拒绝整笔（返回 `insufficient`），而不是"扣掉实际能装下的那部分"——
     * 后者会静默改变玩家的兑换数量，同样属于意外扣款。
     * 调用方若要"最多能换多少"，应先自行查询目标货币余量。
     */
    const toDef = this._defs.get(toId)!;
    const rawGain = quantize(amount * rate, toDef.precision);

    if (!Number.isFinite(rawGain)) {
      return { ok: false, reason: 'invalid-amount' };
    }

    const toCur = this._values.get(toId)!;
    const room = quantize(toDef.cap - toCur, toDef.precision);
    if (rawGain > room) {
      return { ok: false, reason: 'insufficient' };
    }

    const r = this.spend(fromId, amount, reason);
    if (!r.ok) return r;
    this.add(toId, rawGain, reason);
    return { ok: true };
  }

  /** 全部重置为初始值（新一局、清档） */
  reset(): void {
    for (const d of this._defs.values()) {
      this._values.set(d.id, quantize(d.initial, d.precision));
    }
    this._ledger = [];
  }

  // ==================== 流水 ====================

  get ledger(): readonly LedgerEntry[] {
    return this._ledger;
  }

  /** 某种货币的流水 */
  ledgerOf(id: string): LedgerEntry[] {
    return this._ledger.filter((e) => e.id === id);
  }

  clearLedger(): void {
    this._ledger = [];
  }

  // ==================== 存档 ====================

  exportState(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, v] of this._values) out[id] = v;
    return out;
  }

  /**
   * 导入存档
   *
   * 【⚠️ 未知货币静默跳过】
   * 旧存档里有已删除的货币很正常，
   * 抛错会让老玩家进不去游戏。
   */
  importState(state: Readonly<Record<string, number>>): void {
    for (const [id, v] of Object.entries(state)) {
      const d = this._defs.get(id);
      if (!d) continue;
      if (!Number.isFinite(v)) continue;
      this._values.set(id, quantize(Math.min(d.cap, Math.max(d.floor, v)), d.precision));
    }
  }

  // ==================== 内部 ====================

  private _require(id: string): Required<CurrencyDef> {
    const d = this._defs.get(id);
    if (!d) {
      throw new Error(
        `[Currency] 未声明的货币："${id}"（已声明：${[...this._defs.keys()].join(', ')}）`
      );
    }
    return d;
  }

  private _record(id: string, delta: number, after: number, reason: string | undefined, d: Required<CurrencyDef>): void {
    if (!d.tracked) return;
    this._ledger.push({ id, delta, after, reason, seq: this._seq++ });
    if (this._ledger.length > this._ledgerLimit) {
      this._ledger.shift();
    }
  }
}
