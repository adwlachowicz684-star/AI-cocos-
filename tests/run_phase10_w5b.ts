/**
 * tests/run_phase10_w5b.ts —— 第二次精审 P1/P2 回归 · 窗口 W5-B
 *
 * 【本窗口的七个单元】accessibility / analytics / feedback / input / mmr / rarity / scenerouter
 *
 * 【每条修复三条用例的约定】
 * 1. 复现用例：修复前**确实会失败**（每条注释里都写了修复前的实测输出）
 * 2. 对照用例：正常输入不受影响（防止矫枉过正）
 * 3. 需要总审裁决的，写在 `audit/result_W5-B.md` 里，不在这里拍板
 *
 * 【为什么每个 test 里都重复 new 一个对象】
 * 这七个单元全都持有状态（开关、样本聚合、在途反馈实例、路由阶段），
 * 跨用例复用会让"失败原因"变成"上一个用例污染了这个对象"——
 * 排查成本远高于多 new 一次。
 *
 * 【关于"已修（附说明）"的两条】
 * feedback 的 `popup` 与 mmr 的 `resolve()` 只改文档/不改行为，
 * 这里的用例是**记录当前真实行为**而不是断言"它变了"，
 * 免得将来有人按错误文档改回实现时没有任何东西拦住他。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { Accessibility } from '../accessibility/Accessibility';
import {
  Experiment,
  assign,
  emptyStats,
  mean,
  recordBinary,
  recordValue,
  requiredSampleSize,
  twoProportionZTest,
  variance,
} from '../analytics/ABTest';
import { HitFeedback } from '../feedback/HitFeedback';
import { InputBuffer } from '../input/InputBuffer';
import {
  fillFromPool,
  suggestedWindow,
  teamMmr,
  validateParty,
} from '../mmr/TeamMMR';
import { Rarity } from '../rarity/Rarity';
import { SceneRouter } from '../scenerouter/SceneRouter';

/** 攒一批数值样本 */
function statsOf(xs: readonly number[]) {
  let s = emptyStats();
  for (const x of xs) s = recordValue(s, x);
  return s;
}

