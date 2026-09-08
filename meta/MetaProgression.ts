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

import { clampNum } from '../_core/math';

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
  /** 构造期发现的"前置指向不存在的节点"（配置笔误） */
  private readonly _unknownRequires: { node: string; require: string }[] = [];

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

    /**
     * 【⚠️ 构造期收集"未知前置"，让静默跳过的笔误变得可查】
     *
     * 原实现在 `canUnlock`（以及 `_findCycle`、`topoOrder`）里对未知前置
     * 一律 `continue` 跳过。实测：
     *
     * ```
     * 节点 need 的 requires: ['不存在的节点']
     * → canUnlock('need') = {"ok":true,"cost":10}
     * → start 还没解锁，need 就能直接解锁
     * ```
     *
     * **前置条件形同虚设，玩家可以直接解锁终局节点**——
     * 这是财产类问题（跳过了设计好的成长曲线），不是显示问题。
     *
     * 【为什么这里只收集、不抛错】
     * `meta/README.md` 明确写了"未知前置（配置笔误）则忽略而不是阻塞——
     * 一个笔误不该让整个游戏起不来"，既有测试
     * `未知前置被忽略（不报错、不阻塞）` 也断言了同一行为。
     *
     * 任务书建议改成"构造期即抛"，但这与 README 的明确声明冲突、
     * 且会破坏既有回归，属于**需总审裁决**项（见 `audit/result_W8-A.md`）。
     * 在裁决前，本窗口取"不改变行为、但消除静默"的方案：
     * 行为与文档都不变，但笔误有了可查询的出口。
     *
     * 【为什么必须在所有节点注册完之后再收集】
     * `requires` 可以指向**后面才注册**的节点（A 需要 B，B 排在 A 之后）。
     * 边注册边判定会把这种完全合法的配置误报成笔误。
     */
    for (const n of opts.nodes) {
      for (const req of n.requires ?? []) {
        if (!this._nodes.has(req)) {
          this._unknownRequires.push({ node: n.id, require: req });
        }
      }
    }

    /**
     * 【为什么收集完还要立刻 warn 一次】
     *
     * 只收集、不吭声的话，笔误仍然只在"调用方主动查 `unknownRequires`"时才可见——
     * 而配置校验恰恰是**最容易忘记主动查**的地方。
     *
     * W8-B 在验收本报告时建议的折中方案是"构造期出 warning，运行期保持跳过"，
     * 本条采纳：warn 一次（汇总，不是每个笔误一条），
     * 行为仍然不变（不抛错、不影响解锁），但开发环境**一定能看见**。
     *
     * 【为什么用 console.warn 而不是 throw】
     * README 承诺"一个笔误不该让整个游戏起不来"，且有既有测试断言。
     * 抛错会同时破坏这两者，属 breaking，需总审裁决（见 `audit/result_W8-A.md` §3.1）。
     */
    if (this._unknownRequires.length > 0) {
      const detail = this._unknownRequires
        .map((u) => `${u.node} → ${u.require}`)
        .join('、');
      console.warn(
        `[MetaProgression] 检测到 ${this._unknownRequires.length} 处前置配置笔误` +
        `（${detail}）：这些前置会被当作"不存在"跳过，` +
        `对应节点可以绕过前置链直接解锁。请修正配置，或查询 unknownRequires 获取完整清单。`
      );
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
      /**
       * 【未知前置：跳过】
       *
       * ⚠️ 这是 `requires: ['拼错的节点']` 让前置条件形同虚设的那一行：
       * 实测 start 未解锁也能直接解锁 need，且没有任何报错。
       *
       * 构造期已经把这些笔误收集进 `unknownRequires`，
       * **调用方应当启动自检一次**（见该 getter 的说明）。
       * 这里保持跳过是遵守 README 的承诺——"一个笔误不该让整个游戏起不来"。
       *
       * 是否应当改为构造期抛错，见 `audit/result_W8-A.md` 的"需总审裁决"。
       */
      if (!this._nodes.has(req)) continue;
      if (!this.isUnlocked(req)) {
        return { ok: false, reason: 'missing-requirement' };
      }
    }

    const cost = costAt(n.cost, lv);
    const cur = n.currency ?? this._soleCurrency();

    /**
     * 【⚠️ 必须用肯定式判定 `!(have >= cost)`，不能写 `have < cost`】
     *
     * NaN 参与任何 `<` 比较都返回 false。
     * 若余额被污染成 NaN，`have < cost` 恒为 false →
     * "余额不足"分支永不进入 → **零成本解锁任何节点**。
     *
     * 写成 `!(have >= cost)` 后，NaN 会让 `>=` 为 false、取反为 true，
     * 于是走到拒绝分支——**NaN 天然被拒**，不需要额外判断。
     *
     * 【同样的理由】`cost` 本身若非法也走拒绝分支，
     * 而不是像 `<` 那样放行。
     */
    if (!(this.currency(cur) >= cost)) {
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

    /**
     * 【⚠️ 非有限金额必须在入口挡掉，不能只靠 Math.max(0, ...)】
     *
     * `Math.max(0, NaN)` 的结果是 **NaN** 而不是 0——
     * 于是 `addCurrency(NaN)` 会把余额整条毒化成 NaN。
     *
     * 而余额一旦是 NaN，`canUnlock` 里的 `currency < cost` 恒为 false，
     * **"余额不足"判定彻底失效 → 可以零成本解锁任何节点**。
     * 这是能白嫖整棵局外成长树的漏洞，属于财产类问题。
     *
     * 【为什么抛错而不是静默忽略】
     * 奖励计算里出现 NaN 说明上游有除零或字段缺失，
     * 静默忽略会让"玩家该拿 100 实际拿 0"，反而更难查。
     * 这里的问题严重度值得响亮失败。
     */
    if (!Number.isFinite(amount)) {
      throw new Error(
        `[MetaProgression] addCurrency 的金额必须是有限数字，收到 ${amount}`
      );
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
    /**
     * 【⚠️ level 必须在入口收口为"有限、非负、整数"】
     *
     * 原写法 `Math.max(0, Math.min(level, max))` 对 NaN 毫无防御：
     * `Math.min(NaN, mx)` → NaN，`Math.max(0, NaN)` → **NaN**。
     *
     * 于是出现一处自相矛盾的状态（实测）：
     *
     * ```
     * level('n')        = NaN
     * isUnlocked('n')   = false      ← "NaN > 0" 为 false，判定未解锁
     * effectOf('atk')   = { add: NaN }  ← 但 effects 里 `if (lv <= 0) continue`
     *                                    对 NaN 同样为 false，照样进入计算
     * compute('atk')    = NaN        ← 整条属性聚合链被污染
     * ```
     *
     * **一个"看起来没解锁"的节点在产出效果**，而且产出的是 NaN。
     * 属性聚合是整条链串起来的，一个 NaN 会让玩家最终属性变成 NaN，
     * 表现为"伤害全是 NaN""血量显示 NaN"，而排查方向完全不对——
     * 你会去查伤害公式，不会去查"有个节点被 setLevel(NaN) 过"。
     *
     * 【为什么同时要 floor】
     * 等级是整数语义（"Lv2"），1.5 级没有意义，
     * 而 `restore()` 早就用 `Math.floor` 收口了——两处口径应当一致。
     */
    const mx = this.maxLevel(nodeId);
    this._levels.set(nodeId, Math.floor(clampNum(level, 0, mx, 0)));
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
    /**
     * 【⚠️ 退款比例必须收口到 [0,1]】
     *
     * 原实现直接用 `refund * refundRatio`，负数会让"洗点"反过来扣钱：
     * 实测 200 成本的节点，`respec(-1)` 后余额从 500 变成 **300**。
     * 玩家点"重置"是想拿回资源，结果是资产被没收——这是财产类问题。
     *
     * NaN 更隐蔽：`refund * NaN` → NaN，余额整个被毒化成 NaN。
     * 而余额一旦是 NaN，`canUnlock` 里 `!(have >= cost)` 对 NaN 成立，
     * 于是**之后所有节点都解锁不了**（实测 canUnlock 返回 insufficient-currency），
     * 玩家的整棵成长树直接锁死，且没有任何报错指向这次 respec。
     *
     * 【为什么上界是 1 而不是放开】
     * 比例 > 1 意味着洗点能刷资源（反复洗点白嫖），是经济漏洞。
     * 想要"洗点有奖励"应该显式加参数，而不是靠传 2 这种隐式用法。
     *
     * 【为什么非有限值回落 1（全额）而不是 0】
     * 默认值就是 1，回落 1 与"不传参"行为一致，不会悄悄没收玩家资源。
     */
    const ratio = clampNum(refundRatio, 0, 1, 1);
    for (const id of this._order) {
      const lv = this._levels.get(id) ?? 0;
      if (lv <= 0) continue;
      const n = this._nodes.get(id)!;
      const cur = n.currency ?? this._soleCurrency();
      let refund = 0;
      for (let i = 0; i < lv; i++) refund += costAt(n.cost, i);
      this._currency.set(cur, this.currency(cur) + Math.floor(refund * ratio));
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
            /**
             * 【⚠️ set 是"覆盖"语义，不能被等级缩放】
             *
             * 原写法 `eff.value * lv`：Lv2 的 `set(50)` 得到 **100**，
             * Lv3 得到 150（实测）。而配置里写的明明是"设为 50"。
             *
             * `add` / `mul` 乘等级是对的——它们是"每级 +5"的累加语义
             * （`MetaEffect.value` 的 JSDoc 也写着"是每级，不是总共"）。
             * 但 `set` 的含义是"把这个属性定成某个值"，
             * 定成 50 就是 50，升到 3 级还是 50。
             *
             * 把它和 add/mul 混为一谈，数值曲线会和设计完全不符：
             * 一个"暴击率上限锁定为 50%"的节点，
             * 满级时给出 150% 的上限——而调用方 `compute()` 会直接返回 150。
             *
             * 这是"模式 D：set 类效果被层数/等级错误缩放"，
             * blessing / curse / meta 三个单元同源，修法一致。
             */
            e.set = e.set === undefined ? eff.value : Math.max(e.set, eff.value);
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

    /**
     * 【⚠️ 为什么不用 queue.shift()】
     * `Array#shift` 会把后面所有元素整体前移，是 O(n)；
     * 放在 while 循环里就是 O(n²)。节点数几十时无所谓，
     * 但元进度树长到几百个节点（大型肉鸽很常见）时，
     * 一次 topoOrder 就是几万次元素搬移。
     *
     * 用游标 `head` 只前进不回退：等价于出队但不动数组，整体降为 O(n)。
     * 这个方法常被 UI 每次打开界面时调用，不是一次性的。
     */
    const out: string[] = [];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++]!;
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

  /**
   * 配置笔误清单：前置指向了不存在的节点
   *
   * 【用法】启动时自检一次，非空就打错误日志：
   * ```typescript
   * for (const u of meta.unknownRequires) {
   *   logger.error(`元进度配置笔误：节点 ${u.node} 的前置 ${u.require} 不存在`);
   * }
   * ```
   *
   * 【为什么这个出口是必要的】
   * 这些节点在运行时会**被当作没有前置**，玩家可以直接解锁终局节点。
   * 没有出口的话，唯一的表现是"玩家成长速度异常快"，
   * 而没有任何日志能把原因指向那个拼错的 id。
   *
   * 注意：本类**不会**因为这个列表非空而改变任何解锁行为
   * （README 承诺未知前置不阻塞解锁）。
   */
  get unknownRequires(): readonly { readonly node: string; readonly require: string }[] {
    return this._unknownRequires;
  }

  /**
   * 释放内部状态与回调
   *
   * 【为什么要显式提供】
   * 本类持有货币表、等级表两张 Map，以及 `onUnlock` / `onReject` 两个外部回调。
   * 回调尤其危险：它们通常闭包着 UI 面板或业务对象，
   * 只要这里还挂着，那些对象就跟着本实例一起活着——
   * 切账号、回主菜单时忘掉本实例，就是一整块 UI 泄漏。
   *
   * 【为什么只清累积数据，不清节点配置】
   * 节点定义（`_nodes` / `_order`）是构造期确定的只读数据。
   * 清掉之后 destroy 过的对象调 `nodeCount` 会返回 0、
   * `maxLevel` 会退化成 1，比留着更容易掩盖 bug。
   * destroy 只清"运行时累积出来的东西"和"外部引用"。
   */
  destroy(): void {
    this._currency.clear();
    this._levels.clear();
    this.onUnlock = undefined;
    this.onReject = undefined;
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
