/**
 * tests/run_p0.ts —— P0 四个地基插件的测试
 *
 * 【为什么单独一个文件】
 * 原有 run.ts 已 86 项，全塞一起文件太大。按模块拆分后：
 * - 改一个插件只需跑对应测试文件
 * - 失败信息更好定位
 *
 * run.ts 会 import 本文件，所以 `npm test` 仍然一次跑完全部。
 *
 * 【这四个插件为什么必须测】
 * Logger / Scheduler / ConfigLoader / InputManager 都属于
 * **「错了不会抛异常，只会悄悄错」**的类型：
 * - Scheduler 漏一个系统 → 暂停时某个 buff 仍在倒计时（玩家愤怒）
 * - ConfigLoader 校验漏一项 → 三小时后表现为「某个敌人不掉东西」
 * - InputManager 忘清 justPressed → 按一次攻击连放好几次
 * 这些都不报错，只能靠测试拦。
 */

import { Logger, LogLevel } from '../logger/Logger';
import { Assert, AssertionError } from '../logger/Assert';
import { TimeScale } from '../scheduler/TimeScale';
import { Scheduler } from '../scheduler/Scheduler';
import { Validator, ValidationIssue } from '../config/Validator';
import { ConfigLoader, MemoryTableSource } from '../config/ConfigLoader';
import { InputManager, Key } from '../input/InputManager';

import { describe, describeAsync, test, testAsync, assert, eq, near } from './_framework';

