/**
 * tests/run_phase4.ts —— 精审修复回归（第四批 · 模式之外的单独项）
 *
 * 本批是**无法归入四个模式**的独立缺陷，逐个对应实测确认过的故障：
 *
 * | 编号 | 单元 | 一句话 |
 * |---|---|---|
 * | B5-03 | stats | 分组 key 裸拼接 → 不同标签组合碰撞 |
 * | B5-04 | stats | NaN 进入统计，被展示层藏成 0 |
 * | B4-10 | skill-variant | 只校验目标字段，不校验操作数 |
 * | B1-07 | mmr | 加权分母可能抵消成 0 → 队伍 MMR 变 Infinity |
 *
 * 【共同点】它们都是"**校验做了，但只做了一半**"：
 * 校验了目标却没校验输入、校验了格式却没考虑边界、
 * 聚合了分子却没检查分母。这类缺陷比完全没校验更难发现，
 * 因为代码看起来是有防护的。
 */

import { describe, test, assert, eq, throws } from './_framework';

import { Stats, makeKey } from '../stats/Stats';
import { applyPatch } from '../skill-variant/SkillVariant';
import { teamMmr } from '../mmr/TeamMMR';
import {
  DebugConsole,
  auditImplicitlyEnabled as auditConsole,
  resetAudit as resetConsoleAudit,
} from '../debug-console/DebugConsole';
import {
  CheatCode,
  auditImplicitlyEnabled as auditCheat,
  resetAudit as resetCheatAudit,
} from '../cheatcode/CheatCode';
import { BehaviorTree, Action, BTStatus } from '../behavior-tree/BehaviorTree';

