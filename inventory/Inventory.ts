import { numOr } from '../_core/math';
/**
 * Inventory —— 背包与物品栏
 *
 * 【它解决什么】
 *
 * 背包看起来简单（"就是个数组"），但真做起来有一堆细节：
 * - 同类型物品要堆叠（99 个一组的箭）
 * - 堆叠满了要溢出到新格子
 * - 交换两格（目标格有东西怎么办？合并还是对调？）
 * - 拆分堆叠（拖一半出来）
 * - 有些物品不可堆叠（每件装备都是唯一的）
 * - 排序、整理、找空格、查数量
 * - 改了之后要通知 UI，但 UI 不该知道内部实现
 *
 * 手写这些，每个游戏都要重写一遍，而且每次都会在"交换"的边界情况上出 bug。
 *
 * 【设计：只管数据，不管渲染】
 * 本类是纯数据模型。UI 通过 `onChange` 拿到变更事件去刷新。
 * 它不知道格子画在哪、图标长什么样。
 *
 * 【使用示例】
 * ```typescript
 * const bag = new Inventory({ size: 20 });
 *
 * bag.define({ id: 'arrow', name: '箭', maxStack: 99 });
 * bag.define({ id: 'sword', name: '铁剑', maxStack: 1 });
 *
 * bag.add('arrow', 150);        // 返回 0（全部放入）
 * bag.count('arrow');           // 150
 * bag.add('arrow', 500);        // 返回剩余放不下的数量
 *
 * bag.slots[0];                 // { def, count }
 * bag.swap(0, 1);               // 交换两格
 * bag.split(0, 5);              // 从第 0 格分 5 个出来
 * bag.remove('arrow', 30);      // 移除 30 个（跨格子扣）
 * bag.compact();                // 整理（合并同类堆叠）
 * ```
 *
 * 【无引擎依赖】
 */

export interface ItemDef {
  readonly id: string;
  /**
   * 显示名（或本地化 key）
   *
   * 【为什么放在这里而不是外部查表】
   * 背包 UI 几乎总要显示名字。放在 def 里，
   * UI 渲染时不用再查一次配置表——少一次依赖，也少一处可能不同步。
   */
  readonly name: string;
  /** 最大堆叠数（1 = 不可堆叠） */
  readonly maxStack: number;
  /** 排序权重（compact / sort 用） */
  readonly sortOrder?: number;
  /** 附加数据（品质、等级、词条……由业务决定，本类不关心） */
  readonly data?: unknown;
}

export interface Slot {
  /** 物品定义。null = 空格子 */
  def: ItemDef | null;
  /** 数量。空格子时为 0 */
  count: number;
  /**
   * 该格的附加数据（同一 def 的不同实例，比如两把词缀不同的剑）
   * 【坑】有 data 的格子不参与自动合并
   */
  data?: unknown;
}

export type InventoryChangeKind = 'add' | 'remove' | 'move' | 'swap' | 'split' | 'clear' | 'resize';

export interface InventoryChange {
  readonly kind: InventoryChangeKind;
  /** 受影响的格子下标 */
  readonly slots: readonly number[];
}

export interface InventoryOptions {
  /** 格子数 */
  readonly size: number;
  /**
   * 是否允许同类自动堆叠
   * 【关掉的场景】"格子 = 装备位"这种语义
   */
  readonly autoStack?: boolean;
}

export class Inventory {
  private readonly _slots: Slot[];
  private readonly _defs = new Map<string, ItemDef>();
  private readonly _autoStack: boolean;

  private _onChange: ((c: InventoryChange) => void) | null = null;

  constructor(opts: InventoryOptions) {
    if (opts.size < 1) throw new Error('[Inventory] 至少要 1 个格子');
    this._autoStack = opts.autoStack ?? true;
    this._slots = new Array(opts.size);
    for (let i = 0; i < opts.size; i++) this._slots[i] = { def: null, count: 0 };
  }

  /** 注册物品定义 */
  define(def: ItemDef): this {
    if (def.maxStack < 1) throw new Error(`[Inventory] ${def.id}: maxStack 至少为 1`);
    this._defs.set(def.id, def);
    return this;
  }

