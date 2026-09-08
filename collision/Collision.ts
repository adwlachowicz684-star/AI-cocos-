/**
 * collision/Collision.ts —— 碰撞检测与解析（物理阻挡层）
 *
 * 【它和 hitbox 的区别】
 *
 * 这是一个极易混淆的地方，先说清楚：
 *
 * | | hitbox（已有） | collision（本模块） |
 * |---|---|---|
 * | 回答什么 | "这个攻击打中了谁" | "这个角色能不能走到这儿" |
 * | 要什么结果 | 布尔：重叠 / 不重叠 | **MTV**：推开多少、朝哪个方向 |
 * | 重叠时 | 造成伤害 | **不允许重叠**，要分离 |
 * | 典型形状 | 扇形（攻击范围） | 胶囊、AABB（身体、墙） |
 *
 * 形状系统看起来相似，但**需求完全不同**：
 * hitbox 只需要"是/否"，collision 需要"推开向量"。
 * 硬塞进一个模块的话，扇形也要实现 MTV，而那没有意义。
 *
 * 【三个必须处理的问题】
 *
 * 1. **高速穿墙** —— 位移大于墙厚时，起点和终点都在墙外，
 *    逐帧点检测完全漏掉。必须 sweep（扫掠）或子步进。
 *
 * 2. **角落卡住** —— 同时撞到两面墙，分别应用两个 MTV 会让角色
 *    在两个方向上来回弹，最终卡死在角上。
 *
 * 3. **沿墙滑动** —— 斜向撞墙时如果不把速度投影到墙面切线，
 *    玩家会觉得"我明明在推摇杆，角色却不动"。
 *    这是动作游戏手感的头号杀手。
 */

import { clamp, clamp01 } from '../_core/math';

// ==================== 形状 ====================

/** 形状类型标签 */
export type ShapeKind = 'circle' | 'aabb' | 'obb' | 'capsule';

/** 圆：中心 + 半径 */
export interface CircleShape {
  readonly kind: 'circle';
  x: number;
  y: number;
  r: number;
}

/** 轴对齐矩形：中心 + 半宽半高 */
export interface AabbShape {
  readonly kind: 'aabb';
  x: number;
  y: number;
  /** 半宽（half extent） */
  hw: number;
  /** 半高 */
  hh: number;
}

/**
 * 旋转矩形：中心 + 半宽半高 + 弧度
 *
 * 【⚠️ 用 half extent 而不是 width/height】
 * 物理计算里几乎全都要用半长（判断重叠、算距离、求投影）。
 * 存全长的话，每个函数第一行都得 `/ 2`，既啰嗦又是精度损失的来源。
 */
export interface ObbShape {
  readonly kind: 'obb';
  x: number;
  y: number;
  hw: number;
  hh: number;
  /** 弧度，逆时针为正 */
  rot: number;
}

/**
 * 胶囊：线段 + 半径
 *
 * 【为什么角色常用胶囊而不是矩形】
 * 矩形撞到墙角会被"角"卡住（因为角是尖的），
 * 胶囊在任何方向都是圆角，能自然滑过去。
 * 这是几乎所有 3D 角色控制器都用胶囊的原因。
 */
export interface CapsuleShape {
  readonly kind: 'capsule';
  /** 线段起点 */
  x0: number;
  y0: number;
  /** 线段终点 */
  x1: number;
  y1: number;
  r: number;
}

export type Shape = CircleShape | AabbShape | ObbShape | CapsuleShape;

/**
 * 凸多边形（顶点按**逆时针**给出）
 *
 * 【为什么单独一类而不是复用 obb】
 * 关卡里的墙、斜面的碰撞体往往是不规则多边形。
 * 用 SAT 统一处理，代价是顶点数一多就慢——
 * 所以复杂多边形应当先用包围盒粗筛。
 */
export interface PolygonShape {
  readonly kind: 'polygon';
  /** 局部坐标顶点（逆时针），使用时叠加上 x/y 偏移 */
  x: number;
  y: number;
  rot: number;
  /** [x0,y0, x1,y1, ...] 扁平数组，减少对象分配 */
  pts: readonly number[];
}

export type AnyShape = Shape | PolygonShape;

// ==================== 构造辅助 ====================

/**
 * ==================== 与 hitbox 同时使用的别名 ====================
 *
 * 【为什么需要】
 * `collision`（移动碰撞）和 `hitbox`（攻击判定）几乎必然同时使用——
 * 先用 hitbox 判定命中，再用 collision 做移动分离。
 *
 * 但两边有 5 个同名导出：`Shape` / `ShapeKind` / `circle` / `capsule` / `boundingRadius`。
 * 同一文件直接 import 两边会报 **TS2300 Duplicate identifier ×5**。
 *
 * 用下面这套带 `Col` 前缀的别名即可避免，两条 import 可以共存：
 *
 * ```typescript
 * import { ColShape, colCircle, colCapsule, colBoundingRadius } from '.../collision/Collision';
 * import { HitShape, hitCircle } from '.../hitbox/Hitbox';
 * ```
 *
 * 【为什么不直接把原名改掉】
 * 那会破坏所有已有代码。别名是零成本的兼容方案。
 *
 * 【两套 Shape 不通用】
 * `ColShape` 是 `'circle'|'aabb'|'obb'|'capsule'`，
 * `HitShape` 是 `'circle'|'rect'|'sector'|'capsule'`，
 * 业务侧要自己写转换——这是刻意的，两者算法差异大，强行统一不合理。
 */
