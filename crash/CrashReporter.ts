import { clampNum, numOr } from '../_core/math';
/**
 * CrashReporter —— 崩溃捕获与上报
 *
 * 【它解决什么】
 *
 * 玩家反馈「游戏闪退了」，你问「当时在做什么」，他说「忘了」。
 * 没有崩溃上报，这类问题只有一个解决路径：等它再次发生，并且刚好被你撞上。
 *
 * 本模块负责把崩溃现场打包成一份**可用的报告**：
 *
 * ```
 * 错误堆栈 + 最近 30 条日志 + 玩家操作面包屑 + 设备/版本信息 + 当前关卡
 * ```
 *
 * 【三个核心机制】
 *
 * **1. 面包屑（breadcrumb）**
 * 崩溃发生时堆栈只告诉你"哪里炸了"，不告诉你"怎么走到这的"。
 * 面包屑记录最近的操作：`进入战斗房 → 使用技能 → 拾取遗物 → 崩溃`。
 * 这一条链的价值通常超过堆栈本身。
 *
 * **2. 去重**
 * 同一个 bug 被 1000 个玩家触发，你不该收到 1000 封报告。
 * 用「错误类型 + 首个堆栈帧」做指纹，只上报首次和计数。
 *
 * **3. 采样**
 * 高频崩溃会打爆服务器。采样率让你在"数据量"和"代表性"之间取平衡。
 *
 * 【它不做什么】
 * **不做网络传输。** 传输由宿主注入（HTTP / 文件 / 本地队列）。
 * 原因和所有插件一样：一旦写死 `fetch`，这个模块就绑死在浏览器上了。
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

/**
 * 一条日志的最小结构
 *
 * 【为什么在这里重新定义，而不是 import logger 的 LogEntry】
 *
 * 本库的铁律之一是"插件之间禁止横向依赖"。
 * 如果这里 `import { LogEntry } from '../logger/Logger'`，
 * 就把 crash 和 logger 绑死了——
 * 你只想用崩溃上报，却被迫带上整个日志系统。
 *
 * 【结构化类型（duck typing）解决这个问题】
 * TypeScript 是结构类型系统：只要形状对得上就能赋值。
 * `logger.export()` 返回的 `LogEntry[]` 天然满足下面这个接口，
 * 不需要任何显式依赖。
 *
 * 代价是两处定义要同步——所以这里只声明**用到的三个字段**，
 * 字段越少，将来不同步的风险越低。
 */
export interface ILogEntryLike {
  readonly level: number;
  readonly module: string;
  readonly message: string;
  readonly time: number;
}

/**
 * 默认只收集 Warn 及以上
 *
 * 【为什么是 3】
 * 对齐 Logger 的 LogLevel 枚举（Trace=0 … Error=4），Warn=3。
 * Debug 日志量太大且很少有用，全塞进报告会淹掉真正有用的信息。
 *
 * 如果你的日志系统级别编号不同，用 `setMinLogLevel()` 调整。
 */
const DEFAULT_MIN_LOG_LEVEL = 3;


export type CrashSeverity = 'fatal' | 'error' | 'warning';

/** 一条面包屑 */
export interface Breadcrumb {
  readonly time: number;
  readonly category: string;
  readonly message: string;
  readonly level: CrashSeverity;
  /** 附加数据（会被 JSON 序列化，别塞循环引用） */
  readonly data?: Record<string, unknown>;
}

/** 崩溃报告 */
export interface CrashReport {
  /** 指纹（用于去重） */
  readonly fingerprint: string;
  readonly name: string;
  readonly message: string;
  /** 格式化后的堆栈 */
  readonly stack: string;
  readonly severity: CrashSeverity;
  readonly time: number;
  /** 该指纹已发生的次数 */
  readonly occurrences: number;
  /** 面包屑（时间正序，最后一条最接近崩溃点） */
  readonly breadcrumbs: readonly Breadcrumb[];
  /** 最近日志（由 Logger 导出，可选） */
  readonly logs: readonly ILogEntryLike[];
  /** 自定义上下文（版本号、玩家 id、当前关卡…） */
  readonly context: Readonly<Record<string, unknown>>;
  /** 会话时长（毫秒） */
  readonly sessionUptime: number;
}

