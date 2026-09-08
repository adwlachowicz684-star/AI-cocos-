/**
 * tests/run_phase10_w2b.ts —— 精审返工 · 窗口 W2-B
 *
 * 【本文件覆盖的 9 个单元】
 *   config / curse / hitbox / leaderboard / minimap / save / scheduler / subtitle / telegraph
 *
 * 【条目来源】`audit/handoff_W2-B.md` 第 3 节：P1 × 11、P2 × 8（含子项 22 个）
 *
 * 【每条两条用例的约定】
 *   ① 回归用例：修复**前**确实会失败的那条（名字带 ⚠️）
 *   ② 对照用例：证明"正常输入没被改坏"（名字带"防止矫枉过正"）
 *
 * 【为什么对照用例在这一批尤其不能省】
 * 这一批的修复大量是"收口"（加下界、加校验、加清理），
 * 而收口最典型的失败模式不是没修好，是**收过头**：
 *   - 数字 id 查重改完，正常表开始误报
 *   - ranked 区间化改完，名次算错
 *   - reveal 改成圆形判定后，正方形地图的覆盖率变了
 * 这些只有对照用例能兜住。
 */

import { describe, describeAsync, test, testAsync, assert, eq, near, throws } from './_framework';

import { Validator } from '../config/Validator';
import { ConfigLoader, MemoryTableSource } from '../config/ConfigLoader';
import { CurseSystem } from '../curse/Curse';
import { HitboxWorld } from '../hitbox/Hitbox';
import { Leaderboard, mergeLeaderboards } from '../leaderboard/Leaderboard';
import { Minimap, FogMap } from '../minimap/Minimap';
import { SaveManager, MemoryStorage } from '../save/SaveManager';
import { Scheduler } from '../scheduler/Scheduler';
import { TimeScale } from '../scheduler/TimeScale';
import { TelegraphSystem } from '../telegraph/Telegraph';
import { SubtitleTrack } from '../subtitle/Subtitle';

/** 诅咒定义的最小合法骨架（缺 effects / costs 会被构造期拒绝） */
function curseDef(id: string, effects: Array<{ stat: string; op: 'add' | 'mul' | 'set'; value: number }>) {
  return {
    id,
    name: id,
    desc: '',
    effects,
    costs: [{ trigger: 'tick' as const, payload: {} }],
  };
}

/** 构造一个固定时间源的 CurseSystem（不依赖 Date.now） */
function makeCurse(defs: ReturnType<typeof curseDef>[], opts: { allowDuplicate?: boolean } = {}) {
  return new CurseSystem({ defs, allowDuplicate: opts.allowDuplicate ?? true, nowProvider: () => 0 });
}

/** 内存存档：额外暴露 keys，便于断言 __tmp */
function makeSave() {
  const storage = new MemoryStorage();
  const errors: string[] = [];
  const m = new SaveManager(storage, { gameId: 'g', version: 1, onError: (s) => errors.push(s) });
  return { storage, m, errors };
}

