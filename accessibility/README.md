# accessibility · 可访问性

> ⚠️ **写完代码必须同时完成三件事**：① 测试 ② README ③ 登记进 `_kitmeta.json`

---

## 它解决什么

可访问性常被当成"发布前再说"的事，
但它实际上是**一组会同时影响 UI、音频、输入、渲染的全局开关**。

不做成统一模块，这些开关就散落各处，
改了一处忘了另一处——比如开了"减少动效"但震屏还在。

| 需求 | 影响 |
|---|---|
| 减少动效 | 震屏、闪白、转场、粒子、相机抖动全部关闭或减弱 |
| 色盲模式 | 红绿对比的元素改用形状/文字辅助区分 |
| 字号缩放 | UI 整体放大（还会影响布局溢出） |
| 高对比 | 文字加描边、背景加深 |
| 字幕 | 始终显示、显示说话人、背景板 |
| 单手模式 | 触控热区左右手切换 |
| 长按阈值 | 手抖玩家按不住 |

## 用法

```typescript
const a = new Accessibility({ reduceMotion: true, shakeScale: 0.5 });

// 表现层每次要播效果前先问一句
if (a.shouldPlay('shake')) camera.shake(a.shake(0.6));
if (a.shouldPlay('flash'))  screen.flash(0.8);

// 布局
label.fontSize = a.fontSize(16);
if (a.needsColorAid()) hpBar.addIcon();   // 不能只靠颜色区分
```

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **减少动效必须关震屏和闪光** | 这是防止前庭不适（晕动症），不是"画面朴素一点"。只关一项玩家会认为设置没生效 |
| **粒子可以保留** | 装饰性表现不引起不适，关掉反而让画面死板 |
| **震屏是"减弱"不是"开关"** | 玩家可以选 50% 而不是完全关掉——完全关掉会让一部分玩家觉得打击感没了 |
| **字号要夹范围** | 太小等于没有无障碍，太大会让文字跑出按钮外。这里夹到 [0.8, 2.0] |
| **三色盲是蓝黄难分，不是红绿** | 三种色觉障碍要分别处理 |
| **导入脏数据不崩溃** | 手改存档、旧版本残留都会遇到，抛错会让玩家进不去游戏 |
| **构造参数也会夹范围** | 以前只有 setter 夹，构造传 `shakeScale: 5` 得到 5、`setShakeScale(5)` 却得到 1——同一个值走不同路径结果不同。现在两者同口径 |
| **`fontScale` 传 NaN 直接抛错** | `fontSize()` 是 `base × fontScale`，一个 NaN 进去全 UI 字号变 NaN，文本消失且不报错。宁可构造时炸，也不能让 NaN 进布局 |
| **设置界面关掉要 `destroy()`** | `onChange` 闭包通常持有 UI 节点，不断开就是"切几次界面涨几 MB" |

## 预设

```typescript
Accessibility.standard();          // 全部关闭
Accessibility.motionSensitive();   // 前庭敏感：关动效 + 震屏归零
Accessibility.colorBlindRed();     // 红绿色盲
Accessibility.largeText();         // 大字号 + 高对比
```

## 完整接口

**读取**（都是只读属性）：

| 成员 | 说明 |
|---|---|
| `reduceMotion` / `colorBlind` / `fontScale` | 三项主要设置 |
| `highContrast` / `subtitles` / `subtitleSpeaker` | 高对比 / 字幕 / 字幕说话人 |
| `oneHanded` | `'off' \| 'left' \| 'right'`（单手模式） |
| `longPressMs` / `shakeScale` | 长按阈值（毫秒） / 震屏强度倍率 |
| `mirrored()` | 单手模式下是否要**镜像布局** |

**设置**：

`setReduceMotion(v)` / `setColorBlind(v)` / `setFontScale(v)` /
`setHighContrast(v)` / `setSubtitles(v)` / `setSubtitleSpeaker(v)` /
`setOneHanded(v)` / `setLongPressMs(v)` / `setShakeScale(v)`

> ⚠️ **`setFontScale` 和 `setShakeScale` 内部会夹范围**，
> 传超范围的值不报错——返回的是夹完之后的值。
> 别自己先夹一遍再传，容易两边夹的不一致。
>
> **构造函数用同一套夹取**（`fontScale` [0.8, 2] / `shakeScale` [0, 1] /
> `longPressMs` [200, 3000]），非有限值回落到默认值。
> 唯一的例外是 `fontScale` 传非正数：仍然抛错（见坑表格）。

