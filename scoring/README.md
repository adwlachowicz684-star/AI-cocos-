# scoring — 战斗评分与评级

> ## ⚠️ 先别急：库里有两个评分模块
>
> | | **`scoring`（本模块）** | **`score`** |
> |---|---|---|
> | 范式 | **无状态** | **有状态** |
> | 用法 | `evaluate(values)` 一次性 | `set/add/tick` 累积 → `settle()` |
> | 适合 | **批量模拟**、离线平衡分析 | **实时追踪**、边玩边记 |
> | 评级 | 固定 `S/A/B/C/D` + 阈值表 | 可配置 `GradeDef[]` |
>
> **选择判据**：拿到一组数据直接算结果、或要跑 1000 次模拟看分布 → 用本模块；
> 需要在游戏内持续累积并随时查看当前评级 → 用 [`score`](../score/README.md)。

## 它解决什么

打完一场给个评价：S / A / B / C / D。

听起来只是个结算界面，但它的作用远不止展示：

1. **给玩家目标**：不只是「打赢」，而是「打得漂亮」
2. **教学**：玩家看到「受伤 -20 分」，自然学会去躲
3. **重玩动力**：S 评级是动作 / 肉鸽游戏最有效的重复挑战钩子
4. **平衡诊断**：如果全场玩家都拿 D，说明难度设计有问题

## 零业务依赖

指标只是 `{ id, value }`，含义由业务定义。
它不认识击杀、连击、受伤。

## 用法

```typescript
import { ScoringSystem, CombatMetrics, toNextGrade } from './scoring/ScoringSystem';

const sys = new ScoringSystem({ metrics: CombatMetrics, missingAs: 'skip' });

const r = sys.evaluate([
  { id: 'time',        value: 45 },
  { id: 'damageTaken', value: 0 },
  { id: 'maxCombo',    value: 25 },
  { id: 'kills',       value: 42 },
]);

r.total;    // 0~100
r.grade;    // 'S'
r.gaps;     // { time: 0, damageTaken: 0, maxCombo: 5, kills: 0 }

// 结算界面：告诉玩家该改什么
for (const w of sys.weakPoints(values, 3)) {
  console.log(`${w.id} 还差 ${w.gap}`);
}

// 距离下一级
toNextGrade(r.total);
```

## 核心难点：指标方向不统一

| 指标 | 方向 |
|---|---|
| 通关时间 | **越低越好** |
| 受伤次数 | **越低越好** |
| 连击数 | 越高越好 |

最常见的 bug 就是把 lower-better 的指标按 higher-better 算，
结果「打得越快分越低」——而且**不会报错**，
只是玩家觉得评级莫名其妙。

所以 `direction` **必须显式声明**，且构造时校验 par / zero。

## 关键设计

### par / zero 的方向校验

```typescript
// lower-better 要求 zero > par
{ id: 'time', direction: 'lower-better', par: 60, zero: 180 }   // ✓
{ id: 'time', direction: 'lower-better', par: 60, zero: 30  }   // ✗ 抛错
```

写反后 span 为负，兜底逻辑会让「60 秒」和「5 秒」都得 0 分——
玩家会发现「我打得飞快却拿 D」，而代码不报任何错。

所以构造时立即抛错。

### `missingAs: 'skip'`（推荐）

不同关卡的可用指标往往不同（Boss 战没有「击杀数」）。
用 `'zero'` 会让没法刷击杀的关卡**天然低分**，
玩家会困惑「为什么我打得很好却只有 B」。

skip 模式下总分按**实际参与权重**归一化，各场次之间才可比。

### 曲线

| 曲线 | 效果 |
|---|---|
| `linear` | 均匀 |
| `ease-out` | 接近满分线时变难（**推荐用于时间**：从 120s 优化到 90s 容易，从 65s 优化到 60s 难） |
| `ease-in` | 刚开始就很难拿分 |

### 预设 CombatMetrics

- `time` 用 ease-out
- `damageTaken` 权重最高（3）——**鼓励玩家去学躲，而不是堆输出硬吃**
- `maxCombo` par 设得较高（只有真正会连招的才满分）

实测结果：

| 打法 | 总分 | 评级 |
|---|---|---|
| 速通无伤流 | 95.2 | S |
| 莽夫流（快但挨打） | 65.7 | B |
| 稳妥流（慢但无伤） | 72.8 | B |

「莽夫流」比「稳妥流」分低，这在设计上传达了明确信号。

## 四个顶层函数（可单独用）

`evaluate()` 内部就靠这四个，它们都 export 了，
需要单独做某一件事时直接用，不用走一遍 `evaluate()`。

| 函数 | 说明 |
|---|---|
| `normalize(def, raw)` | 单项归一化到 0..1（**处理方向差异**） |
| `gapToPerfect(def, raw)` | 距满分的差距（"再快 3 秒就满分"） |
| `gradeOf(total, thresholds?)` | 总分 → 等级 |
| `toNextGrade(total, thresholds?)` | 距下一档还差多少分 |

另有 `metricCount`（已注册的指标数），**调试用**：
为 0 说明**构造时 `metrics` 传了空数组**，此时 `evaluate()` 会返回空数组而不是报错。

> ⚠️ **本模块没有 `addMetric()`——指标只能在构造时一次性传入。**
>
> ```typescript
> const s = new ScoringSystem({
>   metrics: [ { id: 'time', direction: 'lower-better', par: 120, zero: 300 }, ... ],
>   gradeThresholds: ...,
> });
> s.metricCount;   // 就是上面数组的长度，之后不能再加
> ```
>
> 早期文档写过"忘了 `addMetric()`"，但源码从未有过这个方法。
> 想动态增减指标的话，用 [`score`](../score/README.md)——
> 它有 `set` / `add` / `tick`，是**有状态**的那一个。

```typescript
// 关卡内实时提示：还差多少能上 S
const gap = toNextGrade(sys.total());

// 结算面板的逐项差距
for (const m of metrics) {
  row.hint = `再${gapToPerfect(m, raw).toFixed(1)} 就满分`;
}
```

> **方向差异全在 `normalize` 里。**
> 自己写 `(raw - zero) / (par - zero)` 的话，
> `lower-better`（时间）会得到负数或 >1 的值——
> 而它错得很隐蔽：只有指标是"越小越好"时才暴露。

## 坑

1. **`gapToPerfect` 已达满分时返回 0**——UI 判断要不要显示「还差 X」。
2. **`weakPoints` 按 normalized 升序**——第一个就是最该改的。
3. **`distribution()` 用于平衡**——跑 1000 场模拟看评级分布。
   60% 都是 S → 阈值太松；70% 都是 D → 太紧。
   阈值要用真实玩家数据校准，别拍脑袋。
