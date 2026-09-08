/**
 * SkillCaster —— 技能释放模块（编排器）
 *
 * 【它解决什么】
 *
 * 用户原话："技能释放模块（包括指示器，伤害，弹道等），
 * 任何项目只需要传入移动的角色就能直接用。"
 *
 * 一个技能的完整流程是：
 * ```
 * 按技能键
 *   → 检查冷却、资源、距离
 *   → 显示指示器（这一招打哪里）
 *   → 蓄力预警（敌人/玩家有反应时间）
 *   → 播放时间轴（动画、音效）
 *   → 到判定帧：生成判定框 / 发射弹道
 *   → 命中：走伤害管线
 *   → 后摇，回到待机
 * ```
 *
 * 这些步骤散落在业务代码里，就是典型的「换项目全废」。
 * SkillCaster 把它们**编排**起来，每一步通过接口注入。
 *
 * 【⚠️ 本文件不 import 任何其他插件】
 *
 * 它不认识 Hitbox、Projectile、Indicator、DamagePipeline、SkillPlayer。
 * 全部通过 `SkillCasterDeps` 注入：
 *
 * ```typescript
 * export interface SkillCasterDeps {
 *   hitboxes?:   { query(...) };        // 判定（通常是 HitboxWorld）
 *   projectiles?: { spawn(...) };       // 弹道（通常是 ProjectileSystem）
 *   damage?:     { apply(...) };        // 伤害（通常是 DamagePipeline）
 *   resources?:  { canAfford, pay };    // 资源（蓝/体力/怒气）
 *   timeline?:   { play(...) };         // 时间轴（通常是 SkillPlayer）
 * }
 * ```
 *
 * **这就是"可复用"的落地方式**——编排逻辑是我的，具体能力是你的。
 * 换个游戏，换一批实现传进来，编排逻辑一行不用改。
 *
 * 【为什么不用继承】
 * 继承会把"挥砍"和"火球"绑在一个类层次里。
 * 这里是**组合**：技能 = 配置 + 一组可选能力。
 * 没有指示器就传 `indicator: undefined`，代码自动跳过那一步。
 *
 * 【使用示例】
 * ```typescript
 * const caster = new SkillCaster({
 *   hitboxes: world,
 *   projectiles: projSys,
 *   damage: pipeline,
 *   resources: myResourceBag,
 * });
 *
 * caster.learn({
 *   id: 'slash', cooldown: 0.6,
 *   hitShape: { kind: 'sector', radius: 2, angleDeg: 100 },
 *   hitDelay: 0.12,          // 挥出后 0.12 秒判定
 *   damage: { raw: 20, type: 'physical' },
 *   mask: LAYER_ENEMY,
 * });
 *
 * // 每帧
 * caster.tick(dt);
 *
 * // 施放
 * const r = caster.tryCast('slash', { x: px, y: py, facingDeg, data: player });
 * if (!r.ok) showHint(r.reason);
 * ```
 */

import { clamp, safeDt } from '../_core/math';

// ── 判定形状（字段兼容各插件，避免横向依赖） ──

export interface SkillShape {
  kind: 'circle' | 'rect' | 'sector' | 'capsule';
  radius?: number;
  halfW?: number;
  halfH?: number;
  angleDeg?: number;
  height?: number;
  offsetX?: number;
  offsetY?: number;
}

// ── 注入接口 ──

/** 判定查询结果 */
export interface CasterHit {
  id: string;
  x: number;
  y: number;
  data?: unknown;
}

/** 判定提供方 */
export interface IHitboxProvider {
  query(
    shape: SkillShape, x: number, y: number, rotation: number, mask: number,
  ): CasterHit[];
}

/** 弹道生成参数（透传给 ProjectileSystem） */
export interface ICasterProjectile {
  x: number; y: number; dirX: number; dirY: number;
  speed: number; lifetime: number; mask: number;
  mode?: string;
  pierce?: number;
  data?: unknown;
}

/** 弹道提供方 */
export interface IProjectileProvider {
  spawn(p: ICasterProjectile): unknown;
}

/** 伤害上下文（透传） */
export interface ICasterDamage {
  raw: number;
  type?: string;
  crit?: boolean;
  source?: unknown;
  meta?: Record<string, unknown>;
}

