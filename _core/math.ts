/**
 * _core/math.ts —— 极简数学工具
 *
 * 【为什么有 _core】
 * 铁律说"插件之间禁止横向 import"。但 clamp / lerp 这种纯函数如果每个插件复制一份，
 * 是另一种浪费（改一处要改十处）。
 *
 * 所以约定：**_core 是唯一的例外**——它只包含「零状态、零依赖、纯函数」的基础工具，
 * 可以被任何插件 import，且永远不会反向依赖任何插件。
 *
 * 判据：放进 _core 的东西必须满足「无任何状态、无副作用、不需要配置」。
 * 一旦某个工具需要状态或配置，它就应该成为一个独立插件。
 *
 * 【无引擎依赖】本文件不 import 任何 Cocos 模块，可脱离引擎单测。
 */

/** 把 v 限制在 [min, max] 区间内 */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 把 v 限制在 [0, 1] */
export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/**
 * 配置项兜底：非有限值时回退到默认值，并钳制到 [min, max]
 *
 * 【为什么不能只用 `Math.max(1, opts.x ?? 100)`】
 * `Math.max` / `Math.min` **不做有限性检查**：
 *
 * ```
 * Math.max(1, NaN)       === NaN     // 兜底失败，NaN 直接穿过去
 * Math.max(1, Infinity)  === Infinity
 * ```
 *
 * 后果是"上限字段"被静默绕过——比如撤销栈的 `limit` 变 NaN 后
 * `length > NaN` 恒为 false，栈永不裁剪，内存无限增长。
 *
 * 全库这类写法有 100+ 处，靠逐处 review 杜绝不了，
 * 所以统一收口到这里：以后所有"配置项给个兜底值"的地方都调它。
 *
 * @param v 原始值（通常是 `opts.xxx ?? fallback`，可能来自存档/配置表）
 * @param min 下界（含）
 * @param max 上界（含）
 * @param fallback 非有限值时使用的兜底值
 */
export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = numOr(v, NaN);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

/**
 * 只兜「非有限值」，不设上界。
 *
 * 【为什么还需要它，有 clampNum 不就够了吗】
 * clampNum 强制要求 min/max 两个界。对"容量/上限"类字段
 * （limit / capacity / bufferSize）定上界是对的——
 * Infinity 会让裁剪判定恒为 false，内存无限增长。
 *
 * 但对普通配置项定上界会**误伤合法值**：
 *
 * ```
 * transitionMs: 600_000   // 10 分钟转场，完全合法
 * clampNum(v, 1, 1e6, 300)  → 600000 未被误伤（1e6 够大）
 * clampNum(v, 1, 1e4, 300)  → 被裁成 10000，用户的配置悄悄失效
 * ```
 *
 * 也就是说，定上界这个动作本身需要"理解每个字段的业务上限"，
 * 猜错了就是**静默改掉用户的合法配置**——比 NaN 穿透更隐蔽。
 *
 * 所以两类字段分开处理：
 * - 容量/上限类 → `clampNum`（人工定上界，防内存无限增长）
 * - 普通配置类 → `numOr` + 原有的 `Math.max/min`（只兜 NaN/Infinity）
 *
 * @param v 原始值
 * @param fallback 非有限值（NaN / ±Infinity / undefined / 非数字）时使用的值
 */
