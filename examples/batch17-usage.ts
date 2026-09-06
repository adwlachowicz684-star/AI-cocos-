/**
 * examples/batch17-usage.ts —— 第十六批插件：评分与匹配
 *
 * | 模块 | 场景 |
 * |---|---|
 * | Elo           | 1v1 与多人对局的分数结算 |
 * | Glicko2       | 含不确定度的评分（新号定级、久未登录） |
 * | Matchmaker    | 撮合队列（双向范围、窗口放宽、超时兜底） |
 * | TeamBalancer  | 分队平衡（黑店不拆、角色配额） |
 * | Lobby         | 房间（房主迁移、准备状态） |
 * | RankTier      | 段位展示与赛季重置 |
 *
 * 【为什么这六个放一起】
 * 它们串起来就是一局对战的完整生命周期：
 *   房间（Lobby）→ 排队（Matchmaker）→ 分队（TeamBalancer）
 *   → 结算（Elo/Glicko2）→ 展示（RankTier）
 */

import {
  rate1v1,
  rateMultiplayerDetailed,
  expectedScore,
  ratingGapFor,
} from '../elo/Elo';
import {
  createGlickoPlayer,
  type GlickoPlayer,
  ratePeriod,
  decayRd,
  conservativeRating,
  confidenceInterval,
  isSettled,
} from '../elo/Glicko2';
import {
  Matchmaker,
  matchQuality,
  type QueueEntry,
} from '../matchmaking/Matchmaker';
import {
  balanceTeams,
  validateTeamAssignment,
  type BalancePlayer,
} from '../matchmaking/TeamBalancer';
import { Lobby } from '../matchmaking/Lobby';
import {
  tierOf,
  RankProgress,
  softReset,
  defaultRankConfig,
} from '../ranking/RankTier';

function hr(t: string): void {
  console.log(`\n${'─'.repeat(56)}\n${t}\n${'─'.repeat(56)}`);
}

// ============================================================
hr('【1】ELO —— 谁赢了、加多少');
// ============================================================
{
  console.log('期望胜率（分差的影响）：');
  for (const gap of [0, 100, 200, 400, 800]) {
    const e = expectedScore(1500 + gap, 1500);
    console.log(`  分差 ${String(gap).padStart(3)} → 胜率 ${(e * 100).toFixed(1)}%`);
  }

  console.log(`\n反查：想让强手胜率 75%，双方该差 ${ratingGapFor(0.75).toFixed(0)} 分`);

  console.log('\n结算（同分 1500，K=32）：');
  const cases: readonly { name: string; a: number; b: number; o: 1 | 0.5 | 0 }[] = [
    { name: '弱胜强', a: 1200, b: 1800, o: 1 },
    { name: '强胜弱', a: 1800, b: 1200, o: 1 },
    { name: '平局  ', a: 1200, b: 1800, o: 0.5 },
  ];
  const gains: number[] = [];
  for (const outcome of cases) {
    const r = rate1v1({ rating: outcome.a, games: 100 }, { rating: outcome.b, games: 100 }, outcome.o, {
      allowDecimal: true,
      provisionalGames: 0,
      masterThreshold: 1e9,
    });
    gains.push(r.deltaA);
    console.log(
      `  ${outcome.name}  ${outcome.a} vs ${outcome.b} → ` +
      `${outcome.a} ${r.deltaA >= 0 ? '+' : ''}${r.deltaA.toFixed(1)} / ` +
      `${outcome.b} ${r.deltaB >= 0 ? '+' : ''}${r.deltaB.toFixed(1)}`
    );
  }
  console.log(
    `  ↑ 弱手爆冷拿 ${gains[0]!.toFixed(1)} 分，强手正常赢只拿 ${gains[1]!.toFixed(1)} 分` +
    ` —— 差 ${(gains[0]! / gains[1]!).toFixed(0)} 倍，这就是 ELO 的核心逻辑`
  );

  console.log('\n8 人吃鸡（总分守恒）：');
  const players = [1700, 1650, 1600, 1550, 1500, 1450, 1400, 1350].map((r) => ({
    rating: r, games: 100,
  }));
  const before = players.reduce((a, p) => a + p.rating, 0);
  const d = rateMultiplayerDetailed(players, [0, 1, 2, 3, 4, 5, 6, 7], {
    allowDecimal: true, provisionalGames: 0, masterThreshold: 1e9,
  });
  const after = d.reduce((a, x) => a + x.rating, 0);
  for (let i = 0; i < 8; i++) {
    const x = d[i]!;
    console.log(
      `  第 ${i + 1} 名  ${String(players[i]!.rating).padStart(4)} → ${x.rating.toFixed(1).padStart(7)}` +
      `  ${x.delta >= 0 ? '+' : ''}${x.delta.toFixed(1).padStart(6)}` +
      `  （实际胜 ${x.actual} 场 / 期望 ${x.expected.toFixed(2)} 场）`
    );
  }
  console.log(`  总分 ${before} → ${after.toFixed(6)}（必须相等）`);
}

