/**
 * DIContainer —— 轻量依赖注入容器
 *
 * 【它解决什么】
 *
 * 随着项目变大，你会写出这样的构造链：
 * ```typescript
 * const bus = new EventBus();
 * const rng = new RNG(seed);
 * const loot = new LootTable(rng);
 * const drops = new DropService(loot, rng);
 * const combat = new CombatService(bus, drops, new DamagePipeline());
 * const ai = new AIService(bus, combat);
 * const game = new Game(bus, combat, ai, ...);
 * ```
 * 每加一个依赖，就要改一遍所有下游的构造调用。
 * 更糟的是测试：为了给 combat 换一个假的 rng，你得把整条链重造一遍。
 *
 * 容器把「谁依赖谁」从构造代码里抽出来，变成**声明**：
 * ```typescript
 * c.register('rng', () => new RNG(seed));
 * c.register('bus', () => new EventBus(), { singleton: true });
 * c.register('combat', (c) => new CombatService(c.get('bus'), c.get('rng')));
 *
 * const combat = c.get<CombatService>('combat');
 * ```
 *
 * 【为什么叫"轻量"】
 * 它不做装饰器、不做自动扫描、不做 AOP。就是个
 * **带生命周期管理的工厂注册表**，约 200 行。
 * 这覆盖 95% 的需求，剩下 5% 你本来也不该用 DI 解决。
 *
 * 【什么时候不该用】
 * - 依赖只有一两层 → 直接 new 更清楚
 * - 依赖关系不会变 → 手写构造
 * - 性能敏感的热路径 → 直接持有引用，别每次 get()
 *
 * 【使用示例】
 * ```typescript
 * const c = new DIContainer();
 *
 * c.register('seed', () => 12345);
 * c.register('rng', (c) => new RNG(c.get<number>('seed')), { singleton: true });
 * c.register('bus', () => new EventBus(), { singleton: true });
 * c.register('loot', (c) => makeLootTable(c.get('rng')));
 *
 * const loot = c.get<LootTable>('loot');
 *
 * // 测试：换掉 rng 就行，下游全部自动跟上
 * const testC = c.fork();
 * testC.register('rng', () => new FixedRandomSource([0.5]));
 *
 * // 循环依赖会被检测到，而不是栈溢出
 * c.register('a', (c) => ({ b: c.get('b') }));
 * c.register('b', (c) => ({ a: c.get('a') }));
 * c.get('a');   // 抛错：检测到循环依赖 a → b → a
 * ```
 *
 * 【无引擎依赖】
 */

import { editDistance as editDistanceCore } from '../_core/string';
export type Lifetime = 'singleton' | 'transient';

export interface RegisterOptions {
  /** 生命周期（默认 singleton） */
  readonly lifetime?: Lifetime;
  /** 覆盖已存在的注册（默认 false，重复注册会抛错） */
  readonly override?: boolean;
}

export interface DIContainerOptions {
  /**
   * 销毁某个服务失败时的回调
   *
   * 【为什么需要它】
   * 销毁失败原先是直接 `console.error` 打出去的。库里写死 `console.error`
   * 会打乱宿主项目的日志格式（宿主通常有自己的日志分级、上报、脱敏），
   * 而且调用方拿到的是"打了日志但 `destroy()` 正常返回"——无法感知失败。
   *
   * 现在 `destroy()` 会返回收集到的错误消息数组；如果宿主想**立即**知道，
   * 就用这个钩子。两者都不用也可以：错误不会消失，只是静静地躺返回值里。
   */
  readonly onDisposeError?: (key: string, err: unknown) => void;
}

type Factory<T> = (c: DIContainer) => T;

interface Registration {
  readonly factory: Factory<unknown>;
  readonly lifetime: Lifetime;
}

export class DIContainer {
  private readonly _regs = new Map<string, Registration>();
  private readonly _singletons = new Map<string, unknown>();

  /** 正在解析的链（用于检测循环依赖） */
  private readonly _resolving: string[] = [];

  /**
   * 销毁函数表：key → 销毁函数（按注册顺序倒序执行）
   *
   * 【为什么用 Map 而不是数组】
   * 数组按**注册顺序**索引，跟 key 无关。覆盖注册同一个 key 时，
   * 旧 disposer 仍留在数组里，而它销毁时是"按 key 去 `_singletons` 里现取实例"——
   * 取到的已经是被覆盖后的**新**实例（或 undefined），旧实例永远拿不到引用。
   * 用 Map 才能在覆盖的那一刻精确定位并先销毁旧的那一个。
   *
   * 【为什么存"接收容器的函数"而不是闭包】
   * 闭包会捕获注册时的 `this`（父容器）。`fork()` 把销毁函数复制给子容器后，
   * 子容器销毁时会去**父容器**的 `_singletons` 里取实例来销毁——
   * 于是"子容器销毁"变成"销毁父容器持有的实例"，父容器随后拿到的就是已销毁对象。
   * 把容器作为参数传进来，同一份销毁逻辑在哪个容器上跑，就销毁哪个容器的实例。
   */
  private readonly _disposeFns = new Map<string, (c: DIContainer) => void>();