export function numOr(v: unknown, fallback: number): number {
  /**
   * 【坑】`Number(null) === 0`、`Number('') === 0`、`Number([]) === 0`。
   *
   * 这三个都是 JS 的隐式转换陷阱，而它们恰好是"配置缺失"最常见的三种形态：
   * - JSON 反序列化出 `{ "limit": null }`
   * - 配置表里某格留空 → `''`
   * - 误把数组传进来 → `[]`
   *
   * 走 `Number(v)` 的话它们全部变成 **0**，而不是回退到 fallback。
   * 后果对"容量/上限"类字段尤其致命：`limit = 0` 意味着
   * 撤销栈 / 对象池 / 缓存**容量归零**，而且不报错、不告警。
   *
   * 所以缺值判定必须先于数值转换，且要显式覆盖 null 与空串。
   */
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * dt 守卫：只有"有限且为正"才返回 true
 *
 * 【三种常见写法的盲区】
 *
 * | 写法                        | 负数 | NaN | Infinity |
 * |---------------------------|------|-----|----------|
 * | `if (dt <= 0) return;`     | ✅挡 | ❌穿 | ❌穿     |
 * | `if (!(dt > 0)) return;`   | ✅挡 | ✅挡 | ❌穿     |
 * | `Math.max(0, x - dt)`      | ❌反向 | ❌变NaN | ✅归零 |
 * | **`safeDt(dt)`**           | ✅挡 | ✅挡 | ✅挡     |
 *
 * 为什么前两种挡不住：
 * - `NaN <= 0` 是 `false`，所以 `dt <= 0` 对 NaN 无效
 * - `Infinity > 0` 是 `true`，所以 `!(dt > 0)` 对 Infinity 无效
 *
 * 【后果有多严重】
 * 一个 NaN 帧就能让角色坐标永久变 NaN（再正常几百帧也回不来，
 * 因为 `NaN + 任何数 === NaN`），角色从游戏中消失且不报错。
 *
 * 负数 dt 则会让冷却/计时器**反向延长**，且同样不可自愈。
 *
 * @example
 * ```typescript
 * update(dt: number): void {
 *   if (!safeDt(dt)) return;
 *   // ...
 * }
 * ```
 */
export function safeDt(dt: number): boolean {
  return Number.isFinite(dt) && dt > 0;
}

/**
 * 数组最大值（空数组返回 `fallback`，而不是 `-Infinity`）
 *
 * 【为什么不能直接用 `Math.max(...xs)`】
 *
 * 三个坑，全都是**静默**的：
 *
 * | 场景 | `Math.max(...xs)` | `maxOf(xs, fb)` |
 * |---|---|---|
 * | `xs = []` | **`-Infinity`** | `fb` |
 * | `xs` 有 NaN | `NaN`（传染） | `NaN`（同样传染，见下） |
 * | `xs` 超 10 万项 | **`RangeError` 栈溢出** | 正常 |
 *
 * 空数组那条最危险：`-Infinity` 参与后续运算时不会报错，
 * 只会让 `if (x > 0)` 恒为 false——表现为"这个分支永远不走"，
 * 排查时没人会想到源头是个空数组。
 *
 * 【为什么 NaN 保持传染，不静默跳过】
 *
 * 循环里写 `if (x > m)` 时 NaN 会被天然跳过，要"跳过"只要不管就行。
 * 但那是**静默掩盖数据损坏**：某个玩家 rating 是 NaN 时，
 * 拿到"剩余玩家的最高分"看起来完全正常，坏数据就被吞了。
 *
 * 所以这里刻意保持与 `Math.max` 一致的 NaN 传染语义——
 * 让错误继续可见，由更懂业务的上游决定怎么处理。
 *
 * 【为什么用循环而不是展开】
 *
 * 展开是 `f(a, b, c, ...)`，参数个数受调用栈限制。
 * 实测 200 万项直接 `RangeError: Maximum call stack size exceeded`。
 * 排行榜、热度图这类场景完全可能到这个量级。
 *
 * @param xs 输入数组
 * @param fallback 数组为空时返回的值（**调用方必须显式想清楚空集意味着什么**）
 */
export function maxOf(xs: readonly number[], fallback = 0): number {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    // NaN 参与的比较恒为 false，所以 NaN 会被跳过；
    // 但上面"为什么 NaN 保持传染"说了不该静默跳过——
    // 所以这里显式检测，遇到 NaN 就返回 NaN，与 Math.max 一致。
    if (Number.isNaN(x)) return NaN;
    if (x > m) m = x;
  }
  return m === -Infinity ? fallback : m;
}

/** 数组最小值（空数组返回 `fallback`，而不是 `Infinity`）。详见 {@link maxOf} */
export function minOf(xs: readonly number[], fallback = 0): number {
  let m = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    if (Number.isNaN(x)) return NaN;
    if (x < m) m = x;
  }
  return m === Infinity ? fallback : m;
}

/** 线性插值：t=0 返回 a，t=1 返回 b */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 反向插值：求 v 在 [a,b] 中的比例（a===b 时返回 0，避免除零） */
export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/** 区间重映射：把 v 从 [inMin,inMax] 映射到 [outMin,outMax] */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, v)));
}

/**
 * 浮点相等比较
 *
 * 【坑】永远不要用 === 比较浮点数。0.1 + 0.2 !== 0.3，
 * 而且误差会累积——移动十次之后偏差可能已经很大。
 */
