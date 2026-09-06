/**
 * examples/batch14-usage.ts —— 第十三批插件：流程状态机 + 战斗评分
 *
 * | 模块 | 场景 |
 * |---|---|
 * | GameFlow | 启动→菜单→游戏中⇄暂停→结算 的整条链路 |
 * | ScoreSystem | 打完一局给评级（S/A/B/C/D） |
 * | StarRating | 休闲关卡的三星评价 |
 *
 * 【为什么这两个放一起】
 * 一局的生命周期是 GameFlow 管的，而"这局打得怎么样"是 ScoreSystem 管的。
 * 结算界面就是把两者接起来：从 playing 进 result，结算时问 ScoreSystem 要评级。
 */

import { GameFlow, type FlowStateDef } from '../gameflow/GameFlow';
import {
  ScoreSystem,
  StarRating,
  Metrics,
  DEFAULT_GRADES,
} from '../score/ScoreSystem';

function hr(t: string): void {
  console.log(`\n${'─'.repeat(52)}\n${t}\n${'─'.repeat(52)}`);
}

// ============================================================
// 游戏上下文：状态机的所有状态共享它
// ============================================================

interface GameCtx {
  saveLoaded: boolean;
  hp: number;
  kills: number;
  maxCombo: number;
  hitsTaken: number;
  /** 战斗数据是否已清理（演示"忘记清理"的坑） */
  battleCleaned: boolean;
  log: string[];
}

function makeCtx(saveLoaded = true): GameCtx {
  return {
    saveLoaded,
    hp: 100,
    kills: 0,
    maxCombo: 0,
    hitsTaken: 0,
    battleCleaned: true,
    log: [],
  };
}

function buildFlow(ctx: GameCtx): GameFlow<GameCtx> {
  const defs: FlowStateDef<GameCtx>[] = [
    {
      id: 'boot',
      desc: '加载存档',
      enter: (c) => c.log.push('boot: 开始读档'),
      // 只有读档成功才能进主菜单
      transitions: [{ to: 'menu', when: (c) => c.saveLoaded }],
    },
    {
      id: 'menu',
      desc: '主菜单',
      enter: (c) => c.log.push('menu: 显示主菜单'),
      exit: (c) => c.log.push('menu: 隐藏主菜单'),
      transitions: [{ to: 'playing', when: () => true }],
    },
    {
      id: 'playing',
      desc: '战斗中',
      enter: (c) => {
        // 新一局开始，重置战斗数据
        c.hp = 100;
        c.kills = 0;
        c.maxCombo = 0;
        c.hitsTaken = 0;
        c.battleCleaned = false;
        c.log.push('playing: 初始化战斗数据');
      },
      exit: (c) => {
        // ⚠️ 离开战斗必须清理，否则暂停→结算会带着脏数据
        c.battleCleaned = true;
        c.log.push('playing: 清理战斗数据');
      },
      update: (c, dt) => {
        /**
         * 只有当前状态的 update 会被调用——
         * 暂停时战斗逻辑不该继续跑。
         */
        void dt;
        c.kills += 0;
      },
      transitions: [
        { to: 'paused', when: () => true },
        { to: 'result', when: () => true },
      ],
    },
    {
      id: 'paused',
      desc: '暂停',
      enter: (c) => c.log.push('paused: 冻结时间'),
      exit: (c) => c.log.push('paused: 恢复时间'),
      transitions: [
        { to: 'playing', when: () => true },
        { to: 'menu', when: () => true, desc: '放弃本局' },
      ],
    },
    {
      id: 'result',
      desc: '结算',
      enter: (c) => c.log.push('result: 展示评级'),
      transitions: [{ to: 'menu', when: () => true }],
    },
  ];

  return new GameFlow<GameCtx>({ defs, initial: 'boot', context: ctx, historyLimit: 8 });
}

