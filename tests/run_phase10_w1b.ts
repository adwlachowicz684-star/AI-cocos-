/**
 * tests/run_phase10_w1b.ts —— 精审返工第十批 · 窗口 W1-B
 *
 * 【本窗口的 7 个单元】anticheat / audio / buff / collision / condition / skill-player / spatial
 *
 * 【每条修复配两条用例】
 *   1. 回归用例：修复前**确实会失败**（注释里写了修复前的实测输出）
 *   2. 对照用例：证明正常输入不受影响（防止矫枉过正）
 *
 * 【为什么对照用例和回归用例一样重要】
 * "挡住 NaN"最常见的写法是把合法值一起挡掉。
 * 本文件里每个 NaN 守卫都配了一条"合法边界值仍可通过"的用例，
 * 例如 `masterVolume = 0`（静音）必须保留，不能被误当成非法值夹成 1。
 *
 * 【铁律】tests/run.ts 由总审统一合并注册，本文件不改动它。
 */

import { assert, describe, eq, near, test, throws } from './_framework';

import { SpeedChecker } from '../anticheat/AntiCheat';
import { AudioManager } from '../audio/AudioManager';
import { BgmStack } from '../audio/BGMStack';
import { BuffSystem } from '../buff/BuffSystem';
import { raycastAabb, raycastCircle, satOverlap } from '../collision/Collision';
import { ConditionEngine } from '../condition/ConditionEngine';
import { SkillPlayer } from '../skill-player/SkillPlayer';
import { Track } from '../skill-player/Track';
import { SpatialHash } from '../spatial/SpatialHash';

/** 盒心 (5,0)、半宽半高 10 → x 范围 [-5, 15] */
function boxAt5() {
  return { kind: 'aabb' as const, x: 5, y: 0, hw: 10, hh: 10 };
}

function circleAt5() {
  return { kind: 'circle' as const, x: 5, y: 0, r: 10 };
}

