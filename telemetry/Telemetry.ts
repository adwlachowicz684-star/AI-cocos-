import { clampNum } from '../_core/math';
import { hasOwn } from '../_core/guard';
/**
 * telemetry/Telemetry.ts —— 埋点上报
 *
 * 【它解决什么】
 *
 * 游戏上线后你要知道：玩家卡在第几关？哪个遗物从没人选？
 * 这些数据只能靠埋点。
 *
 * 手写的做法是每次 `fetch('/track', ...)`。问题是：
 *
 * - 一局游戏几百个事件，每个都发一次请求 → 流量和电量爆炸
 * - 网络失败就丢了 → 数据不准
 * - 采样用 `Math.random()` → 同一个会话里"关卡开始"上报了、"关卡结束"没上报
 *
 * 本模块把这三件事做对：
 *
 * ```typescript
 * const t = new Telemetry({ sender, batchSize: 20, flushIntervalMs: 5000 });
 * t.capture('level_start', { level: 3 });   // 进缓冲
 * t.capture('level_end', { level: 3 });     // 进缓冲
 * // 攒够 20 条或每 5 秒，自动发一次
 * ```
 *
 * 【⚠️ 最重要的一条：采样必须在会话内确定性】
 *
 * 朴素的 `Math.random() < 0.1` 会导致数据里出现大量
 * "有 level_start 但没有 level_end" 的关卡——
 * 你永远算不出通关率。
 *
 * 正确做法：用 sessionId 哈希决策，同一会话内结果恒定。
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

export interface TelemetryEvent {
  /** 事件名 */
  readonly name: string;
  /** 属性（已合并通用属性） */
  readonly props: Readonly<Record<string, unknown>>;
  /** 会话内递增序号 */
  readonly seq: number;
  /** 时间戳（毫秒） */
  readonly ts: number;
  readonly sessionId: string;
}

export type TelemetrySender = (
  batch: readonly TelemetryEvent[]
) => Promise<boolean> | boolean;

export interface TelemetryOptions {
  readonly sender?: TelemetrySender;
  /** 攒够这么多条就发 */
  readonly batchSize?: number;
  /** 距上次发送超过这么久就发 */
  readonly flushIntervalMs?: number;
  /** 每条事件都带的属性 */
  readonly commonProps?: Readonly<Record<string, unknown>>;
  /** 全局采样率 0~1 */
  readonly sampleRate?: number;
  /** 按事件名覆盖采样率 */
  readonly eventSampleRates?: Readonly<Record<string, number>>;
  /** 发送失败重试次数（超过则丢弃） */
  readonly maxRetries?: number;
  /** 缓冲区上限（超出丢弃最旧的） */
  readonly maxBuffer?: number;
  readonly sessionId?: string;
}

export interface TelemetryStats {
  captured: number;
  sent: number;
  failed: number;
  dropped: number;
}

// ==================== 工具 ====================

/**
 * 字符串哈希到 [0, 1)
 *
 * 【要求】
 * 1. 确定性：同样的输入永远同样的输出（采样才能一致）
 * 2. 分布均匀：采样率 50% 时真的约一半被选中
 *
 * 用 FNV-1a 变体，32 位。
 */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 乘 16777619，用移位避免溢出为负
    h = Math.imul(h, 16777619);
  }
  // 转无符号再归一
  return (h >>> 0) / 4294967296;
}

// ==================== 实现 ====================

const DEFAULTS = {
  batchSize: 20,
  flushIntervalMs: 5000,
  sampleRate: 1,
  maxRetries: 3,
  maxBuffer: 200,
};

export class Telemetry {
  private readonly _sender?: TelemetrySender;
  private readonly _batchSize: number;
  private readonly _flushIntervalMs: number;
  private readonly _commonProps: Readonly<Record<string, unknown>>;
  private readonly _sampleRate: number;
  private readonly _eventSampleRates: Readonly<Record<string, number>>;
  private readonly _maxRetries: number;
  private readonly _maxBuffer: number;

  private _buffer: TelemetryEvent[] = [];
  private _sessionId: string;
  private _seq = 0;
  private _lastFlushAt = 0;
  private _flushing = false;
  private _retries = 0;
  private _enabled = true;
  private _now: () => number = () => Date.now();

  private readonly _stats: TelemetryStats = {
    captured: 0,
    sent: 0,
    failed: 0,
    dropped: 0,
  };

  constructor(opts: TelemetryOptions = {}) {
    this._sender = opts.sender;
    this._batchSize = clampNum(opts.batchSize, 1, 1e6, DEFAULTS.batchSize);
    this._flushIntervalMs = opts.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this._commonProps = opts.commonProps ?? {};
    this._sampleRate = clamp01(opts.sampleRate ?? DEFAULTS.sampleRate);
    this._eventSampleRates = opts.eventSampleRates ?? {};
    /**
     * 【⚠️ 必须用 clampNum 而不是 `??`】
     *
     * `??` 只挡 null/undefined，**挡不住 NaN**。
     * `maxRetries` 为 NaN 时，判断重试的地方 `this._retries <= this._maxRetries`
     * 变成 `0 <= NaN` → 恒为 false → **第一次发送失败就永久丢数据**。
     *
     * 这与 JSDoc 的承诺（"发送失败重试次数（超过则丢弃）"）正好相反：
     * 配成 NaN 后重试机制彻底失效，且因为"看起来配置过了"而极难发现。
     *
     * 上界 100 是防"配成极大值导致失败后无限重试、请求打满"。
     */
    this._maxRetries = clampNum(opts.maxRetries, 0, 100, DEFAULTS.maxRetries);
    this._maxBuffer = clampNum(opts.maxBuffer, 1, 1e7, DEFAULTS.maxBuffer);
    this._sessionId = opts.sessionId ?? randomId();
    this._lastFlushAt = this._now();
  }

