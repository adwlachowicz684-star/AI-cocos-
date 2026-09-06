/**
 * examples/batch5-usage.ts —— 第四批插件的综合示例
 *
 * 【演示一个完整的"据点经营 + 回合制战斗"切片】
 *
 *   TurnSystem    回合制战斗（先攻 / 行动点 / 死亡跳过）
 *   GridPlacement 据点建造（2×2 房屋、旋转、拆除）
 *   QuestSystem   任务链（前置解锁 / 领奖）
 *   Shop          商店（折扣 / 多货币 / 库存）
 *   CraftSystem   合成（嵌套材料树 / 原子性 / 品质随机）
 *
 * 【这批的共同主题：状态机 + 事务性】
 * 这五个插件都在处理同一类问题：
 * "一个操作要么完全成功，要么完全不发生，中间不能有半成品"。
 *
 * - 回合制：轮转时杀人不能导致跳过
 * - 建造：移动失败要回滚
 * - 任务：奖励只能领一次
 * - 商店：钱不够不能扣钱
 * - 合成：产出失败材料必须还在
 *
 * 【运行】
 *   npx tsc -p tsconfig.json && node .build/examples/batch5-usage.js
 */

import { TurnSystem } from '../turn/TurnSystem';
import { GridPlacement, hexDistance, hexNeighbors, hexSpiral } from '../grid/Grid';
import { QuestSystem } from '../quest/QuestSystem';
import { Shop } from '../shop/Shop';
import { CraftSystem, IInventory } from '../craft/CraftSystem';
import { RNG } from '../rng/RNG';

/** 演示用的简易背包 */
class Bag implements IInventory {
  private readonly _items = new Map<string, number>();
  capacity = Infinity;

  set(id: string, n: number): void {
    this._items.set(id, n);
  }

  count(id: string): number {
    return this._items.get(id) ?? 0;
  }

  get total(): number {
    let n = 0;
    for (const v of this._items.values()) n += v;
    return n;
  }

  remove(id: string, amount: number): number {
    const have = this._items.get(id) ?? 0;
    const take = Math.min(have, amount);
    this._items.set(id, have - take);
    return take;
  }

  add(id: string, amount: number): number {
    const have = this._items.get(id) ?? 0;
    const room = Math.max(0, this.capacity - this.total);
    const put = Math.min(amount, room);
    this._items.set(id, have + put);
    return amount - put;
  }
}

