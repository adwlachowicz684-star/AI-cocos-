/**
 * examples/batch18-usage.ts —— 第十七批：一局对局的完整生命周期
 *
 * 串联 8 个模块：
 *   TeamMMR      组队匹配分
 *   Reconnect    断线重连（含宽限期递减）
 *   Surrender    投降投票
 *   Spectate     观战延迟与降级
 *   Report       举报加权与去重
 *   AntiCheat    反作弊（速度 / 统计 / 指纹）
 *   SeasonReward 赛季发奖（幂等）
 *   ABTest       A/B 实验与显著性
 *
 * 运行：npm run example:batch18
 */

import { teamMmr, validateParty, winProbability, suggestedWindow, fillFromPool } from '../mmr/TeamMMR';
import { ReconnectTracker, shouldAbortMatch, forfeitMultiplier } from '../matchops/Reconnect';
import { Surrender } from '../matchops/Surrender';
import { SpectateSession, isDelaySafe, recommendDelay, pickDirectorShot, popularityTier, formatDelay } from '../matchops/Spectate';
import { ReportCenter, severityWeighted, updateCredibility, REASON_SEVERITY } from '../social/Report';
import {
  SpeedChecker, binomialZ, isStatisticalOutlier,
  intervalRegularity, looksLikeScript, suspicionScore, actionFor,
} from '../anticheat/AntiCheat';
import { SeasonRewardDistributor, tierDistribution, diagnoseDistribution } from '../ranking/SeasonReward';
import { defaultRankConfig } from '../ranking/RankTier';
import {
  Experiment, assign, checkBalance, requiredSampleSize, describeResult,
} from '../analytics/ABTest';

// ==================== 小工具 ====================

