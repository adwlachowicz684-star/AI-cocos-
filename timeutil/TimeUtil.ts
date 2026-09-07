/**
 * timeutil/TimeUtil.ts —— 时间工具（时区 / 倒计时 / 服务器时间同步）
 *
 * 【它解决什么】
 *
 * 游戏里所有"时间"相关的需求，坑都比看起来深：
 *
 * | 需求 | 坑 |
 * |---|---|
 * | 每日 0 点刷新 | **哪个时区？** 玩家改系统时间怎么办？ |
 * | 体力 5 分钟回 1 点 | 切后台再回来，是按真实时间还是游戏时间？ |
 * | 活动倒计时 | 客户端时间不准，显示"剩 -3 秒" |
 * | 赛季结算 | 跨时区玩家同时看到不同结果 |
 *
 * 本模块把这几件事做成确定性的、可测的：
 *
 * 1. **时区无关的日界**：明确指定 UTC 偏移，不依赖运行环境
 * 2. **服务器时间校准**：一次握手，之后本地推算（不每次问服务器）
 * 3. **防作弊的时间源**：`Date.now()` 可被改，但单调时钟不能
 *
 * 【⚠️ 最重要的一条设计：时间源注入】
 *
 * 所有函数都接受 `now` 参数，而不是内部调 `Date.now()`。
 * 这不是洁癖——**不注入就没法测试**。
 * "明天 3 点刷新对不对"这种逻辑，你不可能真的等到明天去验证。
 *
 * 【无引擎依赖】
 */

// ==================== 时区与日界 ====================

/**
 * 时区分
 *
 * 【为什么不直接用本地时区】
 * 玩家改系统时区 → 每日奖励多领一次。
 * 运营配置"北京时间 0 点刷新" → 必须用固定偏移，不能用玩家本地时区。
 */
export interface Zone {
  /** 名称（仅用于展示/调试） */
  readonly name: string;
  /** UTC 偏移（分钟）。东八区 = 480 */
  readonly offsetMinutes: number;
}

export const Zones: Readonly<Record<string, Zone>> = {
  UTC: { name: 'UTC', offsetMinutes: 0 },
  /** 北京时间 = UTC+8 */
  CN: { name: 'Asia/Shanghai', offsetMinutes: 8 * 60 },
  JP: { name: 'Asia/Tokyo', offsetMinutes: 9 * 60 },
  KR: { name: 'Asia/Seoul', offsetMinutes: 9 * 60 },
  US_PACIFIC: { name: 'America/Los_Angeles', offsetMinutes: -8 * 60 },
  US_EASTERN: { name: 'America/New_York', offsetMinutes: -5 * 60 },
  EU_CENTRAL: { name: 'Europe/Berlin', offsetMinutes: 1 * 60 },
};

/** 一天的毫秒数 */
export const DAY_MS = 86_400_000;

/**
 * `Intl.DateTimeFormat` 实例缓存（按 IANA 时区名）
 *
 * 【为什么缓存】
 * 构造一次 `Intl.DateTimeFormat` 要加载并解析时区数据，是微秒到毫秒级的操作；
 * 而日界判断经常出现在"每次进界面/每次领奖"这类路径上。
 * 缓存值为 `null` 表示"这个时区名解析失败过"，避免每次都重新抛一遍异常。
 */
const _zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

/**
 * 取某个时刻在指定时区的**真实** UTC 偏移（分钟）
 *
 * 【为什么不能只用常量 `offsetMinutes`】
 * 欧美时区一年里有半年用夏令时：洛杉矶冬天 PST = UTC-8，夏天 PDT = UTC-7。
 * 常量只能记其中一个，于是另外半年的日界整体错 1 小时——
 * 美服玩家在 23:00~24:00 这一小时里的行为会被算到"第二天"（或反过来），
 * 每日任务 / 赛季结算的边界错乱，而且**只有半年能复现**，极难定位。
 *
 * 实测（修复前）：`startOfDay(2024-07-01T05:00Z, US_PACIFIC)` 得到
 * `2024-06-30T08:00:00Z`，而 2024-07-01 洛杉矶处于 PDT，正确值是 `07:00Z`。
 *
 * 【为什么不干脆删掉 `offsetMinutes`】
 * `Intl` 依赖运行环境的时区数据库（ICU）。宿主引擎裁剪过 ICU，
 * 或者 `zone.name` 不是合法 IANA 名时，它会抛错或给出错误结果。
 * 这时必须有一个确定的兜底——`offsetMinutes` 就是那个兜底，不是冗余字段：
 * 环境支持时用真实偏移，不支持时退回"固定偏移"的旧行为。
 */
