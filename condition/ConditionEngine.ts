/**
 * ConditionEngine —— 条件引擎（成就 / 任务 / 解锁）
 *
 * 【它解决什么】
 *
 * 成就、任务、解锁条件本质都是同一件事：
 * **"检查一组条件是否满足，并在某个时机触发"**。
 *
 * 手写的话每个成就都是一段 if，很快会变成：
 * - 100 个成就 = 100 个 if，分散在代码各处
 * - 无法在策划表里配置
 * - 无法在 UI 上显示进度（"击杀骷髅兵 7/20"）
 * - 加了新统计项要回头改所有成就
 *
 * 条件引擎把条件**数据化**：
 * ```typescript
 * { id: 'kill_20_skeletons',
 *   conditions: [
 *     { stat: 'kill:skeleton', op: '>=', value: 20 }
 *   ],
 *   logic: 'and' }
 * ```
 *
 * 【与成就的区别】
 * 本引擎只管"条件是否满足 + 进度是多少"，
 * 成就的展示、奖励发放由外部处理。这样职责单一，也更好复用。
 *
 * 【使用示例】
 * ```typescript
 * const engine = new ConditionEngine();
 *
 * engine.register({
 *   id: 'first_blood',
 *   conditions: [{ stat: 'kill:any', op: '>=', value: 1 }],
 * });
 *
 * engine.register({
 *   id: 'slayer',
 *   logic: 'and',
 *   conditions: [
 *     { stat: 'kill:skeleton', op: '>=', value: 20 },
 *     { stat: 'floor',         op: '>=', value: 3 },
 *   ],
 * });
 *
 * // 游戏事件驱动
 * engine.setStat('kill:skeleton', 5);
 * engine.addStat('kill:skeleton', 1);   // 6
 * engine.addStat('kill:any', 1);
 * engine.setStat('floor', 3);
 *
 * // 检查（返回新完成的）
 * const done = engine.check();
 * // ['first_blood']
 *
 * engine.progress('slayer');   // 0.3（用于 UI 显示进度条）
 * engine.isCompleted('slayer');
 * ```
 *
 * 【无引擎依赖】
 */

export type CompareOp = '>' | '>=' | '<' | '<=' | '==' | '!=';
export type LogicOp = 'and' | 'or';

export interface Condition {
  /** 统计项名 */
  readonly stat: string;
  readonly op: CompareOp;
  readonly value: number;
}

export interface ConditionDef {
  readonly id: string;
  readonly conditions: readonly Condition[];
  /** 多条件时的组合方式（默认 and） */
  readonly logic?: LogicOp;
  /** 自定义条件（无法用 stat 表达时） */
  readonly custom?: (stats: Readonly<Record<string, number>>) => boolean;
}

export interface ConditionResult {
  readonly id: string;
  /** 完成进度 0–1（所有条件的平均值） */
  readonly progress: number;
  readonly completed: boolean;
}

export class ConditionEngine {
  private readonly _defs = new Map<string, ConditionDef>();
  private readonly _stats = new Map<string, number>();
  private readonly _completed = new Set<string>();

  /** 条件完成时的回调 */
  private _onComplete: ((id: string) => void) | null = null;

  register(def: ConditionDef): this {
    if (def.conditions.length === 0 && !def.custom) {
      throw new Error(`[ConditionEngine] ${def.id}: 至少要有一个条件或 custom`);
    }
    this._defs.set(def.id, def);
    return this;
  }

  unregister(id: string): boolean {
    this._completed.delete(id);
    return this._defs.delete(id);
  }

  // ==================== 统计项 ====================

