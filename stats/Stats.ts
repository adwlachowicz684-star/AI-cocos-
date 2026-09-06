/**
 * stats/Stats.ts —— 统计追踪
 *
 * 【它解决什么】
 *
 * 结算界面要显示：击杀数、最高连击、通关时间、死亡次数、各武器击杀……
 *
 * 手写的做法是一堆散落的变量，配上 `bestTime = Math.min(bestTime, t)`。
 * 问题在于：
 *
 * - 忘了 `Math.min` 就把"最短时间"变成了"最后一次时间"
 * - 想分武器统计时才发现问题，改起来要动所有记录点
 * - `Infinity` 直接渲染成 "-∞"
 *
 * 本模块把统计做成**声明式**的：
 *
 * ```typescript
 * const s = new Stats({
 *   defs: [
 *     { id: 'kills',    agg: 'sum',  persist: true },
 *     { id: 'maxCombo', agg: 'max' },
 *     { id: 'killsByWeapon', agg: 'sum', tags: ['weapon'] },
 *   ],
 * });
 * s.add('kills', 1);
 * s.get('kills');                                  // 1
 * s.get('killsByWeapon', { weapon: 'sword' });     // 分组
 * ```
 *
 * 【四个必须处理的真实问题】
 *
 * 1. **聚合的单位元**：max 的初始值是 -Infinity，min 是 +Infinity
 * 2. **展示安全**：`get()` 保持数学正确，`display()` 转成 0
 * 3. **分组 key 排序**：`{a,b}` 和 `{b,a}` 必须是同一组
 * 4. **存档跳过非有限值**：`JSON.stringify(Infinity)` 会变成 `null`
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

export type Aggregation = 'sum' | 'max' | 'min' | 'last' | 'count';

export interface StatDef {
  readonly id: string;
  /**
   * 聚合方式
   *
   * | 方式 | 单位元 | 含义 |
   * |---|---|---|
   * | `sum`   | 0          | 累加 |
   * | `max`   | -Infinity  | 保留最大 |
   * | `min`   | +Infinity  | 保留最小 |
   * | `last`  | 0          | 保留最后一次 |
   * | `count` | 0          | 只数次数，忽略传入值 |
   */
  readonly agg: Aggregation;
  /**
   * 是否跨会话保留（进存档）
   *
   * 【典型划分】
   * 总击杀数 persist；本局最高连击不 persist。
   */
  readonly persist?: boolean;
  /**
   * 分组维度
   *
   * 声明后才允许传对应标签，防止拼错维度名。
   */
  readonly tags?: readonly string[];
  readonly desc?: string;
}

export type Tags = Readonly<Record<string, string>>;

/** 派生指标计算函数 */
export type DerivedFn = (get: (id: string, tags?: Tags) => number) => number;

export interface StatsOptions {
  readonly defs: readonly StatDef[];
  /**
   * 派生指标（不存储，每次实时算）
   *
   * ```typescript
   * derived: { kph: (g) => g('kills') / (g('playtime') / 3600_000) }
   * ```
   */
  readonly derived?: Readonly<Record<string, DerivedFn>>;
  readonly onChange?: (id: string, value: number) => void;
}

// ==================== 工具 ====================

/** 聚合方式的单位元 */
import { hasOwn, needFinite } from '../_core/guard';

const IDENTITY: Readonly<Record<Aggregation, number>> = {
  sum: 0,
  max: -Infinity,
  min: Infinity,
  last: 0,
  count: 0,
};

const VALID_AGG: readonly Aggregation[] = ['sum', 'max', 'min', 'last', 'count'];

