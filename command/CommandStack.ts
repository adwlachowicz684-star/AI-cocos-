/**
 * CommandStack —— 命令模式 + 撤销 / 重做
 *
 * 【它解决什么】
 *
 * 撤销功能散落在业务里写，典型结果是「撤销了一半」：
 * - 撤销建造，但资源没退还
 * - 撤销删除，但选中状态没恢复
 * - 连点两下撤销，状态错乱（因为没有事务边界）
 *
 * 根本原因是**一个操作的「做」和「撤」写在两处**，
 * 加新功能时很容易只改一半。
 *
 * 命令模式把它们绑在一起：
 *
 * ```typescript
 * stack.do({
 *   name: '建造箭塔',
 *   execute: () => { world.place(id, x, y); gold -= 50; },
 *   undo:    () => { world.remove(id);      gold += 50; },
 * });
 * ```
 *
 * 【典型用途】
 * - 编辑器（关卡编辑器、技能编辑器的撤销）
 * - 建造 / 装修玩法（撤销一次摆放）
 * - 回合制（悔棋）
 * - 调试工具（配合 DebugConsole）
 *
 * 【与 snapshot 的区别】
 * `snapshot` 是**状态快照**（整棵树 diff + 补丁），
 * 适合「存档 / 回滚一大片」。
 * 本模块是**行为反演**，适合「撤销一个用户动作」。
 *
 * 判据：你能写出 undo 的逻辑吗？
 * - 能 → 用 CommandStack（精确、体积小、可带名字）
 * - 不能（比如一次复杂模拟）→ 用 snapshot
 *
 * 【无引擎依赖】
 */
import { clampNum } from '../_core/math';

// ==================== 接口 ====================

/** 一条命令 */
export interface ICommand {
  /** 名字（显示在撤销菜单里：「撤销 建造箭塔」） */
  readonly name: string;
  /** 执行 */
  execute(): void;
  /** 撤销 */
  undo(): void;
  /**
   * 与上一条同 id 的命令合并（返回 true 表示已合并）
   *
   * 【用途】连续拖动同一个滑块不该产生 200 条撤销记录。
   * 合并后撤销一次就回到拖动前的值。
   *
   * 【⚠️ 注意】undo 栈和 redo 栈都会尝试合并，
   * 但 redo 通常不需要——合并只发生在「紧接着的同类操作」上。
   */
  mergeWith?(prev: ICommand): boolean;
  /**
   * 合并键：只有 key 相同的相邻命令才会尝试 mergeWith
   *
   * 【为什么不直接比较 name】
   * name 是给人看的（可能带序号："移动 第 3 次"），
   * key 是给机器比较的（固定为 "move"）。
   */
  readonly mergeKey?: string;
  /**
   * 是否可被撤销（默认 true）
   *
   * 【用途】某些命令是「不可逆」的（提交订单、播放过场），
   * 它们应该清空 redo 栈，但自己不该进 undo 栈。
   */
  readonly undoable?: boolean;
}

export interface CommandStackOptions {
  /** 栈深度上限（默认 100）。超出后丢弃最早的 */
  readonly limit?: number;
  /** 状态变化时回调（用于刷新 UI 的撤销按钮可用性） */
  readonly onChange?: () => void;
  /** 命令执行后的日志（用于调试，不需要可省略） */
  readonly onLog?: (action: 'do' | 'undo' | 'redo', cmd: ICommand) => void;
}

export interface CommandStackSnapshot {
  readonly undoNames: readonly string[];
  readonly redoNames: readonly string[];
}

// ==================== 实现 ====================

export class CommandStack {
  private readonly _undoStack: ICommand[] = [];
  private readonly _redoStack: ICommand[] = [];
  private readonly _limit: number;
  private readonly _onChange?: () => void;
  private readonly _onLog?: (a: 'do' | 'undo' | 'redo', c: ICommand) => void;

  /** 事务嵌套深度（>0 时命令进缓冲区，提交时才入栈） */
  private _txDepth = 0;
  private _txBuffer: ICommand[] | null = null;
  private _txName = '';

