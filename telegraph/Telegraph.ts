/**
 * Telegraph —— 攻击预警
 *
 * 【它解决什么】
 *
 * 玩家被 Boss 一击秒杀时，只有两种感受：
 * 1. **"我没看到"** → 需要预警
 * 2. **"我看到了但躲不掉"** → 预警时长不合理
 *
 * 预警（Telegraph / 预警圈）就是地面上的红圈、Boss 身上的蓄力光效。
 * 它把"不可预知的死亡"变成"我该躲但没躲好"。
 *
 * 【三个阶段的生命周期】
 * ```
 * windup（蓄力）→ active（判定生效）→ recover（后摇）→ done
 *     ↑ 预警显示        ↑ 只有这一帧真正判定
 * ```
 *
 * 【⚠️ 三条铁律】
 *
 * **① 视觉与判定必须用同一份形状**
 * `Telegraph.shape` 直接喂给 `HitboxWorld.query()`。
 * 各写一份参数就会出现"看着躲开了却被打中"。
 *
 * **② 判定位置在 active 开始时锁定**
 * 蓄力期间预警圈可以跟着 Boss 走（有追踪感），
 * 但**一旦进入 active，位置必须冻结**。
 * 否则玩家躲开了，判定圈却跟着他移动 → 必中且无法规避。
 *
 * **③ 时长要能被暂停/减速**
 * 所有计时走注入的 `dt`，不要用 `setTimeout`。
 * 否则暂停时 Boss 的蓄力仍在推进，取消暂停瞬间就被打中。
 *
 * 【使用示例】
 * ```typescript
 * const tg = new TelegraphSystem();
 *
 * const h = tg.spawn({
 *   shape: { kind: 'circle', radius: 2.5 },
 *   x: bossX, y: bossY,
 *   windup: 0.8,        // 0.8 秒预警
 *   active: 0.15,       // 判定窗口很短
 *   recover: 0.4,
 *   mask: LAYER_PLAYER,
 *   onActivate: (t) => {
 *     const hits = world.query(t.shape, t.x, t.y, t.rotation, t.mask);
 *     for (const h of hits) pipeline.apply({ raw: 40, hitId: `${t.id}` }, h.hitbox.data);
 *   },
 * });
 *
 * tg.tick(dt);   // dt 来自 Scheduler
 * ```
 */

/**
 * 判定形状（字段兼容 hitbox/Shape）
 *
 * 【为什么不直接 import】
 * 分层规则：telegraph 与 hitbox 同为第 1 层，禁止横向依赖。
 * 结构上保持一致，适配时直接传即可。
 */
import { numOr, safeDt } from '../_core/math';
export interface TelegraphShape {
  kind: 'circle' | 'rect' | 'sector' | 'capsule';
  radius?: number;
  halfW?: number;
  halfH?: number;
  angleDeg?: number;
  height?: number;
  offsetX?: number;
  offsetY?: number;
}

/** 预警配置 */
export interface TelegraphConfig {
  shape: TelegraphShape;
  /** 中心 X */
  x: number;
  /** 中心 Y */
  y: number;
  /** 朝向（度） */
  rotation?: number;

  /**
   * 蓄力时长（秒）——**预警显示的时长**
   *
   * 【参考值】（哈迪斯 / 黑暗之魂的经验）
   * - 小怪普通攻击：0.25 ~ 0.4s
   * - 精英怪重击：0.5 ~ 0.8s
   * - Boss 大招：1.0 ~ 1.5s
   *
   * 短于 0.2s 玩家基本反应不过来；长于 2s 会显得拖沓。
   */
  windup: number;

  /**
   * 判定生效时长（秒）
   *
   * 【为什么通常很短】
   * 判定窗口越长，玩家越容易"我没躲开但也没被打中"——手感发虚。
   * 瞬时判定（0.1~0.2s）最干脆。
   */
  active: number;

  /** 后摇时长（秒）：预警消失后施法者的硬直 */
  recover?: number;

  /**
   * 蓄力期间是否跟随施法者
   *
   * 【设计取舍】
   * - `true` 有"被锁定"的压迫感，但玩家必须一直跑（适合追踪弹）
   * - `false` 玩家躲开就安全（适合地面 AOE）
   *
   * **无论哪种，进入 active 后位置都会冻结**（铁律 ②）。
   */
  followCaster?: boolean;
  /** 跟随目标（提供实时位置） */
  caster?: { x: number; y: number };

  /** 碰撞掩码（进入 active 时查询用） */
  mask?: number;

  /** 进入 active 的回调：**在这里做真正的判定** */
  onActivate?: (t: Telegraph) => void;
  /** 结束回调（可用于播放"落空"特效） */
  onComplete?: (t: Telegraph, cancelled: boolean) => void;

  /** 附加数据 */
  data?: unknown;
}

/** 预警阶段 */
export type TelegraphPhase = 'windup' | 'active' | 'recover' | 'done';

/** 运行中的预警 */
export interface Telegraph {
  readonly id: number;
  readonly config: Readonly<TelegraphConfig>;
  phase: TelegraphPhase;

  /** 当前位置（active 阶段会被冻结） */
  x: number;
  y: number;
  rotation: number;

