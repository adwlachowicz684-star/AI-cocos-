/**
 * tests/run_batch17.ts —— 第十六批测试：评分与匹配
 *
 * 本批六个模块：
 * 1. Elo          · ELO 评分（1v1 / 多人 / 零和 / 地板）
 * 2. Glicko2      · Glicko-2（含 Glickman 论文标准算例校验）
 * 3. Matchmaker   · 撮合队列（双向范围 / 窗口放宽 / 组队不拆）
 * 4. TeamBalancer · 分队平衡（黑店不拆 / 角色配额）
 * 5. Lobby        · 房间（房主迁移 / 准备状态）
 * 6. RankTier     · 段位与赛季（边界横跳 / 掉段保护 / 软重置）
 */

import { test, describe, assert, eq, near, throws } from './_framework';
import {
  expectedScore,
  ratingGapFor,
  kFactor,
  rate1v1,
  rateMultiplayer,
  rateMultiplayerDetailed,
  averageRating,
} from '../elo/Elo';
import {
  ratePeriod,
  decayRd,
  decayRdClosedForm,
  expectedScore as glickoExpected,
  confidenceInterval,
  conservativeRating,
  isSettled,
  ratingsOverlap,
  createGlickoPlayer,
  exportGlicko,
  importGlicko,
  GLICKO_DEFAULT_RD,
} from '../elo/Glicko2';
import {
  Matchmaker,
  matchQuality,
  estimateWaitMs,
  type QueueEntry,
} from '../matchmaking/Matchmaker';
import {
  balanceTeams,
  splitIntoTwoTeams,
  validateTeamAssignment,
  type BalancePlayer,
} from '../matchmaking/TeamBalancer';
import { Lobby } from '../matchmaking/Lobby';
import {
  tierOf,
  RankProgress,
  softReset,
  softResetAll,
  romanNumeral,
  rankScore,
  defaultRankConfig,
  DEFAULT_TIERS,
} from '../ranking/RankTier';

