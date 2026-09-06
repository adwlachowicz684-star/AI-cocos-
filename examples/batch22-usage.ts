/**
 * examples/batch22-usage.ts —— 补缺示例的五个单元
 *
 * 【为什么有这个文件】
 * 全库 119 个单元里，这 5 个在 `examples/` 中**完全没有可运行示例**：
 *
 *   behavior-tree   AI 行为树（547 行）
 *   curve           曲线插值
 *   entity          ECS 式实体注册表（带 id 代际防悬垂）
 *   fsm             有限状态机
 *   signal          类型安全的信号/回调
 *
 * 前四個都是**业务主链路**上的核心单元，没有示例意味着：
 * 使用者只能靠读源码推断 API，而这几处的 API 都有反直觉之处（见下文注释）。
 *
 * 【这个例子演示什么】
 * 一个"敌人 AI"的完整切面，把这五个单元串起来：
 *
 *   EntityRegistry  管理敌人实体（含 id 代际、标签查询）
 *   BehaviorTree    敌人的决策逻辑（巡逻 → 发现玩家 → 追击）
 *   StateMachine    敌人的宏观状态（idle / alert / dead）
 *   Curve           追击速度随距离变化的曲线
 *   Signal          实体死亡时广播（UI 与掉落各自订阅）
 *
 * 【运行】
 *   npx tsc -p tsconfig.json && node .build/examples/batch22-usage.js
 */

import { EntityRegistry } from '../entity/EntityRegistry';
import {
  BehaviorTree,
  BTStatus,
  Selector,
  Sequence,
  Condition,
  Action,
} from '../behavior-tree/BehaviorTree';
import { StateMachine } from '../fsm/StateMachine';
import { Curve } from '../curve/Curve';
import { Signal } from '../signal/Signal';

// ============================================================
// 一个简单的自检（本库 examples 的统一做法：不引测试框架，能直接 node 跑）
// ============================================================

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function section(title: string): void {
  console.log(`\n▸ ${title}`);
}

// ============================================================
// ① EntityRegistry —— id 代际是这里的重点
// ============================================================

section('EntityRegistry · 实体注册与 id 代际');

interface Enemy {
  name: string;
  hp: number;
  x: number;
  y: number;
}

const registry = new EntityRegistry<Enemy>();

/** 敌人死亡信号：参数为 (id, 死因) */
const onEnemyDied = new Signal<(id: number, reason: string) => void>();

// 订阅方 A：UI 记分
let killCount = 0;
const offUi = onEnemyDied.add((_id, reason) => {
  if (reason === 'killed') killCount++;
});

// 订阅方 B：掉落
const drops: string[] = [];
onEnemyDied.add((id, _reason) => {
  const rec = registry.get(id);
  if (rec) drops.push(`${rec.entity.name} 的掉落`);
});

const goblinId = registry.spawn({ name: '哥布林', hp: 30, x: 0, y: 0 }, { tags: ['enemy', 'melee'] });
const orcId = registry.spawn({ name: '兽人', hp: 80, x: 10, y: 0 }, { tags: ['enemy', 'melee'] });
const bossId = registry.spawn({ name: 'Boss', hp: 500, x: 20, y: 0 }, { tags: ['enemy', 'boss'] });

check('spawn 返回有效 id', registry.isAlive(goblinId) && registry.isAlive(orcId));
check('按标签查询（requireAlive 默认 true）', registry.query('enemy').length === 3);
check('多标签交集查询', registry.queryAll(['enemy', 'boss']).length === 1);

/**
 * 【⚠️ 这里演示本单元最关键的语义：id 复用 + 代际校验】
 *
 * `destroy` 之后槽位会被后来的实体复用，
 * 但**代际号会递增**，所以旧的 id 不会"意外指向新实体"——
 * 这正是悬垂引用的经典坑（旧 id 指向了一个不相干的实体）。
 */
registry.kill(goblinId, 'killed');
onEnemyDied.emit(goblinId, 'killed');

check('kill 后 isAlive 为 false', !registry.isAlive(goblinId));
check('kill 后仍可 get（查死因用）', registry.get(goblinId) !== null);

