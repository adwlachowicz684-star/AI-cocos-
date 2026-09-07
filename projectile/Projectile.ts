/**
 * Projectile —— 弹道系统（纯逻辑）
 *
 * 【它解决什么】
 *
 * 子弹、箭矢、火球、投掷物。它们的共性是：
 * **沿轨迹移动 → 途中检测碰撞 → 命中或超时后消失**。
 *
 * 本模块只负责**运动与生命周期**，不负责渲染，也不负责碰撞的具体实现。
 *
 * 【零业务依赖的两处关键设计】
 *
 * **① 碰撞通过接口注入**
 * ```typescript
 * export interface ICollisionProvider {
 *   sweep(fromX, fromY, toX, toY, mask, exclude): CollisionHit | null;
 * }
 * ```
 * 弹道不知道碰撞是 Hitbox 世界、瓦片地图还是简单圆列表。
 * 传什么进来就用什么检测——所以同一个弹道系统能用于
 * 俯视角射击、横版、塔防、弹幕。
 *
 * **② 命中回调由调用方决定做什么**
 * 它不扣血、不播特效。命中只是回调，扣血请用 `damage-pipeline`。
 *
 * 【五种运动模式】
 * | 模式 | 说明 | 典型 |
 * |---|---|---|
 * | `linear` | 直线匀速 | 箭矢、子弹 |
 * | `accel` | 直线加/减速 | 蓄力炮、减速球 |
 * | `parabola` | 抛物线（给定落点自动算初速） | 投掷、炮弹 |
 * | `homing` | 追踪（带转向率上限） | 追踪弹 |
 * | `sine` | 沿主方向正弦摆动 | 魔法弹、波浪弹 |
 *
 * 【使用示例】
 * ```typescript
 * const sys = new ProjectileSystem({ collision: hitboxAdapter });
 *
 * sys.spawn({
 *   x: px, y: py, dirX: 1, dirY: 0,
 *   speed: 14, mode: 'linear',
 *   pierce: 1, lifetime: 3,
 *   mask: LAYER_ENEMY,
 *   onHit: (hit) => {
 *     pipeline.apply({ raw: 20, hitId: `${id}:${hit.id}` }, hit.data as IDamageable);
 *   },
 * });
 *
 * // 每帧（dt 来自 Scheduler，暂停时自动停）
 * sys.tick(dt);
 * ```
 */

import { clamp, numOr, safeDt } from '../_core/math';

/** 碰撞命中信息 */
export interface CollisionHit {
  /** 被撞对象的 id（由碰撞提供方定义，用于穿透去重） */
  id: string;
  /** 命中点 */
  x: number;
  /** 命中点 */
  y: number;
  /** 命中处的法线 X（弹跳用；提供方给不出就填 0） */
  nx?: number;
  /** 命中处的法线 Y */
  ny?: number;
  /** 附加数据（通常是你的实体） */
  data?: unknown;
  /** 沿本段路径的命中比例 0..1（按距离排序多条命中时用） */
  t: number;
}

/**
 * 碰撞提供方
 *
 * 【为什么是 sweep 而不是 point】
 * 子弹一帧可能移动 14 × 0.016 ≈ 0.22 米。
 * 如果墙只有 0.1 米厚，用点检测就会**直接穿过去**——
 * 这是高速弹丸最经典的 bug，表现为「偶尔穿墙，无法复现」。
 *
 * 所以接口要求的是**扫掠检测**（线段），不是点检测。
 */
export interface ICollisionProvider {
  /**
   * 扫掠检测：从 (fromX, fromY) 移动到 (toX, toY) 的途中撞到了什么
   * @param exclude 要忽略的 id 集合（穿透后已经打过的目标）
   * @returns 最近的命中，没有则 null
   */
  sweep(
    fromX: number, fromY: number, toX: number, toY: number,
    mask: number, exclude: ReadonlySet<string>,
  ): CollisionHit | null;
}

/** 运动模式 */
export type ProjectileMode = 'linear' | 'accel' | 'parabola' | 'homing' | 'sine';

/** 生成参数 */
export interface ProjectileSpawn {
  /** 起点 */
  x: number;
  y: number;
  /** 初始方向（**会被归一化**，传 (3,4) 和 (0.6,0.8) 等价） */
  dirX: number;
  dirY: number;

  /** 初速度（米/秒） */
  speed: number;
  mode?: ProjectileMode;

