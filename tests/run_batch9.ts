/**
 * tests/run_batch9.ts —— 第八批插件的测试
 *
 * 覆盖：perception、attack-token、bullet-pattern、element、
 *       targeting、combo、objective、difficulty、gacha、scoring
 *
 * 【这批的测试重点：状态泄漏与方向反了】
 *
 * 这批 10 个模块全都是**带状态的系统 + 计时器**，
 * 所以 bug 集中在几类：
 *
 * 1. **状态泄漏**：令牌没归还、元素没衰减、连招缓冲没清
 *    → 表现为"怪站着不动""技能没反应""自己出招"
 * 2. **方向反了**：lower-better 的 par/zero 写反、DDA 调节方向反了
 *    → **不报错**，只是玩家觉得莫名其妙
 * 3. **永不终止**：循环前置、等待窗口没有退出条件
 * 4. **边界吞噬**：概率恰好等于阈值、计数恰好达到 target
 *
 * 【为什么这类 bug 必须靠测试】
 * 它们全部**不抛异常**。
 * 数值和状态语义的错误只会悄悄偏差——
 * 玩家感受到的是"这游戏有点怪"，而你查不出来。
 */

import { describe, test, assert, eq, near, throws } from './_framework';
import { RNG } from '../rng/RNG';

import {
  PerceptionSystem,
  OpenLineOfSight,
  PerceptionPresets,
  type ILineOfSight,
  type PerceptionEvent,
} from '../perception/Perception';
import { AttackTokenSystem } from '../attack-token/AttackToken';
import {
  BulletPattern,
  SequencePlayer,
  compileShape,
  speedAt,
  Shapes,
  angleToVec,
  normalizeAngle2Pi,
  lerpAngle,
  type SequenceStep,
} from '../bullet-pattern/BulletPattern';
import {
  ElementSystem,
  validateReactions,
  type ElementDef,
  type ReactionDef,
} from '../element/ElementSystem';
import {
  TargetSelector,
  byDistance,
  byAngle,
  byStickiness,
  byWeight,
  type TargetCandidate,
} from '../targeting/TargetSelector';
import {
  ComboSystem,
  validateCombos,
  type MoveDef,
  type MoveTriggered,
} from '../combo/ComboSystem';
import {
  ObjectiveSystem,
  Objectives,
  type ObjectiveDef,
} from '../objective/ObjectiveSystem';
import {
  DifficultySystem,
  computePerformance,
  DEFAULT_TIERS,
} from '../difficulty/DifficultySystem';
import { GachaPity, simulate, type GachaItem, type RarityConfig } from '../gacha/GachaPity';
import {
  ScoringSystem,
  normalize,
  gradeOf,
  toNextGrade,
  gapToPerfect,
  CombatMetrics,
  DEFAULT_THRESHOLDS,
  type MetricDef,
} from '../scoring/ScoringSystem';

// ============================================================
// 辅助
// ============================================================

/** 一面墙：挡住 x=5 及其右边 */
class WallLOS implements ILineOfSight {
  visible(x0: number, _y0: number, x1: number, _y1: number): boolean {
    const wallX = 5;
    return !((x0 < wallX && x1 >= wallX) || (x0 >= wallX && x1 < wallX));
  }
}

// ══════════════════════════════════════════════════════════
// 1. Perception
// ══════════════════════════════════════════════════════════

export function runBatch9Tests(): void {
describe('Perception · 感知系统', () => {
  function makeSys(los: ILineOfSight = OpenLineOfSight, jitter = 0): PerceptionSystem {
    return new PerceptionSystem({ los, jitter });
  }

  test('注册与基本查询', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.addTarget(100, 10, 10);
    eq(s.isAware(1), false);
    eq(s.alertOf(1), 0);
    eq(s.targetOf(1), -1);
  });

  test('重复注册抛错', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0);
    throws(() => s.addPerceiver(1, PerceptionPresets.humanoid, 1, 1), '重复');
  });

  test('正前方近距离能被发现', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);   // 面向 +X
    s.addTarget(100, 5, 0);                                    // 正前方 5 米
    for (let i = 0; i < 200; i++) s.tick(1 / 60);
    eq(s.isAware(1), true, '正前方 5 米应该被发现');
    eq(s.targetOf(1), 100);
  });

  test('⚠️ 正后方不会被发现（超出 proximityRange）', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);   // 面向 +X
    s.addTarget(100, -8, 0);                                   // 正后方 8 米
    for (let i = 0; i < 300; i++) s.tick(1 / 60);
    eq(s.isAware(1), false, '背后 8 米不该被看见');
  });

  test('⚠️ 贴身时能感知到（proximityRange 生效）', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);   // 面向 +X
    s.addTarget(100, -1.5, 0);                                 // 背后 1.5 米（proximity=2.5）
    for (let i = 0; i < 200; i++) s.tick(1 / 60);
    eq(s.isAware(1), true, '贴身应该能感觉到');
  });

  test('⚠️ 隔墙看不见（视线遮挡生效）', () => {
    const s = makeSys(new WallLOS());
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);   // 墙左边
    s.addTarget(100, 8, 0);                                    // 墙右边，正前方
    for (let i = 0; i < 300; i++) s.tick(1 / 60);
    eq(s.isAware(1), false, '隔墙不该被看见');
  });

  test('超出视距看不见', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.addTarget(100, 50, 0);                                   // 远超 sightRange=12
    for (let i = 0; i < 300; i++) s.tick(1 / 60);
    eq(s.isAware(1), false);
  });

  test('全向视野（炮台）能看见背后', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.turret, 0, 0, 0);
    s.addTarget(100, -6, 0);
    for (let i = 0; i < 200; i++) s.tick(1 / 60);
    eq(s.isAware(1), true, '全向视野应能看见背后');
  });

  test('⚠️ 声音能穿墙传播（视觉不行，听觉可以）', () => {
    /**
     * 【为什么这样断言】
     * "听觉穿墙"的精确含义是：**同样的隔墙场景下，
     * 视觉贡献 0，听觉贡献 > 0**。
     *
     * 不去断言"一定能发现"，因为发现与否还取决于响度、距离、
     * 以及是否连续发声——那是配平问题，不是穿墙与否的问题。
     * 这样断言失败时能立刻定位到"遮挡逻辑"这一层。
     */
    // 对照组：只有视觉，隔墙 → 警觉度恒为 0
    const sight = makeSys(new WallLOS());
    sight.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    sight.addTarget(100, 8, 0);
    for (let i = 0; i < 200; i++) sight.tick(1 / 60);
    eq(sight.alertOf(1), 0, '视觉隔墙应完全无效');

    // 实验组：加一次声音 → 警觉度必须 > 0
    const sound = makeSys(new WallLOS());
    sound.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    sound.addTarget(100, 8, 0);
    sound.emitSound(100, 8, 0, 1.0, 30);
    sound.tick(1 / 60);
    assert(sound.alertOf(1) > 0, '听觉应能穿墙（声音绕过了遮挡）');
  });

  test('连续发声最终会发现（单次只够起疑）', () => {
    const s = makeSys(new WallLOS());
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.addTarget(100, 8, 0);
    for (let i = 0; i < 10; i++) {
      s.emitSound(100, 8, 0, 1.0, 30);
      s.tick(0.1);
    }
    eq(s.isAware(1), true, '持续响声应最终发现');
  });

  test('⚠️ 近处响亮的声音能立刻发现', () => {
    const s = makeSys(new WallLOS());
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.emitSound(100, 0.5, 0, 1.0, 30);      // 几乎就在耳边
    for (let i = 0; i < 3; i++) s.tick(1 / 60);
    eq(s.isAware(1), true, '耳边开枪应立刻发现');
  });

  test('聋子听不见', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.turret, 0, 0, 0);   // hearingScale=0
    s.emitSound(100, 1, 0, 1.0, 100);
    for (let i = 0; i < 200; i++) s.tick(1 / 60);
    eq(s.isAware(1), false, 'hearingScale=0 应完全听不见');
  });

  test('声音超出半径听不见', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.emitSound(100, 100, 0, 1.0, 10);
    for (let i = 0; i < 100; i++) s.tick(1 / 60);
    eq(s.isAware(1), false);
  });

  test('被打无条件察觉', () => {
    const s = makeSys(new WallLOS());
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, Math.PI);   // 背对，且隔墙
    s.emit({ type: 'damage', sourceId: 100, x: 20, y: 0, intensity: 1, radius: 40 });
    s.tick(1 / 60);
    eq(s.isAware(1), true, '挨打应该立刻察觉');
  });

  test('⚠️ 目标消失后进入记忆，不会立刻忘记', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.addTarget(100, 5, 0);
    for (let i = 0; i < 200; i++) s.tick(1 / 60);
    eq(s.isAware(1), true);

    s.removeTarget(100);
    for (let i = 0; i < 60; i++) s.tick(1 / 60);   // 1 秒
    const p = s.lastKnownPosition(1);
    assert(p !== null, '应还记得最后位置');
    near(p!.x, 5, 0.01, '记住的应是最后看到的位置');
  });

  test('⚠️ 记忆过期后回到未察觉', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.addTarget(100, 5, 0);
    for (let i = 0; i < 200; i++) s.tick(1 / 60);
    s.removeTarget(100);

    // humanoid memoryTime=4，再等 8 秒
    for (let i = 0; i < 480; i++) s.tick(1 / 60);
    eq(s.isAware(1), false, '记忆过期后应回到未察觉');
    eq(s.lastKnownPosition(1), null, '记忆清空后不应还有位置');
  });

  test('⚠️ 同伴警报有延迟（不会瞬间全场响应）', () => {
    const spotted: number[] = [];
    const s = new PerceptionSystem({
      los: OpenLineOfSight,
      jitter: 0,
      allyAlertDelay: 2.0,
      allyAlertRadius: 20,
      onEvent: (e) => { if (e.type === 'spotted') spotted.push(e.selfId); },
    });
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    // 2 号背对且离目标远，自己发现不了，只能靠同伴警报
    s.addPerceiver(2, PerceptionPresets.humanoid, 15, 0, Math.PI);
    s.addTarget(100, 5, 0);

    // 只跑到 1 号刚发现
    for (let i = 0; i < 130; i++) s.tick(1 / 60);
    eq(spotted.includes(1), true, '1 号应发现');
    eq(spotted.includes(2), false, '2 号不应立刻知道（延迟 2 秒）');

    // 再等 3 秒
    for (let i = 0; i < 200; i++) s.tick(1 / 60);
    eq(spotted.includes(2), true, '延迟过后 2 号应收到警报');
  });

  test('forceSpot 强制发现', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.forceSpot(1, 100, 3, 4);
    eq(s.isAware(1), true);
    eq(s.targetOf(1), 100);
    near(s.lastKnownPosition(1)!.x, 3, 0.001);
  });

  test('forceForget 强制失忆（隐身成功）', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.forceSpot(1, 100, 3, 4);
    s.forceForget(1);
    eq(s.isAware(1), false);
    eq(s.alertOf(1), 0);
    eq(s.targetOf(1), -1);
  });

  test('reset 清空所有状态', () => {
    const s = makeSys();
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.forceSpot(1, 100, 3, 4);
    s.reset();
    eq(s.isAware(1), false);
    eq(s.alertOf(1), 0);
  });

  test('⚠️ 抖动为 0 时行为确定（可复现）', () => {
    function run(): boolean {
      const s = makeSys(OpenLineOfSight, 0);
      s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
      s.addTarget(100, 5, 0);
      for (let i = 0; i < 120; i++) s.tick(1 / 60);
      return s.alertOf(1) > 0.5;
    }
    eq(run(), run(), 'jitter=0 时同一场景结果应一致');
  });

  test('事件回调顺序：suspicious 在 spotted 之前', () => {
    const events: PerceptionEvent['type'][] = [];
    const s = new PerceptionSystem({
      los: OpenLineOfSight, jitter: 0,
      onEvent: (e) => events.push(e.type),
    });
    s.addPerceiver(1, PerceptionPresets.humanoid, 0, 0, 0);
    s.addTarget(100, 5, 0);
    for (let i = 0; i < 200; i++) s.tick(1 / 60);
    const first = events.indexOf('spotted');
    assert(first > 0, '应先有 suspicious 再有 spotted');
    assert(events.slice(0, first).includes('suspicious'));
  });
});

