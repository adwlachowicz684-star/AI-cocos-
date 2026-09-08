/**
 * perception/Perception.ts —— 感知系统（敌人的"眼睛和耳朵"）
 *
 * 【它解决什么】
 *
 * 敌人什么时候发现玩家？
 *
 * 朴素做法：`if (distance(enemy, player) < 10) chase()`
 *
 * 这个写法会让玩家极其难受：
 * - 隔着墙也能"看见"你
 * - 从背后走过去它也能立刻察觉
 * - 一旦进入范围就永久锁定，躲到天涯海角也甩不掉
 * - 一个怪发现你，全场怪瞬间都知道（没有传播延迟）
 *
 * 感知系统把这些拆开：
 * - **视觉**：距离 + 视野角度 + 视线遮挡 + 光照/隐蔽
 * - **听觉**：声音事件（跑步、开枪、打碎东西），穿墙但衰减
 * - **记忆**：目标消失后还能记住最后位置一段时间
 * - **警觉度**：0→1 的累积条，满了才进入战斗
 * - **传播**：一个怪发现目标，附近同伴延迟一段时间后才知道
 *
 * 【为什么重要】
 * 潜行玩法、包抄 AI、"背刺"手感全都建立在这上面。
 * 它是"敌人聪明"和"敌人开挂"的分界线。
 *
 * 【零业务依赖】
 *
 * 它不认识玩家、不认识敌人。感知者与被感知者都只是**带位置的数字 id**，
 * 位置与朝向通过回调/更新注入。
 * 视线检测用 `ILineOfSight` 接口（可接 `fov/` 的 Shadowcasting，也可自己实现）。
 */
import { normalizeAngleRad, numOr, safeDt } from '../_core/math';
import type { IRandomSource } from '../_core/types';
import { MathRandomSource } from '../_core/types';

// ============================================================
// 数据结构
// ============================================================

/** 感知刺激类型 */
export type StimulusType =
  /** 视觉：看见目标 */
  | 'sight'
  /** 听觉：听到声音 */
  | 'sound'
  /** 伤害：被打了（无条件察觉） */
  | 'damage'
  /** 队友警报：同伴发现了目标 */
  | 'ally-alert';

/** 一次感知刺激 */
export interface Stimulus {
  readonly type: StimulusType;
  /** 来源实体 id（听觉/伤害时为发出者） */
  readonly sourceId: number;
  /** 世界坐标 */
  readonly x: number;
  readonly y: number;
  /**
   * 强度（0~1）
   *
   * 【典型值】
   * - 走路 0.2、跑步 0.6、开枪 1.0、爆炸 1.0
   * - 视觉刺激的强度由可见度决定
   */
  readonly intensity: number;
  /**
   * 传播半径
   *
   * 【注意】听觉能穿墙，所以半径通常比视觉大
   */
  readonly radius: number;
}

/** 感知者配置 */
export interface PerceiverConfig {
  /** 视距 */
  readonly sightRange: number;
  /**
   * 视野半角（弧度）
   *
   * 【典型值】
   * - π（180°）= 半圆，人形敌人常见
   * - 2π = 全向（炮台、眼睛类怪物）
   * - π/4 = 窄视野（需要转身扫描）
   */
  readonly sightHalfAngle: number;
  /**
   * 背后感知距离
   *
   * 【为什么需要】
   * 视野角度为 0 时，敌人对正后方完全无知——
   * 玩家贴着它后背走它也没反应，这很假。
   * 给一个小半径（如 2 米）作为"感觉到身边有人"。
   */
  readonly proximityRange?: number;
  /** 听觉灵敏度倍率（默认 1）。设为 0 = 聋子 */
  readonly hearingScale?: number;
  /**
   * 警觉度累积速度（每秒，默认 1.0）
   *
   * 【手感】
   * 0.5 = 慢热，玩家有时间躲回阴影
   * 2.0 = 警觉，几乎立刻发现
   */
  readonly alertGain?: number;
  /** 警觉度衰减速度（每秒，默认 0.5） */
  readonly alertDecay?: number;
  /** 记忆时长（秒，默认 4）。目标消失后还记得多久 */
  readonly memoryTime?: number;
}

