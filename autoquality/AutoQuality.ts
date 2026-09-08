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

  private _level: QualityLevel;
  private readonly _byLevel = new Map<QualityLevel, QualityTier>();

  /** 帧时间环形缓冲（毫秒） */
  private readonly _samples: number[] = [];
  private _sampleIdx = 0;
  private _sampleCount = 0;

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

    this._samples = new Array(this._window).fill(16.7);
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
    this._samples[this._sampleIdx] = dtMs;
    this._sampleIdx = (this._sampleIdx + 1) % this._window;
    if (this._sampleCount < this._window) this._sampleCount++;

    if (this._sampleCount < this._window) return;

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
    this._sampleCount = 0;
    this._sampleIdx = 0;
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
    this._history.push({
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
    this._history.push({
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
    if (this._sampleCount === 0) return 60;
    const arr = [...this._samples.slice(0, this._sampleCount)].sort((a, b) => a - b);
    const mid = arr.length >> 1;
    const med = arr.length % 2 === 1
      ? arr[mid]!
      : (arr[mid - 1]! + arr[mid]!) / 2;
    return med > 0 ? 1000 / med : 0;
  }

  /** 平均 fps（仅作参考/诊断用，不参与决策） */
  get averageFps(): number {
    if (this._sampleCount === 0) return 60;
    let sum = 0;
    for (let i = 0; i < this._sampleCount; i++) sum += this._samples[i]!;
    return sum > 0 ? (1000 * this._sampleCount) / sum : 0;
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
    if (this._sampleCount === 0) return 60;
    const arr = [...this._samples.slice(0, this._sampleCount)].sort((a, b) => b - a);
    const n = Math.max(1, Math.floor(arr.length * 0.01));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[i]!;
    return sum > 0 ? (1000 * n) / sum : 0;
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
    this._level = level;
    this._locked = true;
    this._enterCooldown();
    this._history.push({
      from: this._level, to: level, at: this._now, fps: this.medianFps,
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
    return {
      level: this._level,
      tierName: this.tier.name,
      fps: this.medianFps,
      fpsValid: this._sampleCount >= this._window && this._cooldownLeft <= 0,
      settled: this._sampleCount >= this._window,
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

  constructor(windowSize = 60) {
    this._window = Math.max(3, windowSize);
    this._samples = new Array(this._window).fill(16.7);
  }

  tick(dtMs: number): void {
    this._samples[this._idx] = dtMs;
    this._idx = (this._idx + 1) % this._window;
    if (this._count < this._window) this._count++;
  }

  /** 中位帧率（最常用，抗离群） */
  get median(): number {
    if (this._count === 0) return 0;
    const arr = [...this._samples.slice(0, this._count)].sort((a, b) => a - b);
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
    const arr = [...this._samples.slice(0, this._count)].sort((a, b) => b - a);
    const n = Math.max(1, Math.floor(arr.length * 0.01));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[i]!;
    return sum > 0 ? (1000 * n) / sum : 0;
  }

  get settled(): boolean {
    return this._count >= this._window;
  }

  reset(): void {
    this._count = 0;
    this._idx = 0;
  }
}