// ══════════════════════════════════════════════════════════
// 2. AttackToken
// ══════════════════════════════════════════════════════════

describe('AttackToken · 攻击令牌', () => {
  test('初始无人持有', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 2 });
    eq(t.activeCount, 0);
    eq(t.freeSlots, 2);
  });

  test('有空位时请求直接授予', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 2 });
    eq(t.request(1), 'active');
    eq(t.request(2), 'active');
    eq(t.activeCount, 2);
  });

  test('⚠️ 超出并发数时排队', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 2 });
    eq(t.request(1), 'active');
    eq(t.request(2), 'active');
    eq(t.request(3), 'queued', '第三个应排队');
    eq(t.activeCount, 2, '并发数不能超过 2');
  });

  test('归还后队列自动补位', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 2 });
    t.request(1);
    t.request(2);
    t.request(3);
    t.release(1);
    eq(t.activeCount, 2, '应立刻补位');
    eq(t.hasToken(3), true, '3 号应拿到令牌');
    eq(t.queuedCount, 0);
  });

  test('⚠️ 按优先级补位', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 1 });
    t.request(1, 10);          // 持有
    t.request(2, 1);           // 低优先级
    t.request(3, 100);         // 高优先级
    t.release(1);
    eq(t.hasToken(3), true, '应优先给优先级高的 3 号');
    eq(t.hasToken(2), false);
  });

  test('⚠️ 队列满时拒绝', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 1, maxQueued: 2 });
    t.request(1);
    eq(t.request(2), 'queued');
    eq(t.request(3), 'queued');
    eq(t.request(4), 'rejected', '队列满了应拒绝');
  });

  test('重复请求幂等，且能提升优先级', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 1 });
    eq(t.request(1), 'active');
    eq(t.request(1), 'active', '重复请求应幂等');
    eq(t.activeCount, 1, '不应产生重复令牌');

    t.request(2, 1);
    eq(t.request(2, 99), 'queued', '仍是排队态，但优先级已提升');
    t.release(1);
    eq(t.hasToken(2), true);
  });

  test('⚠️ 死亡自动归还（最关键的一条）', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 2 });
    t.request(1);
    t.request(2);
    t.remove(1);               // 死了
    eq(t.activeCount, 1, '死亡后令牌应自动归还');
    eq(t.hasToken(1), false);
  });

  test('⚠️ 死亡时也在排队则移除排队', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 1 });
    t.request(1);
    t.request(2);
    t.remove(2);
    eq(t.queuedCount, 0, '死亡后不应还留在队列里');
  });

  test('⚠️ 持有超时兜底（否则全体永久失去攻击能力）', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 2, holdTimeout: 1 });
    t.request(1);
    t.request(2);
    // 忘了归还，模拟攻击动画卡死
    for (let i = 0; i < 70; i++) t.tick(1 / 60);   // 1.17 秒
    eq(t.activeCount, 0, '超时应自动回收');
    eq(t.request(3), 'active', '回收后应有空位');
  });

  test('⚠️ holdTimeout 为 0 表示不限（不能被误判为立即超时）', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 1, holdTimeout: 0 });
    t.request(1);
    for (let i = 0; i < 600; i++) t.tick(1 / 60);
    eq(t.activeCount, 1, 'holdTimeout=0 表示不限时');
  });

  test('⚠️ 防饿死：等待久的低优先级最终能拿到', () => {
    const t = new AttackTokenSystem({
      maxConcurrent: 1,
      starvationAfter: 1,
      starvationGain: 100,
    });
    t.request(1, 0);
    t.request(2, 5);           // 优先级更高
    t.release(1);
    eq(t.hasToken(2), true);

    // 2 号一直持有不还，1 号重新请求
    t.request(1, 0);
    for (let i = 0; i < 120; i++) t.tick(1 / 60);   // 2 秒
    t.release(2);
    eq(t.hasToken(1), true, '等待足够久后 1 号应优先');
  });

  test('cancel 取消排队', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 1 });
    t.request(1);
    t.request(2);
    eq(t.cancel(2), true);
    eq(t.queuedCount, 0);
  });

  test('归还不存在的实体返回 false', () => {
    const t = new AttackTokenSystem();
    eq(t.release(999), false);
  });

  test('⚠️ 20 个敌人同时请求，并发数始终 <= max', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 3, maxQueued: 100 });
    for (let i = 0; i < 20; i++) t.request(i, i);
    assert(t.activeCount <= 3, `并发数 ${t.activeCount} 不应超过 3`);
    assert(t.activeCount === 3, '应填满 3 个位置');
    eq(t.queuedCount, 17);
  });

  test('reset 释放全部并触发事件', () => {
    const released: number[] = [];
    const t = new AttackTokenSystem({
      maxConcurrent: 2,
      onRelease: (id) => released.push(id),
    });
    t.request(1);
    t.request(2);
    t.request(3);
    t.reset();
    eq(t.activeCount, 0);
    eq(t.queuedCount, 0);
    eq(released.length, 3, '持有和排队的都应收到释放事件');
  });

  test('silentReset 不触发事件', () => {
    let n = 0;
    const t = new AttackTokenSystem({ maxConcurrent: 2, onRelease: () => n++ });
    t.request(1);
    t.silentReset();
    eq(t.activeCount, 0);
    eq(n, 0, 'silentReset 不应触发事件');
  });

  test('stats 统计', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 1 });
    t.request(1);
    t.request(2);
    for (let i = 0; i < 60; i++) t.tick(1 / 60);
    t.release(1);
    const s = t.stats();
    eq(s.active, 1);
    eq(s.queued, 0);
    assert(s.avgWait > 0.9 && s.avgWait < 1.1, `平均等待应约 1 秒，实际 ${s.avgWait}`);
  });

  test('dt<=0 不推进', () => {
    const t = new AttackTokenSystem({ maxConcurrent: 1, holdTimeout: 1 });
    t.request(1);
    t.tick(0);
    t.tick(-1);
    t.tick(NaN);
    eq(t.activeCount, 1, '非法 dt 不应推进超时');
  });
});

// ══════════════════════════════════════════════════════════
// 3. BulletPattern
// ══════════════════════════════════════════════════════════

