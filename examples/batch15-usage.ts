/**
 * examples/batch15-usage.ts —— 第十四/十五批插件：游戏外壳
 *
 * | 模块 | 场景 |
 * |---|---|
 * | Settings     | 玩家改设置（音量/画质/昵称） |
 * | Accessibility | 开了"减少动效"之后，哪些表现该关 |
 * | Subtitle     | 剧情播放，字幕跟着时间走，可跳过 |
 * | Tutorial     | 首次进入的引导，可跳过但能续上 |
 * | RedDot       | 主界面各入口的红点 |
 * | Currency     | 多货币（金币/钻石/体力）与消费 |
 * | SceneRouter  | 主菜单 → 关卡 → 结算 → 回主菜单 |
 * | ProgressBar  | 血条（分段 + 延迟条） |
 * | HitFeedback  | 打击反馈的时序 |
 * | CameraFollow | 相机跟随与震屏叠加 |
 *
 * 【为什么这些放一起】
 * 它们都是"包裹在玩法外面的那层壳"。
 * 玩法决定游戏好不好玩，外壳决定玩家能不能顺利玩到——
 * 而外壳恰恰是最容易漏、漏了又没人提的部分。
 */

import { Settings } from '../settings/Settings';
import { Accessibility } from '../accessibility/Accessibility';
import { SubtitleTrack, parseSRT } from '../subtitle/Subtitle';
import { Tutorial, type TutorialStep } from '../tutorial/Tutorial';
import { RedDot } from '../reddot/RedDot';
import { CurrencyWallet } from '../currency/CurrencyWallet';
import { SceneRouter } from '../scenerouter/SceneRouter';
import { ProgressBar } from '../progressbar/ProgressBar';
import { HitFeedback } from '../feedback/HitFeedback';
import { CameraFollow, computeCameraBounds } from '../camera/CameraFollow';

function hr(t: string): void {
  console.log(`\n${'─'.repeat(56)}\n${t}\n${'─'.repeat(56)}`);
}

function yn(b: boolean): string {
  return b ? '✓' : '✗';
}

// ============================================================
hr('【1】设置与可访问性 —— 改了设置，表现层要跟着变');
// ============================================================
{
  const settings = new Settings({
    defs: [
      { key: 'bgm', kind: 'number', default: 0.8, min: 0, max: 1, step: 0.1, group: 'audio' },
      { key: 'quality', kind: 'enum', default: 'high', options: ['low', 'mid', 'high'],
        group: 'video', needRestart: true },
      { key: 'reduceMotion', kind: 'bool', default: false, group: 'video' },
      { key: 'nickname', kind: 'string', default: '无名氏', maxLength: 12, group: 'game' },
    ],
  });

  const a11y = new Accessibility();

  // 玩家在设置面板里关掉动态效果
  settings.set('reduceMotion', true);
  settings.set('bgm', 0.5);
  a11y.setReduceMotion(settings.bool('reduceMotion'));

  console.log(`音量 ${settings.num('bgm')}，减少动效 ${yn(a11y.reduceMotion)}`);

  console.log('\n此时各类表现是否该播放：');
  for (const k of ['shake', 'flash', 'transition', 'autoCamera', 'particle'] as const) {
    console.log(`  ${k.padEnd(12)} ${yn(a11y.shouldPlay(k))}`);
  }

  // ⚠️ 关键：震屏是"减弱"而不是"开关"
  a11y.setShakeScale(0.4);
  a11y.setReduceMotion(false);
  console.log(`\n只把震屏调到 40%：10 点震屏 → 实际 ${a11y.shake(10)}`);
  console.log('（完全关掉会让一部分玩家觉得打击感没了，"减弱"是更好的默认）');

  // 非法输入不崩溃
  const err = settings.set('bgm', 2.5);
  console.log(`\n输入 2.5（超出 0~1）：${err ?? '通过'}，值保持 ${settings.num('bgm')}`);
}

