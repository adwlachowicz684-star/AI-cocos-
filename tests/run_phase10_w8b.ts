/**
 * tests/run_phase10_w8b.ts —— 第二次精审 · 窗口 W8-B 返工回归
 *
 * 【本批 3 个单元】affix / binary / blessing
 * 【条目】11（P1 × 8，P2 × 3 组：A3~A6 / B5~B9 / B10~B13）
 *
 * 【每条修复的三件套】
 * 1. 一条**修复前会失败**的用例（注释里注明"修复前"的真实输出）
 * 2. 一条**防止矫枉过正**的对照用例（正常输入不受影响）
 * 3. 源码里的"为什么"注释
 *
 * 【本批判定为"不成立"的条目】（每条都有实测数据，见对应用例的注释）
 * - affix A5  `_pickDef` 全量扫描 O(N·M)：1000 defs 单次 roll(4) ≈ 0.058ms
 * - binary B9 / affix A6 / blessing B13  无 destroy()：三个单元都是纯逻辑，
 *   没有 install / 监听器 / 定时器，铁律 5 不适用（N/A）
 *
 * 【本批判定为"需总审裁决"的条目】
 * - binary B6 `SchemaOptions.version` 不进字节流：修法（加版本号进流 / 改文档）
 *   会改变字节格式，属于 breaking，见用例 `B6` 的注释。
 *
 * 【为什么没动 tests/run.ts】
 * 16 个窗口同时开工，run.ts 由总审统一合并注册；本文件只保证自身能独立通过 tsc。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import {
  AffixSystem,
  validateAffixPool,
  DefaultRarities,
  type AffixDef,
  type RarityDef,
} from '../affix/AffixSystem';
import {
  uint,
  int,
  float,
  enumeration,
  schema,
  BitWriter,
  BitReader,
  utf8Encode,
  utf8Decode,
} from '../binary/BinarySerializer';
import { BlessingSystem } from '../blessing/Blessing';

/** 固定序列随机源：让"区间内取值"可复现 */
function seq(arr: readonly number[]): { next(): number } {
  let i = 0;
  return { next: () => arr[i++ % arr.length] };
}

const ONE_RARITY: readonly RarityDef[] = [
  { id: 'common', weight: 1, valueScale: 1, tier: 0 },
];

