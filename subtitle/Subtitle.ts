/**
 * subtitle/Subtitle.ts —— 字幕系统
 *
 * 【它解决什么】
 *
 * 对话字幕看起来就是"按时间显示一行字"。真正麻烦的是：
 *
 * 1. **说话人切换**
 *    同一时刻可能有多人（画外音 + 对话），
 *    不做区分的话两条字幕会互相覆盖。
 *
 * 2. **提前结束**
 *    玩家点了"跳过"，当前这条要立刻结束并进入下一条，
 *    而不是等它自己播完。
 *
 * 3. **快进**
 *    玩家连点跳过时，字幕应该快速掠过而不是卡住不动。
 *
 * 4. **时间轴驱动**
 *    字幕必须跟着"当前播放到第几毫秒"走，
 *    而不是自己维护一个计时器——否则暂停/变速后会漂移。
 *
 * 【核心设计】
 *
 * 字幕是**纯查询**（给定时间，返回该显示什么），
 * 不持有播放状态。这样它天然支持 seek、快进、倒退，
 * 也天然可测试。
 *
 * 【零业务依赖】
 *
 * 【使用示例】
 * ```typescript
 * // 从 SRT 文本解析（也支持手工构造 lines）
 * const track = new SubtitleTrack({ lines: parseSRT(srtText) });
 *
 * // 每帧按播放时间查询当前该显示哪些行（单位：毫秒）
 * for (const a of track.at(playTimeMs)) {
 *   showText(a.line.text, a.speakerLabel);
 * }
 *
 * track.speakersAt(playTimeMs);  // 当前正在说话的人（可用于分屏高亮）
 * ```
 *
 * 【⚠️ 时间单位统一是毫秒】
 * `SubtitleLine.start` / `.end`、`at()` / `speakersAt()` 的入参**都是毫秒**，
 * `parseSRT` 也不做换算（SRT 里的 `00:00:01,000` 解析成 `1000`）。
 * 实测：`parseSRT` 得 `{start:1000,end:3000}`，`at(1)` 命中 0 条而 `at(1000)` 命中 1 条。
 * 若按秒传，字幕将**永远不显示且不报错**——半开区间 `[start, end)` 匹配不上任何行。
 */

// ==================== 类型 ====================

export interface SubtitleLine {
  /** 开始时间（毫秒） */
  readonly start: number;
  /** 结束时间（毫秒） */
  readonly end: number;
  readonly text: string;
  /** 说话人 id。为空表示旁白 */
  readonly speaker?: string;
  /** 说话人显示名（不传则直接用 speaker） */
  readonly speakerName?: string;
  /**
   * 语气/情绪标记
   *
   * 【用途】配音系统是"同一句话多个版本"时，用它选版本；
   * 也可以驱动立绘表情。
   */
  readonly emotion?: string;
  /**
   * 即使玩家跳过语音也要显示（重要剧情不跳过）
   */
  readonly essential?: boolean;
  readonly data?: unknown;
}

export interface SubtitleTrackOptions {
  readonly lines: readonly SubtitleLine[];
  /** 说话人 id → 显示名/颜色 */
  readonly speakers?: Readonly<Record<string, { name?: string; color?: string; data?: unknown }>>;
}

export interface ActiveSubtitle {
  readonly line: SubtitleLine;
  readonly index: number;
  /** 说话人显示名 */
  readonly speakerLabel: string | null;
  /** 说话人颜色 */
  readonly speakerColor: string | null;
  /** 当前这条已经播了多久（毫秒） */
  readonly elapsed: number;
  /** 播放进度 0~1（用于打字机效果） */
  readonly progress: number;
}

// ==================== 实现 ====================

export class SubtitleTrack {
  private readonly _lines: SubtitleLine[];
  private readonly _speakers: Readonly<Record<string, { name?: string; color?: string; data?: unknown }>>;
  /** 前 i 行里最大的 end（见构造函数注释），长度 = 行数 + 1 */
  private readonly _maxEndBefore: number[];

