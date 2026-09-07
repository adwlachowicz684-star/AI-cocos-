/**
 * audio/AudioManager.ts —— 音效播放管理
 *
 * 【它解决什么】
 *
 * 播放音效看起来是一行代码的事：`audio.play('hit')`。
 * 但真跑起来会遇到四个不做就会出问题的地方：
 *
 * 1. **同帧叠加**
 *    5 个怪同时被击中 → 5 个 hit 音效同一毫秒播放 →
 *    波形叠加导致音量爆表，听起来是"啪"的一声爆音（clipping）。
 *
 * 2. **并发上限**
 *    爆炸场景里 30 个音效同时播放，引擎的音频通道被占满，
 *    结果**关键音效排不上队**（预警音被爆炸声挤掉）。
 *    而预警音被掩盖 = 玩家死得莫名其妙。
 *
 * 3. **优先级**
 *    上面那条的解法不是"限制总数"，而是"重要的先播"。
 *    预警音 > 爆炸音 > 脚步音。通道不够时，砍脚步。
 *
 * 4. **音量混合**
 *    主音量 × 分类音量 × 单次音量，三层相乘。
 *    UI 里拖动"音效音量"滑块时，已经在播的音效也要跟着变——
 *    所以不能只记录"播放时的音量"，得在查询时才合成。
 *
 * 【零业务依赖】
 * 它不认识"技能""爆炸""脚步"。
 * 那些只是分类名（字符串），由调用方定义。
 */

import { clamp, clampNum } from '../_core/math';

// ==================== 类型 ====================

/**
 * 音效分类
 *
 * 用字符串而非枚举，是为了让调用方自由定义。
 * 常见分类：'ui' / 'sfx' / 'bgm' / 'voice' / 'ambient'
 */
export type AudioCategory = string;

/** 音效优先级：数值越大越重要 */
export type AudioPriority = number;

export interface PlayOptions {
  /** 音量倍率（默认 1，会与分类音量、主音量相乘） */
  readonly volume?: number;
  /** 优先级（默认 0）。通道不足时，低优先级的会被抢占 */
  readonly priority?: AudioPriority;
  /** 循环播放 */
  readonly loop?: boolean;
  /** 音高（默认 1） */
  readonly pitch?: number;
  /** 左右声道（-1 左 ~ 1 右，默认 0 居中） */
  readonly pan?: number;
  /**
   * 去重窗口（毫秒，默认 0 不去重）
   *
   * 【用途】
   * 密集触发的音效（机关枪、连续命中）设 50~80ms，
   * 窗口内的重复请求会被合并成一次，避免爆音。
   */
  readonly dedupeMs?: number;
  /**
   * 延迟播放（毫秒）
   *
   * 【⚠️ 与游戏内计时的关系】
   * 这里的延迟用**真实时间**计。
   * 用游戏时间的话，暂停时排队的音效会永远等不到触发。
   */
  readonly delayMs?: number;
  /** 分类（默认 'sfx'），决定用哪个分类音量 */
  readonly category?: AudioCategory;
}

/** 正在播放的实例 */
export interface AudioHandle {
  /** 实例 id（唯一） */
  readonly id: number;
  /** 音效 id */
  readonly soundId: string;
  /** 所属分类 */
  readonly category: AudioCategory;
  /** 优先级 */
  readonly priority: AudioPriority;
  /** 开始时刻（真实时间毫秒） */
  readonly startedAt: number;
  /** 是否循环 */
  readonly loop: boolean;
  /** 是否已被停止 */
  stopped: boolean;
  /** 基础音量（不含分类与主音量） */
  baseVolume: number;
  /** 音高 */
  pitch: number;
  /** 声道 */
  pan: number;
}

export interface AudioManagerConfig {
  /**
   * 最大并发实例数（默认 32）
   *
   * 【⚠️ 不是越大越好】
   * 引擎的音频通道数有限（常见 32~64）。
   * 超过之后不是"排队"，而是**播放失败或抢占已有通道**，
   * 结果不可预测。所以在这里就限制住。
   */
  readonly maxVoices?: number;
  /**
   * 单帧内同名音效的最大播放数（默认 3）
   *
   * 防止同帧 20 个 hit 叠加成爆音。
   */
  readonly maxSameSoundPerFrame?: number;
  /**
   * 去重窗口内的同名请求是否累加音量（默认 false）
   *
   * true 的话，5 个怪同时被击中会让音量变成 5 倍——
   * 那正是要避免的爆音。所以默认 false：直接丢弃重复请求。
   */
  readonly accumulateOnDedupe?: boolean;
  /** 主音量（默认 1） */
  readonly masterVolume?: number;
  /** 各分类音量（默认均为 1） */
  readonly categoryVolumes?: Readonly<Record<AudioCategory, number>>;
}

