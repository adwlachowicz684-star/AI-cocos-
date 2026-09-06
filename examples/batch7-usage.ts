/**
 * examples/batch7-usage.ts —— 第六批插件的综合示例
 *
 * 【演示：一场完整的战斗】
 *
 *   attribute     属性（攻击力 = 基础 + 装备 + buff）
 *   hitbox        判定（这一刀砍到了谁）
 *   indicator     指示器（这一招会打到哪里）
 *   telegraph     预警（Boss 的攻击有红圈提示）
 *   skill-caster  技能释放（把上面几样串起来）
 *   projectile    弹道（火球飞行、穿透、追踪）
 *   input/Buffer  输入缓冲（按早了也算数）
 *   dash          冲刺（位移 + 无敌帧）
 *   camera        震屏（打击感）
 *
 * 【这批的共同主题：编排】
 *
 * 前五批多是"单个算法"（A*、噪声、地牢生成），
 * 这批是**编排型**——它们本身不做具体的事，
 * 而是把别的能力按正确的时序串起来。
 *
 * 正因为不做具体的事，它们才零依赖：
 * 判定、弹道、伤害、资源全部由外部注入。
 *
 * 【运行】
 *   npm run example:batch7
 */

import { AttributeSet } from '../attribute/AttributeSet';
import {
  HitboxWorld,
  circle,
  rect,
  sector,
  type Shape,
} from '../hitbox/Hitbox';
import { SkillIndicator } from '../indicator/SkillIndicator';
import { TelegraphSystem, telegraphProgress } from '../telegraph/Telegraph';
import {
  SkillCaster,
  type IHitboxProvider,
  type IProjectileProvider,
  type IDamageProvider,
  type IResourceProvider,
} from '../skill-caster/SkillCaster';
import {
  ProjectileSystem,
  createHitboxSweepProvider,
  type ICollisionProvider,
} from '../projectile/Projectile';
import { InputBuffer, CoyoteTimer } from '../input/InputBuffer';
import { DashController } from '../dash/DashController';
import { CameraShake, applyShakePreset } from '../camera/CameraShake';

const LAYER_ENEMY = 1 << 0;
const LAYER_PLAYER = 1 << 1;
const LAYER_WALL = 1 << 2;

/** 一个极简的战斗实体（业务层，不属于插件库） */
interface Fighter {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  armor: number;
  alive: boolean;
}

function makeFighter(id: string, x: number, y: number, hp: number, armor = 0): Fighter {
  return { id, x, y, hp, maxHp: hp, armor, alive: true };
}

/** 极简伤害计算（真实项目用 damage-pipeline） */
function dealDamage(target: Fighter, raw: number): number {
  // 护甲用除法公式：armor / (armor + 30)，永远不会被减到 0 以下
  const final = Math.max(1, Math.round(raw * (1 - target.armor / (target.armor + 30))));
  target.hp -= final;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
  }
  return final;
}

