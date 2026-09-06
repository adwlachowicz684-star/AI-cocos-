/**
 * DamagePipeline —— 分阶段伤害计算管线
 *
 * 【这是整个库最值钱的插件，因为所有游戏都用得上】
 *
 * 【为什么阶段化】
 * 伤害计算永远在变：加个元素抗性、加个背刺加成、加个难度系数……
 * 如果写成一个大函数，每次改动都要在函数内部插代码，越改越乱。
 *
 * 做成一串 stage 后：**加一个机制 = 插入一个 stage，原有代码一行不动。**
 * 这就是"开闭原则"的具体实践。
 *
 * 【使用示例】
 * ```typescript
 * const dmg = DamagePipeline.createDefault();
 *
 * // 外部插一个自定义阶段（遗物、buff 注入自己的规则）
 * dmg.addStage('relic_burn', (v, ctx) => ctx.type === 'fire' ? v * 1.25 : v, 35);
 *
 * const result = dmg.calculate({ raw: 20, type: 'fire', crit: true }, target);
 * // result.value = 最终伤害
 * // result.stages = [{name:'base',value:20}, {name:'relic_burn',value:25}, ...]
 * ```
 */

import { DamageContext, DamageResult, IDamageable } from './IDamageable';
import { clamp, clamp01 } from '../_core/math';

/**
 * 一个计算阶段
 * @param value 当前数值
 * @param ctx 伤害上下文（只读，不要改它）
 * @param target 受击目标（可为 null，做纯数值模拟时）
 * @returns 新的数值
 *
 * 【铁律】stage 必须是纯函数：相同输入必得相同输出，无副作用。
 * 有副作用的 stage 无法单测、无法重试、无法批量模拟。
 */
export type DamageStage = (value: number, ctx: DamageContext, target: IDamageable | null) => number;

interface StageEntry {
  name: string;
  fn: DamageStage;
  /** 优先级，小的先执行 */
  order: number;
  /** 该阶段的中间值是否计入 stages 输出（调试用） */
  record: boolean;
}

export interface DamagePipelineOptions {
  /** 最低伤害保底（防止堆护甲后伤害归零，玩家会觉得"打不动"很挫败） */
  readonly minDamage?: number;
  /** 暴击倍率默认值 */
  readonly defaultCritMul?: number;
}

export class DamagePipeline {
  private readonly _stages: StageEntry[] = [];
  private readonly _minDamage: number;
  private readonly _defaultCritMul: number;

  constructor(opts: DamagePipelineOptions = {}) {
    this._minDamage = opts.minDamage ?? 1;
    this._defaultCritMul = opts.defaultCritMul ?? 2;
  }

  /**
   * 添加一个阶段
   * @param order 优先级，小的先执行。建议用 10 的倍数留出插入空间（10/20/30…）
   */
  addStage(name: string, fn: DamageStage, order: number, record = true): void {
    this._stages.push({ name, fn, order, record });
    this._stages.sort((a, b) => a.order - b.order);
  }

  removeStage(name: string): void {
    const i = this._stages.findIndex((s) => s.name === name);
    if (i >= 0) this._stages.splice(i, 1);
  }

  /**
   * 计算伤害（只算数值，不产生任何副作用）
   *
   * 【关键】这个方法是纯的——它不扣血、不播特效、不发事件。
   * 表现层通过 onResult 订阅，这样可以关掉表现做批量模拟。
   */
  calculate(ctx: DamageContext, target: IDamageable | null): DamageResult {
    /**
     * 【⚠️ NaN / Infinity 必须在入口拦掉】
     *
     * 管线全程无 Number.isFinite 守卫，脏数据会静默扩散：
     * `raw = NaN` 一路穿过所有 stage、取整、保底，最终写进 target.hp。
     * 一次 `undefined` 参与运算（配置缺字段）就能让角色血量永久变成 NaN——
     * 不报错，症状是「血条消失」，排查成本极高。
     */
    if (!Number.isFinite(ctx.raw)) {
      return {
        value: 0,
        isCrit: false,
        type: ctx.type ?? 'physical',
        stages: [],
        immune: false,
      };
    }

    const stages: Array<{ name: string; value: number }> = [];
    let value = ctx.raw;
    let crit = ctx.crit ?? false;

    stages.push({ name: 'base', value });

    for (const s of this._stages) {
      value = s.fn(value, ctx, target);
      if (s.record) stages.push({ name: s.name, value });
    }

    /**
     * 【坑】免疫判定必须在取整**之前**用浮点值判断。
     *
     * 曾经写反过：先 Math.round 再判断 `value === 0`，
     * 结果「20 伤害被 99999 护甲减到 0.02」也被判成免疫 → 伤害 0。
     * 玩家遇到「怎么打都是 0」会以为游戏坏了。
     *
     * 正确语义：
     *   - 减免后 > 0（哪怕只有 0.02）→ 没免疫，走保底给最低伤害
     *   - 减免后 <= 0                 → 真的免疫（如伤害类型被完全免疫）
     */
    const immune = ctx.raw > 0 && value <= 0;

    // 【坑】取整要在最后一步。中间就取整会让小数值的百分比加成全部失效。
    let finalValue = Math.max(0, Math.round(value));

    // 保底：有伤害意图、没被免疫，但被减到低于最小值时给保底
    if (ctx.raw > 0 && !immune && finalValue < this._minDamage) {
      finalValue = this._minDamage;
    }

    return {
      value: finalValue,
      isCrit: crit,
      type: ctx.type ?? 'physical',
      stages,
      immune,
    };
  }

