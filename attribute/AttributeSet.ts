/**
 * AttributeSet —— 属性容器（基础值 + 修正器）
 *
 * 【它解决什么】
 *
 * 游戏里几乎每个数值都是「基础值 + 一堆临时加成」：
 *   攻击力 = 基础 20 + 武器 5 + 力量buff 10，再 ×（1 + 狂暴 30% + 遗物 20%）
 *
 * 如果每次用时都现场算一遍，代码会散落各处；
 * 如果把结果写死，buff 结束时又不知道该减回多少。
 *
 * AttributeSet 把这件事收在一处：**存基础值和修正器列表，用时算，并缓存。**
 *
 * 【零业务依赖】
 * 它不认识「攻击力」「血量」「暴击率」。
 * 属性 id 是开放字符串，由调用方定义：
 * ```typescript
 * attrs.define({ id: 'atk', base: 20 });
 * attrs.define({ id: 'critRate', base: 0.05, min: 0, max: 1 });
 * ```
 *
 * 【为什么不复用 damage-pipeline 的 ModifierSet】
 *
 * 分层规则只允许向下依赖第 0 层（`_core` / `ds`），
 * 而 `damage-pipeline` 和 `attribute` 同属第 1 层，不能横向 import。
 *
 * 两者语义也不同：ModifierSet 服务于「一次伤害结算」的瞬时修正，
 * AttributeSet 需要**长期持有**的修正（带来源、带标签、带条件、需要缓存）。
 *
 * 所以这里自带一个轻量实现，重复是必要的。
 *
 * 【使用示例】
 * ```typescript
 * const attrs = new AttributeSet();
 * attrs.define({ id: 'atk', base: 20 });
 *
 * attrs.add({ attr: 'atk', type: 'add', value: 5, source: 'weapon' });
 * attrs.add({ attr: 'atk', type: 'mul', value: 0.3, source: 'rage', tag: 'buff' });
 *
 * attrs.get('atk');           // (20 + 5) × (1 + 0.3) = 32.5
 * attrs.clearByTag('buff');    // buff 到期，回到 25
 * attrs.get('atk');           // 25
 * ```
 */

// ── 相减缓存版本：任何修改都 bump 版本，查询时比对版本决定是否重算 ──

/** 修正类型 */
export type AttrModifierType =
  /** 加算：`base + Σadd` */
  | 'add'
  /** 乘算：`× (1 + Σmul)` —— 注意是**相加后统一乘**，见下文说明 */
  | 'mul'
  /** 覆盖：直接替换 base，优先级最高 */
  | 'override';

/** 属性定义 */
export interface AttributeDef {
  /** 属性 id（开放字符串） */
  id: string;
  /** 基础值 */
  base: number;
  /** 最终值下限（在**修正之后** clamp） */
  min?: number;
  /** 最终值上限 */
  max?: number;
}

/** 修正器 */
export interface AttributeModifier {
  /** 作用于哪个属性 */
  attr: string;
  /** 修正类型 */
  type: AttrModifierType;
  /**
   * 数值
   * - add：直接加（可以是负数）
   * - mul：0.3 表示 +30%
   * - override：直接替换基础值
   */
  value: number;
  /**
   * 来源标识，用于按来源批量移除
   *
   * 【为什么必须有】
   * 装备换下来时要精确移除「这把武器」的贡献，
   * 不能靠值来匹配（两件装备可能都是 +5）。
   */
  source?: string;
  /** 标签，用于批量清理（如 `tag: 'buff'` 一次性清掉所有 buff） */
  tag?: string;
  /**
   * 条件修正：返回 false 时该修正不生效
   *
   * 【代价】带条件的修正会**跳过缓存**（因为条件可能随时变）。
   * 只在确实需要时才用。
   */
  condition?: () => boolean;
}

/** 变化通知（调试 UI / 属性面板用） */
export interface AttributeChange {
  attr: string;
  oldValue: number;
  newValue: number;
}

let nextModifierId = 1;

/** 内部存储的修正器（带唯一 id，便于精确移除） */
interface StoredModifier extends AttributeModifier {
  readonly _id: number;
}

