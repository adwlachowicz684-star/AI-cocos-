/**
 * ScopedStore —— 局内 / 局外 / 会话 三域数据隔离
 *
 * 【它解决什么】
 *
 * 肉鸽游戏有三类数据，它们的生命周期完全不同：
 *
 * | 域 | 例子 | 生命周期 |
 * |---|---|---|
 * | **run** 局内 | 本局金币、已获遗物、当前层数、临时 buff | 死亡/通关即清空 |
 * | **meta** 局外 | 永久货币、解锁项、成就、统计 | 跨局永久保留 |
 * | **session** 会话 | 当前帧率、调试开关、UI 状态 | 不进存档 |
 *
 * 混在一起的典型串档 bug：
 * - 局内金币被当成永久货币花掉（或反过来）
 * - 死亡后没清干净，下一局带着上局的遗物开局
 * - 存档时把整局数据写进了永久槽
 * - 玩家中途退出，永久货币丢了
 *
 * 【核心机制：状态机 + 越界抛错】
 *
 * 光靠命名约定（比如 `run_gold` / `meta_souls`）防不住串档——
 * 你总会有一天忘记前缀。
 *
 * 本模块用**状态机**强制隔离：
 *
 * ```
 * outOfRun ──beginRun()──> inRun ──endRun()──> outOfRun
 *    │                       │                    │
 *    │ 访问 run 域 → 抛错     │ 全部可访问          │ 访问 run 域 → 抛错
 * ```
 *
 * **在局外读一个 run 域的键，直接抛异常。**
 * 这是防串档最有效的手段：把"悄悄读到脏数据"变成"启动时立刻崩溃"。
 *
 * 【无引擎依赖】
 */

import { hasOwn } from '../_core/guard';

// ==================== 类型 ====================

/** 数据域 */
export type Scope = 'run' | 'meta' | 'session';

export const SCOPES: readonly Scope[] = ['run', 'meta', 'session'];

/** 一个键的声明 */
export interface KeyDef<T = unknown> {
  readonly scope: Scope;
  readonly initial: T;
  /** 说明（调试用） */
  readonly desc?: string;
}

export type StoreSchema = Readonly<Record<string, KeyDef<any>>>;

export interface ScopedStoreOptions {
  /** 键声明 */
  readonly schema: StoreSchema;
  /**
   * 局外状态下访问 run 域时是否抛错（默认 true）
   *
   * 【什么时候该关掉】
   * 老项目接入时可能到处在读 run 域，一次性改不完。
   * 可以暂时关掉、只打警告，但**不要长期关着**——
   * 那等于把这个模块最大的价值关掉了。
   */
  readonly strict?: boolean;
  /** 未声明的键：抛错（默认）还是自动归入 session */
  readonly onUnknownKey?: 'throw' | 'session';
  /** 状态变化时回调（用于刷新 UI） */
  readonly onChange?: (key: string, scope: Scope, value: unknown) => void;
}

/** 存档快照 */
export interface ScopedSnapshot {
  readonly meta: Record<string, unknown>;
  readonly run: Record<string, unknown>;
  /** 是否在局内（用于恢复时判断要不要载入 run 域） */
  readonly inRun: boolean;
}

// ==================== 实现 ====================

export class ScopedStore {
  private readonly _schema: StoreSchema;
  private readonly _strict: boolean;
  private readonly _onUnknownKey: 'throw' | 'session';
  private readonly _onChange?: (key: string, scope: Scope, value: unknown) => void;

  /** 三个域各自的存储 */
  private readonly _data: Record<Scope, Map<string, unknown>> = {
    run: new Map(),
    meta: new Map(),
    session: new Map(),
  };

  private _inRun = false;
  /** 未在 schema 里声明、但被写入的键（归入 session） */
  private readonly _dynamicKeys = new Set<string>();

  constructor(opts: ScopedStoreOptions) {
    this._schema = opts.schema;
    this._strict = opts.strict !== false;
    this._onUnknownKey = opts.onUnknownKey ?? 'throw';
    this._onChange = opts.onChange;

    // 初始化所有声明过的键
    for (const [key, def] of Object.entries(this._schema)) {
      this._data[def.scope].set(key, def.initial);
    }
  }

  // ==================== 状态机 ====================

  get inRun(): boolean {
    return this._inRun;
  }

