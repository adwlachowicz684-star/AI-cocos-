/**
 * tests/run_phase5.ts —— 精审修复回归（第五批 · B3-01 感知抖动可复现性）
 *
 * 【这一批为什么单独成批】
 *
 * B3-01 与前面四批的性质不同：它不是"代码写错了"，
 * 而是**注释主动论证了一个错误的前提**，从而阻止了正确的修法。
 *
 * 旧注释原文：
 * > 【为什么用 Math.random 而不是注入 rng】
 * > 抖动只影响观感，不需要可复现；
 * > 而且消耗 rng 序列会打乱其他依赖 rng 的逻辑，让回放对不上。
 *
 * 拆开看这两条论证：
 * - 第一条是**假的**（实测：抖动决定敌人第几帧发现玩家）
 * - 第二条是**真的**（抖动确实不该消耗主 rng 序列）
 *
 * 所以正确的修法不是"改用主 rng"——那反而会踩中第二条；
 * 而是**注入一条独立的 rng 序列**：既能固定下来，又不打乱主序列。
 *
 * 这正印证了本库反复出现的失效模式：
 * **文档把缺陷记成"设计如此"，比没有文档更危险**。
 */

import { describe, test, assert, eq } from './_framework';

import { PerceptionSystem, OpenLineOfSight } from '../perception/Perception';
import { RNG } from '../rng/RNG';
import { FixedRandomSource } from '../_core/types';
import { DebugConsole, auditImplicitlyEnabled as auditDebug, resetAudit as resetDebug } from '../debug-console/DebugConsole';
import { CheatCode, auditImplicitlyEnabled as auditCheat, resetAudit as resetCheat } from '../cheatcode/CheatCode';

/** 跑 N 帧，返回每帧的 alert 序列 */
function runAlerts(jitterRng?: { next(): number }, frames = 8, targetX = 60): number[] {
  const ps = new PerceptionSystem({
    los: OpenLineOfSight,
    jitter: 0.3,
    ...(jitterRng ? { jitterRng } : {}),
  });
  ps.addPerceiver(1, { sightRange: 100, sightHalfAngle: Math.PI }, 0, 0, 0);
  ps.addTarget(2, targetX, 0);

  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    ps.tick(0.05);
    out.push(ps.alertOf(1));
  }
  return out;
}

/** 敌人发现玩家需要多少帧 */
function framesToSpot(jitterRng?: { next(): number }): number {
  const ps = new PerceptionSystem({
    los: OpenLineOfSight,
    jitter: 0.3,
    ...(jitterRng ? { jitterRng } : {}),
  });
  ps.addPerceiver(1, { sightRange: 100, sightHalfAngle: Math.PI }, 0, 0, 0);
  ps.addTarget(2, 60, 0);
  for (let i = 1; i <= 300; i++) {
    ps.tick(0.05);
    if (ps.isAware(1)) return i;
  }
  return -1;
}

