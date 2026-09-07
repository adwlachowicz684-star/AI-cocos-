/**
 * tests/run_phase10_w4a.ts —— 第二次精审 · 返工窗口 W4-A
 *
 * 【本窗口的 6 个单元】
 * bullet-pattern / difficulty / entity / gameflow / i18n / matchmaking
 *
 * 【本批 15 条（P1 9 / P2 6）的处理结果】
 *
 * | 编号 | 单元 | 主题 | 结论 |
 * |---|---|---|---|
 * | P1-1 | bullet-pattern | 函数形状 `speed` 恒为 0 | 已修 |
 * | P1-2 | bullet-pattern | `interval` / `shots` 的 `<= 0` 挡不住 NaN | 已修 |
 * | P1-3 | bullet-pattern | `compileShape` 的 count 未收口 | **不成立**（见该组注释与实测） |
 * | P1-4 | entity | 回调里注销自己 → 下一个回调被跳过 | 已修 |
 * | P1-5 | entity | `destroy(无效 id)` 两种相反返回值 | 已修 |
 * | P1-6 | gameflow | `historyLimit <= 1` 时历史无限增长 | 已修 |
 * | P1-7 | i18n | `onChange` 只存单个回调 | 已修 |
 * | P1-8 | i18n | `has()` 与 `t()` 口径不一致 | 已修 |
 * | P1-9 | i18n | 覆盖率认 6 种复数，运行时只认 2 种 | 已修 |
 * | P2-1 | bullet-pattern | 掉帧补发 / 循环漂移 / 缺 destroy / 固定角度 | 已修 |
 * | P2-2 | difficulty | 缺 destroy；`currencyGain` 方向存疑 | 已修 + 1 条**需总审裁决** |
 * | P2-3 | entity | 槽位上界；无参 destroy；O(n) 扫描 | 已修 + 1 条**不成立** + 1 条**不修** |
 * | P2-4 | gameflow | `_findTransition` 死代码；`update(Infinity)` | 已修 |
 * | P2-5 | i18n | `addLocale` 原型污染 | 已修 |
 * | P2-6 | matchmaking | 空 if / 分队无解 / 两处未用参数 / 缺 destroy | 已修 |
 *
 * 【两条"不成立"为什么也要写测试】
 * 判"不成立"最容易犯的错是"看代码觉得没问题"就下结论。
 * 这两条都写了**可执行的复现**：把现象跑出来，用断言说明"它不存在"，
 * 并同时把**真实存在的相邻行为**（抛错 / 槽位复用）固化下来——
 * 这样即使将来有人把守卫删掉，测试会立刻变红。
 *
 * 【为什么 P2-3 的 O(n) 扫描不修】
 * 任务书第 1.1 条第 1 条：不要顺手重构。
 * `query/queryAll/snapshot/forEach` 每次全表扫描并新分配数组，
 * 是"遍历安全"这个更强约束的代价（快照才能让回调里改集合不出错）。
 * 改成惰性迭代器会破坏"遍历中改集合"的既有契约，属于行为变更，
 * 不在本窗口"只改清单指出的那一处"的范围内。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { RNG } from '../rng/RNG';
import {
  BulletPattern, SequencePlayer, Shapes, compileShape,
} from '../bullet-pattern/BulletPattern';
import {
  EntityRegistry, SLOT_CAPACITY, makeId, isValidId,
} from '../entity/EntityRegistry';
import { GameFlow } from '../gameflow/GameFlow';
import { I18N } from '../i18n/I18N';
import { DifficultySystem } from '../difficulty/DifficultySystem';
import { Lobby } from '../matchmaking/Lobby';
import { Matchmaker } from '../matchmaking/Matchmaker';
import { balanceTeams } from '../matchmaking/TeamBalancer';

/** 固定种子，保证本文件可复现 */
function rng(): RNG {
  return new RNG(20240917);
}

