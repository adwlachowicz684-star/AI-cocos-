/**
 * feedback/HitFeedback.ts —— 打击反馈编排器（纯逻辑层）
 *
 * 【它解决什么】
 *
 * 打击感是动作游戏的命。一次命中的反馈其实是**好几件事同时发生**：
 *
 * | 反馈 | 典型时长 | 作用 |
 * |---|---|---|
 * | 顿帧 hitstop | 60~140ms | 让"打中了"这件事被看见 |
 * | 震屏 shake | 100~300ms | 传递力度 |
 * | 闪白 flash | 30~80ms | 标记命中瞬间 |
 * | 击退 knockback | 瞬时 | 物理反馈 |
 * | 数字弹出 popup | 600~900ms | 告知数值 |
 *
 * 手写的问题是它们散落在命中处理函数里：
 *
 * ```typescript
 * onHit() {
 *   shake(0.3);
 *   timeScale = 0.05;
 *   setTimeout(() => timeScale = 1, 80);   // ← 这里埋了两个雷
 *   spawnDamageText(dmg);
 * }
 * ```
 *
 * **雷 1：顿帧用缩放后的时间计时**
 * scale=0.05 时，80ms 的顿帧实际要 1600ms 墙钟才结束。
 * 顿帧变成 1.6 秒卡顿，手感彻底毁掉。
 * 顿帧的到期判定必须用**真实时间**（参照 scheduler/TimeScale 里的同一条规则）。
 *
 * **雷 2：连击时叠加无限增大**
 * 快速连打 10 次，10 个 setTimeout 互相覆盖，
 * 最终 timeScale 什么时候恢复是不确定的，而且震屏强度累加到看不清画面。
 *
 * 【设计】
 *
 * 本模块是一个**编排器**：
 *
 * - 输入：`play(intensity, kind)` —— 一次命中的强度和类型
 * - 输出：每帧 `update(realDt)` 后查询当前各层的强度（0~1）
 * - **不产生任何副作用**：它不碰相机、不改 timeScale、不生成飘字
 *
 * 副作用由你按输出执行，所以本模块能在 Node 里完整测试。
 *
 * 【使用示例】
 * ```typescript
 * const fb = new HitFeedback({ maxIntensity: 1.5 });
 *
 * // 击中时：强度按伤害量给，payload 会原样透传给飘字
 * fb.play('heavy', 0.8, { damage: 120, x: 100, y: 200 });
 * fb.play('crit', 1.4, { damage: 480, x: 100, y: 200 });
 *
 * // 每帧推进（用真实 dt，不要用缩放后的 dt）
 * const out = fb.update(realDt);
 * out.shake;        // 震屏强度 0~1
 * out.flash;        // 闪白强度 0~1
 * out.timeScale;    // 顿帧期间的时间缩放（1 = 无顿帧）
 * out.inHitstop;    // 是否正在顿帧
 *
 * // 取出待渲染的飘字负载（取走即清空）
 * for (const p of fb.takePopupPayloads()) spawnPopup(p);
 * ```
 *
 * 【⚠️ kind 取值固定】
 * `light` / `heavy` / `crit` / `block` / `parry` / `kill` / `hurt` / `custom`，
 * 传其他字符串会**抛错**（不是静默忽略）——
 * 预设表里没有的类型请显式传 `profiles` 扩展，别指望默认值兜底。
 *
 * 【⚠️ update 必须用 realDt】
 * 顿帧期间逻辑 dt 会被压成 0，若用缩放后的 dt 喂给 update，
 * 顿帧将永远结束不了——表现是"游戏卡住不动"。
 */

import { clamp01, clampNum, safeDt } from '../_core/math';

// ==================== 类型 ====================

/** 反馈类型（决定各层的默认配比） */
export type HitKind =
  | 'light'      // 轻击
  | 'heavy'      // 重击
  | 'crit'       // 暴击
  | 'block'      // 被格挡
  | 'parry'      // 弹反
  | 'kill'       // 击杀
  | 'hurt'       // 自己受伤
  | 'custom';

export interface FeedbackLayer {
  /** 延迟多久开始（真实秒） */
  readonly delay?: number;
  /** 持续多久（真实秒） */
  readonly duration: number;
  /** 强度系数（乘以传入的 intensity） */
  readonly scale?: number;
}

