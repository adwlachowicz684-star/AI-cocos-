/**
 * bullet-pattern/BulletPattern.ts —— 弹幕发射器
 *
 * 【它解决什么】
 *
 * Boss 战的核心表现手段：
 *
 * ```
 * 环形弹幕 → 螺旋弹幕 → 定向散射 → 全屏天女散花
 * ```
 *
 * 手写这些模式的常见下场：
 * - 代码里写死一堆 `for (let i = 0; i < N; i++)`，改一个参数要翻半天
 * - 角度算错，弹幕歪向一边（弧度/角度混用）
 * - 多发射器时间对不齐，节奏乱掉
 *
 * 本模块把弹幕拆成三层：
 *
 * | 层 | 职责 |
 * |---|---|
 * | **Emitter（发射器）** | 在哪、朝哪、什么时候开火 |
 * | **Shape（形状）** | 一次开火打出什么排列（环/弧/螺旋/扇形…） |
 * | **Sequence（编排）** | 一串开火事件的时间轴 |
 *
 * 【零业务依赖】
 *
 * 它不创建子弹实体、不做碰撞。
 * 每次开火产出一堆 `BulletSpawn`（纯数据：位置/方向/速度/类型 id），
 * 业务拿去生成自己的子弹。
 *
 * 【确定性】
 *
 * 随机源注入 + 螺旋状态可序列化 →
 * 同一个种子在任何机器上产出完全相同的弹幕。
 * 这让 Boss 战可以**回放、录像、自动化测试**。
 */

import { IRandomSource } from '../_core/types';
import { clamp, numOr, safeDt } from '../_core/math';
import { needCount } from '../_core/guard';

// ============================================================
// 数据结构
// ============================================================

/** 一次开火产出的一颗子弹（纯数据） */
export interface BulletSpawn {
  /** 子弹类型 id（业务定义，本模块不解释） */
  readonly typeId: string;
  readonly x: number;
  readonly y: number;
  /** 方向（弧度，0 = +X） */
  readonly angle: number;
  readonly speed: number;
  /** 本次开火的序号（用于给螺旋等模式做分组） */
  readonly shotIndex: number;
  /** 同一次开火内的第几颗 */
  readonly indexInShot: number;
  /** 业务数据（原样透传） */
  readonly data?: unknown;
}

// ============================================================
// 形状
// ============================================================

/** 形状上下文（形状函数根据它算角度） */
export interface ShapeContext {
  /** 发射器朝向（弧度） */
  readonly aim: number;
  /** 第几次开火（0 开始）——螺旋靠它推进 */
  readonly shotIndex: number;
  /** 随机源 */
  readonly rng: IRandomSource;
}

/** 形状函数：返回相对 `aim` 的角度偏移数组（弧度） */
export type ShapeFn = (ctx: ShapeContext) => number[];

/** 形状定义（配置友好） */
export interface ShapeSpec {
  /** 每份几颗 */
  count: number;
  /** 类型 id */
  typeId: string;

  // ↓ 以下互斥，优先按 spread/burst/random 顺序判定

  /** 环形：count 颗均匀分布在 360° */
  fullCircle?: boolean;
  /** 扇形张角（度）。与 count 配合 = 扇形散射 */
  spreadDeg?: number;
  /** 螺旋：每次开火整体旋转的度数 */
  spiralStepDeg?: number;
  /** 垂直排列（扇形/环形的正交方向），用于"墙"形弹幕 */
  perpendicular?: boolean;
  /** 随机抖动（度），让弹幕不那么机械 */
  jitterDeg?: number;
  /** 速度。可为数组（按 index 取模）或单值 */
  speed: number | number[];
  /** 双向对称（左右各一份） */
  mirrored?: boolean;
  /** 业务数据 */
  data?: unknown;
}

const DEG = Math.PI / 180;

