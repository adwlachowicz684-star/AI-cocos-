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
| 拼错变量名 | 永远是 0，没有任何报错 | 用 `variables()` 对照检查 |
| 热重载后公式变了但没重编译 | 改了不生效 | 热重载时要重建 `Expression` 对象 |

## API

| 成员 | 说明 |
|---|---|
| `new Expression(src)` | 编译（**语法错误在此抛出**） |
| `evaluate(vars?)` | 求值。未定义变量当 0 |
| `evaluateStrict(vars?)` | 严格求值，未定义变量抛错 |
| `variables()` | 列出用到的变量名（**检查配置拼写**） |
| `source` | 原始表达式 |

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
