/**
 * Hitbox —— 判定形状与重叠检测
 *
 * 【它解决什么】
 *
 * 「这一刀砍到了谁」是动作游戏最核心的判定。
 * 但它不该认识「敌人」——同一个判定系统要能用于：
 * 玩家砍怪、怪撞玩家、子弹命中、AOE 选取、拾取范围、陷阱触发、视线遮挡。
 *
 * 所以这里只有三样东西：**形状、变换、层**。
 *
 * 【零业务依赖】
 * 没有 Enemy / Player / Damage。命中返回的是 `Hitbox` 本身，
 * 它的 `data` 字段由调用方塞入（通常指向你的实体），检测逻辑不解释它。
 *
 * 【四种形状】
 * | 形状 | 参数 | 典型用途 |
 * |---|---|---|
 * | `circle` | radius | 子弹、爆炸、拾取范围 |
 * | `rect` | halfW / halfH | 剑气矩形、平台 |
 * | `sector` | radius + angleDeg | **扇形挥砍**（近战最常用） |
 * | `capsule` | radius + height | 角色体积、激光 |
 *
 * 【检测精度说明（重要）】
 *
 * | 组合 | 精度 |
 * |---|---|
 * | circle × 任意 | **精确** |
 * | rect × rect | **精确**（OBB SAT） |
 * | capsule × rect/capsule | **精确** |
 * | **sector × rect/capsule/sector** | **近似**（采样点） |
 *
 * 扇形参与的复杂组合用采样是因为 SAT 处理不了弧形边，
 * 而精确解（圆弧与多边形求交）的复杂度收益比太低。
 * 实际游戏里扇形几乎总是**攻击方**，目标是圆/矩形/胶囊——那些组合是精确的。
 *
 * 【使用示例】
 * ```typescript
 * const world = new HitboxWorld();
 *
 * // 敌人受击框（圆形）
 * world.add({ id: 'bat#1', shape: { kind: 'circle', radius: 0.5 },
 *             x: 3, y: 0, layer: LAYER_ENEMY, data: batEntity });
 *
 * // 玩家挥砍（扇形）
 * const sword: Shape = { kind: 'sector', radius: 2, angleDeg: 100 };
 * const hits = world.query(sword, px, py, facingDeg, MASK_HIT_ENEMY);
 * for (const h of hits) {
 *   pipeline.apply({ raw: atk, hitId: `${swingId}:${h.id}` }, h.data as IDamageable);
 * }
 * ```
 */

import { clamp } from '../_core/math';

// ── 形状 ──

export type ShapeKind = 'circle' | 'rect' | 'sector' | 'capsule';

/** 形状定义（**局部坐标**，原点在形状中心/圆心） */
export interface Shape {
  kind: ShapeKind;

  /** circle / sector / capsule：半径 */
  radius?: number;
  /** rect：半宽（全宽的一半） */
  halfW?: number;
  /** rect：半高 */
  halfH?: number;
  /** sector：扇形张角（度），如 100 表示左右各 50 */
  angleDeg?: number;
  /** capsule：两端圆心之间的距离（不含两端半径） */
  height?: number;

  /**
   * 形状中心相对实体原点的偏移
   *
   * 【为什么需要】
   * 角色原点通常在脚底，但受击框中心在身体中部。
   * 这个偏移会跟随 `rotation` 一起旋转。
   */
  offsetX?: number;
  offsetY?: number;
}

// ── 判定框 ──

/**
 * 判定框实例
 *
 * 【layer / mask 语义】
 * - `layer`：我属于哪一层（位掩码，如 `1 << 2`）
 * - `mask`：我要检测哪些层
 *
 * 命中条件：**单向** `( attackerMask & targetLayer ) !== 0`
 *
 * 为什么是单向：受击框通常只声明 `layer` 而不关心 `mask`。
 * 双向检查会让「只声明 layer 的受击框」永远打不到。
 */
