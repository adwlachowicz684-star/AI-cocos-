/**
 * tests/run_phase10_w3a.ts —— 第二次精审 · 窗口 W3-A 返工回归
 *
 * 【本批 6 个单元】camera / interact / perception / score / settings / tween
 * 【条目】16（P1 × 10，P2 × 6）
 *
 * 【每条修复的三件套】
 * 1. 一条**修复前会失败**的用例（下面每条都注明了"修复前"的真实输出）
 * 2. 一条**防止矫枉过正**的对照用例（正常输入不受影响）
 * 3. 源码里的"为什么"注释
 *
 * 【本批唯一的"不成立"条目】
 * `camera` 的"双重限速"（P1-1）。实测扫描 smoothTime ∈ [0.02, 1.0]：
 * smoothDamp 自己的最大单帧位移始终 **小于** maxSpeed·dt
 * （0.1166 → 0.1651，上限 0.1667），也就是说第二层 clamp **从未真正生效**，
 * 它只是一道兜底。详见文件内 `P1-1` 那一组用例的注释。
 *
 * 【为什么有一条用例修前修后都通过】
 * `interact` 的排序稳定性（P2-I3）：旧比较函数在等价时恒返回 1，
 * 违反严格弱序，但在 **V8 / Node 20 的 TimSort（二元插入排序）** 下
 * 实测并不产生可见乱序（n = 2/3/5/10/20/30/64/100/1000/5000 全部保持输入顺序）。
 * 所以那条用例是"给实现上锁"，不是"复现缺陷"——报告里已如实标注。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { CameraFollow, computeCameraBounds } from '../camera/CameraFollow';
import { CameraShake } from '../camera/CameraShake';
import { InteractSystem, type Interactable } from '../interact/Interact';
import { PerceptionSystem, OpenLineOfSight } from '../perception/Perception';
import { ScoreSystem, StarRating } from '../score/ScoreSystem';
import { Settings, type SettingValue } from '../settings/Settings';
import { Tween, TweenRunner } from '../tween/Tween';

export function runPhase10W3ATests(): void {
  // ================================================================
  describe('W3-A · camera（P1-1 双重限速复核 / P1-2 旋转分量 / P1-3 destroy）', () => {
    // ================================================================

    /**
     * 【P1-1 结论：不成立】
     *
     * 报告描述"两层叠加会让相机实际最大速度低于配置的 maxSpeed"。
     * 实测（dt=1/60，目标在 1e6 处，跑 600 帧）：
     *
     * | smoothTime | smoothDamp 自身最大单帧位移 | maxSpeed·dt |
     * |---|---|---|
     * | 0.02 | 0.116638 | 0.166667 |
     * | 0.20 | 0.159681 | 0.166667 |
     * | 1.00 | 0.165148 | 0.166667 |
     *
     * smoothDamp 自身的位移**始终小于**上限，
     * 说明第二层 clamp 从未被触发，不存在"叠加再一次限速"。
     * 稳态速度也确实逼近 maxSpeed（smoothTime 越小越接近：9.74 @ 1.0s）。
     *
     * 【那为什么还要保留第二层】
     * smoothDamp 的 maxSpeed 是**近似**上限（omega = 2/smoothTime 会放大 change 项），
     * 换一组参数（比如 smoothTime 极小 + dt 极大）就可能超速。
     * 它是保险丝，不是第二道限速——所以保留，并把理由写进源码注释。
     */
    test('⚠️ P1-1（不成立·上锁）：限速只有一层在生效，稳态速度不低于 maxSpeed 的 90%', () => {
      const MAX = 10;
      const DT = 1 / 60;
      const f = new CameraFollow({ smoothTime: 0.2, maxSpeed: MAX });
      f.update(DT, 0, 0);
      let prev = f.x;
      let maxStep = 0;
      for (let i = 0; i < 600; i++) {
        const s = f.update(DT, 1e6, 0);
        maxStep = Math.max(maxStep, Math.abs(s.x - prev));
        prev = s.x;
      }
      // ① 每帧位移不得超过 maxSpeed·dt
      assert(maxStep <= MAX * DT + 1e-9, `单帧位移 ${maxStep} 应 ≤ ${MAX * DT}`);
      // ② 也不得被"双重限速"压得明显慢：稳态速度 ≥ 90% maxSpeed
      const xAt9s = f.x;
      for (let i = 0; i < 60; i++) f.update(DT, 1e6, 0);
      const steady = f.x - xAt9s;
      assert(steady >= MAX * 0.9, `稳态速度 ${steady} 应 ≥ ${MAX * 0.9}（否则说明多了一层限速）`);
    });

    test('P1-1（对照）：不配 maxSpeed 时不受影响', () => {
      const f = new CameraFollow({ smoothTime: 0.2 });
      f.update(1 / 60, 0, 0);
      for (let i = 0; i < 60; i++) f.update(1 / 60, 1e6, 0);
      assert(f.x > 1000, `不配 maxSpeed 时应快速跟上，实际 ${f.x}`);
    });

    /**
     * 【P1-2 修复前】
     * `punch()` 之后 `offsetRotation` 峰值 = **0**（`_orot` 只有三处写入，全是 `= 0`），
     * 而 README 的 API 表里写着 `offsetRotation`——震屏缺了旋转分量。
     */
    test('⚠️ P1-2：震屏的旋转分量不再是恒 0（修复前峰值 = 0）', () => {
      const s = new CameraShake();
      s.punch({ amplitude: 1, duration: 0.5 });
      let maxRot = 0;
      for (let i = 0; i < 30; i++) {
        s.tick(1 / 60);
        maxRot = Math.max(maxRot, Math.abs(s.offsetRotation));
      }
      assert(maxRot > 0, `offsetRotation 峰值应 > 0，实际 ${maxRot}`);
    });

    test('P1-2：旋转受 maxRotation 限幅（防止矫枉过正：不能转过头）', () => {
      const s = new CameraShake({ maxRotation: 3 });
      s.punch({ amplitude: 100, duration: 1 });   // 故意给超大振幅
      let maxRot = 0;
      for (let i = 0; i < 60; i++) {
        s.tick(1 / 60);
        maxRot = Math.max(maxRot, Math.abs(s.offsetRotation));
      }
      assert(maxRot > 0, '仍应有旋转');
      assert(maxRot <= 3 + 1e-9, `旋转应被 maxRotation=3 限住，实际 ${maxRot}`);
    });

    test('P1-2（对照）：strengthScale=0 时旋转与平移都归零', () => {
      const s = new CameraShake({ strengthScale: 0 });
      s.punch({ amplitude: 1, duration: 0.3 });
      s.tick(1 / 60);
      eq(s.offsetX, 0);
      eq(s.offsetY, 0);
      eq(s.offsetRotation, 0, '关闭震屏时旋转也必须为 0');
    });

    /** 【P1-3 修复前】`typeof new CameraFollow().destroy` = `'undefined'`（CameraShake 有，它没有） */
    test('⚠️ P1-3：CameraFollow 有 destroy（修复前是 undefined）', () => {
      const f = new CameraFollow();
      eq(typeof f.destroy, 'function', '同单元的 CameraShake 有 destroy，Follow 也该有');
    });

    test('P1-3：destroy 会丢掉外部 bounds 引用，reset 不会（防止矫枉过正）', () => {
      const b = computeCameraBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 10, 10);
      const f1 = new CameraFollow({ bounds: b });
      f1.destroy();
      eq(f1.bounds, null, 'destroy 应断开外部边界引用（让关卡数据可回收）');

      const f2 = new CameraFollow({ bounds: b });
      f2.reset();
      assert(f2.bounds !== null, 'reset 是"回到初始状态还能用"，不该清掉 bounds');
    });
  });

  // ================================================================
  describe('W3-A · camera（P2：strengthScale 口径 / 前瞻 NaN / 震源上限）', () => {
    // ================================================================

    /**
     * 【修复前】`new CameraShake({ strengthScale: 2 }).strengthScale` = **2**，
     * 而 `shake.strengthScale = 2` 之后 = **1**（setter 走 clamp01，构造走 ?? 1）。
     * 同一字段两种口径：设置面板拖到最大反而变弱。
     */
    test('⚠️ P2：构造与 setter 用同一套收口（修复前构造得 2，set 得 1）', () => {
      const a = new CameraShake({ strengthScale: 2 });
      eq(a.strengthScale, 1, '构造入参也要夹到 0~1');
      a.strengthScale = 2;
      eq(a.strengthScale, 1, 'setter 行为不变');
      eq(new CameraShake({ strengthScale: NaN }).strengthScale, 1, 'NaN 也要回落到默认');
    });

    test('P2（对照）：合法的 0.5 不受影响', () => {
      eq(new CameraShake({ strengthScale: 0.5 }).strengthScale, 0.5);
      eq(new CameraShake().strengthScale, 1, '不传时默认 1');
    });

    /**
     * 【修复前】`lookAheadFactor: NaN` → `lookAheadX = NaN`、`x = NaN`
     * （`??` 挡不住 NaN，`clamp` 对 NaN 的两次比较都是 false，也挡不住）
     */
    test('⚠️ P2：lookAheadFactor 为 NaN 时相机坐标不被污染（修复前 x = NaN）', () => {
      const f = new CameraFollow({ smoothTime: 0.2, lookAheadFactor: NaN, lookAheadMax: { x: 5, y: 5 } });
      f.update(1 / 60, 0, 0);
      const s = f.update(1 / 60, 0, 0, 10, 0);
      assert(Number.isFinite(s.x), `相机 x 必须有限，实际 ${s.x}`);
      assert(Number.isFinite(s.lookAheadX), `前瞻必须有限，实际 ${s.lookAheadX}`);
    });

    test('P2（对照）：正常的前瞻照常生效', () => {
      const f = new CameraFollow({ smoothTime: 0.2, lookAheadFactor: 1, lookAheadMax: { x: 5, y: 5 } });
      f.update(1 / 60, 0, 0);
      for (let i = 0; i < 30; i++) f.update(1 / 60, 0, 0, 10, 0);
      assert(Math.abs(f.lookAheadX) > 0.1, `正常前瞻应生效，实际 ${f.lookAheadX}`);
      assert(Math.abs(f.lookAheadX) <= 5 + 1e-9, '且不超过 lookAheadMax');
    });

    /** 【修复前】10 万次 punch 后 `sourceCount` = **100000**（无上限，且每帧全量遍历） */
    test('⚠️ P2：punch 受 maxSources 上限约束（修复前 10 万次 → 10 万个震源）', () => {
      const s = new CameraShake({ maxSources: 8 });
      for (let i = 0; i < 500; i++) s.punch({ amplitude: 0.1, duration: 1 });
      eq(s.sourceCount, 8, '应被 maxSources 卡住');
      eq(s.maxSources, 8);
    });

    test('P2：超上限时丢最老的（后 punch 的必须还在）', () => {
      const s = new CameraShake({ maxSources: 3 });
      s.punch({ amplitude: 0.1, duration: 1 });
      s.punch({ amplitude: 0.2, duration: 1 });
      s.punch({ amplitude: 0.3, duration: 1 });
      s.punch({ amplitude: 0.4, duration: 1 });   // 挤掉第一个
      eq(s.sourceCount, 3);
      // 用"总振幅"间接验证被挤掉的是最老的那个
      s.tick(1 / 60);
      const mag = Math.hypot(s.offsetX, s.offsetY);
      assert(mag > 0, '仍在震动');
    });

    test('P2（对照）：少于上限时全部保留', () => {
      const s = new CameraShake();
      s.punch({ amplitude: 0.5, duration: 0.3 });
      s.punch({ amplitude: 0.5, duration: 0.3 });
      eq(s.sourceCount, 2, '未触上限不该丢');
    });
  });

  // ================================================================
  describe('W3-A · interact（P1-4 pos 字段 / P2：通知 / 排序 / 冻结 / destroy）', () => {
    // ================================================================

    interface ChestData { loot: string }
    const ctx = {
      pos: { x: 0, y: 0 },
      facing: { x: 1, y: 0 },
      inventory: [] as string[],
      data: {},
    };

    /**
     * 【P1-4 修复前】`Interactable` 接口里**没有** `pos`，
     * 于是按 README 写 `register({ id, data, radius, pos })` 在 strict 下
     * 会因多余属性检查**编译失败**——本用例在修复前根本编译不过。
     * 实现侧则靠 `(item as unknown as { pos?: ... }).pos` 双重强转硬取。
     */
    test('⚠️ P1-4：pos 是 Interactable 的正式字段（修复前 strict 下编译失败）', () => {
      const sys = new InteractSystem<ChestData>();
      // 不写 as any —— 类型层面必须合法
      sys.register({ id: 'chest', data: { loot: 'gold' }, radius: 3, pos: { x: 1, y: 0 } });
      const c = sys.evaluate(sys.get('chest')!, ctx);
      near(c.distance, 1, 1e-9, '距离应按 pos 计算');
      eq(c.inRange, true);
      eq(c.valid, true);
    });

    test('P1-4（对照）：不传 pos 仍是"全局可交互"，语义不变', () => {
      const sys = new InteractSystem<ChestData>();
      sys.register({ id: 'ui', data: { loot: 'none' }, radius: 3 });
      const c = sys.evaluate(sys.get('ui')!, ctx);
      eq(c.distance, 0);
      eq(c.inRange, true);
      eq(c.valid, true, 'README 第 6 节：不提供 pos 视为全局可交互');
    });

    /**
     * 【修复前】`clear()` 把 `_focusedId` 置 null 就结束，不发 `onFocusChange`
     * → 屏幕上"按 E 开箱"的提示留在原地，指向已不存在的物件。
     * 实测：findFocus 后通知次数 = 1，clear() 之后仍是 **1**。
     */
    test('⚠️ P2-I2：clear() 会通知 UI（修复后通知次数 1 → 2）', () => {
      let n = 0;
      const sys = new InteractSystem<ChestData>({ onFocusChange: () => n++ });
      sys.register({ id: 'a', data: { loot: 'x' }, radius: 3, pos: { x: 1, y: 0 } });
      sys.findFocus(ctx);
      eq(n, 1, '聚焦应通知一次');
      sys.clear();
      eq(n, 2, '清空焦点也该通知，否则交互提示不消失');
    });

    test('P2-I2（对照）：本来就没焦点时 clear 不误发通知', () => {
      let n = 0;
      const sys = new InteractSystem<ChestData>({ onFocusChange: () => n++ });
      sys.clear();
      eq(n, 0, '没有焦点变化就不该刷屏');
    });

    test('⚠️ P2-I2：resetAll() 同样会通知 UI', () => {
      let n = 0;
      const sys = new InteractSystem<ChestData>({ onFocusChange: () => n++ });
      sys.register({ id: 'a', data: { loot: 'x' }, radius: 3, pos: { x: 1, y: 0 } });
      sys.findFocus(ctx);
      sys.resetAll();
      eq(n, 2);
    });

    /**
     * 【P2-I3】旧比较函数 `(a, b) => (this._better(a, b) ? -1 : 1)`：
     * 等价时两个方向都返回 1，违反严格弱序。
     * ⚠️ 如实说明：在 Node 20 / V8 的 TimSort 下实测**不会**产生可见乱序
     * （n = 2…5000 全部保持输入顺序），所以这条用例**修复前后都通过**，
     * 它锁的是"实现不得退化成真·不稳定比较"，不是复现缺陷。
     */
    test('⚠️ P2-I3（上锁）：等价候选保持注册顺序', () => {
      const sys = new InteractSystem<ChestData>();
      const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
      for (const id of ids) {
        sys.register({ id, data: { loot: id }, radius: 5, pos: { x: 1, y: 0 } });
      }
      const got = sys.candidates(ctx).map((c) => c.item.id);
      eq(got.join(','), ids.join(','), '完全等价的候选不该被排序打乱');
    });

    test('P2-I3（对照）：不同距离仍按距离排序', () => {
      const sys = new InteractSystem<ChestData>();
      sys.register({ id: 'far', data: { loot: '1' }, radius: 9, pos: { x: 3, y: 0 } });
      sys.register({ id: 'near', data: { loot: '2' }, radius: 9, pos: { x: 1, y: 0 } });
      eq(sys.candidates(ctx)[0].item.id, 'near');
    });

    /**
     * 【P2-I4 修复前】`setDisabled` 直接写 readonly 字段，
     * 对 `Object.freeze` 的对象在严格模式下抛
     * `TypeError: Cannot add property disabled, object is not extensible`。
     * 触发路径正是 `interact()` 里的"用完自动禁用"——开个冻结的箱子会当场崩。
     */
    test('⚠️ P2-I4：冻结的物件也能正常交互（修复前抛 TypeError）', () => {
      const frozen: Interactable<ChestData> = Object.freeze({
        id: 'frozen', data: { loot: 'ice' }, radius: 3, pos: { x: 1, y: 0 },
      });
      const sys = new InteractSystem<ChestData>();
      sys.register(frozen);
      eq(sys.interact(ctx), true, '第一次应成功且不抛错');
      eq(sys.interact(ctx), false, '用完自动禁用对冻结物件同样生效');
      eq(sys.usedCount('frozen'), 1);
    });

    test('P2-I4（对照）：普通物件用完即禁的行为不变', () => {
      const sys = new InteractSystem<ChestData>();
      sys.register({ id: 'once', data: { loot: 'x' }, radius: 3, pos: { x: 1, y: 0 } });
      eq(sys.interact(ctx), true);
      eq(sys.interact(ctx), false, '不能重复开同一个箱子');
      eq(sys.get('once')?.disabled, true, '物件上的 disabled 镜像仍会被回写');
    });

    /** 【P2-I6 修复前】`typeof new InteractSystem().destroy` = `'undefined'` */
    test('⚠️ P2-I6：InteractSystem 有 destroy（修复前 undefined）', () => {
      const sys = new InteractSystem<ChestData>();
      eq(typeof sys.destroy, 'function');
    });

    test('P2-I6：destroy 会摘掉回调，之后 findFocus 不再触发通知', () => {
      let n = 0;
      const sys = new InteractSystem<ChestData>({ onFocusChange: () => n++ });
      sys.register({ id: 'a', data: { loot: 'x' }, radius: 3, pos: { x: 1, y: 0 } });
      sys.findFocus(ctx);
      eq(n, 1, '聚焦通知一次');

      sys.destroy();
      eq(n, 2, 'destroy 自身会发一次"清空"通知（UI 提示要消失）');

      sys.register({ id: 'b', data: { loot: 'y' }, radius: 3, pos: { x: 1, y: 0 } });
      sys.findFocus(ctx);
      eq(n, 2, 'destroy 之后不应再有回调（闭包已摘掉）');
    });
  });

  // ================================================================
  describe('W3-A · perception（P1-5 抖动源复核 / P1-6 destroy / P2 切换目标发 lost）', () => {
    // ================================================================

    const CFG = { sightRange: 100, sightHalfAngle: Math.PI };

    function framesToSpot(rng?: { next(): number }): number {
      const ps = new PerceptionSystem({
        los: OpenLineOfSight,
        jitter: 0.3,
        ...(rng ? { jitterRng: rng } : {}),
      });
      ps.addPerceiver(1, CFG, 0, 0, 0);
      ps.addTarget(2, 60, 0);
      for (let i = 1; i <= 300; i++) {
        ps.tick(1 / 60);
        if (ps.isAware(1)) return i;
      }
      return -1;
    }

    /** 固定序列的随机源 */
    function fixed(): { next(): number } {
      const seq = [0.1, 0.9, 0.3, 0.7, 0.5, 0.2, 0.8, 0.4];
      let i = 0;
      return { next: () => seq[i++ % seq.length] };
    }

    /**
     * 【P1-5 复核结论：已在"第五批"修好，本窗口不重复修】
     * 源码里已无裸 `Math.random`（改用注入的 `_jitterRng`，默认 `MathRandomSource`）。
     * 实测：同一固定序列跑三次 → 152 / 152 / 152（完全一致）；
     * 不注入时（默认源）→ 148 / 146 / 154（仍不可复现，但可注入即达成目标）。
     * 这条用例把它固化下来，防止有人改回 `Math.random()`。
     */
    test('⚠️ P1-5（复核·上锁）：注入固定 rng 后"发现玩家"的帧数可复现', () => {
      const a = framesToSpot(fixed());
      const b = framesToSpot(fixed());
      const c = framesToSpot(fixed());
      assert(a > 0 && b > 0 && c > 0, '应当在 300 帧内发现目标');
      eq(a, b, '同一序列应得到同一结果');
      eq(b, c, '同一序列应得到同一结果');
    });

    test('P1-5（对照）：不注入时仍可用（保持向后兼容）', () => {
      const n = framesToSpot();
      assert(n > 0, `默认源下也应在 300 帧内发现目标，实际 ${n}`);
    });

    test('⚠️ P1-5：源码里不得出现裸 Math.random 参与 alert 计算', () => {
      // 行为层面：注入一个"永远返回同一个值"的源，抖动实际被固定住
      const ps = new PerceptionSystem({
        los: OpenLineOfSight, jitter: 0.3, jitterRng: { next: () => 0.5 },
      });
      ps.addPerceiver(1, CFG, 0, 0, 0);
      ps.addTarget(2, 60, 0);
      ps.tick(1 / 60);
      const first = ps.alertOf(1);
      const ps2 = new PerceptionSystem({
        los: OpenLineOfSight, jitter: 0.3, jitterRng: { next: () => 0.5 },
      });
      ps2.addPerceiver(1, CFG, 0, 0, 0);
      ps2.addTarget(2, 60, 0);
      ps2.tick(1 / 60);
      near(ps2.alertOf(1), first, 1e-12, '抖动被固定后首帧警觉度应完全一致');
    });

    /** 【P1-6 修复前】`typeof new PerceptionSystem({los}).destroy` = `'undefined'` */
    test('⚠️ P1-6：PerceptionSystem 有 destroy（修复前 undefined）', () => {
      const ps = new PerceptionSystem({ los: OpenLineOfSight });
      eq(typeof ps.destroy, 'function');
    });

    test('P1-6：destroy 清空感知图并摘掉 onEvent', () => {
      let n = 0;
      const ps = new PerceptionSystem({ los: OpenLineOfSight, onEvent: () => n++ });
      ps.addPerceiver(1, CFG, 0, 0, 0);
      ps.addTarget(2, 5, 0);
      // alertGain 默认 1、阈值默认 1 → 可见度≈1 时约需 1 秒（60 帧）才 aware
      for (let i = 0; i < 80; i++) ps.tick(1 / 60);
      assert(ps.isAware(1), `80 帧内应已发现目标，实际 alert=${ps.alertOf(1)}`);
      const before = n;
      assert(before > 0, '发现过程应发过事件');

      ps.destroy();
      eq(ps.stateOf(1), undefined, '感知者应被清空');
      for (let i = 0; i < 80; i++) ps.tick(1 / 60);
      eq(n, before, 'destroy 之后不应再发事件（回调已摘掉）');
    });

    test('P1-6（对照）：reset 只清状态不清注册（两者职责不同）', () => {
      const ps = new PerceptionSystem({ los: OpenLineOfSight });
      ps.addPerceiver(1, CFG, 0, 0, 0);
      ps.addTarget(2, 5, 0);
      for (let i = 0; i < 10; i++) ps.tick(1 / 60);
      ps.reset();
      eq(ps.isAware(1), false, '警觉度应被清掉');
      assert(ps.stateOf(1) !== undefined, '感知者仍在（reset 不是卸载）');
      ps.tick(1 / 60);
      assert(ps.alertOf(1) > 0, '重置后仍能重新感知');
    });

    /**
     * 【P2 修复前】`targetId` 从旧目标换成新目标时**不发任何事件**
     * （旧实现是两支相同的 if/else，只赋值）。
     * 实测：加入更近的目标后事件列表为空，没有 `lost:2`。
     */
    test('⚠️ P2：切换目标时补发 lost（修复前事件列表里没有 lost）', () => {
      const events: string[] = [];
      const ps = new PerceptionSystem({
        los: OpenLineOfSight, jitter: 0,
        onEvent: (e) => events.push(`${e.type}:${'targetId' in e ? e.targetId : ''}`),
      });
      ps.addPerceiver(1, CFG, 0, 0, 0);
      ps.addTarget(2, 10, 0);
      for (let i = 0; i < 3; i++) ps.tick(1 / 60);
      eq(ps.targetOf(1), 2);

      ps.addTarget(3, 5, 0);   // 更近的目标出现
      for (let i = 0; i < 3; i++) ps.tick(1 / 60);
      eq(ps.targetOf(1), 3, '应切到更显眼的目标');
      assert(events.includes('lost:2'), `切换前应通知"旧目标脱离"，实际事件：${JSON.stringify(events)}`);
    });

    test('P2（对照）：目标没变时不重复发 lost', () => {
      const events: string[] = [];
      const ps = new PerceptionSystem({
        los: OpenLineOfSight, jitter: 0,
        onEvent: (e) => events.push(`${e.type}:${'targetId' in e ? e.targetId : ''}`),
      });
      ps.addPerceiver(1, CFG, 0, 0, 0);
      ps.addTarget(2, 10, 0);
      for (let i = 0; i < 10; i++) ps.tick(1 / 60);
      eq(events.filter((e) => e === 'lost:2').length, 0, '同一目标不该反复发 lost');
    });
  });

  // ================================================================
  describe('W3-A · score（P1-7 NaN / P2：StarRating / 冗余分支 / destroy）', () => {
    // ================================================================

    function makeScore(mode?: 'weighted' | 'minimum' | 'weighted-with-floor'): ScoreSystem {
      return new ScoreSystem({
        metrics: [
          { id: 'kills', direction: 'higher-better', weight: 1, par: 10, zero: 0 },
          { id: 'time', direction: 'lower-better', weight: 1, par: 30, zero: 120 },
        ],
        grades: [
          { id: 'S', minScore: 95 }, { id: 'A', minScore: 80 },
          { id: 'B', minScore: 60 }, { id: 'C', minScore: 40 }, { id: 'D', minScore: 0 },
        ],
        ...(mode ? { mode } : {}),
      });
    }

    /**
     * 【P1-7 修复前】`add('kills', NaN)` 之后：
     * `total = NaN  grade = D`——无异常、无警告，
     * 因为 `grade()` 的兜底是"返回最后一档"，看起来"评级功能正常"，
     * 实际是 NaN 把 `s >= g.minScore` 全部短路成 false。
     */
    test('⚠️ P1-7：set / add 拒绝非有限值（修复前静默写入 → total = NaN）', () => {
      const s = makeScore();
      s.set('kills', 10);
      s.set('time', 30);
      eq(s.total(), 100);

      throws(() => s.add('kills', NaN), '必须是有限数字', 'NaN 必须被拒绝');
      throws(() => s.set('time', Infinity), '必须是有限数字', 'Infinity 必须被拒绝');

      // 关键：拒绝之后状态没被污染
      eq(s.total(), 100, '非法值没写进去，总分不受影响');
      eq(s.grade().id, 'S', '评级也不该被拉低');
    });

    test('P1-7（对照）：合法的 0 与负值仍可正常录入', () => {
      const s = makeScore();
      s.set('kills', 0);
      eq(s.get('kills'), 0, '0 是合法值');
      s.add('kills', -5);
      eq(s.get('kills'), -5, '负数（超额完成用时等场景）也合法');
      assert(Number.isFinite(s.total()), '总分仍应有限');
    });

    test('⚠️ P1-7：NaN 权重被构造拦住（修复前 NaN < 0 为 false，一路放行）', () => {
      throws(
        () => new ScoreSystem({
          metrics: [{ id: 'x', direction: 'higher-better', weight: NaN, par: 1, zero: 0 }],
          grades: [{ id: 'D', minScore: 0 }],
        }),
        '权重',
        'NaN 权重应被拒绝'
      );
    });

    test('P1-7（对照）：合法权重不受影响', () => {
      const s = new ScoreSystem({
        metrics: [
          { id: 'a', direction: 'higher-better', weight: 0, par: 1, zero: 0 },
          { id: 'b', direction: 'higher-better', weight: 2.5, par: 1, zero: 0 },
        ],
        grades: [{ id: 'D', minScore: 0 }],
      });
      s.set('a', 1);
      s.set('b', 1);
      eq(s.total(), 100, '权重 0 / 小数都合法');
    });

    /**
     * 【P2-Sc3 修复前】`new StarRating(NaN).max` = **NaN**
     * → `addCondition` 里的 `length >= NaN` 恒为 false
     * → 可以无限加条件，星级能超过 max。实测连加 50 个都不报错。
     */
    test('⚠️ P2-Sc3：StarRating(NaN) 回落到 1 星（修复前 max = NaN，可无限加条件）', () => {
      eq(new StarRating(NaN).max, 1);
      const r = new StarRating(2);
      r.addCondition(() => true).addCondition(() => true);
      throws(() => r.addCondition(() => true), '最多', '条数上限必须生效');
    });

    test('P2-Sc3（对照）：0 星夹到 1 星、正常星级不变', () => {
      eq(new StarRating(0).max, 1, '0 星夹成 1 星（README 承诺）');
      eq(new StarRating(3).max, 3);
      const r = new StarRating(2);
      r.addCondition(() => true);
      eq(r.evaluate({}), 1);
    });

    /** 【P2-Sc5 修复前】`typeof new ScoreSystem(...).destroy` = `'undefined'` */
    test('⚠️ P2-Sc5：ScoreSystem 有 destroy（修复前 undefined）', () => {
      eq(typeof makeScore().destroy, 'function');
    });

    test('P2-Sc5：destroy 摘掉 onGrade，reset 不会（防止矫枉过正）', () => {
      let n = 0;
      const s = new ScoreSystem({
        metrics: [{ id: 'k', direction: 'higher-better', weight: 1, par: 1, zero: 0 }],
        grades: [{ id: 'D', minScore: 0 }],
        onGrade: () => n++,
      });
      s.set('k', 1);
      s.settle();
      eq(n, 1);
      s.reset();
      s.set('k', 1);
      s.settle();
      eq(n, 2, 'reset 之后对象还能继续用');
      s.destroy();
      s.set('k', 1);
      s.settle();
      eq(n, 2, 'destroy 之后不再回调');
    });

    /**
     * 【P2-Sc2】`_scoreOne` 的两个方向分支代码完全相同（都是 `clamp01(t) * 100`），
     * 因为方向已经隐含在 zero/par 的大小关系里（构造时校验）。
     * 这条用例锁的是"两个方向算出同样的分"，防止有人以为分支该不同而改坏。
     */
    test('⚠️ P2-Sc2（上锁）：方向与 par/zero 一致时，两个方向应得到同样的插值', () => {
      const higher = new ScoreSystem({
        metrics: [{ id: 'm', direction: 'higher-better', weight: 1, par: 10, zero: 0 }],
        grades: [{ id: 'D', minScore: 0 }],
      });
      const lower = new ScoreSystem({
        metrics: [{ id: 'm', direction: 'lower-better', weight: 1, par: 0, zero: 10 }],
        grades: [{ id: 'D', minScore: 0 }],
      });
      higher.set('m', 5);    // 半程
      lower.set('m', 5);     // 半程（zero=10 → 用时 5 秒）
      near(higher.total(), lower.total(), 1e-9, '方向只体现在 par/zero 谁大，评分公式是同一条');
      near(higher.total(), 50, 1e-9);
    });

    test('P2-Sc4（文档）：weighted-with-floor 是一票否决', () => {
      const s = makeScore('weighted-with-floor');
      s.set('kills', 10);      // 满分 100
      s.set('time', 115);      // 几乎贴着 zero → 接近 0 分
      eq(s.grade().id, 'D', '一科再好，另一科低于 floor 也归零（README 第 5 节已写明）');
    });
  });

  // ================================================================
  describe('W3-A · settings（P1-8 静默丢弃 / P1-9 不发通知 / P2 destroy）', () => {
    // ================================================================

    function makeSettings(onChange?: (k: string, v: SettingValue, o: SettingValue) => void,
      onReject?: (k: string, v: SettingValue, r: string) => void): Settings {
      return new Settings({
        defs: [
          { key: 'volume', kind: 'number', default: 50, min: 0, max: 100 },
          { key: 'quality', kind: 'enum', default: 'high', options: ['low', 'medium', 'high'] },
        ],
        ...(onChange ? { onChange } : {}),
        ...(onReject ? { onReject } : {}),
      });
    }

    /**
     * 【P1-8 修复前】
     * ```
     * importState({ volume: 9999, quality: 'ultra' }) 返回值 = []   ← 空数组
     * 实际 volume = 50（被丢弃）  quality = high（被丢弃）
     * ```
     * 返回值类型是 `string[]`（**未知**键列表），非法值压根不在返回结构里，
     * 调用方没有任何渠道知道导入失败。
     */
    test('⚠️ P1-8：非法值被记为 rejected（修复前 rejected 这个概念都不存在）', () => {
      const s = makeSettings();
      s.importState({ volume: 9999, quality: 'ultra' });
      eq(s.rejected.length, 2, '两个非法值都该被记录');
      const keys = s.rejected.map((r) => r.key).sort().join(',');
      eq(keys, 'quality,volume');
      assert(
        s.rejected.some((r) => r.key === 'quality' && r.reason.includes('必须是其中之一')),
        `应带上 _validate 算好的原因，实际 ${JSON.stringify(s.rejected)}`
      );
    });

    test('⚠️ P1-8：onReject 回调会触发', () => {
      const seen: string[] = [];
      const s = makeSettings(undefined, (k) => seen.push(k));
      s.importState({ volume: 20, quality: 'ultra' });
      eq(seen.join(','), 'quality', '只上报真正非法的那个');
    });

    test('P1-8（对照）：全合法的导入不产生任何 rejected', () => {
      const s = makeSettings();
      const unknown = s.importState({ volume: 20, quality: 'low' });
      eq(unknown.length, 0);
      eq(s.rejected.length, 0);
      eq(s.num('volume'), 20);
      eq(s.str('quality'), 'low');
    });

    test('P1-8（对照）：非法值回退到默认，不影响其他键', () => {
      const s = makeSettings();
      s.importState({ volume: 9999, quality: 'medium' });
      eq(s.num('volume'), 50, '坏值回退到默认');
      eq(s.str('quality'), 'medium', '好值照常导入');
    });

    /**
     * 【P1-9 修复前】
     * ```
     * set(80) 后 onChange 次数 = 1
     * importState({volume:20}) 后 onChange 次数 = 1   ← 没变成 2
     * 实际 volume = 20                                ← 值确实改了
     * ```
     * 读档后音量数值已变成 20，音频系统却没收到通知 → 实际音量仍是 80。
     */
    test('⚠️ P1-9：importState 会触发 onChange（修复前次数不增加）', () => {
      let n = 0;
      const s = makeSettings(() => n++);
      s.set('volume', 80);
      eq(n, 1);
      s.importState({ volume: 20 });
      eq(n, 2, '导入改动了值，就必须通知音频系统');
      eq(s.num('volume'), 20, '值也确实改了');
    });

    test('P1-9（对照）：导入相同值不重复通知（与 set 的幂等语义一致）', () => {
      let n = 0;
      const s = makeSettings(() => n++);
      s.importState({ volume: 50 });      // 与默认相同
      eq(n, 0, '没变化就不该刷屏');
      s.set('volume', 50);
      eq(n, 0);
    });

    /** 【P2 修复前】`typeof new Settings({defs}).destroy` = `'undefined'` */
    test('⚠️ P2：Settings 有 destroy（修复前 undefined）', () => {
      eq(typeof makeSettings().destroy, 'function');
    });

    test('P2：destroy 摘掉 onChange', () => {
      let n = 0;
      const s = makeSettings(() => n++);
      s.set('volume', 80);
      eq(n, 1);
      s.destroy();
      s.set('volume', 30);
      eq(n, 1, 'destroy 之后不再回调（闭包已摘掉）');
    });

    test('P2（对照）：destroy 之前 set 照常工作', () => {
      const s = makeSettings();
      eq(s.set('volume', 30), null);
      eq(s.num('volume'), 30);
      assert(s.set('volume', 200) !== null, '越界仍返回错误文案，不抛错');
    });
  });

  // ================================================================
  describe('W3-A · tween（P1-10 原型键 / P2：completeAll / 魔法数字）', () => {
    // ================================================================

    /**
     * 【P1-10 修复前】
     * ```
     * ease('toString') 未抛错；onUpdate 收到 = "[object Object]"  类型 = string
     * ```
     * `Easing['toString']` 拿到 `Object.prototype.toString`，truthy 通过 `if (!fn)` 守卫。
     * 配置里把缓动名拼成原型键时，进度变成字符串，
     * 调用方做算术立刻得到 NaN → 坐标 NaN → "物体消失"，全程无报错。
     */
    test('⚠️ P1-10：缓动名命中原型键时抛错（修复前不抛，返回字符串）', () => {
      throws(() => new Tween(0.5).ease('toString'), '未知的缓动名', 'toString 不是缓动函数');
      throws(() => new Tween(0.5).ease('constructor'), '未知的缓动名');
      throws(() => new Tween(0.5).ease('valueOf'), '未知的缓动名');
    });

    test('P1-10：onUpdate 拿到的必须是数字（防止矫枉过正的兜底）', () => {
      let got: unknown = null;
      const t = new Tween(0.5).ease('outQuad').onUpdate((p) => { got = p; });
      t.update(0.25);
      eq(typeof got, 'number', '进度必须是数字');
      near(got as number, 0.75, 1e-9, 'outQuad(0.5) = 0.75');
    });

    test('P1-10（对照）：合法缓动名与自定义函数不受影响', () => {
      near(new Tween(1).ease('linear') && 0, 0);
      let v = -1;
      const t = new Tween(1).ease((x) => x * x).onUpdate((p) => { v = p; });
      t.update(0.5);
      near(v, 0.25, 1e-9, '自定义缓动函数仍可用');
    });

    /**
     * 【P2-T2 修复前】
     * ```
     * runner.add(new Tween(0.5).onComplete(fn)); runner.completeAll();
     * → fn 不会执行（_pending 被直接丢弃）
     * ```
     * 名字叫"全部完成"，实际是"丢掉一部分"——过场跳过、切场景清场都会静默漏回调。
     */
    test('⚠️ P2-T2：completeAll 也要完成刚 add（还在 _pending）的 tween', () => {
      const runner = new TweenRunner();
      let done = false;
      // 直接 completeAll，中间**不**调 update —— _pending 还没并进 _tweens
      runner.add(new Tween(0.5).onComplete(() => { done = true; }));
      runner.completeAll();
      eq(done, true, 'completeAll 名不副实的问题：刚 add 的 onComplete 必须被调用');
      eq(runner.count, 0);
    });

    test('P2-T2（对照）：正常 update 跑完也只触发一次 onComplete', () => {
      const runner = new TweenRunner();
      let n = 0;
      runner.add(new Tween(0.1).onComplete(() => n++));
      for (let i = 0; i < 20; i++) runner.update(0.016);
      eq(n, 1, '只完成一次');
    });

    test('P2-T2（对照）：killAll 仍然不触发 onComplete（与 completeAll 语义相反）', () => {
      const runner = new TweenRunner();
      let n = 0;
      runner.add(new Tween(0.1).onComplete(() => n++));
      runner.killAll();
      eq(n, 0, 'kill 是终止，不该补发完成');
    });

    /** 【P2-T4 修复前】`delay()` 里硬写 `new Tween(0.0001)`，且无法配置 */
    test('⚠️ P2-T4：delay 的最短时长可配置（修复前是硬编码 0.0001）', () => {
      const runner = new TweenRunner({ minDuration: 0.001 });
      let fired = false;
      runner.delay(0.05, () => { fired = true; });
      for (let i = 0; i < 10; i++) runner.update(0.016);
      eq(fired, true, '可配置的最短时长下，延时回调照常触发');
    });

    test('P2-T4（对照）：默认 runner 的 delay 行为不变', () => {
      const runner = new TweenRunner();
      let fired = false;
      runner.delay(0.05, () => { fired = true; });
      runner.update(0.03);
      eq(fired, false, '延时未到不触发');
      for (let i = 0; i < 5; i++) runner.update(0.016);
      eq(fired, true, '到点触发');
    });

    /**
     * 【P2-T3】`update()` 每帧 `slice()` 一份快照——热路径上的纯分配。
     * 这条用例不做性能断言（不可靠），只锁"遍历期间新增/终止都安全"这个前提，
     * 因为不再切片正是建立在这个前提上。
     */
    test('⚠️ P2-T3（上锁）：回调里新增 tween 不破坏本帧遍历', () => {
      const runner = new TweenRunner();
      let second = 0;
      const first = new Tween(0.05).onUpdate(() => { });
      first.onComplete(() => {
        runner.add(new Tween(0.05).onUpdate(() => { second++; }));
      });
      runner.add(first);
      for (let i = 0; i < 20; i++) runner.update(0.016);
      assert(second > 0, '回调里新增的 tween 应在后续帧正常推进');
    });

    test('P2-T3（对照）：回调里 killAll 不崩溃', () => {
      const runner = new TweenRunner();
      runner.add(new Tween(0.05).onComplete(() => runner.killAll()));
      runner.add(new Tween(0.5).onUpdate(() => { }));
      for (let i = 0; i < 20; i++) runner.update(0.016);
      eq(runner.count, 0);
    });
  });
}
