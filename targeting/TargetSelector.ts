/**
 * targeting/TargetSelector.ts —— 目标锁定与切换
 *
 * 【它解决什么】
 *
 * 动作游戏里"打谁"这件看似简单的事，实际是手感的关键：
 *
 * - 不锁定：玩家在混战里打不到想打的怪，挫败
 * - 锁定太黏：想换个目标却换不动，难受
 * - 锁定太松：每帧自动切换目标，攻击方向乱跳，**玩家感觉角色失控**
 *
 * 最后一条是最致命也最常见的。
 * 原因是目标选择每帧重算，两个候选分数接近时来回翻转。
 *
 * 【本模块的核心设计：迟滞 + 粘性】
 *
 * ```
 * 新目标必须比当前目标好 THRESHOLD 倍才切换
 * ```
 *
 * 这叫**迟滞（hysteresis）**，和空调温控原理一样：
 * 不在临界点反复横跳。
 *
 * 【零业务依赖】
 *
 * 它不认识"敌人""Boss"。候选目标只有 `id / x / y / 权重`。
 * 距离、角度、血量等业务概念通过**评分函数注入**。
 */

import { numOr, safeDt, normalizeAngleRad } from '../_core/math';

// ============================================================
// 数据结构
// ============================================================

/** 候选目标 */
export interface TargetCandidate {
  readonly id: number;
  x: number;
  y: number;
  /** 是否可选（死了/无敌/在墙后就 false） */
  selectable: boolean;
}

/**
 * 评分函数
 *
 * @returns 分数，越大越优先
 *
 * 【为什么返回分数而不是布尔】
 * "能不能选"和"有多想选"是两件事。
 * 布尔只能做硬过滤，分数才能做"更近的优先"这类排序。
 */
export type TargetScorer = (
  candidate: TargetCandidate,
  ctx: TargetingContext,
) => number;

export interface TargetingContext {
  /** 玩家/宿主位置 */
  readonly originX: number;
  readonly originY: number;
  /** 宿主朝向（弧度） */
  readonly facing: number;
  /** 当前锁定目标（无则 null） */
  readonly current: number | null;
}

// ============================================================
// 配置
// ============================================================

export interface TargetSelectorOptions {
  /**
   * 最大锁定距离。0 = 不限
   *
   * 【典型值】屏幕内可见范围，比如 15~25
   */
  maxRange?: number;
  /**
   * 最大锁定角度（半角，弧度）。Math.PI = 不限
   *
   * 【典型值】
   * - 60°~90°：只锁身前的（黑魂、怪物猎人）
   * - 180°：锁半屏内的
   * - 360°：全向（俯视角射击）
   */
  maxAngle?: number;
  /**
   * 迟滞阈值。默认 1.25
   *
   * 当前目标保持锁定，除非新目标分数**高出 25%**。
   *
   * 【怎么调】
   * - 1.0 = 无迟滞，每帧都可能切换（**不要用**）
   * - 1.15~1.4 = 推荐区间
   * - 2.0+ = 太黏，几乎锁死不动
   */
  hysteresis?: number;
  /**
   * 目标失效后的宽限时间（秒）。默认 0.6
   *
   * 【为什么需要】
   * 目标短暂不可见（死亡动画播放中、被柱子挡了一瞬）时，
   * 立刻解锁会让玩家"莫名其妙失去锁定"。
   *
   * 给 0.5~1 秒宽限，手感明显更顺。
   * 但太长会导致"锁着一只死掉的怪"。
   */
  graceTime?: number;
  onLock?: (id: number | null, previous: number | null) => void;
}

/** 锁定模式 */
export type LockMode =
  /** 不锁定，每次攻击时按当前朝向选 */
  | 'free'
  /** 软锁定：朝向优先，但不强制转向 */
  | 'soft'
  /** 硬锁定：相机与朝向跟随目标 */
  | 'hard';

// ============================================================
// 实现
// ============================================================

export class TargetSelector {
  private readonly _maxRange: number;
  private readonly _maxAngle: number;
  private readonly _hysteresis: number;
  private readonly _graceTime: number;
  private readonly _scorers: TargetScorer[] = [];

  private _current: number | null = null;
  private _currentScore = -Infinity;
  private _grace = 0;
  private _mode: LockMode = 'soft';

  /** 宿主状态（外部每帧设置） */
  originX = 0;
  originY = 0;
  facing = 0;

  onLock?: (id: number | null, previous: number | null) => void;

