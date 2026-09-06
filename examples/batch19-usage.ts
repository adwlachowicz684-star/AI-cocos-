/**
 * examples/batch19-usage.ts —— 第十八批插件：表现与运维层
 *
 * | 模块 | 场景 |
 * |---|---|
 * | AudioManager | Boss 战：30 个音效同时请求，预警音会不会被挤掉？ |
 * | BGMStack     | 血线降到 30%，音乐从"探索"切到"决战" |
 * | Cutscene     | Boss 出场演出，玩家按跳过 |
 * | Transition   | 打完收工，切回主城 |
 * | Minimap      | 主城里看队友在哪（旋转 vs 北朝上） |
 * | Builder      | 在主城盖房子：旋转、返还、升级 |
 * | AutoQuality  | 战斗中掉帧，画质自动降级 |
 * | DiagPack     | 崩了，生成一份脱敏的诊断包 |
 *
 * 运行：npm run example:batch19
 */

import { AudioManager, PRIORITY } from '../audio/AudioManager';
import { BgmStack } from '../audio/BGMStack';
import { Cutscene, Timeline } from '../cutscene/Cutscene';
import { Transition, overlayStyle } from '../transition/Transition';
import { Minimap } from '../minimap/Minimap';
import {
  Builder, type Blueprint, type ResourceWallet,
} from '../builder/Builder';
import { AutoQuality } from '../autoquality/AutoQuality';
import { DiagCollector } from '../diagpack/DiagPack';

// ==================== 小工具 ====================

function h1(t: string): void {
  console.log('\n' + '═'.repeat(58));
  console.log('  ' + t);
  console.log('═'.repeat(58));
}

function h2(t: string): void {
  console.log('\n▸ ' + t);
}

/** 测试用钱包 */
class Wallet implements ResourceWallet {
  private readonly _b = new Map<string, number>();
  constructor(init: Record<string, number>) {
    for (const [k, v] of Object.entries(init)) this._b.set(k, v);
  }
  get(id: string): number { return this._b.get(id) ?? 0; }
  spend(costs: Record<string, number>): boolean {
    for (const [k, v] of Object.entries(costs)) if (this.get(k) < v) return false;
    for (const [k, v] of Object.entries(costs)) this._b.set(k, this.get(k) - v);
    return true;
  }
  gain(g: Record<string, number>): void {
    for (const [k, v] of Object.entries(g)) this._b.set(k, this.get(k) + v);
  }
}

// ==================== 1. 音频 ====================

function demoAudio(): void {
  h1('1. AudioManager · 30 个音效同时请求，预警音还在吗？');

  h2('场景：Boss 放了一记大招，瞬间有 30 个音效请求');
  const a = new AudioManager({ maxVoices: 8, maxSameSoundPerFrame: 3 });

  let t = 0;
  // 27 个爆炸音效（低优先级）
  for (let i = 0; i < 27; i++) {
    a.play('explosion', { priority: PRIORITY.HIGH });
    a.tick(5);
    t += 5;
  }
  console.log(`  27 个爆炸音后：活跃 ${a.activeCount}/8，被拒 ${a.stats.rejected}`);

  h2('此时 Boss 抬手，要走一个预警音');
  const warn = a.play('telegraph_warning', { priority: PRIORITY.CRITICAL });
  console.log(`  预警音是否排上队：${warn !== null ? '✓ 是' : '✗ 否'}`);
  console.log(`  抢占了 ${a.stats.evicted} 个低优先级音效`);
  console.log('');
  console.log('  ↑ 这就是 CRITICAL 优先级存在的理由。');
  console.log('    通道是 8 个，爆炸音已经占满，');
  console.log('    如果没有优先级，预警音会被**静默丢弃**——');
  console.log('    玩家看到 Boss 抬手却没有听到预警，');
  console.log('    然后死了，然后认为游戏不公平。');

  h2('⚠️ 对照：如果把预警音的优先级设成 LOW');
  const b = new AudioManager({ maxVoices: 8, maxSameSoundPerFrame: 3 });
  for (let i = 0; i < 8; i++) {
    b.play('explosion', { priority: PRIORITY.HIGH });
    b.tick(5);
  }
  const low = b.play('telegraph_warning', { priority: PRIORITY.LOW });
  console.log(`  预警音是否排上队：${low !== null ? '是' : '✗ 否（被拒）'}`);

  h2('统计：排查"音效听不见了"时第一眼看的东西');
  console.log(a.describe().split('\n').map((l) => '  ' + l).join('\n'));
}