export function runPhase10W2BTests(): void {
  // ============================================================
  // P1-1 · [config] 数字型 id 不参与重复检测，且索引静默覆盖
  // ============================================================
  describe('config · 数字型 id 的重复检测与索引覆盖（P1-1）', () => {
    const schema = {
      id: { type: 'number' as const, required: true },
      name: { type: 'string' as const },
    };
    const rows = [
      { id: 1, name: '第一个' },
      { id: 1, name: '第二个（id 撞了）' },
    ];

    test('⚠️ 数字 id 撞车必须被报出（修复前：0 个问题）', () => {
      /**
       * 【修复前的实测】
       * ```
       * validateTable 报出的问题 = []
       * get(hero, 1) = {"id":1,"name":"第二个（id 撞了）"}
       * count(hero)  = 2
       * ```
       * 根因：查重只在 `typeof id === 'string'` 时执行，
       * 而 `_rowId` / `checkReferences` 的 idSets / ConfigLoader 索引都接受 number。
       */
      const issues = Validator.validateTable('hero', rows, schema);
      assert(
        issues.some((i) => i.message.includes('重复')),
        `应报出 id 重复，实际 ${Validator.format(issues)}`
      );
    });

    test('字符串 id 的既有查重行为不变（防止矫枉过正）', () => {
      const s = { id: { type: 'string' as const }, v: { type: 'number' as const } };
      const bad = Validator.validateTable('t', [{ id: 'a', v: 1 }, { id: 'a', v: 2 }], s);
      assert(bad.some((i) => i.message.includes('重复')), '字符串 id 重复仍要报');
      const ok = Validator.validateTable('t', [{ id: 'a', v: 1 }, { id: 'b', v: 2 }], s);
      eq(ok.length, 0, '正常表不该有误报');
    });

    test('字符串与数字 id 混用不互相误伤（防止矫枉过正）', () => {
      const s = { id: { type: 'any' as const } };
      const mixed = Validator.validateTable('t', [{ id: '1' }, { id: 1 }], s);
      eq(mixed.length, 0, "'1' 与 1 是不同 id，不应判重复");
    });
  });

  // ============================================================
  // P1-2 · [curse] effects() 把 set 效果乘以层数
  // ============================================================
  describe('curse · set 效果不得被层数缩放（P1-2）', () => {
    test('⚠️ 2 层的 set 仍是原值（修复前：value=200）', () => {
      /**
       * 【修复前的实测】
       * ```
       * stacks = 2  effects = [{"stat":"maxHp","op":"set","value":200}]
       * ```
       */
      const cs = makeCurse([curseDef('c1', [{ stat: 'maxHp', op: 'set', value: 100 }])]);
      cs.add('c1');
      cs.add('c1');
      eq(cs.stacks('c1'), 2);
      const e = cs.effects()[0];
      eq(e.value, 100, `set 不应随层数放大，实际 ${e.value}`);
      eq(e.op, 'set');
    });

    test('add / mul 仍按原样累加累乘（防止矫枉过正）', () => {
      const cs = makeCurse([
        curseDef('c1', [
          { stat: 'atk', op: 'add', value: 3 },
          { stat: 'def', op: 'mul', value: 2 },
        ]),
      ]);
      cs.add('c1');
      cs.add('c1');
      const es = cs.effects();
      eq(es[0].value, 6, 'add 仍是 3×2');
      eq(es[1].value, 4, 'mul 仍是 2²');
    });

    test('单层时原样返回原对象（防止矫枉过正）', () => {
      const def = curseDef('c1', [{ stat: 'maxHp', op: 'set', value: 100 }]);
      const cs = makeCurse([def]);
      cs.add('c1');
      eq(cs.effects()[0].value, 100);
    });
  });

  // ============================================================
  // P1-3 · [curse] importState 不校验 stacks，负数会取倒数
  // ============================================================
  describe('curse · importState 的 stacks 校验（P1-3）', () => {
    test('⚠️ 负层数不得让增益反向（修复前：mul 2 → 0.125）', () => {
      /**
       * 【修复前的实测】
       * ```
       * stacks = -3  effects = [{"stat":"atk","op":"mul","value":0.125}]
       * ```
       * `Math.pow(2, -3)` = 0.125 —— 减益变增益，且不报错。
       */
      const cs = makeCurse([curseDef('c1', [{ stat: 'atk', op: 'mul', value: 2 }])]);
      cs.importState([{ id: 'c1', since: 0, stacks: -3 }]);
      assert(cs.stacks('c1') >= 0, `层数不该为负，实际 ${cs.stacks('c1')}`);
      const v = cs.effects()[0].value;
      assert(v >= 1, `效果不该被取倒数，实际 ${v}`);
    });

    test('⚠️ NaN 层数回落（修复前：stacks=NaN，value=null）', () => {
      const cs = makeCurse([curseDef('c1', [{ stat: 'atk', op: 'mul', value: 2 }])]);
      cs.importState([{ id: 'c1', since: NaN, stacks: NaN }]);
      assert(Number.isFinite(cs.stacks('c1')), `层数应是有限值，实际 ${cs.stacks('c1')}`);
      assert(Number.isFinite(cs.effects()[0].value), '效果值应是有限值');
    });

    test('⚠️ since 非有限时回落，不产出 NaN（修复前：since=NaN）', () => {
      const cs = makeCurse([curseDef('c1', [{ stat: 'atk', op: 'add', value: 1 }])]);
      cs.importState([{ id: 'c1', since: NaN, stacks: 1 }]);
      assert(Number.isFinite(cs.active[0].since), `since 应有限，实际 ${cs.active[0].since}`);
    });

    test('正常存档导入结果不变（防止矫枉过正）', () => {
      const cs = makeCurse([curseDef('c1', [{ stat: 'atk', op: 'add', value: 5 }])]);
      cs.add('c1');
      cs.add('c1');
      const state = cs.exportState();
      const other = makeCurse([curseDef('c1', [{ stat: 'atk', op: 'add', value: 5 }])]);
      other.importState(state);
      eq(other.stacks('c1'), 2, '层数应原样导入');
      eq(other.effects()[0].value, 10, 'add 仍按层数累加');
    });

    test('未知 id 仍被跳过（防止矫枉过正）', () => {
      const cs = makeCurse([curseDef('c1', [{ stat: 'atk', op: 'add', value: 1 }])]);
      cs.importState([{ id: '已删除的诅咒', since: 0, stacks: 1 }]);
      eq(cs.effects().length, 0);
    });
  });

  // ============================================================
  // P1-4 · [hitbox] 外部直接改 box.x/y 后 remove() 留下僵尸条目
  // ============================================================
  describe('hitbox · 绕过 update 改坐标后的 remove（P1-4）', () => {
    /** 统计还有多少个格子持有该 id */
    const holding = (w: HitboxWorld, id: string): number => {
      const cells = (w as unknown as { _cells: Map<number, Set<string>> })._cells;
      let n = 0;
      for (const set of cells.values()) if (set.has(id)) n++;
      return n;
    };

    test('⚠️ 外部改坐标后 remove 不得留僵尸格子（修复前：4 个）', () => {
      /**
       * 【修复前的实测】
       * ```
       * remove = true  count = 0
       * 仍持有 id z 的格子数 = 4
       * ```
       * 根因：`remove` 按**当前**坐标重算 `_cellsFor` 去删格子，
       * 旧位置登记过的格子永远清不掉（Set 不空 → 不回收 → 泄漏）。
       */
      const w = new HitboxWorld({ cellSize: 4 });
      const b = { id: 'z', shape: { kind: 'circle' as const, radius: 1 }, x: 0, y: 0, rotation: 0, layer: 1, mask: 1 };
      w.add(b);
      b.x = 100;
      b.y = 100;                       // 绕过 update 直接改坐标（API 允许）
      assert(w.remove('z'), 'remove 应返回 true');
      eq(w.count, 0, '_boxes 里应已删除');
      eq(holding(w, 'z'), 0, '不应还有格子持有该 id（修复前是 4）');
    });

    test('⚠️ 僵尸格子清掉后查询不再遍历空 id（修复前：需遍历 4 个死格）', () => {
      const w = new HitboxWorld({ cellSize: 4 });
      const b = { id: 'z', shape: { kind: 'circle' as const, radius: 1 }, x: 0, y: 0, rotation: 0, layer: 1, mask: 1 };
      w.add(b);
      b.x = 100;
      b.y = 100;
      w.remove('z');
      // 旧位置再查：不应命中（若僵尸 id 还在，query 会走到 _boxes.get(id) === undefined 的分支）
      eq(w.query({ kind: 'circle', radius: 1 }, 0, 0, 0, 1).length, 0);
      eq(w.query({ kind: 'circle', radius: 1 }, 100, 100, 0, 1).length, 0);
    });

    test('正常 update 路径的命中不变（防止矫枉过正）', () => {
      const w = new HitboxWorld({ cellSize: 4 });
      w.add({ id: 'a', shape: { kind: 'circle', radius: 1 }, x: 0, y: 0, rotation: 0, layer: 1, mask: 1 });
      w.update('a', 10, 0);
      eq(w.query({ kind: 'circle', radius: 1 }, 10, 0, 0, 1).length, 1, '新位置应命中');
      eq(w.query({ kind: 'circle', radius: 1 }, 0, 0, 0, 1).length, 0, '旧位置不应命中');
      eq(holding(w, 'a'), 2, '只登记在新位置（半径 1 跨 y 方向两行）');
    });

    test('remove 后再 add 同一 id 正常（防止矫枉过正）', () => {
      const w = new HitboxWorld({ cellSize: 4 });
      w.add({ id: 'a', shape: { kind: 'circle', radius: 1 }, x: 0, y: 0, rotation: 0, layer: 1, mask: 1 });
      w.remove('a');
      w.add({ id: 'a', shape: { kind: 'circle', radius: 1 }, x: 5, y: 5, rotation: 0, layer: 1, mask: 1 });
      eq(w.count, 1);
      eq(w.query({ kind: 'circle', radius: 1 }, 5, 5, 0, 1).length, 1);
      eq(w.query({ kind: 'circle', radius: 1 }, 0, 0, 0, 1).length, 0);
    });
  });

  // ============================================================
  // P1-5 · [leaderboard] importEntries 绕过分数有限性校验
  // ============================================================
  describe('leaderboard · importEntries 的分数校验（P1-5）', () => {
    test('⚠️ NaN 分数不得混进榜单（修复前：rank 1 的分数是 null）', () => {
      /**
       * 【修复前的实测】
       * ```
       * ranked = [{"id":"p1","rank":1,"score":null},{"id":"p2","rank":2,"score":5}]
       * ```
       * NaN 参与比较恒为 false，排序结果不可预测，玩家看到"第一名分数是空的"。
       */
      const lb = new Leaderboard();
      lb.importEntries([
        { playerId: 'p1', name: 'p1', score: NaN, at: 1 },
        { playerId: 'p2', name: 'p2', score: 5, at: 2 },
      ]);
      eq(lb.lastDroppedCount, 1, '应记录丢弃了 1 条');
      eq(lb.size, 1, '只剩合法那条');
      assert(lb.ranked().every((e) => Number.isFinite(e.score)), '榜单里不该有非有限分数');
    });

    test('⚠️ Infinity / 缺失条目同样被拒（修复前：照收）', () => {
      const lb = new Leaderboard();
      lb.importEntries([
        { playerId: 'p1', name: 'p1', score: Infinity, at: 1 },
        { playerId: 'p2', name: 'p2', score: -Infinity, at: 2 },
      ]);
      eq(lb.size, 0, '两条都该被丢');
      eq(lb.lastDroppedCount, 2);
    });

    test('⚠️ strict 模式与 submitAll 口径一致（抛错）', () => {
      const lb = new Leaderboard();
      throws(
        () => lb.importEntries([{ playerId: 'p1', name: 'p1', score: NaN, at: 1 }], { strict: true }),
        '分数'
      );
    });

    test('合法条目导入后顺序与排名不变（防止矫枉过正）', () => {
      const lb = new Leaderboard();
      lb.importEntries([
        { playerId: 'a', name: 'a', score: 10, at: 1 },
        { playerId: 'b', name: 'b', score: 30, at: 2 },
        { playerId: 'c', name: 'c', score: 20, at: 3 },
      ]);
      eq(lb.lastDroppedCount, 0);
      eq(lb.ranked().map((e) => e.playerId).join(','), 'b,c,a');
      eq(lb.ranked()[0].rank, 1);
    });
  });

  // ============================================================
  // P1-6 · [leaderboard] ranked() 每次全量展开 + pageSize 未收口
  // ============================================================
  describe('leaderboard · 分页不再全量展开（P1-6）', () => {
    test('⚠️ pageSize=0 不得给出 Infinity 页数（修复前：pageCount=Infinity）', () => {
      /**
       * 【修复前的实测】
       * ```
       * pageSize=0 → pageCount = Infinity，entries = []，hasNext = true
       * ```
       * "有下一页但翻出来是空的"——UI 上表现为下一页永远可点、永远翻不动。
       */
      const lb = new Leaderboard();
      lb.submit({ playerId: 'p1', name: 'p1', score: 10, at: 1 });
      const pg = lb.page(1, 0);
      assert(Number.isFinite(pg.pageCount), `pageCount 应有限，实际 ${pg.pageCount}`);
      eq(pg.entries.length, 1, '收口后应能翻出这一条');
      eq(pg.pageSize, 1);
    });

    test('⚠️ pageSize 为负同样被收口（修复前：返回空页）', () => {
      const lb = new Leaderboard();
      lb.submit({ playerId: 'p1', name: 'p1', score: 10, at: 1 });
      eq(lb.page(1, -3).entries.length, 1);
    });

    test('⚠️ 大榜单翻页只展开当页（修复前：每页 2 万个对象）', () => {
      /**
       * 【修复前的实测】2 万条 × 60 次 page() = **913ms**。
       * 按 capacity 上界 1e7 外推，翻一页就是分配 1000 万个对象。
       */
      const lb = new Leaderboard({ capacity: 1e7 });
      const es: Array<{ playerId: string; name: string; score: number; at: number }> = [];
      for (let i = 0; i < 20000; i++) es.push({ playerId: `p${i}`, name: 'n', score: i, at: i });
      lb.submitAll(es);
      const t0 = Date.now();
      for (let k = 0; k < 60; k++) lb.page(1, 10);
      const ms = Date.now() - t0;
      assert(ms < 200, `2 万条 × 60 次 page() 应 < 200ms，实际 ${ms}ms（修复前 913ms）`);
    });

    test('名次与翻页结果不变（防止矫枉过正）', () => {
      const lb = new Leaderboard();
      for (let i = 1; i <= 10; i++) lb.submit({ playerId: `p${i}`, name: `p${i}`, score: i, at: i });
      const p2 = lb.page(2, 3);
      eq(p2.entries.map((e) => e.playerId).join(','), 'p7,p6,p5');
      eq(p2.entries[0].rank, 4, '第 2 页第一条应是第 4 名（不是 1）');
      eq(p2.total, 10);
      eq(p2.pageCount, 4);
      eq(p2.hasNext, true);
    });

    test('rankOf / around / top 结果不变（防止矫枉过正）', () => {
      const lb = new Leaderboard();
      lb.submit({ playerId: 'a', name: 'a', score: 10, at: 1 });
      lb.submit({ playerId: 'b', name: 'b', score: 30, at: 2 });
      lb.submit({ playerId: 'c', name: 'c', score: 20, at: 3 });
      eq(lb.rankOf('a')?.rank, 3);
      eq(lb.rankOf('zzz'), null);
      eq(lb.top(2).map((e) => e.playerId).join(','), 'b,c');
      eq(lb.around('c', 1).length, 3);
    });
  });

  // ============================================================
  // P1-7 · [minimap] FogMap.reveal 用 X 轴尺寸换算 Y 轴跨度
  // ============================================================
  describe('minimap · FogMap.reveal 在非正方形世界（P1-7）', () => {
    const revealedCells = (f: FogMap, res: number): number =>
      Math.round((f as unknown as { coverage: number }).coverage * res * res);

    test('⚠️ 窄长世界：半径覆盖全高（修复前：只揭开 21 格）', () => {
      /**
       * 【修复前的实测】
       * 世界 1000×100、res 100、reveal({x:500,y:50}, 100)
       * → 只揭开 **21 格**（step = 100/1000*100 = 10 格）
       * 而半径 100 ≥ 世界高度 100，Y 方向本应全覆盖。
       */
      const f = new FogMap({ x: 1000, y: 100 }, 100);
      f.reveal({ x: 500, y: 50 }, 100);
      const n = revealedCells(f, 100);
      // 修正后：Y 方向全覆盖（100 格），X 方向半径 100 世界单位 = ±10 格 = 21 格
      assert(n > 21 * 3, `窄长世界应远多于 21 格，实际 ${n}`);
      assert(f.isRevealed({ x: 500, y: 0 }), '世界顶部应被揭开');
      assert(f.isRevealed({ x: 500, y: 99 }), '世界底部应被揭开');
    });

    test('⚠️ 高瘦世界（竖版）同样正确（修复前：X 方向揭不全）', () => {
      const f = new FogMap({ x: 100, y: 1000 }, 100);
      f.reveal({ x: 50, y: 500 }, 100);
      assert(f.isRevealed({ x: 0, y: 500 }), '世界最左应被揭开');
      assert(f.isRevealed({ x: 99, y: 500 }), '世界最右应被揭开');
    });

    test('正方形世界的行为与修复前一致（防止矫枉过正）', () => {
      /**
       * 对照组：世界 100×100、reveal(中心, 10) → 修复前是 21 格（= 2×10+1）。
       * 改成圆形判定后，正方形格子下应仍是"直径 20 世界单位的圆"——
       * 格数会略少于方形包围盒，但不能少到离谱。
       */
      const f = new FogMap({ x: 100, y: 100 }, 100);
      f.reveal({ x: 50, y: 50 }, 10);
      const n = revealedCells(f, 100);
      assert(n > 200, `正方形世界半径 10 应揭开约 π×10² ≈ 314 格，实际 ${n}`);
      assert(n <= 441, `不应超过方形包围盒 441 格，实际 ${n}`);
      assert(f.isRevealed({ x: 50, y: 50 }), '圆心必揭开');
      assert(!f.isRevealed({ x: 50, y: 90 }), '圆外不应揭开');
    });

    test('radius=0 的单点揭开不变（防止矫枉过正）', () => {
      const f = new FogMap({ x: 1000, y: 1000 }, 32);
      f.reveal({ x: 500, y: 500 }, 0);
      assert(f.isRevealed({ x: 500, y: 500 }));
      near(f.coverage, 1 / (32 * 32), 1e-9);
    });

    test('越界坐标仍不崩（防止矫枉过正）', () => {
      const f = new FogMap({ x: 1000, y: 1000 }, 32);
      f.reveal({ x: -100, y: -100 }, 50);
      f.reveal({ x: 99999, y: 99999 }, 50);
      eq(f.isRevealed({ x: -100, y: -100 }), false);
    });
  });

  // ============================================================
  // P1-8 · [minimap] scale 为 0 时 minimapToWorld 除零
  // ============================================================
  describe('minimap · scale 的下界（P1-8）', () => {
    test('⚠️ scale=0 不得产出 NaN 坐标（修复前：{x:NaN,y:NaN}）', () => {
      /**
       * 【修复前的实测】
       * ```
       * new Minimap({... mode:'follow', scale: 0}).minimapToWorld({x:10,y:10},{x:0,y:0})
       *   → {x: null, y: null}   （JSON 里的 NaN）
       * ```
       * 后果："点哪走哪"返回 NaN，角色瞬移到 NaN 或不动，且不报错。
       */
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow',
        scale: 0,
      });
      const p = m.minimapToWorld({ x: 10, y: 10 }, { x: 0, y: 0 });
      assert(Number.isFinite(p.x), `x 应有限，实际 ${p.x}`);
      assert(Number.isFinite(p.y), `y 应有限，实际 ${p.y}`);
    });

    test('⚠️ fixed 模式同样不产出 NaN（修复前：同一处除零）', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'fixed',
        scale: 0,
      });
      const p = m.minimapToWorld({ x: 10, y: 10 }, { x: 0, y: 0 });
      assert(Number.isFinite(p.x) && Number.isFinite(p.y), `实际 ${JSON.stringify(p)}`);
    });

    test('⚠️ 负数 / NaN 的 scale 也收口', () => {
      for (const s of [-1, NaN, Infinity]) {
        const m = new Minimap({
          worldSize: { x: 1000, y: 1000 },
          viewSize: { x: 200, y: 200 },
          mode: 'follow',
          scale: s,
        });
        assert(m.scale > 0, `scale=${s} 应收口为正，实际 ${m.scale}`);
      }
    });

    test('正常 scale 的换算结果不变（防止矫枉过正）', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow',
        scale: 2,
      });
      eq(m.scale, 2, '显式 scale 应原样保留');
      const p = m.minimapToWorld({ x: 10, y: 0 }, { x: 100, y: 100 });
      near(p.x, 105, 1e-9);
      near(p.y, 100, 1e-9);
    });
  });

  // ============================================================
  // P1-9 · [save] clearAll() 不清理 __tmp 备份键
  // ============================================================
  describe('save · clearAll 清理 __tmp 残留（P1-9）', () => {
    test('⚠️ 中断留下的 __tmp 必须被清掉（修复前：永久残留）', () => {
      /**
       * 【修复前的实测】
       * ```
       * write('slot1') → 手动写入 save_slot1__tmp → clearAll() → keys = ["save_slot1__tmp"]
       * ```
       * `listSlots()` 过滤掉了 __tmp，而 `clearAll()` 又基于 `listSlots()`——
       * 于是开发者自查时看不到任何异常，存储占用只增不减。
       */
      const { storage, m } = makeSave();
      m.write('slot1', { a: 1 });
      storage.write('save_slot1__tmp', 'garbage');   // 模拟写入中断
      m.clearAll();
      eq(storage.keys().length, 0, `不该有残留，实际 ${JSON.stringify(storage.keys())}`);
    });

    test('⚠️ purgeTempKeys 只清自己的前缀', () => {
      const { storage, m } = makeSave();
      m.write('slot1', { a: 1 });
      storage.write('save_slot1__tmp', 'garbage');
      storage.write('other_mod__tmp', '别人的');
      storage.write('other_mod', '别人的档');
      const n = m.purgeTempKeys();
      eq(n, 1, '只清本前缀下的 1 个');
      assert(storage.keys().includes('other_mod__tmp'), '别人的 tmp 不该被动');
      assert(storage.keys().includes('other_mod'), '别人的档不该被动');
      assert(storage.keys().includes('save_slot1'), '自己的正档不该被动');
    });

    test('正常写档后不残留 __tmp，槽位列表不含 __tmp（防止矫枉过正）', () => {
      const { storage, m } = makeSave();
      m.write('slot1', { level: 1 });
      assert(!storage.keys().some((k) => k.endsWith('__tmp')), `不该残留：${storage.keys()}`);
      assert(!m.listSlots().some((s) => s.includes('__tmp')), '槽位列表不该含 __tmp');
      eq(m.listSlots().length, 1);
    });

    test('读档仍能从 __tmp 回退（防止矫枉过正：清理不能抢在回退之前）', () => {
      const { storage, m } = makeSave();
      m.write('slot1', { level: 5 });
      // 用一次正常写入的产物当备份（checksum 才是匹配的），再写坏主档
      const good = storage.read('save_slot1');
      assert(good !== null, '正常写入应留下主档');
      storage.write('save_slot1__tmp', good as string);
      storage.write('save_slot1', '{坏档');
      const r = m.read<{ level: number }>('slot1');
      assert(r.ok, `应能从备份回退，实际 ${r.ok ? '' : r.error}`);
      assert(r.ok && r.value.level === 5, '回退后数据应正确');
    });
  });

  // ============================================================
  // P1-10 · [scheduler] maxDeltaTime 未做数值收口
  // ============================================================
  describe('scheduler · maxDeltaTime 的收口（P1-10）', () => {
    test('⚠️ maxDeltaTime=0 不得让游戏静止（修复前：回调 0 次）', () => {
      /**
       * 【修复前的实测】
       * ```
       * maxDeltaTime=0 → 每帧回调次数 = 0，lastRealDt = 0
       * ```
       * 所有 dt 被 clamp 成 0 → `if (delta === 0) continue` → 回调一次都不执行。
       * 不报错，只是"该发生的事没发生"。
       */
      const s = new Scheduler({ maxDeltaTime: 0 });
      let n = 0;
      s.everyFrame(() => n++);
      for (let i = 0; i < 5; i++) s.update(0.016);
      assert(n > 0, `回调应执行，实际 ${n} 次（修复前是 0）`);
      assert(s.lastRealDt > 0, `lastRealDt 应为正，实际 ${s.lastRealDt}`);
    });

    test('⚠️ maxDeltaTime=-1 不得让时间倒流（修复前：delay 永不到期）', () => {
      /**
       * 【修复前的实测】
       * ```
       * maxDeltaTime=-1 → 累计 0.16s 后 delay(1) 到期 = false，lastRealDt = -1
       * ```
       * `task.remaining -= delta` 中 delta 为负 → 剩余时间越减越多。
       */
      const s = new Scheduler({ maxDeltaTime: -1 });
      let fired = false;
      s.delay(0.05, () => { fired = true; });
      for (let i = 0; i < 20; i++) s.update(0.016);
      assert(fired, '延时任务应正常到期');
      assert(s.lastRealDt > 0, `lastRealDt 应为正，实际 ${s.lastRealDt}`);
      assert(s.scaledTime > 0, `累计时间应为正，实际 ${s.scaledTime}`);
    });

    test('⚠️ NaN 的 maxDeltaTime 回落默认 0.1', () => {
      const s = new Scheduler({ maxDeltaTime: NaN });
      let got = 0;
      s.everyFrame((dt) => (got += dt));
      s.update(30);                       // 切后台 30 秒
      near(got, 0.1, 1e-6, '应 clamp 到默认 0.1');
    });

    test('正常 clamp 行为不变（防止矫枉过正）', () => {
      const s = new Scheduler({ maxDeltaTime: 0.1 });
      let got = 0;
      s.everyFrame((dt) => (got += dt));
      s.update(30);
      near(got, 0.1, 1e-6, '切后台回来必须被 clamp');
      got = 0;
      s.update(0.016);
      near(got, 0.016, 1e-6, '正常帧不受影响');
    });
  });

  // ============================================================
  // P1-11 · [telegraph] clear() 不触发 onComplete
  // ============================================================
  describe('telegraph · clear 与 cancelAll 行为一致（P1-11）', () => {
    const spawn = (ts: TelegraphSystem, onComplete: (cancelled: boolean) => void) =>
      ts.spawn({
        shape: { kind: 'circle', radius: 1 },
        x: 0, y: 0,
        windup: 1, active: 1, recover: 1,
        onComplete: (_t, cancelled) => onComplete(cancelled),
      });

    test('⚠️ clear() 必须触发 onComplete（修复前：0 次）', () => {
      /**
       * 【修复前的实测】
       * ```
       * spawn 一个带 onComplete 的 telegraph → clear() → 回调次数 0
       * （同样场景调 cancelAll() → 1 次）
       * ```
       * 外部状态机靠 onComplete 做清理，切场景时收不到 → 预警圈残留、AI 锁死。
       */
      const ts = new TelegraphSystem();
      let n = 0;
      spawn(ts, () => n++);
      ts.clear();
      eq(n, 1, 'clear 应触发一次 onComplete（修复前是 0）');
    });

    test('⚠️ clear() 与 cancelAll() 的回调参数一致（都是 cancelled=true）', () => {
      const a = new TelegraphSystem();
      const b = new TelegraphSystem();
      let flagA: boolean | null = null;
      let flagB: boolean | null = null;
      spawn(a, (cancelled) => { flagA = cancelled; });
      spawn(b, (cancelled) => { flagB = cancelled; });
      a.clear();
      b.cancelAll();
      eq(flagA, true, 'clear 应带 cancelled=true');
      eq(flagB, true, 'cancelAll 应带 cancelled=true');
      eq(flagA, flagB, '两个 API 的参数必须一致');
    });

    test('clear() 后列表为空、不重复回调（防止矫枉过正）', () => {
      const ts = new TelegraphSystem();
      let n = 0;
      spawn(ts, () => n++);
      spawn(ts, () => n++);
      ts.clear();
      eq(ts.count, 0);
      ts.tick(0.016);
      eq(n, 2, '每条只回调一次');
    });

    test('cancelAll 的返回值语义不变（防止矫枉过正）', () => {
      const ts = new TelegraphSystem();
      spawn(ts, () => { /* noop */ });
      spawn(ts, () => { /* noop */ });
      eq(ts.cancelAll(), 2, '返回取消的条数');
      eq(ts.clear(), 0, '已经空了就返回 0');
    });
  });

  // ============================================================
  // P2 · [config] C2 ~ C7
  // ============================================================
  describeAsync('config · 热重载与查询口径（P2 C2 / C4）', async () => {
    const schema = {
      id: { type: 'string' as const, required: true },
      hp: { type: 'number' as const, min: 1 },
    };

    await testAsync('⚠️ 同一张表重复 load 不得累积 issues（修复前：1→2→3）', async () => {
      /**
       * 【修复前的实测】
       * ```
       * load x1 issues = 1
       * load x2 issues = 2
       * load x3 issues = 3
       * ```
       * `reload()` 会 filter，`load()` 不会——长期热重载下缓慢增长。
       */
      const loader = new ConfigLoader(
        new MemoryTableSource({ hero: [{ id: 'a', hp: -5 }] }),
        { tables: { hero: schema }, throwOnError: false }
      );
      await loader.load('hero');
      eq(loader.issues.length, 1);
      await loader.load('hero');
      eq(loader.issues.length, 1, `第二次 load 不该翻倍，实际 ${loader.issues.length}`);
      await loader.load('hero');
      eq(loader.issues.length, 1, `第三次 load 不该翻倍，实际 ${loader.issues.length}`);
    });

    await testAsync('⚠️ 非数组数据源要报"配置问题"而不是 TypeError（修复前：rows is not iterable）', async () => {
      /**
       * 【修复前的实测】
       * ```
       * 抛出: TypeError | rows is not iterable
       * ```
       * 这个 throw 发生在 try 之外，`throwOnError: false` 挡不住，
       * 第一张表炸掉，后面所有表的问题一条都看不到。
       */
      const bad = { load: (() => ({ notAnArray: true })) as unknown as () => readonly unknown[] };
      const loader = new ConfigLoader(bad, { tables: { hero: { id: { type: 'string' } } }, throwOnError: false });
      await loader.load('hero');
      eq(loader.issues.length, 1, '应记成一条 issue 而不是抛出');
      assert(
        loader.issues[0].message.includes('不是数组'),
        `文案应说明是数据源的问题，实际 ${loader.issues[0].message}`
      );
    });

    await testAsync('⚠️ 索引覆盖要记进 issues（异步路径）', async () => {
      const rows = [{ id: 1, name: '第一个' }, { id: 1, name: '第二个' }];
      const loader = new ConfigLoader(
        new MemoryTableSource({ hero: rows }),
        { tables: { hero: { id: { type: 'number' }, name: { type: 'string' } } }, throwOnError: false }
      );
      await loader.load('hero');
      eq(loader.count('hero'), 2, '行数仍是 2');
      assert(
        loader.issues.some((i) => i.message.includes('重复')),
        `应记下索引覆盖，实际 ${JSON.stringify(loader.issues)}`
      );
    });

    await testAsync('正常热重载仍生效（防止矫枉过正）', async () => {
      const src = new MemoryTableSource({ hero: [{ id: 'a', hp: 30 }] });
      const loader = new ConfigLoader(src, { tables: { hero: schema } });
      await loader.load('hero');
      eq(loader.get<{ hp: number }>('hero', 'a').hp, 30);
      src.set('hero', [{ id: 'a', hp: 999 }]);
      await loader.reload('hero');
      eq(loader.get<{ hp: number }>('hero', 'a').hp, 999, '重载后应返回新值');
    });
  });

  describe('config · C3 / C5 / C6 / C7', () => {
    test('⚠️ count() 对未加载表与 all() 口径一致（修复前：静默返回 0）', () => {
      /**
       * 【修复前的实测】
       * ```
       * count(nope) = 0
       * all(nope) 抛错 = [ConfigLoader] 表 "nope" 未加载
       * ```
       * 同为查询接口，一个静默 0、一个抛错——
       * "先探一下有没有数据"的写法会安静地走 else 分支。
       */
      const loader = new ConfigLoader(new MemoryTableSource({}), { tables: {} });
      throws(() => loader.count('nope'), '未加载');
    });

    test('⚠️ 旧取消函数不得误删新注册的同名监听器（修复前：handlers 变 0）', () => {
      /**
       * 【修复前的实测】
       * ```
       * handlers 长度 = 0（期望 1）
       * ```
       * 与已修的"EventBus 旧取消函数误删同名新监听器"同型：
       * 用函数值本身当身份，就没有"第几次订阅"这个维度。
       */
      const loader = new ConfigLoader(new MemoryTableSource({}), { tables: {} });
      let n = 0;
      const fn = () => n++;
      const off = loader.onReload(fn);
      off();
      const off2 = loader.onReload(fn);
      off();                       // 手滑再调一次旧取消函数
      const handlers = (loader as unknown as { _reloadHandlers: Array<() => void> })._reloadHandlers;
      eq(handlers.length, 1, '新注册的那个不该被删掉');
      (handlers[0] as unknown as (t: string) => void)('hero');
      eq(n, 1, '新监听器仍应收到通知');
      off2();
      eq(handlers.length, 0);
    });

    test('⚠️ 已加载失败的表不引发"引用了不存在的表"级联误报（修复前：误报）', () => {
      /**
       * 【修复前的实测】
       * ```
       * ["引用了不存在的表 \"b\""]
       * ```
       * 但"不在 tables 里"有两种原因：真写错表名 / 本次加载失败。
       * 后者的真因是那次加载失败，这里重复报只会把注意力引错方向。
       */
      const tables = { a: [{ id: 'x', ref: 'y' }] };
      const schemas = {
        a: { id: { type: 'string' as const }, ref: { type: 'ref' as const, table: 'b' } },
        b: { id: { type: 'string' as const } },      // 声明了，但本次没加载成功
      };
      const issues = Validator.checkReferences(tables, schemas);
      eq(issues.length, 0, `声明过的表不该再报，实际 ${Validator.format(issues)}`);
    });

    test('真·写错表名仍要报（防止矫枉过正）', () => {
      const tables = { a: [{ id: 'x', ref: 'y' }] };
      const schemas = {
        a: { id: { type: 'string' as const }, ref: { type: 'ref' as const, table: 'typo_table' } },
      };
      const issues = Validator.checkReferences(tables, schemas);
      assert(
        issues.some((i) => i.message.includes('typo_table')),
        '没声明过的表名仍应报出来'
      );
    });

    test('⚠️ 数组元素一次报全（修复前：只报第 0 个）', () => {
      /**
       * 【修复前的实测】
       * ```
       * 问题数 = 1 ["第 0 个元素类型错误：应是 string，实际 number"]
       * ```
       * `tags: [1,2,3]` 只报第一个——"改一个→重启→再改一个"正是要避免的体验。
       */
      const schema = { id: { type: 'string' as const }, tags: { type: 'array' as const, item: 'string' as const } };
      const issues = Validator.validateTable('t', [{ id: 'a', tags: [1, 2, 3] }], schema);
      eq(issues.length, 1, '仍是同一字段的一条 issue');
      const msg = issues[0].message;
      assert(msg.includes('第 0 个'), msg);
      assert(msg.includes('第 1 个'), msg);
      assert(msg.includes('第 2 个'), msg);
    });

    test('合法数组不误报（防止矫枉过正）', () => {
      const schema = { id: { type: 'string' as const }, tags: { type: 'array' as const, item: 'string' as const } };
      eq(Validator.validateTable('t', [{ id: 'a', tags: ['x', 'y'] }], schema).length, 0);
    });
  });

  // ============================================================
  // P2 · [curse] Cu3 / Cu5 / Cu6
  // ============================================================
  describe('curse · 时间源注入与可卸载（P2 Cu3 / Cu5 / Cu6）', () => {
    test('⚠️ 时间源可注入（修复前：内部直接取 Date.now）', () => {
      let now = 1000;
      const cs = new CurseSystem({
        defs: [curseDef('c1', [{ stat: 'atk', op: 'add', value: 1 }])],
        nowProvider: () => now,
      });
      cs.add('c1');
      eq(cs.active[0].since, 1000, '应用注入的时间，不是墙钟');
      now = 5000;
      cs.add('c1');
      eq(cs.active[0].since, 1000, 'since 保留首次获得时刻（新时间不影响）');
    });

    test('不传 nowProvider 时仍走 Date.now（防止矫枉过正）', () => {
      const before = Date.now();
      const cs = new CurseSystem({ defs: [curseDef('c1', [{ stat: 'atk', op: 'add', value: 1 }])] });
      cs.add('c1');
      assert(cs.active[0].since >= before, '默认时间源仍应工作');
    });

    test('⚠️ importState 要清掉上一局的代价计数（修复前：沿用旧数字）', () => {
      /**
       * 【修复前的实测】
       * ```
       * tick 后 costCount = 2
       * importState 后 costCount = 2   ← 新档沿用了上一局
       * ```
       * 读档后 UI 一上来就显示"已触发 2 次"，而这一局一次都没触发过。
       */
      const cs = makeCurse([curseDef('c1', [{ stat: 'atk', op: 'add', value: 1 }])], { allowDuplicate: false });
      cs.add('c1');
      cs.tick();
      cs.tick();
      eq(cs.costCount('c1'), 2);
      cs.importState([{ id: 'c1', since: 0, stacks: 1 }]);
      eq(cs.costCount('c1'), 0, '导入等价于重建状态，计数应归零');
    });

    test('remove / clear 清计数的既有行为不变（防止矫枉过正）', () => {
      const cs = makeCurse(
        [{ ...curseDef('c1', [{ stat: 'atk', op: 'add', value: 1 }]), removeCondition: { id: 'r', desc: 'd' } }] as never,
        { allowDuplicate: false }
      );
      cs.add('c1');
      cs.tick();
      eq(cs.costCount('c1'), 1);
      cs.remove('c1', true);
      eq(cs.costCount('c1'), 0);
    });

    test('⚠️ 有 destroy()（修复前：无，违反铁律 5）', () => {
      const cs = makeCurse([curseDef('c1', [{ stat: 'atk', op: 'add', value: 1 }])]);
      cs.add('c1');
      cs.destroy();
      eq(cs.count, 0);
      eq(cs.effects().length, 0);
    });
  });

  // ============================================================
  // 二次任务 · [curse] 两条与 blessing 同构的洞（§3.8，W2-A 附议派工）
  //
  // 【为什么这两条不在原清单里】
  // W8-B 修 blessing 时把 `pick()` 权重与 `importState` 通知一并修了，
  // 而 curse 与 blessing 是同构单元——同一个 bug 在 curse 上原样存在。
  // 上一轮我按纪律 1.1「不擅自扩范围」只登记未修；W2-A 验收时附议
  // 「建议派 W2-B 补修」，本轮据此补修 + 补对照用例。
  // ============================================================
  describe('curse · 二次任务：pick 的 NaN 权重（同构洞 1）', () => {
    /**
     * 确定性随机源（LCG），保证 300 次抽样的分布可复现。
     * 用 Math.random 的话这条用例会偶发失败，那就失去了护栏的意义。
     */
    function makeRng(seed = 1) {
      let s = seed >>> 0;
      return {
        next(): number {
          s = (s * 1664525 + 1013904223) >>> 0;
          return s / 4294967296;
        },
      };
    }

    test('⚠️ NaN 权重不得让轮盘赌退化成"永远抽池尾"（修复前 300/300 命中最后一个）', () => {
      const defs = [
        { ...curseDef('c1', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 1 },
        { ...curseDef('c2', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 1 },
        { ...curseDef('c3', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: NaN },
      ];
      const cs = makeCurse(defs, { allowDuplicate: true });
      const rng = makeRng();
      const hit: Record<string, number> = { c1: 0, c2: 0, c3: 0 };
      for (let i = 0; i < 300; i++) hit[cs.pick(rng, 1)[0].id]++;

      /**
       * 【修复前的实测】`{"c1":0, "c2":0, "c3":300}`
       * total 变 NaN → `total <= 0` 恒 false → `r -= NaN` 让 `r < 0` 恒 false
       * → idx 停在初值 `pool.length - 1` → 每次都是池子最后一个。
       */
      assert(hit.c3 < 300, `NaN 权重不该让 c3 被抽中 300/300 次，实际 ${JSON.stringify(hit)}`);
      assert(hit.c1 > 0 && hit.c2 > 0, `c1 / c2 应能被抽到，实际 ${JSON.stringify(hit)}`);
    });

    test('⚠️ 负权重同样被夹到 0（NaN 是"非有限"，负数是"合法但荒谬"）', () => {
      const defs = [
        { ...curseDef('c1', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 1 },
        { ...curseDef('c2', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: -5 },
      ];
      const cs = makeCurse(defs, { allowDuplicate: true });
      const hit: Record<string, number> = { c1: 0, c2: 0 };
      const rng = makeRng(7);
      for (let i = 0; i < 200; i++) hit[cs.pick(rng, 1)[0].id]++;
      eq(hit.c2, 0, '负权重应被夹到 0，不该被抽中');
      eq(hit.c1, 200);
    });

    test('正常权重下的分布仍然均衡（防止矫枉过正）', () => {
      const defs = [
        { ...curseDef('c1', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 1 },
        { ...curseDef('c2', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 1 },
        { ...curseDef('c3', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 1 },
      ];
      const cs = makeCurse(defs, { allowDuplicate: true });
      const rng = makeRng(42);
      const hit: Record<string, number> = { c1: 0, c2: 0, c3: 0 };
      for (let i = 0; i < 300; i++) hit[cs.pick(rng, 1)[0].id]++;
      // 300 次分给 3 个等权重项，每个约 100；给足余量防偶发
      for (const k of ['c1', 'c2', 'c3']) {
        assert(hit[k] > 60, `等权重下 ${k} 应大致均衡，实际 ${JSON.stringify(hit)}`);
      }
    });

    test('权重悬殊时仍按权重倾斜（防止矫枉过正）', () => {
      const defs = [
        { ...curseDef('c1', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 9 },
        { ...curseDef('c2', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 1 },
      ];
      const cs = makeCurse(defs, { allowDuplicate: true });
      const rng = makeRng(9);
      const hit: Record<string, number> = { c1: 0, c2: 0 };
      for (let i = 0; i < 300; i++) hit[cs.pick(rng, 1)[0].id]++;
      assert(hit.c1 > hit.c2 * 2, `9:1 的权重应明显偏向 c1，实际 ${JSON.stringify(hit)}`);
    });

    test('pick 多次不重复、且 filter 仍生效（防止矫枉过正）', () => {
      const defs = [
        { ...curseDef('c1', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 1 },
        { ...curseDef('c2', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 1 },
        { ...curseDef('c3', [{ stat: 'atk', op: 'add' as const, value: 1 }]), weight: 1 },
      ];
      const cs = makeCurse(defs, { allowDuplicate: false });
      const picked = cs.pick(makeRng(3), 2).map((d) => d.id);
      eq(picked.length, 2);
      eq(new Set(picked).size, 2, '同一次 pick 内不应重复');

      const only1 = cs.pick(makeRng(3), 1, (d) => d.id === 'c1').map((d) => d.id);
      eq(only1.join(','), 'c1', 'filter 仍应生效');
    });
  });

  describe('curse · 二次任务：importState 触发 onChange（同构洞 2）', () => {
    function makeTracking(ids: string[]) {
      const log: string[] = [];
      const cs = new CurseSystem({
        defs: ids.map((id) => curseDef(id, [{ stat: 'atk', op: 'add' as const, value: 1 }])),
        allowDuplicate: true,
        nowProvider: () => 0,
        onChange: (id, action) => log.push(`${action}:${id}`),
      });
      return { cs, log };
    }

    test('⚠️ 导入新增的诅咒要通知（修复前：一次都不通知）', () => {
      const { cs, log } = makeTracking(['c1']);
      log.length = 0;
      cs.importState([{ id: 'c1', since: 0, stacks: 4 }]);
      assert(log.includes('add:c1'), `导入后应通知 add:c1，实际 ${JSON.stringify(log)}`);
      eq(cs.stacks('c1'), 4);
    });

    test('⚠️ 导入后消失的诅咒要通知 remove（修复前：UI 残留图标）', () => {
      const { cs, log } = makeTracking(['c1', 'c2']);
      cs.add('c1');
      cs.add('c2');
      log.length = 0;
      cs.importState([]);
      assert(log.includes('remove:c1'), `应通知 remove:c1，实际 ${JSON.stringify(log)}`);
      assert(log.includes('remove:c2'), `应通知 remove:c2，实际 ${JSON.stringify(log)}`);
      eq(cs.count, 0);
    });

    test('⚠️ 部分消失时：留下的报 add、消失的报 remove', () => {
      const { cs, log } = makeTracking(['c1', 'c2']);
      cs.add('c1');
      cs.add('c2');
      log.length = 0;
      cs.importState([{ id: 'c2', since: 0, stacks: 3 }]);
      assert(log.includes('add:c2'), `留下的 c2 应报 add，实际 ${JSON.stringify(log)}`);
      assert(log.includes('remove:c1'), `消失的 c1 应报 remove，实际 ${JSON.stringify(log)}`);
    });

    test('每个 id 恰好通知一次，不重复（幂等性）', () => {
      const { cs, log } = makeTracking(['c1', 'c2', 'c3']);
      cs.add('c1');
      cs.add('c2');
      log.length = 0;
      cs.importState([
        { id: 'c2', since: 0, stacks: 2 },
        { id: 'c3', since: 0, stacks: 1 },
      ]);
      const c2Count = log.filter((l) => l.endsWith(':c2')).length;
      eq(c2Count, 1, '同一个 id 在 before ∪ after 里只应出现一次');
      eq(log.length, 3, 'c1(remove) + c2(add) + c3(add) = 3 条');
    });

    test('未配 onChange 时导入不报错（防止矫枉过正）', () => {
      const cs = makeCurse([
        curseDef('c1', [{ stat: 'atk', op: 'add' as const, value: 1 }]),
      ]);
      cs.importState([{ id: 'c1', since: 0, stacks: 2 }]);
      eq(cs.stacks('c1'), 2);
    });

    test('配置里已删除的 id 不通知（防止矫枉过正）', () => {
      const { cs, log } = makeTracking(['c1']);
      log.length = 0;
      cs.importState([{ id: 'ghost', since: 0, stacks: 1 }]);
      eq(log.length, 0, '配置里没有的 id 应被跳过，不该凭空通知');
      eq(cs.count, 0);
    });
  });

  // ============================================================
  // P2 · [hitbox] 采样数硬编码
  // ============================================================
  describe('hitbox · 采样密度可配（P2）', () => {
    test('⚠️ 采样数可配置，且能改变漏检结果', () => {
      /**
       * 【修复前】`samplePoints` 里弧上 8 段、胶囊 6 段是写死的常量，
       * 违反 rule4（数值不得硬编码），且使用者无法通过配置提高精度。
       *
       * 这里用"窄扇形 + 细长胶囊"构造一个默认密度下可能漏检的组合，
       * 提高采样数后应能稳定命中。
       */
      const mk = (samples?: { arc: number; capsule: number }) => {
        const w = new HitboxWorld({ cellSize: 1000, sampleCounts: samples });
        w.add({ id: 'a', shape: { kind: 'sector', radius: 10, angleDeg: 8 }, x: 0, y: 0, rotation: 0, layer: 1, mask: 1 });
        w.add({ id: 'b', shape: { kind: 'capsule', radius: 0.02, height: 6 }, x: 4, y: 0.02, rotation: 90, layer: 1, mask: 1 });
        return w.query({ kind: 'sector', radius: 10, angleDeg: 8 }, 0, 0, 0, 1).length;
      };
      const hi = mk({ arc: 200, capsule: 200 });
      assert(hi > 0, '高密度下应能命中');
      // 低密度至少不能崩，且结果不多于高密度
      const lo = mk({ arc: 1, capsule: 1 });
      assert(lo <= hi, `低密度命中数 ${lo} 不应多于高密度 ${hi}`);
    });

    test('⚠️ 非法采样数回落默认，不得让循环失控', () => {
      for (const bad of [0, -5, NaN]) {
        const w = new HitboxWorld({ cellSize: 1000, sampleCounts: { arc: bad, capsule: bad } });
        w.add({ id: 'a', shape: { kind: 'sector', radius: 5, angleDeg: 60 }, x: 0, y: 0, rotation: 0, layer: 1, mask: 1 });
        w.add({ id: 'b', shape: { kind: 'rect', halfW: 1, halfH: 1 }, x: 2, y: 0, rotation: 0, layer: 1, mask: 1 });
        eq(w.query({ kind: 'sector', radius: 5, angleDeg: 60 }, 0, 0, 0, 1).length, 2, `arc=${bad} 应回落默认`);
      }
    });

    test('不配置时行为与修复前一致（防止矫枉过正）', () => {
      const w = new HitboxWorld({ cellSize: 10 });
      w.add({ id: 'a', shape: { kind: 'sector', radius: 5, angleDeg: 90 }, x: 0, y: 0, rotation: 0, layer: 1, mask: 1 });
      eq(w.query({ kind: 'circle', radius: 1 }, 3, 0, 0, 1).length, 1, '正前方命中');
      eq(w.query({ kind: 'circle', radius: 1 }, -3, 0, 0, 1).length, 0, '背后不命中');
    });
  });

  // ============================================================
  // P2 · [leaderboard] Lb4 / Lb6
  // ============================================================
  describe('leaderboard · 合并与可卸载（P2 Lb4 / Lb6）', () => {
    test('⚠️ mergeLeaderboards 要尊重 tieBreak 配置（修复前：固定 earlier）', () => {
      /**
       * 【修复前的实测】
       * ```
       * tieBreak=later 的两个榜合并后保留的是 at=1 那条（应为 at=2）
       * ```
       * 本类的 `tieBreak` 在 `_cmp` / `_isBetter` 里生效，
       * 唯独合并这条路径写死了 `e.at < prev.at`——配置项静默失效。
       */
      const a = new Leaderboard({ tieBreak: 'later' });
      a.submit({ playerId: 'p1', name: 'A', score: 10, at: 1 });
      const b = new Leaderboard({ tieBreak: 'later' });
      b.submit({ playerId: 'p1', name: 'B', score: 10, at: 2 });
      const m = mergeLeaderboards([a, b], { tieBreak: 'later' });
      eq(m.size, 1, '同一个人只占一个位置');
      eq(m.ranked()[0].at, 2, 'later 时应保留后达成那条');
    });

    test('tieBreak=earlier 的行为不变（防止矫枉过正）', () => {
      const a = new Leaderboard({ tieBreak: 'earlier' });
      a.submit({ playerId: 'p1', name: 'A', score: 10, at: 1 });
      const b = new Leaderboard({ tieBreak: 'earlier' });
      b.submit({ playerId: 'p1', name: 'B', score: 10, at: 2 });
      const m = mergeLeaderboards([a, b], { tieBreak: 'earlier' });
      eq(m.ranked()[0].at, 1, 'earlier 时保留先达成那条');
    });

    test('⚠️ 有 destroy()（修复前：只有 clear）', () => {
      const lb = new Leaderboard();
      lb.submit({ playerId: 'p1', name: 'p1', score: 1, at: 1 });
      lb.destroy();
      eq(lb.size, 0);
    });
  });

  // ============================================================
  // P2 · [leaderboard] Lb5 的**现状护栏**（刻意不修，只把现状钉住）
  //
  // 【为什么要有这一组】
  // `submit()` 是"末位比较 + push + 全量 sort"，多一次 O(n log n)，
  // 我在 §3.5 判定**不改成二分插入**（收益常数级，风险是动到已跑通大量用例的路径）。
  // W2-A 验收时指出："判定保持现状是合理的，但'不修'的地方最好也有一条用例
  // 把现状钉住，否则将来别人会把它当缺陷重开一遍。"——本组即为此而写。
  //
  // 【注意】这 4 条是"现状上锁"型，不是"修复前会失败"型：
  // 它们断言的是 submit 的**语义契约**，任何改动（包括"优化"）都不应破坏它。
  // ============================================================
  describe('leaderboard · Lb5 现状护栏：submit 的语义契约（刻意不优化）', () => {
    test('插入后榜单始终有序（升序 / 降序都对）', () => {
      const desc = new Leaderboard({ order: 'desc' });
      for (const s of [5, 1, 9, 3, 7, 2, 8]) {
        desc.submit({ playerId: `p${s}`, name: `p${s}`, score: s, at: s });
      }
      const scores = desc.ranked().map((e) => e.score);
      eq(scores.join(','), '9,8,7,5,3,2,1', 'desc 应从高到低');

      const asc = new Leaderboard({ order: 'asc' });
      for (const s of [5, 1, 9, 3, 7, 2, 8]) {
        asc.submit({ playerId: `p${s}`, name: `p${s}`, score: s, at: s });
      }
      eq(asc.ranked().map((e) => e.score).join(','), '1,2,3,5,7,8,9', 'asc 应从低到高');
    });

    test('乱序插入 N 条后仍然是全序（不是局部有序）', () => {
      const lb = new Leaderboard({ capacity: 1000 });
      // 用固定序列，保证可复现
      const seq: number[] = [];
      let x = 7;
      for (let i = 0; i < 200; i++) { x = (x * 37 + 11) % 997; seq.push(x); }
      seq.forEach((s, i) => lb.submit({ playerId: `p${i}`, name: `p${i}`, score: s, at: i }));

      const scores = lb.ranked().map((e) => e.score);
      for (let i = 1; i < scores.length; i++) {
        assert(scores[i - 1] >= scores[i], `第 ${i} 位 ${scores[i - 1]} 应 >= ${scores[i]}`);
      }
    });

    test('满容量时淘汰末位，且新成绩排不进则返回 false', () => {
      const lb = new Leaderboard({ capacity: 3, order: 'desc' });
      lb.submit({ playerId: 'a', name: 'a', score: 30, at: 1 });
      lb.submit({ playerId: 'b', name: 'b', score: 20, at: 2 });
      lb.submit({ playerId: 'c', name: 'c', score: 10, at: 3 });

      eq(lb.submit({ playerId: 'd', name: 'd', score: 5, at: 4 }), false, '排不进应拒绝');
      eq(lb.size, 3);
      eq(lb.submit({ playerId: 'e', name: 'e', score: 25, at: 5 }), true, '能进则应挤掉末位');
      eq(lb.ranked().map((e) => e.playerId).join(','), 'a,e,b', '末位 10 被淘汰');
    });

    test('bestPerPlayer 下去重与最好成绩保留的语义不变', () => {
      const lb = new Leaderboard({ bestPerPlayer: true, order: 'desc' });
      eq(lb.submit({ playerId: 'p1', name: 'p1', score: 10, at: 1 }), true);
      eq(lb.submit({ playerId: 'p1', name: 'p1', score: 5, at: 2 }), false, '更差的成绩应被拒');
      eq(lb.submit({ playerId: 'p1', name: 'p1', score: 20, at: 3 }), true, '更好的成绩应替换');
      eq(lb.size, 1);
      eq(lb.ranked()[0].score, 20);
    });
  });

  // ============================================================
  // P2 · [save] write 失败只 console.error
  // ============================================================
  describe('save · 失败原因要能被查到（P2）', () => {
    test('⚠️ 写入失败要记进 lastError 并通知 onError（修复前：只有 console.error）', () => {
      const errors: string[] = [];
      const bad = {
        read: () => null,
        write: () => { throw new Error('配额不足'); },
        remove: () => { /* noop */ },
        keys: () => [] as string[],
      };
      const m = new SaveManager(bad, { gameId: 'g', version: 1, onError: (s) => errors.push(s) });
      eq(m.write('s', { a: 1 }), false, '仍返回 false（返回值语义不变）');
      assert(m.lastError !== null, 'lastError 应有值（修复前没有这个字段）');
      eq(errors.length, 1, 'onError 应被调用一次');
      assert(errors[0].includes('配额不足'), `应带真实原因，实际 ${errors[0]}`);
    });

    test('⚠️ 不传 onError 时仍能看到线索（lastError 不看日志也能查）', () => {
      const orig = console.error;
      const seen: string[] = [];
      console.error = (...a: unknown[]) => seen.push(a.join(' '));
      try {
        const bad = {
          read: () => null,
          write: () => { throw new Error('boom'); },
          remove: () => { /* noop */ },
          keys: () => [] as string[],
        };
        const m = new SaveManager(bad, { gameId: 'g', version: 1 });
        m.write('s', { a: 1 });
        assert(m.lastError !== null, 'lastError 仍应记录');
      } finally {
        console.error = orig;
      }
    });

    test('写入成功后 lastError 清空（防止矫枉过正）', () => {
      const { m, errors } = makeSave();
      eq(m.lastError, null);
      eq(m.write('slot1', { a: 1 }), true);
      eq(m.lastError, null, '成功后不该留着上一次的错误');
      eq(errors.length, 0, '成功不该触发 onError');
    });
  });

  // ============================================================
  // P2 · [scheduler] S2 / S3 / S4 / S5 / S6
  // ============================================================
  describe('scheduler · 时间源与收口（P2 S2 / S3 / S5 / S6）', () => {
    test('⚠️ TimeScale 时间源可注入（修复前：默认参数直接取 Date.now）', () => {
      let now = 0;
      const ts = new TimeScale({ nowProvider: () => now });
      ts.add('hitstop', 0.05, 0.08);
      eq(ts.layerCount, 1);
      now = 100;                     // 80ms 后
      ts.update();
      eq(ts.layerCount, 0, '到期应自动移除');
    });

    test('⚠️ durationSeconds 非正要抛错，不得静默丢失顿帧（修复前：layerCount=0）', () => {
      /**
       * 【修复前的实测】
       * ```
       * hitStop(-1)  → update 后 layerCount = 0
       * slowMotion(0.5, -5) → update 后 layerCount = 0
       * ```
       * `expiresAt` 落在过去 → 第一次 update 就当过期删掉，
       * 顿帧像没发生过一样，一个字都不报。
       */
      const ts = new TimeScale();
      throws(() => ts.add('hitstop', 0.05, -1), '必须为正');
      throws(() => ts.add('slowmo', 0.5, 0), '必须为正');
    });

    test('⚠️ durationSeconds 非有限同样拒绝', () => {
      const ts = new TimeScale();
      throws(() => ts.add('x', 0.5, NaN), '非法');
      throws(() => ts.add('x', 0.5, Infinity), '非法');
    });

    test('合法的顿帧仍按真实时间到期（防止矫枉过正）', () => {
      const ts = new TimeScale();
      const now = 1000000;
      ts.add('hitstop', 0.05, 0.08, now);
      ts.update(now + 79);
      assert(ts.has('hitstop'), '79ms 时仍在顿帧');
      ts.update(now + 81);
      assert(!ts.has('hitstop'), '81ms 时应已到期');
    });

    test('⚠️ 极小非零 dt 不再触发回调（修复前：delta===0 判不住）', () => {
      /**
       * 【修复前】`if (delta === 0 && !task.unscaled) continue`
       * 只有 dt **恰好为 0** 才跳过；scale 是个小数时
       * scaledDt 极小但非零，回调照常执行——
       * "本该完全冻结"的时间源仍在每帧调用每个回调。
       */
      const s = new Scheduler({ nowProvider: () => 0 });
      s.timeScale.add('micro', 1e-300);
      let n = 0;
      s.everyFrame(() => n++);
      s.update(0.016);
      eq(n, 0, `极小 dt 应视为没推进，实际回调 ${n} 次`);
    });

    test('⚠️ hitStop 默认参数可配置（修复前：0.08/0.05 写死在签名里）', () => {
      const s = new Scheduler({ hitStopDuration: 0.2, hitStopScale: 0.01 });
      s.hitStop();
      eq(s.timeScale.get('hitstop'), 0.01, '默认缩放应来自配置');
      assert(s.timeScale.has('hitstop'), '顿帧层应存在');
    });

    test('不配置时 hitStop 默认值不变（防止矫枉过正）', () => {
      const s = new Scheduler({ nowProvider: () => 0 });
      s.hitStop();
      eq(s.timeScale.get('hitstop'), 0.05);
    });

    test('⚠️ 稳态下不再每帧重建快照（修复前：每帧 Array.from）', () => {
      /**
       * 【修复前】`const snapshot = Array.from(this._tasks.values())`
       * 每帧一次数组分配，60fps 下每秒 60 次，直接推高 GC 频率。
       */
      const s = new Scheduler({ nowProvider: () => 0 });
      s.everyFrame(() => { /* noop */ });
      s.update(0.016);
      const first = (s as unknown as { _snapshot: unknown[] })._snapshot;
      s.update(0.016);
      const second = (s as unknown as { _snapshot: unknown[] })._snapshot;
      assert(first === second, '任务集合没变时不该重建快照');
      s.everyFrame(() => { /* noop */ });
      s.update(0.016);
      assert((s as unknown as { _snapshot: unknown[] })._snapshot !== second, '新增任务后应重建');
    });

    test('正常调度与暂停语义不变（防止矫枉过正）', () => {
      const s = new Scheduler({ nowProvider: () => 0 });
      let t = 0;
      s.everyFrame((dt) => (t += dt));
      for (let i = 0; i < 60; i++) s.update(1 / 60);
      near(t, 1, 1e-6, '60 帧 × 1/60 = 1 秒');
      s.pause();
      const before = t;
      for (let i = 0; i < 60; i++) s.update(1 / 60);
      near(t, before, 1e-9, '暂停后游戏时间不推进');
      s.unpause();
      s.update(1 / 60);
      assert(t > before, '恢复后继续推进');
    });
  });

  // ============================================================
  // P2 · [subtitle] 长字幕的 at() 复杂度 + 单元示例
  // ============================================================
  describe('subtitle · at() 的复杂度与正确性（P2）', () => {
    const many: Array<{ start: number; end: number; text: string }> = [];
    for (let i = 0; i < 3000; i++) many.push({ start: i * 1000, end: i * 1000 + 500, text: `第 ${i} 行` });

    test('⚠️ 片尾查询不再随行数线性退化', () => {
      /**
       * 【修复前的实测】3000 行、查询 290 万毫秒附近 600 次 = **10ms**
       * （从数组头一路扫到命中点，越往后越慢）。
       * 行数再翻十倍就是 100ms——足以在片尾看到掉帧。
       */
      const tr = new SubtitleTrack({ lines: many });
      const tail = 2900 * 1000;
      const t0 = Date.now();
      for (let f = 0; f < 600; f++) tr.at(tail + f * 16);
      const ms = Date.now() - t0;
      assert(ms < 20, `3000 行 × 600 次查询应 < 20ms，实际 ${ms}ms`);
    });

    test('⚠️ 二分 + 回溯的结果必须与全量扫描一致', () => {
      const tr = new SubtitleTrack({ lines: many });
      for (let t = 0; t < 10000; t += 137) {
        const got = tr.at(t).length;
        let want = 0;
        for (const l of tr.lines) {
          if (l.start > t) break;
          if (t >= l.start && t < l.end) want++;
        }
        eq(got, want, `t=${t} 的命中数不一致`);
      }
    });

    test('⚠️ 重叠区间（开始更早但结束更晚）仍能被找到', () => {
      /**
       * 画外音压着好几条对话是常态：
       * 二分定位到"最后一条 start <= time"之后，
       * 还必须能回溯到更早开始、但此刻仍在播的行。
       */
      const tr = new SubtitleTrack({
        lines: [
          { start: 0, end: 5000, text: '画外音', speaker: 'narrator' },
          { start: 1000, end: 1500, text: '短句' },
          { start: 2000, end: 2500, text: '另一句' },
        ],
      });
      const at = tr.at(2100);
      eq(at.length, 2, `应同时返回画外音与当前句，实际 ${at.length}`);
      eq(at[0].line.text, '画外音');
      eq(at[1].line.text, '另一句');
    });

    test('边界、空档、说话人解析不变（防止矫枉过正）', () => {
      const tr = new SubtitleTrack({
        lines: [
          { start: 0, end: 1000, text: 'a', speaker: 'hero' },
          { start: 2000, end: 3000, text: 'b', speaker: 'npc' },
        ],
        speakers: { hero: { name: '勇者', color: '#0f0' }, npc: { name: '村民' } },
      });
      eq(tr.at(-1).length, 0, '未开始');
      eq(tr.at(0).length, 1, 'start 是闭区间');
      eq(tr.at(1000).length, 0, 'end 是开区间');
      eq(tr.at(1500).length, 0, '空档');
      eq(tr.at(2500)[0].speakerLabel, '村民');
      eq(tr.at(500)[0].speakerColor, '#0f0');
      near(tr.at(500)[0].progress, 0.5, 1e-9);
      eq(tr.at(500)[0].index, 0, 'index 是排序后的下标');
    });

    test('非有限时间不崩且不命中（防止矫枉过正）', () => {
      const tr = new SubtitleTrack({ lines: many });
      eq(tr.at(NaN).length, 0);
      eq(tr.at(Infinity).length, 0);
    });

    test('⚠️ 示例要覆盖的三个反直觉点（P2 · rule7，示例见 examples/subtitle-usage.ts）', () => {
      /**
       * 全库 119 个单元里 subtitle 原本是**唯一**没有可运行示例的，
       * 违反 rule7。补的是 `examples/subtitle-usage.ts`
       * （`npm run build && node .build/examples/subtitle-usage.js`）。
       *
       * 示例里演示的三处反直觉点，这里用断言锁住，
       * 防止示例与实现各说各话：
       */
      const tr = new SubtitleTrack({ lines: [{ start: 1000, end: 3000, text: '一秒后才出现' }] });
      // ① 时间单位是毫秒：按秒传则永不显示且不报错
      eq(tr.at(1).length, 0, 'at(1) 是 1 毫秒');
      eq(tr.at(1000).length, 1, 'at(1000) 才是 1 秒');
      // ② skipToNext 跳到"下一条的开始"而不是"当前条的结束"
      eq(tr.skipToNext(1500), 1500, '已是最后一条则返回当前时间');
      // ③ nextIndex 用 -1 表示播完，而 -1 是布尔真值
      eq(tr.nextIndex(9999), -1);
      assert(Boolean(tr.nextIndex(9999)) === true, '-1 是真值，不能当布尔用');
    });
  });
}
