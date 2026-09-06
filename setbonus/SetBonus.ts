/**
 * SetBonus —— 装备套装效果
 *
 * 【它解决什么】
 *
 * N 件套效果看起来简单，但有几个真实的分歧点，
 * 每个分歧搞错都会让玩家觉得"数值不对"：
 *
 * 1. **部位去重**：穿两个头盔算 2 件吗？（大多数游戏：不算）
 * 2. **阈值是否叠加**：4 件时生效的是「4 件档」还是「2 件档 + 4 件档」？
 *    - 魔兽世界式：只生效最高档（4 件 = 4 件档）
 *    - 暗黑 3 式：叠加（4 件 = 2 件档 + 4 件档）
 * 3. **同名装备**：两把相同的剑算 2 件吗？（通常不算，因为占同一个部位）
 * 4. **移除装备后效果要正确回退**（最常见的 bug 来源）
 *
 * 【设计：声明式 + 自动重算】
 *
 * 你只需要告诉它「哪些装备属于哪个套装、各档位有什么效果」，
 * 剩下的（计数、去重、阈值判定、效果汇总）全部自动。
 *
 * ```typescript
 * const sets = new SetBonusSystem({
 *   sets: [{
 *     id: 'flame',
 *     name: '烈焰套装',
 *     thresholds: [
 *       { count: 2, effects: [{ stat: 'atk', op: 'mul', value: 1.10 }] },
 *       { count: 4, effects: [{ stat: 'atk', op: 'mul', value: 1.25 },
 *                             { stat: 'cdr', op: 'add', value: 0.15 }] },
 *     ],
 *   }],
 *   cumulative: false,      // false = 只生效最高档（WoW 式）
 * });
 *
 * sets.equip('flame_helm', { set: 'flame', slot: 'head' });
 * sets.equip('flame_chest', { set: 'flame', slot: 'chest' });
 * sets.summary();   // → { atk: 1.10 }  （2 件档生效）
 * ```
 *
 * 【无引擎依赖】
 */

// ==================== 类型 ====================

/** 装备槽位 */
export type SlotId = string;

/** 效果运算 */
export type EffectOp = 'add' | 'mul' | 'set' | 'min' | 'max';

/** 一条数值效果 */
export interface StatEffect {
  /** 目标属性名（由你的属性系统解释） */
  readonly stat: string;
  readonly op: EffectOp;
  readonly value: number;
}

/** 一档阈值 */
export interface Threshold {
  /** 需要几件（按**不同部位**计） */
  readonly count: number;
  /** 该档位激活时的效果 */
  readonly effects: readonly StatEffect[];
  /** 说明（UI 显示） */
  readonly desc?: string;
}

/** 套装定义 */
export interface SetDef {
  readonly id: string;
  readonly name: string;
  readonly thresholds: readonly Threshold[];
  /** 说明 */
  readonly desc?: string;
}

/** 一件装备 */
export interface EquipItem {
  readonly id: string;
  /** 所属套装 id（不属于任何套装则不填） */
  readonly set?: string;
  /** 占用哪个槽位 */
  readonly slot: SlotId;
}

export interface SetBonusOptions {
  readonly sets: readonly SetDef[];
  /**
   * 阈值是否叠加（默认 false）
   *
   * - `false`：只生效**已达到的最高档**（WoW / FF14 式）
   *   2 件档 +10%，4 件档 +25% → 穿 4 件时是 +25%
   * - `true`：所有已达档位累加（暗黑 3 式）
   *   2 件档 +10%，4 件档 +25% → 穿 4 件时是 +35%
   *
   * 【⚠️ 这个选择会显著改变数值曲线】
   * 叠加模式下 6 件套的强度远超非叠加，
   * 配表时要按叠加后的实际值来平衡，而不是单看每档。
   */
  readonly cumulative?: boolean;
  /** 状态变化时回调 */
  readonly onChange?: (active: readonly ActiveThreshold[]) => void;
}

/** 已激活的一档 */
export interface ActiveThreshold {
  readonly setId: string;
  readonly setName: string;
  readonly count: number;
  readonly effects: readonly StatEffect[];
  readonly desc?: string;
}