/** 感知者运行时状态 */
export interface PerceptionState {
  /** 当前警觉度 0~1 */
  alert: number;
  /** 是否已达"发现"阈值（进入战斗） */
  aware: boolean;
  /** 当前锁定目标 id，-1 = 无 */
  targetId: number;
  /** 最后已知目标位置 */
  lastKnownX: number;
  lastKnownY: number;
  /** 记忆剩余时间 */
  memoryLeft: number;
  /** 连续可见时长（用于"确认"延迟） */
  visibleTime: number;
  /**
   * suspicious 事件是否已发过（避免每帧刷屏）
   *
   * 只在 alert 归零时重置，所以同一次"发现过程"只提示一次。
   */
  suspiciousFired: boolean;
}

/**
 * 可疑阈值：警觉度超过它就该有"察觉"表现（转头、停步、举武器）
 *
 * 【为什么比 spotted 低】
 * 玩家需要**预警**才能做出反应。
 * 如果只有"完全发现"才有表现，玩家会觉得敌人是瞬移过来的。
 */
const SUSPICION_LEVEL = 0.15;

/**
 * 近场比例：半径内侧这个比例内，声音不衰减
 *
 * 【为什么不是 0】
 * 见 `_applyStimulus` 中 sound 分支的注释——
 * 完全连续的衰减曲线会让"贴近"的情形永远差一点点达不到阈值。
 * 留一段近场，让"很近"这件事有确定的语义。
 */
const NEAR_FIELD_RATIO = 0.1;

/**
 * 声音响度衰减：近场满强度，之后二次滚降，边缘归零
 *
 * @returns 0~1 的响度系数
 */
export function soundFalloff(dist: number, radius: number): number {
  if (!(radius > 0)) return 0;
  if (dist < 0) return 1;

  const near = radius * NEAR_FIELD_RATIO;
  if (dist <= near) return 1;

  const t = (dist - near) / (radius - near);
  if (t >= 1) return 0;
  return 1 - t * t;
}

/** 感知事件 */
export type PerceptionEvent =
  /** 首次发现目标 */
  | { type: 'spotted'; selfId: number; targetId: number; x: number; y: number }
  /** 目标离开感知（进入记忆） */
  | { type: 'lost'; selfId: number; targetId: number; x: number; y: number }
  /** 记忆彻底过期（回去巡逻） */
  | { type: 'forgot'; selfId: number; targetId: number }
  /** 被刺激影响但还没发现（可疑） */
  | { type: 'suspicious'; selfId: number; x: number; y: number };

// ============================================================
// 视线检测接口（注入）
// ============================================================

/**
 * 视线检测
 *
 * 【为什么注入】
 * 遮挡判定依赖地图表示（格子 / 导航网格 / 物理射线），
 * 每种游戏都不一样。注入后本模块保持零依赖。
 *
 * 【接 fov 插件的示例】
 * ```typescript
 * const fov = new Shadowcasting(w, h, isWall);
 * const los: ILineOfSight = {
 *   visible: (x0, y0, x1, y1) => fov.compute(x0, y0, dist) && fov.visible.has(x1, y1)
 * };
 * ```
 */
export interface ILineOfSight {
  /** 从 (x0,y0) 能否看到 (x1,y1) */
  visible(x0: number, y0: number, x1: number, y1: number): boolean;
}

/** 无障碍视线（测试 / 开阔场地用） */
export const OpenLineOfSight: ILineOfSight = {
  visible: () => true,
};

// ============================================================
// 配置
// ============================================================