export interface HitProfile {
  readonly hitstop?: FeedbackLayer;
  readonly shake?: FeedbackLayer;
  readonly flash?: FeedbackLayer;
  readonly popup?: FeedbackLayer;
  /** 顿帧期间的时间缩放（0 = 完全冻结） */
  readonly timeScale?: number;
  /** 击退强度（由宿主按方向施加） */
  readonly knockback?: number;
}

export interface FeedbackOutput {
  /** 顿帧期间的时间缩放（1 = 无顿帧） */
  readonly timeScale: number;
  /** 震屏强度 0~1 */
  readonly shake: number;
  /** 闪白强度 0~1 */
  readonly flash: number;
  /**
   * 数字弹出**强度** 0~1（不是进度）
   *
   * 【⚠️ 这里以前写的是"进度 0~1（1 = 刚触发，0 = 结束）"，是错的（P2）】
   *
   * 实测（修复前）：`play('heavy', 0.5)` 之后连续 40 帧采样，
   * `popup` 恒为 `0.50`，直到 duration 结束的那一帧直接掉到 0。
   * 也就是说它是"强度"（= 传入的 intensity × popup 层的 scale），
   * 在整个持续期内**恒定不变**，不是从 1 递减到 0 的进度。
   *
   * 后果很具体：宿主若按文档把它当进度做飘字淡出，
   * 会看到"飘字全程不淡出、结束瞬间突然消失"。
   *
   * 【为什么不直接把它改成真正的进度】
   * 那是 breaking change——已按"强度"接的宿主会突然看到淡出。
   * 这里选择改文档说清真实语义（全库共享模式 F：
   * 文档与实现冲突时，要么改实现、要么改文档，**不能放着不管**）。
   *
   * 需要进度的宿主请自己按 duration 算：
   * `1 - elapsed / duration`，或用 `takePopupPayloads()` 的时机自己维护生命周期。
   */
  readonly popup: number;
  /** 是否正在顿帧 */
  readonly inHitstop: boolean;
}

export interface HitFeedbackOptions {
  /** 自定义类型配置（覆盖预设） */
  readonly profiles?: Partial<Record<HitKind, HitProfile>>;
  /** 全局强度上限（防止叠加到看不清） */
  readonly maxIntensity?: number;
  /** 同时存在的反馈实例上限 */
  readonly maxInstances?: number;
  /** 顿帧期间是否允许新的顿帧叠加 */
  readonly stackHitstop?: boolean;
}

// ==================== 预设 ====================

/**
 * 预设数值的来历
 *
 * 这些不是拍脑袋定的，是动作游戏里被反复验证过的区间：
 *
 * - **顿帧**：轻击 60ms、重击 110ms、暴击 140ms。
 *   低于 50ms 玩家察觉不到；高于 150ms 会被认为是掉帧。
 * - **震屏**：轻击 0.15、重击 0.4、暴击 0.6（归一化到 0~1）。
 *   超过 0.8 就会看不清画面。
 * - **闪白**：30~80ms。太长会像闪光弹，太短看不见。
 * - **timeScale**：顿帧期间 0.05~0.15，不是 0。
 *   完全冻结会让粒子、UI 都僵住，看起来像卡死；
 *   留一点速度能保持"时间变慢"而不是"游戏崩溃"的观感。
 */