// ==================== 2. 分层音乐 ====================

function demoBgm(): void {
  h1('2. BGMStack · 血线降到 30%，音乐怎么变');

  const bgm = new BgmStack({
    layers: [
      { name: 'drums' },
      { name: 'bass' },
      { name: 'melody' },
      { name: 'choir', baseVolume: 0.5, alwaysOn: false },
    ],
    states: {
      explore: { drums: 0.5, bass: 0.3, melody: 1.0, choir: 0 },
      battle: { drums: 1.0, bass: 0.8, melody: 0.6, choir: 0 },
      climax: { drums: 1.0, bass: 1.0, melody: 0.3, choir: 1.0 },
    },
    initialState: 'explore',
    transitionMs: 800,
  });

  const show = (label: string): void => {
    const ls = bgm.layers();
    const bar = (v: number): string => '█'.repeat(Math.round(v * 12)).padEnd(12, '·');
    console.log(`  ${label.padEnd(14)} ` + ls.map((l) => `${l.name}:${bar(l.current)}`).join(' '));
  };

  h2('分层混音（每层独立淡入淡出，音乐不中断）');
  show('探索');
  bgm.setState('battle');
  bgm.update(800);
  show('战斗');
  bgm.setState('climax');
  bgm.update(800);
  show('决战');

  console.log('');
  console.log('  ↑ 注意 choir 层：探索与战斗时是 0，只有决战才推上来。');
  console.log('    它不是"换了一首歌"，而是**同一首歌多了一层**——');
  console.log('    节拍、调性完全连续，玩家察觉不到切换点。');

  h2('⚠️ 为什么默认用 equal-power 而不是 linear');
  const mk = (curve: 'linear' | 'equal-power'): number => {
    const s = new BgmStack({
      layers: [{ name: 'a' }, { name: 'b' }],
      states: { s1: { a: 1, b: 0 }, s2: { a: 0, b: 1 } },
      initialState: 's1',
      transitionMs: 1000,
      curve,
    });
    s.setState('s2');
    let minLevel = Infinity;
    for (let i = 0; i < 10; i++) {
      s.update(100);
      minLevel = Math.min(minLevel, s.outputLevel);
    }
    return minLevel;
  };
  const lin = mk('linear');
  const eqp = mk('equal-power');
  console.log(`  两层交叉时，过渡中途的最低总音量：`);
  console.log(`    linear       ${lin.toFixed(3)}   ← 中间"变轻"了`);
  console.log(`    equal-power  ${eqp.toFixed(3)}   ← 全程恒定`);
  console.log('');
  console.log('  等功率曲线用的是功率域插值 √(from²·cos²θ + to²·sin²θ)。');
  console.log('  它还有个附带好处：**两层都保持 0.8 时，中间不会涨到 1.13**。');
}

// ==================== 3. 演出 ====================

