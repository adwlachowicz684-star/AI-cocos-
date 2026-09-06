/**
 * DialogueGraph —— 对话系统（节点图 + 条件分支）
 *
 * 【它解决什么】
 *
 * 对话如果写成 if-else 嵌套，第 20 句台词时就已经没法维护了。
 * 做成**数据**后：
 * - 策划能在表里写
 * - 能做可视化编辑器
 * - 能做本地化（文本用 key，不放内容）
 * - 能单测"走到某个分支需要什么条件"
 *
 * 【设计：图而不是树】
 * 用图（节点 + 跳转）而不是树，因为对话经常需要**回到之前的节点**
 * （"让我再想想"→ 回到选项列表），这在树里要复制子树。
 *
 * 【使用示例】
 * ```typescript
 * const g = new DialogueGraph();
 *
 * g.node('start', {
 *   speaker: '铁匠',
 *   text: '想打造点什么？',
 *   choices: [
 *     { text: '打造武器', next: 'craft', condition: (s) => s.gold >= 100 },
 *     { text: '闲聊',     next: 'smalltalk' },
 *     { text: '再见',     next: null },
 *   ],
 * });
 *
 * g.node('craft', { speaker: '铁匠', text: '好嘞', onEnter: (s) => { s.gold -= 100; }, next: 'start' });
 * g.node('smalltalk', { speaker: '铁匠', text: '今天天气不错', next: 'start' });
 *
 * const runner = g.start('start', { gold: 150 });
 * runner.current;              // { speaker, text, choices }
 * runner.choose(0);            // 选"打造武器"
 * runner.current.speaker;      // '铁匠'
 * runner.isDone;               // false（craft 的 next 指回 start）
 *
 * runner.choose(2);            // 选"再见"（next: null）
 * runner.isDone;               // true
 * ```
 *
 * 【无引擎依赖】状态类型由调用方定义（游戏存档、任务进度、好感度……）
 */

/** 对话运行时的外部状态（由调用方提供：存档、任务进度等） */
export type DialogueState = Record<string, unknown>;

/**
 * 【为什么运行器的状态类型是 S extends object 而不是 S extends DialogueState】
 *
 * DialogueState（= Record<string, unknown>）要求有索引签名。
 * 但你自己的状态类型通常是：
 * ```typescript
 * interface GameState { gold: number; hasQuest: boolean }
 * ```
 * 这个类型**不满足** `Record<string, unknown>`（缺索引签名），
 * 会被编译器拒绝——逼你在自己的类型上加 `[k: string]: unknown`，
 * 那既啰嗦又会让所有属性访问失去类型检查。
 *
 * 所以内部默认用 DialogueState，泛型约束放宽到 `object`。
 */

export interface Choice<S = DialogueState> {
  /** 选项文本（或本地化 key） */
  readonly text: string;
  /** 跳转到哪个节点。null = 结束对话 */
  readonly next: string | null;
  /** 显示条件。不填 = 总是显示 */
  readonly condition?: (state: S) => boolean;
  /** 不满足条件时是否显示为灰色（而不是隐藏） */
  readonly showDisabled?: boolean;
  /** 选中时执行 */
  readonly onSelect?: (state: S) => void;
  /** 不满足条件时的提示（"需要 100 金币"） */
  readonly lockedHint?: string;
}

export interface DialogueNode<S = DialogueState> {
  readonly id: string;
  /** 说话者名字（或 key） */
  readonly speaker?: string;
  /** 正文（或 key） */
  readonly text: string;
  /** 选项。不填 = 单句节点，用 next 推进 */
  readonly choices?: readonly Choice<S>[];
  /** 单句节点的下一个节点。null = 结束 */
  readonly next?: string | null;
  /** 进入节点时执行（推进任务、扣钱、给物品） */
  readonly onEnter?: (state: S) => void;
  /** 离开节点时执行 */
  readonly onExit?: (state: S) => void;
  /** 立绘 / 表情（由渲染层解释） */
  readonly portrait?: string;
  /** 额外数据（音效、动画指令……） */
  readonly meta?: unknown;
}

