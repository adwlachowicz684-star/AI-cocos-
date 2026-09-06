/**
 * tests/run_batch4.ts —— 第三批插件的测试
 *
 * 覆盖：di、scheduling、inventory、card、dialogue、expression、snapshot、replay、i18n
 *
 * 【这批的共同特点】
 * 它们都是"基础设施"类插件——用的时候很爽，错了很难查：
 * - DI 循环依赖 → RangeError: Maximum call stack，看不出是 DI 的问题
 * - 背包交换的边界 → 物品凭空消失（玩家最愤怒的 bug）
 * - 表达式除零 → NaN 沿管线传播，最后表现为"打怪没伤害"
 * - 快照深拷贝循环引用 → JSON.stringify 直接抛异常
 * - 回放种子不匹配 → 能播但结果不对，你以为是对的
 * 每一个都必须有测试。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { DIContainer } from '../di/DIContainer';
import { FrameScheduler } from '../scheduling/FrameScheduler';
import { Inventory } from '../inventory/Inventory';
import { Deck } from '../card/Deck';
import { DialogueGraph } from '../dialogue/DialogueGraph';
import { Expression } from '../expression/Expression';
import { deepClone, diffSnapshots, createPatch, applyPatch, UndoStack } from '../snapshot/Snapshot';
import { ReplayRecorder } from '../replay/ReplayRecorder';
import { I18N } from '../i18n/I18N';
import { RNG } from '../rng/RNG';

export async function runBatch4Tests(): Promise<void> {
  // ============================================================
  // DI
  // ============================================================

  describe('DIContainer · 依赖注入', () => {
    test('注册并解析', () => {
      const c = new DIContainer();
      c.register('n', () => 42);
      eq(c.get<number>('n'), 42);
    });

    test('singleton：多次 get 返回同一实例', () => {
      const c = new DIContainer();
      let created = 0;
      c.register('obj', () => {
        created++;
        return { id: created };
      });
      const a = c.get<{ id: number }>('obj');
      const b = c.get<{ id: number }>('obj');
      eq(a, b);
      eq(created, 1);
    });

    test('transient：每次都新建', () => {
      const c = new DIContainer();
      let created = 0;
      c.register('obj', () => {
        created++;
        return { id: created };
      }, { lifetime: 'transient' });
      c.get('obj');
      c.get('obj');
      eq(created, 2);
    });

    test('依赖链自动解析', () => {
      const c = new DIContainer();
      c.register('seed', () => 123);
      c.register('rng', (cc) => new RNG(cc.get<number>('seed')));
      c.register('table', (cc) => ({ rng: cc.get<RNG>('rng') }));
      const t = c.get<{ rng: RNG }>('table');
      assert(t.rng instanceof RNG);
    });

    test('循环依赖被检测（不是栈溢出）', () => {
      const c = new DIContainer();
      c.register('a', (cc) => ({ b: cc.get('b') }));
      c.register('b', (cc) => ({ a: cc.get('a') }));
      let msg = '';
      try {
        c.get('a');
      } catch (e) {
        msg = e instanceof Error ? e.message : '';
      }
      assert(msg.includes('循环依赖'), msg);
      assert(msg.includes('a → b → a'), `应报出依赖链，实际：${msg}`);
    });

    test('未注册的 key 报错并给出近似提示', () => {
      const c = new DIContainer();
      c.register('playerService', () => ({}));
      let msg = '';
      try {
        c.get('playerServce');
      } catch (e) {
        msg = e instanceof Error ? e.message : '';
      }
      assert(msg.includes('未注册'), msg);
      assert(msg.includes('playerService'), `应给出近似提示，实际：${msg}`);
    });

    test('重复注册默认抛错，override 可以覆盖', () => {
      const c = new DIContainer();
      c.register('x', () => 1);
      throws(() => c.register('x', () => 2));
      c.register('x', () => 3, { override: true });
      eq(c.get<number>('x'), 3);
    });

    test('覆盖注册后旧单例失效', () => {
      const c = new DIContainer();
      c.register('x', () => 1);
      eq(c.get<number>('x'), 1);
      c.register('x', () => 99, { override: true });
      eq(c.get<number>('x'), 99, '不应返回缓存的 1');
    });

    test('fork 继承并可覆盖（测试换依赖）', () => {
      const c = new DIContainer();
      c.register('rng', () => new RNG(1));
      c.register('svc', (cc) => ({ rng: cc.get<RNG>('rng') }));

      const child = c.fork();
      child.register('rng', () => new RNG(999), { override: true });

      // 父容器不受影响
      assert(c.get<{ rng: RNG }>('svc').rng !== child.get<{ rng: RNG }>('svc').rng);
    });

    test('validate 提前发现解析失败', () => {
      const c = new DIContainer();
      c.register('ok', () => 1);
      c.register('bad', (cc) => cc.get('不存在'));
      const errors = c.validate();
      eq(errors.length, 1);
      assert(errors[0].includes('不存在'), errors[0]);
    });

    test('tryGet 不存在返回 undefined 而不抛错', () => {
      const c = new DIContainer();
      eq(c.tryGet('nope'), undefined);
    });

    test('disposable 注册的对象会被销毁', () => {
      const c = new DIContainer();
      let destroyed = false;
      c.disposable('svc', () => ({
        destroy() {
          destroyed = true;
        },
      }));
      c.get('svc');
      c.destroy();
      eq(destroyed, true);
    });

    test('工厂抛异常时错误信息带上 key', () => {
      const c = new DIContainer();
      c.register('boom', () => {
        throw new Error('内部错误');
      });
      let msg = '';
      try {
        c.get('boom');
      } catch (e) {
        msg = e instanceof Error ? e.message : '';
      }
      assert(msg.includes('boom'), `应指出是哪个 key 出错，实际：${msg}`);
    });

    test('clearSingletons 保留注册但清缓存', () => {
      const c = new DIContainer();
      let created = 0;
      c.register('x', () => ++created);
      eq(c.get<number>('x'), 1);
      c.clearSingletons();
      eq(c.get<number>('x'), 2);
      eq(c.has('x'), true);
    });
  });

  // ============================================================
  // FrameScheduler
  // ============================================================

  describe('FrameScheduler · 分帧调度', () => {
    /** 可控的假时钟 */
    function fakeClock() {
      let t = 0;
      return {
        now: () => t,
        advance: (ms: number) => {
          t += ms;
        },
      };
    }

    test('分帧处理完整个批次', () => {
      const clock = fakeClock();
      const fs = new FrameScheduler({ budgetMs: 4, now: clock.now });

      const items = Array.from({ length: 50 }, (_, i) => i);
      const processed: number[] = [];

      fs.scheduleBatch(items, (it) => {
        processed.push(it);
        clock.advance(1); // 每项 1ms
      });

      // 每帧预算 4ms → 每帧约 4 项
      let frames = 0;
      while (fs.isBusy && frames < 100) {
        fs.update();
        frames++;
      }

      eq(processed.length, 50);
      assert(frames > 10, `应分多帧，实际 ${frames} 帧`);
      eq(processed.join(','), items.join(','), '顺序应正确');
    });

    test('优先级高的先执行', () => {
      const clock = fakeClock();
      const fs = new FrameScheduler({ budgetMs: 100, now: clock.now });
      const order: string[] = [];

      fs.schedule(() => {
        order.push('low');
        clock.advance(1);
        return true;
      }, { priority: 1 });

      fs.schedule(() => {
        order.push('high');
        clock.advance(1);
        return true;
      }, { priority: 10 });

      fs.update();
      eq(order.join(','), 'high,low');
    });

    test('硬上限强制本帧结束（单项很慢也不卡死）', () => {
      const clock = fakeClock();
      const fs = new FrameScheduler({ budgetMs: 4, hardLimitMs: 10, now: clock.now });

      let steps = 0;
      fs.schedule(() => {
        steps++;
        clock.advance(3); // 每步 3ms
        return steps >= 100;
      });

      fs.update();
      // 预算 4ms 但每项 3ms：第一步后已 3ms < 4，继续；第二步后 6ms，超预算停
      assert(steps <= 5, `应在硬上限内停止，实际跑了 ${steps} 步`);
    });

    test('onDone 在完成后触发一次', () => {
      const clock = fakeClock();
      const fs = new FrameScheduler({ budgetMs: 10, now: clock.now });
      let done = 0;

      fs.schedule(
        () => {
          clock.advance(1);
          return true;
        },
        { onDone: () => done++ }
      );

      fs.update();
      fs.update();
      eq(done, 1);
    });

    test('onProgress 回调进度', () => {
      const clock = fakeClock();
      const fs = new FrameScheduler({ budgetMs: 10, now: clock.now });
      const progress: number[] = [];

      fs.scheduleBatch(
        [1, 2, 3, 4, 5],
        () => clock.advance(1),
        { onProgress: (d) => progress.push(d), onDone: () => {} }
      );
      fs.flush();
      eq(progress[progress.length - 1], 5);
    });

    test('cancel 取消任务并触发 onCancel', () => {
      const fs = new FrameScheduler({ budgetMs: 10 });
      let cancelled = false;
      let ran = false;

      const id = fs.schedule(() => {
        ran = true;
        return true;
      }, { onCancel: () => (cancelled = true) });

      eq(fs.cancel(id), true);
      fs.update();
      eq(ran, false);
      eq(cancelled, true);
    });

    test('flush 同步跑完（不等下一帧）', () => {
      const fs = new FrameScheduler({ budgetMs: 1 });
      let n = 0;
      fs.schedule(() => {
        n++;
        return n >= 1000;
      });
      fs.flush();
      eq(n, 1000);
      eq(fs.isBusy, false, 'flush 后队列必须清空（第一版忘了 shift，靠 guard 撑 100 万次）');
      eq(fs.pendingCount, 0);
    });

    test('任务抛异常不崩溃，且不再重试', () => {
      const clock = fakeClock();
      const fs = new FrameScheduler({ budgetMs: 10, now: clock.now });
      const origErr = console.error;
      console.error = () => {};

      let calls = 0;
      fs.schedule(() => {
        calls++;
        throw new Error('任务内部错误');
      });

      fs.update();
      fs.update();
      console.error = origErr;

      eq(calls, 1, '出错的任务不应每帧重试');
      eq(fs.isBusy, false);
    });

    test('空批次立即完成', () => {
      const fs = new FrameScheduler();
      let done = false;
      fs.scheduleBatch([], () => {}, { onDone: () => (done = true) });
      eq(done, true);
    });

    test('cancelAll 清空所有任务', () => {
      const fs = new FrameScheduler();
      fs.schedule(() => true);
      fs.schedule(() => true);
      eq(fs.pendingCount, 2);
      fs.cancelAll();
      eq(fs.pendingCount, 0);
    });

    test('预算必须为正', () => {
      throws(() => new FrameScheduler({ budgetMs: 0 }));
    });
  });

  // ============================================================
  // Inventory
  // ============================================================

  describe('Inventory · 背包', () => {
    function makeBag(size = 5): Inventory {
      const bag = new Inventory({ size });
      bag.define({ id: 'arrow', name: '箭', maxStack: 99 });
      bag.define({ id: 'potion', name: '药水', maxStack: 5 });
      bag.define({ id: 'sword', name: '剑', maxStack: 1 });
      return bag;
    }

    test('添加并堆叠', () => {
      const bag = makeBag();
      eq(bag.add('arrow', 150), 0, '150 个箭：99 + 51，放得下');
      eq(bag.count('arrow'), 150);
      eq(bag.usedSlots, 2);
    });

    test('放不下时返回剩余数量', () => {
      const bag = makeBag(2); // 2 格 × 99 = 198
      eq(bag.add('arrow', 250), 52);
      eq(bag.count('arrow'), 198);
    });

    test('不可堆叠物品一格一个', () => {
      const bag = makeBag();
      bag.add('sword', 3);
      eq(bag.usedSlots, 3);
      eq(bag.count('sword'), 3);
    });

    test('移除跨格子扣减', () => {
      const bag = makeBag();
      bag.add('arrow', 150); // 99 + 51
      eq(bag.remove('arrow', 120), 120);
      eq(bag.count('arrow'), 30);
      eq(bag.usedSlots, 1, '第一格应被清空');
    });

    test('移除数量不足时返回实际移除数', () => {
      const bag = makeBag();
      bag.add('arrow', 10);
      eq(bag.remove('arrow', 50), 10);
      eq(bag.count('arrow'), 0);
    });

    test('move 到空格：搬过去', () => {
      const bag = makeBag();
      bag.add('arrow', 10);
      bag.move(0, 3);
      eq(bag.slots[0].def, null);
      eq(bag.slots[3].def?.id, 'arrow');
      eq(bag.slots[3].count, 10);
    });

    test('move 到同类未满格：合并', () => {
      const bag = makeBag();
      bag.add('arrow', 50);
      bag.add('arrow', 20); // 第二格 20
      bag.move(1, 0);
      eq(bag.slots[0].count, 70);
      eq(bag.slots[1].def, null);
    });

    test('move 合并溢出：部分合并，剩余留在原格', () => {
      const bag = makeBag();
      bag.add('arrow', 95);
      // add() 总会先填满已有堆叠，所以要直接摆出"第二格也有"的局面
      bag.slots[1].def = bag.getDef('arrow')!;
      bag.slots[1].count = 10;

      bag.move(1, 0);
      eq(bag.slots[0].count, 99, '填满为止（95 + 4）');
      eq(bag.slots[1].count, 6, '剩下的留在原格，不是消失');
      eq(bag.count('arrow'), 105, '总数守恒');
    });

    test('move 到不同类：交换（不是覆盖！）', () => {
      const bag = makeBag();
      bag.add('arrow', 30);
      bag.add('potion', 2);
      bag.move(0, 1);
      eq(bag.slots[0].def?.id, 'potion', '原位置变成对方的物品');
      eq(bag.slots[1].def?.id, 'arrow');
      eq(bag.count('arrow'), 30, '箭没有丢失');
      eq(bag.count('potion'), 2, '药水没有丢失');
    });

    test('swap 强制交换（即使同类）', () => {
      const bag = makeBag();
      bag.add('arrow', 30);
      bag.split(0, 10); // 摆出两格：20 / 10
      eq(bag.slots[0].count, 20);
      eq(bag.slots[1].count, 10);

      bag.swap(0, 1);
      eq(bag.slots[0].count, 10, '即使是同类也交换，而不是合并');
      eq(bag.slots[1].count, 20);
    });

    test('split 拆出一部分', () => {
      const bag = makeBag();
      bag.add('arrow', 30);
      const target = bag.split(0, 10);
      eq(target, 1);
      eq(bag.slots[0].count, 20);
      eq(bag.slots[1].count, 10);
    });

    test('split 数量等于全部时失败（应该直接 move）', () => {
      const bag = makeBag();
      bag.add('arrow', 30);
      eq(bag.split(0, 30), -1);
    });

    test('split 背包满时失败', () => {
      const bag = makeBag(2);
      bag.add('sword', 1);
      bag.add('sword', 1);
      eq(bag.split(0, 1), -1, '没有空格');
    });

    test('compact 合并同类并压紧', () => {
      const bag = makeBag();
      bag.add('arrow', 30);
      bag.add('potion', 2);
      // add() 会把 arrow 填进已有的格子，所以直接摆到第三格
      bag.slots[2].def = bag.getDef('arrow')!;
      bag.slots[2].count = 40;
      eq(bag.usedSlots, 3);

      bag.compact();
      eq(bag.usedSlots, 2, '两个 arrow 堆应合并');
      eq(bag.count('arrow'), 70);
      eq(bag.count('potion'), 2, '其他物品不受影响');
    });

    test('remainingSpaceFor 计算正确', () => {
      const bag = makeBag();
      eq(bag.remainingSpaceFor('arrow'), 5 * 99);
      bag.add('arrow', 50);
      eq(bag.remainingSpaceFor('arrow'), 5 * 99 - 50);
    });

    test('change 事件带上受影响的格子', () => {
      const bag = makeBag();
      const events: string[] = [];
      bag.onChange((c) => events.push(`${c.kind}:${c.slots.join('|')}`));
      bag.add('arrow', 10);
      assert(events.length > 0);
      assert(events[0].startsWith('add'), events[0]);
    });

    test('导出导入往返', () => {
      const bag = makeBag();
      bag.add('arrow', 150);
      bag.add('potion', 3);

      const data = bag.export();
      const bag2 = makeBag();
      const skipped = bag2.import(data);

      eq(skipped, 0);
      eq(bag2.count('arrow'), 150);
      eq(bag2.count('potion'), 3);
    });

    test('导入未知物品时跳过而不是崩溃', () => {
      const bag = makeBag();
      const origWarn = console.warn;
      console.warn = () => {};
      const skipped = bag.import([{ id: '不存在的物品', count: 5 }]);
      console.warn = origWarn;
      eq(skipped, 5);
      eq(bag.isEmpty, true);
    });

    test('resize 缩小会丢弃后面的物品', () => {
      const bag = makeBag(5);
      bag.add('sword', 3);
      bag.resize(2);
      eq(bag.size, 2);
      eq(bag.count('sword'), 2, '第三个被丢弃');
    });

    test('未注册物品抛错', () => {
      const bag = makeBag();
      throws(() => bag.add('未定义', 1));
    });

    test('has / isFull / firstEmpty', () => {
      const bag = makeBag(2);
      eq(bag.firstEmpty, 0);
      bag.add('sword', 1);
      eq(bag.firstEmpty, 1);
      bag.add('sword', 1);
      eq(bag.firstEmpty, -1);
      eq(bag.isFull, true);
      eq(bag.has('sword', 2), true);
    });

    test('带 data 的物品不自动合并（两把词缀不同的剑）', () => {
      const bag = makeBag();
      bag.add('sword', 1, { affix: '火焰' });
      bag.add('sword', 1, { affix: '冰霜' });
      eq(bag.usedSlots, 2);
      // 两者 data 不同，move 时应交换而不是合并
      bag.move(0, 1);
      eq(bag.usedSlots, 2, '不应合并消失');
      eq(bag.count('sword'), 2);
    });
  });

  // ============================================================
  // Deck
  // ============================================================

  describe('Deck · 牌库', () => {
    const cards = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

    test('初始牌库与抽牌', () => {
      const deck = new Deck<string>();
      deck.setDeck(cards);
      const rng = new RNG(1);
      const drawn = deck.draw(3, rng);
      eq(drawn.length, 3);
      eq(deck.hand.length, 3);
      eq(deck.drawPile.length, 4);
    });

    test('抽牌从顶部（数组末尾）取', () => {
      const deck = new Deck<string>();
      deck.setDeck(['A', 'B', 'C']);
      eq(deck.top, 'C');
      eq(deck.drawOne(new RNG(1)), 'C');
      eq(deck.top, 'B');
    });

    test('打出后进弃牌堆', () => {
      const deck = new Deck<string>();
      deck.setDeck(cards);
      deck.draw(3, new RNG(1));
      const played = deck.play(0);
      assert(played !== undefined);
      eq(deck.hand.length, 2);
      eq(deck.discardPile.length, 1);
      eq(deck.discardPile[0], played);
    });

    test('消耗（exhaust）不进弃牌堆', () => {
      const deck = new Deck<string>();
      deck.setDeck(cards);
      deck.draw(2, new RNG(1));
      deck.play(0, 'exhaust');
      eq(deck.discardPile.length, 0);
      eq(deck.exhaustPile.length, 1);
    });

    test('抽牌堆空时自动洗回弃牌堆', () => {
      const deck = new Deck<string>();
      deck.setDeck(['A', 'B']);
      const rng = new RNG(5);

      deck.draw(2, rng);
      deck.discardHand(); // 手牌进弃牌堆
      eq(deck.drawPile.length, 0);
      eq(deck.discardPile.length, 2);

      const drawn = deck.draw(2, rng);
      eq(drawn.length, 2, '应自动洗回并抽到');
      eq(deck.discardPile.length, 0);
    });

    test('两堆都空时抽不到（默认不抛错）', () => {
      const deck = new Deck<string>();
      deck.setDeck(['A']);
      deck.draw(1, new RNG(1));
      deck.play(0, 'exhaust'); // 唯一的牌被消耗
      eq(deck.draw(5, new RNG(1)).length, 0);
    });

    test('onEmpty=error 时抛错（用于发现配置错误）', () => {
      const deck = new Deck<string>({ onEmpty: 'error' });
      deck.setDeck(['A']);
      deck.draw(1, new RNG(1));
      deck.play(0, 'exhaust');
      throws(() => deck.draw(1, new RNG(1)));
    });

    test('手牌上限：抽不进的留在抽牌堆', () => {
      const deck = new Deck<string>({ handLimit: 3 });
      deck.setDeck(cards);
      const drawn = deck.draw(10, new RNG(1));
      eq(drawn.length, 3);
      eq(deck.hand.length, 3);
      eq(deck.drawPile.length, 4, '没抽的应留在抽牌堆，不该丢失');
    });

    test('discardHand 清空手牌', () => {
      const deck = new Deck<string>();
      deck.setDeck(cards);
      deck.draw(3, new RNG(1));
      deck.discardHand();
      eq(deck.hand.length, 0);
      eq(deck.discardPile.length, 3);
    });

    test('addToDrawPile 到顶/底', () => {
      const deck = new Deck<string>();
      deck.setDeck(['A', 'B']);
      deck.addToDrawPile('X', 'top');
      eq(deck.top, 'X', '放顶部 = 下一张抽到');
      deck.addToDrawPile('Y', 'bottom');
      eq(deck.drawPile[0], 'Y');
    });

    test('peek 查看顶部不移除', () => {
      const deck = new Deck<string>();
      deck.setDeck(['A', 'B', 'C']);
      eq(deck.peek(2).join(','), 'C,B');
      eq(deck.drawPile.length, 3, '不应移除');
    });

    test('reset 回到主牌库（临时卡不会残留）', () => {
      const deck = new Deck<string>();
      deck.setDeck(['A', 'B', 'C']);
      deck.addToDrawPile('临时诅咒', 'top');
      eq(deck.totalCards, 4);

      deck.reset();
      eq(deck.totalCards, 3, '临时卡应消失');
      eq(deck.drawPile.includes('临时诅咒'), false);
    });

    test('removeEverywhere 从任意区域移除', () => {
      const deck = new Deck<string>();
      deck.setDeck(['A', 'B', 'C']);
      deck.draw(1, new RNG(1)); // C 进手牌
      eq(deck.removeEverywhere('C'), true);
      eq(deck.totalCards, 2);
    });

    test('shuffle 洗牌后牌数不变', () => {
      const deck = new Deck<string>();
      deck.setDeck(cards);
      deck.shuffle(new RNG(42));
      eq(deck.drawPile.length, 7);
      eq(new Set(deck.drawPile).size, 7);
    });

    test('play 到 drawTop（某些卡的效果）', () => {
      const deck = new Deck<string>();
      deck.setDeck(['A', 'B', 'C']);
      deck.draw(1, new RNG(1)); // 抽到 C
      deck.play(0, 'drawTop');
      eq(deck.top, 'C', '应回到抽牌堆顶');
    });

    test('totalCards 统计所有区域', () => {
      const deck = new Deck<string>();
      deck.setDeck(['A', 'B', 'C', 'D']);
      deck.draw(2, new RNG(1));
      deck.play(0);
      deck.play(0, 'exhaust');
      eq(deck.totalCards, 4); // 2 抽牌 + 0 手牌 + 1 弃牌 + 1 消耗
    });

    test('discardRandom 随机弃牌', () => {
      const deck = new Deck<string>();
      deck.setDeck(cards);
      deck.draw(4, new RNG(1));
      const discarded = deck.discardRandom(2, new RNG(9));
      eq(discarded.length, 2);
      eq(deck.hand.length, 2);
    });
  });

  // ============================================================
  // Dialogue
  // ============================================================

  describe('DialogueGraph · 对话系统', () => {
    interface S { gold: number; hasQuest: boolean; talked: number }

    function make(): DialogueGraph<S> {
      const g = new DialogueGraph<S>();
      g.node('start', {
        speaker: '铁匠',
        text: '想打造点什么？',
        choices: [
          { text: '打造武器', next: 'craft', condition: (s) => s.gold >= 100, lockedHint: '需要 100 金币' },
          { text: '闲聊', next: 'smalltalk' },
          { text: '再见', next: null },
        ],
      });
      g.node('craft', {
        speaker: '铁匠',
        text: '好嘞',
        onEnter: (s) => {
          s.gold -= 100;
        },
        next: 'start',
      });
      g.node('smalltalk', { speaker: '铁匠', text: '今天天气不错', next: 'start' });
      return g;
    }

    test('起始节点正确', () => {
      const r = make().start('start', { gold: 150, hasQuest: false, talked: 0 });
      eq(r.current?.speaker, '铁匠');
      eq(r.current?.text, '想打造点什么？');
      eq(r.current?.choices.length, 3);
    });

    test('条件不满足的选项显示 disabled', () => {
      const r = make().start('start', { gold: 50, hasQuest: false, talked: 0 });
      eq(r.current?.choices[0].enabled, false);
      eq(r.current?.choices[0].hint, '需要 100 金币');
    });

    test('条件满足的选项可点', () => {
      const r = make().start('start', { gold: 150, hasQuest: false, talked: 0 });
      eq(r.current?.choices[0].enabled, true);
    });

    test('选择跳转并触发 onEnter', () => {
      const state: S = { gold: 150, hasQuest: false, talked: 0 };
      const r = make().start('start', state);
      eq(r.choose(0), true);
      eq(state.gold, 50, 'onEnter 扣了 100 金币');
      eq(r.currentNodeId, 'craft');
    });

    test('不能选择 disabled 的选项', () => {
      const r = make().start('start', { gold: 50, hasQuest: false, talked: 0 });
      eq(r.choose(0), false);
      eq(r.currentNodeId, 'start', '应停在原地');
    });

    test('next: null 结束对话', () => {
      const r = make().start('start', { gold: 150, hasQuest: false, talked: 0 });
      r.choose(2);
      eq(r.isDone, true);
      eq(r.current, null);
    });

    test('单句节点用 advance 推进', () => {
      const r = make().start('start', { gold: 150, hasQuest: false, talked: 0 });
      r.choose(1); // 闲聊
      eq(r.currentNodeId, 'smalltalk');
      eq(r.advance(), true);
      eq(r.currentNodeId, 'start', 'smalltalk 的 next 指回 start');
    });

    test('有选项的节点 advance 返回 false（必须用 choose）', () => {
      const r = make().start('start', { gold: 150, hasQuest: false, talked: 0 });
      eq(r.advance(), false);
    });

    test('回到之前的节点（图而不是树）', () => {
      const r = make().start('start', { gold: 150, hasQuest: false, talked: 0 });
      r.choose(1);   // 闲聊
      r.advance();   // 回到 start
      eq(r.currentNodeId, 'start');
      r.choose(1);   // 可以再选一次
      eq(r.currentNodeId, 'smalltalk');
    });

    test('validate 发现跳转到不存在的节点', () => {
      const g = new DialogueGraph<S>();
      g.node('a', { text: 'x', next: '不存在的节点' });
      const errors = g.validate();
      eq(errors.length, 1);
      assert(errors[0].includes('不存在'), errors[0]);
    });

    test('findUnreachable 找出死内容', () => {
      const g = new DialogueGraph<S>();
      g.node('a', { text: 'x', next: null });
      g.node('orphan', { text: '没人能到这', next: null });
      eq(g.findUnreachable('a').join(','), 'orphan');
    });

    test('advanceToChoice 连续播放到有选项的节点', () => {
      const g = new DialogueGraph<S>();
      g.node('a', { text: '第一句', next: 'b' });
      g.node('b', { text: '第二句', next: 'c' });
      g.node('c', { text: '选一个', choices: [{ text: '好', next: null }] });

      const r = g.start('a', { gold: 0, hasQuest: false, talked: 0 });
      eq(r.advanceToChoice(), true);
      eq(r.currentNodeId, 'c');
    });

    test('advanceToChoice 有安全上限（next 成环不死循环）', () => {
      const g = new DialogueGraph<S>();
      g.node('a', { text: 'x', next: 'b' });
      g.node('b', { text: 'y', next: 'a' }); // 环
      const r = g.start('a', { gold: 0, hasQuest: false, talked: 0 });
      r.advanceToChoice(20); // 应该在 20 步内停下
      eq(r.isDone, false, '没完成但也没死循环');
    });

    test('jumpTo 强制跳转（任务系统插入对话）', () => {
      const r = make().start('start', { gold: 150, hasQuest: false, talked: 0 });
      eq(r.jumpTo('smalltalk'), true);
      eq(r.currentNodeId, 'smalltalk');
    });

    test('end 强制结束', () => {
      const r = make().start('start', { gold: 150, hasQuest: false, talked: 0 });
      r.end();
      eq(r.isDone, true);
    });

    test('history 记录走过的路径', () => {
      const r = make().start('start', { gold: 150, hasQuest: false, talked: 0 });
      r.choose(1);
      r.advance();
      assert(r.history.length >= 3);
      eq(r.history[0], 'start');
    });

    test('重复注册节点抛错', () => {
      const g = new DialogueGraph<S>();
      g.node('a', { text: 'x' });
      throws(() => g.node('a', { text: 'y' }));
    });

    test('起始节点不存在抛错', () => {
      const g = new DialogueGraph<S>();
      g.node('a', { text: 'x' });
      throws(() => g.start('nope', { gold: 0, hasQuest: false, talked: 0 }));
    });
  });

  // ============================================================
  // Expression
  // ============================================================

  describe('Expression · 表达式求值', () => {
    test('四则运算', () => {
      near(new Expression('1 + 2').evaluate(), 3);
      near(new Expression('10 - 3').evaluate(), 7);
      near(new Expression('6 * 7').evaluate(), 42);
      near(new Expression('10 / 4').evaluate(), 2.5);
      near(new Expression('10 % 3').evaluate(), 1);
    });

    test('优先级（先乘除后加减）', () => {
      near(new Expression('2 + 3 * 4').evaluate(), 14);
      near(new Expression('(2 + 3) * 4').evaluate(), 20);
    });

    test('幂运算右结合', () => {
      near(new Expression('2 ^ 3').evaluate(), 8);
      // 2^3^2 = 2^(3^2) = 512（右结合）
      near(new Expression('2 ^ 3 ^ 2').evaluate(), 512);
    });

    test('一元负号', () => {
      near(new Expression('-5').evaluate(), -5);
      near(new Expression('3 + -2').evaluate(), 1);
      near(new Expression('-(2 + 3)').evaluate(), -5);
    });

    test('变量代入', () => {
      const e = new Expression('100 + level * 15');
      near(e.evaluate({ level: 10 }), 250);
      near(e.evaluate({ level: 1 }), 115);
    });

    test('点号路径', () => {
      const e = new Expression('player.atk * (1 + buff.str)');
      near(e.evaluate({ player: { atk: 50 }, buff: { str: 0.3 } }), 65);
    });

    test('未定义变量当作 0（不崩溃）', () => {
      near(new Expression('10 + missing').evaluate({}), 10);
    });

    test('evaluateStrict 对未定义变量抛错', () => {
      const e = new Expression('10 + missing');
      throws(() => e.evaluateStrict({}));
    });

    test('比较运算', () => {
      near(new Expression('5 > 3').evaluate(), 1);
      near(new Expression('5 < 3').evaluate(), 0);
      near(new Expression('5 >= 5').evaluate(), 1);
      near(new Expression('5 == 5').evaluate(), 1);
      near(new Expression('5 != 5').evaluate(), 0);
    });

    test('逻辑运算', () => {
      near(new Expression('1 && 1').evaluate(), 1);
      near(new Expression('1 && 0').evaluate(), 0);
      near(new Expression('0 || 1').evaluate(), 1);
      near(new Expression('!0').evaluate(), 1);
      near(new Expression('!5').evaluate(), 0);
    });

    test('三元表达式', () => {
      const e = new Expression('level > 5 ? 100 : 10');
      near(e.evaluate({ level: 10 }), 100);
      near(e.evaluate({ level: 1 }), 10);
    });

    test('内置函数', () => {
      near(new Expression('min(3, 5)').evaluate(), 3);
      near(new Expression('max(3, 5)').evaluate(), 5);
      near(new Expression('abs(-7)').evaluate(), 7);
      near(new Expression('floor(3.7)').evaluate(), 3);
      near(new Expression('ceil(3.2)').evaluate(), 4);
      near(new Expression('round(3.5)').evaluate(), 4);
      near(new Expression('sqrt(16)').evaluate(), 4);
      near(new Expression('clamp(15, 0, 10)').evaluate(), 10);
      near(new Expression('lerp(0, 10, 0.5)').evaluate(), 5);
      near(new Expression('pct(200, 25)').evaluate(), 50);
    });

    test('嵌套函数调用', () => {
      near(new Expression('max(min(10, 20), 5)').evaluate(), 10);
    });

    test('除零返回 0 而不是 NaN（NaN 会沿管线传播）', () => {
      near(new Expression('10 / 0').evaluate(), 0);
      near(new Expression('10 % 0').evaluate(), 0);
    });

    test('variables 列出用到的变量（检查配置拼写）', () => {
      const e = new Expression('base + level * mult + player.atk');
      const vars = e.variables().sort();
      eq(vars.join(','), 'base,level,mult,player.atk');
    });

    test('语法错误在构造时抛出', () => {
      throws(() => new Expression('1 +'));
      throws(() => new Expression('(1 + 2'));
      throws(() => new Expression(''));
      throws(() => new Expression('1 @ 2'));
      throws(() => new Expression('1 + 2)'));
    });

    test('未知函数报错并列出可用的', () => {
      let msg = '';
      try {
        new Expression('foo(1)').evaluate();
      } catch (e) {
        msg = e instanceof Error ? e.message : '';
      }
      assert(msg.includes('foo'), msg);
      assert(msg.includes('min'), `应列出可用函数，实际：${msg}`);
    });

    test('编译一次多次求值（性能）', () => {
      const e = new Expression('100 + level * 15');
      const results: number[] = [];
      for (let level = 1; level <= 10; level++) results.push(e.evaluate({ level }));
      eq(results[0], 115);
      eq(results[9], 250);
    });

    test('小数', () => {
      near(new Expression('0.1 + 0.2').evaluate(), 0.3, 1e-9);
      near(new Expression('.5 * 4').evaluate(), 2);
    });

    test('实际配置场景：分层难度公式', () => {
      const e = new Expression('base * (1 + floor * 0.15)');
      near(e.evaluate({ base: 100, floor: 0 }), 100);
      near(e.evaluate({ base: 100, floor: 10 }), 250);
    });
  });

  // ============================================================
  // Snapshot
  // ============================================================

  describe('Snapshot · 快照与差异', () => {
    test('deepClone 深拷贝', () => {
      const src = { a: 1, b: { c: 2, d: [1, 2, 3] } };
      const copy = deepClone(src);
      eq(copy.a, 1);
      copy.b.c = 99;
      eq(src.b.c, 2, '原对象不应受影响');
    });

    test('deepClone 处理循环引用（JSON.parse 会崩）', () => {
      const src: Record<string, unknown> = { name: 'root' };
      src.self = src;
      const copy = deepClone(src) as Record<string, unknown>;
      eq(copy.name, 'root');
      eq(copy.self, copy, '循环引用应保持结构');
    });

    test('deepClone 保留 Date', () => {
      const d = new Date(1000);
      const copy = deepClone({ d });
      eq(copy.d.getTime(), 1000);
      assert(copy.d instanceof Date, '应还是 Date 而不是字符串');
    });

    test('deepClone 处理 Map 和 Set', () => {
      const src = { m: new Map([['a', 1]]), s: new Set([1, 2]) };
      const copy = deepClone(src);
      eq(copy.m.get('a'), 1);
      eq(copy.s.has(2), true);
    });

    test('diffSnapshots 检测值变化', () => {
      const d = diffSnapshots({ hp: 100, mp: 50 }, { hp: 80, mp: 50 });
      eq(d.changed.length, 1);
      eq(d.changed[0].path, 'hp');
      eq(d.changed[0].from, 100);
      eq(d.changed[0].to, 80);
    });

    test('diffSnapshots 检测新增和移除', () => {
      const d = diffSnapshots({ a: 1 }, { a: 1, b: 2 });
      eq(d.added.length, 1);
      eq(d.added[0].path, 'b');

      const d2 = diffSnapshots({ a: 1, b: 2 }, { a: 1 });
      eq(d2.removed.length, 1);
      eq(d2.removed[0].path, 'b');
    });

    test('diffSnapshots 递归到嵌套', () => {
      const d = diffSnapshots(
        { player: { hp: 100, mp: 50 } },
        { player: { hp: 80, mp: 50 } }
      );
      eq(d.changed[0].path, 'player.hp');
    });

    test('diffSnapshots 处理数组变化', () => {
      const d = diffSnapshots({ items: [1, 2, 3] }, { items: [1, 9, 3] });
      eq(d.changed[0].path, 'items[1]');
    });

    test('diffSnapshots 数组增删', () => {
      const d = diffSnapshots({ items: [1, 2] }, { items: [1, 2, 3] });
      eq(d.added.length, 1);
      eq(d.added[0].path, 'items[2]');
    });

    test('无变化 hasChanges 为 false', () => {
      const d = diffSnapshots({ a: 1 }, { a: 1 });
      eq(d.hasChanges, false);
    });

    test('maxDepth 限制递归深度', () => {
      const deep = { a: { b: { c: { d: 1 } } } };
      const deep2 = { a: { b: { c: { d: 2 } } } };
      // 深度 2：a.b 之后整体算一个变化
      const d = diffSnapshots(deep, deep2, 2);
      assert(d.changed[0].path.length <= 'a.b.c'.length, `路径应被截断：${d.changed[0].path}`);
    });

    test('createPatch / applyPatch 往返', () => {
      const before = { hp: 100, items: [1, 2, 3], name: 'x' };
      const after = { hp: 80, items: [1, 2, 3], name: 'x' };

      const patch = createPatch(before, after);
      const restored = applyPatch(before, patch);
      eq(restored.hp, 80);
      eq(restored.name, 'x');
      eq(restored.items.join(','), '1,2,3');
    });

    test('applyPatch 不修改原对象', () => {
      const before = { hp: 100 };
      const patch = createPatch(before, { hp: 50 });
      applyPatch(before, patch);
      eq(before.hp, 100, '原对象不应被改动');
    });

    test('applyPatch 处理新增的嵌套路径', () => {
      const base = { a: {} };
      const patch: { set: Record<string, unknown>; remove: readonly string[] } = {
        set: { 'a.b.c': 42 },
        remove: [],
      };
      const out = applyPatch(base, patch) as { a: { b: { c: number } } };
      eq(out.a.b.c, 42);
    });

    test('applyPatch 处理删除', () => {
      const base = { a: 1, b: 2 };
      const patch: { set: Record<string, unknown>; remove: readonly string[] } = {
        set: {},
        remove: ['b'],
      };
      const out = applyPatch(base, patch) as Record<string, unknown>;
      eq(out.a, 1);
      eq('b' in out, false);
    });

    test('applyPatch 处理数组下标', () => {
      const base = { items: [1, 2, 3] };
      const patch: { set: Record<string, unknown>; remove: readonly string[] } = {
        set: { 'items[1]': 99 },
        remove: [],
      };
      const out = applyPatch(base, patch) as { items: number[] };
      eq(out.items.join(','), '1,99,3');
    });

    test('UndoStack 撤销重做', () => {
      const undo = new UndoStack<{ hp: number }>();

      // push 记录的是"可以回到这个状态"，应在**改动之前**调用
      let state = { hp: 100 };
      undo.push(state);      // 记录 100

      state = { hp: 80 };    // 改动
      undo.push(state);      // 记录 80

      state = { hp: 60 };    // 再改动

      const back = undo.undo(state);   // 从 60 回到 80
      eq(back?.hp, 80);

      const back2 = undo.undo({ hp: 80 });  // 从 80 回到 100
      eq(back2?.hp, 100);

      eq(undo.canUndo, false, '栈已空');
      eq(undo.canRedo, true);

      const fwd = undo.redo({ hp: 100 });
      eq(fwd?.hp, 80);
    });

    test('UndoStack 撤销后新操作会清空 redo', () => {
      const undo = new UndoStack<{ v: number }>();
      undo.push({ v: 1 });
      undo.push({ v: 2 });
      undo.undo({ v: 2 });
      eq(undo.canRedo, true);

      undo.push({ v: 3 }); // 新操作
      eq(undo.canRedo, false, 'redo 栈应被清空');
    });

    test('UndoStack 空栈返回 undefined', () => {
      const undo = new UndoStack<number>();
      eq(undo.undo(1), undefined);
      eq(undo.redo(1), undefined);
    });

    test('UndoStack limit 限制步数', () => {
      const undo = new UndoStack<number>({ limit: 3 });
      for (let i = 0; i < 10; i++) undo.push(i);
      eq(undo.undoDepth, 3);
    });

    test('快照是深拷贝（改原对象不影响快照）', () => {
      const undo = new UndoStack<{ list: number[] }>();
      const state = { list: [1, 2, 3] };
      undo.push(state);
      state.list.push(4);
      const back = undo.undo(state);
      eq(back?.list.length, 3, '快照应记录当时的状态');
    });
  });

  // ============================================================
  // Replay
  // ============================================================

  describe('ReplayRecorder · 输入录制与回放', () => {
    test('录制与回放一致', () => {
      const rec = new ReplayRecorder({ seed: 12345 });
      rec.start();

      const recorded: Array<Record<string, number>> = [];
      for (let f = 0; f < 10; f++) {
        const input = { x: f % 3, btn: f === 5 ? 1 : 0 };
        recorded.push(input);
        rec.record(f, input);
      }
      const data = rec.export();

      const player = new ReplayRecorder({ seed: 12345 });
      player.load(data);
      for (let f = 0; f < 10; f++) {
        const input = player.playback(f);
        assert(input !== undefined, `第 ${f} 帧应有输入`);
        eq(input!.x, recorded[f].x);
        eq(input!.btn, recorded[f].btn);
      }
    });

    test('deltaOnly 只在输入变化时记录（体积小）', () => {
      const rec = new ReplayRecorder({ seed: 1 });
      rec.start();
      // 按住不动 100 帧
      for (let f = 0; f < 100; f++) rec.record(f, { x: 1 });
      const data = rec.export();
      eq(data.keyframes.length, 1, '只有第一次算变化');
      eq(data.frameCount, 100, '但总帧数要记全');
    });

    test('deltaOnly 关闭时每帧记录', () => {
      const rec = new ReplayRecorder({ seed: 1, deltaOnly: false });
      rec.start();
      for (let f = 0; f < 10; f++) rec.record(f, { x: 1 });
      eq(rec.keyframeCount, 10);
    });

    test('版本不匹配报错（而不是静默播错）', () => {
      const rec = new ReplayRecorder({ seed: 1, version: 2 });
      rec.start();
      rec.record(0, { x: 1 });
      const data = rec.export();

      const player = new ReplayRecorder({ seed: 1, version: 1 });
      throws(() => player.load(data));
    });

    test('种子不匹配报错（回放会漂移）', () => {
      const rec = new ReplayRecorder({ seed: 111 });
      rec.start();
      rec.record(0, { x: 1 });
      const data = rec.export();

      const player = new ReplayRecorder({ seed: 222 });
      let msg = '';
      try {
        player.load(data);
      } catch (e) {
        msg = e instanceof Error ? e.message : '';
      }
      assert(msg.includes('种子'), msg);
    });

    test('回放超出范围返回 undefined（主循环用 ?? 接真实输入）', () => {
      const rec = new ReplayRecorder({ seed: 1 });
      rec.start();
      rec.record(0, { x: 1 });
      const data = rec.export();

      const player = new ReplayRecorder({ seed: 1 });
      player.load(data);
      eq(player.playback(0)?.x, 1);
      eq(player.playback(999), undefined, '超出范围');
    });

    test('第一个关键帧之前返回空输入，之后持续有效', () => {
      const rec = new ReplayRecorder({ seed: 1 });
      rec.start();
      // 前 5 帧无输入，第 5 帧起按住 x=1
      for (let f = 0; f < 10; f++) {
        rec.record(f, f >= 5 ? { x: 1 } : {});
      }
      const data = rec.export();
      /**
       * 只有 1 个关键帧：初始状态就是空输入，前 5 帧与它相同，不算变化。
       * 这正是 deltaOnly 省体积的地方——"没操作"不占任何字节。
       */
      eq(data.keyframes.length, 1, '只有第 5 帧那一次变化');
      eq(data.keyframes[0].frame, 5);

      const player = new ReplayRecorder({ seed: 1 });
      player.load(data);
      eq(player.playback(0)?.x, undefined, '前 5 帧没输入');
      eq(player.playback(4)?.x, undefined);
      eq(player.playback(5)?.x, 1, '第 5 帧开始按下');
      eq(player.playback(9)?.x, 1, '按住状态持续有效（deltaOnly 的语义）');
    });

    test('playbackDone 标记结束', () => {
      const rec = new ReplayRecorder({ seed: 1 });
      rec.start();
      for (let f = 0; f < 10; f++) rec.record(f, { x: f });
      const data = rec.export();

      const player = new ReplayRecorder({ seed: 1 });
      player.load(data);
      eq(player.playbackDone, false);
      player.playback(9);
      eq(player.playbackDone, true);
    });

    test('录制中调用 playback 返回 undefined（用真实输入）', () => {
      const rec = new ReplayRecorder({ seed: 1 });
      rec.start();
      rec.record(0, { x: 1 });
      eq(rec.playback(0), undefined, '录制时应走真实输入');
    });

    test('seek 跳转', () => {
      const rec = new ReplayRecorder({ seed: 1 });
      rec.start();
      for (let f = 0; f < 100; f++) rec.record(f, { x: f % 4 });
      const data = rec.export();

      const player = new ReplayRecorder({ seed: 1 });
      player.load(data);
      player.seek(50);
      eq(player.frame, 50);
      // seek 后取输入应对应第 50 帧附近
      assert(player.playback(50) !== undefined);
    });

    test('estimateSize 估算体积', () => {
      const rec = new ReplayRecorder({ seed: 1 });
      rec.start();
      for (let f = 0; f < 1000; f++) rec.record(f, { x: f % 4 });
      assert(rec.estimateSize() > 0);
    });

    test('maxFrames 上限防止撑爆内存', () => {
      const origWarn = console.warn;
      console.warn = () => {};
      const rec = new ReplayRecorder({ seed: 1, maxFrames: 10 });
      rec.start();
      for (let f = 0; f < 100; f++) rec.record(f, { x: f });
      console.warn = origWarn;
      assert(rec.keyframeCount <= 10, `应被截断，实际 ${rec.keyframeCount}`);
    });

    test('导出的数据可 JSON 序列化（能存盘/分享）', () => {
      const rec = new ReplayRecorder({ seed: 7 });
      rec.start();
      rec.record(0, { x: 1 });
      const json = rec.exportJSON({ character: 'warrior' });
      const parsed = JSON.parse(json);
      eq(parsed.seed, 7);
      eq(parsed.meta.character, 'warrior');
    });
  });

  // ============================================================
  // I18N
  // ============================================================

  describe('I18N · 本地化', () => {
    function make(): I18N {
      const i18n = new I18N({ fallback: 'zh-CN' });
      i18n.addLocale('zh-CN', {
        'ui.start': '开始游戏',
        'item.count': '{n} 个',
        'msg.kill': '你击败了 {name}，获得 {exp} 经验',
        'only.zh': '只有中文有',
      });
      i18n.addLocale('en-US', {
        'ui.start': 'Start Game',
        'item.count_one': '{n} item',
        'item.count_other': '{n} items',
        'msg.kill': 'You defeated {name} and gained {exp} EXP',
      });
      return i18n;
    }

    test('基本翻译', () => {
      const i18n = make();
      i18n.setLocale('en-US');
      eq(i18n.t('ui.start'), 'Start Game');
      i18n.setLocale('zh-CN');
      eq(i18n.t('ui.start'), '开始游戏');
    });

    test('插值', () => {
      const i18n = make();
      eq(i18n.t('msg.kill', { name: '骷髅兵', exp: 120 }), '你击败了 骷髅兵，获得 120 经验');
    });

    test('英文复数（n=1 用单数形式）', () => {
      const i18n = make();
      i18n.setLocale('en-US');
      eq(i18n.t('item.count', { n: 1 }), '1 item');
      eq(i18n.t('item.count', { n: 5 }), '5 items');
    });

    test('中文无复数变化（不写 _plural 也能用）', () => {
      const i18n = make();
      eq(i18n.t('item.count', { n: 1 }), '1 个');
      eq(i18n.t('item.count', { n: 5 }), '5 个');
    });

    test('缺翻译回退到 fallback 语言', () => {
      const i18n = make();
      i18n.setLocale('en-US');
      eq(i18n.t('only.zh'), '只有中文有', '英文没有这条，应回退到中文');
    });

    test('完全缺失时回退到 key（不是空白）', () => {
      const i18n = make();
      eq(i18n.t('完全不存在的key'), '完全不存在的key');
    });

    test('缺失的 key 被统计（用于检查覆盖率）', () => {
      const i18n = make();
      i18n.t('missing.a');
      i18n.t('missing.b');
      eq(i18n.missingKeys.length, 2);
    });

    test('点号路径插值', () => {
      const i18n = new I18N({ fallback: 'zh-CN' });
      i18n.addLocale('zh-CN', { greet: '你好，{player.name}！' });
      eq(i18n.t('greet', { player: { name: '小明' } }), '你好，小明！');
    });

    test('插值变量缺失时保留占位符（而不是变成 undefined）', () => {
      const i18n = make();
      const s = i18n.t('msg.kill', { name: 'X' }); // 缺 exp
      assert(!s.includes('undefined'), s);
    });

    test('切换语言触发 onChange', () => {
      const i18n = make();
      const changes: string[] = [];
      i18n.onChange((l) => changes.push(l));
      i18n.setLocale('en-US');
      i18n.setLocale('zh-CN');
      eq(changes.join(','), 'en-US,zh-CN');
    });

    test('切换到不存在的语言时保持原样', () => {
      const i18n = make();
      i18n.setLocale('en-US');
      eq(i18n.setLocale('不存在的语言'), false);
      eq(i18n.locale, 'en-US');
    });

    test('coverage 检查翻译覆盖率', () => {
      const i18n = make();
      const cov = i18n.coverage('en-US');
      eq(cov.total, 4);
      // item.count 在英文里以 count_one / count_other 的形式存在，应算已翻译
      eq(cov.translated, 3, '只有 only.zh 没翻译');
      eq(cov.missing.join(','), 'only.zh');
    });

    test('热重载语言包', () => {
      const i18n = make();
      i18n.setLocaleTable('zh-CN', { 'ui.start': '新的开始文本' });
      eq(i18n.t('ui.start'), '新的开始文本');
    });

    test('addLocale 合并而不是替换', () => {
      const i18n = new I18N({ fallback: 'zh-CN' });
      i18n.addLocale('zh-CN', { a: '1' });
      i18n.addLocale('zh-CN', { b: '2' });
      eq(i18n.t('a'), '1');
      eq(i18n.t('b'), '2');
    });

    test('has 检查是否存在翻译', () => {
      const i18n = make();
      eq(i18n.has('ui.start'), true);
      eq(i18n.has('nope'), false);
    });
  });
}