function demoCutscene(): void {
  h1('3. Cutscene · Boss 出场演出，玩家按了跳过');

  const log: string[] = [];
  const tl = new Timeline('boss_intro')
    .add('camera', 1200, { to: 'boss' })
    .with('sfx', 400, { id: 'roar' })
    .add('dialogue', 1500, { text: '凡人……' })
    .add('shake', 300, { power: 0.8 });

  const cs = new Cutscene(tl.build());

  cs.on('camera', (_s, t) => log.push(`camera  t=${t.toFixed(2)}`));
  cs.on('dialogue', (_s, t) => log.push(`dialogue t=${t.toFixed(2)}`));
  cs.on('shake', (_s, t) => log.push(`shake   t=${t.toFixed(2)}`));

  h2('正常播放到一半（1200ms）');
  cs.play();
  cs.update(1200);
  console.log(`  进度 ${(cs.progress * 100).toFixed(0)}%，状态 ${cs.state}`);
  console.log(`  最后的镜头进度：${log[log.length - 1]}`);

  h2('⚠️ 玩家按了跳过');
  cs.skip();
  console.log(`  状态 ${cs.state}`);
  console.log(`  最后一条日志：${log[log.length - 1]}`);
  console.log('');
  console.log('  ↑ skip 是"快进到结尾"，不是"停止播放"。');
  console.log('    所有 step 的**最终状态**都被应用了：镜头到位、对话到底、震屏结束。');
  console.log('    如果写成 stop()，跳过之后镜头会卡在半路——');
  console.log('    玩家会看到一个很怪的中间画面。');

  h2('⚠️ 对照：seek 到中间会重放之前的 step');
  const cs2 = new Cutscene(tl.build());
  const seeked: string[] = [];
  cs2.on('camera', (_s, _t, isSeek) => { if (isSeek) seeked.push('camera'); });
  cs2.on('dialogue', (_s, _t, isSeek) => { if (isSeek) seeked.push('dialogue'); });
  cs2.play();
  cs2.seek(2000);   // 跳到对话中段
  console.log(`  跳到 2000ms，被重放的 step：${seeked.join('、')}`);
  console.log('  ↑ camera 在 1200ms 就结束了，但它**必须被补上**——');
  console.log('    否则镜头不会移动，玩家会看到默认机位。');

  h2('⚠️ 门控：等待玩家按键，且有超时兜底');
  let pressed = false;
  const cs3 = new Cutscene({
    id: 'wait_demo',
    steps: [
      { id: 'a', kind: 'a', duration: 100 },
      { id: 'press', kind: 'press', duration: 0, waitFor: () => pressed, timeoutMs: 1500 },
      { id: 'b', kind: 'b', duration: 5000 },
    ],
  });
  cs3.play();
  cs3.update(150);
  console.log(`  时间 150ms（门在 100ms 处）：状态 ${cs3.state}，时间 ${cs3.time}`);
  console.log('  ↑ 时间**停在门的起点**，没有越过去。');
  console.log('    早期实现会在这里直接冲过门，后面的内容照常播放，');
  console.log('    门控形同虚设。');
  for (let i = 0; i < 8; i++) cs3.update(200);
  console.log(`  无人按键 1600ms 后：状态 ${cs3.state}，超时标记 ${cs3.timedOut}`);
  console.log('  ↑ 玩家不按也不能永远卡住——waitFor 必须配 timeoutMs。');
}

// ==================== 4. 转场 ====================

async function demoTransition(): Promise<void> {
  h1('4. Transition · 打完收工，切回主城');

  h2('正常转场（out → load → in）');
  const t = new Transition(
    () => Promise.resolve(),
    { outMs: 300, inMs: 300, loadTimeoutMs: 5000 }
  );
  t.start('town');
  const phases: string[] = [];
  for (let i = 0; i < 20; i++) {
    phases.push(`${t.phase}(${(t.state.progress * 100).toFixed(0)}%)`);
    t.update(50);
    await Promise.resolve();
  }
  console.log('  ' + phases.slice(0, 14).join(' → '));

  h2('⚠️ 转场途中玩家又点了一次');
  const t2 = new Transition(() => Promise.resolve(), { outMs: 300 });
  console.log(`  第一次 start('town')：${t2.start('town')}`);
  console.log(`  第二次 start('shop')：${t2.start('shop')}   ← 被拒绝`);
  console.log(`  目标仍是：${t2.state.target}`);
  console.log('  ↑ 不拒绝的话会叠加两个转场，场景被加载两次。');

  h2('⚠️ 加载卡死（网络/磁盘故障）');
  const t3 = new Transition(
    () => new Promise<void>(() => { /* 永不 resolve */ }),
    { outMs: 100, loadTimeoutMs: 1000 }
  );
  t3.start('town');
  t3.update(100);
  t3.update(2000);
  console.log(`  状态：${t3.phase}`);
  console.log(`  原因：${t3.error}`);
  console.log(`  遮罩：${t3.state.overlay}（保持全黑，由上层决定重试或退回）`);
  console.log(`  是否锁输入：${t3.shouldLockInput}`);
  console.log('  ↑ 没有超时的话，玩家会看到**永久黑屏**，以为游戏崩了。');

  h2('⚠️ overlay=0 时必须隐藏遮罩节点');
  const s0 = overlayStyle(0);
  const s1 = overlayStyle(1);
  console.log(`  overlay=0 → visible=${s0.visible}（否则全屏节点会吃掉触摸事件）`);
  console.log(`  overlay=1 → visible=${s1.visible}, opacity=${s1.opacity}`);
  console.log('  ↑ "转场结束后点不动了"这个经典 bug 就出在这里。');
}