  constructor(opts: CommandStackOptions = {}) {
    // 【为什么不能用 Math.max(1, opts.limit ?? 100)】
    //
    // `Math.max(1, NaN) === NaN`，而裁剪判定是 `length > this._limit`。
    // `_limit` 变 NaN 后该判定恒为 false → **栈永不裁剪**。
    // 实测 do 10000 次后 undoDepth 仍是 10000，内存无上限增长。
    //
    // 0 和负数原本被 Math.max 兜到 1，clampNum 保持了这个行为。
    this._limit = clampNum(opts.limit, 1, 1e6, 100);
    this._onChange = opts.onChange;
    this._onLog = opts.onLog;
  }

  // ==================== 查询 ====================

  get canUndo(): boolean {
    return this._undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this._redoStack.length > 0;
  }

  get undoDepth(): number {
    return this._undoStack.length;
  }

  get redoDepth(): number {
    return this._redoStack.length;
  }

  /** 下一次撤销会撤销什么（用于菜单文案：「撤销 建造箭塔」） */
  get nextUndoName(): string | null {
    return this._undoStack.length > 0 ? this._undoStack[this._undoStack.length - 1].name : null;
  }

  get nextRedoName(): string | null {
    return this._redoStack.length > 0 ? this._redoStack[this._redoStack.length - 1].name : null;
  }

  /** 是否处于事务中 */
  get inTransaction(): boolean {
    return this._txDepth > 0;
  }

  // ==================== 执行 ====================

  /**
   * 执行一条命令并入栈
   *
   * @returns 命令的 execute 抛错时会向上冒泡，且**不入栈**——
   *          失败的命令不该留下撤销记录
   */
  do(cmd: ICommand): void {
    /**
     * 【⚠️ 事务中必须先入缓冲区，再 execute】
     *
     * 老实现是"先 execute，成功后再 push 进 buffer"。
     * 如果 `execute()` **执行到一半抛错**（先改了外部状态、再 throw），
     * 这条命令根本没进 buffer，
     * 于是 `rollback()` 逆序 undo 时不会撤销它——**副作用残留**。
     *
     * 实测（修复前）：
     * ```
     * transact('tx', () => { stack.do(ok); stack.do(bad); })
     * // bad.execute 里先 outside += 100 然后 throw
     * // 抛出后 outside === 100（应为 0），undoDepth === 0
     * ```
     * ok 被正确回滚，但 bad 的 undo **从未被调用**。
     *
     * 后果正是事务要解决的问题本身：一次批量操作失败后，
     * 界面停在"部分已改、部分未改"的中间态，而 `undo` 已经帮不上忙
     * （失败的命令不在栈里）。用户看到"操作失败了，但有些东西已经变了"。
     *
     * 【要求 undo 容忍"部分执行"】
     * 先入 buffer 意味着 `rollback()` 会对一条"execute 未成功完成"的命令调 undo。
     * 命令的 `undo()` 必须能处理这种状态（通常是幂等地把状态改回去）。
     * 这是命令模式的标准要求，也是这里选择先入 buffer 的原因：
     * 宁可多调一次 undo，也不能让已发生的副作用无人负责。
     */
    const inTx = this._txDepth > 0 && this._txBuffer !== null;
    if (inTx) this._txBuffer!.push(cmd);

    // 异常自然向上冒泡（`transact` 的 catch 会接住并 rollback）。
    // 这里**不要** try/catch 吞掉它——吞了 rollback 就不会触发。
    cmd.execute();

    if (inTx) return;

    this._pushUndo(cmd);
    this._redoStack.length = 0;
    this._onLog?.('do', cmd);
    this._onChange?.();
  }

  /** 撤销一步 */
  undo(): boolean {
    if (!this.canUndo) return false;

    const cmd = this._undoStack.pop()!;
    cmd.undo();
    this._redoStack.push(cmd);
    this._onLog?.('undo', cmd);
    this._onChange?.();
    return true;
  }

