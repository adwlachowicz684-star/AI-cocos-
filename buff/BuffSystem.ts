/**
 * BuffSystem —— 增益/减益系统
 *
 * 【它解决什么】
 * "中毒 5 秒每秒掉 10 血"、"攻击力 +30% 持续 10 秒"、
 * "最多叠 3 层，每层 +5% 移速"——
 * 这些需求看似简单，但组合起来有很多坑：
 *
 * - 叠层时时长怎么算？重置还是累加？
 * - 到期了怎么精确移除（不能影响其他 buff）？
 * - 同源 buff 刷新时会不会重复叠加？
 * - 死了之后要不要清？
 * - 存档怎么存？
 *
 * 【设计：与 Modifier 协作】
 * 本类只管**生命周期**（什么时候加、什么时候删、叠几层），
 * 具体数值效果委托给 `damage-pipeline/Modifier`：
 *
 * ```
 * BuffSystem（生命周期）→ 变化时回调 → 外部重建 ModifierSet → 数值生效
 * ```
 * 这样职责清晰，也避免了 BuffSystem 依赖具体的属性系统。
 *
 * 【使用示例】
 * ```typescript
 * const buffs = new BuffSystem();
 *
 * buffs.onChange((delta) => {
 *   // 收到变更通知，重建数值
 *   mods.clear();
 *   for (const b of buffs.active) {
 *     mods.add(b.def.modifier);
 *   }
 * });
 *
 * buffs.register({ id: 'poison', duration: 5, maxStacks: 5,
 *                  stackMode: 'refresh', tickInterval: 1 });
 *
 * buffs.apply('poison');            // 叠 1 层
 * buffs.apply('poison');            // 叠 2 层
 * buffs.stacks('poison');           // 2
 *
 * buffs.update(dt, (id, stacks) => {  // 每 tick 触发
 *   if (id === 'poison') damage(10 * stacks);
 * });
 * ```
 *
 * 【无引擎依赖】
 */

import { safeDt } from '../_core/math';
import { needCount } from '../_core/guard';

export type StackMode =
  /** 刷新：重置持续时间，层数上限由 maxStacks 控制 */
  | 'refresh'
  /** 累加时长：层数不变，剩余时间累加 */
  | 'extend'
  /** 独立：每次应用都是独立的一层，各自计时 */
  | 'independent';

export interface BuffDef {
  readonly id: string;
  /** 持续时间（秒）。Infinity = 永久 */
  readonly duration: number;
  /** 最大层数 */
  readonly maxStacks?: number;
  /** 叠加模式（默认 refresh） */
  readonly stackMode?: StackMode;
  /**
   * tick 间隔（秒）。有值时到期会触发 onTick 回调
   * 【用途】中毒每 1 秒掉一次血
   */
  readonly tickInterval?: number;
  /** 是否可被驱散（净化技能） */
  readonly dispellable?: boolean;
  /** 死亡时是否清除（默认 true） */
  readonly clearOnDeath?: boolean;
  /** 标签：用于分组移除（"移除所有 debuff"） */
  readonly tags?: readonly string[];
}

/** 一个生效中的 buff 实例 */
export interface BuffInstance {
  readonly def: BuffDef;
  /** 当前层数 */
  stacks: number;
  /** 剩余时间（秒） */
  remain: number;
  /** 距离下次 tick 的时间 */
  tickTimer: number;
}

/** 变更类型 */
export type BuffChangeKind = 'add' | 'remove' | 'stack' | 'expire' | 'clear';

export interface BuffChange {
  readonly kind: BuffChangeKind;
  readonly id: string;
  readonly stacks: number;
}

export class BuffSystem {
  private readonly _defs = new Map<string, BuffDef>();
  private readonly _active = new Map<string, BuffInstance>();

  /** independent 模式的多个实例 */
  private readonly _independent = new Map<string, BuffInstance[]>();

  private _onChange: ((c: BuffChange) => void) | null = null;

  /** 注册定义 */
  register(def: BuffDef): this {
    if (!(def.duration > 0)) {
      throw new Error(`[BuffSystem] ${def.id}: duration 必须为正（永久用 Infinity）`);
    }
    if (def.maxStacks !== undefined && def.maxStacks < 1) {
      throw new Error(`[BuffSystem] ${def.id}: maxStacks 至少为 1`);
    }
    if (def.tickInterval !== undefined && !(def.tickInterval > 0)) {
      throw new Error(`[BuffSystem] ${def.id}: tickInterval 必须为正`);
    }
    this._defs.set(def.id, def);
    return this;
  }

