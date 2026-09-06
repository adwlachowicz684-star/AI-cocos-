/**
 * basic-usage.ts —— 六个插件串起来的完整例子
 *
 * 【这个例子演示什么】
 * 从「玩家推摇杆」到「敌人掉血飘字」的完整链路，
 * 全程零业务耦合——把 Enemy 换成 Crate（箱子）、Wall（墙），
 * 代码一行都不用改。
 *
 * 【如何运行】
 * 纯逻辑部分可以脱离 Cocos 直接跑：
 *   npx ts-node examples/basic-usage.ts
 */

import { RNG } from '../rng/RNG';
import { Seed } from '../rng/Seed';
import { EventBus } from '../event-bus/EventBus';
import { Pool } from '../pool/Pool';
import { JoystickCore } from '../joystick-mover/JoystickCore';
import { DamagePipeline } from '../damage-pipeline/DamagePipeline';
import { IDamageable, DamageResult, DamageContext } from '../damage-pipeline/IDamageable';
import { ModifierSet } from '../damage-pipeline/Modifier';
import { Track } from '../skill-player/Track';
import { SkillPlayer } from '../skill-player/SkillPlayer';
import { Cooldown } from '../skill-player/Cooldown';

// ============================================================
// 1. 定义游戏事件（事件清单应该集中维护）
// ============================================================

interface GameEvents {
  'damage:dealt': { value: number; crit: boolean; targetId: string };
  'enemy:died': { id: string };
  'skill:cast': { name: string };
}

const bus = new EventBus<GameEvents>({ trace: false });

// 表现层订阅（飘字 / 特效 / 音效 / 统计各自订阅，互不干扰）
bus.on('damage:dealt', (d) => {
  console.log(`  [飘字] ${d.crit ? '暴击! ' : ''}${d.value} → ${d.targetId}`);
});
bus.on('enemy:died', (d) => console.log(`  [事件] ${d.id} 已死亡`));

// ============================================================
// 2. 敌人：只需实现 IDamageable 最小契约
// ============================================================

let nextId = 1;

class Enemy implements IDamageable {
  readonly id: string;
  hp: number;
  readonly maxHp: number;
  armor: number;
  resistances: Record<string, number>;

  constructor(hp: number, armor = 0, resistances: Record<string, number> = {}) {
    this.id = `enemy_${nextId++}`;
    this.hp = hp;
    this.maxHp = hp;
    this.armor = armor;
    this.resistances = resistances;
  }

  applyDamage(result: DamageResult, _ctx: DamageContext): void {
    this.hp -= result.value;
    bus.emit('damage:dealt', { value: result.value, crit: result.isCrit, targetId: this.id });
    if (this.hp <= 0) bus.emit('enemy:died', { id: this.id });
  }

  isAlive(): boolean {
    return this.hp > 0;
  }
}

// ============================================================
// 3. 主流程
// ============================================================

