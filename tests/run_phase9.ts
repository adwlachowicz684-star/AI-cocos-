/**
 * tests/run_phase9.ts —— 第二次精审 · 第九批（数据损坏 / 经济 / 统计正确性）
 *
 * 【这一批和第八批的区别】
 * 第八批的后果是"游戏挂了"或"某个系统永久废掉"；
 * 这一批的后果是**数据悄悄错了**——不崩、不报错、日志正常，
 * 但存档/钱包/实验结论已经不对了：
 *
 * | 编号 | 单元 | 后果 |
 * |---|---|---|
 * | P0-3 | binary | 32 位写入非对齐时数据损坏（是否出错取决于前面字段长度）|
 * | P0-22 | currency | `exchange` 非原子，超出上限的部分凭空消失 |
 * | P0-24 | inventory | NaN 让格子数量变 NaN 且槽位永不回收 |
 * | P0-26 | setbonus | `min`/`max` 被覆盖而非聚合，结果与配置表顺序耦合 |
 * | P0-1 | analytics | 数值指标被当成转化，实验永远不显著 |
 * | P0-5 | autoquality | `dtMs=0` 被读成 0 fps → 反向降到最低画质档 |
 *
 * 【贯穿本批的两个模式】
 *
 * 1. **JS 位移量按 5 位掩码**：`_cur << 32` 等于 `_cur << 0`，
 *    `1 << 32` 等于 `1`。凡是"位数等于 32"的分支都要单独写，
 *    不能指望通用表达式自动成立。
 *
 * 2. **否定式条件拦不住 NaN**：`if (x <= 0) return` 对 NaN 是 false → 继续执行；
 *    `if (!(x > 0)) return` 才是能拦住的写法。
 *
 * 【两条"防止矫枉过正"的用例为什么必须有】
 * 这一批改了好几处"否定式 → 肯定式"和"加范围校验"，
 * 每一处都可能误伤合法输入（比如 `-1` 的 32 位无符号写入、
 * `amount = Infinity` 表示"全取走"）。
 * 所以每组都配了正常输入的对照用例。
 */

import { describe, test, assert, eq } from './_framework';

import { BitWriter, BitReader } from '../binary/BinarySerializer';
import { CurrencyWallet } from '../currency/CurrencyWallet';
import { Inventory } from '../inventory/Inventory';
import { SetBonusSystem } from '../setbonus/SetBonus';
import { Experiment, conversionRate } from '../analytics/ABTest';
import { AutoQuality } from '../autoquality/AutoQuality';
import { Transition } from '../transition/Transition';
import { CommandStack } from '../command/CommandStack';
import { Builder } from '../builder/Builder';

