/**
 * Pool<T> —— 通用对象池
 *
 * 【这是"可复用 vs 解耦"最好的例子】
 *
 * 不可复用的写法：
 * ```typescript
 * class BulletPool {           // ← 写死了「子弹」
 *   get(): Bullet { ... }
 * }
 * ```
 * 它不依赖任何东西（解耦了），但你做下一个游戏时一点用都没有。
 *
 * 可复用的写法是 `Pool<T>` + 三个由调用方注入的钩子。
 * 它**不知道自己装的是什么**——所以能装子弹、敌人、飘字、粒子、网络包。
 *
 * 【使用示例】
 * ```typescript
 * const pool = new Pool<Bullet>(
 *   () => new Bullet(),                 // create：怎么造
 *   (b) => b.reset(),                   // onGet：取出前怎么重置
 *   (b) => b.sleep(),                   // onPut：归还前怎么休眠
 *   { maxSize: 200, prewarm: 50 }
 * );
 * const b = pool.get();
 * pool.put(b);
 * pool.dump();  // 排查泄漏
 * ```
 */

import { needCount } from '../_core/guard';

export interface PoolOptions {
  /** 池的最大容量（归还时若空闲已达上限则真正销毁，防止只增不减） */
  readonly maxSize?: number;
  /**
   * 泄漏检测：记录 get 的调用栈。
   * 【坑】这有明显性能开销，只在开发期开启。
   */
  readonly trackLeaks?: boolean;
  /**
   * 防止重复归还（默认 **true**）
   *
   * 【为什么默认开】
   * 同一个对象 `put` 两次，以前会：
   *   ① `active` 变成**负数**，泄漏检测彻底失效
   *   ② 空闲池里出现两个相同引用，之后 `get()` 两次会**拿到同一个对象**
   *
   * 后者在子弹池里的表现是"两颗子弹一起飞"——改一颗的位置，
   * 另一颗跟着变。这种 bug 极难联想回"某处多还了一次"。
   *
   * 【开销】
   * 用 `Set` 同步维护空闲集合，`has/add/delete` 都是 O(1)，
   * 与数组 `push/pop` 同量级。热路径上每帧几千次调用无感。
   * 若实测确实是瓶颈，可显式传 `false` 关掉。
   *
   * 【⚠️ 装原始值时】
   * `Set` 用 SameValueZero 判等，所以 `Pool<number>` 里两个 `0`
   * 会被当成同一对象。对象池本就该装对象——装原始值没有池化意义。
   */
  readonly guardDuplicate?: boolean;
  /**
   * 重复归还时是否打印警告（默认 **true**）
   *
   * 重复归还是**调用方的 bug**，静默修正会掩盖它。
   * 所以默认打一条警告；确认无误后可关掉。
   */
  readonly warnOnDuplicate?: boolean;
}

interface TrackedItem<T> {
  obj: T;
  stack?: string;
  time: number;
}

export class Pool<T> {
  private readonly _idle: T[] = [];
  private readonly _create: () => T;
  private readonly _onGet?: (obj: T) => void;
  private readonly _onPut?: (obj: T) => void;
  private readonly _maxSize: number;
  private readonly _trackLeaks: boolean;
  private readonly _guard: boolean;
  private readonly _warnDup: boolean;

  /** 空闲对象的引用集合（guardDuplicate 开启时维护，用于拦截重复归还） */
  private readonly _inIdle: Set<T> | null;

  /** 未归还的对象（仅 trackLeaks 开启时记录） */
  private readonly _out: Map<T, TrackedItem<T>> = new Map();

  /** 统计：累计创建次数（远大于 maxSize 说明池没起作用） */
  created = 0;
  /** 统计：当前借出数量（长时间不回落 = 泄漏） */
  active = 0;

  get idle(): number {
    return this._idle.length;
  }

  constructor(
    create: () => T,
    onGet?: (obj: T) => void,
    onPut?: (obj: T) => void,
    opts: PoolOptions = {}
  ) {
    this._create = create;
    this._onGet = onGet;
    this._onPut = onPut;
    this._maxSize = opts.maxSize ?? 1000;
    this._trackLeaks = opts.trackLeaks ?? false;
    this._guard = opts.guardDuplicate ?? true;
    this._warnDup = opts.warnOnDuplicate ?? true;
    this._inIdle = this._guard ? new Set<T>() : null;
  }

  /**
   * 预热：提前创建 N 个，避免运行中创建造成卡顿尖峰
   *
   * 【⚠️ n 必须有上界】
   *
   * 老实现是裸的 `for (let i = 0; i < n; i++)`：
   * - `n = Infinity` → **无限创建，进程立即 OOM**
   * - `n = NaN` → `i < NaN` 恒假，静默什么都不做（这个还算温和）
   *
   * Infinity 那条是全库"无界 count"模式的一员（见 `_core/guard.ts`），
   * 该模式在 fov / buff / loot 等单元上实测确认会卡死进程。
   *
   * 【⚠️ 上界为什么用 needCount 的默认值，而不是 maxSize】
   *
   * 我第一版写的是 `Math.min(needCount(...), this._maxSize)`，
   * 顺手把 prewarm 夹到了 maxSize 以内——**这是错的**，已回退。
   *
   * `maxSize` 的语义是"**归还时**若空闲已达上限则真正销毁"，
   * 它管的是运行时的回收上限，不是预分配上限。
   * 既有测试明确断言了这条契约：
   * `prewarm(20)` 配 `maxSize: 3` 应当得到 `idle === 20`
   * ——"预热就是要预分配，不该被 maxSize 截断"。
   *
   * 两者是独立的设计决策。我要防的是 **Infinity 导致 OOM**，
   * 不是要重新定义预热与容量的关系。顺手改掉一个既有设计决策，
   * 正是返工纪律里明令禁止的"顺手重构"。
   */
  prewarm(n: number): void {
    const count = needCount(n, 'prewarm.n');
    for (let i = 0; i < count; i++) {
      const o = this._createNew();
      this._idle.push(o);
      this._inIdle?.add(o);
    }
  }