export interface Hitbox {
  /** 唯一 id（同一实体多个判定框时用于区分） */
  id: string;
  shape: Shape;
  /** 世界坐标 X */
  x: number;
  /** 世界坐标 Y */
  y: number;
  /**
   * 朝向（**度**）
   *
   * 【为什么用度不用弧度】
   * 策划在配置表里写 90 比写 1.5708 直观；
   * 美术标注动画关键帧也用度。弧度容易写错一个数量级。
   */
  rotation: number;
  /** 我属于哪层 */
  layer: number;
  /** 我要检测哪些层 */
  mask: number;
  /** 禁用后不参与检测（比反复 add/remove 便宜） */
  enabled?: boolean;
  /**
   * 附加数据——检测命中时原样带回
   *
   * 通常塞你的实体对象。这里是 `unknown`，
   * 因为 Hitbox 不该知道它装的是什么（否则就不可复用了）。
   */
  data?: unknown;
}

/** 查询结果 */
export interface HitResult {
  hitbox: Hitbox;
  /** 命中点到查询形状中心的距离（排序用：谁更近） */
  distance: number;
}

// ── 几何辅助 ──

/** 把局部偏移按朝向旋转到世界坐标 */
function rotateOffset(
  ox: number,
  oy: number,
  deg: number,
  out: { x: number; y: number },
): void {
  if (deg === 0) {
    out.x = ox;
    out.y = oy;
    return;
  }
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  out.x = ox * c - oy * s;
  out.y = ox * s + oy * c;
}

const _off = { x: 0, y: 0 };

/**
 * 把形状的 offset 按朝向旋转后，算出形状的**真实中心**
 *
 * 【为什么需要单独一个函数】
 * 攻击方（查询形状）和受击方（判定框）都用 offset，
 * 但查询形状不是 `Hitbox`，没法走 `hitboxCenter`。
 *
 * offset 是**局部坐标**，会跟随 rotation 一起转：
 * 剑气的 `offsetX: 2` 在朝右时是 +X 2 米，朝上时是 +Y 2 米。
 *
 * 【两种用法】
 * ```typescript
 * const c = applyShapeOffset(s, x, y, rot);   // 返回新对象（方便）
 * applyShapeOffset(s, x, y, rot, reused);     // 写入已有对象（每帧不产生垃圾）
 * ```
 */
export function applyShapeOffset(
  s: Shape,
  x: number,
  y: number,
  rotDeg: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const ox = s.offsetX ?? 0;
  const oy = s.offsetY ?? 0;
  rotateOffset(ox, oy, rotDeg, _off);
  out.x = x + _off.x;
  out.y = y + _off.y;
  return out;
}

/**
 * 判定框在世界空间的真实中心（含偏移与旋转）
 *
 * 【两种用法】
 * ```typescript
 * const c = hitboxCenter(b);            // 返回新对象（方便）
 * hitboxCenter(b, reused);              // 写入已有对象（每帧调用不产生垃圾）
 * ```
 * 传不传 `out` 都**返回**结果，所以第一种写法是合法的。
 */
export function hitboxCenter(
  b: Hitbox,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  return applyShapeOffset(b.shape, b.x, b.y, b.rotation, out);
}

/**
 * 形状的包围圆半径（快速排除用）
 *
 * 【必须加上 offset 的距离】
 * 曾经没算 offset，导致带偏移的形状（如剑气 `offsetX: 2`）
 * 在快速排除阶段就被判掉——表现为"剑明明伸出去很远却打不到人"。
 */
export function boundingRadius(s: Shape): number {
  let r: number;
  switch (s.kind) {
    case 'circle':
    case 'sector':
      r = s.radius ?? 0;
      break;
    case 'rect':
      r = Math.hypot(s.halfW ?? 0, s.halfH ?? 0);
      break;
    case 'capsule':
      r = (s.height ?? 0) / 2 + (s.radius ?? 0);
      break;
    default:
      r = 0;
  }
  return r + Math.hypot(s.offsetX ?? 0, s.offsetY ?? 0);
}

