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
 *
 * 【使用示例】
 * ```typescript
 * // ① 地牢的一维数组 → 视野/寻路要的二维数组
 * const grid = toGrid2D({ width: 64, height: 64, tileAt: (x, y) => map[y * 64 + x] });
 * const isWall = wallTestFrom2D(grid);
 *
 * // ② hitbox 的命中结果数组 → skill-caster 要的结构（默认按距离排序）
 * const hits = toCasterHits(rawHitResults);
 *
 * // ③ LootTable 的掉落 → Inventory 的物品（默认合并同 id）
 * const items = flattenDrops(drops);
 * ```
 *
 * 【为什么单独成目录】
 * 这三个转换每次接新项目都要重写一遍，集中在这里才能只写一次。
 * 具体签名见各函数的注释——适配的字段对应关系写在那里。
 */

import { numOr } from '../_core/math';

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
 *
 * 【⚠️ 值域只有 0~255，越界值会被静默改写（本次修复的重点）】
 *
 * `Uint8Array` 的写入是 **mod 256**，不是报错：
 *
 * ```
 * tileAt 返回 -1  → 存进去是 255
 * tileAt 返回 300 → 存进去是 44
 * ```
 *
 * 而地牢/网格里 `-1` 是极常见的哨兵值（"未生成 / 未知 / 查询失败"）。
 * 于是"还没生成的格子"被当成 255 号地形送进渲染器和网络包——
 * 表现为**地图上出现配置里根本不存在的地形块**，存档回读后地形错乱，
 * 全程不报错，所以没人会怀疑是转换函数的问题。
 *
 * 【为什么默认 clamp 而不是抛错】
 * 这个函数常被用在"打包整张图"的热路径上，抛错会让整张图报废。
 * 默认把越界值**收口到 [0,255]**（至少不会再回绕成另一个合法地形 id），
 * 需要严格语义的调用方传 `{ clamp: false }`，越界即抛错——
 * 让"哨兵值混进来"这件事在适配层暴露，而不是下游凭空出现 255 号地形。
 *
 * 【哨兵值应该显式映射】
 * 真正的修法是调用方在 `tileAt` 里把 `-1` 映射成一个明确的地形值
 * （比如"未生成 = 255 号'未知地形'"，并让渲染器认识它）。
 * 靠 mod 兜底等于把两类完全不同的含义压到同一个字节里。
 *
 * @param src 地牢数据源
 * @param opts.clamp 默认 true：越界值收口到 0~255；false：越界抛错
 * @throws `clamp: false` 且 tileAt 返回值超出 0~255 时抛 RangeError
 */
export function toFlatGrid(
  src: ITileSource,
  opts: { clamp?: boolean } = {},
): Uint8Array {
  const clamp = opts.clamp !== false;
  const out = new Uint8Array(src.width * src.height);
  let i = 0;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const v = src.tileAt(x, y);
      if (!Number.isFinite(v) || v < 0 || v > 255 || !Number.isInteger(v)) {
        if (!clamp) {
          throw new RangeError(
            `[adapters] toFlatGrid 值域越界：(${x},${y}) = ${String(v)}。` +
              `Uint8Array 只能存 0~255 的整数，直接写入会 mod 256` +
              `（-1 → 255、300 → 44）。请在 tileAt 中把哨兵值显式映射掉。`
          );
        }
        // NaN / 非整数同样落到 0：它们写进 Uint8Array 会变成 0，结果一样，
        // 但这里显式写出来，避免"看起来是合法值、其实是转换巧合"。
        out[i++] = Number.isFinite(v) ? Math.min(255, Math.max(0, Math.round(v))) : 0;
        continue;
      }
      out[i++] = v;
    }
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
 *
 * 【⚠️ 默认值为什么从 [0] 改成了 [1]】
 *
 * 原来的默认值是 `[0]`（0 = 墙），而 `fov.makeWallTest` 的默认值是 `[1]`。
 * **同一个"墙"概念，两个函数的默认值完全相反**，而不传参恰恰是最常用的调用方式。
 *
 * 实测同一张图 `[[0,1],[1,0]]`：
 *
 * | 坐标 | 旧 `wallTestFrom2D` | `fov.makeWallTest` |
 * |---|---|---|
 * | (0,0) | **true（是墙）** | false（不是墙） |
 * | (1,0) | **false** | **true** |
 *
 * 两处结论**全部相反**。后果是：视野从实体墙里穿出去、或从空地撞上看不见的墙；
 * 两个模块各自单测全绿，接在一起全错，且没有任何报错——
 * 这类"接口对齐错误"只能靠默认值一致来防。
 *
 * 现在两边默认值都是 `[1]`（1 = 墙，与 `AStar` 的 `GridMap` 约定一致：
 * 0 = 可通行，非 0 = 阻挡）。
 *
 * ⚠️ 老代码如果依赖旧的 `[0]` 默认值，请**显式传 `[0]`**，
 * 不要依赖默认值——默认值只应该表达"库推荐的通用约定"。
 */
