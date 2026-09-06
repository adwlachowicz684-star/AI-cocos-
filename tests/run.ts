/**
 * tests/run.ts —— 测试入口
 *
 * 【结构】
 * - `_framework.ts`  迷你测试框架（describe / test / assert / eq / near）
 * - `run_core.ts`    第一批 6 个插件的测试
 * - `run_p0.ts`      P0 四个地基插件的测试（Logger / Scheduler / Config / Input）
 * - `run_batch3.ts`  第二批插件的测试（loot / fsm / BT / buff 等 15 个）
 * - `run_batch4.ts`  第三批插件的测试（di / scheduling / inventory / card / dialogue / expression / snapshot / replay / i18n）
 * - `run_batch5.ts`  第四批插件的测试（turn / grid / quest / shop / craft）
 * - `run_batch6.ts`  第五批插件的测试（ds / pathfind / fov / dungeon / steering / noise）
 * - `run.ts`         本文件：入口，依次跑上面两组并汇总
 *
 * 【运行】
 * ```bash
 * npm test
 * ```
 *
 * 【测试重点的选择】
 * 不要追求 100% 覆盖率——UI 和渲染相关的自动化测试成本收益极差。
 * 把精力放在**纯逻辑**上，那才是 bug 高发区：
 *   1. RNG 可复现性（这是核心承诺）
 *   2. 伤害管线各阶段
 *   3. Modifier 运算顺序与缓存
 *   4. Track 序列化与区间查询
 *   5. JoystickCore 死区 / 归一化 / 松开归零
 *   6. Scheduler 暂停语义（「暂停后 buff 仍在倒计时」的解药）
 *   7. ConfigLoader 校验（一次报全）
 *   8. InputManager justPressed 帧边界
 */

import { setSuite, summary } from './_framework';
import { runCoreTests } from './run_core';
import { runP0Tests } from './run_p0';
import { runBatch3Tests } from './run_batch3';
import { runBatch4Tests } from './run_batch4';
import { runBatch5Tests } from './run_batch5';
import { runBatch6Tests } from './run_batch6';
import { runBatch7Tests } from './run_batch7';
import { runBatch8Tests } from './run_batch8';
import { runBatch9Tests } from './run_batch9';
import { runBatch10Tests } from './run_batch10';
import { runBatch11Tests } from './run_batch11';
import { runBatch12Tests } from './run_batch12';
import { runBatch13Tests } from './run_batch13';
import { runBatch14Tests } from './run_batch14';
import { runBatch15Tests } from './run_batch15';
import { runBatch16Tests } from './run_batch16';
import { runBatch17Tests } from './run_batch17';
import { runBatch18Tests } from './run_batch18';
import { runBatch19Tests } from './run_batch19';
import { runBatch20Tests } from './run_batch20';
import { runAdapterTests } from './run_adapters';
import { runEntityTests } from './run_entity';
import { runSkillQueueTests } from './run_skillqueue';
import { runFuzzTests } from './run_fuzz';
import { runWeakTests } from './run_weak';
import { runWeak2Tests } from './run_weak2';
import { runFixRegressTests } from './run_fixregress';
import { runDtGuardTests } from './run_dtguard';
import { runDtGuard2Tests } from './run_dtguard2';
import { runNumGuardTests } from './run_numguard';

