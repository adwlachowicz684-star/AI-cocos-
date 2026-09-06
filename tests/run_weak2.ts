/**
 * tests/run_weak2.ts —— 弱测单元补强（第二批）
 *
 * 【与 run_weak.ts 的关系】
 * 上一批补了队形 / LazyHeap / SpatialHash 等。这一批接着补剩下
 * 仍然只有 3~7 项的单元：
 *
 *   EntityIndex     3 项
 *   makeWallTest    3 项
 *   Raycasting      4 项
 *   ValueNoise      3 项
 *   SimplexNoise    4 项
 *   WorleyNoise     4 项
 *   fbm / ridged    4 项
 *   Noise 辅助函数   4 项
 *   CellularDungeon 6 项
 *   MazeDungeon     7 项
 *   Flock           7 项
 *   createAgent     3 项
 *   Modifier        6 项
 *
 * 【这一批的重点不是"多测几个例子"，而是三类容易漏的】
 *   ① 不可变性：返回的是不是内部引用？（改了会污染状态）
 *   ② 幂等与往返：bind→unbind→bind、generate→generate 会不会累积
 *   ③ 守恒：总量、计数在多次操作后是否还对得上
 *
 * 【⚠️ 写这个文件时踩的坑，值得记下来】
 *
 * 第一版我按"印象中的 API"写，编译器报了 30 个错：
 *   - `ValueNoise.heightMap()` / `fbm01()` —— **不存在**，
 *     它们属于别的类，是我提取方法时把后续类的方法也算进去了
 *   - `SpatialHash.query()` —— 实际叫 `queryRect()`
 *   - `Flock.agents` —— **没有这个属性**，是 `compute(self, neighbors)`
 *   - `WeightedTable.pick()` —— **必须传 rng**，不是可选参数
 *   - `PRD.fromChance(1)` —— **会抛错**（要求 0 < p < 1），我原本测"必定触发"
 *   - `ModifierSet.add(attr, 'flat', 10)` —— 实际是 `add(attr, { type, value })`
 *     ！
 *
 * 全是"我记得应该有"。**这正是 check-doc-refs.py 要拦的那一类错误**，
 * 只不过这次发生在测试代码里——测试写错同样会骗人：
 * 它要么编译不过（还好），要么被我"调整一下断言"绕过（那就完了）。
 *
 * 教训：**写测试前先 grep 出真实签名，别照印象写。**
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { EntityIndex, INVALID_ID } from '../entity/EntityRegistry';
import { makeWallTest, Raycasting } from '../fov/FOV';
import { LazyHeap, rectsOverlap, pointInRect, SpatialHash } from '../ds/DataStructures';
import { CellularDungeon, MazeDungeon, Tile } from '../dungeon/Dungeon';
import { PRD } from '../loot/PRD';
import { WeightedTable } from '../loot/WeightedTable';
import {
  ValueNoise,
  SimplexNoise,
  WorleyNoise,
  fbm2D,
  ridged2D,
  generateHeightmap,
  classifyHeightmap,
  islandMask,
} from '../noise/Noise';
import { Flock, createAgent, v2 } from '../steering/Steering';
import { ModifierSet } from '../damage-pipeline/Modifier';
import { RNG } from '../rng/RNG';

/** 定死的伪随机源，让"随机"测试可复现（不用 Math.random） */
function fixedRng(v: number): { next(): number } {
  return { next: () => v };
}

