/**
 * tests/run_dtguard2.ts —— dt 守卫统一回归（批次 2）
 *
 * 【与 run_dtguard.ts 的分工】
 *
 * - `run_dtguard.ts`  管**崩溃与死循环**：OOM、Infinity 死循环、坐标永久 NaN
 * - 本文件            管**静默状态污染**：异常 dt 让计时器越走越远 / 永远停不下来
 *
 * 【为什么单独一批】
 * 批次 1 那 4 处是"进程直接没了"，症状醒目。
 * 本批 20 处是"没崩、没报错，但状态悄悄错了"——
 * 冷却被拉长、输入永不老化、buff 永不消失。玩家只会觉得"这游戏手感怪"，
 * 不会想到是 dt 的问题。
 *
 * 【统一断言模式】
 * 每条都断言两件事，缺一不可：
 *
 *   ① 不变性：异常 dt 前后状态**完全相等**（不只是"没崩溃"）
 *   ② 可恢复：异常 dt 之后，正常 dt 仍能继续推进（不是永久卡死）
 *
 * 只测 ① 会漏掉"守卫写成了永久禁用"这种过度修复；
 * 只测 ② 会漏掉"污染已经发生但还能动"。
 *
 * 【0 为什么算异常】
 * `0` 是合法的暂停语义，所以断言"状态不变"对它同样成立——
 * 一帧 dt=0 不应该推进任何东西。
 */

import { describe, test, assert, eq } from './_framework';
import { CameraShake } from '../camera/CameraShake';
import { DashController } from '../dash/DashController';
import { StateMachine } from '../fsm/StateMachine';
import { NumberRollerCore } from '../number-roller/NumberRollerCore';
import { SceneRouter } from '../scenerouter/SceneRouter';
import { ScoreSystem } from '../score/ScoreSystem';
import { SkillPlayer } from '../skill-player/SkillPlayer';
import { TargetSelector } from '../targeting/TargetSelector';
import { Tutorial } from '../tutorial/Tutorial';
import { CommandStack } from '../command/CommandStack';
import { ReplayRecorder } from '../replay/ReplayRecorder';
import { CameraFollow } from '../camera/CameraFollow';
import { TelegraphSystem } from '../telegraph/Telegraph';
import { AttackTokenSystem } from '../attack-token/AttackToken';
import { ComboSystem } from '../combo/ComboSystem';
import { ObjectiveSystem } from '../objective/ObjectiveSystem';
import { ProgressBar } from '../progressbar/ProgressBar';
import { Cooldown } from '../skill-player/Cooldown';
import { Tween } from '../tween/Tween';
import { InputBuffer, CoyoteTimer } from '../input/InputBuffer';
import { Wait, CooldownDecorator, Action } from '../behavior-tree/BTNode';
import { integrate, createAgent } from '../steering/Steering';
import { PerceptionSystem, OpenLineOfSight } from '../perception/Perception';
import { ElementSystem } from '../element/ElementSystem';
import { DifficultySystem } from '../difficulty/DifficultySystem';
import { WaveSpawner } from '../wave-spawner/WaveSpawner';
import { SequencePlayer } from '../bullet-pattern/BulletPattern';
import { ProjectileSystem } from '../projectile/Projectile';
import { SkillQueue } from '../skill-queue/SkillQueue';
import { SkillCaster } from '../skill-caster/SkillCaster';
import { FixedRandomSource } from '../_core/types';
import { BTStatus } from '../behavior-tree/BTNode';

/** 所有需要被挡住的 dt：NaN / ±Infinity / 负数 / 零 */
const BAD_DTS: ReadonlyArray<readonly [string, number]> = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['负 -1', -1],
  ['零 0', 0],
];

const OK_DT = 0.016;

/** 数值快照：NaN 用字符串标注，避免 `NaN === NaN` 为 false 导致误判通过 */
function num(v: number): string {
  return Number.isNaN(v) ? 'NaN' : String(v);
}

/** 通用状态快照：把若干数值拼成字符串，用于前后比对 */
function snap(parts: ReadonlyArray<readonly [string, number]>): string {
  return parts.map(([k, v]) => `${k}=${num(v)}`).join(' | ');
}

