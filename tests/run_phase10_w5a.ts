/**
 * tests/run_phase10_w5a.ts —— 第二次精审 · 窗口 W5-A 的回归测试
 *
 * 【本窗口的 9 个单元】
 * behavior-tree  fsm  number-roller  quest  signal  skill-queue  steering  telemetry  turn
 *
 * 【每条修复配两个用例】
 * ① 回归用例：修复前**确实会失败**（失败现象写在该用例上方的注释里）
 * ② 对照用例：正常输入不受影响（防止矫枉过正）
 *
 * 【为什么这个文件不注册进 run.ts】
 * 16 个窗口同时改 `tests/run.ts` 必然冲突，该文件由总审统一合并。
 * 本文件导出 `runPhase10W5ATests()`，单独跑：
 *   node .build/tests/run_phase10_w5a.js
 */

import { describe, describeAsync, test, testAsync, assert, eq, near, throws } from './_framework';

import { Wait, CooldownDecorator, Action, Repeater, Parallel, Selector, BTStatus } from '../behavior-tree/BTNode';
import { BehaviorTree } from '../behavior-tree/BehaviorTree';
import { StateMachine } from '../fsm/StateMachine';
import { NumberRollerCore } from '../number-roller/NumberRollerCore';
import { QuestSystem } from '../quest/QuestSystem';
import { Signal } from '../signal/Signal';
import { SkillQueue } from '../skill-queue/SkillQueue';
import { createAgent, v2, applyForce, integrate, wander, circleFormation, formationOffset } from '../steering/Steering';
import { Telemetry } from '../telemetry/Telemetry';
import { TurnSystem } from '../turn/TurnSystem';
import { FixedRandomSource } from '../_core/types';

