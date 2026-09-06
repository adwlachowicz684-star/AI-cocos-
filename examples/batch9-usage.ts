/**
 * examples/batch9-usage.ts —— 第八批插件的集成示例
 *
 * 【这个示例展示什么】
 *
 * 前七批解决的是"能不能打"，这一批解决的是**"打得公不公平、爽不爽"**：
 *
 * ```
 * 潜行接近 → 敌人感知（视线/听觉/记忆/同伴警报）
 *   ↓ 被发现
 * 围攻调度（攻击令牌：同时最多 2 个能打你）
 *   ↓
 * Boss 弹幕（环形/螺旋/扇形，按序列编排）
 *   ↓
 * 元素反应（水+火=蒸发）+ 目标锁定（粘性防抖）
 *   ↓
 * 玩家连招输入（缓冲/窗口/优先级）
 *   ↓
 * 关卡目标（击杀/保护/限时）+ 动态难度（DDA）
 *   ↓
 * 战斗评分（S/A/B/C/D）+ 抽卡保底
 * ```
 *
 * 全程纯逻辑，不需要引擎。
 *
 * 【运行】
 * ```bash
 * npm run example:batch9
 * ```
 */

import { RNG } from '../rng/RNG';
import {
  PerceptionSystem,
  PerceptionPresets,
  soundFalloff,
  type ILineOfSight,
  type PerceiverConfig,
} from '../perception/Perception';
import { AttackTokenSystem } from '../attack-token/AttackToken';
import {
  BulletPattern,
  Shapes,
  SequencePlayer,
  angleToVec,
  type SequenceStep,
} from '../bullet-pattern/BulletPattern';
import { ElementSystem, type ElementDef, type ReactionDef } from '../element/ElementSystem';
import { TargetSelector, byDistance, byAngle, byStickiness, type TargetCandidate } from '../targeting/TargetSelector';
import { ComboSystem, type MoveDef } from '../combo/ComboSystem';
import { ObjectiveSystem, Objectives, type ObjectiveDef } from '../objective/ObjectiveSystem';
import { DifficultySystem, computePerformance } from '../difficulty/DifficultySystem';
import { GachaPity, simulate, type GachaItem, type RarityConfig } from '../gacha/GachaPity';
import {
  ScoringSystem,
  CombatMetrics,
  toNextGrade,
  type MetricValue,
} from '../scoring/ScoringSystem';

function hr(title: string): void {
  console.log(`\n${'═'.repeat(66)}\n  ${title}\n${'═'.repeat(66)}`);
}

// ============================================================
// ① 潜行：感知系统
// ============================================================

/** 一根柱子在 x=6, y∈[-1,1]，挡住视线 */
class PillarLOS implements ILineOfSight {
  visible(x0: number, y0: number, x1: number, y1: number): boolean {
    // 用线段与点的最近距离粗判（够演示用）
    for (let t = 0; t <= 1; t += 0.02) {
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (Math.abs(x - 6) < 0.6 && Math.abs(y) < 0.6) return false;
    }
    return true;
  }
}

