/**
 * examples/batch6-usage.ts —— 第五批插件的综合示例
 *
 * 【演示：从零生成一张可玩的地图，并在上面跑寻路、视野、怪群】
 *
 *   noise     程序化生成地形
 *   ds        数据结构（四叉树 / 空间哈希 / 并查集 / 优先队列）
 *   dungeon   地牢生成（BSP）
 *   pathfind  A* 寻路 + 流场
 *   fov       视野与战争迷雾
 *   steering  怪群 AI（boids）
 *
 * 【这批的共同主题：算法】
 * 前几批是"业务框架"（背包、任务、商店），
 * 这批是"算法工具"——它们不认识你的游戏，只认数字和坐标。
 *
 * 正因为如此，它们才最容易被复用：
 * 换一个游戏，这些代码一行都不用改。
 *
 * 【运行】
 *   npm run example:batch6
 */

import { SimplexNoise, Noise, fbm2D } from '../noise/Noise';
import { BinaryHeap, DisjointSet, QuadTree, SpatialHash } from '../ds/DataStructures';
import { AStar, FlowField, PathSmoother } from '../pathfind/PathFinder';
import { Shadowcasting } from '../fov/FOV';
import { BSPDungeon, CellularDungeon } from '../dungeon/Dungeon';
import {
  createAgent,
  v2,
  arrive,
  Flock,
  applyForce,
  integrate,
  constrain,
} from '../steering/Steering';

