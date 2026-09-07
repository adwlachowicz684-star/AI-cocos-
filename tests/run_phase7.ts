/**
 * tests/run_phase7.ts —— 第二批精审 · 财产/安全类 P0 修复回归
 *
 * 【这一批的性质】
 * 前六批处理的是"我自己实跑复现的清单"。这五份报告来自**另一次独立精审**，
 * 两个清单重叠极小——30 个 P0 里只撞上 1 条（snapshot 数组删除）。
 * 所以本批是**新增**的修复，不是重复劳动。
 *
 * 【为什么优先修这 6 条】
 * 它们都能造成**实际的资产损失或安全放行**，且全程静默：
 *
 * | 编号 | 单元 | 后果 |
 * |---|---|---|
 * | P0-6 | meta | NaN 余额 → 零成本解锁整棵成长树 |
 * | P0-22 | currency | 兑换抛错后源货币消失（钱凭空没了）|
 * | P0-25 | quest | 一次 NaN 让任务瞬间完成并发出奖励 |
 * | P0-27 | shop | 定价 NaN → 钱包变 NaN（等价无限金币）/ 0 元购 |
 * | P0-19 | skill-variant | 未注入 evaluator → 门禁失效（fail-open）|
 * | P0-7 | anticheat | 证据 NaN → 作弊者被判 none 放行 |
 *
 * 【贯穿全批的一个模式：否定式判定会被 NaN 利用】
 * `if (have < cost) return 拒绝` —— NaN 让 `<` 恒为 false，
 * 于是"拒绝分支永不进入"，坏数据反而一路畅通。
 * 改成 `if (!(have >= cost)) return 拒绝` 后，
 * NaN 让 `>=` 为 false、取反为 true → **天然走拒绝分支**。
 *
 * 同一模式出现在：meta 的余额检查、quest 的完成判定、
 * shop 的资金检查。改法一致，都是"否定式 → 肯定式"。
 *
 * 【另一个模式：`Math.max(0, x)` 兜不住 NaN】
 * `Math.max(0, NaN) === NaN`。本批 meta、quest、shop 三处
 * 都曾靠它兜底。收口必须显式判 `Number.isFinite`。
 */

import { describe, test, assert, eq, throws } from './_framework';

import { MetaProgression } from '../meta/MetaProgression';
import { Wallet } from '../currency/Currency';
import { QuestSystem } from '../quest/QuestSystem';
import { Shop } from '../shop/Shop';
import { SkillVariantSystem } from '../skill-variant/SkillVariant';
import { suspicionScore } from '../anticheat/AntiCheat';

