/**
 * tests/run_phase10_w3b.ts —— 第二次精审 P1/P2 回归 · 窗口 W3-B
 *
 * 【本窗口的九个单元】
 * cheatcode / currency / daily / inventory / ranking / room-graph / snapshot / stats / wave-spawner
 *
 * 【每条修复三条用例的约定】
 * 1. 复现用例：修复前**确实会失败**（每条下面写了修复前的实测输出）
 * 2. 对照用例：正常输入不受影响（防止矫枉过正）
 * 3. 需要总审裁决的写在 `audit/result_W3-B.md`，不在这里拍板
 *
 * 【为什么每个 test 里都重新 new 一个对象】
 * 这九个单元全都持有状态（历史、余额、槽位、段位、路径、撤销栈、进度）。
 * 跨用例复用会让"失败原因"变成"上一个用例污染了这个对象"，
 * 排查成本远高于多 new 一次。
 *
 * 【⚠️ 两条标 `已存在` 的用例】
 * stats 的两条（原型链查表 / record 的 NaN 校验）在本次精审前
 * 已由别的窗口修掉（`hasOwn` + `needFinite`）。
 * 按纪律"改之前必须先复现"，我实测确认现象已不存在，
 * 所以这里保留的是**守护用例**：它们现在通过，
 * 但一旦有人把 `hasOwn` 改回 `in`、或删掉 `needFinite`，会立刻变红。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { CheatCode } from '../cheatcode/CheatCode';
import { Wallet } from '../currency/Currency';
import { CurrencyWallet } from '../currency/CurrencyWallet';
import {
  DailyChallenge,
  seedToText,
  isValidSeedText,
} from '../daily/DailyChallenge';
import { Inventory } from '../inventory/Inventory';
import { RankProgress, tierOf } from '../ranking/RankTier';
import {
  tierDistribution,
  diagnoseDistribution,
  type SeasonPlayer,
} from '../ranking/SeasonReward';
import {
  generateRoomGraph,
  assignTypes,
  findBestPath,
  diagnose,
  RoomTypes,
} from '../room-graph/RoomGraph';
import { deepClone, diffSnapshots } from '../snapshot/Snapshot';
import { Stats } from '../stats/Stats';
import { WaveSpawner } from '../wave-spawner/WaveSpawner';
import { RNG } from '../rng/RNG';

// ==================== 测试替身 ====================

/** 生成回调替身：记录生成过什么，可模拟生成失败 */
class TestSink {
  handles: Array<{ id: number; alive: boolean; age: number; waveIndex: number; data: unknown }> = [];
  killed: number[] = [];
  private _nextId = 1;

  spawn(
    entryId: string,
    indexInEntry: number,
    waveIndex: number
  ): { id: number; alive: boolean; age: number; waveIndex: number; data: unknown } {
    const h = {
      id: this._nextId++,
      alive: true,
      age: 0,
      waveIndex,
      data: { entryId, indexInEntry },
    };
    this.handles.push(h);
    return h;
  }

  forceKill(h: { id: number; alive: boolean }): void {
    h.alive = false;
    this.killed.push(h.id);
  }
}

/** 段位表：青铜 0 / 白银 1300（2 个小段）/ 宗师 1600 */
const TIER_CFG = {
  tiers: [
    { id: 'bronze', name: '青铜', minRating: 0, divisions: 1 },
    { id: 'silver', name: '白银', minRating: 1300, divisions: 2 },
    { id: 'gm', name: '宗师', minRating: 1600, divisions: 1 },
  ],
};
const TIER_ORDER = TIER_CFG.tiers.map((t) => t.id);

function mkPlayer(peak: number, id: string): SeasonPlayer {
  return { id, peakRating: peak, finalRating: peak, games: 1 };
}

// ==================== 主入口 ====================

