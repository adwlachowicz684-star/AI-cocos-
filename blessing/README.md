# blessing · 祝福系统

> 正向增益的堆叠管理。核心是**递减**：20 层不该是 1 层的 20 倍。

## 1. 它解决什么

祝福（Boon / Blessing）是肉鸽里"越拿越强"的正反馈来源。
但要处理好三件事：

1. **堆叠上限**：某些祝福不能无限叠
2. **递减**：线性叠加下数值曲线会彻底失控
3. **互斥**：两个设计上冲突的祝福不能同时生效

## 2. 五分钟上手

```typescript
const sys = new BlessingSystem({
  defs: [
    { id: 'atk', name: '力量', effects: [{ stat: 'atk', op: 'add', perStack: 5 }] },
    {
      id: 'haste', name: '疾风',
      effects: [{ stat: 'spd', op: 'add', perStack: 3 }],
      softCap: 5, falloff: 0.5,     // 超过 5 层的部分打 5 折
    },
  ],
  onConflict: 'reject',
});

sys.add('haste', 8);
sys.stacks('haste');            // 8      实际层数
sys.effectiveStacks('haste');   // 6.5    递减后
sys.effectsOf('haste');         // [{ stat:'spd', op:'add', value: 19.5 }]
```

## 3. 递减公式

```
有效层数 = min(n, softCap) + max(0, n - softCap) × falloff
```

`softCap=5, falloff=0.5, n=8` → `5 + 3×0.5 = 6.5`

**递减是打折不是截断** —— 多拿仍然有用，只是不再指数爆炸。

## 4. 互斥策略

| 模式 | 行为 |
|---|---|
| `reject`（默认） | 冲突时拒绝添加 |
| `replace` | 移除旧的，添加新的 |
| `coexist` | 允许共存 |

**互斥是双向的**：`a.excludes = ['b']` 无论先拿到哪个都互斥。

> **修过的 bug**：原实现有 `if (!def.excludes) return null` 的 early return，
> 导致"先 a 后 b"能共存、"先 b 后 a"被拒绝——
> **同一份配置，换个添加顺序结果就不同**。
> 配表的人写的是"a 和 b 互斥"，他想不到这还取决于玩家先拿到哪个。

## 5. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| `add()` 返回值含义 | 第 4 节 | 返回**实际添加的层数**（可能被 maxStacks 夹紧），不是总数 |
| `remove()` 返回值含义 | 第 4 节 | 返回**移除的层数**，不是剩余 |
| 未知 id | 静默失败 | 抛错（防拼写） |
| 忘记递减 | 数值爆炸 | 给长期堆叠的祝福配 softCap |

## 5.5 API

### 查询（做祝福列表 UI）

| 成员 | 说明 |
|---|---|
| `owned()` | 当前持有的祝福，返回 `BlessingStack[]`（含 `def` / `stacks` / `effective`） |
| `count` | **种类数**，不是总层数 |
| `stacks(id)` | 某祝福的层数 |
| `effectiveStacks(id)` | 递减后的**有效**层数 |
| `effects()` / `effectsOf(id)` | 效果列表 |
| `summary()` | 把效果**聚合成** `{ 属性: 数值 }` |

> ⚠️ **`count` 是种类数，不是总层数。**
> 持有「攻击+3 层、暴击+2 层」时 `count === 2`。
> 想显示"共 5 层"要自己累加 `stacks()`。

> ⚠️ **`summary()` 会把 add / mul / set 混成一个数。**
> 它不是"把所有加成加起来"，而是按类型聚合后套用公式。
> 想逐条展示"哪件给了多少"用 `effects()`，别用 `summary()`。

### 抽取（三选一奖励）

| 成员 | 说明 |
|---|---|
| `pick(rng, n, filter?)` | 随机取 n 个可选祝福 |
| `wouldConflict(id)` | 若添加它会与谁冲突，返回冲突 id 或 `null` |

```typescript
const choices = sys.pick(rng, 3);
for (const d of choices) {
  const bad = sys.wouldConflict(d.id);   // 灰显会冲突的选项
  card.disabled = bad !== null;
}
```

> **`pick` 会自动排除已满层与互斥项**——不用自己在外层过滤。
> 候选不足 `n` 个时**返回实际数量，不抛错**。

### 新局与存档

| 成员 | 说明 |
|---|---|
| `clear()` | 清空全部持有（**开新局 / 换存档时必须调**） |
| `exportState()` / `importState(s)` | 存档 |
| `describe()` | 诊断输出 |

> ⚠️ **`onChange` 在 `clear()` 会触发，在 `importState()` 不会。**
>
> 这是有意的：读档时逐条触发回调会产生大量无意义的 UI 重绘
> （甚至在你还没初始化 UI 时就触发）。
> 所以**读档后要自己刷一次 UI**，不能依赖 `onChange`。
>
> `importState` 另外会：`maxStacks` 夹紧层数、静默忽略已删除的 def。

## 6. 测试覆盖

29 项。重点覆盖：递减公式、堆叠上限、**互斥双向性（不依赖添加顺序）**、三种冲突策略、存档容错。

## 7. 依赖

零依赖，纯逻辑。
