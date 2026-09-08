/**
 * affix/AffixSystem.ts —— 词条系统（随机属性）
 *
 * 【它解决什么】
 *
 * 装备上的随机属性：
 * ```
 * 锈蚀长剑
 *   +15 攻击力
 *   +8% 暴击率
 *   击中时 20% 概率流血
 * ```
 *
 * 词条是 ARPG / 肉鸽构筑深度的核心来源——
 * 同一把剑，roll 出不同词条就是完全不同的 build。
 *
 * 本模块负责：
 * - **Roll**：按稀有度权重抽词条，在范围内随机数值
 * - **冲突控制**：同一件装备不能出现两个"暴击率"
 * - **槽位限制**："攻击力"只能出现在武器上
 * - **聚合**：一组词条 → 属性修正表
 * - **配置校验**：开发期就发现"稀有词条反而更弱"这类错误
 *
 * 【零业务依赖】
 *
 * 它不认识"攻击力""暴击率"。
 * `stat` 是开放字符串，`slots` 也是开放字符串。
 * 具体含义由业务解释。
 */

import { IRandomSource, MathRandomSource } from '../_core/types';
import { clampNum, numOr } from '../_core/math';

// ============================================================
// 数据结构
// ============================================================

export type AffixOp = 'add' | 'mul';

/** 稀有度定义 */
export interface RarityDef {
  readonly id: string;
  /**
   * 抽取权重
   *
   * 【典型配置】
   * ```
   * common    100
   * rare       30
   * epic        8
   * legendary   2
   * ```
   */
  readonly weight: number;
  /**
   * 数值倍率
   *
   * 【用途】高稀有度滚出更高的值。
   * 即使同一个词条定义（min=5, max=10），
   * legendary 版本会乘 1.5 → 7.5 ~ 15。
   *
   * 这样不需要为每个稀有度重复配一遍词条表。
   */
  readonly valueScale?: number;
  /** UI 排序用（越大越稀有） */
  readonly tier?: number;
}

/** 词条定义 */
export interface AffixDef {
  readonly id: string;
  /** 作用属性（开放字符串） */
  readonly stat: string;
  readonly op: AffixOp;
  /** 数值下限 */
  readonly min: number;
  /** 数值上限 */
  readonly max: number;
  /** 稀有度 id */
  readonly rarity: string;
  /**
   * 池内权重（默认 1）
   *
   * 【和稀有度权重的区别】
   * 稀有度权重决定"抽到什么品质"，
   * 池内权重决定"同品质里抽到哪一条"。
   */
  readonly weight?: number;
  /**
   * 冲突组
   *
   * 【为什么需要】
   * 没有冲突组，一件装备可能 roll 出
   * "+8% 暴击率" 和 "+12% 暴击率"，
   * 玩家会觉得"这是在占词条位"——
   * 明明有 4 个词条位，实际只有 3 条有效属性。
   *
   * 同组词条在一件装备里最多出现一个。
   */
  readonly group?: string;
  /**
   * 可出现的槽位（不填 = 不限）
   *
   * 例：`slots: ['weapon', 'ring']`
   */
  readonly slots?: readonly string[];
  /**
   * 小数位（默认 0 = 整数）
   *
   * 【坑】百分比类词条（暴击率、吸血）需要 1~2 位小数。
   * 取整的话 "+8% 暴击率" 和 "+12%" 之间只有 5 个可能值，
   * 构筑深度直接消失。
   */
  readonly precision?: number;
  /** 是否为百分比（仅影响展示，不影响计算） */
  readonly percent?: boolean;
  /** 业务数据（原样透传） */
  readonly data?: unknown;
}

/** roll 出来的词条实例 */
export interface Affix {
  readonly defId: string;
  readonly stat: string;
  readonly op: AffixOp;
  /** 实际数值 */
  readonly value: number;
  readonly rarity: string;
  readonly percent: boolean;
  readonly data?: unknown;
}

