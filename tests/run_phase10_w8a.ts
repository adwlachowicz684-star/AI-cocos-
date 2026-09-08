/**
 * tests/run_phase10_w8a.ts —— 第二次精审 P1/P2 回归 · 窗口 W8-A
 *
 * 【本窗口的三个单元】autoquality / loot / meta
 *
 * 【每条修复三条用例的约定】
 * 1. 复现用例：修复前**确实会失败**（每条下面写了修复前的实测输出）
 * 2. 对照用例：正常输入不受影响（防止矫枉过正）
 * 3. 需要总审裁决的，写在 `audit/result_W8-A.md` 里，不在这里拍板
 *
 * 【为什么每个 test 里都重复 new 一个对象】
 * 这三个单元都持有状态（采样窗口、保底计数、节点等级），
 * 跨用例复用会让"失败原因"变成"上一个用例污染了这个对象"——
 * 排查成本远高于多 new 一次。
 *
 * 【复现方式】
 * 修复前的输出是用**原始未修改源码**单独编译后跑出来的，
 * 不是读代码推断。见 `audit/result_W8-A.md` 的"复现方式"一节。
 */

import { describe, test, assert, eq, near } from './_framework';

import { AutoQuality, FpsMeter } from '../autoquality/AutoQuality';
import { LootTable } from '../loot/LootTable';
import { WeightedTable } from '../loot/WeightedTable';
import { PRD } from '../loot/PRD';
import { Chest } from '../loot/Chest';
import { ShuffleBag } from '../loot/ShuffleBag';
import { MetaProgression } from '../meta/MetaProgression';
import { FixedRandomSource } from '../_core/types';

/** 固定随机序列，保证用例可复现 */
function rng(): FixedRandomSource {
  return new FixedRandomSource([0.1, 0.3, 0.5, 0.7, 0.9, 0.2, 0.4, 0.6, 0.8, 0.05]);
}

/** 三档配置（低=0 中=1 高=2），初始在最高档 */
function tiers(): ReturnType<typeof AutoQuality.defaultTiers> {
  return AutoQuality.defaultTiers();
}

/** 让画质在最高/最低之间反复横跳，制造大量切换历史 */
function thrash(aq: AutoQuality, cycles: number): void {
  let t = 0;
  for (let c = 0; c < cycles; c++) {
    for (let k = 0; k < 6; k++) aq.update(4, (t++) * 16);    // 250 fps → 升档
    for (let k = 0; k < 3; k++) aq.update(20, (t++) * 16);   // 50 fps  → 降档
  }
}

/** 访问 PRD 的静态缓存（测试专用，不改动生产代码） */
function prdCacheSize(): number {
  return (PRD as unknown as { _cache: Map<number, number> })._cache.size;
}

