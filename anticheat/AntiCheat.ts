/**
 * anticheat/AntiCheat.ts —— 基础反作弊检测
 *
 * 【它解决什么】
 *
 * 这一层做的**不是**反外挂（那是驱动级对抗），
 * 而是"数据明显不合理"的检测。三条线索：
 *
 * 1. **移动速度** —— 一秒移动了 100 米，而角色上限是 10 米/秒
 * 2. **统计离群** —— 命中率 80%，而人类基线是 30%
 * 3. **行为指纹** —— 点击间隔精确等于 200ms，连抖动都没有
 *
 * 【⚠️ 三条必须遵守的原则】
 *
 * **原则一：宁可漏过，不可误判。**
 * 误判一个正常玩家的代价远大于放过一个作弊者。
 * 被误封的玩家会永远流失，还会在社区里说你游戏烂。
 * 所以：阈值留大幅余量，且要求**连续多次**触发才标记。
 *
 * **原则二：小样本一律不定罪。**
 * 10 发子弹全中，Z 分数高得离谱——但那完全可能是运气。
 * 所有统计类检测都有**样本量门槛**，不够就不判。
 * 这条规则是"不误伤"最主要的保障。
 *
 * **原则三：只输出可疑度，不做处罚。**
 * 是否封号由人工或上层策略决定。
 * 把判定和处罚写在一起，会让你不敢调阈值——
 * 因为每次调参都等于直接改变玩家的账号状态。
 *
 * 【零业务依赖】
 */

import { clamp, clamp01 } from '../_core/math';

// ==================== 速度检测 ====================

export interface SpeedSample {
  readonly x: number;
  readonly y: number;
  /** 时间戳（毫秒） */
  readonly t: number;
}

export interface SpeedViolation {
  /** 实测速度（单位/秒） */
  readonly speed: number;
  /** 允许的上限 */
  readonly allowed: number;
  readonly exceeded: boolean;
  /** 是否达到"连续异常"阈值 */
  readonly flagged: boolean;
  /** 当前连续异常次数 */
  readonly strikes: number;
}

export interface SpeedCheckerConfig {
  /** 合法最大速度（单位/秒） */
  readonly maxSpeed: number;
  /**
   * 容忍系数（默认 1.15）
   *
   * 【为什么留 15% 余量】
   * 网络抖动、客户端预测、插值误差都会让实测值偏高。
   * 系数设 1.0 的话，正常玩家会被大量误判。
   */
  readonly tolerance?: number;
  /**
   * 最小位移（默认 0）
   *
   * 位移极小时，时间测量的相对误差会被放大成巨大的速度。
   * 设 0.5 能滤掉这一类噪声。
   */
  readonly minDistance?: number;
  /** 连续异常多少次才算 flagged（默认 3） */
  readonly strikeThreshold?: number;
  /**
   * 滑动窗口大小（默认 0 = **关闭**）
   *
   * 与 `strikeThreshold` 是**两套并行的判据**：
   *
   * | 判据 | 抓什么 | 弱点 |
   * |---|---|---|
   * | `strikeThreshold`（连续） | 持续超速 | 抓不到"隔几帧来一次" |
   * | `windowSize` + `windowThreshold` | 窗口内累计超速次数 | 抓不到"窗口滑走后才集中爆发" |
   *
   * 【为什么默认关闭】
   * 见 `push()` 里窗口实现的注释——它会略微提高误报率，
   * 属于产品决策，不该由库替你决定。
   */
  readonly windowSize?: number;
  /**
   * 窗口内超速多少次才算 flagged（启用窗口时必填）
   *
   * 必须为正，且不应大于 `windowSize`
   * （大于就永远不可能触发，等于要求窗口内 100% 超速）。
   */
  readonly windowThreshold?: number;
}

export class SpeedChecker {
  private readonly _max: number;
  private readonly _tolerance: number;
  private readonly _minDist: number;
  private readonly _threshold: number;

  private _last: SpeedSample | null = null;
  private _strikes = 0;
  private _maxObserved = 0;