export function runPhase10W1BTests(): void {
  // ==================== P1 · anticheat ====================

  describe('anticheat · P1 SpeedChecker 的 NaN 守卫（模式 A）', () => {
    test('⚠️ NaN 时间戳不得清零 _strikes', () => {
      const c = new SpeedChecker({ maxSpeed: 10, tolerance: 1.1, strikeThreshold: 3 });
      c.push({ x: 0, y: 0, t: 0 });
      c.push({ x: 100, y: 0, t: 1000 });
      c.push({ x: 200, y: 0, t: 2000 });
      eq(c.strikes, 2, '先攒够 2 次连击');
      c.push({ x: 300, y: 0, t: NaN });
      // 修复前：NaN 时间戳穿透 `dtSec <= 0` → speed = NaN → exceeded = false
      // → 走 else 分支 → strikes 被清零（实测 2 → 0）
      eq(c.strikes, 2, 'NaN 时间戳是不合法样本，应跳过不计而非清零');
    });

    test('⚠️ NaN 坐标不得清零 _strikes（dt 守卫挡不住的第二个入口）', () => {
      const c = new SpeedChecker({ maxSpeed: 10, tolerance: 1.1, strikeThreshold: 3 });
      c.push({ x: 0, y: 0, t: 0 });
      c.push({ x: 100, y: 0, t: 1000 });
      c.push({ x: 200, y: 0, t: 2000 });
      eq(c.strikes, 2, '先攒够 2 次连击');
      c.push({ x: NaN, y: 0, t: 3000 });
      // 修复前：dist = NaN，`NaN < minDist` 恒 false → 穿透 → strikes 清零（实测 2 → 0）
      eq(c.strikes, 2, 'NaN 坐标是不合法样本，应跳过不计');
    });

    test('⚠️ 对照：合规样本仍然正常清零（防止矫枉过正）', () => {
      const c = new SpeedChecker({ maxSpeed: 10, tolerance: 1.1, strikeThreshold: 3 });
      c.push({ x: 0, y: 0, t: 0 });
      c.push({ x: 100, y: 0, t: 1000 });
      c.push({ x: 200, y: 0, t: 2000 });
      eq(c.strikes, 2);
      c.push({ x: 201, y: 0, t: 3000 });   // 1 m/s，远低于阈值
      eq(c.strikes, 0, '真的合规就该清零，不能把连击永久挂住');
    });

    test('⚠️ 非法样本不得顶掉基线（否则合法样本会被连带跳过）', () => {
      const c = new SpeedChecker({ maxSpeed: 10, tolerance: 1.1, strikeThreshold: 3 });
      c.push({ x: 0, y: 0, t: 0 });
      c.push({ x: 100, y: 0, t: 1000 });
      eq(c.push({ x: 200, y: 0, t: 2000 })!.exceeded, true);
      // 修复前：`_last` 在守卫之前就被覆盖成 NaN 样本，
      // 于是下一个合法样本的 dt 也是 NaN → 被一起丢掉。
      // 按"合法包 / NaN 包"交替上报即可让检测彻底失明。
      c.push({ x: 300, y: 0, t: NaN });
      const v = c.push({ x: 400, y: 0, t: 3000 });
      assert(v !== null, 'NaN 之后的合法样本必须仍然参与判定');
      eq(v!.exceeded, true, '速度 100/1s 仍应判为超速');
    });

    test('⚠️ destroy() 可用（铁律 5：可卸载）', () => {
      const c = new SpeedChecker({ maxSpeed: 10 });
      c.push({ x: 0, y: 0, t: 0 });
      c.push({ x: 100, y: 0, t: 1000 });
      // 用 as 断言：修复前 SpeedChecker 没有 destroy，
      // 这里会在运行时抛 TypeError → 用例失败（正是我们想要的"修复前会失败"）
      (c as unknown as { destroy(): void }).destroy();
      eq(c.strikes, 0, '无外部资源，destroy 等价于状态归零');
      eq(c.push({ x: 0, y: 0, t: 0 }), null, '之后重新从第一个样本开始');
    });

    test('⚠️ 对照：连续超速仍能攒到阈值并标记', () => {
      const c = new SpeedChecker({ maxSpeed: 10, tolerance: 1.1, strikeThreshold: 3 });
      c.push({ x: 0, y: 0, t: 0 });
      const r1 = c.push({ x: 100, y: 0, t: 1000 });
      const r2 = c.push({ x: 200, y: 0, t: 2000 });
      const r3 = c.push({ x: 300, y: 0, t: 3000 });
      assert(r1 !== null && r2 !== null && r3 !== null);
      assert(r3 !== null && r3.flagged, '第 3 次连续超速应达到 strikeThreshold');
    });
  });

  // ==================== P1 · audio ====================

  describe('audio · P1 masterVolume 非法值收口（模式 B）', () => {
    test('⚠️ masterVolume 为 NaN 时 effectiveVolume 不得返回 NaN', () => {
      const a = new AudioManager({ masterVolume: NaN });
      const h = a.play('x');
      assert(h !== null);
      // 修复前：`clamp(NaN ?? 1, 0, 1)` = NaN → effectiveVolume 返回 NaN
      assert(Number.isFinite(a.effectiveVolume(h.id)), '音量必须是有限数');
      eq(a.effectiveVolume(h.id), 1, '非法值应回落到默认 1');
    });

    test('⚠️ 对照：masterVolume = 0.5 正常生效（防止矫枉过正）', () => {
      const a = new AudioManager({ masterVolume: 0.5 });
      const h = a.play('x');
      assert(h !== null);
      near(a.effectiveVolume(h.id), 0.5, 1e-9);
    });

    test('⚠️ 对照：masterVolume = 0（静音）是合法值，不得被夹成 1', () => {
      const a = new AudioManager({ masterVolume: 0 });
      const h = a.play('x');
      assert(h !== null);
      eq(a.effectiveVolume(h.id), 0, '0 = 静音，是有意义的配置');
    });
  });

  describe('audio · P1 loop 通道占满时新音效被永久拒绝（契约已文档化）', () => {
    test('⚠️ 全部通道被 loop 占满时，一次性音效被拒绝且有统计可查', () => {
      const a = new AudioManager({ maxVoices: 4 });
      for (let i = 0; i < 4; i++) a.play('loop' + i, { loop: true });
      const h = a.play('normal');
      eq(h, null, 'loop 不可被抢占（既有契约，README 已写明）');
      eq(a.stats.rejected, 1, '被拒必须有统计，否则调用方无从排查');
    });

    test('⚠️ P2：describe() 的段落之间必须有分隔符', () => {
      const a = new AudioManager({ maxVoices: 8 });
      a.play('sfx1');
      const s = a.describe();
      // 报告描述的现象是"待播 0分类 [sfx:3]"（缺分隔符）。
      // 实测当前实现已有 \n：这里锁住它，防止后续改动把换行删掉。
      assert(!s.includes('待播 0分类'), `段落之间必须有换行，实际：${JSON.stringify(s)}`);
      assert(s.includes('\n'), 'describe 必须是多行文本');
    });

    test('⚠️ 对照：预留非 loop 通道后一次性音效正常播放', () => {
      const a = new AudioManager({ maxVoices: 4 });
      for (let i = 0; i < 3; i++) a.play('loop' + i, { loop: true });
      const h = a.play('normal');
      assert(h !== null, '留一个通道给一次性音效即可正常播放');
      eq(a.stats.rejected, 0);
    });
  });

  describe('audio · P1 BgmStack.setState 的原型链守卫', () => {
    test('⚠️ setState("toString") 必须拒绝，不得静音全部层', () => {
      const bgm = new BgmStack({
        layers: [{ name: 'base' }, { name: 'drum' }],
        states: { calm: { base: 1, drum: 0 }, battle: { base: 1, drum: 1 } },
        initialState: 'calm',
        transitionMs: 100,
      });
      // 修复前：`'toString' in states` 命中 Object.prototype → 返回 true，
      // 随后 mix 全取 0 → 所有层被静音且不报错
      throws(() => bgm.setState('toString'), '未知状态');
      eq(bgm.state, 'calm', '非法状态不得改变当前状态');
    });

    test('⚠️ setState("constructor") 同样必须拒绝', () => {
      const bgm = new BgmStack({
        layers: [{ name: 'base' }],
        states: { calm: { base: 1 } },
        initialState: 'calm',
      });
      throws(() => bgm.setState('constructor'), '未知状态');
    });

    test('⚠️ 对照：合法状态切换正常（防止矫枉过正）', () => {
      const bgm = new BgmStack({
        layers: [{ name: 'base' }, { name: 'drum' }],
        states: { calm: { base: 1, drum: 0 }, battle: { base: 1, drum: 1 } },
        initialState: 'calm',
        transitionMs: 100,
      });
      eq(bgm.setState('battle'), true);
      eq(bgm.state, 'battle');
      bgm.update(200);
      assert(bgm.layerVolume('drum') > 0, '战斗层的鼓点应有音量');
    });
  });

  // ==================== P1 · buff ====================

  describe('buff · P1 import() 恢复 _independent（模式 C）', () => {
    test('⚠️ 独立叠层 buff 读档后层信息不丢失', () => {
      const b = new BuffSystem();
      b.register({ id: 'poison', duration: 5, maxStacks: 3, stackMode: 'independent' });
      b.apply('poison', 3);
      eq(b.stacks('poison'), 3);
      b.import(b.export());
      // 修复前：_independent 为空 → _syncIndependent 直接 return，聚合视图不再刷新
      eq(b.stacks('poison'), 3, '导入后层数应保留');
      b.update(1);
      eq(b.stacks('poison'), 3, '推进后层数不应乱跳');
    });

    test('⚠️ 读档后继续叠加，层数与"未读档直接叠加"一致', () => {
      const b = new BuffSystem();
      b.register({ id: 'poison', duration: 5, maxStacks: 3, stackMode: 'independent' });
      b.apply('poison', 3);
      b.import(b.export());
      b.apply('poison', 1);

      const ref = new BuffSystem();
      ref.register({ id: 'poison', duration: 5, maxStacks: 3, stackMode: 'independent' });
      ref.apply('poison', 3);
      ref.apply('poison', 1);
      // 修复前：读档后 _independent 为空 → 再叠 1 层变成 1（层数被覆盖）
      eq(b.stacks('poison'), ref.stacks('poison'), '读档后叠加应与未读档一致');
    });

    test('⚠️ 对照：refresh 模式读档行为不变（防止矫枉过正）', () => {
      const b = new BuffSystem();
      b.register({ id: 'atk', duration: 10, maxStacks: 3 });
      b.apply('atk', 2);
      const data = b.export();
      b.import(data);
      eq(b.stacks('atk'), 2);
      near(b.remain('atk'), 10, 1e-9);
    });
  });

  describe('buff · P1 import() 校验 remain / stacks（模式 C）', () => {
    test('⚠️ remain = NaN 不得产出永不消失的永久 buff', () => {
      const b = new BuffSystem();
      b.register({ id: 'poison', duration: 5, maxStacks: 3 });
      b.import([{ id: 'poison', stacks: 1, remain: NaN }]);
      // 修复前：remain = NaN → `remain -= dt` 仍 NaN → `NaN <= 0` 恒 false → 永不过期
      assert(Number.isFinite(b.remain('poison')), 'remain 必须是有限数');
      eq(b.remain('poison'), 5, '非法 remain 应回落到 def.duration');
      for (let i = 0; i < 100; i++) b.update(1);
      eq(b.has('poison'), false, '推进 100 秒后必须过期');
    });

    test('⚠️ stacks 不得超过 maxStacks', () => {
      const b = new BuffSystem();
      b.register({ id: 'poison', duration: 5, maxStacks: 3 });
      // 修复前：import 绕过校验直接写入 → stacks = 999
      b.import([{ id: 'poison', stacks: 999, remain: 5 }]);
      eq(b.stacks('poison'), 3, '层数必须夹到 maxStacks');
    });

    test('⚠️ remain <= 0 的坏数据不得入库', () => {
      const b = new BuffSystem();
      b.register({ id: 'poison', duration: 5 });
      b.import([{ id: 'poison', stacks: 1, remain: 0 }]);
      eq(b.has('poison'), false, 'remain = 0 是坏数据，不是"还有 0 秒"');
    });

    test('⚠️ 对照：合法存档导入后数值分毫不差（防止矫枉过正）', () => {
      const b = new BuffSystem();
      b.register({ id: 'a', duration: 10, maxStacks: 5 });
      b.apply('a', 3);
      b.update(2);
      const snapshot = b.export();
      b.import(snapshot);
      eq(b.stacks('a'), 3);
      near(b.remain('a'), snapshot[0]!.remain, 1e-9, '合法 remain 必须原样保留');
    });
  });

  describe('buff · P2 onChange 多播与 clear 的移除通知', () => {
    test('⚠️ 第二个 onChange 不得顶掉第一个', () => {
      const b = new BuffSystem();
      b.register({ id: 'a', duration: 5 });
      let a = 0;
      let c = 0;
      b.onChange(() => { a++; });
      b.onChange(() => { c++; });
      b.apply('a');
      // 修复前：`this._onChange = fn` 直接赋值 → a = 0、c = 1
      assert(a > 0, '第一个监听器不应失联');
      assert(c > 0, '第二个监听器应生效');
    });

    test('⚠️ 取消订阅只摘掉自己，不影响别人', () => {
      const b = new BuffSystem();
      b.register({ id: 'a', duration: 5 });
      let a = 0;
      let c = 0;
      const off1 = b.onChange(() => { a++; });
      b.onChange(() => { c++; });
      off1();
      b.apply('a');
      eq(a, 0, '取消后不再触发');
      assert(c > 0, '另一个监听器不受影响');
    });

    test('⚠️ clear() 必须逐个发 remove，不能只发一次 clear', () => {
      const b = new BuffSystem();
      b.register({ id: 'a', duration: 5 });
      b.register({ id: 'c', duration: 5 });
      const removed: string[] = [];
      let cleared = 0;
      b.onChange((ch) => {
        if (ch.kind === 'remove') removed.push(ch.id);
        if (ch.kind === 'clear') cleared++;
      });
      b.apply('a');
      b.apply('c');
      b.clear();
      // 修复前：只有 'clear' 一条 → 只监听 remove 的 UI 收不到任何通知
      eq(removed.length, 2, '两个 buff 各自发一次 remove');
      eq(cleared, 1, 'clear 事件保留，只监听 clear 的依赖方不受影响');
    });
  });

  // ==================== P1 · collision ====================

  describe('collision · P1 raycastAabb 起点在内部时的语义统一', () => {
    test('⚠️ 起点在盒内应返回穿出点，与 raycastCircle 一致', () => {
      const ra = raycastAabb(0, 0, 1, 0, boxAt5());
      const rc = raycastCircle(0, 0, 1, 0, circleAt5());
      // 修复前：raycastAabb → hit:false（tmin<0 被判 miss），raycastCircle → hit:true, t:15
      assert(ra.hit, '起点在盒内，射线必然穿过边界');
      assert(rc.hit);
      near(ra.t, rc.t, 1e-9, '同一条射线、同一个形状范围，两者 t 必须一致');
    });

    test('⚠️ 起点在盒内时法线朝外（穿出面）', () => {
      const r = raycastAabb(0, 0, 1, 0, boxAt5());
      assert(r.hit);
      near(r.nx, 1, 1e-9, '从盒内向右穿出，法线应指向 +x');
      near(r.x, 15, 1e-9, '穿出点应在盒的右边界');
    });

    test('⚠️ 对照：起点在盒外仍返回进入点（防止矫枉过正）', () => {
      const r = raycastAabb(-50, 0, 1, 0, boxAt5());
      assert(r.hit);
      near(r.t, 45, 1e-6, '外部起点的行为不得改变');
      near(r.nx, -1, 1e-9, '进入面法线朝向射线来源');
    });

    test('⚠️ 对照：射不中时仍返回 miss', () => {
      const r = raycastAabb(-100, 0, 1, 0, { kind: 'aabb', x: 0, y: 100, hw: 5, hh: 5 });
      eq(r.hit, false, '完全错开的射线不得因为放宽守卫而误判命中');
    });
  });

  describe('collision · P2 satOverlap 共享常量不得被污染', () => {
    test('⚠️ 修改返回值不会污染后续调用', () => {
      const r1 = satOverlap([0, 0, 1, 0, 1, 1], [5, 5, 6, 5, 6, 6]);
      eq(r1.overlap, false);
      assert(Object.isFrozen(r1), '共享常量必须冻结，把静默污染变成当场暴露');
      try { (r1 as { overlap: boolean }).overlap = true; } catch { /* 严格模式下抛错 */ }
      const r2 = satOverlap([0, 0, 1, 0, 1, 1], [5, 5, 6, 5, 6, 6]);
      // 修复前：r1 被改写后 r2.overlap 变成 true → 碰撞检测认为全世界都撞在一起
      eq(r2.overlap, false, '再次调用不得被上一次的写入污染');
    });

    test('⚠️ 对照：真正相交时仍返回 overlap = true', () => {
      const r = satOverlap([0, 0, 2, 0, 2, 2, 0, 2], [1, 1, 3, 1, 3, 3, 1, 3]);
      eq(r.overlap, true);
      assert(r.depth > 0);
    });
  });

  // ==================== P1 · condition ====================

  describe('condition · P1 addStat 的有限性校验', () => {
    test('⚠️ addStat 传入 NaN 必须抛异常（与 setStat 同一契约）', () => {
      const e = new ConditionEngine();
      // 修复前：addStat 不校验 → getStat('x') === NaN 且静默入库
      throws(() => e.addStat('x', NaN), '有限数');
      eq(e.getStat('x'), 0, '抛错后不得写入脏值');
    });

    test('⚠️ addStat 传入 Infinity 同样必须拒绝', () => {
      const e = new ConditionEngine();
      throws(() => e.addStat('x', Infinity), '有限数');
    });

    test('⚠️ 对照：正常累加行为不变（防止矫枉过正）', () => {
      const e = new ConditionEngine();
      eq(e.addStat('k', 2), 2);
      eq(e.addStat('k', 2), 4);
      eq(e.addStat('k', 2), 6);
      eq(e.getStat('k'), 6);
    });

    test('⚠️ 对照：未初始化的 stat 从 0 开始累加', () => {
      const e = new ConditionEngine();
      eq(e.addStat('fresh', 3), 3);
    });
  });

  describe('condition · P1 evaluate 对 NaN 阈值的收口', () => {
    test('⚠️ c.value 为 NaN 时进度不得是 NaN', () => {
      const e = new ConditionEngine();
      e.register({ id: 'c1', conditions: [{ stat: 'x', op: '>=', value: NaN }] });
      e.setStat('x', 5);
      const r = e.evaluate('c1');
      // 修复前：progress = NaN（Math.min(1, Math.max(0, NaN)) 仍是 NaN）
      assert(Number.isFinite(r.progress), '进度必须是有限数，否则 UI 渲染出 NaN%');
      eq(r.progress, 0);
    });

    test('⚠️ 配置缺 value 字段（undefined）同样不得产出 NaN 进度', () => {
      const e = new ConditionEngine();
      e.register({ id: 'c2', conditions: [{ stat: 'x', op: '>=', value: undefined as unknown as number }] });
      e.setStat('x', 5);
      assert(Number.isFinite(e.evaluate('c2').progress));
    });

    test('⚠️ 对照：合法阈值的进度计算分毫不差（防止矫枉过正）', () => {
      const e = new ConditionEngine();
      e.register({ id: 'c3', conditions: [{ stat: 'x', op: '>=', value: 10 }] });
      e.setStat('x', 5);
      near(e.evaluate('c3').progress, 0.5, 1e-9);
      e.setStat('x', 10);
      near(e.evaluate('c3').progress, 1, 1e-9);
    });

    test('⚠️ 对照：value = 0 的零值条件走独立分支，不受影响', () => {
      const e = new ConditionEngine();
      e.register({ id: 'c4', conditions: [{ stat: 'x', op: '<', value: 0 }] });
      e.setStat('x', 5);
      eq(e.evaluate('c4').progress, 0, '不满足应为 0（不是旧的"两个分支都返回 1"）');
      e.setStat('x', -1);
      eq(e.evaluate('c4').progress, 1);
    });
  });

  describe('condition · P2 onComplete 支持多监听器', () => {
    test('⚠️ 第二个 onComplete 不得顶掉第一个', () => {
      const e = new ConditionEngine();
      e.register({ id: 'c', conditions: [{ stat: 'x', op: '>=', value: 1 }] });
      let a = 0;
      let b = 0;
      e.onComplete(() => { a++; });
      e.onComplete(() => { b++; });
      e.setStat('x', 5);
      e.check();
      // 修复前：`this._onComplete = fn` 覆盖 → a = 0、b = 1
      eq(a, 1, '成就系统不应失联');
      eq(b, 1, '任务系统不应失联');
    });

    test('⚠️ 取消订阅只摘掉自己', () => {
      const e = new ConditionEngine();
      e.register({ id: 'c', conditions: [{ stat: 'x', op: '>=', value: 1 }] });
      let a = 0;
      let b = 0;
      const off = e.onComplete(() => { a++; });
      e.onComplete(() => { b++; });
      off();
      e.setStat('x', 5);
      e.check();
      eq(a, 0);
      eq(b, 1);
    });
  });

  // ==================== P1 · skill-player ====================

  describe('skill-player · P1 循环播放的 t=0 事件', () => {
    test('⚠️ 循环时每轮都要触发 t=0 事件', () => {
      const p = new SkillPlayer();
      let n = 0;
      p.register('boom', () => { n++; });
      p.play(new Track({ duration: 1, loop: true, events: [{ t: 0, type: 'boom' }] }));
      eq(n, 1, 'play() 时触发第一次');
      for (let i = 0; i < 130; i++) p.tick(1 / 60);
      // 修复前：回卷后没有补发 → 跨 2 次循环累计仍为 1（期望 3：0s / 1s / 2s）
      eq(n, 3, '2.17 秒跨 2 次回卷，应触发 3 次');
    });

    test('⚠️ 对照：非循环播放只触发一次（防止矫枉过正）', () => {
      const p = new SkillPlayer();
      let n = 0;
      p.register('boom', () => { n++; });
      p.play(new Track({ duration: 1, loop: false, events: [{ t: 0, type: 'boom' }] }));
      for (let i = 0; i < 130; i++) p.tick(1 / 60);
      eq(n, 1, '非循环不得重复触发');
    });

    test('⚠️ 对照：区间中段的事件不因补发而重复', () => {
      const p = new SkillPlayer();
      const hits: number[] = [];
      p.register('mid', () => { hits.push(p.currentTime); });
      p.play(new Track({ duration: 1, loop: true, events: [{ t: 0.5, type: 'mid' }] }));
      for (let i = 0; i < 130; i++) p.tick(1 / 60);
      eq(hits.length, 2, '2.17 秒内 t=0.5 的事件应触发 2 次，不多不少');
    });
  });

  describe('skill-player · P1 过期 SkillHandle.cancel 的归属校验', () => {
    test('⚠️ 旧句柄 cancel 不得停掉正在播放的新轨道', () => {
      const p = new SkillPlayer();
      const mk = (d: number) => new Track({ duration: d, events: [] });
      const h1 = p.play(mk(5));
      p.play(mk(5));
      // 修复前：h1.cancel() 直接调 player.stop(true) → state 变 idle，B 被误停
      h1.cancel();
      eq(p.state, 'playing', '正在播的新轨道必须继续');
      eq(h1.cancelled, true, '句柄自身仍标记为已取消');
    });

    test('⚠️ 当前句柄 cancel 仍能正常停止', () => {
      const p = new SkillPlayer();
      const h = p.play(new Track({ duration: 5, events: [] }));
      h.cancel();
      eq(p.state, 'idle', '归属正确的 cancel 必须生效');
    });

    test('⚠️ 对照：play 新轨道仍会停掉旧轨道（防止矫枉过正）', () => {
      const p = new SkillPlayer();
      const h1 = p.play(new Track({ duration: 5, events: [] }));
      let ended = false;
      h1.onEnd = () => { ended = true; };
      p.play(new Track({ duration: 5, events: [] }));
      assert(ended, '切轨道时旧轨道的 onEnd 仍应触发');
      eq(p.state, 'playing');
    });
  });

  describe('skill-player · P2 非法 dt 的处理（已文档化）', () => {
    test('⚠️ 非法 dt 不得污染播放时间', () => {
      const p = new SkillPlayer();
      p.play(new Track({ duration: 5, events: [] }));
      p.tick(NaN);
      // 修复前是安全的（step = 0），这里锁住：NaN 不得让 _time 变成 NaN
      assert(Number.isFinite(p.currentTime), '时间被污染会导致所有区间比较恒 false，技能永久卡住');
      eq(p.currentTime, 0, '非法 dt 跳过这一帧');
      eq(p.state, 'playing', '不得因一个坏 dt 提前结束技能');
    });
  });

  // ==================== P1 · spatial ====================

  describe('spatial · P1 queryNearest 的正确性与复杂度', () => {
    test('⚠️ queryNearest 返回真正最近的 k 个（无 O(n) 反查）', () => {
      const sh = new SpatialHash<{ id: number }>({ cellSize: 8 });
      for (let i = 0; i < 500; i++) sh.update('e' + i, i % 50, Math.floor(i / 50), { id: i });
      const near5 = sh.queryNearest(0, 0, 5);
      eq(near5.length, 5);
      eq(near5[0]!.id, 0, '最近的是自己所在位置');
      // 修复前用 `_findEntry` 逐元素全表扫描反查坐标，是 O(k·n)
      assert(!('_findEntry' in (sh as unknown as Record<string, unknown>)), '不应再有全表反查入口');
    });

    test('⚠️ 大数量下 queryNearest 的结果仍然有序', () => {
      const sh = new SpatialHash<{ id: number }>({ cellSize: 4 });
      for (let i = 0; i < 200; i++) sh.update('e' + i, i, 0, { id: i });
      const r = sh.queryNearest(100, 0, 4);
      eq(r.length, 4);
      eq(r[0]!.id, 100);
    });
  });

  describe('spatial · P1/P2 capacity 契约与 update 强转（已文档化）', () => {
    test('⚠️ capacity 声明后未实现：接口注释必须说明（当前行为：不限制）', () => {
      const sh = new SpatialHash<{ id: number }>({ cellSize: 8, capacity: 2 });
      for (let i = 0; i < 10; i++) sh.update('e' + i, i, 0, { id: i });
      // 这一行锁住"当前真实行为"，避免有人误以为已做容量保护。
      // 去留（实现上限 vs 删除字段）已上报总审裁决，见 audit/result_W1-B.md
      eq(sh.itemCount, 10, 'capacity 当前不生效（已在接口 JSDoc 明确写出）');
    });

    test('⚠️ 首次 update 不传 item 时，取回的是 undefined（类型谎言已注释）', () => {
      const sh = new SpatialHash<{ id: number }>({ cellSize: 8 });
      sh.update('e1', 0, 0);
      eq(sh.itemCount, 1, '坐标登记本身成功');
      eq(sh.get('e1'), undefined, '类型上是 T，运行时是 undefined（已在源码注释说明）');
      // 正确用法：带上 item 登记
      sh.update('e1', 0, 0, { id: 1 });
      eq(sh.get('e1')!.id, 1);
    });

    test('⚠️ destroy 存在且能清空', () => {
      const sh = new SpatialHash<{ id: number }>({ cellSize: 8 });
      sh.update('e1', 0, 0, { id: 1 });
      sh.destroy();
      eq(sh.itemCount, 0);
    });
  });
}