export function main(): void {
  // ============================================================
  hr('① GameFlow —— 状态机的价值在于"拒绝"');
  // ============================================================

  const ctx = makeCtx();

  // 转换表校验：写错状态名在构造时就炸，不会等到运行到那一步
  try {
    new GameFlow<GameCtx>({
      defs: [
        { id: 'a', transitions: [{ to: 'nope', when: () => true }] },
      ],
      initial: 'a',
      context: ctx,
    });
  } catch (e) {
    console.log(`  配置错误在构造时暴露：\n    ${(e as Error).message}`);
  }

  const flow = buildFlow(ctx);
  console.log(`\n  初始状态 = ${flow.current}`);
  console.log(`  可去：${JSON.stringify(flow.availableTargets())}`);

  // 非法转换被拒绝
  const illegal = flow.goTo('result');
  console.log(`  直接跳到结算 → ${illegal}（boot 只能去 menu）`);
  console.log(`  状态没变：${flow.current}`);

  // 合法路径
  flow.goTo('menu');
  flow.goTo('playing');
  flow.goTo('paused');
  flow.goTo('playing');
  console.log(`\n  走完 menu → playing → paused → playing：当前 ${flow.current}`);
  console.log(`  历史栈：${JSON.stringify(flow.history)}`);

  // 条件转换：存档没加载完就不能进主菜单
  const ctx2 = makeCtx(false);
  const flow2 = buildFlow(ctx2);
  console.log(`\n  存档未加载时 goTo('menu') → ${flow2.goTo('menu')}（when 条件不满足）`);

  // ============================================================
  hr('② 转换中的重入保护');
  // ============================================================

  const ctx3 = makeCtx();
  const seen: string[] = [];

  /**
   * 用一个可变的持有者绕开 TDZ：
   * 状态 b 的 enter 回调需要在 flow3 赋值完成后才拿得到它。
   */
  const holder: { flow: GameFlow<GameCtx> | null } = { flow: null };
  let reentryResult: boolean | null = null;

  const flow3 = new GameFlow<GameCtx>({
    defs: [
      {
        id: 'a',
        enter: () => seen.push('enter:a'),
        exit: () => seen.push('exit:a'),
        transitions: [{ to: 'b', when: () => true }],
      },
      {
        id: 'b',
        // 在 enter 里又调 goTo —— 这是个典型的坑
        enter: () => {
          seen.push('enter:b');
          if (reentryResult === null && holder.flow) {
            reentryResult = holder.flow.goTo('a');
          }
        },
        transitions: [{ to: 'a', when: () => true }],
      },
    ],
    initial: 'a',
    context: ctx3,
  });
  holder.flow = flow3;

  flow3.goTo('b');
  console.log(`  回调顺序：${seen.join(' → ')}`);
  console.log(`  b 的 enter 里再调 goTo('a') → ${reentryResult}（转换中被拒绝）`);
  console.log(`  最终状态：${flow3.current}（停在 b，没被自己踢回去）`);
  console.log('  若不加保护，顺序会变成 a.exit → b.enter → b.exit → a.enter，');
  console.log('  状态机自己都不知道自己在哪。');

  // ============================================================
  hr('③ back() 也走转换表');
  // ============================================================

  const ctx4 = makeCtx();
  const flow4 = buildFlow(ctx4);
  flow4.goTo('menu');
  flow4.goTo('playing');
  flow4.goTo('paused');
  console.log(`  paused.back() → ${flow4.back()}，当前 ${flow4.current}`);
  flow4.goTo('playing');
  flow4.goTo('paused');
  flow4.goTo('menu');       // 放弃本局
  console.log(`  paused → menu（放弃本局）→ 当前 ${flow4.current}`);
  console.log(`  ⚠️ 战斗数据已清理：${ctx4.battleCleaned}`);

  // ============================================================
  hr('④ timeInState —— 自动转换与停留时长');
  // ============================================================

  const ctx5 = makeCtx(true);
  let elapsed = 0;
  const flow5 = new GameFlow<GameCtx>({
    defs: [
      {
        id: 'loading',
        update: () => { elapsed += 100; },
        // 加载完成就自动进主菜单
        transitions: [{ to: 'ready', when: () => elapsed >= 500, auto: true }],
      },
      { id: 'ready', transitions: [] },
    ],
    initial: 'loading',
    context: ctx5,
  });

  for (let i = 0; i < 4; i++) flow5.update(100);
  console.log(`  加载中，停留 ${flow5.timeInState}ms，状态 ${flow5.current}`);
  flow5.update(100);
  console.log(`  再过一帧 → ${flow5.current}（auto 转换触发）`);
  console.log(`  切换后 timeInState 归零：${flow5.timeInState}`);

  const ctx6 = makeCtx();
  const flow6 = buildFlow(ctx6);
  flow6.update(1000);
  flow6.update(-5000);       // 切后台回来可能给负 dt
  console.log(`\n  传入负 dt 后 timeInState = ${flow6.timeInState}（不倒流）`);

  // ============================================================
  hr('⑤ ScoreSystem —— 打完一局给个说法');
  // ============================================================

  function playthrough(name: string, run: (s: ScoreSystem) => void): void {
    const sys = new ScoreSystem({
      metrics: [
        Metrics.time(120, 300, 1),      // 目标 2 分钟，超过 5 分钟 0 分
        Metrics.damage(5, 1.5),         // 无伤满分，挨 5 次打 0 分
        Metrics.combo(30, 1),           // 30 连击满分
        Metrics.kills(50, 0.5),         // 击杀数（权重低，不鼓励刷怪）
      ],
      grades: DEFAULT_GRADES,
    });
    sys.startTimer();
    run(sys);
    const r = sys.settle();
    const bar = '█'.repeat(Math.round(r.score / 5));
    console.log(`\n  【${name}】总分 ${r.score.toFixed(1)} → 评级 ${r.grade.id} (${r.grade.name ?? ''})`);
    console.log(`    ${bar}`);
    for (const m of r.breakdown) {
      const mark = m.score >= 80 ? '✓' : m.score >= 40 ? '·' : '✗';
      console.log(`      ${mark} ${m.id.padEnd(8)} 原始 ${String(m.raw).padStart(4)}  得分 ${m.score.toFixed(1).padStart(5)}  权重 ${m.weight}`);
    }
    const next = sys.toNextGrade();
    if (next) {
      console.log(`      距 ${next.next.id} 还差 ${next.need.toFixed(1)} 分`);
    }
  }

  playthrough('速通流：快但有伤', (s) => {
    s.set('time', 95);
    s.set('damage', 4);
    s.set('combo', 12);
    s.set('kills', 20);
  });

  playthrough('稳妥流：慢但无伤', (s) => {
    s.set('time', 240);
    s.set('damage', 0);
    s.set('combo', 45);
    s.set('kills', 55);
  });

  playthrough('高手：又快又无伤', (s) => {
    s.set('time', 105);
    s.set('damage', 0);
    s.set('combo', 52);
    s.set('kills', 48);
  });

  // ============================================================
  hr('⑥ 木桶模式 —— 单项拉胯不给 S');
  // ============================================================

  function compare(name: string, mode: 'weighted' | 'minimum' | 'weighted-with-floor'): void {
    const sys = new ScoreSystem({
      metrics: [Metrics.time(120, 300, 1), Metrics.damage(5, 1.5)],
      grades: DEFAULT_GRADES,
      mode,
      floor: 20,
    });
    // 时间满分，但挨了 5 下（damage 维度 0 分）
    sys.set('time', 100);
    sys.set('damage', 5);
    const r = sys.settle();
    console.log(`  ${name.padEnd(24)} 总分 ${r.score.toFixed(1).padStart(5)} → ${r.grade.id}`);
  }

  console.log('  场景：速通纪录（时间满分），但挨了 5 下打（damage 直接 0 分）\n');
  compare('weighted 加权平均', 'weighted');
  compare('minimum 木桶效应', 'minimum');
  compare('weighted-with-floor', 'weighted-with-floor');
  console.log('\n  ⚠️ 加权平均会让"速通但狂挨打"拿到高分，');
  console.log('     如果希望评级代表"打得好"而不只是"跑得快"，用后两种。');

  // ============================================================
  hr('⑦ StarRating —— 休闲关卡的三星');
  // ============================================================

  interface RunResult {
    cleared: boolean;
    timeLeft: number;
    deaths: number;
  }

  // ❌ 错误写法：条件各自独立累加
  const naive = new StarRating(3)
    .addCondition((c) => (c as RunResult).cleared)
    .addCondition((c) => (c as RunResult).timeLeft > 30)
    .addCondition((c) => (c as RunResult).deaths === 0);

  // ✅ 正确写法：后面的条件自带前置判断
  const proper = new StarRating(3)
    .addCondition((c) => (c as RunResult).cleared)
    .addCondition((c) => (c as RunResult).cleared && (c as RunResult).timeLeft > 30)
    .addCondition((c) => (c as RunResult).cleared && (c as RunResult).deaths === 0);

  const runs: RunResult[] = [
    { cleared: true, timeLeft: 60, deaths: 1 },
    { cleared: true, timeLeft: 5, deaths: 0 },
    { cleared: true, timeLeft: 45, deaths: 0 },
    { cleared: false, timeLeft: 90, deaths: 0 },   // 失败
  ];
  const names = ['通关但死了 1 次', '无伤通关但超时', '完美通关', '挑战失败'];

  console.log('  ' + ' '.repeat(16) + ' 错误写法   正确写法');
  for (let i = 0; i < runs.length; i++) {
    const a = naive.evaluate(runs[i]);
    const b = proper.evaluate(runs[i]);
    console.log(
      `  ${names[i].padEnd(14)}  ${'★'.repeat(a)}${'☆'.repeat(3 - a)}        ` +
      `${'★'.repeat(b)}${'☆'.repeat(3 - b)}`
    );
  }

  console.log(`
  ⚠️ 上面第 4 行（挑战失败）：错误写法给了 2 星。

  因为 addCondition 只是**独立累加**——没通关不影响"剩余时间充足"
  和"零死亡"这两条各自成立。于是失败的一局拿到了 2 星，
  玩家会觉得"我明明没通关，怎么还两星？"

  正确做法：把通关作为后续每条星的前置条件（cleared && ...）。
  这不是 StarRating 的缺陷——"几颗星"的语义由使用方定义，
  但**必须想清楚条件之间是否存在依赖**。`);

  console.log(`\n  星级是"达成几个条件"，字母是"加权总分"：`);
  console.log(`    星级 → 玩家一眼看懂，适合休闲/关卡制`);
  console.log(`    字母 → 能表达细腻差距，适合动作/硬核`);

  // ============================================================
  hr('串联：一局的完整生命周期');
  // ============================================================

  const gctx = makeCtx();
  const gflow = buildFlow(gctx);
  const gsys = new ScoreSystem({
    metrics: [Metrics.time(120, 300, 1), Metrics.damage(5, 1.5), Metrics.combo(30, 1)],
    grades: DEFAULT_GRADES,
  });

  gflow.goTo('menu');
  gflow.goTo('playing');
  gsys.startTimer();

  // 模拟一局：边打边记录
  // 模拟一局：60 帧 × 2 秒 = 120 秒
  for (let i = 0; i < 60; i++) {
    gflow.update(2000);
    gsys.tick(2000);
    gctx.kills += 1;
    if (i % 20 === 0) {
      gctx.hitsTaken += 1;
      gsys.add('damage', 1);
    }
    gctx.maxCombo = Math.max(gctx.maxCombo, 5 + i);
  }
  gsys.set('time', gsys.elapsed / 1000);   // 指标单位是秒
  gsys.set('combo', gctx.maxCombo);

  gflow.goTo('result');
  const final = gsys.settle();

  console.log(`
  状态机负责"现在在哪一局"：
    当前状态   ${gflow.current}
    历史栈     ${JSON.stringify(gflow.history)}
    战斗已清理 ${gctx.battleCleaned}

  评分系统负责"这局打得怎么样"：
    用时       ${(gsys.elapsed / 1000).toFixed(0)}s
    受伤       ${gctx.hitsTaken} 次
    最大连击   ${gctx.maxCombo}
    击杀       ${gctx.kills}
    ─────────────────
    总分       ${final.score.toFixed(1)}
    评级       ${final.grade.id}（${final.grade.name ?? ''}）

  两者互不认识：状态机不知道什么是"评级"，
  评分系统不知道什么是"暂停"。结算界面把它们接起来即可。
`);
}

main();
