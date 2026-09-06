/**
 * tests/run_dtguard.ts —— 异常数值穿透回归（外部精审报告）
 *
 * 【这批测的是什么】
 * 四份《逐模块精审报告》指出：全库大量"时间推进"方法对 dt 的校验不一致，
 * NaN / Infinity / 负数会穿透，造成**不可自愈**的状态污染。
 *
 * 本报告把它收口成一条规则：
 *
 *   dt 参与算术运算前，必须过 `safeDt(dt)`（有限且为正）
 *
 * 【为什么后果严重】
 * 不是"数值算错了"，而是**污染不可逆**：
 *
 *   x = NaN  →  再正常 update 几百次，x 仍然是 NaN（NaN + 任何数 === NaN）
 *
 * 角色消失、buff 永不消失、冷却永久锁死，全部不抛错、不告警。
 *
 * 【测试设计原则】
 * 每条都断言"异常输入后状态完全不变"，而不只是"没崩溃"——
 * 因为静默改了状态同样是有害的。
 */

import {
  describe, test, assert, eq, near, throws,
} from './_framework';
import { clampNum, safeDt, normalizeAngleRad, angleDiffRad } from '../_core/math';
import { BuffSystem } from '../buff/BuffSystem';
import { CharacterMover } from '../mover/CharacterMover';
import { generateRoomGraph } from '../room-graph/RoomGraph';

/** 所有需要被挡住的异常 dt */
const BAD_DTS: ReadonlyArray<readonly [string, number]> = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['负 -1', -1],
  ['零 0', 0],
];