export interface PerceptionSystemOptions {
  /** 视线检测 */
  readonly los: ILineOfSight;
  /**
   * 感知抖动幅度（0~1，默认 0.3）
   *
   * 【用途】避免同型号敌人在同一帧集体发现玩家——
   * 那看起来像机器而不是一群人。
   *
   * 【⚠️ 抖动不是"只影响观感"，它决定敌人第几帧发现玩家】
   *
   * 旧注释写着"抖动只影响观感，不需要可复现"——**这个前提是错的**。
   * 抖动后的 `bestVisibility` 直接进了 `st.alert` 的累积：
   *
   * ```
   * st.alert += bestVisibility * gain * dt      // 抖动后的值
   * if (st.alert >= threshold) → aware = true，发 spotted 事件
   * ```
   *
   * 实测（jitter=0.3，同一初始状态跑 12 次）：
   * 敌人"发现玩家"所需帧数是 **48~53 帧**，每次都不一样。
   *
   * 这不是观感问题，是**玩法结果的分叉**：
   * - 潜行玩法里"能不能溜过去"由这几帧决定
   * - 回放 / 锁步：同一份输入两次跑出不同结果
   * - 反作弊：客户端的结果无法被服务端复算验证
   *
   * 所以抖动必须可注入、可固定。见 {@link PerceptionSystemOptions.jitterRng}。
   */
  readonly jitter?: number;
  /**
   * 抖动用的随机源（**独立于主 rng**）
   *
   * 【为什么是独立的，而不是复用主 rng】
   *
   * 旧注释的第二条论证其实是对的：抖动若消耗主 rng 序列，
   * 会打乱其他依赖 rng 的逻辑（掉落、刷怪），让回放对不上。
   * 所以这里要的是**另一条序列**，不是"复用主序列"。
   *
   * 【默认行为】不传时用 `MathRandomSource`（等价于旧的 `Math.random()`），
   * 保持向后兼容；需要可复现时注入固定种子源（回放、锁步、服务端校验）。
   *
   * @example
   * ```typescript
   * // 回放 / 锁步：固定种子，保证两次跑出同一结果
   * new PerceptionSystem({ los, jitterRng: new RNG(seed) });
   * ```
   */
  readonly jitterRng?: IRandomSource;
  /**
   * 进入"发现"状态的警觉阈值（默认 1.0）
   *
   * 配合 alertGain 控制"多快发现玩家"。
   */
  readonly awareThreshold?: number;
  /**
   * 警觉度传播的延迟（秒，默认 0.8）
   *
   * 【用途】一个怪发现玩家后，同伴**延迟**才响应。
   * 没有这个延迟，玩家一被发现整个营地瞬间全扑上来，
   * 玩家会觉得"敌人开挂"。
   */
  readonly allyAlertDelay?: number;
  /** 传播半径（默认 12） */
  readonly allyAlertRadius?: number;
  /** 事件回调 */
  onEvent?: (e: PerceptionEvent) => void;
}

interface Perceiver {
  readonly id: number;
  readonly cfg: PerceiverConfig;
  x: number;
  y: number;
  /** 朝向（弧度）。全向感知的敌人可以随便填 */
  facing: number;
  state: PerceptionState;
}

/** 待传播的同伴警报 */
interface PendingAlert {
  at: number;
  x: number;
  y: number;
  targetId: number;
  /** 已接收者，避免重复 */
  delivered: Set<number>;
}

// ============================================================
// 实现
// ============================================================

export class PerceptionSystem {
  private readonly _los: ILineOfSight;
  private readonly _threshold: number;
  private readonly _allyDelay: number;
  private readonly _allyRadius: number;
  private readonly _jitter: number;
  /** 抖动的独立随机源（不消耗主 rng 序列） */
  private readonly _jitterRng: IRandomSource;

  private readonly _perceivers = new Map<number, Perceiver>();
  /** 被感知目标：id → 位置 */
  private readonly _targets = new Map<number, { x: number; y: number }>();
  /** 待处理的刺激（下一帧统一处理） */
  private _stimuli: Stimulus[] = [];
  private _pendingAlerts: PendingAlert[] = [];
  private _time = 0;

  onEvent?: (e: PerceptionEvent) => void;

  constructor(opts: PerceptionSystemOptions) {
    this._los = opts.los;
    this._threshold = opts.awareThreshold ?? 1;
    this._allyDelay = opts.allyAlertDelay ?? 0.8;
    this._allyRadius = opts.allyAlertRadius ?? 12;
    this._jitter = Math.max(0, Math.min(1, numOr(opts.jitter, 0.3)));
    this._jitterRng = opts.jitterRng ?? MathRandomSource;
    this.onEvent = opts.onEvent;
  }

  // ---- 注册 ----