  /** 滑动窗口：最近 N 次有效样本里，是否超速（true = 超速） */
  private readonly _window: boolean[] = [];
  private readonly _winSize: number;
  private readonly _winThreshold: number;

  constructor(cfg: SpeedCheckerConfig) {
    if (!(cfg.maxSpeed > 0)) {
      throw new Error(`[AntiCheat] maxSpeed 必须为正，收到 ${cfg.maxSpeed}`);
    }
    this._max = cfg.maxSpeed;
    this._tolerance = cfg.tolerance ?? 1.15;
    this._minDist = cfg.minDistance ?? 0;
    this._threshold = cfg.strikeThreshold ?? 3;

    const winSize = cfg.windowSize ?? 0;
    const winThreshold = cfg.windowThreshold ?? 0;

    if (winSize < 0) {
      throw new Error(`[AntiCheat] windowSize 不能为负，收到 ${winSize}`);
    }
    if (winThreshold < 0) {
      throw new Error(`[AntiCheat] windowThreshold 不能为负，收到 ${winThreshold}`);
    }
    if (winSize > 0 && winThreshold === 0) {
      throw new Error(
        `[AntiCheat] 启用滑动窗口时必须指定 windowThreshold（收到 0）`
      );
    }
    if (winThreshold > 0 && winSize === 0) {
      throw new Error(
        `[AntiCheat] 指定 windowThreshold 时必须指定 windowSize（收到 0）`
      );
    }
    /**
     * 【为什么阈值必须为 1 以上，不能是 0】
     * `windowHits >= 0` 恒为真——窗口一启用就永远 flagged。
     * 我第一次写的时候允许 0，结果所有样本都被标记。
     */
    if (winSize > 0 && winThreshold > winSize) {
      throw new Error(
        `[AntiCheat] windowThreshold(${winThreshold}) 大于 windowSize(${winSize})，永远不可能触发`
      );
    }

    this._winSize = winSize;
    this._winThreshold = winThreshold;
  }

  get strikes(): number {
    return this._strikes;
  }

  get maxObserved(): number {
    return this._maxObserved;
  }

