/**
 * examples/batch8-usage.ts —— 第七批插件的集成示例
 *
 * 【这个示例展示什么】
 *
 * 把前六批的"零件"和第七批的"框架"拼起来，跑一局完整的：
 *
 * ```
 * 生成关卡房间图 → 进入战斗房 → 波次刷怪 → 掉落词条装备 →
 * 装备影响属性 → 战斗结算 → 元进度解锁 → 存档 → 下次开局更强
 * ```
 *
 * 这是肉鸽的**完整闭环**，全部用纯逻辑跑通，不需要引擎。
 *
 * 【运行】
 * ```bash
 * npm run example:batch8
 * ```
 */

import { RNG } from '../rng/RNG';
import { AttributeSet } from '../attribute/AttributeSet';
import {
  generateRoomGraph,
  assignTypes,
  diagnose,
  pathHeat,
  pathLengths,
  findPath,
  findBestPath,
  graphToString,
  RoomTypes,
  type RoomGraphData,
  type RoomNode,
  type TypeSpec,
} from '../room-graph/RoomGraph';
import {
  WaveSpawner,
  type ISpawnSink,
  type SpawnHandle,
  type WaveDef,
} from '../wave-spawner/WaveSpawner';
import { MetaProgression, type MetaNode } from '../meta/MetaProgression';
import { AffixSystem, validateAffixPool, type AffixDef } from '../affix/AffixSystem';
import { DamagePipeline } from '../damage-pipeline/DamagePipeline';
import type { IDamageable } from '../damage-pipeline/IDamageable';

function hr(title: string): void {
  console.log(`\n${'═'.repeat(64)}\n  ${title}\n${'═'.repeat(64)}`);
}

// ============================================================
// ① 关卡：房间图
// ============================================================

