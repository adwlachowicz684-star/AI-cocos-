/**
 * blessing —— 祝福 / 恩惠系统（局内强化堆叠）
 *
 * 【它解决什么】
 *
 * 肉鸽里有一类强化是**可叠加、无上限**的：
 *
 * ```
 * 「锐利」攻击 +2  —— 可以拿 5 次，变成 +10
 * 「迅捷」移速 +5% —— 可以拿 3 次
 * ```
 *
 * 它和遗物（affix 词条）的区别：
 *
 * | | 祝福 blessing | 遗物 relic |
 * |---|---|---|
 * | 重复获得 | **可以**，堆叠 | 通常不行（唯一） |
 * | 负面 | 通常没有 | 常有代价 |
 * | 展示 | 一个图标 + 层数 | 各自独立图标 |
 * | 移除 | 一般不移除 | 可以被替换/献祭 |
 *
 * 【三个必须处理的真实问题】
 *
 * 1. **堆叠上限**：没有上限的话，玩家拿了 50 层就无敌了
 * 2. **递减**：线性叠加到 20 层时数值会失控，需要软上限
 * 3. **冲突**："火焰附魔" 和 "冰霜附魔" 能同时存在吗？
 *
 * 【无引擎依赖】
 */

import { numOr } from '../_core/math';

// ==================== 类型 ====================

/** 祝福的效果运算 */
export type BlessingOp = 'add' | 'mul' | 'set';

export interface BlessingEffect {
  readonly stat: string;
  readonly op: BlessingOp;
  /** 每层的数值 */
  readonly perStack: number;
}

export interface BlessingDef {
  readonly id: string;
  readonly name: string;
  /** 效果（按层数乘算） */
  readonly effects: readonly BlessingEffect[];
  /** 堆叠上限（默认无限） */
  readonly maxStacks?: number;
  /**
   * 递减：超过 softCap 后，超出的部分按 falloff 折算
   *
   * ```
   * softCap=5, falloff=0.5, 拿了 8 层
   * 有效层数 = 5 + (8-5) × 0.5 = 6.5
   * ```
   *
   * 【为什么需要】
   * 线性叠加下，20 层的强度是 1 层的 20 倍，
   * 数值曲线会彻底失控。
   * 递减让"多拿"仍然有用，但不再是指数爆炸。
   */
  readonly softCap?: number;
  readonly falloff?: number;
  /** 与哪些祝福互斥 */
  readonly excludes?: readonly string[];
  /** 互斥时的处理（默认 'priority'） */
  readonly desc?: string;
  /** 优先级（互斥判定与展示排序用） */
  readonly priority?: number;
  /** 稀有度（用于抽取权重） */
  readonly rarity?: string;
  /** 权重（抽取用） */
  readonly weight?: number;
  /** 标签（用于条件筛选） */
  readonly tags?: readonly string[];
}

export interface BlessingSystemOptions {
  readonly defs: readonly BlessingDef[];
  /** 效果变化时回调（刷新 UI） */
  readonly onChange?: (id: string, stacks: number) => void;
  /** 互斥时的处理 */
  readonly onConflict?: 'reject' | 'replace' | 'coexist';
}

/** 已持有的一个祝福 */
export interface BlessingStack {
  readonly def: BlessingDef;
  readonly stacks: number;
  /** 递减后的有效层数 */
  readonly effective: number;
}

// ==================== 实现 ====================

export class BlessingSystem {
  private readonly _defs = new Map<string, BlessingDef>();
  private readonly _stacks = new Map<string, number>();
  private readonly _onChange?: (id: string, stacks: number) => void;
  private readonly _onConflict: 'reject' | 'replace' | 'coexist';

  constructor(opts: BlessingSystemOptions) {
    this._onChange = opts.onChange;
    this._onConflict = opts.onConflict ?? 'reject';

    for (const d of opts.defs) {
      if (this._defs.has(d.id)) throw new Error(`[Blessing] 祝福 id 重复：${d.id}`);
      this._validate(d);
      this._defs.set(d.id, d);
    }
  }