  /** 注册一个感知者（敌人） */
  addPerceiver(id: number, cfg: PerceiverConfig, x: number, y: number, facing = 0): void {
    if (this._perceivers.has(id)) {
      throw new Error(`[Perception] 感知者 id 重复：${id}`);
    }
    this._perceivers.set(id, {
      id,
      cfg,
      x,
      y,
      facing,
      state: {
        alert: 0,
        aware: false,
        targetId: -1,
        lastKnownX: x,
        lastKnownY: y,
        memoryLeft: 0,
        visibleTime: 0,
        suspiciousFired: false,
      },
    });
  }

  /** 注册/更新一个可被感知的目标（玩家、诱饵） */
  addTarget(id: number, x: number, y: number): void {
    this._targets.set(id, { x, y });
  }

  removeTarget(id: number): void {
    this._targets.delete(id);
  }

  removePerceiver(id: number): void {
    this._perceivers.delete(id);
  }

  /** 更新位置 */
  setPosition(id: number, x: number, y: number, facing?: number): void {
    const p = this._perceivers.get(id);
    if (p) {
      p.x = x;
      p.y = y;
      if (facing !== undefined) p.facing = facing;
      return;
    }
    const t = this._targets.get(id);
    if (t) {
      t.x = x;
      t.y = y;
    }
  }

  // ---- 查询 ----

  stateOf(id: number): PerceptionState | undefined {
    return this._perceivers.get(id)?.state;
  }

  isAware(id: number): boolean {
    return this._perceivers.get(id)?.state.aware ?? false;
  }

  targetOf(id: number): number {
    return this._perceivers.get(id)?.state.targetId ?? -1;
  }

  alertOf(id: number): number {
    return this._perceivers.get(id)?.state.alert ?? 0;
  }

  /** 最后已知位置（用于"去最后看到的地方搜索"） */
  lastKnownPosition(id: number): { x: number; y: number } | null {
    const s = this._perceivers.get(id)?.state;
    if (!s || s.memoryLeft <= 0) return null;
    return { x: s.lastKnownX, y: s.lastKnownY };
  }

  // ---- 刺激 ----

  /**
   * 广播一个刺激（下一帧生效）
   *
   * 【为什么延迟一帧】
   * 立即处理会让"谁先注册谁先响应"影响结果，
   * 且与帧内顺序耦合——难以测试、难以复现。
   * 统一延迟到 tick 处理，行为是确定的。
   */
  emit(s: Stimulus): void {
    this._stimuli.push(s);
  }

  /** 便捷方法：发出声音 */
  emitSound(sourceId: number, x: number, y: number, intensity: number, radius: number): void {
    this.emit({ type: 'sound', sourceId, x, y, intensity, radius });
  }

  // ---- 主循环 ----

  tick(dt: number): void {
    if (!safeDt(dt)) return;
    this._time += dt;

    // ① 处理延迟的同伴警报
    this._processPendingAlerts();

    // ② 处理刺激
    if (this._stimuli.length > 0) {
      const batch = this._stimuli;
      this._stimuli = [];
      for (const s of batch) this._applyStimulus(s);
    }

    // ③ 视觉检测（每帧都要做，这才是最主要的感知途径）
    for (const p of this._perceivers.values()) {
      this._checkSight(p, dt);
    }

    // ④ 警觉度衰减与记忆过期
    for (const p of this._perceivers.values()) {
      this._decay(p, dt);
    }
  }

  // ---- 内部 ----

