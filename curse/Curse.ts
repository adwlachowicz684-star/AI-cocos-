/**
 * curse —— 诅咒系统（带代价的强化）
 *
 * 【它解决什么】
 *
 * 诅咒是肉鸽的核心张力来源：**给你一个强力效果，但索取代价**。
 *
 * ```
 * 「贪婪之血」攻击 +50%，但每层失去 1 点最大生命
 * 「易碎护甲」  减伤 +30%，但受到暴击时伤害翻倍
 * 「时间债」    冷却 -40%，但通关后结算分数 -20%
 * ```
 *
 * 它和祝福的区别不只是"有负面"——而是**代价有独立的触发条件**。
 *
 * | | 祝福 | 诅咒 |
 * |---|---|---|
 * | 效果 | 持续生效 | 持续生效 |
 * | 代价 | 无 | **在特定时机触发** |
 * | 玩家态度 | 越多越好 | 权衡要不要拿 |
 * | 可移除 | 一般不 | **可以**，通常要付费/满足条件 |
 *
 * 【三个必须处理的真实问题】
 *
 * 1. **代价的触发时机**：持续掉血（每帧）vs 事件触发（受击时）vs 结算触发（通关时）
 * 2. **移除条件**："献祭 100 金币" "击败 Boss" "不使用药水通关一层"
 * 3. **诅咒本身能不能被诅咒叠加**：两个诅咒的代价会不会互相触发
 *
 * 【无引擎依赖】
 */

import { numOr } from '../_core/math';

// ==================== 类型 ====================

export type CurseOp = 'add' | 'mul' | 'set';

export interface CurseEffect {
  readonly stat: string;
  readonly op: CurseOp;
  readonly value: number;
}

/** 代价的触发时机 */
export type CurseTrigger =
  /** 每帧（持续掉血等） */
  | 'tick'
  /** 事件触发（由宿主调用 trigger()） */
  | 'event'
  /** 关卡结束时结算 */
  | 'onFloorEnd'
  /** 一局结束时结算 */
  | 'onRunEnd'
  /** 只在获得时立刻生效一次 */
  | 'onAcquire';

export interface CurseCost {
  /** 触发时机 */
  readonly trigger: CurseTrigger;
  /** event 类型的事件名 */
  readonly event?: string;
  /**
   * 代价内容（由宿主解释）
   *
   * 例：`{ type: 'hp', amount: 1 }`、`{ type: 'gold', amount: 50 }`
   */
  readonly payload: Readonly<Record<string, unknown>>;
  /** 说明（UI 显示） */
  readonly desc?: string;
}

export interface CurseDef {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  /** 增益 */
  readonly effects: readonly CurseEffect[];
  /** 代价（可多条） */
  readonly costs: readonly CurseCost[];
  /**
   * 移除条件
   *
   * 【不定义则为不可移除】
   * 有些诅咒是设计上就该跟到死的。
   */
  readonly removeCondition?: {
    readonly id: string;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly desc: string;
  };
  /** 权重（抽取用） */
  readonly weight?: number;
  /** 稀有度 */
  readonly rarity?: string;
  /** 标签 */
  readonly tags?: readonly string[];
}

export interface CurseSystemOptions {
  readonly defs: readonly CurseDef[];
  /**
   * 代价执行器
   *
   * 【为什么注入】
   * 代价可能是扣血、扣金币、加负面 buff……
   * 内建任何一种都会产生业务依赖。
   */
  readonly executor?: (cost: CurseCost, curse: CurseDef) => void;
  /**
   * 移除条件检查器
   */
  readonly checker?: (c: NonNullable<CurseDef['removeCondition']>, curse: CurseDef) => boolean;
  /** 变化时回调 */
  readonly onChange?: (id: string, action: 'add' | 'remove') => void;
  /**
   * 是否允许重复获得同一诅咒（默认 false）
   *
   * 【默认不允许的理由】
   * 两个"贪婪之血"会让代价叠加到不可玩，
   * 而增益的边际收益递减。这不是有趣的选择。
   */
  readonly allowDuplicate?: boolean;
  /**
   * 时间源（默认 `Date.now`）
   *
   * 【为什么要注入】
   * 原实现 `add(id, now = Date.now())` 让模块内部主动去"找"墙钟时间，
   * 违反 rule2（配置驱动 / 依赖注入）：
   *   - 回放、确定性测试无法控制时间推进
   *   - "持有 N 秒后自动解除"这类条件在快进时算错
   *   - 单测里想构造"过了 10 秒"只能真的 sleep 或改全局 Date
   *
   * 保持默认值为 `Date.now`，所以既有调用方（不传也能用）不受影响。
   */
  readonly nowProvider?: () => number;
}

