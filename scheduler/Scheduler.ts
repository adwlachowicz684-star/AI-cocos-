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
import { clampNum, numOr } from '../_core/math';

/** 回调类型：接收 dt（秒） */
export type TickCallback = (dt: number) => void;

/**
 * 小于这个量级的 dt 视为"没有推进"
 *
 * 见 `update()` 中关于 `delta === 0` 的注释。
 */
const MIN_EFFECTIVE_DT = 1e-12;

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
  /**
   * 时间源（默认 `Date.now`）
   *
   * 【为什么要注入（rule2）】
   * 原实现在 `update()` 里直接 `this.timeScale.update(Date.now())`
   * ——模块内部主动去"找"墙钟时间。
   * 于是回放 / 确定性测试无法控制时间推进，
   * "顿帧 80ms 后恢复"这种场景只能靠真的 sleep 来测。
   */
  readonly nowProvider?: () => number;
  /**
   * `hitStop()` 的默认时长（真实秒）。默认 0.08
   *
   * 【为什么要提出来】
   * 0.08 / 0.05 原本是写在 `hitStop` 签名里的魔法数字。
   * 打击手感是要按武器类型调的（轻击 60ms、重击 110ms、暴击 140ms），
   * 每次都靠调用方传参，就等于把"手感基准值"散落到每个调用点。
   */
  readonly hitStopDuration?: number;
  /** `hitStop()` 的默认缩放。默认 0.05 */
  readonly hitStopScale?: number;
}

export class Scheduler implements IDisposable {
  readonly timeScale: TimeScale;

  private readonly _maxDt: number;
  private readonly _now: () => number;
  private readonly _hitStopDuration: number;
  private readonly _hitStopScale: number;

  /** 常规任务 + 延时任务统一放这里，按 id 索引 */
  private readonly _tasks = new Map<number, Task>();
  private _nextId = 1;

  /** 本帧待新增的任务（避免在遍历中修改集合） */
  private _pendingAdd: Task[] = [];

  /**
   * 遍历用的快照缓存
   *
   * 【⚠️ 曾经的 bug：每帧 `Array.from(this._tasks.values())`】
   *
   * `update()` 在主循环里每帧跑一次，任务集合通常几十到几百个。
   * 每帧分配一个新数组，在 60fps 下就是每秒 60 次分配——
   * 这些短命数组会直接推高 GC 频率，表现为**周期性的帧时间尖刺**。
   *
   * 修法：只在任务集合真的变了（注册 / 取消 / 完成删除）时才重建快照。
   * 稳态下（任务既不增也不减）一次分配都不做。
   *
   * 【为什么缓存仍然安全】遍历时 `if (task.dead) continue` 已经挡住了
   * 在回调中被取消的任务——见下方快照遍历处的注释。
   */
  private _snapshot: Task[] = [];
  private _snapshotDirty = true;

  /** 累计时间（调试与统计用） */
  private _scaledTime = 0;
  private _unscaledTime = 0;

  /** 上一帧的信息（调试面板用） */
  private _lastRealDt = 0;
  private _lastScaledDt = 0;