/**
 * 属性集合
 *
 * 【线程/时序约定】
 * 修改（add / remove / setBase）会 bump 版本号，
 * 查询（get）在版本变化时重算并缓存。
 * **不要在遍历 `onChange` 回调时修改属性**——会触发递归通知。
 */
export class AttributeSet {
  private _defs = new Map<string, AttributeDef>();
  private _base = new Map<string, number>();
  private _mods = new Map<string, StoredModifier[]>();
  private _cache = new Map<string, number>();

  /** 有条件的修正会跳过缓存，但它仍需要触发重算 */
  private _version = 0;
  private _cachedVersion = -1;

  /** 是否存在条件修正（有则禁用全部缓存，简化正确性判断） */
  private _hasConditional = false;

  private _listeners: Array<(c: AttributeChange) => void> = [];
  private _notifySuspended = false;
  private _pendingChanges: AttributeChange[] = [];

  constructor(defs: readonly AttributeDef[] = []) {
    for (const d of defs) this.define(d);
  }

  // ── 定义与基础值 ──

  /** 定义一个属性（重复定义会覆盖 base） */
  define(def: AttributeDef): this {
    this._defs.set(def.id, def);
    if (!this._base.has(def.id)) this._base.set(def.id, def.base);
    this._bump();
    return this;
  }

  /** 是否已定义 */
  has(id: string): boolean {
    return this._defs.has(id);
  }

  /** 所有属性 id */
  ids(): string[] {
    return Array.from(this._defs.keys());
  }

  /** 设置基础值（不影响修正器） */
  setBase(id: string, value: number): this {
    const old = this.get(id);
    this._base.set(id, value);
    this._bump();
    this._notifyIf(id, old);
    return this;
  }

  /** 读取基础值（未定义返回 0） */
  getBase(id: string): number {
    return this._base.get(id) ?? this._defs.get(id)?.base ?? 0;
  }

  // ── 修正器 ──

  /**
   * 添加一个修正器
   *
   * @returns 移除函数（比记住 source 再调 removeBySource 更不容易出错）
   */
  add(m: AttributeModifier): () => void {
    // 【old 必须在修改之前取】
    // 曾经把 `const old = this.get(...)` 写在 push 之后，
    // 那时 get 已经算出了新值，old === newValue → 通知永远不触发。
    // 表现为"属性变了但 UI 不刷新"，且没有任何报错。
    const old = this.get(m.attr);

    const stored: StoredModifier = { ...m, _id: nextModifierId++ };
    let list = this._mods.get(m.attr);
    if (!list) {
      list = [];
      this._mods.set(m.attr, list);
    }
    list.push(stored);
    if (m.condition) this._hasConditional = true;

    this._bump();
    this._notifyIf(m.attr, old);

    return () => this.removeById(m.attr, stored._id);
  }

  /** 批量添加（常用于穿上一套装备） */
  addAll(ms: readonly AttributeModifier[]): () => void {
    const disposers = ms.map((m) => this.add(m));
    return () => {
      for (const d of disposers) d();
    };
  }

  /** 按来源移除 */
  removeBySource(source: string): number {
    let n = 0;
    for (const attr of this._mods.keys()) {
      n += this.removeWhere(attr, (m) => m.source === source);
    }
    return n;
  }

  /** 按标签移除（如 buff 全部到期） */
  clearByTag(tag: string): number {
    let n = 0;
    for (const attr of this._mods.keys()) {
      n += this.removeWhere(attr, (m) => m.tag === tag);
    }
    return n;
  }

  /** 按自定义条件移除 */
  removeWhere(attr: string, predicate: (m: AttributeModifier) => boolean): number {
    const list = this._mods.get(attr);
    if (!list || list.length === 0) return 0;

    const old = this.get(attr);
    let removed = 0;

    // 【倒序遍历】正边遍历边删除会跳过元素，这是最常见的数组删除 bug
    for (let i = list.length - 1; i >= 0; i--) {
      if (predicate(list[i])) {
        list.splice(i, 1);
        removed++;
      }
    }

    if (removed > 0) {
      this._recomputeHasConditional();
      this._bump();
      this._notifyIf(attr, old);
    }
    return removed;
  }