// ==================== 5. 小地图 ====================

function demoMinimap(): void {
  h1('5. Minimap · 队友在哪（旋转 vs 北朝上）');

  const mk = (rotate: boolean) => new Minimap({
    worldSize: { x: 1000, y: 1000 },
    viewSize: { x: 200, y: 200 },
    mode: 'follow',
    scale: 1,
    rotateWithView: rotate,
  });

  const viewer = { x: 500, y: 500 };
  // 玩家朝东（rotation=0 表示 +X 方向）；队友在正北方 100 米处
  const ally = { id: 'ally', kind: 'ally', pos: { x: 500, y: 600 }, rotation: 0 };

  h2('北朝上模式（rotateWithView: false）');
  const m1 = mk(false);
  const i1 = m1.layout([ally], viewer, 0)[0]!;
  console.log(`  队友在正北 → 小地图坐标 (${i1.x.toFixed(0)}, ${i1.y.toFixed(0)})`);
  console.log(`  图标朝向 ${(i1.rotation * 180 / Math.PI).toFixed(0)}°（0=上，顺时针为正）`);
  console.log('  ↑ 北方在上，所以朝北的队友显示在**上方**。');

  h2('随视角旋转模式（玩家朝东）');
  const m2 = mk(true);
  const i2 = m2.layout([ally], viewer, 0)[0]!;
  console.log(`  队友在正北 → 小地图坐标 (${i2.x.toFixed(0)}, ${i2.y.toFixed(0)})`);
  console.log('  ↑ 玩家朝东，北方在他的**左手边**，所以队友显示在左边。');
  console.log('    早期实现漏了横向交换，正前方的物体会显示在右边——');
  console.log('    整张小地图转了 90°，玩家完全没法用。');

  h2('⚠️ 正前方的物体必须显示在正上方');
  const front = { id: 'f', kind: 'enemy', pos: { x: 600, y: 500 }, rotation: 0 };
  const i3 = m2.layout([front], viewer, 0)[0]!;
  console.log(`  正前方 100 米 → (${i3.x.toFixed(1)}, ${i3.y.toFixed(1)})`);
  console.log(`  x 应为 0，y 应为 -100（屏幕上方）`);

  h2('⚠️ 范围外的敌人：钳制到边缘而不是消失');
  const far = { id: 'far', kind: 'enemy', pos: { x: 900, y: 900 } };
  const i4 = m2.layout([far], viewer, 0)[0]!;
  console.log(`  实际距离 ${Math.hypot(400, 400).toFixed(0)} 米，小地图半径仅 100 像素`);
  console.log(`  钳制后 (${i4.x.toFixed(0)}, ${i4.y.toFixed(0)})，clamped=${i4.clamped}，visible=${i4.visible}`);
  console.log('  ↑ 直接不画的话，玩家会觉得"背后突然冒出来一个人"。');

  h2('圆形 vs 矩形的钳制方式不同');
  const circle = new Minimap({
    worldSize: { x: 1000, y: 1000 },
    viewSize: { x: 200, y: 200 },
    mode: 'follow', scale: 1, shape: 'circle',
  });
  const c = circle.clampToEdge({ x: 1000, y: 1000 });
  console.log(`  圆形：钳制到半径上，长度 ${Math.hypot(c.pos.x, c.pos.y).toFixed(1)}（≈96 = 半径100 - padding4）`);
  console.log('  ↑ 圆形下分别 clamp x/y 会得到一个方形边界，');
  console.log('    图标出现在圆外的四个角上，很怪。');
}

// ==================== 6. 建造 ====================