  /**
   * 上报一次位置
   *
   * @returns 首次调用、或样本无效时返回 null
   */
  push(s: SpeedSample): SpeedViolation | null {
    const prev = this._last;
    /**
     * 【⚠️ 只有**合法**样本才能成为下一轮的基线】
     *
     * 原实现一进门就 `this._last = s`，于是非法样本也会顶掉基线。
     * 时间戳为 NaN 的样本顶上之后，下一个**合法**样本算出
     * `dtSec = (t - NaN) / 1000 = NaN`，同样被守卫丢掉——
     * 一个坏包会连带废掉它后面那一个好包。
     *
     * 于是只要按"好包 / NaN 包"交替上报（每两个包塞一个 NaN），
     * **所有合法样本都会被跳过**，检测彻底失明，
     * 而 `strikes` 既不加也不清零——看起来"运行正常"。
     * 这比"清零连击"更彻底，且是同一条绕过链上的第三个入口。
     *
     * 修法：非法样本直接丢弃，基线保持为**上一个合法样本**。
     * 副作用是这一对样本的间隔被合并计算（dt 偏大 → 速度偏低），
     * 方向是"宁可少报、不可误报"，与原则三一致。
     */
    if (!prev) {
      this._last = s;
      return null;
    }

    const dtSec = (s.t - prev.t) / 1000;

    /**
     * 【⚠️ dt <= 0 必须忽略】
     *
     * 时间倒流（包乱序）会算出负速度；
     * dt 为 0（同一毫秒收到两个包）会算出 Infinity。
     *
     * 这两种情况都不是玩家的错，
     * 而且它们**在高频同步的游戏里是必然发生的**，不是理论风险。
     */
    /**
     * 【⚠️ 为什么写成 `!(dtSec > 0)` 而不是 `dtSec <= 0`】
     * 否定式 `dtSec <= 0` **拦不住 NaN**——`NaN <= 0` 为 false，继续执行；
     * 于是 `speed = dist / NaN` = NaN，`exceeded = NaN > threshold` 恒为 false
     * → 走 else 分支 → **`_strikes` 被清零**。
     *
     * 后果是"作弊者只要让时间戳变成 NaN 就能洗掉累计违规"：
     * 连续超速攒够的 strikes 被一个坏包抹平，检测彻底失效。
     * 时间戳为 NaN 的现实来源是客户端上报 `undefined` / `null` 的时间。
     *
     * 肯定式 `!(dtSec > 0)` 对 NaN 为 true → 正确忽略该样本。
     */
    if (!(dtSec > 0)) return null;

    const dx = s.x - prev.x;
    const dy = s.y - prev.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    /**
     * 【⚠️ dist 同样要挡 NaN，光挡住 dt 不够】
     *
     * dt 守卫只能拦住"时间戳为 NaN"，拦不住**坐标为 NaN**：
     * 坐标 NaN 时 `dist = NaN`，`NaN < minDist` 为 false → 穿透守卫，
     * 于是 `speed = NaN / dt = NaN`，`exceeded = NaN > allowed` 恒为 false
     * → 走 else → **`_strikes` 被清零**（和 P0/P1 里 dt 那条完全一样）。
     *
     * 实测（修复前）：连续两次超速攒到 `strikes = 2`，
     * 再上报一个 `{x: NaN}` 的样本 → `strikes` 变回 **0**。
     * 也就是说"洗掉连击"根本不需要伪造时间戳，
     * 只要上报一个坏坐标即可——这是同一条绕过链上的第二个入口。
     *
     * 【为什么是"跳过不计"而不是"清零"】
     * 非法样本既不是合规证明、也不是违规证据，它对判定**没有信息量**。
     * 把它算成"没超速"就等于送作弊者一次清零。跳过才是中性处理。
     */
    if (!Number.isFinite(dist)) return null;

    // 位移过小：比值误差太大，数据没有参考价值
    if (dist < this._minDist) return null;

    // 走到这里才是合法样本：它才有资格当下一轮的基线（见本方法开头的注释）
    this._last = s;

    const speed = dist / dtSec;
    if (speed > this._maxObserved) this._maxObserved = speed;

    const allowed = this._max * this._tolerance;
    const exceeded = speed > allowed;

    /**
     * 【连续计数】
     * 单次异常 → 可能是网络/服务器问题，只记数不标记
     * 连续 N 次 → 是模式，标记
     * 中间恢复正常 → 计数清零（不能秋后算账）
     */
    if (exceeded) {
      this._strikes++;
    } else {
      this._strikes = 0;
    }

    /**
     * 【滑动窗口：抓"隔几帧来一次"的作弊】
     *
     * `strikes` 要求**连续**超速，所以这种节奏完全免疫：
     *
     *   帧:   1    2    3    4    5    6
     *   速度: 25   3    25   3    25   3     ← 每帧都超速？不，隔一帧
     *   strikes: 1 → 0 → 1 → 0 → 1 → 0      ← 每次都被正常帧清零
     *
     * 实测（每 3 帧超速 1 帧，跑 200 帧）：
     *   仅连续计数    → 漏检，maxStrike 恒为 1
     *   开窗口(60/5) → ✅ 检出
     *
     * 【为什么两个计数并行，而不是二选一】
     * 它们抓的是不同的作弊形态，且**互不干扰**：
     * `strikes` 判持续性，窗口判高频间歇。
     *
     * 【为什么不违背"不能秋后算账"】
     * 原则一的要求是"恢复正常就清零，不追溯"。
     * 窗口**会滑走**——旧的超速记录会过期移出，
     * 不会像永久黑名单那样累积。但它确实有 N 个样本的"记忆"，
     * 这是抓间歇作弊必须付的代价。
     *
     * 【代价】会略微提高误报率：
     * 网络抖动可能在窗口内凑够阈值。所以默认关闭，由你决定要不要开。
     */
    let windowHits = 0;
    if (this._winSize > 0) {
      this._window.push(exceeded);
      if (this._window.length > this._winSize) this._window.shift();
      for (const hit of this._window) if (hit) windowHits++;
    }

    const flagged =
      this._strikes >= this._threshold ||
      (this._winSize > 0 && windowHits >= this._winThreshold);

    return {
      speed,
      allowed,
      exceeded,
      flagged,
      strikes: this._strikes,
    };
  }