  /** 注入时间源（测试必需） */
  useClock(fn: () => number): void {
    this._now = fn;
    this._lastFlushAt = fn();
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    this._enabled = v;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get buffered(): number {
    return this._buffer.length;
  }

  get stats(): Readonly<TelemetryStats> {
    return { ...this._stats };
  }

  // ==================== 采样 ====================

  /**
   * 这个事件是否会被采集
   *
   * 【⚠️ 会话内确定性】
   * 用 `${sessionId}:${name}` 做哈希键，
   * 同一会话内对同一事件的决策永远一致。
   */
  willSample(name: string): boolean {
    /**
     * 【⚠️ 采样率表必须只认自有属性】
     *
     * `this._eventSampleRates[name]` 直接下标会命中原型链。实测：
     * ```js
     * new Telemetry({ eventSampleRates: {} }).willSample('toString')
     * // rate = Object.prototype.toString（一个函数）
     * // 于是 hash < function → NaN 比较恒 false → 事件被永久丢弃
     * ```
     * 后果是"某个事件名永远不上报"，且因为采样本来就是概率性的，
     * 现象看起来和正常采样完全一样——几乎不可能被怀疑是 bug。
     *
     * 事件名虽然通常来自代码常量，但也可能来自配置表或埋点平台下发，
     * 属于外部输入，必须守。用 `hasOwn` 挡一层后未命中即回退全局采样率。
     */
    const rate = hasOwn(this._eventSampleRates, name)
      ? this._eventSampleRates[name]
      : this._sampleRate;
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return hashString(`${this._sessionId}:${name}`) < rate;
  }

  // ==================== 采集 ====================

  capture(name: string, props: Readonly<Record<string, unknown>> = {}): boolean {
    if (!this._enabled) return false;
    if (!name || name.trim() === '') {
      throw new Error('[Telemetry] 事件名不能为空');
    }
    if (!this.willSample(name)) return false;

    const evt: TelemetryEvent = {
      name,
      // 事件属性覆盖通用属性
      props: { ...this._commonProps, ...props },
      seq: this._seq++,
      ts: this._now(),
      sessionId: this._sessionId,
    };

    /**
     * 【为什么丢弃最旧的而不是最新的】
     * 埋点数据里，最近的行为更有价值
     * （玩家是在哪一关退出的，比他一开局做了什么重要）。
     */
    if (this._buffer.length >= this._maxBuffer) {
      this._buffer.shift();
      this._stats.dropped++;
    }

    this._buffer.push(evt);
    this._stats.captured++;

    if (this._buffer.length >= this._batchSize) {
      // 不 await：采集路径不该被网络阻塞
      void this.flush();
    }
    return true;
  }

  // ==================== 发送 ====================

  /** 是否到了该发送的时候（按时间间隔） */
  shouldFlush(): boolean {
    if (this._buffer.length === 0) return false;
    if (this._now() - this._lastFlushAt < this._flushIntervalMs) return false;
    return true;
  }

  /**
   * 发送缓冲
   *
   * 【⚠️ 重入保护】
   * 多个 flush 并发时会重复发送同一批数据。
   * 用 _flushing 标记挡住。
   */
  async flush(): Promise<boolean> {
    if (this._flushing) return true;
    if (this._buffer.length === 0) return true;

    // 没有 sender：直接清空，避免无限堆积
    if (!this._sender) {
      this._buffer = [];
      return true;
    }

    this._flushing = true;
    const batch = this._buffer;
    this._buffer = [];
    this._lastFlushAt = this._now();

    try {
      await this._sender(batch);
      this._stats.sent += batch.length;
      this._retries = 0;
      return true;
    } catch {
      /**
       * 【⚠️ 失败要放回队首，而不是丢弃】
       * 丢一次就是数据缺口。
       * 但也不能无限重试——超过上限就真的丢，防止内存无限涨。
       */
      this._retries++;
      this._stats.failed++;

      if (this._retries <= this._maxRetries) {
        this._buffer = [...batch, ...this._buffer];
      }
      return false;
    } finally {
      this._flushing = false;
    }
  }

  /** 开启新会话（序号归零） */
  newSession(id?: string): void {
    this._sessionId = id ?? randomId();
    this._seq = 0;
  }

  clear(): void {
    this._buffer = [];
  }

  /** 页面关闭前调用：尽力发一次 */
  async flushSync(): Promise<void> {
    await this.flush();
  }
}

// ==================== 内部 ====================

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