  private _createNew(): T {
    this.created++;
    return this._create();
  }

  get(): T {
    const obj = this._idle.length > 0 ? this._idle.pop()! : this._createNew();
    this._inIdle?.delete(obj);
    this.active++;

    if (this._trackLeaks) {
      this._out.set(obj, {
        obj,
        stack: new Error().stack,
        time: Date.now(),
      });
    }

    // 【关键】取出前必须重置，否则复用对象带着上一次的状态
    // 这是对象池最经典的 bug：新子弹带着上一颗的位置和速度
    this._onGet?.(obj);
    return obj;
  }

  put(obj: T): void {
    // 【⚠️ 重复归还拦截】
    //
    // 同一个对象 put 两次，不拦的话会：
    //   ① active 变负数 → 泄漏检测彻底失效（真泄漏时看到的也是 0 或负数）
    //   ② 空闲池里塞进两个相同引用 → 之后 get() 两次拿到**同一个对象**
    //
    // 后者在子弹池里的表现是"两颗子弹一起飞"——改一颗的位置另一颗跟着变。
    // 这种症状极难联想回"某处多还了一次"。
    //
    // 这是**调用方的 bug**，所以修正的同时打一条警告：静默修正会掩盖它。
    if (this._inIdle && this._inIdle.has(obj)) {
      if (this._warnDup) {
        console.warn(
          `[Pool] 重复归还：这个对象已在空闲池里，本次 put 已忽略。` +
            `通常是同一处逻辑还了两次（如"命中"和"生命周期结束"各还一次）。`
        );
      }
      return;
    }

    if (this._trackLeaks) this._out.delete(obj);
    /**
     * 【⚠️ active 不能减到负数】
     *
     * 最常见的触发路径是 `destroy()` 之后：destroy 把 active 归零，
     * 但那时借出去的对象还在外部，切场景后它们被归还就会一路减成负数
     * （实测：get 两次 → destroy → put 两次 → active === -2）。
     *
     * active 是**泄漏检测的唯一指标**，一旦为负就会说谎：
     * 真的泄漏了 5 个，看到的却是 -2，而"负数"比"正数增长"更不像故障，
     * 排查时根本不会往泄漏上想。
     */
    this.active = Math.max(0, this.active - 1);

    // 归还前休眠：断开引用、停止计时、隐藏节点
    //
    // 【为什么超出容量也要调 onPut】
    // 对象最终没进池（会被 GC），但"休眠"语义必须执行——
    // 否则被丢弃的对象还持有外部引用，那就是真泄漏。
    this._onPut?.(obj);

    if (this._idle.length < this._maxSize) {
      this._idle.push(obj);
      this._inIdle?.add(obj);
    }
    // 超出容量则丢弃（交给 GC），不无限增长
  }

  /** 批量归还 */
  putAll(objs: Iterable<T>): void {
    for (const o of objs) this.put(o);
  }

  /**
   * 清空空闲对象
   *
   * 【⚠️ 只清空闲的，不动 active】
   * 借出去还没还的那些对象仍算 `active`——它们在外面，池管不着。
   * 想彻底重置（切场景）用 `destroy()`。
   */
  clear(): void {
    this._idle.length = 0;
    this._inIdle?.clear();
  }

  /**
   * 泄漏报告：列出超过 durationMs 仍未归还的对象及其创建栈
   *
   * 【为什么需要它】
   * 「只 get 不 put」是对象池最常见的错误，表现为内存缓慢增长。
   * 没有这个工具，你只能看着内存曲线猜。
   */
  dump(thresholdMs = 5000): string {
    if (!this._trackLeaks) {
      return `[Pool] 未开启 trackLeaks。统计：created=${this.created} active=${this.active} idle=${this.idle}`;
    }
    const now = Date.now();
    const leaks = Array.from(this._out.values()).filter((i) => now - i.time > thresholdMs);

    let s = `[Pool] created=${this.created} active=${this.active} idle=${this.idle}`;
    if (leaks.length === 0) return s + '\n无泄漏。';

    s += `\n发现 ${leaks.length} 个疑似泄漏（超过 ${thresholdMs}ms 未归还）：\n`;
    for (const l of leaks.slice(0, 10)) {
      s += `\n--- 已借出 ${now - l.time}ms ---\n${l.stack}\n`;
    }
    return s;
  }

  /** 【铁律 5】可卸载：清空池与追踪表 */
  destroy(): void {
    this._idle.length = 0;
    this._inIdle?.clear();
    this._out.clear();
    this.active = 0;
  }
}