export function wallTestFrom2D(
  grid: ReadonlyArray<ReadonlyArray<number>>,
  wallValues: readonly number[] = [1],
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
 * 【⚠️ 复用数组 `opts.out` 的坑（本次补充说明）】
 * 传了 `opts.out` 之后，**每次调用都会先 `out.length = 0` 清空它**。
 * 也就是说：
 *
 * ```typescript
 * const buf: ICasterHitLike[] = [];
 * const a = toCasterHits(hitsA, { out: buf });   // a === buf
 * const b = toCasterHits(hitsB, { out: buf });   // b === buf，且 a 也变成了 hitsB 的结果！
 * ```
 *
 * `a` 和 `b` 是**同一个数组对象**。典型踩法：
 * "先算近战命中，再算 AOE 命中，然后发现近战的结果被 AOE 覆盖了"。
 * 这不是 bug（复用数组本来就是为了省分配），但**必须知道**——
 * 所以写在这里：要么每次调用后立刻消费结果，要么别复用同一个 out。
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
  /**
   * 【⚠️ 为什么要把 `n <= 0` 改成 `!(count > 0)` 并先收口】
   *
   * 原写法 `if (n <= 0) return` 对 NaN **恒为 false**（NaN 与任何值比较都是 false），
   * 于是 `n = NaN` 时会一路走到 `Math.min(NaN, sorted.length)` → NaN，
   * `i < NaN` 恒为 false → **循环一次都不执行，返回空数组**。
   *
   * 后果：技能配置表里 `targetCount` 漏填 → 技能静默打不中任何目标，
   * 不报错、不告警，玩家只觉得"这个技能有时候没伤害"。
   *
   * 【为什么不在 NaN 时抛错】
   * 这里命中数来自技能配置的场景很常见，抛错会把一次技能释放变成崩溃。
   * 收口成 0（= 不取任何目标，与显式传 0 的既有契约一致）更安全。
   *
   * 【注意】收口后 NaN 的结果**仍然是空数组**——和修复前偶然得到的一样，
   * 但现在是"显式落到 0 分支"，而不是"靠 Math.min 的 NaN 传播恰好不循环"。
   * 依赖巧合的代码在重构（比如把 Math.min 换成手写循环）时会突然变成全量命中。
   */
  const count = numOr(n, 0);
  if (!(count > 0)) {
    out.length = 0;
    return out;
  }
  const sorted = [...hits].sort((a, b) => a.distance - b.distance);
  out.length = 0;
  const take = Math.min(Math.floor(count), sorted.length);
  for (let i = 0; i < take; i++) {
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
  opts: { mergeSameId?: boolean; path?: readonly string[]; maxDepth?: number } = {},
): DroppedItem[] {
  const merge = opts.mergeSameId !== false;
  /**
   * 【⚠️ 为什么必须给递归定深度上限】
   *
   * `walk` 会无条件递归 `d.children`。掉落表一旦出现**自引用**
   * （配表时把某个子表填成了它自己，或 A→B→A 的环），
   * 递归就永不终止，进程直接 `RangeError: Maximum call stack size exceeded` 崩掉。
   *
   * 实测：
   * ```typescript
   * const a = { id: 'a', count: 1 }; a.children = [a];
   * flattenDrops([a]);   // RangeError: Maximum call stack size exceeded
   * ```
   *
   * 更要命的是**爆栈发生在掉落结算那一刻**——玩家刚打死 Boss、正要弹结算界面时崩溃，
   * 而且是崩溃不是报错，连"哪个表配错了"都无从查起。
   * 定上限后改成抛一条带路径的明确错误，配置错误当场可见。
   */
  const maxDepth = Math.max(1, Math.floor(numOr(opts.maxDepth, 32)));
  const out: DroppedItem[] = [];
  const index = new Map<string, DroppedItem & { count: number }>();

  const walk = (list: readonly ILootDropLike[], parentPath: readonly string[], depth: number): void => {
    if (depth > maxDepth) {
      throw new RangeError(
        `[adapters] flattenDrops 掉落表嵌套超过 ${maxDepth} 层（当前路径：${parentPath.join('/') || '(根)'}）。` +
          `合法的掉落表不该嵌套这么深——八成是子表环形引用了自己。` +
          `若业务确实需要，请显式传 opts.maxDepth。`
      );
    }
    for (const d of list) {
      const path = [...parentPath, d.id];

      // ① 父项本身也是一个物品（除非它只有 children 且 id 是容器标记）
      if (d.count > 0) {
        push(d.id, d.count, !!d.fromPity, path);
      }

      // ② 递归子表
      if (d.children && d.children.length > 0) {
        walk(d.children, path, depth + 1);
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

  walk(drops, opts.path ?? [], 1);
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
