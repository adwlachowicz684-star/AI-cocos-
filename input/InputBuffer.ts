/**
 * InputBuffer —— 输入缓冲
 *
 * 【它解决什么】
 *
 * 玩家在攻击后摇的第 3 帧按下了攻击键。
 * 此时角色还在硬直中，输入被丢弃 → 玩家觉得"我按了没反应"。
 *
 * 输入缓冲把这次按键**记住一小段时间**（通常 100~150ms），
 * 等硬直一结束立刻执行。
 *
 * 【这是动作游戏手感的第一块地基】
 * 哈迪斯、空洞骑士、鬼泣都靠它。
 * 没有它，连招会变得"粘滞"——玩家必须精确卡帧才能接上。
 *
 * 【零业务依赖】
 * 它只知道「动作名 + 时间戳」，不知道是键盘、手柄还是 UI 按钮，
 * 也不知道这个动作是"攻击"还是"跳跃"。
 *
 * 【两个相关概念】
 *
 * | | 作用 |
 * |---|---|
 * | **Input Buffer** | 当前**不能**执行时，记下来稍后执行 |
 * | **Input Queue** | 记下**连续**的输入序列，用于搓招（↓↘→ + A） |
 *
 * 本模块两者都提供。
 *
 * 【使用示例】
 * ```typescript
 * const buf = new InputBuffer({ window: 0.15 });
 *
 * // 玩家按下攻击
 * buf.press('attack');
 *
 * // 每帧（dt 来自 Scheduler）
 * buf.tick(dt);
 *
 * // 硬直结束时
 * if (!busy && buf.consume('attack')) {
 *   doAttack();
 * }
 * ```
 */

/** 一次输入记录 */
import { safeDt } from '../_core/math';
export interface BufferedInput {
  /** 动作名 */
  action: string;
  /** 记录时的时间（秒，单调递增） */
  time: number;
}

export interface InputBufferOptions {
  /**
   * 缓冲窗口（秒）
   *
   * 【参考值】
   * - 动作游戏攻击：0.10 ~ 0.15
   * - 跳跃：0.08 ~ 0.12（太长会导致"我没按也跳了"）
   * - 格挡/闪避：0.12（容错要更高，因为按早了就死）
   *
   * 超过 0.2 玩家会觉得输入"太黏"，出现误操作。
   */
  window?: number;

  /**
   * 队列最大长度（搓招用）
   *
   * 【建议】6 足够放下 `↓↘→+A` 这类 4~5 步的指令。
   */
  maxQueue?: number;

  /**
   * 时间源（默认用 tick 累积的 dt）
   *
   * 【为什么可以注入】
   * 用它接 `Scheduler` 的缩放时间，暂停时缓冲不推进——
   * 否则暂停 5 秒后回来，缓冲的输入早已过期却还在队列里。
   */
  now?: () => number;
}

/**
 * 输入缓冲
 *
 * 【与 InputManager 的分工】
 * - `InputManager`：物理输入 → 动作名（键盘/手柄/触摸 → 'attack'）
 * - `InputBuffer`：动作名 → 记住/消费（时序容错）
 *
 * 两者顺序串联，互不依赖。
 */
export class InputBuffer {
  private _window: number;
  private _maxQueue: number;
  private _now: () => number;

  /** 累积时间（未提供 now 时自己维护） */
  private _clock = 0;
  private _useInternalClock: boolean;

  /** 待消费的缓冲 */
  private _pending = new Map<string, number>();
  /** 输入序列（搓招） */
  private _queue: BufferedInput[] = [];

  constructor(opts: InputBufferOptions = {}) {
    this._window = opts.window ?? 0.15;
    this._maxQueue = opts.maxQueue ?? 6;
    this._useInternalClock = opts.now === undefined;
    this._now = opts.now ?? (() => this._clock);
  }

  /** 缓冲窗口 */
  get window(): number {
    return this._window;
  }

  set window(v: number) {
    this._window = Math.max(0, v);
  }

  /**
   * 每帧推进
   *
   * 【必须在游戏暂停时传 dt = 0】
   * 否则暂停期间缓冲会继续"老化"，恢复后输入已失效。
   */
  tick(dt: number): void {
    if (this._useInternalClock && safeDt(dt)) this._clock += dt;
    this._prune();
  }

  /**
   * 记录一次输入
   *
   * @param action 动作名
   * @param force 是否强制覆盖已有（连按时取最新）
   */
  press(action: string, force = true): void {
    const t = this._now();
    if (!force && this._pending.has(action)) return;
    this._pending.set(action, t);
    this._queue.push({ action, time: t });
    if (this._queue.length > this._maxQueue) this._queue.shift();
  }

  /**
   * 是否有待消费的该动作（**不消费**）
   *
   * 【什么时候用】只想查询不想触发时（如 UI 显示"可接招"提示）
   */
  peek(action: string): boolean {
    const t = this._pending.get(action);
    if (t === undefined) return false;
    return this._now() - t <= this._window;
  }

  /**
   * 消费该动作
   *
   * 【注意】返回 true 后缓冲被清除，**同一次输入不会被消费两次**。
   */
  consume(action: string): boolean {
    const t = this._pending.get(action);
    if (t === undefined) return false;
    if (this._now() - t > this._window) {
      this._pending.delete(action);
      return false;
    }
    this._pending.delete(action);
    return true;
  }

