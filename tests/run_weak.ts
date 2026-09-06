/**
 * tests/run_weak.ts —— 补强"弱测"单元
 *
 * 【为什么需要这个文件】
 *
 * 全库 2977 项测试里，有些单元只有 2~5 项：
 *
 *   队形        2 项
 *   ValueNoise  3 项
 *   EntityIndex 3 项
 *   LazyHeap    4 项
 *   几何工具    4 项
 *   ...
 *
 * 2 项的测试**等于没测**——它只验证了"我构造的那一个例子"，
 * 换一组参数就可能崩。这些单元往往是"看起来简单"的，
 * 于是没人给它写测试，直到线上出问题。
 *
 * 本文件把这些单元补到 8~10 项，重点覆盖：
 *   ① 边界（0、负数、超界、除零）
 *   ② 守恒（总量不变、顺序无关）
 *   ③ 往返（A → B → A）
 *   ④ 幂等（重复调用结果一致）
 */

import { describe, test, assert, eq, near, throws } from './_framework';
import { formationOffset, circleFormation, v2, createAgent } from '../steering/Steering';
import { VisibilityMap } from '../fov/FOV';
import { SpatialHash } from '../ds/DataStructures';

// ============================================================
// 队形（原来只有 2 项）
// ============================================================

export function runWeakTests(): void {
  describe('队形 · formationOffset 网格', () => {
    test('⚠️ index 0 在第一行中央（不是左上角）', () => {
      const o = formationOffset(0, 10, 5);
      // columns=5 → (0 - 2) * 10 = -20，即偏左；第 0 行不错开
      near(o.x, -20, 1e-9, 'index 0 应在 -20');
      near(o.y, 0, 1e-9, '第 0 行 y 为 0');
    });

    test('奇数行错开半个身位（楔形，不是纯网格）', () => {
      const r0 = formationOffset(0, 10, 5); // 第 0 行
      const r1 = formationOffset(5, 10, 5); // 第 1 行
      near(r1.x - r0.x, 5, 1e-9, '奇数行应右移 spacing/2');
      near(r1.y, 10, 1e-9, '第 1 行 y 为 spacing');
    });

    test('⚠️ 同一行的相邻单位间距恰好是 spacing', () => {
      const spacing = 7.5;
      for (let i = 0; i < 4; i++) {
        const a = formationOffset(i, spacing, 5);
        const b = formationOffset(i + 1, spacing, 5);
        near(b.x - a.x, spacing, 1e-9, `第 ${i} 与 ${i + 1} 个间距`);
      }
    });

    test('整队围绕原点大致对称（不往一边偏）', () => {
      const n = 12;
      const cols = 4;
      let sumX = 0;
      for (let i = 0; i < n; i++) sumX += formationOffset(i, 10, cols).x;
      // 楔形每行错开半个身位，会略微右偏，但不该超过一个 spacing
      assert(Math.abs(sumX) < 10 * n * 0.3, `队伍重心偏移过大：${sumX}`);
    });

    test('⚠️ spacing = 0 时全部重叠在原点（不崩）', () => {
      for (let i = 0; i < 10; i++) {
        const o = formationOffset(i, 0, 5);
        near(o.x, 0, 1e-9);
        near(o.y, 0, 1e-9);
      }
    });

    test('⚠️ columns = 1 时是竖排（每人在一行）', () => {
      for (let i = 0; i < 5; i++) {
        const o = formationOffset(i, 10, 1);
        near(o.x, 0 + (i % 2 === 0 ? 0 : 5), 1e-9, `第 ${i} 个 x`);
        near(o.y, i * 10, 1e-9, `第 ${i} 个 y`);
      }
    });

    test('大 index 不崩（index 远超 columns）', () => {
      const o = formationOffset(1000, 10, 5);
      assert(Number.isFinite(o.x) && Number.isFinite(o.y), `值非有限：${o.x},${o.y}`);
      near(o.y, 200 * 10, 1e-9, '第 200 行');
    });
  });

  describe('队形 · circleFormation 环绕', () => {
    test('所有点都在圆上（半径恒定）', () => {
      for (const r of [1, 5, 100, 0.5]) {
        for (let i = 0; i < 7; i++) {
          const p = circleFormation(i, 7, r);
          near(Math.hypot(p.x, p.y), r, 1e-9, `半径 ${r} 第 ${i} 点`);
        }
      }
    });

    test('⚠️ 均匀分布：相邻夹角 = 2π/count', () => {
      const n = 8;
      for (let i = 0; i < n; i++) {
        const a = circleFormation(i, n, 10);
        const b = circleFormation(i + 1, n, 10);
        const angA = Math.atan2(a.y, a.x);
        const angB = Math.atan2(b.y, b.x);
        let d = angB - angA;
        while (d <= -Math.PI) d += Math.PI * 2;
        while (d > Math.PI) d -= Math.PI * 2;
        near(Math.abs(d), (Math.PI * 2) / n, 1e-9, `第 ${i} → ${i + 1} 夹角`);
      }
    });

    test('⚠️ 首尾相接（index = count 回到起点）', () => {
      const a = circleFormation(0, 6, 10);
      const b = circleFormation(6, 6, 10);
      near(a.x, b.x, 1e-9);
      near(a.y, b.y, 1e-9);
    });

    test('中心对称：i 与 i + count/2 互为相反数', () => {
      const n = 8;
      for (let i = 0; i < n / 2; i++) {
        const a = circleFormation(i, n, 10);
        const b = circleFormation(i + n / 2, n, 10);
        near(a.x, -b.x, 1e-9);
        near(a.y, -b.y, 1e-9);
      }
    });

    test('⚠️ count = 0 不崩（除零保护）', () => {
      // count=0 → index/0 = Infinity → cos(Infinity) = NaN
      const p = circleFormation(0, 0, 10);
      // 只要求"不抛异常"，值是 NaN 也算一种明确结果
      assert(
        Number.isNaN(p.x) || Number.isFinite(p.x),
        `count=0 时返回了非数非 NaN 的怪值：${p.x}`,
      );
    });

    test('半径为 0 时全部在原点', () => {
      for (let i = 0; i < 5; i++) {
        const p = circleFormation(i, 5, 0);
        near(p.x, 0, 1e-9);
        near(p.y, 0, 1e-9);
      }
    });
  });

  // ============================================================
  // VisibilityMap（原来只有 4 项）
  // ============================================================

  describe('VisibilityMap · 边界与安全', () => {
    test('⚠️ 越界读取返回 false，不崩', () => {
      const vm = new VisibilityMap(10, 10);
      eq(vm.has(-1, 5), false, '左越界');
      eq(vm.has(10, 5), false, '右越界');
      eq(vm.has(5, -1), false, '上越界');
      eq(vm.has(5, 10), false, '下越界');
      eq(vm.has(-100, -100), false, '双重越界');
    });

    test('⚠️ 越界写入被静默忽略（不是报错，也不是扩容）', () => {
      const vm = new VisibilityMap(10, 10);
      vm.mark(-1, 5);
      vm.mark(10, 5);
      vm.mark(5, -1);
      vm.mark(5, 10);
      eq(vm.count, 0, '越界标记不该计数');
      // 也不该影响界内的值
      vm.mark(3, 3);
      eq(vm.has(3, 3), true);
      eq(vm.count, 1);
    });

    test('重复 mark 同一格不重复计数', () => {
      const vm = new VisibilityMap(20, 20);
      for (let i = 0; i < 50; i++) vm.mark(7, 9);
      eq(vm.count, 1, `重复标记 50 次，count 应仍为 1，实际 ${vm.count}`);
    });

    test('set(false) 可以取消标记', () => {
      const vm = new VisibilityMap(10, 10);
      vm.mark(1, 1);
      eq(vm.has(1, 1), true);
      vm.set(1, 1, false);
      eq(vm.has(1, 1), false, '应该已取消');
      eq(vm.count, 0, 'count 应归零');
    });

    test('clear() 清空全部并归零计数', () => {
      const vm = new VisibilityMap(10, 10);
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) vm.mark(x, y);
      eq(vm.count, 100);
      vm.clear();
      eq(vm.count, 0);
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) assert(!vm.has(x, y));
    });

    test('⚠️ 幂等：mark 后 clear 再 mark，状态一致', () => {
      const vm = new VisibilityMap(8, 8);
      vm.mark(2, 3);
      vm.mark(4, 5);
      const before = vm.count;
      vm.clear();
      vm.mark(2, 3);
      vm.mark(4, 5);
      eq(vm.count, before, '重复操作后应回到相同状态');
    });

    test('toArray 长度与 count 一致', () => {
      const vm = new VisibilityMap(12, 12);
      for (let i = 0; i < 30; i++) vm.mark(i % 12, Math.floor(i / 12));
      eq(vm.toArray().length, vm.count, 'toArray 长度应等于 count');
    });

    test('inBounds 与 has 的一致性', () => {
      const vm = new VisibilityMap(6, 6);
      // 界内未标记的返回 false，界外也返回 false —— 但 inBounds 能区分
      eq(vm.inBounds(1, 1), true);
      eq(vm.inBounds(-1, 1), false);
      eq(vm.inBounds(6, 1), false);
    });
  });

  // ============================================================
  // SpatialHash（对 fuzz 的补充：定向边界用例）
  // ============================================================

  describe('SpatialHash · 定向边界', () => {
    test('⚠️ 负数坐标：Math.floor 而非截断（这是经典 bug）', () => {
      /**
       * 【为什么必须测】
       * 若用 `(x / cell) | 0` 而不是 Math.floor，
       * -0.5 会被分到格子 0 而不是 -1，
       * 于是 x=-0.5 与 x=+0.5 落在同一格 —— 空间哈希在原点附近失效。
       */
      const h = new SpatialHash(10);
      h.insert(1, -0.5, 0);   // 应在格 (-1, 0)
      h.insert(2, 0.5, 0);    // 应在格 ( 0, 0)

      const near1 = h.queryNeighbors(-0.5, 0, 0);  // 只查自己所在格
      const near2 = h.queryNeighbors(0.5, 0, 0);

      assert(near1.includes(1), '-0.5 应能查到自己');
      assert(!near1.includes(2), '-0.5 与 0.5 不该同格（floor vs 截断）');
      assert(near2.includes(2), '0.5 应能查到自己');
      assert(!near2.includes(1), '反之亦然');
    });

    test('⚠️ 极端坐标（1e308）不产生 Infinity 格号', () => {
      const h = new SpatialHash(10);
      h.insert(1, 1e308, 1e308);
      h.insert(2, -1e308, -1e308);
      // 只要不崩、查询能找到自己即可
      const a = h.queryNeighbors(1e308, 1e308, 0);
      const b = h.queryNeighbors(-1e308, -1e308, 0);
      assert(a.includes(1), '极端正坐标应能查到自己');
      assert(b.includes(2), '极端负坐标应能查到自己');
    });

    test('remove 后查不到', () => {
      const h = new SpatialHash(20);
      h.insert(1, 5, 5);
      eq(h.count, 1);
      eq(h.remove(1), true, 'remove 应返回 true');
      eq(h.count, 0);
      eq(h.queryNeighbors(5, 5, 2).includes(1), false, '删除后不该再被查到');
      eq(h.remove(1), false, '重复 remove 返回 false');
    });

    test('⚠️ 移动到新格后，旧格里不再有它', () => {
      const h = new SpatialHash(20);
      h.insert(1, 5, 5);      // 格 (0,0)
      h.update(1, 500, 500);  // 格 (25,25)
      eq(h.count, 1, 'id 数不该变');
      assert(!h.queryNeighbors(5, 5, 0).includes(1), '旧格不该还有它');
      assert(h.queryNeighbors(500, 500, 0).includes(1), '新格应有它');
    });

    test('cellSize 非正数抛错', () => {
      throws(() => new SpatialHash(0), '必须为正');
      throws(() => new SpatialHash(-5), '必须为正');
    });

    test('⚠️ 同一位置重复 insert 返回 false', () => {
      const h = new SpatialHash(20);
      eq(h.insert(1, 5, 5), true, '首次应为 true');
      eq(h.insert(1, 5, 5), false, '位置没变应返回 false');
    });
  });

  // ============================================================
  // createAgent（Steering 的入口，原来几乎没测）
  // ============================================================

  describe('createAgent · 入口', () => {
    test('默认字段齐全', () => {
      const a = createAgent(v2(1, 2));
      near(a.pos.x, 1, 1e-9);
      near(a.pos.y, 2, 1e-9);
      assert(a.vel !== undefined, '应有 vel');
      assert(a.force !== undefined, '应有 force');
    });

    test('⚠️ 返回的 pos/vel/force 是独立对象（不是共享引用）', () => {
      /**
       * 【为什么必须测】
       * 若实现里用了共享的默认对象常量，
       * 创建两个 agent 后改其中一个的速度，另一个也会变——
       * 表现为"控制一个单位，全场一起动"。
       */
      const a = createAgent(v2(0, 0));
      const b = createAgent(v2(0, 0));
      a.vel.x = 999;
      assert(b.vel.x !== 999, '两个 agent 的 vel 共享了引用');
      a.force.y = 888;
      assert(b.force.y !== 888, '两个 agent 的 force 共享了引用');
      a.pos.x = 777;
      assert(b.pos.x !== 777, '两个 agent 的 pos 共享了引用');
    });

    test('v2() 每次返回新对象', () => {
      const p = v2(1, 2);
      const q = v2(1, 2);
      assert(p !== q, 'v2 应返回新对象');
      p.x = 100;
      eq(q.x, 1, '改一个不该影响另一个');
    });
  });
}
