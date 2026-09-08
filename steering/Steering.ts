/**
 * steering —— 群体转向行为（boids / 单体 steering）
 *
 * 【它解决什么】
 *
 * 让单位"自然地"移动，而不是直线插值过去：
 * - 怪群围过来但不叠在一起（分离）
 * - 队伍一起走但保持队形（聚集 + 队形偏移）
 * - 追击时会预判目标去向（拦截，而不是跟在屁股后面）
 * - 遇到障碍会绕开（避障）
 * - 到达目标时会减速（到达行为，不会冲过头来回抖）
 *
 * 【为什么不用"直接设速度朝目标"】
 * 那样所有单位会**挤成一坨**，而且到达时会**抖动**（冲过头再折返）。
 *
 * 【收录行为】
 * | 单体 | 群体 |
 * |---|---|
 * | seek 接近 | separation 分离（避免重叠） |
 * | flee 逃离 | cohesion 聚集（抱团） |
 * | arrive 到达（带减速） | alignment 对齐（同向） |
 * | pursuit 追击（预判） | |
 * | wander 游荡 | |
 * | obstacleAvoid 避障 | |
 *
 * 【关键设计：输出"转向力"而不是直接改速度】
 *
 * 每个行为返回的是一个**力**（加速度），不是速度。
 * 多个行为的力加权相加，再由调用方积分成速度。
 *
 * 这样才能：
 * ① 多个行为平滑叠加（不会互相覆盖）
 * ② 用 maxForce / maxSpeed 限制，行为自然
 * ③ 调用方可以完全掌管物理积分（本库不碰 dt）
 *
 * 【使用示例：单体】
 * ```typescript
 * const agent = createAgent({ x: 0, y: 0 }, { x: 10, y: 10 });
 *
 * const force = arrive(agent, { x: 100, y: 50 }, 30);
 * applyForce(agent, force, dt);      // 累加力
 * integrate(agent, dt);              // 积分成速度和位置
 * ```
 *
 * 【使用示例：群体（boids）】
 * ```typescript
 * const flock = new Flock({ separationRadius: 15, cohesionRadius: 60 });
 *
 * // 每帧
 * for (const agent of agents) {
 *   const force = flock.compute(agent, neighbors);
 *   applyForce(agent, force, dt);
 * }
 * for (const agent of agents) integrate(agent, dt);
 * ```
 *
 * 【无引擎依赖】不碰 dt，不碰物理引擎，只算向量。
 */

/**
 * 【⚠️ 全库有 3 套二维向量：`_core` 的 `IVec2`、本模块的、以及 `camera`/`minimap` 的 `Vec2`】
 *
 * 字段都是 `{ x, y }`，结构兼容，所以**互换不会报错**——
 * 但 `readonly` 修饰、配套工厂函数（`vec2()` / `v2()`）各不相同，
 * 混用时会遇到"能赋值但类型对不上"的编译错误，或者更糟：静默通过。
 *
 * `_core/types.ts` 是标准定义，并带了全套工具（`vec2` / `setVec2` / `len2` / `normalize2`），
 * 新代码应优先用它。本模块保留本地定义是为了"单文件可复制"——
 * 复制本文件时不必连带 `_core`。
 *
 * 如果你的项目已经带了 `_core`，可以直接换成：
 *
 * ```typescript
 * import type { IVec2 } from '../_core/types';
 * ```
 */
import { safeDt } from '../_core/math';
import { needPositive } from '../_core/guard';
export interface IVec2 {
  x: number;
  y: number;
}

export interface Agent {
  /** 位置 */
  pos: IVec2;
  /** 速度 */
  vel: IVec2;
  /** 当前受力（每帧末清零） */
  force: IVec2;
  /** 最大速度 */
  maxSpeed: number;
  /** 最大转向力（决定转弯有多急） */
  maxForce: number;
  /** 质量（力 → 加速度：a = F / m） */
  mass: number;
  /** 碰撞半径（分离行为用） */
  radius: number;
}

export function v2(x = 0, y = 0): IVec2 {
  return { x, y };
}

