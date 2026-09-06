/**
 * meta/MetaProgression.ts —— 元进度（局外成长）
 *
 * 【它解决什么】
 *
 * 肉鸽的核心循环：
 * ```
 * 打一局 → 死了 → 用积累的资源解锁永久能力 → 下一局更强 → 打得更远
 * ```
 *
 * 这个"死了也在变强"的机制，就是**元进度（Meta Progression）**。
 * 它让失败不再是纯粹的挫败，而是进度的一部分——
 * 这是肉鸽能让人连打几十小时的关键。
 *
 * 典型实现（《哈迪斯》）：
 * - 局内收集"黑暗"→ 局外升级武器天赋
 * - 局内收集"宝石"→ 局外装修主城（解锁新功能）
 * - 送"蜜露"给 NPC → 解锁剧情与遗物
 *
 * 【零业务依赖】
 *
 * 它不认识"灵魂""黑暗""金币"。
 * 货币是开放的字符串 id，效果作用对象也是开放的字符串。
 * 具体"+1 最大血量"是什么意思，由业务解释。
 *
 * 【不 import 任何其他插件】
 *
 * 存档只产生**纯数据**（`snapshot()` 返回可 JSON 序列化的对象），
 * 不依赖 save 插件——这样换存档方案时这里不用改。
 */

// ============================================================
// 数据结构
// ============================================================

/** 效果运算 */
export type EffectOp = 'add' | 'mul' | 'set' | 'flag';

/**
 * 一个解锁节点提供的效果
 *
 * 【为什么 stat 是字符串】
 * 写死 `maxHp` 就会把插件绑死在某个游戏上。
 * 这里只做"记下来、聚合起来、让你查"，具体含义业务自己解释。
 */
export interface MetaEffect {
  /** 作用对象（开放字符串） */
  readonly stat: string;
  readonly op: EffectOp;
  /**
   * 每级提供的数值
   *
   * 【注意】是"每级"，不是"总共"。
   * 3 级的 +5 血量节点，总加成是 15。
   */
  readonly value: number;
}

/** 成本曲线 */
export type CostCurve = readonly number[] | ((level: number) => number);

/** 元进度节点 */
export interface MetaNode {
  readonly id: string;
  /**
   * 最大等级。默认 1
   *
   * 1 = 一次性解锁（"解锁商店"）
   * N = 可重复升级（"最大血量 +5"，可升 5 次）
   */
  readonly maxLevel?: number;
  /**
   * 成本
   *
   * - 数组：`cost[level]` = 从 level 升到 level+1 的花费
   * - 函数：动态计算
   *
   * 不传则用 `defaultCostCurve()`（100 × 1.5^level）
   */
  readonly cost?: CostCurve;
  /** 消耗哪种货币。默认 'default' */
  readonly currency?: string;
  /**
   * 前置节点 id
   *
   * 【⚠️ 会检测循环依赖】
   * A 需要 B、B 需要 A → 两个都永远解锁不了。
   * 构造时做拓扑检查，发现循环直接抛错。
   */
  readonly requires?: readonly string[];
  /** 解锁后提供的效果 */
  readonly effects?: readonly MetaEffect[];
  /** UI 分组（不影响逻辑，原样透传） */
  readonly category?: string;
  /** 业务数据（原样透传） */
  readonly data?: unknown;
}

/** 聚合后的单一效果 */
export interface AggregatedEffect {
  add: number;
  mul: number;
  /** set 的值（有则优先于 add/mul） */
  set: number | undefined;
  /** flag 是否被激活 */
  flag: boolean;
}

// ============================================================
// 配置
// ============================================================

export interface MetaProgressionOptions {
  readonly nodes: readonly MetaNode[];
  /** 货币种类。默认 ['default'] */
  readonly currencies?: readonly string[];
  /** 初始货币 */
  readonly initialCurrency?: Record<string, number>;
  /** 存档版本号（用于迁移） */
  readonly version?: number;
  onUnlock?: (node: MetaNode, level: number) => void;
  /** 操作被拒绝时（货币不足/前置未满足） */
  onReject?: (nodeId: string, reason: RejectReason) => void;
}

export type RejectReason =
  | 'unknown-node'
  | 'max-level'
  | 'missing-requirement'
  | 'insufficient-currency'
  | 'cycle';

// ============================================================
// 存档
// ============================================================