  /** 当前阶段已过时间 */
  phaseTime: number;
  /** 总经过时间 */
  age: number;
  /** 是否已结束 */
  done: boolean;
  /** 是否被取消（打断） */
  cancelled: boolean;

  data?: unknown;
}

let _nextTgId = 1;

/**
 * 预警系统
 *
 * 【与 BuffSystem / SkillPlayer 的分工】
 * - SkillPlayer：播放技能时间轴（动画、音效、多段判定）
 * - Telegraph：**单个**攻击的预警与判定窗口
 * - 两者可组合：时间轴的某个事件里 spawn 一个 Telegraph
 */
export class TelegraphSystem {
  private _list: Telegraph[] = [];

  /** 活跃数量 */
  get count(): number {
    return this._list.length;
  }

  all(): readonly Telegraph[] {
    return this._list;
  }

  /** 创建一个预警 */
  spawn(cfg: TelegraphConfig): Telegraph {
    const t: Telegraph = {
      id: _nextTgId++,
      config: cfg,
      phase: 'windup',
      x: cfg.x,
      y: cfg.y,
      rotation: cfg.rotation ?? 0,
      phaseTime: 0,
      age: 0,
      done: false,
      cancelled: false,
      data: cfg.data,
    };
    this._list.push(t);
    return t;
  }

  /**
   * 每帧更新
   *
   * @param dt 缩放后的 dt（**必须**来自统一时间源，暂停时为 0）
   */
  tick(dt: number): void {
    if (!safeDt(dt)) return;

    // 【倒序遍历】onActivate 回调里可能 spawn 新的预警
    for (let i = this._list.length - 1; i >= 0; i--) {
      const t = this._list[i];
      if (t.done) {
        this._list.splice(i, 1);
        continue;
      }

      this._advance(t, dt);
      if (t.done) this._list.splice(i, 1);
    }
  }

  private _advance(t: Telegraph, dt: number): void {
    const cfg = t.config;
    t.age += dt;
    t.phaseTime += dt;

    // 蓄力期间跟随施法者
    if (t.phase === 'windup' && cfg.followCaster && cfg.caster) {
      t.x = cfg.caster.x;
      t.y = cfg.caster.y;
    }

    // 【一帧内可能跨过多个阶段】
    // 低帧率（20fps）时 dt=0.05，可能一帧就跨过整个 active 窗口。
    // 用 while 循环而不是 if，保证 active 一定被触发到。
    let guard = 0;
    while (!t.done && guard++ < 8) {
      const remain = phaseDuration(t);
      if (t.phaseTime < remain) break;

      const overshoot = t.phaseTime - remain;
      this._nextPhase(t, overshoot);
    }
  }

  private _nextPhase(t: Telegraph, overshoot: number): void {
    if (t.phase === 'windup') {
      t.phase = 'active';
      t.phaseTime = overshoot;

      // 【位置在这一刻冻结】
      // 之后即使 followCaster 为 true 也不再更新——
      // 否则玩家躲开后判定圈还跟着他，变成必中。
      t.config.onActivate?.(t);
      return;
    }

    if (t.phase === 'active') {
      t.phase = 'recover';
      t.phaseTime = overshoot;
      return;
    }

    if (t.phase === 'recover') {
      t.phase = 'done';
      t.done = true;
      t.config.onComplete?.(t, t.cancelled);
    }
  }

  /** 取消（Boss 被打断、死亡） */
  cancel(id: number): boolean {
    const t = this._list.find((x) => x.id === id);
    if (!t || t.done) return false;
    t.cancelled = true;
    t.done = true;
    t.phase = 'done';
    t.config.onComplete?.(t, true);
    return true;
  }

  /** 全部取消（切场景 / Boss 死亡） */
  cancelAll(): number {
    let n = 0;
    for (const t of this._list) {
      if (t.done) continue;
      t.cancelled = true;
      t.done = true;
      t.phase = 'done';
      t.config.onComplete?.(t, true);
      n++;
    }
    this._list.length = 0;
    return n;
  }

  clear(): void {
    this._list.length = 0;
  }

  destroy(): void {
    this.clear();
  }
}

/**
 * 当前阶段的总时长
 *
 * 【为什么是模块级函数而不是方法】
 * `Telegraph` 是纯数据接口（便于存档/网络传输），
 * 不挂方法。渲染层也需要用它算进度。
 */
export function phaseDuration(t: Telegraph): number {
  switch (t.phase) {
    case 'windup': return Math.max(0, numOr(t.config.windup, 0));
    case 'active': return Math.max(0, numOr(t.config.active, 0));
    case 'recover': return t.config.recover ?? 0;
    default: return 0;
  }
}

/**
 * 获取预警进度（0..1）——渲染层用来画填充动画
 *
 * 【为什么需要】
 * 地面红圈从空心填充到实心，玩家能直观感到"快来了"。
 * 这个进度必须由**逻辑层**给，渲染层自己算会和判定不同步。
 */
export function telegraphProgress(t: Telegraph): number {
  const dur = Math.max(1e-6, phaseDuration(t));
  return t.phase === 'done' ? 1 : Math.min(1, t.phaseTime / dur);
}

/**
 * 是否处于"危险"阶段（渲染层用来闪红 / 播放警报音）
 */
export function isDangerous(t: Telegraph): boolean {
  return t.phase === 'windup' && telegraphProgress(t) > 0.7;
}
