# leaderboard · 排行榜

> 并列名次怎么算？这是玩家一眼就能看出来的东西。

## 1. 它解决什么

排行榜看着简单（"按分数排序"），但几个地方一错就会被玩家发现：

| 问题 | 说明 |
|---|---|
| **并列名次** | 100、100、90 → 1,1,2 还是 1,1,3？ |
| **同分先后** | 先达成者在前（通常） |
| **占位** | 一个人刷 100 次不该占掉整个榜单 |
| **快照** | 查看和提交之间榜单变了，玩家会困惑 |
| **分页** | 第 2 页的名次从 1 开始？ |

## 2. 五分钟上手

```typescript
const lb = new Leaderboard({
  capacity: 100,
  order: 'desc',              // 或 'asc'（用时榜）
  rankMode: 'dense',          // 'dense' | 'competition' | 'ordinal'
  bestPerPlayer: true,        // 只留最好成绩
  tieBreak: 'earlier',        // 同分时先达成的在前
});

lb.submit({ playerId, name, score, at });
lb.ranked();                  // 带名次
lb.page(2, 10);               // 分页
lb.around('me', 5);           // 附近的人
lb.snapshot();                // 冻结名次
```

## 3. 三种名次模式

```
分数 100, 100, 90

dense        1, 1, 2    ← 推荐，玩家最容易理解
competition  1, 1, 3    ← 体育竞赛式，跳过名次
ordinal      1, 2, 3    ← 永不并列，同分靠时间分先后
```

## 4. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| **先切片再排名** | 第 2 页第一名显示成第 1 名 | 必须先算完全部名次再分页 |
| **ordinal 写成 else if** | 100,100,90 算出 1,2,2（第 2、3 名并列了） | ordinal 的名次恒等于序号，必须单独处理 |
| **可选布尔用 `!x` 判断** | `bestPerPlayer` 未传时是 undefined，`!undefined === true` → 合并出空榜 | 用 `=== false` |
| 关掉 bestPerPlayer | 一个刷 100 次的玩家占掉整个榜单 | 保持默认（开启） |
| 导入当成合并 | 现有数据被清空 | 要合并用 `submitAll()` |

### 跨来源合并：`mergeLeaderboards`

```typescript
import { mergeLeaderboards } from './leaderboard/Leaderboard';

const merged = mergeLeaderboards([localBoard, serverBoard]);
```

合并**本地榜 + 服务器榜**（离线先存本地，联网后合并）时用这个顶层函数。

> ⚠️ **`bestPerPlayer` 在合并时最危险。**
> 同一个玩家两边都有成绩时，必须取较好的那条——
> 直接 `concat` 会**让同一个人占两个位置**，
> 表现为"排行榜上我是第一名也是第二名"。
>
> 另外坑表里那条「可选布尔用 `!x` 判断」：
> `bestPerPlayer` 未传时是 `undefined`，而 `!undefined === true`，
> 会让合并**出空榜**。判断可选布尔一律用 `=== false`。

## 5. 快照的用途

玩家查看榜单的那一刻和提交成绩的那一刻之间，榜单可能已经变了——
他会看到"刚才我还是第 3，怎么变第 5 了"。

`snapshot()` 冻结名次，让"你这局排第几"成为确定结果。

## 6. 附近的人

玩家排第 500 名时，给他看 495-505 比看前 10 有用得多：

```typescript
lb.around('me', 5);   // 前后各 5 条 + 自己
```

## 6.5 API 补充

| 成员 | 说明 |
|---|---|
| `size` | 当前条目数 |
| `rankOf(playerId)` | 查某个玩家的名次（`null` = 榜上无名） |
| `top(n)` | 取前 n 名（**做"前 100 名"展示**） |

### `page()` 返回 `LeaderboardPage`

```typescript
interface LeaderboardPage {
  entries:   readonly RankedEntry[];   // 本页条目
  page:      number;                   // 当前页（从 1 起）
  pageSize:  number;
  total:     number;                   // 总条目数
  pageCount: number;                   // 总页数
  hasPrev:   boolean;
  hasNext:   boolean;
}
```

> ⚠️ **`page` 从 1 起，不是从 0 起。**
> `lb.page(2, 10)` 拿到的是第 11~20 名，返回的 `page` 是 `2`。
> 拿它去减 1 当数组下标用会错位一整页。

> **`total` 是条目总数，不是页数。**
> 算"共几页"直接用 `pageCount`，别自己 `Math.ceil(total / pageSize)`——
> 边界（`total` 为 0）时两者的处理不同。

### `submit()` 接受 `ScoreEntry`

```typescript
interface ScoreEntry {
  playerId: string;
  name:     string;
  score:    number;
  at:       number;                                  // 时间戳
  meta?:    Readonly<Record<string, unknown>>;       // 附加数据（头像、段位…）
}
```

> **`meta` 是放展示用附加数据的地方**——头像、段位、国籍。
> 排行榜本体不解释它，只是原样存着，
> 取出来渲染时自己读。
>
> 别把参与排序的东西放进 `meta`，
> 排序只看 `score`（和 `at` 作为 tieBreak）。

### 选项类型

```typescript
type SortOrder = 'asc' | 'desc';
type RankMode  = 'dense' | 'competition' | 'ordinal';
```

`LeaderboardOptions`：`capacity` / `order` / `rankMode` / `bestPerPlayer` / `tieBreak`。

> **`order` 是"分数大小"方向，不是"名次好坏"方向。**
> 用时榜（跑得越快越好）要 `order: 'asc'`——
> 数值越小排越前。搞反的话第一名是耗时最长的那个。
| `remove(playerId)` | 移除某个玩家（封号、清违规成绩） |
| `clear()` | 清空整榜 |
| `exportEntries()` / `importEntries(list)` | 存档 |
| `describe(limit?)` | 诊断输出 |

`rank` **从 1 开始**（第 1 名是 `rank === 1`），所以直接显示即可：

```typescript
const r = lb.rankOf(me);
ui.text = r !== null ? `第 ${r.rank} 名` : '未上榜';
```

> ⚠️ 别再 +1。`rank` 已经是 1 起的，写成 `r.rank + 1` 会让**第一名显示成第 2 名**。
>
> `rankOf` 在榜上无名时返回 `null`。
> 由于 `rank` 从 1 开始，`if (r)` 判空是安全的——
> **但如果哪天改成 0 起，这里就会变成经典的第 0 名 bug。**
> 稳妥写法仍是 `r !== null`。

### 三种名次模式对 `rank` 的影响

| 模式 | 并列时 | 例（100,100,90） |
|---|---|---|
| `dense` | 并列同名次，**不跳号** | 1, 1, 2 |
| `ordinal` | **永不并列**，名次恒等于序号 | 1, 2, 3 |
| `competition` | 并列同名次，**跳号** | 1, 1, 3 |

> 三种模式算出来的 `rank` **含义不同**——
> 同一个玩家，在 `ordinal` 下排第 2，在 `dense` 下可能排第 1。
> 切换模式时排行会整体变动，这不是 bug。

## 7. 测试覆盖

37 项。重点覆盖：三种名次模式、同分 tieBreak、只留最好成绩、容量淘汰、分页边界、快照、合并去重。

## 8. 依赖

零依赖，纯逻辑。
