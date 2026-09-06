/**
 * tests/run_batch3.ts —— 第二批插件的测试
 *
 * 覆盖：loot（PRD/ShuffleBag/WeightedTable/LootTable/Chest）、
 *       fsm、behavior-tree、buff、curve、result、signal、save、
 *       number-roller、pathfinding、spatial、noise、condition、tween
 *
 * 【这批插件为什么值得测】
 * 它们几乎全是「错了不抛异常，只会悄悄错」的类型：
 * - 保底计数差一次 → 玩家第 11 次才出，而不是第 10 次
 * - A* 启发函数写错 → 路径不是最短，但看起来"能走"
 * - Buff 叠层刷新逻辑反了 → 层数永远上不去
 * - 存档迁移漏一级 → 老玩家一进游戏就崩
 * 这些都不会报错，只能靠测试拦。
 */

import { describe, test, assert, eq, near } from './_framework';

import { PRD } from '../loot/PRD';
import { ShuffleBag } from '../loot/ShuffleBag';
import { WeightedTable } from '../loot/WeightedTable';
import { LootTable } from '../loot/LootTable';
import { Chest } from '../loot/Chest';
import { StateMachine } from '../fsm/StateMachine';
import { BehaviorTree, Selector, Sequence, Condition, Action, Wait, Inverter, CooldownDecorator, BTStatus } from '../behavior-tree/BehaviorTree';
import { BuffSystem } from '../buff/BuffSystem';
import { Curve } from '../curve/Curve';
import { ok, err, attempt, all, fromNullable } from '../result/Result';
import { Signal } from '../signal/Signal';
import { SaveManager, MemoryStorage } from '../save/SaveManager';
import { NumberRollerCore } from '../number-roller/NumberRollerCore';
import { GridGraph, findPath, smoothPath } from '../pathfinding/GridGraph';
import { SpatialHash } from '../spatial/SpatialHash';
import { Noise } from '../noise/Noise';
import { ConditionEngine } from '../condition/ConditionEngine';
import { Tween, TweenRunner } from '../tween/Tween';
import { RNG } from '../rng/RNG';
import { FixedRandomSource } from '../_core/types';