export interface MetaSnapshot {
  readonly version: number;
  /** 货币余额 */
  readonly currency: Record<string, number>;
  /** 节点等级：id → level */
  readonly levels: Record<string, number>;
}

// ============================================================
// 工具
// ============================================================

/**
 * 默认成本曲线：指数增长
 *
 * ```
 * 100, 150, 225, 337, 506, ...
 * ```
 *
 * 【为什么默认用指数】
 * 线性成本（100, 200, 300...）在后期会变得"太便宜"——
 * 玩家资源产出随熟练度增长，但成本不增长，
 * 结果是一周到头全解锁，游戏失去了长期目标。
 *
 * 指数成本让"最后几级"变得昂贵，把解锁节奏拉长到数十小时。
 *
 * 【growth 怎么调】
 * - 1.3：温和，适合 20~40 小时的游戏
 * - 1.5（默认）：标准
 * - 1.8：陡峭，适合想让终极解锁非常稀有的设计
 */
export function defaultCostCurve(base = 100, growth = 1.5): (level: number) => number {
  return (level: number) => Math.round(base * Math.pow(growth, level));
}

/** 解析某等级的成本 */
export function costAt(cost: CostCurve | undefined, level: number): number {
  if (cost === undefined) return defaultCostCurve()(level);
  if (typeof cost === 'function') return Math.max(0, cost(level));
  if (level < cost.length) return Math.max(0, cost[level]);
  // 【越界处理】等级超过数组长度 → 用最后一项继续（而不是返回 0 导致免费）
  const last = cost[cost.length - 1] ?? 0;
  return Math.max(0, last);
}

// ============================================================
// 实现
// ============================================================

export class MetaProgression {
  private readonly _nodes = new Map<string, MetaNode>();
  private readonly _order: string[] = [];
  private readonly _currencies: readonly string[];
  private readonly _version: number;
  private readonly _currency = new Map<string, number>();
  private readonly _levels = new Map<string, number>();

  onUnlock?: (node: MetaNode, level: number) => void;
  onReject?: (nodeId: string, reason: RejectReason) => void;

  constructor(opts: MetaProgressionOptions) {
    this._currencies = opts.currencies && opts.currencies.length > 0 ? [...opts.currencies] : ['default'];
    this._version = opts.version ?? 1;
    this.onUnlock = opts.onUnlock;
    this.onReject = opts.onReject;

    for (const c of this._currencies) this._currency.set(c, 0);

    for (const n of opts.nodes) {
      if (this._nodes.has(n.id)) {
        throw new Error(`[MetaProgression] 节点 id 重复：${n.id}`);
      }
      /**
       * 【⚠️ 曾经的坑：货币名对不上导致静默失败】
       *
       * 节点不写 `currency` 时用默认的 `'default'`。
       * 但如果构造时注册的是 `currencies: ['soul']`，
       * `'default'` 根本不在货币表里——
       * 而 `currency()` 对未知货币返回 0（不报错）。
       *
       * 症状：玩家攒了 320 灵魂，点一个 20 灵魂的升级，
       * 提示"货币不足"。没有任何报错，查起来极其费劲。
       *
       * 所以构造时**立即校验**，让它在启动那一刻就炸掉。
       */
      const cur = n.currency ?? this._soleCurrency();
      if (!this._currency.has(cur)) {
        throw new Error(
          `[MetaProgression] 节点 "${n.id}" 使用了未注册的货币 "${cur}"` +
          `（已注册：${this._currencies.join(', ')}）`
        );
      }
      this._nodes.set(n.id, n);
      this._order.push(n.id);
      this._levels.set(n.id, 0);
    }

    if (opts.initialCurrency) {
      for (const [k, v] of Object.entries(opts.initialCurrency)) {
        if (this._currency.has(k)) this._currency.set(k, Math.max(0, v));
      }
    }

    // 【构造时检测循环依赖】
    // 现在抛错，好过上线后玩家发现"这个永远解锁不了"。
    const cycle = this._findCycle();
    if (cycle.length > 0) {
      throw new Error(`[MetaProgression] 检测到循环依赖：${cycle.join(' → ')}`);
    }
  }

  // ---- 查询 ----

  get nodeCount(): number {
    return this._nodes.size;
  }

  allNodes(): readonly MetaNode[] {
    return this._order.map((id) => this._nodes.get(id)!);
  }

  level(nodeId: string): number {
    return this._levels.get(nodeId) ?? 0;
  }