  private _checkSight(p: Perceiver, dt: number): void {
    let bestTarget = -1;
    let bestVisibility = 0;
    let bx = 0;
    let by = 0;

    for (const [tid, t] of this._targets) {
      const v = this._visibility(p, t.x, t.y);
      if (v > bestVisibility) {
        bestVisibility = v;
        bestTarget = tid;
        bx = t.x;
        by = t.y;
      }
    }

    const st = p.state;

    /**
     * 【感知抖动】
     * 给可见度加一点噪声，避免同型号的敌人**帧同步**地发现玩家。
     *
     * 没有抖动时，一排哨兵会在同一帧集体转身——
     * 看起来像机器而不是一群人。
     *
     * 【⚠️ 旧注释说"只影响观感、所以用 Math.random"——这是错的】
     * 抖动后的值会进 `st.alert` 累积，进而决定 `aware` 状态与
     * `spotted` 事件的时机。实测同样的初始状态，
     * 发现玩家的帧数在 48~53 之间波动。
     *
     * 所以这里走**可注入的独立随机源**（`_jitterRng`）：
     * - 独立 → 不消耗主 rng 序列，不打乱掉落/刷怪的回放
     * - 可注入 → 回放/锁步/服务端校验时能固定下来
     *
     * 默认 `MathRandomSource`，与旧行为等价。
     */
    if (bestVisibility > 0 && this._jitter > 0) {
      bestVisibility *= 1 - this._jitter + this._jitterRng.next() * this._jitter * 2;
      if (bestVisibility > 1) bestVisibility = 1;
      if (bestVisibility < 0) bestVisibility = 0;
    }

    if (bestTarget >= 0 && bestVisibility > 0) {
      // 【为什么要在覆盖 lastKnown 之前先存旧目标】
      // `lastKnownX/Y` 是本帧新目标的位置，
      // 而 `lost` 事件要报的是**旧目标**最后在哪——
      // 顺序写反的话，业务侧会收到"玩家在诱饵位置失踪"这种错数据。
      const prevTarget = st.targetId;
      const prevX = st.lastKnownX;
      const prevY = st.lastKnownY;

      st.visibleTime += dt;
      st.lastKnownX = bx;
      st.lastKnownY = by;
      st.memoryLeft = p.cfg.memoryTime ?? 4;

      // 警觉度累积：可见度越高、越近，涨得越快
      const gain = p.cfg.alertGain ?? 1;
      st.alert = Math.min(this._threshold, st.alert + bestVisibility * gain * dt);

      /**
       * 【换目标要发 lost，旧目标是"静默消失"的】
       *
       * 旧实现是两个分支体完全相同的 if/else（`if (a && b) x = c; else x = c;`），
       * 读代码的人会以为"两支不同，只是刚好长得像"，
       * 从而忽略真正缺的东西：**旧目标没有任何事件**。
       *
       * 后果：`targetId` 从玩家换成诱饵时，业务侧只会看到"还在战斗"，
       * 而"玩家已经脱离视野"这件事从不发生——
       * 表现为"敌人明明看着诱饵，BGM 却还在战斗状态"、
       * "玩家的潜行 UI 一直显示已被发现"。
       *
       * 现在切换前补一条 `lost`（位置用旧目标的最后已知位置）。
       */
      if (prevTarget >= 0 && prevTarget !== bestTarget) {
        this.onEvent?.({
          type: 'lost',
          selfId: p.id,
          targetId: prevTarget,
          x: prevX,
          y: prevY,
        });
      }
      st.targetId = bestTarget;

      /**
       * 【⚠️ 曾经的 bug：视觉路径从不发 suspicious 事件】
       *
       * `suspicious` 只在 `_applyStimulus` 里发，
       * 于是靠"看见"发现玩家时，业务侧只会收到 `spotted`——
       * 没有"敌人好像察觉到什么"的中间态。
       *
       * 后果：敌人转身看向玩家、举起武器示警这类
       * **最重要的预警表现**没有触发时机，
       * 玩家看到的是"敌人毫无征兆地突然冲过来"。
       *
       * 用一个一次性标记，避免每帧刷屏。
       */
      if (!st.aware && !st.suspiciousFired && st.alert >= SUSPICION_LEVEL) {
        st.suspiciousFired = true;
        this.onEvent?.({ type: 'suspicious', selfId: p.id, x: bx, y: by });
      }

      if (!st.aware && st.alert >= this._threshold) {
        st.aware = true;
        this.onEvent?.({ type: 'spotted', selfId: p.id, targetId: bestTarget, x: bx, y: by });
        this._scheduleAllyAlert(p, bx, by, bestTarget);
      }
    } else {
      st.visibleTime = 0;
    }
  }

