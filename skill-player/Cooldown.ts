/**
 * Cooldown —— 技能冷却
 *
 * 【设计要点】
 * ① 时间源由外部注入（tick(dt)），不用 setTimeout——否则暂停时仍在恢复
 * ② 支持充能（多段冷却）
 * ③ 冷却缩减用除法，不用减法
 */

import { clamp01, clampNum, safeDt } from '../_core/math';

export interface CooldownOptions {
  /** 单次冷却时长（秒） */
  readonly duration: number;
  /** 充能数量（默认 1）。2 = 可连续放两次，然后逐个恢复 */
  readonly charges?: number;
}

export class Cooldown {
  readonly duration: number;
  readonly maxCharges: number;

  /** 当前可用充能（可能是小数，表示正在恢复中） */
  private _charges: number;
  /** 当前正在恢复的那一个充能的进度（0..1） */
  private _progress = 1;

  constructor(opts: CooldownOptions) {
    // 【为什么 fallback 用下界值 0.0001】duration 是必填项，没有 ?? 可兜。
    // NaN 时退化成"几乎立刻就绪"，比"永久 NaN 导致技能永远放不出来"安全。
    this.duration = clampNum(opts.duration, 0.0001, 1e6, 0.0001);
    this.maxCharges = clampNum(opts.charges, 1, 1e4, 1);
    this._charges = this.maxCharges;
  }

  /** 是否可用（至少有一个充能） */
  get ready(): boolean {
    return this._charges >= 1;
  }

  /** 当前充能数（整数部分 = 可用数量） */
  get charges(): number {
    return Math.floor(this._charges);
  }

  /** 下一个充能的恢复进度 0..1（UI 遮罩用） */
  get progress(): number {
    return this._progress;
  }

  /** 距离下一个充能恢复还有多少秒（全部充满时为 0） */
  get remaining(): number {
    return this._charges >= this.maxCharges ? 0 : (1 - this._progress) * this.duration;
  }

  /**
   * 消耗一个充能
   * @returns 是否成功（失败 = 冷却中）
   */
  trigger(): boolean {
    if (!this.ready) return false;
    this._charges -= 1;
    // 如果没有在恢复中，启动恢复计时
    if (this._progress >= 1) this._progress = 0;
    return true;
  }

  /**
   * 推进时间
   *
   * 【关键】dt 必须是**经过 timeScale 缩放后的时间**。
   * 如果传真实时间，暂停时冷却仍在恢复——这是最典型的暂停 bug。
   *
   * @param dt 缩放后的帧间隔（秒）
   * @param speedMul 冷却缩减倍率（外部 modifier 提供，>1 表示更快）
   */
  tick(dt: number, speedMul = 1): void {
    if (!safeDt(dt)) return;

    /**
     * 【⚠️ speedMul 必须收口——NaN 会让 _progress 永久毒化】
     *
     * 入口原本只校验了 `dt`，没校验 `speedMul`。
     * `this._progress += (dt * NaN) / duration` → `_progress` 变 NaN，此后：
     * - `while (this._progress >= 1)` 恒为 false（NaN 比较恒 false）→ 充能永不恢复
     * - `if (this._charges >= this.maxCharges)` 也救不了它（只有充能满才重置）
     * - **后续再用合法的 tick(dt, 1) 也恢复不了**——NaN 有粘性
     *
     * 实测（修复前）：`trigger()` 后 `tick(0.5, NaN)` → progress=NaN；
     * 再 `tick(10, 1)` → 仍是 NaN，`ready` 仍为 false。
     *
     * `speedMul` 通常来自"冷却缩减"属性（攻速/CDR）。
     * 属性系统一旦算出 NaN（除零、缺失字段），**该技能永久无法再次使用**，
     * 玩家表现为"技能图标永远灰着"，重载角色数据才恢复。
     *
     * 【为什么回落成 1 而不是抛错】
     * tick 是每帧调用的热路径，抛错会打断整个技能更新循环。
     * 回落成 1（无加成）意味着"这一帧没有冷却缩减"，
     * 是最贴近意图的中性行为，且不会污染状态。
     */
    const mul = Number.isFinite(speedMul) && speedMul > 0 ? speedMul : 1;

    if (this._charges >= this.maxCharges) {
      this._progress = 1;
      return;
    }
    this._progress += (dt * mul) / this.duration;
    while (this._progress >= 1) {
      this._progress -= 1;
      this._charges += 1;
      if (this._charges >= this.maxCharges) {
        this._charges = this.maxCharges;
        this._progress = 1;
        break;
      }
    }
  }

  /**
   * 立即充满（调试指令、某些技能效果用）
   */
  reset(): void {
    this._charges = this.maxCharges;
    this._progress = 1;
  }

  /**
   * 冷却缩减的正确公式
   *
   * 【坑】两种算法差别巨大：
   *   乘法：cd × (1 - 缩减)  →  50% 缩减时是 0.5 倍，100% 缩减时冷却为 0（无限放技能！）
   *   除法：cd ÷ (1 + 缩减)  →  50% 缩减时是 0.67 倍，100% 缩减时是 0.5 倍（永不为 0）
   *
   * **必须用除法**。乘法会导致堆满冷却缩减后无限放技能，平衡直接崩坏。
   */
  static applyReduction(duration: number, reduction: number): number {
    return duration / (1 + Math.max(0, reduction));
  }

  /** 归一化进度，供 UI 显示（1 = 就绪） */
  get normalized(): number {
    return this.ready ? 1 : clamp01(this._progress);
  }

  destroy(): void {
    /* 无外部资源，无需清理。保留 destroy 以符合铁律 5 的接口一致性 */
  }
}
