/**
 * examples/batch4-usage.ts —— 第三批插件的综合示例
 *
 * 【演示一个"游戏外壳"如何把基础设施插件串起来】
 *
 *   DIContainer     组装所有服务（启动体检 + 测试换依赖）
 *   FrameScheduler  分批生成 2000 个怪物（不卡帧）
 *   I18N            多语言 UI 文本
 *   Expression      配置里的难度公式
 *   Inventory       战利品背包
 *   Deck            技能卡牌（抽牌/打出/消耗）
 *   DialogueGraph   NPC 对话
 *   Snapshot        存档增量 + 设置撤销
 *   ReplayRecorder  录制这一局
 *
 * 【与前两批的区别】
 * 前两批是"游戏内容"的零件（掉落、AI、战斗），
 * 这批是**撑起整个项目的脚手架**——它们不直接产生玩法，
 * 但没有它们，项目到一定规模就会失控。
 *
 * 【运行】
 *   npx tsc -p tsconfig.json && node .build/examples/batch4-usage.js
 */

import { DIContainer } from '../di/DIContainer';
import { FrameScheduler } from '../scheduling/FrameScheduler';
import { I18N } from '../i18n/I18N';
import { Expression } from '../expression/Expression';
import { Inventory } from '../inventory/Inventory';
import { Deck } from '../card/Deck';
import { DialogueGraph } from '../dialogue/DialogueGraph';
import { deepClone, diffSnapshots, createPatch, applyPatch, UndoStack } from '../snapshot/Snapshot';
import { ReplayRecorder } from '../replay/ReplayRecorder';
import { RNG } from '../rng/RNG';
import { Logger, LogLevel } from '../logger/Logger';