/** 上报通道（宿主实现） */
export interface ICrashTransport {
  send(report: CrashReport): void | Promise<void>;
}

export interface CrashReporterOptions {
  /** 上报通道 */
  readonly transport?: ICrashTransport;
  /** 面包屑上限（默认 30） */
  readonly breadcrumbLimit?: number;
  /**
   * 采样率 0~1（默认 1 = 全量）
   * 【用途】高频崩溃打爆服务器时降到 0.1
   */
  readonly sampleRate?: number;
  /** 抑制窗口（毫秒）：同一指纹在此窗口内只上报一次（默认 60 秒） */
  readonly dedupeWindow?: number;
  /**
   * 是否捕获全局异常
   * 【注意】在 Cocos / 浏览器里会覆盖 window.onerror，
   * 接入时要确认没有其他 SDK 也在抢这个钩子
   */
  readonly autoCapture?: boolean;
  /** 上报失败时的回调（用于本地落盘重试） */
  readonly onError?: (e: unknown, report: CrashReport) => void;
  /** 生成前的最后一次修改机会（可返回 null 丢弃该报告） */
  readonly beforeSend?: (r: CrashReport) => CrashReport | null;
}

// ==================== 面包屑环 ====================

class BreadcrumbRing {
  private readonly _items: Breadcrumb[] = [];

  constructor(private readonly _limit: number) {}

  push(b: Breadcrumb): void {
    this._items.push(b);
    // ⚠️ shift 是 O(n)，但 limit 默认 30 且面包屑不频繁
    if (this._items.length > this._limit) this._items.shift();
  }

  /** 返回副本（防止外部修改内部状态） */
  snapshot(): Breadcrumb[] {
    return this._items.slice();
  }

  clear(): void {
    this._items.length = 0;
  }

  get size(): number {
    return this._items.length;
  }
}

// ==================== 实现 ====================

export class CrashReporter {
  private readonly _ring: BreadcrumbRing;
  private readonly _transport?: ICrashTransport;
  private readonly _sampleRate: number;
  private readonly _dedupeWindow: number;
  private readonly _onError?: (e: unknown, r: CrashReport) => void;
  private readonly _beforeSend?: (r: CrashReport) => CrashReport | null;

  /** 指纹 → { 次数, 上次上报时间 } */
  private readonly _seen = new Map<string, { count: number; lastSent: number }>();

  private _context: Record<string, unknown> = {};
  private _startTime = Date.now();
  private _logSource?: () => ILogEntryLike[];
  private _minLogLevel = DEFAULT_MIN_LOG_LEVEL;
  private _installed = false;
  private _prevHandler: unknown = null;
  /**
   * `unhandledrejection` 的监听器引用
   *
   * 【⚠️ 必须保存引用，否则 uninstall 无法移除它】
   * 原实现注册的是**匿名箭头函数**，引用没保存，
   * `uninstall()` 里 `removeEventListener` **完全没被调用**。
   *
   * 后果：
   * 1. 卸载后监听器仍挂在全局，继续给一个"已关闭"的 reporter 上报；
   *    `this` 被闭包持有 → reporter 及其 `_ring` / `_seen` / `_context` 全部无法回收
   * 2. `install → uninstall → install` 每循环一次**叠加**一个监听器，
   *    重复上报、重复采样
   * 3. 热更新 / 场景切换时销毁旧 reporter 建新的，旧的永远活着
   *
   * 这是铁律 5「可卸载」的直接违反，且是最难查的那种泄漏——
   * 对象看似被释放，实际被全局事件总线吊着。
   */
  private _rejectionHandler: ((e: unknown) => void) | null = null;

  constructor(opts: CrashReporterOptions = {}) {
    this._ring = new BreadcrumbRing(clampNum(opts.breadcrumbLimit, 1, 1e6, 30));
    this._transport = opts.transport;
    this._sampleRate = clamp01(opts.sampleRate ?? 1);
    this._dedupeWindow = Math.max(0, numOr(opts.dedupeWindow, 60000));
    this._onError = opts.onError;
    this._beforeSend = opts.beforeSend;

    if (opts.autoCapture) this.install();
  }

