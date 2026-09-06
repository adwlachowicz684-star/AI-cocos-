/**
 * tutorial/Tutorial.ts —— 新手引导
 *
 * 【它解决什么】
 *
 * 引导是玩家看到的第一段游戏内容，也是最容易被做砸的部分。
 * 手写的引导是一条 `if (step === 3 && player.moved) step = 4` 的长链，
 * 一旦中途要插入一步，后面所有编号都要改。
 *
 * 真正难的是这五件事：
 *
 * 1. **推进条件要能等待**
 *    "等玩家移动到某处"、"等玩家打开背包"——
 *    不是点一下就下一步，而是"做到了才走"。
 *
 * 2. **可跳过，但要能续上**
 *    玩家跳过了，下次进来应该从断点继续，
 *    而不是从头再来一遍（那会导致二次流失）。
 *
 * 3. **不能卡死**
 *    条件永远不满足（比如引导指向的按钮被其他 UI 挡住了），
 *    玩家就彻底卡住。必须有超时兜底。
 *
 * 4. **存档要能容错**
 *    版本更新后引导步骤变了，旧存档指向一个不存在的步骤。
 *
 * 5. **强制与软引导**
 *    强制引导锁住其他操作；软引导只是高亮提示，玩家可以做别的。
 *
 * 【核心设计】
 *
 * 引导是一串 **步骤（Step）**，每步声明：
 * 做什么（highlight/文案/遮罩） + 什么条件下算完成（until）。
 *
 * 它不知道 UI 长什么样，只对外报告"当前是哪一步、要高亮什么"。
 *
 * 【零业务依赖】
 */
import { safeDt } from '../_core/math';

// ==================== 类型 ====================

export type TutorialEventKind =
  /** 点击任意处继续 */
  | 'tap'
  /** 等待条件满足（自动推进） */
  | 'wait'
  /** 等待条件满足，且需要玩家点一下确认 */
  | 'waitAndTap';

export interface TutorialStep<Ctx = unknown> {
  readonly id: string;
  readonly kind: TutorialEventKind;
  /** 提示文案 */
  readonly text?: string;
  /** 要高亮的目标（UI 元素 id / 世界物体 id，由业务解释） */
  readonly target?: string;
  /**
   * 完成条件（kind 为 wait / waitAndTap 时必填）
   *
   * 【为什么是函数而不是事件名】
   * "玩家血量为 0"、"玩家拥有了 3 个遗物"这类条件
   * 用事件名表达不了。
   */
  readonly until?: (ctx: Ctx) => boolean;
  /**
   * 超时（毫秒）
   *
   * 【为什么必须有】
   * 条件永远不满足时玩家会彻底卡住。
   * 超时后自动推进（或强制完成），宁可引导不完整也不能卡死。
   */
  readonly timeoutMs?: number;
  /**
   * 是否强制（锁住其他输入）
   *
   * 【谨慎使用】
   * 强制引导会让玩家觉得"被剥夺控制权"，
   * 只在最关键的第一步用。
   */
  readonly modal?: boolean;
  /** 遮罩挖洞的位置由业务决定，这里只声明要不要 */
  readonly mask?: boolean;
  /** 进入这一步时执行一次 */
  readonly onEnter?: (ctx: Ctx) => void;
  /** 离开这一步时执行一次 */
  readonly onExit?: (ctx: Ctx) => void;
  /**
   * 是否满足才进入这一步（条件分支引导）
   *
   * 【用途】"如果玩家已经有遗物了就跳过这段说明"
   */
  readonly skipIf?: (ctx: Ctx) => boolean;
  readonly data?: unknown;
}

export interface TutorialOptions<Ctx> {
  readonly steps: readonly TutorialStep<Ctx>[];
  readonly context: Ctx;
  readonly onChange?: (step: TutorialStep<Ctx> | null, index: number) => void;
  readonly onFinish?: () => void;
  /**
   * 默认超时（毫秒）。单步未指定时用它
   *
   * 【默认 30 秒】
   * 太长卡死，太短会让正常玩家被打断。
   */
  readonly defaultTimeoutMs?: number;
}

export type TutorialState = 'idle' | 'running' | 'finished';

// ==================== 实现 ====================

export class Tutorial<Ctx = unknown> {
  private readonly _steps: readonly TutorialStep<Ctx>[];
  private readonly _ctx: Ctx;
  private readonly _onChange?: (step: TutorialStep<Ctx> | null, index: number) => void;
  private readonly _onFinish?: () => void;
  private readonly _defaultTimeout: number;

  private _index = -1;
  private _state: TutorialState = 'idle';
  private _elapsed = 0;
  /** 已完成的步骤 id（存档用） */
  private readonly _done = new Set<string>();

  constructor(opts: TutorialOptions<Ctx>) {
    this._steps = opts.steps;
    this._ctx = opts.context;
    this._onChange = opts.onChange;
    this._onFinish = opts.onFinish;
    this._defaultTimeout = opts.defaultTimeoutMs ?? 30_000;

    for (const s of this._steps) {
      if ((s.kind === 'wait' || s.kind === 'waitAndTap') && !s.until) {
        throw new Error(
          `[Tutorial] 步骤 "${s.id}" 的 kind 是 ${s.kind}，必须提供 until`
        );
      }
    }
  }

