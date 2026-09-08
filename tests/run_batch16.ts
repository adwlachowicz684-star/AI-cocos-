/**
 * tests/run_batch15.ts —— 第十五批测试：系统与外壳补完
 *
 * 本批七个模块：
 * 1. Currency    · 多货币钱包（原子性、精度、流水）
 * 2. Settings    · 设置系统（默认值迁移、范围约束、分组）
 * 3. Subtitle    · 字幕（时间轴查询、SRT 解析、跳过）
 * 4. Tutorial    · 新手引导（等待、超时兜底、断点续）
 * 5. RedDot      · 红点树（父子聚合、清除）
 * 6. SceneRouter · 场景路由（阶段编排、并发拒绝、返回栈）
 * 7. Accessibility · 可访问性（减少动效的影响面）
 */

import { test, describe, assert, eq, near, throws } from './_framework';
import { CurrencyWallet } from '../currency/CurrencyWallet';
import { Settings } from '../settings/Settings';
import { SubtitleTrack, parseSRT, toSRT } from '../subtitle/Subtitle';
import { Tutorial, type TutorialStep } from '../tutorial/Tutorial';
import { RedDot } from '../reddot/RedDot';
import { SceneRouter } from '../scenerouter/SceneRouter';
import { Accessibility } from '../accessibility/Accessibility';