  // ==================== 上下文 ====================

  setContext(ctx: Record<string, unknown>): void {
    this._context = { ...this._context, ...ctx };
  }

  setContextValue(key: string, value: unknown): void {
    this._context[key] = value;
  }

  removeContextValue(key: string): void {
    delete this._context[key];
  }

  get context(): Readonly<Record<string, unknown>> {
    return this._context;
  }

  /**
   * 绑定日志源（通常是 `logger.export()`）
   *
   * 【为什么要外部注入而不是直接持有 Logger】
   * 直接持有会造成 `crash → logger` 的横向依赖，
   * 违反本库的铁律。注入一个函数即可，零耦合。
   *
   * 配合结构化类型 `ILogEntryLike`，连类型都不用 import。
   */
  bindLogSource(fn: () => ILogEntryLike[]): void {
    this._logSource = fn;
  }

  /** 设置收集日志的最低级别（默认 Warn） */
  setMinLogLevel(level: number): void {
    this._minLogLevel = level;
  }

  // ==================== 面包屑 ====================

  leave(category: string, message: string, level: CrashSeverity = 'warning', data?: Record<string, unknown>): void {
    this._ring.push({ time: Date.now(), category, message, level, ...(data ? { data } : {}) });
  }

  /** 只保留等级不低于指定值的日志（减少噪音） */
  get breadcrumbs(): Breadcrumb[] {
    return this._ring.snapshot();
  }

  get breadcrumbCount(): number {
    return this._ring.size;
  }

  clearBreadcrumbs(): void {
    this._ring.clear();
  }

  // ==================== 上报 ====================