  /**
   * 当前滑动窗口内的超速次数
   *
   * 窗口未启用时恒为 0。
   */
  get windowHits(): number {
    let n = 0;
    for (const hit of this._window) if (hit) n++;
    return n;
  }

  reset(): void {
    this._last = null;
    this._strikes = 0;
    this._window.length = 0;
    this._maxObserved = 0;
  }

  /**
   * 【铁律 5】可卸载
   *
   * SpeedChecker 不持有外部资源（无定时器、无监听、无引擎对象），
   * 所以这里只是把内部状态清空——**真正的目的是给出统一的收尾入口**：
   * 调用方（以及自动化的可卸载校验）不必为了"这个单元要不要特殊处理"去翻实现。
   *
   * 【⚠️ 不要在这个方法里加"告警/上报"之类的副作用】
   * 它被设计为纯粹的状态归零；有副作用的话，
   * 玩家断线重连时销毁旧 checker 就会误报一次。
   */
  destroy(): void {
    this.reset();
  }
}

// ==================== 统计离群 ====================

/**
 * 二项分布的 Z 分数
 *
 * `Z = (p̂ − p) / sqrt(p(1−p)/n)`
 *
 * 含义：实测比例偏离期望多少个标准差。
 * |Z| > 3 通常被认为"极不可能由随机造成"（约 0.3% 概率）。
 *
 * @param k 成功次数
 * @param n 总次数
 * @param p 期望比例
 */
export function binomialZ(k: number, n: number, p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error(`[AntiCheat] 期望比例必须在 (0,1) 开区间，收到 ${p}`);
  }
  if (n <= 0) return 0;

  const observed = k / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  if (se <= 0) return 0;
  return (observed - p) / se;
}

/**
 * 是否统计显著地超出人类水平
 *
 * 【⚠️ 样本量门槛是本函数最重要的部分】
 *
 * 10 发全中（Z ≈ 4.8）在统计上"显著"，但 10 发全中是正常的。
 * 没有 minSamples 的话，这个功能会误伤所有打得好的人。
 *
 * @param minSamples 最小样本量，低于此值一律返回 false
 */
export function isStatisticalOutlier(
  k: number,
  n: number,
  p: number,
  minSamples: number
): boolean {
  if (n < minSamples) return false;
  return binomialZ(k, n, p) > 3;
}

// ==================== 行为指纹 ====================

/**
 * 间隔规律性 = 变异系数 CV = 标准差 / 均值
 *
 * ```
 * CV = 0     完全精确（脚本）
 * CV = 0.05  极其规律
 * CV = 0.15  人类（有抖动）
 * ```
 *
 * @returns 样本不足时返回 **1**（表示"很不规律"，即不像脚本）
 *
 * 【为什么样本不足返回 1 而不是 0】
 * 返回 0 会被解读成"完美规律 = 脚本"，
 * 于是只有 1 个样本的新玩家直接被定罪。
 * 返回 1 让"样本不足"天然落到"不像脚本"这一侧——
 * 这符合"宁可漏过不可误判"。
 */
export function intervalRegularity(intervals: readonly number[]): number {
  if (intervals.length < 2) return 1;

  let sum = 0;
  for (const v of intervals) sum += v;
  const mean = sum / intervals.length;
  if (mean <= 0) return 1;

  let sq = 0;
  for (const v of intervals) sq += (v - mean) * (v - mean);
  const sd = Math.sqrt(sq / (intervals.length - 1));

  return sd / mean;
}

/**
 * 点击节奏是否像脚本
 *
 * @param minSamples 低于此样本量一律返回 false
 */
export function looksLikeScript(
  intervals: readonly number[],
  minSamples: number
): boolean {
  if (intervals.length < minSamples) return false;
  return intervalRegularity(intervals) < 0.05;
}

// ==================== 综合可疑度 ====================

