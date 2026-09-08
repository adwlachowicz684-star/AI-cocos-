# score · 有状态评分追踪器

> 边玩边记，最后一次性结算。

## 1. 它解决什么

战斗评分系统需要**在游戏过程中持续累积数据**（时间、受伤、连击），
然后在关卡结束时给出一个评级。

## 2. ⚠️ 它和 `scoring` 的区别（别选错）

库里有两个评分模块，这不是重复，是**两种范式**：

| | **`score`（本模块）** | **`scoring`** |
|---|---|---|
| 范式 | **有状态** | **无状态** |
| 用法 | `set/add/tick` 累积 → `settle()` | `evaluate(values)` 一次性 |
| 内部 | 持有当前值，可随时读 | 纯函数，不保存任何东西 |
| 评级 | 可配置 `GradeDef[]`（带 id/name/data） | 固定 `S/A/B/C/D` + 阈值表 |
| 评级方式 | `weighted` / `minimum` / `weighted-with-floor` | 加权平均 |
| 适合 | **实时追踪**、边玩边记 | **批量模拟**、离线平衡分析 |
| 典型场景 | 关卡内的 HUD 实时显示 | 跑 1000 次模拟看评级分布 |

**选择判据**：

- 需要在游戏中持续累积、随时查看当前评级 → **`score`**
- 拿到一组数据直接算结果、或要批量跑模拟 → **`scoring`**

## 3. 五分钟上手

```typescript
const sys = new ScoreSystem({
  metrics: [
    { id: 'time',   direction: 'lower-better',  weight: 1,   par: 60, zero: 180 },
    { id: 'damage', direction: 'lower-better',  weight: 1.5, par: 0,  zero: 5 },
    { id: 'combo',  direction: 'higher-better', weight: 1,   par: 20, zero: 0 },
  ],
  grades: DEFAULT_GRADES,          // S/A/B/C/D，也可自定义
  mode: 'weighted-with-floor',     // 有短板就降级
  floor: 20,
});

// 游戏过程中
sys.tick(dt);
sys.set('damage', 2);
sys.add('combo', 1);

// 关卡结束
const { grade, score, breakdown } = sys.settle();
```

## 4. 指标方向

| 方向 | 语义 | par | zero |
|---|---|---|---|
| `lower-better` | 越小越好（时间、受伤） | ≤ par 满分 | ≥ zero 零分 |
| `higher-better` | 越大越好（连击、击杀） | ≥ par 满分 | ≤ zero 零分 |

**`zero` 是必须的**：只有 par 的话，"超了 par 一点点"和"超了 10 倍"没区别，
评级会失去区分度。

## 5. 三种评级方式

| mode | 行为 | 用途 |
|---|---|---|
| `weighted`（默认） | 加权平均 | 通用 |
| `minimum` | 取最低分 | 硬核：所有维度都要达标 |
| `weighted-with-floor` | 加权平均，但任一维度低于 `floor` 则封顶到最低档 | **推荐**："时间满分但死了 20 次"不该拿 S |

> ⚠️ **`weighted-with-floor` 是一票否决，比"加权"严厉得多。**
> 只要有**一个**维度低于 `floor`（默认 20），
> 总分会被直接压到最低档的 `minScore`（通常是 **0**），
> 其余维度考得再好也不计入——不是"扣一点分"，是"归零"。
>
> 实测（两指标等权重，一科 100 分、另一科 10 分，floor=20）：
> 加权平均应是 55，实际 `total()` = 0，评级 = 最低档。
>
> 想用这个模式，先在配表里确认 `floor` 相对各维度分数量级是否合理，
> 否则玩家会遇到"明明打得不错却拿 D"且看不出原因。

## 6. 超额奖励

优于 par 的部分可以继续加分（默认上限 150）：

```
时间 par=60，实际 30 秒 → t=2 → 100 + (2-1)×50 = 150（封顶）
```

用 `allowOvershoot: false` 关闭（封顶 100）。

