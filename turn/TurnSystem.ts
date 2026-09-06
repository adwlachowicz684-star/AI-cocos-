/**
 * TurnSystem —— 回合制系统（行动顺序 / 行动点 / 阶段）
 *
 * 【它解决什么】
 *
 * 回合制看起来就是"你一下我一下"，但真做起来有一堆边界情况：
 * - 单位在轮到自己之前**死了**怎么办（必须从顺序里移除，否则轮到空位）
 * - 战斗中**新加入**单位（召唤物）排在哪
 * - 有人被**跳过**（眩晕）或被**额外行动**（连击）
 * - 回合结束时要触发一堆结算（buff 跳、中毒掉血、冷却 -1）
 * - 玩家点了"结束回合"但动画还在播 → 输入必须被锁住
 *
 * 手写这些，最常见的 bug 是"轮到一个不存在的单位"然后崩溃，
 * 或者"召唤物插进来导致某单位一回合行动两次"。
 *
 * 【设计：顺序是一个数组 + 游标，不是队列】
 * 队列（shift/push）无法表达"插入到中间"和"移除中间的"。
 * 用数组 + 游标，配合惰性清理（死了的标记而不是立即删除），
 * 才能保证遍历过程中修改顺序是安全的。
 *
 * 【使用示例】
 * ```typescript
 * const turn = new TurnSystem();
 *
 * turn.addUnit({ id: 'hero', initiative: 15 });
 * turn.addUnit({ id: 'goblin', initiative: 8 });
 * turn.addUnit({ id: 'boss', initiative: 20 });
 *
 * turn.start();                    // 按先攻排序：boss → hero → goblin
 * turn.currentUnitId;              // 'boss'
 *
 * turn.endTurn();                  // 交给下一个
 * turn.currentUnitId;              // 'hero'
 *
 * turn.killUnit('hero');           // 死了，下次轮到时自动跳过
 * turn.endTurn();                  // → 'goblin'（跳过了 hero）
 * turn.endTurn();                  // → 'boss'（回到队首，round 变成 2）
 *
 * turn.round;                      // 2
 * ```
 *
 * 【行动点（AP）】
 * ```typescript
 * turn.setActionPoints('hero', 4);
 * turn.spendAP(2);                 // 花 2 点
 * turn.currentAP;                  // 2
 * turn.spendAP(5);                 // false（不够，不扣）
 * turn.endTurn();                  // 下一个人，AP 自动回满
 * ```
 *
 * 【无引擎依赖】
 */

export interface TurnUnit {
  readonly id: string;
  /** 先攻值，大的先动 */
  readonly initiative: number;
  /** 每回合的行动点（默认 1） */
  readonly actionPoints?: number;
}

export type TurnPhase = 'idle' | 'roundStart' | 'unitStart' | 'unitAction' | 'unitEnd' | 'roundEnd';

export interface TurnEvents {
  /** 新一轮开始（所有单位都动过一遍） */
  onRoundStart?: (round: number) => void;
  /** 轮到某单位 */
  onUnitStart?: (id: string, round: number) => void;
  /** 某单位结束 */
  onUnitEnd?: (id: string) => void;
  /** 一轮结束 */
  onRoundEnd?: (round: number) => void;
}

interface Entry {
  readonly id: string;
  readonly initiative: number;
  readonly maxAP: number;
  ap: number;
  /** 已死 / 已移除。惰性清理：遍历时跳过，遍历结束后才真正删除 */
  dead: boolean;
  /** 被跳过本回合（眩晕等） */
  skipThisRound: boolean;
}

export class TurnSystem {
  private _entries: Entry[] = [];
  private readonly _byId = new Map<string, Entry>();

  /** 当前游标（-1 = 未开始） */
  private _cursor = -1;
  private _round = 0;
  private _phase: TurnPhase = 'idle';

  /** 是否正在遍历（防止回调里改顺序导致错乱） */
  private _iterating = false;
  private _pendingRemoval: string[] = [];

  private readonly _events: TurnEvents;

  constructor(events: TurnEvents = {}) {
    this._events = events;
  }

  // ==================== 单位管理 ====================

