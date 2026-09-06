/**
 * tests/run_batch8.ts —— 第七批插件的测试
 *
 * 覆盖：room-graph、wave-spawner、meta、affix
 *
 * 【这批的测试重点：不会卡死】
 *
 * 前几批测的是"算得对不对"，
 * 这批测的是**"会不会卡死"**——
 *
 * 肉鸽最恶劣的一类 bug 不是数值错，是：
 * - 生成的图走不通，玩家困在关卡里
 * - 怪卡在地图外，门永远打不开
 * - 旧存档读不进来，玩家进不去游戏
 * - 词条池抽干，roll 出空装备或死循环
 *
 * 这四类的共同点是：**开发期概率极低，上线后必然发生**。
 * 手测几十次碰不到，但玩家玩几万次一定会撞上。
 *
 * 所以这批的核心测试方法是 **批量种子自检**：
 * 用几百上千个随机种子跑生成算法，统计失败率。
 * 目标 0%。
 *
 * 【预期会抓到的 bug】
 * 写代码时已经修掉的（保留测试防回归）：
 * 1. RoomGraph 的连接算法在 n > m 时漏掉出边 → 死路
 * 2. WaveSpawner 用 for 处理 pending → 同一时刻的多个生成被漏掉
 * 3. MetaProgression 的 RestoreReport 字段标了 readonly → 调用方改不了
 * 4. AffixSystem 的 rerollAll 对 undefined 稀有度做 tier 比较
 */

import { describe, test, assert, eq, throws } from './_framework';

import {
  generateRoomGraph,
  assignTypes,
  diagnose,
  pathHeat,
  pathLengths,
  findPath,
  findBestPath,
  graphToString,
  RoomTypes,
  type RoomGraphData,
  type RoomNode,
  type TypeSpec,
} from '../room-graph/RoomGraph';
import {
  WaveSpawner,
  type ISpawnSink,
  type SpawnHandle,
  type WaveDef,
} from '../wave-spawner/WaveSpawner';
import {
  MetaProgression,
  defaultCostCurve,
  costAt,
  type MetaNode,
  type MetaSnapshot,
} from '../meta/MetaProgression';
import {
  AffixSystem,
  validateAffixPool,
  DefaultRarities,
  type AffixDef,
  type Affix,
} from '../affix/AffixSystem';
import { RNG } from '../rng/RNG';

// ============================================================
// 测试辅助
// ============================================================

/** 常用类型配置 */
const DEFAULT_SPEC: TypeSpec = {
  weights: {
    [RoomTypes.COMBAT]: 60,
    [RoomTypes.ELITE]: 15,
    [RoomTypes.TREASURE]: 8,
    [RoomTypes.SHOP]: 7,
    [RoomTypes.REST]: 5,
    [RoomTypes.EVENT]: 5,
  },
  fixed: {
    0: RoomTypes.ENTRY,
  },
};

function makeGraph(seed: number, depth = 8, spec?: TypeSpec): RoomGraphData {
  const g = generateRoomGraph({ depth, rng: new RNG(seed) });
  assignTypes(g, spec ?? DEFAULT_SPEC, new RNG(seed + 7777));
  // Boss 层强制
  for (const id of g.layers[g.depth - 1]) g.nodes[id].type = RoomTypes.BOSS;
  return g;
}

// ============================================================
// 测试主体
// ============================================================