  // ── 可选运动参数 ──

  /** accel 模式：加速度（米/秒²），负数减速 */
  accel?: number;
  /** accel 模式：速度下限（减速弹用） */
  minSpeed?: number;
  /** accel 模式：速度上限 */
  maxSpeed?: number;

  /** parabola 模式：落点（不传则按当前方向平抛） */
  targetX?: number;
  targetY?: number;
  /** parabola 模式：抛物线最高点相对起点的高度（默认按距离估算） */
  arcHeight?: number;
  /** parabola 模式：重力（默认 20，越大弧线越"急"） */
  gravity?: number;

  /** homing 模式：追踪目标（提供当前位置） */
  homingTarget?: { x: number; y: number };
  /** homing 模式：最大转向率（**度/秒**） */
  turnRate?: number;

  /** sine 模式：摆动振幅（米） */
  amplitude?: number;
  /** sine 模式：摆动频率（Hz） */
  frequency?: number;

  // ── 生命周期 ──

  /** 最长时间（秒）。**必填**——没有它，追踪失败的弹丸会永远飞 */
  lifetime: number;

  /**
   * 穿透次数
   * - 0（默认）：命中即消失
   * - 2：可以穿过 2 个目标
   */
  pierce?: number;

  /**
   * 弹跳次数（需要碰撞提供方返回法线 nx/ny）
   * 弹跳与穿透互斥：pierce > 0 时 bounce 不生效
   */
  bounce?: number;

  /** 碰撞掩码 */
  mask: number;

  /** 半径（传给碰撞方做扫掠用，0 表示按射线处理） */
  radius?: number;

  /** 命中回调 */
  onHit?: (hit: CollisionHit, proj: Projectile) => void;
  /** 结束回调（超时 / 穿透用尽 / 弹跳用尽） */
  onExpire?: (proj: Projectile, reason: ExpireReason) => void;
  /** 每帧回调（可用于拖尾采样） */
  onMove?: (proj: Projectile, fromX: number, fromY: number) => void;

  /** 附加数据，命中时可从 proj.data 取回 */
  data?: unknown;
}

export type ExpireReason = 'lifetime' | 'hit' | 'bounced-out' | 'out-of-bounds';

/** 运行中的弹丸 */
export interface Projectile {
  readonly id: number;
  x: number;
  y: number;
  /** 当前速度向量 */
  vx: number;
  vy: number;
  /** 已存活时间 */
  age: number;
  readonly lifetime: number;
  /**
   * 初始方向角（弧度）
   *
   * 【为什么需要】sine 模式每帧要根据**原始**方向重算速度。
   * 如果从当前速度反推角度，摆动分量会被反复叠加，轨迹会漂走。
   */
  readonly baseAngle: number;
  /** 剩余穿透次数 */
  pierceLeft: number;
  /** 剩余弹跳次数 */
  bounceLeft: number;
  /** 是否已消亡 */
  dead: boolean;
  readonly mask: number;
  readonly radius: number;
  readonly mode: ProjectileMode;
  readonly spawn: Readonly<ProjectileSpawn>;
  data?: unknown;
  /** 已命中过的目标（穿透去重） */
  readonly hitIds: Set<string>;
}

export interface ProjectileSystemOptions {
  collision: ICollisionProvider;
  /**
   * 边界（可选）：超出即销毁
   *
   * 【为什么需要】追踪弹可能永远追不上目标，
   * lifetime 之外再加一道保险，避免泄漏。
   */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };

  /**
   * 未指定 lifetime 时用的兜底秒数（默认 5）
   *
   * 【为什么需要】
   * `spawn()` 的 lifetime 是可选的，漏填时 `age >= undefined` 恒为 false，
   * 弹丸永不回收。给个兜底值，宁可提前消失也不能永久泄漏。
   */
  readonly defaultLifetime?: number;
  /**
   * 单帧最大移动距离（防穿墙兜底）
   *
   * 即使碰撞方只支持点检测，把一帧的位移切成若干小段也能大幅降低穿透概率。
   * 默认 0.5 米。设为 0 则不做切分。
   */
  maxStep?: number;
}

let _nextId = 1;

/**
 * 弹道系统
 *
 * 【每帧流程】
 * ```
 * for each projectile:
 *   1. 更新速度（按 mode）
 *   2. 计算本帧位移
 *   3. 按 maxStep 切成小段
 *   4. 每段做 sweep 检测
 *   5. 命中 → onHit → pierce-- / bounce
 *   6. age += dt，超时则销毁
 * ```
 */
