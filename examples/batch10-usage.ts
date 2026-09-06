/**
 * examples/batch10-usage.ts —— 第九批插件的集成示例
 *
 * 【这个示例展示什么】
 *
 * 前八批都是"游戏里跑的东西"。这一批是**开发期用的工具**：
 *
 * ```
 * ① 关卡编辑器：摆放物件 → 撤销 / 重做 / 事务批量操作
 * ② 调试控制台：给物品 / 改属性 / 切关卡，带补全与历史
 * ③ 存档压缩：200 个单位的存档，二进制 vs JSON
 * ④ 崩溃现场：面包屑 + 日志 + 上下文，还原"玩家到底遇到了什么"
 * ```
 *
 * 四个模块互不相干，但有一个共同点：
 * **它们都不写死任何游戏概念**，所以任何项目都能直接搬。
 *
 * 【运行】
 * ```bash
 * npm run example:batch10
 * ```
 */

import { CommandStack, setValueCommand } from '../command/CommandStack';
import { DebugConsole, type ParsedArgs } from '../debug-console/DebugConsole';
import {
  schema,
  uint,
  float,
  bool,
  RecordArray,
  toHex,
} from '../binary/BinarySerializer';
import {
  CrashReporter,
  reportText,
  type CrashReport,
} from '../crash/CrashReporter';
import { Logger, LogLevel } from '../logger/Logger';
import { RNG } from '../rng/RNG';

function hr(title: string): void {
  console.log(`\n${'═'.repeat(66)}\n  ${title}\n${'═'.repeat(66)}`);
}

// ============================================================
// ① 关卡编辑器：撤销 / 重做
// ============================================================

interface Placed {
  id: number;
  x: number;
  y: number;
  kind: string;
}

