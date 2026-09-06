/**
 * attack-token/AttackToken.ts —— 攻击令牌（防止被围殴秒杀）
 *
 * 【它解决什么】
 *
 * 五个敌人同时扑向玩家，同一帧全部命中。
 * 玩家血量 100，每个怪打 25 —— 瞬间归零，连反应的机会都没有。
 *
 * 玩家不会觉得"我操作失误了"，会觉得"这游戏不公平"。
 * 因为它确实不公平：**玩家没有同时应对五个攻击的可能性**。
 *
 * 攻击令牌（Attack Token）是业界标准解法（《阿卡姆》《荣耀战魂》《只狼》都在用）：
 *
 * > 同一时刻只允许 **N 个**敌人处于"正在攻击"状态，
 * > 其余必须排队等待。
 *
 * 效果：
 * - 敌人轮流上，玩家能逐个格挡/闪避
 * - 视觉上变成"围而不攻"的包抄圈，压迫感反而更强
 * - 玩家能读懂"谁要打我了"，做出正确反应
 *
 * 【为什么比"降低伤害"好】
 * 降低伤害会让战斗变得软绵绵（打半天不死）。
 * 令牌保持单个伤害不变，只控制**并发数**——
 * 难度来自"节奏密度"而不是"数值堆砌"。
 *
 * 【零业务依赖】
 *
 * 它不认识敌人、不认识攻击动作。
 * 只有 id 和"我要攻击"的请求，以及"我用完了"的归还。
 */

import { IRandomSource, MathRandomSource } from '../_core/types';
import { clampNum, maxOf, numOr, safeDt } from '../_core/math';

// ============================================================
// 数据结构
// ============================================================

/** 请求状态 */
export type TokenRequestState =
  /** 排队中（还没轮到） */
  | 'queued'
  /** 已获得令牌，正在攻击 */
  | 'active'
  /** 被拒绝（优先级太低且队列满了） */
  | 'rejected';

export interface TokenRequest {
  readonly entityId: number;
  /**
   * 优先级（越大越优先）
   *
   * 【典型用法】
   * - Boss / 精英：+50
   * - 距离玩家越近：+ (10 - dist)
   * - 已经排队很久：+ 等待时间（防止饿死）
   */
  priority: number;
  readonly requestedAt: number;
  state: TokenRequestState;
  /** 获得令牌的时刻（用于统计与超时） */
  grantedAt: number;
}

/** 令牌归还原因 */
export type ReleaseReason =
  /** 正常结束 */
  | 'finished'
  /** 被打断（玩家格挡、被击退） */
  | 'interrupted'
  /** 实体死亡 */
  | 'died'
  /** 持有超时（兜底，见下） */
  | 'timeout'
  /** 系统重置 */
  | 'reset';

// ============================================================
// 配置
// ============================================================

export interface AttackTokenOptions {
  /**
   * 同时最多几个实体能攻击。默认 2
   *
   * 【怎么定】
   * - 1：最严格，回合感强（适合《只狼》式一对一决斗）
   * - 2（推荐）：能打出配合，玩家仍能应付
   * - 3：混乱，只适合杂兵海
   * - ≥4：基本失去意义
   */
  maxConcurrent?: number;

  /**
   * 队列最大长度。默认 32
   *
   * 【为什么要有上限】
   * 20 个怪同时请求，队列会很长。
   * 队尾的怪要等几十秒才轮到，看起来像"发呆"。
   * 超限直接拒绝，让它们去做别的行为（包抄、后退）。
   */
  maxQueued?: number;

  /**
   * 持有令牌的最长时间（秒）。默认 0（不限）
   *
   * 【⚠️ 强烈建议设置】
   * 某个敌人攻击动画卡住、或者它被冰冻但没释放令牌，
   * 令牌就永远不归还 → **所有敌人再也无法攻击** →
   * 玩家发现怪都站着不动，游戏废了。
   *
   * 建议设为"最长攻击动画时长 × 2"。
   */
  holdTimeout?: number;

  /**
   * 等待多久后开始提升优先级（秒）。默认 2
   *
   * 【防饿死】
   * 高优先级的 Boss 反复抢到令牌，小怪永远排不上。
   * 等待超过这个时间后，优先级按等待时长提升。
   */
  starvationAfter?: number;

  /** 每秒提升多少优先级。默认 10 */
  starvationGain?: number;

  /**
   * 实体死亡 / 移除后是否自动释放。默认 true
   *
   * 【为什么必须自动】
   * 指望业务在每个死亡分支都记得归还令牌是不现实的。
   * 漏一次就永久少一个令牌，而且**没有任何报错**。
   */
  autoReleaseOnRemove?: boolean;

  rng?: IRandomSource;

