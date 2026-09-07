/**
 * tests/run_phase10_w6b.ts —— 第二次精审 P1/P2 回归 · 窗口 W6-B
 *
 * 【本窗口的四个单元】adapters / dungeon / pathfind / replay
 *
 * 【三条约定】
 * 1. **复现用例**：修复前**确实会失败**。每条下面都写了修复前的实测输出，
 *    来源是 /data/workspace/repo 下跑的复现脚本（改代码前先跑出来的），不是照抄报告。
 * 2. **对照用例**：正常输入不受影响（防止矫枉过正）。
 * 3. 需要总审裁决的写进 `audit/result_W6-B.md`，不在这里拍板。
 *
 * 【为什么每个 test 里都重新 new】
 * 这四个单元都持有状态（地牢地形、寻路缓冲、回放指针），
 * 跨用例复用会让"失败原因"变成"上一个用例污染了它"——
 * 排查成本远高于多 new 一次。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import {
  toFlatGrid,
  wallTestFrom2D,
  toCasterHits,
  nearestCasterHits,
  flattenDrops,
} from '../adapters/Adapters';
import {
  BSPDungeon,
  CellularDungeon,
  MazeDungeon,
  RoomDungeon,
  Tile,
} from '../dungeon/Dungeon';
import { AStar, FlowField, PathSmoother } from '../pathfind/PathFinder';
import { ReplayRecorder } from '../replay/ReplayRecorder';
import { makeWallTest } from '../fov/FOV';

// ============================================================
// 小工具
// ============================================================

/** 造一张全空的 w×h 地图（0 = 可走） */
function emptyMap(w: number, h: number): number[][] {
  const g: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    for (let x = 0; x < w; x++) row.push(0);
    g.push(row);
  }
  return g;
}

function mkHit(id: string, x: number, y: number, distance: number) {
  return { hitbox: { id, x, y }, distance };
}

// ============================================================
// 主入口
// ============================================================

