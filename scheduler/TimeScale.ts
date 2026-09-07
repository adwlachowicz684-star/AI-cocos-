/**
 * TimeScale —— 多层时间缩放
 *
 * 【为什么必须做成"多层"】
 *
 * 单一 scale 变量会遇到经典的覆盖问题：
 * ```
 * 玩家开技能 → scale = 0.5（慢动作）
 * 打中敌人   → scale = 0.05（顿帧）
 * 顿帧结束   → scale = ?   ← 该恢复成 0.5 还是 1？
 * ```
 * 单一变量会丢失「慢动作还在生效」这个信息，顿帧结束后要么慢动作没了，
 * 要么得让每个系统自己记住旧值——那就变成了 distributed mess。
 *
 * 多层结构：每层独立记录自己的 scale 和到期时间，最终值 = 各层相乘。
 * 顿帧层到期自动移除，慢动作层不受影响。
 *
 * 【使用示例】
 * ```typescript
 * const ts = new TimeScale();
 *
 * ts.add('hitstop', 0.05, 0.08);   // 顿帧 80ms（第三个参数是真实秒数）
 * ts.add('slowmo', 0.5);            // 慢动作，持续到手动移除
 * ts.add('pause', 0);               // 暂停
 *
 * ts.value;    // 0.05 * 0.5 * 0 = 0
 *
 * ts.remove('pause');
 * ts.value;    // 0.05 * 0.5 = 0.025
 * ```
 */

import { clamp } from '../_core/math';

interface ScaleLayer {
  readonly id: string;
  /** 该层的缩放值 */
  scale: number;
  /**
   * 到期时间（**真实时间戳**，毫秒）
   * null 表示永久，需手动 remove
   */
  expiresAt: number | null;
  /**
   * 是否已暂停（被冻结）
   * 用途：某些层需要「暂时不生效但保留」（如慢动作在剧情演出期间挂起）
   */
  suspended: boolean;
}

export interface TimeScaleOptions {
  /**
   * 最终 scale 的下限
   *
   * 【为什么需要】scale = 0 会让所有 dt 归零。
   * 这对暂停是对的，但如果某个 bug 导致两层相乘意外为 0，
   * 游戏会诡异地完全静止且难以定位。设一个很小但非零的下限
   * （如 0.0001）能让这种 bug 表现为"极慢"而不是"死机"，
   * 反而更容易被发现。
   *
   * **需要真暂停（scale 严格为 0）时，用 `pause()` 显式调用。**
   */
  readonly minScale?: number;
  /**
   * 时间源（默认 `Date.now`）
   *
   * 【为什么要注入（rule2）】
   * `add(..., now = Date.now())` 让模块内部主动去"找"墙钟时间：
   *   - 单测里想表达"过了 100ms"只能真的 sleep 或改全局 Date
   *   - 回放 / 确定性模拟无法控制时间推进
   *
   * 保持默认值为 `Date.now`，所以既有调用方一行都不用改。
   */
  readonly nowProvider?: () => number;
}

export class TimeScale {
  private readonly _layers = new Map<string, ScaleLayer>();
  private readonly _minScale: number;
  private readonly _now: () => number;

  /** 显式暂停（优先级最高，独立于 layer 机制） */
  private _paused = false;

  constructor(opts: TimeScaleOptions = {}) {
    this._minScale = opts.minScale ?? 0;
    this._now = opts.nowProvider ?? (() => Date.now());
  }

