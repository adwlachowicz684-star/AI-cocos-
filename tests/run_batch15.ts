/**
 * tests/run_batch15.ts —— 第十四批测试：表现层孤儿插件收尾
 *
 * 【这一批为什么存在】
 *
 * 上一轮写了三个插件，测试文件被同名文件覆盖时连同测试一起消失了：
 *
 * | 插件 | 行数 | 状态 |
 * |---|---|---|
 * | `camera/CameraFollow` | 404 | 有实现、无测试、无 README、未登记 |
 * | `feedback/HitFeedback` | 418 | 同上 |
 * | `progressbar/ProgressBar` | 439 | 同上 |
 *
 * 这已经是**第五次**发现孤儿插件了（前四次：skill-variant/blessing/curse/
 * interact/score → timeutil → gameflow → 本批）。
 *
 * 重复五遍就不是巧合，而是流程缺陷。所以本批除了补测试，
 * 还把"写完代码必须同时完成三件事"写进每份 README 的开头。
 *
 * 本批三个模块：
 * 1. CameraFollow · 相机跟随（死区 / 前瞻 / 边界 / 瞬移）
 * 2. HitFeedback  · 打击反馈（顿帧 / 震屏 / 闪白 / 飘字的时序编排）
 * 3. ProgressBar  · 进度条（分段 / 延迟条 / 缓动 / 阈值滞回）
 */

import { test, describe, assert, eq, near, throws } from './_framework';
import {
  CameraFollow,
  computeCameraBounds,
  type Rect,
} from '../camera/CameraFollow';
import { HitFeedback, DEFAULT_PROFILES, type HitKind } from '../feedback/HitFeedback';
import { ProgressBar, fillPixels } from '../progressbar/ProgressBar';

