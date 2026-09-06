/**
 * examples/batch12-usage.ts —— 第十一批插件集成示例
 *
 * 【这个示例展示什么】
 *
 * 这一批的四个插件都在回答同一个问题：
 * **"多个小机制怎么组合成一个功能"**
 *
 * ```
 * ① 技能变体  —— 补丁 + 条件 + 深拷贝 = 遗物改造技能
 * ② 祝福      —— 堆叠 + 递减 + 互斥 = 局内强化
 * ③ 诅咒      —— 增益 + 代价时机 + 移除条件 = 有代价的强化
 * ④ 环境互动  —— 目标选择 + 触发条件 + 状态管理 = 可交互物
 * ```
 *
 * 这也是本库「功能模块」概念的实际演示：
 * 每个插件内部都由几个平级的小机制组成，
 * 它们谁也不是谁的前置，但合起来才是一个完整功能。
 *
 * 【运行】
 * ```bash
 * npm run example:batch12
 * ```
 */

import { SkillVariantSystem } from '../skill-variant/SkillVariant';
import { BlessingSystem, type BlessingDef } from '../blessing/Blessing';
import { CurseSystem, type CurseDef } from '../curse/Curse';
import { InteractSystem, type Interactable } from '../interact/Interact';
import { RNG } from '../rng/RNG';

function hr(title: string): void {
  console.log(`\n${'═'.repeat(66)}\n  ${title}\n${'═'.repeat(66)}`);
}

// ============================================================
// ① 技能变体
// ============================================================

function demoSkillVariant(): void {
  hr('① 技能变体：遗物如何改造技能');

  type Skill = {
    id: string;
    name: string;
    cooldown: number;
    damage: { raw: number };
    projectile: { count: number; speed: number; pierce: number };
    tags: string[];
  };

  const fireball: Skill = {
    id: 'fireball', name: '火球术', cooldown: 3,
    damage: { raw: 20 }, projectile: { count: 1, speed: 12, pierce: 0 },
    tags: ['fire', 'ranged'],
  };

  const sys = new SkillVariantSystem<Skill>({
    evaluator: (c, ctx) => {
      if (c.id === 'lowHp') return (ctx.data['hpRate'] as number) < (c.params?.['t'] as number);
      return true;
    },
  });

  sys.registerAll([
    { id: 'multi', name: '多重投射',
      patches: [{ op: 'set', path: 'projectile.count', value: 3 }] },
    { id: 'pierce', name: '穿透',
      patches: [{ op: 'add', path: 'projectile.pierce', value: 2 }] },
    { id: 'power', name: '强化',
      patches: [{ op: 'mul', path: 'damage.raw', value: 1.5 }] },
    { id: 'desperate', name: '背水一战',
      conditions: [{ id: 'lowHp', params: { t: 0.3 } }],
      patches: [{ op: 'mul', path: 'damage.raw', value: 2 }] },
    { id: 'burn', name: '灼烧',
      patches: [{ op: 'push', path: 'tags', value: ['burn'] }] },
  ]);

  function show(label: string, ids: string[], hpRate: number): void {
    const { result, applied } = sys.apply(fireball, ids, { data: { hpRate } });
    console.log(`\n  ${label}`);
    console.log(`    变体：${applied.join('、') || '（无）'}`);
    console.log(`    弹数 ${result.projectile.count}  穿透 ${result.projectile.pierce}  ` +
                `伤害 ${result.damage.raw}  标签 [${result.tags.join(',')}]`);
  }

  show('【基础】什么都没拿', [], 1);
  show('【拿了三重】多重 + 穿透 + 强化', ['multi', 'pierce', 'power'], 1);
  show('【残血】同上 + 背水一战（血量 20%）', ['multi', 'pierce', 'power', 'desperate'], 0.2);
  show('【满血】同样持有背水一战但不触发', ['multi', 'pierce', 'power', 'desperate'], 1.0);

  console.log(`
  【⚠️ 深拷贝：本模块最重要的一行】

  如果不深拷贝，apply() 改的是**原型**，
  于是所有敌人、所有玩家的火球术都变成 3 发——
  而且不报错，只是"数值莫名其妙不对"。

  更糟的是它会累积：
    拿一次遗物 → 全局 +3 发
    拿两次     → 全局 +6 发
  玩家表现是"越玩越强，强得离谱"。`);

  const before = fireball.projectile.count;
  for (let i = 0; i < 5; i++) sys.apply(fireball, ['multi'], { data: {} });
  console.log(`  实测：应用 5 次后，原型弹数仍是 ${fireball.projectile.count}（应用前 ${before}）`);
}

