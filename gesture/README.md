# gesture · 手势识别

**swipe / drag / tap / longPress / circle / pinch**

---

## 它解决什么

移动端游戏需要滑动、拖拽、点击、长按、画圈、双指缩放。

手写的常见 bug：

- 抖动被当成滑动（手指微动几个像素就翻页了）
- **圆圈被当成长按**：圆圈首尾重合，首尾直线距离≈0，先命中"基本没动"分支就返回 longPress
- 累积转角不分正负（来回抖动累加出很大角度，被判成画圈）
- 双指起始距离为 0（`scale = d1/d0` 得到 Infinity）

## 用法

```typescript
// 一次性识别
const g = recognize(points);
// g.kind: 'swipe' | 'drag' | 'tap' | 'longPress' | 'circle' | 'none'
// g.dir:  'left' | 'right' | 'up' | 'down'

// 增量识别
const rec = new GestureRecognizer({ maxPoints: 64 });
rec.down(p); rec.move(p);
const g = rec.up(p);

// 双指缩放
recognizePinch(a0, b0, a1, b1);   // { kind:'pinch', scale }

// 双击
const d = new DoubleTapDetector();
d.tap(p);   // 第二次返回 true
```

### `GestureRecognizer` 增量接口

| 成员 | 说明 |
|---|---|
| `down(p)` / `move(p)` / `up(p)` | 触摸序列 |
| `active` | 是否正在跟踪一次手势 |
| `pointCount` | 已采集点数 |
| `cancel()` | 取消当前手势（`up` 不再产出结果） |
| `reset()` | 重置状态 |
| `isLongPressSoFar(now)` | **当前是否已构成长按** |

> **`isLongPressSoFar` 是给"长按进度条"用的。**
> 它在手指还没抬起时就告诉你能不能算长按，
> 做"按住 3 秒解锁"这类 UI 时，
> 进度环的实时反馈靠它，而不是等 `up()` 才知道结果。

> ⚠️ **"按了多久"用按下时刻算，不用轨迹里的第一个点。**
> `maxPoints` 是**滑动窗口**，超限时 `shift()` 丢的正是最早的点，
> 而"按了多久"恰恰由最早的点决定。
> 实测 `maxPoints: 8`、静止按住 1 秒（20 个采样点）：
> 窗口里最早的点已经是第 650ms 的，阈值 600ms 的长按被判成**单击**。
> 只有采样率高 / `maxPoints` 配得小的设备会复现，极难定位。
> 所以识别器在 `down()` 时单独记时刻；轨迹裁剪照旧（位移判定只看最近一段）。

> ⚠️ **`cancel()` 之后 `up()` 不再产出结果。**
> 系统打断手势（来电、切后台、多指变单指）时调它，
> 否则会误判出一个"划到一半"的手势。

## ⚠️ 坐标系

```typescript
recognize(pts, { yDown: true });    // 默认：屏幕坐标，y 减小 = 上
recognize(pts, { yDown: false });   // 世界坐标，y 减小 = 下
```

搞反了所有上下滑动都会反向，而且**看起来像"识别不准"**，很难联想到坐标系。

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **画圈必须最先判定** | 用路径总长而不是首尾距离判"够不够大" |
| **转角必须带符号** | 不分正负的话，抖 20 次每次 180° 累加就是 20π |
| **双指 d0=0 返回 scale=1** | 不是 Infinity |
| **缩放幅度不足返回 none** | 手抖不该触发缩放 |
| **三连击只算一次双击** | 第二次返回 true 后清空记录 |
| **移动过就不算长按** | 长按的语义是"按住不动" |

## API

### 顶层函数（可单独用）

| 函数 | 说明 |
|---|---|
| `pathLength(points)` | 路径总长度 |
| `totalTurn(points)` | **累计转角（弧度，带符号）** |
| `boundsOf(points)` | 轨迹包围盒 |
| `dirOf(dx, dy)` | 由位移判断方向 |

> ⚠️ **`totalTurn` 必须带符号，这是"画圈"能识别的前提。**
>
> 不区分方向地累加绝对值，来回抖动会累加出很大的值——
> 抖 20 次每次 180°，累加就是 20π，会被误判成画了 10 个圈。
> 带符号累加后正负抵消，**抖动的总转角接近 0**。
> 有测试专门锁住这一条。

> **`dirOf` 在 `|dx| === |dy|` 时归为水平方向。**
> 45° 斜划会被判成左/右而不是上/下——
> 需要八方向的话得自己处理边界。

### 类型

| 类型 | 取值 / 说明 |
|---|---|
| `GestureKind` | `'swipe'` / `'drag'` / `'tap'` / `'longPress'` / `'circle'` / `'pinch'` / `'none'` |
| `Direction` | `'left'` / `'right'` / `'up'` / `'down'` |
| `Gesture` | 识别结果：`kind` / `dir?` / `turns?` / 缩放倍数 |
| `Point` | `{ x, y, t }`（`t` 是毫秒时间戳） |
| `RecognizeOptions` / `RecognizerOptions` | 配置 |

> **`Gesture` 的 `turns` 是带符号弧度，画一个圈约 ±2π。**
> 顺时针和逆时针符号相反——想区分方向就看正负。

### 类

| 类 | 说明 |
|---|---|
| `GestureRecognizer` | 手势识别器（**有状态**：跟踪触摸序列） |
| `DoubleTapDetector` | 双击检测 |

## 测试

**37 项**，含一条专门验证"画圈不能被没动分支吃掉"，
以及一条验证来回抖动的累计转角很小。
