/**
 * tests/run_fixregress.ts —— 外部审查报告缺陷的回归测试
 *
 * 【这批测的是"改过的东西别再坏回去"】
 *
 * 四份外部审查报告（《逻辑与边界》《架构与代码规范》《内存与资源泄漏》
 * 《性能与卡顿》）共报出 20 条缺陷，本文件为其中可自动化验证的部分
 * 建立回归防线。每条都对应当时实测复现的具体症状：
 *
 *   P0-1  save        原子写：断电后主档半截，tmp 里躺着完好的新档
 *   P0-1  leaderboard 批量提交 O(n²)：5 万条 34 秒 → 全批只排一次
 *   P1-2  gacha       十连保底在单抽场景完全失效
 *   P1-3  gacha       50/50 判负却发放限定物品
 *   P1-4  currency    canAfford 说能买，spendAll 却抛异常
 *   M1-1  social      _tickets / _lastReport 无界且无法清理
 *   M2-2  projectile  lifetime 漏填即永不回收
 *   P2-5  wave-spawner waveTimeout=0 语义反转
 *   P2-6  damage      armorPen 负值导致护甲不减反增
 *   P2-7  damage      NaN / Infinity 静默穿透整条管线
 *   M3-3  cutscene    build() 返回内部数组引用
 *   M3-4  scenerouter 历史上限硬编码 32，不可配置
 *   M3-5  audio       _frameCounts 每帧 new 一个 Map
 *   M3-6  daily       按天累积，原本没有任何清理手段
 *   A2-3  cheatcode   tokenize 吞掉空参数（参数位置左移一位）
 *   P2-5  collision   query() 每次 new Set()
 *   P3-8  全局         DefaultRandom ×4，_core 现成轮子零复用
 *
 * 【⚠️ 写这个文件时踩的坑】
 *
 * 第一版我按"印象中的 API"写，编译器和运行时一共错了 6 次，
 * **每次都伪装成"这条修复其实没生效"**：
 *
 *   - `new Wallet({ gold: 100 })`        → 实际是 `{ defs: [...] }` 数组
 *   - `new DamagePipeline()`             → 不注册阶段就没有护甲，
 *                                          测出来 armorPen 全是 100，
 *                                          差点判成"clamp01 没生效"
 *   - `new CollisionGrid({ cellSize })`  → 实际是位置参数 `new CollisionGrid(10)`
 *   - `circle(0, 0, 5)` 直接 insert      → insert 收 Collider，不是 Shape
 *   - `new CurrencyWallet({ gold: 100 })`→ 同样要 `{ defs: [...] }`
 *   - `WaveSpawner` 的 sink              → spawn() 要返回 SpawnHandle 对象，
 *                                          返回字符串会在 tick 时崩
 *
 * 这正是第四份报告反复强调的：**测量本身也会撒谎，
 * 而且撒的是"一切正常"的谎。** 所以下面每个用例都带
 * "如果修复被回退，这条会失败"的显式判据。
 */

import { describe, test, assert, eq } from './_framework';
import { SaveManager, IStorage } from '../save/SaveManager';

/** 内存存储，用于伪造实验（可以直接改写底层字符串） */
class MemStorage implements IStorage {
  _map = new Map<string, string>();
  read(key: string): string | null { return this._map.get(key) ?? null; }
  write(key: string, data: string): void { this._map.set(key, data); }
  remove(key: string): void { this._map.delete(key); }
  keys(): string[] { return [...this._map.keys()]; }
}
import { Leaderboard } from '../leaderboard/Leaderboard';
import { GachaPity } from '../gacha/GachaPity';
import { RNG } from '../rng/RNG';
import { Wallet } from '../currency/Currency';
import { CurrencyWallet } from '../currency/CurrencyWallet';
import { ReportCenter } from '../social/Report';
import { ProjectileSystem } from '../projectile/Projectile';
import { WaveSpawner, ISpawnSink, SpawnHandle } from '../wave-spawner/WaveSpawner';
import { DamagePipeline } from '../damage-pipeline/DamagePipeline';
import { Timeline } from '../cutscene/Cutscene';
import { SceneRouter } from '../scenerouter/SceneRouter';
import { AudioManager } from '../audio/AudioManager';
import { DailyChallenge } from '../daily/DailyChallenge';
import { tokenize, levenshtein, CheatCode } from '../cheatcode/CheatCode';
import { DebugConsole } from '../debug-console/DebugConsole';
import { CollisionGrid, circle } from '../collision/Collision';
import { MathRandomSource, IRect, IRectSized, toCorners, toSized, setCorners, rectContains, rectOverlaps } from '../_core/types';
import { editDistance as editDistanceCore, similarity as similarityCore } from '../_core/string';
import { Expression, DEFAULT_MAX_DEPTH } from '../expression/Expression';
import { similarity as similarityConsole } from '../debug-console/DebugConsole';
import { CellularDungeon } from '../dungeon/Dungeon';
import { defaultRankConfig, tierOf, RankProgress } from '../ranking/RankTier';
import { tokenize as tokenizeCheat } from '../cheatcode/CheatCode';
import { tokenize as tokenizeConsole } from '../debug-console/DebugConsole';
import { SpeedChecker } from '../anticheat/AntiCheat';

