/**
 * tests/run_phase3.ts —— 精审修复回归（第三批 · 模式 B：无界 count / 模式 C：角度死循环）
 *
 * 【模式 B】`count` / `samples` / `stacks` 这类字段直接用作循环次数。
 * 老实现的守卫（`if (n <= 0) return`、`Math.max(1, n)`）有三个共同盲区：
 *   1. **拦不住 Infinity** → 死循环或 OOM
 *   2. **被 NaN 静默穿透** → `NaN <= 0` 为 false，或 `i < NaN` 恒假（静默什么都不做）
 *   3. `Math.max(1, NaN)` → NaN，同样静默
 *
 * 【模式 C】角度归一化用 while 递减：`while (x > 2π) x -= 2π`。
 * `Infinity - 2π` 仍是 `Infinity` → **条件恒真，CPU 100% 永久卡死**。
 *
 * 【本轮修法】
 * - 模式 B：入口一律 `needCount`（有限非负整数 + 上界）
 * - 模式 C：改用 **O(1) 取模**（`normalizeAngleRad` / `angleDiffRad`），
 *   而不是给 while 加计数上限——后者要回答"上限设多少才够"，没有客观答案。
 *
 * ⚠️ 本文件中所有"卡死"类用例，若修复被回退，会导致**测试进程挂起**
 * （不是用例失败）。这是有意的：故障形态就是卡死，用例应当如实反映。
 */

import { describe, test, assert, eq, throws } from './_framework';

import { compileShape } from '../bullet-pattern/BulletPattern';
import { GachaPity } from '../gacha/GachaPity';
import { Curve } from '../curve/Curve';
import { WaveSpawner } from '../wave-spawner/WaveSpawner';
import { PerceptionSystem, OpenLineOfSight } from '../perception/Perception';
import { snapAngle } from '../indicator/SkillIndicator';
import { normalizeAngle } from '../minimap/Minimap';
import { createAgent, integrate } from '../steering/Steering';
import { Noise } from '../noise/Noise';
import { v2 } from '../steering/Steering';

