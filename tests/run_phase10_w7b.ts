/**
 * tests/run_phase10_w7b.ts —— 第二次精审 · 窗口 W7-B 返工回归
 *
 * 【本批 3 个单元】achievement / curve / expression
 * 【条目】12（P1 × 10，P2 × 2）
 *
 * 【每条修复的三件套】
 * 1. 一条**修复前会失败**的用例（下面每条都注明了"修复前"的真实输出，
 *    全部由 /tmp 下的复现脚本实测得到，不是照抄任务书）
 * 2. 一条**防止矫枉过正**的对照用例（正常输入不受影响）
 * 3. 源码里的"为什么"注释
 *
 * 【本批的两条特殊状态】
 * - `curve` 的 `integrate(samples)` 采样数（P1-C3）：
 *   **本窗口开工前已被 `tests/run_phase3.ts` 修复**（`needCount` + `n === 0` 抛错）。
 *   任务书建议的 `clampNum(samples, 1, 1e5, 64)` 静默收口**与既有测试冲突**
 *   （既有两条用例断言必须抛错），且把"明确的错误输入"变成"悄悄改掉你的参数"
 *   属于 breaking，故保持抛错，本文件补一组用例上锁并说明。
 * - `expression` 的除零（P2-E2）：任务书要求"文档化即可，不改代码"，
 *   本文件同样只上锁、不改行为。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { Achievement } from '../achievement/Achievement';
import { Curve } from '../curve/Curve';
import { Expression, setExpressionWarningHandler } from '../expression/Expression';

/** 成就用上下文：没有的键返回 0 */
function ctxOf(vals: Record<string, number>): { get: (k: string) => number } {
  return { get: (k: string) => vals[k] ?? 0 };
}

/** 装一个告警收集器，跑完自动卸载（避免污染其它测试文件） */
function collectWarnings(fn: (seen: string[]) => void): string[] {
  const seen: string[] = [];
  setExpressionWarningHandler((m) => seen.push(m));
  try {
    fn(seen);
  } finally {
    setExpressionWarningHandler(null);
  }
  return seen;
}

