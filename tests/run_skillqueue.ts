/**
 * skill-queue 测试（29 项）
 *
 * 【测试重点】
 * 这个模块最容易错的地方**不抛异常**，只表现为"手感发黏"：
 *   ① 输入被吃掉（consume 之后才 tryCast）
 *   ② 永久失败被当成暂时失败，队列一直占着
 *   ③ 延迟释放用了按下时的位置，技能在原地放出来
 *   ④ 窗口配短了，输入时灵时不灵
 *   ⑤ 一次 tick 放了多个技能
 *
 * 【为什么用真实 SkillCaster 而不是 mock】
 * 教训：mock 比真实实现宽松时，你测的就不是你的代码。
 * 这里全部用真实 SkillCaster，只注入必要的假资源。
 */

import { describe, test, assert, eq, near } from './_framework';
import { SkillQueue, defaultRetryable, suggestWindow, type IQueuedCaster } from '../skill-queue/SkillQueue';
import { SkillCaster, type CastContext, type SkillDef } from '../skill-caster/SkillCaster';

const DT = 1 / 60;

/** 造一个纯 CD 技能（无资源、无距离限制） */
function cdSkill(id: string, cooldown: number): SkillDef {
  return { id, cooldown, windup: 0, recover: 0, mask: 1 } as SkillDef;
}

/** 会记录释放次数的 caster 包装 */
function makeRig(cooldown = 1.0) {
  const caster = new SkillCaster();
  caster.learn(cdSkill('fire', cooldown));
  let casts = 0;
  const wrapped: IQueuedCaster = {
    get busy() {
      return caster.busy;
    },
    tryCast(id, ctx) {
      const r = caster.tryCast(id, ctx);
      if (r.ok) casts++;
      return r;
    },
    cooldownLeft(id) {
      return caster.cooldownLeft(id);
    },
  };
  return { caster, wrapped, casts: () => casts };
}

