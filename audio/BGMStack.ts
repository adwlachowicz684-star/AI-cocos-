/**
 * audio/BGMStack.ts —— 分层背景音乐（水平重混）
 *
 * 【它解决什么】
 *
 * 背景音乐最朴素的写法是"切歌"：
 * 探索时放 A，遇敌时淡出 A、淡入 B。
 *
 * 问题有两个：
 *
 * 1. **切换点突兀**
 *    玩家进入战斗的瞬间，音乐从"平静"跳到"紧张"，
 *    而战斗其实才刚开始——音乐比画面早了三秒，很出戏。
 *
 * 2. **音乐与玩法脱节**
 *    Boss 血线降到 30% 时该更紧张，但你只有"探索曲"和"战斗曲"两首，
 *    做不出层次。
 *
 * 分层音乐（horizontal re-mixing）的解法是：
 *
 * > 一首曲子拆成若干**层**（鼓 / 贝斯 / 和声 / 旋律 / 紧张音效），
 * > 所有层**同步播放、同一 BPM、同一时间轴**，
 * > 根据游戏状态决定每层该多响。
 *
 * 这样"进入战斗"不是换歌，而是"贝斯层淡入 + 旋律层变强"，
 * 音乐**没有中断**，只是密度变了。
 *
 * 【零业务依赖】
 * 层名和状态名都是字符串，由调用方定义。
 * 它不知道什么是"战斗"，只知道"状态 A 下这些层的目标音量是这些"。
 */

import { clamp, numOr } from '../_core/math';

// ==================== 类型 ====================

export type LayerName = string;
export type StateName = string;

/** 一层的配置 */
export interface BgmLayerConfig {
  readonly name: LayerName;
  /**
   * 该层的基准音量（默认 1）
   *
   * 【用途】
   * 鼓层通常是主体（1.0），旋律层略低（0.7），
   * 紧张音效层更低（0.4）——它在需要时才被推上来。
   */
  readonly baseVolume?: number;
  /**
   * 总是播放（默认 true）
   *
   * false 的话，该层只在目标音量 > 0 时才播放。
   * 适合"只在 Boss 战出现的合唱层"这类稀有层。
   */
  readonly alwaysOn?: boolean;
}

/** 一个状态下各层的目标音量（0~1） */
export type StateMix = Readonly<Record<LayerName, number>>;

export interface BgmStackConfig {
  /** 层定义 */
  readonly layers: readonly BgmLayerConfig[];
  /** 状态 → 层混音 */
  readonly states: Readonly<Record<StateName, StateMix>>;
  /** 初始状态 */
  readonly initialState: StateName;
  /**
   * 状态切换的过渡时长（毫秒，默认 800）
   *
   * 【怎么选】
   * 战斗切换 300~600（要跟手），探索切换 1500~3000（要自然）。
   */
  readonly transitionMs?: number;
  /** 主音量（默认 1） */
  readonly volume?: number;
  /**
   * 交叉淡变曲线（默认 'equal-power'）
   *
   * - `'linear'`：线性。总音量会在过渡中间**凹陷**
   * - `'equal-power'`：等功率。总音量保持恒定
   *
   * 【⚠️ 默认必须是 equal-power】
   * 两个层各 0.5 音量，线性叠加听起来不等于一个层 1.0——
   * 能量是振幅的平方，0.5² + 0.5² = 0.5，实际只有 70% 响度。
   * 中间会明显"变轻一下"，这在音乐上是很廉价的听感。
   */
  readonly curve?: 'linear' | 'equal-power';
}

/** 层的运行时状态 */
export interface LayerState {
  readonly name: LayerName;
  /** 当前音量（过渡中的插值结果） */
  current: number;
  /** 目标音量 */
  target: number;
  /** 过渡起点音量 */
  from: number;
  /** 是否在播（音量趋近 0 且非 alwaysOn 时会停止） */
  playing: boolean;
}

// ==================== 实现 ====================