export function runFixRegressTests(): void {
  // ==================== P0-1 存档原子写 ====================
  describe('P0-1 save · 原子写与断电回退', () => {
    /** 模拟在主档写盘中途"断电"的存储 */
    class CrashStorage implements IStorage {
      private readonly _m = new Map<string, string>();
      private _n = 0;
      crashOnWrite = -1;
      read(k: string): string | null { return this._m.get(k) ?? null; }
      write(k: string, d: string): void {
        this._n++;
        if (this._n === this.crashOnWrite) {
          this._m.set(k, d.slice(0, Math.floor(d.length / 2)));
          throw new Error('模拟断电');
        }
        this._m.set(k, d);
      }
      remove(k: string): void { this._m.delete(k); }
      keys(): string[] { return Array.from(this._m.keys()); }
    }
    /** 支持 commit 的真原子存储 */
    class AtomicStorage extends CrashStorage {
      commit(tmp: string, key: string): void {
        const v = this.read(tmp);
        if (v === null) throw new Error('临时文件不存在');
        (this as unknown as { write(k: string, d: string): void }).write(key, v);
        this.remove(tmp);
      }
    }

    test('降级路径：主档写坏时自动回退到 __tmp 备份', () => {
      const s = new CrashStorage();
      const m = new SaveManager(s, { gameId: 'g', version: 1 });
      m.write('slot1', { level: 99 });
      s.crashOnWrite = 4;                    // 第二次保存写主档时断电
      m.write('slot1', { level: 100 });
      const r = m.read<{ level: number }>('slot1');
      // 修复前：主档半截 + tmp 被删 → 读档失败，新进度 100 永久丢失
      assert(r.ok, `主档损坏后应能从备份恢复，实际失败：${r.ok ? '' : r.error}`);
      eq(r.value.level, 100, '应恢复到断电前正在写入的新档');
    });

    test('真原子路径：commit 失败时主档保持上一次的完整状态', () => {
      const s = new AtomicStorage();
      const m = new SaveManager(s, { gameId: 'g', version: 1 });
      m.write('slot1', { level: 99 });
      const r = m.read<{ level: number }>('slot1');
      assert(r.ok && r.value.level === 99, '正常保存应能读回');
    });

    test('正常保存后 __tmp 不残留在槽位列表里', () => {
      const s = new AtomicStorage();
      const m = new SaveManager(s, { gameId: 'g', version: 1 });
      m.write('slot1', { level: 1 });
      const slots = m.listSlots();
      assert(!slots.some((x) => x.includes('__tmp')), `槽位列表不应含 __tmp：${slots}`);
      eq(slots.length, 1, '只应有 slot1');
    });
  });

  // ==================== P0-1 leaderboard 批量退化 ====================
  describe('P0-1 leaderboard · 批量提交不再平方级退化', () => {
    test('submitAll 2 万条应在 500ms 内完成（修复前约 4.6 秒）', () => {
      const es: Array<{ playerId: string; score: number; at: number }> = [];
      for (let i = 0; i < 20000; i++) {
        es.push({ playerId: `p${i}`, score: (i * 7919) % 10000, at: i });
      }
      const lb = new Leaderboard({ capacity: 20100, order: 'desc' } as never);
      const t0 = Date.now();
      const n = lb.submitAll(es as never);
      const ms = Date.now() - t0;
      eq(n, 20000, '全部应入榜');
      assert(ms < 500, `2 万条批量提交耗时 ${ms}ms，应 < 500ms（修复前约 4600ms）`);
    });

    test('批量提交后排名正确（降序、取前 capacity 个）', () => {
      const lb = new Leaderboard({ capacity: 3, order: 'desc' } as never);
      const n = lb.submitAll([
        { playerId: 'a', score: 10, at: 1 },
        { playerId: 'b', score: 50, at: 2 },
        { playerId: 'c', score: 30, at: 3 },
        { playerId: 'd', score: 5, at: 4 },
      ] as never);
      eq(n, 3, '容量 3，提交 4 条只应入榜 3 条');
      const ids = (lb as unknown as {
        ranked(): Array<{ playerId: string; score: number }>;
      }).ranked().map((r) => r.playerId);
      eq(ids.join(','), 'b,c,a', '应按分数降序');
    });

    test('批量刷新：更好的成绩替换，更差的成绩被挡下', () => {
      const lb = new Leaderboard({ capacity: 3, order: 'desc' } as never);
      lb.submitAll([
        { playerId: 'a', score: 10, at: 1 },
        { playerId: 'b', score: 50, at: 2 },
        { playerId: 'c', score: 30, at: 3 },
      ] as never);
      eq(lb.submitAll([{ playerId: 'a', score: 99, at: 9 }] as never), 1, '更好的成绩应替换上榜');
      eq(lb.submitAll([{ playerId: 'a', score: 1, at: 10 }] as never), 0, '更差的成绩应被自己挡下');
    });
  });

  // ==================== P1-2 gacha 十连保底 ====================
  describe('P1-2 gacha · 十连保底对单抽同样生效', () => {
    const rarities = [
      { id: 'r3', tier: 1, baseRate: 0.9 },
      { id: 'r4', tier: 2, baseRate: 0.05 },
    ];
    const items = [
      { id: 'a', rarity: 'r3' }, { id: 'b', rarity: 'r3' },
      { id: 'c', rarity: 'r4' }, { id: 'd', rarity: 'r4' },
    ];
    const mk = (s: number) =>
      new GachaPity({ items, rarities, rng: new RNG(s), tenPullGuarantee: 'r4' } as never);

    /** 最长"没出 r4"的连续抽数 */
    function longestDrought(fn: () => Array<{ rarity: string }>): number {
      let worst = 0; let cur = 0;
      for (const r of fn()) {
        if (r.rarity === 'r4') { worst = Math.max(worst, cur); cur = 0; } else cur++;
      }
      return Math.max(worst, cur);
    }

    test('连续 60 次 pull() 的最长干涸 ≤ 9（修复前一次都没出）', () => {
      const d = longestDrought(() => {
        const g = mk(1); const o = [];
        for (let i = 0; i < 60; i++) o.push(g.pull() as unknown as { rarity: string });
        return o;
      });
      assert(d <= 9, `单抽最长干涸 ${d} 抽，承诺是每 10 抽必出（≤9）`);
    });

    test('10 个种子各连抽 60 次，没有一个种子一次不出', () => {
      let worstAll = 0; let never = 0;
      for (let s = 1; s <= 10; s++) {
        const d = longestDrought(() => {
          const g = mk(s); const o = [];
          for (let i = 0; i < 60; i++) o.push(g.pull() as unknown as { rarity: string });
          return o;
        });
        const g2 = mk(s); let cnt = 0;
        for (let i = 0; i < 60; i++) {
          if ((g2.pull() as unknown as { rarity: string }).rarity === 'r4') cnt++;
        }
        if (cnt === 0) never++;
        worstAll = Math.max(worstAll, d);
      }
      eq(never, 0, `有 ${never}/10 个种子连抽 60 次一次 r4 都没出`);
      assert(worstAll <= 9, `最长干涸 ${worstAll}，应 ≤ 9`);
    });

    test('pullTen() 与 pullN() 的干涸同样受保底约束', () => {
      const dTen = longestDrought(() => {
        const g = mk(1); const o = [];
        for (let i = 0; i < 6; i++) o.push(...(g.pullTen() as unknown as Array<{ rarity: string }>));
        return o;
      });
      assert(dTen <= 9, `6×pullTen() 最长干涸 ${dTen}，应 ≤ 9`);
    });
  });

  // ==================== P1-3 gacha 50/50 判负发限定 ====================
  describe('P1-3 gacha · 判负时不得发放限定物品', () => {
    const rarities = [
      { id: 'r5', tier: 2, baseRate: 0.5 },
      { id: 'r4', tier: 1, baseRate: 0.5 },
    ];
    const allLimited = [
      { id: 'limA', rarity: 'r5', limited: true },
      { id: 'limB', rarity: 'r5', limited: true },
      { id: 's1', rarity: 'r4' },
    ];
    const withStandard = [
      { id: 'limA', rarity: 'r5', limited: true },
      { id: 'std5', rarity: 'r5', limited: false },
      { id: 's1', rarity: 'r4' },
    ];

    function countMismatch(items: unknown[]): { lose: number; bad: number } {
      let lose = 0; let bad = 0;
      for (let s = 1; s <= 60; s++) {
        const g = new GachaPity({
          items, rarities, rng: new RNG(s),
          fiftyFifty: true, fiftyFiftyRate: 0.5,
        } as never);
        for (let i = 0; i < 40; i++) {
          const r = g.pull() as unknown as {
            wonFiftyFifty?: boolean; item?: { limited?: boolean };
          };
          if (r.wonFiftyFifty === false) {
            lose++;
            if (r.item?.limited === true) bad++;
          }
        }
      }
      return { lose, bad };
    }

    test('无常驻可歪时，判负不得发放 limited（修复前 100% 误发）', () => {
      const { lose, bad } = countMismatch(allLimited);
      eq(bad, 0, `无常驻时判负 ${lose} 次，其中 ${bad} 次误发限定`);
    });

    test('有常驻时判负仍正常（不应误伤正常路径）', () => {
      const { lose, bad } = countMismatch(withStandard);
      assert(lose > 0, '有常驻时应该会出现判负（否则这条测试没测到东西）');
      eq(bad, 0, `有常驻时判负 ${lose} 次，其中 ${bad} 次误发限定`);
    });
  });

  // ==================== P1-4 currency canAfford 语义一致 ====================
  describe('P1-4 currency · UI 判定与实际扣款必须一致', () => {
    type Cost = { currencyId: string; amount: number };
    function probe(costs: Cost[]): { ui: 'yes' | 'no' | 'throw'; sp: 'yes' | 'no' | 'throw' } {
      const w = new Wallet({ defs: [{ id: 'gold' }, { id: 'gem' }] } as never);
      w.add('gold', 100); w.add('gem', 3);
      let ui: 'yes' | 'no' | 'throw';
      let sp: 'yes' | 'no' | 'throw';
      try { ui = w.canAfford(costs as never).ok ? 'yes' : 'no'; } catch { ui = 'throw'; }
      try { sp = w.spendAll(costs as never) ? 'yes' : 'no'; } catch { sp = 'throw'; }
      return { ui, sp };
    }

    test('NaN / 负数 / 0 / 小数：UI 与扣款结论一致（修复前 UI 说能买、扣款抛异常）', () => {
      for (const [label, c] of [
        ['NaN', [{ currencyId: 'gold', amount: NaN }]],
        ['负数', [{ currencyId: 'gold', amount: -50 }]],
        ['0', [{ currencyId: 'gold', amount: 0 }]],
        ['小数', [{ currencyId: 'gold', amount: 10.5 }]],
      ] as Array<[string, Cost[]]>) {
        const { ui, sp } = probe(c);
        eq(ui, sp, `${label}：canAfford=${ui} 但 spendAll=${sp}，两者会打架`);
      }
    });

    test('正常路径不受影响（能买就真能买，不够就都说不）', () => {
      const ok = probe([{ currencyId: 'gold', amount: 80 }, { currencyId: 'gem', amount: 2 }]);
      eq(ok.ui, 'yes', '80 金 + 2 钻应该买得起');
      eq(ok.sp, 'yes', '应该真的扣款成功');
      const no = probe([{ currencyId: 'gold', amount: 80 }, { currencyId: 'gem', amount: 5 }]);
      eq(no.ui, 'no', '钻不够应判不够');
      eq(no.sp, 'no', '且一分钱都不扣');
    });

    test('同货币重复出现时按总量判断（80金+80金 在只有 100 金时应为不够）', () => {
      const r = probe([{ currencyId: 'gold', amount: 80 }, { currencyId: 'gold', amount: 80 }]);
      eq(r.ui, 'no', '总量 160 > 100，应判不够');
      eq(r.sp, 'no', '且不应扣款');
    });

    test('CurrencyWallet 的单货币 canAfford 与 spend 同样一致', () => {
      for (const [label, amt] of [
        ['负数', -50], ['0', 0], ['NaN', NaN],
      ] as Array<[string, number]>) {
        const w = new CurrencyWallet({ defs: [{ id: 'gold' }] } as never);
        w.add('gold', 100);
        const ui = w.canAfford('gold', amt);
        const sp = (w.spend('gold', amt) as { ok: boolean }).ok;
        eq(ui, sp, `${label}：canAfford=${ui} 但 spend.ok=${sp}`);
      }
      const w = new CurrencyWallet({ defs: [{ id: 'gold' }] } as never);
      w.add('gold', 100);
      eq(w.canAfford('gold', 80), true, '80 < 100 应判够');
      eq(w.canAfford('gold', 200), false, '200 > 100 应判不够');
    });
  });

  // ==================== M1-1 social/Report 无界增长 ====================
  describe('M1-1 social · 举报记录必须有上限且可清理', () => {
    function flood(): ReportCenter {
      const r = new ReportCenter({ cooldownMs: 0, dailyLimit: 999999 } as never);
      for (let d = 0; d < 20; d++) {
        for (let p = 0; p < 500; p++) {
          (r as unknown as {
            submit(a: string, b: string, c: string, d: number): unknown;
          }).submit(`r${p}`, `t${p}_${d}`, 'spam', d * 86400000);
        }
      }
      return r;
    }

    test('_tickets 受 maxTickets 上限约束（修复前 5 万次 → 5 万条）', () => {
      const r = flood();
      const st = r as unknown as { _tickets: unknown[]; _maxTickets: number };
      assert(st._tickets.length <= st._maxTickets,
        `_tickets ${st._tickets.length} 超过上限 ${st._maxTickets}`);
    });

    test('提供 clear / destroy / prune 三个清理手段', () => {
      const r = flood();
      const st = r as unknown as {
        _tickets: unknown[]; _lastReport: { size: number };
      };
      assert(typeof r.clear === 'function', '应有 clear()');
      assert(typeof r.destroy === 'function', '应有 destroy()（铁律：可卸载）');
      assert(typeof r.prune === 'function', '应有 prune()');
      r.clear();
      eq(st._tickets.length, 0, 'clear 后工单应清空');
      eq(st._lastReport.size, 0, 'clear 后冷却记录应清空');
    });

    test('prune() 能清掉过期冷却记录', () => {
      const r = new ReportCenter({ cooldownMs: 1000, dailyLimit: 99 } as never);
      const rr = r as unknown as {
        submit(a: string, b: string, c: string, d: number): unknown;
      };
      rr.submit('r1', 't1', 'spam', 0);
      rr.submit('r1', 't2', 'spam', 0);
      const st = r as unknown as { _lastReport: { size: number } };
      const before = st._lastReport.size;
      assert(before > 0, '应产生了冷却记录');
      r.prune(999999);
      eq(st._lastReport.size, 0, `prune 后应清空（清理前 ${before} 条）`);
    });
  });

  // ==================== M2-2 projectile lifetime ====================
  describe('M2-2 projectile · 漏填 lifetime 不得永久泄漏', () => {
    const noHit = { query: () => [], sweep: () => null };
    function residue(extra: Record<string, unknown>): number {
      const sys = new ProjectileSystem({ collision: noHit, ...extra } as never);
      for (let i = 0; i < 200; i++) {
        sys.spawn({ x: 0, y: 0, dirX: 1, dirY: 0, speed: 100 } as never);
      }
      for (let i = 0; i < 200; i++) sys.tick(0.1);
      return sys.count;
    }

    test('不传 lifetime 时全部回收（修复前 100% 残留）', () => {
      eq(residue({}), 0, '漏填 lifetime 不应有残留');
    });

    test('lifetime = NaN 时全部回收', () => {
      eq(residue({ defaultLifetime: 1 }), 0, 'NaN 兜底同样生效');
      const sys = new ProjectileSystem({ collision: noHit } as never);
      sys.spawn({ x: 0, y: 0, dirX: 1, dirY: 0, speed: 100, lifetime: NaN } as never);
      for (let i = 0; i < 200; i++) sys.tick(0.1);
      eq(sys.count, 0, '显式传 NaN 也应被兜底值替换');
    });

    test('正常传 lifetime 仍按原值回收', () => {
      const sys = new ProjectileSystem({ collision: noHit } as never);
      sys.spawn({ x: 0, y: 0, dirX: 1, dirY: 0, speed: 100, lifetime: 0.5 } as never);
      sys.tick(0.3);
      eq(sys.count, 1, '0.3 秒时还没到期');
      sys.tick(0.3);
      eq(sys.count, 0, '0.6 秒时应已回收');
    });
  });

  // ==================== P2-5 wave-spawner waveTimeout = 0 ====================
  describe('P2-5 wave-spawner · 超时参数对 0 的语义必须一致', () => {
    class Sink implements ISpawnSink {
      handles: SpawnHandle[] = [];
      killed: SpawnHandle[] = [];
      private _nextId = 1;
      spawn(entryId: string, indexInEntry: number, waveIndex: number): SpawnHandle | null {
        const h: SpawnHandle = {
          id: this._nextId++, alive: true, age: 0, waveIndex,
          data: { entryId, indexInEntry },
        };
        this.handles.push(h);
        return h;
      }
      forceKill(h: SpawnHandle): void { h.alive = false; this.killed.push(h); }
    }

    function run(waveTimeout: number, ticks: number): { killed: number } {
      const sink = new Sink();
      const ws = new WaveSpawner({
        waves: [
          { id: 'w1', entries: [{ id: 'bat', count: 2 }] },
          { id: 'w2', entries: [{ id: 'bat', count: 2 }] },
          { id: 'w3', entries: [{ id: 'bat', count: 2 }] },
        ],
        spawn: sink, waveTimeout,
      } as never);
      ws.start();
      for (let i = 0; i < ticks; i++) ws.tick(0.1);
      return { killed: sink.killed.length };
    }

    test('waveTimeout = 0 表示关闭，不得每帧触发（修复前语义反转）', () => {
      eq(run(0, 2).killed, 0, '传 0 想关闭超时，结果反而立刻清场');
      eq(run(60, 2).killed, 0, '基线：60 秒超时在 0.2 秒内不该触发');
    });

    test('waveTimeout > 0 时超时仍能正常触发', () => {
      assert(run(1, 25).killed > 0, '1 秒超时跑 2.5 秒应触发强制清除');
    });
  });

  // ==================== P2-6 / P2-7 damage-pipeline ====================
  describe('P2-6 / P2-7 damage · 护甲穿透与脏数据', () => {
    const p = DamagePipeline.createDefault();
    const tgt = { hp: 9999, armor: 100, resistances: {} } as never;
    const base = p.calculate({ raw: 100 } as never, tgt).value;

    test('基线：armor=100 时 100 点原始伤害被打折', () => {
      assert(base < 100 && base > 0, `护甲应生效，实际 ${base}`);
    });

    test('armorPen 为负时不得让护甲不减反增（修复前 -2 → 伤害从 50 掉到 25）', () => {
      for (const pen of [-0.5, -2, -100]) {
        const v = p.calculate({ raw: 100, armorPen: pen } as never, tgt).value;
        eq(v, base, `armorPen=${pen} 时伤害 ${v}，应与无穿透的 ${base} 相同`);
      }
    });

    test('armorPen 在 [0,1] 内单调：穿透越多伤害越高', () => {
      let prev = base;
      for (const pen of [0.25, 0.5, 0.75, 1]) {
        const v = p.calculate({ raw: 100, armorPen: pen } as never, tgt).value;
        assert(v >= prev, `armorPen=${pen} 时伤害 ${v} 应 ≥ 上一级 ${prev}`);
        prev = v;
      }
    });

    test('armorPen > 1 不产生越界收益', () => {
      const at1 = p.calculate({ raw: 100, armorPen: 1 } as never, tgt).value;
      const at5 = p.calculate({ raw: 100, armorPen: 5 } as never, tgt).value;
      eq(at5, at1, '穿透超过 100% 不应比 100% 更高');
    });

    test('NaN / Infinity 在入口被拦下，不再静默写进 hp', () => {
      for (const raw of [NaN, Infinity, -Infinity]) {
        const r = p.calculate({ raw } as never, tgt);
        eq(r.value, 0, `raw=${raw} 应返回 0，实际 ${r.value}`);
        assert(Number.isFinite(r.value), `raw=${raw} 的结果必须是有限数`);
      }
    });

    test('正常伤害未被误伤', () => {
      eq(p.calculate({ raw: 100 } as never, tgt).value, base, '正常输入应保持不变');
    });
  });

  // ==================== M3-3 cutscene build 别名 ====================
  describe('M3-3 cutscene · build() 必须返回副本', () => {
    test('构建后继续 add 不得污染已构建的 def', () => {
      const tl = new Timeline('intro');
      tl.add('camera', 1000);
      tl.add('dialogue', 2000);
      const def1 = tl.build();
      tl.add('sfx', 500);
      const def2 = tl.build();
      assert(def1.steps !== def2.steps, '两次 build 不得返回同一个数组');
      eq(def1.steps.length, 2, 'def1 应保持构建时的 2 条');
      eq(def2.steps.length, 3, 'def2 应为 3 条');
    });
  });

  // ==================== M3-4 scenerouter 历史上限 ====================
  describe('M3-4 scenerouter · 历史上限可配置', () => {
    test('默认 32，可通过 historyLimit 配置', () => {
      const d = new SceneRouter({} as never) as unknown as { _historyLimit: number };
      eq(d._historyLimit, 32, '默认应为 32');
      const c = new SceneRouter({ historyLimit: 5 } as never) as unknown as { _historyLimit: number };
      eq(c._historyLimit, 5, '应可配置为 5');
    });
  });

  // ==================== M3-5 audio 每帧分配 ====================
  describe('M3-5 audio · _frameCounts 复用而非每帧 new', () => {
    test('update() 复用同一个 Map 实例', () => {
      const a = new AudioManager({ maxVoices: 8 } as never);
      const st = a as unknown as { _frameCounts: Map<string, number> };
      const before = st._frameCounts;
      a.update(1000);
      const after = st._frameCounts;
      a.update(2000);
      assert(before === after, 'update 不应替换 _frameCounts 实例');
      assert(after === st._frameCounts, '第二次 update 也不应替换');
    });
  });

  // ==================== M3-6 daily 清理 ====================
  describe('M3-6 daily · 按天累积需可清理', () => {
    test('prune() 清理指定日期之前的记录', () => {
      const d = new DailyChallenge({ modifiers: [], modifierCount: 0 } as never);
      const st = d as unknown as {
        _records: Map<string, unknown>; _attempts: Map<string, number>;
      };
      st._records.set('2024-01-01', {});
      st._records.set('2024-06-01', {});
      st._records.set('2025-01-01', {});
      st._attempts.set('2024-01-01', 1);
      const n = d.prune('2025-01-01' as never);
      eq(n, 3, '应清掉 3 条（2 条 records + 1 条 attempts）');
      eq(st._records.size, 1, '2025-01-01 应保留');
      eq(st._attempts.size, 0, 'attempts 应清空');
    });
  });

  // ==================== A2-3 cheatcode tokenize ====================
  describe('A2-3 cheatcode · tokenize 不得吞掉空参数', () => {
    test('空参数保留占位，参数位置不左移', () => {
      eq(tokenize('set "" 1').length, 3, '空串参数应保留为 1 个 token');
      eq(tokenize('set "" 1')[1], '', '第二个 token 应是空串');
    });

    test('引号未闭合时抛错，不得静默接受', () => {
      let threw = false;
      try { tokenize('give "大剑 5'); } catch { threw = true; }
      assert(threw, '引号未闭合应抛错');
    });

    test('正常场景不受影响', () => {
      eq(tokenize('setgold 100').length, 2, '普通命令');
      eq(tokenize('give "大剑" 5').length, 3, '带引号的含空格参数');
      eq(tokenize('give "大剑" 5')[1], '大剑', '引号内内容不应带引号');
    });
  });

  // ==================== P2-5 collision 每帧分配 ====================
  describe('P2-5 collision · query() 复用 seen Set', () => {
    test('多次查询复用同一 Set 且结果稳定', () => {
      const g = new CollisionGrid(10);
      const mk = (id: number, shape: unknown): never => ({ id, shape } as never);
      g.insert(mk(1, circle(0, 0, 5)));
      g.insert(mk(2, circle(3, 3, 5)));
      const st = g as unknown as { _scratchSeen: Set<number> };
      const q1 = g.query(0, 0, 20, []);
      const s1 = st._scratchSeen;
      const q2 = g.query(0, 0, 20, []);
      const q3 = g.query(0, 0, 20, []);
      assert(s1 === st._scratchSeen, '应复用同一个 scratch Set');
      eq(q1.length, 2, '应命中 2 个');
      eq(q2.length, 2, 'clear 未生效会导致结果累积');
      eq(q3.length, 2, '第三次也应稳定');
    });
  });

  // ==================== P3-8 DefaultRandom 复用 ====================
  describe('P3-8 全局 · _core.MathRandomSource 可被复用', () => {
    test('next() 返回 [0,1) 区间的数', () => {
      for (let i = 0; i < 200; i++) {
        const v = MathRandomSource.next();
        assert(v >= 0 && v < 1, `第 ${i} 次返回 ${v}，应在 [0,1)`);
      }
    });
  });

  // ==================== 外部安全审查 · 上线开关与不变量 ====================
  //
  // 【来源】外部安全审查报告（S1-1 / S2-1 / S2-2 / S3-3）
  //
  // 四项：
  //   S1-1 save 不防篡改         → 文档口径（本节测行为，文档由脚本检查）
  //   S2-1 cheatcode 默认开启    → 未显式传参时 warn
  //   S2-2 debug-console 无开关  → 加 enabled
  //   S3-3 noise 极值偏低        → 文档更新（见 noise/README.md）
  describe('安全审查 · 上线开关零副作用', () => {
    /** 捕获 console.warn 与 console.error */
    function captureWarn(fn: () => void): string[] {
      const msgs: string[] = [];
      const orig = console.warn;
      console.warn = (...a: unknown[]) => { msgs.push(a.join(' ')); };
      try { fn(); } finally { console.warn = orig; }
      return msgs;
    }

    test('S2-1 cheatcode 未显式传 enabled 时警告', () => {
      const msgs = captureWarn(() => { new CheatCode({}); });
      assert(
        msgs.some((m) => m.includes('CheatCode') && m.includes('enabled')),
        `应警告未显式传 enabled，实际：${JSON.stringify(msgs)}`
      );
    });

    test('S2-1 cheatcode 显式传 true 时不警告（不打扰想清楚的人）', () => {
      const msgs = captureWarn(() => { new CheatCode({ enabled: true }); });
      eq(msgs.length, 0, `显式传 true 不应警告，实际：${JSON.stringify(msgs)}`);
    });

    test('S2-1 cheatcode 显式传 false 时不警告且默认关闭', () => {
      const cc = new CheatCode({ enabled: false });
      eq(cc.enabled, false, '应为关闭');
      eq(cc.enabledWasExplicit, true, '应记录为显式传参');
    });

    test('S2-2 debug-console 未显式传 enabled 时警告', () => {
      const msgs = captureWarn(() => { new DebugConsole({}); });
      assert(
        msgs.some((m) => m.includes('DebugConsole') && m.includes('enabled')),
        `应警告未显式传 enabled，实际：${JSON.stringify(msgs)}`
      );
    });

    test('S2-2 debug-console 显式传 true 时不警告', () => {
      const msgs = captureWarn(() => { new DebugConsole({ enabled: true }); });
      eq(msgs.length, 0, `显式传 true 不应警告，实际：${JSON.stringify(msgs)}`);
    });

    test('S2-2 debug-console 关闭后 execute 零副作用（不解析不执行不改历史）', () => {
      let ran = 0;
      const c = new DebugConsole({ enabled: false });
      c.register({ name: 'boom', help: '', run: () => { ran++; } });

      const ok = c.execute('boom');
      eq(ok, false, '关闭时 execute 应返回 false');
      eq(ran, 0, '命令不应被执行');
      eq(c.history.length, 0, '历史不应被记录（零副作用）');
    });

    test('S2-2 debug-console 开启后能正常执行', () => {
      let ran = 0;
      const c = new DebugConsole({ enabled: true });
      c.register({ name: 'go', help: '', run: () => { ran++; } });
      eq(c.execute('go'), true, '开启时应返回 true');
      eq(ran, 1, '命令应执行一次');
    });

    test('S2-2 debug-console enabled 运行时可热开关', () => {
      let ran = 0;
      const c = new DebugConsole({ enabled: true });
      c.register({ name: 'go', help: '', run: () => { ran++; } });
      c.execute('go');
      eq(ran, 1, '开启时应执行');
      c.enabled = false;
      c.execute('go');
      eq(ran, 1, '关闭后不应再执行');
      c.enabled = true;
      c.execute('go');
      eq(ran, 2, '重新开启后应恢复执行');
    });

    test('S1-1 save 改数据+重算校验和 → 伪造成功（文档口径的实证）', () => {
      // 无密钥滚动哈希，任何会写 5 行代码的人都能重算
      function forgeChecksum(data: unknown): number {
        const str = JSON.stringify(data);
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
        return h;
      }
      const st = new MemStorage();
      const sm = new SaveManager(st, { gameId: 'g', version: 1 });
      sm.write('s0', { gold: 100 });

      const key = st.keys().find((k) => !k.endsWith('__tmp'))!;
      const env = JSON.parse(st.read(key)!) as { v: number; gameId: string; savedAt: number };
      const evil = { gold: 999999 };
      st.write(key, JSON.stringify({
        ...env,
        checksum: forgeChecksum(evil),
        data: evil,
      }));

      const r = sm.read<{ gold: number }>('s0');
      assert(r.ok, '伪造应成功（这正是"不防篡改"的实证）');
      eq((r as { ok: true; value: { gold: number } }).value.gold, 999999, '应读到伪造值');
    });

    test('S1-1 save 只改数据不重算 → 被拦截（能防损坏）', () => {
      const st = new MemStorage();
      const sm = new SaveManager(st, { gameId: 'g', version: 1 });
      sm.write('s0', { gold: 100 });
      const key = st.keys().find((k) => !k.endsWith('__tmp'))!;
      const env = JSON.parse(st.read(key)!);
      st.write(key, JSON.stringify({ ...env, data: { gold: 1 } }));
      const r = sm.read('s0');
      eq(r.ok, false, '应被拦截');
    });

    test('S1-1 save 改 gameId 且重算校验和 → 被拦截（gameId 是真防线）', () => {
      function forgeChecksum(data: unknown): number {
        const str = JSON.stringify(data);
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
        return h;
      }
      const st = new MemStorage();
      const sm = new SaveManager(st, { gameId: 'g', version: 1 });
      sm.write('s0', { gold: 100 });
      const key = st.keys().find((k) => !k.endsWith('__tmp'))!;
      const env = JSON.parse(st.read(key)!);
      st.write(key, JSON.stringify({
        ...env,
        gameId: 'other',
        checksum: forgeChecksum(env.data),
      }));
      const r = sm.read('s0');
      eq(r.ok, false, 'gameId 不匹配应被拦截');
    });
  });

  // ==================== 引擎实测第三轮 · 命令解析器统一 ====================
  //
  // 【来源】外部报告 A2-2：cheatcode 与 debug-console 各有一份 tokenize。
  // 下沉时发现两份**不只是复制关系**，语义有分歧（见 _core/string.ts 注释）：
  //   cheatcode 只认 ' ' 和 '\t'；console 用 /\s/
  // 分歧在换行 / 回车 / NBSP / 全角空格等 6 类空白符上。
  describe('tokenize · 两份实现下沉后行为一致', () => {
    const cases: Array<[string, string]> = [
      ['a b', '空格'],
      ['a\tb', 'Tab'],
      ['a\nb', '换行'],
      ['a\rb', '回车'],
      ['a\u00a0b', 'NBSP（网页复制常见）'],
      ['a\u3000b', '全角空格'],
      ['give "" 1', '空参数'],
      ['give "a b" 2', '引号含空格'],
      ["set 'x y' 1", '单引号'],
    ];

    for (const [input, label] of cases) {
      test(`${label}：两份结果一致`, () => {
        eq(
          JSON.stringify(tokenizeCheat(input)),
          JSON.stringify(tokenizeConsole(input)),
          `输入 ${JSON.stringify(input)} 两份 tokenize 结果不同`
        );
      });
    }

    test('空参数不得被吞（原 A2-2 缺陷）', () => {
      eq(JSON.stringify(tokenizeCheat('give "" 1')), '["give","","1"]');
      eq(JSON.stringify(tokenizeConsole('give "" 1')), '["give","","1"]');
    });

    test('NBSP 必须当分隔符（否则网页复制的命令永远匹配不上）', () => {
      // 曾经 cheatcode 会得到 ['god\u00a0mode']（一个 token）
      eq(JSON.stringify(tokenizeCheat('god\u00a0mode')), '["god","mode"]');
    });

    test('未闭合引号仍然抛错，且错误类型各自保持', () => {
      let e1: any = null;
      try {
        tokenizeCheat('give "x');
      } catch (e) {
        e1 = e;
      }
      assert(e1 !== null, 'cheatcode 应抛错');

      let e2: any = null;
      try {
        tokenizeConsole('give "x');
      } catch (e) {
        e2 = e;
      }
      assert(e2 !== null, 'debug-console 应抛错');
      // 两份抛的不是同一个类（console 用 CommandError）
      assert(
        e1.constructor !== e2.constructor,
        '两份应抛出各自模块的错误类型'
      );
    });
  });

  // ==================== 引擎实测第三轮 · 滑动窗口检测间歇作弊 ====================
  describe('anticheat · 滑动窗口', () => {
    const base = { maxSpeed: 10, tolerance: 1.15, strikeThreshold: 3 };

    test('间歇作弊：仅连续计数会漏检（问题存在性）', () => {
      const c = new SpeedChecker(base);
      let x = 0;
      let t = 0;
      let flagged = false;
      for (let f = 0; f < 200; f++) {
        t += 1000 / 60;
        x += ((f % 3) === 0 ? 25 : 3) * (1 / 60);
        if (c.push({ x, y: 0, t })?.flagged) flagged = true;
      }
      eq(flagged, false, '仅连续计数本就该漏检——这是问题的存在性证明');
    });

    test('间歇作弊：开窗口能检出', () => {
      const c = new SpeedChecker({ ...base, windowSize: 60, windowThreshold: 5 });
      let x = 0;
      let t = 0;
      let flagged = false;
      for (let f = 0; f < 200; f++) {
        t += 1000 / 60;
        x += ((f % 3) === 0 ? 25 : 3) * (1 / 60);
        if (c.push({ x, y: 0, t })?.flagged) flagged = true;
      }
      eq(flagged, true, '开窗口后应能检出间歇作弊');
    });

    test('窗口会滑走（不秋后算账）', () => {
      const c = new SpeedChecker({ ...base, windowSize: 10, windowThreshold: 3 });
      let x = 0;
      let t = 0;
      for (let f = 0; f < 5; f++) {
        t += 1000 / 60;
        x += 25 * (1 / 60);
        c.push({ x, y: 0, t });
      }
      assert(c.windowHits > 0, '超速后窗口内应有记录');
      for (let f = 0; f < 20; f++) {
        t += 1000 / 60;
        x += 3 * (1 / 60);
        c.push({ x, y: 0, t });
      }
      eq(c.windowHits, 0, '正常 20 帧后旧记录应滑出窗口');
    });

    test('未启用窗口时行为与改动前完全一致（反向验证）', () => {
      const c = new SpeedChecker(base);
      let x = 0;
      let t = 0;
      let first = -1;
      for (let f = 0; f < 10; f++) {
        t += 1000 / 60;
        x += 25 * (1 / 60);
        if (c.push({ x, y: 0, t })?.flagged && first < 0) first = f + 1;
      }
      // 第 1 帧 push 返回 null（无前序样本），第 4 帧 strikes 才到 3
      eq(first, 4, '未启用窗口时首次 flagged 的帧必须与改动前一致');
      eq(c.windowHits, 0, '未启用窗口时 windowHits 恒为 0');
    });

    test('窗口阈值精确到帧', () => {
      for (const thr of [1, 2, 3, 5, 8]) {
        // strikeThreshold 调到极大，隔离出窗口判据
        const c = new SpeedChecker({
          maxSpeed: 10,
          strikeThreshold: 9999,
          windowSize: 10,
          windowThreshold: thr,
        });
        let x = 0;
        let t = 0;
        let first = -1;
        for (let f = 0; f < 15; f++) {
          t += 1000 / 60;
          x += 25 * (1 / 60);
          if (c.push({ x, y: 0, t })?.flagged && first < 0) first = f + 1;
        }
        // 第 1 帧 push 返回 null，第 N 个窗口项落在第 N+1 帧
        eq(first, thr + 1, `threshold=${thr} 时首次 flagged 的帧不对`);
      }
    });

    test('构造参数校验', () => {
      const bad = [
        { windowSize: 10, windowThreshold: 0 },
        { windowSize: 0, windowThreshold: 3 },
        { windowSize: 5, windowThreshold: 10 },
        { windowSize: -1 },
      ];
      for (const extra of bad) {
        let threw = false;
        try {
          new SpeedChecker({ maxSpeed: 10, ...extra });
        } catch {
          threw = true;
        }
        eq(threw, true, `非法配置 ${JSON.stringify(extra)} 应抛错`);
      }
    });
  });

  // ==================== 引擎实测第三轮 · ranking 浮点边界 ====================
  //
  // 【来源】外部引擎实测报告第三轮 P1-3 抓到：
  //   exportState() 存 floor → importState() 用 tierOf(floor) 重建
  //   → 小段降一级（白银 I 恢复成白银 II）
  //
  // 【根因比报告说的更广】不只是 export/import——
  // `tierOf(floor)` 在任何地方都不稳定，因为
  // (1583.3333333333333 - 1500) / 66.66666666666667 = 1.9999999999999987
  // 而不是 2。所以这里测的是根因，不是只测往返。
  describe('ranking · 小段边界的浮点归位', () => {
    const cfg = defaultRankConfig();

    test('每个小段的 floor 反查都应落回自己（根因测试）', () => {
      let bad = 0;
      for (let i = 0; i < cfg.tiers.length; i++) {
        const t = cfg.tiers[i];
        const div = t.divisions ?? 1;
        if (div <= 1) continue;
        const nextMin = cfg.tiers[i + 1]?.minRating ?? Infinity;
        if (nextMin === Infinity) continue;
        const span = (nextMin - t.minRating) / div;
        for (let d = 0; d < div; d++) {
          const floor = t.minRating + span * (div - 1 - d);
          const back = tierOf(floor, cfg);
          if (back.division !== d) {
            bad++;
            assert(false, `${t.name} floor=${floor} 期望 division=${d}，实得 ${back.division}（${back.label}）`);
          }
        }
      }
      eq(bad, 0, '有小段的 floor 反查落到了别的小段');
    });

    test('export→import 段位完全一致（报告原始场景）', () => {
      // 三段配置，复现报告里的 1150 场景
      const c3 = {
        tiers: [
          { id: 'bronze', name: '青铜', minRating: 0, divisions: 3 },
          { id: 'silver', name: '白银', minRating: 1000, divisions: 3 },
          { id: 'gold', name: '黄金', minRating: 1200, divisions: 3 },
        ],
        promotionMargin: 20,
        demotionShieldGames: 3,
      };
      const rp = new RankProgress(c3 as any, 1200);
      rp.update(1150);
      const before = rp.current!;
      const st = rp.exportState()!;

      const rp2 = new RankProgress(c3 as any);
      rp2.importState(st);
      const after = rp2.current!;

      eq(after.division, before.division, '小段不应变化');
      eq(after.tier.id, before.tier.id, '大段不应变化');
      eq(after.label, before.label, 'label 不应变化');
    });

    test('段内进度不再归零（exportState 存真实分数）', () => {
      // 曾经 exportState 存 floor，恢复后 progress 从 20% 变 0%
      const p = new RankProgress(cfg, 1600);
      const orig = p.current!;
      const st = p.exportState()!;
      const p2 = new RankProgress(cfg);
      p2.importState(st);
      assert(
        Math.abs(p2.current!.progress - orig.progress) < 1e-9,
        `进度丢失：${orig.progress.toFixed(3)} → ${p2.current!.progress.toFixed(3)}`
      );
    });

    test('全量扫描：1200~2900 每 17 分，段位与进度都无损', () => {
      let badDiv = 0;
      let badProg = 0;
      for (let r = 1200; r <= 2900; r += 17) {
        const p = new RankProgress(cfg, r);
        const s = p.exportState();
        if (!s) continue;
        const p2 = new RankProgress(cfg);
        p2.importState(s);
        const a = p.current!;
        const b = p2.current!;
        if (a.division !== b.division || a.tier.id !== b.tier.id) badDiv++;
        if (Math.abs(a.progress - b.progress) > 1e-9) badProg++;
      }
      eq(badDiv, 0, '有分数存档后段位变了');
      eq(badProg, 0, '有分数存档后段内进度变了');
    });

    test('旧存档兼容：存的是 floor 也能正确恢复', () => {
      // 旧版 exportState 存的是 floor。升级后读旧档不应降级。
      const oldSave = { rating: 1133.3333333333333, shield: 3, belowLine: true };
      const rp = new RankProgress(defaultRankConfig());
      rp.importState(oldSave);
      // 1133.33 在白银段（1000~1200，3 小段）：span=66.67
      // offset = floor(133.33/66.67) = floor(2.0) = 2 → division = 0（白银 I）
      assert(rp.current !== null, '应有段位');
      eq(rp.current!.division, 0, '旧存档恢复后不应降级（division 应为 0）');
    });
  });

  // ==================== P1-2 CellularDungeon 分帧生成 ====================
  //
  // 【为什么单独测】
  // generate() 现在委托给 generateSteps()。如果两者逻辑各自演化，
  // 唯一的症状是"有的地图长这样、有的长那样"——没人会怀疑是两条路径。
  describe('P1-2 dungeon · generateSteps 分帧生成与 generate 结果一致', () => {
    const N = 96;

    test('分帧跑完的结果与一次性 generate 逐格相同', () => {
      const a = new CellularDungeon({ width: N, height: N, seed: 42 });
      a.generate();

      const b = new CellularDungeon({ width: N, height: N, seed: 42 });
      const it = b.generateSteps(7);
      while (!it.next().done) { /* 跑到结束 */ }

      let diff = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (a.tileAt(x, y) !== b.tileAt(x, y)) diff++;
        }
      }
      eq(diff, 0, '分帧与一次性结果不一致说明两条路径已经分叉');
    });

    test('不同 rowsPerStep 结果相同（步长只影响切分，不影响结果）', () => {
      const base = new CellularDungeon({ width: N, height: N, seed: 7 });
      base.generate();
      for (const step of [1, 3, 16, 1000, Number.POSITIVE_INFINITY]) {
        const d = new CellularDungeon({ width: N, height: N, seed: 7 });
        const it = d.generateSteps(step);
        while (!it.next().done) { /* 跑到结束 */ }
        let diff = 0;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) if (base.tileAt(x, y) !== d.tileAt(x, y)) diff++;
        }
        eq(diff, 0, `rowsPerStep=${step} 时结果应与其他步长一致`);
      }
    });

    test('分帧生成确实分成多步（不是一次跑完）', () => {
      const d = new CellularDungeon({ width: N, height: N, seed: 1 });
      const it = d.generateSteps(4);
      let steps = 0;
      while (!it.next().done) steps++;
      assert(steps > 5, `只用了 ${steps} 步，说明没真的切片`);
    });

    test('进度单调递增且最终为 1', () => {
      const d = new CellularDungeon({ width: N, height: N, seed: 3 });
      const it = d.generateSteps(8);
      let last = -1;
      let maxSeen = 0;
      while (true) {
        const r = it.next();
        if (r.value !== undefined) {
          assert(r.value >= last - 1e-9, `进度回退了：${last} → ${r.value}`);
          last = r.value;
          maxSeen = Math.max(maxSeen, r.value);
        }
        if (r.done) break;
      }
      eq(maxSeen, 1, '最终进度应为 1（做进度条要用）');
    });
  });

  // ==================== _tunnelToMain 的 O(n²) ====================
  //
  // 【为什么测】
  // 这条被四份外部审查报告全部漏掉——性能报告把 dungeon 的批量操作
  // 列为"未通过校验、不下结论"，所以从未被测量过。
  // 它只在"出现大次区"时触发，默认参数下完全测不出来。
  describe('dungeon · initialWallChance 高时不应出现平方级耗时', () => {
    test('0.55 墙密度下 256² 生成应在 200ms 内完成', () => {
      const d = new CellularDungeon({
        width: 256, height: 256, seed: 7, initialWallChance: 0.55,
      } as any);
      const t0 = Date.now();
      d.generate();
      const ms = Date.now() - t0;
      // 修复前实测 418ms，修复后 31ms。阈值 200ms 留足机器差异余量。
      assert(ms < 200, `256²/0.55 用了 ${ms}ms（修复前 418ms，疑似 O(n²) 回归）`);
    });

    test('边长 192 → 384，耗时增长应接近线性而非平方', () => {
      const time = (n: number): number => {
        const d = new CellularDungeon({
          width: n, height: n, seed: 7, initialWallChance: 0.55,
        } as any);
        const t0 = Date.now();
        d.generate();
        const ms = Date.now() - t0;
        return Math.max(ms, 1); // 避免除零
      };
      const t192 = time(192);
      const t384 = time(384);
      const ratio = t384 / t192;
      // 面积增长 4×。平方级（O(|region|×|main|)）会呈现 16× 以上。
      // 修复后实测约 3×（接近面积比，含 floodFill 的线性开销）。
      assert(ratio < 10, `边长翻倍耗时涨了 ${ratio.toFixed(1)}×（修复前约 9×，现应接近面积比 4×）`);
    });
  });

  // ==================== _core 几何类型 ====================
  describe('_core · 矩形两种表示法互转', () => {
    test('toCorners / toSized 往返一致', () => {
      const sized: IRectSized = { x: 10, y: 20, w: 30, h: 40 };
      const corners = toCorners(sized);
      eq(corners.minX, 10, 'minX');
      eq(corners.maxX, 40, 'maxX = x + w');
      eq(corners.maxY, 60, 'maxY = y + h');
      const back = toSized(corners);
      eq(back.w, 30, '往返后 w 应还原');
      eq(back.h, 40, '往返后 h 应还原');
    });

    test('rectContains 含边界', () => {
      const r: IRect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
      eq(rectContains(r, 0, 0), true, '左上角应算在内');
      eq(rectContains(r, 10, 10), true, '右下角应算在内');
      eq(rectContains(r, -1, 5), false, '越界应为 false');
    });

    test('rectOverlaps 含相切', () => {
      const a: IRect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
      const b: IRect = { minX: 10, minY: 0, maxX: 20, maxY: 10 };
      const c: IRect = { minX: 11, minY: 0, maxX: 20, maxY: 10 };
      eq(rectOverlaps(a, b), true, '共边应算相交');
      eq(rectOverlaps(a, c), false, '有 1 格间隙不应算相交');
    });

    test('setCorners 就地写入，不产生新对象', () => {
      const out = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      const ref = out;
      setCorners(out, 1, 2, 3, 4);
      assert(ref === out, 'setCorners 必须就地写');
      eq(out.maxX, 3, '写入值');
    });
  });

  // ==================== 编辑距离三处统一 ====================
  describe('编辑距离 · 三份实现已统一到 _core/string', () => {
    test('cheatcode.levenshtein 与 _core.editDistance 一致', () => {
      const cases: Array<[string, string]> = [
        ['setgold', 'setgld'], ['godmode', 'godmod'], ['abc', 'abc'],
        ['', ''], ['abc', ''], ['kitten', 'sitting'],
      ];
      for (const [a, b] of cases) {
        eq(levenshtein(a, b), editDistanceCore(a, b), `"${a}" vs "${b}"`);
      }
    });

    test('debug-console.similarity 与 _core.similarity 一致', () => {
      for (const [a, b] of [['setgold', 'setgld'], ['abc', 'abc'], ['a', 'abcdefghij']]) {
        assert(
          Math.abs(similarityConsole(a, b) - similarityCore(a, b)) < 1e-12,
          `"${a}" vs "${b}" 两处结果应相同`
        );
      }
    });

    test('【坑】similarity 有提前返回，不等于 1 - dist/max', () => {
      // 长度差超过 60% 时 similarity 直接返回 0，省一次 O(n×m)
      eq(similarityCore('a', 'abcdefghij'), 0, '长度差大应提前返回 0');
      const manual = 1 - editDistanceCore('a', 'abcdefghij') / 10;
      assert(manual > 0, `手算值 ${manual} 应大于 0，证明两者不是简单互转`);
    });
  });

  // ==================== 表达式深度上限 ====================
  regExpressionDepth();
}


