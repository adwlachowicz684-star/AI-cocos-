/**
 * Tween —— 补间动画（纯逻辑，由 dt 驱动）
 *
 * 【为什么不用引擎自带的 tween】
 * Cocos 的 `tween(node)` 很好用，但它绑在节点上、绑在引擎的调度上。
 * 这意味着：
 * - 无法对纯数值做补间（比如"把伤害从 10 平滑到 25"）
 * - 无法在暂停时精确控制（引擎 tween 走自己的时间轴）
 * - 无法脱离引擎单测
 *
 * 本实现只做一件事：**给你一个从 0 到 1 的进度 t，你用它算任何值。**
 *
 * 【设计：Tween 不持有目标对象】
 * 这是可复用的关键。引擎 tween 的写法是 `tween(node).to(...)`，
 * 它必须认识 node。而这里：
 * ```typescript
 * const t = new Tween(1.0).onUpdate((p) => {
 *   label.opacity = 255 * p;      // 你决定用 p 做什么
 *   enemy.health = lerp(0, 100, p);
 * });
 * ```
 * 它能补间任何东西——数值、颜色、位置、音量、UI 布局。
 *
 * 【使用示例】
 * ```typescript
 * const runner = new TweenRunner();
 *
 * // 淡入
 * runner.add(new Tween(0.5).ease('easeOutQuad').onUpdate(p => {
 *   panel.opacity = 255 * p;
 * }));
 *
 * // 序列：等 0.3s → 移动 → 回调
 * runner.add(
 *   new Tween(0.4).delay(0.3).ease('easeOutBack')
 *     .onUpdate(p => { icon.x = lerp(startX, endX, p); })
 *     .onComplete(() => console.log('到位'))
 * );
 *
 * // 每帧（用 Scheduler 的 unscaled 通道，UI 动画不应受暂停影响）
 * runner.update(dt);
 *
 * // 循环（呼吸效果）
 * new Tween(1).loop('pingpong').onUpdate(p => glow.intensity = p);
 * ```
 *
 * 【无引擎依赖】
 */

import { clamp01, safeDt, EasingName, Easing } from '../_core/math';

export type LoopMode = 'none' | 'repeat' | 'pingpong';

export class Tween {
  private _duration: number;
  private _elapsed = 0;
  private _delay = 0;
  private _ease: (t: number) => number = (t) => t;
  private _loop: LoopMode = 'none';
  private _loopCount = Infinity;
  private _times = 0;

  private _onUpdate: ((p: number, raw: number) => void) | null = null;
  private _onComplete: (() => void) | null = null;

  private _done = false;
  private _killed = false;
  private _direction = 1;

  constructor(duration: number) {
    if (!(duration > 0)) throw new Error(`[Tween] 时长必须为正，实际 ${duration}`);
    this._duration = duration;
  }

  /** 延迟多久开始（秒） */
  delay(seconds: number): this {
    if (seconds < 0) throw new Error('[Tween] 延迟不能为负');
    this._delay = seconds;
    return this;
  }

  /**
   * 设置缓动
   *
   * 【为什么拼错名字要抛错】
   * 静默退化成线性缓动的话，你的动画会"看起来不太对劲"但没有任何报错——
   * 然后你会花一小时调时长、调曲线，最后才发现是名字写成了
   * `easeOutQuad`（正确是 `outQuad`）。
   *
   * 这是被测试抓到的真实缺陷：**配置错误必须在设置时就炸。**
   *
   * 可用名称见 `_core/math.ts` 的 `Easing`：
   * linear / inQuad / outQuad / inOutQuad / inCubic / outCubic /
   * inOutCubic / outQuart / inOutQuart / outExpo / outBack /
   * outElastic / outBounce ……
   */
  ease(name: EasingName | string | ((t: number) => number)): this {
    if (typeof name === 'function') {
      this._ease = name;
      return this;
    }
    const fn = Easing[name as EasingName];
    if (!fn) {
      const valid = Object.keys(Easing).join(', ');
      throw new Error(`[Tween] 未知的缓动名 "${name}"。可用：${valid}`);
    }
    this._ease = fn;
    return this;
  }

  /** 循环模式 */
  loop(mode: LoopMode, times = Infinity): this {
    this._loop = mode;
    this._loopCount = times;
    return this;
  }

  /** 每帧回调。p = 缓动后的进度，raw = 未缓动的线性进度 */
  onUpdate(fn: (p: number, raw: number) => void): this {
    this._onUpdate = fn;
    return this;
  }

  onComplete(fn: () => void): this {
    this._onComplete = fn;
    return this;
  }