describe('BulletPattern · 弹幕', () => {
  /**
   * 【API 说明】
   * `BulletPattern` 只负责"这一帧该生成哪些子弹"，
   * 生成结果 `BulletSpawn` 是**纯数据**（角度+速度，不是 dx/dy），
   * 由业务层决定怎么变成实体。
   *
   * 速度在 `Shapes` 里配，不在 EmitterOptions 里——
   * 因为速度是"形状"的一部分（三连发速度递增就是典型）。
   */
  test('环形弹幕：均匀分布在 360°', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.ring(8, 10, 'bullet'), interval: 0.5 });
    bp.play();
    const spawns = bp.tick(0.6);
    eq(spawns.length, 8, '应生成 8 发');

    // 检查均匀性：相邻角度差应为 45°
    const angles = spawns.map((s) => s.angle).sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i++) {
      near(angles[i] - angles[i - 1], Math.PI / 4, 1e-6, '相邻应差 45°');
    }
    for (const s of spawns) eq(s.speed, 10);
  });

  test('⚠️ 方向是角度不是向量（不会因浮点累积漂移）', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.ring(4, 5, 'b'), interval: 0.5 });
    bp.play();
    for (const s of bp.tick(0.6)) {
      assert(Number.isFinite(s.angle), '角度必须是有限数');
      assert(s.speed > 0, '速度应为正');
    }
    // 业务侧要向量时用 angleToVec
    const v = angleToVec(Math.PI / 4, 10);
    near(Math.hypot(v.x, v.y), 10, 1e-9, 'angleToVec 应带上速度大小');
  });

  test('扇形弹幕：张角范围内', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({
      id: 'e', shape: Shapes.fan(5, 90, 8, 'b'),
      interval: 0.5, fixedAngle: 0, aimAtTarget: false,
    });
    bp.play();
    for (const s of bp.tick(0.6)) {
      let a = s.angle;
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      assert(Math.abs(a) <= Math.PI / 2 + 1e-6, `角度 ${a} 应在 ±45° 内`);
    }
  });

  test('⚠️ 间隔生效：不会一帧全出', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.ring(1, 5, 'b'), interval: 0.5, shots: 3 });
    bp.play();
    eq(bp.tick(0.51).length, 1, '第一次只出 1 发');
    eq(bp.tick(0.2).length, 0, '未到间隔不生成');
    eq(bp.tick(0.4).length, 1, '到间隔才生成');
  });

  test('有限次数后发射器结束', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.ring(2, 5, 'b'), interval: 0.1, shots: 3 });
    bp.play();
    let total = 0;
    for (let i = 0; i < 200; i++) total += bp.tick(0.05).length;
    eq(total, 6, '3 次开火 × 每次 2 发 = 6');
    eq(bp.isEmitterDone('e'), true);
  });

  test('⚠️ 无限弹幕不会死循环', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.ring(1, 5, 'b'), interval: 0.05 });
    bp.play();
    const t0 = Date.now();
    let total = 0;
    for (let i = 0; i < 600; i++) total += bp.tick(1 / 60).length;
    assert(Date.now() - t0 < 2000, '不应卡住');
    // 10 秒 / 0.05 间隔 ≈ 200 发
    assert(total > 150 && total <= 210, `应约 200 发，实际 ${total}`);
  });

  test('螺旋弹幕：每次开火整体旋转', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({
      id: 'e', shape: Shapes.spiral(1, 5, 'b', 30),
      interval: 0.1, fixedAngle: 0, aimAtTarget: false,
    });
    bp.play();
    const angles: number[] = [];
    for (let i = 0; i < 100 && angles.length < 3; i++) {
      for (const s of bp.tick(0.05)) angles.push(s.angle);
    }
    eq(angles.length, 3);
    // 每次旋转 30°
    near(angles[1] - angles[0], Math.PI / 6, 1e-6, '应旋转 30°');
    near(angles[2] - angles[1], Math.PI / 6, 1e-6);
  });

  test('三连发：速度递增', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.triple('b', [5, 8, 12]), interval: 0.5 });
    bp.play();
    const spawns = bp.tick(0.6);
    eq(spawns.length, 3);
    eq(spawns[0].speed, 5);
    eq(spawns[1].speed, 8);
    eq(spawns[2].speed, 12, 'speed 数组应按 index 取');
  });

  test('⚠️ speed 数组越界取模（不是返回 0）', () => {
    eq(speedAt({ count: 1, typeId: 'b', speed: [4, 8] }, 5), 8, 'index 5 → 5%2=1 → 8');
    eq(speedAt({ count: 1, typeId: 'b', speed: [4, 8] }, 0), 4);
    eq(speedAt({ count: 1, typeId: 'b', speed: [] }, 0), 0, '空数组兜底为 0');
  });

  test('镜像弹幕：左右对称', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({
      id: 'e', shape: Shapes.cross(2, 60, 5, 'b'),
      interval: 0.5, fixedAngle: 0, aimAtTarget: false,
    });
    bp.play();
    const spawns = bp.tick(0.6);
    eq(spawns.length, 4, '2 颗 × 镜像 2 份 = 4');
    let sum = 0;
    for (const s of spawns) {
      let a = s.angle;
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      sum += a;
    }
    near(sum, 0, 1e-6, '镜像应左右对称，角度和为 0');
  });

  test('delay 首次开火延迟', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.ring(1, 5, 'b'), interval: 0.1, delay: 0.5 });
    bp.play();
    // 累计到 0.45s：delay 未到
    let n = 0;
    for (let i = 0; i < 45; i++) n += bp.tick(0.01).length;
    eq(n, 0, 'delay(0.5s) 内不应发射');
    // 继续到 0.65s
    for (let i = 0; i < 20; i++) n += bp.tick(0.01).length;
    eq(n, 1, 'delay(0.5)+interval(0.1)=0.6s 时发出第 1 发');
  });

  test('stop / restartEmitter', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.ring(1, 5, 'b'), interval: 0.05 });
    bp.play();
    bp.tick(0.1);
    bp.stop();
    eq(bp.tick(1).length, 0, 'stop 后不再生成');
    bp.restartEmitter('e');
    bp.play();
    eq(bp.tick(0.06).length, 1, 'restart + play 后恢复');
  });

  test('setEmitterActive 暂停单个发射器', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.ring(1, 5, 'b'), interval: 0.05 });
    bp.play();
    bp.setEmitterActive('e', false);
    eq(bp.tick(1).length, 0);
    bp.setEmitterActive('e', true);
    eq(bp.tick(0.06).length, 1);
  });

  test('reset 重置计数', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.ring(1, 5, 'b'), interval: 0.05, shots: 1 });
    bp.play();
    bp.tick(0.06);
    eq(bp.isEmitterDone('e'), true);
    bp.reset();
    eq(bp.isEmitterDone('e'), false, 'reset 后应恢复');
  });

  test('多个发射器独立工作', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'a', shape: Shapes.ring(3, 5, 'A'), interval: 0.5 });
    bp.addEmitter({ id: 'b', shape: Shapes.ring(2, 5, 'B'), interval: 0.5 });
    bp.play();
    const spawns = bp.tick(0.6);
    eq(spawns.filter((s) => s.typeId === 'A').length, 3);
    eq(spawns.filter((s) => s.typeId === 'B').length, 2);
  });

  test('⚠️ 未 play 时不生成', () => {
    const bp = new BulletPattern(new RNG(1));
    bp.addEmitter({ id: 'e', shape: Shapes.ring(4, 5, 'b'), interval: 0.5 });
    eq(bp.tick(1).length, 0, 'play 之前不应生成');
    bp.play();
    eq(bp.tick(0.6).length, 4);
  });

  test('角度工具函数', () => {
    near(normalizeAngle2Pi(Math.PI * 3), Math.PI, 1e-9, '3π → π');
    near(normalizeAngle2Pi(-Math.PI), Math.PI, 1e-9, '-π → π');
    near(normalizeAngle2Pi(0), 0, 1e-9);
    // 跨 ±π 走最短弧
    const a = lerpAngle(Math.PI * 0.9, -Math.PI * 0.9, 0.5);
    assert(Math.abs(a) > Math.PI * 0.9, `应走短路径经 ±π，实际 ${a}`);
  });

  test('compileShape 自定义形状', () => {
    const fn = compileShape({
      count: 3, typeId: 'x', speed: 1,
      spreadDeg: 90,
    });
    const out = fn({ aim: 0, shotIndex: 0, rng: new RNG(1) });
    eq(out.length, 3, '应产出 3 个角度');
    for (const a of out) assert(Number.isFinite(a));
  });

  test('SequencePlayer 按时间顺序播放', () => {
    const fired: string[] = [];
    const steps: SequenceStep[] = [
      { at: 0, action: 'start', emitter: 'a' },
      { at: 0.5, action: 'start', emitter: 'b' },
      { at: 1.0, action: 'stop', emitter: 'c' },
    ];
    const p = new SequencePlayer(steps);
    p.start();
    for (let i = 0; i < 80; i++) p.tick(1 / 60, (st) => fired.push(st.emitter));
    eq(fired.join(','), 'a,b,c', '应按时间顺序触发');
  });

  test('SequencePlayer 未 start 不触发', () => {
    let n = 0;
    const p = new SequencePlayer([{ at: 0, action: 'start', emitter: 'x' }]);
    for (let i = 0; i < 60; i++) p.tick(1 / 60, () => n++);
    eq(n, 0, 'start 之前不应触发');
  });

  test('SequencePlayer stop 停止', () => {
    let n = 0;
    const p = new SequencePlayer([
      { at: 0, action: 'start', emitter: 'a' },
      { at: 0.5, action: 'start', emitter: 'b' },
    ]);
    p.start();
    p.tick(0.001, () => n++);
    p.stop();
    for (let i = 0; i < 100; i++) p.tick(1 / 60, () => n++);
    eq(n, 1, 'stop 后不应继续触发');
  });
});

// ══════════════════════════════════════════════════════════
// 4. Element
// ══════════════════════════════════════════════════════════