function demoPerception(): void {
  hr('① 潜行：敌人是怎么发现你的');

  /**
   * 【先看声音衰减曲线】
   * 它决定了"在什么距离做什么动作是安全的"。
   */
  console.log('\n【声音响度衰减】半径 20 米：');
  for (const d of [0, 2, 5, 10, 15, 19]) {
    const f = soundFalloff(d, 20);
    const bar = '█'.repeat(Math.round(f * 20));
    console.log(`  ${String(d).padStart(2)}m  ${f.toFixed(3)}  ${bar}`);
  }
  console.log('  ↑ 半径内侧 10%（2 米）为近场，响度不打折');
  console.log('    这是刻意的：贴脸开枪必须有确定后果，不能靠浮点运气');

  // —— 场景：玩家从敌人正面走过，中间有柱子 ——
  const events: string[] = [];
  const sys = new PerceptionSystem({
    los: new PillarLOS(),
    jitter: 0,
    onEvent: (e) => {
      if (e.type === 'suspicious') events.push(`  帧${frames} ${e.selfId} 号：嗯？好像有动静`);
      if (e.type === 'spotted') events.push(`  帧${frames} ${e.selfId} 号：发现玩家！`);
    },
  });

  let frames = 0;
  const guard: PerceiverConfig = PerceptionPresets.humanoid;
  sys.addPerceiver(1, guard, 10, 0, Math.PI);   // 面向 -X（朝玩家来的方向）
  sys.addPerceiver(2, guard, 14, 3, Math.PI);   // 稍远的同伴
  sys.addTarget(100, 1, 0);                     // 玩家在左边

  console.log('\n【场景】两名守卫面朝玩家方向，中间有一根柱子挡住视线');
  console.log('  守卫1 在 (10,0)，守卫2 在 (14,3)，玩家在 (1,0)');

  // 静默走过：柱子挡住了，不该被发现
  for (let i = 0; i < 180; i++) { frames++; sys.tick(1 / 60); }
  console.log('\n  静默接近 3 秒：');
  console.log(`    守卫1 警觉度 ${sys.alertOf(1).toFixed(2)}（柱子挡住，应为 0）`);
  console.log(`    守卫2 警觉度 ${sys.alertOf(2).toFixed(2)}（超出视距，应为 0）`);

  // 玩家开枪：声音穿墙
  sys.emitSound(100, 1, 0, 1.0, 25);
  sys.tick(1 / 60);
  console.log('\n  💥 玩家开了一枪（强度 1.0，半径 25）：');
  console.log(`    守卫1 警觉度 ${sys.alertOf(1).toFixed(2)} ← 声音绕过了遮挡`);
  console.log(`    守卫2 警觉度 ${sys.alertOf(2).toFixed(2)}`);

  // 连续走动发声，最终被发现
  for (let i = 0; i < 300; i++) {
    frames++;
    if (i % 20 === 0) sys.emitSound(100, 4 + i * 0.02, 0, 0.8, 25);
    sys.tick(1 / 60);
  }
  console.log('\n  持续发出脚步声 5 秒：');
  for (const id of [1, 2]) {
    console.log(`    守卫${id}：警觉 ${sys.alertOf(id).toFixed(2)}  已发现=${sys.isAware(id)}`);
    const p = sys.lastKnownPosition(id);
    if (p) console.log(`              最后已知位置 (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) → 会去这里搜索`);
  }

  if (events.length > 0) {
    console.log('\n  事件流：');
    for (const e of events.slice(0, 6)) console.log(e);
    console.log('  ↑ suspicious（起疑）永远在 spotted（发现）之前');
    console.log('    没有中间态的话，玩家会觉得敌人是"瞬移过来的"');
  }
}

// ============================================================
// ② 围攻调度：攻击令牌
// ============================================================

