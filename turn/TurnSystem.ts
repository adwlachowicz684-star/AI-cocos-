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

import type { IRandomSource } from '../_core/types';

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
  /**
   * 额外回合存货（连击 / 再动）
   *
   * 【为什么是计数器而不是"插入克隆体"】
   * 原实现 `grantExtraTurn` 往 `_entries` 里 `{...e}` 插一个**同 id 的克隆对象**。
   * 于是同一个 id 在数组里有两条记录，而 `_byId` 只认原对象：
   * - `_doRemove` 用 `findIndex(e => e.id === id)` **只删第一个匹配**
   *   → 单位被击杀后，克隆体仍留在行动序列里，且它的 `dead` 还是 false
   * - 结果：**一个已经被杀死的单位会再次获得回合并触发 onUnitStart**
   *   （表现为"敌人死了还行动了一次"）
   * - 同时 `unitCount`（按 `_byId.get(e.id) === e` 过滤）与 `_entries.length` 不一致，
   *   胜负判定会提前或错后
   *
   * 改成计数器后，一个 id 永远只对应一条 Entry，
   * 身份唯一 → 删除、计数、胜负判定全部自洽。
   */
  extraTurns: number;
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
      extraTurns: 0,
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

    /**
     * 【⚠️ 只从行动序列里摘掉，记录仍留在 _byId】
     *
     * 原实现在 `_doRemove` 里 `this._byId.delete(id)`，
     * 而 `reviveUnit` 唯一的入口就是 `_byId.get(id)`——
     * 于是 `reviveUnit` **永远拿不到对象、永远返回 false**。
     *
     * 实测（修复前）：`killUnit('b')` 后 `has('b')` = false，
     * `reviveUnit('b')` = false，无论何时调用都失败。
     * README 的 API 表里明写 `killUnit(id) / reviveUnit(id)` 是"死亡 / 复活"，
     * 任何带复活、召唤、亡语机制的玩法接上后**复活静默失败**——
     * 它返回 false，但只要调用方没检查返回值（绝大多数不会），
     * 表现就是"复活术放了，单位没回来"。
     *
     * 【记录什么时候真正删除】
     * 由 `removeUnit(id)` 显式删除，或 `clear()` 清空整场。
     * 一场战斗的单位数是有界的，死亡记录留到战斗结束没有内存问题。
     */
    e.dead = true;
    if (this._iterating) {
      this._pendingRemoval.push(id);
    } else {
      this._removeFromSequence(id);
    }
    return true;
  }

  /** 复活（清除死亡标记，重新加回行动序列） */
  reviveUnit(id: string): boolean {
    const e = this._byId.get(id);
    if (!e || !e.dead) return false;

    e.dead = false;
    e.skipThisRound = false;
    e.extraTurns = 0;
    e.ap = e.maxAP;

    /**
     * 【为什么复活后要重新插入 _entries】
     * `killUnit` 已经把它从行动序列里摘掉了（否则死人还会轮到行动）。
     * 复活要让它重新参与回合，就得按先攻插回正确位置——
     * 直接用 push 会破坏"按先攻降序"这条不变式。
     */
    if (!this._entries.includes(e)) {
      let at = this._entries.length;
      for (let i = 0; i < this._entries.length; i++) {
        if (this._entries[i].initiative < e.initiative) {
          at = i;
          break;
        }
      }
      this._entries.splice(at, 0, e);
      // 插在游标之前时，游标要前进，否则当前单位会被跳过一次
      if (at <= this._cursor) this._cursor++;
    }
    return true;
  }

  /**
   * 彻底移除一个单位（不再可复活）
   *
   * 【为什么单独提供】
   * `killUnit` 为了让 `reviveUnit` 能工作，会保留 `_byId` 记录。
   * 确认不需要复活时（比如战斗结算、单位被永久消灭），
   * 用这个方法把记录一起清掉，避免长期累积。
   */
  removeUnit(id: string): boolean {
    const e = this._byId.get(id);
    if (!e) return false;
    this._removeFromSequence(id);
    this._byId.delete(id);
    return true;
  }

  /** 跳过某单位本回合（眩晕、冰冻） */
  skipUnit(id: string): boolean {
    const e = this._byId.get(id);
    if (!e || e.dead) return false;
    e.skipThisRound = true;
    return true;
  }

  /** 授予一个"额外回合"（连击、再动）——当前单位结束后立即再动一次 */
  grantExtraTurn(id: string): boolean {
    const e = this._byId.get(id);
    if (!e || e.dead) return false;

    /**
     * 【⚠️ 不再插入克隆体，改为累加计数器】
     *
     * 原实现往 `_entries` 里插 `{...e}`（同 id 的第二个对象），
     * 导致 id 与 entry 不再一一对应——详见 `Entry.extraTurns` 的注释。
     *
     * 实测（修复前）：a(先攻10) b(先攻5)，`grantExtraTurn('a')` 后
     * 序列 = [a, a(clone), b]；`killUnit('a')` 之后
     * 序列残留 = [a(clone)]、`unitCount` = 1，
     * 而 clone 的 `dead` 仍是 false → **死亡单位继续行动**。
     *
     * 计数器方案下 `killUnit` 只需删掉唯一那条 Entry，
     * 行动序列里不会留下幽灵。
     */
    e.extraTurns++;
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
   *
   * 【⚠️ `shuffleEqual = true` 曾经根本不打乱——参数名是假的】
   * 老实现在先攻相同时 `return shuffleEqual ? 0 : a.id.localeCompare(b.id)`
   * 依赖"sort 对返回 0 的一对会交换顺序"来打乱，
   * 但 ES2019 起 `Array.prototype.sort` **保证稳定**，返回 0 就是保持原序。
   * 实测：6 个同先攻单位，`start(true)` / `start(false)` / `start()` 三种调用
   * 全部输出 u0,u1,...,u5（永远按添加顺序）。
   *
   * 后果不是"少了个功能"，而是**系统性的先手优势**：
   * 回合制里同先攻谁先手往往决定胜负（先手秒杀），
   * 配了 `shuffleEqual = true` 的游戏实际永远是"先加入的先打"，
   * 玩家会投诉"为什么总是他先打我"。
   *
   * 【为什么不直接改成真随机】
   * 本模块的确定性（同数据同顺序）是回放/录像的前提，
   * 也是 README 里"用 id 做二级排序保证确定性"这条承诺。
   * 内置随机等于把这个承诺悄悄改掉，现有调用方无法察觉。
   *
   * 所以拆成两条路，由调用方选：
   * - 不传 `rng`：**行为与修复前完全一致**（保持添加顺序），不破坏任何既有用法；
   * - 传 `rng`（`IRandomSource`，库内统一口径）且 `shuffleEqual = true`：
   *   对同先攻的单位做 Fisher-Yates 真打乱，想要可复现就传带种子的 RNG。
   *
   * @param shuffleEqual 同先攻时是否打乱（需要配合 rng 才生效）
   * @param rng 随机源。未注入时同先攻单位保持添加顺序
   */
  start(shuffleEqual: boolean = false, rng?: IRandomSource): void {
    if (this._entries.length === 0) throw new Error('[Turn] 没有单位，无法开始');

    // 先按先攻降序 + id 升序排一次，保证"不打乱"时顺序完全确定
    this._entries.sort((a, b) => {
      const d = b.initiative - a.initiative;
      if (d !== 0) return d;
      return a.id.localeCompare(b.id);
    });

    // 再把同先攻的连续段整体打乱（只有注入了随机源才做）
    if (shuffleEqual && rng) {
      let i = 0;
      while (i < this._entries.length) {
        let j = i + 1;
        while (j < this._entries.length && this._entries[j].initiative === this._entries[i].initiative) {
          j++;
        }
        for (let k = j - 1; k > i; k--) {
          // Fisher-Yates：k 与 [i, k] 中随机一个交换
          const span = k - i + 1;
          const pick = i + Math.min(span - 1, Math.max(0, Math.floor(rng.next() * span)));
          const tmp = this._entries[k];
          this._entries[k] = this._entries[pick];
          this._entries[pick] = tmp;
        }
        i = j;
      }
    }

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

      /**
       * 【额外回合优先于推进游标】
       * 当前单位有 extraTurns 存货时，直接让它再动一次，不往下走。
       * 这样"连击"表现为：a 结束 → a 立即再动 → 才轮到 b。
       */
      const curEntry = this._entries[this._cursor];
      if (curEntry && !curEntry.dead && curEntry.extraTurns > 0) {
        curEntry.extraTurns--;
        curEntry.ap = curEntry.maxAP;
        this._phase = 'unitStart';
        this._events.onUnitStart?.(curEntry.id, this._round);
        return;
      }

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
        for (const id of this._pendingRemoval) this._removeFromSequence(id);
        this._pendingRemoval.length = 0;
      }
    }
  }

  /**
   * 从行动序列里移除（**不动 _byId**）
   *
   * 【为什么不再 delete _byId】
   * 见 `killUnit` 的注释：删了就无法复活。
   * 真正删除走 `removeUnit`。
   *
   * 【为什么用 while 而不是 findIndex】
   * 一个 id 现在只对应一条 Entry（改掉克隆体之后），
   * 这里用 while 全量清理是防御性的：万一历史存档或外部代码
   * 造出了重复 id，也不会留下幽灵条目。
   */
  private _removeFromSequence(id: string): void {
    for (let i = 0; i < this._entries.length; i++) {
      if (this._entries[i].id !== id) continue;
      this._entries.splice(i, 1);
      // 删的是游标之前的（含游标），游标要回退
      if (i <= this._cursor) this._cursor--;
      i--;
    }
  }

  // ==================== 行动点 ====================

  /** 当前单位的行动点 */
  get currentAP(): number {
    const e = this._entries[this._cursor];
    return e ? e.ap : 0;
  }

  /**
   * 花费行动点。不够时返回 false 且**不扣**
   *
   * 【⚠️ 必须是肯定式：`!(n > 0)`，不能写 `if (n <= 0)`】
   * 老实现只有 `if (e.ap < n) return false`，漏了"n 本身不合法"这一支。
   * 于是 `spendAP(-5)` 时 `3 < -5` 为 false → `ap -= -5` → **AP 从 3 变成 8**。
   * 实测：初始 AP 3，spendAP(-5) 后 AP = 8。
   * 这是"倒扣 AP 刷行动次数"的漏洞：技能费用配成负数（配表很容易写出）
   * 就能无限行动。
   * 顺带说明为什么连 NaN 也要一起挡：`3 < NaN` 恒为 false，
   * 走 `ap -= NaN` 会把 AP 变成 NaN，之后 `ap <= 0` 恒为 false →
   * `isOutOfAP` 永远 false → **回合永远不结束**。
   */
  spendAP(n: number): boolean {
    const e = this._entries[this._cursor];
    if (!e) return false;
    if (!(n > 0) || !(e.ap >= n)) return false;
    e.ap -= n;
    return true;
  }

  /** 当前 AP 是否还够做某件事（用于 UI 灰化按钮） */
  canAfford(n: number): boolean {
    const e = this._entries[this._cursor];
    return e ? e.ap >= n : false;
  }

  /**
   * 补充行动点（某些技能效果）
   *
   * 【⚠️ n 为 NaN 时 `ap += NaN` → AP 变 NaN】
   * 与 spendAP 是同一条契约的两侧，只修一侧会不一致：
   * `spendAP` 已经拒绝非法值，这里若放任 NaN 进去，
   * 之后 `isOutOfAP`（`ap <= 0`）对 NaN 恒为 false → 回合永不结束。
   * 负数则按"扣 AP"处理是合理的（有些效果是减行动点），但 NaN 必须挡。
   */
  grantAP(id: string, n: number): boolean {
    const e = this._byId.get(id);
    if (!e || e.dead) return false;
    if (!Number.isFinite(n)) return false;
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
