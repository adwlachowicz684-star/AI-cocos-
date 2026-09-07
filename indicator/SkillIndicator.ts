/**
 * SkillIndicator —— 技能指示器（纯参数计算）
 *
 * 【它解决什么】
 *
 * 玩家按下技能键后、真正生效前，需要看到「这一招会打到哪里」。
 * 这就是指示器：地面上的扇形、圆圈、直线。
 *
 * 【关键设计：只算参数，不画】
 *
 * 本模块输出的是**形状描述**（`Shape` + 位置 + 朝向），
 * 由渲染层照着画。
 *
 * 为什么这样切：
 * 1. 3D 俯视角、2D 横版、等距视角的画法完全不同，但**参数一样**
 * 2. 参数可以在 Node 里完整测试（"射程 5 米时目标点应被钳制到 5 米"）
 * 3. 同一份参数同时喂给判定系统 → **所见即所得**
 *
 * 【⚠️ 最重要的一条原则】
 *
 * **指示器、预警、实际判定必须用同一份 `Shape`。**
 *
 * 一旦三处各写一份参数，就会出现「看着能躲开却被打中」——
 * 这是动作游戏最让玩家愤怒的 bug，而且极难排查（三处数值看起来都对）。
 *
 * 所以 `IndicatorResult.shape` 应该**直接传给** `HitboxWorld.query()`。
 *
 * 【使用示例】
 * ```typescript
 * const ind = new SkillIndicator({
 *   kind: 'sector', radius: 3, angleDeg: 100,
 *   range: 5, aimed: true,
 * });
 *
 * const r = ind.compute(px, py, facingDeg, aimX, aimY);
 * // r.shape → 传给 hitbox 查询
 * // r.x / r.y / r.rotation → 传给渲染层画
 * // r.valid → 决定能不能放（UI 显示红色还是绿色）
 * ```
 */

import { angleDiff, clamp } from '../_core/math';

/** 指示器类型 */
export type IndicatorKind =
  /** 圆形范围（AOE、爆炸） */
  | 'circle'
  /** 扇形（近战挥砍、喷火） */
  | 'sector'
  /** 直线（突进、激光、箭雨） */
  | 'line'
  /** 环形（冲击波、光环） */
  | 'ring'
  /** 点选（传送、放置类） */
  | 'point'
  /** 方向指示（冲刺、闪现——只显示方向和目标点） */
  | 'direction';

/**
 * 形状描述
 *
 * 【为什么这里重新定义而不复用 hitbox/Shape】
 * 分层规则禁止横向依赖（hitbox 和 indicator 同为第 1 层）。
 * 这个结构**字段兼容** hitbox 的 `Shape`，
 * 可以直接传给 `HitboxWorld.query()`，在适配层做一次转换即可。
 */
export interface IndicatorShape {
  kind: 'circle' | 'rect' | 'sector' | 'capsule';
  radius?: number;
  halfW?: number;
  halfH?: number;
  angleDeg?: number;
  height?: number;
  offsetX?: number;
  offsetY?: number;
}

/** 指示器配置 */
export interface IndicatorConfig {
  kind: IndicatorKind;

  /** circle / sector / ring：半径 */
  radius?: number;
  /** sector：张角（度） */
  angleDeg?: number;
  /** line：长度（米） */
  length?: number;
  /** line：宽度（米），即矩形短边 */
  width?: number;
  /** ring：内半径 */
  innerRadius?: number;
  /** point：作用半径（0 = 严格一个点） */
  pointRadius?: number;

  /**
   * 最大施法距离（米）
   *
   * 【作用】目标点超出射程时会被**钳制**到射程边缘，
   * 而不是判定失败——玩家把鼠标拖远了不该放不出技能。
   */
  range: number;

  /**
   * 是否需要选点
   * - `true`：以目标点为中心（火球、传送）
   * - `false`：以施法者为中心（旋风斩、光环）
   */
  aimed: boolean;

  /**
   * 最小施法距离（防止贴脸放 AOE 把自己也炸了——可选）
   */
  minRange?: number;

  /**
   * 吸附到目标
   *
   * 【体验设计】鼠标指在敌人身上时，指示器锁定该敌人而不是自由点。
   * 这让「我想打这个」变得确定，而不是靠像素级瞄准。
   * 需要配合 `ITargetProvider`。
   */
  snapToTarget?: boolean;
  /** 吸附半径（米） */
  snapRadius?: number;
}

/** 可选目标（吸附用） */
export interface ISnapTarget {
  x: number;
  y: number;
  /** 半径（用于精确吸附） */
  radius?: number;
  id?: string;
}

