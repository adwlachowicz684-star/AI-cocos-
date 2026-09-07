/**
 * ConfigLoader —— 配置表加载、索引、热重载
 *
 * 【为什么要用它而不是直接 JSON.parse】
 *
 * 直接 parse 的问题：
 * ① 每次取值都是 `table.find(r => r.id === id)` —— O(n)，高频路径掉帧
 * ② 拼错 id 返回 undefined，然后在很远处以奇怪的方式崩溃
 * ③ 没有校验，配置错误要到运行时才发现
 * ④ 改配置要重启游戏，调数值的反馈循环极慢
 *
 * ConfigLoader 解决这四点：id 索引 O(1)、缺失即报错、启动时全量校验、热重载。
 *
 * 【设计：数据源由外部注入】
 * 本文件**不 import 任何引擎模块**。加载逻辑抽象成 `ITableSource`，
 * 由调用方注入 Cocos 的 resources.load 实现。
 *
 * 好处：可脱离引擎单测；换资源方案不用改这里。
 *
 * 【使用示例】
 * ```typescript
 * const loader = new ConfigLoader(new CocosTableSource(), {
 *   tables: { enemies: enemySchema, loot: lootSchema }
 * });
 *
 * await loader.loadAll();
 *
 * const enemy = loader.get('enemies', 'slime');      // 找不到会抛错
 * const all   = loader.all('enemies');               // 只读数组
 * const maybe = loader.find('enemies', 'boss');      // 找不到返回 undefined
 *
 * // 热重载：改了配置立刻生效，不用重启
 * loader.onReload((table) => ui.refresh(table));
 * await loader.reload('enemies');
 * ```
 */

import { Validator, TableSchema, ValidationIssue } from './Validator';
import { hasOwn } from '../_core/guard';

/**
 * 表数据源
 *
 * 【为什么要抽象】
 * Cocos 用 `resources.load`、Web 用 `fetch`、测试用内存对象。
 * 把这一层隔离出去，ConfigLoader 才是纯逻辑、可测、可复用。
 */
export interface ITableSource {
  /** 返回该表的原始行数据 */
  load(tableName: string): Promise<readonly unknown[]> | readonly unknown[];
}

/** 内存数据源（测试与热重载用） */
export class MemoryTableSource implements ITableSource {
  private readonly _data: Record<string, readonly unknown[]>;

  constructor(data: Record<string, readonly unknown[]> = {}) {
    this._data = data;
  }

  set(tableName: string, rows: readonly unknown[]): void {
    this._data[tableName] = rows;
  }

  load(tableName: string): readonly unknown[] {
    /**
     * 【⚠️ 必须只认自有属性】
     *
     * 实测：`load('toString')` 不抛"表不存在"，
     * 而是返回 `Object.prototype.toString` 这个**函数**。
     * 因为 `this._data['toString']` 取到原型方法（truthy），
     * `if (!rows)` 的真假判断挡不住它。
     *
     * 后果：下游把函数当成"行数组"去遍历、校验、建索引，
     * 得到一堆莫名其妙的校验错误，而真正的病根（表名错了）被掩盖。
     */
    if (!hasOwn(this._data, tableName)) {
      throw new Error(`[MemoryTableSource] 表不存在: ${tableName}`);
    }
    return this._data[tableName];
  }
}

export interface ConfigLoaderOptions {
  /** 表名 → schema */
  readonly tables: Readonly<Record<string, TableSchema>>;
  /**
   * 加载失败时是否抛出
   * false = 记录到 issues 里继续（便于一次看到所有表的问题）
   */
  readonly throwOnError?: boolean;
}

/** 一张已加载的表 */
interface LoadedTable {
  readonly name: string;
  readonly rows: readonly unknown[];
  /** id → row 的索引 */
  readonly index: Map<string, unknown>;
}

export class ConfigLoader {
  private readonly _source: ITableSource;
  private readonly _schemas: Readonly<Record<string, TableSchema>>;
  private readonly _throwOnError: boolean;

  private readonly _tables = new Map<string, LoadedTable>();
  private _issues: ValidationIssue[] = [];

  /** 热重载订阅者 */
  private _reloadHandlers: Array<(tableName: string) => void> = [];

  constructor(source: ITableSource, opts: ConfigLoaderOptions) {
    this._source = source;
    this._schemas = opts.tables;
    this._throwOnError = opts.throwOnError ?? true;
  }

  // ==================== 加载 ====================

  /** 加载所有在 schemas 中声明的表 */
  async loadAll(): Promise<ValidationIssue[]> {
    const names = Object.keys(this._schemas);
    for (const name of names) {
      await this._loadTable(name);
    }
    // 所有表加载完，才能做跨表引用检查
    this._checkReferences();
    return this._issues;
  }

  /** 加载单张表 */
  async load(tableName: string): Promise<void> {
    await this._loadTable(tableName);
  }

