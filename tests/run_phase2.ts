/**
 * tests/run_phase2.ts —— 精审修复回归（第二批 · 模式 A：Record 查表原型链）
 *
 * 【模式 A 是什么】
 * `Record<string, T>` 用 `obj[key]` 或 `key in obj` 查表时，
 * key 来自外部输入（配置表 / 存档 / 网络包 / 业务字符串）的情况下，
 * 传进 `'toString'` / `'constructor'` / `'valueOf'` 会取到
 * `Object.prototype` 上的方法——**不是 undefined，所以 `?? 默认值` 挡不住**。
 *
 * 【为什么危险】
 * 它不会抛异常，而是"返回了一个类型正确的假值"：
 * 该是数字的地方返回 NaN 或字符串，该是对象的地方返回函数。
 * 下游 `伤害 * 倍率` 立刻变 NaN，表现为数值静默失效。
 *
 * 【本轮修法】
 * 配置类 Record **在构造期**复制进 `Map`（fsm），
 * 或在统一入口用 `hasOwn` 挡一层（其余 6 处）。
 * 不采用"每个读取点零散加判断"——会漏。
 */

import { describe, test, assert, eq, throws } from './_framework';

import { StateMachine } from '../fsm/StateMachine';
import { Telemetry } from '../telemetry/Telemetry';
import { DifficultySystem } from '../difficulty/DifficultySystem';
import { Stats } from '../stats/Stats';
import { ScopedStore } from '../runscope/ScopedStore';
import { BgmStack } from '../audio/BGMStack';
import { MemoryTableSource } from '../config/ConfigLoader';

