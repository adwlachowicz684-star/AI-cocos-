/**
 * tests/run_phase10_w7a.ts —— 第二次精审 P1/P2 回归 · 窗口 W7-A
 *
 * 【本窗口的四个单元】dash / grid / objective / progressbar
 *
 * 【每条修复三条用例的约定】
 * 1. 复现用例：修复前**确实会失败**（每条下面写了修复前的实测输出）
 * 2. 对照用例：正常输入不受影响（防止矫枉过正）
 * 3. 需要总审裁决的，写在 `audit/result_W7-A.md` 里，不在这里拍板
 *
 * 【为什么每个 test 里都重复 new 一个对象】
 * 这些单元都持有状态（充能、格子、进度），跨用例复用会让
 * "失败原因"变成"上一个用例污染了这个对象"——排查成本远高于多 new 一次。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { DashController } from '../dash/DashController';
import {
  Grid,
  GridPlacement,
  hexRing,
  hexSpiral,
  hexToPixel,
  pixelToHex,
} from '../grid/Grid';
import { ObjectiveSystem, Objectives } from '../objective/ObjectiveSystem';
import { ProgressBar } from '../progressbar/ProgressBar';

/** 把冲刺跑到结束（防死循环） */
function runDash(d: DashController, dt = 1 / 60, maxFrames = 1000): number {
  let guard = 0;
  let moved = 0;
  while (d.active && guard++ < maxFrames) {
    d.tick(dt);
    moved += Math.abs(d.deltaX);
  }
  return moved;
}

