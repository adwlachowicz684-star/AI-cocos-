# expression — 表达式求值器

## 它解决什么

配置表里写死数值很快就不管用了：

```
damage: 100                // 第 10 层还是 100？
damage: 100 + level * 15   // ← 想要这个
```

不做这层的话，公式会散落在几十个文件里，策划改一个数要找程序员。

## 安全边界（重要）

**绝对不要用 `eval()` 或 `new Function()`**：
- 配置可能来自网络/玩家（RCE 风险）
- 无法控制它能访问什么
- 出错时堆栈完全看不懂

本实现是自己写的词法 + 语法分析，**只能做数学和变量查找**，
不能调用函数、不能访问对象、不能有任何副作用。

## 支持的语法

```
数字    100, 3.14, -5
变量    level, player.atk, $hp
运算    + - * / % ^
比较    > >= < <= == !=
逻辑    && || !
括号    (a + b) * c
三元    cond ? a : b
函数    min max abs floor ceil round sqrt pow clamp lerp sign pct
```

## 用法

```typescript
const expr = new Expression('100 + level * 15');
expr.evaluate({ level: 10 });        // 250

// 点号路径
new Expression('player.atk * (1 + buff.str)')
  .evaluate({ player: { atk: 50 }, buff: { str: 0.3 } });   // 65

// 编译一次，多次求值
for (const e of enemies) e.hp = expr.evaluate({ level: e.level });

// 语法错误在构造时抛出
new Expression('1 +');   // 抛错：表达式不完整

// 列出用到的变量（检查配置拼写）
expr.variables();        // ['level']
```

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 用 `eval` | RCE 风险 | 本实现不支持任何副作用 |
| 除零产生 NaN | NaN 沿伤害管线传播，最后表现为"打怪没伤害"，要追十几层 | 除零返回 **0** |
| 未定义变量抛错 | 整张表加载失败 | 默认当 0；要严格用 `evaluateStrict()` |
| 拼错变量名 | 永远是 0，没有任何报错 | 用 `variables()` 对照检查，或接 `setExpressionWarningHandler()` |
| 三元分支里写负值 | 早先版本会抛"意外的符号 -"，指向 `-` 的位置，与三元毫无关联 | 现已支持：`hp > 0 ? -dmg : 0` |
| 把 `toString` / `constructor` 当函数写 | 早先版本会命中 `Object.prototype` 上的同名成员，错误信息完全指错方向 | 查表只认内建自有属性，报"未知函数" |
| 热重载后公式变了但没重编译 | 改了不生效 | 热重载时要重建 `Expression` 对象 |

## API

| 成员 | 说明 |
|---|---|
| `new Expression(src)` | 编译（**语法错误在此抛出**） |
| `evaluate(vars?)` | 求值。未定义变量当 0（**会告警一次**，见下） |
| `evaluateStrict(vars?)` | 严格求值，未定义变量抛错 |
| `variables()` | 列出用到的变量名（**检查配置拼写**） |
| `source` | 原始表达式 |
| `setExpressionWarningHandler(h)` | 接告警出口（`h = null` 卸载） |

### 除零与取模零：返回 0（**已知取舍，不是 bug**）

```
10 / 0   → 0
10 % 0   → 0
a / b    → b 为 0 时得到 0
```

`Infinity` / `NaN` 会沿伤害管线传播，最后表现为"打怪没伤害"，
要顺着管线追十几层才能找到源头；返回 0 至少是**可预测的**
（通常表现为"这条公式没生效"，一眼能看出来）。
需要严格检查时用 `evaluateStrict()` + 业务侧显式校验分母。

### 非 strict 模式下的静默降级：会留痕

`evaluate()` 是宽松入口：未定义变量、`null`、`[]` 一律当 0。
这是刻意的（配置里常常引用"现在还没设置"的变量），
但"拼错变量名"和"确实填了 0"在返回值上完全无法区分。

所以宽松归宽松，**留一条痕**：

```typescript
setExpressionWarningHandler((m) => logger.warn(m));   // 接上宿主 Logger
setExpressionWarningHandler(null);                    // 卸载

new Expression('critRate + 0.1').evaluate({});        // 0.1，并告警一次：未定义的变量 critRate
```

- 默认**静默**（不装 handler 就什么都不做）——表达式每帧求值，默认打印会刷屏
- 每个表达式、每个键**只报一次**，不重复刷
- 返回值仍然是 0（改成抛错会让既有配置全线加载失败）

> ⚠️ **两个粒度不一样：handler 是全局的，去重是按实例的。**
> `setExpressionWarningHandler()` 设的是**模块级** handler——整个进程只有一个，
> 所有 `Expression` 实例共享它（宿主本来也只需要装一个 Logger）。
> 但"只报一次"的 `_warned` 集合是**每个实例一份**，
> 所以三个表达式用了同一个拼错的变量名，会各报一次，不是全进程只报一次。
>
> 由此还有个边界：如果写成"每帧 `new Expression(...)`"（把公式当临时对象），
> 去重就失效了——每帧都是新实例、新 `_warned`，日志照样刷屏。
> 正确用法是**配置期编译一次、运行期反复 evaluate**，实例是长命的。

## 典型场景

```typescript
// 分层难度
'base * (1 + floor * 0.15)'

// 掉落数量随幸运值浮动
'floor(amount * (1 + luck / 100))'

// 暴击伤害（有暴击才加成）
'isCrit ? dmg * 2 : dmg'

// 护甲减伤（除法公式，避免负伤害）
'dmg * 100 / (100 + armor)'
```

---

## `toString()`

返回**原始表达式文本**。

> **`toString()` 返回的是构造时传入的源码字符串，不是重新格式化后的。**
> 做编辑器回显（把 AST 改回文本给人看）时要自己写序列化——
> 它只适合调试打印和缓存 key。
