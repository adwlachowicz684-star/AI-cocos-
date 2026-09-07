/**
 * entity · 统一实体注册表
 *
 * ============================================================
 * 【它解决什么】
 * ============================================================
 *
 * `npm run probe` 测出的头号缺失：
 *
 * > 全库 grep 无 EntityRegistry / EntityStore / World 类。
 * > 每个模块都只持有 id，但没有"根据 id 取实体"的统一入口。
 *
 * 更麻烦的是**各模块对 id 的假设不一致**：
 *
 * | 模块 | id 类型 | id 语义 |
 * |---|---|---|
 * | hitbox | string | **判定框** id（一个实体多个框 → 多个 id） |
 * | perception | number | 实体 id |
 * | collision | number | **碰撞体** id |
 * | attack-token | number | 实体 id |
 * | targeting | number | 实体 id |
 * | skill-caster | string | 命中 id（透传） |
 *
 * 于是"命中了 → 这个 id 是谁？"这个问题，目前没有地方能回答。
 * 业务侧只能自己维护 Map，而那张表一旦有 bug（同号不同实体），
 * 症状就是"打错人"——不报错，玩家只觉得"我明明瞄准了却打中别人"。
 *
 * ------------------------------------------------------------
 * 【设计：映射，而不是统一】
 * ------------------------------------------------------------
 *
 * 本模块**不去**把 hitbox 的 string 改成 number，
 * 也不去统一 collision 的语义。
 * 那些改动会破坏已有调用方，而且语义差异是**真实存在**的——
 * 判定框 id 确实该和实体 id 分开（一个实体可以有多个框）。
 *
 * 正确做法是**建立映射**：
 *
 * ```
 * 实体 id (number，带版本号)
 *    ├── hitbox:      'body' / 'weapon' / 'weakpoint'   (string，多对一)
 *    ├── collision:   1234                              (number)
 *    └── perception / attack-token / targeting: 直接复用实体 id
 * ```
 *
 * 【使用示例】
 * ```typescript
 * const reg = new EntityRegistry<{ hp: number }>();
 *
 * const id = reg.spawn({ hp: 30 }, { tags: ['enemy'] });
 * reg.isAlive(id);          // true
 * reg.query('enemy');       // [id]  按标签查活着的
 *
 * // ⚠️ id 会被复用，但代际号递增——旧 id 不会指向新实体
 * reg.kill(id, 'killed');   // 标记死亡（仍可 get 查死因）
 * reg.destroy(id);         // 释放槽位
 * const id2 = reg.spawn({ hp: 10 });
 * reg.isAlive(id);         // false —— 旧 id 不会"复活"成新实体
 * ```
 *
 * 【⚠️ SLOT_CAPACITY 是 id 编码模数，不是数量上限】
 * `SLOT_CAPACITY = 1048576`（2^20），id 由 `index + generation * SLOT_CAPACITY` 拼成。
 * 它约束的是"槽位下标能有多大"，**spawn 本身没有数量检查**——
 * 槽位超过 2^20 时不会抛错，而是 index 进位污染 generation 位，导致 id 碰撞。
 * 真要达到这个量级前，内存早就先撑不住了，所以这里刻意不做检查。
 */

// ==================== 常量 ====================

/**
 * 槽位容量：一个 id 里 index 部分的上限
 *
 * 1048576 = 2^20 ≈ 100 万。
 * 超过这个数量的实体，需要增大本常量（同时 id 的数值也会更大）。
 */
export const SLOT_CAPACITY = 1048576;

/** 非法 id */
export const INVALID_ID = 0;

// ==================== id 编码 ====================

/**
 * 取 id 里的槽位下标
 *
 * 【为什么用取模而不是 `& (CAP-1)`】
 * 位运算是 32 位有符号的，id 超过 2^31 就会出错。
 * 取模没有这个问题，且现代 JS 引擎对常量取模有优化。
 */
export function idIndex(id: number): number {
  return id % SLOT_CAPACITY;
}