/** 某个套装的进度 */
export interface SetProgress {
  readonly setId: string;
  readonly setName: string;
  /** 已装备的**不同部位**数（这才是套装计数） */
  readonly equipped: number;
  /** 套装总共需要的件数（最高档的 count） */
  readonly required: number;
  /** 下一档还差几件（满了则为 null） */
  readonly toNext: number | null;
  readonly nextThreshold: number | null;
  readonly activeThresholds: readonly number[];
}

// ==================== 实现 ====================

export class SetBonusSystem {
  private readonly _sets = new Map<string, SetDef>();
  private readonly _cumulative: boolean;
  private readonly _onChange?: (a: readonly ActiveThreshold[]) => void;

  /** 已装备：slot → item */
  private readonly _equipped = new Map<SlotId, EquipItem>();

  constructor(opts: SetBonusOptions) {
    this._cumulative = opts.cumulative ?? false;
    this._onChange = opts.onChange;

    for (const s of opts.sets) {
      if (this._sets.has(s.id)) {
        throw new Error(`[SetBonus] 套装 id 重复：${s.id}`);
      }
      this._validateSet(s);
      this._sets.set(s.id, s);
    }
  }

  /**
   * 构造时校验配置
   *
   * 【为什么必须有】
   * 阈值乱序（4 件档写在 2 件档前面）会让"只生效最高档"的逻辑
   * 选到错误的一档，而且**不报错**——只是数值不对。
   */
  private _validateSet(s: SetDef): void {
    if (s.thresholds.length === 0) {
      throw new Error(`[SetBonus] 套装 "${s.id}" 没有任何档位`);
    }
    let prev = -1;
    for (const t of s.thresholds) {
      if (!Number.isInteger(t.count) || t.count <= 0) {
        throw new Error(`[SetBonus] 套装 "${s.id}" 的档位 ${t.count} 必须是正整数`);
      }
      if (t.count <= prev) {
        throw new Error(
          `[SetBonus] 套装 "${s.id}" 的档位必须递增且唯一：${prev} 之后出现了 ${t.count}`
        );
      }
      prev = t.count;
      if (t.effects.length === 0) {
        throw new Error(`[SetBonus] 套装 "${s.id}" 的 ${t.count} 件档没有任何效果`);
      }
    }
  }

  // ==================== 装备操作 ====================

  /**
   * 装备一件
   *
   * @returns 被替换下来的旧装备（没有则 undefined）
   *
   * 【⚠️ 同槽位自动替换】
   * 不先卸下再装备的话，同一个部位会同时存在两件：
   * 计数时因为按部位去重，看起来是对的，
   * 但卸下一件时另一件还在，导致**效果没有正确移除**。
   */
  equip(item: EquipItem): EquipItem | undefined {
    if (item.set !== undefined && !this._sets.has(item.set)) {
      throw new Error(
        `[SetBonus] 装备 "${item.id}" 引用了未定义的套装：${item.set}` +
        `（已定义：${[...this._sets.keys()].join(', ')}）`
      );
    }

    const old = this._equipped.get(item.slot);
    this._equipped.set(item.slot, item);
    this._onChange?.(this.activeThresholds());
    return old;
  }

  /** 卸下一个槽位 */
  unequip(slot: SlotId): EquipItem | undefined {
    const old = this._equipped.get(slot);
    if (old) {
      this._equipped.delete(slot);
      this._onChange?.(this.activeThresholds());
    }
    return old;
  }

  /** 按 id 卸下 */
  unequipById(id: string): EquipItem | undefined {
    for (const [slot, item] of this._equipped) {
      if (item.id === id) {
        this._equipped.delete(slot);
        this._onChange?.(this.activeThresholds());
        return item;
      }
    }
    return undefined;
  }

  /** 全部卸下 */
  clear(): void {
    this._equipped.clear();
    this._onChange?.(this.activeThresholds());
  }

  get equipped(): EquipItem[] {
    return [...this._equipped.values()];
  }

  // ==================== 计数 ====================

