/**
 * Chest —— 开箱 / 三选一
 *
 * 【它解决什么】
 * 肉鸽的奖励界面（三选一）是这类游戏的**乐趣本体**，
 * 但它的状态管理比你想象的麻烦：
 * - 选过的不该再出现
 * - reroll 要排除当前选项
 * - reroll 次数用完了要禁用按钮
 * - 关闭界面再打开，应该还是那三个选项（不能刷新）
 * - 已拥有的遗物要不要重复出现？
 *
 * 把这些逻辑散落在 UI 代码里，很快就会变成 bug 温床。
 *
 * 【设计：纯逻辑 + 无状态 UI】
 * 本类只管"该给玩家看哪几个、选了会怎样"，
 * 不含任何渲染代码。UI 只负责画 `current` 里的东西。
 *
 * 【关于权重】
 * 默认**等概率**。肉鸽里这不可接受——稀有遗物和普通遗物不该一样常见。
 * 传 `weightOf` 开启加权抽取：
 *
 * ```typescript
 * new Chest(relics, { weightOf: (r) => RARITY_WEIGHT[r.rarity] });
 * ```
 *
 * 详见 README 的「加权抽取」一节，特别是**加权不放回的分布与独立抽取不同**这一点。
 *
 * 【使用示例】
 * ```typescript
 * const chest = new Chest(relicPool, { count: 3, allowDuplicate: false });
 *
 * // 打开奖励界面
 * chest.roll(rng);
 * chest.current;      // [遗物A, 遗物C, 遗物F]
 *
 * // 玩家 reroll
 * chest.reroll(rng);  // 换了三个，且不含刚才那三个
 * chest.canReroll;    // false（次数用完）
 *
 * // 玩家选了第 2 个
 * const picked = chest.take(1);
 * chest.state;        // 'taken'
 *
 * // 存档
 * chest.exportState();
 * ```
 *
 * 【无引擎依赖】随机源通过 IRandomSource 注入。
 */

import { IRandomSource } from '../_core/types';

export type ChestState = 'idle' | 'rolled' | 'taken';

export interface ChestOptions<T> {
  /** 一次给出几个选项（默认 3） */
  readonly count?: number;
  /**
   * 是否允许同一批里出现重复项
   * 【注意】这是"同一批内"的去重，不是"跨批次"。
   * 跨批次的已获得列表用 `owned` 管理。
   */
  readonly allowDuplicate?: boolean;
  /** reroll 次数上限（默认 1） */
  readonly rerolls?: number;
  /**
   * 已拥有的项（会被排除）
   * 【典型用法】已经拿过的唯一遗物不再出现
   *
   * 【⚠️ 必须是可写数组】
   * `addOwned()` 会往这个数组里 push。
   * 这里**曾经声明为 `readonly T[]`**，然后内部用 `as T[]` 强转再 push——
   * 类型说"我不会改"，实现却在改。传真的只读数组（`as const` / `Object.freeze`）
   * 会在运行时崩，而编译器一声不吭。
   *
   * 改成 `T[]` 之后，传只读数组是**编译期报错**——
   * 运行时崩溃提前到编译时，这是修它的全部理由。
   */
  owned?: T[];
  /**
   * 过滤器：返回 false 的项永不出现
   * 【典型用法】"只在血量低于 30% 时才出现这个遗物"
   */
  readonly filter?: (item: T) => boolean;
  /**
   * 权重函数（默认全部为 1，即等概率）
   *
   * 【返回 0 意味着永不出现】
   * 和 `filter` 的区别在于：权重可以在运行时变化。
   * 例：已持有的遗物权重减半，而不是完全排除。
   *
   * 【负数会被当作 0】
   * 不抛错——配置里偶尔出现负权重时，
   * 静默当作 0 比让整个奖励界面崩掉好。
   * 但**全为 0 时会退化为等概率**，见 `_pickIndices` 里的说明。
   */
  readonly weightOf?: (item: T) => number;
}