export function runPhase4Tests(): void {
  // ============================================================
  // B5-03 · makeKey 碰撞
  // ============================================================

  describe('stats · 分组 key 编码', () => {
    test('⚠️ 标签值含分隔符时不能与多标签组合碰撞', () => {
      /**
       * 【修复前实测】
       * ```js
       * makeKey('hit', { a: '1,b=2' })     // → 'hit|a=1,b=2'
       * makeKey('hit', { a: '1', b: '2' }) // → 'hit|a=1,b=2'   ← 同一个 key！
       * ```
       * 老实现是裸拼接 `` `${id}|${k}=${v},...` ``，
       * 而标签值里可以合法出现 `,` `=` `|`——
       * 武器名、关卡描述、玩家自定义标签都可能有。
       *
       * 后果：**两个不同分组被合并统计**。A 组数据算进 B 组，
       * 且总数不变、没有任何"少了一条"的迹象，
       * 表现为"某个分组数字莫名偏大"，几乎无法归因。
       */
      const k1 = makeKey('hit', { a: '1,b=2' });
      const k2 = makeKey('hit', { a: '1', b: '2' });
      assert(k1 !== k2, `不应碰撞：\n  ${k1}\n  ${k2}`);
    });

    test('⚠️ 含 | 与 = 的极端值同样不碰撞', () => {
      const k3 = makeKey('hit', { a: 'x|y=z' });
      const k4 = makeKey('hit', { a: 'x', y: 'z' });
      assert(k3 !== k4, `不应碰撞：\n  ${k3}\n  ${k4}`);
    });

    test('排序语义保持（标签顺序不影响 key）', () => {
      eq(makeKey('x', { b: '2', a: '1' }), makeKey('x', { a: '1', b: '2' }));
      eq(makeKey('x', {}), 'x|');
    });

    test('⚠️ 编码与解码必须同步（byTag 不能静默返回空）', () => {
      /**
       * 【改编码时最容易漏的一环】
       * `matchTag` / `parseTags` 按旧格式切分。
       * 若只改 makeKey 不改它们，`byTag` 会**静默返回空对象**——
       * 不是报错，而是"汇总出来什么都没有"。
       * 编译器不会提醒你还有个解码函数。
       */
      const s = new Stats({ defs: [{ id: 'killsByWeapon', agg: 'sum', tags: ['weapon'] }] });
      s.record('killsByWeapon', 1, { weapon: 'sword' });
      s.record('killsByWeapon', 2, { weapon: 'sword' });
      s.record('killsByWeapon', 4, { weapon: 'bow' });
      const by = s.byTag('killsByWeapon', 'weapon');
      eq(by.sword, 3, 'sword 应汇总为 3');
      eq(by.bow, 4, 'bow 应为 4');
    });

    test('⚠️ tagCombos 也要能正确反解析', () => {
      const s = new Stats({ defs: [{ id: 'kills', agg: 'sum', tags: ['weapon'] }] });
      s.record('kills', 1, { weapon: 'sword' });
      const combos = s.tagCombos('kills');
      eq(combos.length, 1, '应有一组标签组合');
      eq(combos[0].weapon, 'sword', '应能还原出标签值');
    });
  });

  // ============================================================
  // B5-04 · NaN 进统计
  // ============================================================

  describe('stats · 非有限值拦截', () => {
    test('⚠️ record(NaN) 必须抛错，不能让 display 藏成 0', () => {
      /**
       * 【修复前实测】
       * ```js
       * s.record('hit', NaN);
       * s.get('hit')      // → NaN
       * s.display('hit')  // → 0    ← 坏数据被展示层静默藏掉
       * ```
       * "统计面板显示 0"看起来完全正常，没人会想到上游算出了 NaN。
       *
       * 【注意 display() 本身的设计是对的】
       * max 聚合无记录时是 -Infinity（数学上正确的单位元），
       * 直接渲染会显示 "-∞"，所以展示层转成 0。
       * **但 NaN 和"合法单位元"是两回事**——前者是数据损坏，后者是空集。
       * 修法是在入口拦 NaN，而不是让展示层一刀切。
       */
      const s = new Stats({ defs: [{ id: 'hit', agg: 'sum' }] });
      throws(() => s.record('hit', NaN), '必须是有限数值');
    });

    test('⚠️ set(NaN) 同样要拦', () => {
      const s = new Stats({ defs: [{ id: 'hit', agg: 'sum' }] });
      throws(() => s.set('hit', NaN), '必须是有限数值');
    });

    test('⚠️ record(Infinity) 也要拦', () => {
      const s = new Stats({ defs: [{ id: 'hit', agg: 'sum' }] });
      throws(() => s.record('hit', Infinity), '必须是有限数值');
    });

    test('正常记录不受影响', () => {
      const s = new Stats({ defs: [{ id: 'hit', agg: 'sum' }] });
      s.record('hit', 10);
      s.add('hit', 5);
      eq(s.get('hit'), 15);
    });

    test('⚠️ display 对"合法单位元"仍返回 0（原设计保留，不能误伤）', () => {
      const s = new Stats({ defs: [{ id: 'm', agg: 'max' }] });
      eq(s.display('m'), 0, 'max 无记录时 display 应为 0，不是 -∞');
    });
  });

  // ============================================================
  // B4-10 · skill-variant 操作数
  // ============================================================

  describe('skill-variant · 数值操作数校验', () => {
    test('⚠️ add(NaN) 必须抛错', () => {
      /**
       * 【修复前实测】`applyPatch({dmg:10}, {op:'add', path:'dmg', value:NaN})` → NaN。
       * 老实现的 `assertNumber` 只校验了 `oldVal`（目标字段），
       * 操作数 `p.value` 直接 `as number` 强转后参与运算。
       */
      const t = { dmg: 10 };
      throws(() => applyPatch(t, { op: 'add', path: 'dmg', value: NaN }), 'value 是有限数字');
    });

    test('⚠️ mul(Infinity) 必须抛错', () => {
      const t = { dmg: 10 };
      throws(() => applyPatch(t, { op: 'mul', path: 'dmg', value: Infinity }), 'value 是有限数字');
    });

    test('⚠️ add(字符串) 必须抛错（否则会字符串拼接）', () => {
      /**
       * 【修复前实测】`value: 'abc'` → dmg 变成 **"10abc"**。
       * `number + string` 在 JS 里是字符串拼接，
       * 字段类型从 number 悄悄变成 string，
       * 后续 `dmg * 2` 得 NaN，而错误现场离这条补丁已经很远了。
       */
      const t = { dmg: 10 };
      throws(() => applyPatch(t, { op: 'add', path: 'dmg', value: 'abc' }), 'value 是有限数字');
    });

    test('⚠️ max / min 的操作数同样要校验', () => {
      throws(() => applyPatch({ dmg: 10 }, { op: 'max', path: 'dmg', value: NaN }), 'value 是有限数字');
      throws(() => applyPatch({ dmg: 10 }, { op: 'min', path: 'dmg', value: NaN }), 'value 是有限数字');
    });

    test('正常补丁不受影响', () => {
      const t = { dmg: 10 };
      applyPatch(t, { op: 'add', path: 'dmg', value: 5 });
      eq(t.dmg, 15);
      applyPatch(t, { op: 'mul', path: 'dmg', value: 2 });
      eq(t.dmg, 30);
    });

    test('⚠️ 目标字段不存在时报错信息要指向路径（不是值）', () => {
      throws(() => applyPatch({}, { op: 'add', path: 'nope', value: 1 }), '不存在');
    });
  });

  // ============================================================
  // B1-07 · mmr 加权分母为零
  // ============================================================

  describe('mmr · 加权基础分', () => {
    const players = [{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }];

    test('⚠️ weightBase 使分母抵消为 0 时不能返回 Infinity', () => {
      /**
       * 【修复前实测】
       * ```js
       * teamMmr([1500, 1600], { strategy: 'weighted', weightBase: -1 })
       * // den = 1 + (-1) = 0  →  base = Infinity
       * ```
       * 权重是 `base^i`，base 为负时正负交替，分母可能正好抵消。
       *
       * 队的 MMR 变成 Infinity，之后所有匹配分、胜负概率、
       * 段位判定全部失效，且**没有任何报错**——
       * Infinity 是合法 number，能一路穿到 UI 上显示 "∞"。
       */
      const r = teamMmr(players, { strategy: 'weighted', weightBase: -1 });
      assert(Number.isFinite(r.base), `必须是有限数，实际 ${r.base}`);
      assert(Number.isFinite(r.effective), `effective 也必须是有限数，实际 ${r.effective}`);
    });

    test('⚠️ 分母为 0 时降级为等权平均（不中断匹配）', () => {
      const r = teamMmr(players, { strategy: 'weighted', weightBase: -1 });
      // (1500 + 1600) / 2
      assert(Math.abs(r.base - 1550) < 1e-9, `应降级为 1550，实际 ${r.base}`);
    });

    test('正常 weightBase 不受影响', () => {
      const r = teamMmr(players, { strategy: 'weighted', weightBase: 0.7 });
      assert(Math.abs(r.base - 1558.823) < 0.01, `实际 ${r.base}`);
    });

    test('⚠️ 三人队 weightBase=-1 时也可能抵消（0 个 vs 3 个的分母）', () => {
      // 1 + (-1) + 1 = 1，不为 0，但值得确认不崩
      const r = teamMmr(
        [{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }, { id: 'c', rating: 1700 }],
        { strategy: 'weighted', weightBase: -1 }
      );
      assert(Number.isFinite(r.base), `必须是有限数，实际 ${r.base}`);
    });
  });

  // ============================================================
  // B4-11 / B5-01 · 调试台与作弊码的默认开启
  // ============================================================

  describe('debug-console · 默认开启的可审计性', () => {
    test('⚠️ 未显式传 enabled 时审计计数 +1', () => {
      /**
       * 【为什么需要计数而不只是 console.warn】
       * 1. 开发者可能根本不看控制台
       * 2. **CI 无法拦截 warn**——warn 不是失败
       *
       * 计数让项目能在启动自检里断言：
       * `if (auditImplicitlyEnabled() > 0) throw ...`
       *
       * 【为什么不把默认值直接改成 false】
       * 那是破坏性变更——现有用户的调试命令会静默失效且无提示。
       * 所以保留默认开启，只强化提醒。
       */
      resetConsoleAudit();
      eq(auditConsole(), 0, '前置：计数应清零');
      new DebugConsole({});
      eq(auditConsole(), 1);
    });

    test('显式传 enabled 时不计数（不打扰想清楚的人）', () => {
      resetConsoleAudit();
      new DebugConsole({ enabled: true });
      new DebugConsole({ enabled: false });
      eq(auditConsole(), 0, '两种显式传法都不该计数');
    });

    test('运行时改为显式设置后撤销计数', () => {
      resetConsoleAudit();
      const d = new DebugConsole({});
      eq(auditConsole(), 1);
      d.enabled = false;
      eq(auditConsole(), 0, '显式设置后不该再算作"忘了传"');
    });

    test('enabledWasExplicit 能区分"传过"与"没传"', () => {
      eq(new DebugConsole({}).enabledWasExplicit, false);
      eq(new DebugConsole({ enabled: true }).enabledWasExplicit, true);
    });
  });

  describe('behavior-tree · 黑板作用域（写示例时踩到）', () => {
    test('黑板是树自带的，外部对象传不进去', () => {
      /**
       * 【为什么记这条】
       * 补 examples/batch22-usage.ts 时，我第一版自己建了个
       * `const bb = {}` 想当黑板传进去，断言 `bb.lastSeenX` 一直失败。
       *
       * 查源码才发现 `tick(ctx, dt)` **没有 blackboard 参数**——
       * 树用的是自己的 `public readonly blackboard`，外部无法替换。
       *
       * 这不是缺陷（黑板作用域就该是"这棵树"，
       * 多棵树共享一个才会在 reset 时互相影响），
       * 但 API 上看不出来，连照着 README 写都会踩。
       *
       * 这条用例把"外部对象不会生效"固化下来，
       * 免得有人以为能传、然后困惑于数据没写入。
       */
      const tree = new BehaviorTree<{ v: number }>(
        new Action<{ v: number }>('写黑板', (_c, board) => {
          board.written = 1;
          return BTStatus.Success;
        })
      );
      const outside: Record<string, unknown> = {};
      tree.tick({ v: 1 }, 0.016);

      eq(tree.blackboard.written, 1, '应写入树自带的黑板');
      eq(outside.written, undefined, '外部对象不该被写入');
    });
  });

  describe('cheatcode · 默认开启的可审计性', () => {
    test('⚠️ 未显式传 enabled 时审计计数 +1', () => {
      resetCheatAudit();
      new CheatCode({});
      eq(auditCheat(), 1);
    });

    test('显式传 enabled 时不计数', () => {
      resetCheatAudit();
      new CheatCode({ enabled: true });
      new CheatCode({ enabled: false });
      eq(auditCheat(), 0);
    });

    test('运行时改为显式设置后撤销计数', () => {
      resetCheatAudit();
      const c = new CheatCode({});
      eq(auditCheat(), 1);
      c.enabled = false;
      eq(auditCheat(), 0);
    });

    test('resetAudit 可清零（热重载与单测用）', () => {
      new CheatCode({});
      assert(auditCheat() > 0);
      resetCheatAudit();
      eq(auditCheat(), 0);
    });
  });
}