export type { Shape as ColShape, ShapeKind as ColShapeKind } from './Collision';
export {
  circle as colCircle,
  capsule as colCapsule,
  boundingRadius as colBoundingRadius,
} from './Collision';

export function circle(x: number, y: number, r: number): CircleShape {
  return { kind: 'circle', x, y, r };
}

export function aabb(x: number, y: number, hw: number, hh: number): AabbShape {
  return { kind: 'aabb', x, y, hw, hh };
}

export function obb(x: number, y: number, hw: number, hh: number, rot = 0): ObbShape {
  return { kind: 'obb', x, y, hw, hh, rot };
}

export function capsule(x0: number, y0: number, x1: number, y1: number, r: number): CapsuleShape {
  return { kind: 'capsule', x0, y0, x1, y1, r };
}

/** 由中心、半宽半高构造 AABB（很多配置里给的是 min/max 或 w/h） */
export function aabbFromSize(cx: number, cy: number, w: number, h: number): AabbShape {
  return { kind: 'aabb', x: cx, y: cy, hw: w / 2, hh: h / 2 };
}

// ==================== 基础几何 ====================

/** 点到线段的最近点（写入 out，避免分配） */
export function closestPointOnSegment(
  px: number, py: number,
  x0: number, y0: number, x1: number, y1: number,
  out: { x: number; y: number }
): { x: number; y: number } {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;

  // 【⚠️ 退化情况：线段长度为 0】
  // 不判的话会除以 0 得到 NaN，然后 NaN 会一路传播到位置，
  // 表现为"角色突然消失"——极难排查，因为不抛任何异常。
  if (lenSq < 1e-12) {
    out.x = x0;
    out.y = y0;
    return out;
  }

  let t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = clamp01(t);
  out.x = x0 + dx * t;
  out.y = y0 + dy * t;
  return out;
}

/** 点到线段的距离平方 */
export function distSqPointSegment(
  px: number, py: number,
  x0: number, y0: number, x1: number, y1: number
): number {
  const p = { x: 0, y: 0 };
  closestPointOnSegment(px, py, x0, y0, x1, y1, p);
  const dx = px - p.x;
  const dy = py - p.y;
  return dx * dx + dy * dy;
}

/** 形状的中心（用于粗筛和排序） */
export function shapeCenter(s: AnyShape): { x: number; y: number } {
  switch (s.kind) {
    case 'circle':
      return { x: s.x, y: s.y };
    case 'aabb':
    case 'obb':
    case 'polygon':
      return { x: s.x, y: s.y };
    case 'capsule':
      return { x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 };
  }
}

/** 形状的包围圆半径（粗筛用） */
export function boundingRadius(s: AnyShape): number {
  switch (s.kind) {
    case 'circle':
      return s.r;
    case 'aabb':
    case 'obb':
      return Math.sqrt(s.hw * s.hw + s.hh * s.hh);
    case 'capsule': {
      const dx = s.x1 - s.x0;
      const dy = s.y1 - s.y0;
      return Math.sqrt(dx * dx + dy * dy) / 2 + s.r;
    }
    case 'polygon': {
      let maxSq = 0;
      for (let i = 0; i < s.pts.length; i += 2) {
        const d = s.pts[i]! * s.pts[i]! + s.pts[i + 1]! * s.pts[i + 1]!;
        if (d > maxSq) maxSq = d;
      }
      return Math.sqrt(maxSq);
    }
  }
}

// ==================== 相交测试 ====================

export function circleCircle(a: CircleShape, b: CircleShape): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rr = a.r + b.r;
  return dx * dx + dy * dy <= rr * rr;
}

export function aabbAabb(a: AabbShape, b: AabbShape): boolean {
  return (
    Math.abs(a.x - b.x) <= a.hw + b.hw &&
    Math.abs(a.y - b.y) <= a.hh + b.hh
  );
}

export function circleAabb(c: CircleShape, b: AabbShape): boolean {
  // 把圆心夹到矩形内，取最近点，再比距离
  const nx = clamp(c.x, b.x - b.hw, b.x + b.hw);
  const ny = clamp(c.y, b.y - b.hh, b.y + b.hh);
  const dx = c.x - nx;
  const dy = c.y - ny;
  return dx * dx + dy * dy <= c.r * c.r;
}

export function circleCapsule(c: CircleShape, cap: CapsuleShape): boolean {
  const rr = c.r + cap.r;
  return distSqPointSegment(c.x, c.y, cap.x0, cap.y0, cap.x1, cap.y1) <= rr * rr;
}

export function pointInAabb(px: number, py: number, b: AabbShape): boolean {
  return (
    px >= b.x - b.hw && px <= b.x + b.hw &&
    py >= b.y - b.hh && py <= b.y + b.hh
  );
}

export function pointInCircle(px: number, py: number, c: CircleShape): boolean {
  const dx = px - c.x;
  const dy = py - c.y;
  return dx * dx + dy * dy <= c.r * c.r;
}