/** 取 id 里的版本号 */
export function idGeneration(id: number): number {
  return Math.floor(id / SLOT_CAPACITY);
}

/**
 * 组装 id
 *
 * 【⚠️ 用乘法，不要用位移】
 * 第一版写成 `(gen << 20) | index`，但 JS 位运算是 **32 位有符号**：
 * `gen=2048` 时 `2048 << 20` 溢出成负数。
 *
 * 后果：**槽位复用 2048 次后实体凭空消失**——
 * 长会话游戏（挂机、无尽模式）跑几小时就会撞上，
 * 而没人会想到是"死了 2048 个怪"导致的。
 */
export function makeId(index: number, generation: number): number {
  return index + generation * SLOT_CAPACITY;
}

/** id 是否合法（index 部分必须 > 0，因为 0 被 INVALID_ID 占用） */
export function isValidId(id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  return idIndex(id) > 0;
}

// ==================== 类型 ====================

/** 死因 */
export type DeathReason =
  /** 正常击杀（业务侧判断 hp<=0 后调 kill） */
  | 'killed'
  /** 被 destroy 直接移除（换关卡、尸体消失） */
  | 'destroyed'
  /** 业务自定义 */
  | (string & {});

/** 实体记录 */
export interface EntityRecord<T = unknown> {
  /** 实体 id（含版本号） */
  readonly id: number;
  /** 业务对象 */
  readonly entity: T;
  /** 是否存活（kill 后为 false，但记录还在） */
  alive: boolean;
  /** 标签 */
  readonly tags: Set<string>;
  /** 判定框 id（hitbox 用的 string，可以有多个） */
  readonly hitboxIds: string[];
  /** 碰撞体 id（collision 用的 number） */
  colliderId: number;
  /** 生成时的帧号 */
  readonly bornFrame: number;
  /** 死亡时的帧号（未死为 -1） */
  deadFrame: number;
  /** 死因 */
  deathReason: DeathReason | null;
}

export interface SpawnOptions {
  /** 标签（用于 query） */
  readonly tags?: readonly string[];
  /** 判定框 id（hitbox 用 string，可多个） */
  readonly hitboxIds?: readonly string[];
  /** 碰撞体 id（collision 用 number） */
  readonly colliderId?: number;
}

export type DeathHandler<T = unknown> = (
  id: number, entity: T, reason: DeathReason,
) => void;
export type SpawnHandler<T = unknown> = (id: number, entity: T) => void;
export type DestroyHandler = (id: number) => void;

// ==================== 实现 ====================

export class EntityRegistry<T = unknown> {
  /**
   * 槽位 → 记录。为空表示该槽位空闲。
   *
   * 【⚠️ 第 0 个位置是占位，永不使用】
   * 槽位下标必须 ≥ 1，因为 index=0 时 `makeId(0, gen)` 可能等于
   * gen=0 时的 0，而 0 是 INVALID_ID——
   * 两者冲突会让"第一个生成的实体"被判为非法 id。
   *
   * 实测：不占位的话，第一个 spawn 得到 id=1048576（index=0, gen=1），
   * `isValidId` 因 index≤0 返回 false，
   * 于是第一个实体**永远查不到**——而后续实体都正常。
   */
  private _slots: Array<EntityRecord<T> | null> = [null];
  /** 槽位 → 版本号（同样第 0 位占位） */
  private _gens: number[] = [0];
  /** 空闲槽位栈 */
  private _free: number[] = [];
  /** 别名（判定框 string id）→ 实体 id */
  private _alias = new Map<string, number>();
  /** 碰撞体 id → 实体 id */
  private _colliders = new Map<number, number>();

  private _live = 0;
  private _frame = 0;

  /** 遍历中暂存的待销毁 id（连锁死亡安全） */
  private _pendingDestroy: number[] = [];
  private _iterating = 0;

  private _onDeath: Array<DeathHandler<T>> = [];
  private _onSpawn: Array<SpawnHandler<T>> = [];
  private _onDestroy: DestroyHandler[] = [];

  // ==================== 生成 ====================

