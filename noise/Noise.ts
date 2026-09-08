import { needCount, needFinite } from '../_core/guard';
import { clampNum, numOr } from '../_core/math';

/**
 * noise —— 程序化噪声（地形 / 纹理 / 随机分布）
 *
 * 【它解决什么】
 *
 * 用 `Math.random()` 生成地形会得到**电视雪花**——
 * 每个点完全独立，没有任何结构，看起来像噪点而不是地形。
 *
 * 噪声函数生成的是**平滑的随机**：相邻值接近，
 * 整体有起伏、有山脉、有盆地。这是所有程序化生成的基础。
 *
 * 【收录】
 * | 函数 | 特点 | 适用 |
 * |---|---|---|
 * | `Perlin` | 经典，各方向都有格子感 | 通用地形 |
 * | `Simplex` | Perlin 的改进，无明显方向性，更快 | **推荐**，大部分场景 |
 * | `ValueNoise` | 最简单最快，质量略差 | 对性能敏感 |
 * | `fbm` | 分形叠加（多个倍频） | 真实感地形 |
 * | `Worley` | 细胞噪声（Voronoi） | 石头纹理、龟裂、区域划分 |
 *
 * 【核心概念：倍频（Octave）】
 *
 * 单个噪声只有一个"尺度"，看起来太圆滑。
 * 真实地形有大起伏（山脉）也有小细节（碎石）。
 *
 * `fbm` 把多个不同频率的噪声叠加：
 * ```
 * frequency × 2, amplitude × 0.5，重复 N 次
 * ```
 * 这叫"分形布朗运动"，是生成自然地形的标准做法。
 *
 * 【使用示例】
 * ```typescript
 * const noise = new SimplexNoise(12345);
 *
 * // 单层
 * noise.noise2D(x * 0.01, y * 0.01);    // -1 ~ 1
 *
 * // 归一化到 0~1
 * (noise.noise2D(x, y) + 1) / 2;
 *
 * // 分形地形（推荐）
 * const h = fbm2D(noise, x * 0.005, y * 0.005, {
 *   octaves: 5,
 *   frequency: 1,
 *   amplitude: 1,
 *   lacunarity: 2,     // 频率倍率
 *   persistence: 0.5,  // 振幅衰减
 * });
 *
 * // 生成高度图
 * const map = generateHeightmap(64, 64, (x, y) => fbm2D(...));
 * ```
 *
 * 【无引擎依赖】
 */

// ============================================================
// 工具
// ============================================================

function mulberry32(seed: number): () => number {
  /**
   * 【⚠️ 非有限 seed 必须在这里拦住，不能让 `>>> 0` 静默吃掉】
   *
   * `NaN >>> 0 === 0`、`Infinity >>> 0 === 0`、
   * 所以 `new Noise(NaN)` 会**静默**变成 `new Noise(0)`。
   * seed 来自配置表、存档或字符串 hash 时，一旦算成 NaN/undefined，
   * 所有地图 / 怪物分布 / 掉落抖动全部退化成 seed 0 的同一份结果。
   * 现象是"每次进游戏地形一模一样，但代码里明明传了不同 seed"——
   * 排查时会去查 scale、查采样坐标，没人会想到 seed 已经塌成 0。
   *
   * 本单元的卖点是**确定性**，与它相称的做法是"坏种子立刻失败"，
   * 而不是悄悄给你一张 seed 0 的图。
   *
   * 【为什么守在这里而不是每个类的构造函数】
   * `PerlinNoise` / `SimplexNoise` / `ValueNoise` / `WorleyNoise` 四个类
   * 最终都从这里取随机流，一处收口全覆盖；漏掉一个就会重新长出这个坑。
   */
  let a = needFinite(seed, 'seed') >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平滑插值曲线 6t⁵-15t⁴+10t³（比 lerp 更自然，二阶连续） */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 2D 梯度方向表（12 个，避开轴向以减少格子感）
 *
 * 【为什么提成模块级常量】
 * 它原本在 `PerlinNoise` 和 `SimplexNoise` 里各存了一份，逐字相同。
 * 两份拷贝的问题不是多占几十字节，而是**改一份忘另一份**：
 * 调梯度的人只改了一处，两种噪声的输出会悄悄分叉，
 * 而没人会把"两种噪声长得不一样"跟这次改动联系起来。
 */
const GRAD2: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
];