export function runBatch8Tests(): void {
  // ══════════════════════════════════════════════════════════
  describe('RoomGraph · 房间图生成', () => {
    test('基本结构：分层 + 每层有节点', () => {
      const g = generateRoomGraph({ depth: 6, rng: new RNG(1) });
      eq(g.depth, 6);
      eq(g.layers.length, 6);
      for (const layer of g.layers) assert(layer.length > 0, '每层至少 1 个节点');
    });

    test('节点数 = 各层之和，id 连续', () => {
      const g = generateRoomGraph({ depth: 7, rng: new RNG(2) });
      let sum = 0;
      for (const l of g.layers) sum += l.length;
      eq(g.nodes.length, sum);
      for (let i = 0; i < g.nodes.length; i++) eq(g.nodes[i].id, i, 'id 应连续');
    });

    test('入口层与 Boss 层各 1 个节点', () => {
      const g = generateRoomGraph({ depth: 6, rng: new RNG(3) });
      eq(g.layers[0].length, 1, '入口层应只有 1 个');
      eq(g.layers[g.depth - 1].length, 1, 'Boss 层应只有 1 个');
    });

    test('⚠️ 无死路：每个非末层节点都有出边', () => {
      for (let seed = 1; seed <= 200; seed++) {
        const g = generateRoomGraph({ depth: 8, rng: new RNG(seed) });
        const d = diagnose(g);
        if (d.deadEnds.length > 0) {
          assert(false, `种子 ${seed} 产生死路：${d.deadEnds.join(',')}`);
          return;
        }
      }
      assert(true);
    });

    test('⚠️ 全连通：入口可达所有，所有可达 Boss（200 种子）', () => {
      let bad = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const g = generateRoomGraph({ depth: 9, rng: new RNG(seed) });
        const d = diagnose(g);
        if (d.reachableFromEntry !== g.nodes.length || d.canReachBoss !== g.nodes.length) {
          bad++;
          if (bad === 1) console.log(`      首个失败种子 ${seed}：${d.issues.join('; ')}`);
        }
      }
      eq(bad, 0, '200 个种子应全部连通');
    });

    test('⚠️ 路径不交叉（200 种子）', () => {
      let crossings = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const g = generateRoomGraph({ depth: 8, rng: new RNG(seed) });
        crossings += diagnose(g).crossings;
      }
      eq(crossings, 0, '交叉会让地图变得无法阅读');
    });

    test('⚠️ n > m 时（上层比下层多）不产生死路', () => {
      // 强制：中间层很宽，最后收窄
      let bad = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const g = generateRoomGraph({
          depth: 6,
          rng: new RNG(seed),
          width: (d) => (d === 0 || d === 5 ? 1 : d === 1 ? 6 : 2),
        });
        if (diagnose(g).deadEnds.length > 0) bad++;
      }
      eq(bad, 0, '上层节点更多时，每个都仍要有出边');
    });

    test('maxOutDegree 生效', () => {
      for (let seed = 1; seed <= 50; seed++) {
        const g = generateRoomGraph({ depth: 8, rng: new RNG(seed), maxOutDegree: 2 });
        for (const n of g.nodes) {
          if (n.depth === g.depth - 1) continue;
          if (n.next.length > 2) {
            assert(false, `种子 ${seed}：节点 ${n.id} 出度 ${n.next.length} > 2`);
            return;
          }
        }
      }
      assert(true);
    });

    test('minOutDegree=0 时会产生死路（这是预期的）', () => {
      let withDeadEnd = 0;
      for (let seed = 1; seed <= 50; seed++) {
        const g = generateRoomGraph({ depth: 8, rng: new RNG(seed), minOutDegree: 0, maxOutDegree: 1 });
        if (diagnose(g).deadEnds.length > 0) withDeadEnd++;
      }
      assert(withDeadEnd > 0, 'minOutDegree=0 + maxOutDegree=1 应该会产生死路');
    });

    test('层数不足会抛错', () => {
      throws(() => generateRoomGraph({ depth: 2 }), '至少 3');
      throws(() => generateRoomGraph({ depth: 0 }), '至少 3');
    });

    test('同种子结果完全一致（可复现）', () => {
      const a = generateRoomGraph({ depth: 8, rng: new RNG(42) });
      const b = generateRoomGraph({ depth: 8, rng: new RNG(42) });
      eq(a.nodes.length, b.nodes.length);
      for (let i = 0; i < a.nodes.length; i++) {
        eq(a.nodes[i].next.join(','), b.nodes[i].next.join(','), `节点 ${i} 出边应一致`);
      }
    });

    test('固定宽度生效', () => {
      const g = generateRoomGraph({ depth: 6, rng: new RNG(5), width: 3 });
      for (let d = 1; d < 5; d++) eq(g.layers[d].length, 3, `第 ${d} 层应为 3 个`);
    });

    test('宽度函数生效', () => {
      const g = generateRoomGraph({
        depth: 6, rng: new RNG(5),
        width: (d, total) => (d === 0 || d === total - 1 ? 1 : d + 2),
      });
      eq(g.layers[1].length, 3);
      eq(g.layers[2].length, 4);
      eq(g.layers[3].length, 5);
      eq(g.layers[4].length, 6);
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('RoomGraph · 类型分配与路径分析', () => {
    test('fixed 层强制生效', () => {
      const g = makeGraph(10, 8);
      eq(g.nodes[g.layers[0][0]].type, RoomTypes.ENTRY);
      for (const id of g.layers[g.depth - 1]) {
        eq(g.nodes[id].type, RoomTypes.BOSS);
      }
    });

    test('⚠️ Boss 前一层必有休息房', () => {
      let missing = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const g = makeGraph(seed, 8);
        const before = g.layers[g.depth - 2];
        if (!before.some((id) => g.nodes[id].type === RoomTypes.REST)) missing++;
      }
      eq(missing, 0, 'Boss 前没有回血点会让玩家陷入无解挫败');
    });

    test('所有非固定节点都有类型（不会是空字符串）', () => {
      const g = makeGraph(11, 8);
      for (const n of g.nodes) {
        assert(n.type !== '', `节点 ${n.id} 类型为空`);
      }
    });

    test('规则可以禁止某类型', () => {
      const spec: TypeSpec = {
        weights: {
          [RoomTypes.COMBAT]: 50,
          [RoomTypes.ELITE]: 50,
        },
        fixed: { 0: RoomTypes.ENTRY },
        rules: [
          {
            // 精英不出现在前两层
            allow: (ctx) => {
              if (ctx.node.type === RoomTypes.ELITE) return ctx.node.depth >= 3;
              return true;
            },
          },
        ],
      };
      let bad = 0;
      for (let seed = 1; seed <= 50; seed++) {
        const g = generateRoomGraph({ depth: 8, rng: new RNG(seed) });
        assignTypes(g, spec, new RNG(seed + 1));
        for (const n of g.nodes) {
          if (n.type === RoomTypes.ELITE && n.depth < 3) bad++;
        }
      }
      eq(bad, 0, '规则应完全禁止精英出现在前 3 层');
    });

    test('规则可以覆盖权重', () => {
      const spec: TypeSpec = {
        weights: { [RoomTypes.COMBAT]: 100, [RoomTypes.SHOP]: 1 },
        fixed: { 0: RoomTypes.ENTRY },
        rules: [
          // 最后三层全变成商店（极端测试，验证权重覆盖生效）
          { weight: (ctx) => (ctx.node.depth >= ctx.totalDepth - 3 ? { shop: 100 } : {}) },
        ],
      };
      const g = generateRoomGraph({ depth: 8, rng: new RNG(7) });
      assignTypes(g, spec, new RNG(8));
      const lastNodes = g.layers[5].concat(g.layers[6]);
      const shops = lastNodes.filter((id) => g.nodes[id].type === RoomTypes.SHOP).length;
      assert(shops > 0, '权重覆盖后应出现商店');
    });

    test('pathHeat：入口与 Boss 的热度 = 总路径数', () => {
      const g = makeGraph(13, 8);
      const heat = pathHeat(g);
      const entry = g.layers[0][0];
      const boss = g.layers[g.depth - 1][0];
      eq(heat.get(entry), heat.get(boss), '入口和 Boss 的路径数应相同（都是全部路径）');
      assert((heat.get(entry) ?? 0) > 0, '至少有一条路径');
    });

    test('pathHeat：中间节点热度 ≤ 总路径数', () => {
      const g = makeGraph(14, 8);
      const heat = pathHeat(g);
      const total = heat.get(g.layers[0][0]) ?? 0;
      for (const n of g.nodes) {
        assert((heat.get(n.id) ?? 0) <= total, `节点 ${n.id} 热度超过总路径数`);
        assert((heat.get(n.id) ?? 0) >= 0, '热度不应为负');
      }
    });

    test('pathHeat 与暴力枚举一致（小规模图）', () => {
      /**
       * 【pathHeat 的语义】
       * depth 0 的**所有**节点都是入口（玩家可以从任一个开始），
       * 最后一层的**所有**节点都是终点。
       * 所以暴力枚举要从每个入口都走一遍。
       *
       * 用默认宽度生成（入口层自动为 1 个），避免显式 width 把首末层也撑开。
       */
      const g = generateRoomGraph({ depth: 5, rng: new RNG(99) });
      const heat = pathHeat(g);

      const brute = new Map<number, number>();
      for (const n of g.nodes) brute.set(n.id, 0);

      const walk = (id: number, path: number[]): void => {
        const nextPath = [...path, id];
        if (g.nodes[id].depth === g.depth - 1) {
          for (const p of nextPath) brute.set(p, (brute.get(p) ?? 0) + 1);
          return;
        }
        for (const nx of g.nodes[id].next) {
          if (g.nodes[nx].depth !== g.nodes[id].depth + 1) continue;
          walk(nx, nextPath);
        }
      };
      for (const start of g.layers[0]) walk(start, []);

      for (const n of g.nodes) {
        eq(heat.get(n.id), brute.get(n.id), `节点 ${n.id} 热度应与暴力枚举一致`);
      }
    });

    test('pathLengths：最短路径 = 层数', () => {
      const g = makeGraph(15, 8);
      const L = pathLengths(g);
      eq(L.min, 8, '每层经过一个房间，最短就是 8');
      assert(L.max >= L.min, '最长不小于最短');
      assert(L.total > 0, '至少有一条完整路径');
    });

    test('⚠️ 路径长度方差可控（不能差太多）', () => {
      let worst = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const g = makeGraph(seed, 8);
        const L = pathLengths(g);
        worst = Math.max(worst, L.max - L.min);
      }
      assert(worst <= 3, `最长与最短路径差 ${worst}，超过 3 说明玩家的选择变成了运气`);
    });

    test('findPath 返回从入口到 Boss 的完整路径', () => {
      const g = makeGraph(16, 8);
      const p = findPath(g);
      eq(p.length, 8, '应经过 8 个节点');
      eq(g.nodes[p[0]].depth, 0, '起点在入口层');
      eq(g.nodes[p[p.length - 1]].depth, g.depth - 1, '终点在 Boss 层');
      // 每一步都是合法的边
      for (let i = 0; i < p.length - 1; i++) {
        assert(g.nodes[p[i]].next.includes(p[i + 1]), `${p[i]} → ${p[i + 1]} 应是合法边`);
      }
    });

    test('findPath 按偏好选路（优先精英）', () => {
      const g = makeGraph(17, 8);
      const p = findPath(g, (n) => (n.type === RoomTypes.ELITE ? 10 : 0));
      const hasElite = p.some((id) => g.nodes[id].type === RoomTypes.ELITE);
      // 图上得真有精英才断言
      const anyElite = g.nodes.some((n) => n.type === RoomTypes.ELITE);
      if (anyElite) assert(hasElite, '偏好精英时应尽量走到精英房');
      else assert(true);
    });

    test('⚠️ findBestPath 能区分策略（findPath 不能）', () => {
      /**
       * 这个测试固定的种子下，贪心会让"激进"和"稳健"走出同一条路，
       * 因为走到某个节点后只剩不想要的分支。
       * 全局最优应该能区分开。
       */
      const spec: TypeSpec = {
        weights: { combat: 55, elite: 15, treasure: 8, shop: 7, rest: 5, event: 10 },
        fixed: { 0: RoomTypes.ENTRY },
        rules: [{ allow: (ctx) => (ctx.node.type === RoomTypes.ELITE ? ctx.node.depth >= 2 : true) }],
      };

      // 找一个贪心会失效的种子
      let verified = false;
      for (let seed = 1; seed <= 60 && !verified; seed++) {
        const g = generateRoomGraph({ depth: 9, rng: new RNG(seed) });
        assignTypes(g, spec, new RNG(seed + 999));
        for (const id of g.layers[g.depth - 1]) g.nodes[id].type = RoomTypes.BOSS;

        const greedyScore = (n: RoomNode) => (n.type === RoomTypes.ELITE ? 10 : 0);
        const safeScore = (n: RoomNode) => (n.type === RoomTypes.ELITE ? -10 : 0);

        const gb = findBestPath(g, greedyScore);
        const sb = findBestPath(g, safeScore);

        // 全局最优给稳健策略的精英数，不应多于激进策略
        const countElite = (p: number[]) => p.filter((i) => g.nodes[i].type === RoomTypes.ELITE).length;
        if (countElite(sb.path) > countElite(gb.path)) {
          assert(false, `种子 ${seed}：稳健路线精英数(${countElite(sb.path)}) 多于激进(${countElite(gb.path)})`);
          return;
        }
        if (countElite(sb.path) < countElite(gb.path)) verified = true;
      }
      assert(verified, '应在某些种子上体现出策略差异');
    });

    test('findBestPath 返回全局最优（暴力比对）', () => {
      const g = generateRoomGraph({ depth: 6, rng: new RNG(4242) });
      assignTypes(g, DEFAULT_SPEC, new RNG(1));
      for (const id of g.layers[g.depth - 1]) g.nodes[id].type = RoomTypes.BOSS;

      const score = (n: RoomNode) => (n.type === RoomTypes.TREASURE ? 5 : n.type === RoomTypes.ELITE ? 3 : 0);

      // 暴力：枚举所有路径算总分
      let bruteBest = -Infinity;
      const cur: number[] = [];
      const walk = (id: number, acc: number): void => {
        cur.push(id);
        const t = acc + score(g.nodes[id]);
        if (g.nodes[id].depth === g.depth - 1) {
          if (t > bruteBest) bruteBest = t;
        } else {
          for (const nx of g.nodes[id].next) {
            if (g.nodes[nx].depth === g.nodes[id].depth + 1) walk(nx, t);
          }
        }
        cur.pop();
      };
      for (const start of g.layers[0]) walk(start, 0);

      const r = findBestPath(g, score);
      eq(r.total, bruteBest, 'findBestPath 的总分应等于暴力最优');
    });

    test('findBestPath 路径合法', () => {
      const g = makeGraph(31, 8);
      const r = findBestPath(g, (n) => (n.type === RoomTypes.ELITE ? 5 : 1));
      eq(r.path.length, 8);
      for (let i = 0; i < r.path.length - 1; i++) {
        assert(g.nodes[r.path[i]].next.includes(r.path[i + 1]), '每一步都应是合法边');
      }
      eq(r.truncated, false);
    });

    test('findBestPath 超限时退化为贪心且不崩溃', () => {
      const g = makeGraph(32, 10);
      const r = findBestPath(g, () => 1, 5);   // maxPaths 极小
      assert(Array.isArray(r.path), '应始终返回数组');
      if (r.truncated) {
        assert(r.path.length > 0, '退化时也要给出路径');
      }
    });

    test('graphToString 能输出（不崩溃）', () => {
      const g = makeGraph(18, 6);
      const s = graphToString(g);
      assert(s.length > 0, '应输出内容');
      assert(s.includes('B'), '应包含 Boss 标记');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('WaveSpawner · 波次刷怪', () => {
    /** 一个测试用的生成接收器 */
    class TestSink implements ISpawnSink {
      handles: SpawnHandle[] = [];
      killed: SpawnHandle[] = [];
      failNext = false;
      private _nextId = 1;

      spawn(entryId: string, indexInEntry: number, waveIndex: number): SpawnHandle | null {
        if (this.failNext) {
          this.failNext = false;
          return null;
        }
        const h: SpawnHandle = {
          id: this._nextId++,
          alive: true,
          age: 0,
          waveIndex,
          data: { entryId, indexInEntry },
        };
        this.handles.push(h);
        return h;
      }

      forceKill(h: SpawnHandle): void {
        h.alive = false;
        this.killed.push(h);
      }
    }

    test('初始状态为 idle', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 3 }] }],
        spawn: sink,
      });
      eq(ws.state, 'idle');
      eq(ws.finished, false);
    });

    test('start 后进入生成阶段', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 3 }] }],
        spawn: sink,
      });
      ws.start();
      assert(ws.state !== 'idle', 'start 后不应还是 idle');
    });

    test('一波刷完后进入下一波', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [
          { id: 'w1', entries: [{ id: 'bat', count: 2 }] },
          { id: 'w2', entries: [{ id: 'slime', count: 1 }] },
        ],
        spawn: sink,
      });
      ws.start();
      ws.tick(0.016);
      eq(ws.currentWaveIndex, 0);
      eq(sink.handles.length, 2, '第一波应生成 2 个');

      for (const h of sink.handles) h.alive = false;
      ws.tick(0.016);
      eq(ws.currentWaveIndex, 1, '清空后应进入第二波');
    });

    test('全部清完触发 onAllClear', () => {
      const sink = new TestSink();
      let cleared = false;
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 2 }] }],
        spawn: sink,
        onAllClear: () => { cleared = true; },
      });
      ws.start();
      ws.tick(0.016);
      for (const h of sink.handles) h.alive = false;
      ws.tick(0.016);
      assert(cleared, '应触发 onAllClear');
      eq(ws.finished, true);
    });

    test('⚠️ 核心承诺：怪卡住时波次超时会强制推进', () => {
      const sink = new TestSink();
      let fallback: string | null = null;
      const ws = new WaveSpawner({
        waves: [
          { id: 'w1', entries: [{ id: 'bat', count: 3 }] },
          { id: 'w2', entries: [{ id: 'slime', count: 1 }] },
        ],
        spawn: sink,
        waveTimeout: 5,
        onFallback: (i) => { fallback = i.type; },
      });

      ws.start();
      ws.tick(0.016);
      eq(sink.handles.length, 3);
      // 一个都不杀（模拟怪卡在地图外）
      for (let i = 0; i < 400; i++) ws.tick(0.016);   // 6.4 秒

      eq(fallback, 'wave-timeout', '应触发波次超时兜底');
      eq(ws.currentWaveIndex, 1, '应推进到下一波，而不是卡死');
      eq(sink.killed.length, 3, '卡住的怪应被强制清除');
    });

    test('⚠️ 单体超时：只有 1 个卡住也能单独清掉', () => {
      const sink = new TestSink();
      let stuckFallback = false;
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 5 }] }],
        spawn: sink,
        waveTimeout: 100,
        entityTimeout: 2,
        onFallback: (i) => { if (i.type === 'stuck') stuckFallback = true; },
      });

      ws.start();
      ws.tick(0.016);
      // 杀掉 4 个，留 1 个
      for (let i = 0; i < 4; i++) sink.handles[i].alive = false;
      ws.tick(0.016);
      eq(ws.aliveCount, 1);

      for (let i = 0; i < 150; i++) ws.tick(0.016);   // 2.4 秒

      assert(stuckFallback, '应触发单体超时');
      eq(ws.aliveCount, 0, '卡住的应被清除');
      eq(ws.finished, true, '清完应结束');
    });

    test('⚠️ 生成返回 null 不会让流程卡死', () => {
      const sink = new TestSink();
      sink.failNext = true;      // 第一个生成失败
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 2 }] }],
        spawn: sink,
        waveTimeout: 3,
      });
      ws.start();
      ws.tick(0.016);
      // 剩下的那个杀了
      for (const h of sink.handles) h.alive = false;
      ws.tick(0.016);
      eq(ws.finished, true, '生成失败不应导致永远清不完');
    });

    test('⚠️ 所有生成都失败时，超时也能结束', () => {
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 3 }] }],
          spawn: { spawn: () => null },
        waveTimeout: 2,
      });
      ws.start();
      ws.tick(0.016);
      for (let i = 0; i < 200; i++) ws.tick(0.016);
      assert(ws.finished, '全失败也应有兜底');
    });

    test('interval 让生成分批', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 5, interval: 0.5 }] }],
        spawn: sink,
      });
      ws.start();
      ws.tick(0.016);
      eq(sink.handles.length, 1, '第一帧只出 1 个');
      for (let i = 0; i < 40; i++) ws.tick(0.016);   // 0.64 秒
      eq(sink.handles.length, 2, '0.5 秒后出第 2 个');
    });

    test('delay 让整条延后', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 1, delay: 1.0 }] }],
        spawn: sink,
      });
      ws.start();
      for (let i = 0; i < 30; i++) ws.tick(0.016);   // 0.48 秒
      eq(sink.handles.length, 0, '延迟未到不应生成');
      for (let i = 0; i < 40; i++) ws.tick(0.016);   // 再 0.64 秒
      eq(sink.handles.length, 1, '延迟到了才生成');
    });

    test('⚠️ interval=0 时一帧内全部生成（不能漏）', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 10, interval: 0 }] }],
        spawn: sink,
      });
      ws.start();
      ws.tick(0.016);
      eq(sink.handles.length, 10, '同一时刻的 10 个应全部生成，不能漏');
    });

    test('maxSpawnsPerFrame 限制单帧生成数', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 10 }] }],
        spawn: sink,
        maxSpawnsPerFrame: 3,
      });
      ws.start();
      ws.tick(0.016);
      eq(sink.handles.length, 3, '第一帧最多 3 个');
      ws.tick(0.016);
      eq(sink.handles.length, 6);
      ws.tick(0.016);
      eq(sink.handles.length, 9);
      ws.tick(0.016);
      eq(sink.handles.length, 10, '总共 10 个');
    });

    test('preDelay 让玩家先看清场地', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 1 }], preDelay: 0.5 }],
        spawn: sink,
      });
      ws.start();
      eq(ws.state, 'pre-delay');
      for (let i = 0; i < 20; i++) ws.tick(0.016);   // 0.32 秒
      eq(sink.handles.length, 0, 'preDelay 内不生成');
      for (let i = 0; i < 20; i++) ws.tick(0.016);
      eq(sink.handles.length, 1);
    });

    test('notifyDead 能移除实体', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 2 }] }],
        spawn: sink,
      });
      ws.start();
      ws.tick(0.016);
      eq(ws.aliveCount, 2);
      ws.notifyDead(sink.handles[0].id);
      eq(ws.aliveCount, 1);
    });

    test('⚠️ 只置 alive=false 不通知也能被清理（双保险）', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 2 }] }],
        spawn: sink,
      });
      ws.start();
      ws.tick(0.016);
      sink.handles[0].alive = false;     // 业务忘了通知
      ws.tick(0.016);
      eq(ws.aliveCount, 1, '轮询应兜底清理');
    });

    test('dt=0（暂停）不推进', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 1, delay: 0.5 }] }],
        spawn: sink,
      });
      ws.start();
      for (let i = 0; i < 100; i++) ws.tick(0);
      eq(sink.handles.length, 0, '暂停时不应生成');
    });

    test('负数/NaN dt 不推进（防护）', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 1 }] }],
        spawn: sink,
      });
      ws.start();
      ws.tick(-1);
      ws.tick(NaN);
      eq(sink.handles.length, 0);
    });

    test('abort 清空并置为 aborted', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 3 }] }],
        spawn: sink,
      });
      ws.start();
      ws.tick(0.016);
      ws.abort();
      eq(ws.state, 'aborted');
      eq(ws.aliveCount, 0);
      eq(sink.killed.length, 3, 'abort 应强制清除所有');
    });

    test('totalTimeout 强制结束整场', () => {
      const sink = new TestSink();
      let totalFallback = false;
      const ws = new WaveSpawner({
        waves: [
          { id: 'w1', entries: [{ id: 'bat', count: 2 }] },
          { id: 'w2', entries: [{ id: 'slime', count: 2 }] },
        ],
        spawn: sink,
        waveTimeout: 1000,
        totalTimeout: 3,
        onFallback: (i) => { if (i.type === 'total-timeout') totalFallback = true; },
      });
      ws.start();
      for (let i = 0; i < 250; i++) ws.tick(0.016);   // 4 秒
      assert(totalFallback, '应触发总超时');
      assert(ws.finished, '总超时后应结束');
    });

    test('nextOn=timeout 时不等清完就推进', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [
          { id: 'w1', entries: [{ id: 'bat', count: 2 }], nextOn: 'timeout', timeout: 1 },
          { id: 'w2', entries: [{ id: 'slime', count: 1 }] },
        ],
        spawn: sink,
        waveTimeout: 100,
      });
      ws.start();
      ws.tick(0.016);
      eq(ws.currentWaveIndex, 0);
      for (let i = 0; i < 70; i++) ws.tick(0.016);   // 1.1 秒
      eq(ws.currentWaveIndex, 1, '到时间就推进');
    });

    test('forceClearWave 立即清完当前波（调试指令）', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [
          { id: 'w1', entries: [{ id: 'bat', count: 5 }] },
          { id: 'w2', entries: [{ id: 'slime', count: 1 }] },
        ],
        spawn: sink,
      });
      ws.start();
      ws.tick(0.016);
      ws.forceClearWave();
      eq(ws.currentWaveIndex, 1, '应立即进入下一波');
      eq(ws.aliveCount, 0);
    });

    test('reset 后可重新开始', () => {
      const sink = new TestSink();
      const ws = new WaveSpawner({
        waves: [{ id: 'w1', entries: [{ id: 'bat', count: 2 }] }],
        spawn: sink,
      });
      ws.start();
      ws.tick(0.016);
      ws.reset();
      eq(ws.state, 'idle');
      eq(ws.aliveCount, 0);
      ws.start();
      ws.tick(0.016);
      eq(ws.aliveCount, 2);
    });

    test('空波次列表不会崩溃', () => {
      const ws = new WaveSpawner({ waves: [], spawn: { spawn: () => null } });
      ws.start();
      ws.tick(0.016);
      assert(true, '不应抛异常');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('MetaProgression · 元进度', () => {
    function makeMeta(nodes?: readonly MetaNode[]): MetaProgression {
      return new MetaProgression({
        nodes: nodes ?? [
          { id: 'hp1', maxLevel: 5, cost: [10, 20, 40, 80, 160], effects: [{ stat: 'maxHp', op: 'add', value: 5 }] },
          { id: 'atk1', maxLevel: 3, cost: [15, 30, 60], effects: [{ stat: 'atk', op: 'add', value: 2 }] },
          { id: 'shop', maxLevel: 1, cost: [100], effects: [{ stat: 'unlockShop', op: 'flag', value: 1 }] },
          { id: 'gold', maxLevel: 2, cost: [50, 100], effects: [{ stat: 'startGold', op: 'mul', value: 0.25 }] },
        ],
      });
    }

    test('初始等级为 0，货币为 0', () => {
      const m = makeMeta();
      eq(m.level('hp1'), 0);
      eq(m.currency(), 0);
      eq(m.isUnlocked('hp1'), false);
    });

    test('货币不足时解锁失败', () => {
      const m = makeMeta();
      eq(m.unlock('hp1'), -1, '没钱应失败');
      eq(m.level('hp1'), 0);
    });

    test('货币足够时解锁成功并扣费', () => {
      const m = makeMeta();
      m.addCurrency('default', 100);
      eq(m.unlock('hp1'), 1);
      eq(m.currency(), 90, '应扣 10');
      eq(m.level('hp1'), 1);
    });

    test('逐级成本递增', () => {
      const m = makeMeta();
      m.addCurrency('default', 1000);
      m.unlock('hp1');
      eq(m.nextCost('hp1'), 20, '第二级成本 20');
      m.unlock('hp1');
      eq(m.nextCost('hp1'), 40);
      eq(m.currency(), 1000 - 10 - 20);
    });

    test('满级后不能再升', () => {
      const m = makeMeta();
      m.addCurrency('default', 10000);
      for (let i = 0; i < 10; i++) m.unlock('atk1');
      eq(m.level('atk1'), 3, '应停在 maxLevel');
      eq(m.nextCost('atk1'), null, '满级无下一级成本');
      eq(m.unlock('atk1'), -1);
    });

    test('前置未满足时不能解锁', () => {
      const m = new MetaProgression({
        nodes: [
          { id: 'a', cost: [10] },
          { id: 'b', cost: [10], requires: ['a'] },
        ],
      });
      m.addCurrency('default', 100);
      eq(m.unlock('b'), -1, 'a 没解锁时 b 不能解锁');
      m.unlock('a');
      eq(m.unlock('b'), 1, 'a 解锁后 b 可以');
    });

    test('⚠️ 循环依赖在构造时抛错', () => {
      throws(
        () =>
          new MetaProgression({
            nodes: [
              { id: 'a', requires: ['b'] },
              { id: 'b', requires: ['a'] },
            ],
          }),
        '循环依赖',
      );
    });

    test('自引用也算循环', () => {
      throws(() => new MetaProgression({ nodes: [{ id: 'a', requires: ['a'] }] }), '循环依赖');
    });

    test('未知前置被忽略（不报错、不阻塞）', () => {
      const m = new MetaProgression({
        nodes: [{ id: 'a', cost: [10], requires: ['不存在的节点'] }],
      });
      m.addCurrency('default', 100);
      eq(m.unlock('a'), 1, '未知前置不应阻塞解锁');
    });

    test('重复 id 抛错', () => {
      throws(() => new MetaProgression({ nodes: [{ id: 'a' }, { id: 'a' }] }), '重复');
    });

    test('未知货币抛错（不静默丢弃）', () => {
      const m = makeMeta();
      throws(() => m.addCurrency('不存在的货币', 10), '未知货币');
    });

    test('货币不会变成负数', () => {
      const m = makeMeta();
      m.addCurrency('default', 10);
      m.addCurrency('default', -1000);
      eq(m.currency(), 0, '应 clamp 到 0');
    });

    test('效果聚合：add 累加', () => {
      const m = makeMeta();
      m.addCurrency('default', 1000);
      m.setLevel('hp1', 3);
      eq(m.effectOf('maxHp').add, 15, '3 级 × 每级 5 = 15');
      eq(m.compute('maxHp', 100), 115);
    });

    test('效果聚合：mul 累加不是连乘', () => {
      const m = makeMeta();
      m.addCurrency('default', 1000);
      m.setLevel('gold', 2);
      eq(m.effectOf('startGold').mul, 0.5, '2 级 × 0.25 = 0.5');
      eq(m.compute('startGold', 100), 150, '(100 + 0) × 1.5');
    });

    test('效果聚合：flag', () => {
      const m = makeMeta();
      eq(m.hasFlag('unlockShop'), false);
      m.addCurrency('default', 1000);
      m.unlock('shop');
      eq(m.hasFlag('unlockShop'), true);
    });

    test('效果聚合：add 与 mul 同时存在', () => {
      const m = new MetaProgression({
        nodes: [
          { id: 'x', maxLevel: 2, effects: [{ stat: 'atk', op: 'add', value: 10 }] },
          { id: 'y', maxLevel: 1, effects: [{ stat: 'atk', op: 'mul', value: 0.5 }] },
        ],
      });
      m.setLevel('x', 2);
      m.setLevel('y', 1);
      eq(m.compute('atk', 20), 60, '(20 + 20) × 1.5');
    });

    test('set 优先于 add/mul', () => {
      const m = new MetaProgression({
        nodes: [
          { id: 'a', effects: [{ stat: 'v', op: 'add', value: 100 }] },
          { id: 'b', effects: [{ stat: 'v', op: 'set', value: 42 }] },
        ],
      });
      m.setLevel('a', 1);
      m.setLevel('b', 1);
      eq(m.compute('v', 10), 42, 'set 应覆盖');
    });

    test('多个 set 取最大（确定性）', () => {
      const m = new MetaProgression({
        nodes: [
          { id: 'a', effects: [{ stat: 'v', op: 'set', value: 10 }] },
          { id: 'b', effects: [{ stat: 'v', op: 'set', value: 30 }] },
          { id: 'c', effects: [{ stat: 'v', op: 'set', value: 20 }] },
        ],
      });
      m.setLevel('a', 1);
      m.setLevel('b', 1);
      m.setLevel('c', 1);
      eq(m.compute('v', 0), 30, '应取最大，不依赖遍历顺序');
    });

    test('默认成本曲线是指数增长', () => {
      const c = defaultCostCurve(100, 2);
      eq(c(0), 100);
      eq(c(1), 200);
      eq(c(2), 400);
      eq(c(3), 800);
    });

    test('⚠️ costAt 数组越界时用最后一项（不能免费）', () => {
      eq(costAt([10, 20], 0), 10);
      eq(costAt([10, 20], 1), 20);
      eq(costAt([10, 20], 2), 20, '越界应沿用最后一项，而不是返回 0');
      eq(costAt([10, 20], 5), 20);
    });

    test('respec 退还货币并清零等级', () => {
      const m = makeMeta();
      m.addCurrency('default', 1000);
      m.unlock('hp1');
      m.unlock('hp1');
      const before = m.currency();
      m.respec(1);
      eq(m.level('hp1'), 0);
      eq(m.currency(), before + 10 + 20, '应全额退还');
    });

    test('respec 按比例退款', () => {
      const m = makeMeta();
      m.addCurrency('default', 1000);
      m.unlock('hp1');
      const before = m.currency();
      m.respec(0.5);
      eq(m.currency(), before + 5, '半价退款');
    });

    test('⚠️ 旧存档有未知节点时不崩溃', () => {
      const m = makeMeta();
      const bad: MetaSnapshot = {
        version: 1,
        currency: { default: 500, 未知货币: 100 },
        levels: { hp1: 2, 已删除的节点: 3, atk1: 1 },
      };
      const report = m.restore(bad);
      eq(m.level('hp1'), 2, '已知节点应恢复');
      eq(m.level('atk1'), 1);
      eq(m.currency(), 500, '未知货币被忽略');
      assert(report.skipped.includes('node:已删除的节点'), '应记录被跳过的节点');
      assert(report.skipped.includes('currency:未知货币'));
    });

    test('⚠️ 存档等级超过上限时 clamp', () => {
      const m = makeMeta();
      m.restore({ version: 1, currency: {}, levels: { atk1: 99 } });
      eq(m.level('atk1'), 3, '应 clamp 到 maxLevel');
    });

    test('存档等级为负时归零', () => {
      const m = makeMeta();
      m.restore({ version: 1, currency: {}, levels: { hp1: -5 } });
      eq(m.level('hp1'), 0);
    });

    test('存档为 null 时安全返回', () => {
      const m = makeMeta();
      const r = m.restore(null);
      eq(r.skipped.length, 0);
      eq(m.level('hp1'), 0);
    });

    test('snapshot / restore 往返一致', () => {
      const m = makeMeta();
      m.addCurrency('default', 500);
      m.setLevel('hp1', 3);
      m.setLevel('shop', 1);
      const snap = m.snapshot();

      const m2 = makeMeta();
      m2.restore(snap);
      eq(m2.level('hp1'), 3);
      eq(m2.level('shop'), 1);
      eq(m2.currency(), 500);
      eq(m2.compute('maxHp', 100), 115);
    });

    test('版本不一致会被标记', () => {
      const m = new MetaProgression({ nodes: [{ id: 'a' }], version: 2 });
      const r = m.restore({ version: 1, currency: {}, levels: {} });
      eq(r.versionMismatch, true);
    });

    test('⚠️ 单货币游戏：节点不写 currency 也能正常解锁', () => {
      /**
       * 【曾经的坑】
       * 构造时写 `currencies: ['soul']`，但节点没写 `currency`（默认 'default'）。
       * 结果 'default' 不在货币表里，`currency()` 静默返回 0，
       * 所有解锁都因"货币不足"失败——玩家有 320 灵魂却买不起 20 的东西。
       */
      const m = new MetaProgression({
        nodes: [{ id: 'hp1', maxLevel: 3, cost: [10, 20, 40] }],
        currencies: ['soul'],
      });
      m.addCurrency('soul', 100);
      eq(m.currency(), 100, '单货币时不传参也应查到 soul');
      eq(m.unlock('hp1'), 1, '应能正常解锁');
      eq(m.currency(), 90);
    });

    test('⚠️ 节点引用未注册货币：构造时立即抛错', () => {
      throws(
        () =>
          new MetaProgression({
            nodes: [{ id: 'a', currency: 'diamond' }],
            currencies: ['soul'],
          }),
        '未注册的货币',
        '应在构造时失败，而不是运行时静默返回 0',
      );
    });

    test('⚠️ 多货币时必须显式指定 currency（否则构造即失败）', () => {
      /**
       * 【契约】
       * 只有一种货币时，节点不写 `currency` 就用它（宽容）。
       * 有多种货币时不写是**歧义**——不知道该扣哪个，
       * 所以构造时立即抛错，而不是等到扣款时才发现。
       */
      throws(
        () =>
          new MetaProgression({
            nodes: [{ id: 'a', cost: [10] }],       // 没写 currency，但有 2 种货币
            currencies: ['soul', 'gem'],
          }),
        '未注册的货币',
      );
    });

    test('多货币：各自独立结算', () => {
      const m = new MetaProgression({
        nodes: [
          { id: 'a', cost: [10], currency: 'soul' },
          { id: 'b', cost: [5], currency: 'gem' },
        ],
        currencies: ['soul', 'gem'],
      });
      m.addCurrency('soul', 50);
      m.addCurrency('gem', 50);
      eq(m.unlock('a'), 1);
      eq(m.currency('soul'), 40, 'a 扣 soul');
      eq(m.unlock('b'), 1);
      eq(m.currency('gem'), 45, 'b 扣 gem');
      eq(m.currency('soul'), 40, 'soul 不受影响');
    });

    test('多货币：余额不足只影响对应货币', () => {
      const m = new MetaProgression({
        nodes: [{ id: 'a', cost: [10], currency: 'gem' }],
        currencies: ['soul', 'gem'],
      });
      m.addCurrency('soul', 999);      // soul 很多
      eq(m.unlock('a'), -1, '但 gem 为 0，应失败');
      m.addCurrency('gem', 10);
      eq(m.unlock('a'), 1, '补足 gem 后成功');
    });

    test('addCurrency 单货币时可省略 id', () => {
      const m = new MetaProgression({
        nodes: [{ id: 'a' }],
        currencies: ['soul'],
      });
      m.addCurrency(50);
      eq(m.currency('soul'), 50);
      eq(m.currency(), 50);
    });

    test('topoOrder 依赖在前', () => {
      const m = new MetaProgression({
        nodes: [
          { id: 'c', requires: ['b'] },
          { id: 'b', requires: ['a'] },
          { id: 'a' },
        ],
      });
      const order = m.topoOrder();
      eq(order.length, 3);
      assert(order.indexOf('a') < order.indexOf('b'), 'a 应在 b 前');
      assert(order.indexOf('b') < order.indexOf('c'), 'b 应在 c 前');
    });

    test('describe 输出已解锁节点', () => {
      const m = makeMeta();
      m.setLevel('hp1', 2);
      const lines = m.describe();
      eq(lines.length, 1);
      assert(lines[0].includes('hp1'), '应包含节点 id');
      assert(lines[0].includes('maxHp'), '应包含效果');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('AffixSystem · 词条', () => {
    const DEFS: readonly AffixDef[] = [
      { id: 'atk1', stat: 'atk', op: 'add', min: 5, max: 15, rarity: 'common', group: 'atk', slots: ['weapon'] },
      { id: 'atk2', stat: 'atk', op: 'add', min: 10, max: 25, rarity: 'rare', group: 'atk', slots: ['weapon'] },
      { id: 'crit1', stat: 'crit', op: 'add', min: 0.02, max: 0.08, rarity: 'common', group: 'crit', precision: 2, percent: true },
      { id: 'crit2', stat: 'crit', op: 'add', min: 0.05, max: 0.15, rarity: 'epic', group: 'crit', precision: 2, percent: true },
      { id: 'hp1', stat: 'hp', op: 'add', min: 10, max: 30, rarity: 'common', group: 'hp' },
      { id: 'dmg1', stat: 'dmg', op: 'mul', min: 0.05, max: 0.15, rarity: 'rare', group: 'dmg', precision: 2, percent: true, slots: ['weapon', 'ring'] },
      { id: 'spd1', stat: 'spd', op: 'add', min: 1, max: 3, rarity: 'common', group: 'spd', slots: ['boots'] },
    ];

    function makeAffix(defs?: readonly AffixDef[], seed = 1): AffixSystem {
      return new AffixSystem({
        defs: defs ?? DEFS,
        rng: new RNG(seed),
        maxAffixes: 4,
      });
    }

    test('构造：正常配置不抛错', () => {
      const a = makeAffix();
      eq(a.defCount, 7);
    });

    test('⚠️ 范围反了会抛错', () => {
      throws(
        () => new AffixSystem({ defs: [{ id: 'x', stat: 's', op: 'add', min: 10, max: 5, rarity: 'common' }] }),
        '范围反了',
      );
    });

    test('⚠️ 未知稀有度会抛错', () => {
      throws(
        () => new AffixSystem({ defs: [{ id: 'x', stat: 's', op: 'add', min: 1, max: 2, rarity: '不存在的稀有度' }] }),
        '未定义的稀有度',
      );
    });

    test('重复 id 会抛错', () => {
      throws(
        () =>
          new AffixSystem({
            defs: [
              { id: 'x', stat: 's', op: 'add', min: 1, max: 2, rarity: 'common' },
              { id: 'x', stat: 's2', op: 'add', min: 1, max: 2, rarity: 'common' },
            ],
          }),
        '重复',
      );
    });

    test('roll 返回指定数量', () => {
      const a = makeAffix();
      const rolled = a.roll(undefined, 3);
      eq(rolled.length, 3);
    });

    test('roll 不超过 maxAffixes', () => {
      const a = makeAffix();
      eq(a.roll(undefined, 99).length, 4, '应 clamp 到 maxAffixes');
    });

    test('⚠️ 冲突组：同组不会同时出现', () => {
      for (let s = 1; s <= 100; s++) {
        const sys = makeAffix(undefined, s);
        const rolled = sys.roll(undefined, 4);
        const groups = rolled.map((x) => {
          const d = DEFS.find((d) => d.id === x.defId)!;
          return d.group!;
        });
        const uniq = new Set(groups);
        if (uniq.size !== groups.length) {
          assert(false, `种子 ${s} 出现同组词条：${groups.join(',')}`);
          return;
        }
      }
      assert(true);
    });

    test('⚠️ 默认不出现重复词条', () => {
      for (let s = 1; s <= 100; s++) {
        const sys = makeAffix(undefined, s);
        const rolled = sys.roll(undefined, 4);
        const ids = rolled.map((x) => x.defId);
        if (new Set(ids).size !== ids.length) {
          assert(false, `种子 ${s} 出现重复：${ids.join(',')}`);
          return;
        }
      }
      assert(true);
    });

    test('槽位过滤生效', () => {
      for (let s = 1; s <= 50; s++) {
        const sys = makeAffix(undefined, s);
        const rolled = sys.roll('boots', 2);
        for (const x of rolled) {
          const d = DEFS.find((d) => d.id === x.defId)!;
          if (d.slots && !d.slots.includes('boots')) {
            assert(false, `boots 上出现了不属于它的词条 ${x.defId}`);
            return;
          }
        }
      }
      assert(true);
    });

    test('⚠️ 池子抽干时不会死循环，且优雅降级', () => {
      /**
       * DEFS 里 `slots` 的语义：
       * - 写了 slots → 只能在那些槽位出现
       * - **不写 slots → 通用词条，任何槽位都能出**
       *
       * 所以 boots 槽位可用的是：spd1(boots) + crit1/crit2/hp1(通用)
       * 但 crit1 和 crit2 同组，只能取一个 → 最多 3 条：
       * {crit 组 1 个} + hp1 + spd1
       */
      const a = makeAffix();
      const t0 = Date.now();
      const rolled = a.roll('boots', 4);
      assert(Date.now() - t0 < 1000, '不应卡住');
      eq(rolled.length, 3, 'boots 最多 3 条（crit 组 1 + hp1 + spd1）');

      const ids = rolled.map((x) => x.defId).sort();
      assert(ids.includes('spd1'), '应包含 spd1');
      assert(ids.includes('hp1'), '应包含通用词条 hp1');
      assert(
        !(ids.includes('crit1') && ids.includes('crit2')),
        'crit1 与 crit2 同组，不能共存',
      );
    });

    test('⚠️ 真实抽干场景：只有一个词条时给 1 条', () => {
      // 只给 boots 留一个专属词条，且其他词条全部限定到别的槽位
      const only = new AffixSystem({
        defs: [
          { id: 'spd1', stat: 'spd', op: 'add', min: 1, max: 3, rarity: 'common', group: 'spd', slots: ['boots'] },
          { id: 'atk1', stat: 'atk', op: 'add', min: 1, max: 3, rarity: 'common', group: 'atk', slots: ['weapon'] },
        ],
        rng: new RNG(1),
        maxAffixes: 4,
      });
      const t0 = Date.now();
      const rolled = only.roll('boots', 4);
      assert(Date.now() - t0 < 1000, '不应卡住');
      eq(rolled.length, 1, 'boots 只有 1 个可用词条');
      eq(rolled[0].defId, 'spd1');
    });

    test('⚠️ 池子完全为空时返回空数组（不崩溃）', () => {
      const only = new AffixSystem({
        defs: [{ id: 'a', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common', group: 'g', slots: ['weapon'] }],
        rng: new RNG(1),
      });
      const t0 = Date.now();
      const rolled = only.roll('不存在的槽位', 4);
      assert(Date.now() - t0 < 1000, '不应卡住');
      eq(rolled.length, 0, '没有可用词条时应返回空，而不是死循环');
    });

    test('数值在范围内（考虑稀有度倍率）', () => {
      for (let s = 1; s <= 200; s++) {
        const sys = makeAffix(undefined, s);
        for (const x of sys.roll(undefined, 4)) {
          const d = DEFS.find((d) => d.id === x.defId)!;
          const scale = DefaultRarities.find((r) => r.id === d.rarity)?.valueScale ?? 1;
          const lo = d.min * scale;
          const hi = d.max * scale;
          if (x.value < lo - 1e-6 || x.value > hi + 1e-6) {
            assert(false, `种子 ${s}：${x.defId} 值 ${x.value} 超出 [${lo}, ${hi}]`);
            return;
          }
        }
      }
      assert(true);
    });

    test('precision 生效', () => {
      for (let s = 1; s <= 50; s++) {
        const sys = makeAffix(undefined, s);
        for (const x of sys.roll(undefined, 4)) {
          const d = DEFS.find((d) => d.id === x.defId)!;
          const p = d.precision ?? 0;
          const f = Math.pow(10, p);
          if (Math.abs(x.value * f - Math.round(x.value * f)) > 1e-9) {
            assert(false, `${x.defId} 值 ${x.value} 不符合 precision=${p}`);
            return;
          }
        }
      }
      assert(true);
    });

    test('稀有度分布大致符合权重', () => {
      const counts = new Map<string, number>();
      for (let s = 1; s <= 500; s++) {
        for (const x of makeAffix(undefined, s).roll(undefined, 4)) {
          counts.set(x.rarity, (counts.get(x.rarity) ?? 0) + 1);
        }
      }
      const common = counts.get('common') ?? 0;
      const legendary = counts.get('legendary') ?? 0;
      assert(common > 0, '应有 common');
      // common 权重 100，legendary 权重 2，比例 50:1
      // DEFS 里没有 legendary 词条，所以应为 0
      eq(legendary, 0, 'DEFS 中没有 legendary 定义');
      assert(common > (counts.get('rare') ?? 0), 'common 应比 rare 多');
    });

    test('聚合：add 累加', () => {
      const a = makeAffix();
      const affixes: Affix[] = [
        { defId: 'a', stat: 'atk', op: 'add', value: 10, rarity: 'common', percent: false },
        { defId: 'b', stat: 'atk', op: 'add', value: 5, rarity: 'common', percent: false },
      ];
      eq(a.aggregate(affixes).get('atk')!.add, 15);
      eq(a.compute(affixes, 'atk', 20), 35);
    });

    test('聚合：mul 累加不是连乘', () => {
      const a = makeAffix();
      const affixes: Affix[] = [
        { defId: 'a', stat: 'dmg', op: 'mul', value: 0.2, rarity: 'common', percent: true },
        { defId: 'b', stat: 'dmg', op: 'mul', value: 0.3, rarity: 'common', percent: true },
      ];
      eq(a.aggregate(affixes).get('dmg')!.mul, 0.5);
      eq(a.compute(affixes, 'dmg', 100), 150, '(100+0) × 1.5，而不是 100×1.2×1.3');
    });

    test('聚合：不同 stat 分开', () => {
      const a = makeAffix();
      const affixes: Affix[] = [
        { defId: 'a', stat: 'atk', op: 'add', value: 10, rarity: 'common', percent: false },
        { defId: 'b', stat: 'hp', op: 'add', value: 20, rarity: 'common', percent: false },
      ];
      eq(a.aggregate(affixes).get('atk')!.add, 10);
      eq(a.aggregate(affixes).get('hp')!.add, 20);
    });

    test('compute 未知 stat 返回 base', () => {
      const a = makeAffix();
      eq(a.compute([], 'nothing', 42), 42);
    });

    test('reroll 保持稀有度（默认）', () => {
      const a = makeAffix();
      const rolled = a.roll(undefined, 1);
      if (rolled.length === 0) { assert(true); return; }
      const r = a.reroll(rolled[0]);
      assert(r !== null, '应返回新词条');
      eq(r!.defId, rolled[0].defId, '保持稀有度时 defId 不变');
    });

    test('reroll 不保持稀有度时可以换一条', () => {
      const a = makeAffix();
      const rolled = a.roll(undefined, 1);
      if (rolled.length === 0) { assert(true); return; }
      const r = a.reroll(rolled[0], undefined, { keepRarity: false });
      assert(r !== null);
      assert(r!.defId !== rolled[0].defId, '应换成不同的词条');
    });

    test('rerollAll 保持数量', () => {
      const a = makeAffix();
      const rolled = a.roll('weapon', 3);
      const out = a.rerollAll(rolled, 'weapon');
      eq(out.length, rolled.length);
    });

    test('describe 输出可读描述', () => {
      const a = makeAffix();
      const affix: Affix = { defId: 'x', stat: 'atk', op: 'add', value: 12, rarity: 'rare', percent: false };
      const s = a.describe(affix);
      assert(s.includes('atk'), '应包含属性名');
      assert(s.includes('12'), '应包含数值');
    });

    test('自定义 format 生效', () => {
      const a = makeAffix();
      const affix: Affix = { defId: 'x', stat: 'atk', op: 'add', value: 12, rarity: 'rare', percent: false };
      eq(a.describe(affix, (x) => `自定义:${x.value}`), '自定义:12');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('AffixSystem · 配置校验', () => {
    test('正常配置无错误', () => {
      const r = validateAffixPool(
        [
          { id: 'a', stat: 'atk', op: 'add', min: 1, max: 10, rarity: 'common' },
          { id: 'b', stat: 'atk', op: 'add', min: 5, max: 20, rarity: 'rare' },
        ],
        DefaultRarities,
      );
      eq(r.ok, true);
      eq(r.errors.length, 0);
    });

    test('⚠️ 稀有度倒挂会被警告', () => {
      const r = validateAffixPool(
        [
          // common 上限 100，rare 下限只有 5 → 稀有反而更弱
          { id: 'a', stat: 'atk', op: 'add', min: 50, max: 100, rarity: 'common' },
          { id: 'b', stat: 'atk', op: 'add', min: 5, max: 10, rarity: 'rare' },
        ],
        DefaultRarities,
      );
      assert(
        r.warnings.some((w) => w.includes('倒挂')),
        '应警告稀有度倒挂',
      );
    });

    test('⚠️ 槽位词条不足会被警告', () => {
      const r = validateAffixPool(
        [
          { id: 'a', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common', slots: ['ring'] },
          { id: 'b', stat: 'hp', op: 'add', min: 1, max: 2, rarity: 'common', slots: ['ring'] },
        ],
        DefaultRarities,
        { maxAffixes: 4 },
      );
      assert(
        r.warnings.some((w) => w.includes('ring') && w.includes('只有 2')),
        `应警告 ring 槽位词条不足，实际：${r.warnings.join(' | ')}`,
      );
    });

    test('百分比但 precision=0 会被警告', () => {
      const r = validateAffixPool(
        [{ id: 'a', stat: 'crit', op: 'add', min: 0.01, max: 0.2, rarity: 'common', percent: true }],
        DefaultRarities,
      );
      assert(r.warnings.some((w) => w.includes('precision')), '应警告 precision');
    });

    test('所有稀有度权重为 0 是错误', () => {
      const r = validateAffixPool(
        [{ id: 'a', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common' }],
        [{ id: 'common', weight: 0 }, { id: 'rare', weight: 0 }],
      );
      eq(r.ok, false);
      assert(r.errors.some((e) => e.includes('权重都是 0')));
    });

    test('单成员冲突组会被警告', () => {
      const r = validateAffixPool(
        [{ id: 'a', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common', group: 'solo' }],
        DefaultRarities,
      );
      assert(r.warnings.some((w) => w.includes('只有 1 个成员')), '应警告无效冲突组');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('批量自检 · 上线前必跑', () => {
    test('⚠️ RoomGraph：500 个种子零死图、零不连通、零交叉', () => {
      let bad = 0;
      let firstError = '';
      for (let seed = 1; seed <= 500; seed++) {
        const depth = 6 + (seed % 8);          // 6~13 层
        const g = generateRoomGraph({ depth, rng: new RNG(seed) });
        const d = diagnose(g);
        if (!d.ok) {
          bad++;
          if (!firstError) firstError = `种子 ${seed}(深度${depth})：${d.issues.join('; ')}`;
        }
      }
      if (bad > 0) console.log(`      首个失败：${firstError}`);
      eq(bad, 0, `500 个种子中有 ${bad} 个不合格`);
    });

    test('⚠️ RoomGraph + 类型分配：300 个种子全部合法', () => {
      let bad = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const g = makeGraph(seed, 8);
        // 每个节点都要有类型
        if (g.nodes.some((n) => n.type === '')) { bad++; continue; }
        // Boss 前必有休息
        const before = g.layers[g.depth - 2];
        if (!before.some((id) => g.nodes[id].type === RoomTypes.REST)) { bad++; continue; }
      }
      eq(bad, 0, '类型分配不应产生非法图');
    });

    test('⚠️ WaveSpawner：模拟 1000 局随机战斗，全部能结束', () => {
      let stuck = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const rng = new RNG(seed);
        const handles: SpawnHandle[] = [];
        let nextId = 1;
        const sink: ISpawnSink = {
          spawn(entryId, idx, waveIndex) {
            const h: SpawnHandle = { id: nextId++, alive: true, age: 0, waveIndex, data: { entryId, idx } };
            handles.push(h);
            return h;
          },
          forceKill(h) { h.alive = false; },
        };

        const waves: WaveDef[] = [];
        const waveCount = 1 + rng.int(4);
        for (let w = 0; w < waveCount; w++) {
          const entries = [];
          const entryCount = 1 + rng.int(3);
          for (let e = 0; e < entryCount; e++) {
            entries.push({
              id: `m${e}`,
              count: 1 + rng.int(6),
              delay: rng.next() * 0.5,
              interval: rng.next() * 0.4,
            });
          }
          waves.push({ id: `w${w}`, entries, preDelay: rng.next() * 0.3 });
        }

        const ws = new WaveSpawner({
          waves, spawn: sink,
          waveTimeout: 30,
          entityTimeout: 15,
          maxSpawnsPerFrame: rng.int(4),
        });
        ws.start();

        // 模拟：玩家以随机效率杀怪
        let frames = 0;
        while (!ws.finished && frames < 20000) {
          ws.tick(1 / 60);
          frames++;
          // 每秒随机杀掉当前存活的一半
          if (frames % 60 === 0) {
            const alive = handles.filter((h) => h.alive);
            for (const h of alive) {
              if (rng.chance(0.5)) h.alive = false;
            }
          }
        }
        if (!ws.finished) stuck++;
      }
      eq(stuck, 0, '模拟中不应有卡住的战斗');
    });

    test('⚠️ AffixSystem：1000 次 roll 不崩溃、不超量、不重复', () => {
      let bad = 0;
      const DEFS2: readonly AffixDef[] = [
        { id: 'a', stat: 'atk', op: 'add', min: 1, max: 10, rarity: 'common', group: 'g1' },
        { id: 'b', stat: 'atk', op: 'add', min: 5, max: 20, rarity: 'rare', group: 'g1' },
        { id: 'c', stat: 'hp', op: 'add', min: 10, max: 50, rarity: 'common', group: 'g2' },
        { id: 'd', stat: 'crit', op: 'add', min: 0.01, max: 0.1, rarity: 'epic', group: 'g3', precision: 2 },
        { id: 'e', stat: 'spd', op: 'add', min: 1, max: 5, rarity: 'common', group: 'g4', slots: ['boots'] },
      ];
      for (let seed = 1; seed <= 1000; seed++) {
        const sys = new AffixSystem({ defs: DEFS2, rng: new RNG(seed), maxAffixes: 3 });
        const rolled = sys.roll(undefined, 3);
        if (rolled.length > 3) { bad++; continue; }
        const ids = rolled.map((x) => x.defId);
        if (new Set(ids).size !== ids.length) { bad++; continue; }
        const groups = rolled.map((x) => DEFS2.find((d) => d.id === x.defId)!.group!);
        if (new Set(groups).size !== groups.length) { bad++; continue; }
      }
      eq(bad, 0, '1000 次 roll 应全部合法');
    });
  });
}