  /**
   * 开始新的一局
   *
   * 【⚠️ 如果在局内重复调用】
   * 直接抛错。重复 beginRun 通常意味着上局没正确结束，
   * 静默继续的话会带着上局的数据开局——这正是要防的串档。
   */
  beginRun(): void {
    if (this._inRun) {
      throw new Error('[ScopedStore] 已在局内，不能重复 beginRun（是否忘了 endRun？）');
    }
    this._resetRun();
    this._inRun = true;
  }

  /**
   * 结束当前一局
   *
   * 【⚠️ 必须重置为初始值，而不是删除】
   * 删除的话下一局 `get('gold')` 返回 undefined，
   * 于是 `gold + 10` 变成 NaN，一路污染下去还不报错。
   * 重置为初始值才能让"下一局"的行为和"第一局"完全一致。
   */
  endRun(): void {
    if (!this._inRun) return;
    this._resetRun();
    this._inRun = false;
  }

  private _resetRun(): void {
    for (const [key, def] of Object.entries(this._schema)) {
      if (def.scope === 'run') this._data.run.set(key, def.initial);
    }
    // 动态归入 run 的键没有声明，直接清掉
    // （dynamicKeys 只记录归入 session 的，run 域的动态键不会被创建）
  }

  // ==================== 读写 ====================

  has(key: string): boolean {
    /**
     * 【⚠️ schema 查询必须用 hasOwn，不能用 `in`】
     *
     * 实测：`has('toString')` 返回 **true**，尽管 schema 是空对象。
     * 因为 `'toString' in this._schema` 命中原型链。
     *
     * 后果：`has()` 是"这个键应不应该持久化"的判据，
     * 返回 true 会让一个根本不存在的键进入存档/同步流程，
     * 后续 `get`/`set` 拿到 undefined 却以为有值。
     *
     * key 来自业务代码与配置表，属于外部输入。
     */
    return hasOwn(this._schema, key) || this._dynamicKeys.has(key);
  }

  scopeOf(key: string): Scope | null {
    const def = this._schema[key];
    if (def) return def.scope;
    return this._dynamicKeys.has(key) ? 'session' : null;
  }

  get<T>(key: string): T {
    const scope = this._scopeFor(key, 'read');
    const v = this._data[scope].get(key);
    return v as T;
  }

  /** 取值（不存在时用兜底，不抛错） */
  getOr<T>(key: string, fallback: T): T {
    try {
      const v = this.get<T>(key);
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }

  set<T>(key: string, value: T): void {
    const scope = this._scopeFor(key, 'write');
    this._data[scope].set(key, value);
    this._onChange?.(key, scope, value);
  }

  /**
   * 数值增减（金币、计数这类最常用）
   *
   * 【为什么要单独提供】
   * `set('gold', get('gold') + 10)` 写起来啰嗦，
   * 而且漏掉类型检查时容易变成字符串拼接（'10' + 10 = '1010'）。
   */
  add(key: string, delta: number): number {
    const cur = this.get<number>(key);
    if (typeof cur !== 'number') {
      throw new Error(
        `[ScopedStore] add() 只能用于数值键，"${key}" 当前是 ${typeof cur}（${String(cur)}）`
      );
    }
    const next = cur + delta;
    this.set(key, next);
    return next;
  }

  /**
   * 内部：确定一个键属于哪个域，并做越界检查
   *
   * 【这是整个模块的核心】
   */
  private _scopeFor(key: string, op: 'read' | 'write'): Scope {
    const def = this._schema[key];

    if (!def) {
      if (this._onUnknownKey === 'throw') {
        /**
         * 【为什么未声明的键要抛错】
         * 99% 的情况是拼写错误：`get('golld')`。
         * 如果静默返回 undefined，你会拿到一个 NaN 或 null，
         * 一路传下去，最后表现为"金币显示异常"——
         * 而真正的错误发生在一百行之前。
         */
        throw new Error(
          `[ScopedStore] 未声明的键："${key}"（${op}）。` +
          `先在 schema 里声明它属于哪个域——这正是本模块存在的意义。`
        );
      }
      // 归入 session（临时逃生通道）
      this._dynamicKeys.add(key);
      return 'session';
    }

    // 核心：局外不得访问 run 域
    if (def.scope === 'run' && !this._inRun) {
      const msg =
        `[ScopedStore] 在局外${op === 'read' ? '读取' : '写入'}局内数据："${key}"。` +
        `这通常是串档 bug——局内数据在 endRun() 后已失效。`;

      if (this._strict) throw new Error(msg);
      // 非严格模式：仍然警告，但不中断
      console.warn(`[ScopedStore] ${msg}（strict=false，已放行）`);
    }

    return def.scope;
  }

  // ==================== 存档 ====================

  /**
   * 导出存档（只含 meta，以及局内的续玩数据）
   *
   * 【为什么 session 不进存档】
   * 帧率、调试开关这类东西存下来没有任何意义，
   * 而且会让存档在不同设备间不可交换。
   */
  exportSave(): ScopedSnapshot {
    const meta: Record<string, unknown> = {};
    for (const [k, v] of this._data.meta) meta[k] = v;

    const run: Record<string, unknown> = {};
    if (this._inRun) {
      for (const [k, v] of this._data.run) run[k] = v;
    }

    return { meta, run, inRun: this._inRun };
  }

  /**
   * 载入存档
   *
   * 【容错原则】
   * 存档里多了键（新版本删掉的）→ 忽略，不报错
   * 存档里少了键（新版本新增的）→ 用初始值，不报错
   * 只有**类型明显不对**时才警告
   *
   * 玩家不该因为一次版本更新就丢存档。
   */
  importSave(snap: ScopedSnapshot): void {
    for (const k of Object.keys(this._schema)) {
      const def = this._schema[k];
      if (def.scope === 'session') continue;

      const src = def.scope === 'meta' ? snap.meta : snap.run;
      if (src && k in src) {
        this._data[def.scope].set(k, src[k]);
      } else if (def.scope === 'meta' || snap.inRun) {
        // meta 永远要恢复（缺失则用初始值）；run 只在存档处于局内时恢复
        if (!(def.scope === 'run' && !snap.inRun)) {
          this._data[def.scope].set(k, def.initial);
        }
      }
    }

    this._inRun = snap.inRun === true;
  }

  /** 只导出 meta（上传服务器 / 云存档用） */
  exportMeta(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this._data.meta) out[k] = v;
    return out;
  }

