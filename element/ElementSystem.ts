/**
 * element/ElementSystem.ts —— 元素附着与反应
 *
 * 【它解决什么】
 *
 * 火 + 水 = 蒸发（伤害翻倍）、冰 + 电 = 超导（减防）……
 * 这类"元素反应"是构筑深度的富矿——
 * 它让玩家从"堆数值"变成"想组合"。
 *
 * 朴素实现（"目标身上有个 fire 标记"）的问题是：
 * - 无法处理"附着量"——一发小火苗和一发大火球触发同样效果，不合理
 * - 无法处理"衰减"——附着永远不消失，玩家上一次火就能无限触发
 * - 无法处理"共存"——同时挂水和火，该先反应哪个？
 *
 * 本模块用**元素量（gauge）**模型：
 *
 * ```
 * 火附着 25 单位 + 水附着 50 单位
 *   → 触发"蒸发"，消耗双方元素量
 *   → 水还剩 25 单位，继续留在目标身上
 * ```
 *
 * 【零业务依赖】
 *
 * 它不认识"火""水""蒸发"。
 * 元素是开放字符串 id，反应规则是**配置表**。
 * 你可以用它做原神式元素、也可以做"毒+火=爆炸"这类自创设定。
 *
 * 【不 import 任何其他插件】
 */

import { clamp01, numOr, safeDt } from '../_core/math';

// ============================================================
// 数据结构
// ============================================================

/** 元素定义 */
export interface ElementDef {
  readonly id: string;
  /**
   * 衰减速率（单位/秒）
   *
   * 【典型值】
   * - 火：快（8~10），燃烧感
   * - 冰：慢（4~5），冻结感
   * - 雷：中等（6~8）
   *
   * 设 0 = 永不衰减（某些特殊元素）
   */
  readonly decay: number;
  /**
   * 最大附着量
   *
   * 【用途】防止玩家疯狂叠同一元素一次打出巨额反应。
   */
  readonly maxGauge?: number;
  /** UI 数据（原样透传，比如颜色、图标） */
  readonly data?: unknown;
}

/**
 * 反应定义
 *
 * 【trigger 与 catalyst 的区分】
 *
 * 原神式设计里，反应的效果取决于"后用哪个元素打"：
 * - 火打水 → 蒸发（伤害 ×2）
 * - 水打火 → 蒸发（伤害 ×1.5）
 *
 * 所以要区分：
 * - `base`：目标身上**已有**的元素
 * - `applied`：本次**新施加**的元素
 */
export interface ReactionDef {
  readonly id: string;
  readonly base: string;
  readonly applied: string;
  /**
   * 每次反应消耗的元素量
   *
   * 【不填则用 applied 元素的消耗系数】
   * 典型：1 单位 applied 消耗 0.5 单位 base（1:0.5）
   */
  readonly gaugeCost?: number;
  /**
   * 是否移除 base 元素（完全反应）
   *
   * true = 反应后 base 清零（如冻结解除）
   * false = 按比例消耗（如蒸发后还剩水）
   */
  readonly consumeAll?: boolean;
  /** 效果（开放数据，业务自己解释） */
  readonly data?: unknown;
}

/** 反应结果 */
export interface ReactionResult {
  /** 发生的反应 id（没发生则为空字符串） */
  readonly reactionId: string;
  /** 目标身上原本的元素 */
  readonly baseElement: string;
  /** 原本的元素量 */
  readonly baseGauge: number;
  /** 本次施加的元素 */
  readonly appliedElement: string;
  /** 反应后 base 剩余量（0 = 已清空） */
  readonly remainingGauge: number;
  /** 反应携带的配置数据 */
  readonly data?: unknown;
}

// ============================================================
// 目标状态
// ============================================================

interface Gauge {
  element: string;
  amount: number;
}

// ============================================================
// 配置
// ============================================================

export interface ElementSystemOptions {
  readonly elements: readonly ElementDef[];
  readonly reactions: readonly ReactionDef[];
  /** 默认最大附着量（元素未指定时）。默认 100 */
  readonly defaultMaxGauge?: number;
  onReaction?: (r: ReactionResult, targetId: number) => void;
}

// ============================================================
// 实现
// ============================================================

export class ElementSystem {
  private readonly _elements = new Map<string, ElementDef>();
  private readonly _reactions = new Map<string, ReactionDef>();
  private readonly _defaultMax: number;
  /** targetId → 当前附着的单一元素 */
  private readonly _gauges = new Map<number, Gauge>();
  onReaction?: (r: ReactionResult, targetId: number) => void;