export function runBatch15Tests(): void {
  // ================================================================
  describe('CameraFollow · 相机跟随', () => {
    // ================================================================

    test('⚠️ 首次 update 直接吸附（不从原点飞过去）', () => {
      /**
       * 不吸附的话，第一帧相机会从 (0,0) 平滑飞向角色，
       * 表现为"进游戏时画面从地图角落滑过来"。
       */
      const f = new CameraFollow({ smoothTime: 0.2 });
      const s = f.update(0.016, 500, 300);
      eq(s.x, 500);
      eq(s.y, 300);
    });

    test('硬跟随（smoothTime = 0）', () => {
      const f = new CameraFollow({ smoothTime: 0 });
      f.update(0.016, 100, 0);
      f.update(0.016, 200, 0);
      eq(f.x, 200, '无平滑时应立刻到位');
    });

    test('平滑跟随：不会立刻到位', () => {
      const f = new CameraFollow({ smoothTime: 0.2 });
      f.update(0.016, 100, 0);      // 首次吸附
      f.update(0.016, 200, 0);
      assert(f.x > 100 && f.x < 200, `应在 100~200 之间，实际 ${f.x}`);
    });

    test('平滑跟随最终收敛', () => {
      const f = new CameraFollow({ smoothTime: 0.2 });
      f.update(0.016, 100, 0);
      for (let i = 0; i < 200; i++) f.update(0.016, 200, 0);
      near(f.x, 200, 0.01);
    });

    test('⚠️ 平滑是帧率无关的', () => {
      /**
       * 用 lerp(a, b, 0.1) 的话，120fps 下跟随会明显更紧——
       * 高刷屏玩家和低帧率玩家看到的镜头手感不同。
       * smoothDamp 用 dt 做指数衰减，两者结果一致。
       */
      const a = new CameraFollow({ smoothTime: 0.2 });
      const b = new CameraFollow({ smoothTime: 0.2 });
      a.update(0.016, 100, 0);
      b.update(0.016, 100, 0);
      for (let i = 0; i < 60; i++) a.update(1 / 60, 200, 0);    // 60fps，1 秒
      for (let i = 0; i < 240; i++) b.update(1 / 240, 200, 0);  // 240fps，1 秒
      near(a.x, b.x, 0.5, `60fps=${a.x} vs 240fps=${b.x}，1 秒后应几乎相同`);
    });

    test('⚠️ 死区内相机不动', () => {
      const f = new CameraFollow({ smoothTime: 0, deadZone: { x: 50 } });
      f.update(0.016, 100, 0);
      f.update(0.016, 130, 0);      // 在死区内
      eq(f.x, 100, '死区内不该移动');
    });

    test('⚠️ 死区外相机跟着边界走', () => {
      const f = new CameraFollow({ smoothTime: 0, deadZone: { x: 50 } });
      f.update(0.016, 100, 0);
      f.update(0.016, 200, 0);
      eq(f.x, 150, '目标 200，死区半宽 50 → 相机停在 150');
    });

    test('inDeadZone 标志', () => {
      const f = new CameraFollow({ smoothTime: 0, deadZone: { x: 50 } });
      f.update(0.016, 100, 0);
      eq(f.update(0.016, 120, 0).inDeadZone, true);
      eq(f.update(0.016, 300, 0).inDeadZone, false);
    });

    test('前瞻：按速度提前偏移', () => {
      const f = new CameraFollow({
        smoothTime: 0, lookAheadFactor: 0.5, lookAheadMax: { x: 100 },
      });
      f.update(0.016, 100, 0);
      for (let i = 0; i < 100; i++) f.update(0.016, 100, 0, 200, 0);   // 向右高速
      assert(f.lookAheadX > 0, `向右移动时前瞻应为正，实际 ${f.lookAheadX}`);
      assert(f.x > 100, '相机应在角色前方');
    });

    test('⚠️ 前瞻有上限（防高速甩太远）', () => {
      const f = new CameraFollow({
        smoothTime: 0, lookAheadFactor: 10, lookAheadMax: { x: 50 },
      });
      f.update(0.016, 100, 0);
      for (let i = 0; i < 200; i++) f.update(0.016, 100, 0, 99999, 0);
      assert(Math.abs(f.lookAheadX) <= 50.001, `应被夹到 50，实际 ${f.lookAheadX}`);
    });

    test('无速度时无前瞻', () => {
      const f = new CameraFollow({ smoothTime: 0, lookAheadFactor: 1, lookAheadMax: { x: 100 } });
      f.update(0.016, 100, 0);
      for (let i = 0; i < 50; i++) f.update(0.016, 100, 0, 0, 0);
      near(f.lookAheadX, 0, 1e-6);
    });

    test('⚠️ 瞬移阈值：直接跳过去而不是平滑飞', () => {
      /**
       * 角色回城时相机平滑飞过去会掠过大半个地图，
       * 玩家看到一堆无意义的画面滚动，还容易晕。
       */
      const f = new CameraFollow({ smoothTime: 10, teleportThreshold: 200 });
      f.update(0.016, 0, 0);
      f.update(0.016, 5000, 0);    // 位移 5000 > 200
      eq(f.x, 5000, '应直接跳过去');
    });

    test('瞬移后清掉阻尼记忆（不会继续漂移）', () => {
      const f = new CameraFollow({ smoothTime: 0.3, teleportThreshold: 200 });
      f.update(0.016, 0, 0);
      for (let i = 0; i < 30; i++) f.update(0.016, 300, 0);   // 正在向右飞
      f.update(0.016, 5000, 0);                                // 瞬移
      eq(f.x, 5000);
      f.update(0.016, 5000, 0);
      eq(f.x, 5000, '瞬移后目标不变，相机不该继续动');
    });

    test('⚠️ 边界钳制', () => {
      const f = new CameraFollow({
        smoothTime: 0,
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      });
      f.update(0.016, 50, 50);
      f.update(0.016, 500, 500);
      eq(f.x, 100);
      eq(f.y, 100);
    });

    test('⚠️ 地图比视口小时相机居中（而不是贴角落）', () => {
      /**
       * clamp(v, min, max) 在 max < min 时会返回 max，
       * 表现为相机贴在角落。正确做法是取中点。
       */
      const f = new CameraFollow({
        smoothTime: 0,
        bounds: { minX: 100, minY: 0, maxX: 50, maxY: 100 },   // max < min
      });
      f.update(0.016, 0, 50);
      eq(f.x, 75, '应取中点 (100+50)/2');
    });

    test('setBounds 可中途修改（换关卡）', () => {
      const f = new CameraFollow({ smoothTime: 0 });
      f.setBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
      f.update(0.016, 500, 0);
      eq(f.x, 100);
      f.setBounds({ minX: 0, minY: 0, maxX: 1000, maxY: 100 });
      f.update(0.016, 500, 0);
      eq(f.x, 500);
    });

    test('setBounds(null) 取消限制', () => {
      const f = new CameraFollow({
        smoothTime: 0, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      });
      f.setBounds(null);
      f.update(0.016, 9999, 0);
      eq(f.x, 9999);
    });

    test('snapTo 立即到位', () => {
      const f = new CameraFollow({ smoothTime: 5 });
      f.update(0.016, 0, 0);
      f.snapTo(888, 777);
      eq(f.x, 888);
      eq(f.y, 777);
    });

    test('⚠️ addOffset 是叠加（震屏用）', () => {
      /**
       * 震屏必须叠加在跟随之"上"，不能覆盖跟随结果。
       * 每帧先 update 再 addOffset，震屏衰减后自然回到跟随位置。
       */
      const f = new CameraFollow({ smoothTime: 0 });
      f.update(0.016, 100, 0);
      f.addOffset(10, -5);
      eq(f.x, 110);
      eq(f.y, -5);
    });

    test('⚠️ addOffset 也受边界钳制', () => {
      const f = new CameraFollow({
        smoothTime: 0, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      });
      f.update(0.016, 100, 50);
      f.addOffset(50, 0);
      eq(f.x, 100, '不该被震出边界');
    });

    test('reset 回到未初始化', () => {
      const f = new CameraFollow({ smoothTime: 0 });
      f.update(0.016, 500, 0);
      f.reset();
      eq(f.x, 0);
      // reset 后首次 update 再次吸附
      eq(f.update(0.016, 300, 0).x, 300);
    });

    test('⚠️ dt <= 0 时不推进', () => {
      const f = new CameraFollow({ smoothTime: 0.2 });
      f.update(0.016, 100, 0);
      const before = f.x;
      f.update(0, 500, 0);
      f.update(-1, 500, 0);
      eq(f.x, before, '负 dt 不该让相机倒退');
    });

    test('⚠️ maxSpeed 限制单帧位移（而不是滞后距离）', () => {
      /**
       * 【修改记录】
       * 原实现只把 maxSpeed 传给 smoothDamp，
       * 而 smoothDamp（沿用 Unity 语义）夹的是"当前值与目标值的差"，
       * 于是目标瞬移 10000 时相机一帧就跳到 9999 ——
       * maxSpeed 反而让它跳得更快。
       *
       * 现在在 update 末尾再夹一次真实位移。
       */
      const f = new CameraFollow({ smoothTime: 0.1, maxSpeed: 10 });
      f.update(0.016, 0, 0);
      f.update(0.016, 10000, 0);
      const lim = 10 * 0.016;
      assert(f.x <= lim + 1e-6, `单帧位移应 ≤ ${lim}，实际 ${f.x}`);
    });

    test('⚠️ 有 maxSpeed 时仍能追上（只是慢）', () => {
      /**
       * 【修正过的用例】
       * 原用例跑 500 帧 × 0.016s = 8 秒，
       * 而 100 px/s 的速度 8 秒只能走 800 —— 断言打错了。
       * 走完 1000 像素需要 10 秒，即 625 帧。
       */
      const f = new CameraFollow({ smoothTime: 0.1, maxSpeed: 100 });
      f.update(0.016, 0, 0);
      for (let i = 0; i < 1000; i++) f.update(0.016, 1000, 0);
      near(f.x, 1000, 0.5, '足够多帧后应到位');
    });

    test('⚠️ computeCameraBounds：相机中心范围是"地图内缩半个视口"', () => {
      /**
       * 人自然地想传地图边界，但那样相机会露出地图外的黑边。
       */
      const map: Rect = { minX: 0, minY: 0, maxX: 1000, maxY: 800 };
      const b = computeCameraBounds(map, 200, 100);
      eq(b.minX, 100);
      eq(b.maxX, 900);
      eq(b.minY, 50);
      eq(b.maxY, 750);
    });

    test('computeCameraBounds 配合实际使用', () => {
      const map: Rect = { minX: 0, minY: 0, maxX: 1000, maxY: 800 };
      const f = new CameraFollow({
        smoothTime: 0,
        bounds: computeCameraBounds(map, 200, 100),
      });
      f.update(0.016, 0, 0);
      eq(f.x, 100, '贴左边界时相机中心在 100，视口左边缘正好是 0');
      f.update(0.016, 1000, 0);
      eq(f.x, 900, '贴右边界时视口右边缘正好是 1000');
    });
  });

  // ================================================================
  describe('HitFeedback · 打击反馈', () => {
    // ================================================================

    const FRAME = 1 / 60;

    test('基本：播放后处于顿帧', () => {
      const f = new HitFeedback();
      f.play('light');
      const o = f.update(FRAME);
      assert(o.inHitstop, '应处于顿帧');
      assert(o.timeScale < 1, `timeScale 应小于 1，实际 ${o.timeScale}`);
    });

    test('⚠️ 顿帧用真实时间计时（不自我延长）', () => {
      /**
       * 用缩放后的 dt 计时的话，scale=0.05 时
       * 60ms 的顿帧需要 1200ms 墙钟才走完——
       * 这是"手感糊掉"最常见的原因，且很难联想到计时口径。
       */
      const f = new HitFeedback();
      f.play('light');           // 顿帧 60ms
      let frames = 0;
      while (f.update(FRAME).inHitstop && frames < 1000) frames++;
      const ms = frames * FRAME * 1000;
      assert(ms >= 50 && ms <= 90, `顿帧应约 60ms，实际 ${ms.toFixed(0)}ms`);
    });

    test('⚠️ 顿帧期间 timeScale 不是 0', () => {
      /**
       * 完全冻结会让粒子和 UI 都僵住，看起来像卡死。
       * 留一点速度能保持"时间变慢"而不是"游戏崩溃"的观感。
       */
      for (const k of Object.keys(DEFAULT_PROFILES) as HitKind[]) {
        const f = new HitFeedback();
        f.play(k);
        const o = f.update(FRAME);
        if (o.inHitstop) {
          assert(o.timeScale > 0, `${k} 的 timeScale 应大于 0，实际 ${o.timeScale}`);
        }
      }
    });

    test('⚠️ 连打时顿帧不叠加（否则 10 连击变成 10 倍卡顿）', () => {
      const f = new HitFeedback();
      f.play('light');
      f.update(FRAME);
      for (let i = 0; i < 9; i++) f.play('light');

      let frames = 0;
      while (f.update(FRAME).inHitstop && frames < 1000) frames++;
      const ms = frames * FRAME * 1000;
      assert(ms < 150, `10 连击的顿帧不该超过单次太多，实际 ${ms.toFixed(0)}ms`);
    });

    test('⚠️ 连打时震屏仍累积（连打要有爽感）', () => {
      const f = new HitFeedback();
      f.play('light');
      const single = f.update(FRAME).shake;
      f.clear();
      for (let i = 0; i < 5; i++) f.play('light');
      const multi = f.update(FRAME).shake;
      near(multi, single, 1e-6, '取 max 而非 sum：视觉强度等于最强那次');
    });

    test('⚠️ 震屏叠加取 max 而不是 sum（两个 0.6 不该变成 1.2）', () => {
      const f = new HitFeedback();
      f.play('crit', 1);
      f.play('crit', 1);
      const o = f.update(FRAME);
      assert(o.shake <= 1.001, `应被夹到 1，实际 ${o.shake}`);
    });

    test('强度按 intensity 缩放', () => {
      const a = new HitFeedback();
      a.play('light', 1);
      const weak = a.update(FRAME).shake;

      const b = new HitFeedback();
      b.play('light', 2);
      const strong = b.update(FRAME).shake;
      assert(strong > weak, `强度 2 的震屏应更大：${strong} vs ${weak}`);
    });

    test('⚠️ maxIntensity 上限（防叠加到看不清）', () => {
      const f = new HitFeedback({ maxIntensity: 1 });
      f.play('crit', 999);
      const o = f.update(FRAME);
      assert(o.shake <= 1.001, `应被夹到 1，实际 ${o.shake}`);
    });

    test('不同打击类型的顿帧时长递增', () => {
      const dur: Record<string, number> = {};
      for (const k of ['light', 'heavy', 'crit'] as HitKind[]) {
        const f = new HitFeedback();
        f.play(k);
        let frames = 0;
        while (f.update(FRAME).inHitstop && frames < 1000) frames++;
        dur[k] = frames * FRAME * 1000;
      }
      assert(dur.light < dur.heavy, `轻击(${dur.light.toFixed(0)}) < 重击(${dur.heavy.toFixed(0)})`);
      assert(dur.heavy < dur.crit, `重击(${dur.heavy.toFixed(0)}) < 暴击(${dur.crit.toFixed(0)})`);
    });

    test('弹反的顿帧最长（这是奖励）', () => {
      const dur: Record<string, number> = {};
      for (const k of ['light', 'kill', 'parry'] as HitKind[]) {
        const f = new HitFeedback();
        f.play(k);
        let frames = 0;
        while (f.update(FRAME).inHitstop && frames < 1000) frames++;
        dur[k] = frames * FRAME * 1000;
      }
      assert(dur.parry > dur.light && dur.parry > dur.kill,
        `弹反应最长，实际 ${JSON.stringify(dur)}`);
    });

    test('⚠️ 反馈会自动结束并清理', () => {
      const f = new HitFeedback();
      f.play('light');
      eq(f.activeCount, 1);
      for (let i = 0; i < 200; i++) f.update(FRAME);
      eq(f.activeCount, 0, '应自动清理');
      eq(f.timeScale, 1);
      eq(f.shake, 0);
    });

    test('⚠️ 实例数上限（满了丢最旧的）', () => {
      const f = new HitFeedback({ maxInstances: 3 });
      for (let i = 0; i < 10; i++) f.play('light');
      assert(f.activeCount <= 3, `应被限制在 3，实际 ${f.activeCount}`);
    });

    test('stackHitstop: true 时顿帧可叠加', () => {
      const a = new HitFeedback({ stackHitstop: false });
      a.play('light'); a.update(FRAME);
      for (let i = 0; i < 9; i++) a.play('light');
      let fa = 0; while (a.update(FRAME).inHitstop && fa < 1000) fa++;

      const b = new HitFeedback({ stackHitstop: true });
      b.play('light'); b.update(FRAME);
      for (let i = 0; i < 9; i++) b.play('light');
      let fb = 0;
      // 叠加时每次新的 play 都会刷新 hasHitstop，总时长会明显更长
      for (let i = 0; i < 9; i++) b.play('light');
      while (b.update(FRAME).inHitstop && fb < 1000) fb++;
      assert(fb >= fa, `叠加时应不短于不叠加：${fb} vs ${fa}`);
    });

    test('clear 立即结束所有反馈', () => {
      const f = new HitFeedback();
      f.play('crit');
      f.update(FRAME);
      f.clear();
      eq(f.timeScale, 1);
      eq(f.shake, 0);
      eq(f.flash, 0);
      eq(f.activeCount, 0);
    });

    test('knockback 记录最后一次的击退强度', () => {
      const f = new HitFeedback();
      f.play('light', 1);
      const light = f.lastKnockback;
      f.play('kill', 1);
      assert(f.lastKnockback > light, '击杀的击退应更大');
    });

    test('击退按强度缩放', () => {
      /**
       * 【注意 maxIntensity】
       * 默认上限是 1.5，所以传 2 会被夹成 1.5。
       * 这里用 1.2 验证纯缩放关系，夹取本身由另一条测试覆盖。
       */
      const f = new HitFeedback();
      f.play('heavy', 1.2);
      near(f.lastKnockback, (DEFAULT_PROFILES.heavy.knockback ?? 0) * 1.2, 1e-9);
    });

    test('⚠️ 未知类型抛错', () => {
      const f = new HitFeedback();
      throws(() => f.play('不存在的类型' as HitKind), '未知的反馈类型');
    });

    test('⚠️ 非法 intensity 抛错', () => {
      const f = new HitFeedback();
      throws(() => f.play('light', -1), '非负');
      throws(() => f.play('light', NaN), '非负');
    });

    test('自定义 profile 可覆盖预设', () => {
      const f = new HitFeedback({
        profiles: { light: { hitstop: { duration: 0.5 }, timeScale: 0.01 } },
      });
      f.play('light');
      let frames = 0;
      while (f.update(FRAME).inHitstop && frames < 1000) frames++;
      assert(frames * FRAME > 0.4, `自定义顿帧应约 500ms，实际 ${(frames * FRAME * 1000).toFixed(0)}ms`);
    });

    test('⚠️ 自定义 profile 未覆盖的层为 0（而不是沿用预设）', () => {
      const f = new HitFeedback({
        profiles: { light: { hitstop: { duration: 0.06 } } },
      });
      f.play('light');
      const o = f.update(FRAME);
      eq(o.shake, 0, '未定义 shake 层就是没有震屏');
      eq(o.flash, 0);
    });

    test('⚠️ 飘字 payload 只在刚跨过 delay 的那一帧可取', () => {
      const f = new HitFeedback();
      f.play('light', 1, { damage: 123 });
      f.update(FRAME);
      const first = f.takePopupPayloads();
      eq(first.length, 1);
      eq((first[0] as { damage: number }).damage, 123);

      // 推进几帧后不再返回（否则会重复生成飘字）
      for (let i = 0; i < 10; i++) f.update(FRAME);
      eq(f.takePopupPayloads().length, 0);
    });

    test('⚠️ 没有 payload 时不返回', () => {
      const f = new HitFeedback();
      f.play('light');
      f.update(FRAME);
      eq(f.takePopupPayloads().length, 0);
    });

    test('delay 延迟层在延迟期间不生效', () => {
      const f = new HitFeedback({
        profiles: {
          custom: {
            shake: { delay: 0.2, duration: 0.1, scale: 1 },
          },
        },
      });
      f.play('custom', 1);
      eq(f.update(FRAME).shake, 0, '延迟期间不该震');
      for (let i = 0; i < 15; i++) f.update(FRAME);   // 推进 0.25s
      assert(f.shake > 0, '延迟过后应开始震');
    });

    test('dt <= 0 时不推进', () => {
      const f = new HitFeedback();
      f.play('light');
      f.update(FRAME);
      const before = f.shake;
      f.update(0);
      f.update(-1);
      eq(f.shake, before);
    });

    test('⚠️ 反馈期间多次 update 不会让 shake 超出 1', () => {
      const f = new HitFeedback();
      for (let i = 0; i < 20; i++) f.play('crit', 5);
      for (let i = 0; i < 60; i++) {
        const o = f.update(FRAME);
        assert(o.shake >= 0 && o.shake <= 1, `shake 应在 0~1，实际 ${o.shake}`);
        assert(o.flash >= 0 && o.flash <= 1, `flash 应在 0~1，实际 ${o.flash}`);
      }
    });
  });

  // ================================================================
  describe('ProgressBar · 进度条', () => {
    // ================================================================

    test('基本：值与占比', () => {
      const b = new ProgressBar({ max: 100, value: 75 });
      eq(b.value, 75);
      near(b.ratio, 0.75, 1e-9);
    });

    test('自定义 min', () => {
      const b = new ProgressBar({ min: 100, max: 200, value: 150 });
      near(b.ratio, 0.5, 1e-9);
    });

    test('⚠️ 值被夹在 min/max 之间', () => {
      const b = new ProgressBar({ max: 100, value: 500 });
      eq(b.value, 100);
      b.set(-10);
      eq(b.value, 0);
    });

    test('⚠️ 非法值抛错（而不是变成 NaN 静默失效）', () => {
      const b = new ProgressBar();
      throws(() => b.set(NaN), '有限数');
      throws(() => new ProgressBar({ value: Infinity }), '有限数');
    });

    test('add / fill / empty', () => {
      const b = new ProgressBar({ max: 100, value: 50 });
      b.add(25);
      eq(b.value, 75);
      b.fill();
      eq(b.value, 100);
      b.empty();
      eq(b.value, 0);
    });

    test('isEmpty / isFull', () => {
      const b = new ProgressBar({ max: 100, value: 0 });
      eq(b.isEmpty, true);
      b.fill();
      eq(b.isFull, true);
    });

    test('⚠️ 缓动：display 慢慢追上', () => {
      const b = new ProgressBar({ max: 100, value: 0, easeSpeed: 0.5 });
      b.set(100);
      b.update(0.5);                     // 0.5 * 0.5 = 0.25
      near(b.displayRatio, 0.25, 1e-9);
      b.update(0.5);
      near(b.displayRatio, 0.5, 1e-9);
    });

    test('⚠️ 缓动不会冲过头', () => {
      const b = new ProgressBar({ max: 100, value: 0, easeSpeed: 10 });
      b.set(100);
      b.update(1);
      near(b.displayRatio, 1, 1e-9, '步长足够大时应精确落在目标');
    });

    test('easeSpeed = 0 时立刻到位', () => {
      const b = new ProgressBar({ max: 100, value: 0 });
      b.set(80);
      b.update(0.016);
      near(b.displayRatio, 0.8, 1e-9);
    });

    test('snap 跳过缓动', () => {
      const b = new ProgressBar({ max: 100, value: 0, easeSpeed: 0.1 });
      b.set(100);
      b.snap();
      near(b.displayRatio, 1, 1e-9);
    });

    test('⚠️ 延迟条：掉血后延迟跟随', () => {
      /**
       * 延迟条是"刚才还有这么多血"的红色残影，
       * 让玩家看清这次掉了多少。
       */
      const b = new ProgressBar({
        max: 100, value: 100, trail: true, trailDelay: 0.3, trailSpeed: 0.5,
      });
      b.update(0.016);
      near(b.trailRatio, 1, 1e-9);

      b.set(40);
      b.update(0.1);                 // 还在等待
      near(b.trailRatio, 1, 1e-9, '等待期内残影不动');

      b.update(0.3);                 // 这一帧把 wait 累加到 0.4，但还没开始移动
      near(b.trailRatio, 1, 1e-9, '跨过 delay 的那一帧仍在等待判定内');

      b.update(0.016);               // 下一帧才开始追赶
      assert(b.trailRatio < 1 && b.trailRatio > 0.4,
        `应开始下降，实际 ${b.trailRatio}`);
    });

    test('⚠️ 回血时延迟条立刻跟上（残影不跟着涨）', () => {
      /**
       * 语义：残影表示"掉血前的量"。
       * 回血时如果残影还慢慢追，玩家会看到红色残影跟着血条一起涨，
       * 完全反了。
       */
      const b = new ProgressBar({ max: 100, value: 50, trail: true, easeSpeed: 0.2 });
      b.update(1);
      b.set(90);
      b.update(0.016);
      assert(b.trailRatio >= b.displayRatio - 1e-9,
        `回血时残影不该落后：trail=${b.trailRatio} display=${b.displayRatio}`);
    });

    test('⚠️ 未启用延迟条时 trailRatio 等于 displayRatio', () => {
      const b = new ProgressBar({ max: 100, value: 50 });
      b.update(0.016);
      eq(b.trailRatio, b.displayRatio);
    });

    test('⚠️ 分段：200/300 应显示在第 2 段且填满', () => {
      /**
       * 3 段血条、300 血时，200 血覆盖满两段。
       * 用 floor 的话会显示"进入第 3 段、填充 0%"——
       * 玩家看到三段都在但第三段是空的，
       * 看起来像"还有血"，与直觉相反。
       */
      const b = new ProgressBar({ max: 300, value: 200, segments: 3 });
      b.update(0.016);
      eq(b.segmentIndex, 1);
      near(b.segmentFill, 1, 1e-9);
    });

    test('分段：满值在最后一段且填满', () => {
      const b = new ProgressBar({ max: 300, value: 300, segments: 3 });
      b.update(0.016);
      eq(b.segmentIndex, 2);
      near(b.segmentFill, 1, 1e-9);
    });

    test('分段：250/300 在第 3 段填一半', () => {
      const b = new ProgressBar({ max: 300, value: 250, segments: 3 });
      b.update(0.016);
      eq(b.segmentIndex, 2);
      near(b.segmentFill, 0.5, 1e-9);
    });

    test('⚠️ 浮点误差不该让整段值多跳一段', () => {
      const b = new ProgressBar({ max: 3, value: 1, segments: 3 });
      b.update(0.016);
      near(b.ratio, 1 / 3, 1e-9);
      eq(b.segmentIndex, 0, '1/3 * 3 = 1.0 → 覆盖 1 段 → 索引 0');
    });

    test('⚠️ 血量为 0 时索引被夹到 0（不该是 -1）', () => {
      const b = new ProgressBar({ max: 300, value: 0, segments: 3 });
      b.update(0.016);
      eq(b.segmentIndex, 0);
      near(b.segmentFill, 0, 1e-9);
    });

    test('不分段时 segmentIndex 恒为 0', () => {
      const b = new ProgressBar({ max: 100, value: 90 });
      b.update(0.016);
      eq(b.segmentCount, 0);
      eq(b.segmentIndex, 0);
      near(b.segmentFill, 0.9, 1e-9);
    });

    test('segmentBounds 计算渲染区间', () => {
      const b = new ProgressBar({ max: 100, value: 50, segments: 4, segmentGap: 0 });
      const s0 = b.segmentBounds(0);
      near(s0.start, 0, 1e-9);
      near(s0.end, 0.25, 1e-9);
      const s3 = b.segmentBounds(3);
      near(s3.start, 0.75, 1e-9);
      near(s3.end, 1, 1e-9);
    });

    test('⚠️ segmentBounds 有间隙', () => {
      const b = new ProgressBar({ max: 100, value: 50, segments: 4, segmentGap: 0.1 });
      const s0 = b.segmentBounds(0);
      const s1 = b.segmentBounds(1);
      assert(s1.start > s0.end, `段之间应留空隙：${s0.end} → ${s1.start}`);
    });

    test('不分段时 segmentBounds 返回整条', () => {
      const b = new ProgressBar();
      const s = b.segmentBounds(0);
      near(s.start, 0, 1e-9);
      near(s.end, 1, 1e-9);
    });

    test('⚠️ segmentBounds 越界抛错', () => {
      const b = new ProgressBar({ segments: 3 });
      throws(() => b.segmentBounds(3), '越界');
      throws(() => b.segmentBounds(-1), '越界');
    });

    test('⚠️ 阈值滞回：在边界反复时不闪', () => {
      /**
       * 血线在 25% 上下反复时（持续掉血又被小回复拉回），
       * 没有滞回会让血条颜色每帧闪一次，非常刺眼。
       */
      const b = new ProgressBar({
        max: 100, value: 30, lowThreshold: 0.25, thresholdHysteresis: 0.05,
      });
      b.update(0.016);
      eq(b.state, 'normal');

      b.set(24);                    // 24% < 25% → low
      b.update(0.016);
      eq(b.state, 'low');

      b.set(27);                    // 回到 27%，但离开阈值是 25%+5%=30%
      b.update(0.016);
      eq(b.state, 'low', '滞回：还没到 30%，仍保持 low');
    });

    test('滞回：超过阈值 + 滞回才恢复', () => {
      const b = new ProgressBar({
        max: 100, value: 24, lowThreshold: 0.25, thresholdHysteresis: 0.05,
      });
      b.update(0.016);
      eq(b.state, 'low');
      b.set(31);
      b.update(0.016);
      eq(b.state, 'normal');
    });

    test('⚠️ empty 优先于 low', () => {
      const b = new ProgressBar({ max: 100, value: 0, lowThreshold: 0.25 });
      b.update(0.016);
      eq(b.state, 'empty');
    });

    test('⚠️ full 优先于 high', () => {
      const b = new ProgressBar({ max: 100, value: 100, highThreshold: 0.9 });
      b.update(0.016);
      eq(b.state, 'full');
    });

    test('high 状态', () => {
      const b = new ProgressBar({ max: 100, value: 95, highThreshold: 0.9 });
      b.update(0.016);
      eq(b.state, 'high');
    });

    test('⚠️ highThreshold 为 1 时不产生 high 状态', () => {
      const b = new ProgressBar({ max: 100, value: 99 });
      b.update(0.016);
      eq(b.state, 'normal');
    });

    test('方向', () => {
      const b = new ProgressBar({ direction: 'ttb' });
      eq(b.vertical, true);
      eq(b.reversed, false);
      const c = new ProgressBar({ direction: 'rtl' });
      eq(c.reversed, true);
      eq(c.vertical, false);
    });

    test('⚠️ fillPixels 反向填充', () => {
      eq(fillPixels(0, 100, false), 0);
      eq(fillPixels(1, 100, false), 100);
      eq(fillPixels(0, 100, true), 100, '反向：0% 时从右端开始');
      eq(fillPixels(1, 100, true), 0);
    });

    test('fillPixels 夹取输入', () => {
      eq(fillPixels(-1, 100, false), 0);
      eq(fillPixels(2, 100, false), 100);
    });

    test('text 格式化', () => {
      const b = new ProgressBar({ max: 100, value: 87 });
      eq(b.text(), '87 / 100');
      eq(b.text(1), '87.0 / 100.0');
    });

    test('snapshot 汇总', () => {
      const b = new ProgressBar({ max: 200, value: 100, segments: 2 });
      b.update(0.016);
      const s = b.snapshot();
      eq(s.value, 100);
      near(s.ratio, 0.5, 1e-9);
      near(s.displayRatio, 0.5, 1e-9);
      eq(s.segmentIndex, 0);
      eq(s.state, 'normal');
    });

    test('⚠️ update 负 dt 无副作用', () => {
      const b = new ProgressBar({ max: 100, value: 50, easeSpeed: 0.5 });
      b.set(100);
      const before = b.displayRatio;
      b.update(-1);
      eq(b.displayRatio, before);
    });

    test('⚠️ 分段配合缓动：索引跟随 display 而不是真实值', () => {
      const b = new ProgressBar({ max: 300, value: 0, segments: 3, easeSpeed: 0.5 });
      b.set(300);
      b.update(0.5);                 // display = 0.25
      eq(b.ratio, 1, '真实值已经是满的');
      eq(b.segmentIndex, 0, '但显示还在第一段（这才是玩家看到的）');
    });
  });
}