  /**
   * 计算可见度 0~1
   *
   * 【四个因素相乘，任一为 0 就完全看不见】
   * 1. 距离衰减（超出视距 = 0）
   * 2. 视野角度（背后的目标 = 0，除非在 proximityRange 内）
   * 3. 视线遮挡（有墙 = 0）
   * 4. 感知抖动（避免所有敌人同步）
   *
   * 【⚠️ 这一项不是"观感修饰"，它会影响 alert 的累积速度】
   * 见 {@link PerceptionSystemOptions.jitter} 的说明——
   * 抖动用的是**可注入的独立随机源**，不是 Math.random。
   */
  private _visibility(p: Perceiver, tx: number, ty: number): number {
    const dx = tx - p.x;
    const dy = ty - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // ① 距离
    const range = p.cfg.sightRange;
    if (dist > range) return 0;
    const distFactor = 1 - dist / range;

    // ② 角度
    let angleFactor = 1;
    const prox = p.cfg.proximityRange ?? 0;
    if (dist > prox && p.cfg.sightHalfAngle < Math.PI) {
      const ang = Math.atan2(dy, dx);
      let diff = ang - p.facing;
      /**
       * 【⚠️ 用取模归一化，不能用 while 递减】
       *
       * 原实现：`while (diff > Math.PI) diff -= Math.PI * 2;`
       * `Infinity - 2π` 仍等于 `Infinity`，循环条件恒真 → **死循环**。
       *
       * 实测：给 perceiver 设 `facing = Infinity` 后调用 `tick()`，
       * 进程 CPU 100% 永久卡死（`timeout 8` 退出码 124）。
       * facing 通常来自 `Math.atan2` 或外部传入的朝向角，
       * 一旦上游产生 NaN/Infinity 就会触发。
       *
       * 改用 `normalizeAngleRad`（O(1) 取模，结构上不可能死循环），
       * 且它把非有限值归一到 0——让判定确定可解释，而非 NaN 静默失效。
       */
      diff = normalizeAngleRad(diff);
      const ad = Math.abs(diff);
      if (ad > p.cfg.sightHalfAngle) return 0;
      // 视野边缘的可见度低（余光）
      angleFactor = 1 - (ad / p.cfg.sightHalfAngle) * 0.5;
    } else if (dist <= prox && prox > 0) {
      // 贴身感知：不看朝向，但强度打折
      angleFactor = 0.7;
    }

    // ③ 遮挡
    if (!this._los.visible(p.x, p.y, tx, ty)) return 0;

    return Math.max(0, Math.min(1, distFactor * angleFactor));
  }

  private _applyStimulus(s: Stimulus): void {
    for (const p of this._perceivers.values()) {
      const dx = s.x - p.x;
      const dy = s.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let factor = 0;

      switch (s.type) {
        case 'sound': {
          if (dist > s.radius) continue;
          const hear = p.cfg.hearingScale ?? 1;
          if (hear <= 0) continue;
          /**
           * 【⚠️ 声音衰减踩过两个坑】
           *
           * **坑一：线性衰减让中距离声音永远不够响**
           * 半径 30 米处开枪，8 米外的敌人只收到 0.73 强度。
           * 这个数**永远达不到 1.0 的察觉阈值**，
           * 于是"听到枪声"只会让敌人可疑一下然后衰减归零——
           * 玩家发现"开枪完全引不来敌人"，潜行玩法的反馈链断了。
           *
           * **坑二：改成二次衰减后，近场仍然差一点点**
           * 0.5 米处开枪 → 0.99972，还是 < 1.0。
           * 差 0.00028 却导致"贴着敌人开枪它也不理你"，
           * 这种浮点边界问题极难排查——
           * 单看每个数字都合理，合起来结果完全错误。
           *
           * 【现在的模型：近场不衰减 + 之后二次衰减】
           * 半径的内侧 10% 视为**近场**，在这个范围内响度不打折；
           * 超出近场后按二次曲线滚降到边缘为 0。
           *
           * 这既符合直觉（贴脸的声音就是"很响"，没有渐变），
           * 也让"在敌人旁边开枪"有**确定的**后果，
           * 而不是依赖浮点数的运气。
           */
          factor = soundFalloff(dist, s.radius) * s.intensity * hear;
          break;
        }
        case 'damage': {
          // 被打无条件察觉（不然玩家能白嫖）
          if (dist > s.radius) continue;
          factor = s.intensity;
          break;
        }
        case 'ally-alert': {
          if (dist > s.radius) continue;
          factor = s.intensity;
          break;
        }
        case 'sight': {
          // 外部直接注入"被看见了"，跳过几何计算
          if (!this._los.visible(p.x, p.y, s.x, s.y)) continue;
          if (dist > s.radius) continue;
          factor = (1 - dist / s.radius) * s.intensity;
          break;
        }
      }

      if (factor <= 0) continue;

      const st = p.state;
      const before = st.alert;
      st.alert = Math.min(this._threshold, st.alert + factor);

      // 记录可疑位置（即使没发现）
      st.lastKnownX = s.x;
      st.lastKnownY = s.y;
      st.memoryLeft = Math.max(st.memoryLeft, numOr(p.cfg.memoryTime, 4));

      if (st.alert > before && !st.aware) {
        this.onEvent?.({ type: 'suspicious', selfId: p.id, x: s.x, y: s.y });
      }

      if (!st.aware && st.alert >= this._threshold) {
        st.aware = true;
        st.targetId = s.sourceId;
        this.onEvent?.({ type: 'spotted', selfId: p.id, targetId: s.sourceId, x: s.x, y: s.y });
        this._scheduleAllyAlert(p, s.x, s.y, s.sourceId);
      }
    }
  }

