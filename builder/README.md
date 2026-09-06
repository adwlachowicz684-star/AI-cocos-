# builder · 建造系统

```typescript
import { Builder, rotateCell, blueprintCells } from './builder/Builder';
```

- 依赖：`_core/math`
- 引擎耦合：**无**（钱包与地形通过接口注入）
- 测试：60 项

---

## 它解决什么

**1. 原子性** — 先扣资源 → 放置失败 = 玩家的木材凭空消失。
这是建造系统**头号事故**，玩家会认为你在偷东西。

**2. 预览** — 要"看到"不能建的原因，不只是红色。

**3. 旋转** — 2×3 转 90° 变成 3×2，占位算错 = 建筑重叠。

**4. 拆除返还** — 100% 返还的话玩家可以零成本试错，
建造决策就失去意义。但**取消未完成的建造必须 100% 返还**。

**5. 依赖与上限** — 散落在代码里的话，配表的人改不动。

---

## 用法

```typescript
const b = new Builder({
  blueprints: [house, wall, wall2],
  wallet: myWallet,                       // 实现 ResourceWallet
  terrain: { isBuildable: (c) => !isWater(c) },   // 可选
  bounds: { w: 20, h: 20 },               // 可选
});

// 预览（纯查询，不改动状态）
const pre = b.preview('house', { x: 5, y: 5 }, 90);
if (!pre.ok) showReason(pre.detail);      // "与 2 个已有建筑重叠"
drawGhost(pre.cells, pre.ok);

// 放置
const r = b.place('house', { x: 5, y: 5 }, 90);
```

---

## ⚠️ 放置顺序：验证 → 占位 → 扣资源

反过来（先扣资源）的话，任何一步失败都会吞掉玩家的东西。
占位放在扣资源前面，是因为占位不会失败——
`preview` 已经验证过了，这里再验一次只是防并发。

---

## ⚠️ 拆除返还的两条规则

| 情况 | 返还 | 理由 |
|---|---|---|
| **未完成**的建筑取消 | **100%** | 玩家改主意了，不是"拆掉用过的东西"。扣钱的话他就不敢再试 |
| 已完成的建筑拆除 | `refundRate`（默认 50%） | 100% 返还 = 零成本试错，建造决策失去意义 |

---

## ⚠️ 升级必须原地替换，不是"拆了重建"

```typescript
b.upgrade(id);   // 保留 id 与位置
```

拆了再建的三个问题：
1. 位置可能被别的建筑抢走（拆的瞬间格子空了）
2. 返还 50% 再付 100%，玩家净亏 50%
3. **id 变了，所有引用它的东西全断**

升级时会先清旧占位再算新占位，
所以"自身占的格子"不算冲突（可以升到更大的建筑）。

---

## 蓝图配置

```typescript
const house: Blueprint = {
  id: 'house',
  name: '民居',
  cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],   // 2×1，相对锚点
  cost: { wood: 50, stone: 20 },
  buildTimeMs: 3000,          // 0 = 瞬间完成
  requires: ['lumber_camp'],  // 前置建筑
  maxCount: 5,                // ⚠️ 不设的话玩家可以铺满全图
  removable: true,
  refundRate: 0.5,
  upgradeTo: 'house_2',
  data: { /* 透传 */ },
};
```

## API

| 方法 | 说明 |
|---|---|
| `preview(id, anchor, rot)` | 纯查询，返回错误原因 + 占位 + 冲突对象 |
| `place(id, anchor, rot)` | 放置（原子） |
| `remove(id)` | 拆除并返还 |
| `upgrade(id)` | 原地替换 |
| `complete(id)` | 标记建造完成 |
| `buildingAt(cell)` | 查询某格 |

### 查询

| 成员 | 说明 |
|---|---|
| `getBlueprint(id)` / `allBlueprints()` | 蓝图定义 |
| `getBuilding(id)` / `allBuildings()` | 已放置的建筑 |
| `countOf(blueprintId)` | 某蓝图已建了几个（**限建造上限**用） |
| `buildingCount` | 建筑总数 |

### 资源

`spend(costs)` / `gain(gains)` —— 默认是内部账本。
`spend` 返回 `boolean`（**资源不够返回 false，不抛错**）。

```typescript
if (!builder.spend({ wood: 50 })) {
  showToast('木材不足');   // 别用 try/catch，它不抛
}
```

> ⚠️ **`spend` 的返回值必须判。** 它不抛异常，
> 不判的话资源不够时照样往下走——建筑放下了但没扣资源。

### 时间与清理

| 成员 | 说明 |
|---|---|
| `update(now)` | 推进建造进度。**`now` 是外部传入的时间戳** |
| `now` | 当前时间 |
| `clear()` | 清空全部建筑 |

> **时间由外部注入，不用 `Date.now()`。**
> 这样离线建造进度可以一次算完，也让测试能精确控制时间。
| `validate()` | 检查 `requires` / `upgradeTo` 的引用 |

## 坑

| 坑 | 后果 |
|---|---|
| 先扣资源再验证 | 失败时资源消失，玩家认为被偷 |
| 旋转只换贴图不换占位 | 建筑重叠 |
| 未完成建造按 `refundRate` 返还 | 玩家不敢尝试建造 |
| 升级用"拆+建"实现 | id 断了、位置被抢、玩家净亏 |
| `requires` 拼错 | 表现为"这个建筑永远建不了"，玩家以为自己没满足条件 → 用 `validate()` |
| 不设 `maxCount` | 铺满全图，既破坏平衡也拖垮性能 |

---

## 返回值结构

### `PlacedBuilding`

```typescript
interface PlacedBuilding {
  id:          string;
  blueprintId: string;
  anchor:      Cell;                  // 锚点格
  rotation:    Direction;             // 旋转（影响占位）
  cells:       readonly Cell[];       // **实际占用的所有格**
  placedAt:    number;
  completedAt: number | null;         // null = 还在建造中
  completed:   boolean;
}
```

> ⚠️ **`cells` 是旋转后算出来的，别用 `anchor` + 蓝图尺寸自己推。**
> L 形、T 形建筑旋转后的占位不是矩形，
> 自己推会让"看起来能放"的位置实际重叠。

> **`completedAt` 为 `null` 表示还在建造**，别判 `completed`——
> 两者冗余但语义不同：前者是时间戳，后者是布尔。
> 做"建造进度"读 `completedAt`。