  maxLevel(nodeId: string): number {
    return Math.max(1, this._nodes.get(nodeId)?.maxLevel ?? 1);
  }

  /** 是否已解锁（等级 > 0） */
  isUnlocked(nodeId: string): boolean {
    return this.level(nodeId) > 0;
  }

  /**
   * 查余额
   *
   * 【只注册了一种货币时，不传参也能查到它】
   * 这样业务代码不用到处写 `currency('soul')`，
   * 单货币游戏直接用 `currency()` 即可。
   */
  currency(id?: string): number {
    return this._currency.get(id ?? this._soleCurrency()) ?? 0;
  }

  /**
   * 唯一的货币名（只有一种时），否则返回 'default'
   *
   * 【为什么不把默认值直接存成 'soul'】
   * 因为货币名是外部数据，构造时才知道。
   * 用一个惰性查询，比在构造时改写所有节点配置更干净。
   */
  private _soleCurrency(): string {
    return this._currencies.length === 1 ? this._currencies[0] : 'default';
  }

  /** 下一级的成本（已满级返回 null） */
  nextCost(nodeId: string): number | null {
    const n = this._nodes.get(nodeId);
    if (!n) return null;
    const lv = this.level(nodeId);
    if (lv >= this.maxLevel(nodeId)) return null;
    return costAt(n.cost, lv);
  }

  /** 是否可解锁（不扣钱，只检查） */
  canUnlock(nodeId: string): { ok: boolean; reason?: RejectReason; cost?: number } {
    const n = this._nodes.get(nodeId);
    if (!n) return { ok: false, reason: 'unknown-node' };

    const lv = this.level(nodeId);
    if (lv >= this.maxLevel(nodeId)) return { ok: false, reason: 'max-level' };

    for (const req of n.requires ?? []) {
      // 【未知前置：跳过而不是阻塞】
      // 配置里写了 '不存在的节点' 这种笔误时，
      // 如果当成"未满足"，这个节点就永远解锁不了，
      // 而且没有任何报错——玩家只会觉得"这个升级点不动"。
      //
      // 选择"忽略"而不是"抛错"的理由：
      // 抛错会让整个游戏起不来（一个笔误毁掉一次发布）。
      // 忽略至少游戏能玩，配合启动时的一次性配置校验即可发现问题。
      if (!this._nodes.has(req)) continue;
      if (!this.isUnlocked(req)) {
        return { ok: false, reason: 'missing-requirement' };
      }
    }

    const cost = costAt(n.cost, lv);
    const cur = n.currency ?? this._soleCurrency();
    if (this.currency(cur) < cost) {
      return { ok: false, reason: 'insufficient-currency', cost };
    }
    return { ok: true, cost };
  }

  // ---- 操作 ----

  /** 增加货币（负数会被 clamp 到 0）。单货币时可省略 id */
  addCurrency(id: string | undefined, amount: number): number;
  addCurrency(amount: number): number;
  addCurrency(a: string | number | undefined, b?: number): number {
    if (typeof a === 'number' && b === undefined) return this._add(this._soleCurrency(), a);
    return this._add((a as string) ?? this._soleCurrency(), b ?? 0);
  }

  private _add(id: string, amount: number): number {
    if (!this._currency.has(id)) {
      // 【未知货币不静默丢弃】
      // 静默丢弃会导致"打了怪没给钱"这种查不出来的 bug。
      throw new Error(`[MetaProgression] 未知货币：${id}（已注册：${this._currencies.join(', ')}）`);
    }
    const v = Math.max(0, (this._currency.get(id) ?? 0) + amount);
    this._currency.set(id, v);
    return v;
  }

  /**
   * 解锁 / 升级一个节点
   *
   * @returns 新的等级；失败返回 -1
   */
  unlock(nodeId: string): number {
    const check = this.canUnlock(nodeId);
    if (!check.ok) {
      this.onReject?.(nodeId, check.reason ?? 'unknown-node');
      return -1;
    }
    const n = this._nodes.get(nodeId)!;
    const cost = check.cost ?? 0;
    const cur = n.currency ?? this._soleCurrency();

    this._currency.set(cur, this.currency(cur) - cost);
    const lv = this.level(nodeId) + 1;
    this._levels.set(nodeId, lv);
    this.onUnlock?.(n, lv);
    return lv;
  }

