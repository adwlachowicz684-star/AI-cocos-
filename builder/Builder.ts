/**
 * builder/Builder.ts —— 建造系统
 *
 * 【它解决什么】
 *
 * 建造看起来是"点一下，房子出现在格子上"。
 * 但真正做到能玩，有五个必须处理的点：
 *
 * 1. **原子性**
 *    先扣资源 → 放置失败 = 玩家的木材凭空消失。
 *    这是建造系统**头号事故**，玩家会认为你在偷东西。
 *    正确顺序：先验证 → 再占位 → 最后扣资源。
 *
 * 2. **预览**
 *    玩家移动鼠标时要实时看到"这里能不能建"，
 *    而且要"看到"不能建的原因（撞了别的建筑 / 地形不允许 / 资源不够）。
 *    只显示红色不够，得显示为什么红。
 *
 * 3. **旋转**
 *    2×3 的建筑转 90° 变成 3×2，占位完全不同。
 *    旋转后的占位算错 = 建筑重叠。
 *
 * 4. **拆除返还**
 *    100% 返还的话，玩家可以无成本试错（"先全建一遍看哪个好"），
 *    建造决策就失去意义了。常见返还 50~75%。
 *    但**拆除未完成的建筑应该 100% 返还**（取消，不是拆除）。
 *
 * 5. **依赖与上限**
 *    需要先建"兵营"才能建"马厩"；同类建筑最多 3 个。
 *    这些规则散落在代码里的话，配表的人改不动。
 *
 * 【设计】
 * 蓝图（Blueprint）是配置，Builder 是执行器。
 * 资源与地形通过**注入的接口**提供，所以它能被完整测试。
 */

import { clamp } from '../_core/math';

// ==================== 类型 ====================

/** 格子坐标 */
export interface Cell {
  readonly x: number;
  readonly y: number;
}

export type Direction = 0 | 90 | 180 | 270;

/** 资源类型（字符串，由调用方定义） */
export type ResourceId = string;

/** 建筑蓝图 */
export interface Blueprint {
  readonly id: string;
  /** 显示名 */
  readonly name?: string;
  /**
   * 占位（相对锚点，未旋转时的形状）
   *
   * 例：1×1 是 [{x:0,y:0}]，2×1 是 [{x:0,y:0},{x:1,y:0}]
   */
  readonly cells: readonly Cell[];
  /** 建造成本 */
  readonly cost: Readonly<Record<ResourceId, number>>;
  /** 建造耗时（毫秒，0 表示瞬间完成） */
  readonly buildTimeMs?: number;
  /**
   * 前置建筑（需要先拥有这些蓝图的实例）
   *
   * 【用途】科技树：兵营 → 马厩 → 骑兵营
   */
  readonly requires?: readonly string[];
  /**
   * 同类数量上限
   *
   * 【⚠️ 不设的话玩家可以铺满全图】
   * 这既影响平衡，也影响性能。
   */
  readonly maxCount?: number;
  /**
   * 可否拆除（默认 true）
   *
   * 任务建筑、初始建筑通常设为 false。
   */
  readonly removable?: boolean;
  /** 拆除返还比例（0~1，默认 0.5） */
  readonly refundRate?: number;
  /** 升级目标蓝图 id */
  readonly upgradeTo?: string;
  /** 附加数据（透传） */
  readonly data?: unknown;
}

/** 已放置的建筑 */
export interface PlacedBuilding {
  /** 实例 id */
  readonly id: string;
  readonly blueprintId: string;
  readonly anchor: Cell;
  readonly rotation: Direction;
  /** 实际占用的格子（旋转后） */
  readonly cells: readonly Cell[];
  /** 放置时刻 */
  readonly placedAt: number;
  /** 建造完成时刻（未完成则 null） */
  readonly completedAt: number | null;
  /** 是否建造完成 */
  readonly completed: boolean;
}

export type PlaceError =
  /** 蓝图不存在 */
  | 'unknown-blueprint'
  /** 位置被占 */
  | 'occupied'
  /** 越界 */
  | 'out-of-bounds'
  /** 地形不允许 */
  | 'terrain-blocked'
  /** 资源不足 */
  | 'insufficient-resources'
  /** 前置建筑未满足 */
  | 'missing-requirement'
  /** 达到数量上限 */
  | 'max-count-reached';

export interface PlaceResult {
  readonly ok: boolean;
  readonly error?: PlaceError;
  /** 人类可读的说明（直接能显示给玩家） */
  readonly detail?: string;
  /** 缺少的资源（error 为 insufficient-resources 时给出） */
  readonly missing?: Readonly<Record<ResourceId, number>>;
  readonly building?: PlacedBuilding;
}

