import { numOr } from '../_core/math';
/**
 * FrameScheduler —— 分帧调度器
 *
 * 【它解决什么】
 *
 * 有些活一次性做完会卡住一帧：
 * - 生成一张 200×200 的地图
 * - 一次性实例化 500 个敌人
 * - 读档时反序列化几十个对象
 * - 启动时校验 30 张配置表
 *
 * 60fps 下每帧只有 16.6ms。这类活干了 200ms 就是明显的卡顿，
 * 画面会定住，玩家以为游戏崩了。
 *
 * 分帧调度的做法：**每帧只干 N 毫秒，剩下的留到下一帧**。
 *
 * 【设计：按时间预算而不是按数量】
 * 常见的错误做法是"每帧处理 10 个"。问题是每个的耗时不同——
 * 有的 0.1ms 有的 5ms，结果一会儿太快一会儿太慢。
 * 按**时间预算**切分才稳定：每帧最多干 4ms，干不完下一帧继续。
 *
 * 【使用示例】
 * ```typescript
 * const fs = new FrameScheduler({ budgetMs: 4 });
 *
 * // ① 把一批任务摊到多帧
 * fs.scheduleBatch(enemyIds, (id) => spawnEnemy(id), {
 *   onDone: () => console.log('刷怪完成'),
 *   onProgress: (done, total) => updateLoadingBar(done / total),
 * });
 *
 * // ② 自定义的长任务（自己控制每次干多少）
 * fs.schedule((ctx) => {
 *   while (ctx.hasTimeLeft() && !mapGen.done) mapGen.step();
 *   return mapGen.done;   // 返回 true 表示完成
 * });
 *
 * // ③ 每帧在主循环里驱动
 * fs.update();
 *
 * // ④ 优先级：加载中的动画不该被刷怪挤掉
 * fs.schedule(task, { priority: 10 });   // 数字大的先执行
 * ```
 *
 * 【与 Scheduler 的区别】
 * - `scheduler/Scheduler`：管**什么时候**执行（延时、重复、暂停）
 * - 本类：管**一帧之内干多少**（把重活切开）
 *
 * 【无引擎依赖】时间源可注入（默认 Date.now，测试时可注入假时钟）
 */

export interface FrameSchedulerOptions {
  /** 每帧的时间预算（毫秒）。建议 2–5ms */
  readonly budgetMs?: number;
  /**
   * 单帧硬上限（毫秒）
   *
   * 【为什么需要】
   * 如果单个任务项本身就超过预算（比如一个特别大的房间），
   * 只按预算检查的话，这一项干完就超了。
   * 硬上限保证即使单项很慢，帧率也不会跌太狠。
   */
  readonly hardLimitMs?: number;
  /** 自定义时间源（测试用） */
  readonly now?: () => number;
}

export interface TaskOptions {
  /** 优先级，数字大的先跑（默认 0） */
  readonly priority?: number;
  /** 完成后回调 */
  readonly onDone?: () => void;
  /** 被取消时回调 */
  readonly onCancel?: () => void;
}

/** 传给任务函数的上下文 */
export interface StepContext {
  /** 本帧还剩多少时间（毫秒） */
  readonly hasTimeLeft: () => boolean;
  /** 本帧已用时间（毫秒） */
  readonly elapsed: number;
}

/** 一个可分步执行的任务 */
interface FrameTask {
  readonly id: number;
  readonly priority: number;
  /** 执行一小步，返回 true 表示已完成 */
  readonly step: (ctx: StepContext) => boolean;
  readonly onDone?: () => void;
  readonly onCancel?: () => void;
  done: boolean;
}

export class FrameScheduler {
  private readonly _budgetMs: number;
  private readonly _hardLimitMs: number;
  private readonly _now: () => number;

  private _tasks: FrameTask[] = [];
  private _nextId = 1;

  /** 当前帧的开始时间 */
  private _frameStart = 0;

  constructor(opts: FrameSchedulerOptions = {}) {
    this._budgetMs = opts.budgetMs ?? 4;
    this._hardLimitMs = opts.hardLimitMs ?? Math.max(this._budgetMs * 2, 8);
    this._now = opts.now ?? (() => Date.now());

    if (this._budgetMs <= 0) throw new Error('[FrameScheduler] budgetMs 必须为正');
  }

  get budgetMs(): number {
    return this._budgetMs;
  }

  /** 待处理任务数 */
  get pendingCount(): number {
    return this._tasks.length;
  }

  get isBusy(): boolean {
    return this._tasks.length > 0;
  }

  /**
   * 注册一个可分步的任务
   *
   * @param step 每帧调用一次，干一小步，返回 true 表示完成
   * @returns 任务 id（可用于 cancel）
   */
  schedule(step: (ctx: StepContext) => boolean, opts: TaskOptions = {}): number {
    const task: FrameTask = {
      id: this._nextId++,
      priority: opts.priority ?? 0,
      step,
      done: false,
      ...(opts.onDone ? { onDone: opts.onDone } : {}),
      ...(opts.onCancel ? { onCancel: opts.onCancel } : {}),
    };
    this._tasks.push(task);
    this._sort();
    return task.id;
  }