  /**
   * 添加一个缩放层
   *
   * @param id 层标识。相同 id 重复添加会**覆盖**旧值（不是叠加两层）
   * @param scale 缩放值（1 = 正常，0 = 冻结，0.5 = 半速）
   * @param durationSeconds 持续时间（**真实秒数**，非缩放时间）
   *
   * 【坑：为什么 duration 必须用真实时间】
   * 顿帧时 scale = 0.05，如果用缩放时间计时，
   * "持续 80ms" 实际需要 80 / 0.05 = 1600ms 的墙钟时间才到期——
   * 顿帧变成了卡顿，手感彻底毁掉。
   *
   * 所以层的到期判定走真实时间线（`unscaledTime`），
   * 只有"游戏内"的计时才受缩放影响。
   */
  add(id: string, scale: number, durationSeconds?: number, now = this._now()): void {
    if (!Number.isFinite(scale) || scale < 0) {
      throw new Error(`[TimeScale] 非法的 scale: ${scale}`);
    }
    /**
     * 【⚠️ 曾经的 bug：durationSeconds 不做校验，顿帧/慢动作被静默丢弃】
     *
     * `expiresAt = now + durationSeconds * 1000`。
     * 传 `0` 或负数时 expiresAt 落在**过去**，
     * 下一次 `update()` 立刻把它当过期层删掉——
     * 于是 `hitStop(-1)` / `slowMotion(0.5, -5)` 之后 `layerCount` 直接是 0，
     * 顿帧像没发生过一样，而且**一个字都不报**。
     *
     * 实测（修复前）：`ts.add('hitstop', 0.05, -1)` → update 后 layerCount = 0。
     *
     * 表现为"打击感没了"/"慢动作没生效"，
     * 排查时第一反应是数值配得不对，很难想到是 duration 的符号。
     *
     * 【为什么是抛错而不是静默改成永久层】
     * 改成永久层更糟：一个本该 80ms 消失的顿帧变成永久 0.05 倍速，
     * 游戏从此一直慢放。传错的 duration 是**调用方的编程错误**，
     * 早炸早发现——这与本方法对非法 `scale` 的处理口径一致。
     */
    if (durationSeconds !== undefined && !Number.isFinite(durationSeconds)) {
      throw new Error(`[TimeScale] 非法的 durationSeconds: ${durationSeconds}`);
    }
    if (durationSeconds !== undefined && durationSeconds <= 0) {
      throw new Error(
        `[TimeScale] durationSeconds 必须为正，收到 ${durationSeconds}（传 undefined 表示永久层）`
      );
    }
    this._layers.set(id, {
      id,
      scale,
      expiresAt: durationSeconds !== undefined ? now + durationSeconds * 1000 : null,
      suspended: false,
    });
  }

  /** 移除一层 */
  remove(id: string): boolean {
    return this._layers.delete(id);
  }

  has(id: string): boolean {
    return this._layers.has(id);
  }

  /** 获取某层当前的 scale（不存在返回 1） */
  get(id: string): number {
    return this._layers.get(id)?.scale ?? 1;
  }

  /** 挂起某层（保留但暂不生效） */
  suspend(id: string): void {
    const l = this._layers.get(id);
    if (l) l.suspended = true;
  }

  resume(id: string): void {
    const l = this._layers.get(id);
    if (l) l.suspended = false;
  }

  /** 显式暂停（等价于最高优先级的 0 层，但语义更清晰且不会被误删） */
  pause(): void {
    this._paused = true;
  }

  unpause(): void {
    this._paused = false;
  }

  get paused(): boolean {
    return this._paused;
  }

  /**
   * 推进真实时间，**清理已到期的层**
   *
   * @param now 真实时间戳（毫秒）。由外部传入而非内部取 Date.now()，
   *            是为了可测试性——单测里能精确控制"时间"。
   */
  update(now = this._now()): void {
    for (const [id, l] of this._layers) {
      if (l.expiresAt !== null && now >= l.expiresAt) {
        this._layers.delete(id);
      }
    }
  }

  /**
   * 最终的合成缩放值
   *
   * 【合成规则：相乘】
   * 这个规则必须在单测里锁死。团队里如果有人以为"取最小"或"取最后添加的"，
   * 数值就会对不上，而且这种错误**没有任何报错**。
   */
  get value(): number {
    if (this._paused) return 0;

    let result = 1;
    for (const l of this._layers.values()) {
      if (l.suspended) continue;
      result *= l.scale;
    }
    return clamp(result, this._minScale, Number.POSITIVE_INFINITY);
  }

  /**
   * 当前活跃层数（调试用）
   *
   * 典型 bug：「游戏莫名变慢」→ 打印这个发现有 5 个慢动作层忘了移除。
   */
  get layerCount(): number {
    return this._layers.size;
  }

  /** 调试：列出所有层 */
  dump(): string {
    if (this._layers.size === 0) return `[TimeScale] 无层（paused=${this._paused}）value=${this.value}`;
    const lines = Array.from(this._layers.values()).map(
      (l) => `  ${l.id}: ${l.scale}${l.suspended ? ' (挂起)' : ''}${l.expiresAt ? ` 到期@${l.expiresAt}` : ' 永久'}`
    );
    return `[TimeScale] value=${this.value} paused=${this._paused}\n${lines.join('\n')}`;
  }

  clear(): void {
    this._layers.clear();
    this._paused = false;
  }

  destroy(): void {
    this.clear();
  }
}
