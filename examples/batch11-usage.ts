/**
 * examples/batch11-usage.ts —— 第十批插件的集成示例
 *
 * 【这个示例展示什么】
 *
 * 这一批是把"肉鸽该有的、但之前漏掉的东西"补齐：
 *
 * ```
 * ① 三选一的权重 —— 稀有遗物不该和普通遗物一样常见
 * ② 局内 / 局外数据隔离 —— 死亡后必须清干净，永久货币必须留下
 * ③ 装备套装 —— N 件套，含"叠加还是只生效最高档"的分歧
 * ④ 每日挑战 —— 全球同一天同一张图，且能分享给朋友
 * ⑤ 排行榜 —— 并列名次、只留最好成绩、分页
 * ```
 *
 * 【运行】
 * ```bash
 * npm run example:batch11
 * ```
 */

import { Chest } from '../loot/Chest';
import { RNG } from '../rng/RNG';
import { ScopedStore, keys, key } from '../runscope/ScopedStore';
import { SetBonusSystem } from '../setbonus/SetBonus';
import { DailyChallenge } from '../daily/DailyChallenge';
import { Leaderboard } from '../leaderboard/Leaderboard';

function hr(title: string): void {
  console.log(`\n${'═'.repeat(66)}\n  ${title}\n${'═'.repeat(66)}`);
}

// ============================================================
// ① 三选一的权重
// ============================================================

function demoWeightedChest(): void {
  hr('① 三选一的权重：稀有遗物不该和普通遗物一样常见');

  type Relic = { id: string; name: string; rarity: 'common' | 'rare' | 'legendary' };
  const RARITY_WEIGHT: Record<Relic['rarity'], number> = {
    common: 100, rare: 15, legendary: 2,
  };

  const pool: Relic[] = [
    { id: 'c1', name: '磨刀石', rarity: 'common' },
    { id: 'c2', name: '皮甲', rarity: 'common' },
    { id: 'c3', name: '草鞋', rarity: 'common' },
    { id: 'c4', name: '护符', rarity: 'common' },
    { id: 'r1', name: '吸血匕首', rarity: 'rare' },
    { id: 'r2', name: '火焰披风', rarity: 'rare' },
    { id: 'r3', name: '荆棘之甲', rarity: 'rare' },
    { id: 'l1', name: '时间沙漏', rarity: 'legendary' },
    { id: 'l2', name: '死神镰刀', rarity: 'legendary' },
  ];

  console.log('\n【权重表】');
  for (const [k, v] of Object.entries(RARITY_WEIGHT)) {
    console.log(`  ${k.padEnd(12)} ${v}`);
  }

  function sample(label: string, weightOf?: (r: Relic) => number): void {
    const chest = new Chest(pool, { count: 3, weightOf });
    const count: Record<string, number> = {};
    const N = 3000;
    for (let i = 0; i < N; i++) {
      chest.reset();
      for (const r of chest.roll(new RNG(i * 7919 + 13))) {
        count[r.rarity] = (count[r.rarity] ?? 0) + 1;
      }
    }
    const total = Object.values(count).reduce((a, b) => a + b, 0);
    console.log(`\n  ${label}`);
    for (const k of ['common', 'rare', 'legendary'] as const) {
      const n = count[k] ?? 0;
      const pct = (n / total) * 100;
      const bar = '█'.repeat(Math.round(pct / 2));
      console.log(`    ${k.padEnd(11)} ${pct.toFixed(1).padStart(5)}%  ${bar}`);
    }
  }

  sample('【不加权】三种稀有度几乎一样常见：');
  sample('【加权】传说极其罕见：', (r) => RARITY_WEIGHT[r.rarity]);

  console.log(`
  【⚠️ 一个必须知道的陷阱：不放回 ≠ 独立抽取】

  上面的百分比是"每次三选一时，某稀有度出现在选项里的比例"。
  注意传说即使权重只有 2，出现率也远高于 2/117。

  因为抽 3 个 = 传说了 3 次机会。

  配表时的换算（池子 n 个、抽 k 个、目标权重 w、总权重 W）：
    单个位置选中 ≈ w / W
    整批至少出现一次 ≈ 1 - C(n-1,k)/C(n,k)   （等权时）
    加权时要用"不含该物的抽取概率"逐次累乘

  所以：你按"传说权重 2"配表，玩家实际每层见到传说的概率
  远高于你的直觉。想控制体验，要按整批出现率反推权重。`);
}

// ============================================================
// ② 局内外数据隔离
// ============================================================

