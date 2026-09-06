# adapters · 模块间适配器

```typescript
import {
  toGrid2D, toFlatGrid, wallTestFrom2D,
  toCasterHits, nearestCasterHits, uniqueEntityHits,
  flattenDrops, applyDropsToInventory,
} from './adapters/Adapters';
```

- 依赖：**无**（只用结构化类型，不 import 任何插件）
- 引擎耦合：**无**
- 测试：**35 项**

---

## 这个目录为什么存在

`npm run probe`（接口连通性体检）实测出 8 处"能连上但需要胶水"的地方，其中 3 处是**每次接新项目都要重写一遍的同一种代码**：

| 胶水 | 手写 | 用本模块 |
|---|---|---|
| 地牢一维数组 → 二维数组 | 6 行 | `toGrid2D(dun)` |
| HitResult → CasterHit | 4 行 | `toCasterHits(hits)` |
| LootDrop → Inventory | 3 行 + 递归 | `flattenDrops(drops)` |

**它们的存在说明：库缺的不是轮子，是轮子之间的轴。**

---

## 为什么不是直接改那两个模块

三条理由，按重要性排序：

**① 不能让 dungeon 依赖 fov**

dungeon 和 fov 同为第 1 层。让 dungeon 输出 fov 想要的格式，等于让 dungeon 认识 fov——下次换个视野算法，dungeon 要跟着改。

**② 改格式会破坏已有调用方**

`makeWallTest` 的二维数组签名已被 8 处引用，改成一维要全改。

**③ 适配器是"可选依赖"的正确形态**

依赖规则 v2 的判据是「**必需**才依赖，**可选**就注入」。

dungeon 不"必需"转给 fov——同一个地牢也可能根本不用视野系统。所以转换逻辑应该独立存在，谁需要谁用。

---

## 准入标准

只有满足**全部**条件才配进这个目录：

- ✓ 连接两个及以上已有插件
- ✓ 转换逻辑与具体游戏无关（换项目同样要写）
- ✓ 无状态
- ✓ 不新增业务概念

**反例（不该进来）**：

- ✗ "把我的 Enemy 类转成 CasterHit" —— 那是业务代码
- ✗ "骨王关卡的地牢配置" —— 那是内容

---

## ① 地牢 → 网格

```typescript
const rows = toGrid2D(dungeon);                       // 二维数组，喂 AStar / makeWallTest
const flat = toFlatGrid(dungeon);                     // 扁平 Uint8Array，喂渲染器 / 存档
const isWall = wallTestFrom2D(rows, [Tile.Wall]);     // 墙判定（含越界保护）
```

**⚠️ 用结构化类型 `ITileSource` 而不是 `import Dungeon`**

```typescript
export interface ITileSource {
  readonly width: number;
  readonly height: number;
  tileAt(x: number, y: number): number;   // 越界必须返回墙
}
```

适配器一旦 import 具体类，它就从"可选的桥"变成了"硬依赖"。而 dungeon 只是地牢的**一种**来源——tilemap 导出的数据、手写关卡数组，都该能直接用。

### 两个必须测的点

**① 行列顺序**

一维索引是 `y * w + x`，转成二维时写成 `out[x][y]` 是极常见的错误。

**地图是正方形时完全看不出问题**（41×41 转置后仍是 41×41），
只有长宽不等时才暴露——而那时症状是"寻路在竖直方向错乱"，很容易被误判成 A\* 的 bug。

**② 越界必须算墙**

自己写 wall test 时这一句最常被漏掉。漏了的表现是"视野/寻路从地图边缘漏出去"——只在边缘发生，且看起来像渲染问题。

---

## ② HitResult → CasterHit

```typescript
const hits = world.query(sector(2, 90), px, py, facing, MASK_ENEMY);
const casterHits = toCasterHits(hits);        // 全部，按距离升序
const nearest = nearestCasterHits(hits, 1);   // 只取最近 1 个（近战单体）
```

### 为什么必须有这个转换

两者字段名不同**且嵌套一层**：

```
HitResult = { hitbox: { id, x, y, data }, distance }
CasterHit = { id, x, y, data }
```

不转换直接传的话，`hit.id` 是 `undefined`，然后一路传到伤害结算——
表现为**"技能打中了但没伤害"**，不报错。

测试里有一条专门锁死这件事：

```typescript
const wrong = raw as unknown as { id: string; x: number };
eq(wrong.id, undefined, '直接当 CasterHit 用 → id 是 undefined');
```

