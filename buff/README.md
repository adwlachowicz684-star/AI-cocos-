# buff — 增益与减益系统

## 与 Modifier 的分工

```
BuffSystem（生命周期）→ 变化时回调 → 外部重建 ModifierSet → 数值生效
```

本类只管**生命周期**（什么时候加、什么时候删、叠几层、多久 tick 一次），
具体数值效果委托给 `damage-pipeline/Modifier`。职责清晰，也避免了
BuffSystem 依赖具体的属性系统。

## 用法

```typescript
import { BuffSystem } from './buff/BuffSystem';

const buffs = new BuffSystem();

buffs.onChange((change) => {
  mods.clear();
  for (const b of buffs.active) mods.add(b.def.modifier);
});

buffs.register({ id: 'poison', duration: 5, maxStacks: 5,
                 stackMode: 'refresh', tickInterval: 1 });
buffs.register({ id: 'rage', duration: 8, tags: ['buff'] });

buffs.apply('poison');        // 叠 1 层
buffs.apply('poison', 2);     // 叠 3 层
buffs.stacks('poison');       // 3

// 每帧
buffs.update(dt, (id, stacks) => {
  if (id === 'poison') dealDamage(10 * stacks);   // DoT
});

buffs.removeByTag('debuff');  // 驱散
buffs.clearOnDeath();         // 死亡清理
```

## 三种叠加模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `refresh`（默认） | 重置持续时间，层数上限由 maxStacks 控制 | 大多数 buff |
| `extend` | 层数不变，剩余时间累加 | 时间类 buff（"再延长 5 秒"） |
| `independent` | 每次应用都是独立实例，各自计时 | 需要独立衰减的效果 |

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 每帧重建 ModifierSet | 性能浪费 | 只在 `onChange` 时重建 |
| tick 计时器只在传回调时推进 | **中毒掉血忽快忽慢** | 已修：计时器总是推进 |
| 多个角色共用一个 BuffSystem | 层数串了 | 每个角色一个实例 |
| 忘了 `clearOnDeath` | 死亡后 buff 残留 | 用 `clearOnDeath()` |
| 不可驱散的 Boss buff 没标 `dispellable: false` | 被玩家净化掉 | 显式标注 |

## API

| 成员 | 说明 |
|---|---|
| `register(def)` | 注册定义 |
| `apply(id, stacks?)` | 应用，返回实际层数 |
| `remove(id, stacks?)` | 移除（默认全移除） |
| `removeByTag(tag)` / `dispelAll()` | 批量驱散（跳过 `dispellable: false`） |
| `clearOnDeath()` | 只清 `clearOnDeath !== false` 的 |
| `update(dt, onTick?)` | 每帧推进，onTick 用于 DoT/HoT |
| `stacks(id)` / `remain(id)` / `has(id)` | 查询 |
| `onChange(fn)` | 订阅变更（**多播**，返回取消函数；在这里重建 ModifierSet） |
| `export()` / `import()` | 存档（含剩余时间与层数） |
| `count()` | 当前生效的 buff **种类数**（不是总层数） |
| `destroy()` | 释放（**之后 onChange 不再触发**） |

> ⚠️ **`count()` 是"种类数"，不是"总层数"。**
> 一个 3 层的燃烧 + 一个 1 层的护盾，`count()` 是 2 不是 4。
> 拿它算"总层数"会少算——
> 表现为"UI 上显示 2 层但实际有 4 层效果"。

> ⚠️ **`onChange` 是多播：注册多个监听器互不影响。**
> 早期实现是 `this._onChange = fn` 直接赋值，**第二次注册会静默顶掉第一次**。
> 后果很隐蔽：UI 层（刷图标）和数值层（重建 ModifierSet）都订阅时，
> 后注册的那个生效、先注册的那个彻底失联——
> 表现为"图标还在，但属性没变"，且没有任何报错。
> 返回的取消函数只摘掉自己，不影响其它监听器。

> ⚠️ **`clear()` 会逐个 buff 发一次 `remove`，再发一次 `clear`。**
> 只监听 `remove` 的依赖方（逐个图标的 UI 最常见）
> 以前在 `clear()` 之后收不到任何单个 buff 的移除通知，
> 表现为"人已经死了，状态栏图标还挂着"。两类事件现在都会发。

> ⚠️ **`import()` 会校验并收口存档数据，不是原样写入。**
> `remain` 为 NaN / 非正数 → 回落到 `def.duration`（`remain = 0` 则跳过该条）；
> `stacks` 会被夹到 `maxStacks`；`independent` 模式会重建逐层实例。
> 早期实现绕过校验直接写内部字段，坏存档能造出**永不消失的中毒**
> （`remain = NaN` → `NaN <= 0` 恒 false → 永不过期）和超出上限的层数。
> 若你的存档里有合法但超上限的旧数据，读档后层数会被夹到 `maxStacks`——这是刻意的。

> ⚠️ **`destroy()` 之后 `onChange` 不再触发。**
> 换场景时如果只 `dispelAll()` 不 `destroy()`，
> 旧场景的回调还挂着——新场景里加 buff 时会触发上一局的刷新逻辑，
> 表现为"属性莫名被改"。

## BuffDef 字段

| 字段 | 说明 |
|---|---|
| `duration` | 秒。永久用 `Infinity` |
| `maxStacks` | 最大层数（默认 1） |
| `stackMode` | `refresh` / `extend` / `independent` |
| `tickInterval` | tick 间隔（DoT/HoT 用） |
| `dispellable` | false = 不可驱散 |
| `clearOnDeath` | false = 死亡不清除 |
| `tags` | 分组标签（"移除所有 debuff"） |

## ⚠️ 异常 dt 会被静默丢弃（不是抛错）

```typescript
buff.update(NaN);        // 什么都不做
buff.update(Infinity);   // 什么都不做
buff.update(-1);         // 什么都不做
buff.update(0);          // 什么都不做
```

**为什么必须这么做**（而不是照常推进）：

- `remain -= NaN` 会让 `remain` 变 `NaN`，此后 `remain <= 0` 恒为 `false`
  → **buff 永不消失**，中毒/减益永久挂在角色身上，不报错、不可自愈
- 负 `dt` 会让 `remain` **反向增大**，同样是永不消失
- `Infinity` 会让 tick 循环**永久死循环**（`Infinity - 0.1` 仍是 `Infinity`）

判断标准是 `safeDt(dt)`：只有"有限且为正"才推进。
想确认某帧有没有生效，比较调用前后的 `remain` 即可。

## ⚠️ 长卡顿帧的 tick 会被截断（上限 64 次）

```typescript
buff.register({ id: 'dot', duration: 5, tickInterval: 0.1 });
buff.update(0.5);   // onTick 5 次   ✅ 正常
buff.update(100);   // onTick 64 次  ← 不是 1000 次
buff.update(1e9);   // onTick 64 次  ← 同样截断
```

**为什么截断**：一帧补 1000 次 DoT 伤害，等于把一次卡顿放大成"角色瞬间暴毙"。
上限 64 与 `bullet-pattern` 对齐，超出的部分直接丢弃——
**宁可少跳几下伤害，也不要让卡顿变成卡死或暴毙。**

截断后 `tickTimer` 会被重置到一个正的起点，下一帧不会继续累积。

**什么时候会碰到**：`tickInterval × 64` 秒以上的卡顿。
例如 `tickInterval=0.1` 时是 6.4 秒——正常游戏帧远达不到，
通常只在"切后台很久再切回来"时出现，此时截断反而是你要的行为。