function demoCommandStack(): void {
  hr('① 关卡编辑器：撤销 / 重做');

  const world: Placed[] = [];
  let nextId = 1;
  let gold = 500;

  const stack = new CommandStack({ limit: 50 });

  console.log('\n【场景】在关卡编辑器里摆放物件，每摆一个花 50 金币\n');

  // 摆放命令
  function place(kind: string, x: number, y: number) {
    stack.do({
      name: `摆放 ${kind}`,
      execute: () => {
        world.push({ id: nextId++, x, y, kind });
        gold -= 50;
      },
      undo: () => {
        world.pop();
        nextId--;
        gold += 50;
      },
    });
  }

  place('箭塔', 3, 4);
  place('箭塔', 7, 2);
  place('兵营', 5, 9);
  console.log(`  摆放 3 个后：世界 ${world.length} 个物件，金币 ${gold}`);

  stack.undo();
  console.log(`  撤销 1 次：  ${world.length} 个物件，金币 ${gold}`);
  console.log(`    ↑ 数量和金币都回退了——这就是"做"和"撤"绑在一起的价值`);
  console.log(`       写在两处的话，很容易只退一个`);

  stack.redo();
  console.log(`  重做：      ${world.length} 个物件，金币 ${gold}`);

  // 事务
  console.log('\n【事务】批量选中 3 个物件一起移动 → 撤销一次全部回退\n');
  const selected = [0, 1, 2];
  const dx = 2, dy = 1;

  stack.transact('移动 3 个物件', () => {
    for (const i of selected) {
      const obj = world[i];
      stack.do({
        name: `移动 #${obj.id}`,
        execute: () => { obj.x += dx; obj.y += dy; },
        undo: () => { obj.x -= dx; obj.y -= dy; },
      });
    }
  });

  console.log(`  移动后：${world.map((o) => `(${o.x},${o.y})`).join(' ')}`);
  console.log(`  栈深度 ${stack.undoDepth} = 之前 3 次摆放 + 本次事务 1 条`);
  console.log(`    ↑ 事务内的 3 条子命令合并成了 1 条，否则这里会是 6`);

  stack.undo();
  console.log(`  撤销一次：${world.map((o) => `(${o.x},${o.y})`).join(' ')} ← 全部归位`);

  // 事务回滚
  console.log('\n【回滚】事务执行到一半失败');
  const before = { n: world.length, gold };
  try {
    stack.transact('危险操作', () => {
      stack.do({
        name: '摆放 A',
        execute: () => { world.push({ id: nextId++, x: 0, y: 0, kind: 'A' }); gold -= 50; },
        undo: () => { world.pop(); nextId--; gold += 50; },
      });
      stack.do({
        name: '摆放 B',
        execute: () => { world.push({ id: nextId++, x: 1, y: 1, kind: 'B' }); gold -= 50; },
        undo: () => { world.pop(); nextId--; gold += 50; },
      });
      throw new Error('中途发现位置非法');
    });
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message}`);
  }
  console.log(`  回滚后：物件 ${world.length}（应回到 ${before.n}），金币 ${gold}（应回到 ${before.gold}）`);
  console.log(`  ↑ 没有自动回滚的话，界面显示"操作失败"但世界已经改了一半`);

  // 合并
  console.log('\n【合并】拖动滑块改血量，50 次输入只产生 1 条撤销记录\n');
  let hp = 100;
  const hpStack = new CommandStack();
  for (let v = 101; v <= 150; v++) {
    hpStack.do(setValueCommand('血量', () => hp, (n) => { hp = n; }, v, { mergeKey: 'hp' }));
  }
  console.log(`  拖到 ${hp}，栈深度 ${hpStack.undoDepth}`);
  hpStack.undo();
  console.log(`  撤销一次 → ${hp}（回到拖动前的 100，而不是 149）`);
}

// ============================================================
// ② 调试控制台
// ============================================================

function demoDebugConsole(): void {
  hr('② 调试控制台：把 5 分钟的验证压缩到 3 秒');

  // 一个模拟的游戏状态
  const game = {
    level: 1,
    gold: 0,
    hp: 100,
    inventory: [] as string[],
    difficulty: 'normal' as 'easy' | 'normal' | 'hard',
  };

  const out: string[] = [];
  const con = new DebugConsole({ prefix: '', historyLimit: 20 });
  con.onOutput((l) => out.push(l));
  con.onClear(() => out.length = 0);

  con.registerAll([
    {
      name: 'give',
      args: [
        { name: 'item', type: 'string', help: '物品 id' },
        { name: 'count', type: 'int', optional: true, default: 1, min: 1, max: 999 },
      ],
      help: '给玩家物品',
      group: '物品',
      run: (a: ParsedArgs) => {
        const item = a.getString('item');
        const n = a.getInt('count');
        for (let i = 0; i < n; i++) game.inventory.push(item);
        return `获得 ${item} ×${n}`;
      },
    },
    {
      name: 'set_hp',
      args: [{ name: 'v', type: 'int', min: 0, max: 9999 }],
      help: '设置血量',
      group: '角色',
      run: (a) => {
        const v = a.getInt('v');
        const old = game.hp;
        game.hp = v;
        return `血量 ${old} → ${v}`;
      },
    },
    {
      name: 'goto',
      args: [{ name: 'level', type: 'int', min: 1, max: 20 }],
      help: '跳到指定关卡',
      group: '流程',
      run: (a) => {
        game.level = a.getInt('level');
        return `进入第 ${game.level} 关`;
      },
    },
    {
      name: 'difficulty',
      alias: ['diff'],
      args: [{ name: 'v', type: 'enum', values: ['easy', 'normal', 'hard'] }],
      help: '设置难度',
      group: '流程',
      run: (a) => {
        game.difficulty = a.getEnum('v') as 'easy' | 'normal' | 'hard';
        return `难度 → ${game.difficulty}`;
      },
    },
    {
      name: 'self_destruct',
      help: '（隐藏）触发一次崩溃，验证上报链路',
      hidden: true,
      run: () => { throw new Error('这是一次故意的崩溃'); },
    },
  ]);

  function run(line: string): void {
    out.length = 0;
    console.log(`\n  $ ${line}`);
    try {
      con.execute(line);
    } catch {
      // 内部错误会向上抛（便于接入崩溃上报）
      console.log('    [错误已向上传播，可被 CrashReporter 捕获]');
    }
    for (const l of out) {
      for (const sub of l.split('\n')) console.log(`    ${sub}`);
    }
  }

  console.log('\n【正常命令】');
  run('give 火焰之剑 3');
  run('give "破损的 盾牌"');
  run('set_hp 8888');
  run('goto 7');
  run('diff hard');

  console.log('\n【参数校验：错误提示要指出问题在哪】');
  run('give 剑 0');
  run('set_hp 99999');
  run('set_hp abc');
  run('diff nightmare');
  run('goto 7 8 9');

  console.log('\n【模糊建议：打错命令时给方向】');
  run('st_hp 50');
  run('xyz');

  console.log('\n【Tab 补全】');
  console.log(`  "gi"       → "${con.complete('gi')}"`);
  console.log(`  "diff "    → "${con.complete('diff ')}"`);
  console.log(`  "diff h"   → "${con.complete('diff h')}"`);
  console.log(`  候选 "s"   → [${con.completeCandidates('s').join(', ')}]`);

  console.log('\n【历史：↑ / ↓】');
  const h = con.history;
  console.log(`  已记录 ${h.length} 条（连续重复的不重复记录）`);
  console.log(`  ↑ 第一次：${con.historyPrev('')}`);
  console.log(`  ↑ 第二次：${con.historyPrev('')}`);
  console.log(`  ↓        ：${con.historyNext()}`);

  console.log('\n【内置 help】');
  out.length = 0;
  con.execute('help');
  for (const l of out.slice(0, 24)) console.log(`    ${l}`);
  if (out.length > 24) console.log(`    …（共 ${out.length} 行）`);
}

// ============================================================
// ③ 存档压缩
// ============================================================

function demoBinary(): void {
  hr('③ 存档压缩：200 个单位的存档，二进制 vs JSON');

  const unitSchema = schema<{
    id: number; hp: number; x: number; y: number; alive: boolean;
  }>(
    {
      id: uint(12),                      // 0..4095
      hp: uint(10),                      // 0..1023
      x: float(-500, 500, 0.05),         // 0.05 精度
      y: float(-500, 500, 0.05),
      alive: bool(),
    },
    { name: 'Unit', version: 1 }
  );

  console.log('\n【结构布局】');
  console.log(unitSchema.describe().split('\n').map((l) => `  ${l}`).join('\n'));
  console.log(`\n  定长部分 ${unitSchema.fixedBits} 位 → ${unitSchema.minBytes} 字节/单位`);

  const rng = new RNG(2024);
  const units = Array.from({ length: 200 }, (_, i) => ({
    id: i,
    hp: Math.floor(rng.next() * 1024),
    x: rng.range(-400, 400),
    y: rng.range(-400, 400),
    alive: rng.next() > 0.1,
  }));

  const arr = new RecordArray(unitSchema, 512);
  const bin = arr.encode(units);
  const json = JSON.stringify(units);
  const jsonBytes = new TextEncoder().encode(json).length;

  console.log('\n【体积对比】200 个单位');
  console.log(`  JSON    ${String(jsonBytes).padStart(6)} 字节`);
  console.log(`  二进制  ${String(bin.length).padStart(6)} 字节`);
  console.log(`  节省    ${((1 - bin.length / jsonBytes) * 100).toFixed(1)}%`);
  console.log(`\n  前 16 字节：${toHex(bin, 16)}`);

  // 往返精度
  const back = arr.decode(bin);
  let maxErr = 0;
  for (let i = 0; i < units.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(back[i].x - units[i].x), Math.abs(back[i].y - units[i].y));
    if (back[i].id !== units[i].id || back[i].alive !== units[i].alive) {
      throw new Error(`往返不一致：#${i}`);
    }
  }
  console.log(`\n  往返校验：200 个单位 id / alive 完全一致`);
  console.log(`  坐标最大误差 ${maxErr.toFixed(4)}（量化步长 0.05，符合预期）`);
  console.log(`  ↑ 判据：量化误差要小于游戏里能感知的最小距离`);
  console.log(`    角色每帧移动 0.1 米时，0.05 的误差可以被接受`);

  console.log('\n【⚠️ 位打包的代价：改宽度会让旧存档失效】');
  console.log('  hp: uint(10) 改成 uint(12) 后：');
  console.log('    - 新存档每个单位多 2 位');
  console.log('    - 旧存档读出来的所有字段全部错位');
  console.log('  所以 schema 必须带 version，读取时先判断要不要迁移');
  console.log(`  当前 version = ${unitSchema.version}`);

  console.log('\n【安全边界】');
  const w = unitSchema;
  try {
    w.encode({ id: 5000, hp: 0, x: 0, y: 0, alive: false });
  } catch (e) {
    console.log(`  id=5000 超出 uint12 → ${(e as Error).message}`);
  }
  try {
    w.encode({ id: 1.5, hp: 0, x: 0, y: 0, alive: false });
  } catch (e) {
    console.log(`  id=1.5 不是整数   → ${(e as Error).message}`);
    console.log(`    ↑ 提示"需要整数"而不是"越界"，排查方向才不会跑偏`);
  }
}

