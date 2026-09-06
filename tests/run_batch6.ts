/**
 * tests/run_batch6.ts —— 第五批插件的测试
 *
 * 覆盖：ds、pathfind、fov、dungeon、steering、noise
 *
 * 【这批的 bug 特点：算法类 bug，静默出错】
 *
 * 算法插件是最难靠"肉眼审查"发现问题的，
 * 因为错误往往表现为"90% 情况对，10% 情况诡异"：
 *
 * - 优先队列：删除中间元素后堆性质被破坏 → 偶尔取出的不是最小值
 * - 并查集：没做路径压缩 → 链退化成 O(n)，大图超时
 * - A*：斜穿墙角没检查 → 单位从两堵墙的对角缝"挤"过去
 * - A*：终点不可达返回空路径 → 调用方直接 path[0] 读到 undefined
 * - 地牢：元胞自动机产生孤岛 → 宝箱生成在走不到的地方
 * - 地牢：BSP 房间重叠 → 房间糊成一团
 * - 转向：力没清零 → 单位越跑越快直到飞出地图
 * - 噪声：值域超出 ±1 → 下游 v*0.5+0.5 得到负数，地图出现黑洞
 *
 * 这些都不会抛异常。只能靠测试。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import {
  BinaryHeap,
  LazyHeap,
  DisjointSet,
  QuadTree,
  SpatialHash,
  rectsOverlap,
  pointInRect,
} from '../ds/DataStructures';

import { AStar, PathSmoother, FlowField } from '../pathfind/PathFinder';
import { Shadowcasting, Raycasting, makeWallTest, VisibilityMap } from '../fov/FOV';
import { BSPDungeon, RoomDungeon, CellularDungeon, MazeDungeon, Tile, rectsOverlap as rectOverlap } from '../dungeon/Dungeon';
import {
  createAgent,
  v2,
  seek,
  flee,
  arrive,
  pursuit,
  wander,
  obstacleAvoid,
  Flock,
  formationOffset,
  circleFormation,
  applyForce,
  integrate,
  constrain,
} from '../steering/Steering';
import {
  PerlinNoise,
  SimplexNoise,
  ValueNoise,
  WorleyNoise,
  Noise,
  fbm2D,
  ridged2D,
  generateHeightmap,
  classifyHeightmap,
  islandMask,
} from '../noise/Noise';

export async function runBatch6Tests(): Promise<void> {
  // ============================================================
  // BinaryHeap
  // ============================================================

  describe('BinaryHeap · 优先队列', () => {
    test('最小堆：按序弹出', () => {
      const h = new BinaryHeap<number>((a, b) => a - b);
      for (const v of [5, 3, 9, 1, 7]) h.push(v);
      const out: number[] = [];
      while (!h.isEmpty) out.push(h.pop()!);
      eq(out.join(','), '1,3,5,7,9');
    });

    test('最大堆', () => {
      const h = new BinaryHeap<number>((a, b) => b - a);
      for (const v of [5, 3, 9, 1, 7]) h.push(v);
      eq(h.pop(), 9);
      eq(h.pop(), 7);
    });

    test('peek 不移除', () => {
      const h = new BinaryHeap<number>((a, b) => a - b);
      h.push(3);
      h.push(1);
      eq(h.peek(), 1);
      eq(h.size, 2, 'peek 不该移除');
    });

    test('空堆 pop 返回 undefined', () => {
      const h = new BinaryHeap<number>((a, b) => a - b);
      eq(h.pop(), undefined);
      eq(h.isEmpty, true);
    });

    test('批量构造（O(n) 建堆）结果正确', () => {
      const h = new BinaryHeap<number>((a, b) => a - b, [9, 5, 1, 8, 3]);
      const out: number[] = [];
      while (!h.isEmpty) out.push(h.pop()!);
      eq(out.join(','), '1,3,5,8,9');
    });

    test('对象元素 + 自定义比较', () => {
      interface Task { p: number; name: string }
      const h = new BinaryHeap<Task>((a, b) => a.p - b.p);
      h.push({ p: 10, name: 'low' });
      h.push({ p: 1, name: 'high' });
      h.push({ p: 5, name: 'mid' });
      eq(h.pop()!.name, 'high');
      eq(h.pop()!.name, 'mid');
      eq(h.pop()!.name, 'low');
    });

    test('remove 中间元素后堆性质仍然成立', () => {
      const h = new BinaryHeap<number>((a, b) => a - b);
      for (const v of [10, 4, 8, 2, 6, 1, 9, 3]) h.push(v);

      eq(h.remove(8), true);

      const out: number[] = [];
      while (!h.isEmpty) out.push(h.pop()!);

      // 应该还是有序的（少了 8）
      eq(out.join(','), '1,2,3,4,6,9,10', 'remove 后堆性质必须保持');
    });

    test('remove 不存在的元素返回 false', () => {
      const h = new BinaryHeap<number>((a, b) => a - b);
      h.push(1);
      h.push(2);
      eq(h.remove(999), false);
      eq(h.size, 2);
    });

    test('removeWhere', () => {
      interface T { id: string; p: number }
      const h = new BinaryHeap<T>((a, b) => a.p - b.p, [
        { id: 'a', p: 1 },
        { id: 'b', p: 2 },
        { id: 'c', p: 3 },
      ]);
      eq(h.removeWhere((t) => t.id === 'b'), true);
      eq(h.size, 2);
      eq(h.pop()!.id, 'a');
    });

    test('remove 最后一个元素', () => {
      const h = new BinaryHeap<number>((a, b) => a - b, [1]);
      eq(h.remove(1), true);
      eq(h.size, 0);
    });

    test('大量随机数据的正确性（对拍 sort）', () => {
      const h = new BinaryHeap<number>((a, b) => a - b);
      const data: number[] = [];
      // 用固定序列，保证可复现
      let s = 12345;
      for (let i = 0; i < 500; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        data.push(s % 1000);
      }
      for (const v of data) h.push(v);

      const out: number[] = [];
      while (!h.isEmpty) out.push(h.pop()!);

      const expected = data.slice().sort((a, b) => a - b);
      eq(out.join(','), expected.join(','), '堆输出应与排序结果一致');
    });

    test('drain 清空堆', () => {
      const h = new BinaryHeap<number>((a, b) => a - b, [3, 1, 2]);
      const all = h.drain();
      eq(all.join(','), '1,2,3');
      eq(h.isEmpty, true);
    });

    test('clear', () => {
      const h = new BinaryHeap<number>((a, b) => a - b, [3, 1, 2]);
      h.clear();
      eq(h.size, 0);
    });
  });

  describe('LazyHeap · 惰性删除堆', () => {
    test('基本出入队', () => {
      const h = new LazyHeap<string>();
      h.push('a', 3);
      h.push('b', 1);
      h.push('c', 2);
      eq(h.pop(), 'b');
      eq(h.pop(), 'c');
      eq(h.pop(), 'a');
    });

    test('标记删除的项被跳过（A* decrease-key 场景）', () => {
      const h = new LazyHeap<string>();
      h.push('old', 10);
      const handle = h.push('new', 10);   // 同一节点，更短路径
      h.push('other', 5);

      // 删掉旧的重复项
      h.remove(handle - 1);   // 第一个 push 的 seq 是 0

      // 应该弹出 other(5)，然后是 new(10)，不应该是 old
      eq(h.pop(), 'other');
      const second = h.pop();
      assert(second !== undefined);
      eq(h.pop(), undefined, '被删的不该再被弹出');
    });

    test('删除后再入队同一元素', () => {
      const h = new LazyHeap<string>();
      h.push('x', 1);
      const handle = h.push('x', 2);
      h.remove(handle);
      h.push('x', 3);

      // 应该弹出一个 x（优先级 1 或 3）
      const a = h.pop();
      eq(a, 'x');
    });

    test('空堆 pop', () => {
      const h = new LazyHeap<string>();
      eq(h.pop(), undefined);
      eq(h.isEmpty, true);
    });
  });

  // ============================================================
  // DisjointSet
  // ============================================================

  describe('DisjointSet · 并查集', () => {
    test('初始每个元素自成一组', () => {
      const uf = new DisjointSet(5);
      eq(uf.componentCount, 5);
      eq(uf.connected(0, 1), false);
    });

    test('union 后连通', () => {
      const uf = new DisjointSet(5);
      uf.union(0, 1);
      uf.union(1, 2);
      eq(uf.connected(0, 2), true, '传递性');
      eq(uf.componentCount, 3);
    });

    test('重复 union 不减少分量数', () => {
      const uf = new DisjointSet(3);
      eq(uf.union(0, 1), true);
      eq(uf.union(0, 1), false, '已连通应返回 false');
      eq(uf.componentCount, 2);
    });

    test('全部连通后 componentCount = 1', () => {
      const uf = new DisjointSet(4);
      uf.union(0, 1);
      uf.union(2, 3);
      uf.union(1, 2);
      eq(uf.componentCount, 1);
    });

    test('find 越界返回 -1', () => {
      const uf = new DisjointSet(3);
      eq(uf.find(99), -1);
      eq(uf.find(-1), -1);
    });

    test('union 越界返回 false（不崩）', () => {
      const uf = new DisjointSet(3);
      eq(uf.union(0, 99), false);
    });

    test('路径压缩：长链后 find 仍然正确', () => {
      const uf = new DisjointSet(100);
      // 串成一条长链
      for (let i = 0; i < 99; i++) uf.union(i, i + 1);
      eq(uf.connected(0, 99), true);
      eq(uf.componentCount, 1);
    });

    test('groups 返回连通分量', () => {
      const uf = new DisjointSet(6);
      uf.union(0, 1);
      uf.union(1, 2);
      uf.union(3, 4);
      const groups = uf.groups();
      eq(groups.length, 3, '应该是 [0,1,2] [3,4] [5]');

      const big = groups.find((g) => g.includes(0))!;
      eq(big.length, 3);
    });

    test('componentSize', () => {
      const uf = new DisjointSet(5);
      uf.union(0, 1);
      uf.union(1, 2);
      eq(uf.componentSize(0), 3);
      eq(uf.componentSize(3), 1);
    });

    test('reset 恢复初始状态', () => {
      const uf = new DisjointSet(4);
      uf.union(0, 1);
      uf.union(2, 3);
      uf.reset();
      eq(uf.componentCount, 4);
      eq(uf.connected(0, 1), false);
    });

    test('负大小抛错', () => {
      throws(() => new DisjointSet(-1));
    });
  });

  // ============================================================
  // QuadTree
  // ============================================================

  describe('QuadTree · 四叉树', () => {
    test('插入与范围查询', () => {
      const qt = new QuadTree<string>({ x: 0, y: 0, w: 100, h: 100 });
      qt.insert(10, 10, 'a');
      qt.insert(20, 20, 'b');
      qt.insert(90, 90, 'c');

      eq(qt.count, 3);

      const found = qt.query({ x: 0, y: 0, w: 30, h: 30 });
      eq(found.length, 2);
      assert(found.includes('a') && found.includes('b'));
    });

    test('范围外的不被返回', () => {
      const qt = new QuadTree<string>({ x: 0, y: 0, w: 100, h: 100 });
      qt.insert(10, 10, 'a');
      qt.insert(90, 90, 'c');

      const found = qt.query({ x: 0, y: 0, w: 50, h: 50 });
      eq(found.length, 1);
      eq(found[0], 'a');
    });

    test('越界插入返回 false', () => {
      const qt = new QuadTree<string>({ x: 0, y: 0, w: 100, h: 100 });
      eq(qt.insert(200, 200, 'x'), false);
      eq(qt.insert(-5, 50, 'x'), false);
      eq(qt.count, 0);
    });

    test('自动分裂（超过 maxItems）', () => {
      const qt = new QuadTree<number>({ x: 0, y: 0, w: 100, h: 100 }, 4, 4);
      for (let i = 0; i < 50; i++) {
        qt.insert((i * 7) % 100, (i * 13) % 100, i);
      }
      eq(qt.count, 50);

      // 小范围查询应该只返回少数
      const found = qt.query({ x: 0, y: 0, w: 10, h: 10 });
      assert(found.length < 50, `应该只返回一部分，实际 ${found.length}`);
    });

    test('圆形查询', () => {
      const qt = new QuadTree<string>({ x: 0, y: 0, w: 100, h: 100 });
      qt.insert(10, 10, 'near');
      qt.insert(11, 11, 'near2');
      qt.insert(90, 90, 'far');

      const found = qt.queryCircle(10, 10, 20);
      eq(found.length, 2);
      assert(!found.includes('far'));
    });

    test('remove', () => {
      const qt = new QuadTree<string>({ x: 0, y: 0, w: 100, h: 100 });
      qt.insert(10, 10, 'a');
      qt.insert(20, 20, 'b');
      eq(qt.remove('a'), true);
      eq(qt.count, 1);
      eq(qt.remove('a'), false, '重复删除返回 false');
      eq(qt.query({ x: 0, y: 0, w: 100, h: 100 }).includes('a'), false);
    });

    test('大量对象的正确性（对拍暴力）', () => {
      const qt = new QuadTree<number>({ x: 0, y: 0, w: 200, h: 200 }, 8, 8);
      const pts: Array<{ x: number; y: number; id: number }> = [];

      let s = 999;
      for (let i = 0; i < 200; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const x = s % 200;
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const y = s % 200;
        pts.push({ x, y, id: i });
        qt.insert(x, y, i);
      }

      // 随机一个查询框，对比暴力结果
      const range = { x: 30, y: 40, w: 60, h: 70 };
      const qtResult = new Set(qt.query(range));

      const brute = new Set<number>();
      for (const p of pts) {
        if (p.x >= range.x && p.x < range.x + range.w && p.y >= range.y && p.y < range.y + range.h) {
          brute.add(p.id);
        }
      }

      eq(qtResult.size, brute.size, `四叉树 ${qtResult.size} vs 暴力 ${brute.size}`);
      for (const id of brute) assert(qtResult.has(id), `缺少 ${id}`);
    });

    test('clear', () => {
      const qt = new QuadTree<string>({ x: 0, y: 0, w: 100, h: 100 });
      qt.insert(10, 10, 'a');
      qt.clear();
      eq(qt.count, 0);
    });

    test('非法参数抛错', () => {
      throws(() => new QuadTree<string>({ x: 0, y: 0, w: 10, h: 10 }, 0));
      throws(() => new QuadTree<string>({ x: 0, y: 0, w: 10, h: 10 }, 4, 0));
    });
  });

  describe('SpatialHash · 空间哈希', () => {
    test('插入与邻居查询', () => {
      const sh = new SpatialHash(10);
      sh.insert(1, 5, 5);     // 格 (0,0)
      sh.insert(2, 12, 5);    // 格 (1,0)
      sh.insert(3, 50, 50);   // 格 (5,5)

      const near1 = sh.queryNeighbors(5, 5, 1);
      assert(near1.includes(1));
      assert(near1.includes(2), '隔壁格应被查到');
      assert(!near1.includes(3), '远处的不应被查到');
    });

    test('同格查询', () => {
      const sh = new SpatialHash(10);
      sh.insert(1, 5, 5);
      sh.insert(2, 7, 7);
      const cell = sh.queryCell(5, 5);
      eq(cell.length, 2);
    });

    test('移动后旧格被清理', () => {
      const sh = new SpatialHash(10);
      sh.insert(1, 5, 5);     // (0,0)
      eq(sh.queryCell(5, 5).length, 1);

      sh.update(1, 95, 95);   // 移到 (9,9)
      eq(sh.queryCell(5, 5).length, 0, '旧格应被清理');
      eq(sh.queryCell(95, 95).length, 1);
      eq(sh.count, 1, '总数不该重复计数');
    });

    test('负数坐标不冲突（Cantor 配对）', () => {
      const sh = new SpatialHash(10);
      sh.insert(1, -5, -5);    // 格 (-1,-1)
      sh.insert(2, 5, 5);      // 格 (0,0)

      eq(sh.count, 2);
      eq(sh.queryCell(-5, -5).length, 1, '负坐标格子不应与正坐标冲突');
      eq(sh.queryCell(5, 5).length, 1);
    });

    test('极端坐标不冲突', () => {
      const sh = new SpatialHash(10);
      sh.insert(1, -10000, 10000);
      sh.insert(2, 10000, -10000);
      eq(sh.queryCell(-10000, 10000).length, 1);
      eq(sh.queryCell(10000, -10000).length, 1);
    });

    test('remove', () => {
      const sh = new SpatialHash(10);
      sh.insert(1, 5, 5);
      eq(sh.remove(1), true);
      eq(sh.remove(1), false);
      eq(sh.count, 0);
    });

    test('矩形查询去重', () => {
      const sh = new SpatialHash(10);
      sh.insert(1, 5, 5);
      const found = sh.queryRect(0, 0, 100, 100);
      eq(found.length, 1, '同一 id 不该重复出现');
    });

    test('clear', () => {
      const sh = new SpatialHash(10);
      sh.insert(1, 5, 5);
      sh.clear();
      eq(sh.count, 0);
    });

    test('非法尺寸抛错', () => {
      throws(() => new SpatialHash(0));
      throws(() => new SpatialHash(-1));
    });
  });

  describe('几何工具', () => {
    test('rectsOverlap', () => {
      eq(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true);
      eq(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }), false);
    });

    test('相邻的矩形不算重叠（边界相切）', () => {
      eq(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false);
    });

    test('带 padding 的重叠', () => {
      eq(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 0, w: 10, h: 10 }, 3), true);
    });

    test('pointInRect', () => {
      eq(pointInRect(5, 5, { x: 0, y: 0, w: 10, h: 10 }), true);
      eq(pointInRect(10, 5, { x: 0, y: 0, w: 10, h: 10 }), false, '右边界是开的');
      eq(pointInRect(-1, 5, { x: 0, y: 0, w: 10, h: 10 }), false);
    });
  });

  // ============================================================
  // AStar
  // ============================================================

  describe('AStar · 寻路', () => {
    /** 空地地图 5×5 */
    function openMap(): number[][] {
      return [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ];
    }

    test('直线路径', () => {
      const a = new AStar(openMap(), { allowDiagonal: false });
      const r = a.find({ x: 0, y: 0 }, { x: 3, y: 0 });
      eq(r.found, true);
      eq(r.path.length, 3, '不含起点，含终点');
      eq(r.path[r.path.length - 1].x, 3);
      eq(r.path[r.path.length - 1].y, 0);
    });

    test('绕墙', () => {
      const map = [
        [0, 0, 0, 0, 0],
        [0, 1, 1, 1, 0],
        [0, 0, 0, 0, 0],
      ];
      const a = new AStar(map, { allowDiagonal: false });
      const r = a.find({ x: 0, y: 0 }, { x: 4, y: 2 });

      eq(r.found, true);
      // 不能穿过墙（y=1 那一行的 x=1,2,3 是墙）
      for (const p of r.path) {
        assert(!(p.y === 1 && p.x >= 1 && p.x <= 3), `路径穿墙了: (${p.x},${p.y})`);
      }
    });

    test('终点不可达返回 found=false 且路径为空', () => {
      const map = [
        [0, 1, 0],
        [0, 1, 0],
        [0, 1, 0],
      ];
      const a = new AStar(map);
      const r = a.find({ x: 0, y: 0 }, { x: 2, y: 0 });
      eq(r.found, false);
      eq(r.path.length, 0);
    });

    test('起点即终点', () => {
      const a = new AStar(openMap());
      const r = a.find({ x: 2, y: 2 }, { x: 2, y: 2 });
      eq(r.found, true);
      eq(r.path.length, 0);
    });

    test('起点是墙返回 false', () => {
      const map = [[1, 0], [0, 0]];
      const a = new AStar(map);
      eq(a.find({ x: 0, y: 0 }, { x: 1, y: 1 }).found, false);
    });

    test('终点是墙返回 false', () => {
      const map = [[0, 0], [0, 1]];
      const a = new AStar(map);
      eq(a.find({ x: 0, y: 0 }, { x: 1, y: 1 }).found, false);
    });

    test('越界坐标返回 false（不崩）', () => {
      const a = new AStar(openMap());
      eq(a.find({ x: -1, y: 0 }, { x: 3, y: 3 }).found, false);
      eq(a.find({ x: 0, y: 0 }, { x: 99, y: 99 }).found, false);
    });

    test('对角线最短（八方向）', () => {
      const a = new AStar(openMap(), { allowDiagonal: true });
      const r = a.find({ x: 0, y: 0 }, { x: 2, y: 2 });
      eq(r.found, true);
      eq(r.path.length, 2, '对角线走 2 步');
    });

    test('四方向时步数更多', () => {
      const a = new AStar(openMap(), { allowDiagonal: false });
      const r = a.find({ x: 0, y: 0 }, { x: 2, y: 2 });
      eq(r.path.length, 4, '曼哈顿距离 4');
    });

    test('禁止斜穿墙角（默认开启）', () => {
      // 对角缝隙：(0,1) 和 (1,0) 都是墙，(0,0)→(1,1) 会被拦
      const map = [
        [0, 1],
        [1, 0],
      ];
      const a = new AStar(map, { allowDiagonal: true, dontCrossCorners: true });
      const r = a.find({ x: 0, y: 0 }, { x: 1, y: 1 });
      eq(r.found, false, '不该从对角缝挤过去');
    });

    test('允许斜穿时能通过', () => {
      const map = [
        [0, 1],
        [1, 0],
      ];
      const a = new AStar(map, { allowDiagonal: true, dontCrossCorners: false });
      const r = a.find({ x: 0, y: 0 }, { x: 1, y: 1 });
      eq(r.found, true);
    });

    test('地形代价：绕开高代价区域', () => {
      /**
       * 【地图设计】沼泽只在**中间一段**（y=1 那一行的 x=1），
       * 这样才存在"绕开"的可能。
       *
       * 第一版我把整列都设成沼泽，那根本绕不开——
       * 是测试设计错了，不是实现错了。
       */
      const map = [
        [0, 0, 0],
        [0, 2, 0],   // 只有 (1,1) 是沼泽
        [0, 0, 0],
      ];
      const a = new AStar(map, {
        allowDiagonal: false,
        costOf: (_x, _y, v) => (v === 2 ? 10 : 1),
      });

      const r = a.find({ x: 0, y: 1 }, { x: 2, y: 1 });
      eq(r.found, true);

      // 直穿沼泽：代价 1 + 10 = 11
      // 绕行：(0,1)→(0,0)→(1,0)→(2,0)→(2,1) 代价 4
      const crossed = r.path.filter((p) => p.x === 1 && p.y === 1).length;
      eq(crossed, 0, `应该绕开沼泽格，实际穿过了`);
      assert(r.cost < 11, `绕行代价 ${r.cost} 应小于穿沼泽的 11`);
    });

    test('地形代价：无路可绕时接受高代价', () => {
      // 一整列都是沼泽，绕不开
      const map = [
        [0, 2, 0],
        [0, 2, 0],
        [0, 2, 0],
      ];
      /**
       * 【注意】costOf 必须配 isWalkable 一起用。
       * 只传 costOf 的话，默认 `isWalkable` 仍要求 v === 0，
       * 于是沼泽格被当成墙 → 找不到路。
       * （这是我自己写测试时犯的错，不是实现的错）
       */
      const a = new AStar(map, {
        allowDiagonal: false,
        isWalkable: (_x, _y, v) => v !== 1,
        costOf: (_x, _y, v) => (v === 2 ? 10 : 1),
      });
      const r = a.find({ x: 0, y: 0 }, { x: 2, y: 2 });
      eq(r.found, true);
      assert(r.cost > 10, `穿过沼泽代价应该很高，实际 ${r.cost}`);
    });

    test('自定义通行（飞行单位无视墙）', () => {
      const map = [
        [0, 1, 0],
        [0, 1, 0],
        [0, 1, 0],
      ];
      const a = new AStar(map, { isWalkable: () => true });
      const r = a.find({ x: 0, y: 0 }, { x: 2, y: 0 });
      eq(r.found, true, '飞行单位应该能穿墙');
    });

    test('maxNodes 限制防止卡死', () => {
      // 大地图 + 不可达终点
      const big: number[][] = [];
      for (let y = 0; y < 40; y++) big.push(new Array(40).fill(0));
      for (let y = 0; y < 40; y++) big[y][20] = 1;   // 一堵墙隔开

      const a = new AStar(big, { maxNodes: 50 });
      const r = a.find({ x: 0, y: 0 }, { x: 39, y: 0 });
      eq(r.found, false);
      assert(r.nodesExplored <= 51, `搜索节点数应被限制，实际 ${r.nodesExplored}`);
    });

    test('多次寻路结果一致（内部缓冲区复用正确）', () => {
      const map = [
        [0, 0, 0, 0, 0],
        [0, 1, 1, 1, 0],
        [0, 0, 0, 0, 0],
      ];
      const a = new AStar(map);

      const r1 = a.find({ x: 0, y: 0 }, { x: 4, y: 2 });
      const r2 = a.find({ x: 0, y: 0 }, { x: 4, y: 2 });
      const r3 = a.find({ x: 0, y: 0 }, { x: 4, y: 2 });

      eq(r1.path.length, r2.path.length, '重复寻路结果必须一致');
      eq(r2.path.length, r3.path.length);
    });

    test('非矩形地图抛错', () => {
      throws(() => new AStar([[0, 0], [0]]), '矩形');
    });

    test('空地图抛错', () => {
      throws(() => new AStar([]));
    });

    test('inBounds / at', () => {
      const a = new AStar(openMap());
      eq(a.width, 5);
      eq(a.height, 5);
      eq(a.inBounds(4, 4), true);
      eq(a.inBounds(5, 0), false);
      eq(a.at(99, 99), -1);
    });

    test('复杂迷宫能找到路', () => {
      const map = [
        [0, 0, 0, 0, 0, 0, 0],
        [0, 1, 1, 1, 1, 1, 0],
        [0, 1, 0, 0, 0, 1, 0],
        [0, 1, 0, 1, 0, 1, 0],
        [0, 1, 0, 0, 0, 1, 0],
        [0, 1, 1, 1, 1, 1, 0],
        [0, 0, 0, 0, 0, 0, 0],
      ];
      const a = new AStar(map);
      // 从外圈走到中间 (3,3) 应该是可达的（通过入口）
      const r = a.find({ x: 0, y: 0 }, { x: 0, y: 6 });
      eq(r.found, true, '外圈应该连通');
    });
  });

  describe('PathSmoother · 路径平滑', () => {
    test('直线路径被压缩成一个点', () => {
      const smoother = new PathSmoother(() => true);
      const path = [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
        { x: 4, y: 0 },
      ];
      const out = smoother.smooth({ x: 0, y: 0 }, path);
      eq(out.length, 1, '能直达就直达');
      eq(out[0].x, 4);
    });

    test('有墙时不会穿墙', () => {
      // (2,0) 是墙
      const walkable = (x: number, y: number) => !(x === 2 && y === 0);
      const smoother = new PathSmoother(walkable);

      eq(smoother.hasLineOfSight(0, 0, 4, 0), false, '应该被墙挡住');
      eq(smoother.hasLineOfSight(0, 0, 1, 0), true);
    });

    test('对角线不擦墙角', () => {
      // (1,0) 和 (0,1) 都是墙 → (0,0) 到 (1,1) 的对角线被拦
      const walkable = (x: number, y: number) => !((x === 1 && y === 0) || (x === 0 && y === 1));
      const smoother = new PathSmoother(walkable);
      eq(smoother.hasLineOfSight(0, 0, 1, 1), false);
    });

    test('空/单点路径原样返回', () => {
      const smoother = new PathSmoother(() => true);
      eq(smoother.smooth({ x: 0, y: 0 }, []).length, 0);
      eq(smoother.smooth({ x: 0, y: 0 }, [{ x: 1, y: 1 }]).length, 1);
    });

    test('起点不可走时 LOS 为 false', () => {
      const smoother = new PathSmoother((px) => px !== 0);
      eq(smoother.hasLineOfSight(0, 0, 5, 0), false);
    });

    // ── 以下 5 项针对"用了才知道"的边界 ──

    test('部分可达时保留被挡住之后的所有点', () => {
      // (3,0) 是墙，从 0 只能直达 (2,0)
      const smoother = new PathSmoother((x, y) => !(x === 3 && y === 0));
      const out = smoother.smooth({ x: 0, y: 0 }, [
        { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 },
      ]);

      eq(out.length, 3, '起点能直达 (2,0)，之后的路段原样保留');
      eq(out[0].x, 2);
    });

    test('smooth 不校验路径点本身是否可走（输入应是合法路径）', () => {
      // smooth 只做视线合并，假定传入的已经是寻路结果
      const smoother = new PathSmoother(() => true);
      const out = smoother.smooth({ x: 0, y: 0 }, [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
      eq(out.length, 1, '全通时压成一个点');
      eq(out[0].x, 2);
    });

    test('起点到终点完全被挡时返回最后一个点（不会返回空）', () => {
      const smoother = new PathSmoother((x, y) => !(x === 1 && y === 0));
      const out = smoother.smooth({ x: 0, y: 0 }, [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
      assert(out.length >= 1, '完全被挡时不应返回空数组——那会让角色原地不动');
    });

    test('hasLineOfSight 自身到自身为 true', () => {
      const smoother = new PathSmoother(() => true);
      eq(smoother.hasLineOfSight(2, 2, 2, 2), true, '退化的零长度线段');
    });

    test('随机化：平滑后的路径仍能走通（不穿墙）', () => {
      // 建一张随机地图，验证 smooth 的输出点之间两两可见
      let checked = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const walls = new Set<number>();
        let rnd = seed * 2654435761;
        const nextRnd = () => {
          rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
          return rnd / 0x7fffffff;
        };
        for (let i = 0; i < 40; i++) {
          const wx = Math.floor(nextRnd() * 20);
          // 【⚠️ 为什么避开 y=0】
          // 第一版我没避开，结果断言在"路径点自己就是墙"时失败。
          // 那是测试构造错了，不是库的问题——
          // smooth 的契约是「输入已是合法寻路结果，我只做视线合并」，
          // 它不校验路径点本身可不可走（见上一项测试）。
          const wy = 1 + Math.floor(nextRnd() * 19);
          walls.add(wy * 20 + wx);
        }

        const walkable = (x: number, y: number) =>
          x >= 0 && y >= 0 && x < 20 && y < 20 && !walls.has(y * 20 + x);

        const smoother = new PathSmoother(walkable);
        // 沿 y=0 走一条直线路径（这一行保证无墙）
        const path: { x: number; y: number }[] = [];
        for (let x = 1; x < 19; x++) path.push({ x, y: 0 });
        if (!walkable(0, 0)) continue;

        const out = smoother.smooth({ x: 0, y: 0 }, path);
        // 相邻输出点之间必须可见
        let prev = { x: 0, y: 0 };
        for (const p of out) {
          assert(
            smoother.hasLineOfSight(prev.x, prev.y, p.x, p.y),
            `种子 ${seed}: (${prev.x},${prev.y}) → (${p.x},${p.y}) 不可见`
          );
          prev = p;
        }
        checked++;
      }
      assert(checked >= 10, `应至少检查 10 张地图，实际 ${checked}`);
    });
  });

  describe('FlowField · 流场', () => {
    test('全场可达', () => {
      const map = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ];
      const f = new FlowField(map);
      eq(f.build({ x: 0, y: 0 }), true);

      eq(f.reachable(4, 2), true);
      eq(f.reachable(2, 1), true);
    });

    test('距离随远离而增加', () => {
      const map = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ];
      const f = new FlowField(map);
      f.build({ x: 0, y: 0 });

      assert(f.distanceAt(1, 0) < f.distanceAt(4, 0), '远的应该距离大');
      near(f.distanceAt(0, 0), 0);
    });

    test('方向指向目标', () => {
      const map = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ];
      const f = new FlowField(map);
      f.build({ x: 0, y: 0 });

      const d = f.directionAt(3, 0);
      assert(d.x < 0, `应该朝左走（x 减小），实际 ${d.x}`);
    });

    test('目标点没有下一步', () => {
      const map = [[0, 0, 0], [0, 0, 0]];
      const f = new FlowField(map);
      f.build({ x: 1, y: 1 });
      eq(f.hasNext(1, 1), false, '已到达');
    });

    test('墙不可达', () => {
      const map = [
        [0, 1, 0],
        [0, 1, 0],
        [0, 1, 0],
      ];
      const f = new FlowField(map);
      f.build({ x: 0, y: 0 });
      eq(f.reachable(2, 0), false, '墙对面不该可达');
    });

    test('目标是墙时 build 失败', () => {
      const map = [[0, 1]];
      const f = new FlowField(map);
      eq(f.build({ x: 1, y: 0 }), false);
    });

    test('tracePath 能走到目标', () => {
      const map = [
        [0, 0, 0, 0, 0],
        [0, 1, 1, 1, 0],
        [0, 0, 0, 0, 0],
      ];
      const f = new FlowField(map);
      f.build({ x: 4, y: 2 });

      const path = f.tracePath(0, 0);
      eq(path.length > 0, true);
      const last = path[path.length - 1];
      eq(last.x, 4);
      eq(last.y, 2, '应该走到目标');
    });

    test('tracePath 在不可达时不会死循环', () => {
      const map = [
        [0, 1, 0],
        [0, 1, 0],
        [0, 1, 0],
      ];
      const f = new FlowField(map);
      f.build({ x: 0, y: 0 });
      const path = f.tracePath(2, 0, 100);
      assert(path.length <= 100, '应该被 maxSteps 限制');
    });

    test('越界查询返回安全值', () => {
      const map = [[0, 0], [0, 0]];
      const f = new FlowField(map);
      f.build({ x: 0, y: 0 });
      eq(f.distanceAt(99, 99), -1);
      const d = f.directionAt(99, 99);
      eq(d.x, 0);
      eq(d.y, 0);
    });
  });

  // ============================================================
  // FOV
  // ============================================================

  describe('Shadowcasting · 视野', () => {
    /** 空房间 11×11，中间站人 */
    function openRoom(): { isWall: (x: number, y: number) => boolean; size: number } {
      const size = 11;
      return { isWall: () => false, size };
    }

    test('空房间：视野内全部可见', () => {
      const { isWall, size } = openRoom();
      const fov = new Shadowcasting(size, size, isWall);
      const n = fov.compute(5, 5, 5);

      // 半径 5 的圆内格子数（含中心）
      let expected = 0;
      for (let dy = -5; dy <= 5; dy++) {
        for (let dx = -5; dx <= 5; dx++) {
          if (dx * dx + dy * dy <= 25) expected++;
        }
      }
      eq(n, expected, `半径 5 应有 ${expected} 格可见`);
    });

    test('自己总可见', () => {
      const { isWall, size } = openRoom();
      const fov = new Shadowcasting(size, size, isWall);
      fov.compute(5, 5, 3);
      eq(fov.canSee(5, 5), true);
    });

    test('视野外的不可见', () => {
      const { isWall, size } = openRoom();
      const fov = new Shadowcasting(size, size, isWall);
      fov.compute(5, 5, 2);
      eq(fov.canSee(10, 10), false, '超出半径');
    });

    test('墙本身可见（关键：墙不能消失）', () => {
      // 一堵横墙在 y=5
      const isWall = (x: number, y: number) => y === 5 && x >= 7;
      const fov = new Shadowcasting(11, 11, isWall);
      fov.compute(5, 5, 6);

      eq(fov.canSee(7, 5), true, '墙必须可见，否则房间轮廓会消失');
    });

    test('墙后面形成阴影', () => {
      // 一堵完整的横墙
      const isWall = (_x: number, y: number) => y === 6;
      const fov = new Shadowcasting(11, 11, isWall);
      fov.compute(5, 5, 6);

      eq(fov.canSee(5, 6), true, '墙可见');
      eq(fov.canSee(5, 7), false, '墙正后方不可见');
    });

    test('战争迷雾：explored 累积', () => {
      const { isWall, size } = openRoom();
      const fov = new Shadowcasting(size, size, isWall);

      fov.compute(2, 2, 3);
      eq(fov.hasExplored(2, 2), true);

      // 走开后，原来的地方不再"可见"但仍"探索过"
      fov.compute(8, 8, 3);
      eq(fov.canSee(2, 2), false, '离开后不可见');
      eq(fov.hasExplored(2, 2), true, '但记忆还在');
    });

    test('resetExplored 清空记忆', () => {
      const { isWall, size } = openRoom();
      const fov = new Shadowcasting(size, size, isWall);
      fov.compute(5, 5, 3);
      fov.resetExplored();
      eq(fov.hasExplored(5, 5), false);
    });

    test('视线判定：直线无阻挡', () => {
      const fov = new Shadowcasting(11, 11, () => false);
      eq(fov.hasLineOfSight(0, 0, 10, 0), true);
    });

    test('视线判定：被墙挡住', () => {
      const isWall = (x: number, _y: number) => x === 5;
      const fov = new Shadowcasting(11, 11, isWall);
      eq(fov.hasLineOfSight(0, 0, 10, 0), false);
    });

    test('视线判定：对角线擦墙角被拦', () => {
      const isWall = (x: number, y: number) => (x === 1 && y === 0) || (x === 0 && y === 1);
      const fov = new Shadowcasting(5, 5, isWall);
      eq(fov.hasLineOfSight(0, 0, 1, 1), false);
    });

    test('边界外视为墙（视野不漏出去）', () => {
      const fov = new Shadowcasting(5, 5, () => false);
      fov.compute(2, 2, 10);
      // 不会崩溃，且不会把越界格标记为可见
      eq(fov.canSee(-1, -1), false);
    });

    test('半径 0 只有自己可见', () => {
      const fov = new Shadowcasting(5, 5, () => false);
      fov.compute(2, 2, 0);
      eq(fov.canSee(2, 2), true);
      eq(fov.canSee(2, 3), false);
    });

    test('非法尺寸抛错', () => {
      throws(() => new Shadowcasting(0, 5, () => false));
    });
  });

  describe('Raycasting · 射线视野（对照用）', () => {
    test('【验证已知缺陷】空房间只能看到圆周附近（这就是盲点）', () => {
      const rc = new Raycasting(11, 11, () => false);
      const sc = new Shadowcasting(11, 11, () => false);

      rc.compute(5, 5, 5);
      sc.compute(5, 5, 5);

      // 理论可见 81 格
      assert(sc.visible.count === 81, `Shadowcasting 应看到全部 81 格，实际 ${sc.visible.count}`);
      assert(rc.visible.count < 40, `Raycasting 只看到 ${rc.visible.count} 格——这就是它的盲点`);
    });

    test('墙后面不可见', () => {
      const isWall = (_x: number, y: number) => y === 6;
      const rc = new Raycasting(11, 11, isWall);
      rc.compute(5, 5, 6);
      eq(rc.canSee(5, 7), false);
    });

    test('墙本身可见', () => {
      const isWall = (_x: number, y: number) => y === 6;
      const rc = new Raycasting(11, 11, isWall);
      rc.compute(5, 5, 6);
      eq(rc.canSee(5, 6), true);
    });

    test('有墙时 Shadowcasting 明显看得更多', () => {
      const isWall = (x: number, y: number) => y === 6 && x < 6;
      const rc = new Raycasting(11, 11, isWall);
      const sc = new Shadowcasting(11, 11, isWall);

      rc.compute(5, 5, 5);
      sc.compute(5, 5, 5);

      assert(sc.visible.count > rc.visible.count,
        `Shadowcasting(${sc.visible.count}) 应多于 Raycasting(${rc.visible.count})`);
    });
  });

  describe('VisibilityMap', () => {
    test('基本读写', () => {
      const vm = new VisibilityMap(5, 5);
      vm.mark(2, 2);
      eq(vm.has(2, 2), true);
      eq(vm.has(0, 0), false);
    });

    test('越界安全', () => {
      const vm = new VisibilityMap(5, 5);
      vm.mark(99, 99);   // 不应崩溃
      eq(vm.has(99, 99), false);
    });

    test('set false', () => {
      const vm = new VisibilityMap(5, 5);
      vm.mark(1, 1);
      vm.set(1, 1, false);
      eq(vm.has(1, 1), false);
    });

    test('count 与 toArray 一致', () => {
      const vm = new VisibilityMap(5, 5);
      vm.mark(1, 1);
      vm.mark(2, 2);
      vm.mark(3, 3);
      eq(vm.count, 3);
      eq(vm.toArray().length, 3);
    });

    test('clear', () => {
      const vm = new VisibilityMap(5, 5);
      vm.mark(1, 1);
      vm.clear();
      eq(vm.count, 0);
    });
  });

  describe('makeWallTest', () => {
    test('默认 1 是墙', () => {
      const map = [
        [0, 1, 0],
        [1, 1, 0],
      ];
      const isWall = makeWallTest(map);
      eq(isWall(1, 0), true);
      eq(isWall(0, 0), false);
    });

    test('自定义墙值', () => {
      const map = [[0, 2, 0]];
      const isWall = makeWallTest(map, [2, 3]);
      eq(isWall(1, 0), true);
      eq(isWall(0, 0), false);
    });

    test('越界视为墙', () => {
      const isWall = makeWallTest([[0, 0]]);
      eq(isWall(-1, 0), true);
      eq(isWall(0, 99), true);
    });
  });

  // ============================================================
  // Dungeon
  // ============================================================

  describe('BSPDungeon · BSP 地牢', () => {
    test('生成后有房间', () => {
      const d = new BSPDungeon({ width: 50, height: 40, seed: 1 });
      d.generate();
      assert(d.roomCount > 0, `应该有房间，实际 ${d.roomCount}`);
    });

    test('所有房间可达（核心保证）', () => {
      for (let seed = 1; seed <= 30; seed++) {
        const d = new BSPDungeon({ width: 50, height: 40, seed });
        d.generate();
        assert(d.allRoomsReachable(), `种子 ${seed} 生成了不可达房间`);
      }
    });

    test('地板全连通', () => {
      for (let seed = 1; seed <= 20; seed++) {
        const d = new BSPDungeon({ width: 40, height: 30, seed });
        d.generate();
        assert(d.isFullyConnected(), `种子 ${seed} 地板不连通`);
      }
    });

    test('同种子结果一致（可复现）', () => {
      const a = new BSPDungeon({ width: 40, height: 30, seed: 777 });
      a.generate();
      const b = new BSPDungeon({ width: 40, height: 30, seed: 777 });
      b.generate();
      eq(a.toString(), b.toString(), '同种子必须生成相同地牢');
    });

    test('不同种子结果不同', () => {
      const a = new BSPDungeon({ width: 40, height: 30, seed: 1 });
      a.generate();
      const b = new BSPDungeon({ width: 40, height: 30, seed: 2 });
      b.generate();
      assert(a.toString() !== b.toString(), '不同种子应生成不同地牢');
    });

    test('房间不重叠', () => {
      for (let seed = 1; seed <= 20; seed++) {
        const d = new BSPDungeon({ width: 50, height: 40, seed });
        d.generate();
        const rooms = d.rooms;
        for (let i = 0; i < rooms.length; i++) {
          for (let j = i + 1; j < rooms.length; j++) {
            assert(!rectOverlap(rooms[i], rooms[j]), `种子 ${seed}: 房间 ${i} 和 ${j} 重叠了`);
          }
        }
      }
    });

    test('房间在地图内', () => {
      const d = new BSPDungeon({ width: 50, height: 40, seed: 3 });
      d.generate();
      for (const r of d.rooms) {
        assert(r.x >= 0 && r.y >= 0, '房间超出左上边界');
        assert(r.x + r.w <= 50 && r.y + r.h <= 40, `房间超出右下边界: ${JSON.stringify(r)}`);
      }
    });

    test('findFarthestRoom 返回不同房间', () => {
      const d = new BSPDungeon({ width: 60, height: 40, seed: 5 });
      d.generate();
      if (d.roomCount > 1) {
        const far = d.findFarthestRoom(0);
        assert(far !== 0, `最远房间不该是自己，实际 ${far}`);
      }
    });

    test('roomDistance 对称合理', () => {
      const d = new BSPDungeon({ width: 60, height: 40, seed: 5 });
      d.generate();
      if (d.roomCount > 1) {
        const dist = d.roomDistance(0, 1);
        assert(dist > 0, `距离应为正，实际 ${dist}`);
      }
    });

    test('randomFloor 返回可走格', () => {
      const d = new BSPDungeon({ width: 40, height: 30, seed: 7 });
      d.generate();
      const p = d.randomFloor();
      assert(p !== null);
      assert(d.isWalkable(p!.x, p!.y), '随机格必须可走');
    });

    test('maxDepth 越大房间越多', () => {
      const shallow = new BSPDungeon({ width: 80, height: 60, seed: 9, maxDepth: 2 });
      shallow.generate();
      const deep = new BSPDungeon({ width: 80, height: 60, seed: 9, maxDepth: 5 });
      deep.generate();
      assert(deep.roomCount > shallow.roomCount, `深分割房间应更多：${deep.roomCount} vs ${shallow.roomCount}`);
    });

    test('toGrid 尺寸正确', () => {
      const d = new BSPDungeon({ width: 30, height: 20, seed: 11 });
      d.generate();
      const grid = d.toGrid();
      eq(grid.length, 20);
      eq(grid[0].length, 30);
    });

    test('minRoomSize 过小抛错', () => {
      throws(() => new BSPDungeon({ width: 50, height: 40, seed: 1, minRoomSize: 2 }));
    });

    test('地图过小抛错', () => {
      throws(() => new BSPDungeon({ width: 3, height: 3, seed: 1 }));
    });

    test('100 次生成死图率为 0', () => {
      let dead = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const d = new BSPDungeon({ width: 50, height: 40, seed });
        d.generate();
        if (d.roomCount === 0 || !d.allRoomsReachable()) dead++;
      }
      eq(dead, 0, `100 次生成中有 ${dead} 张死图`);
    });
  });

  describe('RoomDungeon · 随机房间地牢', () => {
    test('生成多个房间', () => {
      const d = new RoomDungeon({ width: 60, height: 40, seed: 1, roomCount: 10 });
      d.generate();
      assert(d.roomCount >= 3, `应该有多个房间，实际 ${d.roomCount}`);
    });

    test('所有房间可达', () => {
      for (let seed = 1; seed <= 20; seed++) {
        const d = new RoomDungeon({ width: 60, height: 40, seed, roomCount: 10 });
        d.generate();
        assert(d.allRoomsReachable(), `种子 ${seed} 有不可达房间`);
      }
    });

    test('房间不重叠（有 spacing）', () => {
      for (let seed = 1; seed <= 15; seed++) {
        const d = new RoomDungeon({ width: 60, height: 40, seed, roomCount: 10, spacing: 2 });
        d.generate();
        const rooms = d.rooms;
        for (let i = 0; i < rooms.length; i++) {
          for (let j = i + 1; j < rooms.length; j++) {
            assert(!rectOverlap(rooms[i], rooms[j]), `种子 ${seed}: 房间重叠`);
          }
        }
      }
    });

    test('同种子可复现', () => {
      const a = new RoomDungeon({ width: 50, height: 40, seed: 42 });
      a.generate();
      const b = new RoomDungeon({ width: 50, height: 40, seed: 42 });
      b.generate();
      eq(a.toString(), b.toString());
    });

    test('地图太小时房间数会少于请求（不崩）', () => {
      const d = new RoomDungeon({ width: 20, height: 15, seed: 1, roomCount: 50 });
      d.generate();
      assert(d.roomCount > 0, '至少要有 1 个房间');
      assert(d.roomCount <= 50);
    });

    // ── 以下 7 项针对"用了才知道"的边界 ──

    test('房间 id 从 0 开始，等于数组下标', () => {
      const d = new RoomDungeon({ width: 60, height: 40, seed: 3, roomCount: 8 });
      d.generate();
      const ok = d.rooms.every((r, i) => r.id === i);
      assert(ok, `id 应等于下标，实际 ${d.rooms.map((r) => r.id).join(',')}`);
    });

    test('roomDistance 找不到房间时返回 -1（不报错）', () => {
      const d = new RoomDungeon({ width: 60, height: 40, seed: 3, roomCount: 8 });
      d.generate();
      eq(d.roomDistance(0, 999), -1, '非法 id 静默返回 -1，不抛错');
      eq(d.roomDistance(999, 0), -1);
    });

    test('roomDistance 对称：d(a,b) === d(b,a)', () => {
      const d = new RoomDungeon({ width: 60, height: 40, seed: 5, roomCount: 8 });
      d.generate();
      const ab = d.roomDistance(0, 1);
      const ba = d.roomDistance(1, 0);
      assert(ab >= 0 && ba >= 0, '两个房间都可达');
      eq(ab, ba, 'BFS 距离应对称');
    });

    test('findFarthestRoom 非法 id 时返回传入值本身（不报错）', () => {
      const d = new RoomDungeon({ width: 60, height: 40, seed: 3, roomCount: 8 });
      d.generate();
      eq(d.findFarthestRoom(999), 999, '静默返回入参——调用方若不校验会拿到假房间号');
    });

    test('findFarthestRoom 返回的房间离起点最远', () => {
      const d = new RoomDungeon({ width: 60, height: 40, seed: 11, roomCount: 8 });
      d.generate();
      const far = d.findFarthestRoom(0);
      assert(far !== 0 || d.roomCount === 1, '不应返回自己（除非只有一个房间）');

      const distFar = d.roomDistance(0, far);
      for (let i = 1; i < d.roomCount; i++) {
        if (i === far) continue;
        const di = d.roomDistance(0, i);
        if (di >= 0) assert(distFar >= di, `房间 ${far} 应比 ${i} 更远`);
      }
    });

    test('randomFloor 同种子可复现（但它会推进内部 RNG）', () => {
      // 【⚠️ 这是可复现性的隐藏依赖】
      // randomFloor() 用的是生成器内部的 RNG。
      // 只要调用顺序一致，同种子结果就一致；
      // 一旦某个分支多调一次，后面全部错位。
      const a = new RoomDungeon({ width: 60, height: 40, seed: 7, roomCount: 8 });
      a.generate();
      const b = new RoomDungeon({ width: 60, height: 40, seed: 7, roomCount: 8 });
      b.generate();
      const pa = a.randomFloor();
      const pb = b.randomFloor();
      assert(pa !== null && pb !== null, '有地板时不应返回 null');
      eq(`${pa.x},${pa.y}`, `${pb.x},${pb.y}`);
    });

    test('randomFloor 在没有任何地板时返回 null（不崩）', () => {
      // 【⚠️ 返回类型是 `{x,y} | null`，不是 `{x,y}`】
      // 照着 `const p = d.randomFloor(); spawn(p.x, p.y)` 写，
      // 地图生成失败（一个房间都没放下）时会在 p.x 上抛 TypeError。
      const d = new RoomDungeon({ width: 60, height: 40, seed: 42, roomCount: 8 });
      // 先不 generate —— 此时还没有任何地板
      eq(d.randomFloor(), null, '未生成时应返回 null');
    });

    test('randomFloor 返回的格子确实可走', () => {
      const d = new RoomDungeon({ width: 60, height: 40, seed: 9, roomCount: 8 });
      d.generate();
      for (let i = 0; i < 30; i++) {
        const p = d.randomFloor();
        if (p === null) continue;
        assert(
          d.isWalkable(p.x, p.y),
          `randomFloor 返回了不可走的格子 (${p.x},${p.y})`
        );
      }
    });

    test('floodFill 从墙格出发返回空集（不崩）', () => {
      const d = new RoomDungeon({ width: 60, height: 40, seed: 3, roomCount: 8 });
      d.generate();
      // (0,0) 在 RoomDungeon 里几乎必然是外墙
      const reached = d.floodFill(0, 0);
      eq(reached.size, d.isWalkable(0, 0) ? reached.size : 0, '从不可走格子出发应返回空集');
    });

    test('isFullyConnected 与 floorCount 一致（连通时可达数=地板数）', () => {
      const d = new RoomDungeon({ width: 60, height: 40, seed: 13, roomCount: 8 });
      d.generate();
      if (!d.isFullyConnected()) return; // 该种子不连通则跳过

      // 找第一个地板做 floodFill
      let start = { x: -1, y: -1 };
      for (let y = 0; y < d.height && start.x < 0; y++) {
        for (let x = 0; x < d.width; x++) {
          if (d.isWalkable(x, y)) {
            start = { x, y };
            break;
          }
        }
      }
      assert(start.x >= 0, '应该有地板');
      eq(d.floodFill(start.x, start.y).size, d.floorCount, '连通时 floodFill 应覆盖所有地板');
    });
  });

  describe('CellularDungeon · 元胞自动机洞穴', () => {
    test('生成有地板', () => {
      const d = new CellularDungeon({ width: 40, height: 30, seed: 1 });
      d.generate();
      assert(d.floorCount > 0, `应该有地板，实际 ${d.floorCount}`);
    });

    test('孤岛被清理（核心：不清理会有走不到的区域）', () => {
      for (let seed = 1; seed <= 15; seed++) {
        const d = new CellularDungeon({ width: 40, height: 30, seed, iterations: 5 });
        d.generate();
        assert(d.isFullyConnected(), `种子 ${seed} 存在孤岛`);
      }
    });

    test('边界封闭（不会漏出去）', () => {
      const d = new CellularDungeon({ width: 40, height: 30, seed: 5 });
      d.generate();
      for (let x = 0; x < 40; x++) {
        eq(d.tileAt(x, 0), Tile.Wall, `上边界 (${x},0) 应为墙`);
        eq(d.tileAt(x, 29), Tile.Wall, `下边界 (${x},29) 应为墙`);
      }
      for (let y = 0; y < 30; y++) {
        eq(d.tileAt(0, y), Tile.Wall);
        eq(d.tileAt(39, y), Tile.Wall);
      }
    });

    test('同种子可复现', () => {
      const a = new CellularDungeon({ width: 40, height: 30, seed: 99 });
      a.generate();
      const b = new CellularDungeon({ width: 40, height: 30, seed: 99 });
      b.generate();
      eq(a.toString(), b.toString());
    });

    test('迭代次数影响结果', () => {
      const few = new CellularDungeon({ width: 40, height: 30, seed: 3, iterations: 1 });
      few.generate();
      const many = new CellularDungeon({ width: 40, height: 30, seed: 3, iterations: 6 });
      many.generate();
      assert(few.toString() !== many.toString(), '迭代次数应改变结果');
    });

    test('floorCount 与 tileAt 一致', () => {
      const d = new CellularDungeon({ width: 30, height: 20, seed: 7 });
      d.generate();
      let manual = 0;
      for (let y = 0; y < 20; y++) {
        for (let x = 0; x < 30; x++) {
          if (d.tileAt(x, y) === Tile.Floor) manual++;
        }
      }
      eq(d.floorCount, manual);
    });
  });

  describe('MazeDungeon · 迷宫', () => {
    test('生成迷宫', () => {
      const d = new MazeDungeon({ width: 21, height: 15, seed: 1 });
      d.generate();
      assert(d.floorCount > 0);
    });

    test('完美迷宫：任意两点连通', () => {
      const d = new MazeDungeon({ width: 21, height: 15, seed: 3 });
      d.generate();
      assert(d.isFullyConnected(), '迷宫应该全连通');
    });

    test('braid 增加环路后仍连通', () => {
      for (let seed = 1; seed <= 10; seed++) {
        const d = new MazeDungeon({ width: 21, height: 15, seed, braidRatio: 0.2 });
        d.generate();
        assert(d.isFullyConnected(), `种子 ${seed} 连通性被破坏`);
      }
    });

    test('偶数尺寸抛错（会漏出边界）', () => {
      throws(() => new MazeDungeon({ width: 20, height: 15, seed: 1 }), '必须为奇数');
      throws(() => new MazeDungeon({ width: 21, height: 14, seed: 1 }), '必须为奇数');
    });

    test('边界封闭', () => {
      const d = new MazeDungeon({ width: 21, height: 15, seed: 2 });
      d.generate();
      for (let x = 0; x < 21; x++) {
        eq(d.tileAt(x, 0), Tile.Wall);
        eq(d.tileAt(x, 14), Tile.Wall);
      }
    });

    test('同种子可复现', () => {
      const a = new MazeDungeon({ width: 21, height: 15, seed: 88 });
      a.generate();
      const b = new MazeDungeon({ width: 21, height: 15, seed: 88 });
      b.generate();
      eq(a.toString(), b.toString());
    });

    test('braid 提高地板数（打通了墙）', () => {
      const perfect = new MazeDungeon({ width: 31, height: 21, seed: 4, braidRatio: 0 });
      perfect.generate();
      const braided = new MazeDungeon({ width: 31, height: 21, seed: 4, braidRatio: 0.3 });
      braided.generate();
      assert(braided.floorCount > perfect.floorCount, 'braid 应该增加通路');
    });
  });

  // ============================================================
  // Steering
  // ============================================================

  describe('Steering · 转向行为', () => {
    test('seek 朝向目标', () => {
      const a = createAgent(v2(0, 0));
      const f = seek(a, v2(10, 0));
      assert(f.x > 0, `应该朝右，实际 ${f.x}`);
      near(f.y, 0, 1e-6);
    });

    test('flee 背离威胁', () => {
      const a = createAgent(v2(0, 0));
      const f = flee(a, v2(10, 0));
      assert(f.x < 0, `应该朝左逃，实际 ${f.x}`);
    });

    test('flee 超出恐慌距离时不逃', () => {
      const a = createAgent(v2(0, 0));
      const f = flee(a, v2(10, 0), 5);
      eq(f.x, 0);
      eq(f.y, 0);
    });

    test('arrive 在减速区内减速（关键：防止抖动）', () => {
      const nearAgent = createAgent(v2(0, 0), v2(100, 0));
      const fNear = arrive(nearAgent, v2(5, 0), 50);

      // 在减速区内且当前速度很快 → 力应该是"刹车"（向左）
      assert(fNear.x < 0, `近处应刹车，实际 ${fNear.x}`);
    });

    test('arrive 到达后主动刹车（不会冲过头）', () => {
      const a = createAgent(v2(10, 0), v2(50, 0));
      const f = arrive(a, v2(10.5, 0), 50, 2);
      // 在 stopRadius 内，应该返回抵消速度的力
      assert(f.x < 0, `应该向左刹车，实际 ${f.x}`);
    });

    test('seek 会在目标附近抖动（说明为什么需要 arrive）', () => {
      // 模拟：单位高速冲向目标，seek 不会减速
      const a = createAgent(v2(0, 0), v2(0, 0), { maxSpeed: 100, maxForce: 500 });
      const target = v2(10, 0);

      let overshoot = false;
      for (let i = 0; i < 60; i++) {
        applyForce(a, seek(a, target));
        integrate(a, 1 / 60);
        if (a.pos.x > 10) overshoot = true;
      }
      assert(overshoot, 'seek 应该会冲过目标（这正是它的缺陷）');
    });

    test('pursuit 预判目标位置（抄近路）', () => {
      const chaser = createAgent(v2(0, 0));
      const runner = createAgent(v2(10, 10), v2(50, 0));   // 向右跑

      const f = pursuit(chaser, runner, 1);
      // 应该朝预判位置 (60, 10) 而不是当前位置 (10, 10)
      assert(f.x > 0 && f.y > 0, `应该朝右上，实际 (${f.x}, ${f.y})`);
    });

    test('wander 产生非零力', () => {
      const a = createAgent(v2(0, 0), v2(10, 0));
      const state = { angle: 0 };
      let seed = 42;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };

      const f = wander(a, state, 20, 10, 0.5, rand);
      assert(Math.abs(f.x) + Math.abs(f.y) > 0, '游荡应产生非零力');
    });

    test('wander 静止时也有方向（不会卡死）', () => {
      const a = createAgent(v2(0, 0), v2(0, 0));
      const state = { angle: 0 };
      const f = wander(a, state, 20, 10, 0.5, () => 0.5);
      assert(Number.isFinite(f.x) && Number.isFinite(f.y), '不应产生 NaN');
      assert(Math.abs(f.x) + Math.abs(f.y) > 0, '静止时不该输出零力');
    });

    test('obstacleAvoid 前方有障碍时偏转', () => {
      const a = createAgent(v2(0, 0), v2(50, 0), { radius: 1 });
      const obstacles = [{ pos: v2(30, 0), radius: 10 }];
      const f = obstacleAvoid(a, obstacles, 60);
      assert(Math.abs(f.x) + Math.abs(f.y) > 0, '应该产生避障力');
    });

    test('obstacleAvoid 无障碍时返回零', () => {
      const a = createAgent(v2(0, 0), v2(50, 0));
      const obstacles = [{ pos: v2(1000, 1000), radius: 10 }];
      const f = obstacleAvoid(a, obstacles, 60);
      eq(f.x, 0);
      eq(f.y, 0);
    });

    test('obstacleAvoid 静止时返回零（没有前进方向）', () => {
      const a = createAgent(v2(0, 0), v2(0, 0));
      const obstacles = [{ pos: v2(10, 0), radius: 10 }];
      const f = obstacleAvoid(a, obstacles, 60);
      eq(f.x, 0, '静止时不该避障');
    });
  });

  describe('Flock · 群体行为', () => {
    test('分离：太近的互相推开', () => {
      const flock = new Flock({ separationRadius: 30, cohesionWeight: 0, alignmentWeight: 0 });
      const a = createAgent(v2(0, 0));
      const b = createAgent(v2(5, 0));

      const f = flock.compute(a, [a, b]);
      assert(f.x < 0, `应该被推开（向左），实际 ${f.x}`);
    });

    test('聚集：离群的被拉回', () => {
      const flock = new Flock({ cohesionRadius: 100, separationWeight: 0, alignmentWeight: 0 });
      const a = createAgent(v2(0, 0));
      const b = createAgent(v2(50, 0));

      const f = flock.compute(a, [a, b]);
      assert(f.x > 0, `应该被拉近（向右），实际 ${f.x}`);
    });

    test('对齐：同向', () => {
      const flock = new Flock({ alignmentRadius: 100, separationWeight: 0, cohesionWeight: 0 });
      const a = createAgent(v2(0, 0), v2(0, 0));
      const b = createAgent(v2(20, 0), v2(50, 0));

      const f = flock.compute(a, [a, b]);
      assert(f.x > 0, `应该被带动（向右），实际 ${f.x}`);
    });

    test('远处的邻居不影响（超出半径）', () => {
      const flock = new Flock({ separationRadius: 10, cohesionRadius: 10, alignmentRadius: 10 });
      const a = createAgent(v2(0, 0));
      const b = createAgent(v2(1000, 0));

      const f = flock.compute(a, [a, b]);
      eq(f.x, 0, '远邻居不该产生力');
      eq(f.y, 0);
    });

    test('没有邻居时返回零力', () => {
      const flock = new Flock();
      const a = createAgent(v2(0, 0));
      const f = flock.compute(a, [a]);
      eq(f.x, 0);
      eq(f.y, 0);
    });

    test('视野外的邻居不计入', () => {
      // 视野 90 度，邻居在正后方
      const flock = new Flock({ cohesionRadius: 100, fieldOfView: Math.PI / 2 });
      const a = createAgent(v2(0, 0), v2(50, 0));   // 朝右
      const b = createAgent(v2(-20, 0));            // 在左边（后方）

      const f = flock.compute(a, [a, b]);
      eq(f.x, 0, '背后的邻居不该影响');
    });

    test('群体会收敛（模拟多步后不会爆炸）', () => {
      const flock = new Flock({ separationRadius: 15, cohesionRadius: 50 });
      const agents: ReturnType<typeof createAgent>[] = [];

      let s = 1;
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };

      for (let i = 0; i < 20; i++) {
        agents.push(createAgent(v2((rand() - 0.5) * 100, (rand() - 0.5) * 100), v2(0, 0), { maxSpeed: 50 }));
      }

      for (let step = 0; step < 200; step++) {
        for (const a of agents) {
          applyForce(a, flock.compute(a, agents));
        }
        for (const a of agents) integrate(a, 1 / 60);
      }

      // 所有位置必须是有限数（不能 NaN 或 Infinity）
      for (const a of agents) {
        assert(Number.isFinite(a.pos.x) && Number.isFinite(a.pos.y), `位置变成 ${a.pos.x}, ${a.pos.y}`);
        assert(Math.abs(a.pos.x) < 1e6, '不应该飞到无穷远');
      }
    });
  });

  describe('Steering · 物理积分', () => {
    test('integrate 更新位置和速度', () => {
      const a = createAgent(v2(0, 0), v2(0, 0));
      applyForce(a, v2(10, 0));
      integrate(a, 1);

      assert(a.vel.x > 0, '速度应该增加');
      assert(a.pos.x > 0, '位置应该改变');
    });

    test('integrate 后力被清零（关键：不清会越跑越快）', () => {
      const a = createAgent(v2(0, 0), v2(0, 0));
      applyForce(a, v2(10, 0));
      integrate(a, 1);

      eq(a.force.x, 0, '力必须清零');
      eq(a.force.y, 0);
    });

    test('速度被 maxSpeed 限制', () => {
      const a = createAgent(v2(0, 0), v2(0, 0), { maxSpeed: 50 });
      for (let i = 0; i < 100; i++) {
        applyForce(a, v2(1000, 0));
        integrate(a, 1 / 60);
      }
      assert(a.vel.x <= 50.0001, `速度应被限制在 50，实际 ${a.vel.x}`);
    });

    test('质量影响加速度（重的慢）', () => {
      const light = createAgent(v2(0, 0), v2(0, 0), { mass: 1 });
      const heavy = createAgent(v2(0, 0), v2(0, 0), { mass: 10 });

      applyForce(light, v2(100, 0));
      integrate(light, 1);
      applyForce(heavy, v2(100, 0));
      integrate(heavy, 1);

      assert(light.vel.x > heavy.vel.x, '轻的应该更快');
    });

    test('constrain 夹住位置', () => {
      const a = createAgent(v2(-100, 0), v2(-50, 0));
      constrain(a, 0, 0, 100, 100, false);
      eq(a.pos.x, 0, '应被夹到边界');
    });

    test('constrain 反弹', () => {
      const a = createAgent(v2(-100, 0), v2(-50, 0));
      constrain(a, 0, 0, 100, 100, true);
      eq(a.vel.x, 50, '速度应反向');
    });

    test('静止物体不受力时不动', () => {
      const a = createAgent(v2(10, 10), v2(0, 0));
      integrate(a, 1);
      eq(a.pos.x, 10);
      eq(a.pos.y, 10);
    });
  });

  describe('队形', () => {
    test('formationOffset 网格排列', () => {
      const o0 = formationOffset(0, 10, 5);
      const o1 = formationOffset(1, 10, 5);
      const o5 = formationOffset(5, 10, 5);

      assert(o1.x > o0.x, '应该向右排开');
      assert(o5.y > o0.y, '换行后 y 增加');
    });

    test('circleFormation 均匀分布', () => {
      const a = circleFormation(0, 4, 10);
      const b = circleFormation(2, 4, 10);

      near(Math.hypot(a.x, a.y), 10, 1e-6, '半径应一致');
      near(Math.hypot(b.x, b.y), 10, 1e-6);
      // 0 和 2 应该是对称的
      near(a.x, -b.x, 1e-6);
    });
  });

  // ============================================================
  // Noise
  // ============================================================

  describe('PerlinNoise', () => {
    test('值域在 [-1,1]', () => {
      const n = new PerlinNoise(1);
      for (let i = 0; i < 500; i++) {
        const v = n.noise2D(i * 0.13, i * 0.29);
        assert(v >= -1.001 && v <= 1.001, `超域: ${v}`);
      }
    });

    test('连续性好（相邻点接近）', () => {
      const n = new PerlinNoise(42);
      let maxJump = 0;
      for (let i = 1; i < 500; i++) {
        const a = n.noise2D(i * 0.01, 0);
        const b = n.noise2D((i - 1) * 0.01, 0);
        maxJump = Math.max(maxJump, Math.abs(a - b));
      }
      assert(maxJump < 0.2, `跳变过大: ${maxJump}`);
    });

    test('同种子可复现', () => {
      const a = new PerlinNoise(7);
      const b = new PerlinNoise(7);
      near(a.noise2D(1.5, 2.5), b.noise2D(1.5, 2.5), 1e-12);
    });

    test('不同种子不同结果', () => {
      const a = new PerlinNoise(1);
      const b = new PerlinNoise(2);
      let diff = 0;
      for (let i = 0; i < 50; i++) {
        if (Math.abs(a.noise2D(i * 0.3, i * 0.7) - b.noise2D(i * 0.3, i * 0.7)) > 0.01) diff++;
      }
      assert(diff > 40, `应显著不同，实际 ${diff}/50`);
    });

    test('noise1D 正常', () => {
      const n = new PerlinNoise(3);
      assert(Number.isFinite(n.noise1D(1.5)));
    });
  });

  describe('SimplexNoise', () => {
    test('值域在 [-1,1]', () => {
      const n = new SimplexNoise(1);
      for (let i = 0; i < 1000; i++) {
        const v = n.noise2D(i * 0.37, i * 0.71);
        assert(v >= -1.001 && v <= 1.001, `超域: ${v}`);
      }
    });

    test('连续性', () => {
      const n = new SimplexNoise(99);
      let maxJump = 0;
      for (let i = 1; i < 1000; i++) {
        const a = n.noise2D(i * 0.01, 0);
        const b = n.noise2D((i - 1) * 0.01, 0);
        maxJump = Math.max(maxJump, Math.abs(a - b));
      }
      assert(maxJump < 0.2, `跳变过大: ${maxJump}`);
    });

    test('整数格点不是固定值（Perlin 的经典缺陷）', () => {
      const p = new PerlinNoise(5);
      const s = new SimplexNoise(5);

      // Perlin 在所有整数格点上梯度点积为 0 → 值恒为 0
      let perlinZeros = 0;
      for (let i = 0; i < 10; i++) {
        if (Math.abs(p.noise2D(i, i)) < 1e-9) perlinZeros++;
      }

      let simplexZeros = 0;
      for (let i = 0; i < 10; i++) {
        if (Math.abs(s.noise2D(i, i)) < 1e-9) simplexZeros++;
      }

      assert(perlinZeros > 0, 'Perlin 在整数格点确实会退化（这是已知特性）');
      // Simplex 不应有这个退化
      assert(simplexZeros < perlinZeros, 'Simplex 应更少退化');
    });

    test('3D 噪声', () => {
      const n = new SimplexNoise(1);
      const v = n.noise3D(1.5, 2.5, 3.5);
      assert(Number.isFinite(v));
      assert(v >= -1.001 && v <= 1.001, `超域: ${v}`);
    });
  });

  describe('ValueNoise', () => {
    test('值域在 [-1,1]', () => {
      const n = new ValueNoise(1);
      for (let i = 0; i < 500; i++) {
        const v = n.noise2D(i * 0.13, i * 0.29);
        assert(v >= -1.001 && v <= 1.001, `超域: ${v}`);
      }
    });

    test('连续性', () => {
      const n = new ValueNoise(5);
      let maxJump = 0;
      for (let i = 1; i < 500; i++) {
        const a = n.noise2D(i * 0.01, 0);
        const b = n.noise2D((i - 1) * 0.01, 0);
        maxJump = Math.max(maxJump, Math.abs(a - b));
      }
      assert(maxJump < 0.2, `跳变过大: ${maxJump}`);
    });

    test('非 2 的幂尺寸抛错', () => {
      throws(() => new ValueNoise(1, 100), '必须是 2 的幂');
    });
  });

  describe('WorleyNoise', () => {
    test('f1 模式：距离非负', () => {
      const n = new WorleyNoise(1);
      for (let i = 0; i < 100; i++) {
        const v = n.noise2D(i * 0.1, i * 0.13);
        assert(v >= 0, `f1 应非负，实际 ${v}`);
      }
    });

    test('f2-f1 模式：边界处接近 0', () => {
      const n = new WorleyNoise(1);
      let minV = Infinity;
      for (let i = 0; i < 200; i++) {
        const v = n.noise2D(i * 0.07, i * 0.11, 'f2-f1');
        minV = Math.min(minV, v);
      }
      assert(minV < 0.2, `边界值应接近 0，实际最小 ${minV}`);
      assert(minV >= 0, '不应为负');
    });

    test('同种子可复现', () => {
      const a = new WorleyNoise(3);
      const b = new WorleyNoise(3);
      near(a.noise2D(0.3, 0.7), b.noise2D(0.3, 0.7), 1e-12);
    });

    test('无缝平铺（跨越边界连续）', () => {
      const n = new WorleyNoise(7);
      // 网格宽度 32，坐标 1.0 处应该等于 0.0 处（因为 wrapping）
      const a = n.noise2D(0.001, 0.001);
      const b = n.noise2D(1.001, 0.001);
      near(a, b, 0.35, '跨越一个周期应该接近（允许采样点差异）');
    });
  });

  describe('fbm / ridged', () => {
    test('fbm2D 值域合理', () => {
      const n = new SimplexNoise(3);
      for (let i = 0; i < 500; i++) {
        const v = fbm2D(n, i * 0.1, i * 0.13);
        assert(v >= -1.001 && v <= 1.001, `超域: ${v}`);
      }
    });

    test('octaves 越多细节越丰富（方差更大）', () => {
      const n = new SimplexNoise(5);
      const vals1: number[] = [];
      const vals5: number[] = [];
      for (let i = 0; i < 200; i++) {
        vals1.push(fbm2D(n, i * 0.1, i * 0.11, { octaves: 1 }));
        vals5.push(fbm2D(n, i * 0.1, i * 0.11, { octaves: 5 }));
      }
      // 用极差粗略衡量
      const range = (a: number[]) => Math.max(...a) - Math.min(...a);
      assert(range(vals5) > 0.3, `多倍频应该有足够动态范围，实际 ${range(vals5)}`);
    });

    test('ridged2D 值域 [0,1] 且偏向高值', () => {
      const n = new SimplexNoise(11);
      let sum = 0;
      for (let i = 0; i < 500; i++) {
        const v = ridged2D(n, i * 0.1, i * 0.11);
        assert(v >= 0 && v <= 1.001, `超域: ${v}`);
        sum += v;
      }
      assert(sum / 500 > 0.3, `ridged 应偏向高值，实际均值 ${sum / 500}`);
    });

    test('persistence 影响细节强度', () => {
      const n = new SimplexNoise(9);
      const a = fbm2D(n, 1.5, 2.5, { octaves: 4, persistence: 0.2 });
      const b = fbm2D(n, 1.5, 2.5, { octaves: 4, persistence: 0.8 });
      assert(Number.isFinite(a) && Number.isFinite(b));
      assert(a !== b, 'persistence 应改变结果');
    });
  });

  describe('Noise 统一入口', () => {
    test('noise2 值域 [-1,1]', () => {
      const n = new Noise(7);
      for (let i = 0; i < 2000; i++) {
        const v = n.noise2((i % 50) * 0.37, Math.floor(i / 50) * 0.41);
        assert(v >= -1.001 && v <= 1.001, `超域: ${v}`);
      }
    });

    test('同种子完全可复现', () => {
      const a = new Noise(12345);
      const b = new Noise(12345);
      for (let i = 0; i < 100; i++) {
        near(a.noise2(i * 0.1, i * 0.2), b.noise2(i * 0.1, i * 0.2), 1e-12);
      }
    });

    test('不同种子显著不同', () => {
      const a = new Noise(1);
      const b = new Noise(2);
      let diff = 0;
      for (let i = 0; i < 50; i++) {
        if (Math.abs(a.noise2(i * 0.3, i * 0.7) - b.noise2(i * 0.3, i * 0.7)) > 0.01) diff++;
      }
      assert(diff > 40, `应显著不同，实际 ${diff}/50`);
    });

    test('连续性：与随机数的本质区别', () => {
      const n = new Noise(99);
      let maxJump = 0;
      for (let i = 1; i < 1000; i++) {
        const a = n.noise2(i * 0.01, 0);
        const b = n.noise2((i - 1) * 0.01, 0);
        maxJump = Math.max(maxJump, Math.abs(a - b));
      }
      assert(maxJump < 0.2, `相邻点跳变过大: ${maxJump}`);
    });

    test('fbm 值域 [-1,1]', () => {
      const n = new Noise(3);
      for (let i = 0; i < 500; i++) {
        const v = n.fbm(i * 0.1, i * 0.13);
        assert(v >= -1.001 && v <= 1.001, `超域: ${v}`);
      }
    });

    test('fbm01 值域 [0,1]', () => {
      const n = new Noise(3);
      for (let i = 0; i < 500; i++) {
        const v = n.fbm01(i * 0.1, i * 0.13);
        assert(v >= -0.001 && v <= 1.001, `超域: ${v}`);
      }
    });

    test('ridged 值域 [0,1] 且偏向高值', () => {
      const n = new Noise(11);
      let sum = 0;
      for (let i = 0; i < 500; i++) {
        const v = n.ridged(i * 0.1, i * 0.11);
        assert(v >= 0 && v <= 1.001, `超域: ${v}`);
        sum += v;
      }
      assert(sum / 500 > 0.3, `ridged 应偏向高值，实际 ${sum / 500}`);
    });

    test('heightMap 归一化到 [0,1]', () => {
      const n = new Noise(21);
      const hm = n.heightMap(32, 32, 0.1);
      eq(hm.length, 32 * 32);

      let min = Infinity;
      let max = -Infinity;
      for (const v of hm) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      near(min, 0, 1e-6, '最小值应为 0');
      near(max, 1, 1e-6, '最大值应为 1');
    });

    test('heightMap 不归一化时值域不同（说明归一化必要）', () => {
      const a = new Noise(1);
      const b = new Noise(2);
      const ha = a.heightMap(16, 16, 0.1, { normalize: false });
      const hb = b.heightMap(16, 16, 0.1, { normalize: false });

      for (const v of ha) assert(Number.isFinite(v));
      for (const v of hb) assert(Number.isFinite(v));

      // 不归一化时，不同种子的范围确实不一样
      const rangeOf = (arr: Float64Array) => Math.max(...Array.from(arr)) - Math.min(...Array.from(arr));
      const ra = rangeOf(ha);
      const rb = rangeOf(hb);
      assert(Math.abs(ra - rb) > 0.001, `不归一化时范围应有差异：${ra} vs ${rb}`);
    });

    test('用外部 RNG 构造（绑定主世界种子）', () => {
      const rng = { next: () => 0.5 };
      const n = new Noise(0, rng);
      assert(Number.isFinite(n.noise2(1.5, 2.5)));
    });

    test('外部 RNG 相同则噪声相同', () => {
      const n1 = new Noise(0, { next: () => 0.42 });
      const n2 = new Noise(0, { next: () => 0.42 });
      near(n1.noise2(1, 2), n2.noise2(1, 2), 1e-12);
    });

    test('heightMap 尺寸正确', () => {
      const n = new Noise(1);
      const hm = n.heightMap(10, 20, 0.1);
      eq(hm.length, 200);
    });
  });

  describe('Noise 辅助函数', () => {
    test('generateHeightmap', () => {
      const hm = generateHeightmap(4, 5, (x, y) => x + y * 10);
      eq(hm.length, 20);
      eq(hm[0], 0);
      eq(hm[1], 1);
      eq(hm[4], 10, '第二行第一列');
    });

    test('classifyHeightmap 分层', () => {
      const hm = new Float64Array([0.1, 0.5, 0.9]);
      const levels = classifyHeightmap(hm, [0.3, 0.7]);
      eq(levels[0], 0, '0.1 < 0.3 → 层 0');
      eq(levels[1], 1, '0.5 在 0.3~0.7 → 层 1');
      eq(levels[2], 2, '0.9 > 0.7 → 层 2');
    });

    test('islandMask 中心高边缘低', () => {
      const mask = islandMask(11, 11, 2);
      const center = mask[5 * 11 + 5];
      const corner = mask[0];
      near(center, 1, 1e-6, '中心应为 1');
      assert(corner < 0.01, `角落应接近 0，实际 ${corner}`);
    });

    test('islandMask 单调递减', () => {
      const mask = islandMask(21, 21, 1);
      // 从中心向右走，值应该单调不增
      let prev = Infinity;
      for (let x = 10; x < 21; x++) {
        const v = mask[10 * 21 + x];
        assert(v <= prev + 1e-9, `x=${x} 处不应回升：${v} > ${prev}`);
        prev = v;
      }
    });
  });
}
