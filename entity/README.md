# entity · 统一实体注册表

```typescript
import {
  EntityRegistry, EntityIndex,
  idIndex, idGeneration, makeId, isValidId,
  SLOT_CAPACITY, INVALID_ID,
  type EntityRecord, type SpawnOptions, type DeathReason,
} from './entity/EntityRegistry';
```

- 依赖：**无**
- 引擎耦合：**无**
- 测试：**48 项**

---

## 它解决什么

`npm run probe`（接口连通性体检）实测出的**头号缺失**：

```
✗ 实体注册表（id → entity 统一查询）
    每个模块都只持有 id，但库里没有"根据 id 取实体"的统一入口。
    已实测：全库 grep 无 EntityRegistry / EntityStore / World 类。
```

更麻烦的是**各模块对 id 的假设不一致**：

| 模块 | 类型 | 语义 |
|---|---|---|
| `hitbox` | string | **判定框** id（一个实体可有多个框） |
| `skill-caster` | string | 命中 id（透传） |
| `perception` / `attack-token` / `targeting` | number | 实体 id |
| `collision` | number | **碰撞体** id |

于是"**命中了 → 这个 id 是谁？**"没有地方能回答。业务侧只能自己维护 Map，一旦不同步，症状就是"打错人"——不报错，玩家只觉得"我明明瞄准了却打中别人"。

---

## 设计：映射，而不是统一

不去改 `hitbox` 的 string，也不去统一 `collision` 的语义——那些差异是**真实存在**的（判定框 id 确实该和实体 id 分开）。建立映射即可：

```
实体 id (number，带版本号)
   ├── hitbox:      'body' / 'weak'   (string，多对一)
   ├── collision:   1234              (number)
   └── perception / attack-token:     直接复用实体 id
```

---

## 用法

```typescript
const reg = new EntityRegistry<Enemy>();

// ① 生成（Boss 有两个判定框）
const bossId = reg.spawn(boss, {
  tags: ['enemy', 'boss'],
  hitboxIds: ['boss-body', 'boss-weak'],
});

// ② 死亡结算的归宿（掉落 / 成就 / 移除判定框 / 释放攻击令牌）
reg.onDeath((id, entity, reason) => {
  loot.drop(entity);
  hitboxWorld.remove(entity.hitboxId);
  attackTokens.release(id);
});

// ③ 命中判定框 → 反查实体 → 扣血
const targetId = reg.fromAlias(hit.hitbox.id);      // 'boss-weak' → 实体 id
const target = reg.getEntity<Enemy>(targetId);
if (target) {
  target.hp -= damage;
  if (target.hp <= 0) reg.kill(targetId);           // ← 触发 onDeath
}

// ④ 查询（默认不含尸体，AOE 不会打到尸体）
reg.query('enemy');
reg.queryAll(['enemy', 'boss']);
```

---

## 四个关键设计

### ① id 带版本号 —— ABA 问题的解药

不用版本号的话：

```
1. 怪物 A 占用 id 7
2. A 死亡，槽位回收
3. 怪物 B 复用 id 7
4. 技能持有"目标 = 7"的旧引用 → 打在 B 身上
```

症状是"**偶尔打错人**"，无法复现，且没人会想到是 id 回收。

现在 `id = index + generation × 1048576`，复用时 `generation + 1`，旧 id 永远查不到。

> **⚠️ 用乘法，不要用位移**
> 第一版写成 `(gen << 20) | index`，但 JS 位运算是 **32 位有符号**：
> `gen=2048` 时 `2048 << 20` 溢出成负数。
> 后果是**槽位复用 2048 次后实体凭空消失**——
> 长会话游戏（挂机、无尽模式）跑几小时就会撞上，
> 而没人会想到是"死了 2048 个怪"导致的。

**槽位 0 保留给 `INVALID_ID`**，所以 `idIndex` 恒 > 0 —— `isValidId` 正是靠这一点区分"合法 id"与"非法 id"。