/**
 * `noise3D` 的 z 方向切片间距
 *
 * 【这是个观感参数，不是推导出来的数学常数】
 * 唯一要求是"足够大，让相邻切片之间不相关"；取无理数是为了避免与整数格点共振。
 * 埋在算式里会让人以为它是算出来的系数、不敢改，所以提成一个有名有姓的常量。
 */
const NOISE3D_SLICE_SPACING = 37.7;

/** 把置换表按种子打乱 */
function buildPermutation(seed: number, size = 256): Uint8Array {
  const p = new Uint8Array(size);
  for (let i = 0; i < size; i++) p[i] = i;

  const rand = mulberry32(seed);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }

  return p;
}

// ============================================================
// Perlin 噪声
// ============================================================

/**
 * 经典 Perlin 噪声
 *
 * 【原理】
 * 在整数格点上放随机梯度向量，
 * 取查询点与各格点的点积，再做平滑插值。
 *
 * 【特点】
 * 有明显的"格子感"（沿轴向的伪影），
 * 但胜在经典、实现简单、结果可预期。
 *
 * 【输出范围】约 -1 ~ 1（理论上 ±√(n/2)，2D 约 ±0.707，实测常被夹到 ±1）
 *
 * 【为什么库内部不用它、却仍然导出】
 * 确实：`Noise` 统一入口只用 `SimplexNoise`，本单元内部没有任何代码引用 `PerlinNoise`。
 * 但它是 **export 的公开 API**，删掉会直接破坏已经 `import { PerlinNoise }` 的使用者；
 * 而"格子感"本身就是一种画风需求（像素/复古地形常故意要它），不是缺陷。
 * 所以保留导出，并在这里说明它的定位，而不是静悄悄地留一个没人解释的类。
 */
export class PerlinNoise {
  private readonly _perm: Uint8Array;
  private readonly _permMod12: Uint8Array;

  constructor(seed = 0) {
    this._perm = buildPermutation(seed);
    // 扩展成 512，避免索引越界时取模
    const ext = new Uint8Array(512);
    for (let i = 0; i < 512; i++) ext[i] = this._perm[i & 255];
    this._perm = ext;

    this._permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this._permMod12[i] = this._perm[i] % 12;
  }

  /** 2D 噪声，返回约 -1 ~ 1 */
  noise2D(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;

    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    const u = fade(xf);
    const v = fade(yf);

    const aa = this._permMod12[this._perm[X] + Y];
    const ab = this._permMod12[this._perm[X] + Y + 1];
    const ba = this._permMod12[this._perm[X + 1] + Y];
    const bb = this._permMod12[this._perm[X + 1] + Y + 1];

    const g = GRAD2;

    const dotAA = g[aa][0] * xf + g[aa][1] * yf;
    const dotBA = g[ba][0] * (xf - 1) + g[ba][1] * yf;
    const dotAB = g[ab][0] * xf + g[ab][1] * (yf - 1);
    const dotBB = g[bb][0] * (xf - 1) + g[bb][1] * (yf - 1);

    const x1 = lerp(dotAA, dotBA, u);
    const x2 = lerp(dotAB, dotBB, u);

    return lerp(x1, x2, v) * 1.4;   // 放大到接近 ±1
  }

  /** 1D 噪声 */
  noise1D(x: number): number {
    return this.noise2D(x, 0.5);
  }
}

// ============================================================
// Simplex 噪声（推荐）
// ============================================================

/**
 * Simplex 噪声 —— Perlin 的改进版
 *
 * 【和 Perlin 的区别】
 * - 用**单形**（三角形）而不是立方体网格 → 无明显方向性伪影
 * - 计算量更小（2D 只需 3 个顶点，Perlin 要 4 个）
 * - 质量更好，尤其是高维
 *
 * **默认用这个。**
 */
export class SimplexNoise {
  private readonly _perm: Uint8Array;
  private readonly _permMod12: Uint8Array;

  /** 2D 单形的偏斜常数 */
  private static readonly F2 = 0.5 * (Math.sqrt(3) - 1);
  private static readonly G2 = (3 - Math.sqrt(3)) / 6;

