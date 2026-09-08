import { clampNum } from '../_core/math';
/**
 * DailyChallenge —— 每日挑战与固定种子
 *
 * 【它解决什么】
 *
 * 每日挑战的核心承诺是：**同一天，所有玩家玩的是完全一样的内容**。
 * 这样排行榜才有意义——大家面对的是同一套关卡、同样的掉落。
 *
 * 听起来简单（"用日期做种子"），但有几个真实的坑：
 *
 * 1. **时区**：玩家期望"我的周一"，但服务器要"全球同一天"。
 *    用 UTC 还是本地时间？两种设计都有，必须显式选择。
 * 2. **跨日切换**：玩家在 23:59 开始挑战，00:01 提交，算哪天的？
 * 3. **种子质量**：`20240101` 这种数字直接当种子，
 *    相邻两天生成的关卡可能高度相似（低位变化小）。
 * 4. **重玩限制**：每天一次，还是可以刷？（多数游戏：成绩只记第一次）
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

/** 日期字符串，格式 YYYY-MM-DD */
export type DateKey = string;

/** 每日挑战的配置 */
export interface DailyModifier {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  /** 由你的系统解释的效果 */
  readonly effects: readonly { stat: string; op: 'add' | 'mul' | 'set'; value: number }[];
  /** 权重（多 modifiers 时按权重抽取） */
  readonly weight?: number;
}

export interface DailyChallengeOptions {
  /** 挑战内容池（按种子抽取） */
  readonly modifiers?: readonly DailyModifier[];
  /**
   * 时区模式
   *
   * - `'utc'`：全球统一，UTC 日期变了就换（排行榜可比性强）
   * - `'local'`：按玩家本地日期换（符合直觉，但不同玩家进度不同）
   * - 数字：固定 UTC 偏移（小时），如 8 = 东八区
   *
   * 【默认 utc 的理由】
   * 每日挑战的价值在于"大家打一样的"，
   * 用本地时间的话，澳洲玩家比美国玩家早 15 小时拿到新挑战，
   * 排行榜的可比性就没了。
   */
  readonly timezone?: 'utc' | 'local' | number;
  /**
   * 每天抽几个 modifier（默认 2）
   */
  readonly modifierCount?: number;
  /**
   * 成绩记录方式
   * - `'first'`：只记当天第一次（防刷，多数游戏的选择）
   * - `'best'`：记最好成绩（更友好，但玩家可以刷）
   */
  readonly recordMode?: 'first' | 'best';
}

/** 某一天的挑战定义 */
export interface DailyEntry {
  /** 日期键 */
  readonly date: DateKey;
  /** 该天的种子（**这才是给生成器的**，不是原始日期数字） */
  readonly seed: number;
  /** 人类可读的展示种子（分享用） */
  readonly seedText: string;
  /** 抽中的 modifiers */
  readonly modifiers: readonly DailyModifier[];
}

/** 一条成绩记录 */
export interface DailyRecord {
  readonly date: DateKey;
  readonly score: number;
  /** 完成时刻（毫秒时间戳） */
  readonly at: number;
  /** 是否通关 */
  readonly cleared: boolean;
  /** 尝试次数 */
  readonly attempts: number;
}

// ==================== 实现 ====================

export class DailyChallenge {
  private readonly _modifiers: readonly DailyModifier[];
  private readonly _timezone: 'utc' | 'local' | number;
  private readonly _modifierCount: number;
  private readonly _recordMode: 'first' | 'best';

  /** date → 成绩 */
  private readonly _records = new Map<DateKey, DailyRecord>();
  /** date → 尝试次数 */
  private readonly _attempts = new Map<DateKey, number>();

  constructor(opts: DailyChallengeOptions = {}) {
    this._modifiers = opts.modifiers ?? [];
    this._timezone = opts.timezone ?? 'utc';
    this._modifierCount = clampNum(opts.modifierCount, 0, 1000, 2);
    this._recordMode = opts.recordMode ?? 'first';

    // 构造时校验：modifierCount 不该超过池子大小
    if (this._modifierCount > this._modifiers.length) {
      throw new Error(
        `[Daily] modifierCount(${this._modifierCount}) 超过 modifier 池子大小(${this._modifiers.length})`
      );
    }
  }

  // ==================== 日期与种子 ====================

  /**
   * 取当前日期键
   *
   * 【⚠️ 时区处理】
   * `new Date().toISOString().slice(0,10)` 拿到的是 **UTC 日期**，
   * 东八区的玩家在早上 8 点前会拿到"昨天"。
   *
   * 必须按配置的时区偏移调整后再取日期。
   */
  todayKey(now: number = Date.now()): DateKey {
    return dateKeyOf(now, this._timezone);
  }

