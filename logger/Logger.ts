import { clampNum } from '../_core/math';
/**
 * Logger —— 分级日志 + 环形缓冲
 *
 * 【为什么需要环形缓冲】
 * 生产环境的崩溃往往没有控制台。玩家只告诉你「游戏闪退了」，
 * 你什么线索都没有。
 *
 * 环形缓冲保留最近 N 条日志，**崩溃时能把它导出来给你**——
 * 这是唯一能还原现场的手段。
 *
 * 【为什么不用 console.log】
 * ① 无法批量关闭（生产环境字符串拼接也是开销）
 * ② 无法分级（想只看错误做不到）
 * ③ 没有上下文（"undefined is not an object" 看不出是谁报的）
 *
 * 【使用示例】
 * ```typescript
 * const log = new Logger({ level: LogLevel.Debug, bufferSize: 200 });
 * const combat = log.module('combat');
 *
 * combat.info('敌人生成', { id: 'slime', hp: 30 });
 * combat.error('伤害计算异常', { raw: NaN });
 *
 * log.setLevel(LogLevel.Warn);        // 生产环境关掉 debug/info
 * crashReporter.attach(log.export()); // 崩溃时导出最近 200 条
 * ```
 *
 * 【无引擎依赖】可脱离 Cocos 单测。
 */

export enum LogLevel {
  /** 最详细，只在开发期开 */
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
  /** 静默：什么都不输出（但仍写入缓冲，便于事后分析） */
  Silent = 5,
}

export interface LogEntry {
  readonly level: LogLevel;
  readonly module: string;
  readonly message: string;
  readonly data?: unknown;
  /** 时间戳（毫秒） */
  readonly time: number;
}

export interface LoggerOptions {
  /** 最低输出级别。低于此级别的只写缓冲，不输出到控制台 */
  readonly level?: LogLevel;
  /**
   * 环形缓冲大小
   *
   * 【坑】这是固定内存开销。200 条 × 平均 200 字节 ≈ 40KB，
   * 对移动端完全可接受，但设成 10000 就浪费了。
   */
  readonly bufferSize?: number;
  /**
   * 每个模块可单独设置级别
   * 例：{ combat: LogLevel.Debug, network: LogLevel.Warn }
   */
  readonly moduleLevels?: Readonly<Record<string, LogLevel>>;
  /** 是否写入缓冲（关闭可省内存，但崩溃时无现场） */
  readonly bufferEnabled?: boolean;
}

/** 级别名（输出与导出用） */
const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.Trace]: 'TRACE',
  [LogLevel.Debug]: 'DEBUG',
  [LogLevel.Info]: 'INFO',
  [LogLevel.Warn]: 'WARN',
  [LogLevel.Error]: 'ERROR',
  [LogLevel.Silent]: 'SILENT',
};

export class Logger {
  private _level: LogLevel;
  private readonly _moduleLevels = new Map<string, LogLevel>();
  private readonly _bufferEnabled: boolean;

  /** 环形缓冲：固定长度数组 + 写指针，永不增长 */
  private readonly _buffer: Array<LogEntry | undefined>;
  private readonly _bufferSize: number;
  private _writeIndex = 0;
  private _count = 0;

  /** 外部输出目标（可由宿主注入，便于对接引擎控制台 / 文件 / 上报） */
  private _sinks: Array<(e: LogEntry) => void> = [];

  constructor(opts: LoggerOptions = {}) {
    this._level = opts.level ?? LogLevel.Debug;
    this._bufferEnabled = opts.bufferEnabled ?? true;
    this._bufferSize = clampNum(opts.bufferSize, 1, 1e6, 200);
    this._buffer = new Array<LogEntry | undefined>(this._bufferSize);

    if (opts.moduleLevels) {
      for (const [k, v] of Object.entries(opts.moduleLevels)) {
        this._moduleLevels.set(k, v);
      }
    }
  }

  // ==================== 配置 ====================

  setLevel(level: LogLevel): void {
    this._level = level;
  }

  get level(): LogLevel {
    return this._level;
  }

  setModuleLevel(module: string, level: LogLevel): void {
    this._moduleLevels.set(module, level);
  }

  clearModuleLevel(module: string): void {
    this._moduleLevels.delete(module);
  }

  /**
   * 添加输出目标
   *
   * 【为什么用 sink 而不是直接 console】
   * 让宿主决定"输出到哪"：引擎控制台、文件、远程上报、UI 调试面板。
   * 库不关心，也不该关心。
   */
  addSink(fn: (e: LogEntry) => void): () => void {
    this._sinks.push(fn);
    return () => {
      const i = this._sinks.indexOf(fn);
      if (i >= 0) this._sinks.splice(i, 1);
    };
  }

  // ==================== 核心写入 ====================

