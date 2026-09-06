/**
 * tests/_framework.ts —— 零依赖迷你测试框架
 *
 * 【为什么不用 jest】
 * jest 需要装依赖、配环境。这里用一个约 40 行的框架，
 * 你装个 TypeScript 就能立刻验证库是对的。
 *
 * 【迁移到 jest】
 * 每个 `test(...)` 可以直接改成 jest 的 `it(...)`，
 * `assert` / `eq` / `near` 换成 `expect(...).toBe(...)` / `.toBeCloseTo(...)`，
 * **测试逻辑一行都不用改**。
 */

declare const process: { exit(code: number): void } | undefined;

export let passed = 0;
export let failed = 0;
export const failures: string[] = [];

let currentGroup = '';
let currentSuite = '';

/** 当前测试文件名（用于失败信息分组） */
export function setSuite(name: string): void {
  currentSuite = name;
  console.log(`\n${'='.repeat(50)}\n${name}\n${'='.repeat(50)}`);
}

export function describe(name: string, fn: () => void): void {
  currentGroup = name;
  console.log(`\n▸ ${name}`);
  fn();
}

/** 异步版 describe：内部可 await testAsync */
export async function describeAsync(name: string, fn: () => Promise<void>): Promise<void> {
  currentGroup = name;
  console.log(`\n▸ ${name}`);
  await fn();
}

export function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${currentSuite} › ${currentGroup} › ${name}: ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

/** 异步测试：await 一个 Promise，内部错误也能被捕获 */
export function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  return fn().then(
    () => {
      passed++;
      console.log(`  ✓ ${name}`);
    },
    (e: unknown) => {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${currentSuite} › ${currentGroup} › ${name}: ${msg}`);
      console.log(`  ✗ ${name}\n      ${msg}`);
    }
  );
}

/**
 * 断言
 *
 * 【为什么签名是 `asserts cond` 而不是 `void`】
 *
 * 加上 `asserts cond` 之后，TypeScript 会在调用点做**类型收窄**：
 *
 * ```typescript
 * const r = s.join('x', 0);          // r 是联合类型
 * assert(r.ok);
 * r.effectiveVisibility;             // ← 收窄后可以直接取字段
 * ```
 *
 * 不加的话，处理"成功返回数据 / 失败返回错误码"的联合类型时，
 * 每个测试都要写 `if (!r.ok) throw new Error(...)`，
 * 而这个模式在库里会反复出现（Result 类型、JoinError…）。
 */
export function assert(cond: boolean, msg = '断言失败'): asserts cond {
  if (!cond) throw new Error(msg);
}

export function eq(actual: unknown, expected: unknown, msg = ''): void {
  if (actual !== expected) {
    throw new Error(`${msg} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

export function near(actual: number, expected: number, tol = 1e-6, msg = ''): void {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${msg} 期望 ≈${expected}，实际 ${actual}`);
  }
}

/** 期望抛出 */
export function throws(fn: () => void, contains?: string, msg = ''): void {
  let threw = false;
  let errorMsg = '';
  try {
    fn();
  } catch (e) {
    threw = true;
    errorMsg = e instanceof Error ? e.message : String(e);
  }
  if (!threw) throw new Error(`${msg} 期望抛出异常，但没有`);
  if (contains && !errorMsg.includes(contains)) {
    throw new Error(`${msg} 异常信息应包含 "${contains}"，实际 "${errorMsg}"`);
  }
}

/** 汇总并退出（非零退出码让 CI 能捕获失败） */
export function summary(): void {
  console.log('\n' + '='.repeat(50));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.log('\n失败详情：');
    failures.forEach((f) => console.log('  ✗ ' + f));
    if (typeof process !== 'undefined' && process !== undefined) process.exit(1);
  } else {
    console.log('全部通过 ✓');
  }
}

/** 重置计数（便于多次运行合并） */
export function reset(): void {
  passed = 0;
  failed = 0;
  failures.length = 0;
}