export const DEFAULT_PROFILES: Readonly<Record<HitKind, HitProfile>> = {
  light: {
    hitstop: { duration: 0.06 },
    shake: { duration: 0.12, scale: 0.15 },
    flash: { duration: 0.03, scale: 0.3 },
    popup: { duration: 0.7 },
    timeScale: 0.1,
    knockback: 0.3,
  },
  heavy: {
    hitstop: { duration: 0.11 },
    shake: { duration: 0.2, scale: 0.4 },
    flash: { duration: 0.05, scale: 0.6 },
    popup: { duration: 0.8 },
    timeScale: 0.05,
    knockback: 1.0,
  },
  crit: {
    hitstop: { duration: 0.14 },
    shake: { duration: 0.28, scale: 0.6 },
    flash: { duration: 0.08, scale: 1.0 },
    popup: { duration: 0.9 },
    timeScale: 0.03,
    knockback: 1.4,
  },
  block: {
    hitstop: { duration: 0.05 },
    shake: { duration: 0.1, scale: 0.2 },
    flash: { duration: 0.04, scale: 0.2 },
    popup: { duration: 0.5 },
    timeScale: 0.15,
    knockback: 0.2,
  },
  parry: {
    hitstop: { duration: 0.18 },
    shake: { duration: 0.3, scale: 0.5 },
    flash: { duration: 0.1, scale: 1.0 },
    popup: { duration: 0.9 },
    timeScale: 0.02,
    knockback: 0,
  },
  kill: {
    hitstop: { duration: 0.16 },
    shake: { duration: 0.35, scale: 0.7 },
    flash: { duration: 0.1, scale: 0.8 },
    popup: { duration: 1.0 },
    timeScale: 0.02,
    knockback: 1.6,
  },
  hurt: {
    hitstop: { duration: 0.08 },
    shake: { duration: 0.25, scale: 0.5 },
    flash: { duration: 0.12, scale: 0.9 },
    popup: { duration: 0.6 },
    timeScale: 0.08,
    knockback: 0.8,
  },
  custom: {
    hitstop: { duration: 0.08 },
    shake: { duration: 0.15, scale: 0.3 },
    flash: { duration: 0.05, scale: 0.5 },
    popup: { duration: 0.7 },
    timeScale: 0.08,
    knockback: 0.5,
  },
};

// ==================== 实现 ====================

interface Instance {
  readonly kind: HitKind;
  readonly profile: HitProfile;
  readonly intensity: number;
  /** 已流逝的真实时间 */
  elapsed: number;
  /** 本次实例是否有顿帧效果（多次叠加只算一次） */
  hasHitstop: boolean;
  /** 供宿主读取的附加数据 */
  readonly payload: Readonly<Record<string, unknown>> | null;
  /**
   * 飘字 payload 是否已被 `takePopupPayloads()` 取走
   *
   * 【为什么用标志而不是时间窗口】
   * 原实现判定 `inst.elapsed - delay < 1 / 30`——窗口只有 33ms。
   * 帧间隔一旦大于 33ms，整个窗口会被**跳过**
   * （上一帧 elapsed 还没到、下一帧已经超），飘字永远不被取出。
   *
   * 实测（修复前）：60fps → 1 条；**30fps → 0 条；20fps → 0 条**。
   * 中低端手机、复杂战斗、录屏时的常态帧率正是 20~30fps，
   * 于是这些设备上伤害飘字 **100% 不显示**，且完全静默——
   * 开发在 60fps 的机器上永远复现不了。
   *
   * 同时 `1/30` 是裸魔法数字，违反 rule4（配置驱动）。
   * 改成"到点就置标志、由 take 消费"后，与帧率彻底无关。
   */
  popupTaken: boolean;
}

const DEFAULT_MAX_INTENSITY = 1.5;
const DEFAULT_MAX_INSTANCES = 24;

export class HitFeedback {
  private readonly _profiles: Record<HitKind, HitProfile>;
  private readonly _maxIntensity: number;
  private readonly _maxInstances: number;
  private readonly _stackHitstop: boolean;
  private readonly _instances: Instance[] = [];
  private _timeScale = 1;
  private _shake = 0;
  private _flash = 0;
  private _popup = 0;
  private _lastKnockback = 0;

  constructor(opts: HitFeedbackOptions = {}) {
    this._profiles = { ...DEFAULT_PROFILES, ...(opts.profiles ?? {}) } as Record<HitKind, HitProfile>;
    /**
     * 【⚠️ 为什么不能用 `?? 1.5`（P2）】
     * `??` 只挡 null/undefined，NaN 照穿。
     * 之后 `Math.min(intensity, NaN) === NaN` → `eff = NaN`
     * → 各层强度全是 NaN → `clamp01(NaN)` 也是 NaN
     * → 震屏/闪白既不是"有"也不是"无"，而是 NaN，
     * 宿主拿去做位移会算出 NaN 坐标：**整个表现层静默失效**。
     * 实测（修复前）：`maxIntensity: NaN` 时 shake = NaN、flash = NaN
     * （对照组 0.4 / 0.6）。
     *
     * 上界取 1e6 而不是某个"合理上限"：这是**强度倍率**，
     * 宿主想叠到多大是它的自由；这里只负责挡住非有限值
     * （见 _core 的 numOr 注释：给普通配置乱定上界会静默改掉合法配置）。
     */
    this._maxIntensity = clampNum(opts.maxIntensity, 0, 1e6, DEFAULT_MAX_INTENSITY);
    this._maxInstances = clampNum(opts.maxInstances, 1, 1e5, DEFAULT_MAX_INSTANCES);
    this._stackHitstop = opts.stackHitstop ?? false;
  }

