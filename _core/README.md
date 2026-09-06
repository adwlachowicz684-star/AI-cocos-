# _core — 第 0 层：纯函数与类型接口

## 为什么有这一层

铁律 6 禁止插件间横向依赖，但 `clamp` 这种纯函数如果每个插件复制一份，
是另一种浪费（改一处要改十处）。

`_core` 和 `ds` 构成**第 0 层**，是唯一允许被其他插件 import 的地方。

## 准入条件（极严）

- 无任何状态
- 无副作用
- 不需要配置
- 不 import 引擎
- **不 import 任何其他插件**

一旦某个工具需要状态或配置（比如"带缓存的加载器"），
就该成为独立的第 1 层插件，而不是塞进这里。

## 内容

### `math.ts`
`clamp` / `lerp` / `smoothDamp` / `clamp01` / `remap`
`Easing`（13 个缓动函数）/ `wrapAngle` / `remap` / `inverseLerp`

### `types.ts`

| 导出 | 说明 |
|---|---|
| `IVec2` | 二维向量接口 `{ x, y }` |
| `IRandomSource` | 随机源接口（`next(): number`）。**所有随机逻辑依赖它而不是 `RNG` 具体类** |
| `IRange` | 区间 `{ min, max }` |
| `IDisposable` | 可释放接口（**`destroy()`**，不是 `dispose()`） |
| `MathRandomSource` | 基于 `Math.random()` 的随机源实现（不需要复现时用） |
| `vec2(x, y)` / `setVec2(out, x, y)` | 构造 / **就地**设置（高频路径避免分配） |
| `len2(v)` / `normalize2(v)` | 长度平方 / 归一化（返回**新对象**） |

#### 矩形：两种表示法并存

| 导出 | 说明 |
|---|---|
| `IRect` | **角点表示法** `{ minX, minY, maxX, maxY }` |
| `IRectSized` | **位置+尺寸表示法** `{ x, y, w, h }` |
| `toCorners(sized)` / `toSized(corners)` | 两种表示法互转（返回新对象） |
| `setCorners(out, minX, minY, maxX, maxY)` | **就地**写入角点矩形（热路径免分配） |
| `rectContains(r, x, y)` | 点是否落在角点矩形内（含边界） |
| `rectOverlaps(a, b)` | 两个角点矩形是否相交（含相切） |

> ⚠️ **全库有 3 个叫 `Rect` 的类型，坐标系不同，别混用。**
>
> | 模块 | 字段 | 表示法 |
> |---|---|---|
> | `camera` | `minX / minY / maxX / maxY` | 角点 |
> | `ds` / `dungeon` | `x / y / w / h` | 位置+尺寸 |
>
> 都叫 `Rect`。调用方会以为 `Rect` 就是 `Rect`，
> 于是写出 `x + w` 却拿到 `minX/maxX` 的语义——
> **不报错，只是算出错误的矩形。**
>
> 同理，`IVec2` 也有 3 份定义（`_core` / `fov` / `steering`），
> `Vec2` 有 2 份（`camera` / `minimap`）。字段都是 `{x, y}` 所以互换不报错，
> 但 `readonly` 修饰和配套工厂各不相同。
>
> **新代码请用 `IRect` / `IRectSized` 和 `_core` 的 `IVec2`**，名字无歧义。
> 各模块保留本地定义是为了"单文件可复制"，不是为了让你继续用。

> ⚠️ **`IDisposable` 的方法名是 `destroy()`，不是 `dispose()`。**
> 表格里曾写作 `dispose()`。照它实现的话接口对不上——
> 而且 TypeScript 的结构化类型会**静默接受**不匹配的签名，
> 直到调用 `destroy()` 时才报"不是函数"。

> ⚠️ **本模块不再导出 `Partial<T>`（已删除）。**
> 它曾与 TS 内置的 `Partial<T>` 同名，一旦被 import 就遮蔽全局版本，
> 让读代码的人无法判断某个 `Partial<Foo>` 指哪一个。
> 全库 0 处引用，纯负收益。需要"部分覆盖"语义请直接用内置的 `Partial<T>`。

