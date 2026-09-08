# feedback · 打击反馈（顿帧 / 震屏 / 闪白 / 飘字）

> ⚠️ **写完代码必须同时完成三件事**：① 测试 ② README ③ 登记进 `_kitmeta.json`
> 本插件曾因测试文件被覆盖而变成孤儿，第五次同类事故。

---

## 它解决什么

"打中了"这件事需要被**感觉到**而不只是看到。
四个要素：顿帧（hitstop）、震屏、闪白、飘字。

手写的做法是在命中处直接调 `camera.shake()`、`timeScale = 0`，
然后连打时十个顿帧叠成一秒卡顿。

## 预设数值的来历

不是拍脑袋定的，是动作游戏里被反复验证过的区间：

| 要素 | 轻击 | 重击 | 暴击 | 说明 |
|---|---|---|---|---|
| 顿帧 | 60ms | 110ms | 140ms | 低于 50ms 察觉不到；高于 150ms 会被认为是掉帧 |
| 震屏 | 0.15 | 0.4 | 0.6 | 超过 0.8 就看不清画面 |
| 闪白 | 30ms | 50ms | 80ms | 太长像闪光弹，太短看不见 |
| timeScale | 0.1 | 0.05 | 0.03 | **不是 0** |

## 用法

```typescript
const fb = new HitFeedback();

// 命中时
fb.play('crit', damage / 100, { damage, isCrit: true });

// 每帧（用真实 dt！）
function update(realDt: number) {
  const o = fb.update(realDt);
  timeScale = o.timeScale;
  camera.shake(o.shake);
  flash.alpha = o.flash;

  for (const p of fb.takePopupPayloads()) {
    spawnDamageText(p);      // 只在刚跨过 popup 延迟的那一帧触发
  }
}
```

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **必须用真实 dt 计时** | 用缩放后的 dt，顿帧会自我延长：scale=0.05 时 60ms 顿帧需要 1200ms 墙钟走完。这是"手感糊掉"最常见的原因 |
| **timeScale 不是 0** | 完全冻结会让粒子和 UI 都僵住，看起来像卡死 |
| **顿帧默认不叠加** | 10 连击不该变成 10 倍卡顿。但震屏仍累积（连打要有爽感） |
| **震屏取 max 不是 sum** | 两个 0.6 叠加成 1.2 会让画面糊掉 |
| **payload 只在触发帧可取** | 否则会重复生成飘字 |
| **自定义 profile 未覆盖的层为 0** | 不是沿用预设——写了 `{hitstop}` 就只有顿帧 |
| **`update` 的 dt 走 `safeDt`** | `Infinity` 的 dt 会把所有实例的 elapsed 推到 Infinity，打击反馈**同一帧集体消失**。切后台再回来、断点续跑都会产出这种 dt |
| **`popup` 是强度不是进度** | 它在整个 duration 内恒定（= `intensity × scale`），不是从 1 递减到 0。按进度做淡出会看到"飘字永不淡出、结束瞬间突降为 0" |
| **`maxIntensity` 非有限值回落 1.5** | NaN 会让各层强度变 NaN，宿主拿去做位移算出 NaN 坐标：整个表现层静默失效 |

## 完整接口

| 成员 | 说明 |
|---|---|
| `play(kind, intensity, vars?)` | 触发一次反馈 |
| `update(realDt)` | 推进（**必须用真实 dt**），返回 `FeedbackOutput` |
| `output()` | 读当前输出（**不推进**） |
| `timeScale()` / `shake()` / `flash()` | 单项读数 |
| `lastKnockback()` | 上一次的击退量 |
| `activeCount()` | 当前活跃的实例数 |
| `takePopupPayloads()` | 取出本帧的飘字数据（**取走即清空**） |
| `clear()` | 全部清空（**游戏内**语义：暂停、切场景后还要继续用） |
| `destroy()` | 卸载：断开 payload 引用并 `clear()` |

> ⚠️ **`takePopupPayloads()` 是"取走"，不是"读取"。**
> 调一次后队列就空了——
> 同一帧调两次的话第二次拿到空数组，
> 表现为"飘字时有时无"（取决于调用顺序）。
> 这也是坑表格里"payload 只在触发帧可取"的实现方式。

> ⚠️ **`output()` 与 `update()` 的区别：只有后者推进时间。**
> 每帧只能调一次 `update()`。
> 想在多个系统里读同一个输出（相机、UI、音频）就调 `output()`——
> 调多次 `update()` 会让反馈跑得比预期快。

> ⚠️ **`clear()` 不会恢复 `timeScale`。**
> 它只是清空实例，下一次 `update()` 才会算回 1.0。
> 在 `clear()` 之后立刻读 `timeScale` 还是顿帧中的值——
> 表现为"暂停菜单里游戏还是很慢"。