// ==================== 实现 ====================

interface PendingRequest {
  readonly soundId: string;
  readonly opts: PlayOptions;
  /** 应触发的时刻（真实时间毫秒） */
  readonly fireAt: number;
}

let _nextId = 1;

export class AudioManager {
  private readonly _maxVoices: number;
  private readonly _maxSamePerFrame: number;
  private readonly _accumulate: boolean;
  private _master: number;
  private readonly _catVol: Map<AudioCategory, number>;

  /** 活跃实例：id → handle */
  private readonly _active = new Map<number, AudioHandle>();
  /** 延迟队列 */
  private readonly _pending: PendingRequest[] = [];
  /** 去重记录：soundId → 上次播放时刻 */
  private readonly _lastPlayed = new Map<string, number>();
  /** 当前帧的播放计数：soundId → 次数 */
  private _frameCounts = new Map<string, number>();
  /** 当前帧号（由 beginFrame 推进） */
  private _frame = 0;
  /** 当前时间（真实时间毫秒，由 update 推进） */
  private _now = 0;

  /** 统计：被并发上限拒绝的次数 */
  private _rejected = 0;
  /** 统计：被去重丢弃的次数 */
  private _deduped = 0;
  /** 统计：被抢占的次数 */
  private _evicted = 0;

  constructor(cfg: AudioManagerConfig = {}) {
    /**
     * 【⚠️ 容量类字段必须用 clampNum 收口，不能用裸 `??`】
     *
     * `??` 只挡 null/undefined，挡不住 NaN。
     * 而 `if (this._active.size >= this._maxVoices)` 在 NaN 时恒为 false
     * → **"通道已满 → 抢占/拒绝"这条保护路径永不进入**。
     *
     * 实测（修复前）：`{maxVoices: NaN}` 时播 500 个不同音效，
     * 活跃数 = **500**（上限完全失效）。
     * 对照 `{maxVoices: 32}` → 活跃数 32，正常。
     *
     * 后果是内存/句柄泄漏：`_active` Map 只增不减，
     * 引擎侧音频通道被打爆，表现为"声音逐渐失真/卡顿，内存持续上涨"，
     * 而 `describe()` 打印的是 `活跃 500/NaN`，需要仔细看才发现。
     */
    /**
     * 【⚠️ 下界必须是 0，不能是 1】
     *
     * 第一版我写成 `clampNum(cfg.maxVoices, 1, 512, 32)`，
     * 把 `maxVoices: 0` 也夹成了 1——结果"静音配置"变成"允许 1 个音效"，
     * 既有测试 `new AudioManager({maxVoices: 0})` 期望 `rejected > 0` 立刻变红。
     *
     * `0` 是**有意义的配置**（完全静音），不是非法值。
     * 这里要拦的只有 NaN（以及离谱的大值），不该顺手重定义合法语义。
     */
    this._maxVoices = clampNum(cfg.maxVoices, 0, 512, 32);
    this._maxSamePerFrame = cfg.maxSameSoundPerFrame ?? 3;
    this._accumulate = cfg.accumulateOnDedupe ?? false;
    /**
     * 【⚠️ 主音量必须用 clampNum 收口，`clamp(v ?? 1, 0, 1)` 挡不住 NaN】
     *
     * `??` 只挡 null/undefined；而 `clamp` 本身是 `Math.min(Math.max(v, lo), hi)`，
     * `Math.max(NaN, 0)` 仍是 **NaN** → 主音量直接变成 NaN。
     *
     * 实测（修复前）：`new AudioManager({masterVolume: NaN}).effectiveVolume(1)`
     * 返回 **NaN**。这个 NaN 会一路传给引擎的音频接口，
     * 表现通常是"静音"或"爆音"，而且**不报错、不打印任何警告**——
     * 排查时只会看到"声音没了"，看不到音量字段是 NaN。
     *
     * 主音量的常见来源是玩家设置存档（拖滑块 → 序列化 → 读档），
     * 存档被截断/版本升级字段缺失时就是 NaN，属于真实的到达路径。
     *
     * 【为什么下界是 0 上界是 1】
     * 0 = 静音，是合法配置（不是非法值），不能被夹成 1。
     * 这里要拦的只有 NaN 和越界值，顺手重定义合法语义会踩 `maxVoices` 那个坑。
     */
    this._master = clampNum(cfg.masterVolume, 0, 1, 1);
    this._catVol = new Map(Object.entries(cfg.categoryVolumes ?? {}));
  }

  // ==================== 时间推进 ====================

