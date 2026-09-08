/**
 * cutscene/Cutscene.ts —— 演出编排（时间轴播放器）
 *
 * 【它解决什么】
 *
 * 过场动画看起来是"播放一段视频"，但在游戏里通常是
 * **代码编排**：镜头移动、角色走位、对话弹出、音效、震屏……
 * 这些按时间轴串起来。
 *
 * 手写的话典型形态是一堆嵌套 setTimeout：
 *
 * ```typescript
 * camera.moveTo(A, 1000);
 * setTimeout(() => {
 *   dialogue.show('...');
 *   setTimeout(() => { ... }, 2000);
 * }, 1000);
 * ```
 *
 * 四个必然出现的问题：
 *
 * 1. **没法暂停**
 *    setTimeout 不受 timeScale 控制。演出播到一半玩家按了暂停，
 *    演出还在继续走。
 *
 * 2. **没法跳过**
 *    跳过时要把所有未完成步骤的**最终状态**都应用上——
 *    否则跳过演出后，镜头停在半路、角色卡在走位中间。
 *    而 setTimeout 你根本不知道有多少个还没执行。
 *
 * 3. **没法回看/拖动进度**
 *    调试时想跳到第 3 秒看镜头对不对，做不到。
 *
 * 4. **清理困难**
 *    演出中途玩家退出，那一串 setTimeout 还是会触发。
 *
 * 【设计】
 * 本模块是一个**纯时间轴**：它只负责"现在该执行哪些 step"，
 * 具体做什么（镜头怎么动、对话怎么显示）由调用方注册的回调决定。
 *
 * 所以它可以被测试——测试里注册一个记录器，验证时间轴推进正确。
 */

import { clamp, clampNum, safeDt } from '../_core/math';

// ==================== 类型 ====================

export type StepKind = string;

export interface CutsceneStep {
  readonly id: string;
  /**
   * 类型（调用方自定义）
   *
   * 常见：'camera' / 'dialogue' / 'sfx' / 'move' / 'wait' / 'shake'
   */
  readonly kind: StepKind;
  /**
   * 开始时刻（毫秒）
   *
   * - 给了数值 → 绝对时间轴，可以重叠（并行）
   * - 不给 → 紧跟上一个 step 结束（串行），由播放器计算
   */
  readonly start?: number;
  /** 时长（毫秒） */
  readonly duration?: number;
  /** 附加数据（透传给回调） */
  readonly data?: unknown;
  /**
   * 阻塞条件：返回 true 才继续推进时间轴（用于"等待玩家按键"）
   *
   * 【⚠️ 必须配 timeoutMs】
   * 不配的话，玩家不按就永远卡住。
   */
  readonly waitFor?: () => boolean;
  /** 阻塞超时（毫秒，默认 30000） */
  readonly timeoutMs?: number;
}

export interface CutsceneDef {
  readonly id: string;
  readonly steps: readonly CutsceneStep[];
  /** 总时长（毫秒）。不给则取所有 step 的结束时刻最大值 */
  readonly duration?: number;
}

/**
 * step 回调
 *
 * @param step step 定义
 * @param localT 该 step 内的进度 0~1
 * @param isSeek true 表示这是 seek 重放（不应播放一次性音效）
 */
export type StepHandler = (
  step: CutsceneStep,
  localT: number,
  isSeek: boolean
) => void;

export type CutsceneState =
  | 'idle'
  | 'playing'
  | 'blocked'
  | 'finished';

export interface CutsceneCut {
  /** step id */
  readonly id: string;
  /** 该 step 在本次推进中是否刚进入 */
  readonly entered: boolean;
  /** 该 step 在本次推进中是否刚结束 */
  readonly exited: boolean;
  /** step 内进度 */
  readonly localT: number;
}

// ==================== 实现 ====================

interface ResolvedStep {
  readonly def: CutsceneStep;
  readonly start: number;
  readonly duration: number;
  /** 本次推进前是否已进入过 */
  entered: boolean;
  /** 本次推进前是否已结束过 */
  exited: boolean;
  /** 阻塞开始时刻（null 表示未阻塞） */
  blockedAt: number | null;
}

export class Cutscene {
  private readonly _def: CutsceneDef;

  /** 原始定义（只读） */
  get def(): CutsceneDef {
    return this._def;
  }
  private readonly _steps: ResolvedStep[];
  private readonly _duration: number;
  private readonly _handlers = new Map<StepKind, StepHandler>();

  private _state: CutsceneState = 'idle';
  private _time = 0;
  /** 阻塞累计时长（用于超时判定） */
  private _blockElapsed = 0;
  private _timedOut = false;
  /** 单帧最多解几道门（见构造参数说明） */
  private readonly _maxGatesPerTick: number;