/** 一个已获得的诅咒 */
export interface ActiveCurse {
  readonly def: CurseDef;
  /** 获得时刻（用于"持有 N 秒后自动解除"这类条件） */
  readonly since: number;
  /**
   * 层数
   *
   * 【为什么诅咒也会有多层】
   * `allowDuplicate: true` 时同一个诅咒可获得多次。
   * 默认是 1（不允许重复时恒为 1）。
   */
  readonly stacks: number;
}

// ==================== 实现 ====================

export class CurseSystem {
  private readonly _defs = new Map<string, CurseDef>();
  private readonly _active = new Map<string, ActiveCurse>();
  private readonly _executor?: (cost: CurseCost, curse: CurseDef) => void;
  private readonly _checker?: (
    c: NonNullable<CurseDef['removeCondition']>,
    curse: CurseDef
  ) => boolean;
  private readonly _onChange?: (id: string, action: 'add' | 'remove') => void;
  private readonly _allowDuplicate: boolean;
  private readonly _now: () => number;

  /** 统计：某诅咒的代价已触发次数 */
  private readonly _costCount = new Map<string, number>();

  constructor(opts: CurseSystemOptions) {
    this._executor = opts.executor;
    this._checker = opts.checker;
    this._onChange = opts.onChange;
    this._allowDuplicate = opts.allowDuplicate ?? false;
    this._now = opts.nowProvider ?? (() => Date.now());

    for (const d of opts.defs) {
      if (this._defs.has(d.id)) throw new Error(`[Curse] 诅咒 id 重复：${d.id}`);
      this._validate(d);
      this._defs.set(d.id, d);
    }
  }

  private _validate(d: CurseDef): void {
    if (d.effects.length === 0) {
      throw new Error(`[Curse] 诅咒 "${d.id}" 没有任何增益——没有增益的就不是诅咒，只是惩罚`);
    }
    if (d.costs.length === 0) {
      throw new Error(`[Curse] 诅咒 "${d.id}" 没有任何代价——没有代价的就不是诅咒，是祝福`);
    }
    for (const c of d.costs) {
      if (c.trigger === 'event' && !c.event) {
        throw new Error(`[Curse] 诅咒 "${d.id}" 有条代价是 event 触发但没给 event 名`);
      }
    }
  }

  get all(): CurseDef[] {
    return [...this._defs.values()];
  }

  def(id: string): CurseDef | undefined {
    return this._defs.get(id);
  }

  // ==================== 获得 / 移除 ====================

  /** 获得诅咒（不传 now 时用注入的时间源，默认 Date.now） */
  add(id: string, now = this._now()): boolean {
    const def = this._defs.get(id);
    if (!def) {
      throw new Error(`[Curse] 未定义的诅咒：${id}`);
    }
    const existing = this._active.get(id);
    if (existing && !this._allowDuplicate) return false;

    /**
     * 【⚠️ 曾经的 bug：allowDuplicate 形同虚设】
     *
     * `_active` 是 `Map<id, ActiveCurse>`，
     * 同 id 直接 `set` 会**覆盖**，count 永远是 1。
     *
     * 表现为：开了 allowDuplicate，拿两次同名诅咒，
     * UI 上还是只显示一个——而且不报错，
     * 因为返回了 true，看起来"获得成功"了。
     *
     * 修法：重复时累加 stacks 而不是覆盖。
     */
    this._active.set(id, {
      def,
      since: existing?.since ?? now,
      stacks: (existing?.stacks ?? 0) + 1,
    });
    this._onChange?.(id, 'add');

    // onAcquire 类型的代价立刻生效
    this._fire(def, 'onAcquire');
    return true;
  }