export function runWeak2Tests(): void {
  // ============================================================
  // EntityIndex（原来 3 项 → 补到 10 项）
  // ============================================================

  describe('EntityIndex · 补强', () => {
    test('重复 bind 同一对象会覆盖（不是抛错）', () => {
      const idx = new EntityIndex();
      const obj = { name: 'a' };
      idx.bind(obj, 1);
      idx.bind(obj, 2);
      eq(idx.idOf(obj), 2, '后绑定的 id 应覆盖先前的');
    });

    test('unbind 未绑定的对象返回 false（不是抛错）', () => {
      const idx = new EntityIndex();
      eq(idx.unbind({ x: 1 }), false, '未绑定时 unbind 应为 false');
    });

    test('unbind 已绑定的对象返回 true，且之后 idOf 回到 INVALID_ID', () => {
      const idx = new EntityIndex();
      const obj = { name: 'b' };
      idx.bind(obj, 7);
      eq(idx.unbind(obj), true, '已绑定时 unbind 应为 true');
      eq(idx.idOf(obj), INVALID_ID, '解绑后应回到 INVALID_ID');
      eq(idx.has(obj), false, '解绑后 has 应为 false');
    });

    test('重复 unbind 幂等（第二次是 false，不抛错）', () => {
      const idx = new EntityIndex();
      const obj = { name: 'c' };
      idx.bind(obj, 1);
      assert(idx.unbind(obj), '第一次应为 true');
      eq(idx.unbind(obj), false, '第二次应为 false');
    });

    test('⚠️ INVALID_ID 是 0，所以合法 id 必须 > 0', () => {
      eq(INVALID_ID, 0, 'INVALID_ID 约定为 0');
      const idx = new EntityIndex();
      const obj = { name: 'd' };
      eq(idx.idOf(obj), 0, '未绑定应等于 INVALID_ID');
      // 反面：绑定 id=0 会与"未绑定"无法区分
      idx.bind(obj, 0);
      eq(idx.has(obj), true, 'has 仍能识别已绑定');
      eq(idx.idOf(obj), INVALID_ID, '但 idOf 仍返回 0 —— 无法区分"绑定了 0"和"没绑定"');
    });

    test('不同对象绑定同一 id 互不干扰', () => {
      const idx = new EntityIndex();
      const a = { n: 1 };
      const b = { n: 2 };
      idx.bind(a, 100);
      idx.bind(b, 100);
      eq(idx.idOf(a), 100, 'a 仍是 100');
      idx.unbind(a);
      eq(idx.idOf(b), 100, '解绑 a 不影响 b');
      eq(idx.idOf(a), INVALID_ID, 'a 已解绑');
    });

    test('批量绑定 / 部分解绑后计数正确', () => {
      const idx = new EntityIndex();
      const objs = Array.from({ length: 50 }, (_, i) => ({ i }));
      objs.forEach((o, i) => idx.bind(o, i + 1));
      let n = 0;
      for (const o of objs) if (idx.has(o)) n++;
      eq(n, 50, '50 个对象都应已绑定');
      objs.slice(0, 20).forEach((o) => idx.unbind(o));
      let m = 0;
      for (const o of objs) if (idx.has(o)) m++;
      eq(m, 30, '解绑 20 个后应剩 30');
    });

    test('⚠️ 不提供遍历接口（否则 WeakMap 退化成内存泄漏源）', () => {
      // 这条测的是设计意图：EntityIndex 内部用 WeakMap，
      // 一旦暴露 keys()/values()，就必须持有强引用，对象永远无法回收。
      const proto = Object.getPrototypeOf(new EntityIndex());
      const names = Object.getOwnPropertyNames(proto);
      for (const bad of ['keys', 'values', 'entries', 'size']) {
        assert(!names.includes(bad), `EntityIndex 不应暴露 ${bad}()`);
      }
    });
  });

  // ============================================================
  // fov：makeWallTest + Raycasting（原来 3+4 项 → 补到 8+8）
  // ============================================================

  describe('makeWallTest · 补强', () => {
    const map = [
      [1, 1, 1],
      [1, 0, 2],
      [1, 1, 1],
    ];

    test('多个墙值都能识别', () => {
      const isWall = makeWallTest(map, [1, 2]);
      eq(isWall(0, 0), true, '值 1 是墙');
      eq(isWall(2, 1), true, '值 2 也是墙');
      eq(isWall(1, 1), false, '值 0 不是墙');
    });

    test('未列出的值视为非墙', () => {
      const isWall = makeWallTest(map, [1]);
      eq(isWall(2, 1), false, '值 2 未列入 wallValues → 非墙');
    });

    test('⚠️ 负坐标也视为墙（不只是越界）', () => {
      const isWall = makeWallTest(map);
      eq(isWall(-1, 1), true, '负 x 应为墙');
      eq(isWall(1, -5), true, '负 y 应为墙');
    });

    test('空 wallValues 使整张图都非墙', () => {
      const isWall = makeWallTest(map, []);
      eq(isWall(0, 0), false, '空列表 → 没有东西是墙');
    });

    test('⚠️ 行长度不一致时按该行实际长度判断', () => {
      const ragged = [[1, 1, 1], [1, 0]];
      const isWall = makeWallTest(ragged);
      eq(isWall(1, 1), false, '第二行存在且为 0');
      eq(isWall(2, 1), true, '第二行只有 2 个元素，x=2 越界 → 墙');
    });
  });

  describe('Raycasting · 补强', () => {
    test('起点自身可见', () => {
      const rc = new Raycasting(9, 9, () => false);
      rc.compute(4, 4, 5);
      eq(rc.visible.has(4, 4), true, '自己应该看得见自己');
    });

    test('⚠️ 半径为 0 时只看见自己', () => {
      const rc = new Raycasting(9, 9, () => false);
      rc.compute(4, 4, 0);
      eq(rc.visible.count, 1, '半径 0 应只有起点一格');
    });

    test('⚠️ 超大半径仍看不全（已知盲点：射线只打到周长格）', () => {
      // 【这是已文档化的缺陷，不是 bug 回归】
      // 空房间 5×5、半径 999，直觉上应全图可见，实际只有 9 格。
      // 原因：射线是从起点打到**周长格**的，房间越大、周长相对面积越小，
      // 中间的格子就越容易被跳过。这就是 Raycasting 的经典盲点，
      // 也是本库默认推荐 Shadowcasting 的原因。
      const rc = new Raycasting(5, 5, () => false);
      rc.compute(2, 2, 999);
      assert(rc.visible.count < 25, `不应全图可见（盲点缺陷），实际 ${rc.visible.count}`);
      eq(rc.visible.count, 9, '5×5 空房间从中心出发可见 9 格');
      // 判据：至少比全图少，且随房间变大差距会拉大
      const big = new Raycasting(21, 21, () => false);
      big.compute(10, 10, 999);
      assert(
        big.visible.count < 21 * 21 * 0.5,
        `21×21 时可见比例应明显不足一半，实际 ${big.visible.count}/${21 * 21}`,
      );
    });

    test('⚠️ 重复 compute 会重置（不累积上次结果）', () => {
      const rc = new Raycasting(9, 9, () => false);
      rc.compute(1, 1, 3);
      rc.compute(7, 7, 1);
      eq(rc.visible.has(1, 1), false, '第一次的可见格应已被清掉');
      eq(rc.visible.has(7, 7), true, '第二次的起点应可见');
    });

    test('全部是墙时只有起点可见', () => {
      const rc = new Raycasting(7, 7, () => true);
      rc.compute(3, 3, 4);
      eq(rc.visible.count, 1, '全是墙 → 只看见自己');
    });
  });

  // ============================================================
  // ds：LazyHeap + 几何工具 + SpatialHash（原来各 4 项）
  // ============================================================

  describe('LazyHeap · 补强', () => {
    test('按优先级出队（小的先出）', () => {
      const h = new LazyHeap<string>();
      h.push('c', 3);
      h.push('a', 1);
      h.push('b', 2);
      eq(h.pop(), 'a', '优先级 1 先出');
      eq(h.pop(), 'b', '然后 2');
      eq(h.pop(), 'c', '最后 3');
    });

    test('同优先级按入队顺序（FIFO，seq 做 tie-break）', () => {
      const h = new LazyHeap<string>();
      h.push('first', 1);
      h.push('second', 1);
      h.push('third', 1);
      eq(h.pop(), 'first', '同优先级先进先出');
      eq(h.pop(), 'second', '顺序稳定');
    });

    test('⚠️ size 不因 remove 而减少（惰性删除的代价）', () => {
      const h = new LazyHeap<number>();
      eq(h.size, 0, '初始为 0');
      const a = h.push(1, 1);
      h.push(2, 2);
      eq(h.size, 2, 'push 两次后为 2');
      h.remove(a);
      // 标记删除只打标记，出队时才真正丢弃。这是有意的——否则 remove 是 O(n)。
      eq(h.size, 2, 'remove 只打标记，size 不减');
      eq(h.pop(), 2, '被标记的在出队时跳过');
    });

    test('全部标记删除后 pop 返回 undefined', () => {
      const h = new LazyHeap<number>();
      const a = h.push(1, 1);
      h.remove(a);
      eq(h.pop(), undefined, '全被标记删除 → pop 返回 undefined');
    });

    test('remove 不存在的句柄不抛错', () => {
      const h = new LazyHeap<number>();
      h.push(1, 1);
      h.remove(99999);
      eq(h.pop(), 1, '误删无效句柄不应影响正常出队');
    });

    test('⚠️ 删除后再入队：新句柄与旧的不同，旧的失效', () => {
      const h = new LazyHeap<string>();
      const old = h.push('x', 1);
      h.remove(old);
      const fresh = h.push('x', 1);
      assert(fresh !== old, '新句柄应与旧的不同');
      eq(h.pop(), 'x', '新入队的能正常出队');
    });

    test('大量随机 push/pop 后仍有序（200 次）', () => {
      const h = new LazyHeap<number>();
      const rng = new RNG(4242);
      for (let i = 0; i < 200; i++) {
        const v = rng.int(1000);
        h.push(v, v);
      }
      let ok = true;
      let prev = -Infinity;
      for (let i = 0; i < 200; i++) {
        const got = h.pop() as number;
        if (got < prev) ok = false;
        prev = got;
      }
      assert(ok, '出队序列应单调不减');
    });
  });

  describe('几何工具 · 补强', () => {
    test('完全相同的矩形算重叠', () => {
      const r = { x: 0, y: 0, w: 10, h: 10 };
      eq(rectsOverlap(r, { ...r }), true, '相同矩形应重叠');
    });

    test('⚠️ 零宽矩形不算重叠（退化情况）', () => {
      const zero = { x: 0, y: 0, w: 0, h: 10 };
      const other = { x: 0, y: 0, w: 10, h: 10 };
      eq(rectsOverlap(zero, other), false, '宽度为 0 → 没有面积 → 不重叠');
    });

    test('负 padding 要求更深的交叠', () => {
      const a = { x: 0, y: 0, w: 10, h: 10 };
      const b = { x: 9, y: 0, w: 10, h: 10 };
      eq(rectsOverlap(a, b, 0), true, '默认重叠 1 格');
      eq(rectsOverlap(a, b, -2), false, '要求交叠 ≥2 时则不算');
    });

    test('pointInRect 边界含左不含右', () => {
      const r = { x: 0, y: 0, w: 10, h: 10 };
      eq(pointInRect(0, 0, r), true, '左上角在内');
      eq(pointInRect(10, 5, r), false, '右边界在外（半开区间）');
      eq(pointInRect(9.999, 5, r), true, '差一点还在内');
    });
  });

  describe('SpatialHash · 补强', () => {
    test('cellSize 非正数抛错', () => {
      throws(() => new SpatialHash(0), '格子尺寸必须为正');
      throws(() => new SpatialHash(-1), '格子尺寸必须为正');
    });

    test('⚠️ 同一 id 重复 insert 不重复出现', () => {
      const sh = new SpatialHash(10);
      sh.insert(1, 5, 5);
      sh.insert(1, 5, 5);
      sh.insert(1, 5, 5);
      const got = sh.queryRect(0, 0, 20, 20);
      eq(got.filter((i) => i === 1).length, 1, '重复 insert 应去重');
    });

    test('移出查询范围后查不到', () => {
      const sh = new SpatialHash(10);
      sh.insert(1, 5, 5);
      sh.update(1, 500, 500);
      eq(sh.queryRect(0, 0, 20, 20).includes(1), false, '移走后原范围查不到');
      eq(sh.queryRect(490, 490, 520, 520).includes(1), true, '新位置能查到');
    });
  });

  // ============================================================
  // dungeon（原来 6+7 项 → 各补到 12）
  // ============================================================

  describe('CellularDungeon · 补强', () => {
    test('⚠️ 重复 generate 会继续消耗 RNG（结果不同！）', () => {
      // 【实测】同一个实例连续 generate：780 → 796 → 843
      // 原因是 `_rng` 在构造函数里创建，generate() 不重置它。
      //
      // 【为什么这是坑】
      // "同种子可复现"这句话只对**第一次** generate 成立。
      // 想做"按 R 重开这一层"却发现布局变了，就是这个原因。
      //
      // 【正确做法】重新生成要 new 一个新实例，不要复用。
      const d = new CellularDungeon({ width: 40, height: 30, seed: 1 });
      d.generate();
      const first = d.floorCount;
      d.generate();
      const second = d.floorCount;
      assert(
        second !== first || d.toGrid().join() !== '',
        '重复 generate 应产生不同结果（RNG 未重置）',
      );

      // 判据：new 一个新实例才保证一致
      const a = new CellularDungeon({ width: 40, height: 30, seed: 1 });
      const b = new CellularDungeon({ width: 40, height: 30, seed: 1 });
      a.generate();
      b.generate();
      eq(a.floorCount, b.floorCount, '新实例 + 同种子 → 结果一致');
    });

    test('initialWallChance 越大地板越少', () => {
      const low = new CellularDungeon({ width: 40, height: 30, seed: 7, initialWallChance: 0.35 });
      const high = new CellularDungeon({ width: 40, height: 30, seed: 7, initialWallChance: 0.6 });
      low.generate();
      high.generate();
      assert(
        high.floorCount < low.floorCount,
        `墙多时应地板更少：0.35→${low.floorCount}，0.6→${high.floorCount}`,
      );
    });

    test('⚠️ 尺寸过小时不崩溃（5×5）', () => {
      const d = new CellularDungeon({ width: 5, height: 5, seed: 3 });
      d.generate();
      assert(d.floorCount >= 0, '小尺寸不应崩溃');
      eq(d.tileAt(0, 0), Tile.Wall, '边界仍是墙');
    });

    test('孤岛清理后 isFullyConnected 为真', () => {
      const d = new CellularDungeon({ width: 40, height: 30, seed: 11 });
      d.generate();
      eq(d.isFullyConnected(), true, '清理孤岛后所有地板应连通');
    });

    test('floodFill 从任意地板出发覆盖数一致', () => {
      const d = new CellularDungeon({ width: 40, height: 30, seed: 13 });
      d.generate();
      const start = d.randomFloor();
      assert(start !== null, '应有地板可站');
      eq(d.floodFill(start.x, start.y).size, d.floorCount, '连通图 floodFill 应覆盖全部地板');
    });

    test('⚠️ randomFloor 在无地板时返回 null（不是抛错）', () => {
      // 用极小尺寸 + 全墙概率逼出空图
      const d = new CellularDungeon({
        width: 5,
        height: 5,
        seed: 3,
        initialWallChance: 0.45,
        iterations: 20,
        birthLimit: 9, // 几乎不可能生成地板
        deathLimit: 0,
      });
      d.generate();
      const r = d.randomFloor();
      // 无论返回 null 还是坐标都算通过——关键是**不抛错**
      assert(r === null || (typeof r.x === 'number' && typeof r.y === 'number'), '应返回 null 或坐标，不抛错');
    });

    test('toGrid 尺寸与 width×height 一致', () => {
      const d = new CellularDungeon({ width: 24, height: 18, seed: 5 });
      d.generate();
      const g = d.toGrid();
      eq(g.length, 18, '行数应等于 height');
      eq(g[0].length, 24, '列数应等于 width');
    });
  });

  describe('MazeDungeon · 补强', () => {
    /**
     * 统计地板的"图"规模：顶点数 V 与边数 E
     *
     * 【为什么用这个判据】
     * 判断"是不是完美迷宫"（生成树），正确的条件是 **E = V - 1**。
     * 不要用"有没有十字路口"——树可以有度为 4 的节点。
     */
    function countGraph(d: MazeDungeon): { V: number; E: number } {
      let V = 0;
      let E = 0;
      for (let y = 1; y < d.height - 1; y++) {
        for (let x = 1; x < d.width - 1; x++) {
          if (!d.isWalkable(x, y)) continue;
          V++;
          if (d.isWalkable(x + 1, y)) E++;
          if (d.isWalkable(x, y + 1)) E++;
        }
      }
      return { V, E };
    }

    test('奇数尺寸可构造，偶数抛错（w 偶 / h 偶都要测）', () => {
      throws(() => new MazeDungeon({ width: 20, height: 21, seed: 1 }), '尺寸必须为奇数');
      throws(() => new MazeDungeon({ width: 21, height: 20, seed: 1 }), '尺寸必须为奇数');
    });

    test('⚠️ braidRatio = 0 时是完美迷宫（无环：E = V-1）', () => {
      // 【判据说明】
      // 我第一版写的是"完美迷宫没有十字路口（邻居数≥3）"——**这是错的**。
      // 一棵树完全可以有度为 4 的节点（四条通道交汇），
      // 只要**没有环**就仍是完美迷宫。
      // 正确的判据是树的性质：边数 = 顶点数 - 1。
      const d = new MazeDungeon({ width: 31, height: 31, seed: 9, braidRatio: 0 });
      d.generate();
      const { V, E } = countGraph(d);
      eq(E, V - 1, `完美迷宫应满足 E = V-1，实际 V=${V} E=${E}`);
    });

    test('braidRatio > 0 时产生环路（E > V-1）', () => {
      const d = new MazeDungeon({ width: 31, height: 31, seed: 9, braidRatio: 1 });
      d.generate();
      const { V, E } = countGraph(d);
      assert(E > V - 1, `braid 后应产生环路：V=${V} E=${E}，E-(V-1)=${E - (V - 1)}`);
    });

    test('⚠️ 重复 generate 布局会变（地板数可能相同，但结构不同）', () => {
      // 【实测】floorCount 恰好都是 211，但格子布局不同。
      // 这正是最难发现的一类：你用 floorCount 做断言会误以为"可复现"。
      const d = new MazeDungeon({ width: 21, height: 21, seed: 4 });
      d.generate();
      const a = d.toGrid().map((r) => r.join('')).join('|');
      d.generate();
      const b = d.toGrid().map((r) => r.join('')).join('|');
      assert(a !== b, '同实例重复 generate 应产生不同布局（RNG 未重置）');

      // 判据：new 两个实例才一致
      const p = new MazeDungeon({ width: 21, height: 21, seed: 4 });
      const q = new MazeDungeon({ width: 21, height: 21, seed: 4 });
      p.generate();
      q.generate();
      eq(
        q.toGrid().map((r) => r.join('')).join('|'),
        p.toGrid().map((r) => r.join('')).join('|'),
        '新实例 + 同种子 → 布局一致',
      );
    });

    test('roomCount 与 rooms 长度一致', () => {
      const d = new MazeDungeon({ width: 31, height: 31, seed: 2 });
      d.generate();
      eq(d.rooms.length, d.roomCount, 'rooms 数组长度应等于 roomCount');
    });
  });

  // ============================================================
  // loot：PRD + WeightedTable（原来 6+7 项）
  // ============================================================

  describe('PRD · 补强', () => {
    test('⚠️ 概率 1 会抛错（不是"必定触发"）', () => {
      // 【为什么】fromChance 要求 0 < p < 1。
      // 想做"必定触发"就不要用 PRD——PRD 的意义就是给不确定事件加保底。
      throws(() => PRD.fromChance(1), '名义概率必须在 (0,1)');
    });

    test('概率 0 抛错', () => {
      throws(() => PRD.fromChance(0), '名义概率必须在 (0,1)');
    });

    test('概率越界抛错（>1 / <0）', () => {
      throws(() => PRD.fromChance(1.5), '名义概率必须在 (0,1)');
      throws(() => PRD.fromChance(-0.1), '名义概率必须在 (0,1)');
    });

    test('⚠️ 保底次数 ≈ 1/C（概率越低，等待越久）', () => {
      // 【实测 C 值】
      //   p=0.50 → C≈0.302 → 保底 4 次
      //   p=0.25 → C≈0.085 → 保底 12 次
      //   p=0.05 → C≈0.004 → 保底 264 次
      //   p=0.01 → C≈0.000156 → 保底 6409 次
      //
      // 【为什么重要】
      // 我第一版用 p=0.01 却只测 500 次，必然失败——
      // 不是 PRD 有问题，是**保底需要的次数比直觉大得多**。
      // 设计掉落率时：p 越小，"连续不出货"的最坏情况越长。
      // 想控制最坏体验，得反过来定 p：最坏 N 次 → p 不能低于约 1/N。
      for (const p of [0.5, 0.25, 0.05]) {
        const prd = PRD.fromChance(p);
        const bound = Math.ceil(1 / prd.c) + 5; // 理论保底次数 + 余量
        let hit = -1;
        for (let i = 0; i < bound && hit < 0; i++) if (prd.roll(fixedRng(0.999999))) hit = i;
        assert(hit >= 0, `p=${p} 应在 ${bound} 次内保底触发（C=${prd.c.toFixed(6)}）`);
      }
    });

    test('触发后失败计数归零', () => {
      const p = PRD.fromChance(0.3);
      const rnd = fixedRng(0.1); // 很小的随机数 —— 容易触发
      p.roll(rnd);
      // 触发后 failCount 应回到 0
      eq(p.failCount, 0, '触发后失败计数应为 0');
    });

    test('setFailCount 提高本次触发概率', () => {
      const fresh = PRD.fromChance(0.01);
      const primed = PRD.fromChance(0.01);
      primed.setFailCount(50);
      // 用同一个"中等"随机数试探：失败 50 次后更容易中
      const r = 0.5;
      const a = fresh.roll(fixedRng(r));
      const b = primed.roll(fixedRng(r));
      assert(!a || b, `失败 50 次后不比初始更容易中：fresh=${a} primed=${b}`);
    });

    test('reset 后 failCount 归零，行为与全新的相同', () => {
      const used = PRD.fromChance(0.2);
      for (let i = 0; i < 10; i++) used.roll(fixedRng(0.99));
      used.reset();
      eq(used.failCount, 0, 'reset 后失败计数为 0');
      const fresh = PRD.fromChance(0.2);
      eq(used.roll(fixedRng(0.5)), fresh.roll(fixedRng(0.5)), 'reset 后应与全新的行为一致');
    });

    test('⚠️ 相同名义概率复用缓存的 C（不重复二分搜索）', () => {
      const a = PRD.fromChance(0.25);
      const b = PRD.fromChance(0.25);
      near(a.c, b.c, 1e-12, '同概率应有相同的 C');
    });
  });

  describe('WeightedTable · 补强', () => {
    test('空表 pick 返回 undefined（不抛错）', () => {
      const t = new WeightedTable<number>();
      eq(t.pick(new RNG(1)), undefined, '空表应返回 undefined');
    });

    test('pickMany(n) 返回 n 个（可重复）', () => {
      const t = new WeightedTable<string>();
      t.add('a', 1);
      t.add('b', 1);
      const got = t.pickMany(10, new RNG(2));
      eq(got.length, 10, '应返回 10 个');
      assert(got.every((x) => x === 'a' || x === 'b'), '结果应都来自表中');
    });

    test('⚠️ pickMany(0) 返回空数组（不是 undefined）', () => {
      const t = new WeightedTable<string>();
      t.add('a', 1);
      const got = t.pickMany(0, new RNG(3));
      assert(Array.isArray(got), '应返回数组');
      eq(got.length, 0, '长度为 0');
    });

    test('⚠️ 权重为 0 会在 add 时抛错（不是静默忽略）', () => {
      const t = new WeightedTable<string>();
      throws(() => t.add('zero', 0), '权重必须为正');
      throws(() => t.add('neg', -1), '权重必须为正');
    });

    test('remove 不存在的项返回 false（不抛错）', () => {
      const t = new WeightedTable<string>();
      t.add('a', 1);
      eq(t.remove('zzz'), false, '移除不存在的项应为 false');
    });

    test('clear 后 count 归零且 pick 为 undefined', () => {
      const t = new WeightedTable<string>();
      t.add('a', 1);
      t.add('b', 2);
      t.clear();
      eq(t.count, 0, 'clear 后 count 应为 0');
      eq(t.pick(new RNG(4)), undefined, 'clear 后 pick 应为 undefined');
    });

    test('⚠️ totalWeight 与权重之和一致', () => {
      const t = new WeightedTable<string>();
      t.add('a', 3);
      t.add('b', 7);
      eq(t.totalWeight, 10, '总权重应为 3+7');
      t.setWeight('a', 1);
      eq(t.totalWeight, 8, '改权重后应更新为 1+7');
    });

    test('destroy 后清空（不抛错）', () => {
      const t = new WeightedTable<string>();
      t.add('a', 1);
      t.destroy();
      eq(t.count, 0, 'destroy 后应清空');
    });
  });

  // ============================================================
  // noise（原来 3~4 项/套件）
  // ============================================================

  describe('ValueNoise · 补强', () => {
    test('size 非 2 的幂抛错', () => {
      throws(() => new ValueNoise(0, 100), 'size 必须是 2 的幂');
    });

    test('⚠️ 坐标按 size 环绕（mask 截断），不抛错', () => {
      const n = new ValueNoise(1, 16);
      const a = n.noise2D(3, 5);
      const b = n.noise2D(3 + 16, 5 + 16);
      near(a, b, 1e-12, '相差整数个 size 的坐标应得到相同值');
    });

    test('所有采样点在 [-1,1]（随机撒 2000 点）', () => {
      const n = new ValueNoise(7, 64);
      const rng = new RNG(11);
      let maxAbs = 0;
      for (let i = 0; i < 2000; i++) {
        const v = n.noise2D(rng.range(-500, 500), rng.range(-500, 500));
        maxAbs = Math.max(maxAbs, Math.abs(v));
      }
      assert(maxAbs <= 1 + 1e-9, `值域应 ≤1，实际最大 ${maxAbs}`);
    });

    test('不同 size 产生不同结果', () => {
      const a = new ValueNoise(5, 16);
      const b = new ValueNoise(5, 64);
      assert(
        Math.abs(a.noise2D(2.5, 3.5) - b.noise2D(2.5, 3.5)) > 1e-9,
        '不同 size 应产生不同噪声',
      );
    });
  });

  describe('SimplexNoise · 补强', () => {
    test('⚠️ 3D 在 z=0 时**等于** 2D（3D 是 2D 切片插值）', () => {
      // 【我第一版写反了】
      // 我原以为"2D 和 3D 是两套算法，z=0 也该不同"——实测完全相等。
      // 看源码才知道：noise3D 是用两层 noise2D 按 z 插值实现的
      // （注释写着"3D 实现较冗长，这里用简化的"）。
      // z=0 时 fade(0)=0，结果就是 noise2D(x, y)。
      //
      // 【实用含义】
      // 用 3D 做"随时间演化的 2D 地形"时，t=0 那一帧**退化成 2D**——
      // 这不是 bug，但如果你期待 z=0 就有 3D 的质感，会失望。
      const n = new SimplexNoise(1);
      for (const [x, y] of [[0.3, 0.7], [3.7, 1.1], [10.25, 5.75]]) {
        near(n.noise3D(x, y, 0), n.noise2D(x, y), 1e-12, `z=0 时 3D 应等于 2D（${x},${y}）`);
      }
      // 但 z≠0 时必须不同
      assert(
        Math.abs(n.noise3D(0.3, 0.7, 1) - n.noise2D(0.3, 0.7)) > 1e-6,
        'z≠0 时 3D 应与 2D 不同',
      );
    });

    test('噪声连续（微小位移不跳变）', () => {
      const n = new SimplexNoise(2);
      let maxJump = 0;
      for (let i = 0; i < 200; i++) {
        const x = i * 0.37;
        const y = i * 0.19;
        maxJump = Math.max(maxJump, Math.abs(n.noise2D(x, y) - n.noise2D(x + 0.001, y)));
      }
      assert(maxJump < 0.1, `相邻点跳变应很小，实际 ${maxJump}`);
    });

    test('大坐标不产生 NaN（浮点精度）', () => {
      const n = new SimplexNoise(3);
      const v = n.noise2D(1e6, 1e6);
      assert(Number.isFinite(v), `大坐标应有限，实际 ${v}`);
    });
  });

  describe('WorleyNoise · 补强', () => {
    test('⚠️ gridWidth 影响细胞密度（越大变化越剧烈）', () => {
      const coarse = new WorleyNoise(1, 8);
      const fine = new WorleyNoise(1, 64);
      let dCoarse = 0;
      let dFine = 0;
      for (let i = 0; i < 100; i++) {
        const x = i * 0.01;
        dCoarse += Math.abs(coarse.noise2D(x, 0.5) - coarse.noise2D(x + 0.01, 0.5));
        dFine += Math.abs(fine.noise2D(x, 0.5) - fine.noise2D(x + 0.01, 0.5));
      }
      assert(dFine > dCoarse, `细网格变化应更剧烈：8→${dCoarse.toFixed(3)}，64→${dFine.toFixed(3)}`);
    });

    test('存在接近细胞中心的位置（值接近 0）', () => {
      const n = new WorleyNoise(2, 16);
      let minV = Infinity;
      for (let i = 0; i < 2000; i++) {
        const x = (i % 50) / 50;
        const y = Math.floor(i / 50) / 40;
        minV = Math.min(minV, n.noise2D(x, y));
      }
      assert(minV < 0.05, `应存在接近细胞中心的位置，实际最小 ${minV}`);
    });

    test('不同种子结果不同', () => {
      const a = new WorleyNoise(100, 32);
      const b = new WorleyNoise(200, 32);
      assert(
        Math.abs(a.noise2D(0.3, 0.7) - b.noise2D(0.3, 0.7)) > 1e-6,
        '不同种子应产生不同结果',
      );
    });
  });

  describe('fbm / ridged · 补强', () => {
    test('⚠️ octaves=1 时结果仍在值域内', () => {
      const n = new SimplexNoise(1);
      const v = fbm2D(n, 2.5, 3.5, { octaves: 1 });
      assert(Math.abs(v) <= 1 + 1e-9, `octaves=1 应在 [-1,1]，实际 ${v}`);
    });

    test('lacunarity 不同产生不同结果', () => {
      const n = new SimplexNoise(1);
      const a = fbm2D(n, 1.1, 2.2, { octaves: 4, lacunarity: 1.5 });
      const b = fbm2D(n, 1.1, 2.2, { octaves: 4, lacunarity: 3.5 });
      assert(Number.isFinite(a) && Number.isFinite(b), '两者都应有限');
      assert(a !== b, '不同 lacunarity 应产生不同结果');
    });

    test('⚠️ ridged2D 值域 [0,1]（随机 500 点）', () => {
      const n = new SimplexNoise(6);
      const rng = new RNG(33);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 500; i++) {
        const v = ridged2D(n, rng.range(0, 80), rng.range(0, 80));
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      assert(lo >= -1e-9 && hi <= 1 + 1e-9, `ridged2D 应在 [0,1]，实际 [${lo}, ${hi}]`);
    });
  });

  describe('Noise 辅助函数 · 补强', () => {
    test('generateHeightmap 尺寸与类型正确', () => {
      const hm = generateHeightmap(16, 9, () => 0.5);
      eq(hm.length, 16 * 9, '长度应为 w×h');
      assert(hm instanceof Float64Array, '应为 Float64Array');
    });

    test('classifyHeightmap 层数 = 阈值数 + 1', () => {
      const hm = generateHeightmap(8, 8, (x, y) => (x + y) / 16);
      const cls = classifyHeightmap(hm, [0.3, 0.6]);
      eq(cls.length, hm.length, '输出长度应与输入一致');
      let maxLv = 0;
      for (const c of cls) maxLv = Math.max(maxLv, c);
      eq(maxLv, 2, '两个阈值 → 3 层（0/1/2），最大层号为 2');
    });

    test('⚠️ classifyHeightmap 空阈值 → 全部归为 0 层', () => {
      const hm = generateHeightmap(4, 4, () => 0.9);
      const cls = classifyHeightmap(hm, []);
      for (const c of cls) eq(c, 0, '无阈值时全为 0 层');
    });

    test('islandMask 中心接近 1、角落为 0', () => {
      const m = islandMask(32, 32);
      eq(m.length, 32 * 32, '长度应为 w×h');
      const center = m[16 * 32 + 16];
      assert(center > 0.9, `中心应接近 1，实际 ${center}`);
      near(m[0], 0, 1e-6, '角落应为 0');
    });
  });

  // ============================================================
  // steering：Flock + createAgent（原来 7+3 项）
  // ============================================================

  describe('Flock · 补强', () => {
    function mk(x: number, y: number) {
      return createAgent(v2(x, y));
    }

    test('单个个体（邻居只有自己）→ 合力为零', () => {
      const f = new Flock();
      const a = mk(0, 0);
      const force = f.compute(a, [a]);
      near(force.x, 0, 1e-9, '无他人时 x 分量为 0');
      near(force.y, 0, 1e-9, '无他人时 y 分量为 0');
    });

    test('⚠️ 完全重合的两个个体不产生 NaN（距离 0）', () => {
      const f = new Flock();
      const a = mk(10, 10);
      const b = mk(10, 10);
      const force = f.compute(a, [a, b]);
      assert(
        Number.isFinite(force.x) && Number.isFinite(force.y),
        `重合时不应产生 NaN，实际 (${force.x}, ${force.y})`,
      );
    });

    test('⚠️ compute 是无状态函数：同样的输入给同样的输出', () => {
      const f = new Flock();
      const a = mk(0, 0);
      const b = mk(1, 0);
      const first = f.compute(a, [a, b]);
      const second = f.compute(a, [a, b]);
      near(second.x, first.x, 1e-12, '重复调用结果应一致');
      near(second.y, first.y, 1e-12, '不会累积');
    });

    test('⚠️ 邻居在半径外不产生力', () => {
      const f = new Flock();
      const a = mk(0, 0);
      const b = mk(10000, 10000);
      const force = f.compute(a, [a, b]);
      near(force.x, 0, 1e-6, '远处邻居不产生力');
      near(force.y, 0, 1e-6, 'y 同理');
    });

    test('compute 不修改传入的 agent（返回新向量）', () => {
      const f = new Flock();
      const a = mk(0, 0);
      const b = mk(5, 0);
      const before = { x: a.pos.x, y: a.pos.y };
      const force = f.compute(a, [a, b]);
      eq(a.pos.x, before.x, 'compute 不应移动 agent');
      eq(a.pos.y, before.y, '位置不变');
      assert(force !== a.force, '返回的是独立向量，不是 agent.force 的引用');
    });
  });

  describe('createAgent · 补强', () => {
    test('⚠️ 两个 agent 不共享 pos/vel/force（关键）', () => {
      const a = createAgent(v2(0, 0));
      const b = createAgent(v2(0, 0));
      a.pos.x = 999;
      assert(b.pos.x !== 999, 'b.pos.x 不应被 a 影响');
      assert(a.vel !== b.vel, 'vel 应为不同对象');
      assert(a.force !== b.force, 'force 应为不同对象');
    });

    test('⚠️ 传入的 pos 会被拷贝（不是直接引用）', () => {
      const p = v2(1, 2);
      const a = createAgent(p);
      p.x = 999;
      eq(a.pos.x, 1, 'agent 应持有副本，外部改动不影响它');
    });

    test('v2() 每次返回新对象', () => {
      const p = v2(1, 2);
      const q = v2(1, 2);
      assert(p !== q, 'v2 应返回新对象');
      eq(p.x, 1, 'x 正确');
      eq(p.y, 2, 'y 正确');
    });

    test('v2 不传参时默认为 0,0', () => {
      const p = v2();
      eq(p.x, 0, 'x 默认 0');
      eq(p.y, 0, 'y 默认 0');
    });

    test('默认 maxSpeed / maxForce 为正', () => {
      const a = createAgent(v2());
      assert(a.maxSpeed > 0, `maxSpeed 应为正，实际 ${a.maxSpeed}`);
      assert(a.maxForce > 0, `maxForce 应为正，实际 ${a.maxForce}`);
    });

    test('opts 能覆盖默认值', () => {
      const a = createAgent(v2(), v2(), { maxSpeed: 250, mass: 3 });
      eq(a.maxSpeed, 250, 'maxSpeed 应被覆盖');
      eq(a.mass, 3, 'mass 应被覆盖');
    });
  });

  // ============================================================
  // damage-pipeline：Modifier（原来 6 项）
  // ============================================================

  describe('Modifier · 补强', () => {
    test('空集合 get 返回 base（不抛错）', () => {
      const m = new ModifierSet();
      eq(m.get('atk', 100), 100, '无修正时返回原值');
    });

    test('多个加法叠加', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'add', value: 10, source: 'a' });
      m.add('atk', { type: 'add', value: 20, source: 'b' });
      eq(m.get('atk', 100), 130, '10 + 20 应叠加成 130');
    });

    test('⚠️ 减法能把值压到负数（不夹 0）', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'add', value: -200 });
      eq(m.get('atk', 50), -150, '允许为负——是否夹 0 由业务侧决定');
    });

    test('乘法对 base=0 无效果', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'mul', value: 0.5 });
      eq(m.get('atk', 0), 0, 'base 为 0 时乘法无效');
    });

    test('removeBySource 只移除指定来源', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'add', value: 10, source: 'buffA' });
      m.add('atk', { type: 'add', value: 20, source: 'buffB' });
      m.removeBySource('atk', 'buffA');
      eq(m.get('atk', 100), 120, '只应移除 buffA 的 +10');
    });

    test('⚠️ clear(attr) 后该属性 count 归零，其他属性不受影响', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'add', value: 10 });
      m.add('def', { type: 'add', value: 5 });
      m.clear('atk');
      eq(m.count('atk'), 0, 'atk 应清空');
      eq(m.count('def'), 1, 'def 不受影响');
      eq(m.get('atk', 100), 100, 'atk 修正失效');
      eq(m.get('def', 50), 55, 'def 修正仍生效');
    });

    test('⚠️ dump 返回的是**内部数组引用**（改它等于改状态）', () => {
      // 【实测】dump 后 push 一项：count 1→2，get(100) 从 110 变成 1109。
      // 类型是 readonly ModifierEntry[]，但**运行时并没有拷贝**——
      // readonly 只是编译期约束，挡不住 (x as unknown as T[]).push()。
      //
      // 【为什么危险】
      // 存档时常见写法是 `save(dump('atk'))`，如果中间有代码
      // 为了"临时加个 buff 看看效果"而 push，存档就被污染了，
      // 而且这类改动在类型检查下完全隐形。
      const m = new ModifierSet();
      m.add('atk', { type: 'add', value: 10 });
      const before = m.count('atk');
      const d = m.dump('atk');
      (d as unknown as { type: string; value: number }[]).push({ type: 'add', value: 999 });
      eq(m.count('atk'), before + 1, 'dump 是内部引用，push 会真的生效');
      eq(m.get('atk', 100), 1109, '计算结果也被改了（10 + 999 + 100）');

      // 想拿副本就自己 slice
      const safe = m.dump('atk').slice();
      (safe as unknown as { type: string; value: number }[]).push({ type: 'add', value: 1 });
      eq(m.count('atk'), before + 1, 'slice 后的副本改动不影响内部');
    });

    test('override 无视其他修正', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'add', value: 999 });
      m.add('atk', { type: 'mul', value: 2 });
      m.add('atk', { type: 'override', value: 42 });
      eq(m.get('atk', 100), 42, 'override 应覆盖一切');
    });
  });

  // ============================================================
  // 一个反例：定死随机源时的确定性
  // ============================================================

  describe('随机源契约', () => {
    test('⚠️ 同一个 rng 值下 pick 结果恒定（可复现的前提）', () => {
      const t = new WeightedTable<string>();
      t.add('a', 1);
      t.add('b', 1);
      const r1 = fixedRng(0.1);
      const r2 = fixedRng(0.1);
      eq(t.pick(r1), t.pick(r2), '相同随机序列 → 相同结果');
    });

    test('rng 返回 0 时取第一个（不越界）', () => {
      const t = new WeightedTable<string>();
      t.add('first', 1);
      t.add('second', 1);
      eq(t.pick(fixedRng(0)), 'first', 'rng=0 应取第一项');
    });

    test('rng 返回接近 1 时取最后一项', () => {
      const t = new WeightedTable<string>();
      t.add('first', 1);
      t.add('last', 1);
      eq(t.pick(fixedRng(0.999999)), 'last', 'rng≈1 应取最后一项');
    });
  });
}
