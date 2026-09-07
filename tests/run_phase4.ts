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

export function runPhase4Tests(): void {
  // ============================================================
  // B5-03 · makeKey 碰撞
  // ============================================================

  describe('stats · 分组 key 编码', () => {
    test('⚠️ 标签值含分隔符时不能与多标签组合碰撞', () => {
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
      const t = { dmg: 10 };
      throws(() => applyPatch(t, { op: 'add', path: 'dmg', value: NaN }), 'value 是有限数字');
    });

    test('⚠️ mul(Infinity) 必须抛错', () => {
      const t = { dmg: 10 };
      throws(() => applyPatch(t, { op: 'mul', path: 'dmg', value: Infinity }), 'value 是有限数字');
    });

    test('⚠️ add(字符串) 必须抛错（否则会字符串拼接）', () => {
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
      const r = teamMmr(players, { strategy: 'weighted', weightBase: -1 });
      assert(Number.isFinite(r.base), `必须是有限数，实际 ${r.base}`);
      assert(Number.isFinite(r.effective), `effective 也必须是有限数，实际 ${r.effective}`);
    });

    test('⚠️ 分母为 0 时降级为等权平均（不中断匹配）', () => {
      const r = teamMmr(players, { strategy: 'weighted', weightBase: -1 });
      assert(Math.abs(r.base - 1550) < 1e-9, `应降级为 1550，实际 ${r.base}`);
    });

    test('正常 weightBase 不受影响', () => {
      const r = teamMmr(players, { strategy: 'weighted', weightBase: 0.7 });
      assert(Math.abs(r.base - 1558.823) < 0.01, `实际 ${r.base}`);
    });

    test('⚠️ 三人队 weightBase=-1 时也可能抵消', () => {
      const r = teamMmr(
        [{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }, { id: 'c', rating: 1700 }],
        { strategy: 'weighted', weightBase: -1 }
      );
      assert(Number.isFinite(r.base), `必须是有限数，实际 ${r.base}`);
    });
  });
}