/** 通用相交测试（分派） */
export function intersects(a: AnyShape, b: AnyShape): boolean {
  const ka = a.kind;
  const kb = b.kind;

  if (ka === 'circle' && kb === 'circle') return circleCircle(a, b);
  if (ka === 'circle' && kb === 'aabb') return circleAabb(a, b);
  if (ka === 'aabb' && kb === 'circle') return circleAabb(b, a);
  if (ka === 'aabb' && kb === 'aabb') return aabbAabb(a, b);
  if (ka === 'circle' && kb === 'capsule') return circleCapsule(a, cap(b));
  if (ka === 'capsule' && kb === 'circle') return circleCapsule(b, a);

  // 其余组合走 SAT（多边形化）
  return satOverlap(toPolygon(a), toPolygon(b)).overlap;
}

/**
 * 把任意形状转成凸多边形的**世界坐标**顶点（SAT 统一处理）
 *
 * 【⚠️ 必须是世界坐标，不是局部坐标】
 *
 * 第一版返回的是"以形状中心为原点"的局部顶点。
 * 于是 `satOverlap(toPolygon(a), toPolygon(b))` 把两个**不同原点**的
 * 多边形投影到同一条轴上比较——区间完全错位。
 *
 * 这个 bug 极隐蔽：当两个形状都恰好在原点附近时结果是对的，
 * 只有位置拉开距离后才出错，而单元测试很容易只测原点附近。
 *
 * 修法：每种形状都加上自己的位置偏移。
 */
function toPolygon(s: AnyShape): number[] {
  switch (s.kind) {
    case 'aabb':
      return [
        s.x - s.hw, s.y - s.hh,
        s.x + s.hw, s.y - s.hh,
        s.x + s.hw, s.y + s.hh,
        s.x - s.hw, s.y + s.hh,
      ];
    case 'obb': {
      const c = Math.cos(s.rot);
      const sn = Math.sin(s.rot);
      const out: number[] = [];
      const corners = [
        [-s.hw, -s.hh], [s.hw, -s.hh], [s.hw, s.hh], [-s.hw, s.hh],
      ];
      for (const [cx, cy] of corners) {
        out.push(s.x + cx! * c - cy! * sn, s.y + cx! * sn + cy! * c);
      }
      return out;
    }
    case 'circle': {
      // 圆用正 N 边形近似（SAT 无法直接处理曲面）
      const N = 12;
      const out: number[] = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        out.push(s.x + Math.cos(a) * s.r, s.y + Math.sin(a) * s.r);
      }
      return out;
    }
    case 'capsule': {
      // 胶囊沿法线方向扩出两段圆弧
      const dx = s.x1 - s.x0;
      const dy = s.y1 - s.y0;
      const ang = Math.atan2(dy, dx);
      const N = 6;
      const out: number[] = [];
      // 起点侧的半圆
      for (let i = 0; i <= N; i++) {
        const a = ang + Math.PI / 2 + (i / N) * Math.PI;
        out.push(s.x0 + Math.cos(a) * s.r, s.y0 + Math.sin(a) * s.r);
      }
      // 终点侧的半圆
      for (let i = 0; i <= N; i++) {
        const a = ang - Math.PI / 2 + (i / N) * Math.PI;
        out.push(s.x0 + dx + Math.cos(a) * s.r, s.y0 + dy + Math.sin(a) * s.r);
      }
      return out;
    }
    case 'polygon': {
      if (s.rot === 0) {
        const out: number[] = [];
        for (let i = 0; i < s.pts.length; i += 2) {
          out.push(s.x + s.pts[i]!, s.y + s.pts[i + 1]!);
        }
        return out;
      }
      const c = Math.cos(s.rot);
      const sn = Math.sin(s.rot);
      const out: number[] = [];
      for (let i = 0; i < s.pts.length; i += 2) {
        const px = s.pts[i]!;
        const py = s.pts[i + 1]!;
        out.push(s.x + px * c - py * sn, s.y + px * sn + py * c);
      }
      return out;
    }
  }
}

/** 把胶囊当圆处理（半径取最大，保守但便宜）—— 仅用于快速排除 */
function cap(s: AnyShape): CapsuleShape {
  if (s.kind === 'capsule') return s;
  const c = shapeCenter(s);
  return { kind: 'capsule', x0: c.x, y0: c.y, x1: c.x, y1: c.y, r: boundingRadius(s) };
}

// ==================== SAT：重叠 + MTV ====================

/**
 * SAT 重叠检测结果
 *
 * `mtvX/mtvY` 是把 a 推离 b 所需的**最小平移向量**。
 * 它是 collision 模块的核心产物——hitbox 不需要它，collision 需要。
 */
export interface SatResult {
  overlap: boolean;
  /** 把 a 推出去的方向（已归一化） */
  mtvX: number;
  mtvY: number;
  /** 推开距离（沿 mtv 方向移动这么多就刚好不重叠） */
  depth: number;
}

const _satEmpty: SatResult = { overlap: false, mtvX: 0, mtvY: 0, depth: 0 };

