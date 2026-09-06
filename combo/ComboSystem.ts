/**
 * combo/ComboSystem.ts —— 连招（输入序列 → 招式）
 *
 * 【它解决什么】
 *
 * 玩家按"轻轻重"，角色打出一套连击而不是三次普通攻击。
 * 这是动作游戏的深度来源，也是最容易做崩的地方。
 *
 * 朴素实现（`if (lastInput === 'light' && now === 'light')`）的问题：
 * - 加招式要改一串 if，招式一多就变成意大利面
 * - **无法处理"前缀冲突"**：`轻轻` 和 `轻轻重` 都想匹配时怎么办？
 * - 输入窗口写死在代码里，调手感要重编译
 *
 * 【本模块的核心设计：前缀树（Trie）】
 *
 * ```
 * 轻 → 轻 → [终结技A]
 *           └→ 重 → [终结技B]
 * ```
 *
 * 走到 `轻轻` 时，系统知道：
 * - 现在是 `终结技A` 的候选
 * - 如果下一输入是 `重`，会变成 `终结技B`
 *
 * 所以必须**等一个输入窗口**才知道玩家想出哪一招。
 * 这段等待时间就是连招手感的来源。
 *
 * 【零业务依赖】
 *
 * 它不认识"轻攻击""重攻击"。
 * 输入是开放字符串（`'light'` / `'A'` / `'↓↘→+P'` 都行），
 * 招式产出的是 `moveId` 字符串。
 */
import { clampNum, numOr, safeDt } from '../_core/math';

// ============================================================
// 数据结构
// ============================================================

/** 招式定义 */
export interface MoveDef {
  readonly id: string;
  /** 输入序列 */
  readonly inputs: readonly string[];
  /**
   * 优先级。同序列冲突时取大的
   *
   * 【用途】遗物/技能解锁了"强化版升龙"时，
   * 用更高优先级覆盖原招式，不用改配置顺序。
   */
  readonly priority?: number;
  /**
   * 该招式可用的额外条件（返回 false 则跳过）
   *
   * 【用途】"需要在空中""需要满气"
   */
  readonly condition?: (ctx: ComboContext) => boolean;
  /**
   * 该招式的输入窗口覆盖（秒）
   *
   * 不填则用全局 `inputWindow`。
   * 【用途】升龙这类需要快速输入的招式给更短的窗口
   */
  readonly window?: number;
  /** 业务数据（原样透传给回调） */
  readonly data?: unknown;
}

export interface ComboContext {
  /** 已经打出的招式序列（最近在最后） */
  readonly history: readonly string[];
  /** 距离上次输入过了多久（秒） */
  readonly sinceLastInput: number;
  /** 当前是否在地面上（由外部设置） */
  readonly grounded: boolean;
  /**
   * 外部状态（业务自定义）
   *
   * 【为什么是 any 而不是泛型】
   * 泛型会让每次使用都要写类型参数，很啰嗦。
   * 这里用 unknown + 业务自己 downcast，
   * 换取零业务依赖与配置友好。
   */
  readonly state: unknown;
}

/** 招式触发结果 */
export interface MoveTriggered {
  readonly moveId: string;
  /** 匹配到的输入序列长度 */
  readonly length: number;
  /** 业务数据 */
  readonly data?: unknown;
}

// ============================================================
// 前缀树
// ============================================================

interface TrieNode {
  readonly children: Map<string, TrieNode>;
  /** 到此节点结束的招式（可能有多个，按优先级取） */
  moves: MoveDef[];
  /** 是否为某个招式的中间节点 */
  isPrefix: boolean;
}

function makeNode(): TrieNode {
  return { children: new Map(), moves: [], isPrefix: false };
}

// ============================================================
// 配置
// ============================================================