export function runDtGuardTests(): void {
  describe('safeDt —— dt 守卫工具', () => {
    test('只有"有限且为正"才返回 true', () => {
      assert(safeDt(0.016), '正常 dt 应通过');
      assert(safeDt(1e-9), '极小正数应通过');
      for (const [n, v] of BAD_DTS) {
        assert(!safeDt(v), `${n} 应被挡住`);
      }
    });

    test('三种常见写法的盲区对照（记录为什么必须用 safeDt）', () => {
      // `dt <= 0` 挡不住 NaN / Infinity
      assert(!(NaN <= 0), 'NaN <= 0 是 false → dt<=0 对 NaN 无效');
      assert(!(Infinity <= 0), 'Infinity <= 0 是 false → 同样穿透');
      // `!(dt > 0)` 挡不住 Infinity
      assert(Infinity > 0, 'Infinity > 0 是 true → !(dt>0) 挡不住');
      // Math.max 不做有限性检查
      assert(Number.isNaN(Math.max(1, NaN)), 'Math.max(1, NaN) 是 NaN → 兜底失败');
      // safeDt 三个都挡
      for (const [, v] of BAD_DTS) assert(!safeDt(v), 'safeDt 应挡住全部');
    });
  });

  describe('clampNum —— 配置项兜底', () => {
    test('非有限值回退到 fallback（Math.max 做不到这一点）', () => {
      eq(clampNum(NaN, 1, 1000, 100), 100, 'NaN → fallback');
      eq(clampNum(Infinity, 1, 1000, 100), 100, 'Infinity → fallback');
      eq(clampNum(undefined, 1, 1000, 100), 100, 'undefined → fallback');
      eq(clampNum('abc', 1, 1000, 100), 100, '非数字字符串 → fallback');
    });

    test('有限值被钳制到 [min, max]', () => {
      eq(clampNum(50, 1, 1000, 100), 50, '区间内原样');
      eq(clampNum(-5, 1, 1000, 100), 1, '低于下界 → min');
      eq(clampNum(99999, 1, 1000, 100), 1000, '高于上界 → max');
    });
  });

  describe('_core/math —— 角度归一化死循环（原 Infinity 永久卡死）', () => {
    test('非有限角度返回 0，不死循环', () => {
      eq(normalizeAngleRad(NaN), 0, 'NaN → 0');
      eq(normalizeAngleRad(Infinity), 0, 'Infinity → 0');
      eq(normalizeAngleRad(-Infinity), 0, '-Infinity → 0');

    });

    test('结果始终落在 [-π, π]，包括超大角度', () => {
      for (const v of [0, 0.5, Math.PI, -Math.PI, 3, 7, -7, 100, -100, 10000, -1e6]) {
        const r = normalizeAngleRad(v);
        assert(Number.isFinite(r), `${v} 归一化后必须有限`);
        assert(r >= -Math.PI - 1e-9 && r <= Math.PI + 1e-9, `${v} → ${r} 越界`);
      }
    });

    test('取模不退化：归一化后三角函数值保持一致', () => {
      for (const v of [0.5, 3, 7, -7, 100, 10000]) {
        const r = normalizeAngleRad(v);
        near(Math.sin(r), Math.sin(v), 1e-9, `sin 应保持：${v}`);
        near(Math.cos(r), Math.cos(v), 1e-9, `cos 应保持：${v}`);
      }
    });

    test(' angleDiffRad 走最短路径', () => {
      near(angleDiffRad(0, 1), 1, 1e-9, '相邻角差 1');
      const d = angleDiffRad(350 * Math.PI / 180, 10 * Math.PI / 180) * 180 / Math.PI;
      near(d, 20, 1e-6, '350° 到 10° 应是 +20° 不是 -340°');
      eq(angleDiffRad(0, Infinity), 0, 'Infinity 不透传（否则下游静默失效）');

    });
  });

  describe('mover —— 坐标永久 NaN（角色消失）', () => {
    test('异常 dt 不改变任何状态，且之后能继续正常移动', () => {
      for (const [n, bad] of BAD_DTS) {
        const mv = new CharacterMover({ maxSpeed: 6, accel: 60 } as never) as never as {
          x: number; vx: number; update(dt: number, dx?: number, dy?: number): void;
        };
        for (let i = 0; i < 10; i++) mv.update(0.016, 1, 0);
        const x0 = mv.x, v0 = mv.vx;

        mv.update(bad, 1, 0);
        assert(mv.x === x0 && mv.vx === v0, `${n}：注入帧坐标/速度不应改变`);

        for (let i = 0; i < 100; i++) mv.update(0.016, 1, 0);
        assert(Number.isFinite(mv.x), `${n}：之后坐标必须有限（否则角色消失）`);
        assert(mv.x > x0, `${n}：之后应能继续前进`);
      }
    });

    test('正常移动行为未被破坏（基准 x=0.7066）', () => {
      const mv = new CharacterMover({ maxSpeed: 6, accel: 60 } as never) as never as {
        x: number; update(dt: number, dx?: number, dy?: number): void;
      };
      for (let i = 0; i < 10; i++) mv.update(0.016, 1, 0);
      near(mv.x, 0.7066, 1e-3, '与报告基准一致');
    });
  });

  describe('buff —— Infinity 死循环 + NaN 让 buff 永不消失', () => {
    test('Infinity dt 不死循环（原全库唯一无 guard 的 while）', () => {
      const bs = new BuffSystem();
      bs.register({ id: 'dot', duration: 5, maxStacks: 3, tickInterval: 0.1 } as never);
      bs.apply('dot', 1);
      let ticks = 0;
      bs.update(Infinity, () => { ticks++; });
      assert(ticks <= 64, `onTick 应被 guard 截断，实际 ${ticks} 次`);
    });

    test('超大 dt 也被 guard 截断，不放大卡顿', () => {
      const bs = new BuffSystem();
      bs.register({ id: 'dot', duration: 5, maxStacks: 3, tickInterval: 0.1 } as never);
      bs.apply('dot', 1);
      let ticks = 0;
      bs.update(1e9, () => { ticks++; });
      eq(ticks, 64, '上限 64，与 bullet-pattern 对齐');
    });

    test('异常 dt 不改变剩余时间（NaN 不再让 buff 永不消失）', () => {
      for (const [n, bad] of BAD_DTS) {
        const bs = new BuffSystem();
        bs.register({ id: 'b', duration: 5, maxStacks: 1 } as never);
        bs.apply('b', 1);
        const before = (bs as never as { _active: Map<string, { remain: number }> })._active.get('b')!.remain;
        bs.update(bad);
        const inst = (bs as never as { _active: Map<string, { remain: number }> })._active.get('b');
        assert(inst !== undefined, `${n}：buff 不应消失`);
        eq(inst!.remain, before, `${n}：remain 不应改变`);
      }
    });

    test('正常推进与到期仍然有效', () => {
      const bs = new BuffSystem();
      bs.register({ id: 'b', duration: 5, maxStacks: 1 } as never);
      bs.apply('b', 1);
      bs.update(1);
      const inst = (bs as never as { _active: Map<string, { remain: number }> })._active.get('b');
      near(inst!.remain, 4, 1e-9, '推进 1 秒后剩 4 秒');

      let fired = 0;
      bs.register({ id: 't', duration: 5, maxStacks: 1, tickInterval: 0.5 } as never);
      bs.apply('t', 1);
      bs.update(2, () => { fired++; });
      eq(fired, 4, '2 秒 / 0.5 秒间隔 = 4 次（未触及 64 上限）');

      bs.update(10);
      assert(!(bs as never as { _active: Map<string, unknown> })._active.has('b'), '超时应移除');
    });
  });

  describe('room-graph —— depth 异常导致 OOM 崩溃', () => {
    const rng = { next: () => 0.5 } as never;

    test('非有限 depth 抛错（原会 OOM）', () => {
      for (const [n, d] of [['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]] as const) {
        throws(
          () => generateRoomGraph({ depth: d, rng } as never),
          '必须为有限值',
          `${n} 应抛错`,
        );
      }
    });

    test('超上界 depth 抛错（防 1e9 撑爆内存）', () => {
      throws(() => generateRoomGraph({ depth: 1001, rng } as never), '层数过大', '1001 应被拒');
      throws(() => generateRoomGraph({ depth: 1e9, rng } as never), '层数过大', '1e9 应被拒');
    });

    test('合法 depth 行为不变（含边界 3 与 1000）', () => {
      const g3 = generateRoomGraph({ depth: 3, rng } as never) as never as { nodes: unknown[] };
      assert(g3.nodes.length >= 4, `depth=3 至少 4 节点，实际 ${g3.nodes.length}`);
      const g1000 = generateRoomGraph({ depth: 1000, rng } as never) as never as { nodes: unknown[] };
      assert(g1000.nodes.length > 1000, 'depth=1000 应正常生成');
      throws(() => generateRoomGraph({ depth: 2, rng } as never), '层数至少 3', '原有的下界校验保留');
    });
  });
}
