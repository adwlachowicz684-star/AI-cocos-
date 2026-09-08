# JoystickMover
> 📋 **引擎实测**：本模块是库里**唯一**耦合 Cocos 引擎的单元。
> 第一轮挂载实测已通过（Cocos Creator 3.8.8，去掉 `typings/` 桩后零报错）。
> 第二轮的运行时实测已执行完，结论已并入本文；后续实测见 [`引擎实测任务_第四轮.md`](../引擎实测任务_第四轮.md)。

轮盘移动。你点名要的那个插件——**传入任意节点即可驱动**。

## 为什么要拆成两层

| 文件 | 职责 | 依赖引擎？ |
|---|---|---|
| `JoystickCore.ts` | 触摸点 → 方向向量（死区/归一化/吸附/多点） | ❌ 纯 TS，可单测 |
| `JoystickMover.ts` | 接引擎事件 + 画 UI | ✅ Cocos 组件（薄） |

如果混在一起：无法单测（构造函数就要 `new Node`）、换引擎要重写、换 UI 方案要重写。

拆分后 **Core 可以完整单测**，Mover 只做转接。

## Cocos 中的用法

1. Canvas 下建一个节点（如 `JoystickArea`），尺寸覆盖触摸区域
2. 挂上 `JoystickMover` 组件
3. 拖入底盘（`bgNode`）与摇杆头（`knobNode`）两个子节点
4. 业务代码里读方向

```typescript
// 方式 A：回调（只在变化时触发）
joystick.onDirectionChange = (dir, magnitude) => {
  mover.setInput(dir);       // 喂给你的 CharacterMover
};

// 方式 B：每帧读（物理移动常用）
update(dt: number) {
  const dir = joystick.direction;
  rigidbody.applyForce(dir.x * speed, dir.y * speed);
}
```

## 纯逻辑层用法（可单测 / 非 Cocos 场景）

```typescript
import { JoystickCore } from './joystick-mover/JoystickCore';

const joy = new JoystickCore({ radius: 80, deadZone: 0.15 });

joy.onDown(0, 100, 100);     // 触点 id=0 按下
joy.onMove(0, 150, 100);     // 向右推 50px
const o = joy.evaluate();
o.dir;    // { x: 1, y: 0 }  归一化后满舵
o.magnitude;  // 0.625（50/80）
o.angle;  // 0 度

joy.onUp(0);                 // 松开
joy.evaluate().dir;          // { x: 0, y: 0 } 归零
```

## 它不认识「角色」

组件只输出方向。**谁用这个方向、怎么用，是调用方的事。**

所以同一个组件能给：角色移动、炮台瞄准、镜头控制、菜单光标、载具方向……

## 关键参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `radius` | 80 | 摇杆半径（像素） |
| `deadZone` | 0.15 | 死区比例。**没有它手指微动会让角色持续抖动** |
| `mode` | 'dynamic' | fixed = 固定位置；dynamic = 按下的位置生成 |
| `snapDirections` | 0 | 0 = 自由，4 = 四向，8 = 八向（格子移动用） |
| `clampKnob` | true | 摇杆头是否限制在底盘内 |
| `normalizeOutput` | true | **必须开**，否则斜向移动快 1.41 倍 |

## ⚠️ 两个只在运行时暴露的坑

### ① 节点必须有 `UITransform`，否则摇杆**静默错位**

`_toLocal()` 里有一条降级路径：

```typescript
const ui = (this.touchArea ?? this.node).getComponent(UITransform);
if (ui) {
  ui.convertToNodeSpaceAR(this._tmpVec, this._tmpVec);   // 正确
} else {
  out.set(p.x, p.y);                                      // ⚠️ 退回屏幕坐标
}
```

**不报错、不警告**，只是摇杆位置悄悄错乱。
症状是"摇杆跟手但偏得很离谱"，你会先怀疑手感而不是组件没配对。

> 常与 `touchArea` 一起踩：你把 `touchArea` 指向了另一个节点，
> 那个节点没挂 `UITransform`，于是坐标全错。

### ② 传送角色后，摇杆中心不会自己更新（dynamic 模式）

`dynamic` 模式下，底盘中心记在 `onDown()` 那一刻：

```typescript
onDown(id, x, y) {
  if (this.mode === 'dynamic') {
    this._center.x = x;      // ← 中心在这里定下来
    this._center.y = y;
  }
  ...
}
```

**只有 `onUp()` / `reset()` 才会清掉它。**

于是这种情况会出错：

```typescript
player.teleport(0, 0);      // 角色传送到原点
// 但玩家的手指还按着，摇杆中心仍停留在传送前的位置
```

玩家手指没动，输入方向却突然变了——
因为 `(当前触点 - 旧中心)` 算出来的向量变了。
表现为"过场动画结束后，角色朝莫名其妙的方向走"。

**正确做法**：传送 / 重生 / 过场后，主动重置摇杆：

