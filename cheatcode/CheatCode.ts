/**
 * cheatcode/CheatCode.ts —— 作弊码 / 命令系统
 *
 * 【它解决什么】
 *
 * 开发期你一定需要这些：
 * - 直接跳到第 10 层
 * - 给自己加 9999 金币
 * - 无敌
 * - 解锁全部内容
 *
 * 手写的话，通常是散落在各处的 `if (DEBUG && key === 'F1')`，
 * 然后**忘了删就上线了**。
 *
 * 本模块把作弊集中成一张命令表：
 *
 * ```typescript
 * const cc = new CheatCode({ enabled: !IS_PRODUCTION });
 * cc.register({
 *   name: 'setgold',
 *   desc: '设置金币',
 *   args: [{ name: 'amount', type: 'int' }],
 *   run: ({ args }) => { player.gold = args[0]; return `gold=${args[0]}`; },
 * });
 * cc.execute('setgold 999');
 * ```
 *
 * 【和 DebugConsole 的分工】
 *
 * | | CheatCode | DebugConsole |
 * |---|---|---|
 * | 定位 | 游戏内作弊 | 开发期调试面板 |
 * | 参数 | 带类型校验 | 同样有 |
 * | 历史 | 有（上下翻） | 有 |
 * | 典型命令 | god / setgold / jumpfloor | reload / spawn / profile |
 *
 * 两者可以并存：DebugConsole 把未知命令转发给 CheatCode。
 *
 * 【四个必须处理的真实问题】
 *
 * 1. **参数类型校验**：`setgold abc` 不能把 gold 设成 NaN
 * 2. **发布开关**：一行关掉全部，且关掉后**零副作用**
 * 3. **拼写建议**：`godd` 应该提示"你是不是想找 god"
 * 4. **隐藏命令**：内部调试命令不该出现在 help 里
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

import { editDistance as editDistanceCore, tokenize as coreTokenize } from '../_core/string';
export type ArgType = 'int' | 'number' | 'string' | 'bool';

export interface ArgDef {
  readonly name: string;
  readonly type?: ArgType;
  /** 是否可选（后面不能跟必填参数） */
  readonly optional?: boolean;
  readonly default?: unknown;
  readonly desc?: string;
}

export interface CommandContext {
  /** 已解析并转换类型的参数 */
  readonly args: readonly unknown[];
  /** 原始输入 */
  readonly raw: string;
}

export interface CommandDef {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly desc?: string;
  readonly args?: readonly ArgDef[];
  /** 是否在 help 中隐藏（仍可执行） */
  readonly hidden?: boolean;
  readonly run: (ctx: CommandContext) => string | void;
}

export interface ExecuteResult {
  /** 是否识别并（尝试）执行了命令 */
  readonly handled: boolean;
  readonly output?: string;
  readonly error?: string;
}

export interface CheatCodeOptions {
  /** 命令前缀（如 `'/'`）。为空则直接识别 */
  readonly prefix?: string;
  /** 总开关。上线前务必关掉 */
  readonly enabled?: boolean;
  readonly onUnknown?: (raw: string) => void;
  readonly onRun?: (name: string, raw: string, ok: boolean) => void;
  /** 历史上限 */
  readonly historyLimit?: number;
}

// ==================== 工具函数 ====================

/**
 * 分词（支持引号）
 *
 * ```
 * tokenize('a "b c" d') → ['a', 'b c', 'd']
 * ```
 *
 * 【为什么不能简单 split(' ')】
 * 带空格的参数（玩家名、物品名）会被引号包起来，
 * 简单 split 会把它切成两半。
 */
/**
 * 把命令行拆成 token（支持引号包裹的含空格参数）
 *
 * 【⚠️ 两处历史 bug，对照 debug-console 的同名函数修复】
 *
 * 这两个模块各有一份 tokenize，是复制后各自演化的。
 * debug-console 那份修好了下面两个问题，本份早期没修：
 *
 * ① **空参数被吞掉**（最危险）
 *    `set "" 1` 早期切出 `["set", "1"]`——空串参数被丢掉，
 *    **后面所有参数位置整体左移一位**。
 *    GM 指令按位置取参的话，会执行到完全错误的操作，而且**不报错**。
 *    正确结果：`["set", "", "1"]`
 *
 * ② **引号未闭合被静默接受**
 *    `give "大剑 5` 早期返回 `["give", "大剑 5"]`，
 *    玩家少打一个引号，命令照样执行，只是参数不对。
 *    现在抛 Error，明确告诉调用方"你这行写错了"。
 *
 * 【为什么不直接 import debug-console 的】
 * 分层不允许：cheatcode 是 L1，debug-console 是 L3，L1 不能依赖 L3。
 * 所以两边各自维护，靠注释保持同步。
 */