  constructor(seed = 0) {
    const base = buildPermutation(seed);
    this._perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this._perm[i] = base[i & 255];
    this._permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this._permMod12[i] = this._perm[i] % 12;
  }

  /** 2D 噪声，返回约 -1 ~ 1 */
  noise2D(xin: number, yin: number): number {
    const g = GRAD2;

    // 偏斜到单形网格
    const s = (xin + yin) * SimplexNoise.F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);

    const t = (i + j) * SimplexNoise.G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = xin - X0;
    const y0 = yin - Y0;

    // 确定在哪个三角形
    let i1: number;
    let j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }

    const x1 = x0 - i1 + SimplexNoise.G2;
    const y1 = y0 - j1 + SimplexNoise.G2;
    const x2 = x0 - 1 + 2 * SimplexNoise.G2;
    const y2 = y0 - 1 + 2 * SimplexNoise.G2;

    const ii = i & 255;
    const jj = j & 255;

    let n0 = 0;
    let n1 = 0;
    let n2 = 0;

    // 三个顶点的贡献
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const gi0 = this._permMod12[ii + this._perm[jj]];
      t0 *= t0;
      n0 = t0 * t0 * (g[gi0][0] * x0 + g[gi0][1] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const gi1 = this._permMod12[ii + i1 + this._perm[jj + j1]];
      t1 *= t1;
      n1 = t1 * t1 * (g[gi1][0] * x1 + g[gi1][1] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const gi2 = this._permMod12[ii + 1 + this._perm[jj + 1]];
      t2 *= t2;
      n2 = t2 * t2 * (g[gi2][0] * x2 + g[gi2][1] * y2);
    }

    return 70 * (n0 + n1 + n2);
  }

  /**
   * 3D 噪声（用于体积雾、3D 地形）
   *
   * 【⚠️ 这是"伪 3D"：z 方向是 2D 切片插值，不是真 3D 单纯形】
   *
   * 实现是 `lerp(noise2D(x, y + iz·D), noise2D(x, y + (iz+1)·D), fade(fz))`。
   * 后果是**各向异性**：z 方向的特征尺度与 xy 完全不同。
   * 实测（seed 7）：沿 x 走 1 个单位，输出变化约 0.198；
   * 沿 z 走 1 个单位，输出变化约 1.005——差 5 倍。
   * 拿它做 3D 地形 / 云体积，会看到明显的"层叠切片"感，
   * 沿 z 拉长的结构与沿 xy 完全不同。
   *
   * 大多数游戏（分层地形、随时间演化的 2D 噪声）看不出区别，
   * 这就是它留在这里的原因；但如果你需要**各向同性**的 3D 噪声，
   * 这个方法不适用，得换真 3D 单纯形实现。
   */
  noise3D(xin: number, yin: number, zin: number): number {
    // 3D 实现较冗长，这里用简化的：三层 2D 切片插值
    // 对于大多数游戏够用，且代码量小得多
    const iz = Math.floor(zin);
    const fz = zin - iz;

    const a = this.noise2D(xin, yin + iz * NOISE3D_SLICE_SPACING);
    const b = this.noise2D(xin, yin + (iz + 1) * NOISE3D_SLICE_SPACING);

    return lerp(a, b, fade(fz));
  }
}

// ============================================================
// Value 噪声（最快，质量略差）
// ============================================================

/**
 * 值噪声：格点上是随机值（不是梯度），直接插值
 *
 * 【和 Perlin 的区别】
 * Perlin 格点上存梯度向量，值噪声存标量。
 * 值噪声更快，但有更明显的"块状"感。
 *
 * 对性能敏感且对质量要求不高时用（比如每帧生成的粒子扰动）。
 */
export class ValueNoise {
  private readonly _values: Float64Array;
  private readonly _mask: number;

  constructor(seed = 0, size = 256) {
    // size 必须是 2 的幂
    if ((size & (size - 1)) !== 0) throw new Error('[ValueNoise] size 必须是 2 的幂');

    this._values = new Float64Array(size * size);
    this._mask = size - 1;

    const rand = mulberry32(seed);
    for (let i = 0; i < this._values.length; i++) {
      this._values[i] = rand() * 2 - 1;
    }
  }