  /**
   * 某一天的挑战定义
   *
   * 【为什么不能直接用日期数字当种子】
   * `20240101` 和 `20240102` 只差 1。
   * 多数 PRNG（包括 mulberry32）对相邻种子的前几次输出
   * 相关性很高——表现为"连续几天的关卡布局几乎一样"。
   *
   * 必须做一次**雪崩混合**（hash），让相邻日期的种子彻底发散。
   */
  entryFor(date: DateKey): DailyEntry {
    /**
     * 【⚠️ 曾经的 bug：展示文本无法回填】
     *
     * 第一版是 `seed = hash(date)`、`text = seedToText(seed)`。
     * 于是玩家看到今天的挑战叫 "IRON-WOLF-42"，分享给朋友，
     * 朋友输入 "IRON-WOLF-42" 后走的是**反解**路径——
     * 只能恢复低 24 位，得到的是一个**不同的种子**。
     *
     * 表现为："我分享给你了，为什么我们玩的关卡不一样？"
     * 这种 bug 会直接摧毁每日挑战的社交价值，而且极难排查——
     * 因为两边的代码看起来都对。
     *
     * 【修法：让文本成为种子的真身】
     * date → text → seed，而不是 date → seed → text。
     *
     *   hash(date)          派生展示文本
     *   hash(text)          ← 这才是真正用的种子
     *
     * 这样"输入文本"和"今日挑战"走的是同一条路径，
     * 分享与回填必然一致。代价是多一次 hash，可忽略。
     */
    const seedText = seedToText(hashDateKey(date));
    const seed = hashDateKey(seedText);
    return {
      date,
      seed,
      seedText,
      modifiers: this._pickModifiers(seed),
    };
  }

  /**
   * 从分享文本还原挑战
   *
   * 【保证】`fromText(entryFor(d).seedText).seed === entryFor(d).seed`
   *
   * 这是每日挑战社交功能的正确性根基。
   */
  fromText(text: string): DailyEntry | null {
    const t = text.trim().toUpperCase();
    if (!isValidSeedText(t)) return null;
    const seed = hashDateKey(t);
    return {
      date: '',                 // 来自分享，不属于任何一天
      seed,
      seedText: t,
      modifiers: this._pickModifiers(seed),
    };
  }

  /** 今天的挑战 */
  today(now: number = Date.now()): DailyEntry {
    return this.entryFor(this.todayKey(now));
  }

