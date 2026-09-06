/**
 * Modifier —— 数值修正框架
 *
 * 【它解决什么问题】
 * 同一个属性（比如攻击力）可能被很多来源修改：基础值、装备、buff、遗物、难度加成。
 * 如果每个来源各自去改那个数字，它们会互相打架：
 * - buff 到期时要减回去，但期间装备换了，减多少？
 * - 两个 +20% 是加算（+40%）还是乘算（+44%）？
 * - 顺序不同结果不同，谁来定？
 *
 * Modifier 的做法：**基础值不变，所有修改都是「描述」而不是「写入」**。
 * 最终值在需要时统一计算。
 *
 * 【运算顺序】`(base + Σadd) × (1 + Σmul)`，然后 override 覆盖一切。
 *
 * 【为什么必须先明确顺序】
 * `(base × Πmul) + Σadd` 结果完全不同。团队里两人理解不同，数值就会对不上。
 * 这个顺序在单测里锁死，谁改谁负责。
 *
 * 【使用示例】
 * ```typescript
 * const mod = new ModifierSet();
 * mod.add('atk', { type: 'add', value: 5, source: 'weapon' });
 * mod.add('atk', { type: 'mul', value: 0.2, source: 'relic', tag: 'relic' });
 * mod.get('atk', 10);        // (10 + 5) * 1.2 = 18
 * mod.clearByTag('relic');   // buff 到期时批量清理
 * ```
 */

/** 修正类型 */
export type ModifierType = 'add' | 'mul' | 'override';

export interface ModifierEntry {
  readonly type: ModifierType;
  readonly value: number;
  /** 来源标识（'weapon' / 'buff_burn' / 'relic_03'），便于追溯与去重 */
  readonly source?: string;
  /**
   * 分组标签。**每个 modifier 都应该有 tag**——
   * 否则 buff 到期时你无法批量清理它加的所有东西。
   */
  readonly tag?: string;
}

export class ModifierSet {
  /** attr -> entries */
  private readonly _map = new Map<string, ModifierEntry[]>();

  /**
   * 脏标记：只在变化时重算
   *
   * 【坑】如果每次 get 都遍历全部 modifier，属性多的时候会明显掉帧。
   * 用脏标记，get 命中缓存时是 O(1)。
   */
  private readonly _cache = new Map<string, number>();
  private readonly _dirty = new Set<string>();

  add(attr: string, entry: ModifierEntry): void {
    let list = this._map.get(attr);
    if (!list) {
      list = [];
      this._map.set(attr, list);
    }
    list.push(entry);
    this._dirty.add(attr);
  }

  /**
   * 移除
   *
   * 【坑】必须用引用或 source 精确定位，不能"移除第一个匹配的"。
   * 加了两次同样的 modifier，移除时应该移除指定的那一个。
   */
  remove(attr: string, predicate: (e: ModifierEntry) => boolean): number {
    const list = this._map.get(attr);
    if (!list) return 0;

    let removed = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (predicate(list[i])) {
        list.splice(i, 1);
        removed++;
      }
    }
    if (removed > 0) this._dirty.add(attr);
    return removed;
  }

  removeBySource(attr: string, source: string): number {
    return this.remove(attr, (e) => e.source === source);
  }

  /** 按 tag 清理某个属性的修正（buff 到期用） */
  clearByTag(attr: string, tag: string): number {
    return this.remove(attr, (e) => e.tag === tag);
  }

  /** 按 tag 清理所有属性的修正 */
  clearTagEverywhere(tag: string): void {
    for (const attr of this._map.keys()) this.clearByTag(attr, tag);
  }

  /**
   * 计算最终值
   *
   * @param attr 属性名
   * @param base 基础值
   *
   * 【护甲类属性不要用这个公式】
   * 护甲应该用除法公式 `dmg * 100/(100+armor)`，见 DamagePipeline。
   * 这里的 mul 是"倍率"，不是"护甲点数"。
   */
  get(attr: string, base: number): number {
    if (!this._dirty.has(attr)) {
      const cached = this._cache.get(attr);
      if (cached !== undefined && cached !== Number.NaN && this._baseMatch(attr, base)) {
        return cached;
      }
    }
    return this._compute(attr, base);
  }

  // 缓存需要同时记住当时用的 base，否则 base 变了会返回旧值
  private readonly _baseCache = new Map<string, number>();
  private _baseMatch(attr: string, base: number): boolean {
    return this._baseCache.get(attr) === base;
  }

  private _compute(attr: string, base: number): number {
    const list = this._map.get(attr);
    let value = base;

    if (list && list.length > 0) {
      let add = 0;
      let mul = 1;
      let override: number | null = null;

      for (const e of list) {
        switch (e.type) {
          case 'add':
            add += e.value;
            break;
          case 'mul':
            mul += e.value; // 加成累加：两个 +20% = +40%
            break;
          case 'override':
            // 多个 override 取最后一个（后来的覆盖先来的）
            override = e.value;
            break;
        }
      }

      value = override !== null ? override : (base + add) * mul;
    }

    this._cache.set(attr, value);
    this._baseCache.set(attr, base);
    this._dirty.delete(attr);
    return value;
  }

  /** 该属性当前的修正来源数（调试用） */
  count(attr: string): number {
    return this._map.get(attr)?.length ?? 0;
  }

  /** 导出某个属性的全部修正（存档用——只存 modifier，最终值可重算） */
  dump(attr: string): readonly ModifierEntry[] {
    return this._map.get(attr) ?? [];
  }

  clear(attr?: string): void {
    if (attr === undefined) {
      this._map.clear();
      this._cache.clear();
      this._baseCache.clear();
      this._dirty.clear();
    } else {
      this._map.delete(attr);
      this._cache.delete(attr);
      this._baseCache.delete(attr);
      this._dirty.delete(attr);
    }
  }

  destroy(): void {
    this.clear();
  }
}
