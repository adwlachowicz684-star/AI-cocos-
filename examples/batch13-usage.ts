/**
 * examples/batch13-usage.ts —— 第十二批插件：游戏外壳
 *
 * 这一批十个模块都不是"玩法"，而是**每个游戏都要有的外壳**：
 *
 * | 模块 | 场景 |
 * |---|---|
 * | Observable | 数值一变，UI 自动刷新 |
 * | CheatCode | 开发期调试指令 |
 * | TimeUtil | 每日刷新 / 倒计时 / 服务器时间 |
 * | UINav | 界面层级与返回键 |
 * | Telemetry | 埋点批量上报 |
 * | Rarity | 掉落权重与展示的单一数据源 |
 * | Stats | 玩家个人数据统计 |
 * | Achievement | 成就解锁 |
 * | Gesture | 划动手势 |
 * | Rebind | 按键重映射 |
 *
 * 【本示例演示的核心价值】
 * 把它们串起来，一个"改键位 → 打一局 → 解锁成就 → 刷新统计 → 上报埋点"
 * 的完整外壳就跑通了，而这些代码换到任何项目里都几乎不用改。
 */

import { ref, computed, batch } from '../observable/Observable';
import { CheatCode } from '../cheatcode/CheatCode';
import { Zones, dayIndex, Countdown, formatDurationCN, ClockSync } from '../timeutil/TimeUtil';
import { UINav } from '../uinav/UINav';
import { Telemetry } from '../telemetry/Telemetry';
import { Rarity, CommonRarity } from '../rarity/Rarity';
import { Stats } from '../stats/Stats';
import { Achievement } from '../achievement/Achievement';
import { recognize, GestureRecognizer, type Point } from '../gesture/Gesture';
import { Rebind, formatBinding } from '../rebind/Rebind';
import { RNG } from '../rng/RNG';

function hr(t: string): void {
  console.log(`\n${'─'.repeat(52)}\n${t}\n${'─'.repeat(52)}`);
}