function demoScopedStore(): void {
  hr('② 局内 / 局外数据隔离：串档 bug 的根源');

  const store = new ScopedStore({
    schema: {
      ...keys('run', { gold: 0, floor: 1, relics: [] as string[] }),
      ...keys('meta', { souls: 0, totalRuns: 0, unlocked: [] as string[] }),
      fps: key('session', 60, '当前帧率'),
    },
  });

  console.log('\n【三域声明】');
  console.log(store.describe());

  console.log('\n【局外：只能碰永久数据和会话数据】');
  store.set('souls', 120);
  store.set('fps', 144);
  console.log(`  永久灵魂 ${store.get('souls')}，帧率 ${store.get('fps')}`);

  try {
    store.get('gold');
  } catch (e) {
    console.log(`  读取局内金币 → ✗ ${(e as Error).message.slice(0, 48)}…`);
  }

  console.log('\n【第 1 局】');
  store.beginRun();
  store.set('gold', 500);
  store.set('floor', 5);
  store.set('relics', ['吸血匕首', '火焰披风']);
  store.set('souls', 180);   // 局内获得的永久货币，立刻记账
  console.log(`  金币 ${store.get('gold')}，层数 ${store.get('floor')}`);
  console.log(`  遗物 ${(store.get('relics') as string[]).join('、')}`);
  console.log(`  灵魂 ${store.get('souls')}（局内获得，属于永久）`);

  console.log('\n【死亡 → endRun】');
  store.endRun();
  store.set('totalRuns', 1);
  console.log(`  总场次 ${store.get('totalRuns')}`);
  console.log(`  灵魂 ${store.get('souls')} ← 保留了`);
  console.log(`  帧率 ${store.get('fps')} ← 会话数据不受影响`);

  console.log('\n【第 2 局：局内数据必须是干净的】');
  store.beginRun();
  console.log(`  金币 ${store.get('gold')}（应为 0）`);
  console.log(`  层数 ${store.get('floor')}（应为 1）`);
  console.log(`  遗物 ${JSON.stringify(store.get('relics'))}（应为空）`);
  console.log(`  灵魂 ${store.get('souls')}（应为 180，不是 0）`);

  console.log(`
  【为什么"局外访问局内数据"必须抛错】

  靠命名约定（run_gold / meta_souls）防不住串档，
  你总会有一天忘记前缀。

  抛错把"悄悄读到脏数据"变成"启动时立刻崩溃"：
  - 脏数据：玩家玩到第 3 层才发现金币不对，你查三小时
  - 抛错： 开发时第一次跑就崩，堆栈直接指到那一行`);

  console.log('\n【存档内容】');
  const snap = store.exportSave();
  console.log(`  meta: ${JSON.stringify(snap.meta)}`);
  console.log(`  run:  ${JSON.stringify(snap.run)}`);
  console.log(`  fps 不在其中 —— 会话数据不进存档`);
}

// ============================================================
// ③ 装备套装
// ============================================================

function demoSetBonus(): void {
  hr('③ 装备套装：叠加还是只生效最高档？');

  const defs = [{
    id: 'flame',
    name: '烈焰',
    thresholds: [
      { count: 2, effects: [{ stat: 'atk', op: 'mul' as const, value: 1.10 }], desc: '攻击 +10%' },
      { count: 4, effects: [
        { stat: 'atk', op: 'mul' as const, value: 1.25 },
        { stat: 'cdr', op: 'add' as const, value: 0.15 },
      ], desc: '攻击 +25%，冷却缩减 +15%' },
    ],
  }];

  const slots = ['head', 'chest', 'hands', 'legs'];

  function run(cumulative: boolean): void {
    console.log(`\n  【${cumulative ? '叠加模式（暗黑 3 式）' : '仅最高档（WoW 式）'}】`);
    for (let n = 1; n <= 4; n++) {
      const s = new SetBonusSystem({ sets: defs, cumulative });
      for (let i = 0; i < n; i++) {
        s.equip({ id: `flame_${slots[i]}`, set: 'flame', slot: slots[i] });
      }
      const active = s.activeThresholds().map((a) => a.count);
      const sum = s.summary();
      const atk = sum['atk.mul'];
      const cdr = sum['cdr.add'];
      console.log(
        `    ${n} 件 → 激活档 [${active.join(',') || '无'}]  ` +
        `攻击 ×${atk === undefined ? '1.000' : atk.toFixed(3)}` +
        `${cdr !== undefined ? `  冷却 +${(cdr * 100).toFixed(0)}%` : ''}`
      );
    }
  }

  run(false);
  run(true);

  console.log(`
  【这个选择会显著改变数值曲线】

  仅最高档：4 件 = ×1.25
  叠加：    4 件 = ×1.10 × ×1.25 = ×1.375（高出 10%）

  配表时必须按**叠加后的实际值**来平衡，
  只看单档数值会低估满套装的强度。`);

  console.log('  【部位去重：同槽位自动替换】');
  const s = new SetBonusSystem({ sets: defs });
  s.equip({ id: 'flame_head', set: 'flame', slot: 'head' });
  const replaced = s.equip({ id: 'plain_head', slot: 'head' });
  console.log(`    换上非套装头盔 → 被替换：${replaced?.id}`);
  console.log(`    烈焰件数 ${s.countFor('flame')}（应为 0，不是 1）`);
  console.log(`    ↑ 若同槽位能共存两件，卸下一件时另一件还在，`);
  console.log(`      效果就不会正确移除——这是套装系统最常见的 bug`);
}

