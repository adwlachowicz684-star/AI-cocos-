# indicator — 技能指示器（纯参数计算）

## 它解决什么

玩家按下技能键后、真正生效前，需要看到「这一招会打到哪里」。
这就是指示器：地面上的扇形、圆圈、直线。

## 关键设计：只算参数，不画

输出的是**形状描述**（`Shape` + 位置 + 朝向），由渲染层照着画。

为什么这样切：

1. 3D 俯视角、2D 横版、等距视角的画法完全不同，但**参数一样**
2. 参数可以在 Node 里完整测试（「射程 5 米时目标点应被钳制到 5 米」）
3. 同一份参数同时喂给判定系统 → **所见即所得**

## ⚠️ 最重要的一条原则

**指示器、预警、实际判定必须用同一份 `Shape`。**

一旦三处各写一份参数，就会出现「看着能躲开却被打中」——
这是动作游戏最让玩家愤怒的 bug，而且极难排查（三处数值看起来都对）。

所以 `IndicatorResult.shape` 应该**直接传给** `HitboxWorld.query()`。

## 六种类型

| 类型 | 输出形状 | 说明 |
|---|---|---|
| `circle` | circle | AOE、爆炸 |
| `sector` | sector | 近战挥砍、喷火 |
| `line` | rect | 突进、激光、剑气 |
| `ring` | circle（外圆） | 冲击波、光环 |
| `point` | circle | 传送、放置类 |
| `direction` | capsule | 冲刺、闪现 |

### line / direction 的中心要前移

直线技能从脚下向前延伸，形状中心应在前方半个长度处，
而不是施法者脚下。否则判定框会往后多出一半——
表现为「打不到身前的怪，却能打到身后的」。

用 `centerFor(casterX, casterY, rotationDeg)` 算。

### ring 需要二次过滤

环形无法用单个形状表达（外圆内有、内圆内无）。
返回外圆，调用方用 `inRing()` 过滤：

```typescript
const hits = world.query(shape, x, y, rot, MASK)
  .filter(h => inRing(h.hitbox.x, h.hitbox.y, x, y, inner, outer));
```

## 用法

```typescript
const ind = new SkillIndicator({
  kind: 'circle', radius: 2, range: 8, aimed: true,
  snapToTarget: true, snapRadius: 1.2,
}, {
  targets: myTargetProvider,        // 可选：吸附
  placement: myPlacementValidator,  // 可选：落点合法性
});

const r = ind.compute(px, py, facingDeg, aimX, aimY);
// r.shape / r.x / r.y / r.rotation → 同时喂给判定和渲染
// r.valid → 决定 UI 显示绿色还是红色
```

### 三个配套函数

| 函数 | 说明 |
|---|---|
| `toQueryArgs(r)` | 把结果转成 `hitbox` 的 `query()` 参数（**省得手写四个参数**） |
| `inRing(hx, hy, cx, cy, inner, outer)` | 环形二次过滤（`ring` 指示器必配，见下） |
| `snapAngle(desired, facing, maxDeviation)` | 朝向吸附 |

```typescript
// 判定与预览共用同一份形状——这是本插件的核心承诺
const args = toQueryArgs(ind.compute(px, py, facing, aimX, aimY));
const hits = world.query(args.shape, args.x, args.y, args.rotation, MASK);
```

> **不要自己拼 `world.query(r.shape, r.x, r.y, r.rotation)`。**
> 参数顺序写错不会报错，只是打不中——这四个参数类型相近，编译器拦不住。

## 三个体验设计

**① 超出射程要钳制，不是失败**

玩家把鼠标拖远了不该放不出技能。钳到射程边缘并标记 `clamped`。

**② 目标吸附**

鼠标指在敌人身上时锁定该敌人，而不是自由点。
让「我想打这个」变得确定，而不是靠像素级瞄准。

**③ 辅助瞄准的角度要小**

`snapAngle(desired, facing, maxDeviation)` 的 `maxDeviation` 建议 10~15°。
太大玩家会觉得「我想打左边却打了右边」。

## 一个坑

瞄准点就在脚下时（摇杆没推、鼠标在角色身上），
**保持当前朝向**而不是算出一个随机角度。

## 完整接口

| 成员 | 说明 |
|---|---|
| `compute(px, py, facingDeg, aimX, aimY)` | 计算指示器参数，返回 `IndicatorResult` |
| `configure(cfg)` | 运行期改配置（**换技能**时用） |
| `config()` | 读当前配置（只读） |