export interface ComboSystemOptions {
  readonly moves: readonly MoveDef[];
  /**
   * 默认输入窗口（秒）。默认 0.4
   *
   * 【怎么调】
   * - 0.25~0.3：硬核（鬼泣、忍者龙剑传）
   * - **0.35~0.45**（默认）：标准动作游戏
   * - 0.6+：休闲，几乎不会失败
   *
   * 【坑】太短会让玩家"明明按了却没出招"，
   * 而且玩家**不知道是自己手慢还是游戏有 bug**——
   * 这会严重损害信任感。宁可长一点。
   */
  inputWindow?: number;
  /**
   * 出招后到下一个序列开始的间隔（秒）。默认 0.1
   *
   * 【用途】防止 A 招的输入被 B 招"吃掉"
   */
  recovery?: number;
  /**
   * 历史记录长度。默认 8
   *
   * 【只影响 condition 回调能看到多少历史】
   */
  historySize?: number;
  onMove?: (m: MoveTriggered) => void;
  /** 输入无匹配（可选：用于播"空挥"音效） */
  onMismatch?: (input: string) => void;
}

// ============================================================
// 实现
// ============================================================

export class ComboSystem {
  private readonly _root = makeNode();
  private readonly _moves: MoveDef[] = [];
  private readonly _window: number;
  private readonly _recovery: number;
  private readonly _historySize: number;

  /** 当前匹配路径上的节点栈 */
  private readonly _path: TrieNode[] = [];
  /** 当前已缓冲的输入 */
  private readonly _buffer: string[] = [];
  private _timeSinceInput = 0;
  private _locked = 0;
  /**
   * 硬直期间的输入缓冲（单槽）
   *
   * 【为什么需要：这是动作游戏"跟手"的关键】
   *
   * 玩家打完一招后，角色有 0.1~0.2 秒后摇。
   * 这段时间里玩家已经在按下一招了——
   * 如果直接丢弃，玩家会觉得"按了没反应"，然后疯狂连按。
   *
   * 标准做法是**输入缓冲**：后摇结束的瞬间自动兑现这一下。
   * 玩家的主观感受是"角色完全跟手"。
   *
   * 【为什么单槽】
   * 多槽会让玩家在硬直里狂按五下、硬直一结束连出五招——
   * 那不是流畅，是失控。单槽只保留**最后一次**输入，
   * 既保证了跟手感，又不会积压。
   */
  private _buffered: string | null = null;
  private readonly _history: string[] = [];

  grounded = true;
  state: unknown = null;

  onMove?: (m: MoveTriggered) => void;
  onMismatch?: (input: string) => void;

  constructor(opts: ComboSystemOptions) {
    this._window = Math.max(0.01, numOr(opts.inputWindow, 0.4));
    this._recovery = Math.max(0, numOr(opts.recovery, 0.1));
    this._historySize = clampNum(opts.historySize, 1, 1e6, 8);
    this.onMove = opts.onMove;
    this.onMismatch = opts.onMismatch;

    for (const m of opts.moves) this._insert(m);
  }

  get moveCount(): number {
    return this._moves.length;
  }

  /** 当前缓冲的输入序列（调试用） */
  get buffered(): readonly string[] {
    return this._buffer;
  }

  /** 是否正在等待连招输入（用于 UI 提示"可以继续"） */
  get pending(): boolean {
    return this._path.length > 0 && this._peek() !== null;
  }

  // ---- 构建 ----