/** 目标提供者（吸附用，可选注入） */
export interface ITargetProvider {
  /** 返回在 (x,y) 半径 r 内、最合适的目标 */
  findNearest(x: number, y: number, r: number): ISnapTarget | null;
}

/**
 * 落点校验器（可选注入）
 *
 * 【典型用途】
 * - 不允许在墙里放技能
 * - 不允许在悬崖外放
 * - 只允许放在地面上
 */
export interface IPlacementValidator {
  isValid(x: number, y: number, shape: IndicatorShape): boolean;
}

/** 计算结果 */
export interface IndicatorResult {
  /** 形状（**直接传给 HitboxWorld.query()**） */
  shape: IndicatorShape;
  /** 世界坐标 X（形状中心） */
  x: number;
  /** 世界坐标 Y */
  y: number;
  /** 朝向（度） */
  rotation: number;

  /** 钳制并吸附后的目标点 */
  aimX: number;
  aimY: number;
  /** 是否发生了钳制（超出射程） */
  clamped: boolean;
  /** 吸附到的目标 id（未吸附则 undefined） */
  snappedTo?: string;

  /**
   * `ring` 类型的内半径（仅 ring 有此字段）
   *
   * 【为什么必须外露】
   * 配置里的 `innerRadius` 被 API 收下却在 `_buildShape()` 里被丢弃——
   * 形状只返回外圆。于是直接把 `toQueryArgs(result)` 喂给
   * `HitboxWorld.query()` 得到的是**实心圆**判定：环形技能打中心的人。
   *
   * 调用方要正确过滤，就必须手上有 innerRadius。
   * 以前它只能自己回配置里取（而 result 里没有，等于要再持有 cfg），
   * 这条多余的路径就是误用来源。所以这里随结果一起给出。
   */
  innerRadius?: number;

  /** 是否可以施放（落点合法） */
  valid: boolean;
  /** 无效原因（UI 提示用） */
  invalidReason?: 'out-of-range' | 'too-close' | 'blocked';
}

/**
 * 技能指示器
 *
 * 【无状态】同一个实例可以安全地被多个技能复用（每帧调 compute）。
 */
export class SkillIndicator {
  private _cfg: IndicatorConfig;
  private _targets?: ITargetProvider;
  private _placement?: IPlacementValidator;

  constructor(cfg: IndicatorConfig, deps: { targets?: ITargetProvider; placement?: IPlacementValidator } = {}) {
    this._cfg = cfg;
    this._targets = deps.targets;
    this._placement = deps.placement;
  }

  /** 更新配置（技能升级后射程变了） */
  configure(cfg: IndicatorConfig): void {
    this._cfg = cfg;
  }

  get config(): Readonly<IndicatorConfig> {
    return this._cfg;
  }

  /**
   * 计算指示器
   *
   * @param casterX 施法者 X
   * @param casterY 施法者 Y
   * @param facingDeg 施法者朝向（度）
   * @param aimX 瞄准点 X（鼠标/摇杆方向）
   * @param aimY 瞄准点 Y
   */
  compute(
    casterX: number, casterY: number, facingDeg: number,
    aimX: number, aimY: number,
  ): IndicatorResult {
    const cfg = this._cfg;

    // ── 1. 决定朝向 ──
    let dx = aimX - casterX;
    let dy = aimY - casterY;
    let dist = Math.hypot(dx, dy);

    let rotation = facingDeg;
    if (cfg.aimed) {
      if (dist > 1e-6) {
        rotation = (Math.atan2(dy, dx) * 180) / Math.PI;
      }
      // 瞄准点就在脚下（摇杆没推 / 鼠标在角色身上）→ 保持当前朝向
    }

    // ── 2. 计算中心点 ──
    let cx: number;
    let cy: number;
    let clamped = false;

    if (!cfg.aimed) {
      // 自身为中心
      cx = casterX;
      cy = casterY;
    } else {
      // 钳制到射程内
      if (dist > cfg.range && dist > 1e-6) {
        const k = cfg.range / dist;
        dx *= k;
        dy *= k;
        dist = cfg.range;
        clamped = true;
      }
      cx = casterX + dx;
      cy = casterY + dy;

      // 吸附
      let snapped: string | undefined;
      if (cfg.snapToTarget && this._targets) {
        const t = this._targets.findNearest(cx, cy, cfg.snapRadius ?? 1);
        if (t) {
          cx = t.x;
          cy = t.y;
          snapped = t.id;
        }
      }
      return this._finish(cx, cy, rotation, cx, cy, clamped, snapped, casterX, casterY);
    }

    return this._finish(cx, cy, rotation, cx, cy, clamped, undefined, casterX, casterY);
  }

