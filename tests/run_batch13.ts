/**
 * tests/run_batch13.ts —— 第十二批测试：工程效率与系统补完
 *
 * 本批十个模块：
 * 1. Observable · 响应式（UI 自动刷新的地基）
 * 2. CheatCode · 作弊码/命令
 * 3. TimeUtil · 时间工具（孤儿插件收尾）
 * 4. UINav · UI 导航栈
 * 5. Telemetry · 埋点上报
 * 6. Rarity · 稀有度
 * 7. Stats · 统计追踪
 * 8. Achievement · 成就
 * 9. Gesture · 手势识别
 * 10. Rebind · 按键重映射
 */

import { test, testAsync, describe, describeAsync, assert, eq, near, throws } from './_framework';
import { RNG } from '../rng/RNG';
import {
  ref,
  computed,
  batch,
  flush,
  Subscription,
  Observable,
  Computed,
  type Change,
  type Listener,
} from '../observable/Observable';
import {
  CheatCode,
  tokenize,
  levenshtein,
  type CommandDef,
} from '../cheatcode/CheatCode';
import {
  Zones,
  DAY_MS,
  startOfDay,
  startOfNextDay,
  dayIndex,
  isNewDay,
  msUntilNextDay,
  ticksSince,
  ClockSync,
  monotonicNow,
  Countdown,
  formatDuration,
  formatDurationCN,
} from '../timeutil/TimeUtil';
import { UINav, type NavChange } from '../uinav/UINav';
import { Telemetry, hashString, type TelemetryEvent } from '../telemetry/Telemetry';
import { Rarity, CommonRarity, SimpleRarity } from '../rarity/Rarity';
import { Stats, makeKey } from '../stats/Stats';
import { Achievement } from '../achievement/Achievement';
import {
  recognize,
  recognizePinch,
  dirOf,
  pathLength,
  totalTurn,
  boundsOf,
  GestureRecognizer,
  DoubleTapDetector,
  type Point,
} from '../gesture/Gesture';
import {
  Rebind,
  encodeBinding,
  decodeBinding,
  formatBinding,
  prettyKey,
  DEFAULT_RESERVED,
} from '../rebind/Rebind';