async function main(): Promise<void> {
  console.log('========== 第六批：战斗手感 ==========\n');

  // ────────────────────────────────────────────
  // 1. AttributeSet：攻击力是怎么算出来的
  // ────────────────────────────────────────────
  console.log('【1. AttributeSet · 属性容器】\n');

  const attrs = new AttributeSet([
    { id: 'atk', base: 20 },
    { id: 'critRate', base: 0.05, min: 0, max: 1 },
    { id: 'moveSpeed', base: 6 },
  ]);

  // 装备
  const unequip = attrs.addAll([
    { attr: 'atk', type: 'add', value: 5, source: 'sword', tag: 'equip' },
    { attr: 'critRate', type: 'add', value: 0.15, source: 'ring', tag: 'equip' },
  ]);

  // buff（可批量清除）
  const raging = attrs.add({ attr: 'atk', type: 'mul', value: 0.3, tag: 'buff' });

  console.log('  穿装备 + 狂暴后：');
  console.log(attrs.dump('atk').split('\n').map((l) => '    ' + l).join('\n'));
  console.log(`    暴击率 ${(attrs.get('critRate') * 100).toFixed(0)}%（base 5% + 戒指 15%）`);

  console.log('\n  狂暴到期（clearByTag buff）：');
  attrs.clearByTag('buff');
  console.log(`    攻击力 → ${attrs.get('atk')}（只掉 buff，装备还在）`);

  console.log('\n  脱掉装备：');
  unequip();
  console.log(`    攻击力 → ${attrs.get('atk')}`);
  void raging;

  // ────────────────────────────────────────────
  // 2. Hitbox：这一刀砍到了谁
  // ────────────────────────────────────────────
  console.log('\n【2. Hitbox · 判定形状】\n');

  const world = new HitboxWorld({ cellSize: 4 });

  const enemies: Fighter[] = [
    makeFighter('骷髅兵#1', 1.5, 0.5, 30),
    makeFighter('骷髅兵#2', 1.2, -1.0, 30),
    makeFighter('远处的弓手', 8, 0, 25),
  ];
  for (const e of enemies) {
    world.add({
      id: e.id, shape: circle(0.5),
      x: e.x, y: e.y, rotation: 0,
      layer: LAYER_ENEMY, mask: 0, data: e,
    });
  }

  // 墙
  world.add({
    id: 'wall', shape: rect(0.3, 3),
    x: 4, y: 0, rotation: 0,
    layer: LAYER_WALL, mask: 0,
  });

  const slash: Shape = sector(2.5, 100);   // 前方 2.5 米、张角 100° 的扇形

  const hits = world.query(slash, 0, 0, 0, LAYER_ENEMY);
  console.log(`  在原点朝右挥砍（扇形 2.5m / 100°）：`);
  console.log(`    命中 ${hits.length} 个目标`);
  for (const h of hits) {
    console.log(`      • ${(h.hitbox.data as Fighter).id}  距离 ${h.distance.toFixed(2)}m`);
  }
  console.log(`    远处的弓手没被命中（8m 超出射程）`);

  console.log('\n  同样的判定框，朝向转 180°：');
  const backHits = world.query(slash, 0, 0, 180, LAYER_ENEMY);
  console.log(`    命中 ${backHits.length} 个（背后没人）`);

  console.log('\n  视线检测（墙在 x=4）：');
  console.log(`    (0,0) → (10,0)：${world.lineOfSightBlocked(0, 0, 10, 0, LAYER_WALL) ? '被墙挡住' : '畅通'}`);
  console.log(`    (0,0) → (10,4)：${world.lineOfSightBlocked(0, 0, 10, 4, LAYER_WALL) ? '被墙挡住' : '畅通（绕过墙）'}`);

  // ────────────────────────────────────────────
  // 3. SkillIndicator：这一招会打到哪里
  // ────────────────────────────────────────────
  console.log('\n【3. SkillIndicator · 技能指示器】\n');

  const fireball = new SkillIndicator({
    kind: 'circle', radius: 2, range: 8, aimed: true,
    snapToTarget: true, snapRadius: 1.2,
  }, {
    targets: {
      findNearest: (x, y, r) => {
        let best: Fighter | null = null;
        let bd = r;
        for (const e of enemies) {
          const d = Math.hypot(e.x - x, e.y - y);
          if (d < bd) { bd = d; best = e; }
        }
        return best ? { x: best.x, y: best.y, id: best.id } : null;
      },
    },
  });

  console.log('  火球（射程 8m，半径 2m）：');
  for (const [ax, ay, label] of [
    [1.3, 0.3, '瞄准骷髅兵#1 附近'],
    [100, 0, '瞄准 100 米外'],
    [5, 0, '瞄准空地（无吸附）'],
  ] as Array<[number, number, string]>) {
    const r = fireball.compute(0, 0, 0, ax, ay);
    const extra = r.snappedTo ? ` → 吸附到 ${r.snappedTo}` : r.clamped ? ' → 已钳制到射程边缘' : '';
    console.log(`    ${label}：中心 (${r.x.toFixed(2)}, ${r.y.toFixed(2)})${extra}`);
  }

  // ────────────────────────────────────────────
  // 4. Telegraph：Boss 的攻击有预警
  // ────────────────────────────────────────────
  console.log('\n【4. Telegraph · 攻击预警】\n');

  const tgSys = new TelegraphSystem();
  const player = makeFighter('玩家', 0, 0, 100, 5);

  // Boss 在 (5,0) 蓄力，0.8 秒后发动半径 3 的 AOE
  let playerHurt = false;
  tgSys.spawn({
    shape: circle(3), x: 5, y: 0,
    windup: 0.8, active: 0.15, recover: 0.4,
    mask: LAYER_PLAYER,
    onActivate: (t) => {
      const inRange = Math.hypot(player.x - t.x, player.y - t.y) <= 3;
      if (inRange) playerHurt = true;
      console.log(`    ⚡ 判定生效！玩家${inRange ? '在范围内 → 被击中' : '已躲开 → 安全'}`);
    },
  });

  const tg = tgSys.all()[0];
  console.log('  Boss 在 (5,0) 蓄力 0.8 秒，半径 3m：');

  // 模拟：玩家看到预警后往右跑（错误方向）
  let playerX = 0;
  for (let i = 0; i < 60; i++) {
    tgSys.tick(1 / 60);
    if (tgSys.all().length > 0) {
      playerX += 3 * (1 / 60);          // 玩家往 +X 跑，正好跑向 Boss
      player.x = playerX;
    }
    if (i === 24) {
      console.log(`    0.4s：预警进度 ${(telegraphProgress(tgSys.all()[0] ?? tg) * 100).toFixed(0)}%（玩家在 x=${playerX.toFixed(1)}）`);
    }
  }
  console.log(`    结果：玩家${playerHurt ? '被击中（跑错方向了）' : '安全'}`);

  // 再来一次：玩家往左跑
  console.log('\n  同样的攻击，玩家往左跑：');
  player.x = 0;
  playerHurt = false;
  tgSys.spawn({
    shape: circle(3), x: 5, y: 0,
    windup: 0.8, active: 0.15,
    mask: LAYER_PLAYER,
    onActivate: (t) => {
      if (Math.hypot(player.x - t.x, player.y - t.y) <= 3) playerHurt = true;
    },
  });
  playerX = 0;
  for (let i = 0; i < 60; i++) {
    tgSys.tick(1 / 60);
    playerX -= 4 * (1 / 60);            // 往 -X 跑，远离 Boss
    player.x = playerX;
  }
  console.log(`    结果：玩家${playerHurt ? '被击中' : '成功躲开 ✓'}（跑到 x=${playerX.toFixed(1)}）`);

  // ────────────────────────────────────────────
  // 5. SkillCaster：把上面几样串起来
  // ────────────────────────────────────────────
  console.log('\n【5. SkillCaster · 技能释放】\n');

  const damageLog: string[] = [];

  const hitboxes: IHitboxProvider = {
    query: (shape, x, y, rot, mask) =>
      world.query(shape, x, y, rot, mask).map((h) => ({
        id: h.hitbox.id, x: h.hitbox.x, y: h.hitbox.y, data: h.hitbox.data,
      })),
  };

  const projSys = new ProjectileSystem({
    collision: createHitboxSweepProvider(world, { segmentRadius: 0.15 }) as ICollisionProvider,
    bounds: { minX: -30, minY: -30, maxX: 30, maxY: 30 },
    maxStep: 0.5,
  });

  const projectiles: IProjectileProvider = {
    spawn: (p) => projSys.spawn({
      x: p.x, y: p.y, dirX: p.dirX, dirY: p.dirY,
      speed: p.speed, lifetime: p.lifetime, mask: p.mask,
      mode: (p.mode ?? 'linear') as 'linear',
      pierce: p.pierce,
      onHit: (hit) => {
        const d = (p.data as { damage?: { raw: number } })?.damage;
        if (d) {
          const t = hit.data as Fighter | undefined;
          if (t) damageLog.push(`弹道命中 ${t.id}，伤害 ${dealDamage(t, d.raw)}`);
        }
      },
    }),
  };

  const damage: IDamageProvider = {
    apply: (target, dmg) => {
      const t = target as Fighter;
      const final = dealDamage(t, dmg.raw);
      damageLog.push(`直接命中 ${t.id}，伤害 ${final}（剩余 ${t.hp}）`);
    },
  };

  const purse: Record<string, number> = { mp: 100 };
  const resources: IResourceProvider = {
    canAfford: (c) => Object.entries(c).every(([k, v]) => (purse[k] ?? 0) >= v),
    pay: (c) => { for (const [k, v] of Object.entries(c)) purse[k] = (purse[k] ?? 0) - v; },
  };

  const caster = new SkillCaster({ hitboxes, projectiles, damage, resources });

  // 近战扇形：origin 默认 'caster'，形状以自身为中心向前张开
  caster.learn({
    id: 'slash', cooldown: 0.8, mask: LAYER_ENEMY,
    windup: 0.12, hitDelay: 0.08, hitWindow: 0.1, recover: 0.2,
    hitShape: sector(2.5, 100),
    damage: { raw: 20 },
  });

  // 火球：弹道从施法者发射，命中后由 onHit 结算伤害
  caster.learn({
    id: 'fireball', cooldown: 2, mask: LAYER_ENEMY, cost: { mp: 25 },
    windup: 0.3, hitDelay: 0, recover: 0.3,
    projectile: { speed: 12, lifetime: 2, pierce: 1, damage: { raw: 35 } },
  });

  // 陨石：origin='aim'，在鼠标位置炸开（演示两种原点的区别）
  caster.learn({
    id: 'meteor', cooldown: 3, mask: LAYER_ENEMY, cost: { mp: 40 },
    origin: 'aim',
    windup: 0.6, hitDelay: 0, recover: 0.4,
    hitShape: { kind: 'circle', radius: 3 },
    damage: { raw: 60 },
  });

  console.log('  学会了三个技能：');
  console.log('    斩击   近战扇形，origin=caster（从自身张开）');
  console.log('    火球   穿透弹道，消耗 25 MP');
  console.log('    陨石   落点 AOE，origin=aim（在鼠标位置炸开）\n');

  /** 推进若干帧，同时驱动施法与弹道 */
  function advance(frames: number): void {
    for (let i = 0; i < frames; i++) {
      caster.tick(1 / 60);
      projSys.tick(1 / 60);
    }
  }

  function flushLog(indent = '      '): void {
    if (damageLog.length === 0) console.log(`${indent}（没有命中）`);
    for (const l of damageLog) console.log(`${indent}${l}`);
    damageLog.length = 0;
  }

  // 斩击：全程 0.5 秒（蓄力 0.12 + 判定延迟 0.08 + 窗口 0.1 + 后摇 0.2）
  console.log('  ▶ 施放 [斩击]（瞄准 2 米外，扇形以自身为中心）');
  const r1 = caster.tryCast('slash', { x: 0, y: 0, facingDeg: 0, aimX: 2, aimY: 0 });
  console.log(`    结果：${r1.ok ? '成功' : '失败 ' + r1.reason}`);
  advance(35);
  flushLog();

  // 动作刚结束时再放一次 → 冷却还没走完
  console.log('\n  ▶ 立刻再放一次 [斩击]');
  const r2 = caster.tryCast('slash', { x: 0, y: 0, facingDeg: 0 });
  {
    const why: Record<string, string> = {
      busy: '上一个动作还没做完',
      cooldown: '冷却中',
      resource: '资源不足',
      'out-of-range': '超出射程',
      'too-close': '距离太近',
    };
    const detail = r2.remain !== undefined ? `，还需 ${r2.remain.toFixed(2)}s` : '';
    console.log(
      `    结果：${r2.ok ? '成功' : `失败 → ${r2.reason}（${why[r2.reason ?? ''] ?? ''}${detail}）`}`
    );
  }
  advance(40);

  // 火球
  console.log('\n  ▶ 施放 [火球]（消耗 25 MP，穿透 1 个）');
  console.log(`    施法前 MP：${purse.mp}`);
  const r3 = caster.tryCast('fireball', { x: 0, y: 0, facingDeg: 0, aimX: 10, aimY: 0 });
  console.log(`    结果：${r3.ok ? '成功' : '失败 ' + r3.reason}，施法后 MP：${purse.mp}`);
  advance(150);
  flushLog();

  // 陨石：打远处的弓手（8 米外，扇形/近战都够不着）
  console.log('\n  ▶ 施放 [陨石]（origin=aim，砸向 8 米外的弓手）');
  const r4 = caster.tryCast('meteor', { x: 0, y: 0, facingDeg: 0, aimX: 8, aimY: 0 });
  console.log(`    结果：${r4.ok ? '成功' : `失败 → ${r4.reason}`}`);
  advance(80);
  flushLog();

  console.log('\n  战斗结果：');
  for (const e of enemies) {
    console.log(`    ${e.id.padEnd(12)} ${e.hp}/${e.maxHp} ${e.alive ? '' : '☠ 已死亡'}`);
  }

  // ────────────────────────────────────────────
  // 6. InputBuffer + Dash：手感的两块地基
  // ────────────────────────────────────────────
  console.log('\n【6. InputBuffer + DashController · 手感地基】\n');

  const buf = new InputBuffer({ window: 0.15 });
  const dash = new DashController({
    distance: 4, duration: 0.22,
    invulnerableRatio: 0.7,
    cooldown: 0.6, charges: 2,
  });

  console.log('  场景：玩家在攻击后摇中按下了冲刺键\n');
  console.log('    后摇剩余 0.12s，玩家按下冲刺 → 输入被缓冲');
  buf.press('dash');

  // 后摇期间（角色还不能动）
  for (let i = 0; i < 7; i++) buf.tick(1 / 60);   // 0.117 秒后摇
  console.log(`    后摇结束，缓冲仍在窗口内：${buf.peek('dash') ? '是' : '否'}`);

  if (buf.consume('dash')) {
    const ok = dash.tryStart(1, 0, 0, 0, 0);
    console.log(`    → 冲刺立即执行：${ok ? '是' : '否'}`);
    console.log('    （没有输入缓冲的话，这次按键会被直接丢弃）');
  }

  console.log('\n  冲刺过程（每 3 帧采样一次）：');
  let px = 0;
  let frame = 0;
  let ghostAt = -1;
  while (dash.active && frame < 60) {
    dash.tick(1 / 60);
    px += dash.deltaX;
    frame++;
    if (frame % 3 === 1) {
      const bar = '█'.repeat(Math.round(dash.progress * 24)).padEnd(24, '·');
      console.log(
        `    ${String(frame).padStart(2)}帧  ${bar} ${(dash.progress * 100).toFixed(0).padStart(3)}%  ` +
        `x=${px.toFixed(2)}m  ${dash.invulnerable ? '🛡 无敌' : '  破绽'}`
      );
    }
    if (ghostAt < 0 && dash.progress > 0.3) ghostAt = frame;
  }
  console.log(`\n    总位移 ${px.toFixed(3)}m（配置值 4m，误差 ${Math.abs(px - 4).toExponential(1)}）`);
  console.log(`    无敌帧覆盖前 70%，末尾 ${(0.22 * 0.3 * 1000).toFixed(0)}ms 是破绽`);

  console.log('\n  双层充能：');
  console.log(`    剩余充能 ${dash.chargesLeft}/2`);
  dash.tryStart(1, 0, 0, 0, 0);
  console.log(`    连冲第二次后 → 剩余 ${dash.chargesLeft}/2`);
  console.log(`    再冲第三次：${dash.tryStart(1, 0, 0, 0, 0) ? '成功' : '失败（充能耗尽）'}`);

  // 搓招
  console.log('\n  搓招（升龙拳 ↓ → A）：');
  const buf2 = new InputBuffer({ window: 0.3, maxQueue: 8 });
  for (const a of ['down', 'down-right', 'right', 'attack']) {
    buf2.press(a);
    buf2.tick(0.04);
  }
  console.log(`    输入序列：${buf2.queue.map((q) => q.action).join(' → ')}`);
  console.log(`    匹配 [down, right, attack]：${buf2.matchSequence(['down', 'right', 'attack']) ? '✓ 命中' : '✗ 未命中'}`);
  console.log('    （中间划过的 down-right 不会打断匹配）');

  // 土狼时间
  console.log('\n  土狼时间：');
  const coyote = new CoyoteTimer(0.1);
  coyote.setGrounded(true);
  coyote.setGrounded(false);        // 走出平台
  coyote.tick(0.05);
  console.log(`    离地 0.05s 后按跳：${coyote.consumeJump() ? '✓ 成功（玩家感觉"我跳了"）' : '✗ 失败'}`);
  console.log(`    再按一次：${coyote.consumeJump() ? '成功（bug！能二段跳）' : '✗ 正确拒绝'}`);

  // ────────────────────────────────────────────
  // 7. CameraShake：打击感的最后一块
  // ────────────────────────────────────────────
  console.log('\n【7. CameraShake · 震屏】\n');

  const shake = new CameraShake({ strengthScale: 1, maxOffset: 0.5 });

  console.log('  触发 [暴击] 预设，逐帧偏移（前 12 帧）：');
  applyShakePreset(shake, 'crit');
  let line = '    ';
  for (let i = 0; i < 12; i++) {
    shake.tick(1 / 60);
    const mag = Math.hypot(shake.offsetX, shake.offsetY);
    line += mag.toFixed(2) + ' ';
    if (i === 5) { console.log(line); line = '    '; }
  }
  console.log(line);
  console.log('    ↑ 振幅单调衰减，轨迹连续（不是每帧随机噪点）');

  console.log('\n  连续命中（三震源叠加，受 maxOffset 约束）：');
  const shake2 = new CameraShake({ maxOffset: 0.5 });
  applyShakePreset(shake2, 'lightHit');
  applyShakePreset(shake2, 'heavyHit');
  applyShakePreset(shake2, 'explosion');
  let maxMag = 0;
  for (let i = 0; i < 30; i++) {
    shake2.tick(1 / 60);
    maxMag = Math.max(maxMag, Math.hypot(shake2.offsetX, shake2.offsetY));
  }
  console.log(`    三源叠加最大偏移 ${maxMag.toFixed(3)}，上限 0.5 → ${maxMag <= 0.501 ? '✓ 未失控' : '✗ 超出'}`);

  console.log('\n  玩家在设置里关掉震屏（strengthScale = 0）：');
  shake2.strengthScale = 0;
  applyShakePreset(shake2, 'explosion');
  shake2.tick(1 / 60);
  console.log(`    偏移 (${shake2.offsetX}, ${shake2.offsetY}) → ✓ 完全静止`);
  console.log('    （前庭敏感的玩家会因震屏晕眩，这是可访问性需求）');

  console.log('\n========== 示例结束 ==========');
}

declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== 'undefined' && require?.main === module) {
  main();
}

export { main };