  constructor(opts: ElementSystemOptions) {
    this._defaultMax = opts.defaultMaxGauge ?? 100;
    this.onReaction = opts.onReaction;

    for (const e of opts.elements) {
      if (this._elements.has(e.id)) {
        throw new Error(`[ElementSystem] 元素 id 重复：${e.id}`);
      }
      if (e.decay < 0) {
        throw new Error(`[ElementSystem] 元素 ${e.id} 的 decay 不能为负`);
      }
      this._elements.set(e.id, e);
    }

    for (const r of opts.reactions) {
      const key = reactionKey(r.base, r.applied);
      if (this._reactions.has(key)) {
        throw new Error(`[ElementSystem] 反应 ${r.base}+${r.applied} 重复定义`);
      }
      if (!this._elements.has(r.base)) {
        throw new Error(`[ElementSystem] 反应 ${r.id} 引用了未定义元素：${r.base}`);
      }
      if (!this._elements.has(r.applied)) {
        throw new Error(`[ElementSystem] 反应 ${r.id} 引用了未定义元素：${r.applied}`);
      }
      this._reactions.set(key, r);
    }
  }

  // ---- 查询 ----

  /** 目标当前附着的元素（无则空字符串） */
  elementOf(targetId: number): string {
    const g = this._gauges.get(targetId);
    return g && g.amount > 0 ? g.element : '';
  }

  /** 附着量 */
  gaugeOf(targetId: number): number {
    const g = this._gauges.get(targetId);
    return g ? g.amount : 0;
  }

  /** 附着比例 0~1（UI 显示进度条用） */
  ratioOf(targetId: number): number {
    const g = this._gauges.get(targetId);
    if (!g) return 0;
    const def = this._elements.get(g.element);
    // 【为什么 numOr 包住 def?.maxGauge】`??` 只挡 nullish，挡不住 NaN。
    // maxGauge 为 NaN 时 Math.max(1e-6, NaN) === NaN，除法结果变 NaN，
    // 元素槽进度条静默显示不出来。
    return clamp01(g.amount / Math.max(1e-6, numOr(def?.maxGauge, this._defaultMax)));
  }

  /** 查询某组合会触发什么反应（不产生副作用） */
  peek(base: string, applied: string): ReactionDef | null {
    return this._reactions.get(reactionKey(base, applied)) ?? null;
  }

  // ---- 核心 ----

  /**
   * 施加元素
   *
   * @param amount 元素量。典型值：小火球 25、大火球 50、持续技能 10/秒
   * @returns 反应结果；`reactionId` 为空表示没触发反应
   */
  apply(targetId: number, element: string, amount: number): ReactionResult {
    if (amount <= 0) {
      return {
        reactionId: '', baseElement: this.elementOf(targetId),
        baseGauge: this.gaugeOf(targetId), appliedElement: element,
        remainingGauge: this.gaugeOf(targetId),
      };
    }

    const def = this._elements.get(element);
    if (!def) {
      // 【未知元素：抛错而不是静默忽略】
      // 静默忽略的表现是"这个技能打不出反应"，
      // 排查时你不会想到是元素 id 拼错了。
      throw new Error(
        `[ElementSystem] 未定义的元素：${element}` +
        `（已定义：${[...this._elements.keys()].join(', ')}）`
      );
    }

    const cur = this._gauges.get(targetId);

    // ① 目标身上没元素 → 纯附着
    if (!cur || cur.amount <= 0 || cur.element === '') {
      this._gauges.set(targetId, { element, amount: this._clampGauge(element, amount) });
      return {
        reactionId: '', baseElement: '', baseGauge: 0,
        appliedElement: element, remainingGauge: this.gaugeOf(targetId),
      };
    }

    // ② 同元素 → 叠加（不反应）
    if (cur.element === element) {
      cur.amount = this._clampGauge(element, cur.amount + amount);
      return {
        reactionId: '', baseElement: cur.element, baseGauge: cur.amount,
        appliedElement: element, remainingGauge: cur.amount,
      };
    }

    // ③ 不同元素 → 查反应表
    const reaction = this._reactions.get(reactionKey(cur.element, element));

    if (!reaction) {
      /**
       * 【无反应时的处理：覆盖】
       *
       * 这是设计决策。另一个选择是"共存多元素"，
       * 但那会让反应判定变得不确定（该先反应哪个？），
       * 而且 UI 无法显示"身上同时有三种元素"。
       *
       * 覆盖的直觉是：新元素把旧的"冲掉"了。
       * 玩家能预测，这比"正确"更重要。
       */
      const prevElement = cur.element;
      const prevAmount = cur.amount;
      this._gauges.set(targetId, { element, amount: this._clampGauge(element, amount) });
      return {
        reactionId: '', baseElement: prevElement, baseGauge: prevAmount,
        appliedElement: element, remainingGauge: this.gaugeOf(targetId),
      };
    }

    // ④ 触发反应
    const baseGauge = cur.amount;
    const cost = reaction.gaugeCost ?? amount * 0.5;

    let remaining: number;
    if (reaction.consumeAll || baseGauge - cost <= 0) {
      remaining = 0;
      // base 被清空后，剩余的元素量会留下 applied 元素
      const leftover = Math.max(0, cost - baseGauge);
      if (leftover > 0) {
        this._gauges.set(targetId, { element, amount: this._clampGauge(element, amount - baseGauge / 0.5) });
      } else {
        this._gauges.delete(targetId);
      }
    } else {
      remaining = baseGauge - cost;
      cur.amount = remaining;   // base 元素保留
    }

    const result: ReactionResult = {
      reactionId: reaction.id,
      baseElement: cur.element,
      baseGauge,
      appliedElement: element,
      remainingGauge: remaining,
      ...(reaction.data !== undefined ? { data: reaction.data } : {}),
    };

    this.onReaction?.(result, targetId);
    return result;
  }

