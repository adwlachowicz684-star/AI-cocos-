import { numOr } from '../_core/math';
/**
 * CraftSystem —— 合成 / 打造系统
 *
 * 【它解决什么】
 *
 * 合成系统的难点不是"材料够不够"这么简单：
 *
 * - **配方查找**：我手里有这些材料，能做什么？（反向查询）
 * - **嵌套合成**：铁剑需要铁锭，铁锭需要铁矿石。要能展开成完整的材料树
 * - **材料消耗顺序**：先消耗背包里快过期的？还是先消耗堆叠最少的？
 * - **部分满足**：3 个材料只够 2 个，是做还是不做？
 * - **原子性**：扣了材料但产出失败（背包满）→ 材料必须**全部退回**
 * - **随机产出**：打造可能出精良/史诗品质，概率怎么配
 * - **副产物**：合成时返还一点材料（"工匠熟练度"）
 *
 * 【最容易出的 bug】
 * 扣材料 → 发现背包满了 → 材料已经扣了但东西没到手。
 * **玩家会认为你在偷他东西**。这是所有合成系统的头号事故。
 *
 * 【使用示例】
 * ```typescript
 * const craft = new CraftSystem();
 *
 * craft.define({
 *   id: 'iron_ingot',
 *   name: '铁锭',
 *   inputs: [{ itemId: 'iron_ore', count: 2 }],
 *   output: { itemId: 'iron_ingot', count: 1 },
 * });
 *
 * craft.define({
 *   id: 'iron_sword',
 *   name: '铁剑',
 *   inputs: [
 *     { itemId: 'iron_ingot', count: 3 },
 *     { itemId: 'wood', count: 1 },
 *   ],
 *   output: { itemId: 'iron_sword', count: 1 },
 * });
 *
 * // 材料够不够
 * craft.canCraft('iron_sword', inv);       // { ok: false, missing: [{itemId:'iron_ingot', need:3, have:1}] }
 *
 * // 合成（原子：要么全成功，要么什么都不变）
 * const r = craft.craft('iron_sword', inv);
 * r.ok;                                     // true
 *
 * // 反向查询：我能做什么
 * craft.findCraftable(inv);                 // ['iron_ingot', ...]
 *
 * // 展开完整材料树（UI 显示"还需要多少铁矿石"）
 * craft.totalMaterials('iron_sword', 1);    // { iron_ore: 6, wood: 1 }
 * ```
 *
 * 【无引擎依赖】背包通过 `IInventory` 接口接入（解耦关键）
 */

/** 背包接口（只暴露合成需要的能力，不依赖具体 Inventory 实现） */
export interface IInventory {
  count(itemId: string): number;
  remove(itemId: string, amount: number): number;
  add(itemId: string, amount: number): number;
}

export interface RecipeInput {
  readonly itemId: string;
  readonly count: number;
  /**
   * 是否消耗（false = 只检查有，不消耗。比如"需要有工作台"）
   */
  readonly consume?: boolean;
}

export interface RecipeOutput {
  readonly itemId: string;
  readonly count: number;
  /**
   * 品质/变体的概率表。不填 = 固定产出
   * ```typescript
   * [{ itemId: 'sword_common', weight: 70 },
   *  { itemId: 'sword_rare',   weight: 25 },
   *  { itemId: 'sword_epic',   weight: 5 }]
   * ```
   */
  readonly variants?: ReadonlyArray<{ itemId: string; weight: number; count?: number }>;
}

export interface Recipe {
  readonly id: string;
  readonly name: string;
  readonly inputs: readonly RecipeInput[];
  readonly output: RecipeOutput;
  /** 需要解锁（蓝图、图纸） */
  readonly requiresUnlock?: boolean;
  /** 分类（铁匠台 / 炼金台） */
  readonly station?: string;
  /** 副产物（返还材料） */
  readonly byproducts?: ReadonlyArray<{ itemId: string; count: number; chance?: number }>;
}

export interface MissingMaterial {
  readonly itemId: string;
  readonly need: number;
  readonly have: number;
}

export interface CanCraftResult {
  readonly ok: boolean;
  readonly missing: readonly MissingMaterial[];
  /** 最多能做几个 */
  readonly maxCount: number;
}

export interface CraftResult {
  readonly ok: boolean;
  readonly reason?: 'unknown_recipe' | 'locked' | 'missing_materials' | 'output_failed' | 'rolled_nothing';
  readonly missing?: readonly MissingMaterial[];
  /** 实际产出（随机品质时这里是最终决定的物品） */
  readonly produced?: Array<{ itemId: string; count: number }>;
  /** 副产物 */
  readonly byproducts?: Array<{ itemId: string; count: number }>;
}

export class CraftSystem {
  private readonly _recipes = new Map<string, Recipe>();
  private readonly _unlocked = new Set<string>();