describe('ElementSystem · 元素反应', () => {
  const ELEMENTS: readonly ElementDef[] = [
    { id: 'fire', decay: 10, maxGauge: 100 },
    { id: 'water', decay: 10, maxGauge: 100 },
    { id: 'shock', decay: 12, maxGauge: 100 },
  ];

  /**
   * 【注意】ReactionDef 只有 gaugeCost / consumeAll / data。
   * 伤害、范围、眩晕这些**效果**放在 `data` 里由业务解释——
   * 这正是零业务依赖的体现：系统只管"反应了、消耗多少"，
   * 不关心"造成什么效果"。
   */
  const REACTIONS: readonly ReactionDef[] = [
    { id: 'steam', base: 'water', applied: 'fire', consumeAll: true, data: { damage: 30 } },
    { id: 'overload', base: 'fire', applied: 'shock', consumeAll: true, data: { damage: 50, aoe: 3 } },
    { id: 'conduct', base: 'water', applied: 'shock', gaugeCost: 10, consumeAll: false, data: { stun: 1.5 } },
  ];

  function make() {
    return new ElementSystem({ elements: ELEMENTS, reactions: REACTIONS });
  }

  test('施加元素会积累', () => {
    const e = make();
    const r = e.apply(1, 'fire', 40);
    eq(e.elementOf(1), 'fire');
    eq(e.gaugeOf(1), 40);
    eq(r.reactionId, '', '首次施加不反应（reactionId 为空串）');
  });

  test('⚠️ 不同元素触发反应并消耗', () => {
    const e = make();
    e.apply(1, 'water', 50);
    const r = e.apply(1, 'fire', 50);
    eq(r.reactionId, 'steam', '应触发蒸发');
    eq(e.elementOf(1), '', '反应后元素应清空');
    eq(r.remainingGauge, 0, 'consumeAll 应清空 base');
  });

  test('相同元素只叠加不反应', () => {
    const e = make();
    e.apply(1, 'fire', 30);
    const r = e.apply(1, 'fire', 30);
    eq(r.reactionId, '', '同元素不反应');
    eq(e.gaugeOf(1), 60, '应累加');
  });

  test('⚠️ 上限截断', () => {
    const e = make();
    e.apply(1, 'fire', 500);
    eq(e.gaugeOf(1), 100, '不应超过 max');
  });

  test('衰减：随时间下降', () => {
    const e = make();
    e.apply(1, 'fire', 100);
    e.tick(2);                       // decay=10/s
    eq(e.gaugeOf(1), 80);
  });

  test('⚠️ 衰减到 0 时清空元素类型', () => {
    const e = make();
    e.apply(1, 'fire', 10);
    e.tick(2);
    eq(e.gaugeOf(1), 0);
    eq(e.elementOf(1), '', '衰减到 0 应清空类型');
  });

  test('conduct 不消耗基础元素', () => {
    const e = make();
    e.apply(1, 'water', 60);
    const r = e.apply(1, 'shock', 60);
    eq(r.reactionId, 'conduct');
    eq(e.elementOf(1), 'water', 'conduct 应保留水元素');
    assert(e.gaugeOf(1) > 0, '水元素应残留（consumeAll=false）');
    eq(r.data !== undefined, true, 'data 应透传');
  });

  test('peek 可以预查反应（不改变状态）', () => {
    const e = make();
    const r = e.peek('water', 'fire');
    eq(r!.id, 'steam');
    eq(r!.base, 'water');
    eq(r!.applied, 'fire');
    // peek 不应改变任何状态
    eq(e.elementOf(1), '');
  });

  test('⚠️ 未知元素会抛错（不静默忽略）', () => {
    const e = make();
    throws(() => e.apply(1, '不存在的元素', 10), '未定义');
  });

  test('⚠️ 未知元素在配置里会抛错（构造时）', () => {
    throws(
      () => new ElementSystem({
        elements: [{ id: 'fire', decay: 1, maxGauge: 100 }],
        reactions: [{ id: 'x', base: 'fire', applied: '不存在的元素' }],
      }),
      '未定义',
    );
  });

  test('set / clear 强制设置', () => {
    const e = make();
    e.set(1, 'fire', 77);
    eq(e.gaugeOf(1), 77);
    e.clear(1);
    eq(e.gaugeOf(1), 0);
  });

  test('clearAll 清空所有目标', () => {
    const e = make();
    e.apply(1, 'fire', 50);
    e.apply(2, 'water', 50);
    e.clearAll();
    eq(e.gaugeOf(1), 0);
    eq(e.gaugeOf(2), 0);
  });

  test('✅ 配置校验：未配反应会警告', () => {
    const v = validateReactions(
      [{ id: 'fire', decay: 1, maxGauge: 100 }, { id: 'ice', decay: 1, maxGauge: 100 }],
      [],
    );
    assert(v.warnings.length > 0, '两个元素没有反应应给出警告');
  });

  test('✅ 配置校验：反应不对称会警告', () => {
    const v = validateReactions(
      [
        { id: 'a', decay: 1, maxGauge: 100 },
        { id: 'b', decay: 1, maxGauge: 100 },
      ],
      [{ id: 'ab', base: 'a', applied: 'b' }],
    );
    assert(
      v.warnings.some((w) => w.includes('b') && w.includes('a')),
      '只配了 A→B 没配 B→A 应警告',
    );
  });

  test('✅ 配置校验：正常配置无错误', () => {
    const v = validateReactions(ELEMENTS, REACTIONS);
    eq(v.errors.length, 0);
  });
});

// ══════════════════════════════════════════════════════════
// 5. Targeting
// ══════════════════════════════════════════════════════════

describe('TargetSelector · 目标选择', () => {
  const CANDIDATES: readonly TargetCandidate[] = [
    { id: 1, x: 10, y: 0, selectable: true },
    { id: 2, x: 3, y: 0, selectable: true },
    { id: 3, x: 20, y: 0, selectable: true },
  ];

  test('基础选择：默认选最近的', () => {
    const t = new TargetSelector();
    t.addScorer(byDistance());
    t.update(0, CANDIDATES);
    eq(t.current === 2, true, '应选最近的 2 号（距离 3）');
  });

  test('⚠️ 无候选时清空目标', () => {
    const t = new TargetSelector();
    t.addScorer(byDistance());
    t.update(0, CANDIDATES);
    eq(t.current === 2, true);
    /**
     * 【为什么不能立刻清空】
     * 目标短暂被遮挡（躲到柱子后一帧）时，
     * 立刻清空会让锁定疯狂闪烁。
     * 所以有一段宽限期 `graceTime`，需要真实推进 dt 才耗尽。
     */
    for (let i = 0; i < 60; i++) t.update(1 / 60, []);
    eq(t.current, null, '宽限期过后应清空，而不是永远留着旧目标');
  });

  test('⚠️ 粘性：不会因微小差异反复切换', () => {
    const t = new TargetSelector();
    t.addScorer(byDistance());
    t.addScorer(byStickiness(3));
    t.update(0, CANDIDATES);
    const first = t.current;
    // 两个目标距离几乎相同，反复抖动应被粘性压住
    for (let i = 0; i < 30; i++) {
      t.update(1 / 60, [
        { id: 1, x: 10.0 + (i % 2) * 0.05, y: 0, selectable: true },
        { id: 2, x: 10.0, y: 0, selectable: true },
      ]);
    }
    eq(t.current, first, '粘性应让目标保持稳定，不来回抖动');
  });

  test('角度评分：优先准星方向', () => {
    const t = new TargetSelector();
    t.addScorer(byAngle(1));            // 用宿主的 originX/originY/facing
    t.originX = 0;
    t.originY = 0;
    t.facing = 0;                       // 面向 +X
    t.update(0, [
      { id: 1, x: 10, y: 0, selectable: true },      // 正前方
      { id: 2, x: 10, y: 10, selectable: true },     // 偏 45°
    ]);
    eq(t.current === 1, true, '应选正前方的');
  });

  test('权重评分', () => {
    const t = new TargetSelector();
    t.addScorer(byWeight((c) => (c.id === 3 ? 100 : 1)));
    t.update(0, CANDIDATES);
    eq(t.current === 3, true, '应选权重最高的');
  });

  test('manual 模式下不自动切换', () => {
    const t = new TargetSelector();
    t.addScorer(byDistance());
    t.setMode('free');
    t.update(0, CANDIDATES);
    eq(t.current, null, 'free 模式不锁定目标');
  });

  test('cycle 手动切换', () => {
    const t = new TargetSelector();
    t.addScorer(byDistance());
    t.update(0, CANDIDATES);
    const first = t.current;
    eq(t.cycle(CANDIDATES, 1, 0), true);
    assert(t.current !== first, 'cycle 应换目标');
    assert(t.current !== null);
  });

  test('lock 强制锁定', () => {
    const t = new TargetSelector();
    t.addScorer(byDistance());
    t.update(0, CANDIDATES);
    t.lock(3);
    eq(t.current === 3, true);
    t.update(0, CANDIDATES);
    eq(t.current === 3, true, '锁定后不应被评分改变');
  });

  test('unlock 解除锁定', () => {
    const t = new TargetSelector();
    t.addScorer(byDistance());
    t.update(0, CANDIDATES);
    t.lock(3);
    t.unlock();
    t.update(0, CANDIDATES);
    eq(t.current === 2, true, '解锁后应按评分回到最近的');
  });

  test('aimAngle 返回当前目标角度', () => {
    const t = new TargetSelector();
    t.addScorer(byDistance());
    t.update(0, CANDIDATES);
    const a = t.aimAngle(CANDIDATES);
    assert(a !== null);
    near(a!, 0, 1e-6, '目标在 +X 方向');
  });

  test('clearScorers 后无评分器不至于崩溃', () => {
    const t = new TargetSelector();
    t.addScorer(byDistance());
    t.clearScorers();
    t.update(0, CANDIDATES);
    assert(t.current === null || typeof t.current === 'number', '不应崩溃');
  });
});

// ══════════════════════════════════════════════════════════
// 6. Combo
// ══════════════════════════════════════════════════════════