// ============================================================
// ④ 崩溃现场还原
// ============================================================

function demoCrash(): void {
  hr('④ 崩溃现场还原：玩家只说"闪退了"');

  const logger = new Logger({ level: LogLevel.Silent });

  const sent: CrashReport[] = [];
  const crash = new CrashReporter({
    transport: { send: (r) => { sent.push(r); } },
    breadcrumbLimit: 20,
    dedupeWindow: 60000,
  });

  crash.setContext({
    version: '1.2.3',
    platform: 'iOS 17.5',
    device: 'iPhone 14',
    buildType: 'release',
  });
  crash.bindLogSource(() => logger.export());

  console.log('\n【模拟一局游戏，玩家一路留下痕迹】\n');

  crash.leave('flow', '启动游戏');
  crash.leave('flow', '进入主菜单');
  logger.info('save', '读取存档成功');
  crash.leave('flow', '开始第 3 层');
  crash.leave('combat', '遭遇精英怪 ×4');
  logger.warn('ai', '寻路失败，使用直线移动兜底');
  crash.leave('loot', '拾取遗物：暴击强化');
  crash.leave('input', '施放技能：烈焰斩');
  logger.error('combat', '伤害计算异常，原始值为 NaN', { target: 'elite_2' });
  crash.leave('combat', 'Boss 进入二阶段');

  crash.setContextValue('currentLevel', 3);
  crash.setContextValue('playerHp', 45);

  // 崩溃
  function bossPhaseTwo() {
    throw new TypeError("Cannot read properties of undefined (reading 'hp')");
  }

  console.log('  …玩家打到 Boss 二阶段，崩了\n');
  try {
    bossPhaseTwo();
  } catch (e) {
    crash.capture(e, 'fatal');
  }

  const report = sent[0];
  console.log(reportText(report).split('\n').map((l) => `  ${l}`).join('\n'));

  console.log('\n\n【为什么面包屑比堆栈更有用】');
  console.log('  堆栈告诉你「bossPhaseTwo 里读了个 undefined」');
  console.log('  面包屑告诉你「玩家在第 3 层、拿了暴击强化、放了烈焰斩、');
  console.log('  Boss 刚进二阶段」——再结合日志里那条 NaN 伤害，');
  console.log('  基本能锁定问题出在遗物加成与 Boss 阶段切换的交互上。');

  console.log('\n【去重：同一个 bug 不会刷屏】');
  for (let i = 0; i < 20; i++) {
    try { bossPhaseTwo(); } catch (e) { crash.capture(e, 'fatal'); }
  }
  console.log(`  又崩了 20 次 → 新增上报 ${sent.length - 1} 次（被去重全部拦下）`);
  console.log(`  累计计数 ${crash.stats()[0].count}（服务端据此判断影响了多少人）`);
  console.log(`  ↑ 窗口过期后的下一次上报，会带上这个累计数`);

  console.log('\n【⚠️ 指纹的稳定性】');
  const fp = report.fingerprint;
  console.log(`  本次指纹：${fp}`);
  console.log(`  ↑ 取首个堆栈帧并抹掉行号——`);
  console.log(`    行号会随构建变化，带行号的话同一个 bug 会产生几十个指纹，`);
  console.log(`    去重就失效了。`);

  console.log('\n【采样：高频崩溃不打爆服务器】');
  const sampledSent: CrashReport[] = [];
  const sampled = new CrashReporter({
    transport: { send: (r) => { sampledSent.push(r); } },
    dedupeWindow: 0,
    sampleRate: 0.1,
  });
  let sentCount = 0;
  for (let i = 0; i < 1000; i++) {
    if (sampled.captureMessage(`警告 ${i}`, 'warning')) sentCount++;
  }
  console.log(`  1000 条警告，采样率 10% → 上报约 ${sentCount} 条`);
  console.log(`  崩溃（fatal）不受采样影响，永远上报`);
}

