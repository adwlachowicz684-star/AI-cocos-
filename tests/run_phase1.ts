/**
 * tests/run_phase1.ts —— 精审修复回归（第一批）
 *
 * 【为什么单独立文件】
 * 这些用例守的是**具体单元里的具体漏洞**，不是通用守卫。
 * 每条都对应一个实测确认过的故障，且**在修复前会失败**——
 * 这是判断用例是否有效的唯一标准。
 *
 * 【每条用例都要能回答三个问题】
 * 1. 修复前表现是什么（实测输出写进注释）
 * 2. 后果有多严重（为什么必须修）
 * 3. 修复后应该是什么
 */

import { describe, test, assert, eq, throws } from './_framework';

import { applyPatch as applySnapshotPatch } from '../snapshot/Snapshot';
import { applyPatch as applyVariantPatch } from '../skill-variant/SkillVariant';
import { Shop } from '../shop/Shop';
import { Raycasting, Shadowcasting } from '../fov/FOV';
import { BuffSystem } from '../buff/BuffSystem';
import { ShuffleBag } from '../loot/ShuffleBag';
import { IRandomSource } from '../_core/types';

export function runPhase1Tests(): void {
  // ============================================================
  // 模式 D · 进程级原型污染
  // ============================================================

  describe('原型污染 · 路径写入（进程级，最高优先）', () => {
    test('⚠️ snapshot: __proto__ 路径必须被拒', () => {
      /**
       * 【修复前实测】
       * ```js
       * applyPatch({}, { set: { '__proto__.snapshotPolluted': true }, remove: [] });
       * ({}).snapshotPolluted // → true
       * ```
       * 这不是"改坏了目标对象"，而是**整个进程的所有对象都被污染**，
       * 之后任何 `if (obj.snapshotPolluted)` 都为真，不可逆、无报错。
       * patch 常来自存档或网络包，属于外部输入。
       */
      let threw = false;
      try {
        applySnapshotPatch({}, { set: { '__proto__.snapshotPolluted': true }, remove: [] });
      } catch {
        threw = true;
      }
      assert(threw, '__proto__ 路径应抛错');
      eq(({} as Record<string, unknown>).snapshotPolluted, undefined, '原型不应被污染');
    });

    test('⚠️ skill-variant: __proto__ 路径必须被拒', () => {
      /**
       * 【修复前实测】
       * ```js
       * applyPatch({}, { op: 'set', path: '__proto__.skillPolluted', value: true });
       * ({}).skillPolluted // → true
       * ```
       * 补丁路径来自遗物/词条配置表，是外部输入。
       */
      let threw = false;
      try {
        applyVariantPatch({}, { op: 'set', path: '__proto__.skillPolluted', value: true });
      } catch {
        threw = true;
      }
      assert(threw, '__proto__ 路径应抛错');
      eq(({} as Record<string, unknown>).skillPolluted, undefined, '原型不应被污染');
    });

    test('⚠️ 危险段出现在路径中间也要拦（不只是开头）', () => {
      // 只检查首段是最常见的漏法
      throws(
        () => applyVariantPatch({}, { op: 'set', path: 'a.constructor.b', value: 1 }),
        'constructor'
      );
    });

    test('安全路径不受影响（防止矫枉过正）', () => {
      const t: Record<string, unknown> = {};
      applyVariantPatch(t, { op: 'set', path: 'projectile.count', value: 3 });
      eq((t.projectile as Record<string, unknown>).count, 3, '正常嵌套写入应照常工作');
    });
  });

  // ============================================================
  // snapshot · 同层数组删除顺序
  // ============================================================

  describe('snapshot · 数组删除顺序', () => {
    test('⚠️ 删 [1][2] 应得 ["a"]，不是 ["a","c"]', () => {
      /**
       * 【修复前实测】
       * ```js
       * applyPatch({ arr:['a','b','c'] }, { set:{}, remove:['arr[1]','arr[2]'] });
       * // → ['a','c']（期望 ['a']）
       * ```
       * 老实现只按深度降序排，同深度时 `Array.sort` 稳定 → 保持 [1],[2]，
       * 先删下标 1 后元素左移，再删下标 2 删到的是**原来的下标 3**。
       * 撤销栈、状态同步会静默丢数据。
       */
      const out = applySnapshotPatch<{ arr: string[] }>(
        { arr: ['a', 'b', 'c'] },
        { set: {}, remove: ['arr[1]', 'arr[2]'] }
      );
      eq(JSON.stringify(out.arr), JSON.stringify(['a']), `实际 ${JSON.stringify(out.arr)}`);
    });

    test('乱序给定删除下标也正确（调用方不该关心顺序）', () => {
      const out = applySnapshotPatch<{ arr: string[] }>(
        { arr: ['a', 'b', 'c', 'd'] },
        { set: {}, remove: ['arr[0]', 'arr[3]', 'arr[1]'] }
      );
      eq(JSON.stringify(out.arr), JSON.stringify(['c']), `实际 ${JSON.stringify(out.arr)}`);
    });
  });

  // ============================================================
  // shop · 经济漏洞
  // ============================================================

  describe('shop · 经济漏洞', () => {
    function mkShop(): Shop {
      const s = new Shop();
      s.defineItem({ id: 'potion', name: '药水', basePrice: 10 });
      s.stock('potion', 5);
      return s;
    }

    test('⚠️ 负数量购买必须被拒（原：空手套白狼）', () => {
      /**
       * 【修复前实测】
       * ```js
       * shop.buy('potion', -2, { gold: 0 })
       * // → { ok: true, total: -20 }，钱包 0 → 20，库存 5 → 7
       * ```
       * 买 -2 个反而倒赚 20 金币、凭空多出 2 件库存。
       * 连 `stock.count < quantity`（5 < -2）的库存检查都被绕过。
       */
      const s = mkShop();
      const w: Record<string, number> = { gold: 0 };
      throws(() => s.buy('potion', -2, w), '不能为负');
      eq(w.gold, 0, '钱包不应增加');
      eq(s.stockOf('potion'), 5, '库存不应增加');
    });

    test('⚠️ 币种名为原型键时空钱包买不成', () => {
      /**
       * 【修复前实测】
       * ```js
       * shop.buy('potion', 1, {}, 'toString')
       * // → { ok: true }，空钱包买成，钱包被写入 toString: NaN
       * ```
       * `wallet['toString']` 取到原型函数，`?? 0` 挡不住，
       * `function < 10` 是 NaN 比较恒 false → **资金检查被整个绕过**。
       */
      const s = mkShop();
      const w: Record<string, number> = {};
      const r = s.buy('potion', 1, w, 'toString');
      eq(r.ok, false, `不应买成，实际 ${JSON.stringify(r)}`);
    });

    test('正常购买不受影响（防止矫枉过正）', () => {
      const s = mkShop();
      const w: Record<string, number> = { gold: 100 };
      const r = s.buy('potion', 2, w);
      eq(r.ok, true, '正常购买应成功');
      eq(w.gold, 80, '应扣 20');
      eq(s.stockOf('potion'), 3, '应扣 2 件库存');
    });

    test('钱不够仍然买不成（原逻辑保留）', () => {
      const s = mkShop();
      const w: Record<string, number> = { gold: 5 };
      const r = s.buy('potion', 1, w);
      eq(r.ok, false, '钱不够应失败');
    });
  });

  // ============================================================
  // 无界 count → 死循环
  // ============================================================

  describe('无界 count · 实测卡死的三处', () => {
    test('⚠️ FOV radius=Infinity 应抛错而不是卡死', () => {
      /**
       * 【修复前实测】`timeout 5` 退出码 124（进程卡死）。
       * `for (let dy = -Infinity; dy <= Infinity; dy++)` 永不结束。
       */
      throws(() => new Raycasting(20, 20, () => false).compute(5, 5, Infinity), '必须是有限数值');
      throws(() => new Shadowcasting(20, 20, () => false).compute(5, 5, Infinity), '必须是有限数值');
    });

    test('FOV 正常半径不受影响（防止矫枉过正）', () => {
      const r = new Raycasting(20, 20, () => false).compute(5, 5, 6);
      assert(r > 0, `正常半径应有可见格，实际 ${r}`);
    });

    test('⚠️ buff stacks=Infinity 应抛错而不是卡死', () => {
      /**
       * 【修复前实测】`timeout 5` 退出码 124。
       * independent 模式下 stacks 直接是 `for` 的循环次数。
       */
      const s = new BuffSystem();
      s.register({ id: 'x', stackMode: 'independent', duration: 1 });
      throws(() => s.apply('x', Infinity), '必须是有限数值');
    });

    test('⚠️ ShuffleBag count=Infinity 应抛错而不是卡死', () => {
      /**
       * 【修复前实测】`timeout 5` 退出码 124。
       * 老实现只有 `count <= 0` 检查，Infinity 与 NaN 都畅通。
       */
      const b = new ShuffleBag<string>({});
      throws(() => b.add('a', Infinity), '必须是有限数值');
      throws(() => b.add('a', NaN), '必须是有限数值');
    });

    test('ShuffleBag 正常权重不受影响', () => {
      const b = new ShuffleBag<string>({});
      b.add('a', 2);
      b.add('b', 1);
      const src: IRandomSource = { next: () => 0.5 };
      let drew = 0;
      for (let i = 0; i < 30; i++) {
        if (b.draw(src) !== undefined) drew++;
      }
      assert(drew > 0, `应能正常抽取，实际抽到 ${drew} 次`);
    });
  });
}
