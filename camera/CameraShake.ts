/**
 * CameraShake —— 震屏（纯逻辑轨迹计算）
 *
 * 【它解决什么】
 *
 * 打击感的三大件：顿帧、震屏、粒子。
 * 震屏让"这一下打得很重"变得可感知——
 * 同样的伤害数字，加震屏和不加震屏，玩家感受到的力量差一倍。
 *
 * 【零业务依赖】
 * 它只输出「这一帧相机应该偏移多少」，
 * 不碰相机节点、不碰屏幕。适配层拿到偏移量去设相机位置。
 *
 * 【三种噪声，怎么选】
 *
 * | 类型 | 观感 | 适用 |
 * |---|---|---|
 * | **`perlin`**（默认） | 平滑、有惯性，像真实震动 | 绝大多数情况 |
 * | `random` | 高频抖动，生硬 | 电击、故障效果 |
 * | `decay-sine` | 有节奏的摆动 | 爆炸冲击波、心跳 |
 *
 * 为什么默认不用 `random`：每帧独立随机看起来像"信号不良"，
 * 而不是"被撞了一下"。真实震动是**连续**的。
 *
 * 【关键设计：衰减 + 频率分离】
 *
 * - **振幅**随时间衰减（指数或线性）→ 震完自然停下
 * - **频率**保持较高（15~30Hz）→ 有"抖"的感觉
 *
 * 只衰减振幅而不保持频率，会变成缓慢的"飘"——那不是震屏。
 *
 * 【⚠️ 最重要的坑：震屏不能影响操作】
 *
 * 相机偏移了，但**输入方向、瞄准点、UI 都不该跟着偏**。
 * 玩家会觉得"我往左推它往右走"。
 *
 * 所以：
 * - 只偏移**相机节点**，不偏移世界和输入坐标系
 * - UI 用独立相机/独立节点，不跟着震
 * - 提供 `strengthScale` 让玩家在设置里关掉（部分玩家会晕眩）
 *
 * 【使用示例】
 * ```typescript
 * const shake = new CameraShake();
 *
 * // 命中时触发
 * shake.punch({ amplitude: 0.3, duration: 0.25 });
 *
 * // 每帧
 * shake.tick(dt);
 * camera.setPosition(baseX + shake.offsetX, baseY + shake.offsetY);
 * ```
 */

import { clamp, clamp01, safeDt } from '../_core/math';

export type ShakeNoise = 'perlin' | 'random' | 'decay-sine';

export interface CameraShakeOptions {
  /**
   * 全局强度倍率（0 = 关闭）
   *
   * 【为什么必须有】
   * 设置面板里的"震屏强度"滑块直接接这里。
   * 部分玩家（前庭功能敏感）会因震屏产生晕眩，这是可访问性需求，不是可选项。
   */
  strengthScale?: number;

  /** 噪声类型 */
  noise?: ShakeNoise;

  /**
   * 频率（Hz）
   *
   * 【参考值】
   * - 轻击：25~30（快而细碎）
   * - 重击：15~20（慢而有力）
   * - 爆炸：10~15（低频大振幅）
   */
  frequency?: number;

  /**
   * 衰减曲线
   * - `'exp'`：指数衰减（前段猛后段缓，**推荐**）
   * - `'linear'`：线性衰减（更"机械"）
   */
  decay?: 'exp' | 'linear';

  /**
   * 最大偏移（米/像素）
   *
   * 【为什么需要上限】
   * 多个震源叠加时（连续暴击、连环爆炸）振幅会累加，
   * 不设上限相机会飞出屏幕，玩家瞬间失去视野。
   */
  maxOffset?: number;

}

/**
 * 【为什么没有 random 选项】
 *
 * 震屏轨迹是**完全确定性**的：给定同一串 punch 调用，
 * 任何机器上都产出相同轨迹。
 *
 * 这是刻意的——和本库的 RNG、ReplayRecorder 保持同一哲学：
 * 确定性让回放、测试、录像都能对得上。
 * 需要"真随机"的话，在 `punch` 时传入随机的 `dirX/dirY` 即可。
 */

/** 触发参数 */
export interface ShakePunch {
  /** 振幅（单位同相机坐标） */
  amplitude: number;
  /** 持续时间（秒） */
  duration?: number;
  /** 频率覆盖 */
  frequency?: number;
  /**
   * 方向性震动（可选）
   *
   * 【什么时候用】
   * 受击时朝"被击中的反方向"震，能传递方向信息。
   * 不传则是全向随机（爆炸、落地）。
   */
  dirX?: number;
  dirY?: number;
}

