/**
 * tests/run_phase6.ts —— 全局议题裁决的固化（文档一致性类）
 *
 * 【这一批的性质】
 * 前五批修的是"代码行为错误"。这一批守的是**语义约定的文档化**——
 * 三处不一致如果被"统一"掉，反而会破坏各自场景下的正确性：
 *
 * | 议题 | 差异 | 裁决 |
 * |---|---|---|
 * | 相切 | `_core.rectOverlaps` 含相切 / `ds.rectsOverlap` 不含 | **都保留**，注释说明适用场景 |
 * | 点包含 | `_core.rectContains` 闭区间 / `ds.pointInRect` 半开 | **都保留**，注释说明适用场景 |
 * | 矩形坐标系 | "左下+右上" vs "左上角+宽高" 自相矛盾 | **更正注释**，定统一口径 |
 *
 * 【为什么不强行统一】
 * 半开区间是格子归属的正确语义（闭区间会让边界点同时属于两格）；
 * 不含相切是空间索引的正确语义（避免边界物体重复命中）。
 * 强行选一个，必然有另一个场景出 bug——
 * 这也正是 `_core/types.ts` 里"两种表示法并存，不要强行统一"的同一思路。
 *
 * 【那这批测试在守什么】
 * 守的是"**差异本身不要被无意抹平**"。
 * 如果有人把 `ds.rectsOverlap` 的 `<` 改成 `<=` 想"对齐 _core"，
 * 四叉树查询就会开始重复命中——这些用例会立刻失败。
 *
 * 换句话说：这批用例是给"看起来不一致但故意如此"的设计**上锁**。
 */

import { describe, test, assert, eq } from './_framework';

import {
  IRect,
  IRectSized,
  toCorners,
  toSized,
  rectContains,
  rectOverlaps,
} from '../_core/types';
import { rectsOverlap, pointInRect, Rect } from '../ds/DataStructures';