  /** 推进（由 TweenRunner 调用） */
  update(dt: number): void {
    if (this._done || this._killed) return;
    if (!safeDt(dt)) return;

    if (this._delay > 0) {
      this._delay -= dt;
      if (this._delay > 0) return;
      dt = -this._delay; // 把超出的部分补偿进正式计时
      this._delay = 0;
    }

    if (this._loop === 'pingpong') {
      this._elapsed += dt * this._direction;
      if (this._elapsed >= this._duration) {
        this._elapsed = this._duration;
        this._direction = -1;
      } else if (this._elapsed <= 0) {
        this._elapsed = 0;
        this._direction = 1;
        this._times++;
        if (this._times >= this._loopCount) {
          this._finish();
          return;
        }
      }
    } else {
      this._elapsed += dt;
      if (this._elapsed >= this._duration) {
        if (this._loop === 'repeat') {
          this._times++;
          if (this._times >= this._loopCount) {
            this._elapsed = this._duration;
            this._emit();
            this._finish();
            return;
          }
          this._elapsed -= this._duration;
        } else {
          this._elapsed = this._duration;
          this._emit();
          this._finish();
          return;
        }
      }
    }

    this._emit();
  }

  private _emit(): void {
    const raw = this._duration <= 0 ? 1 : clamp01(this._elapsed / this._duration);
    this._onUpdate?.(this._ease(raw), raw);
  }

  private _finish(): void {
    this._done = true;
    this._onComplete?.();
  }

  /** 立即跳到结束状态并触发完成 */
  complete(): void {
    if (this._done || this._killed) return;
    this._elapsed = this._duration;
    this._delay = 0;
    this._emit();
    this._finish();
  }

  /** 终止（不触发 onComplete，不跳到终态） */
  kill(): void {
    this._killed = true;
  }

  get done(): boolean {
    return this._done;
  }

  get killed(): boolean {
    return this._killed;
  }

  get progress(): number {
    return this._duration <= 0 ? 1 : clamp01(this._elapsed / this._duration);
  }

  /** 重置（对象池复用时用） */
  reset(): void {
    this._elapsed = 0;
    this._times = 0;
    this._done = false;
    this._killed = false;
    this._direction = 1;
  }

  destroy(): void {
    this._onUpdate = null;
    this._onComplete = null;
    this._killed = true;
  }
}

/**
 * TweenRunner —— 管理多个 Tween
 *
 * 【为什么需要它】
 * 单个 Tween 要你自己每帧 update。有 20 个动画时，
 * 你得维护一个数组、每帧遍历、移除已完成的——
 * 这些样板代码写一次就够，所以抽成 Runner。
 *
 * 【坑：遍历中移除】
 * 回调里可能创建新的 Tween 或 kill 当前 Tween。
 * 用快照遍历 + 延迟清理（同 Scheduler 的做法）。
 */
export class TweenRunner {
  private _tweens: Tween[] = [];
  private _pending: Tween[] = [];

  /** 添加一个 Tween（返回它，便于链式） */
  add<T extends Tween>(t: T): T {
    this._pending.push(t);
    return t;
  }

  /** 便捷创建 */
  to(duration: number, onUpdate: (p: number) => void): Tween {
    const t = new Tween(duration).onUpdate((p) => onUpdate(p));
    return this.add(t);
  }

  /** 延时执行 */
  delay(seconds: number, fn: () => void): Tween {
    return this.add(new Tween(0.0001).delay(seconds).onComplete(fn));
  }

  update(dt: number): void {
    if (this._pending.length > 0) {
      for (const t of this._pending) this._tweens.push(t);
      this._pending.length = 0;
    }

    if (this._tweens.length === 0) return;

    const snapshot = this._tweens.slice();
    for (const t of snapshot) {
      t.update(dt);
    }

    // 清理已完成/已终止的
    if (this._tweens.some((t) => t.done || t.killed)) {
      this._tweens = this._tweens.filter((t) => !t.done && !t.killed);
    }
  }

  get count(): number {
    return this._tweens.length + this._pending.length;
  }

  /** 终止所有 */
  killAll(): void {
    for (const t of this._tweens) t.kill();
    for (const t of this._pending) t.kill();
    this._tweens.length = 0;
    this._pending.length = 0;
  }

  /** 全部立即完成（跳过动画） */
  completeAll(): void {
    for (const t of this._tweens) t.complete();
    this._tweens.length = 0;
    this._pending.length = 0;
  }

  destroy(): void {
    this.killAll();
  }
}