  /** 重做一步 */
  redo(): boolean {
    if (!this.canRedo) return false;

    const cmd = this._redoStack.pop()!;
    cmd.execute();
    this._pushUndo(cmd);
    this._onLog?.('redo', cmd);
    this._onChange?.();
    return true;
  }

  /** 连续撤销 n 步 */
  undoMany(n: number): number {
    let done = 0;
    for (let i = 0; i < n && this.canUndo; i++) {
      if (this.undo()) done++;
    }
    return done;
  }

  redoMany(n: number): number {
    let done = 0;
    for (let i = 0; i < n && this.canRedo; i++) {
      if (this.redo()) done++;
    }
    return done;
  }

  // ==================== 事务 ====================

  /**
   * 开始一个事务
   *
   * 【为什么需要】
   * 「移动一个物体」可能由多条子命令组成（解除绑定、改坐标、重算碰撞）。
   * 如果它们各自入栈，玩家要按 3 次撤销才能退回去。
   *
   * 事务让它们合并成一条，撤销一次全部回退。
   *
   * 【支持嵌套】内层事务并入外层，只有最外层提交时才入栈。
   *
   * 【⚠️ 曾经没有做失败回滚】
   * 事务执行到一半抛错时，已经执行过的命令没有回滚——
   * 结果是「界面显示操作失败，但世界已经改了一半」。
   * 现在 `commit()` 前若捕获到异常，会自动回滚已执行的部分。
   */
  begin(name = 'transaction'): void {
    this._txDepth++;
    if (this._txDepth === 1) {
      this._txBuffer = [];
      this._txName = name;
    }
  }

  /**
   * 提交事务
   *
   * @returns 合并后的命令（已入栈）
   */
  commit(): ICommand | null {
    if (this._txDepth === 0) return null;
    this._txDepth--;

    // 内层事务：交给外层
    if (this._txDepth > 0) return null;

    const buffer = this._txBuffer ?? [];
    this._txBuffer = null;

    if (buffer.length === 0) return null;

    const name = this._txName;
    const macro: ICommand = {
      name,
      execute: () => {
        /**
         * 【⚠️ 曾经的 bug：重做时重复执行了 execute】
         *
         * 事务内的命令在 `do()` 时**已经执行过**了，
         * 入栈的是「已完成的命令集合」。
         * 所以 macro.execute 只应在**重做**时调用。
         *
         * 但 commit 后入栈的 macro 会被 undo() 弹出并调用 undo()，
         * 之后再 redo() 调用 execute() —— 此时才需要真正重放。
         *
         * 原实现在 commit 时就调用一次 execute()，导致副作用发生两次：
         * 建造一次扣了 100 金币而不是 50。
         *
         * 现在：commit 不执行，只入栈；重做才重放。
         */
        for (const c of buffer) c.execute();
      },
      undo: () => {
        // ⚠️ 逆序撤销——顺序错了在有关联的操作上会出问题
        for (let i = buffer.length - 1; i >= 0; i--) buffer[i].undo();
      },
    };

    this._pushUndo(macro);
    this._redoStack.length = 0;
    this._onLog?.('do', macro);
    this._onChange?.();
    return macro;
  }

  /**
   * 回滚事务（撤销已执行的部分）
   *
   * @returns 回滚的命令数
   */
  rollback(): number {
    if (this._txDepth === 0) return 0;
    this._txDepth = 0;

    const buffer = this._txBuffer ?? [];
    this._txBuffer = null;

    for (let i = buffer.length - 1; i >= 0; i--) {
      try {
        buffer[i].undo();
      } catch {
        // 单条回滚失败不能中断整体回滚，否则残留更多脏状态
      }
    }
    this._onChange?.();
    return buffer.length;
  }

  /**
   * 便捷写法：以事务方式执行一段代码，异常时自动回滚
   *
   * ```typescript
   * stack.transact('批量移动', () => {
   *   for (const id of selected) stack.do(moveCmd(id, dx, dy));
   * });
   * ```
   */
  transact<T>(name: string, fn: () => T): T {
    this.begin(name);
    try {
      const r = fn();
      this.commit();
      return r;
    } catch (e) {
      this.rollback();
      throw e;
    }
  }