> ⚠️ **曾经这里写过 `ITickable`，但源码里从来没有这个类型。**
> 照着它写 `implements ITickable` 会编译失败。
> 文档里写了不存在的 API 比漏写更糟——**漏写你会去看源码，写错你会信文档**。

### `math.ts`

| 导出 | 说明 |
|---|---|
| `clamp(v, min, max)` / `clamp01(v)` | 夹紧。`clamp01` 是 `clamp(v, 0, 1)` 的快捷版 |
| `lerp(a, b, t)` / `inverseLerp(a, b, v)` | 插值 / **反向**插值（"v 在 a→b 里的位置"） |
| `remap(v, a1, b1, a2, b2)` | 区间重映射 |
| `lerp(a, b, t)` | 线性插值（**帧率相关**，见下方说明） |
| `smoothDamp(cur, target, vel, smoothTime, dt)` | 帧率无关阻尼（Unity 那套） |
| `clamp01(v)` | 夹到 `[0,1]` |
| `remap(v, inMin, inMax, outMin, outMax)` | 区间重映射 |
| `maxOf(xs, fallback?)` / `minOf(xs, fallback?)` | 数组极值。空数组返回 `fallback`（**默认 0**，不是 `-Infinity`） |

#### `maxOf` / `minOf` 与 `Math.max` 的两处差异

```typescript
maxOf([1, 5, 3])      // 5
maxOf([])             // 0      ← 空数组的兜底，Math.max() 会返回 -Infinity
maxOf([], -1)         // -1     ← 兜底值可指定
maxOf([1, NaN, 3])    // NaN    ← NaN 传染，与 Math.max 一致
```

| 场景 | `Math.max(...xs)` | `maxOf(xs)` |
|---|---|---|
| 空数组 | `-Infinity` | `fallback`（默认 `0`） |
| 含 NaN | `NaN` | `NaN`（**同样传染，不静默跳过**） |
| 大数组（>10 万） | 可能栈溢出（展开成参数） | 循环，无上限 |

**NaN 为什么要传染**：源码注释写明"NaN 参与的比较恒为 false，
所以 NaN 会被跳过；但不该静默跳过——所以显式检测，遇到 NaN 就返回 NaN"。
这是本项目的一贯口径：**宁可让坏值可见地传播，也不要静默降级**。
（同一个判断也用在 `curve.evaluate(NaN)` 维持不修上，理由一致。）

**空数组返回 0 而不是 -Infinity 的理由**：`maxOf` 的典型用法是
"取这批数的最大值"，空集合的语义是"没有值"——
返回 `0` 至少是有限的、能参与后续运算；
返回 `-Infinity` 会让后续除法得到 `-0` 或 NaN，且没有任何提示。
**需要的语义不是 0 时，显式传第二个参数。**

> ⚠️ **本模块没有 `approach()` / `damp()`。**
> 早期文档里出现过这两个名字，但源码从未实现过。
> 需要的效果请这样实现：
>
> | 想要 | 用什么 |
> |---|---|
> | "朝目标逼近，最多走 maxDelta" | `clamp(target - cur, -maxDelta, maxDelta) + cur` |
> | "帧率无关阻尼" | `smoothDamp(cur, target, velRef, smoothTime, dt)` |

#### 边界契约：退化区间怎么处理

这几个函数在输入"退化区间"时**不报错**，但行为需要知道：

| 情况 | 表达式 | 结果 | 说明 |
|---|---|---|---|
| 区间反转 | `clamp(5, 10, 0)` | `10` | 恒返回 `min`，**不是**夹到 [0,10] |
| 单点区间 | `remap(5, 3, 3, 0, 100)` | `0`（= `outMin`） | 经 `inverseLerp → 0`，丢失映射语义 |
| 除零保护 | `inverseLerp(3, 3, 5)` | `0` | 刻意设计，防 NaN |

**为什么不管**：`min > max` 是调用方的 bug，抛错会把"配错了表"
变成运行时崩溃。但下游应避免传退化区间——
尤其 `remap` 用在**数值配置驱动**的地方（策划表填错上下界），
结果是"所有值都变成 outMin"，表现为"这个属性怎么调都不生效"。