  getDef(id: string): ItemDef | undefined {
    return this._defs.get(id);
  }

  get size(): number {
    return this._slots.length;
  }

  get slots(): readonly Slot[] {
    return this._slots;
  }

  /** 已占用的格子数 */
  get usedSlots(): number {
    return this._slots.filter((s) => s.def !== null).length;
  }

  get isFull(): boolean {
    return this._slots.every((s) => s.def !== null);
  }

  get isEmpty(): boolean {
    return this._slots.every((s) => s.def === null);
  }

  /** 第一个空格子的下标（-1 = 满） */
  get firstEmpty(): number {
    return this._slots.findIndex((s) => s.def === null);
  }

  // ==================== 查询 ====================

  /** 某物品的总数量（跨所有格子累加） */
  count(id: string): number {
    let n = 0;
    for (const s of this._slots) if (s.def?.id === id) n += s.count;
    return n;
  }

  /** 某物品占用了几个格子 */
  slotsUsedBy(id: string): number {
    return this._slots.filter((s) => s.def?.id === id).length;
  }

  has(id: string, amount = 1): boolean {
    return this.count(id) >= amount;
  }

  /** 还能再放多少个该物品 */
  remainingSpaceFor(id: string): number {
    const def = this._defs.get(id);
    if (!def) return 0;

    let space = 0;
    for (const s of this._slots) {
      if (s.def === null) space += def.maxStack;
      else if (s.def.id === id && !s.data) space += def.maxStack - s.count;
    }
    return space;
  }

  // ==================== 增删 ====================

  /**
   * 添加物品
   *
   * @returns **放不下的数量**（0 = 全部放入）
   *
   * 【为什么返回剩余而不是布尔】
   * 调用方需要知道"还差多少空间"才能提示玩家，
   * 返回 true/false 会逼你再调一次 remainingSpaceFor。
   */
  add(id: string, amount = 1, data?: unknown): number {
    const def = this._defs.get(id);
    if (!def) throw new Error(`[Inventory] 未注册的物品：${id}`);
    if (amount <= 0) return 0;

    let left = amount;
    const touched: number[] = [];

    // ① 先填已有的同类堆叠
    if (this._autoStack) {
      for (let i = 0; i < this._slots.length && left > 0; i++) {
        const s = this._slots[i];
        if (s.def?.id !== id) continue;
        if (s.data !== undefined || data !== undefined) continue; // 有 data 的不自动合并
        const room = def.maxStack - s.count;
        if (room <= 0) continue;
        const put = Math.min(room, left);
        s.count += put;
        left -= put;
        touched.push(i);
      }
    }

    // ② 再占用空格子
    for (let i = 0; i < this._slots.length && left > 0; i++) {
      const s = this._slots[i];
      if (s.def !== null) continue;
      // 【为什么 numOr 的 fallback 是 left】maxStack 来自物品配置表。
      // 写成 NaN 时 Math.min(NaN, left) === NaN → 格子里的数量变 NaN，
      // 从此这个格子取不出也放不进。退化成"不限制堆叠"是可用的。
      const put = Math.min(numOr(def.maxStack, left), left);
      s.def = def;
      s.count = put;
      if (data !== undefined) s.data = data;
      left -= put;
      touched.push(i);
    }

    if (touched.length > 0) this._emit('add', touched);
    return left;
  }

  /**
   * 移除物品（跨格子扣）
   *
   * @returns 实际移除的数量
   */
  remove(id: string, amount = 1): number {
    if (amount <= 0) return 0;

    let left = amount;
    const touched: number[] = [];

    // 从后往前扣，这样先消耗不满的堆叠，留下整齐的
    for (let i = this._slots.length - 1; i >= 0 && left > 0; i--) {
      const s = this._slots[i];
      if (s.def?.id !== id) continue;
      const take = Math.min(s.count, left);
      s.count -= take;
      left -= take;
      touched.push(i);
      if (s.count === 0) {
        s.def = null;
        delete s.data;
      }
    }

    if (touched.length > 0) this._emit('remove', touched);
    return amount - left;
  }

