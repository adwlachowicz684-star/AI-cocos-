# DamagePipeline

分阶段伤害计算。这是整个库最值钱的插件——**所有游戏都用得上**。

## 为什么阶段化

伤害计算永远在变：加个元素抗性、加个背刺加成、加个难度系数……
如果写成一个大函数，每次改动都要在函数内部插代码，越改越乱。

做成一串 stage 后：

> **加一个机制 = 插入一个 stage，原有代码一行不动。**

这就是「开闭原则」的具体实践。

## 用法

```typescript
import { DamagePipeline } from './damage-pipeline/DamagePipeline';
import { IDamageable } from './damage-pipeline/IDamageable';

// 1. 你的目标只需实现这个最小契约
class Enemy implements IDamageable {
  hp = 100;
  maxHp = 100;
  armor = 20;
  resistances = { fire: 0.5, ice: -0.3 };   // 火抗 50%，冰易伤 30%

  applyDamage(result, ctx) {
    this.hp -= result.value;
  }
  isAlive() { return this.hp > 0; }
}

// 2. 创建默认管线
const dmg = DamagePipeline.createDefault();

// 3. 外部插入自定义阶段（遗物 / buff 注入自己的规则）
dmg.addStage('relic_fire', (v, ctx) => ctx.type === 'fire' ? v * 1.25 : v, 35);

// 4. 打一下
const result = dmg.apply({ raw: 20, type: 'fire', crit: true }, enemy);

console.log(result.value);   // 最终伤害
console.log(result.stages);  // [{name:'base',value:20}, {name:'crit',value:40}, ...]
```

## 默认阶段顺序

| order | 阶段 | 说明 |
|---|---|---|
| 10 | `crit` | 暴击倍率 |
| 20 | — | **留给调用方插入**（order 用 10 的倍数就是为此） |
| 30 | `resist` | 元素抗性，clamp 到 [-1, 0.9] |
| 40 | `armor` | 护甲，除法公式 |
| — | （内置） | 取整 + 最低伤害保底 |

## 两个必须记住的公式

### ① 护甲用除法，不用减法

```typescript
// ❌ 减法
dmg - armor
// 问题：armor > dmg 时出负伤害（打人反而加血）；高护甲时完全免疫

// ✅ 除法
dmg * (100 / (100 + armor))
// 收益递减，永远不会归零 —— 行业标准做法
```

### ② 抗性语义

```
resist = +0.5  →  减伤 50%（v × 0.5）
resist = -0.3  →  易伤 30%（v × 1.3）
```

**上限必须 < 1**。允许 `resist = 1` 会让玩家遇到「怎么打都打不动」的敌人——
那是设计事故，不是难度。这里 clamp 到 0.9（最多减伤 90%）。

## 计算与表现分离

`calculate()` 是**纯函数**——不扣血、不播特效、不发事件。
`apply()` 才产生副作用，并通过 `onResult` 通知表现层。

```typescript
// 表现层订阅（飘字 / 特效 / 音效 / 统计各自订阅）
dmg.onResult((r, ctx, target) => {
  floatingText.show(r.value, r.isCrit);
  hitFeedback.play(r);
  stats.record(r);
});

// 批量模拟（无表现）→ 一秒跑几千次验证平衡
for (let i = 0; i < 10000; i++) {
  results.push(dmg.calculate({ raw: 20 }, enemy).value);
}
```

> **如果表现和计算耦合，批量模拟就跑不起来。**
> 而平衡调整非常依赖它——「凭感觉这把武器有点强」不如
> 「模拟 10000 次，期望 DPS 是 47.3」。

## 坑

- **护甲用减法** → 负伤害 / 完全免疫，平衡崩坏
- **中间就取整** → 小数值的百分比加成全部失效。**取整必须在最后一步**
- **stage 有副作用**（如直接扣血）→ 无法单测、无法重试、无法批量模拟
- **抗性没设上限** → 堆到 100% 无敌
- **伤害类型用枚举写死** → 加新类型要改所有 switch。用开放字符串
- **多段伤害没去重** → 一刀秒杀 Boss。用 `hitId` + 已命中集合

## API

| 成员 | 说明 |
|---|---|
| `addStage(name, fn, order, record?)` | 插入阶段（order 小的先执行） |
| `removeStage(name)` | 移除 |
| `calculate(ctx, target)` | **纯计算**，返回 DamageResult |
| `apply(ctx, target)` | 计算 + 写入 + 通知 |
| `simulate(ctx, target, times)` | 批量模拟（无副作用） |
| `onResult(fn)` | 订阅结果（返回取消函数） |
| `destroy()` | 清空 |

### DamageResult

```typescript
{
  value: number;      // 最终伤害
  isCrit: boolean;
  type: string;
  stages: [{ name, value }];   // 每个阶段的中间值（调试与 UI 展示）
  immune: boolean;             // 被完全免疫
}
```

`stages` 让你能显示「基础 20 → 暴击 40 → 遗物 50 → 护甲后 42」，
玩家看得懂伤害是怎么算出来的。

### `ModifierSet`（同文件的第二个类）

`DamagePipeline` 管**伤害计算流程**，`ModifierSet` 管**一组修正器**。
后者被 `attribute/` 与 `buff/` 共用。

| 成员 | 说明 |
|---|---|
| `add(attr, entry)` | 添加一个，返回**移除函数** |
| `remove(attr, id)` | 按 id 移除 |
| `removeBySource(attr, source)` | 按 source 移除，返回移除数量（**换装备用这个**） |
| `clearByTag(attr, tag)` | 按标签批量移除（「移除全部 debuff」） |
| `clearTagEverywhere(tag)` | 跨所有属性按标签移除 |
| `get(attr)` | 取该属性的最终值 |
| `count(attr)` | 修正器条数 |
| `dump(attr)` | 取全部条目（**调试面板用**，看每个加成的来源） |

> ⚠️ **`dump()` 返回的是内部数组引用，不是副本。**
>
> 类型签名的 `readonly` 只是**编译期**约束，运行时并没有拷贝：
>
> ```typescript
> const d = set.dump('atk');        // readonly ModifierEntry[]
> (d as unknown as any[]).push({ type: 'add', value: 999 });
> set.get('atk', 100);              // → 1109，状态真的被改了
> set.count('atk');                 // → 2
> ```
>
> 【为什么危险】存档时常见的做法是把 `dump('atk')` 的结果直接写进存档。
> 若中间有代码为"临时加个 buff 看看效果"而 push，存档就被污染了，
> 而这类改动在类型检查下完全隐形。
>
> 要副本就自己 `slice()`。
| `clear(attr?)` | 清空（不传 attr = 全清） |

```typescript
// 净化：移除全部标记为 debuff 的
const n = mods.clearByTag('atk', 'debuff');

// 换武器：精确移除旧武器的贡献，不影响其他来源
mods.removeBySource('atk', 'weapon');
```

> ⚠️ **`add` 返回的移除函数优先于 `remove(id)`。**
> 闭包捕获了确切的那一条，不会误删；
> `remove(id)` 在 id 重复时会删错对象，而这种重复**不报错**。