// ============================================================
// ② 祝福
// ============================================================

function demoBlessing(): void {
  hr('② 祝福：可叠加的局内强化');

  const defs: BlessingDef[] = [
    { id: 'sharp', name: '锐利', weight: 100, maxStacks: 10,
      effects: [{ stat: 'atk', op: 'add', perStack: 2 }] },
    { id: 'greed', name: '贪婪', weight: 10, maxStacks: 20, softCap: 5, falloff: 0.5,
      effects: [{ stat: 'gold', op: 'mul', perStack: 1.2 }] },
    { id: 'flame', name: '火附魔', weight: 20, excludes: ['frost'],
      effects: [{ stat: 'atk', op: 'mul', perStack: 1.1 }] },
    { id: 'frost', name: '冰附魔', weight: 20, excludes: ['flame'],
      effects: [{ stat: 'atk', op: 'mul', perStack: 1.1 }] },
  ];

  const bs = new BlessingSystem({ defs, onConflict: 'reject' });

  console.log('\n  【线性叠加 vs 软上限递减】');
  console.log('  层数   锐利(无递减)   贪婪(softCap=5, falloff=0.5)');
  for (const n of [1, 3, 5, 8, 12, 20]) {
    const a = new BlessingSystem({ defs });
    a.add('sharp', n);
    a.add('greed', n);
    const linear = a.effectsOf('sharp')[0].value;
    const eff = a.effectiveStacks('greed');
    const bar = '█'.repeat(Math.round(eff));
    console.log(`   ${String(n).padStart(3)}      ${String(linear).padStart(4)}` +
                `          ${eff.toFixed(1).padStart(5)} 层  ${bar}`);
  }

  console.log(`
  【为什么需要递减】
  线性叠加下 20 层的强度是 1 层的 20 倍，数值曲线彻底失控。
  递减让"多拿"仍然有用，但不再是指数爆炸。

  配表时的经验：softCap 设在"玩家正常通关能拿到的层数"附近，
  falloff 取 0.4 ~ 0.6。太低会让多拿变得没意义。`);

  console.log('  【互斥：火 / 冰附魔不能共存】');
  bs.add('flame');
  console.log(`    持有火附魔后，再拿冰附魔 → ${bs.add('frost') === 0 ? '被拒绝 ✓' : '成功 ✗'}`);
  console.log(`    wouldConflict('frost') → ${bs.wouldConflict('frost')}`);

  console.log('\n  【三选一：已满层与冲突项不出现】');
  bs.add('sharp', 10);   // 满层
  const rng = new RNG(42);
  for (let i = 0; i < 3; i++) {
    const picked = bs.pick(rng, 3);
    console.log(`    第 ${i + 1} 次：${picked.map((d) => d.name).join('、') || '（无可选项）'}`);
  }
  console.log(`    ↑ 锐利已满层，冰附魔冲突，所以只剩下贪婪`);
}

// ============================================================
// ③ 诅咒
// ============================================================

