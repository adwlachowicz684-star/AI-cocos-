/**
 * examples/batch3-usage.ts —— 第二批插件的综合示例
 *
 * 【这个例子演示什么】
 * 一个"迷你 Roguelike 的一层"，把第二批插件串起来：
 *
 *   Noise       生成洞穴地形
 *   GridGraph   把地形变成可走网格
 *   findPath    敌人寻路追玩家
 *   SpatialHash 范围查询（爆炸伤害）
 *   LootTable   掉落（含保底）
 *   Chest       三选一奖励
 *   BuffSystem  中毒 DoT
 *   PRD         暴击（低方差）
 *   Condition   成就
 *   Tween       伤害数字飘字
 *   NumberRoller 血条滚动
 *   SaveManager 存档
 *   Result      错误处理
 *
 * 【为什么做这个例子】
 * 单个插件的 README 只讲它自己，但真实场景是**组合使用**。
 * 这个例子展示它们怎么接在一起——尤其是"数据怎么从一个插件流到下一个"。
 *
 * 【运行】
 *   npx tsc -p tsconfig.json && node .build/examples/batch3-usage.js
 */

import { RNG } from '../rng/RNG';
import { Logger, LogLevel } from '../logger/Logger';
import { Noise } from '../noise/Noise';
import { GridGraph, findPath, smoothPath } from '../pathfinding/GridGraph';
import { SpatialHash } from '../spatial/SpatialHash';
import { LootTable } from '../loot/LootTable';
import { Chest } from '../loot/Chest';
import { PRD } from '../loot/PRD';
import { BuffSystem } from '../buff/BuffSystem';
import { ConditionEngine } from '../condition/ConditionEngine';
import { Tween, TweenRunner } from '../tween/Tween';
import { NumberRollerCore } from '../number-roller/NumberRollerCore';
import { SaveManager, MemoryStorage } from '../save/SaveManager';
import { ok, err } from '../result/Result';

const log = new Logger({ level: LogLevel.Warn, bufferSize: 50 });
const mainLog = log.module('dungeon');