  constructor(def: CutsceneDef, opts: { readonly maxGatesPerTick?: number } = {}) {
    this._def = def;
    /**
     * 【为什么 64 不能写死在循环里】
     * 它是"一帧最多解几道阻塞门"的上限：门极多时（比如连续 100 个
     * 等待玩家按键的 step）一帧推不完，演出会**变慢**（不是卡死，
     * 但节奏被拉长），而调用方没有任何办法调整——
     * 数值埋在循环条件里，配置驱动这条铁律就落空了。
     *
     * 默认仍是 64（保持原行为），需要时显式调大。
     */
    this._maxGatesPerTick = clampNum(opts.maxGatesPerTick, 1, 1e6, 64);

    // 解析 start：未指定的话串行排列
    let cursor = 0;
    this._steps = def.steps.map((s) => {
      const start = s.start ?? cursor;
      const duration = Math.max(0, s.duration ?? 0);
      cursor = Math.max(cursor, start + duration);
      return {
        def: s,
        start,
        duration,
        entered: false,
        exited: false,
        blockedAt: null,
      };
    });

    this._duration = def.duration ?? cursor;
  }

  // ==================== 注册回调 ====================

  /**
   * 注册某类 step 的处理函数
   *
   * 【为什么要按 kind 注册而不是全局一个】
   * 镜头、对话、音效的处理方式完全不同，
   * 塞进一个 switch 里会让这个函数越来越长。
   */
  on(kind: StepKind, handler: StepHandler): this {
    this._handlers.set(kind, handler);
    return this;
  }

  // ==================== 播放控制 ====================

  play(): void {
    this._state = 'playing';
    this._time = 0;
    this._blockElapsed = 0;
    this._timedOut = false;
    for (const s of this._steps) {
      s.entered = false;
      s.exited = false;
      s.blockedAt = null;
    }
  }

  /**
   * 推进
   *
   * @param dtMs 时间增量（毫秒）
   * @returns 本次推进产生的变化，供调用方做一次性处理
   *
   * 【⚠️ 用缩放时间还是真实时间？】
   * 这里应该传**游戏缩放时间**。
   * 演出是游戏内容的一部分，暂停时它该停——
   * 这与 BGM 相反（BGM 用真实时间，暂停时继续）。
   */
  update(dtMs: number): readonly CutsceneCut[] {
    if (this._state !== 'playing' && this._state !== 'blocked') return [];

    /**
     * 【⚠️ dt 守卫：NaN / 负数 / Infinity 一律丢弃这一帧】
     *
     * 老实现没有守卫，`remaining = dtMs` 直接参与比较：
     * `update(NaN)` 后 `this._time + NaN = NaN`，
     * `target > this._time` 恒为 false → 时间**不再推进**，
     * 而 `state` 仍是 `playing`。
     *
     * 后果比"演出卡一下"严重：上层"等演出结束"的等待逻辑永久挂起，
     * 没有任何报错——演出看起来在播，其实已经死了。
     */
    if (!safeDt(dtMs)) return [];

    const all: CutsceneCut[] = [];
    let remaining = dtMs;
    /** 本帧是否已经把 dtMs 计过一次阻塞时长 */
    let chargedBlock = false;

    /**
     * 【为什么要循环】
     * 一帧内可能先推进到某个门的起点，再解除它、继续推进。
     * 用 guard 限制轮数，避免配置出问题时死循环。
     */
    for (let guard = 0; guard < this._maxGatesPerTick; guard++) {
      const gate = this._findGate();

      if (gate !== null) {
        if (gate.def.waitFor!() === true) {
          this._unblock(gate);
          continue;
        }
        if (!chargedBlock) {
          this._blockElapsed += dtMs;
          chargedBlock = true;
        }
        if (this._blockElapsed >= (gate.def.timeoutMs ?? 30_000)) {
          this._timedOut = true;
          this._unblock(gate);
          continue;
        }
        this._state = 'blocked';
        return all;
      }

      this._state = 'playing';

      /**
       * 【本帧最多推进到下一个门的起点】
       *
       * 早期版本直接 `time += dt`，然后再检查阻塞。
       * 由于 wait step 时长为 0，它会在**进入的同一帧**被标记为已结束，
       * 于是门根本拦不住——时间直接越过了它，
       * 后面的 step 在"应该被阻塞"的时候照常播放。
       */
      let nextGateAt: number | null = null;
      for (const st of this._steps) {
        if (st.def.waitFor === undefined || st.exited) continue;
        if (st.start <= this._time) continue;
        if (nextGateAt === null || st.start < nextGateAt) nextGateAt = st.start;
      }

      const want = this._time + remaining;
      let target = want;
      let clamped = false;
      if (nextGateAt !== null && want > nextGateAt) {
        target = nextGateAt;
        clamped = true;
      }

      if (target > this._time) {
        const prev = this._time;
        this._time = target;
        all.push(...this._apply(prev, target, false));
      }

      if (!clamped) break;
      remaining = 0;
      /**
       * 【为什么用时间比较而不是 `state === 'finished'`】
       * 上一行的赋值让 TS 把 `_state` 收窄成 'playing'，
       * 再和 'finished' 比较会报"类型无交集"。
       * 而 `_apply` 里判定 finished 的依据本来就是 `to >= duration`，
       * 直接比时间是等价的，也更好读。
       */
      if (this._time >= this._duration) break;
    }

    return all;
  }

