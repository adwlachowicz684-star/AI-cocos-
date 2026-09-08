/**
 * skill-queue · 技能排队与 CD 补发
 *
 * ============================================================
 * 【它解决什么】
 * ============================================================
 * 技能 CD 还剩 0.1 秒，玩家点了。然后——什么都没发生。
 *
 * 玩家会觉得"我按了没反应"，于是再按一次、再按一次。
 * 实际上他按了三次，只放出一个，而且手感极差。
 *
 * 这不是玩家的错，是**输入被丢弃**了：
 *
 * ```typescript
 * // ❌ 朴素接法：输入在这里被吃掉
 * if (buf.consume('fire')) {
 *   caster.tryCast('fire', ctx);   // CD 还差 0.08s → 失败，但缓冲已经没了
 * }
 * ```
 *
 * 正确做法要满足三件事：
 *
 *   ① 失败时**不要**清掉缓冲（只在真正成功、或确定没戏时才清）
 *   ② 区分**暂时失败**（CD / 正在施法）与**永久失败**（蓝不够、技能不存在）
 *   ③ 延迟释放时用**释放那一刻**的位置，而不是按下时的位置
 *
 * 这三条都不难，但每条都能单独把玩法毁掉，而且都不报错。
 *
 * ============================================================
 * 【依赖】
 * ============================================================
 * - `skill-caster`（前置模块）：本模块是它的上层封装
 * - 输入源：注入接口，不绑定 `InputBuffer`
 */

import type { CastContext, CastResult } from '../skill-caster/SkillCaster';
import { clampNum, safeDt } from '../_core/math';

// ==================== 类型 ====================

/**
 * 施法目标的最小接口
 *
 * 【为什么用接口而不是直接用 SkillCaster 类】
 * 这样本模块不绑定具体实现——测试可以传一个假 caster，
 * 业务也可以包一层（比如加上"沉默状态下不能施法"的判断）。
 */
export interface IQueuedCaster {
  /** 是否正在施法（正在施法时新请求必须排队，不能覆盖） */
  readonly busy: boolean;
  /** 尝试施放 */
  tryCast(id: string, ctx: CastContext): CastResult;
  /** 剩余冷却 */
  cooldownLeft(id: string): number;
}

/**
 * 输入源的最小接口
 *
 * `InputBuffer` 天然满足（`peek` 存在）。
 * 不 import 它是因为：业务完全可能有自己的输入系统。
 */
export interface IInputSource {
  /** 是否有待消费的该动作（**不得**清除） */
  peek(action: string): boolean;
  /** 消费（确认要用了才调） */
  consume(action: string): boolean;
}

/** 失败原因（与 CastResult.reason 对齐） */
export type QueueFailReason = NonNullable<CastResult['reason']>;

/** 上下文可以是快照，也可以是延迟求值 */
export type CastContextLike = CastContext | (() => CastContext);

/** 队列中的一个待释放请求 */
export interface QueuedCast {
  /** 技能 id */
  readonly id: string;
  /** 入队时刻（秒，内部时钟） */
  readonly time: number;
  /** 入队序号（同优先级时先到先得） */
  readonly seq: number;
  /** 优先级（大者先放） */
  readonly priority: number;
  /** 已等待时长（秒） */
  readonly waited: number;
  /** 最近一次失败原因 */
  readonly lastReason: QueueFailReason | undefined;
}

/** 请求被丢弃的原因 */
export type RejectReason =
  /** 等待超时（窗口内没能放出去） */
  | 'expired'
  /** 永久失败（资源不足 / 技能不存在 / 参数非法） */
  | 'failed'
  /** 队列满，被更高优先级的请求挤掉 */
  | 'crowded'
  /** 主动清空 */
  | 'cleared';

