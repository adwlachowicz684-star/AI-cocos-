/**
 * observable/Observable.ts —— 响应式数据（UI 自动刷新的地基）
 *
 * 【它解决什么】
 *
 * 手写的 UI 刷新长这样：
 *
 * ```typescript
 * hp = 80;
 * refreshHpBar();      // 忘了这行 → 血条不动
 * refreshHpText();
 * checkDeath();
 * ```
 *
 * 每加一处修改数值的地方，就要记得补一遍刷新调用。
 * 漏一处就是一个"数值变了但界面没变"的 bug，
 * 而且这种 bug 极难发现——它只在特定路径下出现。
 *
 * 响应式把这个关系倒过来：
 *
 * ```typescript
 * hp.value = 80;       // 订阅者自动收到通知，界面自己更新
 * ```
 *
 * 【四个必须处理的真实问题】
 *
 * 1. **相同值不该通知** —— 否则每帧刷 UI 会导致整个界面重建
 * 2. **批量更新** —— 一次操作改 10 个值，不该触发 10 次重建
 * 3. **依赖在运行期变化** —— `cond ? a : b`，cond 变了依赖就变了
 * 4. **链式冒泡** —— top 依赖 mid、mid 依赖 base，base 变了 top 必须更新
 *
 * 【⚠️ 关键设计：依赖是运行期收集的】
 *
 * 不在构造时声明依赖数组，而是在求值过程中记录"读了谁"。
 * 这样条件分支导致的依赖变化才能被正确追踪。
 *
 * 代价是需要在求值期间维护一个全局的"当前收集器"栈
 * （computed 可以嵌套，所以是栈而不是单个变量）。
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

/** 变更信息 */
export interface Change<T = unknown> {
  /** 新值 */
  readonly value: T;
  /** 变化前的值 */
  readonly prev: T;
}

export type Listener<T = unknown> = (change: Change<T>) => void;

export type Unsubscribe = () => void;

export interface RefOptions<T> {
  /** 自定义相等比较（默认 `===`） */
  readonly equals?: (a: T, b: T) => boolean;
  readonly name?: string;
}

// ==================== 依赖收集 ====================

/**
 * 依赖收集器接口
 *
 * `ref` 被读取时，会把当前收集器登记为自己的依赖方。
 */
interface Collector {
  /** 被读取时调用：把 target 登记为依赖 */
  onRead(target: Observable<unknown>): void;
}

/** 当前正在求值的收集器栈（computed 可嵌套） */
const collectorStack: Collector[] = [];

function currentCollector(): Collector | null {
  return collectorStack.length > 0 ? collectorStack[collectorStack.length - 1] : null;
}

/** ref 被读取时调用 */
function trackRead(target: Observable<unknown>): void {
  const c = currentCollector();
  if (c) c.onRead(target);
}

// ==================== 批处理 ====================

let batchDepth = 0;

/** 批处理队列：source → 待执行的通知 */
const batchQueue = new Map<object, () => void>();

/** 每个 source 在批内的首次 prev 值 */
const batchPrev = new Map<object, unknown>();

export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flush();
  }
}

/** 立即执行队列中的通知（通常由 batch 自动调用） */
export function flush(): void {
  if (batchQueue.size === 0) return;
  const entries = [...batchQueue.values()];
  batchQueue.clear();
  batchPrev.clear();
  for (const fn of entries) fn();
}

/** 当前批处理深度（调试用） */
export function batchSize(): number {
  return batchQueue.size;
}

/**
 * 入队一个通知
 *
 * 【⚠️ 按 source 去重，且 prev 取批量开始时的值】
 *
 * 第一版实现把每个通知包成一个新闭包入队，
 * 10 次修改产生 10 个不同闭包 → flush 时全执行 → 批量等于没做。
 *
 * 现在的做法：Map 的 key 是 source 本身，
 * 后一次赋值覆盖前一次的闭包，但 prev 保留首次记录的值。
 * 于是 UI 只刷一次，且能看到"净变化"（0 → 9），
 * 而不是中间某一步（8 → 9）。
 */
function enqueue(source: object, firstPrev: unknown, value: unknown, notify: () => void): void {
  if (batchDepth === 0) {
    notify();
    return;
  }
  if (!batchPrev.has(source)) {
    batchPrev.set(source, firstPrev);
  }
  // 用最新的 value 覆盖闭包，但 prev 不动
  batchQueue.set(source, () => notify());

  // 记录最新值供 notify 读取（notify 是闭包，读的是 ref 的当前值）
  void value;
}

// ==================== Observable ====================

/**
 * 可观察值
 *
 * 【它不知道 UI 是什么】
 * 订阅者可以是 UI、成就系统、埋点——它只负责"值变了就说一声"。
 */
