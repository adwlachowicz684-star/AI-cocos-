/**
 * DebugConsole —— 运行时调试控制台
 *
 * 【它解决什么】
 *
 * 没有调试控制台时，你想验证「这个遗物到底有没有生效」，
 * 流程是：改代码 → 重新编译 → 重启游戏 → 打三分钟到那个场景 → 看日志。
 * 一轮 5 分钟，一天下来光在等编译。
 *
 * 有了控制台，流程是：按 ` 键 → 输入 `add_relic crit_boost` → 回车。三秒。
 *
 * 【它提供什么】
 * - 命令注册与解析（带参数类型：int / float / string / bool / enum）
 * - **自动补全**（Tab）与历史（上下箭头）
 * - 参数校验与**清晰的错误提示**（不是 "undefined is not a function"）
 * - 输出回调（宿主决定打印到引擎控制台、屏幕上的面板、还是文件）
 * - 内置命令：help（h / ?） / history / clear（cls） / find
 *
 * 【⚠️ 上面这行曾经写着 "help / history / clear / alias / set / find"】
 * 但 `alias` 与 `set` **从未注册**——全文件 grep 没有 `name: 'alias'`。
 * 用户照着输入会得到"未知命令"。审查时发现并删除。
 *
 * 教训：命令清单这类"一眼能数清"的东西，
 * 写完要去 `_registerBuiltins` 里对一遍，别凭印象列。
 *
 * 【它不做什么】
 * **不画任何东西。** UI 完全由宿主实现——
 * 本模块只负责「输入一行文本 → 输出结果」。
 * 这样它在命令行、引擎内、甚至网络远程调试里都能用。
 *
 * 【与 CheatCode 的关系】
 * 控制台是「通用命令入口」；作弊码是「控制台里的一类命令」。
 * 作弊码单独抽出来是因为它需要**权限控制**（正式版要禁用），
 * 而控制台本身在正式版也可能需要保留（只读的诊断命令）。
 *
 * 【无引擎依赖】
 */

// ==================== 参数类型 ====================

import { similarity as similarityCore, tokenize as coreTokenize } from '../_core/string';
import { clampNum } from '../_core/math';
export type ArgType = 'int' | 'float' | 'string' | 'bool' | 'enum';

export interface ArgDef {
  readonly name: string;
  readonly type: ArgType;
  /** 是否必需（默认 true）。可选参数必须排在必需参数之后 */
  readonly optional?: boolean;
  /** 默认值（optional 为 true 时生效） */
  readonly default?: unknown;
  /** enum 类型的候选值（type === 'enum' 时必填） */
  readonly values?: readonly string[];
  /** 帮助文本 */
  readonly help?: string;
  /** 最小值 / 最大值（int / float） */
  readonly min?: number;
  readonly max?: number;
}

export interface CommandDef {
  readonly name: string;
  /** 简写（如 'h' 对应 'help'） */
  readonly alias?: readonly string[];
  readonly args?: readonly ArgDef[];
  readonly help: string;
  /** 分组（help 里按组展示） */
  readonly group?: string;
  /**
   * 是否隐藏（不在 help 与补全里出现）
   * 【用途】内部命令、彩蛋
   */
  readonly hidden?: boolean;
  /** 执行。返回字符串会被输出到控制台 */
  run: (args: ParsedArgs, ctx: CommandContext) => string | void;
}

/** 解析后的参数（已按类型转好） */
export interface ParsedArgs {
  /** 位置参数：args[0] 或 args.get('name') */
  readonly raw: readonly string[];
  get(name: string): unknown;
  getInt(name: string, fallback?: number): number;
  getFloat(name: string, fallback?: number): number;
  getString(name: string, fallback?: string): string;
  getBool(name: string, fallback?: boolean): boolean;
  getEnum(name: string, fallback?: string): string;
}

export interface CommandContext {
  /** 输出一行（不经由返回值，用于多行输出） */
  print(line: string): void;
  /** 清空屏幕 */
  clear(): void;
  /** 发起该命令的时间（毫秒） */
  readonly now: number;
}

// ==================== 错误 ====================

/**
 * 命令错误
 *
 * 【为什么不直接抛 Error】
 * 控制台需要**区分「用户输入错了」和「命令内部崩了」**：
 * - 输入错了 → 打印红色提示，程序继续
 * - 内部崩了 → 记录堆栈，可能是 bug
 */
export class CommandError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'CommandError';
  }
}

// ==================== 实现 ====================