  private _insert(m: MoveDef): void {
    if (m.inputs.length === 0) {
      throw new Error(`[Combo] 招式 ${m.id} 的输入序列为空`);
    }
    this._moves.push(m);

    let node = this._root;
    for (const input of m.inputs) {
      let next = node.children.get(input);
      if (!next) {
        next = makeNode();
        node.children.set(input, next);
      }
      next.isPrefix = true;
      node = next;
    }
    node.moves.push(m);
    // 优先级降序，取第一个满足条件的
    node.moves.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  // ---- 核心 ----

  /**
   * 输入一个动作
   *
   * @returns 触发的招式；没触发返回 null
   *
   * 【⚠️ 返回 null 不代表"输入无效"】
   * 可能只是还在等待后续输入（比如刚按了"轻"，
   * 系统在等下一个输入决定是"轻轻"还是"轻重"）。
   *
   * 用 `pending` 区分这两种情况。
   */
  input(action: string): MoveTriggered | null {
    if (this._locked > 0) {
      // 硬直中：存入缓冲，硬直结束的瞬间自动兑现（见上方 _buffered 注释）
      this._buffered = action;
      return null;
    }

    // ① 尝试沿当前路径前进
    const cur = this._path.length > 0 ? this._path[this._path.length - 1] : this._root;
    const next = cur.children.get(action);

    if (next) {
      this._path.push(next);
      this._buffer.push(action);
      this._timeSinceInput = 0;

      return this._tryEmit(next);
    }

    // ② 走不通：尝试从根重新开始
    this._resetPath();
    const fromRoot = this._root.children.get(action);
    if (fromRoot) {
      this._path.push(fromRoot);
      this._buffer.push(action);
      this._timeSinceInput = 0;
      return this._tryEmit(fromRoot);
    }

    // ③ 完全无匹配
    this.onMismatch?.(action);
    return null;
  }

  /**
   * 每帧调用
   *
   * 【必须调用】连招窗口超时只在这里判定。
   * 忘了调的话，输入会一直挂在缓冲区里——
   * 表现为"过了一会儿自己出招"，非常诡异。
   */
  tick(dt: number): MoveTriggered | null {
    /**
     * 【⚠️ 曾经的 bug：硬直结束的那一帧被整帧丢弃】
     *
     * 原写法在 `_locked` 归零后直接 `return`，
     * 于是"硬直刚好结束"的这一帧不会去检查输入窗口超时。
     *
     * 后果：玩家按 A → 出招（硬直 0.1s）→ 按 B →
     * 第一帧 tick 只用来清硬直，B 的窗口判定延后一帧。
     * 低帧率（30fps）时这一帧是 33ms，
     * 连招窗口的精度直接损失 33ms——手感变糊。
     *
     * 正确做法：清掉硬直后**继续往下走**，
     * 用剩余时间（或本帧全部时间）处理窗口判定。
     */
    if (this._locked > 0) {
      this._locked -= dt;
      if (this._locked > 0) return null;
      this._locked = 0;
    }

    // 硬直刚结束：兑现缓冲的输入
    if (this._buffered !== null) {
      const action = this._buffered;
      this._buffered = null;
      const r = this.input(action);
      if (r) return r;                  // 缓冲的输入直接出招
      if (this._path.length === 0) return null;
      if (!safeDt(dt)) return null;
      // 输入刚发生，本帧不累计窗口时间
      return null;
    }

    if (this._path.length === 0) return null;
    if (!safeDt(dt)) return null;

    this._timeSinceInput += dt;

    const cur = this._path[this._path.length - 1];
    const win = this._windowFor(cur);
    if (this._timeSinceInput >= win) {
      // 窗口到了：出当前能出的招
      const result = this._emitForce(cur);
      this._resetPath();
      return result;
    }

    return null;
  }

  /** 中断连招（受击、闪避、切状态） */
  cancel(): void {
    this._resetPath();
    this._buffered = null;
  }

  /** 重置（角色死亡、过场） */
  reset(): void {
    this._resetPath();
    this._history.length = 0;
    this._locked = 0;
    this._buffered = null;
  }

  // ---- 内部 ----

  private _ctx(): ComboContext {
    return {
      history: this._history,
      sinceLastInput: this._timeSinceInput,
      grounded: this.grounded,
      state: this.state,
    };
  }

  /**
   * 尝试出招
   *
   * 【核心逻辑：什么时候立刻出，什么时候再等等】
   *
   * 到达节点 A 后：
   * - A 有招式 且 **没有更长的后续** → 立刻出
   * - A 有招式 且 **有更长的后续** → **等一个窗口**
   *   （因为玩家可能想打更长的连招）
   * - A 只有后续没有招式 → 继续等
   */
  private _tryEmit(node: TrieNode): MoveTriggered | null {
    const available = node.moves.filter((m) => !m.condition || m.condition(this._ctx()));
    const hasLonger = node.children.size > 0;

    if (available.length > 0 && !hasLonger) {
      // 没有更长的可能，立刻出招
      return this._emit(available[0]);
    }
    // 有更长的可能 → 等窗口（tick 里会处理超时出招）
    return null;
  }

  /** 窗口到期，强制出招 */
  private _emitForce(node: TrieNode): MoveTriggered | null {
    const available = node.moves.filter((m) => !m.condition || m.condition(this._ctx()));
    if (available.length === 0) return null;
    return this._emit(available[0]);
  }

  private _emit(move: MoveDef): MoveTriggered | null {
    const result: MoveTriggered = {
      moveId: move.id,
      length: this._buffer.length,
      ...(move.data !== undefined ? { data: move.data } : {}),
    };

    this._history.push(move.id);
    if (this._history.length > this._historySize) this._history.shift();

    this._resetPath();
    this._locked = this._recovery;
    this.onMove?.(result);
    return result;
  }

  /** 当前节点能出的招（用于 UI 显示"可以接什么"） */
  private _peek(): MoveDef | null {
    if (this._path.length === 0) return null;
    const cur = this._path[this._path.length - 1];
    const available = cur.moves.filter((m) => !m.condition || m.condition(this._ctx()));
    return available[0] ?? null;
  }

  private _windowFor(node: TrieNode): number {
    const m = node.moves.find((x) => !x.condition || x.condition(this._ctx()));
    return m?.window ?? this._window;
  }

  private _resetPath(): void {
    this._path.length = 0;
    this._buffer.length = 0;
    this._timeSinceInput = 0;
  }

  /** 是否有待兑现的缓冲输入（调试/UI 用） */
  get bufferedInput(): string | null {
    return this._buffered;
  }
}

// ============================================================
// 配置校验
// ============================================================

export interface ComboValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 校验连招表
 *
 * 【为什么要校验】
 *
 * 两类错误在运行时**完全静默**：
 *
 * ① **遮蔽（shadowing）**
 * ```
 * 招式A：轻 轻 重
 * 招式B：轻 轻        ← B 是 A 的前缀
 * ```
 * 但 A 没有子路径（比如配错了），
 * 结果是 A 永远打不出来——玩家按"轻轻重"只会出 B + 一次无效输入。
 *
 * ② **条件互斥**
 * 两个招式序列相同但条件永远不同时满足 → 其中一个死配置。
 */
export function validateCombos(moves: readonly MoveDef[]): ComboValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const seen = new Map<string, MoveDef[]>();
  for (const m of moves) {
    if (m.inputs.length === 0) {
      errors.push(`招式 ${m.id} 的输入序列为空`);
      continue;
    }
    const key = m.inputs.join('|');
    const arr = seen.get(key);
    if (arr) arr.push(m);
    else seen.set(key, [m]);
  }