// ============================================================
hr('【2】红点 —— 父子自动聚合');
// ============================================================
{
  const rd = new RedDot();

  rd.set('mail/system', 3);
  rd.set('mail/gift', 2);
  rd.set('quest/daily', 1);

  console.log('业务只需要管好叶子：');
  console.log(`  mail/system = ${rd.get('mail/system')}`);
  console.log(`  mail/gift   = ${rd.get('mail/gift')}`);

  console.log('\n父节点自动算出来的：');
  console.log(`  mail  = ${rd.get('mail')}   (3 + 2)`);
  console.log(`  quest = ${rd.get('quest')}   (1)`);
  console.log(`  总入口 = ${rd.get('')}   (3 + 2 + 1)`);

  // 玩家读了一封系统邮件
  rd.add('mail/system', -1);
  console.log(`\n读了一封系统邮件 → mail/system = ${rd.get('mail/system')}，mail = ${rd.get('mail')}`);

  // 前缀不能误匹配
  rd.set('mailbox', 99);
  console.log(`新增 mailbox=99 后，mail 仍然是 ${rd.get('mail')}（mailbox 不该被算进来）`);
}

// ============================================================
hr('【3】多货币 —— 消费的原子性');
// ============================================================
{
  const w = new CurrencyWallet({
    defs: [
      { id: 'gold', name: '金币', initial: 120, cap: 9999 },
      { id: 'gem', name: '钻石', initial: 8 },
      { id: 'energy', name: '体力', initial: 20, cap: 30, precision: 1 },
    ],
  });

  console.log(`初始：金币 ${w.get('gold')}，钻石 ${w.get('gem')}，体力 ${w.get('energy')}`);

  // 买 150 金币的药水 —— 钱不够
  const r = w.spend('gold', 150, 'buy_potion');
  console.log(`\n买 150 金币的药水 → ${r.ok ? '成功' : `失败（${r.reason}，还差 ${r.need}）`}`);
  console.log(`  余额：${w.get('gold')}（失败时一分钱都没扣）`);

  // 买 80 的
  w.spend('gold', 80, 'buy_potion');
  console.log(`\n买 80 金币的药水 → 成功，余额 ${w.get('gold')}`);

  // 浮点：体力小数
  w.set('energy', 0);
  for (let i = 0; i < 10; i++) w.add('energy', 0.1);
  console.log(`\n体力加 10 次 0.1 → ${w.get('energy')}`);
  console.log('  不量化的话会是 0.9999999999999999，表现为"还差一点点就能升级"');

  // 上限
  w.set('energy', 0);
  const applied = w.add('energy', 1000);
  console.log(`\n体力加 1000（上限 30）→ 实际加了 ${applied}，当前 ${w.get('energy')}`);

  // 流水带货币类型
  console.log('\n流水（带货币类型，可以对账）：');
  for (const e of w.ledger.slice(-4)) {
    console.log(`  ${e.id.padEnd(7)} ${e.delta > 0 ? '+' : ''}${String(e.delta).padStart(6)} → ${String(e.after).padStart(5)}  ${e.reason ?? ''}`);
  }
}

// ============================================================
hr('【4】血条 —— 分段与延迟条');
// ============================================================
{
  const hp = new ProgressBar({
    max: 300, value: 300, segments: 3,
    trail: true, trailDelay: 0.35, trailSpeed: 0.5,
    lowThreshold: 0.25, thresholdHysteresis: 0.05,
    easeSpeed: 0.8,
  });
  hp.update(0.016);
  console.log(`满血：第 ${hp.segmentIndex + 1} 段填充 ${(hp.segmentFill * 100).toFixed(0)}%，状态 ${hp.state}`);

  // ⚠️ 关键用例：200/300 应该显示在第 2 段且**填满**
  hp.set(200);
  hp.update(2);
  console.log(`200/300：第 ${hp.segmentIndex + 1} 段填充 ${(hp.segmentFill * 100).toFixed(0)}%`);
  console.log('  用 floor 会显示"第 3 段填充 0%"——三段都在但第三段空着，看着像还有血');

  // 掉血，延迟条
  hp.set(60);
  hp.update(0.016);
  console.log(`\n掉到 60：显示 ${(hp.displayRatio * 100).toFixed(0)}%，残影还在 ${(hp.trailRatio * 100).toFixed(0)}%`);
  for (let i = 0; i < 45; i++) hp.update(0.016);
  console.log(`0.7 秒后：显示 ${(hp.displayRatio * 100).toFixed(0)}%，残影 ${(hp.trailRatio * 100).toFixed(0)}%`);
  console.log(`状态：${hp.state}（低于 25% 变红）`);

  // 回血时残影不该跟着涨
  hp.set(250);
  for (let i = 0; i < 260; i++) hp.update(0.016);   // 跑够时间让缓动追上
  console.log(`\n回血到 250 并等缓动追上：显示 ${(hp.displayRatio * 100).toFixed(0)}%，残影 ${(hp.trailRatio * 100).toFixed(0)}%`);
  console.log('  残影表示"掉血前的量"，回血时必须立刻跟上，否则红色残影会跟着血条一起涨');
}