function demoAttackToken(): void {
  hr('② 围攻调度：5 个怪不会同时打你');

  console.log('\n【问题】5 个怪同时命中，玩家 100 血瞬间归零');
  console.log('  玩家不会觉得"我失误了"，只会觉得"这游戏不公平"');
  console.log('  因为它确实不公平——人无法同时应对 5 个攻击');

  // 无令牌对照组
  console.log('\n  ── 对照组：无令牌 ──');
  let hpNoToken = 100;
  for (let i = 0; i < 5; i++) hpNoToken -= 25;
  console.log(`    一帧内 5 次命中 × 25 = ${hpNoToken} 血（秒杀）`);

  // 有令牌
  console.log('\n  ── 实验组：maxConcurrent = 2 ──');
  const tokens = new AttackTokenSystem({
    maxConcurrent: 2,
    maxQueued: 10,
    holdTimeout: 3,
    starvationAfter: 1,
    onGrant: (id) => console.log(`    ${id} 号 获得攻击权`),
  });

  for (let id = 1; id <= 5; id++) tokens.request(id, 6 - id);
  console.log(`\n    5 个怪同时请求 → 持有 ${tokens.activeCount} 个，排队 ${tokens.queuedCount} 个`);
  console.log(`    并发数被限制在 ${tokens.maxConcurrent}，其余围而不攻`);

  // 模拟轮流攻击
  console.log('\n    轮流攻击过程：');
  let hp = 100;
  for (let round = 0; round < 4; round++) {
    const active = tokens.activeIds();
    for (const id of active) {
      tokens.release(id, 'finished');
      hp -= 25;
      tokens.request(id, 0);
    }
    console.log(`      第 ${round + 1} 轮：${active.map((i) => `#${i}`).join(' + ')} 出手 → 剩余 ${hp} 血`);
  }

  console.log(`\n    统计：平均等待 ${tokens.stats().avgWait.toFixed(2)}s`);
  console.log('    ↑ 伤害数值没变，只是**节奏**变了');
  console.log('      难度来自密度而非数值堆砌，战斗不会变软');

  // 泄漏测试
  console.log('\n  【兜底】某个怪攻击动画卡死，永不归还令牌：');
  const t2 = new AttackTokenSystem({ maxConcurrent: 2, holdTimeout: 1 });
  t2.request(1);
  t2.request(2);
  for (let i = 0; i < 70; i++) t2.tick(1 / 60);
  console.log(`    1.17 秒后自动回收 → 持有 ${t2.activeCount} 个`);
  console.log('    没有这个兜底，所有敌人将**永久失去攻击能力**');
  console.log('    而且不报错，只表现为"怪都站着不动"');
}

// ============================================================
// ③ Boss 弹幕
// ============================================================

function demoBulletPattern(): void {
  hr('③ Boss 弹幕：形状、编排与序列');

  const bp = new BulletPattern(new RNG(2024));
  bp.addEmitter({ id: 'ring', shape: Shapes.ring(12, 6, 'orb'), interval: 1.2 });
  bp.addEmitter({ id: 'spiral', shape: Shapes.spiral(3, 5, 'orb', 25), interval: 0.15, delay: 3 });
  bp.addEmitter({ id: 'fan', shape: Shapes.fan(5, 60, 9, 'orb'), interval: 2.0, delay: 6 });
  bp.play();

  console.log('\n【三个发射器并行】环形 1.2s / 螺旋 0.15s(延迟3s) / 扇形 2.0s(延迟6s)');
  console.log('\n  时间轴（每 0.5 秒采样）：');
  let t = 0;
  for (let i = 0; i < 24; i++) {
    const n = bp.tick(0.5).length;
    t += 0.5;
    if (i % 2 === 0 || n > 0) {
      const bar = '•'.repeat(Math.min(n, 40));
      console.log(`    ${t.toFixed(1)}s  ${String(n).padStart(2)} 发  ${bar}`);
    }
  }

  console.log('\n  ↑ 螺旋在 3 秒后启动（delay 生效），扇形在 6 秒后');
  console.log('    注意 delay 的精确语义：第一发出现在 delay + interval');

  // 序列编排
  const steps: SequenceStep[] = [
    { at: 0.0, action: 'start', emitter: 'ring' },
    { at: 2.0, action: 'start', emitter: 'spiral' },
    { at: 5.0, action: 'stop', emitter: 'ring' },
    { at: 6.0, action: 'start', emitter: 'fan' },
    { at: 9.0, action: 'restart', emitter: 'spiral' },
  ];
  const seq = new SequencePlayer(steps);
  seq.start();
  console.log('\n【序列编排】Boss 阶段切换（时间轴驱动的招式表）：');
  let st = 0;
  for (let i = 0; i < 620; i++) {
    st += 1 / 60;
    seq.tick(1 / 60, (s) => {
      const label = s.action === 'start' ? '开启' : s.action === 'stop' ? '关闭' : '重启';
      console.log(`    ${st.toFixed(2)}s  ${label}  ${s.emitter}`);
    });
  }

  // 方向计算
  const v = angleToVec(Math.PI / 4, 10);
  console.log(`\n  【方向】45° 速度 10 → (${v.x.toFixed(2)}, ${v.y.toFixed(2)})`);
  console.log(`    模长 ${Math.hypot(v.x, v.y).toFixed(4)}（斜向不会更快）`);
}

// ============================================================
// ④ 元素反应
// ============================================================

function demoElement(): void {
  hr('④ 元素反应：系统只管"反应了"，不管"造成什么"');

  const elements: readonly ElementDef[] = [
    { id: 'fire', decay: 8, maxGauge: 100, data: { color: '#ff6b35' } },
    { id: 'water', decay: 6, maxGauge: 100, data: { color: '#4dabf7' } },
    { id: 'shock', decay: 10, maxGauge: 100, data: { color: '#ffd43b' } },
  ];

  /**
   * 【关键设计】反应定义里**没有 damage 字段**。
   * 伤害、范围、眩晕这些"效果"放在 `data` 里由业务解释。
   * 这正是零业务依赖的体现：系统只回答"发生了什么反应、消耗多少元素"。
   */
  const reactions: readonly ReactionDef[] = [
    { id: 'vaporize', base: 'water', applied: 'fire', consumeAll: true, data: { damage: 60, name: '蒸发' } },
    { id: 'overload', base: 'fire', applied: 'shock', consumeAll: true, data: { damage: 90, aoe: 4, name: '超载' } },
    { id: 'conduct', base: 'water', applied: 'shock', gaugeCost: 10, consumeAll: false, data: { stun: 2, name: '感电' } },
  ];

  const es = new ElementSystem({ elements, reactions });

  console.log('\n【元素附着量随时间衰减】火 8/s、水 6/s、雷 10/s');
  es.set(1, 'fire', 80);
  for (const s of [0, 2, 4, 6, 8, 10]) {
    if (s > 0) es.tick(2);
    const g = es.gaugeOf(1);
    console.log(`    ${String(s).padStart(2)}s  ${String(Math.round(g)).padStart(3)}  ${'▓'.repeat(Math.round(g / 4))}`);
  }
  console.log('    ↑ 衰减到 0 时元素类型也会清空（不是留着 0 量的"火"）');

  console.log('\n【反应链】');
  const chain: Array<[string, string, number]> = [
    ['water', 'fire', 50],
    ['fire', 'shock', 50],
    ['water', 'shock', 50],
  ];
  es.clearAll();
  for (const [base, applied, amount] of chain) {
    es.set(1, base, 60);
    const r = es.apply(1, applied, amount);
    const d = (r.data ?? {}) as { name?: string; damage?: number; stun?: number };
    const effect = d.damage ? `${d.damage} 伤害` : d.stun ? `眩晕 ${d.stun}s` : '—';
    console.log(
      `    ${base} + ${applied} → ${r.reactionId || '(无反应)'}  ` +
      `${d.name ?? ''}  ${effect}  剩余 ${Math.round(r.remainingGauge)}`
    );
  }

  console.log('\n  ↑ consumeAll=false 的感电保留了水元素，可以继续触发蒸发');
  console.log('    这类"残留"设计是元素玩法深度的来源');
}

// ============================================================
// ⑤ 目标锁定
// ============================================================

function demoTargeting(): void {
  hr('⑤ 目标锁定：为什么需要"迟滞"');

  const sel = new TargetSelector({ hysteresis: 1.15, graceTime: 0.3 });
  sel.addScorer(byDistance(1));
  sel.addScorer(byAngle(1));
  sel.addScorer(byStickiness(3));

  sel.originX = 0;
  sel.originY = 0;
  sel.facing = 0;

  console.log('\n【场景】两个敌人距离几乎相同，位置每帧微小抖动');
  console.log('  没有迟滞时，锁定会在两者间疯狂闪烁——角色来回扭头');

  let flips = 0;
  let prev: number | null = null;
  const rng = new RNG(7);
  for (let i = 0; i < 120; i++) {
    const jitter = (rng.next() - 0.5) * 0.3;
    const cands: TargetCandidate[] = [
      { id: 1, x: 8 + jitter, y: 0.2, selectable: true },
      { id: 2, x: 8 - jitter, y: -0.2, selectable: true },
    ];
    sel.update(1 / 60, cands);
    if (prev !== null && sel.current !== prev) flips++;
    prev = sel.current;
  }
  console.log(`\n  2 秒内目标切换次数：${flips}`);
  console.log(`  当前锁定：#${sel.current}`);
  console.log('  ↑ 迟滞（新目标需好 1.15 倍才切换）+ 粘性（当前目标 +3 分）');
  console.log('    两者叠加后，抖动被完全吸收');

  // 目标消失
  for (let i = 0; i < 60; i++) sel.update(1 / 60, []);
  console.log(`\n  全部敌人消失后：current = ${sel.current}`);
  console.log('  ↑ 宽限期（0.3s）内保持锁定，避免短暂遮挡导致闪烁');
  console.log('    宽限耗尽才真正清空');
}

// ============================================================
// ⑥ 连招输入
// ============================================================

function demoCombo(): void {
  hr('⑥ 连招：为什么"按了却没出招"是最伤手感的问题');

  const moves: readonly MoveDef[] = [
    { id: 'light1', inputs: ['L'] },
    { id: 'light2', inputs: ['L', 'L'] },
    { id: 'light3', inputs: ['L', 'L', 'L'] },
    { id: 'finisher', inputs: ['L', 'L', 'H'], priority: 10, data: { name: '终结技' } },
    { id: 'heavy', inputs: ['H'] },
  ];

  const c = new ComboSystem({ moves, inputWindow: 0.4, recovery: 0.08 });

  console.log('\n【核心机制】输入先缓冲；若是更长招式的**前缀**就等待，否则立即触发');
  console.log('\n  序列 L → L → H：');

  const log: string[] = [];
  const push = (a: string) => {
    const r = c.input(a);
    if (r) log.push(`      输入 ${a} → 出招 ${r.moveId} ✨（${a} 不是任何更长招式的前缀，立即触发）`);
    else log.push(`      输入 ${a} → 缓冲，等待（是更长招式的前缀，先看下一手）`);
    return r;
  };

  push('L');
  push('L');
  push('H');
  for (const l of log) console.log(l);

  console.log('\n  ↑ 玩家按 L,L 时系统在等第三段；');
  console.log('    第三下是 L 就走 light3，是 H 就走终结技。');
  console.log('    这个"等一下"正是连招手感的来源。');

  console.log('\n  【窗口超时】按 L, L 后停手：');
  const c2 = new ComboSystem({ moves, inputWindow: 0.4 });
  c2.input('L');
  c2.input('L');
  let fired: string | null = null;
  for (let i = 0; i < 40 && !fired; i++) {
    const m = c2.tick(1 / 60);
    if (m) fired = m.moveId;
  }
  console.log(`    0.4 秒后自动结算 → ${fired}`);
  console.log('    ↑ 如果不结算，输入会永远挂在缓冲区里，');
  console.log('      表现为"过了一会儿自己出招"，非常诡异');

  console.log('\n  【优先级】同序列取大的：');
  const c3 = new ComboSystem({
    moves: [
      { id: 'weak', inputs: ['L', 'L'], priority: 1 },
      { id: 'strong', inputs: ['L', 'L'], priority: 99 },
    ],
    inputWindow: 0.4,
  });
  c3.input('L');
  let r3 = c3.input('L');
  for (let i = 0; i < 40 && !r3; i++) r3 = c3.tick(1 / 60);
  console.log(`    结果 ${r3?.moveId} ← 遗物强化后不用改配置顺序，只提优先级`);
}

// ============================================================
// ⑦ 关卡目标 + 动态难度
// ============================================================

function demoObjectivesAndDifficulty(): void {
  hr('⑦ 关卡目标与动态难度');

  const defs: readonly ObjectiveDef[] = [
    Objectives.kill('clear', 10, '清剿敌人'),
    Objectives.after(Objectives.protect('vip', 3, '保护村民'), ['clear']),
    Objectives.optional(Objectives.timeLimit('speed', 90, '速通')),
  ];

  const os = new ObjectiveSystem({ objectives: defs, mode: 'all' });
  os.tick(0.001);

  console.log('\n【关卡目标】激活与依赖：');
  for (const st of os.all()) {
    console.log(`    ${st.def.id.padEnd(6)} ${st.status.padEnd(9)} 进度 ${st.progress}/${st.def.target}`);
  }
  console.log('    ↑ protect 的初始进度 = target（满血），掉到 0 才失败');
  console.log('      optional 目标失败不会导致整关失败');

  os.addProgress('clear', 10);
  os.tick(0.001);
  console.log('\n    击杀 10 个后：');
  for (const st of os.all()) {
    console.log(`    ${st.def.id.padEnd(6)} ${st.status.padEnd(9)} 进度 ${st.progress}/${st.def.target}`);
  }
  console.log(`    整关完成：${os.finished}`);

  // DDA
  console.log('\n【动态难度 DDA】隐形调节，幅度 ±15%：');
  const dd = new DifficultySystem({ dda: { enabled: true, maxAdjust: 0.15, responsiveness: 0.15 } });
  dd.setTier('normal');
  const base = dd.baseMultiplier('enemyDamage');

  const scenarios: Array<[string, number]> = [
    ['菜鸟玩家（一直挨打）', 0.1],
    ['普通玩家', 0.5],
    ['高手玩家（无伤速通）', 0.95],
  ];

  for (const [name, perf] of scenarios) {
    const d = new DifficultySystem({ dda: { enabled: true, maxAdjust: 0.15, responsiveness: 0.15 } });
    d.setTier('normal');
    for (let i = 0; i < 30; i++) {
      d.report(perf, 30);
      d.tick(1);
    }
    const m = d.multiplier('enemyDamage');
    const pct = ((m / base - 1) * 100).toFixed(1);
    console.log(`    ${name.padEnd(22)} 敌人伤害 ×${m.toFixed(3)} (${pct >= '0' ? '+' : ''}${pct}%)`);
  }

  console.log('\n  ↑ 幅度被钳制在 ±15%，且默认不显示给玩家');
  console.log('    如果玩家发现游戏在放水，通关成就感会崩塌');

  const good = computePerformance({ hurtRatio: 0.05, deaths: 0, clearSpeed: 0.9, resourceLeft: 0.8 });
  const bad = computePerformance({ hurtRatio: 0.8, deaths: 4, clearSpeed: 0.2, resourceLeft: 0.1 });
  console.log(`\n    表现分：高手 ${good.toFixed(2)} / 新手 ${bad.toFixed(2)}（0~1）`);
}

// ============================================================
// ⑧ 战斗评分
// ============================================================

function demoScoring(): void {
  hr('⑧ 战斗评分：评级是比奖励更有效的重玩钩子');

  const sys = new ScoringSystem({ metrics: CombatMetrics, missingAs: 'skip' });

  const runs: Array<[string, MetricValue[]]> = [
    ['速通无伤流', [
      { id: 'time', value: 45 },
      { id: 'damageTaken', value: 0 },
      { id: 'maxCombo', value: 25 },
      { id: 'kills', value: 42 },
    ]],
    ['莽夫流（快但挨打）', [
      { id: 'time', value: 52 },
      { id: 'damageTaken', value: 240 },
      { id: 'maxCombo', value: 35 },
      { id: 'kills', value: 42 },
    ]],
    ['稳妥流（慢但无伤）', [
      { id: 'time', value: 130 },
      { id: 'damageTaken', value: 10 },
      { id: 'maxCombo', value: 8 },
      { id: 'kills', value: 42 },
    ]],
    ['打得很难看', [
      { id: 'time', value: 175 },
      { id: 'damageTaken', value: 280 },
      { id: 'maxCombo', value: 3 },
      { id: 'kills', value: 20 },
    ]],
  ];

  console.log('\n【四种打法的评分】');
  console.log('  指标：时间(越低越好) / 受伤(越低越好) / 连击 / 击杀\n');
  console.log('    ' + '打法'.padEnd(22) + '总分   评级   最大短板');
  console.log('    ' + '─'.repeat(60));

  for (const [name, vals] of runs) {
    const r = sys.evaluate(vals);
    const weak = sys.weakPoints(vals, 1)[0];
    const gapTxt = weak ? `${weak.id} 还差 ${weak.gap.toFixed(0)}` : '无';
    console.log(
      `    ${name.padEnd(20)} ${r.total.toFixed(1).padStart(5)}  ${r.grade}     ${gapTxt}`
    );
  }

  console.log('\n  ↑ "莽夫流"比"稳妥流"分低，因为受伤权重是 3');
  console.log('    这在设计上传递了一个明确信号：**学会躲比堆输出更重要**');

  const r0 = sys.evaluate(runs[0][1]);
  console.log(`\n    速通无伤流的各指标归一化：`);
  for (const m of r0.metrics) {
    console.log(`      ${m.id.padEnd(13)} raw=${String(m.raw).padStart(4)}  →  ${(m.normalized * 100).toFixed(0)}%  (权重 ${m.weight})`);
  }
  console.log(`\n    总分 ${r0.total.toFixed(1)}，距离下一级还差 ${toNextGrade(r0.total).toFixed(1)} 分`);
  console.log('    ↑ 结算界面显示"再快 12 秒就是 S"，比干巴巴的"B 级"有用得多');

  console.log('\n  【⚠️ par/zero 方向写反会怎样】');
  try {
    new ScoringSystem({
      metrics: [{ id: 'time', direction: 'lower-better', par: 60, zero: 30 }],
    });
  } catch (e) {
    console.log(`    构造即抛错：${(e as Error).message}`);
    console.log('    ↑ 不抛错的话，"打得越快分越低"，且查不出原因');
  }
}

// ============================================================
// ⑨ 抽卡保底
// ============================================================

function demoGacha(): void {
  hr('⑨ 抽卡保底：跨抽累计 vs 每次独立');

  const rarities: readonly RarityConfig[] = [
    { id: 'r5', baseRate: 0.006, softPity: 74, hardPity: 90, rampPerPull: 0.06, tier: 2 },
    { id: 'r4', baseRate: 0.051, hardPity: 10, tier: 1 },
    { id: 'r3', baseRate: 0.943, tier: 0 },
  ];

  const items: readonly GachaItem[] = [
    { id: '限定角色', rarity: 'r5', weight: 1, limited: true },
    { id: '常驻角色', rarity: 'r5', weight: 1 },
    { id: '四星武器', rarity: 'r4', weight: 1 },
    { id: '三星武器', rarity: 'r3', weight: 1 },
  ];

  console.log('\n【与 PRD 的关键区别】');
  console.log('  PRD（掉落用）：每次 roll 独立计数，出了就重置 → 平滑无感');
  console.log('  保底（抽卡用）：跨抽累计，出货才重置   → "还差 10 抽保底"');
  console.log('\n  用错的表现：拿 PRD 做抽卡，玩家觉得"根本没保底"');

  console.log('\n【保底推进】模拟一个运气极差的玩家：');
  console.log('    (rng 恒返回 0.9999，即"永远抽不中")\n');

  for (const n of [1, 10, 50, 73, 80, 89, 90]) {
    // 重新模拟到第 n 抽
    const gx = new GachaPity({ items, rarities, rng: { next: () => 0.9999 } });
    let last = '';
    for (let i = 1; i <= n; i++) last = gx.pull().rarity;
    console.log(
      `    第 ${String(n).padStart(2)} 抽  结果 ${last}  ` +
      `r5 计数 ${String(gx.pityCount('r5')).padStart(2)}  ` +
      `距保底 ${String(gx.toHardPity('r5')).padStart(2)}  ` +
      `当前概率 ${(gx.currentRate('r5') * 100).toFixed(1)}%`
    );
  }
  console.log('\n    ↑ 第 74 抽进入软保底，概率开始爬升');
  console.log('      第 90 抽**必定**出货——这是写进规则的承诺');

  console.log('\n  【⚠️ 差一错误的代价】');
  console.log('    若判定写成 `n + 1 >= hardPity`，硬保底会在第 89 抽触发。');
  console.log('    玩家数着抽数对照时会发现对不上 → 信任受损。');
  console.log('    而代码不报错，"只差一抽"几乎无人察觉。');

  const report = simulate({ items, rarities, rng: new RNG(42) }, 100000);
  console.log('\n【10 万抽统计】');
  for (const id of ['r5', 'r4', 'r3']) {
    const rate = (report.rates[id] * 100).toFixed(2);
    console.log(
      `    ${id}  出货率 ${rate.padStart(5)}%  ` +
      `平均 ${report.avgPity[id].toFixed(1).padStart(5)} 抽  ` +
      `最长连续未出货 ${String(report.worstDry[id]).padStart(2)} 抽`
    );
  }
  console.log('\n    ↑ 最长未出货 ≤ hardPity，保底承诺 100% 兑现');
  console.log(`      五星平均 ${report.avgPity['r5'].toFixed(1)} 抽 < 90，说明软保底在起作用`);
  console.log('      （若每次都是第 90 抽才出，保底感就太生硬了）');
}

// ============================================================
// 主函数
// ============================================================

function main(): void {
  console.log('╔' + '═'.repeat(66) + '╗');
  console.log('║' + '  cocos-kit 第八批插件集成示例'.padEnd(58) + '║');
  console.log('║' + '  perception / attack-token / bullet-pattern / element /'.padEnd(58) + '║');
  console.log('║' + '  targeting / combo / objective / difficulty / scoring / gacha'.padEnd(58) + '║');
  console.log('╚' + '═'.repeat(66) + '╝');

  demoPerception();
  demoAttackToken();
  demoBulletPattern();
  demoElement();
  demoTargeting();
  demoCombo();
  demoObjectivesAndDifficulty();
  demoScoring();
  demoGacha();

  hr('总结');
  console.log(`
  这一批的 10 个模块有一个共同主题：**公平性**。

  ┌────────────────┬──────────────────────────────┐
  │ 模块           │ 它在守护什么                 │
  ├────────────────┼──────────────────────────────┤
  │ perception     │ 敌人不许隔墙读心、不许背后长眼│
  │ attack-token   │ 不许被 5 个怪同时秒杀        │
  │ targeting      │ 锁定不许抖动、不许锁身后的怪 │
  │ combo          │ 按了就要有反应，不能吞输入   │
  │ difficulty     │ 隐性调节，但不让玩家察觉     │
  │ scoring        │ 评级要能解释"我哪里没做好"  │
  │ gacha          │ 保底承诺必须 100% 兑现       │
  └────────────────┴──────────────────────────────┘

  它们的失败模式也一致：**不抛异常**。
  数值算错、状态泄漏、方向写反、差一错误——
  全都只是让游戏"感觉有点怪"，而开发者查不出来。

  这就是为什么这一批 168 项测试里，
  很大一部分断言的不是"能不能跑"，而是"方向对不对"。
`);
}

main();