/**
 * 生成分组 key
 *
 * 【⚠️ 标签必须排序】
 * `{weapon:'sword', floor:'3'}` 和 `{floor:'3', weapon:'sword'}`
 * 是同一组合。不排序会存成两条，统计结果翻倍。
 *
 * 【⚠️ 拼接格式必须转义，否则会碰撞】
 *
 * 老实现是裸拼接 `` `${id}|${k}=${v},...` ``，实测碰撞：
 * ```js
 * makeKey('hit', { a: '1,b=2' })  // → 'hit|a=1,b=2'
 * makeKey('hit', { a: '1', b: '2' }) // → 'hit|a=1,b=2'   ← 同一个 key！
 * ```
 * 因为标签值里可以合法出现 `,` `=` `|` 这三个分隔符——
 * 武器名、关卡描述、玩家输入的自定义标签都可能有。
 *
 * 后果是**两个不同分组被合并统计**：A 组的数据算进了 B 组，
 * 且因为总数没变，没有任何"少了一条"的迹象，
 * 表现为"某个分组的数字莫名偏大"，几乎无法归因。
 *
 * 【为什么用 JSON 而不是自己写转义】
 * 自己写转义要处理"转义符本身也要转义"，容易漏；
 * `JSON.stringify` 对字符串的分隔符有完整转义，且已排序后顺序稳定。
 *
 * 【性能】
 * 比裸拼接慢，但 record/get 是**事件驱动**（击杀、拾取），
 * 不是每帧几千次的热路径。正确性优先。
 */
export function makeKey(id: string, tags: Tags): string {
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return `${id}|`;
  return `${id}|${JSON.stringify(keys.map((k) => [k, String(tags[k])]))}`;
}

// ==================== 实现 ====================

export class Stats {
  private readonly _defs = new Map<string, StatDef>();
  private readonly _values = new Map<string, number>();
  private readonly _derived: Readonly<Record<string, DerivedFn>>;
  private readonly _onChange?: (id: string, value: number) => void;

  constructor(opts: StatsOptions) {
    for (const d of opts.defs) {
      if (this._defs.has(d.id)) {
        throw new Error(`[Stats] 指标 id 重复：${d.id}`);
      }
      if (!VALID_AGG.includes(d.agg)) {
        throw new Error(
          `[Stats] 未知的聚合方式："${d.agg}"（可选：${VALID_AGG.join(', ')}）`
        );
      }
      this._defs.set(d.id, d);
    }
    this._derived = opts.derived ?? {};
    this._onChange = opts.onChange;
  }

  // ==================== 记录 ====================

  /**
   * 记录一次（按聚合方式处理）
   *
   * 【⚠️ value 必须是有限数值】
   *
   * 实测：`record('hit', NaN)` 后 `get('hit')` 返回 NaN，
   * 而 `display('hit')` 把它显示成 **0**。
   * 坏数据就这样被展示层静默藏掉了——
   * "统计面板显示 0"看起来完全正常，没人会想到上游算出了 NaN。
   *
   * 注意 `display()` 本身的设计是对的：
   * max 聚合无记录时是 -Infinity（数学上正确的单位元），
   * 直接渲染会显示 "-∞"，所以展示层转成 0。
   * **但 NaN 和"合法单位元"是两回事**——前者是数据损坏，后者是空集。
   *
   * 所以在入口拦住 NaN，而不是让展示层一刀切。
   */
  record(id: string, value = 1, tags: Tags = {}): void {
    const def = this._require(id);
    this._validateTags(def, tags);
    const v = needFinite(value, `Stats.record(${id}).value`);

    const key = makeKey(id, tags);
    const cur = this._values.get(key) ?? IDENTITY[def.agg];
    const next = this._apply(def.agg, cur, v);

    this._values.set(key, next);
    this._onChange?.(id, next);
  }

  /** 累加（sum 的语义化别名） */
  add(id: string, delta = 1, tags: Tags = {}): void {
    this.record(id, delta, tags);
  }

  /** 直接设置（覆盖聚合逻辑） */
  set(id: string, value: number, tags: Tags = {}): void {
    const def = this._require(id);
    this._validateTags(def, tags);
    const v = needFinite(value, `Stats.set(${id}).value`);
    this._values.set(makeKey(id, tags), v);
    this._onChange?.(id, v);
  }

  // ==================== 查询 ====================

