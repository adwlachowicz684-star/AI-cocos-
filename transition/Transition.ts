/**
 * transition/Transition.ts —— 场景转场编排
 *
 * 【它解决什么】
 *
 * 场景切换最朴素的写法：
 *
 * ```typescript
 * async function goto(scene) {
 *   await fadeOut(300);
 *   await loadScene(scene);
 *   await fadeIn(300);
 * }
 * ```
 *
 * 五个不做就会出问题的地方：
 *
 * 1. **重入**
 *    玩家在转场途中又点了一次按钮 → 两个转场同时跑 →
 *    场景被加载两次，或者黑屏卡死。
 *
 * 2. **输入未锁**
 *    淡出完成、场景还在加载时，玩家的点击会打到**正在卸载的旧场景**上，
 *    触发一堆 null 引用。
 *
 * 3. **加载无超时**
 *    资源加载卡住（网络、磁盘）→ 永远停在黑屏。
 *    玩家以为游戏崩了。
 *
 * 4. **异常时锁不释放**
 *    加载抛错，但 `finally` 没写 → 输入永久锁死。
 *    这是最严重的一类：游戏看起来还在跑，但什么都不响应。
 *
 * 5. **加载比转场慢时的进度表现**
 *    淡出只用了 0.3 秒，加载用了 8 秒。
 *    如果进度条按"转场时长"算，它会在 0.3 秒时跳到 100% 然后卡 7.7 秒——
 *    玩家认为"卡住了"。正确做法是淡出阶段最多走到 90%。
 *
 * 【设计】
 * 三段式状态机：`out → load → in`，每段都有超时。
 * 加载是调用方提供的异步函数，本模块不关心它加载什么。
 */

import { clamp, numOr } from '../_core/math';

// ==================== 类型 ====================

export type TransitionPhase =
  /** 空闲 */
  | 'idle'
  /** 淡出中 */
  | 'out'
  /** 加载中 */
  | 'load'
  /** 淡入中 */
  | 'in'
  /** 已完成 */
  | 'done'
  /** 失败 */
  | 'failed';

export interface TransitionConfig {
  /** 淡出时长（毫秒，默认 300） */
  readonly outMs?: number;
  /** 淡入时长（毫秒，默认 300） */
  readonly inMs?: number;
  /**
   * 加载超时（毫秒，默认 30000）
   *
   * 【为什么必须有】
   * 加载卡死时，玩家会看到永久黑屏。
   * 超时后至少能报错、重试或退回原场景。
   */
  readonly loadTimeoutMs?: number;
  /**
   * 淡出阶段最多推进到多少进度（默认 0.9）
   *
   * 剩下的 10% 留给加载阶段，
   * 避免"进度条到 100% 却还在等"的假死观感。
   */
  readonly outProgressCap?: number;
}

export interface TransitionState {
  readonly phase: TransitionPhase;
  /** 整体进度 0~1 */
  readonly progress: number;
  /** 当前阶段进度 0~1 */
  readonly phaseProgress: number;
  /** 遮罩不透明度 0~1（1 = 全黑） */
  readonly overlay: number;
  /** 是否处于转场中（可用于锁输入） */
  readonly busy: boolean;
  /** 目标场景（失败时保留，便于重试） */
  readonly target: string | null;
  /** 失败原因 */
  readonly error: string | null;
}

/** 加载函数：由调用方提供，返回 Promise */
export type SceneLoader = (scene: string) => Promise<void>;

// ==================== 实现 ====================

export class Transition {
  private readonly _outMs: number;
  private readonly _inMs: number;
  private readonly _loadTimeoutMs: number;
  private readonly _outCap: number;
  private readonly _loader: SceneLoader;

  private _phase: TransitionPhase = 'idle';
  private _phaseElapsed = 0;
  private _target: string | null = null;
  private _error: string | null = null;

  /** 加载是否已 resolve */
  private _loadDone = false;
  private _loadError: string | null = null;

  /**
   * 当前转场的代号（每次 start/reset 递增）
   *
   * 【为什么需要它】见 `_beginLoad` 的注释：
   * 在飞的 Promise 完成时无法知道"自己是第几次转场发起的"，
   * 只能靠一个前后比对的标识来判定自己是否已过期。
   */
  private _loadToken = 0;

