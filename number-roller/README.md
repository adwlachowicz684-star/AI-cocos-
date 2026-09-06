# number-roller — 数字滚动（核心逻辑）

## 为什么拆核心与渲染

与 JoystickMover 同样思路：
- **核心（本文件）**：从当前显示值滚到目标值，纯数字逻辑 → 可完整单测
- **渲染层**：Cocos 组件，每帧读 `display` 写到 Label → 约 30 行

## 三个关键问题

**① 连续设置值时从哪开始滚**
玩家连续捡金币，100 → 150 → 220。从"上一个目标值"开始会跳变；
正确做法是**从当前显示值继续滚**（内部 `_from = _current`）。

**② 滚动速度**
固定速度太慢，固定时长则小变化拖沓。做法：**时长随差值缩放，设上下限**。

**③ 大数字**
1234567 显示成 "1,234,567" 还是 "1.2M"？两种都提供。

## 用法

```typescript
import { NumberRollerCore } from './number-roller/NumberRollerCore';

const roller = new NumberRollerCore({ duration: { min: 0.3, max: 1.2 } });

roller.set(100);
roller.set(250);              // 从当前显示值继续滚，不跳变

// 每帧（Cocos 组件里）
roller.update(dt);
label.string = roller.formatted;

roller.snapTo(999);           // 立即到位
roller.set(500, { overshoot: 1.15 });  // 暴击时冲过头再回落
roller.abbreviated;           // '1.2K' / '3.4M'
```

**Cocos 渲染层示例**（约 30 行）：

```typescript
@ccclass('NumberRoller')
export class NumberRoller extends Component {
  @property(Label) label: Label = null!;
  private _core = new NumberRollerCore({ separator: ',' });

  setTo(v: number, immediate = false) { this._core.set(v, { immediate }); }
  update(dt: number) {
    if (!this._core.isRolling) return;
    this._core.update(dt);
    this.label.string = this._core.formatted;
  }
}
```

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 用"上一个目标值"作为起点 | 连续拾取时数字跳变 | 已用当前显示值 |
| 固定时长 | 大数字滚太久 / 小变化拖沓 | 时长随差值缩放 |
| 负数千分位写错 | 显示 "-,1234,567" | 已处理符号 |
| 每帧都写 Label | 浪费（Label 赋值会触发重排） | `isRolling` 为 false 时不写 |

## API

| 成员 | 说明 |
|---|---|
| `set(v, {overshoot?, immediate?})` | 设置目标 |
| `snapTo(v)` | 立即到位 |
| `update(dt)` | 每帧推进 |
| `display` / `displayInt` | 当前显示值 |
| `formatted` | 格式化字符串（千分位/符号/小数） |
| `abbreviated` | 缩写（1.2K / 3.4M / 2.5B） |
| `isRolling` | 是否滚动中（**用于跳过 Label 赋值**） |
| `reset()` | 归零并停止滚动（不触发回调） |
| `destroy()` | 等同 `reset()`（`IDisposable` 用） |

> **复用滚动器时先 `reset()`。**
> 比如从商店返回，数值要重新滚——
> 不 reset 的话 `_from` 还是上一次的值，会看到数字先跳回旧值再滚。

## 配置

| 选项 | 默认 | 说明 |
|---|---|---|
| `duration` | `{min:0.25, max:1.0}` | 时长范围 |
| `bigDelta` | 10000 | 多大差值算"最大时长" |
| `separator` | `''` | 千分位分隔符 |
| `showSign` | false | 显示正号 |
| `decimals` | 0 | 小数位数 |

---

## `target`

> ⚠️ **`target` 和 `displayInt` 不是一个东西。**
> 滚动过程中 `target` 是最终要到的数，
> `displayInt` 才是此刻该显示的数。
> 拿 `target` 去渲染的话，数字会"一步到位"，滚动动画完全看不见。
>
> 判断"滚完了没有"用 `target === displayInt`（或模块提供的 done 查询）。