export function runPhase7Tests(): void {
  // ============================================================
  // P0-6 · meta：NaN 货币不能零成本解锁
  // ============================================================

  describe('meta · 货币 NaN 与零成本解锁（P0-6）', () => {
    test('⚠️ addCurrency(NaN) 必须抛错，不能毒化余额', () => {
      /**
       * 【修复前】`Math.max(0, cur + NaN)` = NaN，余额整条变 NaN。
       * 而 `canUnlock` 里 `currency < cost` 恒为 false →
       * **"余额不足"判定彻底失效 → 零成本解锁任何节点**。
       */
      const m = new MetaProgression({ nodes: [{ id: 'a', cost: [10] }] });
      m.addCurrency('default', 100);
      throws(() => m.addCurrency('default', NaN), '有限数字');
      assert(Number.isFinite(m.currency('default')), '余额不应被污染');
    });

    test('⚠️ 余额不足时正确拒绝（对照组，确保没修过头）', () => {
      const m = new MetaProgression({ nodes: [{ id: 'a', cost: [10] }] });
      m.addCurrency('default', 5);
      eq(m.canUnlock('a').ok, false, '余额 5 < 成本 10 应拒绝');
      eq(m.canUnlock('a').reason, 'insufficient-currency');
    });

    test('⚠️ 余额充足时能正常解锁（防止矫枉过正）', () => {
      const m = new MetaProgression({ nodes: [{ id: 'a', cost: [10] }] });
      m.addCurrency('default', 100);
      eq(m.canUnlock('a').ok, true);
      eq(m.unlock('a'), 1, '解锁后等级应为 1');
      eq(m.currency('default'), 90, '应扣掉 10');
    });

    test('⚠️ 负数金额仍被 clamp 到 0（原有行为保留）', () => {
      const m = new MetaProgression({ nodes: [{ id: 'a', cost: [10] }] });
      m.addCurrency('default', 50);
      m.addCurrency('default', -100);
      eq(m.currency('default'), 0, '负数应被夹到 0');
    });
  });

  // ============================================================
  // P0-22 · currency：exchange 非原子
  // ============================================================

  describe('currency · exchange 的原子性（P0-22）', () => {
    test('⚠️ 目标为付费货币时抛错，源货币不丢失', () => {
      /**
       * 【修复前】`spend()` 已扣款并落流水，`add()` 随后抛错，
       * 异常直接逃逸 → **源货币永久丢失**。
       * 实测：gold 1000 → 500，gem 仍为 0。
       *
       * `premium: true`（线上充值货币的标准配置）是必现路径。
       */
      const w = new Wallet({
        defs: [
          { id: 'gold', name: '金币' },
          { id: 'gem', name: '钻石', premium: true },
        ],
        initial: { gold: 1000 },
      });
      throws(() => w.exchange('gold', 500, 'gem', 10), '付费货币');
      eq(w.get('gold'), 1000, '源货币必须分文未动');
    });

    test('⚠️ 正常兑换仍然可用（防止矫枉过正）', () => {
      const w = new Wallet({
        defs: [
          { id: 'gold', name: '金币' },
          { id: 'silver', name: '银两' },
        ],
        initial: { gold: 100 },
      });
      eq(w.exchange('gold', 30, 'silver', 300), true);
      eq(w.get('gold'), 70);
      eq(w.get('silver'), 300);
    });

    test('⚠️ 余额不足时返回 false 且不扣款', () => {
      const w = new Wallet({
        defs: [
          { id: 'gold', name: '金币' },
          { id: 'silver', name: '银两' },
        ],
        initial: { gold: 10 },
      });
      eq(w.exchange('gold', 9999, 'silver', 1), false);
      eq(w.get('gold'), 10, '失败的兑换不应扣款');
    });

    test('⚠️ 兑换成同一种货币仍然抛错', () => {
      const w = new Wallet({ defs: [{ id: 'gold', name: '金币' }], initial: { gold: 100 } });
      throws(() => w.exchange('gold', 10, 'gold', 10), '同一种货币');
    });
  });

  // ============================================================
  // P0-25 · quest：NaN 不能让任务瞬间完成
  // ============================================================

  describe('quest · NaN 与虚假完成（P0-25）', () => {
    test('⚠️ report(n=NaN) 必须抛错，任务不能变 completed', () => {
      /**
       * 【修复前】`Math.min(need, next[i] + NaN)` = NaN，
       * 而 `_isAllDone` 里 `progress[i] < need` 在 NaN 时为 false
       * → 判定"全部达标" → **任务瞬间完成且可领奖**。
       *
       * `event.n` 常常就是伤害值，一次除零就能触发。
       */
      const q = new QuestSystem();
      q.define({
        id: 'q1',
        name: '讨伐史莱姆',
        objectives: [{ type: 'kill', target: 'slime', count: 5 }],
        rewards: { gold: 100 },
      });
      q.accept('q1');
      throws(() => q.report({ type: 'kill', target: 'slime', n: NaN }), '有限正数');
      assert(q.get('q1')!.status !== 'completed', '不应被判定完成');
    });

    test('⚠️ setProgress(NaN) 必须抛错', () => {
      /** 【修复前】`Math.max(0, NaN)` = NaN，兜底无效。 */
      const q = new QuestSystem();
      q.define({ id: 'q1', name: '讨伐', objectives: [{ type: 'kill', target: 'slime', count: 5 }] });
      q.accept('q1');
      throws(() => q.setProgress('q1', 0, NaN), '有限数字');
    });

    test('⚠️ 正常推进仍可完成（防止矫枉过正）', () => {
      const q = new QuestSystem();
      q.define({ id: 'q1', name: '讨伐', objectives: [{ type: 'kill', target: 'slime', count: 2 }] });
      q.accept('q1');
      q.report({ type: 'kill', target: 'slime', n: 1 });
      q.report({ type: 'kill', target: 'slime', n: 1 });
      eq(q.get('q1')!.status, 'completed', '达到 2/2 应完成');
    });

    test('⚠️ 超额推进时进度被夹到 need（不显示 7/5）', () => {
      const q = new QuestSystem();
      q.define({ id: 'q1', name: '讨伐', objectives: [{ type: 'kill', target: 'slime', count: 5 }] });
      q.accept('q1');
      q.report({ type: 'kill', target: 'slime', n: 100 });
      eq(q.get('q1')!.progress[0], 5, '应夹到 5 而不是 100');
    });

    test('⚠️ _isAllDone 用肯定式判定（NaN 视为未完成）', () => {
      /**
       * 这是本条的核心：`progress[i] < need` 会让 NaN 被当成"达标"，
       * `!(progress[i] >= need)` 会让 NaN 被当成"未完成"。
       */
      const q = new QuestSystem();
      q.define({ id: 'q1', name: '讨伐', objectives: [{ type: 'kill', target: 'slime', count: 5 }] });
      q.accept('q1');
      // 通过 setProgress 只能传合法值，这里验证的是"进度为 0 时确实未完成"
      q.setProgress('q1', 0, 0);
      assert(q.get('q1')!.status !== 'completed', '进度 0 不应完成');
      q.setProgress('q1', 0, 5);
      eq(q.get('q1')!.status, 'completed', '达到 5 应完成');
    });
  });

  // ============================================================
  // P0-27 · shop：定价 NaN 与 0 元购
  // ============================================================

  describe('shop · 定价 NaN 与 0 元购（P0-27）', () => {
    test('⚠️ 定价钩子返回 NaN 时，priceOf 收口为 0 且交易被拒绝', () => {
      /**
       * 【修复前】`Math.max(0, Math.round(NaN))` = NaN，
       * `buy` 里 `have < NaN` 恒 false → 交易"成功"，
       * `wallet[currency] = have - NaN` → **余额永久变 NaN**
       * （此后什么都能买，等价无限金币）。
       */
      const shop = new Shop();
      shop.defineItem({ id: 'sword', name: '剑', basePrice: 100 });
      shop.stock('sword', 10);
      shop.setPricing(() => NaN);

      eq((shop as unknown as { priceOf(a: string, b: 'buy', c: number): number })
        .priceOf('sword', 'buy', 1), 0, '对外收口成 0，UI 不崩');

      const wallet: Record<string, number> = { gold: 1000 };
      const r = shop.buy('sword', 1, wallet, 'gold');
      eq(r.ok, false, '定价不可信时必须拒绝，不能 0 元成交');
      assert(Number.isFinite(wallet.gold), '钱包不能被写成 NaN');
      eq(wallet.gold, 1000, '不应扣款');
    });

    test('⚠️ 卖出侧同样拒绝（防止刷库存）', () => {
      /** 卖出侧若按 0 放行，玩家可用"卖 0 金币"把物品刷进商店库存。 */
      const shop = new Shop();
      shop.defineItem({ id: 'sword', name: '剑', basePrice: 100 });
      shop.setPricing(() => NaN);
      const wallet: Record<string, number> = { gold: 0 };
      const r = shop.sell('sword', 1, wallet, 'gold');
      eq(r.ok, false, '定价不可信时不能卖出');
      eq(wallet.gold, 0);
    });

    test('⚠️ 正常定价不受影响（防止矫枉过正）', () => {
      const shop = new Shop();
      shop.defineItem({ id: 'sword', name: '剑', basePrice: 100 });
      shop.stock('sword', 10);
      const wallet: Record<string, number> = { gold: 1000 };
      const r = shop.buy('sword', 1, wallet, 'gold');
      eq(r.ok, true);
      eq(r.total, 100);
      eq(wallet.gold, 900);
    });

    test('⚠️ 折扣钩子仍可正常生效', () => {
      const shop = new Shop();
      shop.defineItem({ id: 'sword', name: '剑', basePrice: 100 });
      shop.stock('sword', 10);
      shop.setPricing((p) => p * 0.8);
      eq((shop as unknown as { priceOf(a: string, b: 'buy', c: number): number })
        .priceOf('sword', 'buy', 1), 80, '八折应生效');
    });
  });

  // ============================================================
  // P0-19 · skill-variant：门禁失效（fail-open）
  // ============================================================

  describe('skill-variant · 未注入 evaluator 时不得放行（P0-19）', () => {
    test('⚠️ 带 conditions 但无 evaluator → 抛错（fail-closed）', () => {
      /**
       * 【修复前】`if (!this._evaluator) return true`
       * ——注释还写着"视为已满足，因为静默失效更难查"。
       *
       * 那个论证只比较了两种**静默**方案，漏掉了第三种：抛错。
       * 抛错既不静默生效也不静默失效，恰好消掉原顾虑。
       *
       * 而 fail-open 的代价是门禁失效：玩家没有遗物也能吃遗物加成。
       */
      const sv = new SkillVariantSystem();
      sv.register({
        id: 'v',
        name: '需要遗物',
        conditions: [{ id: 'need-relic' }],
        patches: [{ op: 'set', path: 'dmg', value: 101 }],
      });
      throws(() => sv.apply({ id: 's', dmg: 1 }, ['v'], { data: {} }), 'evaluator');
    });

    test('⚠️ 注入 evaluator 后条件不满足时不应用', () => {
      const sv = new SkillVariantSystem({ evaluator: () => false });
      sv.register({
        id: 'v',
        name: '需要遗物',
        conditions: [{ id: 'need-relic' }],
        patches: [{ op: 'set', path: 'dmg', value: 101 }],
      });
      const r = sv.apply({ id: 's', dmg: 1 }, ['v'], { data: {} });
      eq(r.applied.length, 0, '条件不满足不应应用');
      eq(r.result.dmg, 1, '原值不变');
    });

    test('⚠️ 条件满足时正常应用（防止矫枉过正）', () => {
      const sv = new SkillVariantSystem({ evaluator: () => true });
      sv.register({
        id: 'v',
        name: '需要遗物',
        conditions: [{ id: 'need-relic' }],
        patches: [{ op: 'set', path: 'dmg', value: 101 }],
      });
      const r = sv.apply({ id: 's', dmg: 1 }, ['v'], { data: {} });
      eq(r.applied.length, 1);
      eq(r.result.dmg, 101);
    });

    test('⚠️ 无 conditions 的变体即使没有 evaluator 也能生效', () => {
      /**
       * 这条是关键的对照片：门禁只针对"声明了 conditions"的变体。
       * 没声明条件的变体本就不需要求值器，不该被误伤。
       */
      const sv = new SkillVariantSystem();
      sv.register({ id: 'v', name: '无条件', patches: [{ op: 'set', path: 'dmg', value: 101 }] });
      const r = sv.apply({ id: 's', dmg: 1 }, ['v'], { data: {} });
      eq(r.applied.length, 1, '无条件变体应正常生效');
      eq(r.result.dmg, 101);
    });
  });

  // ============================================================
  // P0-7 · anticheat：NaN 让作弊者被放过
  // ============================================================

  describe('anticheat · 证据 NaN 与静默放行（P0-7）', () => {
    test('⚠️ 核心证据为 NaN 时必须抛错，不能兜底成 0', () => {
      /**
       * 【为什么不能用 numOr 一刀切】
       * `numOr(NaN, 0)` 会把"违规 10 次"和"数据损坏"都变成 0 分——
       * 与原本的失败模式（放行）**结果完全一样**，等于没修。
       *
       * 必须区分：字段没传（undefined）→ 记 0；传了但是 NaN → 抛错。
       */
      throws(() => suspicionScore({ speedViolations: NaN } as never), '坏数据');
      throws(() => suspicionScore({ accuracyZ: NaN } as never), '坏数据');
    });

    test('⚠️ 字段缺失（undefined）视为 0，其余证据照常生效', () => {
      /**
       * 【修复前】`intervalCv: NaN` → score 变 NaN → actionFor 返回 'none'
       * —— 一个"速度违规 10 次 + 命中率 z=6"的账号被直接放过。
       *
       * 【修复后】cv 视为"无信息"（不计分），其余证据照常：
       * speed 40 + accuracy 30 = 70 分，足以触发处置。
       */
      const r = suspicionScore({ speedViolations: 10, accuracyZ: 6, intervalCv: NaN });
      assert(Number.isFinite(r.score), 'score 必须是有效数字');
      assert(r.action !== 'none', '不能因 cv 为 NaN 就放行');
      assert(r.score >= 70, '其余证据应照常计分');
    });

    test('⚠️ 正常高分输入仍能判 ban（防止矫枉过正）', () => {
      const r = suspicionScore({ speedViolations: 10, accuracyZ: 6, intervalCv: 0.01 });
      assert(Number.isFinite(r.score));
      eq(r.action, 'ban', '本应 ban');
    });

    test('⚠️ 干净玩家不被误判（防止矫枉过正）', () => {
      const r = suspicionScore({ speedViolations: 0, accuracyZ: 1, intervalCv: 0.5 });
      eq(r.action, 'none', '干净玩家应放行');
      eq(r.score, 0);
    });

    test('⚠️ score 被夹在 0~100 且 breakdown 各项有限', () => {
      const r = suspicionScore({
        speedViolations: 100,
        accuracyZ: 50,
        intervalCv: 0,
        reportScore: 100,
        isNewAccount: true,
      });
      assert(r.score >= 0 && r.score <= 100, 'score 应在 0~100');
      for (const v of Object.values(r.breakdown)) {
        assert(Number.isFinite(v as number), `breakdown 各项应有限，收到 ${v}`);
      }
    });
  });
}