> **⚠️ 槽位是复用的，"spawn 次数"不等于"槽位数"**
> 曾有审查意见认为"spawn 无上限 → 超过 1048576 后 `idIndex === 0` → 实体静默查不到"。
> 实测：**20 万次 `spawn` + `destroy` 之后占用槽位仍是 0**
> ——`destroy` 会把槽位压回 `_free` 空闲栈，下次 `spawn` 直接复用。
> 要撞到那个上界需要**同时存活**超过 100 万个实体，
> 而在那之前内存早就先撑不住了。所以这里刻意不做检查（与文件头的设计说明一致）。

### ② kill 与 destroy 分离

| 方法 | 做什么 | 何时用 |
|---|---|---|
| `kill(id)` | 标记 `alive=false`，触发 `onDeath`，**保留记录** | 正常击杀 |
| `destroy(id)` | 真正移除并回收槽位 | 尸体消失、换关卡 |

**为什么分开**：死了的实体还要留着——掉落在尸体上（玩家走过去捡）、尸体消失动画、成就统计"本局击杀数"、死亡回放。立刻删除的话这些全部拿不到数据。

**`kill` 可重复调用但回调只触发一次** —— 否则"一帧内被两发子弹打死"会掉两份装备，那是玩家会主动刷的漏洞。

**`destroy` 活着的实体也会触发 `onDeath`**（reason 为 `'destroyed'`）—— 换关卡时直接 destroy 全场，如果不触发，"击杀计数"类成就就会**只在换关时**漏，极难发现。

### ③ 遍历安全（连锁死亡）

`forEach` 期间调用 `destroy()` 会被推迟到遍历结束：

```typescript
reg.forEach((rec) => {
  if (rec.hasTag('barrel')) {
    for (const e of reg.query('enemy')) reg.kill(e);   // 回调里改集合
  }
});
// 这里才真正回收
```

这是"**爆炸桶炸死一片**"能正常工作的前提。嵌套 `forEach` 也安全——内层结束不清理，等最外层结束才清。

### ④ 死亡结算的归宿

体检时发现的第二处缺失，这里一并解决：

> `IDamageable.isAlive()` 存在但**没有任何模块会去调它**，
> 而 `applyDamage` 的注释明令禁止在里面播特效、飘字、掉物品。

正确链路：

```
伤害管线结算 → 业务侧判断 hp<=0 → registry.kill(id)
             → onDeath 回调（掉落/成就/移除 hitbox/释放令牌）
```

**不要在 `applyDamage` 里做死亡结算。**

---

## API

### 生成与查询

| 方法 | 说明 |
|---|---|
| `spawn(entity, opts?)` | 注册，返回 id |
| `get(id)` / `getAlive(id)` | 取记录（后者排除尸体） |
| `getEntity<T>(id)` | 取业务对象 |
| `exists(id)` / `isAlive(id)` | 存在 / 存活 |
| `fromAlias(string)` | 判定框 id → 实体 id |
| `fromCollider(number)` | 碰撞体 id → 实体 id |

### 标签

| 方法 | 说明 |
|---|---|
| `addTag` / `removeTag` / `hasTag` | 单个标签 |
| `query(tag, requireAlive?)` | 按标签查（**默认不含尸体**） |
| `queryAll(tags, requireAlive?)` | 同时满足多个标签 |

### 生命周期

| 方法 | 说明 |
|---|---|
| `kill(id, reason?)` | 标记死亡，触发 `onDeath` |
| `destroy(id)` | 真正移除 |
| `destroy()` | **无参重载**：等价于 `clear()`，给只认 `destroy` 名字的清理代码用 |
| `clear()` | 清空（换关卡） |
| `onDeath` / `onSpawn` / `onDestroy` | 回调，均返回取消函数 |

### 遍历与统计

| 方法 | 说明 |
|---|---|
| `forEach(fn, requireAlive?)` | 遍历（连锁安全） |
| `snapshot(requireAlive?)` | 快照 |
| `tick()` / `frame` | 帧计数（配合 `bornFrame` 调试） |
| `liveCount` / `slotCount` / `describe()` | 统计 |

### 独立函数

| 函数 | 说明 |
|---|---|
| `idIndex(id)` / `idGeneration(id)` / `makeId(i, g)` | id 编解码 |
| `isValidId(id)` | 合法性（不含存在性） |
| `INVALID_ID` | 非法 id（恒为 0） |
| `SLOT_CAPACITY` | 单代槽位容量（1048576） |

