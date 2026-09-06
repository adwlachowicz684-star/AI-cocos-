# currency · 多货币钱包

> ## ⚠️ 本目录有两套实现，先选一个
>
> | | `CurrencyWallet.ts`（**推荐**） | `Currency.ts` |
> |---|---|---|
> | 主打 | **精度与上下限** | **多货币原子支付** |
> | 单货币消费 | `spend()` → `SpendResult`（**带 `need`/`have`**） | `spend()` → `boolean` |
> | 小数精度 | ✅ `precision` | ❌ 只支持整数 |
> | 负债（负数） | ✅ `floor` | ❌ |
> | 多货币原子 | ❌ 仅 `exchange`（1:1） | ✅ `spendAll` / `addAll` / `canAfford(costs[])` |
> | 多货币对账 | `ledger` | `log` / `netChange` |
> | 测试 | ✅ 36 项 | ❌ **无** |
> | 本文档覆盖 | ✅ | ❌ |
>
> **速判**：
> - 要"付 100 金币 + 5 钻石"这种**一次扣多种货币** → `Currency.ts` 的 `spendAll`
> - 其他所有情况 → `CurrencyWallet.ts`
>
> ⚠️ **两个文件都导出 `CurrencyDef`，字段完全不同。**
> 本文件的字段是 `cap` / `floor` / `precision`；
> `Currency.ts` 的是 `max` / `premium` / `trackLog`。
> **只 import 一个文件**，别两边都引。

> ⚠️ **写完代码必须同时完成三件事**：① 测试 ② README ③ 登记进 `_kitmeta.json`
> 缺任何一件都等于没写完。本项目已五次出现"有实现无测试"的孤儿插件。

---

## 它解决什么

金币、钻石、体力、活动代币……手写的 `player.gold += 10` 会遇到三个必然问题：

| 问题 | 后果 |
|---|---|
| 货币名拼错 | `add('diaomnd', 100)` 静默失败，玩家没拿到奖励，没人报错 |
| 多货币混算 | 流水只记数字不记类型，对账时金币和钻石混在一起 |
| 浮点累积 | `0.1 + 0.2 !== 0.3`，表现为"还差 0.0000001 点就能升级" |

## 用法

```typescript
const w = new CurrencyWallet({
  defs: [
    { id: 'gold', name: '金币', initial: 100, cap: 999 },
    { id: 'gem', name: '钻石', initial: 5 },                        // 无上限
    { id: 'energy', name: '体力', initial: 20, cap: 30, precision: 1 },
  ],
});

w.add('gold', 50);                    // 返回实际增加量（受上限约束）
const r = w.spend('gold', 200);
if (!r.ok) {
  showToast(`还差 ${r.need} 金币`);    // 失败时返回缺口
}
w.exchange('gem', 'gold', 1, 100);    // 原子：扣失败则完全不加
```

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **未声明货币在查询时抛错** | 静默创建是最坏的失败模式 |
| **但 `spend` 未知货币只返回 reason** | 查询抛错（代码错误，必须立刻暴露）；消费返回 reason（配表错误不该让玩家崩溃） |
| **消费失败一分钱都不扣** | 这是钱包最重要的契约：要么完全成功，要么完全没发生 |
| **流水必须带货币类型** | 只记数字的话多货币对不上账 |
| **`add` 返回实际增加量** | 满了再加返回 0，可用来提示"体力已满" |
| **precision 消除浮点误差** | `10 次 0.1` 必须精确等于 1 |
| **导入存档夹到上下限** | 防止改存档突破上限 |
| **导入未知货币静默跳过** | 旧存档兼容，抛错会让老玩家进不去游戏 |

## 设计：为什么查询抛错而消费返回 reason

两者失败的性质不同：

- `get('diaomnd')` 是**代码错误**——你写错了一个不存在的货币名，必须在开发期立刻炸出来
- `spend('已下架货币', 1)` 是**运行时可能发生的**——配置删了一种货币但玩家背包里还有，崩溃是过度反应

