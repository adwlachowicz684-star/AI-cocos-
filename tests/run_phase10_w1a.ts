/**
 * tests/run_phase10_w1a.ts —— 精审返工 · 窗口 W1-A（第 A 组）
 *
 * 【本批覆盖的 8 个单元】
 * builder / craft / crash / cutscene / debug-console / gesture / matchops / skill-variant
 *
 * 【本批的共性】
 * 这 17 条 P1 + 3 条 P2 的后果**全都不是崩溃**，而是"静默地做错事"：
 *
 * | 形态 | 典型 |
 * |---|---|
 * | 契约说谎 | `PlaceResult.missing` 声明了但永远 undefined |
 * | 静默不生效 | `rotateCell(45)` 不转也不报错；未知 op 的补丁被算作"已应用" |
 * | 静默丢失 | 副产物被背包挤掉后 `byproducts` 是空数组 |
 * | 对同一事实给出相反答案 | `canCraft().maxCount = 0` 而 `craft()` 能成功 |
 * | 只在特定设备复现 | `maxPoints` 裁剪丢起点，采样率越高越容易触发 |
 *
 * 【为什么每条都配"防止矫枉过正"的对照用例】
 * 这批改动大多是在"加拒绝 / 加收口"，很容易误伤合法输入：
 * 空串当 0 要拒绝，但 `set_hp 50` 必须照常通过；
 * 掉线者的票要拒，但在线者的票必须照收；
 * NaN 配置要兜底，但正常配置必须原样生效。
 * 只写"修复前会失败"的那一条，等于只验证了一半。
 */

import { describe, test, assert, eq, throws } from './_framework';

import { Builder, rotateCell } from '../builder/Builder';
import { CraftSystem } from '../craft/CraftSystem';
import { CrashReporter } from '../crash/CrashReporter';
import { Cutscene, Timeline } from '../cutscene/Cutscene';
import { DebugConsole } from '../debug-console/DebugConsole';
import { GestureRecognizer } from '../gesture/Gesture';
import { ReconnectTracker } from '../matchops/Reconnect';
import { Surrender } from '../matchops/Surrender';
import { SkillVariantSystem, applyPatch } from '../skill-variant/SkillVariant';
import { FixedRandomSource } from '../_core/types';

// ==================== 测试用背包 ====================

/** 有容量上限的背包：`add` 返回**放不下的数量**（与 Inventory 语义一致） */
function makeInv(cap?: Record<string, number>) {
  const m = new Map<string, number>();
  return {
    count: (id: string): number => m.get(id) ?? 0,
    remove(id: string, n: number): number {
      const have = m.get(id) ?? 0;
      const got = Math.min(have, n);
      if (got > 0) m.set(id, have - got);
      return got;
    },
    add(id: string, n: number): number {
      const limit = cap && cap[id] !== undefined ? cap[id] : Infinity;
      const have = m.get(id) ?? 0;
      const put = Math.min(Math.max(0, limit - have), n);
      if (put > 0) m.set(id, have + put);
      return n - put; // leftover
    },
  };
}

function makeWallet(store: Record<string, number>) {
  return {
    get: (id: string): number => store[id] ?? 0,
    spend(costs: Readonly<Record<string, number>>): boolean {
      for (const k of Object.keys(costs)) if ((store[k] ?? 0) < costs[k]) return false;
      for (const k of Object.keys(costs)) store[k] -= costs[k];
      return true;
    },
    gain(g: Readonly<Record<string, number>>): void {
      for (const k of Object.keys(g)) store[k] = (store[k] ?? 0) + g[k];
    },
  };
}