async function main(): Promise<void> {
  setSuite('第一批：核心插件（EventBus / Pool / RNG / Damage / Skill / Joystick）');
  runCoreTests();

  setSuite('P0：地基插件（Logger / Scheduler / Config / Input）');
  await runP0Tests();

  setSuite('第二批：内容与系统（loot / fsm / BT / buff / curve / result / signal / save / roller / pathfinding / spatial / noise / condition / tween）');
  await runBatch3Tests();

  setSuite('第三批：基础设施（di / scheduling / inventory / card / dialogue / expression / snapshot / replay / i18n）');
  await runBatch4Tests();

  setSuite('第四批：玩法框架（turn / grid / quest / shop / craft）');
  await runBatch5Tests();

  setSuite('第五批：算法工具（ds / pathfind / fov / dungeon / steering / noise）');
  await runBatch6Tests();

  setSuite('第六批：战斗手感（attribute / hitbox / projectile / indicator / telegraph / skill-caster / input-buffer / dash / camera-shake）');
  runBatch7Tests();

  setSuite('第七批：肉鸽核心（room-graph / wave-spawner / meta 元进度 / affix 词条）');
  runBatch8Tests();

  setSuite('第八批：系统与深度（perception / attack-token / bullet-pattern / element / targeting / combo / objective / difficulty / score / gacha）');
  runBatch9Tests();

  setSuite('第九批：工程效率（command / debug-console / binary / crash）');
  await runBatch10Tests();

  setSuite('第十批：玩法补完（Chest 加权 / runscope / setbonus / daily / leaderboard）');
  await runBatch11Tests();


  setSuite('第十一批：模块内聚（skill-variant / blessing / curse / interact）');
  await runBatch12Tests();

  setSuite('第十二批：工程效率与系统补完（observable / cheatcode / timeutil / uinav / telemetry / rarity / stats / achievement / gesture / rebind）');
  await runBatch13Tests();

  setSuite('第十三批：GameFlow 孤儿插件收尾');
  await runBatch14Tests();

  setSuite('第十四批：系统与表现层补完（currency / scenerouter / camera-follow / feedback / progressbar / subtitle）');
  await runBatch15Tests();

  setSuite('第十五批：系统与外壳补完（currency / settings / subtitle / tutorial / reddot / scenerouter / accessibility）');
  runBatch16Tests();

  setSuite('第十六批：评分与匹配（elo / glicko2 / matchmaker / team-balancer / lobby / rank-tier）');
  runBatch17Tests();

  setSuite('第十七批：评分与匹配周边（team-mmr / reconnect / surrender / spectate / report / anticheat / season-reward / abtest）');
  runBatch18Tests();

  setSuite('第十八批：表现与运维层（audio / bgm-stack / cutscene / transition / minimap / builder / auto-quality / diag-pack）');
  runBatch19Tests();

  setSuite('第十九批：碰撞与移动（collision 碰撞检测与解析 / mover 角色移动控制器）');
  runBatch20Tests();

  setSuite('第二十批：模块间适配器（adapters：地牢→网格 / 命中→施法 / 掉落→入包）');
  runAdapterTests();

  setSuite('第二十一批：统一实体注册表（entity：id 版本号 / 别名映射 / 死亡归宿 / 遍历安全）');
  runEntityTests();

  setSuite('第二十二批：技能排队与 CD 补发（skill-queue：提前点击 / 失败分类 / 窗口自检）');
  runSkillQueueTests();

  setSuite('第二十三批：随机化（模糊）测试（对拍 / 随机采样 / 畸形输入）');
  runFuzzTests();

  setSuite('第二十四批：弱测单元补强（队形 / VisibilityMap / SpatialHash / createAgent）');
  runWeakTests();

  setSuite('第二十五批：弱测补强第二批（EntityIndex / 噪声 / 地牢 / 加权表 / Flock / Modifier）');
  runWeak2Tests();

  setSuite('外部审查报告缺陷回归（save / leaderboard / gacha / currency / social / projectile / wave / damage / cutscene / scene / audio / daily / cheatcode / collision）');
  runFixRegressTests();

  setSuite('异常数值穿透回归（dt 守卫 / 角度死循环 / buff 死循环 / room-graph OOM）');
  runDtGuardTests();

  setSuite('异常数值穿透回归 · 批次 2（dt 守卫统一：静默状态污染）');
  runDtGuard2Tests();

  setSuite('异常数值穿透回归 · 批次 5（Math.max/min 收口：容量字段上界）');
  runNumGuardTests();

  summary();
}

main();