async function main(): Promise<void> {
  console.log('========== 第三批插件综合示例：游戏外壳 ==========\n');

  const rng = new RNG(20260902);
  const log = new Logger({ level: LogLevel.Warn, bufferSize: 30 });

  // ---------- 1. DI：组装所有服务 ----------
  console.log('【1】依赖注入（DIContainer）');

  const c = new DIContainer('game');
  c.value('seed', 20260902);
  // 注意：是 { lifetime: 'singleton' }（'singleton' 是默认值，写出来是为了表意）
  c.register('rng', (cc) => new RNG(cc.get<number>('seed')), { lifetime: 'singleton' });
  c.register('i18n', () => createI18N(), { lifetime: 'singleton' });
  c.register('bag', () => createInventory(), { lifetime: 'singleton' });
  c.register('scheduler', () => new FrameScheduler({ budgetMs: 4 }), { lifetime: 'singleton' });
  c.disposable('logger', () => log);

  // 启动体检：能提前发现"某个服务依赖了没注册的东西"
  const errors = c.validate();
  console.log(`  注册 ${c.size} 个服务，validate() 发现 ${errors.length} 个问题`);

  const i18n = c.get<I18N>('i18n');
  const bag = c.get<Inventory>('bag');

  // 循环依赖会被检测（而不是栈溢出）
  const cyc = new DIContainer('bad');
  cyc.register('a', (cc) => ({ b: cc.get('b') }));
  cyc.register('b', (cc) => ({ a: cc.get('a') }));
  try {
    cyc.get('a');
  } catch (e) {
    console.log(`  循环依赖检测：${(e as Error).message}`);
  }

  // ---------- 2. 多语言 ----------
  console.log('\n【2】本地化（I18N）');
  i18n.setLocale('en-US');
  console.log(`  英文：${i18n.t('ui.start')} / ${i18n.t('item.count', { n: 1 })} / ${i18n.t('item.count', { n: 5 })}`);
  i18n.setLocale('zh-CN');
  console.log(`  中文：${i18n.t('ui.start')} / ${i18n.t('item.count', { n: 5 })}`);
  console.log(`  击杀提示：${i18n.t('msg.kill', { name: '骷髅兵', exp: 120 })}`);

  const cov = i18n.coverage('en-US');
  console.log(`  英文翻译覆盖率：${cov.translated}/${cov.total}（缺 ${cov.missing.join(',')}）`);

  // ---------- 3. 配置公式 ----------
  console.log('\n【3】配置公式（Expression）');
  const hpFormula = new Expression('base * (1 + floor * 0.15)');
  const dmgFormula = new Expression('atk * (1 + str / 100) * (isCrit ? 2 : 1)');

  for (const floor of [1, 5, 10]) {
    console.log(`  第 ${String(floor).padStart(2)} 层怪物血量：${hpFormula.evaluate({ base: 100, floor }).toFixed(0)}`);
  }
  console.log(`  普通攻击：${dmgFormula.evaluate({ atk: 50, str: 20, isCrit: 0 })}`);
  console.log(`  暴击：${dmgFormula.evaluate({ atk: 50, str: 20, isCrit: 1 })}`);
  console.log(`  公式用到的变量：${hpFormula.variables().join(', ')}`);

  // ---------- 4. 分帧生成怪物（不卡帧）----------
  console.log('\n【4】分帧调度（FrameScheduler）');
  const sched = c.get<FrameScheduler>('scheduler');

  const MONSTERS = 600;
  const monsterIds = Array.from({ length: MONSTERS }, (_, i) => i);
  const spawned: number[] = [];
  const perFrameCounts: number[] = [];

  sched.scheduleBatch(
    monsterIds,
    (id) => {
      // 模拟"实例化一个怪物"：加载配置、建节点、挂脚本、生成 AI 数据
      // 真实项目里这一步通常 0.05–0.5ms，这里用空转放大以便观察
      spin(0.05);
      spawned.push(id);
    },
    {
      onDone: () => console.log(`  ✓ 全部 ${MONSTERS} 个生成完毕`),
    }
  );

  let frameNo = 0;
  let prevCount = 0;
  while (sched.isBusy && frameNo < 500) {
    sched.update();
    perFrameCounts.push(spawned.length - prevCount);
    prevCount = spawned.length;
    frameNo++;
  }

  const avg = MONSTERS / perFrameCounts.length;
  const maxPerFrame = Math.max(...perFrameCounts);
  console.log(`  ${MONSTERS} 个怪物分 ${perFrameCounts.length} 帧生成`);
  console.log(`  平均每帧 ${avg.toFixed(0)} 个，最多一帧 ${maxPerFrame} 个`);
  console.log(`  前 6 帧的分配：${perFrameCounts.slice(0, 6).join(', ')}`);
  console.log(`  ↑ 每帧只干预算内的活，剩下的留到下一帧——画面不会卡住`);

  // ---------- 5. 背包 ----------
  console.log('\n【5】背包（Inventory）');
  bag.add('金币', 500);
  bag.add('药水', 7);
  bag.add('铁剑', 1);
  bag.add('火焰剑', 1, { affix: '燃烧' });

  console.log(`  金币 ${bag.count('金币')}（占 ${bag.slotsUsedBy('金币')} 格）`);
  console.log(`  药水 ${bag.count('药水')}（占 ${bag.slotsUsedBy('药水')} 格，maxStack=5）`);
  console.log(`  已用 ${bag.usedSlots}/${bag.size} 格`);

  // 交换：把药水换到第一格
  const potionSlot = bag.slots.findIndex((s) => s.def?.id === '药水');
  bag.swap(0, potionSlot);
  console.log(`  交换后第 0 格：${bag.slots[0].def?.name} ×${bag.slots[0].count}`);

  bag.compact();
  console.log(`  整理后已用 ${bag.usedSlots} 格`);

  // ---------- 6. 卡牌 ----------
  console.log('\n【6】技能卡（Deck）');
  const deck = new Deck<string>({ handLimit: 5 });
  deck.setDeck(['斩击', '斩击', '火球', '治疗', '护盾', '重击', '闪现']);
  deck.shuffle(rng);

  const hand = deck.draw(5, rng);
  console.log(`  抽到手牌：${hand.join(' / ')}`);
  console.log(`  打出「${hand[0]}」→ 弃牌堆`);
  deck.play(0);
  console.log(`  消耗「${hand[1]}」（不进弃牌堆）`);
  deck.play(0, 'exhaust');

  deck.discardHand();
  console.log(`  回合结束弃牌：手牌 ${deck.hand.length}，弃牌堆 ${deck.discardPile.length}`);

  deck.draw(5, rng);
  console.log(`  新回合抽牌：手牌 ${deck.hand.length}（抽牌堆空时自动洗回）`);

  // ---------- 7. 对话 ----------
  console.log('\n【7】NPC 对话（DialogueGraph）');
  interface NPCState { gold: number; talked: number }
  const dialog = new DialogueGraph<NPCState>();

  dialog.node('greet', {
    speaker: '商人',
    text: '欢迎光临！',
    choices: [
      { text: '买药水（50 金）', next: 'buy', condition: (s) => s.gold >= 50, lockedHint: '金币不足' },
      { text: '打听消息', next: 'rumor' },
      { text: '离开', next: null },
    ],
  });
  dialog.node('buy', {
    speaker: '商人',
    text: '拿好！',
    onEnter: (s) => {
      s.gold -= 50;
      bag.add('药水', 1);
    },
    next: 'greet',
  });
  dialog.node('rumor', { speaker: '商人', text: '听说第三层的宝箱很多', next: 'greet' });

  console.log(`  对话校验：${dialog.validate().length} 个错误`);
  console.log(`  不可达节点：${dialog.findUnreachable('greet').length} 个`);

  const npcState: NPCState = { gold: 30, talked: 0 };
  const runner = dialog.start('greet', npcState);
  console.log(`  [${runner.current?.speaker}] ${runner.current?.text}`);
  runner.current?.choices.forEach((ch) => {
    console.log(`    - ${ch.text}${ch.enabled ? '' : `（${ch.hint}）`}`);
  });
  console.log(`  金币 30，买不起药水 → 选打听消息`);
  runner.choose(1);
  console.log(`  [${runner.current?.speaker}] ${runner.current?.text}`);

  // ---------- 8. 快照与存档 ----------
  console.log('\n【8】快照与增量存档（Snapshot）');
  /**
   * 用 200 个敌人模拟真实存档规模。
   * 【注意】小对象上增量存档省不了多少（路径本身也占字节），
   * 只有对象够大、变化比例够小时才有意义。
   */
  const worldBefore = {
    floor: 3,
    player: { hp: 100, mp: 50, x: 12.5, y: 8.25, gold: 340, exp: 1200 },
    enemies: Array.from({ length: 200 }, (_, i) => ({
      id: `e${i}`,
      hp: 30 + (i % 7),
      x: (i % 20) * 1.5,
      y: Math.floor(i / 20) * 1.5,
      state: 'idle',
    })),
  };

  const worldAfter = deepClone(worldBefore);
  worldAfter.player.hp = 80;
  worldAfter.enemies[1].hp = 0;
  worldAfter.enemies[2].state = 'chase';
  worldAfter.enemies.push({ id: 'boss', hp: 500, x: 0, y: 0, state: 'idle' });

  const diff = diffSnapshots(worldBefore, worldAfter);
  console.log(`  变化 ${diff.changed.length} 处、新增 ${diff.added.length} 处：`);
  diff.changed.slice(0, 3).forEach((e) => console.log(`    ${e.path}: ${e.from} → ${e.to}`));

  const patch = createPatch(worldBefore, worldAfter);
  const fullSize = JSON.stringify(worldAfter).length;
  const patchSize = JSON.stringify(patch).length;
  const saved = ((1 - patchSize / fullSize) * 100).toFixed(0);
  console.log(`  全量存档 ${fullSize} 字节，增量补丁 ${patchSize} 字节（省 ${saved}%）`);
  console.log(`  ↑ 只改了 3 处，所以补丁很小。改动越多优势越小`);

  const restored = applyPatch(worldBefore, patch);
  console.log(`  应用补丁后：hp=${restored.player.hp}，敌人数=${restored.enemies.length}`);
  eq(restored.player.hp, 80);
  eq(restored.enemies.length, 201);
  eq(worldBefore.player.hp, 100, '原对象未被修改');

  // 设置撤销
  const settings = new UndoStack<{ volume: number; shake: boolean }>();
  let cur = { volume: 80, shake: true };
  settings.push(cur);
  cur = { volume: 40, shake: true };
  settings.push(cur);
  cur = { volume: 40, shake: false };
  const undone = settings.undo(cur);
  console.log(`  设置撤销：${cur.volume}/${cur.shake} → ${undone?.volume}/${undone?.shake}`);

  // ---------- 9. 回放录制 ----------
  console.log('\n【9】回放录制（ReplayRecorder）');
  const rec = new ReplayRecorder({ seed: 20260902 });
  rec.start();

  // 模拟 600 帧（10 秒）：玩家按住前进，第 100 帧跳跃，第 300 帧攻击
  for (let f = 0; f < 600; f++) {
    rec.record(f, {
      moveX: f < 500 ? 1 : 0,
      jump: f === 100 ? 1 : 0,
      attack: f === 300 ? 1 : 0,
    });
  }
  const replayData = rec.export({ floor: 3, character: 'warrior' });

  console.log(`  录制 600 帧，只产生 ${replayData.keyframes.length} 个关键帧`);
  console.log(`  体积约 ${rec.estimateSize()} 字节（录状态的话会是几百 KB）`);

  const player = new ReplayRecorder({ seed: 20260902 });
  player.load(replayData);
  console.log(`  回放校验：第 100 帧 jump=${player.playback(100)?.jump}，第 101 帧 jump=${player.playback(101)?.jump}`);
  console.log(`  （deltaOnly 下，第 101 帧沿用第 100 帧的输入）`);

  // 种子不匹配会被拒绝（而不是"能播但结果不对"）
  const wrongPlayer = new ReplayRecorder({ seed: 999 });
  try {
    wrongPlayer.load(replayData);
  } catch (e) {
    console.log(`  种子不匹配：${(e as Error).message}`);
  }

  // ---------- 收尾 ----------
  console.log('\n【清理】');
  c.destroy();
  console.log('  容器销毁，所有 disposable 服务已清理');

  console.log('\n========== 示例结束 ==========');
}

