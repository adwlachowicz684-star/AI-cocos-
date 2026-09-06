# telegraph — 攻击预警

## 它解决什么

玩家被 Boss 一击秒杀时，只有两种感受：

1. **「我没看到」** → 需要预警
2. **「我看到了但躲不掉」** → 预警时长不合理

预警（Telegraph）就是地面上的红圈、Boss 身上的蓄力光效。
它把「不可预知的死亡」变成「我该躲但没躲好」。

## 生命周期

```
windup（蓄力）→ active（判定生效）→ recover（后摇）→ done
    ↑ 预警显示        ↑ 只有这一帧真正判定
```

## ⚠️ 三条铁律

### ① 视觉与判定必须用同一份形状

`Telegraph.shape` 直接喂给 `HitboxWorld.query()`。
各写一份参数就会出现「看着躲开了却被打中」。

### ② 判定位置在 active 开始时锁定

蓄力期间预警圈可以跟着 Boss 走（有追踪感），
但**一旦进入 active，位置必须冻结**。

否则玩家躲开了，判定圈却跟着他移动 → 必中且无法规避。

### ③ 时长要能被暂停/减速

所有计时走注入的 `dt`，不要用 `setTimeout`。
否则暂停时 Boss 的蓄力仍在推进，取消暂停瞬间就被打中。

## 时长参考值

| 场景 | 蓄力时长 |
|---|---|
| 小怪普通攻击 | 0.25 ~ 0.4s |
| 精英怪重击 | 0.5 ~ 0.8s |
| Boss 大招 | 1.0 ~ 1.5s |

短于 0.2s 玩家基本反应不过来；长于 2s 会显得拖沓。

**判定窗口（active）通常很短**（0.1~0.2s）。
窗口越长，玩家越容易「没躲开但也没被打中」——手感发虚。瞬时判定最干脆。

## 用法

```typescript
const tg = new TelegraphSystem();

tg.spawn({
  shape: circle(2.5), x: bossX, y: bossY,
  windup: 0.8, active: 0.15, recover: 0.4,
  followCaster: true, caster: boss,
  mask: LAYER_PLAYER,
  onActivate: (t) => {
    const hits = world.query(t.shape, t.x, t.y, t.rotation, t.mask);
    for (const h of hits) pipeline.apply({ raw: 40, hitId: `${t.id}` }, h.hitbox.data);
  },
});

tg.tick(dt);   // dt 必须来自统一时间源，暂停时为 0
```

## 渲染层需要的两个量

```typescript
telegraphProgress(t);   // 0..1，画填充动画（空心→实心）
isDangerous(t);         // 蓄力过 70%，闪红 / 播警报音
```

**进度必须由逻辑层给**——渲染层自己算会和判定不同步。

## 一个坑：低帧率会跳过整个判定窗口

20fps 时 dt=0.05，一帧可能跨过 `active: 0.02` 的极短窗口。
用 `if` 推进阶段就会直接落到 recover，**技能永远打不到人**。

本库用 `while` 循环推进，并用 guard 防死循环。

## 与 SkillPlayer 的分工

| | 负责 |
|---|---|
| `SkillPlayer` | 播放技能时间轴（动画、音效、多段判定） |
| `Telegraph` | **单个**攻击的预警与判定窗口 |

两者可组合：时间轴的某个事件里 spawn 一个 Telegraph。

## API

### `TelegraphSystem`

| 成员 | 说明 |
|---|---|
| `spawn(config)` | 创建一个预警，返回 `Telegraph` |
| `tick(dt)` | 推进（**dt 必须来自统一时间源，暂停时传 0**） |
| `cancel(id)` | 取消单个 |
| `cancelAll()` | 取消全部 |
| `clear()` | 清空（**换关卡时必须调**，见下） |
| `all()` | 取全部（只读） |
| `count` | 当前活跃数量（**调试用**：应该会回落，一直涨说明泄漏） |

> ⚠️ **换关卡必须 `clear()` 或 `cancelAll()`。**
>
> `onActivate` 里挂着 `spawnDamage` 这类回调，不取消的话
> 新关卡照样会执行——表现为「刚进新图就被不知哪来的伤害打了一下」。
>
> `cancel()` 要传 id，得自己维护列表；**`cancelAll()` 一行就够**。

### 自由函数

| 函数 | 说明 |
|---|---|
| `telegraphProgress(t)` | 0..1 进度，**渲染层画填充动画用这个**（见上） |
| `isDangerous(t)` | 是否已进入危险期（蓄力过 70%） |
| `phaseDuration(t)` | 当前阶段的总时长（`windup`/`active`/`recover` 各自的秒数） |

| `destroy()` | 释放（含清空所有预警） |

> ⚠️ **换关卡时必须在 `destroy()` 和 `cancelAll()` 里选一个。**
> 什么都不调的话，预警身上挂的 `onComplete` 回调会在新关卡里执行——
> 表现为"刚进新图就被不知哪来的伤害打了一下"。
> 详见坑表格里"换关卡"那条。

## 测试

9 项。重点覆盖位置冻结铁律、低帧率不跳窗、dt=0 不推进。

文件：`Telegraph.ts`