  noise2D(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;

    const u = fade(xf);
    const v = fade(yf);

    const m = this._mask;
    const x0 = xi & m;
    const y0 = yi & m;
    const x1 = (xi + 1) & m;
    const y1 = (yi + 1) & m;

    const v00 = this._values[y0 * (m + 1) + x0];
    const v10 = this._values[y0 * (m + 1) + x1];
    const v01 = this._values[y1 * (m + 1) + x0];
    const v11 = this._values[y1 * (m + 1) + x1];

    return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
  }
}

// ============================================================
// 分形布朗运动（fBm）
// ============================================================

export interface FbmOptions {
  /** 倍频数（层数）。越多细节越丰富，也越慢 */
  octaves?: number;
  /** 频率倍率（lacunarity），通常 2 */
  lacunarity?: number;
  /** 振幅衰减（persistence），通常 0.5 */
  persistence?: number;
  /** 初始振幅 */
  amplitude?: number;
  /** 初始频率 */
  frequency?: number;
}

/**
 * 分形噪声：多个倍频叠加
 *
 * 【为什么必需】
 * 单层噪声只有一种尺度，看起来像"平滑的橡皮泥"。
 * 叠加 5 层后才有"大陆 → 山脉 → 丘陵 → 碎石"的层次。
 *
 * 【参数怎么调】
 * - `octaves`: 4~6 合适。超过 8 肉眼看不出差别，纯浪费性能
 * - `persistence`: 0.5 是标准。
 *     - 调高（0.7）→ 细节更强，地形更"毛躁"
 *     - 调低（0.3）→ 更平滑，像被侵蚀过的高原
 * - `lacunarity`: 2.0 是标准。调高会让细节更"密"
 *
 * 【注意】返回值范围不是严格 ±1。
 * 归一化时用 `normalizeFbm` 或自己 clamp。
 */