  /**
   * 安排一次延迟的同伴警报
   *
   * 【为什么延迟】
   * 立即传播 = 玩家一被发现，全营地瞬间扑上来。
   * 玩家会觉得"这游戏敌人会读心"。
   *
   * 给 0.5~1.5 秒延迟，玩家能听到敌人喊叫、
   * 看到它们陆续反应——**这个"陆续"就是紧张感的来源**。
   */
  private _scheduleAllyAlert(from: Perceiver, x: number, y: number, targetId: number): void {
    this._pendingAlerts.push({
      at: this._time + this._allyDelay,
      x,
      y,
      targetId,
      delivered: new Set([from.id]),
    });
  }

  private _processPendingAlerts(): void {
    if (this._pendingAlerts.length === 0) return;

    const ready: PendingAlert[] = [];
    const rest: PendingAlert[] = [];
    for (const a of this._pendingAlerts) {
      if (a.at <= this._time) ready.push(a);
      else rest.push(a);
    }
    this._pendingAlerts = rest;

    for (const a of ready) {
      for (const p of this._perceivers.values()) {
        if (a.delivered.has(p.id)) continue;
        const dx = a.x - p.x;
        const dy = a.y - p.y;
        if (Math.sqrt(dx * dx + dy * dy) > this._allyRadius) continue;

        a.delivered.add(p.id);
        this.emit({
          type: 'ally-alert',
          sourceId: a.targetId,
          x: a.x,
          y: a.y,
          intensity: 0.6,
          radius: this._allyRadius,
        });
      }
    }
  }

  private _decay(p: Perceiver, dt: number): void {
    const st = p.state;

    // 记忆倒计时
    if (st.memoryLeft > 0) {
      st.memoryLeft -= dt;
      if (st.memoryLeft <= 0) {
        st.memoryLeft = 0;
        if (st.aware) {
          st.aware = false;
          this.onEvent?.({ type: 'lost', selfId: p.id, targetId: st.targetId, x: st.lastKnownX, y: st.lastKnownY });
        }
      }
    }

    // 警觉度衰减
    const sawSomething = st.visibleTime > 0;
    if (!sawSomething && st.alert > 0) {
      const decay = p.cfg.alertDecay ?? 0.5;
      st.alert = Math.max(0, st.alert - decay * dt);

      // 衰减到 0 且记忆也没了 → 彻底忘记
      if (st.alert <= 0) st.suspiciousFired = false;
      if (st.alert <= 0 && st.memoryLeft <= 0 && st.targetId >= 0) {
        this.onEvent?.({ type: 'forgot', selfId: p.id, targetId: st.targetId });
        st.targetId = -1;
      }
    }
  }