**表现层查询**（**这三组是本模块的核心**）：

| 成员 | 说明 |
|---|---|
| `shouldPlay(kind)` | 这个效果该不该播（见上文设计） |
| `shake(amount)` | 把原始震屏量**乘上 `shakeScale`** 后返回 |
| `needsColorAid()` | 是否需要"除颜色外再加一个区分手段" |
| `avoidHuePair()` | 应避免的色对：`'red-green'` / `'blue-yellow'` / `null` |
| `fontSize(base)` | 把基准字号乘上 `fontScale` 并夹范围 |

> ⚠️ **`shake()` 返回的是"该用多大"，不是"能不能播"。**
> 正确写法是**两个都用**：
>
> ```typescript
> if (a.shouldPlay('shake')) camera.shake(a.shake(0.6));
> ```
>
> 只用 `shake()` 的话，`shakeScale = 0` 时会调用 `camera.shake(0)`——
> 白调一次，且某些引擎的 shake(0) 不等于不震。
> 只用 `shouldPlay()` 的话，玩家选了 50% 强度却完全不震。

> ⚠️ **`avoidHuePair()` 对三色盲（tritanopia）返回 `'blue-yellow'`。**
> 只处理红绿的话，蓝黄色盲玩家完全得不到帮助——
> 而"三色盲是蓝黄难分"这条写在坑表格里，靠人记住不靠谱。

**存档**：

| 成员 | 说明 |
|---|---|
| `exportState()` | 导出为 `Record<string, unknown>` |
| `importState(s)` | 导入（**脏数据不抛错**，见坑表格） |

> ⚠️ **不调 `exportState()` 的话，玩家每次进游戏都要重设一遍无障碍选项。**
> 而这恰恰是"最需要长期生效、重设成本最高"的一类设置。

**卸载**：

| 成员 | 说明 |
|---|---|
| `destroy()` | 断开 `onChange` 引用 |

> 本单元没有 `install`、没有定时器，看着"没什么可清理的"——
> 真正要清的就是 `onChange` 这一个引用。

### `EffectKind` 的全部取值

```
shake       震屏 / 相机抖动
flash       闪白 / 闪红 / 全屏闪光
transition  转场动画
particle    粒子 / 拖尾等装饰表现
autoCamera  自动镜头移动（过场）
loopAnim    循环动画（待机呼吸、UI 循环特效）
sway        屏幕震动之外的持续性画面晃动
```

> **`particle` 在减少动效下仍然返回 `true`**——这是刻意的。
> 装饰性粒子不引起前庭不适，关掉反而让画面死板。
> 详见坑表格。

### `ColorBlindMode`

```
'none' | 'protanopia' | 'deuteranopia' | 'tritanopia'
```

前两种是红绿色盲（红弱 / 绿弱），`tritanopia` 是蓝黄色盲。

### `AccessibilityOptions`

构造时传入，全部可选：

| 字段 | 说明 |
|---|---|
| `reduceMotion` | 减少动效 |
| `colorBlind` | 色觉模式 |
| `fontScale` | 字号倍率（夹到 [0.8, 2.0]） |
| `highContrast` | 高对比 |
| `subtitles` / `subtitleSpeaker` | 字幕 / 显示说话人 |
| `oneHanded` | 单手模式 |
| `longPressMs` | 长按阈值 |
| `shakeScale` | 震屏倍率 |

> 不想一项项配的话直接用预设：
> `Accessibility.standard()` / `motionSensitive()` /
> `colorBlindRed()` / `largeText()`。

## 设计：为什么用 `shouldPlay(kind)` 而不是一堆布尔量

散落的布尔量会导致"改了一处忘了另一处"。
统一入口让"减少动效到底影响什么"有一个地方可以查、
一个地方可以改、一条测试可以锁住。

## 示例

可运行的完整例子见 [`examples/accessibility-usage.ts`](../examples/accessibility-usage.ts)：

```bash
npm run build && node .build/examples/accessibility-usage.js
```

覆盖：影响面查询、震屏倍率、脏配置不进 UI、色觉障碍、存档往返与 `destroy()`。

## 测试

**28 项**，覆盖影响面、夹取范围、色觉障碍分支、预设、存档容错。