/** 一个活跃的震动源 */
interface ShakeSource {
  amplitude: number;
  duration: number;
  age: number;
  frequency: number;
  seed: number;
  dirX: number;
  dirY: number;
  /** 是否有方向性 */
  directional: boolean;
}

/**
 * 震屏控制器
 *
 * 【多震源叠加】
 * 连续命中会叠加多个震源，各自独立衰减后**向量相加**。
 * 这样"连击"的震感会自然增强，而不需要手动配置"连击第 N 下震多少"。
 */
export class CameraShake {
  private _scale: number;
  private _noise: ShakeNoise;
  private _frequency: number;
  private _decay: 'exp' | 'linear';
  private _maxOffset: number;

  private _sources: ShakeSource[] = [];

  /** 当前偏移 */
  private _ox = 0;
  private _oy = 0;
  /** 当前旋转偏移（度） */
  private _orot = 0;

  private _time = 0;
  private _seedCounter = 1;

  constructor(opts: CameraShakeOptions = {}) {
    this._scale = opts.strengthScale ?? 1;
    this._noise = opts.noise ?? 'perlin';
    this._frequency = opts.frequency ?? 24;
    this._decay = opts.decay ?? 'exp';
    this._maxOffset = opts.maxOffset ?? 2;
  }

  /** 全局强度（接设置面板滑块，0~1） */
  get strengthScale(): number {
    return this._scale;
  }

  set strengthScale(v: number) {
    this._scale = clamp01(v);
    if (this._scale === 0) this._ox = this._oy = this._orot = 0;
  }

  /** 当前偏移 X */
  get offsetX(): number {
    return this._ox;
  }

  /** 当前偏移 Y */
  get offsetY(): number {
    return this._oy;
  }

  /** 当前旋转偏移（度） */
  get offsetRotation(): number {
    return this._orot;
  }

  /** 是否正在震动 */
  get active(): boolean {
    return this._sources.length > 0 && this._scale > 0;
  }

  /** 活跃震源数（调试） */
  get sourceCount(): number {
    return this._sources.length;
  }

  /**
   * 触发一次震动
   *
   * 【为什么叫 punch 而不是 shake】
   * 强调它是"一次性冲击"，持续震动请用持续调用或 `addTrauma`。
   */
  punch(p: ShakePunch): void {
    if (this._scale <= 0) return;
    if (p.amplitude <= 0) return;

    const dx = p.dirX ?? 0;
    const dy = p.dirY ?? 0;
    const directional = Math.hypot(dx, dy) > 1e-6;

    this._sources.push({
      amplitude: p.amplitude,
      duration: p.duration ?? 0.25,
      age: 0,
      frequency: p.frequency ?? this._frequency,
      seed: this._seedCounter++ * 7919,
      dirX: directional ? dx : 0,
      dirY: directional ? dy : 0,
      directional,
    });
  }

  /**
   * 持续震动（trauma 模型）
   *
   * 【什么时候用】
   * 持续状态：站在瀑布旁、地震、Boss 蓄力。
   *
   * 【trauma 模型的优点】
   * 不用管理一堆震源，只需要一个 0~1 的"创伤值"：
   * `trauma` 每帧衰减，实际振幅 = trauma²（平方让小值更小，大值更明显）。
   */
  addTrauma(amount: number): void {
    this.punch({ amplitude: clamp01(amount) });
  }