export function runBatch17Tests(): void {
  // ================================================================
  describe('Elo · 经典评分', () => {
    // ================================================================

    test('同分对局期望 0.5', () => {
      near(expectedScore(1500, 1500), 0.5, 1e-9);
    });

    test('⚠️ 期望得分对称：E(a,b) + E(b,a) = 1', () => {
      for (const [a, b] of [[1500, 1200], [2000, 1800], [1000, 2500]]) {
        near(expectedScore(a!, b!) + expectedScore(b!, a!), 1, 1e-12);
      }
    });

    test('分差 400 时强手期望约 90.9%', () => {
      near(expectedScore(1600, 1200), 0.9091, 1e-3);
    });

    test('分差越大期望越极端（但不等于 1）', () => {
      assert(expectedScore(3000, 100) > 0.99, '应该极有优势');
      assert(expectedScore(3000, 100) < 1, '但永远不能等于 1');
      assert(expectedScore(100, 3000) > 0, '弱手也永远有机会');
    });

    test('⚠️ ratingGapFor 是 expectedScore 的反函数', () => {
      for (const e of [0.6, 0.75, 0.9]) {
        const gap = ratingGapFor(e);
        near(expectedScore(1500, 1500 - gap), e, 1e-9, `期望 ${e}`);
      }
    });

    test('ratingGapFor 越界抛错', () => {
      throws(() => ratingGapFor(0), '(0,1)');
      throws(() => ratingGapFor(1), '(0,1)');
    });

    test('K 值：新手用 provisionalK，高手用 masterK', () => {
      const cfg = { provisionalGames: 10, provisionalK: 64, masterThreshold: 2400, masterK: 16, baseK: 32 };
      eq(kFactor({ rating: 1200, games: 3 }, cfg), 64, '新手');
      eq(kFactor({ rating: 1200, games: 50 }, cfg), 32, '老手');
      eq(kFactor({ rating: 2500, games: 50 }, cfg), 16, '高手');
    });

    test('⚠️ games 为 0 也算新手（不是"未指定"）', () => {
      const cfg = { provisionalGames: 10, provisionalK: 64 };
      eq(kFactor({ rating: 1200 }, cfg), 64);
    });

    test('1v1：赢加分、输扣分', () => {
      const r = rate1v1({ rating: 1500, games: 100 }, { rating: 1500, games: 100 }, 1);
      assert(r.deltaA > 0, `赢家应加分，实际 ${r.deltaA}`);
      assert(r.deltaB < 0, `输家应扣分，实际 ${r.deltaB}`);
    });

    test('⚠️ 冷门获胜加分更多（弱胜强 > 强弱）', () => {
      const upset = rate1v1({ rating: 1200, games: 100 }, { rating: 1800, games: 100 }, 1);
      const expected = rate1v1({ rating: 1800, games: 100 }, { rating: 1200, games: 100 }, 1);
      assert(upset.deltaA > expected.deltaA,
        `冷门 ${upset.deltaA.toFixed(1)} 应大于 常规 ${expected.deltaA.toFixed(1)}`);
    });

    test('⚠️ 1v1 严格零和（K 相同时）', () => {
      /**
       * 【必须显式关掉 masterThreshold】
       * 默认值 2400 会让 2400 分的玩家用 masterK=16，
       * 而对手用 baseK=32 —— K 不同必然破坏零和。
       * 这条测试要验的是"K 相同时守恒"，所以把阈值顶到天上。
       */
      const cfg = {
        baseK: 32, allowDecimal: true, provisionalGames: 0,
        masterThreshold: 1e9,
      };
      for (const [ra, rb] of [[1500, 1500], [1200, 1800], [2400, 900]]) {
        for (const outcome of [1, 0.5, 0] as const) {
          const r = rate1v1({ rating: ra!, games: 100 }, { rating: rb!, games: 100 }, outcome, cfg);
          near(r.deltaA + r.deltaB, 0, 1e-9, `${ra} vs ${rb} 结果${outcome}`);
        }
      }
    });

    test('⚠️ K 不同时零和会被打破（这是设计选择，不是 bug）', () => {
      const cfg = { allowDecimal: true, provisionalK: 64, baseK: 32 };
      const r = rate1v1({ rating: 1500, games: 2 }, { rating: 1500, games: 500 }, 1, cfg);
      assert(Math.abs(r.deltaA + r.deltaB) > 1e-9, 'K 不同，总和不为 0');
      eq(r.kA, 64);
      eq(r.kB, 32);
    });

    test('平局：弱手加分、强手扣分', () => {
      const r = rate1v1({ rating: 1200, games: 100 }, { rating: 1800, games: 100 }, 0.5);
      assert(r.deltaA > 0, '弱手逼平强手应加分');
      assert(r.deltaB < 0, '强手被逼平应扣分');
    });

    test('⚠️ 分数地板：连输不会掉穿', () => {
      let a = { rating: 150, games: 100 };
      const b = { rating: 2000, games: 100 };
      for (let i = 0; i < 50; i++) {
        const r = rate1v1(a, b, 0);
        a = { rating: r.a, games: 100 };
      }
      assert(a.rating >= 100, `不应低于地板，实际 ${a.rating}`);
    });

    test('⚠️ 取整会让小分差"冻住"（低分段爬不出来）', () => {
      /**
       * 【这是一个真实且隐蔽的陷阱】
       *
       * 150 分的人输给 2000 分的人，理论扣分约 0.0008 分。
       * 取整后是 0 —— 分数永远不动。
       *
       * 后果：低分玩家发现自己"怎么打都不涨分"，
       * 因为对局分差太大，每次变化都不足 1 分。
       *
       * 【解法】用 `allowDecimal: true` 内部保留小数，
       * 只在展示时取整。这也是本库默认推荐的做法。
       */
      const intCfg = { allowDecimal: false, provisionalGames: 0, masterThreshold: 1e9 };
      const decCfg = { allowDecimal: true, provisionalGames: 0, masterThreshold: 1e9 };

      let aInt = 150;
      let aDec = 150;
      for (let i = 0; i < 20; i++) {
        aInt = rate1v1({ rating: aInt, games: 100 }, { rating: 2000, games: 100 }, 0, intCfg).a;
        aDec = rate1v1({ rating: aDec, games: 100 }, { rating: 2000, games: 100 }, 0, decCfg).a;
      }
      eq(aInt, 150, '取整模式：20 局后分数纹丝不动');
      assert(aDec < 150 && aDec > 149.9, `小数模式：应有实际变化，实际 ${aDec.toFixed(4)}`);
    });

    test('⚠️ 地板让零和失效（文档化行为）', () => {
      /**
       * 要触发夹取，必须让扣分幅度真的大到穿透地板。
       * 同分对局扣 16 分，从 100 掉到 84，被夹回 100 —— 这时零和就破了。
       */
      const cfg = {
        allowDecimal: true, ratingFloor: 100,
        provisionalGames: 0, masterThreshold: 1e9,
      };
      const r = rate1v1({ rating: 100, games: 100 }, { rating: 100, games: 100 }, 0, cfg);
      eq(r.a, 100, '84 被夹回地板 100');
      eq(r.b, 116, '对手正常涨到 116');

      /**
       * 【注意区分两个概念】
       * - `deltaA / deltaB` 是**理论变化量**，仍然严格零和（-16 / +16）
       * - **实际变化量**被地板破坏了：a 没动，b 涨了 16
       *
       * 所以要断言的是后者，而不是 delta 之和。
       */
      near(r.deltaA + r.deltaB, 0, 1e-9, '理论变化量仍零和');
      const appliedSum = (r.a - 100) + (r.b - 100);
      near(appliedSum, 16, 1e-9, '但实际凭空多出 16 分');
    });

    test('非法结果值抛错', () => {
      throws(() => rate1v1({ rating: 1500 }, { rating: 1500 }, 0.7 as never), '1 / 0.5 / 0');
    });

    test('allowDecimal: false 时取整', () => {
      const r = rate1v1({ rating: 1500, games: 100 }, { rating: 1520, games: 100 }, 1);
      eq(r.a, Math.round(r.a));
      eq(r.b, Math.round(r.b));
    });

    // ---- 多人 ----

    test('多人：第一名加分、最后一名扣分', () => {
      const players = [
        { rating: 1500, games: 100 },
        { rating: 1500, games: 100 },
        { rating: 1500, games: 100 },
        { rating: 1500, games: 100 },
      ];
      const after = rateMultiplayer(players, [0, 1, 2, 3], { allowDecimal: true });
      assert(after[0]! > 1500, `冠军应加分，实际 ${after[0]}`);
      assert(after[3]! < 1500, `末位应扣分，实际 ${after[3]}`);
    });

    test('⚠️ 多人严格零和（K 相同时）', () => {
      const cfg = { baseK: 32, allowDecimal: true, provisionalGames: 0, ratingFloor: -1e9 };
      const players = [1600, 1500, 1400, 1300, 1200].map((r) => ({ rating: r, games: 100 }));
      const before = players.reduce((a, p) => a + p.rating, 0);
      const after = rateMultiplayer(players, [0, 1, 2, 3, 4], cfg);
      const sum = after.reduce((a, r) => a + r, 0);
      near(sum, before, 1e-6, '总分必须守恒');
    });

    test('⚠️ 并列名次：两人并列第一都不亏', () => {
      const cfg = { allowDecimal: true, provisionalGames: 0 };
      const players = [
        { rating: 1500, games: 100 },
        { rating: 1500, games: 100 },
        { rating: 1500, games: 100 },
      ];
      const after = rateMultiplayer(players, [0, 0, 2], cfg);
      near(after[0]!, after[1]!, 1e-9, '并列者变化应相同');
      assert(after[0]! > 1500, '并列第一应加分');
      assert(after[2]! < 1500, '第三名应扣分');
    });

    test('⚠️ 全部并列且同分 → 无人变动', () => {
      const cfg = { allowDecimal: true, provisionalGames: 0 };
      const players = [1500, 1500, 1500].map((r) => ({ rating: r, games: 100 }));
      const after = rateMultiplayer(players, [0, 0, 0], cfg);
      for (const r of after) near(r, 1500, 1e-9);
    });

    test('多人：强手拿第一加得少（期望高）', () => {
      const cfg = { allowDecimal: true, provisionalGames: 0 };
      const weakFirst = rateMultiplayer(
        [{ rating: 1200, games: 100 }, { rating: 1800, games: 100 }], [0, 1], cfg);
      const strongFirst = rateMultiplayer(
        [{ rating: 1800, games: 100 }, { rating: 1200, games: 100 }], [0, 1], cfg);
      const weakGain = weakFirst[0]! - 1200;
      const strongGain = strongFirst[0]! - 1800;
      assert(weakGain > strongGain,
        `弱手夺冠 ${weakGain.toFixed(2)} 应多于 强手夺冠 ${strongGain.toFixed(2)}`);
    });

    test('多人明细：expected + actual 可解读', () => {
      const players = [
        { rating: 1800, games: 100 },
        { rating: 1500, games: 100 },
        { rating: 1200, games: 100 },
      ];
      const d = rateMultiplayerDetailed(players, [0, 1, 2], { allowDecimal: true, provisionalGames: 0 });
      eq(d.length, 3);
      eq(d[0]!.actual, 2, '冠军赢了两场');
      eq(d[2]!.actual, 0, '末位全输');
      eq(d[1]!.actual, 1, '中间赢一场');
      assert(d[0]!.expected > d[1]!.expected, '强手期望更高');
    });

    test('⚠️ 多人参数校验', () => {
      throws(() => rateMultiplayer([{ rating: 1500 }], [0]), '至少需要 2 人');
      throws(
        () => rateMultiplayer([{ rating: 1500 }, { rating: 1500 }], [0]),
        '长度'
      );
      throws(
        () => rateMultiplayer([{ rating: 1500 }, { rating: 1500 }], [0, -1]),
        '非负整数'
      );
      throws(
        () => rateMultiplayer([{ rating: 1500 }, { rating: 1500 }], [0, 1.5]),
        '非负整数'
      );
    });

    test('averageRating 空数组返回 0', () => {
      eq(averageRating([]), 0);
    });

    test('⚠️ averageRating 用平均分不是总分', () => {
      const five = [1500, 1500, 1500, 1500, 1500].map((r) => ({ rating: r }));
      const two = [1500, 1500].map((r) => ({ rating: r }));
      eq(averageRating(five), averageRating(two), '队伍强度与人数无关');
    });
  });

  // ================================================================
  describe('Glicko2 · 含不确定度的评分', () => {
    // ================================================================

    test('⚠️ Glickman 论文标准算例', () => {
      /**
       * 这是 Glicko-2 论文（Glickman, "Example of the Glicko-2 system"）里的例子：
       *
       * 玩家 r=1500, RD=200, σ=0.06, τ=0.5
       * 对手：1400(RD=30) 胜、1550(RD=100) 负、1700(RD=300) 负
       *
       * 论文给出的结果：
       *   r'  = 1464.06
       *   RD' = 151.52
       *   σ'  = 0.05999
       *
       * 【为什么必须测这个】
       * 波动率的 Illinois 迭代没有任何"看起来对"的直觉判断标准。
       * 只有对照论文数值才能确认实现真的正确 ——
       * 写错一个符号，分数照样动，玩家只会觉得"给分有点怪"。
       */
      const player = createGlickoPlayer(1500, 200, 0.06);
      const result = ratePeriod(
        player,
        [
          { opponent: createGlickoPlayer(1400, 30, 0.06), score: 1 },
          { opponent: createGlickoPlayer(1550, 100, 0.06), score: 0 },
          { opponent: createGlickoPlayer(1700, 300, 0.06), score: 0 },
        ],
        { tau: 0.5 }
      );

      near(result.rating, 1464.06, 0.5, 'rating');
      near(result.rd, 151.52, 0.5, 'RD');
      near(result.sigma, 0.05999, 0.0001, 'sigma');
    });

    test('新号 RD 很大', () => {
      eq(createGlickoPlayer().rd, GLICKO_DEFAULT_RD);
      eq(GLICKO_DEFAULT_RD, 350);
    });

    test('⚠️ 打完一局后 RD 必然下降', () => {
      const p = createGlickoPlayer();
      const after = ratePeriod(p, [
        { opponent: createGlickoPlayer(1500, 60, 0.06), score: 1 },
      ]);
      assert(after.rd < p.rd, `RD 应下降：${p.rd} → ${after.rd}`);
    });

    test('⚠️ 新号比老号加分多得多（快速定级）', () => {
      const opponent = createGlickoPlayer(1500, 60, 0.06);
      const fresh = ratePeriod(createGlickoPlayer(1500, 350, 0.06), [
        { opponent, score: 1 },
      ]);
      const veteran = ratePeriod(createGlickoPlayer(1500, 40, 0.06), [
        { opponent, score: 1 },
      ]);
      const freshGain = fresh.rating - 1500;
      const vetGain = veteran.rating - 1500;
      assert(freshGain > vetGain * 3,
        `新号 ${freshGain.toFixed(1)} 应远多于 老号 ${vetGain.toFixed(1)}`);
    });

    test('⚠️ 久未参赛 → RD 上升（系统不再"确定"你）', () => {
      const p = createGlickoPlayer(1500, 50, 0.06);
      const after = ratePeriod(p, []);
      assert(after.rd > p.rd, `未参赛应涨 RD：${p.rd} → ${after.rd}`);
      eq(after.rating, p.rating, '分数本身不变');
    });

    test('RD 有上限，不会无限膨胀', () => {
      const p = createGlickoPlayer(1500, 50, 0.06);
      const after = decayRd(p, 10000);
      assert(after.rd <= GLICKO_DEFAULT_RD + 1e-9, `应被夹在 ${GLICKO_DEFAULT_RD}，实际 ${after.rd}`);
    });

    test('⚠️ decayRd 与闭式解结果一致', () => {
      const p = createGlickoPlayer(1500, 60, 0.06);
      for (const n of [0, 1, 5, 30]) {
        const loop = decayRd(p, n);
        const closed = decayRdClosedForm(p, n);
        near(loop.rd, closed.rd, 1e-6, `n=${n}`);
        near(loop.rating, closed.rating, 1e-9, `n=${n}`);
      }
    });

    test('decayRd 负数抛错', () => {
      throws(() => decayRd(createGlickoPlayer(), -1), '非负');
    });

    test('⚠️ 对手 RD 越大，你的分差优势被稀释', () => {
      const me = createGlickoPlayer(1800, 60, 0.06);
      const certain = createGlickoPlayer(1500, 30, 0.06);
      const uncertain = createGlickoPlayer(1500, 350, 0.06);
      const eCertain = glickoExpected(me, certain);
      const eUncertain = glickoExpected(me, uncertain);
      assert(eCertain > eUncertain,
        `对手确定时 ${eCertain.toFixed(3)} 应大于 不确定时 ${eUncertain.toFixed(3)}`);
      assert(eUncertain > 0.5, '但仍应占优');
    });

    test('⚠️ 打赢"水平确定"的对手加分更多', () => {
      const me = createGlickoPlayer(1500, 200, 0.06);
      const vsCertain = ratePeriod(me, [
        { opponent: createGlickoPlayer(1500, 30, 0.06), score: 1 },
      ]);
      const vsUnknown = ratePeriod(me, [
        { opponent: createGlickoPlayer(1500, 350, 0.06), score: 1 },
      ]);
      assert(vsCertain.rating > vsUnknown.rating,
        `打确定对手 ${vsCertain.rating.toFixed(1)} > 打未知对手 ${vsUnknown.rating.toFixed(1)}`);
    });

    test('置信区间', () => {
      const p = createGlickoPlayer(1500, 100, 0.06);
      const ci = confidenceInterval(p);
      eq(ci.low, 1300);
      eq(ci.high, 1700);
    });

    test('⚠️ 保守分：新号远低于真实分（防炸鱼）', () => {
      const fresh = createGlickoPlayer(1500, 350, 0.06);
      const veteran = createGlickoPlayer(1500, 50, 0.06);
      eq(conservativeRating(fresh), 800, '1500 - 2*350');
      eq(conservativeRating(veteran), 1400, '1500 - 2*50');
      assert(conservativeRating(fresh) < conservativeRating(veteran) - 500,
        '新号必须先跟弱对手打');
    });

    test('isSettled', () => {
      eq(isSettled(createGlickoPlayer(1500, 350)), false, '新号未定级');
      eq(isSettled(createGlickoPlayer(1500, 60)), true, '老号已定级');
    });

    test('ratingsOverlap', () => {
      const a = createGlickoPlayer(1500, 200, 0.06);   // 1100~1900
      const b = createGlickoPlayer(1700, 200, 0.06);   // 1300~2100
      const c = createGlickoPlayer(2500, 50, 0.06);    // 2400~2600
      eq(ratingsOverlap(a, b), true);
      eq(ratingsOverlap(a, c), false);
    });

    test('存档往返', () => {
      const p = createGlickoPlayer(1732.5, 87.25, 0.0512);
      const back = importGlicko(exportGlicko(p));
      near(back.rating, p.rating, 1e-9);
      near(back.rd, p.rd, 1e-9);
      near(back.sigma, p.sigma, 1e-9);
    });

    test('⚠️ 导入脏数据回退默认值而不是崩溃', () => {
      const p = importGlicko({ r: NaN, rd: -5, sigma: 'x' as never });
      eq(p.rating, 1500);
      assert(p.rd > 0 && p.rd <= GLICKO_DEFAULT_RD, `RD 应在合法区间，实际 ${p.rd}`);
      assert(p.sigma > 0, 'sigma 应为正');
    });

    test('非法 score 抛错', () => {
      throws(
        () => ratePeriod(createGlickoPlayer(), [
          { opponent: createGlickoPlayer(), score: 0.7 },
        ]),
        '1 / 0.5 / 0'
      );
    });

    test('分数区间可配', () => {
      const p = createGlickoPlayer(150, 200, 0.06);
      const after = ratePeriod(p, [
        { opponent: createGlickoPlayer(2000, 30, 0.06), score: 0 },
      ], { ratingFloor: 200 });
      assert(after.rating >= 200, `应被夹到 200，实际 ${after.rating}`);
    });
  });

  // ================================================================
  describe('Matchmaker · 撮合队列', () => {
    // ================================================================

    /** 造一批分数接近的玩家 */
    function crowd(n: number, base = 1500, spread = 0): QueueEntry[] {
      return Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        rating: spread === 0 ? base : base + (i / (n - 1) - 0.5) * spread,
      }));
    }

    test('人数不足时不撮合', () => {
      const mm = new Matchmaker({ teamSize: 5, teamsPerMatch: 2 });
      eq(mm.matchSize, 10);
      mm.enqueueAll(crowd(9), 0);
      eq(mm.tick(1000).length, 0);
      eq(mm.queueSize, 9);
    });

    test('人数够了就撮合', () => {
      const mm = new Matchmaker({ teamSize: 5, teamsPerMatch: 2 });
      mm.enqueueAll(crowd(10), 0);
      const ms = mm.tick(1000);
      eq(ms.length, 1);
      eq(ms[0]!.teams.length, 2);
      eq(ms[0]!.teams[0]!.length, 5);
      eq(mm.queueSize, 0, '撮合后应清空');
    });

    test('⚠️ 一轮撮出多场（而不是每秒一场）', () => {
      const mm = new Matchmaker({ teamSize: 1, teamsPerMatch: 2 });
      mm.enqueueAll(crowd(8), 0);
      eq(mm.tick(1000).length, 4, '8 人应撮出 4 场 1v1');
    });

    test('⚠️ 分差过大不撮合', () => {
      const mm = new Matchmaker({ teamSize: 1, teamsPerMatch: 2, initialRange: 50 });
      mm.enqueueAll([{ id: 'a', rating: 1500 }, { id: 'b', rating: 2000 }], 0);
      eq(mm.tick(1000).length, 0, '差 500 分不该立刻撮合');
    });

    test('⚠️ 窗口随等待时间放宽', () => {
      const mm = new Matchmaker({
        teamSize: 1, teamsPerMatch: 2,
        initialRange: 50, rangeGrowthPerSec: 5, maxRange: 500,
      });
      mm.enqueueAll([{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }], 0);
      eq(mm.tick(1000).length, 0, '差 100，1 秒时窗口才 55');

      // 等到窗口放宽到 100 以上
      mm.tick(10_000);
      eq(mm.queueSize, 0, '10 秒后窗口 100，应已撮合');
    });

    test('⚠️ 范围必须双向成立（核心 bug 防护）', () => {
      /**
       * 场景：
       * - A 等了很久，窗口已放宽到 500
       * - B 刚进队列，窗口只有 50
       * - 分差 400
       *
       * 只检查 A 的窗口 → 400 <= 500，撮合成功 → B 被分差 400 的对手打崩
       * 正确做法 → 取两者较小值 min(500, 50) = 50 → 400 > 50，不撮合
       */
      const mm = new Matchmaker({
        teamSize: 1, teamsPerMatch: 2,
        initialRange: 50, rangeGrowthPerSec: 5, maxRange: 500,
      });
      mm.enqueue([{ id: 'veteran', rating: 1600 }], 0);

      // 推进到 veteran 的窗口足够大
      let t = 0;
      while (t < 60_000) {
        t += 1000;
        if (mm.tick(t).length > 0) break;   // 队列里只有 1 人，撮不出来
      }

      // 此时 veteran 窗口已是 500。放进一个刚来的新手
      mm.enqueue([{ id: 'newbie', rating: 1200 }], t);
      eq(mm.tick(t + 1).length, 0, '新人的窗口只有 50，不该被捞进大佬的局');
    });

    test('⚠️ 超时后强制撮合（不能让人干等）', () => {
      const mm = new Matchmaker({
        teamSize: 1, teamsPerMatch: 2,
        initialRange: 10, maxRange: 20, guaranteedAfterMs: 5000,
      });
      mm.enqueueAll([{ id: 'a', rating: 1500 }, { id: 'b', rating: 2500 }], 0);
      eq(mm.tick(1000).length, 0, '分差 1000，远超时限内不撮合');

      const ms = mm.tick(6000);
      eq(ms.length, 1, '超过 guaranteedAfterMs 后强制撮合');
      eq(ms[0]!.relaxed, true, '应标记为放宽了限制');
    });

    test('⚠️ 组队不可拆（三人队必须在同一队）', () => {
      const mm = new Matchmaker({ teamSize: 3, teamsPerMatch: 2 });
      mm.enqueue([
        { id: 'a1', rating: 1500, partyId: 'A' },
        { id: 'a2', rating: 1510, partyId: 'A' },
        { id: 'a3', rating: 1490, partyId: 'A' },
      ], 0);
      mm.enqueueAll(crowd(3, 1500), 0);

      const ms = mm.tick(1000);
      eq(ms.length, 1);
      const flat = ms[0]!.teams.flat().map((e) => e.id);
      const teamOfA = ms[0]!.teams.findIndex((t) => t.some((e) => e.partyId === 'A'));
      assert(teamOfA >= 0, 'A 队应存在');
      for (const id of ['a1', 'a2', 'a3']) {
        assert(ms[0]!.teams[teamOfA]!.some((e) => e.id === id), `${id} 应和队伍在一起`);
      }
      eq(flat.length, 6);
    });

    test('⚠️ 队伍人数超过 teamSize 时入队就拒绝', () => {
      const mm = new Matchmaker({ teamSize: 3, teamsPerMatch: 2 });
      throws(
        () => mm.enqueue([
          { id: 'a1', rating: 1500, partyId: 'A' },
          { id: 'a2', rating: 1500, partyId: 'A' },
          { id: 'a3', rating: 1500, partyId: 'A' },
          { id: 'a4', rating: 1500, partyId: 'A' },
        ], 0),
        '永远撮合不出来'
      );
    });

    test('⚠️ 组队的人退出，全队一起退', () => {
      const mm = new Matchmaker({ teamSize: 3, teamsPerMatch: 2 });
      mm.enqueue([
        { id: 'a1', rating: 1500, partyId: 'A' },
        { id: 'a2', rating: 1500, partyId: 'A' },
      ], 0);
      eq(mm.queueSize, 2);
      mm.dequeue('a1');
      eq(mm.queueSize, 0, '队友应一起退出，不能留下残缺队伍');
    });

    test('单人退出只影响自己', () => {
      const mm = new Matchmaker({ teamSize: 1, teamsPerMatch: 2 });
      mm.enqueueAll(crowd(3), 0);
      mm.dequeue('p1');
      eq(mm.queueSize, 2);
    });

    test('重复入队抛错', () => {
      const mm = new Matchmaker({ teamSize: 1, teamsPerMatch: 2 });
      mm.enqueue([{ id: 'a', rating: 1500 }], 0);
      throws(() => mm.enqueue([{ id: 'a', rating: 1500 }], 0), '已在队列中');
    });

    test('⚠️ 撮合后不会重复撮合（队列已清理）', () => {
      const mm = new Matchmaker({ teamSize: 1, teamsPerMatch: 2 });
      mm.enqueueAll(crowd(4), 0);
      eq(mm.tick(1000).length, 2);
      eq(mm.queueSize, 0);
      eq(mm.tick(2000).length, 0, '队列已空，不该再出对局');
    });

    test('⚠️ 队伍平衡：两队平均分接近', () => {
      /**
       * 【窗口要开大】
       * 这条测的是"分完之后两队是否均衡"，不是"能不能撮合"。
       * 四人分数跨度 1000，默认窗口 ±50 根本撮不起来，
       * 所以显式把窗口放大到能容纳这个跨度。
       */
      const mm = new Matchmaker({
        teamSize: 2, teamsPerMatch: 2, balanceTeams: true,
        initialRange: 1000, maxRange: 1000,
      });
      mm.enqueueAll([
        { id: 's1', rating: 2000 }, { id: 's2', rating: 1000 },
        { id: 's3', rating: 1500 }, { id: 's4', rating: 1500 },
      ], 0);
      const ms = mm.tick(1000);
      eq(ms.length, 1);
      const [r0, r1] = ms[0]!.teamRatings;
      // 最优是 (2000,1000) vs (1500,1500)，两队都是 1500
      near(Math.abs(r0! - r1!), 0, 1e-9, `两队应完全均衡，实际 ${r0} vs ${r1}`);
    });

    test('等待时间统计', () => {
      const mm = new Matchmaker({ teamSize: 1, teamsPerMatch: 2 });
      mm.enqueueAll([{ id: 'a', rating: 1500 }], 0);
      mm.enqueueAll([{ id: 'b', rating: 1500 }], 3000);
      const ms = mm.tick(5000);
      eq(ms[0]!.maxWaitMs, 5000);
      eq(ms[0]!.avgWaitMs, 3500);
    });

    test('waitOf 查询等待时长', () => {
      const mm = new Matchmaker({ teamSize: 1, teamsPerMatch: 2 });
      mm.enqueue([{ id: 'a', rating: 1500 }], 1000);
      eq(mm.waitOf('a', 3000), 2000);
      eq(mm.waitOf('不在队列的人', 3000), -1);
    });

    test('clear 清空队列', () => {
      const mm = new Matchmaker({ teamSize: 1, teamsPerMatch: 2 });
      mm.enqueueAll(crowd(5), 0);
      mm.clear();
      eq(mm.queueSize, 0);
    });

    test('构造校验', () => {
      throws(() => new Matchmaker({ teamSize: 0 }), '正整数');
      throws(() => new Matchmaker({ teamSize: 2, teamsPerMatch: 0 }), '正整数');
    });

    test('⚠️ 大队伍优先放置（否则最后塞不下）', () => {
      // 2v2，一个 2 人黑店 + 2 个散人
      const mm = new Matchmaker({ teamSize: 2, teamsPerMatch: 2 });
      mm.enqueueAll([
        { id: 'a1', rating: 1500, partyId: 'A' },
        { id: 'a2', rating: 1500, partyId: 'A' },
        { id: 's1', rating: 1500 },
        { id: 's2', rating: 1500 },
      ], 0);
      const ms = mm.tick(1000);
      eq(ms.length, 1, '必须能撮合出来');
      for (const t of ms[0]!.teams) eq(t.length, 2);
    });

    // ---- 辅助函数 ----

    test('matchQuality：同分 = 1', () => {
      near(matchQuality([1500, 1500, 1500, 1500], 2), 1, 1e-9);
    });

    test('matchQuality：分差大 → 低', () => {
      const q = matchQuality([2000, 2000, 1000, 1000], 2);
      assert(q < 0.4, `应较低，实际 ${q.toFixed(3)}`);
      assert(q >= 0, '不能为负');
    });

    test('matchQuality 空数组返回 0', () => {
      eq(matchQuality([], 2), 0);
    });

    test('estimateWaitMs', () => {
      const w = estimateWaitMs(20, 10, 2);   // 20 人在排，每场 10 人，每分钟 2 场
      near(w, 60_000, 1e-6, '前面有 20 人，每分钟消化 20 人 → 60 秒');
    });

    test('estimateWaitMs 无历史数据时返回 Infinity', () => {
      eq(estimateWaitMs(20, 10, 0), Number.POSITIVE_INFINITY);
    });
  });

  // ================================================================
  describe('TeamBalancer · 分队平衡', () => {
    // ================================================================

    function players(rs: readonly number[], party?: (i: number) => string | undefined): BalancePlayer[] {
      return rs.map((r, i) => ({ id: `p${i}`, rating: r, partyId: party?.(i) }));
    }

    test('基本：人数均分', () => {
      const r = balanceTeams(players([1500, 1500, 1500, 1500]), { teamCount: 2 });
      eq(r.teams.length, 2);
      eq(r.teams[0]!.players.length, 2);
      eq(r.teams[1]!.players.length, 2);
    });

    test('⚠️ 最优解：(2000,1000) vs (1500,1500)，不是 (2000,1500) vs (1500,1000)', () => {
      /**
       * 蛇形分配会给出 (2000,1500) vs (1500,1000)，两队差 500。
       * 贪心"放进当前最弱队"（LPT）给出 (2000,1000) vs (1500,1500)，差 0。
       *
       * 这是"分数均匀递减时蛇形最优、其他分布时 LPT 更优"的典型例子。
       */
      const r = balanceTeams(players([2000, 1500, 1500, 1000]), { teamCount: 2 });
      near(r.spread, 0, 1e-9, `两队平均分差应为 0，实际 ${r.spread}`);
      near(r.fairness, 1, 1e-9, '公平度应为 1');
    });

    test('三队均衡', () => {
      const rs = [1800, 1700, 1600, 1500, 1400, 1300];
      const r = balanceTeams(players(rs), { teamCount: 3 });
      for (const t of r.teams) eq(t.players.length, 2);
      // 最优：总和 9300，每队 3100 → (1800,1300) (1700,1400) (1600,1500)
      near(r.spread, 0, 1e-9, `应为 0，实际 ${r.spread}`);
    });

    test('⚠️ 黑店不可拆', () => {
      const p = players([2000, 1900, 1200, 1100], (i) => (i < 2 ? 'stack' : undefined));
      const r = balanceTeams(p, { teamCount: 2 });
      const v = validateTeamAssignment(r.teams.map((t) => t.players));
      eq(v.ok, true, v.reason);

      // 黑店两人（2000,1900）必在同队，另一队是 (1200,1100)
      const stackTeam = r.teams.find((t) => t.players.some((x) => x.partyId === 'stack'));
      eq(stackTeam!.players.length, 2);
      assert(stackTeam!.players.every((x) => x.partyId === 'stack'), '黑店不应被拆');
    });

    test('⚠️ 黑店人数超过队容量 → 抛错', () => {
      const p = players([1500, 1500, 1500, 1500], (i) => (i < 3 ? 'trio' : undefined));
      throws(() => balanceTeams(p, { teamCount: 2 }), '超过每队容量');
    });

    test('⚠️ 人数除不尽 → 抛错', () => {
      throws(() => balanceTeams(players([1500, 1500, 1500]), { teamCount: 2 }), '无法均分');
    });

    test('空列表抛错', () => {
      throws(() => balanceTeams([], { teamCount: 2 }), '为空');
    });

    test('teamCount 非法抛错', () => {
      throws(() => balanceTeams(players([1500, 1500]), { teamCount: 0 }), '正整数');
    });

    test('⚠️ metric: top —— 避免"一队有个大哥"', () => {
      // sum 相同时：(2500,500) vs (1500,1500) 总分都是 3000
      // 但 top 口径下前者 top=2500、后者 top=1500，差距巨大
      const rs = [2500, 1500, 1500, 500];
      const sumMetric = balanceTeams(players(rs), { teamCount: 2, metric: 'sum' });
      const topMetric = balanceTeams(players(rs), { teamCount: 2, metric: 'top' });

      const topSpreadOf = (r: typeof sumMetric) =>
        Math.max(...r.teams.map((t) => t.top)) - Math.min(...r.teams.map((t) => t.top));

      assert(topSpreadOf(topMetric) <= topSpreadOf(sumMetric),
        `top 口径下最强者差距应更小：${topSpreadOf(topMetric)} vs ${topSpreadOf(sumMetric)}`);
    });

    test('metric: both 同时考虑总分与最强者', () => {
      const r = balanceTeams(players([2000, 1500, 1500, 1000]), { teamCount: 2, metric: 'both' });
      near(r.spread, 0, 1e-9);
    });

    test('optimize: false 时不做局部搜索（仍能给出合法解）', () => {
      const r = balanceTeams(players([2000, 1500, 1500, 1000]), {
        teamCount: 2, optimize: false,
      });
      eq(r.iterations, 0);
      eq(validateTeamAssignment(r.teams.map((t) => t.players)).ok, true);
    });

    test('⚠️ 角色配额', () => {
      const p: BalancePlayer[] = [
        { id: 'a', rating: 1500, role: 'tank' },
        { id: 'b', rating: 1500, role: 'tank' },
        { id: 'c', rating: 1500, role: 'dps' },
        { id: 'd', rating: 1500, role: 'support' },
      ];
      const r = balanceTeams(p, {
        teamCount: 2,
        roleQuota: { tank: 1, dps: 0.5, support: 0.5 } as never,
      });
      // 配额是每队 1 坦克；dps/support 各 0.5 表示两队合计 1 个
      for (const t of r.teams) {
        const tanks = t.players.filter((x) => x.role === 'tank').length;
        assert(tanks >= 1, `每队至少 1 坦克，实际 ${tanks}`);
      }
    });

    test('validateTeamAssignment：人数不均', () => {
      const v = validateTeamAssignment([
        [{ id: 'a', rating: 1500 }, { id: 'b', rating: 1500 }],
        [{ id: 'c', rating: 1500 }],
      ]);
      eq(v.ok, false);
      assert(v.reason!.includes('不均'), v.reason);
    });

    test('⚠️ validateTeamAssignment：黑店被拆', () => {
      const v = validateTeamAssignment([
        [{ id: 'a', rating: 1500, partyId: 'S' }],
        [{ id: 'b', rating: 1500, partyId: 'S' }],
      ]);
      eq(v.ok, false);
      assert(v.reason!.includes('拆'), v.reason);
    });

    test('⚠️ validateTeamAssignment：同人出现在两队', () => {
      const v = validateTeamAssignment([
        [{ id: 'a', rating: 1500 }],
        [{ id: 'a', rating: 1500 }],
      ]);
      eq(v.ok, false);
      assert(v.reason!.includes('多个队伍'), v.reason);
    });

    test('validateTeamAssignment：空队伍', () => {
      eq(validateTeamAssignment([]).ok, false);
    });

    test('splitIntoTwoTeams 便捷入口', () => {
      const r = splitIntoTwoTeams(players([2000, 1500, 1500, 1000]));
      eq(r.teams.length, 2);
      near(r.spread, 0, 1e-9);
    });

    test('⚠️ 10 人 5v5：分差应在合理范围', () => {
      const rs = [2200, 2100, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1100];
      const r = balanceTeams(players(rs), { teamCount: 2 });
      for (const t of r.teams) eq(t.players.length, 5);
      // LPT 在这种分布下能给出很小的分差
      assert(r.spread < 100, `分差应较小，实际 ${r.spread}`);
      assert(r.fairness > 0, '公平度应为正');
    });
  });

  // ================================================================
  describe('Lobby · 房间', () => {
    // ================================================================

    const P = (id: string) => ({ id, name: id.toUpperCase() });

    test('基本：加入与容量', () => {
      const l = new Lobby({ capacity: 4 });
      eq(l.join(P('a'), undefined, 0).ok, true);
      eq(l.size, 1);
      eq(l.isFull, false);
    });

    test('第一个进来的人是房主', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 0);
      eq(l.hostId, 'a');
      l.join(P('b'), undefined, 0);
      eq(l.hostId, 'a', '房主不变');
    });

    test('⚠️ 房主退出后自动迁移', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      l.leave('a');
      eq(l.hostId, 'b', '房主应迁移，否则没人能开局');
    });

    test('⚠️ 所有人退出后 hostId 为 null', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 0);
      l.leave('a');
      eq(l.hostId, null);
      eq(l.isEmpty, true);
    });

    test('满员后拒绝加入', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      eq(l.isFull, true);
      const r = l.join(P('c'), undefined, 0);
      eq(r.ok, false);
      eq(r.error, 'full');
    });

    test('重复加入被拒', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 0);
      eq(l.join(P('a'), undefined, 0).error, 'duplicate');
    });

    test('⚠️ 密码错误被拒', () => {
      const l = new Lobby({ capacity: 4, password: '1234' });
      eq(l.hasPassword, true);
      eq(l.join(P('a'), 'wrong', 0).error, 'wrong-password');
      eq(l.join(P('a'), '1234', 0).ok, true);
    });

    test('无密码房间不校验密码', () => {
      const l = new Lobby({ capacity: 4 });
      eq(l.join(P('a'), '随便传', 0).ok, true);
    });

    test('⚠️ 全员准备才能开局', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      eq(l.canStart().ok, false);
      l.setReady('a', true);
      eq(l.canStart().ok, false, '还有人没准备');
      l.setReady('b', true);
      eq(l.canStart().ok, true);
    });

    test('⚠️ 人数不足不能开局', () => {
      const l = new Lobby({ capacity: 4, minPlayers: 4 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      l.setReady('a', true);
      l.setReady('b', true);
      const r = l.canStart();
      eq(r.ok, false);
      eq((r as { reason: string }).reason, 'too-few');
    });

    test('⚠️ 重复设置准备不会重复计数', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      l.setReady('a', true);
      l.setReady('a', true);   // 重复
      eq(l.readyCount, 1, '用 Set 存储，重复设置不该累加');
    });

    test('⚠️ 退出后清除准备状态（不会有残留）', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      l.setReady('a', true);
      l.leave('a');
      l.join(P('c'), undefined, 0);
      l.setReady('c', true);
      l.setReady('b', true);
      eq(l.canStart().ok, true, '不该被已退出的人卡住');
    });

    test('⚠️ 踢人：只有房主能踢', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      l.join(P('c'), undefined, 0);
      eq(l.kick('b', 'c'), false, '非房主不能踢人');
      eq(l.kick('a', 'c'), true, '房主可以踢');
      eq(l.has('c'), false);
    });

    test('⚠️ 不能踢自己', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 0);
      eq(l.kick('a', 'a'), false);
      eq(l.size, 1);
    });

    test('⚠️ 踢掉房主后由剩下的人接任', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      // 房主 a 不能踢自己，但 transferHost 后可以
      l.transferHost('a', 'b');
      eq(l.hostId, 'b');
      l.kick('b', 'a');
      eq(l.hostId, 'b', '剩下的人接任');
    });

    test('transferHost 需要房主权限', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      eq(l.transferHost('b', 'b'), false);
      eq(l.transferHost('a', '不存在的人'), false);
    });

    test('⚠️ 开局后不再接受加入', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      l.setReady('a', true);
      l.setReady('b', true);
      l.beginStart();
      eq(l.state, 'starting');
      eq(l.join(P('c'), undefined, 0).error, 'started');
      eq(l.setReady('a', false), false, '开局中不能改准备状态');
    });

    test('⚠️ 不能重复开局', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      l.setReady('a', true);
      l.setReady('b', true);
      eq(l.beginStart(), true);
      const r = l.canStart();
      eq(r.ok, false);
      eq((r as { reason: string }).reason, 'already-started');
      eq(l.beginStart(), false, '不能开第二次');
    });

    test('beginStart 条件不足时失败', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      eq(l.beginStart(), false, '没人准备');
    });

    test('⚠️ reopen 保留玩家但清空准备', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      l.setReady('a', true);
      l.setReady('b', true);
      l.beginStart();
      l.finishStart();
      eq(l.state, 'closed');

      l.reopen();
      eq(l.state, 'open');
      eq(l.size, 2, '玩家还在');
      eq(l.readyCount, 0, '准备状态已清空，要重新点');
    });

    test('requireAllReady: false 时人数够就能开', () => {
      const l = new Lobby({ capacity: 2, requireAllReady: false });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      eq(l.canStart().ok, true, '不要求全员准备');
    });

    test('startBlockReason 给出可读提示', () => {
      const l = new Lobby({ capacity: 4, minPlayers: 4 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      assert(l.startBlockReason()!.includes('2 人'), l.startBlockReason()!);

      l.join(P('c'), undefined, 0);
      l.join(P('d'), undefined, 0);
      l.setReady('a', true);
      assert(l.startBlockReason()!.includes('3 人未准备'), l.startBlockReason()!);
    });

    test('canStart 成功时 startBlockReason 返回 null', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      l.setReady('a', true);
      l.setReady('b', true);
      eq(l.startBlockReason(), null);
    });

    test('⚠️ revision 随变化递增（客户端脏检查用）', () => {
      const l = new Lobby({ capacity: 4 });
      const r0 = l.revision;
      l.join(P('a'), undefined, 0);
      assert(l.revision > r0, '入队应递增');
      const r1 = l.revision;
      l.setReady('a', true);
      assert(l.revision > r1, '准备应递增');
    });

    test('⚠️ 设置准备成相同值也递增 revision（幂等但有变化）', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 0);
      l.setReady('a', true);
      const r = l.revision;
      l.setReady('a', true);
      eq(l.revision, r + 1);
    });

    test('slots 带完整状态', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 100);
      l.join(P('b'), undefined, 200);
      l.setReady('b', true);
      const slots = l.slots;
      eq(slots.length, 2);
      eq(slots[0]!.isHost, true);
      eq(slots[0]!.ready, false);
      eq(slots[1]!.isHost, false);
      eq(slots[1]!.ready, true);
      eq(slots[0]!.joinedAt, 100);
    });

    test('toggleReady', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.toggleReady('a');
      eq(l.isReady('a'), true);
      l.toggleReady('a');
      eq(l.isReady('a'), false);
    });

    test('setReady 对不在房间的人无效', () => {
      const l = new Lobby({ capacity: 2 });
      eq(l.setReady('不存在', true), false);
    });

    test('setPassword 需要房主权限', () => {
      const l = new Lobby({ capacity: 2 });
      l.join(P('a'), undefined, 0);
      l.join(P('b'), undefined, 0);
      eq(l.setPassword('b', 'x'), false);
      eq(l.setPassword('a', 'x'), true);
      eq(l.hasPassword, true);
    });

    test('snapshot 汇总', () => {
      const l = new Lobby({ capacity: 4, minPlayers: 2 });
      l.join(P('a'), undefined, 0);
      l.setReady('a', true);
      const s = l.snapshot();
      eq(s.capacity, 4);
      eq(s.minPlayers, 2);
      eq(s.hostId, 'a');
      eq(s.ready.length, 1);
      eq(s.state, 'open');
    });

    test('构造校验', () => {
      throws(() => new Lobby({ capacity: 0 }), '正整数');
      throws(() => new Lobby({ capacity: 2, minPlayers: 3 }), '超过容量');
    });

    test('close 后不能加入', () => {
      const l = new Lobby({ capacity: 4 });
      l.join(P('a'), undefined, 0);
      l.close();
      eq(l.join(P('b'), undefined, 0).error, 'closed');
    });
  });

  // ================================================================
  describe('RankTier · 段位与赛季', () => {
    // ================================================================

    const cfg = defaultRankConfig();

    test('青铜（最低段位）', () => {
      const t = tierOf(0, cfg);
      eq(t.tier.id, 'bronze');
      eq(t.tierIndex, 0);
      eq(t.label, '青铜 III', '最低段位的最低小段');
      eq(t.division, 2);
    });

    test('⚠️ 恰好在段位线上属于该段位（不是上一段的最高小段）', () => {
      const t = tierOf(1200, cfg);
      eq(t.tier.id, 'silver', '1200 应进白银');
      eq(t.division, 2, '白银 III（最低小段）');
      eq(t.floor, 1200);
      eq(t.progress, 0, '刚进段，进度 0');
    });

    test('⚠️ 小段编号方向：I 最高、III 最低', () => {
      const low = tierOf(1210, cfg);
      const mid = tierOf(1350, cfg);
      const high = tierOf(1450, cfg);
      eq(low.label, '白银 III');
      eq(mid.label, '白银 II');
      eq(high.label, '白银 I');
      assert(low.division > mid.division, 'III 的编号应大于 II');
      assert(mid.division > high.division, 'II 的编号应大于 I');
    });

    test('⚠️ 分数越高段位越高（rankScore 单调）', () => {
      let prev = -Infinity;
      for (let r = 0; r <= 2800; r += 50) {
        const s = rankScore(tierOf(r, cfg));
        assert(s >= prev, `${r} 分的 rankScore ${s} 不应小于前一个 ${prev}`);
        prev = s;
      }
    });

    test('小段边界：段位线前 1 分', () => {
      const t = tierOf(1499, cfg);
      eq(t.tier.id, 'silver', '1499 还在白银');
      eq(t.division, 0, '白银 I');
      eq(t.ceiling, 1500);
    });

    test('跨段位：1500 进黄金', () => {
      const t = tierOf(1500, cfg);
      eq(t.tier.id, 'gold');
      eq(t.division, 2, '黄金 III');
      eq(t.floor, 1500);
    });

    test('⚠️ 大师只有一个小段（不分 I/II/III）', () => {
      const t = tierOf(2400, cfg);
      eq(t.tier.id, 'master');
      eq(t.label, '大师', '不应显示"大师 I"');
    });

    test('⚠️ 宗师是 apex，进度恒为 1', () => {
      const t = tierOf(2700, cfg);
      eq(t.tier.id, 'grandmaster');
      eq(t.isApex, true);
      eq(t.label, '宗师');
      eq(t.progress, 1);
      eq(t.ceiling, Infinity);
      eq(t.toNext, Infinity, '没有下一档了');
    });

    test('超过最高段位仍返回 apex', () => {
      eq(tierOf(9999, cfg).tier.id, 'grandmaster');
    });

    test('⚠️ 段落未升序时抛错', () => {
      throws(
        () => tierOf(1500, {
          tiers: [
            { id: 'high', name: '高', minRating: 2000 },
            { id: 'low', name: '低', minRating: 1000 },
          ],
        }),
        '升序'
      );
    });

    test('空段位表抛错', () => {
      throws(() => tierOf(1500, { tiers: [] }), '为空');
    });

    test('romanNumeral', () => {
      eq(romanNumeral(0), 'I');
      eq(romanNumeral(1), 'II');
      eq(romanNumeral(3), 'IV');
      eq(romanNumeral(9), 'X');
    });

    test('romanNumeral 非法输入抛错', () => {
      throws(() => romanNumeral(-1), '非负整数');
      throws(() => romanNumeral(1.5), '非负整数');
    });

    test('DEFAULT_TIERS 是升序的', () => {
      for (let i = 1; i < DEFAULT_TIERS.length; i++) {
        assert(DEFAULT_TIERS[i]!.minRating > DEFAULT_TIERS[i - 1]!.minRating,
          `${DEFAULT_TIERS[i]!.id} 应高于 ${DEFAULT_TIERS[i - 1]!.id}`);
      }
    });

    // ---- 进度追踪 ----

    test('构造时给了分数 = 已完成定级，首次 update 不产生事件', () => {
      const rp = new RankProgress(cfg, 1200);
      eq(rp.current!.label, '白银 III', '构造时即定级');
      const u = rp.update(1200);
      eq(u.event, null, '分数没变，不该有事件');
      eq(u.previous!.label, '白银 III', 'previous 是构造时的段位');
    });

    test('⚠️ 未给定级分数时，首次 update 的 previous 为 null', () => {
      const rp = new RankProgress(cfg);
      eq(rp.current, null, '构造后未定级');
      const u = rp.update(1200);
      eq(u.previous, null, '首次定级没有"上一段位"');
      eq(u.event, null, '首次定级不算升段');
      eq(u.info.label, '白银 III');
    });

    test('未指定初始分时，首次 update 返回 null 事件', () => {
      const rp = new RankProgress(cfg);
      const u = rp.update(1200);
      eq(u.event, null);
      eq(u.info.tier.id, 'silver');
    });

    test('升段事件', () => {
      const rp = new RankProgress(cfg, 1200);
      const u = rp.update(1350);
      eq(u.event, 'promoted');
      eq(u.info.label, '白银 II');
      eq(u.previous!.label, '白银 III');
    });

    test('掉段事件', () => {
      const rp = new RankProgress(cfg, 1350);
      const u = rp.update(1210);
      eq(u.event, 'demoted');
      eq(u.info.label, '白银 III');
      assert(u.shieldGames > 0, '掉段后应给保护');
    });

    test('⚠️ 掉段保护：保护期内不掉段', () => {
      const rp = new RankProgress(cfg, 1350);
      rp.update(1210);            // 掉到白银 III，获得 3 局保护
      const u = rp.update(1000);  // 继续掉，但被保护
      eq(u.event, null, '保护期内不掉段');
      eq(u.shielded, true, '应标记触发了保护');
      eq(u.info.label, '白银 III', '段位不变');
      eq(u.shieldGames, 2, '消耗一局保护');
    });

    test('⚠️ 保护耗尽后真正掉段', () => {
      const rp = new RankProgress(cfg, 1350);
      rp.update(1210);   // 掉到白银 III，3 局保护
      rp.update(1000);   // 保护 → 剩 2
      rp.update(1000);   // 保护 → 剩 1
      rp.update(1000);   // 保护 → 剩 0
      const u = rp.update(1000);   // 保护用尽 → 掉段
      eq(u.event, 'demoted');
      eq(u.info.tier.id, 'bronze');
    });

    test('⚠️ 分数回到段位线以上，保护自动失效', () => {
      /**
       * 【为什么必须这样】
       * 不清除保护的话，玩家可以卡在段位边缘：
       * 掉下去 → 拿保护 → 打回来 → 保护还在 → 再掉下去又不用掉段。
       * 这等于永久免掉段。
       */
      const rp = new RankProgress(cfg, 1350);
      rp.update(1210);            // 掉到白银 III，3 局保护
      rp.update(1250);            // 掉出白银 II 线但在保护内 → 消耗保护
      assert(rp.shieldGames < 3, '保护被消耗');

      // 注意：白银 II 的区间是 1300~1400，1400 已经是白银 I 了
      rp.update(1350);            // 回到白银 II 区间
      eq(rp.shieldGames, 0, '回到线上后保护应清零');
      eq(rp.current!.label, '白银 II');
    });

    test('⚠️ 晋级余量：需要超过阈值才算升段', () => {
      const strict = defaultRankConfig({ promotionMargin: 30 });
      const rp = new RankProgress(strict, 1200);   // 白银 III，floor=1200

      // 白银 II 的 floor 是 1300，要求实际分数 >= 1330 才升
      const notYet = rp.update(1310);
      eq(notYet.event, null, '1310 < 1330，不该升段');
      eq(notYet.info.label, '白银 III');

      const now = rp.update(1340);
      eq(now.event, 'promoted', '1340 >= 1330，升段');
      eq(now.info.label, '白银 II');
    });

    test('⚠️ 升段后保护清零', () => {
      const rp = new RankProgress(cfg, 1350);
      rp.update(1210);   // 掉段，获得保护
      assert(rp.shieldGames > 0);
      const u = rp.update(1450);   // 升回白银 I
      eq(u.event, 'promoted');
      eq(u.shieldGames, 0, '升段后保护清零');
    });

    test('段位内小段变化也算升/降段', () => {
      const rp = new RankProgress(cfg, 1200);
      eq(rp.update(1210).event, null, '同小段内不变');
      eq(rp.update(1310).event, 'promoted', '小段升级');
    });

    test('存档往返', () => {
      const rp = new RankProgress(cfg, 1350);
      rp.update(1210);
      const saved = rp.exportState();
      assert(saved !== null);

      const rp2 = new RankProgress(cfg);
      rp2.importState(saved!);
      eq(rp2.current!.label, rp.current!.label);
      eq(rp2.shieldGames, rp.shieldGames);
    });

    test('未初始化时 exportState 返回 null', () => {
      eq(new RankProgress(cfg).exportState(), null);
    });

    // ---- 赛季重置 ----

    test('⚠️ 软重置：向基准收缩', () => {
      eq(softReset(1500, { baseline: 1200, factor: 0.5 }), 1350);
      eq(softReset(1200, { baseline: 1200, factor: 0.5 }), 1200, '基准分不变');
      eq(softReset(800, { baseline: 1200, factor: 0.5 }), 1000, '低于基准的往上抬');
    });

    test('factor = 1 等于不重置', () => {
      eq(softReset(2000, { baseline: 1200, factor: 1 }), 2000);
    });

    test('factor = 0 等于硬重置', () => {
      eq(softReset(2000, { baseline: 1200, factor: 0 }), 1200);
    });

    test('⚠️ 软重置压缩顶端差距（让追赶成为可能）', () => {
      const before = [2800, 1200];
      const after = softResetAll(before, { baseline: 1200, factor: 0.5 });
      near(after[0]! - after[1]!, 800, 1e-9, '差距从 1600 压到 800');
    });

    test('软重置保持排序（强者仍在前）', () => {
      const ratings = [800, 1500, 2200, 2800];
      const after = softResetAll(ratings, { baseline: 1200, factor: 0.5 });
      for (let i = 1; i < after.length; i++) {
        assert(after[i]! > after[i - 1]!, `顺序应保持：${after.join(',')}`);
      }
    });

    test('软重置不改原数组', () => {
      const ratings = [800, 2800];
      softResetAll(ratings, { baseline: 1200, factor: 0.5 });
      eq(ratings[0], 800);
      eq(ratings[1], 2800);
    });

    test('factor 越界抛错', () => {
      throws(() => softReset(1500, { baseline: 1200, factor: 1.5 }), '0~1');
      throws(() => softReset(1500, { baseline: 1200, factor: -0.1 }), '0~1');
    });

    test('⚠️ 重置后掉段（展示软重置的实际效果）', () => {
      const before = tierOf(2500, cfg);
      const after = tierOf(softReset(2500, { baseline: 1200, factor: 0.5 }), cfg);
      eq(before.tier.id, 'master');
      eq(after.tier.id, 'platinum', '大师应掉到铂金');
    });
  });
}