  private readonly _onDisposeError?: (key: string, err: unknown) => void;

  constructor(public readonly name = 'root', opts: DIContainerOptions = {}) {
    this._onDisposeError = opts.onDisposeError;
  }

  /**
   * 注册工厂
   *
   * @param key 标识
   * @param factory 工厂函数，参数是容器本身
   */
  register<T>(key: string, factory: Factory<T>, opts: RegisterOptions = {}): this {
    if (!opts.override && this._regs.has(key)) {
      throw new Error(`[DI] "${key}" 已注册。要覆盖请传 { override: true }`);
    }
    /**
     * 【⚠️ 覆盖注册前必须先把旧实例销毁掉，而不是丢掉引用】
     *
     * 销毁函数是"按 key 现取实例"的，不持有实例引用。
     * 所以如果这里只 `this._singletons.delete(key)` 就把引用扔掉，
     * 等到 `destroy()` 阶段它再去 `get(key)`，拿到的已经是被覆盖后写入的**新**实例——
     * 结果是：旧实例一次都没被销毁，而销毁阶段看起来还"正常执行了一次"，
     * 最有欺骗性。热重载 / 测试里覆盖注册一个持有事件监听或定时器的服务时，
     * 旧实例连同它的监听一起泄漏。
     *
     * 实测（修复前）：注册 a（destroy +1）→ `override:true` 重新注册 a（destroy +10）
     * → `destroy()` 后计数为 **10**，旧实例的 +1 从未发生。
     */
    if (opts.override && this._regs.has(key)) {
      /**
       * 【旧实例销毁失败要不要打断覆盖注册】不要。
       * 覆盖注册是"我就要换掉它"，旧实例清理失败不该让新注册进不来。
       * 有 `onDisposeError` 钩子就交给钩子；没有钩子时**抛出**——
       * 静默吞掉会让"旧服务没被销毁"这件事彻底无人知晓，那正是本条要修的问题。
       */
      try {
        this._disposeKey(key);
      } catch (e) {
        if (this._onDisposeError) this._onDisposeError(key, e);
        else throw e;
      }
    }

    this._regs.set(key, {
      factory: factory as Factory<unknown>,
      lifetime: opts.lifetime ?? 'singleton',
    });
    // 覆盖注册时，旧的单例失效
    this._singletons.delete(key);
    return this;
  }

  /** 注册一个常量值 */
  value<T>(key: string, v: T, opts: RegisterOptions = {}): this {
    return this.register(key, () => v, opts);
  }

  /**
   * 注册一个已构造好的实例（等价于 value，语义更清楚）
   *
   * 【典型用法】把外部对象（引擎的 director、已存在的 manager）塞进容器
   */
  instance<T>(key: string, v: T, opts: RegisterOptions = {}): this {
    return this.value(key, v, opts);
  }

  /**
   * 注册带销毁逻辑的单例
   *
   * 【为什么要显式注册销毁】
   * 容器不知道你的对象怎么清理（EventBus 要 clear，Scheduler 要 stop）。
   * 让容器猜会漏，不如让你明确说出来。
   */
  disposable<T extends { destroy(): void }>(
    key: string,
    factory: Factory<T>,
    opts: RegisterOptions = {}
  ): this {
    /**
     * 【⚠️ `disposable` + `transient` 是无效组合，直接拒绝注册】
     *
     * 容器根本不持有 transient 实例——`get()` 每次新建，从不写进 `_singletons`，
     * 所以销毁阶段无从下手：销毁函数去 `_singletons` 里永远取不到它。
     * 修复前这个组合被静默忽略（连销毁函数都不注册），
     * 调用方写了 `disposable(..., { lifetime: 'transient' })`，
     * 心理预期是"每次取的临时对象也会被回收"，实际一个都不会被销毁，
     * 编译期和运行时都不报错。这是典型的**配置组合静默失效**。
     *
     * 【为什么不改成"记录每次创建的 transient 实例，destroy 时统一销毁"】
     * 那要给每次 `get()` 追加一次数组写入，而 transient 的调用次数是无界的，
     * 等于在热路径上放了一个只增不减的数组——正是本库反复在消除的"无界增长"。
     * 与其让它静默失效，不如在注册这一刻就告诉调用方：这个组合不支持。
     */
    if ((opts.lifetime ?? 'singleton') !== 'singleton') {
      throw new Error(
        `[DI] disposable("${key}") 不支持 lifetime:'${opts.lifetime}'：` +
          `容器不持有 transient 实例，销毁阶段无从下手。` +
          `请改用 singleton（默认），或在调用方自己管理这批临时对象的生命周期。`
      );
    }

    this.register(key, factory, opts);
    // 只有真的被创建过才需要销毁，所以销毁函数里再取一次
    this._disposeFns.set(key, (c) => {
      const inst = c._singletons.get(key);
      if (inst && typeof (inst as { destroy?: unknown }).destroy === 'function') {
        (inst as { destroy(): void }).destroy();
      }
      c._singletons.delete(key);
    });
    return this;
  }

