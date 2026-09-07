/**
 * examples/subtitle-usage.ts —— subtitle 单元的可运行示例
 *
 * 【为什么单独补这个文件】
 *
 * 全库 119 个单元里，subtitle 是**唯一**一个在 `examples/` 中
 * 完全没有可运行示例的单元（其余单元都能在 examples/ 下找到引用）。
 *
 * 违反的是 rule7「每个插件自带 README + 测试 + 示例」。
 * 后果比"少个文件"严重：字幕用法里有三处反直觉的地方，
 * 只靠读源码几乎一定会踩——
 *
 *   1. 时间单位是**毫秒**，按秒传则字幕永远不显示且不报错
 *   2. `at()` 返回**数组**（画外音和对话重叠是常态），不是单条
 *   3. `skipToNext()` 跳到"下一条的开始"而不是"当前条的结束"
 *
 * 这三条在 README 里都写了，但**没有能跑起来的代码**，
 * 使用者仍然会在自己工程里原样踩一遍。
 *
 * 【这个例子演示什么】
 * 一段 4 秒的剧情对话，覆盖：
 *
 *   - SRT 文本解析（自动提取【角色名】）
 *   - 每帧查询当前该显示哪些行（含重叠）
 *   - 说话人显示名 / 颜色的解析
 *   - 打字机进度 progress
 *   - 跳跃：连点跳过时逐条前进
 *   - 导出回 SRT（本地化 / 配音回写）
 *
 * 【运行】
 *   npx tsc -p tsconfig.json && node .build/examples/subtitle-usage.js
 */

import {
  SubtitleTrack,
  parseSRT,
  toSRT,
} from '../subtitle/Subtitle';

// ============================================================
// 极简自检（examples/ 不引 Node 类型，手写最小断言）
// ============================================================

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ============================================================
// ① 从 SRT 文本解析（也支持手工构造 lines）
// ============================================================

console.log('\n=== ① SRT 解析（自动提取【角色名】）===');

const srtText = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  '【勇者】出发吧，天亮之前要赶到王城。',
  '',
  '2',
  '00:00:01,500 --> 00:00:03,500',
  '【村民】路上有埋伏，小心。',
  '',
  '3',
  '00:00:03,000 --> 00:00:04,000',
  '（远处传来雷声）',
  '',
].join('\n');

const parsed = parseSRT(srtText);
check('解析出 3 条', parsed.length === 3, `实际 ${parsed.length}`);
check('第 1 条提取出说话人', parsed[0]?.speaker === '勇者', String(parsed[0]?.speaker));
check('第 1 条去掉了【】前缀', parsed[0]?.text === '出发吧，天亮之前要赶到王城。', parsed[0]?.text);
check('旁白没有说话人', parsed[2]?.speaker === undefined, String(parsed[2]?.speaker));
check(
  '毫秒单位正确（,000 → 0ms）',
  parsed[0]?.start === 0 && parsed[0]?.end === 2000,
  `${parsed[0]?.start}~${parsed[0]?.end}`
);

// ============================================================
// ② 每帧查询：重点看"重叠"和"毫秒"
// ============================================================

console.log('\n=== ② 每帧查询（时间单位是毫秒）===');

const track = new SubtitleTrack({
  lines: parsed,
  speakers: {
    勇者: { name: '勇者·阿伦', color: '#4CAF50' },
    村民: { name: '村民', color: '#2196F3' },
  },
});

/**
 * 【⚠️ 这是本单元第一大坑】
 * `at()` 的入参是**毫秒**。按秒传（比如 `at(1)`）时，
 * 半开区间 `[start, end)` 匹配不上任何行，
 * 字幕**永远不显示，而且不报错**。
 */
// 用一条 1000ms 才开始的行，直观对比"按秒传"和"按毫秒传"
const late = new SubtitleTrack({
  lines: [{ start: 1000, end: 3000, text: '一秒后才出现' }],
});
check('at(1) 只有 1 毫秒 → 命中 0 条（按秒传的后果）', late.at(1).length === 0);
check('at(1000) 才是 1 秒 → 命中 1 条', late.at(1000).length === 1);