  constructor(opts: TargetSelectorOptions = {}) {
    this._maxRange = Math.max(0, numOr(opts.maxRange, 0));
    this._maxAngle = opts.maxAngle ?? Math.PI;
    this._hysteresis = Math.max(1, numOr(opts.hysteresis, 1.25));
    this._graceTime = Math.max(0, numOr(opts.graceTime, 0.6));
    this.onLock = opts.onLock;
  }

  get current(): number | null {
    return this._current;
  }

  get mode(): LockMode {
    return this._mode;
  }

  setMode(m: LockMode): void {
    this._mode = m;
    if (m === 'free') this.unlock();
  }

  // ---- 评分规则 ----

  /**
   * 添加评分规则
   *
   * 多个规则**相加**。这样"距离近 +30、在正前方 +20、是精英 +50"
   * 可以自然组合。
   *
   * 【为什么不内置业务规则】
   * "优先打血量低的"还是"优先打精英"是设计决策，
   * 每个游戏都不一样。这里只提供组合机制。
   */
  addScorer(fn: TargetScorer): this {
    this._scorers.push(fn);
    return this;
  }

  clearScorers(): void {
    this._scorers.length = 0;
  }

  // ---- 主循环 ----

  /**
   * 每帧更新锁定目标
   *
   * @param dt 帧间隔（用于宽限计时）
   * @param candidates 候选列表
   */
  update(dt: number, candidates: readonly TargetCandidate[]): void {
    if (this._mode === 'free') {
      if (this._current !== null) this._setCurrent(null);
      return;
    }

    const ctx: TargetingContext = {
      originX: this.originX,
      originY: this.originY,
      facing: this.facing,
      current: this._current,
    };

    // ① 检查当前目标是否仍然有效，并刷新它的分数
    let currentValid = false;
    if (this._current !== null) {
      const c = candidates.find((x) => x.id === this._current);
      if (c && c.selectable && this._inRange(c)) {
        currentValid = true;
        this._currentScore = this._score(c, ctx);
      }
    }

    /**
     * ② 在全部候选中找最优
     *
     * 【⚠️ 曾经的 bug：当前目标有效时直接 return】
     *
     * 原写法是"当前目标还活着就保持锁定"，
     * 于是 `hysteresis` 参数**从来没有生效过**——
     * 它只在当前目标失效的那一瞬间参与判定，
     * 而那种情况下根本没什么可选的。
     *
     * 症状：配置里写了 `hysteresis: 1.25`，
     * 但目标几乎从不切换（除非当前这个死了）。
     * 表现为"锁定太黏、换不了目标"，
     * 而你去查代码会发现"迟滞明明配了啊"。
     *
     * 正确的迟滞是：**每帧都评估所有候选**，
     * 但新目标必须比当前目标好 hysteresis 倍才切换。
     */
    let best: TargetCandidate | null = null;
    let bestScore = -Infinity;
    let currentStillBest = false;

    for (const c of candidates) {
      if (!c.selectable) continue;
      if (!this._inRange(c)) continue;

      const s = this._score(c, ctx);

      if (c.id === this._current) {
        currentStillBest = true;
        // 当前目标自身不受迟滞门槛限制
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
        continue;
      }

      // 迟滞：新目标必须明显更好
      if (this._current !== null && currentValid && s <= this._currentScore * this._hysteresis) {
        continue;
      }
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }

    // ③ 当前目标失效 → 进入宽限，期间不切换
    if (this._current !== null && !currentValid) {
      // 【为什么是内联而不是提前 return】宽限递减在方法中段，
      // 提前 return 会跳过后面的目标切换逻辑。
      // 异常 dt 时"宽限不递减"= 保持当前目标，
      // 比"宽限变 NaN 后 > 0 恒 false 导致立即切换"安全得多。
      this._grace -= safeDt(dt) ? dt : 0;
      if (this._grace > 0) return;      // 宽限期内保持锁定

      // 宽限耗尽：接受切换结果（可能为 null）
      this._currentScore = best ? bestScore : -Infinity;
      this._setCurrent(best ? best.id : null);
      this._grace = best ? this._graceTime : 0;
      return;
    }

    // ④ 正常切换
    if (best) {
      if (!currentStillBest) this._setCurrent(best.id);
      this._currentScore = bestScore;
      this._grace = this._graceTime;
    } else if (this._current !== null && !currentValid) {
      this._currentScore = -Infinity;
      this._setCurrent(null);
    }
  }

  // ---- 手动控制 ----

  /** 强制锁定（玩家按键） */
  lock(id: number, score = 0): void {
    this._currentScore = score;
    this._grace = this._graceTime;
    this._setCurrent(id);
  }

  /** 解除锁定 */
  unlock(): void {
    this._grace = 0;
    this._setCurrent(null);
  }