  /**
   * 本配置的形状中心是否需要"从施法者脚下向前延伸"
   *
   * 【为什么抽成方法】`compute` 与 `centerFor` 必须共用同一个判据。
   * 判据一旦在两处各写一份，就会出现"加了新类型只改了一边"的静默不一致。
   */
  private _extendsFromCaster(): boolean {
    const k = this._cfg.kind;
    return k === 'line' || k === 'direction';
  }

  private _finish(
    cx: number, cy: number, rotation: number,
    aimX: number, aimY: number, clamped: boolean, snappedTo: string | undefined,
    casterX: number, casterY: number,
  ): IndicatorResult {
    const shape = this._buildShape();

    /**
     * 【⚠️ 曾经的 bug：`compute()` 与 `centerFor()` 给出两个不同的中心】
     *
     * 对 `line` / `direction` 这类"从脚下向前延伸"的形状：
     * - `compute()` 返回的是**瞄准点**（射程末端，实测 `x === 6`）
     * - `centerFor()` 返回的是**线段中点**（前方半长处，实测 `x === 3`）
     *
     * 两个 API 对同一套配置给出相差 `length/2` 的两个答案，而 README
     * 没有说明二者语义不同。于是"用 centerFor 画、用 compute 判定"（或反之）
     * 的代码，画的圈和实际打中的位置**整整错开半个长度**——
     * 正是本单元开篇列为头号原则要防的那种"看着能躲开却被打中"。
     *
     * 【以哪个为准】README 第 40 行明确写了"形状中心应在前方半个长度处，
     * 用 centerFor 算"，且物理上自洽：矩形 `halfW = length/2`，
     * 中心只有前移半长，覆盖区间才正好是 [caster, caster + length]。
     * 所以统一到 `centerFor`，并让 `compute` 直接复用它（不再各写一份）。
     *
     * 【瞄准点语义不变】`aimX` / `aimY` 仍表示"钳制并吸附后的目标点"，
     * 保持原有含义，便于渲染层画准星。
     */
    let shapeCx = cx;
    let shapeCy = cy;
    if (this._extendsFromCaster()) {
      const c = this.centerFor(casterX, casterY, rotation);
      shapeCx = c.x;
      shapeCy = c.y;
    }

    const r: IndicatorResult = {
      shape,
      x: shapeCx,
      y: shapeCy,
      rotation,
      aimX,
      aimY,
      clamped,
      valid: true,
    };
    if (snappedTo !== undefined) r.snappedTo = snappedTo;

    // 【ring 必须把 innerRadius 交出去】见 IndicatorResult.innerRadius 的说明
    if (shape.kind === 'circle' && this._cfg.kind === 'ring') {
      r.innerRadius = this._cfg.innerRadius ?? 0;
    }

    const cfg = this._cfg;

    // 最小距离：防止贴脸放 AOE（可选）
    if (cfg.minRange !== undefined && cfg.aimed) {
      const d = Math.hypot(cx - casterX, cy - casterY);
      if (d < cfg.minRange) {
        r.valid = false;
        r.invalidReason = 'too-close';
      }
    }

    // 落点校验（墙里 / 悬崖外等）
    if (r.valid && this._placement && !this._placement.isValid(shapeCx, shapeCy, shape)) {
      r.valid = false;
      r.invalidReason = 'blocked';
    }

    return r;
  }

  /** 把配置转成判定形状 */
  private _buildShape(): IndicatorShape {
    const cfg = this._cfg;
    switch (cfg.kind) {
      case 'circle':
        return { kind: 'circle', radius: cfg.radius ?? 1 };

      case 'ring':
        // 【环形没法直接用单个形状表达】
        // 判定层需要"外圆内有、内圆内无"。
        // 这里返回外圆，调用方用 `query` 结果再按距离过滤内圈。
        return { kind: 'circle', radius: cfg.radius ?? 1 };

      case 'sector':
        return {
          kind: 'sector',
          radius: cfg.radius ?? 1,
          angleDeg: cfg.angleDeg ?? 90,
        };

      case 'line': {
        // 直线用胶囊/矩形表达。
        // 用矩形更符合"剑气"的直觉，且能表达宽度。
        // 中心前移半长：指示器从施法者脚下向前延伸，而不是以施法者为中心。
        const halfLen = (cfg.length ?? 3) / 2;
        const halfW = (cfg.width ?? 0.6) / 2;
        return { kind: 'rect', halfW: halfLen, halfH: halfW };
      }

      case 'point':
        return { kind: 'circle', radius: cfg.pointRadius ?? 0.2 };

      case 'direction':
        // 方向指示（冲刺）：用胶囊表达路径，便于检测沿途障碍
        return {
          kind: 'capsule',
          radius: (cfg.width ?? 0.5) / 2,
          height: cfg.length ?? 3,
        };

      default:
        return { kind: 'circle', radius: 1 };
    }
  }