  /**
   * 移除诅咒
   *
   * @param force true 则忽略移除条件（付费移除等场景）
   * @returns 是否成功
   */
  /**
   * 移除一个诅咒
   *
   * 【⚠️ 曾经的 bug：canRemove 说不能删，remove 却能删掉】
   *
   * 原实现：
   * ```typescript
   * if (!force && c.def.removeCondition) { ...检查... }
   * ```
   *
   * 这个条件只在**有** removeCondition 时才检查。
   * 于是「设计上不可移除」的诅咒（没有 removeCondition）
   * 反而被直接删掉了。
   *
   * 表现：
   *   canRemove('eternal') → false   （UI 显示"无法移除"）
   *   remove('eternal')    → true    （代码一调用就删了）
   *
   * 玩家会觉得"明明说不能移除，怎么我交了钱就消失了"——
   * 或者更糟，某个系统路径误调 remove 直接破坏设计意图。
   *
   * 【正确的语义】
   *   没有 removeCondition → 设计上不可移除，只有 force 能删
   *   有 removeCondition   → 需 checker 验证；没有 checker 则不能删
   */
  remove(id: string, force = false): boolean {
    const c = this._active.get(id);
    if (!c) return false;

    if (!force) {
      // 没有移除条件 = 设计上就该跟到死
      if (!c.def.removeCondition) return false;
      // 有条件但没注入检查器 = 无法验证，拒绝而不是放行
      if (!this._checker) return false;
      if (!this._checker(c.def.removeCondition, c.def)) return false;
    }

    this._active.delete(id);
    this._costCount.delete(id);
    this._onChange?.(id, 'remove');
    return true;
  }

  /** 检查是否能移除（UI 显示用，不实际移除） */
  canRemove(id: string): boolean {
    const c = this._active.get(id);
    if (!c) return false;
    if (!c.def.removeCondition) return false;   // 不可移除
    if (!this._checker) return false;
    return this._checker(c.def.removeCondition, c.def);
  }

  clear(): void {
    const ids = [...this._active.keys()];
    this._active.clear();
    this._costCount.clear();
    for (const id of ids) this._onChange?.(id, 'remove');
  }

  has(id: string): boolean {
    return this._active.has(id);
  }

  get active(): ActiveCurse[] {
    return [...this._active.values()];
  }

  get count(): number {
    return this._active.size;
  }

  // ==================== 代价触发 ====================

  /**
   * 触发一次代价
   *
   * 【⚠️ 迭代时移除的坑】
   * 代价执行过程中，宿主可能回调 `remove()`（比如"扣血致死"）。
   * 直接遍历 `_active` 会触发 JS Map 的迭代失效——
   * 表现为"某个诅咒莫名其妙不触发了"，而且不报错。
   *
   * 所以先快照再遍历。
   */
  private _fire(def: CurseDef, trigger: CurseTrigger, event?: string): number {
    let fired = 0;
    for (const c of def.costs) {
      if (c.trigger !== trigger) continue;
      if (trigger === 'event' && c.event !== event) continue;

      this._costCount.set(def.id, (this._costCount.get(def.id) ?? 0) + 1);
      this._executor?.(c, def);
      fired++;
    }
    return fired;
  }

  /** 每帧调用（持续掉血等） */
  tick(): number {
    return this._fireAll('tick');
  }

  /** 事件触发（受击、拾取…） */
  trigger(event: string): number {
    return this._fireAll('event', event);
  }

  /** 一层结束 */
  onFloorEnd(): number {
    return this._fireAll('onFloorEnd');
  }

  /** 一局结束（结算） */
  onRunEnd(): number {
    return this._fireAll('onRunEnd');
  }

  private _fireAll(trigger: CurseTrigger, event?: string): number {
    // 【关键】快照，防止执行过程中被移除导致迭代失效
    const snapshot = [...this._active.values()];
    let n = 0;
    for (const c of snapshot) {
      // 可能已被前一条代价的副作用移除
      if (!this._active.has(c.def.id)) continue;
      n += this._fire(c.def, trigger, event);
    }
    return n;
  }

