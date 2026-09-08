import { clampNum, numOr } from '../_core/math';
/**
 * autoquality/AutoQuality.ts —— 帧率监测与自动画质降级
 *
 * 【它解决什么】
 *
 * 自动降级的朴素写法：
 *
 * ```typescript
 * if (fps < 50) lowerQuality();
 * else if (fps > 58) raiseQuality();
 * ```
 *
 * 三个会让这个功能从"有用"变成"灾难"的问题：
 *
 * 1. **均值被单帧卡顿污染**
 *    一次 500ms 的 GC 停顿，会把 60 帧的平均值从 60 拉到 52。
 *    于是系统认为"性能不够"开始降级——
 *    而实际上只有那一帧有问题。
 *    **应该用中位数**，它对离群值免疫。
 *
 * 2. **边界横跳**
 *    帧率在 55 附近抖动时，会在"降级"和"升级"之间反复切换。
 *    每次切换都要重建渲染资源，玩家看到的是**画面一直在闪**。
 *    这比稳定 50 帧糟糕得多。
 *    **需要迟滞**：降级的阈值（55）要低于升级的阈值（58）。
 *
 * 3. **切换后立即评估**
 *    刚降完档的那几帧，可能正在编译着色器、重建纹理，
 *    帧率反而更低。如果立刻再评估，会连降三级到底。
 *    **需要冷却期**，切换后等 2 秒再采样。
 *
 * 【设计】
 * 本模块只输出"该用哪个档位"，不执行任何渲染操作。
 * 执行（改分辨率、关阴影）由调用方注册的回调完成，
 * 所以它可以被完整测试：喂给它一串帧时间，看档位怎么变。
 */

// ==================== 类型 ====================

export type QualityLevel = number;

/** 档位定义 */
export interface QualityTier {
  readonly level: QualityLevel;
  /** 显示名（"低" / "中" / "高"） */
  readonly name: string;
  /** 该档位的参数（透传给回调，由调用方解释） */
  readonly settings: Readonly<Record<string, number | boolean | string>>;
}

export interface AutoQualityConfig {
  /** 档位列表（按 level 升序，0 = 最低） */
  readonly tiers: readonly QualityTier[];
  /**
   * 初始档位（默认最高档）
   *
   * 【⚠️ 默认不要从最低档开始】
   * 现代设备的性能差异极大，从最低档开始会让
   * 旗舰机用户看到很差的画面，且**永远不会升上去**
   * （因为从低档升档需要"帧率过剩"这个信号，而低档下永远过剩）。
   */
  readonly initialLevel?: QualityLevel;
  /**
   * 降级阈值（fps，默认 50）
   *
   * 持续低于此值就降一档。
   */
  readonly downgradeFps?: number;
  /**
   * 升级阈值（fps，默认 58）
   *
   * 【⚠️ 必须显著高于降级阈值】
   * 两者相同会导致边界横跳。建议差 8 fps 以上。
   */
  readonly upgradeFps?: number;
  /**
   * 采样窗口大小（默认 60 帧）
   *
   * 太小 → 抖动敏感；太大 → 反应迟钝。
   * 60 帧 @60fps ≈ 1 秒，是个合理的折中。
   */
  readonly windowSize?: number;
  /**
   * 切换后的冷却时长（毫秒，默认 2000）
   *
   * 冷却期内不采样、不决策。
   */
  readonly cooldownMs?: number;
  /**
   * 触发降级所需的连续不达标次数（默认 3）
   *
   * 【为什么不是"一次就降"】
   * 一次卡顿就降级的话，过场动画、场景加载都会触发降级。
   * 要求连续 N 次采样都不达标，能过滤掉瞬时抖动。
   */
  readonly consecutiveSamples?: number;
  /**
   * 是否允许自动升档（默认 true）
   *
   * false 的话只降不升，最保守。
   * 有些项目宁可让玩家手动调高，也不愿自动升级后掉帧。
   */
  readonly allowUpgrade?: boolean;
  /**
   * 档位变化历史的最大保留条数（默认 50）
   *
   * 【⚠️ 为什么必须收口】
   * 历史是"排查为什么降档"用的诊断数据，只关心最近若干次。
   * 但它是只增不减的数组：长时间挂机 + 帧率在阈值附近抖动时，
   * 一次升降就是一条，实测 360 帧的横跳能攒出 79 条，
   * 挂机几小时就是几万条——为一个诊断字段付出持续增长的常驻内存。
   *
   * 【为什么是"丢最旧的"】
   * 诊断价值随时效衰减："刚刚为什么降了"有用，
   * "三小时前为什么降了"没人看。丢尾部不影响排查当下的问题。
   */
  readonly historyLimit?: number;
}