/** 回调 */
export interface SkillQueueHooks {
  /** 成功释放（从队列里放出去的） */
  onCast?: (id: string, ctx: CastContext, waited: number) => void;
  /** 被丢弃 */
  onReject?: (id: string, reason: RejectReason, detail?: QueueFailReason) => void;
  /**
   * ⚠️ 窗口"差一点点"导致过期
   *
   * 【为什么单独给这个回调】
   * 请求过期那一刻，如果 CD 其实已经归零了，
   * 说明**窗口配短了**——再等一帧就能放出去。
   *
   * 这类配置问题不会报错，只是"偶尔手感发黏"，极难定位。
   * 所以显式抛出来，让你在日志里一眼看见。
   */
  onNearMiss?: (id: string, wastedWait: number) => void;
}

export interface SkillQueueOptions extends SkillQueueHooks {
  /**
   * 队列窗口（秒）：一个请求最多等多久
   *
   * 【⚠️ 必须大于你想容忍的提前量】
   * 想容忍"提前 0.1s 点击"却把窗口设成 0.1，
   * 边界误差会让输入时灵时不灵。建议留 2 倍余量。
   */
  window?: number;
  /**
   * 队列容量
   *
   * 默认 1 —— 动作游戏里通常只想要**最新**的意图，
   * 攒一串旧输入会让角色"回放"玩家半秒前的操作，那更糟。
   */
  capacity?: number;
  /**
   * 同 id 的新请求是否覆盖旧请求
   *
   * 默认 true。玩家连点同一个技能，你想要的是"再放一次"，
   * 不是"队列里堆三次"。
   */
  replaceSame?: boolean;
  /** 哪些失败可以重试（返回 true 则继续排队） */
  retryable?: (reason: QueueFailReason) => boolean;
  /** 外部时间源（接 Scheduler，保证与游戏时钟一致） */
  now?: () => number;
}

// ==================== 默认策略 ====================

/**
 * 默认的可重试判定
 *
 * 【分类依据】
 * - `cooldown` / `busy`：状态会自己变好 → 等
 * - `out-of-range` / `too-close`：玩家可能在移动 → 等（靠窗口兜底）
 * - `resource`：蓝不会自己涨回来（涨得很慢）→ 立刻丢，给明确反馈
 * - `unknown-skill` / `invalid`：永远不会成功 → 立刻丢
 */
export function defaultRetryable(reason: QueueFailReason): boolean {
  return (
    reason === 'cooldown' ||
    reason === 'busy' ||
    reason === 'out-of-range' ||
    reason === 'too-close'
  );
}

// ==================== 实现 ====================

let _nextSeq = 1;

export class SkillQueue {
  private readonly _caster: IQueuedCaster;
  private readonly _opts: Required<
    Omit<SkillQueueOptions, keyof SkillQueueHooks | 'now'>
  > &
    SkillQueueHooks;

  private _queue: Array<{
    id: string;
    ctxLike: CastContextLike;
    time: number;
    seq: number;
    priority: number;
    lastReason?: QueueFailReason;
  }> = [];

  private _clock = 0;
  private readonly _useInternalClock: boolean;
  private readonly _now: () => number;

  /** 统计 */
  private _stats = { requested: 0, cast: 0, rejected: 0, nearMiss: 0, maxWaited: 0 };

  constructor(caster: IQueuedCaster, opts: SkillQueueOptions = {}) {
    this._caster = caster;
    this._useInternalClock = opts.now === undefined;
    this._now = opts.now ?? (() => this._clock);
    this._opts = {
      window: opts.window ?? 0.25,
      capacity: clampNum(opts.capacity, 1, 1e4, 1),
      replaceSame: opts.replaceSame ?? true,
      retryable: opts.retryable ?? defaultRetryable,
      onCast: opts.onCast,
      onReject: opts.onReject,
      onNearMiss: opts.onNearMiss,
    };
  }

  // ── 配置 ──

  get window(): number {
    return this._opts.window;
  }