  /**
   * line / direction 类型的**实际中心**
   *
   * 【为什么需要单独处理】
   * 直线技能从脚下向前延伸，形状中心应该在前方半个长度处，
   * 而不是施法者脚下。否则判定框会往后多出一半，看起来"打不到身前却打到了身后"。
   */
  centerFor(
    casterX: number, casterY: number, rotationDeg: number,
  ): { x: number; y: number } {
    const cfg = this._cfg;
    if (cfg.kind !== 'line' && cfg.kind !== 'direction') {
      return { x: casterX, y: casterY };
    }
    const half = (cfg.length ?? 3) / 2;
    const r = (rotationDeg * Math.PI) / 180;
    return {
      x: casterX + Math.cos(r) * half,
      y: casterY + Math.sin(r) * half,
    };
  }
}

/**
 * 便利：把指示器结果转成可直接喂给 HitboxWorld.query 的参数
 *
 * ```typescript
 * const args = toQueryArgs(result);
 * const hits = world.query(args.shape, args.x, args.y, args.rotation, MASK);
 * ```
 */
export function toQueryArgs(r: IndicatorResult): {
  shape: IndicatorShape;
  x: number;
  y: number;
  rotation: number;
} {
  return { shape: r.shape, x: r.x, y: r.y, rotation: r.rotation };
}

/**
 * 环形判定的距离过滤（配合 `ring` 指示器）
 *
 * ```typescript
 * const hits = world.query(shape, x, y, rot, MASK)
 *   .filter(h => inRing(h.hitbox.x, h.hitbox.y, x, y, inner, outer));
 * ```
 */
export function inRing(
  px: number, py: number,
  cx: number, cy: number,
  innerR: number, outerR: number,
): boolean {
  const d = Math.hypot(px - cx, py - cy);
  return d >= innerR && d <= outerR;
}

/**
 * 把角度限制在朝向附近（辅助瞄准）
 *
 * 【体验设计】
 * 摇杆操作时很难精确指向，把施法方向吸附到"最接近的目标方向"能大幅改善手感。
 * 但**吸附角度要小**（10~15°），否则玩家会觉得"我想打左边却打了右边"。
 */
export function snapAngle(
  desiredDeg: number,
  facingDeg: number,
  maxDeviationDeg: number,
): number {
  /**
   * 【⚠️ 用取模归一化，不能用 while 递减】
   *
   * 原实现：
   * ```js
   * while (diff > 180) diff -= 360;
   * while (diff < -180) diff += 360;
   * ```
   * `Infinity - 360` 仍等于 `Infinity`，循环条件恒真 → **死循环**。
   * 实测 `snapAngle(Infinity, 15)`：退出码 124（卡死）。
   *
   * 角度常由 `Math.atan2` 算出，上游一旦出现 NaN/Infinity
   * （比如除零、坐标未初始化），这里就是进程级卡死而不是"指示偏了"。
   *
   * 复用 `angleDiff(0, diff)`：O(1) 取模，返回 -180~180 的最短差值，
   * 与原来两个 while 的语义完全一致。
   */
  /**
   * 度 → 弧度 → `angleDiffRad` → 度。
   *
   * 走弧度版是因为**只有它做了非有限值归一**（Infinity → 0）；
   * 度版的 `wrapAngle` 用 `deg % 360`，`Infinity % 360` 仍是 NaN。
   * 实测角度差为 Infinity 时，度版会返回 NaN 并污染下游。
   */
  const raw = desiredDeg - facingDeg;
  /**
   * 【为什么不换算成弧度再走 angleDiffRad】
   *
   * 弧度往返会引入浮点误差：实测 `snapAngle(5, 0, 15)`
   * 从精确的 5 变成 4.999999999999995。
   * 角度值常被直接写回节点 rotation 并参与相等比较，
   * 无谓的精度损失应当避免。
   *
   * 所以保留度内取模（`angleDiff` 是 O(1)，与原来两个 while 同义），
   * 只对非有限值单独归一到 0——这正是 `angleDiffRad` 的做法，
   * 只是避免了一次单位换算。
   */
  const diff = Number.isFinite(raw) ? angleDiff(0, raw) : 0;
  const clamped = clamp(diff, -maxDeviationDeg, maxDeviationDeg);
  return facingDeg + clamped;
}
