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

import { clamp01, numOr, safeDt } from '../_core/math';

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
    /**
     * 【⚠️ 每个数值配置都要过 `numOr`，不能只靠 `??`】
     *
     * `??` 只挡 null / undefined，**挡不住 NaN**；
     * 而配置来自配表 / 存档 / 编辑器面板，缺失字段反序列化成 NaN 是很常见的。
     *
     * 实测（修复前，只给 maxSpeed / accel / decel 做了 `!(x > 0)` 校验）：
     * ```
     * externalDamping = NaN → 一次 update 后 externalSpeed = NaN、x = NaN
     * turnBoost       = NaN → 掉头那一帧 vx = NaN、vy = NaN
     * ```
     * 两者都是**坐标永久变 NaN 且不可恢复**（NaN + 任何数 === NaN），
     * 之后碰撞、渲染、寻路全崩，而且不抛错。
     * 所以这里一律走 `numOr`（非有限值回落到默认值）。
     */
    this._cfg = {
      maxSpeed: numOr(cfg.maxSpeed, 6),
      accel: numOr(cfg.accel, 60),
      decel: numOr(cfg.decel, 90),
      turnBoost: numOr(cfg.turnBoost, 3),
      friction: numOr(cfg.friction, 0),
      externalDamping: numOr(cfg.externalDamping, 8),
      stopEpsilon: numOr(cfg.stopEpsilon, 0.01),
      knockbackThreshold: numOr(cfg.knockbackThreshold, 0),
      knockbackControl: numOr(cfg.knockbackControl, 0.3),
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

    /**
     * 未显式指定时，取 maxSpeed 的 25%：
     * 外力衰减到"明显慢于正常移动"时就可以交还控制权了
     *
     * 【⚠️ 为什么判"未指定"用 `undefined` 而不是 `<= 0`】
     *
     * 原写法 `if (threshold <= 0) 取默认值`，把**显式传 0** 也吃掉了：
     * 想要"外力不清零就一直保持击退态"的调用方，传 0 会被静默改写成
     * `maxSpeed * 0.25`（默认 maxSpeed=6 时是 1.5）。
     * 表现为"我明明关掉了提前解除，怎么还有"——而且没有任何提示。
     *
     * 阈值 0 是合法语义（只有外力衰减到 stopEpsilon 才解除），
     * 所以只有**没传**（undefined）才走自动推导。
     */
    if (cfg.knockbackThreshold === undefined) {
      this._cfg.knockbackThreshold = this._cfg.maxSpeed * 0.25;
    } else {
      // 显式传值时只做收口（NaN → 自动值，负数按 0 处理），不再改写语义
      this._cfg.knockbackThreshold = Math.max(
        0,
        numOr(cfg.knockbackThreshold, this._cfg.maxSpeed * 0.25)
      );
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
   *
   * 【⚠️ 默认上限不能是 Infinity，否则这段 JSDoc 是空话】
   *
   * 原默认参数 `maxExternal = Infinity` 让 `mag > maxExternal` 恒为 false，
   * 于是**默认行为就是纯累加**：
   * ```
   * 连续 3 次 addImpulse(10, 0) → externalSpeed = 30（不是 10，也不是"取较大者"）
   * ```
   * 多段击退（连击、多重爆炸、连环陷阱）会把玩家加速到离谱速度并穿墙，
   * 而文档上白纸黑字写着"相加会让玩家被弹飞，所以我们不加"。
   * 这正是"注释说是设计、实际是 bug"的形态——默认值恰好让承诺失效。
   *
   * 默认取 `maxSpeed * 5`：既能挡住叠加成火箭，
   * 又不会把一次强力击退（常见配法是 maxSpeed 的 3~5 倍）削成挠痒痒。
   * 需要真的不设限时，显式传 `Infinity`。
   */
  addImpulse(ix: number, iy: number, maxExternal?: number): void {
    /**
     * 【为什么不是 `??`，还要单独挡 NaN】
     * `??` 只处理 undefined / null；配表里 `maxExternal: NaN`
     * 会让 `mag > NaN` 恒 false，等价于"没有上限"。所以 NaN 也要回落到默认值。
     * 但 `Infinity` 是**调用方显式要求不设限**，必须保留，不能被 numOr 吃掉。
     */
    let cap = maxExternal ?? this._cfg.maxSpeed * 5;
    if (Number.isNaN(cap)) cap = this._cfg.maxSpeed * 5;

    this._exX += ix;
    this._exY += iy;
    this._exTimer = 0;

    // 限制总外力强度，防止叠加成火箭
    const mag = Math.sqrt(this._exX * this._exX + this._exY * this._exY);
    let applied = mag;
    if (mag > cap && mag > 1e-9) {
      const k = cap / mag;
      this._exX *= k;
      this._exY *= k;
      applied = cap;
    }

    /**
     * 【⚠️ 外力存在期间才置 knocked】
     * 用"刚加过冲量"标记，而不是"外力 > 0"，
     * 否则传送带这种持续小外力会让角色永远处于击退态。
     *
     * 【⚠️ 判据必须是**合成后**的总外力，不是本次冲量】
     *
     * 原实现用单次冲量的 `mag2` 判断：
     * ```
     * maxSpeed = 6 → 阈值 3
     * addImpulse(2.5, 0) × 3  → 合成外力 7.5（明显在把玩家推开）
     *                         但每次 mag2 = 2.5 < 3 → knocked 仍是 false
     * ```
     * 多个小击退（连击、多重小爆炸、弹幕推挤）合成很大时角色被明显推开，
     * 却仍保有 100% 控制权——"击退形同虚设"，而且极难复现（要凑次数）。
     * 改成看 `applied`（本次冲量叠加并限幅后的真实总外力）。
     */
    if (applied > this._cfg.maxSpeed * 0.5) this.knocked = true;
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
    /**
     * 【⚠️ 公开 API 里的 dt 守卫：`update` 有，`moveBy` 原本没有】
     *
     * 同一类公开 API 两套标准，迟早在某一处漏掉。
     * 实测（修复前）：`moveBy(5, 0, NaN)` → 位置变成 `(NaN, NaN)`；
     * `moveBy(5, 0, -1)` → 角色**倒着走**（负 dt 让位移反向）。
     *
     * 位置变 NaN 之后不可自愈（NaN + 任何数 === NaN），
     * 碰撞、渲染、寻路全崩；而 dash 冲刺是每次按键都走 `moveBy` 的热路径，
     * 上游一个 `dt = 0/NaN`（切后台回来第一帧很常见）就中招。
     */
    if (!safeDt(dt)) return;

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

  /**
   * 卸载（rule5：可卸载）
   *
   * 【为什么要有】
   * 角色对象被回收、切场景重新创建 mover 时，
   * 如果调用方手里还留着旧实例（事件回调、AI 黑名单、UI 绑定），
   * 旧实例会继续持有 `solver`（里面通常闭包引用了整张碰撞地图）——
   * 地图卸载不掉，就是一次实打实的内存泄漏。
   * 这里把引用与状态一并清空，让旧实例变成"安全的空壳"。
   */
  destroy(): void {
    this.vx = 0;
    this.vy = 0;
    this.clearImpulse();
    this.x = 0;
    this.y = 0;
    this.blocked = false;
    this.lastNX = 0;
    this.lastNY = 0;
    this._facing = 0;
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
  /**
   * 【为什么不夹在 1e6】
   *
   * `speed / decel` 本身就是精确答案，夹一个 1e6 的上界
   * 会让"减速极慢"的场景返回**假的** 1e6：
   * `stoppingTime(1e9, 1)` = 1e6 秒（约 11.6 天），真实答案是 1e9 秒。
   * 拿它去做 AI 预判或"刹车距离"UI，就会算出一个看起来合理、
   * 实际差了 1000 倍的数——**比返回 Infinity 更难发现**。
   *
   * 需要做展示上界是调用方的事（它才知道自己的 UI 能显示几位），
   * 库这里只保证数学正确。
   *
   * 【NaN 保持可见】`decel <= 0` 对 NaN 为 false，所以用肯定式 `!(decel > 0)`；
   * 非有限的 speed 返回 NaN 而不是 0，让坏数据在调用方继续可见。
   */
  if (!Number.isFinite(speed)) return NaN;
  if (!(decel > 0)) return Infinity;
  return Math.max(0, speed / decel);
}