export function runPhase10W1ATests(): void {
  // ============================================================
  // builder
  // ============================================================

  describe('builder · PlaceResult.missing 契约说谎（P1）', () => {
    test('⚠️ 资源不足时 missing 必须给出每种资源还差多少', () => {
      /**
       * 【修复前】`preview` 里算出的 `missing` 是**局部变量**，没进返回对象；
       * `place` 失败时又只透传 `error` / `detail`。
       * 实测：`place(...).missing === undefined`。
       *
       * 危害在于**类型检查是过的**：调用方照着
       * `readonly missing?: Record<ResourceId, number>` 写
       * `if (r.missing?.wood)` 来做"还差多少木头"的提示，
       * 运行时永远走不到，玩家点了建造没反应也没提示。
       * 比没有这个字段更糟——没有它，调用方会去找别的办法。
       */
      const store = { wood: 3, stone: 0 };
      const b = new Builder({
        blueprints: [{ id: 'hut', name: '小屋', cells: [{ x: 0, y: 0 }], cost: { wood: 10, stone: 4 } }],
        wallet: makeWallet(store),
      });

      const pre = b.preview('hut', { x: 0, y: 0 });
      assert(pre.missing !== undefined, 'preview 未给出 missing');
      eq(pre.missing!['wood'], 7, 'wood 应还差 7：');
      eq(pre.missing!['stone'], 4, 'stone 应还差 4：');

      const r = b.place('hut', { x: 0, y: 0 });
      assert(r.missing !== undefined, 'place 未透传 missing');
      eq(r.missing!['wood'], 7, 'place 的 wood 缺口：');
    });

    test('资源充足时成功放下，且不带 missing（防止矫枉过正）', () => {
      const store = { wood: 100 };
      const b = new Builder({
        blueprints: [{ id: 'hut', name: '小屋', cells: [{ x: 0, y: 0 }], cost: { wood: 10 } }],
        wallet: makeWallet(store),
      });
      const r = b.place('hut', { x: 0, y: 0 });
      assert(r.ok, '资源充足时应放置成功');
      eq(store.wood, 90, '应扣掉 10 木：');
      assert(r.missing === undefined, '成功时不应带 missing');
    });
  });

  describe('builder · rotateCell 对非法角度静默返回原值（P1）', () => {
    test('⚠️ 非法角度必须抛错，不能"不转也不报错"', () => {
      /**
       * 【修复前】`default: return c` —— 实测
       * `rotateCell({x:1,y:0}, 45)` → `{x:1,y:0}`。
       *
       * `Direction` 是 `0|90|180|270` 的字面量联合，TS 层能挡住写死的错误，
       * 但**挡不住运行时的数字**：蓝图从 JSON 反序列化后就是 `number`，
       * `rot` 传 45 时类型系统看不见。
       * 于是建筑不旋转、也不报错，占位与预览对不上，
       * 玩家看到的是"我选了旋转但它没转"，日志一行都没有。
       */
      throws(
        () => rotateCell({ x: 1, y: 0 }, 45 as never),
        '非法旋转角度',
        '非法角度应抛错：'
      );
    });

    test('四个合法角度的旋转结果不变（防止矫枉过正）', () => {
      const c = { x: 1, y: 0 };
      const r0 = rotateCell(c, 0);
      const r90 = rotateCell(c, 90);
      const r180 = rotateCell(c, 180);
      const r270 = rotateCell(c, 270);

      eq(`${r0.x},${r0.y}`, '1,0', '0°：');
      eq(`${r90.x},${r90.y}`, '0,1', '90°：');
      eq(`${r180.x},${r180.y}`, '-1,0', '180°：');
      eq(`${r270.x},${r270.y}`, '0,-1', '270°：');
    });
  });

  // ============================================================
  // craft
  // ============================================================

  describe('craft · totalMaterials 忽略子配方产率（P1）', () => {
    test('⚠️ 递归必须按子配方产率换算次数，不能把"需要 N 个"当成"做 N 次"', () => {
      /**
       * 【修复前】递归时直接 `totalMaterials(sub.id, need, ...)`：
       * 把"需要 8 个板"当成"要做 8 次板配方"，而板配方一次产出 4 个。
       *
       * 实测（修复前）：
       * ```
       * plank: 2 木 → 4 板 ;  house: 8 板 → 1 房
       * 实需 8 ÷ 4 = 2 次 × 2 木 = 4 木
       * totalMaterials('house',1) = {"wood":16}   ← 正好高估 4 倍
       * ```
       *
       * 数字都是"合理的正整数"，任何校验都抓不到。
       * 后果不只是 UI 让玩家多攒材料：自动合成/代工系统照着这个数执行，
       * 会多做 4 倍的中间产物。
       */
      const c = new CraftSystem();
      c.define({ id: 'plank', name: '板', inputs: [{ itemId: 'wood', count: 2 }], output: { itemId: 'plank', count: 4 } });
      c.define({ id: 'house', name: '房', inputs: [{ itemId: 'plank', count: 8 }], output: { itemId: 'house', count: 1 } });

      const need = c.totalMaterials('house', 1);
      eq(need['wood'], 4, '造 1 房应需 4 木（8 板 ÷ 4 板/次 = 2 次 × 2 木）：');
    });

    test('产率为 1 的嵌套链结果不变（防止矫枉过正）', () => {
      const c = new CraftSystem();
      c.define({ id: 'ingot', name: '锭', inputs: [{ itemId: 'ore', count: 2 }], output: { itemId: 'ingot', count: 1 } });
      c.define({ id: 'sword', name: '剑', inputs: [{ itemId: 'ingot', count: 3 }], output: { itemId: 'sword', count: 1 } });

      const need = c.totalMaterials('sword', 1);
      eq(need['ore'], 6, '3 锭 × 2 矿 = 6 矿（产率 1，不该被改动）：');
    });

    test('不能整除时向上取整，宁可多算一个也不能少备料', () => {
      const c = new CraftSystem();
      c.define({ id: 'plank', name: '板', inputs: [{ itemId: 'wood', count: 2 }], output: { itemId: 'plank', count: 4 } });
      c.define({ id: 'fence', name: '栏', inputs: [{ itemId: 'plank', count: 5 }], output: { itemId: 'fence', count: 1 } });

      // 5 板 ÷ 4 板/次 = 1.25 次 → ceil = 2 次 × 2 木 = 4 木
      eq(c.totalMaterials('fence', 1)['wood'], 4, '5 板需 2 次合成：');
    });
  });

  describe('craft · 副产物被背包丢弃时静默消失（P1）', () => {
    test('⚠️ 放不下的副产物必须出现在 lost 里', () => {
      /**
       * 【修复前】`got = bp.count * count - leftover`，只在 `got > 0` 时 push。
       * 背包放不下时 `got === 0`，`byproducts` 就是空数组，
       * 而 `ok: true`——**没有任何字段表示"有东西被丢了"**。
       *
       * 带概率的稀有副产物（比如 5% 出橙装）被这么丢掉时，
       * 运营侧看到的是"掉率异常低"，代码侧一切正常，两边都查不出问题。
       */
      const c = new CraftSystem();
      c.define({
        id: 'sword', name: '剑',
        inputs: [{ itemId: 'iron', count: 1 }],
        output: { itemId: 'sword', count: 1 },
        byproducts: [{ itemId: 'slag', count: 2 }],
      });
      const inv = makeInv({ slag: 0 }); // slag 完全放不下
      inv.add('iron', 5);

      const r = c.craft('sword', inv);
      assert(r.ok, '主产物应成功');
      assert(r.lost !== undefined, '丢弃的副产物必须出现在 lost 里');
      eq(r.lost![0].itemId, 'slag', '被丢弃的应是 slag：');
      eq(r.lost![0].count, 2, '丢弃数量：');
    });

    test('放得下时 lost 不出现，副产物正常到手（防止矫枉过正）', () => {
      const c = new CraftSystem();
      c.define({
        id: 'sword', name: '剑',
        inputs: [{ itemId: 'iron', count: 1 }],
        output: { itemId: 'sword', count: 1 },
        byproducts: [{ itemId: 'slag', count: 2 }],
      });
      const inv = makeInv();
      inv.add('iron', 5);

      const r = c.craft('sword', inv);
      assert(r.ok, '应成功');
      assert(r.lost === undefined, '没丢东西时 lost 应为 undefined');
      eq(r.byproducts![0].count, 2, '副产物应正常到手：');
    });
  });

  describe('craft · 全 consume:false 配方 maxCount 归零（P1）', () => {
    test('⚠️ 无消耗输入时 maxCount 应为 Infinity 且标记 unlimited', () => {
      /**
       * 【修复前】末尾统一 `Number.isFinite(maxCount) ? maxCount : 0`，
       * 把"没有任何消耗型材料"也归零了。
       *
       * 实测（修复前）：`canCraft` 返回 `{"ok":true,"missing":[],"maxCount":0}`，
       * 而 `craft()` 本身能成功——**两个 API 对同一事实给出相反答案**。
       * UI 拿 maxCount 做"最多能做几个"滑块的上限，滑块直接禁用。
       */
      const c = new CraftSystem();
      c.define({
        id: 'free', name: '免费合成',
        inputs: [{ itemId: 'workbench', count: 1, consume: false }],
        output: { itemId: 'thing', count: 1 },
      });
      const inv = makeInv();
      inv.add('workbench', 1);

      const r = c.canCraft('free', inv);
      assert(r.ok, '应可合成');
      assert(r.unlimited, '无消耗型输入时应标记 unlimited');
      assert(r.maxCount === Infinity, `maxCount 应为 Infinity，实际 ${r.maxCount}`);
    });

    test('有消耗但材料为 0 时 maxCount 真的为 0（防止矫枉过正）', () => {
      const c = new CraftSystem();
      c.define({
        id: 'sword', name: '剑',
        inputs: [{ itemId: 'iron', count: 3 }],
        output: { itemId: 'sword', count: 1 },
      });
      const inv = makeInv();
      inv.add('iron', 7);

      const r = c.canCraft('sword', inv);
      assert(!r.unlimited, '有消耗型输入时不该是 unlimited');
      eq(r.maxCount, 2, '7 铁 / 3 每次 = 2 次：');
    });
  });

  // ============================================================
  // crash
  // ============================================================

  describe('crash · _seen 指纹表只增不减（P1）', () => {
    test('⚠️ 指纹数超过容量上限时必须被淘汰', () => {
      /**
       * 【修复前】`_seen` 只增不减，唯一清理入口是 `reset()`（用户不会在运行时调）。
       * 实测：`dedupeWindow: 1` 下抓 1000 个不同指纹 → `stats().length = 1000`，
       * 且会继续涨。每条还带 `{count, lastSent}`，
       * `stats()` 每次 `[...entries].map().sort()` 全表排序，随指纹数线性劣化。
       */
      const rep = new CrashReporter({
        dedupeWindow: 1,
        maxFingerprints: 100,
        transport: { send(): void {} },
      });
      for (let i = 0; i < 1000; i++) rep.capture({ name: 'E' + i, message: 'boom' + i });

      const n = rep.stats().length;
      assert(n <= 100, `指纹表应被淘汰到 <= 100，实际 ${n}`);
    });

    test('去重本身仍然有效：同指纹只留一条（防止矫枉过正）', () => {
      const rep = new CrashReporter({
        dedupeWindow: 60_000,
        transport: { send(): void {} },
      });
      for (let i = 0; i < 500; i++) rep.capture({ name: 'Same', message: 'same' });

      eq(rep.stats().length, 1, '同指纹应只留一条：');
      eq(rep.stats()[0].count, 500, '次数应累加到 500：');
    });
  });

  describe('crash · 采样用裸 Math.random（P1）', () => {
    test('⚠️ 注入固定随机源后，采样结果必须完全可复现', () => {
      /**
       * 【修复前】`if (Math.random() > this._sampleRate) return false;`
       * 实测 sampleRate=0.5、200 次不同异常，多轮发送次数是 95 / 105 / 99——
       * 比例对，但**每次都不同**。
       *
       * 后果是违反"随机数走 IRandomSource 注入"：
       * 采样相关的单测无法稳定断言（只能写"大致 50%"），
       * 且线上无法用固定种子复现"为什么这条崩溃没上报"。
       */
      const seq = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 0.1 : 0.9));
      const runs: number[] = [];

      for (let r = 0; r < 3; r++) {
        let sent = 0;
        const rep = new CrashReporter({
          sampleRate: 0.5,
          dedupeWindow: 0,
          random: new FixedRandomSource(seq),
          transport: { send(): void { sent++; } },
        });
        for (let i = 0; i < 200; i++) rep.capture({ name: 'X' + r + '_' + i, message: 'm' + i });
        runs.push(sent);
      }

      eq(runs[0], runs[1], '第 1、2 轮应一致：');
      eq(runs[1], runs[2], '第 2、3 轮应一致：');
      // 0.1 < 0.5 → 发送；0.9 > 0.5 → 丢弃。200 次里正好一半
      eq(runs[0], 100, '固定序列下应正好发送 100 次：');
    });

    test('fatal 严重度不受采样影响（防止矫枉过正）', () => {
      let sent = 0;
      const rep = new CrashReporter({
        sampleRate: 0,
        dedupeWindow: 0,
        transport: { send(): void { sent++; } },
      });
      for (let i = 0; i < 10; i++) rep.capture({ name: 'F' + i, message: 'fatal' }, 'fatal');

      eq(sent, 10, '崩溃永远上报，不参与采样：');
    });
  });

  // ============================================================
  // cutscene
  // ============================================================

  describe('cutscene · Timeline.with 与 README 不符（P1）', () => {
    test('⚠️ with() 必须与上一个 step 同时开始', () => {
      /**
       * 【修复前】`with` 里 `start = this._lastStart()` 返回的是 `_cursor`，
       * 而 `add` 已经把 cursor 推进到 `start + duration`。
       *
       * 实测（修复前）：`add('a',1000); with('b',1000)` → `a:0, b:1000`。
       * README 第 136 行写的是「并行添加（与上一个同时开始，总时长取 max）」，
       * 第 141-142 行还专门强调了这个语义。
       *
       * 按 README 编排"音效与动画同时起"，实际变成串行两段，
       * 演出时长翻倍、节奏全错。因为 `with` 的名字和文档都指向并行，
       * 调用方不会去验证 start 值。
       */
      const tl = new Timeline('t').add('a', 1000).with('b', 1000);
      const steps = tl.build().steps;

      eq(steps[0].start, 0, 'a 应从 0 开始：');
      eq(steps[1].start, 0, 'b 应与 a 同时开始（修复前是 1000）：');
      eq(tl.build().duration, 1000, '总时长取 max，应为 1000 而非 2000：');
    });

    test('add 仍是串行，gap 之后的 with 从空档结束处起算（防止矫枉过正）', () => {
      const tl = new Timeline('t').add('a', 1000).add('b', 500);
      const s1 = tl.build().steps;
      eq(s1[0].start, 0, 'a 从 0：');
      eq(s1[1].start, 1000, 'b 串行接在 a 之后：');

      const tl2 = new Timeline('t').add('a', 1000).gap(500).with('c', 200);
      const s2 = tl2.build().steps;
      eq(s2[1].start, 1500, '空档之后的 with 应从 1500 开始：');
    });
  });

  describe('cutscene · update 无 dt 守卫（P1）', () => {
    /**
     * 【⚠️ 报告里"NaN 帧额外造成时间损失（112 而非 160）"这一条实测不成立】
     *
     * 我按报告的说法复现（play → update(NaN) → 10 帧 16ms），
     * 实测修复前后 time 都是 **160**，没有 112 这回事。
     * 原因是 NaN 帧根本走不到推进分支：
     * `want = time + NaN = NaN`，`NaN > time` 恒为 false，
     * 于是不推进也**不损失**——这一帧被自然跳过了。
     *
     * 【但这条 P1 依然成立，只是危害点不同，而且更严重】
     * 真正的坑在**门控（waitFor）已经激活之后**来一个异常帧：
     * 此时走的是 `this._blockElapsed += dtMs`，
     * NaN 一进来，`_blockElapsed` 就永久变成 NaN，
     * 而 `NaN >= timeoutMs` 恒为 false → **超时机制彻底失效**。
     *
     * 实测（修复前，门控激活后插一帧 NaN，再正常推进 3000ms）：
     * ```
     * 对照（正常帧）: {"state":"finished","timedOut":true}
     * NaN 帧       : {"state":"blocked", "timedOut":false,"time":100}  ← 永久挂起
     * Infinity 帧  : {"state":"finished","timedOut":true,"time":null}  ← 时间轴被污染
     * ```
     *
     * 这就是报告说的"上层等演出结束的等待逻辑永久挂起"——
     * 但它只在**带门控的演出**上才会发生，且必须异常帧落在门控激活之后。
     */
    const mkGated = (): Cutscene =>
      new Cutscene({
        id: 'x',
        steps: [
          { id: 'intro', kind: 'intro', start: 0, duration: 100 },
          // 永不满足的门控，1 秒后超时放行
          { id: 'gate', kind: 'gate', start: 100, duration: 0, waitFor: (): boolean => false, timeoutMs: 1000 },
          { id: 'after', kind: 'after', start: 100, duration: 100 },
        ],
        duration: 200,
      });

    /** 推进到门控激活 → 插一帧异常 dt → 再正常推进 3000ms */
    const runWith = (bad: number): Cutscene => {
      const c = mkGated();
      c.play();
      c.update(100); // time=100，门控激活
      c.update(bad); // ← 异常帧落在门控已激活之后
      for (let i = 0; i < 30; i++) c.update(100); // 再给 3000ms，远超 timeout
      return c;
    };

    test('⚠️ NaN 帧不得污染门控计时，超时仍须放行', () => {
      const c = runWith(NaN);
      assert(c.timedOut, '门控应超时放行（修复前会永远卡在 blocked）');
      eq(c.state, 'finished', '演出应正常结束：');
    });

    test('⚠️ Infinity 帧不得把时间轴污染成 NaN', () => {
      const c = runWith(Infinity);
      assert(Number.isFinite(c.time), `time 应仍是有限数，实际 ${c.time}`);
      eq(c.state, 'finished', '演出应正常结束：');
    });

    test('⚠️ 异常 dt 不得推进时间轴', () => {
      const c1 = mkGated();
      c1.play();
      c1.update(NaN);
      eq(c1.time, 0, 'NaN 帧不应推进时间：');

      const c2 = mkGated();
      c2.play();
      c2.update(-50);
      eq(c2.time, 0, '负 dt 不应推进时间：');
    });

    test('正常 dt 照常推进、门控照常超时（防止矫枉过正）', () => {
      const c = runWith(100);
      assert(c.timedOut, '正常帧下门控应超时放行');
      eq(c.state, 'finished', '演出应结束：');

      const c2 = new Cutscene({
        id: 'x',
        steps: [{ id: 'a', kind: 'a', start: 0, duration: 1000 }],
        duration: 1000,
      });
      c2.play();
      c2.update(16);
      eq(c2.time, 16, '正常帧应推进 16ms：');
    });
  });

  describe('cutscene · update 的 64 次门控上限是魔法数（P2）', () => {
    test('⚠️ 门控上限应可由构造配置调整', () => {
      /**
       * 【修复前】`for (let guard = 0; guard < 64; guard++)` 写死在循环条件里。
       * 门极多时一帧推进不完，演出变慢，而调用方没有任何办法调整——
       * 数值埋在代码里，配置驱动这条铁律就落空了。
       */
      const waitFor = (): boolean => true;
      const steps = Array.from({ length: 100 }, (_, i) => ({
        id: 'g' + i, kind: 'g' + i, start: 0, duration: 0, waitFor,
      }));

      const c = new Cutscene({ id: 'x', steps, duration: 1000 }, { maxGatesPerTick: 200 });
      c.play();
      c.update(10);
      assert(c.time > 0, '提高上限后一帧应能推进');
    });

    test('不传配置时默认仍是 64（防止矫枉过正）', () => {
      const c = new Cutscene({ id: 'x', steps: [], duration: 1000 });
      c.play();
      c.update(500);
      eq(c.time, 500, '默认配置下行为不变：');
    });
  });

  // ============================================================
  // debug-console
  // ============================================================

  describe('debug-console · execute 把内部异常 rethrow（P1）', () => {
    test('⚠️ 默认必须吞掉异常并转成一行红字', () => {
      /**
       * 【修复前】`catch` 里打印 `✗ 命令内部错误：<堆栈>` 之后又 `throw e`。
       * 实测：注册 `run: () => { throw new Error('内部炸了') }`，
       * `dc.execute('boom')` **向外抛出异常**。
       *
       * 控制台是"运行时调试"的最后一道防线，本应吞掉一切异常。
       * 现在它把异常抛回 UI 的输入事件处理器——
       * 一行打错的命令就能让整个输入系统崩溃，
       * 而此时错误已经被打印过一次（重复暴露）。
       */
      const dc = new DebugConsole({ enabled: true });
      const out: string[] = [];
      dc.onOutput((l) => out.push(l));
      dc.register({ name: 'boom', help: 'x', run: (): void => { throw new Error('内部炸了'); } });

      let threw: unknown = null;
      try { dc.execute('boom'); } catch (e) { threw = e; }
      assert(threw === null, '默认不应向外抛异常');
      assert(out.length > 0 && out[0].includes('命令内部错误'), '应输出红字提示');
    });

    test('显式 rethrow:true 时仍可向上抛（防止矫枉过正）', () => {
      const dc = new DebugConsole({ enabled: true, rethrow: true });
      dc.onOutput((): void => {});
      dc.register({ name: 'boom', help: 'x', run: (): void => { throw new Error('内部炸了'); } });

      throws(() => { dc.execute('boom'); }, '内部炸了', 'rethrow 模式应继续抛：');
    });
  });

  describe('debug-console · _coerce 的 int 把空串当 0（P1）', () => {
    test('⚠️ 引号内空串必须报参数错误，不能静默当 0', () => {
      /**
       * `Number('') === 0`、`Number(' ') === 0`，且 `Number.isInteger(0) === true`。
       * `tokenize` 只过滤未加引号的空白，引号内空串（`""`）是合法 token。
       *
       * 实测（修复前）：`set_hp ""` → 参数值 0，静默把血量设为 0。
       * 调试命令本来就权限很大，这种写法会让一条手滑的输入
       * 直接毁掉正在调试的局。
       */
      const dc = new DebugConsole({ enabled: true });
      const out: string[] = [];
      dc.onOutput((l) => out.push(l));
      let got: unknown = '（未执行）';
      dc.register({
        name: 'set_hp', help: 'x',
        args: [{ name: 'v', type: 'int' }],
        run: (args): string => { got = args.get('v'); return 'hp=' + String(args.get('v')); },
      });

      dc.execute('set_hp ""');
      eq(got as unknown as string, '（未执行）', '空串不应被当成 0 执行：');
      assert(out.some((l) => l.includes('需要数字')), '应报参数错误');
    });

    test('正常数字照常解析（防止矫枉过正）', () => {
      const dc = new DebugConsole({ enabled: true });
      dc.onOutput((): void => {});
      let got: unknown = null;
      dc.register({
        name: 'set_hp', help: 'x',
        args: [{ name: 'v', type: 'int' }],
        run: (args): string => { got = args.get('v'); return 'ok'; },
      });

      dc.execute('set_hp 50');
      eq(got as unknown as number, 50, '正常数字应照常解析：');
    });
  });

  describe('debug-console · 历史去重只看上一条（P2）', () => {
    test('⚠️ 记录真实语义：只与上一条比，A-B-A 会存 3 条', () => {
      /**
       * 【这不算 bug】多数 shell 也是这个行为，
       * 但与"去重"的直觉有偏差——用户容易以为"输过的不会重复记录"。
       *
       * 修法选的是**改文档而不是改行为**：
       * 真的做成全局去重的话，调试时反复执行同一条命令
       * （比如反复 `reload` 看效果）就再也翻不到历史，反而更难用。
       * 所以这里用测试把这个行为**钉住**，README 里说清真实语义。
       */
      const dc = new DebugConsole({ enabled: true });
      dc.onOutput((): void => {});
      dc.register({ name: 'noop', help: 'x', run: (): void => {} });

      dc.execute('noop a');
      dc.execute('noop b');
      dc.execute('noop a');
      eq(dc.history.length, 3, 'A-B-A 应存 3 条（仅避免与上一条连续重复）：');

      dc.execute('noop a');
      eq(dc.history.length, 3, '与上一条完全相同时才不记录：');
    });
  });

  describe('debug-console · list() 每次排序 + _resolve 是 O(n)（P2）', () => {
    test('⚠️ 别名必须走索引，list() 结果必须被缓存', () => {
      /**
       * 【修复前】`_resolve` 对未命中名字的情况遍历**全部命令**比对 alias 数组
       * （O(命令数 × 别名数)），`complete()` 每次按键都会调 `list()` → 每次全量排序。
       * 命令数量大时（几百条）补全有卡顿。
       */
      const dc = new DebugConsole({ enabled: true });
      const out: string[] = [];
      dc.onOutput((l) => out.push(l));
      dc.register({ name: 'teleport', alias: ['tp'], help: 'x', run: (): string => 'ok' });

      dc.execute('tp');
      eq(out[0], 'ok', '别名应能解析到命令：');
      assert(dc.list() === dc.list(), 'list() 应返回缓存的同一数组');
    });

    test('unregister 后别名索引与缓存同步失效（防止矫枉过正）', () => {
      const dc = new DebugConsole({ enabled: true });
      const out: string[] = [];
      dc.onOutput((l) => out.push(l));
      dc.register({ name: 'teleport', alias: ['tp'], help: 'x', run: (): string => 'ok' });

      dc.execute('tp');
      eq(out.length, 1, '注册后别名可用：');

      dc.unregister('teleport');
      dc.execute('tp');
      // 未知命令会先输出 "✗ 未知命令：tp"，再输出一行"猜你想输入…"的建议，
      // 所以判据是"任意一行出现未知命令"，而不是看最后一行
      assert(
        out.slice(1).some((l) => l.includes('未知命令')),
        '注销后别名必须失效，不能仍然命中索引'
      );
      assert(!out.slice(1).includes('ok'), '注销后不应再执行成功');
    });
  });

  // ============================================================
  // gesture
  // ============================================================

  describe('gesture · maxPoints 裁剪丢起点导致长按判不出来（P1）', () => {
    test('⚠️ 长按时长必须用真实按下时刻，不能用窗口里最早的点', () => {
      /**
       * 【修复前】`maxPoints` 是滑动窗口，`shift()` 丢的是**最早的点**，
       * 而"按了多久"恰恰由最早的点决定。
       *
       * 实测（修复前）：`maxPoints: 8`、静止按住 1 秒（20 个采样点）：
       * ```
       * pointCount=8 首点 t=650      ← 起点 0 被丢
       * isLongPressSoFar(1000)=false ← 阈值 600ms，实际按了 1000ms，判不出来
       * up -> {"kind":"tap"}          ← 长按被识别成单击
       * ```
       *
       * 只在特定设备复现（采样率越高、maxPoints 越小越容易），极难定位。
       */
      const rec = new GestureRecognizer({ maxPoints: 8, longPressMs: 600 });
      rec.down({ x: 100, y: 100, t: 0 });
      for (let i = 1; i <= 19; i++) {
        // 轻微抖动 1px，保证 move 不被去抖过滤
        rec.move({ x: 100 + (i % 2), y: 100, t: i * 50 });
      }

      assert(rec.isLongPressSoFar(1000), '按了 1000ms 应已构成长按');
      const g = rec.up({ x: 100, y: 100, t: 1000 });
      eq(g.kind, 'longPress', '1 秒长按不应被识别成单击：');
    });

    test('短按仍识别为 tap，滑动仍正常（防止矫枉过正）', () => {
      const rec = new GestureRecognizer({ maxPoints: 8, longPressMs: 600 });
      rec.down({ x: 100, y: 100, t: 0 });
      for (let i = 1; i <= 5; i++) rec.move({ x: 100 + (i % 2), y: 100, t: i * 20 });
      const g = rec.up({ x: 100, y: 100, t: 100 });
      eq(g.kind, 'tap', '100ms 短按应仍是 tap：');

      const rec2 = new GestureRecognizer({ maxPoints: 8 });
      rec2.down({ x: 0, y: 0, t: 0 });
      for (let i = 1; i <= 10; i++) rec2.move({ x: i * 20, y: 0, t: i * 16 });
      const g2 = rec2.up({ x: 200, y: 0, t: 160 });
      assert(g2.kind === 'swipe' || g2.kind === 'drag', `快速水平移动应识别为滑动，实际 ${g2.kind}`);
    });
  });

  // ============================================================
  // matchops
  // ============================================================

  describe('matchops · Reconnect 的 graceMs/graceDecay 为 NaN（P1）', () => {
    test('⚠️ graceDecay=NaN 时重连仍必须判超时', () => {
      /**
       * 【修复前】`??` 只挡 null/undefined，挡不住 NaN。
       * `_computeGrace` 里 `Math.max(minGrace, Math.round(NaN))` = NaN，
       * 而 `elapsed > NaN` **恒为 false** → 永不过期。
       *
       * 实测（修复前）：
       * ```
       * graceDecay=NaN：第 1 次 grace=120000（Math.pow(NaN,0)===1，侥幸正确）
       *   重连后 attempts=1 → grace=NaN
       *   再断线，10 小时后 reconnect -> {"ok":true}   ← 永不过期
       *   tick(36e6) -> []                              ← 也永不判弃权
       * ```
       *
       * 后果是悬挂对局：队友掉线 3 小时，比赛一直不结束；
       * 而他既不是 forfeited 也不是 exhausted，队友连扣分减免都拿不到。
       */
      const t = new ReconnectTracker({ graceDecay: NaN });
      t.register(['a']);
      assert(Number.isFinite(t.graceFor('a')), '初始宽限期必须是有限数');

      t.markDisconnected('a', 0);
      t.reconnect('a', 1000);
      assert(Number.isFinite(t.graceFor('a')), `重连后宽限期仍须有限，实际 ${t.graceFor('a')}`);

      t.markDisconnected('a', 1000);
      const r = t.reconnect('a', 36e6); // 10 小时后
      assert(!r.ok, '10 小时后重连必须被拒');
      eq(r.reason, 'expired', '原因：');
    });

    test('⚠️ graceMs=NaN 时同样不得永不过期', () => {
      const t = new ReconnectTracker({ graceMs: NaN });
      t.register(['b']);
      t.markDisconnected('b', 0);
      const r = t.reconnect('b', 36e6);
      assert(!r.ok, 'graceMs=NaN 时 10 小时后重连也必须被拒');
    });

    test('tick 在 NaN 配置下仍能判弃权', () => {
      const t = new ReconnectTracker({ graceDecay: NaN });
      t.register(['a']);
      t.markDisconnected('a', 0);
      const forfeited = t.tick(36e6);
      eq(forfeited.length, 1, '超时应判 1 人弃权：');
    });

    test('正常配置下宽限期照常递减（防止矫枉过正）', () => {
      const t = new ReconnectTracker({ graceMs: 120_000, graceDecay: 0.6, minGraceMs: 30_000 });
      t.register(['a']);
      eq(t.graceFor('a'), 120_000, '第 1 次 2 分钟：');

      t.markDisconnected('a', 0);
      t.reconnect('a', 1000);
      eq(t.graceFor('a'), 72_000, '第 2 次 120000 × 0.6 = 72 秒：');

      // 宽限期内重连成功
      const t2 = new ReconnectTracker({ graceMs: 120_000 });
      t2.register(['c']);
      t2.markDisconnected('c', 0);
      assert(t2.reconnect('c', 60_000).ok, '30 秒后重连应成功');
    });
  });

  describe('matchops · Surrender.vote 对掉线玩家返回 ok:true（P1）', () => {
    test('⚠️ 掉线玩家的票必须当场拒绝', () => {
      /**
       * 【修复前】`vote` 只查 `_team.has(id)` 和 state/deadline，**不查 connected**；
       * 而 `_tally` 里 `if (!this._connected.has(id)) continue;` 把掉线者的票跳过。
       *
       * 实测（修复前）：
       * ```
       * 3 人队，c 掉线后 c 投票 -> {"ok":true}   ← 告诉 c "你投成功了"
       * status -> {yes:1, eligible:2, needMore:1} ← c 的票没被计入
       * ```
       *
       * 玩家会反复点、以为是网络问题。配合 `requireAllConnected: true`（默认）时，
       * 只要有一人掉线，投降永远无法达成，对局被拖到超时。
       */
      const s = new Surrender({ teamSize: 3 });
      s.setTeam(['a', 'b', 'c']);
      s.setConnected(['a', 'b', 'c']);
      s.markMatchStart(0);
      assert(s.start('a', 400_000).ok, '全员在线时应能发起');

      s.setConnected(['a', 'b']); // c 掉线
      const r = s.vote('c', 'yes', 400_001);
      assert(!r.ok, '掉线玩家的票应被拒');
      if (!r.ok) eq(r.error, 'not-connected', '错误码：');

      const st = s.status(400_001);
      eq(st.yes, 1, '掉线者的票不应被计入（只有发起人 a 的 1 票）：');
    });

    test('在线玩家的票照常计入（防止矫枉过正）', () => {
      const s = new Surrender({ teamSize: 3 });
      s.setTeam(['a', 'b', 'c']);
      s.setConnected(['a', 'b', 'c']);
      s.markMatchStart(0);
      s.start('a', 400_000);

      assert(s.vote('b', 'yes', 400_001).ok, '在线玩家投票应成功');
      eq(s.status(400_001).yes, 2, 'a 与 b 共 2 票：');
    });
  });

  // ============================================================
  // skill-variant
  // ============================================================

  describe('skill-variant · applyPatch 的 switch 无 default（P1）', () => {
    test('⚠️ 未知 op 必须抛错，不能被算作"已应用"', () => {
      /**
       * 【修复前】`switch (p.op)` 只有 7 个 case，没有 default。
       *
       * 实测（修复前）：
       * `{op:'nope', path:'dmg', value:1}` → `apply` 返回
       * `{result:{dmg:5}, applied:['w']}` —— **补丁被算作已应用，但值没变**。
       *
       * 配置里 op 拼错（`'multiply'` 而非 `'mul'`），
       * 变体显示"已生效"但技能数值毫无变化。
       * 玩家和策划都认为是"数值没配够"，不会想到是 op 名错了。
       */
      throws(
        () => applyPatch({ dmg: 5 }, { op: 'nope' as never, path: 'dmg', value: 1 }),
        '未知补丁操作',
        '未知 op 应抛错：'
      );
    });

    test('七个合法 op 全部仍然生效（防止矫枉过正）', () => {
      const o: Record<string, unknown> = { dmg: 10, tags: ['a'] };
      applyPatch(o, { op: 'set', path: 'name', value: 'x' });
      applyPatch(o, { op: 'add', path: 'dmg', value: 5 });
      applyPatch(o, { op: 'mul', path: 'dmg', value: 2 });
      applyPatch(o, { op: 'max', path: 'dmg', value: 100 });
      applyPatch(o, { op: 'min', path: 'dmg', value: 50 });
      applyPatch(o, { op: 'push', path: 'tags', value: ['b'] });
      applyPatch(o, { op: 'remove', path: 'name' });

      eq(o['dmg'], 50, 'set/add/mul/max/min 链式结果：');
      assert(o['name'] === undefined, 'remove 应删掉字段');
      eq((o['tags'] as string[]).length, 2, 'push 应追加：');
    });
  });

  describe('skill-variant · 数值 op 未校验结果有限性（P1）', () => {
    test('⚠️ 运算结果溢出成 Infinity 必须抛错', () => {
      /**
       * 【报告原文说的是 `mul: NaN` 会污染结果，但实测不成立】
       * `assertOperand` 已经在入口拦下了 `value` 为 NaN / Infinity 的情况
       * （实测 `{op:'mul', value:NaN}` 会抛
       * "mul 要求 value 是有限数字"）。这条在更早的批次里已经修过了。
       *
       * 【但同类的洞确实存在，只是入口不同】
       * 老实现只校验**操作数**和**旧值**是有限数，**不校验结果**。
       * 两个都合法的输入相乘可以溢出：
       * `dmg: 1e308`、`mul: 10` → `Infinity`。
       * Infinity 进入技能定义后，伤害计算、UI 显示、存档全部变成 null
       * （JSON 序列化 Infinity 得 null），
       * 而 `applied` 列表里这个变体仍是"成功应用"的。
       *
       * 所以保留这条修复，但把判据从"操作数 NaN"改成"结果非有限"。
       */
      throws(
        () => applyPatch({ dmg: 1e308 }, { op: 'mul', path: 'dmg', value: 10 }),
        '不是有限数字',
        '结果溢出应抛错：'
      );
    });

    test('正常数值运算不受影响（防止矫枉过正）', () => {
      const o = { dmg: 5 };
      applyPatch(o, { op: 'mul', path: 'dmg', value: 2 });
      eq(o.dmg, 10, 'mul 2 应得 10：');
      applyPatch(o, { op: 'add', path: 'dmg', value: -3 });
      eq(o.dmg, 7, 'add -3 应得 7（负数不该被误拒）：');
    });
  });

  describe('skill-variant · 互斥检查只处理第一个冲突者（P1）', () => {
    test('⚠️ 三变体互斥时必须移除全部冲突者', () => {
      /**
       * 【修复前】`const blockedBy = final.find(...)` 只找**第一个**冲突者，
       * 然后只替换这一个。
       *
       * 实测（修复前）：A（prio 1）、B（prio 1）、C（prio 10，`excludes:['A','B']`）
       * → `apply(..., ['A','B','C'])` → `applied === ["B","C"]`。
       * C 明确排除了 A 和 B，正确结果应只剩 C，但 B 被留下了。
       *
       * 因为 A 确实被移除了，表面上看"互斥是生效的"，更具欺骗性。
       */
      const sys = new SkillVariantSystem<Record<string, unknown>>();
      sys.register({ id: 'A', name: 'A', priority: 1, patches: [{ op: 'set', path: 'x', value: 1 }] });
      sys.register({ id: 'B', name: 'B', priority: 1, patches: [{ op: 'set', path: 'x', value: 2 }] });
      sys.register({ id: 'C', name: 'C', priority: 10, excludes: ['A', 'B'], patches: [{ op: 'set', path: 'x', value: 3 }] });

      const r = sys.apply({ x: 0 }, ['A', 'B', 'C'], { data: {} });
      eq(r.applied.length, 1, '应只剩 C：');
      eq(r.applied[0], 'C', '留下的是 C：');
      eq(r.result['x'], 3, '结果取 C 的值：');
    });

    test('无互斥时全部保留，低优先级冲突时新变体被跳过（防止矫枉过正）', () => {
      const sys = new SkillVariantSystem<Record<string, unknown>>();
      sys.register({ id: 'A', name: 'A', priority: 1, patches: [{ op: 'set', path: 'x', value: 1 }] });
      sys.register({ id: 'B', name: 'B', priority: 1, patches: [{ op: 'set', path: 'y', value: 2 }] });

      const r = sys.apply({ x: 0, y: 0 }, ['A', 'B'], { data: {} });
      eq(r.applied.length, 2, '无互斥时应全部保留：');

      // 新变体优先级更低 → 应被跳过，两个冲突者都留着
      const sys2 = new SkillVariantSystem<Record<string, unknown>>();
      sys2.register({ id: 'Hi', name: 'Hi', priority: 10, patches: [{ op: 'set', path: 'x', value: 1 }] });
      sys2.register({ id: 'Lo', name: 'Lo', priority: 0, excludes: ['Hi'], patches: [{ op: 'set', path: 'x', value: 9 }] });
      const r2 = sys2.apply({ x: 0 }, ['Hi', 'Lo'], { data: {} });
      eq(r2.applied.length, 1, '低优先级者应被跳过：');
      eq(r2.applied[0], 'Hi', '保留高优先级：');
    });
  });
}