// ============================================================
// 主函数
// ============================================================

function main(): void {
  console.log('╔' + '═'.repeat(66) + '╗');
  console.log('║' + '  cocos-kit 第九批插件集成示例'.padEnd(58) + '║');
  console.log('║' + '  command / debug-console / binary / crash'.padEnd(58) + '║');
  console.log('╚' + '═'.repeat(66) + '╝');

  demoCommandStack();
  demoDebugConsole();
  demoBinary();
  demoCrash();

  hr('总结');
  console.log(`
  这一批的四个模块都不是"游戏里跑的东西"，而是**开发期用的工具**。

  ┌────────────────┬──────────────────────────────────┐
  │ 模块           │ 它把什么从 5 分钟压到 3 秒       │
  ├────────────────┼──────────────────────────────────┤
  │ command        │ 编辑器/建造的撤销功能，零返工    │
  │ debug-console  │ 验证「这个遗物生效了吗」         │
  │ binary         │ 存档体积与存档造假               │
  │ crash          │ 还原「玩家到底遇到了什么」       │
  └────────────────┴──────────────────────────────────┘

  它们的共同点：都不认识你的游戏。
  command 不认识"箭塔"，console 不认识"遗物"，
  binary 不认识"血量"，crash 不认识"Boss"。

  正因为不认识，换任何项目一行都不用改。

  开发顺序建议：先 debug-console（立刻提升效率），
  再 command（编辑器必备），binary 和 crash 可以等到
  要做存档和要上线时再接。
`);
}

main();