  constructor(opts: SubtitleTrackOptions) {
    this._speakers = opts.speakers ?? {};

    // 按开始时间排序（配置里的顺序不该影响正确性）
    this._lines = opts.lines.slice().sort((a, b) => a.start - b.start);

    for (let i = 0; i < this._lines.length; i++) {
      const l = this._lines[i];
      if (l.end < l.start) {
        throw new Error(
          `[Subtitle] 第 ${i} 行的结束时间 ${l.end} 早于开始时间 ${l.start}`
        );
      }
    }

    /**
     * `maxEndBefore[i]` = 前 i 行里最大的 end（前缀最大值）
     *
     * 【用途】`at()` 二分到命中点后要向前回溯，找那些"开始得更早、
     * 但区间更长、此刻仍在播"的行（画外音压着好几条对话是常态）。
     * 最坏情况要一路回溯到数组头，退化回 O(n)。
     *
     * 有了前缀最大值，回溯时一旦 `maxEndBefore[i] <= time`
     * 就能立刻停：更早的行全都在这个时间之前结束了，不可能还在播。
     * 于是回溯长度只取决于**真正重叠的行数**，而不是总行数。
     */
    this._maxEndBefore = new Array<number>(this._lines.length + 1);
    this._maxEndBefore[0] = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this._lines.length; i++) {
      const prev = this._maxEndBefore[i];
      const end = this._lines[i].end;
      this._maxEndBefore[i + 1] = end > prev ? end : prev;
    }
  }

  get lines(): readonly SubtitleLine[] {
    return this._lines;
  }

  get duration(): number {
    let max = 0;
    for (const l of this._lines) if (l.end > max) max = l.end;
    return max;
  }

  /**
   * 查询某个时刻应该显示的字幕
   *
   * 【⚠️ 可能同时有多条】
   * 画外音和对话重叠是常态，所以返回数组而不是单条。
   */
  at(time: number): ActiveSubtitle[] {
    const out: ActiveSubtitle[] = [];

    /**
     * 【⚠️ 曾经的 bug：每次查询都从数组头扫到命中点】
     *
     * 字幕是**每帧查询**的（`at(playTimeMs)` 在渲染循环里），
     * 而原实现从头遍历直到 `l.start > time` 才 break——
     * 也就是每次都要走过**前面所有**已经播完的行。
     *
     * 电影级长字幕 3000+ 行时：
     *   片尾那一段 = 每次查询走 3000 次迭代 × 60fps = 每秒 18 万次
     * 而且越往后越慢——性能问题**只在长片尾出现**，
     * 用几十行的样片自测完全测不出来。
     *
     * 实测（修复前）：3000 行、查询 290 万毫秒附近 600 次 = 10ms；
     * 行数再翻十倍就是 100ms——足以在片尾看到掉帧。
     *
     * 修法：数组按 start 排序（构造时已排），
     * 用二分找到"最后一条 start <= time"的位置，
     * 再从那里**向前**回溯（重叠区间可能跨越很多行）。
     */
    const n = this._lines.length;
    if (n === 0) return out;
    if (!Number.isFinite(time)) return out;

    // 二分：找最后一个满足 start <= time 的下标
    let lo = 0;
    let hi = n - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this._lines[mid].start <= time) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx < 0) return out;   // 还没到第一条

    // 从 idx 向前回溯：更早的行可能区间更长、仍然在播
    let i = idx;
    while (i >= 0) {
      const l = this._lines[i];
      // 已经不可能有更早的行覆盖到 time（行按 start 排序，
      // 且这里额外用 maxEnd 前缀加速：见 _maxEndBefore）
      if (this._maxEndBefore[i + 1] <= time) break;
      if (time >= l.start && time < l.end) {
        const sp = l.speaker ? this._speakers[l.speaker] : undefined;
        const span = Math.max(1, l.end - l.start);
        out.push({
          line: l,
          index: i,
          speakerLabel: sp?.name ?? l.speakerName ?? (l.speaker ?? null),
          speakerColor: sp?.color ?? null,
          elapsed: time - l.start,
          progress: Math.min(1, (time - l.start) / span),
        });
      }
      i--;
    }
    out.reverse();   // 保持与修复前一致：按时间先后升序
    return out;
  }

  /** 当前时刻的说话人列表（用于立绘高亮） */
  speakersAt(time: number): string[] {
    const s = new Set<string>();
    for (const a of this.at(time)) {
      if (a.line.speaker) s.add(a.line.speaker);
    }
    return [...s];
  }

  /** 下一条字幕的索引（-1 表示已结束） */
  nextIndex(time: number): number {
    for (let i = 0; i < this._lines.length; i++) {
      if (this._lines[i].start > time) return i;
    }
    return -1;
  }

  /**
   * 跳到下一条
   *
   * 【⚠️ 跳过语义】
   * 跳到"下一条开始"，而不是"当前这条结束"。
   * 后者在有空档时会导致跳过后要等一段空白。
   *
   * @returns 新的时间；已是最后一条则返回当前时间
   */
  skipToNext(time: number): number {
    const n = this.nextIndex(time);
    return n === -1 ? time : this._lines[n].start;
  }

  /**
   * 快进：跳过当前这条，但如果下一条是 essential 也照样停
   *
   * @returns 新的时间
   */
  advance(time: number): number {
    return this.skipToNext(time);
  }

  /** 全部台词去重后的说话人 */
  get allSpeakers(): string[] {
    const s = new Set<string>();
    for (const l of this._lines) if (l.speaker) s.add(l.speaker);
    return [...s];
  }

  /** 某位说话人的总台词数（用于统计/成就） */
  lineCountOf(speaker: string): number {
    let n = 0;
    for (const l of this._lines) if (l.speaker === speaker) n++;
    return n;
  }
}