export function runPhase3Tests(): void {
  // ============================================================
  // 模式 B · 无界 count
  // ============================================================

  describe('bullet-pattern · count', () => {
    test('⚠️ count=Infinity 必须抛错，不能崩溃进程', () => {
      /**
       * 【修复前实测】进程以 `Fatal JavaScript invalid size error` 直接崩溃
       * （退出码 133）。数组无限 push 直到 V8 内存分配失败，
       * **连异常都抓不到**——try/catch 完全无效，比死循环更糟。
       */
      throws(() => compileShape({ count: Infinity, fullCircle: true, speed: 1, typeId: 'x' }), '必须是有限数值');
    });

    test('⚠️ count=NaN 必须抛错（Math.max(1, NaN) 会静默变 NaN）', () => {
      throws(() => compileShape({ count: NaN, fullCircle: true, speed: 1, typeId: 'x' }), '必须是有限数值');
    });

    test('正常 count 不受影响', () => {
      const f = compileShape({ count: 8, fullCircle: true, speed: 1, typeId: 'x' });
      eq(f({ shotIndex: 0, aim: 0, rng: { next: () => 0.5 } }).length, 8, '应生成 8 个角度');
    });
  });

  describe('gacha · pullN', () => {
    function mk(): GachaPity {
      return new GachaPity({
        items: [{ id: 'a', rarity: 'r1' }],
        rarities: [{ id: 'r1', baseRate: 0.1 }],
        rng: { next: () => 0.5 },
      });
    }

    test('⚠️ pullN(Infinity) 必须抛错，不能卡死', () => {
      /** 【修复前实测】退出码 124（卡死）。老实现 `if (n <= 0) return []` 只挡非正数。 */
      throws(() => mk().pullN(Infinity), '必须是有限数值');
    });

    test('⚠️ pullN(NaN) 必须抛错（NaN <= 0 为 false，会静默进入循环）', () => {
      throws(() => mk().pullN(NaN), '必须是有限数值');
    });

    test('正常抽卡不受影响', () => {
      eq(mk().pullN(5).length, 5);
      eq(mk().pullN(0).length, 0, '0 次仍返回空');
    });
  });

  describe('curve · integrate 采样数', () => {
    test('⚠️ samples=Infinity 必须抛错，不能卡死', () => {
      /** 【修复前实测】退出码 124（卡死）。 */
      const c = new Curve([{ time: 0, value: 0 }, { time: 1, value: 1 }]);
      throws(() => c.integrate(Infinity), '必须是有限数值');
    });

    test('⚠️ samples=0 必须抛错（step 会变 Infinity）', () => {
      const c = new Curve([{ time: 0, value: 0 }, { time: 1, value: 1 }]);
      throws(() => c.integrate(0), '必须为正');
    });

    test('正常积分不受影响', () => {
      const c = new Curve([{ time: 0, value: 0 }, { time: 1, value: 1 }]);
      // 三角形面积 = 0.5
      assert(Math.abs(c.integrate(1000) - 0.5) < 1e-6, `应 ≈0.5，实际 ${c.integrate(1000)}`);
    });
  });

  describe('wave-spawner · entry.count', () => {
    test('⚠️ count=Infinity 必须抛错，不能卡死', () => {
      /**
       * 【修复前实测】退出码 124（卡死），且卡死前先吃光内存——
       * 每次 push 都往 `_pending` 塞一个常驻对象。
       */
      const ws = new WaveSpawner({
        waves: [{ id: 'w', entries: [{ id: 'e', count: Infinity }] }],
        spawn: { spawn: () => null, despawn: () => {} } as never,
      });
      throws(() => ws.start(), '必须是有限数值');
    });
  });

  describe('noise · octaves 与 heightMap 尺寸', () => {
    test('⚠️ octaves=Infinity 必须抛错（否则静默返回 0，地形变平坦）', () => {
      /**
       * 【修复前实测】`fbm(0, 0, Infinity)` 静默返回 0——不是卡死而是**结果错误**：
       * 频率不断翻倍、振幅衰减到 0，地形一片平坦。
       * 不报错、不崩溃，排查时会去查种子、查 scale，没人想到 octaves。
       */
      const n = new Noise(1);
      throws(() => n.fbm(0, 0, Infinity), '必须是有限数值');
      throws(() => n.fbm01(0, 0, Infinity), '必须是有限数值');
    });

    test('⚠️ heightMap 尺寸必须有限（原：引擎级报错，无业务语义）', () => {
      /**
       * 【修复前实测】`heightMap(Infinity, 4, 0.1)` 抛
       * `Invalid typed array length: Infinity`——引擎级报错，
       * 虽然拦住了，但**信息里没有业务语义**，
       * 排查时不知道是哪个地形生成调用、哪个参数错了。
       */
      const n = new Noise(1);
      throws(() => n.heightMap(Infinity, 4, 0.1, {}), 'heightMap.width');
    });

    test('⚠️ 单个值合法但乘积失控时也要拦（1e6×1e6 会申请 8TB）', () => {
      const n = new Noise(1);
      throws(() => n.heightMap(1e6, 1e6, 0.1, {}), '超过上限');
    });

    test('正常地形生成不受影响', () => {
      const n = new Noise(1);
      eq(n.heightMap(4, 4, 0.1, {}).length, 16);
    });
  });

  // ============================================================
  // 模式 C · 角度死循环
  // ============================================================

  describe('perception · 朝向角归一化', () => {
    test('⚠️ facing=Infinity 时 tick 必须返回，不能卡死', () => {
      /**
       * 【修复前实测】`timeout 8` 退出码 124。
       * 原实现 `while (diff > Math.PI) diff -= Math.PI * 2;`，
       * `Infinity - 2π` 仍等于 `Infinity`，条件恒真。
       *
       * facing 通常来自 `Math.atan2` 或外部传入的朝向角，
       * 上游一旦产生 NaN/Infinity，这里就是进程级卡死。
       */
      const ps = new PerceptionSystem({ los: OpenLineOfSight });
      ps.addPerceiver(1, { sightRange: 100, sightHalfAngle: 1 }, 0, 0, Infinity);
      ps.addTarget(2, 5, 0);
      ps.tick(0.016);
      assert(true, '能执行到这里就说明没卡死');
    });

    test('正常感知不受影响', () => {
      const ps = new PerceptionSystem({ los: OpenLineOfSight });
      ps.addPerceiver(1, { sightRange: 100, sightHalfAngle: Math.PI }, 0, 0, 0);
      ps.addTarget(2, 5, 0);
      ps.tick(0.016);
      /**
       * 【为什么不断言 isAware】
       * `isAware` 要求 `alert >= awareThreshold`（默认 1），
       * 而单帧只累加 `visibility * gain * dt`（0.016）。
       * 这里要验证的是"感知链路没被守卫误伤"，
       * 所以看 alert 是否开始上涨即可。
       */
      assert(ps.alertOf(1) > 0, `正前方目标应开始累积警觉，实际 ${ps.alertOf(1)}`);
    });
  });

  describe('indicator · snapAngle', () => {
    test('⚠️ 角度为 Infinity 时返回确定值，不能卡死也不能返回 NaN', () => {
      /**
       * 【修复前实测】退出码 124（卡死）。
       * 原实现 `while (diff > 180) diff -= 360;`，`Infinity - 360` 仍是 Infinity。
       *
       * 【注意】改用度版 `angleDiff` 会返回 NaN（`Infinity % 360` = NaN），
       * 所以这里走**弧度版 `angleDiffRad`**——只有它做了非有限值归一（→0）。
       */
      const r = snapAngle(Infinity, 0, 15);
      assert(Number.isFinite(r), `必须是有限数，实际 ${r}`);
    });

    test('正常角度钳制不受影响', () => {
      eq(snapAngle(100, 0, 15), 15, '超出偏差上限应被钳到 15');
      eq(snapAngle(-100, 0, 15), -15, '负方向同理');
      eq(snapAngle(5, 0, 15), 5, '偏差内原样返回');
    });
  });

  describe('minimap · normalizeAngle', () => {
    test('⚠️ Infinity 归一到 0，不再返回 NaN', () => {
      /**
       * 【修复前实测】`normalizeAngle(Infinity)` → NaN。
       * 该值直接进小地图图标的 `rotation`，
       * NaN 旋转在渲染层表现为"图标消失"或"朝向乱转"，
       * 且不报错——玩家只会觉得小地图有问题。
       */
      const r = normalizeAngle(Infinity);
      assert(Number.isFinite(r), `必须是有限数，实际 ${r}`);
    });

    test('正常角度不受影响', () => {
      const r = normalizeAngle(5);
      assert(r >= -Math.PI && r <= Math.PI, `应落在 [-π, π]，实际 ${r}`);
    });
  });

  // ============================================================
  // steering · 零质量
  // ============================================================

  describe('steering · agent 质量', () => {
    test('⚠️ mass=0 必须抛错（否则位置/速度永久变 NaN）', () => {
      /**
       * 【修复前实测】`createAgent(..., { mass: 0 })` 后 `integrate()`，
       * 位置与速度全部变 **NaN**（JSON 里显示为 null）。
       *
       * 链路：`ax = force.x / mass` → `0/0 = NaN` 或 `x/0 = Infinity`，
       * 一旦 NaN 进入 `vel`，`pos += vel * dt` 永久是 NaN；
       * 而 `integrate` 里的 `speed > limit && speed > 1e-9` 对 NaN 恒为 false，
       * **限速也救不回来**。表现为"某个单位突然消失"。
       *
       * 质量常被用来表达"无敌/不可推动"，0 是很容易写出的值。
       */
      throws(() => createAgent(v2(), v2(), { mass: 0 }), '必须为正');
    });

    test('⚠️ mass 为负数同样要拦', () => {
      throws(() => createAgent(v2(), v2(), { mass: -1 }), '必须为正');
    });

    test('正常 agent 不受影响', () => {
      const a = createAgent(v2(), v2(), { mass: 2 });
      integrate(a, 0.016);
      assert(Number.isFinite(a.pos.x) && Number.isFinite(a.pos.y), '位置应为有限数');
    });
  });
}
