/**
 * Assert —— 快速失败的断言工具
 *
 * 【核心理念：开发期的崩溃是朋友，不是敌人】
 *
 * 两种错误处理方式：
 * ```typescript
 * // 静默失败：问题被藏起来，三小时后以完全无关的形态爆发
 * if (hp < 0) return;                    // ❌
 *
 * // 快速失败：立刻崩在出错的那一行，栈指着你
 * Assert.isTrue(hp >= 0, 'HP 为负');     // ✅
 * ```
 *
 * 第一种你会花三小时找「为什么敌人不动了」，
 * 第二种你花三秒改掉那行。
 *
 * 【为什么生产环境要 Strip】
 * 断言有运行时开销，而且生产环境崩溃比"带病运行"更糟
 * （玩家正在打 Boss 时崩溃，体验极差）。
 *
 * 所以约定：**断言只在开发期生效**，生产构建时通过压缩器移除。
 * 判断依据是用 `__DEV__` 之类的编译期常量，而不是运行时 if——
 * 运行时 if 的话，断言代码仍然会被打进包里。
 *
 * 【使用示例】
 * ```typescript
 * // 最常见的用法
 * Assert.notNull(target, '伤害目标不能为空');
 * Assert.range(damage, 0, 9999, '伤害值超出合理范围');
 *
 * // 表明"这行不该到达"，帮助引擎做类型收窄
 * const v = map.get(key);
 * Assert.found(v, `配置 ${key} 不存在`);
 * // 此后 v 必定非空
 * ```
 */

/**
 * 断言失败时抛出
 *
 * 【为什么自定义错误类型】
 * 便于在崩溃上报里区分「断言失败」和「普通异常」——
 * 断言失败意味着**程序逻辑有 bug**，优先级最高。
 */
export class AssertionError extends Error {
  constructor(message: string) {
    super(`[断言失败] ${message}`);
    this.name = 'AssertionError';
    // 【坑】继承内置 Error 时必须手动恢复原型链，
    // 否则 `err instanceof AssertionError` 在 ES5 编译目标下会返回 false
    Object.setPrototypeOf(this, AssertionError.prototype);
  }
}

export class Assert {
  /**
   * 条件必须为真
   *
   * @param cond 条件
   * @param msg 失败信息。**必须写清楚「什么不该发生」**，
   *            而不是「assert failed」——后者等于没写
   */
  static isTrue(cond: boolean, msg = '条件不成立'): void {
    if (!cond) throw new AssertionError(msg);
  }

  static isFalse(cond: boolean, msg = '条件不应成立'): void {
    if (cond) throw new AssertionError(msg);
  }

  /** 值必须非 null / undefined */
  static notNull<T>(value: T | null | undefined, msg = '值不应为空'): asserts value is T {
    if (value === null || value === undefined) {
      throw new AssertionError(msg);
    }
  }

  /** 值必须为空（用于"这个对象应该已被释放"之类的检查） */
  static isNull(value: unknown, msg = '值应为空'): void {
    if (value !== null && value !== undefined) throw new AssertionError(msg);
  }

  /** 数字必须在 [min, max] 区间内 */
  static range(value: number, min: number, max: number, msg = ''): void {
    if (Number.isNaN(value) || value < min || value > max) {
      throw new AssertionError(msg || `${value} 超出 [${min}, ${max}]`);
    }
  }

  /**
   * 数字必须是有限数（非 NaN、非 Infinity）
   *
   * 【为什么值得单独一个】
   * NaN 是最善于隐藏的 bug：`NaN > 0` 是 false，`NaN === NaN` 也是 false。
   * 一个 NaN 混进伤害计算，会一路传播到 HP，
   * 表现是「角色血量突然变成 NaN 然后打不死」，排查非常痛苦。
   */
  static finite(value: number, msg = '数值必须是有限数'): void {
    if (!Number.isFinite(value)) throw new AssertionError(`${msg}（实际 ${value}）`);
  }

  /** 数组索引必须合法 */
  static index(index: number, length: number, msg = ''): void {
    if (!Number.isInteger(index) || index < 0 || index >= length) {
      throw new AssertionError(msg || `索引 ${index} 越界（长度 ${length}）`);
    }
  }

  /** 数组/字符串非空 */
  static notEmpty<T>(arr: readonly T[], msg = '集合不应为空'): void {
    if (!arr || arr.length === 0) throw new AssertionError(msg);
  }

  /**
   * 查找必须成功
   *
   * 【为什么单独一个】
   * 这是最高频的断言：`map.get(id)` 找不到东西。
   * 有了它，`const v = Assert.found(map.get(k))` 之后
   * TypeScript 就知道 v 非空了——兼具断言与类型收窄。
   */
  static found<T>(value: T | null | undefined, msg = '未找到目标'): T {
    if (value === null || value === undefined) {
      throw new AssertionError(msg);
    }
    return value;
  }

  /**
   * 标记"这行不该到达"
   *
   * 【典型用法：穷尽性检查】
   * ```typescript
   * switch (state) {
   *   case 'idle': ... break;
   *   case 'run':  ... break;
   *   default: Assert.unreachable(state);   // 加了新状态忘了处理 → 编译期报错
   * }
   * ```
   */
  static unreachable(_never: never, msg = '到达了不应到达的分支'): never {
    throw new AssertionError(msg);
  }

  /** 软断言的告警出口（未设置时回退到 `console.warn`） */
  private static _softHandler: ((msg: string) => void) | null = null;

  /**
   * 把软断言的告警接到指定出口（传 `null` 恢复默认）
   *
   * 【为什么需要】
   * 原实现直接 `console.warn`，绕开了 Logger 的 sink 体系。
   * 而 README 承诺所有输出都能通过 sink 重定向到引擎控制台 / 文件 / 上报通道。
   * 结果是：接了上报的项目里，断言失败这类**优先级最高的信号**
   * 反而只落在控制台，线上一条都收不到。
   *
   * ```typescript
   * Assert.setSoftHandler((msg) => log.warn('assert', msg));
   * ```
   */
  static setSoftHandler(fn: ((msg: string) => void) | null): void {
    Assert._softHandler = fn;
  }

  /**
   * 生产环境安全版：失败时只告警不抛出
   *
   * 【什么时候用它】
   * 那些"错了也不值得崩"的检查，比如美术资源的尺寸不符合建议值。
   * 但**不要用它在生产环境掩盖逻辑错误**——
   * 那正是断言存在的意义。
   */
  static soft(cond: boolean, msg: string): boolean {
    if (!cond) {
      const line = `[软断言] ${msg}`;
      // 【为什么先判 handler 而不是无条件 console.warn】
      // 接了上报之后不应该再往控制台打一遍——
      // 软断言在热路径上一天能触发上万次，双写等于双倍开销。
      if (Assert._softHandler) Assert._softHandler(line);
      else console.warn(line);
    }
    return cond;
  }
}