  /** 某诅咒的代价已触发次数 */
  costCount(id: string): number {
    return this._costCount.get(id) ?? 0;
  }

  // ==================== 效果 ====================

  /** 某诅咒的层数 */
  stacks(id: string): number {
    return this._active.get(id)?.stacks ?? 0;
  }

  /** 全部增益（重复获得时按层数累加 add / 累乘 mul，set 不随层数缩放） */
  effects(): CurseEffect[] {
    const out: CurseEffect[] = [];
    for (const c of this._active.values()) {
      const n = c.stacks;
      for (const e of c.def.effects) {
        if (n === 1) { out.push(e); continue; }
        /**
         * 【⚠️ 曾经的 bug：`set` 效果被乘了层数】
         *
         * 原实现只有「mul → 乘方，其它 → 乘以 n」两个分支，
         * 于是 `set` 被当成 `add` 处理：
         *
         *   2 层「最大生命设为 100」→ value = 200
         *
         * `set` 的语义是**覆盖**（"最大生命减半"这类固定值），
         * 叠加两层应该是 100，不是 200。
         * 与 blessing / meta 的同类问题同源：三个单元都把覆盖语义
         * 和累加语义混在了一个表达式里。
         *
         * 表现为"诅咒叠到 2 层时数值突然翻倍"，
         * 而数值策划表里写的是固定值——看代码的人会以为策划表写错了。
         */
        out.push({
          stat: e.stat,
          op: e.op,
          value: e.op === 'mul' ? Math.pow(e.value, n) : (e.op === 'set' ? e.value : e.value * n),
        });
      }
    }
    return out;
  }