export function fbm2D(
  noise: { noise2D(x: number, y: number): number },
  x: number,
  y: number,
  opts: FbmOptions = {}
): number {
  /**
   * 【⚠️ octaves 必须有上界】
   *
   * 它直接就是下面的 `for (let i = 0; i < octaves; i++)` 次数。
   * 早年它没有任何守卫：`Infinity` 会让主循环永不结束（进程级卡死），
   * `NaN` 会让循环体一次都不执行、`maxValue` 停在 0，最后静默返回 0——
   * 地形变成一片平原，不报错、不崩溃，
   * 排查时会去查种子、查 scale，没人会想到 octaves。
   * 现在由 `needCount` 收口（有限整数 + 上界 64），坏值直接抛错。
   */
  const octaves = needCount(opts.octaves ?? 4, 'opts.octaves', 64);

  /**
   * 【⚠️ lacunarity / persistence 也必须收口】
   *
   * 这两个是循环里的乘子，`??` 挡不住 NaN，`Math.max` 也挡不住 NaN：
   *
   * - `lacunarity = 0`：`frequency` 从第二层起恒为 0，
   *   每一层都在采样同一个点 → 退化成"同一层重复叠加"，地形出现诡异的重复纹理。
   * - `persistence = NaN / 负数`：`amplitude` 变 NaN 或符号翻转，
   *   `maxValue` 累加成 NaN 或负数 → 走 `maxValue > 0 ? ... : 0` 分支，
   *   **整张图静默变成 0**。
   *
   * 范围选择：
   * - `lacunarity ∈ [1, 16]`：分形要求逐层加密，< 1 意味着越往后越"糊"，
   *   实际没人这么用（JSDoc 推荐 2）；上界 16 防止 frequency 叠成 Infinity。
   * - `persistence ∈ [0, 1]`：0 = 只要第一层（等价于单层噪声，合法），
   *   1 = 不衰减（合法上界）；越界值会让归一化失去意义。
   *
   * 【为什么这里用 clampNum 兜底、而 octaves 用 needCount 抛错】
   * octaves 是循环次数，越界会**卡死进程**，必须让调用方立刻失败；
   * 这两个是观感参数，夹到合法区间后仍能出一张合理的图——
   * 让地形生成器因为配置表里一个笔误就整局崩溃，代价不成比例。
   */
  const lacunarity = clampNum(opts.lacunarity, 1, 16, 2);
  const persistence = clampNum(opts.persistence, 0, 1, 0.5);

  // 振幅 / 频率只挡非有限值：0 和极大值都可能是调用方想要的合法输入
  let amplitude = numOr(opts.amplitude, 1);
  let frequency = numOr(opts.frequency, 1);

  let total = 0;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    total += noise.noise2D(x * frequency, y * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  // 归一化到 -1~1
  return maxValue > 0 ? total / maxValue : 0;
}

/**
 * 山脊噪声（ridged）—— 生成山脉
 *
 * 【原理】
 * 把噪声取绝对值再反转：`1 - |n|`。
 * 原本的"零交叉线"变成**山脊**，
 * 叠加后产生非常逼真的山脉走向。
 *
 * 普通 fbm 生成的是"丘陵"，ridged 生成的是"山脉"。
 */
export function ridged2D(
  noise: { noise2D(x: number, y: number): number },
  x: number,
  y: number,
  opts: FbmOptions = {}
): number {
  /**
   * 【⚠️ octaves 必须有上界】
   *
   * 它直接就是下面的 `for (let i = 0; i < octaves; i++)` 次数。
   * 早年它没有任何守卫：`Infinity` 会让主循环永不结束（进程级卡死），
   * `NaN` 会让循环体一次都不执行、`maxValue` 停在 0，最后静默返回 0——
   * 地形变成一片平原，不报错、不崩溃，
   * 排查时会去查种子、查 scale，没人会想到 octaves。
   * 现在由 `needCount` 收口（有限整数 + 上界 64），坏值直接抛错。
   */
  const octaves = needCount(opts.octaves ?? 4, 'opts.octaves', 64);

  /**
   * 【⚠️ lacunarity / persistence 也必须收口】
   *
   * 这两个是循环里的乘子，`??` 挡不住 NaN，`Math.max` 也挡不住 NaN：
   *
   * - `lacunarity = 0`：`frequency` 从第二层起恒为 0，
   *   每一层都在采样同一个点 → 退化成"同一层重复叠加"，地形出现诡异的重复纹理。
   * - `persistence = NaN / 负数`：`amplitude` 变 NaN 或符号翻转，
   *   `maxValue` 累加成 NaN 或负数 → 走 `maxValue > 0 ? ... : 0` 分支，
   *   **整张图静默变成 0**。
   *
   * 范围选择：
   * - `lacunarity ∈ [1, 16]`：分形要求逐层加密，< 1 意味着越往后越"糊"，
   *   实际没人这么用（JSDoc 推荐 2）；上界 16 防止 frequency 叠成 Infinity。
   * - `persistence ∈ [0, 1]`：0 = 只要第一层（等价于单层噪声，合法），
   *   1 = 不衰减（合法上界）；越界值会让归一化失去意义。
   *
   * 【为什么这里用 clampNum 兜底、而 octaves 用 needCount 抛错】
   * octaves 是循环次数，越界会**卡死进程**，必须让调用方立刻失败；
   * 这两个是观感参数，夹到合法区间后仍能出一张合理的图——
   * 让地形生成器因为配置表里一个笔误就整局崩溃，代价不成比例。
   */
  const lacunarity = clampNum(opts.lacunarity, 1, 16, 2);
  const persistence = clampNum(opts.persistence, 0, 1, 0.5);

  // 振幅 / 频率只挡非有限值：0 和极大值都可能是调用方想要的合法输入
  let amplitude = numOr(opts.amplitude, 1);
  let frequency = numOr(opts.frequency, 1);

  let total = 0;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise.noise2D(x * frequency, y * frequency));
    total += n * n * amplitude;    // 平方让山脊更锐利
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return maxValue > 0 ? total / maxValue : 0;
}

// ============================================================
// Worley 噪声（细胞 / Voronoi）
// ============================================================

/**
 * Worley 噪声：返回到最近特征点的距离
 *
 * 【长什么样】
 * 像细胞、鹅卵石、龟裂的泥地、叶脉。
 *
 * 【用途】
 * - 石头 / 大理石纹理
 * - 区域划分（每个细胞一个区域）
 * - 散布物体（在特征点上放树/石头，天然不会太密）
 *
 * 【返回的两种模式】
 * - `f1` = 到最近点的距离（默认，产生细胞）
 * - `f2 - f1` = 两个最近点的距离差（产生**边界线**，像龟裂）
 */