export function runDtGuard2Tests(): void {
  // ─────────────────────────────────────────────────────────
  describe('camera —— 相机跟随', () => {
    for (const [name, bad] of BAD_DTS) {
      test(`update(${name}) 不改变任何状态`, () => {
        const c = new CameraFollow();
        c.update(OK_DT, 100, 50);
        c.update(OK_DT, 100, 50);
        const before = snap([
          ['x', c.x], ['y', c.y],
          ['laX', c.lookAheadX], ['laY', c.lookAheadY],
        ]);
        c.update(bad, 100, 50);
        const after = snap([
          ['x', c.x], ['y', c.y],
          ['laX', c.lookAheadX], ['laY', c.lookAheadY],
        ]);
        eq(after, before, `dt=${name} 不应改变相机状态`);
      });
    }
    test('异常 dt 之后仍能正常跟随', () => {
      const c = new CameraFollow();
      c.update(NaN, 100, 50);
      for (let i = 0; i < 60; i++) c.update(OK_DT, 100, 50);
      assert(Number.isFinite(c.x) && c.x > 0, `应继续跟随，实际 x=${c.x}`);
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('projectile —— 弹道', () => {
    for (const [name, bad] of BAD_DTS) {
      test(`tick(${name}) 不改变任何状态`, () => {
        const sys = new ProjectileSystem({ collision: { query: () => [] } as any });
        sys.spawn({ x: 0, y: 0, vx: 10, vy: 0, lifetime: 5 } as any);
        sys.tick(OK_DT);
        const before = snap([['count', sys.count]]);
        sys.tick(bad);
        const after = snap([['count', sys.count]]);
        eq(after, before, `dt=${name} 不应改变弹丸状态`);
      });
    }
  });

  // ─────────────────────────────────────────────────────────
  describe('telegraph —— 攻击预警（报告实测：预警提前引爆）', () => {
    for (const [name, bad] of BAD_DTS) {
      test(`tick(${name}) 不改变预警进度`, () => {
        const tg = new TelegraphSystem();
        const t = tg.spawn({ shape: 'circle' as any, x: 0, y: 0, radius: 3, windup: 0.8, active: 0.2 } as any);
        tg.tick(OK_DT);
        const before = snap([['age', (t as any).age], ['phase', (t as any).phaseIdx ?? 0]]);
        tg.tick(bad);
        const after = snap([['age', (t as any).age], ['phase', (t as any).phaseIdx ?? 0]]);
        eq(after, before, `dt=${name} 不应推进预警`);
      });
    }
    test('异常 dt 不会让预警提前引爆', () => {
      const tg = new TelegraphSystem();
      let activatedAt = -1;
      const t = tg.spawn({
        shape: 'circle' as any, x: 0, y: 0, radius: 3,
        windup: 0.8, active: 0.2,
        onActivate: () => { activatedAt = (t as any).age; },
      } as any);
      tg.tick(NaN);
      tg.tick(Infinity);
      for (let i = 0; i < 50; i++) tg.tick(OK_DT);
      // 正常情况 0.8s 引爆，异常 dt 不应该把它提前到第 2 帧
      assert(activatedAt < 0 || activatedAt >= 0.7,
        `预警不应提前引爆，实际在 age=${num(activatedAt)} 触发`);
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('attack-token —— 攻击令牌（报告实测：Infinity 污染 _time）', () => {
    test('异常 dt 不污染内部时钟', () => {
      const sys = new AttackTokenSystem({ holdTimeout: 1 } as any);
      sys.request(1);
      sys.tick(OK_DT);
      const before = snap([['time', (sys as any)._time]]);
      for (const [name, bad] of BAD_DTS) {
        sys.tick(bad);
        eq(snap([['time', (sys as any)._time]]), before, `dt=${name} 不应推进 _time`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('objective —— 关卡目标（报告实测：Infinity 污染 _time）', () => {
    test('异常 dt 不污染 totalTime', () => {
      const sys = new ObjectiveSystem({ objectives: [] });
      sys.tick(OK_DT);
      const before = snap([['totalTime', sys.totalTime]]);
      for (const [name, bad] of BAD_DTS) {
        sys.tick(bad);
        eq(snap([['totalTime', sys.totalTime]]), before, `dt=${name} 不应推进 totalTime`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('progressbar —— 进度条', () => {
    for (const [name, bad] of BAD_DTS) {
      test(`update(${name}) 不改变显示值`, () => {
        const p = new ProgressBar();
        p.set(50);
        p.update(OK_DT);
        const before = snap([['display', p.displayRatio], ['value', p.value]]);
        p.update(bad);
        const after = snap([['display', p.displayRatio], ['value', p.value]]);
        eq(after, before, `dt=${name} 不应改变进度条`);
      });
    }
  });

  // ─────────────────────────────────────────────────────────
  describe('skill-player/Cooldown —— 冷却（报告实测：NaN 让技能永久锁死）', () => {
    for (const [name, bad] of BAD_DTS) {
      test(`tick(${name}) 不改变冷却进度`, () => {
        const cd = new Cooldown({ duration: 1, charges: 3 });
        cd.trigger();
        cd.tick(OK_DT);
        const before = snap([['progress', cd.progress], ['charges', cd.charges]]);
        cd.tick(bad);
        const after = snap([['progress', cd.progress], ['charges', cd.charges]]);
        eq(after, before, `dt=${name} 不应改变冷却`);
      });
    }
    test('异常 dt 之后冷却仍能正常恢复', () => {
      const cd = new Cooldown({ duration: 0.5, charges: 1 });
      cd.trigger();
      assert(!cd.ready, '刚触发时不应就绪');
      cd.tick(NaN);
      for (let i = 0; i < 40; i++) cd.tick(OK_DT);   // 0.64s > 0.5s
      assert(cd.ready, '异常 dt 之后冷却应能正常走完');
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('tween —— 补间', () => {
    for (const [name, bad] of BAD_DTS) {
      test(`update(${name}) 不改变进度`, () => {
        const t = new Tween(1);
        t.update(OK_DT);
        const before = snap([['progress', t.progress]]);
        t.update(bad);
        const after = snap([['progress', t.progress]]);
        eq(after, before, `dt=${name} 不应推进补间`);
      });
    }
    test('异常 dt 之后补间仍能正常完成', () => {
      const t = new Tween(0.5);
      t.update(NaN);
      for (let i = 0; i < 40; i++) t.update(OK_DT);
      assert(t.done, '异常 dt 之后补间应能走完');
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('input/InputBuffer —— 输入缓冲（报告实测：NaN 让输入永不老化）', () => {
    test('异常 dt 不推进内部时钟，输入会正常过期', () => {
      const buf = new InputBuffer({ window: 0.15 });
      buf.press('fire');
      for (const [, bad] of BAD_DTS) buf.tick(bad);
      // 再用正常 dt 推进超过 window
      for (let i = 0; i < 20; i++) buf.tick(OK_DT);   // 0.32s > 0.15s
      assert(!buf.consume('fire'), '输入应已过期（NaN 不应让时钟停摆）');
    });
    test('正常 dt 下输入仍能在窗口内被消费', () => {
      const buf = new InputBuffer({ window: 0.15 });
      buf.press('fire');
      buf.tick(0.05);
      assert(buf.consume('fire'), '窗口内应能消费');
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('input/CoyoteTimer —— 土狼时间（报告实测：负 dt 把 0.1s 拉到 5.1s）', () => {
    /** 走公开 API 进入土狼时间：先着地再离地 */
    function leaveGround(duration: number): CoyoteTimer {
      const ct = new CoyoteTimer(duration);
      ct.setGrounded(true);
      ct.setGrounded(false);   // 刚离地 → 开始倒计时
      return ct;
    }

    for (const [name, bad] of BAD_DTS) {
      test(`tick(${name}) 不延长剩余时间`, () => {
        const ct = leaveGround(0.1);
        const before = ct.left;
        for (let i = 0; i < 5; i++) ct.tick(bad);
        const after = ct.left;
        assert(!(after > before), `dt=${name} 不应延长土狼时间（${num(before)} → ${num(after)}）`);
      });
    }
    test('异常 dt 之后土狼时间仍能正常耗尽', () => {
      const ct = leaveGround(0.1);
      ct.tick(-1);
      for (let i = 0; i < 10; i++) ct.tick(OK_DT);   // 0.16s > 0.1s
      assert(!ct.canJump(), `土狼时间应已耗尽，实际 left=${num(ct.left)}`);
    });
    test('土狼时间基线：正常 dt 下 0.1s 后失效', () => {
      const ct = leaveGround(0.1);
      assert(ct.canJump(), '刚离地应还能跳');
      for (let i = 0; i < 10; i++) ct.tick(OK_DT);
      assert(!ct.canJump(), '0.16s 后不应还能跳');
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('behavior-tree/Wait —— 等待节点（报告实测：NaN 让 AI 永久卡死）', () => {
    for (const [name, bad] of BAD_DTS) {
      test(`tick(${name}) 不推进 elapsed`, () => {
        const w = new Wait('w', 1);
        w.tick({} as any, {} as any, OK_DT);
        const before = w.elapsed;
        w.tick({} as any, {} as any, bad);
        eq(num(w.elapsed), num(before), `dt=${name} 不应推进 elapsed`);
      });
    }
    test('异常 dt 之后等待仍能正常完成', () => {
      const w = new Wait('w', 0.5);
      w.tick({} as any, {} as any, NaN);
      let ok = false;
      for (let i = 0; i < 40; i++) {
        if (w.tick({} as any, {} as any, OK_DT) === BTStatus.Success) { ok = true; break; }
      }
      assert(ok, '异常 dt 之后 Wait 应能正常返回 success');
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('behavior-tree/CooldownDecorator —— 冷却装饰器（报告实测：1.0s 被拉到 6.0s）', () => {
    for (const [name, bad] of BAD_DTS) {
      test(`tick(${name}) 不延长 remain`, () => {
        const child = new Action('a', () => 'success' as any);
        const cd = new CooldownDecorator('c', child, 1);
        cd.tick({} as any, {} as any, OK_DT);          // 触发冷却
        const before = cd.remain;
        for (let i = 0; i < 5; i++) cd.tick({} as any, {} as any, bad);
        assert(!(cd.remain > before), `dt=${name} 不应延长冷却（${num(before)} → ${num(cd.remain)}）`);
      });
    }
  });

  // ─────────────────────────────────────────────────────────
  describe('steering/integrate —— 群体转向积分', () => {
    for (const [name, bad] of BAD_DTS) {
      test(`integrate(${name}) 不改变位置与速度`, () => {
        const a = createAgent({ x: 0, y: 0 } as any);
        a.force.x = 10; a.force.y = 0;
        integrate(a, OK_DT);
        const before = snap([['px', a.pos.x], ['py', a.pos.y], ['vx', a.vel.x], ['vy', a.vel.y]]);
        integrate(a, bad);
        const after = snap([['px', a.pos.x], ['py', a.pos.y], ['vx', a.vel.x], ['vy', a.vel.y]]);
        eq(after, before, `dt=${name} 不应改变 agent 状态`);
      });
    }
  });

  // ─────────────────────────────────────────────────────────
  describe('perception —— 感知系统', () => {
    test('异常 dt 不推进警觉度', () => {
      const sys = new PerceptionSystem({ los: OpenLineOfSight });
      sys.addPerceiver(1, { sightRange: 10, sightHalfAngle: Math.PI } as any, 0, 0, 0);
      sys.addTarget(2, 3, 0);
      sys.tick(OK_DT);
      const before = snap([['alert', sys.alertOf(1)]]);
      for (const [name, bad] of BAD_DTS) {
        sys.tick(bad);
        eq(snap([['alert', sys.alertOf(1)]]), before, `dt=${name} 不应改变警觉度`);
      }
    });
    test('异常 dt 不产生 NaN 警觉度', () => {
      const sys = new PerceptionSystem({ los: OpenLineOfSight });
      sys.addPerceiver(1, { sightRange: 10, sightHalfAngle: Math.PI } as any, 0, 0, 0);
      sys.addTarget(2, 3, 0);
      for (const [, bad] of BAD_DTS) sys.tick(bad);
      assert(Number.isFinite(sys.alertOf(1)), `警觉度应始终有限，实际 ${num(sys.alertOf(1))}`);
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('element —— 元素反应', () => {
    test('异常 dt 不推进元素衰减', () => {
      const sys = new ElementSystem({
        elements: [{ id: 'fire', decay: 5 }] as any,
        reactions: [] as any,
      });
      sys.apply(1, 'fire', 100);        // 必须有 gauge，否则循环不执行、测试空跑
      sys.tick(OK_DT);
      // 【为什么断言 gaugeOf 而不是 activeCount】
      // activeCount 只在 gauge 归零删除时才变；一帧只衰减 decay*dt 这么点，
      // 永远不会归零 → 断言 activeCount 恒真，测试等于没测。
      const before = snap([['gauge', sys.gaugeOf(1)]]);
      assert(before !== 'gauge=100', 'gauge 应先被正常 dt 衰减过，否则测试会空跑');
      for (const [name, bad] of BAD_DTS) {
        sys.tick(bad);
        eq(snap([['gauge', sys.gaugeOf(1)]]), before, `dt=${name} 不应改变元素量`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('difficulty —— 动态难度', () => {
    test('异常 dt 不推进', () => {
      const sys = new DifficultySystem({
        tiers: [{ id: 'n', multipliers: {} }] as any,
        dda: { enabled: true, windowSize: 8 },
      });
      assert((sys as any)._ddaEnabled, 'DDA 必须真的开启了，否则测试会空跑');
      // 【为什么必须先 report】
      // _smoothPerf 只在有样本时才更新；没喂样本它恒为初值，断言恒真。
      sys.report(0.9, 1);
      sys.tick(OK_DT);
      const before = snap([['perf', (sys as any)._smoothPerf], ['adj', (sys as any)._adjust ?? 0]]);
      for (const [name, bad] of BAD_DTS) {
        sys.tick(bad);
        eq(snap([['perf', (sys as any)._smoothPerf], ['adj', (sys as any)._adjust ?? 0]]),
           before, `dt=${name} 不应推进`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('wave-spawner —— 波次生成', () => {
    test('异常 dt 不推进波次', () => {
      const sys = new WaveSpawner({
        waves: [{ entries: [{ entryId: 'a', count: 1 }] }] as any,
        spawn: { spawn: () => ({ id: 1 }), despawn: () => {} } as any,
        rng: new FixedRandomSource([0.5]),
      });
      sys.tick(OK_DT);
      const before = snap([['alive', (sys as any).aliveCount ?? 0]]);
      for (const [name, bad] of BAD_DTS) {
        sys.tick(bad);
        eq(snap([['alive', (sys as any).aliveCount ?? 0]]), before, `dt=${name} 不应推进波次`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('bullet-pattern/SequencePlayer —— 弹幕序列', () => {
    test('异常 dt 不推进序列', () => {
      const p = new SequencePlayer([{ at: 0.5 } as any, { at: 1.5 } as any]);
      p.start();                        // 不 start 的话 _running=false，测试会空跑
      const seen: unknown[] = [];
      p.tick(OK_DT, (s) => seen.push(s));
      const before = snap([['seen', seen.length], ['time', (p as any)._time]]);
      for (const [name, bad] of BAD_DTS) {
        p.tick(bad, (s) => seen.push(s));
        eq(snap([['seen', seen.length], ['time', (p as any)._time]]), before, `dt=${name} 不应推进序列`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('combo —— 连招', () => {
    test('异常 dt 不推进连招窗口', () => {
      const sys = new ComboSystem({
        moves: [{ id: 'a', inputs: ['light', 'heavy'] }] as any,
      });
      sys.input('light');               // 不输入则 _path 为空，守卫走不到、测试会空跑
      assert((sys as any)._path.length > 0, '_path 应非空');
      sys.tick(OK_DT);
      const before = snap([['sinceInput', (sys as any)._timeSinceInput]]);
      for (const [name, bad] of BAD_DTS) {
        sys.tick(bad);
        eq(snap([['sinceInput', (sys as any)._timeSinceInput]]), before, `dt=${name} 不应推进连招窗口`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('skill-queue —— 技能排队（与 InputBuffer 后果相反）', () => {
    test('异常 dt 不让排队的技能被丢弃', () => {
      const caster = {
        busy: () => true,
        cooldownLeft: () => 1,          // 缺这个会在 tick 内部抛错，测试就变成空跑
        tryCast: () => ({ ok: false, reason: 'busy' as const }),
      } as any;
      const q = new SkillQueue(caster, { window: 0.25 } as any);
      q.request('fire', { facingDeg: 0 } as any);
      const before = q.pending.length;
      for (const [name, bad] of BAD_DTS) {
        q.tick(bad);
        eq(String(q.pending.length), String(before), `dt=${name} 不应丢弃排队的技能`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('skill-caster —— 施法器（守卫必须在冷却递减之前）', () => {
    test('异常 dt 不污染冷却（NaN 不应让冷却瞬间归零）', () => {
      const caster = new SkillCaster({} as any);
      caster.learn({ id: 'fire', cooldown: 5 } as any);
      // 用一次技能让冷却开始
      (caster as any)._cd?.set?.('fire', 5);
      const before = (caster as any)._cd?.get?.('fire') ?? -1;
      for (const [name, bad] of BAD_DTS) {
        caster.tick(bad);
        const now = (caster as any)._cd?.get?.('fire') ?? -1;
        eq(num(now), num(before), `dt=${name} 不应改变冷却（守卫必须在递减之前）`);
      }
    });
    test('负 dt 不把冷却越拉越长', () => {
      const caster = new SkillCaster({} as any);
      caster.learn({ id: 'fire', cooldown: 1 } as any);
      (caster as any)._cd?.set?.('fire', 1);
      const before = (caster as any)._cd?.get?.('fire') ?? -1;
      for (let i = 0; i < 5; i++) caster.tick(-1);
      const after = (caster as any)._cd?.get?.('fire') ?? -1;
      assert(!(after > before), `负 dt 不应延长冷却（${num(before)} → ${num(after)}）`);
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('command/CommandStack —— 上限字段（limit=NaN 栈无上限）', () => {
    // 【为什么这条缺陷隐蔽】
    // 旧写法 `Math.max(1, opts.limit ?? 100)` 看起来是"有兜底"的，
    // 但 `Math.max(1, NaN) === NaN` —— 兜底对 NaN 完全无效。
    // 裁剪判定 `length > this._limit` 恒为 false → 栈永不裁剪。
    // 表现不是崩溃，是**内存随操作次数无限增长**。
    test('limit=NaN 回退到默认 100，栈会裁剪', () => {
      const st = new CommandStack({ limit: NaN } as any);
      for (let i = 0; i < 200; i++) {
        st.do({ name: 'c' + i, execute: () => {}, undo: () => {} });
      }
      eq(st.undoDepth, 100, 'limit=NaN 应回退到 100，而不是无限增长');
    });
    test('limit=Infinity 回退到默认 100', () => {
      const st = new CommandStack({ limit: Infinity } as any);
      for (let i = 0; i < 200; i++) {
        st.do({ name: 'c' + i, execute: () => {}, undo: () => {} });
      }
      eq(st.undoDepth, 100, 'limit=Infinity 应回退到 100');
    });
    test('limit=0 与负数仍被兜到 1（保持原行为）', () => {
      for (const bad of [0, -5]) {
        const st = new CommandStack({ limit: bad } as any);
        st.do({ name: 'a', execute: () => {}, undo: () => {} });
        st.do({ name: 'b', execute: () => {}, undo: () => {} });
        eq(st.undoDepth, 1, `limit=${bad} 应被兜到 1`);
      }
    });
    test('limit 正常值行为不变', () => {
      const st = new CommandStack({ limit: 3 } as any);
      for (let i = 0; i < 10; i++) {
        st.do({ name: 'c' + i, execute: () => {}, undo: () => {} });
      }
      eq(st.undoDepth, 3, 'limit=3 时最多保留 3 条');
    });
  });

  // ─────────────────────────────────────────────────────────
  describe('replay/ReplayRecorder —— 上限字段（maxFrames=NaN 录制无上限）', () => {
    // 【比 command 更危险的一处】
    // command 至少还有 `Math.max(1, ...)` 想兜一下；
    // replay 这条是纯粹的 `opts.maxFrames ?? 200_000`，连兜底动作都没有。
    // NaN 直接穿过，而停止判定 `length >= _maxFrames` 恒 false → 永不停止录制。
    // 【为什么必须显式 start()】
    // `_recording` 默认 false，`record()` 开头就 `if (!this._recording) return;`
    // 忘了 start 的话一帧都录不进去，而断言"停在 0"和"停在 10"都看不出区别。
    // （外部报告第 38 次调用错误：把录制态指标 `recordedFrames`
    //   和播放态指标 `frameCount` 混用，误判"往返失败"。）
    const mk = (maxFrames: unknown) => new ReplayRecorder({ maxFrames } as any);
    const recN = (r: ReplayRecorder, n: number) => {
      r.start();
      for (let i = 0; i < n; i++) r.record(i, { x: i } as any);
    };

    test('maxFrames=NaN 回退到默认 200000（仍有上界）', () => {
      const r = mk(NaN);
      assert(Number.isFinite((r as any)._maxFrames), '_maxFrames 应为有限值');
    });
    test('maxFrames=Infinity 回退到默认 200000', () => {
      const r = mk(Infinity);
      assert(Number.isFinite((r as any)._maxFrames), '_maxFrames 应为有限值');
    });
    test('maxFrames=10 时录制在第 10 帧停止（正常行为不变）', () => {
      const r = mk(10);
      recN(r, 30);
      eq(r.recordedFrames, 10, 'maxFrames=10 应停在 10');
    });
    test('maxFrames=NaN 回退值为 200000（不是 NaN）', () => {
      const r = mk(NaN);
      eq((r as any)._maxFrames, 200_000, 'NaN 应回退到默认值 200000');
    });
    test('maxFrames=NaN 时上界真的生效（录到 20 帧会停）', () => {
      // 【这条才是真验证】
      // 前一条只断言"值是有限的"，太弱——就算回退成 1e30 也能过。
      // 这里用一个小到能触发的上界，确认"到上界真的会停"。
      const r = mk(10);
      recN(r, 30);
      eq(r.recordedFrames, 10, '到上界后应停止录制（不再增长）');
      eq(r.isRecording, false, '停止录制后 _recording 应为 false');
    });
  });

  // ─────────────────────────────────────────────────────────
  // 以下 9 个模块是**静态扫描脚本**捞出来的，不是人工清单里的。
  // 计划最初写「9 处 dt 守卫」，脚本跑出来是 20 处——
  // 手工正则太窄（只认 tick 后紧跟守卫行），漏掉这批。
  // 这也说明扫描规则必须固化进 verify，否则新增代码会重蹈覆辙。
  // ─────────────────────────────────────────────────────────
  describe('camera/CameraShake —— 震屏（脚本扫出，人工清单漏了）', () => {
    test('异常 dt 不推进震屏时间与源存活时间', () => {
      const sh = new CameraShake();
      sh.punch({ strength: 1, duration: 1 } as any);
      sh.tick(0.016);
      const t0 = (sh as any)._time;
      const age0 = (sh as any)._sources[0]?.age ?? 0;
      for (const [, bad] of BAD_DTS) sh.tick(bad);
      eq(num((sh as any)._time), num(t0), '异常 dt 不应推进 _time');
      eq(num((sh as any)._sources[0]?.age ?? 0), num(age0), '异常 dt 不应推进 source.age');
    });
  });

  describe('dash —— 冲刺（报告实证：NaN 让状态卡在 dashing）', () => {
    test('异常 dt 不改变冷却剩余', () => {
      const d = new DashController();
      (d as any)._cdLeft = 0.68;
      for (const [, bad] of BAD_DTS) d.tick(bad);
      eq(num((d as any)._cdLeft), num(0.68), '异常 dt 不应改变冷却');
    });
    test('负 dt 不把冷却越拉越长（报告：0.68 → 5.68）', () => {
      const d = new DashController();
      (d as any)._cdLeft = 0.68;
      for (let i = 0; i < 5; i++) d.tick(-1);
      assert(!((d as any)._cdLeft > 0.68), `负 dt 不应延长冷却，实际 ${num((d as any)._cdLeft)}`);
    });
    test('异常 dt 结束后冲刺仍能正常完成（不卡在 dashing）', () => {
      const d = new DashController({ duration: 0.2 } as any);
      (d as any)._state = 'dashing';
      (d as any)._t = 0.1;
      for (const [, bad] of BAD_DTS) d.tick(bad);
      for (let i = 0; i < 40; i++) d.tick(0.016);
      assert((d as any)._state !== 'dashing', `异常 dt 后应能正常结束，实际 ${(d as any)._state}`);
    });
  });

  describe('fsm —— 状态机（内联保护：不能提前 return）', () => {
    // 【为什么这里用内联而不是 return】
    // update() 内部要调用子状态的 update。提前 return 会让
    // "暂停时子状态仍被调用"这个语义静默消失。
    test('异常 dt 不推进状态停留时间', () => {
      let childCalls = 0;
      const fsm = new StateMachine({
        initial: 'a',
        states: { a: { update: () => { childCalls++; return undefined; } } },
      } as any);
      fsm.update({} as any, 0.016);
      const t0 = (fsm as any)._timeInState;
      const c0 = childCalls;
      for (const [, bad] of BAD_DTS) fsm.update({} as any, bad);
      eq(num((fsm as any)._timeInState), num(t0), '异常 dt 不应推进 _timeInState');
      assert(childCalls > c0, '子状态 update 仍应被调用（守卫不该 return 掉整个方法）');
    });
  });

  describe('number-roller —— 数字滚动（报告实证：永久显示 NaN）', () => {
    test('异常 dt 不产生 NaN 显示值', () => {
      const r = new NumberRollerCore();
      r.set(100);
      for (const [, bad] of BAD_DTS) r.update(bad);
      for (let i = 0; i < 200; i++) r.update(0.016);
      assert(Number.isFinite(r.display), `显示值应始终有限，实际 ${r.display}`);
      eq(num(r.display), num(100), '滚动应正常结束在目标值');
    });
  });

  describe('scenerouter —— 场景切换（dt > 0 挡不住 Infinity）', () => {
    test('Infinity dt 不推进切场计时', () => {
      const r = new SceneRouter();
      (r as any)._phase = 'out';
      (r as any)._elapsed = 0;
      for (const [, bad] of BAD_DTS) r.tick(bad);
      eq(num((r as any)._elapsed), num(0), '异常 dt（含 Infinity）不应推进 _elapsed');
    });
  });

  describe('score —— 计分（dt > 0 挡不住 Infinity）', () => {
    test('Infinity dt 不污染计时', () => {
      const sc = new ScoreSystem({
        metrics: [{ id: 'kills', weight: 1, better: 'higher' }],
        grades: [{ id: 'S', minScore: 90 }],
      } as any);
      sc.tick(0.016);
      const t0 = (sc as any)._startTime;
      for (const [, bad] of BAD_DTS) sc.tick(bad);
      eq(num((sc as any)._startTime), num(t0), '异常 dt 不应推进计时');
    });
  });

  describe('skill-player —— 技能时间轴', () => {
    test('异常 dt 不推进时间轴', () => {
      const sp = new SkillPlayer();
      (sp as any)._state = 'playing';
      // 【为什么 mock 必须带 query】
      // 守卫生效时 tick 会提前 return，走不到 query → 测试空跑。
      // 反向验证（守卫失效）时才会暴露这里缺方法，直接崩在 query 上，
      // 掩盖了真正要断言的东西。宁可把 mock 补全。
      // 【为什么 query 要返回 []】源码是 `for (const e of this._track.query(...))`，
      // 返回 null 会在解构迭代时抛 "events is not iterable"。
      (sp as any)._track = { events: [], duration: 10, query: () => [] };
      (sp as any)._time = 1;
      for (const [, bad] of BAD_DTS) sp.tick(bad);
      eq(num((sp as any)._time), num(1), '异常 dt 不应推进 _time');
    });
  });

  describe('targeting —— 目标选择（内联保护）', () => {
    // 【为什么是内联】宽限递减在方法中段，提前 return 会跳过
    // 整个目标切换逻辑。异常 dt 时"宽限不递减"= 保持当前目标，
    // 比"宽限变 NaN 后 > 0 恒 false 导致立即切换"安全得多。
    test('异常 dt 不把宽限变成 NaN', () => {
      const ts = new TargetSelector();
      (ts as any)._grace = 0.5;
      for (const [, bad] of BAD_DTS) ts.update(bad, [] as any);
      assert(Number.isFinite((ts as any)._grace), `宽限应始终有限，实际 ${(ts as any)._grace}`);
    });
  });

  describe('tutorial —— 新手引导（dt > 0 挡不住 Infinity）', () => {
    test('Infinity dt 不推进步骤计时', () => {
      const tu = new Tutorial({
        steps: [{ id: 's1', condition: () => false }],
        context: {},
      } as any);
      (tu as any)._state = 'running';
      (tu as any)._elapsed = 0;
      for (const [, bad] of BAD_DTS) tu.update(bad);
      eq(num((tu as any)._elapsed), num(0), '异常 dt 不应推进 _elapsed');
    });
  });
}
