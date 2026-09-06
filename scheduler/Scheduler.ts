/**
 * Scheduler —— 统一时间源
 *
 * 【这是整个库最关键的插件，没有之一】
 *
 * 【它解决什么】
 * 「暂停时 buff 仍在倒计时」是游戏开发最经典、最让玩家愤怒的 bug。
 * 根因永远是同一个：某个系统偷偷用了 `setTimeout` / `Date.now()` /
 * 引擎自带的 `schedule`，它们不受 timeScale 控制。
 *
 * Scheduler 的做法：**所有计时都必须向它注册，由它统一分发 dt。**
 * 这样暂停（scale=0）、慢动作、顿帧自动生效，
 * 不需要每个系统各自处理——也就没有"某个系统忘了处理"的可能。
 *
 * 【两条通道】
 * - `onUpdate(fn)`      —— 受缩放影响。**游戏逻辑用这条**（移动、冷却、buff、AI）
 * - `onUnscaledUpdate`  —— 不受影响。**UI 动画、暂停菜单、网络心跳用这条**
 *
 * 【坑：为什么必须有 unscaled 通道】
 * 暂停时 scale = 0，如果暂停菜单自己的淡入动画也走缩放通道，
 * 那菜单会卡在半透明状态永远淡不进来——
 * 暂停菜单自己被暂停了。这个 bug 几乎所有新手都会遇到一次。
 *
 * 【使用示例】
 * ```typescript
 * const sched = new Scheduler();
 *
 * // 主循环（唯一一处调用 update 的地方）
 * gameLoop(dt: number) {
 *   sched.update(dt);   // dt 是引擎给的真实帧间隔
 * }
 *
 * // 游戏逻辑（受暂停影响）
 * sched.onUpdate((dt) => buffSystem.tick(dt));
 *
 * // UI（不受暂停影响）
 * sched.onUnscaledUpdate((dt) => menuAnim.tick(dt));
 *
 * // 延时（受缩放影响：暂停时不推进）
 * sched.delay(3, () => spawnEnemy());
 *
 * // 每帧
 * sched.everyFrame((dt) => player.move(dt));
 * ```
 *
 * 【无引擎依赖】可脱离 Cocos 单测。
 */

import { TimeScale, TimeScaleOptions } from './TimeScale';
import { IDisposable } from '../_core/types';

/** 回调类型：接收 dt（秒） */
export type TickCallback = (dt: number) => void;

/** 内部任务 */
interface Task {
  id: number;
  fn: TickCallback;
  /** true = 不受 timeScale 影响 */
  unscaled: boolean;
  /** 剩余等待时间（秒）。<= 0 表示立即执行（每帧任务为 0） */
  remaining: number;
  /** 重复间隔（秒）。null = 一次性 */
  interval: number | null;
  /** 剩余重复次数。Infinity = 无限 */
  times: number;
  /** 是否已标记删除 */
  dead: boolean;
}

export interface SchedulerOptions extends TimeScaleOptions {
  /**
   * 单帧最大真实 dt（秒）
   *
   * 【为什么必须有】
   * 切到后台再回来、断点调试、首帧加载——这些情况下
   * 引擎给的 dt 可能是几十秒。
   * 后果：角色瞬移穿墙、物理爆炸、一次 update 里刷出上千个敌人。
   *
   * 行业惯例 clamp 到 0.1 秒（相当于最低 10fps）。
   * 宁可"卡顿一下"也不要"物理炸掉"。
   */
  readonly maxDeltaTime?: number;
}

export class Scheduler implements IDisposable {
  readonly timeScale: TimeScale;

  private readonly _maxDt: number;

  /** 常规任务 + 延时任务统一放这里，按 id 索引 */
  private readonly _tasks = new Map<number, Task>();
  private _nextId = 1;

  /** 本帧待新增的任务（避免在遍历中修改集合） */
  private _pendingAdd: Task[] = [];

  /** 累计时间（调试与统计用） */
  private _scaledTime = 0;
  private _unscaledTime = 0;

  /** 上一帧的信息（调试面板用） */
  private _lastRealDt = 0;
  private _lastScaledDt = 0;

  constructor(opts: SchedulerOptions = {}) {
    this._maxDt = opts.maxDeltaTime ?? 0.1;
    this.timeScale = new TimeScale(opts);
  }

