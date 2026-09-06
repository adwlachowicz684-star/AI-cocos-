# card — 牌库 / 手牌 / 弃牌堆

## 它解决什么

卡牌构筑类（杀戮尖塔、月圆之夜）的核心循环：

```
抽牌堆 --draw--> 手牌 --play--> 弃牌堆
   ^                                |
   +--------- 抽牌堆空时洗回 --------+
```

这个循环细节不少：抽牌堆空了要自动洗回、手牌上限、
消耗（exhaust）不进弃牌堆、临时卡战斗结束要移除。

## 用法

```typescript
const deck = new Deck<Card>({ handLimit: 10 });

deck.setDeck(startingCards);     // 会记为"主牌库"
deck.shuffle(rng);

deck.draw(5, rng);               // 抽 5 张
deck.hand;                       // 手牌
deck.play(0, 'discard');         // 打出 → 弃牌堆
deck.play(0, 'exhaust');         // 消耗（不进弃牌堆）

deck.discardHand();              // 回合结束弃掉所有手牌
deck.addToDrawPile(card, 'top'); // 放到抽牌堆顶
deck.peek(3);                    // 查看顶部 3 张（不移除）

deck.piles;                      // { draw, hand, discard, exhaust }
```

## 关键设计：reset 用主牌库

`setDeck(cards)` 会同时记下 `_master`。`reset()` 用 `_master` 重建，
所以**战斗中加入的临时卡（事件给的诅咒）会自动消失**——
不需要手动清理，也就不会漏。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 手牌满时直接丢弃抽到的牌 | 玩家觉得"我的牌莫名其妙少了" | 已处理：抽不进的**留在抽牌堆** |
| 临时卡没清 | 第二次战斗又出现 | 用 `reset()`（基于主牌库重建） |
| 洗牌时机不确定 | 不同玩家看到的顺序不同 | 用注入的 `IRandomSource`，不用 `Math.random` |

## API

| 成员 | 说明 |
|---|---|
| `setDeck(cards, saveMaster?)` | 设置牌库（默认记为主牌库） |
| `reset()` | 回到主牌库 |
| `shuffle(rng)` / `reshuffle(rng)` | 洗抽牌堆 / 弃牌堆洗回 |
| `draw(n, rng)` | 抽 n 张，返回实际抽到的 |
| `drawOne(rng)` | 抽一张 |
| `play(index, to?)` | 打出。`to`: `discard`(默认)/`exhaust`/`drawTop`/`drawBottom` |
| `playCard(card, to?)` | 按引用打出（UI 拖拽用） |
| `discard(index)` / `discardHand()` / `discardRandom(n, rng)` | 弃牌 |
| `addToDrawPile(card, where?, rng?)` | `top`/`bottom`/`random` |
| `addToHand(card)` / `addToDiscard(card)` | 加牌 |
| `removeFromHand(card)` / `removeEverywhere(card)` | 移除 |
| `peek(n)` | 查看顶部 n 张（不移除） |
| `totalCards` / `piles` | 统计与快照 |

### 三个牌堆（只读）

| 成员 | 说明 |
|---|---|
| `drawPile` | 抽牌堆 |
| `discardPile` | 弃牌堆 |
| `exhaustPile` | 消耗堆（**本局不会再回来**） |
| `isHandFull` | 手牌是否满了 |

```typescript
// 卡组追踪 UI：「抽牌堆 12 / 弃牌堆 5 / 消耗 2」
ui.text = `抽 ${d.drawPile.length} · 弃 ${d.discardPile.length} · 消 ${d.exhaustPile.length}`;
```

> **这三个都是 `readonly T[]`**，直接改数组不会触发任何同步——
> 要改就走 `addToDrawPile` / `removeEverywhere` 这类方法。

### 变更订阅

`onChange(fn)` —— 牌堆变动时回调（**UI 重绘用这个，不要每帧轮询**）。

`findAll(predicate)` —— 在**所有牌堆**里按条件找牌。

```typescript
const allFire = deck.findAll((c) => c.tags.includes('fire'));
```

> 它扫的是抽牌堆 + 手牌 + 弃牌堆 + 消耗堆。
> **消耗堆也算**——想排除消耗掉的牌要自己过滤。

`destroy()` —— 清空全部牌堆。

## DeckOptions

`handLimit`（默认 10）、`onEmpty`: `'ignore'`(默认) / `'error'`

> ⚠️ **这里曾有一行「只存关键帧不存 frameCount」——它是 `replay/` 的坑，错放到了本文档。**
>
> `card/` 只有牌库（Deck），没有任何"关键帧""回放"的概念。
> 第五批审查时发现并删除。**文档内容错放比漏写更糟**：
> 漏写你会去看源码，错放你会以为这个模块真有那个功能。