**`smoothDamp` 的实测行为**（2026-09-05 实测，均为 Unity 标准行为，非 bug）：

- **大 dt 不完全收敛**：`smoothDamp(0, 10, {v:0}, 0.1, 5)` → `9.9958`（差 0.042%）。
  根因是泰勒展开近似 `exp` 在 x 极大时非精确为 0。正常帧率下无影响。

- ✅ **`maxSpeed` 限制的就是每帧速度**（2026-09-06 修正）

  完整签名是 `smoothDamp(current, target, velRef, smoothTime, dt, maxSpeed = Infinity)`。
  偏差超过 `maxSpeed * smoothTime` 时，本帧的目标点会先回退到 `current - change`，
  因此**单帧位移始终落在 `maxSpeed * dt` 量级以内**：

  ```
  smoothDamp(0, 1000, v, 1, 1/60, 5)    →   0.0026   （maxSpeed*dt = 0.083）
  smoothDamp(0, 1000, v, 1, 1/60, 50)   →   0.0262   （maxSpeed*dt = 0.833）
  smoothDamp(0, 1000, v, 1, 1/60, 2000) →   0.5243   （未触发限速，正常渐进）
  ```

  追赶能力不受影响：`maxSpeed=50` 追 1000px 用 21.1 秒（理论最快 20 秒，
  差值来自起步加速与尾部收敛）。

  > ⚠️ **这段说明曾被写反，别再改回去。**
  > 旧版本写的是"`maxSpeed` 极具误导性，它不限制每帧速度，
  > 首帧直接跳到 995"，并标注"均为 Unity 标准行为，非 bug"。
  >
  > 实测数据没错，**归因错了**：995 不是 Unity 的行为，
  > 而是本实现漏掉了 Unity 里 `target = current - change` 这一行导致的。
  > 缺这一行时，限速只是把"要奔赴的目标"拉近了，
  > 却仍然以**原始 target** 为基准做插值，于是首帧跳到离目标 5 的位置——
  > 表现为"设了最大速度，瞬移时反而闪现得更远"。
  >
  > 这类"实测数据为真、归因为假"的记录比没有记录更危险：
  > 它会让下一个看到的人打消修复的念头。

| `smoothDamp(cur, target, vel, t, dt)` | 阻尼（维护速度引用，Unity 语义） |
| **`safeDt(dt)`** | **dt 守卫**：只有"有限且为正"返回 true |
| **`clampNum(v, min, max, fallback)`** | **容量字段兜底**：非有限值回退，有限超界截断（**有上界**） |
| **`numOr(v, fallback)`** | **普通配置兜底**：只兜非有限值，**不定上界** |
| `wrapAngle(deg)` / `normalizeAngleRad(rad)` | 角度归一化到 (-180,180] / (-π,π] |
| `angleDiff(from, to)` / `angleDiffRad(from, to)` | **最短**角差（走小弧，结果带符号） |
| `angleLerp(from, to, t)` / `angleLerpRad(from, to, t)` | 角度插值（**走最短路径**，不会绕远） |
| `approximately(a, b, eps)` | 浮点近似相等 |
| `easing(name)` / `Easing` | **13 个**缓动函数；传字符串取函数 |

> ⚠️ 本节原写"30+ 缓动函数"，**实测是 13 个**。
> 已按源码 `Easing` 对象的实际键数更正。

**全部 13 个缓动**：

```
linear
inQuad    outQuad    inOutQuad
inCubic   outCubic   inOutCubic
outQuart  inOutQuart
outExpo
outBack   outElastic  outBounce
```

> ⚠️ **只有 `out` 系列的有 `outExpo` / `outBack` / `outElastic` / `outBounce`，
> 没有对应的 `inExpo` / `inBack` / `inElastic` / `inBounce`。**
> 写 `easing('inBounce')` 不报错（签名接受 `string`），
> 但返回的是 `linear`——
> 表现为"缓动没生效"，而你会以为名字写对了。

> ⚠️ **`easing()` 的参数类型是 `EasingName | string`。**
> 这个 `| string` 让拼错的名字**通过编译**——
> 代价就是上面那条。想让编辑器帮你检查就用 `Easing.xxx` 直接取，
> 只在需要动态选择（配置表里存名字）时才用 `easing(name)`。