  /**
   * 上报一个错误
   *
   * @returns 是否实际发送了（false = 被去重/采样/过滤拦下）
   */
  capture(error: unknown, severity: CrashSeverity = 'error'): boolean {
    const normalized = normalize(error);
    const fingerprint = makeFingerprint(normalized);

    const now = Date.now();
    const rec = this._seen.get(fingerprint);
    const count = (rec?.count ?? 0) + 1;

    /**
     * 【去重逻辑】
     * 首次必报；之后在 dedupeWindow 内只累加计数，不再发送。
     *
     * 【为什么窗口内也要累加】
     * 服务端需要知道"这个 bug 影响多少人"，
     * 所以窗口过期后的下一次上报会带上累计次数。
     *
     * 【⚠️ 曾经的 bug：首次上报时 lastSent 存了 0】
     * 原写法用 `rec?.lastSent ?? 0` 初始化，而首次 `rec` 是 undefined，
     * 于是 lastSent 记为 0。第二次进来时 `now - 0` 是个天文数字，
     * 永远大于窗口 → **去重完全失效**，同一个 bug 会每帧上报一次。
     *
     * 判据：首次上报也必须把 lastSent 设为 now，
     * 因为"首次上报"本身就是一次发送，窗口要从这一刻开始算。
     */
    if (rec && this._dedupeWindow > 0 && now - rec.lastSent < this._dedupeWindow) {
      // 窗口内：累加计数，保留原窗口起点
      this._seen.set(fingerprint, { count, lastSent: rec.lastSent });
      return false;
    }

    // 首次，或窗口已过：上报，并把窗口起点重置为现在
    this._seen.set(fingerprint, { count, lastSent: now });

    // 采样（只对非致命错误采样；崩溃永远上报）
    if (severity !== 'fatal' && this._sampleRate < 1) {
      if (Math.random() > this._sampleRate) return false;
    }

    let report: CrashReport = {
      fingerprint,
      name: normalized.name,
      message: normalized.message,
      stack: normalized.stack,
      severity,
      time: now,
      occurrences: count,
      breadcrumbs: this._ring.snapshot(),
      logs: this._collectLogs(),
      context: { ...this._context },
      sessionUptime: now - this._startTime,
    };

    if (this._beforeSend) {
      const filtered = this._beforeSend(report);
      if (filtered === null) return false;
      report = filtered;
    }

    if (!this._transport) {
      // 没有通道时至少打印出来，避免"静默吞掉"
      console.error('[CrashReporter] 未配置 transport，报告内容：', reportText(report));
      return false;
    }

    try {
      const r = this._transport.send(report);
      // 【异步通道的错误必须捕获】
      // Promise rejection 不会被下面的 catch 接住，
      // 会变成 unhandledrejection，在某些环境直接导致二次崩溃
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((e) => this._onError?.(e, report));
      }
      return true;
    } catch (e) {
      this._onError?.(e, report);
      return false;
    }
  }

  /** 手动上报一条消息（没有 Error 对象的场景） */
  captureMessage(message: string, severity: CrashSeverity = 'error'): boolean {
    return this.capture(new Error(message), severity);
  }

  // ==================== 全局捕获 ====================

  /**
   * 安装全局异常钩子
   *
   * 【⚠️ 会覆盖已有的 handler】
   * 如果项目里已经有别的崩溃 SDK，后安装的会覆盖先安装的。
   * 本实现保存了旧 handler 并在处理后调用它，形成链条。
   */
  install(): void {
    if (this._installed) return;
    if (typeof globalThis === 'undefined') return;

    const g = globalThis as unknown as {
      onerror?: unknown;
      addEventListener?: (t: string, f: (e: unknown) => void) => void;
      removeEventListener?: (t: string, f: (e: unknown) => void) => void;
    };

    // 浏览器 / 小游戏环境
    this._prevHandler = g.onerror ?? null;
    const self = this;
    g.onerror = function (msg: unknown, src?: unknown, line?: unknown, col?: unknown, err?: unknown) {
      self.capture(err ?? new Error(String(msg)), 'fatal');
      const prev = self._prevHandler;
      if (typeof prev === 'function') {
        return (prev as (...a: unknown[]) => unknown).call(this, msg, src, line, col, err);
      }
      return false;
    };

    // Promise 未捕获异常
    if (typeof g.addEventListener === 'function') {
      /**
       * 【为什么先移除再注册】
       * 极端情况下 install 可能被连续调用（`_installed` 守卫之外的路径），
       * 先移除能避免叠加。正常路径下此时 `_rejectionHandler` 为 null，无副作用。
       */
      const prev = this._rejectionHandler;
      if (prev && typeof g.removeEventListener === 'function') {
        g.removeEventListener('unhandledrejection', prev);
        this._rejectionHandler = null;
      }
      const handler = (e: unknown): void => {
        const reason = (e as { reason?: unknown }).reason;
        this.capture(reason ?? new Error('unhandledrejection'), 'fatal');
      };
      this._rejectionHandler = handler;
      g.addEventListener('unhandledrejection', handler);
    }

    this._installed = true;
  }

  /** 卸载（恢复原 handler） */
  uninstall(): void {
    if (!this._installed) return;
    if (typeof globalThis === 'undefined') return;
    const g = globalThis as unknown as {
      onerror?: unknown;
      removeEventListener?: (t: string, f: (e: unknown) => void) => void;
    };

    /**
     * 【⚠️ 必须移除 unhandledrejection，不能只恢复 onerror】
     * 原实现只做了 `g.onerror = this._prevHandler` 一件事，
     * 监听器被永久留在全局。详见 `_rejectionHandler` 的注释。
     */
    if (typeof g.removeEventListener === 'function' && this._rejectionHandler) {
      g.removeEventListener('unhandledrejection', this._rejectionHandler);
    }
    this._rejectionHandler = null;

    g.onerror = this._prevHandler as never;
    this._prevHandler = null;
    this._installed = false;
  }

  get installed(): boolean {
    return this._installed;
  }

  // ==================== 诊断 ====================

  /** 已记录的指纹统计（调试用） */
  stats(): Array<{ fingerprint: string; count: number }> {
    return [...this._seen.entries()]
      .map(([fingerprint, v]) => ({ fingerprint, count: v.count }))
      .sort((a, b) => b.count - a.count);
  }

  reset(): void {
    this._seen.clear();
    this._ring.clear();
    this._startTime = Date.now();
  }

  private _collectLogs(): ILogEntryLike[] {
    if (!this._logSource) return [];
    try {
      // 【只取 Warn 及以上】Debug 日志量太大，且很少有用
      return this._logSource().filter((e) => e.level >= this._minLogLevel).slice(-20);
    } catch {
      // 日志源自己崩了不能影响上报
      return [];
    }
  }
}