/**
 * 分离轴定理（凸多边形）
 *
 * 【⚠️ 两个易错点】
 *
 * 1. **分离判定必须用严格小于 `<`**
 *    `maxA == minB` 是"刚好边贴边"，应算重叠（depth = 0，不需推开）。
 *    用 `<=` 判分离会让贴墙状态被误判为自由，
 *    角色下一帧就能挤进墙里。
 *
 * 2. **重叠量要取所有轴里最小的**
 *    取最大的话会把物体推到错误的方向（穿到另一边去）。
 *    这也是 MTV 名字里 "minimum" 的含义。
 *
 * 【⚠️ 坐标系：传入的顶点必须是世界坐标】
 * 见 `toPolygon` 的说明——局部坐标会让投影区间完全错位。
 */
export function satOverlap(polyA: readonly number[], polyB: readonly number[]): SatResult {
  const axes = collectAxes(polyA, polyB);
  let minDepth = Infinity;
  let mtvX = 0;
  let mtvY = 0;

  for (const [ax, ay] of axes) {
    const [minA, maxA] = project(polyA, ax, ay);
    const [minB, maxB] = project(polyB, ax, ay);

    // 【⚠️ 分离轴：必须是严格小于，不是 <=】
    //
    // `maxA == minB` 表示两个多边形**刚好边贴边**（间隙为 0）。
    // 这应当判为"重叠"（depth=0，不需要推开），与
    // `circleCircle` / `aabbAabb` 用 `<=` 的口径保持一致。
    //
    // 写成 `<=` 的话，贴着墙站会被判为分离，
    // 于是下一帧的微小浮点抖动让角色挤进墙里一点点——
    // 累积起来就是"偶尔能穿墙"。
    if (maxA < minB || maxB < minA) return _satEmpty;

    // 重叠量（取两个方向里较小的那个，才是"推开"所需的）
    const d1 = maxA - minB;   // B 在 A 的右边 → 把 A 往左推
    const d2 = maxB - minA;   // B 在 A 的左边 → 把 A 往右推
    const d = d1 < d2 ? d1 : d2;
    const sign = d1 < d2 ? -1 : 1;

    if (d < minDepth) {
      minDepth = d;
      mtvX = ax * sign;
      mtvY = ay * sign;
    }
  }

  return { overlap: true, mtvX, mtvY, depth: minDepth };
}

/** 收集两个多边形的所有候选分离轴（各自的边法线） */
function collectAxes(a: readonly number[], b: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  pushAxes(a, out);
  pushAxes(b, out);
  return out;
}

function pushAxes(poly: readonly number[], out: [number, number][]): void {
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = poly[j * 2]! - poly[i * 2]!;
    const ey = poly[j * 2 + 1]! - poly[i * 2 + 1]!;
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len < 1e-12) continue;
    // 边法线（逆时针多边形的外法线）
    const nx = ey / len;
    const ny = -ex / len;
    // 去重（矩形只有 2 条独立轴，不去重会白白多算一倍）
    let dup = false;
    for (const [ox, oy] of out) {
      if (Math.abs(ox - nx) < 1e-9 && Math.abs(oy - ny) < 1e-9) { dup = true; break; }
      // 反向轴等价于同一条轴
      if (Math.abs(ox + nx) < 1e-9 && Math.abs(oy + ny) < 1e-9) { dup = true; break; }
    }
    if (!dup) out.push([nx, ny]);
  }
}

/** 把多边形投影到轴上，返回 [min, max] */
function project(poly: readonly number[], ax: number, ay: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const d = poly[i]! * ax + poly[i + 1]! * ay;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

// ==================== 扫掠（连续碰撞） ====================

/**
 * 扫掠结果
 *
 * `t` 是 0~1 的命中时刻：`t = 0.5` 表示移到一半时撞上。
 * 用它可以把物体停在撞击点，而不是穿过去。
 */
export interface SweepResult {
  hit: boolean;
  /** 命中时刻（0~1） */
  t: number;
  /** 命中点的法线（指向移动物体，即"该往回退"的方向） */
  nx: number;
  ny: number;
}

const _sweepMiss: SweepResult = { hit: false, t: 1, nx: 0, ny: 0 };

/**
 * 圆 vs AABB 的扫掠检测
 *
 * 【为什么需要它】
 * 子弹速度 2000/秒，一帧 16.7ms 移动 33 像素，
 * 而墙只有 20 像素厚——起点和终点都在墙外，逐帧点检测完全漏掉。
 * 表现为"偶尔能穿墙，无法复现"，是最难查的一类 bug。
 *
 * 【做法】
 * 把圆半径"膨胀"到 AABB 上（Minkowski 和），
 * 于是"圆扫过矩形"等价于"点扫过圆角矩形"。
 * 这里进一步简化为：点 vs 膨胀后的 AABB（忽略圆角），
 * 换来的是 O(1) 的解析解和足够的精度。
 * 圆角处的误差最多 0.41×r，对游戏碰撞完全够用。
 */
export function sweepCircleAabb(
  cx: number, cy: number, r: number,
  dx: number, dy: number,
  b: AabbShape
): SweepResult {
  // Minkowski：膨胀矩形
  const minX = b.x - b.hw - r;
  const maxX = b.x + b.hw + r;
  const minY = b.y - b.hh - r;
  const maxY = b.y + b.hh + r;

  // 起点已在内部：算作 t=0 命中，法线取最浅的那个面
  if (cx > minX && cx < maxX && cy > minY && cy < maxY) {
    const dLeft = cx - minX;
    const dRight = maxX - cx;
    const dDown = cy - minY;
    const dUp = maxY - cy;
    const m = Math.min(dLeft, dRight, dDown, dUp);
    if (m === dLeft) return { hit: true, t: 0, nx: -1, ny: 0 };
    if (m === dRight) return { hit: true, t: 0, nx: 1, ny: 0 };
    if (m === dDown) return { hit: true, t: 0, nx: 0, ny: -1 };
    return { hit: true, t: 0, nx: 0, ny: 1 };
  }

  // 射线 vs 膨胀 AABB（slab 方法）
  let tmin = -Infinity;
  let tmax = Infinity;
  let hitAxis = 0;
  let hitSign = 0;

  // X 轴 slab
  if (Math.abs(dx) < 1e-12) {
    if (cx < minX || cx > maxX) return _sweepMiss;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - cx) * inv;
    let t2 = (maxX - cx) * inv;
    let sign = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sign = 1; }
    if (t1 > tmin) { tmin = t1; hitAxis = 0; hitSign = sign; }
    if (t2 < tmax) tmax = t2;
  }

  // Y 轴 slab
  if (Math.abs(dy) < 1e-12) {
    if (cy < minY || cy > maxY) return _sweepMiss;
  } else {
    const inv = 1 / dy;
    let t1 = (minY - cy) * inv;
    let t2 = (maxY - cy) * inv;
    let sign = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sign = 1; }
    if (t1 > tmin) { tmin = t1; hitAxis = 1; hitSign = sign; }
    if (t2 < tmax) tmax = t2;
  }

  if (tmax < tmin || tmax < 0 || tmin > 1 || tmin < 0) return _sweepMiss;

  return {
    hit: true,
    t: tmin,
    nx: hitAxis === 0 ? hitSign : 0,
    ny: hitAxis === 1 ? hitSign : 0,
  };
}