  /**
   * 每帧调用一次，推进时间并处理延迟队列
   *
   * @param now 真实时间毫秒（Date.now()）
   *
   * 【⚠️ 必须是真实时间】
   * 用游戏时间的话，暂停时延迟音效永远不触发，
   * 恢复后又可能一次性全部涌出。
   */
  update(now: number): void {
    this._now = now;
    this._frame++;

    // 帧计数每帧清零
    // 【性能】早期每帧 new 一个 Map，60fps 下每秒 60 次分配。
    // 这些 Map 活不过一帧却要进新生代 GC。clear() 语义完全一样，零分配。
    this._frameCounts.clear();

    // 处理到期的延迟请求
    if (this._pending.length > 0) {
      const due: PendingRequest[] = [];
      for (let i = this._pending.length - 1; i >= 0; i--) {
        const p = this._pending[i]!;
        if (p.fireAt <= now) {
          due.push(p);
          this._pending.splice(i, 1);
        }
      }
      due.sort((a, b) => a.fireAt - b.fireAt);
      for (const p of due) this._spawn(p.soundId, p.opts);
    }
  }

  /** 推进一帧（内部时间递增，便于无时钟环境测试） */
  tick(deltaMs: number): void {
    this.update(this._now + deltaMs);
  }

  get now(): number {
    return this._now;
  }

  get frame(): number {
    return this._frame;
  }

  // ==================== 播放 ====================

  /**
   * 播放音效
   *
   * @returns handle，通道不足或去重被拦时返回 null
   */
  play(soundId: string, opts: PlayOptions = {}): AudioHandle | null {
    const delay = opts.delayMs ?? 0;
    if (delay > 0) {
      this._pending.push({ soundId, opts, fireAt: this._now + delay });
      /**
       * 【延迟播放不返回 handle】
       * 它还不存在。调用方需要控制的话，
       * 应该自己记录返回的 null 并稍后重新查询。
       */
      return null;
    }
    return this._spawn(soundId, opts);
  }

  private _spawn(soundId: string, opts: PlayOptions): AudioHandle | null {
    const category = opts.category ?? 'sfx';
    const priority = opts.priority ?? 0;

    // ① 去重窗口
    const dedupe = opts.dedupeMs ?? 0;
    if (dedupe > 0) {
      const last = this._lastPlayed.get(soundId);
      if (last !== undefined && this._now - last < dedupe) {
        this._deduped++;
        if (this._accumulate) {
          // 累加模式：把音量叠加到已有的活跃实例上（由调用方负责 clamp）
          const existing = this._findActive(soundId);
          if (existing) existing.baseVolume += opts.volume ?? 1;
        }
        return null;
      }
    }

    // ② 同帧同名上限
    const n = this._frameCounts.get(soundId) ?? 0;
    if (n >= this._maxSamePerFrame) {
      this._deduped++;
      return null;
    }

    // ③ 并发上限：先尝试抢占
    if (this._active.size >= this._maxVoices) {
      const victim = this._pickEvictable(priority);
      if (victim === null) {
        this._rejected++;
        return null;
      }
      this._active.delete(victim.id);
      victim.stopped = true;
      this._evicted++;
    }

    const h: AudioHandle = {
      id: _nextId++,
      soundId,
      category,
      priority,
      startedAt: this._now,
      loop: opts.loop ?? false,
      stopped: false,
      baseVolume: clamp(opts.volume ?? 1, 0, 4),
      pitch: clamp(opts.pitch ?? 1, 0.0625, 16),
      pan: clamp(opts.pan ?? 0, -1, 1),
    };

    this._active.set(h.id, h);
    this._lastPlayed.set(soundId, this._now);
    this._frameCounts.set(soundId, n + 1);
    return h;
  }

  /**
   * 挑一个可以被抢占的实例
   *
   * 【判据】
   * 1. 只抢优先级**更低**的（同级或更高的不动，避免抖动）
   * 2. 同级里抢**最早开始**的
   * 3. 循环音效不抢（它是持续状态，抢掉会听出来"断了"）
   */
  private _pickEvictable(priority: AudioPriority): AudioHandle | null {
    let best: AudioHandle | null = null;
    for (const h of this._active.values()) {
      if (h.loop) continue;
      if (h.priority >= priority) continue;
      if (best === null
        || h.priority < best.priority
        || (h.priority === best.priority && h.startedAt < best.startedAt)) {
        best = h;
      }
    }
    return best;
  }

  private _findActive(soundId: string): AudioHandle | null {
    for (const h of this._active.values()) {
      if (h.soundId === soundId) return h;
    }
    return null;
  }

  // ==================== 停止 ====================