  // ==================== 主循环 ====================

  /**
   * 推进一帧。**整个项目应该只有一处调用它。**
   *
   * @param realDt 真实帧间隔（秒），来自引擎的 update(deltaTime)
   *
   * 【为什么只有一处】
   * 多处调用会导致不同系统的 dt 不一致，
   * 表现为"同样的 3 秒冷却，有的系统快有的慢"——极难排查。
   */
  update(realDt: number): void {
    // ① clamp 真实 dt（防御切后台、断点、首帧）
    let dt = realDt;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > this._maxDt) dt = this._maxDt;
    this._lastRealDt = dt;

    // ② 推进时间缩放（用真实时间清理过期的顿帧/慢动作层）
    this.timeScale.update(Date.now());

    // ③ 计算缩放后的 dt
    const scaledDt = dt * this.timeScale.value;
    this._lastScaledDt = scaledDt;

    this._unscaledTime += dt;
    this._scaledTime += scaledDt;

    // ④ 先合并本帧新增的任务
    if (this._pendingAdd.length > 0) {
      for (const t of this._pendingAdd) this._tasks.set(t.id, t);
      this._pendingAdd.length = 0;
    }

    /**
     * ⑤ 快照遍历
     *
     * 【坑】回调中可能添加或移除任务（例如延时到点后创建新的延时）。
     * 直接遍历 Map 会漏掉或重复。用快照，代价是每帧一次数组分配——
     * 任务量通常几十个，可以接受。如果确实是热点，可以改成
     * 「标记删除 + 延迟清理」的方式避免分配。
     */
    const snapshot = Array.from(this._tasks.values());