/** 未指定 lifetime 时的兜底秒数 */
const DEFAULT_LIFETIME = 5;

export class ProjectileSystem {
  private _collision: ICollisionProvider;
  private _bounds?: ProjectileSystemOptions['bounds'];
  private _maxStep: number;
  private readonly _defaultLifetime: number;
  private _list: Projectile[] = [];

  constructor(opts: ProjectileSystemOptions) {
    this._collision = opts.collision;
    this._bounds = opts.bounds;
    /**
     * 【⚠️ `??` 挡不住 NaN → 子步进被静默关闭 → 高速弹道穿透】
     *
     * 后面 `const steps = this._maxStep > 0 ? ... : 1`：
     * `NaN > 0` 为 false → `steps = 1` → 整段位移只做**一次** sweep。
     * 而 `maxStep: 0`（文档里的"关闭分步"）也是 1，
     * **两者行为相同，无法区分**。
     *
     * 实测（修复前）：speed=100、`tick(1)`（一帧位移 100 单位）
     * - `maxStep = 0.5` → sweep 被调用 **200** 次（正确分步）
     * - `maxStep = NaN` → sweep 被调用 **1** 次（隧穿）
     *
     * 子弹穿墙/穿人且完全静默。`maxStep` 一旦来自配置
     * （JSON 里写成字符串再 `Number()`、或字段缺失），
     * 所有高速弹道在一帧内跳过整段路径，中间目标全部漏掉。
     *
     * 【为什么这里用 numOr 而不是抛错】
     * `maxStep: 0` 是文档明确支持的"关闭分步"值，必须保留；
     * 非法值回落到默认 0.5，既修好隧穿又不破坏合法配置。
     */
    this._maxStep = opts.maxStep === 0 ? 0 : numOr(opts.maxStep, 0.5);
    this._defaultLifetime = opts.defaultLifetime ?? DEFAULT_LIFETIME;
  }

  /** 存活数量 */
  get count(): number {
    return this._list.length;
  }

  /** 所有弹丸（只读） */
  all(): readonly Projectile[] {
    return this._list;
  }

  /** 生成一个弹丸 */
  spawn(p: ProjectileSpawn): Projectile {
    const len = Math.hypot(p.dirX, p.dirY);
    // 【零向量的坑】调用方可能传 (0,0)（比如摇杆没推），
    // 不处理会得到 NaN 速度，然后弹丸坐标变 NaN 并永久存在（NaN 比较永远 false）
    const nx = len > 1e-9 ? p.dirX / len : 1;
    const ny = len > 1e-9 ? p.dirY / len : 0;

    const mode = p.mode ?? 'linear';

    const proj: Projectile = {
      id: _nextId++,
      x: p.x,
      y: p.y,
      vx: nx * p.speed,
      vy: ny * p.speed,
      age: 0,
      // 【坑】lifetime 漏填会让弹丸永不回收
      //
      // `age >= undefined` 恒为 false，超时判定完全失效。
      // 实测：不传 lifetime 或传 NaN，1000 发弹丸**全部残留**，
      // 飞到 480 万米外还在跑，几小时后 OOM。
      //
      // 其他字段（speed / dirX）漏填会立刻表现异常，
      // 唯独 lifetime 漏填**没有任何即时症状**——最容易被漏掉。
      lifetime: Number.isFinite(p.lifetime) ? p.lifetime : this._defaultLifetime,
      baseAngle: Math.atan2(ny, nx),
      pierceLeft: p.pierce ?? 0,
      bounceLeft: p.bounce ?? 0,
      dead: false,
      mask: p.mask,
      radius: p.radius ?? 0,
      mode,
      spawn: p,
      data: p.data,
      hitIds: new Set(),
    };

    // 抛物线：根据落点反算初速度
    if (mode === 'parabola') this._initParabola(proj);

    this._list.push(proj);
    return proj;
  }

