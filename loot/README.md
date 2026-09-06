# loot — 随机与掉落

五个可独立使用的零件。全都通过 `IRandomSource` 注入随机源，无引擎依赖。

## PRD · 伪随机分布

**解决**：真随机 25% 暴击，连续 10 刀不暴击的概率有 5.6%——玩家会骂"暴击是假的"。

PRD 每次失败后提高概率，成功后重置。**长期频率不变，方差大幅降低**。

```typescript
const crit = PRD.fromChance(0.25);   // 由名义概率反解 C
if (crit.roll(rng)) dealCrit();
crit.chance;      // 当前真实概率（可显示"下次暴击率"）
```

| | |
|---|---|
| ✅ 适用 | 暴击、闪避、掉落、格挡 |
| ❌ 不适用 | 抽卡保底（那是 pity，见 LootTable）、需要真公平的场合 |

## ShuffleBag · 洗牌袋

**解决**：纯随机有聚集现象（连着 5 次同一声脚步）。ShuffleBag 保证**一轮内每个元素恰好一次**。

```typescript
const bag = new ShuffleBag<string>();
bag.add('hit1').add('hit2').add('hit3');
bag.draw(rng);   // 抽完自动重洗，且保证不与上一轮最后一个重复
```

## WeightedTable · 加权表

前缀和 + 二分查找，O(log n)。支持不重复抽取（`pickUnique`，三选一的核心）。

```typescript
const t = new WeightedTable<string>();
t.add('金币', 70).add('药水', 25).add('传说', 5);
t.pick(rng);
t.pickUnique(3, rng);        // 不重复
t.setWeight('传说', 15);      // 动态调整
```

## LootTable · 掉落表

比 WeightedTable 多了：数量区间、必掉项、嵌套子表、**保底**。

**保底为什么必须有**：5% 掉落刷 20 次不出是完全正常的（35.8%）。玩家不会算概率，只会觉得"游戏在耍我"。保底给的是**确定的希望**。

```typescript
const bossLoot = new LootTable('boss')
  .entry({ id: 'gold', weight: 100, min: 50, max: 120 })
  .entry({ id: 'legendary', weight: 5, min: 1, max: 1, rare: true })
  .withPity({ threshold: 10 });

const drops = bossLoot.roll(rng);
// [{ id: 'gold', count: 87 }, { id: 'legendary', count: 1, fromPity: true }]
```

`sinceRare` / `pityRemaining` 可用于 UI 显示"再 X 次必出"。

## Chest · 开箱与三选一

管的是「该给玩家看哪几个、选了会怎样」，不含渲染。

```typescript
const chest = new Chest(relicPool, { count: 3, owned: myRelics });
chest.roll(rng);
chest.current;        // 三个选项
chest.reroll(rng);    // 排除当前三个，保证每次 reroll 都有变化
chest.take(1);
chest.exportState();  // 存索引，读档后选项不变
```

**候选不足时放宽限制而不是少给**——三选一变成二选一会让玩家以为出 bug 了。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| PRD 实例共享 | 所有角色共用一个失败计数 | **每个角色一个实例** |
| LootTable 实例共享 | 保底计数串了 | 每个玩家一个实例 |
| 保存了 `chest.current` 的引用 | reroll 后失效 | 每次读 `chest.current` |
| 池子顺序变了还用索引存档 | 读档拿到错误物品 | 改用 id 存 |
| PRD 用于抽卡保底 | 语义不匹配 | 用 LootTable 的 pity |
| **注入的 rng 返回 NaN** | **掉落永远为空 / PRD 永远不中，且不报错** | 见下 |

### 坏 rng 的症状：静默失效

`IRandomSource` 的契约是 `next()` 返回 `[0, 1)`。本模块**不校验**这个返回值——
自己去封装 `Math.random()` 时写错（比如 `Math.random() * 2`，或某分支返回 `NaN`），
注入后不会有任何报错，只会表现为：

| 组件 | 坏 rng 下的行为 | 正常行为 |
|---|---|---|
| `PRD.roll()` | **1000 次命中 0 次**（实测） | 1000 次命中约 333 次（`chance=0.25`） |
| `LootTable.roll()` | **返回空数组**（实测） | 返回掉落列表 |
| `ShuffleBag.draw()` | 抽到 `undefined` 或固定项 | 正常洗牌 |