// ==================== 碰撞体与解析 ====================

/**
 * 碰撞层
 *
 * 【为什么用位掩码而不是字符串标签】
 * 位掩码的相交判断是一条 CPU 指令，字符串要查表。
 * 高频路径（每帧几百次）上这个差别很明显。
 *
 * 上限 32 层——对任何游戏都够了，而且 32 位整数在 JS 里是原子的。
 */
export const LAYER = {
  NONE: 0,
  DEFAULT: 1 << 0,
  PLAYER: 1 << 1,
  ENEMY: 1 << 2,
  WALL: 1 << 3,
  TRIGGER: 1 << 4,
  PROJECTILE: 1 << 5,
  PICKUP: 1 << 6,
  ALL: 0xffffffff,
} as const;

/** 场景里的一个碰撞体 */
export interface Collider {
  readonly id: number;
  shape: AnyShape;
  /** 所属层 */
  layer: number;
  /** 会与哪些层发生碰撞 */
  mask: number;
  /** true = 只报告重叠，不产生分离（如拾取区、触发区） */
  trigger: boolean;
  /** 附加数据（业务侧自己解释） */
  userData?: unknown;
}

export function makeCollider(
  id: number,
  shape: AnyShape,
  opts: { layer?: number; mask?: number; trigger?: boolean; userData?: unknown } = {}
): Collider {
  return {
    id,
    shape,
    layer: opts.layer ?? LAYER.DEFAULT,
    mask: opts.mask ?? LAYER.ALL,
    trigger: opts.trigger ?? false,
    userData: opts.userData,
  };
}

/** 两个碰撞体是否会发生碰撞（双向：我的 mask 认你的 layer，你的 mask 也认我的 layer） */
export function canCollide(a: Collider, b: Collider): boolean {
  return (a.mask & b.layer) !== 0 && (b.mask & a.layer) !== 0;
}

// ==================== 空间网格 ====================

/**
 * 均匀网格（宽阶段加速）
 *
 * 【为什么不用现成的 QuadTree】
 * `ds/` 里的 QuadTree 适合**静态、分布不均**的数据；
 * 碰撞体每帧都在动，QuadTree 的重建开销反而更大。
 * 均匀网格是"动态 + 尺寸相近"场景的经典选择——
 * 角色、墙、子弹基本都是同一量级的大小。
 */
export class CollisionGrid {
  /** 查询用的复用 Set（不可重入） */
  private readonly _scratchSeen = new Set<number>();
  private readonly _cell: number;
  private readonly _buckets = new Map<number, Collider[]>();
  private _nextId = 1;

  constructor(cellSize = 64) {
    // 【⚠️ cellSize 必须为正】
    // 为 0 会导致除零 → key 变成 NaN → 所有对象都塞进同一个 NaN 桶，
    // 于是查询退化成 O(n) 且**不报错**，只是莫名地慢。
    if (!(cellSize > 0)) throw new Error(`cellSize 必须为正，收到 ${cellSize}`);
    this._cell = cellSize;
  }

  nextId(): number {
    return this._nextId++;
  }

  private _key(cx: number, cy: number): number {
    // 用 32 位打包两个 16 位坐标（支持 ±32767 格）
    return ((cx & 0xffff) << 16) | (cy & 0xffff);
  }

  clear(): void {
    this._buckets.clear();
  }