export function approximately(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon;
}

// ==================== 角度 ====================

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/**
 * 【坑】角度取模：JS 的 % 对负数返回负值（-10 % 360 === -10），
 * 这在角度运算里会导致方向反转。必须用这个修正版。
 */
export function wrapAngle(deg: number): number {
  const a = deg % 360;
  return a < 0 ? a + 360 : a;
}

/** 两角之间的最短差值（考虑绕圈）：350° 与 10° 的差是 20°，不是 -340° */
export function angleDiff(from: number, to: number): number {
  const d = wrapAngle(to - from);
  return d > 180 ? d - 360 : d;
}

/**
 * 角度插值（走最短路径）
 *
 * 【坑】直接 lerp(350, 10, 0.5) 得到 180，物体会转半圈。
 * 正确做法是先算最短差值再加上去。
 */
export function angleLerp(from: number, to: number, t: number): number {
  return wrapAngle(from + angleDiff(from, to) * clamp01(t));
}

// ============================================================
// 弧度版（与上面的角度版**不要混用**）
// ============================================================

/**
 * 归一化角度到 [-π, π]（弧度）
 *
 * 【为什么同时存在角度版和弧度版】
 * JS 的 `Math.atan2`、`Math.cos/sin` 全部用弧度，
 * 而设计师配置表、UI 显示习惯用角度。
 * 两套 API 都会用到。
 *
 * 【⚠️ 混用的代价】
 * 把 30° 当成 30 弧度传进去，得到的方向是随机的——
 * 表现为"视锥方向乱七八糟""弹幕歪向一边"，
 * 而且**不报错**，只能靠肉眼发现。
 *
 * 所以命名上明确区分：`wrapAngle`（度）vs `normalizeAngleRad`（弧度）。
 */
export function normalizeAngleRad(a: number): number {
  // 【为什么改成取模，而不是给 while 加 guard】
  //
  // 原实现是 while 循环递减：
  //   while (x > Math.PI) x -= Math.PI * 2;
  //
  // `Infinity - 2π` 仍然是 `Infinity`，循环条件恒真 → **死循环**，
  // 进程 CPU 100% 永久卡死。实测 5 秒超时未返回。
  //
  // 加 guard（如 `guard++ < 8`）能避免卡死，但会引入新问题：
  // "上限设多少才够"没有客观答案——角度 10000 需要转 1592 次。
  // 取模是 O(1)，且**结构上不可能死循环**，没有这个二次决策。
  //
  // 【非有限值归一到 0，不是返回 NaN】
  // NaN 若透传，下游 `ad > halfAngle` 恒为 false → 感知静默失效、
  // 判定结果不可预测，比"当作 0"更难排查。0 是一个确定且可解释的取值。
  if (!Number.isFinite(a)) return 0;

  // JS 的 % 对负数返回负值（-10 % 360 === -10），
  // 先加 TAU 再取模才能保证落在 [0, TAU)，最后平移到 [-π, π]。
  const TAU = Math.PI * 2;
  return (((a + Math.PI) % TAU) + TAU) % TAU - Math.PI;
}

/** 两角最短差值（弧度）：-π..π */
export function angleDiffRad(from: number, to: number): number {
  return normalizeAngleRad(to - from);
}

/** 角度插值（弧度，走最短路径） */
export function angleLerpRad(from: number, to: number, t: number): number {
  return from + angleDiffRad(from, to) * clamp01(t);
}

/**
 * 帧率无关的平滑阻尼
 *
 * 【为什么需要它】
 * 常见的 `cur = lerp(cur, target, 0.1)` 是**帧率相关**的：
 * 120Hz 屏幕每帧执行 120 次，跟随比 60Hz 紧一倍。
 * 这是很多「感觉不对但说不上来」的手感问题的根源。
 *
 * smoothDamp 用 dt 参与计算，任何帧率下表现一致。
 *
 * @param current 当前值
 * @param target 目标值
 * @param velRef 速度引用对象（**必须在外部保存并在调用间保持**，这是阻尼的"记忆"）
 * @param smoothTime 大约多久到达目标（秒），越小越快
 * @param dt 帧间隔（秒）
 */