export interface AutoQualityState {
  readonly level: QualityLevel;
  readonly tierName: string;
  /** 当前中位数 fps */
  readonly fps: number;
  /**
   * fps 是否可信（采样已满且不在冷却期）
   *
   * 【为什么需要】
   * 冷却期会清空采样窗口，此时 `fps` 读到的是残留的旧数据。
   * 让每个调用方都自己拼 `settled && !coolingDown` 太容易漏，
   * 直接给一个字段。
   */
  readonly fpsValid: boolean;
  /** 采样窗口是否已满 */
  readonly settled: boolean;
  /** 是否在冷却期 */
  readonly coolingDown: boolean;
  /** 冷却剩余（毫秒） */
  readonly cooldownRemaining: number;
  /** 连续不达标次数 */
  readonly strikes: number;
  /** 本档位已运行时长（毫秒） */
  readonly timeInLevel: number;
  /** 是否已被玩家手动锁定 */
  readonly manualLocked: boolean;
}

// ==================== 实现 ====================

export class AutoQuality {
  private readonly _tiers: readonly QualityTier[];
  private readonly _downFps: number;
  private readonly _upFps: number;
  private readonly _window: number;
  private readonly _cooldownMs: number;
  private readonly _needStrikes: number;
  private readonly _allowUpgrade: boolean;
  private readonly _historyLimit: number;

  private _level: QualityLevel;
  private readonly _byLevel = new Map<QualityLevel, QualityTier>();

  /**
   * 帧时间环形缓冲 + 三个统计量的唯一实现
   *
   * 【⚠️ 为什么统计逻辑要委托给 FpsMeter，而不是在本类里再写一遍】
   * 本类原本自带 medianFps / averageFps / lowFps1Percent 三份实现，
   * FpsMeter 里又有同名的三份，**逐行对比下来算法完全一样**。
   *
   * 两份实现的代价不是"多写几行"，而是**修 bug 要修两遍**：
   * 中位数对 NaN 的处理、1% low 的取整方式、空窗口返回什么，
   * 任何一处只改一边，就会出现"调试面板和自动降档读数不一致"，
   * 而这类不一致不会报错，只会让人怀疑自己的眼睛。
   *
   * 现在本类只持有样本写入与冷却语义，统计全部由 `_meter` 负责。
   */
  private readonly _meter: FpsMeter;

  private _cooldownLeft = 0;
  private _strikes = 0;
  private _timeInLevel = 0;
  private _locked = false;
  private _now = 0;

  /** 档位变化历史（排查"为什么降了"用） */
  private readonly _history: {
    readonly from: QualityLevel;
    readonly to: QualityLevel;
    readonly at: number;
    readonly fps: number;
    readonly reason: string;
  }[] = [];

  constructor(cfg: AutoQualityConfig) {
    if (cfg.tiers.length === 0) {
      throw new Error('[AutoQuality] 至少要有一个档位');
    }
    this._tiers = [...cfg.tiers].sort((a, b) => a.level - b.level);
    for (const t of this._tiers) this._byLevel.set(t.level, t);

    this._downFps = cfg.downgradeFps ?? 50;
    this._upFps = cfg.upgradeFps ?? 58;
    this._window = clampNum(cfg.windowSize, 3, 1e6, 60);
    this._cooldownMs = Math.max(0, numOr(cfg.cooldownMs, 2000));
    this._needStrikes = Math.max(1, numOr(cfg.consecutiveSamples, 3));
    this._allowUpgrade = cfg.allowUpgrade ?? true;
    this._historyLimit = clampNum(cfg.historyLimit, 1, 1e6, 50);

    this._level = cfg.initialLevel ?? this._tiers[this._tiers.length - 1]!.level;
    if (!this._byLevel.has(this._level)) {
      throw new Error(`[AutoQuality] 初始档位 ${this._level} 不在 tiers 里`);
    }

    /**
     * 【迟滞检查】
     * 升级阈值必须高于降级阈值，否则会在边界反复横跳。
     * 这是配置错误，应该在构造时就抛，而不是等玩家发现画面在闪。
     */
    if (this._allowUpgrade && this._upFps <= this._downFps) {
      throw new Error(
        `[AutoQuality] 升级阈值 ${this._upFps} 必须高于降级阈值 ${this._downFps}，`
        + `否则会在边界反复横跳（当前差 ${this._upFps - this._downFps}，建议 ≥ 8）`
      );
    }

    this._meter = new FpsMeter(this._window);
  }

