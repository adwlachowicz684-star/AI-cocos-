/**
 * SkillPlayer —— 时间轴驱动的技能播放器
 *
 * 【这是整个库里最像"轮子"的插件】
 *
 * 「在什么时间发生什么事」是所有游戏都有的需求：
 * 技能、演出、过场、UI 动画、新手引导、Boss 阶段转换。
 * 做成数据驱动的时间轴后，编辑器直接就有了运行时支撑。
 *
 * 【关键设计】
 * ① 时间源由外部 tick(dt) 驱动 —— 不碰 setTimeout，所以暂停/慢动作自动生效
 * ② 事件类型开放注册 —— 调用方加自己的事件类型，核心代码不动
 * ③ seek 支持 —— 编辑器可以拖动播放头预览任意时刻
 *
 * 【使用示例】
 * ```typescript
 * const player = new SkillPlayer();
 *
 * // 注册自定义事件类型
 * player.register('hitbox', (data, ctx) => spawnHitbox(data));
 * player.register('sfx', (data) => Audio.play(data.name));
 *
 * const handle = player.play(track, caster);
 * // 每帧（由主循环调用，传缩放后的 dt）
 * player.tick(dt);
 * // 中断（被控制技能打断、角色死亡）
 * handle.cancel();
 * ```
 */
import { safeDt } from '../_core/math';

import { Track, TrackEvent } from './Track';
import { IDisposable } from '../_core/types';

/**
 * 事件处理器
 * @param data 事件的载荷
 * @param context 播放时传入的上下文（施法者、目标、朝向等）
 */
export type EventHandler = (data: Record<string, unknown> | undefined, context: unknown) => void;

export type SkillState = 'idle' | 'playing' | 'paused' | 'done';

/** 一次播放的句柄 */
export class SkillHandle {
  private _cancelled = false;
  private _player: SkillPlayer;

  /** 外部可监听：结束（正常完成或被取消） */
  onEnd?: (cancelled: boolean) => void;

  constructor(player: SkillPlayer) {
    this._player = player;
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this._player.stop(true);
  }

  pause(): void {
    this._player.pause();
  }

  resume(): void {
    this._player.resume();
  }

  /** 当前播放时间（秒） */
  get time(): number {
    return this._player.currentTime;
  }

  get progress(): number {
    return this._player.progress;
  }
}

export interface SkillPlayerOptions {
  /**
   * 未注册的事件类型是否静默忽略
   * 开发期建议 false（快速失败，拼错类型立刻发现）
   */
  readonly ignoreUnknown?: boolean;
}

export class SkillPlayer implements IDisposable {
  private readonly _handlers = new Map<string, EventHandler>();
  private readonly _ignoreUnknown: boolean;

  private _track: Track | null = null;
  private _handle: SkillHandle | null = null;
  private _context: unknown = null;

  private _time = 0;
  private _state: SkillState = 'idle';

  // 复用缓冲：避免每帧 new 数组（高频路径零分配）
  private readonly _buf: TrackEvent[] = [];

  constructor(opts: SkillPlayerOptions = {}) {
    this._ignoreUnknown = opts.ignoreUnknown ?? false;
  }

  /**
   * 注册事件类型处理器
   *
   * 【为什么用注册表而不是 switch】
   * switch 意味着加一种事件要改播放器源码；
   * 注册表意味着调用方自己扩展，核心永远不变。
   */
  register(type: string, handler: EventHandler, overwrite = false): void {
    if (this._handlers.has(type) && !overwrite) {
      /**
       * 【⚠️ 这里必须 return——老实现只 warn 然后照样覆盖】
       *
       * 实测（修复前）：先 `register('x', fn1)`，
       * 再 `register('x', fn2, false)` → 取出的 handler 执行后确认是 **fn2**，
       * 控制台只有一行容易被日志系统过滤掉的 warn。
       * 而 README 白纸黑字写着「默认**不允许**覆盖」。
       *
       * 后果：两个子系统注册同名事件类型时（例如都注册 'hitbox'），
       * 后者静默顶掉前者，前者功能彻底消失——
       * 表现为"某个技能的判定突然不生效了"。
       * 这是"文档写了但实现相反"里最严重的一档。
       */
      console.warn(
        `[SkillPlayer] 事件类型 "${type}" 已注册，未覆盖（如需覆盖请显式传 overwrite = true）`
      );
      return;
    }
    this._handlers.set(type, handler);
  }

