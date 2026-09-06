# stats · 统计追踪

**结算界面的数据来源**

---

## 它解决什么

结算界面要显示：击杀数、最高连击、通关时间、死亡次数、各武器击杀。

手写是一堆散落变量配上 `bestTime = Math.min(bestTime, t)`。问题是：

- 忘了 `Math.min` 就把"最短时间"变成"最后一次时间"
- 想分武器统计时才发现问题，改起来要动所有记录点
- `Infinity` 直接渲染成 "-∞"

## 用法

```typescript
const s = new Stats({
  defs: [
    { id: 'kills',         agg: 'sum',  persist: true },
    { id: 'maxCombo',      agg: 'max' },
    { id: 'bestTime',      agg: 'min' },
    { id: 'deaths',        agg: 'count' },
    { id: 'killsByWeapon', agg: 'sum', tags: ['weapon'] },
  ],
  derived: {
    kph: (g) => g('kills') / Math.max(1, g('playtime') / 3600_000),
  },
});

s.add('kills', 1);
s.get('kills');                               // 1
s.record('killsByWeapon', 1, { weapon: 'sword' });
s.byTag('killsByWeapon', 'weapon');           // { sword: 1 }
s.get('kph');                                 // 派生指标
```

## 聚合方式与单位元

| 方式 | 单位元 | 含义 |
|---|---|---|
| `sum`   | 0          | 累加 |
| `max`   | -Infinity  | 保留最大 |
| `min`   | +Infinity  | 保留最小 |
| `last`  | 0          | 保留最后一次 |
| `count` | 0          | 只数次数，忽略传入值 |

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **`get()` 保持数学正确，`display()` 转 0** | max 无记录时是 `-Infinity`（正确的单位元），但直接渲染是 "-∞" |
| **分组 key 必须排序标签** | `{a,b}` 和 `{b,a}` 是同一组合，不排序会统计翻倍 |
| **存档跳过非有限值** | `JSON.stringify(Infinity)` 得到 `null`，读回来是 null 不是 Infinity |
| **未声明的标签被拒绝** | 防拼错维度名，早失败好过数据悄悄错 |
| **导入未知 id 静默跳过** | 旧存档兼容 |

## API

用法示例之外，还有这些：

### 查询

| 成员 | 说明 |
|---|---|
| `get(id, tags?)` | 取值。**未声明的 id 抛错** |
| `tryGet(id, tags?)` | 取值，不存在返回 `0`（**不抛错**） |
| `display(id, tags?)` | 取值并**把 `-Infinity` 转成 0**（渲染用这个） |
| `has(id, tags?)` | 是否有记录 |
| `byTag(id, tag)` | 按标签分组统计 |
| `tagCombos(id)` | 该指标出现过的**全部标签组合** |
| `derivedIds` | 全部派生指标 id |

> ⚠️ **渲染用 `display()`，不要用 `get()`。**
> `get()` 保持数学正确——max 聚合在无记录时是 `-Infinity`（正确的单位元），
> 直接渲染会显示 "-∞"。

```typescript
ui.text = String(stats.display('maxCombo'));   // 0
const raw = stats.get('maxCombo');             // -Infinity（用于继续 max 比较）
```

### 增删与存档

| 成员 | 说明 |
|---|---|
| `resetSession()` | 清空**未标记 `persist`** 的指标（新一局开始时调） |
| `reset(id)` / `resetAll()` | 重置单个 / 全部 |
| `exportState()` / `importState(state)` | 存档（**跳过非有限值**，见下） |
| `snapshot()` | 取当前全部值的快照 |
| `describe()` | 诊断输出 |

> **`resetSession()` 是"新一局"的正确入口。**
> 用 `resetAll()` 会把 `persist: true` 的累计数据（总击杀数）一起清掉——
> 玩家发现自己玩了 100 局，总击杀还是 0。

### `makeKey(id, tags)`（可单独用）

把「指标 + 标签组合」拼成内部键，**标签会排序**。

```typescript
makeKey('kills', {weapon:'sword', floor:'3'})
// → 'kills|floor=3,weapon=sword'   ← 注意 floor 排在前面
```

> ⚠️ 排序是刻意的：`{a,b}` 和 `{b,a}` 是同一组合，
> 不排序会存成两条，**统计结果翻倍**。
> 别自己拼这个 key——手写 `'kills|weapon=sword'` 会和内部不一致。

## 测试

**45 项**，覆盖 5 种聚合、标签顺序无关、display 的 Infinity 转 0、存档往返。
