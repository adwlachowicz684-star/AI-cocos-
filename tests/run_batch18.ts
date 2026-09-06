/**
 * tests/run_batch18.ts —— 第十七批测试：评分与匹配周边
 *
 * 本批七个模块：
 * 1. TeamMMR        · 队伍分（carry 效应 / 组队惩罚 / 分差限制）
 * 2. Reconnect      · 断线重连（宽限期递减 / 队友连坐 / 真实时间）
 * 3. Surrender      · 投降投票（分母是在线人数 / 弃权算反对）
 * 4. Spectate       · 观战（延迟安全 / 全场可见降级）
 * 5. Report         · 举报（加权 / 去重 / 恶意举报识别）
 * 6. AntiCheat      · 反作弊（速度 / 统计离群 / 行为指纹）
 * 7. SeasonReward   · 赛季发奖（幂等 / 快照分）
 * 8. ABTest         · A/B 实验（稳定分组 / 显著性 / 样本量）
 */

import { test, describe, assert, eq, near, throws } from './_framework';
import {
  teamMmr,
  partyPenalty,
  validateParty,
  fillFromPool,
  winProbability,
  suggestedWindow,
  type MmrPlayer,
} from '../mmr/TeamMMR';
import {
  ReconnectTracker,
  shouldAbortMatch,
  forfeitMultiplier,
  type ReconnectConfig,
} from '../matchops/Reconnect';
import { Surrender, surrenderDiscount } from '../matchops/Surrender';
import {
  SpectateSession,
  isDelaySafe,
  recommendDelay,
  pickDirectorShot,
  popularityTier,
  formatDelay,
} from '../matchops/Spectate';
import {
  ReportCenter,
  severityWeighted,
  updateCredibility,
  REASON_SEVERITY,
  type ReportTicket,
} from '../social/Report';
import {
  SpeedChecker,
  binomialZ,
  isStatisticalOutlier,
  intervalRegularity,
  looksLikeScript,
  suspicionScore,
  actionFor,
} from '../anticheat/AntiCheat';
import {
  SeasonRewardDistributor,
  tierDistribution,
  diagnoseDistribution,
  type SeasonPlayer,
} from '../ranking/SeasonReward';
import {
  bucketHash,
  bucketOf,
  assign,
  checkBalance,
  emptyStats,
  recordBinary,
  recordValue,
  mean,
  variance,
  conversionRate,
  twoProportionZTest,
  isSignificant,
  requiredSampleSize,
  Experiment,
  describeResult,
  normalCdf,
} from '../analytics/ABTest';
import { defaultRankConfig } from '../ranking/RankTier';

