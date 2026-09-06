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

  /** 销毁时调用的清理函数（按注册顺序倒序） */
  private readonly _disposers: Array<() => void> = [];

  constructor(public readonly name = 'root') {}

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
    this.register(key, factory, opts);
    if ((opts.lifetime ?? 'singleton') === 'singleton') {
      // 只有真的被创建过才需要销毁，所以销毁器里再取一次
      this._disposers.push(() => {
        const inst = this._singletons.get(key);
        if (inst && typeof (inst as { destroy?: unknown }).destroy === 'function') {
          (inst as { destroy(): void }).destroy();
        }
        this._singletons.delete(key);
      });
    }
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
    const child = new DIContainer(name);
    for (const [k, v] of this._regs) child._regs.set(k, v);
    for (const [k, v] of this._singletons) child._singletons.set(k, v);
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
   */
  destroy(): void {
    for (let i = this._disposers.length - 1; i >= 0; i--) {
      try {
        this._disposers[i]();
      } catch (e) {
        console.error(`[DI] 销毁出错：${e}`);
      }
    }
    this._disposers.length = 0;
    this._singletons.clear();
    this._regs.clear();
    this._resolving.length = 0;
  }

  // ==================== 内部 ====================

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