function zoneOffsetAt(now: number, zone: Zone): number {
  if (!zone.name) return zone.offsetMinutes;

  let fmt = _zoneFormatters.get(zone.name);
  if (fmt === undefined) {
    try {
      // 'longOffset' 稳定给出 "GMT-07:00" 形式，比 shortOffset 的 "GMT-7" 好解析
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone.name,
        timeZoneName: 'longOffset',
      });
      _zoneFormatters.set(zone.name, fmt);
    } catch {
      _zoneFormatters.set(zone.name, null);
      return zone.offsetMinutes;
    }
  }
  if (fmt === null) return zone.offsetMinutes;

  try {
    const part = fmt.formatToParts(new Date(now)).find((p) => p.type === 'timeZoneName');
    if (!part) return zone.offsetMinutes;
    // "GMT" / "GMT+08:00" / "GMT-07:00"；解析不出来就退回常量，不猜
    if (part.value === 'GMT') return 0;
    const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part.value);
    if (!m) return zone.offsetMinutes;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0));
  } catch {
    return zone.offsetMinutes;
  }
}

/** 获取某个时区内"今天 00:00"对应的 UTC 时间戳 */
export function startOfDay(now: number, zone: Zone = Zones.UTC): number {
  let off = zoneOffsetAt(now, zone);
  let dayStart = Math.floor((now + off * 60_000) / DAY_MS) * DAY_MS - off * 60_000;

  /**
   * 【为什么要按日界时刻再取一次偏移】
   * 夏令时切换当天，`now` 和"当天 00:00"可能处在**不同**偏移下
   * （例如凌晨 2 点切到 PDT）。用查询时刻的偏移去定位日界，
   * 在切换日那 24 小时里仍会偏 1 小时。取日界那一刻的偏移再算一次即可收敛。
   */
  const offAtDayStart = zoneOffsetAt(dayStart, zone);
  if (offAtDayStart !== off) {
    off = offAtDayStart;
    dayStart = Math.floor((now + off * 60_000) / DAY_MS) * DAY_MS - off * 60_000;
  }

  return dayStart;
}

/** 获取下一天 00:00 的 UTC 时间戳 */
export function startOfNextDay(now: number, zone: Zone = Zones.UTC): number {
  return startOfDay(now, zone) + DAY_MS;
}

/**
 * 自 epoch 以来的"日序号"（在指定时区下）
 *
 * 【用途】每日奖励、每日任务。
 * 比存"上次领取时间戳"更稳：
 * 玩家在同一天的不同时刻领，序号相同。
 */
export function dayIndex(now: number, zone: Zone = Zones.UTC): number {
  return Math.floor((now + zoneOffsetAt(now, zone) * 60_000) / DAY_MS);
}

/**
 * 看起来像毫秒时间戳（而不是日序号）的下界
 *
 * 日序号 = 1970 以来的天数，当前约 2 万，几十万年内都不会超过 1 亿；
 * 而毫秒时间戳当前约 1.7e12。两者量级差 7 个数量级，
 * 任何大于 1e11（1973 年）的值都只可能是时间戳。
 */
const TIMESTAMP_LIKE_MIN = 1e11;

/**
 * 是否是新的一天
 *
 * @param lastDayIndex 上次记录的**日序号**（`dayIndex()` 的返回值，当前约 2 万）
 *
 * 【⚠️ 第二个参数是日序号，不是时间戳】
 *
 * 实现是 `dayIndex(now, zone) > lastDayIndex`。如果按"lastSeen = 上次登录时间"
 * 的直觉传 `Date.now()`（约 1.7e12），比较恒为 false——
 * **每日任务 / 每日奖励 / 每日商店永不刷新**，而且返回值是 false 而不是报错，
 * 现象是"第二天上线，任务还是昨天那批"。注释说谎比没注释更糟，
 * 所以这里把参数名从 `lastSeen` 改成了 `lastDayIndex`。
 *
 * 【为什么不改成内部 `dayIndex(lastSeen)` 来兼容两种传法】
 * 日序号本身也是个毫秒数（约 2 万 ms ≈ 1970-01-01），再取一次 dayIndex 恒为 0，
 * 于是"传日序号"这种**正确**用法会变成永远 true。两种传法无法无歧义地兼容：
 * 与其猜，不如对明显的误用直接报错（见下面的阈值守卫）。
 *
 * 【仓库里为什么没人发现】
 * 自带测试传的正是 `dayIndex`（正确用法），所以误用路径从来没被覆盖到。
 */
