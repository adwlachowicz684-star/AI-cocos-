/**
 * interact —— 环境互动系统（可交互物与触发器）
 *
 * 【它解决什么】
 *
 * 关卡里散布着可交互的东西：宝箱、门、拉杆、NPC、可破坏的罐子、
 * 隐藏开关、传送阵……
 *
 * 手写时这些都变成散落各处的 `if (distance < 2 && Input.pressed('E'))`，
 * 于是：
 * - 玩家同时靠近两个物件时，交互提示闪烁（"按 E 开箱" / "按 E 对话" 来回跳）
 * - 明明面朝宝箱，却触发了背后的门
 * - 交互后物件没正确禁用，能反复开同一个箱子
 *
 * 本模块把三件事固定下来：
 *
 * 1. **目标选择**：在候选中选出"最该被交互的那个"
 * 2. **触发条件**：距离 + 朝向 + 按键 + 自定义条件
 * 3. **状态管理**：一次性、可重复、需持有道具
 *
 * 【无引擎依赖】逻辑层，位置/朝向由宿主提供。
 */

// ==================== 类型 ====================

/** 一个可交互物 */
export interface Interactable<T = unknown> {
  readonly id: string;
  /** 归属的数据（宝箱内容、门的目标关卡…） */
  readonly data: T;
  /** 交互半径 */
  readonly radius: number;
  /**
   * 物件位置。**不提供则视为"全局可交互"**（UI 按钮、随身菜单等），
   * 不受距离与朝向限制。
   *
   * 【⚠️ 这个字段曾被"藏"在实现里】
   * 旧版本 `evaluate()` 靠 `(item as unknown as { pos?: ... }).pos`
   * 双重强转去读位置，而接口里**根本没有 `pos`**。
   * 后果是双向的：
   * - 按接口写 `register({ id, data, radius })` 完全合法，
   *   运行时的行为却是"永远可交互"（distance=0 / inRange=true）——
   *   类型层面完全看不出来；
   * - 反过来，README 示例里的 `pos: { x, y }` 在 `strict` 下
   *   会因多余属性检查**编译失败**，调用方只能自己 `as any`。
   *
   * 现在 `pos` 是接口的一等字段：不传 = 全局可交互（语义不变），
   * 传了就有类型检查。
   */
  readonly pos?: { x: number; y: number; z?: number };
  /**
   * 是否需要朝向它才能交互
   *
   * 【默认 true】
   * 关掉的话，玩家背对着也能开门——
   * 在多数游戏里这感觉是 bug。
   */
  readonly requireFacing?: boolean;
  /**
   * 朝向容差（弧度，默认 ±75°）
   *
   * 【为什么不是 ±90°】
   * 90° 意味着"侧对着也算"，而玩家侧对门时按 E 开了门会觉得意外。
   * 75° 需要玩家大致朝向它。
   */
  readonly facingTolerance?: number;
  /** 已交互次数 */
  readonly used?: number;
  /** 最多可交互几次（默认 1，Infinity = 无限） */
  readonly maxUses?: number;
  /**
   * 需要的道具 / 钥匙
   *
   * 【不定义则不需要】
   * 宿主在 `canInteract` 里检查。
   */
  readonly requires?: readonly string[];
  /** 优先级（同时命中时选高的） */
  readonly priority?: number;
  /** 是否禁用（已破坏的箱子等） */
  readonly disabled?: boolean;
}