  /** 随机源（用于品质roll和副产物）。**必须注入**以保证可复现 */
  private _rng: { next(): number } | null = null;

  constructor(rng?: { next(): number }) {
    this._rng = rng ?? null;
  }

  setRNG(rng: { next(): number }): void {
    this._rng = rng;
  }

  // ==================== 配方 ====================

  define(recipe: Recipe): this {
    if (this._recipes.has(recipe.id)) throw new Error(`[Craft] 配方 "${recipe.id}" 已存在`);
    if (recipe.inputs.length === 0) throw new Error(`[Craft] ${recipe.id}: 至少要有一个输入`);
    this._recipes.set(recipe.id, recipe);

    // 不需要解锁的配方默认已解锁
    if (!recipe.requiresUnlock) this._unlocked.add(recipe.id);
    return this;
  }

  defineAll(recipes: readonly Recipe[]): this {
    for (const r of recipes) this.define(r);
    return this;
  }

  /** 解锁图纸 */
  unlock(recipeId: string): boolean {
    if (!this._recipes.has(recipeId)) return false;
    this._unlocked.add(recipeId);
    return true;
  }

  isUnlocked(recipeId: string): boolean {
    return this._unlocked.has(recipeId);
  }

  get recipeIds(): string[] {
    return Array.from(this._recipes.keys());
  }

  /** 某个工作台的配方 */
  byStation(station: string): string[] {
    return Array.from(this._recipes.values())
      .filter((r) => r.station === station)
      .map((r) => r.id);
  }

  // ==================== 检查 ====================

  /**
   * 能否合成
   *
   * 【maxCount 的用途】
   * UI 上"最大"按钮要它；批量合成时也要它。
   * 一次算好，避免调用方自己遍历 inputs 再算一遍（容易算错）。
   */
  canCraft(recipeId: string, inv: IInventory, count = 1): CanCraftResult {
    const recipe = this._recipes.get(recipeId);
    if (!recipe) return { ok: false, missing: [], maxCount: 0 };

    const missing: MissingMaterial[] = [];
    let maxCount = Infinity;

    for (const input of recipe.inputs) {
      const need = input.count * count;
      const have = inv.count(input.itemId);

      if (have < need) missing.push({ itemId: input.itemId, need, have });

      // 消耗型材料才限制产能
      //
      // 【为什么先取 per 再判 > 0】
      // 配方表里 count 写成 0 时，`have / 0 === Infinity`，
      // `Math.min(maxCount, Infinity) === maxCount` → 产能不受材料限制。
      // 这个行为其实是对的（不消耗 = 不限制），不需要特殊处理。
      //
      // 真正要防的是 count 为 NaN：`have / NaN === NaN`，
      // `Math.min(maxCount, NaN) === NaN` → 整个合成数量静默变成 NaN，
      // 表现为"点了合成但什么都没发生"，控制台零报错。
      const per = numOr(input.count, 0);
      if (input.consume !== false && per > 0) {
        maxCount = Math.min(maxCount, Math.floor(have / per));
      }
    }

    return {
      ok: missing.length === 0 && this.isUnlocked(recipeId) && count > 0,
      missing,
      maxCount: Number.isFinite(maxCount) ? maxCount : 0,
    };
  }

  /** 反向查询：现在能合成哪些 */
  findCraftable(inv: IInventory, station?: string): string[] {
    const out: string[] = [];
    for (const id of this._recipes.keys()) {
      if (!this.isUnlocked(id)) continue;
      if (station !== undefined && this._recipes.get(id)!.station !== station) continue;
      if (this.canCraft(id, inv).missing.length === 0) out.push(id);
    }
    return out;
  }

  /**
   * 展开完整材料树
   *
   * 【用途】UI 上显示"合成铁剑总共需要 6 个铁矿石 + 1 个木头"，
   * 而不是只显示直接材料"3 个铁锭"。
   *
   * 【防循环】合成树里出现环（A 需要 B，B 需要 A）会导致无限递归。
   * 用 visiting 集合检测，发现环就跳过（当作原始材料）。
   *
   * 【已持有抵扣】`inv` 不为空时，会扣掉背包里已有的中间产物。
   */
  totalMaterials(
    recipeId: string,
    count = 1,
    inv?: IInventory,
    visiting = new Set<string>(),
    out: Record<string, number> = {}
  ): Record<string, number> {
    const recipe = this._recipes.get(recipeId);
    if (!recipe) return out;
    if (visiting.has(recipeId)) return out; // 环，跳过
    visiting.add(recipeId);

    for (const input of recipe.inputs) {
      if (input.consume === false) continue;

      let need = input.count * count;

      // 背包里已有的直接抵扣
      if (inv) {
        const have = inv.count(input.itemId);
        const used = Math.min(have, need);
        need -= used;
      }

      if (need <= 0) continue;

      // 这个材料本身能不能合成？能就递归展开
      const sub = this._findRecipeProducing(input.itemId);
      if (sub) {
        this.totalMaterials(sub.id, need, inv, visiting, out);
      } else {
        out[input.itemId] = (out[input.itemId] ?? 0) + need;
      }
    }

    visiting.delete(recipeId);
    return out;
  }

