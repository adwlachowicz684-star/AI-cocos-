/**
 * 异常数值穿透 · 批次 5（Math.max / Math.min 系统性收口）
 *
 * 【这批修的是什么】
 *
 * 全库有大量 `Math.max(1, opts.capacity ?? 100)` 这种"给配置项兜底"的写法。
 * 它看起来安全，其实有两处洞：
 *
 * ```
 * Math.max(1, NaN)       === NaN       // `??` 只挡 nullish，挡不住 NaN
 * Math.max(1, Infinity)  === Infinity  // 没有上界
 * ```
 *
 * 对"容量/上限"类字段（limit / capacity / bufferSize），
 * NaN 或 Infinity 会让裁剪判定 `length > NaN` 恒为 false，
 * 于是**集合永不裁剪，内存随操作次数无限增长**。
 *
 * 【clampNum 的真实语义（我第一版测试就在这里搞错了）】
 *
 * ```
 * clampNum(NaN,       1, 1e7, 100) === 100      // 非有限 → 回退 fallback
 * clampNum(Infinity,  1, 1e7, 100) === 100      // 同上，不是 1e7！
 * clampNum(1e9,       1, 1e7, 100) === 1e7      // 有限但超界 → 截断到上界
 * clampNum(-5,        1, 1e7, 100) === 1        // 下界
 * ```
 *
 * 也就是说 **Infinity 走的是 fallback 而不是截断**——这设计是对的
 * （Infinity 是荒谬输入，回退默认比截断到 1e7 更保守），
 * 但意味着"上界只在'有限但超界'时才起作用"。
 * A1 / A2 两组分别覆盖这两条路径。
 *
 * 【为什么分成两种写法】
 *
 * - 容量类   → `clampNum(v, min, max, fallback)`：有上界
 * - 普通配置 → `numOr(v, fallback)` + 原 `Math.max/min`：不设上界
 *
 * 第二种不能图省事也用 clampNum——给普通配置定上界会**误伤合法值**
 * （`transitionMs: 600_000` 是合法配置，被裁成 1e4 就是悄悄改掉用户意图）。
 * 所以 C 组专门测"大值不被误伤"，这是这批修复最容易做错的地方。
 *
 * 【本文件的坑：必须用共享框架】
 * 第一版我自己写了 `let passed = 0` 的局部计数器，
 * 结果 34 项测试全绿地跑完了，但总计数**纹丝不动**——
 * 等于"测试跑了，但没被统计进去"。必须用 `./_framework` 的 describe/test。
 */

import { describe, test, eq, assert } from './_framework';
import { maxOf, minOf } from '../_core/math';
import { Logger } from '../logger/Logger';
import { Leaderboard } from '../leaderboard/Leaderboard';
import { UndoStack } from '../snapshot/Snapshot';
import { CrashReporter } from '../crash/CrashReporter';
import { Expression } from '../expression/Expression';
import { Telemetry } from '../telemetry/Telemetry';
import { DebugConsole } from '../debug-console/DebugConsole';
import { ReportCenter } from '../social/Report';
import { ProgressBar } from '../progressbar/ProgressBar';
import { Cooldown } from '../skill-player/Cooldown';
import { Track } from '../skill-player/Track';
import { CameraFollow } from '../camera/CameraFollow';
import { TargetSelector } from '../targeting/TargetSelector';
import { BgmStack } from '../audio/BGMStack';

/** 断言值是有限数——NaN / ±Infinity 都算失败 */
function finite(v: number, msg = ''): void {
  assert(Number.isFinite(v), `${msg} 应为有限值，实际 ${v}`);
}

/**
 * BgmStack 的最小合法配置。
 *
 * 【为什么要单独抽出来】
 * 它的构造强制要求 layers 非空、initialState 必须在 states 里，
 * 直接写在测试里会掩盖真正要断言的东西（transitionMs）。
 */
function makeBgm(extra: Record<string, unknown>): BgmStack {
  return new BgmStack({
    layers: [{ name: 'drums' }],
    states: { explore: { drums: 1 } },
    initialState: 'explore',
    ...extra,
  } as any);
}