function demoBuilder(): void {
  h1('6. Builder · 在主城盖房子');

  const house: Blueprint = {
    id: 'house',
    name: '民居',
    cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],   // 2×1
    cost: { wood: 50 },
    buildTimeMs: 3000,
  };
  const wall: Blueprint = {
    id: 'wall',
    name: '城墙',
    cells: [{ x: 0, y: 0 }],
    cost: { stone: 20 },
    upgradeTo: 'wall2',
  };
  const wall2: Blueprint = {
    id: 'wall2',
    name: '加固城墙',
    cells: [{ x: 0, y: 0 }],
    cost: { stone: 40 },
    refundRate: 0.75,
  };

  const w = new Wallet({ wood: 200, stone: 200 });
  const b = new Builder({
    blueprints: [house, wall, wall2],
    wallet: w,
    bounds: { w: 20, h: 20 },
  });

  h2('⚠️ 2×1 的房子旋转 90° 后占哪两格');
  const p0 = b.preview('house', { x: 5, y: 5 }, 0);
  const p90 = b.preview('house', { x: 5, y: 5 }, 90);
  const fmt = (cells: readonly { x: number; y: number }[]) =>
    cells.map((c) => `(${c.x},${c.y})`).join(' ');
  console.log(`  0°  → ${fmt(p0.cells)}`);
  console.log(`  90° → ${fmt(p90.cells)}`);
  console.log('  ↑ 占位算错 = 建筑重叠。旋转不是换个贴图，是换一整套格子。');

  h2('⚠️ 资源不足时，一分钱都不能扣');
  const poor = new Wallet({ wood: 10 });
  const b2 = new Builder({ blueprints: [house], wallet: poor, bounds: { w: 20, h: 20 } });
  const r = b2.place('house', { x: 1, y: 1 });
  console.log(`  结果：${r.ok}（${r.error}）`);
  console.log(`  钱包：wood=${poor.get('wood')}（还是 10）`);
  console.log('  ↑ "先扣资源再放置"是建造系统的头号事故——');
  console.log('    失败时资源凭空消失，玩家会认为你在偷东西。');
  console.log('    正确顺序：验证 → 占位 → 扣资源。');

  h2('放一个正在建造的房子，然后取消');
  b.place('house', { x: 2, y: 2 });
  console.log(`  放置后 wood=${w.get('wood')}（-50），建造中`);
  const placed = b.allBuildings()[0]!;
  const rm = b.remove(placed.id);
  console.log(`  取消后 wood=${w.get('wood')}（返还 ${rm.refunded?.wood ?? 0}）`);
  console.log('  ↑ **未完成**的建筑取消时 100% 返还。');
  console.log('    玩家改主意了，不该被惩罚；否则他就不敢再试。');

  h2('⚠️ 建完再拆，只返还一部分');
  b.place('wall', { x: 8, y: 8 });
  const wallInst = b.allBuildings().find((x) => x.blueprintId === 'wall')!;
  console.log(`  建好后 stone=${w.get('stone')}（-20）`);
  const rm2 = b.remove(wallInst.id);
  console.log(`  拆除后 stone=${w.get('stone')}（返还 ${rm2.refunded?.stone ?? 0} = 50%）`);
  console.log('  ↑ 100% 返还的话，玩家可以零成本试错，建造决策就失去意义了。');

  h2('⚠️ 升级必须原地替换，不能"拆了重建"');
  b.place('wall', { x: 10, y: 10 });
  const w2 = b.allBuildings().find((x) => x.blueprintId === 'wall')!;
  const idBefore = w2.id;
  const up = b.upgrade(w2.id);
  const after = b.getBuilding(idBefore)!;
  console.log(`  升级结果：${up.ok}`);
  console.log(`  蓝图 wall → ${after.blueprintId}`);
  console.log(`  实例 id ${idBefore} → ${after.id}（未变）`);
  console.log(`  位置 (${after.anchor.x}, ${after.anchor.y})（未变）`);
  console.log('  ↑ 拆了重建的话：位置可能被抢、返还50%再付100%净亏、');
  console.log('    而且 id 变了，所有引用它的东西全断。');
}

// ==================== 7. 自动画质 ====================

