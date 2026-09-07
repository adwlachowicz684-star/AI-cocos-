/**
 * tests/run_phase10_w2a.ts —— 第二次精审 · 窗口 W2-A（第 A 组）
 *
 * 【本批覆盖的 10 个单元】
 * attribute / command / diagpack / indicator / logger / pathfinding
 * runscope / scheduling / skill-caster / social
 *
 * 【条目】19 条（P1 14 / P2 5）
 *
 * 【每条都配两条用例】
 * 1. 回归用例：在**修复前确实会失败**（证据见 `audit/result_W2-A.md` 的实测输出）
 * 2. 对照用例：验证正常输入不受影响（防止矫枉过正）
 *
 * 【本批反复出现的三个模式】
 *
 * 1. **同义不同行为**：`clearModifiers` vs `removeBySource`、
 *    `compute()` vs `centerFor()`——两个 API 同一个语义却给出两个答案，
 *    调用方按其中一个写的代码在另一个上就是错的。
 *
 * 2. **`as` 断言骗过类型检查**：`{} as Record<K, number>` 让"每个键都有数字"
 *    的承诺变成假的，编译期不报错，运行时读到 `undefined` → 参与运算得 NaN。
 *
 * 3. **空 catch / 空 if 块**：把"不中断"错做成"完全无声"。
 *    本批两处（command 的 undo 异常、diagpack 的脱敏规则异常）
 *    都是**安全问题**而不是健壮性问题——前者留下脏状态，后者可能上报明文密码。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { AttributeSet } from '../attribute/AttributeSet';
import { CommandStack } from '../command/CommandStack';
import { safeStringify, redact, DiagCollector, collectEnvironment } from '../diagpack/DiagPack';
import { SkillIndicator } from '../indicator/SkillIndicator';
import { Logger, LogLevel } from '../logger/Logger';
import { Assert } from '../logger/Assert';
import { GridGraph, findPath } from '../pathfinding/GridGraph';
import { ScopedStore, key } from '../runscope/ScopedStore';
import { FrameScheduler, NO_TASK } from '../scheduling/FrameScheduler';
import { SkillCaster } from '../skill-caster/SkillCaster';
import { ReportCenter, REPORT_REASONS } from '../social/Report';

export function runPhase10W2ATests(): void {
  // ══════════════════════════════════════════════════════════
  describe('W2-A · attribute · clearModifiers 触发 onChange', () => {
    test('⚠️ clearModifiers(attr) 要通知监听者（修复前不通知）', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      let n = 0;
      a.onChange(() => n++);

      a.add({ attr: 'atk', type: 'add', value: 5 });
      eq(n, 1, 'add 应触发一次');

      a.clearModifiers('atk');
      eq(n, 2, 'clearModifiers(attr) 让值从 15 变回 10，必须通知');
      eq(a.get('atk'), 10);
    });

    test('⚠️ clearModifiers() 无参要对每个受影响属性通知（修复前不通知）', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }, { id: 'hp', base: 100 }]);
      const seen: string[] = [];
      a.onChange((c) => seen.push(c.attr));

      a.add({ attr: 'atk', type: 'add', value: 5 });
      a.add({ attr: 'hp', type: 'add', value: 50 });
      seen.length = 0;

      a.clearModifiers();
      eq(seen.length, 2, '两个属性都变了，都应收到通知');
      assert(seen.includes('atk') && seen.includes('hp'), `实际收到：${seen.join(',')}`);
    });

    test('⚠️ suspendNotify 期间仍然只汇总不漏（修复前 clearModifiers 完全静默）', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      const seen: Array<{ oldValue: number; newValue: number }> = [];
      a.onChange((c) => seen.push({ oldValue: c.oldValue, newValue: c.newValue }));

      a.suspendNotify();
      a.add({ attr: 'atk', type: 'add', value: 5 });
      a.clearModifiers('atk');
      a.resumeNotify();

      eq(seen.length, 1, '挂起期间同一属性只发最后一次');
      // 挂起期内 add(10→15) 与 clear(15→10) 两笔变化按"只发最后一次"汇总，
      // 所以通知的是 15→10（清空那一步），而不是"净变化 10→10"（没有变化就不该通知）。
      eq(seen[0].oldValue, 15, '最后一次变化是清空：从 15 开始');
      eq(seen[0].newValue, 10, '清空后的值');
    });

    test('没有变化时不应误报（防止矫枉过正）', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      let n = 0;
      a.onChange(() => n++);

      a.clearModifiers('atk');   // 根本没有修正器可清
      eq(n, 0, '值没变就不该通知');
      eq(a.clearModifiers('atk'), 0);
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · attribute · override 与 add 的叠加语义', () => {
    test('override 只替换 base，add 仍叠加（与 README 公式一致）', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      a.add({ attr: 'atk', type: 'override', value: 100 });
      a.add({ attr: 'atk', type: 'add', value: 50 });
      eq(a.get('atk'), 150, 'base 被 override 替换成 100，再加 50');
    });

    test('mul 在 override 之后同样生效（防止矫枉过正）', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      a.add({ attr: 'atk', type: 'override', value: 100 });
      a.add({ attr: 'atk', type: 'mul', value: 0.5 });
      eq(a.get('atk'), 150, '(100 + 0) × (1 + 0.5)');
    });

    test('多个 override 取最后一个（既有行为不变）', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      a.add({ attr: 'atk', type: 'override', value: 100 });
      a.add({ attr: 'atk', type: 'override', value: 7 });
      eq(a.get('atk'), 7);
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · command · rollback 不再静默吞掉 undo 异常', () => {
    test('⚠️ undo 抛错要留下痕迹（修复前完全无声）', () => {
      const errors: unknown[] = [];
      const stack = new CommandStack({ onRollbackError: (e) => errors.push(e) });

      const ok = { name: 'ok', execute: () => {}, undo: () => {} };
      const bad = {
        name: 'bad',
        execute: () => {},
        undo: () => {
          throw new Error('undo 依赖的资源已释放');
        },
      };

      throws(() => {
        stack.transact('tx', () => {
          stack.do(ok);
          stack.do(bad);
          throw new Error('execute 失败');
        });
      }, 'execute 失败');

      eq(errors.length, 1, '回滚失败的异常应被上报，而不是被空 catch 吞掉');
      eq(stack.lastRollbackErrors.length, 1, 'lastRollbackErrors 应记录失败明细');
      eq(stack.lastRollbackErrors[0].cmd.name, 'bad');
    });

    test('⚠️ 单条回滚失败不中断其余命令的撤销（不矫枉过正）', () => {
      const stack = new CommandStack({ onRollbackError: () => {} });
      let a = 0;
      let b = 0;

      try {
        stack.transact('tx', () => {
          stack.do({ name: 'a', execute: () => { a = 1; }, undo: () => { a = 0; } });
          stack.do({
            name: 'b',
            execute: () => { b = 1; },
            undo: () => {
              b = 0;
              throw new Error('b 的 undo 炸了');
            },
          });
          throw new Error('tx 失败');
        });
      } catch {
        // 事务异常由调用方处理，这里只关心回滚是否继续
      }

      eq(a, 0, 'b 失败不应阻止 a 被撤销');
      eq(b, 0, 'b 自己的副作用也已经改回去了（抛错发生在改完之后）');
    });

    test('全部回滚成功时没有错误记录（防止矫枉过正）', () => {
      const stack = new CommandStack();
      let a = 0;
      try {
        stack.transact('tx', () => {
          stack.do({ name: 'a', execute: () => { a = 1; }, undo: () => { a = 0; } });
          throw new Error('tx 失败');
        });
      } catch {
        // ignore
      }
      eq(a, 0);
      eq(stack.lastRollbackErrors.length, 0, '正常回滚不该留下错误');
      eq(stack.rollback(), 0, '不在事务中时回滚 0 条（返回值语义未变）');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · diagpack · safeStringify 不再误判共享引用', () => {
    test('⚠️ 同一对象被两个字段引用都要保留（修复前第二个变 [Circular]）', () => {
      const shared = { hp: 100 };
      const out = safeStringify({ a: shared, b: shared });
      eq(out, '{"a":{"hp":100},"b":{"hp":100}}');
      assert(!out.includes('[Circular]'), `不应出现 [Circular]：${out}`);
    });

    test('⚠️ 数组与跨层级的共享引用同样保留', () => {
      const shared = { v: 1 };
      eq(safeStringify([shared, shared]), '[{"v":1},{"v":1}]');
      eq(safeStringify({ x: { y: shared }, z: shared }), '{"x":{"y":{"v":1}},"z":{"v":1}}');
    });

    test('真正的循环引用仍被拦下（防止矫枉过正）', () => {
      const cyclic: Record<string, unknown> = { name: 'x' };
      cyclic.self = cyclic;
      const out = safeStringify(cyclic);
      assert(out.includes('[Circular]'), `环必须被拦下：${out}`);

      const a: Record<string, unknown> = {};
      const b: Record<string, unknown> = { a };
      a.b = b;
      assert(safeStringify(a).includes('[Circular]'), '间接环也要拦下');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · diagpack · 脱敏不得破坏 JSON 结构', () => {
    test('⚠️ 值是对象时脱敏后仍是合法 JSON（修复前多出一个 }）', () => {
      const out = redact('{"password": {"a":1},"nested":1}');
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(out);
      } catch (e) {
        throw new Error(`脱敏后不再是合法 JSON：${out}（${String(e)}）`);
      }
      eq((parsed as { password: unknown }).password, '[REDACTED]');
      eq((parsed as { nested: number }).nested, 1, '相邻字段不能被吃掉');
    });

    test('⚠️ 值是数组时脱敏后仍是合法 JSON', () => {
      const out = redact('{"token": [1,2,3],"ok":1}');
      const parsed = JSON.parse(out) as { token: unknown; ok: number };
      eq(parsed.token, '[REDACTED]');
      eq(parsed.ok, 1);
    });

    test('⚠️ 嵌套与 null / 数字 / 布尔值都能正确脱敏', () => {
      const out = redact('{"data":{"user":{"apiKey":"x","name":"bob"}},"n":1}');
      const parsed = JSON.parse(out) as { data: { user: { apiKey: string; name: string } } };
      eq(parsed.data.user.apiKey, '[REDACTED]');
      eq(parsed.data.user.name, 'bob', '非敏感字段必须原样保留');

      const out2 = redact('{"auth":null,"pwd":123,"secret":true}');
      const p2 = JSON.parse(out2) as Record<string, unknown>;
      eq(p2.auth, '[REDACTED]');
      eq(p2.pwd, '[REDACTED]');
      eq(p2.secret, '[REDACTED]');
    });

    test('valuePattern 仍对字符串值生效，且不会误伤不是 key 的引号串（防止矫枉过正）', () => {
      // "note" 命中了 keyPattern 但它是**值**，不该被当成 key 替换
      eq(redact('{"note":"my password is x"}'), '{"note":"my password is x"}');
      // valuePattern（邮箱）仍然要脱敏
      assert(redact('{"m":"a@b.com"}').includes('[REDACTED]'), '邮箱应被 valuePattern 命中');
    });

    test('⚠️ 规则执行失败不能静默跳过（修复前是空 catch）', () => {
      const brokenRule = {
        name: 'broken',
        // 故意构造一个会在 replace 时抛错的规则：keyPattern 命中后交给扫描器，
        // 这里用 onRuleError 验证"失败可见"
        keyPattern: /(?!)/ as unknown as RegExp,
        get valuePattern(): RegExp {
          throw new Error('规则的 valuePattern 是坏的 getter');
        },
      } as never;

      let reported = false;
      redact('{"a":1}', [brokenRule], { onRuleError: () => { reported = true; } });
      assert(reported, '规则失败必须上报');
    });

    test('收集器把脱敏失败写进 warnings', () => {
      const brokenRule = {
        name: 'broken',
        get valuePattern(): RegExp {
          throw new Error('boom');
        },
      } as never;

      const c = new DiagCollector({
        appId: 't',
        version: '1',
        extraRedactions: [brokenRule],
      });
      c.section('s', () => ({ a: 1 }));
      const r = c.generate(0);
      assert(
        r.warnings.some((w) => w.includes('脱敏规则') && w.includes('broken')),
        `warnings 应记录脱敏规则失败：${r.warnings.join(' | ')}`
      );
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · diagpack · 配额收口与 destroy（P2）', () => {
    test('⚠️ maxSectionChars = 0 不应让内容被截成 0 字符（修复前静默清空）', () => {
      const c = new DiagCollector({ appId: 't', version: '1', maxSectionChars: 0 });
      c.section('s', () => ({ hello: 'world' }));
      const r = c.generate(0);
      assert(r.sections[0].chars > 0, '内容不应被截成 0 字符');
      eq(r.sections[0].truncated, false);
    });

    test('⚠️ maxTotalChars = -1 不应让整个包被丢弃（修复前第一个分区就被丢）', () => {
      const c = new DiagCollector({ appId: 't', version: '1', maxTotalChars: -1 });
      c.section('s', () => ({ hello: 'world' }));
      const r = c.generate(0);
      eq(r.sections.length, 1, '分区不该被配额逻辑丢掉');
    });

    test('⚠️ NaN 配额不应让截断失效（修复后回落到默认值）', () => {
      const c = new DiagCollector({ appId: 't', version: '1', maxSectionChars: NaN });
      c.section('s', () => ({ big: 'x'.repeat(50) }));
      const r = c.generate(0);
      assert(r.sections[0].chars > 0, 'NaN 应回落到默认配额，而不是永不截断');
    });

    test('正常配额仍然生效（防止矫枉过正）', () => {
      const c = new DiagCollector({ appId: 't', version: '1', maxSectionChars: 10 });
      c.section('s', () => ({ big: 'x'.repeat(200) }));
      const r = c.generate(0);
      eq(r.sections[0].truncated, true, '超配额应被截断');
    });

    test('⚠️ destroy() 释放 provider（P2 · Di6）', () => {
      const c = new DiagCollector({ appId: 't', version: '1' });
      c.section('s', () => ({ a: 1 }));
      eq(c.sectionNames.length, 1);
      c.destroy();
      eq(c.sectionNames.length, 0, 'provider 闭包必须被释放');
      eq(c.generate(0).sections.length, 0);
    });

    test('⚠️ collectEnvironment 支持注入时间与时区（P2 · Di5）', () => {
      const env = collectEnvironment(
        { platform: 'ios' },
        { now: 0, timezone: 'Asia/Shanghai', timezoneOffsetMin: -480 }
      );
      eq(env.platform, 'ios');
      eq(env.timezone, 'Asia/Shanghai');
      eq(env.timezoneOffsetMin, -480);
      eq(env.collectedAt, '1970-01-01T00:00:00.000Z');
    });

    test('不注入时行为不变（防止矫枉过正）', () => {
      const env = collectEnvironment({ platform: 'ios' });
      assert(typeof env.timezone === 'string' && env.timezone.length > 0);
      assert(Number.isFinite(env.timezoneOffsetMin), 'offset 应是数字');
    });

    test('safeStringify 支持传入 replacer（P2 · Di3）', () => {
      const out = safeStringify({ a: 1, b: 2 }, {
        replacer: (k, v) => (k === 'b' ? undefined : v),
      });
      eq(out, '{"a":1}', 'replacer 应真正生效（旧的恒等 replacer 什么都没做）');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · indicator · compute 与 centerFor 中心一致', () => {
    test('⚠️ line 类型的 compute().x 必须等于 centerFor().x（修复前差 length/2）', () => {
      const ind = new SkillIndicator({ kind: 'line', length: 6, width: 1, range: 10, aimed: true });
      const r = ind.compute(0, 0, 0, 6, 0);
      const c = ind.centerFor(0, 0, r.rotation);
      near(r.x, c.x, 1e-6, '两个 API 应给出同一个中心');
      near(r.y, c.y, 1e-6);
      near(r.x, 3, 1e-6, '中心应在前方半长处');
    });

    test('⚠️ direction 类型同样一致', () => {
      const ind = new SkillIndicator({
        kind: 'direction', length: 4, width: 0.5, range: 10, aimed: true,
      });
      const r = ind.compute(0, 0, 0, 10, 0);
      const c = ind.centerFor(0, 0, r.rotation);
      near(r.x, c.x, 1e-6);
      near(r.x, 2, 1e-6);
    });

    test('⚠️ 非 aimed 的 line 也一致（修复前 aimed=false 时中心在脚下）', () => {
      const ind = new SkillIndicator({ kind: 'line', length: 6, width: 1, range: 10, aimed: false });
      const r = ind.compute(0, 0, 0, 6, 0);
      near(r.x, ind.centerFor(0, 0, r.rotation).x, 1e-6);
      near(r.x, 3, 1e-6);
    });

    test('circle 的中心仍是目标点（防止矫枉过正）', () => {
      const ind = new SkillIndicator({ kind: 'circle', radius: 2, range: 10, aimed: true });
      const r = ind.compute(0, 0, 0, 3, 4);
      near(r.x, 3, 1e-6);
      near(r.y, 4, 1e-6);
    });

    test('aimX / aimY 仍是瞄准点语义（防止矫枉过正）', () => {
      const ind = new SkillIndicator({ kind: 'line', length: 6, width: 1, range: 10, aimed: true });
      const r = ind.compute(0, 0, 0, 6, 0);
      near(r.aimX, 6, 1e-6, '瞄准点不该被形状中心的改动影响');
      near(r.aimY, 0, 1e-6);
    });

    test('⚠️ ring 结果带上 innerRadius（P2）', () => {
      const ind = new SkillIndicator({
        kind: 'ring', radius: 5, innerRadius: 4, range: 10, aimed: false,
      });
      const r = ind.compute(0, 0, 0, 0, 0);
      eq(r.shape.kind, 'circle');
      eq(r.shape.radius, 5);
      eq(r.innerRadius, 4, 'innerRadius 必须随结果给出，否则调用方只能拿到实心圆判定');
    });

    test('非 ring 类型不带 innerRadius（防止矫枉过正）', () => {
      const ind = new SkillIndicator({ kind: 'circle', radius: 3, range: 10, aimed: false });
      const r = ind.compute(0, 0, 0, 0, 0);
      eq(r.innerRadius, undefined);
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · logger · Silent 语义显式化（不再留空 if 块）', () => {
    test('⚠️ bufferWhileSilent:false 时 Silent 真正不写缓冲（修复前空块什么都没做）', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferWhileSilent: false });
      let emitted = 0;
      log.addSink(() => { emitted++; });

      log.info('m', '1');
      log.error('m', '2');

      eq(log.buffered, 0, '不该再有 entry 对象分配与缓冲写入');
      eq(log.export().length, 0);
      eq(emitted, 0, 'Silent 也不该输出');
    });

    test('默认行为不变：Silent 仍保留缓冲（刻意设计，防止矫枉过正）', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferSize: 10 });
      let emitted = 0;
      log.addSink(() => { emitted++; });

      log.info('m', '1');
      log.error('m', '2');

      eq(log.buffered, 2, 'level 只挡输出、不挡记录，这是 README 明确承诺的');
      eq(emitted, 0);
    });

    test('⚠️ 模块级例外不被全局 Silent 误伤（修复前的判据漏了模块级）', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferWhileSilent: false });
      log.setModuleLevel('net', LogLevel.Debug);
      const got: string[] = [];
      log.addSink((e) => got.push(e.message));

      log.debug('net', '保留');
      log.debug('other', '丢弃');

      eq(got.join(','), '保留', '全局 Silent 但 net 单独开了 Debug → net 不是静默的');
      eq(log.buffered, 1);
    });

    test('⚠️ addSink 的取消函数不会误删后来者（P2 · L2）', () => {
      const log = new Logger({ level: LogLevel.Debug });
      const calls: string[] = [];
      const fn = () => calls.push('x');

      const off1 = log.addSink(fn);
      log.addSink(fn);

      off1();
      off1();   // 重复调用：旧的 indexOf 写法会再去删一次，把另一个同函数删掉

      log.info('m', 'msg');
      eq(calls.length, 1, '取消一次只应减少一个 sink');
    });

    test('⚠️ sink 在自己回调里注销不会跳过其他 sink（P2 · 模式 E）', () => {
      const log = new Logger({ level: LogLevel.Debug });
      const order: string[] = [];
      const offA = log.addSink(() => {
        order.push('A');
        offA();
      });
      log.addSink(() => order.push('B'));

      log.info('m', 'x');
      eq(order.join(','), 'A,B', 'A 注销自己后 B 仍应被调用');
    });

    test('⚠️ destroy 清掉模块级配置（P2 · L2）', () => {
      const log = new Logger({ level: LogLevel.Silent });
      log.setModuleLevel('combat', LogLevel.Debug);
      log.destroy();
      log.setLevel(LogLevel.Silent);

      const got: string[] = [];
      log.addSink((e) => got.push(e.message));
      log.debug('combat', 'destroy 之后');

      eq(got.length, 0, 'destroy 后旧配置不该继续生效');
    });

    test('⚠️ bufferData:false 断开 data 引用（P2 · L3）', () => {
      const log = new Logger({ level: LogLevel.Silent, bufferData: false });
      log.info('m', 'x', { big: 'object' });
      eq(log.export()[0].data, undefined, '缓冲里不该再持有 data');
      eq(log.export()[0].message, 'x', '定位信息仍在');
    });

    test('默认保留 data，且 sink 仍拿得到（防止矫枉过正）', () => {
      const log = new Logger({ level: LogLevel.Debug });
      let got: unknown = null;
      log.addSink((e) => { got = e.data; });
      log.info('m', 'x', { big: 1 });
      eq(JSON.stringify(got), '{"big":1}');
      eq(JSON.stringify(log.export()[0].data), '{"big":1}');
    });

    test('⚠️ Assert.soft 可重定向到 Logger 的 sink 体系（P2 · L4）', () => {
      const log = new Logger({ level: LogLevel.Debug });
      const lines: string[] = [];
      log.addSink((e) => lines.push(e.message));

      const orig = console.warn;
      console.warn = () => {};
      try {
        Assert.setSoftHandler((msg: string) => log.warn('assert', msg));
        Assert.soft(false, '软断言失败');
        Assert.setSoftHandler(null);
      } finally {
        console.warn = orig;
      }

      eq(lines.length, 1, '软断言应能进 sink');
      assert(lines[0].includes('软断言失败'), `实际：${lines[0]}`);
    });

    test('未设置 handler 时回退到 console.warn（防止矫枉过正）', () => {
      const orig = console.warn;
      let warned = '';
      console.warn = (...a: unknown[]) => { warned += String(a[0]); };
      try {
        Assert.soft(false, '默认出口');
      } finally {
        console.warn = orig;
      }
      assert(warned.includes('软断言'), `应回退到 console.warn：${warned}`);
      eq(Assert.soft(true, '不该触发'), true);
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · pathfinding · 起点不可走也要返回 null', () => {
    test('⚠️ 起点在墙里时返回 null（修复前照样给出完整路径）', () => {
      const g = new GridGraph(5, 5);
      g.setWalkable(0, 0, false);
      eq(findPath(g, { x: 0, y: 0 }, { x: 4, y: 4 }), null);
    });

    test('⚠️ 起点终点都在墙里同样返回 null', () => {
      const g = new GridGraph(5, 5);
      g.setWalkable(0, 0, false);
      g.setWalkable(4, 4, false);
      eq(findPath(g, { x: 0, y: 0 }, { x: 4, y: 4 }), null);
    });

    test('起终点都合法时照常找到路径（防止矫枉过正）', () => {
      const g = new GridGraph(5, 5);
      const p = findPath(g, { x: 0, y: 0 }, { x: 4, y: 4 });
      assert(p !== null, '空旷地图应能找到路径');
      if (p) {
        eq(p[0].x, 0);
        eq(p[0].y, 0);
        eq(p[p.length - 1].x, 4);
        eq(p[p.length - 1].y, 4);
      }
    });

    test('起点 = 终点且可走时返回单点（防止矫枉过正）', () => {
      const g = new GridGraph(5, 5);
      const p = findPath(g, { x: 3, y: 3 }, { x: 3, y: 3 });
      assert(p !== null);
      if (p) eq(p.length, 1);
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · runscope · 原型链键不再让 has/get/set 打架', () => {
    test('⚠️ has() 对原型链上的键返回 false', () => {
      const s = new ScopedStore({ schema: { gold: key('run', 0) } });
      eq(s.has('toString'), false, '原型链命中不算"声明过"');
      eq(s.has('valueOf'), false);
      eq(s.has('constructor'), false);
      eq(s.has('gold'), true);
    });

    test('⚠️ get()/set() 对原型链上的键给出与 has() 一致的回答', () => {
      const s = new ScopedStore({ schema: { gold: key('run', 0) } });
      s.beginRun();
      // 修复前：get 抛 "Cannot read properties of undefined (reading 'get')"
      // 现在应按"未声明的键"的统一口径处理
      throws(() => s.get('toString'), '', '未声明的键应走 onUnknownKey 的统一口径');
      throws(() => s.set('valueOf', 1), '', '同上');
    });

    test('⚠️ scopeOf() 对原型链上的键返回 null 而不是 undefined', () => {
      const s = new ScopedStore({ schema: { gold: key('run', 0) } });
      eq(s.scopeOf('toString'), null, '修复前返回 undefined，下游 switch 会掉进 default');
      eq(s.scopeOf('gold'), 'run');
    });

    test('⚠️ getOr 可以拒绝吞掉越界异常（修复前一律返回 fallback）', () => {
      const s = new ScopedStore({ schema: { gold: key('run', 10) } });
      // 局外读 run 域 —— 这是本模块存在的意义要挡住的事
      eq(s.getOr('gold', 0), 0, '默认保持兼容：返回 fallback');
      throws(
        () => s.getOr('gold', 0, { swallowCrossScope: false }),
        '',
        '显式要求严格时应把越界抛出来'
      );
    });

    test('⚠️ getOr 对"键不存在"仍然返回 fallback（防止矫枉过正）', () => {
      const s = new ScopedStore({ schema: { gold: key('run', 10) } });
      s.beginRun();
      eq(s.getOr('nope', 42, { swallowCrossScope: false }), 42, '未声明的键不该因为开了严格就抛');
    });

    test('⚠️ add() 拒绝 NaN / Infinity 增量（P2 · Ru4）', () => {
      const s = new ScopedStore({ schema: { gold: key('run', 10) } });
      s.beginRun();
      throws(() => s.add('gold', NaN), '有限数');
      throws(() => s.add('gold', Infinity), '有限数');
      eq(s.get('gold'), 10, '被拒绝的写入不能留下半个结果');
    });

    test('add() 正常增量仍然可用（防止矫枉过正）', () => {
      const s = new ScopedStore({ schema: { gold: key('run', 10) } });
      s.beginRun();
      eq(s.add('gold', 5), 15);
      eq(s.add('gold', -3), 12);
    });

    test('⚠️ importSave 校验存档值（P2 · Ru3）', () => {
      const s = new ScopedStore({ schema: { gold: key('run', 10) } });
      const orig = console.warn;
      console.warn = () => {};
      try {
        // inRun: true 的存档导入后即处于局内，不能再 beginRun
        s.importSave({ run: { gold: NaN }, meta: {}, inRun: true });
      } finally {
        console.warn = orig;
      }
      eq(s.get('gold'), 10, 'NaN 存档值应回退到初始值，而不是污染存储');
    });

    test('importSave 正常存档照常恢复（防止矫枉过正）', () => {
      const s = new ScopedStore({ schema: { gold: key('run', 10) } });
      s.importSave({ run: { gold: 999 }, meta: {}, inRun: true });
      eq(s.get('gold'), 999);
    });

    test('⚠️ destroy() 释放数据（P2 · Ru6）', () => {
      const s = new ScopedStore({ schema: { gold: key('run', 10) } });
      s.beginRun();
      s.set('gold', 55);
      s.destroy();
      s.beginRun();
      eq(s.get('gold'), 10, 'destroy 后回到初始状态');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · scheduling · StepContext.elapsed 与若干 P2', () => {
    test('⚠️ elapsed 反映本帧已用时间（修复前恒为 0）', () => {
      let t = 0;
      const fs = new FrameScheduler({ budgetMs: 1000, hardLimitMs: 100000, now: () => t });
      const seen: number[] = [];
      fs.schedule((ctx) => {
        t += 5;
        seen.push(ctx.elapsed);
        return true;
      });
      fs.update();
      eq(seen.length, 1);
      eq(seen[0], 5, '任务执行到一半读 elapsed 应看到真实耗时');
    });

    test('⚠️ 跨帧执行时 elapsed 按每帧起点重新计算', () => {
      let t = 100;
      // hardLimitMs = 1 保证每帧只跑一步，任务跨多帧执行
      const fs = new FrameScheduler({ budgetMs: 100, hardLimitMs: 1, now: () => t });
      const seen: number[] = [];
      fs.schedule((ctx) => {
        t += (seen.length + 1) * 10;   // 每步耗时递增，便于分辨是哪一帧
        seen.push(ctx.elapsed);
        return seen.length >= 3;
      });
      for (let i = 0; i < 5; i++) fs.update();

      assert(seen.length >= 3, `应跨多帧执行，实际 ${seen.length} 步`);
      eq(seen[0], 10, '第一帧已用 10ms');
      eq(seen[1], 20, '第二帧的 elapsed 应相对**本帧起点**重新计算（写死 0 时这里是 0）');
      eq(seen[2], 30);
    });

    test('⚠️ flush() 里的 elapsed 同样有效（修复前也写死 0）', () => {
      let t = 0;
      const fs = new FrameScheduler({ budgetMs: 1000, hardLimitMs: 100000, now: () => t });
      const seen: number[] = [];
      fs.schedule((ctx) => {
        t += 2;
        seen.push(ctx.elapsed);
        return true;
      });
      fs.flush();
      eq(seen[0], 2);
    });

    test('⚠️ hardLimitMs 非正数要报错而不是静默退化（P2 · Sch2）', () => {
      // 修复前：0 → 每帧只跑一个任务；-1/NaN → 硬限制完全失效，两种都不报错
      throws(() => new FrameScheduler({ hardLimitMs: 0 }), 'hardLimitMs 必须为正');
      throws(() => new FrameScheduler({ hardLimitMs: -1 }), 'hardLimitMs 必须为正');
    });

    test('⚠️ hardLimitMs 为 NaN 时回落到默认值而不是失效（P2 · Sch2）', () => {
      // NaN 参与 `>=` 比较恒为 false —— 修复前这会让硬限制彻底失效
      const fs = new FrameScheduler({ budgetMs: 4, hardLimitMs: NaN });
      eq(fs.hardLimitMs, 8, '应回落到 max(budgetMs*2, 8)');
      assert(fs.hardLimitMs > 0, '回落后必须为正，否则硬限制形同虚设');
    });

    test('合法 hardLimitMs 仍然生效（防止矫枉过正）', () => {
      let t = 0;
      const fs = new FrameScheduler({ budgetMs: 100, hardLimitMs: 1, now: () => t });
      let ran = 0;
      fs.schedule(() => { ran++; t += 10; return true; });
      fs.schedule(() => { ran++; t += 10; return true; });
      fs.update();
      eq(ran, 1, '硬上限应在第一个任务之后就中断本帧');
    });

    test('⚠️ onError 让调用方能区分"做完了"和"做炸了"（P2 · Sch3）', () => {
      const fs = new FrameScheduler({ now: () => 0 });
      const errors: unknown[] = [];
      let done = 0;
      fs.schedule(
        () => {
          throw new Error('任务炸了');
        },
        { onError: (e) => errors.push(e), onDone: () => { done++; } }
      );
      fs.update();
      eq(errors.length, 1, '出错应通知 onError');
      eq(done, 1, 'onDone 仍按 README 承诺触发（出错即完成，不重试）');
    });

    test('⚠️ scheduleBatch 空数组返回具名的 NO_TASK（P2 · Sch7）', () => {
      const fs = new FrameScheduler({ now: () => 0 });
      let doneCalled = false;
      const id = fs.scheduleBatch([], () => {}, { onDone: () => { doneCalled = true; } });
      eq(id, NO_TASK);
      eq(NO_TASK, 0, '0 是保留的"无任务"哨兵，与"有效 id 从 1 开始"不冲突');
      eq(doneCalled, true, '空批次仍同步完成');
      eq(fs.cancel(NO_TASK), false, 'cancel(NO_TASK) 是安全的空操作');
    });

    test('⚠️ flush() 不再依赖 shift（P2 · Sch6）：批量任务都能跑完', () => {
      const fs = new FrameScheduler({ now: () => 0 });
      let n = 0;
      for (let i = 0; i < 50; i++) fs.schedule(() => { n++; return true; });
      fs.flush();
      eq(n, 50);
      eq(fs.pendingCount, 0, '任务必须被移出队列');
    });

    test('⚠️ 批量注册仍保持优先级顺序（P2 · Sch5 改了插入方式）', () => {
      const fs = new FrameScheduler({ now: () => 0 });
      const order: string[] = [];
      fs.schedule(() => { order.push('low'); return true; }, { priority: 1 });
      fs.schedule(() => { order.push('high'); return true; }, { priority: 10 });
      fs.schedule(() => { order.push('mid'); return true; }, { priority: 5 });
      fs.schedule(() => { order.push('high2'); return true; }, { priority: 10 });
      fs.update();
      eq(order.join(','), 'high,high2,mid,low', '高优先级先跑，同优先级按注册顺序');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · skill-caster · resetCooldown 不留下错乱的充能数', () => {
    /** 一个带 2 层充能的技能 */
    function mkCaster(): SkillCaster {
      const c = new SkillCaster();
      c.learn({
        id: 's',
        cooldown: 5,
        charges: 2,
        windup: 0.1,
        active: 0.1,
        recover: 0.1,
      } as never);
      return c;
    }

    test('⚠️ resetCooldown 要把充能恢复满（修复前留在 0）', () => {
      const c = mkCaster();
      const ctx = { x: 0, y: 0, facingDeg: 0 } as never;

      c.tryCast('s', ctx);
      c.cancel();
      c.tryCast('s', ctx);
      c.cancel();
      eq(c.chargesLeft('s'), 0, '两次施放用光 2 层');

      c.resetCooldown('s');
      eq(c.chargesLeft('s'), 2, '重置冷却后应回到满充能');
    });

    test('⚠️ 重置后再施放不会把充能数变成负数（修复前是 -1）', () => {
      const c = mkCaster();
      const ctx = { x: 0, y: 0, facingDeg: 0 } as never;

      c.tryCast('s', ctx);
      c.cancel();
      c.tryCast('s', ctx);
      c.cancel();
      c.resetCooldown('s');

      c.tryCast('s', ctx);
      c.cancel();
      eq(c.chargesLeft('s'), 1, '不该变成 -1');
    });

    test('⚠️ 充能数被写坏时不再继续放大（clamp 到 0）', () => {
      const c = mkCaster();
      const ctx = { x: 0, y: 0, facingDeg: 0 } as never;
      // 直接把状态写坏，模拟存档导入 / 旧数据残留
      (c as unknown as { _charges: Map<string, number> })._charges.set('s', -3);

      c.tryCast('s', ctx);
      c.cancel();
      eq(c.chargesLeft('s'), 0, '损坏不应继续放大');
    });

    test('⚠️ 无参 resetCooldown 重置全部技能', () => {
      const c = mkCaster();
      const ctx = { x: 0, y: 0, facingDeg: 0 } as never;
      c.tryCast('s', ctx);
      c.cancel();
      c.resetCooldown();
      eq(c.chargesLeft('s'), 2);
    });

    test('正常充能消耗与恢复不受影响（防止矫枉过正）', () => {
      const c = mkCaster();
      const ctx = { x: 0, y: 0, facingDeg: 0 } as never;
      eq(c.chargesLeft('s'), 2);

      c.tryCast('s', ctx);
      c.cancel();
      eq(c.chargesLeft('s'), 1, '第一次施放后还剩 1 层');

      c.tryCast('s', ctx);
      c.cancel();
      eq(c.chargesLeft('s'), 0, '第二次施放后用光');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('W2-A · social · statsOf().byReason 完整且阈值收口', () => {
    test('⚠️ 未出现的 reason 也必须是数字 0（修复前是 undefined）', () => {
      const rc = new ReportCenter();
      rc.submit('a', 'bad', 'cheating', 0, { credibility: 100 });
      const st = rc.statsOf('bad');

      eq(st.byReason.cheating, 1);
      for (const r of REPORT_REASONS) {
        eq(typeof st.byReason[r], 'number', `reason "${r}" 必须是数字`);
      }
      eq(st.byReason.afk + 1, 1, 'undefined + 1 会得到 NaN，这里不能是 NaN');
    });

    test('⚠️ 空统计也是完整的 0 集合', () => {
      const rc = new ReportCenter();
      const st = rc.statsOf('nobody');
      eq(st.total, 0);
      for (const r of REPORT_REASONS) eq(st.byReason[r], 0);
      eq(REPORT_REASONS.length, 6);
    });

    test('byReason 的计数仍然正确（防止矫枉过正）', () => {
      const rc = new ReportCenter();
      rc.submit('a', 't', 'cheating', 0, { credibility: 100 });
      rc.submit('b', 't', 'cheating', 1000, { credibility: 100 });
      rc.submit('c', 't', 'afk', 2000, { credibility: 100 });
      const st = rc.statsOf('t');
      eq(st.byReason.cheating, 2);
      eq(st.byReason.afk, 1);
      eq(st.byReason.other, 0);
    });

    test('⚠️ abuseThreshold 为 NaN 时回落到默认值而不是永久失效', () => {
      const rc = new ReportCenter({ abuseThreshold: NaN });
      // 修复前：0 >= NaN 恒为 false → 无论驳回多少次都识别不出恶意举报者
      eq(rc.isAbusiveReporter('r0'), false, '一条都没被驳回时不该被判恶意');

      // 同一个举报人连续提交 5 条（间隔大于默认冷却），再全部驳回
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = rc.submit('r0', `t${i}`, 'cheating', i * 4_000_000, { credibility: 100 });
        if (r.ticket) ids.push(r.ticket.id);
      }
      eq(ids.length, 5, '5 条举报都应被受理');

      for (let i = 0; i < 4; i++) rc.reject(ids[i]);
      eq(rc.isAbusiveReporter('r0'), false, '4 次还不够（默认阈值 5）');
      rc.reject(ids[4]);
      eq(rc.isAbusiveReporter('r0'), true, '第 5 次之后应被识别为恶意举报者');
    });

    test('⚠️ abuseThreshold 为 0 / 负数时不该把所有人都判成恶意', () => {
      eq(new ReportCenter({ abuseThreshold: 0 }).isAbusiveReporter('x'), false);
      eq(new ReportCenter({ abuseThreshold: -1 }).isAbusiveReporter('x'), false);
    });

    test('⚠️ actionThreshold 为 NaN 时不该让 needsAction 恒 false', () => {
      const rc = new ReportCenter({ actionThreshold: NaN });
      rc.submit('a', 'b', 'cheating', 0, { credibility: 100 });
      // 默认 3.0；一个信誉 100 的人 = 1.0，还不够
      eq(rc.needsAction('b'), false);
      eq(rc.remainingToAction('b'), 2, '剩余分应基于默认阈值计算');
    });

    test('正常阈值行为不变（防止矫枉过正）', () => {
      const rc = new ReportCenter({ actionThreshold: 1, abuseThreshold: 2 });
      rc.submit('a', 'b', 'cheating', 0, { credibility: 100 });
      eq(rc.needsAction('b'), true, '权重 1.0 >= 1');

      const rc2 = new ReportCenter();
      rc2.submit('a', 'b', 'cheating', 0, { credibility: 100 });
      eq(rc2.needsAction('b'), false, '默认阈值 3 时一个人不够');
    });
  });
}