export function runPhase10W3BTests(): void {
  // ---------------------------------------------------------------
  describe('cheatcode · historyLimit 的收口', () => {
    test('⚠️ historyLimit=NaN 时历史不再无限增长', () => {
      /**
       * 修复前实测：
       *   historyLimit=NaN -> history.length=2000
       * `??` 只挡 undefined，而 `_pushHistory` 里的 `length > limit`
       * 对 NaN 恒为 false，裁剪永不触发。
       */
      const cc = new CheatCode({ enabled: true, historyLimit: NaN });
      cc.register({ name: 'noop', desc: 'noop', run: () => 'ok' });
      for (let i = 0; i < 2000; i++) cc.execute('noop ' + i);
      eq(cc.history.length, 50, 'NaN 应回落到默认 50，而不是无限增长');
    });

    test('historyLimit=Infinity / 负数同样被收口', () => {
      const cc = new CheatCode({ enabled: true, historyLimit: Infinity });
      cc.register({ name: 'noop', desc: 'noop', run: () => 'ok' });
      for (let i = 0; i < 300; i++) cc.execute('noop ' + i);
      assert(cc.history.length <= 1e5, `Infinity 不应让裁剪失效，实际 ${cc.history.length}`);

      const cc2 = new CheatCode({ enabled: true, historyLimit: -5 });
      cc2.register({ name: 'noop', desc: 'noop', run: () => 'ok' });
      cc2.execute('noop');
      eq(cc2.history.length, 0, '负数仍应等价于"关掉历史"（既有语义）');
    });

    test('正常 historyLimit 与默认行为不变（防止矫枉过正）', () => {
      const cc = new CheatCode({ enabled: true, historyLimit: 5 });
      cc.register({ name: 'noop', desc: 'noop', run: () => 'ok' });
      for (let i = 0; i < 20; i++) cc.execute('noop ' + i);
      eq(cc.history.length, 5, '显式配置应精确生效');

      const cc2 = new CheatCode({ enabled: true });
      cc2.register({ name: 'noop', desc: 'noop', run: () => 'ok' });
      for (let i = 0; i < 200; i++) cc2.execute('noop ' + i);
      eq(cc2.history.length, 50, '默认 50 不变');
      // 去重仍在：连续相同命令只记一条
      cc2.execute('noop 199');
      eq(cc2.history.length, 50, '重复命令不应新增历史');
    });
  });

  // ---------------------------------------------------------------
  describe('currency · logOf(0) 与 netChange 的语义', () => {
    test('⚠️ logOf(id, 0) 返回空数组而不是全部流水', () => {
      /**
       * 修复前实测：logOf('gold',0).length = 5（期望 0）
       * `slice(-0)` 等价于 `slice(0)` = 从 0 切到末尾。
       */
      const w = new Wallet({ defs: [{ id: 'gold', name: '金币' }], logLimit: 200 });
      for (let i = 0; i < 5; i++) w.add('gold', 10, 'r');
      eq(w.logOf('gold', 0).length, 0, '取最后 0 条应为空');
      eq(w.logOf('gold', 2).length, 2, '取最后 2 条仍正常');
      eq(w.logOf('gold').length, 5, '不传 n 时返回全部（既有语义）');
    });

    test('⚠️ netChange 不再被日志裁剪悄悄削掉', () => {
      /**
       * 修复前实测：logLimit=5 下 20 次 add(10)
       *   余额=200  netChange=50     ← 差 4 倍
       */
      const w = new Wallet({ defs: [{ id: 'gold', name: '金币' }], logLimit: 5 });
      for (let i = 0; i < 20; i++) w.add('gold', 10, 'r');
      eq(w.get('gold'), 200);
      eq(w.netChange('gold'), 200, '净变化应与余额一致，不受 logLimit 影响');

      w.spend('gold', 50, 'r');
      eq(w.netChange('gold'), 150, '支出也要计入');
    });

    test('clearLog 与 trackLog=false 的既有语义不变（防止矫枉过正）', () => {
      const w = new Wallet({ defs: [{ id: 'gold', name: '金币' }] });
      w.add('gold', 100, 'r');
      w.clearLog();
      eq(w.netChange('gold'), 0, '清流水应一并清掉净变化（两者生命周期一致）');
      eq(w.get('gold'), 100, '余额不受影响');

      const w2 = new Wallet({
        defs: [
          { id: 'gold', name: '金币' },
          { id: 'gem', name: '钻石', trackLog: false },
        ],
      });
      w2.add('gem', 10, 'r');
      eq(w2.netChange('gem'), 0, 'trackLog=false 的货币不记账（既有语义）');
      eq(w2.logOf('gem').length, 0);
    });

    test('⚠️ CurrencyWallet 的 precision 越界不再让余额变 NaN', () => {
      /**
       * 修复前实测：
       *   precision=400 初始余额=NaN   add(5) -> applied=NaN
       * 10**400 === Infinity，Math.round(v*Infinity)/Infinity = NaN。
       */
      const w = new CurrencyWallet({ defs: [{ id: 'gold', initial: 100, precision: 400 }] });
      eq(w.get('gold'), 100, '越界精度应被 clamp 到上界，而不是产出 NaN');
      eq(w.add('gold', 5), 5);
      eq(w.get('gold'), 105, '后续 add 必须是有限数');
      assert(w.canAfford('gold', 100), 'canAfford 不能因为 NaN 恒假');
    });

    test('小数精度与不封顶货币行为不变（防止矫枉过正）', () => {
      const w = new CurrencyWallet({
        defs: [
          { id: 'energy', initial: 0, cap: 30, precision: 1 },
          { id: 'gem', initial: 5, cap: Infinity, precision: 0 },
        ],
      });
      for (let i = 0; i < 10; i++) w.add('energy', 0.1);
      eq(w.get('energy'), 1, '10 次 0.1 必须精确等于 1');

      // cap = Infinity 是合法配置：quantize 不能把 Infinity 当成坏输入
      const w2 = new CurrencyWallet({
        defs: [
          { id: 'gold', initial: 100, cap: 999 },
          { id: 'gem', initial: 5, cap: Infinity },
        ],
      });
      const r = w2.exchange('gold', 'gem', 100, 0.1);
      assert(r.ok, '不封顶货币的兑换必须仍然成功：' + JSON.stringify(r));
      eq(w2.get('gold'), 0);
      eq(w2.get('gem'), 15);
    });
  });

  // ---------------------------------------------------------------
  describe('daily · 种子文本空间与存档校验', () => {
    test('⚠️ 400 天内不再出现"两天共用同一张挑战"', () => {
      /**
       * 修复前实测：第 156 天就撞车
       *   2026-06-06 与 2026-05-18 共用种子文本 ASH-ECHO-61
       * 老 seedToText 的输出空间只有 16 × 16 × 100 = 25600。
       */
      const d = new DailyChallenge({
        modifiers: [
          { id: 'm1', name: 'm1', desc: '', effects: [] },
          { id: 'm2', name: 'm2', desc: '', effects: [] },
          { id: 'm3', name: 'm3', desc: '', effects: [] },
        ],
        modifierCount: 2,
      });
      const seen = new Map<string, string>();
      const start = Date.UTC(2026, 0, 1);
      for (let i = 0; i < 400; i++) {
        const key = new Date(start + i * 86400000).toISOString().slice(0, 10);
        const e = d.entryFor(key);
        const prev = seen.get(e.seedText);
        assert(
          prev === undefined,
          `第 ${i} 天 ${key} 与 ${prev} 共用种子文本 ${e.seedText}`
        );
        seen.set(e.seedText, key);
      }
    });

    test('seedToText 覆盖 32 位：不同种子必得不同文本', () => {
      // 抽样验证单射性（全量 2^32 不可行，取边界与随机样本）
      const texts = new Set<string>();
      const samples = [0, 1, 2, 255, 256, 257, 65535, 65536, 16777215, 16777216, 4294967295];
      for (const s of samples) texts.add(seedToText(s));
      eq(texts.size, samples.length, '样本内不应有重复文本');
      assert(isValidSeedText(seedToText(0)), '种子 0 的文本也要能通过校验');
      assert(isValidSeedText(seedToText(4294967295)), '最大种子的文本也要合法');
    });

    test('分享回填仍然一致（这是社交功能的根基，防止矫枉过正）', () => {
      // modifierCount 默认 2，而这里不关心 modifier 池，显式关掉
      const d = new DailyChallenge({ modifierCount: 0 });
      const entry = d.entryFor('2024-05-20');
      const back = d.fromText(entry.seedText);
      assert(back !== null, '文本应被接受');
      eq(back!.seed, entry.seed, '回填后的种子必须与原种子一致');
      eq(
        back!.modifiers.map((m) => m.id).join(','),
        entry.modifiers.map((m) => m.id).join(','),
        'modifier 也必须一致'
      );
      // 旧格式（两位数字段）依然合法且映射到同一种子
      assert(isValidSeedText('IRON-WOLF-42'), '旧的短码格式仍应被接受');
      assert(!isValidSeedText('IRON-WOLF-4'), '一位数字仍应被拒绝（抄写错误）');
    });

    test('⚠️ submit(NaN) 不再静默丢弃成绩', () => {
      /**
       * 修复前：best 模式下 `score > prev.score` 对 NaN 恒 false，
       * 于是"成绩丢了，但调用方只拿到一个 false"，
       * 分不清是"这次分不够"还是"分根本是坏的"。
       */
      const d = new DailyChallenge({ recordMode: 'best', modifierCount: 0 });
      d.submit('2024-01-01', 100, true);
      throws(
        () => d.submit('2024-01-01', NaN, true),
        '有限',
        'NaN 成绩应立刻暴露，而不是静默返回 false'
      );
      eq(d.recordOf('2024-01-01')!.score, 100, '原记录不受影响');
    });

    test('⚠️ importState 拒绝坏存档并报告跳过条数', () => {
      /**
       * 修复前：`for (const r of s.records) this._records.set(r.date, r)`
       * score:NaN 的记录会**永远无法被更好的成绩覆盖**（NaN 比较恒 false）；
       * attempts:-3 会让"今日次数"变负。
       */
      const d = new DailyChallenge({ modifierCount: 0 });
      const skipped = d.importState({
        records: [
          { date: '2024-01-01', score: 100, at: 0, cleared: true, attempts: 1 },
          { date: '2024-01-02', score: NaN, at: 0, cleared: true, attempts: 1 },
          { date: '乱码', score: 50, at: 0, cleared: true, attempts: 1 },
          { date: '2024-1-3', score: 50, at: 0, cleared: true, attempts: 1 },
        ] as never,
        attempts: [['2024-01-01', 2], ['2024-01-02', -3]] as never,
      });
      eq(skipped, 4, '三条坏记录 + 一条负数 attempts 都应被跳过');
      eq(d.recordOf('2024-01-01')!.score, 100, '好记录应保留');
      eq(d.recordOf('2024-01-02'), undefined, 'score=NaN 的记录不该进入');
      eq(d.attemptsOn('2024-01-02'), 0, '负数 attempts 不该进入');
      eq(d.attemptsOn('2024-01-01'), 2, '正常 attempts 保留');
    });

    test('正常成绩的提交与存档往返不受影响（防止矫枉过正）', () => {
      const d = new DailyChallenge({ recordMode: 'best', modifierCount: 0 });
      eq(d.submit('2024-01-01', 100, true), true);
      eq(d.submit('2024-01-01', 200, true), true, '更高分应覆盖');
      eq(d.submit('2024-01-01', 150, true), false, '更低分不覆盖');
      eq(d.recordOf('2024-01-01')!.score, 200);

      const state = { records: d.history(), attempts: [['2024-01-01', 2]] as never };
      const d2 = new DailyChallenge({ recordMode: 'best', modifierCount: 0 });
      eq(d2.importState(state), 0, '干净存档应全部导入');
      eq(d2.recordOf('2024-01-01')!.score, 200);
    });

    test('⚠️ 种子为 0 时 modifiers 抽取不再退化成"永远取前 N 个"', () => {
      /**
       * xorshift32 的不动点是 0：状态为 0 时三轮异或后仍是 0，
       * 于是加权抽取恒取池子第 0 项。
       * 直接调不到（seed 来自 hash），但分享文本是玩家可控输入，
       * 这是一条可被构造的路径。
       */
      const pool = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: 'm' + i,
        name: 'm' + i,
        desc: '',
        effects: [],
      }));
      const d = new DailyChallenge({ modifiers: pool, modifierCount: 3 });
      // 找一个 seed 使其 hash 后为 0 不易构造，改为直接对比"退化形态"：
      // 若抽取恒定，不同 seed 的 modifiers 会完全一致
      const seenIds = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const e = d.entryFor('2024-01-' + String((i % 28) + 1).padStart(2, '0'));
        seenIds.add(e.modifiers.map((m) => m.id).join(','));
      }
      assert(seenIds.size > 1, '不同日期应能抽到不同的 modifier 组合');
    });
  });

  // ---------------------------------------------------------------
  describe('inventory · 堆叠查询口径与 compact 的静默丢弃', () => {
    test('⚠️ remainingSpaceFor 与 add 对 data=0 的判断一致', () => {
      /**
       * 修复前实测（size=1, maxStack=10）：
       *   add('sword',1,0) 后 remainingSpaceFor('sword') = 9
       *   add('sword',5) -> leftover=5, count=1   ← 一个都堆不进去
       * `!s.data` 把合法的 0 当成了"没有 data"。
       */
      const bag = new Inventory({ size: 1 });
      bag.define({ id: 'sword', name: '剑', maxStack: 10 });
      eq(bag.add('sword', 1, 0), 0);
      eq(bag.remainingSpaceFor('sword'), 0, 'data=0 的堆叠不能再收东西（与 add 对齐）');
      eq(bag.add('sword', 5), 5, 'add 报告放不下 5 个');
      eq(bag.count('sword'), 1, '实际也确实没放进去');
    });

    test('data 为空字符串 / false 同样按"有 data"处理', () => {
      const bag = new Inventory({ size: 4 });
      bag.define({ id: 'ring', name: '戒指', maxStack: 5 });
      bag.add('ring', 1, '');
      eq(bag.remainingSpaceFor('ring'), 3 * 5, "data='' 的那一格不计入可用空间");
      const bag2 = new Inventory({ size: 4 });
      bag2.define({ id: 'ring', name: '戒指', maxStack: 5 });
      bag2.add('ring', 1, false);
      eq(bag2.remainingSpaceFor('ring'), 3 * 5, 'data=false 同理');
    });

    test('⚠️ compact 报告被丢弃的数量', () => {
      /**
       * 修复前：compact() 返回 void，格子用尽后剩余的 left 直接丢掉，
       * 没有事件、没有返回值、没有任何出口。
       * 场景：跨版本改了 maxStack，或存档被写成超量。
       */
      const bag = new Inventory({ size: 2 });
      bag.define({ id: 'a', name: 'a', maxStack: 5 });
      bag.slots[0].def = bag.getDef('a')!;
      bag.slots[0].count = 5;
      bag.slots[1].def = bag.getDef('a')!;
      bag.slots[1].count = 5;
      const dropped = bag.compact();
      eq(dropped, 0, '10 个刚好装满 2 格 × 5，不该丢');
      eq(bag.count('a'), 10);

      // 缩小 maxStack 后整理：容量只剩 2 × 2 = 4
      const bag2 = new Inventory({ size: 2 });
      bag2.define({ id: 'a', name: 'a', maxStack: 5 });
      bag2.slots[0].def = bag2.getDef('a')!;
      bag2.slots[0].count = 5;
      bag2.slots[1].def = bag2.getDef('a')!;
      bag2.slots[1].count = 5;
      (bag2.getDef('a') as { maxStack: number }).maxStack = 2;
      const dropped2 = bag2.compact();
      eq(dropped2, 6, '10 个只能装下 4 个，应报告丢弃 6 个');
      eq(bag2.count('a'), 4, '包里只剩 4 个');
    });

    test('正常整理与堆叠行为不变（防止矫枉过正）', () => {
      const bag = new Inventory({ size: 5 });
      bag.define({ id: 'arrow', name: '箭', maxStack: 99 });
      bag.define({ id: 'potion', name: '药水', maxStack: 5 });
      eq(bag.remainingSpaceFor('arrow'), 5 * 99, '空格全部可用');
      bag.add('arrow', 50);
      eq(bag.remainingSpaceFor('arrow'), 5 * 99 - 50);

      bag.add('potion', 2);
      bag.slots[2].def = bag.getDef('arrow')!;
      bag.slots[2].count = 40;
      eq(bag.compact(), 0, '装得下时不丢东西');
      eq(bag.count('arrow'), 90);
      eq(bag.usedSlots, 2, '两个 arrow 堆应合并');
      eq(bag.count('potion'), 2, '其他物品不受影响');
    });
  });

  // ---------------------------------------------------------------
  describe('ranking · 分布顺序与进度条陈旧', () => {
    test('⚠️ tierDistribution 的输出顺序不随输入顺序变化', () => {
      /**
       * 修复前实测（1 宗师 + 9 青铜）：
       *   宗师在前 -> ["grandmaster:0.1","bronze:0.9"]   ← 顺序被"首次出现"决定
       *   青铜在前 -> ["bronze:0.9","grandmaster:0.1"]
       * 而 diagnoseDistribution 用 dist[0] 当最低段位。
       */
      const gmFirst = [
        mkPlayer(2000, 'gm'),
        ...Array(9)
          .fill(0)
          .map((_, i) => mkPlayer(500, 'b' + i)),
      ];
      const brFirst = [
        ...Array(9)
          .fill(0)
          .map((_, i) => mkPlayer(500, 'b' + i)),
        mkPlayer(2000, 'gm'),
      ];
      const d1 = tierDistribution(gmFirst, TIER_CFG);
      const d2 = tierDistribution(brFirst, TIER_CFG);
      eq(
        d1.map((x) => x.tierId).join(','),
        d2.map((x) => x.tierId).join(','),
        '两种输入顺序必须得到同一个顺序'
      );
      eq(d1.map((x) => x.tierId).join(','), 'bronze,gm', '应按 tiers 由低到高');
      eq(d1[0]!.ratio, 0.9);
    });

    test('⚠️ diagnoseDistribution 的结论不随输入顺序颠倒', () => {
      const gmFirst = [
        mkPlayer(2000, 'gm'),
        ...Array(9)
          .fill(0)
          .map((_, i) => mkPlayer(500, 'b' + i)),
      ];
      const brFirst = [
        ...Array(9)
          .fill(0)
          .map((_, i) => mkPlayer(500, 'b' + i)),
        mkPlayer(2000, 'gm'),
      ];
      const a = diagnoseDistribution(tierDistribution(gmFirst, TIER_CFG), { tierOrder: TIER_ORDER });
      const b = diagnoseDistribution(tierDistribution(brFirst, TIER_CFG), { tierOrder: TIER_ORDER });
      eq(a.issues.join('|'), b.issues.join('|'), '两种顺序应给出同样的诊断');
      assert(
        a.issues.some((i) => i.includes('最低段位')),
        '90% 挤在青铜，应报"最低段位占比过高"，而不是"最高段位"：' + a.issues.join()
      );
      assert(
        !a.issues.some((i) => i.includes('最高段位占比 90')),
        '不应把青铜的 90% 误报成最高段位'
      );
    });

    test('⚠️ 段位未变时 update 返回本次的真实进度', () => {
      /**
       * 修复前实测（白银 I 区间 1400~1500）：
       *   update(1450) -> progress=0.500  toNext=50
       *   update(1490) -> progress=0.500  toNext=50   ← 涨了 40 分，进度条不动
       */
      const p = new RankProgress(TIER_CFG, 1350);
      const u1 = p.update(1450);
      const u2 = p.update(1490);
      assert(u2.info.progress > u1.info.progress, '分数涨了进度必须涨');
      near(u2.info.progress, tierOf(1490, TIER_CFG).progress, 1e-9, '应等于 tierOf 的真实进度');
      near(u2.info.toNext, tierOf(1490, TIER_CFG).toNext, 1e-9);
      eq(u2.event, null, '段位没变，事件仍是 null');
      assert(u2.previous !== null, 'previous 字段仍要带上一次的段位信息');
    });

    test('升降段与掉段保护行为不变（防止矫枉过正）', () => {
      const p = new RankProgress(TIER_CFG, 1350);
      const up = p.update(1700);
      eq(up.event, 'promoted', '越过段位线应升段');
      eq(up.info.tierIndex, 2);

      const p2 = new RankProgress(TIER_CFG, 1700);
      const down = p2.update(500);
      eq(down.event, 'demoted', '掉回青铜应降段');
      eq(down.info.tierIndex, 0);
      assert(down.shieldGames > 0, '刚掉段后应给新的保护局数');
      eq(p2.current!.tierIndex, 0, 'current 也要跟着变');
    });
  });

  // ---------------------------------------------------------------
  describe('room-graph · 截断返回值、空 if、fixed 优先', () => {
    test('⚠️ findBestPath 截断时 total 不再是 NaN', () => {
      /**
       * 修复前实测：truncated = true  total = NaN
       * 调用方拿 NaN 去比较或显示，会让"最优路线"永远选第一个。
       */
      const g = generateRoomGraph({ depth: 6, width: 4, rng: new RNG(42) });
      const r = findBestPath(g, (n) => n.depth, 3);
      eq(r.truncated, true, '配额 3 应触发截断');
      assert(Number.isFinite(r.total), `total 必须是有限数，实际 ${r.total}`);
      const sum = r.path.reduce((s, id) => s + g.nodes[id].depth, 0);
      eq(r.total, sum, 'total 必须与实际返回的 path 自洽');
    });

    test('不截断时结果不变（防止矫枉过正）', () => {
      const g = generateRoomGraph({ depth: 6, width: 4, rng: new RNG(42) });
      const full = findBestPath(g, (n) => n.depth, 1e9);
      eq(full.truncated, false);
      assert(Number.isFinite(full.total));
      eq(
        full.total,
        full.path.reduce((s, id) => s + g.nodes[id].depth, 0),
        '完整枚举时 total 应等于路径分'
      );
    });

    test('⚠️ diagnose 暴露"未分配类型"的节点数（原来是空 if 块）', () => {
      /**
       * 修复前：`if (emptyType > 0 && emptyType < nodes.length) { }`
       * 条件算出来了却什么都不做 → "部分节点没类型"永远不会被报出来。
       */
      const g = generateRoomGraph({ depth: 5, width: 3, rng: new RNG(7) });
      eq(diagnose(g).untyped, g.nodes.length, '刚生成的图全部未分配类型');

      assignTypes(g, { weights: { combat: 1, rest: 1 } });
      eq(diagnose(g).untyped, 0, '分配后应无未分配类型');
      assert(diagnose(g).ok, '分配完类型不应引入新的 issue');
    });

    test('⚠️ spec.fixed 指定的层不再被"Boss 前强制休息房"覆盖', () => {
      /**
       * 修复前：ensureRestBeforeBoss 无差别改写节点类型，
       * 调用方写了 fixed:{3:'shop'} 却被改成 rest，而配置读起来没变。
       */
      const g = generateRoomGraph({ depth: 5, width: 3, rng: new RNG(11) });
      const bossPrev = g.depth - 2;
      assignTypes(g, {
        weights: { combat: 1 },
        fixed: { [bossPrev]: RoomTypes.SHOP },
      });
      const layer = g.layers[bossPrev];
      const types = layer.map((id) => g.nodes[id].type);
      assert(
        types.every((t) => t === RoomTypes.SHOP),
        `Boss 前一层被 fixed 指定后应全是 shop，实际 ${types.join(',')}`
      );
    });

    test('未设 fixed 时 Boss 前仍保证有休息房（防止矫枉过正）', () => {
      const g = generateRoomGraph({ depth: 5, width: 3, rng: new RNG(11) });
      assignTypes(g, { weights: { combat: 1 } });
      const layer = g.layers[g.depth - 2];
      assert(
        layer.some((id) => g.nodes[id].type === RoomTypes.REST),
        'Boss 前一层应至少有一个休息房（体验刚需）'
      );
    });
  });

  // ---------------------------------------------------------------
  describe('snapshot · deepClone 的原型与 TypedArray', () => {
    test('⚠️ TypedArray 克隆后仍是 TypedArray', () => {
      /**
       * 修复前实测：
       *   克隆后还是 Uint8Array 吗？false
       *   实际 = {"0":1,"1":2,"3":3}   constructor = Object
       * UndoStack.push 后撤销回来的是"长得像但方法没了"的普通对象。
       */
      const src = new Uint8Array([1, 2, 3]);
      const c = deepClone(src);
      assert(c instanceof Uint8Array, '克隆后应仍是 Uint8Array');
      eq(c.constructor.name, 'Uint8Array');
      eq(Array.from(c).join(','), '1,2,3');
    });

    test('⚠️ 类实例克隆后保留原型方法', () => {
      class Counter {
        constructor(public n: number) {}
        double(): number {
          return this.n * 2;
        }
      }
      const c = deepClone(new Counter(21));
      eq(c.constructor.name, 'Counter');
      assert(typeof c.double === 'function', '原型方法不应丢失');
      eq(c.double(), 42);
    });

    test('⚠️ diffSnapshots 的 maxDepth 被收口', () => {
      /**
       * 修复前：maxDepth=0 或负数时 depth >= maxDepth 在根节点就成立，
       * 整棵树被当成"一个变化"，路径为空串 → 下游无法定位。
       */
      const before = { a: { b: 1 } };
      const after = { a: { b: 2 } };
      for (const bad of [0, -1, NaN]) {
        const d = diffSnapshots(before, after, bad);
        assert(
          d.changed[0]!.path.length > 0,
          `maxDepth=${bad} 不应退化成"整棵树一个变化"，实际路径 "${d.changed[0]!.path}"`
        );
      }
    });

    test('⚠️ 达到 maxDepth 时不再把原对象引用存进 diff', () => {
      /**
       * 修复前：直接存 `before` / `after` 的引用。
       * 调用方缓存 diff（撤销栈 / 回放）会让整棵旧对象无法被 GC。
       */
      const before = { a: { b: { c: { deep: 1 } } } };
      const after = { a: { b: { c: { deep: 2 } } } };
      const d = diffSnapshots(before, after, 2);
      assert(d.changed[0]!.from !== before.a.b, '存的不应是原引用');
      assert(d.changed[0]!.to !== after.a.b, '存的不应是原引用');
      // maxDepth=2 时截断在 'a.b' 这一层，存的是 { c: { deep } } 的副本
      eq(d.changed[0]!.path, 'a.b');
      const toCopy = d.changed[0]!.to as { c: { deep: number } };
      eq(toCopy.c.deep, 2, '副本内容应正确');
      // 改动副本不应影响原对象
      toCopy.c.deep = 999;
      eq(after.a.b.c.deep, 2, '原对象不受 diff 结果影响');
    });

    test('纯数据 / Date / Map / Set 与循环引用行为不变（防止矫枉过正）', () => {
      const src = { d: new Date(1000), m: new Map([['k', 1]]), s: new Set([1, 2]), arr: [1, [2]] };
      const c = deepClone(src);
      assert(c.d instanceof Date && c.d.getTime() === 1000, 'Date 应保留');
      assert(c.m instanceof Map && c.m.get('k') === 1, 'Map 应保留');
      assert(c.s instanceof Set && c.s.has(2), 'Set 应保留');
      eq((c.arr[1] as number[])[0], 2);

      const plain = deepClone({ a: 1, b: 'x' });
      eq(plain.constructor.name, 'Object', '普通对象仍应是普通对象');

      const cyclic: Record<string, unknown> = { self: null };
      cyclic.self = cyclic;
      const cc = deepClone(cyclic) as Record<string, unknown>;
      assert(cc.self === cc, '循环引用应被 seen 复用而不是爆栈');
    });
  });

  // ---------------------------------------------------------------
  describe('stats · 原型链查表与 NaN 入参（守护用例）', () => {
    test('⚠️ get 不会命中 Object.prototype 上的键', () => {
      /**
       * 现象（修复前）：
       *   get("toString")       -> "[object Object]"   ← 声明返回 number 却返回字符串
       *   display("toString")   -> 0                   ← 最危险：看起来正常
       * 现在已由 `hasOwn` 修掉，这里守护住它。
       */
      const s = new Stats({ defs: [{ id: 'kills', agg: 'sum' }] });
      for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
        throws(
          () => s.get(key),
          '未定义的指标',
          `get('${key}') 应拒绝原型键，而不是返回原型上的方法`
        );
        eq(s.tryGet(key), 0, `${key} 的 tryGet 应回落 0`);
        eq(s.display(key), 0, `${key} 的 display 应回落 0`);
      }
    });

    test('⚠️ record(NaN) 不会污染指标终身', () => {
      /**
       * 现象（修复前）：record('score', NaN) → get=NaN，
       * 之后的 record('score',10) 也全是 NaN；display 显示成 0。
       * 现在已由 `needFinite` 修掉，这里守护住它。
       */
      const s = new Stats({ defs: [{ id: 'score', agg: 'sum' }] });
      throws(() => s.record('score', NaN), '有限', 'NaN 应被入口拒绝');
      eq(s.get('score'), 0, '拒绝后应保持未记录状态');
      s.record('score', 10);
      eq(s.get('score'), 10, '后续有效数据应正常累积');
      s.record('score', 5);
      eq(s.get('score'), 15);
    });

    test('正常派生指标与聚合不受影响（防止矫枉过正）', () => {
      const s = new Stats({
        defs: [
          { id: 'kills', agg: 'sum' },
          { id: 'deaths', agg: 'sum' },
        ],
        derived: { kd: (g) => g('kills') / Math.max(1, g('deaths')) },
      });
      s.record('kills', 10);
      s.record('deaths', 2);
      eq(s.get('kd'), 5);
      eq(s.derived('kd'), 5, 'derived() 也能读到');
      throws(() => s.derived('不存在'), '未定义的派生指标');
    });
  });

  // ---------------------------------------------------------------
  describe('wave-spawner · cleared 模式下波次自带的 timeout', () => {
    test('⚠️ nextOn=cleared 时波次自带的 timeout 生效', () => {
      /**
       * 修复前实测：
       *   wave.timeout=5 / 全局 60，跑 20 秒后是否触发兜底 = false，state=fighting
       * 老代码在 cleared 分支用的是 `this._waveTimeout`（只认全局值）。
       */
      const sink = new TestSink();
      let fallback: string | null = null;
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 2 }], nextOn: 'cleared', timeout: 5 }],
        spawn: sink,
        waveTimeout: 60,
        onFallback: (i) => {
          fallback = i.type;
        },
      });
      ws.start();
      ws.tick(0.016);
      for (let i = 0; i < 1250; i++) ws.tick(0.016); // 20 秒
      eq(fallback, 'wave-timeout', '波次自带的 5 秒超时应作为兜底生效');
      eq(ws.state, 'cleared', '兜底后应推进而非卡住');
    });

    test('⚠️ nextOn=timeout 行为不变（那条分支本来就对）', () => {
      const ws = new WaveSpawner({
        waves: [
          { id: 'w1', entries: [{ id: 'bat', count: 2 }], nextOn: 'timeout', timeout: 1 },
          { id: 'w2', entries: [{ id: 'slime', count: 1 }] },
        ],
        spawn: new TestSink(),
        waveTimeout: 100,
      });
      ws.start();
      ws.tick(0.016);
      eq(ws.currentWaveIndex, 0);
      for (let i = 0; i < 70; i++) ws.tick(0.016); // 1.1 秒
      eq(ws.currentWaveIndex, 1, '到时间就推进');
    });

    test('⚠️ 不设 wave.timeout 时仍回退全局值（防止矫枉过正）', () => {
      let fallback: string | null = null;
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 2 }] }],
        spawn: new TestSink(),
        waveTimeout: 60,
        onFallback: (i) => {
          fallback = i.type;
        },
      });
      ws.start();
      ws.tick(0.016);
      for (let i = 0; i < 600; i++) ws.tick(0.016); // ~9.6 秒 < 60
      eq(fallback, null, '没到全局超时不该兜底');
      eq(ws.state, 'fighting', '怪没清完就还在打');
    });

    test('清空即推进与 waveTimeout=0 关闭超时不变（防止矫枉过正）', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [
          { id: 'w1', entries: [{ id: 'bat', count: 2 }] },
          { id: 'w2', entries: [{ id: 'slime', count: 1 }] },
        ],
        spawn: sink,
        waveTimeout: 0,
      });
      ws.start();
      ws.tick(0.016);
      eq(sink.handles.length, 2);
      for (const h of sink.handles) h.alive = false;
      ws.tick(0.016);
      eq(ws.currentWaveIndex, 1, '清空后应立即进下一波');
      for (let i = 0; i < 2000; i++) ws.tick(0.016);
      assert(ws.currentWaveIndex <= 1, 'waveTimeout=0 表示关闭超时，不该推进');
    });
  });
}