  /** 找出产出某物品的配方（取第一个） */
  private _findRecipeProducing(itemId: string): Recipe | undefined {
    for (const r of this._recipes.values()) {
      if (r.output.itemId === itemId) return r;
      if (r.output.variants?.some((v) => v.itemId === itemId)) return r;
    }
    return undefined;
  }

  // ==================== 合成 ====================

  /**
   * 执行合成
   *
   * 【原子性保证（最重要的一段）】
   * 顺序是：
   *   1. 检查材料（不扣）
   *   2. 尝试产出
   *   3. 产出成功 → 扣材料
   *   4. 产出失败 → **什么都不做**（材料还在）
   *
   * 反过来（先扣后产）的话，一旦第 2 步失败，
   * 玩家的材料就凭空消失了——这是合成系统的头号事故。
   */
  craft(recipeId: string, inv: IInventory, count = 1): CraftResult {
    const recipe = this._recipes.get(recipeId);
    if (!recipe) return { ok: false, reason: 'unknown_recipe' };
    if (!this.isUnlocked(recipeId)) return { ok: false, reason: 'locked' };
    if (count <= 0) return { ok: false, reason: 'missing_materials', missing: [] };

    // ① 检查（不扣）
    const check = this.canCraft(recipeId, inv, count);
    if (check.missing.length > 0) {
      return { ok: false, reason: 'missing_materials', missing: check.missing };
    }

    // ② 决定产出（可能在变体里 roll）
    const produced = this._rollOutput(recipe, count);
    if (produced.length === 0) {
      return { ok: false, reason: 'rolled_nothing' };
    }

    // ③ 先试产出——这是关键。用临时记录，失败可回滚
    const added: Array<{ itemId: string; count: number }> = [];
    let failed = false;

    for (const p of produced) {
      const leftover = inv.add(p.itemId, p.count);
      const actuallyAdded = p.count - leftover;
      if (actuallyAdded > 0) added.push({ itemId: p.itemId, count: actuallyAdded });
      if (leftover > 0) failed = true;
    }

    // ④ 产出失败 → 回滚（把刚加进去的再拿回来），材料分毫未动
    if (failed) {
      for (const a of added) inv.remove(a.itemId, a.count);
      return { ok: false, reason: 'output_failed' };
    }

    // ⑤ 产出成功 → 扣材料
    for (const input of recipe.inputs) {
      if (input.consume === false) continue;
      inv.remove(input.itemId, input.count * count);
    }

    // ⑥ 副产物
    const byproducts: Array<{ itemId: string; count: number }> = [];
    for (const bp of recipe.byproducts ?? []) {
      const chance = bp.chance ?? 1;
      if (this._rng && chance < 1 && this._rng.next() >= chance) continue;
      const leftover = inv.add(bp.itemId, bp.count * count);
      const got = bp.count * count - leftover;
      if (got > 0) byproducts.push({ itemId: bp.itemId, count: got });
    }

    return { ok: true, produced: added, byproducts };
  }

  private _rollOutput(recipe: Recipe, count: number): Array<{ itemId: string; count: number }> {
    const out: Array<{ itemId: string; count: number }> = [];

    if (!recipe.output.variants || recipe.output.variants.length === 0) {
      out.push({ itemId: recipe.output.itemId, count: recipe.output.count * count });
      return out;
    }

    // 有变体：每个成品单独 roll
    for (let i = 0; i < count; i++) {
      const picked = this._pickVariant(recipe.output.variants);
      if (picked) {
        out.push({ itemId: picked.itemId, count: picked.count ?? 1 });
      }
    }

    // 合并同类，减少 add 调用
    const merged = new Map<string, number>();
    for (const o of out) merged.set(o.itemId, (merged.get(o.itemId) ?? 0) + o.count);
    return Array.from(merged).map(([itemId, count]) => ({ itemId, count }));
  }

  private _pickVariant(variants: ReadonlyArray<{ itemId: string; weight: number; count?: number }>) {
    if (!this._rng) return variants[0];

    let total = 0;
    for (const v of variants) total += v.weight;
    if (total <= 0) return variants[0];

    let roll = this._rng.next() * total;
    for (const v of variants) {
      roll -= v.weight;
      if (roll < 0) return v;
    }
    return variants[variants.length - 1];
  }

  destroy(): void {
    this._recipes.clear();
    this._unlocked.clear();
    this._rng = null;
  }
}
