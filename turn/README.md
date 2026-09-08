# turn — 回合制系统

## 它解决什么

回合制的边界情况远比"你一下我一下"多：

| 情况 | 手写时的问题 |
|---|---|
| 单位在轮到自己前死了 | 轮到空位 → 崩溃，或跳过一整轮 |
| 战斗中召唤新单位 | 重排顺序 → 已行动的单位又动一次 |
| 眩晕 / 连击 | 跳过一次 / 连续动两次 |
| 遍历中杀人 | 游标错位 → 下一个单位被跳过 |

## 用法

```typescript
const turn = new TurnSystem({
  onRoundStart: (r) => refreshBuffs(),
  onUnitStart: (id) => highlightUnit(id),
});

turn.addUnit({ id: 'hero', initiative: 15, actionPoints: 4 });
turn.addUnit({ id: 'goblin', initiative: 8 });
turn.addUnit({ id: 'boss', initiative: 20 });

turn.start();                 // 按先攻排序：boss → hero → goblin
turn.currentUnitId;           // 'boss'

turn.spendAP(2);              // 花 2 点行动点
turn.endTurn();               // 交给下一个

turn.killUnit('hero');        // 死了，下次轮到时自动跳过
turn.skipUnit('goblin');      // 眩晕一回合
turn.grantExtraTurn('boss');  // 连击：boss 连续动两次

turn.orderPreview;            // ['boss','hero','goblin']（UI 行动条）
```

## 关键设计

### 顺序是数组 + 游标，不是队列

队列无法表达"插入到中间"和"移除中间的"。
用数组 + 游标，配合**惰性清理**（死了只打标记，遍历结束才真删），
才能保证遍历过程中修改顺序是安全的。

### 战斗中加入的单位不重排

`addUnit` 只追加到队尾。如果重排，
已经动过的单位会因为先攻高而**再动一次**。

### 同先攻用 id 二级排序

保证**确定性**——否则同样的数据在不同 JS 引擎上顺序可能不同
（`Array.sort` 不保证稳定），回放就对不上了。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 遍历中直接 splice | 游标错位，下一个单位被跳过 | 已处理：惰性清理 |
| 眩晕标记不重置 | 眩晕一次永远不动 | 已处理：新一轮清空 skip |
| 战斗中加人后重排 | 某单位一回合动两次 | 已处理：只在 start 排序 |
| 没人了还在 endTurn | 推进到空位后崩溃 | 已处理：返回 idle |
| 顺序里全是死人 | 无限循环 | 已处理：guard 上限 |

## API

| 成员 | 说明 |
|---|---|
| `addUnit(unit)` | 添加。重复返回 false |
| `start(shuffleEqual?, rng?)` | 开始（排序）。没单位会抛错 |
| `endTurn()` | 结束当前，返回是否成功 |
| `skip()` | 跳过当前（不触发 onUnitEnd） |
| `killUnit(id)` / `reviveUnit(id)` | 死亡 / 复活 |
| `skipUnit(id)` | 跳过本回合（眩晕） |
| `grantExtraTurn(id)` | 额外回合（连击） |
| `spendAP(n)` / `canAfford(n)` / `grantAP(id,n)` | 行动点 |
| `currentUnitId` / `round` / `phase` / `isRunning` | 状态 |
| `orderPreview` / `peekOrder(n)` | 行动条 |
| `unitCount` | 参战单位数 |
| `currentAP` | 当前单位的剩余行动点 |
| `isOutOfAP` | 行动点是否耗尽（**自动结束回合的判据**） |
| `stop()` | 停止（**战斗结束时调**） |
| `destroy()` | 清空 |

> ⚠️ **用 `isOutOfAP` 判断该不该结束回合，不要自己数 `spendAP` 次数。**
> 有"额外行动点"buff 时，自己算的次数和实际不符——
> 表现为「还能行动，但游戏强制结束了回合」。

> ⚠️ **同先攻的顺序：只有同时传 `shuffleEqual = true` 和 `rng` 才会真打乱。**
> 早期版本 `start(true)` 看起来承诺打乱，实际 ES2019 起 `Array.sort` 保证稳定，
> 同先攻永远按添加顺序走——回合制里"谁先手"往往决定胜负，
> 于是配了打乱的游戏实际在给"先加入的一方"系统性先手优势。
>
> 现在拆成两条路：
> - `start()` / `start(true)` **不传 rng** → 同先攻保持添加顺序（与旧行为一致，不破坏既有调用方）
> - `start(true, rng)` → 对同先攻的连续段做 Fisher-Yates 真打乱，**同种子可复现**
>
> ```typescript
> turn.start(true, new FixedRandomSource([0.9, 0.1, 0.5]));   // 可复现的先手顺序
> ```