/** 当前展示给用户的内容 */
export interface DialogueView {
  readonly nodeId: string;
  readonly speaker?: string;
  readonly text: string;
  readonly portrait?: string;
  readonly choices: Array<{
    readonly index: number;
    readonly text: string;
    readonly enabled: boolean;
    readonly hint?: string;
  }>;
}

export class DialogueGraph<S extends object = DialogueState> {
  private readonly _nodes = new Map<string, DialogueNode<S>>();

  /** 注册节点 */
  node(id: string, def: Omit<DialogueNode<S>, 'id'>): this {
    if (this._nodes.has(id)) throw new Error(`[Dialogue] 节点 "${id}" 已存在`);
    this._nodes.set(id, { ...def, id });
    return this;
  }

  /** 批量注册 */
  nodes(defs: ReadonlyArray<DialogueNode<S>>): this {
    for (const d of defs) {
      if (this._nodes.has(d.id)) throw new Error(`[Dialogue] 节点 "${d.id}" 已存在`);
      this._nodes.set(d.id, d);
    }
    return this;
  }

  has(id: string): boolean {
    return this._nodes.has(id);
  }

  get nodeIds(): string[] {
    return Array.from(this._nodes.keys());
  }

  /**
   * 校验图的完整性
   *
   * 【用途】启动时跑一次，能发现"跳转到了不存在的节点"——
   * 这类错误在运行时表现为"对话说到一半卡住"，而且是特定分支才触发。
   */
  validate(): string[] {
    const errors: string[] = [];
    for (const node of this._nodes.values()) {
      if (node.choices) {
        if (node.choices.length === 0) {
          errors.push(`节点 "${node.id}" 的 choices 是空数组（应用 next 或设为 undefined）`);
        }
        for (const c of node.choices) {
          if (c.next !== null && !this._nodes.has(c.next)) {
            errors.push(`节点 "${node.id}" 的选项 "${c.text}" 跳转到不存在的节点 "${c.next}"`);
          }
        }
      } else if (node.next !== undefined && node.next !== null && !this._nodes.has(node.next)) {
        errors.push(`节点 "${node.id}" 的 next 指向不存在的节点 "${node.next}"`);
      }
    }
    return errors;
  }

  /** 找出从 startId 不可达的节点（死内容） */
  findUnreachable(startId: string): string[] {
    const seen = new Set<string>();
    const queue = [startId];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);

      const node = this._nodes.get(id);
      if (!node) continue;

      if (node.choices) {
        for (const c of node.choices) if (c.next) queue.push(c.next);
      } else if (node.next) {
        queue.push(node.next);
      }
    }

    return Array.from(this._nodes.keys()).filter((id) => !seen.has(id));
  }

  /** 开始一段对话 */
  start(startId: string, state: S): DialogueRunner<S> {
    if (!this._nodes.has(startId)) {
      throw new Error(`[Dialogue] 起始节点 "${startId}" 不存在`);
    }
    return new DialogueRunner<S>(this, startId, state);
  }

  /** 内部：取节点 */
  getNode(id: string): DialogueNode<S> | undefined {
    return this._nodes.get(id);
  }

  destroy(): void {
    this._nodes.clear();
  }
}

/**
 * 对话运行器
 *
 * 【为什么单独一个类】
 * 图是**静态数据**（所有玩家共享），运行器是**会话状态**（每个玩家一段对话一个）。
 * 分开后才能多人/多次同时对话而互不干扰。
 */
export class DialogueRunner<S extends object = DialogueState> {
  private readonly _graph: DialogueGraph<S>;
  private readonly _state: S;
  private _currentId: string | null;
  private _done = false;

  /** 走过的路径（用于"回到上一句"和调试） */
  private readonly _history: string[] = [];