  setStat(name: string, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`[ConditionEngine] 统计值必须是有限数：${name} = ${value}`);
    }
    this._stats.set(name, value);
  }

  /** 增量（击杀数之类的累加用这个） */
  addStat(name: string, delta: number): number {
    const v = (this._stats.get(name) ?? 0) + delta;
    this._stats.set(name, v);
    return v;
  }

  getStat(name: string): number {
    return this._stats.get(name) ?? 0;
  }

  get stats(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [k, v] of this._stats) out[k] = v;
    return out;
  }

  // ==================== 检查 ====================

  /** 单个条件的比较 */
  private _compare(actual: number, op: CompareOp, expected: number): boolean {
    switch (op) {
      case '>':
        return actual > expected;
      case '>=':
        return actual >= expected;
      case '<':
        return actual < expected;
      case '<=':
        return actual <= expected;
      case '==':
        return actual === expected;
      case '!=':
        return actual !== expected;
      default:
        return false;
    }
  }

  /** 单个条件的进度（用于 UI） */
  private _progressOf(c: Condition, actual: number): number {
    /**
     * 【⚠️ 零值条件：直接按"是否满足"给 0/1，不能返回常量 1】
     *
     * 原实现 `return actual === 0 ? 1 : 1;` —— 两个分支返回同一个值，
     * 是**写了一半的三元**。于是所有 `value === 0` 的条件
     * （`x < 0`、`x != 0`、`x >= 0`）无论满足与否进度都是 1。
     *
     * 实测（修复前）：`{op:'<', value:0}`、actual=5（**不满足**）→ progress = **1**，
     * 而 `completed` 是 false —— 进度条显示 100% 却判定未完成。
     *
     * 【为什么是 0/1 而不是渐进值】
     * 阈值为 0 时不存在"走了多少比例"的中间态
     * （`actual / 0` 是 Infinity 或 NaN），
     * 所以退化为"满足即 1，不满足即 0"是唯一自洽的选择。
     */
    if (c.value === 0) return this._compare(actual, c.op, 0) ? 1 : 0;

    const p = actual / c.value;
    switch (c.op) {
      case '>':
      case '>=':
        return Math.min(1, Math.max(0, p));

      case '<':
      case '<=':
        /**
         * 【反向条件：值越**低**越满足，进度越高】
         *
         * "血量低于 30%"：血量 10% → 满进度；血量 100% → 0。
         * 实测确认这个方向是**正确的**，与 `>=` 相反是它的本意，不是 bug。
         * （有报告建议反转它，按那个改会让"残血任务"的进度条倒着走。）
         *
         * 【为什么分母用 Math.abs】
         * 原实现 `Math.max(1, c.value)` 对**负阈值**是错的：
         * `value = -10` 时 `Math.max(1, -10) = 1`，
         * 于是 `1 - (actual + 10) / 1` 会瞬间掉到 0，失去渐进。
         * 用 `Math.abs` 后按阈值自身的量级归一化，正负压阈都合理。
         */
        return actual <= c.value
          ? 1
          : Math.max(0, 1 - (actual - c.value) / Math.max(1, Math.abs(c.value)));

      case '==':
        return actual === c.value ? 1 : 0;

      case '!=':
        /**
         * 【⚠️ 必须与 `==` 相反】
         * 原实现两个分支共用 `actual === c.value ? 1 : 0`，
         * 于是 `!=` 的进度被算成了 `==` 的进度。
         *
         * 实测（修复前）：`{op:'!=', value:0}` 在 actual=0（不满足）和
         * actual=5（满足）两种情况下 progress 都是 **1**
         * —— 进度条完全不携带信息，玩家无法判断还差多少。
         */
        return actual !== c.value ? 1 : 0;

      default:
        return 0;
    }
  }

  /** 检查一个定义是否满足 */
  evaluate(id: string): ConditionResult {
    const def = this._defs.get(id);
    if (!def) return { id, progress: 0, completed: false };

    const logic = def.logic ?? 'and';
    let allOk = logic === 'and';
    let progressSum = 0;

    for (const c of def.conditions) {
      const actual = this.getStat(c.stat);
      const ok = this._compare(actual, c.op, c.value);
      progressSum += this._progressOf(c, actual);

      if (logic === 'and') {
        if (!ok) allOk = false;
      } else {
        if (ok) allOk = true;
      }
    }

    // custom 条件
    if (def.custom) {
      const ok = def.custom(this.stats);
      if (logic === 'and') allOk = allOk && ok;
      else allOk = allOk || ok;
    }

    const n = def.conditions.length || 1;
    const progress = Math.min(1, Math.max(0, progressSum / n));

    return { id, progress, completed: allOk };
  }

  /**
   * 检查所有定义，返回**本次新完成**的 id
   *
   * 【为什么只返回新完成的】
   * 调用方通常只关心"要不要弹成就提示"。
   * 已完成的不重复触发——这个去重逻辑放这里，
   * 避免每个调用方各写一遍。
   */
  check(): string[] {
    const newly: string[] = [];
    for (const id of this._defs.keys()) {
      if (this._completed.has(id)) continue;
      if (this.evaluate(id).completed) {
        this._completed.add(id);
        newly.push(id);
        this._onComplete?.(id);
      }
    }
    return newly;
  }

  isCompleted(id: string): boolean {
    return this._completed.has(id);
  }

  /** 进度（UI 显示用） */
  progress(id: string): number {
    return this.evaluate(id).progress;
  }

  /** 所有定义的进度（成就列表界面用） */
  list(): ConditionResult[] {
    return Array.from(this._defs.keys()).map((id) => {
      const r = this.evaluate(id);
      return { id, progress: r.progress, completed: this.isCompleted(id) || r.completed };
    });
  }

  onComplete(fn: (id: string) => void): () => void {
    this._onComplete = fn;
    return () => {
      if (this._onComplete === fn) this._onComplete = null;
    };
  }

  // ==================== 存档 ====================

  export(): {
    stats: Record<string, number>;
    completed: string[];
  } {
    const stats: Record<string, number> = {};
    for (const [k, v] of this._stats) stats[k] = v;
    return { stats, completed: Array.from(this._completed) };
  }

  import(data: { stats?: Record<string, number>; completed?: readonly string[] }): void {
    this._stats.clear();
    this._completed.clear();
    if (data.stats) for (const [k, v] of Object.entries(data.stats)) this._stats.set(k, v);
    if (data.completed) for (const id of data.completed) this._completed.add(id);
  }

  reset(): void {
    this._stats.clear();
    this._completed.clear();
  }

  destroy(): void {
    this.reset();
    this._defs.clear();
    this._onComplete = null;
  }
}