export class WorleyNoise {
  private readonly _points: Float64Array;
  private readonly _cellSize: number;
  private readonly _gridW: number;

  /**
   * @param seed 随机种子
   * @param gridWidth 网格宽度（每个网格放 1 个特征点）。越大细胞越密
   */
  constructor(seed = 0, gridWidth = 32) {
    this._gridW = gridWidth;
    this._cellSize = 1 / gridWidth;
    this._points = new Float64Array(gridWidth * gridWidth * 2);

    const rand = mulberry32(seed);
    for (let i = 0; i < gridWidth * gridWidth; i++) {
      this._points[i * 2] = rand();
      this._points[i * 2 + 1] = rand();
    }
  }

  /**
   * @param mode 'f1' 到最近点距离 | 'f2-f1' 边界
   */
  noise2D(x: number, y: number, mode: 'f1' | 'f2-f1' = 'f1'): number {
    // 用 wrapping 保证无缝平铺
    const gx = Math.floor(x / this._cellSize);
    const gy = Math.floor(y / this._cellSize);

    let f1 = Infinity;
    let f2 = Infinity;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        // wrapping（周期性）
        const cx = ((gx + dx) % this._gridW + this._gridW) % this._gridW;
        const cy = ((gy + dy) % this._gridW + this._gridW) % this._gridW;

        const idx = (cy * this._gridW + cx) * 2;
        const px = (gx + dx + this._points[idx]) * this._cellSize;
        const py = (gy + dy + this._points[idx + 1]) * this._cellSize;

        const ddx = px - x;
        const ddy = py - y;
        const d = Math.sqrt(ddx * ddx + ddy * ddy);

        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }

    return mode === 'f1' ? f1 / this._cellSize : (f2 - f1) / this._cellSize;
  }
}

// ============================================================
// 辅助：生成高度图与阈值化
// ============================================================

/**
 * 生成高度图
 *
 * @returns Float64Array，长度 w*h，值为采样函数的输出
 */
export function generateHeightmap(
  width: number,
  height: number,
  sampler: (x: number, y: number) => number
): Float64Array {
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = sampler(x, y);
    }
  }
  return out;
}

/**
 * 把高度图按阈值分层（地形分区）
 *
 * 【用途】
 * ```
 * 0.0 ~ 0.3  → 深水
 * 0.3 ~ 0.4  → 浅水
 * 0.4 ~ 0.5  → 沙滩
 * 0.5 ~ 0.7  → 草地
 * 0.7 ~ 0.85 → 森林
 * 0.85~ 1.0  → 山地
 * ```
 *
 * @param thresholds 递增的阈值数组
 * @returns 分层 id 数组（0 ~ thresholds.length）
 */
export function classifyHeightmap(
  heightmap: Float64Array,
  thresholds: readonly number[]
): Uint8Array {
  const out = new Uint8Array(heightmap.length);

  for (let i = 0; i < heightmap.length; i++) {
    const h = heightmap[i];
    let level = 0;
    while (level < thresholds.length && h >= thresholds[level]) level++;
    out[i] = level;
  }

  return out;
}

/**
 * 岛屿化：让边缘下沉，中间隆起
 *
 * 【为什么需要】
 * 直接用噪声生成的地图边缘是随机的，
 * 会出现"地图一半是海，一半是陆地，但边界很丑"。
 *
 * 乘一个"中心高、边缘低"的遮罩，
 * 就能得到一个漂在海中间的岛。
 *
 * @param falloff 边缘衰减强度。1 = 线性，>1 边缘下降更快
 */