// ==================== 工具 ====================

interface NormalizedError {
  name: string;
  message: string;
  stack: string;
}

function normalize(e: unknown): NormalizedError {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack ?? '' };
  }
  if (typeof e === 'string') {
    return { name: 'StringError', message: e, stack: '' };
  }
  // 可能是 { message, stack } 形状的跨 realm 对象
  if (e && typeof e === 'object') {
    const o = e as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof o.name === 'string' ? o.name : 'UnknownError',
      message: typeof o.message === 'string' ? o.message : safeStringify(e),
      stack: typeof o.stack === 'string' ? o.stack : '',
    };
  }
  return { name: 'UnknownError', message: String(e), stack: '' };
}

/**
 * 指纹：错误类型 + 首个堆栈帧
 *
 * 【为什么取第一帧而不是整个堆栈】
 * 整个堆栈在不同设备上行号可能不同（不同构建、不同引擎版本），
 * 会导致同一个 bug 产生几十个指纹，去重失效。
 *
 * 第一帧（出错的那个函数）通常稳定得多。
 *
 * 【⚠️ 曾经的 bug：无堆栈的错误全部坍缩成一个指纹】
 *
 * `new Error('A')` 和 `new Error('B')` 如果都没有 stack
 * （跨 realm 对象、被序列化过、或某些小游戏环境），
 * 指纹都会变成 `"Error:"` ——
 * 于是**第二个错误被去重逻辑吞掉，永远不上报**。
 *
 * 这类"上报系统自己把报告丢了"的问题极难发现：
 * 你看到第一个 bug，修完以为没事了，
 * 其实另一个完全不同的 bug 一直没进你的视野。
 *
 * 【兜底策略】没有堆栈时退化为"类型 + 规范化消息"：
 * 消息里的数字要抹掉，否则
 * `player 123 not found` / `player 456 not found`
 * 会产生无数指纹，去重同样失效。
 */
export function makeFingerprint(e: NormalizedError): string {
  const firstFrame = extractFirstFrame(e.stack);
  if (firstFrame !== null) return `${e.name}:${firstFrame}`;
  return `${e.name}:${normalizeMessage(e.message)}`;
}

/**
 * 消息规范化：抹掉数字与长十六进制，避免同模板消息炸出多个指纹
 */
export function normalizeMessage(msg: string): string {
  return msg
    .replace(/\d+/g, '#')          // 123 → #
    .replace(/0x[0-9a-fA-F]+/g, '#') // 0x1F → #
    .replace(/[0-9a-f]{8,}/g, '#')   // 长十六进制（如 hash）→ #
    .slice(0, 80);
}

/**
 * 提取首个堆栈帧
 *
 * 【⚠️ 曾经的 bug：把错误标题行当成了堆栈帧】
 *
 * Node 的堆栈第一行是 `TypeError: Cannot read properties...`，
 * 而不是 `at ...`。原实现只跳过以 'Error' 开头的行，
 * 于是 'TypeError' 这种子类**跳不过去**，
 * 指纹变成了 `TypeError:TypeError: Cannot read properties...`。
 *
 * 后果不只是难看——错误标题里常含动态内容
 * （"Cannot read properties of undefined"、"player 123 not found"），
 * 会让同一个 bug 产生大量不同指纹，去重失效。
 *
 * 【正确做法】只认真正的帧格式：
 * - V8:      `at Foo.bar (file:1:2)` 或 `at file:1:2`
 * - Safari:  `Foo.bar@file:1:2`
 *
 * 两轮扫描：先找 `at ` 形式，找不到再退回 `@` 形式。
 * 都找不到时返回 null，由调用方退化为消息指纹。
 */