  insert(c: Collider): void {
    const b = boundingRadius(c.shape);
    const ctr = shapeCenter(c.shape);
    const minX = Math.floor((ctr.x - b) / this._cell);
    const maxX = Math.floor((ctr.x + b) / this._cell);
    const minY = Math.floor((ctr.y - b) / this._cell);
    const maxY = Math.floor((ctr.y + b) / this._cell);

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const k = this._key(x, y);
        let arr = this._buckets.get(k);
        if (!arr) {
          arr = [];
          this._buckets.set(k, arr);
        }
        // 【⚠️ 同一碰撞体会落在多个格子，去重靠 id】
        // 不去重的话，站在格子边界的角色会被检测两次，
        // 分离力翻倍 → 抖动。
        if (!arr.some((e) => e.id === c.id)) arr.push(c);
      }
    }
  }

  /** 查询可能与 circle 重叠的碰撞体（去重后） */
  query(cx: number, cy: number, r: number, out: Collider[] = []): Collider[] {
    out.length = 0;
    const minX = Math.floor((cx - r) / this._cell);
    const maxX = Math.floor((cx + r) / this._cell);
    const minY = Math.floor((cy - r) / this._cell);
    const maxY = Math.floor((cy + r) / this._cell);
    // 【性能】早期每次查询 new 一个 Set，500 实体每帧 3.24 KB 分配。
    // 复用实例级 scratch（注意：不可重入，嵌套查询会互相踩）
    const seen = this._scratchSeen;
    seen.clear();

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const arr = this._buckets.get(this._key(x, y));
        if (!arr) continue;
        for (const c of arr) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          out.push(c);
        }
      }
    }
    return out;
  }

  get bucketCount(): number {
    return this._buckets.size;
  }
}

// ==================== 移动解算 ====================

/**
 * 移动解算结果
 */
export interface MoveResult {
  /** 最终位置 */
  x: number;
  y: number;
  /** 是否发生过碰撞 */
  collided: boolean;
  /** 累计的接触法线（可能同时撞多个，已归一化） */
  nx: number;
  ny: number;
  /** 撞到的碰撞体 id */
  hits: number[];
}

/**
 * 带滑动的移动解算（核心 API）
 *
 * 【算法】
 * 1. sweep 求最早命中时刻 t
 * 2. 移动到撞击点（留一点 skin 间隙）
 * 3. 把剩余位移**投影到墙面切线**（滑动）
 * 4. 重复，直到位移用完或迭代上限
 *
 * 【⚠️ 三个必须注意的点】
 *
 * 1. **skin（皮肤厚度）**
 *    分离后必须留一点间隙，否则下一帧浮点误差又判为重叠，
 *    角色会在墙上高频抖动。典型值 0.01~0.1。
 *
 * 2. **迭代上限**
 *    内角（两面墙夹角）会让剩余位移反复被投影，理论上永不收敛。
 *    不设上限的话会死循环——这是"游戏偶尔卡死一下"的常见原因。
 *
 * 3. **投影后要检查剩余量**
 *    剩余位移小于 epsilon 就停，否则会为了 1e-9 的位移白跑一轮。
 */
export function moveAndSlide(
  x: number, y: number, r: number,
  dx: number, dy: number,
  solids: readonly Collider[],
  opts: {
    /** 皮肤厚度 */
    skin?: number;
    /** 最大迭代次数 */
    maxIterations?: number;
    /** 层过滤 */
    layer?: number;
    mask?: number;
  } = {}
): MoveResult {
  const skin = opts.skin ?? 0.01;
  const maxIter = opts.maxIterations ?? 4;

  let px = x;
  let py = y;
  let rdx = dx;
  let rdy = dy;
  let collided = false;
  let nx = 0;
  let ny = 0;
  const hits: number[] = [];

  for (let iter = 0; iter < maxIter; iter++) {
    const stepLen = Math.sqrt(rdx * rdx + rdy * rdy);
    // 【⚠️ 剩余位移太小就停】
    // 不为这个设阈值的话，浮点尾数会让循环永远跑满 maxIter 次。
    if (stepLen < 1e-6) break;

    // 找最早命中
    let bestT = 1;
    let bestNX = 0;
    let bestNY = 0;
    let bestId = -1;

    for (const c of solids) {
      if (c.trigger) continue;
      if (opts.layer !== undefined && (c.mask & opts.layer) === 0) continue;
      if (opts.mask !== undefined && (c.layer & opts.mask) === 0) continue;

      const s = c.shape;
      let sw: SweepResult;
      if (s.kind === 'aabb') {
        sw = sweepCircleAabb(px, py, r, rdx, rdy, s);
      } else if (s.kind === 'circle') {
        // 圆 vs 圆 → 半径相加后当点 vs 圆处理（用膨胀 AABB 近似）
        const inflated: AabbShape = {
          kind: 'aabb', x: s.x, y: s.y, hw: s.r, hh: s.r,
        };
        sw = sweepCircleAabb(px, py, r, rdx, rdy, inflated);
      } else {
        // 其余形状用包围盒粗筛 + SAT 精筛
        const br = boundingRadius(s);
        const sc = shapeCenter(s);
        const coarse: AabbShape = { kind: 'aabb', x: sc.x, y: sc.y, hw: br, hh: br };
        const coarseSw = sweepCircleAabb(px, py, r, rdx, rdy, coarse);
        if (!coarseSw.hit) continue;
        // 在命中点做一次静态重叠检测确认
        const hx = px + rdx * coarseSw.t;
        const hy = py + rdy * coarseSw.t;
        const polyA = toPolygon(circle(hx, hy, r));
        const polyB = toPolygon(s);
        // SAT 需要同一坐标系：这里直接用局部坐标近似
        if (!satOverlap(polyA, polyB).overlap) continue;
        sw = coarseSw;
      }

      if (sw.hit && sw.t < bestT) {
        bestT = sw.t;
        bestNX = sw.nx;
        bestNY = sw.ny;
        bestId = c.id;
      }
    }

    if (bestId < 0) {
      // 无碰撞，走完剩余位移
      px += rdx;
      py += rdy;
      break;
    }

    collided = true;
    hits.push(bestId);
    nx += bestNX;
    ny += bestNY;

    // 移动到撞击点，留 skin 间隙
    const move = Math.max(0, bestT - skin / Math.max(stepLen, 1e-9));
    px += rdx * move;
    py += rdy * move;

    // 【核心：把剩余位移投影到墙面切线】
    // v' = v - n * (v · n)
    // 这就是"沿墙滑动"——玩家斜着推摇杆时，角色会贴着墙走，
    // 而不是像撞到隐形墙一样停住。
    const remainX = rdx * (1 - bestT);
    const remainY = rdy * (1 - bestT);
    const dot = remainX * bestNX + remainY * bestNY;
    rdx = remainX - bestNX * dot;
    rdy = remainY - bestNY * dot;
  }

  // 归一化累计法线
  if (collided) {
    const nl = Math.sqrt(nx * nx + ny * ny);
    if (nl > 1e-9) {
      nx /= nl;
      ny /= nl;
    }
  }

  return { x: px, y: py, collided, nx, ny, hits };
}