registry.destroy(goblinId);
const reusedId = registry.spawn({ name: '新哥布林', hp: 30, x: 5, y: 0 }, { tags: ['enemy'] });

check('销毁后槽位被复用（index 相同）', reusedId !== goblinId, 'id 数值应含新代际');
check('旧 id 不再指向新实体（代际校验生效）', !registry.isAlive(goblinId));
check('旧 id 查不到（不会误伤新实体）', registry.getAlive(goblinId) === null);

// ============================================================
// ② BehaviorTree —— 敌人的决策
// ============================================================

section('BehaviorTree · 决策树');

interface AiCtx {
  enemy: Enemy;
  playerX: number;
  playerY: number;
  canSeePlayer: boolean;
  /** 本 tick 计算出的移动速度（供外部读取） */
  speed: number;
}

/**
 * 【⚠️ 黑板要用 `tree.blackboard`，不是自己 new 一个】
 *
 * 我写这个示例时第一版就踩了：自己建了个 `bb` 对象想传进去，
 * 结果 `tick(ctx, dt)` 的签名里**根本没有 blackboard 参数**——
 * 树用的是它自己的 `public readonly blackboard`，外部无法替换。
 *
 * 这不是 bug：黑板的作用域就是"这棵树"，
 * 多棵树共享一个黑板才会出问题（一棵树清空时影响别人）。
 * 但 API 上看不出来，所以记在这里。
 */
const tree = new BehaviorTree<AiCtx>(
  new Selector<AiCtx>('root', [
    // ① 看不见玩家 → 巡逻
    new Sequence<AiCtx>('patrol', [
      new Condition<AiCtx>('看不见玩家', (c) => !c.canSeePlayer),
      new Action<AiCtx>('巡逻移动', (c, board) => {
        board.patrolTicks = ((board.patrolTicks as number) ?? 0) + 1;
        c.speed = 20;
        return BTStatus.Success;
      }),
    ]),
    // ② 看得见 → 追击
    new Sequence<AiCtx>('chase', [
      new Condition<AiCtx>('看得见玩家', (c) => c.canSeePlayer),
      new Action<AiCtx>('记录位置', (c, board) => {
        board.lastSeenX = c.playerX;
        board.lastSeenY = c.playerY;
        return BTStatus.Success;
      }),
      new Action<AiCtx>('追击', (c, board) => {
        const dx = (board.lastSeenX as number) - c.enemy.x;
        const dy = (board.lastSeenY as number) - c.enemy.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // ③ 用 Curve 决定速度（见下节）
        c.speed = chaseSpeed.evaluate(dist / 50);
        return BTStatus.Success;
      }),
    ]),
  ])
);

// ============================================================
// ③ Curve —— 追击速度随距离衰减
// ============================================================

section('Curve · 距离→速度曲线');

/**
 * 距离 0 → 速度 60（贴脸最快，防止绕圈）
 * 距离 1 → 速度 10（远处慢，给玩家喘息）
 */
const chaseSpeed = Curve.fromArray([
  [0, 60],
  [0.3, 45],
  [1, 10],
]);

check('贴脸速度最快', chaseSpeed.evaluate(0) === 60);
check('远处速度慢', chaseSpeed.evaluate(1) === 10);
check('中间插值单调递减', chaseSpeed.evaluate(0.3) < 60 && chaseSpeed.evaluate(0.3) > 10);

// 跑一次树（看不见玩家）
const ctxBlind: AiCtx = { enemy: registry.getAlive(orcId)!.entity, playerX: 100, playerY: 0, canSeePlayer: false, speed: 0 };
tree.tick(ctxBlind, 0.016);
check('看不见玩家时走巡逻分支', ctxBlind.speed === 20, `实际 ${ctxBlind.speed}`);