> ⚠️ **`compute()` 是纯函数式的**——
> 它不持有状态，每次都按传入的参数重算。
> 这意味着**每帧调用是安全的**，
> 也意味着你必须在每帧把最新的摇杆/鼠标位置传进去。
>
> 缓存结果的做法在这里行不通：玩家移动瞄准点时，
> 旧结果里的 `clamped` / `snappedTo` 会立刻过期。

### `IndicatorResult`（`compute()` 的返回）

```typescript
{
  shape: IndicatorShape;   // 形状（喂给 hitbox.query()）
  x: number; y: number;    // 落点
  rotation: number;        // 朝向（弧度或度，见源码）
  aimX: number; aimY: number;
  clamped: boolean;        // 是否因超出射程被钳制
  snappedTo?: string;      // 吸附到了哪个目标
  valid: boolean;          // 落点是否合法
}
```

> ⚠️ **`clamped` 为 true 时 `x`/`y` 已经被钳到射程边缘。**
> 想做"超出射程就禁用技能"的话判 `clamped`；
> 想做"钳到边缘照常释放"的话忽略它——
> 两种设计都合理，但别在 `clamped` 时又拒绝释放，
> 那是把两种设计混在了一起，玩家会觉得"明明在范围内却不让我放"。

> ⚠️ **`valid` 需要注入 `placement` 才有意义。**
> 不传 `placement` 的话它恒为 `true`——
> 表现为"技能能放在墙上"，而你会以为校验生效了。

### 类型

**`IndicatorKind`**：

```
'circle' | 'sector' | 'line' | 'ring' | 'point' | 'direction'
```

**`IndicatorShape`**：

```typescript
{
  kind: 'circle' | 'rect' | 'sector' | 'capsule';
  radius?: number;  halfW?: number;  halfH?: number;
  angleDeg?: number;  height?: number;
  offsetX?: number;  offsetY?: number;
}
```

> ⚠️ **`IndicatorShape` 不等于 `IndicatorKind`**，两者取值不同。
> `kind: 'line'` 的指示器算出来的 `shape.kind` 是 `'rect'` 或 `'capsule'`——
> 前者是"玩家看到什么"，后者是"判定用什么形状"。
> 直接拿 `cfg.kind` 去调 `hitbox.query()` 会类型不匹配。

> **这个结构刻意与 `hitbox` 的 `Shape` 字段兼容**，
> 但**没有 import 它**——分层规则禁止同层横向依赖
> （indicator 和 hitbox 都是第 1 层）。
> 在适配层做一次转换即可，成本很低。

**三个可注入的接口**：

| 接口 | 方法 | 用途 |
|---|---|---|
| `ITargetProvider` | `findNearest(x, y, r)` | 目标吸附 |
| `IPlacementValidator` | `isValid(x, y, shape)` | 落点合法性 |
| `ISnapTarget` | `{ x, y, radius?, id? }` | 吸附目标的形状 |

> ⚠️ **三个都是可选的，不注入也能用。**
> 但 `valid` 恒为 `true`、`snappedTo` 恒为 `undefined`——
> 见上面两条。

**`IndicatorConfig`**：

| 字段 | 说明 |
|---|---|
| `kind` | 类型（**必填**） |
| `range` | 最大施法距离（**必填**）。超出会**钳制**不是失败 |
| `aimed` | 是否选点（`true` = 以目标点为中心，`false` = 以施法者为中心） |
| `radius` | circle / sector / ring 的半径 |
| `angleDeg` | sector 的张角（**度**） |
| `length` / `width` | line 的长度 / 宽度（米） |
| `innerRadius` | ring 的内半径 |
| `pointRadius` | point 的作用半径（`0` = 严格一个点） |
| `minRange` | 最小施法距离（**防止贴脸放 AOE 炸到自己**） |
| `snapToTarget` / `snapRadius` | 目标吸附开关 / 半径 |

> ⚠️ **`range` 和 `aimed` 必填，`radius` 等按 `kind` 选填。**
> 但**填错了不报错**——比如 `kind: 'line'` 却只填了 `radius`，
> 算出来的 length 是默认值，表现为"激光很短"。

> ⚠️ **`aimed` 决定中心点是谁。**
> `false` 时（旋风斩、光环这类）指示器以施法者为中心，
> 传进去的 `aimX`/`aimY` 只用于决定**朝向**。
> 把它设成 false 却按"以目标点为中心"来渲染，
> 指示器会画在脚下而判定却在瞄准点——
> 表现为"看起来打中了实际没伤害"。

> **`minRange` 是防自伤的。**
> 贴脸放火球术时，如果落点就在脚下，
> 玩家会把自己也炸了。设了 `minRange` 会把落点推到最小距离外。

## 测试

13 项。重点覆盖射程钳制、吸附、line 中心前移、角度环绕。

文件：`SkillIndicator.ts`
