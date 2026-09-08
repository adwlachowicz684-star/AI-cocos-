/**
 * tests/run_phase10_w6a.ts —— 第二次精审 273 条 · 窗口 W6-A 回归
 *
 * 【本窗口覆盖】3 个单元 / 13 条（P1 11 · P2 2）
 *
 * | 编号 | 单元 | 条目 |
 * |---|---|---|
 * | W6A-01 | di | `register({override:true})` 覆盖后旧单例不会被 destroy |
 * | W6A-02 | di | `fork()` 不复制 disposers，子容器销毁时一个都不销毁 |
 * | W6A-03 | di | `disposable()` 配 `lifetime:'transient'` 时永不销毁 |
 * | W6A-04 | noise | 非有限 seed 静默退化为 seed 0 |
 * | W6A-05 | noise | `fbm2D` / `ridged2D` 的 `octaves=Infinity` 死循环 |
 * | W6A-06 | noise | `octaves=NaN/-1`、`lacunarity=0` 无校验，静默返回 0 |
 * | W6A-07 | noise | `islandMask(1, 1)` 返回 NaN |
 * | W6A-08 | timeutil | `isNewDay` 按参数名传时间戳永远返回 false |
 * | W6A-09 | timeutil | `Countdown.pause()` 后 `state()` 仍返回 `'running'` |
 * | W6A-10 | timeutil | `ticksSince(periodMs = NaN)` 返回 NaN |
 * | W6A-11 | timeutil | 固定 `offsetMinutes` 无法表达夏令时 |
 * | W6A-12 | di | `destroy()` 里的 `console.error`（P2） |
 * | W6A-13 | noise | `noise3D` 伪 3D 与魔法数 / `PerlinNoise` 无人使用（P2） |
 *
 * 【每条的两条用例】
 * - `⚠️` 前缀 = 回归用例：喂的是**能触发缺陷的输入**，修复前必然失败
 * - `✓` 前缀 = 对照用例：喂的是**合法输入**，验证修复没有矫枉过正
 *
 * 【W6A-05 的特殊说明】
 * 复现时发现"octaves=Infinity 死循环"在当前基线上**已不成立**——
 * `needCount` 会先抛 TypeError。本文件保留的是"不再挂起"的证据用例，
 * 作为回归护栏：将来谁把 `needCount` 换成 `?? 4`，这条会立刻变红。
 */

import { describe, test, assert, eq, throws } from './_framework';

import { DIContainer } from '../di/DIContainer';
import {
  PerlinNoise,
  SimplexNoise,
  ValueNoise,
  WorleyNoise,
  Noise,
  fbm2D,
  ridged2D,
  islandMask,
} from '../noise/Noise';
import {
  DAY_MS,
  Zones,
  Countdown,
  dayIndex,
  isNewDay,
  startOfDay,
  ticksSince,
} from '../timeutil/TimeUtil';