  onGrant?: (entityId: number) => void;
  onRelease?: (entityId: number, reason: ReleaseReason) => void;
  onReject?: (entityId: number) => void;
}

// ============================================================
// 实现
// ============================================================


export class AttackTokenSystem {
  private readonly _maxConcurrent: number;
  private readonly _maxQueued: number;
  private readonly _holdTimeout: number;
  private readonly _starveAfter: number;
  private readonly _starveGain: number;
  private readonly _autoRelease: boolean;
  private readonly _rng: IRandomSource;

  /** 正在持有令牌的：entityId → 请求 */
  private readonly _active = new Map<number, TokenRequest>();
  /** 排队中的：entityId → 请求 */
  private readonly _queued = new Map<number, TokenRequest>();
  private _time = 0;

  onGrant?: (entityId: number) => void;
  onRelease?: (entityId: number, reason: ReleaseReason) => void;
  onReject?: (entityId: number) => void;

  constructor(opts: AttackTokenOptions = {}) {
    this._maxConcurrent = clampNum(opts.maxConcurrent, 1, 1e4, 2);
    this._maxQueued = clampNum(opts.maxQueued, 0, 1e6, 32);
    this._holdTimeout = Math.max(0, numOr(opts.holdTimeout, 0));
    this._starveAfter = Math.max(0, numOr(opts.starvationAfter, 2));
    this._starveGain = Math.max(0, numOr(opts.starvationGain, 10));
    this._autoRelease = opts.autoReleaseOnRemove ?? true;
    this._rng = opts.rng ?? MathRandomSource;
    this.onGrant = opts.onGrant;
    this.onRelease = opts.onRelease;
    this.onReject = opts.onReject;
  }

  // ---- 查询 ----

  get activeCount(): number {
    return this._active.size;
  }

  get queuedCount(): number {
    return this._queued.size;
  }

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  /** 是否持有令牌（可以攻击） */
  hasToken(entityId: number): boolean {
    return this._active.has(entityId);
  }

  /** 是否正在排队 */
  isQueued(entityId: number): boolean {
    return this._queued.has(entityId);
  }

  requestState(entityId: number): TokenRequestState | null {
    return this._active.get(entityId)?.state ?? this._queued.get(entityId)?.state ?? null;
  }

  activeIds(): number[] {
    return [...this._active.keys()];
  }

  /** 还剩几个空位 */
  get freeSlots(): number {
    return Math.max(0, this._maxConcurrent - this._active.size);
  }

  // ---- 请求 ----

  /**
   * 请求攻击权限
   *
   * @returns
   * - `'active'` 立刻可以攻击
   * - `'queued'` 需要等待（会在后续 tick 中被授予）
   * - `'rejected'` 队列已满，去做别的事
   */
  request(entityId: number, priority = 0): TokenRequestState {
    // 已在持有或排队 → 幂等，返回当前状态
    const existing = this._active.get(entityId) ?? this._queued.get(entityId);
    if (existing) {
      // 【允许更新优先级】
      // 敌人可能一开始离得远（低优先级），走近了要提优先级。
      // 不更新的话，走近了的敌人还得排很久。
      if (priority > existing.priority) existing.priority = priority;
      return existing.state;
    }

    const req: TokenRequest = {
      entityId,
      priority,
      requestedAt: this._time,
      state: 'queued',
      grantedAt: -1,
    };

    // 有空位 → 直接授予（同时防止一帧内请求超过 maxConcurrent）
    if (this._active.size < this._maxConcurrent) {
      this._grant(req);
      return 'active';
    }

    // 队列满了 → 拒绝
    if (this._queued.size >= this._maxQueued) {
      req.state = 'rejected';
      this.onReject?.(entityId);
      return 'rejected';
    }

    this._queued.set(entityId, req);
    return 'queued';
  }

  /** 归还令牌 */
  release(entityId: number, reason: ReleaseReason = 'finished'): boolean {
    const req = this._active.get(entityId);
    if (!req) {
      // 也在排队？直接取消
      if (this._queued.delete(entityId)) {
        this.onRelease?.(entityId, reason);
        return true;
      }
      return false;
    }

    this._active.delete(entityId);
    this.onRelease?.(entityId, reason);
    this._promote();
    return true;
  }

  /**
   * 实体被移除（死亡、离场）
   *
   * 【为什么有独立方法】
   * 死亡路径往往很分散（被玩家杀、掉坑、被剧情移除），
   * 指望每处都调 `release` 一定会漏。
   * 统一在实体销毁时调 `remove()` 兜底。
   */
  remove(entityId: number): boolean {
    if (this._autoRelease) {
      return this.release(entityId, 'died');
    }
    // 不自动释放时，至少要清掉排队，避免幽灵请求
    return this._queued.delete(entityId);
  }