// ============================================================
hr('【5】打击反馈 —— 顿帧必须用真实时间');
// ============================================================
{
  const fb = new HitFeedback();
  const FRAME = 1 / 60;

  for (const kind of ['light', 'heavy', 'crit', 'parry'] as const) {
    const f = new HitFeedback();
    f.play(kind);
    let frames = 0;
    let scaleDuringStop = 1;
    let o = f.update(FRAME);
    while (o.inHitstop && frames < 500) {
      scaleDuringStop = o.timeScale;       // ← 必须在顿帧**期间**取
      frames++;
      o = f.update(FRAME);
    }
    console.log(
      `${kind.padEnd(6)} 顿帧 ${String((frames * FRAME * 1000).toFixed(0)).padStart(3)}ms` +
      `  期间 timeScale ${scaleDuringStop}`
    );
  }
  console.log('\n注意 timeScale 不是 0 —— 完全冻结会让粒子和 UI 都僵住，看起来像卡死');

  // 连打不叠加：从第一帧就开始计时，才可比
  function hitstopMs(plays: number): number {
    const f = new HitFeedback();
    for (let i = 0; i < plays; i++) f.play('light');
    let n = 0;
    while (f.update(FRAME).inHitstop && n < 500) n++;
    return n * FRAME * 1000;
  }
  const one = hitstopMs(1);
  const ten = hitstopMs(10);
  console.log(`\n单次命中顿帧 ${one.toFixed(0)}ms，10 连击 ${ten.toFixed(0)}ms`);
  console.log('  顿帧没有叠加（否则会是 10 倍时长，玩家以为游戏卡了）');
  console.log('  但震屏仍在累积，连打依旧有爽感');

  // 飘字只在触发帧可取
  const f3 = new HitFeedback();
  f3.play('crit', 1, { damage: 342, isCrit: true });
  f3.update(FRAME);
  const pops = f3.takePopupPayloads();
  console.log(`飘字触发：${pops.length} 个，伤害 ${(pops[0] as { damage: number })?.damage}`);
  for (let i = 0; i < 10; i++) f3.update(FRAME);
  console.log(`10 帧后再取：${f3.takePopupPayloads().length} 个（不会重复生成）`);
  void fb;
}

// ============================================================
hr('【6】相机 —— 死区、边界、震屏叠加');
// ============================================================
{
  const map = { minX: 0, minY: 0, maxX: 2000, maxY: 1200 };
  const cam = new CameraFollow({
    deadZone: { x: 60, y: 40 },
    smoothTime: 0.2,
    lookAheadFactor: 0.4,
    lookAheadMax: { x: 120 },
    bounds: computeCameraBounds(map, 640, 360),
    teleportThreshold: 500,
  });

  cam.snapTo(500, 300);
  console.log(`角色在 (500,300)，相机 (${cam.x.toFixed(0)}, ${cam.y.toFixed(0)})`);

  // 死区内不动
  for (let i = 0; i < 60; i++) cam.update(1 / 60, 530, 320);
  console.log(`角色移到 (530,320)（死区内）→ 相机 (${cam.x.toFixed(0)}, ${cam.y.toFixed(0)})，没动`);

  // 出死区才跟
  for (let i = 0; i < 120; i++) cam.update(1 / 60, 900, 300);
  console.log(`角色移到 (900,300)（出死区）→ 相机 (${cam.x.toFixed(0)}, ${cam.y.toFixed(0)})`);

  // 边界
  for (let i = 0; i < 300; i++) cam.update(1 / 60, 5000, 300);
  console.log(`角色跑到地图外 (5000,300) → 相机被夹在 x=${cam.x.toFixed(0)}（视口右边缘正好是 2000）`);

  // 震屏叠加（⚠️ 要在地图中间演示 —— 贴在边界会被 clamp，看不出效果）
  for (let i = 0; i < 300; i++) cam.update(1 / 60, 1000, 300);
  const beforeX = cam.x;
  const beforeY = cam.y;
  cam.addOffset(12, -5);
  console.log(`\n角色回到地图中间 (1000,300)，相机 (${beforeX.toFixed(0)}, ${beforeY.toFixed(0)})`);
  console.log(`加一次震屏偏移 (12,-5) → (${cam.x.toFixed(0)}, ${cam.y.toFixed(0)})`);
  console.log('  震屏是"叠加"在跟随之上的，衰减后自然回到跟随位置，不会覆盖跟随结果');
  console.log('  （如果此时相机正贴着地图边界，偏移会被夹掉——这也是对的，不该被震出地图）');
}