  /**
   * 直接设置等级（GM 指令 / 测试 / 存档恢复）
   *
   * 【不检查成本与前置】——这是有意的，
   * 测试和存档恢复需要绕过规则。
   */
  setLevel(nodeId: string, level: number): void {
    if (!this._nodes.has(nodeId)) return;
    this._levels.set(nodeId, Math.max(0, Math.min(level, this.maxLevel(nodeId))));
  }

  /**
   * 洗点：重置所有等级并退还货币
   *
   * 【退款比例为什么默认 1.0】
   * 全额退款会让玩家随意反复洗点试错——
   * 这其实是好事（鼓励实验），但会让"选择"失去分量。
   *
   * 0.7~0.8 是常见折中：允许改错，但改错有代价。
   */
  respec(refundRatio = 1): void {
    for (const id of this._order) {
      const lv = this._levels.get(id) ?? 0;
      if (lv <= 0) continue;
      const n = this._nodes.get(id)!;
      const cur = n.currency ?? this._soleCurrency();
      let refund = 0;
      for (let i = 0; i < lv; i++) refund += costAt(n.cost, i);
      this._currency.set(cur, this.currency(cur) + Math.floor(refund * refundRatio));
      this._levels.set(id, 0);
    }
  }

  /** 重置货币（不重置等级） */
  resetCurrency(): void {
    for (const c of this._currencies) this._currency.set(c, 0);
  }

  // ---- 效果聚合 ----

  /**
   * 聚合所有已解锁节点的效果
   *
   * ```
   * final = (base + Σadd) × (1 + Σmul)
   * ```
   *
   * 【为什么不返回最终数值】
   * 因为不知道 base。这里只返回"修正量"，
   * 业务拿去套自己的基础值——这正是零业务依赖的体现。
   */
  effects(): Map<string, AggregatedEffect> {
    const out = new Map<string, AggregatedEffect>();

    const ensure = (stat: string): AggregatedEffect => {
      let e = out.get(stat);
      if (!e) {
        e = { add: 0, mul: 0, set: undefined, flag: false };
        out.set(stat, e);
      }
      return e;
    };

    for (const id of this._order) {
      const lv = this._levels.get(id) ?? 0;
      if (lv <= 0) continue;
      const n = this._nodes.get(id)!;
      for (const eff of n.effects ?? []) {
        const e = ensure(eff.stat);
        switch (eff.op) {
          case 'add':
            e.add += eff.value * lv;
            break;
          case 'mul':
            e.mul += eff.value * lv;
            break;
          case 'set':
            // 【多个 set 冲突时取最大】
            // 取最后会依赖遍历顺序（不可靠），取最大是确定的。
            e.set = e.set === undefined ? eff.value * lv : Math.max(e.set, eff.value * lv);
            break;
          case 'flag':
            e.flag = true;
            break;
        }
      }
    }
    return out;
  }

  /** 查某个属性的聚合结果（没有则返回零效果） */
  effectOf(stat: string): AggregatedEffect {
    return this.effects().get(stat) ?? { add: 0, mul: 0, set: undefined, flag: false };
  }

  /**
   * 用聚合结果计算最终值
   *
   * 【顺序】set > (add, mul)
   * 有 set 时直接返回它（覆盖语义），否则走加乘公式。
   */
  compute(stat: string, base: number): number {
    const e = this.effectOf(stat);
    if (e.set !== undefined) return e.set;
    return (base + e.add) * (1 + e.mul);
  }

  /** 查一个开关型效果是否激活 */
  hasFlag(stat: string): boolean {
    return this.effectOf(stat).flag;
  }

  // ---- 存档 ----

  snapshot(): MetaSnapshot {
    const currency: Record<string, number> = {};
    for (const [k, v] of this._currency) currency[k] = v;
    const levels: Record<string, number> = {};
    for (const [k, v] of this._levels) if (v > 0) levels[k] = v;
    return { version: this._version, currency, levels };
  }