  /** 清空某目标的元素附着（死亡、免疫） */
  clear(targetId: number): void {
    this._gauges.delete(targetId);
  }

  /** 直接设置（GM 指令 / 存档） */
  set(targetId: number, element: string, amount: number): void {
    if (amount <= 0) {
      this._gauges.delete(targetId);
      return;
    }
    this._gauges.set(targetId, { element, amount: this._clampGauge(element, amount) });
  }

  /** 移除所有目标的元素（过场、重置） */
  clearAll(): void {
    this._gauges.clear();
  }

  // ---- 主循环 ----

  /**
   * 衰减
   *
   * 【为什么必须每帧调】
   * 元素不衰减的话，玩家上一次火就能在未来无限触发反应——
   * 元素系统就退化成"一次性开关"，失去所有深度。
   */
  tick(dt: number): void {
    if (!safeDt(dt)) return;
    for (const [id, g] of this._gauges) {
      const def = this._elements.get(g.element);
      const decay = def?.decay ?? 0;
      if (decay <= 0) continue;
      g.amount -= decay * dt;
      if (g.amount <= 0) this._gauges.delete(id);
    }
  }

  /** 附着中的目标数（调试/性能监控） */
  get activeCount(): number {
    return this._gauges.size;
  }

  // ---- 内部 ----

  private _clampGauge(element: string, amount: number): number {
    const def = this._elements.get(element);
    const max = def?.maxGauge ?? this._defaultMax;
    return Math.max(0, Math.min(amount, max));
  }
}

function reactionKey(base: string, applied: string): string {
  return `${base}→${applied}`;
}

// ============================================================
// 配置校验
// ============================================================

export interface ElementValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 校验反应表
 *
 * 【为什么要校验】
 *
 * 反应表的坑在于**不对称**：
 * 定义了"水→火 = 蒸发"，却忘了"火→水 = 蒸发"，
 * 结果玩家用火打水能触发、用水打火不能——
 * 表现为"这个技能有时候不反应"，极难排查。
 *
 * 另外"某元素没有任何反应"通常也是配置遗漏。
 */
export function validateReactions(
  elements: readonly ElementDef[],
  reactions: readonly ReactionDef[],
): ElementValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set(elements.map((e) => e.id));
  const seen = new Set<string>();

  for (const r of reactions) {
    const key = reactionKey(r.base, r.applied);
    if (seen.has(key)) errors.push(`反应重复：${r.base}+${r.applied}`);
    seen.add(key);

    if (!ids.has(r.base)) errors.push(`反应 ${r.id} 的 base 元素未定义：${r.base}`);
    if (!ids.has(r.applied)) errors.push(`反应 ${r.id} 的 applied 元素未定义：${r.applied}`);

    // 反向反应缺失
    if (!reactions.some((o) => o.base === r.applied && o.applied === r.base)) {
      warnings.push(
        `反应 ${r.id}（${r.base}+${r.applied}）缺少反向定义：${r.applied}+${r.base}` +
        `——玩家会觉得"这个技能有时候不反应"`
      );
    }
  }

  // 孤立元素
  for (const e of elements) {
    const involved = reactions.some((r) => r.base === e.id || r.applied === e.id);
    if (!involved) {
      warnings.push(`元素 ${e.id} 没有参与任何反应（可能是配置遗漏）`);
    }
  }

  // 自我反应（通常没意义）
  for (const r of reactions) {
    if (r.base === r.applied) {
      warnings.push(`反应 ${r.id} 的 base 与 applied 相同（${r.base}）——永远不会触发，因为同元素只叠加不反应`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
