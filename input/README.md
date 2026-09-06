# InputManager

> ⚠️ **本目录有两个插件，这份只讲 InputManager。**
>
> 输入缓冲（提前按键、CD 补发）看
> **[`README_InputBuffer.md`](./README_InputBuffer.md)**。
>
> 那个模块是 `skill-queue` 的依赖——
> 「技能还有 0.1 秒 CD、玩家提前点击，CD 到了自动放」
> 靠的就是它。只知道 InputManager 的话，会以为库里没有输入缓冲。

统一输入抽象：把键盘、鼠标、触摸、手柄统一成「动作名 → 状态」。

统一输入抽象：把键盘、鼠标、触摸、手柄统一成「动作名 → 状态」。

## 它解决什么

直接监听按键的写法：

```typescript
if (keyboard.isDown('W')) moveUp();   // ❌
```

问题：① 玩家无法改键 ② 加手柄支持要重写所有逻辑 ③ 触摸端怎么办

抽象成「动作名」后：

```typescript
input.getAxis('move');           // { x, y } 不管来自 WASD、摇杆还是手柄
input.isPressed('attack');
input.wasJustPressed('dash');
```

换设备、改键位、加触摸——**游戏逻辑一行不用改**。

## 三个必须理解的时间概念

| 状态 | 含义 | 用途 |
|---|---|---|
| `pressed` | 当前是否按住 | 持续动作（移动、蓄力） |
| `justPressed` | **这一帧**刚按下 | 触发一次的动作（跳跃、攻击） |
| `justReleased` | **这一帧**刚松开 | 蓄力释放、取消 |

## 用法

```typescript
import { InputManager, Key } from './input/InputManager';

const input = new InputManager();

// 绑定
input.bindAxis('move', {
  negativeX: [Key.A], positiveX: [Key.D],
  negativeY: [Key.S], positiveY: [Key.W],
});
input.bindButton('attack', [Key.Space, Key.MouseLeft]);
input.bindButton('dash', [Key.ShiftLeft]);

// 每帧（顺序很重要）
update(dt: number) {
  input.beginFrame();                          // ① 重置 + 从按键推导
  input.setAxisAnalog('move', padLX, padLY);   // ② 注入模拟量（手柄/摇杆）

  const dir = input.getAxis('move');           // ③ 读取
  player.move(dir, dt);
  if (input.wasJustPressed('attack')) player.attack();

  input.endFrame();                            // ④ 清除 just 状态
}
```

### ⚠️ 调用顺序

**`setAxisAnalog` 必须在 `beginFrame` 之后。**

beginFrame 会重置所有轴（数字键状态每帧都要重算）。
如果先注入再 beginFrame，模拟量会被清掉——
表现为「手柄摇杆完全没反应」，而且很难看出原因。

## 改键

```typescript
// 重新绑定
input.rebind('dash', [Key.Q], 0);

// 查询当前绑定（做改键 UI 用）
input.getBinding('dash');    // readonly KeyCode[]

// 存档
const saved = input.exportBindings();
// 读档
input.importBindings(saved);
```

> ⚠️ **`getBinding()` 返回的是 `readonly KeyCode[]`，改键 UI 要遍历它。**
> 没有这个接口的话只能从 `exportBindings()` 的字典里取，
> 而那个是 `Record<string, number[]>`——**键是数字不是 `KeyCode` 语义**，
> 直接拿去显示容易出错。

> ⚠️ **`exportBindings()` 导出的是 `Record<string, number[]>`（数字数组）。**
> 存档用数字是刻意的（体积小、跨版本稳），
> 但显示给玩家之前要映射回键名。

### `AxisBinding`

```typescript
{
  negativeX?: readonly KeyCode[];   // 左
  positiveX?: readonly KeyCode[];   // 右
  negativeY?: readonly KeyCode[];   // 下
  positiveY?: readonly KeyCode[];   // 上
  x?: number;                        // 模拟量（摇杆）
  y?: number;
  axisDeadZone?: number;             // 覆盖全局死区
}
```