  /** 取消排队（还没拿到令牌，不想打了） */
  cancel(entityId: number): boolean {
    return this._queued.delete(entityId);
  }

  // ---- 主循环 ----

  tick(dt: number): void {
    if (!safeDt(dt)) return;
    this._time += dt;

    // ① 持有超时兜底
    if (this._holdTimeout > 0) {
      const expired: number[] = [];
      for (const [id, req] of this._active) {
        if (this._time - req.grantedAt >= this._holdTimeout) expired.push(id);
      }
      for (const id of expired) {
        this._active.delete(id);
        this.onRelease?.(id, 'timeout');
      }
      if (expired.length > 0) this._promote();
    }
  }

  // ---- 内部 ----

  private _grant(req: TokenRequest): void {
    req.state = 'active';
    req.grantedAt = this._time;
    this._queued.delete(req.entityId);
    this._active.set(req.entityId, req);
    this.onGrant?.(req.entityId);
  }

  /** 从队列中提升优先级最高的补位 */
  private _promote(): void {
    while (this._active.size < this._maxConcurrent && this._queued.size > 0) {
      let best: TokenRequest | null = null;
      for (const req of this._queued.values()) {
        const eff = this._effectivePriority(req);
        if (!best || eff > this._effectivePriority(best)) best = req;
      }
      if (!best) break;
      this._grant(best);
    }
  }

  /**
   * 有效优先级 = 基础优先级 + 饥饿加成
   *
   * 【防饿死】
   * 没有这个，一个小怪可能被持续请求的高优先级敌人
   * 永远挤在队尾——玩家会看到它一动不动地站着。
   */
  private _effectivePriority(req: TokenRequest): number {
    const waited = this._time - req.requestedAt;
    if (waited <= this._starveAfter) return req.priority;
    return req.priority + (waited - this._starveAfter) * this._starveGain;
  }

  /**
   * 清空（会触发 onRelease，让业务能清理状态）
   *
   * 【⚠️ 曾经的 bug：reset 之后仍有令牌被持有】
   *
   * 原实现是循环调用 `release()`。但 `release()` 内部会调
   * `_promote()` 把队列里的补上来——
   *
   * ```
   * maxConcurrent = 2，持有 {1, 2}，队列 [3]
   * release(1) → _promote() → 3 补位，active = {2, 3}
   * release(2) → _promote() → 队列已空，active = {3}
   * reset() 结束，active = {3}   ← 残留！
   * ```
   *
   * 后果有两层，第二层更严重：
   * 1. `activeCount` 不为 0，看起来像"没清干净"
   * 2. **3 号从未收到 `onRelease`** ——
   *    业务侧以为它还在攻击中，不会清理它的攻击状态。
   *    下一场战斗开始时，这个幽灵令牌可能导致并发数算错。
   *
   * 【修法】先把所有请求**静默摘下来**，再统一通知。
   * 这样补位逻辑无从介入。
   */
  reset(): void {
    const activeIds = [...this._active.keys()];
    const queuedIds = [...this._queued.keys()];
    this._active.clear();
    this._queued.clear();
    this._time = 0;
    for (const id of activeIds) this.onRelease?.(id, 'reset');
    for (const id of queuedIds) this.onRelease?.(id, 'reset');
  }

  /** 静默清空（不触发事件，用于切场景） */
  silentReset(): void {
    this._active.clear();
    this._queued.clear();
    this._time = 0;
  }

  get time(): number {
    return this._time;
  }

  // ============================================================
  // 诊断：开发期用来调参
  // ============================================================

  /**
   * 统计信息
   *
   * 【用途】
   * 上线前跑一场战斗，看 `avgWait`：
   * - < 1s：流畅
   * - 1~3s：正常（玩家能感到"轮流上"的节奏）
   * - > 5s：令牌太少或敌人太多，需要调 maxConcurrent
   */
  stats(): TokenStats {
    const waits: number[] = [];
    for (const req of this._active.values()) {
      waits.push(req.grantedAt - req.requestedAt);
    }
    return {
      active: this._active.size,
      queued: this._queued.size,
      maxConcurrent: this._maxConcurrent,
      avgWait: waits.length > 0 ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
      // 原写法 `waits.length > 0 ? Math.max(...waits) : 0` 是**对的**，
      // 换成 maxOf 只是消除"记得判空"这个负担——
      // 手工三元一旦漏写，症状是 -Infinity 且无任何提示。
      maxWait: maxOf(waits, 0),
    };
  }

  /** 未使用的 rng：保留给未来的"随机挑一个补位"策略 */
  protected get rng(): IRandomSource {
    return this._rng;
  }
}

export interface TokenStats {
  active: number;
  queued: number;
  maxConcurrent: number;
  /** 平均等待时长（秒） */
  avgWait: number;
  maxWait: number;
}