### `string.ts`

> **这一节 2026-09-06 新建。** 这三个函数此前长期"存在于源码、缺席于文档"——
> 审查脚本报「`_core` 有 5 个导出 README 未提」，其中 3 个就在这里，
> 且整个 `string.ts` 章节都是空的。

**为什么会有这一层**：`cheatcode` 与 `debug-console` 各自写了一份命令解析器，
**连空串保留和单引号处理都一模一样**，只有错误文案不同。
已下沉到 `_core`，两处改为转发（对外 API 未变，含各自的报错前缀）。

| 导出 | 说明 |
|---|---|
| `editDistance(a, b)` | Levenshtein 编辑距离，**越小越像**，0 = 完全相同 |
| `similarity(a, b)` | 相似度 **0~1**，1 = 完全相同（**有长度差短路，见下**） |
| `tokenize(input, opts?)` | 命令串切分（支持引号、NBSP），未闭合引号**抛错** |

---

#### ⚠️ `similarity` 有长度差短路 —— 两个函数可能给出"矛盾"的答案

这是本模块最需要注意的一点（2026-09-06 实测，6 组样本）：

```typescript
// 长度差 > max(la, lb) * 0.6 时，直接返回 0，不再算编辑距离
if (Math.abs(la - lb) > Math.max(la, lb) * 0.6) return 0;
```

| 输入 | `editDistance` | `similarity` | 说明 |
|---|---|---|---|
| `("godmode", "godmod")` | 1 | 0.857 | 正常 |
| `("godmode", "godmodexyz")` | 3 | 0.700 | 正常 |
| `("godmode", "godmodexxxxxxxx")` | 8 | 0.467 | 正常 |
| `("godmode", "completely-different")` | **17** | **0.000** | ⚠️ **短路判 0** |

最后一行是问题所在：**编辑距离只有 17，但相似度直接是 0**。
两者看起来矛盾，实际是短路生效（7 vs 20，长度差 13 > 20×0.6=12）。

**后果**：用 `similarity > 阈值` 做命令纠错 / 模糊匹配时，
两个**长度差很大但内容相关**的字符串会被判为完全不相似。
比如 `similarity("hp", "hitpoints-remaining")` = 0，
尽管后者确实包含前者的语义。

**该用哪个**：

| 场景 | 用 |
|---|---|
| 要"编辑了几个字符"的绝对量（排序、找最近项） | `editDistance` |
| 要"像不像"的归一化判断，**且候选长度接近** | `similarity` |
| 候选长度可能差很多 | **别用 `similarity`**，用 `editDistance` 自己归一化 |

> 短路本身是**性能优化**（省一次 O(n×m)），不是 bug。
> 但在长度不可控的场景下，它把"性能优化"变成了"结果错误"。

---

#### `tokenize` 的四条实测行为

（2026-09-06 实测，7 组样本）

| 输入 | 输出 | 说明 |
|---|---|---|
| `give "" 1` | `["give","","1"]` | ⚠️ **空串会保留**，不跳过 |
| `give  1`（双空格） | `["give","1"]` | 连续空白合并 |
| `say "a b"` | `["say","a b"]` | 引号内保留空格 |
| `set 'q x' 5` | `["set","q x","5"]` | **单引号等同双引号** |
| `a\u00a0b`（NBSP） | `["a","b"]` | 不换行空格当分隔符 |
| `a\u3000b`（全角空格） | `["a","b"]` | 同理 |
| `say "a b`（未闭合） | **抛错** | 见下 |

**空串为什么必须保留**：GM 指令按位置取参数。
若空串被跳过，`give "" 1` 会变成 `["give","1"]`，
第 2 位参数从 `""` 变成 `1`——**执行到完全不同的操作**。
这一条 2026-08 曾在 `cheatcode` 出过 bug（两份解析器分化），已修。

**未闭合引号抛错，且文案可定制**：

```typescript
tokenize('say "a b');
// 默认：Error: [_core/string] 引号未闭合：say "a b

tokenize('say "a b', { onUnclosedQuote: (s) => new Error(`[CheatCode] 引号未闭合：${s}`) });
// 自定义前缀——cheatcode 与 debug-console 正是靠这个保持各自文案
```