  has(id: string): boolean {
    return this._active.has(id);
  }

  /** 当前层数（0 = 未生效） */
  stacks(id: string): number {
    return this._active.get(id)?.stacks ?? 0;
  }

  /** 剩余时间（未生效返回 0） */
  remain(id: string): number {
    return this._active.get(id)?.remain ?? 0;
  }

  /** 所有生效中的 buff */
  get active(): readonly BuffInstance[] {
    return Array.from(this._active.values());
  }

  get count(): number {
    return this._active.size;
  }

  /**
   * 应用一个 buff
   *
   * @returns 实际层数
   */
  apply(id: string, stacks = 1): number {
    /**
     * 【⚠️ stacks 必须有上界】
     *
     * independent 模式下 `stacks` 直接就是 `for` 的循环次数。
     * 实测 `apply('x', Infinity)`（stackMode: 'independent'）→ 退出码 124，进程卡死。
     * NaN 则相反：`i < NaN` 恒假，静默什么都不加，
     * 表现为"叠了 buff 但状态栏没变化"且无任何报错。
     */
    const n = needCount(stacks, 'stacks');

    const def = this._defs.get(id);
    if (!def) throw new Error(`[BuffSystem] 未注册的 buff: ${id}`);

    const mode = def.stackMode ?? 'refresh';

    if (mode === 'independent') {
      const list = this._independent.get(id) ?? [];
      for (let i = 0; i < n; i++) {
        list.push(this._makeInstance(def));
      }
      this._independent.set(id, list);
      // 同步一个汇总实例供查询
      this._syncIndependent(id);
      this._emit('add', id, this.stacks(id));
      return this.stacks(id);
    }

    const exist = this._active.get(id);
    const max = def.maxStacks ?? 1;

    if (!exist) {
      this._active.set(id, { def, stacks: Math.min(stacks, max), remain: def.duration, tickTimer: def.tickInterval ?? 0 });
      this._emit('add', id, this.stacks(id));
      return this.stacks(id);
    }

    if (mode === 'refresh') {
      exist.stacks = Math.min(exist.stacks + stacks, max);
      exist.remain = def.duration; // 刷新时长
      this._emit('stack', id, exist.stacks);
    } else {
      // extend
      exist.remain += def.duration;
      exist.stacks = Math.min(exist.stacks + stacks, max);
      this._emit('stack', id, exist.stacks);
    }
    return exist.stacks;
  }

  /** 移除（可指定层数，默认全移除） */
  remove(id: string, stacks = Infinity): boolean {
    const inst = this._active.get(id);
    if (!inst) return false;

    if (stacks >= inst.stacks) {
      this._active.delete(id);
      this._independent.delete(id);
      this._emit('remove', id, 0);
      return true;
    }

    inst.stacks -= stacks;
    this._emit('remove', id, inst.stacks);
    return true;
  }

  /** 按标签批量移除（"驱散所有 debuff"） */
  removeByTag(tag: string): number {
    let n = 0;
    for (const [id, inst] of Array.from(this._active)) {
      if (inst.def.tags?.includes(tag)) {
        if (inst.def.dispellable === false) continue;
        this._active.delete(id);
        this._emit('remove', id, 0);
        n++;
      }
    }
    return n;
  }

  /** 驱散全部可驱散的 */
  dispelAll(): number {
    let n = 0;
    for (const [id, inst] of Array.from(this._active)) {
      if (inst.def.dispellable === false) continue;
      this._active.delete(id);
      this._emit('remove', id, 0);
      n++;
    }
    return n;
  }

  /** 清空全部（死亡、换关） */
  clear(): void {
    const had = this._active.size > 0;
    this._active.clear();
    this._independent.clear();
    if (had) this._emit('clear', '', 0);
  }

  /** 死亡时清理（只清 clearOnDeath !== false 的） */
  clearOnDeath(): number {
    let n = 0;
    for (const [id, inst] of Array.from(this._active)) {
      if (inst.def.clearOnDeath === false) continue;
      this._active.delete(id);
      this._independent.delete(id);
      this._emit('remove', id, 0);
      n++;
    }
    return n;
  }