/** 聚合结果 */
export interface AffixSum {
  add: number;
  mul: number;
}

// ============================================================
// 默认稀有度
// ============================================================

export const DefaultRarities: readonly RarityDef[] = [
  { id: 'common', weight: 100, valueScale: 1.0, tier: 0 },
  { id: 'rare', weight: 30, valueScale: 1.25, tier: 1 },
  { id: 'epic', weight: 8, valueScale: 1.5, tier: 2 },
  { id: 'legendary', weight: 2, valueScale: 1.8, tier: 3 },
];

// ============================================================
// 配置
// ============================================================

export interface AffixSystemOptions {
  readonly defs: readonly AffixDef[];
  readonly rarities?: readonly RarityDef[];
  readonly rng?: IRandomSource;
  /**
   * 一件装备最多几条词条。默认 4
   *
   * 【怎么定】
   * 2 条：装备差异小，凑 build 靠数量
   * 4 条（推荐）：每件都有辨识度，又不至于太复杂
   * 6+ 条：玩家会看不过来，且稀释了单条的重要性
   */
  readonly maxAffixes?: number;
  /**
   * 是否允许同一件装备出现相同 id 的词条。默认 false
   *
   * 【默认禁止的理由】
   * 两条"+10 攻击力"和一条"+20 攻击力"在数值上等价，
   * 但前者看起来像 bug，而且多占了一个词条位。
   */
  readonly allowDuplicate?: boolean;
  /**
   * 池子抽干时是否允许降级（选更低稀有度的）。默认 true
   *
   * 【为什么默认开】
   * 某些小槽位可能只有 2 个 legendary 词条。
   * 关掉的话 roll 不出来，玩家拿到空装备。
   */
  readonly fallbackOnEmpty?: boolean;
}

// ============================================================
// 实现
// ============================================================


export class AffixSystem {
  private readonly _defs = new Map<string, AffixDef>();
  private readonly _rarities: readonly RarityDef[];
  private readonly _rarityMap = new Map<string, RarityDef>();
  private readonly _rng: IRandomSource;
  private readonly _maxAffixes: number;
  private readonly _allowDuplicate: boolean;
  private readonly _fallback: boolean;

  /**
   * 上一次 rerollAll 是否导致品质下降
   *
   * 【用途】UI 提示"品质下降，是否保留？"
   * 玩家需要在"接受更好的"和"保留旧的"之间选择，
   * 这个选择本身就是重铸玩法的乐趣。
   */
  lastRerollDegraded = false;

  constructor(opts: AffixSystemOptions) {
    this._rarities = opts.rarities ?? DefaultRarities;
    this._rng = opts.rng ?? MathRandomSource;
    this._maxAffixes = clampNum(opts.maxAffixes, 1, 1e4, 4);
    this._allowDuplicate = opts.allowDuplicate ?? false;
    this._fallback = opts.fallbackOnEmpty ?? true;

    for (const r of this._rarities) {
      /**
       * 【⚠️ NaN 权重穿透了 `< 0` 判断】
       *
       * 原写法 `if (r.weight < 0) throw`：NaN < 0 恒为 false，
       * 于是 NaN 权重一路带进 `_pickRarity`，`total` 变成 NaN：
       *
       *   实测（修复前）：common=100 / epic=NaN 时，
       *   `_pickRarity` 200 次**全部返回最后一个稀有度**（epic），
       *   一次 common 都没出过——权重表静默失效，且不报错。
       *
       * 否定式判断天然漏掉 NaN（模式 A），改成肯定式 `!(x >= 0)`。
       */
      if (!(r.weight >= 0)) {
        throw new Error(`[Affix] 稀有度权重非法（负数或 NaN）：${r.id} = ${r.weight}`);
      }
      this._rarityMap.set(r.id, r);
    }

    for (const d of opts.defs) {
      if (this._defs.has(d.id)) {
        throw new Error(`[Affix] 词条 id 重复：${d.id}`);
      }
      // 【模式 A】`d.min > d.max` 同样拦不住 NaN：NaN > NaN 恒为 false。
      // 不拦的话 NaN 会一路走进 `_instantiate`，roll 出 value = NaN 的词条，
      // 再经 aggregate → compute 把整条属性算成 NaN，且不报错。
      if (!Number.isFinite(d.min) || !Number.isFinite(d.max)) {
        throw new Error(`[Affix] 词条 ${d.id} 的数值范围不是有限数字：min=${d.min} max=${d.max}`);
      }
      if (d.min > d.max) {
        throw new Error(`[Affix] 词条 ${d.id} 的数值范围反了：min(${d.min}) > max(${d.max})`);
      }
      if (!this._rarityMap.has(d.rarity)) {
        throw new Error(
          `[Affix] 词条 ${d.id} 引用了未定义的稀有度：${d.rarity}` +
          `（已定义：${[...this._rarityMap.keys()].join(', ')}）`
        );
      }
      this._defs.set(d.id, d);
    }
  }

