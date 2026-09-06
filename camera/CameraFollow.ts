/**
 * camera/CameraFollow.ts —— 相机跟随（纯逻辑层）
 *
 * 【它解决什么】
 *
 * 相机跟随的需求听起来只有一句"相机跟着角色走"。
 * 但真正做出来要处理五件事，每一件做错了玩家都说"手感怪"：
 *
 * 1. **帧率无关**：`lerp(cur, target, 0.1)` 在 120Hz 屏上跟随紧一倍
 * 2. **死区**：角色每动一像素相机就动，画面永远在抖
 * 3. **前瞻**：角色朝右跑时应该多看到右边一点
 * 4. **边界钳制**：走到地图边缘时不该看到地图外的黑边
 * 5. **瞬移处理**：角色传送（回城、重生）时相机不该"飞"过去
 *
 * 【它不做什么】
 *
 * 本模块**不认识任何引擎相机**。它只输出一个坐标：
 *
 * ```typescript
 * const p = follow.update(dt, targetX, targetY, velX, velY);
 * camera.node.setPosition(p.x, p.y);   // 你自己套到引擎上
 * ```
 *
 * 这样它能在 Node 里完整测试，换引擎只改最后一行。
 * 参照 `joystick-mover/` 的 Core + 适配层结构。
 */

import { clamp, numOr, safeDt, smoothDamp } from '../_core/math';

// ==================== 类型 ====================

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * 【⚠️ 全库有 3 个同名 `Rect`，坐标系不同，别混用】
 *
 * | 模块 | 字段 | 表示法 |
 * |---|---|---|
 * | **本模块** | minX / minY / maxX / maxY | 角点 |
 * | ds / dungeon | x/y/w/h | 位置+尺寸 |
 *
 * 都叫 `Rect`。调用方会自然地以为 `Rect` 就是 `Rect`，
 * 于是写出 `x + w` 却拿到 `minX/maxX` 的语义——
 * **不报错**，只是算出错误的矩形。这正是最难查的那类问题。
 *
 * `_core/types.ts` 现在提供了无歧义的名字和互转函数，新代码请用它们：
 *
 * ```typescript
 * import { IRect, IRectSized, toCorners, toSized } from '../_core/types';
 * ```
 *
 * 本模块的 `Rect` 保留原样是为了不破坏已有代码，
 * 等价于 `_core` 的 `IRect`。
 */
export interface Rect {
  /** 左边界 */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface FollowOptions {
  /**
   * 死区半宽/半高
   *
   * 【死区是什么】
   * 以相机中心为原点的一个矩形。角色在矩形内移动时相机**不动**。
   * 没有死区的话角色每次微调方向相机都会跟着动，画面抖得让人眼晕。
   *
   * 典型值：屏幕宽度的 8%~15%。
   */
  readonly deadZone?: Partial<Vec2>;

  /**
   * 平滑时间（秒），越小跟随越紧
   *
   * 【典型值】0.15~0.3。0 表示硬跟随（无平滑）。
   */
  readonly smoothTime?: number;

  /**
   * 前瞻：按角色速度提前偏移的距离系数
   *
   * 【为什么需要】
   * 角色向右高速跑时，如果相机只跟着当前位置，
   * 玩家看到的右侧空间不够，来不及反应撞上障碍。
   */
  readonly lookAheadFactor?: number;
  /** 前瞻最大距离（防止高速时相机甩太远） */
  readonly lookAheadMax?: Partial<Vec2>;
  /** 前瞻自身的平滑时间（比 smoothTime 大，让前瞻"慢一拍"） */
  readonly lookAheadSmoothTime?: number;

  /**
   * 世界边界（相机中心的可行范围）。null 表示不限制。
   *
   * 【⚠️ 传的是相机中心的范围，不是视口范围】
   * 常见错误是把地图边界直接传进来，
   * 结果相机能跑到地图外（因为相机看的是一个视口，不是一点）。
   */
  readonly bounds?: Rect | null;

  /**
   * 瞬移阈值：单帧位移超过这个值就认为是传送，直接跳过去
   *
   * 【为什么需要】
   * 角色回城时如果相机平滑飞过去，会掠过大半个地图，
   * 玩家看到一堆无意义的画面滚动，还容易晕。
   */
  readonly teleportThreshold?: number;

  readonly maxSpeed?: number;
}

export interface FollowSnapshot {
  readonly x: number;
  readonly y: number;
  /** 前瞻偏移（调试可视化很有用） */
  readonly lookAheadX: number;
  readonly lookAheadY: number;
  /** 目标是否在死区内（true 表示相机本帧不该移动） */
  readonly inDeadZone: boolean;
}

// ==================== 实现 ====================

const DEFAULTS = {
  deadZoneX: 0,
  deadZoneY: 0,
  smoothTime: 0.2,
  lookAheadFactor: 0,
  lookAheadMaxX: 0,
  lookAheadMaxY: 0,
  lookAheadSmoothTime: 0.4,
  teleportThreshold: Infinity,
  maxSpeed: Infinity,
};

export class CameraFollow {
  private readonly _dzX: number;
  private readonly _dzY: number;
  private readonly _smoothTime: number;
  private readonly _laFactor: number;
  private readonly _laMaxX: number;
  private readonly _laMaxY: number;
  private readonly _laSmoothTime: number;
  private readonly _teleportThreshold: number;
  private readonly _maxSpeed: number;
  private _bounds: Rect | null;