  private _validate(d: BlessingDef): void {
    if (d.effects.length === 0) {
      throw new Error(`[Blessing] 祝福 "${d.id}" 没有任何效果`);
    }
    if (d.maxStacks !== undefined && (!Number.isInteger(d.maxStacks) || d.maxStacks < 1)) {
      throw new Error(`[Blessing] 祝福 "${d.id}" 的 maxStacks 必须是正整数`);
    }
    if (d.softCap !== undefined && d.falloff === undefined) {
      /**
       * 【⚠️ 这里原本是一个空 if】
       *
       * 检测到了"给了 softCap 却没给 falloff"，然后什么都不做：
       * 实际行为由 `effectiveStacks` 里的 `falloff ?? 0.5` 悄悄决定。
       * 实测：softCap=3、8 层 → effective = 5.5（按 0.5 折算）。
       *
       * 数值是对的，但**配表的人不知道自己触发了一个隐式默认值**，
       * 于是"我明明配了 softCap=3，为什么 8 层只有 5.5 的效果"变成一个
       * 没有入口可查的问题——链路上每一处单独看都成立。
       *
       * 不抛错（配表疏忽不该让游戏起不来，这点原注释是对的），
       * 但必须让人看见。
       */
      console.warn(
        `[Blessing] 祝福 "${d.id}" 给了 softCap=${d.softCap} 但没有 falloff，` +
        `超过 softCap 的部分将按 0.5 折算（显式写 falloff 可消除此告警）`
      );
    }
    for (const e of d.effects) {
      if (!Number.isFinite(e.perStack)) {
        throw new Error(`[Blessing] 祝福 "${d.id}" 的 ${e.stat} 每层数不是有限数字`);
      }
    }
  }

  get all(): BlessingDef[] {
    return [...this._defs.values()];
  }

  def(id: string): BlessingDef | undefined {
    return this._defs.get(id);
  }

  // ==================== 获得 / 移除 ====================

  /**
   * 获得一层祝福
   *
   * @returns 实际增加的层数（0 = 满了或被拒）
   */
  add(id: string, n = 1): number {
    const def = this._defs.get(id);
    if (!def) {
      throw new Error(
        `[Blessing] 未定义的祝福：${id}（已定义：${[...this._defs.keys()].join(', ')}）`
      );
    }

    // ① 互斥检查
    const conflict = this._findConflict(def);
    if (conflict) {
      if (this._onConflict === 'reject') return 0;
      if (this._onConflict === 'replace') this.remove(conflict);
      // coexist：什么都不做
    }

    /**
     * 【⚠️ NaN 层数会污染整条属性链路，且全程不报错】
     *
     * 原写法 `Math.min(n, cap - cur)`：`n = NaN` 时 `Math.min(NaN, x)` = NaN，
     * 于是 `actual <= 0` 为 false（NaN 比较恒 false）→ 直接写进 `_stacks`。
     * 实测（修复前）：`add(b, NaN)` 后 stacks = NaN、effectiveStacks = NaN、
     * `effectsOf` 给出 `perStack * NaN` = NaN —— 玩家属性直接变 NaN。
     *
     * 【为什么也 floor】层数是整数语义；`add(b, 2.5)` 会留下 0.5 层的
     * "看不见的残片"，在 UI 上显示 3 层却按 2.5 层算伤害。
     */
    const k = this._safeCount(n);
    const cur = this._stacks.get(id) ?? 0;
    const cap = def.maxStacks ?? Infinity;
    const actual = Math.min(k, Math.max(0, cap - cur));
    // 【模式 A】肯定式：NaN 进来 k = 0，这里也能拦住
    if (!(actual > 0)) return 0;

    this._stacks.set(id, cur + actual);
    this._onChange?.(id, cur + actual);
    return actual;
  }

  /** 移除若干层（到 0 则删除） */
  remove(id: string, n = Infinity): number {
    const cur = this._stacks.get(id) ?? 0;
    if (cur === 0) return 0;
    /**
     * 【⚠️ 负数参数让 remove 变成 add】
     *
     * 原写法 `Math.min(cur, n)`：n = -5 时 actual = -5，
     * `next = cur - (-5)` = cur + 5 —— **移除变成了加层**。
     * 实测（修复前）：add 3 层后 `remove(b, -5)` → stacks = **8**。
     *
     * 这个坑之所以危险，是因为调用方最常见的写法就是算差值：
     * `remove(id, cur - target)`，target > cur 时差值为负，
     * 于是"想削到 3 层"变成"加到 8 层"，方向完全相反。
     */
    const k = this._safeCount(n);
    const actual = Math.min(cur, k);
    // 【模式 A】actual 为 0/负数/NaN 都不该走下去：
    // 既不改状态，也不该触发一次"没变化"的 onChange。
    if (!(actual > 0)) return 0;
    const next = cur - actual;
    if (next <= 0) this._stacks.delete(id);
    else this._stacks.set(id, next);
    this._onChange?.(id, next);
    return actual;
  }

  /**
   * 层数参数收口：非有限 → 0，负数 → 0，小数 → 向下取整
   *
   * 【⚠️ 为什么 `Infinity` 要单独放行】
   * `remove(id)` 的默认参数是 `Infinity`，语义是"全部移除"。
   * `numOr` 会把非有限值（含 Infinity）兜成 fallback，
   * 一刀切地收口会让 `remove(id)` 变成"什么都不做"——
   * 用兜底工具的时候必须先看清楚默认参数本身是不是一个合法哨兵值。
   */
  private _safeCount(n: number): number {
    if (n === Infinity) return Infinity;
    return Math.max(0, Math.floor(numOr(n, 0)));
  }