/**
 * 静态分离（把已经重叠的物体推开）
 *
 * 【什么时候需要】
 * 关卡加载后可能有配置错误的重叠；
 * 或者用瞬移（传送）把角色放进墙里。
 * moveAndSlide 只保证"移动时不穿"，不修已存在的重叠。
 */
export function separate(
  x: number, y: number, r: number,
  solids: readonly Collider[],
  opts: { skin?: number; maxIterations?: number; layer?: number; mask?: number } = {}
): { x: number; y: number; moved: boolean } {
  const skin = opts.skin ?? 0.01;
  const maxIter = opts.maxIterations ?? 4;
  let px = x;
  let py = y;
  let moved = false;

  for (let iter = 0; iter < maxIter; iter++) {
    let deepest = 0;
    let pushX = 0;
    let pushY = 0;

    for (const c of solids) {
      if (c.trigger) continue;
      if (opts.layer !== undefined && (c.mask & opts.layer) === 0) continue;
      if (opts.mask !== undefined && (c.layer & opts.mask) === 0) continue;

      const s = c.shape;
      // 【⚠️ 只处理有解析解的两种形状，其余用包围圆近似】
      // 精确解需要为每种形状对实现专门的 MTV，代码量翻几倍，
      // 而包围圆近似在"把角色从墙里挤出来"这个场景下完全够用。
      let nx = 0;
      let ny = 0;
      let depth = 0;

      if (s.kind === 'aabb') {
        const cx = clamp(px, s.x - s.hw, s.x + s.hw);
        const cy = clamp(py, s.y - s.hh, s.y + s.hh);
        let ddx = px - cx;
        let ddy = py - cy;
        let dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist >= r) continue;
        if (dist < 1e-9) {
          // 圆心正好在矩形内：推向最近的边
          const dl = px - (s.x - s.hw);
          const dr = s.x + s.hw - px;
          const dd = py - (s.y - s.hh);
          const du = s.y + s.hh - py;
          const m = Math.min(dl, dr, dd, du);
          if (m === dl) { nx = -1; ny = 0; depth = dl + r; }
          else if (m === dr) { nx = 1; ny = 0; depth = dr + r; }
          else if (m === dd) { nx = 0; ny = -1; depth = dd + r; }
          else { nx = 0; ny = 1; depth = du + r; }
        } else {
          nx = ddx / dist;
          ny = ddy / dist;
          depth = r - dist;
        }
      } else if (s.kind === 'circle') {
        const ddx = px - s.x;
        const ddy = py - s.y;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        const rr = r + s.r;
        if (dist >= rr) continue;
        if (dist < 1e-9) { nx = 1; ny = 0; depth = rr; }
        else { nx = ddx / dist; ny = ddy / dist; depth = rr - dist; }
      } else {
        const sc = shapeCenter(s);
        const br = boundingRadius(s);
        const ddx = px - sc.x;
        const ddy = py - sc.y;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        const rr = r + br;
        if (dist >= rr) continue;
        if (dist < 1e-9) { nx = 1; ny = 0; depth = rr; }
        else { nx = ddx / dist; ny = ddy / dist; depth = rr - dist; }
      }

      // 【⚠️ 取最深的那个推，不是累加所有】
      // 累加的话，同时贴两面墙会被推两倍距离，直接弹飞。
      if (depth > deepest) {
        deepest = depth;
        pushX = nx * (depth + skin);
        pushY = ny * (depth + skin);
      }
    }

    if (deepest <= 0) break;
    px += pushX;
    py += pushY;
    moved = true;
  }

  return { x: px, y: py, moved };
}