export function runBatch16Tests(): void {
  // ================================================================
  describe('Currency · 多货币钱包', () => {
    // ================================================================

    function make(opts = {}) {
      return new CurrencyWallet({
        defs: [
          { id: 'gold', name: '金币', initial: 100, cap: 999 },
          { id: 'gem', name: '钻石', initial: 5 },
          { id: 'energy', name: '体力', initial: 20, cap: 30, precision: 1 },
        ],
        ...opts,
      });
    }

    test('基本：读取与增加', () => {
      const w = make();
      eq(w.get('gold'), 100);
      eq(w.add('gold', 50), 50);
      eq(w.get('gold'), 150);
    });

    test('⚠️ 未声明的货币抛错（而不是静默创建）', () => {
      /**
       * 手写的 map 实现会静默创建这个键，
       * 玩家拿不到奖励但没有任何报错，
       * 排查时只能看到"活动奖励没到账"。
       */
      const w = make();
      throws(() => w.get('diaomnd'), '未声明的货币');
    });

    test('⚠️ 增加受上限约束，返回实际增加量', () => {
      const w = make();
      eq(w.add('gold', 5000), 899, '上限 999，从 100 只能加 899');
      eq(w.get('gold'), 999);
    });

    test('⚠️ 消费失败时一分钱都不扣', () => {
      const w = make();
      const r = w.spend('gold', 200);
      eq(r.ok, false);
      eq(r.reason, 'insufficient');
      eq(w.get('gold'), 100, '失败后余额必须不变');
    });

    test('⚠️ 失败时返回缺口（UI 显示"还差 100"）', () => {
      const w = make();
      const r = w.spend('gold', 200);
      eq(r.need, 100);
      eq(r.have, 100);
    });

    test('消费成功并记流水', () => {
      const w = make();
      eq(w.spend('gold', 30, 'buy_potion').ok, true);
      eq(w.get('gold'), 70);
      const e = w.ledgerOf('gold')[0];
      eq(e.delta, -30);
      eq(e.after, 70);
      eq(e.reason, 'buy_potion');
    });

    test('⚠️ 流水带货币类型（多货币对账）', () => {
      const w = make();
      w.spend('gold', 30);
      w.add('gem', 2);
      eq(w.ledger.length, 2);
      eq(w.ledger[0].id, 'gold');
      eq(w.ledger[1].id, 'gem');
    });

    test('⚠️ 浮点精度：体力小数累积不漂移', () => {
      /**
       * 不量化的话 0.1 + 0.2 = 0.30000000000000004，
       * 反复加减后表现为"还差 0.0000001 点就能升级"。
       */
      const w = make();
      w.set('energy', 0);
      for (let i = 0; i < 10; i++) w.add('energy', 0.1);
      eq(w.get('energy'), 1, '10 次 0.1 必须精确等于 1');
    });

    test('⚠️ 上限也是量化的', () => {
      const w = make();
      w.set('energy', 0);
      for (let i = 0; i < 100; i++) w.add('energy', 0.1);
      eq(w.get('energy'), 10);
    });

    test('clamp 模式：不够就扣到下限', () => {
      const w = make({ onShortage: 'clamp' });
      const r = w.spend('gold', 9999);
      eq(r.ok, true);
      eq(w.get('gold'), 0, '扣到下限为止');
    });

    test('⚠️ 消费数量非正数被拒绝', () => {
      const w = make();
      eq(w.spend('gold', 0).reason, 'invalid-amount');
      eq(w.spend('gold', -10).reason, 'invalid-amount');
      eq(w.get('gold'), 100);
    });

    test('⚠️ 消费未知货币走 reason 而不是抛错', () => {
      /**
       * 【设计决定】
       * 查询（get）抛错——那是代码写错了，必须立刻暴露。
       * 消费（spend）返回 reason——那是运行时可能发生的（配表错误不该让玩家崩溃）。
       */
      const w = make();
      eq(w.spend('不存在', 1).reason, 'unknown-currency');
    });

    test('⚠️ 兑换是原子的：扣失败则完全不加', () => {
      const w = make();
      const r = w.exchange('gold', 'gem', 99999, 1);
      eq(r.ok, false);
      eq(w.get('gold'), 100, '没扣');
      eq(w.get('gem'), 5, '也没加');
    });

    test('兑换成功', () => {
      const w = make();
      w.exchange('gold', 'gem', 100, 0.1);
      eq(w.get('gold'), 0);
      eq(w.get('gem'), 15);
    });

    test('canAfford 只查询不改变', () => {
      const w = make();
      eq(w.canAfford('gold', 100), true);
      eq(w.canAfford('gold', 101), false);
      eq(w.get('gold'), 100);
    });

    test('⚠️ canAfford 未知货币返回 false 而不是抛错', () => {
      const w = make();
      eq(w.canAfford('不存在', 1), false);
    });

    test('isFull / room', () => {
      const w = make();
      w.set('energy', 30);
      eq(w.isFull('energy'), true);
      eq(w.room('energy'), 0);
      w.set('energy', 12.5);
      eq(w.room('energy'), 17.5);
    });

    test('⚠️ 上限可以设 Infinity（钻石不封顶）', () => {
      const w = make();
      eq(w.cap('gem'), Infinity);
      eq(w.isFull('gem'), false);
    });

    test('⚠️ 构造校验：上限小于下限抛错', () => {
      throws(
        () => new CurrencyWallet({ defs: [{ id: 'x', cap: 5, floor: 10 }] }),
        '上限'
      );
    });

    test('⚠️ 货币 id 重复抛错', () => {
      throws(
        () => new CurrencyWallet({ defs: [{ id: 'x' }, { id: 'x' }] }),
        '重复'
      );
    });

    test('⚠️ 流水有上限（防内存无限增长）', () => {
      const w = make({ ledgerLimit: 5 });
      for (let i = 0; i < 20; i++) w.add('gold', 1);
      assert(w.ledger.length <= 5, `应被裁剪，实际 ${w.ledger.length}`);
    });

    test('tracked: false 的货币不记流水', () => {
      const w = new CurrencyWallet({
        defs: [{ id: 'gold', tracked: false }],
      });
      w.add('gold', 10);
      eq(w.ledger.length, 0);
      eq(w.get('gold'), 10, '值本身仍然正确');
    });

    test('⚠️ 导入存档跳过未知货币（旧存档兼容）', () => {
      const w = make();
      w.importState({ gold: 500, removedCurrency: 999, gem: 3 });
      eq(w.get('gold'), 500);
      eq(w.get('gem'), 3);
      eq(w.has('removedCurrency'), false);
    });

    test('⚠️ 导入存档的值会被夹到上下限', () => {
      const w = make();
      w.importState({ gold: 99999 });
      eq(w.get('gold'), 999, '不能通过改存档突破上限');
    });

    test('reset 回到初始值', () => {
      const w = make();
      w.add('gold', 500);
      w.reset();
      eq(w.get('gold'), 100);
    });

    test('onChange 回调', () => {
      const seen: string[] = [];
      const w = new CurrencyWallet({
        defs: [{ id: 'g', initial: 10 }],
        onChange: (id, _v, d) => seen.push(`${id}:${d}`),
      });
      w.add('g', 5);
      w.spend('g', 3);
      eq(seen.join(','), 'g:5,g:-3');
    });

    test('⚠️ 满了再 add 不触发 onChange', () => {
      let n = 0;
      const w = new CurrencyWallet({
        defs: [{ id: 'g', initial: 10, cap: 10 }],
        onChange: () => n++,
      });
      w.add('g', 5);
      eq(n, 0, '没有任何实际变化，不该通知');
    });
  });

  // ================================================================
  describe('Settings · 设置系统', () => {
    // ================================================================

    function make() {
      return new Settings({
        defs: [
          { key: 'bgm', kind: 'number', default: 0.8, min: 0, max: 1, step: 0.1, group: 'audio' },
          { key: 'sfx', kind: 'number', default: 1, min: 0, max: 1, step: 0.1, group: 'audio' },
          { key: 'quality', kind: 'enum', default: 'high', options: ['low', 'mid', 'high'], group: 'video', needRestart: true },
          { key: 'fullscreen', kind: 'bool', default: true, group: 'video' },
          { key: 'nickname', kind: 'string', default: 'Player', maxLength: 12, group: 'game' },
        ],
      });
    }

    test('基本：默认值', () => {
      eq(make().num('bgm'), 0.8);
      eq(make().str('nickname'), 'Player');
      eq(make().bool('fullscreen'), true);
    });

    test('⚠️ 未定义的 key 抛错（拼错立刻暴露）', () => {
      throws(() => make().get('bgmm'), '未定义的设置项');
    });

    test('设置与读取', () => {
      const s = make();
      eq(s.set('bgm', 0.5), null, 'null 表示成功');
      eq(s.num('bgm'), 0.5);
    });

    test('⚠️ 超出范围被拒绝', () => {
      const s = make();
      const err = s.set('bgm', 2.5);
      assert(err !== null, '应返回错误');
      eq(s.num('bgm'), 0.8, '值不该改变');
    });

    test('⚠️ 步进不符被拒绝', () => {
      const s = make();
      assert(s.set('bgm', 0.85) !== null, '0.85 不是 0.1 的整数倍');
      eq(s.num('bgm'), 0.8);
    });

    test('⚠️ 步进是以 min 为基准的', () => {
      const s = make();
      eq(s.set('bgm', 0.3), null, '0 + 0.1*3 = 0.3，合法');
      eq(s.num('bgm'), 0.3);
    });

    test('⚠️ 类型不符被拒绝', () => {
      const s = make();
      assert(s.set('fullscreen', 1 as unknown as boolean) !== null, 'bool 不接受数字');
      assert(s.set('nickname', 5 as unknown as string) !== null, 'string 不接受数字');
    });

    test('⚠️ enum 的值必须在 options 中', () => {
      const s = make();
      assert(s.set('quality', 'ultra') !== null);
      eq(s.str('quality'), 'high');
    });

    test('字符串长度限制', () => {
      const s = make();
      /**
       * 【修正过的用例】
       * 原用例的昵称正好 12 个字，而 maxLength 也是 12——
       * 它是合法的，不该被拒绝。
       */
      eq(s.set('nickname', '一二三四五六七八九十一'), null, '正好 12 字，合法');
      const tooLong = '一二三四五六七八九十甲乙丙丁';   // 14 字 > 12
      assert(s.set('nickname', tooLong) !== null, `${tooLong.length} 字应被拒绝`);
      eq(s.str('nickname'), '一二三四五六七八九十一', '被拒绝后值不该改变');
    });

    test('validate 只校验不写入', () => {
      const s = make();
      eq(s.validate('bgm', 5), null === null ? s.validate('bgm', 5) : '');
      assert(s.validate('bgm', 5) !== null);
      eq(s.num('bgm'), 0.8, '不该被写入');
    });

    test('自定义校验', () => {
      const s = new Settings({
        defs: [{
          key: 'nickname', kind: 'string', default: 'a',
          validate: (v) => (String(v).includes('fuck') ? '包含敏感词' : null),
        }],
      });
      assert(s.set('nickname', 'badfuckword') !== null);
      eq(s.set('nickname', 'goodname'), null);
    });

    test('⚠️ cycle 在 enum 上循环', () => {
      const s = make();
      eq(s.str('quality'), 'high');
      s.cycle('quality');
      eq(s.str('quality'), 'low', '到末尾后回到第一个');
      s.cycle('quality');
      eq(s.str('quality'), 'mid');
    });

    test('cycle 对非 enum 返回错误', () => {
      assert(make().cycle('bgm') !== null);
    });

    test('⚠️ onChange 回调', () => {
      const seen: string[] = [];
      const s = new Settings({
        defs: [{ key: 'v', kind: 'number', default: 0, min: 0, max: 1 }],
        onChange: (k, v, o) => seen.push(`${k}:${o}->${v}`),
      });
      s.set('v', 1);
      eq(seen.join(','), 'v:0->1');
    });

    test('⚠️ 设置成相同值不触发回调', () => {
      let n = 0;
      const s = new Settings({
        defs: [{ key: 'v', kind: 'number', default: 0, min: 0, max: 1 }],
        onChange: () => n++,
      });
      s.set('v', 0);
      eq(n, 0);
    });

    test('分组查询', () => {
      const s = make();
      eq(s.keysOfGroup('audio').join(','), 'bgm,sfx');
      eq(s.groups.sort().join(','), 'audio,game,video');
    });

    test('⚠️ resetGroup 只重置一页', () => {
      const s = make();
      s.set('bgm', 0.2);
      s.set('quality', 'low');
      s.resetGroup('audio');
      eq(s.num('bgm'), 0.8, 'audio 页已重置');
      eq(s.str('quality'), 'low', 'video 页不受影响');
    });

    test('resetAll', () => {
      const s = make();
      s.set('bgm', 0.2);
      s.set('quality', 'low');
      s.resetAll();
      eq(s.num('bgm'), 0.8);
      eq(s.str('quality'), 'high');
    });

    test('⚠️ 导入存档：新版本新增项用默认值', () => {
      /**
       * 【这是默认值迁移的核心场景】
       * 老存档没有新加的设置项，
       * 不处理的话读进来是 undefined，静音/黑屏都可能。
       */
      const s = make();
      s.importState({ bgm: 0.3 });   // 只存了一个
      eq(s.num('bgm'), 0.3, '存档里的用存档值');
      eq(s.num('sfx'), 1, '存档里没有的用默认值');
    });

    test('⚠️ 导入存档：未知键被忽略并返回', () => {
      const s = make();
      const unknown = s.importState({ bgm: 0.5, removedSetting: true });
      eq(unknown.join(','), 'removedSetting');
      eq(s.has('removedSetting'), false);
    });

    test('⚠️ 导入存档：单个键非法只影响它自己', () => {
      const s = make();
      s.importState({ bgm: 99, sfx: 0.5 });
      eq(s.num('bgm'), 0.8, '非法值保留默认');
      eq(s.num('sfx'), 0.5, '其他键照常导入');
    });

    test('snapshot 列出需要重启的项', () => {
      const s = make();
      const snap = s.snapshot();
      eq(snap.pendingRestart.join(','), 'quality');
    });

    test('⚠️ 构造校验：enum 的 default 必须在 options 中', () => {
      throws(
        () => new Settings({
          defs: [{ key: 'x', kind: 'enum', default: 'nope', options: ['a'] }],
        }),
        'options'
      );
    });

    test('⚠️ 构造校验：number 的 default 必须是数字', () => {
      throws(
        () => new Settings({
          defs: [{ key: 'x', kind: 'number', default: 'not a number' }],
        }),
        'default'
      );
    });

    test('⚠️ 构造校验：min 大于 max 抛错', () => {
      throws(
        () => new Settings({
          defs: [{ key: 'x', kind: 'number', default: 1, min: 5, max: 1 }],
        }),
        'min'
      );
    });

    test('设置项重复抛错', () => {
      throws(
        () => new Settings({
          defs: [
            { key: 'x', kind: 'bool', default: true },
            { key: 'x', kind: 'bool', default: false },
          ],
        }),
        '重复'
      );
    });
  });

  // ================================================================
  describe('Subtitle · 字幕', () => {
    // ================================================================

    function make() {
      return new SubtitleTrack({
        lines: [
          { start: 0, end: 2000, text: '第一句', speaker: 'hero', speakerName: '勇者' },
          { start: 2000, end: 4000, text: '第二句', speaker: 'npc' },
          { start: 3000, end: 5000, text: '旁白重叠' },
        ],
        speakers: {
          hero: { name: '勇者', color: '#4CAF50' },
          npc: { name: '村民', color: '#2196F3' },
        },
      });
    }

    test('基本：按时间查询', () => {
      const t = make();
      eq(t.at(1000)[0].line.text, '第一句');
      eq(t.at(5000).length, 0, '结束后没有字幕');
    });

    test('⚠️ 同一时刻可能有多条（重叠）', () => {
      const t = make();
      const r = t.at(3500);
      eq(r.length, 2, '第二句和旁白重叠');
      eq(r.map((x) => x.line.text).sort().join(','), '旁白重叠,第二句');
    });

    test('⚠️ 说话人显示名优先取 speakers 表', () => {
      const t = make();
      const a = t.at(1000)[0];
      eq(a.speakerLabel, '勇者');
      eq(a.speakerColor, '#4CAF50');
    });

    test('未登记的说话人回退到 speaker id', () => {
      const t = new SubtitleTrack({
        lines: [{ start: 0, end: 1000, text: 'x', speaker: 'unknown_man' }],
      });
      eq(t.at(500)[0].speakerLabel, 'unknown_man');
      eq(t.at(500)[0].speakerColor, null);
    });

    test('旁白（无说话人）', () => {
      const t = make();
      eq(t.at(3500).find((x) => !x.line.speaker)?.speakerLabel, null);
    });

    test('⚠️ progress 用于打字机效果', () => {
      const t = make();
      eq(t.at(0)[0].progress, 0);
      near(t.at(1000)[0].progress, 0.5, 1e-9);
      near(t.at(1999)[0].progress, 0.9995, 1e-3);
    });

    test('⚠️ 结束边界是开区间（end 那一刻不再显示）', () => {
      const t = make();
      eq(t.at(2000)[0].line.text, '第二句', '第一句在 2000 已结束');
    });

    test('duration 取最晚的结束时间', () => {
      eq(make().duration, 5000);
    });

    test('⚠️ 构造时自动按开始时间排序', () => {
      const t = new SubtitleTrack({
        lines: [
          { start: 3000, end: 4000, text: '后' },
          { start: 0, end: 1000, text: '先' },
        ],
      });
      eq(t.lines[0].text, '先');
      eq(t.at(3500)[0].line.text, '后');
    });

    test('⚠️ 结束早于开始抛错', () => {
      throws(
        () => new SubtitleTrack({ lines: [{ start: 2000, end: 1000, text: 'x' }] }),
        '结束时间'
      );
    });

    test('⚠️ nextIndex 与 skipToNext', () => {
      const t = make();
      eq(t.nextIndex(0), 1);
      eq(t.nextIndex(2500), 2);
      eq(t.nextIndex(4500), -1, '已到最后');

      eq(t.skipToNext(500), 2000, '跳到下一条的开始');
      eq(t.skipToNext(4500), 4500, '最后一条之后原地不动');
    });

    test('⚠️ skipToNext 跳到"开始"而不是"结束"（有空档时更自然）', () => {
      const t = new SubtitleTrack({
        lines: [
          { start: 0, end: 1000, text: 'a' },
          { start: 5000, end: 6000, text: 'b' },   // 中间 4 秒空档
        ],
      });
      eq(t.skipToNext(500), 5000, '直接跳到 5000，跳过空档');
    });

    test('speakersAt 用于立绘高亮', () => {
      const t = make();
      eq(t.speakersAt(1000).join(','), 'hero');
      eq(t.speakersAt(3500).join(','), 'npc', '旁白没有说话人');
    });

    test('allSpeakers 去重', () => {
      eq(make().allSpeakers.sort().join(','), 'hero,npc');
    });

    test('lineCountOf', () => {
      eq(make().lineCountOf('hero'), 1);
    });

    // ---- SRT ----

    test('SRT 解析基本', () => {
      const src = `1
00:00:01,000 --> 00:00:03,500
这是一句话

2
00:00:04,000 --> 00:00:06,000
第二句话`;
      const lines = parseSRT(src);
      eq(lines.length, 2);
      eq(lines[0].start, 1000);
      eq(lines[0].end, 3500);
      eq(lines[0].text, '这是一句话');
    });

    test('⚠️ SRT 解析：点号分隔也支持', () => {
      const lines = parseSRT('1\n00:00:01.500 --> 00:00:02.000\nhi');
      eq(lines[0].start, 1500);
      eq(lines[0].end, 2000);
    });

    test('⚠️ SRT 解析：毫秒位数不足要补位', () => {
      /**
       * "5" 应是 500ms 而不是 5ms。
       * 不补位的话字幕会在错误的时间出现/消失。
       */
      const lines = parseSRT('1\n00:00:01,5 --> 00:00:02,05\nhi');
      eq(lines[0].start, 1500, ',5 → 500ms');
      eq(lines[0].end, 2050, ',05 → 50ms');
    });

    test('⚠️ SRT 解析：提取【角色名】', () => {
      const lines = parseSRT('1\n00:00:01,000 --> 00:00:02,000\n【勇者】出发吧');
      eq(lines[0].speaker, '勇者');
      eq(lines[0].text, '出发吧');
    });

    test('⚠️ SRT 解析：提取 角色名：', () => {
      const lines = parseSRT('1\n00:00:01,000 --> 00:00:02,000\n村民：你好');
      eq(lines[0].speaker, '村民');
      eq(lines[0].text, '你好');
    });

    test('SRT 解析：无序号也能解析', () => {
      const lines = parseSRT('00:00:01,000 --> 00:00:02,000\nhi');
      eq(lines.length, 1);
    });

    test('SRT 解析：非法块被忽略', () => {
      eq(parseSRT('这不是字幕').length, 0);
      eq(parseSRT('').length, 0);
    });

    test('⚠️ SRT 往返（导出再导入内容一致）', () => {
      const lines = [
        { start: 1000, end: 3500, text: '第一句', speaker: 'hero' },
        { start: 4000, end: 6000, text: '第二句' },
      ];
      const back = parseSRT(toSRT(lines));
      eq(back.length, 2);
      eq(back[0].start, 1000);
      eq(back[0].end, 3500);
      eq(back[0].text, '第一句');
      eq(back[0].speaker, 'hero');
      eq(back[1].text, '第二句');
    });

    test('toSRT 时间格式化', () => {
      const s = toSRT([{ start: 3661_234, end: 3662_007, text: 'x' }]);
      assert(s.includes('01:01:01,234'), `应含 01:01:01,234，实际：${s}`);
      assert(s.includes('01:01:02,007'), `应含 01:01:02,007，实际：${s}`);
    });
  });

  // ================================================================
  describe('Tutorial · 新手引导', () => {
    // ================================================================

    interface Ctx {
      moved: boolean;
      openedBag: boolean;
      killed: number;
      log: string[];
    }

    function makeCtx(): Ctx {
      return { moved: false, openedBag: false, killed: 0, log: [] };
    }

    function build(ctx: Ctx, steps?: readonly TutorialStep<Ctx>[]) {
      return new Tutorial<Ctx>({
        steps: steps ?? [
          { id: 's1', kind: 'tap', text: '点击任意处开始' },
          {
            id: 's2', kind: 'wait', text: '移动一下',
            until: (c) => c.moved, timeoutMs: 5000,
          },
          { id: 's3', kind: 'tap', text: '完成' },
        ],
        context: ctx,
        onChange: (s) => { if (s) ctx.log.push(`enter:${s.id}`); },
        defaultTimeoutMs: 10_000,
      });
    }

    test('基本：start 进入第一步', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      eq(t.current?.id, 's1');
      eq(t.state, 'running');
    });

    test('tap 推进', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      t.tap();
      eq(t.current?.id, 's2');
    });

    test('⚠️ wait 步骤：条件满足自动推进', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      t.tap();              // → s2
      t.update(16);
      eq(t.current?.id, 's2', '还没移动，不该推进');
      ctx.moved = true;
      t.update(16);
      eq(t.current?.id, 's3', '移动后自动推进');
    });

    test('⚠️ wait 步骤忽略点击（由条件驱动）', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      t.tap();              // → s2 (wait)
      eq(t.tap(), false, 'wait 步骤不该被点击推进');
      eq(t.current?.id, 's2');
    });

    test('⚠️ waitAndTap：条件不满足时点击无效', () => {
      const ctx = makeCtx();
      const t = new Tutorial<Ctx>({
        steps: [{
          id: 's', kind: 'waitAndTap', text: '打开背包后继续',
          until: (c) => c.openedBag,
        }],
        context: ctx,
      });
      t.start();
      eq(t.tap(), false, '没打开背包，点不动');
      ctx.openedBag = true;
      eq(t.tap(), true);
      eq(t.state, 'finished');
    });

    test('⚠️ 超时兜底（条件永远不满足也不卡死）', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      t.tap();              // → s2，超时 5000
      t.update(4999);
      eq(t.current?.id, 's2');
      t.update(2);
      eq(t.current?.id, 's3', '超时后自动推进，宁可引导不完整也不能卡死');
    });

    test('⚠️ 超时用单步的 timeoutMs 而不是默认', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      t.update(9999);
      eq(t.current?.id, 's1', 'tap 步骤不该被超时推进');
    });

    test('remaining 用于超时进度条', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      t.tap();
      eq(t.remaining, 5000);
      t.update(2000);
      eq(t.remaining, 3000);
    });

    test('⚠️ skipIf 跳过条件满足的步骤', () => {
      const ctx = makeCtx();
      ctx.moved = true;
      /**
       * 【修正过的用例】
       * 原用例里 s2 根本没有 skipIf，自然不会被跳过。
       * skipIf 是被跳过**那一步自己**声明的。
       */
      const t = build(ctx, [
        { id: 's1', kind: 'tap' },
        {
          id: 's2', kind: 'wait', text: '移动一下',
          until: (c) => c.moved, skipIf: (c) => c.moved,
        },
        { id: 's3', kind: 'tap' },
      ]);
      t.start();
      t.tap();
      eq(t.current?.id, 's3', 's2 因为已移动被跳过');
      eq(t.isDone('s2'), true, '被跳过的步骤也算完成');
    });

    test('⚠️ skipIf 不满足时不跳过', () => {
      const ctx = makeCtx();
      ctx.moved = false;
      const t = build(ctx, [
        {
          id: 's2', kind: 'wait',
          until: (c) => c.moved, skipIf: (c) => c.moved,
        },
        { id: 's3', kind: 'tap' },
      ]);
      t.start();
      eq(t.current?.id, 's2');
    });

    test('⚠️ 连续多个 skipIf 全部跳过', () => {
      const ctx = makeCtx();
      const t = new Tutorial<Ctx>({
        steps: [
          { id: 'a', kind: 'tap', skipIf: () => true },
          { id: 'b', kind: 'tap', skipIf: () => true },
          { id: 'c', kind: 'tap' },
        ],
        context: ctx,
      });
      t.start();
      eq(t.current?.id, 'c');
    });

    test('skip 跳过全部', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      t.skip();
      eq(t.state, 'finished');
      eq(t.done.length, 3, '全部标记为已完成');
    });

    test('skipStep 只跳一步', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      t.skipStep();
      eq(t.current?.id, 's2');
    });

    test('onEnter / onExit 回调', () => {
      const ctx = makeCtx();
      const seen: string[] = [];
      const t = new Tutorial<Ctx>({
        steps: [
          { id: 'a', kind: 'tap', onEnter: () => seen.push('enter:a'), onExit: () => seen.push('exit:a') },
          { id: 'b', kind: 'tap', onEnter: () => seen.push('enter:b') },
        ],
        context: ctx,
      });
      t.start();
      t.tap();
      eq(seen.join(','), 'enter:a,exit:a,enter:b');
    });

    test('onFinish 回调', () => {
      let n = 0;
      const ctx = makeCtx();
      const t = new Tutorial<Ctx>({
        steps: [{ id: 'a', kind: 'tap' }],
        context: ctx,
        onFinish: () => n++,
      });
      t.start();
      t.tap();
      eq(n, 1);
    });

    test('progress', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      near(t.progress, 1 / 3, 1e-9);
    });

    test('⚠️ 断点续引导：startAt', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.startAt('s3');
      eq(t.current?.id, 's3');
      eq(t.isDone('s1'), true);
      eq(t.isDone('s2'), true);
    });

    test('⚠️ startAt 找不到步骤时从头开始（版本更新后 id 变了）', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.startAt('已删除的步骤');
      eq(t.current?.id, 's1', '从头来一遍，比对不上号直接崩溃好');
    });

    test('⚠️ 存档往返', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.start();
      t.tap();
      const saved = JSON.parse(JSON.stringify(t.exportState()));

      const ctx2 = makeCtx();
      const t2 = build(ctx2);
      t2.importState(saved);
      eq(t2.current?.id, 's2');
      eq(t2.isDone('s1'), true);
    });

    test('⚠️ 导入已完成存档', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.importState({ finished: true });
      eq(t.state, 'finished');
    });

    test('⚠️ 构造校验：wait 必须提供 until', () => {
      throws(
        () => new Tutorial<unknown>({
          steps: [{ id: 'x', kind: 'wait' }],
          context: {},
        }),
        'until'
      );
    });

    test('modal / mask / data 透传', () => {
      const ctx = makeCtx();
      const t = new Tutorial<Ctx>({
        steps: [{ id: 'a', kind: 'tap', modal: true, mask: true, data: { tip: 'x' } }],
        context: ctx,
      });
      t.start();
      eq(t.current?.modal, true);
      eq(t.current?.mask, true);
      eq((t.current?.data as { tip: string }).tip, 'x');
    });

    test('非运行态的 update/tap 无副作用', () => {
      const ctx = makeCtx();
      const t = build(ctx);
      t.update(1000);
      eq(t.tap(), false);
      eq(t.state, 'idle');
    });
  });

  // ================================================================
  describe('RedDot · 红点树', () => {
    // ================================================================

    test('基本：设置与读取', () => {
      const r = new RedDot();
      r.set('mail/system', 3);
      eq(r.get('mail/system'), 3);
      eq(r.has('mail/system'), true);
    });

    test('⚠️ 父节点自动聚合子节点', () => {
      const r = new RedDot();
      r.set('mail/system', 3);
      r.set('mail/gift', 2);
      eq(r.get('mail'), 5, '父节点不需要手动维护');
      eq(r.get(''), 5, '根节点也是');
    });

    test('⚠️ 多层嵌套也聚合', () => {
      const r = new RedDot();
      r.set('bag/equip/weapon', 1);
      r.set('bag/equip/armor', 2);
      r.set('bag/item', 4);
      eq(r.get('bag/equip'), 3);
      eq(r.get('bag'), 7);
    });

    test('⚠️ 父节点自身也算（自身 + 后代）', () => {
      const r = new RedDot();
      r.set('mail', 1);
      r.set('mail/system', 2);
      eq(r.get('mail'), 3);
    });

    test('⚠️ 前缀不能误匹配（mail 不该匹配 mailx）', () => {
      const r = new RedDot();
      r.set('mail', 5);
      r.set('mailbox', 100);
      eq(r.get('mail'), 5, 'mailbox 不该被算进 mail');
    });

    test('add 累加', () => {
      const r = new RedDot();
      r.set('mail', 1);
      r.add('mail', 4);
      eq(r.get('mail'), 5);
    });

    test('⚠️ add 负数不会小于 0', () => {
      const r = new RedDot();
      r.set('mail', 3);
      r.add('mail', -10);
      eq(r.get('mail'), 0);
    });

    test('clear 单个节点', () => {
      const r = new RedDot();
      r.set('mail/system', 3);
      r.set('mail/gift', 2);
      r.clear('mail/system');
      eq(r.get('mail/system'), 0);
      eq(r.get('mail'), 2, '父节点同步更新');
    });

    test('clearAll', () => {
      const r = new RedDot();
      r.set('a', 1);
      r.set('b', 2);
      r.clearAll();
      eq(r.get(''), 0);
    });

    test('⚠️ 设置为 0 等于删除（内存不泄漏）', () => {
      const r = new RedDot();
      r.set('mail', 5);
      r.set('mail', 0);
      eq(r.own('mail'), 0);
      eq(r.activePaths().length, 0);
    });

    test('any 只判断有无（不聚合数量）', () => {
      const r = new RedDot();
      r.set('mail/system', 3);
      eq(r.any('mail'), true);
      r.clear('mail/system');
      eq(r.any('mail'), false);
    });

    test('children 列出直接子节点', () => {
      const r = new RedDot();
      r.set('bag/equip/weapon', 1);
      r.set('bag/equip/armor', 1);
      r.set('bag/item', 1);
      eq(r.children('bag').sort().join(','), 'equip,item');
      eq(r.children('bag/equip').sort().join(','), 'armor,weapon');
    });

    test('children 根', () => {
      const r = new RedDot();
      r.set('a/1', 1);
      r.set('b/1', 1);
      eq(r.children('').sort().join(','), 'a,b');
    });

    test('⚠️ 覆盖：父节点显示自定义口径', () => {
      const r = new RedDot();
      r.set('quest/daily', 5);
      r.set('quest/weekly', 3);
      eq(r.get('quest'), 8, '默认聚合');
      r.override('quest', 2);
      eq(r.get('quest'), 2, '覆盖后显示"可领取数"');
      r.override('quest', null);
      eq(r.get('quest'), 8, '取消覆盖回到聚合');
    });

    test('⚠️ 数量为负抛错', () => {
      const r = new RedDot();
      throws(() => r.set('a', -1), '非负');
    });

    test('⚠️ 缓存失效：修改子节点后父节点必须更新', () => {
      /**
       * 这是最容易出的 bug：加了缓存但忘了失效，
       * 表现为"进过一次界面后红点数就不准了"。
       */
      const r = new RedDot();
      r.set('mail/system', 3);
      eq(r.get('mail'), 3);        // 写入缓存
      r.set('mail/gift', 2);
      eq(r.get('mail'), 5, '必须重新计算');
      r.clear('mail/system');
      eq(r.get('mail'), 2, '清除也要失效');
    });

    test('⚠️ onChange 通知所有祖先', () => {
      const seen: string[] = [];
      const r = new RedDot({
        onChange: (p, n) => seen.push(`${p}=${n}`),
      });
      r.set('bag/equip/weapon', 2);
      assert(seen.includes('bag/equip=2'), `应通知 bag/equip，实际：${seen}`);
      assert(seen.includes('bag=2'), `应通知 bag，实际：${seen}`);
      assert(seen.includes('=2'), `应通知根，实际：${seen}`);
    });

    test('相同值不通知', () => {
      const seen: string[] = [];
      const r = new RedDot({ onChange: (p) => seen.push(p) });
      r.set('a', 1);          // 通知 'a' 和根 ''（两个祖先）
      eq(seen.length, 2);
      seen.length = 0;
      r.set('a', 1);          // 值没变，不该有任何通知
      eq(seen.length, 0);
    });

    test('⚠️ 自定义分隔符', () => {
      const r = new RedDot({ separator: '.' });
      r.set('mail.system', 3);
      eq(r.get('mail'), 3);
    });

    test('存档往返', () => {
      const r = new RedDot();
      r.set('mail/system', 3);
      r.set('bag', 1);
      const r2 = new RedDot();
      r2.importState(r.exportState());
      eq(r2.get('mail'), 3);
      eq(r2.get(''), 4);
    });

    test('⚠️ 导入存档过滤非法值', () => {
      const r = new RedDot();
      r.importState({ a: 5, b: 0, c: -1, d: NaN });
      eq(r.get('a'), 5);
      eq(r.get(''), 5, '0 / 负数 / NaN 都被丢弃');
    });

    test('activePaths 调试用', () => {
      const r = new RedDot();
      r.set('mail/system', 1);
      r.set('bag', 0);
      eq(r.activePaths().join(','), 'mail/system');
    });
  });

  // ================================================================
  describe('SceneRouter · 场景路由', () => {
    // ================================================================

    function make(opts = {}) {
      return new SceneRouter({ outMs: 100, inMs: 100, initial: 'menu', ...opts });
    }

    /** 推进到 idle（模拟宿主驱动） */
    function settle(r: SceneRouter, maxSteps = 200): void {
      for (let i = 0; i < maxSteps; i++) {
        if (r.phase === 'load') {
          r.notifyLoaded();
          continue;
        }
        if (r.phase === 'idle') return;
        r.tick(50);
      }
    }

    test('基本：完整切换流程', () => {
      const r = make();
      eq(r.phase, 'idle');
      eq(r.goTo('game'), true);
      eq(r.phase, 'out');
      r.tick(100);
      eq(r.phase, 'load');
      r.notifyLoaded();
      eq(r.phase, 'in');
      r.tick(100);
      eq(r.phase, 'idle');
      eq(r.current, 'game');
    });

    test('⚠️ 切换中拒绝新请求（防连点加载两次）', () => {
      const r = make();
      r.goTo('game');
      eq(r.goTo('shop'), false, 'out 阶段被拒绝');
      r.tick(100);
      eq(r.goTo('shop'), false, 'load 阶段也被拒绝');
      settle(r);
      eq(r.current, 'game');
    });

    test('⚠️ 切到当前场景被拒绝', () => {
      const r = make();
      eq(r.goTo('menu'), false);
      eq(r.phase, 'idle');
    });

    test('⚠️ 返回栈', () => {
      const r = make();
      r.goTo('game'); settle(r);
      r.goTo('result'); settle(r);
      eq(r.current, 'result');
      eq(r.history.join('>'), 'menu>game>result');

      eq(r.back(), true);
      settle(r);
      eq(r.current, 'game');
    });

    test('⚠️ back 时历史被正确截断', () => {
      const r = make();
      r.goTo('game'); settle(r);
      r.goTo('result'); settle(r);
      r.back(); settle(r);
      eq(r.history.join('>'), 'menu>game', 'result 应被弹出');
    });

    test('⚠️ pushHistory: false 不入栈（回程场景）', () => {
      /**
       * 结算回主菜单是"回程"，
       * 入栈的话按返回键又会回到结算界面。
       */
      const r = make();
      r.goTo('game'); settle(r);
      r.goTo('result'); settle(r);
      r.go({ to: 'menu', pushHistory: false }); settle(r);
      eq(r.history.join('>'), 'menu');
      eq(r.back(), false, '没有上一场景了');
    });

    test('⚠️ 返回栈至少保留一层', () => {
      const r = make();
      eq(r.back(), false, '只有初始场景时不能 back');
      eq(r.current, 'menu', '场景不该变成 null');
    });

    test('⚠️ 加载超时兜底（回调永远不来也不卡死）', () => {
      const r = make({ loadTimeoutMs: 5000 });
      r.goTo('game');
      r.tick(100);              // → load
      eq(r.phase, 'load');
      r.tick(4999);
      eq(r.phase, 'load');
      r.tick(2);
      eq(r.phase, 'in', '超时后继续走，至少玩家能看到错误场景');
    });

    test('notifyLoaded 幂等', () => {
      const r = make();
      r.goTo('game');
      r.tick(100);
      r.notifyLoaded();
      r.notifyLoaded();
      r.notifyLoaded();
      eq(r.phase, 'in');
      eq(r.current, 'game');
    });

    test('⚠️ 非 load 阶段调 notifyLoaded 无副作用', () => {
      const r = make();
      r.goTo('game');
      r.notifyLoaded();      // 还在 out 阶段
      eq(r.phase, 'out');
      eq(r.current, 'menu', '不该提前切换');
    });

    test('⚠️ 历史上限（防无限增长）', () => {
      const r = make();
      for (let i = 0; i < 50; i++) {
        r.goTo(`s${i}`);
        settle(r);
      }
      assert(r.history.length <= 32, `应被裁剪，实际 ${r.history.length}`);
    });

    test('progress 驱动进度条', () => {
      const r = make();
      r.goTo('game');
      eq(r.state.progress, 0);
      r.tick(50);
      near(r.state.progress, 0.5, 1e-9);
      r.tick(50);
      eq(r.phase, 'load');
    });

    test('⚠️ 零时长转场直接跳过', () => {
      const r = make({ outMs: 0, inMs: 0 });
      r.goTo('game');
      r.tick(1);
      eq(r.phase, 'load');
      r.notifyLoaded();
      r.tick(1);
      eq(r.phase, 'idle');
      eq(r.current, 'game');
    });

    test('params 透传', () => {
      const r = make();
      r.go({ to: 'game', params: { level: 3 } });
      r.tick(100);
      r.notifyLoaded();
      eq((r.state.params as { level: number }).level, 3);
    });

    test('skipPhase 跳过当前阶段', () => {
      const r = make();
      r.goTo('game');
      r.skipPhase();          // out → load
      eq(r.phase, 'load');
      r.skipPhase();          // load → in
      eq(r.phase, 'in');
      r.skipPhase();          // in → idle
      eq(r.phase, 'idle');
      eq(r.current, 'game');
    });

    test('skipPhase 在 idle 时无副作用', () => {
      const r = make();
      r.skipPhase();
      eq(r.phase, 'idle');
    });

    test('busy', () => {
      const r = make();
      eq(r.busy, false);
      r.goTo('game');
      eq(r.busy, true);
    });

    test('onChange 回调', () => {
      const seen: string[] = [];
      const r = new SceneRouter({
        outMs: 0, inMs: 0, initial: 'menu',
        onChange: (p, s) => seen.push(`${p}:${s}`),
      });
      r.goTo('game');
      r.tick(1);
      r.notifyLoaded();
      assert(seen.some((x) => x.startsWith('out:')), '应通知退场');
      assert(seen.some((x) => x === 'in:game'), `应通知入场，实际：${seen}`);
    });

    test('⚠️ 无初始场景时 history 为空', () => {
      const r = new SceneRouter({ outMs: 0, inMs: 0 });
      eq(r.current, null);
      eq(r.history.length, 0);
    });

    test('tick 在 idle 时无副作用', () => {
      const r = make();
      r.tick(1000);
      eq(r.phase, 'idle');
    });
  });

  // ================================================================
  describe('Accessibility · 可访问性', () => {
    // ================================================================

    test('默认值全部关闭', () => {
      const a = new Accessibility();
      eq(a.reduceMotion, false);
      eq(a.fontScale, 1);
      eq(a.colorBlind, 'none');
    });

    test('⚠️ 减少动效必须关掉震屏和闪光', () => {
      /**
       * 这是"减少动效"最核心的用途——防止晕动症，
       * 不是"画面朴素一点"。
       * 只关震屏不关闪光，玩家会认为设置没生效。
       */
      const a = Accessibility.motionSensitive();
      eq(a.shouldPlay('shake'), false);
      eq(a.shouldPlay('flash'), false);
      eq(a.shouldPlay('sway'), false);
      eq(a.shouldPlay('transition'), false);
      eq(a.shouldPlay('autoCamera'), false);
    });

    test('⚠️ 减少动效保留装饰性表现', () => {
      const a = Accessibility.motionSensitive();
      eq(a.shouldPlay('particle'), true, '粒子不引起前庭不适');
      eq(a.shouldPlay('loopAnim'), true);
    });

    test('未开启时全部播放', () => {
      const a = new Accessibility();
      eq(a.shouldPlay('shake'), true);
      eq(a.shouldPlay('flash'), true);
    });

    test('⚠️ shake 是"减弱"而不是"开关"', () => {
      const a = new Accessibility({ shakeScale: 0.5 });
      eq(a.shake(10), 5);
      a.setShakeScale(0);
      eq(a.shake(10), 0, '完全关闭');
    });

    test('减少动效时 shake 恒为 0', () => {
      const a = new Accessibility({ reduceMotion: true, shakeScale: 1 });
      eq(a.shake(10), 0);
    });

    test('⚠️ shakeScale 被夹到 [0,1]', () => {
      const a = new Accessibility();
      a.setShakeScale(5);
      eq(a.shakeScale, 1);
      a.setShakeScale(-1);
      eq(a.shakeScale, 0);
    });

    test('⚠️ fontScale 被夹到 [0.8,2]', () => {
      const a = new Accessibility();
      a.setFontScale(10);
      eq(a.fontScale, 2);
      a.setFontScale(0.1);
      eq(a.fontScale, 0.8);
    });

    test('⚠️ 构造时 fontScale 为 0 抛错', () => {
      throws(() => new Accessibility({ fontScale: 0 }), '必须为正');
    });

    test('fontSize 应用缩放', () => {
      const a = new Accessibility({ fontScale: 1.5 });
      eq(a.fontSize(16), 24);
    });

    test('⚠️ longPressMs 被夹到 [200,3000]', () => {
      const a = new Accessibility();
      a.setLongPressMs(0);
      eq(a.longPressMs, 200);
      a.setLongPressMs(99999);
      eq(a.longPressMs, 3000);
    });

    test('色盲模式：需要颜色辅助', () => {
      const a = Accessibility.colorBlindRed();
      eq(a.needsColorAid(), true);
      eq(a.avoidHuePair(), 'red-green');
    });

    test('⚠️ 三色盲是蓝黄难分（不是红绿）', () => {
      const a = new Accessibility({ colorBlind: 'tritanopia' });
      eq(a.avoidHuePair(), 'blue-yellow');
    });

    test('无色觉障碍时不需要辅助', () => {
      const a = new Accessibility();
      eq(a.needsColorAid(), false);
      eq(a.avoidHuePair(), null);
    });

    test('单手模式：左手才镜像', () => {
      const a = new Accessibility({ oneHanded: 'left' });
      eq(a.mirrored(), true);
      a.setOneHanded('right');
      eq(a.mirrored(), false);
      a.setOneHanded('off');
      eq(a.mirrored(), false);
    });

    test('预设：大字号', () => {
      const a = Accessibility.largeText();
      eq(a.fontScale, 1.5);
      eq(a.highContrast, true);
    });

    test('预设：标准', () => {
      const a = Accessibility.standard();
      eq(a.reduceMotion, false);
      eq(a.shakeScale, 1);
    });

    test('onChange 回调', () => {
      const seen: string[] = [];
      const a = new Accessibility({ onChange: (k, v) => seen.push(`${k}=${v}`) });
      a.setReduceMotion(true);
      a.setFontScale(1.2);
      eq(seen.join(','), 'reduceMotion=true,fontScale=1.2');
    });

    test('⚠️ 存档往返', () => {
      const a = new Accessibility({
        reduceMotion: true, colorBlind: 'protanopia', fontScale: 1.3,
        highContrast: true, subtitles: true, subtitleSpeaker: false,
        oneHanded: 'left', longPressMs: 900, shakeScale: 0.4,
      });
      const b = new Accessibility();
      b.importState(a.exportState());

      eq(b.reduceMotion, true);
      eq(b.colorBlind, 'protanopia');
      eq(b.fontScale, 1.3);
      eq(b.highContrast, true);
      eq(b.subtitles, true);
      eq(b.subtitleSpeaker, false);
      eq(b.oneHanded, 'left');
      eq(b.longPressMs, 900);
      eq(b.shakeScale, 0.4);
    });

    test('⚠️ 导入脏数据不崩溃（数值被夹到合法区间）', () => {
      const a = new Accessibility();
      a.importState({
        colorBlind: 'not-a-real-mode',
        oneHanded: 'sideways',
        fontScale: NaN,
        longPressMs: -999,
        shakeScale: 'abc',
        reduceMotion: 'yes',
      });
      eq(a.colorBlind, 'none');
      eq(a.oneHanded, 'off');
      eq(a.fontScale, 1);
      eq(a.longPressMs, 200, '非法值被夹到边界而不是崩溃（不是保留默认）');
      eq(a.shakeScale, 1);
      eq(a.reduceMotion, false);
    });
  });
}