> **`negativeY` 是"下"、`positiveY` 是"上"**——
> 屏幕坐标系 Y 轴向下，别写反。
> 写反的表现是"上下颠倒、左右正常"。

### `InputManagerOptions`

| 字段 | 说明 |
|---|---|
| `axisDeadZone` | 全局摇杆死区（**默认非 0**，防漂移） |
| `normalizeAxis` | 是否归一化对角线（不归一化的话斜向移动更快） |
| `enableBuffer` | 是否启用内置缓冲 |

> ⚠️ **`normalizeAxis` 关掉会导致斜向移动比直行快 √2 倍。**
> 这是"按住斜方向跑得更快"这类速度 bug 的常见来源。

## 与 JoystickCore 配合

虚拟摇杆的输出可以直接喂给 InputManager，
这样键盘、手柄、触屏三条路径**共用同一套死区与归一化**，行为完全一致：

```typescript
const o = joystick.evaluate();
input.setAxisAnalog('move', o.dir.x, o.dir.y);
```

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 忘了 `endFrame()` | **按一次攻击连放好几次** | 帧末必须调用 |
| `setAxisAnalog` 写在 `beginFrame` 前 | 手柄摇杆完全没反应 | 顺序：beginFrame → setAxisAnalog |
| 没有死区 | 手柄漂移，角色自己走 | 默认 0.15 死区 |
| 轴输出不归一化 | 斜向移动快 1.41 倍 | 默认已归一化 |
| 测试 W 时没松开 D | 得到 0.707 而非 1 | 是对角线，符合预期 |
| 直接监听按键而非动作名 | 无法改键、无法加手柄 | 一律用动作名 |

## API

### 绑定
| 方法 | 说明 |
|---|---|
| `bindButton(action, keys)` | 绑定按钮动作（可绑多个键） |
| `bindAxis(action, axisBinding)` | 绑定轴（四方向各一组键） |
| `rebind(action, keys, slotIndex?)` | 改键 |
| `exportBindings()` / `importBindings(d)` | 存档 / 读档 |
| `resetBindings(defaults)` | 恢复默认 |

### 帧循环
| 方法 | 说明 |
|---|---|
| `beginFrame()` | 帧开始：重置轴 + 从按键推导 |
| `endFrame()` | 帧结束：**清除 just 状态，必须调用** |

### 注入（引擎侧调用）
| 方法 | 说明 |
|---|---|
| `setKeyDown(code)` / `setKeyUp(code)` | 按键状态 |
| `setAxisAnalog(action, x, y)` | 模拟量（**在 beginFrame 之后**） |
| `clearKeys()` | 清空（切场景/失焦） |

### 查询
| 方法 | 说明 |
|---|---|
| `isPressed(action)` | 是否按住 |
| `wasJustPressed(action)` | 这一帧刚按下 |
| `wasJustReleased(action)` | 这一帧刚松开 |
| `getAxis(action)` | 轴值（返回复用对象） |
| `getAxisTo(action, out)` | 轴值写入 out（零分配） |
| `isKeyDown(code)` | 原始键查询（调试用） |

### 控制
| 成员 | 说明 |
|---|---|
| `setEnabled(v)` / `enabled` | 禁用时会清空按键状态 |
| `pressedCount` | 当前按下的键数（调试） |
| `destroy()` | 清空 |

## Key 常量

包含字母、数字、功能键、方向键、鼠标键、手柄键。
引擎侧负责把引擎的 keyCode 映射到这些值：

```typescript
// Cocos 侧
import { EventKeyboard, KeyCode as CocosKey } from 'cc';
const MAP: Record<number, Key> = {
  [CocosKey.KEY_W]: Key.W,
  [CocosKey.SPACE]: Key.Space,
  // ...
};
node.on(SystemEventType.KEY_DOWN, (e: EventKeyboard) => {
  input.setKeyDown(MAP[e.keyCode] ?? Key.None);
});
```