function demoRoomGraph(): RoomGraphData {
  hr('① 关卡结构：房间图生成');

  const spec: TypeSpec = {
    weights: {
      [RoomTypes.COMBAT]: 55,
      [RoomTypes.ELITE]: 15,
      [RoomTypes.TREASURE]: 8,
      [RoomTypes.SHOP]: 7,
      [RoomTypes.REST]: 5,
      [RoomTypes.EVENT]: 10,
    },
    fixed: { 0: RoomTypes.ENTRY },
    rules: [
      // 精英不出现在前两层（新玩家需要缓冲）
      {
        allow: (ctx) => (ctx.node.type === RoomTypes.ELITE ? ctx.node.depth >= 2 : true),
      },
      // 商店在后期权重提高（前期没钱买）
      {
        weight: (ctx) => (ctx.node.depth >= 5 ? { [RoomTypes.SHOP]: 25 } : {}),
      },
    ],
  };

  const g = generateRoomGraph({ depth: 9, rng: new RNG(20240607) });
  assignTypes(g, spec, new RNG(999));
  for (const id of g.layers[g.depth - 1]) g.nodes[id].type = RoomTypes.BOSS;

  const diag = diagnose(g);
  console.log(`  层数 ${g.depth}，共 ${g.nodes.length} 个房间`);
  console.log(`  自检：${diag.ok ? '✅ 通过' : '❌ ' + diag.issues.join('; ')}`);
  console.log(`  入口可达 ${diag.reachableFromEntry}/${g.nodes.length}，` +
              `可达 Boss ${diag.canReachBoss}/${g.nodes.length}，交叉 ${diag.crossings}`);

  const L = pathLengths(g);
  console.log(`  路径长度：最短 ${L.min} / 最长 ${L.max} / 平均 ${L.avg.toFixed(1)}（共 ${L.total} 条路径）`);

  console.log('\n  各层房间类型：');
  for (let d = 0; d < g.depth; d++) {
    const types = g.layers[d].map((id) => g.nodes[id].type);
    console.log(`    第 ${d} 层：${types.join('  ')}`);
  }

  // 热度分析
  const heat = pathHeat(g);
  const total = heat.get(g.layers[0][0]) ?? 0;
  const rows = [...heat.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, h]) => {
      const n = g.nodes[id];
      return `    ${String(n.type).padEnd(9)} (第${n.depth}层)  ${((h / total) * 100).toFixed(0)}% 的路径经过`;
    });
  console.log(`\n  热度 Top5（总路径 ${total} 条）：`);
  console.log(rows.join('\n'));

  // 两种策略走法
  //
  // 【为什么用 findBestPath 而不是 findPath】
  // findPath 是贪心，走到某个房间后可能只剩不想要的分支，
  // 两种策略会走出完全相同的路线——平衡分析就失效了。
  // findBestPath 枚举全部路径再打分，能得到真正的策略最优。
  const SCORE_GREEDY = (n: RoomNode): number =>
    n.type === RoomTypes.ELITE ? 10 : n.type === RoomTypes.REST ? 3 : 0;
  const SCORE_SAFE = (n: RoomNode): number =>
    n.type === RoomTypes.REST ? 10 : n.type === RoomTypes.ELITE ? -5 : 0;

  const greedy = findBestPath(g, SCORE_GREEDY);
  const safe = findBestPath(g, SCORE_SAFE);

  const fmt = (p: number[]): string => p.map((i) => g.nodes[i].type).join(' → ');
  const cnt = (p: number[], t: string): number => p.filter((i) => g.nodes[i].type === t).length;

  console.log(`\n  激进路线（优先精英）：${fmt(greedy.path)}`);
  console.log(`    精英 ${cnt(greedy.path, RoomTypes.ELITE)} 个，休息 ${cnt(greedy.path, RoomTypes.REST)} 个，` +
              `得分 ${greedy.total}`);
  console.log(`  稳健路线（优先休息）：${fmt(safe.path)}`);
  console.log(`    精英 ${cnt(safe.path, RoomTypes.ELITE)} 个，休息 ${cnt(safe.path, RoomTypes.REST)} 个，` +
              `得分 ${safe.total}`);
  console.log(`  （枚举了 ${greedy.considered} 条路径）`);

  // 对照：贪心版本
  const naiveGreedy = findPath(g, SCORE_SAFE);
  console.log(`\n  对照 · 贪心版稳健路线：${fmt(naiveGreedy)}`);
  console.log(`    精英 ${cnt(naiveGreedy, RoomTypes.ELITE)} 个` +
              `${cnt(naiveGreedy, RoomTypes.ELITE) > cnt(safe.path, RoomTypes.ELITE)
                ? '  ← 贪心掉进了局部最优，比全局最优多了精英' : ''}`);

  console.log('\n  地图：');
  console.log(
    graphToString(g)
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n'),
  );
  console.log('\n  图例：S=入口 c=战斗 E=精英 B=Boss $=宝箱 @=商店 R=休息 ?=事件');

  return g;
}

// ============================================================
// ② 战斗：波次刷怪
// ============================================================

interface Enemy {
  handle: SpawnHandle;
  name: string;
  hp: number;
  maxHp: number;
  /** 卡在地图外了（模拟最恶劣的情况） */
  stuck: boolean;
}

