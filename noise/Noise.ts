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
  let a = seed >>> 0;
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
 */
export class PerlinNoise {
  private readonly _perm: Uint8Array;
  private readonly _permMod12: Uint8Array;

  /** 2D 梯度方向（12 个，避开轴向以减少格子感） */
  private static readonly GRAD3: ReadonlyArray<readonly [number, number]> = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
  ];

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

    const g = PerlinNoise.GRAD3;

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

  private static readonly GRAD3: ReadonlyArray<readonly [number, number]> = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
  ];

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
    const g = SimplexNoise.GRAD3;

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

  /** 3D 噪声（用于体积雾、3D 地形） */
  noise3D(xin: number, yin: number, zin: number): number {
    // 3D 实现较冗长，这里用简化的：三层 2D 切片插值
    // 对于大多数游戏够用，且代码量小得多
    const iz = Math.floor(zin);
    const fz = zin - iz;

    const a = this.noise2D(xin, yin + iz * 37.7);
    const b = this.noise2D(xin, yin + (iz + 1) * 37.7);

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
  const octaves = opts.octaves ?? 4;
  const lacunarity = opts.lacunarity ?? 2;
  const persistence = opts.persistence ?? 0.5;

  let amplitude = opts.amplitude ?? 1;
  let frequency = opts.frequency ?? 1;

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
  const octaves = opts.octaves ?? 4;
  const lacunarity = opts.lacunarity ?? 2;
  const persistence = opts.persistence ?? 0.5;

  let amplitude = opts.amplitude ?? 1;
  let frequency = opts.frequency ?? 1;

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
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;

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
    const octaves = opts.octaves ?? 4;
    const normalize = opts.normalize ?? true;

    const out = new Float64Array(width * height);
    let min = Infinity;
    let max = -Infinity;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = this.fbm01(x * scale, y * scale, octaves);
        out[y * width + x] = v;
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