export interface InteractContext {
  /** 玩家位置 */
  readonly pos: { x: number; y: number; z?: number };
  /** 玩家朝向（单位向量） */
  readonly facing: { x: number; y: number; z?: number };
  /** 玩家持有的道具 id 列表 */
  readonly inventory: readonly string[];
  /** 业务数据（血量、层数、任务状态…） */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface InteractSystemOptions<T> {
  /**
   * 自定义条件
   *
   * 【为什么注入】
   * "只有血量满时才能开这个箱子""只在夜晚能采这株草"——
   * 这些条件内建任何一条都会产生业务依赖。
   */
  readonly canInteract?: (item: Interactable<T>, ctx: InteractContext) => boolean;
  /** 距离计算（默认欧氏距离） */
  readonly distance?: (a: InteractContext['pos'], b: InteractContext['pos']) => number;
  /** 交互成功回调 */
  readonly onInteract?: (item: Interactable<T>, ctx: InteractContext) => void;
  /** 目标变化回调（刷新 UI 提示） */
  readonly onFocusChange?: (item: Interactable<T> | null) => void;
}

/** 一个候选（已算出距离，供排序） */
export interface InteractCandidate<T> {
  readonly item: Interactable<T>;
  readonly distance: number;
  /** 朝向点积（1 = 正对） */
  readonly alignment: number;
  /** 是否在交互半径内（与"能否交互"是两个维度） */
  readonly inRange: boolean;
  /** 全部条件是否满足（= inRange && 无拒绝原因） */
  readonly valid: boolean;
  /** 不满足的原因（UI 提示"需要钥匙"） */
  readonly reason: string | null;
}

// ==================== 实现 ====================

export class InteractSystem<T = unknown> {
  private readonly _items = new Map<string, Interactable<T>>();
  private readonly _used = new Map<string, number>();
  // 【为什么这几个不是 readonly】destroy() 要能断掉它们持有的外部引用
  private _canInteract?: (i: Interactable<T>, c: InteractContext) => boolean;
  private readonly _distance: (a: InteractContext['pos'], b: InteractContext['pos']) => number;
  private _onInteract?: (i: Interactable<T>, c: InteractContext) => void;
  private _onFocusChange?: (i: Interactable<T> | null) => void;

  private _focusedId: string | null = null;

  /**
   * 被 `setDisabled` 关掉的 id
   *
   * 【为什么不直接写 `item.disabled`】
   * `Interactable.disabled` 是 `readonly` 字段，
   * 写入要靠 `(it as { disabled?: boolean }).disabled = ...` 绕过类型系统。
   * 对 `Object.freeze` 过的物件（配置表导出的常量、immer 产物很常见），
   * 严格模式下这行会**直接抛 TypeError**：
   *   `Cannot add property disabled, object is not extensible`
   * 实测触发路径正是最要紧的那条——`interact()` 里"用完自动禁用"，
   * 也就是说玩家开一个冻结的箱子会让游戏当场崩在这里。
   *
   * 所以真正的开关放在内部的两个 Set 里，物件上的 `disabled` 只是**镜像**，
   * 且只在对象可写时才回写（保持 `get(id).disabled` 的旧行为不变）。
   */
  private readonly _disabled = new Set<string>();
  /** 被显式重新启用的 id（用于盖住冻结物件上写不掉的 `disabled: true`） */
  private readonly _reEnabled = new Set<string>();

  constructor(opts: InteractSystemOptions<T> = {} as InteractSystemOptions<T>) {
    this._canInteract = opts.canInteract;
    this._distance = opts.distance ?? defaultDistance;
    this._onInteract = opts.onInteract;
    this._onFocusChange = opts.onFocusChange;
  }

  // ==================== 注册 ====================

  register(item: Interactable<T>): void {
    if (this._items.has(item.id)) {
      throw new Error(`[Interact] 可交互物 id 重复：${item.id}`);
    }
    this._items.set(item.id, item);
  }

  registerAll(items: readonly Interactable<T>[]): void {
    for (const i of items) this.register(i);
  }

  unregister(id: string): boolean {
    this._used.delete(id);
    if (this._focusedId === id) {
      this._focusedId = null;
      this._onFocusChange?.(null);
    }
    return this._items.delete(id);
  }

  /**
   * 禁用 / 启用（破坏箱子后禁用）
   *
   * 【为什么对冻结物件也安全】见 `_disabled` 的注释。
   */
  setDisabled(id: string, disabled: boolean): void {
    const it = this._items.get(id);
    if (!it) return;
    this._markDisabled(id, disabled);
    if (disabled && this._focusedId === id) {
      this._focusedId = null;
      this._onFocusChange?.(null);
    }
  }