export function runPhase10W5ATests(): void {
  // ============================================================
  // behavior-tree · P1
  // ============================================================

  describe('behavior-tree · Wait 的秒数收口（P1）', () => {
    test('⚠️ Wait(NaN) 不得永远返回 Running', () => {
      // 修复前：_seconds 为 NaN 时 `_elapsed >= NaN` 恒 false
      // → 600 帧内 Success 次数 = 0，节点永久停在 Running。
      const w = new Wait<void>('w', NaN);
      let success = 0;
      for (let i = 0; i < 100; i++) {
        if (w.tick(undefined, {}, 1 / 60) === BTStatus.Success) success++;
      }
      assert(success > 0, `Wait(NaN) 应能结束，实际 Success ${success} 次`);
    });

    test('⚠️ Wait(Infinity) 仍表示"无限等待"（不被误收口成 0）', () => {
      // 与 NaN 相对的另一头：Infinity 是**合法**的"永远等下去"。
      // numOr 会把它当非有限值回落到 0，所以这里单独确认它确实没有等待。
      const w = new Wait<void>('w', Infinity);
      let success = 0;
      for (let i = 0; i < 60; i++) {
        if (w.tick(undefined, {}, 1 / 60) === BTStatus.Success) success++;
      }
      eq(success, 0, 'Infinity 应一直 Running');
    });

    test('Wait(0.1) 正常等待（防止矫枉过正）', () => {
      const w = new Wait<void>('w', 0.1);
      let success = 0;
      for (let i = 0; i < 600; i++) {
        if (w.tick(undefined, {}, 1 / 60) === BTStatus.Success) success++;
      }
      // 600 帧 = 10 秒，每 0.1 秒一次 → 约 85 次（autoReset 会吞掉一次判定）
      assert(success > 50, `Wait(0.1) 在 10 秒内应成功约 85 次，实际 ${success}`);
    });
  });

  describe('behavior-tree · CooldownDecorator 的秒数收口（P1）', () => {
    test('⚠️ Cooldown(Infinity) 仍是"一次放完永久冷却"（不被误收口成 0）', () => {
      // 与 NaN 相对的另一头：Infinity 是**合法**的"一次性技能"语义。
      // fixSeconds 必须放行它——若被 numOr 回落成 0，一次性技能会变成每帧可放。
      let n = 0;
      const child = new Action<void>('a', () => {
        n++;
        return BTStatus.Success;
      });
      const cd = new CooldownDecorator<void>('cd', child, Infinity);
      for (let i = 0; i < 10; i++) cd.tick(undefined, {}, 1 / 60);
      eq(n, 1, 'Infinity 冷却 = 只放一次');
    });

    /**
     * 【⚠️ 修复后仍是"无冷却"（对家 W5-B 指出措辞易被误读）】
     *
     * `Cooldown(NaN)` 收口成 **0 秒**，子节点依旧每帧执行（实测 5 帧 5 次，与修复前一致）。
     * 变的是 `remain` 从 NaN 变成可观测的 `0`——**不是"恢复成配表默认值"**。
     * 这个取舍与 `Wait(NaN) = 0 秒` 同口径：非法值一律退化为"没有效果"，
     * 而不是替调用方猜一个默认值。别把这条读成"冷却不再失效"。
     */
    test('⚠️ Cooldown(NaN) 的 remain 必须是可观测的有限数（语义 = 无冷却）', () => {
      // 修复前：NaN 写进 _remain 后 `_remain > 0` 恒 false，
      // 子节点每帧都被执行（技能每帧释放），而 remain 显示 NaN。
      let n = 0;
      const child = new Action<void>('a', () => {
        n++;
        return BTStatus.Success;
      });
      const cd = new CooldownDecorator<void>('cd', child, NaN);
      for (let i = 0; i < 5; i++) cd.tick(undefined, {}, 1 / 60);
      assert(Number.isFinite(cd.remain), `remain 应为有限数，实际 ${cd.remain}`);
      eq(cd.remain, 0, '0 秒冷却 = 不冷却，但 remain 可观测');
    });

    test('Cooldown(1) 冷却期内只执行一次（防止矫枉过正）', () => {
      let n = 0;
      const child = new Action<void>('a', () => {
        n++;
        return BTStatus.Success;
      });
      const cd = new CooldownDecorator<void>('cd', child, 1);
      for (let i = 0; i < 10; i++) cd.tick(undefined, {}, 1 / 60);
      eq(n, 1, '1 秒冷却、10 帧共 1/6 秒 → 只应执行 1 次');
    });
  });

  // ============================================================
  // behavior-tree · P2
  // ============================================================

  describe('behavior-tree · Repeater 的次数收口（P2）', () => {
    test('⚠️ times = 0 表示一次都不执行', () => {
      // 修复前：先 tick 子节点再判定，times=0 时子节点仍被执行 1 次。
      let n = 0;
      const rep = new Repeater<void>(
        'r',
        new Action<void>('a', () => {
          n++;
          return BTStatus.Success;
        }),
        0
      );
      const s = rep.tick(undefined, {}, 1 / 60);
      eq(n, 0, 'times = 0 不应执行子节点');
      eq(s, BTStatus.Success);
    });

    /**
     * 【⚠️ 这条是"收口"，不是行为变更（对家 W5-B 验收时指出应写明）】
     *
     * 修复前 `_count >= NaN` 恒 false、修复后 `_count >= Infinity` 同样恒 false
     * ——**两者都是"无限 Repeater"**，实测行为完全一致（50 帧 50 次、恒 Running）。
     * 所以这条断言回退修复后照样通过，属"锁现状"用例。
     *
     * 真正的收益是：非法次数有了**确定且可预期**的语义（与"不传参"一致），
     * 而不是依赖 NaN 碰巧也让比较恒为 false。别把它读成"NaN 不再导致无限循环"。
     */
    test('⚠️ times = NaN 退化为 Infinity（收口，行为与"不传参"对齐）', () => {
      // 修复前：`_count >= NaN` 恒 false，Repeater 永不结束。
      // 收口后与"不传参"一致（Infinity），行为可预期。
      let n = 0;
      const rep = new Repeater<void>(
        'r',
        new Action<void>('a', () => {
          n++;
          return BTStatus.Success;
        }),
        NaN
      );
      let status: BTStatus = BTStatus.Running;
      for (let i = 0; i < 50; i++) status = rep.tick(undefined, {}, 1 / 60);
      eq(n, 50, '无限 Repeater 应每帧执行');
      eq(status, BTStatus.Running, '无限 Repeater 不返回 Success');
    });

    test('times = 3 每 3 次完成一轮（防止矫枉过正）', () => {
      let n = 0;
      let success = 0;
      const rep = new Repeater<void>(
        'r',
        new Action<void>('a', () => {
          n++;
          return BTStatus.Success;
        }),
        3
      );
      for (let i = 0; i < 9; i++) {
        if (rep.tick(undefined, {}, 1 / 60) === BTStatus.Success) success++;
      }
      eq(n, 9);
      eq(success, 3, '9 帧内应完成 3 轮');
    });
  });

  describe('behavior-tree · Parallel 不再重复触发已完成子节点（P2）', () => {
    test('⚠️ skipCompleted = true 时已 Success 的子节点不再被 tick', () => {
      // 修复前（且默认保持）：每帧 tick 所有子节点，
      // 已 Success 的动作节点（放音效 / 发子弹）会被反复触发。
      let n = 0;
      const par = new Parallel<void>(
        'p',
        [
          new Action<void>('a', () => {
            n++;
            return BTStatus.Success;
          }),
          new Action<void>('b', () => BTStatus.Running),
        ],
        'all',
        true
      );
      for (let i = 0; i < 5; i++) par.tick(undefined, {}, 1 / 60);
      eq(n, 1, '已 Success 的子节点只应被 tick 一次');
    });

    test('默认仍每帧 tick 所有子节点（防止矫枉过正）', () => {
      let n = 0;
      const par = new Parallel<void>('p', [
        new Action<void>('a', () => {
          n++;
          return BTStatus.Success;
        }),
        new Action<void>('b', () => BTStatus.Running),
      ]);
      for (let i = 0; i < 5; i++) par.tick(undefined, {}, 1 / 60);
      eq(n, 5, '默认行为不变');
    });
  });

  describe('behavior-tree · destroy 对共享子节点只调一次（P2）', () => {
    test('⚠️ 同一子节点挂两处时 destroy 只调一次', () => {
      // 修复前：parent 的 destroy 会把它 destroy 两遍，
      // 若 destroy 是"归还对象池"，同一个对象被归还两次。
      let destroyed = 0;
      const shared = new Action<void>('shared', () => BTStatus.Success);
      shared.destroy = () => {
        destroyed++;
      };
      new Selector<void>('s', [shared, shared]).destroy();
      eq(destroyed, 1);
    });

    test('不同子节点各自 destroy（防止矫枉过正）', () => {
      let destroyed = 0;
      const mk = (): Action<void> => {
        const a = new Action<void>('a', () => BTStatus.Success);
        a.destroy = () => {
          destroyed++;
        };
        return a;
      };
      new Selector<void>('s', [mk(), mk()]).destroy();
      eq(destroyed, 2);
    });

    test('trackedNodes 是手动接口（文档已更正，此处锁住语义）', () => {
      const tree = new BehaviorTree<void>(new Action<void>('a', () => BTStatus.Success));
      tree.tick(undefined, 1 / 60);
      // 内置节点不自动记录；需要调试面板时请自行 recordNode
      eq(tree.trackedNodes.size, 0);
      tree.recordNode('a', BTStatus.Success);
      eq(tree.trackedNodes.size, 1);
    });
  });

  // ============================================================
  // number-roller · P1 / P2
  // ============================================================

  describe('number-roller · snapTo 的有限性校验（P1）', () => {
    test('⚠️ snapTo(NaN) 必须抛错，而不是永久显示 NaN', () => {
      // 修复前：snapTo 裸写 _current，之后 _rolling = false，
      // update() 开头直接 return → **永远无法自愈**，UI 上永久 "NaN"。
      const r = new NumberRollerCore();
      throws(() => r.snapTo(NaN), '必须是有限数');
    });

    test('snapTo(999) 立即到位（防止矫枉过正）', () => {
      const r = new NumberRollerCore();
      r.snapTo(999);
      eq(r.display, 999);
      eq(r.isRolling, false);
      eq(r.formatted, '999');
    });
  });

  describe('number-roller · 配置项收口（P2）', () => {
    test('⚠️ duration.min = NaN 时滚动动画不得静默失效', () => {
      // 修复前：_computeDuration 返回 NaN → `_rolling = NaN > 0` 为 false
      // → 直接跳到终值（display 从 0 直跳 5000），滚动动画消失。
      const r = new NumberRollerCore({ duration: { min: NaN, max: 1.0 } });
      r.set(5000);
      eq(r.isRolling, true, '应处于滚动中');
      eq(r.display, 0, '还没滚动就不该到终值');
    });

    /**
     * 【⚠️ 这条是"内部收口"，行为未变（对家 W5-B 指出应写明）】
     *
     * 修复前 `decimals: -1` → `formatted = '1'`；修复后（夹到 0 后走 `toFixed(0)`）
     * 结果同样是 `'1'` —— **对外行为完全一致**，实测修复前后输出相同。
     * 变的是内部不再依赖"`decimals > 0` 碰巧为 false"这种隐式兜底。
     * 它原本就不会抛 RangeError（走的是 Math.round 分支），
     * 这条用例锁的是"别将来改崩了"，不是"修了一个 bug"。
     */
    test('⚠️ decimals = -1 不得抛 RangeError（内部收口，输出不变）', () => {
      // 修复前：`decimals > 0` 为 false，走 Math.round 分支——
      // 实际不抛，但配置被静默吞掉；这里锁住"不会崩"这条底线。
      const r = new NumberRollerCore({ decimals: -1 });
      r.snapTo(1.234);
      eq(r.formatted, '1');
    });

    test('⚠️ formatted(-0.4) 不得输出 "-0"', () => {
      // 修复前：neg 按 `v < 0` 判定，Math.round(0.4) = 0 → 输出 "-0"。
      const r = new NumberRollerCore();
      r.snapTo(-0.4);
      eq(r.formatted, '0');
    });

    /**
     * 【⚠️ 断言加强过（对家 W5-B 验收时抓出来的）】
     *
     * 旧断言是 `assert(r.display < 100)`。对家实测：修复前走"不过冲"分支时
     * 中途值 = **87.5**，同样 `< 100` —— 断言在两种实现下都成立，**无效用例**。
     *
     * 正确的做法是**把下冲与不过冲直接对照**：两者中途值必须明显不同。
     * 实测：修复前 87.5 vs 87.5（无差别 → 断言红），修复后 49.77 vs 87.5（→ 断言绿）。
     */
    test('⚠️ overshoot < 1 的下冲必须生效（与不过冲直接对照）', () => {
      // 修复前：只有 `> 1` 才走过冲分支，0.5 被当成"不过冲"。
      const plain = new NumberRollerCore({ duration: { min: 1, max: 1 } });
      plain.set(100);
      plain.update(0.5);

      const under = new NumberRollerCore({ duration: { min: 1, max: 1 } });
      under.set(100, { overshoot: 0.5 });
      under.update(0.5);

      assert(
        under.display < plain.display - 1e-6,
        `下冲应比不过冲更慢：下冲 ${under.display} vs 不过冲 ${plain.display}`
      );
    });

    test('正常 duration 与 decimals 行为不变（防止矫枉过正）', () => {
      const r = new NumberRollerCore({ duration: { min: 0.25, max: 1.0 } });
      r.set(5000);
      eq(r.isRolling, true);
      const r2 = new NumberRollerCore({ decimals: 2 });
      r2.snapTo(3.14159);
      eq(r2.formatted, '3.14');
      const r3 = new NumberRollerCore();
      r3.snapTo(-5.4);
      eq(r3.formatted, '-5', '负数仍要带负号');
      const r4 = new NumberRollerCore({ duration: { min: 1, max: 1 } });
      r4.set(100);
      r4.update(0.5);
      r4.update(0.5);
      near(r4.display, 100, 1e-9, '不过冲时正常到达终值');
    });
  });

  // ============================================================
  // quest · P1
  // ============================================================

  describe('quest · import 的字段校验（P1）', () => {
    function makeQuest(): QuestSystem {
      const q = new QuestSystem();
      q.define({
        id: 'q1',
        name: '清理史莱姆',
        objectives: [{ type: 'kill', target: 'slime', count: 5 }],
        rewards: { gold: 100 },
      });
      return q;
    }

    test('⚠️ status 是枚举外的值时整条跳过', () => {
      // 修复前：status='garbage' 被原样写入，available/active/completed
      // 三个 getter 全都查不到它 → 任务在 UI 上"消失"。
      const q = makeQuest();
      const skipped = q.import([{ id: 'q1', status: 'garbage' as never }]);
      eq(skipped, 1, '非法 status 应计入 skipped');
      eq(q.status('q1'), 'available', '未被非法存档污染');
    });

    test('⚠️ progress 元素非数字时收口为 0', () => {
      // 修复前：progress: ['a'] 原样写入，之后 `next[i] + n` 得到 NaN，
      // `next[i] >= need` 恒 false → 该目标永远无法完成。
      const q = makeQuest();
      const skipped = q.import([{ id: 'q1', status: 'active', progress: ['a' as never] }]);
      eq(skipped, 0, 'id 与 status 合法 → 整条接受，只修数据');
      eq(q.objectiveProgress('q1', 0)?.current, 0);
      q.accept('q1');
      q.report({ type: 'kill', target: 'slime', n: 5 });
      eq(q.status('q1'), 'completed', '进度被收口后应能正常完成');
    });

    test('合法存档往返不变（防止矫枉过正）', () => {
      const q = makeQuest();
      q.accept('q1');
      q.report({ type: 'kill', target: 'slime', n: 3 });
      const data = q.export();
      const q2 = makeQuest();
      eq(q2.import(data), 0);
      eq(q2.status('q1'), 'active');
      eq(q2.objectiveProgress('q1', 0)?.current, 3);
    });
  });

  // ============================================================
  // signal · P1
  // ============================================================

  describe('signal · 同一函数注册多次时的取消（P1）', () => {
    test('⚠️ once + add 同一函数，emit 后只删 once 那一条', () => {
      // 修复前：_pendingRemoval 是 Set<函数>，收尾 filter 把所有 fn 相同的
      // 条目一起删掉 → listenerCount 从 2 直接变 0，add 的那条被连坐。
      let n = 0;
      const fn = (): void => {
        n++;
      };
      const s = new Signal<() => void>();
      s.once(fn);
      s.add(fn);
      eq(s.listenerCount, 2);
      s.emit();
      eq(n, 2, '两条注册都应被调用');
      eq(s.listenerCount, 1, '只应删掉 once 那一条');
    });

    /**
     * 【⚠️ 这条用例重写过（对家 W5-B 验收时抓出来的）】
     *
     * 旧版写的是「A 自增 1 并自我取消、B 自增 10，第二次 emit 后 m 应为 21」。
     * 对家在 df65fca 上实测：修复前 m 就是 21、listenerCount 就是 1——
     * **与修复后完全一致**，即这条断言回退修复后照样通过，是无效用例。
     *
     * 根因（读基线 `signal/Signal.ts`）：`_pendingRemoval` 是 `Set<函数>`，
     * 连坐只发生在**集合里存在相同函数引用**时。
     * 旧版 A、B 是两个不同引用，Set 按值去重删不掉 B，压根没触发 bug。
     *
     * 真正能触发的形态是**同一个函数注册两次**、在回调里只取消自己那一条：
     * 修复前收尾 filter 会把两条一起删掉（count 停在 1、listenerCount 归 0），
     * 修复后只有被 off 的那一条消失（count = 3、listenerCount = 1）。
     * 实测（修复前 / 修复后）：count = 1 / 3，listenerCount = 0 / 1。
     */
    test('⚠️ 同一函数注册两次并在回调里自我取消，不得连坐另一条注册', () => {
      let count = 0;
      let off1: (() => void) | null = null;
      const fn = (): void => {
        count++;
        if (off1) off1();
      };
      const s = new Signal<() => void>();
      off1 = s.add(fn);
      s.add(fn);
      eq(s.listenerCount, 2);

      s.emit();
      eq(s.listenerCount, 1, '只应删掉被 off 的那一条');
      s.emit();
      // 第一次 emit：两条注册都调用（count = 2），收尾删掉 id 更小的那条
      // 第二次 emit：剩下那条仍应被调用（count = 3）
      eq(count, 3, '未被取消的那条注册必须在后续 emit 中继续被调用');
    });

    test('普通 add / off 语义不变（防止矫枉过正）', () => {
      let n = 0;
      const s = new Signal<() => void>();
      const off = s.add(() => {
        n++;
      });
      s.emit();
      off();
      s.emit();
      eq(n, 1, '取消后不再收到');
      eq(s.listenerCount, 0);
    });
  });

  // ============================================================
  // skill-queue · P1
  // ============================================================

  describe('skill-queue · window 的收口（P1）', () => {
    interface Ctx {
      x?: number;
    }

    function makeCaster(busy: boolean): {
      busy: boolean;
      cooldownLeft: (id: string) => number;
      tryCast: (id: string, ctx: Ctx) => { ok: boolean; reason?: string };
    } {
      return {
        busy,
        cooldownLeft: () => 0,
        tryCast: (): { ok: boolean } => ({ ok: true }),
      };
    }

    test('⚠️ 构造时 window = NaN 不得让所有排队项立即过期', () => {
      // 修复前：构造函数是裸的 `opts.window ?? 0.25`
      // → `waited <= NaN` 恒 false → 一入队就被判过期（rejected = 1）。
      const q = new SkillQueue(makeCaster(true) as never, { window: NaN });
      assert(Number.isFinite(q.window), `window 应为有限数，实际 ${q.window}`);
      q.request('s1', { x: 0, y: 0, facingDeg: 0 });
      q.tick(1 / 60);
      eq(q.count, 1, '窗口内的排队项不该被清空');
      eq(q.stats.rejected, 0);
    });

    test('⚠️ 运行时把 window 设成 NaN 应保留上一次的有效值', () => {
      // 修复前：setter 用 `clampNum(v, 0, 1e6, 0)`，兜底到 0 ——
      // 而 `waited <= 0` 除入队那一帧外恒为 false，效果与没修一样。
      const q = new SkillQueue(makeCaster(true) as never, { window: 1.0 });
      q.request('s1', { x: 0, y: 0, facingDeg: 0 });
      q.tick(0.1);
      eq(q.count, 1);
      q.window = NaN;
      eq(q.window, 1.0, '非法值应保留旧值而不是回落到 0');
      q.tick(0.1);
      eq(q.count, 1, '窗口维持 1 秒 → 仍在窗口内');
      eq(q.stats.rejected, 0);
    });

    test('window 到期仍会过期（防止矫枉过正）', () => {
      const q = new SkillQueue(makeCaster(true) as never, { window: 0.2 });
      q.request('s1', { x: 0, y: 0, facingDeg: 0 });
      q.tick(0.1);
      eq(q.count, 1);
      q.tick(0.2);
      eq(q.count, 0, '超过窗口应被丢弃');
      eq(q.stats.rejected, 1);
    });
  });

  // ============================================================
  // steering · P1 / P2
  // ============================================================

  describe('steering · 除零与收口（P1 / P2）', () => {
    test('⚠️ mass = 0 不得产出 Infinity / NaN 坐标', () => {
      // 修复前：`force / 0` → Infinity 或 NaN，一旦进了 vel，
      // 限速 `speed > limit` 对 NaN 恒为 false → 再也救不回来。
      const a = createAgent(v2(0, 0), v2(), { mass: 1 });
      a.mass = 0;
      applyForce(a, v2(10, 10));
      integrate(a, 1 / 60);
      assert(Number.isFinite(a.pos.x) && Number.isFinite(a.pos.y), `pos 应有限，实际 ${JSON.stringify(a.pos)}`);
      assert(Number.isFinite(a.vel.x) && Number.isFinite(a.vel.y), `vel 应有限，实际 ${JSON.stringify(a.vel)}`);
    });

    test('⚠️ maxSpeed = NaN 时限速不得静默失效', () => {
      // 修复前：`speed > NaN` 恒 false → 速度无限增长（实测可到 1e9）。
      const a = createAgent(v2(0, 0), v2(), { maxSpeed: NaN });
      a.vel.x = 1e9;
      integrate(a, 1 / 60);
      near(a.vel.x, 100, 1e-6, '应回落到 createAgent 的默认 maxSpeed = 100');
    });

    test('⚠️ circleFormation 的 count = 0 不得返回 NaN', () => {
      const p = circleFormation(0, 0, 10);
      assert(Number.isFinite(p.x) && Number.isFinite(p.y), `实际 ${JSON.stringify(p)}`);
    });

    test('⚠️ formationOffset 的 columns = 0 不得返回 NaN', () => {
      const p = formationOffset(0, 10, 0);
      assert(Number.isFinite(p.x) && Number.isFinite(p.y), `实际 ${JSON.stringify(p)}`);
    });

    test('正常参数结果不变（防止矫枉过正）', () => {
      const a = createAgent(v2(0, 0), v2(), { mass: 2 });
      applyForce(a, v2(10, 0));
      integrate(a, 1 / 60);
      near(a.vel.x, 10 / 2 / 60, 1e-9, 'a = F / m');
      const p = circleFormation(1, 4, 10);
      near(p.x, 0, 1e-9);
      near(p.y, 10, 1e-9);
      const f = formationOffset(0, 10, 5);
      near(f.x, -20, 1e-9);
      near(f.y, 0, 1e-9);
    });
  });

  /**
   * 【⚠️ 本组用例的有效性来自类型系统，不是运行时断言（对家 W5-B 指出）】
   *
   * 真正被修掉的是"不传 rand 时默认 `Math.random`"这条路径——改成必填参数后，
   * 漏传只能由 `tsc` 拦住，**运行时无法构造回退用例**。
   * 下面两条断言（"注入后确定"）在修复前也成立，属"锁现状"。
   * 请不要因为"有测试"就以为这条已被断言守住。
   */
  describe('steering · wander 的随机源（P1）', () => {
    test('⚠️ 注入同一随机源时 wander 必须可复现', () => {
      // 修复前：默认 `rand = Math.random`，不注入时两次调用结果不同
      // → 回放 / 录像 / 确定性 lockstep / 单测全部失效。
      const mk = (): { angle: number } => ({ angle: 0 });
      const a1 = createAgent(v2(0, 0), v2(50, 0), {});
      const a2 = createAgent(v2(0, 0), v2(50, 0), {});
      const r1 = wander(a1, mk(), 20, 10, 0.5, new FixedRandomSource([0.3]).next.bind(new FixedRandomSource([0.3])));
      const r2 = wander(a2, mk(), 20, 10, 0.5, new FixedRandomSource([0.3]).next.bind(new FixedRandomSource([0.3])));
      near(r1.x, r2.x, 1e-12);
      near(r1.y, r2.y, 1e-12);
    });

    test('不同随机序列产出不同结果（防止矫枉过正）', () => {
      const mk = (): { angle: number } => ({ angle: 0 });
      const a1 = createAgent(v2(0, 0), v2(50, 0), {});
      const a2 = createAgent(v2(0, 0), v2(50, 0), {});
      const r1 = wander(a1, mk(), 20, 10, 0.5, new FixedRandomSource([0.1]).next.bind(new FixedRandomSource([0.1])));
      const r2 = wander(a2, mk(), 20, 10, 0.5, new FixedRandomSource([0.9]).next.bind(new FixedRandomSource([0.9])));
      assert(Math.abs(r1.x - r2.x) > 1e-9 || Math.abs(r1.y - r2.y) > 1e-9, 'rand 应真的影响结果');
    });
  });

  // ============================================================
  // telemetry · P1 / P2
  // ============================================================

  describeAsync('telemetry · 配置收口与统计（P1 / P2）', async () => {
    function make(opts: Record<string, unknown> = {}): Telemetry {
      const t = new Telemetry({
        sender: async () => {
          throw new Error('网络失败');
        },
        maxBuffer: 1000,
        ...opts,
      } as never);
      t.useClock(() => 0);
      return t;
    }

    await testAsync('⚠️ maxRetries 为 "" 时不得第一次失败就永久丢弃', async () => {
      // 修复前：`?? 3` 挡不住 ''，`_retries <= ''` 中 '' 转成 0
      // → `1 <= 0` 恒 false → 第一次失败即丢，永不重试。
      const t = make({ maxRetries: '' });
      t.capture('e');
      await t.flush();
      await t.flush();
      eq(t.buffered, 1, '失败后应放回缓冲等待重试');
    });

    await testAsync('⚠️ flushIntervalMs = NaN 时 shouldFlush 不得恒为 true', async () => {
      // 修复前：`now - last < NaN` 恒 false → 每条事件都触发一次网络请求。
      const t = make({ flushIntervalMs: NaN });
      t.capture('e');
      eq(t.shouldFlush(), false);
    });

    /**
     * 【⚠️ 这条是"锁现状"用例，不是缺陷复现（对家 W5-B 指出应标注）】
     *
     * 基线 `Telemetry.ts` 的 `willSample` **已经用了 `hasOwn`**，
     * 原精审报告说的"原型键取到函数 → 采样恒 false"在基线就不成立。
     * 本次只在 `hasOwn` 之上补了 `numOr`（防表里存的是 'abc'/null），
     * 断言修复前后都通过 —— 它的作用是**防止将来有人把 hasOwn 改回去**。
     */
    await testAsync('⚠️ willSample 对原型键走全局采样率而不是静默丢弃（锁现状）', async () => {
      // 修复前：`_eventSampleRates['toString']` 取到原型方法（函数）
      // → `hash < function` 恒 false → 该事件名永远不上报。
      const t = make({ eventSampleRates: {} });
      eq(t.willSample('toString'), true, '全局采样率 1 → 应采集');
    });

    await testAsync('⚠️ sampleRate = "abc" 不得静默全量丢失', async () => {
      // 修复前：clamp01 用 Number.isNaN 判定，而 Number.isNaN('abc') 是 false
      // → 'abc' 原样穿过，之后 `hash < 'abc'` 恒 false → 50 次采集成功 0 次。
      const t = make({ sampleRate: 'abc', sessionId: 's' });
      let ok = 0;
      for (let i = 0; i < 20; i++) if (t.capture('e' + i)) ok++;
      eq(ok, 20, '非法采样率应回落到 1（全采）而不是全丢');
    });

    await testAsync('⚠️ 重试超限丢弃必须计入 dropped', async () => {
      // 修复前：dropped 只统计"缓冲满时丢最旧的"，
      // 重试超限的整批丢弃只记 failed → 看统计的人以为数据还在。
      const t = make({ maxRetries: 0 });
      t.capture('e1');
      t.capture('e2');
      await t.flush();
      eq(t.stats.dropped, 2, '超限丢弃应计入 dropped');
      eq(t.buffered, 0);
    });

    await testAsync('正常采样与重试行为不变（防止矫枉过正）', async () => {
      const t = make({ maxRetries: 3 });
      t.capture('e');
      await t.flush();
      eq(t.buffered, 1, '未超限 → 放回缓冲');
      eq(t.stats.dropped, 0);
      const t2 = make({ flushIntervalMs: 5000 });
      t2.capture('e');
      eq(t2.shouldFlush(), false);
      const t3 = make({ sampleRate: 0.5, sessionId: 'fixed-session' });
      let ok = 0;
      for (let i = 0; i < 50; i++) if (t3.capture('evt' + i)) ok++;
      assert(ok > 0 && ok < 50, `50% 采样应部分命中，实际 ${ok}`);
    });

    await testAsync('destroy 后不再持有 sender（rule5 可卸载）', async () => {
      const t = make({});
      t.capture('e');
      t.destroy();
      eq(t.buffered, 0);
      // destroy 之后 flush 不应再触发网络（sender 已断开）
      await t.flush();
      eq(t.stats.sent, 0);
    });
  });

  // ============================================================
  // turn · P1 / P2
  // ============================================================

  describe('turn · start 的同先攻顺序（P1）', () => {
    function make6(): TurnSystem {
      const t = new TurnSystem();
      for (let i = 0; i < 6; i++) t.addUnit({ id: 'u' + i, initiative: 10 });
      return t;
    }

    function takeOrder(t: TurnSystem): string {
      const out: string[] = [];
      for (let i = 0; i < 6; i++) {
        out.push(t.currentUnitId ?? '?');
        t.endTurn();
      }
      return out.join(',');
    }

    test('⚠️ 注入随机源后 shuffleEqual = true 必须真打乱', () => {
      // 修复前：`return shuffleEqual ? 0 : ...` 依赖 sort 的不稳定性，
      // 而 ES2019 起 sort 是稳定的 → 三种调用全部输出 u0..u5（按添加顺序）。
      const rng = new FixedRandomSource([0.9, 0.1, 0.5, 0.2, 0.8, 0.4, 0.7, 0.3, 0.6, 0.05]);
      const t = make6();
      t.start(true, rng);
      const order = takeOrder(t);
      assert(order !== 'u0,u1,u2,u3,u4,u5', `应被打乱，实际 ${order}`);
    });

    test('⚠️ 同一随机序列必须给出同一顺序（可复现）', () => {
      const mkRng = (): FixedRandomSource =>
        new FixedRandomSource([0.9, 0.1, 0.5, 0.2, 0.8, 0.4, 0.7, 0.3, 0.6, 0.05]);
      const t1 = make6();
      t1.start(true, mkRng());
      const t2 = make6();
      t2.start(true, mkRng());
      eq(takeOrder(t1), takeOrder(t2), '同种子应完全复现');
    });

    test('未注入随机源时顺序与修复前一致（防止矫枉过正）', () => {
      const t = make6();
      t.start(true);
      eq(takeOrder(t), 'u0,u1,u2,u3,u4,u5', '不传 rng 时保持添加顺序，不破坏既有调用方');
    });

    test('先攻不同的部分不受打乱影响', () => {
      const t = new TurnSystem();
      t.addUnit({ id: 'slow', initiative: 1 });
      t.addUnit({ id: 'fast', initiative: 99 });
      t.start(true, new FixedRandomSource([0.9, 0.1]));
      eq(t.currentUnitId, 'fast', '打乱只在同先攻的连续段内进行');
    });
  });

  describe('turn · 行动点的负数与 NaN（P2）', () => {
    function makeAP(ap: number): TurnSystem {
      const t = new TurnSystem();
      t.addUnit({ id: 'x', initiative: 1, actionPoints: ap });
      t.start();
      return t;
    }

    test('⚠️ spendAP(-5) 不得让 AP 增加', () => {
      // 修复前：`if (e.ap < n) return false` 只挡"不够"，
      // 负数 n 让 `3 < -5` 为 false → `ap -= -5` → AP 从 3 变 8。
      const t = makeAP(3);
      eq(t.spendAP(-5), false);
      eq(t.currentAP, 3);
    });

    test('⚠️ spendAP(NaN) 不得把 AP 变成 NaN', () => {
      // 修复前：`3 < NaN` 恒 false → `ap -= NaN` → 之后 `ap <= 0` 恒 false
      // → isOutOfAP 永远 false → 回合永不结束。
      const t = makeAP(3);
      eq(t.spendAP(NaN), false);
      eq(t.currentAP, 3);
      eq(t.isOutOfAP, false);
    });

    test('⚠️ grantAP 传 NaN 不得污染 AP', () => {
      const t = makeAP(3);
      eq(t.grantAP('x', NaN), false);
      eq(t.currentAP, 3);
    });

    test('正常花费与补充行为不变（防止矫枉过正）', () => {
      const t = makeAP(3);
      eq(t.spendAP(2), true);
      eq(t.currentAP, 1);
      eq(t.spendAP(5), false, '不够时不扣');
      eq(t.currentAP, 1);
      eq(t.grantAP('x', 2), true);
      eq(t.currentAP, 3);
      eq(t.spendAP(3), true);
      eq(t.isOutOfAP, true);
    });
  });

  // ============================================================
  // fsm · P2
  // ============================================================

  describe('fsm · can 的白名单语义（P2）', () => {
    interface Ctx {
      n: number;
    }

    test('⚠️ 配了转换表但当前状态缺项时 can() 应返回 false', () => {
      // 修复前：`if (!allowed) return true` 把"缺项"和"没配表"混为一谈
      // → can('jump') 与 can('teleport') 都是 true，白名单形同虚设。
      const fsm = new StateMachine<Ctx>({
        initial: 'idle',
        states: { idle: {}, walk: {}, run: {}, jump: {} },
        transitions: { walk: ['run'] },
      });
      eq(fsm.can('jump'), false);
      eq(fsm.can('teleport'), false);
    });

    test('未配置 transitions 时仍允许任意转换（防止矫枉过正）', () => {
      const fsm = new StateMachine<Ctx>({
        initial: 'a',
        states: { a: {}, b: {} },
      });
      eq(fsm.can('b'), true);
    });

    test('表中有该项时按白名单放行', () => {
      const fsm = new StateMachine<Ctx>({
        initial: 'idle',
        states: { idle: {}, walk: {}, run: {} },
        transitions: { idle: ['walk'], walk: ['run', 'idle'] },
      });
      eq(fsm.can('walk'), true);
      eq(fsm.can('run'), false);
      fsm.transitionTo('walk', { n: 0 });
      eq(fsm.can('run'), true);
      eq(fsm.can('idle'), true);
    });
  });

  describe('fsm · start 幂等与 reset 通知（P2）', () => {
    interface Ctx {
      log: string[];
    }

    test('⚠️ 重复 start 不得重复触发 enter', () => {
      // 修复前：每次 start 都调一次 enter。enter 里通常是播动画/申请资源，
      // 跑两遍的表现是"动画从头播一次"，不一定报错。
      let enters = 0;
      const fsm = new StateMachine<Ctx>({
        initial: 'a',
        states: {
          a: {
            enter: () => {
              enters++;
            },
          },
        },
      });
      const ctx: Ctx = { log: [] };
      fsm.start(ctx);
      fsm.start(ctx);
      eq(enters, 1);
    });

    test('⚠️ reset 必须触发 onChange', () => {
      // 修复前：reset 不发通知 → 埋点缺一段、UI 不刷新，
      // 表现为"读档/重置后状态对了但界面没更新"。
      const changes: string[] = [];
      const fsm = new StateMachine<Ctx>({
        initial: 'a',
        states: { a: {}, b: {} },
        onChange: (from, to) => changes.push(`${from}->${to}`),
      });
      const ctx: Ctx = { log: [] };
      fsm.start(ctx);
      fsm.transitionTo('b', ctx);
      fsm.reset(ctx);
      eq(changes.join(','), 'a->b,b->a');
    });

    test('⚠️ 转换过程中 reset 应被忽略', () => {
      let warned = false;
      const origWarn = console.warn;
      console.warn = () => {
        warned = true;
      };
      try {
        const fsm = new StateMachine<{ deep: boolean }>({
          initial: 'a',
          states: {
            a: {
              enter: () => {},
              update: () => 'b',
            },
            b: {
              enter: (c) => {
                (c as { deep: boolean }).deep = true;
                fsm.reset(c);
              },
            },
          },
        });
        fsm.start({ deep: false });
        fsm.update({ deep: false }, 0.016);
      } finally {
        console.warn = origWarn;
      }
      assert(warned, '转换中 reset 应给出警告');
    });

    test('reset 回到初始状态（防止矫枉过正）', () => {
      const fsm = new StateMachine<Ctx>({
        initial: 'a',
        states: { a: {}, b: {} },
      });
      const ctx: Ctx = { log: [] };
      fsm.start(ctx);
      fsm.transitionTo('b', ctx);
      fsm.reset(ctx);
      eq(fsm.current, 'a');
      near(fsm.timeInState, 0, 1e-9);
    });
  });
}

/**
 * 【为什么这里没有"独立运行"的入口】
 * `tests/run.ts` 由总审统一合并注册，本文件只导出 `runPhase10W5ATests()`；
 * 16 个窗口各自塞一个 `require.main === module` 的分支会让 run.ts 的行为取决于
 * 它是被 import 还是被直接执行。需要单独跑时：
 *   node -e "require('./.build/tests/run_phase10_w5a.js').runPhase10W5ATests()
 *            ; require('./.build/tests/_framework.js').summary()"
 */