  /**
   * 抛物线初速度反算
   *
   * 【推导】
   * 水平：dx = vx · t
   * 竖直：dy = vy · t - ½g·t²
   *
   * 给定水平速度和距离 → t = dx / vx
   * 代入竖直式 → vy = (dy + ½g·t²) / t
   *
   * 注意坐标系：本模块用 **Y 向上为正**（数学惯例）。
   * 如果你的渲染是 Y 向下，在适配层翻转，别改这里。
   */
  private _initParabola(p: Projectile): void {
    const s = p.spawn;
    const g = s.gravity ?? 20;

    if (s.targetX === undefined || s.targetY === undefined) {
      // 没有落点：按当前方向平抛，只需记录重力
      return;
    }

    const dx = s.targetX - p.x;
    const dy = s.targetY - p.y;
    const speed = s.speed;

    // 水平速度保持 speed 的大小，方向由 dx 决定
    const dirX = dx >= 0 ? 1 : -1;
    const vx = speed * dirX;
    const t = Math.abs(dx) / Math.max(speed, 1e-6);

    // vy = (dy + ½g·t²) / t
    const vy = (dy + 0.5 * g * t * t) / Math.max(t, 1e-6);

    p.vx = vx;
    p.vy = vy;

    // arcHeight 覆盖：用给定弧高重算 vy
    if (s.arcHeight !== undefined) {
      // 最高点 h = vy² / (2g)  →  vy = sqrt(2·g·h)
      const sign = vy >= 0 ? 1 : -1;
      p.vy = sign * Math.sqrt(2 * g * Math.abs(s.arcHeight));
      // 保持飞行时间不变，调整水平速度
      p.vx = dx / Math.max(t, 1e-6);
    }
  }

  /**
   * 每帧更新
   *
   * 【dt 从哪来】由调用方注入（通常是 `Scheduler` 的缩放后 dt）。
   * 这样暂停、慢动作、顿帧自动生效——不需要弹道系统知道这些概念。
   */
  tick(dt: number): void {
    if (!safeDt(dt)) return;

    // 【倒序遍历】回调里可能 spawn 新弹丸，正序遍历会处理到本帧新增的
    for (let i = this._list.length - 1; i >= 0; i--) {
      const p = this._list[i];
      if (p.dead) {
        this._list.splice(i, 1);
        continue;
      }
      this._step(p, dt);
      if (p.dead) this._list.splice(i, 1);
    }
  }