export interface DebugConsoleOptions {
  /**
   * 总开关（默认 **true**）
   *
   * 【⚠️ 正式版请显式关闭】
   * 这个模块允许执行任意注册过的命令，
   * 默认开启意味着"只要创建了实例，命令就能跑"。
   *
   * ```typescript
   * new DebugConsole({ enabled: !IS_PRODUCTION });
   * ```
   *
   * 关闭后 `execute()` 直接返回，**不解析、不执行、不改任何状态**
   * （包括历史记录）。这是刻意的——
   * 关掉的开关不该产生任何副作用，否则"关了但状态被改了"
   * 会变成一个极难排查的问题。
   *
   * 【为什么不默认 false】
   * 那是破坏性变更：所有现有代码创建的 console 会静默失效，
   * 且失效时无提示。这里选择保持默认 true + 未显式传参时警告。
   */
  readonly enabled?: boolean;
  /**
   * 命令前缀（默认空）
   * 设为 '/' 后，只有以 / 开头的输入才当命令，其余当聊天/普通文本
   */
  readonly prefix?: string;
  /** 历史记录上限（默认 100） */
  readonly historyLimit?: number;
  /** 是否启用内置命令（默认 true） */
  readonly builtins?: boolean;
  /** 未知命令时的模糊匹配建议阈值（0~1，默认 0.5） */
  readonly suggestionThreshold?: number;
}

interface Entry {
  readonly def: CommandDef;
}

export class DebugConsole {
  private readonly _commands = new Map<string, Entry>();
  private readonly _history: string[] = [];
  private _historyIndex = -1;
  private readonly _prefix: string;
  private readonly _historyLimit: number;
  private readonly _threshold: number;

  /** 输出目标（宿主注入） */
  private _output: (line: string) => void = () => {};
  private _clear: () => void = () => {};

  private _enabled: boolean;
  /** 用户是否显式传入过 enabled（用于上线警告） */
  private _enabledExplicit = false;

