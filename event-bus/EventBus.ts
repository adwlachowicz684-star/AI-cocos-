/**
 * EventBus —— 类型安全的事件总线
 *
 * 【它解决什么】
 * 解耦发送方与接收方：A 不需要认识 B，只要双方都认识事件名。
 *
 * 【它不解决什么】
 * 需要返回值、严格顺序、每帧高频（>100/s）的场景。
 * 判据：**一个事件如果只有一个监听者，那它应该是直接调用**，不是事件。
 *
 * 【滥用警告】
 * 事件最大的风险是「隐式耦合」——直接调用至少有调用栈可查，
 * 事件是"发出去就不知道谁接了"，滥用后没人敢删任何一个 emit。
 *
 * 【使用示例】
 * ```typescript
 * interface GameEvents {
 *   'hp:change': { cur: number; max: number };
 *   'enemy:died': { id: string; by: string };
 * }
 * const bus = new EventBus<GameEvents>();
 *
 * // on 返回取消函数——比 off(name, fn) 更难出错
 * const off = bus.on('hp:change', (d) => ui.update(d.cur));
 * bus.emit('hp:change', { cur: 3, max: 10 });
 * off();  // 或用 bus.destroy() 全清
 * ```
 */

type Handler<T> = (payload: T) => void;

export interface EventBusOptions {
  /**
   * 错误隔离：某个监听器抛异常时是否吞掉（继续通知其他监听器）。
   * 默认 true——一个监听器出错不该影响其他人。
   * 开发期可设为 false 以便快速暴露问题。
   */
  readonly swallowErrors?: boolean;

  /** 追踪模式：打印每次发布/订阅，用于排查"谁没收到" */
  readonly trace?: boolean;
}

export class EventBus<Events extends object> {
  private readonly _map = new Map<keyof Events, Set<Handler<never>>>();
  private readonly _opts: EventBusOptions;

  /** 统计：当前监听器总数（排查泄漏用） */
  get listenerCount(): number {
    let n = 0;
    for (const set of this._map.values()) n += set.size;
    return n;
  }

  constructor(opts: EventBusOptions = {}) {
    // 【⚠️ 默认值必须在这里兜住，不能靠 `!this._opts.swallowErrors` 判空】
    //
    // 以前的实现是直接 `this._opts = opts`，而 emit 里判
    // `if (!this._opts.swallowErrors) throw e`。
    // 不传 opts 时 swallowErrors 是 undefined → falsy → **抛异常**，
    // 与注释里写的"默认 true"完全相反。
    //
    // 后果很隐蔽：开发环境你可能显式传了 `{ swallowErrors: true }`
    // 一切正常；换到生产代码忘了传，一个监听器出错就中断整条事件链——
    // 表现为"某个 UI 突然不刷新了"，而且没有任何日志。
    this._opts = {
      swallowErrors: true,
      trace: false,
      ...opts,
    };
  }

  /**
   * 订阅。返回一个取消订阅的函数。
   *
   * 【为什么返回函数而不是提供 off(name, fn)】
   * off(name, fn) 需要调用方保留 fn 的引用，很容易因为写成箭头函数
   * （每次都是新函数）导致取消失败——这是最常见的事件泄漏原因。
   * 返回取消函数把这件事变成必然正确。
   */
  on<K extends keyof Events>(name: K, fn: Handler<Events[K]>): () => void {
    let set = this._map.get(name);
    if (!set) {
      set = new Set();
      this._map.set(name, set);
    }
    set.add(fn as Handler<never>);

    if (this._opts.trace) console.log(`[EventBus] +on ${String(name)} (total ${this.listenerCount})`);

    let active = true;
    return () => {
      if (!active) return;
      active = false; // 幂等：重复调用不会误删别人的监听器
      set!.delete(fn as Handler<never>);
      if (set!.size === 0) this._map.delete(name);
    };
  }

  /** 只触发一次 */
  once<K extends keyof Events>(name: K, fn: Handler<Events[K]>): () => void {
    const off = this.on(name, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  /**
   * 发布事件
   *
   * 【坑：遍历期间增删】
   * 监听器 A 执行后把自己 off 掉，如果用普通数组遍历就会跳过后续监听器
   * 甚至越界。这里用快照遍历——有性能开销但安全。
   * 如果你确认某条高频路径不会在回调中增删，可以接受这个开销
   * （Set 的快照成本远低于数组 splice 的代价）。
   */
  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    const set = this._map.get(name);
    if (!set || set.size === 0) return;

    if (this._opts.trace) console.log(`[EventBus] emit ${String(name)} → ${set.size} 个监听器`);

    const snapshot = Array.from(set);
    for (const fn of snapshot) {
      // 监听器可能在遍历中已被移除
      if (!set.has(fn)) continue;
      try {
        (fn as Handler<Events[K]>)(payload);
      } catch (e) {
        if (!this._opts.swallowErrors) throw e;
        console.error(`[EventBus] 监听器执行出错 (${String(name)}):`, e);
      }
    }
  }

  /** 移除某个事件的所有监听器 */
  off<K extends keyof Events>(name: K): void {
    this._map.delete(name);
  }

  /** 移除所有监听器（destroy 时调用） */
  offAll(): void {
    this._map.clear();
  }

  has<K extends keyof Events>(name: K): boolean {
    const s = this._map.get(name);
    return !!s && s.size > 0;
  }

  /** 【铁律 5】可卸载：清空所有监听器 */
  destroy(): void {
    this.offAll();
  }
}