export function isNewDay(
  now: number,
  lastDayIndex: number,
  zone: Zone = Zones.UTC
): boolean {
  if (!Number.isFinite(lastDayIndex)) {
    throw new TypeError(
      `[TimeUtil] isNewDay 的 lastDayIndex 必须是有限数值，实际 ${String(lastDayIndex)}`
    );
  }
  /**
   * 【误用守卫】传进来的值大过阈值就一定是毫秒时间戳，
   * 也就是上面那个"永不刷新"的误用。静默返回 false 是最糟的结果
   * （玩家第二天上线看到昨天的任务，运营查一周查不出原因），所以直接报错，
   * 并在错误信息里给出正确写法。
   */
  if (lastDayIndex > TIMESTAMP_LIKE_MIN) {
    throw new RangeError(
      `[TimeUtil] isNewDay 的第二个参数是日序号（dayIndex() 的返回值，当前约 2 万），` +
        `实际收到 ${lastDayIndex}，看着像毫秒时间戳。` +
        `传时间戳会让本函数恒返回 false，表现为每日任务/奖励永不刷新。` +
        `正确写法：isNewDay(now, dayIndex(lastLoginAt, zone), zone)`
    );
  }
  return dayIndex(now, zone) > lastDayIndex;
}

/** 距离下次日界还有多少毫秒 */
export function msUntilNextDay(now: number, zone: Zone = Zones.UTC): number {
  return startOfNextDay(now, zone) - now;
}

// ==================== 周期刷新点 ====================

/**
 * 计算某个"周期"内的第几个刷新点已经过去
 *
 * 【用途】体力恢复、每日任务批次、周常。
 *
 * ```
 * 每 5 分钟回 1 点体力
 * periodMs = 300_000
 * ticksSince(lastClaim, now, 300_000) → 过了几个 5 分钟
 * ```
 *
 * 【⚠️ 曾经的 bug：切后台再回来一次性补满】
 * 如果不限制上限，玩家离线一天回来直接领满。
 * 所以用 `maxTicks` 夹紧——这是设计决定，不是优化。
 */
export function ticksSince(
  since: number,
  now: number,
  periodMs: number,
  maxTicks = Infinity
): number {
  /**
   * 【⚠️ 必须写成肯定式 `!(periodMs > 0)`】
   *
   * `periodMs <= 0` 这种否定式**天然漏掉 NaN**：NaN 与任何值比较都是 false，
   * 于是 `NaN <= 0` 为 false，坏值直接穿透到下面——
   * `Math.floor((now - since) / NaN) = NaN`，补发体力数量变成 NaN，
   * 玩家体力显示 NaN 且不报错。配置表里 period 字段缺失正是 NaN 的典型来源。
   *
   * 实测（修复前）：`ticksSince(0, 1000, NaN) === NaN`，
   * 而 `ticksSince(0, 1000, 0)` 正常抛错——同一条守卫对 0 有效、对 NaN 失效。
   *
   * `Infinity` 是允许的：周期无限长 → 一个 tick 都没有（返回 0），语义自洽。
   */
  if (!(periodMs > 0)) throw new Error('[TimeUtil] periodMs 必须为正');
  if (now < since) return 0;   // 时间倒流（改系统时间）→ 不奖励
  const n = Math.floor((now - since) / periodMs);
  return Math.min(n, maxTicks);
}

// ==================== 服务器时间校准 ====================

/**
 * 时间偏移校准器
 *
 * 【为什么需要】
 * 客户端时钟可能不准（差几分钟很常见，差几小时也不罕见）。
 * 倒计时"还剩 5 分钟"如果基于本地时钟，玩家改一下就白嫖了。
 *
 * 【做法】
 * 启动时问一次服务器，记下 `offset = serverTime - localTime`。
 * 之后用 `localTime + offset` 作为"服务器时间"。
 *
 * 【⚠️ 为什么不能每次都问服务器】
 * 一来有延迟（倒计时会抖），二来请求量太大。
 * 一次校准 + 本地推算，是业界标准做法。
 */
export class ClockSync {
  private _offset = 0;
  private _synced = false;
  /** 上一次校准时的本地时间（用于检测本地时钟被大幅改动） */
  private _localAtSync = 0;
  /** 单调时钟基准（不受系统时间修改影响） */
  private _monoAtSync = 0;