  /** 添加单位 */
  addUnit(unit: TurnUnit): boolean {
    if (this._byId.has(unit.id)) return false;

    const e: Entry = {
      id: unit.id,
      initiative: unit.initiative,
      maxAP: unit.actionPoints ?? 1,
      ap: unit.actionPoints ?? 1,
      dead: false,
      skipThisRound: false,
    };

    this._entries.push(e);
    this._byId.set(unit.id, e);

    /**
     * 【坑】战斗中加人不能直接 sort —— 那会让已经动过的单位重新排到前面，
     * 导致它这一轮又动一次。
     *
     * 正确做法：只在 start() 时排序。战斗中加的单位排在队尾。
     */
    return true;
  }

  /**
   * 移除单位（死亡、逃跑）
   *
   * 【为什么是惰性清理】
   * 如果正在遍历顺序（比如某单位的 onUnitEnd 回调里杀了另一个单位），
   * 直接 splice 会让游标错位——下一个单位被跳过。
   * 所以只打标记，等遍历结束后统一清理。
   */
  killUnit(id: string): boolean {
    const e = this._byId.get(id);
    if (!e || e.dead) return false;

    e.dead = true;
    if (this._iterating) {
      this._pendingRemoval.push(id);
    } else {
      this._doRemove(id);
    }
    return true;
  }

  /** 复活（清除死亡标记） */
  reviveUnit(id: string): boolean {
    const e = this._byId.get(id);
    if (!e || !e.dead) return false;
    e.dead = false;
    return true;
  }

  /** 跳过某单位本回合（眩晕、冰冻） */
  skipUnit(id: string): boolean {
    const e = this._byId.get(id);
    if (!e || e.dead) return false;
    e.skipThisRound = true;
    return true;
  }

  /** 插入一个"额外回合"（连击、再动） */
  grantExtraTurn(id: string): boolean {
    const e = this._byId.get(id);
    if (!e || e.dead) return false;
    // 在当前游标后面插一个引用（同一单位连续动两次）
    const clone: Entry = { ...e, skipThisRound: false };
    this._entries.splice(this._cursor + 1, 0, clone);
    return true;
  }

  has(id: string): boolean {
    const e = this._byId.get(id);
    return e !== undefined && !e.dead;
  }

  get unitCount(): number {
    return this._entries.filter((e) => !e.dead && this._byId.get(e.id) === e).length;
  }

  // ==================== 流程 ====================

  /**
   * 开始战斗（按先攻排序）
   *
   * 【同先攻的处理】
   * 用 id 做二级排序，保证**确定性**——
   * 否则同样的数据在不同 JS 引擎上可能顺序不同（Array.sort 不保证稳定），
   * 回放就对不上了。
   */
  start(shuffleEqual: boolean = false): void {
    if (this._entries.length === 0) throw new Error('[Turn] 没有单位，无法开始');

    this._entries.sort((a, b) => {
      const d = b.initiative - a.initiative;
      if (d !== 0) return d;
      // 先攻相同：固定用 id 排序（确定性）
      return shuffleEqual ? 0 : a.id.localeCompare(b.id);
    });

    this._round = 1;
    this._cursor = -1;
    this._phase = 'roundStart';
    this._events.onRoundStart?.(this._round);

    this._advance();
  }

  /**
   * 结束当前单位的回合
   *
   * 【为什么返回 boolean】
   * 如果游戏已经结束（比如玩家把最后一个敌人打死了），
   * 再调 endTurn 应该无害地返回 false，而不是推进到空位然后崩。
   */
  endTurn(): boolean {
    if (this._phase === 'idle') return false;

    const cur = this._entries[this._cursor];
    if (cur) {
      this._phase = 'unitEnd';
      this._events.onUnitEnd?.(cur.id);
    }

    this._advance();
    return true;
  }

  /** 强制跳到下一个人（不触发 onUnitEnd，用于"跳过回合"） */
  skip(): boolean {
    if (this._phase === 'idle') return false;
    this._advance();
    return true;
  }

  /** 结束战斗 */
  stop(): void {
    this._phase = 'idle';
    this._cursor = -1;
  }