export type RemoveError =
  | 'not-found'
  /** 不可拆除 */
  | 'not-removable';

export interface RemoveResult {
  readonly ok: boolean;
  readonly error?: RemoveError;
  readonly detail?: string;
  /** 返还的资源 */
  readonly refunded?: Readonly<Record<ResourceId, number>>;
}

/** 预览结果 */
export interface PlacePreview {
  readonly ok: boolean;
  readonly error?: PlaceError;
  readonly detail?: string;
  /** 旋转后实际会占用的格子（用于画半透明预览） */
  readonly cells: readonly Cell[];
  /** 与哪些已有建筑冲突（error 为 occupied 时给出） */
  readonly conflicts?: readonly string[];
}

// ==================== 注入接口 ====================

/** 资源钱包（由调用方实现） */
export interface ResourceWallet {
  /** 查询余额 */
  get(id: ResourceId): number;
  /**
   * 扣资源
   *
   * 【⚠️ 必须原子】
   * 要么全部扣成功，要么一个都不扣。
   */
  spend(costs: Readonly<Record<ResourceId, number>>): boolean;
  /** 加资源 */
  gain(gains: Readonly<Record<ResourceId, number>>): void;
}

/** 地形查询（由调用方实现，不需要可为 null） */
export interface TerrainQuery {
  /** 该格是否可建造 */
  isBuildable(cell: Cell): boolean;
}

// ==================== 实现 ====================

/** 旋转一个相对坐标 */
export function rotateCell(c: Cell, rot: Direction): Cell {
  switch (rot) {
    case 0: return c;
    case 90: return { x: -c.y, y: c.x };
    case 180: return { x: -c.x, y: -c.y };
    case 270: return { x: c.y, y: -c.x };
    default: return c;
  }
}

/** 计算某蓝图在某锚点、某旋转下占用的绝对格子 */
export function blueprintCells(
  bp: Blueprint,
  anchor: Cell,
  rot: Direction
): Cell[] {
  return bp.cells.map((c) => {
    const r = rotateCell(c, rot);
    return { x: anchor.x + r.x, y: anchor.y + r.y };
  });
}

function key(c: Cell): string {
  return `${c.x},${c.y}`;
}

export class Builder {
  private readonly _blueprints = new Map<string, Blueprint>();
  private readonly _wallet: ResourceWallet;
  private readonly _terrain: TerrainQuery | null;
  private readonly _bounds: { readonly w: number; readonly h: number } | null;

  /** 实例 id → 建筑 */
  private readonly _buildings = new Map<string, PlacedBuilding>();
  /** 格子 → 实例 id */
  private readonly _occupancy = new Map<string, string>();
  /** 蓝图 id → 已建数量 */
  private readonly _counts = new Map<string, number>();

  private _nextId = 1;
  private _now = 0;

  constructor(opts: {
    blueprints: readonly Blueprint[];
    wallet: ResourceWallet;
    terrain?: TerrainQuery;
    bounds?: { readonly w: number; readonly h: number };
  }) {
    for (const bp of opts.blueprints) this._blueprints.set(bp.id, bp);
    this._wallet = opts.wallet;
    this._terrain = opts.terrain ?? null;
    this._bounds = opts.bounds ?? null;
  }

  // ==================== 时间 ====================

  /** 推进建造进度 */
  update(now: number): void {
    this._now = now;
  }

  get now(): number {
    return this._now;
  }

  // ==================== 查询 ====================

  getBlueprint(id: string): Blueprint | undefined {
    return this._blueprints.get(id);
  }

  allBlueprints(): readonly Blueprint[] {
    return [...this._blueprints.values()];
  }

  getBuilding(id: string): PlacedBuilding | undefined {
    return this._buildings.get(id);
  }

  allBuildings(): readonly PlacedBuilding[] {
    return [...this._buildings.values()];
  }

  /** 某格上的建筑 */
  buildingAt(cell: Cell): PlacedBuilding | undefined {
    const id = this._occupancy.get(key(cell));
    return id === undefined ? undefined : this._buildings.get(id);
  }

  countOf(blueprintId: string): number {
    return this._counts.get(blueprintId) ?? 0;
  }

  get buildingCount(): number {
    return this._buildings.size;
  }

  // ==================== 预览 ====================

