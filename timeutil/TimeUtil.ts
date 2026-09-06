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

/** 获取某个时区内"今天 00:00"对应的 UTC 时间戳 */
export function startOfDay(now: number, zone: Zone = Zones.UTC): number {
  const shifted = now + zone.offsetMinutes * 60_000;
  const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
  return dayStart - zone.offsetMinutes * 60_000;
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
  return Math.floor((now + zone.offsetMinutes * 60_000) / DAY_MS);
}

/**
 * 是否是新的一天
 *
 * @param lastSeen 上次记录的日序号（0 = 从未）
 */
export function isNewDay(now: number, lastSeen: number, zone: Zone = Zones.UTC): boolean {
  return dayIndex(now, zone) > lastSeen;
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
  if (periodMs <= 0) throw new Error('[TimeUtil] periodMs 必须为正');
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

export type CountdownState = 'waiting' | 'running' | 'finished';

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
    if (this._endAt === null && this._pausedRemain === null) return 'waiting';
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