// ============================================================
// ④ 每日挑战
// ============================================================

function demoDaily(): void {
  hr('④ 每日挑战：全球同一天同一张图');

  const daily = new DailyChallenge({
    timezone: 'utc',
    modifierCount: 2,
    recordMode: 'first',
    modifiers: [
      { id: 'swift', name: '迅捷', desc: '敌人移速 +20%', effects: [{ stat: 'spd', op: 'mul', value: 1.2 }] },
      { id: 'tough', name: '坚韧', desc: '敌人血量 +30%', effects: [{ stat: 'hp', op: 'mul', value: 1.3 }] },
      { id: 'fragile', name: '脆弱', desc: '受伤 +50%', effects: [{ stat: 'dmgTaken', op: 'mul', value: 1.5 }] },
      { id: 'rich', name: '富饶', desc: '金币翻倍', effects: [{ stat: 'gold', op: 'mul', value: 2 }] },
      { id: 'cursed', name: '诅咒', desc: '每层失去 1 点最大生命', effects: [{ stat: 'maxHp', op: 'add', value: -1 }] },
    ],
  });

  console.log('\n【连续 8 天的挑战】');
  console.log('  日期          种子文本        修饰符');
  for (let d = 1; d <= 8; d++) {
    const date = `2024-03-${String(d).padStart(2, '0')}`;
    const e = daily.entryFor(date);
    const mods = e.modifiers.map((m) => m.name).join(' + ');
    console.log(`  ${date}  ${e.seedText.padEnd(14)}  ${mods}`);
  }

  console.log(`
  【为什么日期不能直接当种子】
  2024-03-01 和 2024-03-02 只差一个字符。
  直接把字符码相加，相邻两天的种子只差 1，
  而 PRNG 对相邻种子的输出高度相关 ——
  表现为"连续几天的关卡几乎一样"，玩家会以为你偷懒。

  本模块做 FNV-1a + 三轮额外混合，改一个字符就彻底发散。`);

  console.log('  【时区：UTC vs 本地】');
  const ms = Date.UTC(2024, 0, 1, 23, 30);
  console.log(`    2024-01-01 23:30 UTC`);
  console.log(`      UTC 日期   → ${daily.todayKey(ms)}`);
  const localDaily = new DailyChallenge({ timezone: 8, modifierCount: 0 });
  console.log(`      东八区日期 → ${localDaily.todayKey(ms)}（已是次日）`);
  console.log(`    ↑ 用本地时间的话，澳洲玩家比美国玩家早 15 小时拿到新挑战，`);
  console.log(`      排行榜的可比性就没了。所以默认 utc。`);

  console.log('\n  【分享与回填】');
  const entry = daily.entryFor('2024-03-15');
  console.log(`    今日：${entry.seedText}`);
  const back = daily.fromText(entry.seedText);
  console.log(`    朋友输入同一文本 → 种子 ${back?.seed === entry.seed ? '一致 ✓' : '不一致 ✗'}`);
  console.log(`    修饰符 ${back?.modifiers.map((m) => m.name).join(' + ')}`);
  console.log(`    ↑ 这是每日挑战社交功能的正确性根基。`);
  console.log(`      曾因"先生成种子再转文本"导致回填得到不同关卡。`);

  console.log('\n  【成绩与连续打卡】');
  const base = Date.UTC(2024, 5, 10, 12, 0);
  for (let i = 0; i < 3; i++) {
    const t = base - i * 86400000;
    daily.submit(daily.todayKey(t), 1000 + i * 100, true, t);
  }
  console.log(`    连续打卡 ${daily.streak(base)} 天`);
  console.log(`    recordMode=first：第二次提交不覆盖`);
  const before = daily.recordOf(daily.todayKey(base))?.score;
  daily.submit(daily.todayKey(base), 99999, true, base);
  console.log(`      提交 99999 后仍是 ${daily.recordOf(daily.todayKey(base))?.score}（原 ${before}）`);
}