  /** 改窗口（比如"手速慢的玩家给长一点"） */
  set window(v: number) {
    /**
     * 【⚠️ `Math.max(0, v)` 挡不住 NaN】
     *
     * `Math.max(0, NaN)` 返回 **NaN**（不是 0），
     * 于是排队项的过期判断 `now - queuedAt > window` 变成
     * `x > NaN` → 恒为 false……等等，方向要小心：
     * 实际判断是 `now - queuedAt <= this._opts.window`，
     * 对 NaN 恒为 false → **所有排队项立即过期**。
     *
     * 表现为"技能队列配好之后一个都排不进去"，
     * 而 `window` 的值看起来是"配过了的"。
     *
     * 用 `numOr` 兜底到 0（0 = 不过期，与 `Math.max(0, ...)` 的既有语义一致）。
     */
    this._opts.window = clampNum(v, 0, 1e6, 0);
  }

  get capacity(): number {
    return this._opts.capacity;
  }

  get stats(): Readonly<typeof this._stats> {
    return this._stats;
  }

  // ── 排队 ──

  /**
   * 请求释放一个技能
   *
   * @param ctx 上下文。**强烈建议传函数** `() => ({...})` ——
   *   技能可能延迟 0.2 秒才放出去，用按下时的位置会导致
   *   "人已经走了，技能却在原地放出来"。
   *   传函数则会在真正释放那一刻才求值。
   * @param priority 优先级，大者先放（默认 0）
   */
  request(id: string, ctx: CastContextLike, priority = 0): boolean {
    const now = this._now();
    this._stats.requested++;

    // 同 id 覆盖：连点同一个技能，意图是"再放一次"，不是"堆三次"
    if (this._opts.replaceSame) {
      const i = this._queue.findIndex((q) => q.id === id);
      if (i >= 0) {
        const old = this._queue[i];
        this._queue.splice(i, 1);
        // 覆盖不算 rejected，那是同一个意图的刷新
        void old;
      }
    }

    const item = { id, ctxLike: ctx, time: now, seq: _nextSeq++, priority, lastReason: undefined };

    if (this._queue.length >= this._opts.capacity) {
      const victim = this._pickVictim(item.priority);
      if (victim === null) {
        // 队里全是要放技能的请求，且新的优先级不够高 → 挤掉自己
        this._stats.rejected++;
        this._opts.onReject?.(id, 'crowded');
        return false;
      }
      this._queue.splice(this._queue.indexOf(victim), 1);
      this._stats.rejected++;
      this._opts.onReject?.(victim.id, 'crowded');
    }

    this._queue.push(item);
    return true;
  }

  /** 队里优先级最低、且入队最早的（用来挤掉） */
  private _pickVictim(newPriority: number): (typeof this._queue)[number] | null {
    let best: (typeof this._queue)[number] | null = null;
    for (const q of this._queue) {
      if (q.priority > newPriority) continue;
      if (best === null || q.priority < best.priority || (q.priority === best.priority && q.seq < best.seq)) {
        best = q;
      }
    }
    return best;
  }

  // ── 每帧推进 ──