  get(id: string, tags: Tags = {}): number {
    /**
     * 【⚠️ 派生表必须用 hasOwn，不能用 `in`】
     *
     * 实测：`get('toString')` 返回字符串 `"[object Object]"`，不是数字。
     * 因为 `'toString' in this._derived` 命中原型链 → 为 true，
     * 于是 `this._derived['toString'](...)` 调的是
     * `Object.prototype.toString`，返回字符串。
     *
     * 而本函数声明返回 `number`——**违反了自声明的返回类型却不报错**。
     * 调用方 `伤害 * stats.get(...)` 立刻得到 NaN，
     * 表现为伤害静默失效、角色血量不变。
     *
     * 指标 id 常来自配置表（成就条件、任务目标），属于外部输入。
     */
    if (hasOwn(this._derived, id)) {
      return this._derived[id]((x, t) => this.get(x, t));
    }
    const def = this._defs.get(id);
    if (!def) {
      throw new Error(
        `[Stats] 未定义的指标：${id}（已定义：${[...this._defs.keys()].join(', ')}）`
      );
    }
    this._validateTags(def, tags);
    return this._values.get(makeKey(id, tags)) ?? IDENTITY[def.agg];
  }

  /** 不抛错版本（UI 遍历用） */
  tryGet(id: string, tags: Tags = {}): number {
    try {
      return this.get(id, tags);
    } catch {
      return 0;
    }
  }

  /**
   * 展示用数值
   *
   * 【为什么需要】
   * max 聚合没有任何记录时是 -Infinity（数学上正确的单位元），
   * 但直接渲染会显示 "-∞"。
   * 所以 get() 保持数学正确，display() 负责展示友好。
   */
  display(id: string, tags: Tags = {}): number {
    const v = this.tryGet(id, tags);
    return Number.isFinite(v) ? v : 0;
  }

  /** 是否有过记录 */
  has(id: string, tags: Tags = {}): boolean {
    return this._values.has(makeKey(id, tags));
  }

  // ==================== 派生 ====================

  derived(id: string): number {
    // 同 get()：派生表只认自有属性，避免取到 Object.prototype 上的方法
    const fn = hasOwn(this._derived, id) ? this._derived[id] : undefined;
    if (!fn) {
      throw new Error(
        `[Stats] 未定义的派生指标：${id}（已定义：${Object.keys(this._derived).join(', ')}）`
      );
    }
    return fn((x, t) => this.get(x, t));
  }

  get derivedIds(): string[] {
    return Object.keys(this._derived);
  }

  // ==================== 分组 ====================

  /** 按某个维度汇总 */
  byTag(id: string, tag: string): Record<string, number> {
    const def = this._require(id);
    const out: Record<string, number> = {};

    const prefix = `${id}|`;
    for (const [key, v] of this._values) {
      if (!key.startsWith(prefix)) continue;
      const m = matchTag(key.slice(prefix.length), tag);
      if (m === null) continue;
      out[m] = (out[m] ?? IDENTITY[def.agg]);
      out[m] = this._apply(def.agg, out[m], v);
    }
    return out;
  }

  /** 列出出现过的标签组合 */
  tagCombos(id: string): Tags[] {
    this._require(id);
    const out: Tags[] = [];
    const seen = new Set<string>();
    const prefix = `${id}|`;

    for (const key of this._values.keys()) {
      if (!key.startsWith(prefix)) continue;
      const raw = key.slice(prefix.length);
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push(parseTags(raw));
    }
    return out;
  }

  // ==================== 重置与存档 ====================

  /** 重置单个指标（含所有分组） */
  reset(id: string): void {
    const def = this._require(id);
    const prefix = `${id}|`;
    for (const key of [...this._values.keys()]) {
      if (key.startsWith(prefix)) this._values.delete(key);
    }
    this._onChange?.(id, IDENTITY[def.agg]);
  }

  resetAll(): void {
    const ids = new Set<string>();
    for (const key of this._values.keys()) {
      ids.add(key.split('|')[0]);
    }
    this._values.clear();
    for (const id of ids) this._onChange?.(id, 0);
  }

  /** 清空未标记 persist 的指标（新一局开始时） */
  resetSession(): void {
    const prefixOf = new Map<string, boolean>();
    for (const d of this._defs.values()) prefixOf.set(d.id, d.persist === true);

    for (const key of [...this._values.keys()]) {
      const id = key.split('|')[0];
      if (prefixOf.get(id) !== true) this._values.delete(key);
    }
  }