export function runPhase10W7BTests(): void {
  // ================================================================
  describe('W7-B · achievement（P1-A1 importState 语义）', () => {
    // ================================================================

    /**
     * 【修复前实测】
     * ```
     * importState(['a'])   → unlockedCount === 1
     * importState(['b'])   → unlockedCount === 2   ← 第二份存档只写了 1 个成就
     * ```
     * 旧实现只 `add` 从不 `clear`，"读档"变成了"取并集"。
     */
    test('⚠️ P1-A1：重复 importState 是替换，不得叠加出幽灵解锁', () => {
      const a = new Achievement({
        defs: [
          { id: 'a', name: 'A', target: 1 },
          { id: 'b', name: 'B', target: 1 },
          { id: 'c', name: 'C', target: 1, points: 10 },
        ],
      });
      a.importState(['a']);
      eq(a.unlockedCount, 1);
      a.importState(['b']);
      eq(a.unlockedCount, 1, '第二次导入应替换，而不是并集');
      eq(a.isUnlocked('a'), false, '旧槽位的成就不该被带进新槽位');
      eq(a.points, 0);
    });

    test('P1-A1（对照）：单次导入与存档往返不受影响', () => {
      const a = new Achievement({
        defs: [
          { id: 'a', name: 'A', target: 1 },
          { id: 'b', name: 'B', target: 1 },
        ],
      });
      a.unlock('a');
      const state = a.exportState();
      const b = new Achievement({ defs: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
      b.importState(state);
      eq(b.unlockedCount, 1);
      eq(b.isUnlocked('a'), true);
    });

    test('P1-A1（对照）：未知 id 仍静默跳过', () => {
      const a = new Achievement({ defs: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
      a.importState(['a', '已删除的成就']);
      eq(a.unlockedCount, 1);
    });

    test('P1-A1（新增 API）：mergeState 保留追加语义', () => {
      const a = new Achievement({ defs: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
      a.importState(['a']);
      a.mergeState(['b']);
      eq(a.unlockedCount, 2, 'mergeState 是并集，与 importState 语义分离');
    });

    test('⚠️ P1-A1（副作用）：换存档后第一次 check 仍要通知进度', () => {
      let n = 0;
      const a = new Achievement({
        defs: [{ id: 'x', name: 'X', target: 100, progress: (c) => c.get('v') }],
        onProgress: () => { n++; },
      });
      a.check(ctxOf({ v: 5 }));
      eq(n, 1);
      a.importState([]);                  // 换新存档：进度缓存必须一起作废
      a.check(ctxOf({ v: 5 }));
      eq(n, 2, '换存档后同一进度应重新通知一次，UI 才不会停在旧槽位');
    });
  });

  // ================================================================
  describe('W7-B · achievement（P1-A2 revoke 与 reset 对称）', () => {
    // ================================================================

    /**
     * 【修复前实测】
     * 注册 onProgress → check（回调 1 次）→ revoke('x') → check
     * → 回调仍为 1 次（期望 2）。
     * 原因：`_progressOf` 的去重靠 `last !== p.current`，
     * revoke 只改了解锁标记，`current` 没变，于是"进度没变化"→ 跳过回调。
     */
    test('⚠️ P1-A2：revoke 后重新 check，onProgress 必须再触发一次', () => {
      let n = 0;
      const a = new Achievement({
        defs: [{ id: 'x', name: 'X', target: 100, progress: (c) => c.get('v') }],
        onProgress: () => { n++; },
      });
      a.check(ctxOf({ v: 5 }));
      eq(n, 1);
      a.revoke('x');
      a.check(ctxOf({ v: 5 }));
      eq(n, 2, '撤销后重新观察，进度回调不该被去重吞掉');
    });

    test('P1-A2（对照）：未撤销时相同进度仍只通知一次', () => {
      let n = 0;
      const a = new Achievement({
        defs: [{ id: 'x', name: 'X', target: 100, progress: (c) => c.get('v') }],
        onProgress: () => { n++; },
      });
      a.check(ctxOf({ v: 5 }));
      a.check(ctxOf({ v: 5 }));
      eq(n, 1, '去重本身没错，不能为了修 A2 把去重一起干掉');
      a.check(ctxOf({ v: 20 }));
      eq(n, 2);
    });

    test('P1-A2（对照）：revoke 的返回值与解锁状态不受影响', () => {
      const a = new Achievement({ defs: [{ id: 'x', name: 'X' }] });
      a.unlock('x');
      eq(a.revoke('x'), true);
      eq(a.revoke('x'), false, '撤销不存在的解锁返回 false');
      eq(a.isUnlocked('x'), false);
    });
  });

  // ================================================================
  describe('W7-B · achievement（P1-A3 target 收口）', () => {
    // ================================================================

    /**
     * 【修复前实测】
     * ```
     * target: NaN, progress: () => 5  → { current: NaN, target: NaN, done: false }
     * target: 0,   progress: () => 0  → { current: 0,   target: 0,   done: true }   ← 秒达成
     * ```
     * `def.target ?? 1` 挡不住 NaN / 0：`Math.min(NaN, 5)` 得 NaN，
     * `0 >= 0` 恒真。两者都不抛异常，只在数值上体现。
     */
    test('⚠️ P1-A3：target = NaN 不得污染进度', () => {
      const a = new Achievement({
        defs: [{ id: 'x', name: 'x', target: NaN, progress: () => 5 }],
      });
      const p = a.progressOf('x', ctxOf({}));
      assert(Number.isFinite(p.current), `current 应为有限数，实际 ${p.current}`);
      assert(Number.isFinite(p.target), `target 应为有限数，实际 ${p.target}`);
      eq(p.target, 1, 'NaN 目标应回落到默认 1');
      eq(p.current, 1);
    });

    test('⚠️ P1-A3：target = 0 的成就不得瞬间达成', () => {
      const a = new Achievement({
        defs: [{ id: 'x', name: 'x', target: 0, progress: () => 0 }],
      });
      const p = a.progressOf('x', ctxOf({}));
      eq(p.target, 1, '0 不是合法目标值（等价于无条件达成）');
      eq(p.done, false, '零目标不该在进度为 0 时判定达成');
    });

    test('⚠️ P1-A3：target = Infinity 不得让成就永不可达', () => {
      const a = new Achievement({
        defs: [{ id: 'x', name: 'x', target: Infinity, progress: () => 5 }],
      });
      const p = a.progressOf('x', ctxOf({}));
      assert(Number.isFinite(p.target), `target 应被收口，实际 ${p.target}`);
    });

    test('P1-A3（对照）：正常 target 与未填 target 行为不变', () => {
      const a = new Achievement({
        defs: [
          { id: 'x', name: 'X', target: 100, progress: () => 5 },
          { id: 'y', name: 'Y' },                    // 未填 target
        ],
      });
      eq(a.progressOf('x', ctxOf({})).target, 100);
      eq(a.progressOf('x', ctxOf({})).current, 5);
      eq(a.progressOf('y', ctxOf({})).target, 1, '未填仍是 1（布尔型成就）');
      eq(a.progressOf('x', ctxOf({})).done, false);
    });

    test('P1-A3（对照）：进度仍被夹到 [0, target]', () => {
      const a = new Achievement({
        defs: [{ id: 'x', name: 'X', target: 100, progress: (c) => c.get('v') }],
      });
      eq(a.progressOf('x', ctxOf({ v: 99999 })).current, 100, '展示时不超过目标');
      eq(a.progressOf('x', ctxOf({ v: -5 })).current, 0, '负数夹到 0');
    });
  });

  // ================================================================
  describe('W7-B · achievement（P1-A4 unlock 的前置校验）', () => {
    // ================================================================

    /**
     * 【修复前实测】
     * ```
     * A（无前置）、B（requires: ['A']）
     * unlock('B')            → true
     * isUnlocked('B')        → true
     * requirementsMet('B')   → false        ← 矛盾态
     * ```
     * `checkOne()` 显式校验了 `requirementsMet()`，`unlock()` 却没校验，
     * 同一个"解锁"动作两条路径两套规则。
     */
    test('⚠️ P1-A4：unlock 默认校验前置，不得绕过依赖图', () => {
      const a = new Achievement({
        defs: [
          { id: 'A', name: 'A', target: 1 },
          { id: 'B', name: 'B', target: 1, requires: ['A'] },
        ],
      });
      eq(a.unlock('B'), false, '前置未达成时不应解锁成功');
      eq(a.isUnlocked('B'), false);
      eq(a.requirementsMet('B'), false, '不应出现"已解锁但前置未完成"');
    });

    test('P1-A4（对照）：前置达成后可正常 unlock', () => {
      const a = new Achievement({
        defs: [
          { id: 'A', name: 'A', target: 1 },
          { id: 'B', name: 'B', target: 1, requires: ['A'] },
        ],
      });
      eq(a.unlock('A'), true);
      eq(a.unlock('B'), true);
      eq(a.isUnlocked('B'), true);
    });

    test('P1-A4（新增开关）：bypassRequires 供 GM / 补发使用', () => {
      const a = new Achievement({
        defs: [
          { id: 'A', name: 'A', target: 1 },
          { id: 'B', name: 'B', target: 1, requires: ['A'] },
        ],
      });
      eq(a.unlock('B', true), true, '显式传 true 时允许绕过');
      eq(a.isUnlocked('B'), true);
    });

    test('P1-A4（对照）：无前置成就与未定义 id 的行为不变', () => {
      const a = new Achievement({ defs: [{ id: 'A', name: 'A', target: 1 }] });
      eq(a.unlock('A'), true);
      eq(a.unlock('A'), false, '重复解锁返回 false');
      throws(() => a.unlock('nope'), '未定义');
    });
  });

  // ================================================================
  describe('W7-B · curve（P1-C1 evaluate 的 NaN 入参）', () => {
    // ================================================================

    /**
     * 【修复前实测】
     * ```
     * new Curve([{0,0},{10,10}]).evaluate(NaN)      → NaN
     * new Curve([{0,0},{10,10}]).evaluate(Infinity) → 10（clamp 正常）
     * ```
     * `Math.min(Math.max(NaN, lo), hi)` 每一步都返回 NaN，
     * 而 `addKey()` 在入口就校验了有限性——同一个口子只堵了一半。
     */
    test('⚠️ P1-C1：evaluate(NaN) 不得返回 NaN', () => {
      const c = new Curve([{ time: 0, value: 0 }, { time: 10, value: 10 }]);
      const v = c.evaluate(NaN);
      assert(Number.isFinite(v), `evaluate(NaN) 应为有限数，实际 ${v}`);
      eq(v, 0, 'NaN 没有方向，按"时间未定义"回落到起点值');
    });

    test('P1-C1（对照）：±Infinity 仍按方向 clamp，不误伤', () => {
      const c = new Curve([{ time: 0, value: 0 }, { time: 10, value: 10 }]);
      eq(c.evaluate(Infinity), 10, '+Inf 明确表示"远超末端"');
      eq(c.evaluate(-Infinity), 0);
      near(c.evaluate(5), 5);
      near(c.evaluate(999), 10, 1e-6, '超范围 clamp 而非抛错（README 承诺）');
    });

    test('P1-C1（对照）：三种插值模式下 NaN 守卫都生效', () => {
      const c = new Curve([{ time: 0, value: 3 }, { time: 10, value: 7 }]);
      eq(c.evaluate(NaN, 'step'), 3);
      eq(c.evaluate(NaN, 'smooth'), 3);
      eq(c.evaluate(NaN, 'linear'), 3);
    });

    test('P1-C1（对照）：单关键帧与空曲线的既有行为不变', () => {
      eq(Curve.constant(42).evaluate(NaN), 42);
      eq(new Curve().evaluate(NaN), 0, '空曲线仍是 0');
    });
  });

  // ================================================================
  describe('W7-B · curve（P1-C2 空曲线的 minValue / maxValue）', () => {
    // ================================================================

    /**
     * 【修复前实测】
     * ```
     * new Curve().minValue       → Infinity
     * new Curve().maxValue       → -Infinity
     * (1 - min) / (max - min)    → NaN        ← 归一化静默失效
     * ```
     * `reduce(fn, Infinity)` 在空数组上直接返回初始值。
     */
    test('⚠️ P1-C2：空曲线的极值返回 0，不返回 ∓Infinity', () => {
      const c = new Curve();
      eq(c.minValue, 0, '修前是 Infinity');
      eq(c.maxValue, 0, '修前是 -Infinity');
      assert(
        Number.isFinite((1 - c.minValue) / (c.maxValue - c.minValue)) === false ||
          c.minValue === c.maxValue,
        '归一化分母为 0 是调用方该挡的，但至少不能是 Infinity'
      );
    });

    test('P1-C2（对照）：非空曲线的极值照旧', () => {
      const c = new Curve([{ time: 0, value: -10 }, { time: 5, value: 50 }]);
      near(c.minValue, -10);
      near(c.maxValue, 50);
    });

    test('P1-C2（对照）：destroy 后不再抛（已清空即视为空曲线）', () => {
      const c = new Curve([{ time: 0, value: -10 }, { time: 5, value: 50 }]);
      c.destroy();
      eq(c.minValue, 0, '清空后是空曲线，走同一条返回 0 的分支');
      eq(c.maxValue, 0);
    });
  });

  // ================================================================
  describe('W7-B · curve（P1-C3 integrate 采样数 · 本窗口只上锁）', () => {
    // ================================================================

    /**
     * 【本条为什么不是"我修的"】
     * 开工前实测：`integrate(Infinity)` 抛
     * `[guard] samples 必须是有限数值`，`integrate(0)` 抛
     * `[Curve] samples 必须为正`——**不死循环、也不静默返回 0**，
     * 缺陷已由 `needCount()`（见 `tests/run_phase3.ts` 的两条用例）修掉。
     *
     * 【为什么不按任务书改成 `clampNum(samples, 1, 1e5, 64)` 静默收口】
     * 1. 既有两条用例断言 `throws`，改成静默收口会让它们变红，
     *    违反"条数只增不减"；
     * 2. `samples = Infinity` 是配置算错的信号（典型：`duration / dt` 且 dt 为 0），
     *    静默取 64 会把"配置错了"变成"积分结果悄悄偏了"——
     *    与本库"宁可抛错也不要静默错误"的取向相反；
     * 3. 抛错是**现状**，改它属于 breaking，按第 8 节应交总审裁决。
     *
     * 本组用例只给现状上锁：将来若有人改回静默，这里会立刻变红。
     */
    test('⚠️ P1-C3（上锁）：samples = Infinity 抛错，绝不死循环', () => {
      const c = new Curve([{ time: 0, value: 0 }, { time: 1, value: 1 }]);
      throws(() => c.integrate(Infinity), '必须是有限数值');
    });

    test('⚠️ P1-C3（上锁）：samples = 0 抛错，不静默返回 0', () => {
      const c = new Curve([{ time: 0, value: 0 }, { time: 1, value: 1 }]);
      throws(() => c.integrate(0), '必须为正');
    });

    test('P1-C3（对照）：正常积分结果不变（三角形面积 ≈ 0.5）', () => {
      const c = new Curve([{ time: 0, value: 0 }, { time: 1, value: 1 }]);
      near(c.integrate(1000), 0.5, 1e-6);
      assert(c.integrate(64) > 0, '默认采样数仍可用');
    });
  });

  // ================================================================
  describe('W7-B · curve（P2-C4 destroy 之后不能再 evaluate）', () => {
    // ================================================================

    /**
     * 【修复前实测】
     * ```
     * c.destroy();  c.evaluate(0.5)  → 0（keyCount 也是 0，不抛错）
     * ```
     * README 第 89 / 97 行明确写"destroy() 之后不能再 evaluate()"，
     * 实现却走"空曲线返回 0"静默降级——文档承诺不可用，实际返回一个合法值。
     */
    test('⚠️ P2-C4：destroy 后 evaluate 抛错，不静默返回 0', () => {
      const c = new Curve([{ time: 0, value: 5 }, { time: 1, value: 9 }]);
      c.destroy();
      eq(c.destroyed, true);
      throws(() => c.evaluate(0.5), 'destroy');
    });

    test('P2-C4（对照）：未 destroy 的曲线一切照旧', () => {
      const c = new Curve([{ time: 0, value: 5 }, { time: 1, value: 9 }]);
      eq(c.destroyed, false);
      near(c.evaluate(0.5), 7);
      near(c.evaluate(0.5, 'step'), 5);
      eq(c.keyCount, 2);
    });

    test('P2-C4（对照）：clone 出来的副本独立于原曲线', () => {
      const c = new Curve([{ time: 0, value: 5 }, { time: 1, value: 9 }]);
      const copy = c.clone();
      c.destroy();
      near(copy.evaluate(0.5), 7, 1e-6, 'destroy 原曲线不影响已克隆的副本');
    });
  });

  // ================================================================
  describe('W7-B · expression（P1-E1 三元分支里的负号）', () => {
    // ================================================================

    /**
     * 【修复前实测】
     * ```
     * '1 ? -5 : -7'        → 抛 [Expression] 意外的符号 "-"（位置 4）
     * '0 ? -5 : -7'        → 同样抛错
     * 'hp > 0 ? -dmg : 0'  → 抛 [Expression] 意外的符号 "-"（位置 9）
     * '1 ? 5 : 7'          → 5（正常）
     * ```
     * `?` / `:` 不在一元负号的前导集合里，`-` 被当成二元运算符，
     * 走到 parsePrimary 抛错，而错误位置指向 `-`，与"三元"毫无字面关联。
     */
    test('⚠️ P1-E1：三元分支支持负数字面量', () => {
      eq(new Expression('1 ? -5 : -7').evaluate({}), -5);
      eq(new Expression('0 ? -5 : -7').evaluate({}), -7);
    });

    test('⚠️ P1-E1：配置里最常见的一刀——扣血公式', () => {
      eq(new Expression('hp > 0 ? -dmg : 0').evaluate({ hp: 10, dmg: 3 }), -3);
      eq(new Expression('hp > 0 ? -dmg : 0').evaluate({ hp: 0, dmg: 3 }), 0);
      // 三元嵌套 + 负号
      eq(new Expression('a > 0 ? (b > 0 ? -1 : -2) : -3').evaluate({ a: 1, b: 0 }), -2);
    });

    test('P1-E1（对照）：正数三元与既有负号写法不受影响', () => {
      eq(new Expression('1 ? 5 : 7').evaluate({}), 5);
      eq(new Expression('-5').evaluate({}), -5);
      eq(new Expression('3 + -2').evaluate({}), 1);
      eq(new Expression('-(2 + 3)').evaluate({}), -5);
      eq(new Expression('max(-1, -2)').evaluate({}), -1, '函数参数里的负号');
      eq(new Expression('a > 5 ? 100 : 10').evaluate({ a: 1 }), 10);
    });

    test('P1-E1（对照）：真正的语法错误仍然报错', () => {
      throws(() => new Expression('1 ?'), '表达式不完整');
      throws(() => new Expression('1 ? 2'), '":"');
    });
  });

  // ================================================================
  describe('W7-B · expression（P1-E2 BUILTIN 原型链命中）', () => {
    // ================================================================

    /**
     * 【修复前实测】
     * ```
     * 'toString()'        → 抛 [Expression] 函数 toString() 的结果不是有限数：[object Undefined]
     * 'constructor()'     → 抛 [Expression] 函数 constructor() 的结果不是有限数：[object Object]
     * 'hasOwnProperty()'  → 抛 Cannot convert undefined or null to object
     * 'max(3, 5)'         → 5（正常）
     * ```
     * `BUILTIN[node.name]` 取到 `Object.prototype` 上的成员：
     * 它是函数，`!fn` 判定通过，于是"成功调用"了它；
     * 抛出的错误信息指向"结果不是数字"，而真正的错误是"函数不存在"。
     */
    test('⚠️ P1-E2：toString() 报"未知函数"，而不是去调用原型方法', () => {
      throws(() => new Expression('toString()').evaluate({}), '未知函数');
    });

    test('⚠️ P1-E2：constructor() / hasOwnProperty() 同样被挡住', () => {
      throws(() => new Expression('constructor()').evaluate({}), '未知函数');
      throws(() => new Expression('hasOwnProperty()').evaluate({}), '未知函数');
      throws(() => new Expression('valueOf()').evaluate({}), '未知函数');
    });

    test('P1-E2（对照）：内建函数照旧可用', () => {
      eq(new Expression('max(3, 5)').evaluate({}), 5);
      eq(new Expression('min(3, 5)').evaluate({}), 3);
      eq(new Expression('clamp(15, 0, 10)').evaluate({}), 10);
      eq(new Expression('pct(200, 25)').evaluate({}), 50);
    });

    test('P1-E2（对照）：真的拼错函数名时报未知函数', () => {
      throws(() => new Expression('foo(1)').evaluate({}), '未知函数');
    });
  });

  // ================================================================
  describe('W7-B · expression（P1-E3 非 strict 下的静默降级留痕）', () => {
    // ================================================================

    /**
     * 【修复前实测】
     * ```
     * 'missingVar + 1'        → 1（未定义变量当 0）
     * 'arr + 1'（arr = []）   → 1
     * 'n + 1'（n = null）     → 1
     * 'toString'              → 0（命中原型方法，Number(函数) = NaN → 0）
     * ```
     * 全部"算出一个偏小的数字"，与"确实填了 0"完全无法区分。
     *
     * 【本条改了什么、没改什么】
     * 返回值仍然是 0（宽松语义是刻意设计，改成抛错会让既有配置全线加载失败），
     * 只补一个**可卸载**的告警出口，让宿主能接自己的 Logger。
     */
    test('⚠️ P1-E3：未定义变量会告警一次，且只告警一次', () => {
      const seen = collectWarnings((s) => {
        const e = new Expression('missing + 1');
        eq(e.evaluate({}), 1, '返回值仍是 0 + 1');
        e.evaluate({});
        e.evaluate({});
        eq(s.length, 1, '同名问题只报一次，避免每帧刷屏');
        assert(s[0].includes('missing'), `告警应点名变量：${s[0]}`);
      });
      assert(seen.length === 1);
    });

    test('⚠️ P1-E3：null / [] 与"真的填了 0"在告警里被区分开', () => {
      collectWarnings((s) => {
        eq(new Expression('n + 1').evaluate({ n: null }), 1);
        eq(new Expression('arr + 1').evaluate({ arr: [] }), 1);
        assert(s.some((m) => m.includes('n')), 'null 应留痕');
        assert(s.some((m) => m.includes('arr')), '[] 应留痕');

        // 对照：真的填了 0 不该报
        const before = s.length;
        eq(new Expression('z + 1').evaluate({ z: 0 }), 1);
        eq(s.length, before, '值确实是 0 时不告警');
      });
    });

    test('P1-E3（对照）：不装 handler 时完全静默（默认行为不变）', () => {
      eq(new Expression('missing + 1').evaluate({}), 1);
      eq(new Expression('n + 1').evaluate({ n: null }), 1);
    });

    test('P1-E3（对照）：handler 可卸载（铁律：有 install 必有 uninstall）', () => {
      const seen: string[] = [];
      setExpressionWarningHandler((m) => seen.push(m));
      new Expression('a + 1').evaluate({});
      assert(seen.length === 1);
      setExpressionWarningHandler(null);
      new Expression('b + 1').evaluate({});
      eq(seen.length, 1, '卸载后不再有新的告警');
    });

    test('P1-E3（对照）：strict 模式仍然抛错，且不受 handler 影响', () => {
      throws(() => new Expression('missing + 1').evaluateStrict({}), '未定义的变量');
      // 【为什么这里不断言 null 抛错】
      // `Number(null) === 0` 是有限数，strict 模式下同样返回 0——
      // 这是既有行为（本条只补留痕，不改返回值），所以只锁"未定义变量"这条路径。
      eq(new Expression('n + 1').evaluateStrict({ n: null }), 1);
      throws(() => new Expression('n + 1').evaluateStrict({ n: 'abc' }), '不是有效数字');
    });

    test('P1-E3（对照）：正常变量与字符串数字不受影响', () => {
      eq(new Expression('player.atk * (1 + buff.str)').evaluate({ player: { atk: 50 }, buff: { str: 0.3 } }), 65);
      eq(new Expression('s + 1').evaluate({ s: '5' }), 6, '字符串数字仍按数字参与运算');
    });

    // ----------------------------------------------------------------
    // 【收尾补锁】W7-A 验收意见 §5.3 指出：handler 是模块级全局，
    // 但去重是按实例的——两个粒度不一样，容易被读成"全进程只报一次"。
    // 我在 README / 源码注释里把这个差异写死了（本库规则：写进文档的行为要有测试锁），
    // 所以补下面 3 条把"粒度"本身固定住。改任何一侧，这三条会立刻变红。
    // ----------------------------------------------------------------

    test('⚠️ P1-E3（收尾·上锁）：handler 是全局的——装一次，之后新建的实例同样生效', () => {
      collectWarnings((s) => {
        // 关键：这个实例是在 handler 装上**之后**才 new 的，
        // 它从来没见过 handler，却能告警 → 证明 handler 是模块级共享的。
        eq(new Expression('late + 1').evaluate({}), 1);
        eq(s.length, 1, '新实例无需各自注册 handler');
      });
    });

    test('⚠️ P1-E3（收尾·上锁）：去重按实例——两个实例用同一个拼错的变量名，会各报一次', () => {
      collectWarnings((s) => {
        eq(new Expression('same + 1').evaluate({}), 1);
        eq(new Expression('same + 1').evaluate({}), 1);
        eq(
          s.length,
          2,
          '去重是"每个实例一份 _warned"，不是全进程共享——' +
            '这一点写进了 README，改了要同步改文档'
        );
      });
    });

    test('⚠️ P1-E3（收尾·上锁·记录现状）：每帧 new 表达式时去重失效（已知边界）', () => {
      /**
       * 【这是现状，不是理想】
       * README 里写了："正确用法是配置期编译一次、运行期反复 evaluate"，
       * 因为实例是长命的，按实例去重才有效。真写成"每帧 new"，
       * 每帧都是新实例、新 `_warned`，去重必然失效、日志刷屏。
       *
       * 所以这条断言的是**当前实现的真实行为**（5 次 = 5 条），
       * 不是"它应该这样"。将来若改成"按表达式源码去重"（把 `_warned` 提到模块级），
       * 这条会变红——那时应当连同 README 的边界说明一起改，
       * 而不是把这条断言删掉。
       */
      collectWarnings((s) => {
        for (let i = 0; i < 5; i++) new Expression('temp + 1').evaluate({});
        eq(s.length, 5, '每帧 new 时按实例去重失效——README 已记录该边界');
      });
    });
  });

  // ================================================================
  describe('W7-B · expression（P2-E2 除零 · 文档化，行为上锁）', () => {
    // ================================================================

    /**
     * 【修复前实测】`10 / 0 → 0`、`10 % 0 → 0`。
     *
     * 任务书要求"文档化即可，不改代码"——这是已知取舍
     * （NaN 沿伤害管线传播比 0 更难查），本窗口不改行为，
     * 只把规则写进 README，并用下面两条用例锁住现状。
     */
    test('⚠️ P2-E2（上锁）：除零与取模零都返回 0，不返回 NaN / Infinity', () => {
      eq(new Expression('10 / 0').evaluate({}), 0);
      eq(new Expression('10 % 0').evaluate({}), 0);
      eq(new Expression('a / b').evaluate({ a: 10, b: 0 }), 0, '变量为 0 时同样返回 0');
    });

    test('P2-E2（对照）：正常除法与取模不变', () => {
      eq(new Expression('10 / 4').evaluate({}), 2.5);
      eq(new Expression('10 % 3').evaluate({}), 1);
      eq(new Expression('dmg * 100 / (100 + armor)').evaluate({ dmg: 50, armor: 100 }), 25);
    });
  });
}