```typescript
stick.onUp(currentTouchId);   // 或 stick.reset()
// 玩家下次按下时，中心会重新按按下点计算
```

> 这条是 `examples/demo-moveloop.ts` 里实测踩到的：
> 场景 A 在 (0,150) 按下，场景 B 把角色传送到 (0,0) 却没重新按，
> 结果"向右下推"被算成了"向右上"，角色一路滑到反方向的墙根。

### ③ `output` 返回的是**复用对象**，别存引用

```typescript
evaluate(): JoystickOutput   // 每次返回同一个对象，不产生 GC
```

```typescript
const a = jm.output;
const b = jm.output;
a === b;   // true —— 同一个引用
```

所以这样写是错的：

```typescript
this.lastDir = jm.output.dir;   // ❌ 存的是引用，下一帧就被改写
```

**正确做法**（任取其一）：

```typescript
this.lastDir = { ...jm.output.dir };                    // 拷贝
// 或
jm.onDirectionChange = (dir, mag) => { this.lastDir = { ...dir }; };
```

表现为"方向偶尔跳变回上一次的值"——因为在别处改写了同一个对象。

**需要留一份副本时，用 `snapshot()` / `evaluateInto()` 而不是手写展开**：

```typescript
const snap = jm.snapshot();              // 一次性拿到值拷贝（零引用）
jm.evaluateInto(this._buf);              // 算进你自己的复用对象（零分配）
```

`evaluate()` 的零分配语义**没有改**（不 breaking）——它返回的仍是同一个复用对象。
新增的这两个入口是为了让"我就是要存一份"这个需求有正解，
而不是让每个人自己写 `{ ...jm.output.dir }`（`dir` 里还有 `magnitude`，
少拷一个字段就是一个新坑）。

### ④ 抬起事件是**广播**的，非驱动手指抬起不能复位摇杆

这是 2026-09-05 第三轮引擎实测才发现的——**前两轮都没测到**。

组件刻意不调用 `e.propagationStopped()`，好让技能按钮能收到触摸。
但触摸是广播的：**技能按钮那根手指抬起时，摇杆节点同样会收到 `TOUCH_END`**。

```typescript
// ❌ 错误：不看返回值，一律复位
_onTouchEnd(e) {
  this._core.onUp(e.getID());
  this.bgNode.active = false;        // 摇杆视觉消失
  this.onDirectionChange({x:0,y:0}, 0);  // 输出清零
  this.onEnd?.();                    // 误报"松手了"
}
```

出问题的时序：

```
指1 按住摇杆移动        → 角色在跑
指2 点技能按钮（tap）
指2 抬起                → 摇杆消失、输出清零、onEnd 误报
                          而指1 还按着
```

表现：**"点一下技能，角色就顿一下"**。
这正是"边移动边放技能"最不能接受的手感。

**正确做法**：`onUp()` 返回 `boolean`，只有驱动手指抬起才复位。

```typescript
// ✅ 正确
if (!this._core.onUp(e.getID())) return;   // 不是驱动手指，什么都不做
// 下面才做 UI 复位与 onEnd
```

> 一句话记忆：**防住了按下，没防住抬起。**
> 这类 bug 的成因都是"验证了 A 路径就以为 B 路径也成立"。

---

## 坑

- **输出不归一化** ⚠️ 斜向移动速度是直线的 **1.41 倍**（x、y 都是 1）
- **没有死区** → 手指微动导致角色抖动
- **松开后方向没归零** → 角色一直朝一个方向走（经典 bug，单测容易漏）
- **多点触摸没处理** → 第二个手指（如点技能）抢占摇杆，角色突然转向
- **抬起事件没判 `onUp()` 返回值** → 点技能的手指抬起导致角色顿一下（见 ④）
- **坐标没做 `convertToNodeSpaceAR`** → 有缩放/偏移的 Canvas 下完全错位
- ** Cocos 组件忘记 `off`** → 切场景后报 null（最常见的内存泄漏源头之一）
- **`e.propagationStopped()` 乱用** → 会阻断其他 UI（技能按钮）的触摸
- **归一化后裸乘 `dir`** → 一过死区就满速起步，没有渐进（见下）

## 手柄 / 键盘复用

```typescript
// 键盘或手柄也可以驱动同一个 Core，输出逻辑完全一致
joystick.setAxis(inputX, inputY);
```

这样键鼠、触屏、手柄三条输入路径共用同一套死区与归一化逻辑，行为一致。

**触摸可以接管**：外部驱动期间玩家直接摸屏幕会被接受，
不需要调用方先 `reset()`。真实触点的 id 从 0 开始，
而 `setAxis` 内部用 `-1` 作哨兵，两者不会冲突。

> 【为什么不做成"必须 reset 才能接管"】
> 要求调用方记得先调某个方法，等于把内部状态泄漏给了外部。
> 这类"记得调"的约定正是本库一直在消除的东西。

## 起步手感：`dir` 是归一化满量，`magnitude` 才是渐进的

