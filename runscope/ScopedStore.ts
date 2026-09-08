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

/**
 * 【⚠️ 曾经是 `Record<string, KeyDef<any>>`（P2 · Ru5）】
 *
 * `any` 会**顺着类型系统扩散**：`KeyDef<any>.initial` 是 any，
 * 于是所有读它的地方（初始化、reset、importSave 回退、_sanitize）
 * 都自动变成"不做检查"——本模块最核心的"越界抛错、坏值回退"防线，
 * 在类型层面被这一处 `any` 悄悄短路了。
 *
 * 改成 `unknown` 后，`def.initial` 是 unknown：
 * 想把它当数字用必须先用 `typeof` 收窄（这正是 `_sanitize` 在做的事），
 * 编译器会替我们检查有没有漏。
 *
 * 【为什么 `unknown` 不会破坏调用方】
 * `KeyDef<T>` 对 T 是协变的（`initial: T` 只出现在输出位置），
 * 所以 `key('run', 0)` 得到的 `KeyDef<number>` 依然可以赋给 `KeyDef<unknown>`；
 * `get<T>()` / `set<T>()` 本来就是调用方自己标泛型，不受影响。
 */
export type StoreSchema = Readonly<Record<string, KeyDef<unknown>>>;

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
    /**
     * 【⚠️ 曾经是 `const def = this._schema[key]`，与 `has()` 不一致】
     *
     * 实测：`scopeOf('toString')` 返回 **undefined**（不是 null！），
     * 因为 `this._schema['toString']` 命中 `Object.prototype.toString`。
     * 于是"先 has 再 scopeOf"的标准写法拿到一个既不是三个 Scope
     * 也不是 null 的值，下游 `switch(scope)` 直接掉进 default 分支。
     *
     * 与 `has()` 保持同一判据：只有**自有属性**才算声明过。
     */
    const def = this._defFor(key);
    if (def) return def.scope;
    return this._dynamicKeys.has(key) ? 'session' : null;
  }

  /**
   * schema 查表的唯一入口
   *
   * 【为什么必须绕一层】原型链查表（`obj[key]` / `key in obj`）会命中
   * `Object.prototype` 上的 `toString` / `valueOf` / `constructor` 等键。
   * 键名来自存档字段 / 配置表 / RPC 字段名时，这些名字完全可能出现。
   * 散落在各处的直连查表迟早会漏改一处，所以收成一个方法。
   */
  private _defFor(key: string): KeyDef | undefined {
    return hasOwn(this._schema, key) ? this._schema[key] : undefined;
  }

  get<T>(key: string): T {
    const scope = this._scopeFor(key, 'read');
    const v = this._data[scope].get(key);
    return v as T;
  }

  /**
   * 取值（不存在时用兜底，不抛错）
   *
   * 【⚠️ 曾经的 bug：它把 `get()` 的**所有**异常都吞了】
   *
   * ```ts
   * try { ... } catch { return fallback; }
   * ```
   *
   * 本单元存在的意义是"让串档 bug 立刻炸出来"（见文件头），
   * strict 模式下局外读局内数据会抛错——而 `getOr` 恰好把**这一类**
   * 最有价值的异常也一起吞了，返回 fallback。
   * 表现是"读到了 0 金币"，和"真的有 0 金币"完全无法区分。
   *
   * 后果是防串档机制可以被一个 API 静默关闭：调用方图省事全用 `getOr`，
   * 整条隔离链就失效了，而且没有任何日志或告警。
   * README 第 100 行自己也承认了这点，但只是"建议排查时换回 get"——
   * 靠人自觉守不住。
   *
   * 【现在的行为】
   * - 键不存在 / 未声明 / 没值 → 返回 `fallback`（这是 `getOr` 的本职）
   * - 越界访问（局外读 run 域）→ **默认仍返回 fallback（保持兼容）**，
   *   传 `{ swallowCrossScope: false }` 可让它与 `get()` 一致地抛错
   *
   * 【⚠️ 为什么默认没有直接改成抛】
   * 这是 breaking change：既有测试（`tests/run_batch11.ts`「getOr 不抛错」）
   * 明确断言了"局外读 run 域应返回兜底值"，README 第 75 行也把
   * `getOr` 列为"不抛错"的三个逃生舱之一。
   * 按窗口纪律（测试总数只增不减、改变对外 API 行为需总审裁决），
   * 这里保留默认行为，把严格化做成显式开关，
   * **是否翻转默认值交总审裁决**——见 `audit/result_W2-A.md`。
   *
   * 【为什么"越界"值得单独区分】
   * "取不到值"是数据问题，"越界"是程序逻辑错了。
   * 后者静默下来只会变成三小时后的另一次崩溃，
   * 所以至少要给想守住这条线的调用方一个开关。
   */
  getOr<T>(key: string, fallback: T, opts: { readonly swallowCrossScope?: boolean } = {}): T {
    try {
      const v = this.get<T>(key);
      return v === undefined ? fallback : v;
    } catch (e) {
      // 只有"越界"这一类要看开关；其余（未声明 / 无值）始终是 fallback 的适用场合
      if (opts.swallowCrossScope === false && this._wouldCrossScope(key)) throw e;
      return fallback;
    }
  }

  /**
   * 这个键的访问是否属于"越界（局外访问 run 域）"
   *
   * 【为什么不判断异常类型】
   * 抛错可能来自两个地方：`_scopeFor` 的越界检查，
   * 或 `_onUnknownKey: 'throw'` 的未声明检查。
   * 靠 message 区分很脆（文案一改就失效），直接查状态更可靠。
   */
  private _wouldCrossScope(key: string): boolean {
    const def = this._defFor(key);
    return def !== undefined && def.scope === 'run' && !this._inRun;
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
    /**
     * 【⚠️ 曾经不校验 delta】
     *
     * `add('gold', NaN)` 会把 NaN 直接写进存储，
     * 而**写入路径上没有任何检查**——NaN 从这里出发，
     * 一路传到 UI（显示 NaN）和存档（写坏存档，且读回来还是 NaN）。
     *
     * 与 `cur` 保持一致的口径：本模块是"快速失败"风格
     * （未声明的键抛错、越界抛错），delta 是 NaN 同样是调用方的 bug，
     * 静默兜成 0 只会把错误推到更远的地方。
     *
     * 【为什么用 Number.isFinite 而不是 typeof】
     * `typeof Infinity === 'number'`，但 `gold + Infinity` 同样会写坏存档。
     */
    if (!Number.isFinite(delta)) {
      throw new Error(
        `[ScopedStore] add() 的增量必须是有限数，"${key}" 收到 ${String(delta)}`
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
    /**
     * 【⚠️ 曾经是 `const def = this._schema[key]`】
     *
     * 这是本模块最隐蔽的一处原型链缺陷，因为它**不在异常里暴露根因**：
     * `this._schema['toString']` 拿到 `Object.prototype.toString`，
     * `def.scope` 为 undefined，于是 `this._data[undefined]` 是 undefined，
     * 最后报 `Cannot read properties of undefined (reading 'get')`。
     * 这条信息指向的是数据结构，而不是"键名命中了原型链"。
     *
     * 更糟的组合是 `has()` 已修好而这里没修：
     * `has('toString') === false`，`get('toString')` 却崩溃——
     * 两个 API 对同一个键给出互相矛盾的回答。
     */
    const def = this._defFor(key);

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
      const def = this._defFor(k);
      if (!def || def.scope === 'session') continue;

      const src = def.scope === 'meta' ? snap.meta : snap.run;
      if (src && hasOwn(src, k)) {
        /**
         * 【⚠️ 曾经直接 `set(k, src[k])`，与 `meta.restore` 的严谨形成对比】
         *
         * 存档是外部输入：它可能来自旧版本、被手改过、
         * 或在上一次写入时就已经带上了 NaN。
         * 老代码不做任何校验，`src[k]` 是对象、字符串、NaN 都照收，
         * 于是"读档后金币变成 NaN"这类问题一路传到 UI 才发现，
         * 而真正的入口在这里。
         *
         * 【为什么用"回退到初始值"而不是抛错】
         * 上面的容错原则写了：玩家不该因为一次版本更新就丢存档。
         * 单个字段坏掉时，丢这一个字段（回到初始值）
         * 比整个存档作废要好得多。所以这里警告 + 回退。
         */
        const raw = src[k];
        this._data[def.scope].set(k, this._sanitize(k, def, raw));
      } else if (def.scope === 'meta' || snap.inRun) {
        // meta 永远要恢复（缺失则用初始值）；run 只在存档处于局内时恢复
        if (!(def.scope === 'run' && !snap.inRun)) {
          this._data[def.scope].set(k, def.initial);
        }
      }
    }

    this._inRun = snap.inRun === true;
  }

  /**
   * 存档值校验：与声明的初始类型不符、或数值是 NaN/Infinity 时回退到初始值
   *
   * 【为什么只校数值】
   * 想做完整校验就得给 schema 加类型标签（本模块没有），
   * 而存档里最常见的坏值恰恰是数值类：
   * `NaN` / `Infinity` / 被写成字符串的数字（`"12"` 来自 JSON 手改）。
   * 这三样占了实际问题的绝大多数，先堵住它们。
   */
  private _sanitize<T>(key: string, def: KeyDef<T>, raw: unknown): unknown {
    if (typeof def.initial === 'number') {
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      console.warn(
        `[ScopedStore] 存档字段 "${key}" 的值不合法（${String(raw)}），已回退到初始值 ${String(def.initial)}`
      );
      return def.initial;
    }
    // 非数值：只挡"类型族"明显不同（对象 ↔ 基本类型），避免把 [] 和 {} 的差异也报出来
    if (raw !== null && typeof raw === 'object' && typeof def.initial !== 'object') {
      console.warn(`[ScopedStore] 存档字段 "${key}" 是对象，与声明的类型不符，已回退到初始值`);
      return def.initial;
    }
    return raw;
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

  /**
   * 释放资源（【铁律 5】可卸载）
   *
   * 【为什么 `reset()` 不够】
   * `reset()` 会把所有键重新填回初始值——它是"回到初始状态"，
   * 不是"结束使用"。本实例仍然持有 schema 与 onChange 回调
   * （回调通常捕获了 UI / 存档服务对象），
   * 挂在长生命周期的容器里就会阻止那些对象被回收。
   * 所以需要一个语义明确的 destroy：清空数据、清掉动态键、退出局内。
   */
  destroy(): void {
    for (const s of SCOPES) this._data[s].clear();
    this._dynamicKeys.clear();
    this._inRun = false;
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
