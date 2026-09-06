/**
 * RNG —— 可复现的种子随机数
 *
 * 【"可复现"是种子随机的全部价值】
 * 你必须能保证：同样种子 + 同样操作 = 同样结果。
 * 所以任何地方都不能偷偷用 Math.random()——包括洗牌、包括 AI 抖动。
 *
 * 【强烈建议】在 eslint 里加一条规则禁止直接使用 Math.random：
 * ```json
 * "no-restricted-properties": ["error", { "property": "random", "message": "请用注入的 RNG" }]
 * ```
 * 靠自觉必然失守，靠工具才拦得住。
 *
 * 【算法选择：mulberry32】
 * 32 位状态、速度快、分布良好、实现简单。
 * 不需要密码学强度，也不需要 Math.random 那种不可预测性——
 * 恰恰相反，我们要的就是可预测。
 *
 * 【使用示例】
 * ```typescript
 * const rng = new RNG(12345);
 * rng.next();            // 0..1
 * rng.range(1, 10);      // [1, 10)
 * rng.int(3);            // 0,1,2
 * rng.pick(['a','b','c']);
 * rng.shuffle(arr);      // Fisher-Yates，无偏
 *
 * const sub = rng.fork();  // 派生独立子流
 * ```
 */

export class RNG {
  private _s: number;

  constructor(seed: number = Date.now() >>> 0) {
    // 【坑】种子必须转成 32 位无符号整数。
    // 传负数或超过 2^32 的数会导致内部状态异常。
    this._s = seed >>> 0;
    if (this._s === 0) this._s = 0x9e3779b9; // 0 是坏种子（会卡住）
  }

  /** 当前内部状态（存档用） */
  get state(): number {
    return this._s;
  }

  set state(v: number) {
    this._s = v >>> 0;
  }

  /** 核心：返回 [0, 1) */
  next(): number {
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) 区间浮点 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** [min, max] 区间整数（含两端） */
  rangeInt(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** [0, n) 整数 */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** 概率为 p 时返回 true */
  chance(p: number): boolean {
    return this.next() < p;
  }

  bool(): boolean {
    return this.next() < 0.5;
  }

  /** 随机取一个元素（空数组返回 undefined） */
  pick<T>(arr: readonly T[]): T | undefined {
    return arr.length === 0 ? undefined : arr[this.int(arr.length)];
  }

  /**
   * 原地洗牌（Fisher-Yates，无偏）
   *
   * 【坑】绝对不要用 `arr.sort(() => Math.random() - 0.5)`：
   * ① 它用了 Math.random，破坏可复现；
   * ② 比较函数不满足传递性，分布是**有偏**的（某些排列概率更高）；
   * ③ 复杂度 O(n log n) 而非 O(n)。
   */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** 取 n 个不重复元素（n 大于长度时返回全部） */
  sample<T>(arr: readonly T[], n: number): T[] {
    const copy = arr.slice();
    this.shuffle(copy);
    return copy.slice(0, Math.min(n, copy.length));
  }

  /**
   * 正态分布（Box-Muller）
   * 用于"自然的随机"——比如敌人属性在均值附近波动，
   * 而不是均匀分布（那样会感觉很假）。
   */
  gaussian(mean = 0, stdDev = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * 派生一个独立的子随机流
   *
   * 【为什么需要】
   * 如果所有系统共用一个 RNG，那么"玩家多开了一个宝箱"会导致
   * 后面所有随机（地图生成、AI 决策）全部错位。
   * 有了 fork，每个子系统用自己的流，互不干扰。
   *
   * 例：mapRng = rng.fork(); lootRng = rng.fork();
   */
  fork(): RNG {
    return new RNG(this.int(0xffffffff));
  }
}