  /**
   * 注册一个实体
   *
   * @returns 实体 id（含版本号）
   */
  spawn(entity: T, opts: SpawnOptions = {}): number {
    let index: number;

    if (this._free.length > 0) {
      index = this._free.pop()!;
    } else {
      // 从 1 开始（0 是占位，见 _slots 的注释）
      index = this._slots.length;
      this._slots.push(null);
    }

    // 【⚠️ 版本号必须读 _gens[index]，不能硬编码 0】
    // 第一版在这里写 `const gen = 0`，绕过 clear() 保留的版本号，
    // 导致"换关后旧 id 复活"的修复形同虚设。
    // 而且 _gens 可能比 index 短（clear 后复用槽位），需要补。
    while (this._gens.length <= index) this._gens.push(1);
    const gen = this._gens[index];

    const id = makeId(index, gen);

    const rec: EntityRecord<T> = {
      id,
      entity,
      alive: true,
      tags: new Set(opts.tags ?? []),
      hitboxIds: [...(opts.hitboxIds ?? [])],
      colliderId: opts.colliderId ?? 0,
      bornFrame: this._frame,
      deadFrame: -1,
      deathReason: null,
    };

    this._slots[index] = rec;
    for (const hb of rec.hitboxIds) this._alias.set(hb, id);
    if (rec.colliderId > 0) this._colliders.set(rec.colliderId, id);

    this._live++;

    for (const fn of this._onSpawn) fn(id, entity);
    return id;
  }

  // ==================== 查询 ====================

  /** 取记录（含尸体）。不存在或版本不符返回 null */
  get(id: number): EntityRecord<T> | null {
    if (!isValidId(id)) return null;
    const index = idIndex(id);
    if (index >= this._slots.length) return null;
    const rec = this._slots[index];
    if (!rec) return null;
    // 版本号不符 = 这是旧引用的"幽灵 id"
    if (rec.id !== id) return null;
    return rec;
  }

  /** 取记录，排除尸体 */
  getAlive(id: number): EntityRecord<T> | null {
    const rec = this.get(id);
    return rec && rec.alive ? rec : null;
  }

  /** 取业务对象 */
  getEntity<X = T>(id: number): X | null {
    const rec = this.get(id);
    return rec ? (rec.entity as unknown as X) : null;
  }

  /** 该 id 是否指向一个存在的记录（含尸体） */
  exists(id: number): boolean {
    return this.get(id) !== null;
  }

  /** 是否存活 */
  isAlive(id: number): boolean {
    const rec = this.get(id);
    return !!rec && rec.alive;
  }

  /** 判定框 id → 实体 id */
  fromAlias(alias: string): number {
    return this._alias.get(alias) ?? INVALID_ID;
  }

  /** 判定框 id → 业务对象 */
  entityFromAlias<X = T>(alias: string): X | null {
    const id = this.fromAlias(alias);
    return id === INVALID_ID ? null : this.getEntity<X>(id);
  }

  /** 碰撞体 id → 实体 id */
  fromCollider(colliderId: number): number {
    return this._colliders.get(colliderId) ?? INVALID_ID;
  }

  // ==================== 标签 ====================

  addTag(id: number, tag: string): boolean {
    const rec = this.get(id);
    if (!rec) return false;
    rec.tags.add(tag);
    return true;
  }

  removeTag(id: number, tag: string): boolean {
    const rec = this.get(id);
    if (!rec) return false;
    return rec.tags.delete(tag);
  }

  hasTag(id: number, tag: string): boolean {
    const rec = this.get(id);
    return !!rec && rec.tags.has(tag);
  }

  /** 查询带某标签的实体（默认只要活的） */
  query(tag: string, requireAlive = true): number[] {
    const out: number[] = [];
    for (const rec of this._snapshotRecords(requireAlive)) {
      if (rec.tags.has(tag)) out.push(rec.id);
    }
    return out;
  }