/** 伤害提供方 */
export interface IDamageProvider {
  apply(target: unknown, dmg: ICasterDamage, hitId: string): void;
}

/** 资源提供方（蓝/体力/怒气……语义由调用方定义） */
export interface IResourceProvider {
  canAfford(cost: Readonly<Record<string, number>>): boolean;
  pay(cost: Readonly<Record<string, number>>): void;
  /** 退还（施法被打断时） */
  refund?(cost: Readonly<Record<string, number>>): void;
}

/** 时间轴事件（透传给 SkillPlayer） */
export interface ICasterTimelineEvent {
  time: number;
  type: string;
  data?: Record<string, unknown>;
}

/** 时间轴提供方 */
export interface ITimelineProvider {
  play(events: readonly ICasterTimelineEvent[], ctx: unknown): { cancel(): void };
}

// ── 技能定义 ──

/** 伤害配置 */
export interface SkillDamageDef {
  raw: number;
  type?: string;
  /** 是否可暴击（暴击判定由伤害管线负责） */
  canCrit?: boolean;
}

/** 技能定义 */
export interface SkillDef {
  id: string;
  name?: string;

  /** 冷却（秒） */
  cooldown: number;
  /** 充能层数（1 = 普通冷却，2 = 可存两次） */
  charges?: number;

  /** 资源消耗，如 `{ mp: 20 }` */
  cost?: Record<string, number>;

  /**
   * 蓄力时长（秒）
   *
   * 【为什么需要】
   * 0 表示按下即判定。但那会让玩家觉得"我还没准备好就放出去了"。
   * 蓄力期间通常显示预警（对自己是蓄力条，对敌人是地面圈）。
   */
  windup?: number;

  /**
   * 判定延迟（秒）——**相对于蓄力结束**，不是相对于按下
   *
   * 【为什么要对齐动画】
   * 剑挥到最前方那一帧才该判定。
   * 这个值必须和美术标注的判定帧一致，差 3 帧玩家就觉得"打空了"。
   */
  hitDelay?: number;
  /**
   * 判定窗口（秒）；0 = 瞬时判定
   *
   * 【什么时候用】
   * 持续型技能（旋风斩、激光）需要窗口期内每帧检测新目标。
   * 瞬时判定更干脆，优先用 0。
   */
  hitWindow?: number;
  /** 后摇（秒）：期间不能再施法 */
  recover?: number;

  // ── 三种命中方式，三选一（或组合）──

  /** ① 直接判定：在 hitDelay 时刻生成形状查询 */
  hitShape?: SkillShape;
  /** 直接判定的伤害 */
  damage?: SkillDamageDef;

  /** ② 弹道：在 hitDelay 时刻发射 */
  projectile?: {
    speed: number;
    lifetime: number;
    mode?: string;
    pierce?: number;
    /** 命中时的伤害 */
    damage?: SkillDamageDef;
  };

  /** ③ 完全交给时间轴（复杂多段技能用这个） */
  timeline?: ICasterTimelineEvent[];

  /**
   * 判定形状的原点
   *
   * - `'caster'`（**默认**）：以施法者位置为中心
   * - `'aim'`：以瞄准点为中心
   *
   * 【怎么选】
   * | 技能 | origin | 说明 |
   * |---|---|---|
   * | 扇形挥砍 | `caster` | 从自身扩散出去 |
   * | 剑气（矩形） | `caster` + `offsetX` | 形状沿朝向前移半个长度 |
   * | 冲刺路径 | `caster` + `offsetX` | 同上 |
   * | 火球落点爆炸 | **`aim`** | 在鼠标位置炸开 |
   * | 传送 / 放置 | **`aim`** | 以落点为准 |
   *
   * 【默认为什么是 caster】
   * 曾经默认用瞄准点，结果扇形近战技能全部打空——
   * 扇形以瞄准点（2 米外）为中心，身前的怪反而在扇形背后。
   * 大多数技能是"从自身发出"的，所以 caster 更安全的默认值。
   */
  origin?: 'caster' | 'aim';

  /** 碰撞掩码 */
  mask: number;

  /** 最大施法距离（超出则失败，0/不填 = 不限制） */
  maxRange?: number;
  /** 最小施法距离 */
  minRange?: number;

