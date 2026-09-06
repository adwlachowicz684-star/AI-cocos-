# skill-caster — 技能释放模块（编排器）

## 它解决什么

一个技能的完整流程：

```
按技能键
  → 检查冷却、资源、距离
  → 显示指示器（这一招打哪里）
  → 蓄力预警（敌人/玩家有反应时间）
  → 播放时间轴（动画、音效）
  → 到判定帧：生成判定框 / 发射弹道
  → 命中：走伤害管线
  → 后摇，回到待机
```

散落在业务代码里就是典型的「换项目全废」。
SkillCaster 把它们**编排**起来，每一步通过接口注入。

## ⚠️ 本文件不 import 任何其他插件

它不认识 Hitbox、Projectile、Indicator、DamagePipeline、SkillPlayer。
全部通过 `SkillCasterDeps` 注入：

```typescript
export interface SkillCasterDeps {
  hitboxes?:    { query(...) };      // 判定
  projectiles?: { spawn(...) };      // 弹道
  damage?:      { apply(...) };      // 伤害
  resources?:   { canAfford, pay };  // 资源（蓝/体力/怒气）
  timeline?:    { play(...) };       // 时间轴
}
```

**这就是「可复用」的落地方式**——编排逻辑是我的，具体能力是你的。
换个游戏，换一批实现传进来，编排逻辑一行不用改。

## 为什么不用继承

继承会把「挥砍」和「火球」绑在一个类层次里。
这里是**组合**：技能 = 配置 + 一组可选能力。
没有指示器就传 `indicator: undefined`，代码自动跳过那一步。

## 用法

```typescript
const caster = new SkillCaster({
  hitboxes: world,
  projectiles: projSys,
  damage: pipeline,
  resources: myResourceBag,
});

caster.learn({
  id: 'slash', cooldown: 0.8,
  windup: 0.12, hitDelay: 0.08, hitWindow: 0.1, recover: 0.2,
  hitShape: { kind: 'sector', radius: 2.5, angleDeg: 100 },
  damage: { raw: 20 },
  mask: LAYER_ENEMY,
});

caster.tick(dt);

const r = caster.tryCast('slash', { x: px, y: py, facingDeg, aimX, aimY, source: player });
if (!r.ok) showHint(r.reason);
```

## ⚠️ origin：判定中心在哪

| 技能 | origin | 说明 |
|---|---|---|
| 扇形挥砍 | `caster`（默认） | 从自身扩散出去 |
| 剑气（矩形） | `caster` + `offsetX` | 形状沿朝向前移半个长度 |
| 冲刺路径 | `caster` + `offsetX` | 同上 |
| **火球落点爆炸** | **`aim`** | 在鼠标位置炸开 |
| 传送 / 放置 | **`aim`** | 以落点为准 |

**默认为什么是 caster**：曾经默认用瞄准点，结果扇形近战全部打空——
扇形以瞄准点（2 米外）为中心，身前的怪反而在扇形背后。

**弹道始终从施法者发射**，不受 origin 影响
（origin='aim' 时 `c.x/c.y` 是落点，从落点往外射就反了）。

## 时序参数

```
windup ── hitDelay ── hitWindow ── recover
  蓄力      判定延迟     判定窗口     后摇
```

- **`hitDelay` 是相对蓄力结束**，不是相对按下
- `hitWindow: 0` = 瞬时判定（更干脆，优先用）
- `hitWindow > 0` = 窗口期内每帧检测新目标（旋风斩、激光）

**`hitDelay` 必须和美术标注的判定帧对齐**，
差 3 帧玩家就觉得「打空了」。

## 失败原因要给玩家看

```typescript
type CastFailReason =
  | 'unknown-skill' | 'cooldown' | 'resource'
  | 'busy' | 'out-of-range' | 'too-close' | 'invalid';
```

失败时给明确提示（「冷却中」「蓝不够」），
而不是默默什么都不发生——后者会让玩家以为游戏卡了。

## 五个坑