  constructor(opts: { readonly now?: number; readonly mono?: number } = {}) {
    this._localAtSync = opts.now ?? Date.now();
    this._monoAtSync = opts.mono ?? monotonicNow();
  }

  /** 是否已校准 */
  get synced(): boolean {
    return this._synced;
  }

  /** 当前偏移量（服务器时间 - 本地时间） */
  get offset(): number {
    return this._offset;
  }

  /**
   * 用一次服务器响应校准
   *
   * @param serverTime 服务器返回的时间戳（毫秒）
   * @param localAtRequest 发出请求时的本地时间戳
   * @param localAtResponse 收到响应时的本地时间戳
   */
  sync(serverTime: number, localAtRequest: number, localAtResponse: number): void {
    /**
     * 【为什么要传请求和响应两个本地时间】
     * 网络有延迟。假设请求花了 200ms，
     * 那么服务器返回的时刻，真实时间应该是 `serverTime + 100ms`（半个 RTT）。
     *
     * 取中点：`localAtResponse` 对应的服务器时间 ≈ serverTime + rtt/2
     */
    const rtt = Math.max(0, localAtResponse - localAtRequest);
    const midLocal = localAtRequest + rtt / 2;
    this._offset = Math.round(serverTime - midLocal);

    this._localAtSync = localAtResponse;
    this._monoAtSync = monotonicNow();
    this._synced = true;
  }

  /**
   * 校准（单次时间戳，忽略 RTT 补偿）
   *
   * 用于无法测 RTT 的场景（比如从存档里读到的服务器时间）。
   */
  syncSimple(serverTime: number, localTime: number): void {
    this._offset = serverTime - localTime;
    this._localAtSync = localTime;
    this._monoAtSync = monotonicNow();
    this._synced = true;
  }

  /**
   * 当前服务器时间（估算）
   *
   * 【⚠️ 用单调时钟推算，而不是 `Date.now() + offset`】
   *
   * 玩家可以改系统时间。改完之后 `Date.now()` 跳变，
   * 但因为 offset 是固定的，推算出的"服务器时间"也跟着跳——
   * 于是倒计时被绕过。
   *
   * 用单调时钟（`performance.now()`）推算：
   * 真实经过的时间不受系统时间修改影响。
   */
  now(): number {
    if (!this._synced) return Date.now();
    const elapsedMono = monotonicNow() - this._monoAtSync;
    return this._localAtSync + this._offset + elapsedMono;
  }

  /**
   * 检测本地时钟是否被大幅改动
   *
   * 【用途】发现"玩家把系统时间调快了一天"。
   * 注意：单靠客户端无法彻底防作弊，这只是提高门槛；
   * 真正的关键判定（发奖）必须在服务器做。
   */
  detectClockJump(toleranceMs = 60_000): boolean {
    if (!this._synced) return false;
    const fromMono = this._localAtSync + (monotonicNow() - this._monoAtSync);
    return Math.abs(Date.now() - fromMono) > toleranceMs;
  }

  /** 重置（重新登录时） */
  reset(): void {
    this._offset = 0;
    this._synced = false;
  }
}

/**
 * 单调时钟（毫秒）
 *
 * 优先 `performance.now()`，没有则退化到 `process.hrtime()`，
 * 再没有才用 `Date.now()`（此时失去防作弊能力，但至少不崩）。
 */
export function monotonicNow(): number {
  const g = globalThis as unknown as {
    performance?: { now(): number };
    process?: { hrtime?: (t?: [number, number]) => [number, number] };
  };
  if (g.performance && typeof g.performance.now === 'function') {
    return g.performance.now();
  }
  if (g.process?.hrtime) {
    // 不用 BigInt：目标 ES2019 不支持 BigInt 字面量
    const [sec, nsec] = g.process.hrtime();
    return sec * 1000 + nsec / 1_000_000;
  }
  return Date.now();
}

// ==================== 倒计时 ====================

/**
 * 倒计时状态
 *
 * 【'paused' 是后加的，属于行为变更】
 * 原先只有三态，暂停中的倒计时 `state()` 返回 `'running'`——
 * 调用方没法用 `state()` 区分"在跑"和"暂停中"，只能自己额外记一个标志，
 * UI 上表现为"暂停后倒计时还在转"。
 * 加了 `'paused'` 之后，对已有 `switch` 是**穷尽性**上的 breaking：
 * 写了 `default` 的没事，写死三分支且开了穷尽检查的会编译报错——
 * 这恰恰是想要的：漏处理暂停态的代码应该在编译期浮出来。
 */