## 7. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| **评级表没按降序排** | 评级逻辑错乱 | 构造时校验并抛错，错误信息指出哪两个顺序错了 |
| `lower-better` 的 zero ≤ par | 分数反向 | 构造时校验 |
| 负权重 | 总分算错 | 构造时校验 |
| `tick(负dt)` | 时间倒流 | 忽略负 dt |
| `reset()` 后读值 | 期望是 0 | lower-better 重置为 `zero`，higher-better 重置为 0 |
| 忘了区分两种范式 | 选错模块 | 见第 2 节对比表 |

## 8. StarRating（休闲游戏常用）

和字母评级的区别：**星级是"达成几个条件"，字母是"加权总分"**。
星级更适合玩家一眼看懂，字母更适合表达细腻差距。

```typescript
const stars = new StarRating(3);
stars
  .addCondition((c) => c.noDamage)
  .addCondition((c) => c.time < 60)
  .addCondition((c) => c.allCollected);

stars.evaluate(result);   // → 0~3
```

条件数超过星级数时抛错；`addCondition` 返回 `this` 支持链式。

## 8.5 API

### `ScoreSystem`

| 成员 | 说明 |
|---|---|
| `tick(dt)` | 推进计时（**负 dt 会被忽略**） |
| `set(id, v)` / `add(id, n)` | 设置 / 累加指标（**非有限值直接抛错**，见下） |
| `breakdown()` | 各指标得分明细（**做结算面板的逐项展示**） |
| `total()` | 总分（0~100+，**可能超过 100**，超额奖励见第 6 节） |
| `settle()` | 结算，返回 `{ grade, score, breakdown }` |
| `toNextGrade()` | 距下一档还差多少（`{ next, need }`） |
| `reset()` | 重置（lower-better 重置为 `zero`，higher-better 重置为 0） |
| `destroy()` | 卸载：重置并摘掉 `onGrade` 回调 |

> ⚠️ **`set` / `add` 收到 NaN、Infinity 会抛错，不会静默写进去。**
> 旧实现不校验，于是一次 `add('kills', NaN)`（值来自 UI / 网络 / 未初始化字段）
> 就会让 `total()` 变成 NaN，而 `grade()` 的兜底返回最后一档——
> **看起来"评级功能正常"，实际是 NaN 把所有 `s >= minScore` 都短路成了 false**，
> 玩家永远拿最低档且日志里什么都没有。
> 现在在写入那一行就炸，问题定位到录入处而不是结算画面。

### 计时器

| 成员 | 说明 |
|---|---|
| `startTimer()` | **归零**并重新开始计时（不是"启动"） |
| `elapsed` | 已累计时间 |

> ⚠️ **`startTimer()` 是"归零重来"，不是"开始计时"。**
> 它把内部计数清 0，而计时**从 `tick(dt)` 累加**。
> 也就是说不调 `startTimer()` 也能计时——
> 想重新开始一轮才需要它。
>
> 命名容易误导，但改名字会破坏已有调用方。

### `StarRating`

| 成员 | 说明 |
|---|---|
| `addCondition(fn)` | 加条件，返回 `this`（链式） |
| `evaluate(ctx)` | 评定，返回达成数 |
| `max` | 最大星级 |
| `stars` | 当前星级（**至少 1 星**，0 星被夹到 1） |

> **0 星会被夹成 1 星**（`Math.max(1, stars)`）。
> 一个条件都没达成也显示 1 星——这是有意的，
> 0 星会让玩家觉得"白玩了"。要显示 0 星自己判 `evaluate() === 0`。
>
> ⚠️ 夹取用的是**肯定式** `!(stars >= 1)` 而不是 `stars < 1`：
> `Math.max(1, NaN)` 得到的是 **NaN 而不是 1**，
> NaN 星级会让 `addCondition` 的条数上限（`length >= max`）恒为 false，
> 于是可以无限加条件、评出超过星级的星数。

## 9. 测试覆盖

29 项。重点覆盖：两种方向的插值与边界、超额奖励与封顶、三种评级模式、
reset 的初始值、计时器（含负 dt）、settle/onGrade、toNextGrade、
五项构造校验、Metrics 预设、StarRating 边界。

## 10. 依赖

零依赖，纯逻辑。