export interface ChestSnapshot {
  readonly state: ChestState;
  readonly current: number[]; // 索引（便于存档）
  readonly rerollsLeft: number;
  readonly takenIndex: number;
}

export class Chest<T> {
  private readonly _options: ChestOptions<T>;
  private readonly _items: readonly T[];

  private _state: ChestState = 'idle';
  private _current: T[] = [];
  private _currentIndices: number[] = [];
  private _rerollsLeft: number;
  private _takenIndex = -1;

  constructor(items: readonly T[], opts: ChestOptions<T> = {}) {
    this._items = items;
    this._options = opts;
    this._rerollsLeft = opts.rerolls ?? 1;
  }

  get state(): ChestState {
    return this._state;
  }

  /** 当前展示的选项（UI 直接渲染这个） */
  get current(): readonly T[] {
    return this._current;
  }

  get rerollsLeft(): number {
    return this._rerollsLeft;
  }

  get canReroll(): boolean {
    return this._state === 'rolled' && this._rerollsLeft > 0;
  }

  get taken(): T | undefined {
    return this._takenIndex >= 0 ? this._current[this._takenIndex] : undefined;
  }

  /**
   * 掷出选项
   *
   * 【坑】重复调用会**刷新**选项。
   * 如果玩家关掉界面再打开，你不希望选项变了——
   * 所以应该只在 state === 'idle' 时调用，或先检查 state。
   */
  roll(rng: IRandomSource): readonly T[] {
    this._currentIndices = this._pickIndices(rng, []);
    this._applyIndices();
    this._state = 'rolled';
    this._takenIndex = -1;
    return this._current;
  }

  /**
   * 重掷（排除当前选项）
   *
   * 【为什么排除当前的】
   * 如果 reroll 可能给出和之前一样的组合，玩家会觉得"白花了 reroll"。
   * 排除当前项能保证「每一次 reroll 都有实际变化」。
   */
  reroll(rng: IRandomSource): boolean {
    if (!this.canReroll) return false;

    const exclude = this._currentIndices.slice();
    this._rerollsLeft--;
    this._currentIndices = this._pickIndices(rng, exclude);
    this._applyIndices();
    return true;
  }

  /** 选择第 index 个 */
  take(index: number): T | undefined {
    if (this._state !== 'rolled') return undefined;
    if (index < 0 || index >= this._current.length) return undefined;
    this._takenIndex = index;
    this._state = 'taken';
    return this._current[index];
  }

  /** 重置（开启下一个宝箱时） */
  reset(): void {
    this._state = 'idle';
    this._current = [];
    this._currentIndices = [];
    this._takenIndex = -1;
    this._rerollsLeft = this._options.rerolls ?? 1;
  }

  /** 更新已拥有列表（拿到新遗物后调用） */
  addOwned(item: T): void {
    if (!this._options.owned) return;
    this._options.owned.push(item);
  }

  // ==================== 存档 ====================

  /**
   * 导出状态（索引形式，便于存档）
   *
   * 【为什么存索引而不是值】
   * 值可能是复杂对象，序列化后体积大且版本迁移麻烦。
   * 存索引的前提是**池子顺序稳定**——
   * 如果池子顺序会变（比如动态增删），请自行改用 id。
   */
  exportState(): ChestSnapshot {
    return {
      state: this._state,
      current: this._currentIndices.slice(),
      rerollsLeft: this._rerollsLeft,
      takenIndex: this._takenIndex,
    };
  }

  /** 恢复状态（读档后 UI 能显示"上次没选完的宝箱"） */
  importState(snap: ChestSnapshot): void {
    this._state = snap.state;
    this._rerollsLeft = snap.rerollsLeft;
    this._takenIndex = snap.takenIndex;
    this._currentIndices = snap.current.slice();
    this._applyIndices();
  }

  // ==================== 内部 ====================

  private _applyIndices(): void {
    this._current = this._currentIndices.map((i) => this._items[i]);
  }