  constructor(opts: DebugConsoleOptions = {}) {
    this._prefix = opts.prefix ?? '';
    this._enabled = opts.enabled ?? true;
    if (opts.enabled !== undefined) this._enabledExplicit = true;
    this._historyLimit = clampNum(opts.historyLimit, 1, 1e6, 100);
    this._threshold = opts.suggestionThreshold ?? 0.5;
    if (opts.builtins !== false) this._registerBuiltins();

    /**
     * 【上线安全兜底】与 cheatcode 保持一致的策略
     *
     * 只在「没显式传 enabled 且最终为 true」时警告一次。
     * 显式传 `true` 的人说明想清楚了，不打扰。
     *
     * 【外部安全审查 S2-2 指出】
     * 这个模块原先**完全没有开关**——
     * 源码里 0 处 enabled / permission。
     * 只要创建了实例，命令就一定能执行。
     */
    if (opts.enabled === undefined && this._enabled) {
      console.warn(
        '[DebugConsole] 未显式传入 enabled，默认开启。' +
        '正式版请传 `enabled: !IS_PRODUCTION`，' +
        '否则调试命令会带到线上。'
      );
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * 运行时可改
   *
   * 【⚠️ `readonly` 只是编译期约束】
   * 配置接口里写 `readonly enabled?` 只表示"构造后不该改这个字段对象"，
   * **不表示类实例的 enabled 不可变**。这里两者都可变，是刻意的：
   * 调试台需要能热开关（比如线上按特定手势临时打开）。
   */
  set enabled(v: boolean) {
    this._enabled = v;
    this._enabledExplicit = true;
  }

  /** 用户是否显式设置过 enabled（测试与自检用） */
  get enabledWasExplicit(): boolean {
    return this._enabledExplicit;
  }

  // ==================== 注册 ====================

  register(def: CommandDef): this {
    if (this._commands.has(def.name)) {
      throw new Error(`[DebugConsole] 命令重复：${def.name}`);
    }
    // 【构造时校验】enum 类型必须给候选值，否则运行时才发现
    for (const a of def.args ?? []) {
      if (a.type === 'enum' && (!a.values || a.values.length === 0)) {
        throw new Error(`[DebugConsole] 命令 ${def.name} 的参数 ${a.name} 是 enum 但没给 values`);
      }
      if (a.optional && a.default === undefined && a.type !== 'bool') {
        throw new Error(
          `[DebugConsole] 命令 ${def.name} 的可选参数 ${a.name} 必须给 default`
        );
      }
    }
    this._commands.set(def.name, { def });
    return this;
  }

  unregister(name: string): boolean {
    return this._commands.delete(name);
  }

  /** 批量注册（插件式） */
  registerAll(defs: readonly CommandDef[]): this {
    for (const d of defs) this.register(d);
    return this;
  }

  has(name: string): boolean {
    return this._commands.has(name);
  }

  /** 所有命令（按名排序，隐藏的排在后面） */
  list(includeHidden = false): readonly CommandDef[] {
    const out: CommandDef[] = [];
    for (const e of this._commands.values()) {
      if (!includeHidden && e.def.hidden) continue;
      out.push(e.def);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ==================== 输入输出绑定 ====================

  onOutput(fn: (line: string) => void): void {
    this._output = fn;
  }

  onClear(fn: () => void): void {
    this._clear = fn;
  }

  // ==================== 执行 ====================

  /**
   * 执行一行输入
   *
   * @param line 原始输入（可带前缀）
   * @returns 是否当作命令处理了（false = 普通文本，宿主可当聊天）
   */
  execute(line: string): boolean {
    // 【零副作用】关闭时直接返回，不解析、不执行、不改历史
    if (!this._enabled) return false;

    const trimmed = line.trim();
    if (trimmed === '') return false;

    if (this._prefix !== '') {
      if (!trimmed.startsWith(this._prefix)) return false;
    }

    const body = this._prefix !== '' ? trimmed.slice(this._prefix.length).trim() : trimmed;
    if (body === '') return false;

    // 历史：不要记录连续重复的两条
    if (this._history[this._history.length - 1] !== body) {
      this._history.push(body);
      if (this._history.length > this._historyLimit) this._history.shift();
    }
    this._historyIndex = -1;

    this._runBody(body);
    return true;
  }

  private _runBody(body: string): void {
    const ctx: CommandContext = {
      print: (l) => this._output(l),
      clear: () => this._clear(),
      now: Date.now(),
    };

    try {
      const { cmd, rest } = this._split(body);
      const entry = this._resolve(cmd);
      if (!entry) {
        const guess = this._suggest(cmd);
        throw new CommandError(
          `未知命令：${cmd}`,
          guess ? `你是不是想输入 "${guess}"？输入 help 查看全部命令。` : '输入 help 查看全部命令。'
        );
      }
      const args = this._parseArgs(entry.def, rest);
      const result = entry.def.run(args, ctx);
      //
      // 【为什么用 typeof 而不是 `!== undefined`】
      // run 返回 `string | void`。`!== undefined` **收窄不了 void**——
      // 部分 TS 版本（含 Cocos 内置版本）会认为这里 result 仍是
      // `string | void`，传给 _output(s: string) 报错。
      // typeof 判断在任何版本下都能正确收窄到 string。
      if (typeof result === 'string' && result !== '') this._output(result);
    } catch (e) {
      if (e instanceof CommandError) {
        this._output(`✗ ${e.message}`);
        if (e.hint) this._output(`  ${e.hint}`);
      } else {
        const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
        this._output(`✗ 命令内部错误：${msg}`);
        // 内部错误是真 bug，向上抛以便崩溃上报捕获
        throw e;
      }
    }
  }

  // ==================== 补全 ====================

  /**
   * Tab 补全
   *
   * @param line 当前输入
   * @returns 补全后的完整输入；无变化时返回原值
   */
  complete(line: string): string {
    const body = this._prefix !== '' && line.startsWith(this._prefix)
      ? line.slice(this._prefix.length)
      : line;

    const parts = body.split(/\s+/);
    const isFirstWord = parts.length === 1;

    if (isFirstWord) {
      const prefix = parts[0].toLowerCase();
      const candidates = this.list()
        .map((d) => d.name)
        .filter((n) => n.toLowerCase().startsWith(prefix));

      if (candidates.length === 0) return line;

      // 公共前缀补全：输入 "se" 有 set / setpos → 补到 "set"
      const common = commonPrefix(candidates);
      const filled = common.length > prefix.length ? common : candidates[0];
      return (line.startsWith(this._prefix) ? this._prefix : '') + filled;
    }

    // 补全参数：目前只处理 enum
    const { cmd, rest } = this._split(body);
    const entry = this._resolve(cmd);
    if (!entry || !entry.def.args) return line;

    /**
     * 【⚠️ 曾经的 bug：输入 "mode " 后按 Tab 没反应】
     *
     * `rest === ''` 时原写法令 `argParts = []`，
     * 于是 `idx = -1`，取不到任何 ArgDef，直接原样返回。
     *
     * 但玩家输入 "mode "（命令名 + 空格 + 空参数）时，
     * 语义上他**正在输入第 0 个参数**，而不是"没有参数"。
     * 正确做法是放一个空串占位，让 idx = 0 命中第一个参数。
     */
    const argParts = rest === '' ? [''] : rest.split(/\s+/);
    const idx = argParts.length - 1;
    const argDef = entry.def.args[idx];
    if (!argDef || argDef.type !== 'enum' || !argDef.values) return line;

    const cur = argParts[idx] ?? '';
    const hits = argDef.values.filter((v) => v.toLowerCase().startsWith(cur.toLowerCase()));
    if (hits.length === 0) return line;

    const common = commonPrefix(hits);
    const use = common.length > cur.length ? common : hits[0];
    argParts[idx] = use;
    return (line.startsWith(this._prefix) ? this._prefix : '') + cmd + ' ' + argParts.join(' ');
  }

  /** 补全候选列表（用于显示下拉） */
  completeCandidates(line: string): readonly string[] {
    const body = this._prefix !== '' && line.startsWith(this._prefix)
      ? line.slice(this._prefix.length)
      : line;
    const parts = body.split(/\s+/);

    if (parts.length === 1) {
      const prefix = parts[0].toLowerCase();
      return this.list()
        .map((d) => d.name)
        .filter((n) => n.toLowerCase().startsWith(prefix))
        .sort();
    }

    const { cmd, rest } = this._split(body);
    const entry = this._resolve(cmd);
    if (!entry?.def.args) return [];

    const argParts = rest === '' ? [''] : rest.split(/\s+/);
    const argDef = entry.def.args[argParts.length - 1];
    if (!argDef || argDef.type !== 'enum' || !argDef.values) return [];

    const cur = argParts[argParts.length - 1] ?? '';
    return argDef.values
      .filter((v) => v.toLowerCase().startsWith(cur.toLowerCase()))
      .sort();
  }

  // ==================== 历史 ====================

  /**
   * 上一条历史
   *
   * 【交互约定】
   * 按下箭头时，如果当前正在编辑一条没提交的输入，
   * 第一次应该能回到它（否则玩家会丢掉手上的输入）。
   * 所以这里用 `_historyIndex = -1` 表示"在编辑新行"。
   */
  historyPrev(current: string): string | null {
    if (this._history.length === 0) return null;
    if (this._historyIndex === -1) {
      this._draft = current;
      this._historyIndex = this._history.length - 1;
    } else if (this._historyIndex > 0) {
      this._historyIndex--;
    }
    return this._history[this._historyIndex] ?? null;
  }

  historyNext(): string | null {
    if (this._historyIndex === -1) return null;
    if (this._historyIndex < this._history.length - 1) {
      this._historyIndex++;
      return this._history[this._historyIndex] ?? null;
    }
    this._historyIndex = -1;
    return this._draft;   // 回到草稿
  }

  private _draft = '';

  get history(): readonly string[] {
    return this._history;
  }

  clearHistory(): void {
    this._history.length = 0;
    this._historyIndex = -1;
    this._draft = '';
  }

  // ==================== 内部 ====================

  private _split(body: string): { cmd: string; rest: string } {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(body);
    if (!m) return { cmd: body, rest: '' };
    return { cmd: m[1], rest: m[2].trim() };
  }

  private _resolve(name: string): Entry | undefined {
    const direct = this._commands.get(name);
    if (direct) return direct;
    // 别名
    for (const e of this._commands.values()) {
      if (e.def.alias?.includes(name)) return e;
    }
    return undefined;
  }

  private _suggest(name: string): string | null {
    let best: string | null = null;
    let bestScore = 0;
    const lower = name.toLowerCase();
    for (const e of this._commands.values()) {
      if (e.def.hidden) continue;
      const score = similarity(lower, e.def.name.toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        best = e.def.name;
      }
    }
    return bestScore >= this._threshold ? best : null;
  }

  private _parseArgs(def: CommandDef, rest: string): ParsedArgs {
    /**
     * 【引号处理】
     * 支持 `give "火焰 之剑" 5` —— 带空格的字符串用引号包起来。
     * 手写 split(' ') 会把它拆成两个参数，
     * 表现为「这个命令有时候参数数量不对」，很难查。
     */
    const raw = tokenize(rest);
    const values = new Map<string, unknown>();

    const argDefs = def.args ?? [];
    let ri = 0;

    for (const a of argDefs) {
      const token = raw[ri];

      if (token === undefined) {
        if (a.optional) {
          values.set(a.name, a.default);
          continue;
        }
        throw new CommandError(
          `命令 ${def.name} 缺少参数 <${a.name}>`,
          usageOf(def)
        );
      }

      values.set(a.name, this._coerce(def, a, token));
      ri++;
    }

    if (ri < raw.length) {
      throw new CommandError(
        `参数过多：${def.name} 只需要 ${argDefs.length} 个，收到 ${raw.length} 个`,
        usageOf(def)
      );
    }

    return makeParsedArgs(raw, values);
  }

  private _coerce(def: CommandDef, a: ArgDef, token: string): unknown {
    switch (a.type) {
      case 'int': {
        const n = Number(token);
        // 【坑】Number('') === 0，Number('1abc') === NaN
        if (!Number.isInteger(n)) {
          throw new CommandError(`参数 <${a.name}> 需要整数，收到 "${token}"`, usageOf(def));
        }
        if (a.min !== undefined && n < a.min) {
          throw new CommandError(`参数 <${a.name}> 不能小于 ${a.min}，收到 ${n}`, usageOf(def));
        }
        if (a.max !== undefined && n > a.max) {
          throw new CommandError(`参数 <${a.name}> 不能大于 ${a.max}，收到 ${n}`, usageOf(def));
        }
        return n;
      }
      case 'float': {
        const n = Number(token);
        if (!Number.isFinite(n)) {
          throw new CommandError(`参数 <${a.name}> 需要数字，收到 "${token}"`, usageOf(def));
        }
        if (a.min !== undefined && n < a.min) {
          throw new CommandError(`参数 <${a.name}> 不能小于 ${a.min}，收到 ${n}`, usageOf(def));
        }
        if (a.max !== undefined && n > a.max) {
          throw new CommandError(`参数 <${a.name}> 不能大于 ${a.max}，收到 ${n}`, usageOf(def));
        }
        return n;
      }
      case 'bool': {
        const t = token.toLowerCase();
        if (['1', 'true', 'yes', 'on', 'y'].includes(t)) return true;
        if (['0', 'false', 'no', 'off', 'n'].includes(t)) return false;
        throw new CommandError(`参数 <${a.name}> 需要 true/false，收到 "${token}"`, usageOf(def));
      }
      case 'enum': {
        const hit = a.values!.find((v) => v.toLowerCase() === token.toLowerCase());
        if (hit === undefined) {
          throw new CommandError(
            `参数 <${a.name}> 只能是 [${a.values!.join(' | ')}]，收到 "${token}"`,
            usageOf(def)
          );
        }
        return hit;
      }
      case 'string':
      default:
        return token;
    }
  }

  // ==================== 内置命令 ====================

  private _registerBuiltins(): void {
    this.register({
      name: 'help',
      alias: ['h', '?'],
      args: [{ name: 'command', type: 'string', optional: true, default: '', help: '命令名' }],
      help: '显示命令列表，或某个命令的详细用法',
      group: '内置',
      run: (a) => {
        const target = a.getString('command', '');
        if (target !== '') {
          const e = this._resolve(target);
          if (!e) return `✗ 没有命令 ${target}`;
          return [
            `${e.def.name} —— ${e.def.help}`,
            `  用法：${usageOf(e.def)}`,
            ...(e.def.args ?? []).map(
              (x) => `    <${x.name}>  ${x.type}${x.optional ? ` (默认 ${String(x.default)})` : ''}${x.help ? `  ${x.help}` : ''}`
            ),
          ].join('\n');
        }

        const groups = new Map<string, CommandDef[]>();
        for (const d of this.list()) {
          const g = d.group ?? '通用';
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g)!.push(d);
        }
        const lines: string[] = ['可用命令：'];
        for (const [g, list] of [...groups.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
          lines.push(`  [${g}]`);
          for (const d of list) {
            lines.push(`    ${usageOf(d).padEnd(34)} ${d.help}`);
          }
        }
        lines.push('', '提示：Tab 补全，↑/↓ 翻历史');
        return lines.join('\n');
      },
    });

    this.register({
      name: 'history',
      help: '显示命令历史',
      group: '内置',
      run: (_a, ctx) => {
        if (this._history.length === 0) return '（空）';
        this._history.forEach((h, i) => ctx.print(`  ${String(i + 1).padStart(3)}  ${h}`));
        return undefined;
      },
    });

    this.register({
      name: 'clear',
      alias: ['cls'],
      help: '清屏',
      group: '内置',
      run: (_a, ctx) => {
        ctx.clear();
        return undefined;
      },
    });

    this.register({
      name: 'find',
      args: [{ name: 'keyword', type: 'string', help: '关键字' }],
      help: '按关键字搜索命令',
      group: '内置',
      run: (a) => {
        const kw = a.getString('keyword').toLowerCase();
        const hits = this.list().filter(
          (d) => d.name.toLowerCase().includes(kw) || d.help.toLowerCase().includes(kw)
        );
        if (hits.length === 0) return `没有匹配 "${kw}" 的命令`;
        return hits.map((d) => `  ${usageOf(d).padEnd(34)} ${d.help}`).join('\n');
      },
    });
  }
}

// ==================== 工具函数 ====================

/** 用法字符串：`give <item:string> [count:int]` */
export function usageOf(def: CommandDef): string {
  const parts = (def.args ?? []).map((a) => {
    const label = `${a.name}:${a.type === 'enum' ? a.values!.join('|') : a.type}`;
    return a.optional ? `[${label}]` : `<${label}>`;
  });
  return [def.name, ...parts].join(' ');
}

/**
 * 词法切分：支持引号包裹的空格
 *
 * ```
 * give "火焰 之剑" 5   →  ['give', '火焰 之剑', '5']
 * ```
 */
export function tokenize(s: string): string[] {
  return coreTokenize(s, {
    onUnclosedQuote: () =>
      new CommandError('引号未闭合', '检查命令里的 " 是否成对'),
  });
}

function commonPrefix(list: readonly string[]): string {
  if (list.length === 0) return '';
  let prefix = list[0];
  for (let i = 1; i < list.length; i++) {
    let j = 0;
    while (j < prefix.length && j < list[i].length && prefix[j] === list[i][j]) j++;
    prefix = prefix.slice(0, j);
    if (prefix === '') break;
  }
  return prefix;
}

/**
 * 编辑距离相似度（0~1）
 *
 * 【为什么不用 includes】
 * 玩家打错的是 `ad_relic`（漏了个 d），
 * 子串匹配下 'ad_relic' 和 'add_relic' 互不包含 → 给不出建议。
 * 编辑距离能兜住这类拼写错误。
 */
/**
 * 【同算法的其他实现 —— 库里共 3 份，别当成一个东西】
 *
 * | 模块 | 函数 | 返回值语义 |
 * |---|---|---|
 * | `cheatcode` | `levenshtein(a, b)` | **距离**，整数，越小越像 |
 * | `di` | `editDistance(a, b)` | **距离**，整数，越小越像 |
 * | `debug-console` | `similarity(a, b)` | **相似度**，0~1，越大越像 |
 *
 * 实测：`"setgold"` vs `"setgld"` → levenshtein = 1，similarity = 0.857。
 *
 * 【坑】距离和相似度是**相反**的方向。
 * 拿 distance 的结果去当相似度用（或反过来），结果会完全颠倒。
 *
 * 【已统一】
 * 三份实现现已合并到 `_core/string.ts`，本函数只是转发。
 * 保留本地名字是为了不破坏已有调用方。
 */
/**
 * 相似度（基于编辑距离归一化）
 *
 * 【实现已下沉到 `_core/string.ts`】
 * 与 `cheatcode.levenshtein`、`di.editDistance` 曾是三份相同实现，
 * 现已统一。本函数保留原名，仅做转发——**对外 API 未变**。
 *
 * @returns 0~1，**越大越像**。1 = 完全相同。
 */
export function similarity(a: string, b: string): number {
  return similarityCore(a, b);
}
function makeParsedArgs(raw: readonly string[], values: Map<string, unknown>): ParsedArgs {
  const num = (name: string, fallback?: number): number => {
    const v = values.get(name);
    if (typeof v === 'number') return v;
    if (fallback !== undefined) return fallback;
    throw new CommandError(`参数 ${name} 不是数字`);
  };
  return {
    raw,
    get: (name) => values.get(name),
    getInt: (name, fb) => Math.trunc(num(name, fb)),
    getFloat: (name, fb) => num(name, fb),
    getString: (name, fb = '') => {
      const v = values.get(name);
      if (typeof v === 'string') return v;
      if (v === undefined) return fb;
      return String(v);
    },
    getBool: (name, fb = false) => {
      const v = values.get(name);
      if (typeof v === 'boolean') return v;
      if (v === undefined) return fb;
      return Boolean(v);
    },
    getEnum: (name, fb = '') => {
      const v = values.get(name);
      if (v === undefined) return fb;
      return String(v);
    },
  };
}