  private _advance(): void {
    this._iterating = true;

    try {
      const aliveCount = this._entries.filter((e) => !e.dead).length;
      if (aliveCount === 0) {
        this._phase = 'idle';
        return;
      }

      /**
       * 【为什么必须有 guard】
       * 循环里 continue 的条件有两个（dead / skip），
       * 如果数据被外部改坏（比如所有单位都 dead 但 aliveCount 缓存过期），
       * 就会无限转圈。guard 保证最坏情况下也只是"本轮无人行动"，
       * 而不是整个游戏卡死。
       */
      let guard = 0;
      const maxGuard = this._entries.length * 2 + 4;

      for (;;) {
        if (++guard > maxGuard) {
          this._phase = 'idle';
          return;
        }

        this._cursor++;

        // 走完一圈 → 新一轮
        if (this._cursor >= this._entries.length) {
          this._cursor = 0;
          this._round++;
          /**
           * 【坑】新一轮要重置 skip 标记，
           * 否则眩晕一次就永远不动了。
           */
          for (const e of this._entries) e.skipThisRound = false;
          for (const e of this._entries) e.ap = e.maxAP;
          this._phase = 'roundStart';
          this._events.onRoundStart?.(this._round);
        }

        const e = this._entries[this._cursor];
        if (!e) break;

        if (e.dead) continue;
        if (e.skipThisRound) {
          e.skipThisRound = false; // 只跳过一次
          continue;
        }

        // 找到了
        e.ap = e.maxAP;
        this._phase = 'unitStart';
        this._events.onUnitStart?.(e.id, this._round);
        return;
      }

      // 一圈全是死人
      this._phase = 'idle';
    } finally {
      this._iterating = false;
      // 遍历结束，清理延迟删除的
      if (this._pendingRemoval.length > 0) {
        for (const id of this._pendingRemoval) this._doRemove(id);
        this._pendingRemoval.length = 0;
      }
    }
  }

  private _doRemove(id: string): void {
    const idx = this._entries.findIndex((e) => e.id === id);
    if (idx < 0) return;
    this._entries.splice(idx, 1);
    // 删的是游标之前的（含游标），游标要回退
    if (idx <= this._cursor) this._cursor--;
    this._byId.delete(id);
  }

  // ==================== 行动点 ====================

  /** 当前单位的行动点 */
  get currentAP(): number {
    const e = this._entries[this._cursor];
    return e ? e.ap : 0;
  }

  /** 花费行动点。不够时返回 false 且**不扣** */
  spendAP(n: number): boolean {
    const e = this._entries[this._cursor];
    if (!e) return false;
    if (e.ap < n) return false;
    e.ap -= n;
    return true;
  }

  /** 当前 AP 是否还够做某件事（用于 UI 灰化按钮） */
  canAfford(n: number): boolean {
    const e = this._entries[this._cursor];
    return e ? e.ap >= n : false;
  }

  /** 补充行动点（某些技能效果） */
  grantAP(id: string, n: number): boolean {
    const e = this._byId.get(id);
    if (!e || e.dead) return false;
    e.ap += n;
    return true;
  }

  /** AP 用完自动结束回合（可选） */
  get isOutOfAP(): boolean {
    const e = this._entries[this._cursor];
    return e ? e.ap <= 0 : false;
  }

  // ==================== 查询 ====================

  get currentUnitId(): string | null {
    const e = this._entries[this._cursor];
    return e && !e.dead ? e.id : null;
  }

  get round(): number {
    return this._round;
  }

  get phase(): TurnPhase {
    return this._phase;
  }

  get isRunning(): boolean {
    return this._phase !== 'idle';
  }

  /** 接下来的行动顺序（含当前）—— UI 的行动条用这个 */
  get orderPreview(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this._entries.length; i++) {
      const idx = (this._cursor + i) % this._entries.length;
      const e = this._entries[idx];
      if (e && !e.dead) out.push(e.id);
    }
    return out;
  }

  /** 未来 N 步的顺序（考虑死人，但不考虑临时插入） */
  peekOrder(count: number): string[] {
    return this.orderPreview.slice(0, count);
  }

  destroy(): void {
    this._entries.length = 0;
    this._byId.clear();
    this._pendingRemoval.length = 0;
    this._cursor = -1;
    this._round = 0;
    this._phase = 'idle';
  }
}
