/**
 * _core/types.ts —— 跨插件共用的极简类型契约
 *
 * 【为什么这些类型在这里】
 * 它们描述的是「能力」而不是「业务」：
 * - IDisposable：能被销毁
 * - IVec2：二维向量（纯数据，不含引擎类型）
 *
 * 放这里的判据同 math.ts：无状态、无实现、只是形状声明。
 *
 * 【关键设计：为什么用 IVec2 而不是 Cocos 的 Vec3】
 * 一旦这里写了 `import { Vec3 } from 'cc'`，整个 _core 就绑死在 Cocos 上，
 * 纯逻辑层就无法脱离引擎单测了。
 *
 * 插件内部一律用 IVec2 / number 做计算，引擎层负责 IVec2 ↔ Vec3 的转换。
 * 这层薄转换是可复用性付出的代价，但它换来了「逻辑可测 + 引擎可换」。
 */

/** 二维向量（纯数据，不是引擎对象，可自由创建不产生 GC 压力顾虑） */
export interface IVec2 {
  x: number;
  y: number;
}

export function vec2(x = 0, y = 0): IVec2 {
  return { x, y };
}

/** 就地设置，避免创建新对象（高频路径用） */
export function setVec2(out: IVec2, x: number, y: number): IVec2 {
  out.x = x;
  out.y = y;
  return out;
}