  // ==================== 采样 ====================

  /**
   * 每帧调用
   *
   * @param dtMs 本帧耗时（毫秒）
   * @param now 当前时间（毫秒）
   *
   * 【⚠️ dtMs 用渲染帧时间，不是逻辑帧时间】
   * 逻辑帧可能因为固定步长而恒定 16.7ms，
   * 那样采样出来的永远是 60fps，自动降级永远不会触发。
   */
  update(dtMs: number, now: number): void {
    /**
     * 【⚠️ dtMs 必须收口，否则"帧耗时 0"会被读成"0 fps"→ 直接降到最低档】
     *
     * 链路：
     * ```
     * dtMs = 0  →  _samples 里全是 0
     *           →  medianFps: `med > 0 ? 1000 / med : 0` → 返回 **0**
     *           →  `if (fps < this._downFps)` 成立 → 连续 N 次后降到最低档
     * ```
     * **方向完全反了**：dtMs 越小意味着越快，结果被判成最慢。
     *
     * 实测（修复前）：喂 30 次 `update(0, i*10)` → `medianFps === 0`、档位降到 1（最低）。
     * 而 `update(16.7, ...)` 正常得到 59.9。
     *
     * dtMs 为 0 的现实来源：高精度计时器在部分平台/首帧返回 0，
     * 或调用方把"秒"当"毫秒"传（`0.016` 会被读成 62500fps，同样失真）。
     *
     * 【为什么是"丢弃样本"而不是"夹到下界"】
     * 帧耗时 ≤ 0 在本模块里没有可解释的含义（不像 dt 缩放可以为 0），
     * 夹成任意正数都是在编造数据。丢弃一帧对中位数几乎无影响，
     * 却避免了"一个 0 把整窗拉到最低档"。
     *
     * 【为什么 NaN 也必须挡】
     * `med > 0` 对 NaN 为 false → 同样返回 0 → 同样降到最低档，
     * 且 NaN 会在排序数组里污染中位数（`[NaN, 16, 16].sort()` 顺序不可预期）。
     */
    const validDtMs = Number.isFinite(dtMs) && dtMs > 0;

    const dt = now - this._now;
    this._now = now;
    this._timeInLevel += Math.max(0, Math.min(dt, 1000));

    // 冷却期：不采样、不决策
    if (this._cooldownLeft > 0) {
      this._cooldownLeft -= Math.max(0, Math.min(dt, 1000));
      if (this._cooldownLeft > 0) return;
      this._cooldownLeft = 0;
      // 冷却结束：清空窗口，避免用切换前的旧数据决策
      this._resetWindow();
      return;
    }

    if (this._locked) return;

    // 写入环形缓冲（非法样本直接跳过，不占位）
    if (!validDtMs) return;
    this._meter.tick(dtMs);

    if (!this._meter.settled) return;

    // 决策
    const fps = this.medianFps;
    if (fps < this._downFps) {
      /**
       * 【方向反转时清零另一侧的计数】
       *
       * 早期版本用一个双向计数器：快帧时减到 -2N，慢帧时再加回来。
       * 于是一段长时间流畅后，要 2N + N 帧才会触发降级——
       * 玩家已经卡了三秒，系统还在"还债"。
       * 方向一变就清零，计数才是真正的"连续 N 次"。
       */
      if (this._strikes < 0) this._strikes = 0;
      this._strikes++;
      if (this._strikes >= this._needStrikes) {
        this._downgrade(fps);
      }
    } else if (this._allowUpgrade && fps > this._upFps) {
      /**
       * 【升级比降级更保守】
       * 升级的连续要求次数是降级的 2 倍。
       * 降错了玩家只损失一点画面；
       * 升错了会掉帧，而掉帧直接影响操作手感——代价不对等。
       */
      if (this._strikes > 0) this._strikes = 0;
      this._strikes--;
      if (this._strikes <= -this._needStrikes * 2) {
        this._upgrade(fps);
      }
    } else {
      // 稳定区间：清零计数，避免缓慢累积后误触发
      this._strikes = 0;
    }
  }

