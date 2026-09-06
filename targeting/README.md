# targeting — 目标锁定

## 它解决什么

动作游戏里「我按攻击键，打的是谁」。

朴素做法 `选最近的` 会导致：

- 玩家想打正前方的怪，系统却锁了身后 1 米处的 → 角色突然回头，玩家完全懵掉
- 两个怪距离几乎相同时，锁定在两者间**疯狂闪烁** → 角色来回扭头
- 目标短暂被柱子遮挡一帧，锁定就丢失 → 闪烁

## 零业务依赖

候选人只是 `{ id, x, y, selectable }`。它不认识敌人、不认识玩家。

## 用法

```typescript
import { TargetSelector, byDistance, byAngle, byStickiness } from './targeting/TargetSelector';

const sel = new TargetSelector({ hysteresis: 1.15, graceTime: 0.3 });

// 评分器：分数越高越优先
sel.addScorer(byDistance(1));     // 越近越好
sel.addScorer(byAngle(1));        // 越正对越好（最重要）
sel.addScorer(byStickiness(3));   // 保持当前目标

// 每帧
sel.originX = px; sel.originY = py; sel.facing = facing;
sel.update(dt, candidates);

if (sel.current !== null) aimAt(sel.current);
```

### 锁定模式

| 模式 | 行为 |
|---|---|
| `free` | 不锁定，每次攻击时按当前朝向选 |
| `soft` | 朝向优先，但不强制转向 |
| `hard` | 相机与朝向跟随目标 |

### 手动控制

```typescript
sel.lock(id);               // 强制锁定
sel.unlock();               // 解除
sel.cycle(candidates, 1, 0); // 按方向切换（摇杆拨动换目标）
sel.aimAngle(candidates);   // 当前目标的角度
sel.setMode('hard');        // 切锁定模式（等价于直接改 sel.mode）
sel.clearScorers();         // 清空评分器（换角色/换武器时重建）
```

## 评分器

内置三个，都是**分数越高越优先**：

| 评分器 | 默认权重 | 含义 |
|---|---|---|
| `byDistance(weight)` | 1 | 越近越好 |
| `byAngle(weight)` | 1 | 越正对越好（通常最重要的一个） |
| `byStickiness(weight)` | **10** | 保持当前目标，**防抖动**的关键 |

自定义用 `byWeight(fn, scale)`：

```typescript
sel.addScorer(byWeight((c) => c.hp / c.maxHp, 5));   // 优先打残血的
```

> **`byStickiness` 的权重远高于其他**，这是有意的。
> 三个评分器权重相同时，两个距离相近的怪会让锁定**来回抖**——
> 玩家看到的是"瞄准框在两个怪之间跳"。粘性权重给到 10 才能压住。

## 关键设计

### 迟滞（hysteresis）

新目标必须比当前目标**好 `hysteresis` 倍**才切换。

> ⚠️ 曾经的 bug：当前目标有效时直接 `return`，
> 于是 `hysteresis` **从来没有生效过**——
> 它只在当前目标失效的那一瞬间参与判定，而那种情况下根本没什么可选的。
>
> 症状：配置里写了 `hysteresis: 1.25`，
> 但目标几乎从不切换（除非当前这个死了）。
> 你去查代码会发现「迟滞明明配了啊」。

正确做法是**每帧都评估所有候选**，只是新目标要过门槛。

### 宽限期（graceTime）

目标短暂被遮挡（躲到柱子后一帧）时立刻清空会让锁定疯狂闪烁。
所以有一段宽限期，需要**真实推进 dt** 才耗尽。

### 为什么 `byAngle` 最重要

没有它的话，玩家想打正前方的怪，系统却锁了身后 1 米处的。
角色突然回头 —— 这是动作游戏最让玩家困惑的 bug 之一。

## 坑

1. **`update()` 必须传真实 dt**——传 0 的话宽限期永远不耗尽，
   表现为「目标消失了还锁着」。
2. **`selectable: false` 的候选会被跳过**——死了、无敌、在墙后的怪要设为 false，
   而不是从列表里删掉（删掉会导致索引跳变）。
3. **`current` 是 `number | null`**，不是 `-1`。