function extractFirstFrame(stack: string): string | null {
  if (!stack) return null;
  const lines = stack.split('\n');

  // 第一轮：V8 的 `at ...`
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('at ')) continue;
    const cleaned = cleanFrame(t.slice(3));
    if (cleaned !== '') return cleaned;
  }

  // 第二轮：Safari / 旧引擎的 `func@file:line:col`
  for (const line of lines) {
    const t = line.trim();
    if (t === '' || t.startsWith('at ') || !t.includes('@')) continue;
    const cleaned = cleanFrame(t);
    if (cleaned !== '') return cleaned;
  }

  return null;
}

/**
 * 归一化一个帧文本
 *
 * 抹掉三类不稳定信息：
 * 1. 行号列号 —— 每次构建都可能变
 * 2. 文件目录 —— dev 与 release 的路径不同，只留文件名
 * 3. 过长内容 —— 指纹要短，便于日志查看
 */
function cleanFrame(t: string): string {
  let s = t.trim();
  if (s === '') return '';

  /**
   * `(/a/b/c.js:12:34)` → `(c.js)`
   *
   * 【⚠️ 曾经的 bug：只做了 basename，没去掉行号】
   *
   * 原实现把 `(game.js:343:15)` 变成 `(game.js:343:15)`——
   * 行号原封不动留了下来。
   *
   * 后果和"用整个堆栈做指纹"一样：
   * 第 343 行在改一次代码后可能变成 351，
   * 于是同一个 bug 被当成两个，去重失效。
   *
   * 实测输出里看到 `TypeError:bossPhaseTwo (batch10-usage.js:343:15)`
   * 才发现——**必须把行号也抹掉**。
   */
  s = s.replace(/\(([^()]*)\)/, (_m, inner: string) => {
    let file = String(inner).split(/[\\/]/).pop() ?? inner;
    file = file.replace(/:\d+(:\d+)?$/, '');   // 去行号列号
    return `(${file})`;
  });

  // 尾部 `:12:34` 或 `:12`（无括号形式）
  s = s.replace(/:\d+(:\d+)?$/, '');

  // `Foo.bar@file.js:12:34` → `Foo.bar@file.js`
  s = s.replace(/@([^@\s]*?):\d+(:\d+)?$/, '@$1');

  return s.slice(0, 120);
}

/**
 * 安全的 JSON 序列化
 *
 * 【为什么需要】
 * 崩溃上报本身抛异常是最糟的情况——
 * 玩家看到闪退，你却什么都收不到，因为上报代码先崩了。
 *
 * 循环引用是这里最常见的杀手（对象互相持有）。
 */
export function safeStringify(v: unknown, maxLen = 500): string {
  const seen = new WeakSet<object>();
  try {
    const s = JSON.stringify(v, (_k, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'function') return '[Function]';
      if (typeof val === 'bigint') return String(val) + 'n';
      return val;
    });
    if (s === undefined) return String(v);
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
  } catch {
    return String(v);
  }
}

/** 报告转纯文本（日志 / 本地落盘用） */
export function reportText(r: CrashReport): string {
  const lines: string[] = [
    `═══ ${r.severity.toUpperCase()} ═══ ${new Date(r.time).toISOString()}`,
    `${r.name}: ${r.message}`,
    `指纹 ${r.fingerprint}（第 ${r.occurrences} 次）`,
    `会话时长 ${(r.sessionUptime / 1000).toFixed(1)}s`,
  ];

  if (Object.keys(r.context).length > 0) {
    lines.push('', '── 上下文 ──');
    for (const [k, v] of Object.entries(r.context)) {
      lines.push(`  ${k}: ${safeStringify(v)}`);
    }
  }

  if (r.breadcrumbs.length > 0) {
    lines.push('', '── 操作轨迹 ──');
    for (const b of r.breadcrumbs) {
      lines.push(`  [${b.category}] ${b.message}`);
    }
  }

  if (r.stack) {
    lines.push('', '── 堆栈 ──', r.stack);
  }

  if (r.logs.length > 0) {
    lines.push('', `── 最近日志（${r.logs.length}）──`);
    for (const e of r.logs) {
      lines.push(`  ${new Date(e.time).toISOString()} [${e.module}] ${e.message}`);
    }
  }

  return lines.join('\n');
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