  /**
   * 从存档恢复
   *
   * 【容错设计：旧存档 ≠ 崩溃】
   *
   * 更新游戏后经常发生两件事：
   * 1. 删掉了某个节点 → 存档里还有它的 id
   * 2. 新增了节点 → 存档里没有
   *
   * 严格模式会抛错、玩家进不去游戏、差评。
   * 所以这里：
   * - 未知 id → **静默跳过**（记在 `skipped` 里供日志用）
   * - 缺失 id → 保持 0
   * - 等级超过当前 maxLevel（节点被削弱了）→ clamp
   *
   * @returns 恢复报告，供日志/调试
   */
  restore(data: MetaSnapshot | null | undefined): RestoreReport {
    const report: RestoreReport = { skipped: [], clamped: [], versionMismatch: false };
    if (!data) return report;

    if (data.version !== this._version) report.versionMismatch = true;

    // 货币
    for (const id of this._currencies) this._currency.set(id, 0);
    if (data.currency) {
      for (const [k, v] of Object.entries(data.currency)) {
        if (!this._currency.has(k)) {
          report.skipped.push(`currency:${k}`);
          continue;
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        this._currency.set(k, Math.max(0, v));
      }
    }

    // 等级
    for (const id of this._order) this._levels.set(id, 0);
    if (data.levels) {
      for (const [k, v] of Object.entries(data.levels)) {
        const node = this._nodes.get(k);
        if (!node) {
          report.skipped.push(`node:${k}`);
          continue;
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const lv = Math.max(0, Math.floor(v));
        const mx = this.maxLevel(k);
        if (lv > mx) {
          this._levels.set(k, mx);
          report.clamped.push(k);
        } else {
          this._levels.set(k, lv);
        }
      }
    }

    return report;
  }

  // ---- 内部：循环依赖检测 ----

  /** 返回第一个找到的环（节点 id 序列），无环返回 [] */
  private _findCycle(): string[] {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this._order) color.set(id, WHITE);

    const stack: string[] = [];
    let found: string[] = [];

    const dfs = (id: string): boolean => {
      color.set(id, GRAY);
      stack.push(id);
      const node = this._nodes.get(id)!;
      for (const req of node.requires ?? []) {
        if (!this._nodes.has(req)) continue;   // 未知前置：忽略（不是环）
        const c = color.get(req);
        if (c === GRAY) {
          found = [...stack.slice(stack.indexOf(req)), req];
          return true;
        }
        if (c === WHITE && dfs(req)) return true;
      }
      stack.pop();
      color.set(id, BLACK);
      return false;
    };

    for (const id of this._order) {
      if (color.get(id) === WHITE && dfs(id)) break;
    }
    return found;
  }

  /**
   * 拓扑排序（UI 展示/自动解锁用）
   *
   * 【用途】UI 按依赖顺序展示节点，玩家能看懂"先解锁这个才能解锁那个"。
   */
  topoOrder(): string[] {
    const indeg = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of this._order) {
      indeg.set(id, 0);
      dependents.set(id, []);
    }
    for (const id of this._order) {
      const node = this._nodes.get(id)!;
      for (const req of node.requires ?? []) {
        if (!this._nodes.has(req)) continue;
        indeg.set(id, (indeg.get(id) ?? 0) + 1);
        dependents.get(req)!.push(id);
      }
    }

    const queue: string[] = [];
    for (const id of this._order) if (indeg.get(id) === 0) queue.push(id);

    const out: string[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      out.push(cur);
      for (const dep of dependents.get(cur) ?? []) {
        const d = (indeg.get(dep) ?? 0) - 1;
        indeg.set(dep, d);
        if (d === 0) queue.push(dep);
      }
    }
    // 有环时 out 会短于 _order——构造时已检测过，这里不会发生
    return out;
  }

  /** 已解锁节点提供的全部效果（调试用，人类可读） */
  describe(): string[] {
    const lines: string[] = [];
    for (const id of this._order) {
      const lv = this._levels.get(id) ?? 0;
      if (lv <= 0) continue;
      const n = this._nodes.get(id)!;
      const eff = (n.effects ?? [])
        .map((e) => `${e.stat} ${e.op} ${e.value * lv}`)
        .join(', ');
      lines.push(`${id} Lv${lv}/${this.maxLevel(id)}${eff ? '  →  ' + eff : ''}`);
    }
    return lines;
  }
}

/**
 * 存档恢复报告
 *
 * 【为什么字段不是 readonly】
 * 它是**返回值**，由本类构造后交给调用方。
 * 标 readonly 会让调用方（比如想把 skipped 追加到自己的日志里）很难用。
 */
export interface RestoreReport {
  /** 存档里存在但游戏中已不存在的 id（被安全忽略） */
  skipped: string[];
  /** 等级被 clamp 的节点（存档等级超过当前上限） */
  clamped: string[];
  /** 存档版本与当前版本不一致 */
  versionMismatch: boolean;
}