  /** 停止单个实例 */
  stop(id: number): boolean {
    const h = this._active.get(id);
    if (!h) return false;
    this._active.delete(id);
    h.stopped = true;
    return true;
  }

  /** 停止某个音效的全部实例 */
  stopSound(soundId: string): number {
    let n = 0;
    for (const [id, h] of [...this._active]) {
      if (h.soundId === soundId) {
        this._active.delete(id);
        h.stopped = true;
        n++;
      }
    }
    return n;
  }

  /** 停止某个分类的全部实例 */
  stopCategory(category: AudioCategory): number {
    let n = 0;
    for (const [id, h] of [...this._active]) {
      if (h.category === category) {
        this._active.delete(id);
        h.stopped = true;
        n++;
      }
    }
    return n;
  }

  /**
   * 停止全部（含清空延迟队列）
   *
   * 【⚠️ 场景切换时必须调用】
   * 否则上一个场景的循环音效会跟着进下一个场景。
   */
  stopAll(): void {
    for (const h of this._active.values()) h.stopped = true;
    this._active.clear();
    this._pending.length = 0;
  }

  // ==================== 音量 ====================

  /** 设置主音量 */
  setMasterVolume(v: number): void {
    this._master = clamp(v, 0, 1);
  }

  get masterVolume(): number {
    return this._master;
  }

  /** 设置分类音量 */
  setCategoryVolume(category: AudioCategory, v: number): void {
    this._catVol.set(category, clamp(v, 0, 1));
  }

  getCategoryVolume(category: AudioCategory): number {
    return this._catVol.get(category) ?? 1;
  }

  /**
   * 计算某实例的实际音量
   *
   * 【⚠️ 这里只读不缓存】
   * 因为分类音量和主音量随时可能被改（玩家拖滑块），
   * 缓存了就会出现"拖了滑块但正在播的音效没变"。
   */
  effectiveVolume(id: number): number {
    const h = this._active.get(id);
    if (!h) return 0;
    return clamp(
      h.baseVolume * (this._catVol.get(h.category) ?? 1) * this._master,
      0, 4
    );
  }

  // ==================== 查询 ====================

  get activeCount(): number {
    return this._active.size;
  }

  get pendingCount(): number {
    return this._pending.length;
  }

  /** 按分类统计活跃数 */
  countByCategory(): ReadonlyMap<AudioCategory, number> {
    const m = new Map<AudioCategory, number>();
    for (const h of this._active.values()) {
      m.set(h.category, (m.get(h.category) ?? 0) + 1);
    }
    return m;
  }

  /** 活跃实例（只读快照） */
  active(): readonly AudioHandle[] {
    return [...this._active.values()];
  }

  /** 是否正在播放某音效 */
  isPlaying(soundId: string): boolean {
    return this._findActive(soundId) !== null;
  }

  // ==================== 统计（排查"音效听不见了"用） ====================

  get stats(): {
    readonly rejected: number;
    readonly deduped: number;
    readonly evicted: number;
  } {
    return { rejected: this._rejected, deduped: this._deduped, evicted: this._evicted };
  }

  resetStats(): void {
    this._rejected = 0;
    this._deduped = 0;
    this._evicted = 0;
  }

  /**
   * 生成诊断文本
   *
   * 【为什么需要】
   * "玩家听不到预警音"是最难查的 bug 之一——
   * 代码看起来在播，但实际被并发上限拒了。
   * 有了 stats 就能一眼看出是"没调用"还是"被拒了"。
   */
  describe(): string {
    const s = this.stats;
    const byCat = [...this.countByCategory()]
      .map(([k, v]) => `${k}:${v}`).join(' ');
    return `活跃 ${this.activeCount}/${this._maxVoices}  待播 ${this.pendingCount}\n`
      + `分类 [${byCat}]\n`
      + `被拒 ${s.rejected}（通道满且无可抢占）  `
      + `去重 ${s.deduped}  抢占 ${s.evicted}`;
  }
}

// ==================== 便捷：常见优先级 ====================

/**
 * 优先级常量（仅作参考，调用方可自定义数值）
 *
 * 【设计意图】
 * 让"关键音效永远排得上队"这件事变成配置，而不是运气。
 */
export const PRIORITY = {
  /** 最低：环境音、脚步 */
  AMBIENT: -20,
  /** 低：一般打击、UI 反馈 */
  LOW: -10,
  /** 普通 */
  NORMAL: 0,
  /** 高：爆炸、技能音效 */
  HIGH: 10,
  /**
   * 最高：预警音
   *
   * 【⚠️ 预警音必须是最高优先级】
   * 它被掩盖 = 玩家死得莫名其妙 = 玩家认为游戏不公平。
   */
  CRITICAL: 20,
} as const;