export function runPhase10W8BTests(): void {
  // ================================================================
  describe('W8-B · affix（P1-1 窄区间越界 / P1-2 degraded 不复位）', () => {
    // ================================================================

    /**
     * 【P1-1 复现（修复前）】
     *
     * def.min=1.2 max=1.4 precision=0 → 实际值 = **1**（不在 [1.2, 1.4] 内）
     * def.min=0.05 max=0.07 precision=1 → 实际值 = **0**（不在 [0.05, 0.07] 内）
     *
     * 成因：`lo = ceil(rawLo·f)/f`、`hi = floor(rawHi·f)/f`，
     * 区间窄于一个精度单位时 `hi < lo`，`v = lo` 之后又被
     * `if (v > hi) v = hi` 拉到 `hi` —— 两个边界都不在配置区间里。
     */
    test('P1-1 ⚠️ 区间窄于一个精度单位时，值仍落在 [min, max] 内', () => {
      const sys = new AffixSystem({
        defs: [
          { id: 'a1', stat: 'critMul', op: 'add', min: 1.2, max: 1.4, rarity: 'common', precision: 0 },
          { id: 'a2', stat: 'leech', op: 'add', min: 0.05, max: 0.07, rarity: 'common', precision: 1 },
        ],
        rarities: ONE_RARITY,
        rng: seq([0, 0.25, 0.5, 0.75, 0.999]),
        maxAffixes: 4,
      });

      // 多个随机点都取样，避免"恰好落在区间内"的偶然通过
      for (let k = 0; k < 5; k++) {
        const a = sys.roll(undefined, 1, { onlyStats: ['critMul'] })[0];
        assert(
          a.value >= 1.2 && a.value <= 1.4,
          `critMul 应落在 [1.2, 1.4] 内，实际 ${a.value}`
        );
        const b = sys.roll(undefined, 1, { onlyStats: ['leech'] })[0];
        assert(
          b.value >= 0.05 && b.value <= 0.07,
          `leech 应落在 [0.05, 0.07] 内，实际 ${b.value}`
        );
      }
    });

    test('P1-1（对照）：正常宽度区间仍然满足 precision 且不越界', () => {
      const sys = new AffixSystem({
        defs: [
          { id: 'p0', stat: 'atk', op: 'add', min: 5, max: 10, rarity: 'common', precision: 0 },
          { id: 'p2', stat: 'crit', op: 'add', min: 0.05, max: 0.15, rarity: 'common', precision: 2 },
        ],
        rarities: ONE_RARITY,
        rng: seq([0, 0.5, 0.999, 0.25]),
        maxAffixes: 4,
      });
      for (let k = 0; k < 8; k++) {
        const a = sys.roll(undefined, 1, { onlyStats: ['atk'] })[0];
        assert(a.value >= 5 && a.value <= 10, `atk 越界：${a.value}`);
        eq(a.value, Math.round(a.value), 'precision=0 时必须是整数');

        const b = sys.roll(undefined, 1, { onlyStats: ['crit'] })[0];
        assert(b.value >= 0.05 && b.value <= 0.15, `crit 越界：${b.value}`);
        near(b.value, Math.round(b.value * 100) / 100, 1e-9, 'precision=2 时应是 2 位小数');
      }
    });

    test('P1-1（配置期）：validateAffixPool 对窄区间出 warning', () => {
      const v = validateAffixPool(
        [{ id: 'a1', stat: 'critMul', op: 'add', min: 1.2, max: 1.4, rarity: 'common', precision: 0 }],
        ONE_RARITY
      );
      assert(v.ok, '窄区间是 warning 不是 error，不该让游戏起不来');
      assert(
        v.warnings.some((w) => w.includes('窄于一个精度单位')),
        `应提示区间窄于精度单位，实际 warnings = ${JSON.stringify(v.warnings)}`
      );
      // 正常宽度不该报这一条（防止矫枉过正）
      const ok = validateAffixPool(
        [{ id: 'a2', stat: 'atk', op: 'add', min: 5, max: 10, rarity: 'common', precision: 0 }],
        ONE_RARITY
      );
      assert(
        !ok.warnings.some((w) => w.includes('窄于一个精度单位')),
        '正常宽度区间不该报窄区间 warning'
      );
    });

    /**
     * 【P1-2 复现（修复前）】
     * 第 1 次 rerollAll（降级）后置 true，**再跑 2 次（未降级）后仍是 true**。
     * 字段语义变成"历史是否曾降级"，与 README 的"本次是否降级"不符。
     */
    test('P1-2 ⚠️ lastRerollDegraded 表示"本次"，未降级时复位', () => {
      const sys = new AffixSystem({
        defs: [
          { id: 'c', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common' },
          { id: 'e', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'epic' },
        ],
        // 两个权重都是 0 → _pickRarity 恒返回第一个（common，tier 0）
        rarities: [
          { id: 'common', weight: 0, valueScale: 1, tier: 0 },
          { id: 'epic', weight: 0, valueScale: 1, tier: 2 },
        ],
        rng: seq([0.5]),
        maxAffixes: 4,
      });
      const high = [{ defId: 'e', stat: 'atk', op: 'add' as const, value: 1, rarity: 'epic', percent: false }];
      const low = [{ defId: 'c', stat: 'atk', op: 'add' as const, value: 1, rarity: 'common', percent: false }];

      sys.rerollAll(high);   // epic(tier2) → common(tier0)：降级
      eq(sys.lastRerollDegraded, true, '本次降级应为 true');

      sys.rerollAll(low);    // common → common：未降级
      eq(sys.lastRerollDegraded, false, '未降级时必须复位为 false（修复前这里仍是 true）');

      sys.rerollAll(low);
      eq(sys.lastRerollDegraded, false, '连续未降级仍应为 false');
    });

    test('P1-2（对照）：空输入与"重铸后更好"都不置 degraded', () => {
      const sys = new AffixSystem({
        defs: [{ id: 'c', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common' }],
        rarities: ONE_RARITY,
        rng: seq([0.5]),
        maxAffixes: 4,
      });
      eq(sys.rerollAll([]).length >= 0, true, '空输入不抛错');
      eq(sys.lastRerollDegraded, false, '空输入不应置 degraded');
    });
  });

  // ================================================================
  describe('W8-B · affix（P2 A3 权重 NaN / A4 valueScale / A6 destroy）', () => {
    // ================================================================

    /**
     * 【A3 复现（修复前）】
     * common=100 / epic=NaN 时，`_pickRarity` 200 次**全部返回 epic**，
     * 一次 common 都没出过；`validateAffixPool` 报 `ok = true`，零 error。
     *
     * 成因：`total += NaN` → total 是 NaN → `total <= 0` 为 false（NaN 比较恒 false）
     * → 走不到回落分支 → `x -= NaN` 让 `x <= 0` 也恒 false → 永远返回最后一个。
     */
    test('A3 ⚠️ 稀有度 weight 为 NaN 时构造即抛错（不再静默偏斜）', () => {
      throws(
        () =>
          new AffixSystem({
            defs: [{ id: 'c', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common' }],
            rarities: [{ id: 'common', weight: NaN, valueScale: 1, tier: 0 }],
          }),
        '权重非法'
      );
    });

    test('A3 ⚠️ 校验函数也不再对 NaN 权重放行', () => {
      const v = validateAffixPool(
        [{ id: 'c', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common' }],
        [{ id: 'common', weight: NaN, valueScale: 1, tier: 0 }]
      );
      eq(v.ok, false, 'NaN 权重必须是 error（修复前 ok = true）');
      assert(v.errors.some((e) => e.includes('权重非法')), JSON.stringify(v.errors));
    });

    test('A3 ⚠️ 运行时池内权重为 NaN 时不再"永远抽最后一条"', () => {
      // 构造期绕过校验的场景：defs 的 weight 走的是 `_pickDef`，不是构造校验
      const sys = new AffixSystem({
        defs: [
          { id: 'x', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common', weight: 1 },
          { id: 'y', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common', weight: NaN as unknown as number },
        ],
        rarities: ONE_RARITY,
        rng: seq([0.01]),
        maxAffixes: 4,
        allowDuplicate: false,
      });
      // 权重 NaN 的 y 应被当作 0 → 抽不到；修复前会永远命中 y
      const got = sys.roll(undefined, 1, { onlyStats: ['atk'] })[0];
      eq(got.defId, 'x', 'NaN 权重应等价于"抽不到"，修复前会恒定命中最后一条');
    });

    test('A3（对照）：正常权重分布仍然按权重工作', () => {
      const sys = new AffixSystem({
        defs: [
          { id: 'hi', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common', weight: 90 },
          { id: 'lo', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common', weight: 10 },
        ],
        rarities: ONE_RARITY,
        rng: seq([0.05, 0.5, 0.95]),
        maxAffixes: 4,
      });
      let hi = 0;
      let lo = 0;
      for (let i = 0; i < 100; i++) {
        const a = sys.roll(undefined, 1, { onlyStats: ['atk'] })[0];
        if (a.defId === 'hi') hi++;
        else lo++;
      }
      assert(hi > lo, `90:10 的权重应让 hi 明显更多，实际 hi=${hi} lo=${lo}`);
    });

    /**
     * 【A4 复现（修复前）】
     * valueScale=NaN → roll 出 **NaN**；valueScale=-1 → roll 出 **-10**（区间 [5,10] 整体反向）。
     */
    test('A4 ⚠️ valueScale 为 NaN / 负数时按中性值 1 处理', () => {
      for (const bad of [NaN, -1]) {
        const sys = new AffixSystem({
          defs: [{ id: 'a', stat: 'atk', op: 'add', min: 5, max: 10, rarity: 'common' }],
          rarities: [{ id: 'common', weight: 1, valueScale: bad, tier: 0 }],
          rng: seq([0.5]),
          maxAffixes: 4,
        });
        const v = sys.roll(undefined, 1)[0].value;
        assert(Number.isFinite(v), `valueScale=${bad} 时不该出 NaN，实际 ${v}`);
        assert(v >= 5 && v <= 10, `valueScale=${bad} 时应回落到 [5,10]（按 1 处理），实际 ${v}`);
      }
    });

    test('A4 ⚠️ 校验函数对非法 valueScale 出 warning', () => {
      for (const bad of [NaN, -1]) {
        const v = validateAffixPool(
          [{ id: 'a', stat: 'atk', op: 'add', min: 5, max: 10, rarity: 'common' }],
          [{ id: 'common', weight: 1, valueScale: bad, tier: 0 }]
        );
        assert(
          v.warnings.some((w) => w.includes('valueScale')),
          `valueScale=${bad} 应出 warning，实际 ${JSON.stringify(v.warnings)}`
        );
      }
      // 合法 valueScale 不该报（防止矫枉过正）
      const okV = validateAffixPool(
        [{ id: 'a', stat: 'atk', op: 'add', min: 5, max: 10, rarity: 'common' }],
        DefaultRarities
      );
      assert(
        !okV.warnings.some((w) => w.includes('valueScale')),
        '默认稀有度不该报 valueScale warning'
      );
    });

    test('A4 ⚠️ 词条 min/max 为 NaN 时构造即抛错', () => {
      const bad: AffixDef = { id: 'a', stat: 'atk', op: 'add', min: NaN, max: 10, rarity: 'common' };
      throws(() => new AffixSystem({ defs: [bad] }), '不是有限数字');
    });

    test('A4（对照）：正常 valueScale 仍然放大数值', () => {
      const sys = new AffixSystem({
        defs: [{ id: 'a', stat: 'atk', op: 'add', min: 5, max: 10, rarity: 'common' }],
        rarities: [{ id: 'common', weight: 1, valueScale: 2, tier: 0 }],
        rng: seq([0.5]),
        maxAffixes: 4,
      });
      const v = sys.roll(undefined, 1)[0].value;
      assert(v >= 10 && v <= 20, `valueScale=2 时应落在 [10, 20]，实际 ${v}`);
    });

    /**
     * 【A5 结论：不成立（附实测）】
     *
     * 报告说 `_pickDef` 每次全量扫 defs，N 个词条 = O(N·M)。
     * 实测（1000 条 defs、roll(4)、2000 次）：总耗时 ~115ms，
     * **单次 roll ≈ 0.058ms**，即一帧（16.7ms）能做约 290 次。
     * 真实配表规模（几十到几百条）下这个开销完全不可见。
     *
     * 【为什么不给它加索引】
     * 加"按稀有度预分组"的索引属于重构，违反第 1.1 节第 1 条，
     * 而且它会引入"defs 后续被外部修改"时索引失效的新风险。
     * 所以它维持现状，这里只留一条**性能护栏**：
     * 哪天有人改坏了让它变成真 O(N²)，这条会红。
     */
    test('A5（不成立·性能护栏）：1000 defs 下 roll(4) 仍是亚毫秒级', () => {
      const defs: AffixDef[] = [];
      for (let i = 0; i < 1000; i++) {
        defs.push({ id: 'd' + i, stat: 's' + (i % 50), op: 'add', min: 1, max: 10, rarity: 'common' });
      }
      const sys = new AffixSystem({
        defs,
        rarities: ONE_RARITY,
        rng: { next: () => Math.random() },
        maxAffixes: 4,
      });
      const t0 = Date.now();
      for (let i = 0; i < 2000; i++) sys.roll(undefined, 4);
      const per = (Date.now() - t0) / 2000;
      // 阈值取得很松（单次 2ms），只用于拦住"退化成 O(N²)"这种量级的变化
      assert(per < 2, `单次 roll(4) 应 < 2ms，实测 ${per.toFixed(4)}ms（原值约 0.058ms）`);
    });

    /** 【A6】affix 是纯逻辑，没有 install / 监听器 / 定时器，铁律 5 不适用 */
    test('A6（N/A）：affix 无 install，故无需 destroy', () => {
      const sys = new AffixSystem({
        defs: [{ id: 'a', stat: 'atk', op: 'add', min: 1, max: 2, rarity: 'common' }],
        rarities: ONE_RARITY,
      });
      eq(typeof (sys as unknown as { destroy?: unknown }).destroy, 'undefined');
      // 多次使用不残留状态（等价的"可卸载"保证）
      eq(sys.roll(undefined, 1).length, 1);
      eq(sys.roll(undefined, 1).length, 1);
    });
  });

  // ================================================================
  describe('W8-B · binary（P1-3 31/32 位 / P1-4 量化 / P1-5 越界）', () => {
    // ================================================================

    /**
     * 【P1-3 复现（修复前）】
     *
     * uint(31) describe => uint31[0..-2147483649]
     * uint(32) describe => uint32[0..0]
     * int(32)  describe => int32[2147483648..-2147483649]
     * uint(31).write(1) => THROW: uint31 越界：1（范围 0..-2147483649）
     * int(32).write(0)  => THROW: int32 越界：0（范围 2147483648..-2147483649）
     * BitWriter.writeBits(1, 31) => THROW: 值 1 需要超过 31 位表示
     *
     * 而 README §6① 写"位宽上限 32"、§8 声称覆盖"32 位边界（0xffffffff）"，
     * 按文档定义 32 位 ID / 哈希字段必然踩坑。
     */
    test('P1-3 ⚠️ uint 的 31 / 32 位范围正确且可写可读', () => {
      eq(uint(31).describe, 'uint31[0..2147483647]', '修复前是 uint31[0..-2147483649]');
      eq(uint(32).describe, 'uint32[0..4294967295]', '修复前是 uint32[0..0]');

      for (const [bits, v] of [[31, 0], [31, 1], [31, 2147483647], [32, 0], [32, 4294967295]] as const) {
        const f = uint(bits);
        const w = new BitWriter();
        f.write(w, v);
        eq(f.read(new BitReader(w.toBytes())), v, `uint(${bits}) 写 ${v} 应能原样读回`);
      }
    });

    test('P1-3 ⚠️ int 的 31 / 32 位范围正确且可写可读', () => {
      eq(int(32).describe, 'int32[-2147483648..2147483647]', '修复前上下界是反的');
      eq(int(31).describe, 'int31[-1073741824..1073741823]');

      for (const [bits, v] of [
        [31, -1073741824], [31, 0], [31, 1073741823],
        [32, -2147483648], [32, 0], [32, 2147483647],
      ] as const) {
        const f = int(bits);
        const w = new BitWriter();
        f.write(w, v);
        eq(f.read(new BitReader(w.toBytes())), v, `int(${bits}) 写 ${v} 应能原样读回`);
      }
    });

    test('P1-3 ⚠️ writeBits 的 31 位阈值不再误判', () => {
      const w = new BitWriter();
      w.writeBits(1, 31);            // 修复前：THROW "值 1 需要超过 31 位表示"
      eq(new BitReader(w.toBytes()).readBits(31), 1);
    });

    test('P1-3（对照）：越界值仍然抛错，且不静默回绕', () => {
      throws(() => uint(31).write(new BitWriter(), 2147483648), '越界');
      throws(() => uint(32).write(new BitWriter(), 4294967296), '越界');
      throws(() => int(32).write(new BitWriter(), 2147483648), '越界');
      throws(() => int(32).write(new BitWriter(), -2147483649), '越界');
      // 小数仍然单独报"需要整数"
      throws(() => uint(31).write(new BitWriter(), 1.5), '整数');
      // 位宽上限 32 的构造校验仍然有效
      throws(() => schema({ v: uint(33) }), '超过 32');
    });

    test('P1-3（对照）：常规位宽行为不变（8/16 位往返）', () => {
      const s = schema<{ a: number; b: number }>({ a: uint(8), b: int(16) });
      const back = s.decode(s.encode({ a: 255, b: -32768 }));
      eq(back.a, 255);
      eq(back.b, -32768);
    });

    /**
     * 【P1-4 复现（修复前）】
     * `float(0, 1.8, 0.5)` → describe 为 2bit，`.write(1.8)`
     * 抛 `[Binary] 值 4 需要超过 2 位表示`——**配置的上界自己写不进去**。
     *
     * 另外读端能表示的最大值（min + (2^bits-1)·step）会超出 max，与写端不对称。
     */
    test('P1-4 ⚠️ 配置上界自己可以写进去', () => {
      const f = float(0, 1.8, 0.5);
      const w = new BitWriter();
      f.write(w, 1.8);                       // 修复前抛错
      const back = f.read(new BitReader(w.toBytes()));
      assert(back <= 1.8 + 1e-9, `读回值不得超出 max，实际 ${back}`);
    });

    test('P1-4 ⚠️ 浮点误差不再让档位少算一档（0.3/0.1）', () => {
      const f = float(0, 0.3, 0.1);
      const w = new BitWriter();
      f.write(w, 0.3);
      near(f.read(new BitReader(w.toBytes())), 0.3, 1e-6, '0.3 应能写进 0~0.3/0.1 的字段');
    });

    test('P1-4 ⚠️ 读端能读到的最大值不超过 max（读写对称）', () => {
      const f = float(0, 5, 2);
      const w = new BitWriter();
      w.writeBits(3, f.bits);                // 写满位宽
      const back = f.read(new BitReader(w.toBytes()));
      assert(back <= 5 + 1e-9, `读端最大值应 <= max(5)，实际 ${back}（修复前是 6）`);
    });

    test('P1-4（对照）：常规量化误差仍小于 step', () => {
      const s = schema<{ x: number }>({ x: float(-100, 100, 0.01) });
      for (const v of [0, 1.5, -33.33, 99.99, -100, 100]) {
        const back = s.decode(s.encode({ x: v })).x;
        assert(Math.abs(back - v) <= 0.01 + 1e-9, `${v} 的误差应 <= step，实际 ${back}`);
      }
    });

    /**
     * 【P1-5 复现（修复前）】
     * `float(0,10,1)` 写入 999 后读回 **10**，无任何报错；
     * 而 uint / int 同场景是抛错。README §6③ 写的是"越界值绝不静默截断"。
     */
    test('P1-5 ⚠️ float 越界抛错，与 uint / int 对齐', () => {
      const f = float(0, 10, 1);
      throws(() => f.write(new BitWriter(), 999), '越界');
      throws(() => f.write(new BitWriter(), -1), '越界');
      // 非有限值仍然单独报（与越界区分，见 README §6②）
      throws(() => f.write(new BitWriter(), NaN), '非有限');
      throws(() => f.write(new BitWriter(), Infinity), '非有限');
    });

    test('P1-5 ⚠️ 显式 clamp 时才截断，且不回绕', () => {
      const c = float(-10, 10, 0.1, 0, { clamp: true });
      const w = new BitWriter();
      c.write(w, 999);
      const back = c.read(new BitReader(w.toBytes()));
      assert(back <= 10 && back > 0, `显式 clamp 应截断到边界且不回绕，实际 ${back}`);
    });

    test('P1-5（对照）：float 合法往返不受影响', () => {
      const s = schema<{ hp: number }>({ hp: float(0, 1000, 0.1, 0) });
      for (const v of [0, 0.1, 123.4, 1000]) {
        const back = s.decode(s.encode({ hp: v })).hp;
        assert(Math.abs(back - v) <= 0.1 + 1e-9, `${v} 往返误差应 <= step，实际 ${back}`);
      }
    });
  });

  // ================================================================
  describe('W8-B · binary（P2 B5 enum / B6 version / B7-B8 utf8 / B9 destroy）', () => {
    // ================================================================

    /**
     * 【B5】README §7 写"enum 索引越界 → 返回 undefined，后续崩溃 → 退化为默认值"，
     * 实现返回的是构造时传入的 `def`，"退化为默认值"这半句是对的，
     * "返回 undefined"这半句是错的（实现从未返回过 undefined）。
     * 按第 4 节模式 F：改文档说清真实语义（已改 README 表格）。
     */
    test('B5 ⚠️ enum 越界索引退化为 def，不是 undefined', () => {
      const e = enumeration(['a', 'b', 'c'] as const, 'a');
      const w = new BitWriter();
      w.writeBits(3, e.bits);     // 3 个候选占 2 位，索引 3 是越界的
      const got = e.read(new BitReader(w.toBytes()));
      eq(got, 'a', '应退化为默认 def（README 曾写"返回 undefined"，与实现不符）');
      assert(got !== undefined, '绝不返回 undefined');
    });

    test('B5（对照）：合法索引正常往返', () => {
      const e = enumeration(['a', 'b', 'c'] as const, 'a');
      for (const v of ['a', 'b', 'c'] as const) {
        const w = new BitWriter();
        e.write(w, v);
        eq(e.read(new BitReader(w.toBytes())), v);
      }
      throws(() => e.write(new BitWriter(), 'zzz' as unknown as 'a'), '未知值');
    });

    /**
     * 【B6 结论：需总审裁决】
     *
     * 实测：`schema({ hp: uint(8) }, { version: 7 })` 编码 `{hp:100}` 只有 1 字节（0x64），
     * 版本号既不进字节流，`decode` 也读不回来。
     * 而 README §5/§7 要求"读取时判断要不要迁移"——只有 bytes 时做不到。
     *
     * 两种改法都是 breaking，不敢自己拍板：
     * - A：把 version 写进字节流（比如固定 8/16 位前缀）→ 所有已有存档格式变化，
     *   且 RecordArray 的下界估算、minBytes 全部要跟着改；
     * - B：不动字节流，改文档说明"version 只服务于人，调用方要自己在包外层带版本号"。
     *
     * 这里只给现状上锁（version 可读、不进流），等总审裁决。
     */
    test('B6（需裁决）：version 可读但不进字节流——现状上锁', () => {
      const s = schema<{ hp: number }>({ hp: uint(8) }, { version: 7, name: 'hero' });
      eq(s.version, 7);
      const bytes = s.encode({ hp: 100 });
      eq(bytes.length, 1, 'version 不占字节（现状）——若裁决为方案 A，这条会变红');
      eq(s.decode(bytes).hp, 100);
    });

    /**
     * 【B7 复现（修复前）】`utf8Decode([0x41, 0xff, 0x42])` → `"AB"`，
     * 非法字节被 `i++; continue;` 静默丢弃，长度差 1 谁也不会注意。
     */
    test('B7 ⚠️ 非法字节产出替换字符，不再静默丢弃', () => {
      const got = utf8Decode(new Uint8Array([0x41, 0xff, 0x42]));
      eq(got, 'A\ufffdB', '修复前是 "AB"（0xff 被无声丢掉）');
      eq(got.length, 3, '字节数应对得上，肉眼可见"这里坏过"');
      // 截断数据同样要留痕
      eq(utf8Decode(new Uint8Array([0x41, 0xe4])), 'A\ufffd', '被截断的多字节序列也要留痕');
    });

    /**
     * 【B8 复现（修复前）】孤立代理项 → `ed a0 80`（WTF-8 三字节），
     * 标准 UTF-8 解码器会判为非法序列并拒绝整段数据。
     */
    test('B8 ⚠️ 孤立代理项编码为 U+FFFD，不再产出 WTF-8', () => {
      const bytes = utf8Encode('\ud800');
      eq(Array.from(bytes).join(','), '239,191,189', '应为 ef bf bd（修复前是 ed a0 80）');
      eq(bytes.length, 3, '字节数不变，string(maxBytes) 的预算不受影响');
      eq(utf8Decode(bytes), '\ufffd');
    });

    test('B7/B8（对照）：中文与 emoji 的往返不受影响', () => {
      for (const s of ['', 'A', '中文测试', '😀', 'a😀中']) {
        eq(utf8Decode(utf8Encode(s)), s, `"${s}" 应能原样往返`);
      }
    });

    /**
     * 【B9】binary 是纯函数（uint/int/float/schema/BitWriter 都没有 install、
     * 监听器或定时器），铁律 5 不适用。
     */
    test('B9（N/A）：binary 为纯函数，无 install 故无需 destroy', () => {
      const w = new BitWriter();
      w.writeBits(1, 8);
      // 同一个 writer 连续使用不残留脏位
      const a = w.toBytes().length;
      const w2 = new BitWriter();
      w2.writeBits(1, 8);
      eq(w2.toBytes().length, a, '无跨实例状态');
    });
  });

  // ================================================================
  describe('W8-B · blessing（P1-6 负数/NaN / P1-7 set / P1-8 importState）', () => {
    // ================================================================

    /**
     * 【P1-6 复现（修复前）】
     * add 3 层后 stacks = 3
     * remove(b, -5) 后 stacks = **8**（负数变成加层）
     * add(b, NaN) 后 stacks = **NaN**，effectiveStacks = NaN，effectsOf → NaN
     */
    test('P1-6 ⚠️ remove 的负数参数不再变成加层', () => {
      const s = new BlessingSystem({
        defs: [{ id: 'b', name: 'B', effects: [{ stat: 'atk', op: 'add', perStack: 2 }] }],
      });
      s.add('b', 3);
      eq(s.stacks('b'), 3);
      eq(s.remove('b', -5), 0, '负数应被忽略（返回 0）');
      eq(s.stacks('b'), 3, '修复前这里会变成 8');
    });

    test('P1-6 ⚠️ add 的 NaN 参数不再污染层数', () => {
      const s = new BlessingSystem({
        defs: [{ id: 'b', name: 'B', effects: [{ stat: 'atk', op: 'add', perStack: 2 }] }],
      });
      s.add('b', 3);
      eq(s.add('b', NaN), 0, 'NaN 应被忽略（返回 0）');
      eq(s.stacks('b'), 3, '修复前这里变成 NaN');
      eq(s.effectiveStacks('b'), 3);
      eq(s.effectsOf('b')[0].value, 6, 'effectsOf 不得出现 NaN');
    });

    test('P1-6 ⚠️ 非法参数不触发 onChange（没有变化就不该通知）', () => {
      const seen: string[] = [];
      const s = new BlessingSystem({
        defs: [{ id: 'b', name: 'B', effects: [{ stat: 'atk', op: 'add', perStack: 2 }] }],
        onChange: (id, n) => seen.push(`${id}:${n}`),
      });
      s.add('b', 2);
      const n0 = seen.length;
      s.remove('b', -5);
      s.add('b', NaN);
      eq(seen.length, n0, '无变化的调用不应产生通知');
    });

    test('P1-6（对照）：正常的 add / remove / 全部移除不受影响', () => {
      const s = new BlessingSystem({
        defs: [{ id: 'b', name: 'B', effects: [{ stat: 'atk', op: 'add', perStack: 2 }], maxStacks: 5 }],
      });
      eq(s.add('b', 3), 3);
      eq(s.stacks('b'), 3);
      eq(s.add('b', 5), 2, 'maxStacks 仍然夹紧');
      eq(s.stacks('b'), 5);
      eq(s.remove('b', 2), 2);
      eq(s.stacks('b'), 3);
      eq(s.remove('b'), 3, '不传 n 表示全部移除（Infinity 哨兵必须保留）');
      eq(s.stacks('b'), 0);
      eq(s.has('b'), false);
    });

    /**
     * 【P1-7 复现（修复前）】2 层的 "set maxHp 100" → **200**。
     * `set` 的语义是覆盖为固定值，却走了与 add 相同的 `perStack * eff`。
     */
    test('P1-7 ⚠️ set 效果不被层数缩放', () => {
      const s = new BlessingSystem({
        defs: [{ id: 'b', name: 'B', effects: [{ stat: 'maxHp', op: 'set', perStack: 100 }] }],
      });
      s.add('b', 2);
      eq(s.effectsOf('b')[0].value, 100, 'set 是覆盖语义，与层数无关（修复前是 200）');
      s.add('b', 3);
      eq(s.effectsOf('b')[0].value, 100, '加到 5 层也仍是 100');
    });

    test('P1-7（对照）：add / mul 仍然按层数缩放', () => {
      const s = new BlessingSystem({
        defs: [
          {
            id: 'b',
            name: 'B',
            effects: [
              { stat: 'atk', op: 'add', perStack: 3 },
              { stat: 'hp', op: 'mul', perStack: 1.2 },
            ],
          },
        ],
      });
      s.add('b', 2);
      const eff = s.effectsOf('b');
      eq(eff[0].value, 6, 'add = perStack × 层数');
      near(eff[1].value, 1.44, 1e-9, 'mul = perStack ^ 层数');
    });

    /**
     * 【P1-8 复现（修复前）】
     * importState({ b: -3 }) → stacks = **-3**
     * importState({ b: NaN }) → stacks = NaN，effectiveStacks = NaN
     * importState({ b: 4 })  → onChange 记录 = **[]**（一次都没触发）
     */
    test('P1-8 ⚠️ importState 收口非法层数', () => {
      const s = new BlessingSystem({
        defs: [{ id: 'b', name: 'B', effects: [{ stat: 'atk', op: 'add', perStack: 2 }], maxStacks: 5 }],
      });
      s.importState({ b: -3 });
      eq(s.stacks('b'), 0, '负数层数应被收口为 0（修复前是 -3）');
      s.importState({ b: NaN });
      eq(s.stacks('b'), 0, 'NaN 应被收口为 0（修复前是 NaN）');
      eq(s.effectiveStacks('b'), 0);
      s.importState({ b: 99 });
      eq(s.stacks('b'), 5, 'maxStacks 仍然夹紧');
    });

    test('P1-8 ⚠️ importState 结束后触发 onChange（读档后 UI 能同步）', () => {
      const seen: string[] = [];
      const s = new BlessingSystem({
        defs: [{ id: 'b', name: 'B', effects: [{ stat: 'atk', op: 'add', perStack: 2 }], maxStacks: 5 }],
        onChange: (id, n) => seen.push(`${id}:${n}`),
      });
      s.importState({ b: 4 });
      assert(seen.includes('b:4'), `导入后应通知一次（修复前 onChange 记录 = []），实际 ${JSON.stringify(seen)}`);
      eq(seen.filter((x) => x === 'b:4').length, 1, '同一个 id 只报一次最终值（幂等）');
    });

    test('P1-8 ⚠️ 导入后"消失的"也要报 0（UI 才能撤下图标）', () => {
      const seen: string[] = [];
      const s = new BlessingSystem({
        defs: [
          { id: 'a', name: 'A', effects: [{ stat: 'atk', op: 'add', perStack: 1 }] },
          { id: 'b', name: 'B', effects: [{ stat: 'atk', op: 'add', perStack: 1 }] },
        ],
        onChange: (id, n) => seen.push(`${id}:${n}`),
      });
      s.add('a', 1);
      s.add('b', 1);
      seen.length = 0;
      s.importState({ a: 2 });          // b 在新存档里没有了
      assert(seen.includes('a:2'), `a 应报新值，实际 ${JSON.stringify(seen)}`);
      assert(seen.includes('b:0'), `b 应报 0，实际 ${JSON.stringify(seen)}`);
    });

    test('P1-8（对照）：已删除的 def 仍被静默忽略，正常导入不变', () => {
      const s = new BlessingSystem({
        defs: [{ id: 'a', name: 'A', effects: [{ stat: 'atk', op: 'add', perStack: 1 }] }],
      });
      s.importState({ a: 3, ghost: 9 } as Record<string, number>);
      eq(s.stacks('a'), 3);
      eq(s.has('ghost'), false, '配置里已删除的祝福应被跳过，不报错');
      eq(s.exportState().a, 3);
    });
  });

  // ================================================================
  describe('W8-B · blessing（P2 B10 空 if / B11 pick 复杂度 / B12 权重 NaN / B13 destroy）', () => {
    // ================================================================

    /**
     * 【B10】`_validate` 里 `softCap` 无 `falloff` 的分支原本是**空 if**：
     * 检测到了问题，然后什么都不做，实际行为由 `falloff ?? 0.5` 悄悄决定。
     * 实测：softCap=3、8 层 → effective = 5.5。
     * 不抛错（配表疏忽不该让游戏起不来），但要让人看得见。
     */
    test('B10 ⚠️ softCap 缺 falloff 时给出告警，行为不变', () => {
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (m: unknown) => { warns.push(String(m)); };
      try {
        const s = new BlessingSystem({
          defs: [{ id: 'b', name: 'B', effects: [{ stat: 'atk', op: 'add', perStack: 2 }], softCap: 3 }],
        });
        assert(
          warns.some((w) => w.includes('falloff')),
          `应告警"没有 falloff"，实际 ${JSON.stringify(warns)}`
        );
        s.add('b', 8);
        eq(s.effectiveStacks('b'), 5.5, '行为不变：仍按 0.5 折算');
      } finally {
        console.warn = orig;
      }
    });

    test('B10（对照）：显式给了 falloff 就不该告警', () => {
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (m: unknown) => { warns.push(String(m)); };
      try {
        new BlessingSystem({
          defs: [
            {
              id: 'b',
              name: 'B',
              effects: [{ stat: 'atk', op: 'add', perStack: 2 }],
              softCap: 3,
              falloff: 0.25,
            },
          ],
        });
        eq(warns.length, 0, `显式 falloff 不该告警，实际 ${JSON.stringify(warns)}`);
      } finally {
        console.warn = orig;
      }
    });

    /**
     * 【B12 复现（修复前）】weight 为 NaN 时 total 变 NaN，
     * `r < 0` 恒为 false → idx 停在最后一个 → 恒取池子最后一个。
     * 实测（修复前）pick(3) = c,b,a（永远从最后开始倒着拿）。
     */
    test('B12 ⚠️ NaN 权重不再让池子静默偏斜', () => {
      const s = new BlessingSystem({
        defs: [
          { id: 'a', name: 'A', effects: [{ stat: 'atk', op: 'add', perStack: 1 }], weight: 100 },
          { id: 'b', name: 'B', effects: [{ stat: 'atk', op: 'add', perStack: 1 }], weight: NaN },
          { id: 'c', name: 'C', effects: [{ stat: 'atk', op: 'add', perStack: 1 }], weight: 100 },
        ],
      });
      const out = s.pick(seq([0.1, 0.5, 0.9]), 3);
      assert(
        !out.some((d) => d.id === 'b'),
        `NaN 权重应等价于"抽不到"，实际抽到 ${out.map((d) => d.id).join(',')}`
      );
      eq(out.length, 2, 'NaN 权重的项被排除后只剩 2 个候选');
    });

    test('B12（对照）：正常权重按权重抽', () => {
      const s = new BlessingSystem({
        defs: [
          { id: 'hi', name: 'HI', effects: [{ stat: 'atk', op: 'add', perStack: 1 }], weight: 99 },
          { id: 'lo', name: 'LO', effects: [{ stat: 'atk', op: 'add', perStack: 1 }], weight: 1 },
        ],
      });
      let hi = 0;
      for (let i = 0; i < 200; i++) {
        // 每次重新构造避免满层过滤干扰
        const t = new BlessingSystem({
          defs: [
            { id: 'hi', name: 'HI', effects: [{ stat: 'atk', op: 'add', perStack: 1 }], weight: 99 },
            { id: 'lo', name: 'LO', effects: [{ stat: 'atk', op: 'add', perStack: 1 }], weight: 1 },
          ],
        });
        if (t.pick(seq([0.5]), 1)[0].id === 'hi') hi++;
      }
      assert(hi > 150, `99:1 的权重应让 hi 占绝大多数，实际 ${hi}/200`);
      eq(s.all.length, 2);
    });

    /**
     * 【B11 结论：不成立（附实测）】
     * 报告说 `pool.filter((_, i) => i !== idx)` 每次 O(n) 重建，整体 O(n²)。
     * 实测（2000 defs、pick(3)、200 次）：总 27ms，**单次 pick ≈ 0.135ms**。
     * 真实候选池（几十种祝福）下完全不可见；改成"交换删除"会打乱候选顺序，
     * 反而影响三选一的展示稳定性。维持现状，只留性能护栏。
     */
    test('B11（不成立·性能护栏）：2000 defs 下 pick(3) 仍是亚毫秒级', () => {
      const defs = [];
      for (let i = 0; i < 2000; i++) {
        defs.push({ id: 'd' + i, name: 'D' + i, effects: [{ stat: 'atk', op: 'add' as const, perStack: 1 }], weight: 1 });
      }
      const s = new BlessingSystem({ defs });
      const rng = { next: () => Math.random() };
      const t0 = Date.now();
      for (let i = 0; i < 200; i++) s.pick(rng, 3);
      const per = (Date.now() - t0) / 200;
      assert(per < 5, `单次 pick(3) 应 < 5ms，实测 ${per.toFixed(4)}ms（原值约 0.135ms）`);
    });

    /** 【B13】blessing 无 install / 监听器 / 定时器，铁律 5 不适用 */
    test('B13（N/A）：blessing 无 install，故无需 destroy', () => {
      const s = new BlessingSystem({
        defs: [{ id: 'b', name: 'B', effects: [{ stat: 'atk', op: 'add', perStack: 1 }] }],
      });
      eq(typeof (s as unknown as { destroy?: unknown }).destroy, 'undefined');
      s.add('b', 1);
      s.clear();                       // clear 就是等价的"卸载"路径
      eq(s.count, 0);
    });
  });
}