/** 向量长度 */
export function len2(v: IVec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

/** 归一化（零向量返回零向量，不产生 NaN） */
export function normalize2(v: IVec2): IVec2 {
  const l = len2(v);
  return l < 1e-6 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

// ============================================================
// 矩形：两种表示法并存，不要强行统一
// ============================================================

/**
 * 矩形 · **角点表示法**（min/max 四至）
 *
 * 【⚠️ 旧注释写的是"左下 + 右上"，那是错的，已更正】
 *
 * `min/max` 是**数值**上的小/大，与 y 轴朝上还是朝下**无关**：
 * `minY` 永远是 y 值更小的那条边，不是"下面那条边"。
 *
 * 旧注释同时声称 `IRectSized` 是"左上角"，而 `toCorners` 又把
 * `IRectSized.y` 直接当成 `minY` —— 这两句话放在一起是矛盾的：
 * 在 y 向下的屏幕坐标系里，"左上角"的 y 确实更小（= minY）；
 * 但在 y 向上的世界里，"左上角"的 y 是**最大**值，应当是 maxY。
 * 于是同一个 `toCorners` 在两种坐标系下只有一个是对的。
 *
 * 【统一口径（本库结论）】
 *   - `IRect` 的 min/max：**轴无关**，只按数值大小。别用"上下左右"描述它。
 *   - `IRectSized` 的 x/y：**是 min 角**（数值较小的那个角），
 *     不是"左上角"。y 轴朝上时它在视觉上位于**下方**。
 *   - `toCorners` / `toSized`：**假设 y 向下**（屏幕坐标系）。
 *     y 向上的场景（如 `camera`）请自行确认方向，别直接套用。
 *
 * 【为什么两种表示法并存】
 * 历史上 `camera` 用 `{minX,minY,maxX,maxY}`，`ds` / `dungeon` 用 `{x,y,w,h}`，
 * 都叫 `Rect`。同名、同库、坐标系不同——调用方会以为 `Rect` 就是 `Rect`，
 * 写出 `x + w` 却拿到 `minX/maxX` 的语义。**不报错，只是算出错误的矩形。**
 *
 * 两种各有适用场景，不强行统一：
 *   - 角点法：边界判定、视口裁剪、AABB 相交——比较大小最直接
 *   - 位置+尺寸法：布局、平铺、房间生成——算位置最方便
 *
 * 【新代码请用这两个名字，别再用裸 `Rect`】
 * `Rect` 在 3 个模块里各有一份且互不兼容，裸用必踩坑。
 */
export interface IRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * 矩形 · **位置+尺寸表示法**
 *
 * `x` / `y` 是 **min 角**（数值较小的那个角），不是"左上角"——
 * 详见 {@link IRect} 里的统一口径说明。
 *
 * y 轴朝上时，`y` 在视觉上位于**下方**，加 `h` 才是上方。
 */
export interface IRectSized {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 位置+尺寸 → 角点
 *
 * 【⚠️ 假设 y 轴向下（屏幕坐标系）】
 *
 * 实现是 `minY = r.y, maxY = r.y + r.h`，
 * 即"y 越大越靠下"。这与屏幕坐标系一致，
 * 但**与 y 向上的世界坐标系相反**——那种场景下直接调用会得到一个
 * 上下翻转的矩形，且不报错。
 *
 * y 向上的场景请先确认方向，或写成 `minY: r.y - r.h, maxY: r.y`。
 */
export function toCorners(r: IRectSized): IRect {
  return { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
}

/** 角点 → 位置+尺寸 */
export function toSized(r: IRect): IRectSized {
  return { x: r.minX, y: r.minY, w: r.maxX - r.minX, h: r.maxY - r.minY };
}

/**
 * 就地写入角点矩形（热路径免分配）
 *
 * 【坑】`out` 必须有 minX/minY/maxX/maxY 四个字段，
 * 传一个 `{x,y,w,h}` 进去**不会报错**，只会静默写出 4 个 NaN。
 */
export function setCorners(
  out: { minX: number; minY: number; maxX: number; maxY: number },
  minX: number, minY: number, maxX: number, maxY: number
): void {
  out.minX = minX; out.minY = minY; out.maxX = maxX; out.maxY = maxY;
}

/**
 * 点是否落在角点矩形内（**闭区间**，含四条边界）
 *
 * 【⚠️ 与 `ds.pointInRect` 的半开区间不同，别混用】
 *
 * 实测（矩形 x:0 w:10）：
 * ```js
 * rectContains(r, 10, 0)          // → true  （本函数，含右边界）
 * pointInRect(10, 0, sized)       // → false （ds，半开 [x, x+w)）
 * ```
 * 半开区间是**格子归属判定**的正确语义（相邻格子共享边界，
 * 闭区间会让边界点同时属于两格）；闭区间是**区域包含**的常规语义。
 * 两者在各自场景下都对，错的是不看语义就互相替换。
 */
export function rectContains(r: IRect, x: number, y: number): boolean {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

/**
 * 两个角点矩形是否相交（**含相切**，用 `<=`）
 *
 * 【⚠️ 与 `ds.rectsOverlap` 的不含相切不同，别混用】
 *
 * 实测（a 右边界 10 == b 左边界 10，刚好贴住）：
 * ```js
 * rectOverlaps(a, b)   // → true  （本函数，贴着就算）
 * rectsOverlap(aSized, bSized)  // → false （ds，用 <）
 * ```
 * `ds` 版用于空间索引，不含相切可避免边界物体被重复命中；
 * 本函数是通用 AABB 判定，含相切是几何上的常规约定。
 */
export function rectOverlaps(a: IRect, b: IRect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX &&
         a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * 可销毁接口
 *
 * 【铁律 5】所有插件必须实现它，且 destroy() 必须清干净：
 * 事件监听、定时器、缓存引用、创建的节点。
 *
 * 【坑】最容易漏的是「事件监听」和「定时器」——
 * 它们不会随对象一起消失，而是继续持有 this，导致对象永不释放。
 */
export interface IDisposable {
  destroy(): void;
}

/**
 * 【这里曾经有一个 `export type Partial<T>`，已删除】
 *
 * 它与 TS 内置的 `Partial<T>` 同名，一旦被 import 就**遮蔽全局版本**，
 * 让读代码的人无法判断某个 `Partial<Foo>` 到底指哪一个。
 * 全库 0 处引用，属于纯负收益。
 *
 * 需要"部分覆盖"语义请直接用内置的 `Partial<T>`。
 */

/** 数值区间 */
export interface IRange {
  min: number;
  max: number;
}

/**
 * 随机源能力契约
 *
 * 【为什么需要它】
 * 很多插件（掉落、洗牌袋、开箱）需要随机数，但铁律 6 禁止插件横向依赖——
 * 它们不能 `import { RNG } from '../rng/RNG'`。
 *
 * 解法：只依赖「能给我一个 [0,1) 的数」这个**能力**，不依赖具体实现。
 *
 * ```typescript
 * function pick<T>(items: T[], rng: IRandomSource): T { ... }
 *
 * pick(list, new RNG(12345));     // 用可复现 RNG
 * pick(list, MathRandomSource);   // 用 Math.random
 * pick(list, seededTestSource);   // 测试里用固定序列
 * ```
 *
 * 这既满足了零依赖，还顺带让所有随机逻辑变得**可测试**。
 */
export interface IRandomSource {
  /** 返回 [0, 1) 的随机数 */
  next(): number;
}

/** 适配器：把 Math.random 包装成 IRandomSource（不需要可复现时用） */
export const MathRandomSource: IRandomSource = {
  next(): number {
    return Math.random();
  },
};

/** 适配器：固定序列（测试用，能精确控制随机行为） */
export class FixedRandomSource implements IRandomSource {
  private _i = 0;

  constructor(private readonly _values: readonly number[]) {
    //
    // 【为什么要在构造时就抛错，而不是在 next() 里兜底】
    //
    // 空序列时 `_i % 0` 得到 NaN，`_values[NaN]` 得到 undefined，
    // 于是 next() 会返回 undefined —— 违反 IRandomSource 声明的
    // `next(): number` 契约。
    //
    // 危害不在 undefined 本身，而在**它是静默的**：
    //   undefined 传进掉落表的权重 → loot.roll() 返回 undefined
    //   → 玩家击杀怪物什么都不掉，控制台没有任何报错。
    // 这正是本库一直在消除的那类静默错误。
    //
    // 兜底成 0 或 Math.random() 同样是在掩盖调用方的 bug——
    // 测试里写死序列却传了空数组，几乎一定是写错了。
    // **让它立刻失败，并说清楚为什么。**
    if (!_values || _values.length === 0) {
      throw new Error(
        '[FixedRandomSource] 随机序列不能为空。' +
          '空序列会让 next() 返回 undefined（_i % 0 → NaN → _values[NaN]），' +
          '这个 undefined 会静默传播到掉落/洗牌等下游，表现为"什么都不掉"却无报错。' +
          '如果你想要不可复现的随机，请用 MathRandomSource。'
      );
    }
  }

  next(): number {
    const v = this._values[this._i % this._values.length];
    this._i++;
    return v;
  }

  /** 已取用的次数（测试断言用） */
  get calls(): number {
    return this._i;
  }

  reset(): void {
    this._i = 0;
  }
}