// ============================================================
// ⑤ 排行榜
// ============================================================

function demoLeaderboard(): void {
  hr('⑤ 排行榜：并列名次与"附近的人"');

  const data = [
    { playerId: 'p1', name: '阿尔法', score: 9800, at: 100 },
    { playerId: 'p2', name: '贝塔', score: 9800, at: 200 },
    { playerId: 'p3', name: '伽马', score: 9500, at: 150 },
    { playerId: 'p4', name: '德尔塔', score: 9500, at: 160 },
    { playerId: 'p5', name: '艾普', score: 9100, at: 120 },
    { playerId: 'p6', name: '泽塔', score: 8700, at: 130 },
  ];

  for (const mode of ['dense', 'competition', 'ordinal'] as const) {
    const lb = new Leaderboard({ rankMode: mode });
    lb.submitAll(data);
    console.log(`\n  【${mode} 排名】`);
    for (const e of lb.ranked()) {
      console.log(`    第 ${e.rank} 名  ${String(e.score).padStart(5)}  ${e.name}`);
    }
  }

  console.log(`
  【该选哪种】
    dense       1,1,2  —— 玩家最容易理解，推荐
    competition 1,1,3  —— 体育竞赛式，跳过名次
    ordinal     1,2,3  —— 永不并列，同分靠时间分先后`);

  console.log('  【只保留最好成绩】');
  const lb = new Leaderboard({ capacity: 100 });
  lb.submit({ playerId: 'me', name: '我', score: 500, at: 1 });
  lb.submit({ playerId: 'me', name: '我', score: 1200, at: 2 });
  lb.submit({ playerId: 'me', name: '我', score: 800, at: 3 });
  console.log(`    提交了 3 次（500 / 1200 / 800），榜单条数 ${lb.size}`);
  console.log(`    保留 ${lb.rankOf('me')?.score}`);
  console.log(`    ↑ 关掉这个的话，一个刷 100 次的玩家会占掉整个榜单`);

  console.log('\n  【附近的人（第 500 名也有存在感）】');
  const big = new Leaderboard();
  for (let i = 1; i <= 60; i++) {
    big.submit({ playerId: `p${i}`, name: `玩家${i}`, score: 10000 - i * 100, at: i });
  }
  const around = big.around('p30', 3);
  console.log(`    玩家30 排第 ${big.rankOf('p30')?.rank} 名，他看到的是：`);
  for (const e of around) {
    const mark = e.playerId === 'p30' ? '  ← 我' : '';
    console.log(`      第 ${String(e.rank).padStart(2)} 名  ${e.name}${mark}`);
  }

  console.log('\n  【分页：名次必须在分页前算好】');
  const p2 = big.page(2, 5);
  console.log(`    第 2 页（每页 5 条），第一名是总第 ${p2.entries[0].rank} 名`);
  console.log(`    ↑ 先切片再排名的话，这里会显示成第 1 名`);
}

// ============================================================
// 主函数
// ============================================================

function main(): void {
  console.log('╔' + '═'.repeat(66) + '╗');
  console.log('║' + '  cocos-kit 第十批插件集成示例'.padEnd(58) + '║');
  console.log('║' + '  Chest 加权 / runscope / setbonus / daily / leaderboard'.padEnd(58) + '║');
  console.log('╚' + '═'.repeat(66) + '╝');

  demoWeightedChest();
  demoScopedStore();
  demoSetBonus();
  demoDaily();
  demoLeaderboard();

  hr('总结');
  console.log(`
  这一批补的是"肉鸽该有、但容易漏掉"的东西。

  ┌──────────────┬─────────────────────────────────┐
  │ Chest 加权    │ 稀有度的意义在于稀有             │
  │ runscope     │ 死亡后清干净，永久的留下         │
  │ setbonus     │ 叠加还是只生效最高档，必须选     │
  │ daily        │ 全球同一天同一张图，且能分享     │
  │ leaderboard  │ 并列的名次、只留最好成绩         │
  └──────────────┴─────────────────────────────────┘

  其中 runscope 的机制值得单独说：
  它把"靠命名约定防串档"换成了"状态机 + 越界抛错"。

  命名约定防不住——你总会有一天忘记前缀。
  抛错把"玩家玩到第 3 层才发现金币不对，你查三小时"
  变成"开发时第一次跑就崩，堆栈直接指到那一行"。

  这正是快速失败的价值：让错误在最便宜的时刻暴露。
`);
}

main();