  /**
   * 应用伤害 = 计算 + 写入目标 + 发事件
   *
   * 这是"有副作用"的版本，正常游戏流程用它。
   */
  apply(ctx: DamageContext, target: IDamageable): DamageResult {
    const result = this.calculate(ctx, target);
    target.applyDamage(result, ctx);
    this._listeners.forEach((fn) => fn(result, ctx, target));
    return result;
  }

  /**
   * 批量模拟（无表现）
   *
   * 【它的价值】
   * 因为 calculate 是纯的，你可以一秒钟跑几千次伤害结算，
   * 用来验证平衡（"这套 build 的期望 DPS 是多少"）。
   * 如果表现和计算耦合，这件事就做不了。
   */
  simulate(ctx: DamageContext, target: IDamageable, times = 1): number[] {
    const out: number[] = [];
    for (let i = 0; i < times; i++) out.push(this.calculate(ctx, target).value);
    return out;
  }

  // ---- 结果订阅（表现层用）----

  private _listeners: Array<(r: DamageResult, c: DamageContext, t: IDamageable) => void> = [];

  onResult(fn: (r: DamageResult, c: DamageContext, t: IDamageable) => void): () => void {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  destroy(): void {
    this._stages.length = 0;
    this._listeners.length = 0;
  }

  // ==================== 预设 ====================

  /**
   * 创建一条标准管线
   *
   * 顺序（order 用 10 的倍数，方便外部插入）：
   *  10 暴击
   *  20 外部自定义（留给调用方）
   *  30 元素抗性
   *  40 护甲（除法公式）
   *  50 取整保底（在 calculate 内部完成）
   */
  static createDefault(opts: DamagePipelineOptions = {}): DamagePipeline {
    const p = new DamagePipeline(opts);
    const defaultCritMul = p._defaultCritMul;

    // 10 · 暴击
    p.addStage('crit', (v, ctx) => (ctx.crit ? v * (ctx.critMul ?? defaultCritMul) : v), 10);

    // 30 · 元素抗性
    p.addStage('resist', (v, ctx, target) => {
      // 真实伤害：无视一切减免（抗性、护甲、穿透都不参与）
      if (ctx.type === 'true') return v;
      if (!target?.resistances) return v;
      const type = ctx.type ?? 'physical';
      const resist = target.resistances[type] ?? 0; // 0 = 无抗性

      // 穿透：只削弱正抗性（减伤），不影响易伤（负抗性）
      const effective = resist > 0 ? resist * (1 - clamp01(ctx.resistPen ?? 0)) : resist;

      /**
       * 抗性语义：
       *   +0.5 → 减伤 50%（v × 0.5）
       *   -0.3 → 易伤 30%（v × 1.3）
       *
       * 【坑】上限必须 < 1。如果允许 resist = 1，伤害完全归零，
       * 玩家会遇到"怎么打都打不动"的敌人——这是设计事故，不是难度。
       * 这里 clamp 到 0.9（最多减伤 90%）。
       */
      const clamped = clamp(effective, -1, 0.9);
      return v * (1 - clamped);
    }, 30);

    // 40 · 护甲（除法公式）
    p.addStage('armor', (v, ctx, target) => {
      if (ctx.type === 'true') return v; // 真实伤害无视护甲
      /**
       * 【⚠️ 护甲穿透必须 clamp01，否则负值让护甲不减反增】
       *
       * 抗性穿透（resistPen）有 clamp01，护甲穿透早期漏了，于是：
       *   armorPen = -0.5 → 护甲 100 变 150 → 伤害 50 掉到 40
       *   armorPen = -2   → 护甲 100 变 300 → 伤害 50 掉到 25
       * 「破甲」点成负数，敌人护甲反而翻倍。
       *
       * 至于 armorPen > 1：护甲变负后走 `if (armor <= 0) return v`，
       * 结果正好等价于合法上限，没有越界收益，不需要额外处理。
       */
      const armor = (target?.armor ?? 0) * (1 - clamp01(ctx.armorPen ?? 0));
      if (armor <= 0) return v;
      /**
       * 【为什么用除法而不是减法】
       * 减法（dmg - armor）：
       *   ① armor > dmg 时出现负伤害（打人反而加血）
       *   ② 高护甲时完全免疫，平衡上极难处理
       * 除法（dmg * 100/(100+armor)）：
       *   收益递减，永远不会归零，是行业标准做法
       */
      return v * (100 / (100 + armor));
    }, 40);

    return p;
  }
}
