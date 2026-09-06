/**
 * tests/run_batch11.ts —— 第十批插件测试
 *
 * loot.Chest 加权抽取（对已有插件的增强）
 * runscope    局内/局外/会话三域隔离
 * setbonus    装备套装（阈值叠加、部位去重、效果回退）
 * daily       每日挑战（时区、种子雪崩、分享回填）
 * leaderboard 排行榜（并列名次、只留最好、分页、快照）
 */

import { test, describe, assert, eq, near, throws } from './_framework';
import { Chest } from '../loot/Chest';
import { RNG } from '../rng/RNG';
import {
  ScopedStore,
  key,
  keys,
  type Scope,
} from '../runscope/ScopedStore';
import { SetBonusSystem, type SetDef } from '../setbonus/SetBonus';
import {
  DailyChallenge,
  dateKeyOf,
  hashDateKey,
  seedToText,
  isValidSeedText,
} from '../daily/DailyChallenge';
import {
  Leaderboard,
  mergeLeaderboards,
  type ScoreEntry,
} from '../leaderboard/Leaderboard';

export async function runBatch11Tests(): Promise<void> {
  // ============================================================
  describe('ScopedStore · 局内外数据隔离', () => {
    // ============================================================

    /** 一个典型的肉鸽 schema */
    function makeStore(strict = true) {
      return new ScopedStore({
        strict,
        schema: {
          ...keys('run', { gold: 0, floor: 1, relics: [] as string[] }),
          ...keys('meta', { souls: 0, unlocked: [] as string[], totalRuns: 0 }),
          fps: key('session', 0, '当前帧率'),
        },
      });
    }

    test('基本读写', () => {
      const s = makeStore();
      s.beginRun();
      s.set('gold', 100);
      eq(s.get('gold'), 100);
      eq(s.get('floor'), 1, '初始值应生效');
      s.add('gold', 50);
      eq(s.get('gold'), 150);
    });

    test('⚠️ 局外读取局内数据 → 抛错', () => {
      const s = makeStore();
      // 还没 beginRun
      throws(() => s.get('gold'), '局外');
      throws(() => s.set('gold', 100), '局外');
    });

    test('⚠️ 局外写入局内数据 → 抛错（防串档的核心）', () => {
      const s = makeStore();
      s.beginRun();
      s.set('gold', 100);
      s.endRun();
      throws(() => s.set('gold', 999), '局外', 'endRun 后不能再写局内数据');
    });

    test('⚠️ meta 域在局外可正常访问', () => {
      const s = makeStore();
      // 局外
      s.set('souls', 50);
      eq(s.get('souls'), 50, '永久货币在局外必须能读写');
      s.beginRun();
      s.set('souls', 80);
      eq(s.get('souls'), 80, '局内获得的永久货币应立刻记账');
      s.endRun();
      eq(s.get('souls'), 80, '局内获得的永久货币不应被清掉');
    });

    test('⚠️ session 域任何时候都可访问', () => {
      const s = makeStore();
      s.set('fps', 60);
      s.beginRun();
      s.set('fps', 30);
      s.endRun();
      eq(s.get('fps'), 30, 'session 不该被 endRun 清掉');
    });

    test('⚠️ endRun 重置为初始值而不是删除', () => {
      const s = makeStore();
      s.beginRun();
      s.set('gold', 500);
      s.set('floor', 7);
      s.endRun();

      s.beginRun();
      eq(s.get('gold'), 0, '新一局应回到初始值，而不是 undefined');
      eq(s.get('floor'), 1);

      // 如果是 undefined，下面这行会得到 NaN
      s.add('gold', 10);
      eq(s.get('gold'), 10, '不能是 NaN');
    });

    test('⚠️ 重复 beginRun 抛错（提示忘了 endRun）', () => {
      const s = makeStore();
      s.beginRun();
      throws(() => s.beginRun(), '重复 beginRun');
    });

    test('重复 endRun 无害', () => {
      const s = makeStore();
      s.endRun();   // 局外调 endRun
      s.beginRun();
      s.endRun();
      s.endRun();   // 幂等
    });

    test('⚠️ 未声明的键 → 抛错（防拼写错误）', () => {
      const s = makeStore();
      throws(() => s.get('golld'), '未声明');
      throws(() => s.set('golld', 1), '未声明');
    });

    test('onUnknownKey=session 作为临时逃生通道', () => {
      const s = new ScopedStore({
        schema: { gold: key('run', 0) },
        onUnknownKey: 'session',
      });
      s.set('tempThing', 1);      // 不该抛
      eq(s.scopeOf('tempThing'), 'session');
      eq(s.get('tempThing'), 1);
    });

    test('⚠️ strict=false 时不抛错但仍警告', () => {
      const s = makeStore(false);
      const orig = console.warn;
      let warned = '';
      console.warn = (...a: unknown[]) => { warned += String(a[0]); };
      try {
        s.set('gold', 100);   // 局外写局内
      } finally {
        console.warn = orig;
      }
      assert(warned.includes('局外'), '非严格模式也应警告');
      eq(s.get('gold'), 100, '值仍被写入（只是不中断）');
    });

    test('add 只能用于数值键', () => {
      const s = makeStore();
      s.beginRun();
      throws(() => s.add('relics', 1), '数值');
    });

    test('⚠️ add 不会变成字符串拼接', () => {
      const s = makeStore();
      s.beginRun();
      s.add('gold', 10);
      s.add('gold', 20);
      eq(s.get('gold'), 30, '必须是数值相加，不能是 "1020"');
    });

    test('⚠️ 存档只含 meta 与（局内的）run，不含 session', () => {
      const s = makeStore();
      s.beginRun();
      s.set('gold', 300);
      s.set('souls', 42);
      s.set('fps', 120);

      const snap = s.exportSave();
      eq(snap.inRun, true);
      eq(snap.meta['souls'], 42);
      eq(snap.run['gold'], 300);
      eq('fps' in snap.meta, false, 'session 不该进存档');
      eq('fps' in snap.run, false, 'session 不该进存档');
    });

    test('⚠️ 局外存档不含 run（避免把上局数据存进永久槽）', () => {
      const s = makeStore();
      s.beginRun();
      s.set('gold', 300);
      s.endRun();
      const snap = s.exportSave();
      eq(Object.keys(snap.run).length, 0, '局外时 run 域应为空');
    });

    test('⚠️ 读档：局内存档能续玩', () => {
      const a = makeStore();
      a.beginRun();
      a.set('gold', 777);
      a.set('souls', 9);
      const snap = a.exportSave();

      const b = makeStore();
      b.importSave(snap);
      eq(b.inRun, true, '应恢复到局内状态');
      eq(b.get('gold'), 777);
      eq(b.get('souls'), 9);
    });

    test('⚠️ 读档容错：多余的键忽略、缺失的键用初始值', () => {
      const s = makeStore();
      s.importSave({
        meta: { souls: 5, 已删除的键: 'x' } as Record<string, unknown>,
        run: {},
        inRun: false,
      } as never);
      eq(s.get('souls'), 5);
      eq((s.get('unlocked') as string[]).length, 0, '缺失的键应取初始值');
    });

    test('exportMeta 只导出永久数据', () => {
      const s = makeStore();
      s.beginRun();
      s.set('gold', 1);
      s.set('souls', 2);
      const m = s.exportMeta();
      eq('gold' in m, false);
      eq(m['souls'], 2);
    });

    test('scopeOf 返回键所属域', () => {
      const s = makeStore();
      eq(s.scopeOf('gold'), 'run');
      eq(s.scopeOf('souls'), 'meta');
      eq(s.scopeOf('fps'), 'session');
      eq(s.scopeOf('不存在的'), null);
    });

    test('has 判断键是否已声明', () => {
      const s = makeStore();
      eq(s.has('gold'), true);
      eq(s.has('golld'), false);
    });

    test('getOr 不抛错', () => {
      const s = makeStore();
      eq(s.getOr('gold', -1), -1, '局外读 run 域应返回兜底值');
      eq(s.getOr('不存在的', 'x'), 'x');
    });

    test('onChange 回调带域名', () => {
      const seen: Array<[string, Scope]> = [];
      const s = new ScopedStore({
        schema: { gold: key('run', 0), souls: key('meta', 0) },
        onChange: (k, scope) => seen.push([k, scope]),
      });
      s.beginRun();
      s.set('gold', 1);
      s.set('souls', 2);
      eq(seen.length, 2);
      eq(seen[0][1], 'run');
      eq(seen[1][1], 'meta');
    });

    test('describe 输出可读结构', () => {
      const s = makeStore();
      s.beginRun();
      const d = s.describe();
      assert(d.includes('局内'), '应显示当前状态');
      assert(d.includes('gold'), '应列出键');
      assert(d.includes('run'), '应标出域名');
    });

    test('reset 全清回初始值', () => {
      const s = makeStore();
      s.beginRun();
      s.set('gold', 100);
      s.set('souls', 50);
      s.reset();
      eq(s.inRun, false);
      s.beginRun();
      eq(s.get('gold'), 0);
      eq(s.get('souls'), 0);
    });

    // ============================================================
    describe('Chest · 加权抽取', () => {
      // ============================================================

      /** 统计多轮抽取中各项出现次数 */
      function tally<T>(
        chest: Chest<T>,
        rounds: number,
        keyFn: (t: T) => string
      ): Record<string, number> {
        const c: Record<string, number> = {};
        for (let i = 0; i < rounds; i++) {
          chest.reset();
          for (const o of chest.roll(new RNG(i * 7919 + 13))) {
            const k = keyFn(o);
            c[k] = (c[k] ?? 0) + 1;
          }
        }
        return c;
      }

      test('⚠️ 加权：3:1 的权重应体现在结果里', () => {
        const chest = new Chest(['common', 'rare'], {
          count: 1,
          weightOf: (x) => (x === 'common' ? 3 : 1),
        });
        const c = tally(chest, 4000, (x) => x);
        const ratio = (c['common'] ?? 0) / (c['rare'] ?? 0);
        assert(ratio > 2.55 && ratio < 3.45, `权重比应约为 3，实际 ${ratio.toFixed(2)}`);
      });

      test('⚠️ 加权：权重为 0 的项永不出现', () => {
        const chest = new Chest(['a', 'b', 'c'], {
          count: 1,
          weightOf: (x) => (x === 'a' ? 0 : 1),
        });
        const c = tally(chest, 500, (x) => x);
        eq(c['a'], undefined, '权重 0 的项不该出现');
        assert((c['b'] ?? 0) > 0 && (c['c'] ?? 0) > 0);
      });

      test('⚠️ 负权重当 0 处理（不抛错）', () => {
        const chest = new Chest(['a', 'b'], {
          count: 1,
          weightOf: (x) => (x === 'a' ? -5 : 1),
        });
        const c = tally(chest, 300, (x) => x);
        eq(c['a'], undefined, '负权重不该出现');
      });

      test('⚠️ 全零权重退化为等概率（而不是界面空白）', () => {
        const chest = new Chest(['a', 'b', 'c'], { count: 2, weightOf: () => 0 });
        const c = tally(chest, 600, (x) => x);
        eq(Object.keys(c).length, 3, '三项都该出现');
        const vals = Object.values(c);
        assert(Math.max(...vals) / Math.min(...vals) < 1.6, '退化后应大致均匀');
      });

      test('⚠️ 加权不放回：每轮重新计算总权重', () => {
        /**
         * 缓存总权重会导致：[a(w=1), b(w=9)] 抽 2 个时，
         * 第二轮仍用 total=10，b 被抽两次、a 永远抽不到。
         */
        const chest = new Chest(['a', 'b'], { count: 2, weightOf: (x) => (x === 'a' ? 1 : 9) });
        const c = tally(chest, 400, (x) => x);
        assert((c['a'] ?? 0) > 0, 'a 必须能出现');
        assert((c['b'] ?? 0) > 0, 'b 必须能出现');
      });

      test('⚠️ 关键认知：不放回 ≠ 独立抽取', () => {
        /**
         * 池子 [legendary(w=1), common(w=99)]：
         * - 抽 1 个：legendary 约 1%
         * - 抽 2 个（= 抽满池子）：legendary 必然出现
         *
         * 这是肉鸽配表最容易搞错的地方。
         */
        const chest = new Chest(['legendary', 'common'], {
          count: 2,
          weightOf: (x) => (x === 'legendary' ? 1 : 99),
        });
        const c = tally(chest, 300, (x) => x);
        eq(c['legendary'], 300, '抽满池子时权重 1% 的项也必然出现');

        const chest2 = new Chest(['legendary', 'common'], {
          count: 1,
          weightOf: (x) => (x === 'legendary' ? 1 : 99),
        });
        const c2 = tally(chest2, 5000, (x) => x);
        const rate = (c2['legendary'] ?? 0) / 5000;
        assert(rate < 0.03, `只抽 1 个时应接近 1%，实际 ${(rate * 100).toFixed(2)}%`);
      });

      test('⚠️ 加权 + 不放回：同一批不重复', () => {
        const chest = new Chest(['a', 'b', 'c', 'd'], {
          count: 3,
          weightOf: (x) => (x === 'a' ? 100 : 1),
        });
        for (let i = 0; i < 100; i++) {
          chest.reset();
          const opts = chest.roll(new RNG(i));
          eq(new Set(opts).size, opts.length, '同一批不该有重复');
        }
      });

      test('⚠️ 浮点兜底：极端权重不越界', () => {
        /**
         * r = rng.next() * total 在浮点下可能略大于权重累加和，
         * 循环结束也没命中。兜底必须是"最后一个"——
         * 取 -1 会崩，取 0 会偏爱第一项。
         */
        const chest = new Chest(['a', 'b', 'c'], {
          count: 1,
          weightOf: (x) => (x === 'a' ? 1e-12 : 1e12),
        });
        for (let i = 0; i < 200; i++) {
          chest.reset();
          const opts = chest.roll(new RNG(i));
          assert(opts.length === 1 && opts[0] !== undefined, '必须给出合法选项');
        }
      });

      test('⚠️ 不传 weightOf 时行为不变（向后兼容）', () => {
        const chest = new Chest(['a', 'b', 'c', 'd'], { count: 2 });
        const c = tally(chest, 2000, (x) => x);
        eq(Object.keys(c).length, 4, '四项都该出现');
        const vals = Object.values(c);
        assert(Math.max(...vals) / Math.min(...vals) < 1.3, '等概率应大致均匀');
      });

      test('⚠️ 权重可运行时变化（与 filter 的区别）', () => {
        /**
         * filter 是布尔的（出现/不出现）；
         * 权重是连续的，适合"已持有则减半"这类软性调节。
         */
        let owned = 0;
        const chest = new Chest(['a', 'b', 'c'], {
          count: 1,
          weightOf: (x) => (x === 'a' && owned > 0 ? 1 : 10),
        });
        const before = tally(chest, 1500, (x) => x);
        const r1 = (before['a'] ?? 0) / 1500;
        owned = 1;
        const after = tally(chest, 1500, (x) => x);
        const r2 = (after['a'] ?? 0) / 1500;
        assert(r2 < r1 * 0.6, `权重降低后出现率应下降：${r1.toFixed(3)} → ${r2.toFixed(3)}`);
      });

      test('加权后 reroll 仍排除当前项', () => {
        const chest = new Chest(['a', 'b', 'c', 'd', 'e'], {
          count: 2,
          rerolls: 1,
          weightOf: (x) => (x === 'a' ? 100 : 1),
        });
        const first = chest.roll(new RNG(1)).slice();
        assert(chest.reroll(new RNG(2)));
        for (const s of chest.current) {
          assert(!first.includes(s), `reroll 不该再出现 ${s}`);
        }
      });
    });
  });

  // ============================================================
  describe('SetBonus · 装备套装', () => {
    // ============================================================

    const flameSet: SetDef = {
      id: 'flame',
      name: '烈焰',
      thresholds: [
        { count: 2, effects: [{ stat: 'atk', op: 'mul', value: 1.1 }] },
        { count: 4, effects: [{ stat: 'atk', op: 'mul', value: 1.25 },
                              { stat: 'cdr', op: 'add', value: 0.15 }] },
      ],
    };

    function makeSystem(cumulative = false) {
      return new SetBonusSystem({ sets: [flameSet], cumulative });
    }

    /** 穿 n 件烈焰（不同部位） */
    function wear(s: SetBonusSystem, n: number, prefix = 'flame'): void {
      const slots = ['head', 'chest', 'hands', 'legs', 'feet', 'back'];
      for (let i = 0; i < n; i++) {
        s.equip({ id: `${prefix}_${slots[i]}`, set: 'flame', slot: slots[i] });
      }
    }

    test('未达档位时无效果', () => {
      const s = makeSystem();
      wear(s, 1);
      eq(s.countFor('flame'), 1);
      eq(s.activeThresholds().length, 0);
      eq(Object.keys(s.summary()).length, 0);
    });

    test('⚠️ 2 件激活 2 件档', () => {
      const s = makeSystem();
      wear(s, 2);
      const active = s.activeThresholds();
      eq(active.length, 1);
      eq(active[0].count, 2);
      eq(s.summary()['atk.mul'], 1.1);
    });

    test('⚠️ 非叠加模式：4 件只生效 4 件档', () => {
      const s = makeSystem(false);
      wear(s, 4);
      const active = s.activeThresholds();
      eq(active.length, 1, '非叠加模式只应激活一档');
      eq(active[0].count, 4);
      eq(s.summary()['atk.mul'], 1.25, '是 1.25，不是 1.1×1.25');
    });

    test('⚠️ 叠加模式：4 件生效 2 件档 + 4 件档', () => {
      const s = makeSystem(true);
      wear(s, 4);
      const active = s.activeThresholds();
      eq(active.length, 2, '叠加模式应激活两档');
      eq(active.map((a) => a.count).join(','), '2,4');
      // mul 相乘：1.1 × 1.25 = 1.375
      near(s.summary()['atk.mul'], 1.375, 1e-9);
    });

    test('⚠️ 同槽位装备会被替换（而不是共存）', () => {
      const s = makeSystem();
      s.equip({ id: 'flame_head', set: 'flame', slot: 'head' });
      const old = s.equip({ id: 'plain_head', slot: 'head' });   // 不属于任何套装
      eq(old?.id, 'flame_head', '应返回被替换的旧装备');
      eq(s.equipped.length, 1, '同槽位不该共存两件');
      eq(s.countFor('flame'), 0, '换上非套装装备后计数应归零');
    });

    test('⚠️ 卸下后效果正确回退（档位跟着件数走）', () => {
      const s = makeSystem();
      wear(s, 4);
      eq(s.activeThresholds().length, 1);
      eq(s.activeThresholds()[0].count, 4);

      // 4 件 → 3 件：4 件档失效，但 3 ≥ 2，所以 2 件档生效
      s.unequip('legs');
      eq(s.countFor('flame'), 3);
      eq(s.activeThresholds().length, 1, '3 件时 2 件档应生效');
      eq(s.activeThresholds()[0].count, 2, '档位应回退到 2 件档');

      // 3 件 → 1 件：低于最低档，无效果
      s.unequip('hands');
      s.unequip('chest');
      eq(s.countFor('flame'), 1);
      eq(s.activeThresholds().length, 0, '1 件不该有任何效果');
      eq(Object.keys(s.summary()).length, 0);
    });

    test('unequipById 按 id 卸下', () => {
      const s = makeSystem();
      wear(s, 2);
      eq(s.unequipById('flame_head')?.id, 'flame_head');
      eq(s.countFor('flame'), 1);
      eq(s.unequipById('不存在'), undefined);
    });

    test('不属于任何套装的装备不影响计数', () => {
      const s = makeSystem();
      wear(s, 2);
      s.equip({ id: 'plain_sword', slot: 'weapon' });   // 没有 set
      eq(s.countFor('flame'), 2, '无套装装备不该计入');
    });

    test('countDistinctIds：同名装备只算 1 件', () => {
      const s = makeSystem();
      s.equip({ id: 'twin_blade', set: 'flame', slot: 'weapon_main' });
      s.equip({ id: 'twin_blade', set: 'flame', slot: 'weapon_off' });
      eq(s.countFor('flame'), 2, '按件数算 2 件');
      eq(s.countDistinctIds('flame'), 1, '按不同 id 算 1 件');
    });

    test('⚠️ effects 返回原始列表（不预先合并）', () => {
      /**
       * 属性系统对 add/mul 的合并顺序有讲究
       * （通常是 (base+Σadd)×(1+Σmul)），
       * 在这里算死会和属性系统打架。
       */
      const s = makeSystem(true);
      wear(s, 4);
      const effs = s.effects();
      assert(effs.length >= 3, '应返回全部原始效果（2 件档 1 条 + 4 件档 2 条）');
      assert(effs.some((e) => e.op === 'add'), '应保留 add 类型');
      assert(effs.some((e) => e.op === 'mul'), '应保留 mul 类型');
    });

    test('progressOf 给出下一档差距', () => {
      const s = makeSystem();
      wear(s, 2);
      const p = s.progressOf('flame')!;
      eq(p.equipped, 2);
      eq(p.required, 4, '最高档是 4 件');
      eq(p.toNext, 2, '还差 2 件到 4 件档');
      eq(p.nextThreshold, 4);
      eq(p.activeThresholds.join(','), '2');

      wear(s, 4);
      const p2 = s.progressOf('flame')!;
      eq(p2.toNext, null, '满档后没有下一档');
      eq(p2.nextThreshold, null);
    });

    test('progressOf 未知套装返回 null', () => {
      const s = makeSystem();
      eq(s.progressOf('不存在的'), null);
    });

    test('⚠️ 构造时校验：档位必须递增', () => {
      throws(() => new SetBonusSystem({
        sets: [{
          id: 'bad', name: '错序',
          thresholds: [
            { count: 4, effects: [{ stat: 'a', op: 'add', value: 1 }] },
            { count: 2, effects: [{ stat: 'a', op: 'add', value: 1 }] },
          ],
        }],
      }), '递增');
    });

    test('⚠️ 构造时校验：档位不能重复', () => {
      throws(() => new SetBonusSystem({
        sets: [{
          id: 'bad', name: '重复',
          thresholds: [
            { count: 2, effects: [{ stat: 'a', op: 'add', value: 1 }] },
            { count: 2, effects: [{ stat: 'a', op: 'add', value: 1 }] },
          ],
        }],
      }), '递增');
    });

    test('构造时校验：空档位与空效果', () => {
      throws(() => new SetBonusSystem({
        sets: [{ id: 'x', name: 'x', thresholds: [] }],
      }), '没有任何档位');

      throws(() => new SetBonusSystem({
        sets: [{ id: 'x', name: 'x', thresholds: [{ count: 2, effects: [] }] }],
      }), '没有任何效果');
    });

    test('⚠️ 装备引用未定义套装 → 抛错', () => {
      const s = makeSystem();
      throws(() => s.equip({ id: 'x', set: '未定义', slot: 'head' }), '未定义的套装');
    });

    test('重复套装 id 抛错', () => {
      throws(() => new SetBonusSystem({ sets: [flameSet, flameSet] }), '重复');
    });

    test('clear 清空后无效果', () => {
      const s = makeSystem();
      wear(s, 4);
      s.clear();
      eq(s.equipped.length, 0);
      eq(s.activeThresholds().length, 0);
    });

    test('onChange 在装备变化时触发', () => {
      let calls = 0;
      const s = new SetBonusSystem({ sets: [flameSet], onChange: () => { calls++; } });
      s.equip({ id: 'a', set: 'flame', slot: 'head' });
      s.equip({ id: 'b', set: 'flame', slot: 'chest' });   // 触发激活
      s.unequip('head');
      s.clear();
      eq(calls, 4, '每次装备变动都应通知');
    });

    test('describe 输出可读进度', () => {
      const s = makeSystem();
      wear(s, 2);
      const d = s.describe();
      assert(d.includes('烈焰'), '应含套装名');
      assert(d.includes('2/4'), '应显示进度');
      assert(d.includes('已激活'), '应显示激活状态');
    });

    test('多套装共存', () => {
      const s = new SetBonusSystem({
        sets: [
          flameSet,
          { id: 'ice', name: '寒冰', thresholds: [{ count: 2, effects: [{ stat: 'def', op: 'add', value: 10 }] }] },
        ],
      });
      s.equip({ id: 'fh', set: 'flame', slot: 'head' });
      s.equip({ id: 'fc', set: 'flame', slot: 'chest' });
      s.equip({ id: 'ih', set: 'ice', slot: 'ring1' });
      s.equip({ id: 'ir', set: 'ice', slot: 'ring2' });
      eq(s.activeThresholds().length, 2, '两个套装都该激活');
      eq(s.summary()['def.add'], 10);
      eq(s.allProgress().length, 2);
    });
  });

  // ============================================================
  describe('DailyChallenge · 每日挑战', () => {
    // ============================================================

    const MODS = [
      { id: 'fast', name: '迅捷', desc: '敌人移速+20%', effects: [{ stat: 'speed', op: 'mul' as const, value: 1.2 }], weight: 1 },
      { id: 'tough', name: '坚韧', desc: '敌人血量+30%', effects: [{ stat: 'hp', op: 'mul' as const, value: 1.3 }], weight: 1 },
      { id: 'fragile', name: '脆弱', desc: '玩家受伤+50%', effects: [{ stat: 'dmgTaken', op: 'mul' as const, value: 1.5 }], weight: 1 },
      { id: 'rich', name: '富饶', desc: '金币掉落翻倍', effects: [{ stat: 'gold', op: 'mul' as const, value: 2 }], weight: 1 },
    ];

    function makeDaily(opts = {}) {
      return new DailyChallenge({ modifiers: MODS, modifierCount: 2, ...opts });
    }

    test('⚠️ 同一天得到完全相同的挑战', () => {
      const d = makeDaily();
      const a = d.entryFor('2024-01-01');
      const b = d.entryFor('2024-01-01');
      eq(a.seed, b.seed);
      eq(a.modifiers.map((m) => m.id).join(','), b.modifiers.map((m) => m.id).join(','));
    });

    test('⚠️ 相邻日期的种子要彻底发散（雪崩）', () => {
      /**
       * 直接把 20240101 当种子，相邻两天只差 1，
       * PRNG 输出高度相关 → "连续几天关卡几乎一样"。
       */
      const s1 = hashDateKey('2024-01-01');
      const s2 = hashDateKey('2024-01-02');
      const diff = Math.abs(s1 - s2);
      assert(diff > 1000000, `相邻日期种子应彻底发散，实际相差 ${diff}`);
      // 且高位也要变（只变低位的话 PRNG 前几次输出仍相似）
      assert((s1 >>> 24) !== (s2 >>> 24) || (s1 >>> 16 & 0xff) !== (s2 >>> 16 & 0xff),
        '高位也应变化');
    });

    test('⚠️ 相邻日期的 modifier 组合应经常不同', () => {
      const d = makeDaily();
      let same = 0;
      const N = 30;
      for (let i = 1; i <= N; i++) {
        const a = d.entryFor(`2024-01-${String(i).padStart(2, '0')}`);
        const b = d.entryFor(`2024-01-${String(i + 1).padStart(2, '0')}`);
        if (a.modifiers.map((m) => m.id).sort().join() === b.modifiers.map((m) => m.id).sort().join()) same++;
      }
      assert(same < N * 0.5, `连续两天抽到相同 modifier 组合太频繁：${same}/${N}`);
    });

    test('modifier 数量正确且不重复', () => {
      const d = makeDaily();
      for (let i = 1; i <= 50; i++) {
        const e = d.entryFor(`2024-03-${String(i % 28 + 1).padStart(2, '0')}`);
        eq(e.modifiers.length, 2);
        eq(new Set(e.modifiers.map((m) => m.id)).size, 2, '同一天不该抽到重复 modifier');
      }
    });

    test('⚠️ 时区：UTC 模式用 UTC 日期', () => {
      // 2024-01-01 00:30 UTC = 东八区 08:30
      const ms = Date.UTC(2024, 0, 1, 0, 30);
      eq(dateKeyOf(ms, 'utc'), '2024-01-01');
      eq(dateKeyOf(ms, 8), '2024-01-01', '东八区此时也是 1 号');

      // 2024-01-01 23:30 UTC = 东八区次日 07:30
      const ms2 = Date.UTC(2024, 0, 1, 23, 30);
      eq(dateKeyOf(ms2, 'utc'), '2024-01-01');
      eq(dateKeyOf(ms2, 8), '2024-01-02', '东八区已进入次日');
    });

    test('⚠️ 时区偏移为负（西半球）', () => {
      const ms = Date.UTC(2024, 0, 1, 2, 0);
      eq(dateKeyOf(ms, -5), '2023-12-31', '西五区此时还是去年最后一天');
    });

    test('⚠️ 分享文本可回填（这是社交功能的根基）', () => {
      const d = makeDaily();
      const entry = d.entryFor('2024-05-20');
      const back = d.fromText(entry.seedText);

      assert(back !== null, '文本应能被接受');
      eq(back!.seed, entry.seed, '【关键】回填后的种子必须与原种子一致');
      eq(back!.modifiers.map((m) => m.id).join(','),
         entry.modifiers.map((m) => m.id).join(','), 'modifier 也必须一致');
    });

    test('isValidSeedText 校验格式', () => {
      assert(isValidSeedText('IRON-WOLF-42'));
      assert(isValidSeedText('iron-wolf-42'), '应大小写不敏感');
      assert(!isValidSeedText('BANANA-WOLF-42'), '未知词应拒绝');
      assert(!isValidSeedText('IRON-WOLF'), '缺少数字段');
      assert(!isValidSeedText('IRON-WOLF-4'), '数字必须是两位');
    });

    test('fromText 拒绝非法文本', () => {
      const d = makeDaily();
      eq(d.fromText('乱七八糟'), null);
      eq(d.fromText(''), null);
    });

    test('seedToText 稳定', () => {
      eq(seedToText(12345), seedToText(12345));
      assert(seedToText(1) !== seedToText(2), '不同种子应有不同文本');
    });

    test('⚠️ 成绩绑定到开始日期（跨日提交）', () => {
      const d = makeDaily();
      // 玩家 23:59 开始，00:01 提交
      const startMs = Date.UTC(2024, 0, 1, 23, 59);
      const startDate = d.todayKey(startMs);
      const submitMs = Date.UTC(2024, 0, 2, 0, 1);

      d.submit(startDate, 1000, true, submitMs);
      eq(d.recordOf(startDate)?.score, 1000, '成绩应记在开始那天');
      eq(d.recordOf(d.todayKey(submitMs)), undefined, '不该记到提交那天');
    });

    test('⚠️ recordMode=first：后续成绩不覆盖', () => {
      const d = makeDaily({ recordMode: 'first' });
      eq(d.submit('2024-01-01', 100, true), true);
      eq(d.submit('2024-01-01', 9999, true), false, 'first 模式下第二次不记录');
      eq(d.recordOf('2024-01-01')?.score, 100);
      eq(d.attemptsOn('2024-01-01'), 2, '尝试次数仍要累加');
    });

    test('recordMode=best：只保留最高分', () => {
      const d = makeDaily({ recordMode: 'best' });
      d.submit('2024-01-01', 100, true);
      d.submit('2024-01-01', 300, true);
      eq(d.submit('2024-01-01', 200, true), false, '低分不覆盖');
      eq(d.recordOf('2024-01-01')?.score, 300);
    });

    test('hasPlayedToday', () => {
      const d = makeDaily();
      const now = Date.UTC(2024, 5, 10, 12, 0);
      eq(d.hasPlayedToday(now), false);
      d.submit(d.todayKey(now), 1, true, now);
      eq(d.hasPlayedToday(now), true);
    });

    test('⚠️ 连续打卡天数', () => {
      const d = makeDaily();
      const base = Date.UTC(2024, 5, 10, 12, 0);
      eq(d.streak(base), 0, '没打过应是 0');

      d.submit(d.todayKey(base), 1, true, base);                       // 今天
      d.submit(d.todayKey(base - 86400000), 1, true, base - 86400000); // 昨天
      d.submit(d.todayKey(base - 172800000), 1, true, base - 172800000); // 前天
      eq(d.streak(base), 3, '连续三天');

      // 中断一天
      const d2 = makeDaily();
      d2.submit(d2.todayKey(base), 1, true, base);
      d2.submit(d2.todayKey(base - 172800000), 1, true, base - 172800000);
      eq(d2.streak(base), 1, '中间断了一天，只算 1');
    });

    test('history 按日期降序', () => {
      const d = makeDaily();
      d.submit('2024-01-01', 1, false);
      d.submit('2024-03-01', 2, true);
      d.submit('2024-02-01', 3, true);
      const h = d.history();
      eq(h.map((r) => r.date).join(','), '2024-03-01,2024-02-01,2024-01-01');
      eq(d.clearedCount, 2);
    });

    test('⚠️ modifierCount 超过池子大小 → 构造时报错', () => {
      throws(() => new DailyChallenge({ modifiers: MODS, modifierCount: 10 }), '超过');
    });

    test('没有 modifier 时也能工作', () => {
      const d = new DailyChallenge({ modifierCount: 0 });
      const e = d.entryFor('2024-01-01');
      eq(e.modifiers.length, 0);
    });

    test('存档往返', () => {
      const a = makeDaily();
      a.submit('2024-01-01', 500, true);
      a.submit('2024-01-02', 700, false);
      const state = a.exportState();

      const b = makeDaily();
      b.importState(state);
      eq(b.recordOf('2024-01-01')?.score, 500);
      eq(b.recordOf('2024-01-02')?.score, 700);
      eq(b.attemptsOn('2024-01-01'), 1);
    });
  });

  // ============================================================
  describe('Leaderboard · 排行榜', () => {
    // ============================================================

    function entry(id: string, score: number, at = 0): ScoreEntry {
      return { playerId: id, name: `P_${id}`, score, at };
    }

    test('基本排序（降序）', () => {
      const lb = new Leaderboard();
      lb.submitAll([entry('a', 100), entry('c', 300), entry('b', 200)]);
      const r = lb.ranked();
      eq(r.map((e) => e.playerId).join(','), 'c,b,a');
      eq(r[0].rank, 1);
    });

    test('升序模式（用时榜）', () => {
      const lb = new Leaderboard({ order: 'asc' });
      lb.submitAll([entry('a', 100), entry('b', 50), entry('c', 75)]);
      eq(lb.ranked().map((e) => e.playerId).join(','), 'b,c,a');
    });

    test('⚠️ 密集排名：100,100,90 → 1,1,2', () => {
      const lb = new Leaderboard({ rankMode: 'dense' });
      lb.submitAll([entry('a', 100, 1), entry('b', 100, 2), entry('c', 90, 3)]);
      const r = lb.ranked();
      eq(r.map((e) => e.rank).join(','), '1,1,2');
    });

    test('⚠️ 竞赛排名：100,100,90 → 1,1,3', () => {
      const lb = new Leaderboard({ rankMode: 'competition' });
      lb.submitAll([entry('a', 100, 1), entry('b', 100, 2), entry('c', 90, 3)]);
      eq(lb.ranked().map((e) => e.rank).join(','), '1,1,3');
    });

    test('普通排名：100,100,90 → 1,2,3', () => {
      const lb = new Leaderboard({ rankMode: 'ordinal' });
      lb.submitAll([entry('a', 100, 1), entry('b', 100, 2), entry('c', 90, 3)]);
      eq(lb.ranked().map((e) => e.rank).join(','), '1,2,3');
    });

    test('⚠️ 同分时先达成的在前', () => {
      const lb = new Leaderboard({ tieBreak: 'earlier' });
      lb.submitAll([entry('late', 100, 200), entry('early', 100, 100)]);
      eq(lb.ranked()[0].playerId, 'early');
    });

    test('tieBreak=later 时后达成的在前', () => {
      const lb = new Leaderboard({ tieBreak: 'later' });
      lb.submitAll([entry('late', 100, 200), entry('early', 100, 100)]);
      eq(lb.ranked()[0].playerId, 'late');
    });

    test('⚠️ 只保留每位玩家的最好成绩', () => {
      const lb = new Leaderboard();
      lb.submit(entry('a', 100));
      lb.submit(entry('a', 300));
      eq(lb.size, 1, '同一个人只该占一个位置');
      eq(lb.ranked()[0].score, 300);
    });

    test('⚠️ 低分不覆盖自己的高分', () => {
      const lb = new Leaderboard();
      lb.submit(entry('a', 300));
      eq(lb.submit(entry('a', 100)), false);
      eq(lb.ranked()[0].score, 300);
    });

    test('bestPerPlayer=false 时允许占位多次', () => {
      const lb = new Leaderboard({ bestPerPlayer: false });
      lb.submit(entry('a', 300));
      lb.submit(entry('a', 100));
      eq(lb.size, 2, '关闭后同一个人可占多个位置');
    });

    test('⚠️ 容量上限：超出后淘汰末位', () => {
      const lb = new Leaderboard({ capacity: 3 });
      lb.submitAll([entry('a', 100), entry('b', 200), entry('c', 300), entry('d', 400)]);
      eq(lb.size, 3);
      eq(lb.ranked().map((e) => e.playerId).join(','), 'd,c,b');
      eq(lb.rankOf('a'), null, '最低分应被淘汰');
    });

    test('⚠️ 分数排不进榜时返回 false', () => {
      const lb = new Leaderboard({ capacity: 2 });
      lb.submitAll([entry('a', 500), entry('b', 600)]);
      eq(lb.submit(entry('c', 100)), false, '低分不该入榜');
      eq(lb.size, 2);
    });

    test('⚠️ 分页：名次在分页前计算', () => {
      const lb = new Leaderboard();
      for (let i = 1; i <= 10; i++) lb.submit(entry(`p${i}`, i * 10));

      const p2 = lb.page(2, 3);
      eq(p2.entries.length, 3);
      eq(p2.entries[0].rank, 4, '第 2 页第一名应是总第 4 名，不是 1');
      eq(p2.total, 10);
      eq(p2.pageCount, 4);
      eq(p2.hasPrev, true);
      eq(p2.hasNext, true);
    });

    test('分页边界：超出范围被夹紧', () => {
      const lb = new Leaderboard();
      lb.submit(entry('a', 1));
      const p = lb.page(99, 5);
      eq(p.page, 1, '超出页数应夹到最后一页');
      eq(lb.page(0, 5).page, 1, '页数从 1 开始');
    });

    test('空榜分页不崩', () => {
      const lb = new Leaderboard();
      const p = lb.page(1, 10);
      eq(p.entries.length, 0);
      eq(p.pageCount, 1, '空榜也有 1 页');
      eq(p.hasNext, false);
    });

    test('⚠️ rankOf 查找玩家', () => {
      const lb = new Leaderboard();
      lb.submitAll([entry('a', 100), entry('b', 200)]);
      eq(lb.rankOf('b')?.rank, 1);
      eq(lb.rankOf('a')?.rank, 2);
      eq(lb.rankOf('不存在'), null);
    });

    test('⚠️ around 取附近的玩家', () => {
      const lb = new Leaderboard();
      for (let i = 1; i <= 20; i++) lb.submit(entry(`p${i}`, i * 10));

      const around = lb.around('p10', 2);   // p10 排第 11（分数 100）
      eq(around.length, 5, '前后各 2 个 + 自己');
      eq(around[2].playerId, 'p10', '中间是自己');
    });

    test('around 在榜单边缘不会越界', () => {
      const lb = new Leaderboard();
      lb.submitAll([entry('a', 100), entry('b', 90)]);
      eq(lb.around('a', 5).length, 2, '第一名附近只有 2 条');
      eq(lb.around('不存在', 5).length, 0);
    });

    test('top(n)', () => {
      const lb = new Leaderboard();
      for (let i = 1; i <= 5; i++) lb.submit(entry(`p${i}`, i * 10));
      eq(lb.top(3).map((e) => e.playerId).join(','), 'p5,p4,p3');
      eq(lb.top(100).length, 5, '超出总数时返回全部');
    });

    test('⚠️ 快照冻结名次', () => {
      const lb = new Leaderboard();
      lb.submit(entry('a', 100));
      const snap = lb.snapshot();
      eq(snap.length, 1);
      eq(snap[0].rank, 1);

      // 之后有人超过他
      lb.submit(entry('b', 999));
      eq(snap[0].rank, 1, '快照不该变化');
      eq(lb.rankOf('a')!.rank, 2, '实时榜已变化');
    });

    test('remove 与 clear', () => {
      const lb = new Leaderboard();
      lb.submitAll([entry('a', 1), entry('b', 2)]);
      eq(lb.remove('a'), true);
      eq(lb.remove('a'), false);
      eq(lb.size, 1);
      lb.clear();
      eq(lb.size, 0);
    });

    test('⚠️ 分数必须是有限数', () => {
      const lb = new Leaderboard();
      throws(() => lb.submit(entry('a', NaN)), '有限');
      throws(() => lb.submit(entry('a', Infinity)), '有限');
    });

    test('导入导出', () => {
      const a = new Leaderboard();
      a.submitAll([entry('x', 10), entry('y', 20)]);
      const data = a.exportEntries();

      const b = new Leaderboard();
      b.importEntries(data);
      eq(b.size, 2);
      eq(b.ranked()[0].playerId, 'y');
    });

    test('⚠️ importEntries 会清空现有数据', () => {
      const lb = new Leaderboard();
      lb.submit(entry('old', 999));
      lb.importEntries([entry('new', 1)]);
      eq(lb.size, 1);
      eq(lb.rankOf('old'), null, '导入是覆盖，不是合并');
    });

    test('⚠️ mergeLeaderboards 按玩家去重', () => {
      const a = new Leaderboard();
      a.submit(entry('p1', 100));
      const b = new Leaderboard();
      b.submit(entry('p1', 300));      // 同一个玩家，更高分
      b.submit(entry('p2', 200));

      const merged = mergeLeaderboards([a, b]);
      eq(merged.size, 2, 'p1 只该占一个位置');
      eq(merged.rankOf('p1')!.score, 300, '应取较高分');
    });

    test('mergeLeaderboards 升序模式取较小值', () => {
      const a = new Leaderboard({ order: 'asc' });
      a.submit(entry('p1', 100));
      const b = new Leaderboard({ order: 'asc' });
      b.submit(entry('p1', 50));
      const merged = mergeLeaderboards([a, b], { order: 'asc' });
      eq(merged.rankOf('p1')!.score, 50, '用时榜应取较短时间');
    });

    test('describe 输出可读榜单', () => {
      const lb = new Leaderboard();
      lb.submitAll([entry('a', 100), entry('b', 200)]);
      const d = lb.describe();
      assert(d.includes('Leaderboard'), '应有标题');
      assert(d.includes('200'), '应含分数');
    });
  });
}