  constructor(opts: SchedulerOptions = {}) {
    /**
     * 【⚠️ 曾经的 bug：maxDeltaTime 完全没做数值收口】
     *
     * 原实现 `this._maxDt = opts.maxDeltaTime ?? 0.1` 有两个洞：
     *
     *   1. `0`  → 每个 dt 都被 clamp 成 0，`if (delta === 0) continue`
     *      → **所有回调一次都不执行，游戏完全静止，且不报错**
     *   2. `-1` → dt 被 clamp 成负数，`task.remaining -= delta`
     *      把剩余时间**越减越多**，定时器永远不到期
     *      （同时 `scaledTime` 也在倒着走）
     *
     * 实测（修复前）：
     *   maxDeltaTime=0  → 5 帧后回调次数 = 0，lastRealDt = 0
     *   maxDeltaTime=-1 → 累计 0.16s 后 delay(1) 到期 = false，lastRealDt = -1
     *
     * 触发方式非常普通：配置文件里写错一个符号、或者 JSON 里
     * `"maxDeltaTime": -1`。而"定时器不工作"是最难查的故障类别——
     * 没有异常、没有日志，只是"该发生的事没发生"。
     *
     * 【影响面】Scheduler 是唯一时间源，
     * tween / wave-spawner / scheduling 等依赖它的单元会一起停摆。
     *
     * 修法：非正值（0 / 负数）**整体回落默认 0.1**，而不是夹到下界。
     *
     * 【为什么不用 clampNum(v, 1e-6, 1e6, 0.1)】
     * 那样 `-1` 会被夹成 **1e-6**——不倒流了，但每帧只推进 1 微秒，
     * 游戏**几乎完全静止**，"定时器不工作"的故障现象一点没变。
     * 一个让游戏停摆的值和一个让游戏倒流的值，都是"配错了"，
     * 都该按"没配"处理。
     */
    const rawMaxDt = numOr(opts.maxDeltaTime, 0.1);
    this._maxDt = rawMaxDt > 0 ? Math.min(rawMaxDt, 1e6) : 0.1;
    this._now = opts.nowProvider ?? (() => Date.now());
    this._hitStopDuration = clampNum(opts.hitStopDuration, 1e-6, 10, 0.08);
    this._hitStopScale = clampNum(opts.hitStopScale, 0, 1, 0.05);
    this.timeScale = new TimeScale({ ...opts, nowProvider: this._now });
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
    this.timeScale.update(this._now());

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
    if (this._snapshotDirty) {
      this._snapshot = Array.from(this._tasks.values());
      this._snapshotDirty = false;
    }
    const snapshot = this._snapshot;

    for (const task of snapshot) {
      if (task.dead) continue;

      const delta = task.unscaled ? dt : scaledDt;

      /**
       * 【⚠️ 曾经的 bug：用 `delta === 0` 做浮点相等判断】
       *
       * 只有在 dt 恰好被清成 **0** 时才跳过。
       * 而 `scaledDt = dt * scale`，scale 是个小数——
       * 只要它非零（哪怕是 1e-300 这种非规格化数），
       * `delta === 0` 就为 false，回调**照常执行**。
       *
       * 后果：本该"完全冻结"的时间源仍在每帧调用每个回调，
       * 回调拿到的 dt 小到没有任何意义，
       * 于是"暂停了但 AI 还在动（只是极慢）"这类现象无法用
       * `delta === 0` 这条路径解释——排查方向会被带到别处。
       *
       * 修法：低于一个极小阈值就当作"没推进"。
       * 阈值取 1e-12 而不是更大的值，
       * 是为了不误伤合法的极慢动作（scale=1e-6 时 dt 仍有 1.6e-8）。
       */
      if (!task.unscaled && !(delta > MIN_EFFECTIVE_DT) && !(delta < -MIN_EFFECTIVE_DT)) continue;

      /**
       * 【关键】scale = 0 时，受缩放影响的任务完全不推进。
       *
       * 注意这里跳过的是**整个任务**（包括倒计时），
       * 而不是"用 dt=0 调用它"。
       * 区别在于：dt=0 时回调仍会执行（只是没推进），
       * 而这里直接不调用——这才符合"暂停"的语义。
       */
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
            this._snapshotDirty = true;
            continue;
          }
        }
        // 补偿溢出：保证长期节奏准确
        task.remaining = task.interval + task.remaining;
        if (task.remaining < 0) task.remaining = 0;
      } else {
        task.dead = true;
        this._tasks.delete(task.id);
        this._snapshotDirty = true;
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
    this._snapshotDirty = true;

    let cancelled = false;
    return () => {
      if (cancelled) return;
      cancelled = true;
      task.dead = true;
      this._tasks.delete(id);
      this._snapshotDirty = true;
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
  hitStop(durationSeconds = this._hitStopDuration, scale = this._hitStopScale): void {
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