  private async _loadTable(name: string): Promise<void> {
    /**
     * 【⚠️ 曾经的 bug：`_issues` 只增不减】
     *
     * `reload()` 里有 `filter((i) => i.table !== tableName)`，
     * 但 `load()` / `loadAll()` 没有——于是同一张表重复 load，
     * 旧的问题永远留在数组里：
     *
     *   同一张表 load 三次 → issues 从 1 累积到 3
     *
     * 长期热重载（改一次配置重载一次）会让这个数组缓慢增长，
     * 表现为"配置面板里的错误越来越多，但配置其实早改对了"。
     *
     * 修法：进入本方法就先丢掉**这张表**的旧问题，
     * 与 `reload()` 的口径统一（而不是只保留 reload 的那一行）。
     */
    this._issues = this._issues.filter((i) => i.table !== name);

    // ① 取原始数据
    let rows: readonly unknown[];
    try {
      rows = await this._source.load(name);
    } catch (e) {
      const msg = `加载失败: ${e instanceof Error ? e.message : String(e)}`;
      this._issues.push({ table: name, index: -1, rowId: '?', field: '', message: msg });
      if (this._throwOnError) throw new Error(`[ConfigLoader] 表 "${name}" ${msg}`);
      return;
    }

    /**
     * 【⚠️ 曾经的 bug：数据源返回非数组时抛出与配置完全无关的 TypeError】
     *
     * 原代码直接进到下面的 `for (const row of rows)`，
     * 而那行**不在 try 里**，于是 `rows is not iterable` 直接抛出去。
     *
     * 后果：`throwOnError: false`（"我想一次看到所有表的问题"）这个语义
     * 在这类错误上彻底失效——第一张表炸掉，后面 8 张表的问题一条都看不到。
     * 而且错误信息 `rows is not iterable` 完全不提表名、不提"配置"，
     * 排查方向会被带到"是不是 for...of 写错了"。
     *
     * 修法：当作这张表的一个校验问题，文案指名道姓说清是数据源的返回类型不对。
     */
    if (!Array.isArray(rows)) {
      const typeName = rows === null || rows === undefined
        ? String(rows)
        : Object.prototype.toString.call(rows);
      const msg = `数据源返回的不是数组（实际 ${typeName}）`;
      this._issues.push({ table: name, index: -1, rowId: '?', field: '', message: msg });
      if (this._throwOnError) throw new Error(`[ConfigLoader] 表 "${name}" ${msg}`);
      return;
    }

    // ② 校验
    const schema = hasOwn(this._schemas, name) ? this._schemas[name] : undefined;
    const issues = schema ? Validator.validateTable(name, rows, schema) : [];
    this._issues.push(...issues);

    if (issues.length > 0 && this._throwOnError) {
      throw new Error(Validator.format(issues));
    }

    // ③ 建索引
    //
    // 【⚠️ 曾经的 bug：id 撞车时索引静默覆盖】
    //
    // `index.set(String(id), row)` 对重复 id 直接覆盖：
    // 表里有 2 行（count 是对的），索引里只剩 1 条，
    // `get()` 拿到的永远是后一条，**没有任何报错**。
    //
    // 这里为什么值得单独再报一次、而不是只靠 Validator 查重：
    // 表可以**没有 schema**（`_loadTable` 里 `schema ? validate : []`），
    // 那条路径下 Validator 根本没跑，索引覆盖是唯一能发现问题的人。
    // 有 schema 时 Validator 会先报一条"id 重复"，
    // 这里再报一条索引层面的（指向"按 id 取值会拿到哪一条"），
    // 两条说的是同一件事的两面，不算噪音。
    const index = new Map<string, unknown>();
    for (const row of rows) {
      if (row && typeof row === 'object') {
        const id = (row as Record<string, unknown>).id;
        if (typeof id === 'string' || typeof id === 'number') {
          const key = String(id);
          if (index.has(key)) {
            this._issues.push({
              table: name,
              index: -1,
              rowId: key,
              field: 'id',
              message: `id "${key}" 重复：索引里后者覆盖了前者，按此 id 取配置只会拿到最后一条`,
            });
          }
          index.set(key, row);
        }
      }
    }

    this._tables.set(name, { name, rows, index });
  }

  private _checkReferences(): void {
    const tables: Record<string, readonly unknown[]> = {};
    for (const [name, t] of this._tables) tables[name] = t.rows;

    const issues = Validator.checkReferences(tables, this._schemas);
    this._issues.push(...issues);

    if (issues.length > 0 && this._throwOnError) {
      throw new Error(Validator.format(issues));
    }
  }

  // ==================== 读取 ====================

  /**
   * 按 id 取一行。**找不到会抛错。**
   *
   * 【为什么抛错而不是返回 undefined】
   * 返回 undefined 的话，错误会传播到很远的地方才爆发
   * （"cannot read property 'hp' of undefined"），那时已经没有上下文了。
   * 立刻抛错，栈会精确指向"谁在要这个 id"。
   *
   * 如果你确实需要"可能没有"的语义，用 `find()`。
   */
  get<T = unknown>(tableName: string, id: string | number): T {
    const table = this._requireTable(tableName);
    const row = table.index.get(String(id));
    if (row === undefined) {
      throw new Error(`[ConfigLoader] 表 "${tableName}" 中找不到 id="${id}"`);
    }
    return row as T;
  }

