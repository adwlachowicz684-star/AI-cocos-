/**
 * mover/CharacterMover.ts —— 角色移动控制器
 *
 * 【它补的是什么缺口】
 *
 * 库里已经有了：
 * - `joystick-mover/JoystickCore` —— 摇杆 → 方向向量
 * - `dash/DashController` —— 冲刺（一次性位移）
 *
 * 但**从"方向"到"角色真的动起来"这一段是空的**。
 * 直接写 `pos += dir * speed * dt` 的角色，玩起来像贴纸在冰上滑：
 *
 * | 缺失 | 玩家感受 |
 * |---|---|
 * | 加速度 | 按下瞬间就到最高速，"贴纸在滑" |
 * | 减速与加速分开 | 要么太黏（停不下来）要么太滑（刹不住） |
 * | 转身插值 | 掉头是瞬间的，角色没有"重量" |
 * | 撞墙投影 | 斜着推摇杆撞墙，角色**完全停住** |
 * | 击退叠加 | 被打时输入仍然全额生效，击退形同虚设 |
 *
 * 这些全都是"不抛异常、只让手感变差"的问题——
 * 和前几批一样，只能靠测试把方向锁住。
 *
 * 【设计：零依赖】
 *
 * 碰撞解算通过 `IMoveSolver` 接口注入。
 * 默认给一个 `NullSolver`（不做碰撞），
 * 需要时把 `collision/Collision.ts` 的 `moveAndSlide` 包一层传进来：
 *
 * ```typescript
 * const solver: IMoveSolver = {
 *   move: (x, y, dx, dy) => moveAndSlide(x, y, radius, dx, dy, walls),
 * };
 * const m = new CharacterMover({ solver, ... });
 * ```
 */

import { clamp, clamp01, safeDt } from '../_core/math';

// ==================== 碰撞解算接口 ====================

/**
 * 移动解算器接口
 *
 * 【为什么用接口而不是直接依赖 collision 模块】
 * 铁律：插件之间禁止横向依赖。
 * 而且不同项目的碰撞方案差异极大（网格、tilemap、物理引擎、无碰撞），
 * 写死一种会让这个模块在别的项目里直接报废。
 */
export interface IMoveSolver {
  /**
   * 尝试从 (x, y) 移动 (dx, dy)
   * @returns 最终位置与接触法线（法线指向"被挡住"的反方向）
   */
  move(x: number, y: number, dx: number, dy: number): MoveOutcome;
}

export interface MoveOutcome {
  x: number;
  y: number;
  /** 是否撞到了东西 */
  collided: boolean;
  /** 接触法线（已归一化；未碰撞时为 0,0） */
  nx: number;
  ny: number;
}

/** 不做任何碰撞的解算器（默认） */
export const NullSolver: IMoveSolver = {
  move(x, y, dx, dy) {
    return { x: x + dx, y: y + dy, collided: false, nx: 0, ny: 0 };
  },
};

// ==================== 配置 ====================

export interface MoverConfig {
  /** 最大移动速度（单位/秒） */
  maxSpeed?: number;
  /** 加速度（单位/秒²）—— 从静止到最高速需要 maxSpeed/accel 秒 */
  accel?: number;
  /**
   * 减速度（单位/秒²）—— 松开输入时的减速
   *
   * 【⚠️ 不要和 accel 用同一个值】
   * 相同的话，要么"起步肉、刹车也肉"，要么"起步灵、停不住"。
   * 经验值：decel ≈ accel × 1.5 ~ 2.5，让刹车比起步更干脆。
   */
  decel?: number;
  /**
   * 转身速度倍率
   *
   * 输入方向与当前速度**反向**时，用 accel × turnBoost 加速。
   * 1 = 不特殊处理（掉头和起步一样肉）
   * 3~5 = 掉头明显更利落，这是"操作跟手"的关键
   */
  turnBoost?: number;
  /** 摩擦（无输入且无外力时的额外减速，单位/秒²） */
  friction?: number;
  /**
   * 外力衰减（每秒衰减到剩余比例的 e 倍）
   *
   * 【⚠️ 外力必须衰减】
   * 不衰减的话，连续被击退两次就叠成火箭——
   * 玩家会觉得自己被弹飞到地图外，而这不会有任何报错。
   */
  externalDamping?: number;
  /**
   * 速度低于此值时直接归零
   *
   * 【为什么需要】
   * 指数衰减在数学上永远到不了 0，
   * 角色会以 0.0001 的速度永远漂移，
   * 表现为"站定后角色还在微微滑动"。
   */
  stopEpsilon?: number;
  /**
   * 击退态解除阈值（外力小于此值就恢复控制）
   *
   * 【⚠️ 为什么不能复用 stopEpsilon】
   *
   * 外力按指数衰减，从 30 衰减到 0.01 需要约 1.3 秒。
   * 但外力剩 0.07 时，角色每秒只移动 0.07 像素——完全不可感知，
   * 而玩家的**控制权却还被锁着**。
   * 表现为"被击退之后有 1 秒多操作不灵"，玩家会觉得角色不听话。
   *
   * 数值归零是数学问题（用 stopEpsilon），
   * 解除击退是体感问题（用这个阈值，按 maxSpeed 的百分比算）。
   * 两者混用一个常量，就会多锁将近一秒的操作。
   */
  knockbackThreshold?: number;
  /**
   * 击退期间玩家输入的权重（0~1）
   *
   * 0 = 击退期间完全不能控制（适合硬直）
   * 0.3 = 能稍微修正方向（大多数动作游戏的选择）
   * 1 = 击退期间照常控制（等于击退没效果）
   */
  knockbackControl?: number;
  /** 碰撞解算器 */
  solver?: IMoveSolver;
  /** 初始位置 */
  x?: number;
  y?: number;
}