  /**
   * 预览某位置能否建造
   *
   * 【为什么单独提供】
   * 玩家每移动一格鼠标就要问一次。
   * 如果直接调 place() 再回滚，会污染状态且很慢。
   * 预览是**纯查询**，不改动任何东西。
   */
  preview(blueprintId: string, anchor: Cell, rot: Direction = 0): PlacePreview {
    const bp = this._blueprints.get(blueprintId);
    if (!bp) {
      return {
        ok: false,
        error: 'unknown-blueprint',
        detail: `未知蓝图 "${blueprintId}"`,
        cells: [],
      };
    }

    const cells = blueprintCells(bp, anchor, rot);

    // ① 越界
    if (this._bounds) {
      for (const c of cells) {
        if (c.x < 0 || c.y < 0 || c.x >= this._bounds.w || c.y >= this._bounds.h) {
          return {
            ok: false, error: 'out-of-bounds', cells,
            detail: `超出地图范围（${this._bounds.w}×${this._bounds.h}）`,
          };
        }
      }
    }

    // ② 占位冲突
    const conflicts = new Set<string>();
    for (const c of cells) {
      const occ = this._occupancy.get(key(c));
      if (occ !== undefined) conflicts.add(occ);
    }
    if (conflicts.size > 0) {
      return {
        ok: false, error: 'occupied', cells,
        detail: `与 ${conflicts.size} 个已有建筑重叠`,
        conflicts: [...conflicts],
      };
    }

    // ③ 地形
    if (this._terrain) {
      for (const c of cells) {
        if (!this._terrain.isBuildable(c)) {
          return {
            ok: false, error: 'terrain-blocked', cells,
            detail: `格子 (${c.x}, ${c.y}) 地形不允许建造`,
          };
        }
      }
    }

    // ④ 数量上限
    const max = bp.maxCount;
    if (max !== undefined && this.countOf(blueprintId) >= max) {
      return {
        ok: false, error: 'max-count-reached', cells,
        detail: `${bp.name ?? blueprintId} 最多 ${max} 个（当前 ${this.countOf(blueprintId)}）`,
      };
    }

    // ⑤ 前置
    if (bp.requires && bp.requires.length > 0) {
      const missing = bp.requires.filter((r) => this.countOf(r) === 0);
      if (missing.length > 0) {
        return {
          ok: false, error: 'missing-requirement', cells,
          detail: `需要先建造：${missing.map((m) => this._blueprints.get(m)?.name ?? m).join('、')}`,
        };
      }
    }

    // ⑥ 资源
    const missing: Record<ResourceId, number> = {};
    let short = false;
    for (const [res, need] of Object.entries(bp.cost)) {
      const have = this._wallet.get(res);
      if (have < need) {
        missing[res] = need - have;
        short = true;
      }
    }
    if (short) {
      return {
        ok: false, error: 'insufficient-resources', cells,
        detail: '资源不足',
      };
    }

    return { ok: true, cells };
  }

  // ==================== 放置 ====================

  /**
   * 放置建筑
   *
   * 【⚠️ 顺序：验证 → 占位 → 扣资源】
   *
   * 反过来（先扣资源）的话，任何一步失败都会吞掉玩家的东西。
   * 而占位放在扣资源前面，是因为占位不会失败——
   * 前面 preview 已经验证过了，这里再验一次只是防并发。
   */
  place(blueprintId: string, anchor: Cell, rot: Direction = 0): PlaceResult {
    const pre = this.preview(blueprintId, anchor, rot);
    if (!pre.ok) {
      return {
        ok: false,
        error: pre.error,
        detail: pre.detail,
      };
    }

    const bp = this._blueprints.get(blueprintId)!;
    const cells = pre.cells;

    // 扣资源（此时已验证过余额充足）
    if (!this._wallet.spend(bp.cost)) {
      return {
        ok: false,
        error: 'insufficient-resources',
        detail: '资源扣除失败',
      };
    }

    const id = `b${this._nextId++}`;
    const buildMs = bp.buildTimeMs ?? 0;
    const b: PlacedBuilding = {
      id,
      blueprintId,
      anchor,
      rotation: rot,
      cells,
      placedAt: this._now,
      completedAt: buildMs <= 0 ? this._now : null,
      completed: buildMs <= 0,
    };

    this._buildings.set(id, b);
    for (const c of cells) this._occupancy.set(key(c), id);
    this._counts.set(blueprintId, this.countOf(blueprintId) + 1);

    return { ok: true, building: b };
  }

  /** 完成建造（由 update 或外部调用） */
  complete(id: string): boolean {
    const b = this._buildings.get(id);
    if (!b || b.completed) return false;
    (b as { completed: boolean }).completed = true;
    (b as { completedAt: number | null }).completedAt = this._now;
    return true;
  }

  // ==================== 拆除 ====================

