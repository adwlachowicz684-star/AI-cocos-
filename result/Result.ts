/**
 * Result —— 显式错误处理的返回类型
 *
 * 【它解决什么】
 *
 * 传统写法用异常，但异常有个问题：**从函数签名看不出来它会抛什么**。
 * ```typescript
 * function loadSave(path: string): SaveData { ... }   // 会抛吗？抛什么？
 * ```
 * 调用方不知道要 catch 什么，于是要么不处理（崩溃），
 * 要么 `catch (e) { }` 全吞掉（隐藏 bug）。
 *
 * Result 把失败变成返回值的一部分，编译器强制你处理：
 * ```typescript
 * function loadSave(path: string): Result<SaveData, string> { ... }
 *
 * const r = loadSave('slot1');
 * if (r.ok) use(r.value);
 * else showError(r.error);       // ← 不处理就取不到 value，编译器会拦
 * ```
 *
 * 【什么时候用 Result，什么时候用异常】
 * - **Result**：预期内的失败（文件不存在、网络超时、解析失败、玩家钱不够）
 * - **异常**：程序 bug（数组越界、null 解引用）——用 Assert 让它炸
 *
 * 判断标准：**调用方能不能合理地恢复？** 能 → Result；不能 → 异常。
 *
 * 【使用示例】
 * ```typescript
 * function parseLevel(json: string): Result<LevelData, string> {
 *   try {
 *     const obj = JSON.parse(json);
 *     if (!obj.rooms) return err('缺少 rooms 字段');
 *     return ok(obj as LevelData);
 *   } catch (e) {
 *     return err(`JSON 解析失败: ${e}`);
 *   }
 * }
 *
 * // 链式
 * const hp = parseLevel(text)
 *   .map(d => d.rooms.length)
 *   .unwrapOr(0);
 *
 * // 组合
 * const both = Result.all([parseLevel(a), parseLevel(b)]);
 * ```
 *
 * 【无引擎依赖】
 */

export type Result<T, E = string> = Ok<T, E> | Err<T, E>;

export class Ok<T, E> {
  readonly ok = true as const;
  constructor(readonly value: T) {}

  isOk(): this is Ok<T, E> {
    return true;
  }
  isErr(): false {
    return false;
  }
  map<U>(fn: (v: T) => U): Result<U, E> {
    return ok(fn(this.value));
  }
  mapErr<F>(_fn: (e: E) => F): Result<T, F> {
    return ok(this.value);
  }
  flatMap<U>(fn: (v: T) => Result<U, E>): Result<U, E> {
    return fn(this.value);
  }
  unwrapOr(_fallback: T): T {
    return this.value;
  }
  unwrap(): T {
    return this.value;
  }
  match<R>(onOk: (v: T) => R, _onErr: (e: E) => R): R {
    return onOk(this.value);
  }
}

export class Err<T, E> {
  readonly ok = false as const;
  constructor(readonly error: E) {}

  isOk(): false {
    return false;
  }
  isErr(): this is Err<T, E> {
    return true;
  }
  map<U>(_fn: (v: T) => U): Result<U, E> {
    return err(this.error);
  }
  mapErr<F>(fn: (e: E) => F): Result<T, F> {
    return err(fn(this.error));
  }
  flatMap<U>(_fn: (v: T) => Result<U, E>): Result<U, E> {
    return err(this.error);
  }
  unwrapOr(fallback: T): T {
    return fallback;
  }
  unwrap(): never {
    throw new Error(`[Result] 对 Err 调用 unwrap: ${JSON.stringify(this.error)}`);
  }
  match<R>(_onOk: (v: T) => R, onErr: (e: E) => R): R {
    return onErr(this.error);
  }
}

export function ok<T, E = string>(value: T): Result<T, E> {
  return new Ok<T, E>(value);
}

export function err<T = never, E = string>(error: E): Result<T, E> {
  return new Err<T, E>(error);
}

/**
 * 包装可能抛异常的函数
 *
 * ```typescript
 * const r = attempt(() => JSON.parse(text), (e) => `解析失败: ${e}`);
 * ```
 */
export function attempt<T, E = string>(fn: () => T, onError: (e: unknown) => E): Result<T, E> {
  try {
    return ok<T, E>(fn());
  } catch (e) {
    return err<T, E>(onError(e));
  }
}

/**
 * 组合多个 Result：全部成功才算成功
 *
 * 【用途】"加载所有配置表，任一失败就整体失败"
 */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const r of results) {
    if (r.isErr()) return err<T[], E>(r.error);
    values.push(r.value);
  }
  return ok<T[], E>(values);
}

/** 返回第一个成功的结果 */
export function any<T, E>(results: readonly Result<T, E>[]): Result<T, E[]> {
  const errors: E[] = [];
  for (const r of results) {
    if (r.isOk()) return ok<T, E[]>(r.value);
    errors.push(r.error);
  }
  return err<T, E[]>(errors);
}

/**
 * 从可空值构造
 *
 * ```typescript
 * const r = fromNullable(map.get(id), `${id} 不存在`);
 * ```
 */
export function fromNullable<T, E>(value: T | null | undefined, error: E): Result<T, E> {
  return value === null || value === undefined ? err<T, E>(error) : ok<T, E>(value);
}
