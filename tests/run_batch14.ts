/**
 * tests/run_batch14.ts —— 第十三批测试：GameFlow 孤儿插件收尾
 *
 * 【为什么单独开一批给一个模块】
 *
 * `gameflow/` 有 321 行实现，但零测试、零 README、零登记——
 * 它是上一轮我自己写的，测试文件被覆盖时连同测试一起消失了。
 *
 * 这已经是第四次发现这类"孤儿插件"了：
 *
 * | 批次 | 发现的孤儿 |
 * |---|---|
 * | 十一 | skill-variant / blessing / curse / interact / score |
 * | 十二 | timeutil |
 * | 十三 | **gameflow** |
 *
 * 教训重复三遍就不再是巧合，而是流程问题：
 *
 * > **写完代码必须同时做三件事，缺一件就等于没写完：**
 * > ① 测试 ② README ③ 登记进 `_kitmeta.json`
 *
 * 所以本批补上 gameflow 的这三件，并把它写进文档作为自查清单。
 */

import { test, describe, assert, eq, near, throws } from './_framework';
import {
  GameFlow,
  type FlowStateDef,
} from '../gameflow/GameFlow';

// ============================================================
// 一个典型的游戏流程：
//   boot → menu → playing ⇄ paused → result → menu
// ============================================================

interface Ctx {
  saveLoaded: boolean;
  log: string[];
}

function makeCtx(saveLoaded = true): Ctx {
  return { saveLoaded, log: [] };
}

function build(ctx: Ctx) {
  const defs: FlowStateDef<Ctx>[] = [
    {
      id: 'boot',
      enter: (c) => c.log.push('enter:boot'),
      exit: (c) => c.log.push('exit:boot'),
      transitions: [{ to: 'menu', when: (c) => c.saveLoaded }],
    },
    {
      id: 'menu',
      enter: (c) => c.log.push('enter:menu'),
      exit: (c) => c.log.push('exit:menu'),
      transitions: [{ to: 'playing', when: () => true }],
    },
    {
      id: 'playing',
      enter: (c) => c.log.push('enter:playing'),
      exit: (c) => c.log.push('exit:playing'),
      transitions: [
        { to: 'paused', when: () => true },
        { to: 'result', when: () => true },
      ],
    },
    {
      id: 'paused',
      enter: (c) => c.log.push('enter:paused'),
      exit: (c) => c.log.push('exit:paused'),
      transitions: [{ to: 'playing', when: () => true }],
    },
    {
      id: 'result',
      enter: (c) => c.log.push('enter:result'),
      exit: (c) => c.log.push('exit:result'),
      transitions: [{ to: 'menu', when: () => true }],
    },
  ];

  return new GameFlow<Ctx>({ defs, initial: 'boot', context: ctx });
}

