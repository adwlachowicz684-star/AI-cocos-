/**
 * examples/accessibility-usage.ts —— accessibility 单单元示例
 *
 * 【为什么单独给它写一个示例】
 * 精审里本单元被判"示例：无"（rule7 要求 README + 测试 + 示例三件套）。
 * `examples/batch15-usage.ts` 里虽然用过它，但那一段是"游戏外壳"大串联的
 * 其中一环，想单独看清 a11y 的行为得先把前后文都读一遍——
 * 达不到 rule7 要求的"复制即可用"。
 *
 * 【这个例子演示什么】
 * 一个设置界面从"玩家勾选"到"表现层查询"的完整链路，
 * 外加两件最容易被忽略的事：
 *
 *   1. 脏配置（NaN / 越界）不会让全 UI 的字号变成 NaN
 *   2. 设置界面关掉之后要 destroy()，否则 UI 节点被 onChange 闭包挂住
 *
 * 【如何运行】
 *   npm run build && node .build/examples/accessibility-usage.js
 */

import { Accessibility, type EffectKind } from '../accessibility/Accessibility';

/** 打一条分隔标题 */
function hr(t: string): void {
  console.log(`\n${'─'.repeat(52)}\n${t}\n${'─'.repeat(52)}`);
}

function main(): void {
  console.log('════════════════════════════════════════════════');
  console.log('  accessibility · 可访问性设置（accessibility）');
  console.log('════════════════════════════════════════════════');

  // ========== 1. 表现层该怎么问 ==========
  hr('1. 表现层不要各自存布尔量，统一问 shouldPlay()');

  const a11y = new Accessibility();
  const kinds: EffectKind[] = [
    'shake', 'flash', 'transition', 'autoCamera', 'particle', 'loopAnim', 'sway',
  ];

  const show = (label: string): void => {
    console.log(`\n  ${label}`);
    for (const k of kinds) {
      console.log(`    ${k.padEnd(11)} ${a11y.shouldPlay(k) ? '播放' : '关闭'}`);
    }
  };

  show('默认（未开启减少动效）：全部播放');

  a11y.setReduceMotion(true);
  show('开启"减少动效"后：只剩装饰性表现');
  console.log(
    '\n  → 只关震屏不关闪白，玩家会认为这个设置没生效。\n' +
    '    减少动效防的是前庭不适（晕动症），不是"画面朴素一点"。'
  );

  // ========== 2. 震屏是"减弱"不是"开关" ==========
  hr('2. 震屏是"减弱"而不是"开关"');

  const a2 = new Accessibility({ shakeScale: 0.4 });
  console.log(`\n  shakeScale = 0.4 时，10 点震屏 → 实际 ${a2.shake(10)}`);
  a2.setShakeScale(0);
  console.log(`  shakeScale = 0   时，10 点震屏 → 实际 ${a2.shake(10)}（完全关闭）`);
  console.log(
    '\n  → 完全关掉会让一部分玩家觉得"打击感没了"，\n' +
    '    所以给的是倍率而不是布尔量。'
  );

  // ========== 3. 脏配置不会让 UI 变 NaN ==========
  hr('3. 脏配置（NaN / 越界）不会让全 UI 字号变 NaN');

  /**
   * 【修复前的实测】
   * ```
   * new Accessibility({ fontScale: NaN }) 未抛错！fontScale = NaN
   * fontSize(16) = NaN
   * ```
   * `fontSize()` 是 `base * _fontScale`，一个 NaN 进去，
   * 全 UI 字号变 NaN → 文本渲染异常或整块消失，且不抛任何错。
   * NaN 进了布局要回溯很久才能定位到"是构造参数带了 NaN"。
   */
  try {
    new Accessibility({ fontScale: NaN });
    console.log('\n  ✗ NaN 字号被放行了');
  } catch (e) {
    console.log(`\n  fontScale = NaN  → 构造即抛错：${(e as Error).message}`);
  }

  console.log(`  shakeScale = 5   → 夹到 ${new Accessibility({ shakeScale: 5 }).shakeScale}`);
  console.log(`  shakeScale = -3  → 夹到 ${new Accessibility({ shakeScale: -3 }).shakeScale}`);
  console.log(`  longPressMs=NaN  → 回落 ${new Accessibility({ longPressMs: NaN }).longPressMs}`);
  console.log(`  longPressMs=99999→ 夹到 ${new Accessibility({ longPressMs: 99999 }).longPressMs}`);
  console.log(
    '\n  → 构造与 setter 同一个口径：以前构造传 5 生效、' +
    'setShakeScale(5) 却被压到 1，\n    同一个值走不同路径结果不同，是最难查的一类不一致。'
  );

  // ========== 4. 色觉障碍 ==========
  hr('4. 色觉障碍：不能只靠颜色区分');

  const cb = new Accessibility({ colorBlind: 'deuteranopia' });
  console.log(`\n  需要颜色辅助：${cb.needsColorAid()}`);
  console.log(`  要避开的色对：${cb.avoidHuePair()}`);
  console.log(
    '\n  → "血量低"不能只靠变红，要额外加图标或数字。\n' +
    '    三色盲是蓝黄难分，不是红绿——三种色觉障碍要分别处理。'
  );

  // ========== 5. 存档往返与卸载 ==========
  hr('5. 存档往返，以及设置界面关掉之后要 destroy()');

  const saved = new Accessibility({
    reduceMotion: true, fontScale: 1.3, shakeScale: 0.5, longPressMs: 900,
  });
  const reloaded = new Accessibility();
  reloaded.importState(saved.exportState());
  console.log(
    `\n  导出→导入后：fontScale=${reloaded.fontScale} ` +
    `shakeScale=${reloaded.shakeScale} longPressMs=${reloaded.longPressMs}`
  );

  let calls = 0;
  const ui = new Accessibility({ onChange: () => { calls++; } });
  ui.setReduceMotion(true);
  ui.destroy();
  ui.setFontScale(1.2);
  console.log(`  destroy() 之后再改设置，onChange 触发次数：${calls}（应为 1）`);
  console.log(
    '\n  → onChange 通常闭包引用着 UI 节点，不断开就是"切几次设置界面涨几 MB"。\n' +
    '    这个单元没有 install / 没有定时器，看着"没什么可清理的"，\n' +
    '    真正要清的就是这一个引用。'
  );

  console.log('\n════════════════════════════════════════════════');
  console.log('  小结：a11y 的价值不在"少几个特效"，');
  console.log('  而在于"影响面"有一个地方可以查、可以改、可以被测试锁住。');
  console.log('════════════════════════════════════════════════\n');
}

/**
 * 【为什么要 declare 而不是 import】
 * 本库运行时依赖为 0，不能为了"能直接 node 跑"就引入 @types/node。
 * 与 `examples/p0-usage.ts` 保持同一写法：只声明用到的那两个名字。
 */
declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== 'undefined' && require?.main === module) {
  main();
}

export { main };