export interface CheatEvidence {
  /** 速度违规次数 */
  readonly speedViolations?: number;
  /** 命中率的 Z 分数 */
  readonly accuracyZ?: number;
  /** 点击间隔的变异系数 */
  readonly intervalCv?: number;
  /** 被举报加权分 */
  readonly reportScore?: number;
  /** 是否新账号（作弊者常用小号） */
  readonly isNewAccount?: boolean;
}

export interface SuspicionBreakdown {
  readonly speed: number;
  readonly accuracy: number;
  readonly interval: number;
  readonly report: number;
  readonly account: number;
}

export interface SuspicionResult {
  readonly score: number;
  readonly action: 'none' | 'watch' | 'review' | 'ban';
  readonly breakdown: SuspicionBreakdown;
}

/** 各项的上限（防止单一证据直接定罪） */
const CAPS = {
  speed: 40,
  accuracy: 30,
  interval: 25,
  report: 15,
  account: 5,
};

/**
 * 综合可疑度 0~100
 *
 * 【核心设计：每一项都有封顶】
 *
 * 速度异常最多 40 分，而封禁阈值是 85 分。
 * 这意味着**光靠速度异常永远无法触发封禁**——
 * 必须有两条以上的独立证据。
 *
 * 为什么这么保守：任何单一检测器都可能被特殊情况触发
 * （服务器回滚、网络重传、某个技能的机制）。
 * 要求多证据交叉，误判率会下降一个数量级。
 */
/**
 * 取证据字段：缺失（undefined）视为 0，坏数据（NaN/Infinity）抛错
 *
 * 【为什么"缺失"和"坏数据"要分开处理】
 * - 缺失 = 这个证据没有采集到 → 记 0 分，其余证据照常
 * - 坏数据 = 采集到了但是 NaN → 说明上游算错了，
 *   若当成 0 就等于"违规 10 次"和"违规 0 次"同分，作弊者被放过
 */
function numOrStrict(v: number | undefined, name: string): number {
  if (v === undefined) return 0;
  if (!Number.isFinite(v)) {
    throw new Error(
      `[AntiCheat] suspicionScore 的 ${name} 是坏数据：${v}。` +
      `安全链路不允许静默兜底——请检查上游采集逻辑。`
    );
  }
  return v;
}