  /**
   * 清空全部注册
   *
   * 【⚠️ 清空必须通知 UI】
   * 旧实现直接把 `_focusedId` 置 null 就结束了，
   * `onFocusChange` 不会触发——屏幕上"按 E 开箱"的提示**留在原地**，
   * 指向一个已经不存在的物件（切场景时最明显）。
   * UI 的可见状态必须由一个通知来驱动，不能靠调用方记得手动清。
   */
  clear(): void {
    this._items.clear();
    this._used.clear();
    this._disabled.clear();
    this._reEnabled.clear();
    if (this._focusedId !== null) {
      this._focusedId = null;
      this._onFocusChange?.(null);
    }
  }

  /**
   * 卸载（rule5）
   *
   * 【为什么 `clear()` 不算卸载】
   * `clear()` 只清本系统自己的记录，
   * 而真正要断的是两条**指向外部**的引用：
   * 1. `_items` 里存着注册方传进来的物件（它们往往还挂着场景节点）
   * 2. 两个回调闭包——闭包会把整条作用域链拖到下一次 GC
   *
   * 所以 `destroy()` 在 `clear()` 之外再摘掉回调。
   */
  destroy(): void {
    this.clear();
    this._canInteract = undefined;
    this._onInteract = undefined;
    this._onFocusChange = undefined;
  }

  get(id: string): Interactable<T> | undefined {
    return this._items.get(id);
  }

  get all(): Interactable<T>[] {
    return [...this._items.values()];
  }

  usedCount(id: string): number {
    return this._used.get(id) ?? 0;
  }

  // ==================== 核心：目标选择 ====================

  /**
   * 找出当前应该交互的目标
   *
   * 【评分规则（按优先级）】
   * 1. 必须在半径内
   * 2. 未禁用、未用完
   * 3. 满足道具要求与自定义条件
   * 4. 朝向优先（更朝向它的得分高）
   * 5. 距离近的优先
   * 6. priority 高者优先
   *
   * 【⚠️ 为什么"朝向"排在"距离"前面】
   * 玩家面朝宝箱、宝箱 2 米、门在身后 1 米——
   * 按距离会选中身后的门。
   * 玩家会认为"游戏没听我的"。
   *
   * 所以：先按朝向分档（正对 > 侧对 > 背对），同档内再比距离。
   */
  findFocus(ctx: InteractContext): InteractCandidate<T> | null {
    let best: InteractCandidate<T> | null = null;

    for (const item of this._items.values()) {
      const c = this.evaluate(item, ctx);
      if (!c.valid) continue;

      if (best === null || this._better(c, best)) best = c;
    }

    const newId = best?.item.id ?? null;
    if (newId !== this._focusedId) {
      this._focusedId = newId;
      this._onFocusChange?.(best?.item ?? null);
    }
    return best;
  }

  /** 当前聚焦的目标（不重新计算） */
  get focused(): Interactable<T> | null {
    return this._focusedId ? this._items.get(this._focusedId) ?? null : null;
  }

  /**
   * 评估一个候选（供 UI 显示全部候选，或调试）
   */
  evaluate(item: Interactable<T>, ctx: InteractContext): InteractCandidate<T> {
    // `pos` 现在是 Interactable 的正式字段，不再需要双重强转
    const pos = item.pos;

    /**
     * 【⚠️ 曾经的 bug：超出半径的东西被当成有效候选】
     *
     * 原实现里"不在范围内"和"满足条件"都返回 `reason = null`，
     * 而 `valid = (reason === null)`。
     *
     * 于是 10 米外的箱子也算有效目标——玩家站着就能开远处的箱子，
     * 或者更糟：身边什么都没有，UI 却显示"按 E 交互"。
     *
     * 【修法：把"够不够得着"独立成 inRange】
     * `reason` 只回答"为什么不能交互"，
     * `inRange` 回答"够不够得着"。
     *
     * 一个语义只该有一个含义。
     * 用同一个 null 表示两种状态，迟早会撞车。
     */
    if (!pos) {
      const reason = this._checkNonPositional(item, ctx, 1, item.requireFacing);
      return { item, distance: 0, alignment: 1, inRange: true, valid: reason === null, reason };
    }

    const distance = this._distance(ctx.pos, pos);
    const alignment = alignmentTo(ctx.pos, pos, ctx.facing);
    const inRange = distance <= item.radius;
    const reason = inRange
      ? this._checkNonPositional(item, ctx, alignment, item.requireFacing)
      : null;

    return {
      item,
      distance,
      alignment,
      inRange,
      valid: inRange && reason === null,
      reason,
    };
  }

