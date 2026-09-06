# curse · 诅咒（带代价的强化）

> 给你一个强力效果，但索取代价。

## 1. 它解决什么

```
「贪婪之血」攻击 +50%，但每层失去 1 点最大生命
「易碎护甲」  减伤 +30%，但受到暴击时伤害翻倍
「时间债」    冷却 -40%，但通关后结算分数 -20%
```

它和祝福的区别不只是"有负面"——而是**代价有独立的触发时机**。

| | 祝福 | 诅咒 |
|---|---|---|
| 效果 | 持续生效 | 持续生效 |
| 代价 | 无 | **在特定时机触发** |
| 玩家态度 | 越多越好 | 权衡要不要拿 |
| 可移除 | 一般不 | **可以**，通常要付费/满足条件 |

## 2. 五分钟上手

```typescript
const cs = new CurseSystem({
  defs,
  executor: (cost, curse) => applyCost(cost.payload),      // 注入代价执行
  checker:  (c) => gold >= c.params.amount,                // 注入移除条件检查
});

cs.add('greed_blood');
cs.tick();                    // 持续代价（每秒掉血…）
cs.trigger('crit_taken');     // 事件代价
cs.onFloorEnd();              // 每层结算
cs.onRunEnd();                // 通关结算
cs.remove('greed_blood');     // 条件满足才能移除
```

## 3. 五种触发时机

| 时机 | 用途 |
|---|---|
| `onAcquire` | 获得时立刻生效一次 |
| `tick` | 每帧（持续掉血） |
| `event` | 指定事件名（需精确匹配） |
| `onFloorEnd` | 一层结束 |
| `onRunEnd` | 一局结束（结算） |

**事件名必须精确匹配**。`'hit_taken'` 不会触发 `event: 'crit_taken'` 的代价。

### 可移除性的三种状态

| 配置 | 能否移除 | 说明 |
|---|---|---|
| 没有 `removeCondition` | **只有 `force=true` 能删** | 设计上就该跟到死 |
| 有 `removeCondition` + 注入了 `checker` | checker 返回 true 才能删 | 正常路径 |
| 有 `removeCondition` 但没注入 `checker` | **不能删** | 无法验证 = 拒绝，而不是放行 |

> **修过的 bug**：原 `remove()` 只在"有 removeCondition"时才检查，
> 于是「设计上不可移除」的诅咒（没有 removeCondition）反而被直接删掉了。
>
> ```
> canRemove('eternal') → false   UI 显示"无法移除"
> remove('eternal')    → true    代码一调用就删了
> ```
>
> 玩家会觉得"明明说不能移除，怎么突然消失了"；
> 或者更糟，某个系统路径误调 remove 直接破坏设计意图。
>
> **`canRemove()` 与 `remove()` 的结论必须一致** —— 已有测试锁住这个契约。

## 4. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| **迭代中改变集合** | 宿主在 executor 里 remove() → 某个诅咒这帧莫名不触发，不报错 | 先快照再遍历，每次重新检查 |
| 没有 checker 时移除 | 无法验证条件 | 视为不满足（保守），`force=true` 可绕过 |
| **canRemove 说不能删，remove 却能删** | UI 显示"无法移除"，代码一调用就删了 | 见第 3 节：两者必须一致 |
| allowDuplicate 用 Map 存 | 同 id 覆盖，count 永远是 1 | 累加 `stacks` 字段 |
| 增益按加法算层数 | 3 层 ×1.5 算成 4.5 | mul 用指数：`1.5³` |
| 忘了加代价 | 那就是祝福不是诅咒 | 构造时校验：无代价 → 抛错 |

## 5. 构造校验

```
无增益 → 抛错（那只是惩罚，不是诅咒）
无代价 → 抛错（那是祝福）
event 触发但没给事件名 → 抛错
```

这些在构造时就会失败，而不是等玩家拿到那个诅咒时才发现。

## 5.5 API

### 查询（做诅咒栏 UI）

| 成员 | 说明 |
|---|---|
| `active` | 当前生效的诅咒（`ActiveCurse[]`） |
| `has(id)` | 是否持有某个诅咒 |
| `costCount(id)` | 该诅咒的**代价条目数**（一个诅咒可有多个代价） |
| `effects()` | 全部效果（逐条，带来源） |
| `summary()` | 效果**聚合**成 `{ 属性: 数值 }` |

> ⚠️ **`summary()` 会把增益与减益混合计算。**
> 展示"这个诅咒具体扣了什么"用 `effects()`；
> `summary()` 只适合算最终数值。

### 抽取

`pick(rng, n, filter?)` —— 随机取 n 个可选诅咒。

> **自动排除互斥项**，候选不足 n 个时返回实际数量，**不抛错**。

### 新局与存档

| 成员 | 说明 |
|---|---|
| `clear()` | 清空全部（**开新局时必须调**） |
| `describe()` | 诊断输出（列出全部诅咒、代价、效果） |
| `exportState()` / `importState(s)` | 存档 |

> ⚠️ **`importState` 会静默跳过已删除的诅咒 id。**
> 读档后 `active.length` 可能小于存档里的条数——
> 这是**特性**（配置删了不该崩），但做"我明明有 3 个诅咒"的 UI 时要注意。

## 6. 测试覆盖

41 项。重点覆盖：五种触发时机、事件精确匹配、迭代安全、**canRemove/remove 一致性**、三种可移除状态、checker 注入、force、allowDuplicate 的层数累加、存档容错。

## 7. 依赖

零依赖，纯逻辑。

---

## 返回值结构

### `CurseDef` / `CurseEffect`

```typescript
interface CurseEffect {
  stat:  string;    // 影响的数值
  op:    CurseOp;   // 运算（add / mul / set…）
  value: number;
}

interface CurseDef {
  id, name, desc: string;
  effects:  readonly CurseEffect[];
  costs:    readonly CurseCost[];
  removeCondition: ...;      // 解除条件
  params:   Readonly<Record<string, unknown>>;
  weight:   number;          // 抽取权重
  rarity:   string;
  tags:     readonly string[];
}
```

> **诅咒是"负面但可交易"的设计**：`costs` 是获得它的代价，
> `removeCondition` 是解除它的条件。
> 两者都不填的话诅咒就是纯负收益，没人会选。

> ⚠️ **`effects` 的 `op` 决定 `value` 的含义。**
> `add` 时是加多少，`mul` 时是乘多少倍。
> 统一按加法处理会让百分比类诅咒数值爆表。