/**
 * 把配置编译成形状函数
 *
 * 【为什么编译一次】
 * 弹幕每帧可能开火几十次，每次都重新解析配置对象
 * （判断 fullCircle / spreadDeg / mirrored…）是浪费。
 * 编译成闭包后，每次开火只做纯算术。
 */
export function compileShape(spec: ShapeSpec): ShapeFn {
  /**
   * 【⚠️ count 必须有上界】
   *
   * `count` 直接就是下面几个 `for (let i = 0; i < count; i++)` 的次数，
   * 每个循环都往 `out` 里 push 一个角度。
   *
   * 实测 `compileShape({ count: Infinity, ... })`：
   * 进程以 **Fatal JavaScript invalid size error** 直接崩溃（退出码 133）——
   * 数组无限 push 直到 V8 内存分配失败，**连异常都抓不到**，
   * 比死循环更糟，因为 try/catch 完全无效。
   *
   * 老实现 `Math.max(1, spec.count)` 只挡了小于 1 的情况，
   * Infinity 畅通无阻，NaN 也会被 `Math.max(1, NaN)` 变成 NaN 后
   * 让循环条件 `i < NaN` 恒假 —— 静默生成 0 颗子弹。
   */
  const count = Math.max(1, needCount(spec.count, 'spec.count'));
  const mirrored = spec.mirrored ?? false;

  return (ctx: ShapeContext): number[] => {
    const out: number[] = [];
    const spiral = (spec.spiralStepDeg ?? 0) * DEG * ctx.shotIndex;

    if (spec.fullCircle) {
      // 【坑】环形不能用 i/count * 2π 然后加 aim 后再加 spiral，
      // 否则 spiral 和 aim 会互相干扰。先算均匀角度，最后统一加偏移。
      for (let i = 0; i < count; i++) {
        out.push((i / count) * Math.PI * 2 + spiral);
      }
    } else if (spec.spreadDeg !== undefined) {
      const spread = spec.spreadDeg * DEG;
      if (count === 1) {
        out.push(spiral);
      } else {
        // 均匀分布在 [-spread/2, +spread/2]
        for (let i = 0; i < count; i++) {
          out.push((i / (count - 1) - 0.5) * spread + spiral);
        }
      }
    } else {
      // 无张角：全部平行（用于"三连发""并排墙"）
      for (let i = 0; i < count; i++) {
        out.push(spiral);
      }
    }

    // 垂直排列
    if (spec.perpendicular) {
      for (let i = 0; i < out.length; i++) out[i] += Math.PI / 2;
    }

    // 随机抖动
    if (spec.jitterDeg) {
      const j = spec.jitterDeg * DEG;
      for (let i = 0; i < out.length; i++) {
        out[i] += (ctx.rng.next() * 2 - 1) * j;
      }
    }

    // 镜像
    if (mirrored) {
      const base = out.length;
      for (let i = 0; i < base; i++) out.push(-out[i]);
    }

    return out;
  };
}

/** 取某颗子弹的速度 */
export function speedAt(spec: ShapeSpec, index: number): number {
  if (typeof spec.speed === 'number') return spec.speed;
  if (spec.speed.length === 0) return 0;
  return spec.speed[index % spec.speed.length];
}

// ============================================================
// 发射器
// ============================================================