export async function main(): Promise<void> {
  // ============================================================
  hr('① Observable —— 数值变了，UI 自己知道');
  // ============================================================

  interface HudLike {
    hp: number;
    gold: number;
    ratio: number;
  }
  const hud: HudLike = { hp: 100, gold: 0, ratio: 1 };

  const hp = ref(100);
  const maxHp = ref(100);
  const gold = ref(0);
  const hpRatio = computed(() => hp.value / maxHp.value);

  // 三个 UI 元素各自订阅，不需要任何地方手动调用 refresh()
  hp.subscribe(({ value }) => { hud.hp = value; });
  gold.subscribe(({ value }) => { hud.gold = value; });
  hpRatio.subscribe(({ value }) => { hud.ratio = Math.round(value * 100); });

  console.log('  初始 HUD:', JSON.stringify(hud));

  // 一帧内发生多次修改 → 只通知一次（不会刷三遍 UI）
  let notifyCount = 0;
  gold.subscribe(() => notifyCount++);
  batch(() => {
    hp.value = 80;
    hp.value = 65;
    hp.value = 40;
    gold.value = 120;
  });
  console.log('  受击后 HUD:', JSON.stringify(hud));
  console.log(`  hp 改了 3 次，通知次数 = ${notifyCount}（批量合并生效）`);

  // ============================================================
  hr('② CheatCode —— 开发期的救命开关');
  // ============================================================

  const cc = new CheatCode();
  cc.registerAll([
    { name: 'god', aliases: ['gm'], desc: '无敌模式', run: () => '无敌：开' },
    {
      name: 'setgold',
      desc: '设置金币',
      args: [{ name: 'amount', type: 'int' }],
      run: ({ args }) => {
        gold.value = args[0] as number;
        return `金币 → ${gold.value}`;
      },
    },
    {
      name: 'heal',
      desc: '回血（默认全满）',
      args: [{ name: 'n', type: 'int', optional: true, default: 100 }],
      run: ({ args }) => {
        hp.value = Math.min(maxHp.value, hp.value + (args[0] as number));
        return `回血 → ${hp.value}`;
      },
    },
    { name: 'nuke', desc: '清场', hidden: true, run: () => 'boom' },
  ]);

  for (const cmd of ['heal', 'setgold 999', 'setgold abc', 'gm', 'godd', 'nuke']) {
    const r = cc.execute(cmd);
    console.log(`  ${cmd.padEnd(14)} → ${r.handled ? r.output : r.error}`);
  }
  console.log(`\n  金币现在 = ${gold.value}（被作弊码改掉了，HUD 同步更新）`);

  // ⚠️ 发布前只需这一行
  cc.enabled = false;
  console.log(`  禁用后执行 'setgold 0' → handled=${cc.execute('setgold 0').handled}，金币仍为 ${gold.value}`);

  // ============================================================
  hr('③ TimeUtil —— 每日刷新与倒计时');
  // ============================================================

  const now = Date.now();
  const today = dayIndex(now, Zones.CN);
  console.log(`  今天（北京时区）日序号 = ${today}`);
  console.log(`  距明日 0 点还有 ${(msUntilNextDaySafe() / 3600_000).toFixed(1)} 小时`);

  function msUntilNextDaySafe(): number {
    // 用本地实现避免额外导入
    const DAY = 86_400_000;
    const off = Zones.CN.offsetMinutes * 60_000;
    const shifted = now + off;
    return Math.floor(shifted / DAY) * DAY + DAY - shifted;
  }

  // 服务器时间校准：客户端时钟不准也不影响倒计时
  const clock = new ClockSync({ now: 1000, mono: 0 });
  clock.sync(5000, 1000, 1200);   // RTT=200 → 中点 1100
  console.log(`  ClockSync 偏移量 = ${clock.offset}ms（= 服务器 5000 − 本地中点 1100）`);

  const cd = new Countdown(3 * 3600_000);
  cd.start(now);
  console.log(`  活动倒计时：${formatDurationCN(cd.remaining(now + 90_000))}（3 小时后结束）`);
  console.log(`  已过 1 小时：剩余 ${formatDurationCN(cd.remaining(now + 3600_000))}，进度 ${(cd.progress(now + 3600_000) * 100).toFixed(0)}%`);

  // ============================================================
  hr('④ UINav —— 返回键该关哪一层');
  // ============================================================

  const nav = new UINav<string>({ transitionMs: 100 });
  /**
   * 【注入时钟】
   * 不注入的话转场锁用真实时间，几次 push 在同一毫秒内完成，
   * 后面的 push 全被（正确地）拒绝——示例看起来像坏了。
   * 推进时钟 = 转场动画播完。
   */
  let navClock = 0;
  nav.useClock(() => navClock);
  const advance = () => { navClock += 150; };

  const log: string[] = [];
  for (const screen of ['main', 'bag', 'item']) {
    nav.push(screen);
    log.push(`push ${screen.padEnd(5)} → 当前 ${nav.current}（栈深 ${nav.depth}）`);
    advance();
  }
  log.push(`按返回    → 关闭 ${nav.pop()}，当前 ${nav.current}`);
  advance();
  log.push(`按返回    → 关闭 ${nav.pop()}，当前 ${nav.current}`);
  for (const l of log) console.log('  ' + l);

  // 转场锁：连点不会开出两个同样的界面
  const nav2 = new UINav<string>({ transitionMs: 100 });
  let clk = 0;
  nav2.useClock(() => clk);
  nav2.push('shop');
  const spam = nav2.push('shop');   // 转场中，被忽略
  console.log(`\n  连点两次"商店"：第二次 push 返回 ${spam}（防重复入栈）`);
  clk += 150;
  console.log(`  等转场播完再点：push 返回 ${nav2.push('shop')}（栈深 ${nav2.depth}）`);

  // ============================================================
  hr('⑤ Telemetry —— 埋点不能一条一个请求');
  // ============================================================

  const sent: number[] = [];
  const tm = new Telemetry({
    sender: (b) => { sent.push(b.length); return true; },
    batchSize: 5,
    commonProps: { v: '1.0.0' },
    sampleRate: 1,
  });

  for (let i = 0; i < 12; i++) tm.capture('hit', { i });
  await new Promise((r) => setTimeout(r, 0));
  /**
   * 【为什么要显式 flush】
   * 达到 batchSize 会自动发，但尾部不足一批的那 2 条会一直留在缓冲里，
   * 直到下一次攒够或宿主调用 flush()。
   * 所以退出游戏/切场景前必须 flush 一次。
   */
  await tm.flush();
  console.log(`  采集 12 条 → 实际发送 ${sent.length} 次，每批 ${JSON.stringify(sent)}`);
  console.log(`  统计：${JSON.stringify(tm.stats)}`);
  console.log(`  剩余缓冲：${tm.buffered}（flush 后应为 0）`);

  // 采样必须稳定，否则"开始"上报了"结束"没上报
  const t2 = new Telemetry({ sampleRate: 0.5, sessionId: 'player-42' });
  const stable = new Set<boolean>();
  for (let i = 0; i < 20; i++) stable.add(t2.willSample('level_start'));
  console.log(`  同一会话采样决策种类 = ${stable.size}（必须为 1，否则数据会自相矛盾）`);

  // ============================================================
  hr('⑥ Rarity —— 权重只有一份，不会改漏');
  // ============================================================

  const rarity = new Rarity(CommonRarity);
  const rng = new RNG(20240903);
  const tally: Record<string, number> = {};
  for (let i = 0; i < 20000; i++) {
    const d = rarity.roll(rng);
    tally[d.id] = (tally[d.id] ?? 0) + 1;
  }
  console.log('  20000 次掉落，各稀有度分布：');
  for (const d of rarity.all) {
    const n = tally[d.id] ?? 0;
    const pct = ((n / 20000) * 100).toFixed(1);
    console.log(`    ${d.name.padEnd(4)} 权重 ${String(d.weight).padStart(3)}  → ${String(n).padStart(5)} 次  ${pct.padStart(5)}%  ${'█'.repeat(Math.round(n / 400))}`);
  }
  console.log(`\n  抽到 [普通, 稀有, 传说] 里最好的：${rarity.best(['common', 'rare', 'legendary'])?.name}`);

  // ============================================================
  hr('⑦ Stats —— 玩家数据页');
  // ============================================================

  const stats = new Stats({
    defs: [
      { id: 'kills', agg: 'sum', persist: true },
      { id: 'playtime', agg: 'sum', persist: true },
      { id: 'maxCombo', agg: 'max', persist: true },
      { id: 'killsByWeapon', agg: 'sum', tags: ['weapon'] },
    ],
    derived: {
      kph: (g) => g('kills') / Math.max(1, g('playtime') / 3600_000),
    },
  });

  stats.add('kills', 120);
  stats.add('kills', 80);
  stats.add('playtime', 2 * 3600_000);
  stats.record('maxCombo', 15);
  stats.record('maxCombo', 27);
  stats.record('maxCombo', 9);
  stats.record('killsByWeapon', 150, { weapon: 'sword' });
  stats.record('killsByWeapon', 50, { weapon: 'bow' });

  console.log(stats.describe().split('\n').map((l) => '  ' + l).join('\n'));
  console.log('  按武器:', JSON.stringify(stats.byTag('killsByWeapon', 'weapon')));
  console.log(`  存档（只含 persist）: ${JSON.stringify(stats.exportState())}`);

  // ============================================================
  hr('⑧ Achievement —— 解锁只触发一次');
  // ============================================================

  const state = { kills: 0, boss: 0 };
  const unlocked: string[] = [];
  const ach = new Achievement({
    defs: [
      { id: 'k100', name: '百人斩', target: 100, progress: (c) => c.get('kills'), points: 10 },
      { id: 'k1000', name: '千人斩', target: 1000, progress: (c) => c.get('kills'), points: 30 },
      { id: 'boss', name: '屠龙者', isDone: (c) => c.get('boss') > 0, points: 50 },
      { id: 'hidden', name: '???', hidden: true, requires: ['boss'], isDone: () => false },
    ],
    onUnlock: (d) => unlocked.push(d.name),
  });
  const ctx = { get: (k: string) => (state as unknown as Record<string, number>)[k] ?? 0 };

  state.kills = 150;
  ach.check(ctx);
  state.kills = 1200;
  ach.check(ctx);
  ach.check(ctx);   // 再查一次，不该重复解锁
  state.boss = 1;
  ach.check(ctx);

  console.log(`  解锁：${unlocked.join('、')}`);
  console.log(`  完成度 ${(ach.completion * 100).toFixed(0)}%，成就点 ${ach.points}/${ach.totalPoints}`);

  // ============================================================
  hr('⑨ Gesture —— 划动、画圈、长按');
  // ============================================================

  function swipe(x0: number, y0: number, x1: number, y1: number, dt = 20): Point[] {
    return Array.from({ length: 5 }, (_, i) => ({
      x: x0 + ((x1 - x0) * i) / 4,
      y: y0 + ((y1 - y0) * i) / 4,
      t: i * dt,
    }));
  }

  const cases: Array<[string, Point[]]> = [
    ['快速左滑', swipe(200, 100, 60, 100)],
    ['快速上滑', swipe(100, 200, 100, 60)],
    ['慢速拖动', swipe(200, 100, 60, 100, 120)],
    ['原地轻点', [{ x: 100, y: 100, t: 0 }, { x: 101, y: 100, t: 80 }]],
    ['长按不动', [{ x: 100, y: 100, t: 0 }, { x: 101, y: 100, t: 800 }]],
    ['画一个圈', Array.from({ length: 24 }, (_, i) => ({
      x: 100 + 50 * Math.cos((i / 23) * Math.PI * 2),
      y: 100 + 50 * Math.sin((i / 23) * Math.PI * 2),
      t: i * 16,
    }))],
  ];

  for (const [name, pts] of cases) {
    const g = recognize(pts);
    const extra = g.dir ? ` ${g.dir}` : g.turns !== undefined ? ` ${g.turns.toFixed(2)} 弧度` : '';
    console.log(`  ${name.padEnd(6)} → ${g.kind}${extra}`);
  }

  // 增量识别器：模拟一段连续触摸
  const rec = new GestureRecognizer();
  rec.down({ x: 300, y: 200, t: 0 });
  rec.move({ x: 250, y: 200, t: 20 });
  rec.move({ x: 180, y: 200, t: 40 });
  const g = rec.up({ x: 100, y: 200, t: 60 });
  console.log(`\n  连续触摸轨迹 → ${g.kind} ${g.dir ?? ''}（距离 ${g.distance?.toFixed(0)}px）`);
  console.log(`  up 之后轨迹已清空：active=${rec.active}, points=${rec.pointCount}`);

  // ============================================================
  hr('⑩ Rebind —— 玩家改键位');
  // ============================================================

  const rb = new Rebind(
    { jump: { key: 'space' }, attack: { key: 'j' }, dash: { key: 'shiftleft' } },
    { conflict: 'swap' }
  );

  console.log('  默认键位：');
  for (const a of rb.actions) {
    console.log(`    ${a.padEnd(8)} ${formatBinding(rb.bindingOf(a)!)}`);
  }

  // 玩家把"跳跃"改到 J 上
  rb.bind('jump', { key: 'j' });
  console.log('\n  把跳跃改到 J 之后（swap 策略，攻击自动换到 Space）：');
  for (const a of rb.actions) {
    console.log(`    ${a.padEnd(8)} ${formatBinding(rb.bindingOf(a)!)}`);
  }

  console.log('\n  尝试把菜单绑到 ESC：');
  try {
    rb.bind('menu', { key: 'escape' });
  } catch (e) {
    console.log(`    ✗ ${(e as Error).message}`);
  }

  rb.resetToDefault();
  console.log(`\n  恢复默认后 跳跃 = ${formatBinding(rb.bindingOf('jump')!)}`);
  console.log(`  存档格式：${JSON.stringify(rb.exportState())}`);

  // ============================================================
  hr('串联：它们合在一起是什么');
  // ============================================================

  console.log(`
  这一批不产生任何玩法，但没有它们，"玩法"就卖不出去：

    Observable  → UI 永远不会显示过期数值
    CheatCode   → 调试到第三层不用从头打一遍（且上线一键关掉）
    TimeUtil    → 每日奖励不会因为玩家改系统时间被刷
    UINav       → 返回键行为一致，连点不会开出两个界面
    Telemetry   → 上线后知道玩家卡在第几关（而不是靠猜）
    Rarity      → 改掉落权重只改一处，不会漏掉 UI 颜色
    Stats       → 玩家数据页 / 平衡分析的数据来源
    Achievement → 解锁只弹一次，进度可展示
    Gesture     → 移动端划动手势，阈值统一可测
    Rebind      → 玩家改键，保留键与冲突自动处理

  它们全部零依赖、纯逻辑，换项目直接复制目录即可。
`);
}

main();