// ==================== 字幕解析 ====================

/**
 * 极简 SRT 解析
 *
 * 【为什么自己写而不用现成库】
 * 1. 零依赖是本项目第一原则
 * 2. 游戏里的字幕常常带自定义标记（说话人、情绪），通用解析器处理不了
 *
 * 支持格式：
 * ```
 * 1
 * 00:00:01,000 --> 00:00:03,500
 * 旁白文本
 * ```
 *
 * 也支持行首 `【角色名】` 或 `角色名：` 作为说话人。
 */
export function parseSRT(src: string): SubtitleLine[] {
  const lines: SubtitleLine[] = [];
  const blocks = src.replace(/\r\n/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const rows = block.split('\n').filter((r) => r.trim() !== '');
    if (rows.length < 2) continue;

    // 第一行可能是序号
    let i = 0;
    if (/^\d+$/.test(rows[0].trim())) i = 1;
    if (i >= rows.length) continue;

    const timeRow = rows[i];
    const m = timeRow.match(
      /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/
    );
    if (!m) continue;

    const start =
      (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + padMs(m[4]);
    const end =
      (+m[5] * 3600 + +m[6] * 60 + +m[7]) * 1000 + padMs(m[8]);

    const text = rows.slice(i + 1).join('\n').trim();
    if (!text) continue;

    // 提取说话人：【角色名】或 角色名：
    let speaker: string | undefined;
    let body = text;
    const bracket = body.match(/^【(.+?)】\s*/);
    const colon = body.match(/^([^：:\n]{1,12})[：:]\s*/);
    if (bracket) {
      speaker = bracket[1];
      body = body.slice(bracket[0].length);
    } else if (colon) {
      speaker = colon[1];
      body = body.slice(colon[0].length);
    }

    lines.push({ start, end, text: body, speaker });
  }

  return lines;
}

/** "5" → 500，"05" → 50，"500" → 500 */
function padMs(s: string): number {
  if (s.length === 1) return +s * 100;
  if (s.length === 2) return +s * 10;
  return +s;
}

/**
 * 导出为 SRT
 *
 * 【用途】配好之后导给配音/本地化，
 * 或者做"字幕校对"工具时回写。
 */
export function toSRT(lines: readonly SubtitleLine[]): string {
  return lines
    .map((l, i) => {
      const head = `${i + 1}\n${fmt(l.start)} --> ${fmt(l.end)}`;
      const prefix = l.speaker ? `【${l.speaker}】` : '';
      return `${head}\n${prefix}${l.text}`;
    })
    .join('\n\n');
}

function fmt(ms: number): string {
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = Math.floor(ms % 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(r).padStart(3, '0')}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
