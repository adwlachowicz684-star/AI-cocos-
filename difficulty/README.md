# difficulty — 难度档位与动态难度（DDA）

## 它解决什么

两件事：

1. **难度档位**：简单 / 普通 / 困难，各自一套倍率
2. **动态难度（DDA）**：根据玩家表现隐性调节，让菜鸟不至于卡死、高手不至于无聊

## 零业务依赖

倍率是 `Record<string, number>` 的开放字典。
它不认识「敌人伤害」「敌人血量」——这些 key 由业务定义。

## 用法

```typescript
import { DifficultySystem, computePerformance, DEFAULT_TIERS } from './difficulty/DifficultySystem';

const dd = new DifficultySystem({
  tiers: DEFAULT_TIERS,                                  // 可用默认三档
  defaultTier: 'normal',
  dda: { enabled: true, maxAdjust: 0.15, responsiveness: 0.15, windowSize: 30 },
});

dd.setTier('hard');
const dmg = dd.multiplier('enemyDamage');   // 基础 × (1 + DDA 调节)

// 每场战斗结束上报表现
dd.report(performance, duration);
dd.tick(dt);
```

### 表现分

```typescript
const p = computePerformance({
  hurtRatio: 0.1,     // 受伤比例（越低越好）
  deaths: 0,          // 死亡次数
  clearSpeed: 0.8,    // 清关速度（归一化）
  resourceLeft: 0.6,  // 剩余资源
});   // → 0~1
```

## 关键设计

### DDA 幅度必须限制在 ±15%

20% 以上玩家能明显感觉到「怪突然变肉了 / 变脆了」，
那不是「适应」，是「难度在乱跳」，会让玩家不安。

### 为什么要平滑

直接跳到目标值的话：玩家死一次 → 难度立刻降 → 下一场明显变简单 →
玩家察觉 → **成就感崩塌**。

慢速平滑让变化隐藏在「这一局我状态好」的自我解释里。

### 什么时候关掉 DDA

- **简单档**：本来就简单，不需要再放水
- **噩梦档**：玩家明确要求「别管我」，DDA 会冒犯他

用 `tier.allowDDA === false` 配置。

> ⚠️ 判断时**必须用 `=== false`，不能用 `!x`**。
> 这个字段经常不写（表示「用默认 true」），
> 此时它是 `undefined`，而 `!undefined === true`——
> 写成 `if (!tier.allowDDA) return;` 会让所有没配这个字段的档位
> **全部失去 DDA**，且没有任何报错，只是「DDA 好像没生效」。
>
> 这是 opt-out 布尔字段的经典陷阱。

### 采样窗口 30 秒

太短会被单次失误带偏——一次手滑就降难度，不合理。

## 坑

1. **`setDDAEnabled(false)` 后倍率回到基础值**——用于设置项「关闭自适应难度」。
2. **`resetDDA()` 清空调节量**——换章节、换存档时用。
3. **`baseMultiplier(key)` 返回不含 DDA 的值**——用于 UI 显示「原始难度」。

## API 补充

| 成员 | 说明 |
|---|---|
| `currentTierId` / `currentTier` | 当前档位（id / 完整对象） |
| `ddaEnabled` | 自适应难度是否开启 |
| `ddaValue` | 当前 DDA 调节量（**调试用**：一直是 0 说明没生效） |
| `smoothedPerformance` | 平滑后的玩家表现 |
| `allMultipliers()` | **全部**倍率（做难度详情页） |
| `destroy()` | 卸载：清掉 `onAdjust` 回调并复位 DDA（**不动**难度档配置） |

```typescript
// 难度详情页：一次列出全部倍率
for (const [k, v] of Object.entries(diff.allMultipliers())) {
  rows.push(`${k}: ×${v.toFixed(2)}`);
}
```

> ⚠️ **`currencyGain` 的方向存疑，已上报总审裁决（行为未改）。**
> 它在 `PLAYER_FAVORING` 集合里，意味着"玩家表现好 → 金币收益下降"。
> 可能是有意的防刷设计，也可能是照抄 `playerDamage` 时误放。
> 在裁决前请**按现状理解**：想绕开这个方向读 `baseMultiplier('currencyGain')`。

> ⚠️ **判断"DDA 有没有生效"看 `ddaValue`，不要自己算。**
> DDA 是**平滑后**再叠加的（`smoothedPerformance` → `ddaValue`），
> 单看某一局的表现猜不出当前调节量——
> 而"为什么我打得好反而变简单了"这类反馈，全靠这个值来排查。