export function createAgent(
  pos: IVec2,
  vel: IVec2 = v2(),
  opts: Partial<Pick<Agent, 'maxSpeed' | 'maxForce' | 'mass' | 'radius'>> = {}
): Agent {
  return {
    pos: { ...pos },
    vel: { ...vel },
    force: v2(),
    maxSpeed: opts.maxSpeed ?? 100,
    maxForce: opts.maxForce ?? 200,
    /**
     * 【⚠️ mass 必须为正的有限数】
     *
     * 实测：`createAgent(v2(), v2(), { mass: 0 })` 后再 `integrate()`，
     * 位置与速度全部变成 **NaN**。
     *
     * 链路：`ax = force.x / mass` → `0/0 = NaN` 或 `x/0 = Infinity`，
     * 一旦 NaN 进入 `vel`，后续 `pos += vel * dt` 永久是 NaN。
     * 而 `integrate` 里的 `speed > limit && speed > 1e-9` 对 NaN 恒为 false，
     * **限速也救不回来**——NaN 不可恢复，只能重置整个 agent。
     *
     * 表现为"某个单位突然消失"（渲染层拿到 NaN 坐标不绘制），
     * 且不报错。质量常被用来表达"无敌/不可推动"，0 是很容易写出的值。
     */
    mass: needPositive(opts.mass ?? 1, 'agent.mass'),
    radius: opts.radius ?? 1,
  };
}

// ---- 向量工具（就地操作，避免 GC） ----