  constructor(loader: SceneLoader, cfg: TransitionConfig = {}) {
    this._loader = loader;
    this._outMs = Math.max(1, numOr(cfg.outMs, 300));
    this._inMs = Math.max(1, numOr(cfg.inMs, 300));
    this._loadTimeoutMs = Math.max(1, numOr(cfg.loadTimeoutMs, 30_000));
    this._outCap = clamp(cfg.outProgressCap ?? 0.9, 0.5, 0.99);
  }

  // ==================== 发起 ====================

  /**
   * 开始转场
   *
   * @returns 是否成功发起（转场中返回 false）
   *
   * 【⚠️ 重入保护】
   * 转场途中再次调用会返回 false，而不是叠加第二个转场。
   */
  start(scene: string): boolean {
    if (this._phase !== 'idle' && this._phase !== 'done' && this._phase !== 'failed') {
      return false;
    }
    this._phase = 'out';
    this._phaseElapsed = 0;
    this._target = scene;
    this._error = null;
    this._loadDone = false;
    this._loadError = null;
    // 递增 token：让上一次转场在飞的 Promise 结果失效
    this._loadToken++;

    // 立即发起异步加载（与淡出并行，节省时间）
    this._beginLoad(scene);
    return true;
  }

  private _beginLoad(scene: string): void {
    /**
     * 【⚠️ 加载与淡出并行启动】
     * 串行的话总时长 = 淡出 + 加载；
     * 并行的话 = max(淡出, 加载)。
     * 加载通常远慢于淡出，并行能省下完整的淡出时间。
     *
     * 【⚠️ 必须区分"这次结果属于哪次转场"】
     *
     * 老实现在 `.then` 里直接 `this._loadDone = true`，
     * 没有任何标识说明这个结果属于哪一次 `start()`。
     * 于是：
     * ```
     * start('a')            // a 的 loader 挂起
     * reset(); start('b')   // b 的 loader 还没完成
     * a 的 Promise resolve  → _loadDone = true   ← 属于 a，却被 b 读到
     * 下一帧 update()       → 阶段从 load 跳到 in（b 根本没加载完）
     * ```
     * 实测（修复前）：`start('a')` → `reset()` → `start('b')`（b 永不 resolve）
     * → a resolve 后再 `update(1)` → 阶段变成 **`in`**。
     *
     * 后果：转场黑幕提前拉开，玩家看到未初始化完成的场景
     * （地形缺失、角色掉出世界、资源还没上屏）。
     * 完全静默——没有超时、没有错误、进度条还显示正常。
     * 在"玩家快速连点切换""加载中途取消"这两个极常见操作下必现。
     *
     * 【修法】用单调递增的 token 标记每次转场，
     * 回调里比对 token，不匹配的（过期的）结果直接丢弃。
     * `reset()` 递增 token，从而让所有在飞的 Promise 自然失效。
     */
    const token = this._loadToken;
    this._loader(scene).then(
      () => {
        if (token !== this._loadToken) return;   // 过期结果，丢弃
        this._loadDone = true;
      },
      (e: unknown) => {
        if (token !== this._loadToken) return;   // 过期结果，丢弃
        this._loadDone = true;
        this._loadError = e instanceof Error ? e.message : String(e);
      }
    );
  }

  // ==================== 推进 ====================

  /**
   * 每帧推进
   *
   * @param dtMs 时间增量（毫秒）
   *
   * 【⚠️ 用真实时间】
   * 转场期间游戏时间通常不流动（旧场景已卸载），
   * 用游戏时间会让转场永远走不完。
   */
  update(dtMs: number): void {
    if (this._phase === 'idle' || this._phase === 'done' || this._phase === 'failed') {
      return;
    }

    this._phaseElapsed += dtMs;

    switch (this._phase) {
      case 'out':
        if (this._phaseElapsed >= this._outMs) {
          this._phase = 'load';
          this._phaseElapsed = 0;
        }
        break;

      case 'load':
        if (this._loadError !== null) {
          this._phase = 'failed';
          this._error = this._loadError;
        } else if (this._loadDone) {
          this._phase = 'in';
          this._phaseElapsed = 0;
        } else if (this._phaseElapsed >= this._loadTimeoutMs) {
          /**
           * 【超时不是成功】
           * 加载超时后进入 failed 而不是强行继续——
           * 继续加载一个半成品场景，崩溃点会离现场更远，更难查。
           */
          this._phase = 'failed';
          this._error = `加载超时（${this._loadTimeoutMs}ms）`;
        }
        break;

      case 'in':
        if (this._phaseElapsed >= this._inMs) {
          this._phase = 'done';
        }
        break;

      default:
        break;
    }
  }