  /** 导出（只含 persist 的） */
  exportState(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, v] of this._values) {
      const id = key.split('|')[0];
      const def = this._defs.get(id);
      if (def?.persist !== true) continue;
      /**
       * 【⚠️ 跳过非有限值】
       * `JSON.stringify(Infinity)` 得到 `null`，
       * 读回来是 null 而不是 Infinity，数值计算会变成 NaN。
       * 干脆不写。
       */
      if (!Number.isFinite(v)) continue;
      out[key] = v;
    }
    return out;
  }

  /** 导入（未知 id 静默跳过，兼容旧存档） */
  importState(state: Readonly<Record<string, number>>): void {
    for (const [key, v] of Object.entries(state)) {
      const id = key.split('|')[0];
      if (!this._defs.has(id)) continue;
      if (!Number.isFinite(v)) continue;
      this._values.set(key, v);
    }
  }

  /** 快照（含派生指标，UI 直接渲染） */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of this._defs.keys()) {
      out[id] = this.display(id);
    }
    for (const id of Object.keys(this._derived)) {
      try {
        out[id] = this.display(id);
      } catch {
        out[id] = 0;
      }
    }
    return out;
  }

  describe(): string {
    const lines: string[] = [];
    for (const id of this._defs.keys()) {
      const combos = this.tagCombos(id);
      if (combos.length <= 1) {
        lines.push(`${id} = ${this.display(id)}`);
      } else {
        for (const t of combos) {
          const tagStr = Object.entries(t)
            .map(([k, v]) => `${k}=${v}`)
            .join(',');
          lines.push(`${id}[${tagStr}] = ${this.display(id, t)}`);
        }
      }
    }
    for (const id of Object.keys(this._derived)) {
      try {
        lines.push(`${id} = ${this.display(id)}`);
      } catch {
        lines.push(`${id} = 0`);
      }
    }
    return lines.join('\n');
  }

  // ==================== 内部 ====================

  private _require(id: string): StatDef {
    const def = this._defs.get(id);
    if (!def) {
      throw new Error(
        `[Stats] 未定义的指标：${id}（已定义：${[...this._defs.keys()].join(', ')}）`
      );
    }
    return def;
  }

  private _validateTags(def: StatDef, tags: Tags): void {
    const declared = def.tags ?? [];
    for (const k of Object.keys(tags)) {
      if (!declared.includes(k)) {
        throw new Error(
          `[Stats] 指标 "${def.id}" 不支持标签 "${k}"（可选：${declared.join(', ') || '无'}）`
        );
      }
    }
  }

  private _apply(agg: Aggregation, cur: number, value: number): number {
    switch (agg) {
      case 'sum':
        return cur + value;
      case 'max':
        return Math.max(cur, value);
      case 'min':
        return Math.min(cur, value);
      case 'last':
        return value;
      case 'count':
        return cur + 1;
      default:
        return cur;
    }
  }
}

// ==================== 内部工具 ====================

/** 从 "a=1,b=2" 里取出指定 tag 的值 */
/**
 * 从 makeKey 产出的分组串里取出某个标签的值
 *
 * 【⚠️ 解析必须与 makeKey 的编码格式严格对应】
 *
 * 老实现按 `a=1,b=2` 切分。makeKey 改成 JSON 编码后，
 * 若不同步改这里，`byTag` / `tagCombos` 会**静默返回空结果**——
 * 不是报错，而是"汇总出来什么都没有"。
 *
 * 这正是"编码与解码分离"的典型风险：
 * 改编码时编译器不会提醒你还有个解码函数。
 * 所以这里直接复用 `parseTags`，不再各自手写一遍解析。
 */
function matchTag(part: string, tag: string): string | null {
  if (part === '') return null;
  const v = parseTags(part)[tag];
  return v === undefined ? null : v;
}

/**
 * 解析 makeKey 产出的分组串（`[["a","1"],["b","2"]]`）成对象
 *
 * 【为什么容错返回 {} 而不是抛错】
 * 调用方（`byTag` / `tagCombos`）是遍历所有的 key，
 * 其中可能有历史遗留或外部写入的异常格式。
 * 汇总场景下跳过一条坏数据比整体失败更合理。
 */
function parseTags(part: string): Tags {
  const out: Record<string, string> = {};
  if (part === '') return out;
  try {
    const arr = JSON.parse(part) as unknown;
    if (!Array.isArray(arr)) return out;
    for (const pair of arr) {
      if (Array.isArray(pair) && pair.length >= 2) {
        out[String(pair[0])] = String(pair[1]);
      }
    }
  } catch {
    return out;
  }
  return out;
}