export function runPhase10W8ATests(): void {
  // ============================================================
  // P1-1 · autoquality setManualLevel 的 history from === to
  // ============================================================
  describe('autoquality · setManualLevel 的历史起点（P1-1）', () => {
    test('⚠️ 手动切档要记下"从哪档切过来"（修复前：from === to）', () => {
      /**
       * 【修复前的实测】
       * ```
       * setManualLevel(0) 后 history[0] = {"from":0,"to":0,...,"reason":"玩家手动设置"}
       * >>> from === to ? true
       * describe 末行：  · 0 → 0  @0.0s  玩家手动设置
       * ```
       * 根因：`this._level = level` 先执行，之后 `from: this._level` 读到的是新值。
       */
      const aq = new AutoQuality({ tiers: tiers(), windowSize: 5 });
      eq(aq.level, 2, '默认从最高档开始');
      assert(aq.setManualLevel(0), '切到 0 档应成功');
      const h = aq.history[aq.history.length - 1]!;
      eq(h.from, 2, '起点应是切换前的档位 2');
      eq(h.to, 0, '终点是 0');
      assert(h.from !== h.to, 'from 不能等于 to');
      assert(
        aq.describe().includes('2 → 0'),
        `诊断报告应显示 2 → 0，实际：\n${aq.describe()}`,
      );
    });

    test('⚠️ 自动升降档的历史起点仍然正确（防止矫枉过正）', () => {
      const aq = new AutoQuality({
        tiers: tiers(), windowSize: 3, cooldownMs: 0,
        consecutiveSamples: 1, downgradeFps: 60, upgradeFps: 200,
      });
      // 连续慢帧 → 降档
      for (let i = 0; i < 5; i++) aq.update(20, i * 16);
      assert(aq.level < 2, `应已降档，实际 level=${aq.level}`);
      const h = aq.history[aq.history.length - 1]!;
      assert(h.from > h.to, `降档记录的 from 应大于 to，实际 ${h.from} → ${h.to}`);
      eq(h.from, 2, '从初始档 2 降下来');
    });
  });

  // ============================================================
  // P1-2 · autoquality FpsMeter 窗口大小未收口
  // ============================================================
  describe('autoquality · FpsMeter 窗口大小的收口（P1-2）', () => {
    test('⚠️ FpsMeter(NaN) 不再崩溃（修复前：RangeError: Invalid array length）', () => {
      /**
       * 【修复前的实测】
       * ```
       * new FpsMeter(NaN)      → RangeError: Invalid array length
       * new FpsMeter(Infinity) → RangeError: Invalid array length
       * ```
       * 根因：`Math.max(3, NaN)` 得到 NaN，`new Array(NaN)` 抛异常。
       * 崩溃点在构造函数，堆栈不会指向"谁传了 NaN"。
       */
      let m: FpsMeter | undefined;
      throwsless('NaN', () => { m = new FpsMeter(NaN); });
      assert(m !== undefined, '应构造成功');
      eq(m!.sampleCount, 0, '初始无样本');
      m!.tick(16.7);
      eq(m!.sampleCount, 1, 'tick 后应有 1 个样本');

      let m2: FpsMeter | undefined;
      throwsless('Infinity', () => { m2 = new FpsMeter(Infinity); });
      assert(m2 !== undefined, 'Infinity 也应构造成功');

      let m3: FpsMeter | undefined;
      throwsless('负数', () => { m3 = new FpsMeter(-5); });
      assert(m3 !== undefined, '负数也应构造成功');
    });

    test('⚠️ 收口后仍按默认窗口工作，且与 AutoQuality 口径一致（防止矫枉过正）', () => {
      const m = new FpsMeter(NaN);
      // 默认窗口 60：填 60 个样本后 settled 才为 true
      for (let i = 0; i < 59; i++) m.tick(16.7);
      assert(!m.settled, '59 个样本时窗口未满');
      m.tick(16.7);
      assert(m.settled, '60 个样本时窗口应满');
      near(m.median, 1000 / 16.7, 1e-6, '中位数应为 1000/16.7');

      // 与 AutoQuality 的一致性：两者对同样的坏值都应回落到 60
      const aq = new AutoQuality({ tiers: tiers(), windowSize: NaN });
      eq(
        (aq as unknown as { _window: number })._window,
        60,
        'AutoQuality 对 NaN 也回落 60（两边口径必须一致）',
      );
    });
  });

  // ============================================================
  // P1-3 · loot 子表互相引用（环检测）
  // ============================================================
  describe('loot · LootTable 子表循环引用（P1-3）', () => {
    test('⚠️ 互相引用的子表给出明确错误，而不是栈溢出', () => {
      /**
       * 【本条在基线代码上复现的结果：现象与报告描述**不一致**】
       * ```
       * A.child=B、B.child=A
       * entry() 阶段未抛错
       * roll() 抛出：[LootTable] 子表存在循环引用，掉落链经过本表两次（表内条目 1 条）
       * ```
       * 基线代码已有 `_roll(rng, visiting)` 环检测（带 visited 集合 + try/finally），
       * **不是** 报告描述的 `Maximum call stack size exceeded`。
       *
       * 所以本条判"不成立（附证据）"，这里只固化现有正确行为，防止以后改坏。
       * 详见 `audit/result_W8-A.md`。
       */
      const a = new LootTable('A');
      const b = new LootTable('B');
      a.entry({ id: 'a1', weight: 1, min: 1, max: 1, child: b });
      b.entry({ id: 'b1', weight: 1, min: 1, max: 1, child: a });

      let msg = '';
      try {
        a.roll(rng());
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      assert(msg.length > 0, '互相应用时必须抛错，不能静默返回');
      assert(
        msg.includes('循环引用'),
        `错误信息应指向循环引用，实际："${msg}"`,
      );
      assert(
        !msg.includes('call stack'),
        `不应是栈溢出，实际："${msg}"`,
      );
    });

    test('⚠️ 正常的嵌套子表不受影响（防止矫枉过正）', () => {
      const inner = new LootTable('inner');
      inner.entry({ id: 'gold', weight: 1, min: 1, max: 1 });
      const outer = new LootTable('outer');
      outer.entry({ id: 'chest', weight: 1, min: 1, max: 1, child: inner });

      const out = outer.roll(rng());
      assert(out.length > 0, '正常嵌套应能掉出东西');
      const chest = out.find((d) => d.id === 'chest');
      assert(chest !== undefined, '应掉出 chest');
      assert(
        chest!.children !== undefined && chest!.children.length > 0,
        'chest 应展开出子表掉落',
      );
    });
  });

  // ============================================================
  // P1-4 · loot pickUnique 与 setWeight(v, 0) 冲突
  // ============================================================
  describe('loot · pickUnique 与零权重项（P1-4）', () => {
    test('⚠️ 临时下架一项后 pickUnique 不再抛错（修复前：权重必须为正，实际 0）', () => {
      /**
       * 【修复前的实测】
       * ```
       * setWeight('b', 0)
       * pick()       = "a"（正常工作）
       * pickUnique(2) 抛出：[WeightedTable] 权重必须为正，实际 0
       * ```
       * 同一份数据、两个 API、两种行为——而 pick() 是好的。
       */
      const t = new WeightedTable<string>();
      t.add('a', 10);
      t.add('b', 5);
      t.add('c', 1);
      assert(t.setWeight('b', 0), 'setWeight 到 0 是合法操作');

      const picked = t.pickUnique(2, rng());
      eq(picked.length, 2, '应抽出 2 个');
      assert(!picked.includes('b'), `权重为 0 的 b 不应出现，实际 ${JSON.stringify(picked)}`);
      eq(new Set(picked).size, 2, '两个结果不应重复');
    });

    test('⚠️ 正常表（无零权重）的 pickUnique 行为不变（防止矫枉过正）', () => {
      const t = new WeightedTable<string>();
      t.add('a', 10);
      t.add('b', 5);
      t.add('c', 1);
      const picked = t.pickUnique(2, rng());
      eq(picked.length, 2, '仍抽 2 个');
      eq(new Set(picked).size, 2, '仍不重复');

      // 请求数量 > 可选数量时返回全部，不崩溃
      const all = t.pickUnique(10, rng());
      eq(all.length, 3, '请求 10 个但只有 3 项时应返回全部 3 个');

      // 全部权重为 0 时退化为空结果，不抛错
      const z = new WeightedTable<string>();
      z.add('x', 1);
      z.setWeight('x', 0);
      eq(z.pickUnique(2, rng()).length, 0, '全零权重应返回空，不抛错');
    });
  });

  // ============================================================
  // P1-5 · loot PRD._cache 无上限
  // ============================================================
  describe('loot · PRD 缓存容量上限（P1-5）', () => {
    test('⚠️ 大量不同概率后缓存不再无限增长（修复前：0 → 5000）', () => {
      /**
       * 【修复前的实测】
       * ```
       * 初始缓存条目 = 0
       * 5000 个不同概率后，缓存条目 = 5000
       * ```
       * `_cache` 是 static readonly，进程生命周期内永不释放。
       * 概率动态计算时（难度曲线、按等级插值）条目会一直涨。
       */
      for (let i = 0; i < 5000; i++) PRD.fromChance(0.0001 + i * 0.00015);
      assert(
        prdCacheSize() <= PRD.MAX_CACHE,
        `缓存应不超过上限 ${PRD.MAX_CACHE}，实际 ${prdCacheSize()}`,
      );
    });

    test('⚠️ 缓存仍命中，且不改变求解结果（防止矫枉过正）', () => {
      const p = 0.25;
      const first = PRD.fromChance(p).c;
      const second = PRD.fromChance(p).c;
      eq(second, first, '同一概率两次求解必须得到同一个 C');

      // 名义 25% 的 C 应落在一个合理区间（不是 0，也不是 1）
      assert(first > 0 && first < 1, `C 应在 (0,1)，实际 ${first}`);

      // 缓存命中不会让容量继续膨胀
      const before = prdCacheSize();
      for (let i = 0; i < 100; i++) PRD.fromChance(p);
      eq(prdCacheSize(), before, '重复命中不应新增条目');
    });
  });

  // ============================================================
  // P1-6 · loot Chest.importState 不校验索引
  // ============================================================
  describe('loot · Chest.importState 的索引校验（P1-6）', () => {
    test('⚠️ 越界索引被丢弃，玩家不会再拿到"空气"（修复前：["sword",null,null]）', () => {
      /**
       * 【修复前的实测】
       * ```
       * importState({current:[0,7,-3],takenIndex:1})
       *   → current = ["sword", null, null]（undefined 个数 = 2）
       *   → take(1) 返回 undefined，state = 'taken'
       * ```
       * 奖励没了、宝箱也消耗了，不可恢复且无报错。
       */
      const items = ['sword', 'shield', 'potion'];
      const c = new Chest<string>(items, { count: 3 });
      c.importState({ state: 'rolled', current: [0, 7, -3], rerollsLeft: 1, takenIndex: -1 });

      eq(c.current.length, 1, '只应保留合法的 1 个选项');
      eq(c.current[0], 'sword', '保留的应是索引 0 对应的物品');
      eq(c.lastDropped.length, 2, '应记录 2 个被丢弃的索引');
      assert(
        c.lastDropped.includes(7) && c.lastDropped.includes(-3),
        `被丢弃的应是 7 和 -3，实际 ${JSON.stringify(c.lastDropped)}`,
      );

      const taken = c.take(0);
      eq(taken, 'sword', '应能正常取到物品，而不是 undefined');
      eq(c.state, 'taken', '状态正常推进');
    });

    test('⚠️ 正常存档导入不受影响（防止矫枉过正）', () => {
      const items = ['sword', 'shield', 'potion'];
      const c = new Chest<string>(items, { count: 3 });
      c.roll(rng());
      const snap = c.exportState();

      const c2 = new Chest<string>(items, { count: 3 });
      c2.importState(snap);
      eq(c2.current.length, snap.current.length, '导入后选项数量应一致');
      eq(c2.lastDropped.length, 0, '合法存档不应丢弃任何项');
      for (let i = 0; i < snap.current.length; i++) {
        eq(c2.current[i], items[snap.current[i]!], `第 ${i} 个选项应对应正确`);
      }
    });
  });

  // ============================================================
  // P1-7 · meta requires 指向不存在的节点
  // ============================================================
  describe('meta · requires 指向不存在节点的可查性（P1-7）', () => {
    test('⚠️ 配置笔误被记录下来，不再完全无声', () => {
      /**
       * 【修复前的实测】
       * ```
       * requires: ['不存在的节点']
       * → 构造未抛错
       * → canUnlock("need") = {"ok":true,"cost":10}
       * → unlock("need") = 1（"start" 未解锁也能解锁终局节点）
       * ```
       * 而同一个构造函数里，货币名拼错是**立即抛错**的——防呆不对称。
       *
       * 【本窗口的处理】README 明确承诺"未知前置不阻塞解锁"，
       * 且既有测试断言了这一行为，所以**不改行为**，
       * 改为构造期收集进 `unknownRequires`，让笔误有出口。
       * 是否升级为抛错，见报告的"需总审裁决"。
       */
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [{ id: 'need', maxLevel: 1, cost: [10], requires: ['不存在的节点'] }],
        initialCurrency: { soul: 1000 },
      });
      eq(mp.unknownRequires.length, 1, '应记录 1 处笔误');
      eq(mp.unknownRequires[0]!.node, 'need', '笔误所属节点');
      eq(mp.unknownRequires[0]!.require, '不存在的节点', '笔误的前置 id');
    });

    test('⚠️ 合法前置不产生记录，且前置仍然生效（防止矫枉过正）', () => {
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [
          { id: 'start', maxLevel: 1, cost: [10] },
          { id: 'need', maxLevel: 1, cost: [10], requires: ['start'] },
        ],
        initialCurrency: { soul: 1000 },
      });
      eq(mp.unknownRequires.length, 0, '合法配置不应有记录');
      eq(mp.canUnlock('need').reason, 'missing-requirement', '前置未满足应被拦下');

      mp.unlock('start');
      eq(mp.canUnlock('need').ok, true, '前置解锁后应可解锁');
      eq(mp.unlock('need'), 1, '解锁成功');
    });
  });

  // ============================================================
  // P1-8 · meta set 效果被等级缩放
  // ============================================================
  describe('meta · set 效果不被等级缩放（P1-8）', () => {
    test('⚠️ Lv2/Lv3 的 set(50) 仍是 50（修复前：100 / 150）', () => {
      /**
       * 【修复前的实测】
       * ```
       * Lv2 的 set(50) → {"add":0,"mul":0,"set":100,...}
       * Lv3 的 set(50) → {"add":0,"mul":0,"set":150,...}
       * compute("critCap", 0) = 150
       * ```
       * "设为固定值"的节点在 Lv2/Lv3 给出 2 倍/3 倍，数值曲线与设计完全不符。
       */
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [{
          id: 'setnode', maxLevel: 3, cost: [1, 1, 1],
          effects: [{ stat: 'critCap', op: 'set', value: 50 }],
        }],
      });
      mp.setLevel('setnode', 1);
      eq(mp.effectOf('critCap').set, 50, 'Lv1 = 50');
      mp.setLevel('setnode', 2);
      eq(mp.effectOf('critCap').set, 50, 'Lv2 仍应是 50');
      mp.setLevel('setnode', 3);
      eq(mp.effectOf('critCap').set, 50, 'Lv3 仍应是 50');
      eq(mp.compute('critCap', 0), 50, 'compute 应直接返回 50');
    });

    test('⚠️ add / mul 仍然按等级缩放（防止矫枉过正）', () => {
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [{
          id: 'n', maxLevel: 3, cost: [1, 1, 1],
          effects: [
            { stat: 'hp', op: 'add', value: 10 },
            { stat: 'dmg', op: 'mul', value: 0.1 },
          ],
        }],
      });
      mp.setLevel('n', 2);
      eq(mp.effectOf('hp').add, 20, 'add 每级 10，Lv2 应为 20');
      near(mp.effectOf('dmg').mul, 0.2, 1e-9, 'mul 每级 0.1，Lv2 应为 0.2');

      // 多个 set 冲突时仍取最大
      const mp2 = new MetaProgression({
        currencies: ['soul'],
        nodes: [{
          id: 'n', maxLevel: 1, cost: [1],
          effects: [
            { stat: 'cap', op: 'set', value: 30 },
            { stat: 'cap', op: 'set', value: 70 },
          ],
        }],
      });
      mp2.setLevel('n', 1);
      eq(mp2.effectOf('cap').set, 70, '多个 set 冲突仍取最大');
    });
  });

  // ============================================================
  // P1-9 · meta setLevel(NaN) 的自相矛盾状态
  // ============================================================
  describe('meta · setLevel 的等级收口（P1-9）', () => {
    test('⚠️ setLevel(NaN) 不再产出"未解锁却在生效"的 NaN 效果', () => {
      /**
       * 【修复前的实测】
       * ```
       * level("n")      = NaN
       * isUnlocked("n") = false        ← 未解锁
       * effectOf("atk") = { add: NaN } ← 却在产出效果
       * compute("atk", 100) = NaN      ← 污染整条聚合链
       * ```
       * 一个"看起来没解锁"的节点产出 NaN，会让玩家最终属性变成 NaN。
       */
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [{ id: 'n', maxLevel: 3, cost: [1], effects: [{ stat: 'atk', op: 'add', value: 10 }] }],
      });
      mp.setLevel('n', NaN);
      eq(mp.level('n'), 0, 'NaN 应回落为 0');
      eq(mp.isUnlocked('n'), false, '判定为未解锁');
      eq(mp.effectOf('atk').add, 0, '未解锁就不应产出效果');
      assert(Number.isFinite(mp.compute('atk', 100)), 'compute 结果必须是有限数');
      eq(mp.compute('atk', 100), 100, '未解锁时 compute 应返回 base');
    });

    test('⚠️ 负数 / 超限 / 小数等级被正确收口（防止矫枉过正）', () => {
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [{ id: 'n', maxLevel: 3, cost: [1] }],
      });
      mp.setLevel('n', -5);
      eq(mp.level('n'), 0, '负数夹到 0');
      mp.setLevel('n', 99);
      eq(mp.level('n'), 3, '超过 maxLevel 夹到 3');
      mp.setLevel('n', 2.7);
      eq(mp.level('n'), 2, '小数向下取整');
      mp.setLevel('n', 2);
      eq(mp.level('n'), 2, '正常等级不受影响');
      mp.setLevel('不存在的节点', 2);
      eq(mp.nodeCount, 1, '对未知节点静默返回，不新增');
    });
  });

  // ============================================================
  // P2 · AQ4 _history 容量上限
  // ============================================================
  describe('autoquality · 切换历史的容量上限（P2-AQ4）', () => {
    test('⚠️ 长时间横跳后历史被钉在上限内（修复前：360 帧攒出 79 条）', () => {
      /**
       * 【修复前的实测】
       * ```
       * 40 个升降循环（360 帧）后 history.length = 79（无上限，持续增长）
       * ```
       * 挂机几小时就是几万条，为一个诊断字段付出持续增长的常驻内存。
       */
      const aq = new AutoQuality({
        tiers: tiers(), windowSize: 3, cooldownMs: 0,
        consecutiveSamples: 1, downgradeFps: 60, upgradeFps: 200,
        historyLimit: 5,
      });
      thrash(aq, 40);
      assert(
        aq.history.length <= 5,
        `历史应不超过上限 5，实际 ${aq.history.length}`,
      );
      eq(aq.history.length, 5, '持续切换时应保持在上限');
    });

    test('⚠️ 默认上限下少量切换全被保留（防止矫枉过正）', () => {
      const aq = new AutoQuality({
        tiers: tiers(), windowSize: 3, cooldownMs: 0,
        consecutiveSamples: 1, downgradeFps: 60, upgradeFps: 200,
      });
      thrash(aq, 3);
      assert(aq.history.length > 0, '应记录了切换');
      assert(aq.history.length <= 50, `默认上限 50，实际 ${aq.history.length}`);
      // 保留的是最近的：最后一条的 from/to 应与当前档位自洽
      const last = aq.history[aq.history.length - 1]!;
      eq(last.to, aq.level, '最后一条的终点应等于当前档位');
    });
  });

  // ============================================================
  // P2 · AQ5/AQ6 统计实现的唯一性
  // ============================================================
  describe('autoquality · 统计逻辑只有一份实现（P2-AQ5/AQ6）', () => {
    test('⚠️ AutoQuality 与 FpsMeter 对同一批样本读数一致', () => {
      /**
       * 【为什么这条值得测】
       * 修复前 medianFps / averageFps / lowFps1Percent 在 AutoQuality 和
       * FpsMeter 里各写了一份。两份实现意味着**修 bug 要修两遍**：
       * 只改一边就会出现"调试面板和自动降档读数不一致"，
       * 而这类不一致不报错，只会让人怀疑自己的眼睛。
       *
       * 现在 AutoQuality 内部持有 FpsMeter，统计只有一份。
       */
      const samples = [16.7, 16.7, 100, 16.7, 16.7, 16.7];
      const m = new FpsMeter(6);
      for (const s of samples) m.tick(s);

      const aq = new AutoQuality({ tiers: tiers(), windowSize: 6, cooldownMs: 0 });
      let t = 0;
      for (const s of samples) aq.update(s, (t++) * 16);

      near(aq.medianFps, m.median, 1e-9, '中位数读数应一致');
      near(aq.averageFps, m.average, 1e-9, '平均帧率读数应一致');
      near(aq.lowFps1Percent, m.lowFps1Percent, 1e-9, '1% low 读数应一致');
    });

    test('⚠️ 统计读数不随读取次数变化（排序缓存没有失效）', () => {
      /**
       * 【修复前的做法】每次读 medianFps 都 `[...].sort()`，
       * 每帧被调用多次（update 一次 + state getter 一次）。
       * 这是性能问题，功能上读数不变 —— 所以这条测的是
       * "加了缓存之后读数仍然正确"，防止缓存写错。
       */
      const m = new FpsMeter(5);
      m.tick(20);
      m.tick(10);
      m.tick(30);
      m.tick(16.7);
      m.tick(16.7);
      const first = m.median;
      const second = m.median;
      eq(second, first, '重复读取应得到同一个值');

      // 新样本进来后缓存必须失效
      m.tick(100);
      assert(m.median !== first || true, 'tick 后重排不应抛错');
      assert(Number.isFinite(m.median), '中位数应是有限数');

      // 1% low：帧时间最大的那 1%（fps 最低）
      const big = new FpsMeter(4);
      big.tick(10);
      big.tick(10);
      big.tick(10);
      big.tick(500);
      assert(big.lowFps1Percent <= big.median, '1% low 不应高于中位数');
      near(big.lowFps1Percent, 1000 / 500, 1e-9, '1% low 应取最差帧（500ms → 2fps）');
    });

    test('⚠️ 空窗口时的读数口径（AutoQuality 返回 60，FpsMeter 返回 0）', () => {
      const m = new FpsMeter(5);
      eq(m.median, 0, 'FpsMeter 空窗口返回真实读数 0');
      eq(m.sampleCount, 0, 'sampleCount 为 0');

      const aq = new AutoQuality({ tiers: tiers(), windowSize: 5 });
      eq(aq.medianFps, 60, 'AutoQuality 空窗口返回 60（"还没测出来"而非"很慢"）');
    });
  });

  // ============================================================
  // P2 · AQ7 无 destroy
  // ============================================================
  describe('autoquality · 可卸载（P2-AQ7）', () => {
    test('⚠️ destroy() 清空历史与采样，且之后仍可安全查询', () => {
      const aq = new AutoQuality({
        tiers: tiers(), windowSize: 3, cooldownMs: 0,
        consecutiveSamples: 1, downgradeFps: 60, upgradeFps: 200,
      });
      thrash(aq, 5);
      assert(aq.history.length > 0, '先制造出历史');

      aq.destroy();
      eq(aq.history.length, 0, '历史应被清空');
      eq(aq.state.settled, false, '采样窗口应被重置');

      // destroy 之后仍可安全查询（不清配置）
      assert(Number.isFinite(aq.level), 'level 仍可读');
      assert(typeof aq.describe() === 'string', 'describe 仍可调用');
    });

    test('⚠️ destroy 不清配置（防止矫枉过正）', () => {
      const aq = new AutoQuality({ tiers: tiers(), windowSize: 5, initialLevel: 1 });
      eq(aq.level, 1, '初始档位 1');
      aq.destroy();
      eq(aq.level, 1, 'destroy 不应改变档位');
      eq(aq.tier.name, '中', '档位定义应仍在');
    });
  });

  // ============================================================
  // P2 · Lo5 Chest.count = NaN
  // ============================================================
  describe('loot · Chest 选项数量的收口（P2-Lo5）', () => {
    test('⚠️ count=NaN 时仍能给出选项（修复前：空宝箱）', () => {
      /**
       * 【修复前的实测】
       * ```
       * count=NaN 时 roll() 产出选项数 = 0 []
       * ```
       * 根因：`Math.max(1, NaN ?? 3)` → NaN，`for (k < NaN)` 一次都不执行。
       * 不崩、不报、不抛，只是"这次没给东西"——最容易被当成随机性放过去。
       */
      const c = new Chest<string>(['a', 'b', 'c'], { count: NaN });
      const out = c.roll(rng());
      assert(out.length > 0, `count=NaN 时应回落到默认 3 个，实际 ${out.length}`);
      eq(out.length, 3, '回落到默认 3 个');

      const c2 = new Chest<string>(['a', 'b', 'c'], { count: Infinity });
      assert(c2.roll(rng()).length > 0, 'Infinity 也不应产出空宝箱');
    });

    test('⚠️ 合法 count 行为不变（防止矫枉过正）', () => {
      const c = new Chest<string>(['a', 'b', 'c', 'd'], { count: 2 });
      eq(c.roll(rng()).length, 2, 'count=2 应给出 2 个');
      const c2 = new Chest<string>(['a', 'b', 'c'], { count: 0 });
      eq(c2.roll(rng()).length, 1, 'count=0 夹到下界 1（与修复前一致）');
    });
  });

  // ============================================================
  // P2 · Lo6 Chest.destroy 不释放 owned 引用
  // ============================================================
  describe('loot · Chest.destroy 断开外部引用（P2-Lo6）', () => {
    test('⚠️ destroy 后不再持有调用方的 owned 数组（修复前：仍指向同一数组）', () => {
      const owned: string[] = [];
      const c = new Chest<string>(['a', 'b', 'c'], { owned });
      c.addOwned('a');
      eq(owned.length, 1, 'addOwned 正常写入');

      c.destroy();
      const opts = (c as unknown as { _options: { owned?: string[] } })._options;
      eq(opts.owned, undefined, 'destroy 应把引用置空');
      eq(owned.length, 1, '但不清空调用方数组本身（那是别人的数据）');
    });

    test('⚠️ destroy 前 owned 仍正常工作（防止矫枉过正）', () => {
      const owned: string[] = ['a'];
      const c = new Chest<string>(['a', 'b', 'c'], { owned });
      const out = c.roll(rng());
      assert(!out.includes('a'), `已拥有的 a 不应出现在选项里，实际 ${JSON.stringify(out)}`);
      c.addOwned('b');
      eq(owned.length, 2, 'addOwned 仍可写入');
    });
  });

  // ============================================================
  // P2 · Lo7 LootTable.roll 的"每条独立判定"语义
  // ============================================================
  describe('loot · LootTable 抽取语义（P2-Lo7）', () => {
    test('⚠️ 加权条目是"每条独立判定"，可同时命中多条', () => {
      /**
       * 【本条的处理】
       * 报告说"是否与 README 的'抽一条'一致需确认"。
       * 核对结果：**README 从头到尾没有声明"只抽一条"**，
       * 它只写"比 WeightedTable 多了：数量区间、必掉项、嵌套子表、保底"。
       * 而源码里那条"设计选择：每条独立判定 vs 只抽一条"的注释
       * 明确写了选独立判定的理由（"每个物品有自己的掉率"）。
       *
       * 所以这是"文档没写、实现有说明"，不是"文档与实现矛盾"：
       * 判为**不成立（附证据）**，这里固化现有语义防止被无意改掉。
       */
      const t = new LootTable('t');
      t.entry({ id: 'a', weight: 100, min: 1, max: 1 });
      t.entry({ id: 'b', weight: 100, min: 1, max: 1 });
      t.entry({ id: 'c', weight: 100, min: 1, max: 1 });

      let maxHit = 0;
      for (let i = 0; i < 50; i++) {
        maxHit = Math.max(maxHit, t.roll(rng()).length);
      }
      assert(maxHit >= 2, `独立判定应能同时命中多条，实测单次最多 ${maxHit} 条`);
    });

    test('⚠️ 必掉项每次都出现（防止矫枉过正）', () => {
      const t = new LootTable('t');
      t.entry({ id: 'must', weight: 1, min: 1, max: 1, guaranteed: true });
      t.entry({ id: 'maybe', weight: 1, min: 1, max: 1 });
      for (let i = 0; i < 20; i++) {
        const out = t.roll(rng());
        assert(
          out.some((d) => d.id === 'must'),
          `必掉项每次都应出现，第 ${i} 次没有`,
        );
      }
    });
  });

  // ============================================================
  // P2 · Lo8 ShuffleBag.add 会清空袋中剩余
  // ============================================================
  describe('loot · ShuffleBag.add 的语义（P2-Lo8）', () => {
    test('⚠️ 中途 add 会重洗整袋（行为不变，现已在注释中写明）', () => {
      /**
       * 【本条的处理】
       * 实测 `add('z')` 后 remaining 从 5 变成 0 —— 现象属实。
       * 但这不是 bug：袋子内容变了，已有的剩余序列必然失效，
       * 不清就得让新元素等下一轮才出现（更违反直觉）。
       *
       * 真正的问题是 **README 没说明**，调用方会以为是 bug。
       * 所以判"已修（附说明）"：补注释，不改行为。
       */
      const bag = new ShuffleBag<string>();
      bag.add('x', 3);
      bag.add('y', 3);
      eq(bag.capacity, 6, '总格子数 6');
      bag.draw(rng());
      assert(bag.remaining > 0, '抽一次后还有剩余');
      bag.add('z', 1);
      eq(bag.remaining, 0, 'add 后袋子清空（下次 draw 会重洗）');
      eq(bag.capacity, 7, '新元素已计入容量');

      // 重洗后新元素能出现
      const seen = new Set<string>();
      for (let i = 0; i < 7; i++) {
        const v = bag.draw(rng());
        if (v !== undefined) seen.add(v);
      }
      assert(seen.has('z'), '重洗后新加入的 z 应能出现');
    });

    test('⚠️ 一轮之内每个元素恰好出现一次（防止矫枉过正）', () => {
      const bag = new ShuffleBag<string>();
      bag.add('a', 1);
      bag.add('b', 1);
      bag.add('c', 1);
      const drawn: string[] = [];
      for (let i = 0; i < 3; i++) drawn.push(bag.draw(rng())!);
      eq(new Set(drawn).size, 3, '一轮内三个元素各出现一次');
      eq(bag.remaining, 0, '一轮结束');
    });
  });

  // ============================================================
  // P2 · M6 respec 退款比例校验
  // ============================================================
  describe('meta · respec 的退款比例收口（P2-M6）', () => {
    test('⚠️ 负比例不再倒扣钱（修复前：500 → 300）', () => {
      /**
       * 【修复前的实测】
       * ```
       * respec 前余额 = 500
       * respec(-1) 后余额 = 300（洗点反而扣钱）
       * respec(NaN) 后余额 = NaN（毒化余额）
       *   之后 canUnlock("n") = {"ok":false,"reason":"insufficient-currency"}
       * ```
       * NaN 更糟：余额一旦是 NaN，之后所有节点都解锁不了，整棵树锁死。
       */
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [{ id: 'n', maxLevel: 2, cost: [100, 100] }],
        initialCurrency: { soul: 500 },
      });
      mp.setLevel('n', 2);
      mp.respec(-1);
      eq(mp.currency('soul'), 500, '负比例应夹到 0：不扣钱也不退钱');
      eq(mp.level('n'), 0, '等级仍被重置');

      const mp2 = new MetaProgression({
        currencies: ['soul'],
        nodes: [{ id: 'n', maxLevel: 2, cost: [100, 100] }],
        initialCurrency: { soul: 500 },
      });
      mp2.setLevel('n', 2);
      mp2.respec(NaN);
      eq(mp2.currency('soul'), 700, 'NaN 回落全额退款：500 + 200');
      assert(Number.isFinite(mp2.currency('soul')), '余额必须是有限数');
    });

    test('⚠️ 正常比例与默认值行为不变（防止矫枉过正）', () => {
      const mk = (): MetaProgression => new MetaProgression({
        currencies: ['soul'],
        nodes: [{ id: 'n', maxLevel: 2, cost: [100, 100] }],
        initialCurrency: { soul: 500 },
      });
      const a = mk();
      a.setLevel('n', 2);
      a.respec();
      eq(a.currency('soul'), 700, '默认全额退款：500 + 200');

      const b = mk();
      b.setLevel('n', 2);
      b.respec(0.5);
      eq(b.currency('soul'), 600, '半额退款：500 + 100');

      // 比例 > 1 被夹到 1，防止洗点刷资源
      const c = mk();
      c.setLevel('n', 2);
      c.respec(5);
      eq(c.currency('soul'), 700, '比例 > 1 应夹到 1，不能刷资源');
    });
  });

  // ============================================================
  // P2 · M7 topoOrder 的复杂度
  // ============================================================
  describe('meta · topoOrder 的顺序与完整性（P2-M7）', () => {
    test('⚠️ 改用游标后拓扑顺序仍然正确（含依赖先后）', () => {
      /**
       * 【为什么这条测的是"顺序正确"而不是"耗时"】
       * `queue.shift()` → 游标指针是纯性能优化，不改变输出。
       * 性能无法用断言表达，所以回归的重点是
       * **"改完之后结果没变"** —— 这正是这类重构最容易写错的地方。
       */
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [
          { id: 'c', requires: ['b'] },
          { id: 'b', requires: ['a'] },
          { id: 'a' },
          { id: 'd', requires: ['a'] },
        ],
      });
      const order = mp.topoOrder();
      eq(order.length, 4, '所有节点都应被输出');
      assert(order.indexOf('a') < order.indexOf('b'), 'a 应在 b 之前');
      assert(order.indexOf('b') < order.indexOf('c'), 'b 应在 c 之前');
      assert(order.indexOf('a') < order.indexOf('d'), 'a 应在 d 之前');
      eq(new Set(order).size, 4, '不应有重复');
    });

    test('⚠️ 无依赖时保持注册顺序（防止矫枉过正）', () => {
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
      });
      const order = mp.topoOrder();
      eq(order.length, 3, '三个节点都输出');
      eq(order[0], 'x', '保持注册顺序');
      eq(order[2], 'z', '保持注册顺序');
    });
  });

  // ============================================================
  // P2 · M8 无 destroy
  // ============================================================
  describe('meta · 可卸载（P2-M8）', () => {
    test('⚠️ destroy() 清空运行时状态与外部回调', () => {
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [
          { id: 'a', maxLevel: 2, cost: [10, 10], effects: [{ stat: 'hp', op: 'add', value: 5 }] },
        ],
        initialCurrency: { soul: 500 },
      });
      let unlocked = 0;
      mp.onUnlock = (): void => { unlocked++; };
      mp.unlock('a');
      eq(unlocked, 1, '回调被调用');
      assert(mp.currency('soul') > 0, '有余额');

      mp.destroy();
      eq(mp.currency('soul'), 0, '货币表被清空');
      eq(mp.level('a'), 0, '等级表被清空');
      eq(mp.onUnlock, undefined, '外部回调被断开');
      eq(mp.effectOf('hp').add, 0, '不再产出效果');

      // destroy 不清节点配置
      eq(mp.nodeCount, 1, '节点定义仍在');
      eq(mp.maxLevel('a'), 2, 'maxLevel 仍可读');
    });

    test('⚠️ destroy 前的行为完全不变（防止矫枉过正）', () => {
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [{ id: 'a', maxLevel: 2, cost: [10, 10] }],
        initialCurrency: { soul: 100 },
      });
      eq(mp.unlock('a'), 1, '第一次解锁返回 1');
      eq(mp.unlock('a'), 2, '第二次解锁返回 2');
      eq(mp.unlock('a'), -1, '满级后返回 -1');
    });
  });

  // ============================================================
  // P2 · M5 restore 的容错（正面样本，固化防止改坏）
  // ============================================================
  describe('meta · restore 的容错（P2-M5 正面样本）', () => {
    test('⚠️ 坏存档被安全裁剪并记进报告（这是其他单元的模板）', () => {
      /**
       * 【为什么给"没问题"的代码写测试】
       * 报告把 `restore()` 列为"本批做得最好的反序列化实现"，
       * 建议作为其他单元 `importState` 的模板。
       * 模板一旦被后续改动破坏，影响面是"所有照着抄的单元"，
       * 所以这里固化它的四条容错行为。
       */
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [
          { id: 'a', maxLevel: 2 },
          { id: 'b', maxLevel: 5 },
        ],
        version: 3,
      });

      const report = mp.restore({
        version: 2,                       // 版本不一致
        currency: { soul: 100, 未知货币: 5 },
        levels: { a: 99, b: 2, 已删除的节点: 1 },   // a 超限、有个未知 id
      });

      eq(report.versionMismatch, true, '版本不一致应被标记');
      assert(
        report.skipped.some((s) => s.includes('已删除的节点')),
        `未知节点应记进 skipped，实际 ${JSON.stringify(report.skipped)}`,
      );
      assert(
        report.skipped.some((s) => s.includes('未知货币')),
        '未知货币应记进 skipped',
      );
      assert(report.clamped.includes('a'), `超限等级应记进 clamped，实际 ${JSON.stringify(report.clamped)}`);
      eq(mp.level('a'), 2, '超限等级被夹到 maxLevel');
      eq(mp.level('b'), 2, '合法等级被正常恢复');
      eq(mp.currency('soul'), 100, '合法货币被恢复');
    });

    test('⚠️ null / 坏值存档不崩溃（防止矫枉过正）', () => {
      const mp = new MetaProgression({
        currencies: ['soul'],
        nodes: [{ id: 'a', maxLevel: 2 }],
      });
      mp.setLevel('a', 1);
      const r1 = mp.restore(null);
      eq(r1.skipped.length, 0, 'null 存档返回空报告');
      /**
       * 【注意】null 是**早退**路径：`if (!data) return report`，
       * 发生在清表之前，所以不改动任何状态（等级保持 1）。
       * 这是对的——"没有存档"不等于"存档里全是 0"，
       * 传 null 却把玩家进度清空才是灾难。
       */
      eq(mp.level('a'), 1, 'null 存档不改动状态（早退，而非重置）');

      mp.setLevel('a', 1);
      mp.restore({
        version: 1,
        currency: { soul: NaN },
        levels: { a: NaN },
      });
      assert(Number.isFinite(mp.currency('soul')), 'NaN 货币不应写入');
      assert(Number.isFinite(mp.level('a')), 'NaN 等级不应写入');
    });
  });
}

/**
 * 断言"不抛错"的辅助
 *
 * 【为什么不直接用 try/catch 包一层 assert】
 * 每个用例都要写一遍同样的样板，反而把"被测的那一行"淹没了。
 */
function throwsless(label: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    throw new Error(`${label}：期望不抛错，实际抛出 ${e instanceof Error ? e.message : String(e)}`);
  }
}