  /** 清空（死亡 / 开新局） */
  clear(): void {
    const ids = [...this._stacks.keys()];
    this._stacks.clear();
    for (const id of ids) this._onChange?.(id, 0);
  }

  stacks(id: string): number {
    return this._stacks.get(id) ?? 0;
  }

  has(id: string): boolean {
    return this._stacks.has(id);
  }

  get count(): number {
    return this._stacks.size;
  }

  // ==================== 计算 ====================

  /**
   * 递减后的有效层数
   *
   * ```
   * softCap=5, falloff=0.5
   *   3 层 → 3
   *   8 层 → 5 + 3×0.5 = 6.5
   *  20 层 → 5 + 15×0.5 = 12.5
   * ```
   */
  effectiveStacks(id: string): number {
    const def = this._defs.get(id);
    const n = this._stacks.get(id);
    if (!def || n === undefined) return 0;

    const cap = def.softCap;
    if (cap === undefined || n <= cap) return n;

    const falloff = def.falloff ?? 0.5;
    return cap + (n - cap) * falloff;
  }

  /**
   * 某祝福当前提供的效果
   *
   * 【返回原始效果列表，不预先合并】
   * 理由同 setbonus：属性系统的合并顺序由它自己决定。
   */
  effectsOf(id: string): StatEffect[] {
    const def = this._defs.get(id);
    const eff = this.effectiveStacks(id);
    if (!def || eff === 0) return [];

    return def.effects.map((e) => ({
      stat: e.stat,
      op: e.op,
      /**
       * 【⚠️ `set` 曾被当成 `add` 一样按层数缩放】
       *
       * `set` 的语义是"覆盖为固定值"，与层数无关。
       * 修复前它走 `perStack * eff`：
       * 实测 2 层的 "set maxHp 100" 给出 **200**，5 层就是 500。
       *
       * 这个 bug 不会崩、也不会报 NaN，只是"血上限比配表高了一截"，
       * 于是平衡表对不上、QA 复现不出来。
       * `curse` / `meta` 是同款写法（见报告"跨单元共性问题"）。
       */
      value: e.op === 'set' ? e.perStack : e.op === 'mul' ? Math.pow(e.perStack, eff) : e.perStack * eff,
    }));
  }

  /** 全部效果 */
  effects(): StatEffect[] {
    const out: StatEffect[] = [];
    for (const id of this._stacks.keys()) out.push(...this.effectsOf(id));
    return out;
  }

