/**
 * examples/p0-usage.ts —— P0 四个地基插件的综合示例
 *
 * 【这个例子演示什么】
 * 一个最小但完整的「游戏循环」，展示四个插件如何协作：
 *
 *   Scheduler  统一时间源（暂停 / 顿帧 / 慢动作）
 *   Input      统一输入（键盘 / 手柄 / 虚拟摇杆）
 *   Config     配置加载与校验
 *   Logger     分级日志与崩溃现场
 *
 * 【关键观察点】
 * 1. 暂停时，游戏逻辑一帧都不执行，但 UI 仍在动
 * 2. 暂停时，延时任务不推进（"暂停后 buff 仍在倒计时"的解药）
 * 3. 配置拼错 id，启动那一刻就报错，而不是三小时后
 *
 * 【运行】
 *   npx tsc -p tsconfig.json && node .build/examples/p0-usage.js
 */

import { Logger, LogLevel } from '../logger/Logger';
import { Assert } from '../logger/Assert';
import { Scheduler } from '../scheduler/Scheduler';
import { ConfigLoader, MemoryTableSource } from '../config/ConfigLoader';
import { Validator } from '../config/Validator';
import { InputManager, Key } from '../input/InputManager';

// ============================================================
// 模拟一个"游戏"
// ============================================================

interface EnemyCfg {
  id: string;
  name: string;
  hp: number;
  drop: string | null;
}

const log = new Logger({ level: LogLevel.Info, bufferSize: 100 });
const gameLog = log.module('game');