describe('ComboSystem · 连招', () => {
  /**
   * 【API 说明】
   * - `MoveDef.inputs` 是输入序列（不是 `sequence`）
   * - `MoveTriggered.moveId`（不是 `id`）
   * - `tick()` 返回超时后触发的短招式，**必须每帧调用**
   *
   * 【核心机制】
   * 输入先进缓冲。若当前缓冲是某个更长招式的**前缀**，
   * 就等待（不立即触发短的）；否则立即触发能匹配的最长招式。
   * 窗口超时后，触发当前能匹配的最长招式。
   */
  const MOVES: readonly MoveDef[] = [
    { id: 'jab', inputs: ['light'] },
    { id: 'jab_jab', inputs: ['light', 'light'] },
    { id: 'jab_jab_heavy', inputs: ['light', 'light', 'heavy'] },
    { id: 'heavy_only', inputs: ['heavy'] },
  ];

  function make(moves: readonly MoveDef[] = MOVES, opts = {}) {
    return new ComboSystem({ moves, inputWindow: 0.5, ...opts });
  }

  test('单段招式在窗口超时后触发', () => {
    const c = make();
    eq(c.input('light'), null, 'light 是更长招式的前缀，应先等待');
    // 推进超时
    let r: MoveTriggered | null = null;
    for (let i = 0; i < 40 && !r; i++) r = c.tick(1 / 60);
    assert(r !== null, '超时应触发');
    eq(r!.moveId, 'jab');
  });

  test('⚠️ 非前缀的输入立即触发', () => {
    const c = make([
      { id: 'heavy_only', inputs: ['heavy'] },
      { id: 'jab', inputs: ['light'] },
    ]);
    const r = c.input('heavy');
    assert(r !== null, 'heavy 不是任何更长招式的前缀，应立即触发');
    eq(r!.moveId, 'heavy_only');
  });

  test('两段连招', () => {
    const c = make();
    c.input('light');
    /**
     * 【机制】`light,light` 同时是 `jab_jab` 的终点
     * 和 `jab_jab_heavy` 的前缀 → 系统选择**等待**。
     * 所以 `input()` 返回 null，由 `tick()` 在窗口超时时结算。
     */
    eq(c.input('light'), null, '是更长招式的前缀，应先等待');
    let r: MoveTriggered | null = null;
    for (let i = 0; i < 40 && !r; i++) r = c.tick(1 / 60);
    assert(r !== null, '窗口超时后必须出招');
    eq(r!.moveId, 'jab_jab', '等待结束应结算为能匹配的最长招式');
  });

  test('三段连招', () => {
    const c = make();
    c.input('light');
    c.input('light');
    const r = c.input('heavy');
    assert(r !== null, 'heavy 不是更长前缀，应立即触发三连');
    eq(r!.moveId, 'jab_jab_heavy');
    eq(r!.length, 3, '匹配长度应为 3');
  });

  test('⚠️ 窗口超时后短招式生效（不能永远挂着）', () => {
    const c = make();
    c.input('light');
    // 不继续输入，推进超过窗口 → 应触发 jab
    let r: MoveTriggered | null = null;
    for (let i = 0; i < 40 && !r; i++) r = c.tick(1 / 60);
    assert(r !== null, '窗口过后必须触发，否则玩家会觉得"按了没反应"');
    eq(r!.moveId, 'jab');
    eq(c.buffered.length, 0, '触发后缓冲应清空');
  });

  test('⚠️ 忘记 tick 会导致输入挂起（tick 是必须的）', () => {
    const c = make();
    c.input('light');
    // 完全不 tick
    eq(c.buffered.length, 1, '输入应仍挂在缓冲里');
    eq(c.pending, true);
  });

  test('cancel 清空缓冲', () => {
    const c = make();
    c.input('light');
    c.cancel();
    eq(c.buffered.length, 0);
    eq(c.pending, false);
  });

  test('reset 重置', () => {
    const c = make();
    c.input('light');
    c.reset();
    eq(c.buffered.length, 0);
    eq(c.pending, false);
  });

  test('⚠️ 无匹配的输入触发 onMismatch', () => {
    const missed: string[] = [];
    const c = make(MOVES, { onMismatch: (i: string) => missed.push(i) });
    c.input('不存在的输入');
    eq(missed.length, 1, '无匹配应通知');
    eq(missed[0], '不存在的输入');
  });

  test('onMove 回调', () => {
    const fired: string[] = [];
    const c = make(MOVES, { onMove: (m: MoveTriggered) => fired.push(m.moveId) });
    c.input('heavy');
    eq(fired[0], 'heavy_only');
  });

  test('⚠️ 优先级：同序列取大的', () => {
    const c = make([
      { id: 'weak', inputs: ['light', 'light'], priority: 1 },
      { id: 'strong', inputs: ['light', 'light'], priority: 99 },
    ]);
    c.input('light');
    let r: MoveTriggered | null = c.input('light');
    for (let i = 0; i < 40 && !r; i++) r = c.tick(1 / 60);
    assert(r !== null);
    eq(r!.moveId, 'strong', '应取优先级高的');
  });

  test('condition 不满足时跳过该招式', () => {
    const c = make([
      { id: 'ground', inputs: ['light'] },
      { id: 'air', inputs: ['light'], priority: 10, condition: () => false },
    ]);
    let r: MoveTriggered | null = c.input('light');
    for (let i = 0; i < 40 && !r; i++) r = c.tick(1 / 60);
    assert(r !== null);
    eq(r!.moveId, 'ground', '条件不满足的应被跳过');
  });

  test('⚠️ 招式级 window 覆盖全局', () => {
    /**
     * 【前提】招式窗口只在"需要等待"时才有意义。
     * 若 `['a']` 是唯一招式，它是叶子 → 立即触发，窗口无关。
     * 所以要配一个 `['a','a']` 让 `['a']` 变成前缀。
     */
    const c = make([
      { id: 'slow', inputs: ['a'], window: 1.0 },
      { id: 'slow2', inputs: ['a', 'a'] },
    ]);
    eq(c.input('a'), null, '是 slow2 的前缀，应等待');

    let r: MoveTriggered | null = null;
    for (let i = 0; i < 40 && !r; i++) r = c.tick(1 / 60);   // 0.67s
    eq(r, null, '全局窗口 0.5s 已过，但招式窗口 1.0s 未到，不应触发');
    for (let i = 0; i < 30 && !r; i++) r = c.tick(1 / 60);   // 累计 1.17s
    assert(r !== null, '超过招式窗口 1.0s 应触发');
    eq(r!.moveId, 'slow');
  });

  test('⚠️ 不配 window 时用全局窗口', () => {
    const c = make([
      { id: 'x', inputs: ['a'] },
      { id: 'y', inputs: ['a', 'a'] },
    ]);
    c.input('a');
    let r: MoveTriggered | null = null;
    for (let i = 0; i < 25 && !r; i++) r = c.tick(1 / 60);   // 0.42s < 0.5
    eq(r, null, '全局窗口 0.5s 未到，不应触发');
    for (let i = 0; i < 15 && !r; i++) r = c.tick(1 / 60);   // 累计 0.67s
    assert(r !== null, '超过全局窗口应触发');
  });

  test('✅ 配置校验：完全重复的序列', () => {
    const v = validateCombos([
      { id: 'a', inputs: ['light'] },
      { id: 'b', inputs: ['light'] },
    ]);
    assert(v.errors.length > 0 || v.warnings.length > 0, '重复序列应被报告');
  });

  test('✅ 配置校验：正常连招无错误', () => {
    const v = validateCombos(MOVES);
    eq(v.errors.length, 0);
  });

  test('空配置不崩溃', () => {
    const c = make([]);
    eq(c.input('light'), null, '没有招式定义应返回 null');
    eq(c.tick(1), null);
  });

  test('moveCount 正确', () => {
    eq(make().moveCount, 4);
  });
});

// ══════════════════════════════════════════════════════════
// 7. Objective
// ══════════════════════════════════════════════════════════

describe('ObjectiveSystem · 关卡目标', () => {
  test('计数目标：达标完成', () => {
    const o = new ObjectiveSystem({
      objectives: [Objectives.kill('k', 10)],
    });
    o.tick(0.001);                 // 目标在 tick 中激活
    eq(o.status('k'), 'active');
    o.addProgress('k', 10);
    eq(o.status('k'), 'completed');
    eq(o.finished, true);
  });

  test('⚠️ 限时目标：超时失败', () => {
    const o = new ObjectiveSystem({
      objectives: [Objectives.timeLimit('t', 5)],
    });
    for (let i = 0; i < 60 * 6; i++) o.tick(1 / 60);
    eq(o.status('t'), 'failed', '超过 5 秒应失败');
    eq(o.failed, true);
  });

  test('⚠️ 保护目标：初始值 = target，掉光则失败', () => {
    const o = new ObjectiveSystem({
      objectives: [Objectives.protect('p', 5)],
    });
    o.tick(0.001);
    eq(o.progress('p'), 5, '保护目标初始应满值');
    o.addProgress('p', -3);
    eq(o.progress('p'), 2);
    o.addProgress('p', -2);
    eq(o.status('p'), 'failed');
    eq(o.failed, true);
  });

  test('⚠️ 生存目标：tick 推进时间', () => {
    const o = new ObjectiveSystem({
      objectives: [{ id: 's', kind: 'survive', target: 30 }],
    });
    for (let i = 0; i < 60 * 31; i++) o.tick(1 / 60);
    eq(o.status('s'), 'completed');
    eq(o.totalTime > 30, true);
  });

  test('到达目标：markReached 完成', () => {
    const o = new ObjectiveSystem({
      objectives: [Objectives.reach('r')],
    });
    o.tick(0.001);
    o.markReached('r');
    eq(o.status('r'), 'completed');
  });

  test('⚠️ 前置依赖：未完成时后续不激活', () => {
    const o = new ObjectiveSystem({
      objectives: [
        Objectives.kill('a', 3),
        Objectives.after(Objectives.kill('b', 3), ['a']),
      ],
    });
    o.tick(0.001);
    eq(o.status('a'), 'active');
    eq(o.status('b'), 'inactive', 'b 应等 a 完成');
    o.addProgress('a', 3);
    o.tick(0.001);
    eq(o.status('b'), 'active', 'a 完成后 b 应激活');
  });

  test('⚠️ 循环依赖构造时抛错', () => {
    throws(
      () => new ObjectiveSystem({
        objectives: [
          Objectives.after(Objectives.kill('a', 1), ['b']),
          Objectives.after(Objectives.kill('b', 1), ['a']),
        ],
      }),
      '循环',
    );
  });

  test('自依赖也算循环', () => {
    throws(
      () => new ObjectiveSystem({
        objectives: [Objectives.after(Objectives.kill('a', 1), ['a'])],
      }),
      '循环',
    );
  });

  test('⚠️ 关键目标失败 → 整关失败', () => {
    const o = new ObjectiveSystem({
      objectives: [
        Objectives.protect('main', 2),
        Objectives.optional(Objectives.kill('side', 5)),
      ],
    });
    o.tick(0.001);
    o.addProgress('main', -5);
    eq(o.failed, true);
    eq(o.failedId, 'main');
  });

  test('非关键目标失败不导致整关失败', () => {
    const o = new ObjectiveSystem({
      objectives: [
        Objectives.kill('main', 2),
        Objectives.optional(Objectives.protect('side', 2)),
      ],
    });
    o.tick(0.001);
    o.addProgress('side', -5);
    eq(o.status('side'), 'failed');
    eq(o.failed, false, '非关键目标失败不应整关失败');
  });

  test('进度不会越界', () => {
    const o = new ObjectiveSystem({
      objectives: [Objectives.kill('k', 5)],
    });
    o.tick(0.001);
    o.addProgress('k', 100);
    eq(o.progress('k'), 5, '不应超过 target');
  });

  test('ratio 归一化', () => {
    const o = new ObjectiveSystem({
      objectives: [Objectives.kill('k', 10)],
    });
    o.tick(0.001);
    o.addProgress('k', 3);
    near(o.ratio('k'), 0.3, 1e-6);
  });

  test('reset 重置进度', () => {
    const o = new ObjectiveSystem({
      objectives: [Objectives.kill('k', 10)],
    });
    o.tick(0.001);
    o.addProgress('k', 10);
    o.reset();
    o.tick(0.001);
    eq(o.status('k'), 'active');
    eq(o.progress('k'), 0);
  });

  test('forceActivate 强制激活', () => {
    const o = new ObjectiveSystem({
      objectives: [
        Objectives.kill('a', 1),
        Objectives.after(Objectives.kill('b', 1), ['a']),
      ],
    });
    o.tick(0.001);
    eq(o.status('b'), 'inactive');
    o.forceActivate('b');
    eq(o.status('b'), 'active');
  });
});