export function runPhase6Tests(): void {
  // ============================================================
  // 议题 1 · 相切语义（刻意不一致，上锁）
  // ============================================================

  describe('矩形 · 相切语义的差异（刻意保留）', () => {
    /** a 的右边界正好等于 b 的左边界 */
    const a: Rect = { x: 0, y: 0, w: 10, h: 10 };
    const b: Rect = { x: 10, y: 0, w: 10, h: 10 };

    test('⚠️ ds.rectsOverlap 相切时返回 false（用 <）', () => {
      /**
       * 【为什么必须不含相切】
       * 它服务于四叉树查询：相切的两个节点若算重叠，
       * 边界上的物体会被两个节点同时命中，
       * 去重后仍多算一次距离计算（且结果可能重复）。
       */
      eq(rectsOverlap(a, b), false, '相切不应算重叠');
    });

    test('⚠️ _core.rectOverlaps 相切时返回 true（用 <=）', () => {
      /** 通用 AABB 判定，含相切是几何上的常规约定。 */
      eq(rectOverlaps(toCorners(a), toCorners(b)), true, '相切应算相交');
    });

    test('⚠️ 两者的差异是刻意的，不是笔误', () => {
      /**
       * 这条用例的价值：把"不一致"本身变成契约。
       * 有人想"统一风格"改成一致时，这里会失败，
       * 从而强制他去读两侧注释里的适用场景说明。
       */
      const dsResult = rectsOverlap(a, b);
      const coreResult = rectOverlaps(toCorners(a), toCorners(b));
      assert(dsResult !== coreResult, '相切场景两者结果必须不同（若相同说明差异被抹平了）');
    });

    test('真正重叠时两者结果一致', () => {
      const overlapping: Rect = { x: 5, y: 0, w: 10, h: 10 };
      eq(rectsOverlap(a, overlapping), true);
      eq(rectOverlaps(toCorners(a), toCorners(overlapping)), true);
    });
  });

  // ============================================================
  // 议题 2 · 点包含的区间语义（刻意不一致，上锁）
  // ============================================================

  describe('矩形 · 点包含的区间语义（刻意保留）', () => {
    const r: Rect = { x: 0, y: 0, w: 10, h: 10 };
    const corners: IRect = toCorners(r);

    test('⚠️ _core.rectContains 是闭区间（含右边界）', () => {
      eq(rectContains(corners, 0, 0), true, '含左边界');
      eq(rectContains(corners, 10, 10), true, '含右/下边界');
    });

    test('⚠️ ds.pointInRect 是半开区间 [x, x+w)（不含右边界）', () => {
      /**
       * 【为什么必须是半开】
       * 格子/瓦片归属判定：相邻格子共享边界，
       * 闭区间会让边界点同时属于两格，
       * 表现为"同一物体被两个格子各存一份"。
       */
      eq(pointInRect(0, 0, r), true, '含左边界');
      eq(pointInRect(10, 10, r), false, '不含右/下边界');
    });

    test('⚠️ 边界点上两者结果不同（差异是刻意的）', () => {
      eq(pointInRect(10, 0, r), false);
      eq(rectContains(corners, 10, 0), true);
    });

    test('内部点上两者结果一致', () => {
      eq(pointInRect(5, 5, r), true);
      eq(rectContains(corners, 5, 5), true);
    });
  });

  // ============================================================
  // 议题 3 · 矩形坐标系口径（注释已更正，行为固化）
  // ============================================================

  describe('矩形 · 坐标系口径', () => {
    test('⚠️ toCorners 假设 y 向下（y 被当作 minY）', () => {
      /**
       * 【统一口径】
       * - `IRect` 的 min/max 是**轴无关**的数值大小，不是"上下左右"
       * - `IRectSized` 的 x/y 是 **min 角**，不是"左上角"
       * - `toCorners` 假设 y 向下（屏幕系）
       *
       * 这个行为不能改（改了破坏 dungeon 等 y 向下的调用方），
       * 但必须在注释里说清——本用例把行为固化下来，
       * 让"注释说的"和"代码做的"始终一致。
       */
      const sized: IRectSized = { x: 10, y: 20, w: 30, h: 40 };
      const c = toCorners(sized);
      eq(c.minX, 10, 'x 是 minX');
      eq(c.minY, 20, 'y 被当作 minY（y 向下的语义）');
      eq(c.maxX, 40, 'x + w');
      eq(c.maxY, 60, 'y + h');
    });

    test('⚠️ toCorners / toSized 往返一致', () => {
      const sized: IRectSized = { x: 10, y: 20, w: 30, h: 40 };
      const back = toSized(toCorners(sized));
      eq(back.x, sized.x);
      eq(back.y, sized.y);
      eq(back.w, sized.w);
      eq(back.h, sized.h);
    });

    test('⚠️ minY 是数值更小的那条边（不是"下面那条边"）', () => {
      /**
       * 这条用例直接固化"轴无关"这个口径：
       * 无论 y 轴朝哪，minY 都该是数值小的那个。
       * 若有人按"左下角"的旧注释去改 toCorners，这里会失败。
       */
      const r: IRect = { minX: 0, minY: 5, maxX: 10, maxY: 15 };
      assert(r.minY < r.maxY, 'minY 必须小于 maxY（数值语义）');
      const sized = toSized(r);
      eq(sized.y, 5, 'toSized 取 minY 作为 y');
    });

    test('负尺寸矩形：max < min（数学上退化，不报错）', () => {
      /**
       * 【为什么不断言抛错】
       * 本库对"中间值"的口径是在入口校验（needCount 等），
       * 而 toCorners 是纯转换函数，不做业务校验。
       * 这里只固化"它不抛错"这个事实，避免有人误以为有校验。
       */
      const weird: IRectSized = { x: 10, y: 10, w: -5, h: -5 };
      const c = toCorners(weird);
      eq(c.maxX, 5, '允许 max < min（调用方责任）');
      assert(c.maxY < c.minY);
    });
  });
}
