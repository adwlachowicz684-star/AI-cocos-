/**
 * PRD —— 伪随机分布（Pseudo-Random Distribution）
 *
 * 【它解决什么】
 *
 * 真随机的暴击率有个很糟糕的体验问题：
 * 25% 暴击率下，连续 10 刀不暴击的概率约 5.6%——
 * 不算低。玩家遇到时会骂「这游戏的暴击是假的」。
 * 更糟的是反过来：连续 5 刀全暴击，敌人秒死，战斗失去张力。
 *
 * PRD 的做法：每次失败后提高下一次的概率，成功后重置。
 *
 * ```
 * 名义 25%：第 1 刀 8.5%，第 2 刀 17%，第 3 刀 25.5%……
 * ```
 * 结果：**长期频率仍是 25%，但方差大幅降低**——
 * 不会长时间不触发，也不会连续爆发。
 *
 * 【适用范围（重要）】
 * ✅ 暴击、闪避、掉落、格挡 —— 玩家能感知频率的
 * ❌ 抽卡保底 —— 那是 pity 机制，语义不同（见 LootTable 的保底）
 * ❌ 需要真随机公平性的场合（赌博、排行榜）
 *
 * 【使用示例】
 * ```typescript
 * const crit = PRD.fromChance(0.25);
 *
 * for (const attack of attacks) {
 *   if (crit.roll(rng)) dealCrit();   // 记住：crit 是有状态的，每个角色要有自己的实例
 * }
 *
 * crit.chance;   // 当前这一次的真实概率（UI 可显示"下次暴击率"）
 * ```
 *
 * 【无引擎依赖】随机源通过 IRandomSource 注入。
 */

import { IRandomSource } from '../_core/types';

export class PRD {
  /** PRD 常数 C：每次失败增加的幅度 */
  private readonly _c: number;
  /** 连续失败次数 */
  private _fails = 0;

  constructor(c: number) {
    if (!(c > 0)) throw new Error(`[PRD] C 必须为正数，实际 ${c}`);
    this._c = Math.min(c, 1);
  }

  /**
   * 由「名义概率」反解出 C 常数
   *
   * 【为什么需要数值求解】
   * C 和名义概率 p 之间没有闭式解，只能数值求解。
   * 做法是二分搜索 C，使得「平均触发间隔的倒数」等于 p。
   *
   * @param chance 名义概率（0–1）
   */
  static fromChance(chance: number): PRD {
    if (!(chance > 0 && chance < 1)) {
      throw new Error(`[PRD] 名义概率必须在 (0,1) 区间，实际 ${chance}`);
    }

    const cached = PRD._cache.get(chance);
    if (cached !== undefined) return new PRD(cached);

    // 二分搜索：C 越大，实际频率越高
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const eff = PRD._effectiveChance(mid);
      if (eff < chance) lo = mid;
      else hi = mid;
    }

    const c = (lo + hi) / 2;
    PRD._cache.set(chance, c);
    return new PRD(c);
  }

  /** C → 实际长期频率 */
  private static _effectiveChance(c: number): number {
    // E[N] = Σ N × P(第 N 次才触发)，实际频率 = 1 / E[N]
    let expected = 0;
    let notYet = 1; // 前 N-1 次都没触发的概率
    const MAX_N = 1000;

    for (let n = 1; n <= MAX_N; n++) {
      const p = Math.min(1, c * n);
      expected += n * notYet * p;
      notYet *= 1 - p;
      if (notYet < 1e-12) break;
    }

    return expected > 0 ? 1 / expected : 0;
  }

  /** C 常数（只读） */
  get c(): number {
    return this._c;
  }

  /** 连续失败次数 */
  get failCount(): number {
    return this._fails;
  }

  /**
   * 本次的实际触发概率
   *
   * 【用途】UI 显示「下次暴击率 42%」，把隐藏机制变成玩家可利用的信息。
   * 这是 PRD 相对真随机的额外好处：它能被展示，而真随机的"手感"没法展示。
   */
  get chance(): number {
    return Math.min(1, this._c * (this._fails + 1));
  }

  /** 掷一次：true = 触发 */
  roll(rng: IRandomSource): boolean {
    if (rng.next() < this.chance) {
      this._fails = 0;
      return true;
    }
    this._fails++;
    return false;
  }

  /** 重置失败计数（换目标、离开战斗时） */
  reset(): void {
    this._fails = 0;
  }

  /** 手动指定失败次数（存档读档用） */
  setFailCount(n: number): void {
    this._fails = Math.max(0, Math.floor(n));
  }

  private static readonly _cache = new Map<number, number>();
}
