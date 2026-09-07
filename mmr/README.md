# mmr · 队伍匹配分

> 一个人排队，分数是明确的；五个人组队，"这支队伍多少分"没有标准答案。

## 1. 它解决什么

```
队伍 A：2400, 2350            → 平均 2375
队伍 B：2400, 1200            → 平均 1800
队伍 C：2375, 2375            → 平均 2375
```

A 和 C 平均分一样，但任何打过组队排位的人都知道：**A 会赢**。
原因是两件事，都必须体现在分数里：

| 效应 | 说明 | 本库处理 |
|---|---|---|
| **Carry 效应** | 顶尖玩家对胜负的影响远大于平均数 | `strategy` 加权策略 |
| **配合优势** | 开黑有语音有默契，同分下强于散人 | `partyPenalty` 加成 |

## 2. 五分钟上手

```typescript
import { teamMmr, validateParty, winProbability, fillFromPool } from './mmr/TeamMMR';

// 基础分：多种加权策略
teamMmr([{ id: 'a', rating: 2400 }, { id: 'b', rating: 1200 }]);
// → { base: 1992, penalty: 0, effective: 1992, spread: 1200, overSpread: false }

// 组队加成：2 人黑店 + 语音
teamMmr([{ id: 'a', rating: 2400, inVoice: true },
         { id: 'b', rating: 2350, inVoice: true }],
        { partyPenalty: 100, voiceMultiplier: 1.5 });
// → effective = 2379 + 150 = 2529

// 组队合法性（防代打）
validateParty([...], { maxSpread: 800 });
// → { ok: false, reason: 'spread', detail: '队内分差 1200，超过上限 800' }

// 从散人池补第 5 人
fillFromPool(party, pool);
// → { pick: {...}, result: {...} }
```

## 3. ⚠️ "惩罚"其实是"承认更强"

`partyPenalty` 这个名字有歧义——它是**加到**队伍分上的：

```
队伍分 = 基础分 + 惩罚
```

含义是"这支队伍比同等分数的散人更强，所以要给他们找更强的对手"。

## 4. ⚠️ 验证惩罚效果时，对照组必须是散人

```typescript
// ❌ 两队都组队 → 两边都加分，差异抵消，永远测不出效果
winProbability(teamA_2人, teamB_2人, { partyPenalty: 100 });

// ✅ 一边组队一边散人 → 1 人队 penalty = 0，差异才显现
winProbability(party, solo, { partyPenalty: 100 });
```

## 5. 分差越大，匹配窗口越该放宽

```typescript
suggestedWindow([{ rating: 1500 }, { rating: 1520 }], 100);   // 104
suggestedWindow([{ rating: 1200 }, { rating: 2400 }], 100);   // 300
```

队内分差大 = 我们对"这支队伍到底多强"没把握 = 窗口要放宽，
否则会反复匹配到实力严重不符的对手。

> ⚠️ **`baseWindow` 为负时区间会被倒过来算**（`min` 与 `max` 各自取真区间两端）。
> 传给它的窗口应该是正数；传了负数说明上游算错了，本模块不会替你悄悄改掉。

## 6. ⚠️ 脏数据是抛错，不是静默降级

匹配分是**开发期配置**驱动的东西，错了必须立刻炸出来：

| 情况 | 行为 |
|---|---|
| `strategy` 是未知字符串（`'average'` / `'Weighted'` / `'avg '`） | **抛错** |
| 某个玩家 `rating` 为 NaN / Infinity | **抛错，并带上玩家 id** |
| `validateParty` 遇到非法 `rating` | 返回 `{ ok: false, reason: 'rating' }` |

原因：TS 的穷尽性检查只覆盖类型内取值，
挡不住从 JSON / 配置里读进来的脏字符串。
以前 `strategy` 没有 `default` 分支，函数会**隐式返回 `undefined`**，
于是 `effective = NaN` —— 一次错都不抛，
表现为"排不到人"或"分局实力悬殊"，改一个配置字符串就能触发。

`rating` 同理：一个 NaN 会传染 `maxOf` / `minOf` / 加权求和，
再往下 `spread > maxSpread` 对 NaN 恒为 false，
**本该被拒绝的队伍被放行**——分差限制（防代练/炸鱼）在这种情况下完全失效。

> 例外：`weightBase` 为负**不是**错误（负权重在某些建模里有意义），
> 只在分母被消成 0 时退化成等权平均。详见源码注释。