// ============================================================
hr('【7】字幕 —— 纯查询，天然支持跳转');
// ============================================================
{
  const srt = `1
00:00:00,000 --> 00:00:02,000
【勇者】终于到王城了

2
00:00:02,000 --> 00:00:04,000
卫兵：站住！什么人

3
00:00:03,000 --> 00:00:05,000
（远处传来号角声）`;

  const track = new SubtitleTrack({
    lines: parseSRT(srt),
    speakers: {
      勇者: { name: '勇者', color: '#4CAF50' },
      卫兵: { name: '卫兵', color: '#F44336' },
    },
  });

  for (const t of [500, 2500, 3500]) {
    const act = track.at(t);
    console.log(`\n${t}ms：`);
    for (const a of act) {
      const who = a.speakerLabel ? `[${a.speakerLabel}] ` : '';
      console.log(`  ${who}${a.line.text}  (进度 ${(a.progress * 100).toFixed(0)}%)`);
    }
  }
  console.log('\n注意 3500ms 时同时有两条 —— 画外音和对话重叠是常态，所以返回数组');

  // ⚠️ 在 2500ms 演示：此时下一条（号角，start=3000）确实存在
  console.log(`\n玩家在 2500ms 点跳过 → 跳到 ${track.skipToNext(2500)}ms（号角声那条的开头）`);
  console.log('  跳的是"下一条的开始"而不是"当前这条的结束"');
  console.log(`  在 3500ms 点跳过则停在 ${track.skipToNext(3500)}ms —— 后面没有更晚的条目了`);

  // 纯查询的红利：倒退和变速不需要任何额外代码
  console.log('\n因为是纯查询，倒退/跳播只是把时间传小一点：');
  for (const t of [500, 1500, 4500, 1500]) {
    const a = track.at(t);
    console.log(`  seek ${String(t).padStart(4)}ms → ${a.map((x) => x.line.text).join(' / ') || '（无）'}`);
  }
}