export function runPhase10W5BTests(): void {
  // ================================================================
  // P1-1 · accessibility：构造不收口，NaN 让全 UI 字号变 NaN
  // ================================================================
  describe('accessibility · 构造与 setter 同口径（P1-1）', () => {
    test('⚠️ fontScale = NaN 必须被拒（修复前：NaN 穿透，fontSize(16) = NaN）', () => {
      /**
       * 【修复前的实测】
       * ```
       * new Accessibility({fontScale: NaN}) 未抛错！fontScale = NaN
       * fontSize(16) = NaN
       * ```
       * 根因：`if (this._fontScale <= 0) throw` 中 `NaN <= 0` 恒为 false。
       * 后果不是"报错没报对"——是字号变 NaN 后文本渲染异常或整块消失，
       * 且不抛任何错，NaN 进了布局要回溯很久才能定位到配置项。
       */
      throws(() => new Accessibility({ fontScale: NaN }), '必须为正');
    });

    test('⚠️ shakeScale 构造也要夹到 [0,1]（修复前：构造传 5 得到 5，setter 却给 1）', () => {
      /**
       * 【修复前的实测】
       * ```
       * new Accessibility({shakeScale: 5}) 构造成功, shakeScale = 5
       * setShakeScale(5) 后 shakeScale = 1        ← 被 clamp
       * ```
       * 同一个值，走构造生效、走 setter 被压到 1——行为随调用路径变化。
       */
      eq(new Accessibility({ shakeScale: 5 }).shakeScale, 1, '构造与 setter 必须同口径');
      eq(new Accessibility({ shakeScale: -3 }).shakeScale, 0);
      eq(new Accessibility({ shakeScale: 0.4 }).shakeScale, 0.4, '合法值不受影响');
    });

    test('⚠️ longPressMs = NaN 回落默认 600（修复前：直接存 NaN）', () => {
      // 修复前：`opts.longPressMs ?? 600` 只挡 undefined，NaN 原样存下，
      // 之后所有长按判定 `elapsed >= NaN` 恒为 false → 长按永远不触发。
      eq(new Accessibility({ longPressMs: NaN }).longPressMs, 600);
      eq(new Accessibility({ longPressMs: 99999 }).longPressMs, 3000, '上界与 setter 一致');
      eq(new Accessibility({ longPressMs: 900 }).longPressMs, 900, '合法值不受影响');
    });

    test('对照：既有契约不动（fontScale=0 仍然抛错、正常值仍生效）', () => {
      /**
       * 【为什么保留抛错而不是改成 clamp】
       * 既有测试断言了 `new Accessibility({fontScale: 0})` 抛"必须为正"。
       * 这条契约是"传错就炸"的开发期保护，不能为了收口而把它变成静默夹取。
       * 所以这里只把判定改成肯定式 `!(v > 0)`，让 NaN 与 0 走同一条路。
       */
      throws(() => new Accessibility({ fontScale: 0 }), '必须为正');
      eq(new Accessibility({ fontScale: 1.5 }).fontSize(16), 24);
      eq(new Accessibility().fontScale, 1, '不传时仍是 1');
      eq(new Accessibility().shakeScale, 1);
      eq(new Accessibility().longPressMs, 600);
    });
  });

  // ================================================================
  // P1-2 · analytics：方差被灾难性消去抹平
  // ================================================================
  describe('analytics · variance 的两遍算法（P1-2）', () => {
    test('⚠️ 大基数小波动不得被抹平成 0（修复前：[1e9+7,+9,+11] → 0，精确值 4）', () => {
      /**
       * 【修复前的实测】
       * ```
       * variance([1e9+7, 1e9+9, 1e9+11]) = 0        （精确值 4）
       * variance([1e8+1..1e8+5])         = 2        （精确值 2.5）
       * ```
       * 根因：`Σx² − n·m²` 是两个几乎相等的大数相减，有效位全部抵消。
       * 更糟的是末尾 `Math.max(0, v)` 把消去产生的负数压成 0，
       * 于是"精度崩了"被伪装成"方差就是 0"——置信区间为 0、t 检验失效，
       * ARPU 这类实验的显著性结论完全不可信。
       */
      near(variance(statsOf([1e9 + 7, 1e9 + 9, 1e9 + 11])), 4, 1e-9);
    });

    test('⚠️ 中等量级也要保住有效位（修复前：[1e8+1..+5] → 2，精确值 2.5）', () => {
      near(variance(statsOf([1e8 + 1, 1e8 + 2, 1e8 + 3, 1e8 + 4, 1e8 + 5])), 2.5, 1e-9);
    });

    test('mean 在大基数下同样要准（修复前先算 Σx，量级被吃掉）', () => {
      near(mean(statsOf([1e9 + 7, 1e9 + 9, 1e9 + 11])), 1e9 + 9, 1e-9);
    });

    test('对照：小数值样本与 n−1 无偏估计不变', () => {
      const s = statsOf([10, 20, 30]);
      eq(mean(s), 20);
      eq(variance(s), 100, '仍应除以 n-1');
      eq(variance(emptyStats()), 0, '样本不足仍返回 0');
      eq(variance(recordValue(emptyStats(), 5)), 0);
    });

    test('对照：二值样本（0/1）的方差不受移位影响', () => {
      let s = emptyStats();
      for (let i = 0; i < 100; i++) s = recordBinary(s, i % 2 === 0);
      near(mean(s), 0.5, 1e-9);
      near(variance(s), 100 * 0.25 / 99, 1e-9);
    });
  });

  // ================================================================
  // P1-3 · feedback：update 的 dt 守卫挡不住 Infinity
  // ================================================================
  describe('feedback · update 的 dt 守卫（P1-3）', () => {
    test('⚠️ update(Infinity) 不得清空所有反馈（修复前：activeCount 1 → 0）', () => {
      /**
       * 【修复前的实测】
       * ```
       * 触发后 activeCount = 1
       * update(Infinity) 后 activeCount = 0   ← 打击反馈瞬间全部消失
       * ```
       * 根因：`!(Infinity > 0)` 为 false，Infinity 穿透守卫，
       * 把每个实例的 elapsed 推到 Infinity → 全部判定到期 → 一次性清空。
       * 切后台再回来、断点续跑、时间戳异常都会产出这种 dt。
       */
      const fb = new HitFeedback();
      fb.play('heavy', 0.8);
      eq(fb.activeCount, 1);
      fb.update(Infinity);
      eq(fb.activeCount, 1, 'Infinity 的 dt 应当被安全忽略');
    });

    test('⚠️ update(NaN) / update(负数) 同样不得推进', () => {
      const fb = new HitFeedback();
      fb.play('heavy', 0.8);
      const before = fb.activeCount;
      fb.update(NaN);
      eq(fb.activeCount, before);
      fb.update(-1);
      eq(fb.activeCount, before);
    });

    test('对照：正常 dt 照常推进，且震屏强度仍算得出来', () => {
      const fb = new HitFeedback();
      fb.play('heavy', 1.0);
      fb.update(1 / 60);
      assert(fb.output.shake > 0, '正常帧应当有震屏输出');
      assert(Number.isFinite(fb.output.shake), '强度必须是有限数');
      for (let i = 0; i < 200; i++) fb.update(1 / 60);
      eq(fb.activeCount, 0, '跑够时长后自然结束');
    });
  });

  // ================================================================
  // P1-4 · mmr：baseRating 的 switch 没有 default
  // ================================================================
  describe('mmr · 未知 strategy 必须失败得出来（P1-4）', () => {
    test('⚠️ 脏字符串不得静默返回 undefined（修复前：base = undefined → effective = NaN）', () => {
      /**
       * 【修复前的实测】
       * ```
       * strategy='average' → base = undefined  effective = NaN
       * ```
       * TS 的穷尽性检查只覆盖类型内取值，挡不住运行时的脏字符串
       * （配置里写成 average / Weighted / 'avg ' 太常见了）。
       * 没有 default 时函数隐式返回 undefined，一次错都不抛，
       * 表现为"排不到人"或"分局实力悬殊"。
       */
      throws(
        () => teamMmr([{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }], {
          strategy: 'average' as never,
        }),
        '未知的队伍分策略'
      );
    });

    test('对照：四种合法策略都返回有限数', () => {
      const team = [{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }];
      for (const s of ['avg', 'weighted', 'max', 'topHalf'] as const) {
        const r = teamMmr(team, { strategy: s });
        assert(Number.isFinite(r.base), `${s} 的 base 必须有限`);
        assert(Number.isFinite(r.effective), `${s} 的 effective 必须有限`);
      }
    });
  });

  // ================================================================
  // P1-5 · mmr：rating 未做有限性校验
  // ================================================================
  describe('mmr · rating 的有限性校验（P1-5）', () => {
    test('⚠️ NaN 分数必须带着玩家 id 报错（修复前：整队 effective = NaN，不抛错）', () => {
      /**
       * 【修复前的实测】
       * ```
       * 一人为 NaN → base = NaN  effective = NaN  spread = NaN
       * weightBase=NaN → base = NaN  effective = NaN
       * ```
       */
      throws(
        () => teamMmr([{ id: 'a', rating: 1500 }, { id: 'b', rating: NaN }]),
        'rating 不是有限数'
      );
    });

    test('⚠️ validateParty 不得放行含 NaN 分数的队伍（修复前：spread > maxSpread 对 NaN 恒 false）', () => {
      /**
       * `NaN > maxSpread` 恒为 false → 本该被分差限制拦下的队伍被放行，
       * 炸鱼/代练的限制在这种情况下完全失效。
       */
      const r = validateParty(
        [{ id: 'a', rating: 1500 }, { id: 'b', rating: NaN }],
        { maxSpread: 100 }
      );
      eq(r.ok, false, '含 NaN 分数的队伍必须被拒');
      assert(!r.ok && r.reason === 'rating', 'reason 应指出是分数值的问题');
    });

    test('⚠️ weightBase = NaN 回落到默认 0.7（修复前：所有权重 NaN）', () => {
      const team = [{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }];
      const bad = teamMmr(team, { strategy: 'weighted', weightBase: NaN });
      const good = teamMmr(team, { strategy: 'weighted' });
      near(bad.base, good.base, 1e-9);
      assert(Number.isFinite(bad.effective));
    });

    test('对照：负的 weightBase 仍是合法输入（den 为 0 的降级分支不能被动掉）', () => {
      /**
       * 这是既有的一条专门设计过的行为：weightBase = -1 时分母 1 + (-1) = 0，
       * 由 `den === 0` 分支退化成等权平均。
       * 收口只能兜非有限值，**不能**把负数夹掉，否则这条分支永远走不到。
       */
      const team = [{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }];
      const r = teamMmr(team, { strategy: 'weighted', weightBase: -1 });
      near(r.base, 1550, 1e-9, '退化成等权平均');
      assert(Number.isFinite(r.effective), '绝不能是 Infinity');
    });
  });

  // ================================================================
  // P1-6 · rarity：order 只查重复不查有限性
  // ================================================================
  describe('rarity · order 的有限性校验（P1-6）', () => {
    test('⚠️ order = NaN 必须在构造期被拒（修复前：highest.id 返回 a，应为 c）', () => {
      /**
       * 【修复前的实测】
       * ```
       * 三条定义 order 分别为 1 / NaN / 3
       * highest.id = a（期望 c）
       * all 顺序 = a,b,c（未排序）
       * ```
       * 比较器返回 NaN 时排序结果由引擎实现决定（实测保持原序），
       * 于是 highest / lowest / compare / best 全错，且不报错。
       */
      throws(
        () =>
          new Rarity([
            { id: 'a', name: 'a', weight: 10, order: 1 },
            { id: 'b', name: 'b', weight: 10, order: NaN },
            { id: 'c', name: 'c', weight: 10, order: 3 },
          ]),
        'order 必须是有限数'
      );
    });

    test('⚠️ weight 与 order 用同一道标准（weight 早已是肯定式判定）', () => {
      throws(
        () => new Rarity([{ id: 'x', name: 'x', weight: NaN, order: 1 }]),
        'weight 必须为正'
      );
    });

    test('对照：合法 order 的排序与查询完全不变', () => {
      const r = new Rarity([
        { id: 'a', name: 'a', weight: 10, order: 1 },
        { id: 'c', name: 'c', weight: 10, order: 3 },
        { id: 'b', name: 'b', weight: 10, order: 2 },
      ]);
      eq(r.highest.id, 'c');
      eq(r.lowest.id, 'a');
      eq(r.all.map((d) => d.id).join(','), 'c,b,a');
      eq(r.isRarer('c', 'a'), true);
      eq(r.best(['a', 'c'])!.id, 'c');
    });
  });

  // ================================================================
  // P1-7 · scenerouter：tick 单位是毫秒，与全库秒制 dt 同名不同义
  // ================================================================
  describe('scenerouter · tick 的毫秒单位（P1-7）', () => {
    test('⚠️ 毫秒口径下 0.6 秒内必须走完（按秒传要 600 秒）', () => {
      /**
       * 【修复前的实测】
       * ```
       * outMs = inMs = 300
       * 按秒传   dt = 1/60   → 36000 帧 ≈ 600 秒    ← 表现为"黑屏卡住十分钟"
       * 按毫秒传 dt = 16.67  → 36 帧    ≈ 0.6 秒
       * ```
       * 本单元内部自洽（配置 ms、tick 收 ms），问题是参数**名叫 dt**，
       * 而全库其余 23 个单元的 dt 都是秒。
       *
       * 改单位会动到所有宿主（breaking），所以只把参数改名为 `dtMs`
       * —— 让 IDE 与类型提示在调用那一刻就把单位亮出来。
       */
      const rt = new SceneRouter({ outMs: 300, inMs: 300 });
      rt.goTo('battle');
      let frames = 0;
      while (rt.phase !== 'idle' && frames < 100000) {
        if (rt.phase === 'load') rt.notifyLoaded();
        rt.tick(16.67);
        frames++;
      }
      assert(frames <= 40, `毫秒口径应在 40 帧内完成，实际 ${frames} 帧`);
      eq(rt.current, 'battle');
    });

    test('⚠️ 函数签名里必须写着 dtMs（单位提示随调用走）', () => {
      /**
       * 参数名是"同名不同义"唯一的自动防线：
       * JSDoc 要靠人去翻，参数名在每次调用时都会出现在提示里。
       * 这条用例防止以后有人把它改回 `dt`。
       */
      assert(
        SceneRouter.prototype.tick.toString().startsWith('tick(dtMs'),
        'tick 的参数名必须是 dtMs，以便调用处立刻看到单位'
      );
    });

    test('对照：Infinity / NaN 的 dt 仍被安全忽略，转场不会卡死', () => {
      const rt = new SceneRouter({ outMs: 300, inMs: 300 });
      rt.goTo('battle');
      rt.tick(Infinity);
      rt.tick(NaN);
      eq(rt.phase, 'out', '非法 dt 不得把阶段推走');
      rt.tick(16.67);
      eq(rt.phase, 'out');
    });
  });

  // ================================================================
  // P2-1 · accessibility：shouldPlay 合并 / destroy
  // ================================================================
  describe('accessibility · shouldPlay 与卸载（P2-1）', () => {
    test('⚠️ 减少动效时只保留装饰性表现（两支 false 合并成一条规则）', () => {
      const a = Accessibility.motionSensitive();
      /**
       * 修复前 switch 里 `shake/sway/flash` 与 `transition/autoCamera`
       * 是两个独立 case 组却返回同一个值，读起来像"策略将来会分开"，
       * 于是改动时只敢动其中一组。合并后新增 EffectKind 默认"关掉"，
       * 而不是放行一个没被评估过的动效。
       */
      eq(a.shouldPlay('shake'), false);
      eq(a.shouldPlay('sway'), false);
      eq(a.shouldPlay('flash'), false);
      eq(a.shouldPlay('transition'), false);
      eq(a.shouldPlay('autoCamera'), false);
      eq(a.shouldPlay('particle'), true);
      eq(a.shouldPlay('loopAnim'), true);
    });

    test('⚠️ destroy() 之后 onChange 不再被触发（防止 UI 节点被闭包挂住）', () => {
      let calls = 0;
      const a = new Accessibility({ onChange: () => { calls++; } });
      a.setReduceMotion(true);
      eq(calls, 1, '销毁前回调正常');
      a.destroy();
      a.setFontScale(1.2);
      eq(calls, 1, '销毁后不得再有回调');
    });

    test('对照：未销毁时 onChange 逐次触发，状态照常更新', () => {
      const seen: string[] = [];
      const a = new Accessibility({ onChange: (k, v) => seen.push(`${k}=${v}`) });
      a.setReduceMotion(true);
      a.setFontScale(1.2);
      eq(seen.join(','), 'reduceMotion=true,fontScale=1.2');
      eq(a.shouldPlay('shake'), false);
      eq(a.fontScale, 1.2);
    });
  });

  // ================================================================
  // P2-2 · analytics：assign / ztest / recordValue / destroy
  // ================================================================
  describe('analytics · 公开函数的收口与卸载（P2-2）', () => {
    test('⚠️ assign 的 treatmentPercent = NaN 不得全员落 control（修复前：0/200）', () => {
      /**
       * 【修复前的实测】
       * ```
       * treatmentPercent = NaN → treatment 人数 = 0 / 200
       * ```
       * `assign` 是公开导出函数，调用方可以不经过 `Experiment` 直接调它，
       * 所以构造函数里的校验管不到这里。`bucket < NaN` 恒 false → 全员 control。
       */
      const cfg = { name: 'x', treatmentPercent: NaN };
      let treat = 0;
      for (let i = 0; i < 200; i++) if (assign('u' + i, cfg) === 'treatment') treat++;
      assert(treat > 40 && treat < 160, `NaN 应回落到 50%，实际 ${treat}/200`);
    });

    test('⚠️ twoProportionZTest 的 p 不得是 NaN（修复前：p = NaN → 永远不显著）', () => {
      /**
       * `clamp` 内部是三目比较，对 NaN 三条分支全不成立 → 原样返回 NaN。
       * `NaN < alpha` 恒 false，于是"永远不显著"——
       * 一个真的有效的改动会被判成无效而砍掉。
       * fallback 取 1（最不显著）：算不出 p 值时，默认姿态是"没有证据"。
       */
      const bad = { n: 10, conversions: NaN, sum: NaN, sumSq: NaN };
      const good = { n: 10, conversions: 5, sum: 5, sumSq: 5 };
      const r = twoProportionZTest(bad, good);
      assert(Number.isFinite(r.p), 'p 必须是有限数');
      eq(r.p, 1, '算不出时应取最保守的 1');
    });

    test('⚠️ recordValue(NaN) 丢弃该样本，不污染 sum（修复前：sum 变 NaN）', () => {
      const s = recordValue(emptyStats(), NaN);
      eq(s.n, 0, '非法样本不计入 n');
      eq(s.sum, 0);
      let s2 = emptyStats();
      s2 = recordValue(s2, 10);
      s2 = recordValue(s2, NaN);
      s2 = recordValue(s2, 20);
      eq(s2.n, 2, 'NaN 被丢弃，其余照常');
      eq(mean(s2), 15);
    });

    test('⚠️ requiredSampleSize 的 baseline = NaN 必须被拒（修复前：返回 NaN）', () => {
      // `baseline <= 0 || baseline >= 1` 对 NaN 两支都是 false → 一路算到 Math.ceil(NaN)
      throws(() => requiredSampleSize(NaN, 0.1), '基线转化率必须在');
    });

    test('⚠️ Experiment 有 destroy()，且能清掉全部样本', () => {
      const e = new Experiment({ name: 'e' });
      e.trackBinary('u1', true);
      eq(e.size, 1);
      e.destroy();
      eq(e.size, 0);
    });

    test('对照：正常的分组分布与显著性判定不受影响', () => {
      const cfg = { name: 'x', treatmentPercent: 50 };
      let treat = 0;
      for (let i = 0; i < 2000; i++) if (assign('u' + i, cfg) === 'treatment') treat++;
      assert(treat > 850 && treat < 1150, `50% 应大致均衡，实际 ${treat}/2000`);

      let c = emptyStats();
      let t = emptyStats();
      for (let i = 0; i < 500; i++) {
        c = recordBinary(c, i % 2 === 0);
        t = recordBinary(t, i % 2 === 0);
      }
      near(twoProportionZTest(c, t).p, 1, 1e-6);
    });
  });

  // ================================================================
  // P2-3 · feedback：popup 语义 / maxIntensity / destroy
  // ================================================================
  describe('feedback · 强度收口与卸载（P2-3）', () => {
    test('⚠️ maxIntensity = NaN 不得让表现层静默失效（修复前：shake = NaN）', () => {
      /**
       * 【修复前的实测】
       * ```
       * maxIntensity = NaN → shake = NaN  flash = NaN
       * 对照组（1.5）      → shake = 0.40 flash = 0.60
       * ```
       * `Math.min(intensity, NaN) === NaN` → `clamp01(NaN)` 还是 NaN，
       * 宿主拿 NaN 去做位移会算出 NaN 坐标：整个表现层不报错地失效。
       */
      const fb = new HitFeedback({ maxIntensity: NaN });
      fb.play('heavy', 1.0);
      fb.update(1 / 60);
      assert(Number.isFinite(fb.output.shake), 'shake 必须是有限数');
      assert(Number.isFinite(fb.output.flash), 'flash 必须是有限数');
      near(fb.output.shake, 0.4, 1e-9, '应回落到默认上限的行为');
    });

    test('⚠️ popup 是强度不是进度（记录真实行为，防止有人按错误文档改回实现）', () => {
      /**
       * JSDoc 原写"进度 0~1（1 = 刚触发，0 = 结束）"，实测 40 帧恒为 0.50。
       * 改成真进度是 breaking（已按强度接的宿主会突然看到淡出），
       * 所以这里按"改文档说清真实语义"处理（模式 F）。
       * 这条用例把真实行为钉住，避免实现将来再被"照文档"改回去。
       */
      const fb = new HitFeedback();
      fb.play('heavy', 0.5);
      const samples: number[] = [];
      for (let i = 0; i < 40; i++) {
        fb.update(1 / 60);
        samples.push(fb.output.popup);
      }
      const uniq = [...new Set(samples.map((v) => v.toFixed(2)))];
      eq(uniq.length, 1, '整个 duration 内 popup 恒定（= intensity × scale）');
      near(samples[0]!, 0.5, 1e-9);
    });

    test('⚠️ destroy() 清空在途反馈并断开 payload 引用', () => {
      const fb = new HitFeedback();
      fb.play('heavy', 0.8, { damage: 120 });
      eq(fb.activeCount, 1);
      fb.destroy();
      eq(fb.activeCount, 0);
      eq(fb.output.shake, 0);
      eq(fb.takePopupPayloads().length, 0);
    });

    test('对照：正常 maxIntensity 与 clear() 行为不变', () => {
      const fb = new HitFeedback({ maxIntensity: 1.5 });
      fb.play('heavy', 1.0);
      fb.update(1 / 60);
      near(fb.output.shake, 0.4, 1e-9);
      near(fb.output.flash, 0.6, 1e-9);
      fb.clear();
      eq(fb.activeCount, 0, 'clear 仍是"游戏内"的清空语义');
    });
  });

  // ================================================================
  // P2-4 · input：maxQueue / window 收口
  // ================================================================
  describe('input · 缓冲参数的收口（P2-4）', () => {
    test('⚠️ maxQueue = NaN 时队列仍要裁剪（修复前：连按 50 次后长度 50）', () => {
      /**
       * `this._queue.length > NaN` 恒为 false → 队列永不裁剪。
       * 搓招序列越来越长、比对越来越慢，内存只增不减。
       */
      const ib = new InputBuffer({ maxQueue: NaN });
      for (let i = 0; i < 50; i++) ib.press('a' + i);
      assert(ib.queue.length <= 6, `应回落到默认上限 6，实际 ${ib.queue.length}`);
    });

    test('⚠️ window = NaN 回落到默认 0.15（修复前：peek 恒 false、consume 时灵时不灵）', () => {
      eq(new InputBuffer({ window: NaN }).window, 0.15);
    });

    test('⚠️ setter 传 NaN 不得再存 NaN（修复前：Math.max(0, NaN) === NaN）', () => {
      const ib = new InputBuffer();
      ib.window = NaN;
      assert(Number.isFinite(ib.window), 'window 必须是有限数');
      eq(ib.window, 0);
      ib.window = -5;
      eq(ib.window, 0, '负数仍被夹到 0');
    });

    test('对照：正常参数下的缓冲与消费完全不变', () => {
      const ib = new InputBuffer({ window: 0.15, maxQueue: 6, now: () => 0 });
      ib.press('attack');
      eq(ib.peek('attack'), true);
      eq(ib.consume('attack'), true);
      eq(ib.consume('attack'), false, '同一输入不得消费两次');
      eq(new InputBuffer().window, 0.15, '默认窗口仍是 0.15');
    });
  });

  // ================================================================
  // P2-5 · mmr：suggestedWindow / fillFromPool
  // ================================================================
  describe('mmr · 窗口与补人（P2-5）', () => {
    test('⚠️ 负 baseWindow 时 min/max 不得颠倒（修复前：返回 -100）', () => {
      /**
       * `clamp(v, baseWindow, baseWindow * 3)` 假设 min <= max。
       * baseWindow = -100 时 min = -100、max = -300，判定互相颠倒，
       * 结果被钉在上界——值看着合理，语义是错的。
       * 修复后落在 [-300, -100] 这个真实区间内。
       */
      const team = [{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }];
      const w = suggestedWindow(team, -100);
      assert(w >= -300 && w <= -100, `应落在 [-300,-100]，实际 ${w}`);
    });

    test('⚠️ baseWindow = NaN 不得返回 NaN', () => {
      const team = [{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }];
      assert(Number.isFinite(suggestedWindow(team, NaN)));
    });

    test('对照：正 baseWindow 的放宽区间与上限不变', () => {
      const team = [{ id: 'a', rating: 1500 }, { id: 'b', rating: 1600 }];
      const w = suggestedWindow(team, 100);
      assert(w >= 100 && w <= 300, `应落在 [100,300]，实际 ${w}`);
      // spread = 100 → uncertainty = 1.2
      near(w, 120, 1e-9);
    });

    test('⚠️ fillFromPool 先排序后校验，仍选出"最接近的合法候选"', () => {
      /**
       * 修复前对每个候选都跑一次 validateParty + teamMmr（O(pool × party)），
       * 而需要的只是"离 target 最近的合法候选"。
       * 排序后第一个通过校验的候选与原算法选中的是同一个——判据完全相同。
       */
      const party = [{ id: 'p1', rating: 1500 }, { id: 'p2', rating: 1500 }];
      const pool = [
        { id: 'far', rating: 3000 },
        { id: 'near', rating: 1510 },
        { id: 'mid', rating: 1600 },
      ];
      const r = fillFromPool(party, pool, { maxSpread: 200 });
      assert(r !== null, '应当能补到人');
      eq(r!.pick.id, 'near');
    });

    test('对照：分差限制仍会过滤掉不合适的候选', () => {
      const party = [{ id: 'p1', rating: 1500 }];
      const pool = [{ id: 'tooFar', rating: 5000 }];
      eq(fillFromPool(party, pool, { maxSpread: 100 }), null);
    });
  });

  // ================================================================
  // P2-6 · rarity：tally 的原型污染
  // ================================================================
  describe('rarity · tally 的键（P2-6）', () => {
    test('⚠️ id 为 __proto__ 时计数不得整条丢失（修复前：返回 {"b":1}）', () => {
      /**
       * 【修复前的实测】
       * ```
       * tally(['__proto__','__proto__','b']) → {"b":1}
       * ```
       * `out['__proto__'] = 0` 走的是原型上的 setter，赋值被静默忽略；
       * 之后 `+= 1` 读到的也是原型值 → NaN → 再赋值又被忽略。
       * 而 `get('__proto__')` 还能取到定义，属于"部分可用、计数丢失"的半失效。
       */
      const r = new Rarity([
        { id: '__proto__', name: 'p', weight: 1, order: 1 },
        { id: 'b', name: 'b', weight: 1, order: 2 },
      ]);
      const t = r.tally(['__proto__', '__proto__', 'b']);
      eq(Object.prototype.hasOwnProperty.call(t, '__proto__'), true, '必须是自有属性');
      eq(t['__proto__'], 2);
      eq(t['b'], 1);
    });

    test('⚠️ 保留普通对象的方法（不能为了修计数而返回无原型对象）', () => {
      const r = new Rarity([
        { id: '__proto__', name: 'p', weight: 1, order: 1 },
        { id: 'b', name: 'b', weight: 1, order: 2 },
      ]);
      const t = r.tally(['b']);
      eq(typeof t.hasOwnProperty, 'function', '宿主可能会调 hasOwnProperty');
      eq(Object.keys(t).sort().join(','), '__proto__,b', '未出现的也有键');
    });

    test('对照：普通 id 的计数与"未出现也有键"不变', () => {
      const r = new Rarity([
        { id: 'common', name: '普通', weight: 10, order: 1 },
        { id: 'rare', name: '稀有', weight: 1, order: 2 },
      ]);
      const t = r.tally(['rare', 'rare', 'common']);
      eq(t['rare'], 2);
      eq(t['common'], 1);
    });
  });

  // ================================================================
  // P2-7 · scenerouter：destroy / load 阶段进度
  // ================================================================
  describe('scenerouter · 卸载与加载进度（P2-7）', () => {
    test('⚠️ destroy() 之后 onChange 不再被触发（防止场景节点被闭包挂住）', () => {
      let calls = 0;
      const rt = new SceneRouter({ outMs: 100, inMs: 100, onChange: () => { calls++; } });
      rt.goTo('a');
      assert(calls > 0, '销毁前回调正常');
      const before = calls;
      rt.destroy();
      rt.goTo('b');
      eq(calls, before, '销毁后不得再有回调');
    });

    test('⚠️ destroy() 清空在途转场与历史栈', () => {
      const rt = new SceneRouter({ outMs: 100, inMs: 100, initial: 'menu' });
      rt.goTo('battle');
      eq(rt.busy, true);
      rt.destroy();
      eq(rt.busy, false, '在途转场应被取消');
      eq(rt.history.length, 0, '历史栈应清空');
    });

    test('⚠️ load 阶段 progress 恒为 0（记录真实语义，防止宿主误当进度条）', () => {
      /**
       * `out` / `in` 是定时动画，本模块知道总时长，能自己算进度；
       * `load` 的进度只有宿主的加载回调才知道，本模块拿不到，所以一律返回 0。
       * 文档原先没说清这点，宿主会以为"进度条卡住了"。
       */
      const rt = new SceneRouter({ outMs: 100, inMs: 100 });
      rt.goTo('battle');
      for (let i = 0; i < 10; i++) rt.tick(100);
      eq(rt.phase, 'load');
      eq(rt.state.progress, 0, 'load 阶段进度恒为 0，宿主需自行上报');
    });

    test('对照：out / in 阶段的进度照常推进，转场能正常走完', () => {
      const rt = new SceneRouter({ outMs: 300, inMs: 300 });
      rt.goTo('battle');
      rt.tick(150);
      near(rt.state.progress, 0.5, 1e-9, 'out 阶段过半');
      rt.tick(150);
      eq(rt.phase, 'load');
      rt.notifyLoaded();
      eq(rt.phase, 'in');
      rt.tick(300);
      eq(rt.phase, 'idle');
      eq(rt.current, 'battle');
    });
  });
}