// ══════════════════════════════════════════════════════════
// 8. Difficulty
// ══════════════════════════════════════════════════════════

describe('DifficultySystem · 难度与 DDA', () => {
  test('默认档位存在', () => {
    const d = new DifficultySystem();
    assert(d.tiers().length > 0);
    assert(DEFAULT_TIERS.length > 0);
  });

  test('切换档位改变倍率', () => {
    const d = new DifficultySystem();
    d.setTier('easy');
    const easy = d.multiplier('enemyDamage');
    d.setTier('hard');
    const hard = d.multiplier('enemyDamage');
    assert(hard > easy, `困难档敌人伤害应更高：easy=${easy}, hard=${hard}`);
  });

  test('切换不存在的档位返回 false', () => {
    const d = new DifficultySystem();
    eq(d.setTier('不存在的档位'), false);
  });

  test('⚠️ DDA：表现好则难度上升', () => {
    const d = new DifficultySystem({ dda: { enabled: true } });
    d.setTier('normal');
    const before = d.multiplier('enemyDamage');
    // 表现好 = performance 高
    for (let i = 0; i < 20; i++) {
      d.report(0.9, 30);
      d.tick(1);
    }
    const after = d.multiplier('enemyDamage');
    assert(after > before, `表现好难度应上升：${before} → ${after}`);
  });

  test('⚠️ DDA：表现差则难度下降', () => {
    const d = new DifficultySystem({ dda: { enabled: true } });
    d.setTier('normal');
    const before = d.multiplier('enemyDamage');
    for (let i = 0; i < 20; i++) {
      d.report(0.1, 30);
      d.tick(1);
    }
    const after = d.multiplier('enemyDamage');
    assert(after < before, `表现差难度应下降：${before} → ${after}`);
  });

  test('⚠️ DDA 调节有上下限（不会无限缩放）', () => {
    const d = new DifficultySystem({ dda: { enabled: true } });
    d.setTier('normal');
    for (let i = 0; i < 500; i++) {
      d.report(1.0, 30);
      d.tick(1);
    }
    const m = d.multiplier('enemyDamage');
    const base = d.baseMultiplier('enemyDamage');
    assert(m < base * 3, `不应无限放大：${m} vs base ${base}`);
    assert(m > base * 0.3, '也不应无限缩小');
  });

  test('关闭 DDA 后不再调节', () => {
    const d = new DifficultySystem({ dda: { enabled: true } });
    d.setTier('normal');
    const base = d.baseMultiplier('enemyDamage');
    d.setDDAEnabled(false);
    for (let i = 0; i < 50; i++) {
      d.report(1.0, 30);
      d.tick(1);
    }
    near(d.multiplier('enemyDamage'), base, 1e-6, '关闭后应保持基础倍率');
  });

  test('resetDDA 重置调节量', () => {
    const d = new DifficultySystem({ dda: { enabled: true } });
    d.setTier('normal');
    for (let i = 0; i < 20; i++) { d.report(1.0, 30); d.tick(1); }
    const base = d.baseMultiplier('enemyDamage');
    d.resetDDA();
    near(d.multiplier('enemyDamage'), base, 1e-6);
  });

  test('allMultipliers 返回全部', () => {
    const d = new DifficultySystem();
    const all = d.allMultipliers();
    assert(Object.keys(all).length > 0);
    assert('enemyDamage' in all, '应包含 enemyDamage');
  });

  test('computePerformance 合成表现分', () => {
    // 完美：没受伤、没死、清得快、资源充足
    const p = computePerformance({
      hurtRatio: 0,
      deaths: 0,
      clearSpeed: 1,
      resourceLeft: 1,
    });
    // 糟糕：一直挨打、死了几次、打得慢、资源耗尽
    const q = computePerformance({
      hurtRatio: 1,
      deaths: 5,
      clearSpeed: 0,
      resourceLeft: 0,
    });
    assert(p > q, `表现好应得分高：${p} vs ${q}`);
    assert(p >= 0 && p <= 1, `应归一化到 0~1，实际 ${p}`);
    assert(q >= 0 && q <= 1, `应归一化到 0~1，实际 ${q}`);
  });

  test('computePerformance 缺项用默认值（不崩溃）', () => {
    const p = computePerformance({});
    assert(p >= 0 && p <= 1, `空信号应返回安全值，实际 ${p}`);
  });
});

// ══════════════════════════════════════════════════════════
// 9. Gacha
// ══════════════════════════════════════════════════════════