  /**
   * 施法期间是否锁定朝向
   *
   * 【语义澄清】
   * 它不是"用施法者的当前朝向"——朝向始终由**瞄准点**决定
   * （没传瞄准点时才用 `facingDeg`）。
   *
   * 它指的是：**朝向在施法开始那一刻锁定，之后不再变化**。
   *
   * 【为什么必须锁】
   * 不锁的话，玩家挥砍中途移动鼠标，判定框会跟着转——
   * 表现为"我明明砍的是左边，却打到了右边的怪"。
   */
  lockFacing?: boolean;

  /**
   * 是否可被移动打断
   * 【设计取舍】近战通常不可打断（有硬直才有力道感）
   */
  interruptibleByMove?: boolean;
}

/** 施法上下文 */
export interface CastContext {
  /** 施法者位置 */
  x: number;
  y: number;
  /** 施法者朝向（度） */
  facingDeg: number;
  /** 瞄准点（可选，不传则用 facingDeg 正前方） */
  aimX?: number;
  aimY?: number;
  /** 施法者（会透传给伤害管线作为 source） */
  source?: unknown;
  /** 附加数据 */
  data?: unknown;
}

/** 施放结果 */
export interface CastResult {
  ok: boolean;
  reason?: 'unknown-skill' | 'cooldown' | 'resource' | 'busy' | 'out-of-range' | 'too-close' | 'invalid';
  /** 剩余冷却（失败原因是 cooldown 时） */
  remain?: number;
  /** 本次施法的唯一 id（用于 hitId 去重） */
  castId?: number;
}

/** 施法阶段 */
export type CastPhase = 'idle' | 'windup' | 'active' | 'recover';

/** 运行中的一次施法 */
export interface ActiveCast {
  readonly castId: number;
  readonly def: Readonly<SkillDef>;
  phase: CastPhase;
  /** 阶段内已过时间 */
  phaseTime: number;
  totalTime: number;

  /** 锁定的朝向（lockFacing 时） */
  facingDeg: number;
  /** 锁定的判定中心（由 origin 决定） */
  x: number;
  y: number;
  /** 施法者位置（弹道发射点，始终以此为准） */
  casterX: number;
  casterY: number;

  /** 本帧是否已判定过（避免窗口期内重复判定） */
  resolved: boolean;
  /** 已命中的目标 id（本窗口内去重） */
  hitIds: Set<string>;
  /**
   * 本次施法是否已生成过弹道
   *
   * 【为什么需要单独一个标志，不能复用 resolved】
   * `resolved` 在**首次判定的那一帧**就置 true，之后窗口期内每帧仍会
   * 走"持续检测命中"分支（持续型技能的设计意图，如旋风斩）。
   * 所以 `resolved` 表达的是"已经命中过一次"，
   * 而弹道需要的是"整个施法只发射一次"——两者语义不同。
   */
  spawned: boolean;

  source?: unknown;
  data?: unknown;
}

export interface SkillCasterDeps {
  hitboxes?: IHitboxProvider;
  projectiles?: IProjectileProvider;
  damage?: IDamageProvider;
  resources?: IResourceProvider;
  timeline?: ITimelineProvider;

  /** 事件回调 */
  onCast?: (def: Readonly<SkillDef>, ctx: CastContext) => void;
  onHit?: (def: Readonly<SkillDef>, target: unknown, hitId: string) => void;
  onComplete?: (def: Readonly<SkillDef>, cancelled: boolean) => void;
  onFail?: (def: Readonly<SkillDef>, reason: CastResult['reason']) => void;
}

let _nextCastId = 1;

/**
 * 技能释放器
 *
 * 【状态机】
 * ```
 * idle ──tryCast(ok)──▶ windup ──▶ active ──▶ recover ──▶ idle
 *          │              │          │
 *          └──────────────┴──────────┴── cancel() ──▶ idle
 * ```
 */
export class SkillCaster {
  private _deps: SkillCasterDeps;
  private _skills = new Map<string, SkillDef>();

  /** 每个技能的冷却剩余 */
  private _cd = new Map<string, number>();
  /** 充能层数 */
  private _charges = new Map<string, number>();

  private _current: ActiveCast | null = null;
  private _timelineHandle: { cancel(): void } | null = null;

  constructor(deps: SkillCasterDeps = {}) {
    this._deps = deps;
  }

  // ── 技能注册 ──