function demoCurse(): void {
  hr('③ 诅咒：带代价的强化');

  const defs: CurseDef[] = [
    { id: 'greed_blood', name: '贪婪之血', desc: '攻击 +50%',
      effects: [{ stat: 'atk', op: 'mul', value: 1.5 }],
      costs: [{ trigger: 'onFloorEnd', payload: { type: 'maxHp', amount: -1 }, desc: '每层失去 1 点最大生命' }],
      removeCondition: { id: 'payGold', params: { amount: 100 }, desc: '献祭 100 金币' } },
    { id: 'bleeding', name: '流血', desc: '暴击率 +25%',
      effects: [{ stat: 'crit', op: 'add', value: 0.25 }],
      costs: [{ trigger: 'tick', payload: { type: 'hp', amount: -0.5 }, desc: '每秒失去 0.5 生命' }] },
    { id: 'brittle', name: '易碎护甲', desc: '减伤 +30%',
      effects: [{ stat: 'def', op: 'add', value: 30 }],
      costs: [{ trigger: 'event', event: 'crit_taken', payload: { type: 'dmgMul', amount: 2 }, desc: '受到暴击时伤害翻倍' }] },
    { id: 'time_debt', name: '时间债', desc: '冷却 -40%',
      effects: [{ stat: 'cdr', op: 'add', value: 0.4 }],
      costs: [{ trigger: 'onRunEnd', payload: { type: 'scoreMul', amount: 0.8 }, desc: '通关分数 -20%' }] },
  ];

  const log: string[] = [];
  let gold = 150;
  const cs = new CurseSystem({
    defs,
    executor: (cost, curse) => {
      const t = cost.payload['type'];
      if (t === 'maxHp') log.push(`  ${curse.name}：最大生命 ${cost.payload['amount']}`);
      if (t === 'hp') log.push(`  ${curse.name}：生命 ${cost.payload['amount']}`);
      if (t === 'dmgMul') log.push(`  ${curse.name}：这次伤害 ×${cost.payload['amount']}！`);
      if (t === 'scoreMul') log.push(`  ${curse.name}：结算分数 ×${cost.payload['amount']}`);
    },
    checker: (c) => gold >= (c.params?.['amount'] as number),
  });

  console.log('\n  【获得三个诅咒】');
  cs.add('greed_blood');
  cs.add('bleeding');
  cs.add('brittle');
  console.log(cs.describe());

  console.log('\n  【代价在不同时机触发】');
  log.length = 0;
  cs.tick();                       // bleeding 的持续掉血
  cs.trigger('hit_taken');         // 无关事件
  cs.trigger('crit_taken');        // brittle 的暴击代价
  cs.onFloorEnd();                 // greed_blood 的每层代价
  console.log(log.join('\n') || '  （无）');
  console.log(`  ↑ "hit_taken" 没有触发任何代价——事件名必须精确匹配`);

  console.log('\n  【移除条件】');
  console.log(`    当前金币 ${gold}`);
  console.log(`    贪婪之血可移除：${cs.canRemove('greed_blood')}（需要 100）`);
  gold = 50;
  console.log(`    金币降到 ${gold} 后：${cs.canRemove('greed_blood')}`);
  console.log(`    强行移除（付费服务）：${cs.remove('greed_blood', true)}`);

  console.log(`
  【⚠️ 迭代安全：代价执行中改变集合】

  宿主在 executor 里可能回调 remove()（比如代价致死导致清诅咒）。
  直接遍历 Map 会导致迭代失效——
  表现为"某个诅咒这帧莫名没触发"，而且不报错。

  本模块先快照再遍历，且每次都重新检查是否还在集合里。`);
}

// ============================================================
// ④ 环境互动
// ============================================================

