/**
 * _core/guard.ts —— 入口参数守卫（纯函数、零依赖、零状态）
 *
 * 【这个文件为什么存在】
 *
 * 全量精审 119 个单元后，53 条问题里有 **41 条可以归入 4 个模式**，
 * 而这 4 个模式的根因高度一致：**入口参数没守住非有限值**。
 *
 * | 模式 | 形态 | 后果 |
 * |---|---|---|
 * | 无界 count | `if (n <= 0) return` / `Math.max(1, n)` | **拦不住 Infinity，也被 NaN 静默穿透** → 死循环 / OOM |
 * | 角度归一化 | `while (x > 2π) x -= 2π` | `Infinity - 2π` 仍是 Infinity → **条件恒真，进程卡死** |
 * | Record 查表 | `table[key]` | 取到 `Object.prototype` 上的方法 → 返回非数字、污染下游 |
 * | 路径写入 | `setAtPath(obj, '__proto__.x', v)` | **进程级原型污染** |
 *
 * 让每个单元自己写守卫，会得到 N 套风格不同的报错文案和不一致的边界处理，
 * 合并不了。所以统一收口到这里。
 *
 * 【为什么是抛错而不是静默兜底】
 *
 * 这些守卫守的都是**调用方传错**的场景，不是"数据本来就该有个默认值"。
 * 静默兜底（如把 Infinity 当 1、把 NaN 当 0）会让错误继续传播，
 * 表现为"某个系统静默失效"——正是本库一直在消除的那类问题。
 *
 * 典型反例：`limit = NaN` 时 `length > NaN` 恒为 false，
 * 撤销栈永不裁剪、内存无限增长，而控制台没有任何输出。
 *
 * 【判据：什么该用这个、什么不该】
 *
 * - **外部输入**（配置表、存档、网络包、编辑器面板）→ 必须守
 * - **内部计算中间值** → 不该守，应该用 `numOr` / `clampNum` 收口
 *   （见 `math.ts`：兜底是"给个合理值继续跑"，守卫是"立即失败并说清为什么"）
 *
 * 【无引擎依赖】本文件不 import 任何模块，可脱离引擎单测。
 */

// ============================================================
// 数值守卫
// ============================================================

/**
 * 有限数值守卫
 *
 * 【拦什么】NaN、±Infinity，以及任何非 number
 *
 * 【为什么不拦 undefined】
 * `undefined` 通常意味着"这个参数没传、有默认值语义"，
 * 属于可选参数的正常形态，由调用方的 `?? 默认值` 处理更合适。
 * 强行拦会让大量带默认值的配置对象没法用。
 *
 * @param v 待校验值
 * @param field 字段名（**必须传**，报错要能直接定位到是谁）
 * @throws 非有限数值时抛错
 *
 * @example
 * ```typescript
 * this._radius = needFinite(opts.radius ?? 5, 'radius');
 * ```
 */
export function needFinite(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(
      `[guard] ${field} 必须是有限数值，实际 ${String(v)}（${typeof v}）`
    );
  }
  return v;
}

/**
 * 有限整数守卫
 *
 * @param v 待校验值
 * @param field 字段名
 * @throws 非有限整数时抛错
 */
export function needInt(v: unknown, field: string): number {
  const n = needFinite(v, field);
  if (!Number.isInteger(n)) {
    throw new RangeError(`[guard] ${field} 必须是整数，实际 ${n}`);
  }
  return n;
}

/**
 * 计数守卫（本库最高频的一类）
 *
 * 【为什么单独立一条，用 needInt 不够吗】
 *
 * `count` / `stacks` / `octaves` / `samples` / `quantity` 这类字段
 * 除了"必须是有限整数"，还要有**上界**——它会被直接用作循环次数。
 *
 * 缺上界时的故障是**进程级**的：
 *
 * ```
 * ShuffleBag.add('a', Infinity) → _refill 无限 push → 退出码 124（卡死）
 * BuffSystem.apply('x', Infinity) → independent 模式下无限 push
 * FOV raycast(radius = Infinity) → perimeter 双重循环永不结束
 * ```
 *
 * 实测这三处全部确认卡死。上界不能省。
 *
 * 【为什么默认上界是 1e6 而不是别的值】
 * 1e6 次循环在现代 JS 引擎上是毫秒级，任何合理的业务 count 都远低于它；
 * 而它又远低于会 OOM 的量级。是个"既能干活又不会炸"的守门值。
 * **业务上确有更大需求的，显式传 max 覆盖。**
 *
 * @param v 待校验值
 * @param field 字段名
 * @param max 上界（含），默认 1e6
 * @throws 非有限整数、为负、或超过上界时抛错
 *
 * @example
 * ```typescript
 * apply(id: string, stacks = 1): number {
 *   const n = needCount(stacks, 'stacks');
 *   ...
 * }
 * ```
 */