  // 完全相同的序列
  for (const [key, arr] of seen) {
    if (arr.length > 1) {
      const noCond = arr.filter((m) => !m.condition).length;
      if (noCond > 1) {
        errors.push(
          `序列 [${key}] 有 ${noCond} 个无条件招式（${arr.map((m) => m.id).join(', ')}）——` +
          `只会触发优先级最高的，其余是死配置`
        );
      } else if (noCond === 1) {
        const shadowed = arr.filter((m) => m.condition).map((m) => m.id);
        if (shadowed.length > 0) {
          warnings.push(
            `序列 [${key}] 有 1 个无条件招式，条件招式 ${shadowed.join(', ')} 可能永远不触发`
          );
        }
      }
    }
  }

  // 前缀遮蔽：短招式是否让长招式打不出来
  for (const m of moves) {
    for (const other of moves) {
      if (m.id === other.id) continue;
      if (other.inputs.length >= m.inputs.length) continue;
      const isPrefix = other.inputs.every((x, i) => x === m.inputs[i]);
      if (isPrefix) {
        warnings.push(
          `招式 ${m.id} [${m.inputs.join(' ')}] 的前缀是 ${other.id} [${other.inputs.join(' ')}]——` +
          `如果 ${other.id} 触发后不保留路径，${m.id} 将永远打不出来`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