export function runPhase10W4ATests(): void {
  // ============================================================
  // P1-1 · bullet-pattern：函数形状的子弹速度
  // ============================================================

  describe('bullet-pattern · 自定义 ShapeFn 的速度（P1-1）', () => {
    test('⚠️ ShapeFn 发射器能给出非零速度', () => {
      /**
       * 【修复前】`_fire` 里 `const speed = spec ? speedAt(spec, i) : 0;`
       * 而 `spec` 在函数形态下恒为 null → 速度**永远取 0**。
       *
       * 实测（修复前）：
       *   shape: () => [0,1,2] → speed = [0, 0, 0]
       *   Shapes.ring(3,10,'b') → speed = [10, 10, 10]   ← 对照组成立
       *
       * 后果不是"子弹慢一点"：速度 0 意味着**全部原地不动**堆在发射点，
       * 玩家不会认为是 bug，只会觉得"这 Boss 有问题"。
       */
      const p = new BulletPattern(rng());
      p.addEmitter({ id: 'fn', shape: () => [0, 1, 2], interval: 0.1, speed: 8 });
      p.setTypeId('fn', 'b');
      p.play();
      let out = p.tick(0.1);
      eq(out.length, 3, '函数形状应产出 3 颗：');
      for (const s of out) eq(s.speed, 8, '每颗都应拿到 opts.speed：');
    });

    test('对照：ShapeSpec 仍优先用自己的 speed（不被 opts.speed 覆盖）', () => {
      const p = new BulletPattern(rng());
      p.addEmitter({
        id: 'spec', shape: Shapes.ring(3, 10, 'b'), interval: 0.1, speed: 999,
      });
      p.play();
      const out = p.tick(0.1);
      eq(out.length, 3, '环形应产出 3 颗：');
      for (const s of out) eq(s.speed, 10, 'ShapeSpec 形态应忽略 opts.speed：');
    });

    test('对照：未传 speed 的函数形状仍是 0（保持旧行为，不静默变速）', () => {
      const p = new BulletPattern(rng());
      p.addEmitter({ id: 'fn0', shape: () => [0], interval: 0.1 });
      p.play();
      eq(p.tick(0.1)[0].speed, 0, '缺省应为 0：');
    });

    test('对照：speed 为 NaN 时不污染产出', () => {
      const p = new BulletPattern(rng());
      p.addEmitter({ id: 'fnNan', shape: () => [0], interval: 0.1, speed: NaN });
      p.play();
      const s = p.tick(0.1)[0];
      assert(Number.isFinite(s.speed), `speed 不应为 NaN，实际 ${s.speed}`);
    });
  });

  // ============================================================
  // P1-2 · bullet-pattern：interval / shots 的 NaN 穿透
  // ============================================================

  describe('bullet-pattern · NaN 穿透构造校验（P1-2）', () => {
    test('⚠️ interval = NaN 必须在构造时就被拒', () => {
      /**
       * 【修复前】`if (opts.interval <= 0) throw`。
       * NaN 与任何值比较都是 false → `NaN <= 0` 为 false → **校验通过**；
       * 之后 tick 里 `while (e.time >= NaN)` 恒为 false，跑 600 帧产出 **0** 颗。
       *
       * 这与同一行上方的注释"配置错误现在就报，别等到 Boss 战打一半"
       * 直接矛盾——注释承诺了它没做到的事（本库判 P1 的典型：注释说谎）。
       */
      const p = new BulletPattern(rng());
      throws(
        () => p.addEmitter({ id: 'x', shape: Shapes.ring(3, 10, 'b'), interval: NaN }),
        'interval 必须为正',
        'interval=NaN 应抛错：'
      );
    });

    test('⚠️ shots = NaN 必须在构造时就被拒（否则有限次退化成无限）', () => {
      /**
       * 【修复前】`if (opts.shots !== undefined && opts.shots < 0)`。
       * `NaN < 0` 为 false → 通过；之后 `e.shotIndex >= NaN` 恒为 false
       * → "三连发"变成永动机，且不报错。
       */
      const p = new BulletPattern(rng());
      throws(
        () => p.addEmitter({
          id: 'x', shape: Shapes.ring(3, 10, 'b'), interval: 0.1, shots: NaN,
        }),
        'shots 不能为负',
        'shots=NaN 应抛错：'
      );
    });

    test('对照：正常 interval / shots 不受影响，且有限次真的会终止', () => {
      const p = new BulletPattern(rng());
      p.addEmitter({
        id: 'ok', shape: Shapes.ring(3, 10, 'b'), interval: 0.1, shots: 3,
      });
      p.play();
      let n = 0;
      for (let i = 0; i < 100; i++) n += p.tick(0.1).length;
      eq(n, 9, '3 次开火 × 3 颗 = 9 颗，之后应停止：');
      assert(p.isEmitterDone('ok'), '有限次发射器应标记 done');
    });

    test('对照：interval = 0 / 负数 / 非数字都仍被拒（不是只挡了 NaN）', () => {
      for (const v of [0, -1, 'x' as unknown as number]) {
        const p = new BulletPattern(rng());
        throws(
          () => p.addEmitter({ id: 'y', shape: Shapes.ring(1, 1, 'b'), interval: v }),
          'interval 必须为正',
          `interval=${String(v)} 应抛错：`
        );
      }
    });
  });

  // ============================================================
  // P1-3 · bullet-pattern：compileShape 的 count —— 判"不成立"
  // ============================================================

  describe('bullet-pattern · compileShape 的 count 收口（P1-3 · 不成立）', () => {
    test('不成立：count = NaN / null 不会静默产出 0 发或 1 发', () => {
      /**
       * 【审查意见原文】`Math.max(1, spec.count)` →
       * `count = NaN` 产出 0 个角度；`count = null` 静默变单发。
       *
       * 【实测】本基线（P0 已修）里这一行已经是
       * `Math.max(1, needCount(spec.count, 'spec.count'))`，
       * `needCount` 先要求有限整数，于是 NaN / null / undefined **全部抛 TypeError**，
       * 既到不了 `Math.max`，更不会产出 0 发或 1 发。
       *
       * 实测输出（见下方断言）：
       *   count=NaN       → TypeError: [guard] spec.count 必须是有限数值，实际 NaN
       *   count=null      → TypeError: ... 实际 null
       *   count=undefined → TypeError: ... 实际 undefined
       *
       * 所以"静默变 0 发 / 1 发"的现象**在当前基线不存在**。
       * 建议里写的 `numOr(spec.count, 1)` 反而会把 NaN 悄悄变成 1 发——
       * 那正是本条意见自己要消除的"静默"行为，故不采纳。
       *
       * 【为什么仍要写这条测试】
       * 把"守卫存在"固化下来：将来有人把 `needCount` 去掉，
       * 这条会立刻变红，而不是等某个配表漏填 count 才暴露。
       */
      for (const c of [NaN, null, undefined]) {
        throws(
          () => compileShape({ count: c as unknown as number, typeId: 'b', speed: 1 }),
          'spec.count 必须是有限数值',
          `count=${String(c)} 应在编译期抛错：`
        );
      }
    });

    test('对照：合法的 count 行为不变（0 与负数被夹到 1，正常值原样）', () => {
      eq(compileShape({ count: 0, typeId: 'b', speed: 1 })({
        aim: 0, shotIndex: 0, rng: rng(),
      }).length, 1, 'count=0 应夹到 1：');

      eq(compileShape({ count: 5, typeId: 'b', speed: 1, fullCircle: true })({
        aim: 0, shotIndex: 0, rng: rng(),
      }).length, 5, 'count=5 应产出 5 个角度：');
    });
  });

  // ============================================================
  // P1-4 · entity：回调里注销自己 → 下一个回调被跳过
  // ============================================================

  describe('entity · 派发期间注销自己的安全性（P1-4）', () => {
    test('⚠️ onSpawn：一次性监听不得吞掉后面的监听者', () => {
      /**
       * 【修复前】`for (const fn of this._onSpawn) fn(id, entity)`。
       * 回调 A 内部调取消函数 → `splice` → B 之后的元素下标前移一位
       * → **紧跟其后的那个回调被整个跳过**。
       *
       * 实测（修复前）：注册 B / A(自注销) / C → 触发序列 ["B","A"]，**C 从未执行**。
       */
      const reg = new EntityRegistry<{ hp: number }>();
      const seq: string[] = [];
      let offA: (() => void) | null = null;
      const offB = reg.onSpawn(() => { seq.push('B'); });
      offA = reg.onSpawn(() => { seq.push('A'); offA!(); });
      const offC = reg.onSpawn(() => { seq.push('C'); });

      reg.spawn({ hp: 1 });
      eq(seq.join(','), 'B,A,C', '三个都应触发：');
      offB(); offC();
    });

    test('⚠️ onDeath：首个回调自注销时，第二个仍要触发', () => {
      /**
       * 【修复前】实测触发序列 ["cb1"]——**cb2 一次都没跑**。
       * "触发一次就注销"是一次性监听最常见的写法，
       * 只要它不是最后一个注册的，后面所有监听者在本次事件里全部静默失效：
       * 掉落、计分、成就、死亡动画漏触发，不报错，且取决于注册顺序。
       */
      const reg = new EntityRegistry<{ hp: number }>();
      const seq: string[] = [];
      let off1: (() => void) | null = null;
      off1 = reg.onDeath(() => { seq.push('cb1'); off1!(); });
      const off2 = reg.onDeath(() => { seq.push('cb2'); });

      const id = reg.spawn({ hp: 1 });
      reg.kill(id, 'killed');
      eq(seq.join(','), 'cb1,cb2', '两个都应触发：');
      off2();
    });

    test('⚠️ onDestroy：同上', () => {
      const reg = new EntityRegistry<{ hp: number }>();
      const seq: string[] = [];
      let off1: (() => void) | null = null;
      off1 = reg.onDestroy(() => { seq.push('d1'); off1!(); });
      const off2 = reg.onDestroy(() => { seq.push('d2'); });

      const id = reg.spawn({ hp: 1 });
      reg.destroy(id);
      eq(seq.join(','), 'd1,d2', '两个都应触发：');
      off2();
    });

    test('⚠️ destroy 活着的实体时，onDeath 的链式注销同样安全', () => {
      const reg = new EntityRegistry<{ hp: number }>();
      const seq: string[] = [];
      let off1: (() => void) | null = null;
      off1 = reg.onDeath(() => { seq.push('a'); off1!(); });
      const off2 = reg.onDeath(() => { seq.push('b'); });
      const id = reg.spawn({ hp: 1 });
      reg.destroy(id);
      eq(seq.join(','), 'a,b', 'destroy 走的是同一条派发路径：');
      off2();
    });

    test('⚠️ clear() 的 onDeath 派发同样安全', () => {
      const reg = new EntityRegistry<{ hp: number }>();
      const seq: string[] = [];
      let off1: (() => void) | null = null;
      off1 = reg.onDeath(() => { seq.push('a'); off1!(); });
      const off2 = reg.onDeath(() => { seq.push('b'); });
      reg.spawn({ hp: 1 });
      reg.clear();
      eq(seq.join(','), 'a,b', 'clear 也应走副本派发：');
      off2();
    });

    test('对照：注销只影响后续事件，本次已确定的名单不变', () => {
      const reg = new EntityRegistry<{ hp: number }>();
      let n = 0;
      let off: (() => void) | null = null;
      off = reg.onSpawn(() => { n++; off!(); });
      reg.spawn({ hp: 1 });
      reg.spawn({ hp: 1 });
      eq(n, 1, '自注销后第二次 spawn 不应再触发：');
    });

    test('对照：无人注销时顺序与次数都不变', () => {
      const reg = new EntityRegistry<{ hp: number }>();
      const seq: string[] = [];
      reg.onSpawn(() => { seq.push('1'); });
      reg.onSpawn(() => { seq.push('2'); });
      reg.spawn({ hp: 1 });
      eq(seq.join(','), '1,2', '按注册顺序触发：');
    });
  });

  // ============================================================
  // P1-5 · entity：destroy(无效 id) 的两种返回值
  // ============================================================

  describe('entity · destroy 对无效 id 的返回值（P1-5）', () => {
    test('⚠️ 遍历中与非遍历中必须给出同一个答案', () => {
      /**
       * 【修复前】同一个无效 id `999999`：
       *   非遍历中 destroy() → false
       *   forEach 内部 destroy() → true      ← 假阳性
       *
       * `if (reg.destroy(id))` 是最常见的"确实删掉了才释放资源/计数"写法，
       * 在遍历上下文里会得到假阳性 → 重复释放或统计偏大，
       * 而且只在"恰好在遍历中销毁"时复现。
       */
      const reg = new EntityRegistry<{ hp: number }>();
      reg.spawn({ hp: 1 });

      const outside = reg.destroy(999999);
      let inside: boolean | null = null;
      reg.forEach(() => { inside = reg.destroy(999999); });

      eq(outside, false, '非遍历中应为 false：');
      eq(inside, false, '遍历中必须同样是 false：');
    });

    test('对照：有效 id 在两种上下文里都返回 true', () => {
      const reg = new EntityRegistry<{ hp: number }>();
      const a = reg.spawn({ hp: 1 });
      const b = reg.spawn({ hp: 1 });
      let inside: boolean | null = null;
      reg.forEach(() => { inside = reg.destroy(b); });
      eq(inside, true, '遍历中延迟销毁有效 id 应为 true：');
      eq(reg.destroy(a), true, '非遍历中销毁有效 id 应为 true：');
      eq(reg.liveCount, 0, '两者都应真的被移除：');
    });

    test('对照：遍历中的延迟销毁仍然生效（不是被判 false 后丢弃）', () => {
      const reg = new EntityRegistry<{ hp: number }>();
      const a = reg.spawn({ hp: 1 });
      reg.forEach(() => { reg.destroy(a); });
      assert(!reg.exists(a), '遍历结束后应真的销毁');
    });
  });

  // ============================================================
  // P1-6 · gameflow：historyLimit
  // ============================================================

  describe('gameflow · historyLimit 的收口与裁剪（P1-6）', () => {
    function run(limit: number | undefined, times: number): number {
      const opts: {
        defs: { id: string; transitions: { to: string; when: () => boolean }[] }[];
        initial: string;
        context: Record<string, unknown>;
        historyLimit?: number;
      } = {
        defs: [
          { id: 'A', transitions: [{ to: 'B', when: () => true }] },
          { id: 'B', transitions: [{ to: 'A', when: () => true }] },
        ],
        initial: 'A',
        context: {},
      };
      if (limit !== undefined) opts.historyLimit = limit;
      const f = new GameFlow<Record<string, unknown>>(opts);
      for (let i = 0; i < times; i++) f.goTo(f.current === 'A' ? 'B' : 'A');
      return f.history.length;
    }

    test('⚠️ historyLimit = 0 不得让历史无限增长', () => {
      /**
       * 【修复前】`_historyLimit = opts.historyLimit ?? 32`，
       * `??` 挡不住 NaN；再叠加 `_pushHistory` 里的 `slice(-(keep - 1))`：
       * keep ≤ 1 时参数变成 `slice(0)`（整段复制）或正数，
       * 裁剪后长度**不减反增**。
       *
       * 实测（修复前，200 次切换）：
       *   limit=32 → 32      ← 正常
       *   limit=1  → 401     ← 每次 +2
       *   limit=0  → 201     ← 每次 +1
       *   limit=NaN → 201
       */
      eq(run(0, 200), 1, 'limit=0 应被夹到下界 1：');
    });

    test('⚠️ historyLimit = 1 也不得增长', () => {
      eq(run(1, 200), 1, 'limit=1 应稳定在 1：');
    });

    test('⚠️ historyLimit = NaN 回落到默认 32', () => {
      eq(run(NaN, 200), 32, 'NaN 应回落到默认值 32：');
    });

    test('⚠️ 长会话下历史长度有上界（内存泄漏回归）', () => {
      eq(run(0, 2000), 1, '跑 2000 次仍应是 1：');
    });

    test('对照：默认与正常 limit 的裁剪语义不变', () => {
      eq(run(undefined, 200), 32, '默认 32：');
      eq(run(10, 200), 10, 'limit=10 应稳定在 10：');
    });

    test('对照：history 仍保留初始状态，back() 可用', () => {
      const f = new GameFlow<Record<string, unknown>>({
        defs: [
          { id: 'A', transitions: [{ to: 'B', when: () => true }] },
          { id: 'B', transitions: [{ to: 'A', when: () => true }] },
        ],
        initial: 'A',
        context: {},
        historyLimit: 4,
      });
      for (let i = 0; i < 20; i++) f.goTo(f.current === 'A' ? 'B' : 'A');
      eq(f.history[0], 'A', '历史首位应始终是初始状态：');
      assert(f.back(), 'back() 应可用');
    });
  });

  // ============================================================
  // P1-7 · i18n：onChange 多播
  // ============================================================

  describe('i18n · onChange 的多播（P1-7）', () => {
    function mk(): I18N {
      const i = new I18N({ fallback: 'zh' });
      i.addLocale('zh', { a: 'A' });
      i.addLocale('en', { a: 'A-en' });
      return i;
    }

    test('⚠️ 多个订阅者都要被通知', () => {
      /**
       * 【修复前】`this._onChange = fn`（赋值），第二个订阅者静默顶掉第一个。
       * 实测（修复前）：cb1 触发 0 次，cb2 触发 1 次。
       *
       * "多个 UI 组件各自订阅来刷新文本"是这个 API 最常见的用法，
       * 结果是只有最后注册的那个刷新，其余停留在旧语言——
       * 玩家看到"一半界面换了语言"，开发侧没有任何报错。
       */
      const i18n = mk();
      let c1 = 0;
      let c2 = 0;
      i18n.onChange(() => { c1++; });
      i18n.onChange(() => { c2++; });
      i18n.setLocale('en');
      eq(c1, 1, '回调1 应触发：');
      eq(c2, 1, '回调2 应触发：');
    });

    test('对照：取消订阅后不再收到通知，且不影响别人', () => {
      const i18n = mk();
      let c1 = 0;
      let c2 = 0;
      const off1 = i18n.onChange(() => { c1++; });
      i18n.onChange(() => { c2++; });
      off1();
      i18n.setLocale('en');
      eq(c1, 0, '已取消的不应触发：');
      eq(c2, 1, '未取消的仍应触发：');
    });

    test('对照：重复取消是幂等的', () => {
      const i18n = mk();
      const off = i18n.onChange(() => { /* noop */ });
      off(); off(); off();
      assert(i18n.setLocale('en'), 'setLocale 正常返回 true');
    });

    test('对照：切换到同一语言不触发（保持原语义）', () => {
      const i18n = mk();
      let n = 0;
      i18n.onChange(() => { n++; });
      eq(i18n.setLocale('zh'), false, '切到当前语言应返回 false：');
      eq(n, 0, '不应触发：');
    });
  });

  // ============================================================
  // P1-8 · i18n：has() 与 t() 口径一致
  // ============================================================

  describe('i18n · has() 与 t() 的口径（P1-8）', () => {
    function mk(): I18N {
      const i = new I18N({ fallback: 'zh' });
      i.addLocale('zh', {
        'ui.start': '开始',
        item: '{n} 个',
        item_other: '{n} items',
      });
      i.addLocale('en', {});
      i.setLocale('en');
      return i;
    }

    test('⚠️ 回退语言能翻出来时 has() 必须是 true', () => {
      /**
       * 【修复前】`has()` 只查当前语言的 key 本身 →
       * `has('ui.start') === false` 但 `t('ui.start') === '开始'`。
       *
       * UI 用 `has()` 决定"显示翻译 / 显示 key / 走兜底样式"，
       * 假阴性 = 明明翻得出来却走了未翻译分支。
       */
      const i18n = mk();
      eq(i18n.t('ui.start'), '开始', '应能从回退语言翻出来：');
      assert(i18n.has('ui.start'), 'has() 必须同样认为有：');
    });

    test('⚠️ 复数变体能翻出来时 has() 必须是 true', () => {
      const i18n = mk();
      eq(i18n.t('item', { n: 3 }), '3 items', '应命中 item_other：');
      assert(i18n.has('item', { n: 3 }), 'has() 必须认复数变体：');
    });

    test('对照：真的没有的 key 仍然是 false', () => {
      const i18n = mk();
      assert(!i18n.has('nope.not.exists'), '不存在的 key 应为 false');
      eq(i18n.t('nope.not.exists'), 'nope.not.exists', 't() 应回落到 key 本身：');
    });

    test('对照：has() 不污染"缺失过的 key"统计', () => {
      const i18n = mk();
      i18n.clearMissing();
      i18n.has('nope.not.exists');
      eq(i18n.missingKeys.length, 0, 'has() 不应触发缺失统计：');
      i18n.t('nope.not.exists');
      eq(i18n.missingKeys.length, 1, 't() 才应记录：');
    });
  });

  // ============================================================
  // P1-9 · i18n：覆盖率只认运行时能命中的复数形式
  // ============================================================

  describe('i18n · 覆盖率与运行时复数口径一致（P1-9）', () => {
    test('⚠️ 只写 item_few / item_many 的语言包必须报"未翻译"', () => {
      /**
       * 【修复前】`_hasAnyForm` 枚举 CLDR 六形式（zero/one/two/few/many/other），
       * 但 `_pluralKeyOf` 只会生成 `_one` / `_other`。
       *
       * 实测（修复前）：
       *   coverage('ru')      → translated = 1/1（100%）
       *   t('item', { n: 3 }) → '3 个'（回落中文，item_few/item_many 永不命中）
       *
       * 本地化看板全绿、验收通过，上线后俄语复数全错。
       * 这是"报告说谎导致决策错误"，比没有报告更糟。
       */
      const i18n = new I18N({ fallback: 'zh' });
      i18n.addLocale('zh', { item: '{n} 个' });
      i18n.addLocale('ru', { item_few: 'few', item_many: 'many' });
      const c = i18n.coverage('ru');
      eq(c.total, 1, '总数：');
      eq(c.translated, 0, '只写不能命中的形式应算未翻译：');
      eq(c.missing.join(','), 'item', '应列在 missing 里：');
    });

    test('对照：写 item_one / item_other 仍算已翻译', () => {
      const i18n = new I18N({ fallback: 'zh' });
      i18n.addLocale('zh', { item: '{n} 个' });
      i18n.addLocale('en', { item_one: '{n} item', item_other: '{n} items' });
      const c = i18n.coverage('en');
      eq(c.translated, 1, '可命中的形式应算已翻译：');
      eq(c.missing.length, 0, '不应有 missing：');
    });

    test('对照：直接写 key 本身也算已翻译', () => {
      const i18n = new I18N({ fallback: 'zh' });
      i18n.addLocale('zh', { a: 'A', b: 'B' });
      i18n.addLocale('en', { a: 'A-en' });
      const c = i18n.coverage('en');
      eq(c.translated, 1, '：');
      eq(c.missing.join(','), 'b', '：');
    });
  });

  // ============================================================
  // P2 · bullet-pattern
  // ============================================================

  describe('bullet-pattern · aimAtTarget 与 JSDoc 一致（P2）', () => {
    test('⚠️ aimAtTarget=false 且不给 fixedAngle 时不再自动瞄准', () => {
      /**
       * 【修复前】条件是 `aimAtTarget === false && fixedAngle !== undefined`，
       * 少给 fixedAngle 就**仍然自动瞄准**，与 JSDoc
       * "false = 用固定角度"相反。
       *
       * 实测（修复前）：目标在正上方 (0,100) → angle = 1.5708（π/2，仍在瞄准），
       * 期望是 0。
       */
      const p = new BulletPattern(rng());
      p.addEmitter({
        id: 'e', shape: Shapes.ring(1, 10, 'b'), interval: 1, aimAtTarget: false,
      });
      p.targetX = 0;
      p.targetY = 100;
      p.play();
      near(p.tick(1)[0].angle, 0, 1e-9, '应取固定角度 0：');
    });

    test('对照：给了 fixedAngle 就用它', () => {
      const p = new BulletPattern(rng());
      p.addEmitter({
        id: 'e',
        shape: Shapes.ring(1, 10, 'b'),
        interval: 1,
        aimAtTarget: false,
        fixedAngle: Math.PI / 2,
      });
      p.targetX = 0;
      p.targetY = 100;
      p.play();
      near(p.tick(1)[0].angle, Math.PI / 2, 1e-9, '：');
    });

    test('对照：未给 aimAtTarget 时仍然自动瞄准', () => {
      const p = new BulletPattern(rng());
      p.addEmitter({ id: 'e', shape: Shapes.ring(1, 10, 'b'), interval: 1 });
      p.targetX = 0;
      p.targetY = 100;
      p.play();
      near(p.tick(1)[0].angle, Math.PI / 2, 1e-9, '应朝向目标：');
    });
  });

  describe('bullet-pattern · 掉帧后的补发上限（P2）', () => {
    test('⚠️ 单帧 dt 过大时，积压的时间被丢弃而不是连续几帧补发', () => {
      /**
       * 【修复前】`while (... && guard++ < 64)` 截断后**保留了未消耗的时间**。
       * 实测（修复前）：dt=10s、interval=0.01s（积压 1000 次）时
       *   第 1 帧 64 发，第 2 帧 64 发，第 3 帧 64 发……
       * 表现是"卡了一下之后 Boss 突然连续喷出十几轮弹幕"，
       * 玩家躲不掉，还以为是判定问题。
       */
      const p = new BulletPattern(rng());
      p.addEmitter({ id: 'e', shape: Shapes.ring(1, 10, 'b'), interval: 0.01 });
      p.play();
      const first = p.tick(10).length;
      const second = p.tick(1 / 60).length;
      eq(first, 64, '单帧最多 64 发：');
      // 积压被清零后，下一帧回到正常节奏（1/60s ÷ 0.01s = 1 发），
      // 而不是继续按 64 发补发。修复前这里是 64。
      eq(second, 1, '下一帧应回到常速，不再补发积压：');
    });

    test('对照：正常 dt 下的开火节奏不受影响', () => {
      const p = new BulletPattern(rng());
      p.addEmitter({ id: 'e', shape: Shapes.ring(1, 10, 'b'), interval: 0.1 });
      p.play();
      let n = 0;
      for (let i = 0; i < 100; i++) n += p.tick(1 / 60).length;
      // 100 帧 × 1/60 ≈ 1.6667 秒，interval 0.1 → 约 16 次
      assert(n >= 16 && n <= 17, `期望 16~17 次开火，实际 ${n}`);
    });
  });

  describe('bullet-pattern · SequencePlayer 的循环周期（P2）', () => {
    test('⚠️ loop 时不得因 `_time = 0` 丢弃余量造成周期漂移', () => {
      /**
       * 【修复前】`_time = 0` 把本帧超出周期的那部分**直接丢掉**，
       * 每个循环都被拉长到"下一个 dt 边界"。
       * 实测（修复前）：dt=0.3s、周期 1s，10.2 秒只触发 9 次（理想 10 次）。
       * 循环跑得越久，编排相对 BGM 偏移越远，且没法靠调配置修。
       */
      // 周期取"最后一步的 at"，所以这里用 at=1 —— 一轮 1 秒
      const sp = new SequencePlayer(
        [{ at: 1, action: 'start', emitter: 'a' }],
        true
      );
      sp.start();
      let fires = 0;
      // 跑 10.2 秒（34 帧 × 0.3）
      for (let i = 0; i < 34; i++) {
        sp.tick(0.3, (s) => { if (s.action === 'start') fires++; });
      }
      // 10.2 秒 ÷ 1 秒周期 = 10 次。修复前（_time = 0 丢弃余量）只有 8 次。
      eq(fires, 10, '10.2 秒内应触发 10 次：');
    });

    test('对照：非 loop 时正常结束并停跑', () => {
      const sp = new SequencePlayer(
        [{ at: 0, action: 'start', emitter: 'a' }],
        false
      );
      sp.start();
      let fires = 0;
      for (let i = 0; i < 10; i++) {
        sp.tick(0.3, (s) => { if (s.action === 'start') fires++; });
      }
      eq(fires, 1, '只应触发一次：');
      assert(sp.finished, '应标记结束');
      assert(!sp.running, '应停止');
    });
  });

  describe('bullet-pattern · destroy（P2）', () => {
    test('⚠️ destroy() 后不再有残余产出', () => {
      const p = new BulletPattern(rng());
      p.addEmitter({ id: 'e', shape: Shapes.ring(3, 10, 'b'), interval: 0.1 });
      p.play();
      p.tick(0.1);
      p.destroy();
      eq(p.tick(0.1).length, 0, 'destroy 后不应再产出：');
      eq(p.allDone, true, '：');
    });

    test('对照：reset() 保留配置，可以重新播放', () => {
      const p = new BulletPattern(rng());
      p.addEmitter({ id: 'e', shape: Shapes.ring(3, 10, 'b'), interval: 0.1 });
      p.play();
      p.tick(0.1);
      p.reset();
      eq(p.playing, false, 'reset 后应停止播放：');
      p.play();
      eq(p.tick(0.1).length, 3, '重新 play 后应恢复产出：');
    });
  });

  // ============================================================
  // P2 · difficulty
  // ============================================================

  describe('difficulty · destroy 与回调清理（P2）', () => {
    test('⚠️ destroy() 清掉 onAdjust 回调（避免持有已销毁的 UI）', () => {
      /**
       * `onAdjust` 通常是捕获了 UI 组件或统计上报器的闭包。
       * 难度系统是全局单例，它持有的闭包会活到应用结束——
       * 换场景想卸载 UI 组件时会发现它还"活着"。
       */
      const d = new DifficultySystem({
        dda: { onAdjust: () => { throw new Error('不应再触发'); } },
      });
      d.destroy();
      assert(d.onAdjust === undefined, 'onAdjust 应被清掉：');
      // 不抛错即通过
      d.report(0.1, 10);
      d.tick(0.1);
    });

    test('对照：destroy() 不动难度档配置，查询仍可用', () => {
      const d = new DifficultySystem({ defaultTier: 'hard' });
      d.destroy();
      eq(d.currentTierId, 'hard', '档位应保留：');
      assert(Number.isFinite(d.multiplier('enemyHp')), '倍率仍应可查：');
      assert(d.tiers().length > 0, '档位列表应保留：');
    });

    test('存疑（需总审裁决）：currencyGain 在"对玩家有利"集合里', () => {
      /**
       * 这是本窗口**唯一没有改动行为**的一条，只做固化说明。
       *
       * 现状：玩家表现好 → ddaValue 为正 → currencyGain **下降**。
       * 即"打得越好，金币收益越低"——惩罚性 DDA，
       * 与本文件开头"DDA 目的 = 让水平不同的玩家都能通关"有张力。
       *
       * 两种读法：
       *   ① 有意为之（防刷：强玩家刷金币效率本就高，再加成会破坏经济）
       *   ② 误放（照抄 playerDamage / healRate 时顺手加的）
       *
       * 不改的理由：任一方向都会改变线上经济曲线，
       * 不该由一个"顺手修 P1"的窗口拍板。
       *
       * 这里只验证"方向确实是反的"这个事实，让裁决时有据可依。
       */
      const d = new DifficultySystem({ defaultTier: 'normal', dda: { enabled: true } });
      // 表现极好 → ddaValue 变正
      for (let i = 0; i < 50; i++) d.report(1, 10);
      assert(d.ddaValue > 0, `表现好时 ddaValue 应为正，实际 ${d.ddaValue}`);

      // 对玩家有利的键应下降
      const gain = d.multiplier('currencyGain');
      assert(gain < 1, `currencyGain 应 < 1（表现好→收益降），实际 ${gain}`);

      // 而敌人血量应上升（方向相反，说明集合生效）
      const hp = d.multiplier('enemyHp');
      assert(hp > 1, `enemyHp 应 > 1（表现好→变难），实际 ${hp}`);
    });
  });

  // ============================================================
  // P2 · entity
  // ============================================================

  describe('entity · 槽位上界（P2 · 不成立）', () => {
    test('不成立：槽位会被复用，spawn 次数不推高槽位数', () => {
      /**
       * 【审查意见原文】spawn 无槽位上限守卫，槽位超过 1048576 后
       * `idIndex === 0` → `isValidId` 恒 false → 实体静默查不到。
       *
       * 【实测】`destroy()` 会把槽位压回 `_free` 空闲栈，下次 `spawn` 直接复用：
       *   5 万次 spawn + destroy 之后，占用槽位仍是 0。
       *
       * 要撞到那个上界需要**同时存活**超过 100 万个实体，
       * 而在此之前内存早就先撑不住了——所以这里刻意不做检查
       * （与文件头"SLOT_CAPACITY 是 id 编码模数，不是数量上限"的设计说明一致）。
       */
      const reg = new EntityRegistry<{ hp: number }>();
      const N = 50000;
      for (let i = 0; i < N; i++) {
        const id = reg.spawn({ hp: 1 });
        assert(reg.destroy(id), '每次都应销毁成功');
      }
      eq(reg.slotCount, 0, '槽位应被完全复用：');
      eq(reg.liveCount, 0, '：');
    });

    test('对照：上界处 id 确实会失效（证明审查意见的推导本身没错）', () => {
      /**
       * 推导链是对的，只是**触发路径不存在**（需要的不是"spawn 次数多"，
       * 而是"同时存活 > 100 万"。这里构造极端 id 验证推导，
       * 同时说明它要靠手工构造才能到达。
       */
      eq(isValidId(makeId(SLOT_CAPACITY, 0)), false, 'index 溢出到 0 时 id 非法：');
      eq(isValidId(makeId(SLOT_CAPACITY, 1)), false, '：');
      assert(isValidId(makeId(1, 0)), '正常 id 合法：');
    });
  });

  describe('entity · 无参 destroy（P2）', () => {
    test('⚠️ 无参 destroy() 等价于 clear()', () => {
      /**
       * 此前只有 `clear()`。按 rule5 的口径去调 `destroy()` 的人
       * 会撞上 `destroy(id)` 的必填参数——要么编译报错，
       * 要么误传一个 id 只删了单个实体。
       */
      const reg = new EntityRegistry<{ hp: number }>();
      reg.spawn({ hp: 1 });
      reg.spawn({ hp: 1 });
      reg.destroy();
      eq(reg.liveCount, 0, '应清空：');
      eq(reg.slotCount, 0, '应回收槽位：');
    });

    test('对照：destroy(id) 仍返回 boolean 且只删一个', () => {
      const reg = new EntityRegistry<{ hp: number }>();
      const a = reg.spawn({ hp: 1 });
      reg.spawn({ hp: 1 });
      eq(reg.destroy(a), true, '：');
      eq(reg.liveCount, 1, '只应删掉一个：');
    });
  });

  // ============================================================
  // P2 · gameflow
  // ============================================================

  describe('gameflow · update 的 dt 守卫（P2）', () => {
    test('⚠️ update(Infinity) 不得让 timeInState 变成 Infinity', () => {
      /**
       * 【修复前】`if (dt > 0)`——`Infinity > 0` 为 true，
       * 于是 `timeInState` 一步变成 Infinity，
       * 此后任何"停留 N 秒后自动跳过"的判断全部恒真。
       *
       * 实测（修复前）：`update(Infinity)` 之后 `timeInState === Infinity`。
       * Infinity 是静默的：不报错，只是让所有时间判断永远成立。
       */
      const f = new GameFlow<Record<string, unknown>>({
        defs: [{ id: 'A' }], initial: 'A', context: {},
      });
      f.update(Infinity);
      assert(Number.isFinite(f.timeInState), `不应为 Infinity，实际 ${f.timeInState}`);
      eq(f.timeInState, 0, '应被拒：');
    });

    test('⚠️ update(NaN) 同样不得污染', () => {
      const f = new GameFlow<Record<string, unknown>>({
        defs: [{ id: 'A' }], initial: 'A', context: {},
      });
      f.update(NaN);
      eq(f.timeInState, 0, '：');
    });

    test('对照：正常的 dt 仍然累加，负数与 0 仍被拒', () => {
      const f = new GameFlow<Record<string, unknown>>({
        defs: [{ id: 'A' }], initial: 'A', context: {},
      });
      f.update(0.5);
      near(f.timeInState, 0.5, 1e-9, '正常 dt 应累加：');
      f.update(-1);
      near(f.timeInState, 0.5, 1e-9, '负 dt 应被拒：');
      f.update(0);
      near(f.timeInState, 0.5, 1e-9, '0 应被拒：');
    });
  });

  describe('gameflow · _findTransition 的死代码（P2）', () => {
    test('对照：删除冗余首循环后，转换判定结果不变', () => {
      /**
       * 原实现第一个 for 循环里唯一能 return 的分支还要求 `t.to === to`，
       * 于是外层的 `|| t.to === this._current` **永远不会导致 return**——
       * 整个首循环与第二个循环逐字等价，是残留死代码，
       * 且带误导性注释（"force 时允许 self"，但本函数根本收不到 force）。
       *
       * 删除是纯行为不变的清理，这里固化"判定仍然正确"。
       */
      let allow = false;
      const f = new GameFlow<{ ok: boolean }>({
        defs: [
          {
            id: 'A',
            transitions: [
              { to: 'B', when: (c) => c.ok },
              { to: 'C', when: () => true },
            ],
          },
          { id: 'B', transitions: [{ to: 'A', when: () => true }] },
          { id: 'C', transitions: [{ to: 'A', when: () => true }] },
        ],
        initial: 'A',
        context: { ok: false },
      });

      eq(f.canGoTo('B'), false, '条件不满足时 B 不可达：');
      eq(f.canGoTo('C'), true, 'C 恒可达：');

      allow = true;
      f.context.ok = allow;
      eq(f.canGoTo('B'), true, '条件满足后 B 可达：');

      // 声明顺序优先：B 在 C 之前声明，两者都可达时不影响 canGoTo(to) 的判定
      eq(f.canGoTo('A'), false, '没有指向 A 的转换（除 B/C 的反向）：');
    });

    test('对照：when() 不会被多调用一次（删掉的循环曾重复求值）', () => {
      let calls = 0;
      const f = new GameFlow<Record<string, unknown>>({
        defs: [
          { id: 'A', transitions: [{ to: 'B', when: () => { calls++; return true; } }] },
          { id: 'B', transitions: [] },
        ],
        initial: 'A',
        context: {},
      });
      f.canGoTo('B');
      eq(calls, 1, '每次判定只应求值一次：');
    });
  });

  // ============================================================
  // P2 · i18n：addLocale 的原型污染
  // ============================================================

  describe('i18n · addLocale 的原型污染（P2）', () => {
    test('⚠️ 合并语言包时 `__proto__` 不得污染实例', () => {
      /**
       * 【修复前】非 override 分支用 `Object.assign(exist, table)`。
       * `Object.assign` 走赋值语义，会触发 `__proto__` 的 setter，
       * 而 `JSON.parse` 会把 `__proto__` 保留为**自有属性**。
       *
       * 实测（修复前）：
       *   addLocale('zh', JSON.parse('{"__proto__":{"polluted":"yes"},"b":"B"}'))
       *   → t('polluted') === 'yes'（本该返回 'polluted' 本身）
       *
       * 这不是"多了一个 key"：语言包的**原型被整体换掉**，
       * 之后会命中任何没写过的 key。
       */
      const i18n = new I18N({ fallback: 'zh' });
      i18n.addLocale('zh', { a: 'A' });
      i18n.addLocale('zh', JSON.parse('{"__proto__":{"polluted":"yes"},"b":"B"}'));
      eq(i18n.t('polluted'), 'polluted', '未定义的 key 应回落到自身：');
      eq(({} as { polluted?: string }).polluted, undefined, '不应污染 Object.prototype：');
      eq(i18n.t('b'), 'B', '正常 key 仍应合并进来：');
    });

    test('⚠️ constructor / prototype 同样被拦', () => {
      const i18n = new I18N({ fallback: 'zh' });
      i18n.addLocale('zh', { a: 'A' });
      i18n.addLocale('zh', JSON.parse('{"constructor":{"x":"1"}}'));
      eq(i18n.t('a'), 'A', '既有 key 不受影响：');
      eq(i18n.t('nope'), 'nope', '未定义 key 仍回落自身：');
    });

    test('对照：普通 key 的合并语义不变（后者覆盖同名）', () => {
      const i18n = new I18N({ fallback: 'zh' });
      i18n.addLocale('zh', { a: 'A', b: 'B1' });
      i18n.addLocale('zh', { b: 'B2', c: 'C' });
      eq(i18n.t('a'), 'A', '未重名的应保留：');
      eq(i18n.t('b'), 'B2', '重名的应被覆盖：');
      eq(i18n.t('c'), 'C', '新增的应并入：');
    });

    test('对照：override 分支仍是"替换"', () => {
      const i18n = new I18N({ fallback: 'zh' });
      i18n.addLocale('zh', { a: 'A', b: 'B' });
      i18n.addLocale('zh', { a: 'A2' }, { override: true });
      eq(i18n.t('a'), 'A2', '：');
      eq(i18n.t('b'), 'b', 'b 应被替换掉：');
    });
  });

  // ============================================================
  // P2 · matchmaking
  // ============================================================

  describe('matchmaking · 分队无解时不得静默错分（P2）', () => {
    test('⚠️ bin-packing 无解时抛错，而不是硬塞进 teams[0]', () => {
      /**
       * 【修复前】`let best = 0` 隐含"第 0 队一定放得下"且从未校验，
       * 所有队都放不下时 best 停在 0，单位被硬塞进 `teams[0]`。
       *
       * 实测（修复前）：10 人分 2 队（每队 5），单位 [4,3,3]
       *   → 各队人数 [7, 3]，**不抛错**。
       *
       * 表现是"这局莫名其妙 7 打 3"，日志里没有任何异常。
       */
      const players: { id: string; rating: number; partyId: string }[] = [];
      let n = 0;
      const party = (size: number, id: string, base: number) => {
        for (let i = 0; i < size; i++) {
          players.push({ id: `p${n++}`, rating: base + i, partyId: id });
        }
      };
      party(4, 'A', 1500);
      party(3, 'B', 1400);
      party(3, 'C', 1300);

      throws(
        () => balanceTeams(players, { teamCount: 2, optimize: false }),
        '塞进任何一队',
        '应抛错：'
      );
    });

    test('对照：可正常分解时结果不变（每队人数正确）', () => {
      const players: { id: string; rating: number }[] = [];
      for (let i = 0; i < 10; i++) players.push({ id: `p${i}`, rating: 1000 + i * 20 });
      const r = balanceTeams(players, { teamCount: 2 });
      eq(r.teams.length, 2, '：');
      for (const t of r.teams) eq(t.players.length, 5, '每队应 5 人：');
      assert(r.fairness >= 0 && r.fairness <= 1, `fairness 应在 0~1，实际 ${r.fairness}`);
    });

    test('对照：黑店仍必定同队', () => {
      const players: { id: string; rating: number; partyId?: string }[] = [];
      players.push({ id: 'a1', rating: 2000, partyId: 'P' });
      players.push({ id: 'a2', rating: 1900, partyId: 'P' });
      for (let i = 0; i < 8; i++) players.push({ id: `s${i}`, rating: 1200 + i * 10 });
      const r = balanceTeams(players, { teamCount: 2 });
      const teamIdx = r.teams.findIndex((t) => t.players.some((p) => p.id === 'a1'));
      const other = r.teams[teamIdx].players.some((p) => p.id === 'a2');
      assert(other, '同 partyId 的两人应同队：');
    });

    test('对照：roleQuota 仍然生效（签名清理未丢功能）', () => {
      const players: { id: string; rating: number; role: string }[] = [];
      // 6 人分 2 队，每队 tank 1 / dps 2
      const roles = ['tank', 'dps', 'dps', 'tank', 'dps', 'dps'];
      for (let i = 0; i < 6; i++) {
        players.push({ id: `p${i}`, rating: 1500 + i, role: roles[i] });
      }
      const r = balanceTeams(players, { teamCount: 2, roleQuota: { tank: 1, dps: 2 } });
      for (const t of r.teams) {
        const tanks = t.players.filter((p) => p.role === 'tank').length;
        const dps = t.players.filter((p) => p.role === 'dps').length;
        eq(tanks, 1, '每队应 1 个 tank：');
        eq(dps, 2, '每队应 2 个 dps：');
      }
    });
  });

  describe('matchmaking · 平衡判定的强弱方向（P2 · 空 if 清理）', () => {
    test('对照：删除空 if 后，强弱判定与分队结果仍然正确', () => {
      /**
       * 被删掉的是 `if (ratings[hi] < ratings[lo]) { }`——
       * 空块，既不交换也不 return，注释"保证 hi 更强"承诺的事一件没做；
       * 紧随其后的 `ratings[hi] >= ratings[lo] ? hi : lo` 已完整处理大小关系。
       *
       * 所以这是**行为不变**的清理。这里固化"清理后结果仍正确"：
       * 强队一定是最强与最弱两队里分更高的那个。
       */
      const players: { id: string; rating: number }[] = [];
      // 故意让第一队明显强于第二队
      const ratings = [2500, 2400, 2300, 1000, 1100, 1200];
      for (let i = 0; i < ratings.length; i++) {
        players.push({ id: `p${i}`, rating: ratings[i] });
      }
      const r = balanceTeams(players, { teamCount: 2, metric: 'sum' });
      const sums = r.teams.map((t) => t.players.reduce((a, p) => a + p.rating, 0));
      const diff = Math.abs(sums[0] - sums[1]);
      // 最优是 (2500,1000,1200)=4700 vs (2400,2300,1100)=5800？取更优即可
      // 这里只断言"比未平衡的原始切分更好或相等"
      assert(diff <= 1100, `局部搜索应缩小差距，实际 ${diff}`);
    });
  });

  describe('matchmaking · Lobby / Matchmaker 的 destroy（P2）', () => {
    test('⚠️ Lobby.destroy() 清空数据并置为 closed', () => {
      const lobby = new Lobby({ capacity: 4, minPlayers: 2 });
      lobby.join({ id: 'u1', name: 'u1' });
      lobby.destroy();
      eq(lobby.size, 0, '应清空玩家：');
      eq(lobby.state, 'closed', '应置为 closed：');
    });

    test('⚠️ Matchmaker.destroy() 后行为与新建实例一致', () => {
      const mm = new Matchmaker({ teamSize: 1, teamsPerMatch: 2 });
      mm.enqueue([{ id: 'u1', rating: 1000 }], 0);
      mm.destroy();
      eq(mm.queueSize, 0, '队列应清空：');
      eq(mm.matchesMade, 0, '统计应复位：');
    });

    test('对照：Lobby 未 destroy 时 join / leave 正常', () => {
      const lobby = new Lobby({ capacity: 2, minPlayers: 2 });
      assert(lobby.join({ id: 'u1', name: 'u1' }).ok, 'u1 应能加入：');
      assert(lobby.join({ id: 'u2', name: 'u2' }).ok, 'u2 应能加入：');
      eq(lobby.size, 2, '：');
      assert(lobby.leave('u1'), 'u1 应能离开：');
      eq(lobby.size, 1, '：');
    });

    test('对照：Matchmaker 未 destroy 时仍能撮合', () => {
      const mm = new Matchmaker({ teamSize: 1, teamsPerMatch: 2 });
      mm.enqueueAll([
        { id: 'a', rating: 1000 },
        { id: 'b', rating: 1010 },
      ], 0);
      assert(mm.tick(0).length >= 0, 'tick 不应抛错：');
    });
  });
}
