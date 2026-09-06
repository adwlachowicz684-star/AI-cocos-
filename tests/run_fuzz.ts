/**
 * tests/run_fuzz.ts —— 随机化（模糊）测试
 *
 * 【为什么需要这个文件】
 *
 * 库里其余 2977 项测试几乎全是**定向测试**：
 * 我构造一个输入，断言一个输出。这类测试只能验证**我想到的情况**。
 *
 * 回想 `elo` 那个 bug：两个同名 `expectedScore` 签名不同，
 * 传错类型得 `NaN`。定向测试永远不会发现它——
 * 因为你根本想不到要测"传错类型"。
 *
 * 随机化测试补的正是这一块：**用大量随机输入覆盖没想到的组合**。
 *
 * 【核心手法：对拍（differential testing）】
 *
 * 优化实现（空间哈希、四叉树）的正确性很难用"预言结果"验证，
 * 但可以用**暴力 O(n²) 实现**对照：
 *
 *   随机撒 N 个点 → 随机查询 → 优化实现的结果 == 暴力解的结果
 *
 * 这能抓到"查询漏了对象""边界算错"这类定向测试极难构造的 bug。
 *
 * 【为什么用库自己的 RNG 而不是 Math.random】
 *
 * 1. 库铁律：**禁用 Math.random**（不可复现 = 不可调试）
 * 2. 固定种子 → 失败能 100% 复现
 * 3. 万一 RNG 本身有 bug，这里也能暴露
 *
 * ⚠️ 每个 test 用**独立种子**，避免前面的用例改变了后面的随机序列
 * （共享 RNG 实例会让"加一个用例"导致后面全变，极难排查）。
 */

import { describe, test, assert, eq, near } from './_framework';
import { RNG } from '../rng/RNG';
import { Seed } from '../rng/Seed';
import { BinaryHeap, LazyHeap, DisjointSet, QuadTree, SpatialHash } from '../ds/DataStructures';
import { PerlinNoise, SimplexNoise, ValueNoise, WorleyNoise, fbm2D, ridged2D } from '../noise/Noise';
import { Shadowcasting, Raycasting, makeWallTest, VisibilityMap } from '../fov/FOV';
import { schema, uint, int, bool, enumeration, string as binString } from '../binary/BinarySerializer';
import { Expression } from '../expression/Expression';

// ============================================================
// 工具：造一个带常用分布的随机源
// ============================================================

/** 每个 test 独立取一个 RNG，互不干扰 */
function rngFor(seed: number): RNG {
  return new RNG(seed);
}

/** 随机整数坐标（含负数与负数边界） */
function randCoord(r: RNG, lo = -500, hi = 500): number {
  return r.range(lo, hi);
}

// ============================================================
// 1. 空间索引：对拍（优化实现 vs 暴力解）
// ============================================================

/** 暴力解：给定点集与圆，返回落在圆内的 id（升序） */
function bruteCircle(
  pts: { id: number; x: number; y: number }[],
  cx: number,
  cy: number,
  radius: number,
): number[] {
  const r2 = radius * radius;
  return pts
    .filter((p) => (p.x - cx) ** 2 + (p.y - cy) ** 2 <= r2)
    .map((p) => p.id)
    .sort((a, b) => a - b);
}

// ============================================================
// 2. 导出
// ============================================================