  get defCount(): number {
    return this._defs.size;
  }

  get maxAffixes(): number {
    return this._maxAffixes;
  }

  // ---- Roll ----

  /**
   * 给一件装备 roll 词条
   *
   * @param slot 槽位（用于过滤 `slots` 限制）
   * @param count 要几条（超过 maxAffixes 会被 clamp）
   * @param opts 额外约束
   */
  roll(slot?: string, count?: number, opts?: RollOptions): Affix[] {
    const want = Math.min(count ?? this._maxAffixes, this._maxAffixes);
    const out: Affix[] = [];
    const usedDefs = new Set<string>();
    const usedGroups = new Set<string>();

    let guard = 0;
    const maxTries = want * 20;

    while (out.length < want && guard++ < maxTries) {
      // ① 摇稀有度
      const rarity = this._pickRarity();
      // ② 在该稀有度 + 该槽位的可选池里摇一条
      const def = this._pickDef(rarity, slot, usedDefs, usedGroups, opts);
      if (!def) {
        // 池子空了：降级为"不限稀有度"再试一次
        if (!this._fallback) break;
        const any = this._pickDef(undefined, slot, usedDefs, usedGroups, opts);
        if (!any) break;      // 真的没有了，停（宁可少一条也不死循环）
        this._record(any, usedDefs, usedGroups);
        out.push(this._instantiate(any));
        continue;
      }
      this._record(def, usedDefs, usedGroups);
      out.push(this._instantiate(def));
    }

    return out;
  }

  /**
   * 重铸（洗练）单条词条
   *
   * 【设计要点】
   * 重铸要保持稀有度**不降低**（否则玩家会觉得被惩罚），
   * 或者明说可以降低（"赌一把"）。
   *
   * 这里提供 `keepRarity` 选项，默认 true。
   */
  reroll(affix: Affix, slot?: string, opts?: RerollOptions): Affix | null {
    const def = this._defs.get(affix.defId);
    if (!def) return null;

    if (opts?.keepRarity ?? true) {
      // 保持稀有度，重新随机数值
      return this._instantiate(def);
    }

    // 不保持稀有度：整条重摇
    const rolled = this.roll(slot, 1, { exclude: [affix.defId], ...opts });
    return rolled[0] ?? null;
  }