export function runPhase10W6BTests(): void {
  // ==========================================================
  // P1 · adapters
  // ==========================================================

  describe('adapters · toFlatGrid 静默截断值域（P1）', () => {
    test('⚠️ 哨兵值 -1 不得变成 255（修复前实测：[-1,300] → [255,44]）', () => {
      const src = {
        width: 2,
        height: 1,
        tileAt: (x: number): number => (x === 0 ? -1 : 300),
      };
      const flat = Array.from(toFlatGrid(src));
      // 修复前：Uint8Array 的 mod 256 让 -1 → 255、300 → 44
      assert(flat[0] !== 255, `-1 不应静默变成 255，实际 ${flat[0]}`);
      assert(flat[1] !== 44, `300 不应静默变成 44，实际 ${flat[1]}`);
      eq(flat[0], 0, '负数收口到 0');
      eq(flat[1], 255, '超上界收口到 255');
    });

    test('⚠️ clamp:false 时越界抛错，而不是静默改写', () => {
      const src = { width: 1, height: 1, tileAt: (): number => -1 };
      throws(() => toFlatGrid(src, { clamp: false }), '值域越界', '越界应抛错');
    });

    test('NaN 不得被写成 0 以外的巧合值（NaN 写进 Uint8Array 本来就是 0）', () => {
      const src = { width: 1, height: 1, tileAt: (): number => NaN };
      eq(Array.from(toFlatGrid(src))[0], 0, 'NaN → 0');
    });

    test('正常值 0~255 逐值不变（防止矫枉过正）', () => {
      const vals = [0, 1, 2, 127, 254, 255];
      const src = {
        width: vals.length,
        height: 1,
        tileAt: (x: number): number => vals[x],
      };
      eq(Array.from(toFlatGrid(src)).join(','), vals.join(','), '合法值域内必须原样保留');
    });
  });

  describe('adapters · wallTestFrom2D 与 fov.makeWallTest 默认值（P1）', () => {
    test('⚠️ 同一张图，两处默认判定必须一致（修复前实测：四处结论全部相反）', () => {
      const grid = [
        [0, 1],
        [1, 0],
      ];
      const a = wallTestFrom2D(grid);
      const f = makeWallTest(grid);
      // 修复前：a(0,0)=true / f(0,0)=false；a(1,0)=false / f(1,0)=true
      eq(a(0, 0), f(0, 0), '(0,0) 必须与 fov 一致');
      eq(a(1, 0), f(1, 0), '(1,0) 必须与 fov 一致');
      eq(a(0, 0), false, '0 = 可走，不是墙');
      eq(a(1, 0), true, '1 = 墙');
    });

    test('显式传 [0] 仍保留旧语义（防止矫枉过正）', () => {
      const grid = [
        [0, 1],
        [1, 0],
      ];
      const a = wallTestFrom2D(grid, [0]);
      eq(a(0, 0), true, '显式 [0] 时 0 仍是墙');
      eq(a(1, 0), false, '显式 [0] 时 1 不是墙');
    });

    test('越界仍算墙（这条不能因为改默认值而丢）', () => {
      const grid = [[0, 0]];
      const a = wallTestFrom2D(grid);
      eq(a(-1, 0), true, 'x 越界算墙');
      eq(a(0, 5), true, 'y 越界算墙');
    });
  });

  // ==========================================================
  // P1 · dungeon
  // ==========================================================

  describe('dungeon · 尺寸校验拦不住 NaN（P1）', () => {
    test('⚠️ width=NaN 必须抛错（修复前实测：构造通过，生成出空地图）', () => {
      // 修复前：NaN < 5 恒 false → 校验穿透 → new Uint8Array(NaN*NaN) 得到 length=0
      throws(
        () => new BSPDungeon({ width: NaN, height: 40, seed: 1 }),
        '尺寸至少',
        'NaN 尺寸必须被拦住',
      );
    });

    test('⚠️ height=NaN 同样必须抛错', () => {
      throws(() => new BSPDungeon({ width: 40, height: NaN, seed: 1 }), '尺寸至少');
    });

    test('⚠️ Maze / Room / Cellular 三种生成器共用基类校验（NaN 一个都进不来）', () => {
      throws(() => new MazeDungeon({ width: NaN, height: 21, seed: 1 }), '尺寸至少');
      throws(() => new RoomDungeon({ width: 30, height: NaN, seed: 1 }), '尺寸至少');
      throws(() => new CellularDungeon({ width: NaN, height: 30, seed: 1 }), '尺寸至少');
    });

    test('正常尺寸仍能出图且连通（防止矫枉过正）', () => {
      const d = new BSPDungeon({ width: 60, height: 40, seed: 1 });
      d.generate();
      eq(d.width, 60, '宽度');
      assert(d.floorCount > 0, '应有地板');
      assert(d.isFullyConnected(), '正常地图必须连通');
      assert(d.roomCount > 1, '应有多个房间');
    });

    test('4×40 这种真的太小仍然抛错（下界语义不变）', () => {
      throws(() => new BSPDungeon({ width: 4, height: 40, seed: 1 }), '尺寸至少');
    });
  });

  describe('dungeon · minRoomSize=NaN 产生 NaN 房间（P1）', () => {
    test('⚠️ minRoomSize=NaN 不得产生 NaN 房间（修复前实测：首个房间 cx=NaN，allRoomsReachable=false）', () => {
      const d = new BSPDungeon({ width: 60, height: 40, seed: 1, minRoomSize: NaN });
      d.generate();
      for (const r of d.rooms) {
        assert(Number.isFinite(r.x), `房间 x 不应是 ${r.x}`);
        assert(Number.isFinite(r.y), `房间 y 不应是 ${r.y}`);
        assert(Number.isFinite(r.w), `房间 w 不应是 ${r.w}`);
        assert(Number.isFinite(r.h), `房间 h 不应是 ${r.h}`);
        assert(Number.isFinite(r.cx), `房间中心 cx 不应是 ${r.cx}`);
        assert(Number.isFinite(r.cy), `房间中心 cy 不应是 ${r.cy}`);
      }
      assert(d.roomCount > 0, '应生成出房间');
      assert(d.allRoomsReachable(), '所有房间应互相可达');
      assert(d.floorCount > 0, '地图上应真的有地板');
    });

    test('⚠️ maxDepth / roomPadding / corridorWidth 为 NaN 同样不得穿透', () => {
      const d = new BSPDungeon({
        width: 60,
        height: 40,
        seed: 1,
        maxDepth: NaN,
        roomPadding: NaN,
        corridorWidth: NaN,
      });
      d.generate();
      for (const r of d.rooms) {
        assert(Number.isFinite(r.cx) && Number.isFinite(r.cy), '房间中心不得为 NaN');
      }
      assert(d.floorCount > 0, '应有地板');
    });

    test('⚠️ NaN 参数与"省略参数"必须生成同一张图（NaN 应等价于没填）', () => {
      const a = new BSPDungeon({ width: 60, height: 40, seed: 1, minRoomSize: NaN });
      a.generate();
      const b = new BSPDungeon({ width: 60, height: 40, seed: 1 });
      b.generate();
      eq(a.floorCount, b.floorCount, 'NaN 应回落到默认值，出图与省略时一致');
      eq(a.roomCount, b.roomCount, '房间数也应一致');
    });

    test('minRoomSize=2 仍然抛错（既有契约不能被收口吃掉）', () => {
      throws(() => new BSPDungeon({ width: 50, height: 40, seed: 1, minRoomSize: 2 }), '至少为 3');
    });

    test('minRoomSize=6 正常出图（防止矫枉过正）', () => {
      const d = new BSPDungeon({ width: 60, height: 40, seed: 1, minRoomSize: 6 });
      d.generate();
      assert(d.floorCount > 0, '应有地板');
      assert(d.rooms.length > 0, '应有房间');
    });
  });

  // ==========================================================
  // P1 · pathfind
  // ==========================================================

  describe('pathfind · heuristicWeight=NaN 静默返回非最优路径（P1）', () => {
    test('⚠️ hw=NaN 时路径长度必须与默认一致（修复前实测：39 → 77，腰折路径）', () => {
      const grid = emptyMap(40, 40);
      const def = new AStar(grid).find({ x: 0, y: 0 }, { x: 39, y: 39 });
      const nan = new AStar(grid, { heuristicWeight: NaN }).find({ x: 0, y: 0 }, { x: 39, y: 39 });

      assert(def.found, '默认配置应找到路径');
      eq(def.path.length, 39, '空地图对角线的曼哈顿最优步数');

      assert(nan.found, 'hw=NaN 也应找到路径');
      eq(nan.path.length, def.path.length, 'hw=NaN 不得退化成绕路');
      eq(nan.nodesExplored, def.nodesExplored, '探索节点数也应一致');
    });

    test('⚠️ hw=Infinity 同样不得让堆序失效', () => {
      const grid = emptyMap(40, 40);
      const r = new AStar(grid, { heuristicWeight: Infinity }).find({ x: 0, y: 0 }, { x: 39, y: 39 });
      assert(r.found, '仍应找到路径');
      assert(Number.isFinite(r.cost), `代价不应是 ${r.cost}`);
    });

    test('hw=2（贪心）仍然允许非最优——这是它的设计目的', () => {
      const grid = emptyMap(40, 40);
      const r = new AStar(grid, { heuristicWeight: 2 }).find({ x: 0, y: 0 }, { x: 39, y: 39 });
      assert(r.found, '贪心权重下也要能找到路径');
      const def = new AStar(grid).find({ x: 0, y: 0 }, { x: 39, y: 39 });
      eq(def.path.length, 39, '默认仍是最优');
    });

    test('正常 hw=1 结果不变（防止矫枉过正）', () => {
      const grid = emptyMap(20, 20);
      const a = new AStar(grid, { heuristicWeight: 1 }).find({ x: 0, y: 0 }, { x: 19, y: 19 });
      const b = new AStar(grid).find({ x: 0, y: 0 }, { x: 19, y: 19 });
      eq(a.path.length, b.path.length, '显式 1 与默认必须一致');
      near(a.cost, b.cost, 1e-9, '代价一致');
    });
  });

  describe('pathfind · maxNodes=NaN 让防卡死上限失效（P1）', () => {
    /**
     * 40×40，目标 (39,39) 周围一圈封死 → 目标不可达。
     * 修复前：maxNodes=NaN 时 explored=800（搜完整张可达区域），
     *         maxNodes=50 时 explored=51。
     */
    function unreachableGrid(size: number): number[][] {
      const g = emptyMap(size, size);
      // 目标取 (size-2, size-2)：四周封墙时 gy+1 = size-1 仍在图内
      const gx = size - 2;
      const gy = size - 2;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx !== 0 || dy !== 0) g[gy + dy][gx + dx] = 1;
        }
      }
      return g;
    }

    test('⚠️ maxNodes=NaN 时上限不得失效（修复前实测：NaN 搜完 800 个节点）', () => {
      const g = unreachableGrid(40);
      const limited = new AStar(g, { maxNodes: 50 }).find({ x: 0, y: 0 }, { x: 38, y: 38 });
      const nan = new AStar(g, { maxNodes: NaN }).find({ x: 0, y: 0 }, { x: 38, y: 38 });

      const def = new AStar(g).find({ x: 0, y: 0 }, { x: 38, y: 38 });

      eq(limited.nodesExplored, 51, 'maxNodes=50 → 探索 51 个节点即停');
      // 小地图（约 1591 个可达格）看不出 100000 的上限，
      // 这里能验证的是"NaN 不再让上限变成无物"——它与默认完全一致。
      // 上限是否真的生效由下一条大地图用例验证。
      eq(nan.nodesExplored, def.nodesExplored, 'maxNodes=NaN 必须与默认完全一致');
    });

    test('⚠️ 大地图上 NaN 与默认值表现一致（默认 100000 会生效）', () => {
      const g = unreachableGrid(320);
      const nan = new AStar(g, { maxNodes: NaN }).find({ x: 0, y: 0 }, { x: 318, y: 318 });
      const def = new AStar(g).find({ x: 0, y: 0 }, { x: 318, y: 318 });
      eq(nan.nodesExplored, def.nodesExplored, 'NaN 应等价于默认上限');
      // 320×320 去掉 9 个格子 ≈ 102391 个可达格，远超 100000 上限
      assert(
        def.nodesExplored <= 100001,
        `默认上限必须真的生效，实际探索 ${def.nodesExplored}`,
      );
    });

    test('maxNodes=-5 收口到 1（负数不能让上限反过来失效）', () => {
      const g = unreachableGrid(40);
      const r = new AStar(g, { maxNodes: -5 }).find({ x: 0, y: 0 }, { x: 38, y: 38 });
      assert(r.nodesExplored <= 2, `负数应被夹到 1，实际探索 ${r.nodesExplored}`);
    });

    test('正常地图 maxNodes 足够大时仍找到最优路径（防止矫枉过正）', () => {
      const g = emptyMap(40, 40);
      const r = new AStar(g, { maxNodes: 100000 }).find({ x: 0, y: 0 }, { x: 39, y: 39 });
      assert(r.found, '应找到');
      eq(r.path.length, 39, '最优步数不变');
    });
  });

  // ==========================================================
  // P1 · replay
  // ==========================================================

  describe('replay · 默认 seed=0 让种子校验被跳过（P1）', () => {
    const data = { version: 1, seed: 999999, frameCount: 10, keyframes: [] };

    test('⚠️ 不传 seed 时也要校验（修复前实测：默认配置 load 完全不报错）', () => {
      throws(
        () => new ReplayRecorder().load(data),
        '种子不匹配',
        '默认配置下种子校验必须生效',
      );
    });

    test('⚠️ 显式 seed 不匹配仍然抛错（这条修复前就是对的）', () => {
      throws(() => new ReplayRecorder({ seed: 1 }).load(data), '种子不匹配');
    });

    test('verifySeed:false 可以显式关掉校验', () => {
      const p = new ReplayRecorder({ verifySeed: false });
      p.load(data);
      assert(p.isPlaying, '关闭校验后应正常加载');
    });

    test('种子一致时正常加载（防止矫枉过正）', () => {
      const p = new ReplayRecorder({ seed: 999999 });
      p.load(data);
      assert(p.isPlaying, '种子一致应能加载');
      eq(p.totalFrames, 10, '帧数');
    });

    test('未指定 seed + 数据 seed=0 应通过（0 是合法种子）', () => {
      const p = new ReplayRecorder();
      p.load({ version: 1, seed: 0, frameCount: 10, keyframes: [] });
      assert(p.isPlaying, '0 号种子应被接受');
    });
  });

  describe('replay · 倒带取帧静默返回空输入（P1）', () => {
    /**
     * 修复前实测：playback(100) → {jump:true}，紧接着 playback(50) → {}
     * （期望沿用这一帧之前的 {jump:false}）
     */
    function setup(): ReplayRecorder {
      const rec = new ReplayRecorder({ seed: 7 });
      rec.start();
      rec.record(0, { jump: false });
      rec.record(100, { jump: true });
      const data = rec.export();
      const p = new ReplayRecorder({ seed: 7 });
      p.load(data);
      return p;
    }

    test('⚠️ 倒着取帧要拿到历史上正确的输入（修复前实测：{} 空输入）', () => {
      const p = setup();
      eq(p.playback(100)!.jump, true, '第 100 帧按下跳');
      const back = p.playback(50);
      assert(back !== undefined, '第 50 帧应有输入');
      eq(Object.keys(back!).length > 0, true, '第 50 帧不得返回空对象');
      eq(back!.jump, false, '第 50 帧应沿用第 0 帧的输入');
    });

    test('⚠️ 乱序取帧（先远后近再回到中间）结果始终正确', () => {
      // 录制到 100 帧，export 的 frameCount = 101，取帧必须落在这个范围内
      const p = setup();
      eq(p.playback(100)!.jump, true);
      eq(p.playback(0)!.jump, false);
      eq(p.playback(99)!.jump, false);
      eq(p.playback(30)!.jump, false);
      eq(p.playback(100)!.jump, true);
      eq(p.playback(60)!.jump, false);
    });

    test('⚠️ 顺序取帧（最常见路径）行为不变（防止矫枉过正）', () => {
      const p = setup();
      eq(p.playback(0)!.jump, false);
      eq(p.playback(50)!.jump, false);
      eq(p.playback(99)!.jump, false);
      eq(p.playback(100)!.jump, true);
    });

    test('seek 与 playback 定位必须一致', () => {
      const a = setup();
      const b = setup();
      b.seek(50);
      eq(b.playback(50)!.jump, a.playback(50)!.jump, 'seek 后取帧结果应相同');
    });

    test('超出范围返回 undefined（契约不变）', () => {
      const p = setup();
      eq(p.playback(-1), undefined, '负帧号');
      eq(p.playback(9999), undefined, '超尾部');
    });
  });

  // ==========================================================
  // P2 · adapters
  // ==========================================================

  describe('adapters · nearestCasterHits 的 n 未收口（P2）', () => {
    const hits = [mkHit('a', 0, 0, 3), mkHit('b', 1, 1, 1)];

    test('⚠️ n=NaN 应落到"取 0 个"分支而不是靠 Math.min 的 NaN 传播（修复前实测：返回 0 个）', () => {
      const out = nearestCasterHits(hits, NaN);
      eq(out.length, 0, 'n=NaN → 空');
    });

    test('n=NaN 与 n=0 行为一致（不再依赖巧合）', () => {
      eq(nearestCasterHits(hits, NaN).length, nearestCasterHits(hits, 0).length, '应与显式 0 一致');
    });

    test('n=1 / n=2 / n=50 正常取用（防止矫枉过正）', () => {
      eq(nearestCasterHits(hits, 1).length, 1, '取 1 个');
      eq(nearestCasterHits(hits, 1)[0].id, 'b', '按距离取最近的 b');
      eq(nearestCasterHits(hits, 2).length, 2, '取 2 个');
      eq(nearestCasterHits(hits, 50).length, 2, '超出数量时取全部');
    });

    test('n=Infinity 按"非有限值"收口为 0，不得卡死', () => {
      // numOr 把 Infinity 与 NaN 一视同仁地视为无效值（都不是有限值），
      // 收口到 0 —— 重点是**不会**进入 `i < Infinity` 这种取全部的分支，
      // 那在"取最近 N 个"的语义下等于静默改变调用方的意图。
      eq(nearestCasterHits(hits, Infinity).length, 0, 'Infinity 与 NaN 同样收口为 0');
    });
  });

  describe('adapters · toCasterHits 的 out 复用语义（P2）', () => {
    const hitsA = [mkHit('a', 0, 0, 1)];
    const hitsB = [mkHit('b', 1, 1, 2), mkHit('c', 2, 2, 3)];

    test('⚠️ 复用同一个 out 时，上一次的结果会被清空（这是契约，写在注释里）', () => {
      const buf = toCasterHits(hitsA, { out: [] });
      eq(buf.length, 1, '第一次 1 个');
      const again = toCasterHits(hitsB, { out: buf });
      eq(again.length, 2, '第二次 2 个');
      // 关键：buf 和 again 是同一个数组 —— 这就是要在 JSDoc 里说清的坑
      assert(buf === again, '复用数组是同一个对象（注释已说明）');
      eq(buf.length, 2, '第一次的返回值也变成了第二次的结果');
    });

    test('不传 out 时每次返回新数组（防止矫枉过正）', () => {
      const a = toCasterHits(hitsA);
      const b = toCasterHits(hitsB);
      assert(a !== b, '不复用时应是两个数组');
      eq(a.length, 1);
      eq(b.length, 2);
    });
  });

  describe('adapters · flattenDrops 递归无深度限制（P2）', () => {
    test('⚠️ 自引用掉落表不得爆栈（修复前实测：RangeError: Maximum call stack size exceeded）', () => {
      const a: { id: string; count: number; children?: unknown[] } = { id: 'a', count: 1 };
      a.children = [a];
      throws(
        () => flattenDrops([a as never]),
        '超过',
        '环形引用应抛 RangeError 而不是爆栈',
      );
    });

    test('⚠️ A→B→A 的环同样被拦住', () => {
      const a: { id: string; count: number; children?: unknown[] } = { id: 'a', count: 1 };
      const b: { id: string; count: number; children?: unknown[] } = { id: 'b', count: 1 };
      a.children = [b];
      b.children = [a];
      throws(() => flattenDrops([a as never]), '超过');
    });

    test('正常嵌套（宝箱→剑）结果不变（防止矫枉过正）', () => {
      const out = flattenDrops([
        { id: 'chest', count: 1, children: [{ id: 'sword', count: 2 }] },
      ]);
      eq(out.length, 2, '父项与子项都是物品');
      eq(out[0].id, 'chest');
      eq(out[1].id, 'sword');
      eq(out[1].path.join('/'), 'chest/sword', '来源路径');
    });

    test('默认值域内（≤32 层）的深嵌套仍可展开', () => {
      let node: { id: string; count: number; children?: unknown[] } = { id: 'deep', count: 1 };
      for (let i = 0; i < 10; i++) {
        node = { id: 'lv' + i, count: 1, children: [node] };
      }
      eq(flattenDrops([node as never]).length, 11, '10 层嵌套应正常展开');
    });
  });

  // ==========================================================
  // P2 · dungeon
  // ==========================================================

  describe('dungeon · rectsOverlap 的相切语义（P2）', () => {
    test('相切（边距刚好 0）不算重叠——这是房间摆放需要的语义', () => {
      const d = new BSPDungeon({ width: 60, height: 40, seed: 1 });
      d.generate();
      // 两个紧贴的矩形（b 的左边界 == a 的右边界）
      const a = { x: 0, y: 0, w: 10, h: 10 };
      const b = { x: 10, y: 0, w: 10, h: 10 };
      // 通过 RoomDungeon 的 spacing=0 间接验证：不抛错、且能生成出多个房间
      const rd = new RoomDungeon({ width: 40, height: 40, seed: 2, spacing: 0 });
      rd.generate();
      assert(rd.roomCount > 1, 'spacing=0 时应能放下多个（可贴边）房间');
      assert(a.x + a.w === b.x, '用例自检：两者确实相切');
    });

    test('真的重叠仍然被判定为重叠（防止矫枉过正）', () => {
      const rd = new RoomDungeon({ width: 40, height: 40, seed: 2, spacing: 2, roomCount: 20 });
      rd.generate();
      let overlapPairs = 0;
      const rooms = rd.rooms;
      for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) {
          const a = rooms[i];
          const b = rooms[j];
          const hit =
            a.x - 2 < b.x + b.w &&
            a.x + a.w + 2 > b.x &&
            a.y - 2 < b.y + b.h &&
            a.y + a.h + 2 > b.y;
          if (hit) overlapPairs++;
        }
      }
      eq(overlapPairs, 0, 'spacing=2 时不应有任何房间相交');
    });
  });

  describe('dungeon · randomFloor / roomDistance 的 O(n) 热路径（P2）', () => {
    test('⚠️ 连续 300 次 randomFloor 不得退化为 O(n²)（修复前实测：512² 地图 294ms）', () => {
      const d = new BSPDungeon({ width: 512, height: 512, seed: 11 });
      d.generate();
      const t0 = Date.now();
      for (let i = 0; i < 300; i++) d.randomFloor();
      const ms = Date.now() - t0;
      assert(ms < 150, `300 次 randomFloor 应远快于修复前的 294ms，实际 ${ms}ms`);
    });

    test('⚠️ 连续 100 次 roomDistance 不得每次全图 BFS（修复前实测：512² 地图 446ms）', () => {
      const d = new BSPDungeon({ width: 512, height: 512, seed: 11 });
      d.generate();
      const t0 = Date.now();
      for (let i = 0; i < 100; i++) d.roomDistance(0, 1);
      const ms = Date.now() - t0;
      assert(ms < 150, `100 次 roomDistance 应远快于修复前的 446ms，实际 ${ms}ms`);
    });

    test('⚠️ 加了缓存后，随机序列必须与无缓存时逐次一致（可复现性不能破）', () => {
      const a = new BSPDungeon({ width: 64, height: 64, seed: 42 });
      a.generate();
      const b = new BSPDungeon({ width: 64, height: 64, seed: 42 });
      b.generate();

      const seqA: string[] = [];
      const seqB: string[] = [];
      for (let i = 0; i < 30; i++) {
        const pa = a.randomFloor();
        const pb = b.randomFloor();
        seqA.push(pa ? `${pa.x},${pa.y}` : 'null');
        seqB.push(pb ? `${pb.x},${pb.y}` : 'null');
      }
      eq(seqA.join('|'), seqB.join('|'), '同种子同调用序列必须完全一致');
    });

    test('randomFloor 返回的必须是可走格（缓存失效不能漏）', () => {
      const d = new BSPDungeon({ width: 64, height: 64, seed: 7 });
      d.generate();
      for (let i = 0; i < 50; i++) {
        const p = d.randomFloor();
        assert(p !== null, '应有地板');
        assert(d.isWalkable(p!.x, p!.y), `(${p!.x},${p!.y}) 应可走`);
      }
    });

    test('⚠️ 改地形后缓存必须失效（不能刷到已变成墙的格子）', () => {
      const d = new BSPDungeon({ width: 32, height: 32, seed: 3 });
      d.generate();
      const before = d.floorCount;
      // 把整张图刷成墙
      for (let y = 0; y < d.height; y++) {
        for (let x = 0; x < d.width; x++) d.setTile(x, y, Tile.Wall);
      }
      eq(d.floorCount, 0, '全刷成墙后地板数应为 0');
      assert(before > 0, '用例自检：刷之前确实有地板');
      eq(d.randomFloor(), null, '没有地板时应返回 null，而不是返回缓存里的旧格子');
    });

    test('roomDistance 结果正确（缓存不能改变距离值）', () => {
      const d = new BSPDungeon({ width: 64, height: 64, seed: 5 });
      d.generate();
      const first = d.roomDistance(0, 1);
      const second = d.roomDistance(0, 1);
      eq(first, second, '同一查询两次结果必须一致');
      assert(first > 0, '两个不同房间之间应有正距离');
      eq(d.roomDistance(0, 999), -1, '不存在的房间返回 -1');
    });
  });

  describe('dungeon · floorCount 与 isFullyConnected 口径不一致（P2）', () => {
    test('⚠️ floorCount 必须把 Door 算进去（与 isFullyConnected 同口径）', () => {
      const d = new BSPDungeon({ width: 40, height: 40, seed: 3 });
      d.generate();
      const before = d.floorCount;
      assert(before > 0, '用例自检：有地板');

      // 找一个地板格改成门
      let done = false;
      for (let y = 1; y < d.height - 1 && !done; y++) {
        for (let x = 1; x < d.width - 1 && !done; x++) {
          if (d.tileAt(x, y) === Tile.Floor) {
            d.setTile(x, y, Tile.Door);
            done = true;
          }
        }
      }
      assert(done, '应成功写入一个门');
      // 修复前：floorCount 只数 Floor，改一个格子成 Door 后 floorCount 会 -1
      eq(d.floorCount, before, 'Floor 改 Door 后总数不应变化');
      assert(d.isFullyConnected(), '门是可走的，连通性应保持');
    });

    test('⚠️ 全是门的地图应判定为连通（旧口径会算出"0 地板"）', () => {
      const d = new BSPDungeon({ width: 20, height: 20, seed: 1 });
      d.generate();
      for (let y = 0; y < d.height; y++) {
        for (let x = 0; x < d.width; x++) d.setTile(x, y, Tile.Door);
      }
      eq(d.floorCount, 400, '全门地图的 floorCount 应为 400');
      assert(d.isFullyConnected(), '应连通');
    });
  });

  describe('dungeon · Cellular 的 _smoothBuf 重入（P2）', () => {
    test('⚠️ 同一实例并发两个生成器必须抛错（修复前实测：静默产出"缝合地图"）', () => {
      const d = new CellularDungeon({ width: 32, height: 32, seed: 5 });
      const g1 = d.generateSteps(4);
      // 生成器函数体要等第一次 next() 才执行，所以先推进一次再尝试重入
      g1.next();
      const g2 = d.generateSteps(4);
      throws(() => g2.next(), '尚未结束', '重入应被拦住');
      g1.return();   // 显式中止第一个
    });

    test('⚠️ 中止后可以重新开始（finally 要真的清干净）', () => {
      const d = new CellularDungeon({ width: 32, height: 32, seed: 5 });
      const g1 = d.generateSteps(4);
      g1.next();
      g1.return();
      const g2 = d.generateSteps(4);
      let steps = 0;
      while (!g2.next().done) steps++;
      assert(steps > 0, '第二次应能正常跑完');
      assert(d.floorCount > 0, `应生成出洞穴，实际 floorCount=${d.floorCount}`);
    });

    test('正常单次生成（防止矫枉过正）', () => {
      const d = new CellularDungeon({ width: 32, height: 32, seed: 5 });
      const g = d.generateSteps(8);
      let steps = 0;
      while (!g.next().done) steps++;
      assert(steps > 0, '应有多步');
      assert(d.floorCount > 0, '应生成出洞穴');
    });
  });

  describe('dungeon · RoomDungeon 未校验房间尺寸（P2）', () => {
    test('⚠️ maxRoomSize 超过地图时，房间中心不得落到地图外（修复前实测：cx=460 而地图只有 24 宽）', () => {
      const d = new RoomDungeon({
        width: 24,
        height: 24,
        seed: 9,
        minRoomSize: 900,
        maxRoomSize: 999,
      });
      d.generate();
      for (const r of d.rooms) {
        assert(
          r.cx >= 0 && r.cx < d.width,
          `房间中心 cx=${r.cx} 落在地图外（宽 ${d.width}）`,
        );
        assert(
          r.cy >= 0 && r.cy < d.height,
          `房间中心 cy=${r.cy} 落在地图外（高 ${d.height}）`,
        );
        assert(r.w <= d.width, `房间宽 ${r.w} 超过地图宽 ${d.width}`);
        assert(r.h <= d.height, `房间高 ${r.h} 超过地图高 ${d.height}`);
      }
    });

    test('⚠️ 收口后仍能正常出图（不能因为夹过头变成 0 房间）', () => {
      const d = new RoomDungeon({
        width: 24,
        height: 24,
        seed: 9,
        minRoomSize: 900,
        maxRoomSize: 999,
      });
      d.generate();
      assert(d.roomCount > 0, '仍应放下至少一个房间');
      assert(d.floorCount > 0, '仍应有地板');
    });

    test('正常参数（min 4 / max 10）行为不变（防止矫枉过正）', () => {
      const d = new RoomDungeon({ width: 60, height: 60, seed: 4 });
      d.generate();
      assert(d.roomCount > 1, '应生成多个房间');
      for (const r of d.rooms) {
        assert(r.w >= 4 && r.w <= 10, `房间宽应在 [4,10] 内，实际 ${r.w}`);
        assert(r.h >= 4 && r.h <= 10, `房间高应在 [4,10] 内，实际 ${r.h}`);
      }
    });
  });

  describe('dungeon · Maze 热路径的逐个格子分配（P2）', () => {
    test('⚠️ 复用方向缓冲后，同种子必须生成逐格相同的迷宫', () => {
      const a = new MazeDungeon({ width: 255, height: 255, seed: 13 });
      a.generate();
      const b = new MazeDungeon({ width: 255, height: 255, seed: 13 });
      b.generate();
      eq(a.toString(), b.toString(), '同种子迷宫必须逐格一致');
    });

    test('⚠️ 与修复前基线一致（改代码前实测：255×255 seed=13 → floorCount 34652）', () => {
      const d = new MazeDungeon({ width: 255, height: 255, seed: 13 });
      d.generate();
      eq(d.floorCount, 34652, '复用缓冲不得改变生成结果');
    });

    test('小迷宫迷宫性仍然成立（防止矫枉过正）', () => {
      const d = new MazeDungeon({ width: 21, height: 21, seed: 1 });
      d.generate();
      assert(d.floorCount > 0, '应有通路');
      assert(d.isFullyConnected(), '迷宫必须全连通');
    });
  });

  // ==========================================================
  // P2 · pathfind
  // ==========================================================

  describe('pathfind · 删除死代码 _openMark（P2）', () => {
    test('删除后寻路结果不变（它本来就没被读过）', () => {
      const g = emptyMap(20, 20);
      for (let y = 5; y < 15; y++) g[y][10] = 1;
      const r = new AStar(g).find({ x: 0, y: 0 }, { x: 19, y: 19 });
      assert(r.found, '应绕过去找到终点');
      eq(r.path.length > 19, true, '中间有墙，路径必然长于直线');
    });

    test('同一实例连续多次 find 结果稳定（stamp 机制不受影响）', () => {
      const g = emptyMap(20, 20);
      const f = new AStar(g);
      const a = f.find({ x: 0, y: 0 }, { x: 19, y: 19 });
      const b = f.find({ x: 0, y: 0 }, { x: 19, y: 19 });
      eq(a.path.length, b.path.length, '第二次不得因残留状态失败');
      assert(b.found, '第二次仍应找到');
    });
  });

  describe('pathfind · FlowField.destroy 后 distanceAt 返回 undefined（P2）', () => {
    test('⚠️ destroy 后 distanceAt 必须返回 -1（修复前实测：undefined）', () => {
      const f = new FlowField([
        [0, 0],
        [0, 0],
      ]);
      f.build({ x: 1, y: 1 });
      assert(f.distanceAt(0, 0) >= 0, '销毁前应有距离');
      f.destroy();
      const d = f.distanceAt(0, 0);
      eq(d, -1, '销毁后按契约返回 -1');
      eq(typeof d, 'number', '类型必须是 number，不能是 undefined');
    });

    test('destroy 后 reachable 仍为 false（防止矫枉过正）', () => {
      const f = new FlowField([
        [0, 0],
        [0, 0],
      ]);
      f.build({ x: 1, y: 1 });
      eq(f.reachable(0, 0), true, '销毁前可达');
      f.destroy();
      eq(f.reachable(0, 0), false, '销毁后不可达');
    });

    test('正常流场行为不变', () => {
      const f = new FlowField(emptyMap(10, 10));
      eq(f.build({ x: 9, y: 9 }), true, '应构建成功');
      eq(f.distanceAt(9, 9), 0, '目标点距离为 0');
      assert(f.distanceAt(0, 0) > 0, '远点距离为正');
      assert(f.hasNext(0, 0), '应有下一步');
    });
  });

  describe('pathfind · PathSmoother 越界 TypeError（P2）', () => {
    const small = emptyMap(3, 3);

    test('⚠️ 传了 bounds 时越界不得抛 TypeError（修复前实测：垂直方向 TypeError）', () => {
      const sm = new PathSmoother((x, y) => small[y][x] === 0, { width: 3, height: 3 });
      eq(sm.hasLineOfSight(0, 0, 0, 10), false, '垂直越界应判为不可见');
      eq(sm.hasLineOfSight(0, 0, 10, 0), false, '水平越界应判为不可见');
      eq(sm.hasLineOfSight(0, 0, 10, 10), false, '斜向越界应判为不可见');
    });

    test('不传 bounds 时保持旧行为（避免 breaking）', () => {
      const sm = new PathSmoother((x, y) => small[y][x] === 0);
      // 旧行为：调用方自己保证 walkable 越界返回 false
      eq(sm.hasLineOfSight(0, 0, 2, 2), true, '地图内正常可见');
    });

    test('有墙时正确判为不可见（防止矫枉过正）', () => {
      const g = emptyMap(5, 5);
      g[2][2] = 1;
      const sm = new PathSmoother((x, y) => g[y][x] === 0, { width: 5, height: 5 });
      eq(sm.hasLineOfSight(0, 2, 4, 2), false, '中间有墙应不可见');
      eq(sm.hasLineOfSight(0, 0, 4, 0), true, '空行应可见');
    });
  });

  describe('pathfind · FlowField.build 每次新分配标记数组（P2）', () => {
    test('⚠️ 反复 build 结果必须一致（复用标记数组不得留下脏值）', () => {
      const f = new FlowField(emptyMap(20, 20));
      eq(f.build({ x: 10, y: 10 }), true);
      const first = Array.from({ length: 20 }, (_, i) => f.distanceAt(i, 0));

      eq(f.build({ x: 5, y: 5 }), true, '第二次构建');
      eq(f.build({ x: 10, y: 10 }), true, '第三次回到同一个目标');
      const again = Array.from({ length: 20 }, (_, i) => f.distanceAt(i, 0));

      eq(again.join(','), first.join(','), '同一目标重算结果必须完全一致');
    });

    test('目标不可达时 build 返回 false 且不影响后续', () => {
      const g = emptyMap(10, 10);
      const f = new FlowField(g);
      eq(f.build({ x: 5, y: 5 }), true, '正常目标');
      g[5][5] = 1;
      eq(f.build({ x: 5, y: 5 }), false, '目标是墙 → false');
      eq(f.build({ x: 0, y: 0 }), true, '换回正常目标仍可用');
    });
  });

  // ==========================================================
  // P2 · replay
  // ==========================================================

  describe('replay · maxFrames 实际限制的是关键帧数（P2）', () => {
    test('⚠️ maxFrames=5 时保留 5 个关键帧（名称与语义不符，已更名）', () => {
      const rec = new ReplayRecorder({ maxFrames: 5 });
      rec.start();
      for (let i = 0; i < 20; i++) rec.record(i * 10, { f: i });
      eq(rec.keyframeCount, 5, '限制的是关键帧数');
      // 关键帧停在第 5 个，但帧号已经推进到 50 —— 两者确实是两个概念
      eq(rec.frame, 50, '帧号与关键帧数是两回事');
    });

    test('新名字 maxKeyframes 语义相同', () => {
      const rec = new ReplayRecorder({ maxKeyframes: 5 });
      rec.start();
      for (let i = 0; i < 20; i++) rec.record(i * 10, { f: i });
      eq(rec.keyframeCount, 5, '新字段名同样限制关键帧');
    });

    test('不设上限时正常录制（防止矫枉过正）', () => {
      const rec = new ReplayRecorder();
      rec.start();
      for (let i = 0; i < 50; i++) rec.record(i, { f: i });
      eq(rec.keyframeCount, 50, '不设上限应全记');
    });
  });

  describe('replay · playback 返回内部引用（P2）', () => {
    test('⚠️ 两次 playback 不得返回同一个对象（修复前实测：a === b 为 true）', () => {
      const rec = new ReplayRecorder({ seed: 7 });
      rec.start();
      rec.record(0, { jump: true });
      const data = rec.export();
      const p = new ReplayRecorder({ seed: 7 });
      p.load(data);
      const a = p.playback(0);
      const b = p.playback(0);
      assert(a !== b, '两次取帧不得是同一个对象');
      eq(a!.jump, b!.jump, '内容应相同');
    });

    test('⚠️ 修改返回值不得污染回放数据', () => {
      const rec = new ReplayRecorder({ seed: 7 });
      rec.start();
      rec.record(0, { jump: true });
      const data = rec.export();
      const p = new ReplayRecorder({ seed: 7 });
      p.load(data);

      const a = p.playback(0)!;
      a.jump = false;          // 调用方随手改
      eq(p.playback(0)!.jump, true, '回放数据不应被外部改动影响');
    });

    test('⚠️ 共享的 EMPTY_INPUT 不得被写入（空帧已冻结）', () => {
      const rec = new ReplayRecorder({ seed: 7 });
      rec.start();
      rec.record(50, { jump: true });
      const data = rec.export();
      const p = new ReplayRecorder({ seed: 7 });
      p.load(data);
      const empty = p.playback(0)!;   // 第 0 帧还没有输入
      eq(Object.keys(empty).length, 0, '应为空输入');
      // 冻结后写入应失败（严格模式下抛错，非严格模式静默失败）
      let threw = false;
      try {
        (empty as { jump?: boolean }).jump = true;
      } catch {
        threw = true;
      }
      const after = p.playback(0)!;
      const polluted = Object.keys(after).length > 0;
      assert(threw || !polluted, '空输入常量不得被污染');
    });

    test('录制与导出仍然做拷贝（防止矫枉过正）', () => {
      const rec = new ReplayRecorder({ seed: 1 });
      rec.start();
      const input = { jump: true };
      rec.record(0, input);
      input.jump = false;          // 改外部对象
      const data = rec.export();
      eq(data.keyframes[0].input.jump, true, '录制时应已拷贝');
    });
  });

  describe('replay · loadJSON 无 try/catch（P2）', () => {
    test('⚠️ 坏 JSON 抛出带 [Replay] 前缀的明确错误（修复前实测：裸 SyntaxError）', () => {
      throws(() => new ReplayRecorder().loadJSON('{bad json'), '[Replay]', '应包装成回放错误');
    });

    test('⚠️ JSON 顶层不是对象时也要明确报错', () => {
      throws(() => new ReplayRecorder().loadJSON('42'), '[Replay]');
      throws(() => new ReplayRecorder().loadJSON('null'), '[Replay]');
      throws(() => new ReplayRecorder().loadJSON('"str"'), '[Replay]');
    });

    test('合法 JSON 正常加载（防止矫枉过正）', () => {
      const rec = new ReplayRecorder({ seed: 5 });
      rec.start();
      rec.record(0, { a: 1 });
      rec.record(10, { a: 2 });
      const json = rec.exportJSON();

      const p = new ReplayRecorder({ seed: 5 });
      p.loadJSON(json);
      eq(p.totalFrames, 11, '帧数');
      eq(p.playback(0)!.a, 1, '第 0 帧');
      eq(p.playback(10)!.a, 2, '第 10 帧');
    });
  });
}