// 1.8 秒处：勇者的第 1 条（0~2000）和村民的第 2 条（1500~3500）同时在播
const both = track.at(1800);
check('重叠时刻返回 2 条（画外音 + 对话）', both.length === 2, `实际 ${both.length}`);
check(
  '说话人显示名来自 speakers 配置',
  both[0].speakerLabel === '勇者·阿伦' && both[1].speakerLabel === '村民',
  JSON.stringify(both.map((a) => a.speakerLabel))
);
check('说话人颜色来自配置', both[0].speakerColor === '#4CAF50', String(both[0].speakerColor));

// 3.2 秒处：村民那句还没完，旁白已经进来
const overlap2 = track.at(3200);
check('旁白与对话重叠也能同时返回', overlap2.length === 2, `实际 ${overlap2.length}`);
check('旁白没有说话人标签', overlap2[1].speakerLabel === null, String(overlap2[1].speakerLabel));

// ============================================================
// ③ 打字机进度
// ============================================================

console.log('\n=== ③ progress（打字机效果）===');

const [first] = track.at(1000);
check('播到一半时 progress ≈ 0.5', Math.abs(first.progress - 0.5) < 1e-6, String(first.progress));
check('elapsed 是已播毫秒', first.elapsed === 1000, String(first.elapsed));

// ============================================================
// ④ 跳跃：连点跳过时逐条前进
// ============================================================

console.log('\n=== ④ 跳跃（跳到"下一条的开始"）===');

/**
 * 【⚠️ 第二大坑】
 * `skipToNext()` 跳到**下一条的开始**，不是当前条的结束。
 * 两条之间有空档时，用"当前结束时间"会让玩家干等一段空白。
 */
let t = 0;
const visited: string[] = [];
for (let i = 0; i < 5; i++) {
  const act = track.at(t);
  if (act.length === 0) break;
  visited.push(act[0].line.text);
  const next = track.skipToNext(t);
  if (next === t) break;          // 已经到最后一条
  t = next;
}
check('逐条跳过了 3 条', visited.length === 3, JSON.stringify(visited));

/**
 * 【⚠️ 第三大坑】
 * `nextIndex()` 用 `-1` 表示"后面没有了"，而 `-1` 是**真值**。
 * `if (track.nextIndex(t))` 在播完时反而会走进分支——必须显式判 `>= 0`。
 */
check('播完后 nextIndex 返回 -1', track.nextIndex(999999) === -1);
check('-1 是布尔真值（别当布尔用）', Boolean(track.nextIndex(999999)) === true);

// ============================================================
// ⑤ 导出回 SRT（本地化 / 配音回写）
// ============================================================

console.log('\n=== ⑤ 导出回 SRT ===');

const back = toSRT(track.lines);
check('导出的文本含时间轴', back.includes('00:00:02,000'));
check('导出的文本含【说话人】', back.includes('【勇者】'));
const reparsed = parseSRT(back);
check('导出→再解析行数一致', reparsed.length === track.lines.length);

// ============================================================
// ⑥ 长字幕下 at() 的性能（二分 + 前缀最大值）
// ============================================================

console.log('\n=== ⑥ 长字幕性能 ===');

const longLines = [];
for (let i = 0; i < 3000; i++) {
  longLines.push({ start: i * 1000, end: i * 1000 + 500, text: `第 ${i} 行` });
}
const longTrack = new SubtitleTrack({ lines: longLines });
const tail = 2900 * 1000;
const t0 = Date.now();
for (let f = 0; f < 600; f++) longTrack.at(tail + f * 16);
const ms = Date.now() - t0;
check('3000 行 × 600 次查询在 20ms 内', ms < 20, `实际 ${ms}ms`);
check('长字幕末尾仍能查到', longTrack.at(tail + 100).length === 1);

// ============================================================
// 收尾
// ============================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  throw new Error(`示例自检失败 ${failed} 项`);
}
console.log('全部通过 ✓');