export function needCount(v: unknown, field: string, max = 1e6): number {
  const n = needInt(v, field);
  if (n < 0) {
    throw new RangeError(`[guard] ${field} 不能为负，实际 ${n}`);
  }
  if (n > max) {
    throw new RangeError(
      `[guard] ${field} 超过上限 ${max}，实际 ${n}。` +
        `这个值会被直接用作循环次数——Infinity 会让进程卡死。` +
        `若业务上确实需要更大值，请显式传入 max 参数覆盖。`
    );
  }
  return n;
}

/**
 * 正数守卫（严格大于 0 的有限数）
 *
 * 【典型用途】除数的分母、格子尺寸、缩放比例
 *
 * 【为什么不能用 needCount 代替】
 * 它管的是循环次数（整数、可为 0）；这里管的是除数（可为小数、不能为 0）。
 * 混用会把合法的 `0.5` 挡在外面。
 *
 * @param v 待校验值
 * @param field 字段名
 * @throws 非有限值或 ≤ 0 时抛错
 */
export function needPositive(v: unknown, field: string): number {
  const n = needFinite(v, field);
  if (n <= 0) {
    throw new RangeError(`[guard] ${field} 必须为正，实际 ${n}`);
  }
  return n;
}

// ============================================================
// 对象查表守卫（原型链污染 / 原型链误取）
// ============================================================

/**
 * 自有属性判定
 *
 * 【为什么需要它】
 *
 * `key in obj` 和 `obj[key]` 都会命中**原型链**。
 * 当 key 来自外部输入（配置表、存档、URL 参数）时，
 * 传进 `'toString'` / `'constructor'` / `'valueOf'` 会取到原型方法：
 *
 * ```
 * easing('toString')(0.5)        → "[object Undefined]"（字符串！）
 * stats.get('toString')          → "[object Object]"
 * difficulty.multiplier('toString') → 返回 NaN
 * ScopedStore.has('toString')    → true
 * ```
 *
 * 实测这四例全部成立。后果比抛异常糟得多：返回值不是数字，
 * 下游 `x + 结果` 立刻变 NaN，表现为"角色瞬移到 (NaN, NaN) 消失"且无报错。
 *
 * @param obj 被查表的对象
 * @param key 键
 * @returns 是否为**自有**属性
 */
export function hasOwn(obj: object, key: string | number | symbol): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 安全查表：只读自有属性，取不到返回 fallback
 *
 * 【⚠️ 这是"读取"的守卫，不是"写入"的】
 * 写入侧要用 `isSafeKey`（见下），两者不能混。
 *
 * 【性能】
 * `hasOwnProperty` + 索引是两次查找。热路径（每帧几千次）上
 * 建议在**构造期**就把配置 Record 复制进 `Map`，然后一直走 `Map.get`——
 * 那既没有原型链问题，也只剩一次查找。
 * 这个函数是给"改不动结构"的存量代码用的兜底。
 *
 * @param table 被查的表
 * @param key 键
 * @param fallback 未命中时的返回值
 *
 * @example
 * ```typescript
 * const fn = safeRead(EASING_TABLE, name, Easing.linear);
 * ```
 */
export function safeRead<V>(
  table: Record<string, V>,
  key: string,
  fallback: V
): V {
  return hasOwn(table, key) ? table[key] : fallback;
}

// ============================================================
// 路径写入守卫（原型污染）
// ============================================================

/**
 * 原型污染的危险键
 *
 * 【为什么是这三个】
 * - `__proto__`：直接改原型（最经典）
 * - `prototype`：`Foo.prototype.x = v` 污染所有实例
 * - `constructor`：`obj.constructor.prototype` 是 `__proto__` 的替代入口
 *
 * 只挡 `__proto__` 是不够的——`constructor` 那条路实测能绕过。
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/**
 * 路径段是否安全
 *
 * @param key 单个路径段（已经 split 过）
 *
 * @example
 * ```typescript
 * for (const part of path.split('.')) {
 *   if (!isSafeKey(part)) throw new Error(`[guard] 非法路径段：${part}`);
 * }
 * ```
 */
export function isSafeKey(key: string): boolean {
  return !UNSAFE_KEYS.has(key);
}

/**
 * 整条路径是否安全（不含危险段）
 *
 * 【调用时机】任何"按路径写入对象"的入口，**在 split 之后、写入之前**
 *
 * @param pathSegments 已分割的路径段
 * @throws 含危险段时抛错
 *
 * @example
 * ```typescript
 * const parts = p.path.split('.').filter((s) => s !== '');
 * assertSafePath(parts, p.path);
 * ```
 */
export function assertSafePath(pathSegments: readonly string[], raw?: string): void {
  for (const seg of pathSegments) {
    if (!isSafeKey(seg)) {
      throw new Error(
        `[guard] 路径包含非法段 "${seg}"` +
          (raw ? `（完整路径：${raw}）` : '') +
          `：写入它会污染 Object.prototype，影响整个进程。` +
          `若业务上确实需要这个键名，请改用 Map 承载数据。`
      );
    }
  }
}