### API

| 函数 | 用途 |
|---|---|
| `toCasterHits(hits, opts?)` | 全部转换，默认按距离升序 |
| `nearestCasterHits(hits, n, out?)` | 只取最近 N 个 |

**两者区别**：`toCasterHits(...).slice(0, n)` 也能做到"取最近 N 个"，
但那样会为**全部**命中都构造一遍对象。命中 50 个只取 1 个的场景，差别明显。

**`sortByDistance: false`** 可关闭排序（AOE 无所谓顺序时省一次排序）。

**⚠️ 排序不修改原数组** —— 有测试锁死这条副作用。

| 独有函数 | 用途 |
|---|---|
| `uniqueEntityHits(hits)` | 按实体去重——**同一实体的多个判定框只保留最近的一个** |

> ⚠️ **一个实体可以有多个判定框，打中会返回多条 HitResult。**
> 直接把结果丢给伤害管线，会导致**同一个目标被打两次**——
> 表现为"Boss 掉血速度是预期的两倍"，而且只在它有多个判定框时复现。
> AOE 技能必须用 `uniqueEntityHits` 去重。

**输入/输出的结构化类型**（不 import 任何插件，你自己的类型只要形状对就能用）：

```typescript
IHitLike        { hitbox: { id, x, y, data? }, distance }
ICasterHitLike  { id, x, y, data? }
```

---

## ③ LootDrop → 物品

```typescript
const drops = lootTable.roll(rng);
const items = flattenDrops(drops);
const report = applyDropsToInventory(items, (id, amount) => inv.add(id, amount));

// report: [{ id, wanted, added }, ...]
// 背包满时 added < wanted → UI 提示"背包已满，获得 8/15"
```

### 为什么需要摊平

LootTable 支持嵌套子表，产出是**树形**：

```typescript
[{ id: 'chest', count: 1, children: [{ id: 'sword', count: 1 }] }]
```

而背包只认扁平的 `{ id, count }`。

**手写这段递归的人，十个有九个会漏掉"父项本身也是物品"这件事**——
于是开宝箱拿到了箱子，却没拿到里面的剑。而且不报错，玩家只觉得"这箱子怎么是空的"。

> 我自己写测试时就犯了这个错：预期 3 种物品，实际 4 种——
> 漏算的正是宝箱本身。断言已修正为 4，并保留注释说明。

### 行为

| 特性 | 说明 |
|---|---|
| **递归摊平** | 父项与子项都产出 |
| **同 id 合并** | 否则背包里会有两个 15 金币的格子，看起来像 bug |
| **`fromPity` 取"或"** | 任一来源来自保底，结果就标为保底 |
| **`count: 0` 不产出** | 支持"纯分组容器"的用法 |
| **`path` 记录来源** | `'boss/chest/sword'`——做掉落统计和平衡分析时必须有 |

`mergeSameId: false` 可关闭合并。

| 类型 | 字段 |
|---|---|
| `ILootDropLike`（输入） | `id` / `count` / `fromPity?` / `children?` |
| `DroppedItem`（输出） | `id` / `count` / `fromPity` / `path` |

**`path` 是数组不是字符串**：`['boss', 'chest', 'sword']`。
源码注释里写的 `'boss/chest/sword'` 是示意，
实际字段类型是 `readonly string[]`，要拼接自己 `join('/')`。

---

## 坑

| 坑 | 后果 |
|---|---|
| 转置写成 `out[x][y]` | 正方形地图看不出，长宽不等时寻路错乱 |
| wall test 漏越界 | 视野/寻路从地图边缘漏出去 |
| HitResult 直接当 CasterHit 传 | 打中了但没伤害，不报错 |
| 摊平漏掉父项 | 开宝箱只拿到空箱子 |
| 不返回 `added` | 背包满时玩家以为被吞了物品 |
| `toCasterHits` 复用 out 但不清空 | 命中列表越滚越长 |

## 测试抓到的缺陷

本模块是新增的，测试**没有**抓到实现 bug——29 项全部一次通过。

但它抓到了**我自己写错的 1 条断言**：

> 「掉落 → 摊平 → 入包」我预期 3 种物品，实际是 4 种。
> 漏算的是宝箱本身——而这恰恰是本模块要解决的核心问题。
> 断言已修正，并保留注释：**我自己都差点漏掉父项**。

这从侧面说明为什么这段逻辑值得做成正式模块，而不是每个项目手写一遍。