export function suspicionScore(e: CheatEvidence): SuspicionResult {
  /**
   * 【⚠️ 每个证据字段都必须先做有限性收口，再参与加权】
   *
   * 老实现直接把字段喂给 `clamp`：而 `clamp` 的实现是
   * `v < min ? min : v > max ? max : v`——**NaN 两个比较都为 false，
   * 于是原样穿透**。任何一个字段是 NaN，`raw` 就被污染成 NaN，
   * `score = Math.round(clamp(NaN,0,100)) = NaN`。
   *
   * 更糟的是 `actionFor(NaN)` 里三个 `>=` 全为 false，
   * 返回 `'none'` —— **作弊者被直接放过**。
   *
   * 实测（修复前）：一个"速度违规 10 次 + 命中率 z=6"的账号
   * （本应 `ban`，score=100），只要 `intervalCv` 是 NaN，
   * 实际返回 `action:'none'`，且不抛错、不打日志。
   *
   * `intervalCv` 由 `intervalRegularity(intervals)` 产出，
   * 只要 intervals 里混入一个 NaN（时间戳缺失/除零）就是 NaN——
   * 这是**真实会发生**的输入，不是理论可能。
   *
   * 【为什么是抛错而不是兜底成 0】
   * 这是安全链路。兜底成 0 意味着"证据不足→放行"，
   * 与"被 NaN 污染后放行"的结果**完全一样**——等于没修。
   * 安全链路宁可响亮失败（让运维介入），也不能静默放行。
   */
  /**
   * 【⚠️ 不能用 `numOr(e.x, 0)` 一刀切——它会把 NaN 也转成 0】
   *
   * 第一版我就写成了 `numOr(e.speedViolations, 0)`，
   * 结果"核心证据是 NaN"被静默当成"没有违规"——
   * 与原本的失败模式（放行）**结果完全一样**，等于没修。
   *
   * 必须区分两种缺失：
   * - `undefined`（字段没传）→ 视为 0，合理
   * - `NaN`（传了但是坏数据）→ **抛错**，否则作弊者靠制造 NaN 就能免检
   */
  const speedViolations = numOrStrict(e.speedViolations, 'speedViolations');
  const accuracyZ = numOrStrict(e.accuracyZ, 'accuracyZ');
  const reportScore = numOrStrict(e.reportScore, 'reportScore');

  // 速度：每次 8 分，封顶 40
  const speed = Math.min(8 * Math.max(0, speedViolations), CAPS.speed);

  /**
   * 命中率：Z 分数减去 2 才开始计分
   *
   * Z <= 2 属于"打得好的正常玩家"范围（约前 2.5%），不该有任何嫌疑。
   * 之后每 1 个 Z 记 8 分。
   *
   * ⚠️ 负值必须夹到 0，否则"低于平均水平"会变成负分，
   * 抵消掉其他证据——那等于奖励菜鸡作弊。
   */
  const accuracy = clamp((Math.max(0, accuracyZ - 2) * 8), 0, CAPS.accuracy);

  /**
   * 间隔规律性：CV 低于 0.05 才开始计分
   * CV = 0（完美精确）→ 25 分；CV = 0.05 → 0 分
   *
   * 【⚠️ cv 为 NaN 时按"无信息"处理（不计分），不是放行整份评分】
   * 这与上面的"抛错"不矛盾：cv 来自 `intervalRegularity()`，
   * 它可能因为数据不足（而非数据损坏）返回 NaN，
   * 属于"这条证据缺失"而非"证据被污染"。
   * 缺失的证据不计分，其余证据照常生效——
   * 上例（10 次违规 + z=6）仍会得到 speed=40 + accuracy=30 = 70 分，
   * 足以触发处置，不会因为 cv 缺失就被放过。
   */
  const cvRaw = e.intervalCv;
  const cv = cvRaw !== undefined && Number.isFinite(cvRaw) ? cvRaw : undefined;
  const interval =
    cv === undefined ? 0 : clamp((0.05 - cv) * 500, 0, CAPS.interval);

  // 举报：每条 3 分，封顶 15（举报本身可信度有限）
  const report = Math.min(3 * Math.max(0, reportScore), CAPS.report);

  const account = e.isNewAccount ? CAPS.account : 0;

  const raw = speed + accuracy + interval + report + account;

  /**
   * 【最后一道闸】非有限分数直接抛错，绝不放行
   * 前面已逐字段收口，这里理论上不会触发；
   * 但安全链路值得双保险——宁可响亮失败，也不能返回 NaN 让 action 退化成 none。
   */
  if (!Number.isFinite(raw)) {
    throw new Error(
      `[AntiCheat] suspicionScore 计算出非有限分数：${raw}` +
      `（speed=${speed}, accuracy=${accuracy}, interval=${interval}, report=${report}）`
    );
  }

  const score = Math.round(clamp(raw, 0, 100));

  return { score, action: actionFor(score), breakdown: { speed, accuracy, interval, report, account } };
}

/**
 * 分数 → 建议动作
 *
 * ```
 *  0-29  none    不处理
 * 30-59  watch   仅记录，提高采样频率
 * 60-84  review  进人工复核队列
 * 85+    ban     建议封禁
 * ```
 *
 * 【阈值为什么这么高】
 * 这是原则一的直接体现。
 * 宁可让 10 个作弊者多玩几天，也不能封错 1 个正常玩家。
 */
export function actionFor(score: number): 'none' | 'watch' | 'review' | 'ban' {
  if (score >= 85) return 'ban';
  if (score >= 60) return 'review';
  if (score >= 30) return 'watch';
  return 'none';
}

// ==================== 便捷 ====================

/**
 * 把命中数据转成 Z 分数（用于 suspicionScore 的 accuracyZ）
 *
 * @param baseRate 人类基线命中率
 */
export function accuracyZ(hits: number, shots: number, baseRate: number): number {
  return binomialZ(hits, shots, baseRate);
}

/** 归一化到 0~1（与 clamp01 同义，此处为语义清晰） */
export function normalizeScore(score: number): number {
  return clamp01(score / 100);
}