  /** 同时满足多个标签 */
  queryAll(tags: readonly string[], requireAlive = true): number[] {
    const out: number[] = [];
    for (const rec of this._snapshotRecords(requireAlive)) {
      let ok = true;
      for (const t of tags) {
        if (!rec.tags.has(t)) { ok = false; break; }
      }
      if (ok) out.push(rec.id);
    }
    return out;
  }

  // ==================== 死亡与销毁 ====================

  /**
   * 标记死亡
   *
   * 【与 destroy 的区别】
   * kill 只标记 alive=false，**记录还留着**——
   * 尸体还要掉物品、播消失动画、统计击杀数。
   *
   * 【⚠️ 可重复调用，但回调只触发一次】
   * 否则"一帧内被两发子弹打死"会掉两份装备，
   * 而这是玩家会主动利用的漏洞。
   */
  kill(id: number, reason: DeathReason = 'killed'): boolean {
    const rec = this.getAlive(id);
    if (!rec) return false;

    rec.alive = false;
    rec.deadFrame = this._frame;
    rec.deathReason = reason;
    this._live--;

    for (const fn of this._onDeath) fn(id, rec.entity, reason);
    return true;
  }

  /**
   * 真正移除并回收槽位
   *
   * 【⚠️ 销毁活着的实体也会触发死亡回调】
   * reason 为 'destroyed'。
   * 换关卡时直接 destroy 全场，如果不触发，
   * "击杀计数"类成就就会**只在换关时**漏——极难发现。
   */
  destroy(id: number): boolean {
    // 遍历中 → 推迟（连锁死亡安全）
    if (this._iterating > 0) {
      this._pendingDestroy.push(id);
      return true;
    }
    return this._destroyNow(id);
  }

  private _destroyNow(id: number): boolean {
    if (!isValidId(id)) return false;
    const index = idIndex(id);
    if (index >= this._slots.length) return false;
    const rec = this._slots[index];
    if (!rec || rec.id !== id) return false;

    // 还活着 → 先走死亡流程
    if (rec.alive) {
      rec.alive = false;
      rec.deadFrame = this._frame;
      rec.deathReason = 'destroyed';
      this._live--;
      for (const fn of this._onDeath) fn(id, rec.entity, 'destroyed');
    }

    // 清理映射
    for (const hb of rec.hitboxIds) {
      if (this._alias.get(hb) === id) this._alias.delete(hb);
    }
    if (rec.colliderId > 0 && this._colliders.get(rec.colliderId) === id) {
      this._colliders.delete(rec.colliderId);
    }

    // 【⚠️ 递增版本号，让旧引用永久失效】
    this._gens[index]++;
    this._slots[index] = null;
    this._free.push(index);

    for (const fn of this._onDestroy) fn(id);
    return true;
  }

  /**
   * 清空（换关卡）
   *
   * 【⚠️ 不能重置版本号】
   * 第一版把 _gens 整个清空，结果：
   * `reg.exists(上一关的id)` 返回 true——
   * **上一关的 id 全部复活**，残留的技能引用会打在新关卡的怪身上。
   *
   * 比普通 ABA 更隐蔽：只在换关时发生。
   * 正确做法是递增所有版本号。
   */
  clear(): void {
    // 先触发所有还活着实体的死亡回调
    for (let i = 1; i < this._slots.length; i++) {
      const rec = this._slots[i];
      if (rec && rec.alive) {
        rec.alive = false;
        rec.deadFrame = this._frame;
        rec.deathReason = 'destroyed';
        for (const fn of this._onDeath) fn(rec.id, rec.entity, 'destroyed');
      }
    }

    // ⚠️ 递增版本号而不是重置（第 0 位是占位，从 1 开始）
    for (let i = 1; i < this._gens.length; i++) this._gens[i]++;

    // ⚠️ 保留第 0 个占位（不能 length = 0，否则下次 spawn 会拿到 index=0）
    this._slots.length = 1;
    this._free.length = 0;
    this._alias.clear();
    this._colliders.clear();
    this._live = 0;
    this._pendingDestroy.length = 0;
  }