export interface EmitterOptions {
  readonly id: string;
  /** 形状（配置或函数） */
  readonly shape: ShapeSpec | ShapeFn;
  /** 开火间隔（秒） */
  readonly interval: number;
  /**
   * 总开火次数。默认 Infinity
   *
   * 【有限次的用途】"三连发""五连弹"这类有明确终点的招式
   */
  readonly shots?: number;
  /**
   * 首次开火延迟（秒）
   *
   * 【精确语义】第一发出现在 `delay + interval` 时刻。
   * 即 delay 是"进入发射节奏前的准备时间"，
   * 之后每隔 interval 发一次。
   *
   * 这与 Unity 粒子系统的 Start Delay 一致。
   * 若你期望"第 0 秒就出第一发"，用 delay = 0。
   */
  readonly delay?: number;
  /** 发射器相对宿主的位置偏移 */
  readonly offsetX?: number;
  readonly offsetY?: number;
  /**
   * 是否自动瞄准宿主的目标
   *
   * false = 用固定角度（用于固定方向的激光、陷阱）
   */
  readonly aimAtTarget?: boolean;
  /** 固定角度（aimAtTarget=false 时用） */
  readonly fixedAngle?: number;
  /**
   * 子弹速度。`shape` 为函数形状时用它；`shape` 为 `ShapeSpec` 时忽略本字段（用 `ShapeSpec.speed`）
   *
   * 【⚠️ 为什么函数形状必须单独给一个速度】
   *
   * `ShapeFn` 只返回**角度偏移数组**，没有 `ShapeSpec`，
   * 于是 `_fire` 里拿不到 `spec.speed`，只能填 0。
   * 实测：`shape: () => [0,1,2]` 的发射器产出 3 颗，
   * `speed` 全是 **0**；而对照组 `Shapes.ring(3, 10, 'b')` 是 `[10,10,10]`。
   *
   * 后果不是"子弹慢一点"，是**全部原地不动**——
   * 用自定义形状（弹幕玩法最核心的扩展点）打出的弹幕堆在发射点成一团，
   * 玩家不会认为是 bug，只会觉得"这 Boss 有问题"，
   * 而开发查碰撞、查渲染都查不到源头（`BulletSpawn.speed` 明明是 README 列名的产出字段）。
   *
   * 【为什么不默认给 1 而是 0】
   * 保持与修复前一致：既有的函数形状调用方不受影响，
   * 需要速度的显式传。默认 1 会让"只想要角度、速度由别处算"的用法静默变速。
   */
  readonly speed?: number;
  /** 业务数据 */
  readonly data?: unknown;
}

/** 发射器运行时状态 */
interface EmitterRuntime {
  readonly opts: EmitterOptions;
  readonly shape: ShapeFn;
  readonly typeId: string;
  time: number;
  shotIndex: number;
  done: boolean;
}

// ============================================================
// 编排（时间轴）
// ============================================================

export interface SequenceStep {
  /** 相对开始的时刻（秒） */
  readonly at: number;
  /** 要做什么 */
  readonly action: 'start' | 'stop' | 'restart';
  /** 目标发射器 id */
  readonly emitter: string;
}

/**
 * 弹幕序列
 *
 * 【用途】把多个发射器按时间轴编排成一套 Boss 招式：
 * ```typescript
 * [
 *   { at: 0,   action: 'start',   emitter: 'ring' },
 *   { at: 1.5, action: 'start',   emitter: 'spiral' },
 *   { at: 4,   action: 'stop',    emitter: 'ring' },
 *   { at: 6,   action: 'stop',    emitter: 'spiral' },
 * ]
 * ```
 */
export class BulletPattern {
  private readonly _emitters = new Map<string, EmitterRuntime>();
  private readonly _order: string[] = [];
  private readonly _rng: IRandomSource;
  private _time = 0;
  private _playing = false;

  /** 本次 tick 产出的子弹 */
  private readonly _pending: BulletSpawn[] = [];

  /** 宿主位置（由外部每帧设置） */
  hostX = 0;
  hostY = 0;
  /** 目标位置（aimAtTarget 时用） */
  targetX = 0;
  targetY = 0;

  constructor(rng: IRandomSource) {
    this._rng = rng;
  }

  // ---- 配置 ----