// ============================================================
hr('【8】新手引导 —— 能等待、不卡死、可续上');
// ============================================================
{
  interface Ctx { moved: boolean; attacked: boolean; log: string[] }
  const ctx: Ctx = { moved: false, attacked: false, log: [] };

  const steps: readonly TutorialStep<Ctx>[] = [
    { id: 'welcome', kind: 'tap', text: '欢迎来到王城' },
    {
      id: 'move', kind: 'wait', text: '用摇杆移动一下',
      until: (c) => c.moved, timeoutMs: 8000,
    },
    {
      id: 'attack', kind: 'waitAndTap', text: '攻击一次',
      until: (c) => c.attacked, timeoutMs: 8000, target: 'btn_attack',
    },
    { id: 'done', kind: 'tap', text: '准备好了吗' },
  ];

  const t = new Tutorial<Ctx>({
    steps, context: ctx,
    onChange: (s) => { if (s) ctx.log.push(`→ ${s.id}: ${s.text}`); },
  });

  t.start();
  ctx.log.forEach((l) => console.log(l));

  // wait 步骤忽略点击
  t.tap();
  console.log(`\n${t.current?.id}（wait）—— 点击无效：${yn(t.tap() === false)}`);
  ctx.moved = true;
  t.update(16);
  console.log(`玩家移动了 → 自动推进到 ${t.current?.id}`);

  // waitAndTap
  console.log(`${t.current?.id}（waitAndTap）—— 没攻击时点击无效：${yn(t.tap() === false)}`);
  ctx.attacked = true;
  console.log(`攻击后点击有效：${yn(t.tap() === true)} → ${t.current?.id}`);

  // 超时兜底演示
  const ctx2: Ctx = { moved: false, attacked: false, log: [] };
  const t2 = new Tutorial<Ctx>({
    steps: [{
      id: 'stuck', kind: 'wait', text: '做一个不可能完成的动作',
      until: () => false, timeoutMs: 3000,
    }],
    context: ctx2,
  });
  t2.start();
  t2.update(2999);
  console.log(`\n条件永远不满足，2999ms 时：${t2.current?.id}`);
  t2.update(2);
  console.log(`3001ms 时：${t2.state}（超时自动推进，宁可引导不完整也不能卡死玩家）`);

  // 存档续上：在"还没做完"的时候退出，下次才需要从断点继续
  const ctx4: Ctx = { moved: false, attacked: false, log: [] };
  const t4 = new Tutorial<Ctx>({ steps, context: ctx4 });
  t4.start();
  t4.tap();                                   // 走到 move
  const saved = JSON.parse(JSON.stringify(t4.exportState()));
  console.log(`\n玩家在 "${saved.resumeAt}" 这步退出了游戏`);

  // 新版本发布，玩家回来
  const t5 = new Tutorial<Ctx>({ steps, context: { moved: false, attacked: false, log: [] } });
  t5.importState(saved);
  console.log(`下次进来直接从 ${t5.current?.id} 继续，done = [${t5.done.join(', ')}]`);

  // 极端情况：版本更新后步骤 id 全变了
  const t6 = new Tutorial<Ctx>({
    steps: [{ id: 'new_step_1', kind: 'tap', text: '全新的引导' }],
    context: { moved: false, attacked: false, log: [] },
  });
  t6.importState(saved);
  console.log(`如果版本更新后 id 全变了 → 从 ${t6.current?.id} 重新开始`);
  console.log('  从头来一遍，比对不上号直接崩溃好');
}

// ============================================================
hr('【9】场景路由 —— 一次切换的四个阶段');
// ============================================================
{
  const r = new SceneRouter({ outMs: 300, inMs: 300, initial: 'menu' });
  const seen: string[] = [];

  function settle(): void {
    for (let i = 0; i < 500; i++) {
      if (r.phase === 'load') { r.notifyLoaded(); continue; }
      if (r.phase === 'idle') return;
      r.tick(50);
    }
  }

  // 主菜单 → 关卡
  r.goTo('game', { level: 3 });
  seen.push(`out（旧场景淡出，进度 ${(r.state.progress).toFixed(2)}）`);
  r.tick(300);
  seen.push('load（引擎加载资源）');
  r.notifyLoaded();
  seen.push(`in（新场景淡入，参数 level=${(r.state.params as { level: number })?.level}）`);
  r.tick(300);
  seen.push('idle');
  console.log(seen.join('\n  → '));

  // 连点防护
  r.goTo('result');
  console.log(`\n切换中再点一次 shop → ${r.goTo('shop') ? '接受' : '拒绝'}（防连点加载两次场景）`);
  settle();

  // 返回栈
  console.log(`\n历史：${r.history.join(' > ')}`);
  r.back();
  settle();
  console.log(`按返回键 → ${r.current}，历史 ${r.history.join(' > ')}`);

  // 回程不入栈
  r.go({ to: 'menu', pushHistory: false });
  settle();
  console.log(`结算回主菜单（pushHistory:false）→ 历史 ${r.history.join(' > ')}`);
  console.log('  入栈的话按返回键又会回到结算界面');
}

// ============================================================
hr('总结：这一层壳');
// ============================================================
console.log(`
这 10 个模块都不是"玩法"，但没有一个能省：

  设置 / 可访问性   玩家进游戏第一眼，也是最容易漏改一处的地方
  红点              父子不一致是最常见的 bug 来源
  货币              消费失败必须一分不扣，否则玩家认为你在偷东西
  血条              分段和延迟条各有反直觉的语义
  打击反馈          顿帧用错时间口径会让手感糊掉
  相机              maxSpeed 限制的是滞后距离不是速度
  字幕              纯查询才能支持跳转和变速
  引导              条件永远不满足时必须有超时兜底
  场景路由          连点两次会加载两份场景
  教程/存档         默认值迁移不处理会让老玩家读不进档

共同点：它们的失败都不抛异常，只是让游戏"感觉有点怪"。
`);