function demoAutoQuality(): void {
  h1('7. AutoQuality · 战斗中掉帧，画质自动降下来');

  const a = new AutoQuality({
    tiers: AutoQuality.defaultTiers(),
    downgradeFps: 50,
    upgradeFps: 58,
    windowSize: 60,
    cooldownMs: 2000,
    consecutiveSamples: 3,
  });

  /** 喂 n 帧，返回新的时间戳 */
  const feed = (dt: number, frames: number, start: number): number => {
    let t = start;
    for (let i = 0; i < frames; i++) a.update(dt, (t += dt));
    return t;
  };

  /**
   * 【⚠️ 冷却期内的 fps 读数不可信】
   * 切换档位会清空采样窗口，缓冲里残留的是上一档位的帧时间。
   * 直接读会得出"已经降到低画质，但帧率显示 60"这种自相矛盾的输出。
   */
  const fpsText = (): string => {
    const st = a.state;
    return st.fpsValid ? `${st.fps.toFixed(1)}fps` : '测量中（切换冷却）';
  };

  h2('前 2 秒：流畅 60fps');
  let now = feed(16.7, 120, 0);
  console.log(`  档位 ${a.tier.name}，帧率 ${fpsText()}`);

  h2('第 3 秒起：进入大场景，掉到 35fps');
  now = feed(28.5, 120, now);   // 约 3.4 秒，够降一级
  console.log(`  档位 ${a.tier.name}，帧率 ${fpsText()}`);

  h2('继续卡，掉到 20fps');
  now = feed(50, 300, now);
  console.log(`  档位 ${a.tier.name}，帧率 ${fpsText()}`);

  h2('切换记录');
  for (const h of a.history) {
    const dir = h.to > h.from ? '↑' : '↓';
    console.log(`  ${dir} ${h.from} → ${h.to}  @${(h.at / 1000).toFixed(1)}s  ${h.reason}`);
  }

  h2('⚠️ 单帧卡顿不应该触发降级（中位数的价值）');
  /**
   * 【⚠️ 必须在卡顿后只喂 59 帧以内就读】
   * 窗口是 60 帧，喂多了那帧 500ms 会被挤出缓冲区，
   * 均值和中位数就都恢复正常了——对照根本没成立，
   * 我第一版就是这么写错的。
   */
  const b = new AutoQuality({
    tiers: AutoQuality.defaultTiers(),
    windowSize: 60,
    cooldownMs: 2000,
    consecutiveSamples: 3,
  });
  let t2 = 0;
  for (let i = 0; i < 60; i++) b.update(16.7, (t2 += 16.7));
  b.update(500, (t2 += 500));       // 一次 GC 停顿
  for (let i = 0; i < 58; i++) b.update(16.7, (t2 += 16.7));  // 补到窗口刚好还留着那一帧

  // 同一个缓冲区的两种读数
  const meterAv = b.averageFps;
  const meterMd = b.medianFps;
  console.log(`  59 帧 16.7ms + 1 帧 500ms：`);
  console.log(`    平均 fps ${meterAv.toFixed(1)}   ← 被单帧污染`);
  console.log(`    中位 fps ${meterMd.toFixed(1)}  ← 免疫离群值`);
  console.log(`    档位 ${b.tier.name}（未降级）`);
  if (meterAv < 50 && meterMd >= 55) {
    console.log('  ↑ 如果决策用均值，这里就会触发一次不必要的降级。');
  } else {
    console.log(`  ↑ 本次污染幅度：均值 ${meterAv.toFixed(1)} vs 中位 ${meterMd.toFixed(1)}`);
  }

  h2('⚠️ 迟滞：帧率在阈值边界抖动时不能来回切');
  const c = new AutoQuality({
    tiers: AutoQuality.defaultTiers(),
    downgradeFps: 50,
    upgradeFps: 58,
    windowSize: 30,
    cooldownMs: 1000,
  });
  let t3 = 0;
  for (let i = 0; i < 300; i++) {
    const dt = i % 2 === 0 ? 17 : 20;   // 58.8fps 与 50fps 交替
    c.update(dt, (t3 += dt));
  }
  console.log(`  300 帧抖动后：档位 ${c.tier.name}，切换次数 ${c.history.length}`);
  console.log('  ↑ 降级阈值 50、升级阈值 58，中间是 8fps 的死区。');
  console.log('    两个阈值相同的话会反复横跳，每次切换都重建渲染资源，');
  console.log('    玩家看到的是画面一直在闪——比稳定 50 帧糟糕得多。');

  h2('诊断报告（玩家问"为什么画质变低了"时直接给他看）');
  console.log(a.describe().split('\n').map((l) => '  ' + l).join('\n'));
}