  /** 重铸整件装备的所有词条 */
  rerollAll(affixes: readonly Affix[], slot?: string): Affix[] {
    /**
     * 【⚠️ 曾经的 bug：degraded 只置 true，从不复位】
     *
     * 原实现只在"本次降级"的分支里 `= true`，没有 else 也没有入口复位，
     * 于是它的实际语义是"**历史是否曾经降级过**"，而不是字段与 README
     * 承诺的"**本次** reroll 是否降级"。
     *
     * 实测（修复前）：第 1 次 rerollAll 后置 true，
     * 再跑 2 次（都没降级）后**仍是 true**。
     * UI 拿它提示"这次洗练亏了，是否保留"会一直亮着，
     * 玩家会以为每次都在亏。
     *
     * 修法：入口先复位，再在降级处置 true——让它真正表示"本次"。
     */
    this.lastRerollDegraded = false;

    const prevRarity = affixes.length > 0 ? this._highestRarity(affixes) : undefined;
    const out = this.roll(slot, affixes.length);
    // 【保底：不比原来差太多】
    // 如果重铸后最高稀有度明显下降，允许玩家接受结果但至少给他提示。
    if (prevRarity && out.length > 0) {
      const now = this._highestRarity(out);
      // 【不做强制纠正】
      // 重铸本来就该有风险；如果保证不变差，玩家就会无脑洗到满意为止，
      // 重铸货币也就失去了意义。这里只把信息暴露出去（见下方 degraded 返回值）。
      if (now !== undefined && this._tierOf(now) < this._tierOf(prevRarity)) {
        this.lastRerollDegraded = true;
      }
    }
    return out;
  }

  // ---- 聚合 ----

  /**
   * 聚合一组词条
   *
   * ```
   * final = (base + Σadd) × (1 + Σmul)
   * ```
   *
   * 【和 AttributeSet / MetaProgression 的一致性】
   * 三处都用同一套加乘公式。
   * 如果这里用连乘、那里用相加，
   * 玩家会发现"面板显示和实际伤害对不上"——
   * 这类 bug 极难排查，因为每一处单独看都是对的。
   */
  aggregate(affixes: readonly Affix[]): Map<string, AffixSum> {
    const out = new Map<string, AffixSum>();
    for (const a of affixes) {
      let s = out.get(a.stat);
      if (!s) {
        s = { add: 0, mul: 0 };
        out.set(a.stat, s);
      }
      if (a.op === 'add') s.add += a.value;
      else s.mul += a.value;
    }
    return out;
  }

  /** 用聚合结果算最终值（不知道 base 时传 0 只看 add） */
  compute(affixes: readonly Affix[], stat: string, base: number): number {
    const s = this.aggregate(affixes).get(stat);
    if (!s) return base;
    return (base + s.add) * (1 + s.mul);
  }

  // ---- 调试 ----

  /** 人类可读的词条描述（业务可覆盖 `format`） */
  describe(affix: Affix, format?: (a: Affix) => string): string {
    if (format) return format(affix);
    const sign = affix.value >= 0 ? '+' : '';
    const num = affix.percent ? `${sign}${(affix.value * 100).toFixed(1)}%` : `${sign}${affix.value}`;
    const op = affix.op === 'add' ? '' : '×';
    return `${affix.stat} ${op}${num}  [${affix.rarity}]`;
  }

  // ---- 内部 ----

  private _pickRarity(): string {
    let total = 0;
    // 【模式 B】`total += r.weight` 遇到 NaN 会把整个 total 变成 NaN，
    // 于是 `total <= 0` 为 false（NaN 比较恒 false），不回落到第一个稀有度；
    // 下面的 `x -= NaN` 让 `x <= 0` 也恒为 false，循环走完 →
    // **永远返回最后一个稀有度**，权重表完全失效且静默。
    // 收口成"非有限/负数都按 0 处理"，与"权重 0 = 抽不到"的语义一致。
    for (const r of this._rarities) total += Math.max(0, numOr(r.weight, 0));
    if (total <= 0) return this._rarities[0]?.id ?? 'common';

    let x = this._rng.next() * total;
    for (const r of this._rarities) {
      x -= Math.max(0, numOr(r.weight, 0));
      if (x <= 0) return r.id;
    }
    return this._rarities[this._rarities.length - 1]?.id ?? 'common';
  }