  /** 相机当前位置（相机中心） */
  private _x = 0;
  private _y = 0;

  /** smoothDamp 的速度记忆（必须跨帧保持） */
  private readonly _velX = { v: 0 };
  private readonly _velY = { v: 0 };
  private readonly _velLaX = { v: 0 };
  private readonly _velLaY = { v: 0 };

  private _laX = 0;
  private _laY = 0;
  private _initialized = false;
  private _lastInDeadZone = false;

  constructor(opts: FollowOptions = {}) {
    this._dzX = this._deadZoneValue(opts.deadZone?.x ?? DEFAULTS.deadZoneX, 'x');
    this._dzY = this._deadZoneValue(opts.deadZone?.y ?? DEFAULTS.deadZoneY, 'y');
    this._smoothTime = Math.max(0, numOr(opts.smoothTime, DEFAULTS.smoothTime));
    this._laFactor = opts.lookAheadFactor ?? DEFAULTS.lookAheadFactor;
    this._laMaxX = opts.lookAheadMax?.x ?? DEFAULTS.lookAheadMaxX;
    this._laMaxY = opts.lookAheadMax?.y ?? DEFAULTS.lookAheadMaxY;
    this._laSmoothTime = Math.max(0, numOr(opts.lookAheadSmoothTime, DEFAULTS.lookAheadSmoothTime));
    this._teleportThreshold = opts.teleportThreshold ?? DEFAULTS.teleportThreshold;
    this._maxSpeed = opts.maxSpeed ?? DEFAULTS.maxSpeed;
    this._bounds = opts.bounds ?? null;

  }

  /**
   * 死区取值校验
   *
   * 【为什么不静默夹成 0】
   * 传负数几乎一定是配表写错（比如把"相机中心偏移"填进了死区）。
   * 夹成 0 的话相机跟得死死的，画面抖得让人眼晕，
   * 而没人会想到去查一个"应该生效但没生效"的参数。
   */
  private _deadZoneValue(v: number, axis: string): number {
    if (!Number.isFinite(v)) {
      throw new Error(`[CameraFollow] 死区 ${axis} 必须是有限数，收到 ${v}`);
    }
    if (v < 0) {
      throw new Error(`[CameraFollow] 死区 ${axis} 不能为负，收到 ${v}`);
    }
    return v;
  }

  // ==================== 查询 ====================

  get x(): number {
    return this._x;
  }

  get y(): number {
    return this._y;
  }

  get lookAheadX(): number {
    return this._laX;
  }