  constructor(graph: DialogueGraph<S>, startId: string, state: S) {
    this._graph = graph;
    this._state = state;
    this._currentId = startId;
    this._enterCurrent();
  }

  get isDone(): boolean {
    return this._done;
  }

  get currentNodeId(): string | null {
    return this._currentId;
  }

  get history(): readonly string[] {
    return this._history;
  }

  /** 当前展示内容（渲染层直接读这个） */
  get current(): DialogueView | null {
    if (this._currentId === null) return null;
    const node = this._graph.getNode(this._currentId);
    if (!node) return null;

    const choices = (node.choices ?? []).map((c, index) => {
      const enabled = c.condition ? c.condition(this._state) : true;
      return {
        index,
        text: c.text,
        enabled,
        ...(enabled ? {} : c.lockedHint ? { hint: c.lockedHint } : {}),
      };
    });

    return {
      nodeId: node.id,
      ...(node.speaker !== undefined ? { speaker: node.speaker } : {}),
      text: node.text,
      ...(node.portrait !== undefined ? { portrait: node.portrait } : {}),
      choices,
    };
  }

  /**
   * 推进（无选项的单句节点用这个）
   *
   * @returns 是否成功推进。false = 对话已结束或当前节点有选项
   */
  advance(): boolean {
    if (this._done || this._currentId === null) return false;

    const node = this._graph.getNode(this._currentId);
    if (!node) return false;
    if (node.choices && node.choices.length > 0) {
      // 有选项的节点必须用 choose
      return false;
    }

    node.onExit?.(this._state);
    this._goto(node.next ?? null);
    return true;
  }

  /**
   * 选择一个选项
   *
   * @param index 选项下标
   * @returns 是否成功。false = 下标无效 或 该选项当前不可用
   */
  choose(index: number): boolean {
    if (this._done || this._currentId === null) return false;

    const node = this._graph.getNode(this._currentId);
    if (!node?.choices) return false;

    const choice = node.choices[index];
    if (!choice) return false;
    if (choice.condition && !choice.condition(this._state)) return false;

    choice.onSelect?.(this._state);
    node.onExit?.(this._state);
    this._goto(choice.next);
    return true;
  }

  /** 直接跳到某个节点（任务系统强行插入对话时用） */
  jumpTo(id: string): boolean {
    if (!this._graph.has(id)) return false;
    const old = this._graph.getNode(this._currentId ?? '');
    old?.onExit?.(this._state);
    this._goto(id);
    return true;
  }

  /** 强制结束 */
  end(): void {
    const node = this._graph.getNode(this._currentId ?? '');
    node?.onExit?.(this._state);
    this._currentId = null;
    this._done = true;
  }

  /**
   * 自动推进到下一个"需要玩家输入"的节点
   *
   * 【用途】
   * 一串连续的独白（A 说话 → B 说话 → A 说话 → 出现选项），
   * 玩家点一下应该连续播过去，而不是每句都点。
   *
   * 【安全上限】防止 next 形成环导致死循环。
   */
  advanceToChoice(maxSteps = 50): boolean {
    let steps = 0;
    while (!this._done && this._currentId !== null && steps < maxSteps) {
      const node = this._graph.getNode(this._currentId);
      if (!node) break;
      if (node.choices && node.choices.length > 0) return true; // 到了有选项的节点
      if (!this.advance()) break;
      steps++;
    }
    return this._currentId !== null && !this._done;
  }

  private _goto(id: string | null): void {
    this._currentId = id;
    if (id === null) {
      this._done = true;
      return;
    }
    this._enterCurrent();
  }

  private _enterCurrent(): void {
    if (this._currentId === null) return;
    this._history.push(this._currentId);
    this._graph.getNode(this._currentId)?.onEnter?.(this._state);
  }

  destroy(): void {
    this._history.length = 0;
    this._currentId = null;
    this._done = true;
  }
}