async function main(): Promise<void> {
  console.log('========== 第四批插件综合示例：据点经营 + 回合制战斗 ==========\n');

  const rng = new RNG(20260902);

  // ---------- 1. 回合制战斗 ----------
  console.log('【1】回合制战斗（TurnSystem）');

  const battleLog: string[] = [];
  const turn = new TurnSystem({
    onRoundStart: (r) => battleLog.push(`── 第 ${r} 回合 ──`),
    onUnitStart: (id) => battleLog.push(`  ▶ ${id} 的回合`),
  });

  turn.addUnit({ id: '勇者', initiative: 15, actionPoints: 3 });
  turn.addUnit({ id: '哥布林', initiative: 8 });
  turn.addUnit({ id: '史莱姆', initiative: 8 });
  turn.addUnit({ id: '骨王', initiative: 20, actionPoints: 2 });

  turn.start();
  console.log(`  先攻排序：${turn.orderPreview.join(' → ')}`);
  console.log(`  （骨王 20 最高，勇者 15，两个 8 的按 id 排）`);

  // 勇者的回合：花行动点
  turn.endTurn(); // 骨王 → 勇者
  console.log(`\n  当前：${turn.currentUnitId}，行动点 ${turn.currentAP}`);
  console.log(`  攻击（2 AP）：${turn.spendAP(2) ? '成功' : '失败'}，剩余 ${turn.currentAP}`);
  console.log(`  再攻击（2 AP）：${turn.spendAP(2) ? '成功' : '失败（AP 不足）'}，剩余 ${turn.currentAP}`);
  console.log(`  ↑ 失败的 spendAP **不扣点**`);

  // 战斗中杀人
  console.log(`\n  勇者一击必杀，哥布林死亡`);
  turn.killUnit('哥布林');
  turn.endTurn(); // 勇者 → ?
  console.log(`  下一位：${turn.currentUnitId}（哥布林被自动跳过，没有崩溃）`);

  // 眩晕
  turn.skipUnit('史莱姆');
  turn.endTurn();
  console.log(`  史莱姆被眩晕 → 跳到 ${turn.currentUnitId}`);
  turn.endTurn();
  console.log(`  第 ${turn.round} 回合，当前 ${turn.currentUnitId}（眩晕只持续一回合）`);

  console.log(`\n  战斗日志：`);
  battleLog.slice(0, 8).forEach((l) => console.log(`    ${l}`));

  // ---------- 2. 据点建造 ----------
  console.log('\n【2】据点建造（GridPlacement）');

  const town = new GridPlacement(8, 6);
  town.define({ id: '房屋', w: 2, h: 2, rotatable: true });
  town.define({ id: '农场', w: 3, h: 2, rotatable: true });
  town.define({ id: '道路', w: 1, h: 1 });

  console.log(`  空地 ${town.width}×${town.height} = ${town.freeCount} 格`);

  const house1 = town.place('房屋', 0, 0)!;
  console.log(`  建造房屋 @(0,0) → 占 ${town.get(house1)!.w}×${town.get(house1)!.h} = 4 格`);
  console.log(`  (1,1) 被占：${town.at(1, 1) === house1}`);

  console.log(`  在 (1,1) 修路：${town.canPlace('道路', 1, 1) ? '可以' : '不行（已被房屋占用）'}`);

  const farm = town.place('农场', 3, 0, true)!; // 旋转
  const fp = town.get(farm)!;
  console.log(`  旋转建造农场 @(3,0) → 占地 ${fp.w}×${fp.h}（原本 3×2，旋转后互换）`);

  console.log(`  剩余空地：${town.freeCount} 格`);

  // 移动失败回滚
  const before = town.at(0, 0);
  const fail = town.move(house1, 3, 0); // 目标被农场占
  console.log(`\n  把房屋移到 (3,0)：${fail ? '成功' : '失败（被农场占）'}`);
  console.log(`  回滚检查：原位还是房屋吗？${town.at(0, 0) === before}`);

  const ok = town.move(house1, 6, 4);
  console.log(`  改移到 (6,4)：${ok ? '成功' : '失败'}`);
  console.log(`  (0,0) 已释放：${town.at(0, 0) === undefined}`);

  town.remove(house1);
  console.log(`  拆除房屋 → 剩余空地 ${town.freeCount} 格`);

  // ---------- 3. 任务链 ----------
  console.log('\n【3】任务链（QuestSystem）');

  const quests = new QuestSystem();
  quests.define({
    id: 'clear_rats',
    name: '清理地窖',
    objectives: [{ type: 'kill', target: 'rat', count: 3 }],
    rewards: { exp: 50, gold: 100 },
  });
  quests.define({
    id: 'rat_king',
    name: '讨伐鼠王',
    requires: ['clear_rats'],
    objectives: [{ type: 'kill', target: 'rat_king', count: 1 }],
    rewards: { exp: 300, gold: 500 },
  });

  console.log(`  初始：讨伐鼠王 状态 = ${quests.status('rat_king')}（前置未完成）`);

  quests.accept('clear_rats');
  quests.report({ type: 'kill', target: 'rat' });
  quests.report({ type: 'kill', target: 'rat', n: 2 });
  console.log(`  清理地窖：${quests.status('clear_rats')}`);
  console.log(`  讨伐鼠王：${quests.status('rat_king')}（已解锁）`);

  const reward = quests.claim('clear_rats');
  console.log(`  领奖：exp=${reward?.exp}, gold=${reward?.gold}`);
  console.log(`  再领一次：${quests.claim('clear_rats')}（防重复发奖）`);

  // 完成后不再累加
  quests.accept('rat_king');
  quests.report({ type: 'kill', target: 'rat_king' });
  quests.report({ type: 'kill', target: 'rat_king', n: 5 });
  const prog = quests.objectiveProgress('rat_king', 0)!;
  console.log(`  鼠王进度：${prog.current}/${prog.need}（不会变成 6/1）`);

  // ---------- 4. 商店 ----------
  console.log('\n【4】商店（Shop）');

  const shop = new Shop();
  shop.defineItem({ id: '药水', name: '治疗药水', basePrice: 50, sellRatio: 0.4 });
  shop.defineItem({ id: '铁剑', name: '铁剑', basePrice: 300 });
  shop.defineItem({ id: '宝石', name: '宝石', basePrice: 1000, category: 'rare' });

  shop.stock('药水', 20);
  shop.stock('铁剑', 2, 1.1);   // 这把剑贵 10%
  shop.stock('宝石', 3);        // 只能用钻石买

  // 会员折扣
  shop.setPricing((base, ctx) => (ctx.side === 'buy' ? Math.round(base * 0.9) : base));

  console.log(`  药水：买入 ${shop.priceOf('药水', 'buy')}（50 × 0.9 会员价），卖出 ${shop.priceOf('药水', 'sell')}`);
  console.log(`  铁剑：买入 ${shop.priceOf('铁剑', 'buy')}（300 × 1.1 × 0.9）`);

  const wallet = { gold: 200, gem: 1000 };
  console.log(`\n  钱包：${wallet.gold} 金 / ${wallet.gem} 钻`);

  const r1 = shop.buy('药水', 3, wallet);
  console.log(`  买 3 瓶药水：${r1.ok ? `花费 ${r1.total}` : r1.reason} → 剩 ${wallet.gold} 金`);

  const r2 = shop.buy('铁剑', 1, wallet);
  console.log(`  买铁剑（297）：${r2.ok ? `花费 ${r2.total}` : `${r2.reason} —— 需要 ${r2.need}，只有 ${r2.have}`}`);
  console.log(`  ↑ 钱不够时**不扣钱**，钱包仍是 ${wallet.gold} 金（不是负数）`);

  const r3 = shop.buy('宝石', 1, wallet, 'gem');
  console.log(`  用钻石买宝石（${shop.priceOf('宝石', 'buy')} 钻）：${r3.ok ? `花费 ${r3.total} 钻` : r3.reason}`);
  console.log(`  剩余：${wallet.gold} 金 / ${wallet.gem} 钻`);

  console.log(`\n  对账：金币净支出 ${shop.netSpent('gold')}，钻石净支出 ${shop.netSpent('gem')}`);
  console.log(`  ↑ 两种货币分开记账，不会混（流水 ${shop.countLog()} 条：金币 ${shop.countLog('gold')} + 钻石 ${shop.countLog('gem')}）`);

  shop.sell('药水', 2, wallet);
  console.log(`  卖 2 瓶药水 → 剩 ${wallet.gold} 金（卖出价 ${shop.priceOf('药水', 'sell')}）`);

  // ---------- 5. 合成 ----------
  console.log('\n【5】合成（CraftSystem）');

  const bag = new Bag();
  bag.set('iron_ore', 20);
  bag.set('wood', 10);

  const craft = new CraftSystem(rng);
  craft.define({
    id: 'ingot',
    name: '铁锭',
    inputs: [{ itemId: 'iron_ore', count: 2 }],
    output: { itemId: 'iron_ingot', count: 1 },
  });
  craft.define({
    id: 'sword',
    name: '铁剑',
    inputs: [
      { itemId: 'iron_ingot', count: 3 },
      { itemId: 'wood', count: 1 },
    ],
    output: {
      itemId: 'sword_common',
      count: 1,
      variants: [
        { itemId: 'sword_common', weight: 70 },
        { itemId: 'sword_rare', weight: 25 },
        { itemId: 'sword_epic', weight: 5 },
      ],
    },
    byproducts: [{ itemId: 'iron_ore', count: 1, chance: 0.3 }],
  });

  console.log(`  背包：铁矿石 ${bag.count('iron_ore')}，木头 ${bag.count('wood')}`);

  const tree = craft.totalMaterials('sword', 1);
  console.log(`  合成铁剑的完整材料：铁矿石 ×${tree['iron_ore']}，木头 ×${tree['wood']}`);
  console.log(`  ↑ 展开了嵌套（铁剑=3铁锭+1木头，铁锭=2矿石）`);

  // 直接合成铁剑会失败——背包里没有中间产物"铁锭"
  const c0 = craft.canCraft('sword', bag);
  console.log(`\n  直接做铁剑：${c0.ok ? '可以' : `不行，缺 ${c0.missing.map((m) => `${m.itemId} ${m.have}/${m.need}`).join('、')}`}`);

  // 先冶炼铁锭
  console.log(`\n  先冶炼 5 个铁锭（每个消耗 2 矿石）`);
  const ingotResult = craft.craft('ingot', bag, 5);
  console.log(`  结果：${ingotResult.ok ? '成功' : ingotResult.reason}`);
  console.log(`  背包：铁矿石 ${bag.count('iron_ore')}，铁锭 ${bag.count('iron_ingot')}`);

  // 现在能做铁剑了
  const check = craft.canCraft('sword', bag);
  console.log(`\n  现在能做几把铁剑？${check.maxCount} 把（木桶效应：受最缺的材料限制）`);

  const r = craft.craft('sword', bag);
  console.log(`  合成结果：${r.ok ? `获得 ${r.produced?.map((p) => p.itemId).join(',')}` : r.reason}`);
  console.log(`  副产物：${r.byproducts?.length ? r.byproducts.map((b) => `${b.itemId}×${b.count}`).join(',') : '（没触发，30% 概率）'}`);
  console.log(`  背包：铁矿石 ${bag.count('iron_ore')}，铁锭 ${bag.count('iron_ingot')}，木头 ${bag.count('wood')}`);

  // 原子性演示：背包满
  console.log(`\n  【原子性验证】把背包容量设为当前占用数，制造"背包满"`);
  const before2 = { ore: bag.count('iron_ore'), wood: bag.count('wood') };
  bag.capacity = bag.total;

  const rFull = craft.craft('ingot', bag);
  console.log(`  合成铁锭：${rFull.ok ? '成功' : `失败（${rFull.reason}）`}`);
  console.log(`  铁矿石：${before2.ore} → ${bag.count('iron_ore')}`);
  console.log(`  ↑ ${before2.ore === bag.count('iron_ore') ? '材料分毫未动 ✓' : '材料丢失 ✗'}`);

  bag.capacity = Infinity;

  // ---------- 6. 六边形（战棋场景）----------
  console.log('\n【6】六边形网格（Hex）');

  const center = { q: 0, r: 0 };
  console.log(`  以 (0,0) 为中心：`);
  console.log(`    相邻 6 格，距离都是 ${hexDistance(center, hexNeighbors(center)[0])}`);
  console.log(`    半径 2 内共 ${hexSpiral(center, 2).length} 格（公式 3r²+3r+1 = 19）`);
  console.log(`    到 (3,-1) 的距离：${hexDistance(center, { q: 3, r: -1 })}`);

  console.log('\n========== 示例结束 ==========');
}

declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== 'undefined' && require?.main === module) {
  main();
}

export { main };
