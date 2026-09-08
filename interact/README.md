# interact · 环境互动（可交互物与触发器）

> 玩家按 E 时，到底该开哪个箱子？

## 1. 它解决什么

关卡里散布着宝箱、门、拉杆、NPC、可破坏的罐子……
手写时这些都变成散落各处的 `if (distance < 2 && pressed('E'))`，于是：

- 玩家同时靠近两个物件时，交互提示闪烁
- 明明面朝宝箱，却触发了身后的门
- 交互后物件没禁用，能反复开同一个箱子

## 2. 五分钟上手

```typescript
const sys = new InteractSystem<ChestData>();

sys.register({ id: 'chest', data: {...}, radius: 3, pos: { x, y } });

const c = sys.findFocus({ pos, facing, inventory, data });
if (c) showPrompt(c.item, c.reason);      // reason 为 null 才能交互

sys.interact(ctx);                         // 绑定按键
```

## 3. 目标选择的排序

```
① 朝向分档   正对(±45°) > 侧对(±90°) > 背对
② priority   高者优先
③ 距离       近者优先
```

**朝向排在距离前面**，这是本模块最重要的设计：

> 玩家面朝宝箱（2 米）、门在身后（1 米）——
> 按距离会选中身后的门。玩家会认为"游戏没听我的"。

## 4. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| **超出半径仍算有效** | 站着能开远处的箱子；空地也显示"按 E" | `inRange` 与 `valid` 分离 |
| 用同一个 null 表示两种状态 | "不在范围"和"满足条件"撞车 | 一个语义只该有一个含义 |
| 交互后不禁用 | 能反复开同一个箱子（严重 exploit） | 达到 maxUses 自动禁用 |
| 位置塞进 data | 污染业务数据结构 | 位置是 Interactable 的独立字段 |
| 朝向为零向量 | 玩家一卡顿就永远无法交互 | 视为正对，放行 |
| 静默拒绝 | 玩家不知道为什么按 E 没反应 | `reason` 给出可读原因（"缺少：黄铜钥匙"） |

## 5. 三种条件

| 条件 | 说明 |
|---|---|
| `requires` | 需要的道具（钥匙） |
| `canInteract` | 自定义条件（注入，避免业务依赖） |
| `maxUses` | 可交互次数（默认 1，`Infinity` = 无限） |

## 6. 无位置的物件

不提供 `pos` 时视为**全局可交互**（UI 按钮等），不受距离与朝向限制。

## 6.5 API

| 成员 | 说明 |
|---|---|
| `register(item)` / `registerAll(items)` | 注册 |
| `unregister(id)` | 反注册，返回是否真的删掉了 |
| `get(id)` / `all` | 取单个 / 取全部 |
| `findFocus(ctx)` | 选一个**最优**目标（排序见第 3 节） |
| `candidates(ctx)` | 取**全部候选**（按优劣排序，做「同时高亮多个」用） |
| `evaluate(item, ctx)` | 单独评估一个物件（**调试用**：看它为什么没被选中） |
| `interact(ctx)` | 对当前焦点执行交互 |
| `focused` | 当前焦点物件（`null` = 没有） |
| `usedCount(id)` | 已交互次数（对照 `maxUses`） |
| `setDisabled(id, disabled)` | 手动启停（**比反复 register/unregister 便宜**） |
| `reset(id)` / `resetAll()` | 重置使用次数（**每日重置的箱子用这个**） |
| `clear()` | 清空全部注册（**会通知 `onFocusChange(null)`**） |
| `destroy()` | 卸载：清空并摘掉回调引用 |

**`Interactable` 的位置字段 `pos`（可选）**：

| 传法 | 语义 |
|---|---|
| 传 `pos: { x, y }`（`z` 可选） | 受距离与朝向限制 |
| 不传 | **全局可交互**（UI 按钮等），`distance = 0` / `inRange = true` |

### 两个排序函数的区别

| | 返回 | 用途 |
|---|---|---|
| `findFocus(ctx)` | 一个 | 显示"按 E 开箱"提示 |
| `candidates(ctx)` | 数组 | **同时高亮附近全部可交互物** |

```typescript
// 常见的错误：用 candidates()[0] 代替 findFocus()
const c = sys.candidates(ctx)[0];   // ❌ 空数组时是 undefined，不报错
```
> `findFocus` 在无目标时返回 `null`，
> `candidates()[0]` 返回 `undefined`——
> `if (c)` 对两者都成立，但 `c.item` 在后者会炸。

### 默认实现（可替换）

| 函数 | 说明 |
|---|---|
| `defaultDistance(a, b)` | 默认距离函数，**支持 2D/3D**（`z` 可选） |
| `alignmentTo(from, to, facing)` | 朝向对齐度（点积，1 = 完全正对） |

自定义距离判定（比如考虑楼层）时替换它们，不必改模块。

## 7. 测试覆盖

37 项。重点覆盖：朝向分档优先于距离、priority 覆盖距离、用完禁用、requires 原因、requireFacing=false、facingTolerance 收紧、canInteract 注入、3D 距离、零距离/零朝向、自定义 distance、无位置物件、onFocusChange 通知。

## 8. 依赖

零依赖，纯逻辑。