export function runBatch18Tests(): void {
  // ================================================================
  describe('TeamMMR · 队伍分', () => {
    // ================================================================

    const P = (id: string, rating: number, inVoice = false): MmrPlayer =>
      ({ id, rating, inVoice });

    test('单人 = 自己的分数', () => {
      eq(teamMmr([P('a', 1500)]).effective, 1500);
    });

    test('avg 策略：算术平均', () => {
      const r = teamMmr([P('a', 1000), P('b', 2000)], { strategy: 'avg' });
      eq(r.base, 1500);
    });

    test('⚠️ weighted 策略：高分权重更大（carry 效应）', () => {
      const r = teamMmr([P('a', 1000), P('b', 2000)], { strategy: 'weighted' });
      assert(r.base > 1500,
        `加权分 ${r.base} 应大于平均 1500（大佬 carry）`);
      assert(r.base < 2000, `但不应达到最高分`);
    });

    test('⚠️ weighted 内部必须降序排序（否则权重随机分配）', () => {
      // 顺序不同，结果必须相同 —— 这是"有没有排序"的判别式
      const a = teamMmr([P('a', 1000), P('b', 2000), P('c', 1500)],
        { strategy: 'weighted' });
      const b = teamMmr([P('a', 2000), P('b', 1500), P('c', 1000)],
        { strategy: 'weighted' });
      near(a.base, b.base, 1e-9, '顺序不该影响结果');
    });

    test('max 策略', () => {
      eq(teamMmr([P('a', 1000), P('b', 2000)], { strategy: 'max' }).base, 2000);
    });

    test('topHalf 策略', () => {
      // [2000, 1500, 1000, 500] → 取较高的一半 [2000, 1500] → 1750
      const r = teamMmr(
        [P('a', 2000), P('b', 1500), P('c', 1000), P('d', 500)],
        { strategy: 'topHalf' });
      eq(r.base, 1750);
    });

    test('空队伍抛错', () => {
      throws(() => teamMmr([]), '队伍为空');
    });

    test('spread 计算', () => {
      eq(teamMmr([P('a', 1200), P('b', 1600)]).spread, 400);
    });

    // ---- 组队惩罚 ----

    test('单人不加惩罚', () => {
      eq(partyPenalty([P('a', 1500)], { partyPenalty: 100 }), 0);
    });

    test('⚠️ 惩罚递减而非线性累加', () => {
      const cfg = { partyPenalty: 100, penaltyDecay: 0.7 };
      const p2 = partyPenalty([P('a', 1500), P('b', 1500)], cfg);
      const p3 = partyPenalty([P('a', 1500), P('b', 1500), P('c', 1500)], cfg);
      const p5 = partyPenalty(
        ['a', 'b', 'c', 'd', 'e'].map((id) => P(id, 1500)), cfg);

      near(p2, 100, 1e-9, '2 人');
      near(p3, 170, 1e-9, '3 人 = 100 + 70');

      // 线性累加的话 5 人队是 400，实际应是 253
      assert(p5 < 400 * 0.7,
        `5 人队惩罚 ${p5.toFixed(1)} 应显著小于线性累加的 400（配合边际收益递减）`);
      near(p5, 253.3, 0.5);
    });

    test('⚠️ 全队语音时惩罚放大', () => {
      const cfg = { partyPenalty: 100, penaltyDecay: 0.7, voiceMultiplier: 1.5 };
      const silent = partyPenalty([P('a', 1500), P('b', 1500)], cfg);
      const voiced = partyPenalty(
        [P('a', 1500, true), P('b', 1500, true)], cfg);
      near(voiced, silent * 1.5, 1e-9, '语音配合优势更大');
    });

    test('部分人在语音不算全队语音', () => {
      const cfg = { partyPenalty: 100, voiceMultiplier: 1.5 };
      const partial = partyPenalty(
        [P('a', 1500, true), P('b', 1500, false)], cfg);
      eq(partial, 100, '不该放大');
    });

    test('惩罚有上限', () => {
      const cfg = { partyPenalty: 500, penaltyCap: 300 };
      eq(partyPenalty([P('a', 1500), P('b', 1500)], cfg), 300);
    });

    test('effective = base + penalty', () => {
      const r = teamMmr([P('a', 1500), P('b', 1500)], { partyPenalty: 100 });
      near(r.effective, r.base + r.penalty, 1e-9);
    });

    // ---- 分差限制 ----

    test('⚠️ 分差超限被标记', () => {
      const r = teamMmr([P('a', 2500), P('b', 500)], { maxSpread: 500 });
      eq(r.overSpread, true);
      eq(r.spread, 2000);
    });

    test('分差未超限', () => {
      eq(teamMmr([P('a', 1500), P('b', 1700)], { maxSpread: 500 }).overSpread, false);
    });

    test('validateParty：分差超限', () => {
      const v = validateParty([P('a', 2500), P('b', 500)], { maxSpread: 500 });
      eq(v.ok, false);
      assert(!v.ok && v.reason === 'spread', '原因应为 spread');
    });

    test('validateParty：空队伍', () => {
      const v = validateParty([], {});
      eq(v.ok, false);
      assert(!v.ok && v.reason === 'empty');
    });

    test('validateParty：重复 id', () => {
      const v = validateParty([P('a', 1500), P('a', 1600)], {});
      eq(v.ok, false);
      assert(!v.ok && v.reason === 'duplicate');
    });

    test('validateParty：超过人数上限', () => {
      const v = validateParty(
        ['a', 'b', 'c'].map((id) => P(id, 1500)), {}, 2);
      eq(v.ok, false);
      assert(!v.ok && v.reason === 'size');
    });

    test('validateParty：合法', () => {
      eq(validateParty([P('a', 1500), P('b', 1600)], { maxSpread: 500 }).ok, true);
    });

    // ---- 补人 ----

    test('⚠️ fillFromPool 挑分差最小的', () => {
      const party = [P('a', 1500), P('b', 1500)];
      const pool = [P('x', 1000), P('y', 1480), P('z', 2000)];
      const r = fillFromPool(party, pool, { strategy: 'avg' });
      eq(r!.pick.id, 'y', '应挑最匹配的 1480');
    });

    test('⚠️ fillFromPool 不会破坏分差限制', () => {
      const party = [P('a', 1500)];
      const pool = [P('x', 100), P('y', 1490)];
      const r = fillFromPool(party, pool, { maxSpread: 200 });
      eq(r!.pick.id, 'y', '100 分会破坏分差限制，应跳过');
    });

    test('fillFromPool 无合适人选返回 null', () => {
      eq(fillFromPool([P('a', 1500)], [P('x', 100)], { maxSpread: 50 }), null);
    });

    test('fillFromPool 空池返回 null', () => {
      eq(fillFromPool([P('a', 1500)], []), null);
    });

    // ---- 胜率与窗口 ----

    test('同分队伍胜率 50%', () => {
      near(winProbability([P('a', 1500)], [P('b', 1500)]), 0.5, 1e-9);
    });

    test('强队胜率更高', () => {
      assert(winProbability([P('a', 1800)], [P('b', 1200)]) > 0.9);
    });

    test('⚠️ 组队惩罚会拉高胜率预期', () => {
      /**
       * 【原测试无法成立，已修正】
       *
       * 原来两队都是 2 人，用的是**同一个 cfg**，
       * 于是两边都加 100 分惩罚，差值不变、胜率恒为 0.5 ——
       * 无论配置成什么都测不出差异。
       *
       * 惩罚的语义是"黑店相对散人有配合优势"，
       * 所以对照组必须是**不组队的对手**：
       * 1 人的队伍 penalty = 0（见 partyPenalty），差异才会显现。
       */
      const party = [P('a', 1500), P('b', 1500)];   // 2 人黑店
      const solo = [P('c', 1500)];                   // 1 人，不吃惩罚

      const noPenalty = winProbability(party, solo, { partyPenalty: 0 });
      const withPenalty = winProbability(party, solo, { partyPenalty: 100 });
      assert(withPenalty > noPenalty,
        `加了惩罚等于认为黑店更强，胜率应上升：${noPenalty} → ${withPenalty}`);
    });

    test('⚠️ suggestedWindow：队内分差越大，窗口越宽', () => {
      const tight = suggestedWindow([P('a', 1500), P('b', 1520)], 100);
      const loose = suggestedWindow([P('a', 1200), P('b', 1800)], 100);
      assert(loose > tight, `分差大时窗口应更宽：${loose} vs ${tight}`);
    });

    test('suggestedWindow 有上限（3 倍）', () => {
      const w = suggestedWindow([P('a', 500), P('b', 3000)], 100);
      assert(w <= 300 + 1e-9, `应被夹在 300，实际 ${w}`);
    });
  });

  // ================================================================
  describe('Reconnect · 断线重连', () => {
    // ================================================================

    function make(cfg?: ReconnectConfig, ids = ['a', 'b', 'c', 'd', 'e']) {
      const t = new ReconnectTracker(cfg);
      t.register(ids);
      return t;
    }

    test('初始全部在线', () => {
      const t = make();
      eq(t.stateOf('a'), 'online');
      eq(t.disconnectedCount, 0);
    });

    test('标记断线', () => {
      const t = make();
      eq(t.markDisconnected('a', 1000), true);
      eq(t.stateOf('a'), 'disconnected');
      eq(t.disconnectedCount, 1);
    });

    test('重复标记断线无效', () => {
      const t = make();
      t.markDisconnected('a', 1000);
      eq(t.markDisconnected('a', 2000), false, '已断线，不该重复');
    });

    test('未注册的人返回 false', () => {
      eq(make().markDisconnected('zzz', 0), false);
    });

    test('宽限期内重连成功', () => {
      const t = make({ graceMs: 60_000 });
      t.markDisconnected('a', 0);
      const r = t.reconnect('a', 30_000);
      eq(r.ok, true);
      eq(t.stateOf('a'), 'online');
    });

    test('超过宽限期重连失败', () => {
      const t = make({ graceMs: 60_000 });
      t.markDisconnected('a', 0);
      const r = t.reconnect('a', 90_000);
      eq(r.ok, false);
      eq(r.reason, 'expired');
    });

    test('对在线的人重连返回 not-disconnected', () => {
      const r = make().reconnect('a', 0);
      eq(r.ok, false);
      eq(r.reason, 'not-disconnected');
    });

    test('⚠️ 宽限期随次数递减', () => {
      const t = make({
        graceMs: 60_000, graceDecay: 0.5, minGraceMs: 10_000,
      });
      const g0 = t.graceFor('a');
      t.markDisconnected('a', 0);
      t.reconnect('a', 1000);

      const g1 = t.graceFor('a');
      t.markDisconnected('a', 2000);
      t.reconnect('a', 3000);

      const g2 = t.graceFor('a');

      eq(g0, 60_000);
      eq(g1, 30_000, '第二次减半');
      eq(g2, 15_000, '第三次再减半');
    });

    test('⚠️ 宽限期有下限，不会无限缩短', () => {
      const t = make({
        graceMs: 60_000, graceDecay: 0.1, minGraceMs: 20_000,
      });
      for (let i = 0; i < 5; i++) {
        t.markDisconnected('a', i * 1000);
        t.reconnect('a', i * 1000 + 100);
      }
      eq(t.graceFor('a'), 20_000, '应被夹在下限');
    });

    test('⚠️ 重连次数用尽 → 直接判负，不再给宽限期', () => {
      const t = make({ graceMs: 60_000, maxAttempts: 2 });
      t.markDisconnected('a', 0);
      t.reconnect('a', 1000);      // 第 1 次
      t.markDisconnected('a', 2000);
      t.reconnect('a', 3000);      // 第 2 次

      t.markDisconnected('a', 4000);
      eq(t.stateOf('a'), 'exhausted', '次数用尽，直接判负');
    });

    test('exhausted 后重连被拒', () => {
      const t = make({ graceMs: 60_000, maxAttempts: 1 });
      t.markDisconnected('a', 0);
      t.reconnect('a', 1000);
      t.markDisconnected('a', 2000);      // → exhausted
      const r = t.reconnect('a', 2100);
      eq(r.ok, false);
      eq(r.reason, 'exhausted');
    });

    test('⚠️ tick 把超时的标为判负', () => {
      const t = make({ graceMs: 60_000 });
      t.markDisconnected('a', 0);
      t.markDisconnected('b', 0);
      t.reconnect('b', 10_000);

      eq(t.tick(30_000).length, 0, '还没到时间');
      const forfeited = t.tick(70_000);
      eq(forfeited.length, 1);
      eq(forfeited[0], 'a');
      eq(t.stateOf('a'), 'forfeited');
    });

    test('⚠️ forfeitAfterMs 独立于 grace（缓冲带）', () => {
      const t = make({ graceMs: 60_000, forfeitAfterMs: 120_000 });
      t.markDisconnected('a', 0);

      // 90 秒：超过 grace（连不上来）但没到 forfeit（还没判负）
      eq(t.tick(90_000).length, 0, '缓冲带内不判负');
      // 130 秒：判负
      eq(t.tick(130_000).length, 1);
    });

    test('⚠️ forfeitAfterMs 不会比 grace 更短（取 max）', () => {
      const t = make({ graceMs: 60_000, forfeitAfterMs: 10_000 });
      t.markDisconnected('a', 0);
      // 配成 10 秒也不能提前判负，否则重连窗口比判负时间还长，逻辑矛盾
      eq(t.tick(30_000).length, 0, '应以 grace（60s）为准');
    });

    test('⚠️ 队友扣分减免', () => {
      const t = make({ teammatePenaltyRate: 0.5 });
      t.markDisconnected('a', 0);
      t.tick(200_000);   // a 判负

      const rates = t.penaltyRates([['a', 'b', 'c'], ['d', 'e']]);
      eq(rates.get('a'), 1, '掉线的人全额');
      eq(rates.get('b'), 0.5, '队友减免一半');
      eq(rates.get('c'), 0.5);
      eq(rates.get('d'), 1, '对方不受影响');
    });

    test('无人掉线时全员全额', () => {
      const rates = make().penaltyRates([['a', 'b'], ['c', 'd']]);
      for (const v of rates.values()) eq(v, 1);
    });

    test('⚠️ 判负阈值合法性校验', () => {
      throws(
        () => new ReconnectTracker({ teammatePenaltyRate: 1.5 }),
        '0~1'
      );
    });

    test('对局结束后不允许重连', () => {
      const t = make({ graceMs: 60_000 });
      t.markDisconnected('a', 0);
      t.endMatch();
      eq(t.reconnect('a', 1000).reason, 'after-end');
    });

    test('allowAfterMatchEnd 可放开', () => {
      const t = make({ graceMs: 60_000, allowAfterMatchEnd: true });
      t.markDisconnected('a', 0);
      t.endMatch();
      eq(t.reconnect('a', 1000).ok, true);
    });

    test('剩余时间查询', () => {
      const t = make({ graceMs: 60_000 });
      t.markDisconnected('a', 0);
      eq(t.remainingMs('a', 20_000), 40_000);
      eq(t.remainingMs('b', 20_000), Infinity, '在线的人返回 Infinity');
    });

    test('累计断线时长', () => {
      const t = make({ graceMs: 60_000 });
      t.markDisconnected('a', 0);
      t.reconnect('a', 10_000);
      t.markDisconnected('a', 20_000);
      t.reconnect('a', 35_000);
      eq(t.snapshot().find((s) => s.id === 'a')!.totalOfflineMs, 25_000);
    });

    test('⚠️ shouldAbortMatch', () => {
      eq(shouldAbortMatch([5, 5]), false);
      eq(shouldAbortMatch([0, 5]), true, '有队伍全灭');
      eq(shouldAbortMatch([2, 5], 3), true, '低于阈值');
      eq(shouldAbortMatch([]), true, '无队伍数据');
    });

    test('forfeitMultiplier 递增且有上限', () => {
      eq(forfeitMultiplier(0), 1);
      eq(forfeitMultiplier(1), 1);
      eq(forfeitMultiplier(3), 2);
      eq(forfeitMultiplier(100), 3, '封顶 3');
    });
  });

  // ================================================================
  describe('Surrender · 投降投票', () => {
    // ================================================================

    function make(teamSize = 5, opts = {}) {
      const s = new Surrender({
        teamSize,
        minMatchMs: 300_000,
        voteDurationMs: 60_000,
        cooldownMs: 120_000,
        ...opts,
      });
      s.setTeam(['a', 'b', 'c', 'd', 'e'].slice(0, teamSize));
      s.setConnected(['a', 'b', 'c', 'd', 'e'].slice(0, teamSize));
      s.markMatchStart(0);
      return s;
    }

    test('⚠️ 人齐时全票才能通过（threshold 0.66）', () => {
      const s = make(5, { threshold: 0.66 });
      s.start('a', 400_000);
      // 5 人 × 0.66 = 3.3 → ceil = 4 票
      let st = s.status(400_000);
      eq(st.needMore, 3, '发起人已投赞成，还差 3 票');

      s.vote('b', 'yes', 401_000);
      s.vote('c', 'yes', 401_000);
      eq(s.tick(402_000), false, '3 票不够');

      s.vote('d', 'yes', 403_000);
      eq(s.tick(404_000), true, '4 票通过');
    });

    test('⚠️ 分母是在线人数，不是队伍人数（核心）', () => {
      /**
       * 5 人队走 2 个，剩 3 人。
       * 若按 5 算：需要 ceil(5*0.66)=4 票，3 个人永远投不出来 → 只能挂机
       * 按 3 算：需要 ceil(3*0.66)=2 票，2 票就能投出去 ✓
       */
      /**
       * 【必须显式关掉 requireAllConnected】
       * 默认开启时，"有人掉线就禁止发起投降"，
       * 于是 start() 直接返回 false，根本进不到投票环节，
       * 后面的断言全部无意义。
       */
      const s = make(5, { threshold: 0.66, requireAllConnected: false });
      s.setConnected(['a', 'b', 'c']);       // d、e 掉线
      eq(s.start('a', 400_000).ok, true, '关闭全员在线要求后应能发起');
      s.markMatchStart(0);

      const st = s.status(400_000);
      eq(st.eligible, 3, '分母应为在线人数');
      eq(st.needMore, 1, 'ceil(3*0.66)=2，还差 1 票');

      s.vote('b', 'yes', 401_000);
      eq(s.tick(402_000), true, '2/3 通过');
    });

    test('⚠️ 掉线的人不能发起投降', () => {
      const s = make(5);
      s.setConnected(['a', 'b', 'c', 'd']);   // e 掉线
      const r = s.start('a', 400_000);
      eq(r.ok, false);
      assert(!r.ok && r.error === 'not-connected');
    });

    test('requireAllConnected: false 时允许', () => {
      const s = make(5, { requireAllConnected: false });
      s.setConnected(['a', 'b', 'c', 'd']);
      eq(s.start('a', 400_000).ok, true);
    });

    test('⚠️ 掉线者的票作废', () => {
      const s = make(5, { threshold: 0.5 });
      s.start('a', 400_000);
      s.vote('b', 'yes', 401_000);
      s.vote('c', 'yes', 401_000);

      // 投票中途 c 掉线
      s.setConnected(['a', 'b', 'd', 'e']);
      eq(s.tick(402_000), false, 'c 的票作废后只剩 2 票');
      eq(s.status(402_000).yes, 2);
    });

    test('⚠️ 弃权默认算反对', () => {
      const s = make(5, { threshold: 0.5 });
      s.start('a', 400_000);
      s.vote('b', 'abstain', 401_000);
      s.vote('c', 'abstain', 401_000);
      s.vote('d', 'abstain', 401_000);
      eq(s.status(402_000).yes, 1, '弃权不计入赞成');
      eq(s.tick(402_000), false);
    });

    test('abstainAsYes: true 时弃权算赞成', () => {
      const s = make(5, { threshold: 0.5, abstainAsYes: true });
      s.start('a', 400_000);
      s.vote('b', 'abstain', 401_000);
      s.vote('c', 'abstain', 401_000);
      eq(s.status(402_000).yes, 3, '弃权计入赞成');
    });

    test('⚠️ 需要 ceil 而不是 floor（4 人队的三分之二）', () => {
      const s = make(4, { threshold: 0.66 });
      s.start('a', 400_000);
      s.vote('b', 'yes', 401_000);
      // floor(4*0.66)=2 → 2 票就能过（错误）
      // ceil(4*0.66)=3 → 需要 3 票（正确）
      eq(s.tick(402_000), false, '2 票不该通过');
      s.vote('c', 'yes', 403_000);
      eq(s.tick(404_000), true, '3 票通过');
    });

    test('⚠️ 重复投票不会重复计数', () => {
      const s = make(5, { threshold: 0.5 });
      s.start('a', 400_000);
      s.vote('b', 'yes', 401_000);
      s.vote('b', 'yes', 402_000);   // 重复
      s.vote('b', 'yes', 403_000);   // 重复
      eq(s.status(404_000).yes, 2, 'a + b，不是 4 票');
    });

    test('改票：从赞成改成反对', () => {
      const s = make(5, { threshold: 0.5 });
      s.start('a', 400_000);
      s.vote('b', 'yes', 401_000);
      eq(s.status(401_000).yes, 2);
      s.vote('b', 'no', 402_000);
      eq(s.status(402_000).yes, 1);
      eq(s.status(402_000).no, 1);
    });

    test('⚠️ 太早不能发起', () => {
      const s = make();
      const r = s.start('a', 100_000);   // 对局才 100 秒
      eq(r.ok, false);
      assert(!r.ok && r.error === 'too-early');
    });

    test('不在队伍里的人不能发起', () => {
      eq(make().start('zzz', 400_000).ok, false);
    });

    test('已在投票中不能重复发起', () => {
      const s = make();
      s.start('a', 400_000);
      const r = s.start('b', 401_000);
      assert(!r.ok && r.error === 'already-voting');
    });

    test('⚠️ 被拒后进入冷却', () => {
      const s = make(5, { threshold: 0.66 });
      s.start('a', 400_000);
      s.tick(500_000);   // 超时未通过

      eq(s.state, 'cooldown');
      const r = s.start('a', 500_001);
      assert(!r.ok && r.error === 'in-cooldown');
    });

    test('⚠️ 冷却结束后可以重新发起（status 会回到 idle）', () => {
      const s = make(5, { threshold: 0.66 });
      s.start('a', 400_000);
      s.tick(500_000);   // 冷却到 620_000

      eq(s.status(610_000).state, 'cooldown', '冷却中');
      eq(s.status(630_000).state, 'idle', '冷却已过，状态应回到 idle');

      eq(s.start('a', 630_000).ok, true);
    });

    test('⚠️ 冷却未过时 status 仍显示 cooldown（不是 idle）', () => {
      const s = make(5, { threshold: 0.66 });
      s.start('a', 400_000);
      s.tick(500_000);
      const st = s.status(550_000);
      eq(st.state, 'cooldown');
      eq(st.cooldownUntil, 620_000);
    });

    test('⚠️ 投票中不能投票给未开始的情况', () => {
      const s = make();
      eq(s.vote('a', 'yes', 1000).ok, false);
    });

    test('cancel 取消投票', () => {
      const s = make();
      s.start('a', 400_000);
      s.cancel();
      eq(s.state, 'idle');
      eq(s.status(400_000).yes, 0);
    });

    test('⚠️ setTeam 超上限抛错', () => {
      const s = make(3);
      throws(() => s.setTeam(['a', 'b', 'c', 'd']), '超过上限');
    });

    test('setTeam 重复 id 抛错', () => {
      throws(() => make(3).setTeam(['a', 'a', 'b']), '重复');
    });

    test('setTeam 后离开队伍的人的票被清除', () => {
      const s = make(5, { threshold: 0.66 });
      s.start('a', 400_000);
      s.vote('b', 'yes', 401_000);
      s.setTeam(['a', 'c', 'd', 'e', 'f']);   // b 离开
      eq(s.status(402_000).yes, 1, 'b 的票应被清除');
    });

    test('remainingMs', () => {
      const s = make();
      s.start('a', 400_000);
      eq(s.remainingMs(410_000), 50_000);
      eq(s.remainingMs(500_000), 0, '超时后为 0');
    });

    test('initiator 默认投赞成', () => {
      const s = make();
      s.start('a', 400_000);
      eq(s.status(400_000).yes, 1);
      eq(s.status(400_000).initiator, 'a');
    });

    test('构造校验：teamSize', () => {
      throws(() => new Surrender({ teamSize: 0 }), '正整数');
    });

    test('构造校验：threshold', () => {
      throws(() => new Surrender({ teamSize: 5, threshold: 0 }), '(0,1]');
      throws(() => new Surrender({ teamSize: 5, threshold: 1.5 }), '(0,1]');
    });

    // ---- 扣分减免 ----

    test('⚠️ 越早投降减免越多', () => {
      const early = surrenderDiscount(60_000, 1_800_000, 0.3);
      const late = surrenderDiscount(1_700_000, 1_800_000, 0.3);
      assert(early > late, `早期 ${early} 应大于 后期 ${late}`);
      near(early, 0.29, 0.01);
      near(late, 0.017, 0.01);
    });

    test('打满时长无减免', () => {
      near(surrenderDiscount(1_800_000, 1_800_000, 0.3), 0, 1e-9);
    });

    test('超过时长不产生负数', () => {
      near(surrenderDiscount(3_000_000, 1_800_000, 0.3), 0, 1e-9);
    });
  });

  // ================================================================
  describe('Spectate · 观战', () => {
    // ================================================================

    test('⚠️ 未开始不能加入', () => {
      const s = new SpectateSession();
      eq(s.join('x', 0).ok, false);
      assert(!s.join('x', 0).ok || true);
    });

    test('开始后可以加入', () => {
      const s = new SpectateSession();
      s.start(0);
      const r = s.join('x', 1000);
      eq(r.ok, true);
      assert(r.ok && r.delayMs === 120_000, '默认延迟 2 分钟');
    });

    test('结束后不能加入', () => {
      const s = new SpectateSession();
      s.start(0);
      s.end();
      const r = s.join('x', 1000);
      eq(r.ok, false);
      assert(!r.ok && r.error === 'ended');
    });

    test('⚠️ 重复加入被拒', () => {
      const s = new SpectateSession();
      s.start(0);
      s.join('x', 1000);
      const r = s.join('x', 2000);
      assert(!r.ok && r.error === 'duplicate');
    });

    test('⚠️ 人数上限', () => {
      const s = new SpectateSession({ maxSpectators: 2 });
      s.start(0);
      s.join('a', 0);
      s.join('b', 0);
      const r = s.join('c', 0);
      assert(!r.ok && r.error === 'full');
      eq(s.count, 2);
    });

    test('⚠️ 全场可见 + 延迟不足 → 静默降级为 team-only', () => {
      const s = new SpectateSession({
        delayMs: 60_000,               // 1 分钟
        allVisionMinDelayMs: 300_000,  // 但全场可见要求 5 分钟
      });
      s.start(0);
      const r = s.join('x', 0, { visibility: 'all' });
      assert(r.ok, '应加入成功');
      eq(r.effectiveVisibility, 'team-only', '应降级');
      eq(s.visibilityOf('x'), 'team-only');
    });

    test('⚠️ 全场可见 + 延迟足够 → 放行', () => {
      const s = new SpectateSession({
        delayMs: 600_000,
        allVisionMinDelayMs: 300_000,
      });
      s.start(0);
      const r = s.join('x', 0, { visibility: 'all' });
      assert(r.ok);
      eq(r.effectiveVisibility, 'all');
    });

    test('默认可见性是 team-only', () => {
      const s = new SpectateSession();
      s.start(0);
      s.join('x', 0);
      eq(s.visibilityOf('x'), 'team-only');
    });

    test('⚠️ 对手观战默认禁止', () => {
      const s = new SpectateSession();
      s.start(0);
      const r = s.join('x', 0, { isOpponent: true });
      assert(!r.ok && r.error === 'opponent-forbidden');
    });

    test('allowOpponentSpectate 可放开', () => {
      const s = new SpectateSession({ allowOpponentSpectate: true });
      s.start(0);
      eq(s.join('x', 0, { isOpponent: true }).ok, true);
    });

    test('⚠️ viewingTime = now - delay（不是从头播放）', () => {
      const s = new SpectateSession({ delayMs: 120_000 });
      s.start(0);
      /**
       * 【为什么这个语义才对】
       * 中途加入的观战者应该立刻看到"当前往前推 delay"的画面。
       * 如果理解成"延迟 delay 秒才开始播"，
       * 他加入后要盯着黑屏等 2 分钟 —— 或者从对局开头播，
       * 那要追很久才追得上。
       */
      eq(s.viewingTime(500_000), 380_000);
    });

    test('viewingTime 不会早于对局开始', () => {
      const s = new SpectateSession({ delayMs: 120_000 });
      s.start(0);
      eq(s.viewingTime(30_000), 0, '开局 30 秒时，应显示第 0 秒');
    });

    test('lagBehind', () => {
      const s = new SpectateSession({ delayMs: 120_000 });
      s.start(0);
      eq(s.lagBehind(500_000), 120_000);
    });

    test('离开与清空', () => {
      const s = new SpectateSession();
      s.start(0);
      s.join('a', 0);
      s.join('b', 0);
      eq(s.leave('a'), true);
      eq(s.count, 1);
      eq(s.leave('zzz'), false);
      s.clear();
      eq(s.count, 0);
    });

    test('切换视角', () => {
      const s = new SpectateSession();
      s.start(0);
      s.join('x', 0, { target: 0 });
      eq(s.switchTarget('x', 1), true);
      eq(s.list()[0]!.target, 1);
      eq(s.switchTarget('zzz', 1), false);
    });

    test('spectatorsVisible 默认 false', () => {
      eq(new SpectateSession().spectatorsVisible, false);
      eq(new SpectateSession({ revealSpectators: true }).spectatorsVisible, true);
    });

    test('负延迟抛错', () => {
      throws(() => new SpectateSession({ delayMs: -1 }), '不能为负');
    });

    test('isActive', () => {
      const s = new SpectateSession();
      eq(s.isActive, false, '未开始');
      s.start(0);
      eq(s.isActive, true);
      s.end();
      eq(s.isActive, false);
    });

    // ---- 辅助函数 ----

    test('⚠️ isDelaySafe：有迷雾要求更高', () => {
      eq(isDelaySafe(0, false), false, '零延迟不安全');
      eq(isDelaySafe(20_000, false), true, '20 秒对无迷雾够用');
      eq(isDelaySafe(20_000, true), false, '有迷雾时 20 秒不够');
      eq(isDelaySafe(30_000, true), true);
    });

    test('⚠️ recommendDelay：卡牌类可以 0（信息本就公开）', () => {
      eq(recommendDelay('card'), 0);
      assert(recommendDelay('moba') >= 120_000);
      assert(recommendDelay('rts') >= 300_000);
    });

    test('⚠️ pickDirectorShot：优先高交战强度', () => {
      const i = pickDirectorShot([
        { combat: 0.1, sinceSwitch: 10, isCurrent: true },
        { combat: 0.9, sinceSwitch: 10, isCurrent: false },
      ]);
      eq(i, 1, '应切到交战激烈的画面');
    });

    test('⚠️ pickDirectorShot：粘性避免抖动', () => {
      /**
       * 当前画面 combat=0.50，候选 combat=0.55。
       * 差距只有 5 分，但当前画面有 +15 粘性加成 → 不切。
       * 否则两个画面分数接近时会疯狂抖动，观众看到幻灯片。
       */
      const i = pickDirectorShot([
        { combat: 0.50, sinceSwitch: 10, isCurrent: true },
        { combat: 0.55, sinceSwitch: 10, isCurrent: false },
      ]);
      eq(i, 0, '差距小时保持当前画面');
    });

    test('⚠️ pickDirectorShot：刚切过来的画面有冷却惩罚', () => {
      // 候选 1 交战更激烈，但 2 秒前刚切过
      const i = pickDirectorShot([
        { combat: 0.3, sinceSwitch: 30, isCurrent: true },
        { combat: 0.9, sinceSwitch: 1, isCurrent: false },
      ]);
      eq(i, 0, '1 秒前刚切过，惩罚 (5-1)*20=80 > 优势 60');
    });

    test('pickDirectorShot 空数组返回 -1', () => {
      eq(pickDirectorShot([]), -1);
    });

    test('popularityTier', () => {
      eq(popularityTier(0), 'none');
      eq(popularityTier(3), 'few');
      eq(popularityTier(20), 'some');
      eq(popularityTier(500), 'hot');
      eq(popularityTier(5000), 'viral');
    });

    test('formatDelay', () => {
      eq(formatDelay(30_000), '30 秒');
      eq(formatDelay(120_000), '2 分钟');
      eq(formatDelay(150_000), '2 分 30 秒');
    });
  });

  // ================================================================
  describe('Report · 举报', () => {
    // ================================================================

    function ticket(
      reporterId: string,
      credibility: number,
      reason: ReportTicket['reason'] = 'cheating'
    ): ReportTicket {
      return {
        id: `t-${reporterId}`,
        reporterId,
        targetId: 'bad',
        reason,
        at: 0,
        reporterCredibility: credibility,
      };
    }

    test('正常提交', () => {
      const rc = new ReportCenter();
      eq(rc.submit('a', 'bad', 'cheating', 0).result, 'accepted');
      eq(rc.size, 1);
    });

    test('⚠️ 不能举报自己', () => {
      const rc = new ReportCenter();
      eq(rc.submit('a', 'a', 'cheating', 0).result, 'self-report');
      eq(rc.size, 0);
    });

    test('⚠️ 同一对 (举报人, 目标) 有冷却', () => {
      const rc = new ReportCenter({ cooldownMs: 60_000 });
      eq(rc.submit('a', 'bad', 'cheating', 0).result, 'accepted');
      eq(rc.submit('a', 'bad', 'cheating', 30_000).result, 'cooldown');
      eq(rc.submit('a', 'bad', 'cheating', 61_000).result, 'accepted', '冷却后可再报');
    });

    test('冷却只针对同一目标', () => {
      const rc = new ReportCenter({ cooldownMs: 60_000 });
      rc.submit('a', 'bad1', 'cheating', 0);
      eq(rc.submit('a', 'bad2', 'cheating', 1000).result, 'accepted', '换个人可以再报');
    });

    test('⚠️ 每日上限', () => {
      const rc = new ReportCenter({ dailyLimit: 2 });
      const H = 3_600_000;
      eq(rc.submit('a', 'x1', 'cheating', 0).result, 'accepted');
      eq(rc.submit('a', 'x2', 'cheating', H).result, 'accepted');
      eq(rc.submit('a', 'x3', 'cheating', 2 * H).result, 'daily-limit');
    });

    test('⚠️ 跨天后计数重置', () => {
      const rc = new ReportCenter({ dailyLimit: 1 });
      const DAY = 86_400_000;
      eq(rc.submit('a', 'x1', 'cheating', 0).result, 'accepted');
      eq(rc.submit('a', 'x2', 'cheating', DAY).result, 'accepted', '第二天重置');
    });

    test('remainingToday', () => {
      const rc = new ReportCenter({ dailyLimit: 3 });
      eq(rc.remainingToday('a', 0), 3);
      rc.submit('a', 'x', 'cheating', 0);
      eq(rc.remainingToday('a', 1000), 2);
      eq(rc.remainingToday('b', 1000), 3, '别人不受影响');
    });

    test('cooldownRemaining', () => {
      const rc = new ReportCenter({ cooldownMs: 60_000 });
      rc.submit('a', 'bad', 'cheating', 0);
      eq(rc.cooldownRemaining('a', 'bad', 20_000), 40_000);
      eq(rc.cooldownRemaining('a', 'other', 20_000), 0);
    });

    // ---- 权重 ----

    test('⚠️ 高信誉权重高', () => {
      const rc = new ReportCenter();
      eq(rc.weightOf(ticket('a', 100)), 1);
      eq(rc.weightOf(ticket('a', 50)), 0.5);
    });

    test('⚠️ 低信誉一律最低权重（不再区分）', () => {
      const rc = new ReportCenter({ lowCredibilityThreshold: 40, minWeight: 0.2 });
      eq(rc.weightOf(ticket('a', 39)), 0.2);
      eq(rc.weightOf(ticket('a', 5)), 0.2, '信誉 5 和 39 不该有区别');
      eq(rc.weightOf(ticket('a', 40)), 0.4, '刚好在阈值上按比例');
    });

    test('⚠️ 权重有下限（不是 0）', () => {
      const rc = new ReportCenter({ minWeight: 0.2 });
      eq(rc.weightOf(ticket('a', 0)), 0.2, '信誉 0 也保留 20%');
    });

    // ---- 统计与处理 ----

    test('statsOf 汇总', () => {
      const rc = new ReportCenter();
      rc.submit('a', 'bad', 'cheating', 0, { credibility: 100 });
      rc.submit('b', 'bad', 'afk', 0, { credibility: 100 });
      rc.submit('c', 'bad', 'cheating', 0, { credibility: 100 });

      const st = rc.statsOf('bad');
      eq(st.total, 3);
      eq(st.uniqueReporters, 3);
      eq(st.byReason.cheating, 2);
      eq(st.byReason.afk, 1);
      near(st.weighted, 3, 1e-9);
    });

    test('⚠️ needsAction 用加权分而不是条数', () => {
      const rc = new ReportCenter({ actionThreshold: 3 });
      // 10 个信誉 10 的人举报 → 权重 10 × 0.2 = 2.0 < 3
      for (let i = 0; i < 10; i++) {
        rc.submit(`low${i}`, 'bad', 'cheating', 0, { credibility: 10 });
      }
      eq(rc.statsOf('bad').total, 10, '条数很多');
      eq(rc.needsAction('bad'), false, '但权重不够，不处理');
      near(rc.remainingToAction('bad'), 1, 1e-9);
    });

    test('⚠️ 高信誉举报更容易触发', () => {
      const rc = new ReportCenter({ actionThreshold: 3 });
      for (let i = 0; i < 3; i++) {
        rc.submit(`hi${i}`, 'bad', 'cheating', 0, { credibility: 100 });
      }
      eq(rc.needsAction('bad'), true, '3 个可信举报就够');
    });

    test('remainingToAction 不为负', () => {
      const rc = new ReportCenter({ actionThreshold: 1 });
      rc.submit('a', 'bad', 'cheating', 0, { credibility: 100 });
      eq(rc.remainingToAction('bad'), 0);
    });

    // ---- 恶意举报 ----

    test('⚠️ reject 累计驳回次数', () => {
      const rc = new ReportCenter({ abuseThreshold: 3 });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = rc.submit('spam', `x${i}`, 'cheating', 0);
        ids.push(r.ticket!.id);
      }
      for (const id of ids) rc.reject(id);

      eq(rc.rejectedCount('spam'), 3);
      eq(rc.isAbusiveReporter('spam'), true);
    });

    test('未达阈值不算恶意', () => {
      const rc = new ReportCenter({ abuseThreshold: 5 });
      const r = rc.submit('a', 'x', 'cheating', 0);
      rc.reject(r.ticket!.id);
      eq(rc.isAbusiveReporter('a'), false);
    });

    test('reject 不存在的票返回 false', () => {
      eq(new ReportCenter().reject('nope'), false);
    });

    test('clearFor 清空某人的举报', () => {
      const rc = new ReportCenter();
      rc.submit('a', 'bad', 'cheating', 0);
      rc.submit('b', 'bad', 'cheating', 0);
      rc.submit('c', 'good', 'cheating', 0);
      eq(rc.clearFor('bad'), 2);
      eq(rc.size, 1);
    });

    // ---- 便捷函数 ----

    test('REASON_SEVERITY：开挂最严重', () => {
      assert(REASON_SEVERITY.cheating > REASON_SEVERITY.afk);
    });

    test('⚠️ severityWeighted 结合信誉与严重度', () => {
      const cheat = [ticket('a', 100, 'cheating')];
      const afk = [ticket('a', 100, 'afk')];
      assert(severityWeighted(cheat) > severityWeighted(afk) * 3);
    });

    test('⚠️ updateCredibility 不对称（扣分快、恢复慢）', () => {
      const before = 100;
      const afterDrop = updateCredibility(before, -20);
      const afterRecover = updateCredibility(afterDrop, +20);

      near(afterDrop, 80, 1e-9, '扣分按 1.0 倍');
      near(afterRecover, 90, 1e-9, '加分只按 0.5 倍');
      assert(afterRecover < before, '恢复不到原值');
    });

    test('⚠️ updateCredibility 下限是 10 不是 0', () => {
      eq(updateCredibility(15, -100), 10, '保留回升的余地');
    });

    test('updateCredibility 上限 100', () => {
      eq(updateCredibility(95, +100), 100);
    });
  });

  // ================================================================
  describe('AntiCheat · 反作弊基础', () => {
    // ================================================================

    test('正常速度不触发', () => {
      const c = new SpeedChecker({ maxSpeed: 10 });
      c.push({ x: 0, y: 0, t: 0 });
      const v = c.push({ x: 5, y: 0, t: 1000 });   // 5 单位/秒
      eq(v!.exceeded, false);
    });

    test('⚠️ 超速触发', () => {
      const c = new SpeedChecker({ maxSpeed: 10 });
      c.push({ x: 0, y: 0, t: 0 });
      const v = c.push({ x: 100, y: 0, t: 1000 });   // 100 单位/秒
      eq(v!.exceeded, true);
      near(v!.speed, 100, 1e-9);
    });

    test('⚠️ 容忍系数：略超不报', () => {
      const c = new SpeedChecker({ maxSpeed: 10, tolerance: 1.15 });
      c.push({ x: 0, y: 0, t: 0 });
      const v = c.push({ x: 11, y: 0, t: 1000 });   // 11 < 11.5
      eq(v!.exceeded, false, '11.5 以内都算正常');
      near(v!.allowed, 11.5, 1e-9);
    });

    test('⚠️ 时间倒流必须忽略（不能除出负数速度）', () => {
      const c = new SpeedChecker({ maxSpeed: 10 });
      c.push({ x: 0, y: 0, t: 1000 });
      const v = c.push({ x: 100, y: 0, t: 500 });   // 时间倒流
      eq(v, null, '无效样本');
      eq(c.strikes, 0, '不能因此记异常');
    });

    test('⚠️ 零时间间隔必须忽略（不能除出 Infinity）', () => {
      const c = new SpeedChecker({ maxSpeed: 10 });
      c.push({ x: 0, y: 0, t: 1000 });
      const v = c.push({ x: 100, y: 0, t: 1000 });
      eq(v, null);
      eq(c.strikes, 0);
    });

    test('⚠️ 位移过小忽略（避免比值误差）', () => {
      const c = new SpeedChecker({ maxSpeed: 10, minDistance: 0.5 });
      c.push({ x: 0, y: 0, t: 0 });
      const v = c.push({ x: 0.01, y: 0, t: 1 });   // 理论速度 10/s
      eq(v, null, '位移 0.01 < 0.5，忽略');
    });

    test('⚠️ 连续异常才标记（单次是网络问题）', () => {
      const c = new SpeedChecker({ maxSpeed: 10, strikeThreshold: 3 });
      c.push({ x: 0, y: 0, t: 0 });
      eq(c.push({ x: 100, y: 0, t: 1000 })!.flagged, false, '第 1 次');
      c.push({ x: 200, y: 0, t: 2000 });
      eq(c.push({ x: 300, y: 0, t: 3000 })!.flagged, true, '第 3 次');
    });

    test('⚠️ 中间恢复正常则计数清零', () => {
      /**
       * 【原测试的数据与断言自相矛盾，已修正】
       *
       * 原来第二帧写的是「从 100 到 102 只走 2」，注释标为"异常 2"，
       * 但速度 2 远低于上限 10 —— 它是**正常**样本，会触发清零而不是累加。
       * 所以 `strikes` 只可能是 0，断言写成 2 必然失败。
       *
       * 要让"连续两次异常"成立，第二帧必须也是超速位移。
       */
      const c = new SpeedChecker({ maxSpeed: 10, strikeThreshold: 3 });
      c.push({ x: 0, y: 0, t: 0 });
      c.push({ x: 100, y: 0, t: 1000 });    // 速度 100 → 异常 1
      c.push({ x: 200, y: 0, t: 2000 });    // 速度 100 → 异常 2
      eq(c.strikes, 2);
      c.push({ x: 203, y: 0, t: 3000 });    // 速度 3 → 正常
      eq(c.strikes, 0, '应清零');
    });

    test('reset 清空状态', () => {
      const c = new SpeedChecker({ maxSpeed: 10 });
      c.push({ x: 0, y: 0, t: 0 });
      c.push({ x: 100, y: 0, t: 1000 });
      c.reset();
      eq(c.strikes, 0);
      eq(c.push({ x: 0, y: 0, t: 0 }), null, '重新开始');
    });

    test('maxObserved 记录最高速度', () => {
      const c = new SpeedChecker({ maxSpeed: 1000 });
      c.push({ x: 0, y: 0, t: 0 });
      c.push({ x: 50, y: 0, t: 1000 });
      c.push({ x: 80, y: 0, t: 2000 });
      near(c.maxObserved, 50, 1e-9);
    });

    test('构造校验', () => {
      throws(() => new SpeedChecker({ maxSpeed: 0 }), '必须为正');
    });

    // ---- 统计 ----

    test('⚠️ binomialZ：符合期望时为 0', () => {
      // 抛 100 次硬币，50 次正面，期望 0.5 → Z = 0
      near(binomialZ(50, 100, 0.5), 0, 1e-9);
    });

    test('binomialZ：远超期望时为正', () => {
      assert(binomialZ(90, 100, 0.5) > 5);
    });

    test('binomialZ 无样本返回 0', () => {
      eq(binomialZ(0, 0, 0.5), 0);
    });

    test('binomialZ 参数校验', () => {
      throws(() => binomialZ(5, 10, 0), '(0,1)');
      throws(() => binomialZ(5, 10, 1), '(0,1)');
    });

    test('⚠️ isStatisticalOutlier：样本不足一律 False', () => {
      // 10 发子弹全中，Z 分数很高，但样本只有 10
      assert(binomialZ(10, 10, 0.3) > 3, 'Z 分数确实高');
      eq(isStatisticalOutlier(10, 10, 0.3, 100), false, '但样本不足，不定罪');
    });

    test('⚠️ isStatisticalOutlier：样本足够且异常', () => {
      // 1000 次射击，命中率 80%，正常是 30%
      eq(isStatisticalOutlier(800, 1000, 0.3, 100), true);
    });

    test('isStatisticalOutlier：正常玩家不误伤', () => {
      // 1000 次射击，命中率 32%，正常 30% —— 略高但正常
      eq(isStatisticalOutlier(320, 1000, 0.3, 100), false);
    });

    // ---- 行为指纹 ----

    test('⚠️ intervalRegularity：脚本的 CV 接近 0', () => {
      const script = new Array(100).fill(200);       // 精确 200ms
      near(intervalRegularity(script), 0, 1e-9);
    });

    test('intervalRegularity：人类有抖动', () => {
      // 均值 200，抖动 ±50
      const human = Array.from({ length: 100 },
        (_, i) => 200 + ((i * 37) % 101) - 50);
      assert(intervalRegularity(human) > 0.1,
        `人类 CV 应大于 0.1，实际 ${intervalRegularity(human)}`);
    });

    test('intervalRegularity 样本不足返回 1', () => {
      eq(intervalRegularity([200]), 1);
      eq(intervalRegularity([]), 1);
    });

    test('⚠️ looksLikeScript：样本不足不定罪', () => {
      const short = new Array(10).fill(200);
      eq(looksLikeScript(short, 50), false, '只有 10 个样本');
    });

    test('looksLikeScript：足够样本的精确点击', () => {
      const long = new Array(100).fill(200);
      eq(looksLikeScript(long, 50), true);
    });

    test('looksLikeScript：人类节奏', () => {
      const human = Array.from({ length: 100 },
        (_, i) => 200 + ((i * 37) % 101) - 50);
      eq(looksLikeScript(human, 50), false);
    });

    // ---- 综合 ----

    test('⚠️ 无异常时分数为 0', () => {
      eq(suspicionScore({}).score, 0);
    });

    test('⚠️ 单一证据不足以定罪（各项都有封顶）', () => {
      const r = suspicionScore({ speedViolations: 100 });
      assert(r.score <= 40 + 5, `仅速度异常最多 40 分，实际 ${r.score}`);
      eq(r.action, 'watch', '只到"观察"级别');
    });

    test('⚠️ 多项证据叠加才能到 ban', () => {
      const r = suspicionScore({
        speedViolations: 10,      // 40（封顶）
        accuracyZ: 6,             // (6-2)*8 = 32
        intervalCv: 0.01,         // (0.05-0.01)*500 = 20
        reportScore: 5,           // 15（封顶）
        isNewAccount: true,       // 5
      });
      assert(r.score >= 85, `总分 ${r.score} 应达到 ban 阈值`);
      eq(r.action, 'ban');
    });

    test('breakdown 可用于排查误判', () => {
      const r = suspicionScore({ speedViolations: 2 });
      eq(r.breakdown.speed, 16);
      eq(r.breakdown.accuracy, 0, '未提供的项记 0');
    });

    test('⚠️ accuracyZ 为负不产生贡献（不能减分）', () => {
      const r = suspicionScore({ accuracyZ: -5 });
      eq(r.breakdown.accuracy, 0, '低于平均水平是正常的');
    });

    test('⚠️ actionFor 阈值保守', () => {
      eq(actionFor(0), 'none');
      eq(actionFor(29), 'none');
      eq(actionFor(30), 'watch', '30 才观察');
      eq(actionFor(59), 'watch');
      eq(actionFor(60), 'review', '60 才复核');
      eq(actionFor(84), 'review');
      eq(actionFor(85), 'ban', '85 才建议封禁');
    });

    test('分数被夹在 0~100', () => {
      const r = suspicionScore({
        speedViolations: 1e6,
        accuracyZ: 1e6,
        intervalCv: 0,
        reportScore: 1e6,
        isNewAccount: true,
      });
      assert(r.score <= 100, `应 <= 100，实际 ${r.score}`);
    });
  });

  // ================================================================
  describe('SeasonReward · 赛季发奖', () => {
    // ================================================================

    const rankConfig = defaultRankConfig();
    const rewards = [
      { tierId: 'gold', rewards: ['gold-frame', 'gold-icon'] },
      { tierId: 'diamond', rewards: ['diamond-frame', 'diamond-icon', 'skin'] },
      { tierId: '*', rewards: ['participation-badge'] },
    ];

    function make(opts = {}) {
      return new SeasonRewardDistributor({
        rankConfig,
        rewards,
        ...opts,
      });
    }

    const players: SeasonPlayer[] = [
      { id: 'p1', finalRating: 1600, peakRating: 1650, games: 50 },  // 黄金
      { id: 'p2', finalRating: 2100, peakRating: 2150, games: 80 },  // 钻石
      { id: 'p3', finalRating: 900, peakRating: 950, games: 10 },    // 青铜
    ];

    test('⚠️ 没有兜底档直接抛错', () => {
      throws(
        () => new SeasonRewardDistributor({
          rankConfig,
          rewards: [{ tierId: 'gold', rewards: [] }],
        }),
        '兜底档'
      );
    });

    test('resolve 按段位匹配档位', () => {
      const d = make();
      eq(d.resolve(players[1]!).tierId, 'diamond');
      eq(d.resolve(players[1]!).rewards.length, 3);
    });

    test('⚠️ 未配置的段位向下找最近的档', () => {
      // 白银没有配置奖励，应向下找到兜底（青铜也没有配置）
      const d = make();
      const silver = d.resolve({ id: 's', finalRating: 1350, peakRating: 1350, games: 20 });
      eq(silver.tierId, 'silver');
      eq(silver.rewards[0], 'participation-badge', '降级到兜底');
    });

    test('⚠️ 降级查找不会跳到兜底（有更低配置档时）', () => {
      // 铂金 1800 没有配置，但黄金有 → 应该拿黄金的，不是兜底
      const d = make();
      const plat = d.resolve({ id: 'x', finalRating: 1850, peakRating: 1850, games: 20 });
      eq(plat.tierId, 'platinum');
      eq(plat.rewards[0], 'gold-frame', '应向下找到黄金档');
    });

    test('⚠️ basis=highest 用峰值分（宽容）', () => {
      const d = make({ basis: 'highest' });
      // 赛季末掉到白银，但曾经上过黄金
      const p: SeasonPlayer = { id: 'x', finalRating: 1300, peakRating: 1650, games: 30 };
      eq(d.resolve(p).tierId, 'gold', '按峰值发黄金奖励');
    });

    test('⚠️ basis=final 用结算分（严格）', () => {
      const d = make({ basis: 'final' });
      const p: SeasonPlayer = { id: 'x', finalRating: 1300, peakRating: 1650, games: 30 };
      eq(d.resolve(p).tierId, 'silver', '按结算分发白银');
    });

    test('⚠️ 参与局数不足被跳过', () => {
      const d = make({ minGames: 20 });
      const p: SeasonPlayer = { id: 'x', finalRating: 2100, peakRating: 2150, games: 5 };
      const g = d.resolve(p);
      eq(g.skipped, true);
      eq(g.skipReason, 'too-few-games');
      eq(g.rewards.length, 0);
    });

    // ---- 幂等（核心）----

    test('⚠️ 同一赛季重复发奖只发一次', () => {
      const d = make();
      const first = d.grant('S1', players);
      eq(first.length, 3);

      const second = d.grant('S1', players);
      eq(second.length, 0, '第二次应全部跳过');
      eq(d.grantedCount('S1'), 3);
    });

    test('⚠️ 不同赛季互不影响', () => {
      const d = make();
      eq(d.grant('S1', players).length, 3);
      eq(d.grant('S2', players).length, 3, '新赛季可以再发');
    });

    test('⚠️ 部分玩家已发过，只补发剩下的', () => {
      const d = make();
      d.grant('S1', [players[0]!]);
      const rest = d.grant('S1', players);
      eq(rest.length, 2, '只发 p2、p3');
      eq(rest[0]!.playerId, 'p2');
    });

    test('⚠️ 跳过的人也记为已发（不会反复尝试）', () => {
      const d = make({ minGames: 20 });
      const low: SeasonPlayer[] = [
        { id: 'x', finalRating: 2100, peakRating: 2150, games: 3 },
      ];
      eq(d.grant('S1', low).length, 1, '第一次会记录（含跳过）');
      eq(d.grant('S1', low).length, 0, '第二次不再处理');
    });

    test('⚠️ 同一批次内的重复 id 只发一次', () => {
      const d = make();
      const dup = [players[0]!, players[0]!, players[1]!];
      eq(d.grant('S1', dup).length, 2, '重复的只算一次');
    });

    test('isGranted 查询', () => {
      const d = make();
      eq(d.isGranted('S1', 'p1'), false);
      d.grant('S1', players);
      eq(d.isGranted('S1', 'p1'), true);
      eq(d.isGranted('S2', 'p1'), false);
    });

    test('⚠️ forceGrant 绕过幂等（命名要显式）', () => {
      const d = make();
      d.grant('S1', players);
      // 管理员补发：即使已发过也能再拿一份
      const g = d.forceGrant(players[0]!);
      eq(g.rewards.length, 2);
      eq(d.isGranted('S1', 'p1'), true, '不影响已发放记录');
    });

    test('resetSeason 清空发放记录', () => {
      const d = make();
      d.grant('S1', players);
      d.resetSeason('S1');
      eq(d.grantedCount('S1'), 0);
      eq(d.grant('S1', players).length, 3, '重置后可重新发');
    });

    test('存档往返', () => {
      const d = make();
      d.grant('S1', players);
      d.grant('S2', [players[0]!]);

      const d2 = make();
      d2.importState(d.exportState());
      eq(d2.grantedCount('S1'), 3);
      eq(d2.grantedCount('S2'), 1);
      eq(d2.grant('S1', players).length, 0, '恢复后仍幂等');
    });

    // ---- 分布统计 ----

    test('tierDistribution 统计各段位人数', () => {
      const dist = tierDistribution(players, rankConfig);
      const gold = dist.find((d) => d.tierId === 'gold');
      const diamond = dist.find((d) => d.tierId === 'diamond');
      eq(gold!.count, 1);
      eq(diamond!.count, 1);
      near(gold!.ratio, 1 / 3, 1e-9);
    });

    test('tierDistribution 空数组不崩溃', () => {
      eq(tierDistribution([], rankConfig).length, 0);
    });

    test('⚠️ diagnoseDistribution：最低段位占比过高', () => {
      const d = diagnoseDistribution([{ tierId: 'bronze', ratio: 0.7 }]);
      eq(d.healthy, false);
      assert(d.issues.some((i) => i.includes('最低段位')), d.issues.join());
    });

    test('⚠️ diagnoseDistribution：最高段位占比过高', () => {
      const d = diagnoseDistribution([
        { tierId: 'bronze', ratio: 0.3 },
        { tierId: 'gm', ratio: 0.7 },
      ]);
      assert(d.issues.some((i) => i.includes('最高段位')), d.issues.join());
    });

    test('⚠️ diagnoseDistribution：最高段位无人达到', () => {
      const d = diagnoseDistribution([
        { tierId: 'bronze', ratio: 1 },
        { tierId: 'gm', ratio: 0 },
      ]);
      assert(d.issues.some((i) => i.includes('无人达到')), d.issues.join());
    });

    test('diagnoseDistribution：健康分布', () => {
      const d = diagnoseDistribution([
        { tierId: 'bronze', ratio: 0.2 },
        { tierId: 'silver', ratio: 0.3 },
        { tierId: 'gold', ratio: 0.3 },
        { tierId: 'gm', ratio: 0.01 },
      ]);
      eq(d.healthy, true);
    });

    test('diagnoseDistribution：无数据', () => {
      eq(diagnoseDistribution([]).healthy, false);
    });
  });

  // ================================================================
  describe('ABTest · A/B 实验', () => {
    // ================================================================

    test('⚠️ 分组必须稳定（同一 id 永远同组）', () => {
      const cfg = { name: 'test' };
      const a1 = assign('user-123', cfg);
      for (let i = 0; i < 50; i++) {
        eq(assign('user-123', cfg), a1, `第 ${i} 次应一致`);
      }
    });

    test('⚠️ salt 让不同实验互相独立（避免交叉污染）', () => {
      /**
       * 不用 salt 的话，被分到 A 组的用户在所有实验里都是 A 组，
       * 这些用户会积累大量"实验曝光"，行为被系统性改变。
       */
      /**
       * 【这条测试曾经"通过"但没有真正守住独立性】
       *
       * 原来只有 200 个样本、断言区间 30%~70%。
       * 而裸 FNV-1a 的实际重合率是 **35.6%** —— 落在区间内，
       * 于是测试绿了，但实验间独立性其实是坏的。
       *
       * 35.6% 与 50% 的差距在 2 万样本下相当于 20 个标准差，
       * 是系统性相关，不是随机波动。
       *
       * 现在：样本量提到 5000，区间收紧到 45%~55%，
       * 才能真正检出"哈希雪崩性不足"这一类问题。
       * 修复方式是给 bucketHash 加 murmur3 finalizer。
       */
      let same = 0;
      const ids = Array.from({ length: 5000 }, (_, i) => `u${i}`);
      for (const id of ids) {
        if (assign(id, { name: 'exp1' }) === assign(id, { name: 'exp2' })) same++;
      }
      const ratio = same / ids.length;
      assert(ratio > 0.45 && ratio < 0.55,
        `重合 ${(ratio * 100).toFixed(1)}%，应接近 50%（独立随机）`);
    });

    test('⚠️ 多个实验两两独立（不能只测一对）', () => {
      /**
       * 【为什么要测多对】
       * 只测 expA vs expB 的话，可能恰好那一对是正常的。
       * 裸 FNV-1a 的实测：expA/expB 35.6%、expA/expC 24.0%、expB/expC 64.2% ——
       * 波动范围极大，单测一对完全看不出来。
       */
      const names = ['e1', 'e2', 'e3', 'e4'];
      const ids = Array.from({ length: 2000 }, (_, i) => `u${i}`);
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          let same = 0;
          for (const id of ids) {
            if (assign(id, { name: names[i]! }) === assign(id, { name: names[j]! })) same++;
          }
          const r = same / ids.length;
          assert(r > 0.42 && r < 0.58,
            `${names[i]} vs ${names[j]} 重合 ${(r * 100).toFixed(1)}%，应接近 50%`);
        }
      }
    });

    test('bucketHash 一致性与范围', () => {
      eq(bucketHash('abc'), bucketHash('abc'));
      assert(bucketHash('abc') !== bucketHash('abd'));
      assert(bucketHash('x') >= 0 && bucketHash('x') <= 0xffffffff);
    });

    test('bucketOf 在 0~99', () => {
      for (let i = 0; i < 100; i++) {
        const b = bucketOf(`u${i}`, 's');
        assert(b >= 0 && b < 100, `bucket ${b} 越界`);
      }
    });

    test('treatmentPercent 生效', () => {
      const ids = Array.from({ length: 2000 }, (_, i) => `u${i}`);
      let t = 0;
      for (const id of ids) if (assign(id, { name: 'e', treatmentPercent: 20 }) === 'treatment') t++;
      const ratio = t / ids.length;
      assert(Math.abs(ratio - 0.2) < 0.05, `20% 分组实际 ${(ratio * 100).toFixed(1)}%`);
    });

    test('⚠️ checkBalance 分组均匀性', () => {
      const ids = Array.from({ length: 5000 }, (_, i) => `u${i}`);
      const r = checkBalance(ids, { name: 'e' });
      eq(r.ok, true, `skew=${r.skew}`);
      assert(Math.abs(r.control - r.treatment) < 500 * 0.2,
        `两组人数 ${r.control} / ${r.treatment} 应接近`);
    });

    test('checkBalance 空数组', () => {
      const r = checkBalance([], { name: 'e' });
      eq(r.skew, 0);
      eq(r.ok, true);
    });

    // ---- 统计 ----

    test('recordBinary 与 conversionRate', () => {
      let s = emptyStats();
      s = recordBinary(s, true);
      s = recordBinary(s, false);
      s = recordBinary(s, true);
      s = recordBinary(s, true);
      eq(s.n, 4);
      eq(s.conversions, 3);
      eq(conversionRate(s), 0.75);
    });

    test('recordValue / mean', () => {
      let s = emptyStats();
      s = recordValue(s, 10);
      s = recordValue(s, 20);
      s = recordValue(s, 30);
      eq(mean(s), 20);
    });

    test('⚠️ variance 用 n-1（无偏估计）', () => {
      // [10, 20, 30]：均值 20，总体方差 200/3≈66.7，样本方差 200/2=100
      let s = emptyStats();
      for (const v of [10, 20, 30]) s = recordValue(s, v);
      eq(variance(s), 100, '应除以 n-1');
    });

    test('variance 样本不足返回 0', () => {
      eq(variance(emptyStats()), 0);
      eq(variance(recordValue(emptyStats(), 5)), 0);
    });

    test('conversionRate 空样本返回 0', () => {
      eq(conversionRate(emptyStats()), 0);
    });

    // ---- 显著性 ----

    test('⚠️ 无差异时 p 接近 1', () => {
      /**
       * 【容差为什么是 1e-6 而不是 1e-9】
       *
       * normalCdf 用的是 Abramowitz-Stegun 7.1.26 近似，
       * 最大误差约 1.5e-7。原测试按 1e-9 断言，
       * 相当于要求一个 1e-7 精度的算法给出 1e-9 的结果 —— 不可能成立。
       *
       * 这属于"测试要求的精度超过了实现方式的理论上限"。
       * 对 A/B 测试而言，p = 0.999999999 与 1 没有任何实际差别。
       */
      let c = emptyStats();
      let t = emptyStats();
      for (let i = 0; i < 500; i++) {
        c = recordBinary(c, i % 2 === 0);
        t = recordBinary(t, i % 2 === 0);
      }
      const r = twoProportionZTest(c, t);
      near(r.z, 0, 1e-9);
      near(r.p, 1, 1e-6);
      near(r.lift, 0, 1e-9);
    });

    test('⚠️ 有明显差异时 p 很小', () => {
      let c = emptyStats();
      let t = emptyStats();
      for (let i = 0; i < 1000; i++) {
        c = recordBinary(c, i < 100);          // 10%
        t = recordBinary(t, i < 150);          // 15%
      }
      const r = twoProportionZTest(c, t);
      assert(r.p < 0.01, `p=${r.p} 应显著`);
      near(r.lift, 0.5, 1e-9, '相对提升 50%');
    });

    test('⚠️ 样本不足时 p 值不可信（isSignificant 拦住）', () => {
      let c = emptyStats();
      let t = emptyStats();
      c = recordBinary(c, false);
      t = recordBinary(recordBinary(t, true), true);   // 0/1 vs 2/2

      /**
       * p 值在这个样本量下可能很小（看起来"显著"），
       * 但只有 1 + 2 个样本，完全可能是运气。
       * 所以 isSignificant 必须拦住它 —— 这正是 minSamples 存在的意义。
       */
      eq(isSignificant(c, t, 0.05, 1000), false, '样本不足，一律不显著');
    });

    test('⚠️ 小样本容易出现"假阳性"（这正是要拦的）', () => {
      /**
       * 10 个用户：A 组 1/5 转化，B 组 4/5 转化。
       * 这个差异看起来巨大（20% vs 80%），
       * 但只有 5+5 个样本，完全可能是运气。
       */
      let c = emptyStats();
      let t = emptyStats();
      for (let i = 0; i < 5; i++) {
        c = recordBinary(c, i === 0);
        t = recordBinary(t, i !== 0);
      }
      eq(isSignificant(c, t, 0.05, 1000), false);
    });

    test('isSignificant 样本足够且差异大', () => {
      let c = emptyStats();
      let t = emptyStats();
      for (let i = 0; i < 2000; i++) {
        c = recordBinary(c, i < 200);          // 10%
        t = recordBinary(t, i < 300);          // 15%
      }
      eq(isSignificant(c, t, 0.05, 1000), true);
    });

    test('⚠️ normalCdf 基本性质', () => {
      near(normalCdf(0), 0.5, 1e-3);
      near(normalCdf(1.96), 0.975, 1e-3);
      near(normalCdf(-1.96), 0.025, 1e-3);
    });

    test('⚠️ requiredSampleSize：效应越小，所需样本越大', () => {
      const big = requiredSampleSize(0.1, 0.5);    // 想检测 50% 提升
      const small = requiredSampleSize(0.1, 0.05); // 想检测 5% 提升
      assert(small > big * 50,
        `检测 5% 效应需要 ${small}，远多于检测 50% 的 ${big}`);
    });

    test('⚠️ requiredSampleSize：基线率越低，所需样本越大', () => {
      const low = requiredSampleSize(0.01, 0.2);
      const high = requiredSampleSize(0.5, 0.2);
      assert(low > high, `1% 基线需要 ${low} > 50% 基线的 ${high}`);
    });

    test('requiredSampleSize 参数校验', () => {
      throws(() => requiredSampleSize(0, 0.1), '(0,1)');
      throws(() => requiredSampleSize(1, 0.1), '(0,1)');
      throws(() => requiredSampleSize(0.5, 0), '必须为正');
    });

    // ---- Experiment ----

    test('⚠️ 分组幂等（同一个用户多次上报同组）', () => {
      const e = new Experiment({ name: 'e' });
      const v1 = e.variantOf('u1');
      e.trackBinary('u1', true);
      e.trackBinary('u1', false);   // 同一用户再次上报
      eq(e.variantOf('u1'), v1, '分组不变');
      eq(e.size, 1, '只算一个用户');
    });

    test('trackBinary 累计到正确的组', () => {
      const e = new Experiment({ name: 'e' });
      for (let i = 0; i < 200; i++) {
        e.trackBinary(`u${i}`, i % 2 === 0);
      }
      const r = e.result();
      eq(r.control.n + r.treatment.n, 200);
    });

    test('⚠️ underpowered 时 significant 恒为 false', () => {
      const e = new Experiment({ name: 'e' }, { minSamples: 1000 });
      for (let i = 0; i < 20; i++) e.trackBinary(`u${i}`, true);
      const r = e.result();
      eq(r.underpowered, true);
      eq(r.significant, false);
    });

    test('trackValue 记录数值型指标', () => {
      const e = new Experiment({ name: 'e' });
      for (let i = 0; i < 100; i++) e.trackValue(`u${i}`, i);
      const r = e.result();
      eq(r.control.n + r.treatment.n, 100);
    });

    test('name 与 reset', () => {
      const e = new Experiment({ name: 'my-exp' });
      eq(e.name, 'my-exp');
      e.trackBinary('u1', true);
      e.reset();
      eq(e.size, 0);
      eq(e.result().control.n, 0);
    });

    test('⚠️ describeResult：样本不足时明确说明', () => {
      const e = new Experiment({ name: 'e' }, { minSamples: 1000 });
      for (let i = 0; i < 10; i++) e.trackBinary(`u${i}`, true);
      const text = describeResult(e.result());
      assert(text.includes('样本不足'), text);
    });

    test('⚠️ describeResult：不显著时说明"不等于没有提升"', () => {
      let c = emptyStats();
      let t = emptyStats();
      for (let i = 0; i < 2000; i++) {
        c = recordBinary(c, i < 400);
        t = recordBinary(t, i < 410);
      }
      const r: Parameters<typeof describeResult>[0] = {
        name: 'e', control: c, treatment: t,
        ...twoProportionZTest(c, t),
        significant: false, underpowered: false, minSamples: 1000,
      };
      assert(describeResult(r).includes('不等于没有提升'));
    });

    test('describeResult：显著时给出方向与幅度', () => {
      const r: Parameters<typeof describeResult>[0] = {
        name: 'e', control: emptyStats(), treatment: emptyStats(),
        z: 3, p: 0.001, lift: 0.25,
        significant: true, underpowered: false, minSamples: 1000,
      };
      const text = describeResult(r);
      assert(text.includes('提升') && text.includes('25.0%'), text);
    });
  });
}
