/**
 * tests/run_guard.ts —— _core/guard.ts 共享守卫的回归测试
 *
 * 【为什么单独立一个文件】
 * 这些守卫是**全库 41 条问题共用的基础设施**，会被十几个单元调用。
 * 它自己错了，所有调用方会一起错——所以必须有一份独立的、密集的测试。
 *
 * 【测试设计原则】
 * 每条用例都要能**在守卫缺失时失败**。
 * 比如 `needCount(Infinity)` 若守卫被删掉就会返回 Infinity 而不是抛错，
 * 那这条用例就会红——这才是有效用例。
 */

import { describe, test, assert, eq, throws } from './_framework';

import {
  needFinite,
  needInt,
  needCount,
  needPositive,
  hasOwn,
  safeRead,
  isSafeKey,
  assertSafePath,
} from '../_core/guard';
import { maxOf, minOf } from '../_core/math';
import { Pool } from '../pool/Pool';

export function runGuardTests(): void {
  // ============================================================
  // needFinite
  // ============================================================

  describe('needFinite · 有限数值守卫', () => {
    test('合法数值原样返回', () => {
      eq(needFinite(0, 'x'), 0, '0 应通过');
      eq(needFinite(-1.5, 'x'), -1.5, '负数应通过');
      eq(needFinite(1e300, 'x'), 1e300, '大数应通过');
    });

    test('⚠️ NaN 必须抛错（Math.max 会让 NaN 静默穿透）', () => {
      throws(() => needFinite(NaN, 'radius'), '必须是有限数值');
    });

    test('⚠️ Infinity 必须抛错（循环次数为 Infinity 会卡死进程）', () => {
      throws(() => needFinite(Infinity, 'count'), '必须是有限数值');
      throws(() => needFinite(-Infinity, 'count'), '必须是有限数值');
    });

    test('⚠️ 非 number 类型必须抛错', () => {
      throws(() => needFinite('5', 'x'), '必须是有限数值');
      throws(() => needFinite(null, 'x'), '必须是有限数值');
      throws(() => needFinite(undefined, 'x'), '必须是有限数值');
      throws(() => needFinite({}, 'x'), '必须是有限数值');
    });

    test('报错信息带字段名（否则无法定位是哪个配置错了）', () => {
      let msg = '';
      try {
        needFinite(NaN, 'smoothTime');
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      assert(msg.includes('smoothTime'), `报错应含字段名，实际：${msg}`);
    });
  });

  // ============================================================
  // needInt
  // ============================================================

  describe('needInt · 整数守卫', () => {
    test('合法整数原样返回', () => {
      eq(needInt(0, 'n'), 0);
      eq(needInt(-3, 'n'), -3);
    });

    test('⚠️ 小数必须抛错', () => {
      throws(() => needInt(1.5, 'n'), '必须是整数');
    });

    test('非有限值仍然被拦（继承 needFinite）', () => {
      throws(() => needInt(Infinity, 'n'));
      throws(() => needInt(NaN, 'n'));
    });
  });

  // ============================================================
  // needCount —— 本库最高频的一类
  // ============================================================

  describe('needCount · 计数守卫（无界 count 模式）', () => {
    test('合法计数原样返回', () => {
      eq(needCount(0, 'count'), 0, '0 次是合法的（不做任何事）');
      eq(needCount(10, 'count'), 10);
    });

    test('⚠️ Infinity 必须抛错（这是全库卡死类 bug 的头号成因）', () => {
      /**
       * 【为什么这条最重要】
       * 实测确认卡死的三处，根因都是 count/radius 为 Infinity 时
       * 进入了无界循环：
       *   ShuffleBag.add('a', Infinity)  → _refill 无限 push → 退出码 124
       *   BuffSystem.apply('x', Infinity) → independent 模式无限 push
       *   Raycasting.compute(r=Infinity)  → perimeter 双重循环永不结束
       */
      throws(() => needCount(Infinity, 'stacks'), '必须是有限数值');
    });

    test('⚠️ NaN 必须抛错（不会卡死但会静默什么都不做）', () => {
      throws(() => needCount(NaN, 'stacks'));
    });

    test('⚠️ 负数必须抛错', () => {
      throws(() => needCount(-1, 'quantity'), '不能为负');
    });

    test('⚠️ 超上界必须抛错（上界可自定义）', () => {
      throws(() => needCount(2e6, 'count'), '超过上限');
      eq(needCount(2e6, 'count', 5e6), 2e6, '显式放宽上界后应通过');
    });

    test('默认上界 1e6 不会误伤合理业务值', () => {
      eq(needCount(999999, 'count'), 999999, '接近上界的合法值应通过');
      eq(needCount(1e6, 'count'), 1e6, '上界含端点');
    });
  });

  // ============================================================
  // needPositive
  // ============================================================

  describe('needPositive · 正数守卫（除数 / 尺寸）', () => {
    test('⚠️ 0 必须抛错（除数为 0 → Infinity/NaN 不可恢复）', () => {
      throws(() => needPositive(0, 'cellSize'));
    });

    test('⚠️ 负数必须抛错', () => {
      throws(() => needPositive(-1, 'cellSize'));
    });

    test('小数应通过（不能用 needCount 代替它）', () => {
      eq(needPositive(0.5, 'scale'), 0.5, '0.5 是合法的除数');
    });

    test('非有限值仍然被拦', () => {
      throws(() => needPositive(Infinity, 'x'));
      throws(() => needPositive(NaN, 'x'));
    });
  });

  // ============================================================
  // hasOwn / safeRead —— 原型链误取
  // ============================================================

  describe('hasOwn · 自有属性判定', () => {
    test('⚠️ 原型方法不算自有属性', () => {
      /**
       * 【为什么这条重要】
       * 实测四例原型链误取，全部因为漏了这一层：
       *   easing('toString')(0.5)           → "[object Undefined]"（字符串！）
       *   stats.get('toString')             → "[object Object]"
       *   difficulty.multiplier('toString') → NaN
       *   ScopedStore.has('toString')       → true
       */
      eq(hasOwn({}, 'toString'), false, 'toString 在原型上');
      eq(hasOwn({}, 'constructor'), false, 'constructor 在原型上');
      eq(hasOwn({}, 'valueOf'), false, 'valueOf 在原型上');
    });

    test('自有属性正常识别', () => {
      eq(hasOwn({ a: 1 }, 'a'), true);
      eq(hasOwn({ toString: 1 }, 'toString'), true, '显式定义后就是自有的');
    });

    test('⚠️ 值为 undefined 的自有属性也算自有（区别于 in 的常见误解）', () => {
      assert(hasOwn({ a: undefined }, 'a'), 'hasOwn 看的是"有没有这个键"');
    });
  });

  describe('safeRead · 安全查表', () => {
    const TABLE: Record<string, number> = { a: 1, b: 2 };

    test('命中时返回原值', () => {
      eq(safeRead(TABLE, 'a', 99), 1);
      eq(safeRead(TABLE, 'b', 99), 2);
    });

    test('⚠️ 原型键返回 fallback 而不是原型方法', () => {
      const r = safeRead(TABLE as Record<string, any>, 'toString', 'FALLBACK');
      eq(r, 'FALLBACK', '应回退而不是返回函数');
      const r2 = safeRead(TABLE as Record<string, any>, 'constructor', 'FALLBACK');
      eq(r2, 'FALLBACK', 'constructor 同样要挡');
    });

    test('未知名返回 fallback', () => {
      eq(safeRead(TABLE, 'zzz', 99), 99);
    });
  });

  // ============================================================
  // isSafeKey / assertSafePath —— 原型污染
  // ============================================================

  describe('isSafeKey · 危险键识别', () => {
    test('⚠️ 三个危险键全部拦下', () => {
      /**
       * 【为什么是三个】
       * 只挡 __proto__ 不够——constructor 是另一条入口：
       * obj.constructor.prototype 同样能改原型。
       */
      eq(isSafeKey('__proto__'), false);
      eq(isSafeKey('prototype'), false);
      eq(isSafeKey('constructor'), false);
    });

    test('普通键不受影响', () => {
      eq(isSafeKey('name'), true);
      eq(isSafeKey('a.b'), true, '点号本身不危险（危险的是段名）');
      eq(isSafeKey('0'), true);
    });
  });

  describe('assertSafePath · 路径写入守卫', () => {
    test('⚠️ 含 __proto__ 的路径必须抛错', () => {
      /**
       * 【实测后果】
       * applyPatch({}, { op:'set', path:'__proto__.skillPolluted', value:true })
       * → ({}).skillPolluted === true，整个进程的所有对象都被污染。
       * snapshot 的 applyPatch 同样成立。
       */
      throws(() => assertSafePath(['__proto__', 'x'], '__proto__.x'));
    });

    test('⚠️ 危险段出现在中间也要拦（不只是开头）', () => {
      throws(() => assertSafePath(['a', 'constructor', 'b'], 'a.constructor.b'));
    });

    test('安全路径正常通过', () => {
      assertSafePath(['a', 'b', '0'], 'a.b.0');
      assertSafePath([], '');
    });

    test('报错信息说明后果（不只是"不允许"）', () => {
      let msg = '';
      try {
        assertSafePath(['__proto__'], '__proto__');
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      assert(msg.includes('污染'), `报错应说明会污染原型，实际：${msg}`);
    });
  });

  // ============================================================
  // maxOf / minOf —— 合法极值不再被误判为空集
  // ============================================================

  describe('maxOf / minOf · 空集哨兵修正', () => {
    test('⚠️ 合法 -Infinity 不再被当成空集', () => {
      /**
       * 【原缺陷】
       * 老实现用 `m === -Infinity` 当空集哨兵，
       * 于是 maxOf([-Infinity], 7) 返回 7 而不是 -Infinity。
       * 用 ±Infinity 表达"无界"的场景（温度下限、损失上界）会静默算错。
       */
      eq(maxOf([-Infinity], 7), -Infinity, '应返回 -Infinity 而非 fallback');
      eq(minOf([Infinity], 7), Infinity, '应返回 Infinity 而非 fallback');
    });

    test('真正的空集仍返回 fallback', () => {
      eq(maxOf([], 7), 7);
      eq(minOf([], 7), 7);
    });

    test('混合极值与普通值', () => {
      eq(maxOf([-Infinity, 3, 5], 7), 5);
      eq(minOf([Infinity, 3, 5], 7), 3);
      eq(maxOf([-Infinity, -Infinity], 7), -Infinity);
    });

    test('NaN 仍保持传染（这条语义没变）', () => {
      assert(Number.isNaN(maxOf([1, NaN, 3], 7)), 'NaN 应传染');
      assert(Number.isNaN(minOf([1, NaN, 3], 7)), 'NaN 应传染');
    });
  });

  // ============================================================
  // Pool.prewarm —— 上界守卫
  // ============================================================

  describe('Pool.prewarm · 上界守卫', () => {
    test('⚠️ Infinity 不再无限创建（原会 OOM）', () => {
      const pool = new Pool<object>(() => ({}));
      let threw = false;
      try {
        pool.prewarm(Infinity);
      } catch {
        threw = true;
      }
      assert(threw, 'prewarm(Infinity) 应抛错而不是无限创建');
      assert(pool.idle < 1e6, `不应创建海量对象，实际 idle=${pool.idle}`);
    });

    test('⚠️ NaN 不再静默通过', () => {
      const pool = new Pool<object>(() => ({}));
      throws(() => pool.prewarm(NaN), '必须是有限数值');
    });

    test('⚠️ 负数不再静默通过', () => {
      const pool = new Pool<object>(() => ({}));
      throws(() => pool.prewarm(-5), '不能为负');
    });

    test('正常预热不受影响（防止矫枉过正）', () => {
      const pool = new Pool<object>(() => ({}), undefined, undefined, { maxSize: 100 });
      pool.prewarm(10);
      eq(pool.idle, 10, '预热 10 个');
      eq(pool.created, 10, '创建计数一致');
    });

    test('⚠️ 预热数不受 maxSize 截断（两者是独立契约）', () => {
      /**
       * 【为什么不受 maxSize 约束】
       * maxSize 管的是"归还时"的回收上限，prewarm 管的是预分配。
       * 既有测试断言 prewarm(20) 配 maxSize:3 应得 idle === 20
       * ——"预热就是要预分配，不该被 maxSize 截断"。
       *
       * 我第一版守卫错误地把两者耦合了，已回退。
       * 这条用例就是防止再改回去。
       */
      const pool = new Pool<object>(() => ({}), undefined, undefined, { maxSize: 5 });
      pool.prewarm(100);
      eq(pool.idle, 100, '预热是预分配，不该被 maxSize 截断');
    });
  });
}
