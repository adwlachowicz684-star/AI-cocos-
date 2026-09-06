/**
 * adapters · 模块间适配器
 *
 * ============================================================
 * 【这个目录为什么存在】
 * ============================================================
 *
 * `npm run probe`（接口连通性体检）实测出 8 处"能连上但需要胶水"的地方。
 * 其中 3 处是**每次接新项目都要重写一遍的同一种代码**：
 *
 *   ① 地牢的一维数组 → 视野/寻路要的二维数组
 *   ② hitbox 的 HitResult → skill-caster 的 CasterHit
 *   ③ LootTable 的 LootDrop → Inventory 需要的物品
 *
 * 它们的存在说明：**库缺的不是轮子，是轮子之间的轴。**
 *
 * ------------------------------------------------------------
 * 【为什么不是直接改那两个模块】
 * ------------------------------------------------------------
 *
 * 三条理由，按重要性排序：
 *
 * 1. **不能让 dungeon 依赖 fov。**
 *    dungeon 是第 1 层插件，fov 也是。让 dungeon 输出 fov 想要的格式，
 *    等于让 dungeon 认识 fov——下次换个视野算法，dungeon 要跟着改。
 *
 * 2. **改格式会破坏已有调用方。**
 *    `makeWallTest` 的二维数组签名已被 8 处引用，改成一维要全改。
 *
 * 3. **适配器是"可选依赖"的正确形态。**
 *    依赖规则 v2 的判据是「必需才依赖，可选就注入」。
 *    dungeon 不"必需"转给 fov——同一个地牢也可能根本不用视野系统。
 *    所以转换逻辑应该独立存在，谁需要谁用。
 *
 * ------------------------------------------------------------
 * 【准入标准】
 * ------------------------------------------------------------
 *
 * 只有满足**全部**条件才配进这个目录：
 *
 *   ✓ 连接两个及以上已有插件
 *   ✓ 转换逻辑与具体游戏无关（换项目同样要写）
 *   ✓ 无状态（或有状态但可复用，如 ObjectPool）
 *   ✓ 不新增业务概念
 *
 * 反例（不该进来）：
 *   ✗ "把我的 Enemy 类转成 CasterHit" —— 那是业务代码
 *   ✗ "骨王关卡的地牢配置" —— 那是内容
 */

// ==================== ① 地牢 → 二维数组 ====================

/**
 * 地牢的最小接口（结构化类型，不 import Dungeon）
 *
 * 【为什么不 import DungeonBase】
 * 适配器一旦 import 具体类，它就从"可选的桥"变成了"硬依赖"——
 * 而 dungeon 只是地牢的**一种**来源。
 * tilemap 编辑器导出的数据、手写的关卡数组，都该能直接用这里的转换。
 */
export interface ITileSource {
  readonly width: number;
  readonly height: number;
  /** 越界必须返回墙（与 DungeonBase.tileAt 行为一致） */
  tileAt(x: number, y: number): number;
}

/**
 * 转成二维数组（fov 的 GridMap / AStar 的 GridMap）
 *
 * 【为什么返回新数组而不是共享缓冲】
 * 共享缓冲意味着"改了地牢就自动同步"——听起来好，
 * 但视野和寻路各自缓存了尺寸，地牢中途 resize 会让它们读到越界。
 * 生成期一次性转换，语义最清晰。
 */
export function toGrid2D(src: ITileSource): number[][] {
  const out: number[][] = new Array(src.height);
  for (let y = 0; y < src.height; y++) {
    const row: number[] = new Array(src.width);
    for (let x = 0; x < src.width; x++) row[x] = src.tileAt(x, y);
    out[y] = row;
  }
  return out;
}

/**
 * 转成扁平 Uint8Array（成块传给渲染器 / 网络 / 二进制存档）
 */
export function toFlatGrid(src: ITileSource): Uint8Array {
  const out = new Uint8Array(src.width * src.height);
  let i = 0;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) out[i++] = src.tileAt(x, y);
  }
  return out;
}

/**
 * 从二维数组构造墙判定函数
 *
 * 【与 fov.makeWallTest 的区别】
 * fov 的 makeWallTest 收的是 `ReadonlyArray<ReadonlyArray<number>>`，
 * 可以直接喂 `toGrid2D` 的结果。
 *
 * 这个函数存在的意义是**顺带处理越界**：
 * fov.makeWallTest 已经处理了越界（返回 true），
 * 但自己写 wall test 时最容易漏的就是越界——
 * 漏了的表现是"视野从地图边缘漏出去"，且只在边缘发生。
 */