  get state(): CutsceneState {
    return this._state;
  }

  get time(): number {
    return this._time;
  }

  get duration(): number {
    return this._duration;
  }

  get progress(): number {
    return this._duration > 0 ? clamp(this._time / this._duration, 0, 1) : 1;
  }

  get finished(): boolean {
    return this._state === 'finished';
  }

  get timedOut(): boolean {
    return this._timedOut;
  }

  // ==================== 跳转 ====================

  /**
   * 跳到指定时刻
   *
   * 【⚠️ 必须重放，不能只应用当前 step】
   *
   * 常见错误实现：找出 t 时刻正在进行的 step，调用它的 handler。
   * 结果是**之前所有 step 的效果全丢了**——
   * 镜头没有移动到 A，因为"移动到 A"那个 step 的 handler 没被调用。
   *
   * 正确做法：把 start <= t 的所有 step 按序重放一遍，
   * 并用 isSeek=true 告诉调用方"这是一次性补状态，别播音效"。
   */
  seek(t: number): readonly CutsceneCut[] {
    const target = clamp(t, 0, this._duration);
    const prev = this._time;
    const cuts = this._apply(prev, target, true);
    this._time = target;
    if (target >= this._duration) {
      this._state = 'finished';
    } else if (this._state === 'finished') {
      this._state = 'playing';
    }
    return cuts;
  }

  /**
   * 跳到结尾
   *
   * 【⚠️ 这是"跳过演出"的正确实现】
   *
   * 跳过不是"停止播放"，而是"快进到结束"。
   * 所有 step 的最终状态都会被应用（比如角色走到终点、镜头到位），
   * 否则跳过之后画面会停在一个中间状态。
   */
  skip(): readonly CutsceneCut[] {
    return this.seek(this._duration);
  }

  /** 停止（不应用最终状态，用于中途退出） */
  stop(): void {
    this._state = 'idle';
    this._time = 0;
  }

  // ==================== 查询 ====================

  /** 当前时刻活跃的 step 定义 */
  activeSteps(): readonly CutsceneStep[] {
    return this._steps
      .filter((s) => this._time >= s.start && this._time < s.start + s.duration)
      .map((s) => s.def);
  }

  /** 当前阻塞的 step（没有则 null） */
  blockingStep(): CutsceneStep | null {
    const b = this._findGate();
    return b ? b.def : null;
  }

  // ==================== 内部 ====================

  /** 找当前挡路的门（已到达起点、尚未通过） */
  private _findGate(): ResolvedStep | null {
    for (const s of this._steps) {
      if (s.def.waitFor === undefined) continue;
      if (s.exited) continue;
      if (this._time >= s.start) return s;
    }
    return null;
  }

  private _unblock(s: ResolvedStep): void {
    s.exited = true;
    s.blockedAt = null;
    this._blockElapsed = 0;
  }

  /**
   * 应用 [from, to] 区间的变化
   *
   * @param isSeek 是否为跳转重放（true 时不触发一次性副作用）
   */
  private _apply(_from: number, to: number, isSeek: boolean): CutsceneCut[] {
    const cuts: CutsceneCut[] = [];

    for (const s of this._steps) {
      const end = s.start + s.duration;

      // 是否应该处于"已开始"状态
      const shouldEnter = to >= s.start;
      /**
       * 【⚠️ 带 waitFor 的 step 不会因时间到达而"结束"】
       * 它时长为 0，end === start，
       * 若照常判定就会在进入的同一帧被标记 exited，
       * 门控直接失效。它只能由 `_unblock` 放行。
       */
      const shouldExit = s.def.waitFor === undefined && to >= end;

      let entered = false;
      let exited = false;

      if (shouldEnter && !s.entered) {
        s.entered = true;
        entered = true;
      }
      if (shouldExit && !s.exited) {
        s.exited = true;
        exited = true;
      }

      /**
       * 回退（seek 到更早的时刻）
       *
       * 【⚠️ 门不能在这里被"取消通过"】
       *
       * 早期版本对**所有** step 统一写
       * `if (!shouldExit && s.exited) s.exited = false;`
       * 而门的 `shouldExit` 恒为 false（它靠 `_unblock` 放行），
       * 结果门在放行的**同一帧**就被重新武装——
       * 超时解除后下一帧又堵上，演出永远播不下去。
       *
       * 正确做法：门只有"时间真的回退到起点之前"才重新武装。
       */
      if (s.def.waitFor === undefined) {
        if (!shouldEnter && s.entered) s.entered = false;
        if (!shouldExit && s.exited) s.exited = false;
      } else if (!shouldEnter) {
        s.entered = false;
        s.exited = false;
      }

      // 计算 localT 并调用 handler
      const active = to >= s.start && to < end;
      const justFinished = exited && s.duration > 0;
      if (entered || active || justFinished || (isSeek && shouldEnter)) {
        const localT = s.duration > 0
          ? clamp((to - s.start) / s.duration, 0, 1)
          : 1;
        const handler = this._handlers.get(s.def.kind);
        if (handler) handler(s.def, localT, isSeek);
        if (entered || exited || active) {
          cuts.push({ id: s.def.id, entered, exited, localT });
        }
      }
    }

    if (to >= this._duration) this._state = 'finished';
    return cuts;
  }
}