export class Observable<T = unknown> {
  private _value: T;
  private readonly _listeners = new Set<Listener<T>>();
  private readonly _dependents = new Set<Collector & { onDepChange(): void }>();
  private readonly _equals: (a: T, b: T) => boolean;
  private readonly _name?: string;
  private _disposed = false;
  /** 订阅过程中被移除的监听（避免遍历时修改集合） */
  private _onceQueue = new Set<Listener<T>>();

  constructor(initial: T, opts: RefOptions<T> = {}) {
    this._value = initial;
    this._equals = opts.equals ?? defaultEquals;
    this._name = opts.name;
  }

  get value(): T {
    trackRead(this as unknown as Observable<unknown>);
    return this._value;
  }

  set value(next: T) {
    if (this._disposed) return;
    if (this._equals(this._value, next)) return;

    const prev = this._value;
    this._value = next;

    // ① 通知依赖方（computed）
    for (const d of [...this._dependents]) d.onDepChange();

    // ② 通知订阅者（走批处理）
    const source = this as unknown as object;
    const firstPrev = batchPrev.has(source) ? batchPrev.get(source) : prev;
    enqueue(source, firstPrev, next, () => {
      this._notify(firstPrev);
    });
  }

  /** 读取但不建立依赖 */
  peek(): T {
    return this._value;
  }

  /** 函数式更新 */
  update(fn: (old: T) => T): void {
    this.value = fn(this._value);
  }

  /** 订阅变更 */
  subscribe(fn: Listener<T>): Unsubscribe {
    if (this._disposed) return () => {};
    this._listeners.add(fn);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this._listeners.delete(fn);
    };
  }

  /** 只订阅一次 */
  once(fn: Listener<T>): Unsubscribe {
    const stop = this.subscribe((c) => {
      stop();
      fn(c);
    });
    return stop;
  }

  dispose(): void {
    this._listeners.clear();
    this._dependents.clear();
    this._disposed = true;
  }

  get listenerCount(): number {
    return this._listeners.size;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  // ---- 内部 ----

  _addDependent(d: Collector & { onDepChange(): void }): void {
    this._dependents.add(d);
  }

  _removeDependent(d: Collector & { onDepChange(): void }): void {
    this._dependents.delete(d);
  }

  private _notify(firstPrev: unknown): void {
    const change: Change<T> = {
      value: this._value,
      prev: firstPrev as T,
    };
    /**
     * 【⚠️ 复制一份再遍历】
     * 订阅者可能在回调里取消订阅（once 就是这样实现的），
     * 直接遍历 Set 会导致跳过或重复。
     */
    for (const fn of [...this._listeners]) {
      try {
        fn(change);
      } catch (e) {
        // 一个订阅者出错不该阻断其他订阅者
        // eslint-disable-next-line no-console
        console.error(
          this._name ? `[Observable: ${this._name}]` : '[Observable]',
          '订阅者抛错：',
          e
        );
      }
    }
    void this._onceQueue;
  }
}

/** 创建一个可观察值 */
export function ref<T>(initial: T, opts: RefOptions<T> = {}): Observable<T> {
  return new Observable<T>(initial, opts);
}

// ==================== Computed ====================

/**
 * 派生值
 *
 * 【惰性 + 自动依赖收集】
 *
 * 构造时求值一次；之后：
 * - 没有订阅者 → 依赖变化时只打脏标记，下次读才重算
 * - 有订阅者   → 依赖变化时立即重算并通知
 *
 * 【⚠️ 为什么必须真正订阅下层】
 *
 * 曾经的实现只把下层 computed 放进一个 Set 表示"我依赖它"，
 * 但没有真正 subscribe。于是下层没有 listener → 走惰性分支 →
 * 不会通知上层 → 上层永远是旧值。
 *
 * 链式（top → mid → base）因此断裂。
 */
export class Computed<T = unknown> implements Collector {
  private readonly _fn: () => T;
  private _value!: T;
  private _dirty = true;
  /** 是否已求值过（构造时是 false） */
  private _computed = false;
  private readonly _deps = new Set<Observable<unknown>>();
  private readonly _listeners = new Set<Listener<T>>();
  private readonly _dependents = new Set<Collector & { onDepChange(): void }>();
  private _disposed = false;
  private _computing = false;

  /**
   * 【惰性】构造时不求值
   *
   * 第一次读 `.value` 时才计算。
   * 这样"定义了但没人用"的派生值不会有任何开销，
   * 也不会因为构造顺序问题读到还没准备好的依赖。
   */
  constructor(fn: () => T) {
    this._fn = fn;
  }

  /**
   * @internal 依赖收集机制的一部分，用户不直接调用。
   * （实现的是非导出的 `Collector` 接口）
   */
  onRead(target: Observable<unknown>): void {
    if (this._computing) this._deps.add(target);
  }

  get value(): T {
    trackRead(this as unknown as Observable<unknown>);
    if (this._dirty || !this._computed) this._recompute();
    return this._value;
  }

