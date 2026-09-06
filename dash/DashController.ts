/**
 * DashController —— 冲刺控制器
 *
 * 【它解决什么】
 *
 * 冲刺（Dash）是哈迪斯式动作游戏的灵魂。
 * 它同时承担三件事：位移、无敌帧、取消后摇。
 *
 * 【三个关键手感点】
 *
 * **① 位移必须用衰减曲线，不是匀速**
 * 匀速位移看起来像"滑行"，没有爆发感。
 * 正确做法：初速度很高，然后快速衰减。
 * ```
 * v = v0 · (1 - t/duration)^p     p ≈ 2
 * ```
 * 前 20% 的时间走完 60% 的距离——这就是"冲"的感觉。
 *
 * **② 冲刺必须能取消攻击后摇**
 * 这是最重要的一条。攻击硬直中玩家按冲刺想跑，
 * 如果被拒绝，角色会"不听话"——这是动作游戏最致命的手感问题。
 *
 * 所以 DashController 提供 `canCancel()`：几乎任何阶段都能触发。
 *
 * **③ 无敌帧的时机**
 * 无敌帧不是整个冲刺都无敌（那样太强），
 * 而是**前中段**（如前 70%）。末尾留一点破绽，
 * 否则玩家会无脑冲刺躲一切。
 *
 * 【零业务依赖】
 * 它只输出「这一帧应该移动多少」和「现在是否无敌」。
 * 不碰角色、不碰动画、不碰碰撞。
 *
 * 【使用示例】
 * ```typescript
 * const dash = new DashController({
 *   distance: 4, duration: 0.22,
 *   invulnerableRatio: 0.7,
 *   cooldown: 0.5,
 * });
 *
 * // 触发（方向由调用方给，通常取当前移动输入；没输入则用朝向）
 * if (dash.tryStart(dirX, dirY, facingDeg)) { ... }
 *
 * // 每帧
 * dash.tick(dt);
 * if (dash.active) {
 *   character.x += dash.deltaX;
 *   character.y += dash.deltaY;
 *   character.invulnerable = dash.invulnerable;
 * }
 * ```
 */

import { clamp, safeDt } from '../_core/math';

export interface DashOptions {
  /**
   * 冲刺距离（米）
   *
   * 【参考值】角色身高的 2~3 倍。
   * 哈迪斯约 4 米（角色高 1.8）。太短没有位移感，太长会脱离战斗节奏。
   */
  distance?: number;

  /**
   * 持续时间（秒）
   *
   * 【参考值】0.18 ~ 0.30
   * 短于 0.15 玩家看不清发生了什么；长于 0.4 会有失控感。
   */
  duration?: number;

  /**
   * 无敌帧占比（0..1）
   *
   * 【参考值】0.6 ~ 0.8
   * 1.0 = 全程无敌（太强，且玩家会觉得"我闭眼按就行"）
   * 0.5 以下 = 无敌时间太短，玩家感受不到
   */
  invulnerableRatio?: number;

  /** 冷却（秒） */
  cooldown?: number;

  /** 充能层数（哈迪斯可以连续冲两次） */
  charges?: number;

  /**
   * 衰减指数
   *
   * 【数值含义】`v = v0 · (1 - t)^p`
   * - p = 1：线性衰减（比较平缓）
   * - **p = 2：推荐**，前段极快后段收尾自然
   * - p = 3：更极端，几乎是"瞬移"
   */
  falloff?: number;

  /**
   * 末段减速（0..1）
   *
   * 【为什么需要】纯衰减曲线在末尾速度趋近 0，
   * 角色会"粘"在原地一小会儿。加一点主动减速让它收得干脆。
   *
   * 【实现必须保证位移单调递增】
   * 早期的实现是"末段对位移打折扣"，结果位移会**回缩**
   * （冲到 4.26m 又退回 4.03m），视觉上是一次抖动。
   * 正确做法是让衰减指数在末段**平滑增大**——
   * 速度衰减更快，但位移只增不减。
   */
  endBrake?: number;

  /**
   * 冲刺结束后保留的惯性速度比例（0..1）
   *
   * 【体验设计】0 = 急停（精确可控，适合战斗）
   * 0.3 = 带一点滑行（更流畅，适合探索）
   */
  exitMomentum?: number;
}

/** 冲刺状态 */
export type DashState = 'idle' | 'dashing' | 'recovery';

/**
 * 冲刺控制器
 *
 * 【状态机】
 * ```
 * idle ──tryStart──▶ dashing ──▶ recovery ──▶ idle
 *                       │
 *                       └── cancel() ──▶ idle
 * ```
 */
export class DashController {
  private _distance: number;
  private _duration: number;
  private _invulnRatio: number;
  private _cooldown: number;
  private _maxCharges: number;
  private _falloff: number;
  private _endBrake: number;
  private _exitMomentum: number;

  private _state: DashState = 'idle';
  private _t = 0;

  /** 本帧位移（调用方读取后累加到角色位置） */
  private _dx = 0;
  private _dy = 0;