  /**
   * 清空某个属性的所有修正器（不传则清空全部）
   *
   * 【为什么必须补 onChange 通知】
   * 同一个"移除修正器"的语义，本类给了三个 API：
   * `removeBySource` / `clearByTag`（内部走 `removeWhere`，**会通知**）
   * 与 `clearModifiers`（原本**不通知**）。
   *
   * 后果是调用方用 `clearModifiers` 清 debuff 时，血条 / 属性面板停在旧数值上，
   * 直到下一次别的操作才刷新——而调用方完全不知道自己用错了 API。
   * 这是典型的"同义不同行为"，所以这里对齐到"会通知"的一侧。
   */
  clearModifiers(attr?: string): number {
    if (attr === undefined) {
      // 【为什么要在 clear() 之前先快照受影响的属性与旧值】
      // 两件事都必须赶在清空前做：
      //   1. `this._mods.clear()` 之后再遍历 keys() 只会拿到空迭代器，
      //      就再也无从知道"哪些属性被改过"；
      //   2. 通知的 oldValue 必须是**清空前**的值，
      //      而 newValue 由 `_notifyIf` 在**清空后**重新 `get()` 得到。
      // 两者跨了一次状态变更，所以只能各自在正确的时机取。
      const affected = Array.from(this._mods.keys());
      const olds = new Map<string, number>();
      for (const a of affected) olds.set(a, this.get(a));

      let n = 0;
      for (const a of affected) n += this._mods.get(a)?.length ?? 0;
      this._mods.clear();
      this._hasConditional = false;
      this._bump();
      // 【为什么逐个通知而不是只发一条"全变了"】
      // 让 `clearModifiers()` 与"对每个属性各调一次 clearModifiers(attr)"等价，
      // 监听器无需区分两种调用方式。挂起期间由 `_notifyIf` 自动汇总，无需特判。
      for (const a of affected) this._notifyIf(a, olds.get(a) as number);
      return n;
    }
    const old = this.get(attr);
    const n = this._mods.get(attr)?.length ?? 0;
    this._mods.delete(attr);
    this._recomputeHasConditional();
    this._bump();
    // n === 0 时值没变，`_notifyIf` 内部比较后会自动跳过，无需在这里判空。
    this._notifyIf(attr, old);
    return n;
  }

  private removeById(attr: string, id: number): boolean {
    return this.removeWhere(attr, (m) => (m as StoredModifier)._id === id) > 0;
  }

  private _recomputeHasConditional(): void {
    for (const list of this._mods.values()) {
      for (const m of list) {
        if (m.condition) {
          this._hasConditional = true;
          return;
        }
      }
    }
    this._hasConditional = false;
  }

  // ── 查询 ──

  /**
   * 取最终值
   *
   * 【计算公式】
   * ```
   * base' = 最后一个 override?.value ?? base
   * v     = base' + Σadd
   * v     = v × (1 + Σmul)
   * v     = clamp(v, min, max)
   * ```
   *
   * 【为什么多个 mul 相加而不是连乘】
   * 两个 +50%：
   * - 连乘 → 1.5 × 1.5 = **2.25x**
   * - 相加 → 1 + (0.5+0.5) = **2.0x**
   *
   * 相加更好：玩家能心算，且不会出现「叠得越多收益越爆炸」的失控。
   * 想要连乘效果，用 `type: 'mul'` 配条件修正，或在业务层再乘一次。
   */
  get(id: string): number {
    if (this._hasConditional) return this._compute(id);

    if (this._cachedVersion !== this._version) {
      this._cache.clear();
      this._cachedVersion = this._version;
    }
    const hit = this._cache.get(id);
    if (hit !== undefined) return hit;

    const v = this._compute(id);
    this._cache.set(id, v);
    return v;
  }