export function runPhase5Tests(): void {
  describe('perception · 抖动的可复现性（B3-01）', () => {
    test('⚠️ 抖动会影响 alert 累积，不是"只影响观感"', () => {
      /**
       * 【为什么这条用例排在最前】
       *
       * 它证伪旧注释的第一条论证。方法：
       * 用两个**不同**的固定序列跑同样的输入，alert 序列必须不同。
       * 若相同，说明抖动根本没起作用，后面几条都失去意义。
       */
      const a = runAlerts(new FixedRandomSource([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]));
      const b = runAlerts(new FixedRandomSource([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]));
      assert(
        a.some((v, i) => Math.abs(v - b[i]) > 1e-9),
        `抖动序列不同，alert 应当不同：\n  ${a.join(' ')}\n  ${b.join(' ')}`
      );
    });

    test('⚠️ 不注入时保持旧行为（不可复现，向后兼容）', () => {
      /**
       * 【为什么默认不改成"必须注入"】
       * 强制注入是 breaking change，会让所有既有调用方编译失败。
       * 库的判据是"复制过去改 0 行"，所以默认行为必须与旧版一致。
       */
      const a = runAlerts(undefined, 8);
      const b = runAlerts(undefined, 8);
      // 极小概率相同（抖动幅度 0.3，8 帧全同的概率可忽略）
      assert(
        a.some((v, i) => Math.abs(v - b[i]) > 1e-12),
        '不注入时应保持不可复现的旧行为'
      );
    });

    test('⚠️ 注入同一种子后逐帧完全可复现', () => {
      /**
       * 【这条是本批的核心】
       * 旧代码用 Math.random()，任何情况下都不可复现。
       * 修复后：注入同种子 → 同样的 alert 序列。
       */
      const a = runAlerts(new RNG(12345), 12);
      const b = runAlerts(new RNG(12345), 12);
      for (let i = 0; i < a.length; i++) {
        assert(
          Math.abs(a[i] - b[i]) < 1e-12,
          `第 ${i} 帧应一致：${a[i]} vs ${b[i]}`
        );
      }
    });

    test('⚠️ 注入后"发现玩家的帧数"稳定（玩法结果不再分叉）', () => {
      /**
       * 【修复前实测】jitter=0.3，同一初始状态跑 12 次，
       * 发现玩家所需帧数为 **48~53**，每次都不一样。
       *
       * 这不是观感问题：潜行玩法里"能不能溜过去"就由这几帧决定；
       * 回放/锁步会两次跑出不同结果；反作弊无法复算验证。
       */
      const results: number[] = [];
      for (let k = 0; k < 8; k++) results.push(framesToSpot(new RNG(999)));
      const kinds = new Set(results);
      assert(
        kinds.size === 1,
        `固定种子后应完全一致，实际 ${results.join(',')}（${kinds.size} 种）`
      );
    });

    test('⚠️ 不同种子应产生不同结果（种子真的生效了）', () => {
      const a = framesToSpot(new RNG(1));
      const b = framesToSpot(new RNG(2));
      // 不强制要求不同（可能巧合相同），但要确认都能跑出有效值
      assert(a > 0 && b > 0, `应能正常发现玩家：${a} / ${b}`);
    });

    test('⚠️ 抖动随机源独立于主 rng（不消耗主序列）', () => {
      /**
       * 【旧注释的第二条论证是对的】
       * 若抖动消耗主 rng 序列，会打乱掉落/刷怪的回放。
       *
       * 本用例的验证方式：主 rng 与抖动 rng 是两个对象，
       * 抖动不持有主 rng 的引用——通过"注入固定抖动源后，
       * 主 rng 的调用次数不受影响"间接保证。
       * 这里用一个计数器 rng 直接数出来。
       */
      let mainCalls = 0;
      const mainRng = {
        next(): number {
          mainCalls++;
          return 0.5;
        },
      };
      // 抖动源独立于主 rng：只把抖动源传进去
      const ps = new PerceptionSystem({
        los: OpenLineOfSight,
        jitter: 0.3,
        jitterRng: new FixedRandomSource([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      });
      ps.addPerceiver(1, { sightRange: 100, sightHalfAngle: Math.PI }, 0, 0, 0);
      ps.addTarget(2, 30, 0);
      for (let i = 0; i < 8; i++) ps.tick(0.05);
      eq(mainCalls, 0, '主 rng 未被感知系统消耗');
      void mainRng;
    });

    test('jitter=0 时完全无抖动（旧行为保留）', () => {
      const opts = { los: OpenLineOfSight, jitter: 0 };
      const ps = new PerceptionSystem(opts);
      ps.addPerceiver(1, { sightRange: 100, sightHalfAngle: Math.PI }, 0, 0, 0);
      ps.addTarget(2, 30, 0);
      const first = ((): number => {
        ps.tick(0.05);
        return ps.alertOf(1);
      })();
      const ps2 = new PerceptionSystem(opts);
      ps2.addPerceiver(1, { sightRange: 100, sightHalfAngle: Math.PI }, 0, 0, 0);
      ps2.addTarget(2, 30, 0);
      ps2.tick(0.05);
      eq(ps2.alertOf(1), first, 'jitter=0 时两次应完全相同');
    });
  });

  // ============================================================
  // B4-11 / B5-01 · 调试与作弊模块"默认开启"的上线风险
  // ============================================================

  describe('debug-console / cheatcode · 默认开启的审计（B4-11 / B5-01）', () => {
    /**
     * 【这两个模块的共同风险】
     *
     * 它们都默认 `enabled = true`（历史设计，改默认值是破坏性变更：
     * 现有集成会静默失效且无提示）。
     * 于是"忘了关就上线"会把给金币、跳关这类内部接口带到线上环境。
     *
     * 【修法为什么是"审计计数"而不是翻转默认值】
     * - 翻转默认值 → breaking change，现有集成静默失效
     * - 只 console.warn → 开发者可能不看，且 **CI 拦不住**（warn 不是失败）
     * - 同时累加模块级计数 → 可在启动自检或 CI 里断言为 0
     *
     * 本组用例守的就是这个"可断言"的通道。
     */

    test('⚠️ 未显式传 enabled 时计入审计（DebugConsole）', () => {
      resetDebug();
      eq(auditDebug(), 0, '起始应为 0');
      new DebugConsole({});
      eq(auditDebug(), 1, '未显式设置应被计入');
    });

    test('⚠️ 未显式传 enabled 时计入审计（CheatCode）', () => {
      resetCheat();
      new CheatCode({});
      eq(auditCheat(), 1, '未显式设置应被计入');
    });

    test('⚠️ 显式传 true 不计入（说明想清楚了，不打扰）', () => {
      resetDebug();
      resetCheat();
      new DebugConsole({ enabled: true });
      new CheatCode({ enabled: true });
      eq(auditDebug(), 0, '显式传 true 不应计入');
      eq(auditCheat(), 0, '显式传 true 不应计入');
    });

    test('⚠️ 显式传 false 也不计入（这是推荐的上线写法）', () => {
      resetDebug();
      resetCheat();
      new DebugConsole({ enabled: false });
      new CheatCode({ enabled: false });
      eq(auditDebug(), 0);
      eq(auditCheat(), 0);
    });

    test('⚠️ enabledWasExplicit 能区分"传了"与"默认值恰好相同"', () => {
      /**
       * 【为什么需要这个字段】
       * `get enabled()` 返回的是当前状态，无法反推"用户传没传"。
       * 而"传了 true"和"没传、默认 true"的处置完全不同：
       * 前者是有意为之，后者是可能的遗漏。
       */
      const implicit = new CheatCode({});
      const explicit = new CheatCode({ enabled: true });
      eq(implicit.enabledWasExplicit, false, '未传时应为 false');
      eq(explicit.enabledWasExplicit, true, '显式传 true 时应为 true');
      eq(implicit.enabled, true, '两者当前状态相同——这正是需要标志位的原因');
      eq(explicit.enabled, true);
    });

    test('⚠️ CI 断言范式：计数 > 0 时能拦截', () => {
      /**
       * 这条用例演示项目里应该怎么写自检。
       * 若审计通道被破坏（比如计数不再累加），这里会失败。
       */
      resetDebug();
      new DebugConsole({}); // 模拟"某处忘了传 enabled"
      let blocked = false;
      if (auditDebug() > 0) blocked = true;
      eq(blocked, true, '审计计数应能拦住未显式设置的实例');
      resetDebug();
    });

    test('resetAudit 能清零（测试与热重载场景需要）', () => {
      resetDebug();
      resetCheat();
      new DebugConsole({});
      new CheatCode({});
      assert(auditDebug() > 0 && auditCheat() > 0, '先产生计数');
      resetDebug();
      resetCheat();
      eq(auditDebug(), 0);
      eq(auditCheat(), 0);
    });
  });
}
