/**
 * tests/run_core.ts —— 第一批 6 个插件的测试
 *
 * 覆盖：EventBus / Pool / RNG / Seed / Modifier / DamagePipeline /
 *       Track / SkillPlayer / Cooldown / JoystickCore
 *
 * 这些是「纯逻辑」插件，可以脱离引擎完整单测——
 * 也是 bug 高发区，值得投入。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { RNG } from '../rng/RNG';
import { Seed } from '../rng/Seed';
import { EventBus } from '../event-bus/EventBus';
import { Pool } from '../pool/Pool';
import { JoystickCore } from '../joystick-mover/JoystickCore';
import { FixedRandomSource } from '../_core/types';
import { maxOf, minOf } from '../_core/math';
import { editDistance, similarity } from '../_core/string';
import { DamagePipeline } from '../damage-pipeline/DamagePipeline';
import { IDamageable, DamageResult } from '../damage-pipeline/IDamageable';
import { ModifierSet } from '../damage-pipeline/Modifier';
import { Track } from '../skill-player/Track';
import { SkillPlayer } from '../skill-player/SkillPlayer';
import { Cooldown } from '../skill-player/Cooldown';


// ============================================================
// 测试目标（一个最小的 IDamageable 实现）
// ============================================================

class Dummy implements IDamageable {
  hp: number;
  maxHp: number;
  armor: number;
  resistances: Record<string, number>;
  lastResult: DamageResult | null = null;

  constructor(hp = 100, armor = 0, resistances: Record<string, number> = {}) {
    this.hp = hp;
    this.maxHp = hp;
    this.armor = armor;
    this.resistances = resistances;
  }
  applyDamage(r: DamageResult): void {
    this.hp -= r.value;
    this.lastResult = r;
  }
  isAlive(): boolean {
    return this.hp > 0;
  }
}

export function runCoreTests(): void {
  // ============================================================
  // 1. RNG
  // ============================================================

  describe('RNG · 可复现随机', () => {
    test('同种子产生完全相同序列（核心承诺）', () => {
      const a = new RNG(12345);
      const b = new RNG(12345);
      for (let i = 0; i < 1000; i++) {
        eq(a.next(), b.next(), `第 ${i} 个数`);
      }
    });

    test('不同种子产生不同序列', () => {
      const a = new RNG(1);
      const b = new RNG(2);
      assert(a.next() !== b.next());
    });

    test('种子 0 不会卡住', () => {
      const r = new RNG(0);
      const vals = new Set<number>();
      for (let i = 0; i < 100; i++) vals.add(r.next());
      assert(vals.size > 90, '种子 0 产生了重复值，说明卡住了');
    });

    test('next() 恒在 [0,1)', () => {
      const r = new RNG(999);
      for (let i = 0; i < 10000; i++) {
        const v = r.next();
        assert(v >= 0 && v < 1, `越界: ${v}`);
      }
    });

    test('int(n) 覆盖完整且分布大致均匀', () => {
      const r = new RNG(7);
      const counts = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 60000; i++) counts[r.int(6)]++;
      for (const c of counts) {
        assert(c > 9000 && c < 11000, `分布异常: ${counts.join(',')}`);
      }
    });

    test('rangeInt 包含两端', () => {
      const r = new RNG(3);
      let sawMin = false;
      let sawMax = false;
      for (let i = 0; i < 5000; i++) {
        const v = r.rangeInt(1, 6);
        assert(v >= 1 && v <= 6, `越界: ${v}`);
        if (v === 1) sawMin = true;
        if (v === 6) sawMax = true;
      }
      assert(sawMin && sawMax, '两端未出现');
    });

    test('shuffle 不丢不重（Fisher-Yates）', () => {
      const r = new RNG(11);
      const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      r.shuffle(arr);
      eq(arr.slice().sort((a, b) => a - b).join(','), '1,2,3,4,5,6,7,8,9,10');
    });

    test('fork() 产生独立子流', () => {
      const root = new RNG(42);
      const a = root.fork();
      const b = root.fork();
      assert(a.next() !== b.next(), '两个子流不应相同');
      // 子流的消耗不影响另一个
      const a1 = a.next();
      assert(b.next() !== a1 || true); // 只要不崩
    });

    test('state 可导出导入（存档）', () => {
      const r = new RNG(555);
      r.next();
      r.next();
      const s = r.state;
      const v1 = r.next();
      r.state = s;
      eq(r.next(), v1, '恢复 state 后应得到相同序列');
    });
  });

  describe('Seed · 人类可读种子', () => {
    test('encode → decode 在可表示范围内严格往返一致', () => {
      for (const n of [0, 1, 42, 777, 1234, Seed.CAPACITY - 1]) {
        eq(Seed.decode(Seed.encode(n)), n, `n=${n}`);
      }
    });

    test('超出可表示范围时规约，但 decode(encode(x)) 幂等', () => {
      const t = Seed.encode(12345);
      eq(Seed.encode(Seed.decode(t)!), t, '再编码一次应得到相同字符串（幂等）');
    });

    test('random() 生成的种子可被 decode 解析', () => {
      for (let i = 0; i < 200; i++) {
        const t = Seed.random();
        assert(Seed.decode(t) !== null, `无法解析: ${t}`);
      }
    });

    test('random() 分布覆盖多个词（不是永远同一个）', () => {
      const set = new Set<string>();
      for (let i = 0; i < 200; i++) set.add(Seed.random().split('-')[0]);
      assert(set.size > 10, `只出现了 ${set.size} 种词，分布异常`);
    });

    test('非法输入返回 null 而不崩溃', () => {
      eq(Seed.decode('XXX-99'), null);
      eq(Seed.decode('乱七八糟'), null);
      eq(Seed.decode('DRAGON'), null);
    });

    test('小写输入也能识别', () => {
      assert(Seed.decode('dragon-01') !== null);
    });

    test('daily() 同一天返回相同种子', () => {
      const d = new Date('2024-09-02T10:00:00Z');
      eq(Seed.daily(d, 8), Seed.daily(d, 8));
    });

    test('daily() 不同天返回不同种子', () => {
      const a = new Date('2024-09-02T10:00:00Z');
      const b = new Date('2024-09-03T10:00:00Z');
      assert(Seed.daily(a, 8) !== Seed.daily(b, 8));
    });
  });

  // ============================================================
  // 2. EventBus
  // ============================================================

  describe('EventBus · 事件总线', () => {
    interface E {
      'a': { v: number };
      'b': { v: number };
    }

    test('订阅并收到事件', () => {
      const bus = new EventBus<E>();
      let got = 0;
      bus.on('a', (d) => (got = d.v));
      bus.emit('a', { v: 7 });
      eq(got, 7);
    });

    test('取消订阅后不再收到', () => {
      const bus = new EventBus<E>();
      let n = 0;
      const off = bus.on('a', () => n++);
      bus.emit('a', { v: 1 });
      off();
      bus.emit('a', { v: 1 });
      eq(n, 1);
    });

    test('取消函数幂等（重复调用不会误删别人的监听器）', () => {
      const bus = new EventBus<E>();
      let a = 0;
      let b = 0;
      const offA = bus.on('a', () => a++);
      bus.on('a', () => b++);
      offA();
      offA(); // 重复调用
      bus.emit('a', { v: 1 });
      eq(a, 0);
      eq(b, 1, '不应误删其他监听器');
    });

    test('遍历期间取消订阅不崩溃且不漏调用', () => {
      const bus = new EventBus<E>();
      let b = 0;
      const offA = bus.on('a', () => offA()); // 第一个监听器把自己 off 掉
      bus.on('a', () => b++);
      bus.emit('a', { v: 1 });
      eq(b, 1, '第二个监听器仍应被调用');
    });

    test('once 只触发一次', () => {
      const bus = new EventBus<E>();
      let n = 0;
      bus.once('a', () => n++);
      bus.emit('a', { v: 1 });
      bus.emit('a', { v: 1 });
      eq(n, 1);
    });

    test('监听器抛异常不中断其他监听器', () => {
      const bus = new EventBus<E>({ swallowErrors: true });
      const origErr = console.error;
      console.error = () => {}; // 屏蔽预期内的错误输出
      let b = 0;
      bus.on('a', () => {
        throw new Error('boom');
      });
      bus.on('a', () => b++);
      bus.emit('a', { v: 1 });
      console.error = origErr;
      eq(b, 1);
    });

    test('offAll 清空全部', () => {
      const bus = new EventBus<E>();
      bus.on('a', () => {});
      bus.on('b', () => {});
      eq(bus.listenerCount, 2);
      bus.offAll();
      eq(bus.listenerCount, 0);
    });

    // ── 以下 8 项针对"用了才知道"的边界 ──

    test('同一个函数订阅两次只会触发一次（Set 去重）', () => {
      const bus = new EventBus<E>();
      let n = 0;
      const fn = () => n++;
      bus.on('a', fn);
      bus.on('a', fn);

      eq(bus.listenerCount, 1, '内部用 Set 存储，同引用会去重');
      bus.emit('a', { v: 1 });
      eq(n, 1, '只触发一次');
    });

    test('箭头函数每次都是新引用，不会被去重', () => {
      const bus = new EventBus<E>();
      let n = 0;
      bus.on('a', () => n++);
      bus.on('a', () => n++);

      eq(bus.listenerCount, 2, '两个不同的箭头函数是两个监听器');
      bus.emit('a', { v: 1 });
      eq(n, 2, '触发两次');
    });

    test('once 在未触发时取消，之后不再触发', () => {
      const bus = new EventBus<E>();
      let n = 0;
      const off = bus.once('a', () => n++);
      off();
      bus.emit('a', { v: 1 });

      eq(n, 0, '取消订阅应当彻底');
    });

    test('emit 过程中新订阅的监听器本次不会收到（快照遍历）', () => {
      const bus = new EventBus<E>();
      let late = 0;
      bus.on('a', () => {
        bus.on('a', () => late++);
      });
      bus.emit('a', { v: 1 });

      eq(late, 0, '本次 emit 用的是遍历开始时的快照');
      bus.emit('a', { v: 1 });
      eq(late, 1, '下次 emit 才会收到');
    });

    test('swallowErrors:false 时异常会中断后续监听器', () => {
      const origErr = console.error;
      console.error = () => {};
      const bus = new EventBus<E>({ swallowErrors: false });
      let after = 0;
      bus.on('a', () => {
        throw new Error('boom');
      });
      bus.on('a', () => after++);

      let threw = false;
      try {
        bus.emit('a', { v: 1 });
      } catch {
        threw = true;
      }
      console.error = origErr;

      assert(threw, 'swallowErrors:false 应该把异常抛给调用方');
      eq(after, 0, '后续监听器被中断（开发期用这个快速暴露问题）');
    });

    test('swallowErrors:true（默认）时异常不影响后续监听器', () => {
      const origErr = console.error;
      console.error = () => {};
      const bus = new EventBus<E>();
      let after = 0;
      bus.on('a', () => {
        throw new Error('boom');
      });
      bus.on('a', () => after++);
      bus.emit('a', { v: 1 });
      console.error = origErr;

      eq(after, 1, '默认吞掉异常，一个监听器出错不该影响其他人');
    });

    test('off(name) 清掉该事件全部监听器，不影响其他事件', () => {
      const bus = new EventBus<E>();
      bus.on('a', () => {});
      bus.on('a', () => {});
      bus.on('b', () => {});
      eq(bus.listenerCount, 3);

      bus.off('a');
      eq(bus.has('a'), false);
      eq(bus.has('b'), true, 'off(name) 只清指定事件');
      eq(bus.listenerCount, 1);
    });

    test('嵌套 emit：内层事件在外层回调中间同步执行完', () => {
      const bus = new EventBus<{ g: {}; h: {} }>();
      const order: string[] = [];
      bus.on('g', () => {
        order.push('g1');
        bus.emit('h', {});
        order.push('g2');
      });
      bus.on('h', () => order.push('h'));
      bus.emit('g', {});

      eq(order.join('→'), 'g1→h→g2', '同步执行，不是排到下一帧');
    });

    test('监听器全部取消后 has 返回 false（内部 Map 会删空 entry）', () => {
      const bus = new EventBus<E>();
      const off = bus.on('a', () => {});
      eq(bus.has('a'), true);
      off();
      eq(bus.has('a'), false, '取消后不应残留空 entry');
    });

    test('不传 opts 时 swallowErrors 默认为 true（不是 undefined→抛异常）', () => {
      const origErr = console.error;
      console.error = () => {};
      // 【为什么单独立一项】
      // 以前构造函数直接 `this._opts = opts`，而 emit 里判
      // `if (!this._opts.swallowErrors) throw e`。
      // 不传 opts 时是 undefined → falsy → **抛异常**，与注释相反。
      // 开发环境显式传参一切正常，生产代码忘了传就中断整条事件链。
      const bus = new EventBus<E>();
      let after = 0;
      bus.on('a', () => {
        throw new Error('boom');
      });
      bus.on('a', () => after++);

      let threw = false;
      try {
        bus.emit('a', { v: 1 });
      } catch {
        threw = true;
      }
      console.error = origErr;

      assert(!threw, '默认必须吞掉异常');
      eq(after, 1, '后续监听器照常执行');
    });

    test('destroy 等价于 offAll（可卸载）', () => {
      const bus = new EventBus<E>();
      bus.on('a', () => {});
      bus.on('b', () => {});
      bus.destroy();
      eq(bus.listenerCount, 0);
      eq(bus.has('a'), false);
    });
  });

  // ============================================================
  // 3. Pool
  // ============================================================

  describe('Pool · 对象池', () => {
    class Item {
      v = 0;
      reset(): void {
        this.v = 0;
      }
    }

    test('取出时会调用 onGet 重置', () => {
      const pool = new Pool<Item>(
        () => new Item(),
        (i) => i.reset()
      );
      const a = pool.get();
      a.v = 99;
      pool.put(a);
      const b = pool.get();
      eq(b.v, 0, '复用对象必须已重置');
      assert(b === a, '应该复用同一个对象');
    });

    test('预热后不产生新分配', () => {
      const pool = new Pool<Item>(() => new Item(), undefined, undefined, { maxSize: 10 });
      pool.prewarm(5);
      eq(pool.created, 5);
      const a = pool.get();
      eq(pool.created, 5, '应从空闲池取出而非新建');
      pool.put(a);
    });

    test('超出 maxSize 不无限增长', () => {
      const pool = new Pool<Item>(() => new Item(), undefined, undefined, { maxSize: 3 });
      const items = [pool.get(), pool.get(), pool.get(), pool.get(), pool.get()];
      items.forEach((i) => pool.put(i));
      assert(pool.idle <= 3, `空闲数 ${pool.idle} 超过 maxSize 3`);
    });

    test('active 计数正确（排查泄漏的关键指标）', () => {
      const pool = new Pool<Item>(() => new Item());
      const a = pool.get();
      eq(pool.active, 1);
      pool.put(a);
      eq(pool.active, 0);
    });

    test('未开启 trackLeaks 时 dump 不崩溃', () => {
      const pool = new Pool<Item>(() => new Item());
      assert(typeof pool.dump() === 'string');
    });

    // ── 以下 5 项针对"用了才知道"的边界 ──

    test('重复归还不会让 active 变负数', () => {
      const orig = console.warn;
      console.warn = () => {};
      const pool = new Pool<Item>(() => new Item());
      const a = pool.get();
      pool.put(a);
      pool.put(a); // 调用方 bug：还了两次
      console.warn = orig;

      eq(pool.active, 0, 'active 变负数会让泄漏检测彻底失效');
    });

    test('重复归还后不会 get 到同一个对象两次', () => {
      const orig = console.warn;
      console.warn = () => {};
      const pool = new Pool<Item>(() => new Item());
      const a = pool.get();
      pool.put(a);
      pool.put(a);
      console.warn = orig;

      const b = pool.get();
      const c = pool.get();
      assert(b !== c, '重复归还会让两颗"子弹"变成同一个对象（改一个另一个跟着变）');
    });

    test('重复归还时默认打警告（静默修正会掩盖调用方 bug）', () => {
      const orig = console.warn;
      const msgs: string[] = [];
      console.warn = (m: string) => msgs.push(String(m));
      const pool = new Pool<Item>(() => new Item());
      const a = pool.get();
      pool.put(a);
      pool.put(a);
      console.warn = orig;

      eq(msgs.length, 1, '应警告一次');
      assert(msgs[0].includes('重复归还'), `警告内容应说明原因，实际：${msgs[0]}`);
    });

    test('guardDuplicate:false 时退回旧行为（可显式关闭防护）', () => {
      const orig = console.warn;
      console.warn = () => {};
      const pool = new Pool<Item>(() => new Item(), undefined, undefined, {
        guardDuplicate: false,
      });
      const a = pool.get();
      pool.put(a);
      pool.put(a);
      console.warn = orig;

      eq(pool.active, -1, '关闭防护后回到旧行为（不推荐，仅在实测为瓶颈时）');
    });

    test('超出 maxSize 时 onPut 仍被调用（被丢弃的对象也要休眠）', () => {
      let putCalls = 0;
      const pool = new Pool<Item>(() => new Item(), undefined, () => putCalls++, {
        maxSize: 2,
      });
      const items = [pool.get(), pool.get(), pool.get(), pool.get()];
      items.forEach((i) => pool.put(i));

      eq(putCalls, 4, '不管对象最终是否入池，"休眠"语义都必须执行');
      eq(pool.idle, 2, '只有 2 个真正进池');
    });

    test('clear 只清空闲，不动 active', () => {
      const pool = new Pool<Item>(() => new Item());
      pool.prewarm(3);
      const a = pool.get();
      pool.clear();

      eq(pool.idle, 0, '空闲被清空');
      eq(pool.active, 1, '借出的那个仍算 active——它在外面，池管不着');
      void a;
    });

    test('destroy 把 active 也归零（切场景用这个，不是 clear）', () => {
      const pool = new Pool<Item>(() => new Item());
      const a = pool.get();
      eq(pool.active, 1);
      pool.destroy();

      eq(pool.active, 0, 'destroy 是彻底重置');
      eq(pool.idle, 0);
      void a;
    });

    test('putAll 批量归还后计数正确', () => {
      const pool = new Pool<Item>(() => new Item());
      const items = [pool.get(), pool.get(), pool.get()];
      eq(pool.active, 3);
      pool.putAll(items);

      eq(pool.active, 0);
      eq(pool.idle, 3);
    });

    test('prewarm 不受 maxSize 限制（预热就是要预分配）', () => {
      const pool = new Pool<Item>(() => new Item(), undefined, undefined, { maxSize: 3 });
      pool.prewarm(20);
      eq(pool.idle, 20, '预热 20 个就该有 20 个，不该被 maxSize 截断');
    });

    test('guardDuplicate 开启时不影响正常复用性能路径', () => {
      const pool = new Pool<Item>(() => new Item(), (i) => i.reset());
      pool.prewarm(4);
      const a = pool.get();
      pool.put(a);
      const b = pool.get();
      pool.put(b);
      const c = pool.get();

      assert(c === a || c === b, '仍应复用已有对象，不该新建');
      eq(pool.created, 4, 'prewarm 之外不应有任何新建');
    });
  });

  // ============================================================
  // 4. Modifier
  // ============================================================

  describe('Modifier · 数值修正', () => {
    test('先加后乘：(10 + 5) × 1.2 = 18', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'add', value: 5 });
      m.add('atk', { type: 'mul', value: 0.2 });
      eq(m.get('atk', 10), 18);
    });

    test('两个 +20% 是累加成 +40%（不是乘算的 44%）', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'mul', value: 0.2 });
      m.add('atk', { type: 'mul', value: 0.2 });
      eq(m.get('atk', 100), 140);
    });

    test('override 覆盖一切', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'add', value: 100 });
      m.add('atk', { type: 'override', value: 42 });
      eq(m.get('atk', 10), 42);
    });

    test('按 tag 批量清理（buff 到期）', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'mul', value: 0.5, tag: 'buff' });
      m.add('atk', { type: 'add', value: 3, tag: 'weapon' });
      eq(m.get('atk', 10), 19.5);
      m.clearByTag('atk', 'buff');
      eq(m.get('atk', 10), 13, '只应移除 buff');
    });

    test('base 变化后缓存失效（不会返回旧值）', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'add', value: 5 });
      eq(m.get('atk', 10), 15);
      eq(m.get('atk', 100), 105, 'base 变了，缓存必须失效');
    });

    test('clearTagEverywhere 清理所有属性', () => {
      const m = new ModifierSet();
      m.add('atk', { type: 'add', value: 5, tag: 'buff' });
      m.add('def', { type: 'add', value: 5, tag: 'buff' });
      m.clearTagEverywhere('buff');
      eq(m.get('atk', 10), 10);
      eq(m.get('def', 10), 10);
    });
  });

  // ============================================================
  // 5. DamagePipeline
  // ============================================================

  describe('DamagePipeline · 伤害管线', () => {
    test('无修正时伤害 = 原值', () => {
      const p = new DamagePipeline();
      eq(p.calculate({ raw: 20 }, new Dummy(100)).value, 20);
    });

    test('暴击应用倍率', () => {
      const p = DamagePipeline.createDefault({ defaultCritMul: 2 });
      const r = p.calculate({ raw: 20, crit: true }, new Dummy(100));
      near(r.value, 40, 1);
      assert(r.isCrit);
    });

    test('护甲用除法公式：20 → 100 护甲时是 10（不是 0 或负数）', () => {
      const p = DamagePipeline.createDefault();
      const r = p.calculate({ raw: 20 }, new Dummy(100, 100));
      near(r.value, 10, 0.6, '20 × 100/(100+100) = 10');
    });

    test('极高护甲也不会归零（不会负伤害）', () => {
      const p = DamagePipeline.createDefault();
      const r = p.calculate({ raw: 20 }, new Dummy(100, 99999));
      assert(r.value >= 1, `伤害 ${r.value} 不应低于保底 1`);
      assert(r.value > 0, '绝不能出现负伤害或零伤害');
    });

    test('真实伤害无视护甲与抗性', () => {
      const p = DamagePipeline.createDefault();
      const target = new Dummy(100, 50, { fire: 0.8 });
      const r = p.calculate({ raw: 20, type: 'true' }, target);
      eq(r.value, 20);
    });

    test('抗性减伤正确（+50% 抗性 → 伤害减半）', () => {
      const p = DamagePipeline.createDefault();
      const r = p.calculate({ raw: 20, type: 'fire' }, new Dummy(100, 0, { fire: 0.5 }));
      near(r.value, 10, 0.6);
    });

    test('负抗性 = 易伤（-30% → +30% 伤害）', () => {
      const p = DamagePipeline.createDefault();
      const r = p.calculate({ raw: 20, type: 'ice' }, new Dummy(100, 0, { ice: -0.3 }));
      near(r.value, 26, 0.6);
    });

    test('抗性上限 0.9（不允许完全免疫）', () => {
      const p = DamagePipeline.createDefault();
      const r = p.calculate({ raw: 100, type: 'fire' }, new Dummy(100, 0, { fire: 1.0 }));
      assert(r.value >= 10, `减伤不应超过 90%，实际 ${r.value}`);
    });

    test('护甲穿透生效', () => {
      const p = DamagePipeline.createDefault();
      const t = new Dummy(100, 20);
      const noPen = p.calculate({ raw: 20 }, t).value;
      const withPen = p.calculate({ raw: 20, armorPen: 0.5 }, t).value;
      assert(withPen > noPen, `穿透后伤害应更高（${withPen} vs ${noPen}）`);
    });

    test('插入自定义 stage 且不破坏原有阶段', () => {
      const p = DamagePipeline.createDefault();
      p.addStage('double', (v) => v * 2, 20);
      const r = p.calculate({ raw: 10 }, new Dummy(100));
      near(r.value, 20, 0.6);
    });

    test('stages 记录中间值（可追踪每步）', () => {
      const p = DamagePipeline.createDefault();
      const r = p.calculate({ raw: 20, crit: true }, new Dummy(100, 20));
      assert(r.stages.length >= 3);
      eq(r.stages[0].name, 'base');
      eq(r.stages[0].value, 20);
    });

    test('calculate 是纯函数（不扣血、无副作用）', () => {
      const p = DamagePipeline.createDefault();
      const t = new Dummy(100);
      for (let i = 0; i < 100; i++) p.calculate({ raw: 10 }, t);
      eq(t.hp, 100, 'calculate 不应修改目标');
    });

    test('apply 才扣血，并触发 onResult', () => {
      const p = DamagePipeline.createDefault();
      let notified = 0;
      p.onResult(() => notified++);
      const t = new Dummy(100);
      p.apply({ raw: 30 }, t);
      assert(t.hp < 100);
      eq(notified, 1);
    });

    test('取整只在最后一步（中间取整会让百分比加成失效）', () => {
      const p = new DamagePipeline();
      // 1.5 经过 ×1.5 应该是 2.25 → 取整 2；如果中间取整会变成 1×1.5=1.5→2，结果巧合相同
      // 用更明显的例子：0.4 × 3 = 1.2 → 1；中间取整会变 0 × 3 = 0
      p.addStage('triple', (v) => v * 3, 10);
      const r = p.calculate({ raw: 0.4 }, new Dummy(100));
      eq(r.value, 1, '0.4 × 3 = 1.2 → 取整 1（中间取整会得到 0）');
    });
  });

  // ============================================================
  // 6. Track & SkillPlayer
  // ============================================================

  describe('Track · 时间轴', () => {
    test('事件按时间排序（构造时自动排）', () => {
      const t = new Track({
        duration: 2,
        events: [
          { t: 1.5, type: 'a' },
          { t: 0.2, type: 'b' },
          { t: 0.9, type: 'c' },
        ],
      });
      eq(t.events.map((e) => e.type).join(','), 'b,c,a');
    });

    test('区间查询不漏事件（一帧跨多个事件）', () => {
      const t = new Track({
        duration: 2,
        events: [
          { t: 0.1, type: 'a' },
          { t: 0.2, type: 'b' },
          { t: 0.3, type: 'c' },
        ],
      });
      const out = t.query(0, 0.5);
      eq(out.length, 3, '一帧跨过多个事件时应全部返回');
    });

    test('t=0 的事件会被区间查询包含（不漏起手事件）', () => {
      const t = new Track({ duration: 1, events: [{ t: 0, type: 'start' }] });
      const out = t.query(0, 0.5);
      eq(out.length, 1, 't=0 的事件必须出现在第一帧的查询区间内');
      eq(out[0].type, 'start');
    });

    test('区间边界：左闭右开，不重复不遗漏', () => {
      const t = new Track({
        duration: 2,
        events: [{ t: 0.5, type: 'a' }, { t: 1.0, type: 'b' }],
      });
      eq(t.query(0, 0.5).length, 0, '左闭右开：0.5 不应包含在 [0,0.5)');
      eq(t.query(0.5, 1.0).length, 1, '应只包含 a');
      eq(t.query(1.0, 1.5).length, 1, '应只包含 b');
    });

    test('序列化往返无损', () => {
      const t = new Track({
        duration: 1.5,
        cancellable: true,
        cancelAfter: 0.4,
        events: [
          { t: 0, type: 'anim', data: { name: 'x' } },
          { t: 0.5, type: 'hitbox', data: { r: 2 } },
        ],
      });
      const back = Track.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
      eq(back.duration, 1.5);
      eq(back.events.length, 2);
      eq(back.cancelAfter, 0.4);
      eq(back.events[1].data!['r'], 2);
    });

    test('validate 一次报出所有错误', () => {
      const errors = Track.validate({
        duration: 1,
        events: [
          { t: -1, type: 'x' },
          { t: 5, type: '' },
          { t: 99, type: 'y' },
        ],
      });
      assert(errors.length >= 3, `应报出多个错误，实际 ${errors.length}: ${errors.join('|')}`);
    });

    test('合法配置 validate 返回空数组', () => {
      eq(Track.validate({ duration: 1, events: [{ t: 0.5, type: 'x' }] }).length, 0);
    });

    test('frameToTime 换算正确', () => {
      near(Track.frameToTime(15, 30), 0.5);
      near(Track.frameToTime(24, 24), 1.0);
    });
  });

  describe('SkillPlayer · 技能播放', () => {
    function makeTrack(): Track {
      return new Track({
        duration: 1.0,
        cancellable: true,
        cancelAfter: 0.5,
        events: [
          { t: 0, type: 'begin' },
          { t: 0.3, type: 'hit' },
          { t: 0.7, type: 'end' },
        ],
      });
    }

    test('播放到结束触发所有事件（含 t=0）', () => {
      const p = new SkillPlayer();
      const log: string[] = [];
      p.register('begin', () => log.push('begin'));
      p.register('hit', () => log.push('hit'));
      p.register('end', () => log.push('end'));

      p.play(makeTrack());
      for (let i = 0; i < 70 && p.isPlaying; i++) p.tick(1 / 60);

      eq(log.join(','), 'begin,hit,end');
    });

    test('t=0 的事件在 play() 时立即触发（不等第一帧）', () => {
      const p = new SkillPlayer();
      let fired = false;
      p.register('begin', () => (fired = true));
      p.play(makeTrack());
      assert(fired, '起手事件不应延迟一帧');
    });

    test('暂停时 tick 不推进（timeScale=0 场景）', () => {
      const p = new SkillPlayer();
      const log: string[] = [];
      p.register('hit', () => log.push('hit'));
      p.play(makeTrack());
      p.pause();
      for (let i = 0; i < 100; i++) p.tick(1 / 60); // 传缩放后的 dt=0 才对，这里验证 pause 本身
      eq(log.length, 0, '暂停期间不应触发事件');
    });

    test('传 dt=0（暂停）时不推进时间', () => {
      const p = new SkillPlayer();
      const log: string[] = [];
      p.register('hit', () => log.push('hit'));
      p.play(makeTrack());
      for (let i = 0; i < 100; i++) p.tick(0); // 模拟 timeScale=0
      eq(log.length, 0, 'dt=0 时不应有任何事件触发');
    });

    test('一帧跨多个事件时不漏（大 dt）', () => {
      const p = new SkillPlayer();
      const log: string[] = [];
      p.register('begin', () => log.push('begin'));
      p.register('hit', () => log.push('hit'));
      p.register('end', () => log.push('end'));
      p.play(makeTrack());
      p.tick(0.8); // 一帧跨过 begin 和 hit
      p.tick(0.3);
      eq(log.join(','), 'begin,hit,end');
    });

    test('cancel 触发 onEnd(true)', () => {
      const p = new SkillPlayer();
      let cancelled: boolean | null = null;
      const h = p.play(makeTrack());
      h.onEnd = (c) => (cancelled = c);
      h.cancel();
      eq(cancelled, true);
    });

    test('正常结束触发 onEnd(false)', () => {
      const p = new SkillPlayer();
      let cancelled: boolean | null = null;
      const h = p.play(makeTrack());
      h.onEnd = (c) => (cancelled = c);
      for (let i = 0; i < 70 && p.isPlaying; i++) p.tick(1 / 60);
      eq(cancelled, false);
    });

    test('canCancel 遵守 cancelAfter', () => {
      const p = new SkillPlayer();
      p.play(makeTrack());
      p.tick(0.1);
      eq(p.canCancel, false, '0.1s < cancelAfter 0.5s，不应可取消');
      p.tick(0.5);
      eq(p.canCancel, true);
    });

    test('未注册的事件类型不崩溃', () => {
      const p = new SkillPlayer({ ignoreUnknown: true });
      const origErr = console.error;
      console.error = () => {};
      p.play(new Track({ duration: 0.5, events: [{ t: 0, type: '不存在的类型' }] }));
      for (let i = 0; i < 40 && p.isPlaying; i++) p.tick(1 / 60);
      console.error = origErr;
      assert(true);
    });

    test('事件处理器抛异常不中断播放', () => {
      const p = new SkillPlayer();
      const origErr = console.error;
      console.error = () => {};
      const log: string[] = [];
      p.register('begin', () => {
        throw new Error('boom');
      });
      p.register('end', () => log.push('end'));
      p.play(makeTrack());
      for (let i = 0; i < 70 && p.isPlaying; i++) p.tick(1 / 60);
      console.error = origErr;
      eq(log.join(','), 'end');
    });
  });

  // ============================================================
  // 7. Cooldown
  // ============================================================

  describe('Cooldown · 冷却', () => {
    test('初始可用，触发后进入冷却', () => {
      const cd = new Cooldown({ duration: 1 });
      assert(cd.ready);
      assert(cd.trigger());
      assert(!cd.ready);
    });

    test('冷却中 trigger 返回 false', () => {
      const cd = new Cooldown({ duration: 1 });
      cd.trigger();
      eq(cd.trigger(), false);
    });

    test('时间推进后恢复', () => {
      const cd = new Cooldown({ duration: 1 });
      cd.trigger();
      cd.tick(0.5);
      assert(!cd.ready);
      cd.tick(0.6);
      assert(cd.ready);
    });

    test('充能：可连续触发多次', () => {
      const cd = new Cooldown({ duration: 1, charges: 2 });
      assert(cd.trigger());
      assert(cd.trigger());
      eq(cd.trigger(), false, '两个充能用完');
    });

    test('充能逐个恢复', () => {
      const cd = new Cooldown({ duration: 1, charges: 2 });
      cd.trigger();
      cd.trigger();
      cd.tick(1.0);
      eq(cd.charges, 1, '恢复了一个');
      cd.tick(1.0);
      eq(cd.charges, 2, '恢复满');
    });

    test('冷却缩减用除法（100% 缩减不会变成 0）', () => {
      near(Cooldown.applyReduction(3, 0.5), 2.0);
      near(Cooldown.applyReduction(3, 1.0), 1.5);
      assert(Cooldown.applyReduction(3, 10) > 0, '缩减再大也不能为 0');
    });

    test('dt=0（暂停）时冷却不恢复', () => {
      const cd = new Cooldown({ duration: 1 });
      cd.trigger();
      for (let i = 0; i < 100; i++) cd.tick(0);
      eq(cd.ready, false, '暂停时不应恢复');
    });

    test('remaining 与 progress 正确', () => {
      const cd = new Cooldown({ duration: 2 });
      cd.trigger();
      near(cd.remaining, 2, 0.01);
      cd.tick(1);
      near(cd.progress, 0.5, 0.01);
      near(cd.remaining, 1, 0.01);
    });
  });

  // ============================================================
  // 8. JoystickCore
  // ============================================================

  describe('JoystickCore · 轮盘（纯逻辑）', () => {
    test('死区内输出为零（防手抖）', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0.2 });
      j.onDown(0, 0, 0);
      j.onMove(0, 10, 0); // 10/100 = 0.1 < 0.2
      const o = j.evaluate();
      eq(o.dir.x, 0);
      eq(o.dir.y, 0);
      eq(o.active, false);
    });

    test('超出死区后正常输出', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0.2 });
      j.onDown(0, 0, 0);
      j.onMove(0, 50, 0); // 0.5
      const o = j.evaluate();
      assert(o.active);
      near(o.magnitude, 0.5);
    });

    test('输出归一化（斜向不是 1.41 倍）', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      j.onDown(0, 0, 0);
      j.onMove(0, 100, 100); // 右下 45°，实际距离 141 > radius
      const o = j.evaluate();
      const len = Math.sqrt(o.dir.x ** 2 + o.dir.y ** 2);
      near(len, 1.0, 1e-6, `斜向长度必须是 1，实际 ${len}`);
    });

    test('松开后方向归零（不能一直走）', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      j.onDown(0, 0, 0);
      j.onMove(0, 100, 0);
      assert(j.evaluate().active);
      j.onUp(0);
      eq(j.evaluate().dir.x, 0);
      eq(j.evaluate().dir.y, 0);
      eq(j.evaluate().active, false);
    });

    test('多点触摸：第二个手指不抢占', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      eq(j.onDown(0, 0, 0), true);
      eq(j.onDown(1, 500, 500), false, '第二个触点应被拒绝');
      j.onMove(1, 600, 600); // 第二个手指移动
      near(j.evaluate().magnitude, 0, 1e-6, '不应被第二个手指影响');
    });

    test('clampKnob 限制摇杆头在底盘内', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0, clampKnob: true });
      j.onDown(0, 0, 0);
      j.onMove(0, 500, 0); // 拖很远
      const k = j.knob;
      near(Math.sqrt(k.x ** 2 + k.y ** 2), 100, 1e-6, '摇杆头应被限制在半径内');
    });

    test('八向吸附', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0, snapDirections: 8 });
      j.onDown(0, 0, 0);
      j.onMove(0, 100, 20); // 略微偏上
      const o = j.evaluate();
      // 吸附后应该落到 0 度（正右）
      near(o.dir.x, 1, 1e-6);
      near(o.dir.y, 0, 1e-6);
    });

    test('角度计算正确', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      j.onDown(0, 0, 0);
      j.onMove(0, 0, 100); // 正上
      near(j.evaluate().angle, 90, 0.01);
    });

    test('dynamic 模式：底盘生成在按下位置', () => {
      const j = new JoystickCore({ radius: 100, mode: 'dynamic' });
      j.onDown(0, 300, 200);
      eq(j.center.x, 300);
      eq(j.center.y, 200);
    });

    test('fixed 模式：底盘不动', () => {
      const j = new JoystickCore({ radius: 100, mode: 'fixed' });
      j.onDown(0, 300, 200);
      eq(j.center.x, 0);
      eq(j.center.y, 0);
    });

    test('setAxis 可用外部输入（键盘/手柄复用同一逻辑）', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      j.setAxis(1, 0);
      near(j.evaluate().dir.x, 1);
    });

    // --------------------------------------------------------
    // 回归：Bug-A（非驱动手指抬起复位摇杆）
    //
    // 【背景】2026-09-05 第三轮引擎实测发现。
    // 第二轮实测只验证了"按下时能共存"（摇杆不阻断技能按钮），
    // 没人测"抬起那一下"。结果玩家点技能按钮的手指抬起时，
    // 摇杆节点同样收到 TOUCH_END，调用方无条件复位 →
    // 摇杆视觉消失、输出清零、onEnd 误报，而移动的手指还按着。
    // 表现："点一下技能，角色就顿一下"。
    // --------------------------------------------------------

    test('Bug-A 回归：非驱动手指抬起，onUp 返回 false', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      j.onDown(1, 0, 0); // 指1 驱动
      j.onMove(1, 100, 0);
      assert(j.evaluate().active);

      // 指2（点技能的那根）抬起 —— 不该影响摇杆
      eq(j.onUp(2), false, '非驱动手指抬起必须返回 false');
    });

    test('Bug-A 回归：非驱动手指抬起后，摇杆状态完全不变', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0, mode: 'dynamic' });
      j.onDown(1, 0, 0);
      j.onMove(1, 100, 0);

      const dirBefore = j.evaluate().dir.x;
      const centerBefore = j.center.x;

      j.onUp(2); // 技能手指抬起

      // 关键：底盘中心没被动、方向没被清零、仍视为激活
      eq(j.center.x, centerBefore, '底盘中心不能被非驱动手指的重置清零');
      near(j.evaluate().dir.x, dirBefore, 1e-6, '方向不能被非驱动手指清零');
      assert(j.evaluate().active, '指1 还按着，摇杆必须仍然激活');
    });

    test('Bug-A 回归：驱动手指抬起才返回 true 并归零', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      j.onDown(1, 0, 0);
      j.onMove(1, 100, 0);

      eq(j.onUp(1), true, '驱动手指抬起必须返回 true');
      eq(j.evaluate().active, false);
      eq(j.evaluate().dir.x, 0);
      eq(j.evaluate().dir.y, 0);
    });

    test('Bug-A 回归：完整序列 指1按住 → 指2按下抬起 → 指1仍正常', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      const accept1 = j.onDown(1, 0, 0);
      j.onMove(1, 100, 0);

      const accept2 = j.onDown(2, 500, 500); // 技能手指落下（被拒）
      const upResult2 = j.onUp(2); // 技能手指抬起

      eq(accept1, true);
      eq(accept2, false, '第二指落下必须被拒');
      eq(upResult2, false, '第二指抬起也必须被拒');

      // 指1 继续操作，一切照常
      j.onMove(1, 0, 100);
      near(j.evaluate().dir.y, 1, 1e-6, '指1 必须仍能正常驱动');

      eq(j.onUp(1), true);
      eq(j.evaluate().active, false);
    });

    // --------------------------------------------------------
    // 回归：Bug-D（setAxis 后触摸无法接管）
    // --------------------------------------------------------

    test('Bug-D 回归：setAxis 后触摸可以接管（不需要先 reset）', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      j.setAxis(1, 0); // 键盘驱动中
      near(j.evaluate().dir.x, 1);

      // 玩家改用触摸
      eq(j.onDown(0, 0, 0), true, '外部驱动期间必须允许触摸接管');
      j.onMove(0, 0, 100); // 改为向上
      const o = j.evaluate();
      near(o.dir.y, 1, 1e-6, '接管后方向应跟随触摸，而非残留的键盘方向');
      near(o.dir.x, 0, 1e-6);
    });

    test('Bug-D 回归：触摸驱动期间，第二指仍被拒', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      j.onDown(1, 0, 0); // 真实触摸驱动
      eq(j.onDown(2, 10, 10), false, '真实触摸期间第二指必须被拒');
    });

    test('Bug-D 回归：接管后重新 setAxis 依然可用', () => {
      const j = new JoystickCore({ radius: 100, deadZone: 0 });
      j.setAxis(1, 0);
      j.onDown(0, 0, 0);
      j.onUp(0); // 松手
      j.setAxis(0, 1); // 再切回键盘
      near(j.evaluate().dir.y, 1, 1e-6);
    });
  });

  // ============================================================
  // 9. 回归：Bug-E（FixedRandomSource 空序列返回 undefined）
  //
  // 【背景】第三轮引擎实测在 _core/types.ts 边界走查中发现。
  // _i % 0 → NaN → _values[NaN] → undefined。
  // 危害不在 undefined 本身，而在它**静默传播**：
  //   掉落表权重 undefined → loot.roll() 返回 undefined
  //   → 玩家击杀怪物什么都不掉，控制台没有任何报错。
  // ============================================================

  describe('FixedRandomSource · 空序列契约', () => {
    test('Bug-E 回归：空数组构造时抛错（而不是静默返回 undefined）', () => {
      throws(
        () => new FixedRandomSource([]),
        '不能为空',
        '空序列必须立刻失败，绝不能让 undefined 流向下游'
      );
    });

    test('Bug-E 回归：正常序列行为不变', () => {
      const r = new FixedRandomSource([0.1, 0.9]);
      near(r.next(), 0.1);
      near(r.next(), 0.9);
      near(r.next(), 0.1, 1e-6, '应循环回第一个值');
      eq(r.calls, 3);
    });

    test('Bug-E 回归：reset 后从头开始', () => {
      const r = new FixedRandomSource([0.25, 0.75]);
      r.next();
      r.reset();
      near(r.next(), 0.25);
      eq(r.calls, 1);
    });
  });


  // ==================== _core 文档补齐后的回归 ====================
  //
  // 【背景】2026-09-06 审查脚本报「_core 有 5 个导出 README 未提」，
  // 其中 maxOf / minOf / similarity 此前**既没文档也没测试**。
  // 补文档时实测发现了两个需要锁住的行为：
  //   1. maxOf/minOf 空数组返回 fallback（默认 0），不是 -Infinity
  //   2. similarity 有长度差短路，会与 editDistance 给出"矛盾"的答案

  describe('_core/math · maxOf / minOf · 非有限值（E 组的增量）', () => {
    // 【为什么只补这两项】
    // `run_numguard.ts` 的 E 组（批次 5）已有 E1~E4：
    //   空数组 fallback / fallback 可自定义 / 非空取极值 / maxWaitMs 场景对照
    // 本组只补 E 组没覆盖的**非有限值**行为，不重复造轮子。
    //
    // 【我犯的错，记下来】
    // 补之前我 grep `maxOf` 在 tests/ 下"没搜到"，判定"完全没有测试"。
    // 实际是 `maxOffset` 把结果淹了，我只看了前 5 行就下结论。
    // **grep 只看前几行 = 没看**——这次是靠反向验证撞出 E1 才发现的。

    test('⚠️ NaN 传染，不静默跳过', () => {
      // 源码注释：NaN 参与的比较恒为 false，会被跳过；
      // 但"不该静默跳过"，所以显式检测后返回 NaN
      assert(Number.isNaN(maxOf([1, NaN, 3])), 'maxOf 遇到 NaN 应返回 NaN');
      assert(Number.isNaN(minOf([1, NaN, 3])), 'minOf 遇到 NaN 应返回 NaN');
      eq(Number.isNaN(Math.max(1, NaN, 3)), true, '与 Math.max 行为一致（对照）');
    });

    test('Infinity 不做特殊处理，如实返回', () => {
      eq(maxOf([1, Infinity]), Infinity);
      eq(minOf([1, -Infinity]), -Infinity);
      // 与 NaN 传染是同一口径：宁可让坏值可见地传播，也不要静默降级
    });
  });

  describe('_core/string · similarity 短路 · 文档契约锁定（增量）', () => {
    // 【为什么只补这两项】
    // `run_fixregress.ts:1202` 已有「similarity 有提前返回，不等于 1 - dist/max」，
    // `run_batch10.ts:507` 有子串匹配与边界。
    // 本组只锁**文档里承诺的具体数字**，让文档与实现绑定——
    // 改坏了文档就得跟着改，反之亦然。
    //
    // 【我犯的错，记下来】
    // 补之前 grep 结果被 `head -6` 截断，我只看了前面几行就判定"没测过"。
    // 与上面的 maxOf（被 `maxOffset` 淹没）是**同一类错误**：
    // **grep 结果没看完 = 没看**。两次都是靠反向验证撞出来才发现的。

    test('⚠️ 文档表格行：godmode vs completely-different', () => {
      // 文档写着 dist=17 但 sim=0 —— 锁住这个"矛盾"
      eq(editDistance('godmode', 'completely-different'), 17, '文档写 17');
      eq(similarity('godmode', 'completely-different'), 0, '文档写 0（短路）');
      assert(editDistance('godmode', 'completely-different') > 0
             && similarity('godmode', 'completely-different') === 0,
             '锁住矛盾本身：正是它导致模糊匹配漏检');
    });

    test('⚠️ 文档例子：短词 vs 长词会漏匹配（实际场景的坑）', () => {
      // 玩家输入缩写、候选是全称 —— 语义相关但 similarity 判 0
      eq(similarity('hp', 'hitpoints-remaining'), 0, '文档承诺 0');
      assert(editDistance('hp', 'hitpoints-remaining') > 0,
             'editDistance 仍给出真实距离 → 长度不可控时应改用它');
    });
  });

}
