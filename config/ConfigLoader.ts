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

    // ② 校验
    const schema = hasOwn(this._schemas, name) ? this._schemas[name] : undefined;
    const issues = schema ? Validator.validateTable(name, rows, schema) : [];
    this._issues.push(...issues);

    if (issues.length > 0 && this._throwOnError) {
      throw new Error(Validator.format(issues));
    }

    // ③ 建索引
    const index = new Map<string, unknown>();
    for (const row of rows) {
      if (row && typeof row === 'object') {
        const id = (row as Record<string, unknown>).id;
        if (typeof id === 'string' || typeof id === 'number') {
          index.set(String(id), row);
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

  /** 表中行数 */
  count(tableName: string): number {
    const table = this._tables.get(tableName);
    return table ? table.rows.length : 0;
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

  /** 订阅热重载 */
  onReload(fn: (tableName: string) => void): () => void {
    this._reloadHandlers.push(fn);
    return () => {
      const i = this._reloadHandlers.indexOf(fn);
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