export function smoothDamp(
  current: number,
  target: number,
  velRef: { v: number },
  smoothTime: number,
  dt: number,
  maxSpeed = Infinity
): number {
  /**
   * 【坑】smoothTime 为 NaN / undefined 时，`Math.max(0.0001, NaN)` 得到 **NaN**，
   * 之后 omega、exp、output 全是 NaN，并且**不会自愈**——
   * velRef.v 被写坏后，后续每一帧都基于坏值继续算。
   * 配置里 smoothTime 来自外部（存档 / 策划表）时这条必然触发。
   */
  smoothTime = Math.max(0.0001, numOr(smoothTime, 0.0001));
  const omega = 2 / smoothTime;

  const x = omega * dt;
  // 泰勒展开近似 exp(-x)，比 Math.exp 快且足够精确
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  let change = current - target;
  const maxChange = maxSpeed * smoothTime;
  change = clamp(change, -maxChange, maxChange);

  /**
   * 【⚠️ 这一行是 maxSpeed 生效的关键，缺了它就等于没限速】
   *
   * 限速之后，"这一帧要奔赴的目标点"必须跟着回退到 `current - change`，
   * 不能再直接用调用方传进来的 target。
   *
   * 缺这一行时（本文件的历史实现）：
   *   current = 0, target = 100, maxSpeed = 5, dt = 1/60
   *   → output = target + (change + temp) * exp ≈ 100 - 1×0.85 ≈ **99.01**
   *   一帧就跳到 99，maxSpeed 完全被绕过，而且比不限速还跳得更快
   *   （不限速时首帧只走到 1.22）。
   *
   * 症状极具迷惑性："明明设了最大速度，镜头瞬移时反而闪现得更远"。
   */
  const limitedTarget = current - change;

  const temp = (velRef.v + omega * change) * dt;
  velRef.v = (velRef.v - omega * temp) * exp;

  let output = limitedTarget + (change + temp) * exp;

  // 防止越过目标后抖动
  if (target - current > 0 === output > target) {
    output = target;
    // 【坑】dt 为 0 时这里是 0/0 → NaN，会把 velRef 永久写坏，之后再正常也回不来
    velRef.v = dt > 0 ? (output - target) / dt : 0;
  }
  return output;
}

// ==================== 缓动 ====================

/**
 * 缓动函数集合（全部接受并返回 0..1）
 *
 * 【为什么缓动重要】
 * out 类（先快后慢）适合 UI 出现、相机跟随；
 * in 类（先慢后快）适合物体被吸走；
 * Back/Elastic 适合强调反馈（如获得奖励）。
 * 同样 0.3 秒的动画，用 linear 和 outBack 完全是两种质感。
 */
export const Easing = {
  linear: (t: number) => t,

  inQuad: (t: number) => t * t,
  outQuad: (t: number) => t * (2 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),

  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => {
    const f = t - 1;
    return f * f * f + 1;
  },
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),

  outQuart: (t: number) => 1 - Math.pow(1 - t, 4),
  inOutQuart: (t: number) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),

  outExpo: (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),

  /** 回弹：冲过目标再弹回，适合"获得奖励"的强调 */
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },

  /** 弹性：来回衰减，适合强反馈（如暴击、升级） */
  outElastic: (t: number) => {
    const c4 = (2 * Math.PI) / 3;
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },

  /** 弹跳：落地弹几下 */
  outBounce: (t: number) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
} as const;

export type EasingName = keyof typeof Easing;

/**
 * 按名字取缓动函数，未知名回退到 linear（不抛异常，配置填错时不该崩）
 *
 * 【⚠️ 必须用 hasOwnProperty 挡一层原型链】
 *
 * 直接 `(Easing as Record<string, fn>)[name]` 时，配置里填了
 * `'toString'` / `'constructor'` / `'valueOf'` 这类 Object.prototype 上的名字，
 * 会取到**原型方法**而不是回退 linear：
 *
 * ```
 * easing('toString')(0.5)     → "[object Undefined]"（字符串！）
 * easing('constructor')(0.5)  → 一个对象
 * ```
 *
 * 后果比抛异常糟得多：返回值不是数字，下游 `x + 插值结果` 立刻变 NaN，
 * 表现为"角色瞬移到 (NaN, NaN) 消失"，且没有任何报错。
 * 配置表 / 存档是外部输入，这类名字完全可能混进来。
 */
export function easing(name: EasingName | string): (t: number) => number {
  const table = Easing as Record<string, (t: number) => number>;
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : Easing.linear;
}