// ==================== 主体 ====================

export class CharacterMover {
  // --- 位置与速度 ---
  x: number;
  y: number;
  /** 内部速度（含外力），单位/秒 */
  vx = 0;
  vy = 0;

  // --- 外力（击退、传送带、风力）---
  private _exX = 0;
  private _exY = 0;
  private _exTimer = 0;

  // --- 状态 ---
  /** 是否正在被击退（供动画/输入系统调用） */
  knocked = false;
  /** 上一帧是否撞墙 */
  blocked = false;
  /** 上一帧的接触法线 */
  lastNX = 0;
  lastNY = 0;

  private readonly _cfg: Required<Omit<MoverConfig, 'solver' | 'x' | 'y'>> & { solver: IMoveSolver };

  constructor(cfg: MoverConfig = {}) {
    this._cfg = {
      maxSpeed: cfg.maxSpeed ?? 6,
      accel: cfg.accel ?? 60,
      decel: cfg.decel ?? 90,
      turnBoost: cfg.turnBoost ?? 3,
      friction: cfg.friction ?? 0,
      externalDamping: cfg.externalDamping ?? 8,
      stopEpsilon: cfg.stopEpsilon ?? 0.01,
      knockbackThreshold: cfg.knockbackThreshold ?? 0,
      knockbackControl: cfg.knockbackControl ?? 0.3,
      solver: cfg.solver ?? NullSolver,
    };
    this.x = cfg.x ?? 0;
    this.y = cfg.y ?? 0;

    // 【为什么构造时就校验】
    // 这些是配置错误，不是运行时的意外。
    // 等到玩家发现"角色不动了"再去查，成本是几十倍。
    if (!(this._cfg.maxSpeed > 0)) {
      throw new Error(`maxSpeed 必须为正，收到 ${this._cfg.maxSpeed}`);
    }
    if (!(this._cfg.accel > 0)) {
      throw new Error(`accel 必须为正，收到 ${this._cfg.accel}`);
    }
    if (!(this._cfg.decel > 0)) {
      throw new Error(`decel 必须为正，收到 ${this._cfg.decel}`);
    }

    // 未显式指定时，取 maxSpeed 的 25%：
    // 外力衰减到"明显慢于正常移动"时就可以交还控制权了
    if (this._cfg.knockbackThreshold <= 0) {
      this._cfg.knockbackThreshold = this._cfg.maxSpeed * 0.25;
    }
  }

  // ==================== 输入 ====================

  /**
   * 施加外力（击退、爆炸推力、传送带）
   *
   * 【⚠️ 这里是"覆盖"还是"叠加"？】
   *
   * 选的是**按强度取较大者**，不是简单相加：
   * - 相加：两次小击退叠成大击退，玩家被弹飞
   * - 取较大：连续挨打时击退强度可控
   *
   * 但这有个前提——两次击退的**方向**要一致时才该取较大。
   * 方向相反的话（左边一下右边一下）应该抵消，
   * 所以实现里做的是"向量合成后限制总强度"。
   */
  addImpulse(ix: number, iy: number, maxExternal = Infinity): void {
    this._exX += ix;
    this._exY += iy;
    this._exTimer = 0;

    // 限制总外力强度，防止叠加成火箭
    const mag = Math.sqrt(this._exX * this._exX + this._exY * this._exY);
    if (mag > maxExternal && mag > 1e-9) {
      const k = maxExternal / mag;
      this._exX *= k;
      this._exY *= k;
    }

    // 【⚠️ 外力存在期间才置 knocked】
    // 用"刚加过冲量"标记，而不是"外力 > 0"，
    // 否则传送带这种持续小外力会让角色永远处于击退态。
    const mag2 = Math.sqrt(ix * ix + iy * iy);
    if (mag2 > this._cfg.maxSpeed * 0.5) this.knocked = true;
  }

