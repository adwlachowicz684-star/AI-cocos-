/**
 * tests/run_phase8.ts —— 第二次精审 · 崩溃/卡死 + 永久失效类 P0 修复回归
 *
 * 【这一组和上一组的区别】
 * 第七批（财产/安全）的后果是"钱错了"；
 * 这一批的后果是"游戏挂了"或"某个系统永久废掉"：
 *
 * | 编号 | 单元 | 后果 |
 * |---|---|---|
 * | P0-9 | spatial | `queryNearest` 默认参数下死循环（主线程 100% 卡死）|
 * | P0-8 | difficulty | 一次 NaN → DDA 永久失效，难度再也不调 |
 * | P0-18 | skill-player | `Cooldown` 被 NaN 毒化，技能永久无法使用 |
 * | P0-28 | turn | `reviveUnit()` 恒返回 false，复活功能整体失效 |
 * | P0-29 | turn | 额外回合的克隆体导致死亡单位继续行动 |
 * | P0-12 | audio | `BgmStack.update(NaN)` → BGM 永久静音且卡在过渡态 |
 *
 * 【贯穿本批的模式：NaN 的"粘性"】
 * 上面 6 条里有 4 条是同一个失效链：
 * ```
 * 一次 NaN 进入状态变量 → 后续所有 `>=`/`<` 比较恒为 false
 *   → 保护分支永不进入 → 状态再也无法被修正 → 永久失效
 * ```
 * 所以修法是一致的：**在状态写入口挡掉脏样本**，
 * 而不是等它进了状态再想办法。
 *
 * 【另一个模式：用克隆体表达"再来一次"】
 * `grantExtraTurn` 往序列里插同 id 的克隆对象，
 * 破坏了"id ↔ entry 一一对应"这条不变式。
 * 改成计数器后，删除、计数、胜负判定全部自洽。
 */

import { describe, test, assert, eq } from './_framework';

import { SpatialHash } from '../spatial/SpatialHash';
import { DifficultySystem, computePerformance } from '../difficulty/DifficultySystem';
import { Cooldown } from '../skill-player/Cooldown';
import { TurnSystem } from '../turn/TurnSystem';
import { BgmStack } from '../audio/BGMStack';
import { HitboxWorld, hitboxCenter } from '../hitbox/Hitbox';
import { SkillCaster } from '../skill-caster/SkillCaster';
import { ConditionEngine } from '../condition/ConditionEngine';
import { CrashReporter } from '../crash/CrashReporter';
import { AudioManager } from '../audio/AudioManager';
import { ReportCenter } from '../social/Report';
import { SkillPlayer } from '../skill-player/SkillPlayer';