  /**
   * 拆除建筑
   *
   * 【⚠️ 未完成的建筑 100% 返还】
   *
   * 两个理由：
   * 1. 玩家改主意了，不是"拆掉用过的东西"
   * 2. 更重要的是——建造中取消是**常见操作**，
   *    如果扣 50%，玩家会觉得被惩罚，进而不再尝试
   */
  remove(id: string): RemoveResult {
    const b = this._buildings.get(id);
    if (!b) {
      return { ok: false, error: 'not-found', detail: `建筑 "${id}" 不存在` };
    }

    const bp = this._blueprints.get(b.blueprintId);
    if (bp && bp.removable === false) {
      return {
        ok: false,
        error: 'not-removable',
        detail: `${bp.name ?? b.blueprintId} 不可拆除`,
      };
    }

    // 先清占位（不会失败），再退资源
    this._buildings.delete(id);
    for (const c of b.cells) this._occupancy.delete(key(c));
    this._counts.set(b.blueprintId, Math.max(0, this.countOf(b.blueprintId) - 1));

    const rate = b.completed
      ? clamp(bp?.refundRate ?? 0.5, 0, 1)
      : 1;

    const refunded: Record<ResourceId, number> = {};
    if (bp) {
      for (const [res, amount] of Object.entries(bp.cost)) {
        const back = Math.floor(amount * rate);
        if (back > 0) refunded[res] = back;
      }
    }
    this._wallet.gain(refunded);

    return { ok: true, refunded };
  }

  // ==================== 升级 ====================