export function runPhase2Tests(): void {
  // ============================================================
  // fsm
  // ============================================================

  describe('fsm · 状态表（构造期复制进 Map）', () => {
    test('⚠️ 初始状态为原型键时必须抛错', () => {
      /**
       * 【修复前实测】
       * ```js
       * const sm = new StateMachine({ states: {}, initial: 'toString' });  // 不报错
       * sm.start({});        // enter 静默不触发
       * sm.current           // → 'toString'
       * ```
       * `states['toString']` 取到 `Object.prototype.toString`（函数，truthy），
       * 于是 `if (!states[initial])` 通过了校验，
       * 状态机带着一个不存在的状态正常启动，enter/exit/update 全部静默不触发。
       * 这是最难查的一类：不报错、不崩溃，只是"什么都没发生"。
       */
      throws(() => new StateMachine({ states: {}, initial: 'toString' }), '初始状态');
    });

    test('⚠️ 转换到原型键状态必须被拒', () => {
      const sm = new StateMachine<{}>({
        states: { a: {}, b: {} },
        initial: 'a',
      });
      throws(() => sm.transitionTo('constructor', {}), '目标状态');
    });

    test('正常状态机不受影响', () => {
      let entered = 0;
      const sm = new StateMachine<{}>({
        states: { a: { enter: () => entered++ }, b: {} },
        initial: 'a',
        transitions: { a: ['b'] },
      });
      sm.start({});
      eq(entered, 1, 'enter 应触发一次');
      eq(sm.current, 'a');
      eq(sm.can('b'), true, '允许的转换应为 true');
      eq(sm.can('toString'), false, '未配置的转换应为 false');
      eq(sm.transitionTo('b', {}), true, '转换应成功');
      eq(sm.current, 'b');
    });

    test('⚠️ findUnreachable 不再把原型键算进状态列表', () => {
      const sm = new StateMachine<{}>({
        states: { a: {}, orphan: {} },
        initial: 'a',
        transitions: { a: [] },
      });
      const unreachable = sm.findUnreachable();
      assert(
        unreachable.includes('orphan'),
        `应报出 orphan 不可达，实际 ${JSON.stringify(unreachable)}`
      );
      assert(!unreachable.includes('toString'), '不应包含原型键');
    });
  });

  // ============================================================
  // telemetry
  // ============================================================

  describe('telemetry · 事件采样率表', () => {
    test('⚠️ 事件名为原型键时回退全局采样率，不再被永久丢弃', () => {
      /**
       * 【修复前实测】
       * ```js
       * new Telemetry({ eventSampleRates: {} }).willSample('toString')  // → false
       * ```
       * rate = `Object.prototype.toString`（函数），
       * `hash < function` 是 NaN 比较、恒为 false → 事件被永久丢弃。
       * 因为采样本来就是概率性的，"永远不上报"看起来和正常采样一模一样。
       */
      const t = new Telemetry({ eventSampleRates: {}, sampleRate: 1 });
      eq(t.willSample('toString'), true, '未配置时应回退全局采样率');
    });

    test('显式配置的采样率仍生效', () => {
      const t = new Telemetry({ eventSampleRates: { rare: 0 }, sampleRate: 1 });
      eq(t.willSample('rare'), false, '配置为 0 的事件应被丢弃');
      eq(t.willSample('normal'), true, '未配置的应走全局');
    });
  });

  // ============================================================
  // difficulty
  // ============================================================

  describe('difficulty · 倍率表', () => {
    test('⚠️ multiplier 原型键返回 1，不再返回 NaN', () => {
      /**
       * 【修复前实测】
       * ```js
       * d.multiplier('toString')  // → NaN
       * ```
       * `?? 1` 挡不住函数值，于是 `base * (1 + delta)` = NaN，
       * `Math.max(0.05, NaN)` 仍是 NaN。
       * 而本函数声明返回 `number`——**违反自声明类型却不报错**，
       * 调用方拿它乘伤害/血量，一个 NaN 就让角色血量永久变 NaN。
       */
      const d = new DifficultySystem({ tiers: [{ id: 't', multipliers: {} }] });
      d.setTier('t');
      eq(d.multiplier('toString'), 1, '未配置的倍率应为 1');
      assert(Number.isFinite(d.multiplier('toString')), '必须是有限数');
    });

    test('⚠️ baseMultiplier 同口径（两处不能只修一处）', () => {
      const d = new DifficultySystem({ tiers: [{ id: 't', multipliers: {} }] });
      d.setTier('t');
      eq(d.baseMultiplier('toString'), 1);
    });

    test('正常倍率不受影响', () => {
      const d = new DifficultySystem({
        tiers: [{ id: 'hard', multipliers: { enemyHp: 1.8 } }],
      });
      d.setTier('hard');
      eq(d.multiplier('enemyHp'), 1.8, '已配置的倍率应原样返回');
      eq(d.multiplier('unknownKey'), 1, '未配置的应为 1');
    });
  });

  // ============================================================
  // stats
  // ============================================================

  describe('stats · 派生指标表（`in` 改 hasOwn）', () => {
    test('⚠️ get 原型键应抛"未定义指标"，而不是返回字符串', () => {
      /**
       * 【修复前实测】
       * ```js
       * s.get('toString')  // → "[object Object]"（字符串！）
       * ```
       * `'toString' in this._derived` 命中原型链为 true，
       * 于是调用 `Object.prototype.toString` 得到字符串。
       * 该函数声明返回 `number`，却返回了字符串且不报错。
       */
      const s = new Stats({ defs: [{ id: 'hit', agg: 'sum' }], derived: {} });
      throws(() => s.get('toString'), '未定义的指标');
    });

    test('⚠️ derived() 同样只认自有属性', () => {
      const s = new Stats({ defs: [{ id: 'hit', agg: 'sum' }], derived: {} });
      throws(() => s.derived('valueOf'), '未定义的派生指标');
    });

    test('正常指标不受影响', () => {
      const s = new Stats({ defs: [{ id: 'hit', agg: 'sum' }], derived: {} });
      eq(s.get('hit'), 0, 'sum 聚合的单位元是 0');
    });

    test('tryGet 不抛错版本仍能兜底', () => {
      const s = new Stats({ defs: [{ id: 'hit', agg: 'sum' }], derived: {} });
      eq(s.tryGet('toString'), 0, 'tryGet 应兜底为 0');
    });
  });

  // ============================================================
  // runscope
  // ============================================================

  describe('runscope · schema 查询', () => {
    test('⚠️ has(原型键) 必须为 false', () => {
      /**
       * 【修复前实测】`has('toString')` → true（schema 是空对象）。
       * `has()` 是"这个键该不该持久化"的判据，
       * 返回 true 会让不存在的键进入存档/同步流程。
       */
      const st = new ScopedStore({ schema: {} });
      eq(st.has('toString'), false);
      eq(st.has('constructor'), false);
    });
  });

  // ============================================================
  // audio BGM
  // ============================================================

  describe('audio · BGM 状态表', () => {
    test('⚠️ setState(原型键) 必须抛错，不再静默静音', () => {
      /**
       * 【修复前实测】
       * ```js
       * b.setState('toString')  // → true（被接受！），随后所有层音量变 0
       * ```
       * `in` 校验被原型链绕过，`_mixOf` 取到函数，
       * `mix[layerName] ?? 0` 全为 0 → BGM 静音且不报错。
       * 音频问题本就难定位，配合不报错几乎无从下手。
       */
      const b = new BgmStack({
        layers: [{ name: 'music' }],
        states: { calm: { music: 1 } },
        initialState: 'calm',
      });
      throws(() => b.setState('toString'), '未知状态');
    });

    test('正常状态切换不受影响', () => {
      const b = new BgmStack({
        layers: [{ name: 'music' }],
        states: { calm: { music: 1 }, battle: { music: 0.5 } },
        initialState: 'calm',
      });
      eq(b.setState('battle'), true, '切到不同状态应成功');
      eq(b.setState('battle'), false, '同状态重复调用应返回 false');
    });
  });

  // ============================================================
  // config
  // ============================================================

  describe('config · 表查询', () => {
    test('⚠️ load(原型表名) 必须抛"表不存在"', () => {
      /**
       * 【修复前实测】
       * ```js
       * new MemoryTableSource({}).load('toString')  // → 返回函数，不抛错
       * ```
       * `this._data['toString']` 取到原型方法（truthy），`if (!rows)` 挡不住。
       * 下游把函数当行数组去遍历校验，得到一堆莫名其妙的错误，
       * 真正的病根（表名错了）被掩盖。
       */
      const src = new MemoryTableSource({});
      throws(() => src.load('toString'), '表不存在');
    });

    test('已存在的表正常读取', () => {
      const rows = [{ id: 'a' }];
      const src = new MemoryTableSource({ items: rows });
      eq(src.load('items'), rows, '应返回原数组');
    });
  });
}