  private _pickDef(
    rarity: string | undefined,
    slot: string | undefined,
    usedDefs: Set<string>,
    usedGroups: Set<string>,
    opts?: RollOptions,
  ): AffixDef | null {
    const pool: AffixDef[] = [];
    let total = 0;

    for (const d of this._defs.values()) {
      if (rarity !== undefined && d.rarity !== rarity) continue;
      if (slot !== undefined && d.slots && d.slots.length > 0 && !d.slots.includes(slot)) continue;
      if (!this._allowDuplicate && usedDefs.has(d.id)) continue;
      if (d.group && usedGroups.has(d.group)) continue;
      if (opts?.exclude?.includes(d.id)) continue;
      if (opts?.onlyStats && !opts.onlyStats.includes(d.stat)) continue;
      if (opts?.minRarity && this._tierOf(d.rarity) < this._tierOf(opts.minRarity)) continue;

      // 【模式 B】`?? 1` 只挡 null/undefined，`Math.max(0, NaN)` 仍是 NaN。
      // NaN 权重会让 total 变 NaN，走与 `_pickRarity` 完全相同的静默偏斜：
      // 池子看起来有 N 条，实际永远抽最后一条。与稀有度权重同源，一并收口。
      const w = Math.max(0, numOr(d.weight ?? 1, 0));
      if (w <= 0) continue;
      pool.push(d);
      total += w;
    }

    if (pool.length === 0 || total <= 0) return null;

    let x = this._rng.next() * total;
    for (const d of pool) {
      x -= Math.max(0, numOr(d.weight ?? 1, 0));
      if (x <= 0) return d;
    }
    return pool[pool.length - 1];
  }

  /**
   * 记录已用过的词条与冲突组
   *
   * 【⚠️ 曾经的 bug】
   * 第一版在 `roll()` 里创建了 `usedDefs` / `usedGroups`，
   * 却**从来没有往里面 add**。
   *
   * 症状（三条同时出现，且都不报错）：
   * - 同一件装备 roll 出两条 "crit2" —— `allowDuplicate: false` 形同虚设
   * - 同组的两条词条（两个暴击率）同时出现
   * - 池子"永远抽不干"，因为每次都在全池里选
   *
   * 这类 bug 靠读代码很难发现（变量声明了、也传进去了），
   * 只有断言"同组不共存"才能逼出来。
   */
  private _record(def: AffixDef, usedDefs: Set<string>, usedGroups: Set<string>): void {
    usedDefs.add(def.id);
    if (def.group) usedGroups.add(def.group);
  }