  /**
   * 升级建筑
   *
   * 【⚠️ 升级不是"拆除 + 新建"】
   *
   * 如果拆了再建：
   * 1. 位置可能被别的建筑抢走（拆的瞬间格子空了）
   * 2. 返还 50% 再付 100%，玩家亏 50%
   * 3. 建筑 id 变了，引用它的东西全断
   *
   * 所以升级要**原地替换**，保留 id 与位置。
   */
  upgrade(id: string): PlaceResult & { readonly removed?: boolean } {
    const b = this._buildings.get(id);
    if (!b) return { ok: false, error: 'unknown-blueprint', detail: `建筑 "${id}" 不存在` };

    const bp = this._blueprints.get(b.blueprintId);
    const targetId = bp?.upgradeTo;
    if (!targetId) {
      return { ok: false, error: 'unknown-blueprint', detail: '该建筑没有升级目标' };
    }
    const target = this._blueprints.get(targetId);
    if (!target) {
      return { ok: false, error: 'unknown-blueprint', detail: `升级目标 "${targetId}" 不存在` };
    }

    const newCells = blueprintCells(target, b.anchor, b.rotation);

    /**
     * 【⚠️ 升级必须走与"放置"相同的全量校验】
     *
     * 老实现只查了"与其他建筑的占位冲突"和资源够不够，
     * **没有**查越界、地形、数量上限、前置。
     *
     * 实测（修复前）：
     * ```
     * 蓝图 hut → house（house 有 maxCount: 1）；地形只有 (0,0) 可建造
     *
     * 地形：place('hut',(0,0)) ok → upgrade() ok=true
     *       ← house 占 (0,0)+(1,0)，而 (1,0) 地形不允许
     *       直接 place('house',(5,5)) → error=terrain-blocked（同一块地被拒）
     *
     * 数量：放 2 个 hut → upgrade 第 1 个 → house=1
     *                    upgrade 第 2 个 → house=2   ← maxCount=1 被突破
     *       直接 place('house') → error=max-count-reached
     * ```
     *
     * 后果：同一栋建筑，走"放置"被规则挡住，走"升级"畅通无阻。
     * 玩家可以用 `hut → house` 的升级链无限刷出 `maxCount:1` 的限量建筑，
     * 或把建筑盖在水面/悬崖上。
     * 服务器与客户端用同一套 Builder 时两边结果一致（都错），
     * 所以**没有任何报错**，只有运营数据异常（"为什么有人有 5 个主城"）。
     *
     * 【为什么不能简单复用 preview】
     * `preview` 会把"自身已占的格子"报成冲突（旧建筑还占着那些格子）。
     * 所以下面逐项复刻 preview 的校验，但把自身格子从占位冲突里剔除
     * —— 这正是原代码已有的 `occ !== id` 逻辑，只是要补上其余四项。
     */
    const selfCells = new Set(b.cells.map(key));

    // ① 越界
    if (this._bounds) {
      for (const c of newCells) {
        if (c.x < 0 || c.y < 0 || c.x >= this._bounds.w || c.y >= this._bounds.h) {
          return {
            ok: false, error: 'out-of-bounds',
            detail: `升级后超出地图范围（${this._bounds.w}×${this._bounds.h}）`,
          };
        }
      }
    }

    // ② 占位冲突（排除自身）
    for (const c of newCells) {
      const occ = this._occupancy.get(key(c));
      if (occ !== undefined && occ !== id && !selfCells.has(key(c))) {
        return { ok: false, error: 'occupied', detail: '升级后的占位与其他建筑冲突' };
      }
    }

    // ③ 地形
    if (this._terrain) {
      for (const c of newCells) {
        if (!this._terrain.isBuildable(c)) {
          return {
            ok: false, error: 'terrain-blocked',
            detail: `升级后的格子 (${c.x}, ${c.y}) 地形不允许建造`,
          };
        }
      }
    }

    // ④ 数量上限
    //
    // 【为什么要减去"自身将要腾出来的那一个"】
    // 升级是把旧蓝图换成新蓝图，旧蓝图的数量会 -1。
    // 若目标蓝图与源蓝图是**同一个**（配置里 `upgradeTo` 指回自己），
    // 不减就会把自己算进已有数量，导致永远升不了级。
    const isSameBp = targetId === b.blueprintId;
    const alreadyHave = this.countOf(targetId) - (isSameBp ? 1 : 0);
    const max = target.maxCount;
    if (max !== undefined && alreadyHave >= max) {
      return {
        ok: false, error: 'max-count-reached',
        detail: `${target.name ?? targetId} 最多 ${max} 个（当前 ${alreadyHave}）`,
      };
    }

    // ⑤ 前置
    if (target.requires && target.requires.length > 0) {
      const missing = target.requires.filter(
        (r) => this.countOf(r) === 0 && r !== b.blueprintId
      );
      if (missing.length > 0) {
        return {
          ok: false, error: 'missing-requirement',
          detail: `需要先建造：${missing.map((m) => this._blueprints.get(m)?.name ?? m).join('、')}`,
        };
      }
    }

    // 验证资源
    for (const [res, need] of Object.entries(target.cost)) {
      if (this._wallet.get(res) < need) {
        return {
          ok: false,
          error: 'insufficient-resources',
          detail: `资源不足：${res}`,
        };
      }
    }

    if (!this._wallet.spend(target.cost)) {
      return { ok: false, error: 'insufficient-resources', detail: '资源扣除失败' };
    }

    // 原地替换：先清旧占位
    for (const c of b.cells) this._occupancy.delete(key(c));
    this._counts.set(b.blueprintId, Math.max(0, this.countOf(b.blueprintId) - 1));

    const mutable = b as {
      blueprintId: string;
      cells: readonly Cell[];
      placedAt: number;
      completedAt: number | null;
      completed: boolean;
    };
    mutable.blueprintId = targetId;
    mutable.cells = newCells;
    mutable.placedAt = this._now;
    const ms = target.buildTimeMs ?? 0;
    mutable.completed = ms <= 0;
    mutable.completedAt = ms <= 0 ? this._now : null;

    for (const c of newCells) this._occupancy.set(key(c), id);
    this._counts.set(targetId, this.countOf(targetId) + 1);

    return { ok: true, building: this._buildings.get(id) };
  }

  // ==================== 批量 ====================

  /** 清空全部（新一局） */
  clear(): void {
    this._buildings.clear();
    this._occupancy.clear();
    this._counts.clear();
  }

  /**
   * 校验全部蓝图配置
   *
   * 【为什么需要】
   * 蓝图里的 `requires` 和 `upgradeTo` 是字符串引用，
   * 拼错了不会崩，只会表现为"这个建筑永远建不了"——
   * 玩家以为是自己没满足条件。
   */
  validate(): readonly string[] {
    const issues: string[] = [];
    for (const bp of this._blueprints.values()) {
      for (const r of bp.requires ?? []) {
        if (!this._blueprints.has(r)) {
          issues.push(`蓝图 "${bp.id}" 的前置 "${r}" 不存在`);
        }
      }
      if (bp.upgradeTo && !this._blueprints.has(bp.upgradeTo)) {
        issues.push(`蓝图 "${bp.id}" 的升级目标 "${bp.upgradeTo}" 不存在`);
      }
      if (bp.cells.length === 0) {
        issues.push(`蓝图 "${bp.id}" 的占位为空`);
      }
      const rate = bp.refundRate ?? 0.5;
      if (rate < 0 || rate > 1) {
        issues.push(`蓝图 "${bp.id}" 的返还比例 ${rate} 超出 0~1`);
      }
    }
    return issues;
  }
}