  // ==================== 查询 ====================

  /**
   * 当前输出快照
   *
   * 【为什么每次都 new 一个对象，而不是复用同一个（P2）】
   * 复用内部对象能让每帧零分配，但会破坏"快照"语义：
   * 宿主写下 `const prev = fb.output` 后，
   * 下次 `update()` 会把 prev 的内容一起改掉，
   * 于是"这一帧和上一帧的对比"恒等——
   * 做差分、做插值、做"强度突变检测"的宿主会全部失效。
   * 每帧一个小对象的代价远小于这类静默错误，所以保留 new。
   */
  get output(): FeedbackOutput {
    return {
      timeScale: this._timeScale,
      shake: this._shake,
      flash: this._flash,
      popup: this._popup,
      inHitstop: this._timeScale < 1,
    };
  }

  get timeScale(): number {
    return this._timeScale;
  }

  get shake(): number {
    return this._shake;
  }

  get flash(): number {
    return this._flash;
  }

  /** 最近一次触发的击退强度（宿主在触发后读取一次） */
  get lastKnockback(): number {
    return this._lastKnockback;
  }

  get activeCount(): number {
    return this._instances.length;
  }

  // ==================== 触发 ====================

  /**
   * 播放一次打击反馈
   *
   * @param kind 类型
   * @param intensity 强度倍率（默认 1）。可按伤害量缩放。
   * @param payload 附加数据（伤害数值、是否暴击等），宿主在 popup 触发时读取
   */
  play(
    kind: HitKind,
    intensity = 1,
    payload: Readonly<Record<string, unknown>> | null = null
  ): void {
    const profile = this._profiles[kind];
    if (!profile) {
      throw new Error(`[HitFeedback] 未知的反馈类型：${kind}`);
    }
    if (!Number.isFinite(intensity) || intensity < 0) {
      throw new Error(`[HitFeedback] intensity 必须是非负有限数，收到 ${intensity}`);
    }

    const eff = Math.min(intensity, this._maxIntensity);

    /**
     * 【⚠️ 顿帧默认不叠加】
     *
     * 连打时如果每次都新增一个顿帧实例，
     * 10 连击会变成 10 倍时长的卡顿。
     * 默认行为：已有实例在顿帧时，新实例不再贡献 timeScale，
     * 但仍贡献震屏和闪白（连打要有累积的爽感）。
     */
    const hitstopActive = this._instances.some((i) => i.hasHitstop && this._inLayer(i, i.profile.hitstop));
    const hasHitstop = this._stackHitstop || !hitstopActive;

    if (this._instances.length >= this._maxInstances) {
      // 满了就丢最旧的：新的命中反馈比旧的更值得表现
      this._instances.shift();
    }

    this._instances.push({
      kind,
      profile,
      intensity: eff,
      elapsed: 0,
      hasHitstop,
      payload,
      popupTaken: false,
    });

    this._lastKnockback = (profile.knockback ?? 0) * eff;
  }