  addEmitter(opts: EmitterOptions): this {
    if (this._emitters.has(opts.id)) {
      throw new Error(`[BulletPattern] 发射器 id 重复：${opts.id}`);
    }
    // 【构造时校验】配置错误现在就报，别等到 Boss 战打一半
    /**
     * 【⚠️ 为什么写成 `!(x > 0)` 而不是 `x <= 0`】
     *
     * JS 里 NaN 与任何值比较都是 **false**，所以 `NaN <= 0` 为 false——
     * 否定式守卫会被 NaN 直接穿透。
     *
     * 实测：`interval = NaN` **通过构造校验**（`NaN <= 0` 为 false），
     * 之后 tick 里 `while (e.time >= NaN)` 恒为 false，跑 600 帧产出 **0** 颗。
     * 发射器静默罢工，Boss 战打一半突然不弹幕了，
     * 而这一行注释原本写的正是"配置错误现在就报，别等到 Boss 战打一半"——
     * 注释承诺了它没做到的事。
     *
     * 肯定式写法 `!(x > 0)` 对 NaN / 0 / 负数 / 非数字全部成立，一个都不漏。
     * （本库把这一类统一叫"模式 A"，是全库最高频的错误形态。）
     */
    if (!(opts.interval > 0)) {
      throw new Error(`[BulletPattern] 发射器 "${opts.id}" 的 interval 必须为正`);
    }
    /**
     * 【同理】`shots < 0` 也挡不住 NaN。
     * `shots = NaN` 时 `e.shotIndex >= NaN` 恒为 false，
     * "有限次"退化成**无限次**——三连发变成永动机，且不报错。
     */
    if (opts.shots !== undefined && !(opts.shots >= 0)) {
      throw new Error(`[BulletPattern] 发射器 "${opts.id}" 的 shots 不能为负`);
    }
    const shape = typeof opts.shape === 'function' ? opts.shape : compileShape(opts.shape);
    const typeId = typeof opts.shape === 'function' ? '' : opts.shape.typeId;

    this._emitters.set(opts.id, {
      opts,
      shape,
      typeId,
      time: -(opts.delay ?? 0),   // 与 _resetTime 保持一致
      shotIndex: 0,
      done: false,
    });
    this._order.push(opts.id);
    return this;
  }

  /**
   * 设置类型 id（用函数形状时必须调用）
   *
   * 【为什么需要】
   * 用 `ShapeFn`（自定义形状）时没有 `ShapeSpec`，
   * 拿不到 typeId。所以必须显式指定——
   * 否则生成的子弹 typeId 是空字符串，业务不知道该生成什么。
   */
  setTypeId(emitterId: string, typeId: string): void {
    const e = this._emitters.get(emitterId);
    if (e) (e as { typeId: string }).typeId = typeId;
  }

  // ---- 播放控制 ----

  play(): void {
    this._playing = true;
    this._time = 0;
    for (const id of this._order) {
      const e = this._emitters.get(id)!;
      e.time = -(e.opts.delay ?? 0);
      e.shotIndex = 0;
      e.done = false;
    }
    this._pending.length = 0;
  }

  stop(): void {
    this._playing = false;
  }

  get playing(): boolean {
    return this._playing;
  }

  /**
   * 卸载（rule5：有 install 就要有对应的 destroy）
   *
   * 【为什么必须显式提供，哪怕调用方可以直接丢弃实例】
   * 常见的写法是"关卡切换时把 BulletPattern 置空"，
   * 但只要还有别处持有这个引用（序列编排表、Boss 的状态机），
   * 它就会继续被 tick——而 `_pending` 里还留着上一次的产出，
   * 下游会在换场后再收到一批"上一关的弹幕"。
   * 显式 destroy 让"这个发射器已经不存在了"变成一个可调用的动作。
   */
  destroy(): void {
    this._playing = false;
    this._time = 0;
    this._pending.length = 0;
    this._emitters.clear();
    this._order.length = 0;
  }

  /** 重置到未播放（保留配置） */
  reset(): void {
    this._playing = false;
    this._time = 0;
    this._pending.length = 0;
    for (const id of this._order) {
      const e = this._emitters.get(id)!;
      e.time = -(e.opts.delay ?? 0);
      e.shotIndex = 0;
      e.done = false;
    }
  }