export function runPhase10W6ATests(): void {
  // ============================================================
  // di
  // ============================================================

  describe('di · 覆盖注册必须先销毁旧实例（W6A-01）', () => {
    test('⚠️ override 覆盖后，旧实例的 destroy 也要被调用', () => {
      let n = 0;
      const c = new DIContainer();
      c.disposable('a', () => ({ destroy() { n += 1; } }));
      c.get('a');
      // 覆盖注册：旧实例 +1，新实例 +10
      c.disposable('a', () => ({ destroy() { n += 10; } }), { override: true });
      c.get('a');
      c.destroy();
      // 修复前：n === 10 —— 销毁函数按注册顺序存在数组里，
      // 销毁时按 key 取到的是覆盖后的新实例，旧实例的 +1 从未发生
      eq(n, 11, '旧实例(+1)与新实例(+10)都应被销毁：');
    });

    test('✓ 不覆盖时重复注册仍然抛错（防止矫枉过正）', () => {
      const c = new DIContainer();
      c.disposable('a', () => ({ destroy() { /* noop */ } }));
      throws(() => c.register('a', () => 1), '已注册', '未传 override 时应拒绝重复注册：');
    });

    test('✓ 只注册一次的 normal 服务仍只销毁一次', () => {
      let n = 0;
      const c = new DIContainer();
      c.disposable('svc', () => ({ destroy() { n += 1; } }));
      c.get('svc');
      c.get('svc');   // singleton：不会重复创建
      eq(c.destroy().length, 0, '正常销毁不应收集到错误：');
      eq(n, 1, '单例只应销毁一次：');
    });
  });

  describe('di · fork 要继承销毁责任（W6A-02）', () => {
    test('⚠️ 子容器销毁时，它现场创建的单例要被销毁', () => {
      let n = 0;
      const parent = new DIContainer();
      parent.disposable('svc', () => ({ destroy() { n += 1; } }));
      const child = parent.fork('child');
      child.get('svc');
      child.destroy();
      // 修复前：n === 0 —— fork 只复制了注册和单例，销毁函数一个都没带过来
      eq(n, 1, '子容器现场创建的单例应被销毁：');
    });

    test('✓ 销毁函数只作用于执行它的那个容器（不会误伤父容器）', () => {
      let parentN = 0;
      let childN = 0;
      const parent = new DIContainer();
      // 父容器只注册、从不解析 —— 它自己不持有实例
      parent.disposable('a', () => ({ destroy() { parentN += 1; } }));
      const child = parent.fork('child');
      child.disposable('b', () => ({ destroy() { childN += 1; } }));
      child.get('b');
      child.destroy();
      eq(childN, 1, '子容器自己注册的应被销毁：');
      eq(parentN, 0, '父容器没创建过的实例不该被销毁：');
      // 父容器仍然完好可用
      parent.get('a');
      parent.destroy();
      eq(parentN, 1, '父容器仍能销毁自己那个：');
    });

    test('✓ fork 仍然继承父容器的注册与单例（既有行为不变）', () => {
      const parent = new DIContainer();
      parent.value('answer', 42);
      const child = parent.fork('child');
      eq(child.get<number>('answer'), 42, '子容器应继承父注册：');
      eq(child.size, parent.size, '注册数量应一致：');
      parent.destroy();
    });
  });

  describe('di · disposable 与 transient 是无效组合（W6A-03）', () => {
    test('⚠️ disposable + transient 应直接拒绝注册，而不是静默失效', () => {
      const c = new DIContainer();
      // 修复前：这个组合被静默忽略（连销毁函数都不注册），
      // 调用方以为"临时对象也会被回收"，实际一个都不会被销毁
      throws(
        () => c.disposable('t', () => ({ destroy() { /* noop */ } }), { lifetime: 'transient' }),
        'transient',
        '容器不持有 transient 实例，应拒绝这个组合：'
      );
    });

    test('✓ disposable 保持默认 singleton 时行为不变', () => {
      let n = 0;
      const c = new DIContainer();
      c.disposable('svc', () => ({ destroy() { n += 1; } }));
      c.get('svc');
      c.destroy();
      eq(n, 1, '默认 singleton 仍应正常销毁：');
    });

    test('✓ 普通 transient 注册（非 disposable）不受影响', () => {
      const c = new DIContainer();
      let created = 0;
      c.register('x', () => ++created, { lifetime: 'transient' });
      c.get<number>('x');
      c.get<number>('x');
      eq(created, 2, 'transient 每次都应新建：');
      c.destroy();
    });
  });

  describe('di · 销毁失败不写 console.error（W6A-12 · P2）', () => {
    test('⚠️ 销毁抛错时不得调用 console.error，错误要回到返回值里', () => {
      const c = new DIContainer();
      c.disposable('bad', () => ({
        destroy() { throw new Error('boom'); },
      }));
      c.get('bad');

      const orig = console.error;
      const printed: string[] = [];
      console.error = (...a: unknown[]) => { printed.push(String(a[0])); };
      let errors: string[] = [];
      try {
        errors = c.destroy();
      } finally {
        console.error = orig;
      }
      // 修复前：printed.length === 1（"[DI] 销毁出错：Error: boom"），errors 概念不存在
      eq(printed.length, 0, '库里不应直接 console.error：');
      eq(errors.length, 1, '错误应收集进返回值：');
      assert(errors[0].includes('boom'), `错误信息应带原因，实际：${errors[0]}`);
      assert(errors[0].includes('bad'), `错误信息应带 key，实际：${errors[0]}`);
    });

    test('⚠️ 单个服务销毁失败不得中断其余服务的销毁', () => {
      let good = 0;
      const c = new DIContainer();
      c.disposable('good', () => ({ destroy() { good += 1; } }));
      c.disposable('bad', () => ({ destroy() { throw new Error('boom'); } }));
      c.get('good');
      c.get('bad');
      const errors = c.destroy();
      eq(good, 1, '前面的服务仍应被销毁：');
      eq(errors.length, 1, '只应有 1 条错误：');
    });

    test('✓ onDisposeError 钩子能收到 key 与原始错误', () => {
      const seen: string[] = [];
      const c = new DIContainer('root', {
        onDisposeError: (key) => { seen.push(key); },
      });
      c.disposable('bad', () => ({ destroy() { throw new Error('boom'); } }));
      c.get('bad');
      c.destroy();
      eq(seen.length, 1, '钩子应被调用一次：');
      eq(seen[0], 'bad', '钩子应收到出错的 key：');
    });

    test('✓ 全部正常时 destroy() 返回空数组', () => {
      const c = new DIContainer();
      c.disposable('a', () => ({ destroy() { /* noop */ } }));
      c.get('a');
      eq(c.destroy().length, 0, '无错误时应返回空数组：');
    });
  });

  // ============================================================
  // noise
  // ============================================================

  describe('noise · 非有限 seed 不得静默退化（W6A-04）', () => {
    test('⚠️ Noise(NaN) 应抛错，而不是塌成 seed 0', () => {
      // 修复前：new Noise(NaN).noise2(1.5,2.5) === new Noise(0).noise2(1.5,2.5) → true
      throws(() => new Noise(NaN), 'seed', 'NaN seed 应被拒绝：');
    });

    test('⚠️ SimplexNoise / ValueNoise / WorleyNoise / PerlinNoise 同样要拦', () => {
      throws(() => new SimplexNoise(Infinity), 'seed', 'Infinity seed 应被拒绝：');
      throws(() => new ValueNoise(NaN), 'seed', 'NaN seed 应被拒绝：');
      throws(() => new WorleyNoise(NaN), 'seed', 'NaN seed 应被拒绝：');
      throws(() => new PerlinNoise(NaN), 'seed', 'NaN seed 应被拒绝：');
    });

    test('✓ seed 0 与正常 seed 仍然可用（防止矫枉过正）', () => {
      const a = new Noise(0).noise2(1.5, 2.5);
      const b = new Noise(12345).noise2(1.5, 2.5);
      assert(Number.isFinite(a) && Number.isFinite(b), '正常 seed 应产出有限值：');
      assert(a !== b, '不同 seed 必须产出不同结果（确定性的核心承诺）：');
    });

    test('✓ 同 seed 仍然可复现', () => {
      eq(new Noise(7).fbm01(1.1, 2.2), new Noise(7).fbm01(1.1, 2.2), '同 seed 应完全一致：');
    });
  });

  describe('noise · octaves 不得导致死循环（W6A-05）', () => {
    test('⚠️ octaves=Infinity 必须立刻失败而不是挂起', () => {
      // 修复前（基线已修）的传说：静默返回 0 或死循环。
      // 现在 needCount 会抛错；这条用例守护的是"绝不进入循环"这件事。
      throws(
        () => fbm2D({ noise2D: () => 1 }, 1, 1, { octaves: Infinity }),
        'opts.octaves',
        'Infinity octaves 应被守卫拦下：'
      );
      throws(
        () => ridged2D({ noise2D: () => 1 }, 1, 1, { octaves: Infinity }),
        'opts.octaves',
        'ridged 同样要拦：'
      );
    });

    test('⚠️ octaves=NaN 也必须失败，不能让循环体一次都不执行', () => {
      // 修复前（若退回 `?? 4`）：循环 0 次 → maxValue = 0 → 静默返回 0（一整张平原）
      throws(() => fbm2D({ noise2D: () => 1 }, 1, 1, { octaves: NaN }), 'opts.octaves');
      throws(() => fbm2D({ noise2D: () => 1 }, 1, 1, { octaves: -1 }), 'opts.octaves');
    });

    test('✓ 合法 octaves 正常出值', () => {
      const v = fbm2D({ noise2D: () => 1 }, 1, 1, { octaves: 4 });
      assert(Number.isFinite(v), '合法 octaves 应产出有限值：');
    });
  });

  describe('noise · lacunarity / persistence 收口（W6A-06）', () => {
    // 用固定种子的真实噪声：常量噪声（() => 1）看不出"退化成重复采样"
    const noise = new SimplexNoise(20260902);

    test('⚠️ lacunarity=0 不得退化成"第二层起采样原点"', () => {
      // 修复前：frequency 逐层归零 → 后几层都在采样 noise2D(0, 0)
      const zero = fbm2D(noise, 3.7, 2.3, { octaves: 4, lacunarity: 0 });
      const one = fbm2D(noise, 3.7, 2.3, { octaves: 4, lacunarity: 1 });
      assert(
        Math.abs(zero - one) < 1e-12,
        `lacunarity=0 应被夹到下界 1，实际 ${zero} vs ${one}`
      );
    });

    test('⚠️ persistence=NaN 不得静默返回 0', () => {
      // 修复前：amplitude 变 NaN → maxValue 为 NaN → `maxValue > 0 ? ... : 0` 返回 0
      const v = fbm2D(noise, 3.7, 2.3, { octaves: 4, persistence: NaN });
      assert(Number.isFinite(v), `不应为 NaN，实际 ${v}`);
      assert(v !== 0, '不应静默退化成 0：');
    });

    test('⚠️ persistence 为负不得让 maxValue 翻负导致整图归零', () => {
      const v = fbm2D(noise, 3.7, 2.3, { octaves: 4, persistence: -3 });
      const p0 = fbm2D(noise, 3.7, 2.3, { octaves: 4, persistence: 0 });
      assert(Number.isFinite(v), `不应为 NaN，实际 ${v}`);
      assert(Math.abs(v - p0) < 1e-12, `负 persistence 应被夹到 0，实际 ${v} vs ${p0}`);
    });

    test('⚠️ ridged2D 的 lacunarity / persistence 同样收口', () => {
      const z = ridged2D(noise, 3.7, 2.3, { octaves: 4, lacunarity: 0 });
      const o = ridged2D(noise, 3.7, 2.3, { octaves: 4, lacunarity: 1 });
      assert(Math.abs(z - o) < 1e-12, `ridged lacunarity=0 应夹到 1，实际 ${z} vs ${o}`);
      const p = ridged2D(noise, 3.7, 2.3, { octaves: 4, persistence: NaN });
      assert(Number.isFinite(p), `ridged persistence=NaN 应有限，实际 ${p}`);
    });

    test('✓ 合法区间内的 lacunarity 仍然生效（防止矫枉过正）', () => {
      const a = fbm2D(noise, 1.1, 2.2, { octaves: 4, lacunarity: 1.5 });
      const b = fbm2D(noise, 1.1, 2.2, { octaves: 4, lacunarity: 3.5 });
      assert(a !== b, '合法 lacunarity 应产生不同结果，不能被夹成同一个：');
    });

    test('✓ persistence 的合法边界 0 与 1 都未被误伤', () => {
      const p0 = fbm2D(noise, 3.7, 2.3, { octaves: 4, persistence: 0 });
      const p1 = fbm2D(noise, 3.7, 2.3, { octaves: 4, persistence: 1 });
      assert(Number.isFinite(p0) && Number.isFinite(p1), '边界值都应有限：');
      // persistence=0 → 只有第一层有振幅，结果就是单层噪声本身
      const single = noise.noise2D(3.7, 2.3);
      assert(Math.abs(p0 - single) < 1e-12, `persistence=0 应等于单层噪声，实际 ${p0}`);
      assert(p1 !== p0, 'persistence=1 不应等于 0：');
    });
  });

  describe('noise · islandMask 边界尺寸（W6A-07）', () => {
    test('⚠️ islandMask(1, 1) 不得返回 NaN', () => {
      // 修复前：cx = (1-1)/2 = 0 → (x-cx)/cx = 0/0 = NaN → Math.min(1, NaN) = NaN
      const m = islandMask(1, 1);
      eq(m.length, 1, '长度应为 1：');
      assert(Number.isFinite(m[0]), `不得为 NaN，实际 ${m[0]}`);
    });

    test('⚠️ 只有一边为 1 时同样不能 NaN', () => {
      assert(Number.isFinite(islandMask(1, 5)[0]), '1×5 不应为 NaN：');
      assert(Number.isFinite(islandMask(5, 1)[0]), '5×1 不应为 NaN：');
    });

    test('✓ 正常尺寸的 mask 语义不变（中心 1、边角 0）', () => {
      const m = islandMask(3, 3);
      assert(Math.abs(m[4] - 1) < 1e-12, `中心应为 1，实际 ${m[4]}`);
      eq(m[0], 0, '左上角应为 0：');
      eq(m[8], 0, '右下角应为 0：');
    });

    /**
     * 【⚠️ 这组 golden 值是本条修复"返工"的直接原因，务必保留】
     *
     * 第一版修法写成 `Math.max(1, (width - 1) / 2)`，把 2×N 的中心从 0.5 夹成了 1，
     * 于是 `islandMask(2,2)` 从全 0 变成 [0,0,0,1] —— 凭空多出一块"中心陆地"。
     * 而 2×N 修复前**并没有 NaN**，是我顺手改掉的既有行为。
     *
     * 原来的对照用例只测了 3×3（(3-1)/2 = 1，恰好不受 clamp 影响），
     * **覆盖不到 2×N**，所以当时全绿没抓到。
     * 这组值取自修复前的基线（commit d62db0f9），逐格锁死"正常尺寸不许变"。
     * 谁再把中心计算改成 clamp 到 1，这几条立刻变红。
     */
    test('✓ 2×N 的既有行为不得被改动（第一版修法在这里翻过车）', () => {
      const m = islandMask(2, 2);
      eq(m.length, 4, '2×2 应有 4 个值：');
      // 修复前基线值：全部为 0（中心距边缘只有半格，整张都算边缘）
      for (let i = 0; i < 4; i++) {
        eq(m[i], 0, `2×2 的第 ${i} 个值应为 0（旧实现全 0），实际 ${m[i]}`);
      }
    });

    test('✓ 2×3 / 3×2 同样不得被改动', () => {
      for (const [w, h] of [[2, 3], [3, 2]] as const) {
        const m = islandMask(w, h);
        for (let i = 0; i < m.length; i++) {
          eq(m[i], 0, `${w}×${h} 的第 ${i} 个值应为 0，实际 ${m[i]}`);
        }
      }
    });

    test('✓ 4×4 / 5×5 的 mask 逐格与修复前一致（golden）', () => {
      // 取自修复前基线 d62db0f9 的实测输出
      const golden4 = [
        0, 0, 0, 0,
        0, 0.279413, 0.279413, 0,
        0, 0.279413, 0.279413, 0,
        0, 0, 0, 0,
      ];
      const m4 = islandMask(4, 4);
      for (let i = 0; i < golden4.length; i++) {
        assert(
          Math.abs(m4[i] - golden4[i]) < 1e-6,
          `4×4 第 ${i} 个值应为 ${golden4[i]}，实际 ${m4[i]}`,
        );
      }

      const golden5 = [
        0, 0, 0, 0, 0,
        0, 0.085786, 0.25, 0.085786, 0,
        0, 0.25, 1, 0.25, 0,
        0, 0.085786, 0.25, 0.085786, 0,
        0, 0, 0, 0, 0,
      ];
      const m5 = islandMask(5, 5);
      for (let i = 0; i < golden5.length; i++) {
        assert(
          Math.abs(m5[i] - golden5[i]) < 1e-6,
          `5×5 第 ${i} 个值应为 ${golden5[i]}，实际 ${m5[i]}`,
        );
      }
    });

    test('✓ 尺寸为 1 时退化为"唯一的格子就是边缘"，而不是 NaN', () => {
      // cx = 0.5 → nx = (0-0.5)/0.5 = -1 → d = 1 → (1-1)^falloff = 0
      const m = islandMask(1, 1);
      assert(Number.isFinite(m[0]), `不得为 NaN，实际 ${m[0]}`);
      eq(m[0], 0, '1×1 唯一的格子应判为边缘（0）：');
      for (const v of islandMask(1, 5)) assert(Number.isFinite(v), '1×5 不得含 NaN：');
      for (const v of islandMask(5, 1)) assert(Number.isFinite(v), '5×1 不得含 NaN：');
    });
  });

  describe('noise · noise3D 的伪 3D 契约与常量（W6A-13 · P2）', () => {
    test('⚠️ 记录：noise3D 的 z 方向是切片插值，各向异性确实存在', () => {
      const s = new SimplexNoise(7);
      const alongX = Math.abs(s.noise3D(1.1, 0.2, 0) - s.noise3D(0.1, 0.2, 0));
      const alongZ = Math.abs(s.noise3D(0.1, 0.2, 1) - s.noise3D(0.1, 0.2, 0));
      // 这条断言锁的是"现象已被记录"：一旦换成真 3D 单纯形，这个不等式会失效，
      // 届时应当连注释一起更新，而不是悄悄让这条变红
      assert(
        alongZ > alongX,
        `伪 3D 的 z 方向变化(${alongZ}) 应明显大于 x 方向(${alongX})，注释中的各向异性说明才成立`
      );
    });

    test('✓ 整数 z 处仍精确等于对应切片（行为未因常量化而改变）', () => {
      const s = new SimplexNoise(11);
      // z 为整数时 fade(0) = 0，结果就是 iz 那一片
      eq(s.noise3D(0.3, 0.7, 2), s.noise2D(0.3, 0.7 + 2 * 37.7), '整数 z 应等于该切片：');
    });

    test('✓ PerlinNoise 仍可作为公开 API 使用，且与 Simplex 不同', () => {
      const p = new PerlinNoise(42).noise2D(1.5, 2.5);
      const s = new SimplexNoise(42).noise2D(1.5, 2.5);
      assert(Number.isFinite(p), 'PerlinNoise 应可用：');
      assert(p !== s, '两种噪声实现不应相同（共享梯度表但算法不同）：');
    });
  });

  // ============================================================
  // timeutil
  // ============================================================

  describe('timeutil · isNewDay 拒绝时间戳（W6A-08）', () => {
    const now = Date.UTC(2024, 0, 1, 12, 0, 0);

    test('⚠️ 传毫秒时间戳必须报错，不能静默返回 false', () => {
      // 修复前：isNewDay(now + DAY_MS, now) === false —— 隔了一整天却是 false，
      // 表现为每日任务 / 奖励 / 商店永不刷新
      throws(
        () => isNewDay(now + DAY_MS, now, Zones.CN),
        '日序号',
        '时间戳量级的第二个参数应被拒绝：'
      );
    });

    test('⚠️ 非有限值同样要拒绝（NaN 会让比较恒为 false）', () => {
      throws(() => isNewDay(now, NaN, Zones.CN), '有限数值', 'NaN 应被拒绝：');
    });

    test('✓ 传 dayIndex 的正确用法行为不变', () => {
      const today = dayIndex(now, Zones.CN);
      eq(isNewDay(now, today, Zones.CN), false, '同一天不算新：');
      eq(isNewDay(now + DAY_MS, today, Zones.CN), true, '第二天应为新：');
    });
  });

  describe('timeutil · Countdown 的暂停态（W6A-09）', () => {
    test('⚠️ pause() 之后 state() 应返回 paused', () => {
      const c = new Countdown(1000);
      c.start(0);
      c.pause(100);
      // 修复前：返回 'running' —— remaining() 已经冻结成 900，state() 却说还在跑
      eq(c.state(500), 'paused', '暂停中应返回 paused：');
      eq(c.remaining(500), 900, 'remaining 仍应冻结：');
    });

    test('✓ waiting / running / finished 三态语义不变', () => {
      eq(new Countdown(1000).state(0), 'waiting', '未开始：');
      const c = new Countdown(1000);
      c.start(0);
      eq(c.state(500), 'running', '进行中：');
      eq(c.state(1500), 'finished', '已结束：');
    });

    test('✓ resume() 之后回到 running', () => {
      const c = new Countdown(1000);
      c.start(0);
      c.pause(100);
      c.resume(1000);
      eq(c.state(1200), 'running', '恢复后应回到 running：');
      // pause 时冻结 900ms，resume 把终点推到 1000+900=1900，到 1200 时还剩 700
      eq(c.remaining(1200), 700, '剩余时间应接续：');
    });

    /**
     * 【`isPaused()` 是对家验收时建议补的，我认可并采纳】
     * `verify_W6-B.md` 第 3 节① 提出：加 `'paused'` 的同时应提供 `isPaused()`，
     * 让"只想判断暂停与否"的调用方不必为了一个布尔值去处理 switch 的四个分支。
     */
    test('✓ isPaused() 与 state() === paused 始终一致', () => {
      const c = new Countdown(1000);
      eq(c.isPaused(), false, '未开始时不是暂停：');
      c.start(0);
      eq(c.isPaused(), false, '进行中不是暂停：');
      c.pause(100);
      eq(c.isPaused(), true, '暂停中应为 true：');
      eq(c.state(500) === 'paused', c.isPaused(), '两者必须等价：');
      c.resume(1000);
      eq(c.isPaused(), false, '恢复后应回到 false：');
      c.reset();
      eq(c.isPaused(), false, 'reset 后应回到 false：');
    });

    test('✓ 暂停期间重复 pause 不改变剩余时间（幂等）', () => {
      const c = new Countdown(1000);
      c.start(0);
      c.pause(100);
      const first = c.remaining(500);
      c.pause(500); // 已在暂停态，应无效果
      eq(c.remaining(900), first, '重复 pause 不得改变冻结值：');
      eq(c.isPaused(), true, '仍处于暂停：');
    });
  });

  describe('timeutil · ticksSince 的 NaN 守卫（W6A-10）', () => {
    test('⚠️ periodMs = NaN 必须抛错，不能返回 NaN', () => {
      // 修复前：`periodMs <= 0` 对 NaN 恒为 false → 穿透 → Math.floor(x / NaN) = NaN
      throws(() => ticksSince(0, 1000, NaN), 'periodMs', 'NaN 周期应被拒绝：');
    });

    test('⚠️ 0 与负数仍然抛错（原行为保持）', () => {
      throws(() => ticksSince(0, 1000, 0), 'periodMs');
      throws(() => ticksSince(0, 1000, -5), 'periodMs');
    });

    test('✓ 正常周期与 maxTicks 夹紧行为不变', () => {
      eq(ticksSince(0, 1000, 300), 3, '正常周期：');
      eq(ticksSince(0, 1000, 300, 2), 2, 'maxTicks 仍应夹紧：');
      eq(ticksSince(1000, 0, 300), 0, '时间倒流仍不奖励：');
      eq(ticksSince(0, 1000, Infinity), 0, '无限周期 = 0 个 tick：');
    });
  });

  describe('timeutil · 夏令时时区的日界（W6A-11）', () => {
    test('⚠️ 洛杉矶夏令时期间的日界应按 PDT(UTC-7) 计算', () => {
      const summer = Date.UTC(2024, 6, 1, 5, 0, 0);   // 2024-07-01T05:00Z
      // 修复前：常量 -8 小时 → 2024-06-30T08:00Z（差 1 小时）
      eq(
        startOfDay(summer, Zones.US_PACIFIC),
        Date.UTC(2024, 5, 30, 7, 0, 0),
        'PDT 期间日界应为 07:00Z：'
      );
    });

    test('⚠️ 柏林夏令时期间的日界应按 CEST(UTC+2) 计算', () => {
      const summer = Date.UTC(2024, 6, 1, 5, 0, 0);
      eq(
        startOfDay(summer, Zones.EU_CENTRAL),
        Date.UTC(2024, 5, 30, 22, 0, 0),
        'CEST 期间日界应为 22:00Z：'
      );
    });

    test('✓ 冬季（标准时间）结果不变', () => {
      const winter = Date.UTC(2024, 0, 15, 5, 0, 0);
      eq(
        startOfDay(winter, Zones.US_PACIFIC),
        Date.UTC(2024, 0, 14, 8, 0, 0),
        'PST 期间日界仍应为 08:00Z：'
      );
    });

    test('✓ 无夏令时的时区结果完全不变（防止矫枉过正）', () => {
      const t = Date.UTC(2024, 5, 15, 10, 0, 0);
      eq(startOfDay(t, Zones.CN), Date.UTC(2024, 5, 14, 16, 0, 0), '东八区日界：');
      eq(startOfDay(t, Zones.UTC), Date.UTC(2024, 5, 15, 0, 0, 0), 'UTC 日界：');
      eq(dayIndex(t, Zones.CN), Math.floor((t + 8 * 3600_000) / DAY_MS), 'dayIndex 仍按偏移折算：');
    });
  });
}