// ============================================================
hr('【2】Glicko-2 —— 同样是 1500 分，可信度天差地别');
// ============================================================
{
  const fresh = createGlickoPlayer(1500, 350, 0.06);    // 新号
  const veteran = createGlickoPlayer(1500, 50, 0.06);   // 打了很久

  const samples: readonly { name: string; p: GlickoPlayer }[] = [
    { name: '新号', p: fresh },
    { name: '老号', p: veteran },
  ];
  for (const { name, p } of samples) {
    const ci = confidenceInterval(p);
    console.log(
      `${name}  ${p.rating}  RD ${p.rd.toFixed(0).padStart(3)}` +
      `  真实水平可能在 ${ci.low.toFixed(0)}~${ci.high.toFixed(0)}` +
      `  保守分 ${conservativeRating(p).toFixed(0)}`
    );
  }
  console.log('  ↑ 两个都是 1500 分，但匹配时应该用保守分，而不是真实分');
  console.log('    否则新号（真实水平未知）会被当成固定 1500 分，开局就炸鱼');

  // 新号定级速度
  console.log('\n新号连胜 8 局（对手都是确定的 1500 分）：');
  let p: GlickoPlayer = fresh;
  const opp = createGlickoPlayer(1500, 60, 0.06);
  for (let i = 1; i <= 8; i++) {
    p = ratePeriod(p, [{ opponent: opp, score: 1 }]);
    if (i % 2 === 0 || i === 1) {
      console.log(
        `  第 ${i} 局  分数 ${p.rating.toFixed(0)}  RD ${p.rd.toFixed(0)}` +
        `  ${isSettled(p) ? '（已定级）' : ''}`
      );
    }
  }
  console.log('  ↑ RD 一路下降，加分幅度同步收窄 —— 系统越来越"确定"他的水平');

  // 久未登录
  console.log('\n半年没上线（180 天）：');
  const before = createGlickoPlayer(1800, 45, 0.06);
  const after = decayRd(before, 180);
  console.log(
    `  分数 ${before.rating}（不变）  RD ${before.rd.toFixed(0)} → ${after.rd.toFixed(0)}`
  );
  console.log('  ↑ 系统不再"确定"他还是 1800 的水平，回来后会快速重新定级');
}