export function wallTestFrom2D(
  grid: ReadonlyArray<ReadonlyArray<number>>,
  wallValues: readonly number[] = [0],
): (x: number, y: number) => boolean {
  const set = new Set(wallValues);
  const h = grid.length;
  return (x: number, y: number): boolean => {
    if (y < 0 || y >= h) return true;
    const row = grid[y];
    if (x < 0 || x >= row.length) return true;   // 行长度不齐时也算墙
    return set.has(row[x]);
  };
}

// ==================== ② HitResult → CasterHit ====================

/**
 * hitbox 的命中结果（结构化类型，不 import hitbox）
 *
 * 【为什么要结构化类型而不是 import】
 * 见文件头第 1 条：适配器不该制造新的硬依赖。
 * 这里只声明"我需要这几个字段"，任何满足的对象都能传进来。
 */
export interface IHitLike {
  readonly hitbox: {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly data?: unknown;
  };
  readonly distance: number;
}

/** skill-caster 的 CasterHit（结构化类型） */
export interface ICasterHitLike {
  id: string;
  x: number;
  y: number;
  data?: unknown;
}

/**
 * 把 hitbox 的查询结果转成 skill-caster 要的形状
 *
 * 【⚠️ 为什么必须有个转换】
 * 两者字段名不同且嵌套一层：
 *   HitResult = { hitbox: { id, x, y, data }, distance }
 *   CasterHit = { id, x, y, data }
 *
 * 不转换直接传的话，`hit.id` 是 undefined，
 * 然后一路传到伤害结算——表现为"技能打中了但没伤害"，不报错。
 *
 * 【可选：按距离排序】
 * `sortByDistance` 默认开启。近战要"只打最近的一个"时，
 * 排序后取 [0] 即可；AOE 无所谓顺序，但排序开销可忽略。
 */
export function toCasterHits(
  hits: readonly IHitLike[],
  opts: { sortByDistance?: boolean; out?: ICasterHitLike[] } = {},
): ICasterHitLike[] {
  const out = opts.out ?? [];
  out.length = 0;

  const src = opts.sortByDistance === false
    ? hits
    : [...hits].sort((a, b) => a.distance - b.distance);

  for (const h of src) {
    out.push({ id: h.hitbox.id, x: h.hitbox.x, y: h.hitbox.y, data: h.hitbox.data });
  }
  return out;
}

/**
 * 取最近的 N 个（近战单体技能常用）
 *
 * 【为什么单独一个函数】
 * `toCasterHits(...).slice(0, n)` 也能做，
 * 但那样会为全部命中都构造一遍对象。
 * 命中 50 个只取 1 个的场景（大范围技能），差别明显。
 */
export function nearestCasterHits(
  hits: readonly IHitLike[],
  n: number,
  out: ICasterHitLike[] = [],
): ICasterHitLike[] {
  if (n <= 0) {
    out.length = 0;
    return out;
  }
  const sorted = [...hits].sort((a, b) => a.distance - b.distance);
  out.length = 0;
  for (let i = 0; i < Math.min(n, sorted.length); i++) {
    const hb = sorted[i].hitbox;
    out.push({ id: hb.id, x: hb.x, y: hb.y, data: hb.data });
  }
  return out;
}

/**
 * 一次查询中，同一实体只保留一个命中
 *
 * 【⚠️ 这是真实链路跑出来的问题】
 *
 * 骨王有两个判定框（身体 'boss-body'、弱点 'boss-weak'）。
 * 一次挥砍同时命中两个框，如果不去重：
 *
 * ```
 * 命中 2 个判定框: boss-weak, boss-body
 *   boss-weak → 骨王 → 扣血 60
 *   boss-body → 骨王 → 扣血 60    ← 同一刀扣了两次
 * 骨王 hp = -20
 * ```
 *
 * 症状是"**大范围技能伤害莫名翻倍**"，
 * 而且框越多翻倍越狠——玩家会觉得"这 Boss 怎么这么脆"，
 * 策划会以为是数值填错了。
 *
 * 【为什么不在 hitbox 里去重】
 * hitbox 不知道"这些框属于同一个实体"——它只认识判定框 id。
 * 这个信息只有 EntityRegistry 有。
 *
 * 【保留哪个】
 * 保留**距离最近**的那个命中。
 * 这样"打中弱点"会优先于"打中身体"——
 * 弱点框通常在更靠近攻击中心的位置，且这是玩家期望的。
 *
 * @param hits hitbox 的查询结果
 * @param entityOf 判定框 id → 实体 id 的函数（通常是 `reg.fromAlias`）
 * @param out 复用数组
 */