  /**
   * 按种子抽 modifiers
   *
   * 【不用 RNG 实例，直接用种子做确定性推导】
   * 因为这个方法可能在没有 RNG 依赖的场景被调用，
   * 而且结果必须**只依赖种子**，不依赖调用顺序。
   */
  private _pickModifiers(seed: number): DailyModifier[] {
    if (this._modifierCount === 0 || this._modifiers.length === 0) return [];

    const pool = this._modifiers.slice();
    const out: DailyModifier[] = [];
    let s = seed >>> 0;

    for (let k = 0; k < this._modifierCount; k++) {
      if (pool.length === 0) break;

      // 总权重
      let total = 0;
      for (const m of pool) total += m.weight ?? 1;

      // xorshift：简单、确定性、对连续调用够用
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      let r = (s >>> 0) / 4294967296 * total;

      let idx = pool.length - 1;
      for (let j = 0; j < pool.length; j++) {
        r -= pool[j].weight ?? 1;
        if (r < 0) { idx = j; break; }
      }

      out.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return out;
  }

  // ==================== 成绩 ====================

  get recordMode(): 'first' | 'best' {
    return this._recordMode;
  }

  attemptsOn(date: DateKey): number {
    return this._attempts.get(date) ?? 0;
  }

  recordOf(date: DateKey): DailyRecord | undefined {
    return this._records.get(date);
  }

  /** 今天是否已打过（用于 UI 置灰） */
  hasPlayedToday(now: number = Date.now()): boolean {
    return this._records.has(this.todayKey(now));
  }

  /**
   * 提交成绩
   *
   * @returns 是否更新了记录
   *
   * 【⚠️ 跨日提交的处理】
   * 玩家 23:59 开始、00:01 完成时，"今天"已经变了。
   * 如果按提交时刻算，成绩会记到新的一天（而那天的挑战他根本没打）。
   *
   * 所以成绩**必须绑定到开始时的日期**，由调用方传入 `date`。
   */
  submit(date: DateKey, score: number, cleared: boolean, now: number = Date.now()): boolean {
    this._attempts.set(date, (this._attempts.get(date) ?? 0) + 1);

    const prev = this._records.get(date);
    const attempts = this._attempts.get(date) ?? 1;

    let shouldWrite: boolean;
    if (prev === undefined) shouldWrite = true;
    else if (this._recordMode === 'first') shouldWrite = false;
    else shouldWrite = score > prev.score;

    if (!shouldWrite) return false;

    this._records.set(date, { date, score, at: now, cleared, attempts });
    return true;
  }

  /** 连续打卡天数（从今天往回数） */
  streak(now: number = Date.now()): number {
    let n = 0;
    let t = now;
    for (;;) {
      const k = dateKeyOf(t, this._timezone);
      if (!this._records.has(k)) break;
      n++;
      t -= 86400000;
      // 安全阀：最多往前查 3650 天
      if (n >= 3650) break;
    }
    return n;
  }

  /** 所有成绩（按日期降序） */
  history(): DailyRecord[] {
    return [...this._records.values()].sort((a, b) => b.date.localeCompare(a.date));
  }

  /** 通关次数 */
  get clearedCount(): number {
    let n = 0;
    for (const r of this._records.values()) if (r.cleared) n++;
    return n;
  }

  // ==================== 存档 ====================

  exportState(): {
    records: DailyRecord[];
    attempts: Array<[DateKey, number]>;
  } {
    return {
      records: [...this._records.values()],
      attempts: [...this._attempts.entries()],
    };
  }

  importState(s: {
    records?: readonly DailyRecord[];
    attempts?: ReadonlyArray<readonly [DateKey, number]>;
  }): void {
    this._records.clear();
    this._attempts.clear();
    for (const r of s.records ?? []) this._records.set(r.date, r);
    for (const [k, v] of s.attempts ?? []) this._attempts.set(k, v);
  }


  /**
   * 清理指定日期**之前**的记录（服务端长期运行时用）
   *
   * 【为什么需要】
   * `_records` / `_attempts` 按天累积，约 730 条/年。
   * 客户端内存影响可忽略，但长期运行的服务端会一直涨，
   * 而这个模块原本**没有任何清理手段**。
   *
   * DateKey 是 `YYYY-MM-DD`，字典序等于时间序，可直接比较。
   *
   * @returns 清理掉多少条
   */
  prune(beforeDateKey: DateKey): number {
    let n = 0;
    for (const k of Array.from(this._records.keys())) {
      if (k < beforeDateKey) { this._records.delete(k); n++; }
    }
    for (const k of Array.from(this._attempts.keys())) {
      if (k < beforeDateKey) { this._attempts.delete(k); n++; }
    }
    return n;
  }
}

// ==================== 工具函数 ====================

/** 毫秒时间戳 → 日期键（按时区） */
export function dateKeyOf(ms: number, tz: 'utc' | 'local' | number): DateKey {
  const d = new Date(ms);
  let y: number, m: number, day: number;

  if (tz === 'utc') {
    y = d.getUTCFullYear(); m = d.getUTCMonth() + 1; day = d.getUTCDate();
  } else if (tz === 'local') {
    y = d.getFullYear(); m = d.getMonth() + 1; day = d.getDate();
  } else {
    // 固定偏移：先平移到目标时区，再用 UTC 取日期
    const shifted = new Date(ms + tz * 3600000);
    y = shifted.getUTCFullYear(); m = shifted.getUTCMonth() + 1; day = shifted.getUTCDate();
  }

  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 日期字符串 → 32 位种子（雪崩混合）
 *
 * 【为什么需要】
 * "2024-01-01" 和 "2024-01-02" 只差一个字符。
 * 直接把字符码相加当种子，相邻两天的种子只差 1，
 * 而多数 PRNG 对相邻种子的输出高度相关——
 * 表现为"连续几天的关卡几乎一样"，玩家会以为你偷懒。
 *
 * FNV-1a + 额外混合，保证改一个字符就彻底发散。
 */
export function hashDateKey(date: DateKey): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 额外三轮混合（FNV-1a 的低位雪崩性偏弱）
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const SEED_WORDS_A = [
  'IRON', 'MOON', 'FLAME', 'STORM', 'GOLD', 'DUSK', 'FROST', 'ASH',
  'VOID', 'STAR', 'BLADE', 'CROW', 'SALT', 'WIND', 'BONE', 'NEON',
];
const SEED_WORDS_B = [
  'WOLF', 'GATE', 'THORN', 'CROWN', 'SHARD', 'WELL', 'HORN', 'MAW',
  'ECHO', 'VEIL', 'FANG', 'ROOT', 'TIDE', 'PYRE', 'SCRAP', 'HALO',
];

/**
 * 种子 → 人类可读文本（分享用）
 *
 * 【为什么要两个词 + 数字】
 * 玩家在群里说"我这个种子是 3748291045"，没人会去试。
 * 说"IRON-WOLF-42"，辨识度高、不易抄错。
 */
export function seedToText(seed: number): string {
  const a = SEED_WORDS_A[seed % SEED_WORDS_A.length];
  const b = SEED_WORDS_B[(seed >>> 8) % SEED_WORDS_B.length];
  const n = (seed >>> 16) % 100;
  return `${a}-${b}-${String(n).padStart(2, '0')}`;
}

/**
 * 校验分享文本格式
 *
 * 【注意：不是反解】
 * 种子由 `hashDateKey(text)` 得到，文本是种子的**唯一来源**。
 * 这里只做格式校验，真正的转换在 `DailyChallenge.fromText()` 里。
 *
 * 反解路径（把文本拆回数字）是行不通的：
 * "IRON-WOLF-42" 三个部分最多编码 4+4+2 = 10 bit 之外的信息量不足，
 * 无法还原 32 位种子。强行反解只会得到一个"看起来对但实际不同"的种子。
 */
export function isValidSeedText(text: string): boolean {
  const m = /^([A-Z]+)-([A-Z]+)-(\d{2})$/.exec(text.trim().toUpperCase());
  if (!m) return false;
  return (
    SEED_WORDS_A.includes(m[1]) &&
    SEED_WORDS_B.includes(m[2]) &&
    Number.isInteger(parseInt(m[3], 10))
  );
}