  get state(): TutorialState {
    return this._state;
  }

  get index(): number {
    return this._index;
  }

  get current(): TutorialStep<Ctx> | null {
    return this._index >= 0 && this._index < this._steps.length
      ? this._steps[this._index]
      : null;
  }

  get progress(): number {
    return this._steps.length === 0 ? 1 : (this._index + 1) / this._steps.length;
  }

  /** 当前步已停留时长（用于超时进度条） */
  get elapsed(): number {
    return this._elapsed;
  }

  /** 当前步的剩余时间（无超时限制时返回 Infinity） */
  get remaining(): number {
    const s = this.current;
    if (!s) return Infinity;
    const t = s.timeoutMs ?? this._defaultTimeout;
    return Math.max(0, t - this._elapsed);
  }

  // ==================== 控制 ====================

  /** 从头开始 */
  start(): void {
    this._index = -1;
    this._state = 'running';
    this._advance();
  }

  /**
   * 从指定步骤开始（断点续引导）
   *
   * 【⚠️ 找不到就从头开始】
   * 版本更新后步骤 id 可能变了，
   * 这时从头来一遍比对不上号直接崩溃好。
   */
  startAt(stepId: string): void {
    const i = this._steps.findIndex((s) => s.id === stepId);
    this._state = 'running';
    if (i < 0) {
      this._index = -1;
      this._advance();
      return;
    }
    // 标记之前的步骤为已完成
    for (let k = 0; k < i; k++) this._done.add(this._steps[k].id);
    this._index = i - 1;
    this._advance();
  }

  /** 每帧驱动 */
  update(dt: number): void {
    if (this._state !== 'running') return;
    const s = this.current;
    if (!s) return;

    // 【为什么不是 dt > 0】Infinity > 0 为 true，_elapsed 一步越界，
    // 引导步骤瞬间超时跳完，玩家根本没看清提示。
    if (safeDt(dt)) this._elapsed += dt;

    // 条件满足 + 需要确认 → 等玩家点
    if (s.kind === 'wait' && s.until?.(this._ctx)) {
      this._advance();
      return;
    }

    // 超时兜底：宁可引导不完整，也不能卡死玩家
    const t = s.timeoutMs ?? this._defaultTimeout;
    if (this._elapsed >= t) {
      this._advance();
    }
  }

  /**
   * 玩家点击
   *
   * 【⚠️ 语义】
   * - `tap`：无条件推进
   * - `waitAndTap`：只有条件满足才推进
   * - `wait`：忽略点击（由条件驱动）
   */
  tap(): boolean {
    if (this._state !== 'running') return false;
    const s = this.current;
    if (!s) return false;

    if (s.kind === 'wait') return false;
    if (s.kind === 'waitAndTap' && !s.until?.(this._ctx)) return false;

    this._advance();
    return true;
  }

  /** 跳过剩余全部（标记完成） */
  skip(): void {
    for (const s of this._steps) this._done.add(s.id);
    this._finish();
  }

  /** 跳过当前这一步 */
  skipStep(): void {
    this._advance();
  }

  // ==================== 存档 ====================

  /** 已完成的步骤 id */
  get done(): string[] {
    return [...this._done];
  }

  /** 当前进度点（下次从这里续） */
  get resumePoint(): string | null {
    return this.current?.id ?? null;
  }

  isDone(stepId: string): boolean {
    return this._done.has(stepId);
  }

  exportState(): { done: string[]; resumeAt: string | null; finished: boolean } {
    return {
      done: this.done,
      resumeAt: this.resumePoint,
      finished: this._state === 'finished',
    };
  }

  /**
   * 导入存档
   *
   * 【⚠️ 已完成的步骤 id 可能已不存在】
   * 直接重建 Set 即可，不存在的 id 不影响任何判断。
   */
  importState(state: { done?: readonly string[]; resumeAt?: string | null; finished?: boolean }): void {
    this._done.clear();
    for (const id of state.done ?? []) this._done.add(id);
    if (state.finished) {
      this._state = 'finished';
      this._index = this._steps.length;
      return;
    }
    if (state.resumeAt) {
      this.startAt(state.resumeAt);
    }
  }

  // ==================== 内部 ====================

  private _advance(): void {
    const prev = this.current;
    if (prev) {
      this._done.add(prev.id);
      prev.onExit?.(this._ctx);
    }

    this._index++;
    this._elapsed = 0;

    // 跳过 skipIf 满足的步骤
    while (this._index < this._steps.length) {
      const s = this._steps[this._index];
      if (s.skipIf?.(this._ctx)) {
        this._done.add(s.id);
        this._index++;
        continue;
      }
      break;
    }

    if (this._index >= this._steps.length) {
      this._finish();
      return;
    }

    const s = this._steps[this._index];
    s.onEnter?.(this._ctx);
    this._onChange?.(s, this._index);
  }

  private _finish(): void {
    this._state = 'finished';
    this._index = this._steps.length;
    this._onChange?.(null, this._index);
    this._onFinish?.();
  }
}