  /**
   * 消费任意动作（返回被消费的动作名）
   *
   * 【优先级】按**按下时间**排序，最早的先消费。
   * 不要用 Map 的插入顺序——插入顺序不等于时间顺序（虽然通常一致）。
   */
  consumeAny(actions: readonly string[]): string | null {
    let best: string | null = null;
    let bestTime = Infinity;

    for (const a of actions) {
      const t = this._pending.get(a);
      if (t === undefined) continue;
      if (this._now() - t > this._window) {
        this._pending.delete(a);
        continue;
      }
      if (t < bestTime) {
        bestTime = t;
        best = a;
      }
    }

    if (best !== null) this._pending.delete(best);
    return best;
  }

  /** 清空某个动作 */
  clear(action?: string): void {
    if (action === undefined) {
      this._pending.clear();
      return;
    }
    this._pending.delete(action);
  }

  /** 待消费数量 */
  get pendingCount(): number {
    this._prune();
    return this._pending.size;
  }

  // ── 搓招序列 ──

  /**
   * 检查最近的输入序列是否匹配
   *
   * @param pattern 动作名序列，如 `['down', 'right', 'attack']`
   * @param maxSpan 整个序列必须在多少秒内完成
   *
   * 【中间允许多余输入】
   * `['down','right','attack']` 能匹配 `down, down-right, right, attack`——
   * 玩家用摇杆划半圈时会产生中间方向，严格要求连续会让搓招几乎不可能。
   */
  matchSequence(pattern: readonly string[], maxSpan = 1.0): boolean {
    if (pattern.length === 0) return false;
    const now = this._now();

    // 从后往前找（序列的最新元素是最后一次输入）
    let qi = this._queue.length - 1;
    let pi = pattern.length - 1;
    let lastTime = -Infinity;

    while (qi >= 0 && pi >= 0) {
      const e = this._queue[qi];
      if (now - e.time > maxSpan) return false;

      if (e.action === pattern[pi]) {
        if (lastTime !== -Infinity && lastTime - e.time > maxSpan) return false;
        lastTime = e.time;
        pi--;
      }
      qi--;
    }

    if (pi >= 0) return false;
    return lastTime !== -Infinity && now - lastTime <= this._window;
  }

  /**
   * 消费一个搓招（匹配成功则清空相关输入）
   *
   * 【为什么匹配后要清队列】
   * 否则 `↓↘→A` 触发后，队列里还剩 `→A`，
   * 下一个招式 `→A` 会立刻被误触发。
   */
  consumeSequence(pattern: readonly string[], maxSpan = 1.0): boolean {
    if (!this.matchSequence(pattern, maxSpan)) return false;
    for (const a of pattern) this._pending.delete(a);
    this._queue.length = 0;
    return true;
  }

  /** 输入序列（调试用） */
  get queue(): readonly BufferedInput[] {
    return this._queue;
  }

  /** 清空序列 */
  clearQueue(): void {
    this._queue.length = 0;
  }

  /** 清理过期项 */
  private _prune(): void {
    const now = this._now();
    for (const [a, t] of this._pending) {
      if (now - t > this._window) this._pending.delete(a);
    }
    while (this._queue.length > 0 && now - this._queue[0].time > Math.max(this._window, 1)) {
      this._queue.shift();
    }
  }

  destroy(): void {
    this._pending.clear();
    this._queue.length = 0;
  }
}

/**
 * Coyote Time（土狼时间）—— 输入缓冲的镜像问题
 *
 * 【它解决什么】
 * 玩家刚走出平台边缘就按跳，但此时已经"离地"，跳跃被拒绝 → 觉得"我按了没跳"。
 *
 * 土狼时间：离地后仍允许跳跃一小段时间（通常 80~120ms）。
 *
 * 【为什么放在这个文件】
 * 它和输入缓冲是同一类问题的两面：
 * - 输入缓冲：**提前**按的键，稍后生效
 * - 土狼时间：**延后**才生效的条件，现在仍算数
 *
 * 两者都靠"给玩家一点时序容错"改善手感。
 */
export class CoyoteTimer {
  private _duration: number;
  private _left = 0;
  private _grounded = true;

  constructor(duration = 0.1) {
    this._duration = duration;
  }

  /** 设置是否着地（每帧调用） */
  setGrounded(g: boolean): void {
    if (g) {
      this._grounded = true;
      this._left = this._duration;
      return;
    }
    if (this._grounded) {
      // 刚离地，开始倒计时
      this._grounded = false;
      this._left = this._duration;
    }
  }

  /** 推进 */
  tick(dt: number): void {
    if (!this._grounded && this._left > 0 && safeDt(dt)) {
      this._left = Math.max(0, this._left - dt);
    }
  }

  /**
   * 现在能否跳
   *
   * 【消费后必须重置】否则一次离地能跳两次。
   */
  canJump(): boolean {
    return this._grounded || this._left > 0;
  }

  /** 消费跳跃（消费后本次土狼时间作废） */
  consumeJump(): boolean {
    if (!this.canJump()) return false;
    this._left = 0;
    this._grounded = false;
    return true;
  }

  /** 剩余时间（调试） */
  get left(): number {
    return this._left;
  }
}