  private _resetWindow(): void {
    this._meter.reset();
    this._strikes = 0;
  }

  private _downgrade(fps: number): void {
    const i = this._tiers.findIndex((t) => t.level === this._level);
    if (i <= 0) {
      /**
       * 已在最低档：把计数**钉在阈值上**，不是清零。
       * 清零的话下一帧又会重新累加到阈值并再次调用本方法，
       * 等于每帧都白跑一次 findIndex。
       */
      this._strikes = this._needStrikes;
      return;
    }
    const from = this._level;
    this._level = this._tiers[i - 1]!.level;
    this._pushHistory({
      from, to: this._level, at: this._now, fps,
      reason: `帧率 ${fps.toFixed(1)} < ${this._downFps}`,
    });
    this._enterCooldown();
  }

  private _upgrade(fps: number): void {
    const i = this._tiers.findIndex((t) => t.level === this._level);
    if (i < 0 || i >= this._tiers.length - 1) {
      this._strikes = -this._needStrikes * 2;
      return;
    }
    const from = this._level;
    this._level = this._tiers[i + 1]!.level;
    this._pushHistory({
      from, to: this._level, at: this._now, fps,
      reason: `帧率 ${fps.toFixed(1)} > ${this._upFps}`,
    });
    this._enterCooldown();
  }

  private _enterCooldown(): void {
    this._cooldownLeft = this._cooldownMs;
    this._timeInLevel = 0;
    this._resetWindow();
  }

  /**
   * 写入一条档位变化历史（超上限时丢最旧的）
   *
   * 【为什么这里收口而不是在 push 的地方各写一遍】
   * 历史有三处写入点（手动设置 / 自动降级 / 自动升级）。
   * 容量上限如果散在三个地方，漏掉一处就会出现
   * "手动切换不涨、自动切换涨"这种只对一半的修复。
   */
  private _pushHistory(rec: {
    readonly from: QualityLevel;
    readonly to: QualityLevel;
    readonly at: number;
    readonly fps: number;
    readonly reason: string;
  }): void {
    this._history.push(rec);
    if (this._history.length > this._historyLimit) {
      this._history.splice(0, this._history.length - this._historyLimit);
    }
  }

  // ==================== 帧率统计 ====================

  /**
   * 中位数 fps
   *
   * 【为什么用中位数而不是均值】
   * 均值会被单帧超长卡顿污染：
   * 59 帧 × 16.7ms + 1 帧 × 500ms = 1485ms / 60 = 24.8ms → 40fps
   * 实际上 59/60 的时间都是流畅的。
   * 中位数对这种离群值完全免疫。
   *
   * 【⚠️ 冷却期和采样未满时，这个值没有意义】
   *
   * 切换档位会清空采样窗口（避免拿切换前的旧数据决策），
   * 此时缓冲里残留的是**上一档位**的帧时间。
   * 直接读它会得出"降到低画质了，但帧率显示 60"这种自相矛盾的诊断。
   *
   * 调试面板应当先判断 `state.settled && !state.coolingDown`，
   * 否则显示"—"或"测量中"。
   */
  get medianFps(): number {
    return this._fpsOrIdle(this._meter.median);
  }

  /** 平均 fps（仅作参考/诊断用，不参与决策） */
  get averageFps(): number {
    return this._fpsOrIdle(this._meter.average);
  }