  unregister(type: string): void {
    this._handlers.delete(type);
  }

  /** 开始播放 */
  play(track: Track, context: unknown = null): SkillHandle {
    this.stop(false);

    this._track = track;
    this._context = context;
    this._time = 0;
    this._state = 'playing';
    this._handle = new SkillHandle(this);

    // 【坑】t=0 的事件必须在此刻立即触发，而不是等第一帧 tick。
    // 否则起手特效、起手音效会延迟一帧（约 16ms），在打击感上是可感知的。
    this._fireRange(0, 0, true);

    return this._handle;
  }

  /**
   * 每帧推进
   *
   * 【关键】dt 必须是**经过 timeScale 缩放后的时间**。
   * 这样暂停（scale=0）、慢动作、顿帧全部自动生效，无需额外代码。
   */
  tick(dt: number): void {
    if (this._state !== 'playing' || !this._track) return;

    const step = safeDt(dt) ? dt : 0;
    const prev = this._time;
    this._time += step;

    // 触发 [prev, now) 区间的所有事件
    this._fireRange(prev, this._time, false);

    if (this._time >= this._track.duration) {
      if (this._track.loop) {
        this._time -= this._track.duration;
      } else {
        this.stop(false);
      }
    }
  }

  /**
   * 触发 [from, to) 区间的事件
   * @param inclusiveFrom 是否包含 from 本身（起手瞬间用 true）
   *
   * 【为什么用区间】
   * 一帧可能跨过多个事件（卡顿、倍速、seek）。
   * 用"当前时间精确匹配"会漏事件——这是时间轴播放器的经典 bug。
   */
  private _fireRange(from: number, to: number, inclusiveFrom: boolean): void {
    if (!this._track) return;
    const events = this._track.query(inclusiveFrom ? from : from + 1e-6, to + 1e-6, this._buf);

    for (const e of events) {
      const h = this._handlers.get(e.type);
      if (!h) {
        if (!this._ignoreUnknown) {
          console.error(
            `[SkillPlayer] 未注册的事件类型: "${e.type}"。` +
              `请先调用 player.register('${e.type}', handler)`
          );
        }
        continue;
      }
      try {
        h(e.data, this._context);
      } catch (err) {
        // 一个事件处理器出错不应中断整个技能
        console.error(`[SkillPlayer] 事件 "${e.type}" 执行出错:`, err);
      }
    }
  }

  /**
   * 跳转到指定时间（编辑器预览用）
   *
   * 【注意】seek 不会触发路过的事件——它只用于可视化预览，
   * 不是"快进"。如果需要快进，用多次 tick。
   */
  seek(time: number): void {
    if (!this._track) return;
    this._time = Math.max(0, Math.min(time, this._track.duration));
  }

  pause(): void {
    if (this._state === 'playing') this._state = 'paused';
  }

  resume(): void {
    if (this._state === 'paused') this._state = 'playing';
  }

  /** 停止。cancelled=true 时 onEnd 会收到 true */
  stop(cancelled: boolean): void {
    if (this._state === 'idle') return;

    this._state = 'done';
    const h = this._handle;
    this._handle = null;
    this._track = null;
    this._time = 0;
    this._state = 'idle';

    h?.onEnd?.(cancelled);
  }

  get state(): SkillState {
    return this._state;
  }

  get currentTime(): number {
    return this._time;
  }

  /** 归一化进度 0..1 */
  get progress(): number {
    return this._track ? this._track.progress(this._time) : 0;
  }

  get isPlaying(): boolean {
    return this._state === 'playing';
  }

  /**
   * 当前是否可被取消
   *
   * 【为什么重要】
   * 允许"攻击后摇被冲刺取消"是动作游戏流畅感的核心。
   * 但完全可取消会让动作没有分量，所以要有 cancelAfter 时间点。
   */
  get canCancel(): boolean {
    if (!this._track || !this._track.cancellable) return false;
    return this._time >= this._track.cancelAfter;
  }

  /** 【铁律 5】可卸载 */
  destroy(): void {
    this.stop(true);
    this._handlers.clear();
  }
}
