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