export function runSkillQueueTests(): void {
  // ============================================================
  describe('SkillQueue · 核心场景（提前点击 → 自动补发）', () => {
    test('CD 剩 0.1s 时点击，CD 结束后自动释放', () => {
      const rig = makeRig(1.0);
      const q = new SkillQueue(rig.wrapped, { window: 0.25 });
      const ctx: CastContext = { x: 0, y: 0, facingDeg: 0 };

      rig.caster.tryCast('fire', ctx); // t=0 第一次，进入 CD 1.0s
      const before = rig.casts();

      // 推进到 CD 剩约 0.1s
      for (let i = 0; i < 54; i++) {
        rig.caster.tick(DT);
        q.tick(DT);
      }
      assert(Math.abs(rig.caster.cooldownLeft('fire') - 0.1) < 0.02, 'CD 应剩约 0.1s');

      q.request('fire', ctx); // 提前点击
      eq(rig.casts(), before, '点击瞬间不该释放（CD 未到）');
      eq(q.count, 1, '应该有一个请求在排队');

      // 再推进 0.2s
      for (let i = 0; i < 12; i++) {
        rig.caster.tick(DT);
        q.tick(DT);
      }
      eq(rig.casts(), before + 1, 'CD 结束后应自动补发');
      eq(q.count, 0, '补发后队列应清空');
    });

    test('⚠️ 用「按下时的位置」会导致技能在原地放出来', () => {
      /**
       * 【为什么必须测】
       * 请求排队 0.15s 后释放，这期间玩家移动了 5 米。
       * 如果 ctx 是按下时的快照，技能会在 5 米外放出来。
       *
       * 这个 bug 不报错，只表现为"技能偶尔打空"，极难定位。
       */
      const rig = makeRig(1.0);
      let castAtX = -1;
      const q = new SkillQueue(rig.wrapped, {
        window: 0.25,
        // ⚠️ 施法瞬时结束，事后读 caster.current 是 null，必须在回调里捕获
        onCast: (_id, ctx) => {
          castAtX = ctx.x;
        },
      });

      let playerX = 0;
      const live = (): CastContext => ({ x: playerX, y: 0, facingDeg: 0 });

      rig.wrapped.tryCast('fire', live());
      for (let i = 0; i < 54; i++) {
        rig.caster.tick(DT);
        q.tick(DT);
      }

      // 玩家一边等 CD 一边移动
      q.request('fire', live);
      for (let i = 0; i < 12; i++) {
        playerX += 0.4; // 0.2s 移动约 4.8 米
        rig.caster.tick(DT);
        q.tick(DT);
      }

      assert(castAtX >= 0, '应该已经释放');
      // CD 剩 0.1s ≈ 6 帧后归零即释放，此时玩家已移动约 2.4 米。
      // 重点是「不是 0」——按下时的位置是 0，用快照就会是 0。
      assert(
        castAtX > 2,
        `延迟求值应取释放时的位置（按下时是 0），实际 ${castAtX.toFixed(2)}`,
      );
    });

    test('传快照则确实用快照（不做意外转换）', () => {
      const rig = makeRig(1.0);
      let castAtX = -1;
      const q = new SkillQueue(rig.wrapped, {
        window: 0.25,
        onCast: (_id, ctx) => {
          castAtX = ctx.x;
        },
      });
      const snapshot: CastContext = { x: 7, y: 0, facingDeg: 0 };
      rig.wrapped.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 54; i++) {
        rig.caster.tick(DT);
        q.tick(DT);
      }
      q.request('fire', snapshot);
      for (let i = 0; i < 12; i++) {
        rig.caster.tick(DT);
        q.tick(DT);
      }
      near(castAtX, 7, 1e-6, '快照原样使用');
    });
  });

  // ============================================================
  describe('SkillQueue · 失败分类（暂时 vs 永久）', () => {
    test('defaultRetryable 的分类', () => {
      eq(defaultRetryable('cooldown'), true, 'CD 会自己好');
      eq(defaultRetryable('busy'), true, '正在施法会结束');
      eq(defaultRetryable('out-of-range'), true, '玩家可能在移动');
      eq(defaultRetryable('too-close'), true, '同上');
      eq(defaultRetryable('resource'), false, '蓝不会自己涨回来');
      eq(defaultRetryable('unknown-skill'), false, '永远不会成功');
      eq(defaultRetryable('invalid'), false, '参数错误');
    });

    test('⚠️ 资源不足时立刻丢弃，不占着队列', () => {
      const caster = new SkillCaster({
        resources: {
          canAfford: () => false,
          pay: () => {},
        },
      });
      caster.learn({ id: 'ult', cooldown: 2, cost: { mp: 50 }, windup: 0, recover: 0, mask: 1 } as SkillDef);

      const rejected: string[] = [];
      const q = new SkillQueue(caster, { onReject: (id, r) => rejected.push(`${id}:${r}`) });
      q.request('ult', { x: 0, y: 0, facingDeg: 0 });
      q.tick(DT);

      eq(q.count, 0, '永久失败应立刻出队');
      eq(rejected.join(','), 'ult:failed', '应报告 failed');
    });

    test('⚠️ CD 未到时请求要留着（不能丢）', () => {
      const rig = makeRig(1.0);
      const rejected: string[] = [];
      const q = new SkillQueue(rig.wrapped, { window: 0.25, onReject: (_id, r) => rejected.push(r) });
      rig.caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });

      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      q.tick(DT);

      eq(q.count, 1, 'CD 失败应保留');
      eq(rejected.length, 0, '不该报告失败');
    });

    test('未知技能立刻丢弃', () => {
      const rig = makeRig(0.5);
      const rejected: string[] = [];
      const q = new SkillQueue(rig.wrapped, { onReject: (_id, r, d) => rejected.push(`${r}/${d}`) });
      q.request('nope', { x: 0, y: 0, facingDeg: 0 });
      q.tick(DT);
      eq(rejected.join(','), 'failed/unknown-skill', '应带明细原因');
    });
  });

  // ============================================================
  describe('SkillQueue · 窗口与过期', () => {
    test('超过窗口的请求被丢弃', () => {
      const rig = makeRig(2.0); // 长 CD，窗口内放不出去
      const expired: string[] = [];
      const q = new SkillQueue(rig.wrapped, { window: 0.2, onReject: (_id, r) => expired.push(r) });
      rig.caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });

      for (let i = 0; i < 30; i++) q.tick(DT); // 0.5s > 0.2s
      eq(q.count, 0, '应过期');
      eq(expired.join(','), 'expired', '应报告 expired');
    });

    test('⚠️ 窗口"差一点点"要能检测出来（nearMiss）', () => {
      /**
       * 【为什么必须测】
       * 窗口 0.10、CD 剩 0.11 —— 请求在 CD 归零前 0.01 秒被丢掉。
       * 玩家会感觉"偶尔按了没反应"，而代码没有任何异常。
       *
       * 这是配置问题（窗口配短了），必须显式暴露。
       */
      /**
       * 构造：CD 0.05s（很快就绪），后摇 0.15s（busy 很久），窗口 0.08s。
       * CD 在 t=0.05 就好，但后摇要到 t=0.15 才结束；
       * 窗口 0.08 在 t≈0.083 就把它丢掉 —— 只差一步。
       */
      const caster = new SkillCaster();
      caster.learn({ id: 'fire', cooldown: 0.05, recover: 0.15, windup: 0, mask: 1 } as SkillDef);
      const near: string[] = [];
      const q = new SkillQueue(caster, {
        window: 0.08,
        onNearMiss: (id, w) => near.push(`${id}@${w.toFixed(3)}`),
        onReject: () => {},
      });
      caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });

      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 20; i++) {
        caster.tick(DT);
        q.tick(DT);
      }

      assert(near.length > 0, `窗口差一点应被检测到，实际 ${near.length} 次`);
      eq(q.stats.nearMiss, near.length, '统计应一致');
    });

    test('窗口够用时不会误报 nearMiss', () => {
      const rig = makeRig(0.2);
      const near: string[] = [];
      const q = new SkillQueue(rig.wrapped, {
        window: 0.3,
        onNearMiss: (id) => near.push(id),
      });
      rig.caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 30; i++) {
        rig.caster.tick(DT);
        q.tick(DT);
      }
      eq(near.length, 0, '窗口够用不该报 nearMiss');
      eq(q.stats.cast, 1, '应该成功补发');
    });

    test('suggestWindow 给 2 倍余量', () => {
      eq(suggestWindow(0.1), 0.2, '0.1 → 0.2');
      eq(suggestWindow(0.15), 0.3, '0.15 → 0.3');
      eq(suggestWindow(0.01), 0.1, '极小值有下限 0.1');
    });

    test('暂停传 dt=0 时请求不会老化', () => {
      const rig = makeRig(1.0);
      const q = new SkillQueue(rig.wrapped, { window: 0.15 });
      rig.caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });

      for (let i = 0; i < 60; i++) q.tick(0);
      eq(q.count, 1, '暂停期间不该过期');
      eq(q.pending[0].waited, 0, '等待时长不该增长');
    });
  });

  // ============================================================
  describe('SkillQueue · 优先级与容量', () => {
    test('⚠️ 同时排队时优先级高的先放', () => {
      const caster = new SkillCaster();
      caster.learn(cdSkill('low', 0));
      caster.learn(cdSkill('high', 0));
      const order: string[] = [];
      const q = new SkillQueue(caster, { capacity: 4, onCast: (id) => order.push(id) });

      // 先让 caster 进入 busy（放一个），这样两个请求都得排队
      caster.tryCast('low', { x: 0, y: 0, facingDeg: 0 });
      q.request('low', { x: 0, y: 0, facingDeg: 0 }, 0);
      q.request('high', { x: 0, y: 0, facingDeg: 0 }, 10);

      for (let i = 0; i < 30; i++) {
        caster.tick(DT);
        q.tick(DT);
      }
      eq(order[0], 'high', '高优先级应先放');
    });

    test('同优先级按先到先得', () => {
      const caster = new SkillCaster();
      caster.learn(cdSkill('a', 0));
      caster.learn(cdSkill('b', 0));
      const order: string[] = [];
      const q = new SkillQueue(caster, { capacity: 4, onCast: (id) => order.push(id) });
      caster.tryCast('a', { x: 0, y: 0, facingDeg: 0 });
      q.request('a', { x: 0, y: 0, facingDeg: 0 });
      q.request('b', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 30; i++) {
        caster.tick(DT);
        q.tick(DT);
      }
      eq(order[0], 'a', '先请求的先放');
    });

    test('同 id 的新请求覆盖旧的（连点不是堆积）', () => {
      const rig = makeRig(1.0);
      const q = new SkillQueue(rig.wrapped, { window: 0.25, capacity: 3 });
      rig.caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      eq(q.count, 1, '连点同一个技能只留一个意图');
    });

    test('replaceSame=false 时堆积', () => {
      const rig = makeRig(1.0);
      const q = new SkillQueue(rig.wrapped, { window: 0.25, capacity: 3, replaceSame: false });
      rig.caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      eq(q.count, 2, '关闭覆盖则可堆积');
    });

    test('队列满时挤掉优先级最低的', () => {
      const rig = makeRig(5.0);
      const crowded: string[] = [];
      const q = new SkillQueue(rig.wrapped, {
        capacity: 2,
        onReject: (id, r) => {
          if (r === 'crowded') crowded.push(id);
        },
      });
      q.request('a', { x: 0, y: 0, facingDeg: 0 }, 1);
      q.request('b', { x: 0, y: 0, facingDeg: 0 }, 5);
      q.request('c', { x: 0, y: 0, facingDeg: 0 }, 10);
      eq(crowded.join(','), 'a', '应挤掉优先级最低的 a');
    });

    test('优先级不够时挤掉自己', () => {
      const rig = makeRig(5.0);
      const crowded: string[] = [];
      const q = new SkillQueue(rig.wrapped, {
        capacity: 1,
        onReject: (id, r) => {
          if (r === 'crowded') crowded.push(id);
        },
      });
      q.request('a', { x: 0, y: 0, facingDeg: 0 }, 5);
      const ok = q.request('b', { x: 0, y: 0, facingDeg: 0 }, 1);
      eq(ok, false, '应返回 false');
      eq(crowded.join(','), 'b', '挤掉的是新来的自己');
      eq(q.has('a'), true, '高优先级保留');
    });
  });

  // ============================================================
  describe('SkillQueue · 一次只放一个', () => {
    test('⚠️ 一次 tick 不能放多个技能', () => {
      /**
       * 【为什么必须测】
       * 若一次 tick 放完队列里所有能放的，
       * 玩家攒下的两次点击会在同一帧全部打出——
       * 伤害瞬间翻倍，且动画完全对不上。
       */
      const caster = new SkillCaster();
      caster.learn(cdSkill('a', 0));
      caster.learn(cdSkill('b', 0));
      let castsThisTick = 0;
      const wrapped: IQueuedCaster = {
        get busy() {
          return caster.busy;
        },
        tryCast(id, ctx) {
          const r = caster.tryCast(id, ctx);
          if (r.ok) castsThisTick++;
          return r;
        },
        cooldownLeft: (id) => caster.cooldownLeft(id),
      };
      const q = new SkillQueue(wrapped, { capacity: 4 });
      q.request('a', { x: 0, y: 0, facingDeg: 0 });
      q.request('b', { x: 0, y: 0, facingDeg: 0 });

      castsThisTick = 0;
      caster.tick(DT);
      q.tick(DT);
      eq(castsThisTick, 1, '一次 tick 最多放 1 个');
    });

    test('busy 期间请求排队不覆盖当前施法', () => {
      const caster = new SkillCaster();
      caster.learn({ id: 'long', cooldown: 0, windup: 0.2, recover: 0, mask: 1 } as SkillDef);
      const q = new SkillQueue(caster, { window: 0.5 });
      caster.tryCast('long', { x: 0, y: 0, facingDeg: 0 });
      assert(caster.busy, '应在施法中');

      q.request('long', { x: 0, y: 0, facingDeg: 0 });
      q.tick(DT);
      eq(q.count, 1, 'busy 时应排队而不是丢掉');
    });
  });

  // ============================================================
  describe('SkillQueue · poll（与 InputBuffer 配合）', () => {
    test('⚠️ poll 只用 peek，成功后才 consume', () => {
      /**
       * 【为什么必须测】
       * 朴素写法 `if (consume) tryCast` 会先清缓冲再尝试，
       * 失败就永久丢失输入。poll 内部固化了正确顺序。
       */
      const rig = makeRig(0.5);
      let consumes = 0;
      const fakeBuf = {
        peek: (a: string) => a === 'fire',
        consume: (a: string) => {
          consumes++;
          return a === 'fire';
        },
      };

      const q = new SkillQueue(rig.wrapped, { window: 0.25 });
      rig.wrapped.tryCast('fire', { x: 0, y: 0, facingDeg: 0 }); // 走 wrapped 才计数

      // 推进到 CD 剩约 0.1s（0.5 - 0.4）
      for (let i = 0; i < 24; i++) {
        rig.caster.tick(DT);
        q.tick(DT);
      }

      q.poll(fakeBuf, { fire: 'fire' }, () => ({ x: 0, y: 0, facingDeg: 0 }));
      eq(consumes, 1, '入队即消费（输入已被接住）');

      for (let i = 0; i < 20; i++) {
        rig.caster.tick(DT);
        q.tick(DT);
      }
      eq(rig.casts(), 2, '应自动补发');
    });

    test('poll 未映射的动作不处理', () => {
      const rig = makeRig(0.5);
      let consumed = 0;
      const fakeBuf = {
        peek: (a: string) => a === 'jump',
        consume: () => {
          consumed++;
          return true;
        },
      };
      const q = new SkillQueue(rig.wrapped);
      q.poll(fakeBuf, { fire: 'fire' }, { x: 0, y: 0, facingDeg: 0 });
      eq(consumed, 0, '未映射的动作不该被消费');
      eq(q.count, 0, '不该入队');
    });
  });

  // ============================================================
  describe('SkillQueue · 清理与统计', () => {
    test('clear(id) 只清指定技能', () => {
      const rig = makeRig(5.0);
      const q = new SkillQueue(rig.wrapped, { capacity: 3 });
      q.request('a', { x: 0, y: 0, facingDeg: 0 });
      q.request('b', { x: 0, y: 0, facingDeg: 0 });
      q.clear('a');
      eq(q.has('a'), false, 'a 被清');
      eq(q.has('b'), true, 'b 保留');
    });

    test('clear() 清空全部', () => {
      const rig = makeRig(5.0);
      const q = new SkillQueue(rig.wrapped, { capacity: 3 });
      q.request('a', { x: 0, y: 0, facingDeg: 0 });
      q.request('b', { x: 0, y: 0, facingDeg: 0 });
      q.clear();
      eq(q.count, 0, '全部清空');
    });

    test('pending 按优先级排序且带 waited', () => {
      const rig = makeRig(5.0);
      const q = new SkillQueue(rig.wrapped, { capacity: 3 });
      // ⚠️ 先让 caster 进 CD，否则 tick 会立刻把请求放出去、pending 为空
      rig.wrapped.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('a', { x: 0, y: 0, facingDeg: 0 }, 1);
      q.request('b', { x: 0, y: 0, facingDeg: 0 }, 9);
      q.tick(0.1);
      const p = q.pending;
      eq(p[0].id, 'b', '高优先级在前');
      near(p[0].waited, 0.1, 1e-6, 'waited 正确');
    });

    test('统计与 describe 可用', () => {
      const rig = makeRig(0.2);
      const q = new SkillQueue(rig.wrapped, { window: 0.3 });
      rig.caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 30; i++) {
        rig.caster.tick(DT);
        q.tick(DT);
      }
      eq(q.stats.requested, 1, '请求数');
      eq(q.stats.cast, 1, '释放数');
      assert(q.stats.maxWaited > 0, '应记录等待时长');
      assert(q.describe().includes('SkillQueue'), 'describe 可用');
    });

    test('外部时间源（接 Scheduler）', () => {
      let t = 0;
      const rig = makeRig(1.0);
      const q = new SkillQueue(rig.wrapped, { window: 0.25, now: () => t });
      rig.caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      eq(q.pending[0].waited, 0, '初始 0');
      t = 0.1;
      q.tick(DT); // dt 被忽略，用外部时钟
      near(q.pending[0]?.waited ?? -1, 0.1, 1e-6, '应用外部时钟');
    });
  });

  // ============================================================
  describe('SkillQueue · 与真实 SkillCaster 的端到端', () => {
    test('完整一局：连点 5 次，CD 1s，窗口 0.25', () => {
      const rig = makeRig(1.0);
      const q = new SkillQueue(rig.wrapped, { window: 0.25 });
      const ctx: CastContext = { x: 0, y: 0, facingDeg: 0 };

      // 模拟玩家乱按：每 0.25s 点一次，共 5 秒
      for (let step = 0; step < 20; step++) {
        q.request('fire', ctx);
        for (let i = 0; i < 15; i++) {
          rig.caster.tick(DT);
          q.tick(DT);
        }
      }
      // 5 秒 / 1 秒 CD ≈ 5~6 次（含第一次）
      assert(
        rig.casts() >= 5 && rig.casts() <= 8,
        `5 秒内应释放 5~8 次，实际 ${rig.casts()}`,
      );
      eq(q.stats.nearMiss, 0, '窗口充足不该有 nearMiss');
    });

    test('⚠️ 排队不会导致技能"回放"（旧意图不该延迟太久放出）', () => {
      const rig = makeRig(1.0);
      const q = new SkillQueue(rig.wrapped, { window: 0.25 });
      rig.caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      q.request('fire', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 20; i++) {
        rig.caster.tick(DT);
        q.tick(DT);
      }
      assert(
        q.stats.maxWaited <= 0.25 + 1e-6,
        `等待时长不应超过窗口，实际 ${q.stats.maxWaited}`,
      );
    });
  });
}
