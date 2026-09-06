/**
 * scenerouter/SceneRouter.ts —— 场景路由
 *
 * 【它解决什么】
 *
 * "主菜单 → 关卡 → 结算 → 回主菜单"，
 * 中间还夹着加载界面、转场动画、进度条。
 *
 * 手写的做法是 `director.loadScene('game')`，
 * 配上一个全局 `isLoading` 布尔量。然后你会遇到：
 *
 * 1. **并发切换**
 *    玩家快速点两次"开始游戏"，加载了两次关卡，
 *    第二次覆盖第一次，或者两个场景叠在一起。
 *
 * 2. **转场没播完就切**
 *    淡出动画还没结束就 load，表现为黑屏闪一下。
 *
 * 3. **进度条不动**
 *    加载完成的回调被吞了，进度条停在 0.9 然后卡住不动。
 *
 * 4. **返回栈**
 *    "返回上一场景"需要记住来路，
 *    手写是一堆 `fromScene` 参数层层传递。
 *
 * 【核心设计】
 *
 * 路由把一次切换拆成**有序的几个阶段**：
 *
 * ```
 * idle → out（旧场景退场）→ load（加载）→ in（新场景入场）→ idle
 * ```
 *
 * 每个阶段由宿主驱动（`tick`），宿主在对应阶段去做引擎相关的事。
 * 本模块**不认识任何引擎 API**，只管编排顺序与状态。
 *
 * 【零业务依赖】
 */
import { clampNum, safeDt } from '../_core/math';

// ==================== 类型 ====================

export type RoutePhase =
  /** 空闲 */
  | 'idle'
  /** 旧场景退场（播转出动画） */
  | 'out'
  /** 加载中 */
  | 'load'
  /** 新场景入场（播转入动画） */
  | 'in';

export interface RouteRequest {
  readonly to: string;
  /**
   * 是否入返回栈
   *
   * 【默认 true】
   * 结算回主菜单这类"回程"应该设 false，
   * 否则按返回键又会回到结算界面。
   */
  readonly pushHistory?: boolean;
  /** 附加参数（传给新场景） */
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface SceneRouterOptions {
  /**
   * 退场时长（毫秒）。0 表示无退场动画
   */
  readonly outMs?: number;
  /**
   * 入场时长（毫秒）
   */
  readonly inMs?: number;
  /**
   * 加载阶段的兜底超时（毫秒）
   *
   * 【必须有】
   * 加载回调永远不来（资源加载失败且没走 reject）时，
   * 玩家会永远卡在加载界面。
   */
  readonly loadTimeoutMs?: number;
  readonly initial?: string;
  readonly onChange?: (phase: RoutePhase, scene: string | null) => void;

  /**
   * 历史栈上限（默认 32）
   *
   * 【为什么可配置】
   * 早期硬编码 32，导致 `back()` 能回退的层数不可调。
   * 做「返回上一级菜单」这类需求时，32 层可能太多也可能太少。
   * 与 `cheatcode` 的 historyLimit ?? 50、`gameflow` 的 ?? 32 保持一致。
   */
  readonly historyLimit?: number;
}

export interface RouteState {
  readonly phase: RoutePhase;
  readonly current: string | null;
  readonly target: string | null;
  /** 当前阶段进度 0~1（驱动进度条/动画） */
  readonly progress: number;
  /** 返回栈 */
  readonly history: readonly string[];
  readonly params: Readonly<Record<string, unknown>> | null;
}

// ==================== 实现 ====================

export class SceneRouter {
  private readonly _historyLimit: number;
  private readonly _outMs: number;
  private readonly _inMs: number;
  private readonly _loadTimeout: number;
  private readonly _onChange?: (phase: RoutePhase, scene: string | null) => void;

  private _phase: RoutePhase = 'idle';
  private _current: string | null;
  private _target: string | null = null;
  private _elapsed = 0;
  private _params: Readonly<Record<string, unknown>> | null = null;
  private _history: string[] = [];
  private _pushHistory = true;

  constructor(opts: SceneRouterOptions = {}) {
    this._outMs = opts.outMs ?? 300;
    this._inMs = opts.inMs ?? 300;
    this._loadTimeout = opts.loadTimeoutMs ?? 30_000;
    // 【为什么可配置】早期硬编码 32，导致 back() 能回退的层数不可调。
    // 做「返回上一级菜单」这类需求时，32 层可能太多也可能太少。
    this._historyLimit = clampNum(opts.historyLimit, 1, 1e5, 32);
    this._onChange = opts.onChange;
    this._current = opts.initial ?? null;
    if (this._current) this._history.push(this._current);
  }