describe('GachaPity · 抽卡保底', () => {
  /**
   * 【baseRate 是概率不是权重】
   * 原神式：五星 0.6%、四星 5.1%、其余三星
   */
  const RARITIES: readonly RarityConfig[] = [
    { id: 'r5', baseRate: 0.006, softPity: 74, hardPity: 90, rampPerPull: 0.06, tier: 2 },
    { id: 'r4', baseRate: 0.051, hardPity: 10, tier: 1 },
    { id: 'r3', baseRate: 0.943, tier: 0 },
  ];

  const ITEMS: readonly GachaItem[] = [
    { id: 'a', rarity: 'r5', weight: 1 },
    { id: 'b', rarity: 'r4', weight: 1 },
    { id: 'c', rarity: 'r3', weight: 1 },
  ];

  function make(seed = 1) {
    return new GachaPity({ items: ITEMS, rarities: RARITIES, rng: new RNG(seed) });
  }

  test('单次抽取返回稀有度', () => {
    const g = make();
    const r = g.pull();
    assert(['r3', 'r4', 'r5'].includes(r.rarity), `稀有度应合法，实际 ${r.rarity}`);
    assert(typeof r.item.id === 'string' && r.item.id.length > 0, '应返回具体物品');
    eq(r.item.rarity, r.rarity, '物品稀有度应与结果一致');
  });

  test('⚠️ 硬保底：连续 89 次不出五星，第 90 次必出', () => {
    // 用一个"永远抽不到 r5"的 rng（next 恒返回 0.999）
    const g = new GachaPity({
      items: ITEMS,
      rarities: RARITIES,
      rng: { next: () => 0.9999 },
    });
    let gotAt = -1;
    for (let i = 1; i <= 200; i++) {
      const r = g.pull();
      if (r.rarity === 'r5') { gotAt = i; break; }
    }
    eq(gotAt, 90, `应在第 90 抽触发硬保底，实际 ${gotAt}`);
  });

  test('⚠️ 出货后保底计数重置', () => {
    const g = new GachaPity({
      items: ITEMS,
      rarities: RARITIES,
      rng: { next: () => 0.9999 },
    });
    for (let i = 0; i < 90; i++) g.pull();    // 第 90 抽必出 r5
    eq(g.pityCount('r5'), 0, '出货后计数应清零');
    eq(g.toHardPity('r5'), 90, '距离下次保底应回到 90');
  });

  test('⚠️ 保底计数是"跨抽累计"的（和 PRD 的关键区别）', () => {
    const g = new GachaPity({
      items: ITEMS,
      rarities: RARITIES,
      rng: { next: () => 0.9999 },
    });
    g.pull(); g.pull(); g.pull();
    eq(g.pityCount('r5'), 3, '应累计，而不是每抽重置');
  });

  test('软保底：概率随计数上升', () => {
    const g = new GachaPity({
      items: ITEMS,
      rarities: [{ id: 'r5', baseRate: 0.006, softPity: 70, hardPity: 90, rampPerPull: 0.06 }, ...RARITIES.slice(1)],
      rng: new RNG(1),
    });
    const early = g.currentRate('r5');
    // 推进到软保底区间
    for (let i = 0; i < 75; i++) g.pull();
    const late = g.toHardPity('r5') === null ? 1 : g.currentRate('r5');
    assert(late >= early, `软保底后概率应不降低：${early} → ${late}`);
  });

  test('pullTen 返回 10 个', () => {
    const g = make();
    eq(g.pullTen().length, 10);
  });

  test('pullN 返回 N 个', () => {
    const g = make();
    eq(g.pullN(50).length, 50);
  });

  test('⚠️ 快照与恢复（计数要保留）', () => {
    const g = new GachaPity({
      items: ITEMS,
      rarities: RARITIES,
      rng: { next: () => 0.9999 },
    });
    for (let i = 0; i < 30; i++) g.pull();
    const snap = g.snapshot();
    eq(g.pityCount('r5'), 30);

    const g2 = new GachaPity({ items: ITEMS, rarities: RARITIES, rng: { next: () => 0.9999 } });
    g2.restore(snap);
    eq(g2.pityCount('r5'), 30, '恢复后计数应保留');
  });

  test('restore(null) 安全', () => {
    const g = make();
    g.restore(null);
    eq(g.pityCount('r5'), 0);
  });

  test('reset 清零', () => {
    const g = new GachaPity({
      items: ITEMS,
      rarities: RARITIES,
      rng: { next: () => 0.9999 },
    });
    for (let i = 0; i < 20; i++) g.pull();
    g.reset();
    eq(g.pityCount('r5'), 0);
  });

  test('⚠️ 统计：五星出货率符合预期', () => {
    const report = simulate({ items: ITEMS, rarities: RARITIES, rng: new RNG(42) }, 100000);
    // 基础 0.6%，加上保底提升，实际约 1.0~1.6%
    const rate5 = report.rates['r5'];
    assert(rate5 > 0.005 && rate5 < 0.025, `五星率应在合理区间，实际 ${(rate5 * 100).toFixed(2)}%`);
  });

  test('⚠️ 统计：无人超过硬保底（关键承诺）', () => {
    const report = simulate({ items: ITEMS, rarities: RARITIES, rng: new RNG(7) }, 20000);
    assert(
      report.worstDry['r5'] <= 90,
      `五星最长连续未出货 ${report.worstDry['r5']} 不应超过 90`,
    );
    assert(
      report.worstDry['r4'] <= 10,
      `四星最长连续未出货 ${report.worstDry['r4']} 不应超过 10`,
    );
  });

  test('⚠️ 未配置的稀有度不会出现在结果里', () => {
    const g = new GachaPity({
      items: [{ id: 'x', rarity: 'r3', weight: 1 }],
      rarities: [{ id: 'r3', baseRate: 1 }],
      rng: new RNG(1),
    });
    for (let i = 0; i < 50; i++) {
      eq(g.pull().rarity, 'r3');
    }
    eq(g.toHardPity('r3'), null, '没有硬保底应返回 null');
  });
});

// ══════════════════════════════════════════════════════════
// 10. Scoring
// ══════════════════════════════════════════════════════════

describe('ScoringSystem · 评分评级', () => {
  const TIME: MetricDef = {
    id: 'time', direction: 'lower-better', par: 60, zero: 180, weight: 1,
  };
  const COMBO: MetricDef = {
    id: 'combo', direction: 'higher-better', par: 30, zero: 0, weight: 1,
  };

  test('⚠️ lower-better：越快分越高（方向不能反）', () => {
    near(normalize(TIME, 60), 1, 1e-9, '达到 par 应满分');
    near(normalize(TIME, 180), 0, 1e-9, '达到 zero 应零分');
    const fast = normalize(TIME, 90);
    const slow = normalize(TIME, 150);
    assert(fast > slow, `快的应得分高：${fast} vs ${slow}`);
  });

  test('⚠️ lower-better：超过 par 仍是满分（不是超过就掉分）', () => {
    near(normalize(TIME, 30), 1, 1e-9, '比 par 更快应仍是满分');
    near(normalize(TIME, 0), 1, 1e-9);
  });

  test('higher-better：越高分越高', () => {
    near(normalize(COMBO, 30), 1, 1e-9);
    near(normalize(COMBO, 0), 0, 1e-9);
    near(normalize(COMBO, 15), 0.5, 1e-9);
    near(normalize(COMBO, 60), 1, 1e-9, '超过 par 应仍是满分');
  });

  test('⚠️ par/zero 写反会在构造时抛错', () => {
    throws(
      () => new ScoringSystem({
        metrics: [{ id: 't', direction: 'lower-better', par: 60, zero: 30 }],
      }),
      '方向写反',
      'lower-better 要求 zero > par',
    );
    throws(
      () => new ScoringSystem({
        metrics: [{ id: 'c', direction: 'higher-better', par: 10, zero: 50 }],
      }),
      '方向写反',
      'higher-better 要求 par > zero',
    );
  });

  test('⚠️ 权重为 NaN / Infinity 时构造期抛错（不是静默按 1 处理）', () => {
    // 【为什么补这条】
    // 原校验 `(d.weight ?? 1) < 0` 看起来在校验权重，
    // 实际上 `NaN < 0` 和 `Infinity < 0` 都是 false，两个坏值全部放行。
    //
    // 放行后运行期有 `numOr(def.weight, 1)` 兜底，会把 NaN 静默改成 1。
    // 于是 `weight: total / count`（count 为 0 → NaN）这种写法：
    // 构造不报错、运行不报错、总分看起来正常，
    // 但**权重结构已经不对了**——静默改配置比报错难查得多。
    const mk = (weight: number) =>
      () => new ScoringSystem({
        metrics: [{ id: 'k', direction: 'higher-better', par: 10, zero: 0, weight }],
      });

    throws(mk(NaN), '非负有限数', 'NaN 权重应在构造期抛错');
    throws(mk(Infinity), '非负有限数', 'Infinity 权重应在构造期抛错');
    throws(mk(-Infinity), '非负有限数', '-Infinity 权重应在构造期抛错');
    throws(mk(-1), '非负有限数', '负权重应在构造期抛错（原有行为，保持不变）');
  });

  test('权重未填 / 正常值不受影响（防止矫枉过正）', () => {
    // 未填是合法用法（默认 1），不能被上面的校验误伤
    const s1 = new ScoringSystem({
      metrics: [{ id: 'k', direction: 'higher-better', par: 10, zero: 0 }],
    });
    near(s1.evaluate([{ id: 'k', value: 5 }]).total, 50, 1e-9, '未填权重默认 1');

    const s2 = new ScoringSystem({
      metrics: [
        { id: 'k', direction: 'higher-better', par: 10, zero: 0, weight: 3 },
        { id: 'a', direction: 'higher-better', par: 10, zero: 0, weight: 1 },
      ],
    });
    // k=满分(1)×3 + a=0分(0)×1 = 3，总权重 4 → 75
    near(
      s2.evaluate([{ id: 'k', value: 10 }, { id: 'a', value: 0 }]).total,
      75,
      1e-9,
      '权重 3:1 且 k 满分 a 零分时，总分应为 75',
    );
  });

  test('曲线：ease-out 让接近满分更难', () => {
    const def: MetricDef = { id: 't', direction: 'higher-better', par: 100, zero: 0, curve: 'ease-out' };
    near(normalize(def, 50), 0.75, 1e-9, 'ease-out 中点应是 0.75 而不是 0.5');
  });

  test('曲线：ease-in 让起步更难', () => {
    const def: MetricDef = { id: 't', direction: 'higher-better', par: 100, zero: 0, curve: 'ease-in' };
    near(normalize(def, 50), 0.25, 1e-9);
  });

  test('总分与评级', () => {
    const s = new ScoringSystem({ metrics: [TIME, COMBO] });
    const perfect = s.evaluate([{ id: 'time', value: 30 }, { id: 'combo', value: 50 }]);
    near(perfect.total, 100, 1e-6, '全部满分应为 100');
    eq(perfect.grade, 'S');

    const worst = s.evaluate([{ id: 'time', value: 300 }, { id: 'combo', value: 0 }]);
    near(worst.total, 0, 1e-6);
    eq(worst.grade, 'D');
  });

  test('权重生效', () => {
    const s = new ScoringSystem({
      metrics: [
        { id: 'a', direction: 'higher-better', par: 100, zero: 0, weight: 9 },
        { id: 'b', direction: 'higher-better', par: 100, zero: 0, weight: 1 },
      ],
    });
    // a 满分、b 零分 → 90 分
    const r = s.evaluate([{ id: 'a', value: 100 }, { id: 'b', value: 0 }]);
    near(r.total, 90, 1e-6);
  });

  test('⚠️ missingAs=skip：缺项不扣分（按实际权重归一化）', () => {
    const s = new ScoringSystem({ metrics: [TIME, COMBO], missingAs: 'skip' });
    // 只提供 time 且满分 → 总分应仍是 100，而不是 50
    const r = s.evaluate([{ id: 'time', value: 30 }]);
    near(r.total, 100, 1e-6, '缺项不应拉低总分');
  });

  test('missingAs=zero：缺项记零分', () => {
    const s = new ScoringSystem({ metrics: [TIME, COMBO], missingAs: 'zero' });
    const r = s.evaluate([{ id: 'time', value: 30 }]);
    near(r.total, 50, 1e-6, '缺项应记 0 分');
  });

  test('gapToPerfect 计算差距', () => {
    eq(gapToPerfect(TIME, 90), 30, 'lower-better：还差 30 秒');
    eq(gapToPerfect(TIME, 30), 0, '已达满分');
    eq(gapToPerfect(COMBO, 12), 18, 'higher-better：还差 18 连击');
    eq(gapToPerfect(COMBO, 40), 0);
  });

  test('gradeOf 阈值', () => {
    eq(gradeOf(95), 'S');
    eq(gradeOf(90), 'S', '等于阈值应算达标');
    eq(gradeOf(89.9), 'A');
    eq(gradeOf(75), 'A');
    eq(gradeOf(60), 'B');
    eq(gradeOf(40), 'C');
    eq(gradeOf(39), 'D');
  });

  test('⚠️ toNextGrade：已是 S 返回 0', () => {
    eq(toNextGrade(100), 0);
    eq(toNextGrade(90), 0, '刚好 S 应返回 0');
    near(toNextGrade(80), DEFAULT_THRESHOLDS.S - 80, 1e-9, 'A→S 还差 10 分');
    near(toNextGrade(50), DEFAULT_THRESHOLDS.B - 50, 1e-9, 'C→B 还差 10 分');
    near(toNextGrade(10), DEFAULT_THRESHOLDS.C - 10, 1e-9, 'D→C 还差 30 分');
  });

  test('weakPoints 找出短板', () => {
    const s = new ScoringSystem({ metrics: [TIME, COMBO] });
    const weak = s.weakPoints([{ id: 'time', value: 175 }, { id: 'combo', value: 29 }]);
    eq(weak[0].id, 'time', '时间应是最短板（几乎零分）');
  });

  test('重复 id 抛错', () => {
    throws(
      () => new ScoringSystem({
        metrics: [
          { id: 'x', direction: 'higher-better', par: 1, zero: 0 },
          { id: 'x', direction: 'higher-better', par: 1, zero: 0 },
        ],
      }),
      '重复',
    );
  });

  test('负权重抛错', () => {
    throws(
      () => new ScoringSystem({
        metrics: [{ id: 'x', direction: 'higher-better', par: 1, zero: 0, weight: -1 }],
      }),
      '权重',
    );
  });

  test('distribution 统计', () => {
    const s = new ScoringSystem({ metrics: [TIME] });
    const d = s.distribution([95, 80, 65, 45, 20]);
    eq(d.S, 1);
    eq(d.A, 1);
    eq(d.B, 1);
    eq(d.C, 1);
    eq(d.D, 1);
    near(d.avg, 61, 1e-6);
  });

  test('✅ 预设 CombatMetrics 可用', () => {
    const s = new ScoringSystem({ metrics: CombatMetrics });
    // 完美通关
    eq(s.grade([
      { id: 'time', value: 40 },
      { id: 'damageTaken', value: 0 },
      { id: 'maxCombo', value: 40 },
      { id: 'kills', value: 50 },
    ]), 'S');
    // 糟糕通关
    eq(s.grade([
      { id: 'time', value: 200 },
      { id: 'damageTaken', value: 400 },
      { id: 'maxCombo', value: 2 },
      { id: 'kills', value: 5 },
    ]), 'D');
  });

  test('⚠️ 受伤权重的体现：无伤 > 高输出但挨打', () => {
    const s = new ScoringSystem({ metrics: CombatMetrics });
    const clean = s.score([
      { id: 'time', value: 90 },
      { id: 'damageTaken', value: 0 },
      { id: 'maxCombo', value: 10 },
      { id: 'kills', value: 40 },
    ]);
    const reckless = s.score([
      { id: 'time', value: 60 },
      { id: 'damageTaken', value: 250 },
      { id: 'maxCombo', value: 30 },
      { id: 'kills', value: 40 },
    ]);
    assert(clean > reckless, `无伤打法应得分更高：${clean.toFixed(1)} vs ${reckless.toFixed(1)}`);
  });
});