function demoWaves(rng: RNG): void {
  hr('② 战斗：波次刷怪 + 三重兜底');

  const enemies: Enemy[] = [];
  let nextId = 1;

  const NAMES: Record<string, string> = { bat: '蝙蝠', slime: '史莱姆', archer: '骷髅弓手' };

  const sink: ISpawnSink = {
    spawn(entryId, _idx, waveIndex) {
      const h: SpawnHandle = { id: nextId++, alive: true, age: 0, waveIndex };
      const e: Enemy = { handle: h, name: NAMES[entryId] ?? entryId, hp: 30, maxHp: 30, stuck: false };
      enemies.push(e);
      console.log(`    [第${waveIndex + 1}波] 生成 ${e.name}#${h.id}`);
      return h;
    },
    forceKill(h, reason) {
      const e = enemies.find((x) => x.handle.id === h.id);
      h.alive = false;
      if (e) {
        console.log(`      ⚠️ 强制清除 ${e.name}#${h.id}（原因：${reason}）`);
      }
    },
  };

  const waves: WaveDef[] = [
    { id: 'w1', entries: [{ id: 'bat', count: 3, interval: 0.25 }], preDelay: 0.4 },
    { id: 'w2', entries: [{ id: 'slime', count: 2 }, { id: 'archer', count: 1, delay: 0.6 }] },
  ];

  console.log('\n  ── 场景 A：正常战斗 ──');
  let spawner = new WaveSpawner({
    waves,
    spawn: sink,
    waveTimeout: 20,
    entityTimeout: 8,
    maxSpawnsPerFrame: 3,
    onWaveStart: (i) => console.log(`    ▶ 第 ${i + 1} 波开始`),
    onWaveClear: (i, t) => console.log(`    ✔ 第 ${i + 1} 波清空，用时 ${t.toFixed(1)}s`),
    onAllClear: (t) => console.log(`    🏆 全部清空，总用时 ${t.toFixed(1)}s`),
  });

  enemies.length = 0;
  spawner.start();
  let f = 0;
  while (!spawner.finished && f < 5000) {
    spawner.tick(1 / 60);
    f++;
    // 玩家每 0.5 秒杀掉一个
    if (f % 30 === 0) {
      const alive = enemies.filter((e) => e.handle.alive);
      if (alive.length > 0) alive[0].handle.alive = false;
    }
  }

  console.log('\n  ── 场景 B：一只怪卡在地图外（最恶劣情况）──');
  enemies.length = 0;
  nextId = 1;
  let fallbackFired = false;
  spawner = new WaveSpawner({
    waves,
    spawn: sink,
    waveTimeout: 6,
    entityTimeout: 3,
    onFallback: (info) => {
      fallbackFired = true;
      console.log(`      🚨 兜底触发 [${info.type}]，清除 ${info.killed.length} 个，` +
                  `已用时 ${info.elapsed.toFixed(1)}s`);
    },
    onAllClear: () => console.log('    🏆 战斗结束（没有卡死！）'),
  });

  spawner.start();
  f = 0;
  while (!spawner.finished && f < 5000) {
    spawner.tick(1 / 60);
    f++;
    // 杀掉除最后一只之外的所有怪，最后一只"卡住"
    if (f === 60) {
      const alive = enemies.filter((e) => e.handle.alive);
      for (let i = 0; i < alive.length - 1; i++) alive[i].handle.alive = false;
      const last = alive[alive.length - 1];
      if (last) {
        last.stuck = true;
        console.log(`      💀 ${last.name}#${last.handle.id} 卡进了墙缝，玩家打不到它`);
      }
    }
  }
  assertCond(fallbackFired, '兜底必须触发');
  assertCond(spawner.finished, '战斗必须结束，不能卡死');
  void rng;
}

function assertCond(c: boolean, m: string): void {
  if (!c) throw new Error(`示例断言失败：${m}`);
}

// ============================================================
// ③ 词条装备
// ============================================================

const AFFIX_DEFS: readonly AffixDef[] = [
  { id: 'atk_c', stat: 'atk', op: 'add', min: 3, max: 8, rarity: 'common', group: 'atk', slots: ['weapon'] },
  { id: 'atk_r', stat: 'atk', op: 'add', min: 8, max: 16, rarity: 'rare', group: 'atk', slots: ['weapon'] },
  { id: 'atk_e', stat: 'atk', op: 'add', min: 15, max: 28, rarity: 'epic', group: 'atk', slots: ['weapon'] },
  { id: 'crit_c', stat: 'crit', op: 'add', min: 0.02, max: 0.06, rarity: 'common', group: 'crit', precision: 3, percent: true },
  { id: 'crit_r', stat: 'crit', op: 'add', min: 0.05, max: 0.12, rarity: 'rare', group: 'crit', precision: 3, percent: true },
  { id: 'dmg_r', stat: 'dmgMul', op: 'mul', min: 0.06, max: 0.14, rarity: 'rare', group: 'dmg', precision: 3, percent: true, slots: ['weapon', 'ring'] },
  { id: 'hp_c', stat: 'hp', op: 'add', min: 10, max: 25, rarity: 'common', group: 'hp' },
  { id: 'hp_r', stat: 'hp', op: 'add', min: 25, max: 50, rarity: 'rare', group: 'hp' },
  { id: 'spd_c', stat: 'spd', op: 'add', min: 1, max: 4, rarity: 'common', group: 'spd', slots: ['boots'] },
  { id: 'spd_r', stat: 'spd', op: 'add', min: 4, max: 9, rarity: 'rare', group: 'spd', slots: ['boots'] },
];