// ============================================================
hr('【3】撮合 —— 窗口随等待放宽，且必须双向成立');
// ============================================================
{
  const mm = new Matchmaker({
    teamSize: 5, teamsPerMatch: 2,
    initialRange: 50, rangeGrowthPerSec: 3, maxRange: 400,
    guaranteedAfterMs: 120_000,
  });

  const crowd = (ids: string[], rating: number): QueueEntry[] =>
    ids.map((id) => ({ id, rating }));

  // 分差 300，初始窗口 ±50 → 撮不起来
  mm.enqueueAll(crowd(['h1', 'h2', 'h3', 'h4', 'h5'], 1700), 0);
  mm.enqueueAll(crowd(['l1', 'l2', 'l3', 'l4', 'l5'], 1400), 0);
  console.log(`10 人入队（1700 组 vs 1400 组），立刻撮合：${mm.tick(1000).length} 场`);
  console.log('  ↑ 分差 300，初始窗口只有 ±50，撮不起来');

  // 等到窗口放宽到 300
  let t = 1000;
  for (; t <= 120_000; t += 5000) {
    if (mm.tick(t).length > 0) break;
  }
  console.log(`等到 ${(t / 1000).toFixed(0)} 秒（窗口已放宽到 ±${Math.min(400, 50 + 3 * (t / 1000)).toFixed(0)}）→ 撮合成功`);
  console.log(`队列剩余 ${mm.queueSize} 人`);

  // 双向成立的演示
  console.log('\n【双向范围】大佬等了很久，窗口 ±400；新手刚进来，窗口 ±50');
  console.log('  只看大佬的窗口 → 分差 400，撮合成功 → 新手当场被打崩');
  console.log('  取两者较小值   → min(400, 50) = 50 → 不撮合 ✓');

  // 超时兜底
  const mm2 = new Matchmaker({
    teamSize: 1, teamsPerMatch: 2,
    initialRange: 10, maxRange: 20, guaranteedAfterMs: 60_000,
  });
  mm2.enqueueAll([{ id: 'a', rating: 1500 }, { id: 'b', rating: 2500 }], 0);
  console.log(`\n分差 1000 的两人，60 秒内撮合：${mm2.tick(30_000).length} 场`);
  const forced = mm2.tick(61_000);
  console.log(`超过保证时间后：${forced.length} 场，relaxed = ${forced[0]?.relaxed}`);
  console.log('  ↑ 凌晨人少时，宁可质量差也不能让人干等');
}

// ============================================================
hr('【4】分队 —— 蛇形不最优，黑店不能拆');
// ============================================================
{
  const p = (rs: number[]): BalancePlayer[] =>
    rs.map((r, i) => ({ id: `p${i}`, rating: r }));

  // 蛇形 vs LPT
  const rs = [2000, 1500, 1500, 1000];
  const snake = [
    [rs[0]!, rs[2]!],   // 2000, 1500
    [rs[1]!, rs[3]!],   // 1500, 1000
  ];
  const snakeSpread =
    Math.abs(avg(snake[0]!) - avg(snake[1]!));
  const r = balanceTeams(p(rs), { teamCount: 2 });
  console.log(`分数 [${rs.join(', ')}]`);
  console.log(`  蛇形分配  ${JSON.stringify(snake)}  两队差 ${snakeSpread}`);
  console.log(`  本库 LPT  ${JSON.stringify(r.teams.map((t) => t.players.map((x) => x.rating)))}  两队差 ${r.spread}`);
  console.log('  ↑ 蛇形只在"分数均匀递减"时最优，现实分布常常不是');

  // 黑店
  console.log('\n【黑店不可拆】');
  const withParty: BalancePlayer[] = [
    { id: 's1', rating: 2000, partyId: 'stack' },
    { id: 's2', rating: 1900, partyId: 'stack' },
    { id: 'p1', rating: 1200 },
    { id: 'p2', rating: 1100 },
  ];
  const rp = balanceTeams(withParty, { teamCount: 2 });
  for (const t of rp.teams) {
    const marks = t.players.map((x) => `${x.id}${x.partyId ? '(黑店)' : ''}`);
    console.log(`  ${marks.join(' + ')}  平均 ${t.rating.toFixed(0)}`);
  }
  const v = validateTeamAssignment(rp.teams.map((t) => t.players));
  console.log(`  校验：${v.ok ? '通过 ✓' : v.reason}`);
  console.log('  ↑ 为了不拆黑店，均衡度必然下降 —— 这是硬约束，不是算法不够好');

  // 角色配额
  console.log('\n【角色配额】每队至少 1 坦克');
  const roles: BalancePlayer[] = [
    { id: 'a', rating: 1500, role: 'tank' },
    { id: 'b', rating: 1400, role: 'tank' },
    { id: 'c', rating: 1600, role: 'dps' },
    { id: 'd', rating: 1500, role: 'support' },
  ];
  const rr = balanceTeams(roles, {
    teamCount: 2,
    roleQuota: { tank: 1 },
  });
  for (const t of rr.teams) {
    console.log(`  ${t.players.map((x) => `${x.id}(${x.role})`).join(' + ')}`);
  }

  // 质量评分
  console.log('\n对局质量：');
  for (const [name, ratings] of [
    ['四人同分    ', [1500, 1500, 1500, 1500]],
    ['小分差      ', [1550, 1500, 1500, 1450]],
    ['两极分化    ', [2000, 2000, 1000, 1000]],
  ] as const) {
    console.log(`  ${name} ${matchQuality(ratings, 2).toFixed(3)}`);
  }
}