  /**
   * 某套装已装备的**不同部位**数
   *
   * 【为什么按部位计，而不是按件数计】
   * 玩家穿了头盔 + 头盔（不可能，因为同槽位会替换），
   * 或者更现实的：一把主手剑 + 一把副手剑，都属于"烈焰套"。
   *
   * 如果按件数计，两把剑算 2 件；
   * 按部位计，剑占的是 weapon_main / weapon_off 两个不同部位，也是 2 件。
   *
   * 真正要防的是**同一部位被重复计数**——
   * 由于 `_equipped` 是 slot → item 的映射，这在结构上就不可能发生了。
   *
   * 【同名装备】
   * 两把 id 相同的剑占不同槽位时算 2 件（多数游戏如此）。
   * 若你的设计是"同名只算 1 件"，用 `countDistinctIds`。
   */
  countFor(setId: string): number {
    let n = 0;
    for (const item of this._equipped.values()) {
      if (item.set === setId) n++;
    }
    return n;
  }

  /** 按不同装备 id 计数（同名装备只算 1 件） */
  countDistinctIds(setId: string): number {
    const ids = new Set<string>();
    for (const item of this._equipped.values()) {
      if (item.set === setId) ids.add(item.id);
    }
    return ids.size;
  }

  // ==================== 激活判定 ====================

  /**
   * 已激活的档位
   *
   * 【非叠加模式】只取**已达到的最高档**
   * 【叠加模式】取所有已达到的档
   */
  activeThresholds(): ActiveThreshold[] {
    const out: ActiveThreshold[] = [];

    for (const set of this._sets.values()) {
      const n = this.countFor(set.id);
      const reached = set.thresholds.filter((t) => n >= t.count);
      if (reached.length === 0) continue;

      const use = this._cumulative ? reached : [reached[reached.length - 1]];
      for (const t of use) {
        out.push({
          setId: set.id,
          setName: set.name,
          count: t.count,
          effects: t.effects,
          ...(t.desc !== undefined ? { desc: t.desc } : {}),
        });
      }
    }

    return out;
  }

  /**
   * 汇总所有激活效果
   *
   * 【为什么返回分运算的数组，而不是直接算出最终值】
   * 属性系统对 add / mul 的合并顺序有讲究：
   * 通常是 `(base + Σadd) × (1 + Σmul)`。
   * 直接在这里算死就会和你的属性系统打架。
   * 返回原始效果列表，交给属性系统按自己的规则合并。
   */
  effects(): StatEffect[] {
    const out: StatEffect[] = [];
    for (const t of this.activeThresholds()) out.push(...t.effects);
    return out;
  }

  /**
   * 便捷：按属性聚合（同属性同运算的值相加/相乘）
   *
   * 只在你不需要精细控制合并顺序时用。
   */
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

  /** 某套装的进度（UI 显示用） */
  progressOf(setId: string): SetProgress | null {
    const set = this._sets.get(setId);
    if (!set) return null;

    const equipped = this.countFor(setId);
    const required = set.thresholds[set.thresholds.length - 1].count;
    const active = this.activeThresholds()
      .filter((t) => t.setId === setId)
      .map((t) => t.count);

    const next = set.thresholds.find((t) => equipped < t.count);

    return {
      setId,
      setName: set.name,
      equipped,
      required,
      toNext: next ? next.count - equipped : null,
      nextThreshold: next ? next.count : null,
      activeThresholds: active,
    };
  }

  /** 所有套装的进度 */
  allProgress(): SetProgress[] {
    return [...this._sets.keys()]
      .map((id) => this.progressOf(id))
      .filter((p): p is SetProgress => p !== null);
  }

  // ==================== 调试 ====================

  describe(): string {
    const lines: string[] = [`SetBonus（${this._cumulative ? '叠加' : '仅最高档'}）`];

    for (const p of this.allProgress()) {
      const mark = p.activeThresholds.length > 0
        ? `✓ 已激活 ${p.activeThresholds.join('/')} 件档`
        : `未激活`;
      const next = p.toNext !== null ? `（再 ${p.toNext} 件到 ${p.nextThreshold} 件档）` : '（已满）';
      lines.push(`  ${p.setName.padEnd(10)} ${p.equipped}/${p.required} 件  ${mark} ${next}`);
    }

    const active = this.activeThresholds();
    if (active.length > 0) {
      lines.push('  当前效果：');
      for (const a of active) {
        for (const e of a.effects) {
          lines.push(`    ${a.setName} ${a.count}件 → ${e.stat} ${e.op} ${e.value}`);
        }
      }
    }
    return lines.join('\n');
  }
}
