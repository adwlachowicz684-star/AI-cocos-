import { clampNum } from '../_core/math';
import { needFinite } from '../_core/guard';
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
    /**
     * 【⚠️ 为什么 seed === 0 要换一个常量（2026 精审 P2-D5 修复）】
     *
     * 下面用的是 xorshift32：`0` 是它的**不动点**——
     * `0 ^ 0 << 13` 还是 0，三轮下来状态永远是 0。
     * 于是 `r` 恒为 0，加权抽取退化为"每次都取池子里的第 0 个"，
     * 生成的 modifiers 永远是同一组前缀，所谓"随机"完全失效。
     *
     * 触发概率是 1/2³²（seed 恰好为 0），看起来可以忽略——
     * 但 seed 来自 `hashDateKey(text)`，而**玩家可以从分享文本倒推输入**，
     * 也就是说这是一条**可被人为构造**的路径，不是纯理论风险。
     *
     * 【为什么只改 0 这一条路径，而不是给所有 seed 加盐】
     * 加盐会改变**所有现有日期**的 modifiers 抽取结果——
     * 玩家上周打过的每日挑战会突然变成另一套，属于不可接受的 breaking。
     * 只把"本来就是坏的"0 换掉，其余 seed 的行为逐位不变。
     */
    let s = seed >>> 0;
    if (s === 0) s = 0x9e3779b9;

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
   *
   * 【⚠️ score 必须是有限数（2026 精审 P2-D3 修复）】
   *
   * 老实现靠 `score > prev.score` 决定写不写记录，
   * 而 NaN 与任何值比较都为 false：
   *
   * ```
   * 首次提交（无 prev）    → shouldWrite = true  → 记录里存进 NaN 成绩
   * 已有 prev，best 模式   → NaN > prev 为 false → 静默不写，返回 false
   * ```
   *
   * 后一种的表现是"成绩丢了，但没有任何提示"——调用方拿到 `false`
   * 只会当成"这次分不够高"。而前一种更糟：一条 `score: NaN` 的记录
   * 会一直留在排行榜数据里（NaN 与任何后续成绩比较都为 false，
   * 于是这条记录**永远不会被更好的成绩覆盖**）。
   *
   * 成绩来自内部结算，NaN 意味着上游算错了，属于必须立刻暴露的错误，
   * 所以这里抛错而不是静默丢弃（与 `stats.record` / `currency.add` 一致）。
   */
  submit(date: DateKey, score: number, cleared: boolean, now: number = Date.now()): boolean {
    needFinite(score, `DailyChallenge.submit(${date}).score`);

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

  /**
   * 导入存档
   *
   * 【⚠️ 为什么必须逐条校验（2026 精审 P2-D4 修复）】
   *
   * 老实现是无条件 `set()`：`for (const r of s.records) this._records.set(r.date, r)`。
   * 损坏的存档（改过的本地文件、跨版本残留、服务端脏数据）会**原样进入内部状态**：
   *
   * ```
   * score: NaN      → 这条记录永远不会被更好的成绩覆盖（NaN 比较恒 false）
   * attempts: -3    → UI 上的"今日次数"显示为 -3
   * date: '' / 乱码 → 生成一条无法被 prune 清理的孤儿记录（字典序比较失效）
   * ```
   *
   * 三种都不会报错，只表现为"排行榜/打卡 UI 上出现怪数字"。
   *
   * 【为什么是"跳过"而不是"抛错"】
   * 存档导入是**容错路径**：一条坏记录不该让整个存档加载失败
   * （玩家会直接丢失全部历史）。所以跳过坏数据、保留能用的部分，
   * 并把跳过的条数返回，让调用方能记日志。
   *
   * @returns 被跳过的坏数据条数（0 = 全部导入成功）
   */
  importState(s: {
    records?: readonly DailyRecord[];
    attempts?: ReadonlyArray<readonly [DateKey, number]>;
  }): number {
    this._records.clear();
    this._attempts.clear();

    let skipped = 0;

    for (const r of s.records ?? []) {
      if (!isDateKey(r?.date) || !Number.isFinite(r?.score)) {
        skipped++;
        continue;
      }
      // attempts / cleared 来自同一条存档，坏了就补默认值而不是丢整条记录
      this._records.set(r.date, {
        date: r.date,
        score: r.score,
        at: Number.isFinite(r.at) ? r.at : 0,
        cleared: r.cleared === true,
        attempts: Math.max(0, Math.floor(Number.isFinite(r.attempts) ? r.attempts : 1)),
      });
    }

    for (const [k, v] of s.attempts ?? []) {
      if (!isDateKey(k) || !Number.isFinite(v) || v < 0) {
        skipped++;
        continue;
      }
      this._attempts.set(k, Math.floor(v));
    }

    return skipped;
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
 * 是否为合法的 `YYYY-MM-DD` 日期键
 *
 * 【为什么 `importState` 需要它】
 * DateKey 参与两件关键的事——按**字典序**比较（`prune`）和按字符串哈希
 * （`hashDateKey`）。一条 `''`、`'2024-1-1'` 或乱码的键，
 * 字典序比较会失效（该被清理的清不掉），哈希出来的种子也毫无意义。
 * 这类脏数据不会报错，只会变成"永远清不掉的孤儿记录"。
 *
 * 只校验**形状**，不校验日历合法性（2 月 30 日也放行）：
 * 存档里的日期来自 `dateKeyOf`，形状错了说明数据损坏，
 * 而"2 月 30 日"更可能是时区/日历系统差异，不该被当成坏数据丢掉。
 */
function isDateKey(v: unknown): v is DateKey {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
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
 *
 * 【⚠️ 为什么数字段不再固定两位（2026 精审 P1 修复）】
 *
 * 老写法是 `n = (seed >>> 16) % 100`，输出空间只有
 * `16 × 16 × 100 = 25600` 种。而 `entryFor` 是
 * `date → seedToText(hash(date)) → hash(text)`，
 * 文本空间直接决定了"不同日期能拿到多少种不同挑战"。
 *
 * 实测（修复前）：**第 156 天就撞车**——
 * `2026-06-06` 与 `2026-05-18` 共用种子文本 `ASH-ECHO-61`，
 * 两天的挑战完全一致。（生日悖论下 25600 桶约 188 天 50% 碰撞，量级吻合。）
 *
 * 后果：玩家半年内会遇到"今天和 19 天前一模一样"，
 * 社区只会报"每日挑战不刷新"——日期键对、文本对，只有内容重复，
 * 排查时没人会想到是**文本空间太小**。
 *
 * 【为什么不能按审查建议直接改用 `hash(date)` 当种子】
 * 那会破坏本文件最重要的保证：`fromText(entryFor(d).seedText).seed === entryFor(d).seed`
 * （README §4「分享回填：文本必须是种子的真身」+ 既有回归用例）。
 * 一旦种子不再由文本派生，分享出去的码就还原不出同一张图。
 *
 * 【修法：让文本无损覆盖 32 位种子】
 * 4 bit（词 A）+ 4 bit（词 B）+ 24 bit（数字段）= 32 bit，
 * `seedToText` 因此是**单射**：不同的 32 位种子必然得到不同文本。
 * 于是"两个日期撞车"只可能来自 `hashDateKey` 自身的 32 位碰撞
 * （约 180 年一次，属已知全局议题），不再有 25600 这个额外瓶颈。
 *
 * 【兼容性】数字段改成 2~8 位，两位及以上的旧码**依然合法且映射到同一种子**
 * ——因为种子是 `hash(text)`，文本字符串本身才是种子的来源，与编码规则无关。
 */
export function seedToText(seed: number): string {
  const s = seed >>> 0;
  const a = SEED_WORDS_A[s & 15];
  const b = SEED_WORDS_B[(s >>> 4) & 15];
  const n = s >>> 8;
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
 * 种子是 `hash(text)` 的结果，文本是种子的**唯一来源**，
 * 不能从文本反推出"当初生成它的那个日期"。强行反解只会得到一个
 * "看起来对但实际不同"的种子。
 *
 * 【数字段为什么是 2~8 位】
 * 见 `seedToText` 的注释：数字段承载种子的高 24 位，最长 8 位。
 * 仍要求**至少两位**——一位数字是抄写错误的最常见形态，必须拒绝。
 */
export function isValidSeedText(text: string): boolean {
  const m = /^([A-Z]+)-([A-Z]+)-(\d{2,8})$/.exec(text.trim().toUpperCase());
  if (!m) return false;
  return (
    SEED_WORDS_A.includes(m[1]) &&
    SEED_WORDS_B.includes(m[2]) &&
    Number.isInteger(parseInt(m[3], 10))
  );
}