混用任何一种都会带来麻烦：全抛错会让线上崩溃，全静默会让 bug 潜伏三个月。

### 多货币原子支付（`Currency.ts` 的 `Wallet`）

`CurrencyWallet` 一次只能动一种货币。要"100 金币 + 5 钻石"一起扣，
用另一个实现的 `spendAll`：

```typescript
import { Wallet } from './currency/Currency';

const ok = w.spendAll([
  { currencyId: 'gold', amount: 100 },
  { currencyId: 'gem',  amount: 5 },
]);
```

> **它是真的原子**：先 `canAfford` 全部校验，通过后才逐个扣减。
> 自己写循环扣的话，第二种货币不够时第一种已经扣掉了——
> 表现为"钱没了东西没买到"。

> `canAfford(costs[])` 返回 `AffordResult`：
> `{ ok, missing }`，`missing` 是**每种差多少**的映射
> （`ok` 为 true 时是空对象）。做"哪项不够"的提示用得上。

> ⚠️ **这个实现没有测试、没有精度处理、金额必须为正整数。**
> 用之前先补测试。

**本文档不覆盖 `Wallet` 的完整 API**（`log` / `logOf` / `netChange` /
`space` / `addAll` / `set` / `exportState` 等）。
原因：无测试的实现不配拥有完整文档——写了也不知道对不对。
要用请先补测试，再照源码补文档。

不过有两个常用成员值得单列，它们与 `CurrencyWallet` **同名但不同类**：

| 成员 | 说明 |
|---|---|
| `currencyIds` | 全部货币 id（**返回 `string[]` 新数组**，不是只读视图） |
| `clearLog()` | 清流水 |

> ⚠️ **`currencyIds` 返回的是新数组，修改它不会影响钱包。**
> 这与 `CurrencyWallet.ids`（只读视图）是**不同的语义**——
> 两个类放在同一目录、都有"钱包"意味，很容易混用。
> 详见文档顶部的两套实现对照表。

> ⚠️ **`clearLog()` 与 `CurrencyWallet.clearLedger()` 是两个类的同名异义方法。**
> 前者清 `Wallet` 的流水，后者清 `CurrencyWallet` 的。
> 混用的话不报错——只是清了一个你没在用的流水，
> 表现为"内存没降下来"。

## API 补充

### `CurrencyWallet` 完整接口

| 成员 | 说明 |
|---|---|
| `get(id)` / `tryGet(id)` | 查询（见下文 `get` vs `tryGet`） |
| `has(id)` | 是否已声明 |
| `ids` | 全部货币 id |
| `def(id)` | 取定义 |
| `add(id, amount, reason?)` | 增加，返回**实际增加量**（受上限约束） |
| `spend(id, amount, reason?)` | 消费，返回 `SpendResult` |
| `set(id, value, reason?)` | 直接设置（**不走上限检查之外的校验**） |
| `exchange(from, to, amount, rate, reason?)` | 兑换（**原子**：扣失败则完全不加） |
| `canAfford(id, amount)` | 是否够 |
| `cap(id)` / `room(id)` / `isFull(id)` | 上限 / **剩余空间** / 是否满 |
| `reset()` | 全部归零 |
| `ledger` / `ledgerOf(id)` | 流水 / 单种货币的流水 |
| `clearLedger()` | 清流水 |
| `exportState()` / `importState(state)` | 存档 |

> ⚠️ **`add` 返回实际增加量，不是新余额。**
> 满了再加返回 `0`——可以拿它提示"体力已满"。
> 想拿新余额用 `get(id)`。

> ⚠️ **`clearLedger()` 要定期调。**
> 流水是只增不减的，一直不清理会吃内存。
> 本模块有 `logLimit` 上限（默认 200）自动丢弃旧的，
> 但存档时记得先清，别把流水也存进去。

> **`importState` 只恢复余额，不恢复流水。**
> 读档后 `ledger` 是空的——这是对的，
> 跨会话的流水没有意义。

### `SpendResult`（`spend` / `exchange` 的返回）