/**
 * 计算某层在过渡进度 t 时的音量
 *
 * 【为什么不能在"插值系数"上做等功率】
 *
 * 直觉做法是给插值系数 k 加一条曲线，然后
 * `current = from + (to - from) * k`。
 * 但 fade-out 层需要 k = 1 - cos θ，fade-in 层需要 k = sin θ——
 * **两者的 k 不一样**，单个 k 无法同时满足。
 *
 * 正确做法是在**功率域**插值：
 *
 * ```
 * amplitude = √(from²·cos²θ + to²·sin²θ)
 * ```
 *
 * 验证三种情况（θ = t·π/2）：
 * - from=1, to=0 → √(cos²θ) = cos θ      ← 标准 fade-out
 * - from=0, to=1 → √(sin²θ) = sin θ      ← 标准 fade-in
 * - from=0.5, to=0.5 → √(0.25) = 0.5     ← 不变的层保持恒定 ✓
 *
 * 最后一条是关键：如果直接在系数上做曲线，
 * 一个"两层都保持 0.8"的过渡会让音量在中间涨到 1.13，
 * 然后再落回 0.8——听起来像音量被推了一下。
 *
 * 总能量：Σ amplitude² = cos²θ·Σfrom² + sin²θ·Σto²。
 * 只要新旧混音的总能量相同（常见情况），过渡中能量恒定。
 */
function crossfadeVolume(
  from: number,
  to: number,
  t: number,
  curve: 'linear' | 'equal-power'
): number {
  if (curve === 'linear') return from + (to - from) * t;
  const theta = t * Math.PI * 0.5;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const p = from * from * c * c + to * to * s * s;
  return p > 0 ? Math.sqrt(p) : 0;
}

export class BgmStack {
  private readonly _layerCfgs: readonly BgmLayerConfig[];
  private readonly _states: Readonly<Record<StateName, StateMix>>;
  private readonly _transitionMs: number;
  private readonly _curve: 'linear' | 'equal-power';
  private _volume: number;

  private readonly _layers = new Map<LayerName, LayerState>();
  private _state: StateName;
  private _prevState: StateName | null = null;
  /** 过渡已进行的时长 */
  private _elapsed = 0;
  /** 是否正在过渡 */
  private _inTransition = false;

  constructor(cfg: BgmStackConfig) {
    if (cfg.layers.length === 0) {
      throw new Error('[BgmStack] 至少要有一层');
    }
    if (!(cfg.initialState in cfg.states)) {
      throw new Error(`[BgmStack] 初始状态 "${cfg.initialState}" 不在 states 里`);
    }

    this._layerCfgs = cfg.layers;
    this._states = cfg.states;
    this._transitionMs = Math.max(1, numOr(cfg.transitionMs, 800));
    this._curve = cfg.curve ?? 'equal-power';
    this._volume = clamp(cfg.volume ?? 1, 0, 1);
    this._state = cfg.initialState;

    const mix = this._mixOf(cfg.initialState);
    for (const lc of cfg.layers) {
      const v = clamp((mix[lc.name] ?? 0) * (lc.baseVolume ?? 1), 0, 1);
      this._layers.set(lc.name, {
        name: lc.name,
        current: v,
        target: v,
        from: v,
        playing: v > 0 || (lc.alwaysOn ?? true),
      });
    }
  }

  // ==================== 状态切换 ====================

  /**
   * 切换到新状态
   *
   * @returns 是否真的切换了（同状态重复调用返回 false）
   *
   * 【⚠️ 同状态重复调用不重启过渡】
   * 否则每帧调 setState('battle') 会让过渡永远停在起点，
   * 音量卡在 0 永不上升——这是很常见的调用方式错误。
   */
  setState(next: StateName): boolean {
    if (!(next in this._states)) {
      throw new Error(`[BgmStack] 未知状态 "${next}"`);
    }
    /**
     * 【同状态一律返回 false】
     * 早期版本写成 `next === this._state && !this._inTransition`，
     * 意味着过渡途中重复设置同一状态会**重启过渡**。
     * 调用方若每帧写 `setState(currentState)`，
     * 过渡会永远停在起点，音量卡在 0。
     */
    if (next === this._state) return false;

    this._prevState = this._state;
    this._state = next;
    this._elapsed = 0;
    this._inTransition = true;

    const mix = this._mixOf(next);
    for (const lc of this._layerCfgs) {
      const ls = this._layers.get(lc.name)!;
      ls.from = ls.current;
      ls.target = clamp((mix[lc.name] ?? 0) * (lc.baseVolume ?? 1), 0, 1);
    }
    return true;
  }

  get state(): StateName {
    return this._state;
  }

  get previousState(): StateName | null {
    return this._prevState;
  }

  get inTransition(): boolean {
    return this._inTransition;
  }

  /** 过渡进度 0~1 */
  get transitionProgress(): number {
    if (!this._inTransition) return 1;
    return clamp(this._elapsed / this._transitionMs, 0, 1);
  }

  // ==================== 推进 ====================