  // ==================== 查询 ====================

  get state(): TransitionState {
    let phaseProgress = 0;
    let progress = 0;
    let overlay = 0;

    switch (this._phase) {
      case 'out':
        phaseProgress = clamp(this._phaseElapsed / this._outMs, 0, 1);
        progress = phaseProgress * this._outCap;
        overlay = phaseProgress;
        break;
      case 'load':
        phaseProgress = clamp(this._phaseElapsed / this._loadTimeoutMs, 0, 1);
        // 加载阶段：从 outCap 缓慢趋向 1，但永不到 1（避免假死观感）
        progress = this._outCap + (1 - this._outCap) * phaseProgress * 0.9;
        overlay = 1;
        break;
      case 'in':
        phaseProgress = clamp(this._phaseElapsed / this._inMs, 0, 1);
        progress = 1;
        overlay = 1 - phaseProgress;
        break;
      case 'done':
        phaseProgress = 1;
        progress = 1;
        overlay = 0;
        break;
      case 'failed':
        phaseProgress = 1;
        progress = this._outCap;
        // 失败时保持遮罩，让上层决定是重试还是退回
        overlay = 1;
        break;
      default:
        break;
    }

    return {
      phase: this._phase,
      progress,
      phaseProgress,
      overlay,
      busy: this._phase === 'out' || this._phase === 'load' || this._phase === 'in',
      target: this._target,
      error: this._error,
    };
  }

  get phase(): TransitionPhase {
    return this._phase;
  }

  /** 是否处于转场中（可用于锁输入） */
  get busy(): boolean {
    const p = this._phase;
    return p === 'out' || p === 'load' || p === 'in';
  }

  get error(): string | null {
    return this._error;
  }

  /**
   * 是否应该锁输入
   *
   * 【⚠️ 失败时也要锁】
   * 失败状态下遮罩是全黑的，玩家的操作没有意义。
   * 但**不能永久锁**——上层必须提供重试/退回的按钮。
   */
  get shouldLockInput(): boolean {
    return this.busy || this._phase === 'failed';
  }

  // ==================== 控制 ====================

  /**
   * 重置回 idle
   *
   * 【什么时候调用】
   * 转场完成后下一帧调用，或者失败后玩家点了重试。
   */
  reset(): void {
    this._phase = 'idle';
    this._phaseElapsed = 0;
    this._target = null;
    this._error = null;
    this._loadDone = false;
    this._loadError = null;
    /**
     * 【⚠️ 递增 token 是 reset 的关键副作用】
     * 只清标志是不够的——在飞的 Promise 仍会在完成时把 `_loadDone` 写回 true。
     * 递增 token 后，那些回调因 token 不匹配而丢弃自己的结果。
     */
    this._loadToken++;
  }

  /**
   * 重试失败的加载
   *
   * @returns 是否发起成功（只在 failed 状态下有效）
   */
  retry(): boolean {
    if (this._phase !== 'failed' || this._target === null) return false;
    const scene = this._target;
    this._phase = 'load';
    this._phaseElapsed = 0;
    this._error = null;
    this._loadDone = false;
    this._loadError = null;
    // 同 start：让上一次（失败的）加载结果失效
    this._loadToken++;
    this._beginLoad(scene);
    return true;
  }

  /**
   * 强制完成（调试用）
   *
   * 【⚠️ 不要在产品里用它"跳过"转场】
   * 它会跳过加载完成的等待，
   * 可能导致在资源没就绪时就淡入。
   */
  forceComplete(): void {
    this._phase = 'done';
    this._phaseElapsed = 0;
  }
}

// ==================== 便捷：遮罩工具 ====================

/**
 * 把 overlay 数值映射为常见的遮罩表现参数
 *
 * 【为什么单独抽出来】
 * 遮罩怎么做（纯黑 Sprite / 圆形擦除 / 百叶窗）是表现层的事，
 * 但"当前该多少不透明"是逻辑层的事。
 * 分开之后，换遮罩样式不用改转场逻辑。
 */
export function overlayStyle(
  overlay: number
): { readonly opacity: number; readonly visible: boolean } {
  return {
    opacity: clamp(overlay, 0, 1),
    /**
     * 【⚠️ overlay=0 时必须隐藏节点】
     * 只设 opacity=0 的话，全屏遮罩节点依然会吃掉触摸事件，
     * 表现为"转场结束后点不动了"。
     */
    visible: overlay > 0.001,
  };
}