export async function runP0Tests(): Promise<void> {
  // ============================================================
  // Logger
  // ============================================================

  describe('Logger · 分级日志与环形缓冲', () => {
    test('分级：低于阈值的只写缓冲不输出', () => {
      const log = new Logger({ level: LogLevel.Warn, bufferSize: 10 });
      const emitted: string[] = [];
      log.addSink((e) => emitted.push(e.message));

      log.debug('m', '调试信息');
      log.info('m', '普通信息');
      log.warn('m', '警告');
      log.error('m', '错误');

      eq(emitted.join(','), '警告,错误');
      eq(log.buffered, 4, '所有级别都应写入缓冲');
    });

    test('环形缓冲按容量覆盖，不无限增长', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferSize: 5 });
      for (let i = 0; i < 20; i++) log.info('m', `msg${i}`);
      eq(log.buffered, 5, '缓冲应固定为 5');
    });

    test('导出按时间顺序（最旧 → 最新）', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferSize: 3 });
      log.info('m', 'a');
      log.info('m', 'b');
      log.info('m', 'c');
      log.info('m', 'd'); // 覆盖掉 a
      log.info('m', 'e'); // 覆盖掉 b

      const out = log.export();
      eq(out.map((e) => e.message).join(','), 'c,d,e', '必须是时间顺序，不是物理顺序');
    });

    test('模块级可单独设置级别', () => {
      const log = new Logger({ level: LogLevel.Error, bufferSize: 20 });
      log.setModuleLevel('network', LogLevel.Debug);

      const emitted: string[] = [];
      log.addSink((e) => emitted.push(`${e.module}:${e.message}`));

      log.debug('combat', '战斗调试');
      log.debug('network', '网络调试');

      eq(emitted.join(','), 'network:网络调试');
    });

    test('exportText 可导出为可读文本（崩溃报告）', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferSize: 10 });
      log.error('combat', '伤害异常', { raw: NaN });
      const text = log.exportText();
      assert(text.includes('ERROR'), text);
      assert(text.includes('combat'), text);
    });

    test('循环引用的数据不会导致导出崩溃', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferSize: 5 });
      const cyclic: Record<string, unknown> = { name: 'x' };
      cyclic.self = cyclic; // 制造循环引用
      log.error('m', '循环数据', cyclic);
      assert(typeof log.exportText() === 'string', '不应抛出');
    });

    test('destroy 后清空缓冲', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferSize: 10 });
      log.info('m', 'x');
      log.destroy();
      eq(log.buffered, 0);
    });

    // ── 以下 8 项针对"用了才知道"的边界 ──

    test('模块级设置优先于全局级别（改全局不会覆盖模块级）', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferSize: 50 });
      log.setModuleLevel('net', LogLevel.Debug);
      log.setLevel(LogLevel.Error); // 全局收紧

      const emitted: string[] = [];
      log.addSink((e) => emitted.push(e.message));
      log.module('net').debug('仍可见');

      eq(emitted.length, 1, '模块级是独立配置，不受全局改动影响');
    });

    test('clearModuleLevel 后回落到全局级别', () => {
      const log = new Logger({ level: LogLevel.Error, bufferSize: 50 });
      log.setModuleLevel('net', LogLevel.Debug);
      const net = log.module('net');

      const emitted: string[] = [];
      log.addSink((e) => emitted.push(e.message));
      net.debug('有模块级时');
      log.clearModuleLevel('net');
      net.debug('清除后');

      eq(emitted.join(','), '有模块级时', '清除后应被全局 Error 阈值挡掉');
    });

    test('addSink 返回取消函数（不用自己留引用）', () => {
      // 【为什么不能用 Silent】
      // Silent 会连 sink 一起挡掉，测试会"假通过"——
      // 就算取消函数没生效，got 也是空的。必须用 Debug 才测得出真行为。
      const log = new Logger({ level: LogLevel.Debug, bufferSize: 5 });
      const got: string[] = [];
      const off = log.addSink((e) => got.push(e.message));

      log.info('m', '1');
      off();
      // 取消后 _sinks 为空，会回退到默认 console sink —— 屏蔽掉避免污染输出
      const origLog = console.log;
      console.log = () => {};
      log.info('m', '2');
      console.log = origLog;

      eq(got.join(','), '1');
    });

    test('多个 sink 都会收到同一条日志', () => {
      const log = new Logger({ level: LogLevel.Debug, bufferSize: 5 });
      const a: string[] = [];
      const b: string[] = [];
      log.addSink((e) => a.push(e.message));
      log.addSink((e) => b.push(e.message));
      log.info('m', 'x');

      eq(a.length, 1);
      eq(b.length, 1, 'sink 是数组，不是单个');
    });

    test('destroy 后 sink 全部解绑（切场景后再打日志不残留）', () => {
      // 同样不能用 Silent：那样 got 天然为空，测不出 destroy 有没有生效
      const log = new Logger({ level: LogLevel.Debug, bufferSize: 5 });
      const got: string[] = [];
      log.addSink((e) => got.push(e.message));
      log.destroy();

      const origLog = console.log;
      console.log = () => {};
      log.info('m', 'after destroy');
      console.log = origLog;

      eq(got.length, 0, 'destroy 清了 _sinks');
    });

    test('有自定义 sink 时不再走默认 console 输出', () => {
      const log = new Logger({ level: LogLevel.Debug, bufferSize: 5 });
      const got: string[] = [];
      log.addSink((e) => got.push(e.message));

      let consoleUsed = false;
      const origInfo = console.info;
      console.info = () => {
        consoleUsed = true;
      };
      log.info('m', 'x');
      console.info = origInfo;

      eq(got.length, 1);
      eq(consoleUsed, false, '_emit 里 _sinks 非空时不会调 _defaultSink');
    });

    test('clearBuffer 只清缓冲，不清 sink', () => {
      const log = new Logger({ level: LogLevel.Debug, bufferSize: 10 });
      const got: string[] = [];
      log.addSink((e) => got.push(e.message));
      log.info('m', 'a');
      log.clearBuffer();
      eq(log.buffered, 0);

      log.info('m', 'b');
      eq(got.join(','), 'a,b', 'sink 仍在，可以继续输出');
    });

    test('setLevel 运行时改级别立即生效', () => {
      const log = new Logger({ level: LogLevel.Error, bufferSize: 20 });
      const got: string[] = [];
      log.addSink((e) => got.push(e.message));

      log.info('m', '被挡');
      eq(got.length, 0);

      log.setLevel(LogLevel.Info);
      log.info('m', '现在能出');
      eq(got.join(','), '现在能出');
    });

    test('级别数值顺序：Trace < Debug < Info < Warn < Error < Silent', () => {
      eq(LogLevel.Trace < LogLevel.Debug, true);
      eq(LogLevel.Debug < LogLevel.Info, true);
      eq(LogLevel.Info < LogLevel.Warn, true);
      eq(LogLevel.Warn < LogLevel.Error, true);
      eq(LogLevel.Error < LogLevel.Silent, true, 'Silent 应最大（挡掉一切）');
    });

    test('Silent 挡掉所有级别，连 error 也不输出', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferSize: 10 });
      const got: string[] = [];
      log.addSink((e) => got.push(e.message));
      log.error('m', '致命');
      log.debug('m', '调试');

      eq(got.length, 0, 'Silent 是最高阈值');
      eq(log.buffered, 2, '但仍写入缓冲——崩溃时要能拿到完整现场');
    });

    test('module() 返回的子日志器带模块名', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferSize: 10 });
      const combat = log.module('combat');
      combat.error('出错了');

      const entries = log.export();
      eq(entries.length, 1);
      eq(entries[0].module, 'combat', '子日志器自动带上模块名，不用每条重复写');
    });
  });

  describe('Assert · 快速失败', () => {
    test('isTrue 失败时抛出 AssertionError', () => {
      let threw = false;
      try {
        Assert.isTrue(false);
      } catch (e) {
        threw = e instanceof AssertionError;
      }
      assert(threw, '应抛出 AssertionError');
    });

    test('notNull 会做类型收窄（编译期）', () => {
      const v: string | null = 'hello';
      Assert.notNull(v);
      // 此后 TS 知道 v 是 string
      eq(v.toUpperCase(), 'HELLO');
    });

    test('range 捕获越界', () => {
      let msg = '';
      try {
        Assert.range(-1, 0, 100, '伤害为负');
      } catch (e) {
        msg = e instanceof Error ? e.message : '';
      }
      assert(msg.includes('伤害为负'), msg);
    });

    test('finite 捕获 NaN（最善于隐藏的 bug）', () => {
      let threw = false;
      try {
        Assert.finite(NaN);
      } catch {
        threw = true;
      }
      assert(threw, 'NaN 必须被捕获');
    });

    test('finite 捕获 Infinity', () => {
      let threw = false;
      try {
        Assert.finite(Infinity);
      } catch {
        threw = true;
      }
      assert(threw);
    });

    test('found 返回值且在缺失时抛出', () => {
      const map = new Map([['a', 1]]);
      eq(Assert.found(map.get('a')), 1);

      let threw = false;
      try {
        Assert.found(map.get('b'), '配置 b 不存在');
      } catch {
        threw = true;
      }
      assert(threw);
    });

    test('unreachable 用于穷尽性检查', () => {
      type S = 'a' | 'b';
      const handle = (s: S): string => {
        switch (s) {
          case 'a':
            return 'A';
          case 'b':
            return 'B';
          default:
            Assert.unreachable(s);
        }
      };
      eq(handle('a'), 'A');
    });

    test('soft 不抛出，只返回布尔', () => {
      const origWarn = console.warn;
      console.warn = () => {};
      eq(Assert.soft(false, '软断言'), false);
      eq(Assert.soft(true, '软断言'), true);
      console.warn = origWarn;
    });
  });

  // ============================================================
  // TimeScale
  // ============================================================

  describe('TimeScale · 多层时间缩放', () => {
    test('无层时 scale = 1', () => {
      eq(new TimeScale().value, 1);
    });

    test('单层生效', () => {
      const ts = new TimeScale();
      ts.add('slow', 0.5);
      near(ts.value, 0.5);
    });

    test('多层相乘（合成规则必须锁死）', () => {
      const ts = new TimeScale();
      ts.add('slow', 0.5);
      ts.add('hitstop', 0.1);
      near(ts.value, 0.05, 1e-9, '0.5 × 0.1 = 0.05');
    });

    test('顿帧到期后自动移除，慢动作不受影响（经典覆盖 bug）', () => {
      const ts = new TimeScale();
      const now = 1000000;
      ts.add('slow', 0.5);
      ts.add('hitstop', 0.05, 0.08, now); // 80ms 顿帧

      near(ts.value, 0.025, 1e-9);

      ts.update(now + 79);
      near(ts.value, 0.025, 1e-9, '79ms 时顿帧仍在');

      ts.update(now + 81);
      near(ts.value, 0.5, 1e-9, '顿帧到期后只剩慢动作，不能恢复成 1');
    });

    test('相同 id 重复 add 是覆盖，不是叠加两层', () => {
      const ts = new TimeScale();
      ts.add('slow', 0.5);
      ts.add('slow', 0.25);
      eq(ts.layerCount, 1);
      near(ts.value, 0.25);
    });

    test('暂停优先于所有层', () => {
      const ts = new TimeScale();
      ts.add('slow', 0.5);
      ts.pause();
      eq(ts.value, 0);
      ts.unpause();
      near(ts.value, 0.5);
    });

    test('挂起的层不参与计算', () => {
      const ts = new TimeScale();
      ts.add('a', 0.5);
      ts.suspend('a');
      eq(ts.value, 1);
      ts.resume('a');
      near(ts.value, 0.5);
    });

    test('非法的 scale 被拒绝', () => {
      const ts = new TimeScale();
      let threw = false;
      try {
        ts.add('bad', -1);
      } catch {
        threw = true;
      }
      assert(threw, '负 scale 应抛错');
    });

    test('minScale 防止意外归零', () => {
      const ts = new TimeScale({ minScale: 0.0001 });
      ts.add('a', 0.00001);
      assert(ts.value >= 0.0001, `被 clamp 到下限，实际 ${ts.value}`);
    });

    test('dump 输出可读信息（排查「游戏莫名变慢」）', () => {
      const ts = new TimeScale();
      ts.add('slow', 0.5);
      ts.add('hitstop', 0.05, 0.08);
      const s = ts.dump();
      assert(s.includes('slow'), s);
      assert(s.includes('hitstop'), s);
    });

    test('clear 清空所有层与暂停', () => {
      const ts = new TimeScale();
      ts.add('a', 0.5);
      ts.pause();
      ts.clear();
      eq(ts.value, 1);
      eq(ts.layerCount, 0);
    });
  });

  describe('Scheduler · 统一时间源', () => {
    test('正常推进：scaledDt = realDt', () => {
      const s = new Scheduler();
      let got = 0;
      s.everyFrame((dt) => (got += dt));

      for (let i = 0; i < 60; i++) s.update(1 / 60);

      near(got, 1.0, 1e-6, '60 帧 × 1/60 = 1 秒');
    });

    test('暂停时受缩放的任务完全不执行（真暂停）', () => {
      const s = new Scheduler();
      let gameTicks = 0;
      let uiTicks = 0;

      s.everyFrame(() => gameTicks++);
      s.everyFrameUnscaled(() => uiTicks++);

      for (let i = 0; i < 10; i++) s.update(1 / 60);
      eq(gameTicks, 10);
      eq(uiTicks, 10);

      s.pause();
      for (let i = 0; i < 10; i++) s.update(1 / 60);

      eq(gameTicks, 10, '暂停后游戏逻辑一帧都不应执行');
      eq(uiTicks, 20, 'UI 应继续（否则暂停菜单自己被暂停）');
    });

    test('暂停时延时任务不推进（「暂停后 buff 仍在倒计时」的解药）', () => {
      const s = new Scheduler();
      let fired = false;
      s.delay(1, () => (fired = true));

      s.pause();
      for (let i = 0; i < 600; i++) s.update(1 / 60); // 墙钟 10 秒

      eq(fired, false, '暂停期间延时不应到期');

      s.unpause();
      for (let i = 0; i < 61; i++) s.update(1 / 60);
      eq(fired, true, '恢复后应正常到期');
    });

    test('delayUnscaled 走墙钟（网络超时用）', () => {
      const s = new Scheduler();
      let fired = false;
      s.delayUnscaled(1, () => (fired = true));

      s.pause();
      for (let i = 0; i < 61; i++) s.update(1 / 60);
      eq(fired, true, 'unscaled 延时不受暂停影响');
    });

    test('慢动作下游戏时间流逝变慢', () => {
      const s = new Scheduler();
      let t = 0;
      s.everyFrame((dt) => (t += dt));

      s.slowMotion(0.5);
      for (let i = 0; i < 60; i++) s.update(1 / 60);

      near(t, 0.5, 1e-6, '墙钟 1 秒 = 游戏内 0.5 秒');
    });

    test('顿帧：极短时间近乎静止（打击感的关键）', () => {
      const s = new Scheduler();
      let t = 0;
      s.everyFrame((dt) => (t += dt));

      for (let i = 0; i < 6; i++) s.update(1 / 60);
      const before = t;

      s.hitStop(0.08, 0.05); // 80ms 真实时间，scale=0.05
      s.update(1 / 60);

      const during = t - before;
      assert(during > 0, '顿帧期间不完全为 0（保留细微动作更自然）');
      assert(during < 0.002, `顿帧期间增量应极小，实际 ${during}`);
    });

    test('顿帧到期后自动恢复常速（用真实时间，不是缩放时间）', () => {
      const s = new Scheduler();
      let t = 0;
      s.everyFrame((dt) => (t += dt));

      const now = Date.now();
      // 直接添加一个 80ms 后到期的层，用可控的时间戳
      s.timeScale.add('hitstop', 0.05, 0.08, now);

      // 顿帧生效中
      const t0 = t;
      s.update(1 / 60);
      assert(t - t0 < 0.002, '顿帧期间几乎不动');

      // 【关键】模拟真实时间流逝 100ms 后，顿帧应自动过期
      // 这里用 timeScale.update 传入未来的时间戳来精确控制（不依赖真实等待）
      s.timeScale.update(now + 100);

      const t1 = t;
      s.update(1 / 60);
      near(t - t1, 1 / 60, 1e-6, '顿帧到期后恢复常速');
    });

    test('顿帧用真实时间计时（若用缩放时间顿帧会变成卡顿）', () => {
      const ts = new TimeScale();
      const now = 1000000;
      ts.add('hitstop', 0.05, 0.08, now); // 80ms 真实时间

      ts.update(now + 79);
      assert(ts.has('hitstop'), '79ms 时仍在顿帧');

      ts.update(now + 81);
      assert(!ts.has('hitstop'), '81ms 时应已到期');
      // 若用缩放时间，80ms 的顿帧需要 80/0.05 = 1600ms 墙钟才结束——
      // 顿帧会变成 1.6 秒的卡顿，手感彻底毁掉
    });

    test('realDt 被 clamp（防御切后台/断点）', () => {
      const s = new Scheduler({ maxDeltaTime: 0.1 });
      let got = 0;
      s.everyFrame((dt) => (got += dt));

      s.update(30); // 切后台 30 秒后回来

      near(got, 0.1, 1e-6, '必须被 clamp，否则角色瞬移穿墙');
    });

    test('非法的 dt（NaN / 负数）被处理为 0', () => {
      const s = new Scheduler();
      let got = 0;
      s.everyFrame((dt) => (got += dt));
      s.update(NaN);
      s.update(-1);
      eq(got, 0);
    });

    test('repeat 按间隔重复执行', () => {
      const s = new Scheduler();
      let n = 0;
      s.repeat(0.5, () => n++);

      for (let i = 0; i < 61; i++) s.update(1 / 60); // 略超 1 秒
      eq(n, 2, '1 秒（间隔 0.5s）内应触发 2 次');
    });

    test('repeat 的长期节奏不漂移（补偿溢出）', () => {
      const s = new Scheduler();
      let n = 0;
      s.repeat(0.1, () => n++);

      // 用不规则 dt 推进，总共 1 秒
      const dts = [0.033, 0.017, 0.05, 0.016, 0.021, 0.04];
      let t = 0;
      while (t < 1.0) {
        const dt = dts[n % dts.length];
        s.update(dt);
        t += dt;
      }
      // 1 秒 / 0.1 秒间隔 ≈ 10 次，允许 ±2 的边界误差
      assert(n >= 8 && n <= 12, `不规则 dt 下节奏应基本准确，实际 ${n} 次`);
    });

    test('repeat 指定次数后自动停止', () => {
      const s = new Scheduler();
      let n = 0;
      s.repeat(0.5, () => n++, 3);

      for (let i = 0; i < 600; i++) s.update(1 / 60);
      eq(n, 3, '达到次数后应停止');
    });

    test('取消函数生效', () => {
      const s = new Scheduler();
      let n = 0;
      const cancel = s.everyFrame(() => n++);

      s.update(1 / 60);
      cancel();
      s.update(1 / 60);
      s.update(1 / 60);

      eq(n, 1);
    });

    test('回调中添加新任务不崩溃（快照遍历）', () => {
      const s = new Scheduler();
      let n = 0;
      const cancel = s.everyFrame(() => {
        n++;
        if (n === 1) s.delay(0.1, () => n += 100);
        cancel();
      });

      s.update(1 / 60);
      for (let i = 0; i < 10; i++) s.update(1 / 60);

      eq(n, 101, '回调中添加的延时任务应正常执行');
    });

    test('taskCount 可排查泄漏（只增不减说明没取消）', () => {
      const s = new Scheduler();
      const c1 = s.everyFrame(() => {});
      const c2 = s.everyFrame(() => {});
      eq(s.taskCount, 2);
      c1();
      eq(s.taskCount, 1);
      c2();
      eq(s.taskCount, 0);
    });

    test('destroy 清空所有任务', () => {
      const s = new Scheduler();
      s.everyFrame(() => {});
      s.delay(1, () => {});
      s.destroy();
      eq(s.taskCount, 0);
    });
  });

  // ============================================================
  // ConfigLoader & Validator
  // ============================================================

  describe('Validator · 配置校验', () => {
    test('合法配置通过', () => {
      const issues = Validator.validateTable(
        't',
        [{ id: 'a', hp: 10 }],
        { id: { type: 'string', required: true }, hp: { type: 'number', min: 1, max: 999 } }
      );
      eq(issues.length, 0, Validator.format(issues));
    });

    test('必填字段缺失被报出', () => {
      const issues = Validator.validateTable('t', [{ hp: 10 }], {
        id: { type: 'string', required: true },
        hp: { type: 'number' },
      });
      eq(issues.length, 1);
      assert(issues[0].message.includes('必填'), issues[0].message);
    });

    test('一次报出所有错误（不是遇到第一个就停）', () => {
      const issues = Validator.validateTable(
        't',
        [
          { id: 'a', hp: -1 },
          { id: 'b', hp: 99999 },
          { id: 'c', hp: 'not a number' },
        ],
        { id: { type: 'string', required: true }, hp: { type: 'number', min: 0, max: 9999 } }
      );
      eq(issues.length, 3, `应一次报全，实际 ${issues.length}: ${Validator.format(issues)}`);
    });

    test('id 重复被报出（很常见的问题）', () => {
      const issues = Validator.validateTable(
        't',
        [{ id: 'a', v: 1 }, { id: 'a', v: 2 }],
        { id: { type: 'string', required: true }, v: { type: 'number' } }
      );
      assert(issues.some((i) => i.message.includes('重复')), Validator.format(issues));
    });

    test('NaN / Infinity 被捕获', () => {
      const issues = Validator.validateTable('t', [{ id: 'a', v: NaN }], {
        id: { type: 'string' },
        v: { type: 'number' },
      });
      assert(issues.some((i) => i.message.includes('NaN')), Validator.format(issues));
    });

    test('枚举校验', () => {
      const issues = Validator.validateTable('t', [{ id: 'a', rarity: 'legendaryy' }], {
        id: { type: 'string' },
        rarity: { type: 'string', enum: ['common', 'rare', 'legendary'] },
      });
      assert(issues.length === 1, Validator.format(issues));
      assert(issues[0].message.includes('common'), issues[0].message);
    });

    test('数组元素类型校验', () => {
      const bad = Validator.validateTable('t', [{ id: 'a', tags: ['x', 123] }], {
        id: { type: 'string' },
        tags: { type: 'array', item: 'string' },
      });
      assert(bad.length === 1, '数组中有非 string 元素应报错');

      const ok = Validator.validateTable('t', [{ id: 'a', tags: ['x', 'y'] }], {
        id: { type: 'string' },
        tags: { type: 'array', item: 'string' },
      });
      eq(ok.length, 0);
    });

    test('自定义校验规则', () => {
      const issues = Validator.validateTable(
        't',
        [{ id: 'a', hp: 10, maxHp: 5 }],
        {
          id: { type: 'string' },
          hp: { type: 'number' },
          maxHp: {
            type: 'number',
            custom: (v, row) => {
              const r = row as { hp: number };
              return (v as number) < r.hp ? 'maxHp 不能小于 hp' : null;
            },
          },
        }
      );
      assert(issues.some((i) => i.message.includes('maxHp')), Validator.format(issues));
    });

    test('nullable 允许 null，默认不允许', () => {
      const strict = Validator.validateTable('t', [{ id: 'a', desc: null }], {
        id: { type: 'string' },
        desc: { type: 'string' },
      });
      eq(strict.length, 1, '默认不允许 null');

      const loose = Validator.validateTable('t', [{ id: 'a', desc: null }], {
        id: { type: 'string' },
        desc: { type: 'string', nullable: true },
      });
      eq(loose.length, 0);
    });

    test('跨表引用完整性：发现指向不存在的 id', () => {
      const tables = {
        enemies: [{ id: 'slime', drop: 'boss_loot' }],
        loot: [{ id: 'common_loot' }],
      };
      const schemas = {
        enemies: { id: { type: 'string' }, drop: { type: 'ref', table: 'loot' } },
        loot: { id: { type: 'string' } },
      };

      const issues = Validator.checkReferences(tables, schemas as never);
      eq(issues.length, 1, Validator.format(issues));
      assert(issues[0].message.includes('boss_loot'), issues[0].message);
    });

    test('引用数组也检查', () => {
      const tables = {
        enemies: [{ id: 'a', drops: ['ok', 'missing'] }],
        loot: [{ id: 'ok' }],
      };
      const schemas = {
        enemies: { id: { type: 'string' }, drops: { type: 'ref', table: 'loot' } },
        loot: { id: { type: 'string' } },
      };
      const issues = Validator.checkReferences(tables, schemas as never);
      assert(issues.some((i) => i.message.includes('missing')), Validator.format(issues));
    });

    test('引用了不存在的表也被报出', () => {
      const tables = { enemies: [{ id: 'a', drop: 'x' }] };
      const schemas = {
        enemies: { id: { type: 'string' }, drop: { type: 'ref', table: 'nonexistent' } },
      };
      const issues = Validator.checkReferences(tables, schemas as never);
      assert(issues.some((i) => i.message.includes('nonexistent')), Validator.format(issues));
    });

    test('format 输出可读文本', () => {
      const issues: ValidationIssue[] = [
        { table: 'enemies', index: 3, rowId: 'boss', field: 'hp', message: '超出范围' },
      ];
      const s = Validator.format(issues);
      assert(s.includes('enemies'), s);
      assert(s.includes('boss'), s);
      assert(s.includes('hp'), s);
    });
  });

  await describeAsync('ConfigLoader · 配置加载与热重载', async () => {
    const schemas = {
      enemies: {
        id: { type: 'string' as const, required: true },
        hp: { type: 'number' as const, min: 1, max: 9999 },
      },
      loot: {
        id: { type: 'string' as const, required: true },
      },
    };

    async function makeLoader(
      data: Record<string, readonly unknown[]>,
      throwOnError = true
    ): Promise<ConfigLoader> {
      const src = new MemoryTableSource(data);
      const loader = new ConfigLoader(src, { tables: schemas, throwOnError });
      await loader.loadAll();
      return loader;
    }

    await testAsync('加载并按下标取（O(1) 索引）', async () => {
      const loader = await makeLoader({ enemies: [{ id: 'slime', hp: 30 }], loot: [] });
      const e = loader.get<{ hp: number }>('enemies', 'slime');
      eq(e.hp, 30);
    });

    await testAsync('get 找不到时抛错（错误不外溢）', async () => {
      const loader = await makeLoader({ enemies: [{ id: 'slime', hp: 30 }], loot: [] });
      let threw = false;
      try {
        loader.get('enemies', 'boss');
      } catch {
        threw = true;
      }
      assert(threw, '找不到 id 应立刻抛错，而不是返回 undefined');
    });

    await testAsync('find 找不到返回 undefined', async () => {
      const loader = await makeLoader({ enemies: [{ id: 'slime', hp: 30 }], loot: [] });
      eq(loader.find('enemies', 'boss'), undefined);
    });

    await testAsync('未加载的表访问时报错并提示已加载的表', async () => {
      const loader = await makeLoader({ enemies: [], loot: [] });
      let msg = '';
      try {
        loader.get('items', 'x');
      } catch (e) {
        msg = e instanceof Error ? e.message : '';
      }
      assert(msg.includes('未加载'), msg);
      assert(msg.includes('enemies'), msg);
    });

    await testAsync('校验失败时抛出（throwOnError=true）', async () => {
      let threw = false;
      try {
        await makeLoader({ enemies: [{ id: 'bad', hp: -5 }], loot: [] });
      } catch {
        threw = true;
      }
      assert(threw, '配置错误应在启动时就炸，而不是运行时');
    });

    await testAsync('throwOnError=false 时记录问题而不抛出', async () => {
      const loader = await makeLoader({ enemies: [{ id: 'bad', hp: -5 }], loot: [] }, false);
      assert(loader.issues.length > 0, '问题应记录到 issues');
    });

    await testAsync('跨表引用在全部加载后检查', async () => {
      let threw = false;
      try {
        await new Promise<void>((resolve) => {
          const src = new MemoryTableSource({
            enemies: [{ id: 'slime', hp: 10, drop: 'nope' }],
            loot: [{ id: 'common' }],
          });
          const loader = new ConfigLoader(src, {
            tables: {
              enemies: {
                id: { type: 'string' },
                hp: { type: 'number' },
                drop: { type: 'ref', table: 'loot' },
              },
              loot: { id: { type: 'string' } },
            },
          });
          loader.loadAll().then(
            () => resolve(),
            () => {
              threw = true;
              resolve();
            }
          );
        });
      } catch {
        threw = true;
      }
      assert(threw, '引用不存在的 id 应在加载时就报出');
    });

    await testAsync('热重载：改数据后 get 返回新值', async () => {
      const src = new MemoryTableSource({ enemies: [{ id: 'slime', hp: 30 }], loot: [] });
      const loader = new ConfigLoader(src, { tables: schemas });
      await loader.loadAll();

      eq(loader.get<{ hp: number }>('enemies', 'slime').hp, 30);

      src.set('enemies', [{ id: 'slime', hp: 999 }]);
      await loader.reload('enemies');

      eq(loader.get<{ hp: number }>('enemies', 'slime').hp, 999, '重载后应返回新值');
    });

    await testAsync('热重载触发订阅（让持有者刷新缓存）', async () => {
      const src = new MemoryTableSource({ enemies: [{ id: 'slime', hp: 30 }], loot: [] });
      const loader = new ConfigLoader(src, { tables: schemas });
      await loader.loadAll();

      let notified = '';
      const off = loader.onReload((t) => (notified = t));

      src.set('enemies', [{ id: 'slime', hp: 50 }]);
      await loader.reload('enemies');

      eq(notified, 'enemies');
      off();
    });

    await testAsync('where / count / has', async () => {
      const loader = await makeLoader({
        enemies: [
          { id: 'a', hp: 10 },
          { id: 'b', hp: 200 },
          { id: 'c', hp: 30 },
        ],
        loot: [],
      });
      eq(loader.count('enemies'), 3);
      eq(loader.has('enemies', 'b'), true);
      eq(loader.has('enemies', 'zzz'), false);
      eq(loader.where<{ hp: number }>('enemies', (r) => r.hp > 50).length, 1);
    });

    await testAsync('destroy 清空', async () => {
      const loader = await makeLoader({ enemies: [{ id: 'a', hp: 1 }], loot: [] });
      loader.destroy();
      eq(loader.loadedTables.length, 0);
    });
  });

  // ============================================================
  // InputManager
  // ============================================================

  describe('InputManager · 统一输入抽象', () => {
    function makeInput(): InputManager {
      const input = new InputManager();
      input.bindAxis('move', {
        negativeX: [Key.A],
        positiveX: [Key.D],
        negativeY: [Key.S],
        positiveY: [Key.W],
      });
      input.bindButton('attack', [Key.Space]);
      input.bindButton('dash', [Key.ShiftLeft, Key.MouseRight]);
      return input;
    }

    test('按键 → 动作（动作名与物理键解耦）', () => {
      const input = makeInput();

      input.setKeyDown(Key.Space);
      input.beginFrame();

      eq(input.isPressed('attack'), true);
      eq(input.isPressed('dash'), false);
    });

    test('justPressed 只在按下那一帧为真（忘了 endFrame 的经典 bug）', () => {
      const input = makeInput();

      input.setKeyDown(Key.Space);
      input.beginFrame();
      eq(input.wasJustPressed('attack'), true);
      input.endFrame();

      input.beginFrame();
      eq(input.wasJustPressed('attack'), false, 'endFrame 后必须清除');
      eq(input.isPressed('attack'), true, '但仍处于按住状态');
      input.endFrame();
    });

    test('持续按住不会重复触发 justPressed', () => {
      const input = makeInput();
      input.setKeyDown(Key.Space);
      input.beginFrame();
      input.endFrame();

      let count = 0;
      for (let i = 0; i < 10; i++) {
        input.beginFrame();
        if (input.wasJustPressed('attack')) count++;
        input.endFrame();
      }
      eq(count, 0, '按住不放只应触发一次 justPressed');
    });

    test('justReleased 在松开那一帧为真', () => {
      const input = makeInput();
      input.setKeyDown(Key.Space);
      input.beginFrame();
      input.endFrame();

      input.setKeyUp(Key.Space);
      input.beginFrame();
      eq(input.wasJustReleased('attack'), true);
      eq(input.isPressed('attack'), false);
      input.endFrame();
    });

    test('轴：WASD 输出方向', () => {
      const input = makeInput();

      input.setKeyDown(Key.D);
      input.beginFrame();
      near(input.getAxis('move').x, 1);
      near(input.getAxis('move').y, 0);

      // 【坑】必须先松开 D 再测 W，否则是对角线（归一化为 0.707）
      input.setKeyUp(Key.D);
      input.setKeyDown(Key.W);
      input.beginFrame();
      near(input.getAxis('move').x, 0);
      near(input.getAxis('move').y, 1);
    });

    test('轴：对角线归一化（不是 1.41 倍）', () => {
      const input = makeInput();
      input.setKeyDown(Key.W);
      input.setKeyDown(Key.D);
      input.beginFrame();

      const a = input.getAxis('move');
      const len = Math.sqrt(a.x * a.x + a.y * a.y);
      near(len, 1, 1e-6, `斜向长度必须是 1，实际 ${len}`);
    });

    test('轴：相反方向抵消', () => {
      const input = makeInput();
      input.setKeyDown(Key.A);
      input.setKeyDown(Key.D);
      input.beginFrame();

      near(input.getAxis('move').x, 0);
    });

    test('轴：模拟量（手柄/虚拟摇杆）注入', () => {
      const input = makeInput();
      input.beginFrame();
      input.setAxisAnalog('move', 0.5, 0);   // ← 必须在 beginFrame 之后

      near(input.getAxis('move').x, 0.5, 1e-6, '轻推摇杆应输出 0.5（保留模拟量）');
    });

    test('轴：模拟量必须在 beginFrame 之后注入（顺序错了会失效）', () => {
      const input = makeInput();
      input.setAxisAnalog('move', 0.5, 0);   // ← 顺序错误
      input.beginFrame();                     // ← 把模拟量清掉了

      near(input.getAxis('move').x, 0, 1e-6, '顺序反了模拟量会丢失（这是常见踩坑）');
    });

    test('轴：模拟量低于死区归零（防手柄漂移）', () => {
      const input = makeInput();
      input.beginFrame();
      input.setAxisAnalog('move', 0.05, 0); // 低于默认死区 0.15

      near(input.getAxis('move').x, 0, 1e-6, '死区内的微小偏移必须归零');
    });

    test('轴：键盘与摇杆合并，取较大值（不互相抵消）', () => {
      const input = makeInput();
      input.setKeyDown(Key.D); // 键盘 = +1
      input.beginFrame();
      input.setAxisAnalog('move', 0.3, 0); // 摇杆 = +0.3

      near(input.getAxis('move').x, 1, 1e-6, '应取绝对值较大者');
    });

    test('重映射：改键后新键生效、旧键失效', () => {
      const input = makeInput();

      input.rebind('dash', [Key.Q], 0);

      input.setKeyDown(Key.ShiftLeft);
      input.beginFrame();
      eq(input.isPressed('dash'), false, '旧键应失效');

      input.setKeyUp(Key.ShiftLeft);
      input.setKeyDown(Key.Q);
      input.beginFrame();
      eq(input.isPressed('dash'), true, '新键应生效');
    });

    test('绑定可导出导入（存档）', () => {
      const input = makeInput();
      const saved = input.exportBindings();
      assert(Array.isArray(saved.attack), JSON.stringify(saved));

      const input2 = new InputManager();
      input2.importBindings(saved);
      input2.setKeyDown(Key.Space);
      input2.beginFrame();
      eq(input2.isPressed('attack'), true, '导入的绑定应可用');
    });

    test('一个动作可绑多个键（任一按下即触发）', () => {
      const input = makeInput();
      input.setKeyDown(Key.MouseRight);
      input.beginFrame();
      eq(input.isPressed('dash'), true, 'dash 绑了 Shift 和右键，任一即可');
    });

    test('禁用输入后所有查询返回空', () => {
      const input = makeInput();
      input.setKeyDown(Key.Space);
      input.setEnabled(false);
      input.beginFrame();

      eq(input.isPressed('attack'), false);
      near(input.getAxis('move').x, 0);
    });

    test('禁用时清空按键状态（避免恢复后残留）', () => {
      const input = makeInput();
      input.setKeyDown(Key.Space);
      input.setEnabled(false);
      input.setEnabled(true);
      input.beginFrame();

      eq(input.isPressed('attack'), false, '禁用再启用后不应有残留按键');
    });

    test('clearKeys 清空所有状态（切场景/失焦用）', () => {
      const input = makeInput();
      input.setKeyDown(Key.Space);
      input.setKeyDown(Key.D);
      input.clearKeys();
      input.beginFrame();

      eq(input.isPressed('attack'), false);
      near(input.getAxis('move').x, 0);
    });

    test('getAxisTo 零分配（高频路径）', () => {
      const input = makeInput();
      input.setKeyDown(Key.D);
      input.beginFrame();

      const out = { x: 0, y: 0 };
      input.getAxisTo('move', out);
      near(out.x, 1);
    });

    test('未绑定的动作查询安全返回空', () => {
      const input = makeInput();
      input.beginFrame();
      eq(input.isPressed('不存在的动作'), false);
      eq(input.wasJustPressed('不存在的动作'), false);
      near(input.getAxis('不存在的动作').x, 0);
    });

    test('destroy 清空', () => {
      const input = makeInput();
      input.destroy();
      input.beginFrame();
      eq(input.isPressed('attack'), false);
    });
  });
}