export function runPhase8Tests(): void {
  // ============================================================
  // P0-9 · spatial：queryNearest 死循环与 O(k·n) 反查
  // ============================================================

  describe('spatial · queryNearest 收敛性与性能（P0-9）', () => {
    test('⚠️ 候选不足 k 且 maxRadius=Infinity 时不得死循环', () => {
      /**
       * 【修复前】原循环的两个终止条件都依赖 `radius >= Infinity`，
       * 而有限数翻倍永远到不了 Infinity → **主线程 100% 卡死**。
       *
       * 实测：插入 1 个点、`queryNearest(0, 0, 5)` → 20 秒内未返回。
       * 这不是边缘调用——"找最近的 5 个敌人"是默认参数下的常见用法。
       */
      const h = new SpatialHash<{ id: number }>({ cellSize: 64 });
      h.insert('a', { id: 1 }, 0, 0);
      const t0 = Date.now();
      const r = h.queryNearest(0, 0, 5);
      const ms = Date.now() - t0;
      assert(ms < 1000, `耗时 ${ms}ms，疑似仍在指数扩张`);
      eq(r.length, 1, '候选不足时应返回全部 1 个');
    });

    test('⚠️ 空表立即返回，不进入扩张循环', () => {
      const h = new SpatialHash<{ id: number }>({ cellSize: 64 });
      eq(h.queryNearest(0, 0, 5).length, 0);
    });

    test('⚠️ 返回的是最近的 K 个且按距离升序', () => {
      const h = new SpatialHash<{ id: number }>({ cellSize: 8 });
      for (let i = 0; i < 20; i++) h.insert('p' + i, { id: i }, i * 10, 0);
      const r = h.queryNearest(0, 0, 3);
      eq(JSON.stringify(r.map((x) => x.id)), '[0,1,2]', '应取 x=0,10,20 三个');
    });

    test('⚠️ 有限 maxRadius 生效，且不会因翻倍越过上限而漏查', () => {
      /**
       * 【返工记录】第一版我写成 `while (radius <= max(cap, cellSize))`，
       * 半径按 2 倍增长会**越过** cap：cap=25、cellSize=8 时序列是 8→16→32，
       * 而 32 <= 25 为假 → 循环在查过 16 之后就退出，从没以 25 为半径查过，
       * 实测少返回 1 个本该命中的点。
       * 改成"先夹到 cap 再翻倍"：8 → 16 → 25（查）→ 退出。
       */
      const h = new SpatialHash<{ id: number }>({ cellSize: 8 });
      for (let i = 0; i < 20; i++) h.insert('p' + i, { id: i }, i * 10, 0);
      const r = h.queryNearest(0, 0, 100, 25);
      eq(r.length, 3, '半径 25 内应有 x=0,10,20 三个');
    });

    test('⚠️ 大规模查询不再触发 O(k·n) 反查', () => {
      /**
       * 【修复前】拿到 `T[]` 后用 `_findEntry(item)` 遍历整个 Map 反查坐标。
       * 改成粗筛阶段直接保留带坐标的 entry，排序阶段零反查。
       */
      const h = new SpatialHash<{ id: number }>({ cellSize: 32 });
      for (let i = 0; i < 20000; i++) {
        h.insert('p' + i, { id: i }, (i * 7919) % 2000, (i * 104729) % 2000);
      }
      const t0 = Date.now();
      let cnt = 0;
      for (let q = 0; q < 200; q++) {
        cnt += h.queryNearest((q * 13) % 2000, (q * 29) % 2000, 5).length;
      }
      const ms = Date.now() - t0;
      assert(cnt > 0, '应有命中');
      assert(ms < 3000, `20000 对象 × 200 次查询耗时 ${ms}ms，疑似退化`);
    });
  });

  // ============================================================
  // P0-8 · difficulty：NaN 永久污染 DDA
  // ============================================================

  describe('difficulty · NaN 与 DDA 永久失效（P0-8）', () => {
    const mk = (): DifficultySystem =>
      new DifficultySystem({
        tiers: [{ id: 'normal', name: '普通', multipliers: { enemyHp: 1 } }],
        defaultTier: 'normal',
        dda: { enabled: true, maxAdjust: 0.15, responsiveness: 0.5 },
      });

    test('⚠️ report(NaN) 丢弃脏样本，不污染 _smoothPerf', () => {
      /**
       * 【修复前】`clamp01(NaN)` 返回 NaN，`lerp(0.51, NaN, alpha)` = NaN，
       * 此后每一次 report 都是 `lerp(NaN, p, alpha)` = NaN —— **自我复制**。
       */
      const d = mk();
      for (let i = 0; i < 5; i++) d.report(0.9, 10);
      const before = d.smoothedPerformance;
      d.report(NaN, 10);
      const after = d.smoothedPerformance;
      assert(Number.isFinite(after), 'smoothPerf 不应变成 NaN');
      assert(Math.abs(after - before) < 1e-9, '脏样本应被完全丢弃');
    });

    test('⚠️ 一次 NaN 之后，后续合法值仍能正常生效', () => {
      const d = mk();
      for (let i = 0; i < 5; i++) d.report(0.9, 10);
      const before = d.smoothedPerformance;
      d.report(NaN, 10);
      for (let i = 0; i < 20; i++) d.report(0.1, 10);
      const after = d.smoothedPerformance;
      assert(Number.isFinite(after), '不应永久卡在 NaN');
      assert(after < before, `合法低表现应拉低平滑值：${before} → ${after}`);
    });

    test('⚠️ computePerformance 的坏分量被跳过而非污染', () => {
      /**
       * 【为什么坏分量"不计入"而不是"记 0 分"】
       * 记 0 分等于"玩家表现极差"，会让难度无端下调；
       * 连权重一起跳过才是"这条数据缺失"的正确语义。
       */
      const v = computePerformance({ hurtRatio: NaN, clearSpeed: 0.8 });
      assert(Number.isFinite(v), '不应返回 NaN');
      eq(Math.abs(v - 0.8) < 1e-9, true, '应只用剩余分量计算，得 0.8');
    });

    test('⚠️ computePerformance 正常输入不受影响', () => {
      const v = computePerformance({ hurtRatio: 0, deaths: 0, clearSpeed: 1, resourceLeft: 1 });
      assert(Number.isFinite(v) && v > 0.9, '全优表现应接近 1');
    });
  });

  // ============================================================
  // P0-18 · skill-player：Cooldown 被 NaN 毒化
  // ============================================================

  describe('skill-player · Cooldown 的 NaN 粘性（P0-18）', () => {
    test('⚠️ tick(dt, NaN) 不毒化 _progress', () => {
      /**
       * 【修复前】入口只校验 `dt`，没校验 `speedMul`。
       * `_progress` 变 NaN 后：`while (_progress >= 1)` 恒为 false → 充能永不恢复；
       * **后续再用合法的 tick(dt, 1) 也救不回来**。
       */
      const cd = new Cooldown({ duration: 1 });
      cd.trigger();
      cd.tick(0.5, NaN);
      assert(Number.isFinite(cd.progress), 'progress 不应变成 NaN');
    });

    test('⚠️ 中毒路径后仍能正常恢复（防止只修一半）', () => {
      const cd = new Cooldown({ duration: 1 });
      cd.trigger();
      cd.tick(0.5, NaN);
      cd.tick(10, 1);
      eq(cd.ready, true, '后续合法 tick 应能充满');
    });

    test('⚠️ speedMul 加成仍然生效（防止矫枉过正）', () => {
      const cd = new Cooldown({ duration: 1 });
      cd.trigger();
      cd.tick(0.4, 1);
      cd.tick(0.4, 2);
      eq(cd.ready, true, 'speedMul=2 时应提前充满');
    });

    test('⚠️ speedMul <= 0 回落成 1（不产生零速或负速）', () => {
      const cd = new Cooldown({ duration: 1 });
      cd.trigger();
      cd.tick(0.5, 0);
      eq(cd.progress, 0.5, 'speedMul=0 应按 1x 处理');
    });
  });

  // ============================================================
  // P0-28 / P0-29 · turn：复活失效与死亡单位继续行动
  // ============================================================

  describe('turn · 复活与额外回合（P0-28 / P0-29）', () => {
    test('⚠️ reviveUnit 在 killUnit 之后可用（不再恒返回 false）', () => {
      /**
       * 【修复前】`_doRemove` 里 `_byId.delete(id)`，
       * 而 `reviveUnit` 唯一的入口就是 `_byId.get(id)` → 永远拿不到对象。
       * README 明写 `killUnit(id) / reviveUnit(id)` 是"死亡 / 复活"，
       * 任何带复活、亡语机制的玩法接上后**复活静默失败**。
       */
      const t = new TurnSystem();
      t.addUnit({ id: 'a', initiative: 10 });
      t.addUnit({ id: 'b', initiative: 5 });
      t.start();
      eq(t.killUnit('b'), true);
      eq(t.has('b'), false);
      eq(t.reviveUnit('b'), true, '复活应成功');
      eq(t.has('b'), true, '复活后应重新可见');
      eq(t.unitCount, 2, '复活后应回到行动序列');
    });

    test('⚠️ 重复复活返回 false（幂等）', () => {
      const t = new TurnSystem();
      t.addUnit({ id: 'a', initiative: 10 });
      t.addUnit({ id: 'b', initiative: 5 });
      t.start();
      t.killUnit('b');
      eq(t.reviveUnit('b'), true);
      eq(t.reviveUnit('b'), false, '活着的单位不该被复活');
    });

    test('⚠️ 额外回合不新增单位计数（克隆体已改为计数器）', () => {
      /**
       * 【修复前】`grantExtraTurn` 插入 `{...e}` 同 id 克隆体，
       * 破坏"id ↔ entry 一一对应"，`unitCount` 与 `_entries.length` 不一致。
       */
      const t = new TurnSystem();
      t.addUnit({ id: 'a', initiative: 10 });
      t.addUnit({ id: 'b', initiative: 5 });
      t.start();
      t.grantExtraTurn('a');
      eq(t.unitCount, 2, '额外回合不应让计数变成 3');
    });

    test('⚠️ 额外回合后击杀，行动序列里不留幽灵', () => {
      /**
       * 【修复前】`_doRemove` 用 `findIndex` 只删第一个匹配，
       * 克隆体残留且 `dead` 仍为 false → **死亡单位再次行动**。
       */
      const t = new TurnSystem();
      t.addUnit({ id: 'a', initiative: 10 });
      t.addUnit({ id: 'b', initiative: 5 });
      t.start();
      t.grantExtraTurn('a');
      t.killUnit('a');
      eq(t.unitCount, 1);
      eq(t.has('a'), false);
      assert(!t.orderPreview.includes('a'), '序列里不应残留已死单位 a');
    });

    test('⚠️ 额外回合让该单位连续行动两次', () => {
      const t = new TurnSystem();
      const seq: string[] = [];
      t.addUnit({ id: 'a', initiative: 10 });
      t.addUnit({ id: 'b', initiative: 5 });
      (t as unknown as { _events: { onUnitStart?: (id: string) => void } })._events = {
        onUnitStart: (id: string) => {
          seq.push(id);
        },
      };
      t.start();
      t.grantExtraTurn('a');
      t.endTurn();
      t.endTurn();
      assert(seq.filter((x) => x === 'a').length >= 2, `a 应连续行动两次，实际 ${JSON.stringify(seq)}`);
      assert(seq[seq.length - 1] === 'b', `最后应轮到 b，实际 ${JSON.stringify(seq)}`);
    });
  });

  // ============================================================
  // P0-12 · audio：BgmStack 被 NaN dt 卡死
  // ============================================================

  describe('audio · BgmStack 的非法 dt（P0-12）', () => {
    const mk = (): BgmStack =>
      new BgmStack({
        layers: [{ name: 'drum', baseVolume: 1 }],
        states: { calm: { drum: 1 }, battle: { drum: 0.8 } },
        initialState: 'calm',
        transitionMs: 200,
      });

    test('⚠️ update(NaN) 不推进过渡，但后续合法 dt 仍能完成', () => {
      /**
       * 【修复前】`_elapsed += NaN` → `_elapsed >= _transitionMs` 恒为 false
       * → `_inTransition` 永远为 true，层音量停在 NaN 交叉淡入的结果上
       * → **BGM 永久静音且卡死在过渡态**，重启场景才恢复。
       */
      const b = mk();
      b.setState('battle');
      eq(b.inTransition, true);
      b.update(NaN);
      b.update(100);
      b.update(100);
      eq(b.inTransition, false, '过渡应能正常结束');
    });

    test('⚠️ 过渡完成时音量到达目标值', () => {
      const b = mk();
      b.setState('battle');
      b.update(NaN);
      b.update(100);
      b.update(100);
      assert(Math.abs(b.layerVolume('drum') - 0.8) < 1e-6, 'drum 应到达 0.8');
    });

    test('⚠️ update(Infinity) 同样被挡（不把 elapsed 推爆）', () => {
      /**
       * 【为什么不能只判 `dt > 0`】`Infinity > 0` 为 true，
       * 会把 `_elapsed` 直接推到 Infinity，同样出不来的过渡态。
       */
      const b = mk();
      b.setState('battle');
      b.update(Infinity);
      assert(Number.isFinite(b.layerVolume('drum')), '音量不应变成 Infinity/NaN');
      b.update(100);
      b.update(100);
      eq(b.inTransition, false, 'Infinity 之后仍能完成过渡');
    });
  });

  // ============================================================
  // P0-11 · audio：maxVoices 收口（非法配置穿透）
  // ============================================================

  describe('audio · maxVoices 收口（P0-11）', () => {
    const fill = (maxVoices: number | undefined): number => {
      const a = new AudioManager({
        maxVoices: maxVoices as number,
        maxSameSoundPerFrame: 1e9,
      });
      a.update(0);
      for (let i = 0; i < 500; i++) a.play('s' + i);
      return (a as unknown as { _active: { size: number } })._active.size;
    };

    test('⚠️ maxVoices=NaN 时通道上限不被绕过', () => {
      /**
       * 【修复前】`cfg.maxVoices ?? 32` —— `??` 只挡 null/undefined，
       * 挡不住 NaN；而 `if (_active.size >= _maxVoices)` 在 NaN 时恒为 false，
       * "通道已满 → 抢占/拒绝"这条保护路径**永不进入**。
       * 实测：播 500 个不同音效 → 活跃数 **500**（上限完全失效）。
       */
      const n = fill(NaN);
      assert(n <= 32, `活跃数 ${n}，上限被绕过`);
    });

    test('⚠️ maxVoices=32 正常生效（防止矫枉过正）', () => {
      eq(fill(32), 32);
    });

    test('⚠️ maxVoices=0 仍是"完全静音"，不被夹成 1', () => {
      /**
       * 【返工记录】第一版我写成 `clampNum(cfg.maxVoices, 1, 512, 32)`，
       * 把 `0` 也夹成了 1——"静音配置"变成"允许 1 个音效"，
       * 既有测试 `new AudioManager({maxVoices: 0})` 期望 rejected > 0 立刻变红。
       * `0` 是有意义的配置，不是非法值；这里要拦的只有 NaN 和离谱大值。
       */
      eq(fill(0), 0);
    });
  });

  // ============================================================
  // P0-17 · skill-player：register 的 overwrite 参数
  // ============================================================

  describe('skill-player · register 的 overwrite（P0-17）', () => {
    test('⚠️ overwrite=false 时不得覆盖（与 README 一致）', () => {
      /**
       * 【修复前】`if (has && !overwrite) console.warn(...)`
       * —— 只 warn **然后照样 set**，参数完全无效。
       * README 白纸黑字写着「默认不允许覆盖」。
       *
       * 后果：两个子系统注册同名事件类型时后者静默顶掉前者，
       * 表现为"某个技能的判定突然不生效了"。
       */
      const sp = new SkillPlayer({} as never);
      let who = '';
      sp.register('x', () => {
        who = 'fn1';
      }, false);
      sp.register('x', () => {
        who = 'fn2';
      }, false);
      (sp as unknown as { _handlers: Map<string, () => void> })._handlers.get('x')?.();
      eq(who, 'fn1', 'overwrite=false 应保留先注册的');
    });

    test('⚠️ overwrite=true 时可以覆盖（防止矫枉过正）', () => {
      const sp = new SkillPlayer({} as never);
      let who = '';
      sp.register('y', () => {
        who = 'a';
      }, false);
      sp.register('y', () => {
        who = 'b';
      }, true);
      (sp as unknown as { _handlers: Map<string, () => void> })._handlers.get('y')?.();
      eq(who, 'b');
    });
  });

  // ============================================================
  // P0-15 · social：cooldownMs=0 导致 _lastReport 无界增长
  // ============================================================

  describe('social · 冷却表的无界增长（P0-15）', () => {
    test('⚠️ cooldownMs=0 时不写入冷却表（不再只增不减）', () => {
      /**
       * 【修复前】`prune()` 开头的 `if (this._cooldownMs <= 0) return 0;`
       * 把冷却表清理**一起跳过**，而 `submit` 每次都 `set`。
       * `cooldownMs: 0`（不限制冷却）是完全合法的配置。
       *
       * 实测（修复前）：50 个举报人各提交 1 次 → 表里 50 条全部留存。
       * 规模是"举报人 × 被举报人"笛卡尔积，大 DAU 下几周能到百万级，
       * 且 `prune` 返回 0 看起来"很正常"。
       */
      const rc = new ReportCenter({ cooldownMs: 0, dailyLimit: 5 });
      for (let i = 0; i < 50; i++) rc.submit('r' + i, 't' + i, 'griefing', 1_000_000);
      eq((rc as unknown as { _lastReport: Map<string, number> })._lastReport.size, 0);
    });

    test('⚠️ 有冷却时冷却表照常工作（防止矫枉过正）', () => {
      const rc = new ReportCenter({ cooldownMs: 1000, dailyLimit: 5 });
      for (let i = 0; i < 50; i++) rc.submit('r' + i, 't' + i, 'griefing', 1_000_000);
      eq((rc as unknown as { _lastReport: Map<string, number> })._lastReport.size, 50);
    });

    test('⚠️ 冷却期过后 prune 能清掉', () => {
      const rc = new ReportCenter({ cooldownMs: 1000, dailyLimit: 5 });
      for (let i = 0; i < 50; i++) rc.submit('r' + i, 't' + i, 'griefing', 1_000_000);
      rc.prune(1_000_000 + 2000);
      eq((rc as unknown as { _lastReport: Map<string, number> })._lastReport.size, 0);
    });

    test('⚠️ 坏时间戳必须抛错，不能造出永远清不掉的记录', () => {
      /**
       * 【为什么还要单独守 now】
       * `_lastReport.set(key, NaN)` 之后 `now - at >= cooldownMs` 是 `NaN >= x`，
       * 恒为 false → 这条记录**永远不会被 prune 清掉**。
       * 实测（加守卫前）：漏传 now 提交 1 次，无论 prune 多大时间戳都残留 1 条。
       * 这与 `cooldownMs === 0` 是同一失效模式的不同入口。
       */
      const rc = new ReportCenter({ cooldownMs: 1000, dailyLimit: 5 });
      let threw = false;
      try {
        (rc as unknown as { submit(a: string, b: string, c: string): void }).submit('r', 't', 'griefing');
      } catch {
        threw = true;
      }
      eq(threw, true, 'now 为 undefined 时应抛错');
    });
  });

  // ============================================================
  // P0-13 · hitbox：update 的 sameCell 只比中心格 → 跨格漏检
  // ============================================================

  describe('hitbox · update 的格子索引（P0-13）', () => {
    const circle = (r: number) => ({ kind: 'circle' as const, radius: r });
    const box = (id: string, r: number, x: number, y: number) => ({
      id,
      shape: circle(r),
      x,
      y,
      rotation: 0,
      layer: 1,
      mask: 1,
    });

    test('⚠️ 跨格的大判定框移动后仍能命中', () => {
      /**
       * 【修复前】`sameCell` 只比中心点所在格。
       * 半径 3 的圆在 (0,0) 覆盖 x 格 {-1,0}；移到 (3.9,0) 后
       * 中心格仍是 0，但覆盖格变成 {0,1}——索引却没更新。
       *
       * 实测（修复前）：`query(圆 r=0.5, 5, 0)` → **0 命中**；
       * 同样位置用 remove+add 重建索引 → 1 命中。距离 1.1 < 半径和 3.5。
       *
       * 表现为"大招打不到边缘的怪"——间歇性、与体型相关，极难归因。
       */
      const w = new HitboxWorld({ cellSize: 4 });
      w.add(box('big', 3, 0, 0));
      w.update('big', 3.9, 0);
      eq(w.query(circle(0.5), 5, 0, 0, 1).length, 1, '大框移动到跨格位置后应能命中');
    });

    test('⚠️ update 与 remove+add 结果一致（索引不陈旧）', () => {
      const a = new HitboxWorld({ cellSize: 4 });
      a.add(box('big', 3, 0, 0));
      a.update('big', 3.9, 0);

      const b = new HitboxWorld({ cellSize: 4 });
      b.add(box('big', 3, 0, 0));
      b.remove('big');
      b.add(box('big', 3, 3.9, 0));

      eq(
        a.query(circle(0.5), 5, 0, 0, 1).length,
        b.query(circle(0.5), 5, 0, 0, 1).length,
        '两条路径必须给出相同结果'
      );
    });

    test('⚠️ 小形状（不跨格）行为不变（防止矫枉过正）', () => {
      const w = new HitboxWorld({ cellSize: 4 });
      w.add(box('sm', 0.5, 0, 0));
      w.update('sm', 0.5, 0);
      eq(w.query(circle(0.5), 0.5, 0, 0, 1).length, 1);
    });

    test('⚠️ rotation 缺失时补全为 0（不再静默失效）', () => {
      /**
       * 【附带修复】`rotation` 缺失 → `rotateOffset(0, 0, undefined)` 走弧度分支
       * → `Math.cos(NaN)` → 判定框世界中心变 (NaN, NaN)
       * → `shapesOverlap` 所有比较恒为 false → **永远命中不了，且不报错**。
       *
       * 实测（补全前）：`hitboxCenter(b)` 返回 `{x: NaN, y: NaN}`。
       */
      const w = new HitboxWorld({ cellSize: 4 });
      w.add({ id: 'a', shape: circle(1), x: 0, y: 0, layer: 1, mask: 1 } as never);
      const stored = (w as unknown as { _boxes: Map<string, never> })._boxes.get('a');
      const c = hitboxCenter(stored as never);
      assert(Number.isFinite(c.x) && Number.isFinite(c.y), 'center 不应是 NaN');
      eq(w.query(circle(1), 0, 0, 0, 1).length, 1, '应能被查到');
    });
  });

  // ============================================================
  // P0-30 · crash：unhandledrejection 监听器必须可移除
  // ============================================================

  describe('crash · 全局监听器的卸载（P0-30）', () => {
    /**
     * 【为什么用假的事件总线】
     * Node 20 的 `globalThis` 没有 `addEventListener`，无法真实派发。
     * 但这是 Cocos / 浏览器下的真实路径（`install()` 的 JSDoc 明确写了
     * "在 Cocos / 浏览器里会覆盖 window.onerror"），
     * 所以这里自己装一个最小事件总线来验证**注册/移除的配对关系**。
     */
    const withFakeBus = (fn: (get: (t: string) => number, r: CrashReporter) => void): void => {
      const listeners: Record<string, ((e: unknown) => void)[]> = {};
      const g = globalThis as unknown as Record<string, unknown>;
      const savedAdd = g.addEventListener;
      const savedRm = g.removeEventListener;
      const savedErr = g.onerror;

      g.addEventListener = (t: string, f: (e: unknown) => void) => {
        (listeners[t] ||= []).push(f);
      };
      g.removeEventListener = (t: string, f: (e: unknown) => void) => {
        listeners[t] = (listeners[t] || []).filter((x) => x !== f);
      };

      try {
        const r = new CrashReporter({} as never);
        fn((t: string) => (listeners[t] || []).length, r);
      } finally {
        g.addEventListener = savedAdd;
        g.removeEventListener = savedRm;
        g.onerror = savedErr;
      }
    };

    test('⚠️ uninstall 后 unhandledrejection 监听器被移除', () => {
      /**
       * 【修复前】注册的是**匿名箭头函数**，引用未保存，
       * `uninstall()` 里 `removeEventListener` **完全没被调用**。
       *
       * 后果：卸载后监听器仍挂在全局，继续给"已关闭"的 reporter 上报；
       * `this` 被闭包持有 → reporter 及其 `_ring` / `_seen` / `_context` 全部无法回收。
       * 这是铁律 5「可卸载」的直接违反，且是最难查的那种泄漏——
       * 对象看似被释放，实际被全局事件总线吊着。
       */
      withFakeBus((get, r) => {
        r.install();
        eq(get('unhandledrejection'), 1, 'install 后应有 1 个监听器');
        r.uninstall();
        eq(get('unhandledrejection'), 0, 'uninstall 后应被移除');
      });
    });

    test('⚠️ 反复 install/uninstall 不叠加监听器', () => {
      /**
       * 【修复前】每次 install 都新增一个匿名监听器，
       * 循环 N 次就是 N 个 → 重复上报、重复采样。
       * 热更新 / 场景切换时销毁旧 reporter 建新的，旧的永远活着。
       */
      withFakeBus((get, r) => {
        for (let i = 0; i < 5; i++) {
          r.install();
          r.uninstall();
        }
        eq(get('unhandledrejection'), 0, '5 轮装卸后不应残留');
      });
    });
  });

  // ============================================================
  // P0-10 · condition：进度计算的三处错误
  // ============================================================

  describe('condition · 进度计算的语义（P0-10）', () => {
    const progressOf = (op: string, value: number, actual: number): number => {
      const e = new ConditionEngine();
      return (e as unknown as {
        _progressOf(c: unknown, actual: number): number;
      })._progressOf({ stat: 'x', op, value }, actual);
    };

    test('⚠️ value=0 的条件：满足为 1、不满足为 0（不再是常量 1）', () => {
      /**
       * 【修复前】`return actual === 0 ? 1 : 1;` —— 两个分支返回同一个值，
       * 是**写了一半的三元**。所有 `value === 0` 的条件无论满足与否进度都是 1。
       *
       * 实测（修复前）：`{op:'<', value:0}`、actual=5（不满足）→ progress = **1**，
       * 而 completed 是 false —— 进度条满格却判定未完成。
       */
      eq(progressOf('<=', 0, 0), 1, 'x <= 0 在 x=0 时满足');
      eq(progressOf('<', 0, 5), 0, 'x < 0 在 x=5 时不应是满进度');
      eq(progressOf('>', 0, 5), 1, 'x > 0 在 x=5 时满足');
    });

    test('⚠️ != 的进度必须与 == 相反', () => {
      /**
       * 【修复前】`==` 和 `!=` 两个分支共用同一个表达式
       * `actual === c.value ? 1 : 0`，`!=` 的进度被算成了 `==` 的进度。
       *
       * 实测（修复前）：`{op:'!=', value:0}` 在 actual=0（不满足）和
       * actual=5（满足）时 progress 都是 1 —— 进度条完全不携带信息。
       */
      eq(progressOf('!=', 0, 0), 0, 'x != 0 在 x=0 时不满足');
      eq(progressOf('!=', 0, 5), 1, 'x != 0 在 x=5 时满足');
      eq(progressOf('==', 0, 0), 1, 'x == 0 在 x=0 时满足');
      eq(progressOf('==', 0, 5), 0, 'x == 0 在 x=5 时不满足');
    });

    test('⚠️ 反向条件（< / <=）：越满足进度越高（方向本就如此，不得反转）', () => {
      /**
       * 【这一条是"防止矫枉过正"】
       * 有报告认为 `<` 的方向反了，建议反转。
       * 但实测确认现有方向**是正确的**：
       * "血量低于 30%" 时血量 10%（满足）→ 1，血量 100%（不满足）→ 0。
       * 按报告改会让残血类任务的进度条倒着走。
       */
      eq(progressOf('<', 30, 10), 1, '血量 10% < 30% → 满进度');
      eq(progressOf('<', 30, 100), 0, '血量 100% 不满足 → 0');
      eq(progressOf('<', 50, 10), 1, '延迟 10 < 50 → 满进度');
      eq(progressOf('<', 50, 200), 0, '延迟 200 不满足 → 0');
    });

    test('⚠️ 正向条件（> / >=）进度随实际值递增', () => {
      eq(progressOf('>=', 100, 50), 0.5, '完成一半');
      eq(progressOf('>=', 100, 100), 1, '刚好达标');
      eq(progressOf('>=', 100, 200), 1, '超额仍夹到 1');
    });
  });

  // ============================================================
  // P0-16 · skill-caster：hitWindow 内每帧生成一个弹道
  // ============================================================

  describe('skill-caster · 弹道的单次发射（P0-16）', () => {
    const mk = (hitWindow: number): { caster: SkillCaster; n: () => number } => {
      let n = 0;
      const caster = new SkillCaster({
        projectiles: {
          spawn: () => {
            n++;
            return {};
          },
        },
      } as never);
      caster.learn({
        id: 'fire',
        name: '火球',
        cooldown: 0,
        windup: 0,
        hitDelay: 0,
        hitWindow,
        recover: 0,
        projectile: { speed: 10, lifetime: 2 },
      } as never);
      return { caster, n: () => n };
    };

    test('⚠️ hitWindow > 0 时弹道只发射一次（不是每帧一次）', () => {
      /**
       * 【修复前】`_resolve` 每帧被调用（持续检测命中），
       * 命中判定那段有 `hitIds` 去重，但**弹道生成那段没有任何"只做一次"的标志**。
       *
       * 实测（修复前）：hitWindow=0.5、60fps 下跑 30 帧 → spawn 被调用 **30 次**。
       * 60fps 下 0.5 秒窗口 = 30 枚弹道叠加，
       * 表现为"技能瞬间打出成百上千伤害"或"弹幕刷屏 + 性能雪崩"。
       * 每枚弹道都是合法生成的，日志和监控都显示正常，极难归因。
       */
      const { caster, n } = mk(0.5);
      caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 30; i++) caster.tick(1 / 60);
      eq(n(), 1, '0.5 秒窗口内应只发射 1 枚');
    });

    test('⚠️ hitWindow = 0 时也正常发射一次（防止矫枉过正）', () => {
      const { caster, n } = mk(0);
      caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 30; i++) caster.tick(1 / 60);
      eq(n(), 1);
    });

    test('⚠️ 连续两次施法各发射一次（标志按次重置）', () => {
      /**
       * 【为什么需要单独测这条】
       * 加"只发射一次"的标志时，最容易犯的错是把状态挂在 caster 上
       * 而不是挂在"本次施法"上——那样第二次施法就再也发不出弹道了。
       */
      const { caster, n } = mk(0.1);
      caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 20; i++) caster.tick(1 / 60);
      caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 20; i++) caster.tick(1 / 60);
      eq(n(), 2, '两次施法应各发射 1 枚');
    });
  });

  // ============================================================
  // P0-30 · crash：unhandledrejection 监听器无法移除
  // ============================================================

  describe('crash · install/uninstall 的监听器（P0-30）', () => {
    /**
     * 【为什么要在测试里造一个假的事件总线】
     * Node 20 的 `globalThis` 没有 `addEventListener`，
     * 直接跑走不到那条分支（所以原报告标注"本批无法实测派发"）。
     * 这里临时挂一个最小实现，就能精确统计监听器的注册与移除。
     *
     * 这也是这条 bug 最容易被漏掉的原因：
     * 在 Node 下测试全绿，问题只在 Cocos / 浏览器里出现。
     */
    const withFakeBus = (fn: (bus: Record<string, ((e: unknown) => void)[]>) => void): void => {
      const bus: Record<string, ((e: unknown) => void)[]> = {};
      const g = globalThis as unknown as {
        addEventListener?: (t: string, f: (e: unknown) => void) => void;
        removeEventListener?: (t: string, f: (e: unknown) => void) => void;
        onerror?: unknown;
      };
      const saved = {
        add: g.addEventListener,
        rm: g.removeEventListener,
        err: g.onerror,
      };
      g.addEventListener = (t, f) => {
        (bus[t] ||= []).push(f);
      };
      g.removeEventListener = (t, f) => {
        bus[t] = (bus[t] || []).filter((x) => x !== f);
      };
      try {
        fn(bus);
      } finally {
        g.addEventListener = saved.add;
        g.removeEventListener = saved.rm;
        g.onerror = saved.err;
      }
    };

    test('⚠️ uninstall 后 unhandledrejection 监听器被真正移除', () => {
      /**
       * 【修复前】注册的是**匿名箭头函数**，引用没保存，
       * `uninstall()` 只恢复了 `g.onerror`，`removeEventListener` 从未被调用。
       *
       * 后果：卸载后监听器仍挂在全局，继续给"已关闭"的 reporter 上报；
       * `this` 被闭包持有 → reporter 及其 `_ring` / `_seen` / `_context` 全部无法回收。
       * 这是铁律 5「可卸载」的直接违反，且对象看似释放、实际被全局事件总线吊着。
       */
      withFakeBus((bus) => {
        const r = new CrashReporter({} as never);
        r.install();
        eq((bus['unhandledrejection'] || []).length, 1, 'install 后应有 1 个监听器');
        r.uninstall();
        eq((bus['unhandledrejection'] || []).length, 0, 'uninstall 后应清空');
      });
    });

    test('⚠️ 反复 install/uninstall 不叠加监听器', () => {
      /**
       * 【修复前】每轮循环都多留一个匿名监听器 → 重复上报、重复采样。
       * 典型场景是热更新 / 场景切换时销毁旧 reporter 建新的，旧的永远活着。
       */
      withFakeBus((bus) => {
        const r = new CrashReporter({} as never);
        for (let i = 0; i < 5; i++) {
          r.install();
          r.uninstall();
        }
        eq((bus['unhandledrejection'] || []).length, 0, '5 轮装卸后不应残留');
      });
    });

    test('⚠️ 连续 install 不重复注册（幂等）', () => {
      withFakeBus((bus) => {
        const r = new CrashReporter({} as never);
        r.install();
        r.install();
        eq((bus['unhandledrejection'] || []).length, 1, '重复 install 只应有 1 个');
        r.uninstall();
      });
    });
  });
}