export function runNumGuardTests(): void {
  // ══════════════════════════════════════════════════════════
  // A1 组：非有限值（NaN / ±Infinity）→ 回退默认
  //
  // 这是"永不裁剪"的主路径：limit 变 NaN 后 `length > NaN` 恒为 false。
  // ══════════════════════════════════════════════════════════
  describe('A1 组：容量类非有限值回退默认', () => {
    test('leaderboard capacity=Infinity → 100', () => {
      const lb = new Leaderboard({ capacity: Infinity } as any);
      eq((lb as any)._capacity, 100, 'capacity 应回退默认');
    });

    test('leaderboard capacity=NaN → 100', () => {
      const lb = new Leaderboard({ capacity: NaN } as any);
      eq((lb as any)._capacity, 100, 'capacity 应回退默认');
    });

    test('logger bufferSize=Infinity → 200', () => {
      const lg = new Logger({ bufferSize: Infinity } as any);
      eq((lg as any)._bufferSize, 200, 'bufferSize 应回退默认');
    });

    test('snapshot limit=Infinity → 50', () => {
      const st = new UndoStack({ limit: Infinity } as any);
      eq((st as any)._limit, 50, 'limit 应回退默认');
    });

    test('crash breadcrumbLimit=Infinity → 30', () => {
      const cr = new CrashReporter({ breadcrumbLimit: Infinity } as any);
      eq((cr as any)._ring._limit, 30, 'breadcrumbLimit 应回退默认');
    });

    test('expression maxDepth=Infinity → 有限值', () => {
      const ex = new Expression('1+1', { maxDepth: Infinity } as any);
      finite((ex as any)._maxDepth, 'maxDepth');
    });

    test('telemetry batchSize / maxBuffer 三种异常值都有限', () => {
      for (const bad of [NaN, Infinity, -Infinity]) {
        const tm = new Telemetry({ batchSize: bad, maxBuffer: bad } as any);
        finite((tm as any)._batchSize, `batchSize=${bad}`);
        finite((tm as any)._maxBuffer, `maxBuffer=${bad}`);
      }
    });

    test('debug-console historyLimit=Infinity → 100', () => {
      const dc = new DebugConsole({ historyLimit: Infinity, enabled: false } as any);
      eq((dc as any)._historyLimit, 100, 'historyLimit 应回退默认');
    });

    test('social maxTickets=Infinity → 有限值', () => {
      const rc = new ReportCenter({ maxTickets: Infinity } as any);
      finite((rc as any)._maxTickets, 'maxTickets');
    });

    test('progressbar segments=Infinity → 有限值', () => {
      const pb = new ProgressBar({ segments: Infinity } as any);
      finite((pb as any)._segments, 'segments');
    });
  });

  // ══════════════════════════════════════════════════════════
  // A2 组：**有限但超界**的值 → 截断到上界
  //
  // 【为什么 A1 之外还要 A2】
  // Infinity 走 fallback，上界这条路径只有"有限但超界"才会走到。
  // 只测 A1 的话，把上界删掉测试照样全绿——那上界就成了没被验证的代码。
  // ══════════════════════════════════════════════════════════
  describe('A2 组：容量类有限超界值被截断到上界', () => {
    test('leaderboard capacity=1e9 → 1e7', () => {
      const lb = new Leaderboard({ capacity: 1e9 } as any);
      eq((lb as any)._capacity, 1e7, 'capacity 应截断到上界');
    });

    test('logger bufferSize=1e9 → 1e6', () => {
      const lg = new Logger({ bufferSize: 1e9 } as any);
      eq((lg as any)._bufferSize, 1e6, 'bufferSize 应截断到上界');
    });

    test('snapshot limit=1e9 → 1e6', () => {
      const st = new UndoStack({ limit: 1e9 } as any);
      eq((st as any)._limit, 1e6, 'limit 应截断到上界');
    });

    test('telemetry batchSize=1e9 → 1e6', () => {
      const tm = new Telemetry({ batchSize: 1e9 } as any);
      eq((tm as any)._batchSize, 1e6, 'batchSize 应截断到上界');
    });

    test('capacity=1e9 时不会真去分配 1e9 条', () => {
      // 光看字段值不够——要确认上界真的挡住了"荒谬的大但有限"的值。
      const lb = new Leaderboard({ capacity: 1e9 } as any);
      assert((lb as any)._capacity <= 1e7, `上界应生效，实际 ${(lb as any)._capacity}`);
    });
  });

  // ══════════════════════════════════════════════════════════
  // B 组：普通配置类 —— NaN 回退默认
  // ══════════════════════════════════════════════════════════
  describe('B 组：普通配置类 NaN 回退默认', () => {
    test('camera smoothTime=NaN → 有限值', () => {
      const cf = new CameraFollow({ smoothTime: NaN } as any);
      finite((cf as any)._smoothTime, 'smoothTime');
    });

    test('targeting maxRange=NaN → 0', () => {
      const ts = new TargetSelector({ maxRange: NaN } as any);
      eq((ts as any)._maxRange, 0, 'maxRange 应回退默认');
    });

    test('track duration=NaN → 0（必填项，无 ?? 兜底）', () => {
      const tk = new Track({ duration: NaN, events: [] } as any);
      eq((tk as any).duration, 0, 'duration 应回退 0');
    });

    test('cooldown duration=NaN → 0.0001（不卡死技能）', () => {
      const cd = new Cooldown({ duration: NaN } as any);
      eq((cd as any).duration, 0.0001, 'duration 应回退下界值');
    });

    test('bgm transitionMs=NaN → 800', () => {
      const b = makeBgm({ transitionMs: NaN });
      eq((b as any)._transitionMs, 800, 'transitionMs 应回退默认');
    });
  });

  // ══════════════════════════════════════════════════════════
  // C 组：**大值不被误伤**——这批修复最容易做错的地方
  //
  // 【为什么必须测】
  // 如果图省事给普通配置也定上界（比如统一 clampNum(v, min, 1e4, def)），
  // 合法的大配置就会被悄悄裁掉，且**没有任何报错**：
  // 用户写了 10 分钟的切换，实际只跑 10 秒，还以为自己配置错了。
  // 这比 NaN 穿透更隐蔽——NaN 至少能被断言抓到。
  // ══════════════════════════════════════════════════════════
  describe('C 组：普通配置类大值不被误伤', () => {
    test('bgm transitionMs=600000 原样保留（10 分钟切换合法）', () => {
      const b = makeBgm({ transitionMs: 600_000 });
      eq((b as any)._transitionMs, 600_000, 'transitionMs 不应被上界裁掉');
    });

    test('targeting maxRange=1e6 原样保留（大地图合法）', () => {
      const ts = new TargetSelector({ maxRange: 1e6 } as any);
      eq((ts as any)._maxRange, 1e6, 'maxRange 不应被裁');
    });

    test('camera smoothTime=10 原样保留', () => {
      const cf = new CameraFollow({ smoothTime: 10 } as any);
      eq((cf as any)._smoothTime, 10, 'smoothTime 不应被裁');
    });

    test('track duration=5000 原样保留', () => {
      const tk = new Track({ duration: 5000, events: [] } as any);
      eq((tk as any).duration, 5000, 'duration 不应被裁');
    });
  });

  // ══════════════════════════════════════════════════════════
  // D 组：正常值不受影响（防止改坏）
  // ══════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════
  // E 组：maxOf / minOf —— 空数组返回 fallback，而不是 ±Infinity
  //
  // 这是批次 5 的**第二类**问题，与 A-D 组的"容量字段上界"无关：
  // `Math.max(...[])` 返回 `-Infinity`，`Math.min(...[])` 返回 `Infinity`。
  //
  // 危险的不是这个返回值本身，而是它**参与运算时完全安静**：
  //   `maxWaitMs = -Infinity` → `if (maxWaitMs > 阈值)` 恒 false
  //   → "等待超时"逻辑永远不触发，没人会想到源头是空数组。
  // ══════════════════════════════════════════════════════════
  describe('E 组：maxOf / minOf 空数组返回 fallback', () => {
    test('E1 空数组不再返回 ±Infinity', () => {
      eq(maxOf([]), 0, 'maxOf([]) 应为 fallback 0，不是 -Infinity');
      eq(minOf([]), 0, 'minOf([]) 应为 fallback 0，不是 Infinity');
      // 对照组：确认原生行为确实是 ±Infinity（否则这条测试没有意义）
      eq(Math.max(...[]), -Infinity, '对照：Math.max(...[]) 确实是 -Infinity');
      eq(Math.min(...[]), Infinity, '对照：Math.min(...[]) 确实是 Infinity');
    });

    test('E2 fallback 可自定义', () => {
      eq(maxOf([], 99), 99, '空数组应返回指定的 fallback');
      eq(minOf([], -1), -1, '空数组应返回指定的 fallback');
    });

    test('E3 非空数组取正确极值', () => {
      eq(maxOf([1, 5, 3]), 5, 'maxOf 应返回最大值');
      eq(minOf([1, 5, 3]), 1, 'minOf 应返回最小值');
      eq(maxOf([-2, -7]), -2, '全负数时取最接近零的');
      eq(minOf([-2, -7]), -7, '全负数时取最小');
    });

    test('E4 场景对照：maxWaitMs 不再让超时判定失效', () => {
      const waits: number[] = [];
      const maxWaitMs = maxOf(waits, 0);
      // 修复前：Math.max(...[]) = -Infinity → 下面的判定恒为 false
      // 修复后：0 → 判定正常（0 > 5000 是 false，但这是"没有等待"的正确语义）
      assert(
        Number.isFinite(maxWaitMs),
        `maxWaitMs 应有限，实际 ${maxWaitMs}（-Infinity 会让所有比较静默失效）`
      );
    });
  });

  // ══════════════════════════════════════════════════════════
  // F 组：大数组不栈溢出
  //
  // `Math.max(...xs)` 是 `f(a,b,c,...)`，参数个数受调用栈限制。
  // 实测 200 万项直接 RangeError。排行榜 / 热度图很容易到这个量级。
  // ══════════════════════════════════════════════════════════
  describe('F 组：大数组不栈溢出（展开会 RangeError）', () => {
    test('F1 百万级数组正常求值', () => {
      const n = 1_000_000;
      const xs = new Array<number>(n).fill(1);
      xs[12345] = 42;
      eq(maxOf(xs), 42, '百万级数组应能正常求最大值');

      const ys = new Array<number>(n).fill(9);
      ys[999] = -3;
      eq(minOf(ys), -3, '百万级数组应能正常求最小值');
    });

    test('F2 对照组：同规模展开确实会抛 RangeError', () => {
      // 【为什么要这条对照】
      // 不证明"旧写法在这里会挂"，F1 的通过就没有意义——
      // 它可能只是"这个规模本来就不会溢出"。
      const xs = new Array<number>(2_000_000).fill(1);
      let threw = false;
      try {
        // eslint-disable-next-line prefer-spread
        Math.max.apply(null, xs as any);
      } catch (e) {
        threw = true;
      }
      assert(threw, '对照：200 万项用 apply/max 展开应抛 RangeError');
    });
  });

  // ══════════════════════════════════════════════════════════
  // G 组：NaN 语义与 Math.max 保持一致（刻意不静默跳过）
  //
  // 循环里 `if (x > m)` 天然跳过 NaN，要"跳过"只要不管就行。
  // 但那是静默掩盖数据损坏——某个玩家 rating 是 NaN 时，
  // 拿到"剩余玩家最高分"看起来完全正常，坏数据被吞掉。
  //
  // 所以这里刻意保持传染语义，让错误继续可见。
  // ══════════════════════════════════════════════════════════
  describe('G 组：NaN 保持传染，不静默跳过', () => {
    test('G1 与 Math.max / Math.min 行为一致', () => {
      // 【为什么不能用 eq(NaN, NaN)】
      // NaN !== NaN 是 IEEE-754 的定义，框架的 eq 用严格相等，
      // 所以 eq(NaN, NaN) **恒为失败**——这条测试会永远红着，
      // 而失败信息是"期望 null 实际 null"，看不出任何线索。
      // 断言 NaN 必须用 Number.isNaN。
      assert(Number.isNaN(maxOf([1, NaN, 3])), 'maxOf 遇 NaN 应返回 NaN（与 Math.max 一致）');
      assert(Number.isNaN(minOf([1, NaN, 3])), 'minOf 遇 NaN 应返回 NaN（与 Math.min 一致）');
      // 对照组：确认原生 Math.max 也是这个语义
      assert(Number.isNaN(Math.max(1, NaN, 3)), '对照：Math.max 确实返回 NaN');
    });

    test('G2 全 NaN 数组也返回 NaN', () => {
      assert(Number.isNaN(maxOf([NaN, NaN])), '全 NaN 应返回 NaN');
    });
  });

  // ══════════════════════════════════════════════════════════
  // H 组：Expression 内建函数——非有限结果直接抛错
  //
  // `max()` 无参数返回 -Infinity，`abs()` 缺参数返回 NaN。
  // 策划在配置表里少写一个参数，症状是一小时后"某个分支永远不走"。
  // 所以在出口拦掉，把问题钉在写错的表达式上。
  // ══════════════════════════════════════════════════════════
  describe('H 组：Expression 非有限结果抛错', () => {
    /** 求值，返回 {ok, value|msg} */
    const ev = (src: string, vars: Record<string, number> = {}) => {
      try {
        return { ok: true as const, value: new Expression(src).evaluate(vars) };
      } catch (e) {
        return { ok: false as const, msg: (e as Error).message };
      }
    };

    test('H1 max() / min() 空参数抛错而不是返回 ±Infinity', () => {
      const a = ev('max()');
      assert(!a.ok, `max() 应抛错，实际返回 ${a.ok ? a.value : ''}`);
      assert(a.ok || /不是有限数/.test(a.msg), '错误信息应说明"不是有限数"');

      const b = ev('min()');
      assert(!b.ok, `min() 应抛错，实际返回 ${b.ok ? b.value : ''}`);
    });

    test('H2 缺参数的一元函数抛错（原返回 NaN）', () => {
      for (const src of ['abs()', 'floor()', 'sqrt()']) {
        const r = ev(src);
        assert(!r.ok, `${src} 应抛错，实际返回 ${r.ok ? r.value : ''}`);
      }
    });

    test('H3 sqrt 负数抛错（原返回 NaN）', () => {
      const r = ev('sqrt(-1)');
      assert(!r.ok, 'sqrt(-1) 应抛错，原实现返回 NaN');
    });

    test('H4 正常调用不受影响（防止矫枉过正）', () => {
      eq(ev('max(1,2)').value!, 2, 'max(1,2) 应正常');
      eq(ev('min(5,3)').value!, 3, 'min(5,3) 应正常');
      eq(ev('abs(-3)').value!, 3, 'abs(-3) 应正常');
      // 【注意】必须显式传 vars，否则变量求值为 0 ——
      // 第一版漏传，得到 0 而不是 20，差点被当成实现 bug。
      eq(ev('max(a,b)', { a: 10, b: 20 }).value!, 20, 'max(a,b) 应正常取变量');
      eq(ev('1 + 2 * 3').value!, 7, '纯算术表达式不受影响');
    });
  });

  describe('D 组：正常值不受影响', () => {
    test('leaderboard capacity=50 原样保留', () => {
      const lb = new Leaderboard({ capacity: 50 } as any);
      eq((lb as any)._capacity, 50);
    });

    test('logger bufferSize=10 原样保留', () => {
      const lg = new Logger({ bufferSize: 10 } as any);
      eq((lg as any)._bufferSize, 10);
    });

    test('leaderboard 不传 capacity → 默认 100', () => {
      const lb = new Leaderboard({});
      eq((lb as any)._capacity, 100);
    });

    test('logger 不传 bufferSize → 默认 200', () => {
      const lg = new Logger({});
      eq((lg as any)._bufferSize, 200);
    });

    test('容量字段下界仍生效（capacity=-5 → 1）', () => {
      const lb = new Leaderboard({ capacity: -5 } as any);
      eq((lb as any)._capacity, 1, '下界裁剪应保留');
    });

    test('容量字段 0 被下界兜住（bufferSize=0 → 1）', () => {
      const lg = new Logger({ bufferSize: 0 } as any);
      eq((lg as any)._bufferSize, 1, '下界裁剪应保留');
    });

    test('cooldown duration=2.5 原样保留', () => {
      const cd = new Cooldown({ duration: 2.5 } as any);
      eq((cd as any).duration, 2.5);
    });

    test('cooldown charges=3 原样保留', () => {
      const cd = new Cooldown({ duration: 1, charges: 3 } as any);
      eq((cd as any).maxCharges, 3);
    });
  });
}