  /**
   * 每帧更新
   *
   * @param realDt **真实**帧间隔（秒），不受 timeScale 影响
   *
   * 【为什么必须是真实时间】
   * 用缩放后的 dt 计时，顿帧会自我延长：
   * scale=0.05 时，60ms 的顿帧需要 1200ms 墙钟才走完。
   * 这是"手感糊掉"最常见的原因，而且很难联想到计时口径。
   */
  update(realDt: number): FeedbackOutput {
    /**
     * 【⚠️ 为什么必须用 safeDt，不能用 `!(realDt > 0)`（P1）】
     *
     * `Infinity > 0` 是 **true**，所以 `!(Infinity > 0)` 是 false——
     * Infinity 直接穿透守卫进了下面的累加：
     * `inst.elapsed += Infinity` → 每个实例的 elapsed 变成 Infinity
     * → `_totalDuration` 判定全部到期 → 实例被一次性清空。
     *
     * 实测（修复前）：`update(Infinity)` 后 `activeCount` 从 1 变 0，
     * **所有正在播放的震屏/闪白/飘字同一帧集体消失**。
     *
     * Infinity 的 dt 不是理论问题：切后台再回来、断点续跑、
     * 时间戳倒着走之后取绝对值，都能产出巨大或无穷的 dt。
     * 本单元其余计时都用的 `safeDt`，这里是漏掉的那一个。
     */
    if (!safeDt(realDt)) {
      return this.output;
    }

    // 推进并清理
    for (let i = this._instances.length - 1; i >= 0; i--) {
      const inst = this._instances[i];
      inst.elapsed += realDt;
      if (inst.elapsed >= this._totalDuration(inst.profile)) {
        this._instances.splice(i, 1);
      }
    }

    // 聚合各层
    let minScale = 1;
    let shake = 0;
    let flash = 0;
    let popup = 0;

    for (const inst of this._instances) {
      const p = inst.profile;

      if (inst.hasHitstop) {
        const inHitstop = this._inLayer(inst, p.hitstop);
        if (inHitstop) {
          minScale = Math.min(minScale, p.timeScale ?? 1);
        }
      }

      shake = Math.max(shake, this._layerValue(inst, p.shake));
      flash = Math.max(flash, this._layerValue(inst, p.flash));
      popup = Math.max(popup, this._layerValue(inst, p.popup));
    }

    this._timeScale = minScale;
    this._shake = clamp01(shake);
    this._flash = clamp01(flash);
    this._popup = clamp01(popup);

    return this.output;
  }

  /** 立即结束所有反馈（切场景、暂停时用） */
  clear(): void {
    this._instances.length = 0;
    this._timeScale = 1;
    this._shake = 0;
    this._flash = 0;
    this._popup = 0;
    this._lastKnockback = 0;
  }

  /**
   * 卸载（P2）
   *
   * 【为什么需要它，而 clear 不够】
   * `clear()` 是"游戏里"的语义：暂停、切场景后还要继续用。
   * 缺的是"这个对象不要了"的语义——
   * `_instances` 里每个实例都持有宿主传进来的 `payload`
   * （伤害数值、坐标，甚至可能是实体引用），
   * 只 clear 数组引用、不显式释放，这些 payload 会一直挂到下一次 GC。
   *
   * 这里显式把每个 payload 引用断开再清空，
   * 让"卸载"和"清空"成为两件可区分的事。
   */
  destroy(): void {
    for (const inst of this._instances) {
      (inst as { payload: Readonly<Record<string, unknown>> | null }).payload = null;
    }
    this.clear();
  }

  /**
   * 取出所有已到点但尚未取走的飘字 payload（宿主用来生成飘字）
   *
   * 【为什么按标志取，而不是按时间窗口捞】
   * 见 `Instance.popupTaken` 的注释：时间窗口在低于 30fps 时会被整帧跳过。
   *
   * 【为什么不在 update 里自动清空】
   * 飘字的时机由宿主决定（可能要等对象池腾出位置）。
   * 这里只负责"通知一次"，取走后标志置位，不会重复给同一条 payload。
   */
  takePopupPayloads(): Readonly<Record<string, unknown>>[] {
    const out: Readonly<Record<string, unknown>>[] = [];
    for (const inst of this._instances) {
      const p = inst.profile.popup;
      if (!p) continue;
      if (!inst.payload) continue;
      if (inst.popupTaken) continue;
      if (inst.elapsed < (p.delay ?? 0)) continue;

      inst.popupTaken = true;
      out.push(inst.payload);
    }
    return out;
  }

  // ==================== 内部 ====================

  private _inLayer(inst: Instance, layer: FeedbackLayer | undefined): boolean {
    if (!layer) return false;
    const start = layer.delay ?? 0;
    return inst.elapsed >= start && inst.elapsed < start + layer.duration;
  }

  /**
   * 层强度
   *
   * 【取 max 而不是 sum】
   * 两个 0.6 强度的震屏叠加成 1.2 会让画面糊掉。
   * 取最大值：同时发生的多次命中，视觉强度等于最强那次。
   */
  private _layerValue(inst: Instance, layer: FeedbackLayer | undefined): number {
    if (!layer) return 0;
    if (!this._inLayer(inst, layer)) return 0;
    return inst.intensity * (layer.scale ?? 1);
  }

  private _totalDuration(p: HitProfile): number {
    let max = 0;
    for (const layer of [p.hitstop, p.shake, p.flash, p.popup]) {
      if (!layer) continue;
      max = Math.max(max, (layer.delay ?? 0) + layer.duration);
    }
    return max;
  }
}