  /**
   * 批量处理（最常见的用法）
   *
   * 【进度回调的开销】
   * onProgress 每完成一项就调一次。如果批次有几万项，
   * 这个回调本身就是开销。用 `progressInterval` 控制频率。
   */
  scheduleBatch<T>(
    items: readonly T[],
    process: (item: T, index: number) => void,
    opts: TaskOptions & { onProgress?: (done: number, total: number) => void; progressInterval?: number } = {}
  ): number {
    const total = items.length;
    if (total === 0) {
      opts.onDone?.();
      return 0;
    }

    let i = 0;
    const interval = Math.max(1, numOr(opts.progressInterval, 1));

    return this.schedule(
      (ctx) => {
        /**
         * 【坑】每次循环都检查时间，而不是"先干 10 个再检查"。
         * 单项耗时的方差很大，按数量切会导致帧时间忽长忽短。
         */
        while (i < total) {
          process(items[i], i);
          i++;

          if (opts.onProgress && i % interval === 0) opts.onProgress(i, total);
          if (!ctx.hasTimeLeft()) break;
        }

        if (i >= total) {
          opts.onProgress?.(total, total);
          return true;
        }
        return false;
      },
      opts
    );
  }

  /** 取消任务 */
  cancel(id: number): boolean {
    const i = this._tasks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    const t = this._tasks[i];
    this._tasks.splice(i, 1);
    t.onCancel?.();
    return true;
  }

  /** 取消所有任务（换关时） */
  cancelAll(): void {
    const tasks = this._tasks;
    this._tasks = [];
    for (const t of tasks) {
      try {
        t.onCancel?.();
      } catch (e) {
        console.error(`[FrameScheduler] onCancel 出错：${e}`);
      }
    }
  }

  /**
   * 立刻跑完全部（不等下一帧）
   *
   * 【用途】
   * - 测试里同步拿到结果
   * - 加载界面上"跳过动画"时直接完成
   * - 启动时（此时卡一下无所谓）
   *
   * 【警告】会阻塞当前帧。大数据量时不要用。
   */
  flush(): void {
    /**
     * 【坑】必须把任务从队列里移除。
     * 第一版只调了 _complete 却没 splice，
     * 结果 while 条件永远成立，全靠 guard 撑到 100 万次才退出——
     * 表现为"flush() 卡住好几秒"。
     */
    let guard = 0;
    const ctx: StepContext = { hasTimeLeft: () => true, elapsed: 0 };
    const completed: FrameTask[] = [];

    while (this._tasks.length > 0 && guard < 1_000_000) {
      const task = this._tasks[0];
      let stepGuard = 0;

      while (!task.done) {
        try {
          task.done = task.step(ctx);
        } catch (e) {
          console.error(`[FrameScheduler] 任务 ${task.id} 出错：${e}`);
          task.done = true;
        }
        if (++stepGuard > 10_000_000) {
          task.done = true;
          break;
        }
      }

      this._tasks.shift(); // ← 关键：移出队列
      completed.push(task);
      guard++;
    }

    // 回调放在循环外：回调里可能注册新任务
    for (const t of completed) this._complete(t);
  }

  /**
   * 每帧调用
   *
   * 【执行策略】
   * 按优先级依次执行，每个任务在本帧的剩余预算内尽量多干。
   * 高优先级任务会先吃掉预算——这是有意的：
   * 你希望"加载动画"比"后台刷怪"先拿到时间。
   */
  update(): void {
    if (this._tasks.length === 0) return;

    this._frameStart = this._now();

    const completed: FrameTask[] = [];

    try {
      // 用索引遍历，因为任务可能在执行中被取消
      for (let i = 0; i < this._tasks.length; ) {
        const task = this._tasks[i];

        const ctx: StepContext = {
          hasTimeLeft: () => this._now() - this._frameStart < this._budgetMs,
          elapsed: 0,
        };

        let finished = false;
        try {
          finished = task.step(ctx);
        } catch (e) {
          console.error(`[FrameScheduler] 任务 ${task.id} 抛出异常：${e}`);
          finished = true; // 出错的任务不再重试，否则每帧都报错
        }

        if (finished) {
          task.done = true;
          completed.push(task);
          this._tasks.splice(i, 1);
          // 不 i++ ，因为数组缩短了一位
        } else {
          i++;
        }

        /**
         * 硬上限：即使某个单项很慢，也强制本帧结束。
         * 【坑】检查必须在**任务执行之后**，否则第一项永远拦不住。
         */
        if (this._now() - this._frameStart >= this._hardLimitMs) break;
      }

      // 【坑】完成回调放在循环**之后**。
      // 回调里可能注册新任务，放在循环内会改动正在遍历的数组。
      for (const t of completed) this._complete(t);
    } finally {
      completed.length = 0;
    }
  }

  /**
   * 本帧已用时间（毫秒）
   *
   * 【用途】性能面板显示"分帧调度占了多少帧时间"
   */
  get lastFrameMs(): number {
    return this._now() - this._frameStart;
  }

  private _complete(t: FrameTask): void {
    try {
      t.onDone?.();
    } catch (e) {
      console.error(`[FrameScheduler] onDone 出错：${e}`);
    }
  }

  private _sort(): void {
    // 稳定排序：同优先级按注册顺序
    this._tasks.sort((a, b) => b.priority - a.priority || a.id - b.id);
  }

  destroy(): void {
    this.cancelAll();
  }
}