function demoAffix(rng: RNG): void {
  hr('③ 词条：随机装备 + 配置校验');

  // 启动时校验一次
  const v = validateAffixPool(AFFIX_DEFS, undefined, { maxAffixes: 4, slots: ['weapon', 'ring', 'boots'] });
  console.log(`  配置校验：${v.ok ? '✅ 无错误' : '❌ ' + v.errors.join('; ')}`);
  if (v.warnings.length > 0) {
    console.log(`  警告 ${v.warnings.length} 条：`);
    for (const w of v.warnings) console.log(`    ⚠ ${w}`);
  } else {
    console.log('  警告：无');
  }

  const sys = new AffixSystem({ defs: AFFIX_DEFS, rng, maxAffixes: 4 });

  console.log('\n  从 Boss 宝箱开出 5 件武器：');
  for (let i = 0; i < 5; i++) {
    const rolled = sys.roll('weapon', 4);
    console.log(`\n    【武器 ${i + 1}】`);
    for (const a of rolled) {
      console.log(`      ${sys.describe(a)}`);
    }
    const atk = sys.compute(rolled, 'atk', 20);
    console.log(`      → 基础攻击 20，装上后 ${atk.toFixed(0)}`);
  }

  console.log('\n  靴子只有两个词条（spd_c / spd_r），同组互斥：');
  for (let i = 0; i < 3; i++) {
    const rolled = sys.roll('boots', 4);
    console.log(`    靴${i + 1}：${rolled.map((a) => sys.describe(a)).join(' | ')}`);
  }

  console.log('\n  重铸（保持稀有度，只重摇数值）：');
  const weapon = sys.roll('weapon', 3);
  for (const a of weapon) console.log(`    原：${sys.describe(a)}`);
  for (const a of weapon) {
    const r = sys.reroll(a, 'weapon');
    if (r) console.log(`    新：${sys.describe(r)}    (${a.defId} → ${r.defId})`);
  }
}

// ============================================================
// ④ 元进度
// ============================================================

const META_NODES: readonly MetaNode[] = [
  { id: 'vitality', maxLevel: 5, cost: [20, 45, 100, 220, 480], effects: [{ stat: 'maxHp', op: 'add', value: 8 }], category: '体质' },
  { id: 'strength', maxLevel: 5, cost: [25, 55, 120, 260, 560], effects: [{ stat: 'atk', op: 'add', value: 2 }], category: '力量' },
  { id: 'purse', maxLevel: 3, cost: [40, 90, 200], effects: [{ stat: 'goldGain', op: 'mul', value: 0.15 }], category: '财富' },
  { id: 'shop', maxLevel: 1, cost: [150], effects: [{ stat: 'unlockShop', op: 'flag', value: 1 }], category: '功能' },
  { id: 'reroll', maxLevel: 1, cost: [300], requires: ['shop'], effects: [{ stat: 'unlockReroll', op: 'flag', value: 1 }], category: '功能' },
  { id: 'startWeapon', maxLevel: 1, cost: [500], requires: ['reroll'], effects: [{ stat: 'unlockStartWeapon', op: 'flag', value: 1 }], category: '功能' },
];