`normalizeOutput: true`（默认）时，`dir` 被强制归一到长度 1，
与 `magnitude` **解耦**：

```typescript
// 死区 0.15 时，手指从 0.149 → 0.16 跨过边界：
o.magnitude   // 0.149 → 0.16    连续
o.dir         // (0,0) → (1,0)   ← 直接跳到满量，无渐进
```

所以这两种写法的手感**完全不同**：

```typescript
velocity = dir * speed;            // ❌ 一过死区就满速起步
velocity = dir * magnitude * speed; // ✅ 渐进加速，手感线性
```

| 用法 | 手感 | 适合 |
|---|---|---|
| `dir` 裸乘 | 起步瞬间满速，无渐进 | 格子移动、八向摇杆 |
| `dir * magnitude` | 推多少走多少，线性渐进 | 模拟摇杆、需要精细走位 |

> 死区只闸门 `ratio`（判断是否激活），**不闸方向幅值**——
> 这是刻意的设计：死区要保证"低于阈值完全不动"，
> 而幅度渐变交给 `magnitude`。两者职责不同。

## API

### JoystickCore
| 成员 | 说明 |
|---|---|
| `onDown(id, x, y)` | 按下，返回是否接受（多点触摸会拒绝第二个） |
| `onMove(id, x, y)` | 移动 |
| `onUp(id)` | 抬起（自动归零） |
| `evaluate()` | 计算输出（返回复用对象，零 GC） |
| `snapshot()` | 输出的**值拷贝**（要存下来用这个） |
| `evaluateInto(out)` | 算进调用方的复用对象（零分配） |
| `setAxis(x, y)` | 外部驱动（键盘/手柄） |
| `center` / `knob` | UI 定位用 |
| `isActive` | 是否有触点 |
| `destroy()` | 重置 |

### JoystickOutput
```typescript
{
  dir: { x, y },     // 方向，长度 0..1
  magnitude: number, // 偏移占半径比例 0..1
  angle: number,     // 角度（度，0 = 右）
  active: boolean,   // 是否超过死区
}
```

`reset()` —— 清空触点并归零。**抬起时会自动调，一般不用手动**。

### `JoystickMover`（Cocos 组件）

挂载后外部每帧读：

| 成员 | 说明 |
|---|---|
| `output` | 当前输出（`JoystickOutput \| null`，**没触摸时是 null**） |
| `onStart` / `onEnd` | 触摸开始 / 结束回调 |
| `radius` / `deadZone` / `snapDirections` / `clampKnob` | 属性面板可调 |
| `isDynamic` | `fixed` = 固定位置；`dynamic` = 按哪从哪冒出来 |
| `bgNode` / `knobNode` / `touchArea` | UI 节点引用（都可留空，留空则无视觉反馈） |
| `onLoad()` / `onDestroy()` | Cocos 生命周期，**由引擎调用，不要手动调** |

> ⚠️ **`touchArea` 与 `bgNode`/`knobNode` 必须挂在同一父链下。**
>
> `center` 是触摸点在 `touchArea` **局部空间**的坐标，
> 而 `bgNode.setPosition(center)` 期望 `bgNode` 与 `touchArea` **同坐标系**。
> 若 `touchArea` 指向外部节点、而 `bg`/`knob` 挂在别的父节点下，
> 定位会随层级变换错位——表现为"摇杆显示在手指旁边但偏了一段"。
>
> 最省事的做法：**`touchArea` 留空**（默认取本节点），
> 此时 `bg`/`knob` 挂在组件所在节点下即可，坐标系天然一致。

> ⚠️ **运行时改属性不生效，需重建。**
>
> `isDynamic` / `radius` / `deadZone` / `snapDirections` / `clampKnob`
> 都在 `onLoad()` 构造 Core 时读取，之后改属性面板不会重建 Core。
> 引擎实测确认：改了 `clampKnob=false` 后 knob 仍被钳制在 `radius` 内。
>
> 要改就新建节点重挂，或在编辑器里改完重启场景。

> ⚠️ **`onLoad()` / `onDestroy()` 是 Cocos 的生命周期钩子，不要手动调用。**
>
> 手动调 `onDestroy()` 会解绑触摸监听，但引擎销毁组件时还会再调一次——
> 第二次在已解绑的状态上操作，行为未定义。
>
> 要重置摇杆状态用 `reset()`，它只清内部状态、不动监听。

### `JoystickCore`（纯逻辑）

| 成员 | 说明 |
|---|---|
| `reset()` | 清空状态（**换关卡 / 复用组件时用**） |

```typescript
// 角色移动：每帧读 output
const out = joystick.output;
if (out && out.active) mover.update(dt, out.dir.x, out.dir.y);
```

> ⚠️ **`output` 在没触摸时是 `null`，不是"全零对象"。**
> 写 `joystick.output.dir.x` 会在松手那一帧炸。
> 判 `out && out.active` 两层都要——
> `active` 单独为 false 是指"在死区里"（手指按着但没动够）。