export function runPhase9Tests(): void {
  // ============================================================
  // 第九批 · 剩余 P0（数据损坏 / 经济 / 统计正确性）
  // ============================================================

  describe('binary · 32 位写入的字节对齐（P0-3）', () => {
    test('⚠️ 非字节对齐时写入 32 位不损坏数据', () => {
      /**
       * 【修复前】`this._cur = ((this._cur << bits) | v) >>> 0`：
       * **`_cur << 32` 在 JS 里等于 `_cur << 0`**（位移量按 5 位掩码），
       * 于是 32 位写入变成"把 v 直接 OR 进当前 _cur"。
       *
       * 字节对齐时 `_cur` 恰好为 0，结果碰巧正确——这是它长期没被发现的原因。
       *
       * 实测（修复前）：先写 1 位制造非对齐，再写 `0x12345678`
       * → 读回 **`0x12345679`**；字节对齐时同样的值读回正确。
       *
       * 后果是存档/网络包在特定字段组合下**随机损坏**：是否出错取决于
       * 前面字段总位数是否为 8 的倍数，改一个字段长度就让另一个字段开始出错。
       */
      const w = new BitWriter();
      w.writeBits(1, 1);
      w.writeBits(0x12345678, 32);
      const r = new BitReader(w.toBytes());
      r.readBits(1);
      eq(r.readBits(32) >>> 0, 0x12345678, '非对齐的 32 位写入必须能原样读回');
    });

    test('⚠️ 字节对齐时 32 位写入仍然正确（防止矫枉过正）', () => {
      const w = new BitWriter();
      w.writeBits(0x12345678, 32);
      const r = new BitReader(w.toBytes());
      eq(r.readBits(32) >>> 0, 0x12345678);
    });

    test('⚠️ 超出 32 位的值必须抛错，不能静默截断', () => {
      /**
       * 【修复前】`1 << 32` 等于 `1 << 0` = 1，原区间校验退化，
       * 超范围的值被 `>>> 0` 悄悄截断（0x1FFFFFFFF → 0xFFFFFFFF）。
       */
      const w = new BitWriter();
      let threw = false;
      try {
        w.writeBits(0x1ffffffff, 32);
      } catch {
        threw = true;
      }
      eq(threw, true, '超 32 位应抛错');
    });

    test('⚠️ 负数仍走无符号映射（防止矫枉过正）', () => {
      const w = new BitWriter();
      w.writeBits(-1, 32);
      const r = new BitReader(w.toBytes());
      eq(r.readBits(32) >>> 0, 0xffffffff, '-1 应写成全 1');
    });
  });

  describe('currency · exchange 的原子性（P0-22）', () => {
    const mk = (): CurrencyWallet =>
      new CurrencyWallet({
        defs: [
          { id: 'gold', name: '金币', initial: 1000, cap: 1e9, floor: 0, precision: 0 },
          { id: 'gem', name: '钻石', initial: 0, cap: 50, floor: 0, precision: 0 },
        ],
      } as never);

    test('⚠️ 目标货币装不下时整笔拒绝，钱不消失', () => {
      /**
       * 【修复前】"先 spend 成功，再 add"：`add` 内部 `Math.min(cap, ...)`
       * 把超出部分**静默截断**。
       *
       * 实测（修复前）：gold=1000、gem 上限 50，`exchange('gold','gem',500,1)`
       * → gold 变 **500**、gem 只到账 **50** —— 450 金币蒸发，
       * 而 `exchange` 返回 `{ok: true}` 表示"成功了"。
       *
       * 流水里两条记录都正常，对账时发现不了。
       */
      const w = mk();
      const before = w.get('gold');
      w.exchange('gold', 'gem', 500, 1, 'test');
      const gold = w.get('gold');
      const gem = w.get('gem');
      assert(
        (gold === before && gem === 0) || (gold === before - 500 && gem === 500),
        `应当要么全成功要么不发生，实际 gold=${gold} gem=${gem}`
      );
    });

    test('⚠️ 装得下时正常兑换（防止矫枉过正）', () => {
      const w = mk();
      w.exchange('gold', 'gem', 30, 1, 'test');
      eq(w.get('gold'), 970);
      eq(w.get('gem'), 30);
    });

    test('⚠️ NaN 兑换不扣钱', () => {
      const w = mk();
      w.exchange('gold', 'gem', NaN, 1, 'test');
      eq(w.get('gold'), 1000, 'NaN 不应扣款');
    });
  });

  describe('inventory · NaN 不再毒化格子（P0-24）', () => {
    const mk = (): Inventory => {
      const inv = new Inventory({ size: 4 } as never);
      (inv as unknown as { define(d: unknown): void }).define({
        id: 'potion',
        name: '药水',
        maxStack: 64,
      } as never);
      inv.add('potion', 10);
      return inv;
    };

    test('⚠️ removeAt(index, NaN) 不产生 NaN 数量、不占死槽位', () => {
      /**
       * 【修复前】`const take = amount >= s.count ? s.count : amount;`
       * `NaN >= count` 为 false → `take = NaN` → `s.count -= NaN` = NaN；
       * 接着 `if (s.count === 0)` 对 NaN 恒为 false
       * → `s.def` 不清空 → **槽位永远占着**。
       *
       * 实测（修复前）：`add('potion',10)` 后 `removeAt(0, NaN)`
       * → 槽 0 count 变 NaN，且该槽仍标记为已占用（"背包莫名少一格"）。
       */
      const inv = mk();
      inv.removeAt(0, NaN);
      const slot = (inv as unknown as { _slots: { count: number; def: unknown }[] })._slots[0];
      assert(Number.isFinite(slot.count), `count 不应是 NaN，实际 ${slot.count}`);
      eq(slot.def, null, '数量清零后槽位应被回收');
    });

    test('⚠️ split(index, NaN) 直接拒绝而不是造出两个 NaN 格子', () => {
      /**
       * 【修复前】`if (amount <= 0 || amount >= s.count) return -1;`
       * —— **否定式条件拦不住 NaN**（两个判断对 NaN 都为 false）→
       * 继续执行，把两个格子的 count 都写成 NaN。
       *
       * 实测（修复前）：`split(0, NaN)` 返回 1（看起来成功），
       * 而两个格子数量都是 NaN。
       *
       * 修法是把否定式改成肯定式：`!(amount > 0) || !(amount < s.count)`。
       */
      const inv = mk();
      const r = inv.split(0, NaN);
      eq(r, -1, 'NaN 应被拒绝');
      const slot = (inv as unknown as { _slots: { count: number }[] })._slots[0];
      assert(Number.isFinite(slot.count), `count 不应是 NaN，实际 ${slot.count}`);
    });

    test('⚠️ 正常 remove / split 不受影响（防止矫枉过正）', () => {
      const inv = mk();
      inv.removeAt(0, 4);
      eq((inv as unknown as { _slots: { count: number }[] })._slots[0].count, 6);
      const to = inv.split(0, 2);
      assert(to >= 0, '正常 split 应成功');
    });
  });

  describe('setbonus · min/max 的聚合（P0-26）', () => {
    test('⚠️ 多档 max 共存时取最大值，不是被后面的覆盖', () => {
      /**
       * 【修复前】`summary()` 把 min/max 落进 `else out[k] = e.value`
       * —— **多档共存时取到的是最后一个**，与 max 语义无关。
       *
       * 实测（修复前）：`max(30)` 后 `max(10)` → 得到 **10**（应为 30）。
       * 结果与配置表书写顺序耦合：策划调一下 thresholds 顺序就改了数值，
       * 且改完不报错。
       */
      const s = new SetBonusSystem({
        sets: [
          {
            id: 'flame',
            name: '烈焰',
            thresholds: [
              { count: 2, effects: [{ stat: 'atk', op: 'max', value: 30 }] },
              { count: 4, effects: [{ stat: 'atk', op: 'max', value: 10 }] },
            ],
          },
        ],
        cumulative: true,
      } as never);
      for (const slot of ['head', 'chest', 'legs', 'feet']) {
        s.equip({ id: 'f_' + slot, set: 'flame', slot } as never);
      }
      eq(s.summary()['atk.max'], 30, 'max 应聚合取 30');
    });

    test('⚠️ min 聚合取最小值', () => {
      const s = new SetBonusSystem({
        sets: [
          {
            id: 'ice',
            name: '冰',
            thresholds: [
              { count: 2, effects: [{ stat: 'hp', op: 'min', value: 20 }] },
              { count: 4, effects: [{ stat: 'hp', op: 'min', value: 50 }] },
            ],
          },
        ],
        cumulative: true,
      } as never);
      for (const slot of ['head', 'chest', 'legs', 'feet']) {
        s.equip({ id: 'i_' + slot, set: 'ice', slot } as never);
      }
      eq(s.summary()['hp.min'], 20, 'min 应聚合取 20');
    });

    test('⚠️ add / mul 仍按原样聚合（防止矫枉过正）', () => {
      const s = new SetBonusSystem({
        sets: [
          {
            id: 'x',
            name: 'x',
            thresholds: [
              { count: 2, effects: [{ stat: 'atk', op: 'add', value: 5 }] },
              { count: 4, effects: [{ stat: 'atk', op: 'add', value: 5 }] },
            ],
          },
        ],
        cumulative: true,
      } as never);
      for (const slot of ['head', 'chest', 'legs', 'feet']) {
        s.equip({ id: 'x_' + slot, set: 'x', slot } as never);
      }
      eq(s.summary()['atk.add'], 10);
    });
  });

  describe('analytics · 数值指标不得被当成转化（P0-1）', () => {
    test('⚠️ 只 trackValue 时转化率为 0', () => {
      /**
       * 【修复前】`const converted = u.converted || u.hasValue;`
       * `trackValue()` 会把 `hasValue` 置 true，
       * 于是**每个记录了数值指标的用户都被算作已转化**。
       *
       * 实测（修复前）：100 个用户只调 `trackValue`
       * → conversions = 100/100、对照组与实验组转化率都是 1、`p = 1`（永远不显著）。
       */
      const e = new Experiment({ name: 'e' });
      for (let i = 0; i < 100; i++) e.trackValue('u' + i, i);
      const r = e.result();
      eq(conversionRate(r.control), 0, '未转化就不该算转化');
      eq(conversionRate(r.treatment), 0);
    });

    test('⚠️ 一个用户只贡献一次样本量（防止重复计数）', () => {
      /**
       * 【返工记录】第一版我写成"先 recordBinary 再 recordValue"，
       * 两个函数各自 `n + 1` → 每个用户被计 2 次，
       * 既有测试 `trackValue × 100 → n === 100` 立刻变红（实际 200）。
       */
      const e = new Experiment({ name: 'e' });
      for (let i = 0; i < 100; i++) e.trackValue('u' + i, i);
      const r = e.result();
      eq(r.control.n + r.treatment.n, 100, 'n 应恰好等于用户数');
    });

    test('⚠️ 真实转化差异仍能被检出（防止矫枉过正）', () => {
      const e = new Experiment({ name: 'e' }, { minSamples: 10 } as never);
      for (let i = 0; i < 200; i++) {
        const v = e.variantOf('u' + i);
        e.trackBinary('u' + i, v === 'treatment' ? i % 100 < 40 : i % 100 < 20);
      }
      eq(e.result().significant, true, '20% vs 40% 应判定显著');
    });
  });

  describe('autoquality · dtMs 的收口（P0-5）', () => {
    const mk = (): AutoQuality =>
      new AutoQuality({
        tiers: [
          { level: 1, name: '低' },
          { level: 2, name: '中' },
          { level: 3, name: '高' },
        ],
        initialLevel: 3,
        cooldownMs: 0,
        windowSize: 10,
        consecutiveSamples: 1,
      } as never);

    test('⚠️ dtMs=0 不得被读成 0 fps 并降档', () => {
      /**
       * 【修复前】`medianFps` 里 `med > 0 ? 1000 / med : 0` → 返回 **0**，
       * 于是 `if (fps < downFps)` 成立，连续 N 次后**降到最低档**。
       * **方向完全反了**：dtMs 越小意味着越快，结果被判成最慢。
       *
       * 实测（修复前）：喂 30 次 `update(0, i*10)` → medianFps = 0、档位降到 1。
       * 而 `update(16.7, ...)` 正常得到 59.9。
       */
      const a = mk();
      for (let i = 0; i < 30; i++) a.update(0, i * 10);
      assert(a.medianFps > 0, `medianFps 不应为 0，实际 ${a.medianFps}`);
    });

    test('⚠️ dtMs=NaN 同样不降档', () => {
      const a = mk();
      for (let i = 0; i < 30; i++) a.update(NaN, i * 10);
      assert(Number.isFinite(a.medianFps), `medianFps 不应是 NaN，实际 ${a.medianFps}`);
      assert(a.medianFps > 0, `medianFps 不应为 0，实际 ${a.medianFps}`);
    });

    test('⚠️ 正常帧率仍判定正确（防止矫枉过正）', () => {
      const a = mk();
      for (let i = 0; i < 30; i++) a.update(16.7, i * 10);
      assert(Math.abs(a.medianFps - 60) < 2, `应约 60fps，实际 ${a.medianFps}`);
    });
  });

  // ============================================================
  // P0-20 · transition：在途 Promise 的竞态
  // ============================================================

  describe('transition · 在途加载的归属（P0-20）', () => {
    test('⚠️ 上一次转场的加载结果不得让本次转场提前进入 in', async () => {
      /**
       * 【修复前】`.then` 里直接 `this._loadDone = true`，
       * 没有任何标识说明这个结果属于哪一次 `start()`。
       *
       * 场景：
       * ```
       * start('a')            // a 的 loader 挂起
       * reset(); start('b')   // b 的 loader 未完成
       * a 的 Promise resolve  → _loadDone = true   ← 属于 a，却被 b 读到
       * 下一帧 update()       → 阶段从 load 跳到 in（b 根本没加载完）
       * ```
       *
       * 后果：转场黑幕提前拉开，玩家看到未初始化完成的场景
       * （地形缺失、角色掉出世界、资源还没上屏）。
       * 完全静默——没有超时、没有错误、进度条还显示正常。
       * 在"玩家快速连点切换""加载中途取消"这两个极常见操作下必现。
       */
      const pending: Array<() => void> = [];
      const loader = (scene: string): Promise<void> => {
        if (scene === 'b') return new Promise<void>(() => {});   // 永不 resolve
        return new Promise<void>((res) => {
          pending.push(res);
        });
      };

      const t = new Transition(loader, { outMs: 1, inMs: 1, loadTimeoutMs: 60_000 });
      t.start('a');
      for (let i = 0; i < 20; i++) t.update(16);
      eq(t.phase, 'load', "a 未完成时应在 load");

      t.reset();
      t.start('b');
      for (let i = 0; i < 20; i++) t.update(16);
      eq(t.phase, 'load', "b 未完成时应在 load");

      // a 的 Promise 现在才完成
      pending.forEach((f) => f());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      t.update(16);
      assert(t.phase !== 'in', `b 没加载完就不该进入 in，实际 ${t.phase}`);
    });

    test('⚠️ 本次转场自己的加载结果仍然生效（防止矫枉过正）', async () => {
      /**
       * 【为什么必须配这条】
       * 加 token 比对时最容易犯的错是"把所有结果都丢掉"
       * （比如 token 没在 start 里同步递增，导致永远不匹配），
       * 那样转场会永远卡在 load，直到超时。
       */
      let resolveA: unknown = null;
      const loader = (): Promise<void> =>
        new Promise<void>((res) => {
          resolveA = () => res();
        });

      const t = new Transition(loader, { outMs: 1, inMs: 1, loadTimeoutMs: 60_000 });
      t.start('a');
      for (let i = 0; i < 20; i++) t.update(16);
      eq(t.phase, 'load');

      (resolveA as (() => void) | null)?.();
      await Promise.resolve();
      await Promise.resolve();
      for (let i = 0; i < 20; i++) t.update(16);

      assert(t.phase === 'in' || t.phase === 'done', `加载完成后应推进，实际 ${t.phase}`);
    });
  });


  // ============================================================
  // P0-21 · command：事务中半执行命令的副作用残留
  // ============================================================

  describe('command · 事务的原子性（P0-21）', () => {
    test('⚠️ 半途抛错的命令，其副作用也要被回滚', () => {
      /**
       * 【修复前】`do()` 是"先 execute，成功后再 push 进 buffer"。
       * 若 `execute()` **执行到一半抛错**（先改了外部状态、再 throw），
       * 这条命令根本没进 buffer → `rollback()` 逆序 undo 时不会撤销它。
       *
       * 实测（修复前）：
       * ```
       * transact('tx', () => { stack.do(ok); stack.do(bad); })
       * // bad.execute 先 outside += 100 然后 throw
       * // 抛出后 outside === 100（应为 0），undoDepth === 0
       * ```
       * ok 被正确回滚，但 bad 的 undo **从未被调用**。
       *
       * 后果正是事务要解决的问题本身：批量操作失败后停在
       * "部分已改、部分未改"的中间态，而 undo 已经帮不上忙
       * （失败的命令不在栈里）。
       */
      let outside = 0;
      const st = new CommandStack({} as never);
      const ok = {
        name: 'ok',
        execute: () => {
          outside += 1;
        },
        undo: () => {
          outside -= 1;
        },
      } as never;
      const bad = {
        name: 'bad',
        execute: () => {
          outside += 100;
          throw new Error('boom');
        },
        undo: () => {
          outside -= 100;
        },
      } as never;

      let threw = false;
      try {
        st.transact('tx', () => {
          st.do(ok);
          st.do(bad);
        });
      } catch {
        threw = true;
      }
      eq(threw, true, '异常应向上抛出');
      eq(outside, 0, '半执行命令的副作用必须被回滚');
    });

    test('⚠️ 全部成功时正常提交（防止矫枉过正）', () => {
      /**
       * 【为什么必须配这条】
       * "先入 buffer 再 execute" 如果实现错（比如忘记在非事务路径入栈），
       * 会让正常提交也不生效。这条守住正常路径。
       */
      let outside = 0;
      const st = new CommandStack({} as never);
      const cmd = {
        name: 'c',
        execute: () => {
          outside += 1;
        },
        undo: () => {
          outside -= 1;
        },
      } as never;
      st.transact('tx', () => {
        st.do(cmd);
        st.do(cmd);
      });
      eq(outside, 2, '两次执行都应生效');
      eq(st.undoDepth, 1, '事务应合并成一条记录');
    });

    test('⚠️ 事务外的 do 行为不变（防止矫枉过正）', () => {
      let outside = 0;
      const st = new CommandStack({} as never);
      const cmd = {
        name: 'c',
        execute: () => {
          outside += 1;
        },
        undo: () => {
          outside -= 1;
        },
      } as never;
      st.do(cmd);
      eq(outside, 1);
      eq(st.undoDepth, 1);
      st.undo();
      eq(outside, 0);
    });
  });


  // ============================================================
  // P0-23 · builder：upgrade 必须走与 place 相同的全量校验
  // ============================================================

  describe('builder · 升级路径的校验完整性（P0-23）', () => {
    const mkWallet = (): unknown => {
      const wallet: Record<string, number> = { gold: 10000 };
      return {
        get: (id: string) => wallet[id] ?? 0,
        spend: (cost: Record<string, number>) => {
          for (const k of Object.keys(cost)) {
            if ((wallet[k] ?? 0) < cost[k]) return false;
          }
          for (const k of Object.keys(cost)) wallet[k] -= cost[k];
          return true;
        },
      };
    };

    test('⚠️ 升级后的格子超出可建造地形时被拒（与 place 一致）', () => {
      /**
       * 【修复前】`upgrade` 只查"与其他建筑的占位冲突"和资源，
       * **没有**查越界、地形、数量上限、前置。
       *
       * 实测（修复前）：
       * - 只有 (0,0) 可建造 → `place('hut',(0,0))` 成功 → `upgrade()` **ok=true**
       *   （house 占 (0,0)+(1,0)，而 (1,0) 地形不允许）
       * - 同一块地直接 `place('house')` → `terrain-blocked`
       *
       * 同一栋建筑，走"放置"被挡、走"升级"畅通，
       * 玩家可以把建筑盖在水面/悬崖上，且两端结果一致（都错）所以没有任何报错。
       */
      const b = new Builder({
        blueprints: [
          { id: 'hut', name: '小屋', cells: [{ x: 0, y: 0 }], cost: { gold: 10 }, upgradeTo: 'house', buildTimeMs: 0 },
          { id: 'house', name: '房屋', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }], cost: { gold: 50 }, buildTimeMs: 0 },
        ] as never,
        wallet: mkWallet() as never,
        terrain: { isBuildable: (c: { x: number; y: number }) => c.x === 0 && c.y === 0 } as never,
        bounds: { w: 10, h: 10 },
      });

      const r1 = b.place('hut', { x: 0, y: 0 });
      eq(r1.ok, true, 'hut 应能放在 (0,0)');
      const id = (r1 as unknown as { building: { id: string } }).building.id;

      const up = b.upgrade(id);
      eq(up.ok, false, '升级后占 (1,0)，地形不允许，应被拒');
      eq(up.error, 'terrain-blocked');

      const direct = b.place('house', { x: 5, y: 5 });
      eq(direct.ok, false, '直接放置同样应被拒');
    });

    test('⚠️ 升级不得突破 maxCount', () => {
      /**
       * 实测（修复前）：放 2 个 hut → 依次 upgrade
       * → house 数量变成 **2**，而 `maxCount: 1`；
       * 直接 `place('house')` 则被 `max-count-reached` 拒绝。
       */
      const b = new Builder({
        blueprints: [
          { id: 'hut', name: '小屋', cells: [{ x: 0, y: 0 }], cost: { gold: 10 }, upgradeTo: 'house', buildTimeMs: 0 },
          { id: 'house', name: '房屋', cells: [{ x: 0, y: 0 }], cost: { gold: 50 }, maxCount: 1, buildTimeMs: 0 },
        ] as never,
        wallet: mkWallet() as never,
        bounds: { w: 10, h: 10 },
      });

      const a = b.place('hut', { x: 0, y: 0 });
      const c = b.place('hut', { x: 2, y: 0 });
      const ia = (a as unknown as { building: { id: string } }).building.id;
      const ic = (c as unknown as { building: { id: string } }).building.id;

      eq(b.upgrade(ia).ok, true, '第一个升级应成功');
      const second = b.upgrade(ic);
      eq(second.ok, false, '第二个应被 maxCount 挡住');
      eq(second.error, 'max-count-reached');
      eq(b.countOf('house'), 1, 'house 数量不得超过 1');
    });

    test('⚠️ 合法升级仍可正常完成（防止矫枉过正）', () => {
      const b = new Builder({
        blueprints: [
          { id: 'hut', name: '小屋', cells: [{ x: 0, y: 0 }], cost: { gold: 10 }, upgradeTo: 'house', buildTimeMs: 0 },
          { id: 'house', name: '房屋', cells: [{ x: 0, y: 0 }], cost: { gold: 50 }, buildTimeMs: 0 },
        ] as never,
        wallet: mkWallet() as never,
        bounds: { w: 10, h: 10 },
      });
      const a = b.place('hut', { x: 0, y: 0 });
      const ia = (a as unknown as { building: { id: string } }).building.id;
      eq(b.upgrade(ia).ok, true, '无限制时的正常升级应成功');
      eq(b.countOf('house'), 1);
      eq(b.countOf('hut'), 0, '旧蓝图计数应减一');
    });
  });

}