```typescript
interface SpendResult {
  ok:      boolean;
  reason?: SpendFailureReason;   // 失败原因
  need?:   number;               // 失败时：还差多少
  have?:   number;               // 失败时：当前有多少
}
```

> **`need` 和 `have` 只在失败时有值。**
> 提示"还差 X 金币"用 `need`——自己算要重新查一次余额，
> 而且容易算错（上限、精度都会影响）。

### `CurrencyDef`（货币定义）

```typescript
interface CurrencyDef {
  id:       string;
  name:     string;
  max:      number | null;     // null = 无上限
  premium:  boolean;           // 是否付费货币（用于统计区分）
  trackLog: boolean;           // 是否记流水
  desc:     string;
}
```

### 类型

```typescript
interface Cost { currencyId: string; amount: number }
```

> **`Cost` 是 `spendAll` / `canAfford` 的入参单位。**
> 上面示例里的 `[{ currencyId: 'gold', amount: 100 }, ...]` 就是它。

**`WalletOptions`**：

| 字段 | 说明 |
|---|---|
| `defs` | 货币定义列表（**必填**） |
| `initial` | 初始余额 |
| `now` | 时间源（**流水时间戳用它**，可注入便于测试） |
| `logLimit` | 流水上限（默认 200，超出丢最老的） |
| `onChange(id, delta, balance, reason)` | 变动回调 |

> ⚠️ **`now` 不传的话用 `Date.now()`（真实时间）。**
> 测试里想固定时间戳得注入自己的时钟——
> 否则流水的时间每次跑都不一样，没法做快照断言。

> ⚠️ **`logLimit` 超限丢最老的流水，不报错。**
> 需要完整审计记录的话调大它，或者定期 `clearLog()` 并自己落盘。

### 查询：`get` vs `tryGet` vs `has`

| 方法 | 未声明的货币 |
|---|---|
| `get(id)` | **抛错** |
| `tryGet(id)` | 返回 `0`，不抛错 |
| `has(id)` | 返回 `false` |

> **`tryGet` 是给 UI 遍历用的**（遍历所有货币画图标，不该因为某一种没配就崩）。
> 业务逻辑里用 `get`——拼错 id 应该当场炸，而不是静默返回 0。

### `CurrencyOptions`

`defs` / `onChange(id, value, delta)`，以及：

| 字段 | 说明 |
|---|---|
| `onInsufficient` | 数量不足时的行为 |

- `'reject'`（默认）：不做任何改动，返回失败原因
- `'clamp'`：扣到下限为止（**扣得多少算多少**）

> ⚠️ **`'clamp'` 会让"钱不够也能买"。**
> 玩家有 80 金币买 100 金币的东西，`clamp` 会扣光 80 并成功——
> 这是"慈善模式"，只有特定玩法（比如体力兑换）才该开。
> 商店默认必须是 `'reject'`。

> ⚠️ **`trackLog: false` 的货币不记流水。**
> 高频变动的货币（比如战斗内金币）关掉流水能省很多内存，
> 但**对账时查不到变动记录**。哪些货币要记账，是上线前就要定的。

### 流水：`CurrencyEntry` vs `LedgerEntry`

两个结构很像，**用途不同**：

| | `CurrencyEntry` | `LedgerEntry` |
|---|---|---|
| 谁产生 | 单种货币的流水 | **全局**流水账 |
| 字段 | `currencyId` / `delta` / `balance` / `reason` / `at` | `id` / `delta` / `after` / `reason` / `seq` |
| 有货币类型 | ✓ | ✗（靠 `id` 区分） |

> ⚠️ **`LedgerEntry` 没有 `currencyId` 字段。**
> 全局流水靠 `id`（形如 `'gold'`）区分货币——
> 只写数字不记货币类型的话，多货币时对不上账。
> 这是本模块坑表格里"流水必须带货币类型"那一条的由来。

## 测试

**36 项**，覆盖原子性、精度、上限、流水、兑换回滚、存档容错。