  /** 强制让某个感知者立刻发现目标（剧情触发、被发现作弊时用） */
  forceSpot(selfId: number, targetId: number, x: number, y: number): void {
    const p = this._perceivers.get(selfId);
    if (!p) return;
    const st = p.state;
    const wasAware = st.aware;
    st.alert = this._threshold;
    st.aware = true;
    st.targetId = targetId;
    st.lastKnownX = x;
    st.lastKnownY = y;
    st.memoryLeft = p.cfg.memoryTime ?? 4;
    if (!wasAware) {
      this.onEvent?.({ type: 'spotted', selfId, targetId, x, y });
      this._scheduleAllyAlert(p, x, y, targetId);
    }
  }

  /** 强制失忆（玩家躲进柜子、隐身成功） */
  forceForget(selfId: number): void {
    const p = this._perceivers.get(selfId);
    if (!p) return;
    const st = p.state;
    st.alert = 0;
    st.aware = false;
    st.visibleTime = 0;
    st.memoryLeft = 0;
    st.suspiciousFired = false;
    if (st.targetId >= 0) {
      this.onEvent?.({ type: 'forgot', selfId, targetId: st.targetId });
      st.targetId = -1;
    }
  }

  /**
   * 卸载（rule5）
   *
   * 【为什么 `reset()` 不够】
   * `reset()` 只把每个感知者的**状态**换掉，
   * `_perceivers` / `_targets` 两个 Map 里仍然挂着一整张感知图：
   * 敌人对象、玩家对象、以及它们的位置引用。
   * 换场景时如果不逐个 `removePerceiver`，
   * 整个感知图会跟着系统对象一起滞留到下一次 GC。
   *
   * 另外 `onEvent` 是个外部闭包——只要还挂着，
   * 闭包引用的整条作用域链（通常是整个战斗场景）都不会被回收。
   *
   * 【destroy 之后对象的状态】
   * 感知者与目标都清空，`tick()` 退化成空转；
   * 想继续用请重新构造。
   */
  destroy(): void {
    this._perceivers.clear();
    this._targets.clear();
    this._stimuli.length = 0;
    this._pendingAlerts.length = 0;
    this._time = 0;
    this.onEvent = undefined;
  }

  /** 清空（回合计/关卡切换） */
  reset(): void {
    this._stimuli.length = 0;
    this._pendingAlerts.length = 0;
    this._time = 0;
    for (const p of this._perceivers.values()) {
      p.state = {
        alert: 0,
        aware: false,
        targetId: -1,
        lastKnownX: p.x,
        lastKnownY: p.y,
        memoryLeft: 0,
        visibleTime: 0,
        suspiciousFired: false,
      };
    }
  }

  get time(): number {
    return this._time;
  }
}

// ============================================================
// 预设配置
// ============================================================

/**
 * 常见敌人的感知预设
 *
 * 【为什么提供预设】
 * 手写这些数值很容易配出"要么全瞎要么全开挂"的敌人。
 * 预设是可用的起点，改一两个字段即可。
 */
export const PerceptionPresets = {
  /** 标准人形：半圆视野，中等警觉 */
  humanoid: {
    sightRange: 12,
    sightHalfAngle: Math.PI * 0.5,
    proximityRange: 2.5,
    hearingScale: 1,
    alertGain: 1,
    alertDecay: 0.5,
    memoryTime: 4,
  } as PerceiverConfig,

  /** 哨兵：视野远而窄，需要转身扫描 */
  sentry: {
    sightRange: 20,
    sightHalfAngle: Math.PI * 0.25,
    proximityRange: 1.5,
    hearingScale: 0.6,
    alertGain: 1.6,
    alertDecay: 0.3,
    memoryTime: 8,
  } as PerceiverConfig,

  /** 炮台/眼睛：全向，但不会追（通常由行为树决定） */
  turret: {
    sightRange: 10,
    sightHalfAngle: Math.PI,
    proximityRange: 0,
    hearingScale: 0,
    alertGain: 2.0,
    alertDecay: 0.8,
    memoryTime: 2,
  } as PerceiverConfig,

  /** 迟钝的重甲：反应慢，但记住你很久 */
  brute: {
    sightRange: 9,
    sightHalfAngle: Math.PI * 0.4,
    proximityRange: 3,
    hearingScale: 1.4,
    alertGain: 0.6,
    alertDecay: 0.25,
    memoryTime: 10,
  } as PerceiverConfig,
} as const;