  /** 冲刺方向（单位向量） */
  private _dirX = 1;
  private _dirY = 0;

  /** 冲刺前的位置（用于精确保证总距离） */
  private _startX = 0;
  private _startY = 0;
  private _curX = 0;
  private _curY = 0;

  private _cdLeft = 0;
  private _charges: number;

  /** 触发次数（残影/音效用） */
  private _dashCount = 0;

  constructor(opts: DashOptions = {}) {
    this._distance = opts.distance ?? 4;
    this._duration = opts.duration ?? 0.22;
    this._invulnRatio = opts.invulnerableRatio ?? 0.7;
    this._cooldown = opts.cooldown ?? 0.5;
    this._maxCharges = opts.charges ?? 1;
    this._falloff = opts.falloff ?? 2;
    this._endBrake = opts.endBrake ?? 0.15;
    this._exitMomentum = opts.exitMomentum ?? 0;
    this._charges = this._maxCharges;
  }

  // ── 查询 ──

  get state(): DashState {
    return this._state;
  }

  /** 是否正在冲刺 */
  get active(): boolean {
    return this._state === 'dashing';
  }

  /** 本帧位移 X（**调用方负责累加**） */
  get deltaX(): number {
    return this._dx;
  }

  /** 本帧位移 Y */
  get deltaY(): number {
    return this._dy;
  }

  /** 当前是否无敌 */
  get invulnerable(): boolean {
    if (this._state !== 'dashing') return false;
    return this._t / this._duration <= this._invulnRatio;
  }

  /** 进度 0..1 */
  get progress(): number {
    if (this._state !== 'dashing') return 0;
    return clamp(this._t / this._duration, 0, 1);
  }

  /** 剩余冷却 */
  get cooldownLeft(): number {
    return this._cdLeft;
  }

  /** 剩余充能 */
  get chargesLeft(): number {
    return this._charges;
  }

  /** 是否可用（有充能且不在冲刺中） */
  get ready(): boolean {
    return this._state === 'idle' && this._charges > 0;
  }

  /** 冲刺方向（残影/特效用） */
  get dirX(): number {
    return this._dirX;
  }

  get dirY(): number {
    return this._dirY;
  }

  /** 累计冲刺次数 */
  get dashCount(): number {
    return this._dashCount;
  }

  // ── 触发 ──

  /**
   * 尝试冲刺
   *
   * @param dirX 方向 X（**不需要归一化**，内部会处理）
   * @param dirY 方向 Y
   * @param fallbackDeg 无输入时的默认朝向（度）
   * @param fromX 当前位置 X（用于精确控制总距离）
   * @param fromY 当前位置 Y
   *
   * 【零向量的处理】
   * 摇杆没推 / 方向键没按时传 (0, 0)，
   * 不处理会得到 NaN 方向，角色坐标变 NaN。
   * 这种情况用 `fallbackDeg`（通常取角色朝向）。
   */
  tryStart(
    dirX: number, dirY: number,
    fallbackDeg = 0,
    fromX = 0, fromY = 0,
  ): boolean {
    if (this._state === 'dashing') return false;
    if (this._charges <= 0) return false;

    const len = Math.hypot(dirX, dirY);
    if (len > 1e-6) {
      this._dirX = dirX / len;
      this._dirY = dirY / len;
    } else {
      const r = (fallbackDeg * Math.PI) / 180;
      this._dirX = Math.cos(r);
      this._dirY = Math.sin(r);
    }

    this._state = 'dashing';
    this._t = 0;
    this._startX = fromX;
    this._startY = fromY;
    this._curX = fromX;
    this._curY = fromY;
    this._dx = 0;
    this._dy = 0;

    this._charges--;
    if (this._charges <= 0 && this._cdLeft <= 0) this._cdLeft = this._cooldown;
    this._dashCount++;

    return true;
  }

  /**
   * 是否能取消当前动作（供业务层判断）
   *
   * 【设计意图】冲刺应该几乎总能打断其他动作。
   * 业务层在攻击后摇中收到冲刺输入时，调这个方法确认，
   * 然后直接 `tryStart`——不用等业务硬直结束。
   *
   * 这是"冲刺能取消后摇"这条手感铁律的落地方式。
   */
  canCancel(): boolean {
    return this._state === 'idle' && this._charges > 0;
  }

  /** 中断冲刺（撞墙、被抓取） */
  cancel(): boolean {
    if (this._state !== 'dashing') return false;
    this._state = 'idle';
    this._t = 0;
    this._dx = 0;
    this._dy = 0;
    return true;
  }