  /** 全部候选（按优劣排序，UI 可用） */
  candidates(ctx: InteractContext): InteractCandidate<T>[] {
    const out: InteractCandidate<T>[] = [];
    for (const item of this._items.values()) {
      const c = this.evaluate(item, ctx);
      if (c.valid || c.reason) out.push(c);
    }
    /**
     * 【⚠️ 比较函数在"相等"时必须返回 0】
     * 旧写法 `(a, b) => (this._better(a, b) ? -1 : 1)`：
     * 两个候选等价时（同朝向档、同 priority、同距离），
     * `better(a,b)` 与 `better(b,a)` 都是 false，于是**两个方向都返回 1**，
     * 比较函数自相矛盾 → 排序结果取决于引擎的实现细节（V8 的插入/快排分界），
     * 表现为"UI 上几个箱子的高亮顺序每次刷新都不一样"。
     *
     * 正确写法是"两个方向都不更好 → 0"（等价），保持输入顺序（稳定排序）。
     */
    return out
      .filter((c) => c.valid)
      .sort((a, b) => (this._better(a, b) ? -1 : this._better(b, a) ? 1 : 0));
  }

  // ==================== 执行交互 ====================

  /**
   * 交互（通常绑定到按键）
   *
   * @returns 是否成功
   */
  interact(ctx: InteractContext, id?: string): boolean {
    const target = id
      ? this._items.get(id)
      : this.findFocus(ctx)?.item;
    if (!target) return false;

    const c = this.evaluate(target, ctx);
    if (!c.valid) return false;

    // 记录次数（先记后执行，防止回调里重复触发）
    const n = (this._used.get(target.id) ?? 0) + 1;
    this._used.set(target.id, n);

    this._onInteract?.(target, ctx);

    /**
     * 【用完自动禁用】
     * 达到上限后标记 disabled，
     * 这样下一帧 findFocus 就不会再选它。
     *
     * 如果不禁用，玩家能反复开同一个箱子——
     * 这是肉鸽里最严重的 exploit 之一。
     */
    if (n >= (target.maxUses ?? 1)) {
      this.setDisabled(target.id, true);
      if (this._focusedId === target.id) {
        this._focusedId = null;
        this._onFocusChange?.(null);
      }
    }
    return true;
  }

  /**
   * 重置某个物件的次数（新一层、新一局）
   */
  reset(id: string): void {
    this._used.delete(id);
    this.setDisabled(id, false);
  }

  resetAll(): void {
    this._used.clear();
    for (const it of this._items.values()) {
      this._markDisabled(it.id, false);
    }
    // 同 clear()：焦点没了要通知 UI，否则提示框指向不存在的物件
    if (this._focusedId !== null) {
      this._focusedId = null;
      this._onFocusChange?.(null);
    }
  }