  /** 学会一个技能 */
  learn(def: SkillDef): this {
    this._skills.set(def.id, def);
    this._cd.set(def.id, 0);
    this._charges.set(def.id, def.charges ?? 1);
    return this;
  }

  /** 遗忘（或临时禁用） */
  forget(id: string): boolean {
    this._cd.delete(id);
    this._charges.delete(id);
    return this._skills.delete(id);
  }

  /** 取技能定义 */
  getDef(id: string): SkillDef | undefined {
    return this._skills.get(id);
  }

  /** 是否已学会 */
  has(id: string): boolean {
    return this._skills.has(id);
  }

  /** 所有技能 id */
  skillIds(): string[] {
    return Array.from(this._skills.keys());
  }

  // ── 冷却 ──

  /** 剩余冷却 */
  cooldownLeft(id: string): number {
    return this._cd.get(id) ?? 0;
  }

  /** 冷却比例 0..1（UI 转圈用，1 = 刚用完） */
  cooldownRatio(id: string): number {
    const def = this._skills.get(id);
    if (!def || def.cooldown <= 0) return 0;
    return clamp((this._cd.get(id) ?? 0) / def.cooldown, 0, 1);
  }

  /** 重置冷却（调试 / 特定遗物） */
  resetCooldown(id?: string): void {
    if (id === undefined) {
      for (const k of this._cd.keys()) this._cd.set(k, 0);
      return;
    }
    this._cd.set(id, 0);
  }

  /** 剩余充能 */
  chargesLeft(id: string): number {
    return this._charges.get(id) ?? 1;
  }

  // ── 施放 ──

  /** 当前是否正在施法 */
  get busy(): boolean {
    return this._current !== null;
  }

  /** 当前施法（可能为 null） */
  get current(): ActiveCast | null {
    return this._current;
  }

  /**
   * 尝试施放
   *
   * 【返回值的用法】
   * 失败时给玩家一个明确原因（UI 显示"冷却中"/"蓝不够"），
   * 而不是默默什么都不发生——后者会让玩家以为游戏卡了。
   */
  tryCast(id: string, ctx: CastContext): CastResult {
    const def = this._skills.get(id);
    if (!def) return this._fail(def, 'unknown-skill');

    if (this._current) return this._fail(def, 'busy');

    const cd = this._cd.get(id) ?? 0;
    if (cd > 0) return this._fail(def, 'cooldown', cd);

    if (def.cost && this._deps.resources && !this._deps.resources.canAfford(def.cost)) {
      return this._fail(def, 'resource');
    }

    // 距离校验
    if (def.maxRange !== undefined || def.minRange !== undefined) {
      const d = Math.hypot((ctx.aimX ?? ctx.x) - ctx.x, (ctx.aimY ?? ctx.y) - ctx.y);
      if (def.maxRange !== undefined && d > def.maxRange) {
        return this._fail(def, 'out-of-range');
      }
      if (def.minRange !== undefined && d < def.minRange) {
        return this._fail(def, 'too-close');
      }
    }

    // 扣费
    if (def.cost) this._deps.resources?.pay(def.cost);

    // 消耗一层充能
    const left = (this._charges.get(id) ?? 1) - 1;
    this._charges.set(id, left);
    if (left <= 0) this._cd.set(id, def.cooldown);

    const castId = _nextCastId++;

    // 计算朝向
    //
    // 【有瞄准点时，朝向指向瞄准点】
    // 曾经直接用 ctx.facingDeg，结果"我瞄准上方却朝右发射"——
    // 角色模型还没转过来，但输入已经指向新方向了。
    //
    // 玩家的意图由**瞄准点**表达，不是由角色当前朝向表达。
    // 角色的视觉朝向应该在施法时同步转向瞄准点（业务层做）。
    let facing = ctx.facingDeg;
    if (ctx.aimX !== undefined && ctx.aimY !== undefined) {
      const dx = ctx.aimX - ctx.x;
      const dy = ctx.aimY - ctx.y;
      if (Math.hypot(dx, dy) > 1e-6) {
        facing = (Math.atan2(dy, dx) * 180) / Math.PI;
      }
    }

    // 锁定朝向与判定中心
    const aimX = ctx.aimX ?? ctx.x + Math.cos((facing * Math.PI) / 180);
    const aimY = ctx.aimY ?? ctx.y + Math.sin((facing * Math.PI) / 180);

    // 【判定中心按 origin 决定】
    // 默认以施法者为中心（"从自身发出"），形状的前移用 offsetX 表达。
    const useAim = def.origin === 'aim';
    const centerX = useAim ? aimX : ctx.x;
    const centerY = useAim ? aimY : ctx.y;

    this._current = {
      castId,
      def,
      phase: (def.windup ?? 0) > 0 ? 'windup' : 'active',
      phaseTime: 0,
      totalTime: 0,
      facingDeg: facing,
      x: centerX,
      y: centerY,
      casterX: ctx.x,
      casterY: ctx.y,
      resolved: false,
      hitIds: new Set(),
      spawned: false,
      source: ctx.source,
      data: ctx.data,
    };

    // 时间轴（如果配置了）
    if (def.timeline && this._deps.timeline) {
      this._timelineHandle = this._deps.timeline.play(def.timeline, ctx.source);
    }

    this._deps.onCast?.(def, ctx);
    return { ok: true, castId };
  }