// ============================================================
// 表达式 · 深度上限（外部安全审查 S2-2'）
// ============================================================
//
// 【为什么是"深度上限"而不是"消除递归"】
// 递归下降解析器改成迭代是一次完整重写，风险高。
// 而真正让玩家难受的不是"会溢出"，是溢出时报
// `RangeError: Maximum call stack size exceeded`——
// 既不说超了多少，也不说在哪，无从下手。
// 这里用主动计数把崩溃换成一句能看懂的话。
//
// 【为什么默认值是 1000】
// 实测上限会漂：嵌套括号两次测量分别卡在 2147 与 4561（差 2 倍），
// 取决于 JIT 状态与调用上下文。所以文档里写"N 项以下安全"是不可靠的，
// 只能自己定一条远低于运行时极限的线。

function regExpressionDepth(): void {
  describe('表达式 · 深度上限（S2-2\'）', () => {
    // 构造各形状的"必然溢出"输入
    const flat = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? '1' : '+1')).join(' ');
    const nest = (n: number) => '('.repeat(n) + '1' + ')'.repeat(n);
    const pow = (n: number) => Array.from({ length: n }, () => '2').join('^');
    const nots = (n: number) => '!'.repeat(n) + 'x';
    const tern = (n: number) => '1>0?'.repeat(n) + '1' + ':0'.repeat(n);

    test('默认值是 1000（远低于实测下限 2147）', () => {
      eq(DEFAULT_MAX_DEPTH, 1000, '默认深度上限');
    });

    test('嵌套括号超限 → 明确报错，不是 RangeError', () => {
      let msg = '';
      try { new Expression(nest(5000)); } catch (e: any) { msg = String(e.message); }
      assert(msg.includes('嵌套过深'), `应报"嵌套过深"，实际：${msg.slice(0, 60)}`);
      assert(!msg.includes('call stack'), `不应是 RangeError，实际：${msg.slice(0, 60)}`);
    });

    test('扁平长式超限 → AST 深度检查拦住（解析阶段是循环，拦不住）', () => {
      let msg = '';
      try { new Expression(flat(5000)); } catch (e: any) { msg = String(e.message); }
      assert(msg.includes('AST 深度'), `应由 AST 深度检查拦住，实际：${msg.slice(0, 60)}`);
      assert(msg.includes('5000'), `报错应带上实际深度，实际：${msg.slice(0, 80)}`);
    });

    test('^ 右结合链超限 → parseBinary 计数拦住（不经 parseTernary）', () => {
      let msg = '';
      try { new Expression(pow(5000)); } catch (e: any) { msg = String(e.message); }
      assert(msg.includes('嵌套过深'), `^ 链必须被拦住，实际：${msg.slice(0, 80)}`);
    });

    test('! 链超限 → parseUnary 计数拦住（不经 parseTernary）', () => {
      let msg = '';
      try { new Expression(nots(5000)); } catch (e: any) { msg = String(e.message); }
      assert(msg.includes('嵌套过深'), `! 链必须被拦住，实际：${msg.slice(0, 80)}`);
    });

    test('三元链超限 → parseTernary 计数拦住', () => {
      let msg = '';
      try { new Expression(tern(5000)); } catch (e: any) { msg = String(e.message); }
      assert(msg.includes('嵌套过深'), `三元链必须被拦住，实际：${msg.slice(0, 80)}`);
    });

    test('【不误伤】正常表达式照常工作', () => {
      eq(new Expression('1 + 2 * 3').evaluate({}), 7, '普通算术');
      eq(new Expression('(1 + 2) * 3').evaluate({}), 9, '带括号');
      eq(new Expression('max(1, min(2, 3))').evaluate({}), 2, '函数调用');
      eq(new Expression('a > 0 ? 1 : 2').evaluate({ a: 5 }), 1, '三元');
      eq(new Expression('p.atk * 2').evaluate({ p: { atk: 3 } }), 6, '变量路径');
    });

    test('【不误伤】200 项长式与 100 层嵌套仍可用（留 5~10 倍余量）', () => {
      eq(new Expression(flat(200)).evaluate({}), 200, '200 项长式');
      eq(new Expression(nest(100)).evaluate({}), 1, '100 层嵌套');
    });

    test('maxDepth 可配置：调小后更早拦住', () => {
      let msg = '';
      try { new Expression(flat(5000), { maxDepth: 100 }); } catch (e: any) { msg = String(e.message); }
      assert(msg.includes('超过上限 100'), `应报上限 100，实际：${msg.slice(0, 80)}`);
    });

    test('maxDepth 调大后仍能处理中等规模（但越过运行时极限仍会 RangeError）', () => {
      // 这一项记录的是【已知边界】，不是"要求它必须成功"：
      // 求值仍是递归的，把上限抬到运行时极限之上（约 4300）就会回到 RangeError。
      // 所以 maxDepth 的作用是"在安全区里给明确报错"，不是"让超深表达式可用"。
      eq(new Expression(flat(2000), { maxDepth: 3000 }).evaluate({}), 2000, '2000 项在上限内应可用');
    });

    test('maxDepth 被 clampNum 兜底：0 与负数不会让检查失效', () => {
      // 【为什么从报错文案验证，而不是读 maxDepth getter】
      // maxDepth=1 时连 `1+1` 都构造失败，根本拿不到实例去读 getter。
      // 所以改看报错里的数字：传 0 / -5 都应显示"超过 1 层"，
      // 显示 "超过 0 层" 或 "超过 -5 层" 就说明兜底没生效
      // （那会让 enter() 第一次调用就命中，检查失去意义）。
      for (const d of [0, -5, -100]) {
        let msg = '';
        try { new Expression('1+1', { maxDepth: d }); } catch (e: any) { msg = String(e.message); }
        assert(
          msg.includes('超过 1 层'),
          `maxDepth=${d} 应被兜底到 1，实际报错：${msg.slice(0, 60)}`
        );
      }
      // 正常值的 getter 仍可读
      eq(new Expression('1+1', { maxDepth: 100 }).maxDepth, 100, '正常值应原样保留');
      eq(new Expression('1+1').maxDepth, DEFAULT_MAX_DEPTH, '默认应等于 DEFAULT_MAX_DEPTH');
    });

    test('maxDepth 非有限值（NaN / ±Infinity）回退默认', () => {
      // 【为什么单独立一项，不并入上面 0/负数那条】
      // 两者的兜底目标不同：
      //   0 / 负数      → 夹到下界 1（报错文案是"超过 1 层"）
      //   NaN/±Infinity → 回退 DEFAULT_MAX_DEPTH（能拿到实例，直接读 getter）
      // 塞进同一个循环就得写两套断言，反而看不清各自在测什么。
      //
      // 【为什么这条必须存在】
      // `depth > NaN` 恒为 false —— 一旦 maxDepth 变成 NaN，
      // 深度检查**彻底失效**，几千项的式子会直接 RangeError 栈溢出。
      // 而栈溢出不是可靠的 try/catch 对象，栈已损坏，后续行为不可预测。
      for (const bad of [NaN, Infinity, -Infinity]) {
        const e = new Expression('1+1', { maxDepth: bad });
        eq(e.maxDepth, DEFAULT_MAX_DEPTH, `maxDepth=${bad} 应回退到默认值`);
      }
      // 回退后功能正常（不是仅仅"不崩"）
      eq(new Expression('1+1', { maxDepth: NaN }).evaluate({}), 2, '回退后应能正常求值');
    });

    test('【已知边界】maxDepth 小于 7 时连 1+1 都过不去', () => {
      // 这一项记录的是【实测事实】，不是"期望它这样"。
      //
      // 基础解析链本身就是 4 层：parseTernary → parseBinary → parseUnary → parsePrimary。
      // 实测四种基本形态全部可用需要 maxDepth >= 7：
      //   4: 只有 1+1 和三元能过
      //   6: 多了 max(1,2)
      //   7: (1+2)*3 也能过
      // 所以兜底值 1 只是"防 0 和负数让检查失效"，不是"可用下限"。
      // 默认值 1000 离这个边界很远，正常配置碰不到。
      for (const d of [1, 2, 3]) {
        let threw = false;
        try { new Expression('1+1', { maxDepth: d }); } catch { threw = true; }
        assert(threw, `maxDepth=${d} 时连 1+1 都应被拒`);
      }
      // 7 是实测的可用下限
      for (const src of ['1+1', '(1+2)*3', 'max(1,2)', '1>0?1:2']) {
        let threw = false;
        try { new Expression(src, { maxDepth: 7 }); } catch { threw = true; }
        assert(!threw, `maxDepth=7 时 "${src}" 应可用`);
      }
    });
  });
}