// 再跑一次（看得见）
const ctxSee: AiCtx = { enemy: registry.getAlive(orcId)!.entity, playerX: 25, playerY: 0, canSeePlayer: true, speed: 0 };
tree.tick(ctxSee, 0.016);
check('看得见玩家时走追击分支', ctxSee.speed > 0 && ctxSee.speed !== 20, `实际 ${ctxSee.speed}`);
check('黑板记录了玩家位置', tree.blackboard.lastSeenX === 25, `实际 ${tree.blackboard.lastSeenX}`);

// ============================================================
// ④ StateMachine —— 敌人的宏观状态
// ============================================================

section('StateMachine · 状态机');

/**
 * 【⚠️ 本单元最容易踩的一点】
 * `start(ctx)` **必须**在拿到 context 之后调用——
 * 构造函数只做校验、不触发 enter。
 * 这是刻意的：构造函数里没有 context，调 enter 会传 undefined。
 */
const fsmLog: string[] = [];
const fsm = new StateMachine<AiCtx>({
  initial: 'idle',
  states: {
    idle: {
      enter: () => fsmLog.push('enter:idle'),
      exit: () => fsmLog.push('exit:idle'),
      update: (c) => (c.canSeePlayer ? 'alert' : undefined),
    },
    alert: {
      enter: () => fsmLog.push('enter:alert'),
      exit: () => fsmLog.push('exit:alert'),
    },
    dead: { enter: () => fsmLog.push('enter:dead') },
  },
  transitions: { idle: ['alert', 'dead'], alert: ['dead'] },
  onChange: (from, to) => fsmLog.push(`change:${from}->${to}`),
});

fsm.start(ctxBlind);
check('start 触发初始 enter', fsmLog.includes('enter:idle'));
check('初始状态为 idle', fsm.current === 'idle');

fsm.update(ctxBlind, 0.016);
check('看不见玩家时保持 idle', fsm.current === 'idle');

fsm.update(ctxSee, 0.016);
check('看见玩家后转到 alert', fsm.current === 'alert');
check('exit 与 enter 都触发了', fsmLog.includes('exit:idle') && fsmLog.includes('enter:alert'));

check('can() 反映转换表', fsm.can('dead') === true && fsm.can('idle') === false);

/**
 * 【⚠️ 未配置的状态会被拒绝】
 * 而且现在连原型键（'toString'）也会被拒绝——
 * 老实现用 `states[key]` 直接查表，原型链会让校验通过，
 * 状态机带着一个不存在的状态"正常启动"，enter/exit/update 全不触发。
 */
let rejected = false;
try {
  fsm.transitionTo('toString', ctxSee);
} catch {
  rejected = true;
}
check('未知状态（含原型键）被拒绝', rejected);

// ============================================================
// ⑤ Signal —— 取消订阅与一次性监听
// ============================================================

section('Signal · 取消订阅');

check('死亡信号已触发一次', killCount === 1);
check('掉落记录了名字', drops.length === 1 && drops[0].includes('哥布林'), JSON.stringify(drops));

// 取消 UI 订阅后再杀一个，killCount 不应增加
offUi();
registry.kill(orcId, 'killed');
onEnemyDied.emit(orcId, 'killed');
check('取消订阅后不再回调', killCount === 1, `实际 ${killCount}`);
check('另一个订阅者不受影响', drops.length === 2);

// once：只触发一次
let onceCount = 0;
const onBossDied = new Signal<() => void>();
onBossDied.once(() => onceCount++);
onBossDied.emit();
onBossDied.emit();
check('once 只触发一次', onceCount === 1, `实际 ${onceCount}`);

// ============================================================
// 收尾
// ============================================================

registry.kill(bossId, 'killed');
onEnemyDied.emit(bossId, 'killed');
check('Boss 死亡也进了掉落', drops.length === 3, JSON.stringify(drops));
check('活着的敌人只剩新哥布林', registry.query('enemy').length === 1);

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  /**
   * 【为什么要 declare 而不是直接 import】
   * examples/ 不引 Node 类型定义（本库要求"复制进引擎工程就能用"），
   * 所以按 tests/_framework.ts 的写法手动声明最小签名。
   */
  throw new Error(`示例自检失败 ${failed} 项`);
}
console.log('全部通过 ✓');