function len(v: IVec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function normalize(v: IVec2): IVec2 {
  const l = len(v);
  return l < 1e-9 ? v2() : v2(v.x / l, v.y / l);
}

function scale(v: IVec2, s: number): IVec2 {
  return v2(v.x * s, v.y * s);
}

function add(a: IVec2, b: IVec2): IVec2 {
  return v2(a.x + b.x, a.y + b.y);
}

function sub(a: IVec2, b: IVec2): IVec2 {
  return v2(a.x - b.x, a.y - b.y);
}

/** 截断长度 */
function truncate(v: IVec2, max: number): IVec2 {
  const l = len(v);
  return l > max && l > 1e-9 ? v2((v.x / l) * max, (v.y / l) * max) : v2(v.x, v.y);
}

function distance(a: IVec2, b: IVec2): number {
  return len(sub(a, b));
}

// ============================================================
// 单体行为（返回"力"）
// ============================================================

/**
 * 接近：朝目标全速
 *
 * 【坑】不要在到达时用它。
 * 单位会冲过目标再折返，来回**抖动**。用 `arrive`。
 */
export function seek(agent: Agent, target: IVec2): IVec2 {
  const desired = scale(normalize(sub(target, agent.pos)), agent.maxSpeed);
  return truncate(sub(desired, agent.vel), agent.maxForce);
}

/** 逃离 */
export function flee(agent: Agent, threat: IVec2, panicDistance = Infinity): IVec2 {
  const d = distance(agent.pos, threat);
  if (d > panicDistance) return v2();

  const desired = scale(normalize(sub(agent.pos, threat)), agent.maxSpeed);
  return truncate(sub(desired, agent.vel), agent.maxForce);
}

/**
 * 到达：接近目标，但在减速半径内逐渐减速
 *
 * 【为什么要减速】
 * 用 seek 的话单位会冲过目标再折返，表现为"在目标点附近抽搐"。
 * arrive 让速度随距离线性衰减到 0，自然停下。
 *
 * @param slowRadius 开始减速的半径
 */
export function arrive(agent: Agent, target: IVec2, slowRadius = 50, stopRadius = 2): IVec2 {
  const toTarget = sub(target, agent.pos);
  const d = len(toTarget);

  if (d < stopRadius) {
    // 已经到了：返回"抵消当前速度"的力，主动刹车
    return truncate(scale(agent.vel, -1), agent.maxForce);
  }

  const speed = d > slowRadius ? agent.maxSpeed : (agent.maxSpeed * d) / slowRadius;
  const desired = scale(normalize(toTarget), speed);
  return truncate(sub(desired, agent.vel), agent.maxForce);
}

/**
 * 追击：预判目标未来位置
 *
 * 【和 seek 的区别】
 * seek 追的是目标**当前**位置，永远跟在屁股后面。
 * pursuit 按目标速度外推，能**抄近路拦截**。
 *
 * @param lookAheadTime 预判时长（秒）。太大会过度提前，太小退化成 seek
 */
export function pursuit(agent: Agent, target: Agent, lookAheadTime = 1): IVec2 {
  const predicted = add(target.pos, scale(target.vel, lookAheadTime));
  return seek(agent, predicted);
}

/** 逃避追击者（预判版） */
export function evade(agent: Agent, pursuer: Agent, lookAheadTime = 1): IVec2 {
  const predicted = add(pursuer.pos, scale(pursuer.vel, lookAheadTime));
  return flee(agent, predicted);
}

/**
 * 游荡：伪随机游走
 *
 * 【为什么用"圆上取点"而不是直接随机转向】
 * 每帧随机改方向会产生高频抖动，看起来像抽搐。
 * 这里在速度前方放一个圆，在圆周上缓慢移动一个点，
 * 转向就变成平滑的。
 */
export interface WanderState {
  angle: number;
}

export function wander(
  agent: Agent,
  state: WanderState,
  circleDistance = 20,
  circleRadius = 10,
  angleChange = 0.5,
  rand: () => number = Math.random
): IVec2 {
  // 圆心在速度方向前方
  const circleCenter = scale(normalize(agent.vel), circleDistance);
  if (circleCenter.x === 0 && circleCenter.y === 0) {
    circleCenter.x = circleDistance;   // 静止时给个初始方向
  }

  // 角度随机游走
  state.angle += (rand() - 0.5) * 2 * angleChange;

  const offset = v2(Math.cos(state.angle) * circleRadius, Math.sin(state.angle) * circleRadius);
  const target = add(agent.pos, add(circleCenter, offset));

  return seek(agent, target);
}

/**
 * 避障：前方有障碍时侧向偏转
 *
 * 【原理】
 * 向前投射一条"探测触须"（长度随速度增加），
 * 如果触须碰到障碍，计算一个垂直于障碍表面的力。
 *
 * 【局限】
 * 这是**反应式**避障，不是寻路。
 * 复杂地形（凹形陷阱）会卡住，那种情况该用 A*。
 * 它的价值在于：配合寻路处理"路径上的小障碍"，让移动不生硬。
 */
export function obstacleAvoid(
  agent: Agent,
  obstacles: ReadonlyArray<{ pos: IVec2; radius: number }>,
  lookAhead = 60
): IVec2 {
  const speed = len(agent.vel);
  if (speed < 1e-6) return v2();

  const ahead = add(agent.pos, scale(normalize(agent.vel), lookAhead * (speed / agent.maxSpeed)));
  const aheadHalf = add(agent.pos, scale(normalize(agent.vel), lookAhead * 0.5 * (speed / agent.maxSpeed)));

  let mostThreatening: { pos: IVec2; radius: number } | null = null;
  let minDist = Infinity;

  for (const o of obstacles) {
    // 障碍在触须附近才算威胁
    const d1 = distance(ahead, o.pos);
    const d2 = distance(aheadHalf, o.pos);
    const d3 = distance(agent.pos, o.pos);

    const collision = d1 <= o.radius + agent.radius || d2 <= o.radius + agent.radius || d3 <= o.radius + agent.radius;
    if (!collision) continue;

    const d = distance(agent.pos, o.pos);
    if (d < minDist) {
      minDist = d;
      mostThreatening = o;
    }
  }

  if (!mostThreatening) return v2();

  let avoidance = sub(ahead, mostThreatening.pos);

  /**
   * 【坑】障碍正好挡在正前方时，avoidance 是**零向量**
   *
   * `ahead` 恰好落在障碍中心 → `ahead - obstacle.pos = (0,0)`
   * → normalize 返回 (0,0) → 避障力为 0 → **单位径直撞上去**。
   *
   * 这是最容易遇到的情况（正面撞墙），却是最先失效的情况。
   * 真实项目的表现是："避障有时候不灵，看起来随机"。
   *
   * 【解法】零向量时改用"垂直于前进方向的侧向力"。
   * 选左还是右？用障碍与前进方向的叉积符号决定——
   * 障碍偏左就往右躲，偏左就往左躲，正前方时默认往右。
   */
  if (Math.abs(avoidance.x) < 1e-9 && Math.abs(avoidance.y) < 1e-9) {
    const fwd = normalize(agent.vel);
    // 右转 90°：(x, y) → (-y, x)
    avoidance = v2(-fwd.y, fwd.x);
  } else {
    avoidance = normalize(avoidance);
  }

  return truncate(scale(avoidance, agent.maxForce), agent.maxForce);
}

// ============================================================
// 群体行为（boids）
// ============================================================

export interface FlockOptions {
  /** 分离：小于此距离则互相推开 */
  separationRadius?: number;
  /** 聚集：大于此距离则互相靠拢 */
  cohesionRadius?: number;
  /** 对齐半径 */
  alignmentRadius?: number;

  /** 各行为权重 */
  separationWeight?: number;
  cohesionWeight?: number;
  alignmentWeight?: number;

  /**
   * 视野角度（弧度）。背后的同伴不影响行为
   *
   * 【为什么需要】
   * 没有视野限制的话，单位会被"背后看不见的同伴"拉扯，
   * 行为看起来很奇怪。真实动物也只看前方和侧方。
   */
  fieldOfView?: number;
  maxSpeed?: number;
  maxForce?: number;
}

/**
 * Boids 群体（分离 / 聚集 / 对齐）
 *
 * 【三条经典规则】
 * 1. **分离**：太挤了就散开
 * 2. **聚集**：离群了就靠拢
 * 3. **对齐**：和邻居保持同向
 *
 * 三条规则加权叠加，就产生了鸟群、鱼群、怪群的自然运动。
 *
 * 【性能】
 * `compute` 是 O(n)，n = 邻居数。
 * 邻居查询请用 `SpatialHash` 或 `QuadTree`，
 * 不要用 O(n²) 的两两比较（100 个单位就是 10000 次）。
 */
export class Flock {
  private readonly _opts: Required<FlockOptions>;

  constructor(opts: FlockOptions = {}) {
    this._opts = {
      separationRadius: opts.separationRadius ?? 20,
      cohesionRadius: opts.cohesionRadius ?? 60,
      alignmentRadius: opts.alignmentRadius ?? 50,
      separationWeight: opts.separationWeight ?? 1.5,
      cohesionWeight: opts.cohesionWeight ?? 1.0,
      alignmentWeight: opts.alignmentWeight ?? 1.0,
      fieldOfView: opts.fieldOfView ?? Math.PI * 1.5,
      maxSpeed: opts.maxSpeed ?? 100,
      maxForce: opts.maxForce ?? 200,
    };
  }

  /**
   * 计算群体力
   *
   * @param self 自己
   * @param neighbors 邻居（**应包含自己**，内部会跳过）
   */
  compute(self: Agent, neighbors: ReadonlyArray<Agent>): IVec2 {
    let sepX = 0;
    let sepY = 0;
    let sepCount = 0;

    let cohX = 0;
    let cohY = 0;
    let cohCount = 0;

    let aliX = 0;
    let aliY = 0;
    let aliCount = 0;

    const sepR2 = this._opts.separationRadius * this._opts.separationRadius;
    const cohR2 = this._opts.cohesionRadius * this._opts.cohesionRadius;
    const aliR2 = this._opts.alignmentRadius * this._opts.alignmentRadius;

    const fovCos = Math.cos(this._opts.fieldOfView / 2);

    for (const other of neighbors) {
      if (other === self) continue;

      const dx = other.pos.x - self.pos.x;
      const dy = other.pos.y - self.pos.y;
      const d2 = dx * dx + dy * dy;

      if (d2 < 1e-12) continue;   // 完全重合，跳过（避免除零）

      // 视野检查（可选）
      if (this._opts.fieldOfView < Math.PI * 2 - 1e-6) {
        const d = Math.sqrt(d2);
        const fx = dx / d;
        const fy = dy / d;
        const vel = self.vel;
        const vl = len(vel);
        if (vl > 1e-6) {
          const dot = (vel.x / vl) * fx + (vel.y / vl) * fy;
          if (dot < fovCos) continue;   // 在视野外
        }
      }

      // ① 分离：距离越近，推力越大（1/d 加权）
      if (d2 < sepR2 && d2 > 1e-12) {
        const d = Math.sqrt(d2);
        sepX -= dx / d / d;   // 方向 × (1/d)，距离越近推力越大
        sepY -= dy / d / d;
        sepCount++;
      }

      // ② 聚集：累加邻居位置，稍后取平均
      if (d2 < cohR2) {
        cohX += other.pos.x;
        cohY += other.pos.y;
        cohCount++;
      }

      // ③ 对齐：累加邻居速度
      if (d2 < aliR2) {
        aliX += other.vel.x;
        aliY += other.vel.y;
        aliCount++;
      }
    }

    const total = v2();

    // 分离
    if (sepCount > 0) {
      const desired = normalize(v2(sepX, sepY));
      const steer = truncate(sub(scale(desired, this._opts.maxSpeed), self.vel), this._opts.maxForce);
      total.x += steer.x * this._opts.separationWeight;
      total.y += steer.y * this._opts.separationWeight;
    }

    // 聚集
    if (cohCount > 0) {
      const center = v2(cohX / cohCount, cohY / cohCount);
      const desired = scale(normalize(sub(center, self.pos)), this._opts.maxSpeed);
      const steer = truncate(sub(desired, self.vel), this._opts.maxForce);
      total.x += steer.x * this._opts.cohesionWeight;
      total.y += steer.y * this._opts.cohesionWeight;
    }

    // 对齐
    if (aliCount > 0) {
      const avgVel = v2(aliX / aliCount, aliY / aliCount);
      const desired = scale(normalize(avgVel), this._opts.maxSpeed);
      const steer = truncate(sub(desired, self.vel), this._opts.maxForce);
      total.x += steer.x * this._opts.alignmentWeight;
      total.y += steer.y * this._opts.alignmentWeight;
    }

    return truncate(total, this._opts.maxForce * 2);
  }
}

// ============================================================
// 队形
// ============================================================

/**
 * 编队偏移（跟随队形）
 *
 * 【用途】RTS 里选一群单位移动，它们应该保持阵型，
 * 而不是全挤到目标点。
 *
 * 【用法】
 * 每个单位的目标 = 队伍中心 + 自己的偏移（按队形计算）。
 * 单位对"自己的目标点"做 arrive。
 */
export function formationOffset(index: number, spacing: number, columns = 5): IVec2 {
  const row = Math.floor(index / columns);
  const col = index % columns;

  // 每行错开半个身位（楔形），看起来更自然
  const rowOffset = row % 2 === 0 ? 0 : spacing * 0.5;

  return v2((col - (columns - 1) / 2) * spacing + rowOffset, row * spacing);
}

/** 圆形环绕阵型（保护中心的单位） */
export function circleFormation(index: number, count: number, radius: number): IVec2 {
  const angle = (index / count) * Math.PI * 2;
  return v2(Math.cos(angle) * radius, Math.sin(angle) * radius);
}

// ============================================================
// 物理积分（调用方每帧调用）
// ============================================================

/**
 * 累加重力
 *
 * 【为什么不直接在行为里改速度】
 * 分离"算力"和"积分"能让多个行为正确叠加。
 * 如果每个行为都直接改速度，后一个会覆盖前一个。
 */
export function applyForce(agent: Agent, force: IVec2): void {
  agent.force.x += force.x;
  agent.force.y += force.y;
}

/** 清零力（每帧末调用） */
export function clearForce(agent: Agent): void {
  agent.force.x = 0;
  agent.force.y = 0;
}

/**
 * 积分：力 → 加速度 → 速度 → 位置
 *
 * 【顺序很重要】
 * ① a = F / m
 * ② v += a × dt，并限速
 * ③ pos += v × dt
 * ④ **清零力**（不清的话下一帧力会累积，单位越来越快）
 *
 * @param maxSpeed 覆盖 agent.maxSpeed（可选）
 */
export function integrate(agent: Agent, dt: number, maxSpeed?: number): void {
  if (!safeDt(dt)) return;
  const ax = agent.force.x / agent.mass;
  const ay = agent.force.y / agent.mass;

  agent.vel.x += ax * dt;
  agent.vel.y += ay * dt;

  const limit = maxSpeed ?? agent.maxSpeed;
  const speed = len(agent.vel);
  if (speed > limit && speed > 1e-9) {
    agent.vel.x = (agent.vel.x / speed) * limit;
    agent.vel.y = (agent.vel.y / speed) * limit;
  }

  agent.pos.x += agent.vel.x * dt;
  agent.pos.y += agent.vel.y * dt;

  clearForce(agent);
}

/** 限制在区域内（碰到边界反弹或夹住） */
export function constrain(
  agent: Agent,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  bounce = true
): void {
  if (agent.pos.x < minX) {
    agent.pos.x = minX;
    if (bounce) agent.vel.x *= -1;
  } else if (agent.pos.x > maxX) {
    agent.pos.x = maxX;
    if (bounce) agent.vel.x *= -1;
  }

  if (agent.pos.y < minY) {
    agent.pos.y = minY;
    if (bounce) agent.vel.y *= -1;
  } else if (agent.pos.y > maxY) {
    agent.pos.y = maxY;
    if (bounce) agent.vel.y *= -1;
  }
}
