/**
 * Track —— 技能时间轴（纯数据 + 求值）
 *
 * 【这是"数据驱动"的关键零件】
 *
 * 把「在什么时间发生什么事」表达成一份 JSON 后：
 * - 加一个技能 = 加一份配置，不改代码
 * - 编辑器可以直接读写它（可视化编辑）
 * - 可以预览任意时刻（编辑器 scrub）
 * - 可以和动画的判定帧对齐
 *
 * 【它的用途远不止技能】
 * 演出、过场、UI 动画、新手引导、Boss 阶段转换——
 * 所有"按时间发生一串事"的需求都能用这一套。
 */

import { clamp01, clampNum } from '../_core/math';

/**
 * 时间轴事件类型
 *
 * 【为什么要开放自定义】
 * 内置的类型永远不够用。关键设计是**注册表**：
 * 调用方注册自己的类型，播放器负责在正确的时间调用它。
 * 这样核心代码一行都不用改。
 */
export type TrackEventType = 'anim' | 'hitbox' | 'projectile' | 'sfx' | 'vfx' | 'buff' | 'custom';

export interface TrackEvent {
  /** 触发时间（秒，从技能开始算） */
  readonly t: number;
  readonly type: TrackEventType | string;
  /** 载荷：具体内容由类型决定，例如 { name: 'attack_heavy' } / { shape:'sector', r:2.5 } */
  readonly data?: Record<string, unknown>;
}

export interface TrackData {
  /** 技能总时长（秒） */
  readonly duration: number;
  /** 事件列表（无需排序，构造时会排序） */
  readonly events: readonly TrackEvent[];
  /** 是否可被其他动作取消（后摇取消，手感关键） */
  readonly cancellable?: boolean;
  /** 可取消的时间点（秒）——在此之前不可取消 */
  readonly cancelAfter?: number;
  /** 是否循环（用于持续型演出） */
  readonly loop?: boolean;
}

export interface TrackSchema {
  readonly version: number;
  readonly data: TrackData;
}

export const TRACK_SCHEMA_VERSION = 1;

export class Track {
  readonly duration: number;
  readonly cancellable: boolean;
  readonly cancelAfter: number;
  readonly loop: boolean;

  /** 按时间升序排列的事件（构造时排序，这样播放时不用每帧排序） */
  private readonly _events: TrackEvent[];

  constructor(data: TrackData) {
    // 【为什么 fallback 是 0】data 来自外部构造的轨道数据。
    // 时长为 0 的轨道会立刻播完，属于"可见的异常"；NaN 则是静默死锁。
    this.duration = clampNum(data.duration, 0, 1e6, 0);
    this.cancellable = data.cancellable ?? false;
    this.cancelAfter = data.cancelAfter ?? 0;
    this.loop = data.loop ?? false;

    this._events = data.events.slice().sort((a, b) => a.t - b.t);

    // 【校验】时间不能为负
    for (const e of this._events) {
      if (e.t < 0) throw new Error(`[Track] 事件时间为负: ${e.t}`);
    }
  }

  /** 从 JSON 构建 */
  static from(data: TrackData): Track {
    return new Track(data);
  }

  /** 序列化（往返无损） */
  toJSON(): TrackSchema {
    return {
      version: TRACK_SCHEMA_VERSION,
      data: {
        duration: this.duration,
        cancellable: this.cancellable,
        cancelAfter: this.cancelAfter,
        loop: this.loop,
        events: this._events.map((e) => ({ t: e.t, type: e.type, data: e.data })),
      },
    };
  }

  static fromJSON(json: TrackSchema): Track {
    if (json.version !== TRACK_SCHEMA_VERSION) {
      console.warn(`[Track] schema 版本不匹配（${json.version} vs ${TRACK_SCHEMA_VERSION}），尝试兼容加载`);
    }
    return new Track(json.data);
  }

  /**
   * 校验：返回错误列表（空数组 = 合法）
   *
   * 【为什么要一次报全】
   * 如果校验器遇到第一个错误就停，你就要"改一个→重启→再改一个"
   * 循环几十次。一次列出全部错误，十分钟改完，体验完全不同。
   */
  static validate(data: TrackData): string[] {
    const errors: string[] = [];

    if (typeof data.duration !== 'number' || data.duration < 0) {
      errors.push('duration 必须是非负数');
    }
    if (!Array.isArray(data.events)) {
      errors.push('events 必须是数组');
      return errors;
    }

    let prev = -Infinity;
    data.events.forEach((e, i) => {
      if (typeof e.t !== 'number' || e.t < 0) {
        errors.push(`events[${i}].t 必须是非负数`);
      }
      if (e.t < prev) {
        errors.push(`events[${i}].t 未递增（前一个 ${prev}）`);
      }
      prev = e.t;

      if (!e.type) errors.push(`events[${i}].type 不能为空`);

      if (e.t > (data.duration ?? 0)) {
        errors.push(`events[${i}].t (${e.t}) 超出了技能时长 (${data.duration})，该事件不会触发`);
      }
    });

    return errors;
  }

  /**
   * 查询 [fromTime, toTime) 区间内的事件
   *
   * 【为什么用区间而不是"当前帧"】
   * 帧间隔可能跨过多个事件（卡顿、倍速播放、seek）。
   * 用区间查询保证**不漏事件**——用"当前时间精确匹配"会漏。
   *
   * @param out 复用数组，避免每次分配（高频路径无 GC）
   */
  query(fromTime: number, toTime: number, out: TrackEvent[] = []): TrackEvent[] {
    out.length = 0;
    for (const e of this._events) {
      if (e.t >= fromTime && e.t < toTime) out.push(e);
      else if (e.t >= toTime) break; // 已排序，后面的更晚
    }
    return out;
  }

  /** 所有事件（只读） */
  get events(): readonly TrackEvent[] {
    return this._events;
  }

  /**
   * 从帧号换算时间（美术标注用）
   *
   * 【为什么有这个方法】
   * 美术给你的标注是"第 15 帧出判定"，你需要换算成秒写在配置里。
   * 帧率搞错（24/30/60）会导致判定与动画错位 3 帧——
   * 玩家就会觉得"打空了"，这是动作游戏手感的第一杀手。
   */
  static frameToTime(frame: number, fps = 30): number {
    return frame / fps;
  }

  /** 归一化进度（0..1），便于 UI 与编辑器显示 */
  progress(time: number): number {
    return this.duration <= 0 ? 1 : clamp01(time / this.duration);
  }
}