export type CountdownState = 'waiting' | 'running' | 'paused' | 'finished';

/**
 * 倒计时
 *
 * 【它解决什么】
 * 手写的倒计时常见两个 bug：
 * 1. **负数**：显示"剩余 -3 秒"
 * 2. **跳变**：切后台回来，倒计时没有按真实流逝推进
 *
 * 本模块的 `remaining()` 永远 >= 0，且基于传入的 `now` 计算，天然支持后台恢复。
 */
export class Countdown {
  private readonly _durationMs: number;
  private _endAt: number | null = null;
  private _pausedRemain: number | null = null;

  constructor(durationMs: number) {
    if (durationMs <= 0) throw new Error('[TimeUtil] 倒计时时长必须为正');
    this._durationMs = durationMs;
  }

  get durationMs(): number {
    return this._durationMs;
  }

  /** 开始（now 为当前时间戳） */
  start(now: number): void {
    this._endAt = now + this._durationMs;
    this._pausedRemain = null;
  }

  /** 从指定剩余时间开始（存档恢复用） */
  startWith(remainingMs: number, now: number): void {
    this._endAt = now + Math.max(0, remainingMs);
    this._pausedRemain = null;
  }

  pause(now: number): void {
    if (this._pausedRemain !== null || this._endAt === null) return;
    this._pausedRemain = Math.max(0, this._endAt - now);
  }

  resume(now: number): void {
    if (this._pausedRemain === null) return;
    this._endAt = now + this._pausedRemain;
    this._pausedRemain = null;
  }

  /** 剩余毫秒（**永不为负**） */
  remaining(now: number): number {
    if (this._pausedRemain !== null) return this._pausedRemain;
    if (this._endAt === null) return this._durationMs;
    return Math.max(0, this._endAt - now);
  }

  /** 进度 0~1 */
  progress(now: number): number {
    return 1 - this.remaining(now) / this._durationMs;
  }

  /** 是否已结束 */
  isFinished(now: number): boolean {
    return this.remaining(now) <= 0;
  }

  state(now: number): CountdownState {
    /**
     * 【⚠️ 暂停判定必须在最前面】
     * `_pausedRemain !== null` 是暂停的**唯一**标志（`pause()` 写入、`resume()` 清掉）。
     * 不先判它，暂停中的倒计时会掉到下面被判成 'running'——
     * 于是 `remaining()` 明明已经冻结（返回 900），`state()` 却说还在跑，
     * 两个方法自相矛盾，调用方没法只靠 `state()` 驱动 UI。
     *
     * 实测（修复前）：`start(0)` → `pause(100)` → `state(500)` 返回 `'running'`。
     */
    if (this._pausedRemain !== null) return 'paused';
    if (this._endAt === null) return 'waiting';
    return this.isFinished(now) ? 'finished' : 'running';
  }

  reset(): void {
    this._endAt = null;
    this._pausedRemain = null;
  }
}

// ==================== 格式化 ====================

/**
 * 把毫秒格式化成 `HH:MM:SS` 或 `MM:SS`
 *
 * 【⚠️ 为什么不用 Date 对象格式化】
 * `new Date(ms).toISOString()` 在超过 24 小时会进位成天数，
 * 显示 "1:00:00" 而不是 "24:00:00"。
 * 活动倒计时超过一天是很常见的。
 */
export function formatDuration(ms: number, opts: { readonly showHoursAlways?: boolean } = {}): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0 || opts.showHoursAlways) {
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

/** 格式化成 "3天2小时" 这类中文可读文本 */
export function formatDurationCN(ms: number, maxUnits = 2): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const units: Array<[number, string]> = [
    [86400, '天'],
    [3600, '小时'],
    [60, '分'],
    [1, '秒'],
  ];

  let rest = total;
  const parts: string[] = [];
  for (const [secs, label] of units) {
    const n = Math.floor(rest / secs);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * secs;
      if (parts.length >= maxUnits) break;
    } else if (parts.length > 0) {
      // 已经开始了就补零位（"1小时0分"）
      parts.push(`0${label}`);
      if (parts.length >= maxUnits) break;
    }
  }
  return parts.length === 0 ? '0秒' : parts.join('');
}