  /** 手动启动/停止某个发射器（序列编排用） */
  setEmitterActive(id: string, active: boolean): void {
    const e = this._emitters.get(id);
    if (!e) return;
    if (active) {
      e.done = false;
      e.time = 0;
      e.shotIndex = 0;
    } else {
      e.done = true;
    }
  }

  /**
   * 重启发射器
   *
   * 【⚠️ 曾经的 bug：restart 把 delay 丢了】
   *
   * 原实现写 `e.time = 0`，而构造和 `reset()` 写的是 `e.time = -delay`。
   * 于是"三连发 + 0.5s 前摇"的招式：
   * - 第一次播放：0.5s 后开始第一发（正确）
   * - restart 后再播：**立刻**出第一发（前摇消失）
   *
   * 表现是"这个 Boss 的招式时快时慢"，
   * 而你去查配置会发现"delay 明明配了 0.5"。
   *
   * 这类 bug 的形态是**同一份配置在两个代码路径下行为不同**——
   * 只有把重置逻辑收敛到一处才能根治，
   * 所以这里统一复用 `_resetTime(e)`。
   */
  restartEmitter(id: string): void {
    const e = this._emitters.get(id);
    if (!e) return;
    e.done = false;
    this._resetTime(e);
    e.shotIndex = 0;
  }

  /** 时间归零（唯一入口，保证 delay 在所有路径下一致） */
  private _resetTime(e: EmitterRuntime): void {
    e.time = -(e.opts.delay ?? 0);
  }

  isEmitterDone(id: string): boolean {
    return this._emitters.get(id)?.done ?? true;
  }

  /** 所有发射器都打完了 */
  get allDone(): boolean {
    for (const id of this._order) if (!this._emitters.get(id)!.done) return false;
    return true;
  }

  // ---- 主循环 ----

  /**
   * 推进并产出子弹
   *
   * @returns 本次 tick 产出的子弹；无产出时返回空数组
   */
  tick(dt: number): BulletSpawn[] {
    this._pending.length = 0;
    if (!this._playing || !safeDt(dt)) return this._pending;

    this._time += dt;

    for (const id of this._order) {
      const e = this._emitters.get(id)!;
      if (e.done) continue;

      e.time += dt;

      // 【为什么用 while】
      // dt 很大（掉帧）时可能跨过多次开火间隔，
      // 用 if 会漏掉中间的几次——表现为"卡顿后弹幕缺了一段"。
      let guard = 0;
      while (e.time >= e.opts.interval && !e.done) {
        /**
         * 【⚠️ 为什么命中上限后要把 e.time 清零，而不是直接退出循环】
         *
         * 原写法 `while (... && guard++ < 64)` 在截断时**保留了未消耗的时间**。
         * 于是掉一帧大的（比如 dt = 10s、interval = 0.01s，积压 1000 次）之后：
         *
         * ```
         * 第 1 帧：产出 64 发（剩下的 936 次仍留在 e.time 里）
         * 第 2 帧：又产出 64 发
         * 第 3 帧：又产出 64 发   ← 实测连续多帧都是 64
         * ```
         *
         * 表现是"卡了一下之后 Boss 突然连续喷出十几轮弹幕"——
         * 玩家躲不掉，还会以为是自己卡了导致的判定问题。
         *
         * 掉帧本来就说明这一帧不可信，积压的时间不该补发。
         * 清零后下一帧从干净状态重新累积，弹幕节奏回到正常。
         */
        if (guard++ >= 64) {
          e.time = 0;
          break;
        }
        e.time -= e.opts.interval;
        this._fire(e);
        e.shotIndex++;
        const maxShots = e.opts.shots ?? Infinity;
        if (e.shotIndex >= maxShots) e.done = true;
      }
    }

    return this._pending;
  }

  // ---- 内部 ----

