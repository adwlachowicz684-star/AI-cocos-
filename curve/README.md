# curve — 关键帧曲线

## 与 Easing 的区别

| | Easing | Curve |
|---|---|---|
| 本质 | 固定的数学函数 | **任意形状**，由关键帧定义 |
| 表达 | "0→1 的变化节奏" | "先升后降"这种自定义形状 |

## 典型用途

- 冲刺速度曲线：起步爆发，末端衰减（比匀速自然得多）
- 技能伤害窗口：第 10 帧 100%，其余 0
- 掉落物抛物线：先上后下
- 难度曲线：第 1 层 1.0 倍血量，第 10 层 2.3 倍

## 用法

```typescript
import { Curve } from './curve/Curve';

const dashSpeed = new Curve([
  { time: 0,    value: 25 },
  { time: 0.15, value: 18 },
  { time: 0.4,  value: 2  },
]);

dashSpeed.evaluate(0.1);              // ≈20.6（线性插值）
dashSpeed.evaluate(0.1, 'smooth');    // 平滑插值
dashSpeed.evaluateNormalized(0.5);    // 按 0–1 归一化求值

Curve.fromArray([[0,0], [0.5,1], [1,0]]);
Curve.constant(5);
```

## 插值模式

| 模式 | 特点 |
|---|---|
| `linear` | 线性。关键帧较少时明显折线感 |
| `smooth` | smoothstep，端点导数为 0，过渡更自然 |
| `step` | 阶梯。取左关键帧的值（用于伤害窗口） |

### 类型

```typescript
type InterpMode  = 'linear' | 'step' | 'smooth';
type TangentMode = 'auto' | 'linear' | 'flat';

interface Keyframe { readonly time: number; readonly value: number }
```

> ⚠️ **`TangentMode` 只在 `smooth` 插值下有意义。**
> `linear` 和 `step` 模式传了 `TangentMode` 不报错——**直接被忽略**，
> 表现为"我改了切线模式怎么曲线没变"。

| `TangentMode` | 说明 |
|---|---|
| `auto` | 按相邻关键帧自动算切线（最常用） |
| `linear` | 切线指向邻点，接近分段线性 |
| `flat` | 切线水平，关键帧处导数为 0（**局部极值**） |

> **`flat` 适合表达"到顶/到底"的关键帧。**
> 比如跳跃曲线的最高点用 `flat`，
> 用 `auto` 的话会冲过头再回落。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 超出范围抛异常 | 浮点误差 `t=1.0000001` 就崩，极难复现 | 已 clamp，不抛错 |
| 关键帧乱序 | 求值错误 | 构造时自动排序 |
| 直接改共享曲线的关键帧 | 所有引用它的地方都变了 | 用 `clone()` |
| 想用 `easeOutQuad` 这类名字 | 不存在（那是 Easing 的概念） | Curve 用关键帧定义形状 |

## API

| 成员 | 说明 |
|---|---|
| `addKey(time, value)` | 添加关键帧（自动排序） |
| `evaluate(time, mode?)` | 求值（超范围 clamp） |
| `evaluateNormalized(u, mode?)` | 按 0–1 求值 |
| `integrate(samples?, mode?)` | 曲线下积分（算总位移） |
| `duration` / `startTime` / `endTime` | 时间范围 |
| `minValue` / `maxValue` | 值域 |
| `clone()` | 克隆（避免污染模板） |
| `keyCount` | 关键帧数量 |
| `toKeyframes()` | 导出关键帧数组（**存档 / 可视化编辑器**用） |
| `destroy()` | 释放（**之后不能再 evaluate**） |

> ⚠️ **`toKeyframes()` 与构造时的关键帧数组不一定相同。**
> 它返回的是**排序后**的内部数组——
> 构造时乱序传入的话，两者顺序不同。
> 拿它做存档是安全的（已排序），
> 但拿它和原始配置做 diff 会得到一堆假差异。

> ⚠️ **`destroy()` 之后不能再 `evaluate()`。**
> 换场景时如果只丢引用不 `destroy()`，
> 曲线数据还占着内存——对少量曲线无所谓，
> 但"每个敌人一条曲线"这种用法下会累积。

> **`keyCount` 为 0 时 `evaluate()` 返回什么由实现决定，别依赖。**
> 空曲线是无效状态，构造时应至少给一个关键帧。