// ==================== 8. 诊断包 ====================

function demoDiagPack(): void {
  h1('8. DiagPack · 崩了，生成一份脱敏的诊断包');

  const c = new DiagCollector({
    appId: 'roguelike-demo',
    version: '1.0.3',
    maxSectionChars: 400,
    maxTotalChars: 2000,
  });

  c.section('environment', () => ({
    platform: 'iOS',
    os: '17.5',
    deviceModel: 'iPhone 15 Pro',
    memoryMB: 612,
    screen: '2556x1179',
  }));

  // 故意放一个会抛错的分区
  c.section('saveData', () => {
    throw new Error('存档文件校验失败');
  });

  // 故意放敏感信息
  c.section('account', () => ({
    userId: 'u_88231',
    email: 'player@example.com',
    phone: '13800138000',
    accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  }));

  // 循环引用（JSON.stringify 会直接抛 TypeError）
  c.section('sceneGraph', () => {
    const root: Record<string, unknown> = { name: 'Canvas', children: [] };
    root.self = root;
    return root;
  });

  // 超长日志（会被截断）
  c.section('recentLog', () => ({
    lines: Array.from({ length: 50 }, (_, i) => `[${i}] some log line here`),
  }));

  h2('摘要（贴工单时发这个）');
  console.log(c.summarize().split('\n').map((l) => '  ' + l).join('\n'));

  h2('⚠️ 脱敏后的正文片段');
  const json = c.generateJson(undefined, false);
  const accountLine = json.replace(/\s+/g, ' ').slice(0, 400);
  console.log('  ' + accountLine);

  console.log('');
  console.log('  ↑ 注意三件事：');
  console.log('    1. 手机号、邮箱、JWT 全部变成 [REDACTED]');
  console.log('    2. 循环引用被标成 [Circular]，**没有抛错**');
  console.log('    3. saveData 分区收集失败，但其他区照常产出');
  console.log('');
  console.log('  "生成诊断包"这个操作自己成了新的崩溃源，');
  console.log('    是这里最容易踩的坑：玩家点"发送"，游戏崩了，');
  console.log('    再点，又崩——所以所有分区都独立 try/catch。');

  h2('⚠️ 为什么脱敏要在"序列化之后"做');
  const errObj = { stack: 'Error: POST /api/user/13800138000 failed\n  at fetch (net.js:12)' };
  console.log('  对象脱敏：只看 key，stack 里的手机号会漏掉');
  console.log('  文本脱敏：整个 JSON 字符串一起过正则，一个都跑不掉');
  console.log(`  stack 是最容易带敏感信息的地方——${'URL 里经常有用户 id 或手机号'}`);
  void errObj;
}

// ==================== main ====================

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  第十八批：表现与运维层 —— 8 个模块                      ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  demoAudio();
  demoBgm();
  demoCutscene();
  await demoTransition();
  demoMinimap();
  demoBuilder();
  demoAutoQuality();
  demoDiagPack();

  console.log('\n' + '╔════════════════════════════════════════════════════════╗');
  console.log('║  本批 8 个模块的共同主题                                 ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`
  它们处理的是同一件事：**玩家能感知到、但说不清的"感觉"**。

  音频     → 预警音被掩盖 = 玩家死得莫名其妙
  分层音乐 → 换歌式的切换点 = 音乐比画面早三秒，出戏
  演出     → 跳过不应用终态 = 镜头停在一个很怪的中间画面
  转场     → 加载无超时 = 玩家以为游戏崩了
  小地图   → 朝向算错 90° = 玩家完全没法用，但说不出哪里不对
  建造     → 先扣资源 = 玩家认为你在偷他东西
  自动画质 → 边界横跳 = 画面一直在闪，比稳定 50 帧更糟
  诊断包   → 没脱敏 = 一次安静发生的数据泄露事故

  失败模式也高度一致：**都不抛异常**。
  数值算错、状态泄漏、方向写反、敏感信息外泄——
  全都只是让游戏"感觉有点怪"，而开发者查不出来。

  所以这一批的测试里，很大一部分断言的不是"能不能跑"，
  而是**"方向对不对"**：
    预警音是否还在？
    正前方是否显示在上方？
    跳过之后镜头是否到位？
    手机号是否真的没了？
`);
}

void main();