export async function runBatch14Tests(): Promise<void> {
  describe('GameFlow · 流程状态机（孤儿插件收尾）', () => {
    // ============================================================

    test('初始状态', () => {
      const flow = build(makeCtx());
      eq(flow.current, 'boot');
    });

    test('⚠️ 进入初始状态会触发 enter', () => {
      /**
       * 如果不触发，boot 里的资源加载逻辑永远不执行。
       * 这类 bug 表现为"第一次进游戏黑屏，第二次就好了"。
       */
      const ctx = makeCtx();
      build(ctx);
      eq(ctx.log.join(','), 'enter:boot');
    });

    test('goTo 触发 exit/enter 且顺序正确', () => {
      const ctx = makeCtx();
      const flow = build(ctx);
      flow.goTo('menu');
      eq(flow.current, 'menu');
      eq(ctx.log.join(','), 'enter:boot,exit:boot,enter:menu');
    });

    test('⚠️ 非法转换被拒绝（状态不变）', () => {
      const ctx = makeCtx();
      const flow = build(ctx);
      const ok = flow.goTo('playing');   // boot 只能去 menu
      eq(ok, false);
      eq(flow.current, 'boot', '失败时状态不该改变');
      eq(ctx.log.join(','), 'enter:boot', '也不该触发任何回调');
    });

    test('⚠️ when 条件不满足时拒绝', () => {
      const flow = build(makeCtx(false));   // saveLoaded = false
      eq(flow.goTo('menu'), false, '条件不满足应拒绝');
    });

    test('when 条件满足时允许', () => {
      const flow = build(makeCtx(true));
      eq(flow.goTo('menu'), true);
    });

    test('canGoTo 只查询不改变状态', () => {
      const ctx = makeCtx();
      const flow = build(ctx);
      eq(flow.canGoTo('menu'), true);
      eq(flow.current, 'boot');
      eq(ctx.log.join(','), 'enter:boot', '查询不该触发回调');
    });

    test('availableTargets 只列当前可去的', () => {
      const flow = build(makeCtx());
      flow.goTo('menu');
      eq(flow.availableTargets().join(','), 'playing');
      flow.goTo('playing');
      eq(flow.availableTargets().sort().join(','), 'paused,result');
    });

    test('⚠️ force 无视转换表', () => {
      const flow = build(makeCtx(false));
      eq(flow.goTo('result', { force: true }), true);
      eq(flow.current, 'result');
    });

    test('force 便捷方法', () => {
      const flow = build(makeCtx());
      flow.force('result');
      eq(flow.current, 'result');
    });

    test('⚠️ 转换到自身默认无操作', () => {
      const ctx = makeCtx();
      const flow = build(ctx);
      eq(flow.goTo('boot'), false, '相同状态默认不重入');
      eq(ctx.log.join(','), 'enter:boot', '不该触发 exit/enter');
    });

    test('⚠️ allowSelf 时重入', () => {
      const ctx = makeCtx();
      const flow = build(ctx);
      flow.goTo('boot', { force: true, allowSelf: true });
      eq(ctx.log.join(','), 'enter:boot,exit:boot,enter:boot');
    });

    test('onChange 回调带 from/to', () => {
      const seen: string[] = [];
      const ctx = makeCtx();
      const flow = new GameFlow<Ctx>({
        defs: build(makeCtx()).states,
        initial: 'boot',
        context: ctx,
        onChange: (from, to) => seen.push(`${from}->${to}`),
      });
      flow.goTo('menu');
      eq(seen.join(','), 'boot->menu');
    });

    test('⚠️ 转换过程中的嵌套切换被拒绝', () => {
      /**
       * 在 enter 回调里立刻 goTo 会造成状态错乱
       * （exit/enter 顺序颠倒，状态机自己都不知道在哪）。
       * 直接拒绝比留下错乱状态好。
       */
      let inner = false;
      const ctx = makeCtx();
      const flow = new GameFlow<Ctx>({
        defs: [
          { id: 'a', transitions: [{ to: 'b', when: () => true }] },
          {
            id: 'b',
            enter: () => { inner = flowRef.goTo('a'); },
            transitions: [],
          },
        ],
        initial: 'a',
        context: ctx,
      });
      const flowRef = flow;
      flow.goTo('b');
      eq(inner, false, '转换中的嵌套切换应被拒绝');
      eq(flow.current, 'b', '状态应正确落在新状态');
    });

    // ---------- 历史 ----------

    test('history 记录轨迹', () => {
      const flow = build(makeCtx());
      flow.goTo('menu');
      flow.goTo('playing');
      flow.goTo('result');
      eq(flow.history.join('>'), 'boot>menu>playing>result');
    });

    test('⚠️ history 有上限（防内存增长）', () => {
      const ctx = makeCtx();
      const flow = new GameFlow<Ctx>({
        defs: [
          { id: 'a', transitions: [{ to: 'b', when: () => true }] },
          { id: 'b', transitions: [{ to: 'a', when: () => true }] },
        ],
        initial: 'a',
        context: ctx,
        historyLimit: 3,
      });
      flow.goTo('b');
      flow.goTo('a');
      flow.goTo('b');
      flow.goTo('a');
      assert(flow.history.length <= 3, `应被裁剪，实际 ${flow.history.length}`);
      eq(flow.history[0], 'a', '初始状态应保留');
    });

    test('back 回到上一个状态', () => {
      /**
       * 【修正过的测试】
       * 原写法从 playing back 到 menu，
       * 但 playing 的转换表只有 paused / result——
       * back **也走转换检查**，所以正确地拒绝了。
       * （"back 也检查转换合法性"那条正是验证这件事。）
       *
       * 用 paused → playing 才是合法的回退路径。
       */
      const flow = build(makeCtx());
      flow.goTo('menu');
      flow.goTo('playing');
      flow.goTo('paused');
      eq(flow.back(), true, 'paused → playing 是转换表里允许的');
      eq(flow.current, 'playing');
    });

    test('⚠️ back 在起点返回 false', () => {
      const flow = build(makeCtx());
      eq(flow.back(), false, '没有上一个状态');
    });

    test('⚠️ back 也检查转换合法性', () => {
      const flow = build(makeCtx());
      flow.goTo('menu');
      flow.force('playing');
      flow.force('result');   // result 只能回 menu
      eq(flow.back(), false, '回不去就不该回去');
      eq(flow.current, 'result');
    });

    test('reset 回到初始并清空历史', () => {
      const flow = build(makeCtx());
      flow.goTo('menu');
      flow.goTo('playing');
      flow.reset();
      eq(flow.current, 'boot');
      eq(flow.history.join('>'), 'boot');
    });

    // ---------- update 与 auto ----------

    test('⚠️ update 驱动 auto 转换', () => {
      const ctx = makeCtx();
      const flow = new GameFlow<Ctx>({
        defs: [
          { id: 'loading', transitions: [{ to: 'ready', when: () => true, auto: true }] },
          { id: 'ready', transitions: [] },
        ],
        initial: 'loading',
        context: ctx,
      });
      eq(flow.current, 'loading');
      flow.update();
      eq(flow.current, 'ready', 'auto 转换应在 update 时自动走');
    });

    test('⚠️ update 只走第一个满足的 auto', () => {
      const ctx = makeCtx();
      const flow = new GameFlow<Ctx>({
        defs: [
          {
            id: 's',
            transitions: [
              { to: 'x', when: () => true, auto: true },
              { to: 'y', when: () => true, auto: true },
            ],
          },
          { id: 'x', transitions: [] },
          { id: 'y', transitions: [] },
        ],
        initial: 's',
        context: ctx,
      });
      flow.update();
      eq(flow.current, 'x', '应按声明顺序取第一个');
    });

    test('⚠️ 非 auto 转换不会被 update 触发', () => {
      const flow = build(makeCtx());
      flow.update();
      eq(flow.current, 'boot', 'boot→menu 没标 auto，不该自动走');
    });

    test('update 调用当前状态的 update 回调', () => {
      const seen: number[] = [];
      const ctx = makeCtx();
      const flow = new GameFlow<Ctx>({
        defs: [
          { id: 'a', update: (_c, dt) => seen.push(dt) },
          { id: 'b', update: (_c, dt) => seen.push(dt * 100) },
        ] as FlowStateDef<Ctx>[],
        initial: 'a',
        context: ctx,
      });
      flow.update(16);
      flow.force('b');
      flow.update(16);
      eq(seen.join(','), '16,1600', '只有当前状态的 update 会被调用');
    });

    // ---------- timeInState ----------

    test('timeInState 累加', () => {
      const flow = build(makeCtx());
      flow.update(0);
      flow.update(500);
      near(flow.timeInState, 500, 1e-9);
    });

    test('⚠️ timeInState 在切换后归零', () => {
      /**
       * 【修正过的测试】
       * 原写法在 goTo 之后又 update(1000)，
       * 于是 timeInState 当然是 1000——断言打错了位置。
       * 要验证的是"切换的那一刻归零"，不是"切换后再累加"。
       */
      const flow = build(makeCtx());
      flow.update(1000);
      near(flow.timeInState, 1000, 1e-9, '切换前已停留 1000ms');

      flow.goTo('menu');
      near(flow.timeInState, 0, 1e-9, '刚进入新状态应从头计时');

      flow.update(250);
      near(flow.timeInState, 250, 1e-9, '之后正常累加');
    });

    test('⚠️ 负 dt 不让时间倒流', () => {
      const flow = build(makeCtx());
      flow.update(1000);
      flow.update(-5000);
      near(flow.timeInState, 1000, 1e-9);
    });

    test('⚠️ dt=0 不累加', () => {
      const flow = build(makeCtx());
      flow.update(0);
      flow.update(0);
      near(flow.timeInState, 0, 1e-9);
    });

    // ---------- 构造校验 ----------

    test('⚠️ 未知状态抛错', () => {
      const flow = build(makeCtx());
      throws(() => flow.force('不存在'), '未知');
    });

    test('⚠️ 初始状态必须存在', () => {
      throws(
        () => new GameFlow<Ctx>({
          defs: [{ id: 'a', transitions: [] }],
          initial: '不存在',
          context: makeCtx(),
        }),
        '初始状态'
      );
    });

    test('⚠️ 转换目标必须存在', () => {
      throws(
        () => new GameFlow<Ctx>({
          defs: [{ id: 'a', transitions: [{ to: '幽灵', when: () => true }] }],
          initial: 'a',
          context: makeCtx(),
        }),
        '不存在'
      );
    });

    test('⚠️ 状态 id 重复', () => {
      throws(
        () => new GameFlow<Ctx>({
          defs: [{ id: 'a', transitions: [] }, { id: 'a', transitions: [] }],
          initial: 'a',
          context: makeCtx(),
        }),
        '重复'
      );
    });

    test('⚠️ 未知状态抛错时列出可用状态（便于排查）', () => {
      const flow = build(makeCtx());
      let msg = '';
      try {
        flow.force('xxx');
      } catch (e) {
        msg = (e as Error).message;
      }
      assert(msg.includes('boot'), `错误信息应列出已定义状态，实际：${msg}`);
    });

    // ---------- 查询 ----------

    test('states 列出全部', () => {
      eq(build(makeCtx()).states.length, 5);
    });

    test('get 查询状态定义', () => {
      const flow = build(makeCtx());
      eq(flow.get('menu')?.id, 'menu');
      eq(flow.get('不存在'), undefined);
    });

    test('context 可访问', () => {
      const ctx = makeCtx();
      eq(build(ctx).context, ctx);
    });

    test('isTransitioning 平时为 false', () => {
      const flow = build(makeCtx());
      eq(flow.isTransitioning, false);
    });

    // ---------- 完整流程 ----------

    test('完整流程：boot → menu → playing ⇄ paused → result → menu', () => {
      const flow = build(makeCtx());
      flow.goTo('menu');
      flow.goTo('playing');
      flow.goTo('paused');
      flow.goTo('playing');
      flow.goTo('result');
      flow.goTo('menu');
      eq(flow.current, 'menu');
      eq(flow.history.join('>'), 'boot>menu>playing>paused>playing>result>menu');
    });

    test('⚠️ 结算界面不能直接回暂停（转换表挡住）', () => {
      /**
       * 这是手写状态机最典型的 bug：
       * 从暂停直接跳结算，忘了清理战斗数据，
       * 下一局开始时还带着暂停标记。
       */
      const flow = build(makeCtx());
      flow.goTo('menu');
      flow.goTo('playing');
      flow.goTo('paused');
      flow.force('result');
      eq(flow.goTo('paused'), false, 'result 只能回 menu');
      eq(flow.goTo('menu'), true);
    });

    test('空转换表的状态是终点', () => {
      const ctx = makeCtx();
      const flow = new GameFlow<Ctx>({
        defs: [{ id: 'end', transitions: [] }],
        initial: 'end',
        context: ctx,
      });
      eq(flow.canGoTo('end'), false);
      eq(flow.availableTargets().length, 0);
    });
  });
}