  /**
   * 空窗口时三个统计量统一返回 60
   *
   * 【⚠️ 为什么是 60 而不是 0】
   * 0 会被调试面板显示成"帧率 0"，看起来像卡死了；
   * 而空窗口的实际含义是"还没测出来"（刚切档 / 刚启动），不是"很慢"。
   * 返回 60（假定正常）不会误导排查方向。
   *
   * FpsMeter 面向"我要真实读数"，空窗口返回 0；
   * 本类面向"档位决策 + 面板显示"，返回 60。
   * 两者语义不同，不是同一个数写错了两遍——委托时在这里收口。
   */
  private _fpsOrIdle(v: number): number {
    return this._meter.sampleCount === 0 ? 60 : v;
  }

  /**
   * 1% 最低帧（最差的 1% 帧的平均）
   *
   * 【用途】
   * 中位数看的是"典型情况"，1% low 看的是"最差情况"。
   * 玩家抱怨"卡"通常是因为后者——
   * 平均 60 帧但每秒掉一次到 15 帧，体感依然很差。
   */
  get lowFps1Percent(): number {
    return this._fpsOrIdle(this._meter.lowFps1Percent);
  }

  // ==================== 手动控制 ====================

  /**
   * 玩家手动设置档位
   *
   * 【⚠️ 手动设置后自动调节应停止】
   *
   * 玩家明确选择了"高画质"，
   * 系统却在 2 秒后因为掉帧把它降回去——
   * 玩家会觉得"我的设置没生效"，反复去调，然后生气。
   *
   * 正确做法：手动设置后锁定自动调节，
   * 并在设置界面明确说明"手动设置将关闭自动调节"。
   */
  setManualLevel(level: QualityLevel): boolean {
    if (!this._byLevel.has(level)) return false;
    /**
     * 【⚠️ 必须在赋值之前取旧档位】
     *
     * 原写法先 `this._level = level` 再 `from: this._level`，
     * 于是历史里每条手动切换都记成 `2 → 2`（from === to）。
     *
     * 后果不是"少记一个数"这么轻：
     * `describe()` 里所有手动切换都渲染成 `· 2 → 2`，
     * 玩家问"画质为什么降了"时，这段历史**完全看不出从哪切过来**——
     * 它就是为此存在的，废掉之后等于没有。
     *
     * 自动升降档（_downgrade/_upgrade）早就正确取了 from，
     * 只有手动这条路径写错了，属于同一份数据两种口径。
     */
    const from = this._level;
    this._level = level;
    this._locked = true;
    this._enterCooldown();
    this._pushHistory({
      from, to: level, at: this._now, fps: this.medianFps,
      reason: '玩家手动设置',
    });
    return true;
  }

  /**
   * 解除手动锁定，恢复自动调节
   *
   * 【⚠️ 解除后应该从当前档位开始评估，而不是跳回最高档】
   * 直接跳到最高档会让刚解锁的玩家立刻掉帧。
   */
  unlock(): void {
    this._locked = false;
    this._enterCooldown();
  }

  get locked(): boolean {
    return this._locked;
  }

  // ==================== 查询 ====================

  get level(): QualityLevel {
    return this._level;
  }

  get tier(): QualityTier {
    return this._byLevel.get(this._level)!;
  }

  /** 当前档位的参数 */
  get settings(): Readonly<Record<string, number | boolean | string>> {
    return this.tier.settings;
  }

  get state(): AutoQualityState {
    const settled = this._meter.settled;
    return {
      level: this._level,
      tierName: this.tier.name,
      fps: this.medianFps,
      fpsValid: settled && this._cooldownLeft <= 0,
      settled,
      coolingDown: this._cooldownLeft > 0,
      cooldownRemaining: Math.max(0, this._cooldownLeft),
      strikes: this._strikes,
      timeInLevel: this._timeInLevel,
      manualLocked: this._locked,
    };
  }

  /** 档位变化历史 */
  get history(): readonly {
    readonly from: QualityLevel;
    readonly to: QualityLevel;
    readonly at: number;
    readonly fps: number;
    readonly reason: string;
  }[] {
    return this._history;
  }