  /**
   * 每帧推进
   *
   * @param dtMs 帧间隔（真实时间毫秒）
   *
   * 【⚠️ 用真实时间还是未缩放时间？】
   * BGM 应该用**不受游戏时间缩放影响**的时间。
   * 顿帧（timeScale=0.05）时音乐不该跟着变慢 20 倍——
   * 那会变成恐怖片音效。
   * 但暂停（timeScale=0）时，如果希望音乐继续，也要用真实时间。
   */
  update(dtMs: number): void {
    if (!this._inTransition) {
      this._syncPlaying();
      return;
    }

    this._elapsed += dtMs;
    const t = this.transitionProgress;

    for (const ls of this._layers.values()) {
      ls.current = crossfadeVolume(ls.from, ls.target, t, this._curve);
    }

    if (this._elapsed >= this._transitionMs) {
      for (const ls of this._layers.values()) ls.current = ls.target;
      this._inTransition = false;
    }
    this._syncPlaying();
  }

  /**
   * 同步 playing 标志
   *
   * 【为什么要单独维护 playing】
   * 音量趋近 0 的层如果不停，会一直占着音频通道。
   * 但也不能音量一为 0 就立刻停——
   * 过渡中途可能还要回升（状态切回去了）。
   *
   * 判据：**过渡结束且目标音量为 0** 才停。
   */
  private _syncPlaying(): void {
    for (const lc of this._layerCfgs) {
      const ls = this._layers.get(lc.name)!;
      if (this._inTransition) {
        ls.playing = true;
      } else {
        ls.playing = ls.current > 0 || (lc.alwaysOn ?? true);
      }
    }
  }

  // ==================== 查询 ====================

  /** 某层的实际音量（已乘主音量） */
  layerVolume(name: LayerName): number {
    const ls = this._layers.get(name);
    if (!ls) return 0;
    return clamp(ls.current * this._volume, 0, 1);
  }

  /** 全部层的状态（只读快照） */
  layers(): readonly LayerState[] {
    return [...this._layers.values()].map((ls) => ({ ...ls }));
  }

  /** 正在播放的层名 */
  playingLayers(): readonly LayerName[] {
    return [...this._layers.values()].filter((l) => l.playing).map((l) => l.name);
  }

  /** 静默的层名 */
  silentLayers(): readonly LayerName[] {
    return [...this._layers.values()].filter((l) => !l.playing).map((l) => l.name);
  }

  /** 总输出音量（各层平方和后开方，等功率合成） */
  get outputLevel(): number {
    let sum = 0;
    for (const ls of this._layers.values()) {
      const v = ls.current * this._volume;
      sum += v * v;
    }
    return clamp(Math.sqrt(sum), 0, 4);
  }

  // ==================== 音量 ====================

  setVolume(v: number): void {
    this._volume = clamp(v, 0, 1);
  }

  get volume(): number {
    return this._volume;
  }

  // ==================== 配置校验 ====================

  /**
   * 校验配置完整性
   *
   * 【为什么需要】
   * 分层音乐的配置是"状态 × 层"的矩阵，
   * 手抄很容易漏一格。漏了的那层会用默认值 0，
   * 表现为"某个状态下少了一层"——
   * 听感上只是"有点单薄"，但排查时会去翻音频文件而不是配置表。
   *
   * @returns 问题列表，空数组表示没问题
   */
  validate(): readonly string[] {
    const issues: string[] = [];
    const layerNames = new Set(this._layerCfgs.map((l) => l.name));

    for (const [stateName, mix] of Object.entries(this._states)) {
      for (const k of Object.keys(mix)) {
        if (!layerNames.has(k)) {
          issues.push(`状态 "${stateName}" 引用了不存在的层 "${k}"`);
        }
      }
      for (const ln of layerNames) {
        if (!(ln in mix)) {
          issues.push(`状态 "${stateName}" 缺少层 "${ln}" 的定义（将按 0 处理）`);
        }
      }
    }
    return issues;
  }

  private _mixOf(state: StateName): StateMix {
    return this._states[state] ?? {};
  }

  /**
   * 生成混音对照表（调试/配表用）
   *
   * 输出"状态 × 层"的矩阵，一眼看出哪格漏了。
   */
  describeMatrix(): string {
    const names = this._layerCfgs.map((l) => l.name);
    const w = Math.max(10, ...names.map((n) => n.length * 2)) + 2;
    const head = '状态'.padEnd(w) + names.map((n) => n.padStart(8)).join('');
    const rows = Object.keys(this._states).map((s) => {
      const mix = this._mixOf(s);
      return s.padEnd(w) + names.map((n) => String(mix[n] ?? 0).padStart(8)).join('');
    });
    return [head, ...rows].join('\n');
  }
}