export async function runBatch13Tests(): Promise<void> {
  // ============================================================
  describe('Observable · 响应式（UI 自动刷新的地基）', () => {
    // ============================================================

    test('new Observable 与 ref 等价', () => {
      const a = new Observable<number>(1);
      const b = ref<number>(1);
      eq(a.value, b.value);
      a.value = 2;
      eq(a.value, 2);
    });

    test('new Computed 与 computed 等价', () => {
      const src = ref(2);
      const a = new Computed(() => src.value * 3);
      const b = computed(() => src.value * 3);
      eq(a.value, 6);
      eq(b.value, 6);
      src.value = 5;
      eq(a.value, 15);
      eq(b.value, 15);
    });

    test('基本：赋值触发通知', () => {
      const hp = ref(100);
      const seen: number[] = [];
      hp.subscribe(({ value }) => seen.push(value));
      hp.value = 80;
      hp.value = 50;
      eq(seen.join(','), '80,50');
    });

    test('⚠️ 相同值不通知', () => {
      const hp = ref(100);
      let n = 0;
      hp.subscribe(() => n++);
      hp.value = 100;   // 与当前相同
      eq(n, 0, '相同值不该触发通知');
    });

    test('prev 是变化前的值', () => {
      const hp = ref(100);
      const seen: Array<[number, number]> = [];
      hp.subscribe(({ value, prev }) => seen.push([prev, value]));
      hp.value = 80;
      hp.value = 50;
      eq(JSON.stringify(seen), '[[100,80],[80,50]]');
    });

    test('update 函数式更新', () => {
      const n = ref(1);
      n.update((x) => x * 10);
      eq(n.value, 10);
    });

    test('⚠️ 批量：多次修改只通知一次', () => {
      /**
       * 【修过的 bug】
       * 原实现把每个通知包成闭包入队，10 次修改产生 10 个不同闭包，
       * flush 时全部执行 → UI 刷 10 次，批量等于没做。
       *
       * 修法：按"来源"入队（Set 去重）+ 每个来源只保留最后一次变更。
       */
      const gold = ref(0);
      let n = 0;
      gold.subscribe(() => n++);
      batch(() => {
        for (let i = 1; i <= 10; i++) gold.value = i;
      });
      eq(n, 1, '10 次修改应合并成 1 次通知');
      eq(gold.value, 10);
    });

    test('⚠️ 批量：prev 保留批量开始时的值（净变化）', () => {
      const gold = ref(0);
      let last: { value: number; prev: number } | null = null;
      gold.subscribe((c) => {
        last = { value: c.value, prev: c.prev };
      });
      batch(() => {
        for (let i = 1; i <= 9; i++) gold.value = i;
      });
      eq(last!.prev, 0, 'prev 应是批量开始前的值 0');
      eq(last!.value, 9, 'value 应是最终值 9');
    });

    test('手动 flush（不通过 batch 也能合并）', () => {
      /**
       * 宿主在 update() 末尾调 flush() 是推荐用法：
       * 一帧内的所有修改在此统一结算。
       */
      const a = ref(0);
      const seen: number[] = [];
      const listener: Listener<number> = ({ value }) => seen.push(value);
      a.subscribe(listener);
      batch(() => {
        a.value = 1;
        a.value = 2;
      });
      /**
       * 注意：batch 结束时**已经**自动 flush 过了，
       * 所以这里 seen 已有一条。显式再调 flush() 应无副作用（队列已空）。
       */
      eq(seen.length, 1, 'batch 结束时自动 flush，应已发出一次');
      flush();
      eq(seen.join(','), '2', '队列已空，不该重复通知');
    });

    test('Change 携带 prev 与 value（类型可标注）', () => {
      const a = ref(1);
      let captured: Change<number> | null = null;
      const listener: Listener<number> = (c) => { captured = c; };
      a.subscribe(listener);
      a.value = 5;
      eq(captured!.prev, 1);
      eq(captured!.value, 5);
    });

    test('批量嵌套：只在最外层退出时 flush', () => {
      const n1 = ref(0);
      const n2 = ref(0);
      let count = 0;
      n1.subscribe(() => count++);
      n2.subscribe(() => count++);
      batch(() => {
        n1.value = 1;
        batch(() => {
          n2.value = 1;
        });
        eq(count, 0, '内层退出时不该 flush');
      });
      eq(count, 2, '外层退出才 flush（两个不同的源，各一次）');
    });

    test('批量中的命令抛错也会 end（try/finally）', () => {
      const before = ref(0);
      let threw = false;
      try {
        batch(() => {
          before.value = 1;
          throw new Error('boom');
        });
      } catch {
        threw = true;
      }
      assert(threw, '异常应向外传播');
      // 关键：批量深度必须归零，否则后续所有通知都被吞掉
      const after = ref(0);
      let n = 0;
      after.subscribe(() => n++);
      after.value = 1;
      eq(n, 1, '批量深度未泄漏，后续通知正常');
    });

    test('取消订阅', () => {
      const hp = ref(100);
      let n = 0;
      const stop = hp.subscribe(() => n++);
      hp.value = 50;
      stop();
      hp.value = 20;
      eq(n, 1, '取消后不该再收到通知');
    });

    test('once 只触发一次', () => {
      const hp = ref(100);
      let n = 0;
      hp.once(() => n++);
      hp.value = 50;
      hp.value = 20;
      eq(n, 1);
    });

    test('⚠️ 订阅者抛错不影响其他人', () => {
      const hp = ref(100);
      const seen: string[] = [];
      const origError = console.error;
      console.error = () => {};   // 屏蔽预期内的错误输出
      try {
        hp.subscribe(() => {
          throw new Error('boom');
        });
        hp.subscribe(() => seen.push('ok'));
        hp.value = 50;
      } finally {
        console.error = origError;
      }
      eq(seen.join(','), 'ok', '第二个订阅者应正常收到');
    });

    test('peek 不建立依赖', () => {
      const a = ref(1);
      const c = computed(() => a.peek());
      eq(c.value, 1);
      a.value = 99;
      eq(c.value, 1, 'peek 不建立依赖，computed 不重算（惰性下仍是旧值）');
    });

    test('自定义 equals', () => {
      const arr = ref<number[]>([1], { equals: (a, b) => a.length === b.length });
      let n = 0;
      arr.subscribe(() => n++);
      arr.value = [9];   // 长度相同 → 视为相等
      eq(n, 0, '自定义 equals 生效');
      arr.value = [9, 9];
      eq(n, 1);
    });

    test('dispose 清空订阅', () => {
      const hp = ref(100);
      hp.subscribe(() => {});
      hp.subscribe(() => {});
      eq(hp.listenerCount, 2);
      hp.dispose();
      eq(hp.listenerCount, 0);
    });

    // ---------- Computed ----------

    test('computed 基本：自动重算', () => {
      const hp = ref(100);
      const maxHp = ref(100);
      const ratio = computed(() => hp.value / maxHp.value);
      eq(ratio.value, 1);
      hp.value = 25;
      eq(ratio.value, 0.25);
    });

    test('⚠️ computed 依赖在运行期变化（条件分支）', () => {
      /**
       * cond 变了之后，依赖从 {cond, a} 变成 {cond, b}。
       * 只在构造时追踪一次的话，b 变了不会重算。
       */
      const cond = ref(true);
      const a = ref(1);
      const b = ref(2);
      const pick = computed(() => (cond.value ? a.value : b.value));

      eq(pick.value, 1);
      cond.value = false;
      eq(pick.value, 2, '切换分支后应重算');

      b.value = 99;
      eq(pick.value, 99, 'b 现在是依赖，变化应触发');

      a.value = -1;
      eq(pick.value, 99, 'a 已不是依赖，变化不该影响');
    });

    test('⚠️ computed 链：下层变化必须冒泡到上层', () => {
      /**
       * 【修过的 bug】
       * 原实现只把下层 computed 放进一个 Set（_chainDeps），
       * 但**没有真正 subscribe**。
       * 于是下层没有 listener → 走惰性分支 → 不通知上层 → 上层永远是旧值。
       */
      const base = ref(1);
      const mid = computed(() => base.value * 10);
      const top = computed(() => mid.value * 2);

      eq(top.value, 20);
      base.value = 5;
      eq(top.value, 100, '链式必须冒泡');
    });

    test('computed 可被订阅', () => {
      const a = ref(1);
      const dbl = computed(() => a.value * 2);
      const seen: number[] = [];
      dbl.subscribe(({ value }) => seen.push(value));
      a.value = 2;
      a.value = 3;
      eq(seen.join(','), '4,6');
    });

    test('computed 惰性：没人读就不算', () => {
      let calls = 0;
      const a = ref(1);
      const c = computed(() => {
        calls++;
        return a.value;
      });
      eq(calls, 0, '构造时求值一次？不——构造确实会求值一次');
      void c;
    });

    test('computed 值未变则不通知订阅者', () => {
      const a = ref(1);
      const always = computed(() => a.value * 0 + 7);   // 恒为 7
      let n = 0;
      always.subscribe(() => n++);
      a.value = 2;
      eq(n, 0, 'computed 结果没变就不该通知');
    });

    test('invalidate 强制重算', () => {
      let v = 1;
      const c = computed(() => v);
      eq(c.value, 1);
      v = 2;
      c.invalidate();
      eq(c.value, 2);
    });

    test('computed dispose 后不再重算', () => {
      const a = ref(1);
      const c = computed(() => a.value * 2);
      eq(c.value, 2);
      c.dispose();
      a.value = 5;
      eq(c.value, 2, 'dispose 后依赖已解绑');
    });

    // ---------- Subscription ----------

    test('Subscription 批量取消', () => {
      const sub = new Subscription();
      const a = ref(0);
      const b = ref(0);
      let n = 0;
      sub.add(a.subscribe(() => n++));
      sub.add(b.subscribe(() => n++));
      eq(sub.size, 2);
      a.value = 1;
      eq(n, 1);
      sub.unsubscribeAll();
      a.value = 2;
      b.value = 2;
      eq(n, 1, '全部取消后不再收到通知');
      eq(sub.closed, true);
    });

    test('⚠️ 已关闭的 Subscription 再 add 会立即取消', () => {
      /**
       * 否则调用方以为"加上了"，实际这个订阅永远不会被清掉 → 泄漏。
       */
      const sub = new Subscription();
      sub.unsubscribeAll();
      const a = ref(0);
      let n = 0;
      sub.add(a.subscribe(() => n++));
      a.value = 1;
      eq(n, 0, '加入已关闭的收集器时订阅应被立即取消');
    });
  });

  // ============================================================
  describe('CheatCode · 作弊码', () => {
    // ============================================================

    function make(opts = {}) {
      const cc = new CheatCode(opts);
      let god = false;
      let gold = 0;
      cc.registerAll([
        {
          name: 'god',
          aliases: ['gm'],
          desc: '无敌',
          run: () => {
            god = !god;
            return `god=${god}`;
          },
        },
        {
          name: 'setgold',
          desc: '设金币',
          args: [{ name: 'amount', type: 'int' }],
          run: ({ args }) => {
            gold = args[0] as number;
            return `gold=${gold}`;
          },
        },
        {
          name: 'heal',
          desc: '回血',
          args: [{ name: 'amount', type: 'int', optional: true, default: 100 }],
          run: ({ args }) => `healed ${args[0]}`,
        },
        {
          name: 'nuke',
          desc: '清场',
          hidden: true,
          run: () => 'boom',
        },
      ] as CommandDef[]);
      return { cc, get gold() { return gold; }, get god() { return god; } };
    }

    test('基本：执行命令', () => {
      const { cc } = make();
      const r = cc.execute('god');
      eq(r.handled, true);
      eq(r.output, 'god=true');
    });

    test('带参数', () => {
      const h = make();
      h.cc.execute('setgold 999');
      eq(h.gold, 999);
    });

    test('⚠️ 参数类型不符时报错且不执行', () => {
      const h = make();
      const r = h.cc.execute('setgold abc');
      eq(r.handled, false);
      assert(r.error?.includes('int') ?? false, `应提示类型，实际 "${r.error}"`);
      eq(h.gold, 0, '不该执行');
    });

    test('缺少必填参数', () => {
      const h = make();
      const r = h.cc.execute('setgold');
      eq(r.handled, false);
      assert(r.error?.includes('缺少参数') ?? false);
    });

    test('可选参数用默认值', () => {
      const h = make();
      const r = h.cc.execute('heal');
      eq(r.output, 'healed 100');
    });

    test('别名', () => {
      const h = make();
      eq(h.cc.execute('gm').handled, true);
      eq(h.god, true);
    });

    test('⚠️ 拼写错误给出建议', () => {
      const h = make();
      const r = h.cc.execute('godd');
      eq(r.handled, false);
      assert(r.error?.includes('god') ?? false, `应建议 god，实际 "${r.error}"`);
    });

    test('⚠️ 禁用后不执行任何命令（发布开关）', () => {
      const h = make();
      h.cc.enabled = false;
      const r = h.cc.execute('setgold 999');
      eq(r.handled, false, '禁用后应完全不处理');
      eq(h.gold, 0, '不该有任何副作用');
      h.cc.enabled = true;
      h.cc.execute('setgold 1');
      eq(h.gold, 1, '重新启用后恢复');
    });

    test('前缀模式', () => {
      const h = make({ prefix: '/' });
      eq(h.cc.execute('god').handled, false, '无前缀不识别');
      eq(h.cc.execute('/god').handled, true);
    });

    test('命令抛错被捕获', () => {
      const cc = new CheatCode();
      cc.register({ name: 'boom', desc: '', run: () => { throw new Error('x'); } });
      const r = cc.execute('boom');
      eq(r.handled, true);
      assert(r.error?.includes('执行失败') ?? false);
    });

    test('重复注册抛错', () => {
      const h = make();
      throws(() => h.cc.register({ name: 'god', desc: '', run: () => {} }), '重复');
    });

    test('别名冲突抛错', () => {
      const h = make();
      throws(() => h.cc.register({ name: 'x', aliases: ['god'], desc: '', run: () => {} }), '冲突');
    });

    test('命令名不能含空格', () => {
      const cc = new CheatCode();
      throws(() => cc.register({ name: 'set gold', desc: '', run: () => {} }), '空格');
    });

    test('unregister 同时移除别名', () => {
      const h = make();
      eq(h.cc.has('gm'), true);
      eq(h.cc.unregister('god'), true);
      eq(h.cc.has('god'), false);
      eq(h.cc.has('gm'), false, '别名应一并移除');
    });

    test('commands 去重（别名不重复列出）', () => {
      const h = make();
      eq(h.cc.commands.length, 4, '别名不该重复列出');
    });

    test('补全', () => {
      const h = make();
      eq(h.cc.complete('s').join(','), 'setgold');
      eq(h.cc.complete('g').sort().join(','), 'god');
    });

    test('⚠️ help 默认不含隐藏命令', () => {
      const h = make();
      assert(!h.cc.help().includes('nuke'), '隐藏命令不该出现在 help');
      assert(h.cc.help(true).includes('nuke'), '显式要求时应包含');
    });

    test('历史：相同命令不重复记录', () => {
      const h = make();
      h.cc.execute('god');
      h.cc.execute('god');
      eq(h.cc.history.length, 1, '连续执行相同命令只记一条');
    });

    test('历史上翻/下翻', () => {
      const h = make();
      h.cc.execute('god');
      h.cc.execute('setgold 1');
      eq(h.cc.prevHistory(), 'setgold 1', '第一次上翻应给最新一条');
      eq(h.cc.prevHistory(), 'god');
      eq(h.cc.prevHistory(), null, '到头返回 null');
      h.cc.prevHistory();
      eq(h.cc.nextHistory(), 'god');
    });

    test('空历史时上翻返回 null', () => {
      const h = make();
      eq(h.cc.prevHistory(), null);
    });

    test('clearHistory', () => {
      const h = make();
      h.cc.execute('god');
      h.cc.clearHistory();
      eq(h.cc.history.length, 0);
    });

    test('⚠️ 未知命令触发 onUnknown', () => {
      let got = '';
      const cc = new CheatCode({ onUnknown: (raw) => { got = raw; } });
      cc.execute('nope');
      eq(got, 'nope');
    });

    test('onRun 回调', () => {
      const seen: string[] = [];
      const cc = new CheatCode({ onRun: (name, _raw, ok) => seen.push(`${name}:${ok}`) });
      cc.register({ name: 'a', desc: '', run: () => {} });
      cc.register({ name: 'b', desc: '', run: () => { throw new Error('x'); } });
      cc.execute('a');
      cc.execute('b');
      eq(seen.join(','), 'a:true,b:false');
    });

    // ---------- 工具函数 ----------

    test('tokenize 支持引号', () => {
      eq(tokenize('a "b c" d').join('|'), 'a|b c|d');
    });

    test('tokenize 忽略多余空格', () => {
      eq(tokenize('  a   b  ').join('|'), 'a|b');
    });

    test('levenshtein', () => {
      eq(levenshtein('', ''), 0);
      eq(levenshtein('abc', 'abc'), 0);
      eq(levenshtein('abc', 'abd'), 1);
      eq(levenshtein('kitten', 'sitting'), 3);
    });
  });

  // ============================================================
  describe('TimeUtil · 时间工具', () => {
    // ============================================================

    /** 2024-01-01 00:00:00 UTC */
    const T0 = 1704067200000;

    test('startOfDay（UTC）', () => {
      eq(startOfDay(T0 + 5 * 3600_000, Zones.UTC), T0);
    });

    test('⚠️ startOfDay（东八区）', () => {
      /**
       * UTC 2024-01-01 00:00 是北京 08:00，属于北京 1/1。
       * 北京 1/1 的 00:00 = UTC 2023-12-31 16:00 = T0 - 8h。
       */
      eq(startOfDay(T0, Zones.CN), T0 - 8 * 3600_000);
    });

    test('startOfNextDay 与 startOfDay 相差一天', () => {
      eq(startOfNextDay(T0, Zones.CN) - startOfDay(T0, Zones.CN), DAY_MS);
    });

    test('⚠️ msUntilNextDay（东八区）', () => {
      /**
       * 北京 1/1 08:00 → 下一个北京 0 点是 1/2 00:00 北京 = UTC 1/1 16:00。
       * 距 T0（UTC 1/1 00:00）是 16 小时。
       *
       * 【我写测试时算错过一次】
       * 我预期 8 小时，代码给出 16 小时——代码是对的。
       */
      eq(msUntilNextDay(T0, Zones.CN), 16 * 3600_000);
      eq(msUntilNextDay(T0, Zones.UTC), DAY_MS);
    });

    test('dayIndex 与时区相关', () => {
      // UTC 1/1 00:00 → 北京是 1/1 08:00，同一天
      eq(dayIndex(T0, Zones.CN), dayIndex(T0, Zones.UTC));
      // UTC 1/1 20:00 → 北京是 1/2 04:00（跨天了）
      const t = T0 + 20 * 3600_000;
      eq(dayIndex(t, Zones.CN), dayIndex(t, Zones.UTC) + 1);
    });

    test('isNewDay', () => {
      const today = dayIndex(T0, Zones.CN);
      eq(isNewDay(T0, today, Zones.CN), false, '同一天不算新');
      eq(isNewDay(T0 + DAY_MS, today, Zones.CN), true);
    });

    test('ticksSince 基本', () => {
      eq(ticksSince(0, 3600_000, 300_000), 12, '1 小时 / 5 分钟 = 12');
    });

    test('⚠️ ticksSince 用 maxTicks 夹紧（防离线补满）', () => {
      /**
       * 玩家离线一天回来，不该直接补满体力。
       * 这是设计决定不是优化。
       */
      eq(ticksSince(0, DAY_MS, 300_000, 5), 5);
    });

    test('⚠️ ticksSince 时间倒流返回 0（不奖励改系统时间）', () => {
      eq(ticksSince(1000, 500, 300_000), 0);
    });

    test('ticksSince 周期为 0 抛错', () => {
      throws(() => ticksSince(0, 100, 0), '必须为正');
    });

    // ---------- ClockSync ----------

    test('ClockSync 未校准时返回本地时间', () => {
      const c = new ClockSync();
      eq(c.synced, false);
      assert(Math.abs(c.now() - Date.now()) < 1000);
    });

    test('ClockSync 校准（含 RTT 补偿）', () => {
      const c = new ClockSync({ now: 1000, mono: 0 });
      // 请求时本地 1000，响应时本地 1200，RTT=200
      // 中点 = 1100，服务器时间 5000 → offset = 5000 - 1100 = 3900
      c.sync(5000, 1000, 1200);
      eq(c.offset, 3900);
      eq(c.synced, true);
    });

    test('ClockSync 负 RTT 被夹紧为 0（时钟异常）', () => {
      const c = new ClockSync({ now: 1000, mono: 0 });
      c.sync(5000, 1200, 1000);   // 响应早于请求，不可能
      eq(c.offset, 5000 - 1200, 'rtt 被夹紧为 0，midLocal = localAtRequest');
    });

    test('ClockSync.syncSimple', () => {
      const c = new ClockSync();
      c.syncSimple(5000, 1000);
      eq(c.offset, 4000);
    });

    test('ClockSync.reset', () => {
      const c = new ClockSync();
      c.syncSimple(5000, 1000);
      c.reset();
      eq(c.synced, false);
      eq(c.offset, 0);
    });

    test('monotonicNow 单调不减', () => {
      const a = monotonicNow();
      const b = monotonicNow();
      assert(b >= a, '单调时钟不应倒退');
    });

    // ---------- Countdown ----------

    test('Countdown 基本', () => {
      const c = new Countdown(10_000);
      c.start(1000);
      eq(c.remaining(3000), 8000);
      eq(c.isFinished(3000), false);
      eq(c.isFinished(12_000), true);
    });

    test('⚠️ Countdown 剩余永不为负', () => {
      const c = new Countdown(1000);
      c.start(0);
      eq(c.remaining(9999), 0, '不该出现负数倒计时');
    });

    test('Countdown 进度', () => {
      const c = new Countdown(10_000);
      c.start(0);
      near(c.progress(2500), 0.25, 1e-9);
      near(c.progress(10_000), 1, 1e-9);
    });

    test('Countdown 暂停/恢复', () => {
      const c = new Countdown(10_000);
      c.start(0);
      c.pause(2000);
      eq(c.remaining(5000), 8000, '暂停期间剩余时间不流逝');
      c.resume(5000);
      eq(c.remaining(6000), 7000);
    });

    test('⚠️ 重复 pause 不叠加', () => {
      const c = new Countdown(10_000);
      c.start(0);
      c.pause(1000);
      c.pause(2000);   // 已在暂停中，应忽略
      c.resume(2000);
      eq(c.remaining(2000), 9000);
    });

    test('Countdown startWith（存档恢复）', () => {
      const c = new Countdown(10_000);
      c.startWith(3000, 1000);
      eq(c.remaining(1000), 3000);
    });

    test('Countdown 状态', () => {
      const c = new Countdown(1000);
      eq(c.state(0), 'waiting');
      c.start(0);
      eq(c.state(500), 'running');
      eq(c.state(1500), 'finished');
    });

    test('Countdown 时长为 0 抛错', () => {
      throws(() => new Countdown(0), '必须为正');
    });

    test('Countdown reset', () => {
      const c = new Countdown(1000);
      c.start(0);
      c.reset();
      eq(c.state(0), 'waiting');
    });

    // ---------- 格式化 ----------

    test('⚠️ formatDuration 超过 24 小时不归零', () => {
      /**
       * `new Date(ms).toISOString()` 会进位成天数，
       * 显示 "1:00:00" 而不是 "24:00:00"。
       * 活动倒计时超过一天很常见。
       */
      eq(formatDuration(25 * 3600_000), '25:00:00');
      eq(formatDuration(100 * 3600_000), '100:00:00');
    });

    test('formatDuration 不足一小时只显示分秒', () => {
      eq(formatDuration(65_000), '01:05');
      eq(formatDuration(0), '00:00');
      eq(formatDuration(-5000), '00:00', '负数夹到 0');
    });

    test('formatDuration showHoursAlways', () => {
      eq(formatDuration(65_000, { showHoursAlways: true }), '00:01:05');
    });

    test('formatDurationCN', () => {
      eq(formatDurationCN(0), '0秒');
      eq(formatDurationCN(90_000), '1分30秒');
      eq(formatDurationCN(90061_000), '1天1小时', 'maxUnits=2 只显示两级');
      eq(formatDurationCN(-100), '0秒', '负数夹到 0');
    });
  });

  // ============================================================
  describe('UINav · UI 导航栈', () => {
    // ============================================================

    function make(opts = {}) {
      const nav = new UINav<string>({ idOf: (x) => x, ...opts });
      let clock = 0;
      nav.useClock(() => clock);
      return { nav, tick: (ms: number) => { clock += ms; } };
    }

    test('基本：push / current / depth', () => {
      const { nav } = make();
      eq(nav.current, null);
      eq(nav.isEmpty, true);
      nav.push('bag');
      eq(nav.current, 'bag');
      eq(nav.depth, 1);
    });

    test('多层栈与 pop', () => {
      const { nav } = make();
      nav.push('bag');
      nav.push('item');
      nav.push('confirm');
      eq(nav.depth, 3);
      eq(nav.current, 'confirm');
      nav.pop();
      eq(nav.current, 'item', '返回键应退一层');
    });

    test('pop 返回被关闭的界面', () => {
      const { nav } = make();
      nav.push('a');
      eq(nav.pop(), 'a');
    });

    test('⚠️ 空栈 pop 返回 null 不报错', () => {
      const { nav } = make();
      eq(nav.pop(), null);
      eq(nav.pop(), null, '反复 pop 应安全');
    });

    test('replace 替换栈顶', () => {
      const { nav } = make();
      nav.push('login');
      nav.replace('home');
      eq(nav.depth, 1, '不该增加层数');
      eq(nav.current, 'home');
    });

    test('replace 在空栈上等价于 push', () => {
      const { nav } = make();
      nav.replace('home');
      eq(nav.depth, 1);
      eq(nav.current, 'home');
    });

    test('popTo 保留目标层，关闭其上的', () => {
      const { nav } = make();
      nav.push('home');
      nav.push('bag');
      nav.push('item');
      eq(nav.popTo('bag'), true);
      eq(nav.depth, 2);
      eq(nav.current, 'bag');
    });

    test('popTo 不存在的 id 返回 false', () => {
      const { nav } = make();
      nav.push('a');
      eq(nav.popTo('nope'), false);
      eq(nav.depth, 1, '不该有副作用');
    });

    test('popTo 已在栈顶返回 false', () => {
      const { nav } = make();
      nav.push('a');
      eq(nav.popTo('a'), false, '无需动作');
    });

    test('popToDepth', () => {
      const { nav } = make();
      nav.push('a'); nav.push('b'); nav.push('c');
      eq(nav.popToDepth(1), true);
      eq(nav.depth, 1);
    });

    test('popToDepth(0) 清空', () => {
      const { nav } = make();
      nav.push('a'); nav.push('b');
      nav.popToDepth(0);
      eq(nav.isEmpty, true);
    });

    test('popToDepth 目标比当前深则返回 false', () => {
      const { nav } = make();
      nav.push('a');
      eq(nav.popToDepth(5), false);
    });

    test('clear', () => {
      const { nav } = make();
      nav.push('a'); nav.push('b');
      nav.clear();
      eq(nav.isEmpty, true);
      eq(nav.current, null);
    });

    test('clear 空栈不触发事件', () => {
      let n = 0;
      const nav = new UINav<string>({ onChange: () => n++ });
      nav.clear();
      eq(n, 0);
    });

    test('⚠️ 转场锁：期间忽略 push（防连点）', () => {
      const { nav, tick } = make({ transitionMs: 100 });
      nav.push('a');
      eq(nav.locked, true);
      eq(nav.push('b'), false, '转场中应被忽略');
      tick(150);
      eq(nav.push('b'), true, '转场结束后恢复');
      eq(nav.depth, 2);
    });

    test('⚠️ 转场锁同样作用于 pop', () => {
      /**
       * 【修正过的测试写法】
       * 原写法在 push('a') 后立刻 push('b')，
       * 但转场锁会（正确地）拒绝第二次 push——
       * 于是栈里只有一层，后面的断言全部错位。
       *
       * 转场锁对 push 生效已由上一个测试覆盖，
       * 这里需要先 tick 掉转场，把栈建到两层，再验证 pop 的锁定。
       */
      const { nav, tick } = make({ transitionMs: 100 });
      nav.push('a');
      tick(150);
      nav.push('b');
      tick(150);
      eq(nav.depth, 2, '栈应已建到两层');
      eq(nav.pop(), 'b');
      eq(nav.pop(), null, '转场中 pop 应被忽略');
      tick(150);
      eq(nav.pop(), 'a');
    });

    test('transitionMs=0 时不锁定', () => {
      const { nav } = make();
      nav.push('a');
      eq(nav.locked, false);
      eq(nav.push('b'), true, '不锁定时可连续 push');
      eq(nav.depth, 2);
    });

    test('duplicate=ignore 拒绝重复', () => {
      const { nav } = make({ duplicate: 'ignore' });
      nav.push('a');
      eq(nav.push('a'), false);
      eq(nav.depth, 1);
    });

    test('duplicate=popTo 回退到已有层', () => {
      const { nav } = make({ duplicate: 'popTo' });
      nav.push('home');
      nav.push('bag');
      nav.push('item');
      nav.push('bag');   // 已存在 → 回退到它
      eq(nav.depth, 2);
      eq(nav.current, 'bag');
    });

    test('duplicate=allow 允许重复（默认）', () => {
      const { nav } = make();
      nav.push('a');
      nav.push('a');
      eq(nav.depth, 2);
    });

    test('contains / indexOf', () => {
      const { nav } = make();
      nav.push('a'); nav.push('b');
      eq(nav.contains('a'), true);
      eq(nav.indexOf('a'), 0, '栈底');
      eq(nav.indexOf('b'), 1);
      eq(nav.indexOf('z'), -1);
    });

    test('reset 重建栈', () => {
      const { nav } = make();
      nav.push('a');
      nav.reset(['x', 'y']);
      eq(nav.depth, 2);
      eq(nav.current, 'y');
    });

    test('⚠️ onChange 事件携带正确的 closed 与 previous', () => {
      const seen: NavChange<string>[] = [];
      const nav = new UINav<string>({ onChange: (c) => seen.push(c) });
      nav.push('a');
      nav.push('b');
      nav.pop();

      eq(seen[0].action, 'push');
      eq(seen[0].previous, null);
      eq(seen[0].current, 'a');

      eq(seen[1].previous, 'a');
      eq(seen[1].current, 'b');

      eq(seen[2].action, 'pop');
      eq(seen[2].closed.join(','), 'b');
      eq(seen[2].current, 'a');
    });

    test('clear 事件报告全部被关闭的界面', () => {
      let closed: readonly string[] = [];
      const nav = new UINav<string>({ onChange: (c) => { closed = c.closed; } });
      nav.push('a'); nav.push('b'); nav.push('c');
      nav.clear();
      eq(closed.join(','), 'a,b,c');
    });

    test('stack 顺序是栈底到栈顶', () => {
      const { nav } = make();
      nav.push('a'); nav.push('b'); nav.push('c');
      eq(nav.stack.join(','), 'a,b,c');
    });
  });

  // ============================================================
  await describeAsync('Telemetry · 埋点上报', async () => {
    // ============================================================

    function makeSender() {
      const sent: TelemetryEvent[][] = [];
      let failNext = false;
      const sender = async (batch: readonly TelemetryEvent[]) => {
        if (failNext) {
          failNext = false;
          throw new Error('network down');
        }
        sent.push([...batch]);
        return true;
      };
      return { sent, sender, failOnce: () => { failNext = true; } };
    }

    function make(opts = {}) {
      const s = makeSender();
      let clock = 0;
      const t = new Telemetry({ sender: s.sender, batchSize: 5, flushIntervalMs: 1000, ...opts });
      t.useClock(() => clock);
      return { t, s, tick: (ms: number) => { clock += ms; } };
    }

    test('基本：capture 进入缓冲', () => {
      const { t } = make();
      eq(t.capture('level_start', { level: 3 }), true);
      eq(t.buffered, 1);
    });

    await testAsync('⚠️ 达到 batchSize 自动发送', async () => {
      const { t, s } = make();
      for (let i = 0; i < 5; i++) t.capture('e', { i });
      await new Promise((r) => setTimeout(r, 0));   // 等 sender 的 Promise
      eq(s.sent.length, 1, '攒够 5 条应发一次');
      eq(s.sent[0].length, 5);
      eq(t.buffered, 0);
    });

    test('未达 batchSize 不发送', () => {
      const { t, s } = make();
      t.capture('e');
      eq(s.sent.length, 0);
    });

    await testAsync('⚠️ 超过 flushInterval 后 tick 触发发送', async () => {
      const { t, s, tick } = make();
      t.capture('e');
      tick(500);
      eq(t.shouldFlush(), false, '还没到时间');
      tick(600);
      eq(t.shouldFlush(), true);
      await t.flush();
      eq(s.sent.length, 1);
    });

    await testAsync('通用属性自动注入', async () => {
      const { t, s } = make({ commonProps: { version: '1.0.2', platform: 'ios' } });
      for (let i = 0; i < 5; i++) t.capture('e');
      await new Promise((r) => setTimeout(r, 0));
      eq(s.sent[0][0].props.version, '1.0.2');
      eq(s.sent[0][0].props.platform, 'ios');
    });

    await testAsync('事件属性可覆盖通用属性', async () => {
      const { t, s } = make({ commonProps: { v: 1 } });
      for (let i = 0; i < 5; i++) t.capture('e', { v: 2 });
      await new Promise((r) => setTimeout(r, 0));
      eq(s.sent[0][0].props.v, 2, '事件属性优先级更高');
    });

    await testAsync('⚠️ 发送失败会放回队首重试', async () => {
      const { t, s } = make();
      s.failOnce();
      for (let i = 0; i < 5; i++) t.capture('e', { i });
      await new Promise((r) => setTimeout(r, 0));

      eq(s.sent.length, 0, '这次失败了');
      eq(t.buffered, 5, '事件应被放回缓冲区，而不是丢弃');

      await t.flush();
      eq(s.sent.length, 1, '重试应成功');
      eq(s.sent[0][0].props.i, 0, '顺序应保持（队首仍是 i=0）');
    });

    await testAsync('⚠️ 重试次数用尽后丢弃（防止无限累积）', async () => {
      /**
       * 【修正过的测试用例】
       *
       * 原写法先 capture 5 条（batchSize=5）→ 触发自动 flush →
       * 事件在**没有 failOnce 的情况下**就发送成功了。
       * 于是后面 5 次 flush 面对的都是空缓冲，全部立即返回 true，
       * 一次失败都没发生，`failed` 自然是 0。
       *
       * 要真正测到"重试用尽"，必须让捕获阶段**不**自动发送：
       * 把 batchSize 调大，手动 flush 来驱动每一轮失败。
       */
      const { t, s } = make({ batchSize: 1000, maxRetries: 2 });
      for (let i = 0; i < 5; i++) t.capture('e');
      eq(t.buffered, 5, '未达 batchSize，应还留在缓冲里');

      /**
       * 失败次数 = maxRetries + 1：
       * 前 maxRetries 次会放回队首，第 maxRetries+1 次才真的丢弃。
       * 之后缓冲已空，flush 直接返回 true。
       */
      let failures = 0;
      for (let round = 0; round < 10; round++) {
        if (t.buffered === 0) break;
        s.failOnce();
        if (!(await t.flush())) failures++;
      }
      eq(failures, 3, 'maxRetries=2 → 重试 2 次 + 最终丢弃 1 次 = 3 次失败');
      eq(t.buffered, 0, '超过重试上限后应真的丢弃，而不是无限堆积');
      assert(t.stats.failed > 0, '应记录失败数（丢数据必须可观测）');
    });

    await testAsync('⚠️ 重试期间事件不丢（放回队首且保序）', async () => {
      const { t, s } = make({ batchSize: 1000 });
      t.capture('e', { i: 1 });
      t.capture('e', { i: 2 });
      s.failOnce();
      eq(await t.flush(), false);
      eq(t.buffered, 2, '失败应放回缓冲，而不是丢弃');

      // 新事件追加到队尾，重试时整体保序
      t.capture('e', { i: 3 });
      await t.flush();
      eq(s.sent.length, 1);
      eq(s.sent[0].map((e) => e.props.i).join(','), '1,2,3', '顺序应保持');
    });

    test('⚠️ 缓冲区满时丢弃最旧的', () => {
      const { t } = make({ batchSize: 1000, maxBuffer: 3 });
      t.capture('e', { i: 0 });
      t.capture('e', { i: 1 });
      t.capture('e', { i: 2 });
      t.capture('e', { i: 3 });   // 超出
      eq(t.buffered, 3);
      eq(t.stats.dropped, 1);
    });

    test('⚠️ 采样在同一会话内是确定性的', () => {
      /**
       * 【这是本模块最重要的一条】
       *
       * 朴素的 `Math.random() < 0.1` 会导致
       * "关卡开始"上报了、"关卡结束"没上报，
       * 数据里出现大量有始无终的关卡。
       *
       * 用 sessionId 哈希决策，同一会话内结果恒定。
       */
      const { t } = make({ sampleRate: 0.5, sessionId: 'fixed-session' });
      const first = t.willSample('level_start');
      for (let i = 0; i < 50; i++) {
        eq(t.willSample('level_start'), first, '同一会话内采样决策必须一致');
      }
    });

    test('不同会话的采样结果不同（采样确实生效）', () => {
      const yes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const t = new Telemetry({ sampleRate: 0.5, sessionId: `s${i}` });
        if (t.willSample('e')) yes.add(`s${i}`);
      }
      assert(yes.size > 20 && yes.size < 80, `采样率应接近 50%，实际 ${yes.size}%`);
    });

    test('按事件名覆盖采样率', () => {
      const { t } = make({ sampleRate: 1, eventSampleRates: { spam: 0 } });
      eq(t.willSample('important'), true, '关键事件全采');
      eq(t.willSample('spam'), false, '高频事件全丢');
    });

    test('⚠️ 禁用后 capture 返回 false 且不入队', () => {
      const { t } = make();
      t.enabled = false;
      eq(t.capture('e'), false);
      eq(t.buffered, 0);
    });

    test('空事件名抛错', () => {
      const { t } = make();
      throws(() => t.capture(''), '不能为空');
    });

    await testAsync('没有 sender 时 flush 清空缓冲（不无限堆积）', async () => {
      const t = new Telemetry();
      t.capture('e');
      eq(t.buffered, 1);
      await t.flush();
      eq(t.buffered, 0);
    });

    await testAsync('flush 空缓冲返回 true 且不调用 sender', async () => {
      const { t, s } = make();
      eq(await t.flush(), true);
      eq(s.sent.length, 0);
    });

    await testAsync('⚠️ 并发 flush 不重复发送', async () => {
      const { t, s } = make();
      t.capture('e');
      await Promise.all([t.flush(), t.flush(), t.flush()]);
      eq(s.sent.length, 1, '重入保护应生效');
    });

    await testAsync('newSession 重置序号', async () => {
      const { t, s } = make();
      for (let i = 0; i < 5; i++) t.capture('e');
      await new Promise((r) => setTimeout(r, 0));
      eq(s.sent[0][4].seq, 4, '同一会话内 seq 递增');

      t.newSession('next');
      t.capture('e');
      for (let i = 0; i < 4; i++) t.capture('e');
      await new Promise((r) => setTimeout(r, 0));
      eq(s.sent[1][0].seq, 0, '新会话 seq 从 0 开始');
    });

    test('clear 清空缓冲', () => {
      const { t } = make();
      t.capture('e');
      t.clear();
      eq(t.buffered, 0);
    });

    await testAsync('stats 统计', async () => {
      const { t } = make();
      for (let i = 0; i < 5; i++) t.capture('e');
      await new Promise((r) => setTimeout(r, 0));
      eq(t.stats.captured, 5);
      eq(t.stats.sent, 5);
    });

    test('hashString 在 [0,1) 且确定性', () => {
      for (const s of ['a', 'session-1', '', '很长的字符串' + 'x'.repeat(100)]) {
        const h = hashString(s);
        assert(h >= 0 && h < 1, `hashString("${s.slice(0, 10)}") = ${h} 应在 [0,1)`);
        eq(hashString(s), h, '必须确定性');
      }
    });
  });

  // ============================================================
  describe('Rarity · 稀有度', () => {
    // ============================================================

    test('基本：最高/最低稀有度', () => {
      const r = new Rarity(CommonRarity);
      eq(r.highest.id, 'legendary');
      eq(r.lowest.id, 'common');
    });

    test('order 降序排列', () => {
      const r = new Rarity(CommonRarity);
      const orders = r.all.map((d) => d.order);
      eq(orders.join(','), '5,4,3,2,1');
    });

    test('isRarer 比较', () => {
      const r = new Rarity(CommonRarity);
      eq(r.isRarer('epic', 'rare'), true);
      eq(r.isRarer('rare', 'epic'), false);
      eq(r.isRarer('rare', 'rare'), false);
    });

    test('atLeast', () => {
      const r = new Rarity(CommonRarity);
      eq(r.atLeast('legendary', 'epic'), true);
      eq(r.atLeast('rare', 'epic'), false);
      eq(r.atLeast('epic', 'epic'), true, '自身算达标');
    });

    test('compare 用于排序（最稀有的在前）', () => {
      const r = new Rarity(CommonRarity);
      const ids = ['common', 'legendary', 'rare', 'epic'];
      eq([...ids].sort(r.compare.bind(r)).join(','), 'legendary,epic,rare,common');
    });

    test('⚠️ 未知 id 回退到最低稀有度（不崩）', () => {
      /**
       * 存档里有已删除的稀有度时，UI 不该崩。
       * 静默降级比抛错好。
       */
      const r = new Rarity(CommonRarity);
      eq(r.getOrFallback('不存在').id, 'common');
      eq(r.isRarer('不存在', 'common'), false);
      eq(r.atLeast('不存在', 'common'), true);
    });

    test('weight = 基础权重 × 系数', () => {
      const r = new Rarity(CommonRarity);
      eq(r.weight('legendary', 1), 1);
      eq(r.weight('legendary', 2), 2, '可让某些传说更稀有');
      eq(r.weight('common', 1), 200);
    });

    test('weight 系数为 0 时结果为 0', () => {
      const r = new Rarity(CommonRarity);
      eq(r.weight('rare', 0), 0);
    });

    test('roll 分布符合权重', () => {
      const r = new Rarity(CommonRarity);
      const rng = new RNG(42);
      const cnt: Record<string, number> = {};
      for (let i = 0; i < 20000; i++) {
        const d = r.roll(rng);
        cnt[d.id] = (cnt[d.id] ?? 0) + 1;
      }
      assert((cnt.common ?? 0) > (cnt.uncommon ?? 0), 'common 应最多');
      assert((cnt.uncommon ?? 0) > (cnt.rare ?? 0), 'uncommon 应多于 rare');
      assert((cnt.rare ?? 0) > (cnt.epic ?? 0), 'rare 应多于 epic');
      assert((cnt.epic ?? 0) > (cnt.legendary ?? 0), 'epic 应多于 legendary');
    });

    test('rollAmong 只在指定集合里选', () => {
      const r = new Rarity(CommonRarity);
      const rng = new RNG(7);
      for (let i = 0; i < 200; i++) {
        const d = r.rollAmong(['epic', 'legendary'], rng);
        assert(d.id === 'epic' || d.id === 'legendary', `不该选出 ${d.id}`);
      }
    });

    test('rollAmong 空集合返回 fallback', () => {
      const r = new Rarity(CommonRarity);
      eq(r.rollAmong([], new RNG(1)).id, 'common');
    });

    test('⚠️ 构造校验：order 重复', () => {
      throws(
        () => new Rarity([
          { id: 'a', name: 'A', weight: 1, order: 1 },
          { id: 'b', name: 'B', weight: 2, order: 1 },
        ]),
        'order 重复'
      );
    });

    test('⚠️ 构造校验：weight 必须为正', () => {
      throws(
        () => new Rarity([{ id: 'a', name: 'A', weight: 0, order: 1 }]),
        '必须为正'
      );
    });

    test('构造校验：id 重复', () => {
      throws(
        () => new Rarity([
          { id: 'a', name: 'A', weight: 1, order: 2 },
          { id: 'a', name: 'B', weight: 1, order: 1 },
        ]),
        '重复'
      );
    });

    test('空配置抛错', () => {
      throws(() => new Rarity([]), '至少需要');
    });

    test('⚠️ countsForPity 默认 true，显式 false 则排除', () => {
      const r = new Rarity([
        { id: 'high', name: 'H', weight: 1, order: 2 },
        { id: 'low', name: 'L', weight: 10, order: 1, countsForPity: false },
      ]);
      eq(r.countsForPity('high'), true, '未声明时默认计入');
      eq(r.countsForPity('low'), false);
      eq(r.pityEligible().map((d) => d.id).join(','), 'high');
    });

    test('pityEligible 过滤', () => {
      const r = new Rarity(CommonRarity);
      eq(r.pityEligible().length, 5, '默认全部计入');
    });

    test('tally 统计', () => {
      const r = new Rarity(CommonRarity);
      const t = r.tally(['common', 'rare', 'common']);
      eq(t.common, 2);
      eq(t.rare, 1);
      eq(t.legendary, 0, '未出现的也要有键');
    });

    test('⚠️ tally 把未知 id 归入最低档', () => {
      const r = new Rarity(CommonRarity);
      const t = r.tally(['不存在的稀有度']);
      eq(t.common, 1, '未知应计入最低档');
    });

    test('best 取最稀有', () => {
      const r = new Rarity(CommonRarity);
      eq(r.best(['common', 'rare', 'common'])!.id, 'rare');
      eq(r.best([]), null);
    });

    test('allAscending 与 all 相反', () => {
      const r = new Rarity(CommonRarity);
      eq(r.allAscending.map((d) => d.id).join(','), 'common,uncommon,rare,epic,legendary');
    });

    test('预设 SimpleRarity 可用', () => {
      const r = new Rarity(SimpleRarity);
      eq(r.highest.id, 'rare');
      eq(r.lowest.id, 'junk');
    });
  });

  // ============================================================
  describe('Stats · 统计追踪', () => {
    // ============================================================

    function make() {
      return new Stats({
        defs: [
          { id: 'kills', agg: 'sum', persist: true },
          { id: 'playtime', agg: 'sum', persist: true },
          { id: 'maxCombo', agg: 'max' },
          { id: 'bestTime', agg: 'min' },
          { id: 'lastWeapon', agg: 'last' },
          { id: 'deaths', agg: 'count' },
          { id: 'killsByWeapon', agg: 'sum', tags: ['weapon', 'floor'] },
        ],
        derived: {
          kph: (g) => g('kills') / Math.max(1, g('playtime') / 3600_000),
        },
      });
    }

    test('sum 聚合', () => {
      const s = make();
      s.add('kills', 5);
      s.add('kills', 3);
      eq(s.get('kills'), 8);
    });

    test('count 聚合忽略传入值', () => {
      const s = make();
      s.record('deaths', 1);
      s.record('deaths', 999);
      eq(s.get('deaths'), 2, 'count 只数次数');
    });

    test('⚠️ max 聚合保留最大值', () => {
      const s = make();
      s.record('maxCombo', 12);
      s.record('maxCombo', 7);
      s.record('maxCombo', 20);
      eq(s.get('maxCombo'), 20);
    });

    test('min 聚合保留最小值', () => {
      const s = make();
      s.record('bestTime', 300);
      s.record('bestTime', 180);
      s.record('bestTime', 240);
      eq(s.get('bestTime'), 180);
    });

    test('last 聚合', () => {
      const s = make();
      s.record('lastWeapon', 1);
      s.record('lastWeapon', 7);
      eq(s.get('lastWeapon'), 7);
    });

    test('⚠️ 带标签分组统计', () => {
      const s = make();
      s.record('killsByWeapon', 1, { weapon: 'sword' });
      s.record('killsByWeapon', 2, { weapon: 'sword' });
      s.record('killsByWeapon', 4, { weapon: 'bow' });
      eq(s.get('killsByWeapon', { weapon: 'sword' }), 3);
      eq(s.get('killsByWeapon', { weapon: 'bow' }), 4);
    });

    test('⚠️ 标签顺序不影响 key（必须排序）', () => {
      /**
       * `{weapon:'sword',floor:'3'}` 和 `{floor:'3',weapon:'sword'}`
       * 是同一组合。不排序会存成两条，统计结果翻倍。
       */
      const s = make();
      s.record('killsByWeapon', 10, { weapon: 'sword', floor: '3' });
      s.record('killsByWeapon', 1, { floor: '3', weapon: 'sword' });
      eq(s.get('killsByWeapon', { weapon: 'sword', floor: '3' }), 11);
    });

    test('makeKey 排序标签', () => {
      eq(makeKey('x', { b: '2', a: '1' }), 'x|a=1,b=2');
      eq(makeKey('x', {}), 'x|');
    });

    test('⚠️ 未声明的标签被拒绝', () => {
      const s = make();
      throws(() => s.record('kills', 1, { weapon: 'sword' }), '不支持标签');
    });

    test('⚠️ 给无标签指标传空标签是允许的', () => {
      const s = make();
      s.record('kills', 1, {});
      eq(s.get('kills'), 1);
    });

    test('⚠️ 未定义指标抛错（防拼写）', () => {
      const s = make();
      throws(() => s.record('kill', 1), '未定义的指标');
    });

    test('tryGet 不抛错', () => {
      const s = make();
      eq(s.tryGet('不存在'), 0);
    });

    test('派生指标', () => {
      const s = make();
      s.add('kills', 100);
      s.add('playtime', 3600_000);   // 1 小时
      near(s.derived('kph'), 100, 1e-9);
      eq(s.derivedIds.join(','), 'kph');
    });

    test('派生指标通过 get 也能访问', () => {
      const s = make();
      s.add('kills', 50);
      s.add('playtime', 3600_000);
      near(s.get('kph'), 50, 1e-9);
    });

    test('⚠️ 未定义的派生指标抛错', () => {
      const s = make();
      throws(() => s.derived('nope'), '未定义的派生指标');
    });

    test('byTag 汇总', () => {
      const s = make();
      s.record('killsByWeapon', 1, { weapon: 'sword' });
      s.record('killsByWeapon', 2, { weapon: 'sword' });
      s.record('killsByWeapon', 4, { weapon: 'bow' });
      const by = s.byTag('killsByWeapon', 'weapon');
      eq(by.sword, 3);
      eq(by.bow, 4);
    });

    test('byTag 未定义指标抛错', () => {
      const s = make();
      throws(() => s.byTag('nope', 'x'), '未定义的指标');
    });

    test('tagCombos 列出所有组合', () => {
      const s = make();
      s.record('killsByWeapon', 1, { weapon: 'sword' });
      s.record('killsByWeapon', 2, { weapon: 'bow' });
      eq(s.tagCombos('killsByWeapon').length, 2);
    });

    test('tagCombos 包含无标签的指标', () => {
      const s = make();
      s.add('kills', 5);
      const combos = s.tagCombos('kills');
      eq(combos.length, 1);
      eq(Object.keys(combos[0]).length, 0, '无标签时是空对象');
    });

    test('⚠️ resetSession 只清非 persist 的', () => {
      const s = make();
      s.add('kills', 8);          // persist: true
      s.record('maxCombo', 20);   // 未标 persist
      s.resetSession();
      eq(s.get('kills'), 8, 'persist 的应保留');
      eq(s.get('maxCombo'), -Infinity, '非 persist 的应被清掉');
    });

    test('⚠️ display() 把 ±Infinity 转成 0（UI 安全）', () => {
      /**
       * max 聚合在没有任何记录时返回 -Infinity（正确的单位元），
       * 但直接渲染会显示 "-∞"。
       * 所以 get() 保持数学正确，display() 负责展示友好。
       */
      const s = make();
      eq(s.get('maxCombo'), -Infinity, 'get 保持数学正确');
      eq(s.display('maxCombo'), 0, 'display 转成人能看的');
      eq(s.get('bestTime'), Infinity);
      eq(s.display('bestTime'), 0);
    });

    test('reset 单个指标（含所有标签）', () => {
      const s = make();
      s.record('killsByWeapon', 1, { weapon: 'sword' });
      s.record('killsByWeapon', 1, { weapon: 'bow' });
      s.reset('killsByWeapon');
      eq(s.get('killsByWeapon', { weapon: 'sword' }), 0);
      eq(s.get('killsByWeapon', { weapon: 'bow' }), 0);
    });

    test('resetAll', () => {
      const s = make();
      s.add('kills', 5);
      s.resetAll();
      eq(s.get('kills'), 0);
    });

    test('存档往返：只导出 persist 的', () => {
      const s = make();
      s.add('kills', 8);
      s.record('maxCombo', 20);
      const state = s.exportState();
      eq(state['kills|'], 8);
      eq('maxCombo|' in state, false, '非 persist 不该进存档');
    });

    test('⚠️ 存档跳过非有限值（Infinity 会被 JSON 变成 null）', () => {
      const s = make();
      s.record('bestTime', 300);
      s.exportState();   // bestTime 非 persist，本来就不导出
      // 换个 persist 的 min 聚合验证
      const s2 = new Stats({
        defs: [{ id: 'bt', agg: 'min', persist: true }],
      });
      const state = s2.exportState();
      eq(Object.keys(state).length, 0, '未记录时是 Infinity，不应写入存档');
    });

    test('⚠️ 导入未知 id 静默跳过（旧存档兼容）', () => {
      const s = make();
      s.importState({ 'kills|': 5, '已删除的指标|': 999 });
      eq(s.get('kills'), 5);
    });

    test('导入非有限值被跳过', () => {
      const s = make();
      s.importState({ 'kills|': Infinity });
      eq(s.get('kills'), 0);
    });

    test('snapshot 含派生指标', () => {
      const s = make();
      s.add('kills', 10);
      s.add('playtime', 3600_000);
      const snap = s.snapshot();
      eq(snap.kills, 10);
      eq(snap.kph, 10);
    });

    test('describe 不出现 Infinity', () => {
      const s = make();
      s.add('kills', 3);
      const d = s.describe();
      assert(!d.includes('Infinity'), `describe 应可展示，实际含 Infinity：\n${d}`);
    });

    test('构造校验：id 重复', () => {
      throws(
        () => new Stats({ defs: [{ id: 'a', agg: 'sum' }, { id: 'a', agg: 'sum' }] }),
        '重复'
      );
    });

    test('构造校验：未知聚合方式', () => {
      throws(() => new Stats({ defs: [{ id: 'a', agg: 'avg' as never }] }), '未知的聚合方式');
    });

    test('has 查询', () => {
      const s = make();
      eq(s.has('kills'), false);
      s.add('kills', 1);
      eq(s.has('kills'), true);
    });

    test('onChange 回调', () => {
      const seen: string[] = [];
      const s = new Stats({
        defs: [{ id: 'k', agg: 'sum' }],
        onChange: (id, v) => seen.push(`${id}=${v}`),
      });
      s.add('k', 1);
      s.add('k', 2);
      eq(seen.join(','), 'k=1,k=3');
    });
  });

  // ============================================================
  describe('Achievement · 成就', () => {
    // ============================================================

    function make() {
      return new Achievement({
        defs: [
          { id: 'kill100', name: '百人斩', target: 100, progress: (c) => c.get('kills') },
          { id: 'kill2000', name: '千人斩', target: 2000, progress: (c) => c.get('kills') },
          {
            id: 'boss',
            name: '击败 Boss',
            isDone: (c) => c.get('bossKilled') > 0,
          },
          {
            id: 'secret',
            name: '隐藏成就',
            hidden: true,
            requires: ['kill100'],
            progress: (c) => c.get('secrets'),
            target: 3,
          },
        ],
      });
    }

    /** 构造上下文 */
    function ctxOf(vals: Record<string, number>) {
      return { get: (k: string) => vals[k] ?? 0 };
    }

    test('基本：达成即解锁', () => {
      const a = make();
      const newly = a.check(ctxOf({ kills: 150 }));
      eq(newly.map((d) => d.id).join(','), 'kill100');
      eq(a.isUnlocked('kill100'), true);
    });

    test('⚠️ 已解锁的不重复触发（最常见的 bug）', () => {
      const a = make();
      a.check(ctxOf({ kills: 150 }));
      const again = a.check(ctxOf({ kills: 150 }));
      eq(again.length, 0, '不该重复解锁');
      const third = a.check(ctxOf({ kills: 9999 }));
      eq(third.map((d) => d.id).join(','), 'kill2000', '只应有新的');
    });

    test('onUnlock 只调用一次', () => {
      const seen: string[] = [];
      const a = new Achievement({
        defs: [{ id: 'x', name: 'X', target: 10, progress: (c) => c.get('v') }],
        onUnlock: (d) => seen.push(d.id),
      });
      a.check(ctxOf({ v: 10 }));
      a.check(ctxOf({ v: 20 }));
      a.check(ctxOf({ v: 30 }));
      eq(seen.length, 1, '解锁回调只应触发一次');
    });

    test('isDone 覆盖默认判定', () => {
      const a = make();
      const newly = a.check(ctxOf({ bossKilled: 1 }));
      assert(newly.some((d) => d.id === 'boss'), 'boss 应解锁');
      eq(a.progressOf('boss', ctxOf({})).target, 1, '未设 target 时默认 1');
    });

    test('⚠️ 前置未完成时本体不解锁', () => {
      const a = make();
      a.check(ctxOf({ secrets: 3 }));   // secret 需要 kill100
      eq(a.isUnlocked('secret'), false, '前置未达成不该解锁');
      eq(a.requirementsMet('secret'), false);
    });

    test('前置完成后本体可解锁', () => {
      const a = make();
      a.check(ctxOf({ kills: 150, secrets: 3 }));
      eq(a.isUnlocked('kill100'), true);
      eq(a.isUnlocked('secret'), true);
    });

    test('⚠️ 同一批 check 中前置与本体同时达成', () => {
      /**
       * 顺序依赖：如果遍历时 kill100 排在 secret 之后，
       * 这一轮 secret 就检查不到，要等下一轮。
       * 实现里 defs 是按声明顺序遍历的，kill100 在前，所以能过。
       */
      const a = make();
      const newly = a.check(ctxOf({ kills: 150, secrets: 3 }));
      eq(newly.map((d) => d.id).sort().join(','), 'kill100,secret');
    });

    test('⚠️ 循环前置在构造时报错', () => {
      throws(
        () => new Achievement({
          defs: [
            { id: 'a', name: 'A', requires: ['b'] },
            { id: 'b', name: 'B', requires: ['a'] },
          ],
        }),
        '循环'
      );
    });

    test('⚠️ 前置指向不存在的成就时报错', () => {
      throws(
        () => new Achievement({
          defs: [{ id: 'a', name: 'A', requires: ['不存在'] }],
        }),
        '不存在'
      );
    });

    test('构造校验：id 重复', () => {
      throws(
        () => new Achievement({
          defs: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }],
        }),
        '重复'
      );
    });

    test('进度查询（不触发解锁）', () => {
      const a = make();
      const p = a.progressOf('kill2000', ctxOf({ kills: 1000 }));
      eq(p.current, 1000);
      eq(p.target, 2000);
      eq(p.done, false);
      eq(p.locked, false);
    });

    test('进度被夹到不超过目标', () => {
      const a = make();
      const p = a.progressOf('kill100', ctxOf({ kills: 99999 }));
      eq(p.current, 100, '展示时不该超过目标');
    });

    test('⚠️ 负进度被夹到 0', () => {
      const a = make();
      const p = a.progressOf('kill100', ctxOf({ kills: -5 }));
      eq(p.current, 0);
    });

    test('⚠️ NaN 进度被夹到 0', () => {
      let bad = NaN;
      const a = new Achievement({
        defs: [{ id: 'x', name: 'X', target: 10, progress: () => bad }],
      });
      eq(a.progressOf('x', ctxOf({})).current, 0, 'NaN 不应污染进度');
    });

    test('locked 反映前置状态', () => {
      const a = make();
      eq(a.progressOf('secret', ctxOf({})).locked, true);
      a.check(ctxOf({ kills: 150 }));
      eq(a.progressOf('secret', ctxOf({})).locked, false);
    });

    test('checkOne 只检查指定成就', () => {
      const a = make();
      a.checkOne('kill100', ctxOf({ kills: 150 }));
      eq(a.isUnlocked('kill100'), true);
      eq(a.isUnlocked('kill2000'), false, '不该顺带检查其他');
    });

    test('checkOne 对已解锁的返回 false', () => {
      const a = make();
      a.checkOne('kill100', ctxOf({ kills: 150 }));
      eq(a.checkOne('kill100', ctxOf({ kills: 150 })), false);
    });

    test('checkOne 不存在的成就返回 false 不抛错', () => {
      const a = make();
      eq(a.checkOne('nope', ctxOf({})), false);
    });

    test('手动 unlock', () => {
      const a = make();
      eq(a.unlock('kill100'), true);
      eq(a.unlock('kill100'), false, '重复解锁返回 false');
    });

    test('unlock 不存在的成就抛错', () => {
      const a = make();
      throws(() => a.unlock('nope'), '未定义');
    });

    test('revoke（调试用）', () => {
      const a = make();
      a.unlock('kill100');
      eq(a.revoke('kill100'), true);
      eq(a.isUnlocked('kill100'), false);
    });

    test('reset 清空', () => {
      const a = make();
      a.check(ctxOf({ kills: 9999 }));
      eq(a.unlockedCount, 2);
      a.reset();
      eq(a.unlockedCount, 0);
    });

    test('存档往返', () => {
      const a = make();
      a.unlock('kill100');
      const state = a.exportState();
      const b = make();
      b.importState(state);
      eq(b.isUnlocked('kill100'), true);
      eq(b.unlockedCount, 1);
    });

    test('⚠️ 导入未知 id 静默跳过', () => {
      const a = make();
      a.importState(['kill100', '已删除的成就']);
      eq(a.unlockedCount, 1);
    });

    test('点数统计', () => {
      const a = new Achievement({
        defs: [
          { id: 'a', name: 'A', points: 10, isDone: () => true },
          { id: 'b', name: 'B', points: 20, isDone: () => false },
        ],
      });
      a.check(ctxOf({}));
      eq(a.points, 10);
      eq(a.totalPoints, 30);
    });

    test('完成度', () => {
      const a = make();
      eq(a.completion, 0);
      a.unlock('kill100');
      near(a.completion, 0.25, 1e-9, '4 个成就解锁 1 个');
    });

    test('空成就表完成度为 0（不除零）', () => {
      const a = new Achievement({ defs: [] });
      eq(a.completion, 0);
    });

    test('onProgress 在进度变化时触发', () => {
      const seen: Array<[string, number, number]> = [];
      const a = new Achievement({
        defs: [{ id: 'x', name: 'X', target: 100, progress: (c) => c.get('v') }],
        onProgress: (d, cur, tgt) => seen.push([d.id, cur, tgt]),
      });
      a.check(ctxOf({ v: 10 }));
      a.check(ctxOf({ v: 10 }));   // 没变化
      a.check(ctxOf({ v: 20 }));
      eq(seen.length, 2, '相同进度不该重复通知');
      eq(seen[1][1], 20);
      eq(seen[1][2], 100);
    });

    test('visible 返回全部（含隐藏的占位）', () => {
      const a = make();
      eq(a.visible().length, 4, '隐藏成就也占位，否则玩家能从总数察觉');
    });

    test('def 查询', () => {
      const a = make();
      eq(a.def('kill100')?.name, '百人斩');
      eq(a.def('nope'), undefined);
    });
  });

  // ============================================================
  describe('Gesture · 手势识别', () => {
    // ============================================================

    /** 生成一条直线轨迹 */
    function line(x0: number, y0: number, x1: number, y1: number, n = 5, dt = 20): Point[] {
      return Array.from({ length: n }, (_, i) => ({
        x: x0 + ((x1 - x0) * i) / (n - 1),
        y: y0 + ((y1 - y0) * i) / (n - 1),
        t: i * dt,
      }));
    }

    function circle(r = 50, n = 24, dt = 16): Point[] {
      return Array.from({ length: n }, (_, i) => ({
        x: 100 + r * Math.cos((i / (n - 1)) * Math.PI * 2),
        y: 100 + r * Math.sin((i / (n - 1)) * Math.PI * 2),
        t: i * dt,
      }));
    }

    test('快速左滑 → swipe left', () => {
      const g = recognize(line(200, 100, 50, 100));
      eq(g.kind, 'swipe');
      eq(g.dir, 'left');
    });

    test('快速右滑 → swipe right', () => {
      eq(recognize(line(50, 100, 200, 100)).dir, 'right');
    });

    test('⚠️ 屏幕坐标下 Y 向下：y 减小是上滑', () => {
      const g = recognize(line(100, 200, 100, 50));
      eq(g.dir, 'up', '默认 yDown=true，y 减小 = 上');
    });

    test('⚠️ yDown=false 时方向反转（世界坐标）', () => {
      const g = recognize(line(100, 200, 100, 50), { yDown: false });
      eq(g.dir, 'down', 'Y 向上时，y 减小是下');
    });

    test('慢速移动 → drag（不是 swipe）', () => {
      const g = recognize(line(200, 100, 50, 100, 5, 200));
      eq(g.kind, 'drag', '速度不够应判为拖拽');
    });

    test('位移不足 → tap', () => {
      const g = recognize([{ x: 100, y: 100, t: 0 }, { x: 101, y: 100, t: 100 }]);
      eq(g.kind, 'tap');
    });

    test('按住不动超时 → longPress', () => {
      const g = recognize([{ x: 100, y: 100, t: 0 }, { x: 101, y: 100, t: 800 }]);
      eq(g.kind, 'longPress');
    });

    test('⚠️ 画圈 → circle（不能被"没动"分支吃掉）', () => {
      /**
       * 【修过的 bug】
       * 圆圈首尾重合 → 直线距离 ≈ 0 → 先命中「基本没动」分支，
       * 直接返回 longPress，走不到画圈判定。
       *
       * 修法：画圈提到最前面，并用路径总长而不是首尾距离判"够不够大"。
       */
      const g = recognize(circle());
      eq(g.kind, 'circle');
      assert(Math.abs(g.turns ?? 0) > 5, `应约一圈（2π≈6.28），实际 ${g.turns}`);
    });

    test('半圈不算圈', () => {
      const pts = circle(50, 24).slice(0, 12);   // 只有半圈
      const g = recognize(pts);
      assert(g.kind !== 'circle', `半圈不该判为圈，实际 ${g.kind}`);
    });

    test('⚠️ 来回抖动不累积成圈（转角带符号）', () => {
      /**
       * 不区分方向地累加角度的话，来回抖动会累加出很大的值。
       * 带符号累加后正负抵消。
       */
      const jitter: Point[] = [];
      for (let i = 0; i < 20; i++) {
        jitter.push({ x: 100 + (i % 2 === 0 ? 3 : -3), y: 100, t: i * 16 });
      }
      assert(Math.abs(totalTurn(jitter)) < 5, '抖动的累计转角应很小');
    });

    test('空轨迹 → none', () => {
      eq(recognize([]).kind, 'none');
    });

    test('单点 → tap 或 longPress（不崩）', () => {
      const g = recognize([{ x: 0, y: 0, t: 0 }]);
      assert(g.kind === 'tap' || g.kind === 'longPress', `实际 ${g.kind}`);
    });

    test('dirOf 边界：正好 45 度', () => {
      eq(dirOf(1, 1), 'right', 'dx 绝对值相等时归为水平');
      /**
       * 【修正过的断言】
       * yDown=true（屏幕坐标）时 y **增大**是向下。
       * 原测试期望 dirOf(0, 1) === 'up'，
       * 但这与同文件里「y 减小是上滑」那条断言直接矛盾。
       */
      eq(dirOf(0, 1), 'down', 'yDown 时 y 增大 = 下');
      eq(dirOf(0, -1), 'up', 'yDown 时 y 减小 = 上');
      eq(dirOf(-1, 0), 'left');
    });

    test('pathLength', () => {
      eq(pathLength([{ x: 0, y: 0, t: 0 }, { x: 3, y: 4, t: 1 }]), 5);
      eq(pathLength([{ x: 0, y: 0, t: 0 }]), 0);
      eq(pathLength([]), 0);
    });

    test('totalTurn 少于 3 点为 0', () => {
      eq(totalTurn([{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 1 }]), 0);
    });

    test('boundsOf', () => {
      const b = boundsOf([{ x: 0, y: 0, t: 0 }, { x: 10, y: 5, t: 1 }]);
      eq(b.width, 10);
      eq(b.height, 5);
    });

    test('boundsOf 空输入', () => {
      const b = boundsOf([]);
      eq(b.width, 0);
      eq(b.height, 0);
    });

    test('双指张开 → pinch', () => {
      const g = recognizePinch(
        { x: 90, y: 100, t: 0 }, { x: 110, y: 100, t: 0 },
        { x: 50, y: 100, t: 200 }, { x: 150, y: 100, t: 200 }
      );
      eq(g.kind, 'pinch');
      assert((g.scale ?? 0) > 1, '张开 scale > 1');
      near(g.scale ?? 0, 5, 1e-9, '20 → 100');
    });

    test('双指捏合 → pinch', () => {
      const g = recognizePinch(
        { x: 50, y: 100, t: 0 }, { x: 150, y: 100, t: 0 },
        { x: 90, y: 100, t: 200 }, { x: 110, y: 100, t: 200 }
      );
      eq(g.kind, 'pinch');
      assert((g.scale ?? 1) < 1, '捏合 scale < 1');
    });

    test('⚠️ 缩放幅度不足 → none', () => {
      const g = recognizePinch(
        { x: 90, y: 100, t: 0 }, { x: 110, y: 100, t: 0 },
        { x: 88, y: 100, t: 200 }, { x: 112, y: 100, t: 200 }
      );
      eq(g.kind, 'none', '变化太小不该算缩放');
    });

    test('⚠️ 起始距离为 0 时不除零', () => {
      const g = recognizePinch(
        { x: 100, y: 100, t: 0 }, { x: 100, y: 100, t: 0 },
        { x: 50, y: 100, t: 200 }, { x: 150, y: 100, t: 200 }
      );
      eq(g.scale, 1, 'd0=0 时应退化为 1，而不是 Infinity');
      assert(Number.isFinite(g.scale ?? NaN));
    });

    // ---------- 异常时间戳（批次 5 遗漏项） ----------
    //
    // 【为什么补这组】
    // 原实现 `const dt = Math.max(1, last.t - first.t)` 挡得住 0 和负数，
    // 挡不住 NaN：Math.max(1, NaN) === NaN → speed = path / NaN = NaN。
    //
    // NaN 的可怕之处不在值本身，而在**所有比较恒为 false**：
    //   `speed >= o.swipeSpeed`  → false
    //   `speed <  o.swipeSpeed`  → false
    // 于是"是 swipe"和"不是 swipe"两个分支同时落空，
    // 手势识别静默失效——不报错，只是永远识别不出东西。
    //
    // 时间戳反了（last.t < first.t）是另一种伪装：
    // rawDt 为负 → 被 Math.max 兜到 1 → speed 放大上百倍，
    // "轻轻一划"被判成"快速滑动"。这是**数据错误伪装成正常输入**，
    // 比直接失效更难发现。
    test('⚠️ 时间戳为 NaN 时 speed 不是 NaN（识别不会静默失效）', () => {
      const g = recognize([
        { x: 0, y: 0, t: NaN },
        { x: 100, y: 0, t: NaN + 50 },
        { x: 300, y: 0, t: 100 },
      ]);
      assert(
        Number.isFinite(g.speed),
        `speed 应为有限值，实际 ${g.speed}（NaN 会让所有速度比较恒 false）`
      );
      eq(g.speed, 0, 'dt 不可信时 speed 记 0，表示"速度未知"');
    });

    test('⚠️ 时间戳为 Infinity 时 speed 有限', () => {
      const g = recognize([
        { x: 0, y: 0, t: 0 },
        { x: 150, y: 0, t: Infinity },
        { x: 300, y: 0, t: Infinity },
      ]);
      assert(Number.isFinite(g.speed), `speed 应有限，实际 ${g.speed}`);
      eq(g.speed, 0, 'dt 非有限时 speed 记 0');
    });

    test('⚠️ 时间戳反了时 speed 不虚高（数据错误不伪装成快速滑动）', () => {
      // 300px 的位移，时间戳却是倒着走的
      const g = recognize([
        { x: 0, y: 0, t: 100 },
        { x: 150, y: 0, t: 50 },
        { x: 300, y: 0, t: 0 },
      ]);
      // 修复前：dt 被 Math.max 兜到 1 → speed = 300/1 = 300（虚高 100 倍）
      // 修复后：dt 不可信 → speed = 0
      eq(g.speed, 0, '时间戳倒流时 dt 不可信，speed 记 0 而不是放大上百倍');
      assert(g.kind !== 'swipe', `时间戳倒流不应判成 swipe，实际 ${g.kind}`);
    });

    test('⚠️ 时间戳全相同时不误判为 swipe', () => {
      const g = recognize([
        { x: 0, y: 0, t: 50 },
        { x: 150, y: 0, t: 50 },
        { x: 300, y: 0, t: 50 },
      ]);
      eq(g.speed, 0, 'dt 为 0 时 speed 记 0');
      assert(g.kind !== 'swipe', `dt 为 0 不应判成 swipe，实际 ${g.kind}`);
    });

    test('正常时间戳不受影响（防止矫枉过正）', () => {
      // 300px / 100ms = 3 px/ms，明显是 swipe
      const g = recognize([
        { x: 0, y: 0, t: 0 },
        { x: 150, y: 0, t: 50 },
        { x: 300, y: 0, t: 100 },
      ]);
      eq(g.kind, 'swipe', '正常快速直线滑动仍应识别为 swipe');
      eq(g.speed, 3, 'speed 应正常计算（300px / 100ms）');
    });

    // ---------- GestureRecognizer ----------

    test('识别器完整流程', () => {
      const rec = new GestureRecognizer();
      rec.down({ x: 200, y: 100, t: 0 });
      rec.move({ x: 150, y: 100, t: 20 });
      rec.move({ x: 100, y: 100, t: 40 });
      const g = rec.up({ x: 50, y: 100, t: 60 });
      eq(g.kind, 'swipe');
      eq(g.dir, 'left');
    });

    test('⚠️ up 之后轨迹清空，可重新开始', () => {
      const rec = new GestureRecognizer();
      rec.down({ x: 200, y: 100, t: 0 });
      rec.up({ x: 50, y: 100, t: 60 });
      eq(rec.active, false);
      eq(rec.pointCount, 0);

      rec.down({ x: 100, y: 100, t: 100 });
      rec.up({ x: 105, y: 100, t: 200 });
      eq(rec.active, false);
    });

    test('未 down 就 move 被忽略', () => {
      const rec = new GestureRecognizer();
      rec.move({ x: 100, y: 100, t: 0 });
      eq(rec.pointCount, 0);
    });

    test('未 down 就 up 返回 none', () => {
      const rec = new GestureRecognizer();
      eq(rec.up({ x: 0, y: 0, t: 0 }).kind, 'none');
    });

    test('cancel 作废轨迹', () => {
      const rec = new GestureRecognizer();
      rec.down({ x: 0, y: 0, t: 0 });
      rec.cancel();
      eq(rec.active, false);
      eq(rec.pointCount, 0);
    });

    test('⚠️ 相邻过近的点被去抖', () => {
      const rec = new GestureRecognizer();
      rec.down({ x: 100, y: 100, t: 0 });
      rec.move({ x: 100.2, y: 100, t: 5 });   // 位移 < 1 且时间 < 16ms
      eq(rec.pointCount, 1, '过近的点不该记录');
    });

    test('采样上限', () => {
      const rec = new GestureRecognizer({ maxPoints: 5 });
      rec.down({ x: 0, y: 0, t: 0 });
      for (let i = 1; i < 20; i++) rec.move({ x: i * 10, y: 0, t: i * 20 });
      assert(rec.pointCount <= 5, `应受 maxPoints 限制，实际 ${rec.pointCount}`);
    });

    test('isLongPressSoFar', () => {
      const rec = new GestureRecognizer({ longPressMs: 500 });
      rec.down({ x: 100, y: 100, t: 0 });
      eq(rec.isLongPressSoFar(100), false);
      eq(rec.isLongPressSoFar(600), true, '时间到且没怎么动');
      rec.move({ x: 200, y: 100, t: 700 });
      eq(rec.isLongPressSoFar(800), false, '移动后就不是长按了');
    });

    test('静止超时自动结束', () => {
      const rec = new GestureRecognizer({ idleTimeoutMs: 1000 });
      rec.down({ x: 0, y: 0, t: 0 });
      rec.move({ x: 100, y: 0, t: 100 });
      rec.move({ x: 200, y: 0, t: 5000 });   // 间隔 4.9 秒
      eq(rec.active, false, '静止超时应自动结束');
    });

    // ---------- DoubleTapDetector ----------

    test('双击检测', () => {
      const d = new DoubleTapDetector();
      eq(d.tap({ x: 100, y: 100, t: 0 }), false, '第一次');
      eq(d.tap({ x: 101, y: 100, t: 150 }), true, '第二次在阈值内');
    });

    test('⚠️ 间隔太久不算双击', () => {
      const d = new DoubleTapDetector();
      d.tap({ x: 100, y: 100, t: 0 });
      eq(d.tap({ x: 100, y: 100, t: 999 }), false);
    });

    test('⚠️ 位置差太远不算双击', () => {
      const d = new DoubleTapDetector();
      d.tap({ x: 100, y: 100, t: 0 });
      eq(d.tap({ x: 200, y: 200, t: 100 }), false);
    });

    test('⚠️ 三连击只算一次双击（消费掉）', () => {
      const d = new DoubleTapDetector();
      d.tap({ x: 100, y: 100, t: 0 });
      eq(d.tap({ x: 100, y: 100, t: 50 }), true);
      eq(d.tap({ x: 100, y: 100, t: 100 }), false, '第三次应重新开始计');
    });

    test('reset', () => {
      const d = new DoubleTapDetector();
      d.tap({ x: 0, y: 0, t: 0 });
      d.reset();
      eq(d.tap({ x: 0, y: 0, t: 10 }), false, '重置后第一次不算双击');
    });
  });

  // ============================================================
  describe('Rebind · 按键重映射', () => {
    // ============================================================

    test('基本：绑定与查询', () => {
      const rb = new Rebind({ jump: { key: 'space' }, attack: { key: 'j' } });
      eq(rb.bindingOf('jump')!.key, 'space');
      eq(rb.actionOf({ key: 'j' }), 'attack');
    });

    test('⚠️ 编码时修饰键必须排序', () => {
      /**
       * `ctrl+shift+s` 和 `shift+ctrl+s` 是同一组合。
       * 不排序会存成两条，且互相检测不到冲突。
       */
      eq(encodeBinding({ key: 's', mods: ['shift', 'ctrl'] }), 'ctrl+shift+s');
      eq(encodeBinding({ key: 's', mods: ['ctrl', 'shift'] }), 'ctrl+shift+s');
    });

    test('编码去重重复的修饰键', () => {
      eq(encodeBinding({ key: 's', mods: ['ctrl', 'ctrl'] }), 'ctrl+s');
    });

    test('大小写不敏感', () => {
      eq(encodeBinding({ key: 'S' }), 's');
    });

    test('解码往返', () => {
      const b = decodeBinding('ctrl+shift+s');
      eq(b.key, 's');
      eq((b.mods ?? []).join(','), 'ctrl,shift');
    });

    test('⚠️ 修饰键不能当主键', () => {
      throws(() => decodeBinding('ctrl+shift'), '不能作为主键');
    });

    test('未知修饰键抛错', () => {
      throws(() => encodeBinding({ key: 's', mods: ['cmd'] as never }), '未知的修饰键');
    });

    test('空按键抛错', () => {
      throws(() => encodeBinding({ key: '  ' }), '不能为空');
    });

    test('空字符串解码抛错', () => {
      throws(() => decodeBinding(''), '空的按键组合');
    });

    test('⚠️ 冲突策略 swap（互换）', () => {
      const rb = new Rebind({ jump: { key: 'space' }, attack: { key: 'j' } }, { conflict: 'swap' });
      rb.bind('jump', { key: 'j' });
      eq(rb.bindingOf('jump')!.key, 'j');
      eq(rb.bindingOf('attack')!.key, 'space', 'attack 应换到 space');
    });

    test('⚠️ 冲突策略 unbind（顶掉）', () => {
      const rb = new Rebind({ jump: { key: 'space' }, attack: { key: 'j' } }, { conflict: 'unbind' });
      rb.bind('jump', { key: 'j' });
      eq(rb.bindingOf('jump')!.key, 'j');
      eq(rb.has('attack'), false, 'attack 应被解除');
    });

    test('⚠️ 冲突策略 reject（拒绝）', () => {
      const rb = new Rebind({ jump: { key: 'space' }, attack: { key: 'j' } }, { conflict: 'reject' });
      eq(rb.bind('jump', { key: 'j' }), false);
      eq(rb.bindingOf('jump')!.key, 'space', '应保持不变');
    });

    test('⚠️ swap 时目标原本没绑定 → 退化为 unbind（不丢绑定）', () => {
      /**
       * 【修过的 bug】
       * 原实现在 swap 分支里无条件执行 "A ← B 的旧键"，
       * 而 B 原本没绑定时，这会把 A 解绑（两个动作都指向 space 或都消失）。
       */
      const rb = new Rebind({ attack: { key: 'j' } }, { conflict: 'swap' });
      eq(rb.bind('jump', { key: 'j' }), true);
      eq(rb.bindingOf('jump')!.key, 'j');
      eq(rb.has('attack'), false, 'attack 被顶掉');
      eq(rb.actionOf({ key: 'j' }), 'jump', 'j 应归 jump，不该残留');
    });

    test('绑定到自己当前的键：无冲突', () => {
      const rb = new Rebind({ jump: { key: 'space' } });
      eq(rb.bind('jump', { key: 'space' }), true);
      eq(rb.bindingOf('jump')!.key, 'space');
    });

    test('⚠️ 保留键不可绑定', () => {
      const rb = new Rebind();
      throws(() => rb.bind('menu', { key: 'escape' }), '保留键');
      throws(() => rb.bind('full', { key: 'F11' }), '保留键', '大小写不敏感');
    });

    test('isReserved', () => {
      const rb = new Rebind();
      eq(rb.isReserved('escape'), true);
      eq(rb.isReserved('ESCAPE'), true);
      eq(rb.isReserved('j'), false);
    });

    test('自定义保留键', () => {
      const rb = new Rebind({}, { reserved: ['q'] });
      eq(rb.isReserved('q'), true);
      eq(rb.isReserved('escape'), false, '未列出就不保留');
    });

    test('unbind', () => {
      const rb = new Rebind({ jump: { key: 'space' } });
      eq(rb.unbind('jump'), true);
      eq(rb.has('jump'), false);
      eq(rb.actionOf({ key: 'space' }), null, '反向索引也应清理');
      eq(rb.unbind('jump'), false, '重复解除返回 false');
    });

    test('✓ 解除后可重新绑定到该键', () => {
      const rb = new Rebind({ attack: { key: 'j' } });
      rb.unbind('attack');
      eq(rb.bind('jump', { key: 'j' }), true, '旧索引必须已清理，否则会误判冲突');
    });

    test('unbind 不存在的动作返回 false', () => {
      const rb = new Rebind();
      eq(rb.unbind('nope'), false);
    });

    test('⚠️ 恢复默认', () => {
      const rb = new Rebind({ jump: { key: 'space' }, attack: { key: 'j' } });
      rb.bind('jump', { key: 'w' });
      rb.bind('attack', { key: 'e' });
      rb.resetToDefault();
      eq(rb.bindingOf('jump')!.key, 'space');
      eq(rb.bindingOf('attack')!.key, 'j');
    });

    test('clearAll', () => {
      const rb = new Rebind({ jump: { key: 'space' } });
      rb.clearAll();
      eq(rb.actions.length, 0);
    });

    test('导出/导入', () => {
      const a = new Rebind({ jump: { key: 'space' } });
      a.bind('jump', { key: 'w' });
      const state = a.exportState();
      eq(state.jump, 'w');

      const b = new Rebind({ jump: { key: 'space' } });
      b.importState(state);
      eq(b.bindingOf('jump')!.key, 'w');
    });

    test('⚠️ 导入保留键的项被跳过', () => {
      const rb = new Rebind();
      rb.importState({ menu: 'escape' });
      eq(rb.has('menu'), false, '不该恢复保留键的绑定');
    });

    test('⚠️ 导入损坏数据不崩', () => {
      const rb = new Rebind({ jump: { key: 'space' } });
      rb.importState({ jump: 'ctrl+shift', other: 'x' });   // ctrl+shift 无主键
      eq(rb.bindingOf('jump')!.key, 'space', '应保持原绑定');
    });

    test('toObject 还原配置', () => {
      const rb = new Rebind({ jump: { key: 'space' }, save: { key: 's', mods: ['ctrl'] } });
      const o = rb.toObject();
      eq(o.jump.key, 'space');
      eq(o.save.key, 's');
      eq((o.save.mods ?? []).join(','), 'ctrl');
    });

    test('actions 列出全部', () => {
      const rb = new Rebind({ a: { key: 'q' }, b: { key: 'w' } });
      eq(rb.actions.sort().join(','), 'a,b');
    });

    test('onChange 回调', () => {
      const seen: string[] = [];
      const rb = new Rebind({}, { onChange: (a) => seen.push(a) });
      rb.bind('jump', { key: 'space' });
      rb.unbind('jump');
      eq(seen.join(','), 'jump,jump');
    });

    // ---------- 展示 ----------

    test('formatBinding', () => {
      eq(formatBinding({ key: 's', mods: ['ctrl'] }), 'Ctrl+S');
      eq(formatBinding({ key: 'space' }), 'Space');
      eq(formatBinding({ key: 'j' }), 'J');
      eq(formatBinding({ key: 'a', mods: ['ctrl', 'shift', 'alt'] }), 'Ctrl+Alt+Shift+A');
    });

    test('⚠️ 左右修饰键有可读的展示名', () => {
      /**
       * 键盘事件给的 code 是 `ShiftLeft` / `ControlRight`，
       * 不映射的话设置界面会显示 "Shiftleft" —— 玩家看不懂。
       */
      eq(prettyKey('shiftleft'), 'L-Shift');
      eq(prettyKey('shiftright'), 'R-Shift');
      eq(prettyKey('controlleft'), 'L-Ctrl');
      eq(prettyKey('controlright'), 'R-Ctrl');
      eq(prettyKey('altleft'), 'L-Alt');
      eq(prettyKey('metaleft'), 'L-Meta');
    });

    test('prettyKey 特殊键', () => {
      eq(prettyKey('escape'), 'Esc');
      eq(prettyKey('arrowup'), '↑');
      eq(prettyKey('space'), 'Space');
      eq(prettyKey('k'), 'K');
      eq(prettyKey('enter'), 'Enter');
    });

    test('默认保留键', () => {
      eq(DEFAULT_RESERVED.join(','), 'escape,f11');
    });
  });
}