/** 采样：把形状离散成一组测试点（用于 sector 参与的近似检测） */
export function samplePoints(
  s: Shape,
  cx: number,
  cy: number,
  rotDeg: number,
  out: Array<{ x: number; y: number }> = [],
): Array<{ x: number; y: number }> {
  out.length = 0;
  const pushLocal = (lx: number, ly: number) => {
    rotateOffset(lx, ly, rotDeg, _off);
    out.push({ x: cx + _off.x, y: cy + _off.y });
  };

  switch (s.kind) {
    case 'circle':
      pushLocal(0, 0);
      break;

    case 'rect': {
      const hw = s.halfW ?? 0;
      const hh = s.halfH ?? 0;
      // 四角 + 四边中点 + 中心
      pushLocal(-hw, -hh); pushLocal(hw, -hh);
      pushLocal(hw, hh);   pushLocal(-hw, hh);
      pushLocal(0, -hh);   pushLocal(0, hh);
      pushLocal(-hw, 0);   pushLocal(hw, 0);
      pushLocal(0, 0);
      break;
    }

    case 'sector': {
      const r = s.radius ?? 0;
      const half = ((s.angleDeg ?? 90) / 2) * (Math.PI / 180);
      pushLocal(0, 0);
      // 弧上采样（含两端点）
      const N = 8;
      for (let i = 0; i <= N; i++) {
        const a = -half + (2 * half * i) / N;
        // 局部坐标：0° 朝 +X
        pushLocal(Math.cos(a) * r, Math.sin(a) * r);
      }
      // 径向中点，避免只测到边缘漏掉内部薄物体
      for (let i = 1; i < N; i++) {
        const a = -half + (2 * half * i) / N;
        pushLocal(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
      }
      break;
    }

    case 'capsule': {
      const h = (s.height ?? 0) / 2;
      const N = 6;
      for (let i = 0; i <= N; i++) {
        pushLocal(-h + (2 * h * i) / N, 0);
      }
      break;
    }
  }
  return out;
}

// ── 点是否在形状内 ──

/** 点是否落在形状内（形状带位置与朝向） */
export function containsPoint(
  s: Shape,
  cx: number,
  cy: number,
  rotDeg: number,
  px: number,
  py: number,
): boolean {
  // 转到形状局部坐标
  rotateOffset(px - cx, py - cy, -rotDeg, _off);
  const lx = _off.x;
  const ly = _off.y;

  switch (s.kind) {
    case 'circle':
      return lx * lx + ly * ly <= (s.radius ?? 0) ** 2;

    case 'rect': {
      const hw = s.halfW ?? 0;
      const hh = s.halfH ?? 0;
      return lx >= -hw && lx <= hw && ly >= -hh && ly <= hh;
    }

    case 'sector': {
      const r = s.radius ?? 0;
      const d2 = lx * lx + ly * ly;
      if (d2 > r * r) return false;
      if (d2 < 1e-12) return true; // 圆心，角度无意义
      const half = (s.angleDeg ?? 90) / 2;
      let a = (Math.atan2(ly, lx) * 180) / Math.PI;
      // 归一化到 [-180, 180]
      while (a > 180) a -= 360;
      while (a < -180) a += 360;
      return Math.abs(a) <= half;
    }

    case 'capsule': {
      const h = (s.height ?? 0) / 2;
      const rad = s.radius ?? 0;
      // 沿局部 X 轴的线段 [-h, h]
      const clampedX = clamp(lx, -h, h);
      const dx = lx - clampedX;
      return dx * dx + ly * ly <= rad * rad;
    }

    default:
      return false;
  }
}

// ── 两两检测 ──

function circleCircle(
  ax: number, ay: number, ar: number,
  bx: number, by: number, br: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const rr = ar + br;
  return dx * dx + dy * dy <= rr * rr;
}

/** 圆 vs 矩形（矩形带旋转） */
function circleRect(
  cx: number, cy: number, cr: number,
  rx: number, ry: number, hw: number, hh: number, rotDeg: number,
): boolean {
  rotateOffset(cx - rx, cy - ry, -rotDeg, _off);
  const lx = clamp(_off.x, -hw, hw);
  const ly = clamp(_off.y, -hh, hh);
  const dx = _off.x - lx;
  const dy = _off.y - ly;
  return dx * dx + dy * dy <= cr * cr;
}

/** 圆 vs 胶囊 */
function circleCapsule(
  cx: number, cy: number, cr: number,
  ax: number, ay: number, halfH: number, ar: number, rotDeg: number,
): boolean {
  // 胶囊轴线段端点（局部 X 轴）
  rotateOffset(-halfH, 0, rotDeg, _off);
  const x1 = ax + _off.x, y1 = ay + _off.y;
  rotateOffset(halfH, 0, rotDeg, _off);
  const x2 = ax + _off.x, y2 = ay + _off.y;

  // 点到线段距离
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-12 ? ((cx - x1) * dx + (cy - y1) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const px = x1 + dx * t, py = y1 + dy * t;
  const ex = cx - px, ey = cy - py;
  const rr = cr + ar;
  return ex * ex + ey * ey <= rr * rr;
}

/** OBB vs OBB —— 分离轴定理（精确） */
function rectRectSAT(
  ax: number, ay: number, ahw: number, ahh: number, aDeg: number,
  bx: number, by: number, bhw: number, bhh: number, bDeg: number,
): boolean {
  const ar = (aDeg * Math.PI) / 180;
  const br = (bDeg * Math.PI) / 180;
  const ac = Math.cos(ar), as = Math.sin(ar);
  const bc = Math.cos(br), bs = Math.sin(br);

  // 各自的轴（局部 X / Y 转到世界）
  const axes = [
    { x: ac, y: as }, { x: -as, y: ac },
    { x: bc, y: bs }, { x: -bs, y: bc },
  ];

  const dx = bx - ax;
  const dy = by - ay;

  // 投影半径
  const projRadius = (hw: number, hh: number, ux: number, uy: number, c: number, s: number) =>
    Math.abs(hw * (ux * c + uy * s)) + Math.abs(hh * (-ux * s + uy * c));

  for (const axis of axes) {
    const ra = Math.abs(ahw * (axis.x * ac + axis.y * as)) + Math.abs(ahh * (-axis.x * as + axis.y * ac));
    const rb = projRadius(bhw, bhh, axis.x, axis.y, bc, bs);
    const dist = Math.abs(dx * axis.x + dy * axis.y);
    if (dist > ra + rb) return false;   // 找到分离轴
  }
  return true;
}

const _pts: Array<{ x: number; y: number }> = [];

/** 采样法：任一方的采样点落在另一方内即算重叠 */
function sampleOverlap(
  a: Shape, ax: number, ay: number, aRot: number,
  b: Shape, bx: number, by: number, bRot: number,
): boolean {
  samplePoints(a, ax, ay, aRot, _pts);
  for (const p of _pts) {
    if (containsPoint(b, bx, by, bRot, p.x, p.y)) return true;
  }
  samplePoints(b, bx, by, bRot, _pts);
  for (const p of _pts) {
    if (containsPoint(a, ax, ay, aRot, p.x, p.y)) return true;
  }
  return false;
}

/**
 * 两个形状是否重叠
 *
 * @param a 第一个形状（世界坐标 + 朝向）
 * @param b 第二个形状
 */
export function shapesOverlap(
  a: Shape, ax: number, ay: number, aRot: number,
  b: Shape, bx: number, by: number, bRot: number,
): boolean {
  // 包围圆快速排除
  const ra = boundingRadius(a);
  const rb = boundingRadius(b);
  const dx = bx - ax;
  const dy = by - ay;
  const rr = ra + rb;
  if (dx * dx + dy * dy > rr * rr) return false;

  const pair = a.kind <= b.kind ? `${a.kind}|${b.kind}` : `${b.kind}|${a.kind}`;
  // 统一让「圆」在前，简化分支
  const swap = a.kind !== 'circle' && b.kind === 'circle';
  const A = swap ? b : a;
  const B = swap ? a : b;
  const Ax = swap ? bx : ax, Ay = swap ? by : ay, ARot = swap ? bRot : aRot;
  const Bx = swap ? ax : bx, By = swap ? ay : by, BRot = swap ? aRot : bRot;

  switch (pair) {
    case 'circle|circle':
      return circleCircle(Ax, Ay, A.radius ?? 0, Bx, By, B.radius ?? 0);

    case 'circle|rect':
      return circleRect(Ax, Ay, A.radius ?? 0, Bx, By, B.halfW ?? 0, B.halfH ?? 0, BRot);

    case 'capsule|circle':
      return circleCapsule(Ax, Ay, A.radius ?? 0, Bx, By, (B.height ?? 0) / 2, B.radius ?? 0, BRot);

    case 'rect|rect':
      return rectRectSAT(Ax, Ay, A.halfW ?? 0, A.halfH ?? 0, ARot, Bx, By, B.halfW ?? 0, B.halfH ?? 0, BRot);

    case 'capsule|capsule':
    case 'capsule|rect':
    case 'capsule|sector':
    case 'rect|sector':
    case 'sector|sector':
      return sampleOverlap(A, Ax, Ay, ARot, B, Bx, By, BRot);

    case 'circle|sector':
      // 圆 vs 扇形有精确解，但为了统一走采样（扇形采样点足够密）
      return sampleOverlap(A, Ax, Ay, ARot, B, Bx, By, BRot);

    default:
      return sampleOverlap(A, Ax, Ay, ARot, B, Bx, By, BRot);
  }
}

// ── 世界 ──

export interface HitboxWorldOptions {
  /**
   * 空间哈希格子大小
   *
   * 【怎么选】约等于**典型判定框直径的 2~4 倍**。
   * 太小 → 一个框跨多格，更新成本高；
   * 太大 → 一格几百个框，退化成线性扫描。
   */
  cellSize?: number;
}

/**
 * 判定框世界
 *
 * 【为什么不用数组线性扫描】
 * 200 个敌人 × 每次挥砍都遍历 = 200 次距离计算，
 * 同屏 20 个玩家技能就是 4000 次。空间哈希把范围外的先排掉。
 *
 * 【注意】元素少于 50 时，线性扫描反而更快（哈希有常数开销）。
 */
export class HitboxWorld {
  private _boxes = new Map<string, Hitbox>();
  private _cells = new Map<number, Set<string>>();
  private _cellSize: number;

  constructor(opts: HitboxWorldOptions = {}) {
    this._cellSize = opts.cellSize ?? 4;
  }

  /** 空间哈希 key（支持负坐标） */
  private _key(cx: number, cy: number): number {
    // Cantor 配对的变体：把 (x,y) 映射到唯一整数
    const a = cx >= 0 ? cx * 2 : -cx * 2 - 1;
    const b = cy >= 0 ? cy * 2 : -cy * 2 - 1;
    return ((a + b) * (a + b + 1)) / 2 + b;
  }

  private _cellsFor(x: number, y: number, r: number): number[] {
    const s = this._cellSize;
    const x0 = Math.floor((x - r) / s);
    const x1 = Math.floor((x + r) / s);
    const y0 = Math.floor((y - r) / s);
    const y1 = Math.floor((y + r) / s);
    const out: number[] = [];
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) out.push(this._key(cx, cy));
    }
    return out;
  }

  /**
   * 添加判定框
   * @returns 移除函数
   */
  add(box: Hitbox): () => void {
    if (box.enabled === undefined) box.enabled = true;

    /**
     * 【⚠️ rotation 缺失必须补全为 0，否则整个判定框静默失效】
     *
     * `rotation` 在接口里是必填的，TS 调用方不会漏。
     * 但从 JSON / JS 侧构造时容易缺这个字段，后果很隐蔽：
     *
     * `hitboxCenter` → `applyShapeOffset` → `rotateOffset(0, 0, undefined, out)`
     * 里 `deg === 0` 对 undefined 为 false，于是走弧度分支
     * `Math.cos((undefined * PI) / 180)` = **NaN**
     * → 判定框的世界中心变成 (NaN, NaN)
     * → `shapesOverlap` 里所有距离比较恒为 false
     * → **这个判定框永远命中不了任何东西，也不报错**
     *
     * 实测（补全前）：`add({id, shape, x:0, y:0, layer:1})`（缺 rotation）
     * 后 `hitboxCenter(b)` 返回 `{x: NaN, y: NaN}`。
     *
     * 【为什么补全为 0 而不是抛错】
     * "没有朝向"的自然含义就是 0 度，与 `enabled` 的默认处理一致。
     * 抛错会让合法的简写写法（`{id, shape, x, y, layer}`）无法使用。
     */
    if (!Number.isFinite(box.rotation)) box.rotation = 0;

    this._boxes.set(box.id, box);
    this._insert(box);
    return () => this.remove(box.id);
  }

  /** 移除 */
  remove(id: string): boolean {
    const b = this._boxes.get(id);
    if (!b) return false;
    for (const k of this._cellsFor(b.x, b.y, boundingRadius(b.shape))) {
      const set = this._cells.get(k);
      if (set) {
        set.delete(id);
        if (set.size === 0) this._cells.delete(k);
      }
    }
    this._boxes.delete(id);
    return true;
  }

  /** 更新位置（比 remove+add 便宜） */
  update(id: string, x: number, y: number, rotation?: number): void {
    const b = this._boxes.get(id);
    if (!b) return;

    /**
     * 【⚠️ 必须比较"覆盖的格子集合"，不能只比中心点所在格】
     *
     * 老实现只比中心点：
     * ```ts
     * const sameCell =
     *   Math.floor(b.x / cellSize) === Math.floor(x / cellSize) &&
     *   Math.floor(b.y / cellSize) === Math.floor(y / cellSize);
     * ```
     * 对**跨格的大判定框**（Boss 的大范围 AOE、细长的剑气）这是错的：
     * 中心点还在原来那一格，但形状的边缘已经伸进新格子了，
     * 索引却没更新 → 新格子里的目标**永远查不到它**。
     *
     * 实测（修复前）：cellSize=4、半径 3 的圆在 (0,0)，
     * `update(id, 3.9, 0)`（中心格没变）后 `query(圆 r=0.5, 5, 0)` → **0 命中**；
     * 而同样的位置用 remove+add 重建索引 → 1 命中。
     * 距离 1.1 < 半径和 3.5，本该命中。
     *
     * 表现为"大招打不到边缘的怪"——间歇性、与体型相关，
     * 是那种最难归因的战斗 bug。
     *
     * 【性能考虑】
     * 这里要算两次 `_cellsFor`（各一次数组分配）。
     * 但它只是整数运算，远低于走一遍 remove+insert 的 Map 操作，
     * "比 remove+add 便宜"这条设计意图仍然成立。
     *
     * 【为什么能逐一比对】`_cellsFor` 用固定的嵌套 for 循环顺序输出，
     * 同样的 (x, y, r) 一定得到同样的顺序，所以可以直接按下标比较。
     */
    const r = boundingRadius(b.shape);
    const oldCells = this._cellsFor(b.x, b.y, r);
    const newCells = this._cellsFor(x, y, r);
    let same = oldCells.length === newCells.length;
    if (same) {
      for (let i = 0; i < oldCells.length; i++) {
        if (oldCells[i] !== newCells[i]) {
          same = false;
          break;
        }
      }
    }

    if (!same) {
      for (const k of oldCells) {
        const set = this._cells.get(k);
        if (set) {
          set.delete(id);
          if (set.size === 0) this._cells.delete(k);
        }
      }
      b.x = x;
      b.y = y;
      if (rotation !== undefined) b.rotation = rotation;
      this._insert(b);
      return;
    }
    b.x = x;
    b.y = y;
    if (rotation !== undefined) b.rotation = rotation;
  }

  /** 启用 / 禁用 */
  setEnabled(id: string, enabled: boolean): void {
    const b = this._boxes.get(id);
    if (b) b.enabled = enabled;
  }

  /** 取判定框 */
  get(id: string): Hitbox | undefined {
    return this._boxes.get(id);
  }

  /** 数量 */
  get count(): number {
    return this._boxes.size;
  }

  private _insert(b: Hitbox): void {
    for (const k of this._cellsFor(b.x, b.y, boundingRadius(b.shape))) {
      let set = this._cells.get(k);
      if (!set) {
        set = new Set();
        this._cells.set(k, set);
      }
      set.add(b.id);
    }
  }

  /**
   * 查询：给定形状与掩码，返回所有命中的判定框
   *
   * 【命中条件】单向 `( mask & target.layer ) !== 0`
   *
   * @param shape 查询形状（攻击范围）
   * @param x 查询中心 X
   * @param y 查询中心 Y
   * @param rotation 查询朝向（度）
   * @param mask 要命中的层
   * @param out 复用数组（避免每帧分配）
   */
  query(
    shape: Shape,
    x: number,
    y: number,
    rotation: number,
    mask: number,
    out: HitResult[] = [],
  ): HitResult[] {
    out.length = 0;
    const r = boundingRadius(shape);

    // 【查询形状也要应用 offset】
    // 否则 `rect(halfW: 2, offsetX: 2)` 这种"从身前伸出去"的剑气，
    // 判定会建立在施法者脚下而不是前方——表现为"打不到身前的怪"。
    applyShapeOffset(shape, x, y, rotation, _qcenter);
    const qx = _qcenter.x;
    const qy = _qcenter.y;

    const seen = new Set<string>();

    for (const k of this._cellsFor(qx, qy, r)) {
      const set = this._cells.get(k);
      if (!set) continue;
      for (const id of set) {
        if (seen.has(id)) continue;   // 跨格的框会重复出现
        seen.add(id);

        const b = this._boxes.get(id);
        if (!b || b.enabled === false) continue;
        if ((mask & b.layer) === 0) continue;

        hitboxCenter(b, _center);
        if (
          shapesOverlap(
            shape, qx, qy, rotation,
            b.shape, _center.x, _center.y, b.rotation,
          )
        ) {
          const dx = _center.x - qx;
          const dy = _center.y - qy;
          out.push({ hitbox: b, distance: Math.hypot(dx, dy) });
        }
      }
    }

    out.sort((p, q) => p.distance - q.distance);
    return out;
  }

  /**
   * 两点之间是否被挡住（视线 / 弹道遮挡）
   *
   * 用一个细胶囊近似线段，比逐点采样便宜且不会穿薄墙。
   */
  lineOfSightBlocked(
    x0: number, y0: number, x1: number, y1: number,
    mask: number,
  ): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return false;

    const seg: Shape = { kind: 'capsule', height: len, radius: 0.01 };
    const rotDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    return this.query(seg, cx, cy, rotDeg, mask).length > 0;
  }

  /** 清空 */
  clear(): void {
    this._boxes.clear();
    this._cells.clear();
  }

  destroy(): void {
    this.clear();
  }
}