  private _compute(id: string): number {
    const def = this._defs.get(id);
    const base = this._base.get(id) ?? def?.base ?? 0;

    const list = this._mods.get(id);
    let v = base;
    let add = 0;
    let mul = 0;

    if (list) {
      for (const m of list) {
        if (m.condition && !m.condition()) continue;

        switch (m.type) {
          case 'override':
            // 【取最后一个】后设置的覆盖先设置的，符合直觉
            v = m.value;
            break;
          case 'add':
            add += m.value;
            break;
          case 'mul':
            mul += m.value;
            break;
        }
      }
    }

    // 【原来这里写的是 `v = overridden ? v + add : v + add;`】
    // 三元两个分支完全相同——作者显然犹豫过"override 时是否该忽略 add"，
    // 但最终没有区分，留下一段看起来有分支、实际什么都没做的代码。
    //
    // 危害不在运行结果（两种写法结果一致），而在**误导**：
    // 维护者读到这行会以为存在"override 定终值"的开关，
    // 顺着这个错误前提去改，必然改错。所以这里摊平成无条件相加。
    //
    // 【当前语义（与 README 第 27 行公式一致，未作变更）】
    //   override 只替换 base，add 与 mul **仍然叠加**。
    //   否则 override 就成了"锁死"——连 buff 都加不上去，太粗暴。
    v = v + add;
    v = v * (1 + mul);

    const min = def?.min;
    const max = def?.max;
    if (min !== undefined && v < min) v = min;
    if (max !== undefined && v > max) v = max;

    return v;
  }

  /** 所有属性的最终值快照（存档 / 属性面板用） */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of this._defs.keys()) out[id] = this.get(id);
    return out;
  }

  /** 调试用：列出某属性的修正器明细 */
  dump(id: string): string {
    const list = this._mods.get(id) ?? [];
    const base = this.getBase(id);
    const parts = [`${id}: base ${base}`];
    let add = 0;
    let mul = 0;
    for (const m of list) {
      if (m.condition && !m.condition()) continue;
      if (m.type === 'add') add += m.value;
      else if (m.type === 'mul') mul += m.value;
      else parts.push(`  override → ${m.value}`);
    }
    if (add !== 0) parts.push(`  add ${add > 0 ? '+' : ''}${add}`);
    if (mul !== 0) parts.push(`  mul ${mul > 0 ? '+' : ''}${(mul * 100).toFixed(0)}%`);
    parts.push(`  = ${this.get(id)}`);
    return parts.join('\n');
  }

  // ── 变化通知 ──

  /** 订阅变化（返回取消函数） */
  onChange(fn: (c: AttributeChange) => void): () => void {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  /**
   * 批量修改时挂起通知，结束后一次性汇总
   *
   * 【为什么需要】
   * 穿一套 6 件装备会触发 6 次通知，UI 重绘 6 次。
   */
  suspendNotify(): void {
    this._notifySuspended = true;
  }

  resumeNotify(): void {
    this._notifySuspended = false;
    if (this._pendingChanges.length > 0) {
      const pending = this._pendingChanges;
      this._pendingChanges = [];
      // 同一个属性只发最后一次
      const uniq = new Map<string, AttributeChange>();
      for (const c of pending) uniq.set(c.attr, c);
      for (const c of uniq.values()) this._emit(c);
    }
  }

  private _bump(): void {
    this._version++;
    this._cachedVersion = -1;
  }

  private _notifyIf(attr: string, oldValue: number): void {
    const nv = this.get(attr);
    if (nv === oldValue) return;
    const change: AttributeChange = { attr, oldValue, newValue: nv };
    if (this._notifySuspended) this._pendingChanges.push(change);
    else this._emit(change);
  }

  private _emit(c: AttributeChange): void {
    for (const fn of this._listeners) fn(c);
  }

  /** 释放资源 */
  destroy(): void {
    this._defs.clear();
    this._base.clear();
    this._mods.clear();
    this._cache.clear();
    this._listeners.length = 0;
    this._pendingChanges.length = 0;
  }
}

/**
 * 方便函数：把一组修正器按属性分组统计（UI 展示"装备提供了多少攻击力"）
 */
export function summarizeModifiers(
  ms: readonly AttributeModifier[],
): Record<string, { add: number; mul: number; override: number | null }> {
  const out: Record<string, { add: number; mul: number; override: number | null }> = {};
  for (const m of ms) {
    const e = (out[m.attr] ??= { add: 0, mul: 0, override: null });
    if (m.type === 'add') e.add += m.value;
    else if (m.type === 'mul') e.mul += m.value;
    else e.override = m.value;
  }
  return out;
}