export function uniqueEntityHits<T extends IHitLike>(
  hits: readonly T[],
  entityOf: (boxId: string) => number,
  out: T[] = [],
): T[] {
  out.length = 0;
  const best = new Map<number, T>();
  const invalid: T[] = [];

  for (const h of hits) {
    const eid = entityOf(h.hitbox.id);
    // 反解失败（id 不属于任何实体）→ 单独保留，不当作同一实体合并
    if (!eid) {
      invalid.push(h);
      continue;
    }
    const exist = best.get(eid);
    if (!exist || h.distance < exist.distance) best.set(eid, h);
  }

  for (const h of best.values()) out.push(h);
  for (const h of invalid) out.push(h);
  return out;
}

// ==================== ③ LootDrop → 物品 ====================

/** LootTable 产出的掉落项（结构化类型） */
export interface ILootDropLike {
  readonly id: string;
  readonly count: number;
  readonly fromPity?: boolean;
  readonly children?: readonly ILootDropLike[];
}

/** 转换结果 */
export interface DroppedItem {
  /** 物品 id（与 ItemDef.id 对应） */
  readonly id: string;
  /** 数量（已合并同 id） */
  readonly count: number;
  /** 是否来自保底（UI 高亮） */
  readonly fromPity: boolean;
  /**
   * 来源路径（嵌套子表时是 ['boss', 'chest', 'sword']）
   *
   * 【用途】"这把剑是哪个箱子开出来的"——
   * 做掉落统计和平衡分析时必须有，事后补很麻烦。
   */
  readonly path: readonly string[];
}

/**
 * 把掉落结果摊平成物品列表
 *
 * 【为什么需要摊平】
 * LootTable 支持嵌套子表，产出是树形：
 *   [{ id:'chest', count:1, children:[{id:'sword',count:1}] }]
 *
 * 而背包只认扁平的 { id, count }。
 * 手写这段递归的人，十个有九个会漏掉"父项本身也是物品"这件事——
 * 于是开宝箱拿到了箱子，却没拿到里面的剑。
 *
 * 【同 id 自动合并】
 * 一个掉落表可能同时产出两堆金币。
 * 不合并的话背包里会有两个 15 金币的格子，看起来像 bug。
 */
export function flattenDrops(
  drops: readonly ILootDropLike[],
  opts: { mergeSameId?: boolean; path?: readonly string[] } = {},
): DroppedItem[] {
  const merge = opts.mergeSameId !== false;
  const out: DroppedItem[] = [];
  const index = new Map<string, DroppedItem & { count: number }>();

  const walk = (list: readonly ILootDropLike[], parentPath: readonly string[]): void => {
    for (const d of list) {
      const path = [...parentPath, d.id];

      // ① 父项本身也是一个物品（除非它只有 children 且 id 是容器标记）
      if (d.count > 0) {
        push(d.id, d.count, !!d.fromPity, path);
      }

      // ② 递归子表
      if (d.children && d.children.length > 0) {
        walk(d.children, path);
      }
    }
  };

  function push(id: string, count: number, fromPity: boolean, path: readonly string[]): void {
    if (!merge) {
      out.push({ id, count, fromPity, path });
      return;
    }
    const exist = index.get(id);
    if (exist) {
      exist.count += count;
      // 保底标记是"或"的关系：任一来源来自保底，结果就标为保底
      if (fromPity) (exist as { fromPity: boolean }).fromPity = true;
      return;
    }
    const item = { id, count, fromPity, path };
    index.set(id, item);
    out.push(item);
  }

  walk(drops, opts.path ?? []);
  return out;
}

/**
 * 把摊平后的掉落放进背包
 *
 * 【为什么返回每种物品实际放入的数量】
 * 背包满了会丢弃一部分。
 * 不把"实际放入多少"返回去，UI 就没法提示"背包已满，获得 8/15"——
 * 而玩家会认为自己被吞了 7 个。
 *
 * 【回调注入而非 import Inventory】
 * 符合文件头第 1 条。
 */
export function applyDropsToInventory(
  drops: readonly DroppedItem[],
  add: (id: string, amount: number) => number,
): Array<{ id: string; wanted: number; added: number }> {
  const report: Array<{ id: string; wanted: number; added: number }> = [];
  for (const d of drops) {
    const added = add(d.id, d.count);
    report.push({ id: d.id, wanted: d.count, added });
  }
  return report;
}