  private _instantiate(def: AffixDef): Affix {
    const rarity = this._rarityMap.get(def.rarity);
    /**
     * 【⚠️ valueScale 未校验：负数让值反向、NaN 让值变 NaN】
     *
     * 原写法 `rarity?.valueScale ?? 1`：
     * - `??` 只挡 null/undefined，NaN 照穿 → `def.min * NaN` = NaN
     *   → 实测（修复前）：min=5 max=10 的词条 roll 出 **value = NaN**
     * - 负数同样照穿：valueScale=-1 时 [5,10] 变成 [-10,-5]，
     *   **数值被整体反向**，实测 roll 出 -10
     *
     * 两种都不会报错，`aggregate` / `compute` 会安静地把 NaN 传下去。
     *
     * 收口到 **1（不放大不缩小）** 而不是 0：
     * 实测验证过夹到 0 的方案——`valueScale=-1` 会让区间整个塌成 [0, 0]，
     * 高稀有度词条变成"加 0"，比"没配 valueScale"还差，
     * 而且看不出是配错了还是本来就该这样。1 是唯一的中性值。
     */
    const rawScale = numOr(rarity?.valueScale, 1);
    const scale = rawScale >= 0 ? rawScale : 1;

    const p = Math.max(0, numOr(def.precision, 0));
    const f = Math.pow(10, p);

    /**
     * 【⚠️ 曾经的 bug：四舍五入让值超出上界】
     *
     * min=0.05, max=0.15, rarity=rare(valueScale=1.25), precision=2
     * → 原始范围 [0.0625, 0.1875]
     * → 最大可能值 0.1875，四舍五入到 2 位小数 = 0.19
     * → **0.19 > 0.1875，超出上界**
     *
     * 单看这条几乎无害（多了 0.0025），
     * 但它让"数值范围"这条契约失效——
     * 平衡计算、配置校验、UI 显示"最大值"全部会对不上。
     *
     * 【解法】先把边界按同一精度**向内**对齐，再随机：
     * - lo 向上取整（只会变大）
     * - hi 向下取整（只会变小）
     * 这样 [lo, hi] ⊆ [min·scale, max·scale]，
     * 且 lo/hi 本身已满足精度，随机值取整后不会越界。
     */
    const rawLo = def.min * scale;
    const rawHi = def.max * scale;
    let lo = Math.ceil(rawLo * f) / f;
    let hi = Math.floor(rawHi * f) / f;

    /**
     * 【⚠️ 区间窄于一个精度单位时，"取整"和"落在区间内"不可兼得】
     *
     * 实测（修复前）：
     *   min=1.2 max=1.4 precision=0 → lo=ceil(1.2)=2、hi=floor(1.4)=1
     *     → `hi <= lo` 取 v=lo=2 → 量化后 2 → 再被 `v > hi` 收口成 **1**
     *     → 1 不在 [1.2, 1.4] 内，配的"1.2~1.4 暴击倍率"实际 roll 出 1.0
     *   min=0.05 max=0.07 precision=1 → 同理得到 **0**，不在 [0.05, 0.07] 内
     *
     * 两个边界都被"向内对齐"各推了一次，越推越远，最后落在一个
     * **既不是 lo 也不是 hi、更不在配置区间里**的值上，且不报错。
     * 策划配的数值范围是平衡性分析的依据，精度只是取整偏好，
     * 所以这里**保范围、弃精度**：退回未取整的 [rawLo, rawHi] 且不再量化。
     *
     * 配置期就能发现这条路：`validateAffixPool` 会为这种情况出一条 warning。
     */
    let quantized = true;
    if (hi < lo) {
      lo = rawLo;
      hi = rawHi;
      quantized = false;
    }

    let v: number;
    if (hi > lo) {
      v = lo + this._rng.next() * (hi - lo);
    } else {
      // 区间被压成一个点（min === max，或上面退化后的单点）：取边界
      v = lo;
    }

    if (quantized) v = Math.round(v * f) / f;

    // 双保险：浮点误差兜底
    if (v < lo) v = lo;
    if (v > hi) v = hi;

    return {
      defId: def.id,
      stat: def.stat,
      op: def.op,
      value: v,
      rarity: def.rarity,
      percent: def.percent ?? false,
      ...(def.data !== undefined ? { data: def.data } : {}),
    };
  }

  private _tierOf(rarityId: string): number {
    return this._rarityMap.get(rarityId)?.tier ?? 0;
  }

  private _highestRarity(affixes: readonly Affix[]): string | undefined {
    let best: string | undefined;
    let bestTier = -1;
    for (const a of affixes) {
      const t = this._tierOf(a.rarity);
      if (t > bestTier) {
        bestTier = t;
        best = a.rarity;
      }
    }
    return best;
  }
}

export interface RollOptions {
  /** 排除某些词条 id */
  readonly exclude?: readonly string[];
  /** 只要这些属性的词条 */
  readonly onlyStats?: readonly string[];
  /** 最低稀有度（保底） */
  readonly minRarity?: string;
}

export interface RerollOptions extends RollOptions {
  /** 保持原稀有度？默认 true */
  readonly keepRarity?: boolean;
}

// ============================================================
// 配置校验
// ============================================================