  /**
   * 记录启用/禁用，并尽力把结果镜像回物件上
   *
   * 【为什么回写要判 `Object.isFrozen`】
   * 冻结对象写属性会抛 TypeError（严格模式），
   * 而 `interact()` 用完之后要自动禁用——那条路径上抛错等于崩游戏。
   * 冻结对象的开关只由内部 Set 决定，不再碰物件本身。
   */
  private _markDisabled(id: string, disabled: boolean): void {
    if (disabled) {
      this._disabled.add(id);
      this._reEnabled.delete(id);
    } else {
      this._disabled.delete(id);
      this._reEnabled.add(id);
    }
    const it = this._items.get(id);
    if (it && !Object.isFrozen(it)) {
      (it as { disabled?: boolean }).disabled = disabled;
    }
  }

  /** 是否禁用（内部 Set 优先，冻结物件也能正确表达） */
  private _isDisabled(item: Interactable<T>): boolean {
    if (this._disabled.has(item.id)) return true;
    if (this._reEnabled.has(item.id)) return false;
    return item.disabled === true;
  }

  // ==================== 内部 ====================

  /** 检查除距离外的所有条件 */
  private _checkNonPositional(
    item: Interactable<T>,
    ctx: InteractContext,
    alignment = 1,
    requireFacing?: boolean
  ): string | null {
    if (this._isDisabled(item)) return '已禁用';

    const max = item.maxUses ?? 1;
    if ((this._used.get(item.id) ?? 0) >= max) return '已用完';

    if (requireFacing !== false) {
      const tol = item.facingTolerance ?? (75 * Math.PI) / 180;
      // alignment 是点积，1=正对；转成夹角比较
      if (Math.acos(clamp(alignment, -1, 1)) > tol) return '需要朝向它';
    }

    if (item.requires && item.requires.length > 0) {
      const missing = item.requires.filter((r) => !ctx.inventory.includes(r));
      if (missing.length > 0) return `缺少：${missing.join('、')}`;
    }

    if (this._canInteract && !this._canInteract(item, ctx)) return '条件不满足';
    return null;
  }

  /**
   * 比较优劣
   *
   * 【排序：朝向档位 → 优先级 → 距离】
   */
  private _better(a: InteractCandidate<T>, b: InteractCandidate<T>): boolean {
    // ① 朝向分档：正对(≥0.7) > 侧对(≥0) > 背对
    const tierA = tier(a.alignment);
    const tierB = tier(b.alignment);
    if (tierA !== tierB) return tierA < tierB;

    // ② 优先级
    const pa = a.item.priority ?? 0;
    const pb = b.item.priority ?? 0;
    if (pa !== pb) return pa > pb;

    // ③ 距离
    return a.distance < b.distance;
  }
}

function tier(alignment: number): number {
  if (alignment >= 0.7) return 0;   // 大致正对（±45°）
  if (alignment >= 0) return 1;     // 侧对（±90°）
  return 2;                          // 背对
}

/**
 * 【为什么这里有一份 clamp 而不是 import _core 的】
 * 本单元是**零依赖**单元（rule 6 只允许 import `_core`，
 * 但引入之后 `interact/` 目录就没法"拷走即用"了）。
 * 三行代码换一个外部依赖不划算，所以保留本地实现。
 *
 * 与 `_core.clamp` 行为完全一致（`v < lo ? lo : v > hi ? hi : v`），
 * 改其中一边时请同步另一边。
 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 默认距离：支持 2D/3D */
export function defaultDistance(
  a: InteractContext['pos'],
  b: InteractContext['pos']
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 从 from 看向 to，与 facing 的对齐度（点积） */
export function alignmentTo(
  from: InteractContext['pos'],
  to: InteractContext['pos'],
  facing: InteractContext['facing']
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = (to.z ?? 0) - (from.z ?? 0);
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-9) return 1;   // 重合视为正对

  const nx = dx / len, ny = dy / len, nz = dz / len;
  const fl = Math.sqrt(
    facing.x * facing.x + facing.y * facing.y + (facing.z ?? 0) * (facing.z ?? 0)
  );
  if (fl < 1e-9) return 1;   // 朝向无效，不卡住交互
  const fx = facing.x / fl, fy = facing.y / fl, fz = (facing.z ?? 0) / fl;

  return nx * fx + ny * fy + nz * fz;
}