function demoInteract(): void {
  hr('④ 环境互动：玩家按 E 时该开哪个箱子');

  type Item = Interactable<{ kind: string }> & { pos: { x: number; y: number } };

  const sys = new InteractSystem<{ kind: string }>();

  const mk = (id: string, x: number, y: number, kind: string, over: Partial<Item> = {}): Item =>
    ({ id, data: { kind }, radius: 3, pos: { x, y }, ...over });

  sys.registerAll([
    mk('chest', 1, 1.5, '宝箱'),
    mk('door', 0, 5, '门'),
    mk('npc', -1.2, 1.2, 'NPC', { priority: 5, maxUses: Infinity }),
    mk('lever', 0, -1.5, '拉杆', { maxUses: 3 }),
    mk('vault', 2, 2.5, '金库', { requires: ['brass_key'] }),
  ]);

  const ctx = (px: number, py: number, fx: number, fy: number, inv: string[] = []) => ({
    pos: { x: px, y: py },
    facing: { x: fx, y: fy },
    inventory: inv,
    data: {},
  });

  console.log('\n  【场景】玩家在原点，五个物件散布四周');
  for (const it of sys.all) {
    const p = (it as unknown as { pos: { x: number; y: number } }).pos;
    console.log(`    ${it.data.kind.padEnd(6)} (${p.x}, ${p.y})  ` +
                `${it.requires ? '需要钥匙 ' : ''}${it.priority ? '优先级' + it.priority : ''}`);
  }

  console.log('\n  【朝向 vs 距离：玩家朝右上看】');
  const dir = 1 / Math.sqrt(2);
  const c1 = sys.findFocus(ctx(0, 0, dir, dir));
  console.log(`    聚焦：${c1?.item.data.kind}（距离 ${c1?.distance.toFixed(2)}，对齐 ${c1?.alignment.toFixed(2)}）`);
  console.log(`    ↑ NPC 在左上(-1.2,1.2)距离 1.70，宝箱在右上(1,1.5)距离 1.80`);
  console.log(`      按距离该选 NPC，但 NPC 更偏左上。NPC 优先级 5 压过宝箱`);

  console.log('\n  【背对时不触发】');
  const c2 = sys.findFocus(ctx(0, 0, 0, -1));
  console.log(`    朝下看：聚焦 ${c2?.item.data.kind ?? '（无）'}（拉杆在下方但需要朝向）`);

  console.log('\n  【用完自动禁用：不能反复开箱】');
  const atChest = ctx(0, 0, dir, dir);
  console.log(`    第一次按 E：${sys.interact(atChest, 'chest')}`);
  console.log(`    第二次按 E：${sys.interact(atChest, 'chest')}  ← 已用完`);
  console.log(`    拉杆可重复 3 次：`);
  const atLever = ctx(0, 0, 0, -1);
  let n = 0;
  for (let i = 0; i < 4; i++) if (sys.interact(atLever, 'lever')) n++;
  console.log(`      按 4 次，成功 ${n} 次`);

  console.log('\n  【需要钥匙：给出原因而不是静默失败】');
  const vault = sys.get('vault')!;
  const noKey = sys.evaluate(vault, ctx(2, 2.2, 0, 1));
  const withKey = sys.evaluate(vault, ctx(2, 2.2, 0, 1, ['brass_key']));
  console.log(`    无钥匙：valid=${noKey.valid}  原因="${noKey.reason}"`);
  console.log(`    有钥匙：valid=${withKey.valid}`);
  console.log(`    ↑ UI 显示"缺少：黄铜钥匙"，玩家知道该去哪找`);

  console.log(`
  【⚠️ 曾经的 bug：超出半径的东西被当成有效候选】

  原实现里"不在范围内"和"满足条件"都返回 reason=null，
  于是 10 米外的箱子也算有效目标——
  玩家站着就能开远处的箱子，或者身边什么都没有却显示"按 E"。

  修法：把"够不够得着"独立成 inRange 字段。
  一个语义只该有一个含义，用同一个 null 表示两种状态迟早撞车。`);
}

// ============================================================
// 主函数
// ============================================================

function main(): void {
  console.log('╔' + '═'.repeat(66) + '╗');
  console.log('║' + '  cocos-kit 第十一批插件集成示例'.padEnd(58) + '║');
  console.log('║' + '  skill-variant / blessing / curse / interact'.padEnd(58) + '║');
  console.log('╚' + '═'.repeat(66) + '╝');

  demoSkillVariant();
  demoBlessing();
  demoCurse();
  demoInteract();

  hr('总结：这一批在演示「功能模块」');
  console.log(`
  四个插件都在回答同一个问题：
  **多个平级的小机制，怎么组合成一个功能**

  ┌───────────────┬────────────────────────────────┐
  │ 技能变体       │ 补丁 + 条件 + 深拷贝            │
  │ 祝福          │ 堆叠 + 递减 + 互斥              │
  │ 诅咒          │ 增益 + 代价时机 + 移除条件       │
  │ 环境互动       │ 目标选择 + 触发条件 + 状态管理   │
  └───────────────┴────────────────────────────────┘

  每个内部的小机制**谁也不是谁的前置**，
  它们是并列关系——共同回答一个问题：

    技能变体 → "怎么改"
    祝福     → "能拿几次"
    诅咒     → "什么时候付代价"
    环境互动 → "按 E 时开哪个"

  这就是你提出的「功能模块」概念：
  **一起变化的打包在一起，模块内可自由依赖，对外只暴露入口。**

  依赖规则 v3 见：依赖规则v3_功能模块.md
`);
}

main();
