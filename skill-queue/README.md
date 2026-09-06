# skill-queue · 技能排队与 CD 补发

```typescript
import { SkillQueue, suggestWindow, defaultRetryable } from './skill-queue/SkillQueue';
import { SkillCaster } from './skill-caster/SkillCaster';
import { InputBuffer } from './input/InputBuffer';
```

- 依赖：**skill-caster**（前置模块，L3 → L2）
- 引擎耦合：**无**
- 测试：**29 项**
- 示例：`npm run example:batch21`

---

## 它解决什么

技能 CD 还剩 0.1 秒，玩家点了。然后——**什么都没发生**。

玩家会觉得"我按了没反应"，于是再按一次、再按一次。
实际上他按了三次，只放出一个，而且手感极差。

这不是玩家的错，是**输入被丢弃**了：

```typescript
// ❌ 朴素接法：输入在这里被吃掉
if (buf.consume('fire')) {
  caster.tryCast('fire', ctx);   // CD 还差 0.08s → 失败，但缓冲已经没了
}
```

`consume()` 一调用就清了缓冲，它不知道技能会不会成功。

实测（CD 1.0s，剩 0.1s 时点击）：

| 接法 | 释放次数 |
|---|---|
| `consume()` → `tryCast()` | **1 次**（输入丢失） |
| `SkillQueue` | **2 次**（自动补发） |

---

## 五分钟上手

```typescript
const caster = new SkillCaster();
caster.learn(fireball);

const queue = new SkillQueue(caster, { window: 0.25 });

// 每帧
function update(dt: number) {
  caster.tick(dt);     // ① 先推进施法
  queue.tick(dt);      // ② 再推进队列（顺序不能反）
}

// 玩家点击
queue.request('fireball', () => ({
  x: player.x, y: player.y,
  facingDeg: player.facing,
  aimX: mouse.x, aimY: mouse.y,
}));
```

**⚠️ ctx 传函数而不是对象。** 技能可能延迟 0.2 秒才放出去，
传快照会让技能在**按下时的位置**放出来。

---

## 与 InputBuffer 配合

正确姿势是 **peek → request → 成功后 consume**，顺序写错就丢输入。
`poll()` 把这三步固化了：

```typescript
queue.poll(buf, { fire: 'fireball', dash: 'dash' },
  () => ({ x: player.x, y: player.y, facingDeg: player.facing }));
```

不用 `poll()` 的话自己写：

```typescript
if (buf.peek('fire') && queue.request('fireball', ctx)) {
  buf.consume('fire');
}
```

---

## API

### 排队与推进

| 方法 | 说明 |
|---|---|
| `request(id, ctx, priority?)` | 请求释放。**ctx 强烈建议传函数** |
| `tick(dt)` | 每帧推进。**必须在 `caster.tick()` 之后**；暂停传 0 |
| `poll(buffer, mapping, ctx, priority?)` | 从输入源拉取（固化 peek→request→consume） |

### 查询与清理

| 方法 | 说明 |
|---|---|
| `pending` | 待释放请求（按优先级排序，带 `waited`） |
| `count` / `has(id)` | 数量 / 是否排队中 |
| `clear(id?)` | 清空（换关卡、死亡、被沉默） |
| `stats` | 统计：`requested / cast / rejected / nearMiss / maxWaited` |
| `describe()` | 调试用一行摘要 |

---

## 失败分类：暂时 vs 永久

这是本模块最核心的判断。分类错了，玩法就毁了。

| 失败原因 | 默认 | 理由 |
|---|---|---|
| `cooldown` | **等** | CD 会自己归零 |
| `busy` | **等** | 正在施法会结束 |
| `out-of-range` / `too-close` | **等** | 玩家可能在移动 |
| `resource` | 丢 | 蓝不会自己涨回来，要给明确提示 |
| `unknown-skill` / `invalid` | 丢 | 永远不会成功 |

改策略：

```typescript
new SkillQueue(caster, {
  retryable: (reason) => reason === 'cooldown',  // 只等 CD
});
```

---

## 窗口怎么配

`suggestWindow(maxLead)` 给 **2 倍余量**：

```typescript
suggestWindow(0.1)  // → 0.2
suggestWindow(0.15) // → 0.3
```

**窗口要覆盖「CD 剩余 + 后摇」**，不只是 CD。

### nearMiss：配短了会明确告诉你

```
CD 0.05s / 后摇 0.15s / 窗口 0.08s：
⚠️ nearMiss ×1 —— fire 等了 0.083s
   意思是「CD 其实早就好了，只是窗口不够等到后摇结束」
```

请求过期那一刻，如果 **CD 已经归零**，说明窗口配短了——
再等一帧就能放出去。

这类配置问题不会报错，只是"偶尔手感发黏"，极难定位，
所以显式抛出来。

> 实现备注：判定里**不要求 `!busy`**。
> CD 已就绪、只差后摇没等完，恰恰是最典型的"窗口没算忙碌时间"。
> busy 是队列自己允许的等待理由，不能让它反过来掩盖窗口不足。

---

## 优先级与容量

```typescript
queue.request('slash', ctx, 0);      // 普攻
queue.request('ultimate', ctx, 10);  // 大招先放
```

- 默认 `capacity: 1` —— 动作游戏通常只想要**最新**的意图
- 默认 `replaceSame: true` —— 连点同一个技能是"再放一次"，不是堆三次
- 队列满时挤掉优先级最低、入队最早的；新请求优先级不够则挤掉自己

---

## 坑

**① `tick()` 顺序反了**

必须在 `caster.tick()` **之后**。反过来的话，
当前施法这一帧不会结束，队列永远等不到机会。

**② 一次 tick 只放一个技能**

即使队列里有 3 个都能放。否则玩家攒的点击会在同一帧全打出去——
伤害瞬间翻倍，动画完全对不上。

**③ 暂停时传 `dt = 0`**

否则暂停期间请求会继续老化，恢复后输入已失效。
用外部时间源（`now` 选项）接 Scheduler 更稳。

**④ 不要用 `caster.current` 读延迟释放的位置**

施法可能已经结束，`current` 是 `null`。
要在 `onCast(ctx)` 回调里捕获。

**⑤ 换关卡必须 `clear()`**

否则上一关攒的意图会在新关卡放出来。

---

## 依赖说明

本模块是 `skill-caster` 的**上层封装**，属于前置依赖（L3 → L2）。
按《依赖规则 v2》的判据：技能排队**必须**依赖施法器才能工作，
所以是必需依赖，不是可选注入。

同时对输入源只要求 `peek` / `consume` 两个方法（结构化类型），
**不 import `InputBuffer`** —— 你可以接自己的输入系统。