### 回调类型

```typescript
type DeathHandler<T>   = (id: number, entity: T, reason: DeathReason) => void;
type SpawnHandler<T>   = (id: number, entity: T) => void;
type DestroyHandler    = (id: number) => void;
```

> **三个回调的时机不同，别搞混：**
>
> | 回调 | 何时触发 | 典型用途 |
> |---|---|---|
> | `SpawnHandler` | `spawn()` 成功 | 注册到渲染层 / 其他系统 |
> | `DeathHandler` | `kill()` 时（**实体还在**，尸体可用） | **掉落、成就统计、死亡回放** |
> | `DestroyHandler` | `destroy()` 时（**真的没了**） | 清理渲染节点 |
>
> 掉落必须挂在 `DeathHandler` 而不是 `DestroyHandler`——
> 尸体有自己的生命周期，两个时机之间可能隔很久（尸体消失动画、 ashes 效果）。

`EntityIndex` 提供**对象 → id** 的反向索引，用 `WeakMap`，不影响 GC。

| 成员 | 说明 |
|---|---|
| `bind(obj, id)` | 绑定 |
| `idOf(obj)` | 取 id，**未绑定返回 `INVALID_ID`** |
| `unbind(obj)` | 解绑，返回是否真的解了 |
| `has(obj)` | 是否已绑定 |

> **它是可选的。** 很多场景只需要 `id → 实体`（Registry 已提供），
> 反向索引要额外维护一张 `WeakMap`，不该强制每个使用者都付这个代价。

### 查实体的两种方式

```typescript
registry.fromAlias('boss-weak');        // → 实体 id（number），找不到返回 INVALID_ID
registry.entityFromAlias('boss-weak');  // → 业务对象，找不到返回 null
```

> ⚠️ **两个方法的"找不到"返回值不同**：一个是 `INVALID_ID`（0），一个是 `null`。
> 判空别用同一种写法——`if (id)` 对 id 有效（0 是假值），
> 但对对象无效（要 `!== null`）。'


---

## 坑

| 坑 | 后果 |
|---|---|
| id 用位移打包 | 32 位溢出，`gen=2048` 后实体凭空消失 |
| `clear()` 重置版本号 | **上一关的 id 全部复活**，换关后技能打错人 |
| `spawn` 新槽位硬编码 `gen=0` | 绕过 `clear()` 保留的版本号，同上 |
| `kill` 重复触发回调 | Boss 掉两份装备，可被玩家刷 |
| 遍历中就地删除 | 连锁死亡时跳过或越界 |
| `forEach` 用动态长度 | 回调里 spawn → 无限循环 |
| 查询含尸体 | AOE 打到尸体，尸体又掉一次物品 |
| `get()` 抛错而不是返回 null | "技能打空"变成"游戏崩溃" |
| 在 `applyDamage` 里做死亡结算 | 违反 `IDamageable` 契约，且无法批量模拟 |

## 测试抓到的 3 个真 bug

| # | 缺陷 | 现象 |
|---|---|---|
| 1 | **id 用位移打包导致 32 位溢出** | `gen=2048` 时 `2048 << 20` 溢出成负数，`isValidId` 判定失败，**实体凭空消失**。长会话游戏几小时就会撞上。改用乘法编码 |
| 2 | **⚠️ `clear()` 重置版本号，旧 id 全部复活** | 换关卡后 `reg.exists(上一关的id)` 返回 true，上一关残留的技能引用打在新关卡的怪身上。**比普通 ABA 更隐蔽——只在换关时发生**。改为递增所有版本号 |
| 3 | **`spawn` 新槽位硬编码 `gen=0`** | 绕过 `clear()` 保留的版本号，让第 2 条的修复形同虚设。改为读 `this._gens[index]`，且只在 `_gens` 不够长时才扩容 |

> 第 2 和第 3 条是同一个 bug 的两半——只修其中一个，另一个会让它继续失效。
> 这是测试连续失败两次才逼出来的。