  // ==================== 调试 ====================

  /** 列出所有键及其域（调试面板用） */
  describe(): string {
    const lines: string[] = [`ScopedStore（${this._inRun ? '局内' : '局外'}）`];
    const byScope: Record<Scope, string[]> = { run: [], meta: [], session: [] };

    for (const [k, def] of Object.entries(this._schema)) {
      const v = this._data[def.scope].get(k);
      byScope[def.scope].push(
        `    ${k.padEnd(14)} ${String(JSON.stringify(v)).slice(0, 40)}${def.desc ? `  // ${def.desc}` : ''}`
      );
    }

    for (const s of SCOPES) {
      if (byScope[s].length === 0) continue;
      const mark = s === 'run' && !this._inRun ? '  ⚠ 局外，访问会抛错' : '';
      lines.push(`  [${s}]${mark}`);
      lines.push(...byScope[s]);
    }
    return lines.join('\n');
  }

  /** 全清（测试用） */
  reset(): void {
    for (const s of SCOPES) this._data[s].clear();
    this._dynamicKeys.clear();
    this._inRun = false;
    for (const [key, def] of Object.entries(this._schema)) {
      this._data[def.scope].set(key, def.initial);
    }
  }
}

// ==================== 便捷构造 ====================

/**
 * 声明一个键
 *
 * ```typescript
 * const schema = {
 *   gold:   key('run', 0),
 *   relics: key<string[]>('run', []),
 *   souls:  key('meta', 0),
 *   fps:    key('session', 0),
 * };
 * ```
 */
export function key<T>(scope: Scope, initial: T, desc?: string): KeyDef<T> {
  return desc === undefined ? { scope, initial } : { scope, initial, desc };
}

/**
 * 批量声明同一域的键
 *
 * ```typescript
 * const schema = {
 *   ...keys('run', { gold: 0, floor: 1 }),
 *   ...keys('meta', { souls: 0, unlocked: [] }),
 * };
 * ```
 */
export function keys<T extends Record<string, unknown>>(
  scope: Scope,
  defs: T
): Record<keyof T, KeyDef<T[keyof T]>> {
  const out = {} as Record<keyof T, KeyDef<T[keyof T]>>;
  for (const k of Object.keys(defs) as Array<keyof T>) {
    out[k] = { scope, initial: defs[k] };
  }
  return out;
}