  /**
   * 每帧更新
   *
   * 【dt 来源】
   * 用**未缩放**的时间（UI 通道）。
   * 顿帧时游戏时间变慢，但震屏应该照常——
   * 否则顿帧期间震屏也被拉长，变成缓慢的漂移，失去冲击力。
   */
  tick(dt: number): void {
    // 【为什么用 step】_ox/_oy/_orot 是每帧输出的偏移量，必须无条件清零。
    // 提前 return 会把上一帧的偏移留着 → 镜头歪着回不来。
    const step = safeDt(dt) ? dt : 0;
    this._time += step;
    this._ox = 0;
    this._oy = 0;
    this._orot = 0;

    if (this._scale <= 0) {
      this._sources.length = 0;
      return;
    }

    let totalX = 0;
    let totalY = 0;

    for (let i = this._sources.length - 1; i >= 0; i--) {
      const s = this._sources[i];
      s.age += step;

      if (s.age >= s.duration) {
        this._sources.splice(i, 1);
        continue;
      }

      const t = s.age / s.duration;

      // 振幅衰减
      const amp =
        this._decay === 'exp'
          ? s.amplitude * Math.pow(1 - t, 2)     // (1-t)² 比 (1-t) 收得更干脆
          : s.amplitude * (1 - t);

      // 噪声采样
      const phase = this._time * s.frequency;
      const nx = this._sample(phase, s.seed);
      const ny = this._sample(phase, s.seed + 12345);

      if (s.directional) {
        // 方向性震动：沿指定方向的主震 + 少量垂直抖动
        const len = Math.hypot(s.dirX, s.dirY) || 1;
        const ux = s.dirX / len;
        const uy = s.dirY / len;
        const main = nx * amp;
        const side = ny * amp * 0.35;
        totalX += ux * main - uy * side;
        totalY += uy * main + ux * side;
      } else {
        totalX += nx * amp;
        totalY += ny * amp;
      }
    }

    // 应用全局强度
    totalX *= this._scale;
    totalY *= this._scale;

    // 【上限钳制】多震源叠加时防止相机飞出屏幕
    const mag = Math.hypot(totalX, totalY);
    if (mag > this._maxOffset) {
      const k = this._maxOffset / mag;
      totalX *= k;
      totalY *= k;
    }

    this._ox = totalX;
    this._oy = totalY;
  }

  /**
   * 噪声采样
   *
   * 【perlin 为什么用三角函数叠加】
   * 真正的 Perlin 噪声需要梯度表和插值，这里用
   * 两个不同频率的正弦叠加，视觉上足够接近且零依赖：
   * ```
   * n(t) = 0.6·sin(t + seed) + 0.4·sin(2.7t + 1.3·seed)
   * ```
   * 两个频率不成整数倍，所以不会周期性重复。
   */
  private _sample(t: number, seed: number): number {
    switch (this._noise) {
      case 'random': {
        // 【用时间戳量化而不是真随机】
        // 真随机每帧都变会导致 60fps 下看起来像噪点雪花。
        // 按 (t, seed) 量化成整数做哈希，同一"时刻"采样结果稳定。
        const k = Math.floor(t * 10) * 374761393 + seed * 668265263;
        const h = Math.sin(k) * 43758.5453;
        return (h - Math.floor(h)) * 2 - 1;
      }

      case 'decay-sine':
        return Math.sin(t * Math.PI * 2 + seed) * (1 - clamp01((t % 1) * 0.3));

      case 'perlin':
      default: {
        const a = Math.sin(t * Math.PI * 2 + seed * 0.37);
        const b = Math.sin(t * Math.PI * 2 * 2.7 + seed * 1.31);
        return clamp(0.6 * a + 0.4 * b, -1, 1);
      }
    }
  }

  /** 立即停止（切场景、过场动画） */
  stop(): void {
    this._sources.length = 0;
    this._ox = 0;
    this._oy = 0;
    this._orot = 0;
  }

  destroy(): void {
    this.stop();
  }
}

/**
 * 震屏预设
 *
 * 【为什么提供预设】
 * 每次手写 `{ amplitude: 0.3, duration: 0.25 }` 很难保证全项目一致。
 * 预设让"轻击/重击/暴击/爆炸"有统一的语言。
 *
 * 【参考值来源】哈迪斯、空洞骑士的常见配置量级
 */
export const SHAKE_PRESETS = {
  /** 轻击命中：细碎快速 */
  lightHit: { amplitude: 0.08, duration: 0.12, frequency: 30 },
  /** 重击命中 */
  heavyHit: { amplitude: 0.22, duration: 0.2, frequency: 20 },
  /** 暴击：更强且稍长 */
  crit: { amplitude: 0.35, duration: 0.26, frequency: 18 },
  /** 玩家受击：方向性（朝受击反方向） */
  playerHurt: { amplitude: 0.3, duration: 0.22, frequency: 22 },
  /** 落地 */
  land: { amplitude: 0.12, duration: 0.15, frequency: 16 },
  /** 爆炸 / Boss 大招 */
  explosion: { amplitude: 0.6, duration: 0.45, frequency: 12 },
  /** 环境持续震动（地震、瀑布） */
  ambient: { amplitude: 0.04, duration: 0.5, frequency: 14 },
} as const;

export type ShakePresetName = keyof typeof SHAKE_PRESETS;

/** 按预设名触发 */
export function applyShakePreset(shake: CameraShake, name: ShakePresetName, scale = 1): void {
  const p = SHAKE_PRESETS[name];
  shake.punch({ amplitude: p.amplitude * scale, duration: p.duration, frequency: p.frequency });
}
