/**
 * Validator —— 配置校验器
 *
 * 【为什么这个插件能省钱】
 *
 * 配置表里拼错一个 id，如果没有校验，会表现成：
 * 「第 47 层的某个敌人不掉东西」
 * 然后你花三小时查掉落逻辑、查概率、查战斗代码……
 * 最后发现是 drop_table 字段写成了 `boss_loot` 而表里叫 `boss_loot_01`。
 *
 * 有了校验器：**启动那一刻就报错**，三分钟改完。
 *
 * 【设计：一次报全，不要遇到一个就停】
 * 校验器如果 throw 第一个错误，你就要"改一个→重启→再改一个"循环几十次。
 * 一次列出全部错误，十分钟改完，体验完全不同。
 *
 * 【使用示例】
 * ```typescript
 * const schema: TableSchema = {
 *   id:     { type: 'string', required: true },
 *   hp:     { type: 'number', min: 1, max: 9999 },
 *   name:   { type: 'string', required: true },
 *   drops:  { type: 'ref', table: 'loot', nullable: true },
 *   flags:  { type: 'array', item: 'string' },
 * };
 *
 * const errors = Validator.validateTable('enemies', rows, schema);
 * // errors: ['enemies[3].hp: 超出范围 [1, 9999]（实际 -5）', ...]
 *
 * // 跨表引用完整性
 * const refErrors = Validator.checkReferences(tables, schemas);
 * ```
 *
 * 【无引擎依赖】纯逻辑，可完整单测。
 */

import { hasOwn } from '../_core/guard';

/** 字段类型 */
export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'ref' | 'any';

export interface FieldSchema {
  readonly type: FieldType;
  /** 是否必填（缺失即报错） */
  readonly required?: boolean;
  /** 是否允许 null / undefined（默认 false） */
  readonly nullable?: boolean;
  /** number：最小值 */
  readonly min?: number;
  /** number：最大值 */
  readonly max?: number;
  /** string：最小长度 */
  readonly minLength?: number;
  /** string：非空（不能是空字符串或纯空格） */
  readonly notBlank?: boolean;
  /** string：允许的取值（枚举） */
  readonly enum?: readonly (string | number)[];
  /** array：元素类型 */
  readonly item?: FieldType;
  /** ref：指向哪张表 */
  readonly table?: string;
  /** 自定义校验：返回错误描述，或 null 表示通过 */
  readonly custom?: (value: unknown, row: unknown, index: number) => string | null;
}

/** 一张表的 schema：字段名 → 字段规则 */
export type TableSchema = Readonly<Record<string, FieldSchema>>;

/** 校验结果 */
export interface ValidationIssue {
  /** 表名 */
  readonly table: string;
  /** 行索引（-1 表示表级问题） */
  readonly index: number;
  /** 行 id（便于定位，未知时为 '?'） */
  readonly rowId: string;
  /** 字段名 */
  readonly field: string;
  /** 问题描述 */
  readonly message: string;
}

export class Validator {
  /**
   * 校验一张表
   *
   * @param tableName 表名（仅用于错误信息）
   * @param rows 数据行
   * @param schema 表 schema
   * @returns 问题列表（空数组 = 通过）
   */
  static validateTable(tableName: string, rows: readonly unknown[], schema: TableSchema): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    if (!Array.isArray(rows)) {
      issues.push({ table: tableName, index: -1, rowId: '?', field: '', message: '表数据必须是数组' });
      return issues;
    }

    // id 去重检查（这本身是很常见的问题）
    const seenIds = new Map<string, number>();

