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
  /**
   * Silent 级别下是否仍然写缓冲（默认 **true**）
   *
   * 【为什么默认 true】见 `log()` 的说明：缓冲是崩溃现场的唯一来源，
   * 而 `level` 按设计只挡"输出"、不挡"记录"。
   * 改成默认 false 会让"上线后调 Silent"这个最常见的操作
   * 顺手把崩溃现场一起关掉。
   *
   * 【什么时候设为 false】压测 / Benchmark 场景：
   * 那时既不想要控制台输出，也不想要 entry 对象分配与缓冲写入的开销。
   */
  readonly bufferWhileSilent?: boolean;
  /**
   * 缓冲里是否保留 `data` 引用（默认 **true**）
   *
   * 【为什么需要这个开关】
   * `data` 常被直接塞进 Cocos 节点、组件或大对象。
   * 缓冲持有它们 200 条，等于给这些对象续命：
   * 场景都销毁了，节点却因为还在日志缓冲里而无法回收。
   * 设为 false 后缓冲只留 level / module / message / time，
   * 大对象可以被正常 GC（代价是导出的现场里没有 data）。
   */
  readonly bufferData?: boolean;
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

/**
 * 内部 sink 登记项
 *
 * 【为什么不能只存函数本身】
 * 注销靠 `indexOf(fn)` 定位时，定位到的是"值相等的那个函数"，
 * 而不是"你这一次注册的这一个"。
 * 后果（本库已出现过同型 bug）：
 *   1. 同一个函数被注册两次，取消一次 → `indexOf` 命中的可能是另一次注册；
 *   2. 取消函数被**重复调用**（幂等性没保证时很常见），
 *      第二次 `indexOf` 会找到**别人新注册的**同一个函数并把它删掉
 *      ——表现为"某个上报通道莫名其妙不再收到日志"。
 *
 * 所以每次注册发一个唯一 token，注销只认 token，
 * 且 token 一旦作废再调用也不会影响后来者。
 */
interface SinkEntry {
  readonly fn: (e: LogEntry) => void;
  alive: boolean;
}

export class Logger {
  private _level: LogLevel;
  private readonly _moduleLevels = new Map<string, LogLevel>();
  private readonly _bufferEnabled: boolean;
  private readonly _bufferWhileSilent: boolean;
  private readonly _bufferData: boolean;

  /** 环形缓冲：固定长度数组 + 写指针，永不增长 */
  private readonly _buffer: Array<LogEntry | undefined>;
  private readonly _bufferSize: number;
  private _writeIndex = 0;
  private _count = 0;

  /** 外部输出目标（可由宿主注入，便于对接引擎控制台 / 文件 / 上报） */
  private _sinks: SinkEntry[] = [];