  /** 清空外力（复位、切场景时用） */
  clearImpulse(): void {
    this._exX = 0;
    this._exY = 0;
    this._exTimer = 0;
    this.knocked = false;
  }

  /** 外力大小（诊断用） */
  get externalSpeed(): number {
    return Math.sqrt(this._exX * this._exX + this._exY * this._exY);
  }

  /** 是否有明显外力在作用 */
  get hasExternal(): boolean {
    return this.externalSpeed > this._cfg.stopEpsilon;
  }

  /** 当前速度大小（不含外力） */
  get speed(): number {
    return Math.sqrt(this.vx * this.vx + this.vy * this.vy);
  }

  /** 实际位移速度（含外力），即本帧会移动多快 */
  get totalSpeed(): number {
    const tx = this.vx + this._exX;
    const ty = this.vy + this._exY;
    return Math.sqrt(tx * tx + ty * ty);
  }

  /** 朝向（弧度；静止时保持上一次朝向，见 _facing） */
  private _facing = 0;
  get facing(): number {
    return this._facing;
  }

  // ==================== 主循环 ====================

  /**
   * 每帧推进
   *
   * @param dt 秒（⚠️ 用**缩放**时间，暂停时角色该停）
   * @param dirX 输入方向的 X（不必归一化，内部会归一化）
   * @param dirY 输入方向的 Y
   *
   * 【⚠️ 输入会在这里被归一化】
   * 摇杆输出已经是单位向量，但键盘的 (1,1) 长度是 1.414——
   * 不归一化的话**斜着走快 41%**，这是最经典的手感 bug，
   * 而且玩家只会说"感觉有点飘"，说不出哪里不对。
   */
  update(dt: number, dirX = 0, dirY = 0): void {
    /**
     * 【为什么不能用 `dt <= 0`】
     *
     * `NaN <= 0` 是 `false` → NaN 直接穿透。
     * 后果是**角色坐标永久变 NaN**：
     *
     * ```
     * update(NaN)  →  x = NaN
     * 再正常 update 100 次  →  x 仍然是 NaN（NaN + 任何数 === NaN）
     * ```
     *
     * 角色从游戏中消失，所有碰撞/距离/拾取判定恒为 false，
     * **不抛错、不告警、不可自愈**。这是全库后果最直观的一处。
     *
     * Infinity 同理（速度变 Infinity，位置爆掉）。
     */
    if (!safeDt(dt)) return;

    // ① 归一化输入
    const inLen = Math.sqrt(dirX * dirX + dirY * dirY);
    let ndx = 0;
    let ndy = 0;
    if (inLen > 1e-6) {
      // 【⚠️ 用 min(1, ...) 而不是直接除】
      // 摇杆推到边缘时长度可能略大于 1（浮点误差），
      // 直接除没问题；但如果上游传来的是"未归一化的模拟量"，
      // 长度 0.3 表示"轻轻推"，除以长度会把它放大成全速——
      // 模拟量（手柄）必须保留强度，数字量（键盘）才归一化。
      // 这里选择：长度 > 1 才归一化到 1，小于 1 保留原样。
      const k = inLen > 1 ? 1 / inLen : 1;
      ndx = dirX * k;
      ndy = dirY * k;
    }

    const hasInput = inLen > 1e-6;

    // ② 击退期间降低输入权重
    const control = this.knocked ? this._cfg.knockbackControl : 1;
    const effDX = ndx * control;
    const effDY = ndy * control;

    // ③ 朝期望速度加速（或减速）
    const targetVX = effDX * this._cfg.maxSpeed;
    const targetVY = effDY * this._cfg.maxSpeed;

    if (hasInput && control > 0) {
      // 判断是否在"反向"（掉头）
      const curLen = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      let isReversing = false;
      if (curLen > this._cfg.stopEpsilon) {
        const dot = (this.vx * effDX + this.vy * effDY) / curLen;
        isReversing = dot < -0.1;
      }

      // 【⚠️ 掉头用更大的加速度】
      // 不特殊处理的话，从全速向左改成向右要先减速到 0 再加速，
      // 中间有个明显的"卡顿"，玩家会觉得角色不听话。
      const a = this._cfg.accel * (isReversing ? this._cfg.turnBoost : 1) * dt;
      this._approach(targetVX, targetVY, a);
    } else {
      // 无输入：先减到 0，再叠加摩擦
      const d = this._cfg.decel * dt;
      this._approach(0, 0, d);
      if (this._cfg.friction > 0) {
        const f = this._cfg.friction * dt;
        const sp = this.speed;
        if (sp > this._cfg.stopEpsilon) {
          const k = Math.max(0, sp - f) / sp;
          this.vx *= k;
          this.vy *= k;
        }
      }
    }

    // ④ 极低速归零（防永远漂移）
    if (!hasInput && this.speed < this._cfg.stopEpsilon) {
      this.vx = 0;
      this.vy = 0;
    }

    // ⑤ 外力衰减（指数）
    if (this.externalSpeed > this._cfg.stopEpsilon) {
      const k = Math.exp(-this._cfg.externalDamping * dt);
      this._exX *= k;
      this._exY *= k;
      this._exTimer += dt;
      // 数值归零用 stopEpsilon（数学问题）
      if (this.externalSpeed < this._cfg.stopEpsilon) {
        this._exX = 0;
        this._exY = 0;
        this.knocked = false;
      } else if (this.externalSpeed < this._cfg.knockbackThreshold) {
        // 体感上已经"不再被击退"了 → 立刻交还控制权（体感问题）
        // 外力本身继续自然衰减，不清零
        this.knocked = false;
      }
    } else {
      this._exX = 0;
      this._exY = 0;
      this.knocked = false;
    }

    // ⑥ 位移 + 碰撞
    const totalX = this.vx + this._exX;
    const totalY = this.vy + this._exY;
    const out = this._cfg.solver.move(this.x, this.y, totalX * dt, totalY * dt);

    this.x = out.x;
    this.y = out.y;
    this.blocked = out.collided;
    this.lastNX = out.nx;
    this.lastNY = out.ny;

    // 【⚠️ ⑦ 撞墙后必须把速度投影掉】
    //
    // 不投影的话会发生什么：
    // 玩家一直推着摇杆顶墙，速度在每个 update 里持续朝目标加速，
    // 由于被墙挡住，位移是 0，但**速度值一直在涨**。
    // 一旦绕过墙角，累积的高速让角色"嗖"地弹射出去。
    //
    // 这是"贴墙走然后突然飞出去"的根本原因，
    // 而且因为它只在特定几何下发生，极难复现。
    if (out.collided && (out.nx !== 0 || out.ny !== 0)) {
      const dot = this.vx * out.nx + this.vy * out.ny;
      // 只削减"朝着墙"的分量（dot < 0 表示速度与法线反向，即撞向墙）
      if (dot < 0) {
        this.vx -= out.nx * dot;
        this.vy -= out.ny * dot;
      }
      // 外力也同样投影，否则击退会把角色按在墙上持续施力
      const edot = this._exX * out.nx + this._exY * out.ny;
      if (edot < 0) {
        this._exX -= out.nx * edot;
        this._exY -= out.ny * edot;
      }
    }

    // ⑧ 更新朝向（只在有明显速度时更新，避免抖动）
    const ts = this.totalSpeed;
    if (ts > this._cfg.stopEpsilon * 2) {
      this._facing = Math.atan2(totalY, totalX);
    }
  }