export function tokenize(input: string): string[] {
  return coreTokenize(input, {
    onUnclosedQuote: (s) => new Error(`[CheatCode] 引号未闭合：${s}`),
  });
}

/**
 * 编辑距离
 *
 * 【用途】拼写错误时给出建议。
 * `godd` → 距离 `god` 为 1 → 建议 god。
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
 * 编辑距离（Levenshtein）
 *
 * 【实现已下沉到 `_core/string.ts`】
 * 库里曾经有三份相同的实现（`cheatcode` / `debug-console` / `di`），
 * 修 bug 只能修到一半。现在统一由 `_core/string.ts` 提供，
 * 本函数保留原名，仅做转发——**对外 API 未变**。
 *
 * @returns 距离，整数，**越小越像**。0 = 完全相同。
 */
export function levenshtein(a: string, b: string): number {
  return editDistanceCore(a, b);
}
// ==================== 实现 ====================

/**
 * 「隐式开启」的实例计数
 *
 * 【为什么是计数而不是实例集合】
 * 持有实例引用会让它们**永远无法被 GC**——这类模块通常是全局单例，
 * 一旦进了 Set 就常驻内存。计数不持有引用，没有这个问题。
 *
 * 【已知局限（保守方向）】
 * 实例被销毁时计数不会自动减少（没有 destroy 钩子），
 * 所以计数可能**偏大**。偏差方向是安全的：宁可误报（多提醒一次），
 * 也不会漏报（本该提醒却静默）。
 * 需要清零时用 `resetAudit()`（测试与热重载场景）。
 */
let _implicitlyEnabled = 0;

/**
 * 返回「未显式设置 enabled 而默认开启」的实例数量
 *
 * 【用途】上线自检 / CI 断言
 * ```js
 * // 启动自检
 * if (auditImplicitlyEnabled() > 0) {
 *   throw new Error('存在未显式设置 enabled 的 CheatCode 实例');
 * }
 * ```
 */
export function auditImplicitlyEnabled(): number {
  return _implicitlyEnabled;
}

/** 清零审计计数（单测与热重载用） */
export function resetAudit(): void {
  _implicitlyEnabled = 0;
}

export class CheatCode {
  private readonly _byName = new Map<string, CommandDef>();
  private readonly _order: string[] = [];
  private readonly _prefix: string;
  private readonly _historyLimit: number;
  private readonly _onUnknown?: (raw: string) => void;
  private readonly _onRun?: (name: string, raw: string, ok: boolean) => void;

  private _enabled: boolean;
  /**
   * 用户是否显式传入过 enabled
   *
   * 【为什么需要单独记】
   * `get enabled()` 返回的是"当前状态"，无法反推"用户传没传"。
   * 而 warn 只该在"可能忘了传"时触发——
   * 显式传 `true` 的人不该被打扰。
   */
  private _enabledExplicit = false;
  private _history: string[] = [];
  private _histIdx = -1;
  /** 是否处于历史导航中（区分"未开始"与"草稿态"） */
  private _navStarted = false;