  /** 按属性聚合（快速查看） */
  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.effects()) {
      const k = `${e.stat}.${e.op}`;
      if (e.op === 'mul') out[k] = (out[k] ?? 1) * e.value;
      else if (e.op === 'add') out[k] = (out[k] ?? 0) + e.value;
      else out[k] = e.value;
    }
    return out;
  }

  // ==================== 抽取 ====================

  /**
   * 加权抽取
   *
   * 【默认排除已持有的】
   * 不允许重复时，已持有的不该再出现在选项里。
   *
   * 【为什么与 blessing.pick() 是两份独立实现，而不抽成公共函数】
   * 这两段代码逐行同构，看上去就该抽走。但铁律 6 禁止单元之间横向 import，
   * 而 `_core/` 是共享层且**严禁本窗口修改**——放 `_core` 这条路走不通。
   * 抽到第三个新目录又会给整个库多一个"什么都能依赖"的垃圾桶层。
   *
   * 所以这里明确写清：**两份是刻意独立的。**
   * 理由不只是"规则不允许"，还有业务语义：
   * 祝福的池子只按稀有度过滤，诅咒这里额外要排除已持有的、
   * 且"权重"在诅咒侧的语义是"出现概率"而非"稀有度权重"。
   * 两边的演化方向不同（诅咒侧正在加"代价上限"过滤），
   * 强行共用会在第一次分叉时被迫加参数开关。
   *
   * 【改这里的注意】如果将来真要合并，必须同步改 blessing/README.md 的说明。
   */
  pick(rng: { next(): number }, n: number, filter?: (d: CurseDef) => boolean): CurseDef[] {
    let pool = this.all.filter((d) => {
      if (!this._allowDuplicate && this.has(d.id)) return false;
      return filter ? filter(d) : true;
    });

    const out: CurseDef[] = [];
    for (let k = 0; k < n; k++) {
      if (pool.length === 0) break;
      let total = 0;
      for (const d of pool) total += d.weight ?? 1;
      if (total <= 0) break;
      let r = rng.next() * total;
      let idx = pool.length - 1;
      for (let j = 0; j < pool.length; j++) {
        r -= pool[j].weight ?? 1;
        if (r < 0) { idx = j; break; }
      }
      out.push(pool[idx]);
      pool = pool.filter((_, i) => i !== idx);
    }
    return out;
  }

  // ==================== 存档 ====================

  exportState(): Array<{ id: string; since: number; stacks: number }> {
    return [...this._active.values()].map((c) => ({
      id: c.def.id, since: c.since, stacks: c.stacks,
    }));
  }

  /**
   * 导入存档
   *
   * 【⚠️ 曾经的 bug：stacks 不做校验，负数让增益反向】
   *
   * 原实现 `stacks: e.stacks ?? 1` 有两个洞：
   *
   *   1. `??` 只挡 null / undefined，**挡不住 NaN**
   *      → `Math.pow(value, NaN)` = NaN → 属性被写成 NaN
   *   2. 负数直接进来 → `effects()` 里 `Math.pow(value, -3)` 取**倒数**
   *      → 减益变增益（0.5 的"减半"变成 8 倍的"增强"），且不报任何错
   *
   * 存档是会被改的（本地文件、云同步冲突、跨版本残留），
   * "坏存档能写进任何值"是模式 C 的典型形态：
   * 导入路径绕开了 `add()` 的校验，于是成了唯一的后门。
   *
   * 实测（修复前）：`importState([{id:'c1', since:0, stacks:-3}])`
   *   → stacks = -3，mul 2 的效果变成 **0.125**
   *
   * 修法：层数取 >= 0 的整数，since 非有限时回落到当前时间。
   */
  importState(s: ReadonlyArray<{ id: string; since: number; stacks?: number }>): void {
    this._active.clear();
    /**
     * 【⚠️ 曾经的 bug：导入后代价计数与"已激活"状态对不上】
     *
     * `_costCount` 只在 `remove` / `clear` 时清，
     * 于是"清掉旧档→导入新档"之后，新档的诅咒**沿用了上一局的代价计数**。
     * `describe()` 里显示的"代价已触发 N 次"是上一局留下的数字，
     * 读档后 UI 一上来就显示"已触发 7 次"，而这一局一次都还没触发过。
     *
     * 语义上"导入"等价于"用这份存档重建状态"，
     * 那计数就该跟状态一起被重建——历史代价不属于这一局。
     */
    this._costCount.clear();
    for (const e of s) {
      const def = this._defs.get(e.id);
      if (!def) continue;   // 配置里删了：跳过
      this._active.set(e.id, {
        def,
        since: numOr(e.since, this._now()),
        stacks: Math.max(0, Math.floor(numOr(e.stacks, 1))),
      });
    }
  }

  // ==================== 调试 ====================

  /**
   * 【铁律 5】可卸载
   *
   * 【为什么原先没有】
   * 这个类的字段全是自己的 Map，没有注册任何外部监听器，
   * 于是"看起来不需要 destroy"。但调用方持有的 `onChange`、
   * 以及"系统是否还活着"这件事，仍然需要一个明确的终点：
   * 切场景时没有 destroy，就只剩"把引用置空靠 GC"这一条路，
   * 而 `_active` 里残留的诅咒在下一局被 `importState` 之前仍可被读到。
   */
  destroy(): void {
    this._active.clear();
    this._costCount.clear();
    this._defs.clear();
  }

  describe(): string {
    const act = this.active;
    if (act.length === 0) return 'Curse（空）';
    const lines = [`Curse（${act.length} 个）`];
    for (const c of act) {
      const removable = c.def.removeCondition
        ? (this.canRemove(c.def.id) ? '✓ 可移除' : '· 条件未满足')
        : '✗ 不可移除';
      const multi = c.stacks > 1 ? ` ×${c.stacks}` : '';
      lines.push(`  ${c.def.name}${multi}  [${removable}]`);
      for (const e of c.def.effects) lines.push(`      增益 ${e.stat} ${e.op} ${e.value}`);
      for (const cost of c.def.costs) {
        const what = cost.trigger === 'event' ? cost.event : cost.trigger;
        lines.push(`      代价 ${what} ×${this.costCount(c.def.id)}  ${cost.desc ?? ''}`);
      }
    }
    return lines.join('\n');
  }
}