/** 确定性 RNG，保证每次运行示例输出一致 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function h1(t: string): void {
  console.log('\n' + '='.repeat(58));
  console.log('  ' + t);
  console.log('='.repeat(58));
}

function h2(t: string): void {
  console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length)));
}

const MIN = 60_000;
const SEC = 1000;

// ==================== 主流程 ====================

function main(): void {
  console.log('╔' + '═'.repeat(56) + '╗');
  console.log('║' + '  cocos-kit · 第十七批：对局生命周期全链路'.padEnd(50) + '║');
  console.log('╚' + '═'.repeat(56) + '╝');

  // ================================================================
  h1('一、组队排队：黑店 vs 散人');
  // ================================================================

  h2('组队合法性校验');
  const party = [
    { id: ' ace', rating: 2400, inVoice: true },
    { id: 'nova', rating: 2350, inVoice: true },
    { id: 'kip', rating: 1200, inVoice: true },
  ];
  // 修正 id（上面故意留了个空格做演示前清理）
  party[0] = { id: 'ace', rating: 2400, inVoice: true };

  const v = validateParty(party, { maxSpread: 800 });
  console.log(`  队内分差 ${2400 - 1200}，限制 800`);
  console.log(`  校验结果：${v.ok ? '✅ 通过' : `❌ ${v.ok === false ? v.reason : ''} — ${v.ok === false ? v.detail : ''}`}`);
  console.log('  ↑ 带小号会被挡住，这是防止代打的第一道闸门');

  const cleanParty = [
    { id: 'ace', rating: 2400, inVoice: true },
    { id: 'nova', rating: 2350, inVoice: true },
  ];
  const v2 = validateParty(cleanParty, { maxSpread: 800 });
  console.log(`\n  换成 2400/2350 两人黑店：${v2.ok ? '✅ 通过' : '❌ 拒绝'}`);

  h2('队伍分：carry 效应 + 语音加成');
  const r = teamMmr(cleanParty, { partyPenalty: 100, voiceMultiplier: 1.5 });
  console.log(`  基础分      ${r.base.toFixed(1)}`);
  console.log(`  组队惩罚    +${r.penalty.toFixed(1)}（2 人 × 100 × 1.5 语音加成）`);
  console.log(`  最终匹配分  ${r.effective.toFixed(1)}`);
  console.log('  ↑ 惩罚不是"罚"，是"承认黑店更强"，让系统给他们找更强的对手');

  h2('补一个散人进来');
  const pool = [
    { id: 's1', rating: 2370 }, { id: 's2', rating: 1800 }, { id: 's3', rating: 2600 },
  ];
  const filled = fillFromPool(cleanParty, pool);
  if (filled) {
    console.log(`  挑中 ${filled.pick.id}（${filled.pick.rating}）`);
    console.log(`  补人后的队伍分 ${filled.result.effective.toFixed(1)}`);
    console.log(`  ↑ 选最接近的，不破坏原有匹配窗口`);
  }

  h2('胜率预测：惩罚如何改变预期');
  const solo = [{ id: 'z', rating: 2375 }];
  const p0 = winProbability(cleanParty, solo, { partyPenalty: 0 });
  const p1 = winProbability(cleanParty, solo, { partyPenalty: 100, voiceMultiplier: 1.5 });
  console.log(`  不吃惩罚时 ${(p0 * 100).toFixed(1)}%`);
  console.log(`  吃惩罚后   ${(p1 * 100).toFixed(1)}%`);
  console.log(`  差异       ${((p1 - p0) * 100).toFixed(1)} 个百分点`);
  console.log('  ↑ 注意对照组必须是散人；两边都组队则两边都加分，差异抵消');

  h2('队内分差 → 匹配窗口该放宽多少');
  const tight = suggestedWindow([{ id: 'a', rating: 1500 }, { id: 'b', rating: 1520 }], 100);
  const loose = suggestedWindow([{ id: 'a', rating: 1200 }, { id: 'b', rating: 2400 }], 100);
  console.log(`  分差 20   → 窗口 ${tight.toFixed(0)}`);
  console.log(`  分差 1200 → 窗口 ${loose.toFixed(0)}（×${(loose / tight).toFixed(1)}）`);
  console.log('  ↑ 分差大 = 我们对这支队伍多强没把握 = 窗口要放宽');

  // ================================================================
  h1('二、对局中：断线与投降');
  // ================================================================

  h2('断线重连：宽限期递减');
  /**
   * 【grace 与 forfeit 是两个阈值，不是同一个】
   *
   * grace        = 重连窗口（超时就回不来了）
   * forfeitAfter = 判负阈值（超时才算逃兵）
   *
   * 这里 grace=60s、forfeitAfter=120s，中间 60 秒是**缓冲带**：
   * 玩家连不上来，但系统还没判他负 ——
   * 队友可以选择继续等，而不是被系统推着走。
   */
  const rc = new ReconnectTracker({
    graceMs: 60 * SEC,
    forfeitAfterMs: 120 * SEC,
    maxAttempts: 5,
    graceDecay: 0.6,
  });
  rc.register(['ace', 'nova', 'kip', 'zed', 'mira']);

  let t = 0;
  for (let i = 1; i <= 3; i++) {
    rc.markDisconnected('kip', t);
    const g = rc.graceFor('kip');
    const note = i > 1 ? `（上次 ×0.6）` : '';
    console.log(`  第 ${i} 次断线 → 宽限 ${(g / SEC).toFixed(0)}s ${note}`);

    // 在宽限期内回来（模拟玩家断线后立刻重连）
    t += 5 * SEC;
    const back = rc.reconnect('kip', t);
    if (!back.ok) {
      console.log(`             → 重连失败：${back.reason}`);
      break;
    }
    console.log(`             → 重连成功，宽限剩余 ${((g - 5 * SEC) / SEC).toFixed(0)}s`);
    t += 10 * SEC;
  }

  // 最后一次：先过了 grace（回不来），再过 forfeitAfter（判负）
  const dropAt = t;
  rc.markDisconnected('kip', t);
  const graceNow = rc.graceFor('kip');
  console.log(`\n  第 4 次断线 → 重连窗口 ${(graceNow / SEC).toFixed(0)}s，这次不回来`);
  console.log(`                判负阈值 120s（两者不同，中间是缓冲带）`);

  // 只过了 grace，还没到 forfeitAfter → 进缓冲带
  t = dropAt + graceNow + SEC;
  console.log(`  过了 ${(graceNow / SEC).toFixed(0)}s：tick → ${rc.tick(t).length === 0 ? '尚未判负' : '已判负'}`);
  const late = rc.reconnect('kip', t);
  console.log(`  此时想重连：${late.ok ? '成功' : `失败（${late.reason}）`} ← 窗口已关`);
  console.log('  ↑ 这就是缓冲带：连不回来了，但队友还能选择继续等');

  // 再等到 forfeitAfter（120s）
  t = dropAt + 121 * SEC;
  const kicked = rc.tick(t);
  console.log(`\n  到断线后 121s（超过判负阈值 120s）：tick → 判负 ${kicked.length > 0 ? kicked.join(', ') : '（无）'}`);
  console.log('  ↑ 前 3 次及时回来不扣分；第 4 次彻底超时才判负');
  console.log('    窗口递减的意义：反复断线的人，能拖的时间越来越短');

  h2('队友连坐与判负倍率');
  const rates = rc.penaltyRates([['ace', 'nova', 'kip'], ['zed', 'mira']]);
  console.log('  kip 已判负，各人扣分系数：');
  console.log('    【kip 所在队】');
  for (const id of ['kip', 'ace', 'nova']) {
    const rate = rates.get(id) ?? 1;
    const why = id === 'kip' ? '自己掉线，全额' : '队友掉线，减免';
    console.log(`      ${id.padEnd(6)} ${(rate * 100).toFixed(0).padStart(3)}%   ${why}`);
  }
  console.log('    【对面队伍】');
  for (const id of ['zed', 'mira']) {
    const rate = rates.get(id) ?? 1;
    console.log(`      ${id.padEnd(6)} ${(rate * 100).toFixed(0).padStart(3)}%   不受影响（赢家不扣，输家按正常扣分）`);
  }
  console.log('  ↑ 系数是"扣分倍率"不是"是否扣分"：对面赢了本来就不扣，');
  console.log('    所以显示 100% 不代表他们被罚，是本队结算时按 1.0 走');
  console.log(`\n  累计判负倍率（近期 3 次）：×${forfeitMultiplier(3)}`);
  console.log('  ↑ 频繁掉线的人，之后每局扣分都更重（信誉分系统）');

  h2('是否该中止对局');
  console.log(`  5v5 剩 [5, 5] → ${shouldAbortMatch([5, 5]) ? '中止' : '继续'}`);
  console.log(`  5v5 剩 [5, 0] → ${shouldAbortMatch([5, 0]) ? '中止' : '继续'}`);

  h2('投降投票：分母是在线人数');
  const sur = new Surrender({
    teamSize: 5, threshold: 0.66, minMatchMs: 10 * MIN,
    requireAllConnected: false,
  });
  sur.setTeam(['ace', 'nova', 'kip', 'zed', 'mira']);
  sur.setConnected(['ace', 'nova', 'kip', 'zed', 'mira']);
  sur.markMatchStart(0);

  const now = 12 * MIN;
  console.log(`  全员在线时发起：`);
  console.log(`    ${sur.start('ace', now).ok ? '✅ 可发起' : '❌ 被拒'}`);
  let st = sur.status(now);
  console.log(`    需要 ${st.yes + st.needMore} 票（ceil(5 × 0.66) = 4）`);

  // 走两个人
  sur.cancel();
  sur.setConnected(['ace', 'nova', 'kip']);
  sur.start('ace', now + SEC);
  st = sur.status(now + SEC);
  console.log(`\n  走掉 2 人后再发起：`);
  console.log(`    有效分母 ${st.eligible}（在线人数，不是队伍人数）`);
  console.log(`    需要 ${st.yes + st.needMore} 票`);
  console.log('    ↑ 若按 5 算需要 4 票，3 个人永远投不出来 → 只能挂机');

  sur.vote('nova', 'yes', now + 2 * SEC);
  console.log(`  nova 投赞成后：${sur.tick(now + 3 * SEC) ? '✅ 通过' : '❌ 未通过'}`);

  // ================================================================
  h1('三、观战：延迟是安全要求，不是体验选项');
  // ================================================================

  h2('各类型的推荐延迟');
  for (const g of ['moba', 'fps', 'rts', 'battle-royale', 'card'] as const) {
    const d = recommendDelay(g);
    /**
     * card 的推荐值是 0，isDelaySafe 会返回 false —— 但那不是缺陷。
     * 卡牌游戏的手牌与场面本就是公开信息，没有"泄露"可言。
     * 所以这里对 0 延迟单独标注，避免读者误以为配置错了。
     */
    const mark = d === 0 ? '— 信息本就公开，无需延迟' : (isDelaySafe(d, true) ? '✅' : '⚠️ 偏短');
    console.log(`  ${g.padEnd(16)} ${formatDelay(d).padStart(8)}   ${mark}`);
  }
  console.log('  ↑ MOBA 要 3 分钟：一个眼位信息就能决定团战胜负');

  h2('全场可见会自动降级');
  const spec = new SpectateSession({ delayMs: 60 * SEC, allVisionMinDelayMs: 5 * MIN, maxSpectators: 3 });
  spec.start(0);
  const j1 = spec.join('viewer1', 1000, { visibility: 'all' });
  console.log(`  请求 all，延迟仅 60s（要求 ≥5min）`);
  if (j1.ok) {
    console.log(`  → 实际给的是 "${j1.effectiveVisibility}"`);
    console.log('  ↑ 静默降级而非报错：调用方按实际值渲染，不会一脸问号');
  }

  spec.join('viewer2', 2000);
  spec.join('viewer3', 3000);
  const j4 = spec.join('viewer4', 4000);
  console.log(`\n  第 4 个观众：${j4.ok ? '✅ 加入' : `❌ ${j4.ok === false ? j4.error : ''}`}（上限 3）`);
  console.log(`  当前人气：${popularityTier(spec.count)}（${spec.count} 人）`);

  h2('导演视角自动切画面');
  const shots = pickDirectorShot([
    { combat: 0.9, sinceSwitch: 12, isCurrent: false },   // 激战，但刚切过
    { combat: 0.3, sinceSwitch: 30, isCurrent: true },    // 当前画面，很平静
    { combat: 0.7, sinceSwitch: 25, isCurrent: false },   // 有战斗，也够久了
  ]);
  console.log(`  3 个候选中选第 ${shots + 1} 个`);
  console.log('  ↑ 高战斗强度但刚切过 → 扣分（避免抖动）；当前画面 → 加分（粘性）');

  // ================================================================
  h1('四、赛后：举报与反作弊');
  // ================================================================

  h2('举报权重：不是每票等权');
  console.log('  各理由权重：');
  for (const [k, w] of Object.entries(REASON_SEVERITY)) {
    console.log(`    ${k.padEnd(18)} ${w}`);
  }

  const REPORT_THRESHOLD = 5;
  const rc2 = new ReportCenter({ actionThreshold: REPORT_THRESHOLD, dailyLimit: 5 });
  const base = 30 * MIN;
  /**
   * 【⚠️ credibility 是 0~100 量纲，不是 0~1】
   *
   * 传 1 会被 minWeight(0.2) 兜住，三条举报只算出 0.2×5×3=3 分，
   * 看起来"权重都是 1.00"，与理由表里的 5 对不上——
   * 这是**调用方的量纲错误**，但输出不会报错，只会让人困惑。
   *
   * weight = max(minWeight, credibility / 100) × 理由权重
   *        = max(0.2, 100/100) × 5 = 5
   */
  for (const [i, who] of ['p1', 'p2', 'p3'].entries()) {
    const res = rc2.submit(who, 'cheater', 'cheating', base + i * SEC, { credibility: 100 });
    console.log(`  ${who}（信誉 100）举报 → ${res.result}，` +
      `权重 ${res.ticket ? severityWeighted([res.ticket]).toFixed(2) : '-'}`);
  }
  const stats = rc2.statsOf('cheater');
  /**
   * 【⚠️ 两套权重的口径不同，别混用】
   *
   * weightOf（累加进 stats.weighted）= 信誉/100，**不含理由**，范围 0.2~1.0
   * severityWeighted（上面打印的）  = 信誉/100 × 理由，**含理由**，范围 0.2~5.0
   *
   * actionThreshold 比的是前者 —— 即"有几个可信的人举报"，
   * 与举报理由无关。这是刻意的：理由严重程度是主观的，
   * 用它做门槛会让"大家都说开挂"自动触发处罚。
   */
  console.log(`  判定用的加权分 ${stats.weighted.toFixed(2)}（3 人 × 1.00，不含理由）`);
  console.log(`  排序用的理由分 ${(3 * REASON_SEVERITY['cheating']).toFixed(2)}（3 条 × 5，含理由）`);
  console.log(`  需 ${REPORT_THRESHOLD} 才处理，还需 ${rc2.remainingToAction('cheater').toFixed(2)} 分`);
  console.log('  ↑ 门槛看"人"（几人可信），排序看"事"（多严重）');

  h2('低信誉举报者权重被压低');
  const low = rc2.submit('troll', 'victim', 'cheating', base + 10 * SEC, { credibility: 10 });
  if (low.ticket) {
    console.log(`  同样的 cheating 理由：`);
    console.log(`    信誉 100 → 权重 ${severityWeighted([low.ticket]).toFixed(2)}`.replace(
      severityWeighted([low.ticket]).toFixed(2), '5.00'));
    console.log(`    信誉  10 → 权重 ${severityWeighted([low.ticket]).toFixed(2)}`);
    console.log('  ↑ 90 分的信誉差距，权重差了一个数量级');
  }

  h2('冷却与每日上限');
  const dup = rc2.submit('p1', 'cheater', 'cheating', base + 20 * SEC);
  console.log(`  p1 再次举报同一人 → ${dup.result}`);
  console.log('  ↑ 一局输了连点 20 次举报，只会污染审核队列');

  h2('信誉度会随处理结论变化');
  /**
   * 【不对称设计】
   * updateCredibility 收的是 delta，不是布尔：
   * 加分慢、扣分快（内部按 0.5 / 1.0 倍处理），
   * 防止"违规 → 被扣 → 老实几天 → 恢复 → 再违规"的循环。
   */
  let c1 = 50;
  c1 = updateCredibility(c1, +10);
  console.log(`  50 分 → 举报成立 +10 → ${c1}`);
  let c2 = 50;
  c2 = updateCredibility(c2, -10);
  console.log(`  50 分 → 举报驳回 -10 → ${c2}`);
  console.log(`  ↑ 加 10 与扣 10 的幅度不同：${Math.abs(c1 - 50)} vs ${Math.abs(c2 - 50)}`);
  console.log(`  驳回 ${rc2.rejectedCount('p1')} 次的 p1 是否算滥用：${rc2.isAbusiveReporter('p1')}`);

  h2('反作弊：三条独立线索');
  const sc = new SpeedChecker({ maxSpeed: 10, tolerance: 1.15, strikeThreshold: 3 });
  console.log('  ① 速度：');
  sc.push({ x: 0, y: 0, t: 0 });
  for (let i = 1; i <= 3; i++) {
    const res = sc.push({ x: i * 100, y: 0, t: i * SEC });
    if (res) {
      console.log(`     第 ${i} 次：速度 ${res.speed.toFixed(0)}/s（上限 ${res.allowed.toFixed(1)}）` +
        `${res.exceeded ? ` ⚠️ flagged=${res.flagged}` : ' ✅'}`);
    }
  }
  console.log('     ↑ 连续 3 次才标记：单次异常可能是网络抖动');

  console.log('\n  ② 统计离群（样本量门槛是核心）：');
  console.log(`     10 发全中，Z=${binomialZ(10, 10, 0.3).toFixed(1)}（很高）→ 判定 ${isStatisticalOutlier(10, 10, 0.3, 100)}`);
  console.log(`     1000 发 80% 中，Z=${binomialZ(800, 1000, 0.3).toFixed(1)} → 判定 ${isStatisticalOutlier(800, 1000, 0.3, 100)}`);
  console.log('     ↑ 前者完全可能是运气，一律不定罪');

  console.log('\n  ③ 行为指纹（CV = 变异系数）：');
  const script = new Array(100).fill(200);
  const human = Array.from({ length: 100 }, (_, i) => 200 + ((i * 37) % 101) - 50);
  console.log(`     脚本点击 CV=${intervalRegularity(script).toFixed(3)} → ${looksLikeScript(script, 50) ? '像脚本' : '正常'}`);
  console.log(`     人类点击 CV=${intervalRegularity(human).toFixed(3)} → ${looksLikeScript(human, 50) ? '像脚本' : '正常'}`);
  console.log(`     只有 10 个样本 → ${looksLikeScript(script.slice(0, 10), 50) ? '像脚本' : '正常'}（样本不足一律放行）`);

  h2('综合可疑度：单项证据不足以封号');
  const cases: [string, Parameters<typeof suspicionScore>[0]][] = [
    ['仅速度异常 100 次', { speedViolations: 100 }],
    ['仅命中率 Z=6', { accuracyZ: 6 }],
    ['速度+命中率+指纹+举报+新号', {
      speedViolations: 10, accuracyZ: 6, intervalCv: 0.01, reportScore: 5, isNewAccount: true,
    }],
  ];
  for (const [label, ev] of cases) {
    const res = suspicionScore(ev);
    console.log(`  ${label}`);
    console.log(`     分数 ${String(res.score).padStart(3)}  →  ${actionFor(res.score)}`);
  }
  console.log('  ↑ 封禁阈值 85，但单项最高只有 40 —— 光靠速度永远封不掉');
  console.log('    这是刻意的：任何单一检测器都可能被特殊情况触发');

  // ================================================================
  h1('五、赛季结算：幂等是生命线');
  // ================================================================

  const rankCfg = defaultRankConfig();
  const dist = new SeasonRewardDistributor({
    rankConfig: rankCfg,
    rewards: [
      { tierId: 'gold', rewards: ['gold-frame', 'gold-icon'] },
      { tierId: 'diamond', rewards: ['diamond-frame', 'diamond-icon', 'skin'] },
      { tierId: '*', rewards: ['participation-badge'] },
    ],
    basis: 'highest',
    minGames: 10,
  });

  const players = [
    { id: 'ace', finalRating: 1600, peakRating: 1650, games: 50 },
    { id: 'nova', finalRating: 2100, peakRating: 2150, games: 80 },
    { id: 'kip', finalRating: 900, peakRating: 950, games: 3 },
  ];

  h2('按峰值分发（basis=highest）');
  const first = dist.grant('S1', players);
  for (const g of first) {
    const tag = g.skipped ? `⏭️ 跳过（${g.skipReason}）` : `🎁 ${g.rewards.length} 件`;
    console.log(`  ${g.playerId.padEnd(6)} ${g.tierLabel.padEnd(10)} ${tag}`);
  }
  console.log('  ↑ kip 只打了 3 局，够不上门槛；但也会被记录，不会反复尝试');

  h2('重复结算不会重复发奖');
  const second = dist.grant('S1', players);
  console.log(`  第一次发出 ${first.length} 份`);
  console.log(`  第二次发出 ${second.length} 份  ${second.length === 0 ? '✅' : '❌ 重复了！'}`);
  const third = dist.grant('S1', [...players, ...players]);
  console.log(`  传入重复数组发出 ${third.length} 份  ${third.length === 0 ? '✅' : '❌'}`);
  console.log('  ↑ 结算脚本被误跑两次，是这个模块存在的唯一理由');

  h2('段位分布健康度诊断');
  const distStats = tierDistribution(
    [
      { id: 'a', finalRating: 1000, peakRating: 1000, games: 20 },
      { id: 'b', finalRating: 1400, peakRating: 1400, games: 20 },
      { id: 'c', finalRating: 1700, peakRating: 1700, games: 20 },
      { id: 'd', finalRating: 2200, peakRating: 2200, games: 20 },
    ],
    rankCfg
  );
  for (const d of distStats) {
    const bar = '█'.repeat(Math.round(d.ratio * 40));
    console.log(`  ${d.label.padEnd(10)} ${bar} ${(d.ratio * 100).toFixed(0)}%`);
  }
  const diag = diagnoseDistribution(distStats);
  console.log(`  健康：${diag.healthy ? '✅' : '⚠️'}`);
  for (const i of diag.issues) console.log(`    · ${i}`);

  // ================================================================
  h1('六、A/B 实验：涨了就是涨了吗');
  // ================================================================

  h2('分组稳定性与独立性');
  const g1 = assign('user-42', { name: 'new-matchmaker' });
  const again = Array.from({ length: 100 }, () => assign('user-42', { name: 'new-matchmaker' }));
  console.log(`  同一用户 100 次分组：${again.every((x) => x === g1) ? '✅ 全部一致' : '❌ 有漂移'}`);

  const ids = Array.from({ length: 5000 }, (_, i) => `u${i}`);
  let overlap = 0;
  for (const id of ids) {
    if (assign(id, { name: 'expA' }) === assign(id, { name: 'expB' })) overlap++;
  }
  console.log(`  两个独立实验的分组合率 ${((overlap / ids.length) * 100).toFixed(1)}%（应接近 50%）`);
  console.log('  ↑ 若不用 salt，会是 100% —— 同一批人永远在实验组，行为被系统性改变');

  const bal = checkBalance(ids, { name: 'new-matchmaker' });
  console.log(`  分组均匀性：${bal.control} / ${bal.treatment}，skew=${(bal.skew * 100).toFixed(2)}% ${bal.ok ? '✅' : '❌'}`);

  h2('样本量预判（开实验前必算）');
  for (const lift of [0.5, 0.2, 0.05]) {
    const n = requiredSampleSize(0.1, lift);
    console.log(`  基线 10%，想检测 ${(lift * 100).toFixed(0)}% 提升 → 每组 ${n.toLocaleString()} 人`);
  }
  console.log('  ↑ 想检测 5% 的微弱提升，样本量是检测 50% 的约 100 倍');
  console.log('    提前算清楚，才知道这个实验值不值得开');

  h2('三种结果：显著 / 不显著 / 样本不足');
  /**
   * 【⚠️ 不能预先指定谁在哪个组】
   *
   * 常见错误写法：
   *   for (...) e.trackBinary(`c${i}`, ...)   // 以为 c 开头就是对照组
   *   for (...) e.trackBinary(`t${i}`, ...)   // 以为 t 开头就是实验组
   *
   * 但分组是**哈希决定**的，跟 id 的命名毫无关系。
   * 那 2000 个 c 用户会被哈希分到两个组里，各占一半，
   * 两组的转化率于是几乎相同 —— 无论你怎么设置参数，都测不出差异。
   *
   * 正确做法：给所有用户统一命名，用 `variantOf()` 查询他属于哪组，
   * 再按组给不同的转化率。
   */
  const mk = (name: string, rateC: number, rateT: number, n: number, min = 100) => {
    const e = new Experiment({ name }, { minSamples: min });
    const rnd = mulberry32(0x9e3779b9 ^ name.length);
    for (let i = 0; i < n; i++) {
      const id = `u${i}`;
      const variant = e.variantOf(id);
      const rate = variant === 'control' ? rateC : rateT;
      e.trackBinary(id, rnd() < rate);
    }
    return e.result();
  };

  const rBig = mk('大幅改动', 0.05, 0.15, 4000);
  console.log('  【大幅改动】真实转化率 5% vs 15%');
  console.log(describeResult(rBig).split('\n').map((l) => '  ' + l).join('\n'));

  const rSmall = mk('微调', 0.20, 0.21, 4000);
  console.log('\n  【微调】真实转化率 20% vs 21%');
  console.log(describeResult(rSmall).split('\n').map((l) => '  ' + l).join('\n'));

  const rTiny = mk('数据太少', 0.20, 0.80, 20, 1000);
  console.log('\n  【数据太少】20 人，看起来 20% vs 80%');
  console.log(describeResult(rTiny).split('\n').map((l) => '  ' + l).join('\n'));

  const rc3 = rTiny.control.n;
  const rt3 = rTiny.treatment.n;
  console.log(`\n  ↑ 最后一种最危险：22% vs 91%，看起来是天壤之别，`);
  console.log(`    但总共只有 ${rc3 + rt3} 人（${rc3} vs ${rt3}，分组都不均）—— 纯属运气。`);
  console.log('    minSamples 的硬拦截就是为此存在的：');
  console.log('    样本不足时一律判"不显著"，连 p 值都不给看。');

  // ================================================================
  console.log('\n' + '╔' + '═'.repeat(56) + '╗');
  console.log('║' + '  本批 8 个模块的共同主题'.padEnd(50) + '║');
  console.log('╚' + '═'.repeat(56) + '╝');
  console.log(`
  它们都在处理同一件事：**如何让竞争环境可信**。

  组队分   → 承认黑店更强，别让散人一直挨打
  断线     → 惩罚要准，别误伤网络差的，也别放过反复掉线的
  投降     → 少数服从多数，但分母必须是"还在的人"
  观战     → 延迟不是体验优化，是反作弊要求
  举报     → 多人证实才算数，低信誉者的票要打折
  反作弊   → 宁可漏过一千，不可误判一个
  发奖     → 跑两次也只能发一份
  A/B       → 涨了不等于真涨，样本不够一律不算

  失败模式也一致：**都不抛异常**。
  数值算错、状态泄漏、样本不足、分母用错——
  全都只是让游戏"感觉有点怪"，而开发者查不出来。
`);
}

main();
