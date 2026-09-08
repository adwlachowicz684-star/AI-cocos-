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
  /**
   * 任务抛异常时回调（**与 `onDone` 同时触发**，不是替代）
   *
   * 【为什么需要】README 写明"出错即完成，不重试"——
   * 于是出错和正常完成都会触发 `onDone`，
   * 调用方**无法区分"做完了"和"做炸了"**：
   * 加载条走到 100% 然后什么都没加载出来，且没有任何报错。
   *
   * 【为什么是"同时触发"而不是改成二选一】
   * 见 `_fail()` 的说明：改 onDone 的触发时机是 breaking change。
   */
  readonly onError?: (error: unknown) => void;
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
  readonly onError?: (error: unknown) => void;
  readonly onCancel?: () => void;
  done: boolean;
}

/**
 * 「没有注册任何任务」的返回值（Sch7）
 *
 * 【为什么需要这个常量】
 * `schedule()` 的有效 id 从 1 开始，而 `scheduleBatch([])` 返回 0——
 * 两者混在同一个返回值里，调用方只能靠文档知道 0 是什么意思。
 * 用一个具名常量把"0 = 空批次，没有任务"这件事显式化，
 * 并且 `cancel(NO_TASK)` 是安全的空操作（返回 false）。
 */
export const NO_TASK = 0;

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
    /**
     * 【⚠️ hardLimitMs 曾经是裸 `??`（Sch2）】
     *
     * 两个方向都静默出错，而且都不报错：
     * - `0`   → 每帧执行完第一个任务就 break（break 在任务执行之后），
     *           退化为"每帧一个任务"，看起来只是"变慢了"；
     * - `NaN` → 比较恒为 false，**硬限制彻底失效**（`>=` 永不成立），
     *           分帧调度退化成同步执行，帧率保护形同虚设。
     *
     * 与 `budgetMs` 的口径保持一致（它已经会为正数抛错）：
     * 非正数没有语义，显式抛错比静默退化好——
     * 否则配置写错时，症状是"游戏偶尔卡"，没人会想到查这里。
     */
    this._hardLimitMs = numOr(opts.hardLimitMs, Math.max(this._budgetMs * 2, 8));
    this._now = opts.now ?? (() => Date.now());

    if (this._budgetMs <= 0) throw new Error('[FrameScheduler] budgetMs 必须为正');
    if (!(this._hardLimitMs > 0)) {
      throw new Error(
        `[FrameScheduler] hardLimitMs 必须为正（收到 ${String(opts.hardLimitMs)}）`
      );
    }
  }

  get budgetMs(): number {
    return this._budgetMs;
  }

  /**
   * 单帧硬上限（收口后的实际生效值）
   *
   * 【为什么需要可读】配置被收口后，调用方拿到的生效值可能不等于传入值
   * （NaN 会回落到默认值）。不可观测的话，"配了但没生效"又会变成一个
   * 只能靠猜的问题——这正是本窗口要清理的那类缺陷。
   */
  get hardLimitMs(): number {
    return this._hardLimitMs;
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
      ...(opts.onError ? { onError: opts.onError } : {}),
      ...(opts.onCancel ? { onCancel: opts.onCancel } : {}),
    };
    this._insertSorted(task);
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
      // 【为什么仍然同步触发 onDone】
      // 空批次"立刻完成"是既有行为，改成"注册一个空任务等下一帧"
      // 会让所有依赖同步完成的调用方（比如"没有东西要加载就直接进游戏"）卡住。
      // 所以保持同步，只把返回值的含义显式化。
      opts.onDone?.();
      return NO_TASK;
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
    /**
     * 【为什么 elapsed 也是 getter】
     * 与 `update()` 同理：老代码在这里同样写死 `elapsed: 0`。
     * flush 是一次跑完全部的同步路径，耗时通常比一帧长得多，
     * 任务在循环里读 elapsed 得到的 0 就更加离谱。
     * 复用 `_makeContext()` 保证两条执行路径语义一致。
     */
    const ctx = this._makeContext();
    const completed: FrameTask[] = [];

    /**
     * 【⚠️ 曾经用 `this._tasks.shift()`（Sch6）】
     * `shift()` 会把后面所有元素整体前移一位，
     * 所以跑完 N 个任务是 **O(N²)** 次搬移。
     * flush 的用途恰恰是"一次性跑完大量任务"，正好踩在最坏情况上。
     *
     * 改成用游标 `i` 单调前进：任务只会被**跳过**，不再被搬移，
     * 循环结束后一次性 `splice` 掉已完成的整段。
     */
    let i = 0;
    while (i < this._tasks.length && guard < 1_000_000) {
      const task = this._tasks[i];
      let stepGuard = 0;

      while (!task.done) {
        try {
          task.done = task.step(ctx);
        } catch (e) {
          console.error(`[FrameScheduler] 任务 ${task.id} 出错：${e}`);
          task.done = true;
          this._fail(task, e);
        }
        if (++stepGuard > 10_000_000) {
          task.done = true;
          break;
        }
      }

      completed.push(task);
      i++;
      guard++;
    }
    // 【关键：必须把任务移出队列，否则 while 条件永远成立】
    // 原注释记录过这个坑（第一版只调 _complete 没 splice）。
    if (i > 0) this._tasks.splice(0, i);

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
      /**
       * 【⚠️ ctx 曾经是每个任务每帧新建一次】
       * 原代码在 for 循环体里构造 `{ hasTimeLeft: () => ..., elapsed: 0 }`，
       * 于是每帧有 N 个任务就分配 N 个对象 + N 个闭包。
       * 分帧调度本来就是为了扛"几百个任务"的场景，
       * 热路径上按任务数分配恰恰是最该避免的。
       *
       * 现在一帧只造一个 ctx（下面统一说明为什么能复用）。
       */
      const ctx = this._makeContext();

      // 用索引遍历，因为任务可能在执行中被取消
      for (let i = 0; i < this._tasks.length; ) {
        const task = this._tasks[i];

        let finished = false;
        try {
          finished = task.step(ctx);
        } catch (e) {
          console.error(`[FrameScheduler] 任务 ${task.id} 抛出异常：${e}`);
          finished = true; // 出错的任务不再重试，否则每帧都报错
          this._fail(task, e);
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
   * 构造传给任务函数的上下文
   *
   * 【为什么 `elapsed` 必须是 getter】
   * 接口 `StepContext` 承诺了 `elapsed: 本帧已用时间（毫秒）`，
   * 但老代码写死 `elapsed: 0`，任务执行到一半、跨多帧读它**永远得到 0**。
   * 调用方拿它做"已耗时"判断或进度条，读数静默错误，
   * 而且类型检查完全看不出来——字段存在、类型也对，只是值恒为 0。
   *
   * 做成 getter 后每次读都是"当下"的耗时，
   * 同一个 ctx 对象也就可以安全地被本帧多个任务复用
   * （顺带解决了"每任务每帧新建 ctx"的热路径分配）。
   *
   * 【为什么不能只在循环里算好一次再塞进去】
   * 那就是"任务开始时的耗时"，不是任务执行途中读到的耗时；
   * 任务在 `while (ctx.hasTimeLeft())` 里读 elapsed 时，值早就过期了。
   */
  private _makeContext(): StepContext {
    const self = this;
    return {
      hasTimeLeft: () => self._now() - self._frameStart < self._budgetMs,
      get elapsed(): number {
        return self._now() - self._frameStart;
      },
    };
  }

  /**
   * 任务抛异常时的通知（Sch3）
   *
   * 【为什么不改 `onDone` 的触发时机】
   * README §7 第 63 行写明"已处理：出错即完成，不重试"，
   * 且出错后仍会把任务标记为完成并触发 onDone。
   * 把 onDone 改成"只在成功时触发"是 breaking change，
   * 既有调用方（进度条、加载完成提示）会永远等不到回调。
   *
   * 所以新增 `onError` 作为**旁路**：出错时 onError 与 onDone 都会触发，
   * 想区分"做完了"和"做炸了"的调用方订阅 onError 即可。
   */
  private _fail(t: FrameTask, e: unknown): void {
    if (!t.onError) return;
    try {
      t.onError(e);
    } catch (inner) {
      console.error(`[FrameScheduler] 任务 ${t.id} 的 onError 回调出错：${inner}`);
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

  /**
   * 把新任务插到已排序队列的正确位置
   *
   * 【⚠️ 曾经每次 schedule() 都做一次全量 sort（Sch5）】
   * `sort` 是 O(n log n)，而循环里注册 N 个任务就是 **O(N² log N)**——
   * 注册 1000 个任务约 1000 × 10 ≈ 1 万次比较只是起步，
   * 而"启动时要排几十个加载任务"正是本类的典型用法。
   *
   * 【为什么可以只插一个】
   * 队列在插入前**已经是有序的**（不变式：每次插入都维持有序），
   * 新增一个任务只需二分找到位置再 `splice`——O(log n) 查找 + O(n) 搬移。
   * 这样 N 次注册是 O(N²) 搬移，省掉了一整个 log N 因子。
   *
   * 【为什么不用堆】
   * 还要支持 `cancel(id)` 的按 id 查找，堆做不到 O(1)。
   *
   * 【排序口径不变】优先级降序，同优先级按 id 升序（= 注册顺序）。
   */
  private _insertSorted(task: FrameTask): void {
    const a = this._tasks;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = a[mid];
      // 新任务应排在 m 之前吗？
      if (task.priority > m.priority || (task.priority === m.priority && task.id < m.id)) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    a.splice(lo, 0, task);
  }

  destroy(): void {
    this.cancelAll();
  }
}