export function islandMask(
  width: number,
  height: number,
  falloff = 2
): Float64Array {
  const mask = new Float64Array(width * height);
  /**
   * 【⚠️ 尺寸为 1 时不能让 cx / cy 变成 0】
   *
   * `width = 1` → `cx = (1-1)/2 = 0` → `(x - cx) / cx = 0/0 = NaN`
   * → `Math.min(1, NaN) = NaN` → 整张 mask 全是 NaN。
   * mask 通常要和高度图相乘，于是全图一起变 NaN：
   * 单列采样、边界尺寸这类"看起来无害"的调用会直接产出一整张废图，且不报错。
   *
   * 实测（修复前）：`islandMask(1,1)[0] === NaN`、`islandMask(1,3)[0] === NaN`，
   * 而 `islandMask(3,3)[0] === 0`（正常）。
   *
   * 【⚠️ 只在 cx 恰好为 0 时兜底，不要写成 clamp 到 1】
   *
   * 这是本条修复**返工过一次**才定下来的写法，记录一下踩过的坑：
   * 第一版写成 `Math.max(1, (width - 1) / 2)`，理由看着也自洽
   * （"退化时语义仍是到中心的距离"），但它会**连带改掉正常尺寸**：
   *
   * ```
   * width = 2 → (2-1)/2 = 0.5  → 被夹成 1
   * 旧 islandMask(2,2) = [0,0,0,0]        （中心距边缘只有半格，全算边缘）
   * 第一版        → [0,0,0,1]   ← 凭空多出一块"中心陆地"
   * ```
   *
   * 2×N 的图修复前并**没有** NaN，是既有行为；我只是来修 NaN 的，
   * 没有资格顺手重定义"中心在哪"。这就是任务书 1.1 第 1 条说的顺手重构。
   *
   * 正确做法是**只在除零发生的那一个点**兜底：
   * `cx > 0` 时原样保留，`cx === 0`（即 width <= 1）时才给 0.5。
   * 0.5 不是任意值：它让唯一的那一列 `nx = (0-0.5)/0.5 = -1`，
   * 即"唯一的格子就是边缘"，与 2×N 的既有口径一致。
   */
  const rawCx = (width - 1) / 2;
  const rawCy = (height - 1) / 2;
  const cx = rawCx > 0 ? rawCx : 0.5;
  const cy = rawCy > 0 ? rawCy : 0.5;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 归一化到 -1~1（中心为 0）
      const nx = (x - cx) / cx;
      const ny = (y - cy) / cy;

      // 到中心的距离（1 = 边缘）
      const d = Math.min(1, Math.sqrt(nx * nx + ny * ny));

      mask[y * width + x] = Math.pow(1 - d, falloff);
    }
  }

  return mask;
}


// ============================================================
// Noise —— 统一入口（原有 API，保持向后兼容）
// ============================================================

/**
 * 噪声统一入口
 *
 * 【这层存在的意义】
 * 上面有 Perlin / Simplex / Value / Worley 四种实现，
 * 但 90% 的场景只需要"给我一个好用的 2D 噪声"。
 * `Noise` 就是那个默认选择：内部用 Simplex（质量最好），
 * 并提供游戏开发最常用的几个便捷方法。
 *
 * 【⚠️ 维护警示：这是被外部依赖的公开 API】
 * `examples/batch3-usage.ts` 和 `tests/run_batch3.ts` 都依赖这个类。
 * **修改它的任何方法签名或值域前，先跑一遍全量测试。**
 *
 * 曾经发生过的事故：一次重构直接覆盖了整个文件，
 * 导致上面两个文件编译不过——因为它们 import 的 `Noise` 不见了。
 * 教训是：**动一个已经被引用超过一次的文件之前，先 grep 它的调用方。**
 *
 * 【构造】
 * ```typescript
 * new Noise(seed);              // 用种子
 * new Noise(seed, myRng);       // 用外部 RNG（让噪声与主世界种子绑定）
 * ```
 *
 * 【方法】
 * | 方法 | 返回范围 | 用途 |
 * |---|---|---|
 * | `noise2(x, y)` | -1 ~ 1 | 原始噪声 |
 * | `fbm(x, y)` | -1 ~ 1 | 分形叠加（地形） |
 * | `fbm01(x, y)` | 0 ~ 1 | 归一化分形（最常用） |
 * | `ridged(x, y)` | 0 ~ 1 | 山脊（山脉走向） |
 * | `heightMap(w, h, scale, opts)` | 0 ~ 1 数组 | 直接生成高度图 |
 */
export class Noise {
  private readonly _simplex: SimplexNoise;

  /**
   * @param seed 种子
   * @param rng 可选外部随机源。传入后噪声与主世界随机流绑定，
   *            同一个"世界种子"能复现出完全相同的地形
   */
  constructor(seed = 0, rng?: { next(): number }) {
    // 有外部 rng 时，用它生成内部种子，保证"外部种子 → 唯一地形"
    const actualSeed = rng ? Math.floor(rng.next() * 0x7fffffff) ^ seed : seed;
    this._simplex = new SimplexNoise(actualSeed);
  }