export interface AffixValidation {
  ok: boolean;
  /** 错误（必须修） */
  errors: string[];
  /** 警告（可以不管，但通常说明设计有问题） */
  warnings: string[];
}

/**
 * 校验词条池配置
 *
 * 【为什么需要】
 *
 * 配置错误在游戏里表现为"玩家拿到垃圾装备但看不出为什么"，
 * 而且**不会报错**——数值只是不太好。
 *
 * 典型问题：
 * | 问题 | 表现 |
 * |---|---|
 * | 稀有词条上限 < 普通词条下限 | 玩家拿到橙装，属性不如蓝装 |
 * | 某槽位可选词条 < maxAffixes | 该槽位永远凑不满词条 |
 * | 稀有度权重全为 0 | 永远只出 common |
 * | 某冲突组只有 1 个成员 | 该组限制形同虚设（不算错，但可能是笔误） |
 *
 * **在启动时跑一次，把问题一次性报出来。**
 */
export function validateAffixPool(
  defs: readonly AffixDef[],
  rarities: readonly RarityDef[] = DefaultRarities,
  opts?: { maxAffixes?: number; slots?: readonly string[] },
): AffixValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxA = opts?.maxAffixes ?? 4;

  const rarityMap = new Map(rarities.map((r) => [r.id, r]));
  const seen = new Set<string>();

  // ① 基础检查
  for (const d of defs) {
    if (seen.has(d.id)) errors.push(`词条 id 重复：${d.id}`);
    seen.add(d.id);

    if (d.min > d.max) errors.push(`词条 ${d.id} 范围反了：${d.min} > ${d.max}`);
    if (!Number.isFinite(d.min) || !Number.isFinite(d.max)) {
      errors.push(`词条 ${d.id} 的数值范围不是有限数字：min=${d.min} max=${d.max}`);
    }
    if (!rarityMap.has(d.rarity)) errors.push(`词条 ${d.id} 的稀有度 ${d.rarity} 未定义`);
    // 【模式 A】`(d.weight ?? 1) < 0` 拦不住 NaN，而 NaN 权重与"权重 0"不同：
    // 它会让整个池子的 total 变 NaN，静默变成"永远抽最后一条"。
    if (!((d.weight ?? 1) >= 0)) errors.push(`词条 ${d.id} 的权重非法（负数或 NaN）：${d.weight}`);

    /**
     * 【区间窄于一个精度单位 → 精度与范围不可兼得】
     *
     * `min=1.2 max=1.4 precision=0` 里不存在任何整数，
     * roll 时会走 `_instantiate` 的"保范围、弃精度"分支（值不再满足精度）。
     * 这不算错（不报错），但策划通常以为自己配的是"1.2~1.4 的整数"，
     * 所以配置期必须说出来——否则只能靠玩家反馈"这词条数值不对"。
     */
    const p = Math.max(0, numOr(d.precision, 0));
    const f = Math.pow(10, p);
    const sc = (() => {
      const raw = numOr(rarityMap.get(d.rarity)?.valueScale, 1);
      return raw >= 0 ? raw : 1;
    })();
    const qLo = Math.ceil(d.min * sc * f) / f;
    const qHi = Math.floor(d.max * sc * f) / f;
    if (qHi < qLo) {
      warnings.push(
        `词条 ${d.id} 的区间 [${d.min}, ${d.max}]×${sc} 窄于一个精度单位 ${1 / f}，` +
        `roll 出的值将不满足 precision=${p}（区间内没有可表示的取值）。` +
        `建议放宽区间或减小 precision——此时以"落在区间内"优先`
      );
    }

    if (d.percent && (d.precision ?? 0) === 0) {
      warnings.push(
        `词条 ${d.id} 标记为百分比但 precision=0，` +
        `值会被取整（建议 precision: 1~2，否则可选值太少）`
      );
    }
  }

  // ② 稀有度权重
  // 【模式 B】NaN 权重会让 reduce 的结果变成 NaN，
  // 于是 `NaN <= 0` 为 false —— 权重表已经失效了，校验却说没问题。
  const totalRarityWeight = rarities.reduce((s, r) => s + Math.max(0, numOr(r.weight, 0)), 0);
  const badRarityWeight = rarities.filter((r) => !(r.weight >= 0));
  for (const r of badRarityWeight) {
    errors.push(`稀有度 ${r.id} 的权重非法（负数或 NaN）：${r.weight}`);
  }
  if (totalRarityWeight <= 0) {
    errors.push('所有稀有度的权重都是 0，将永远只能抽到默认稀有度');
  }
  // 【valueScale 未校验】负数会把整个区间反向，NaN 会让所有词条值变 NaN。
  // 不阻断启动（配表疏忽不该开不了游戏），但必须报出来。
  const badScale = rarities.filter(
    (r) => r.valueScale !== undefined && !(r.valueScale >= 0)
  );
  for (const r of badScale) {
    warnings.push(
      `稀有度 ${r.id} 的 valueScale=${r.valueScale} 非法（负数或 NaN），` +
      `roll 时按 1 处理——高稀有度不会更强`
    );
  }
  const zeroWeight = rarities.filter((r) => r.weight === 0);
  if (zeroWeight.length > 0 && zeroWeight.length < rarities.length) {
    warnings.push(`有稀有度权重为 0，永远不会被抽到：${zeroWeight.map((r) => r.id).join(', ')}`);
  }

  // ③ 稀有度价值倒挂（按 stat + op 分组比较）
  const byStat = new Map<string, AffixDef[]>();
  for (const d of defs) {
    const key = `${d.stat}|${d.op}`;
    const arr = byStat.get(key);
    if (arr) arr.push(d);
    else byStat.set(key, [d]);
  }

  for (const [key, list] of byStat) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(
      (a, b) => (rarityMap.get(a.rarity)?.tier ?? 0) - (rarityMap.get(b.rarity)?.tier ?? 0),
    );
    for (let i = 0; i < sorted.length - 1; i++) {
      const lo = sorted[i];
      const hi = sorted[i + 1];
      const loScale = rarityMap.get(lo.rarity)?.valueScale ?? 1;
      const hiScale = rarityMap.get(hi.rarity)?.valueScale ?? 1;
      if (lo.max * loScale > hi.min * hiScale) {
        warnings.push(
          `稀有度倒挂 [${key}]：${lo.rarity}(${lo.id}) 上限 ${(lo.max * loScale).toFixed(2)} ` +
          `> ${hi.rarity}(${hi.id}) 下限 ${(hi.min * hiScale).toFixed(2)}` +
          `——高稀有度可能反而更弱`
        );
      }
    }
  }

  // ④ 槽位可选数量
  const slots = opts?.slots ?? collectSlots(defs);
  for (const slot of slots) {
    let n = 0;
    for (const d of defs) {
      if (d.slots && d.slots.length > 0 && !d.slots.includes(slot)) continue;
      n++;
    }
    if (n < maxA) {
      warnings.push(
        `槽位 "${slot}" 只有 ${n} 个可用词条，少于 maxAffixes(${maxA})` +
        `——该槽位永远凑不满词条`
      );
    }
  }

  // ⑤ 冲突组
  const groups = new Map<string, number>();
  for (const d of defs) {
    if (!d.group) continue;
    groups.set(d.group, (groups.get(d.group) ?? 0) + 1);
  }
  for (const [g, n] of groups) {
    if (n === 1) warnings.push(`冲突组 "${g}" 只有 1 个成员，限制无效（可能是笔误）`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function collectSlots(defs: readonly AffixDef[]): string[] {
  const s = new Set<string>();
  for (const d of defs) for (const x of d.slots ?? []) s.add(x);
  return [...s];
}