  /** 以固定加速度朝目标速度逼近（不会过冲） */
  private _approach(tvx: number, tvy: number, maxDelta: number): void {
    const dx = tvx - this.vx;
    const dy = tvy - this.vy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= maxDelta || d < 1e-12) {
      // 【⚠️ 这里直接赋值，不是"朝目标走 maxDelta"】
      // 后者在 d 略大于 maxDelta 时会产生振荡（来回过冲），
      // 表现为接近最高速时速度在抖。
      this.vx = tvx;
      this.vy = tvy;
      return;
    }
    this.vx += (dx / d) * maxDelta;
    this.vy += (dy / d) * maxDelta;
  }

  // ==================== 控制 ====================

  /** 瞬移（传送、切场景） */
  teleport(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.clearImpulse();
  }

  /** 立即停止（不清除位置） */
  stop(): void {
    this.vx = 0;
    this.vy = 0;
    this.clearImpulse();
  }

  /** 直接接管速度（冲刺、钩索等，绕过加速度） */
  setVelocity(vx: number, vy: number): void {
    this.vx = vx;
    this.vy = vy;
  }

  /**
   * 与 DashController 配合：冲刺期间绕过速度限制
   *
   * 【为什么需要这个】
   * 冲刺的速度通常远超 maxSpeed。
   * 如果走常规 update，加速度机制会在冲刺结束的瞬间
   * 把速度"拉回" maxSpeed——玩家感觉冲刺被硬生生截断。
   *
   * 正确做法：冲刺期间由 DashController 提供速度，
   * mover 只负责位移与碰撞，不干预速度。
   */
  moveBy(vx: number, vy: number, dt: number): void {
    const out = this._cfg.solver.move(this.x, this.y, vx * dt, vy * dt);
    this.x = out.x;
    this.y = out.y;
    this.blocked = out.collided;
    this.lastNX = out.nx;
    this.lastNY = out.ny;

    if (out.collided && (out.nx !== 0 || out.ny !== 0)) {
      const dot = vx * out.nx + vy * out.ny;
      if (dot < 0) {
        this.vx = vx - out.nx * dot;
        this.vy = vy - out.ny * dot;
      } else {
        this.vx = vx;
        this.vy = vy;
      }
    } else {
      this.vx = vx;
      this.vy = vy;
    }

    const ts = Math.sqrt(vx * vx + vy * vy);
    if (ts > this._cfg.stopEpsilon * 2) {
      this._facing = Math.atan2(vy, vx);
    }
  }

  // ==================== 诊断 ====================

  describe(): string {
    return [
      `位置 (${this.x.toFixed(2)}, ${this.y.toFixed(2)})`,
      `速度 ${this.speed.toFixed(2)} / 上限 ${this._cfg.maxSpeed}`,
      `外力 ${this.externalSpeed.toFixed(2)}${this.knocked ? ' [击退中]' : ''}`,
      `朝向 ${(this._facing * 180 / Math.PI).toFixed(0)}°`,
      `撞墙 ${this.blocked ? `是，法线 (${this.lastNX.toFixed(2)}, ${this.lastNY.toFixed(2)})` : '否'}`,
    ].join('\n');
  }
}