function avg(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ============================================================
hr('【5】房间 —— 房主走了怎么办');
// ============================================================
{
  const l = new Lobby({ capacity: 4, minPlayers: 4 });
  const P = (id: string) => ({ id, name: id.toUpperCase() });

  l.join(P('a'), undefined, 0);
  l.join(P('b'), undefined, 100);
  l.join(P('c'), undefined, 200);
  console.log(`三人入队，房主 ${l.hostId}`);

  l.setReady('a', true);
  l.setReady('b', true);
  console.log(`两人准备，能否开局：${l.canStart().ok ? '能' : '不能'} —— ${l.startBlockReason()}`);

  l.join(P('d'), undefined, 300);
  l.setReady('c', true);
  l.setReady('d', true);
  console.log(`四人满员全员准备：${l.startBlockReason() ?? '可以开局 ✓'}`);

  // 房主退出
  l.leave('a');
  console.log(`\n房主 a 退出 → 房主变成 ${l.hostId}（自动迁移）`);
  console.log(`能否开局：${l.canStart().ok ? '能' : '不能'} —— ${l.startBlockReason()}`);
  console.log('  ↑ 房主迁移做错的话，剩下三人会对着"开始"按钮点了半天没反应');

  l.join(P('e'), undefined, 400);
  l.setReady('e', true);
  console.log(`\ne 补位并准备：${l.startBlockReason() ?? '可以开局 ✓'}`);

  l.beginStart();
  console.log(`\n点击开始 → 状态 ${l.state}`);
  console.log(`此时有人想挤进来：${l.join(P('f'), undefined, 500).error}`);
  console.log('  ↑ 加载中放人进来，会表现为"进游戏后队伍里多了个陌生人"');

  l.finishStart();
  l.reopen();
  console.log(`\n打完回房间：状态 ${l.state}，玩家 ${l.size} 人，已准备 ${l.readyCount} 人`);
  console.log('  ↑ 玩家保留，但要重新点准备，防止连开第二局时有人没看');
}

// ============================================================
hr('【6】段位 —— 反复横跳与赛季重置');
// ============================================================
{
  const cfg = defaultRankConfig();

  console.log('段位表（小段编号越小越高）：');
  for (const r of [800, 1200, 1350, 1499, 1500, 1650, 1800, 2400, 2700]) {
    const t = tierOf(r, cfg);
    const bar = '█'.repeat(Math.round(t.progress * 20)).padEnd(20, '░');
    const next = t.toNext === Infinity ? '—' : `${t.toNext.toFixed(0)}`;
    console.log(`  ${String(r).padStart(4)}  ${t.label.padEnd(10)} ${bar}  还需 ${next}`);
  }

  // 边界横跳
  /**
   * 【分数要选在段位线附近】
   * 白银 II 是 1300~1400，白银 I 是 1400~1500。
   * 所以要让它横跳，分数得在 1400 上下 ——
   * 选 1350~1360 的话全在白银 II 区间内，根本不会跨段，演示就没意义了。
   */
  console.log('\n【边界横跳】玩家分数在 1400（白银 II/I 的分界）上下反复：');
  const wobble = [1405, 1395, 1410, 1390, 1415, 1385, 1420, 1380];

  function countJumps(progress: RankProgress): { p: number; d: number; trail: string[] } {
    let p = 0;
    let d = 0;
    const trail: string[] = [];
    for (const r of wobble) {
      const u = progress.update(r);
      if (u.event === 'promoted') { p++; trail.push(`↑${r}`); }
      else if (u.event === 'demoted') { d++; trail.push(`↓${r}`); }
      else trail.push(String(r));
    }
    return { p, d, trail };
  }

  const plain = countJumps(new RankProgress(cfg, 1400));
  console.log(`  无余量：升段 ${plain.p} 次、掉段 ${plain.d} 次`);
  console.log(`    轨迹 ${plain.trail.join(' → ')}`);
  console.log('    ↑ 玩家会觉得自己"刚升上去就掉下来"，这是最劝退的体验之一');

  const strict = new RankProgress(defaultRankConfig({ promotionMargin: 30 }), 1400);
  const guarded = countJumps(strict);
  console.log(`\n  加 30 分余量（要超过段位线 30 分才算升段）：升段 ${guarded.p} 次、掉段 ${guarded.d} 次 ✓`);
  console.log(`    轨迹 ${guarded.trail.join(' → ')}`);

  // 掉段保护
  /**
   * 【演示分数必须真的掉出段位线】
   *
   * 白银 III 的区间是 1200~1300。
   * 用 1250 演示的话，它本来就在区间内，
   * 系统认为"分数已回到线上"→ 保护立刻失效（防卡保护刷分的设计），
   * 演示就完全看不出效果了。
   *
   * 必须用 1150 —— 已经掉出白银 III 的下限 1200。
   */
  console.log('\n【掉段保护】白银 II（1350）连输，掉到 1150（已在白银 III 线外）：');
  const rp2 = new RankProgress(cfg, 1350);
  const first = rp2.update(1250);
  console.log(`  先掉到 1250 → ${first.info.label}（${first.event}），获得 ${rp2.shieldGames} 局保护`);

  for (let i = 1; i <= 4; i++) {
    const u = rp2.update(1150);   // 掉出白银 III 的线（1200）
    const tag = u.event === 'demoted' ? '  真掉段！'
      : u.shielded ? '  被保护拦下' : '';
    console.log(
      `  第 ${i} 次继续掉到 1150 → ${u.info.label}` +
      `，shielded=${u.shielded ? '✓' : '✗'}，剩余保护 ${rp2.shieldGames}${tag}`
    );
  }
  console.log('  ↑ 保护期内分数照掉，段位不动；玩家看到的是"还差 N 局就掉段"，有时间追回来');

  // 赛季重置
  console.log('\n【赛季重置】软重置（保留一半差距）：');
  for (const r of [800, 1200, 1800, 2500, 2800]) {
    const after = softReset(r, { baseline: 1200, factor: 0.5 });
    console.log(
      `  ${String(r).padStart(4)} → ${after.toFixed(0).padStart(4)}` +
      `  ${tierOf(r, cfg).label.padEnd(10)} → ${tierOf(after, cfg).label}`
    );
  }
  console.log('  ↑ 硬重置（全回 1200）会让上赛季王者在低段位屠杀，把新玩家全打跑');
}

// ============================================================
hr('总结：这几个模块的共同点');
// ============================================================
console.log(`
评分与匹配系统的失败模式高度一致 —— 都不抛异常，只是让游戏"感觉不公平"：

  ELO 的取整          低分段玩家发现自己"怎么打都不涨分"
  ELO 的地板          连输玩家掉穿后要赢几十局才回得来 → 弃坑
  Glicko 的迭代写错   给分幅度不对，玩家说不清哪里怪
  匹配只看单边范围    刚进队列的新手被等了很久的大佬捞走 → 当场退出
  匹配兜底没放开      凌晨人少时排队到超时也进不去
  分队拆了黑店        "系统针对我们"
  房间没做房主迁移    剩下的人对着"开始"按钮点了半天
  段位没做掉段保护    "我刚升段就掉回去了"

共同点：每一个都能正常跑、能上线、能通过人工验收，
只有当玩家开始投诉"这游戏匹配有问题"时才会被发现 ——
而那时的归因成本极高，因为没有任何一处报错。

所以这 2361 项测试里，有很大一部分断言的不是"能不能跑"，
而是"公不公平"。
`);