  /** 移除指定格子的物品（不管是什么） */
  removeAt(index: number, amount = Infinity): Slot | null {
    const s = this._slots[index];
    if (!s || s.def === null) return null;

    const take = amount >= s.count ? s.count : amount;
    s.count -= take;

    const result: Slot = { def: s.def, count: take, ...(s.data !== undefined ? { data: s.data } : {}) };
    if (s.count === 0) {
      s.def = null;
      delete s.data;
    }
    this._emit('remove', [index]);
    return result;
  }

  // ==================== 移动 / 交换 / 拆分 ====================

  /**
   * 移动：把 from 的**全部**内容放到 to
   *
   * 三种情况：
   * 1. to 是空 → 直接搬过去
   * 2. 同类且能装下 → 合并
   * 3. 不同类 / 装不下 → 交换
   *
   * 【为什么第 3 种是交换而不是失败】
   * 玩家拖东西到已占用的格子，期待的是"换位置"。
   * 返回失败会让玩家以为操作没生效。
   */
  move(from: number, to: number): boolean {
    if (from === to) return false;
    const a = this._slots[from];
    const b = this._slots[to];
    if (!a || !b || a.def === null) return false;

    // ① 空格 → 搬过去
    if (b.def === null) {
      b.def = a.def;
      b.count = a.count;
      if (a.data !== undefined) {
        b.data = a.data;
        delete a.data;
      }
      a.def = null;
      a.count = 0;
      this._emit('move', [from, to]);
      return true;
    }

    // ② 同类且可合并
    const canMerge =
      this._autoStack &&
      a.def.id === b.def.id &&
      a.data === undefined &&
      b.data === undefined &&
      b.count < a.def.maxStack;

    if (canMerge) {
      const room = (a.def as ItemDef).maxStack - b.count;
      const put = Math.min(room, a.count);
      b.count += put;
      a.count -= put;
      if (a.count === 0) {
        a.def = null;
        delete a.data;
      }
      this._emit('move', [from, to]);
      return true;
    }

    // ③ 交换
    const tmpDef = b.def;
    const tmpCount = b.count;
    const tmpData = b.data;

    b.def = a.def;
    b.count = a.count;
    if (a.data !== undefined) b.data = a.data;
    else delete b.data;

    a.def = tmpDef;
    a.count = tmpCount;
    if (tmpData !== undefined) a.data = tmpData;
    else delete a.data;

    this._emit('swap', [from, to]);
    return true;
  }

  /** 交换（语义明确的版本，等价于 move 的第三种情况） */
  swap(from: number, to: number): boolean {
    if (from === to) return false;
    const a = this._slots[from];
    const b = this._slots[to];
    if (!a || !b) return false;

    const tmpDef = b.def;
    const tmpCount = b.count;
    const tmpData = b.data;

    b.def = a.def;
    b.count = a.count;
    if (a.data !== undefined) b.data = a.data;
    else delete b.data;

    a.def = tmpDef;
    a.count = tmpCount;
    if (tmpData !== undefined) a.data = tmpData;
    else delete a.data;

    this._emit('swap', [from, to]);
    return true;
  }

  /**
   * 拆分：从 index 分出 amount 个到目标格（默认第一个空格）
   *
   * @returns 目标格下标（-1 = 失败：没有空格 或 数量不足）
   */
  split(index: number, amount: number, to = -1): number {
    const s = this._slots[index];
    if (!s || s.def === null) return -1;
    if (amount <= 0 || amount >= s.count) return -1;

    const target = to >= 0 ? to : this.firstEmpty;
    if (target < 0 || target >= this._slots.length) return -1;
    if (this._slots[target].def !== null) return -1;

    const t = this._slots[target];
    t.def = s.def;
    t.count = amount;
    if (s.data !== undefined) t.data = s.data;

    s.count -= amount;

    this._emit('split', [index, target]);
    return target;
  }

  // ==================== 整理 ====================