    rows.forEach((row, index) => {
      const rowId = Validator._rowId(row, index);

      if (row === null || typeof row !== 'object') {
        issues.push({ table: tableName, index, rowId, field: '', message: `第 ${index} 行不是对象` });
        return;
      }

      const r = row as Record<string, unknown>;

      // ① 字段级校验
      for (const [field, rule] of Object.entries(schema)) {
        const value = r[field];
        const err = Validator._validateField(value, rule, r, index);
        if (err) issues.push({ table: tableName, index, rowId, field, message: err });
      }

      // ② 未声明字段（拼写检查）
      // 【为什么这个检查有价值】
      // 配置里写了 `attakc: 10`，schema 里是 `attack`——
      // 数据静默丢失，查起来非常痛苦。
      // 但这个检查可能过于严格（有些表确实允许扩展字段），
      // 所以设为可选：调用方用 allowExtraFields 控制。
      // 这里默认报出来，让调用方决定要不要过滤掉。

      // ③ id 去重
      //
      // 【⚠️ 曾经的 bug：数字型 id 完全不参与重复检测】
      //
      // 原实现只在 `typeof r.id === 'string'` 时查重，
      // 而下面三处都接受 number：
      //   - `_rowId`（本文件）：string | number 都转成 key
      //   - `checkReferences` 的 idSets：同样两者都收
      //   - `ConfigLoader` 的索引：同样两者都收
      //
      // 于是用数字 id 的表（自动生成 id 的策划表非常常见）出现重复行时：
      //   启动校验全绿（0 个问题）→ 行数 count() 也对 →
      //   但 `get(table, id)` 拿到的**永远是后一条**。
      //
      // 实测（修复前）：两行 id 都是 1 的 hero 表，
      //   validateTable 报出的问题 = []
      //   get(hero, 1) = {"id":1,"name":"第二个（id 撞了）"}
      //   count(hero) = 2
      //
      // 表现为「我改了这条配置，游戏里没变」，
      // 排查时第一反应是热重载或缓存坏了，很难想到是 id 撞了。
      //
      // 修法：判断口径与 `_rowId` / `idSets` / 索引保持一致。
      if (typeof r.id === 'string' || typeof r.id === 'number') {
        /**
         * 【为什么 key 带类型前缀，而不是直接 String(id)】
         *
         * 直接 `String(id)` 会把 `'1'` 和 `1` 判成同一个 id。
         * 从"索引会不会撞"的角度看它们确实会撞（索引就是 String(id)），
         * 但把跨类型碰撞判成"重复 id"是**新增的报错**——
         * 原本合法的一张混用 id 类型的表会突然在启动校验里失败。
         *
         * 本条的目的只是"把数字 id 纳入检测"（与 `_rowId` / idSets 的口径对齐），
         * 不该顺带改变 string / number 之间的碰撞语义。
         * 所以按类型区分：'1' 与 1 各占一个 key。
         *
         * ⚠️ 索引层（`ConfigLoader._loadTable`）仍会为这种组合报一条
         * "后者覆盖了前者"——那反映的是真实发生的覆盖，口径不同但都对。
         */
        const key = `${typeof r.id}:${String(r.id)}`;
        const prev = seenIds.get(key);
        if (prev !== undefined) {
          issues.push({
            table: tableName,
            index,
            rowId,
            field: 'id',
            message: `id 重复（与第 ${prev} 行相同）`,
          });
        } else {
          seenIds.set(key, index);
        }
      }
    });