  /**
   * 写入一条日志
   *
   * 【性能】级别不够时**提前返回**，不做任何字符串处理。
   * 这样生产环境下 `log.debug('昂贵信息 ' + JSON.stringify(obj))`
   * 的拼接开销就由调用方决定是否承担——
   * 实际上更好的做法是传 data 对象而非拼字符串（见 module() 的说明）。
   */
  log(level: LogLevel, module: string, message: string, data?: unknown): void {
    // 静默级别：连缓冲都不写
    if (this._level === LogLevel.Silent && !this._moduleLevels.has(module)) {
      // 仍写入缓冲（便于事后分析），但不输出
    }

    const entry: LogEntry = {
      level,
      module,
      message,
      data,
      time: Date.now(),
    };

    if (this._bufferEnabled) this._push(entry);
    if (this._shouldOutput(level, module)) this._emit(entry);
  }

  private _shouldOutput(level: LogLevel, module: string): boolean {
    const modLevel = this._moduleLevels.get(module);
    const threshold = modLevel ?? this._level;
    return level >= threshold;
  }

  private _push(e: LogEntry): void {
    this._buffer[this._writeIndex] = e;
    this._writeIndex = (this._writeIndex + 1) % this._bufferSize;
    if (this._count < this._bufferSize) this._count++;
  }

  private _emit(e: LogEntry): void {
    if (this._sinks.length === 0) {
      this._defaultSink(e);
      return;
    }
    for (const s of this._sinks) s(e);
  }

  private _defaultSink(e: LogEntry): void {
    const tag = `[${LEVEL_NAMES[e.level]}][${e.module}]`;
    const args: unknown[] = e.data !== undefined ? [tag, e.message, e.data] : [tag, e.message];
    switch (e.level) {
      case LogLevel.Trace:
      case LogLevel.Debug:
        console.log(...args);
        break;
      case LogLevel.Info:
        console.info(...args);
        break;
      case LogLevel.Warn:
        console.warn(...args);
        break;
      case LogLevel.Error:
        console.error(...args);
        break;
    }
  }

  // ==================== 分级快捷方法 ====================

  trace(module: string, msg: string, data?: unknown): void {
    this.log(LogLevel.Trace, module, msg, data);
  }
  debug(module: string, msg: string, data?: unknown): void {
    this.log(LogLevel.Debug, module, msg, data);
  }
  info(module: string, msg: string, data?: unknown): void {
    this.log(LogLevel.Info, module, msg, data);
  }
  warn(module: string, msg: string, data?: unknown): void {
    this.log(LogLevel.Warn, module, msg, data);
  }
  error(module: string, msg: string, data?: unknown): void {
    this.log(LogLevel.Error, module, msg, data);
  }

  /**
   * 创建一个绑定模块名的子日志器
   *
   * 【为什么传 data 对象而不是拼字符串】
   * ```typescript
   * combat.debug('生成敌人 ' + JSON.stringify(e));   // ❌ 级别关掉时拼接开销仍在
   * combat.debug('生成敌人', e);                      // ✅ 不输出就不用序列化
   * ```
   */
  module(name: string): ModuleLogger {
    return new ModuleLogger(this, name);
  }

  // ==================== 缓冲导出 ====================

  /**
   * 导出缓冲中的日志，**按时间顺序**（最旧 → 最新）
   *
   * 【坑】环形缓冲的物理顺序不是时间顺序。
   * 如果直接按数组下标输出，日志会是乱的——
   * 排查问题时这比没有日志更糟（你会沿着错误的时间线推理）。
   */
  export(): LogEntry[] {
    const out: LogEntry[] = [];
    const start = this._count < this._bufferSize ? 0 : this._writeIndex;
    for (let i = 0; i < this._count; i++) {
      const e = this._buffer[(start + i) % this._bufferSize];
      if (e) out.push(e);
    }
    return out;
  }

  /** 导出为可读文本（崩溃报告附件用） */
  exportText(): string {
    return this.export()
      .map((e) => {
        const t = new Date(e.time).toISOString().substring(11, 23);
        let s = `${t} ${LEVEL_NAMES[e.level]} [${e.module}] ${e.message}`;
        if (e.data !== undefined) {
          try {
            s += ' ' + JSON.stringify(e.data);
          } catch {
            s += ' <无法序列化的数据>';
          }
        }
        return s;
      })
      .join('\n');
  }

  /** 缓冲中的条目数 */
  get buffered(): number {
    return this._count;
  }

  clearBuffer(): void {
    this._buffer.fill(undefined);
    this._writeIndex = 0;
    this._count = 0;
  }

  /** 【铁律 5】可卸载 */
  destroy(): void {
    this._sinks.length = 0;
    this.clearBuffer();
  }
}

/** 绑定了模块名的日志器（语法糖） */
export class ModuleLogger {
  constructor(
    private readonly _logger: Logger,
    private readonly _module: string
  ) {}

  trace(msg: string, data?: unknown): void {
    this._logger.log(LogLevel.Trace, this._module, msg, data);
  }
  debug(msg: string, data?: unknown): void {
    this._logger.log(LogLevel.Debug, this._module, msg, data);
  }
  info(msg: string, data?: unknown): void {
    this._logger.log(LogLevel.Info, this._module, msg, data);
  }
  warn(msg: string, data?: unknown): void {
    this._logger.log(LogLevel.Warn, this._module, msg, data);
  }
  error(msg: string, data?: unknown): void {
    this._logger.log(LogLevel.Error, this._module, msg, data);
  }
}