  /**
   * 整理：把同类堆叠合并，并压紧到前面
   *
   * 【用途】"一键整理"按钮
   * 【副作用】格子顺序会变。如果玩家习惯了物品位置，整理反而是负担——
   * 所以很多游戏不做这个功能，或者做成可撤销的。
   */
  compact(): void {
    // 收集所有物品
    const items: Array<{ id: string; data?: unknown; total: number }> = [];

    for (const s of this._slots) {
      if (s.def === null) continue;
      const id = s.def.id;
      if (s.data !== undefined) {
        // 有 data 的独立保留
        items.push({ id, data: s.data, total: s.count });
      } else {
        const exist = items.find((it) => it.id === id && it.data === undefined);
        if (exist) exist.total += s.count;
        else items.push({ id, total: s.count });
      }
    }

    // 按 sortOrder 再按 id 排
    items.sort((a, b) => {
      const da = this._defs.get(a.id);
      const db = this._defs.get(b.id);
      const oa = da?.sortOrder ?? 0;
      const ob = db?.sortOrder ?? 0;
      return oa !== ob ? oa - ob : a.id.localeCompare(b.id);
    });

    // 重排
    this._clearSlotsNoEvent();
    let idx = 0;
    for (const it of items) {
      const def = this._defs.get(it.id)!;
      let left = it.total;
      while (left > 0 && idx < this._slots.length) {
        // 【为什么 numOr 的 fallback 是 left】maxStack 来自物品配置表。
      // 写成 NaN 时 Math.min(NaN, left) === NaN → 格子里的数量变 NaN，
      // 从此这个格子取不出也放不进。退化成"不限制堆叠"是可用的。
      const put = Math.min(numOr(def.maxStack, left), left);
        const s = this._slots[idx];
        s.def = def;
        s.count = put;
        if (it.data !== undefined) s.data = it.data;
        left -= put;
        idx++;
      }
    }

    this._emit('move', this._slots.map((_, i) => i));
  }

  /** 调整容量（保留前面的物品，超出部分**丢弃**） */
  resize(newSize: number): void {
    if (newSize < 1) throw new Error('[Inventory] 容量至少为 1');
    if (newSize < this._slots.length) {
      this._slots.length = newSize;
    } else {
      while (this._slots.length < newSize) this._slots.push({ def: null, count: 0 });
    }
    this._emit('resize', []);
  }

  clear(): void {
    this._clearSlotsNoEvent();
    this._emit('clear', []);
  }

  // ==================== 订阅与存档 ====================

  onChange(fn: (c: InventoryChange) => void): () => void {
    this._onChange = fn;
    return () => {
      if (this._onChange === fn) this._onChange = null;
    };
  }

  /** 导出（只存 id + count，重建时靠 define 过的 def 还原） */
  export(): Array<{ id: string; count: number; data?: unknown }> {
    const out: Array<{ id: string; count: number; data?: unknown }> = [];
    for (const s of this._slots) {
      if (s.def === null) continue;
      const e: { id: string; count: number; data?: unknown } = { id: s.def.id, count: s.count };
      if (s.data !== undefined) e.data = s.data;
      out.push(e);
    }
    return out;
  }

  /**
   * 导入
   *
   * @returns 没能放进去的**物品个数**（未知物品按它的 count 计）
   *
   * 【坑】未注册的 id 会被**跳过并告警**，而不是抛错。
   * 版本更新后某个物品被删了，玩家读档时应该少一件东西，而不是进不去游戏。
   */
  import(data: ReadonlyArray<{ id: string; count: number; data?: unknown }>): number {
    this.clear();
    let skipped = 0;
    for (const e of data) {
      const def = this._defs.get(e.id);
      if (!def) {
        console.warn(`[Inventory] 导入时跳过未知物品：${e.id}`);
        // 【统一语义】skipped 统计的是"少了多少个物品"，不是"少了多少条记录"
        skipped += e.count;
        continue;
      }
      const leftover = this.add(e.id, e.count, e.data);
      if (leftover > 0) skipped += leftover;
    }
    return skipped;
  }

  destroy(): void {
    this.clear();
    this._defs.clear();
    this._onChange = null;
  }

  // ==================== 内部 ====================

  private _clearSlotsNoEvent(): void {
    for (const s of this._slots) {
      s.def = null;
      s.count = 0;
      delete s.data;
    }
  }

  private _emit(kind: InventoryChangeKind, slots: readonly number[]): void {
    this._onChange?.({ kind, slots });
  }
}