  /**
   * 每帧更新
   *
   * 【调用顺序】
   * ```
   * dash.tick(dt);
   * if (dash.active) {
   *   x += dash.deltaX;
   *   y += dash.deltaY;
   * }
   * ```
   * **先 tick 再取 delta**——否则拿到的是上一帧的值。
   */
  tick(dt: number): void {
    this._dx = 0;
    this._dy = 0;

    /**
     * 【为什么用 step 而不是提前 return】
     * _dx/_dy 是每帧输出的位移增量，必须无条件清零。
     * 提前 return 会让上一帧的位移残留 → 角色在冲刺结束后还会自己滑一段。
     * 所以这里只把"时间推进量"归零，其余逻辑照常跑。
     */
    // 【为什么叫 dtStep 而不是 step】本方法后面已有同名的位移变量 step，
    // 重名会让 TS 直接报"无法重复声明块级变量"。
    const dtStep = safeDt(dt) ? dt : 0;

    // 冷却与充能恢复
    if (this._cdLeft > 0) {
      this._cdLeft -= dtStep;
      if (this._cdLeft <= 0) {
        this._cdLeft = 0;
        const max = this._maxCharges;
        if (this._charges < max) {
          this._charges++;
          if (this._charges < max) this._cdLeft = this._cooldown;
        }
      }
    }

    if (this._state !== 'dashing') return;

    const prevT = this._t;
    this._t += dtStep;

    if (this._t >= this._duration) {
      // 收尾：保证总距离精确等于配置值
      const tx = this._startX + this._dirX * this._distance;
      const ty = this._startY + this._dirY * this._distance;
      this._dx = tx - this._curX;
      this._dy = ty - this._curY;
      this._curX = tx;
      this._curY = ty;

      this._state = 'idle';
      this._t = 0;
      return;
    }

    // 位移曲线：对归一化进度积分
    //
    // v(u) = (1-u)^p，u ∈ [0,1]
    // 位移 s(u) = ∫v du 归一化后 = 1 - (1-u)^(p+1)
    // 所以直接算 s 而不是累加 v —— 更精确，且总距离严格等于 distance
    const u1 = clamp(this._t / this._duration, 0, 1);
    const u0 = clamp(prevT / this._duration, 0, 1);

    // 【注意】s(1) 恒等于 1（(1-1)^p = 0），归一化只是为了数值安全
    const norm = this._progressAt(1) || 1;
    const d0 = (this._progressAt(u0) / norm) * this._distance;
    const d1 = (this._progressAt(u1) / norm) * this._distance;

    const step = d1 - d0;
    this._dx = this._dirX * step;
    this._dy = this._dirY * step;
    this._curX += this._dx;
    this._curY += this._dy;
  }

  /**
   * 归一化位移进度：s(u)，u ∈ [0,1]
   *
   * 【基础曲线】`1 - (1-u)^(p+1)`
   * 这是速度 `v(u) = (1-u)^p` 的积分，归一化后总位移为 1。
   *
   * 【末段减速的正确实现】
   * 让衰减指数 p 在最后 `endBrake` 段**平滑增大**（用 k² 保证导数为 0 处连续）。
   *
   * 为什么这样能保证位移单调递增：
   * ```
   * s(u) = 1 - (1-u)^p(u)
   * ds/du = (1-u)^p · [ p/(1-u) − p'·ln(1-u) ]
   * ```
   * `p > 0` 且 `p' ≥ 0`，而 `ln(1-u) < 0`，所以中括号内恒为正 → **ds/du > 0**。
   *
   * 【曾经的 bug】
   * 早期写成 `base × (1 - brake·k·0.5)`，即在末段对位移**打折**。
   * 结果是位移先超调再回缩（冲到 4.26m 又退回 4.03m），
   * 视觉上是终点处的一次抖动。打折永远不是减速的正确实现方式。
   */
  private _progressAt(u: number): number {
    let p = this._falloff + 1;
    const brake = this._endBrake;
    if (brake > 0 && u > 1 - brake) {
      const k = (u - (1 - brake)) / brake;   // 0..1
      p += brake * 12 * k * k;               // k=0 时增量为 0 → 导数连续
    }
    return 1 - Math.pow(1 - u, p);
  }

  /**
   * 冲刺结束后的惯性速度（调用方把它加到角色速度上）
   *
   * 【为什么需要】
   * `exitMomentum` > 0 时，冲刺结束角色还会滑一小段，
   * 移动更连贯。0 则是急停，适合需要精确走位的战斗。
   */
  exitVelocity(): { x: number; y: number } {
    if (this._exitMomentum <= 0) return { x: 0, y: 0 };
    const v = (this._distance / Math.max(this._duration, 1e-6)) * this._exitMomentum;
    return { x: this._dirX * v, y: this._dirY * v };
  }

  /** 重置（角色死亡 / 切场景） */
  reset(): void {
    this._state = 'idle';
    this._t = 0;
    this._dx = 0;
    this._dy = 0;
    this._cdLeft = 0;
    this._charges = this._maxCharges;
  }

  destroy(): void {
    this.reset();
  }
}

/**
 * 残影采样点（配合冲刺做拖尾）
 *
 * 【为什么单独提供】
 * 残影是"让冲刺有速度感"的关键，纯视觉但数据来自逻辑层。
 * 返回的是**采样时刻**，渲染层按这个节奏生成残影节点。
 */
export function shouldSpawnGhost(
  progress: number,
  lastGhostProgress: number,
  interval = 0.15,
): boolean {
  return progress - lastGhostProgress >= interval;
}