const _center = { x: 0, y: 0 };
const _qcenter = { x: 0, y: 0 };

// ── 便利工具 ──

/** 构造圆形 */
/**
 * ==================== 与 collision 同时使用的别名 ====================
 *
 * 【为什么需要】
 * 本模块（攻击判定）和 `collision`（移动碰撞）几乎必然同时使用——
 * 先用 hitbox 判定命中，再用 collision 做移动分离。
 *
 * 但两边有 5 个同名导出：`Shape` / `ShapeKind` / `circle` / `capsule` / `boundingRadius`。
 * 同一文件直接 import 两边会报 **TS2300 Duplicate identifier ×5**。
 *
 * 用下面这套带 `Hit` 前缀的别名即可避免，两条 import 可以共存：
 *
 * ```typescript
 * import { HitShape, hitCircle, hitCapsule, hitBoundingRadius } from '.../hitbox/Hitbox';
 * import { ColShape, colCircle } from '.../collision/Collision';
 * ```
 *
 * 【两套 Shape 不通用】
 * `HitShape` 是 `'circle'|'rect'|'sector'|'capsule'`，
 * `ColShape` 是 `'circle'|'aabb'|'obb'|'capsule'`。
 * 业务侧要自己写转换——这是刻意的，两者算法差异大，强行统一不合理。
 *
 * 【参数也不同】
 * 本模块的 `circle(radius, offsetX?, offsetY?)` 是**相对变换的偏移**，
 * collision 的 `circle(x, y, r)` 是**世界坐标**。别看名字一样就混用。
 */
export type { Shape as HitShape, ShapeKind as HitShapeKind } from './Hitbox';
export {
  circle as hitCircle,
  capsule as hitCapsule,
  boundingRadius as hitBoundingRadius,
} from './Hitbox';

export function circle(radius: number, offsetX?: number, offsetY?: number): Shape {
  return { kind: 'circle', radius, offsetX, offsetY };
}

/** 构造矩形（半宽半高） */
export function rect(halfW: number, halfH: number, offsetX?: number, offsetY?: number): Shape {
  return { kind: 'rect', halfW, halfH, offsetX, offsetY };
}

/** 构造扇形 */
export function sector(radius: number, angleDeg: number, offsetX?: number, offsetY?: number): Shape {
  return { kind: 'sector', radius, angleDeg, offsetX, offsetY };
}

/** 构造胶囊 */
export function capsule(radius: number, height: number, offsetX?: number, offsetY?: number): Shape {
  return { kind: 'capsule', radius, height, offsetX, offsetY };
}