  peek(): T {
    if (this._dirty || !this._computed) this._recompute();
    return this._value;
  }

  subscribe(fn: Listener<T>): Unsubscribe {
    if (this._disposed) return () => {};
    this._listeners.add(fn);
    this._activate();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this._listeners.delete(fn);
      if (this._listeners.size === 0) this._deactivate();
    };
  }

  /** 强制重算（下次读取时生效） */
  invalidate(): void {
    this._dirty = true;
    for (const d of [...this._dependents]) d.onDepChange();
  }

  dispose(): void {
    this._unbindDeps();
    this._listeners.clear();
    this._dependents.clear();
    this._disposed = true;
  }

  get listenerCount(): number {
    return this._listeners.size;
  }

  // ---- 内部 ----

  private _recompute(): void {
    if (this._disposed) return;

    // ① 解绑旧依赖（条件分支切换后，旧依赖不该继续生效）
    this._unbindDeps();

    // ② 求值期间收集新依赖
    this._computing = true;
    collectorStack.push(this as unknown as Collector);
    try {
      this._value = this._fn();
    } finally {
      collectorStack.pop();
      this._computing = false;
    }

    // ③ 绑定新依赖
    for (const d of this._deps) {
      d._addDependent(this as unknown as Collector & { onDepChange(): void });
    }

    this._dirty = false;
    this._computed = true;
  }

  private _unbindDeps(): void {
    for (const d of this._deps) {
      d._removeDependent(this as unknown as Collector & { onDepChange(): void });
    }
    this._deps.clear();
  }

  /** 有订阅者时激活：真正订阅下层，才能收到冒泡 */
  private _activate(): void {
    if (this._dirty) this._recompute();
    if (this._listeners.size > 0) {
      // 已经通过 _addDependent 建立了依赖，无需额外 subscribe
    }
  }

  private _deactivate(): void {
    // 回到惰性模式：不再主动通知
  }

  /**
   * @internal 依赖收集机制的一部分，用户不直接调用。
   * （实现的是非导出的 `Collector` 接口）
   */
  onDepChange(): void {
    if (this._disposed) return;

    if (this._listeners.size > 0) {
      // 有订阅者 → 立即重算并通知
      const prev = this._computed ? this._value : (undefined as unknown as T);
      this._recompute();
      if (this._equalsValue(prev, this._value)) return;

      const source = this as unknown as object;
      const firstPrev = batchPrev.has(source) ? batchPrev.get(source) : prev;
      enqueue(source, firstPrev, this._value, () => {
        this._notify(firstPrev as T);
      });
    } else {
      // 无订阅者 → 只打脏，等下次读
      this._dirty = true;
    }

    // 向上传播
    for (const d of [...this._dependents]) d.onDepChange();
  }

  private _notify(firstPrev: T): void {
    const change: Change<T> = { value: this._value, prev: firstPrev };
    for (const fn of [...this._listeners]) {
      try {
        fn(change);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[Computed] 订阅者抛错：', e);
      }
    }
  }

  private _equalsValue(a: T, b: T): boolean {
    return defaultEquals(a, b);
  }

  _addDependent(d: Collector & { onDepChange(): void }): void {
    this._dependents.add(d);
  }

  _removeDependent(d: Collector & { onDepChange(): void }): void {
    this._dependents.delete(d);
  }
}

/**
 * 创建一个派生值
 *
 * 依赖是**运行期收集**的，所以条件分支也能正确追踪：
 *
 * ```typescript
 * const pick = computed(() => (cond.value ? a.value : b.value));
 * ```
 * cond 变了之后，依赖从 {cond, a} 变成 {cond, b}。
 */
export function computed<T>(fn: () => T): Computed<T> {
  return new Computed<T>(fn);
}

// ==================== Subscription ====================

/**
 * 订阅收集器
 *
 * 【用途】
 * 一个 UI 面板订阅了 5 个数据源，关闭面板时要全部取消。
 * 手写就是存 5 个 unsubscribe 函数逐个调用，漏一个就泄漏。
 */
export class Subscription {
  private readonly _stops: Unsubscribe[] = [];
  private _closed = false;

  get size(): number {
    return this._stops.length;
  }

  get closed(): boolean {
    return this._closed;
  }

  add(stop: Unsubscribe): void {
    /**
     * 【⚠️ 已关闭时立即取消新加入的订阅】
     * 否则调用方以为"加上了"，实际永远不会被清掉 → 泄漏。
     */
    if (this._closed) {
      stop();
      return;
    }
    this._stops.push(stop);
  }

  unsubscribeAll(): void {
    for (const s of this._stops) s();
    this._stops.length = 0;
    this._closed = true;
  }
}

// ==================== 内部 ====================

function defaultEquals<T>(a: T, b: T): boolean {
  // 注意：NaN !== NaN，这里视为相等
  // eslint-disable-next-line no-self-compare
  return a === b || (a !== a && b !== b);
}