  private _fail(
    def: SkillDef | undefined,
    reason: CastResult['reason'],
    remain?: number,
  ): CastResult {
    if (def) this._deps.onFail?.(def, reason);
    const r: CastResult = { ok: false, reason };
    if (remain !== undefined) r.remain = remain;
    return r;
  }

  /** 打断当前施法（被击中、死亡、主动取消） */
  cancel(refundCost = false): boolean {
    const c = this._current;
    if (!c) return false;

    if (refundCost && c.def.cost && Object.keys(c.def.cost).length > 0) {
      this._deps.resources?.refund?.(c.def.cost);
    }

    this._timelineHandle?.cancel();
    this._timelineHandle = null;
    this._current = null;
    this._deps.onComplete?.(c.def, true);
    return true;
  }

  /**
   * 每帧更新
   *
   * 【dt 来源】必须是统一时间源（Scheduler）的缩放后 dt。
   * 这样暂停、慢动作、顿帧自动生效。
   */
  tick(dt: number): void {
    // 【守卫为什么必须在最前面】
    //
    // 冷却递减用的是 `t - dt`，而 `dt <= 0` 的旧守卫写在递减**之后**。
    // 于是异常 dt 会先污染冷却，守卫才姗姗来迟：
    //
    //   tick(-1)  → cd 1.00s → 2.00s → … （负 dt 把冷却越拉越长）
    //   tick(NaN) → `n = t - NaN = NaN`，`NaN > 0` 恒 false → 走 `set(id, 0)` → **冷却瞬间归零**
    //
    // 一个 NaN 帧就能让全部技能立刻可用，平衡性被击穿。
    // 守卫必须在**任何** dt 算术之前。
    if (!safeDt(dt)) return;

    // 冷却递减（即使正在施法也要走）
    //
    // 【充能恢复】冷却走完恢复一层；如果还没满，重新开始计一层的时间。
    // 不这么做的话，2 层充能的技能用完后只会恢复 1 层，第二次永远是空的。
    for (const [id, t] of this._cd) {
      if (t <= 0) continue;
      const n = t - dt;
      if (n > 0) {
        this._cd.set(id, n);
        continue;
      }
      this._cd.set(id, 0);
      const def = this._skills.get(id);
      if (!def) continue;
      const max = def.charges ?? 1;
      const cur = this._charges.get(id) ?? 1;
      if (cur < max) {
        this._charges.set(id, cur + 1);
        if (cur + 1 < max) this._cd.set(id, def.cooldown);
      }
    }

    const c = this._current;
    if (!c) return;

    c.phaseTime += dt;
    c.totalTime += dt;

    // 【判定必须在推进阶段之前】
    //
    // 曾经把判定写在阶段推进之后，结果是：
    // 当 phaseTime 刚够 hitDelay 时，阶段推进已经把它切成 recover，
    // 判定分支 `phase === 'active'` 不再成立 → **技能永远打不中**。
    //
    // hitDelay = 0 的技能尤其致命：active 时长就是 0，
    // 推进后立刻变成 recover，第一帧就错过了判定。
    if (c.phase === 'active') {
      const hitAt = c.def.hitDelay ?? 0;
      if (!c.resolved && c.phaseTime >= hitAt) {
        c.resolved = true;
        this._resolve(c);
      } else if (c.resolved && (c.def.hitWindow ?? 0) > 0) {
        // 判定窗口期内每帧检测（持续型技能，如旋风斩）
        this._resolve(c);
      }
    }

    // 【跨阶段用 while】低帧率时一帧可能跨过整个阶段
    let guard = 0;
    while (c.phase !== 'idle' && guard++ < 8) {
      const dur = this._phaseDuration(c);
      if (c.phaseTime < dur) break;
      const overshoot = c.phaseTime - dur;

      if (c.phase === 'windup') {
        c.phase = 'active';
        c.phaseTime = overshoot;
        // 刚进入 active：这一帧可能已经越过 hitDelay（低帧率时）
        if (overshoot >= (c.def.hitDelay ?? 0) && !c.resolved) {
          c.resolved = true;
          this._resolve(c);
        }
        continue;
      }
      if (c.phase === 'active') {
        c.phase = 'recover';
        c.phaseTime = overshoot;
        continue;
      }
      // recover 结束
      this._finish(c);
      break;
    }
  }