  has(key: string): boolean {
    return this._regs.has(key);
  }

  /**
   * 解析
   *
   * 【坑：循环依赖】
   * A 依赖 B，B 依赖 A —— 不检测的话是栈溢出（RangeError），
   * 报错信息完全看不出是 DI 的问题。这里显式检测并报出依赖链。
   */
  get<T>(key: string): T {
    if (this._resolving.includes(key)) {
      const chain = [...this._resolving.slice(this._resolving.indexOf(key)), key].join(' → ');
      throw new Error(`[DI] 检测到循环依赖：${chain}`);
    }

    const reg = this._regs.get(key);
    if (!reg) {
      const near = this._fuzzyKeys(key);
      throw new Error(
        `[DI] "${key}" 未注册。${near.length > 0 ? `你是不是想找：${near.join(', ')}` : ''}`
      );
    }

    if (reg.lifetime === 'singleton' && this._singletons.has(key)) {
      return this._singletons.get(key) as T;
    }

    this._resolving.push(key);
    let value: unknown;
    try {
      value = reg.factory(this);
    } catch (e) {
      // 解析失败时不要把半成品留在链上
      if (e instanceof Error && !e.message.startsWith('[DI]')) {
        throw new Error(`[DI] 构造 "${key}" 时出错：${e.message}`);
      }
      throw e;
    } finally {
      this._resolving.pop();
    }

    if (reg.lifetime === 'singleton') {
      this._singletons.set(key, value);
    }
    return value as T;
  }

  /**
   * 安全解析（不存在返回 undefined 而不是抛错）
   *
   * 【用途】可选依赖："有音频系统就用，没有就算了"
   */
  tryGet<T>(key: string): T | undefined {
    return this._regs.has(key) ? this.get<T>(key) : undefined;
  }

  /**
   * 派生一个子容器
   *
   * 【为什么需要】
   * 测试时你只想换掉一个依赖（比如 rng），
   * 但不想重建整条链。fork 出来的容器继承父容器的注册，
   * 可以覆盖其中任意一项，父容器不受影响。
   */
  fork(name = 'fork'): DIContainer {
    const child = new DIContainer(name, { onDisposeError: this._onDisposeError });
    for (const [k, v] of this._regs) child._regs.set(k, v);
    for (const [k, v] of this._singletons) child._singletons.set(k, v);
    /**
     * 【⚠️ 销毁责任也要一起继承】
     *
     * 以前只复制注册和单例，不复制销毁函数。于是按作用域 fork
     * （关卡容器 / 战斗容器，这是 DI 的标准用法）时，
     * 子容器现场创建的单例在 `child.destroy()` 时一个都不会被销毁，全部泄漏。
     *
     * 实测（修复前）：父容器 `disposable('svc', ...)` → `fork('child')`
     * → `child.get('svc')` → `child.destroy()` → 销毁计数为 **0**（期望 1）。
     *
     * 复制是安全的：销毁函数接收容器作为参数，
     * 在子容器上执行就销毁子容器 `_singletons` 里的实例，不会误伤父容器。
     */
    for (const [k, v] of this._disposeFns) child._disposeFns.set(k, v);
    return child;
  }

  /** 已注册的 key */
  get keys(): string[] {
    return Array.from(this._regs.keys());
  }

  get size(): number {
    return this._regs.size;
  }