  /**
   * 原始 2D 噪声
   *
   * 【值域】严格 [-1, 1]（超出会被 clamp）
   *
   * 【为什么 clamp】
   * Simplex 的理论最大值是 ±1，但插值实现可能略微超出。
   * 不 clamp 的话，下游代码写 `v * 0.5 + 0.5` 会偶尔得到负数，
   * 表现为"地图上随机出现一个黑洞"。
   */
  noise2(x: number, y: number): number {
    const v = this._simplex.noise2D(x, y);
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  /** 分形噪声，值域 [-1, 1] */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2, persistence = 0.5): number {
    return fbm2D(this._simplex, x, y, { octaves, lacunarity, persistence });
  }

  /**
   * 分形噪声归一化到 [0, 1]
   *
   * 【这是最常用的一个】
   * 地形高度、密度图、概率图都需要 0~1，
   * 而这个范围手算容易写错符号（`v * 0.5 + 0.5` 还是 `v * 0.5 - 0.5`？）。
   */
  fbm01(x: number, y: number, octaves = 4, lacunarity = 2, persistence = 0.5): number {
    const v = this.fbm(x, y, octaves, lacunarity, persistence);
    const n = v * 0.5 + 0.5;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  /**
   * 山脊噪声，值域 [0, 1]，偏向高值
   *
   * 【和 fbm01 的区别】
   * fbm01 生成"丘陵"（圆润的起伏），
   * ridged 生成"山脉"（有明显的山脊线）。
   *
   * 【为什么偏向高值】
   * 公式是 `1 - |n|`，而 |n| 的期望约 0.25，
   * 所以结果均值约 0.75。这是正常现象，不是 bug。
   */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2, persistence = 0.5): number {
    const v = ridged2D(this._simplex, x, y, { octaves, lacunarity, persistence });
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * 生成高度图
   *
   * @param width 宽
   * @param height 高
   * @param scale 采样缩放。越小地形越"大块"（0.05~0.2 常用）
   * @param opts.octaves 倍频数
   * @param opts.normalize 是否归一化到 [0,1]。**默认 true**
   *
   * 【为什么默认归一化】
   * 不归一化时，不同种子产出的高度图范围差异很大
   * （有的 0.2~0.8，有的 0.4~0.5）。
   * 下游写 `h < 0.4 ? 墙 : 地面` 这种阈值判断时，
   * 地形就会忽大忽小、甚至整张图全是墙。
   *
   * 【归一化的实现】
   * 线性拉伸到 min→0, max→1。
   * 注意：如果整张图是平的（max == min），会返回全 0。
   */
  heightMap(
    width: number,
    height: number,
    scale = 0.1,
    opts: { octaves?: number; normalize?: boolean } = {}
  ): Float64Array {
    const octaves = needCount(opts.octaves ?? 4, 'opts.octaves', 64);
    /**
     * 【⚠️ 宽高必须是有限正整数，且乘积要有上界】
     *
     * 实测 `heightMap(Infinity, 4, 0.1)` 抛
     * `Invalid typed array length: Infinity`——引擎级报错，
     * 虽然拦住了，但**信息里没有业务语义**，
     * 排查时不知道是哪个地形生成调用、哪个参数错了。
     *
     * 更隐蔽的是"单个值合法、乘积失控"：
     * `heightMap(1e6, 1e6)` 会尝试分配 8TB 内存。
     * 所以除了有限性，还要给总像素数兜一个上界（16384² ≈ 2.7 亿，
     * 已是 2GB Float64，足够任何实际地形）。
     */
    const w = needCount(width, 'heightMap.width', 16384);
    const h = needCount(height, 'heightMap.height', 16384);
    const normalize = opts.normalize ?? true;

    const out = new Float64Array(w * h);
    let min = Infinity;
    let max = -Infinity;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = this.fbm01(x * scale, y * scale, octaves);
        out[y * w + x] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    if (normalize && max > min) {
      const range = max - min;
      for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) / range;
    }

    return out;
  }
}