export function runPhase10W7ATests(): void {
  // ============================================================
  // P1-1 · dash 多层充能永远回不满
  // ============================================================
  describe('dash · 多层充能的冷却启动时机（P1-1）', () => {
    test('⚠️ 用掉一层后第二层要能恢复（修复前：等 5 秒仍是 1 层）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P1-1] 用掉1层后 chargesLeft=1 cdLeft=0
       * [P1-1] 等 5 秒后 chargesLeft=1（期望 2）
       * ```
       * 根因：旧代码只有 `charges <= 0` 才设冷却，
       * 剩 1 层时 `_cdLeft` 恒为 0，`tick` 里 `if (_cdLeft > 0)` 的恢复分支永不执行。
       */
      const d = new DashController({ duration: 0.05, cooldown: 0.5, charges: 2 });
      assert(d.tryStart(1, 0, 0, 0, 0), '第一层应可用');
      runDash(d);
      eq(d.chargesLeft, 1, '此时还剩 1 层');
      assert(d.cooldownLeft > 0, '用掉一层就该启动冷却（旧实现这里是 0）');

      for (let i = 0; i < 300; i++) d.tick(1 / 60);   // 5 秒，远超 cooldown 0.5s
      eq(d.chargesLeft, 2, '冷却跑完后应回满 2 层');
    });

    test('⚠️ 连冲两层时第二层不把冷却重置回满（防止矫枉过正）', () => {
      const d = new DashController({ duration: 0.05, cooldown: 0.5, charges: 2 });
      d.tryStart(1, 0, 0, 0, 0);
      runDash(d);
      const cdAfterFirst = d.cooldownLeft;
      assert(cdAfterFirst > 0 && cdAfterFirst < 0.5, `第一层后冷却应在 (0, 0.5)，实际 ${cdAfterFirst}`);

      assert(d.tryStart(1, 0, 0, 0, 0), '第二层应可用');
      assert(
        d.cooldownLeft <= cdAfterFirst + 1e-9,
        `第二层只能续冷却、不能重置：${cdAfterFirst} → ${d.cooldownLeft}`,
      );
      eq(d.chargesLeft, 0, '两层都用掉了');
    });

    test('单层充能行为不变（防止矫枉过正）', () => {
      const d = new DashController({ duration: 0.05, cooldown: 0.5, charges: 1 });
      assert(d.tryStart(1, 0, 0, 0, 0));
      runDash(d);
      eq(d.chargesLeft, 0, '用完后为 0');
      assert(!d.tryStart(1, 0, 0, 0, 0), '冷却期间应拒绝');
      for (let i = 0; i < 40; i++) d.tick(1 / 60);    // 0.67s > 0.5s
      eq(d.chargesLeft, 1, '冷却结束后恢复');
    });
  });

  // ============================================================
  // P1-2 · dash duration / distance 未收口 → 坐标永久 NaN
  // ============================================================
  describe('dash · duration / distance 的有限性收口（P1-2）', () => {
    test('⚠️ duration = NaN 不得产出 NaN 位移（修复前：deltaX = NaN）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P1-2] duration=NaN → deltaX=NaN deltaY=NaN
       * ```
       * `?? 0.22` 挡不住 NaN → `clamp(_t / NaN, 0, 1)` 返回 NaN → 位移 NaN。
       */
      const d = new DashController({ duration: NaN, distance: 4, cooldown: 0 });
      d.tryStart(1, 0, 0, 0, 0);
      d.tick(1 / 60);
      assert(
        Number.isFinite(d.deltaX) && Number.isFinite(d.deltaY),
        `位移必须是有限数，实际 (${d.deltaX}, ${d.deltaY})`,
      );
    });

    test('⚠️ distance = NaN 不得产出 NaN 位移（修复前：deltaX = NaN）', () => {
      const d = new DashController({ duration: 0.22, distance: NaN, cooldown: 0 });
      d.tryStart(1, 0, 0, 0, 0);
      d.tick(1 / 60);
      assert(Number.isFinite(d.deltaX) && Number.isFinite(d.deltaY), '位移必须是有限数');
    });

    test('⚠️ duration 为 0 / 负数同样收口（否定式守卫）', () => {
      for (const bad of [0, -1, Infinity]) {
        const d = new DashController({ duration: bad, distance: 4, cooldown: 0 });
        d.tryStart(1, 0, 0, 0, 0);
        d.tick(1 / 60);
        assert(
          Number.isFinite(d.deltaX),
          `duration=${bad} 时位移应为有限数，实际 ${d.deltaX}`,
        );
      }
    });

    test('正常配置的位移总量与曲线不变（防止矫枉过正）', () => {
      const d = new DashController({ distance: 4, duration: 0.25, cooldown: 0, falloff: 2 });
      d.tryStart(1, 0, 0, 0, 0);
      let x = 0;
      let guard = 0;
      while (d.active && guard++ < 1000) {
        d.tick(1 / 60);
        x += d.deltaX;
      }
      near(x, 4, 1e-6, '总位移应精确等于 distance');
    });
  });

  // ============================================================
  // P1-3 · grid NaN 坐标能"放置成功"成为幽灵建筑
  // ============================================================
  describe('grid · NaN 坐标的放置校验（P1-3）', () => {
    test('⚠️ canPlace(NaN) 必须拒绝（修复前：返回 true）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P1-3] canPlace('h', NaN, 3)=true（期望 false）
       * [P1-3] place 返回=h#1，placedCount=1
       * [P1-3] 全图扫描占用格数=0，freeCount=100
       * ```
       * `_cells[NaN]` 是数组的 "NaN" 字符串属性，不进 length、不参与遍历。
       */
      const p = new GridPlacement(10, 10);
      p.define({ id: 'h', w: 2, h: 2 });
      assert(!p.canPlace('h', NaN, 3), 'NaN 坐标必须拒绝');
      assert(!p.canPlace('h', 3, NaN), 'NaN 坐标必须拒绝');
      eq(p.place('h', NaN, 3), null, 'place 应返回 null');
      eq(p.placedCount, 0, '不应记入已放置');
      eq(p.freeCount, 100, '幽灵建筑不该留下痕迹');
    });

    test('⚠️ Infinity 坐标同样拒绝', () => {
      const p = new GridPlacement(10, 10);
      p.define({ id: 'h', w: 1, h: 1 });
      assert(!p.canPlace('h', Infinity, 0), 'Infinity 应拒绝');
      assert(!p.canPlace('h', 0, -Infinity), '-Infinity 应拒绝');
    });

    test('正常放置 / 拆除 / 移动回滚时 freeCount 精确（防止矫枉过正）', () => {
      const p = new GridPlacement(10, 10);
      p.define({ id: 'h', w: 2, h: 2 });
      p.define({ id: 'r', w: 1, h: 1 });

      const id = p.place('h', 0, 0);
      assert(id !== null);
      eq(p.freeCount, 96, '2×2 占 4 格');

      assert(p.move(id!, 5, 5), '移动到空地应成功');
      eq(p.freeCount, 96, '移动不改变占用格数');

      // 用另一个建筑占住 (0,0)，再让 h 移过去 —— 应失败并回滚
      const rid = p.place('r', 0, 0);
      assert(rid !== null, '占住 (0,0)');
      eq(p.freeCount, 95);
      assert(!p.move(id!, 0, 0), '移到已被占用的位置应失败');
      eq(p.freeCount, 95, '失败回滚后占用格数不变（原位仍占着）');
      eq(p.at(5, 5), id, '原位未被清掉');
      p.remove(rid!);
      eq(p.freeCount, 96);

      assert(p.remove(id!), '拆除应成功');
      eq(p.freeCount, 100, '拆除后全空');

      p.place('r', 1, 1);
      eq(p.freeCount, 99);
      p.clear();
      eq(p.freeCount, 100, 'clear 后全空');
    });
  });

  // ============================================================
  // P1-4 · grid find 文档示例签名错误
  // ============================================================
  describe('grid · find 回调签名与文档一致（P1-4）', () => {
    test('⚠️ 按文档写法 (c) => c.value 会静默返回空（已改文档，实现保留）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P1-4] 照文档写 c.value==='树' → 0 条；按实现 v==='树' → 1 条
       * ```
       * 文档示例写 `c.value === '树'`，但回调第一个参数是**值本身**。
       * 改文档而不是改实现（改实现会破坏所有现存调用方，属 breaking）。
       */
      const g = new Grid<string>(10, 8);
      g.set(3, 4, '树');

      // 真实签名：第一个参数就是值
      const got = g.find((v) => v === '树');
      eq(got.length, 1, '按实现签名应命中 1 条');
      eq(got[0].value, '树');
      eq(got[0].x, 3);
      eq(got[0].y, 4);

      // 文档里的旧写法之所以是 0 条：字符串没有 .value 字段
      const wrong = g.find(((c: unknown) => (c as { value?: string }).value === '树') as never);
      eq(wrong.length, 0, '旧文档写法恒为 0 条——这就是"静默返回空"');
    });

    test('find 的第二个/第三个参数是坐标（防止矫枉过正）', () => {
      const g = new Grid<string>(3, 3);
      g.set(2, 1, 'x');
      const got = g.find((v, x, y) => v === 'x' && x === 2 && y === 1);
      eq(got.length, 1);
    });
  });

  // ============================================================
  // P2 · dash：死状态 recovery / canCancel 冗余 / falloff = -1
  // ============================================================
  describe('dash · 状态机与衰减指数（P2）', () => {
    test('⚠️ 冲刺全程不出现 recovery（类型里声明了但从未赋值）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P2-dash] 出现过状态=dashing（DashState 声明了 recovery）
       * ```
       * 状态机图曾画 `dashing → recovery → idle`，实现里冲刺结束直接回 idle。
       * 已在 DashState / 类注释上标注为**预留状态**，补实现会改变
       * `state === 'idle'` 的全部调用方语义（breaking，且恢复期时长无配置出处）。
       */
      const d = new DashController({ duration: 0.2, cooldown: 0 });
      const seen = new Set<string>();
      d.tryStart(1, 0, 0, 0, 0);
      let guard = 0;
      while (d.active && guard++ < 500) {
        seen.add(d.state);
        d.tick(1 / 60);
      }
      seen.add(d.state);
      assert(!seen.has('recovery'), `不应出现 recovery，实际出现：${[...seen].join(',')}`);
      eq(d.state, 'idle', '冲刺结束后应立刻回到 idle');
    });

    test('⚠️ falloff = -1 时不得退化成"单帧瞬移"', () => {
      /**
       * 内部 p = falloff + 1。`falloff = -1` → p = 0 → `s(u) ≡ 0`，
       * 中前段的分段位移全为 0，位移全部堆到末段/收尾帧。
       *
       * 【措辞口径（W7-B 交叉验收时指出）】
       * 这里**不是**"总位移恒 0"——总位移仍精确等于 distance，
       * 因为收尾分支会一次性补齐。实际现象是**曲线退化成瞬移**，
       * 衰减手感、无敌帧节奏、残影间隔全部失效，但数值上"距离是对的"。
       * 按"位移恒 0"去修会改错地方（`_progressAt(1) || 1` 那个兜底
       * 在 endBrake > 0 时根本不会触发）。
       *
       * 所以这里断言的是**首帧**就有位移——首帧为 0 正是"瞬移"的判据。
       */
      const d = new DashController({ distance: 4, duration: 0.2, cooldown: 0, falloff: -1 });
      d.tryStart(1, 0, 0, 0, 0);
      d.tick(1 / 60);
      assert(d.deltaX > 0, `falloff=-1 时首帧也应有位移，实际 ${d.deltaX}`);
    });

    test('falloff = 0（匀速）仍是合法语义（防止矫枉过正）', () => {
      const d = new DashController({ distance: 4, duration: 0.2, cooldown: 0, falloff: 0 });
      d.tryStart(1, 0, 0, 0, 0);
      const x = runDash(d);
      near(x, 4, 1e-6, '匀速时总位移仍是 distance');
    });

    test('canCancel 与 ready 同源（防止两份实现日后分叉）', () => {
      const d = new DashController({ duration: 0.2, cooldown: 0.5 });
      assert(d.canCancel() === d.ready, '空闲时应同义');
      d.tryStart(1, 0, 0, 0, 0);
      assert(d.canCancel() === d.ready, '冲刺中应同义（都为 false）');
      runDash(d);
      assert(d.canCancel() === d.ready, '冷却中应同义（都为 false）');
    });
  });

  // ============================================================
  // P2 · grid：hexRing 注释 / freeCount 复杂度 / size = 0
  // ============================================================
  describe('grid · 六边形与计数（P2）', () => {
    test('⚠️ hexRing 是"环"不含中心（注释曾写"含中心"）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P2-grid] hexRing(center,1).length=6
       * [P2-grid] hexSpiral(center,1).length=7
       * ```
       * 注释写"半径 n 内的所有格子（含中心）"是错的，
       * 照注释写范围预览会漏掉中心格——而中心往往正是技能落点。
       */
      const c = { q: 0, r: 0 };
      eq(hexRing(c, 1).length, 6, '半径 1 的环 = 6 格');
      eq(hexSpiral(c, 1).length, 7, '半径 1 的实心 = 7 格（含中心）');
      assert(
        !hexRing(c, 1).some((h) => h.q === 0 && h.r === 0),
        'hexRing 不应包含中心',
      );
      assert(
        hexSpiral(c, 1).some((h) => h.q === 0 && h.r === 0),
        'hexSpiral 应包含中心',
      );
      eq(hexRing(c, 2).length, 12, '半径 2 的环 = 12 格');
    });

    test('⚠️ size = 0 的像素互转不得产出 NaN / Infinity', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P2-grid] pixelToHex(25,-8,0)={"q":null,"r":null}   // 实际是 ±Infinity
       * ```
       * `pixelToHex` 除以 size → Infinity → `Math.round(Infinity)` → Infinity，
       * 再传给 `hexDistance` 得到 Infinity，比较恒真/恒假，一路传染下去。
       *
       * 【⚠️ 两个函数的失效形态不一样（W7-B 交叉验收时指出）】
       * - `pixelToHex` 是**除零** → ±Infinity，这条用例能直接抓到
       * - `hexToPixel` 是**乘法**：`0 * √3 * (...)` = 0，**不会得到 NaN**
       *   （只有 `q`/`r` 本身是 Infinity 时才会得到 NaN）
       *
       * 所以"两个函数都加 size 正性校验"这个修法里，
       * `hexToPixel` 那半是**把"碰巧正确"变成"显式保证"**——
       * 真正会出错的是下面那条负数用例，不是这条 size=0 的。
       */
      const px = hexToPixel({ q: 2, r: -1 }, 0);
      assert(Number.isFinite(px.x) && Number.isFinite(px.y), `hexToPixel 应有限，实际 ${JSON.stringify(px)}`);

      const hx = pixelToHex(25, -8, 0);
      assert(Number.isFinite(hx.q) && Number.isFinite(hx.r), `pixelToHex 应有限，实际 ${JSON.stringify(hx)}`);
    });

    test('⚠️ size 为负数时不得产出镜像坐标（hexToPixel 守卫的真正价值）', () => {
      /**
       * 【这条才是 `hexToPixel` 那道守卫真正挡住的东西】
       * size = 0 时 `0 * x === 0` 碰巧给出原点，删掉守卫测试也照样过；
       * 但 size < 0 时乘法不会归零，而是把整个六边形网格**镜像翻转**：
       * `hexToPixel({q:2,r:-1}, -10)` 会得到 `{x: -25.98, y: 15}`（正常值的相反数）。
       *
       * 这种"图能画出来、位置全反了"的错误，比 NaN 更难查——
       * 因为没有任何一个值是异常的。
       */
      const px = hexToPixel({ q: 2, r: -1 }, -10);
      eq(px.x, 0, '负 size 应落回原点，而不是产出镜像坐标');
      eq(px.y, 0);

      const hx = pixelToHex(25, -8, -10);
      eq(hx.q, 0, 'pixelToHex 同样：负 size 落回原点格');
      eq(hx.r, 0);
    });

    test('正常 size 的像素互转可以往返（防止矫枉过正）', () => {
      const src = { q: 2, r: -1 };
      const px = hexToPixel(src, 10);
      const back = pixelToHex(px.x, px.y, 10);
      eq(back.q, src.q, 'q 应还原');
      eq(back.r, src.r, 'r 应还原');
    });

    test('⚠️ freeCount 在反复读写后仍精确（改为增量维护）', () => {
      /**
       * 原 getter 每次 O(n) 全扫：50×50 网格读 2000 次约 8ms，
       * 建造类 UI 每帧刷新"剩余空间"时就是实打实的帧时间。
       * 改为增量维护后，风险从"慢"变成"算错"——所以这里覆盖全部写入/清除出口。
       */
      const p = new GridPlacement(20, 20);
      p.define({ id: 'a', w: 1, h: 1 });
      p.define({ id: 'b', w: 3, h: 2 });

      eq(p.freeCount, 400, '初始全空');
      const a = p.place('a', 0, 0)!;
      eq(p.freeCount, 399);
      const b = p.place('b', 5, 5)!;
      eq(p.freeCount, 393, '3×2 占 6 格');

      assert(!p.place('a', 5, 5), '重叠应失败');
      eq(p.freeCount, 393, '失败不占用');

      assert(p.remove(b), '拆除 b');
      eq(p.freeCount, 399);

      assert(p.move(a, 19, 19), '移动到角落');
      eq(p.freeCount, 399);

      // 再放一个 b 占住大块，然后让 a 移进 b 的范围 —— 应失败并回滚
      const b2 = p.place('b', 10, 10)!;
      eq(p.freeCount, 393);
      assert(!p.move(a, 10, 10), '移进被占区域应失败');
      eq(p.freeCount, 393, '回滚后计数不变');
      eq(p.at(19, 19), a, 'a 仍在原位');
      p.remove(b2);
      eq(p.freeCount, 399);

      p.destroy();
      eq(p.freeCount, 400, 'destroy 后全空');
    });
  });

  // ============================================================
  // P2 · objective：事件顺序
  // ============================================================
  describe('objective · 事件顺序（P2）', () => {
    test('⚠️ 完成后不得再补发同帧 progress（修复前：completed/10 | progress/10）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P2-obj] 事件序列=activated/0 | completed/10 | progress/10
       * ```
       * 订阅方（任务追踪 UI）收到 completed 后又收到 progress，
       * 会把"已完成"态覆盖回"进行中"，且与订阅注册顺序强耦合，极难复现。
       */
      const ev: string[] = [];
      const sys = new ObjectiveSystem({
        objectives: [Objectives.kill('k', 10)],
        onEvent: (e) => ev.push(`${e.type}/${e.progress}`),
      });
      sys.tick(0.016);
      sys.setProgress('k', 10);

      eq(ev.join(' | '), 'activated/0 | completed/10', '完成事件后不应再补 progress');
      eq(sys.status('k'), 'completed');
      assert(sys.finished, '应判定整体完成');
    });

    test('⚠️ 失败事件后同样不补 progress', () => {
      const ev: string[] = [];
      const sys = new ObjectiveSystem({
        objectives: [Objectives.protect('p', 5)],
        onEvent: (e) => ev.push(`${e.type}/${e.progress}`),
      });
      sys.tick(0.016);
      sys.setProgress('p', 0);
      assert(
        !ev.some((s) => s.startsWith('progress/')),
        `失败后不应有 progress 事件，实际 ${ev.join(' | ')}`,
      );
      assert(sys.failed, '应判定失败');
    });

    test('未完成的进度仍照常上报 progress（防止矫枉过正）', () => {
      const ev: string[] = [];
      const sys = new ObjectiveSystem({
        objectives: [Objectives.kill('k', 10)],
        onEvent: (e) => ev.push(`${e.type}/${e.progress}`),
      });
      sys.tick(0.016);
      sys.setProgress('k', 4);
      sys.setProgress('k', 7);
      eq(ev.join(' | '), 'activated/0 | progress/4 | progress/7', '进行中的进度必须上报');
    });
  });

  // ============================================================
  // P2 · objective：setProgress / addProgress 有限性
  // ============================================================
  describe('objective · 进度的有限性校验（P2）', () => {
    test('⚠️ setProgress(NaN) 必须被拒绝（修复前：progress = NaN 并上报事件）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P2-obj] setProgress(NaN) → status=active progress=NaN 事件=activated/0 | progress/NaN
       * ```
       * NaN 一旦进来：`progress >= target` 恒 false → 目标永远完不成；
       * `protect` 的 `progress <= 0` 也挡不住 NaN → 永远不失败。
       * 而 `NaN === value` 恒 false，下一次写入也无法纠正 → 永久卡死。
       */
      const ev: string[] = [];
      const sys = new ObjectiveSystem({
        objectives: [Objectives.kill('k', 10)],
        onEvent: (e) => ev.push(`${e.type}/${e.progress}`),
      });
      sys.tick(0.016);
      sys.setProgress('k', 3);
      sys.setProgress('k', NaN);
      eq(sys.progress('k'), 3, 'NaN 写入应被拒绝，保留上一次有效进度');
      assert(!ev.some((s) => s.includes('NaN')), `不应上报 NaN 事件：${ev.join(' | ')}`);
    });

    test('⚠️ addProgress(NaN) 不得污染已有进度（修复前：progress = NaN）', () => {
      const sys = new ObjectiveSystem({ objectives: [Objectives.kill('k', 10)] });
      sys.tick(0.016);
      sys.addProgress('k', 1);
      sys.addProgress('k', NaN);
      eq(sys.progress('k'), 1, 'NaN 增量应被忽略');
      sys.addProgress('k', 2);
      eq(sys.progress('k'), 3, '后续正常增量仍生效');
    });

    test('⚠️ protect 类的 NaN 同样拒绝（否则永远不失败）', () => {
      const sys = new ObjectiveSystem({ objectives: [Objectives.protect('p', 5)] });
      sys.tick(0.016);
      sys.setProgress('p', NaN);
      eq(sys.progress('p'), 5, '保护类进度应保持初始值');
      assert(!sys.failed, '不应因 NaN 触发失败');
      sys.setProgress('p', 0);
      assert(sys.failed, '真正掉到 0 才失败');
    });

    test('正常 setProgress / addProgress 行为不变（防止矫枉过正）', () => {
      const sys = new ObjectiveSystem({ objectives: [Objectives.kill('k', 10)] });
      sys.tick(0.016);
      sys.setProgress('k', 0);
      eq(sys.progress('k'), 0, '0 是合法进度（不是"非有限值"）');
      sys.addProgress('k', 10);
      eq(sys.status('k'), 'completed', '累加达标应完成');
    });
  });

  // ============================================================
  // P2 · objective：destroy / reset
  // ============================================================
  describe('objective · 可卸载与重置语义（P2）', () => {
    test('⚠️ destroy() 必须存在并断开三个外部回调（修复前：typeof destroy === undefined）', () => {
      /**
       * 铁律 5「可卸载」。本类持有 onEvent / onAllComplete / onFailed 三个回调，
       * 它们通常闭包引用着 UI 面板甚至场景节点；不断开就整棵 UI 树都释放不了。
       */
      const sys = new ObjectiveSystem({ objectives: [Objectives.kill('k', 10)] });
      let hits = 0;
      sys.onEvent = () => { hits++; };
      sys.onAllComplete = () => { hits++; };
      sys.onFailed = () => { hits++; };

      sys.destroy();
      eq(sys.onEvent, undefined, 'onEvent 应被断开');
      eq(sys.onAllComplete, undefined, 'onAllComplete 应被断开');
      eq(sys.onFailed, undefined, 'onFailed 应被断开');
      eq(sys.finished, false, 'destroy 应复位完成态');
      eq(sys.totalTime, 0, 'destroy 应复位计时');
    });

    test('⚠️ reset() 不触发任何 onEvent（已在 JSDoc 明确）', () => {
      const ev: string[] = [];
      const sys = new ObjectiveSystem({
        objectives: [Objectives.kill('k', 10)],
        onEvent: (e) => ev.push(e.type),
      });
      sys.tick(0.016);
      sys.setProgress('k', 5);
      ev.length = 0;
      sys.reset();
      eq(ev.length, 0, 'reset 是"回到初始快照"，不应伪造状态迁移事件');
      eq(sys.status('k'), 'inactive');
      eq(sys.progress('k'), 0);
    });
  });

  // ============================================================
  // P2 · progressbar：阈值收口
  // ============================================================
  describe('progressbar · 阈值的有限性收口（P2）', () => {
    test('⚠️ lowThreshold = NaN 时残血仍要进入 low（修复前：state = normal）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P2-bar] lowThreshold=NaN, value=5% → state=normal（期望 low）
       * [P2-bar] 对照组默认 lowThreshold → state=low
       * ```
       * `clamp01(opts.x ?? 默认)`：`??` 挡不住 NaN，
       * 而 clamp01 底层两个比较对 NaN 都为 false → **NaN 原样穿透**。
       * `r <= NaN` 恒 false → 血条永远不进 low，残血预警静默失效。
       */
      const b = new ProgressBar({ max: 100, value: 5, lowThreshold: NaN });
      eq(b.state, 'low', 'NaN 阈值应回落默认 0.25，5% 应判定 low');
    });

    test('⚠️ highThreshold = NaN 时回落默认 1（不是回落 0，否则恒 high）', () => {
      const b = new ProgressBar({ max: 100, value: 90, highThreshold: NaN });
      eq(b.state, 'normal', 'NaN 应回落默认 1 → 90% 还不够 high');

      const b2 = new ProgressBar({ max: 100, value: 90, highThreshold: 0.8 });
      eq(b2.state, 'high', '显式阈值 0.8 时应进 high');
    });

    test('默认阈值行为不变（防止矫枉过正）', () => {
      eq(new ProgressBar({ max: 100, value: 25 }).state, 'low', '25% 边界应算 low');
      eq(new ProgressBar({ max: 100, value: 26 }).state, 'normal');
      eq(new ProgressBar({ max: 100, value: 0 }).state, 'empty');
      eq(new ProgressBar({ max: 100, value: 100 }).state, 'full');
    });

    test('阈值滞回仍生效（防止矫枉过正）', () => {
      const b = new ProgressBar({ max: 100, value: 30, lowThreshold: 0.25 });
      eq(b.state, 'normal');
      b.set(20);
      eq(b.state, 'low', '掉到 20% 进 low');
      b.set(26);
      eq(b.state, 'low', '滞回区（25% + 0.02）内仍保持 low，不会每帧闪');
      b.set(40);
      eq(b.state, 'normal', '远离阈值后恢复 normal');
    });
  });

  // ============================================================
  // P2 · progressbar：segmentBounds 的空隙分摊
  // ============================================================
  describe('progressbar · 分段空隙的对称分摊（P2）', () => {
    test('⚠️ 首段与中间段必须等宽（修复前：0.3233 / 0.3133 / 0.3233）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P2-bar] segmentBounds(3段,gap0.02)= 0:[0,0.3233] 宽=0.3233  1:[0.3433,0.6567] 宽=0.3133  2:[0.6767,1] 宽=0.3233
       * ```
       * 旧算法：中间段两端各扣 gap/2，首末段只扣一头 → 中间段窄 gap/2。
       * 新算法：n-1 处空隙一次性从总宽扣除，剩下 n 段等宽。
       */
      const b = new ProgressBar({ max: 300, segments: 3, segmentGap: 0.02 });
      const widths: number[] = [];
      for (let i = 0; i < 3; i++) {
        const s = b.segmentBounds(i);
        widths.push(s.end - s.start);
      }
      near(widths[0], widths[1], 1e-9, '第 1、2 段应等宽');
      near(widths[1], widths[2], 1e-9, '第 2、3 段应等宽');
    });

    test('⚠️ 空隙总量正确且首末段贴边', () => {
      const b = new ProgressBar({ max: 300, segments: 3, segmentGap: 0.02 });
      const s0 = b.segmentBounds(0);
      const s2 = b.segmentBounds(2);
      near(s0.start, 0, 1e-9, '首段从 0 开始');
      near(s2.end, 1, 1e-9, '末段到 1 结束');
      // 三段 + 两处空隙 = 1
      const total = s2.end - s0.start;
      near(total, 1, 1e-9, '首段起点到末段终点应铺满整条');
    });

    test('段间确实留有空隙（防止矫枉过正：不能把空隙弄没了）', () => {
      const b = new ProgressBar({ max: 100, value: 50, segments: 4, segmentGap: 0.1 });
      const s0 = b.segmentBounds(0);
      const s1 = b.segmentBounds(1);
      assert(s1.start > s0.end, `段之间应留空隙：${s0.end} → ${s1.start}`);
      near(s1.start - s0.end, 0.1, 1e-9, '相邻段的空隙应等于 segmentGap');
    });

    test('gap = 0 时段宽严格等于 1/n（防止矫枉过正）', () => {
      const b = new ProgressBar({ max: 100, value: 50, segments: 4, segmentGap: 0 });
      near(b.segmentBounds(0).start, 0, 1e-9);
      near(b.segmentBounds(0).end, 0.25, 1e-9);
      near(b.segmentBounds(3).start, 0.75, 1e-9);
      near(b.segmentBounds(3).end, 1, 1e-9);
    });

    test('越界仍抛错（防止矫枉过正）', () => {
      const b = new ProgressBar({ segments: 3 });
      throws(() => b.segmentBounds(3), '越界');
      throws(() => b.segmentBounds(-1), '越界');
    });
  });

  // ============================================================
  // P2 · progressbar：构造校验与 destroy
  // ============================================================
  describe('progressbar · 构造校验与可卸载（P2）', () => {
    test('⚠️ max = NaN 不得再产出 NaN 的 ratio（修复前：ratio = NaN 且不抛错）', () => {
      /**
       * 【修复前的实测】
       * ```
       * [P2-bar] max=NaN 构造未抛错 → ratio=NaN（max<=min 校验被 NaN 绕过）
       * [P2-bar] min=NaN 构造未抛错 → ratio=NaN
       * ```
       * NaN 参与 `<=` 比较恒 false → `if (max <= min) throw` 形同虚设。
       * ratio = NaN 会让渲染宽度、分段索引、状态判定全部失效且不报错。
       *
       * 【为什么是"回落默认"而不是"抛错"】
       * 与全库模式 B 一致：配置项统一用 numOr / clampNum 收口，
       * 抛错会把"一份配表填错"升级成"血条建不出来 → 整块 UI 挂掉"。
       * 收口后 max 有确定值，ratio 恒为有限数。
       */
      const b = new ProgressBar({ min: 0, max: NaN, value: 50 });
      eq(b.max, 100, 'max 回落默认 100');
      assert(Number.isFinite(b.ratio), `ratio 应有限，实际 ${b.ratio}`);
      near(b.ratio, 0.5, 1e-9);
    });

    test('⚠️ 区间确实非法时仍抛错（防止矫枉过正：校验不能被一起去掉）', () => {
      throws(() => new ProgressBar({ min: 100, max: 100, value: 50 }), 'max 必须大于 min');
      throws(() => new ProgressBar({ min: 100, max: 0, value: 50 }), 'max 必须大于 min');
    });

    test('⚠️ max 为 Infinity 时回落默认，而不是把 Infinity 带进 ratio', () => {
      const b = new ProgressBar({ min: 0, max: Infinity, value: 50 });
      eq(b.max, 100, 'max 回落默认 100');
      near(b.ratio, 0.5, 1e-9);
    });

    test('min = NaN 回落默认 0（非有限值不落到 ratio 里）', () => {
      const b = new ProgressBar({ min: NaN, max: 100, value: 50 });
      assert(Number.isFinite(b.ratio), `ratio 应有限，实际 ${b.ratio}`);
      near(b.ratio, 0.5, 1e-9);
      eq(b.min, 0, 'min 应回落默认 0');
    });

    test('⚠️ destroy() 后对外状态归零（修复前：typeof destroy === undefined）', () => {
      const b = new ProgressBar({ max: 100, value: 80, segments: 3, trail: true });
      b.update(0.016);
      b.destroy();
      eq(b.value, 0, '值回到 min');
      eq(b.state, 'empty', '状态置 empty');
      eq(b.displayRatio, 0, '显示比例归零');
      eq(b.trailRatio, 0, '延迟条归零');
      // destroy 后再取快照应是一份干净的初始值，而不是上一局残影
      const s = b.snapshot();
      eq(s.value, 0);
      eq(s.state, 'empty');
    });

    test('正常构造与 set/add 行为不变（防止矫枉过正）', () => {
      const b = new ProgressBar({ min: 0, max: 100, value: 100, trail: true });
      eq(b.ratio, 1);
      eq(b.state, 'full');
      b.add(-30);
      near(b.ratio, 0.7, 1e-9);
      b.update(0.016);
      near(b.snapshot().ratio, 0.7, 1e-9);
      assert(b.snapshot().trailRatio > 0.7, '延迟条应仍在后面追赶');
    });
  });
}