> **`activeCount()` 是排查"打击感糊掉"的第一手工具。**
> 它持续增长说明实例没被回收（通常是 `update` 没调，或传了缩放后的 dt）。

### `FeedbackOutput`（`update()` 的返回）

```typescript
{
  timeScale: number;   // 本帧的时间缩放
  shake: number;       // 震屏强度 0~1
  flash: number;       // 闪白强度 0~1
  popup: number;       // 飘字**强度** 0~1（不是进度，见下）
  inHitstop: boolean;
}
```

> ⚠️ **`popup` 是强度，不是进度。**
> 实测 `play('heavy', 0.5)` 之后连续 40 帧采样，它恒为 `0.50`，
> 到 duration 结束那一帧才直接掉到 0。
> 需要"进度"的宿主请自己按 duration 算：`1 - elapsed / duration`。
>
> 为什么不直接把它改成真进度：那是 breaking change——
> 已按强度接的宿主会突然看到淡出。
> 这里选择把文档改成真实的语义（实现与文档冲突时，二者至少要对齐一个）。

> ⚠️ **`shake` 取的是多个实例的 max，不是 sum**（见坑表格）。
> 想自己叠加的话拿 `shake` 去乘，别改这个模块。

### 类型

```typescript
type HitKind =
  | 'light'    // 轻击
  | 'heavy'    // 重击
  | 'crit'     // 暴击
  | 'block'    // 被格挡
  | 'parry'    // 弹反
  | 'kill'     // 击杀
  | 'hurt'     // 自己受伤
  | 'custom';
```

> 注意**没有 `'hit'`**——轻击是 `'light'`。
> 写 `'hit'` 不报错（会走 custom 或未定义分支），
> 表现为"打击感完全没生效"。

**`FeedbackLayer`**（四层里每一层的参数）：

```typescript
{
  delay?: number;     // 延迟多久开始（真实秒）
  duration: number;   // 持续多久（真实秒，**必填**）
  scale?: number;     // 强度系数（乘以传入的 intensity）
}
```

> ⚠️ **`duration` 是这一层唯一的必填项。**
> 省略 `scale` 时按 1.0 处理，省略 `delay` 时立即开始。
> 只写 `{ duration }` 是合法的最小配置。

**`HitProfile`**：

```typescript
{
  hitstop?: FeedbackLayer;   // 顿帧
  shake?:   FeedbackLayer;   // 震屏
  flash?:   FeedbackLayer;   // 闪白
  popup?:   FeedbackLayer;   // 飘字
  timeScale?: number;        // 顿帧期间的时间缩放（0 = 完全冻结）
  knockback?: number;        // 击退强度
}
```

> ⚠️ **`timeScale` 别设成 0。**
> 完全冻结会让粒子和 UI 一起僵住，看起来像卡死
> （正是坑表格里那条）。建议不低于 `0.02`。

> ⚠️ **自定义 profile 未覆盖的层为 0，不是沿用预设。**
> 写了 `{ hitstop }` 就**只有**顿帧，震屏闪白全无——
> 这是坑表格里那条，也是最常见的"自定义后打击感消失"的原因。

**`DEFAULT_PROFILES`**（导出，可读取参考）：

| kind | 顿帧 | 震屏 | 闪白 | timeScale | 击退 |
|---|---|---|---|---|---|
| `light` | 0.06s | 0.15 | 0.3 | 0.1 | 0.3 |
| `heavy` | 0.11s | 0.4 | 0.6 | 0.05 | 1.0 |
| `crit` | 0.14s | — | — | — | — |

> 完整数值见源码 `DEFAULT_PROFILES`。
> 这些数字是调出来的，不是算出来的——改之前先试默认的。

**`HitFeedbackOptions`**：

| 字段 | 说明 |
|---|---|
| `profiles` | 自定义 profile（**按 kind 覆盖，未列的用默认**） |
| `maxIntensity` | 强度上限（夹取） |
| `maxInstances` | 同时存在的实例上限 |
| `stackHitstop` | 顿帧是否叠加（**默认 false**，见设计章节） |

## 设计：为什么不合并顿帧

连打时每次命中都新增一个顿帧实例的话，
10 连击 = 10 倍卡顿，玩家会以为游戏卡了。

默认行为：已有实例在顿帧期间时，新实例**不贡献 timeScale**，
但仍贡献震屏和闪白。这样连打有累积爽感，但不会卡住。

需要叠加时传 `{ stackHitstop: true }`。

## 测试

**31 项**，覆盖顿帧时长（用帧数反推毫秒，确认不自我延长）、
连打不叠加、震屏取 max、强度夹取、自定义 profile、popup 触发窗口。