    for (const task of snapshot) {
      if (task.dead) continue;

      const delta = task.unscaled ? dt : scaledDt;

      /**
       * 【关键】scale = 0 时，受缩放影响的任务完全不推进。
       *
       * 注意这里跳过的是**整个任务**（包括倒计时），
       * 而不是"用 dt=0 调用它"。
       * 区别在于：dt=0 时回调仍会执行（只是没推进），
       * 而这里直接不调用——这才符合"暂停"的语义。
       */
      if (delta === 0 && !task.unscaled) continue;

      // 延时任务：先扣时间
      if (task.remaining > 0) {
        task.remaining -= delta;
        if (task.remaining > 0) continue;
        // 超时部分补偿到下一次，避免长帧导致节奏漂移
        // （例如 interval=1s，某帧 dt=1.5s，不应丢掉那 0.5s）
      }

      // 执行
      task.fn(delta);

      // 处理重复
      if (task.interval !== null) {
        if (task.times !== Infinity) {
          task.times--;
          if (task.times <= 0) {
            task.dead = true;
            this._tasks.delete(task.id);
            continue;
          }
        }
        // 补偿溢出：保证长期节奏准确
        task.remaining = task.interval + task.remaining;
        if (task.remaining < 0) task.remaining = 0;
      } else {
        task.dead = true;
        this._tasks.delete(task.id);
      }
    }
  }

  // ==================== 注册 ====================

  /**
   * 每帧调用（受 timeScale 影响）
   * @returns 取消函数
   */
  everyFrame(fn: TickCallback): () => void {
    // 【关键】interval 必须是 0 而不是 null。
    // null 在内部语义里是"一次性任务"，执行后会被删除——
    // 那 everyFrame 就只执行一帧了。这是我自己踩过的坑。
    return this._add(fn, false, 0, 0, Infinity);
  }

  /**
   * 每帧调用（**不受** timeScale 影响，UI 用）
   * @returns 取消函数
   */
  everyFrameUnscaled(fn: TickCallback): () => void {
    return this._add(fn, true, 0, 0, Infinity);
  }

  /**
   * 延时执行（受 timeScale 影响，暂停时不推进）
   *
   * @param seconds 延迟秒数（**缩放时间**：scale=0.5 时需要 2 倍墙钟时间）
   * @returns 取消函数
   *
   * 【注意】这里的"秒"是游戏内时间。
   * 如果你需要"墙钟 3 秒"（如网络超时），用 `delayUnscaled`。
   */
  delay(seconds: number, fn: TickCallback): () => void {
    if (seconds < 0) throw new Error(`[Scheduler] 延迟不能为负: ${seconds}`);
    return this._add(fn, false, seconds, null, 1);
  }

  /** 延时执行（不受 timeScale 影响，走墙钟时间） */
  delayUnscaled(seconds: number, fn: TickCallback): () => void {
    if (seconds < 0) throw new Error(`[Scheduler] 延迟不能为负: ${seconds}`);
    return this._add(fn, true, seconds, null, 1);
  }

  /**
   * 定时重复（受 timeScale 影响）
   *
   * @param interval 间隔（缩放秒）
   * @param times 次数，省略 = 无限
   */
  repeat(interval: number, fn: TickCallback, times = Infinity): () => void {
    if (interval <= 0) throw new Error(`[Scheduler] 间隔必须为正: ${interval}`);
    return this._add(fn, false, interval, interval, times);
  }

  /** 定时重复（不受 timeScale 影响） */
  repeatUnscaled(interval: number, fn: TickCallback, times = Infinity): () => void {
    if (interval <= 0) throw new Error(`[Scheduler] 间隔必须为正: ${interval}`);
    return this._add(fn, true, interval, interval, times);
  }

  /**
   * @param interval null = 一次性任务（执行后删除）；
   *                 0    = 每帧任务；
   *                 >0   = 定时重复
   */
  private _add(
    fn: TickCallback,
    unscaled: boolean,
    remaining: number,
    interval: number | null,
    times: number
  ): () => void {
    const id = this._nextId++;
    const task: Task = { id, fn, unscaled, remaining, interval, times, dead: false };
    this._pendingAdd.push(task);

    let cancelled = false;
    return () => {
      if (cancelled) return;
      cancelled = true;
      task.dead = true;
      this._tasks.delete(id);
      const i = this._pendingAdd.indexOf(task);
      if (i >= 0) this._pendingAdd.splice(i, 1);
    };
  }

  // ==================== 便捷控制 ====================

  /** 暂停（scale = 0） */
  pause(): void {
    this.timeScale.pause();
  }

  unpause(): void {
    this.timeScale.unpause();
  }

  get paused(): boolean {
    return this.timeScale.paused;
  }

  /**
   * 顿帧：极短时间内的近乎完全静止
   *
   * 【顿帧为什么能提升打击感】
   * 命中瞬间卡住 60–110ms，玩家的视觉系统会把这一刻标记为"重要事件"。
   * 没有顿帧的攻击，手感是"滑过去"的；有了顿帧，是"砸中"的。
   *
   * 这是**投入产出比最高**的手感优化——几行代码，质感提升一个档次。
   *
   * 【参考数值】
   * 轻击 60ms、重击 110ms、暴击 140ms、击杀 180ms。
   * 超过 200ms 会明显感觉"卡"，不再是"有力"。
   *
   * @param durationSeconds 真实秒数
   * @param scale 顿帧期间的缩放（0.05 意味着几乎静止但仍有细微动作，比 0 更自然）
   */
  hitStop(durationSeconds = 0.08, scale = 0.05): void {
    this.timeScale.add('hitstop', scale, durationSeconds);
  }

  /** 慢动作 */
  slowMotion(scale: number, durationSeconds?: number): void {
    this.timeScale.add('slowmo', scale, durationSeconds);
  }

  clearSlowMotion(): void {
    this.timeScale.remove('slowmo');
  }

  // ==================== 查询（调试面板用）====================

  /** 累计的缩放时间（游戏内时间） */
  get scaledTime(): number {
    return this._scaledTime;
  }

  /** 累计的真实时间 */
  get unscaledTime(): number {
    return this._unscaledTime;
  }

  get lastRealDt(): number {
    return this._lastRealDt;
  }

  get lastScaledDt(): number {
    return this._lastScaledDt;
  }

  /** 当前任务数（排查泄漏：只增不减说明取消函数没调用） */
  get taskCount(): number {
    return this._tasks.size + this._pendingAdd.length;
  }

  /** 【铁律 5】可卸载：清空所有任务 */
  destroy(): void {
    this._tasks.clear();
    this._pendingAdd.length = 0;
    this.timeScale.destroy();
  }
}