// ==================== 预设 ====================

/** 几种典型手感预设 */
export const MoverPresets = {
  /**
   * 灵敏（俯视角射击、快节奏动作）
   * 起步快、刹车快、掉头极快——代价是角色"轻"
   */
  snappy: (): MoverConfig => ({
    maxSpeed: 8, accel: 120, decel: 160, turnBoost: 5, knockbackControl: 0.35,
  }),

  /**
   * 有重量感（ARPG、魂类）
   * 起步与刹车都慢，掉头有明显惯性
   */
  heavy: (): MoverConfig => ({
    maxSpeed: 5, accel: 25, decel: 35, turnBoost: 1.5, friction: 2, knockbackControl: 0.15,
  }),

  /**
   * 冰面（低摩擦）
   * 加速慢、几乎不减速，靠摩擦自然停下
   */
  icy: (): MoverConfig => ({
    maxSpeed: 7, accel: 15, decel: 4, turnBoost: 1.2, friction: 1.5, knockbackControl: 0.6,
  }),

  /**
   * 平台跳跃（横版）
   * 空中控制力弱，地面响应快
   */
  platformer: (): MoverConfig => ({
    maxSpeed: 7, accel: 60, decel: 100, turnBoost: 4, knockbackControl: 0.2,
  }),
} as const;

// ==================== 工具 ====================

/**
 * 把速度限制在 maxSpeed 内（供外部接管速度后调用）
 *
 * 【为什么单独提供】
 * `moveBy` 允许超速（那是冲刺要的），
 * 但冲刺结束后需要一把"收回到正常速度"的钳子。
 * 注意这里是**按比例缩放**而不是分别 clamp——
 * 分别 clamp 会把斜向速度变成方形，方向就歪了。
 */
export function clampSpeed(vx: number, vy: number, max: number): [number, number] {
  const sp = Math.sqrt(vx * vx + vy * vy);
  if (sp <= max || sp < 1e-9) return [vx, vy];
  const k = max / sp;
  return [vx * k, vy * k];
}

/** 速度朝目标方向插值（用于"进入/离开载具"这类需要过渡的场景） */
export function lerpVelocity(
  vx: number, vy: number, tvx: number, tvy: number, t: number
): [number, number] {
  const k = clamp01(t);
  return [vx + (tvx - vx) * k, vy + (tvy - vy) * k];
}

/**
 * 计算"从当前速度到静止"还需要多久（秒）
 *
 * 用途：AI 预判、UI 显示刹车距离。
 */
export function stoppingTime(speed: number, decel: number): number {
  if (decel <= 0) return Infinity;
  return clamp(speed / decel, 0, 1e6);
}