  constructor(opts: CheatCodeOptions = {}) {
    this._prefix = opts.prefix ?? '';
    this._enabled = opts.enabled ?? true;
    if (opts.enabled !== undefined) this._enabledExplicit = true;
    this._historyLimit = opts.historyLimit ?? 50;
    this._onUnknown = opts.onUnknown;
    this._onRun = opts.onRun;

    /**
     * 【上线安全兜底】默认 enabled = true
     *
     * 【为什么不直接把默认改成 false】
     * 那是破坏性变更——所有现有用户的作弊码会静默失效，
     * 而且失效时没有任何提示，排查成本极高。
     *
     * 【那怎么防止"忘了关就上线"】
     * 只在「没显式传 enabled 且最终为 true」时警告一次。
     * 显式传 `true` 的人说明想清楚了，不打扰；
     * 完全没传的人（最可能忘）在开发期就能看到。
     *
     * 【外部安全审查 S2-1 指出】
     * 这个模块默认开启，且没有任何上线提醒。
     */
    if (opts.enabled === undefined && this._enabled) {
      /**
       * 【⚠️ console.warn 抓不到：补一个可断言的计数】
       *
       * 光靠 `console.warn` 有两个问题：
       * 1. 开发者可能根本不看控制台
       * 2. **CI 无法拦截它**——warn 不是失败
       *
       * 所以同时累加到模块级计数，暴露 `auditImplicitlyEnabled()`。
       * 项目可以在启动自检或 CI 里断言它为 0：
       * ```js
       * if (auditImplicitlyEnabled() > 0) throw new Error('有作弊码实例未显式设置 enabled');
       * ```
       */
      _implicitlyEnabled++;
      console.warn(
        '[CheatCode] 未显式传入 enabled，默认开启。' +
        '正式版请传 `enabled: !IS_PRODUCTION`，' +
        '否则作弊码会带到线上。' +
        `可用 auditImplicitlyEnabled() 在 CI 中断言（当前 ${_implicitlyEnabled} 处）。`
      );
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    // 从"隐式开启"转为"显式设置"时，撤销计数——它不再是需要提醒的对象
    if (!this._enabledExplicit && this._enabled && _implicitlyEnabled > 0) {
      _implicitlyEnabled--;
    }
    this._enabled = v;
    this._enabledExplicit = true;
  }

  /** 用户是否显式设置过 enabled（测试与自检用） */
  get enabledWasExplicit(): boolean {
    return this._enabledExplicit;
  }

  // ==================== 注册 ====================

  register(def: CommandDef): void {
    const name = def.name.toLowerCase();

    if (name.includes(' ') || name.includes('\t')) {
      throw new Error(`[CheatCode] 命令名不能含空格："${def.name}"`);
    }
    if (this._byName.has(name)) {
      throw new Error(`[CheatCode] 命令重复：${name}`);
    }
    for (const a of def.aliases ?? []) {
      const k = a.toLowerCase();
      if (this._byName.has(k)) {
        throw new Error(
          `[CheatCode] 别名 "${a}" 与已有命令冲突（${this._byName.get(k)!.name}）`
        );
      }
    }

    this._byName.set(name, def);
    this._order.push(name);
    for (const a of def.aliases ?? []) {
      this._byName.set(a.toLowerCase(), def);
    }
  }

  registerAll(defs: readonly CommandDef[]): void {
    for (const d of defs) this.register(d);
  }

  unregister(name: string): boolean {
    const def = this._byName.get(name.toLowerCase());
    if (!def) return false;

    this._byName.delete(def.name.toLowerCase());
    for (const a of def.aliases ?? []) this._byName.delete(a.toLowerCase());

    const i = this._order.indexOf(def.name.toLowerCase());
    if (i >= 0) this._order.splice(i, 1);
    return true;
  }

  has(name: string): boolean {
    return this._byName.has(name.toLowerCase());
  }

  /** 全部命令（别名不重复列出） */
  get commands(): CommandDef[] {
    return this._order.map((n) => this._byName.get(n)!).filter(Boolean);
  }

  /** 补全候选 */
  complete(prefix: string): string[] {
    const p = prefix.toLowerCase();
    return this._order.filter((n) => n.startsWith(p));
  }

  /** 帮助文本 */
  help(showHidden = false): string {
    const lines: string[] = [];
    for (const n of this._order) {
      const d = this._byName.get(n)!;
      if (d.hidden && !showHidden) continue;
      const args = (d.args ?? [])
        .map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`))
        .join(' ');
      const alias = d.aliases?.length ? ` (${d.aliases.join(', ')})` : '';
      lines.push(`${d.name}${alias} ${args}`.trimEnd() + (d.desc ? `  - ${d.desc}` : ''));
    }
    return lines.join('\n');
  }

  // ==================== 执行 ====================

  execute(raw: string): ExecuteResult {
    if (!this._enabled) {
      return { handled: false };
    }

    let text = raw.trim();

    // ① 前缀
    if (this._prefix !== '') {
      if (!text.startsWith(this._prefix)) {
        return { handled: false };
      }
      text = text.slice(this._prefix.length).trim();
    }

    if (text === '') return { handled: false };

    const parts = tokenize(text);
    const name = parts[0].toLowerCase();
    const def = this._byName.get(name);

    // ② 未知命令
    if (!def) {
      this._onUnknown?.(raw);
      return { handled: false, error: `未知命令：${name}。${this._suggest(name)}` };
    }

    // ③ 历史（执行过的才记录，无论成败）
    this._pushHistory(raw);

    // ④ 参数解析与校验
    const given = parts.slice(1);
    const parsed = this._parseArgs(def, given);
    if (parsed.error) {
      this._onRun?.(def.name, raw, false);
      return { handled: false, error: parsed.error };
    }

    // ⑤ 执行
    try {
      const out = def.run({ args: parsed.values, raw });
      this._onRun?.(def.name, raw, true);
      //
      // 【为什么用 typeof 而不是 `out ?? ''`】
      // run 的返回类型是 `string | void`。`??` 只能排除 null/undefined，
      // **对 void 无效**——在部分 TS 版本（含 Cocos 内置的较旧版本）下
      // `out ?? ''` 的结果仍是 `string | void`，赋给 output: string 会报错。
      // 库自带的 TS 5.9.3 能容忍，但写法本身依赖编译器实现细节。
      // typeof 判断在任何版本下都能正确收窄，且语义更直白。
      return { handled: true, output: typeof out === 'string' ? out : '' };
    } catch (e) {
      this._onRun?.(def.name, raw, false);
      return { handled: true, error: `执行失败：${(e as Error).message}` };
    }
  }

  // ==================== 历史 ====================

  get history(): readonly string[] {
    return this._history;
  }

  /**
   * 上翻（第一次给最新一条），到头返回 null
   *
   * 【⚠️ 到底之后进入"草稿态"】
   * 标准 shell 的行为是：翻到最旧一条后再按上键，
   * 回到空白输入（玩家正在敲的新命令）。
   * 此时再按下键，应该回到最旧的那条。
   *
   * 不处理这个的话，到底后再按上键无反应（_histIdx 卡在 0），
   * 下键却从 0 跳到 1，玩家会觉得"丢了一条"。
   */
  prevHistory(): string | null {
    if (this._history.length === 0) return null;

    if (this._histIdx === -1) {
      // 区分"还没开始翻"和"已翻到草稿态"
      if (!this._navStarted) {
        this._navStarted = true;
        this._histIdx = this._history.length - 1;
        return this._history[this._histIdx];
      }
      return null;   // 已在草稿态（比最新还新），再上翻无反应
    }

    if (this._histIdx > 0) {
      this._histIdx--;
      return this._history[this._histIdx];
    }

    // idx === 0：到头，进入草稿态
    this._histIdx = -1;
    return null;
  }

  /** 下翻，到底（回到草稿）返回 null */
  nextHistory(): string | null {
    if (this._histIdx === -1) {
      // 从草稿态往下 → 回到最旧的一条
      if (this._navStarted) {
        this._histIdx = 0;
        return this._history[0];
      }
      return null;
    }
    if (this._histIdx >= this._history.length - 1) {
      // 已在最新，再往下 → 回到草稿态
      this._histIdx = -1;
      this._navStarted = false;
      return null;
    }
    this._histIdx++;
    return this._history[this._histIdx];
  }

  clearHistory(): void {
    this._history = [];
    this._histIdx = -1;
    this._navStarted = false;
  }

  // ==================== 内部 ====================

  private _pushHistory(raw: string): void {
    /**
     * 【为什么去重】
     * 按上方向键翻历史时，如果连续重复刷屏，
     * 玩家要按十几次才能翻到上一条不同的命令。
     */
    if (this._history[this._history.length - 1] === raw) return;
    this._history.push(raw);
    if (this._history.length > this._historyLimit) {
      this._history.shift();
    }
    this._histIdx = -1;
    this._navStarted = false;
  }

  private _parseArgs(
    def: CommandDef,
    given: readonly string[]
  ): { values: unknown[]; error?: string } {
    const defs = def.args ?? [];
    const values: unknown[] = [];

    for (let i = 0; i < defs.length; i++) {
      const a = defs[i];
      const raw = given[i];

      if (raw === undefined) {
        if (a.optional) {
          values.push(a.default);
          continue;
        }
        return { values, error: `缺少参数：<${a.name}>` };
      }

      const v = convertArg(raw, a.type ?? 'string');
      if (v === undefined) {
        return {
          values,
          error: `参数 <${a.name}> 需要一个 ${a.type ?? 'string'} 值，收到 "${raw}"`,
        };
      }
      values.push(v);
    }

    return { values };
  }

  private _suggest(name: string): string {
    let best: string | null = null;
    let bestDist = Infinity;

    for (const n of this._order) {
      const d = levenshtein(name, n);
      // 超过长度一半就不像了
      if (d < bestDist && d <= Math.max(2, Math.floor(n.length / 2))) {
        bestDist = d;
        best = n;
      }
    }

    return best ? `你是不是想找 "${best}"？` : '';
  }
}

/**
 * 参数类型转换
 *
 * @returns 转换后的值；类型不符返回 `undefined`
 */
function convertArg(raw: string, type: ArgType): unknown {
  switch (type) {
    case 'int': {
      /**
       * 【为什么用正则而不是 parseInt】
       * `parseInt('12abc')` 返回 12 —— 静默接受脏输入。
       * `parseInt('12.9')` 也返回 12。
       * 作弊命令的参数错了应该明确报错，而不是猜。
       */
      if (!/^-?\d+$/.test(raw)) return undefined;
      return parseInt(raw, 10);
    }
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) return undefined;
      return parseFloat(raw);
    }
    case 'bool': {
      const k = raw.toLowerCase();
      if (k === 'true' || k === '1' || k === 'on' || k === 'yes') return true;
      if (k === 'false' || k === '0' || k === 'off' || k === 'no') return false;
      return undefined;
    }
    case 'string':
    default:
      return raw;
  }
}