  /**
   * 每帧推进
   *
   * @param onTick 触发 tick 时回调（用于 DoT/HoT）
   */
  update(dt: number, onTick?: (id: string, stacks: number) => void): void {
    // 【为什么必须守卫 dt】
    // `inst.remain -= NaN` 会让 remain 变 NaN，
    // 此后 `remain <= 0` 恒为 false → **buff 永不消失**，
    // 中毒/减益永久挂在角色身上，且不报错、不可自愈。
    // Infinity 同理（-Infinity 会让 remain 变 -Infinity，反而立即过期）。
    if (!safeDt(dt)) return;

    for (const [id, inst] of Array.from(this._active)) {
      inst.remain -= dt;

      /**
       * tick 计时
       *
       * 【坑】计时器必须**总是**推进，与这一帧有没有传 onTick 无关。
       * 否则"某些帧传了回调、某些帧没传"会导致 tick 间隔不准——
       * 表现为中毒掉血忽快忽慢，而且极难定位。
       */
      if (inst.def.tickInterval !== undefined) {
        inst.tickTimer -= dt;

        /**
         * 【为什么需要 guard】
         *
         * `Infinity - 0.1` 仍然是 `Infinity`，而 `-Infinity + 0.1` 也仍是
         * `-Infinity`（Infinity 吸收有限数）→ 循环条件恒真 → **永久死循环**。
         *
         * 即使入口已拒绝 Infinity，超长卡顿（dt 很大）仍会让循环跑
         * 几百万次。guard 把"补帧"限制在合理范围内——
         * 超出的部分直接丢弃，而不是把卡顿放大成卡死。
         *
         * 上限 64 与 `bullet-pattern` 对齐；超出后把计时器重置到
         * 一个正的起点，避免下一帧继续累积。
         */
        let guard = 0;
        while (inst.tickTimer <= 0 && guard++ < 64) {
          onTick?.(id, inst.stacks);
          inst.tickTimer += inst.def.tickInterval;
        }
        if (inst.tickTimer <= 0) inst.tickTimer = inst.def.tickInterval;
      }

      if (inst.remain <= 0) {
        this._active.delete(id);
        this._emit('expire', id, 0);
      }
    }

    // independent 模式的实例
    for (const [id, list] of Array.from(this._independent)) {
      const kept: BuffInstance[] = [];
      for (const inst of list) {
        inst.remain -= dt;
        if (inst.remain > 0) kept.push(inst);
      }
      if (kept.length !== list.length) {
        this._independent.set(id, kept);
        this._syncIndependent(id);
      }
    }
  }

  // ==================== 订阅 ====================

  /** 订阅变更（外部在这里重建 ModifierSet） */
  onChange(fn: (c: BuffChange) => void): () => void {
    this._onChange = fn;
    return () => {
      if (this._onChange === fn) this._onChange = null;
    };
  }

  // ==================== 存档 ====================

  /** 导出状态 */
  export(): Array<{ id: string; stacks: number; remain: number }> {
    return Array.from(this._active.values()).map((i) => ({
      id: i.def.id,
      stacks: i.stacks,
      remain: i.remain,
    }));
  }

  /** 恢复状态 */
  import(data: ReadonlyArray<{ id: string; stacks: number; remain: number }>): void {
    this.clear();
    for (const d of data) {
      const def = this._defs.get(d.id);
      if (!def) continue;
      this._active.set(d.id, {
        def,
        stacks: d.stacks,
        remain: d.remain,
        tickTimer: def.tickInterval ?? 0,
      });
    }
    this._emit('add', '', this._active.size);
  }

  destroy(): void {
    this.clear();
    this._defs.clear();
    this._onChange = null;
  }

  // ==================== 内部 ====================

  private _makeInstance(def: BuffDef): BuffInstance {
    return { def, stacks: 1, remain: def.duration, tickTimer: def.tickInterval ?? 0 };
  }

  private _syncIndependent(id: string): void {
    const list = this._independent.get(id);
    const def = this._defs.get(id);
    if (!list || !def) return;
    if (list.length === 0) {
      this._active.delete(id);
      return;
    }
    // 汇总：层数 = 实例数，剩余时间 = 最短的那个
    let minRemain = Infinity;
    for (const i of list) minRemain = Math.min(minRemain, i.remain);
    this._active.set(id, {
      def,
      stacks: list.length,
      remain: minRemain,
      tickTimer: def.tickInterval ?? 0,
    });
  }

  private _emit(kind: BuffChangeKind, id: string, stacks: number): void {
    this._onChange?.({ kind, id, stacks });
  }
}