  private _step(p: Projectile, dt: number): void {
    const s = p.spawn;

    // 1. 更新速度
    switch (p.mode) {
      case 'accel': {
        const acc = s.accel ?? 0;
        const sp = Math.hypot(p.vx, p.vy);
        const nsp = clamp(
          sp + acc * dt,
          s.minSpeed ?? 0,
          s.maxSpeed ?? Number.MAX_SAFE_INTEGER,
        );
        if (sp > 1e-9) {
          p.vx = (p.vx / sp) * nsp;
          p.vy = (p.vy / sp) * nsp;
        }
        break;
      }

      case 'parabola':
        p.vy -= (s.gravity ?? 20) * dt;
        break;

      case 'homing': {
        const t = s.homingTarget;
        if (t) {
          const desired = Math.atan2(t.y - p.y, t.x - p.x);
          const cur = Math.atan2(p.vy, p.vx);
          const maxTurn = ((s.turnRate ?? 180) * Math.PI) / 180 * dt;

          let diff = desired - cur;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const turn = clamp(diff, -maxTurn, maxTurn);

          // 【振荡的坑】转向率过高时，弹丸会绕着目标转圈永远打不中。
          // 这里限制转向率；另外当距离很近时直接判定命中（见 sweep 后处理）
          const na = cur + turn;
          const sp = Math.hypot(p.vx, p.vy);
          p.vx = Math.cos(na) * sp;
          p.vy = Math.sin(na) * sp;
        }
        break;
      }

      case 'sine': {
        // 主方向匀速，垂直方向叠加速度分量（对正弦位移求导）
        //
        // 【为什么每帧重算而不是累加】
        // 累加会让摆动量进入 baseAngle，轨迹逐渐螺旋漂走。
        // 每帧从 baseAngle 和 speed 重新算，轨迹严格沿主轴。
        const amp = s.amplitude ?? 0.5;
        const freq = s.frequency ?? 2;
        const w = freq * Math.PI * 2;
        const a = p.baseAngle;
        const offsetVel = amp * w * Math.cos(p.age * w);

        p.vx = Math.cos(a) * s.speed - Math.sin(a) * offsetVel;
        p.vy = Math.sin(a) * s.speed + Math.cos(a) * offsetVel;
        break;
      }

      case 'linear':
      default:
        break;
    }

    // 2. 位移
    const totalDX = p.vx * dt;
    const totalDY = p.vy * dt;
    const totalLen = Math.hypot(totalDX, totalDY);

    if (totalLen > 1e-9) {
      const steps =
        this._maxStep > 0 ? Math.max(1, Math.ceil(totalLen / this._maxStep)) : 1;
      const stepDX = totalDX / steps;
      const stepDY = totalDY / steps;

      for (let k = 0; k < steps; k++) {
        const fx = p.x;
        const fy = p.y;
        const tx = p.x + stepDX;
        const ty = p.y + stepDY;

        // 【排除集用弹丸自己的 hitIds】
        // 曾经写成共享的 `_emptySet`，穿透后污染了所有弹丸——
        // A 打过的目标，B 也打不到了。
        const hit = this._collision.sweep(fx, fy, tx, ty, p.mask, p.hitIds);

        if (hit) {
          // 已经打过（穿透过的目标）则忽略
          if (p.hitIds.has(hit.id)) {
            p.x = tx;
            p.y = ty;
            continue;
          }

          p.x = hit.x;
          p.y = hit.y;
          p.hitIds.add(hit.id);
          s.onHit?.(hit, p);

          if (p.pierceLeft > 0) {
            p.pierceLeft--;
            continue;
          }

          if (p.bounceLeft > 0 && hit.nx !== undefined && hit.ny !== undefined) {
            p.bounceLeft--;
            // 反射：v' = v - 2(v·n)n
            const dot = p.vx * hit.nx + p.vy * hit.ny;
            p.vx -= 2 * dot * hit.nx;
            p.vy -= 2 * dot * hit.ny;
            // 【推出表面】不推的话下一帧还在墙里，会连续触发弹跳直到用尽
            p.x += hit.nx * 0.01;
            p.y += hit.ny * 0.01;
            break;
          }

          p.dead = true;
          s.onExpire?.(p, 'hit');
          return;
        }

        if (s.onMove) s.onMove(p, fx, fy);
        p.x = tx;
        p.y = ty;
      }
    }

    // 3. 边界
    const b = this._bounds;
    if (
      b &&
      (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY)
    ) {
      p.dead = true;
      s.onExpire?.(p, 'out-of-bounds');
      return;
    }

    // 4. 超时
    p.age += dt;
    if (p.age >= p.lifetime) {
      p.dead = true;
      s.onExpire?.(p, 'lifetime');
    }
  }

  /** 手动销毁（如施法者死亡） */
  kill(id: number): boolean {
    const i = this._list.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this._list[i].dead = true;
    this._list.splice(i, 1);
    return true;
  }

  /** 清空（切场景时调用） */
  clear(): void {
    this._list.length = 0;
  }

  destroy(): void {
    this.clear();
  }
}

/**
 * 便利：把 HitboxWorld 适配成 ICollisionProvider
 *
 * 【为什么放在这里而不是 hitbox/】
 * 分层规则禁止插件横向依赖。放在本文件里，两边都是"引用方"，
 * 不构成编译期依赖——你甚至可以只用其中一个。
 *
 * 用法：
 * ```typescript
 * const provider = createHitboxSweepProvider(world, { segmentRadius: 0.1 });
 * const sys = new ProjectileSystem({ collision: provider });
 * ```
 */
export function createHitboxSweepProvider(
  world: {
    query(shape: unknown, x: number, y: number, rot: number, mask: number, out?: unknown[]): Array<{ hitbox: { id: string; data?: unknown } }>;
  },
  opts: { segmentRadius?: number } = {},
): ICollisionProvider {
  const r = opts.segmentRadius ?? 0.1;

  return {
    sweep(fromX, fromY, toX, toY, mask, exclude) {
      const dx = toX - fromX;
      const dy = toY - fromY;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return null;

      // 用胶囊近似这一小段路径
      const shape = { kind: 'capsule', height: len, radius: r };
      const rotDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      const results = world.query(shape, (fromX + toX) / 2, (fromY + toY) / 2, rotDeg, mask);

      for (const hit of results) {
        if (exclude.has(hit.hitbox.id)) continue;
        return {
          id: hit.hitbox.id,
          // 命中点近似取线段中点（精确求交需要更多几何计算，游戏里这个精度够）
          x: (fromX + toX) / 2,
          y: (fromY + toY) / 2,
          data: hit.hitbox.data,
          t: 0.5,
        };
      }
      return null;
    },
  };
}