// ==================== 便捷：构建器 ====================

/**
 * 时间轴构建器（链式 API）
 *
 * 【为什么需要】
 * 手写 start 数值很痛苦：加一个 step 就要改后面所有的时间。
 * 构建器让你用"相对于上一个 step"的方式描述。
 *
 * ```typescript
 * const tl = new Timeline('intro')
 *   .add('camera', 1000, { to: 'A' })
 *   .add('dialogue', 2000, { text: '...' })
 *   .with('sfx', 500, { id: 'boom' })   // 与上一个并行
 *   .wait('press', 30000);
 * ```
 */
export class Timeline {
  private readonly _id: string;
  private readonly _steps: CutsceneStep[] = [];
  private _cursor = 0;
  /**
   * 上一个 step 的**起点**
   *
   * 【⚠️ 为什么必须单独记，不能用 `_cursor`】
   * `_cursor` 是"下一个 step 该从哪开始"（即上一条的**结束时刻**），
   * 而 `with()` 要的是"与上一个**同时开始**"，需要的是上一条的**起点**。
   *
   * 老实现 `with()` 里也调 `_lastStart()`（= `_cursor`），
   * 于是 `add('a',1000); with('b',1000);` 得到 `a:0, b:1000`——
   * 名字和 README 都写着"并行"，实际排成了**串行两段**，
   * 整个演出时长翻倍、节奏全错。
   * 因为没人会去验证 start 值，这种错误能一直留到上线。
   */
  private _lastAddedStart = 0;

  constructor(id: string) {
    this._id = id;
  }

  /**
   * 串行添加一个 step（接在上一个之后）
   */
  add(id: string, duration: number, data?: unknown): this {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const start = this._lastStart();
    this._steps.push({ id, kind: id, start, duration, data });
    this._cursor = start + duration;
    this._lastAddedStart = start;
    return this;
  }

  /**
   * 并行添加一个 step（与上一个同时开始）
   *
   * 【⚠️ 时长取 max 不是 sum】
   * 两个并行 step 一个 1 秒一个 3 秒，
   * 整体推进应该是 3 秒，不是 4 秒。
   */
  with(id: string, duration: number, data?: unknown): this {
    // 与上一个 step **同时开始**：用它的起点，而不是 cursor（它的结束时刻）
    const start = this._lastAddedStart;
    this._steps.push({ id, kind: id, start, duration, data });
    this._cursor = Math.max(this._cursor, start + duration);
    // 连续 with 时，后面的仍与同一个起点并行
    this._lastAddedStart = start;
    return this;
  }

  /** 添加一个等待玩家输入的 step */
  wait(id: string, waitFor: () => boolean, timeoutMs = 30_000): this {
    const start = this._lastStart();
    this._steps.push({ id, kind: id, start, duration: 0, waitFor, timeoutMs });
    this._lastAddedStart = start;
    return this;
  }

  /** 空档（纯等待） */
  gap(ms: number): this {
    this._cursor += ms;
    // 空档之后没有"上一个 step"了，下一个 with 应从空档结束处起算
    this._lastAddedStart = this._cursor;
    return this;
  }

  build(): CutsceneDef {
    /**
     * 【坑】必须返回副本，不能直接交出 this._steps
     *
     * 交出引用的话，复用 builder 继续 add() 会**改掉已经构建好的 def**：
     *   const def1 = tl.build();   // steps = 2 条
     *   tl.add('sfx', 500);
     *   def1.steps                 // 变成 3 条了 ← 已构建的 def 被偷偷改变
     *
     * 如果 def 已经传给 Cutscene 播放，播放中的演出会突然多出一段。
     * CutsceneDef 名义上是不可变配置，就不该被外部持有者改动。
     */
    return { id: this._id, steps: this._steps.slice(), duration: this._cursor };
  }

  private _lastStart(): number {
    return this._cursor;
  }
}
