# element — 元素反应

## 它解决什么

「水 + 火 = 蒸发」「火 + 雷 = 超载」这类元素反应。

朴素做法是写一堆 if-else：

```typescript
if (target.element === 'water' && applied === 'fire') { /* ... */ }
```

问题是反应一多就变成面条，而且**配置无法校验**——
你写了 6 种元素，很容易漏配其中几对组合，且不会报错。

## 零业务依赖

这是本模块最关键的设计：

> **反应定义里没有 `damage` 字段。**

```typescript
{ id: 'vaporize', base: 'water', applied: 'fire', consumeAll: true,
  data: { damage: 60 } }        // ← 效果在 data 里，由业务解释
```

系统只回答两件事：**发生了什么反应**、**消耗多少元素**。
伤害、范围、眩晕这些「效果」完全由业务决定。

## 用法

```typescript
import { ElementSystem, validateReactions } from './element/ElementSystem';

const es = new ElementSystem({
  elements: [
    { id: 'fire',  decay: 8,  maxGauge: 100 },
    { id: 'water', decay: 6,  maxGauge: 100 },
    { id: 'shock', decay: 10, maxGauge: 100 },
  ],
  reactions: [
    { id: 'vaporize', base: 'water', applied: 'fire',  consumeAll: true,  data: { damage: 60 } },
    { id: 'overload', base: 'fire',  applied: 'shock', consumeAll: true,  data: { damage: 90, aoe: 4 } },
    { id: 'conduct',  base: 'water', applied: 'shock', gaugeCost: 10, consumeAll: false, data: { stun: 2 } },
  ],
});

es.apply(targetId, 'water', 60);          // 附着水
const r = es.apply(targetId, 'fire', 50); // 触发反应
if (r.reactionId) {
  const d = r.data as { damage?: number };
  dealDamage(targetId, d.damage ?? 0);
}

es.tick(dt);   // 衰减，必须每帧调用
```

### 配置校验

```typescript
const v = validateReactions(elements, reactions);
// v.errors   —— 引用了未定义元素等硬错误
// v.warnings —— 某对元素没有配反应、反应不对称等
```

两个元素之间没有配反应时会给出警告——
这是最容易漏的地方，因为**漏了不会报错，只是「这技能不反应」**。

## 关键设计

### `consumeAll` vs `gaugeCost`

| 配置 | 行为 | 典型 |
|---|---|---|
| `consumeAll: true` | 反应后 base 清零 | 蒸发、超载（完全反应） |
| `consumeAll: false` + `gaugeCost` | 按比例消耗，base 残留 | 感电（还剩水，能继续触发蒸发） |

**残留设计是元素玩法深度的来源**——它让反应可以串联。

### 衰减到 0 时清空元素类型

不是留着「0 量的火」，而是彻底清空。
否则 `elementOf()` 会返回一个没有意义的值，
UI 也会显示一个空的火图标。

### 未知元素抛错，不静默忽略

「这技能不反应」是极难排查的问题——
可能是配置漏了，可能是 id 拼错，可能是元素没定义。

静默忽略会让问题潜伏到几周后。构造时和运行时都会立即抛错。

## API

| 成员 | 说明 |
|---|---|
| `apply(id, element, amount)` | 附着元素，**返回反应结果**（没触发反应时 `null`） |
| `elementOf(id)` | 当前附着的元素 |
| `gaugeOf(id)` | 附着量（**元素量表**） |
| `ratioOf(id)` | 附着量比例 0..1（**UI 显示元素图标的填充**） |
| `peek(id)` | 取完整状态（元素 + 量表，不修改） |
| `set(id, element, amount)` | 直接设置（**测试与 GM 指令用**，正常流程走 `apply`） |
| `clear(id)` | 清除单个目标的元素 |
| `clearAll()` | 清除全部（**换关卡调**） |
| `tick(dt)` | 推进衰减 |
| `activeCount` | 有元素附着的目标数 |

### 判断反应是否触发

```typescript
const r = es.apply(targetId, 'fire', 50);
if (r) {
  // r.reaction / r.damage / r.consumed
}
```

> ⚠️ **`apply` 的返回值必须判空。**
> 不判空直接取 `r.damage` 的话，
> 「没反应」的那一帧会崩——而这恰恰是绝大多数帧的情况。

### `validateReactions(defs)`（配置校验）

启动时跑一次，检查反应定义有没有环、id 冲突、产物未定义。
**配表改错时在这里报错，比运行时某个元素莫名失效好查得多。**

## 坑

1. **`maxGauge` 防止一次打出巨额反应**——不设上限的话，
   玩家疯狂叠同一元素然后一次引爆，数值会失控。
2. **`decay: 0` = 永不衰减**——某些特殊元素可以这样配，但要小心。
3. **`peek()` 不改变状态**——用于 UI 预览「接下来会触发什么」。

---

## 返回值结构

### `ReactionResult`

```typescript
interface ReactionResult {
  reactionId:     string;    // 触发的反应 id（未触发时为空串）
  baseElement:    string;    // 原有附着元素
  baseGauge:      number;    // **反应前**的附着量
  appliedElement: string;    // 本次施加的元素
  remainingGauge: number;    // 反应后**剩余**的附着量
  data:           unknown;   // 反应自定义数据
}
```

> ⚠️ **必须判 `reactionId`，不能只看返回了对象。**
> 没触发反应时也会返回 `ReactionResult`，
> 只是 `reactionId` 是空串。
> 不判的话"没反应"也被当成"触发了反应"处理。

> **`remainingGauge` 是反应之后的量，不是消耗掉的量。**
> 想算"消耗了多少"要自己 `baseGauge - remainingGauge`。