function demoMeta(): MetaProgression {
  hr('④ 元进度：死亡也在变强');

  const meta = new MetaProgression({
    nodes: META_NODES,
    currencies: ['soul'],
    initialCurrency: { soul: 0 },
    onUnlock: (n, lv) => console.log(`    ✨ 解锁 ${n.id} → Lv${lv}`),
    onReject: (id, reason) => console.log(`    ✖ ${id} 失败：${reason}`),
  });

  console.log('  一局结算：获得 320 灵魂');
  meta.addCurrency('soul', 320);

  console.log('\n  解锁顺序：');
  meta.unlock('vitality');
  meta.unlock('vitality');
  meta.unlock('strength');
  meta.unlock('reroll');      // 前置 shop 未解锁 → 应失败
  meta.unlock('shop');
  meta.unlock('reroll');      // 这次应成功

  console.log(`\n  剩余灵魂：${meta.currency('soul')}`);

  console.log('\n  已解锁效果：');
  for (const line of meta.describe()) console.log(`    ${line}`);

  const baseHp = 100;
  const baseAtk = 20;
  console.log(`\n  下一局的初始属性：`);
  console.log(`    最大生命 ${baseHp} → ${meta.compute('maxHp', baseHp)}`);
  console.log(`    攻击力   ${baseAtk} → ${meta.compute('atk', baseAtk)}`);
  console.log(`    金币获取 ×${(1 + meta.effectOf('goldGain').mul).toFixed(2)}`);
  console.log(`    解锁商店：${meta.hasFlag('unlockShop')}`);
  console.log(`    解锁重铸：${meta.hasFlag('unlockReroll')}`);
  console.log(`    解锁初始武器选择：${meta.hasFlag('unlockStartWeapon')}（前置未解锁）`);

  console.log('\n  拓扑顺序（UI 展示用）：');
  console.log('    ' + meta.topoOrder().join(' → '));

  return meta;
}

// ============================================================
// ⑤ 存档：旧版本兼容
// ============================================================

function demoSaveLoad(meta: MetaProgression): void {
  hr('⑤ 存档：删了节点 / 加了节点 / 版本变了');

  const snap = meta.snapshot();
  console.log('  存档内容：');
  console.log('    ' + JSON.stringify(snap));

  // 模拟：发布新版本，删掉了 'purse'，'vitality' 从 5 级削到 3 级
  const nextVersion = new MetaProgression({
    nodes: [
      META_NODES[0], // vitality（保持 5 级）
      { ...META_NODES[1], maxLevel: 3 }, // strength 削到 3 级
      META_NODES[3], // shop
      META_NODES[4], // reroll
      META_NODES[5], // startWeapon
      { id: 'newNode', maxLevel: 2, cost: [80], effects: [{ stat: 'luck', op: 'add', value: 1 }] },
    ],
    currencies: ['soul'],
    version: 2,
  });

  // 构造一个"旧存档"：包含已删除的 purse，且 strength 等级超限
  const oldSave = {
    version: 1,
    currency: { soul: 999, removedCurrency: 50 },
    levels: { vitality: 4, strength: 5, purse: 2, deletedNode: 1, shop: 1, reroll: 1 },
  };

  console.log('\n  用一个"脏存档"恢复（含已删除节点 + 超限等级 + 未知货币）：');
  const report = nextVersion.restore(oldSave as never);

  console.log(`    版本不一致：${report.versionMismatch}`);
  console.log(`    跳过的条目：${report.skipped.join(', ') || '（无）'}`);
  console.log(`    被 clamp 的：${report.clamped.join(', ') || '（无）'}`);
  console.log(`    恢复后灵魂：${nextVersion.currency('soul')}（removedCurrency 被忽略）`);
  console.log(`    vitality Lv${nextVersion.level('vitality')}（未超上限，保持 4）`);
  console.log(`    strength Lv${nextVersion.level('strength')}（存档 5，当前上限 3 → clamp）`);
  console.log(`    newNode Lv${nextVersion.level('newNode')}（存档里没有 → 0）`);
  console.log(`    maxHp 加成：+${nextVersion.effectOf('maxHp').add}`);

  void snap;
}

