# grid — 二维网格 / 建造放置 / 六边形

三个需求，一套"格子"抽象。

## ① Grid\<T\> 通用网格

```typescript
const g = new Grid<string>(10, 8);
g.set(3, 4, '树');
g.get(99, 99);            // undefined（**不崩**）
g.neighbors4(3, 4);       // 上下左右
g.neighbors8(3, 4);       // 八方向
g.fill(0, 0, 5, 5, '水');
g.find((v) => v === '树');
for (const cell of g) { } // 可迭代
Grid.fromRows(g.toRows());
```

> **越界返回 undefined 而不是抛错**：网格查询常发生在"扫描周围一圈"，
> 边缘格子必然越界。抛错会逼你每次先 `inBounds`。
> 需要严格检查时用 `setStrict()`。

## ② GridPlacement 建造放置

```typescript
const place = new GridPlacement(20, 20);
place.define({ id: 'house', w: 2, h: 2, rotatable: true });

place.canPlace('house', 5, 5);
const id = place.place('house', 5, 5);   // 占 4 格
place.at(6, 6);                          // 同一个 id

place.move(id, 10, 10);    // 失败时自动回滚（不会两处都占）
place.remove(id);          // 拆除，全部释放
place.findSpots('house');  // UI 高亮所有可放位置
```

`move` 失败会**回滚**——不会出现"原位和原位都占着"或"建筑消失"。

## ③ 六边形（axial q,r）

```typescript
hexDistance({q:0,r:0}, {q:3,r:-1});   // 3
hexNeighbors({q:0,r:0});              // 6 个
hexRing(center, 2);                   // 半径 2 的环，12 个
hexSpiral(center, 2);                 // 半径内实心，19 个（3r²+3r+1）
hexToPixel(h, size);                  // → {x, y}
pixelToHex(x, y, size);               // → {q, r}
```

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| **`new Array(n)` 是稀疏数组** | `.filter()` 跳过空洞，`freeCount` 永远返回 0，且**不抛异常** | 已修复：`new Array(n).fill(undefined)` + 改用计数循环 |
| 拆除时"扫描全图找 id" | O(n²) 且逻辑绕 | 已处理：按 Placed 记录的 w/h 精确清 |
| 旋转后忘记换 w/h | 占位区域错 | 已处理：`_size()` 统一处理 |
| 六边形 float 取整直接 round | 边缘格子算错 | 用 `hexRound`（cube round，保证 q+r+s=0） |

## 生命周期

`destroy()` —— 清空网格并释放内部数组。

> 切关卡时调。网格持有 `w × h` 的定长数组，
> **大地图（如 512×512）不释放会一直占着 26 万条记录**，
> 而它看起来只是"一个不用的对象"。

## API

### Grid\<T\>
`index(x,y)` / `inBounds` / `get` / `set`（越界 false）/ `setStrict`（越界抛错）
`clear` / `fillAll` / `fill` / `neighbors4` / `neighbors8`
`find` / `count` / `forEach` / `toRows` / `Grid.fromRows` / 可迭代

### GridPlacement
`define({id,w,h,rotatable?})` / `canPlace(id,x,y,rotated?)`
`place(...)` 返回实例 id 或 null / `at(x,y)` / `isFree`
`remove(instanceId)` / `move(instanceId,x,y)` / `get(instanceId)`
`findSpots(id, rotated?)` / `placedCount` / `freeCount` / `clear`

### Hex
`hex` / `hexAdd` / `hexEquals` / `hexNeighbors` / `hexDistance`
`hexRing` / `hexSpiral` / `hexToPixel` / `pixelToHex` / `hexRound`