**为什么要认 NBSP / 全角空格**：玩家会**复制粘贴**。
从网页或 Word 复制的文本常带 NBSP，只认 ASCII 空格的话
`god\u00a0mode` 会被当成一个 token，命令永远匹配不上，
**而且没有任何报错提示**。

---

### 常量

| 常量 | 值 | 说明 |
|---|---|---|
| `DEG2RAD` | `Math.PI / 180` | 度 → 弧度 |
| `RAD2DEG` | `180 / Math.PI` | 弧度 → 度 |

> ⚠️ **角度相关的函数分度/弧度两套**（`angleDiff` vs `angleDiffRad`）。
> 传错单位不报错——结果是错的，
> 表现为"转身方向偶尔不对"。

> **角度相关的四个函数值得单独说。**
> 直接对角度做 `lerp(350, 10, 0.5)` 会得到 180——**方向完全相反**。
> `angleLerp` 会走 350→360/0→10 这条 20° 的短路径。
> 这类 bug 在"角色转身"上表现为**偶尔往反方向转一整圈**，
> 只在跨越 0°/360° 时复现，极难定位。

## 为什么 `_core` 不 import `rng`

`types.ts` 里的 `IRandomSource` 只是个**接口**，不是实现。

所以 `loot/` 可以不依赖 `rng/`，但调用方能把 `RNG` 传进去：

```typescript
table.pick(new RNG(12345));              // 可复现
table.pick(MathRandomSource);            // 不需要复现时
table.pick(new FixedRandomSource([0.5, 0.9]));   // 测试里精确控制
```

好处：**所有随机逻辑都变得可测试**。

三个内置实现：

| 实现 | 用途 |
|---|---|
| `RNG`（在 `rng/`） | 可复现的伪随机（带种子） |
| `MathRandomSource` | 包装 `Math.random`，**不需要复现时**用 |
| `FixedRandomSource` | 固定序列，**测试里精确控制** |

### `FixedRandomSource`

```typescript
const src = new FixedRandomSource([0.5, 0.9]);
src.next();   // 0.5
src.next();   // 0.9
src.next();   // 0.5  ← 循环回开头，不是取不到
```

| 成员 | 说明 |
|---|---|
| `next()` | 取下一个值（**到末尾后循环**，不是返回 undefined） |
| `calls` | 已取用的次数（**测试断言用**） |
| `reset()` | 回到开头 |

> ⚠️ **`next()` 到序列末尾会循环，不会抛错也不会返回 `undefined`。**
> 想验证"随机被消费了几次"用 `calls`——
> 靠"取到 undefined 了"来判断是行不通的。

> **`calls` 是 `FixedRandomSource` 存在的主要理由。**
> 它让"这个掉落表消费了 3 次随机数"这种断言成为可能，
> 从而能测出"多消费了一次随机数导致后续全部错位"这类 bug。

> ⚠️ **`MathRandomSource` 不要用在需要复现的地方。**
> 它每次结果都不同——
> 混用它的存档无法回放。

### `IRandomSource`

```typescript
interface IRandomSource {
  /** 返回 [0, 1) 的随机数 */
  next(): number;
}
```

> ⚠️ **契约是 `[0, 1)`，不是 `[0, 1]`。**
> 实现返回 1.0 的话，下游 `Math.floor(r * len)` 会**越界取到 undefined**——
> 表现为"偶发性的掉落为空"。
> 自己实现这个接口时必须保证取不到 1。

## 依赖它的插件

behavior-tree, card, damage-pipeline, grid, input,
joystick-mover, loot, scheduler, skill-player, tween

（脚本扫描结果，**无环**）

---

## ⚠️ 异常数值防护（全库统一口径）

外部精审报告指出：全库大量"时间推进"方法对 `dt` 的校验不一致，
`NaN` / `Infinity` / 负数会穿透，造成**不可自愈**的状态污染。

收口成两个工具函数，**以后不要再手写等价逻辑**。

### `safeDt(dt)` —— 替代 `dt <= 0`

