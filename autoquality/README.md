# autoquality · 帧率监测与自动画质降级

```typescript
import { AutoQuality, FpsMeter } from './autoquality/AutoQuality';
```

- 依赖：**无**（连 `_core` 都不依赖）
- 引擎耦合：**无**（只输出档位，执行由回调完成）
- 测试：37 项

---

## 它解决什么

朴素写法 `if (fps < 50) lower()` 的三个灾难：

**1. 均值被单帧卡顿污染**
一次 500ms 的 GC 停顿，把 60 帧均值从 60 拉到 40。
于是系统认为"性能不够"开始降级——而实际上只有那一帧有问题。
**应该用中位数**，它对离群值免疫。

**2. 边界横跳**
帧率在 55 附近抖动时反复降/升，每次切换都要重建渲染资源，
玩家看到的是**画面一直在闪**。这比稳定 50 帧糟糕得多。
**需要迟滞**：降级阈值要显著低于升级阈值。

**3. 切换后立即评估**
刚降完档那几帧可能正在编译着色器，帧率反而更低。
立刻再评估会连降三级到底。**需要冷却期**。

---

## 用法

```typescript
const aq = new AutoQuality({
  tiers: AutoQuality.defaultTiers(),
  downgradeFps: 50,
  upgradeFps: 58,        // ⚠️ 必须显著高于降级阈值
  windowSize: 60,
  cooldownMs: 2000,
  consecutiveSamples: 3,
});

// 主循环（⚠️ dtMs 用渲染帧时间，不是逻辑帧时间）
aq.update(renderDtMs, nowMs);

// 应用档位参数
applyQuality(aq.settings);   // { shadow, antialias, renderScale, ... }
```

**⚠️ `dtMs` 必须是渲染帧时间。** 逻辑帧因固定步长而恒定 16.7ms，
用它的话采样出来永远 60fps，自动降级永远不会触发。

---

## 三种帧率读数

| 读数 | 含义 | 用途 |
|---|---|---|
| `medianFps` | 中位数 | **决策用它**，抗离群 |
| `averageFps` | 平均 | 仅诊断参考 |
| `lowFps1Percent` | 最差 1% 帧 | 玩家抱怨"卡"通常是因为它 |

平均 60 帧但每秒掉一次到 15 帧，体感依然很差——
只看中位数会得出"性能没问题"的错误结论。

---

## 升级比降级更保守

升级需要 `consecutiveSamples × 2` 次连续达标。
降错了玩家只损失一点画面；升错了会掉帧，
而掉帧直接影响操作手感——**代价不对等**。

---

## 手动设置会锁定自动调节

```typescript
aq.setManualLevel(2);   // 锁定
aq.unlock();            // 恢复（从当前档开始，不跳回最高）
```

⚠️ 不锁定的话：玩家明确选了"高画质"，系统 2 秒后因为掉帧降回去，
他会觉得"我的设置没生效"，反复去调，然后生气。
设置界面必须说明"手动设置将关闭自动调节"。

---

## `fpsValid`：冷却期内的读数不可信

```typescript
console.log(aq.state.fpsValid ? `${st.fps}fps` : '测量中');
```

切换档位会清空采样窗口，缓冲区里残留的是**上一档位**的帧时间。
直接读会得出"已降到低画质，但帧率显示 60"这种自相矛盾的输出。

---

## 配置校验

```typescript
new AutoQuality({ downgradeFps: 55, upgradeFps: 55, tiers });
// Error: 升级阈值 55 必须高于降级阈值 55，否则会在边界反复横跳
```

这是配置错误，应该在构造时就抛，而不是等玩家发现画面在闪。

## API

| 成员 | 说明 |
|---|---|
| `update(dt, now)` | 每帧推进 |
| `level` / `tier` / `settings` | 当前档位 |
| `medianFps` / `averageFps` / `lowFps1Percent` | 三种读数 |
| `setManualLevel(n)` / `unlock()` / `locked` | 手动控制 |
| `history` | 切换记录（含原因） |
| `describe()` | 诊断报告（给玩家/客服看） |

## 坑

| 坑 | 后果 |
|---|---|
| 用均值决策 | 单帧卡顿触发不必要的降级 |
| 两个阈值相同 | 边界横跳，画面一直在闪 |
| 无冷却期 | 连降三级到底 |
| `dtMs` 用逻辑帧时间 | 自动降级永远不触发 |
| 手动设置后不锁定 | 玩家觉得设置没生效 |
| 初始档位从最低开始 | 旗舰机看到很差画面，且**永远升不上去**（低档下帧率永远过剩） |
| 冷却期读 `medianFps` | 显示"低画质 + 60fps"的自相矛盾输出 |

## `FpsMeter`

不想接自动降级，只想在调试面板显示帧率时用它：

```typescript
const m = new FpsMeter(60);
m.tick(renderDtMs);
m.median;  m.average;  m.lowFps1Percent;  m.settled;
```

---

## `FpsMeter.reset()`

清空采样窗口（**重新统计**）。

> **切场景后建议调一次。**
> 加载期的帧率不代表游戏帧率——
> 不重置的话，加载卡顿会被算进平均，
> 表现为"一进游戏画质就被降到最低"。