// ==================== 射线投射 ====================

export interface RaycastHit {
  hit: boolean;
  /** 命中距离（沿射线方向） */
  t: number;
  x: number;
  y: number;
  nx: number;
  ny: number;
  colliderId: number;
}

const _rayMiss: RaycastHit = { hit: false, t: Infinity, x: 0, y: 0, nx: 0, ny: 0, colliderId: -1 };

/**
 * 射线 vs AABB（slab 方法）
 *
 * 用途：瞄准辅助、视线检测、子弹命中预判、点击拾取。
 */
export function raycastAabb(
  ox: number, oy: number, dx: number, dy: number,
  b: AabbShape
): RaycastHit {
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis = 0;
  let sign = 0;

  if (Math.abs(dx) < 1e-12) {
    if (ox < b.x - b.hw || ox > b.x + b.hw) return _rayMiss;
  } else {
    const inv = 1 / dx;
    let t1 = (b.x - b.hw - ox) * inv;
    let t2 = (b.x + b.hw - ox) * inv;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 0; sign = s; }
    if (t2 < tmax) tmax = t2;
  }

  if (Math.abs(dy) < 1e-12) {
    if (oy < b.y - b.hh || oy > b.y + b.hh) return _rayMiss;
  } else {
    const inv = 1 / dy;
    let t1 = (b.y - b.hh - oy) * inv;
    let t2 = (b.y + b.hh - oy) * inv;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
    if (t2 < tmax) tmax = t2;
  }

  if (tmax < tmin || tmax < 0 || tmin < 0) return _rayMiss;

  return {
    hit: true,
    t: tmin,
    x: ox + dx * tmin,
    y: oy + dy * tmin,
    nx: axis === 0 ? sign : 0,
    ny: axis === 1 ? sign : 0,
    colliderId: -1,
  };
}

/**
 * 射线 vs 圆（解二次方程）
 *
 * 【⚠️ 判别式 < 0 不是 bug】
 * 那只是"没打中"。早年见过有人在这里 throw，
 * 于是瞄准辅助线扫到空处就崩。
 */
export function raycastCircle(
  ox: number, oy: number, dx: number, dy: number,
  c: CircleShape
): RaycastHit {
  const mx = ox - c.x;
  const my = oy - c.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (mx * dx + my * dy);
  const cc = mx * mx + my * my - c.r * c.r;

  const disc = b * b - 4 * a * cc;
  if (disc < 0) return _rayMiss;

  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);

  // 取最近的正根；起点在圆内时 t1 < 0，用 t2
  const t = t1 >= 0 ? t1 : t2;
  if (t < 0) return _rayMiss;

  const hx = ox + dx * t;
  const hy = oy + dy * t;
  const nlx = hx - c.x;
  const nly = hy - c.y;
  const nl = Math.sqrt(nlx * nlx + nly * nly) || 1;

  return {
    hit: true,
    t,
    x: hx,
    y: hy,
    nx: nlx / nl,
    ny: nly / nl,
    colliderId: -1,
  };
}

/** 射线 vs 碰撞体数组，返回最近命中 */
export function raycast(
  ox: number, oy: number, dx: number, dy: number,
  solids: readonly Collider[],
  maxDist = Infinity,
  filter?: (c: Collider) => boolean
): RaycastHit {
  let best: RaycastHit = _rayMiss;

  for (const c of solids) {
    if (filter && !filter(c)) continue;
    const s = c.shape;
    let h: RaycastHit;
    if (s.kind === 'aabb') {
      h = raycastAabb(ox, oy, dx, dy, s);
    } else if (s.kind === 'circle') {
      h = raycastCircle(ox, oy, dx, dy, s);
    } else {
      // 其余用包围圆近似（保守：可能误报，适合作为粗筛）
      const sc = shapeCenter(s);
      h = raycastCircle(ox, oy, dx, dy, {
        kind: 'circle', x: sc.x, y: sc.y, r: boundingRadius(s),
      });
    }
    if (h.hit && h.t < best.t && h.t <= maxDist) {
      best = { ...h, colliderId: c.id };
    }
  }

  return best;
}

// ==================== 诊断 ====================

/** 形状的人类可读描述（调试用） */
export function describeShape(s: AnyShape): string {
  switch (s.kind) {
    case 'circle': return `circle(${s.x}, ${s.y}, r=${s.r})`;
    case 'aabb': return `aabb(${s.x}, ${s.y}, ${s.hw * 2}×${s.hh * 2})`;
    case 'obb': return `obb(${s.x}, ${s.y}, ${s.hw * 2}×${s.hh * 2}, ${(s.rot * 180 / Math.PI).toFixed(0)}°)`;
    case 'capsule': return `capsule((${s.x0},${s.y0})-(${s.x1},${s.y1}), r=${s.r})`;
    case 'polygon': return `polygon(${s.x}, ${s.y}, ${s.pts.length / 2} 顶点)`;
  }
}
