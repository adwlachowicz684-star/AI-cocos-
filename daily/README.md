# daily · 每日挑战与固定种子

> 核心承诺：同一天，所有玩家玩的是完全一样的内容。

## 1. 它解决什么

每日挑战的价值在于"大家打一样的"，所以排行榜才有意义。
听起来简单（"用日期做种子"），但有四个真实的坑：

| 坑 | 后果 |
|---|---|
| **时区** | 澳洲玩家比美国玩家早 15 小时拿到新挑战，排行榜失去可比性 |
| **跨日提交** | 23:59 开始、00:01 提交，成绩记到了没打过的那天 |
| **种子质量** | `20240301` 和 `20240302` 只差 1，PRNG 输出高度相关 → "连续几天关卡几乎一样" |
| **分享回填** | 分享码回填后得到不同的关卡，社交价值归零 |

## 2. 五分钟上手

```typescript
const daily = new DailyChallenge({
  timezone: 'utc',          // 全球统一
  modifierCount: 2,
  recordMode: 'first',      // 只记当天第一次（防刷）
  modifiers: [ /* ... */ ],
});

const e = daily.today();    // { date, seed, seedText, modifiers }
const back = daily.fromText(e.seedText);   // 分享给朋友的同一张图

// ⚠️ 上一行返回的是 `DailyEntry | null`，**必须判空**
if (!back) { showToast('种子格式不对'); return; }

daily.submit(e.date, score, cleared);      // 成绩绑定开始日期
daily.streak();                            // 连续打卡天数
```

## 3. 种子生成：为什么必须 hash

```
hashDateKey('2024-03-01')  vs  hashDateKey('2024-03-02')
直接相加：相差 1      → PRNG 前几次输出高度相关
FNV-1a + 三轮混合：彻底发散
```

FNV-1a 的低位雪崩性偏弱，所以额外做了三轮混合（`_core` 里也是这个思路）。

## 4. ⚠️ 分享回填：文本必须是种子的真身

**这是修过的真 bug。**

第一版是：
```
seed = hash(date)
text = seedToText(seed)      ← 展示用
```

于是玩家看到今天叫 `IRON-WOLF-42`，分享给朋友，朋友输入后走**反解**路径——
只能恢复低 24 位，得到一个**不同的种子**。

表现为："我分享给你了，为什么我们玩的关卡不一样？"
这种 bug 会直接摧毁每日挑战的社交价值，而且极难排查——两边的代码看起来都对。

**修法：让文本成为种子的真身。**

```
date → text → seed      而不是   date → seed → text

hash(date)     派生展示文本
hash(text)     ← 这才是真正用的种子
```

这样"输入文本"和"今日挑战"走同一条路径，分享与回填必然一致。

## 5. 时区选择

| 模式 | 行为 | 适用 |
|---|---|---|
| `'utc'`（默认） | UTC 日期变了就换 | 排行榜可比性强，**推荐** |
| `'local'` | 按玩家本地日期 | 符合直觉，但不同玩家进度不同 |
| 数字（如 `8`） | 固定 UTC 偏移 | 以某个地区为主 |

## 6. recordMode

| 模式 | 行为 |
|---|---|
| `'first'`（默认） | 只记当天第一次，防刷 |
| `'best'` | 记最好成绩，玩家可以刷 |

两种模式下 `attemptsOn()` 都会累加尝试次数。

### ⚠️ `fromText` 返回 `null`，不是抛错

它解析的是**玩家手抄或复制来的文本**——
少个字符、多个空格、打错一位，都是常态。

```typescript
const back = daily.fromText(userInput);
if (!back) {
  showToast('种子格式不对');   // 别用 try/catch，它不抛
  return;
}
```

想要**只校验不解析**，用 `isValidSeedText(text)` 这个顶层函数。

> 不判空的后果：玩家输入错种子 → `back` 是 null →
> `back.seed` 直接抛 TypeError → 界面白屏。
> 而这是每日挑战**最高频的用户输入路径**——分享种子就是为了互相比成绩。

## 6.5 API

| 成员 | 说明 |
|---|---|
| `today()` / `entryFor(dateKey)` | 取当天 / 指定日期的题目 |
| `fromText(text)` | 文本 → 题目，**可能返回 `null`**（见上） |
| `submit(date, score, cleared)` | 提交成绩（**绑定开始日期**，见 §5） |
| `recordOf(dateKey)` | 取某天的记录（`undefined` = 没玩过） |
| `streak()` | 连续打卡天数 |
| `clearedCount` | 通关次数 |
| `exportState()` / `importState(s)` | 存档 |
| `history()` | 全部历史记录（**做"本月战绩"日历**） |
| `todayKey()` | 当天的日期键 |

### 两个顶层函数

`hasPlayedToday(records, dateKey)` —— 某天是否已打过。

> ⚠️ 它和 `recordOf(dateKey)` 的区别：
> `recordOf` 返回**记录对象**（含分数、是否通关），
> `hasPlayedToday` 只回答**打没打过**。
> 做日历格子（只显示"打了吗"）用后者，不用取整个对象。

### 两个顶层函数（可单独用）

| 函数 | 说明 |
|---|---|
| `dateKeyOf(date)` | `Date` → `'YYYY-MM-DD'` 字符串键 |
| `isValidSeedText(text)` | 校验种子文本（**只判断，不解析**） |

```typescript
// 自己算日期键（比如做"本周战绩"UI）
const key = dateKeyOf(new Date());
const rec = daily.recordOf(key);
```

## 7. 测试覆盖

28 项。重点覆盖：种子雪崩、时区边界、分享回填一致性、跨日提交、连续打卡。

## 8. 依赖

零依赖，纯逻辑。

---

## 返回值结构

### `DailyRecord`

```typescript
interface DailyRecord {
  date:     DateKey;    // 日期键（如 '2026-09-05'）
  score:    number;
  at:       number;     // 完成时刻
  cleared:  boolean;
  attempts: number;     // 尝试次数
}
```

> **`attempts` 是"尝试次数"不是"成功次数"。**
> 每日挑战通常限制挑战次数（比如每天 3 次），
> 判剩余次数用 `attempts`，别用 `cleared`。