  /** 按 id 取，找不到返回 undefined */
  find<T = unknown>(tableName: string, id: string | number): T | undefined {
    const table = this._tables.get(tableName);
    if (!table) return undefined;
    return table.index.get(String(id)) as T | undefined;
  }

  /** 整表（只读） */
  all<T = unknown>(tableName: string): readonly T[] {
    const table = this._requireTable(tableName);
    return table.rows as readonly T[];
  }

  /** 按条件过滤 */
  where<T = unknown>(tableName: string, predicate: (row: T) => boolean): T[] {
    return this.all<T>(tableName).filter(predicate);
  }

  /**
   * 表中行数
   *
   * 【⚠️ 曾经的 bug：同为查询接口，口径却不一致】
   *
   * `all()` / `get()` / `where()` 对未加载的表都抛「表未加载」，
   * 只有 `count()` 静默返回 0。
   *
   * 后果：`if (loader.count('drops') > 0)` 这种"先探一下有没有数据"的写法，
   * 在表根本没加载时会**安静地走 else 分支**——
   * 表现为"掉落表是空的"，而真正的原因是表名写错或 loadAll 没跑到它。
   * 这类 bug 排查方向 100% 会被引到"表里是不是没配数据"。
   *
   * 修法：统一走 `_requireTable` 抛错。
   * 需要"可能没加载"的语义时，用 `loadedTables.includes(name)` 或 `find()`。
   *
   * 【⚠️ 这是对外行为的变更】未加载时从返回 0 变成抛错，
   * 与 `all()` / `get()` 的既有约定对齐（本文件开头就写明"缺失即报错"）。
   */
  count(tableName: string): number {
    return this._requireTable(tableName).rows.length;
  }

  has(tableName: string, id: string | number): boolean {
    const table = this._tables.get(tableName);
    return table ? table.index.has(String(id)) : false;
  }

  get loadedTables(): string[] {
    return Array.from(this._tables.keys());
  }

  get issues(): readonly ValidationIssue[] {
    return this._issues;
  }

  /** 清空校验问题（热重载前调用，避免累积旧错误） */
  clearIssues(): void {
    this._issues = [];
  }

  // ==================== 热重载 ====================

  /**
   * 重新加载某张表
   *
   * 【坑：热重载后旧引用失效】
   * 如果你在别处保存了 `const cfg = loader.get('enemies', 'slime')`，
   * 重载后这个 cfg 指向的是**旧对象**，改配置的数值不会生效——
   * 表现为「我明明改了配置，游戏里没变」。
   *
   * 正确做法：每次要用时重新 `get()`，或者订阅 onReload 刷新你的缓存。
   */
  async reload(tableName: string): Promise<void> {
    this._issues = this._issues.filter((i) => i.table !== tableName);
    await this._loadTable(tableName);
    this._checkReferences();

    for (const h of this._reloadHandlers) h(tableName);
  }

  /**
   * 订阅热重载
   *
   * 【⚠️ 曾经的 bug：旧的取消函数会误删新注册的同名监听器】
   *
   * 原实现把 `fn` 本身推进数组，取消时 `indexOf(fn)`。
   * 于是这种序列会出问题：
   *
   * ```typescript
   * const off = loader.onReload(refresh);
   * off();                            // 取消
   * const off2 = loader.onReload(refresh);   // 又注册了同一个 fn
   * off();                            // 手滑再调一次旧取消函数
   * ```
   *
   * 第二次 `off()` 的 `indexOf(refresh)` **命中的是刚注册的那个**，
   * 于是新订阅被删掉，`refresh` 再也不会被调用——
   * 表现为"重新订阅之后还是收不到刷新通知"。
   *
   * 这与已修的「EventBus 旧取消函数误删同名新监听器」是同一个坑：
   * **用函数值本身当身份，就没有"第几次订阅"这个维度。**
   *
   * 修法：包一层带 `alive` 标记的闭包，取消时按闭包自身的身份定位，
   * 且幂等（重复调用第二次直接 return，不会碰到别人）。
   */
  onReload(fn: (tableName: string) => void): () => void {
    let alive = true;
    const wrapped = (tableName: string): void => {
      if (alive) fn(tableName);
    };
    this._reloadHandlers.push(wrapped);
    return () => {
      if (!alive) return;
      alive = false;
      const i = this._reloadHandlers.indexOf(wrapped);
      if (i >= 0) this._reloadHandlers.splice(i, 1);
    };
  }

  // ==================== 内部 ====================

  private _requireTable(name: string): LoadedTable {
    const t = this._tables.get(name);
    if (!t) {
      throw new Error(
        `[ConfigLoader] 表 "${name}" 未加载。已加载: [${this.loadedTables.join(', ')}]`
      );
    }
    return t;
  }

  /** 【铁律 5】可卸载 */
  destroy(): void {
    this._tables.clear();
    this._issues = [];
    this._reloadHandlers.length = 0;
  }
}