  // ==================== 遍历 ====================

  /**
   * 遍历
   *
   * 【⚠️ 遍历安全】
   * 回调里 destroy 会被推迟到遍历结束——
   * 这是"爆炸桶炸死一片"能正常工作的前提。
   *
   * 【⚠️ 用快照长度】
   * 回调里 spawn 新实体不会让本次遍历无限延长。
   */
  forEach(fn: (rec: EntityRecord<T>, id: number) => void, requireAlive = true): void {
    const snapshot = this._snapshotRecords(requireAlive);

    this._iterating++;
    try {
      for (const rec of snapshot) {
        // 回调里可能已经把它销毁了（比如通过 kill + destroy 的直接路径）
        if (requireAlive && !this.isAlive(rec.id)) continue;
        fn(rec, rec.id);
      }
    } finally {
      this._iterating--;
    }

    if (this._iterating === 0 && this._pendingDestroy.length > 0) {
      const pending = this._pendingDestroy;
      this._pendingDestroy = [];
      for (const id of pending) this._destroyNow(id);
    }
  }

  /** 快照 */
  snapshot(requireAlive = true): EntityRecord<T>[] {
    return this._snapshotRecords(requireAlive);
  }

  private _snapshotRecords(requireAlive: boolean): EntityRecord<T>[] {
    const out: EntityRecord<T>[] = [];
    for (let i = 1; i < this._slots.length; i++) {
      const rec = this._slots[i];
      if (!rec) continue;
      if (requireAlive && !rec.alive) continue;
      out.push(rec);
    }
    return out;
  }

  // ==================== 回调 ====================

  onDeath(fn: DeathHandler<T>): () => void {
    this._onDeath.push(fn);
    return () => {
      const i = this._onDeath.indexOf(fn);
      if (i >= 0) this._onDeath.splice(i, 1);
    };
  }

  onSpawn(fn: SpawnHandler<T>): () => void {
    this._onSpawn.push(fn);
    return () => {
      const i = this._onSpawn.indexOf(fn);
      if (i >= 0) this._onSpawn.splice(i, 1);
    };
  }

  onDestroy(fn: DestroyHandler): () => void {
    this._onDestroy.push(fn);
    return () => {
      const i = this._onDestroy.indexOf(fn);
      if (i >= 0) this._onDestroy.splice(i, 1);
    };
  }

  // ==================== 帧 ====================

  /** 推进一帧（调试/统计用） */
  tick(): void {
    this._frame++;
  }

  get frame(): number {
    return this._frame;
  }

  // ==================== 统计 ====================

  /** 存活数 */
  get liveCount(): number {
    return this._live;
  }

  /** 占用槽位数（含尸体） */
  get slotCount(): number {
    let n = 0;
    for (let i = 1; i < this._slots.length; i++) if (this._slots[i]) n++;
    return n;
  }

  describe(): string {
    return `[EntityRegistry] 存活 ${this._live}，占用槽位 ${this.slotCount}` +
      `，别名 ${this._alias.size}，碰撞体 ${this._colliders.size}` +
      `，帧 ${this._frame}`;
  }
}

// ============================================================
// EntityIndex · 对象 → id 的反向索引
// ============================================================

/**
 * 反向索引（可选，按需使用）
 *
 * 【为什么可选】
 * 很多场景只需要 id → 实体（Registry 已提供）。
 * 反向索引要维护一张 WeakMap，有额外开销，
 * 不该强制每个使用者都付这个代价。
 */
export class EntityIndex {
  private _map = new WeakMap<object, number>();

  /** 绑定对象与 id */
  bind(obj: object, id: number): void {
    this._map.set(obj, id);
  }

  /** 取 id。未绑定返回 INVALID_ID */
  idOf(obj: object): number {
    return this._map.get(obj) ?? INVALID_ID;
  }

  /** 解绑 */
  unbind(obj: object): boolean {
    return this._map.delete(obj);
  }

  /** 是否已绑定 */
  has(obj: object): boolean {
    return this._map.has(obj);
  }
}