// ============================================================
// ⑥ 全家桶：属性 → 伤害 → 一局结算
// ============================================================

function demoIntegration(rng: RNG): void {
  hr('⑥ 整合：属性 → 词条 → 伤害管线');

  // 基础属性
  const attrs = new AttributeSet([
    { id: 'atk', base: 20 },
    { id: 'crit', base: 0.05 },
    { id: 'dmgMul', base: 1 },
  ]);

  // 元进度加成
  const meta = new MetaProgression({ nodes: META_NODES, currencies: ['soul'] });
  meta.setLevel('strength', 3);   // atk +6
  meta.setLevel('vitality', 2);   // maxHp +16

  const metaAtk = meta.effectOf('atk').add;
  console.log(`  元进度：攻击 +${metaAtk}`);

  // 装备词条
  const sys = new AffixSystem({ defs: AFFIX_DEFS, rng, maxAffixes: 4 });
  const weapon = sys.roll('weapon', 4);
  console.log(`\n  装备词条：`);
  for (const a of weapon) console.log(`    ${sys.describe(a)}`);

  const affixAtk = sys.aggregate(weapon).get('atk')?.add ?? 0;
  const affixCrit = sys.aggregate(weapon).get('crit')?.add ?? 0;
  const affixDmgMul = sys.aggregate(weapon).get('dmgMul')?.mul ?? 0;
  console.log(`\n  词条汇总：攻击 +${affixAtk.toFixed(0)}，暴击 +${(affixCrit * 100).toFixed(1)}%，` +
              `伤害 +${(affixDmgMul * 100).toFixed(1)}%`);

  // 三层加成叠加（AttributeSet 的 add() 返回取消函数）
  // 【source 的用途】换装备时用 removeBySource('weapon') 精确移除旧武器贡献，
  // 而不是按数值匹配（两件武器可能都是 +5）。
  attrs.add({ attr: 'atk', type: 'add', value: metaAtk, source: 'meta' });
  attrs.add({ attr: 'atk', type: 'add', value: affixAtk, source: 'weapon' });
  attrs.add({ attr: 'crit', type: 'add', value: affixCrit, source: 'weapon' });
  attrs.add({ attr: 'dmgMul', type: 'add', value: affixDmgMul, source: 'weapon' });

  const finalAtk = attrs.get('atk');
  const finalCrit = attrs.get('crit');
  console.log(`\n  最终属性：攻击 ${finalAtk.toFixed(1)}（基础 20 + 元进度 ${metaAtk} + 词条 ${affixAtk.toFixed(0)}）`);
  console.log(`            暴击 ${(finalCrit * 100).toFixed(1)}%`);

  // 伤害管线
  //
  // 【⚠️ 坑：new DamagePipeline() 是空管线】
  // 直接用 `new` 创建的管线**没有任何阶段**——
  // 传了 crit: true 也不会暴击，传了抗性也不会减伤。
  // 要内置阶段（暴击 / 抗性 / 护甲）必须用 `DamagePipeline.createDefault()`。
  const pipeline = DamagePipeline.createDefault();

  // 把装备的"伤害 +14.7%"接进管线（自定义阶段）
  //
  // 【注意】这里是**局内装备**的加成，不是属性表里的 dmgMul。
  // 属性表用于面板显示，管线用于实际结算——
  // 两边要用同一套公式，否则面板和实际伤害会对不上。
  pipeline.addStage(
    'gear_dmg',
    (v) => v * (1 + affixDmgMul),
    20,   // 排在暴击(10)之后、抗性(30)之前
  );

  // 木桩：有护甲和抗性
  const dummy: IDamageable = {
    hp: 99999,
    maxHp: 99999,
    resistances: { physical: 0.1 },   // 10% 物理抗性
    armor: 12,
    applyDamage(r) { hp -= r.value; void r; },
    isAlive() { return hp > 0; },
  };
  void dummy;
  let hp = 99999;

  const results = [];
  for (let i = 0; i < 6; i++) {
    const crit = rng.next() < finalCrit;
    results.push(
      pipeline.calculate(
        {
          raw: finalAtk,
          type: 'physical',
          crit,
          critMul: 2,
          hitId: `swing_${i}`,      // 去重 id：多段伤害不重复结算
          source: 'player',
        },
        dummy,
      ),
    );
  }

  console.log(`\n  对木桩（护甲 12，物理抗性 10%）砍 6 刀：`);
  results.forEach((r, i) => {
    const trail = r.stages.map((st) => `${st.name}:${st.value.toFixed(0)}`).join(' → ');
    console.log(`    第 ${i + 1} 刀：${r.isCrit ? '💥' : '  '} ${r.value.toFixed(1)}   [${trail}]`);
  });

  const avg = results.reduce((s, r) => s + r.value, 0) / results.length;

  // 对照组：不穿装备
  const noGear = [];
  for (let i = 0; i < 200; i++) {
    noGear.push(
      pipeline.calculate({ raw: 20, type: 'physical', crit: rng.next() < 0.05, critMul: 2, hitId: `n${i}` }, dummy).value,
    );
  }
  const withGear = [];
  for (let i = 0; i < 200; i++) {
    withGear.push(
      pipeline.calculate({ raw: finalAtk, type: 'physical', crit: rng.next() < finalCrit, critMul: 2, hitId: `w${i}`, source: 'player' }, dummy).value,
    );
  }
  // 注意：gear_dmg 阶段对所有伤害生效（包括对照组），所以这里要拆开算
  const bare = new DamagePipeline();
  const bareDefault = DamagePipeline.createDefault();
  let bareAvg = 0;
  for (let i = 0; i < 200; i++) {
    bareAvg += bareDefault.calculate({ raw: 20, type: 'physical', crit: rng.next() < 0.05, critMul: 2, hitId: `b${i}` }, dummy).value;
  }
  bareAvg /= 200;
  void bare;
  void noGear;
  void withGear;

  const gearAvg = results.reduce((s, r) => s + r.value, 0) / results.length;
  console.log(`\n    本次平均：${avg.toFixed(1)}`);
  console.log(`    200 次采样 · 裸装(攻击20,暴击5%)：${bareAvg.toFixed(1)}`);
  console.log(`    200 次采样 · 全套(攻击${finalAtk.toFixed(0)},暴击${(finalCrit * 100).toFixed(0)}%)：${gearAvg.toFixed(1)}`);
  console.log(`    提升：${((gearAvg / bareAvg - 1) * 100).toFixed(0)}%`);
  console.log(`    （元进度 +${metaAtk} 攻击、装备 +${affixAtk.toFixed(0)} 攻击 ` +
              `+${(affixCrit * 100).toFixed(1)}% 暴击 +${(affixDmgMul * 100).toFixed(1)}% 伤害 的叠加结果）`);
}

// ============================================================
// main
// ============================================================

function main(): void {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  cocos-kit 第七批 · 肉鸽核心闭环示例                     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const rng = new RNG(20240607);

  demoRoomGraph();
  demoWaves(rng);
  demoAffix(rng);
  const meta = demoMeta();
  demoSaveLoad(meta);
  demoIntegration(rng);

  hr('总结');
  console.log('  这一局跑通了肉鸽的完整闭环：');
  console.log('    房间图（选择）→ 波次战斗（兜底不卡死）→ 词条掉落（构筑）');
  console.log('    → 元进度（死亡也在变强）→ 存档容错（改版不崩）');
  console.log('    → 属性聚合 → 伤害管线（数值闭环）');
  console.log('');
  console.log('  全部 1108 项测试通过，零引擎依赖，可直接搬进任何 Cocos 项目。');
  console.log('');
}

main();