  private _pickIndices(rng: IRandomSource, exclude: readonly number[]): number[] {
    const owned = this._options.owned;
    const filter = this._options.filter;
    const excludeSet = new Set(exclude);

    // ① 收集候选
    const candidates: number[] = [];
    for (let i = 0; i < this._items.length; i++) {
      if (excludeSet.has(i)) continue;
      if (owned && owned.includes(this._items[i])) continue;
      if (filter && !filter(this._items[i])) continue;
      candidates.push(i);
    }

    /**
     * ② 候选不足时怎么办
     *
     * 【设计选择】放宽排除条件，而不是少给几个选项。
     * 三选一变成二选一会让玩家觉得"是不是出 bug 了"；
     * 而重新出现一个已拥有的（如果是可叠加的）通常可以接受。
     *
     * 如果没有 owned/filter 限制，就放宽"排除当前项"的限制。
     */
    let pool = candidates;
    if (pool.length < this._count) {
      const relaxed: number[] = [];
      for (let i = 0; i < this._items.length; i++) {
        if (owned && owned.includes(this._items[i])) continue;
        if (filter && !filter(this._items[i])) continue;
        relaxed.push(i);
      }
      pool = relaxed.length > 0 ? relaxed : this._items.map((_, i) => i);
    }

    // ③ 不放回抽取（加权）
    const weightOf = this._options.weightOf;
    const work = pool.slice();
    const out: number[] = [];
    const n = Math.min(this._count, this._options.allowDuplicate ? this._count : work.length);

    for (let k = 0; k < n; k++) {
      if (work.length === 0) break;

      let idx: number;
      if (!weightOf) {
        // 无权重：等概率（与原实现一致）
        idx = Math.floor(rng.next() * work.length);
      } else {
        idx = this._weightedIndex(work, weightOf, rng);
      }

      out.push(work[idx]);
      if (!this._options.allowDuplicate) work.splice(idx, 1);
    }
    return out;
  }

  /**
   * 按权重取一个下标
   *
   * 【为什么每轮都重新算总权重】
   * 不放回抽取时，已选中的项被移出，剩余项的总权重变了。
   * 缓存总权重会导致第二次抽取的概率失真。
   *
   * 【⚠️ 曾经的隐患：浮点误差导致越界】
   * `r = rng.next() * total` 时，若 rng.next() 返回接近 1 的值，
   * 累加权重后的浮点误差可能让 `r` 略大于所有权重之和，
   * 循环结束都没命中 → idx 停在初始值。
   *
   * 所以这里的兜底必须是**最后一个**（而不是 0 或 -1）：
   * 取最后一个至少是池子里的合法项，取 -1 会直接崩溃，
   * 取 0 则会让第一个候选被莫名其妙地偏爱。
   *
   * 【⚠️ 全零权重要退化，不能返回空】
   * 所有项权重都是 0 时（配置写错、或条件性全部为 0），
   * 如果直接返回 -1，玩家会看到「奖励界面空白」。
   * 退化为等概率，至少游戏还能继续，同时这是个值得排查的配置错误。
   */
  private _weightedIndex(
    work: readonly number[],
    weightOf: (item: T) => number,
    rng: IRandomSource
  ): number {
    let total = 0;
    for (const i of work) {
      const w = weightOf(this._items[i]);
      if (w > 0) total += w;
    }

    if (total <= 0) {
      // 全为 0（或负数）：退化为等概率，至少界面不会空白
      return Math.floor(rng.next() * work.length);
    }

    let r = rng.next() * total;
    for (let j = 0; j < work.length; j++) {
      const w = weightOf(this._items[work[j]]);
      if (w > 0) {
        r -= w;
        if (r < 0) return j;
      }
    }
    // 浮点误差兜底：取最后一个合法项
    return work.length - 1;
  }

  private get _count(): number {
    return Math.max(1, this._options.count ?? 3);
  }

  destroy(): void {
    this._current = [];
    this._currentIndices = [];
  }
}