  get state(): RouteState {
    return {
      phase: this._phase,
      current: this._current,
      target: this._target,
      progress: this._phaseProgress(),
      history: [...this._history],
      params: this._params,
    };
  }

  get current(): string | null {
    return this._current;
  }

  get phase(): RoutePhase {
    return this._phase;
  }

  get busy(): boolean {
    return this._phase !== 'idle';
  }

  get history(): readonly string[] {
    return [...this._history];
  }

  // ==================== 切换 ====================

  /**
   * 请求切换场景
   *
   * @returns 是否接受请求（切换中会被拒绝）
   */
  go(req: RouteRequest): boolean {
    /**
     * 【⚠️ 切换中拒绝新请求】
     * 不拒绝的话，玩家连点两次会加载两次场景，
     * 表现为"关卡被创建了两份"或"两个场景叠在一起"。
     */
    if (this._phase !== 'idle') return false;
    if (req.to === this._current) return false;

    this._target = req.to;
    this._params = req.params ?? null;
    this._pushHistory = req.pushHistory ?? true;
    this._elapsed = 0;
    this._setPhase('out');
    return true;
  }

  /** 便捷方法 */
  goTo(to: string, params?: Readonly<Record<string, unknown>>): boolean {
    return this.go({ to, params });
  }

  /**
   * 返回上一场景
   *
   * 【⚠️ 至少保留一层】
   * 历史里只剩当前场景时返回 false，
   * 而不是把当前场景 pop 掉导致"没有场景了"。
   */
  back(): boolean {
    if (this._phase !== 'idle') return false;
    if (this._history.length < 2) return false;
    const prev = this._history[this._history.length - 2];
    return this.go({ to: prev, pushHistory: false });
  }

  /**
   * 每帧驱动
   *
   * 【宿主在什么时候做什么】
   * - 进入 `out`：播放退场动画
   * - 进入 `load`：调引擎的加载 API，完成后调 `notifyLoaded()`
   * - 进入 `in`：播放入场动画
   * - 回到 `idle`：切换完成
   */
  tick(dt: number): void {
    if (this._phase === 'idle') return;
    // 【为什么不是 dt > 0】Infinity > 0 为 true，会把 _elapsed 直接推到 Infinity，
    // 转场进度永远越界，卡在 out/load 阶段再也出不来。
    if (safeDt(dt)) this._elapsed += dt;

    switch (this._phase) {
      case 'out':
        if (this._elapsed >= this._outMs) {
          this._elapsed = 0;
          this._setPhase('load');
        }
        break;

      case 'load':
        /**
         * 【超时兜底】
         * 加载回调没来（资源加载失败、回调被吞）时，
         * 与其永远卡住，不如继续走——至少玩家能看到错误场景。
         */
        if (this._elapsed >= this._loadTimeout) {
          this._finishLoad();
        }
        break;

      case 'in':
        if (this._elapsed >= this._inMs) {
          this._elapsed = 0;
          this._setPhase('idle');
        }
        break;
    }
  }

  /**
   * 宿主通知：资源加载完成
   *
   * 【幂等】重复调用不会造成状态错乱。
   */
  notifyLoaded(): void {
    if (this._phase !== 'load') return;
    this._finishLoad();
  }

  /** 立刻完成当前阶段（跳过动画 / 调试） */
  skipPhase(): void {
    if (this._phase === 'idle') return;
    if (this._phase === 'load') {
      this._finishLoad();
      return;
    }
    this._elapsed = 0;
    this._setPhase(this._phase === 'out' ? 'load' : 'idle');
  }

  // ==================== 内部 ====================

  private _finishLoad(): void {
    const from = this._current;
    const to = this._target;

    if (this._pushHistory) {
      this._history.push(to!);
      // 历史上限，防止无限增长
      if (this._history.length > this._historyLimit) this._history.shift();
    } else {
      // 回程：把来路弹出
      const i = this._history.lastIndexOf(to!);
      if (i >= 0) this._history.length = i + 1;
      else this._history = [to!];
    }

    this._current = to;
    this._target = null;
    this._elapsed = 0;
    void from;
    this._setPhase('in');
  }

  private _setPhase(p: RoutePhase): void {
    this._phase = p;
    this._onChange?.(p, this._current);
  }

  private _phaseProgress(): number {
    const total =
      this._phase === 'out' ? this._outMs :
      this._phase === 'in' ? this._inMs :
      0;
    if (total <= 0) return this._phase === 'idle' ? 1 : 0;
    return Math.min(1, this._elapsed / total);
  }
}
