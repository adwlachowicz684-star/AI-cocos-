# RNG · Seed

可复现的随机数 + 人类可读的种子编码。

## 为什么「可复现」这么重要

种子随机的全部价值就是：**同样种子 + 同样操作 = 同样结果**。

它能让你：
- 玩家报告 bug 时，输入他的种子就能复现完全一样的关卡
- 做「每日挑战」——所有玩家玩同一张地图
- 玩家之间分享种子，比谁走得远（社区活跃度来源）

而这件事只需要**一处**用 `Math.random` 就会全盘失效。

## 用法

```typescript
import { RNG } from './rng/RNG';
import { Seed } from './rng/Seed';

const rng = new RNG(12345);

rng.next();            // 0..1
rng.range(1, 10);      // [1, 10) 浮点
rng.rangeInt(1, 6);    // [1, 6] 整数（骰子）
rng.int(3);            // 0 / 1 / 2
rng.chance(0.25);      // 25% 概率
rng.pick(['a','b','c']);
rng.shuffle(arr);      // 原地洗牌，Fisher-Yates 无偏
rng.sample(arr, 3);    // 取 3 个不重复
rng.gaussian(10, 2);   // 正态分布（自然的随机）

// 派生独立子流
const mapRng  = rng.fork();   // 地图生成用
const lootRng = rng.fork();   // 掉落用（互不影响）

// 存档
const saved = rng.state;
// 读档
rng.state = saved;

// 人类可读种子
Seed.encode(12345);        // 'IRON-33'
Seed.decode('IRON-33');    // 12345（或同族的合法种子）
Seed.random();             // 'MOON-42'
Seed.daily();              // 今日固定种子（每日挑战）
```

## `fork()` 为什么必须有

如果所有系统共用一个 RNG，那么「玩家多开了一个宝箱」会导致
后面所有随机（地图生成、AI 决策）全部错位。

有了 `fork()`，每个子系统用自己的流，互不干扰：

```typescript
const root = new RNG(seed);
const mapRng   = root.fork();
const lootRng  = root.fork();
const aiRng    = root.fork();
```

## 坑（按危险程度）

- **混用 `Math.random`** ⚠️ 最致命。种子复现直接失效，而且**不报任何错**
  → 用 lint 规则禁用：
  ```json
  "no-restricted-properties": ["error",
    { "property": "random", "message": "请用注入的 RNG，Math.random 会破坏可复现" }]
  ```
- **用 `arr.sort(() => Math.random() - 0.5)` 洗牌**
  → ① 用了 `Math.random` ② 比较函数不满足传递性，分布**有偏** ③ O(n log n)
  → 用 `rng.shuffle(arr)`
- **种子传负数或超过 2³²**：内部状态异常。构造时已做 `>>> 0` 处理
- **种子传 0**：坏种子会导致卡住。构造时已替换为 0x9e3779b9
- **`fork()` 后不保存子流状态**：读档后随机序列对不上

## 算法

**mulberry32**：32 位状态、速度快、分布良好、实现约 10 行。

不需要密码学强度——恰恰相反，我们要的就是可预测。
不要用 `Math.random`（不可控、不可复现），也不要用需要大状态的算法（存档体积大）。

## API

| 方法 | 说明 |
|---|---|
| `next()` | [0,1) |
| `range(min,max)` | [min,max) 浮点 |
| `rangeInt(min,max)` | [min,max] 整数 |
| `int(n)` | [0,n) 整数 |
| `chance(p)` / `bool()` | 概率 |
| `pick(arr)` / `sample(arr,n)` | 取样 |
| `shuffle(arr)` | 原地洗牌（Fisher-Yates） |
| `gaussian(mean,std)` | 正态分布 |
| `fork()` | 派生独立子流 |
| `state` | 内部状态（存档用） |

### Seed

| 方法 | 说明 |
|---|---|
| `encode(n)` | 数字 → 'WORD-NN' |
| `decode(s)` | 'WORD-NN' → 数字（非法返回 null） |
| `random()` | 随机可读种子 |
| `daily(date, tz)` | 按日期生成固定种子（**所有玩家必须用同一时区偏移**） |