**为什么不在模块内校验**：这是"注入了坏依赖"，属集成错误，
应该在开发期暴露，而不是用运行期兜底把它盖住——
盖住之后症状会变成"偶尔掉不出东西"，比现在更难查。

**排查方法**：掉落永远为空、或保底从不触发时，先验证注入的 rng：

```typescript
for (let i = 0; i < 1000; i++) {
  const r = rng.next();
  if (!(r >= 0 && r < 1)) {
    console.error(`rng 第 ${i} 次返回 ${r}，违反 [0,1) 契约`);
    break;
  }
}
```

库自带的 `MathRandomSource`（`_core`）满足契约，可用来对照。

## API 速查

| 类 | 主要方法 |
|---|---|
| `PRD` | `fromChance(p)`、`roll(rng)`、`chance`、`reset()` |
| `ShuffleBag<T>` | `add(v, count?)`、`draw(rng)`、`reshuffle(rng)`、`remaining` |
| `WeightedTable<T>` | `add`、`pick`、`pickMany`、`pickUnique`、`setWeight` |
| `LootTable` | `entry(e)`、`withPity(o)`、`roll(rng)`、`exportPity()` |
| `Chest<T>` | `roll`、`reroll`、`take`、`reset`、`exportState`/`importState` |

### 各类的其余方法

| 类 | 补充 |
|---|---|
| `LootTable` | `importPity(s)`、`resetPity()` —— **保底状态可迁移**（换关卡/存档） |
| `ShuffleBag<T>` | `drawMany(n, rng)`、`lastDrawn`、`capacity`、`remove(v)`、`clear()` |
| `WeightedTable<T>` | `count`、`totalWeight`、`remove(v)`、`clear()`、`toArray()` |
| `Chest<T>` | `addOwned(item)`、`destroy()` |

### 保底与统计

| 成员 | 说明 |
|---|---|
| `failCount` | 连续未出**稀有**的次数（保底计数） |
| `setFailCount(n)` | 手动设置保底计数（**调试 / 存档迁移**） |
| `entryCount` | 掉落条目数 |
| `canReroll` | 是否还能 reroll（**UI 的 reroll 按钮**） |

```typescript
// 保底进度条："再 3 次必出稀有"
ui.text = `${lt.failCount}/${pityThreshold}`;
btn.disabled = !chest.canReroll;
```

> ⚠️ **`failCount` 只在"没出稀有"时累加，出了就归零——
> 但只归零 `countsForPity` 为真的那些档位。**
> 这个过滤由 `rarity` 模块负责（`pityEligible()`），
> 两处配置不一致会导致"保底永远不触发"。

### 存档与重置

`setFailCount(n)` 是保底状态可迁移的入口——换关卡、读档时用。

```typescript
const myRelics: string[] = [];               // 必须是可写的
const chest = new Chest(pool, { count: 3, owned: myRelics });

chest.addOwned('relic_flame');               // → myRelics 也被 push 了
```

`addOwned` 直接往**构造时传入的那个数组**里 push。所以：

- ❌ `owned: Object.freeze([...])` —— push 会抛错
- ❌ `owned: [...] as const` —— 同上
- ❌ 构造后再替换 `owned` 的引用 —— 改的是新数组，对 chest 无效
- ✅ 传同一个数组，在外部增删，或调 `addOwned`

> 它的类型**曾经是 `readonly T[]`**，实现却用 `as T[]` 强转后 push——
> 类型说"我不改"，实现在改。传只读数组时运行时崩，编译器一声不吭。
> 已改成 `T[]`：现在传只读数组是**编译期报错**。

### 存档：导出—读档要对称

```typescript
// 存档
const snap = chest.exportState();   // 索引形式：{ state, current, rerollsLeft, takenIndex }

// 读档
chest.importState(snap);            // 参数是 ChestSnapshot，不是任意对象
```

> ⚠️ **快照存的是索引，读档依赖池子顺序不变。**
> 池子里插一项或调一次顺序，读回来的就是**另一批东西**——
> 不报错，只是"我开的箱子怎么变了"。
> 存档版本升级时不要重排掉落池。