  /**
   * 按方向切换目标
   *
   * 【设计要点】
   * 按"左/右"切换时，玩家期望的是"往那个方向上的下一个目标"，
   * 而不是列表里的下一个。所以按**相对当前朝向的方位角**排序。
   *
   * @param dirX 方向 X（-1 左 / +1 右 / 0 任意）
   * @param dirY 方向 Y
   * @returns 是否切换成功
   */
  cycle(candidates: readonly TargetCandidate[], dirX = 0, dirY = 0): boolean {
    const pool = candidates.filter(
      (c) => c.selectable && c.id !== this._current && this._inRange(c),
    );
    if (pool.length === 0) return false;

    let best: TargetCandidate | null = null;
    let bestScore = -Infinity;

    for (const c of pool) {
      const dx = c.x - this.originX;
      const dy = c.y - this.originY;
      let score = -Math.sqrt(dx * dx + dy * dy);   // 距离近的优先

      // 方向匹配加成
      if (dirX !== 0 || dirY !== 0) {
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 1e-6) {
          // 方向余弦：越接近指定方向分越高
          const cos = (dx / len) * dirX + (dy / len) * dirY;
          score += cos * 100;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best) {
      this._currentScore = bestScore;
      this._grace = this._graceTime;
      this._setCurrent(best.id);
      return true;
    }
    return false;
  }

  /** 在 hard 模式下，获取朝向目标的角度 */
  aimAngle(candidates: readonly TargetCandidate[]): number | null {
    if (this._current === null) return null;
    const c = candidates.find((x) => x.id === this._current);
    if (!c) return null;
    return Math.atan2(c.y - this.originY, c.x - this.originX);
  }

  // ---- 内部 ----

  private _setCurrent(id: number | null): void {
    if (this._current === id) return;
    const prev = this._current;
    this._current = id;
    this.onLock?.(id, prev);
  }

  private _inRange(c: TargetCandidate): boolean {
    const dx = c.x - this.originX;
    const dy = c.y - this.originY;
    const d2 = dx * dx + dy * dy;

    if (this._maxRange > 0 && d2 > this._maxRange * this._maxRange) return false;
    if (this._maxAngle < Math.PI) {
      if (d2 < 1e-12) return true;   // 重合，算在范围内
      const ang = Math.atan2(dy, dx);
      if (Math.abs(normalizeAngleRad(ang - this.facing)) > this._maxAngle) return false;
    }
    return true;
  }

  private _score(c: TargetCandidate, ctx: TargetingContext): number {
    let s = 0;
    for (const fn of this._scorers) s += fn(c, ctx);
    return s;
  }
}

// ============================================================
// 常用评分规则
// ============================================================

/**
 * 距离评分：越近分越高
 *
 * 【weight 的语义】
 * 距离每远 1 米扣 `weight` 分。
 * 典型值 1~5。值越大，"优先打近处"的倾向越强。
 */
export function byDistance(weight = 1): TargetScorer {
  return (c, ctx) => {
    const dx = c.x - ctx.originX;
    const dy = c.y - ctx.originY;
    return -Math.sqrt(dx * dx + dy * dy) * weight;
  };
}

/**
 * 角度评分：越正对分越高
 *
 * 【为什么重要】
 * 没有它的话，玩家想打正前方的怪，
 * 系统却锁了身后 1 米处的——角色突然回头，玩家完全懵掉。
 *
 * 这是"锁定手感差"的最常见原因。
 */
export function byAngle(weight = 1): TargetScorer {
  return (c, ctx) => {
    const dx = c.x - ctx.originX;
    const dy = c.y - ctx.originY;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) return weight;
    const ang = Math.atan2(dy, dx);
    const diff = Math.abs(normalizeAngleRad(ang - ctx.facing));
    // cos 映射：正对 = +weight，背后 = -weight
    return Math.cos(diff) * weight;
  };
}

/**
 * 粘性评分：保持当前目标
 *
 * 【用途】
 * 迟滞阈值之外再加一层保险。
 * 在 hard 锁定模式下，通常用较大的 weight（如 30）
 * 让目标一旦锁定就不轻易改变。
 */
export function byStickiness(weight = 10): TargetScorer {
  return (c, ctx) => (ctx.current !== null && c.id === ctx.current ? weight : 0);
}

/**
 * 自定义权重评分
 *
 * 【用途】"优先精英""优先残血""优先正在施法的"
 *
 * ```typescript
 * // 优先打血量低的
 * byWeight((c) => 1 - (c as any).hpRatio)
 * ```
 */
export function byWeight(fn: (c: TargetCandidate) => number, scale = 10): TargetScorer {
  return (c) => fn(c) * scale;
}