async function main(): Promise<void> {
  console.log('========== P0 地基插件综合示例 ==========\n');

  // ---------- 1. 配置加载 ----------
  const schemas = {
    enemies: {
      id: { type: 'string' as const, required: true },
      name: { type: 'string' as const, required: true },
      hp: { type: 'number' as const, min: 1, max: 9999 },
      drop: { type: 'ref' as const, table: 'loot', nullable: true },
    },
    loot: {
      id: { type: 'string' as const, required: true },
    },
  };

  const source = new MemoryTableSource({
    enemies: [
      { id: 'slime', name: '史莱姆', hp: 30, drop: 'common' },
      { id: 'skeleton', name: '骷髅兵', hp: 60, drop: 'uncommon' },
    ],
    loot: [{ id: 'common' }, { id: 'uncommon' }],
  });

  const config = new ConfigLoader(source, { tables: schemas, throwOnError: false });
  const issues = await config.loadAll();

  console.log('【配置加载】');
  console.log(`  校验结果：${Validator.format(issues)}`);
  const slime = config.get<EnemyCfg>('enemies', 'slime');
  console.log(`  读取敌人：${slime.name} HP=${slime.hp} 掉落=${slime.drop}`);
  gameLog.info('配置就绪', { tables: config.loadedTables });

  // 演示：配置错误会立刻被发现
  console.log('\n【配置校验：故意写错一个 id】');
  const badIssues = Validator.checkReferences(
    { enemies: [{ id: 'boss', hp: 999, drop: 'boss_loot' }], loot: [{ id: 'common' }] },
    {
      enemies: {
        id: { type: 'string' },
        hp: { type: 'number' },
        drop: { type: 'ref', table: 'loot' },
      },
      loot: { id: { type: 'string' } },
    } as never
  );
  console.log('  ' + Validator.format(badIssues).split('\n').join('\n  '));
  console.log('  ↑ 三小时的排查时间，换成了三分钟的修改\n');

  // ---------- 2. 输入 ----------
  const input = new InputManager();
  input.bindAxis('move', {
    negativeX: [Key.A],
    positiveX: [Key.D],
    negativeY: [Key.S],
    positiveY: [Key.W],
  });
  input.bindButton('attack', [Key.Space]);
  input.bindButton('pause', [Key.Escape]);

  // ---------- 3. Scheduler ----------
  const sched = new Scheduler();

  let gameTime = 0; // 游戏内累计时间
  let uiTime = 0; // UI 累计时间
  let attackCount = 0;

  sched.everyFrame((dt) => {
    gameTime += dt;

    input.beginFrame();
    const dir = input.getAxis('move');
    if (dir.x !== 0 || dir.y !== 0) {
      // 角色移动（这里只累计，不真的画出来）
    }
    if (input.wasJustPressed('attack')) attackCount++;
    input.endFrame();
  });

  sched.everyFrameUnscaled((dt) => {
    uiTime += dt;
  });

  // 一个 3 秒后触发的延时（游戏内时间）
  let spawnFired = false;
  sched.delay(3, () => {
    spawnFired = true;
    gameLog.info('3 秒到了，生成敌人');
  });

  // ---------- 4. 模拟主循环 ----------
  const DT = 1 / 60;

  function frames(n: number): void {
    for (let i = 0; i < n; i++) sched.update(DT);
  }

  console.log('【正常运行】');
  frames(60); // 1 秒
  console.log(`  游戏时间 ${gameTime.toFixed(3)}s，UI 时间 ${uiTime.toFixed(3)}s`);
  console.log(`  延时是否已触发：${spawnFired}（预期 false，才过了 1 秒）`);

  frames(121); // 再 2 秒，总共 3 秒
  console.log(`  再过 2 秒，延时触发：${spawnFired}（预期 true）`);

  // ---------- 5. 暂停 ----------
  console.log('\n【暂停：真暂停验证】');
  const gameBefore = gameTime;
  const uiBefore = uiTime;

  sched.pause();
  frames(300); // 墙钟 5 秒

  console.log(`  暂停 5 秒后：`);
  console.log(`    游戏时间增量 ${(gameTime - gameBefore).toFixed(6)}s（必须是 0）`);
  console.log(`    UI 时间增量 ${(uiTime - uiBefore).toFixed(3)}s（应约为 5，暂停菜单还在动）`);

  // 暂停期间延时不应推进
  let pauseTimerFired = false;
  sched.delay(1, () => (pauseTimerFired = true));
  frames(120); // 墙钟 2 秒
  console.log(`    暂停期间的 1 秒延时是否触发：${pauseTimerFired}（必须 false）`);

  sched.unpause();
  frames(61);
  console.log(`    恢复后延时触发：${pauseTimerFired}（应为 true）`);

  // ---------- 6. 慢动作与顿帧 ----------
  console.log('\n【慢动作与顿帧】');

  const t0 = gameTime;
  sched.slowMotion(0.5);
  frames(60);
  console.log(`  半速 1 秒（墙钟）：游戏时间推进 ${(gameTime - t0).toFixed(3)}s（应约 0.5）`);
  sched.clearSlowMotion();

  const t1 = gameTime;
  sched.hitStop(0.08, 0.05); // 顿帧 80ms，scale=0.05
  sched.update(DT);
  console.log(`  顿帧中一帧推进 ${(gameTime - t1).toFixed(6)}s（应接近 0.0008，即几乎静止）`);

  // ---------- 7. 输入：justPressed 帧边界 ----------
  console.log('\n【输入：justPressed 的帧边界】');

  const input2 = new InputManager();
  input2.bindButton('attack', [Key.Space]);

  input2.setKeyDown(Key.Space);
  input2.beginFrame();
  const first = input2.wasJustPressed('attack');
  input2.endFrame();

  input2.beginFrame();
  const second = input2.wasJustPressed('attack');
  input2.endFrame();

  console.log(`  按下那一帧 ${first}（应 true）`);
  console.log(`  下一帧 ${second}（应 false —— 忘了 endFrame 就会也是 true，导致连放）`);
  console.log(`  仍按住 ${input2.isPressed('attack')}（应 true）`);

  // ---------- 8. 断言：快速失败 ----------
  console.log('\n【断言：快速失败】');
  try {
    Assert.finite(NaN, '伤害值');
  } catch (e) {
    console.log(`  ${e instanceof Error ? e.message : e}`);
    console.log('  ↑ 立刻崩在出错那行，而不是三小时后以无关形态爆发');
  }

  // ---------- 9. 崩溃现场 ----------
  console.log('\n【日志：崩溃现场导出】');
  log.setLevel(LogLevel.Error);
  log.error('combat', '伤害计算异常', { raw: NaN, target: 'slime' });
  const crashReport = log.exportText();
  console.log(`  最近 ${log.buffered} 条日志（按时间顺序）：`);
  crashReport.split('\n').forEach((l) => console.log('    ' + l));

  console.log('\n========== 示例结束 ==========');
}

declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== 'undefined' && require?.main === module) {
  main();
}

export { main };