// ══════════════════════════════════════════════════════════
// 批量自检
// ══════════════════════════════════════════════════════════

describe('批量自检 · 上线前必跑', () => {
  test('⚠️ AttackToken：模拟 200 场战斗，令牌永不泄漏', () => {
    let leaks = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rng = new RNG(seed);
      const t = new AttackTokenSystem({ maxConcurrent: 3, maxQueued: 50, holdTimeout: 5 });
      const alive = new Set<number>();
      for (let id = 0; id < 20; id++) alive.add(id);

      for (let frame = 0; frame < 600; frame++) {
        // 随机请求
        for (const id of alive) {
          if (rng.chance(0.02)) t.request(id, rng.range(0, 10));
        }
        // 随机归还 / 死亡
        for (const id of [...alive]) {
          if (t.hasToken(id) && rng.chance(0.05)) t.release(id, 'finished');
          if (rng.chance(0.002)) {
            alive.delete(id);
            t.remove(id);
            if (!t.hasToken(id)) { /* ok */ }
          }
        }
        t.tick(1 / 60);
        if (t.activeCount > 3) { leaks++; break; }
      }
      // 结束后：所有还活着的实体归还，令牌应能全部收回
      for (const id of alive) t.release(id);
      if (t.activeCount !== 0) leaks++;
    }
    eq(leaks, 0, '200 场模拟不应出现令牌泄漏');
  });

  test('⚠️ Perception：100 个随机场景，感知状态始终自洽', () => {
    let bad = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const rng = new RNG(seed);
      const s = new PerceptionSystem({ los: OpenLineOfSight, jitter: 0 });
      for (let i = 0; i < 5; i++) {
        s.addPerceiver(i, PerceptionPresets.humanoid, rng.range(-20, 20), rng.range(-20, 20), rng.range(0, 6.28));
      }
      s.addTarget(999, rng.range(-15, 15), rng.range(-15, 15));

      for (let f = 0; f < 300; f++) {
        if (rng.chance(0.02)) s.emitSound(999, rng.range(-20, 20), rng.range(-20, 20), rng.next(), 15);
        s.tick(1 / 60);
        for (let i = 0; i < 5; i++) {
          const st = s.stateOf(i)!;
          // 不变量 1：警觉度必须在 [0, 1]
          if (!(st.alert >= 0 && st.alert <= 1)) { bad++; break; }
          // 不变量 2：记忆剩余不能为负
          if (st.memoryLeft < 0) { bad++; break; }
          /**
           * 不变量 3：处于"已发现"状态时必须有有效记忆
           *
           * 【注意】这里不能写"aware ⇒ alert === 1"。
           * 记忆期内敌人一直 aware（它在搜索你），
           * 而 alert 会随时间衰减——这是**正确的**设计：
           * 确定性在下降，但搜索行为仍在继续。
           * 写成 alert === 1 会把正确行为判为错误。
           */
          if (st.aware && st.memoryLeft <= 0) { bad++; break; }
          // 不变量 4：没有被发现时，警觉度不该停在满值
          if (!st.aware && st.memoryLeft <= 0 && st.alert >= 1) { bad++; break; }
        }
      }
    }
    eq(bad, 0, '感知状态不应出现自相矛盾');
  });

  test('⚠️ Gacha：10 万抽，保底承诺 100% 兑现', () => {
    const report = simulate({
      items: [
        { id: 'a', rarity: 'r5', weight: 1 },
        { id: 'b', rarity: 'r4', weight: 1 },
        { id: 'c', rarity: 'r3', weight: 1 },
      ],
      rarities: [
        { id: 'r5', baseRate: 0.006, softPity: 74, hardPity: 90, rampPerPull: 0.06, tier: 2 },
        { id: 'r4', baseRate: 0.051, hardPity: 10, tier: 1 },
        { id: 'r3', baseRate: 0.943, tier: 0 },
      ],
      rng: new RNG(2024),
    }, 100000);
    assert(report.worstDry['r5'] <= 90, `五星间隔不得超过 90，实际 ${report.worstDry['r5']}`);
    assert(report.worstDry['r4'] <= 10, `四星间隔不得超过 10，实际 ${report.worstDry['r4']}`);
    assert((report.counts['r3'] ?? 0) > 0, '应有三星产出');
    // 平均出货抽数应明显小于硬保底（软保底在起作用）
    assert(report.avgPity['r5'] < 90, `五星平均出货 ${report.avgPity['r5'].toFixed(1)} 抽应小于 90`);
  });

  test('⚠️ Scoring：归一化结果恒在 [0,1]（含极端输入）', () => {
    const defs: MetricDef[] = [
      { id: 'low', direction: 'lower-better', par: 50, zero: 100, weight: 1 },
      { id: 'high', direction: 'higher-better', par: 50, zero: 0, weight: 1 },
    ];
    const s = new ScoringSystem({ metrics: defs });
    const extremes = [-1e9, -1, 0, 25, 50, 75, 100, 1e9, NaN];
    let bad = 0;
    for (const v of extremes) {
      const r = s.evaluate([{ id: 'low', value: v }, { id: 'high', value: v }]);
      if (r.total < 0 || r.total > 100) bad++;
      for (const m of r.metrics) {
        if (m.normalized < 0 || m.normalized > 1) bad++;
      }
    }
    eq(bad, 0, '总分与归一化值应始终在合法区间');
  });

  test('⚠️ Objective：50 个随机关卡，不出现循环依赖导致的死锁', () => {
    let deadlocks = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const rng = new RNG(seed);
      const n = 3 + rng.int(5);
      const defs: ObjectiveDef[] = [];
      for (let i = 0; i < n; i++) {
        // 只允许依赖更早的目标 → 天然无环
        const req: string[] = [];
        if (i > 0 && rng.chance(0.5)) req.push(`o${rng.int(i)}`);
        defs.push(Objectives.after(Objectives.kill(`o${i}`, 1 + rng.int(5)), req));
      }
      const o = new ObjectiveSystem({ objectives: defs });
      // 依次完成
      let guard = 0;
      while (!o.finished && guard++ < 100) {
        for (const st of o.active()) o.setProgress(st.def.id, st.def.target);
        o.tick(0.1);
      }
      if (!o.finished) deadlocks++;
    }
    eq(deadlocks, 0, '无环的关卡应总能完成');
  });
});
}