  get lookAheadY(): number {
    return this._laY;
  }

  get inDeadZone(): boolean {
    return this._lastInDeadZone;
  }

  get bounds(): Rect | null {
    return this._bounds;
  }

  /**
   * 运行时更换边界（切换关卡时）
   *
   * 【⚠️ max < min 是合法的】
   * 它表示"地图比视口小"，此时相机应居中而不是贴在角落。
   * `computeCameraBounds` 在小地图上就会算出这样的矩形，
   * 所以这里不能拒绝它。
   */
  setBounds(b: Rect | null): void {
    if (b) {
      for (const [k, v] of Object.entries(b)) {
        if (!Number.isFinite(v)) {
          throw new Error(`[CameraFollow] 边界 ${k} 必须是有限数，收到 ${v}`);
        }
      }
    }
    this._bounds = b;
    if (b) this._clampToBounds();
  }

  // ==================== 驱动 ====================

  /**
   * 每帧更新
   *
   * @param dt 帧间隔（**秒**）
   * @param tx 目标位置 X
   * @param ty 目标位置 Y
   * @param vx 目标速度 X（用于前瞻，单位/秒）
   * @param vy 目标速度 Y
   */
  update(dt: number, tx: number, ty: number, vx = 0, vy = 0): FollowSnapshot {
    if (!safeDt(dt)) {
      return this._snapshot();
    }

    // ① 首次调用直接吸附，避免从原点飞过去
    if (!this._initialized) {
      this._x = tx;
      this._y = ty;
      this._initialized = true;
      this._clampToBounds();
      return this._snapshot();
    }

    // ② 瞬移检测：直接跳过去，并清掉阻尼记忆
    const dx = tx - this._x;
    const dy = ty - this._y;
    if (dx * dx + dy * dy > this._teleportThreshold * this._teleportThreshold) {
      this._x = tx;
      this._y = ty;
      this._resetVelocity();
      this._laX = 0;
      this._laY = 0;
      this._clampToBounds();
      return this._snapshot();
    }

    // ③ 前瞻（自身平滑，比相机更慢一拍，避免抖动放大）
    const targetLaX = clamp(vx * this._laFactor, -this._laMaxX, this._laMaxX);
    const targetLaY = clamp(vy * this._laFactor, -this._laMaxY, this._laMaxY);
    this._laX = this._laSmoothTime > 0
      ? smoothDamp(this._laX, targetLaX, this._velLaX, this._laSmoothTime, dt)
      : targetLaX;
    this._laY = this._laSmoothTime > 0
      ? smoothDamp(this._laY, targetLaY, this._velLaY, this._laSmoothTime, dt)
      : targetLaY;

    // ④ 死区：目标在死区内时，期望位置就是相机当前位置（即"不动"）
    const desiredX = this._applyDeadZone(this._x, tx, this._dzX);
    const desiredY = this._applyDeadZone(this._y, ty, this._dzY);
    this._lastInDeadZone = desiredX === this._x && desiredY === this._y;

    // ⑤ 平滑跟随（帧率无关）
    const goalX = desiredX + this._laX;
    const goalY = desiredY + this._laY;

    const prevX = this._x;
    const prevY = this._y;

    if (this._smoothTime > 0) {
      this._x = smoothDamp(this._x, goalX, this._velX, this._smoothTime, dt, this._maxSpeed);
      this._y = smoothDamp(this._y, goalY, this._velY, this._smoothTime, dt, this._maxSpeed);
    } else {
      this._x = goalX;
      this._y = goalY;
    }

    /**
     * ⑥ 单帧位移上限
     *
     * 【⚠️ smoothDamp 的 maxSpeed 限制的不是速度】
     *
     * 它（沿用 Unity 的实现）把「当前值与目标值的差」夹到
     * `maxSpeed * smoothTime`，限制的是**滞后距离**而不是每帧位移。
     *
     * 后果很反直觉：目标瞬移 10000 像素时，相机一帧就跳到离目标
     * 只剩 1 像素的位置——maxSpeed 反而让相机"跳得更快"。
     *
     * 相机要的是"每帧最多移动多少"，所以这里再夹一次真实的单帧位移。
     */
    if (this._maxSpeed < Infinity) {
      const lim = this._maxSpeed * dt;
      this._x = prevX + clamp(this._x - prevX, -lim, lim);
      this._y = prevY + clamp(this._y - prevY, -lim, lim);
    }

    this._clampToBounds();
    return this._snapshot();
  }