  private _fire(e: EmitterRuntime): void {
    const opts = e.opts;
    const ox = this.hostX + (opts.offsetX ?? 0);
    const oy = this.hostY + (opts.offsetY ?? 0);

    let aim: number;
    /**
     * 【⚠️ 为什么去掉了 `opts.fixedAngle !== undefined` 这个条件】
     *
     * `EmitterOptions.aimAtTarget` 的 JSDoc 写的是
     * "false = 用固定角度（用于固定方向的激光、陷阱）"，
     * 但原实现要求同时给了 `fixedAngle` 才走固定角度分支，
     * 否则**仍然自动瞄准目标**——文档承诺与实现相反。
     *
     * 实测：目标在正上方 (0,100)，`aimAtTarget: false` 且不传 `fixedAngle`，
     * 产出子弹的 `angle = 1.5708`（π/2，仍在自动瞄准），而不是期望的 0。
     *
     * 按"模式 F"处理：文档与实现冲突时二选一，不能只改一边。
     * 这里以文档为准（JSDoc 是调用方唯一能看到的契约），
     * 固定角度缺省取 **0**（+X 方向），并用 `numOr` 收口，
     * 避免 `fixedAngle: NaN` 把整颗子弹的 angle 变成 NaN。
     */
    if (opts.aimAtTarget === false) {
      aim = numOr(opts.fixedAngle, 0);
    } else {
      const dx = this.targetX - ox;
      const dy = this.targetY - oy;
      aim = dx * dx + dy * dy > 1e-12 ? Math.atan2(dy, dx) : 0;
    }

    const ctx: ShapeContext = { aim, shotIndex: e.shotIndex, rng: this._rng };
    const offsets = e.shape(ctx);

    const spec = typeof opts.shape === 'function' ? null : opts.shape;
    for (let i = 0; i < offsets.length; i++) {
      /**
       * 函数形状没有 `ShapeSpec`，拿不到 `spec.speed`，
       * 改从 `EmitterOptions.speed` 取（见该字段的注释）。
       * `numOr` 保证 NaN / Infinity 不会漏进 `BulletSpawn.speed`——
       * 速度是会被下游直接乘进位移的字段，一个 NaN 就让子弹永久消失。
       */
      const speed = spec ? speedAt(spec, i) : numOr(opts.speed, 0);
      const a = aim + offsets[i];
      this._pending.push({
        typeId: e.typeId,
        x: ox,
        y: oy,
        angle: a,
        speed,
        shotIndex: e.shotIndex,
        indexInShot: i,
        ...(opts.data !== undefined ? { data: opts.data } : {}),
      });
    }
  }
}

// ============================================================
// 运行序列编排
// ============================================================

/**
 * 序列播放器
 *
 * 【为什么独立】
 * `BulletPattern` 负责"一次 tick 产出什么"，
 * 序列播放器负责"什么时候 start/stop 哪个发射器"。
 * 分开后各自可测，也能用于非弹幕的场景（比如编排技能、音效）。
 */
export class SequencePlayer {
  private readonly _steps: SequenceStep[];
  private _time = 0;
  private _index = 0;
  private _loop = false;
  private _running = false;

  constructor(steps: readonly SequenceStep[], loop = false) {
    // 按时间排序，避免配置写乱顺序
    this._steps = [...steps].sort((a, b) => a.at - b.at);
    this._loop = loop;
  }

  start(): void {
    this._time = 0;
    this._index = 0;
    this._running = true;
  }

  stop(): void {
    this._running = false;
  }

  get running(): boolean {
    return this._running;
  }

  get finished(): boolean {
    return this._index >= this._steps.length;
  }

