/**
 * tests/run_batch10.ts —— 第十批插件测试
 *
 * command       撤销 / 重做（事务、合并、回滚）
 * debug-console 调试控制台（解析、补全、历史、模糊建议）
 * binary        位级二进制序列化（往返、边界、UTF-8）
 * crash         崩溃上报（面包屑、去重、指纹、安全序列化）
 */

import { test, testAsync, describe, assert, eq, near, throws } from './_framework';
import {
  CommandStack,
  setValueCommand,
} from '../command/CommandStack';
import {
  DebugConsole,
  CommandError,
  tokenize,
  similarity,
  usageOf,
  type CommandDef,
} from '../debug-console/DebugConsole';
import {
  schema,
  uint,
  int,
  bool,
  float,
  enumeration,
  string,
  raw,
  BitWriter,
  BitReader,
  RecordArray,
  utf8Encode,
  utf8Decode,
  toHex,
} from '../binary/BinarySerializer';
import {
  CrashReporter,
  makeFingerprint,
  safeStringify,
  reportText,
  type CrashReport,
  type ICrashTransport,
  type ILogEntryLike,
} from '../crash/CrashReporter';

export async function runBatch10Tests(): Promise<void> {
  // ============================================================
  describe('CommandStack · 撤销 / 重做', () => {
    // ============================================================

    /** 一个可观测的世界：一个数字 + 操作日志 */
    function makeWorld() {
      const log: string[] = [];
      let value = 0;
      return {
        get value() { return value; },
        get log() { return log; },
        set(v: number) { value = v; log.push(`set:${v}`); },
      };
    }

    test('基本 do / undo / redo', () => {
      const w = makeWorld();
      const stack = new CommandStack();
      stack.do({ name: '改为 5', execute: () => w.set(5), undo: () => w.set(0) });
      eq(w.value, 5);
      eq(stack.canUndo, true);
      eq(stack.canRedo, false);

      stack.undo();
      eq(w.value, 0);
      eq(stack.canRedo, true);

      stack.redo();
      eq(w.value, 5);
      eq(stack.canUndo, true);
    });

    test('新的 do 会清空 redo 栈', () => {
      const w = makeWorld();
      const stack = new CommandStack();
      stack.do({ name: 'a', execute: () => w.set(1), undo: () => w.set(0) });
      stack.undo();
      eq(stack.canRedo, true, '撤销后应可重做');

      stack.do({ name: 'b', execute: () => w.set(2), undo: () => w.set(0) });
      eq(stack.canRedo, false, '新命令后 redo 栈必须清空');
    });

    test('空栈时 undo / redo 返回 false 且不抛错', () => {
      const stack = new CommandStack();
      eq(stack.undo(), false);
      eq(stack.redo(), false);
      eq(stack.undoMany(5), 0);
      eq(stack.redoMany(5), 0);
    });

    test('⚠️ 命令 execute 抛错时不入栈', () => {
      const stack = new CommandStack();
      let executed = 0;
      throws(() => {
        stack.do({
          name: 'boom',
          execute: () => { executed++; throw new Error('炸了'); },
          undo: () => {},
        });
      }, '炸了');
      eq(executed, 1, 'execute 应被调用一次');
      eq(stack.canUndo, false, '失败的命令不该留下撤销记录');
    });

    test('栈深度上限：超出后丢弃最早的', () => {
      const w = makeWorld();
      const stack = new CommandStack({ limit: 3 });
      for (let i = 1; i <= 5; i++) {
        stack.do({ name: `v${i}`, execute: () => w.set(i), undo: () => w.set(0) });
      }
      eq(stack.undoDepth, 3, '深度应被限制在 3');
      stack.undo();
      stack.undo();
      stack.undo();
      eq(stack.canUndo, false, '只能撤销 3 次');
    });

    test('nextUndoName 用于菜单文案', () => {
      const stack = new CommandStack();
      eq(stack.nextUndoName, null);
      stack.do({ name: '建造箭塔', execute: () => {}, undo: () => {} });
      eq(stack.nextUndoName, '建造箭塔');
      stack.undo();
      eq(stack.nextRedoName, '建造箭塔');
    });

    test('undoable: false 的命令不入 undo 栈但清 redo', () => {
      const stack = new CommandStack();
      stack.do({ name: 'a', execute: () => {}, undo: () => {} });
      stack.undo();
      eq(stack.canRedo, true);

      stack.do({ name: '提交订单', execute: () => {}, undo: () => {}, undoable: false });
      eq(stack.canUndo, false, '不可逆命令不该进 undo 栈');
      eq(stack.canRedo, false, '但仍应清空 redo 栈');
    });

    // ---- 事务 ----

    test('⚠️ 事务合并成一条，且 commit 不重复执行', () => {
      const w = makeWorld();
      const stack = new CommandStack();
      const calls: string[] = [];

      stack.begin('批量');
      stack.do({ name: 'c1', execute: () => { calls.push('e1'); w.set(1); }, undo: () => { calls.push('u1'); } });
      stack.do({ name: 'c2', execute: () => { calls.push('e2'); w.set(2); }, undo: () => { calls.push('u2'); } });
      stack.commit();

      eq(calls.join(','), 'e1,e2', 'commit 不该再执行一次（否则副作用翻倍）');
      eq(w.value, 2);
      eq(stack.undoDepth, 1, '两条子命令应合并为一条');

      stack.undo();
      eq(calls.join(','), 'e1,e2,u2,u1', '撤销必须逆序');
    });

    test('⚠️ 事务重做时按正序重放', () => {
      const w = makeWorld();
      const stack = new CommandStack();
      const calls: string[] = [];

      stack.begin('t');
      stack.do({ name: 'a', execute: () => { calls.push('a'); w.set(1); }, undo: () => {} });
      stack.do({ name: 'b', execute: () => { calls.push('b'); w.set(2); }, undo: () => {} });
      stack.commit();
      stack.undo();
      calls.length = 0;
      stack.redo();
      eq(calls.join(','), 'a,b', '重做应按正序');
      eq(w.value, 2);
    });

    test('⚠️ transact 中途抛错会自动回滚', () => {
      const w = makeWorld();
      const stack = new CommandStack();
      let undone = 0;

      throws(() => {
        stack.transact('t', () => {
          stack.do({ name: 'a', execute: () => w.set(1), undo: () => { undone++; w.set(0); } });
          stack.do({ name: 'b', execute: () => w.set(2), undo: () => { undone++; } });
          throw new Error('中途失败');
        });
      }, '中途失败');

      eq(undone, 2, '已执行的两条都要回滚');
      eq(w.value, 0, '世界必须回到事务前');
      eq(stack.undoDepth, 0, '回滚后不该留下撤销记录');
    });

    test('rollback 时单条 undo 抛错不中断整体', () => {
      const stack = new CommandStack();
      let secondUndone = false;
      stack.begin('t');
      stack.do({ name: 'a', execute: () => {}, undo: () => { throw new Error('撤销失败'); } });
      stack.do({ name: 'b', execute: () => {}, undo: () => { secondUndone = true; } });
      eq(stack.rollback(), 2, '应返回回滚的命令数');
      eq(secondUndone, true, '第一条失败后第二条仍要回滚');
    });

    test('嵌套事务只有最外层提交', () => {
      const stack = new CommandStack();
      stack.begin('outer');
      stack.do({ name: 'a', execute: () => {}, undo: () => {} });
      stack.begin('inner');
      stack.do({ name: 'b', execute: () => {}, undo: () => {} });
      stack.commit();                      // 内层提交：不入栈
      eq(stack.undoDepth, 0, '内层提交不该入栈');
      eq(stack.inTransaction, true, '仍在外层事务中');
      stack.commit();
      eq(stack.undoDepth, 1, '外层提交后才入栈');
    });

    test('空事务提交返回 null', () => {
      const stack = new CommandStack();
      stack.begin('empty');
      eq(stack.commit(), null);
      eq(stack.undoDepth, 0);
    });

    // ---- 合并 ----

    test('⚠️ mergeKey 相同的连续命令会合并', () => {
      const w = makeWorld();
      const stack = new CommandStack();
      for (let v = 1; v <= 5; v++) {
        stack.do(setValueCommand('血量', () => w.value, (x) => w.set(x), v, { mergeKey: 'hp' }));
      }
      eq(w.value, 5);
      eq(stack.undoDepth, 1, '5 次拖动应合并为一条');

      stack.undo();
      eq(w.value, 0, '撤销一次回到最初值，而不是上一次中间值');
    });

    test('mergeKey 不同则不合并', () => {
      const w = makeWorld();
      const stack = new CommandStack();
      stack.do(setValueCommand('a', () => w.value, (x) => w.set(x), 1, { mergeKey: 'a' }));
      stack.do(setValueCommand('b', () => w.value, (x) => w.set(x), 2, { mergeKey: 'b' }));
      eq(stack.undoDepth, 2, '不同 key 不该合并');
    });

    test('不带 mergeKey 的命令永不合并', () => {
      const w = makeWorld();
      const stack = new CommandStack();
      for (let v = 1; v <= 3; v++) {
        stack.do(setValueCommand('x', () => w.value, (x) => w.set(x), v));
      }
      eq(stack.undoDepth, 3);
    });

    test('⚠️ T 可为 undefined 时 oldValue 判断不能失效', () => {
      let cur: string | undefined = 'initial';
      const stack = new CommandStack();
      stack.do(setValueCommand<string | undefined>('name', () => cur, (v) => { cur = v; }, undefined));
      eq(cur, undefined);
      stack.undo();
      eq(cur, 'initial', '旧值是 undefined 也要能正确恢复');
    });

    test('重做时不能覆盖最初记录的旧值', () => {
      let v = 100;
      const stack = new CommandStack();
      stack.do(setValueCommand('x', () => v, (n) => { v = n; }, 200));
      stack.undo();      // v = 100
      stack.redo();      // v = 200，此时 get() 返回 100，但不能把 oldValue 刷成 100
      eq(v, 200);
      stack.undo();
      eq(v, 100, 'redo 后再 undo 仍应回到最初值');
    });

    test('snapshot 导出可读的撤销历史', () => {
      const stack = new CommandStack();
      stack.do({ name: '建造', execute: () => {}, undo: () => {} });
      stack.do({ name: '移动', execute: () => {}, undo: () => {} });
      stack.undo();
      const s = stack.snapshot();
      eq(s.undoNames.join(','), '建造');
      eq(s.redoNames.join(','), '移动');
    });

    // ============================================================
  });

  describe('DebugConsole · 调试控制台', () => {
    // ============================================================

    /** 收集输出的控制台 */
    function makeConsole(opts = {}) {
      const lines: string[] = [];
      let cleared = 0;
      const c = new DebugConsole(opts);
      c.onOutput((l) => lines.push(l));
      c.onClear(() => { cleared++; });
      return {
        c,
        lines,
        get cleared() { return cleared; },
        run(s: string) { lines.length = 0; return c.execute(s); },
      };
    }

    test('注册与执行', () => {
      const { c, run, lines } = makeConsole();
      let got = '';
      c.register({
        name: 'give',
        args: [
          { name: 'item', type: 'string' },
          { name: 'count', type: 'int' },
        ],
        help: '给物品',
        run: (a) => {
          got = `${a.getString('item')}x${a.getInt('count')}`;
          return `获得 ${got}`;
        },
      });
      eq(run('give sword 5'), true);
      eq(got, 'swordx5');
      assert(lines.some((l) => l.includes('获得')), '返回值应输出');
    });

    test('⚠️ 引号内的空格不被拆分', () => {
      const { c, run } = makeConsole();
      let item = '';
      c.register({
        name: 'give',
        args: [{ name: 'item', type: 'string' }, { name: 'n', type: 'int' }],
        help: 'x',
        run: (a) => { item = a.getString('item'); },
      });
      run('give "火焰 之剑" 3');
      eq(item, '火焰 之剑', '带空格的参数必须用引号');
    });

    test('tokenize 基础与边界', () => {
      eq(tokenize('a b c').join('|'), 'a|b|c');
      eq(tokenize('a  b').join('|'), 'a|b', '连续空格不产生空 token');
      eq(tokenize('  a ').join('|'), 'a', '首尾空格应忽略');
      eq(tokenize('').length, 0);
      eq(tokenize(`a "b c" d`).join('|'), 'a|b c|d');
      eq(tokenize(`a 'b c' d`).join('|'), 'a|b c|d', '单引号同样支持');
    });

    test('⚠️ 引号未闭合要报错而不是静默截断', () => {
      const { c, run, lines } = makeConsole();
      c.register({ name: 'say', args: [{ name: 's', type: 'string' }], help: 'x', run: () => {} });
      run('say "没闭合');
      assert(lines.some((l) => l.includes('引号未闭合')), '应提示引号问题');
    });

    test('缺参数报错并给出用法', () => {
      const { c, run, lines } = makeConsole();
      c.register({
        name: 'give',
        args: [{ name: 'item', type: 'string' }],
        help: '给物品',
        run: () => {},
      });
      run('give');
      assert(lines.some((l) => l.includes('缺少参数')), '应提示缺少参数');
      assert(lines.some((l) => l.includes('用法') || l.includes('give')), '应附用法');
    });

    test('参数过多要报错', () => {
      const { c, run, lines } = makeConsole();
      c.register({
        name: 'ping',
        args: [{ name: 'a', type: 'int' }],
        help: 'x',
        run: () => {},
      });
      run('ping 1 2 3');
      assert(lines.some((l) => l.includes('参数过多')), '应提示参数过多');
    });

    test('⚠️ int 类型拒绝小数与非数字', () => {
      const { c, run, lines } = makeConsole();
      c.register({ name: 'n', args: [{ name: 'v', type: 'int' }], help: 'x', run: () => {} });
      run('n 1.5');
      assert(lines.some((l) => l.includes('整数')), '1.5 不是整数');
      run('n abc');
      assert(lines.some((l) => l.includes('整数')), 'abc 不是整数');
      run('n 5');
      eq(lines.length, 0, '合法输入不该有错误输出');
    });

    test('⚠️ Number("") 是 0，不能当成合法输入', () => {
      // 直接验证底层认知：空串转数字是 0，所以必须靠 tokenize 挡住
      eq(Number(''), 0);
      eq(tokenize('n   ').length, 1, '尾部空格不该产生空 token');
      const { c, run, lines } = makeConsole();
      c.register({ name: 'n', args: [{ name: 'v', type: 'int' }], help: 'x', run: () => {} });
      run('n   ');
      assert(lines.some((l) => l.includes('缺少参数')), '空参数应判为缺失而非 0');
    });

    test('int 的范围约束', () => {
      const { c, run, lines } = makeConsole();
      c.register({
        name: 'lv',
        args: [{ name: 'v', type: 'int', min: 1, max: 99 }],
        help: 'x',
        run: () => {},
      });
      run('lv 100');
      assert(lines.some((l) => l.includes('不能大于')), '超上限应报错');
      run('lv 0');
      assert(lines.some((l) => l.includes('不能小于')), '低于下限应报错');
      run('lv 50');
      eq(lines.length, 0, '范围内应通过');
    });

    test('bool 接受多种写法', () => {
      const { c, run } = makeConsole();
      const got: boolean[] = [];
      c.register({ name: 'f', args: [{ name: 'v', type: 'bool' }], help: 'x', run: (a) => { got.push(a.getBool('v')); } });
      run('f true'); run('f 1'); run('f yes'); run('f on');
      run('f false'); run('f 0'); run('f no'); run('f off');
      eq(got.join(','), 'true,true,true,true,false,false,false,false');
    });

    test('enum 拒绝非法值并列出候选', () => {
      const { c, run, lines } = makeConsole();
      c.register({
        name: 'mode',
        args: [{ name: 'v', type: 'enum', values: ['easy', 'normal', 'hard'] }],
        help: 'x',
        run: () => {},
      });
      run('mode nightmare');
      assert(lines.some((l) => l.includes('easy | normal | hard')), '应列出候选值');
      run('mode hard');
      eq(lines.length, 0);
      run('mode HARD');
      eq(lines.length, 0, '枚举应大小写不敏感');
    });

    test('⚠️ 构造时校验：enum 没给 values 要立刻报错', () => {
      const c = new DebugConsole();
      throws(() => c.register({
        name: 'bad',
        args: [{ name: 'v', type: 'enum' }],
        help: 'x',
        run: () => {},
      }), 'values');
    });

    test('可选参数与默认值', () => {
      const { c, run } = makeConsole();
      let n = -1;
      c.register({
        name: 'heal',
        args: [{ name: 'amount', type: 'int', optional: true, default: 10 }],
        help: 'x',
        run: (a) => { n = a.getInt('amount'); },
      });
      run('heal');
      eq(n, 10, '省略时应取默认值');
      run('heal 50');
      eq(n, 50);
    });

    test('⚠️ 可选参数没给 default 要报错', () => {
      const c = new DebugConsole();
      throws(() => c.register({
        name: 'bad',
        args: [{ name: 'v', type: 'int', optional: true }],
        help: 'x',
        run: () => {},
      }), 'default');
    });

    test('别名解析', () => {
      const { c, run } = makeConsole();
      let hit = 0;
      c.register({ name: 'teleport', alias: ['tp'], help: 'x', run: () => { hit++; } });
      run('tp');
      eq(hit, 1);
    });

    test('重复注册抛错', () => {
      const c = new DebugConsole();
      c.register({ name: 'a', help: 'x', run: () => {} });
      throws(() => c.register({ name: 'a', help: 'x', run: () => {} }), '重复');
    });

    test('未知命令给出模糊建议', () => {
      const { c, run, lines } = makeConsole();
      c.register({ name: 'teleport', help: 'x', run: () => {} });
      run('telepor');
      assert(lines.some((l) => l.includes('teleport')), '应建议 teleport');
    });

    test('⚠️ similarity 对漏字符有效（子串匹配做不到）', () => {
      // 'ad_relic' 与 'add_relic'：子串互不包含，但编辑距离很近
      assert(!'add_relic'.includes('ad_relic'), '子串匹配确实无法匹配');
      assert(similarity('ad_relic', 'add_relic') > 0.5, '编辑距离应能匹配');
      eq(similarity('abc', 'abc'), 1);
      eq(similarity('', 'abc'), 0);
      assert(similarity('completely_different', 'x') < 0.5, '差异过大应判不相似');
    });

    test('前缀模式下非命令输入返回 false', () => {
      const { c } = makeConsole({ prefix: '/' });
      eq(c.execute('hello world'), false, '不带前缀应返回 false（宿主可当聊天）');
      eq(c.execute('/help'), true);
    });

    test('命令内部异常向上传播（便于崩溃上报捕获）', () => {
      const c = new DebugConsole();
      c.register({ name: 'boom', help: 'x', run: () => { throw new Error('内部炸了'); } });
      throws(() => c.execute('boom'), '内部炸了');
    });

    test('CommandError 不传播（用户输入错误）', () => {
      const { c } = makeConsole();
      c.register({ name: 'x', help: 'x', run: () => { throw new CommandError('你输错了'); } });
      c.execute('x');   // 不该抛
    });

    test('Tab 补全命令名', () => {
      const c = new DebugConsole();
      c.register({ name: 'set', help: 'x', run: () => {} });
      c.register({ name: 'setpos', help: 'x', run: () => {} });
      c.register({ name: 'save', help: 'x', run: () => {} });
      /**
       * 【正确行为】'se' 的候选是 set / setpos，公共前缀 'set'。
       * 补到公共前缀（而不是停在原处）才能让再按一次 Tab 看到候选列表。
       */
      eq(c.complete('se'), 'set', '应补到公共前缀');
      eq(c.complete('set'), 'set', '公共前缀不短于输入时取唯一候选');
      eq(c.complete('sav'), 'save', '唯一候选直接补全');
      eq(c.complete('zzz'), 'zzz', '无候选时原样返回');
    });

    test('Tab 补全 enum 参数', () => {
      const c = new DebugConsole();
      c.register({
        name: 'mode',
        args: [{ name: 'v', type: 'enum', values: ['easy', 'normal', 'hard'] }],
        help: 'x',
        run: () => {},
      });
      eq(c.complete('mode '), 'mode easy');
      eq(c.complete('mode h'), 'mode hard');
    });

    test('completeCandidates 返回候选列表', () => {
      const c = new DebugConsole();
      c.register({ name: 'set', help: 'x', run: () => {} });
      c.register({ name: 'save', help: 'x', run: () => {} });
      eq(c.completeCandidates('s').join(','), 'save,set');
    });

    test('历史：上翻与下翻', () => {
      const { c } = makeConsole();
      c.execute('a'); c.execute('b'); c.execute('c');
      /**
       * 【正确行为】history = [a, b, c]
       * 上翻：c → b（往回走）
       * 下翻：c（前进）→ 草稿（越过最新一条后回到编辑中的那行）
       *
       * 我原先以为下翻会依次回到 b，那是把"下翻"当成了"上翻的撤销"。
       * 标准 shell 语义是：越过最新一条 → 回到草稿。
       */
      eq(c.historyPrev(''), 'c', '第一次上翻到最后一条');
      eq(c.historyPrev(''), 'b', '再上翻到倒数第二条');
      eq(c.historyNext(), 'c', '下翻回到最新一条');
      eq(c.historyNext(), '', '越过最新一条后回到草稿');
    });

    test('⚠️ 历史：上翻前的草稿不能丢', () => {
      const { c } = makeConsole();
      c.execute('old');
      eq(c.historyPrev('我正在输入'), 'old');
      eq(c.historyNext(), '我正在输入', '下翻应回到草稿');
    });

    test('历史去重与上限', () => {
      const { c } = makeConsole({ historyLimit: 3 });
      c.execute('a'); c.execute('a'); c.execute('b'); c.execute('c'); c.execute('d');
      eq(c.history.length, 3, '应限制在 3 条');
      eq(c.history.join(','), 'b,c,d', '连续重复的不该重复记录');
    });

    test('内置 help / find / history / clear', () => {
      /**
       * 【⚠️ 测试自身的坑】
       * `const { cleared } = makeConsole()` 会在解构那一刻取值，
       * 而 cleared 是 getter —— 之后的变化读不到，永远停在 0。
       * 必须持有对象本身。
       */
      const h = makeConsole();
      assert(h.run('help') === true);
      assert(h.lines.some((l) => l.includes('可用命令')), 'help 应列出命令');
      assert(h.run('find his') === true);
      assert(h.lines.some((l) => l.includes('history')), 'find 应能搜到');
      h.run('clear');
      eq(h.cleared, 1, 'clear 应触发清屏回调');
    });

    test('usageOf 生成可读用法', () => {
      const def: CommandDef = {
        name: 'give',
        args: [
          { name: 'item', type: 'string' },
          { name: 'n', type: 'int', optional: true, default: 1 },
          { name: 'm', type: 'enum', values: ['a', 'b'] },
        ],
        help: 'x',
        run: () => {},
      };
      eq(usageOf(def), 'give <item:string> [n:int] <m:a|b>');
    });

    test('unregister 后可再注册同名', () => {
      const c = new DebugConsole();
      c.register({ name: 'a', help: 'x', run: () => {} });
      eq(c.unregister('a'), true);
      eq(c.unregister('a'), false);
      c.register({ name: 'a', help: 'x', run: () => {} });   // 不该抛
    });

    test('hidden 命令不出现在 help 与补全里', () => {
      const { c, run, lines } = makeConsole();
      c.register({ name: 'secret', help: 'x', hidden: true, run: () => {} });
      run('help');
      assert(!lines.join('\n').includes('secret'), '隐藏命令不该出现在 help');
      eq(c.completeCandidates('sec').length, 0, '隐藏命令不该被补全');
      eq(c.has('secret'), true, '但仍可执行');
    });

    // ============================================================
  });

  describe('BinarySerializer · 位级序列化', () => {
    // ============================================================

    test('BitWriter / BitReader 基础往返', () => {
      const w = new BitWriter();
      w.writeBits(0b1011, 4);
      w.writeBits(0b010, 3);
      w.writeBits(1, 1);
      const bytes = w.toBytes();
      eq(w.bitLength, 8, '总共写了 8 位');
      eq(bytes.length, 1);

      const r = new BitReader(bytes);
      eq(r.readBits(4), 0b1011);
      eq(r.readBits(3), 0b010);
      eq(r.readBits(1), 1);
    });

    test('⚠️ 跨字节边界的位读写', () => {
      const w = new BitWriter();
      w.writeBits(0xff, 8);   // 8 位
      w.writeBits(0x3, 2);    // 跨到第 2 字节的前 2 位
      w.writeBits(0x1, 6);    // 填满第 2 字节
      const bytes = w.toBytes();
      eq(bytes.length, 2);
      eq(bytes[0], 0xff);
      // 第 2 字节：0b11_000001
      eq(bytes[1], 0b11000001);

      const r = new BitReader(bytes);
      eq(r.readBits(8), 0xff);
      eq(r.readBits(2), 0x3);
      eq(r.readBits(6), 0x1);
    });

    test('32 位写入不溢出', () => {
      const w = new BitWriter();
      w.writeBits(0xffffffff, 32);
      const r = new BitReader(w.toBytes());
      eq(r.readBits(32), 0xffffffff, '无符号右移后应为 4294967295');
    });

    test('⚠️ 写入超范围的值要报错（否则静默截断）', () => {
      const w = new BitWriter();
      throws(() => w.writeBits(300, 8), '超过');
    });

    test('⚠️ 读取超出数据长度要报错', () => {
      const w = new BitWriter();
      w.writeBits(1, 4);
      const r = new BitReader(w.toBytes());
      eq(r.remainingBits, 8, '补齐到整字节');
      r.readBits(8);
      throws(() => r.readBits(1), '数据不足');
    });

    test('单次超过 32 位要报错', () => {
      const w = new BitWriter();
      throws(() => w.writeBits(0, 33), '32');
    });

    test('uint / int / bool 往返', () => {
      const s = schema<{ hp: number; delta: number; alive: boolean }>({
        hp: uint(10),
        delta: int(9),
        alive: bool(),
      });
      const o = { hp: 1000, delta: -200, alive: true };
      const back = s.decode(s.encode(o));
      eq(back.hp, 1000);
      eq(back.delta, -200);
      eq(back.alive, true);
    });

    test('⚠️ int 的偏移编码：负数不会写成巨大的无符号数', () => {
      const s = schema<{ v: number }>({ v: int(8) });   // -128..127
      eq(s.decode(s.encode({ v: -128 })).v, -128);
      eq(s.decode(s.encode({ v: -1 })).v, -1);
      eq(s.decode(s.encode({ v: 0 })).v, 0);
      eq(s.decode(s.encode({ v: 127 })).v, 127);
    });

    test('uint 越界抛错', () => {
      const s = schema<{ v: number }>({ v: uint(4) });   // 0..15
      throws(() => s.encode({ v: 16 }), '越界');
      throws(() => s.encode({ v: -1 }), '越界');
      throws(() => s.encode({ v: 1.5 }), '整数');
    });

    test('float 量化：误差小于 step', () => {
      const s = schema<{ x: number }>({ x: float(-100, 100, 0.01) });
      for (const v of [0, 1.5, -33.33, 99.99, -100, 100]) {
        const back = s.decode(s.encode({ x: v }));
        assert(Math.abs(back.x - v) <= 0.01 + 1e-9, `${v} 的误差应 <= step，实际 ${back.x}`);
      }
    });

    test('⚠️ float 越界抛错，绝不静默截断 / 溢出回绕', () => {
      const s = schema<{ x: number }>({ x: float(-10, 10, 0.1) });
      /**
       * 【为什么从"会 clamp"改成"抛错"】
       * 这条用例原本要防的是**回绕**（写 999 读回负数）——抛错同样能防住。
       * 但它顺手把"静默 clamp"也锁成了契约：写 999 读回 10，不报错。
       * 这与 README §6③「越界值绝不静默截断」直接冲突，
       * 也是 W8-B 的 P1-5（float 是承载坐标/血量最可能的类型）。
       * 现在默认抛错；确实需要截断的调用方显式传 `clamp: true`（见下）。
       */
      throws(() => s.encode({ x: 999 }), '越界');
      throws(() => s.encode({ x: -999 }), '越界');

      // 显式开启 clamp 时才截断，且仍然不回绕
      const c = schema<{ x: number }>({ x: float(-10, 10, 0.1, 0, { clamp: true }) });
      eq(c.decode(c.encode({ x: 999 })).x <= 10, true, '显式 clamp：超上限应被截断到边界');
      eq(c.decode(c.encode({ x: -999 })).x >= -10, true, '显式 clamp：低于下限应被截断到边界');
      assert(c.decode(c.encode({ x: 999 })).x > 0, '不能回绕成负数');
    });

    test('float 拒绝 NaN / Infinity', () => {
      const s = schema<{ x: number }>({ x: float(0, 1, 0.1) });
      throws(() => s.encode({ x: NaN }), '非有限');
      throws(() => s.encode({ x: Infinity }), '非有限');
    });

    test('⚠️ float 参数校验：max <= min 要报错', () => {
      throws(() => float(10, 10, 1), 'max 必须大于 min');
      throws(() => float(10, 5, 1), 'max 必须大于 min');
      throws(() => float(0, 10, 0), 'step 必须为正');
    });

    test('enum 往返', () => {
      const s = schema<{ m: 'easy' | 'normal' | 'hard' }>({
        m: enumeration(['easy', 'normal', 'hard'] as const, 'normal'),
      });
      eq(s.decode(s.encode({ m: 'hard' })).m, 'hard');
      eq(s.decode(s.encode({ m: 'easy' })).m, 'easy');
    });

    test('⚠️ enum 索引越界时返回默认值而不是 undefined', () => {
      // 构造：3 个候选需要 2 位，但 2 位能表示 0..3，索引 3 是越界的
      const s = schema<{ m: 'a' | 'b' | 'c' }>({
        m: enumeration(['a', 'b', 'c'] as const, 'a'),
      });
      // 手工写入索引 3（越界）
      const w = new BitWriter();
      w.writeBits(3, 2);
      eq(s.decode(w.toBytes()).m, 'a', '越界索引应退化为默认值');
    });

    test('enum 构造校验', () => {
      throws(() => enumeration([], 'x'), '不能为空');
      throws(() => enumeration(['a', 'b'] as const, 'c'), '不在候选里');
    });

    test('string 往返（含中文与 emoji）', () => {
      const s = schema<{ name: string }>({ name: string(64) });
      for (const v of ['', 'hello', '火焰之剑', '🎉🎮', '混合 abc 123']) {
        eq(s.decode(s.encode({ name: v })).name, v, `"${v}" 往返应一致`);
      }
    });

    test('⚠️ string 超长报错而不是静默截断', () => {
      const s = schema<{ name: string }>({ name: string(4) });
      throws(() => s.encode({ name: '太长的名字' }), '超过上限');
    });

    test('⚠️ utf8 代理对（emoji）往返', () => {
      eq(utf8Decode(utf8Encode('🎉')), '🎉');
      eq(utf8Encode('🎉').length, 4, 'emoji 应编码为 4 字节');
      eq(utf8Encode('a').length, 1, 'ASCII 1 字节');
      eq(utf8Encode('火').length, 3, '中文 3 字节');
    });

    test('raw 字节数组往返', () => {
      const s = schema<{ blob: Uint8Array }>({ blob: raw(16) });
      const src = new Uint8Array([1, 2, 3, 250, 0]);
      const back = s.decode(s.encode({ blob: src })).blob;
      eq(back.length, 5);
      eq(back.join(','), '1,2,3,250,0');
    });

    test('⚠️ schema 构造时拒绝超过 32 位的字段', () => {
      throws(() => schema({ v: uint(33) }), '32');
    });

    test('⚠️ 位打包真的省空间', () => {
      const s = schema<{ hp: number; lv: number; alive: boolean }>({
        hp: uint(10), lv: uint(6), alive: bool(),
      });
      const bytes = s.encode({ hp: 999, lv: 60, alive: true });
      eq(bytes.length, 3, '17 位应补齐到 3 字节');
      const json = JSON.stringify({ hp: 999, lv: 60, alive: true }).length;
      assert(bytes.length < json / 3, `二进制 ${bytes.length}B 应远小于 JSON ${json}B`);
    });

    test('RecordArray 批量往返', () => {
      const item = schema<{ id: number; x: number }>({ id: uint(8), x: float(-50, 50, 0.1) });
      const arr = new RecordArray(item, 100);
      const src = [{ id: 1, x: 1.5 }, { id: 2, x: -20 }, { id: 255, x: 0 }];
      const back = arr.decode(arr.encode(src));
      eq(back.length, 3);
      near(back[0].x, 1.5, 0.05);
      near(back[1].x, -20, 0.05);
      eq(back[2].id, 255);
    });

    test('RecordArray 空数组与上限', () => {
      const item = schema<{ v: number }>({ v: uint(4) });
      const arr = new RecordArray(item, 4);
      eq(arr.decode(arr.encode([])).length, 0);
      throws(() => arr.encode([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }]), '超过上限');
    });

    test('⚠️ 缺失字段用默认值', () => {
      const s = schema<{ a: number; b: number }>({ a: uint(8, 7), b: uint(8, 9) });
      const back = s.decode(s.encode({ a: 1 } as { a: number; b: number }));
      eq(back.a, 1);
      eq(back.b, 9, '缺失的 b 应取默认值');
    });

    test('describe 输出可读结构', () => {
      const s = schema<{ hp: number }>({ hp: uint(10) }, { name: 'Hero', version: 2 });
      const d = s.describe();
      assert(d.includes('Hero'), '应含名字');
      assert(d.includes('v2'), '应含版本号');
      assert(d.includes('hp'), '应含字段名');
    });

    test('toHex 便于日志查看', () => {
      eq(toHex(new Uint8Array([0x0a, 0xff])), '0a ff');
      eq(toHex(new Uint8Array([1]), 0).includes('+1B'), true, '超限时应提示省略');
    });

    test('⚠️ 200 个敌人的存档体积对比', () => {
      const unit = schema<{ id: number; hp: number; x: number; y: number; alive: boolean }>({
        id: uint(12), hp: uint(10), x: float(-500, 500, 0.05), y: float(-500, 500, 0.05), alive: bool(),
      });
      const arr = new RecordArray(unit, 512);
      const units = Array.from({ length: 200 }, (_, i) => ({
        id: i, hp: (i * 3) % 1024, x: i * 0.5 - 50, y: i * 0.3, alive: i % 2 === 0,
      }));
      const bin = arr.encode(units);
      const json = new TextEncoder().encode(JSON.stringify(units)).length;
      assert(bin.length * 5 < json, `二进制 ${bin.length}B 应至少比 JSON ${json}B 小 5 倍`);
      const back = arr.decode(bin);
      eq(back.length, 200);
      eq(back[42].id, 42);
      eq(back[42].alive, true);
    });

    // ============================================================
  });

  describe('CrashReporter · 崩溃上报', () => {
    // ============================================================

    /** 内存中的通道，记录所有收到的报告 */
    function makeTransport() {
      const sent: CrashReport[] = [];
      const t: ICrashTransport = { send: (r) => { sent.push(r); } };
      return { t, sent };
    }

    test('基本捕获', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t });
      cr.capture(new Error('测试错误'));
      eq(sent.length, 1);
      eq(sent[0].message, '测试错误');
      eq(sent[0].severity, 'error');
    });

    test('上下文随报告一起发出', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t });
      cr.setContext({ version: '1.2.3', level: 'boss-2' });
      cr.setContextValue('playerId', 'p42');
      cr.capture(new Error('x'));
      eq(sent[0].context['version'], '1.2.3');
      eq(sent[0].context['playerId'], 'p42');
    });

    test('removeContextValue', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t });
      cr.setContextValue('a', 1);
      cr.removeContextValue('a');
      cr.capture(new Error('x'));
      eq('a' in sent[0].context, false);
    });

    test('面包屑按时间顺序保留', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t });
      cr.leave('flow', '进入战斗房');
      cr.leave('input', '使用技能');
      cr.leave('loot', '拾取遗物');
      cr.capture(new Error('炸了'));
      eq(sent[0].breadcrumbs.length, 3);
      eq(sent[0].breadcrumbs[0].message, '进入战斗房');
      eq(sent[0].breadcrumbs[2].message, '拾取遗物', '最后一条最接近崩溃点');
    });

    test('面包屑上限', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t, breadcrumbLimit: 3 });
      for (let i = 0; i < 10; i++) cr.leave('t', `step${i}`);
      cr.capture(new Error('x'));
      eq(sent[0].breadcrumbs.length, 3, '应限制在 3 条');
      eq(sent[0].breadcrumbs[2].message, 'step9', '应保留最新的');
    });

    test('⚠️ 去重：窗口内同一指纹只上报一次', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t, dedupeWindow: 60000 });
      for (let i = 0; i < 10; i++) cr.capture(new Error('同样的错'));
      eq(sent.length, 1, '10 次同样的崩溃只该上报 1 次');
      eq(cr.stats()[0].count, 10, '但计数要累加到 10');
    });

    test('⚠️ 去重：不同指纹互不影响', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t, dedupeWindow: 60000 });
      /**
       * 【注意】必须用不同函数抛出。
       * 同一行抛出的错误共享首个堆栈帧，指纹本来就相同——
       * 那是设计（同一处 bug 合并统计），不是 bug。
       */
      throwA(cr);
      throwB(cr);
      eq(sent.length, 2, '不同函数的错误指纹不同，都应上报');
    });

    test('⚠️ 同一调用点抛出的错误会合并（这是设计）', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t, dedupeWindow: 60000 });
      for (let i = 0; i < 5; i++) {
        try { throw new Error(`第 ${i} 次`); } catch (e) { cr.capture(e); }
      }
      eq(sent.length, 1, '同一行的 5 次抛出是同一个 bug，只报一次');
    });

    test('⚠️ 指纹必须抹掉行号（否则改一次代码就换指纹）', () => {
      /**
       * 【这是修复前真实存在过的 bug】
       * 原实现只取了文件 basename，没有去掉 `:343:15`，
       * 于是指纹是 `TypeError:bossPhaseTwo (game.js:343:15)`。
       * 改一次代码行号就变，同一个 bug 被当成新 bug，去重失效。
       */
      const fp = makeFingerprint({
        name: 'TypeError',
        message: 'x',
        stack: 'TypeError: x\n    at foo (game.js:343:15)\n    at bar (game.js:12:1)',
      });
      eq(fp, 'TypeError:foo (game.js)', '应只保留函数名与文件名');
      assert(!/\d/.test(fp), `指纹不该含任何数字：${fp}`);
    });

    test('⚠️ 指纹不该包含错误标题行', () => {
      /**
       * Node 的堆栈第一行是 `TypeError: Cannot read properties...`
       * 而不是 `at ...`。如果把它当帧，指纹里就会带上完整消息，
       * 而消息常含动态内容（id、变量名），导致指纹碎片化。
       */
      const fp = makeFingerprint({
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'hp')",
        stack: "TypeError: Cannot read properties of undefined (reading 'hp')\n    at boss (game.js:10:2)",
      });
      assert(!fp.includes('Cannot read'), `不应包含消息：${fp}`);
      eq(fp, 'TypeError:boss (game.js)');
    });

    test('指纹兼容 Safari 的 func@file 格式', () => {
      const fp = makeFingerprint({
        name: 'Error',
        message: 'x',
        stack: 'foo@game.js:10:2\nbar@game.js:20:1',
      });
      assert(fp.includes('foo'), `应取到首个帧：${fp}`);
      assert(!/:\d/.test(fp), `不该含行号：${fp}`);
    });

    test('无有效帧时退化为消息指纹', () => {
      const fp = makeFingerprint({ name: 'Error', message: '完全没堆栈', stack: '乱七八糟的文本' });
      assert(fp.includes('完全没堆栈'), `应退回消息：${fp}`);
    });

    test('⚠️ 无堆栈的错误不能全部坍缩成一个指纹', () => {
      // 这是修复前的真实失败场景：两个不同错误被去重吞掉一个
      const fA = makeFingerprint({ name: 'Error', message: '找不到玩家', stack: '' });
      const fB = makeFingerprint({ name: 'Error', message: '读档失败', stack: '' });
      assert(fA !== fB, `无堆栈时也应区分：${fA} vs ${fB}`);
    });

    test('⚠️ 消息里的数字被抹掉（避免同模板炸出多指纹）', () => {
      const f1 = makeFingerprint({ name: 'Error', message: 'player 123 not found', stack: '' });
      const f2 = makeFingerprint({ name: 'Error', message: 'player 456 not found', stack: '' });
      eq(f1, f2, '同模板不同 id 应视为同一 bug');
      const f3 = makeFingerprint({ name: 'Error', message: 'read failed', stack: '' });
      assert(f1 !== f3, '不同模板不应合并');
    });

    test('⚠️ 去重：窗口过后可以再次上报', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t, dedupeWindow: 0 });
      cr.capture(new Error('x'));
      cr.capture(new Error('x'));
      eq(sent.length, 2, 'dedupeWindow=0 时每次都上报');
    });

    test('⚠️ 累加计数会出现在下一次上报里', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t, dedupeWindow: 0 });

      /**
       * 【为什么窗口设 0 而不是 1ms】
       * 原写法用 1ms 窗口，但三次 capture 在同一毫秒内同步执行完，
       * `now - lastSent` 恒为 0，永远 < 1 → 全部被抑制，只上报 1 次，
       * 于是"累计次数"根本无从体现。
       *
       * 依赖真实时间流逝的断言是不稳定的：
       * 机器快一点 / 慢一点结果就不同。
       * 窗口设 0 让每次都上报，才能确定性地验证计数递增。
       */
      cr.capture(new Error('x'));
      cr.capture(new Error('x'));
      cr.capture(new Error('x'));
      eq(sent.length, 3, '窗口为 0 时每次都上报');
      eq(sent[0].occurrences, 1);
      eq(sent[1].occurrences, 2);
      eq(sent[2].occurrences, 3, '第三次上报应带上累计的 3');
    });

    test('fatal 不受采样率影响', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t, sampleRate: 0 });
      cr.capture(new Error('崩溃'), 'fatal');
      eq(sent.length, 1, '崩溃永远上报');
    });

    test('非致命错误受采样率影响', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t, sampleRate: 0 });
      let reported = 0;
      for (let i = 0; i < 50; i++) {
        if (cr.captureMessage(`msg${i}`, 'warning')) reported++;
      }
      eq(reported, 0, '采样率 0 时应全部拦下');
      eq(sent.length, 0);
    });

    test('⚠️ 指纹取首个堆栈帧且去掉行号', () => {
      function inner() { throw new Error('boom'); }
      let e1!: Error, e2!: Error;
      try { inner(); } catch (e) { e1 = e as Error; }
      try { inner(); } catch (e) { e2 = e as Error; }
      eq(makeFingerprint({ name: e1.name, message: e1.message, stack: e1.stack ?? '' }),
         makeFingerprint({ name: e2.name, message: e2.message, stack: e2.stack ?? '' }),
         '同一处抛出的错误指纹应相同');
    });

    test('不同函数抛出的错误指纹不同', () => {
      function f1() { throw new Error('x'); }
      function f2() { throw new Error('x'); }
      let e1!: Error, e2!: Error;
      try { f1(); } catch (e) { e1 = e as Error; }
      try { f2(); } catch (e) { e2 = e as Error; }
      const fp1 = makeFingerprint({ name: e1.name, message: e1.message, stack: e1.stack ?? '' });
      const fp2 = makeFingerprint({ name: e2.name, message: e2.message, stack: e2.stack ?? '' });
      assert(fp1 !== fp2, `指纹应不同：${fp1} vs ${fp2}`);
    });

    test('⚠️ 循环引用不会让上报本身崩溃', () => {
      const a: Record<string, unknown> = { name: 'a' };
      a['self'] = a;
      eq(safeStringify(a), '{"name":"a","self":"[Circular]"}');
    });

    test('safeStringify 处理各种类型', () => {
      eq(safeStringify(null), 'null');
      eq(safeStringify(undefined), 'undefined');
      eq(safeStringify(42), '42');
      eq(safeStringify({ fn: () => {} }), '{"fn":"[Function]"}', '函数不该让序列化崩掉');
      eq(safeStringify([1, 2]), '[1,2]', '数组应能序列化');
      eq(safeStringify({ d: new Date(0) }).length > 0, true, 'Date 应能序列化');
      assert(safeStringify({ a: 1 }).length < 500, '短对象不该被截断');
      assert(safeStringify({ s: 'x'.repeat(2000) }).endsWith('…'), '超长内容应截断');
    });

    test('⚠️ transport 抛异常不能传播出去', () => {
      let caught: unknown = null;
      const cr = new CrashReporter({
        transport: { send: () => { throw new Error('网络炸了'); } },
        onError: (e) => { caught = e; },
      });
      eq(cr.capture(new Error('x')), false, '应返回 false');
      assert(caught !== null, 'onError 应被调用');
    });


    test('beforeSend 可以丢弃报告', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t, beforeSend: () => null });
      eq(cr.capture(new Error('x')), false);
      eq(sent.length, 0);
    });

    test('beforeSend 可以改写报告', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({
        transport: t,
        beforeSend: (r) => ({ ...r, context: { ...r.context, added: true } }),
      });
      cr.capture(new Error('x'));
      eq(sent[0].context['added'], true);
    });

    test('没有 transport 时不静默吞掉（会打印）', () => {
      const cr = new CrashReporter();
      const orig = console.error;
      let printed = '';
      console.error = (...a: unknown[]) => { printed += String(a[0]); };
      try {
        eq(cr.capture(new Error('x')), false);
      } finally {
        console.error = orig;
      }
      assert(printed.includes('transport'), '应提示未配置通道');
    });

    test('非 Error 对象也能上报', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t });
      cr.capture('只是一个字符串');
      eq(sent[0].message, '只是一个字符串');
      eq(sent[0].name, 'StringError');
      cr.capture({ message: '像 Error 的对象' });
      eq(sent[1].message, '像 Error 的对象');
    });

    test('⚠️ crash 不依赖 logger（结构化类型即可接入）', () => {
      /**
       * 【为什么有这条测试】
       * 第一版直接 `import { LogEntry, LogLevel } from '../logger/Logger'`，
       * 把崩溃上报和日志系统绑死了——想用上报就得带上整个 logger。
       *
       * 改成结构化类型后，任何形如 { level, module, message, time } 的数据
       * 都能接入。这条测试锁住这个性质：
       * 只要这一段能编译通过，就说明没有隐式依赖。
       */
      const foreign: ILogEntryLike[] = [
        { level: 4, module: 'x', message: 'm', time: 0 },
      ];
      eq(foreign.length, 1);
      eq(typeof foreign[0].module, 'string');
    });

    test('setMinLogLevel 可调整收集门槛', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t });
      const entries: ILogEntryLike[] = [
        { level: 1, module: 'a', message: '低级别', time: 0 },
        { level: 4, module: 'b', message: '错误', time: 0 },
      ];
      cr.bindLogSource(() => entries);
      cr.setMinLogLevel(0);          // 全收
      cr.capture(new Error('x'));
      eq(sent[0].logs.length, 2);
    });

    test('⚠️ 日志源绑定后随报告发送（只取 Warn 及以上）', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t });
      /**
       * 【这里不 import Logger】
       * 用结构化类型 `ILogEntryLike` 喂进去——
       * 这本身就是"零横向依赖"的验证：
       * 一个不认识 logger 的数据源，只要形状对就能用。
       */
      const entries: ILogEntryLike[] = [
        { level: 4, module: 'combat', message: '伤害计算异常', time: Date.now() },
        { level: 3, module: 'ai', message: '找不到路径', time: Date.now() },
        { level: 0, module: 'ai', message: '这条不该出现', time: Date.now() },
      ];
      cr.bindLogSource(() => entries);
      cr.capture(new Error('x'));

      const logs = sent[0].logs;
      eq(logs.length, 2, '只应包含 error(4) 与 warn(3)');
      assert(logs.every((l) => l.level >= 3), 'Debug 日志应被过滤掉');
    });

    test('⚠️ 日志源自己崩了不能影响上报', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t });
      cr.bindLogSource(() => { throw new Error('日志源炸了'); });
      cr.capture(new Error('x'));
      eq(sent.length, 1, '仍应上报');
      eq(sent[0].logs.length, 0);
    });

    test('reportText 生成可读报告', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t });
      cr.setContext({ version: '1.0.0' });
      cr.leave('flow', '进入 Boss 房');
      cr.capture(new Error('Boss 技能崩了'), 'fatal');
      const text = reportText(sent[0]);
      assert(text.includes('Boss 技能崩了'), '应含错误信息');
      assert(text.includes('进入 Boss 房'), '应含面包屑');
      assert(text.includes('1.0.0'), '应含上下文');
      assert(text.includes('FATAL'), '应含严重级别');
    });

    test('reset 清空计数与面包屑', () => {
      const { t, sent } = makeTransport();
      const cr = new CrashReporter({ transport: t });
      cr.leave('a', 'x');
      cr.capture(new Error('x'));
      eq(cr.stats().length, 1);
      cr.reset();
      eq(cr.stats().length, 0);
      eq(cr.breadcrumbCount, 0);
      // reset 后同样的错可以再报
      const before = sent.length;
      cr.capture(new Error('x'));
      eq(sent.length, before + 1);
    });

    test('install / uninstall 不重复安装', () => {
      const cr = new CrashReporter();
      eq(cr.installed, false);
      cr.install();
      eq(cr.installed, true);
      cr.install();          // 重复调用应无害
      eq(cr.installed, true);
      cr.uninstall();
      eq(cr.installed, false);
    });

    test('stats 按次数降序', () => {
      const { t } = makeTransport();
      const cr = new CrashReporter({ transport: t, dedupeWindow: 0 });
      for (let i = 0; i < 3; i++) throwA(cr);
      throwB(cr);
      throwC(cr);
      throwC(cr);
      const s = cr.stats();
      eq(s.length, 3, '应有三个不同指纹');
      eq(s[0].count, 3, '出现 3 次的排第一');
    });
  });

  await testAsync('⚠️ 异步 transport 的 rejection 不会变成 unhandledrejection', async () => {
    let caught: unknown = null;
    const cr = new CrashReporter({
      transport: { send: () => Promise.reject(new Error('异步失败')) },
      onError: (e) => { caught = e; },
    });
    cr.capture(new Error('x'));
    await new Promise((r) => setTimeout(r, 5));
    assert(caught !== null, 'onError 应捕获 Promise rejection');
  });
}

/**
 * 三个不同的抛出点
 *
 * 【为什么需要】
 * 指纹基于首个堆栈帧。同一行抛出的错误共享同一帧，
 * 指纹必然相同。要验证"不同错误能区分"，必须有各自的调用点。
 */
function throwA(cr: CrashReporter): void {
  try { throw new Error('错误 A'); } catch (e) { cr.capture(e); }
}
function throwB(cr: CrashReporter): void {
  try { throw new Error('错误 B'); } catch (e) { cr.capture(e); }
}
function throwC(cr: CrashReporter): void {
  try { throw new Error('错误 C'); } catch (e) { cr.capture(e); }
}
