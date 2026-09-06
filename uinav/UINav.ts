/**
 * uinav/UINav.ts —— UI 导航栈
 *
 * 【它解决什么】
 *
 * 打开背包 → 点物品 → 弹出确认框。按返回键应该退一层，
 * 而不是"回到主菜单"或者"把整个栈清空"。
 *
 * 手写的做法是 `if (currentPanel === 'bag') closeBag()`，
 * 加上设置、图鉴、商店、二次确认之后，就是一坨互相矛盾的 if。
 *
 * 本模块把界面当成栈：
 *
 * ```typescript
 * nav.push('bag');
 * nav.push('confirm');
 * nav.pop();            // 回到 bag
 * nav.popTo('home');    // 直接回主界面
 * ```
 *
 * 【三个必须处理的真实问题】
 *
 * 1. **转场锁**：转场动画期间连点会 push 出多层同样的界面
 * 2. **重复入栈**：同一个界面被打开两次
 * 3. **返回值语义**：pop 返回被关闭的是谁，事件里 closed 是数组（可能一次关多层）
 *
 * 【⚠️ 它不知道界面长什么样】
 * `T` 可以是字符串 id、界面实例、或配置项——
 * 怎么渲染是宿主的事，本模块只管顺序。
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

export type NavAction = 'push' | 'pop' | 'replace' | 'popTo' | 'clear' | 'reset';

export interface NavChange<T> {
  readonly action: NavAction;
  /** 变化后的栈顶（清空时为 null） */
  readonly current: T | null;
  /** 变化前的栈顶 */
  readonly previous: T | null;
  /** 本次被关闭的界面（栈底→栈顶顺序） */
  readonly closed: readonly T[];
}

export type DuplicatePolicy =
  /** 允许重复入栈（默认） */
  | 'allow'
  /** 拒绝重复 */
  | 'ignore'
  /** 回退到已存在的那一层 */
  | 'popTo';

export interface UINavOptions<T> {
  /**
   * 如何取出一个界面的标识（用于 contains / popTo / indexOf）
   *
   * 【默认】`String(item)`
   * 如果 T 本身就是字符串 id（最常见），可以不传。
   */
  readonly idOf?: (item: T) => string;
  /** 转场时长（毫秒）。0 表示不锁定 */
  readonly transitionMs?: number;
  readonly duplicate?: DuplicatePolicy;
  readonly onChange?: (change: NavChange<T>) => void;
}

// ==================== 实现 ====================

export class UINav<T> {
  private readonly _stack: T[] = [];
  private readonly _idOf: (item: T) => string;
  private readonly _transitionMs: number;
  private readonly _duplicate: DuplicatePolicy;
  private readonly _onChange?: (change: NavChange<T>) => void;

  private _lockUntil = 0;
  private _now: () => number = () => Date.now();

  constructor(opts: UINavOptions<T>) {
    this._idOf = opts.idOf ?? ((item: T) => String(item));
    this._transitionMs = opts.transitionMs ?? 0;
    this._duplicate = opts.duplicate ?? 'allow';
    this._onChange = opts.onChange;
  }

  /** 注入时间源（测试必需） */
  useClock(fn: () => number): void {
    this._now = fn;
  }

  // ==================== 查询 ====================

  get current(): T | null {
    return this._stack.length > 0 ? this._stack[this._stack.length - 1] : null;
  }

  get depth(): number {
    return this._stack.length;
  }

  get isEmpty(): boolean {
    return this._stack.length === 0;
  }

  /** 栈底→栈顶 */
  get stack(): readonly T[] {
    return this._stack;
  }

  /** 是否处于转场锁定中 */
  get locked(): boolean {
    return this._transitionMs > 0 && this._now() < this._lockUntil;
  }

  contains(id: string): boolean {
    return this.indexOf(id) >= 0;
  }

  /** 返回层索引（栈底为 0），不存在返回 -1 */
  indexOf(id: string): number {
    return this._stack.findIndex((x) => this._idOf(x) === id);
  }

  // ==================== 操作 ====================

  push(item: T): boolean {
    if (this._locked()) return false;

    const id = this._idOf(item);
    if (this._duplicate !== 'allow' && this.contains(id)) {
      if (this._duplicate === 'ignore') return false;
      if (this._duplicate === 'popTo') return this.popTo(id);
    }

    const previous = this.current;
    this._stack.push(item);
    this._lock();
    this._emit('push', this.current, previous, []);
    return true;
  }

  /** 关闭栈顶，返回被关闭的界面 */
  pop(): T | null {
    if (this._locked()) return null;
    if (this._stack.length === 0) return null;

    const previous = this.current;
    const closed = this._stack.pop()!;
    this._lock();
    this._emit('pop', this.current, previous, [closed]);
    return closed;
  }

  /** 替换栈顶（不改变层数） */
  replace(item: T): boolean {
    if (this._locked()) return false;

    const previous = this.current;
    if (this._stack.length === 0) {
      this._stack.push(item);
      this._lock();
      this._emit('replace', this.current, previous, []);
      return true;
    }

    const closed = this._stack[this._stack.length - 1];
    this._stack[this._stack.length - 1] = item;
    this._lock();
    this._emit('replace', this.current, previous, [closed]);
    return true;
  }

  /** 回退到指定界面（保留它，关闭其上的） */
  popTo(id: string): boolean {
    if (this._locked()) return false;

    const idx = this.indexOf(id);
    if (idx < 0) return false;
    // 已在栈顶，无需动作
    if (idx === this._stack.length - 1) return false;

    const previous = this.current;
    const closed = this._stack.splice(idx + 1);
    this._lock();
    this._emit('popTo', this.current, previous, closed);
    return true;
  }

  /** 回退到指定层数 */
  popToDepth(depth: number): boolean {
    if (this._locked()) return false;
    if (depth < 0) return false;
    if (depth >= this._stack.length) return false;

    const previous = this.current;
    const closed = depth === 0 ? this._stack.splice(0) : this._stack.splice(depth);
    this._lock();
    this._emit('popTo', this.current, previous, closed);
    return true;
  }

  /** 清空 */
  clear(): void {
    if (this._stack.length === 0) return;
    const previous = this.current;
    const closed = this._stack.splice(0);
    this._emit('clear', null, previous, closed);
  }

  /** 用一组新界面重建栈 */
  reset(items: readonly T[]): void {
    const previous = this.current;
    const closed = this._stack.splice(0);
    for (const it of items) this._stack.push(it);
    this._emit('reset', this.current, previous, closed);
  }

  // ==================== 内部 ====================

  private _locked(): boolean {
    return this.locked;
  }

  private _lock(): void {
    if (this._transitionMs > 0) {
      this._lockUntil = this._now() + this._transitionMs;
    }
  }

  private _emit(
    action: NavAction,
    current: T | null,
    previous: T | null,
    closed: readonly T[]
  ): void {
    this._onChange?.({ action, current, previous, closed });
  }
}