  /**
   * 推进，返回本次要执行的步骤
   *
   * 【幂等】同一时刻的多个步骤会一次性全部返回，
   * 不会漏（用 while 而非 if）。
   */
  tick(dt: number, apply: (step: SequenceStep) => void): void {
    if (!this._running || !safeDt(dt)) return;
    this._time += dt;

    while (this._index < this._steps.length && this._steps[this._index].at <= this._time) {
      apply(this._steps[this._index]);
      this._index++;
    }

    if (this._index >= this._steps.length) {
      if (this._loop) {
        /**
         * 【⚠️ 为什么是"减掉一个周期"而不是 `_time = 0`】
         *
         * `_time = 0` 会把本帧**超出周期的那部分时间直接丢掉**，
         * 于是每个循环的实际周期都被拉长到"下一个 dt 边界"：
         *
         * ```
         * dt = 0.3s、周期 1s → 实测 10.2 秒只触发 9 次（理想 10 次）
         * ```
         *
         * 丢掉的是**每个周期的零头**，而它不会自己补回来——
         * 循环跑得越久，编排相对背景音乐/其他发射器偏移越远，
         * 表现为"Boss 招式越打越跟不上 BGM"，而且没法靠调配置修
         * （配 1 秒就是 1 秒，慢的是实现不是配置）。
         *
         * 循环周期取"最后一步的 at"（steps 是相对开始的时刻，
         * 最后一步的时刻就是一轮走完所需的时间）。
         * 减掉它而不是归零，余量被保留到下一轮，周期才精确。
         *
         * 【为什么还要判 period > 0】
         * 所有步骤都写在 at=0 时 period 为 0，
         * `_time -= 0` 没有任何进展——此时退回 `_time = 0` 的旧行为。
         */
        const period = this._steps.length > 0
          ? this._steps[this._steps.length - 1].at
          : 0;
        this._time = period > 0 ? this._time - period : 0;
        this._index = 0;
      } else {
        this._running = false;
      }
    }
  }
}

// ============================================================
// 内置形状（常用组合，省得每次都配）
// ============================================================

export const Shapes = {
  /** 环形：n 颗均匀 360° */
  ring: (count: number, speed: number, typeId: string): ShapeSpec => ({
    count, typeId, fullCircle: true, speed,
  }),

  /** 螺旋：每次开火旋转 stepDeg 度 */
  spiral: (count: number, speed: number, typeId: string, stepDeg: number): ShapeSpec => ({
    count, typeId, fullCircle: true, speed, spiralStepDeg: stepDeg,
  }),

  /** 扇形散射 */
  fan: (count: number, spreadDeg: number, speed: number, typeId: string): ShapeSpec => ({
    count, typeId, spreadDeg, speed,
  }),

  /** 三连发（平行，速度递增） */
  triple: (typeId: string, speeds: number[]): ShapeSpec => ({
    count: speeds.length, typeId, speed: speeds, spreadDeg: 0,
  }),

  /** 双向对称扇形 */
  cross: (count: number, spreadDeg: number, speed: number, typeId: string): ShapeSpec => ({
    count, typeId, spreadDeg, speed, mirrored: true,
  }),

  /** 随机散射（霰弹） */
  scatter: (count: number, spreadDeg: number, speed: number, typeId: string): ShapeSpec => ({
    count, typeId, spreadDeg, speed, jitterDeg: spreadDeg * 0.3,
  }),
};

/**
 * 角度转方向向量
 *
 * 【为什么提供】
 * 业务拿到 `BulletSpawn.angle` 后要设速度向量，
 * 每次手写 `Math.cos/sin` 容易把 y 轴符号搞反
 * （屏幕坐标系 vs 世界坐标系）。统一在这里，只错一次。
 */
export function angleToVec(angle: number, speed: number): { x: number; y: number } {
  return { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
}

/** 把角度归一化到 [0, 2π)（存档/比较用） */
export function normalizeAngle2Pi(a: number): number {
  let x = a % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x;
}

/** 线性插值角度（走最短弧） */
export function lerpAngle(from: number, to: number, t: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return from + diff * clamp(t, 0, 1);
}