  constructor(opts: LoggerOptions = {}) {
    this._level = opts.level ?? LogLevel.Debug;
    this._bufferEnabled = opts.bufferEnabled ?? true;
    this._bufferWhileSilent = opts.bufferWhileSilent ?? true;
    this._bufferData = opts.bufferData ?? true;
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
    const entry: SinkEntry = { fn, alive: true };
    this._sinks.push(entry);
    // 【为什么取消函数是幂等的】
    // 见 SinkEntry 的说明：`alive` 标记让"重复调用 / 调用旧的取消函数"
    // 都变成空操作，不会误伤之后注册的监听器。
    return () => {
      if (!entry.alive) return;
      entry.alive = false;
      const i = this._sinks.indexOf(entry);
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
    /**
     * 【⚠️ 这里曾经是一个空 if 块】
     *
     * ```ts
     * // 静默级别：连缓冲都不写
     * if (this._level === LogLevel.Silent && !this._moduleLevels.has(module)) {
     *   // 仍写入缓冲（便于事后分析），但不输出
     * }
     * ```
     *
     * 两行注释互相矛盾，块体是空的——读代码的人无法判断作者到底想要哪种行为，
     * 只能去猜。这正是本库反复强调的"注释骗人"：
     * 空块看起来像"这里做了静默处理"，实际什么都没发生。
     *
     * 【真实语义（不是 bug，是刻意设计，不要"顺手修"掉）】
     * `level` 只挡**输出**，不挡**记录**。
     * README 第 155 行写得很清楚："低于级别的日志仍然进缓冲——这是刻意的：
     * 崩溃时要能导出崩溃前的 Trace 级日志"。
     * 而且缓冲本来就与级别无关（任何级别都进缓冲），
     * 所以"Silent 期日志把关键日志挤出缓冲"这个担忧不成立：
     * 有级别时它们一样在被挤出。
     *
     * 【那 Silent 到底省了什么】省的是 `_emit`（控制台 / sink 输出）。
     * 若连 entry 对象分配与缓冲写入也要省（压测场景），
     * 用 `bufferWhileSilent: false` 显式声明——而不是留一个空块让人猜。
     */
    const silent = this._isSilentFor(module);
    if (silent && !this._bufferWhileSilent) return;

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

  /**
   * 该模块当前是否处于"完全静默"
   *
   * 【为什么不直接写 `this._level === LogLevel.Silent`】
   * 模块级配置优先于全局：全局 Silent 但某模块单独开了 Debug 时，
   * 该模块**不是**静默的。老代码的判断漏了这一层，
   * 只是因为块体为空才没造成实际差异。
   */
  private _isSilentFor(module: string): boolean {
    const threshold = this._moduleLevels.get(module) ?? this._level;
    return threshold === LogLevel.Silent;
  }

  private _shouldOutput(level: LogLevel, module: string): boolean {
    const modLevel = this._moduleLevels.get(module);
    const threshold = modLevel ?? this._level;
    return level >= threshold;
  }

  private _push(e: LogEntry): void {
    /**
     * 【为什么这里可能要拷一份不带 data 的 entry】
     * 缓冲里的 200 条会一直持有 `data` 的引用。
     * 如果 data 是 Cocos 节点 / 组件 / 大对象（日志里很常见——
     * "这个节点的状态不对"正是最想记的东西），
     * 场景销毁后这些对象因为还挂在缓冲上而无法回收。
     *
     * `bufferData: false` 时只留定位问题所需的最小信息
     * （级别 / 模块 / 消息 / 时间），把大对象的引用断开。
     * 【为什么不直接改 e】entry 与 sink 拿到的是同一个对象，
     * 改它会让 sink 也丢 data——所以只能另拷一份给缓冲。
     */
    const stored: LogEntry = this._bufferData
      ? e
      : { level: e.level, module: e.module, message: e.message, time: e.time };

    this._buffer[this._writeIndex] = stored;
    this._writeIndex = (this._writeIndex + 1) % this._bufferSize;
    if (this._count < this._bufferSize) this._count++;
  }

  private _emit(e: LogEntry): void {
    if (this._sinks.length === 0) {
      this._defaultSink(e);
      return;
    }
    /**
     * 【⚠️ 为什么要遍历副本】
     * sink 里最常用的操作之一就是"报完这次就退订"（一次性钩子、
     * 等待某个事件后卸载）。直接遍历 `_sinks` 时，
     * 回调里 `splice` 掉自己会让后面所有 sink **被跳过**——
     * 表现为"某些上报通道莫名其妙收不到日志"，且只在注销发生时出现，
     * 极难复现。这是全库"遍历中修改集合"模式的标准修法。
     */
    for (const s of [...this._sinks]) {
      // 【为什么不直接遍历原数组】见上；这里额外判 alive：
      // 副本快照里可能包含"在本次遍历刚开始时才被注销"的项
      // （例如 sink A 在自己的回调里注销了 sink B），不判就会多调一次。
      if (s.alive) s.fn(e);
    }
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

  /**
   * 【铁律 5】可卸载
   *
   * 【为什么要把 `_moduleLevels` 也清掉】
   * 原实现只清了 `_sinks` 和缓冲。模块级配置是一份会随时间增长的
   * 模块名 → 级别映射（每个系统注册一次），
   * 且它**能改变后续行为**：destroy 之后若有人复用这个实例，
   * 旧配置会悄悄生效（"全局都静默了，怎么 combat 还在刷屏"）。
   */
  destroy(): void {
    this._sinks.length = 0;
    this._moduleLevels.clear();
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