// ============================================================
// 辅助
// ============================================================

/** 空转约 ms 毫秒（用于演示分帧调度的效果） */
function spin(ms: number): void {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
}

function eq(actual: unknown, expected: unknown, label = ''): void {
  if (actual !== expected) {
    throw new Error(`断言失败${label ? `（${label}）` : ''}：期望 ${expected}，实际 ${actual}`);
  }
}

// ============================================================
// 工厂函数（真实项目里放在各自的文件中）
// ============================================================

function createI18N(): I18N {
  const i18n = new I18N({ fallback: 'zh-CN' });
  i18n.addLocale('zh-CN', {
    'ui.start': '开始游戏',
    'ui.settings': '设置',
    'item.count': '{n} 个',
    'msg.kill': '你击败了{name}，获得 {exp} 经验',
    'msg.levelup': '升级！',
  });
  i18n.addLocale('en-US', {
    'ui.start': 'Start Game',
    'ui.settings': 'Settings',
    'item.count_one': '{n} item',
    'item.count_other': '{n} items',
    'msg.kill': 'Defeated {name}, gained {exp} EXP',
    // 故意不翻译 msg.levelup，用于演示覆盖率检查
  });
  return i18n;
}

function createInventory(): Inventory {
  const bag = new Inventory({ size: 24 });
  bag.define({ id: '金币', name: '金币', maxStack: 999, sortOrder: 0 });
  bag.define({ id: '药水', name: '治疗药水', maxStack: 5, sortOrder: 1 });
  bag.define({ id: '铁剑', name: '铁剑', maxStack: 1, sortOrder: 2 });
  bag.define({ id: '火焰剑', name: '火焰剑', maxStack: 1, sortOrder: 2 });
  return bag;
}

declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== 'undefined' && require?.main === module) {
  main();
}

export { main };