  /**
   * 每帧推进（**必须在 tick 里调**）
   *
   * 【顺序】应该在 `caster.tick()` **之后**调用：
   * caster 先结束当前施法，队列才有机会把下一个放出去。
   *
   * 【暂停】传 dt = 0。
   */
  tick(dt: number): void {
    if (this._useInternalClock && safeDt(dt)) this._clock += dt;
    if (this._queue.length === 0) return;

    const now = this._now();

    // ① 先清过期的
    for (let i = this._queue.length - 1; i >= 0; i--) {
      const q = this._queue[i];
      const waited = now - q.time;
      if (waited <= this._opts.window) continue;

      this._queue.splice(i, 1);
      this._stats.rejected++;

      // ⚠️ 过期瞬间 CD 其实已经好了 → 窗口配短了
      //
      // 【为什么不要求 !busy】
      // CD 已就绪、只差后摇这一小段没等完，恰恰是最典型的
      // "窗口没把忙碌时间算进去"。busy 是队列自己允许的等待理由，
      // 不能让它反过来掩盖窗口不足。
      if (this._caster.cooldownLeft(q.id) <= 0) {
        this._stats.nearMiss++;
        this._opts.onNearMiss?.(q.id, waited);
      }
      this._opts.onReject?.(q.id, 'expired', q.lastReason);
    }

    // ② 正在施法则等（不能打断当前施法）
    if (this._caster.busy) return;

    // ③ 按优先级 → 入队顺序，尝试放行
    const order = this._queue
      .slice()
      .sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));

    for (const q of order) {
      const ctx = typeof q.ctxLike === 'function' ? (q.ctxLike as () => CastContext)() : q.ctxLike;
      const r = this._caster.tryCast(q.id, ctx);

      if (r.ok) {
        const waited = this._now() - q.time;
        this._queue.splice(this._queue.indexOf(q), 1);
        this._stats.cast++;
        if (waited > this._stats.maxWaited) this._stats.maxWaited = waited;
        this._opts.onCast?.(q.id, ctx, waited);
        // 一次 tick 只放一个：放完就 busy 了，剩下的等下一帧
        return;
      }

      q.lastReason = r.reason;
      if (!this._opts.retryable(r.reason as QueueFailReason)) {
        this._queue.splice(this._queue.indexOf(q), 1);
        this._stats.rejected++;
        this._opts.onReject?.(q.id, 'failed', r.reason as QueueFailReason);
        // 这个失败了，继续尝试队里下一个（不 return）
      }
    }
  }

  /**
   * 从输入源拉取请求
   *
   * 【为什么单独给这个方法】
   * 和 `InputBuffer` 配合时，正确姿势是 **peek → request → 成功后 consume**。
   * 这三步写错任何一步都会丢输入（尤其是先 consume 再 request）。
   * 所以固化成一个方法。
   *
   * @param mapping 动作名 → 技能 id
   */
  poll(buffer: IInputSource, mapping: Readonly<Record<string, string>>, ctx: CastContextLike, priority = 0): void {
    for (const action in mapping) {
      if (!buffer.peek(action)) continue;
      const skillId = mapping[action];
      if (this.request(skillId, ctx, priority)) {
        buffer.consume(action);
      }
    }
  }

  // ── 查询与清理 ──

  /** 待释放的请求（按优先级排序） */
  get pending(): readonly QueuedCast[] {
    const now = this._now();
    return this._queue
      .slice()
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq)
      .map((q) => ({
        id: q.id,
        time: q.time,
        seq: q.seq,
        priority: q.priority,
        waited: now - q.time,
        lastReason: q.lastReason,
      }));
  }

  /** 是否有某个技能在排队 */
  has(id: string): boolean {
    return this._queue.some((q) => q.id === id);
  }

  /** 待释放数量 */
  get count(): number {
    return this._queue.length;
  }

  /** 清空（换关卡、角色死亡、被沉默） */
  clear(id?: string): void {
    if (id === undefined) {
      for (const q of this._queue) this._opts.onReject?.(q.id, 'cleared');
      this._queue.length = 0;
      return;
    }
    for (let i = this._queue.length - 1; i >= 0; i--) {
      if (this._queue[i].id === id) {
        this._opts.onReject?.(id, 'cleared');
        this._queue.splice(i, 1);
      }
    }
  }

  /** 调试用 */
  describe(): string {
    const s = this._stats;
    return (
      `[SkillQueue] 待释放 ${this._queue.length}/${this._opts.capacity}，` +
      `窗口 ${this._opts.window}s | 请求 ${s.requested} 释放 ${s.cast} 丢弃 ${s.rejected} ` +
      `差一点 ${s.nearMiss} 最长等待 ${s.maxWaited.toFixed(3)}s`
    );
  }
}

// ==================== 辅助 ====================

/**
 * 建议的窗口值
 *
 * 【为什么要有这个函数】
 * "窗口该设多大"没有直觉答案。给一个明确公式，
 * 比让每个人拍脑袋强——拍出来的 0.15 往往正好卡在边界上。
 *
 * @param maxLead 想容忍的最大提前量（秒）
 */
export function suggestWindow(maxLead: number): number {
  return Math.max(0.1, Math.ceil(maxLead * 2 * 100) / 100);
}