  private _phaseDuration(c: ActiveCast): number {
    switch (c.phase) {
      case 'windup': return c.def.windup ?? 0;
      // active 的时长 = 判定延迟 + 判定窗口
      // 这样"窗口结束"和"阶段结束"是同一件事，语义自洽
      case 'active': return (c.def.hitDelay ?? 0) + (c.def.hitWindow ?? 0);
      case 'recover': return c.def.recover ?? 0;
      default: return 0;
    }
  }

  private _finish(c: ActiveCast): void {
    this._timelineHandle = null;
    this._current = null;
    this._deps.onComplete?.(c.def, false);
  }

  /** 执行命中：直接判定 或 发射弹道 */
  private _resolve(c: ActiveCast): void {
    const def = c.def;

    // ① 直接判定
    if (def.hitShape && this._deps.hitboxes) {
      const hits = this._deps.hitboxes.query(
        def.hitShape, c.x, c.y, c.facingDeg, def.mask,
      );
      for (const h of hits) {
        // 【去重】窗口期内同一目标只命中一次
        if (c.hitIds.has(h.id)) continue;
        c.hitIds.add(h.id);

        const hitId = `${c.castId}:${h.id}`;
        if (def.damage && this._deps.damage) {
          this._deps.damage.apply(
            h.data,
            {
              raw: def.damage.raw,
              type: def.damage.type,
              source: c.source,
            },
            hitId,
          );
        }
        this._deps.onHit?.(def, h.data, hitId);
      }
    }

    // ② 弹道
    //
    // 【发射点始终是施法者，不是判定中心】
    // origin='aim' 时 c.x/c.y 是落点，从落点往外射就反了。
    //
    // 【⚠️ 每次施法只发射一次】
    // 本方法在 `hitWindow > 0` 时会被**每帧**调用（持续检测命中）。
    // 直接判定那段有 `hitIds` 去重，弹道这段原本没有任何"只做一次"的标志
    // → 实测：hitWindow=0.5、60fps 下 spawn 被调用 **30 次**（期望 1 次）。
    //
    // 60fps 下 0.5 秒窗口 = 30 枚弹道叠加，
    // 表现为"技能瞬间打出成百上千伤害"或"弹幕刷屏 + 性能雪崩"。
    // 因为每枚弹道都是合法生成的，日志和监控都显示正常，极难归因。
    if (def.projectile && this._deps.projectiles && !c.spawned) {
      c.spawned = true;
      const r = (c.facingDeg * Math.PI) / 180;
      this._deps.projectiles.spawn({
        x: c.casterX,
        y: c.casterY,
        dirX: Math.cos(r),
        dirY: Math.sin(r),
        speed: def.projectile.speed,
        lifetime: def.projectile.lifetime,
        mask: def.mask,
        mode: def.projectile.mode,
        pierce: def.projectile.pierce,
        data: { castId: c.castId, source: c.source, damage: def.projectile.damage },
      });
    }
  }

  /** 清空（切场景） */
  clear(): void {
    this._current = null;
    this._timelineHandle = null;
    this._skills.clear();
    this._cd.clear();
    this._charges.clear();
  }

  destroy(): void {
    this.clear();
  }
}