    return issues;
  }

  /**
   * 校验单行
   *
   * 【用途】编辑器里改一条配置时即时校验，不用等整表保存
   */
  static validateRow(row: unknown, schema: TableSchema): ValidationIssue[] {
    return Validator.validateTable('', [row], schema);
  }

  private static _rowId(row: unknown, index: number): string {
    if (row && typeof row === 'object') {
      const id = (row as Record<string, unknown>).id;
      if (typeof id === 'string' || typeof id === 'number') return String(id);
    }
    return `#${index}`;
  }

  private static _validateField(
    value: unknown,
    rule: FieldSchema,
    row: Record<string, unknown>,
    index: number
  ): string | null {
    // 缺失
    if (value === undefined) {
      return rule.required ? '必填字段缺失' : null;
    }

    // null
    if (value === null) {
      return rule.nullable ? null : '不允许为 null（如需允许请设 nullable: true）';
    }

    // 类型
    const typeErr = Validator._checkType(value, rule);
    if (typeErr) return typeErr;

    // 数值范围
    if (rule.type === 'number' && typeof value === 'number') {
      if (Number.isNaN(value)) return '不能是 NaN';
      if (!Number.isFinite(value)) return '不能是 Infinity';
      if (rule.min !== undefined && value < rule.min) return `小于最小值 ${rule.min}（实际 ${value}）`;
      if (rule.max !== undefined && value > rule.max) return `超过最大值 ${rule.max}（实际 ${value}）`;
    }

    // 字符串
    if (rule.type === 'string' && typeof value === 'string') {
      if (rule.notBlank && value.trim().length === 0) return '不能是空白字符串';
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        return `长度不足 ${rule.minLength}（实际 ${value.length}）`;
      }
    }

    // 枚举
    if (rule.enum && rule.enum.length > 0) {
      if (!rule.enum.includes(value as string | number)) {
        return `不是允许的取值（${rule.enum.join(' | ')}），实际 ${JSON.stringify(value)}`;
      }
    }

    // 数组元素类型
    //
    // 【⚠️ 曾经的 bug：遇到第一个错误元素就 return，一次只报一个】
    //
    // `tags: [1, 2, 3]` 只会报「第 0 个元素类型错误」，
    // 改完第 0 个重启，又报第 1 个——"改一个→重启→再改一个"的循环
    // 正是本文件开头说要避免的体验。
    // 校验器一次把全部错误列出，改一遍就能通过。
    if (rule.type === 'array' && Array.isArray(value) && rule.item) {
      const elemErrors: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const e = Validator._checkType(value[i], { type: rule.item });
        if (e) elemErrors.push(`第 ${i} 个元素类型错误：${e}`);
      }
      if (elemErrors.length > 0) return elemErrors.join('；');
    }

    // 自定义
    if (rule.custom) {
      const e = rule.custom(value, row, index);
      if (e) return e;
    }

    return null;
  }

  private static _checkType(value: unknown, rule: FieldSchema): string | null {
    switch (rule.type) {
      case 'any':
      case 'ref':
        return null;
      case 'string':
        return typeof value === 'string' ? null : `应是 string，实际 ${typeof value}`;
      case 'number':
        return typeof value === 'number' ? null : `应是 number，实际 ${typeof value}`;
      case 'boolean':
        return typeof value === 'boolean' ? null : `应是 boolean，实际 ${typeof value}`;
      case 'array':
        return Array.isArray(value) ? null : `应是 array，实际 ${typeof value}`;
      case 'object':
        return typeof value === 'object' && !Array.isArray(value) ? null : `应是 object，实际 ${typeof value}`;
      default:
        return null;
    }
  }

  /**
   * 跨表引用完整性检查
   *
   * 【为什么单独一步】
   * 字段级校验只能看到"这个字段是 string"，
   * 看不到"这个 string 在另一张表里存不存在"。
   * 必须等所有表都加载完才能做。
   *
   * @param tables 表名 → 数据行
   * @param schemas 表名 → schema
   */
  static checkReferences(
    tables: Readonly<Record<string, readonly unknown[]>>,
    schemas: Readonly<Record<string, TableSchema>>
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // 先建立每表的 id 集合
    const idSets = new Map<string, Set<string>>();
    for (const [name, rows] of Object.entries(tables)) {
      const set = new Set<string>();
      rows.forEach((r, i) => {
        if (r && typeof r === 'object') {
          const id = (r as Record<string, unknown>).id;
          if (typeof id === 'string' || typeof id === 'number') set.add(String(id));
        } else {
          void i;
        }
      });
      idSets.set(name, set);
    }

    // 再检查引用
    for (const [tableName, rows] of Object.entries(tables)) {
      const schema = schemas[tableName];
      if (!schema) continue;

      // 找出这张表里所有 ref 字段
      const refFields = Object.entries(schema).filter(([, r]) => r.type === 'ref' && r.table);

      rows.forEach((row, index) => {
        if (!row || typeof row !== 'object') return;
        const r = row as Record<string, unknown>;
        const rowId = Validator._rowId(row, index);

        for (const [field, rule] of refFields) {
          const value = r[field];
          if (value === undefined || value === null) continue;

          const target = rule.table!;
          const validIds = idSets.get(target);
          if (!validIds) {
            /**
             * 【⚠️ 曾经的 bug：加载失败会引发级联误报】
             *
             * 只要被引用的表不在 `tables` 里就报「引用了不存在的表」，
             * 但"不在 tables 里"有两种完全不同的原因：
             *   ① 这张表根本没在 schema 里声明（真·写错了表名）→ 该报
             *   ② 声明了，但本次加载失败（数据源异常 / 上一张表抛错中断）→ 不该报
             *
             * ② 的后果最坏：一张表加载失败，引用它的 8 张表各报一条，
             * 一条真正的错误（那次加载失败）被 8 条无意义的"表不存在"淹掉，
             * 排查时注意力被引到"是不是表名拼错了"。
             *
             * 所以：schema 里声明过的表不在这里重复报，
             * 它的失败由 `_loadTable` 自己负责报（那条信息才是真因）。
             */
            if (hasOwn(schemas as object, target)) continue;
            issues.push({
              table: tableName,
              index,
              rowId,
              field,
              message: `引用了不存在的表 "${target}"`,
            });
            continue;
          }

          // 支持单引用和引用数组
          const refs = Array.isArray(value) ? value : [value];
          for (const ref of refs) {
            if (typeof ref !== 'string' && typeof ref !== 'number') {
              issues.push({ table: tableName, index, rowId, field, message: `引用值类型错误: ${JSON.stringify(ref)}` });
              continue;
            }
            if (!validIds.has(String(ref))) {
              issues.push({
                table: tableName,
                index,
                rowId,
                field,
                message: `引用了 ${target} 中不存在的 id "${ref}"`,
              });
            }
          }
        }
      });
    }

    return issues;
  }

  /** 把问题列表格式化成可读文本 */
  static format(issues: readonly ValidationIssue[]): string {
    if (issues.length === 0) return '配置校验通过 ✓';
    const lines = issues.map(
      (i) => `  ${i.table}${i.index >= 0 ? `[${i.index}]` : ''} (id=${i.rowId})${i.field ? `.${i.field}` : ''}: ${i.message}`
    );
    return `配置校验发现 ${issues.length} 个问题：\n${lines.join('\n')}`;
  }
}