**① 判定必须在推进阶段之前**
曾经把判定写在阶段推进之后，结果是：phaseTime 刚够 hitDelay 时，
阶段推进已经把它切成 recover，判定分支不再成立 → **技能永远打不中**。
`hitDelay: 0` 尤其致命：active 时长就是 0，第一帧就错过。

**② 充能恢复要能回到满**
两层充能的技能用完后，冷却走完只恢复 1 层的话，第二次永远是空的。

**③ dt=0 时冷却不推进**
暂停期间不能走冷却。

**④ 窗口期内同一目标只命中一次**
用 `c.hitIds` 去重。

**⑤ hitId 必须唯一**
`${castId}:${targetId}`，多段伤害、AOE 全靠它去重。

## API

### 施放

| 成员 | 说明 |
|---|---|
| `tryCast(id, ctx)` | 尝试施放，返回 `CastResult`（`ok` + `reason`） |
| `cancel(refundCost?)` | 取消当前施放。`refundCost=true` 时退还已扣资源 |
| `current` | 当前正在施放的（`ActiveCast \| null`） |

### 查询（**做技能图标 UI 全靠这几个**）

| 成员 | 说明 |
|---|---|
| `cooldownLeft(id)` | 剩余 CD 秒数 |
| `cooldownRatio(id)` | 剩余 CD **比例** 0..1（画扇形遮罩直接用） |
| `chargesLeft(id)` | 剩余充能层数 |
| `skillIds()` | 已注册的全部技能 id |
| `getDef(id)` | 取技能定义 |

```typescript
// 技能图标的遮罩：0 = 刚放过（全遮），1 = 可用（不遮）
icon.mask.fillRange = caster.cooldownRatio('fireball');
```

> ⚠️ **用 `cooldownRatio` 画遮罩，不要自己算 `cooldownLeft / duration`。**
> 后者在技能有「CD 缩减」buff 时会算错——
> 施放时按当时的 CD 算，之后 buff 到期，比例就对不上了。

### 管理

| 成员 | 说明 |
|---|---|
| `learn(def)` | 学会一个技能（重复 learn 同 id 会覆盖并重置充能） |
| `forget(id)` | **连定义一起删**（源码 `_skills.delete`）。之后 `has(id)` 为 false |
| `resetCooldown(id?)` | 只把 CD 归零，**保留定义**。不传 id = 全部重置（换关卡时用这个） |
| `clear()` | **删掉全部技能定义**，不是"只重置"。切场景后必须重新 `learn()` |
| `destroy()` | 同 `clear()` |

> ⚠️ **`resetCooldown` 只归零 CD，不动充能层数。**
> 源码里它只写 `this._cd`，`this._charges` 没碰。
> 想让充能也回满，要自己 `learn()` 一遍（重新 learn 会重置充能）。

> ⚠️ **本模块没有 `register()` / `unregister()`。**
> 早期文档列过这两个名字，但源码用的是 `learn()` / `forget()`。
>
> | 想做什么 | 用什么 |
> |---|---|
> | 学会一个技能 | `caster.learn(def)` |
> | 遗忘（连定义一起删） | `caster.forget(id)` |
> | **只让 CD 归零，保留定义** | `caster.resetCooldown(id)` |
> | 切场景时清空（**连技能定义一起删**） | `caster.clear()` |
>
> 注意 `forget()` 之后 `has(id)` 返回 false、`getDef(id)` 返回 undefined——
> 它是"真的忘了这个技能"，不是"让它进入冷却"。
>
> `clear()` 同样会删掉**全部技能定义**（源码里 `this._skills.clear()`），
> 不是"只重置冷却"。切场景后要重新 `learn()`，否则所有技能都放不出来——
> 而 `tryCast()` 会返回 `{ ok:false, reason:'unknown-skill' }`，
> 不是报错，很容易误判成"技能 id 写错了"。
> 换关卡要清 CD 但**技能还得留着** → 只能用 `resetCooldown()`。
> 用 `forget()` 会把技能一起删掉，之后 `tryCast` 一律返回
> `unknown-skill`，表现为"换关卡后所有技能都放不出来"。

## 测试

19 项。重点覆盖 hitDelay 基准、充能恢复、origin 两种模式、去重。

文件：`SkillCaster.ts`