async function main(): Promise<void> {
  console.log('========== 第五批：算法工具 ==========\n');

  // ---------- 1. 噪声：程序化地形 ----------
  console.log('【1】噪声（noise）—— 程序化地形的地基');

  const noise = new SimplexNoise(20260902);

  // 单个噪声值
  console.log(`  原始噪声几个采样点：${[0, 1, 2, 3].map((i) => noise.noise2D(i * 0.5, 0).toFixed(3)).join(', ')}`);

  // 对比：纯随机 vs 噪声
  let randomJump = 0;
  let noiseJump = 0;
  let prevR = Math.random();
  let prevN = noise.noise2D(0, 0);
  for (let i = 1; i < 100; i++) {
    const r = Math.random();
    randomJump += Math.abs(r - prevR);
    prevR = r;

    const n = noise.noise2D(i * 0.05, 0);
    noiseJump += Math.abs(n - prevN);
    prevN = n;
  }
  console.log(`  100 步累积跳变：随机数 ${randomJump.toFixed(1)} vs 噪声 ${noiseJump.toFixed(1)}`);
  console.log(`  ↑ 噪声是"平滑的随机"，这是它能当地形的唯一原因`);

  // 分形：多倍频
  const uni = new Noise(42);
  const flat = fbm2D(noise, 1.5, 2.5, { octaves: 1 });
  const detailed = fbm2D(noise, 1.5, 2.5, { octaves: 5 });
  console.log(`  同一点：1 个倍频 ${flat.toFixed(4)}，5 个倍频 ${detailed.toFixed(4)}`);
  console.log(`  ↑ 倍频叠加产生"大起伏 + 小细节"的层次`);

  // 生成高度图
  const hm = uni.heightMap(48, 24, 0.08, { octaves: 4 });
  console.log(`  高度图 48×24 已生成，值域 [${Math.min(...hm).toFixed(3)}, ${Math.max(...hm).toFixed(3)}]`);
  console.log(`  ↑ heightMap 默认归一化到 [0,1]，阈值判断才稳定\n`);

  // ASCII 预览
  console.log('  地形预览（# 高地 · ~ 中地 · 空格 低地）：');
  for (let y = 0; y < 24; y += 2) {
    let row = '    ';
    for (let x = 0; x < 48; x++) {
      const h = hm[y * 48 + x];
      row += h > 0.62 ? '#' : h > 0.45 ? '~' : ' ';
    }
    console.log(row);
  }

  // ---------- 2. 数据结构 ----------
  console.log('\n【2】数据结构（ds）');

  // 优先队列
  const heap = new BinaryHeap<{ name: string; priority: number }>((a, b) => a.priority - b.priority);
  heap.push({ name: '普通攻击', priority: 5 });
  heap.push({ name: '暴击', priority: 1 });
  heap.push({ name: '治疗', priority: 3 });
  console.log('  优先队列（数字小的先出）：');
  while (!heap.isEmpty) {
    const t = heap.pop()!;
    console.log(`    → ${t.name}（优先级 ${t.priority}）`);
  }

  // 并查集：检查连通性
  const uf = new DisjointSet(6);
  uf.union(0, 1);
  uf.union(1, 2);
  uf.union(3, 4);
  console.log(`\n  并查集：6 个房间，连了 (0-1) (1-2) (3-4)`);
  console.log(`    0 和 2 连通吗：${uf.connected(0, 2)}`);
  console.log(`    0 和 5 连通吗：${uf.connected(0, 5)}`);
  console.log(`    连通分量 ${uf.componentCount} 个 → ${uf.groups().map((g) => `[${g.join(',')}]`).join(' ')}`);
  console.log(`  ↑ 大于 1 就说明有房间没连上，这是死图检测的核心`);

  // 空间哈希：邻居查询
  const sh = new SpatialHash(50);
  for (let i = 0; i < 20; i++) {
    sh.insert(i, (i * 37) % 200, (i * 53) % 200);
  }
  const near = sh.queryNeighbors(74, 106, 1);
  console.log(`\n  空间哈希：20 个物体，查 (74,106) 附近 → ${near.length} 个`);
  console.log(`  ↑ 不用它就要 O(n²) 两两比较`);

  // 四叉树：范围查询
  const qt = new QuadTree<string>({ x: 0, y: 0, w: 200, h: 200 });
  for (let i = 0; i < 50; i++) {
    qt.insert((i * 37) % 200, (i * 53) % 200, `obj${i}`);
  }
  const inRange = qt.query({ x: 0, y: 0, w: 60, h: 60 });
  console.log(`  四叉树：50 个物体，查 (0,0)-(60,60) → ${inRange.length} 个`);
  console.log(`  count 字段：${qt.count}（应为 50，曾因分裂重复计数变成 95）`);

  // ---------- 3. 地牢生成 ----------
  console.log('\n【3】地牢生成（dungeon）');

  const dungeon = new BSPDungeon({ width: 56, height: 26, seed: 20260902, minRoomSize: 5, maxDepth: 4 });
  dungeon.generate();

  console.log(`  BSP 生成：${dungeon.width}×${dungeon.height}，${dungeon.roomCount} 个房间，${dungeon.floorCount} 格地板`);
  console.log(`  全连通吗：${dungeon.isFullyConnected() ? '是' : '否 ← 死图！'}`);
  console.log(`  所有房间可达吗：${dungeon.allRoomsReachable() ? '是' : '否'}`);

  if (dungeon.roomCount > 1) {
    const far = dungeon.findFarthestRoom(0);
    const dist = dungeon.roomDistance(0, far);
    console.log(`  离 0 号房最远的是 ${far} 号（${dist} 步）→ 出口/Boss 放这里`);
  }

  console.log('\n' + dungeon.toString().split('\n').map((l) => '  ' + l).join('\n'));

  // 洞穴对比
  const cave = new CellularDungeon({ width: 56, height: 20, seed: 20260902 });
  cave.generate();
  console.log(`  元胞洞穴：${cave.floorCount} 格，连通 ${cave.isFullyConnected()}`);
  console.log('  ↑ 不清理孤岛的话，宝箱可能生成在走不到的地方');
  console.log(cave.toString().split('\n').map((l) => '  ' + l).join('\n'));

  // ---------- 4. 寻路 ----------
  console.log('【4】寻路（pathfind）');

  // 把地牢转成 A* 地图
  const map: number[][] = [];
  for (let y = 0; y < dungeon.height; y++) {
    const row: number[] = [];
    for (let x = 0; x < dungeon.width; x++) {
      row.push(dungeon.isWalkable(x, y) ? 0 : 1);
    }
    map.push(row);
  }

  if (dungeon.roomCount >= 2) {
    const a = dungeon.rooms[0];
    const b = dungeon.rooms[dungeon.roomCount - 1];

    const finder = new AStar(map, { allowDiagonal: true });
    const t0 = Date.now();
    const result = finder.find({ x: a.cx, y: a.cy }, { x: b.cx, y: b.cy });
    const dt = Date.now() - t0;

    console.log(`  A*：(${a.cx},${a.cy}) → (${b.cx},${b.cy})`);
    console.log(`    找到：${result.found}，${result.path.length} 步，探索 ${result.nodesExplored} 个节点，耗时 ${dt}ms`);

    // 平滑
    const smoother = new PathSmoother((x, y) => dungeon.isWalkable(x, y));
    const smoothed = smoother.smooth({ x: a.cx, y: a.cy }, result.path);
    console.log(`    平滑后：${smoothed.length} 步（去掉 ${result.path.length - smoothed.length} 个冗余拐点）`);
    console.log(`  ↑ 网格 A* 的路径是锯齿状的，平滑后单位才不会"抽搐"`);

    // 重复寻路（验证内部缓冲区复用）
    const again = finder.find({ x: a.cx, y: a.cy }, { x: b.cx, y: b.cy });
    console.log(`    再算一次：${again.found}，${again.path.length} 步（应与上次一致）`);

    // 流场：多单位共用
    const field = new FlowField(map, true);
    const tf = Date.now();
    field.build({ x: b.cx, y: b.cy });
    const dtf = Date.now() - tf;
    console.log(`\n  流场：一次构建耗时 ${dtf}ms，之后每个单位查询是 O(1)`);
    console.log(`    从 (${a.cx},${a.cy}) 到目标的距离：${field.distanceAt(a.cx, a.cy).toFixed(1)}`);
    const trace = field.tracePath(a.cx, a.cy);
    console.log(`    追踪路径：${trace.length} 步`);

    console.log(`\n  【怎么选】`);
    console.log(`    1 个单位找路 → A*（${dt}ms）`);
    console.log(`    100 个单位去同一个点 → 流场（构建 ${dtf}ms + 100 × 0ms）`);
  }

  // ---------- 5. 视野 ----------
  console.log('\n【5】视野与战争迷雾（fov）');

  const isWall = (x: number, y: number) => !dungeon.isWalkable(x, y);
  const fov = new Shadowcasting(dungeon.width, dungeon.height, isWall);

  if (dungeon.roomCount > 0) {
    const start = dungeon.rooms[0];
    const seen = fov.compute(start.cx, start.cy, 8);
    console.log(`  站在 (${start.cx},${start.cy})，视野半径 8`);
    console.log(`    可见 ${seen} 格`);

    // 走到最远的房间（这样才能体现"离开后看不见，但记忆还在"）
    if (dungeon.roomCount > 1) {
      const farId = dungeon.findFarthestRoom(0);
      const r2 = dungeon.rooms.find((r) => r.id === farId)!;
      fov.compute(r2.cx, r2.cy, 8);
      console.log(`    走到最远的 ${farId} 号房 (${r2.cx},${r2.cy})，可见 ${fov.visible.count} 格`);
      console.log(`    起点房还"看得见"吗：${fov.canSee(start.cx, start.cy)}（应为 false，离得远）`);
      console.log(`    但"探索过"吗：${fov.hasExplored(start.cx, start.cy)}（应为 true ← 灰暗显示）`);
      console.log(`    累计探索 ${fov.explored.count} 格`);
    }

    // 视线判定
    const far = dungeon.findFarthestRoom(0);
    if (far !== 0) {
      const rf = dungeon.rooms.find((r) => r.id === far)!;
      const los = fov.hasLineOfSight(start.cx, start.cy, rf.cx, rf.cy);
      console.log(`\n  视线判定：0 号房能直线看到 ${far} 号房吗：${los}`);
      console.log(`  ↑ 远程攻击、AI 发现玩家用这个，比完整 FOV 快得多`);
    }
  }

  // ---------- 6. 怪群 AI ----------
  console.log('\n【6】群体转向（steering）');

  const flock = new Flock({
    separationRadius: 2.2,
    cohesionRadius: 6,
    alignmentRadius: 5,
    separationWeight: 2.0,
    cohesionWeight: 0.8,
    alignmentWeight: 0.6,
  });

  // 在一个房间里放 8 只怪
  const room = dungeon.rooms[0];
  const enemies = [];
  for (let i = 0; i < 8; i++) {
    enemies.push(
      createAgent(
        v2(room.cx + (i % 4) * 0.8 - 1.2, room.cy + Math.floor(i / 4) * 0.8),
        v2(0, 0),
        { maxSpeed: 3, maxForce: 12, radius: 0.4 }
      )
    );
  }

  const playerPos = v2(room.cx + 2, room.cy);

  console.log(`  8 只怪在 (${room.cx},${room.cy}) 附近，玩家在 (${playerPos.x}, ${playerPos.y})`);
  console.log('  模拟 3 秒（60 步 × 3）：');

  for (let step = 0; step < 180; step++) {
    for (const e of enemies) {
      // 群体力 + 追击玩家
      applyForce(e, flock.compute(e, enemies));
      applyForce(e, arrive(e, playerPos, 4, 0.6));
    }
    for (const e of enemies) {
      const prevX = e.pos.x;
      const prevY = e.pos.y;

      integrate(e, 1 / 60);

      /**
       * 【为什么必须回退位置】
       * 只把速度反向（常见的"撞墙反弹"写法）是不够的：
       * 单位已经**在墙里了**，下一帧它还是从墙里出发，
       * 于是会卡在墙里反复横跳，看起来像穿墙。
       *
       * 正确做法：先回退到撞墙前的位置，再处理速度。
       */
      if (!dungeon.isWalkable(Math.round(e.pos.x), Math.round(e.pos.y))) {
        e.pos.x = prevX;
        e.pos.y = prevY;
        e.vel.x *= -0.3;
        e.vel.y *= -0.3;
      }

      constrain(e, 1, 1, dungeon.width - 2, dungeon.height - 2, false);
    }

    if (step === 60 || step === 179) {
      const avgDist = enemies.reduce((s, e) => {
        const dx = e.pos.x - playerPos.x;
        const dy = e.pos.y - playerPos.y;
        return s + Math.sqrt(dx * dx + dy * dy);
      }, 0) / enemies.length;
      console.log(`    第 ${(step / 60).toFixed(1)} 秒：与玩家平均距离 ${avgDist.toFixed(2)}`);
    }
  }

  // 检查是否叠在一起
  let minGap = Infinity;
  for (let i = 0; i < enemies.length; i++) {
    for (let j = i + 1; j < enemies.length; j++) {
      const dx = enemies[i].pos.x - enemies[j].pos.x;
      const dy = enemies[i].pos.y - enemies[j].pos.y;
      minGap = Math.min(minGap, Math.sqrt(dx * dx + dy * dy));
    }
  }
  console.log(`\n  最近的间距：${minGap.toFixed(2)}`);
  console.log(`  ↑ 分离行为让它不会叠成一坨（没有分离的话会趋向 0）`);

  // 可视化最终位置
  console.log('\n  最终位置（@ = 玩家，o = 怪）：');
  const grid: string[][] = [];
  for (let y = 0; y < dungeon.height; y++) {
    grid.push(new Array(dungeon.width).fill(dungeon.isWalkable(0, y) ? ' ' : '#'));
    for (let x = 0; x < dungeon.width; x++) grid[y][x] = dungeon.isWalkable(x, y) ? ' ' : '#';
  }
  grid[Math.round(playerPos.y)][Math.round(playerPos.x)] = '@';
  for (const e of enemies) {
    const x = Math.round(e.pos.x);
    const y = Math.round(e.pos.y);
    if (x >= 0 && y >= 0 && x < dungeon.width && y < dungeon.height) grid[y][x] = 'o';
  }
  for (const row of grid) console.log('    ' + row.join(''));

  console.log('\n========== 示例结束 ==========');
}

declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== 'undefined' && require?.main === module) {
  main();
}

export { main };