  /**
   * 校验：能否解析所有注册项
   *
   * 【用途】启动时跑一次，能提前发现"某个服务依赖了没注册的东西"。
   * 这比运行时第一次用到才炸要好得多——尤其那个分支可能几小时后才走到。
   */
  validate(): string[] {
    const errors: string[] = [];
    for (const key of this._regs.keys()) {
      try {
        this.get(key);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return errors;
  }

  /**
   * 清空单例缓存（换关、重开时）
   *
   * 【坑】只清单例，不清注册。清注册的话你得重新注册一遍所有东西。
   */
  clearSingletons(): void {
    this._singletons.clear();
  }

  /** 删除某个注册（连同它的单例） */
  unregister(key: string): boolean {
    this._singletons.delete(key);
    return this._regs.delete(key);
  }

  /**
   * 销毁：调用所有注册过的 disposer，然后清空
   *
   * 【顺序】倒序销毁——后创建的先销毁，符合直觉（依赖方先于被依赖方销毁）
   *
   * 【失败怎么处理】不再 `console.error`（库里写死 console 会打乱宿主的日志格式），
   * 而是收集成消息数组返回；宿主想立即感知就传 `onDisposeError` 钩子。
   * 单个服务销毁失败**不会**中断其余服务的销毁。
   *
   * @returns 销毁过程中收集到的错误消息（全部成功时为空数组）
   */
  destroy(): string[] {
    const errors: string[] = [];
    // 快照后倒序遍历：销毁过程中会有 disposer 增删（覆盖注册、unregister）
    const entries = Array.from(this._disposeFns.entries());
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, dispose] = entries[i];
      try {
        dispose(this);
      } catch (e) {
        errors.push(
          `[DI] 销毁 "${key}" 出错：${e instanceof Error ? e.message : String(e)}`
        );
        if (this._onDisposeError) this._onDisposeError(key, e);
      }
    }
    this._disposeFns.clear();
    this._singletons.clear();
    this._regs.clear();
    this._resolving.length = 0;
    return errors;
  }

  // ==================== 内部 ====================

  /**
   * 立即销毁某个 key 的单例（前提是它注册过销毁函数）
   *
   * 【为什么要有这个】覆盖注册时要在写入新注册**之前**把旧实例销毁掉，
   * 否则旧实例的引用被 `_singletons.delete(key)` 丢掉后就再也找不回来了。
   */
  private _disposeKey(key: string): void {
    const dispose = this._disposeFns.get(key);
    if (!dispose) return;
    this._disposeFns.delete(key);
    dispose(this);
  }

  /**
   * 找相似的 key，用于"你是不是想找 xxx"的提示
   *
   * 【为什么需要编辑距离】
   * 朴素的子串匹配（a.includes(b)）对**拼写错误**完全无效：
   * `playerServce` 和 `playerService` 互不包含，匹配不上。
   *
   * 而拼写错误恰恰是最常见的失败原因——
   * 这时候给一句"你是不是想找 playerService"，能省下五分钟。
   */
  private _fuzzyKeys(key: string): string[] {
    const scored: Array<{ key: string; dist: number }> = [];
    for (const k of this._regs.keys()) {
      const d = editDistance(key, k);
      // 阈值随长度放宽：短 key 容忍 1 个字符差异，长 key 容忍更多
      const threshold = Math.max(1, Math.floor(k.length / 4));
      if (d <= threshold) scored.push({ key: k, dist: d });
    }
    scored.sort((a, b) => a.dist - b.dist);
    return scored.slice(0, 3).map((s) => s.key);
  }
}

/**
 * 便捷：创建一个"服务定位器"风格的容器
 *
 * 【注意】服务定位器（在业务代码里到处 `Services.get('x')`）通常被视为反模式，
 * 因为它把依赖关系**隐藏**了——你看类的构造函数看不出它依赖什么。
 *
 * 正确用法：只在**组合根**（main.ts）里用容器解析一次，
 * 然后把解析出来的对象通过构造函数传给下游。
 */
export function createContainer(name?: string): DIContainer {
  return new DIContainer(name);
}

/**
 * Levenshtein 编辑距离（两字符数组实现，省一次分配）
 *
 * 用于 DI 的"你是不是想找 xxx"提示。
 */
/**
 * 【同算法的其他实现 —— 库里共 3 份，别当成一个东西】
 *
 * | 模块 | 函数 | 返回值语义 |
 * |---|---|---|
 * | `cheatcode` | `levenshtein(a, b)` | **距离**，整数，越小越像 |
 * | `di` | `editDistance(a, b)` | **距离**，整数，越小越像 |
 * | `debug-console` | `similarity(a, b)` | **相似度**，0~1，越大越像 |
 *
 * 实测：`"setgold"` vs `"setgld"` → levenshtein = 1，similarity = 0.857。
 *
 * 【坑】距离和相似度是**相反**的方向。
 * 拿 distance 的结果去当相似度用（或反过来），结果会完全颠倒。
 *
 * 【已统一】
 * 三份实现现已合并到 `_core/string.ts`，本函数只是转发。
 */
/**
 * 编辑距离（本模块私有，用于提示"你是不是想输入 xxx"）
 *
 * 【实现已下沉到 `_core/string.ts`】
 * 曾是本模块自己写的一份，与 `cheatcode` / `debug-console` 重复。
 * 现在统一转发到 `_core`。
 */
function editDistance(a: string, b: string): number {
  return editDistanceCore(a, b);
}