function main() {
  console.log('========== cocos-kit 综合示例 ==========\n');

  // ---------- 3.1 种子与随机 ----------
  // 【推荐做法】字符串才是种子的真身——玩家分享的就是它
  const seedText = Seed.random();
  console.log(`【种子】生成可读种子 "${seedText}"（玩家之间可以口耳相传）`);

  // 同一个字符串永远得到同一局游戏
  const rng = new RNG(Seed.decode(seedText)!);
  console.log(`【种子】"${seedText}" → 数字 ${Seed.decode(seedText)}（确定的，可复现）`);

  // 派生独立子流：地图与掉落互不干扰
  const lootRng = rng.fork();
  console.log(`【fork】掉落子流首个随机数 = ${lootRng.next().toFixed(4)}\n`);

  // ---------- 3.2 对象池：飘字 ----------
  interface FloatText {
    text: string;
    x: number;
    y: number;
    life: number;
  }
  const textPool = new Pool<FloatText>(
    () => ({ text: '', x: 0, y: 0, life: 0 }),
    (o) => {
      // onGet：必须重置，否则带着上一次的文本和位置
      o.text = '';
      o.life = 0;
    },
    (o) => {
      o.life = 0;
    },
    { maxSize: 32 }
  );
  textPool.prewarm(8);
  console.log(`【对象池】预热后 idle=${textPool.idle} created=${textPool.created}`);

  // ---------- 3.3 摇杆 ----------
  const joy = new JoystickCore({ radius: 80, deadZone: 0.15 });
  joy.onDown(0, 100, 100);
  joy.onMove(0, 100 + 56, 100 + 56); // 右下 45°
  const out = joy.evaluate();
  const len = Math.sqrt(out.dir.x ** 2 + out.dir.y ** 2);
  console.log(
    `【摇杆】方向=(${out.dir.x.toFixed(2)}, ${out.dir.y.toFixed(2)}) ` +
      `长度=${len.toFixed(2)}（归一化后应为 1.00，不是 1.41）`
  );
  joy.onUp(0);
  console.log(`【摇杆】松开后方向=(${joy.evaluate().dir.x}, ${joy.evaluate().dir.y})（必须归零）\n`);

  // ---------- 3.4 伤害管线 ----------
  const dmg = DamagePipeline.createDefault({ minDamage: 1, defaultCritMul: 2 });

  // 插入一个自定义阶段（比如某件遗物：火伤 +25%）
  dmg.addStage('relic_ember', (v, ctx) => (ctx.type === 'fire' ? v * 1.25 : v), 35);

  dmg.onResult((r) => {
    // 这里接飘字、特效、音效、统计
    const t = textPool.get();
    t.text = String(r.value);
  });

  // ---------- 3.5 数值修正 ----------
  const mods = new ModifierSet();
  mods.add('atk', { type: 'add', value: 5, source: 'weapon' });
  mods.add('atk', { type: 'mul', value: 0.2, source: 'relic', tag: 'relic' });
  const baseAtk = 10;
  const finalAtk = mods.get('atk', baseAtk);
  console.log(`【数值修正】基础 ${baseAtk} +5 后 ×1.2 = ${finalAtk}  (期望 18)`);

  // buff 到期：按 tag 批量清理
  mods.clearByTag('atk', 'relic');
  console.log(`【数值修正】遗物失效后 = ${mods.get('atk', baseAtk)}  (期望 15)\n`);

  // ---------- 3.6 打几下 ----------
  console.log('【伤害结算】');
  const skeleton = new Enemy(100, 20, { fire: 0.5 }); // 火抗 50%，护甲 20

  const cases: Array<{ label: string; ctx: DamageContext }> = [
    { label: '物理 20（无暴击）', ctx: { raw: 20, type: 'physical' } },
    { label: '物理 20（暴击）', ctx: { raw: 20, type: 'physical', crit: true } },
    { label: '火 20（火抗50%+遗物+25%）', ctx: { raw: 20, type: 'fire' } },
    { label: '火 20（50% 护甲穿透）', ctx: { raw: 20, type: 'fire', armorPen: 0.5 } },
    { label: '真实伤害 20（无视一切）', ctx: { raw: 20, type: 'true' } },
  ];

  for (const c of cases) {
    const r = dmg.calculate(c.ctx, skeleton);
    const chain = r.stages.map((s) => `${s.name}:${s.value.toFixed(1)}`).join(' → ');
    console.log(`  ${c.label.padEnd(28)} = ${String(r.value).padStart(3)}   [${chain}]`);
  }

  // 实际应用（会扣血并触发事件）
  console.log('');
  dmg.apply({ raw: 50, type: 'physical', crit: rng.chance(0.3) }, skeleton);
  console.log(`  骷髅兵剩余 HP = ${skeleton.hp}\n`);

  // ---------- 3.7 批量模拟（无表现，验证平衡用）----------
  const samples = dmg.simulate({ raw: 20, type: 'physical' }, skeleton, 1000);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(`【批量模拟】1000 次物理 20 的平均伤害 = ${avg.toFixed(2)}（无副作用，不扣血）`);
  console.log(`  骷髅兵 HP 未变化 = ${skeleton.hp}\n`);

  // ---------- 3.8 技能时间轴 ----------
  const heavyAttack = new Track({
    duration: 1.2,
    cancellable: true,
    cancelAfter: 0.5,
    events: [
      { t: 0.0, type: 'anim', data: { name: 'attack_heavy' } },
      { t: 0.0, type: 'sfx', data: { name: 'swing' } },
      // 【关键】0.35 秒出判定 —— 由美术标注的「第 10 帧（30fps）」换算而来
      { t: Track.frameToTime(10, 30), type: 'hitbox', data: { shape: 'sector', r: 2.5, dmg: 20 } },
      { t: 0.6, type: 'projectile', data: { speed: 12 } },
    ],
  });

  const player = new SkillPlayer();
  const log: string[] = [];
  player.register('anim', (d) => log.push(`anim:${d!['name']}`));
  player.register('sfx', (d) => log.push(`sfx:${d!['name']}`));
  player.register('hitbox', (d) => log.push(`hitbox:${d!['shape']}`));
  player.register('projectile', (d) => log.push(`projectile:speed${d!['speed']}`));

  // 校验（编辑器保存前调用）
  const errors = Track.validate({
    duration: heavyAttack.duration,
    events: heavyAttack.events,
  });
  console.log(`【技能校验】${errors.length === 0 ? '通过' : errors.join('; ')}`);

  // 播放（模拟 60fps，dt = 1/60）
  player.play(heavyAttack, { casterId: 'player' });
  console.log('【技能播放】');
  for (let i = 0; i < 80 && player.isPlaying; i++) {
    player.tick(1 / 60);
  }
  console.log(`  触发的事件：${log.join(' → ')}`);
  console.log(`  播放结束，state=${player.state}`);

  // 序列化往返
  const json = JSON.stringify(heavyAttack.toJSON());
  const restored = Track.fromJSON(JSON.parse(json));
  console.log(`  序列化往返：${restored.events.length} 个事件，时长 ${restored.duration}s\n`);

  // ---------- 3.9 冷却 ----------
  const cd = new Cooldown({ duration: 3, charges: 2 });
  console.log('【冷却】');
  console.log(`  初始充能 ${cd.charges}/${cd.maxCharges}`);
  cd.trigger();
  cd.trigger();
  console.log(`  连放两次后：ready=${cd.ready}（应为 false）`);
  cd.tick(1.5);
  console.log(`  1.5 秒后：charges=${cd.charges} progress=${cd.progress.toFixed(2)}`);
  cd.tick(1.6);
  console.log(`  再过 1.6 秒：charges=${cd.charges}（已充满）`);
  console.log(
    `  冷却缩减 50% → ${Cooldown.applyReduction(3, 0.5).toFixed(2)}s ` +
      `（除法公式：不是 1.5s，因为乘法会导致 100% 缩减时无限放技能）`
  );

  console.log('\n========== 示例结束 ==========');
}

// 【为什么要 declare 而不装 @types/node】
// 这是示例文件，不应该为了一个 require 就让整个库依赖 node 类型。
declare const require: { main?: unknown };
declare const module: unknown;

// 直接运行时执行（作为模块被 import 时不执行）
if (require.main === module) {
  main();
}

export { main };