  /**
   * 生成诊断报告
   *
   * 【为什么需要】
   * "为什么我的画质变低了"是玩家常问的问题，
   * 客服没法复现。这份报告能直接告诉玩家原因。
   */
  describe(): string {
    const s = this.state;
    const lines = [
      `当前档位：${s.tierName}（level ${s.level}）`,
      `帧率：${s.fpsValid
        ? `中位 ${s.fps.toFixed(1)} / 平均 ${this.averageFps.toFixed(1)} / 1%最低 ${this.lowFps1Percent.toFixed(1)}`
        : '测量中（' + (s.coolingDown ? '切换冷却' : '采样未满') + '，读数暂不可信）'}`,
      `阈值：降级 <${this._downFps} / 升级 >${this._upFps}（迟滞 ${(this._upFps - this._downFps).toFixed(0)} fps）`,
      `状态：${s.coolingDown ? `冷却中（剩 ${s.cooldownRemaining.toFixed(0)}ms）` : (s.settled ? '采样中' : '采样未满')}`
        + `${s.manualLocked ? ' · 已手动锁定' : ''}`,
    ];
    if (this._history.length > 0) {
      lines.push('', '切换记录：');
      for (const h of this._history.slice(-5)) {
        const dir = h.to > h.from ? '↑' : h.to < h.from ? '↓' : '·';
        lines.push(`  ${dir} ${h.from} → ${h.to}  @${(h.at / 1000).toFixed(1)}s  ${h.reason}`);
      }
    }
    return lines.join('\n');
  }

  // ==================== 卸载 ====================

  /**
   * 释放采样缓冲与历史记录
   *
   * 【为什么要显式提供】
   * 本类持有两个会随运行时间增长的容器：
   * 采样窗口（`_window` 个帧时间）和档位历史（上限 `_historyLimit` 条）。
   * 切场景时旧实例如果忘了丢，这两个数组会被一直钉在内存里。
   *
   * 【为什么不清 `_tiers` / 配置】
   * 那些是构造期确定的只读数据，清掉之后 destroy 过的对象
   * 连 `level` 都读不出来，比留着更糟。
   * destroy 只清"累积出来的东西"。
   */
  destroy(): void {
    this._history.length = 0;
    this._meter.reset();
    this._strikes = 0;
    this._cooldownLeft = 0;
    this._timeInLevel = 0;
  }

  // ==================== 便捷：预设档位 ====================

  /**
   * 生成常见的三档配置
   *
   * 【为什么提供】
   * 大部分项目的画质档位参数都差不多，
   * 从零写一遍既费时又容易漏项。
   * 这只是个起点，调用方可以改。
   */
  static defaultTiers(): readonly QualityTier[] {
    return [
      {
        level: 0,
        name: '低',
        settings: {
          shadow: false, antialias: false, particleCount: 0.3,
          renderScale: 0.75, textureQuality: 0.5, maxLights: 1,
        },
      },
      {
        level: 1,
        name: '中',
        settings: {
          shadow: true, antialias: false, particleCount: 0.6,
          renderScale: 0.9, textureQuality: 0.75, maxLights: 2,
        },
      },
      {
        level: 2,
        name: '高',
        settings: {
          shadow: true, antialias: true, particleCount: 1,
          renderScale: 1, textureQuality: 1, maxLights: 4,
        },
      },
    ];
  }
}

// ==================== 便捷：帧率采样器 ====================

/**
 * 独立的帧率采样器
 *
 * 【用途】
 * 不想接自动降级，只想在调试面板上显示帧率时也用得上。
 */
export class FpsMeter {
  private readonly _window: number;
  private readonly _samples: number[];
  private _idx = 0;
  private _count = 0;
  /** 排序结果缓存。null = 脏了，下次读要重排 */
  private _sorted: number[] | null = null;