  /** 立即吸附到目标（切场景、读档用） */
  snapTo(tx: number, ty: number): void {
    this._x = tx;
    this._y = ty;
    this._initialized = true;
    this._resetVelocity();
    this._laX = 0;
    this._laY = 0;
    this._clampToBounds();
  }

  /**
   * 外部施加的偏移（震屏用）
   *
   * 【为什么是"加"而不是"设"】
   * 震屏是叠加在跟随之上的，不能覆盖跟随结果。
   * 每帧先 update 再 addShake，震屏衰减后自然回到跟随位置。
   */
  addOffset(ox: number, oy: number): void {
    this._x += ox;
    this._y += oy;
    this._clampToBounds();
  }

  reset(): void {
    this._x = 0;
    this._y = 0;
    this._laX = 0;
    this._laY = 0;
    this._initialized = false;
    this._lastInDeadZone = false;
    this._resetVelocity();
  }

  // ==================== 内部 ====================

  /**
   * 死区计算
   *
   * 【⚠️ 这里是硬死区】
   * 目标越过死区边界的瞬间，期望位置会跳到"边界上"，
   * 于是相机突然启动——这是硬死区的固有特性，
   * 也是很多游戏相机"一顿一顿"的原因。
   *
   * 想要更柔和可以用软死区（越界后按超出量的比例缓慢拉动），
   * 但硬死区行为可预测、好调参，先做这个。
   */
  private _applyDeadZone(camPos: number, target: number, half: number): number {
    if (half <= 0) return target;
    const diff = target - camPos;
    if (Math.abs(diff) <= half) return camPos;
    return target - Math.sign(diff) * half;
  }

  private _clampToBounds(): void {
    const b = this._bounds;
    if (!b) return;
    /**
     * 【⚠️ 地图比视口小时，max < min】
     * 此时 clamp(v, min, max) 会返回 max（因为 clamp 内部用 Math.min(v,max) 兜底），
     * 结果是相机贴在角落而不是居中。
     * 正确做法是取中点。
     */
    if (b.maxX < b.minX) this._x = (b.minX + b.maxX) / 2;
    else this._x = clamp(this._x, b.minX, b.maxX);

    if (b.maxY < b.minY) this._y = (b.minY + b.maxY) / 2;
    else this._y = clamp(this._y, b.minY, b.maxY);
  }

  private _resetVelocity(): void {
    this._velX.v = 0;
    this._velY.v = 0;
    this._velLaX.v = 0;
    this._velLaY.v = 0;
  }

  private _snapshot(): FollowSnapshot {
    return {
      x: this._x,
      y: this._y,
      lookAheadX: this._laX,
      lookAheadY: this._laY,
      inDeadZone: this._lastInDeadZone,
    };
  }
}

/**
 * 由视口尺寸和地图尺寸计算相机中心的可行范围
 *
 * 【为什么需要这个辅助函数】
 * 人自然地想传地图边界，但相机中心的可行范围是"地图边界内缩半个视口"。
 * 直接传地图边界，相机就会露出地图外的黑边。
 *
 * @param mapRect 地图范围
 * @param viewW 视口宽
 * @param viewH 视口高
 */
export function computeCameraBounds(mapRect: Rect, viewW: number, viewH: number): Rect {
  const halfW = viewW / 2;
  const halfH = viewH / 2;
  return {
    minX: mapRect.minX + halfW,
    minY: mapRect.minY + halfH,
    maxX: mapRect.maxX - halfW,
    maxY: mapRect.maxY - halfH,
  };
}