  // ==================== 清理 ====================

  clear(): void {
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._txDepth = 0;
    this._txBuffer = null;
    this._onChange?.();
  }

  /** 丢弃撤销历史（换场景、读档后用） */
  clearHistory(): void {
    this.clear();
  }

  /** 导出状态（调试用） */
  snapshot(): CommandStackSnapshot {
    return {
      undoNames: this._undoStack.map((c) => c.name),
      redoNames: this._redoStack.map((c) => c.name),
    };
  }

  // ==================== 内部 ====================

  private _pushUndo(cmd: ICommand): void {
    if (cmd.undoable === false) {
      // 不可逆命令：清 redo，但不进 undo 栈
      this._onChange?.();
      return;
    }

    // 尝试与栈顶合并
    if (cmd.mergeKey !== undefined && cmd.mergeWith) {
      const top = this._undoStack[this._undoStack.length - 1];
      if (top && top.mergeKey === cmd.mergeKey && top.mergeWith) {
        if (cmd.mergeWith(top)) {
          this._onChange?.();
          return;   // 已合并，不新增记录
        }
      }
    }

    this._undoStack.push(cmd);
    if (this._undoStack.length > this._limit) {
      // ⚠️ shift 是 O(n)，但 limit 默认 100 且撤销不频繁，可接受
      this._undoStack.shift();
    }
  }
}

// ==================== 常用命令工厂 ====================

/** 可合并命令的额外能力：让后一条把新值写给前一条 */
interface IMergeableCommand extends ICommand {
  adoptValue(v: unknown): void;
}

function isMergeable(c: ICommand): c is IMergeableCommand {
  return typeof (c as IMergeableCommand).adoptValue === 'function';
}

/**
 * 值变更命令（最常用的一种）
 *
 * 【用途】属性面板、设置项、编辑器字段——
 * 「把 x 从 1 改成 2」这种操作占了撤销需求的 80%。
 *
 * 【合并语义】
 * 拖动滑块会连续产生几十条命令。带 `mergeKey` 时它们会合并成一条：
 *
 * ```
 * 拖动前 x = 10
 * 产生命令：10→11, 11→12, 12→13   （三条，mergeKey 相同）
 * 合并后：  一条「10→13」
 * 撤销一次：回到 10   ← 这是玩家期望的
 * ```
 *
 * 合并的做法是**让旧命令采用新值**，而不是把新命令入栈：
 * 旧命令的 oldValue 是最初的 10，新值是最终的 13。
 *
 * 【⚠️ `oldValue === undefined` 不能用来判断"是否已记录"】
 * 如果 T 本身可以是 undefined（比如 `string | undefined`），
 * 这个判断会失效——每次 redo 都会把 oldValue 刷成当前值，
 * 撤销就再也回不去了。所以用独立的布尔标志。
 */
export function setValueCommand<T>(
  name: string,
  get: () => T,
  set: (v: T) => void,
  newValue: T,
  opts: { mergeKey?: string; onChange?: () => void } = {},
): ICommand {
  let oldValue: T;
  let hasOld = false;
  let value = newValue;

  const cmd: IMergeableCommand = {
    name,
    mergeKey: opts.mergeKey,
    execute: () => {
      // 只在首次执行时记录旧值；redo 时保持最初那个
      if (!hasOld) {
        oldValue = get();
        hasOld = true;
      }
      set(value);
      opts.onChange?.();
    },
    undo: () => {
      if (hasOld) set(oldValue);
      opts.onChange?.();
    },
    mergeWith: (prev) => {
      if (isMergeable(prev)) {
        prev.adoptValue(value);   // 旧命令采用最新值，自己不入栈
        return true;
      }
      return false;
    },
    adoptValue: (v: unknown) => {
      value = v as T;
    },
  };
  return cmd;
}