  /**
   * 【⚠️ 窗口大小必须收口，不能只写 Math.max(3, windowSize)】
   *
   * 原写法 `Math.max(3, NaN)` 得到 **NaN**（NaN 参与 max 会被"吞掉"成 NaN），
   * 紧接着 `new Array(NaN)` 抛 `RangeError: Invalid array length`。
   * 实测：`new FpsMeter(NaN)` 直接崩，构造函数就是崩溃点，
   * 堆栈完全不会指向"是谁传了 NaN 进来"——配置是从外部读的，
   * 排查时只能一行行回退去找那个来源。
   *
   * `Infinity` 同样崩（实测同样是 Invalid array length）。
   *
   * 【为什么这里值得单独强调】
   * 同一个文件里的 `AutoQuality` 用 `clampNum(cfg.windowSize, 3, 1e6, 60)`
   * 收口得很干净，`FpsMeter` 却用裸 `Math.max`——
   * **两份配置来源相同，一个安全一个崩溃**，这本身就是最容易踩的坑：
   * 调用方会以为"这个类对坏值是宽容的"，因为另一个类是宽容的。
   *
   * 统一用 `clampNum`：NaN / Infinity / 负数全部回落默认值 60。
   */
  constructor(windowSize = 60) {
    this._window = clampNum(windowSize, 3, 1e6, 60);
    this._samples = new Array(this._window).fill(16.7);
  }

  tick(dtMs: number): void {
    this._samples[this._idx] = dtMs;
    this._idx = (this._idx + 1) % this._window;
    if (this._count < this._window) this._count++;
    this._sorted = null;
  }

  /**
   * 已写入的样本数（0 表示空窗口）
   *
   * 【为什么需要对外暴露】
   * `median` / `average` 在空窗口时都返回 0，
   * 而 0 既可能是"真的测得 0 fps"，也可能是"还没样本"。
   * 调用方要区分这两种情况（例如"测量中"提示），只能靠这个字段。
   */
  get sampleCount(): number {
    return this._count;
  }

  /**
   * 升序排列的样本副本（带缓存）
   *
   * 【⚠️ 为什么要缓存】
   * 三个统计量每次读取都要 `sort()`，而排序前的 `[...slice()]` 还会再分配一个数组。
   * 调用方的典型用法是"每帧读一次中位数 + 每帧读一次状态"，
   * 也就是每帧 2 次 O(n log n) + 2 次数组分配——
   * 而**帧率监测恰恰是给性能已经不好的机器用的**，
   * 在最需要省算力的时刻做最多的无用功。
   *
   * 样本只在 `tick()` 时变化，所以"写脏读缓存"是安全的：
   * 两次 tick 之间不管读多少次，排一次就够。
   *
   * 【为什么用升序统一三个统计量】
   * median 要升序取中间；1% low 要的是"帧时间最大的那 1%"（fps 最低），
   * 也就是升序数组的**末尾** n 个。两者共用同一份升序缓存即可，
   * 不需要再维护一份降序。
   */
  private _ascending(): readonly number[] {
    if (this._sorted === null) {
      this._sorted = [...this._samples.slice(0, this._count)].sort((a, b) => a - b);
    }
    return this._sorted;
  }

  /** 中位帧率（最常用，抗离群） */
  get median(): number {
    if (this._count === 0) return 0;
    const arr = this._ascending();
    const mid = arr.length >> 1;
    const med = arr.length % 2 === 1
      ? arr[mid]!
      : (arr[mid - 1]! + arr[mid]!) / 2;
    return med > 0 ? 1000 / med : 0;
  }

  get average(): number {
    if (this._count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this._count; i++) sum += this._samples[i]!;
    return sum > 0 ? (1000 * this._count) / sum : 0;
  }

  /**
   * 1% 最低帧
   *
   * 【为什么调试面板也需要它】
   * 中位数看的是典型情况，1% low 看的是最差情况。
   * 玩家说"卡"通常是因为后者——
   * 平均 60 帧但每秒掉一次到 15 帧，体感依然很差。
   * 只看中位数会得出"性能没问题"的错误结论。
   */
  get lowFps1Percent(): number {
    if (this._count === 0) return 0;
    // 帧时间最大的 n 个 = fps 最低的 n 个 → 升序数组的末尾 n 个
    const arr = this._ascending();
    const n = Math.max(1, Math.floor(arr.length * 0.01));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[arr.length - 1 - i]!;
    return sum > 0 ? (1000 * n) / sum : 0;
  }

  get settled(): boolean {
    return this._count >= this._window;
  }

  reset(): void {
    this._count = 0;
    this._idx = 0;
    this._sorted = null;
  }
}