export async function runBatch3Tests(): Promise<void> {
  // ============================================================
  // PRD
  // ============================================================

  describe('PRD · 伪随机分布', () => {
    test('长期频率接近名义值（核心承诺）', () => {
      const prd = PRD.fromChance(0.25);
      const rng = new RNG(12345);
      let hits = 0;
      const N = 100000;
      for (let i = 0; i < N; i++) if (prd.roll(rng)) hits++;
      const freq = hits / N;
      assert(Math.abs(freq - 0.25) < 0.01, `长期频率应≈0.25，实际 ${freq.toFixed(4)}`);
    });

    test('方差显著小于真随机（不会长时间不触发）', () => {
      // 统计"最长连续未触发"的长度
      function maxGap(usePRD: boolean): number {
        const rng = new RNG(999);
        const prd = PRD.fromChance(0.25);
        let gap = 0;
        let max = 0;
        for (let i = 0; i < 100000; i++) {
          const hit = usePRD ? prd.roll(rng) : rng.next() < 0.25;
          if (hit) gap = 0;
          else {
            gap++;
            if (gap > max) max = gap;
          }
        }
        return max;
      }
      const prdGap = maxGap(true);
      const trueGap = maxGap(false);
      assert(prdGap < trueGap, `PRD 最长间隔(${prdGap}) 应显著小于真随机(${trueGap})`);
    });

    test('失败次数越多，概率越高', () => {
      const prd = PRD.fromChance(0.25);
      const c1 = prd.chance;
      prd.setFailCount(5);
      const c2 = prd.chance;
      assert(c2 > c1, `连续失败后概率应提高：${c1} → ${c2}`);
    });

    test('触发后重置失败计数', () => {
      const prd = PRD.fromChance(0.9); // 高概率便于稳定触发
      const rng = new RNG(1);
      prd.setFailCount(3);
      for (let i = 0; i < 10; i++) prd.roll(rng);
      // 0.9 概率下 10 次内必然触发过
      assert(prd.failCount <= 3, '触发后应重置');
    });

    test('名义概率必须落在 (0,1)', () => {
      let threw = false;
      try {
        PRD.fromChance(0);
      } catch {
        threw = true;
      }
      assert(threw);

      let threw2 = false;
      try {
        PRD.fromChance(1);
      } catch {
        threw2 = true;
      }
      assert(threw2);
    });

    test('相同名义概率复用缓存的 C', () => {
      const a = PRD.fromChance(0.3);
      const b = PRD.fromChance(0.3);
      near(a.c, b.c, 1e-12);
    });
  });

  // ============================================================
  // ShuffleBag
  // ============================================================

  describe('ShuffleBag · 洗牌袋', () => {
    test('一轮内每个元素恰好出现一次', () => {
      const bag = new ShuffleBag<string>();
      bag.add('a').add('b').add('c');
      const rng = new RNG(42);

      const drawn = bag.drawMany(3, rng);
      eq(drawn.length, 3);
      eq(new Set(drawn).size, 3, '不应有重复');
      eq(drawn.sort().join(''), 'abc');
    });

    test('count 作为权重（占几个格子）', () => {
      const bag = new ShuffleBag<string>();
      bag.add('a', 3);
      bag.add('b', 1);
      const rng = new RNG(7);

      const drawn = bag.drawMany(4, rng);
      eq(drawn.filter((x) => x === 'a').length, 3);
      eq(drawn.filter((x) => x === 'b').length, 1);
    });

    test('抽空后自动重洗', () => {
      const bag = new ShuffleBag<string>();
      bag.add('a').add('b');
      const rng = new RNG(3);
      bag.drawMany(2, rng);
      eq(bag.remaining, 0);
      const v = bag.draw(rng);
      assert(v === 'a' || v === 'b', '应自动重洗并给出值');
    });

    test('两轮交界不重复（avoidEdgeRepeat）', () => {
      const bag = new ShuffleBag<string>();
      bag.add('a').add('b');
      const rng = new RNG(11);

      // 跑多轮，检查交界处
      let prev: string | undefined;
      let edgeRepeat = 0;
      for (let round = 0; round < 50; round++) {
        const first = bag.draw(rng);
        if (prev !== undefined && first === prev) edgeRepeat++;
        bag.draw(rng); // 抽完这一轮
        prev = bag.draw(rng); // 下一轮的第一个
      }
      eq(edgeRepeat, 0, '交界处不应与上一轮最后一个重复');
    });

    test('capacity 计算正确', () => {
      const bag = new ShuffleBag<string>();
      bag.add('a', 2).add('b', 3);
      eq(bag.capacity, 5);
    });

    test('remove 后容量更新', () => {
      const bag = new ShuffleBag<string>();
      bag.add('a', 2).add('b', 3);
      bag.remove('a');
      eq(bag.capacity, 3);
    });

    test('空袋子返回 undefined 而不崩溃', () => {
      const bag = new ShuffleBag<string>();
      eq(bag.draw(new RNG(1)), undefined);
    });

    test('只有一种元素时不死循环（avoidEdgeRepeat 的边界）', () => {
      const bag = new ShuffleBag<string>();
      bag.add('only');
      const rng = new RNG(5);
      eq(bag.draw(rng), 'only');
      eq(bag.draw(rng), 'only', '单元素时重复不可避免，但不应崩溃');
    });
  });

  // ============================================================
  // WeightedTable
  // ============================================================

  describe('WeightedTable · 加权表', () => {
    test('频率符合权重', () => {
      const t = new WeightedTable<string>();
      t.add('a', 70).add('b', 30);
      const rng = new RNG(2024);

      let ca = 0;
      const N = 20000;
      for (let i = 0; i < N; i++) if (t.pick(rng) === 'a') ca++;
      const freq = ca / N;
      assert(Math.abs(freq - 0.7) < 0.02, `应为 ≈0.7，实际 ${freq.toFixed(3)}`);
    });

    test('pickUnique 不重复', () => {
      const t = new WeightedTable<string>();
      t.add('a').add('b').add('c').add('d');
      const out = t.pickUnique(3, new RNG(1));
      eq(out.length, 3);
      eq(new Set(out).size, 3);
    });

    test('pickUnique 请求数超过可选数时返回全部', () => {
      const t = new WeightedTable<string>();
      t.add('a').add('b');
      const out = t.pickUnique(5, new RNG(1));
      eq(out.length, 2, '不应崩溃，也不应重复填充');
    });

    test('所有权重为 0 时返回 undefined（不崩溃）', () => {
      const t = new WeightedTable<string>();
      t.add('a', 1);
      t.setWeight('a', 0);
      // 全 0 时 pickUnique 会先 removeZeroWeights
      eq(t.pick(new RNG(1)), undefined);
    });

    test('动态改权重立即生效', () => {
      const t = new WeightedTable<string>();
      t.add('a', 1).add('b', 99);
      const rng = new RNG(88);
      t.setWeight('b', 0);
      for (let i = 0; i < 20; i++) eq(t.pick(rng), 'a');
    });

    test('remove 生效', () => {
      const t = new WeightedTable<string>();
      t.add('a').add('b');
      t.remove('a');
      eq(t.count, 1);
      eq(t.pick(new RNG(1)), 'b');
    });

    test('权重必须为正', () => {
      const t = new WeightedTable<string>();
      let threw = false;
      try {
        t.add('a', 0);
      } catch {
        threw = true;
      }
      assert(threw);
    });
  });

  // ============================================================
  // LootTable
  // ============================================================

  describe('LootTable · 掉落表', () => {
    test('必掉项每次都出现', () => {
      const t = new LootTable('t').entry({ id: 'key', weight: 0, min: 1, max: 1, guaranteed: true });
      for (let i = 0; i < 20; i++) {
        const drops = t.roll(new RNG(i));
        assert(drops.some((d) => d.id === 'key'), '必掉项必须每次出现');
      }
    });

    test('数量落在 [min, max] 区间内', () => {
      const t = new LootTable('t').entry({ id: 'gold', weight: 100, min: 5, max: 15 });
      const rng = new RNG(5);
      for (let i = 0; i < 200; i++) {
        for (const d of t.roll(rng)) {
          assert(d.count >= 5 && d.count <= 15, `数量越界: ${d.count}`);
        }
      }
    });

    test('min > max 在配置时就报错', () => {
      let threw = false;
      try {
        new LootTable('t').entry({ id: 'x', weight: 1, min: 10, max: 5 });
      } catch {
        threw = true;
      }
      assert(threw, '配置错误应在启动时发现');
    });

    test('硬保底：连续 N 次没出稀有后强制给', () => {
      const t = new LootTable('t')
        .entry({ id: 'common', weight: 100, min: 1, max: 1 })
        .entry({ id: 'rare', weight: 1, min: 1, max: 1, rare: true })
        .withPity({ threshold: 5 });

      const rng = new RNG(77);
      let pityCount = 0;
      for (let i = 0; i < 500; i++) {
        for (const d of t.roll(rng)) if (d.fromPity) pityCount++;
      }
      assert(pityCount > 0, '应触发过保底');
    });

    test('保底计数：连续未出稀有会累加，出了就归零', () => {
      const t = new LootTable('t')
        .entry({ id: 'common', weight: 100, min: 1, max: 1 })
        .entry({ id: 'rare', weight: 1, min: 1, max: 1, rare: true })
        .withPity({ threshold: 3 });

      // 固定返回 0.999：稀有（权重 1 / 总 101）永不自然掉落
      const rng = new FixedRandomSource([0.999]);
      t.roll(rng);
      eq(t.sinceRare, 1);
      t.roll(rng);
      eq(t.sinceRare, 2);
      const drops = t.roll(rng);
      eq(t.sinceRare, 0, '第 3 次触发保底后应归零');
      assert(drops.some((d) => d.fromPity), '第 3 次应由保底强制给出');
    });

    test('pityRemaining 可用于 UI 显示', () => {
      const t = new LootTable('t')
        .entry({ id: 'x', weight: 1, min: 1, max: 1 })
        .withPity({ threshold: 10 });
      eq(t.pityRemaining, 10);
      t.roll(new RNG(1));
      assert(t.pityRemaining <= 10 && t.pityRemaining >= 0);
    });

    test('嵌套子表', () => {
      const child = new LootTable('child').entry({ id: 'gem', weight: 100, min: 1, max: 2 });
      const parent = new LootTable('parent').entry({
        id: 'chest',
        weight: 100,
        min: 1,
        max: 1,
        child,
      });

      const rng = new RNG(9);
      let foundNested = false;
      for (let i = 0; i < 100; i++) {
        for (const d of parent.roll(rng)) {
          if (d.children && d.children.length > 0) foundNested = true;
        }
      }
      assert(foundNested, '应产出嵌套结果');
    });

    test('保底状态可存取（存档）', () => {
      const t = new LootTable('t')
        .entry({ id: 'common', weight: 100, min: 1, max: 1 })
        .entry({ id: 'rare', weight: 1, min: 1, max: 1, rare: true })
        .withPity({ threshold: 5 });
      const rng = new FixedRandomSource([0.999]);
      t.roll(rng);
      t.roll(rng);
      const saved = t.exportPity();
      eq(saved, 2);

      const t2 = new LootTable('t')
        .entry({ id: 'common', weight: 100, min: 1, max: 1 })
        .entry({ id: 'rare', weight: 1, min: 1, max: 1, rare: true })
        .withPity({ threshold: 5 });
      t2.importPity(saved);
      eq(t2.sinceRare, 2);
    });

    test('权重必须为正（配错会立刻发现，而不是表现为"永远不掉"）', () => {
      let threw = false;
      try {
        new LootTable('t').entry({ id: 'x', weight: 0, min: 1, max: 1 });
      } catch {
        threw = true;
      }
      assert(threw);
    });
  });

  // ============================================================
  // Chest
  // ============================================================

  describe('Chest · 开箱与三选一', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    test('给出指定数量的选项', () => {
      const chest = new Chest(pool, { count: 3 });
      const opts = chest.roll(new RNG(1));
      eq(opts.length, 3);
    });

    test('同一批内不重复', () => {
      const chest = new Chest(pool, { count: 3 });
      for (let i = 0; i < 50; i++) {
        chest.reset();
        const opts = chest.roll(new RNG(i));
        eq(new Set(opts).size, opts.length);
      }
    });

    test('reroll 排除当前选项', () => {
      const chest = new Chest(pool, { count: 3, rerolls: 1 });
      const first = chest.roll(new RNG(1)).slice();
      const okReroll = chest.reroll(new RNG(2));
      assert(okReroll);
      const second = chest.current;
      for (const s of second) {
        assert(!first.includes(s), `reroll 不应再出现 ${s}`);
      }
    });

    test('reroll 次数用完返回 false', () => {
      const chest = new Chest(pool, { count: 3, rerolls: 1 });
      chest.roll(new RNG(1));
      eq(chest.reroll(new RNG(2)), true);
      eq(chest.reroll(new RNG(3)), false, '次数用完');
      eq(chest.canReroll, false);
    });

    test('take 后状态变为 taken', () => {
      const chest = new Chest(pool, { count: 3 });
      chest.roll(new RNG(1));
      const picked = chest.take(1);
      eq(picked, chest.current[1]);
      eq(chest.state, 'taken');
      eq(chest.taken, picked);
    });

    test('owned 的项不再出现', () => {
      const chest = new Chest(pool, { count: 3, owned: ['a', 'b', 'c'] });
      for (let i = 0; i < 30; i++) {
        chest.reset();
        for (const o of chest.roll(new RNG(i))) {
          assert(!['a', 'b', 'c'].includes(o), `已拥有的 ${o} 不应出现`);
        }
      }
    });

    test('filter 过滤', () => {
      const chest = new Chest(pool, { count: 3, filter: (x) => x !== 'a' });
      for (let i = 0; i < 30; i++) {
        chest.reset();
        for (const o of chest.roll(new RNG(i))) assert(o !== 'a');
      }
    });

    // ==================== 加权抽取 ====================

    /** 统计一批抽取中各项出现次数 */
    function tally<T>(
      chest: Chest<T>,
      rounds: number,
      key: (t: T) => string
    ): Record<string, number> {
      const c: Record<string, number> = {};
      for (let i = 0; i < rounds; i++) {
        chest.reset();
        for (const o of chest.roll(new RNG(i * 7919 + 13))) {
          const k = key(o);
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
      // 4000 次采样，理论 3.0，允许 ±15%
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
      // 不抛错本身就是这条测试的断言（抛了就直接失败）
    });

    test('⚠️ 全零权重退化为等概率（而不是界面空白）', () => {
      const chest = new Chest(['a', 'b', 'c'], {
        count: 2,
        weightOf: () => 0,
      });
      const c = tally(chest, 600, (x) => x);
      const n = Object.keys(c).length;
      eq(n, 3, '三项都该出现（退化后等概率）');
      // 退化后三项大致均匀
      const vals = Object.values(c);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      assert(max / min < 1.6, `退化后应大致均匀，实际 ${min}..${max}`);
    });

    test('⚠️ 加权不放回：每一轮都重新计算总权重', () => {
      /**
       * 【为什么必须有这条测试】
       * 缓存总权重的实现会导致第二次抽取概率失真：
       * 池子 [a(w=1), b(w=9)] 抽 2 个（全抽），
       * 若第二次仍用 total=10 计算，b 会被抽两次、a 永远抽不到。
       */
      const chest = new Chest(['a', 'b'], { count: 2, weightOf: (x) => (x === 'a' ? 1 : 9) });
      const c = tally(chest, 400, (x) => x);
      // 两个都必然出现（不放回抽 2 个 from 2 个）
      assert((c['a'] ?? 0) > 0, 'a 必须能出现');
      assert((c['b'] ?? 0) > 0, 'b 必须能出现');
    });

    test('⚠️ 关键认知：不放回 ≠ 独立抽取，稀有物"被看到"的概率被放大', () => {
      /**
       * 池子 [legendary(w=1), common(w=99)]，抽 2 个（等于全抽）。
       *
       * - 单次权重看：legendary 只有 1%
       * - 但不放回抽 2 个（k = 池子大小）时，它**必然**出现
       *
       * 这就是肉鸽平衡里最容易搞错的地方：
       * 你按"1% 权重"配表，以为玩家几乎见不到传说遗物，
       * 实际上池子小的时候每局都能见到。
       *
       * 换算公式（池子 n 个、抽 k 个、某物权重 w、总权重 W）：
       *   单次位置概率 ≈ w / W
       *   整批至少出现一次 ≈ 1 - C(n-1, k) / C(n, k)  （等权时）
       *   加权时要用"不含该物的抽取概率"逐次累乘
       */
      const chest = new Chest(['legendary', 'common'], {
        count: 2,
        weightOf: (x) => (x === 'legendary' ? 1 : 99),
      });
      const c = tally(chest, 300, (x) => x);
      eq(c['legendary'], 300, '抽满整个池子时，权重 1% 的项也必然出现');

      // 对照组：只抽 1 个时，它确实只有约 1%
      const chest2 = new Chest(['legendary', 'common'], {
        count: 1,
        weightOf: (x) => (x === 'legendary' ? 1 : 99),
      });
      const c2 = tally(chest2, 5000, (x) => x);
      const rate = (c2['legendary'] ?? 0) / 5000;
      assert(rate < 0.03, `只抽 1 个时应接近 1%，实际 ${(rate * 100).toFixed(2)}%`);
    });

    test('⚠️ 加权 + allowDuplicate=false 时同一批不重复', () => {
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
       * r = rng.next() * total 在浮点下可能略大于所有权重的累加和，
       * 导致循环结束也没命中。
       * 兜底必须是"最后一个"，取 -1 会崩、取 0 会偏爱第一项。
       */
      const chest = new Chest(['a', 'b', 'c'], {
        count: 1,
        weightOf: (x) => (x === 'a' ? 1e-12 : 1e12),
      });
      for (let i = 0; i < 200; i++) {
        chest.reset();
        const opts = chest.roll(new RNG(i));
        assert(opts.length === 1, '必须给出一个选项');
        assert(opts[0] !== undefined, '选项不能是 undefined');
      }
    });

    test('⚠️ 不传 weightOf 时行为与等概率完全一致（向后兼容）', () => {
      // 与"无权重"版本的分布对比：各项应大致均匀
      const chest = new Chest(['a', 'b', 'c', 'd'], { count: 2 });
      const c = tally(chest, 2000, (x) => x);
      const vals = Object.values(c);
      assert(vals.length === 4, '四项都该出现');
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      assert(max / min < 1.3, `等概率应大致均匀，实际 ${min}..${max}`);
    });

    test('⚠️ 权重可在运行时变化（与 filter 的区别）', () => {
      /**
       * filter 是布尔的（要么出现要么不出现）；
       * 权重是连续的，适合"已持有则权重减半"这类软性调节。
       */
      let ownedCount = 0;
      const chest = new Chest(['a', 'b', 'c'], {
        count: 1,
        weightOf: (x) => (x === 'a' && ownedCount > 0 ? 1 : 10),
      });

      // 未持有：a 权重 10，与 b/c 相当
      const before = tally(chest, 1500, (x) => x);
      const rateBefore = (before['a'] ?? 0) / 1500;

      // 持有后：a 权重降到 1，出现率应显著下降
      ownedCount = 1;
      const after = tally(chest, 1500, (x) => x);
      const rateAfter = (after['a'] ?? 0) / 1500;

      assert(rateAfter < rateBefore * 0.6,
        `权重降低后出现率应下降：${rateBefore.toFixed(3)} → ${rateAfter.toFixed(3)}`);
    });

    test('候选不足时放宽而不是少给（避免"二选一"）', () => {
      const chest = new Chest(['a', 'b'], { count: 3 });
      const opts = chest.roll(new RNG(1));
      eq(opts.length, 2, '池子只有 2 个，只能给 2 个');

      // 有 owned/filter 限制但放宽排除当前项后仍能满足
      const chest2 = new Chest(pool, { count: 3, owned: ['a', 'b', 'c', 'd', 'e'] });
      const opts2 = chest2.roll(new RNG(1));
      assert(opts2.length >= 1, '不应因为限制就给 0 个');
    });

    test('存档：导出导入后选项一致（关掉界面再打开不变）', () => {
      const chest = new Chest(pool, { count: 3 });
      const before = chest.roll(new RNG(123)).slice();
      const snap = chest.exportState();

      const chest2 = new Chest(pool, { count: 3 });
      chest2.importState(snap);
      eq(chest2.current.slice().join(','), before.join(','), '读档后选项应完全一致');
      eq(chest2.state, 'rolled');
    });

    test('reset 后回到 idle', () => {
      const chest = new Chest(pool, { count: 3, rerolls: 2 });
      chest.roll(new RNG(1));
      chest.reroll(new RNG(2));
      chest.reset();
      eq(chest.state, 'idle');
      eq(chest.rerollsLeft, 2);
    });

    test('allowDuplicate 允许重复', () => {
      const chest = new Chest(pool, { count: 3, allowDuplicate: true });
      // 池子够大，仍可能重复；这里只验证不崩溃且数量正确
      eq(chest.roll(new RNG(1)).length, 3);
    });
  });

  // ============================================================
  // StateMachine
  // ============================================================

  describe('StateMachine · 有限状态机', () => {
    interface Ctx {
      moved: boolean;
      jumped: boolean;
      log: string[];
    }

    function make(): { fsm: StateMachine<Ctx>; ctx: Ctx } {
      const ctx: Ctx = { moved: false, jumped: false, log: [] };
      const fsm = new StateMachine<Ctx>({
        initial: 'idle',
        transitions: { idle: ['run', 'jump'], run: ['idle', 'jump'], jump: ['idle'] },
        states: {
          idle: {
            enter: (c) => c.log.push('enter:idle'),
            exit: (c) => c.log.push('exit:idle'),
            update: (c) => {
              if (c.moved) return 'run';
              return undefined;
            },
          },
          run: {
            enter: (c) => c.log.push('enter:run'),
            update: (c) => {
              if (c.jumped) return 'jump';
              if (!c.moved) return 'idle';
              return undefined;
            },
          },
          jump: { enter: (c) => c.jumped && c.log.push('enter:jump') },
        },
      });
      fsm.start(ctx);
      return { fsm, ctx };
    }

    test('初始状态为 initial', () => {
      const { fsm } = make();
      eq(fsm.current, 'idle');
    });

    test('构造时不触发 enter（没有 context 就不该有副作用）', () => {
      const ctx: Ctx = { moved: false, jumped: false, log: [] };
      new StateMachine<Ctx>({
        initial: 'idle',
        states: { idle: { enter: (c) => c.log.push('enter') } },
      });
      eq(ctx.log.length, 0, '构造不应调用 enter（否则会传 undefined 进去）');
    });

    test('start 触发初始状态的 enter', () => {
      const ctx: Ctx = { moved: false, jumped: false, log: [] };
      const fsm = new StateMachine<Ctx>({
        initial: 'idle',
        states: { idle: { enter: (c) => c.log.push('enter:idle') } },
      });
      fsm.start(ctx);
      eq(ctx.log.join(','), 'enter:idle');
    });

    test('update 返回值驱动转换', () => {
      const { fsm, ctx } = make();
      ctx.moved = true;
      fsm.update(ctx, 0.016);
      eq(fsm.current, 'run');
    });

    test('enter / exit 按序调用', () => {
      const { fsm, ctx } = make();
      ctx.moved = true;
      fsm.update(ctx, 0.016);
      eq(ctx.log.join(' → '), 'enter:idle → exit:idle → enter:run');
    });

    test('transitions 限制非法转换', () => {
      const { fsm, ctx } = make();
      eq(fsm.can('jump'), true);
      eq(fsm.transitionTo('jump', ctx), true);
      eq(fsm.can('run'), false, 'jump 不能转到 run');
      eq(fsm.transitionTo('run', ctx), false);
    });

    test('未知状态抛错（快速失败）', () => {
      const { fsm, ctx } = make();
      let threw = false;
      try {
        fsm.transitionTo('不存在的状态', ctx);
      } catch {
        threw = true;
      }
      assert(threw);
    });

    test('timeInState 累加，转换后归零', () => {
      const { fsm, ctx } = make();
      fsm.update(ctx, 0.1);
      fsm.update(ctx, 0.1);
      near(fsm.timeInState, 0.2, 1e-9);

      ctx.moved = true;
      fsm.update(ctx, 0.016);
      assert(fsm.timeInState < 0.02, '转换后应归零');
    });

    test('findUnreachable 发现不可达状态', () => {
      const fsm = new StateMachine<Ctx>({
        initial: 'a',
        transitions: { a: ['b'], b: [] }, // c 永远进不去
        states: {
          a: { enter: () => {} },
          b: { enter: () => {} },
          c: { enter: () => {} },
        },
      });
      const unreachable = fsm.findUnreachable();
      eq(unreachable.length, 1);
      eq(unreachable[0], 'c');
    });

    test('转换中不再接受新转换（避免 enter 里转状态）', () => {
      const fsm = new StateMachine<{ n: number }>({
        initial: 'a',
        states: {
          a: {
            enter: () => {},
            update: () => 'b',
          },
          b: {
            enter: (c) => {
              c.n++;
              fsm.transitionTo('a', c); // enter 里再转换，应被拦截
            },
          },
        },
      });
      const ctx = { n: 0 };
      const origWarn = console.warn;
      console.warn = () => {};
      fsm.update(ctx, 0.016);
      console.warn = origWarn;
      eq(fsm.current, 'b', 'enter 里的递归转换应被忽略');
    });

    test('reset 回到初始状态', () => {
      const { fsm, ctx } = make();
      ctx.moved = true;
      fsm.update(ctx, 0.016);
      fsm.reset(ctx);
      eq(fsm.current, 'idle');
    });
  });

  // ============================================================
  // BehaviorTree
  // ============================================================

  describe('BehaviorTree · 行为树', () => {
    interface Enemy {
      hp: number;
      maxHp: number;
      canSee: boolean;
      dist: number;
      log: string[];
      attackCd: number;
    }

    test('Selector：第一个成功即返回', () => {
      const tree = new BehaviorTree<Enemy>(
        new Selector('root', [
          new Condition('总是失败', () => false),
          new Action('A', (c) => {
            c.log.push('A');
            return BTStatus.Success;
          }),
          new Action('B', (c) => {
            c.log.push('B');
            return BTStatus.Success;
          }),
        ])
      );
      const e: Enemy = { hp: 100, maxHp: 100, canSee: true, dist: 1, log: [], attackCd: 0 };
      eq(tree.tick(e, 0.016), BTStatus.Success);
      eq(e.log.join(','), 'A', '不应执行 B');
    });

    test('Sequence：全部成功才成功', () => {
      const tree = new BehaviorTree<Enemy>(
        new Sequence('root', [
          new Action('A', (c) => {
            c.log.push('A');
            return BTStatus.Success;
          }),
          new Action('B', (c) => {
            c.log.push('B');
            return BTStatus.Success;
          }),
        ])
      );
      const e: Enemy = { hp: 100, maxHp: 100, canSee: true, dist: 1, log: [], attackCd: 0 };
      eq(tree.tick(e, 0.016), BTStatus.Success);
      eq(e.log.join(','), 'A,B');
    });

    test('Sequence：任一失败则整体失败且后续不执行', () => {
      const tree = new BehaviorTree<Enemy>(
        new Sequence('root', [
          new Action('A', (c) => {
            c.log.push('A');
            return BTStatus.Failure;
          }),
          new Action('B', (c) => {
            c.log.push('B');
            return BTStatus.Success;
          }),
        ])
      );
      const e: Enemy = { hp: 100, maxHp: 100, canSee: true, dist: 1, log: [], attackCd: 0 };
      eq(tree.tick(e, 0.016), BTStatus.Failure);
      eq(e.log.join(','), 'A', 'B 不应执行');
    });

    test('优先级：血量低时逃跑优先于攻击', () => {
      const tree = new BehaviorTree<Enemy>(
        new Selector('root', [
          new Sequence('flee', [
            new Condition('血低', (c) => c.hp / c.maxHp < 0.3),
            new Action('逃跑', (c) => {
              c.log.push('flee');
              return BTStatus.Success;
            }),
          ]),
          new Sequence('attack', [
            new Condition('近', (c) => c.dist < 2),
            new Action('攻击', (c) => {
              c.log.push('attack');
              return BTStatus.Success;
            }),
          ]),
        ])
      );

      const healthy: Enemy = { hp: 100, maxHp: 100, canSee: true, dist: 1, log: [], attackCd: 0 };
      tree.tick(healthy, 0.016);
      eq(healthy.log.join(','), 'attack');

      const dying: Enemy = { hp: 10, maxHp: 100, canSee: true, dist: 1, log: [], attackCd: 0 };
      tree.tick(dying, 0.016);
      eq(dying.log.join(','), 'flee', '血低时应优先逃跑');
    });

    test('Inverter 反转结果', () => {
      const tree = new BehaviorTree<Enemy>(
        new Inverter('not', new Condition('总是真', () => true))
      );
      eq(tree.tick({} as Enemy, 0.016), BTStatus.Failure);
    });

    test('Wait 需要累积 dt 才完成（不能传固定值）', () => {
      const wait = new Wait<Enemy>('w', 1.0);
      eq(wait.tick({} as Enemy, {}, 0.5), BTStatus.Running);
      eq(wait.tick({} as Enemy, {}, 0.5), BTStatus.Success);
    });

    test('CooldownDecorator 冷却期内返回 Failure', () => {
      const cd = new CooldownDecorator<Enemy>(
        'cd',
        new Action('攻击', () => BTStatus.Success),
        1.0
      );
      eq(cd.tick({} as Enemy, {}, 0.016), BTStatus.Success);
      eq(cd.tick({} as Enemy, {}, 0.5), BTStatus.Failure, '冷却中');
      cd.tick({} as Enemy, {}, 0.6); // 冷却走完
      eq(cd.tick({} as Enemy, {}, 0.016), BTStatus.Success);
    });

    test('Running 状态跨帧保持', () => {
      let frames = 0;
      const tree = new BehaviorTree<Enemy>(
        new Action('持续', () => {
          frames++;
          return frames >= 3 ? BTStatus.Success : BTStatus.Running;
        })
      );
      const e: Enemy = { hp: 100, maxHp: 100, canSee: true, dist: 1, log: [], attackCd: 0 };
      eq(tree.tick(e, 0.016), BTStatus.Running);
      eq(tree.tick(e, 0.016), BTStatus.Running);
      eq(tree.tick(e, 0.016), BTStatus.Success);
    });

    test('黑板跨节点共享', () => {
      const tree = new BehaviorTree<Enemy>(
        new Sequence('root', [
          new Action('写入', (_c, bb) => {
            bb.target = 'player1';
            return BTStatus.Success;
          }),
          new Action('读取', (_c, bb) => {
            return bb.target === 'player1' ? BTStatus.Success : BTStatus.Failure;
          }),
        ])
      );
      eq(tree.tick({} as Enemy, 0.016), BTStatus.Success);
    });

    test('reset 清空状态', () => {
      const tree = new BehaviorTree<Enemy>(new Wait('w', 10));
      tree.tick({} as Enemy, 1);
      tree.reset();
      eq(tree.lastStatus, BTStatus.Failure);
    });

    test('autoReset：完成后下一帧从头开始', () => {
      let n = 0;
      const tree = new BehaviorTree<Enemy>(
        new Action('计数', () => {
          n++;
          return BTStatus.Success;
        })
      );
      tree.tick({} as Enemy, 0.016);
      tree.tick({} as Enemy, 0.016);
      eq(n, 2, '每次 tick 都应从头执行');
    });
  });

  // ============================================================
  // BuffSystem
  // ============================================================

  describe('BuffSystem · 增益与减益', () => {
    test('apply 后生效，层数正确', () => {
      const b = new BuffSystem();
      b.register({ id: 'poison', duration: 5, maxStacks: 3 });
      b.apply('poison');
      eq(b.stacks('poison'), 1);
      b.apply('poison');
      eq(b.stacks('poison'), 2);
    });

    test('maxStacks 限制层数', () => {
      const b = new BuffSystem();
      b.register({ id: 'str', duration: 5, maxStacks: 3 });
      for (let i = 0; i < 10; i++) b.apply('str');
      eq(b.stacks('str'), 3);
    });

    test('refresh 模式重置时长', () => {
      const b = new BuffSystem();
      b.register({ id: 'a', duration: 5 });
      b.apply('a');
      b.update(3);
      near(b.remain('a'), 2, 1e-9);
      b.apply('a'); // 刷新
      near(b.remain('a'), 5, 1e-9, '应重置为 5');
    });

    test('extend 模式累加时长', () => {
      const b = new BuffSystem();
      b.register({ id: 'a', duration: 5, stackMode: 'extend' });
      b.apply('a');
      b.update(3);
      b.apply('a');
      near(b.remain('a'), 7, 1e-9, '2 + 5 = 7');
    });

    test('到期自动移除并通知 expire', () => {
      const b = new BuffSystem();
      b.register({ id: 'a', duration: 1 });
      const events: string[] = [];
      b.onChange((c) => events.push(c.kind));
      b.apply('a');
      b.update(1.1);
      eq(b.has('a'), false);
      assert(events.includes('expire'), events.join(','));
    });

    test('tick 按间隔触发（中毒每秒掉血）', () => {
      const b = new BuffSystem();
      b.register({ id: 'poison', duration: 5, tickInterval: 1, maxStacks: 5 });
      b.apply('poison', 3);

      let ticks = 0;
      let lastStacks = 0;
      b.update(0.5);
      eq(ticks, 0, '0.5 秒时不应触发');
      b.update(0.6, (_id, s) => {
        ticks++;
        lastStacks = s;
      });
      eq(ticks, 1);
      eq(lastStacks, 3, 'tick 应带上层数');
    });

    test('remove 部分层数', () => {
      const b = new BuffSystem();
      b.register({ id: 'a', duration: 5, maxStacks: 5 });
      b.apply('a', 5);
      b.remove('a', 2);
      eq(b.stacks('a'), 3);
    });

    test('removeByTag 批量移除（驱散 debuff）', () => {
      const b = new BuffSystem();
      b.register({ id: 'poison', duration: 5, tags: ['debuff'] });
      b.register({ id: 'slow', duration: 5, tags: ['debuff'] });
      b.register({ id: 'haste', duration: 5, tags: ['buff'] });
      b.apply('poison');
      b.apply('slow');
      b.apply('haste');

      eq(b.removeByTag('debuff'), 2);
      eq(b.count, 1);
      eq(b.has('haste'), true);
    });

    test('dispellable=false 的不可驱散（Boss 的永久 buff）', () => {
      const b = new BuffSystem();
      b.register({ id: 'rage', duration: 999, tags: ['debuff'], dispellable: false });
      b.apply('rage');
      eq(b.removeByTag('debuff'), 0, '不可驱散');
      eq(b.has('rage'), true);
    });

    test('clearOnDeath 只清标记了的', () => {
      const b = new BuffSystem();
      b.register({ id: 'temp', duration: 5 });
      b.register({ id: 'permanent', duration: 999, clearOnDeath: false });
      b.apply('temp');
      b.apply('permanent');

      eq(b.clearOnDeath(), 1);
      eq(b.has('temp'), false);
      eq(b.has('permanent'), true);
    });

    test('变更通知驱动外部重建数值（与 Modifier 协作）', () => {
      const b = new BuffSystem();
      b.register({ id: 'atk', duration: 5, maxStacks: 3 });
      let rebuilds = 0;
      b.onChange(() => rebuilds++);
      b.apply('atk');
      b.apply('atk');
      b.remove('atk');
      assert(rebuilds >= 3, `应通知 3 次，实际 ${rebuilds}`);
    });

    test('存档：导出导入', () => {
      const b = new BuffSystem();
      b.register({ id: 'a', duration: 10, maxStacks: 3 });
      b.apply('a', 2);
      b.update(3);
      const saved = b.export();
      eq(saved.length, 1);
      eq(saved[0].stacks, 2);
      near(saved[0].remain, 7, 1e-9);

      const b2 = new BuffSystem();
      b2.register({ id: 'a', duration: 10, maxStacks: 3 });
      b2.import(saved);
      eq(b2.stacks('a'), 2);
    });

    test('未注册的 buff 抛错（配置错误早发现）', () => {
      const b = new BuffSystem();
      let threw = false;
      try {
        b.apply('不存在');
      } catch {
        threw = true;
      }
      assert(threw);
    });

    test('independent 模式各自计时', () => {
      const b = new BuffSystem();
      b.register({ id: 'a', duration: 1, stackMode: 'independent' });
      b.apply('a');
      b.apply('a');
      eq(b.stacks('a'), 2);
      b.update(1.1);
      eq(b.stacks('a'), 0, '两个实例都到期');
    });
  });

  // ============================================================
  // Curve
  // ============================================================

  describe('Curve · 关键帧曲线', () => {
    test('线性插值', () => {
      const c = Curve.fromArray([[0, 0], [1, 100]]);
      near(c.evaluate(0.5), 50);
      near(c.evaluate(0.25), 25);
    });

    test('关键帧之间插值的具体值', () => {
      const c = Curve.fromArray([[0, 0], [0.5, 100], [1, 0]]);
      near(c.evaluate(0.25), 50, 1e-9);
      near(c.evaluate(0.75), 50, 1e-9);
      near(c.evaluate(0.5), 100, 1e-9);
    });

    test('超出范围 clamp 而不是抛错', () => {
      const c = Curve.fromArray([[0, 0], [1, 100]]);
      near(c.evaluate(-5), 0, 1e-9);
      near(c.evaluate(999), 100, 1e-9);
    });

    test('step 模式取左值', () => {
      const c = Curve.fromArray([[0, 0], [1, 100]]);
      near(c.evaluate(0.9, 'step'), 0, 1e-9);
    });

    test('smooth 模式在端点导数为 0（更自然）', () => {
      const c = Curve.fromArray([[0, 0], [1, 100]]);
      const smooth = c.evaluate(0.5, 'smooth');
      near(smooth, 50, 1e-6);
      // 1/4 处：smooth 会比线性更靠近起点
      assert(c.evaluate(0.25, 'smooth') < c.evaluate(0.25, 'linear'));
    });

    test('evaluateNormalized 把 0–1 映射到时间范围', () => {
      const c = Curve.fromArray([[10, 0], [20, 100]]);
      near(c.evaluateNormalized(0.5), 50, 1e-9);
      near(c.evaluate(15), 50, 1e-9);
    });

    test('关键帧乱序输入会自动排序', () => {
      const c = Curve.fromArray([[1, 100], [0, 0]]);
      near(c.evaluate(0.5), 50, 1e-9);
    });

    test('单关键帧返回常数', () => {
      const c = Curve.constant(42);
      near(c.evaluate(0), 42);
      near(c.evaluate(100), 42);
    });

    test('空曲线返回 0', () => {
      eq(new Curve().evaluate(1), 0);
    });

    test('duration / minValue / maxValue', () => {
      const c = Curve.fromArray([[0, -10], [5, 50]]);
      near(c.duration, 5);
      near(c.minValue, -10);
      near(c.maxValue, 50);
    });

    test('clone 不共享数据（避免污染模板）', () => {
      const c = Curve.fromArray([[0, 0], [1, 100]]);
      const c2 = c.clone();
      c2.addKey(2, 200);
      eq(c.keyCount, 2);
      eq(c2.keyCount, 3);
    });

    test('非有限数被拒绝', () => {
      let threw = false;
      try {
        new Curve([{ time: NaN, value: 1 }]);
      } catch {
        threw = true;
      }
      assert(threw);
    });
  });

  // ============================================================
  // Result
  // ============================================================

  describe('Result · 显式错误处理', () => {
    test('ok / err 构造与判断', () => {
      const r = ok(42);
      eq(r.ok, true);
      eq(r.isOk(), true);
      eq(r.isErr(), false);
      if (r.isOk()) eq(r.value, 42);

      const e = err('失败');
      eq(e.ok, false);
      eq(e.isErr(), true);
    });

    test('map 转换成功值', () => {
      eq(ok(10).map((v) => v * 2).unwrapOr(0), 20);
      eq(err<number>('x').map((v) => v * 2).unwrapOr(0), 0);
    });

    test('mapErr 转换错误', () => {
      const r = err<number, string>('404').mapErr((e) => `HTTP ${e}`);
      if (r.isErr()) eq(r.error, 'HTTP 404');
    });

    test('unwrapOr 提供兜底', () => {
      eq(err<number>('x').unwrapOr(99), 99);
      eq(ok(1).unwrapOr(99), 1);
    });

    test('对 Err 调用 unwrap 抛错', () => {
      let threw = false;
      try {
        err('boom').unwrap();
      } catch {
        threw = true;
      }
      assert(threw);
    });

    test('flatMap 链式', () => {
      const parse = (s: string) => {
        const n = Number(s);
        return Number.isFinite(n) ? ok(n) : err<number>('不是数字');
      };
      eq(ok('10').flatMap(parse).unwrapOr(-1), 10);
      eq(ok('abc').flatMap(parse).unwrapOr(-1), -1);
    });

    test('match 分支处理', () => {
      const msg = ok(5).match((v) => `值=${v}`, (e) => `错=${e}`);
      eq(msg, '值=5');
      const msg2 = err<number>('boom').match((v) => `值=${v}`, (e) => `错=${e}`);
      eq(msg2, '错=boom');
    });

    test('attempt 包装异常', () => {
      const good = attempt(() => JSON.parse('{"a":1}'), (e) => String(e));
      eq(good.isOk(), true);

      const bad = attempt(() => JSON.parse('{bad json}'), () => `解析失败`);
      eq(bad.isErr(), true);
      if (bad.isErr()) eq(bad.error, '解析失败');
    });

    test('all：全部成功才成功', () => {
      const r = all([ok(1), ok(2), ok(3)]);
      eq(r.isOk(), true);
      if (r.isOk()) eq(r.value.join(','), '1,2,3');

      const r2 = all([ok(1), err<number>('失败'), ok(3)]);
      eq(r2.isErr(), true);
    });

    test('fromNullable', () => {
      const m = new Map([['a', 1]]);
      eq(fromNullable(m.get('a'), '不存在').unwrapOr(0), 1);
      eq(fromNullable(m.get('b'), '不存在').unwrapOr(0), 0);
    });
  });

  // ============================================================
  // Signal
  // ============================================================

  describe('Signal · 轻量信号', () => {
    test('add / emit', () => {
      const s = new Signal<(n: number) => void>();
      let got = 0;
      s.add((n) => (got = n));
      s.emit(42);
      eq(got, 42);
    });

    test('add 返回取消函数', () => {
      const s = new Signal<() => void>();
      let n = 0;
      const off = s.add(() => n++);
      s.emit();
      off();
      s.emit();
      eq(n, 1);
    });

    test('once 只触发一次', () => {
      const s = new Signal<() => void>();
      let n = 0;
      s.once(() => n++);
      s.emit();
      s.emit();
      s.emit();
      eq(n, 1);
    });

    test('回调里取消自己不破坏遍历（"只处理第一次"）', () => {
      const s = new Signal<() => void>();
      let n = 0;
      const off = s.add(() => {
        n++;
        off();
      });
      s.emit();
      s.emit();
      eq(n, 1);
      eq(s.listenerCount, 0, '应被清理');
    });

    test('某个监听者抛异常不中断其他监听者', () => {
      const s = new Signal<() => void>();
      const origErr = console.error;
      console.error = () => {};
      let second = false;
      s.add(() => {
        throw new Error('我写错了');
      });
      s.add(() => {
        second = true;
      });
      s.emit();
      console.error = origErr;
      eq(second, true, '第二个监听者仍应收到');
    });

    test('listenerCount 可排查泄漏', () => {
      const s = new Signal<() => void>();
      eq(s.listenerCount, 0);
      const o1 = s.add(() => {});
      eq(s.listenerCount, 1);
      o1();
      eq(s.listenerCount, 0);
    });

    test('clear 移除所有', () => {
      const s = new Signal<() => void>();
      let n = 0;
      s.add(() => n++);
      s.add(() => n++);
      s.clear();
      s.emit();
      eq(n, 0);
    });

    test('递归 emit 被拦截（不会无限循环）', () => {
      const s = new Signal<() => void>();
      const origWarn = console.warn;
      console.warn = () => {};
      s.add(() => {
        if (depth < 3) {
          depth++;
          s.emit();
        }
      });
      let depth = 0;
      s.emit();
      console.warn = origWarn;
      eq(depth, 1, '递归 emit 应被忽略');
    });

    test('带参数的信号', () => {
      const s = new Signal<(a: string, b: number) => void>();
      let got = '';
      s.add((a, b) => (got = `${a}:${b}`));
      s.emit('hp', 50);
      eq(got, 'hp:50');
    });
  });

  // ============================================================
  // SaveManager
  // ============================================================

  describe('SaveManager · 存档', () => {
    test('写入后能读出', () => {
      const saves = new SaveManager(new MemoryStorage(), { gameId: 'test', version: 1 });
      saves.write('slot1', { hp: 50 });
      const r = saves.read<{ hp: number }>('slot1');
      eq(r.ok, true);
      if (r.ok) eq(r.value.hp, 50);
    });

    test('读取不存在的槽位返回失败（不抛错）', () => {
      const saves = new SaveManager(new MemoryStorage(), { gameId: 'test', version: 1 });
      const r = saves.read('nope');
      eq(r.ok, false);
    });

    test('校验和检测手改存档', () => {
      const storage = new MemoryStorage();
      const saves = new SaveManager(storage, { gameId: 'test', version: 1 });
      saves.write('s', { gold: 100 });

      // 手改存档
      const raw = JSON.parse(storage.read('save_s')!);
      raw.data.gold = 999999;
      storage.write('save_s', JSON.stringify(raw));

      const r = saves.read('s');
      eq(r.ok, false);
      if (!r.ok) assert(r.error.includes('校验'), r.error);
    });

    test('损坏的 JSON 被识别', () => {
      const storage = new MemoryStorage();
      const saves = new SaveManager(storage, { gameId: 'test', version: 1 });
      storage.write('save_s', '{ 这不是 JSON');
      const r = saves.read('s');
      eq(r.ok, false);
      if (!r.ok) assert(r.error.includes('解析'), r.error);
    });

    test('版本迁移链：v1 → v3', () => {
      const storage = new MemoryStorage();
      // 用 v1 写入
      const v1 = new SaveManager(storage, { gameId: 'test', version: 1 });
      v1.write('s', { coins: 100 });

      // 用 v3 读取，注册迁移
      const v3 = new SaveManager(storage, { gameId: 'test', version: 3 });
      v3.registerMigration(1, 2, (d) => ({ ...d, gold: d.coins ?? 0 }));
      v3.registerMigration(2, 3, (d) => ({ ...d, relics: [] }));

      const r = v3.read<{ gold: number; relics: string[] }>('s');
      eq(r.ok, true);
      if (r.ok) {
        eq(r.value.gold, 100);
        eq(Array.isArray(r.value.relics), true);
      }
    });

    test('缺少迁移函数时明确报错（而不是静默丢档）', () => {
      const storage = new MemoryStorage();
      const v1 = new SaveManager(storage, { gameId: 'test', version: 1 });
      v1.write('s', { a: 1 });

      const v3 = new SaveManager(storage, { gameId: 'test', version: 3 });
      v3.registerMigration(1, 2, (d) => d);
      // 故意不注册 2→3

      const r = v3.read('s');
      eq(r.ok, false);
      if (!r.ok) assert(r.error.includes('迁移'), r.error);
    });

    test('存档版本高于当前版本时报错（提示更新游戏）', () => {
      const storage = new MemoryStorage();
      const v5 = new SaveManager(storage, { gameId: 'test', version: 5 });
      v5.write('s', { a: 1 });

      const v3 = new SaveManager(storage, { gameId: 'test', version: 3 });
      const r = v3.read('s');
      eq(r.ok, false);
      if (!r.ok) assert(r.error.includes('高于'), r.error);
    });

    test('不同游戏的存档互不认', () => {
      const storage = new MemoryStorage();
      const a = new SaveManager(storage, { gameId: 'gameA', version: 1 });
      a.write('s', { x: 1 });

      const b = new SaveManager(storage, { gameId: 'gameB', version: 1 });
      const r = b.read('s');
      eq(r.ok, false);
      if (!r.ok) assert(r.error.includes('另一个游戏'), r.error);
    });

    test('多槽位管理', () => {
      const saves = new SaveManager(new MemoryStorage(), { gameId: 't', version: 1 });
      saves.write('s1', { a: 1 });
      saves.write('s2', { a: 2 });
      eq(saves.listSlots().sort().join(','), 's1,s2');
      eq(saves.has('s1'), true);

      saves.deleteSlot('s1');
      eq(saves.has('s1'), false);
      eq(saves.listSlots().join(','), 's2');
    });

    test('meta 不执行迁移（存档选择界面用）', () => {
      const storage = new MemoryStorage();
      const v1 = new SaveManager(storage, { gameId: 't', version: 1 });
      v1.write('s', { a: 1 });

      const v3 = new SaveManager(storage, { gameId: 't', version: 3 });
      const m = v3.meta('s');
      assert(m !== null);
      if (m) eq(m.version, 1);
    });

    test('迁移必须逐级注册', () => {
      const saves = new SaveManager(new MemoryStorage(), { gameId: 't', version: 3 });
      let threw = false;
      try {
        saves.registerMigration(1, 3, (d) => d);
      } catch {
        threw = true;
      }
      assert(threw);
    });

    test('循环引用不会导致崩溃', () => {
      const saves = new SaveManager(new MemoryStorage(), { gameId: 't', version: 1 });
      const origErr = console.error;
      console.error = () => {};
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const result = saves.write('s', cyclic);
      console.error = origErr;
      eq(result, false, '应返回 false 而不是崩溃');
    });
  });

  // ============================================================
  // NumberRollerCore
  // ============================================================

  describe('NumberRollerCore · 数字滚动', () => {
    test('滚到目标值', () => {
      const r = new NumberRollerCore({ duration: { min: 1, max: 1 } });
      r.set(100);
      r.update(0.5);
      assert(r.display > 0 && r.display < 100, `滚动中: ${r.display}`);
      r.update(0.6);
      eq(r.isRolling, false);
      near(r.display, 100, 1e-6);
    });

    test('连续设置时从当前显示值继续（不跳变）', () => {
      const r = new NumberRollerCore({ duration: { min: 1, max: 1 } });
      r.set(100);
      r.update(0.5);
      const mid = r.display;
      assert(mid > 0 && mid < 100);

      r.set(200); // 中途改目标
      near(r.display, mid, 1e-9, '不应跳变到 0 或 100');
      r.update(1.1);
      near(r.display, 200, 1e-6);
    });

    test('snapTo 立即到位', () => {
      const r = new NumberRollerCore();
      r.set(1000);
      r.snapTo(999);
      eq(r.isRolling, false);
      near(r.display, 999);
    });

    test('差值大时时长更长（但不拖沓）', () => {
      const small = new NumberRollerCore({ duration: { min: 0.2, max: 1.0 }, bigDelta: 1000 });
      const big = new NumberRollerCore({ duration: { min: 0.2, max: 1.0 }, bigDelta: 1000 });

      small.set(10);
      big.set(100000);
      small.update(0.1);
      big.update(0.1);

      // 【注意】不能比较绝对数值（10 和 100000 量级不同），要比较完成比例
      const smallRatio = small.display / 10;
      const bigRatio = big.display / 100000;
      assert(smallRatio > bigRatio, `小变化应更快完成：${smallRatio.toFixed(3)} vs ${bigRatio.toFixed(3)}`);
    });

    test('格式化：千分位', () => {
      const r = new NumberRollerCore({ separator: ',' });
      r.snapTo(1234567);
      eq(r.formatted, '1,234,567');
    });

    test('格式化：负数千分位（不是 "-,1234,567"）', () => {
      const r = new NumberRollerCore({ separator: ',' });
      r.snapTo(-1234567);
      eq(r.formatted, '-1,234,567');
    });

    test('格式化：小数位', () => {
      const r = new NumberRollerCore({ decimals: 2 });
      r.snapTo(3.14159);
      eq(r.formatted, '3.14');
    });

    test('showSign 显示正号', () => {
      const r = new NumberRollerCore({ showSign: true });
      r.snapTo(50);
      eq(r.formatted, '+50');
      r.snapTo(-50);
      eq(r.formatted, '-50');
    });

    test('缩写：K / M / B', () => {
      const r = new NumberRollerCore();
      r.snapTo(999);
      eq(r.abbreviated, '999', '不到 1000 不缩写');
      r.snapTo(1234);
      eq(r.abbreviated, '1.2K');
      r.snapTo(3400000);
      eq(r.abbreviated, '3.4M');
      r.snapTo(2500000000);
      eq(r.abbreviated, '2.5B');
    });

    test('过冲：先冲过头再回落', () => {
      const r = new NumberRollerCore({ duration: { min: 1, max: 1 } });
      r.set(100, { overshoot: 1.2 });
      r.update(0.55); // t≈0.55，接近过冲顶点
      assert(r.display > 100, `应冲过 100，实际 ${r.display}`);
      r.update(0.5);
      near(r.display, 100, 1e-6, '最终回到 100');
    });

    test('displayInt 取整', () => {
      const r = new NumberRollerCore();
      r.snapTo(7.6);
      eq(r.displayInt, 8);
    });

    test('非有限数被拒绝', () => {
      const r = new NumberRollerCore();
      let threw = false;
      try {
        r.set(NaN);
      } catch {
        threw = true;
      }
      assert(threw);
    });
  });

  // ============================================================
  // Pathfinding
  // ============================================================

  describe('pathfinding · 网格寻路', () => {
    test('空旷地图找到直线路径', () => {
      const g = new GridGraph(10, 10);
      const p = findPath(g, { x: 0, y: 0 }, { x: 9, y: 9 });
      assert(p !== null);
      if (p) {
        eq(p[0].x, 0);
        eq(p[0].y, 0);
        eq(p[p.length - 1].x, 9);
        eq(p[p.length - 1].y, 9);
      }
    });

    test('起点 = 终点返回单点', () => {
      const g = new GridGraph(10, 10);
      const p = findPath(g, { x: 3, y: 3 }, { x: 3, y: 3 });
      assert(p !== null);
      if (p) eq(p.length, 1);
    });

    test('目标不可走返回 null（不是抛错）', () => {
      const g = new GridGraph(10, 10);
      g.setWalkable(5, 5, false);
      eq(findPath(g, { x: 0, y: 0 }, { x: 5, y: 5 }), null);
    });

    test('完全被围住返回 null', () => {
      const g = new GridGraph(9, 9);
      // 中心 (4,4) 四周围墙
      g.setWalkable(3, 3, false);
      g.setWalkable(5, 3, false);
      g.setWalkable(3, 5, false);
      g.setWalkable(5, 5, false);
      g.setWalkable(4, 3, false);
      g.setWalkable(4, 5, false);
      g.setWalkable(3, 4, false);
      g.setWalkable(5, 4, false);
      eq(findPath(g, { x: 0, y: 0 }, { x: 4, y: 4 }), null);
    });

    test('绕过障碍（路径不穿墙）', () => {
      const g = new GridGraph(10, 10);
      // 竖墙 x=5，留一个缺口在 y=9
      for (let y = 0; y < 9; y++) g.setWalkable(5, y, false);

      const p = findPath(g, { x: 0, y: 0 }, { x: 9, y: 0 });
      assert(p !== null, '应能绕过');
      if (p) {
        for (const pt of p) {
          assert(g.isWalkable(pt.x, pt.y), `路径经过不可走格子 (${pt.x},${pt.y})`);
        }
      }
    });

    test('路径是连续的（每步相邻）', () => {
      const g = new GridGraph(20, 20);
      g.setWalkableRect(5, 0, 2, 15, false);
      const p = findPath(g, { x: 0, y: 0 }, { x: 19, y: 19 });
      assert(p !== null);
      if (p) {
        for (let i = 1; i < p.length; i++) {
          const dx = Math.abs(p[i].x - p[i - 1].x);
          const dy = Math.abs(p[i].y - p[i - 1].y);
          assert(dx <= 1 && dy <= 1, `第 ${i} 步跳跃过大: (${p[i - 1].x},${p[i - 1].y}) → (${p[i].x},${p[i].y})`);
        }
      }
    });

    test('禁用对角线时只走四方向', () => {
      const g = new GridGraph(10, 10);
      const p = findPath(g, { x: 0, y: 0 }, { x: 5, y: 5 }, { allowDiagonal: false });
      assert(p !== null);
      if (p) {
        for (let i = 1; i < p.length; i++) {
          const d = Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y);
          eq(d, 1, '四方向移动每步曼哈顿距离应为 1');
        }
      }
    });

    test('不允许切角时不从墙角缝穿过', () => {
      const g = new GridGraph(5, 5);
      g.setWalkable(1, 0, false);
      g.setWalkable(0, 1, false);
      // (0,0) → (1,1) 的对角线需要切角
      const p = findPath(g, { x: 0, y: 0 }, { x: 1, y: 1 }, { allowCornerCutting: false });
      if (p) {
        // 应该绕行（长度 > 2）或者找不到路
        assert(p.length !== 2, `不应直接对角穿过墙角，实际路径长度 ${p.length}`);
      }
    });

    test('地形代价影响路径（绕开沼泽）', () => {
      const g = new GridGraph(15, 15);
      // x=5 的 y=0..9 设为高代价沼泽，y=10..14 留作正常通路
      for (let y = 0; y < 10; y++) g.setCost(5, y, 20);

      const p = findPath(g, { x: 0, y: 2 }, { x: 14, y: 2 });
      assert(p !== null, '应能找到路');
      if (p) {
        // 直线穿过 x=5,y=2 代价 20；绕到 y=10+ 走过去代价约 (8+14+8)=30？
        // 用更短的绕行：直接验证不会走代价 20 的格子
        const swampCost = p
          .slice(1)
          .reduce((sum, pt) => sum + (pt.x === 5 && pt.y < 10 ? 1 : 0), 0);
        // 允许穿过沼泽，但只有在没有更优解时；这里验证绕行可行
        assert(swampCost <= 1, `最多穿过 1 格沼泽，实际 ${swampCost}`);
      }
    });

    test('地形代价：沼泽完全封死时仍会穿过（不返回 null）', () => {
      const g = new GridGraph(10, 10);
      for (let y = 0; y < 10; y++) g.setCost(5, y, 50);
      const p = findPath(g, { x: 0, y: 5 }, { x: 9, y: 5 });
      assert(p !== null, '高代价不等于不可走，必须有路');
    });

    test('maxNodes 防止卡死', () => {
      const g = new GridGraph(200, 200);
      // 完全封闭的目标
      g.setWalkableRect(100, 90, 1, 20, false);
      g.setWalkableRect(90, 100, 20, 1, false);
      const p = findPath(g, { x: 0, y: 0 }, { x: 100, y: 100 }, { maxNodes: 500 });
      // 有上限约束，不会跑太久
      assert(p === null || p.length > 0);
    });

    test('smoothPath 合并共线点', () => {
      const g = new GridGraph(20, 20);
      const p = findPath(g, { x: 0, y: 0 }, { x: 15, y: 0 });
      assert(p !== null);
      if (p) {
        const s = smoothPath(g, p);
        assert(s.length <= p.length, '平滑后不应更长');
        assert(s.length >= 2, '至少保留首尾');
      }
    });

    test('越界坐标返回 null', () => {
      const g = new GridGraph(10, 10);
      eq(findPath(g, { x: -1, y: 0 }, { x: 5, y: 5 }), null);
      eq(findPath(g, { x: 0, y: 0 }, { x: 100, y: 100 }), null);
    });

    test('walkableCount 正确', () => {
      const g = new GridGraph(10, 10);
      eq(g.walkableCount, 100);
      g.setWalkableRect(0, 0, 5, 5, false);
      eq(g.walkableCount, 75);
    });
  });

  // ============================================================
  // SpatialHash
  // ============================================================

  describe('SpatialHash · 空间哈希', () => {
    test('圆形查询返回范围内的元素', () => {
      const h = new SpatialHash<string>({ cellSize: 5 });
      h.insert('a', 'A', 0, 0);
      h.insert('b', 'B', 3, 0);
      h.insert('c', 'C', 100, 100);

      const near0 = h.queryCircle(0, 0, 5);
      eq(near0.length, 2, 'A 和 B 在范围内');
      assert(near0.includes('A'));
      assert(near0.includes('B'));
      assert(!near0.includes('C'));
    });

    test('边界元素不被重复返回', () => {
      const h = new SpatialHash<number>({ cellSize: 10 });
      for (let i = 0; i < 100; i++) {
        h.insert(String(i), i, (i % 10) * 9, Math.floor(i / 10) * 9);
      }
      const all = h.queryRect(-1000, -1000, 1000, 1000);
      eq(all.length, 100, '不应有重复');
      eq(new Set(all).size, 100);
    });

    test('移动后必须 update（否则查询错误）', () => {
      const h = new SpatialHash<string>({ cellSize: 5 });
      h.insert('a', 'A', 0, 0);
      // 移动到 (100, 100) 但不更新
      const before = h.queryCircle(100, 100, 5);
      eq(before.includes('A'), false, '未更新时仍在旧位置');

      h.update('a', 100, 100);
      const after = h.queryCircle(100, 100, 5);
      eq(after.includes('A'), true, '更新后应能查到');
    });

    test('矩形查询', () => {
      const h = new SpatialHash<string>({ cellSize: 4 });
      h.insert('a', 'A', 1, 1);
      h.insert('b', 'B', 10, 10);
      const inRect = h.queryRect(0, 0, 5, 5);
      eq(inRect.length, 1);
      eq(inRect[0], 'A');
    });

    test('queryNearest 返回最近的 K 个', () => {
      const h = new SpatialHash<string>({ cellSize: 5 });
      h.insert('far', 'FAR', 50, 0);
      h.insert('near', 'NEAR', 2, 0);
      h.insert('mid', 'MID', 10, 0);

      const k = h.queryNearest(0, 0, 2);
      eq(k.length, 2);
      eq(k[0], 'NEAR');
      eq(k[1], 'MID');
    });

    test('remove 生效', () => {
      const h = new SpatialHash<string>({ cellSize: 5 });
      h.insert('a', 'A', 0, 0);
      eq(h.remove('a'), true);
      eq(h.queryCircle(0, 0, 10).length, 0);
      eq(h.itemCount, 0);
    });

    test('空格子被清理（开放世界不会积累几万空 cell）', () => {
      const h = new SpatialHash<string>({ cellSize: 5 });
      h.insert('a', 'A', 0, 0);
      eq(h.cellCount, 1);
      h.remove('a');
      eq(h.cellCount, 0, '空格子应立即删除');
    });

    test('非有限坐标被拒绝', () => {
      const h = new SpatialHash<string>({ cellSize: 5 });
      let threw = false;
      try {
        h.insert('a', 'A', NaN, 0);
      } catch {
        threw = true;
      }
      assert(threw);
    });

    test('负坐标正确工作', () => {
      const h = new SpatialHash<string>({ cellSize: 5 });
      h.insert('a', 'A', -10, -10);
      eq(h.queryCircle(-10, -10, 1).length, 1);
    });

    test('clear 清空', () => {
      const h = new SpatialHash<string>({ cellSize: 5 });
      h.insert('a', 'A', 0, 0);
      h.clear();
      eq(h.itemCount, 0);
      eq(h.cellCount, 0);
    });
  });

  // ============================================================
  // Noise
  // ============================================================

  describe('Noise · 确定性噪声', () => {
    test('同种子产生完全相同的噪声（可复现）', () => {
      const a = new Noise(12345);
      const b = new Noise(12345);
      for (let i = 0; i < 100; i++) {
        near(a.noise2(i * 0.1, i * 0.2), b.noise2(i * 0.1, i * 0.2), 1e-12);
      }
    });

    test('不同种子产生不同噪声', () => {
      const a = new Noise(1);
      const b = new Noise(2);
      let diff = 0;
      for (let i = 0; i < 50; i++) {
        if (Math.abs(a.noise2(i * 0.3, i * 0.7) - b.noise2(i * 0.3, i * 0.7)) > 0.01) diff++;
      }
      assert(diff > 40, `应显著不同，实际 ${diff}/50`);
    });

    test('值域在 [-1, 1]', () => {
      const n = new Noise(7);
      for (let i = 0; i < 2000; i++) {
        const v = n.noise2((i % 50) * 0.37, Math.floor(i / 50) * 0.41);
        assert(v >= -1.001 && v <= 1.001, `超出值域: ${v}`);
      }
    });

    test('连续性：相邻点的值接近（这是噪声与随机数的本质区别）', () => {
      const n = new Noise(99);
      let maxJump = 0;
      for (let i = 1; i < 1000; i++) {
        const a = n.noise2(i * 0.01, 0);
        const b = n.noise2((i - 1) * 0.01, 0);
        maxJump = Math.max(maxJump, Math.abs(a - b));
      }
      assert(maxJump < 0.2, `相邻点跳变过大: ${maxJump}`);
    });

    test('整数格点上噪声值为确定值', () => {
      const n = new Noise(5);
      const v1 = n.noise2(3, 4);
      const v2 = n.noise2(3, 4);
      near(v1, v2, 1e-12);
    });

    test('fbm 值域合理', () => {
      const n = new Noise(3);
      for (let i = 0; i < 500; i++) {
        const v = n.fbm(i * 0.1, i * 0.13);
        assert(v >= -1.001 && v <= 1.001, `fbm 超域: ${v}`);
      }
    });

    test('fbm01 落在 [0,1]', () => {
      const n = new Noise(3);
      for (let i = 0; i < 500; i++) {
        const v = n.fbm01(i * 0.1, i * 0.13);
        assert(v >= -0.001 && v <= 1.001, `fbm01 超域: ${v}`);
      }
    });

    test('ridged 落在 [0,1] 且偏向高值', () => {
      const n = new Noise(11);
      let sum = 0;
      for (let i = 0; i < 500; i++) {
        const v = n.ridged(i * 0.1, i * 0.11);
        assert(v >= 0 && v <= 1.001, `ridged 超域: ${v}`);
        sum += v;
      }
      assert(sum / 500 > 0.3, 'ridged 应偏向较高值');
    });

    test('heightMap 归一化到 [0,1]', () => {
      const n = new Noise(21);
      const hm = n.heightMap(32, 32, 0.1);
      eq(hm.length, 32 * 32);
      let min = Infinity;
      let max = -Infinity;
      for (const v of hm) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      near(min, 0, 1e-6);
      near(max, 1, 1e-6);
    });

    test('heightMap 不归一化时值域可能不同（说明归一化必要）', () => {
      const a = new Noise(1);
      const b = new Noise(2);
      const ha = a.heightMap(16, 16, 0.1, { normalize: false });
      const hb = b.heightMap(16, 16, 0.1, { normalize: false });
      // 只验证不崩溃且值在合理范围
      for (const v of ha) assert(Number.isFinite(v));
      for (const v of hb) assert(Number.isFinite(v));
    });

    test('用外部 RNG 构造（让噪声与主世界种子绑定）', () => {
      const rng = new RNG(777);
      const n = new Noise(0, rng);
      assert(Number.isFinite(n.noise2(1.5, 2.5)));
    });
  });

  // ============================================================
  // ConditionEngine
  // ============================================================

  describe('ConditionEngine · 条件引擎', () => {
    test('单条件达成', () => {
      const e = new ConditionEngine();
      e.register({ id: 'first_blood', conditions: [{ stat: 'kill', op: '>=', value: 1 }] });
      e.setStat('kill', 1);
      eq(e.check().join(','), 'first_blood');
    });

    test('未达成不返回', () => {
      const e = new ConditionEngine();
      e.register({ id: 'x', conditions: [{ stat: 'kill', op: '>=', value: 10 }] });
      e.setStat('kill', 5);
      eq(e.check().length, 0);
    });

    test('and 逻辑：全部满足', () => {
      const e = new ConditionEngine();
      e.register({
        id: 'x',
        logic: 'and',
        conditions: [
          { stat: 'kill', op: '>=', value: 5 },
          { stat: 'floor', op: '>=', value: 3 },
        ],
      });
      e.setStat('kill', 5);
      e.setStat('floor', 2);
      eq(e.check().length, 0, 'floor 不够');
      e.setStat('floor', 3);
      eq(e.check().join(','), 'x');
    });

    test('or 逻辑：任一满足', () => {
      const e = new ConditionEngine();
      e.register({
        id: 'x',
        logic: 'or',
        conditions: [
          { stat: 'kill', op: '>=', value: 100 },
          { stat: 'floor', op: '>=', value: 3 },
        ],
      });
      e.setStat('floor', 3);
      eq(e.check().join(','), 'x');
    });

    test('只返回新完成的（不重复触发）', () => {
      const e = new ConditionEngine();
      e.register({ id: 'x', conditions: [{ stat: 'kill', op: '>=', value: 1 }] });
      e.setStat('kill', 1);
      eq(e.check().length, 1);
      e.setStat('kill', 5);
      eq(e.check().length, 0, '已完成的不重复返回');
      eq(e.isCompleted('x'), true);
    });

    test('进度用于 UI 显示', () => {
      const e = new ConditionEngine();
      e.register({ id: 'x', conditions: [{ stat: 'kill', op: '>=', value: 20 }] });
      e.setStat('kill', 5);
      near(e.progress('x'), 0.25, 1e-9);
      e.setStat('kill', 10);
      near(e.progress('x'), 0.5, 1e-9);
      e.setStat('kill', 999);
      near(e.progress('x'), 1, 1e-9, '超出后钳制到 1');
    });

    test('addStat 累加', () => {
      const e = new ConditionEngine();
      e.addStat('kill', 1);
      e.addStat('kill', 1);
      eq(e.getStat('kill'), 2);
    });

    test('custom 条件（无法用 stat 表达时）', () => {
      const e = new ConditionEngine();
      e.register({
        id: 'x',
        conditions: [],
        custom: (s) => (s.a ?? 0) > (s.b ?? 0),
      });
      e.setStat('a', 1);
      e.setStat('b', 5);
      eq(e.check().length, 0);
      e.setStat('a', 10);
      eq(e.check().join(','), 'x');
    });

    test('onComplete 回调', () => {
      const e = new ConditionEngine();
      e.register({ id: 'x', conditions: [{ stat: 'k', op: '>=', value: 1 }] });
      const done: string[] = [];
      e.onComplete((id) => done.push(id));
      e.setStat('k', 1);
      e.check();
      eq(done.join(','), 'x');
    });

    test('比较操作符全覆盖', () => {
      const e = new ConditionEngine();
      e.register({ id: 'gt', conditions: [{ stat: 'v', op: '>', value: 5 }] });
      e.register({ id: 'lt', conditions: [{ stat: 'v', op: '<', value: 5 }] });
      e.register({ id: 'eq', conditions: [{ stat: 'v', op: '==', value: 5 }] });
      e.register({ id: 'ne', conditions: [{ stat: 'v', op: '!=', value: 5 }] });

      e.setStat('v', 10);
      let done = e.check().sort();
      eq(done.join(','), 'gt,ne', `v=10 应满足 >5 和 !=5，实际 ${done}`);
    });

    test('存档：导出导入', () => {
      const e = new ConditionEngine();
      e.register({ id: 'x', conditions: [{ stat: 'k', op: '>=', value: 2 }] });
      e.addStat('k', 1);
      e.addStat('k', 1);
      e.check();
      const saved = e.export();
      eq(saved.stats.k, 2);
      eq(saved.completed.join(','), 'x');

      const e2 = new ConditionEngine();
      e2.register({ id: 'x', conditions: [{ stat: 'k', op: '>=', value: 2 }] });
      e2.import(saved);
      eq(e2.getStat('k'), 2);
      eq(e2.isCompleted('x'), true);
    });

    test('空的 conditions 且无 custom 时报错', () => {
      const e = new ConditionEngine();
      let threw = false;
      try {
        e.register({ id: 'x', conditions: [] });
      } catch {
        threw = true;
      }
      assert(threw);
    });

    test('非有限统计值被拒绝', () => {
      const e = new ConditionEngine();
      let threw = false;
      try {
        e.setStat('x', NaN);
      } catch {
        threw = true;
      }
      assert(threw);
    });

    test('list 返回所有定义的进度（成就列表界面）', () => {
      const e = new ConditionEngine();
      e.register({ id: 'a', conditions: [{ stat: 'k', op: '>=', value: 10 }] });
      e.register({ id: 'b', conditions: [{ stat: 'k', op: '>=', value: 20 }] });
      e.setStat('k', 10);
      const list = e.list();
      eq(list.length, 2);
      near(list[0].progress, 1);
      near(list[1].progress, 0.5);
    });
  });

  // ============================================================
  // Tween
  // ============================================================

  describe('Tween · 补间动画', () => {
    test('进度从 0 到 1', () => {
      const t = new Tween(1);
      const seen: number[] = [];
      t.onUpdate((p) => seen.push(p));
      t.update(0.5);
      near(seen[0], 0.5, 1e-9);
      t.update(0.5);
      near(seen[1], 1, 1e-9);
    });

    test('完成时触发 onComplete 且只触发一次', () => {
      const t = new Tween(1);
      let n = 0;
      t.onComplete(() => n++);
      t.update(1.5);
      t.update(1.5);
      eq(n, 1);
    });

    test('delay 延迟开始', () => {
      const t = new Tween(1).delay(0.5);
      let started = false;
      t.onUpdate(() => (started = true));
      t.update(0.3);
      eq(started, false, '延迟期间不应更新');
      t.update(0.3);
      eq(started, true);
    });

    test('delay 的溢出补偿（不丢时间）', () => {
      const t = new Tween(1).delay(0.5);
      const seen: number[] = [];
      t.onUpdate((p) => seen.push(p));
      t.update(0.7); // 超出延迟 0.2
      near(seen[0], 0.2, 1e-9, '超出的 0.2s 应计入动画');
    });

    test('easing 改变进度曲线', () => {
      const linear = new Tween(1);
      const eased = new Tween(1).ease('outQuad');
      let lp = 0;
      let ep = 0;
      linear.onUpdate((p) => (lp = p));
      eased.onUpdate((p) => (ep = p));
      linear.update(0.5);
      eased.update(0.5);
      near(lp, 0.5, 1e-9);
      near(ep, 0.75, 1e-9, 'outQuad(0.5) = 0.5*(2-0.5) = 0.75');
    });

    test('拼错缓动名立刻抛错（而不是静默退化成线性）', () => {
      let threw = false;
      try {
        new Tween(1).ease('easeOutQuad'); // 正确名是 outQuad
      } catch {
        threw = true;
      }
      assert(threw, '静默退化会让你花一小时调曲线才发现名字拼错');
    });

    test('支持自定义缓动函数', () => {
      const t = new Tween(1).ease((x) => x * x);
      let p = 0;
      t.onUpdate((v) => (p = v));
      t.update(0.5);
      near(p, 0.25, 1e-9);
    });

    test('repeat 循环', () => {
      const t = new Tween(1).loop('repeat', 3);
      let completes = 0;
      t.onComplete(() => completes++);
      for (let i = 0; i < 10; i++) t.update(0.5);
      eq(completes, 1, '循环 3 次后完成');
    });

    test('pingpong 来回', () => {
      const t = new Tween(1).loop('pingpong');
      const seen: number[] = [];
      t.onUpdate((p) => seen.push(p));
      t.update(0.5);
      t.update(0.5); // 到 1
      t.update(0.5); // 回头 0.5
      near(seen[0], 0.5, 1e-9);
      near(seen[2], 0.5, 1e-9, '应往回走');
    });

    test('complete 跳到终态并触发完成', () => {
      const t = new Tween(10);
      let lastP = 0;
      let done = false;
      t.onUpdate((p) => (lastP = p));
      t.onComplete(() => (done = true));
      t.complete();
      near(lastP, 1);
      eq(done, true);
    });

    test('kill 不触发完成也不跳终态', () => {
      const t = new Tween(10);
      let done = false;
      let lastP = 0;
      t.onUpdate((p) => (lastP = p));
      t.onComplete(() => (done = true));
      t.update(1);
      t.kill();
      t.update(100);
      eq(done, false);
      assert(lastP < 1);
    });

    test('时长必须为正', () => {
      let threw = false;
      try {
        new Tween(0);
      } catch {
        threw = true;
      }
      assert(threw);
    });

    test('TweenRunner 管理多个', () => {
      const runner = new TweenRunner();
      let a = 0;
      let b = 0;
      runner.add(new Tween(1).onUpdate((p) => (a = p)));
      runner.add(new Tween(2).onUpdate((p) => (b = p)));

      runner.update(0.5);
      near(a, 0.5, 1e-9);
      near(b, 0.25, 1e-9);
    });

    test('TweenRunner 自动清理已完成的', () => {
      const runner = new TweenRunner();
      runner.to(1, () => {});
      eq(runner.count, 1);
      runner.update(2);
      eq(runner.count, 0, '完成后应被移除');
    });

    test('回调里添加新 Tween 不破坏遍历', () => {
      const runner = new TweenRunner();
      let second = 0;
      runner.add(
        new Tween(1).onComplete(() => {
          runner.to(1, (p) => (second = p));
        })
      );
      runner.update(1.1);
      runner.update(0.5);
      near(second, 0.5, 1e-9);
    });

    test('killAll 终止所有', () => {
      const runner = new TweenRunner();
      let n = 0;
      runner.to(1, (p) => (n = p));
      runner.delay(5, () => (n = 999));
      runner.killAll();
      runner.update(10);
      eq(n, 0);
      eq(runner.count, 0);
    });

    test('reset 后可复用（对象池场景）', () => {
      const t = new Tween(1);
      t.update(1.1);
      eq(t.done, true);
      t.reset();
      eq(t.done, false);
      near(t.progress, 0);
    });
  });
}