```typescript
update(dt: number): void {
  if (!safeDt(dt)) return;     // ✅
  // ...
}
```

| 写法 | 负数 | NaN | Infinity |
|---|---|---|---|
| `if (dt <= 0) return;` | ✅挡 | ❌**穿透** | ❌**穿透** |
| `if (!(dt > 0)) return;` | ✅挡 | ✅挡 | ❌**穿透** |
| `Math.max(0, x - dt)` | ❌反向延长 | ❌变 NaN | ✅归零 |
| **`safeDt(dt)`** | ✅ | ✅ | ✅ |

盲区的算术原因：

- `NaN <= 0` 是 `false` → `dt <= 0` 对 NaN 无效
- `Infinity > 0` 是 `true` → `!(dt > 0)` 对 Infinity 无效
- `Math.max(1, NaN)` 是 `NaN` → Math.max **不做有限性检查**

**后果有多严重**：一个 NaN 帧就能让角色坐标永久变 NaN
（`NaN + 任何数 === NaN`，再正常几百帧也回不来），
角色从游戏中消失且不报错。负数 dt 则让冷却反向延长。

### `clampNum(v, min, max, fallback)` —— 替代 `Math.max(1, x ?? 100)`

```typescript
this._limit = clampNum(opts.limit, 1, 1e6, 100);    // ✅
this._limit = Math.max(1, opts.limit ?? 100);       // ❌ NaN 直接穿过
```

**后果**：上限字段被绕过。撤销栈的 `limit` 变 NaN 后
`length > NaN` 恒为 false → 栈永不裁剪 → **内存无限增长**。

**`clampNum` 的真实语义**（容易记错）：

```
clampNum(NaN,       1, 1e7, 100) === 100      // 非有限 → 回退 fallback
clampNum(Infinity,  1, 1e7, 100) === 100      // 同上，不是 1e7
clampNum(1e9,       1, 1e7, 100) === 1e7      // 有限但超界 → 截断到上界
clampNum(-5,        1, 1e7, 100) === 1        // 下界
```

**Infinity 走的是 fallback 而不是截断**——这是刻意的：
Infinity 是荒谬输入，回退默认比截断到 1e7 更保守。
副作用是"上界只在'有限但超界'时才起作用"，
所以测上界要用 `1e9` 这样的有限大值，用 `Infinity` 测不到。

### `numOr(v, fallback)` —— 只兜非有限值，不定上界

```typescript
this._outMs = Math.max(1, numOr(cfg.outMs, 300));   // ✅ 普通配置
this._capacity = clampNum(opts.capacity, 1, 1e7, 100); // ✅ 容量字段
```

**为什么有了 `clampNum` 还需要它**：`clampNum` 强制要求上界。
给普通配置定上界会**误伤合法值**——`transitionMs: 600_000`
（10 分钟切换）是完全合法的配置，被裁成 1e4 就是悄悄改掉用户意图，
**且没有任何报错**。这比 NaN 穿透更隐蔽：NaN 至少能被断言抓到。

**怎么选**：

| 字段类型 | 用哪个 | 理由 |
|---|---|---|
| 容量/上限（limit / capacity / bufferSize / depth） | `clampNum` | Infinity 会让裁剪判定恒 false，内存无限增长 |
| 普通配置（时长 / 距离 / 阈值 / 速度） | `numOr` + 原 `Math.max/min` | 上界需要理解业务上限，猜错就是静默改配置 |

`scripts/scan-num-guard.py` 会拦住未收口的写法（已接入 `verify.sh`）。
它只检查"有没有用这两个函数"，**不检查选对了没**——
选哪个需要理解字段语义，机器判断不了。

### 非有限角度归一到 0

`normalizeAngleRad(NaN)` / `(±Infinity)` 返回 **0**，不是 NaN。

**为什么**：NaN 若透传，下游 `abs(diff) > halfAngle` 恒为 false
→ 感知静默失效、判定结果不可预测，比"当作 0"难排查得多。
0 是确定且可解释的取值。

该实现用**取模**而非 while 循环——`Infinity - 2π` 仍是 `Infinity`，
while 版本会永久死循环。取模是 O(1)，结构上不可能死循环。