async function main(): Promise<void> {
  console.log('========== 第二批插件综合示例：迷你 Roguelike 一层 ==========\n');

  const rng = new RNG(20260902);

  // ---------- 1. 用噪声生成洞穴 ----------
  console.log('【1】地形生成（Noise）');
  const W = 32;
  const H = 20;
  const noise = new Noise(rng.int(100000));
  const height = noise.heightMap(W, H, 0.12, { octaves: 4 });

  const grid = new GridGraph(W, H);
  let walls = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const isWall = height[y * W + x] < 0.40;
      grid.setWalkable(x, y, !isWall);
      if (isWall) walls++;
    }
  }
  // 边界设为墙
  for (let x = 0; x < W; x++) {
    grid.setWalkable(x, 0, false);
    grid.setWalkable(x, H - 1, false);
  }
  console.log(`  地图 ${W}×${H}，墙 ${walls} 格，可走 ${grid.walkableCount} 格`);
  mainLog.info('地形生成完毕', { walls, walkable: grid.walkableCount });

  // ---------- 2. 找一条通路 ----------
  console.log('\n【2】寻路（A*）');
  // 找两个可走点
  let a: { x: number; y: number } | null = null;
  let b: { x: number; y: number } | null = null;
  for (let y = 1; y < H - 1 && !a; y++) {
    for (let x = 1; x < W - 1 && !a; x++) if (grid.isWalkable(x, y)) a = { x, y };
  }
  for (let y = H - 2; y > 0 && !b; y--) {
    for (let x = W - 2; x > 0 && !b; x--) if (grid.isWalkable(x, y)) b = { x, y };
  }

  if (a && b) {
    let path = findPath(grid, a, b, { allowDiagonal: true, maxNodes: 5000 });

    /**
     * 连通性修复（真实 Roguelike 的必备步骤）
     *
     * 纯噪声生成的洞穴经常是不连通的——几个独立的空腔。
     * 如果不处理，玩家会生成在一个走不出去的房间里。
     *
     * 常见做法：① 丢弃重生成 ② 用洪水填充找出主区域，其余填死
     *           ③ 在区域之间挖走廊。
     * 这里用最简单的"挖一条 L 形走廊"演示思路。
     */
    if (!path) {
      console.log(`  (${a.x},${a.y}) → (${b.x},${b.y})：不连通，挖走廊修复`);
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      for (let x = x0; x <= x1; x++) grid.setWalkable(x, a.y, true);
      for (let y = y0; y <= y1; y++) grid.setWalkable(b.x, y, true);
      path = findPath(grid, a, b, { allowDiagonal: true, maxNodes: 5000 });
    }

    if (path) {
      const smooth = smoothPath(grid, path);
      console.log(`  (${a.x},${a.y}) → (${b.x},${b.y})`);
      console.log(
        `  原始路径 ${path.length} 步，平滑后 ${smooth.length} 步` +
          `（少了 ${path.length - smooth.length} 个锯齿点，敌人移动更自然）`
      );
    } else {
      console.log('  仍然找不到路（极少数情况，真实项目里应丢弃这张图重新生成）');
    }
  }

  // ---------- 3. 敌人与空间哈希 ----------
  console.log('\n【3】范围查询（SpatialHash）');
  interface Enemy {
    id: string;
    x: number;
    y: number;
    hp: number;
  }
  const hash = new SpatialHash<Enemy>({ cellSize: 5 });

  // 在可走位置放几个敌人
  const enemies: Enemy[] = [];
  let placed = 0;
  for (let y = 1; y < H - 1 && placed < 12; y++) {
    for (let x = 1; x < W - 1 && placed < 12; x++) {
      if (grid.isWalkable(x, y) && (x * 7 + y * 3) % 5 === 0) {
        const e: Enemy = { id: `e${placed}`, x, y, hp: 30 };
        enemies.push(e);
        hash.insert(e.id, e, x, y);
        placed++;
      }
    }
  }
  console.log(`  放置 ${enemies.length} 个敌人`);

  // 在敌人密集处爆炸
  const center = enemies.length > 0 ? enemies[0] : { x: 5, y: 5 };
  const hits = hash.queryCircle(center.x, center.y, 6);
  console.log(`  以 (${center.x},${center.y}) 为中心、半径 6 的爆炸命中 ${hits.length} 个`);

  // 忘记 update 会怎样
  const moved = enemies[0];
  moved.x += 50;
  moved.y += 50;
  const stale = hash.queryCircle(moved.x, moved.y, 3);
  console.log(`  移动后**未** update 就查询：命中 ${stale.length} 个（应为 0 —— 这就是那个坑）`);
  hash.update(moved.id, moved.x, moved.y);
  const fresh = hash.queryCircle(moved.x, moved.y, 3);
  console.log(`  update 之后再查询：命中 ${fresh.length} 个（应为 1）`);

  // ---------- 4. 战斗：PRD 暴击 + Buff 中毒 ----------
  console.log('\n【4】战斗（PRD + BuffSystem + NumberRoller）');

  const crit = PRD.fromChance(0.3);
  const buffs = new BuffSystem();
  buffs.register({ id: 'poison', duration: 3, maxStacks: 5, tickInterval: 1, tags: ['debuff'] });

  const hpBar = new NumberRollerCore({ duration: { min: 0.3, max: 1.0 } });
  hpBar.snapTo(200);

  let totalDamage = 0;
  let critCount = 0;
  const poisonDamage: number[] = [];

  buffs.apply('poison', 2); // 上两层毒

  // 模拟 3 秒战斗，60fps
  for (let f = 0; f < 180; f++) {
    const dt = 1 / 60;

    // 每 0.5 秒攻击一次
    if (f % 30 === 0) {
      const isCrit = crit.roll(rng);
      if (isCrit) critCount++;
      totalDamage += isCrit ? 30 : 10;
    }

    // 中毒每秒跳一次
    buffs.update(dt, (id, stacks) => {
      if (id === 'poison') poisonDamage.push(5 * stacks);
    });
  }

  const poisonTotal = poisonDamage.reduce((s, v) => s + v, 0);
  hpBar.set(200 - totalDamage - poisonTotal);
  hpBar.update(2); // 滚完

  console.log(`  3 秒内攻击 6 次，暴击 ${critCount} 次`);
  console.log(`  直接伤害 ${totalDamage}，中毒跳了 ${poisonDamage.length} 次共 ${poisonTotal}`);
  console.log(`  血条：200 → ${hpBar.displayInt}（格式化："${hpBar.formatted}"）`);
  console.log(`  ↑ 中毒每次 5×层数，层数 2 → 每次 10 点`);

  // 驱散
  const dispelled = buffs.removeByTag('debuff');
  console.log(`  驱散 debuff：移除 ${dispelled} 个`);

  // ---------- 5. 掉落 + 保底 ----------
  console.log('\n【5】掉落与保底（LootTable）');
  const bossLoot = new LootTable('boss')
    .entry({ id: '金币', weight: 100, min: 20, max: 60 })
    .entry({ id: '药水', weight: 30, min: 1, max: 2 })
    .entry({ id: '传说武器', weight: 3, min: 1, max: 1, rare: true })
    .withPity({ threshold: 8 });

  let pityTriggered = 0;
  for (let i = 0; i < 200; i++) {
    for (const d of bossLoot.roll(rng)) if (d.fromPity) pityTriggered++;
  }
  console.log(`  刷 200 次，保底触发 ${pityTriggered} 次（阈值 8，理论上不会连续 8 次不出）`);
  console.log(`  UI 可显示"再 ${bossLoot.pityRemaining} 次必出稀有"`);

  // ---------- 6. 三选一 ----------
  console.log('\n【6】三选一奖励（Chest）');
  const relicPool = ['火焰之心', '冰霜之握', '雷霆之刃', '石肤', '疾风靴', '吸血獠牙', '智慧之冠'];
  const chest = new Chest(relicPool, { count: 3, owned: ['石肤'] });

  const options = chest.roll(rng);
  console.log(`  选项：${options.join(' / ')}`);
  console.log(`  （"石肤"已拥有，不会出现）`);

  const before = chest.current.slice();
  chest.reroll(rng);
  const after = chest.current;
  const hasOverlap = after.some((x) => before.includes(x));
  console.log(`  reroll 后：${after.join(' / ')}`);
  console.log(`  与 reroll 前有重叠吗：${hasOverlap}（应 false —— 保证每次 reroll 都有变化）`);

  const picked = chest.take(0);
  console.log(`  玩家选择了：${picked}`);

  // ---------- 7. 成就 ----------
  console.log('\n【7】成就（ConditionEngine）');
  const cond = new ConditionEngine();
  cond.register({ id: '初次击杀', conditions: [{ stat: 'kill', op: '>=', value: 1 }] });
  cond.register({
    id: '屠戮者',
    logic: 'and',
    conditions: [
      { stat: 'kill', op: '>=', value: 10 },
      { stat: 'floor', op: '>=', value: 2 },
    ],
  });

  for (let i = 0; i < 10; i++) cond.addStat('kill', 1);
  cond.setStat('floor', 1);

  const done1 = cond.check();
  console.log(`  击杀 10 次、第 1 层 → 解锁：${done1.join(', ')}`);
  console.log(`  "屠戮者"进度：${(cond.progress('屠戮者') * 100).toFixed(0)}%（还差楼层）`);

  cond.setStat('floor', 2);
  const done2 = cond.check();
  console.log(`  到达第 2 层 → 解锁：${done2.join(', ')}`);
  console.log(`  ↑ check() 只返回**新完成**的，不会重复发奖`);

  // ---------- 8. 飘字动画 ----------
  console.log('\n【8】飘字（Tween）');
  const runner = new TweenRunner();
  let floatY = 0;
  let opacity = 255;

  runner.add(
    new Tween(0.8)
      .ease('outQuad')
      .onUpdate((p) => {
        floatY = 80 * p;
        opacity = 255 * (1 - p * p);
      })
      .onComplete(() => console.log('  飘字结束'))
  );

  runner.update(0.4);
  console.log(`  播放到一半：y=${floatY.toFixed(1)} 透明度=${opacity.toFixed(0)}`);
  runner.update(0.5);
  console.log(`  播放结束：Runner 里还有 ${runner.count} 个动画（自动清理）`);

  // ---------- 9. 存档 ----------
  console.log('\n【9】存档（SaveManager）');
  const storage = new MemoryStorage();
  const saves = new SaveManager(storage, { gameId: 'mini-roguelike', version: 2 });
  saves.registerMigration(1, 2, (d) => ({ ...d, relics: d.relics ?? [] }));

  saves.write('slot1', { floor: 3, kill: 10, relics: [picked] });
  const loaded = saves.read<{ floor: number; kill: number; relics: string[] }>('slot1');
  if (loaded.ok) {
    console.log(`  读档成功：第 ${loaded.value.floor} 层，击杀 ${loaded.value.kill}，遗物 ${loaded.value.relics.join(',')}`);
  }

  // 手改存档
  const raw = JSON.parse(storage.read('save_slot1')!);
  raw.data.kill = 999999;
  storage.write('save_slot1', JSON.stringify(raw));
  const tampered = saves.read('slot1');
  console.log(`  手改存档后读取：${tampered.ok ? '成功（不应该！）' : tampered.error}`);

  // ---------- 10. Result ----------
  console.log('\n【10】错误处理（Result）');
  function pickup(item: string, bagFull: boolean): { ok: true; value: string } | { ok: false; error: string } {
    if (bagFull) return err<string>('背包已满');
    return ok(`获得 ${item}`);
  }

  const r1 = pickup('金币', false);
  console.log(`  ${r1.ok ? r1.value : r1.error}`);
  const r2 = pickup('药水', true);
  console.log(`  ${r2.ok ? r2.value : r2.error}（不处理就取不到 value，编译器会拦）`);

  // ---------- 收尾 ----------
  console.log('\n【缓冲日志】最后几条：');
  log.setLevel(LogLevel.Info);
  const recent = log.exportText().split('\n').slice(-3);
  recent.forEach((l) => console.log('  ' + l));

  console.log('\n========== 示例结束 ==========');
  console.log('提示：这个例子只用纯逻辑插件，所以能在 Node 里直接跑。');
  console.log('真实项目里把渲染、节点操作接上去即可。');
}

declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== 'undefined' && require?.main === module) {
  main();
}

export { main };