  /** 按属性聚合（快速查看用） */
  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.effects()) {
      const k = `${e.stat}.${e.op}`;
      if (e.op === 'mul') out[k] = (out[k] ?? 1) * e.value;
      else if (e.op === 'add') out[k] = (out[k] ?? 0) + e.value;
      else out[k] = e.value;
    }
    return out;
  }

  /** 已持有的列表（按优先级、层数排序） */
  owned(): BlessingStack[] {
    const out: BlessingStack[] = [];
    for (const [id, n] of this._stacks) {
      const def = this._defs.get(id);
      if (!def) continue;   // 存档里有但配置里删了：跳过
      out.push({ def, stacks: n, effective: this.effectiveStacks(id) });
    }
    return out.sort(
      (a, b) => (b.def.priority ?? 0) - (a.def.priority ?? 0) || b.stacks - a.stacks
    );
  }

  // ==================== 互斥 ====================

  private _findConflict(def: BlessingDef): string | null {
    for (const id of this._stacks.keys()) {
      const other = this._defs.get(id);
      if (!other) continue;
      // 双向：任一方排斥对方都算冲突
      if (def.excludes?.includes(id)) return id;
      if (other.excludes?.includes(def.id)) return id;
    }
    return null;
  }

  /**
   * 查询：现在拿这个祝福会不会冲突
   *
   * 【⚠️ 曾经的 bug：互斥只在"声明方后加入"时生效】
   *
   * 原实现开头有一句 early return：
   * ```typescript
   * if (!def.excludes || def.excludes.length === 0) return null;
   * ```
   *
   * 于是：
   *   a.excludes = ['b']（a 排斥 b）
   *   先 add('a') 再 add('b') → b 没有 excludes → 直接返回 null → **共存了**
   *   先 add('b') 再 add('a') → a 有 excludes → 正确拒绝
   *
   * **同一个配置，换个添加顺序结果就不同。**
   * 这类 bug 极难发现：配表的人写的是"a 和 b 互斥"，
   * 他不会想到这还取决于玩家先拿到哪个。
   *
   * 修法：去掉 early return，双向检查。
   * 与 `skill-variant` 里的互斥判定保持一致。
   */
  wouldConflict(id: string): string | null {
    const def = this._defs.get(id);
    if (!def) return null;
    return this._findConflict(def);
  }

  // ==================== 抽取 ====================

  /**
   * 加权抽取（三选一用这个）
   *
   * 【为什么自己实现而不依赖 Chest】
   * 这里需要"已满层的不再出现"这个筛选，
   * 直接用 Chest 的话要在外部先过滤，反而啰嗦。
   */
  pick(rng: { next(): number }, n: number, filter?: (d: BlessingDef) => boolean): BlessingDef[] {
    let pool = this.all.filter((d) => {
      if (this.stacks(d.id) >= (d.maxStacks ?? Infinity)) return false;
      if (this.wouldConflict(d.id)) return false;
      return filter ? filter(d) : true;
    });

    const out: BlessingDef[] = [];
    for (let k = 0; k < n; k++) {
      if (pool.length === 0) break;

      let total = 0;
      // 【模式 B】`?? 1` 只挡 null/undefined，NaN 权重会让 total 变 NaN，
      // 于是 `total <= 0` 为 false（NaN 比较恒 false），循环里 `r -= NaN`
      // 让 `r < 0` 也恒为 false → idx 停在 pool.length - 1 →
      // **永远抽池子最后一个**，权重表静默失效。与 affix 同源。
      for (const d of pool) total += Math.max(0, numOr(d.weight ?? 1, 0));
      if (total <= 0) break;

      let r = rng.next() * total;
      let idx = pool.length - 1;
      for (let j = 0; j < pool.length; j++) {
        r -= Math.max(0, numOr(pool[j].weight ?? 1, 0));
        if (r < 0) { idx = j; break; }
      }

      out.push(pool[idx]);
      pool = pool.filter((_, i) => i !== idx);
    }
    return out;
  }

  // ==================== 存档 ====================

  exportState(): Record<string, number> {
    return Object.fromEntries(this._stacks);
  }

  importState(s: Readonly<Record<string, number>>): void {
    // 记下导入前持有哪些，用于给"导入后消失的"补一次 0 通知
    const before = [...this._stacks.keys()];
    this._stacks.clear();
    for (const [id, n] of Object.entries(s)) {
      /**
       * 【容错】
       * 存档里的祝福在配置中被删了 → 跳过，不报错。
       * 玩家不该因为一次版本更新就开不了档。
       */
      if (!this._defs.has(id)) continue;
      const cap = this._defs.get(id)!.maxStacks ?? Infinity;
      /**
       * 【⚠️ 存档是外部输入，且原实现完全不校验】
       *
       * `Math.min(n, cap)` 对 -3 和 NaN 都照单全收：
       * 实测（修复前）`importState({ b: -3 })` → stacks = **-3**；
       * `importState({ b: NaN })` → stacks = NaN → effectiveStacks = NaN。
       * 篡改过的存档或版本迁移的残留字段能写进任何值，
       * 进来的 NaN 与 `add(b, NaN)` 是同一条污染链路（只是更难查——
       * 因为"我什么都没操作，一读档属性就 NaN 了"）。
       *
       * 走与 `add` / `remove` 相同的收口：非有限 → 0，负数 → 0。
       */
      this._stacks.set(id, Math.min(this._safeCount(n), cap));
    }

    /**
     * 【⚠️ 导入后不通知，UI 会一直显示旧层数】
     *
     * 实测（修复前）：`importState({ b: 4 })` 之后 onChange **一次都没触发**。
     * 读档后数据是对的，但 UI 停留在读档前的画面，
     * 直到玩家下一次拾取才突然"补上"——表现为"读档后属性没生效"。
     *
     * 对 before ∪ after 全量通知一次：新增的报新值、消失的报 0。
     */
    for (const id of new Set([...before, ...this._stacks.keys()])) {
      this._onChange?.(id, this._stacks.get(id) ?? 0);
    }
  }

  // ==================== 调试 ====================

  describe(): string {
    const owned = this.owned();
    if (owned.length === 0) return 'Blessing（空）';
    const lines = [`Blessing（${owned.length} 种）`];
    for (const b of owned) {
      const cap = b.def.maxStacks;
      const capStr = cap === undefined ? '' : `/${cap}`;
      const dim = b.def.softCap !== undefined && b.stacks > b.def.softCap
        ? `  有效 ${b.effective.toFixed(1)}（递减）`
        : '';
      lines.push(`  ${b.def.name.padEnd(10)} ×${b.stacks}${capStr}${dim}`);
      for (const e of this.effectsOf(b.def.id)) {
        lines.push(`      ${e.stat} ${e.op} ${e.value.toFixed(2)}`);
      }
    }
    return lines.join('\n');
  }
}

/** 与 setbonus 相同的效果结构（刻意保持一致） */
export interface StatEffect {
  readonly stat: string;
  readonly op: BlessingOp;
  readonly value: number;
}