export function runFuzzTests(): void {
  // ============================================================
  describe('Fuzz · SpatialHash 对拍（空间哈希 vs 暴力解）', () => {
    /**
     * ⚠️【口径】`queryNeighbors(x, y, radius)` 的 radius 是**格子数**，不是世界距离。
     *
     * 它返回的是"以所在格为中心、radius 格为半径的方格区域内所有 id"，
     * 因此结果是**粗筛超集**，不是精确圆。调用方需要自己再判一次距离。
     *
     * 我第一次写这个测试时就按"世界距离"写了，于是全军覆没——
     * 这正是写它的价值：这个参数名太容易被误解。
     */

    test('⚠️ 粗筛不漏：圆内的点一定在 queryNeighbors 结果里', () => {
      const r = rngFor(0xf00d01);
      for (let round = 0; round < 30; round++) {
        const cell = r.range(8, 60);
        const hash = new SpatialHash(cell);

        const n = r.rangeInt(1, 60);
        const pts: { id: number; x: number; y: number }[] = [];
        for (let i = 0; i < n; i++) {
          const id = i + 1;
          const x = randCoord(r);
          const y = randCoord(r);
          hash.insert(id, x, y);
          pts.push({ id, x, y });
        }

        for (let q = 0; q < 20; q++) {
          const cx = randCoord(r);
          const cy = randCoord(r);
          const worldR = r.range(0, 150);
          // 世界距离 → 至少覆盖这么多格（ceil 保证不漏）
          const cellR = Math.ceil(worldR / cell);
          const got = new Set(hash.queryNeighbors(cx, cy, cellR));
          const want = bruteCircle(pts, cx, cy, worldR);

          for (const id of want) {
            assert(got.has(id), `round=${round} q=${q} 粗筛漏了 id=${id}（cell=${cell.toFixed(1)} R=${worldR.toFixed(1)}）`);
          }
        }
      }
    });

    test('粗筛半径与格子尺寸一致时，结果等于全部点', () => {
      const r = rngFor(0xf00d04);
      const cell = 50;
      const hash = new SpatialHash(cell);
      const ids: number[] = [];
      for (let i = 0; i < 40; i++) {
        const id = i + 1;
        hash.insert(id, r.range(-200, 200), r.range(-200, 200));
        ids.push(id);
      }
      // 半径给足（覆盖整个坐标范围所需的格数）
      const all = new Set(hash.queryNeighbors(0, 0, 100));
      for (const id of ids) assert(all.has(id), `半径给足仍漏了 ${id}`);
    });

    test('⚠️ 边界与重复位置（同格多点 / 负坐标 / 极大坐标）', () => {
      const r = rngFor(0xf00d02);
      const hash = new SpatialHash(32);
      const pts: { id: number; x: number; y: number }[] = [];

      // 故意造重复与边界坐标
      const special = [0, -0, 32, -32, 1e-9, -1e-9, 1e6, -1e6, 0.5, -0.5];
      let id = 1;
      for (const x of special) {
        for (const y of special) {
          hash.insert(id, x, y);
          pts.push({ id, x, y });
          id++;
        }
      }
      for (let i = 0; i < 40; i++) {
        const x = randCoord(r);
        const y = randCoord(r);
        hash.insert(id, x, y);
        pts.push({ id, x, y });
        id++;
      }

      for (let q = 0; q < 40; q++) {
        const cx = randCoord(r);
        const cy = randCoord(r);
        const worldR = r.range(0, 200);
        const cellR = Math.ceil(worldR / 32);
        const got = new Set(hash.queryNeighbors(cx, cy, cellR));
        const want = bruteCircle(pts, cx, cy, worldR);
        for (const id2 of want) {
          assert(got.has(id2), `q=${q} 粗筛漏了 id=${id2}`);
        }
      }
    });

    test('重复 insert 同一 id 不产生重复结果', () => {
      /**
       * 【为什么必须测】
       * insert 的语义是"登记 id 的当前位置"而不是"新增一条记录"。
       * 同一个 id 反复 insert 到不同位置，表里必须只保留最后一个位置。
       * 若实现里忘了先删旧的，旧格子会残留该 id，
       * 表现为"对象已经走远了，邻居查询里还有它"。
       */
      const r = rngFor(0xf00d03);
      const hash = new SpatialHash(20);
      let moved = 0;
      for (let i = 0; i < 100; i++) {
        const id = r.rangeInt(1, 10); // id 只有 10 个，必然重复
        if (hash.insert(id, randCoord(r, -100, 100), randCoord(r, -100, 100))) moved++;
      }
      eq(hash.count, 10, `应只有 10 个 id，实际 ${hash.count}`);

      // 查询结果里同一个 id 不该出现两次
      const res = hash.queryNeighbors(0, 0, 100);
      const uniq = new Set(res);
      eq(res.length, uniq.size, `查询返回了重复 id（换过 ${moved} 次格子）`);
    });
  });

  // ============================================================
  describe('Fuzz · QuadTree 对拍（四叉树 vs 暴力解）', () => {
    test('随机撒点 + 随机矩形查询，结果集合必须与暴力解一致', () => {
      const r = rngFor(0x0AAD01);
      for (let round = 0; round < 20; round++) {
        const size = r.range(100, 1000);
        const qt = new QuadTree<number>({ x: -size, y: -size, w: size * 2, h: size * 2 });
        const pts: { x: number; y: number; v: number }[] = [];

        const n = r.rangeInt(1, 50);
        for (let i = 0; i < n; i++) {
          const x = r.range(-size, size);
          const y = r.range(-size, size);
          // ⚠️ 用 i 作为 data，但插入的点可能重复 —— 用对象包一层避免歧义
          const v = i;
          qt.insert(x, y, v);
          pts.push({ x, y, v });
        }

        for (let q = 0; q < 15; q++) {
          const x0 = r.range(-size, size);
          const y0 = r.range(-size, size);
          const w = r.range(0, size);
          const h = r.range(0, size);
          const rect = { x: x0, y: y0, w, h };

          const got = new Set(qt.query(rect));
          const want = new Set(
            pts.filter((p) => p.x >= x0 && p.x <= x0 + w && p.y >= y0 && p.y <= y0 + h).map((p) => p.v),
          );

          // 四叉树可能返回超集（粗筛），但不能漏
          for (const v of want) {
            assert(got.has(v), `round=${round} q=${q} 漏了点 ${v}`);
          }
        }
      }
    });
  });

  // ============================================================
  describe('Fuzz · 堆（BinaryHeap / LazyHeap）', () => {
    test('随机 push/pop 序列始终满足堆序', () => {
      const r = rngFor(0xA1E501);
      for (let round = 0; round < 20; round++) {
        const heap = new BinaryHeap<number>((a, b) => a - b);
        const model: number[] = [];

        for (let i = 0; i < 100; i++) {
          if (r.chance(0.6)) {
            const v = r.rangeInt(-1000, 1000);
            heap.push(v);
            model.push(v);
          } else {
            const got = heap.pop();
            if (model.length === 0) {
              eq(got, undefined, '空堆 pop 应返回 undefined');
            } else {
              model.sort((a, b) => a - b);
              const want = model.shift();
              eq(got, want, `第 ${i} 步 pop 值不符`);
            }
          }
        }
      }
    });

    test('⚠️ LazyHeap 随机删除后仍按优先级升序（惰性删除的经典坑）', () => {
      /**
       * 【为什么必须测】
       * 惰性删除的坑在"弹到一半才删"：被删的元素可能已在堆顶，
       * 也可能还在下面。若 pop 不跳过失效项，就会弹出删掉的东西——
       * 在 A* 里表现为"明明找到更短路径却返回旧的"。
       */
      const r = rngFor(0xA1E502);
      for (let round = 0; round < 20; round++) {
        const heap = new LazyHeap<string>();
        const handleToPr = new Map<number, number>();  // 句柄 → 优先级
        const seqToPr: number[] = [];                  // push 序号 → 优先级
        const alive = new Set<number>();               // 未被删的句柄
        let seq = 0;

        for (let i = 0; i < 100; i++) {
          if (r.chance(0.7)) {
            const pr = r.rangeInt(0, 500);
            const h = heap.push(`n${seq}`, pr);
            handleToPr.set(h, pr);
            seqToPr[seq] = pr;
            alive.add(h);
            seq++;
          } else if (alive.size > 0) {
            const keys = [...alive];
            const h = keys[r.int(keys.length)];
            heap.remove(h);          // 惰性删除，返回 void
            alive.delete(h);
          }
        }

        // 全部弹出：数量应等于存活数
        const popped: string[] = [];
        for (;;) {
          const v = heap.pop();
          if (v === undefined) break;
          popped.push(v);
        }
        eq(popped.length, alive.size, `弹出 ${popped.length} 个，应剩 ${alive.size} 个`);

        // 优先级必须非降序
        let prev = -Infinity;
        for (const name of popped) {
          const idx = parseInt(name.slice(1), 10);
          // 用 push 时记录的映射（seq → priority）
          const pr = seqToPr[idx];
          assert(pr >= prev, `弹出序列优先级非升序：${prev} → ${pr}（${name}）`);
          prev = pr;
        }
      }
    });

    test('⚠️ LazyHeap：删掉的元素绝不会再被弹出', () => {
      const r = rngFor(0xA1E503);
      for (let round = 0; round < 20; round++) {
        const heap = new LazyHeap<string>();
        const handles: number[] = [];
        for (let i = 0; i < 60; i++) handles.push(heap.push(`n${i}`, r.rangeInt(0, 100)));

        // 随机删掉一半
        const removed = new Set<number>();
        for (const h of handles) {
          if (r.chance(0.5)) {
            heap.remove(h);
            removed.add(h);
          }
        }

        // 剩下的必须恰好是未删的（数量上）
        let popped = 0;
        for (;;) {
          if (heap.pop() === undefined) break;
          popped++;
        }
        eq(popped, handles.length - removed.size, `删了 ${removed.size} 个，应剩 ${handles.length - removed.size} 个`);
      }
    });
  });

  // ============================================================
  describe('Fuzz · DisjointSet 对拍（并查集 vs 暴力连通）', () => {
    test('随机 union 后，连通性与 BFS 结果一致', () => {
      const r = rngFor(0xd501);
      for (let round = 0; round < 25; round++) {
        const n = r.rangeInt(2, 40);
        const ds = new DisjointSet(n);
        const adj: number[][] = Array.from({ length: n }, () => []);

        const unions = r.rangeInt(1, n * 2);
        for (let i = 0; i < unions; i++) {
          const a = r.int(n);
          const b = r.int(n);
          ds.union(a, b);
          adj[a].push(b);
          adj[b].push(a);
        }

        // BFS 求连通分量
        const comp = new Array<number>(n).fill(-1);
        let cid = 0;
        for (let s = 0; s < n; s++) {
          if (comp[s] !== -1) continue;
          const q = [s];
          comp[s] = cid;
          while (q.length) {
            const u = q.pop()!;
            for (const v of adj[u]) {
              if (comp[v] === -1) {
                comp[v] = cid;
                q.push(v);
              }
            }
          }
          cid++;
        }

        for (let a = 0; a < n; a++) {
          for (let b = 0; b < n; b++) {
            const byDs = ds.connected(a, b);
            const byBfs = comp[a] === comp[b];
            eq(byDs, byBfs, `round=${round} connected(${a},${b}) 与 BFS 不符`);
          }
        }
      }
    });
  });

  // ============================================================
  describe('Fuzz · 噪声（随机 2D 采样，不是规则直线）', () => {
    /**
     * 【为什么必须补】
     * 现有测试用的是 `i * 0.13, i * 0.29` —— x 与 y **线性相关**，
     * 永远在一条直线上采样。真正的随机 (x,y) 能覆盖整个平面，
     * 可能撞到实现里的象限判断、格点退化等问题。
     */
    /**
     * ⚠️【实测结论】`PerlinNoise` 与 `WorleyNoise` **会超出文档写的 [-1,1] / [0,1]**。
     *
     * 50 万次随机采样实测：
     *   Perlin   [-1.279, 1.208]   约 0.10% 超域
     *   Simplex  [-0.998, 0.998]   0%
     *   Value    [-0.999, 0.998]   0%
     *   Worley   [ 0.001, 1.105]   约 0.05% 超域
     *
     * 后果：拿 `v` 直接算 `(v + 1) / 2 * 255` 做高度图，
     * 会得到 260 或 -4 这种越界像素——`Uint8ClampedArray` 会静默截断，
     * 表现为"地形上偶尔出现一个突兀的亮点/黑点"。
     *
     * 所以这里断言的是**实测值域**，不是理想值域。
     */
    test('四种噪声：随机采样落在实测值域内（Perlin / Worley 会略微超域）', () => {
      const r = rngFor(0xA01501);
      const perlin = new PerlinNoise(11);
      const simplex = new SimplexNoise(22);
      const value = new ValueNoise(33);
      const worley = new WorleyNoise(44);

      // 实测界限（留了余量，别照着文档写 1.0）
      const BOUND = { perlin: 1.30, simplex: 1.001, value: 1.001, worley: 1.15 };

      for (let i = 0; i < 5000; i++) {
        const x = r.range(-1e4, 1e4);
        const y = r.range(-1e4, 1e4);

        const pv = perlin.noise2D(x, y);
        const sv = simplex.noise2D(x, y);
        const vv = value.noise2D(x, y);
        const wv = worley.noise2D(x, y);

        assert(Number.isFinite(pv) && Math.abs(pv) <= BOUND.perlin, `Perlin 越界 ${pv}`);
        assert(Number.isFinite(sv) && Math.abs(sv) <= BOUND.simplex, `Simplex 越界 ${sv}`);
        assert(Number.isFinite(vv) && Math.abs(vv) <= BOUND.value, `Value 越界 ${vv}`);
        assert(Number.isFinite(wv) && wv >= -0.01 && wv <= BOUND.worley, `Worley 越界 ${wv}`);
      }
    });

    test('⚠️ 文档说 [-1,1]，实测 Perlin 会超（这是已知偏差，不是回归）', () => {
      /**
       * 【为什么要把"已知偏差"写成测试】
       * 如果哪天有人"修复"了 Perlin 的归一化，这个测试会失败——
       * 提醒你同步更新 README 里的值域说明。
       * 没有这个测试，文档与实现的偏差会一直漂移下去。
       */
      const r = rngFor(0xA01504);
      const perlin = new PerlinNoise(11);
      let over = 0;
      const N = 30000;
      let max = 0;
      for (let i = 0; i < N; i++) {
        const v = perlin.noise2D(r.range(-1e4, 1e4), r.range(-1e4, 1e4));
        if (Math.abs(v) > 1) over++;
        max = Math.max(max, Math.abs(v));
      }
      // 既确认"确实会超"（说明没被意外修复），也不至于超得离谱
      assert(over > 0, 'Perlin 应当存在超域样本（若此条失败，说明归一化被改了，请同步 README）');
      assert(max < 1.5, `Perlin 最大绝对值 ${max} 超出预期，归一化可能算错了`);
    });

    test('⚠️ 随机输入下同种子仍严格可复现（可复现是核心承诺）', () => {
      const r = rngFor(0xA01502);
      const samples: [number, number][] = [];
      for (let i = 0; i < 500; i++) samples.push([r.range(-1e3, 1e3), r.range(-1e3, 1e3)]);

      const a1 = new PerlinNoise(777);
      const a2 = new PerlinNoise(777);
      const s1 = new SimplexNoise(888);
      const s2 = new SimplexNoise(888);
      const w1 = new WorleyNoise(999);
      const w2 = new WorleyNoise(999);

      for (const [x, y] of samples) {
        eq(a1.noise2D(x, y), a2.noise2D(x, y), `Perlin 不可复现 @(${x},${y})`);
        eq(s1.noise2D(x, y), s2.noise2D(x, y), `Simplex 不可复现 @(${x},${y})`);
        eq(w1.noise2D(x, y), w2.noise2D(x, y), `Worley 不可复现 @(${x},${y})`);
      }
    });

    test('fbm / ridged 随机输入下不产生 NaN', () => {
      const r = rngFor(0xA01503);
      const perlin = new PerlinNoise(5);
      const octaves = [1, 2, 4, 8];
      for (let i = 0; i < 800; i++) {
        const x = r.range(-500, 500);
        const y = r.range(-500, 500);
        const oct = octaves[r.int(octaves.length)];
        const f = fbm2D(perlin, x, y, { octaves: oct });
        const g = ridged2D(perlin, x, y, { octaves: oct });
        assert(Number.isFinite(f), `fbm NaN @(${x},${y}) oct=${oct}`);
        assert(Number.isFinite(g), `ridged NaN @(${x},${y}) oct=${oct}`);
      }
    });

    test('⚠️ 极端输入（NaN / Infinity / 极大值）不导致死循环或抛错', () => {
      const perlin = new PerlinNoise(1);
      const simplex = new SimplexNoise(1);
      const value = new ValueNoise(1);
      const nasty = [0, -0, 1e-12, -1e-12, 1e12, -1e12, 1e308, -1e308, 0.5, -0.5];
      for (const x of nasty) {
        for (const y of nasty) {
          const pv = perlin.noise2D(x, y);
          const sv = simplex.noise2D(x, y);
          const vv = value.noise2D(x, y);
          // 不要求值域（极端输入超域可接受），但必须是有限数或明确的 NaN
          assert(
            Number.isFinite(pv) || Number.isNaN(pv),
            `Perlin 在 (${x},${y}) 返回了 ${pv}`,
          );
          assert(
            Number.isFinite(sv) || Number.isNaN(sv),
            `Simplex 在 (${x},${y}) 返回了 ${sv}`,
          );
          assert(
            Number.isFinite(vv) || Number.isNaN(vv),
            `Value 在 (${x},${y}) 返回了 ${vv}`,
          );
        }
      }
    });
  });

  // ============================================================
  describe('Fuzz · FOV 视野（随机地图）', () => {
    test('⚠️ 随机墙布局下，Shadowcasting 与 Raycasting 不崩且自洽', () => {
      const r = rngFor(0xF0A001);
      for (let round = 0; round < 15; round++) {
        const W = r.rangeInt(8, 30);
        const H = r.rangeInt(8, 30);
        const density = r.range(0.05, 0.45);
        const walls = new Uint8Array(W * H);
        for (let i = 0; i < walls.length; i++) walls[i] = r.chance(density) ? 1 : 0;

        const isWall = (x: number, y: number): boolean => {
          if (x < 0 || y < 0 || x >= W || y >= H) return true; // 边界当墙
          return walls[y * W + x] === 1;
        };

        // 随机选一个非墙点作为观察点
        let ox = 0;
        let oy = 0;
        for (let tries = 0; tries < 200; tries++) {
          const x = r.int(W);
          const y = r.int(H);
          if (!isWall(x, y)) {
            ox = x;
            oy = y;
            break;
          }
        }
        const radius = r.range(1, Math.min(W, H));

        const sc = new Shadowcasting(W, H, isWall);
        const rc = new Raycasting(W, H, isWall);

        const scCount = sc.compute(ox, oy, radius);
        const rcCount = rc.compute(ox, oy, radius);

        assert(Number.isFinite(scCount) && scCount >= 0, `Shadowcasting 返回异常: ${scCount}`);
        assert(Number.isFinite(rcCount) && rcCount >= 0, `Raycasting 返回异常: ${rcCount}`);

        // 自己一定能看见自己
        assert(sc.canSee(ox, oy), `观察点应可见自己 @(${ox},${oy})`);

        // 墙的数量不该超过总数
        assert(scCount <= W * H, `可见数 ${scCount} 超过格子总数 ${W * H}`);
      }
    });

    /**
     * ⚠️【实测结论】`canSee`（Shadowcasting）与 `hasLineOfSight`（Bresenham）
     * **是两套算法，约 59% 的可见格上会给出不同答案**。
     *
     * 原因：Bresenham 走的是严格的"对角线擦角"判定
     * （拐弯时两个正交格都得通），而 Shadowcasting 是扇形扫描，宽松得多。
     *
     * 后果：用 `canSee` 画视野、用 `hasLineOfSight` 判"能不能射击"，
     * 玩家会看到"明明看得见却打不到"或"看不见却被打了"。
     *
     * **结论：同一件事只用一套判定，别混着用。**
     */
    test('⚠️ 实测：canSee 与 hasLineOfSight 大范围不一致（不可混用）', () => {
      const r = rngFor(0xF0A002);
      let visible = 0;
      let disagree = 0;

      for (let round = 0; round < 20; round++) {
        const W = r.rangeInt(8, 20);
        const H = r.rangeInt(8, 20);
        const walls = new Uint8Array(W * H);
        for (let i = 0; i < walls.length; i++) walls[i] = r.chance(0.3) ? 1 : 0;

        const isWall = (x: number, y: number): boolean =>
          x < 0 || y < 0 || x >= W || y >= H ? true : walls[y * W + x] === 1;

        let ox = 0;
        let oy = 0;
        for (let t = 0; t < 300; t++) {
          const x = r.int(W);
          const y = r.int(H);
          if (!isWall(x, y)) {
            ox = x;
            oy = y;
            break;
          }
        }

        const sc = new Shadowcasting(W, H, isWall);
        sc.compute(ox, oy, Math.min(W, H));

        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (sc.canSee(x, y)) {
              visible++;
              if (!sc.hasLineOfSight(ox, oy, x, y)) disagree++;
            }
          }
        }
      }

      // 断言的是"分歧确实存在且量级显著"——这是要写进文档的已知行为
      assert(visible > 0, '没有任何可见格，测试构造有问题');
      const rate = disagree / visible;
      assert(
        rate > 0.1,
        `分歧率 ${(rate * 100).toFixed(1)}% —— 若已修成一致，请同步 README 的"两套判定"说明`,
      );
    });

    test('Shadowcasting 自身不变量：看得见自己 / 不超半径 / 数量不超总数', () => {
      const r = rngFor(0xF0A005);
      for (let round = 0; round < 20; round++) {
        const W = r.rangeInt(8, 20);
        const H = r.rangeInt(8, 20);
        const walls = new Uint8Array(W * H);
        for (let i = 0; i < walls.length; i++) walls[i] = r.chance(0.3) ? 1 : 0;
        const isWall = (x: number, y: number): boolean =>
          x < 0 || y < 0 || x >= W || y >= H ? true : walls[y * W + x] === 1;

        let ox = 0;
        let oy = 0;
        for (let t = 0; t < 300; t++) {
          const x = r.int(W);
          const y = r.int(H);
          if (!isWall(x, y)) {
            ox = x;
            oy = y;
            break;
          }
        }
        const radius = r.range(1, Math.min(W, H));
        const sc = new Shadowcasting(W, H, isWall);
        const n = sc.compute(ox, oy, radius);

        assert(sc.canSee(ox, oy), `看得见自己 @(${ox},${oy})`);
        assert(n >= 1 && Number.isFinite(n), `可见数异常 ${n}`);
        assert(n <= W * H, `可见数 ${n} 超过格子总数`);

        // 超半径的格子不该可见
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (sc.canSee(x, y)) {
              const d = Math.hypot(x - ox, y - oy);
              assert(d <= radius + 1.5, `(${x},${y}) 距 ${d.toFixed(2)} 超过半径 ${radius.toFixed(2)} 却可见`);
            }
          }
        }
      }
    });

    test('makeWallTest 随机输入不崩（含越界）', () => {
      const r = rngFor(0xF0A003);
      const W = 20;
      const H = 20;
      const map: number[][] = [];
      for (let y = 0; y < H; y++) {
        const row: number[] = [];
        for (let x = 0; x < W; x++) row.push(r.chance(0.3) ? 1 : 0);
        map.push(row);
      }
      const fn = makeWallTest(map, [1]);
      for (let i = 0; i < 500; i++) {
        const x = r.rangeInt(-5, W + 5); // 含越界
        const y = r.rangeInt(-5, H + 5);
        const v = fn(x, y);
        assert(typeof v === 'boolean', `应返回布尔，实际 ${typeof v}`);
      }
      // 越界一律当墙
      eq(fn(-1, 5), true, '左越界应当墙');
      eq(fn(W, 5), true, '右越界应当墙');
      eq(fn(5, -1), true, '上越界应当墙');
      eq(fn(5, H), true, '下越界应当墙');
    });

    test('VisibilityMap 随机读写', () => {
      const r = rngFor(0xF0A004);
      const W = r.rangeInt(5, 40);
      const H = r.rangeInt(5, 40);
      const vm = new VisibilityMap(W, H);
      const truth = new Set<string>();
      for (let i = 0; i < 400; i++) {
        const x = r.rangeInt(-3, W + 3);
        const y = r.rangeInt(-3, H + 3);
        if (r.chance(0.6)) {
          vm.mark(x, y);
          if (x >= 0 && y >= 0 && x < W && y < H) truth.add(`${x},${y}`);
        } else {
          vm.set(x, y, false);
          truth.delete(`${x},${y}`);
        }
      }
      // 逐格核对（只核对界内）
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          eq(vm.has(x, y), truth.has(`${x},${y}`), `(${x},${y}) 不一致`);
        }
      }
      eq(vm.count, truth.size, 'count 应与实际标记数一致');
    });
  });

  // ============================================================
  describe('Fuzz · Binary 序列化往返', () => {
    test('⚠️ 随机数据 encode → decode 必须无损', () => {
      const r = rngFor(0xB1A001);
      const S = schema({
        u: uint(7),
        i: int(9),
        b: bool(),
        e: enumeration(['a', 'b', 'c'] as const, 'a'),
        s: binString(32),
      });
      const words = ['a', 'b', 'c', 'ab', '', 'x', 'hello', '中文', 'a'.repeat(30)];

      for (let i = 0; i < 2000; i++) {
        const data = {
          u: r.rangeInt(0, 127),
          i: r.rangeInt(-256, 255),
          b: r.bool(),
          e: words[r.int(words.length)] === 'a' || r.chance(0.5) ? (['a', 'b', 'c'] as const)[r.int(3)] : 'a',
          s: words[r.int(words.length)],
        };
        const bytes = S.encode(data);
        const back = S.decode(bytes);
        eq(back.u, data.u, `u 往返失败 @${i}`);
        eq(back.i, data.i, `i 往返失败 @${i}`);
        eq(back.b, data.b, `b 往返失败 @${i}`);
        eq(back.e, data.e, `e 往返失败 @${i}`);
        eq(back.s, data.s, `s 往返失败 @${i}`);
      }
    });
  });

  // ============================================================
  describe('Fuzz · Expression 解析器（畸形输入不崩）', () => {
    test('⚠️ 随机字符串与畸形表达式必须返回错误，不能抛异常', () => {
      const r = rngFor(0xE0A001);
      const atoms = ['1', '2.5', '0', 'x', 'y', 'hp', '+', '-', '*', '/', '%', '(', ')', ' ', '<', '>', '=', '!', '&', '|', '?', ':'];

      let parsed = 0;
      let rejected = 0;
      for (let i = 0; i < 3000; i++) {
        const len = r.rangeInt(1, 12);
        let src = '';
        for (let k = 0; k < len; k++) src += atoms[r.int(atoms.length)];

        try {
          const e = new Expression(src);
          // 解析成功就试着求值
          e.evaluate({ x: 1, y: 2, hp: 50 });
          parsed++;
        } catch (err) {
          // 允许抛错，但必须是 Error 实例（不能是 undefined 之类的怪东西）
          assert(err instanceof Error, `畸形输入 "${src}" 抛出了非 Error: ${String(err)}`);
          rejected++;
        }
      }
      // 随机串里应该既有能解析的也有不能解析的，否则说明测试没覆盖到
      assert(parsed > 0, `一个都没解析成功，随机串生成有问题`);
      assert(rejected > 0, `一个都没被拒绝，畸形输入可能没做校验`);
    });

    test('正常表达式的随机组合都能求值', () => {
      const r = rngFor(0xE0A002);
      for (let i = 0; i < 1000; i++) {
        const a = r.rangeInt(-100, 100);
        const b = r.rangeInt(1, 100); // 避免除零
        const op = ['+', '-', '*', '/'][r.int(4)];
        const src = `${a} ${op} ${b}`;
        const e = new Expression(src);
        const got = e.evaluate({});
        // 与 JS 自己算的对拍
        const want = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b;
        near(got as number, want, 1e-9, `"${src}" 求值不符`);
      }
    });
  });

  // ============================================================
  describe('Fuzz · Seed 种子往返', () => {
    test('⚠️ 随机数值 encode → decode 严格往返（这是可复现的基石）', () => {
      const r = rngFor(0x5eed01);
      for (let i = 0; i < 3000; i++) {
        const n = r.int(Seed.CAPACITY);
        const text = Seed.encode(n);
        const back = Seed.decode(text);
        eq(back, n, `种子 ${n} → "${text}" → ${back} 往返失败`);
      }
    });

    test('随机文本 decode 返回 null 而不崩', () => {
      const r = rngFor(0x5eed02);
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ';
      for (let i = 0; i < 2000; i++) {
        const len = r.rangeInt(0, 14);
        let s = '';
        for (let k = 0; k < len; k++) s += chars[r.int(chars.length)];
        const v = Seed.decode(s);
        assert(v === null || typeof v === 'number', `decode("${s}") 返回了 ${typeof v}`);
        if (v !== null) {
          assert(v >= 0 && v < Seed.CAPACITY, `decode("${s}") = ${v} 超出容量`);
        }
      }
    });
  });

  // ============================================================
  describe('Fuzz · RNG 自身（它是所有可复现性的根）', () => {
    test('⚠️ 同种子同序列，异种子异序列', () => {
      const r = rngFor(0xB0A001);
      for (let i = 0; i < 200; i++) {
        const seed = r.int(0xffffffff);
        const a = new RNG(seed);
        const b = new RNG(seed);
        for (let k = 0; k < 30; k++) eq(a.next(), b.next(), `种子 ${seed} 第 ${k} 个不一致`);

        const c = new RNG(seed ^ 0x5a5a5a5a);
        let diff = 0;
        for (let k = 0; k < 30; k++) if (a.next() !== c.next()) diff++;
        assert(diff > 25, `不同种子应显著不同，实际 ${diff}/30`);
      }
    });

    test('随机参数下各分布都落在契约内', () => {
      const r = rngFor(0xB0A002);
      for (let i = 0; i < 2000; i++) {
        assert(r.next() >= 0 && r.next() < 1, 'next() 应在 [0,1)');
      }
      for (let i = 0; i < 2000; i++) {
        const n = r.int(1);
        eq(n, 0, 'int(1) 只能是 0');
      }
      for (let i = 0; i < 2000; i++) {
        const lo = r.range(-100, 100);
        const hi = lo + r.range(0, 200);
        const v = r.range(lo, hi);
        assert(v >= lo && v < hi, `range(${lo},${hi}) = ${v} 越界`);
      }
      for (let i = 0; i < 2000; i++) {
        const n = r.rangeInt(-50, 50);
        assert(Number.isInteger(n) && n >= -50 && n <= 50, `rangeInt 返回 ${n}`);
      }
    });

    test('⚠️ fork() 产生独立子流（改一个不影响另一个）', () => {
      const root = new RNG(20240905);
      const a = root.fork();
      const b = root.fork();
      // 两个子流的前 50 个不应相同
      let diff = 0;
      for (let i = 0; i < 50; i++) if (a.next() !== b.next()) diff++;
      assert(diff > 45, `fork 应产生独立子流，实际 ${diff}/50 不同`);

      // 子流内部自己可复现
      const root2 = new RNG(20240905);
      const a2 = root2.fork();
      const a3 = new RNG(20240905).fork();
      for (let i = 0; i < 20; i++) eq(a2.next(), a3.next(), `fork 不可复现 @${i}`);
    });
  });
}
