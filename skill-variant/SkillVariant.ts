/**
 * skill-variant —— 技能变体（遗物改造技能）
 *
 * 【它解决什么】
 *
 * 肉鸽的深度玩法之一：同一个技能被遗物改造成完全不同的东西。
 *
 * ```
 * 火球术（基础）
 *   + 遗物「多重投射」 → 一次发 3 发
 *   + 遗物「穿透」     → 弹道穿透 +2
 *   + 遗物「爆裂」     → 命中时爆炸
 *   = 一次发 3 发、穿透、会爆炸的火球
 * ```
 *
 * 手写的典型做法是搜遍代码找 `if (hasRelic('multi'))`——
 * 三件遗物还能忍，三十件之后就是灾难。
 *
 * 本模块用**补丁（Patch）**描述改造，技能定义保持纯净：
 *
 * ```typescript
 * const multi: VariantDef = {
 *   id: 'multi', name: '多重投射',
 *   patches: [{ op: 'set', path: 'projectile.count', value: 3 }],
 * };
 * ```
 *
 * 【三个必须处理的真实问题】
 *
 * 1. **深拷贝**：不深拷贝就是改了原型，所有敌人共享同一个技能定义
 * 2. **条件变体**：只在特定条件下生效（血量低于 30% 时…）
 * 3. **冲突**：两个变体改同一个字段，谁赢？
 *
 * 【无引擎依赖】
 */

import { assertSafePath } from '../_core/guard';

// ==================== 类型 ====================

/** 补丁运算 */
export type PatchOp =
  /** 设置值（路径不存在则创建） */
  | 'set'
  /** 数值加法 */
  | 'add'
  /** 数值乘法 */
  | 'mul'
  /** 数组追加 */
  | 'push'
  /** 删除字段 / 数组元素 */
  | 'remove'
  /** 数值取最大 */
  | 'max'
  /** 数值取最小 */
  | 'min';

/** 一条补丁 */
export interface Patch {
  readonly op: PatchOp;
  /**
   * 目标路径，点号分隔
   *
   * `'projectile.count'`、`'damage.raw'`、`'tags'`
   */
  readonly path: string;
  readonly value?: unknown;
  /** 说明（调试用） */
  readonly desc?: string;
}

/** 变体生效条件 */
export interface VariantCondition {
  /** 条件标识，由一个外部求值器解释 */
  readonly id: string;
  /** 参数 */
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * 变体定义
 */
export interface VariantDef {
  readonly id: string;
  readonly name: string;
  /** 补丁列表（按顺序应用） */
  readonly patches: readonly Patch[];
  /**
   * 生效条件（全部满足才应用）
   *
   * 【为什么是条件数组而不是单个】
   * "血量低于 30% **且** 手持近战武器" 这类复合条件很常见。
   */
  readonly conditions?: readonly VariantCondition[];
  /**
   * 目标技能筛选
   *
   * - 不填：对所有技能生效
   * - 字符串数组：只对这些技能 id 生效
   * - 标签数组：只对带这些标签的技能生效
   */
  readonly targets?: {
    readonly skills?: readonly string[];
    readonly tags?: readonly string[];
  };
  /** 优先级（大的后应用，即覆盖前面的） */
  readonly priority?: number;
  /** 与哪些变体互斥（同 id 只保留优先级高的） */
  readonly excludes?: readonly string[];
  readonly desc?: string;
}

export interface SkillVariantOptions {
  /**
   * 条件求值器
   *
   * 【为什么注入而不是内建】
   * 条件可能涉及血量、层数、天气、时间……
   * 内建任何一项都会产生业务依赖。
   */
  readonly evaluator?: (c: VariantCondition, ctx: VariantContext) => boolean;
  /** 变体应用回调（用于打日志 / 刷新 UI） */
  readonly onApply?: (variantId: string, skillId: string) => void;
  /** 冲突时的处理（默认 'priority'） */
  readonly onConflict?: 'priority' | 'error' | 'first';
}

/** 求值上下文 */
export interface VariantContext {
  readonly skillId: string;
  readonly skillTags: readonly string[];
  /** 业务数据，由调用方塞进来 */
  readonly data: Readonly<Record<string, unknown>>;
}

// ==================== 实现 ====================

export class SkillVariantSystem<T extends Record<string, unknown>> {
  private readonly _variants = new Map<string, VariantDef>();
  private readonly _evaluator?: (c: VariantCondition, ctx: VariantContext) => boolean;
  private readonly _onApply?: (variantId: string, skillId: string) => void;
  private readonly _onConflict: 'priority' | 'error' | 'first';

  constructor(opts: SkillVariantOptions = {}) {
    this._evaluator = opts.evaluator;
    this._onApply = opts.onApply;
    this._onConflict = opts.onConflict ?? 'priority';

    if (this._onConflict === 'error') {
      // error 模式下会检查路径冲突，见 _applyPatches
    }
  }

  // ==================== 注册 ====================

  register(v: VariantDef): void {
    if (this._variants.has(v.id)) {
      throw new Error(`[SkillVariant] 变体 id 重复：${v.id}`);
    }
    this._validate(v);
    this._variants.set(v.id, v);
  }

  registerAll(vs: readonly VariantDef[]): void {
    for (const v of vs) this.register(v);
  }

  unregister(id: string): boolean {
    return this._variants.delete(id);
  }

  get(id: string): VariantDef | undefined {
    return this._variants.get(id);
  }

  get all(): VariantDef[] {
    return [...this._variants.values()];
  }

  /** 构造时校验：早失败比运行时诡异好 */
  private _validate(v: VariantDef): void {
    if (v.patches.length === 0) {
      throw new Error(`[SkillVariant] 变体 "${v.id}" 没有任何补丁`);
    }
    for (const p of v.patches) {
      if (!p.path || p.path.trim() === '') {
        throw new Error(`[SkillVariant] 变体 "${v.id}" 有一条补丁的 path 为空`);
      }
      if (p.op !== 'remove' && p.value === undefined) {
        throw new Error(
          `[SkillVariant] 变体 "${v.id}" 的补丁 "${p.path}" 是 ${p.op} 操作但没给 value`
        );
      }
      if ((p.op === 'add' || p.op === 'mul' || p.op === 'max' || p.op === 'min') &&
          typeof p.value !== 'number') {
        throw new Error(
          `[SkillVariant] 变体 "${v.id}" 的补丁 "${p.path}" 是 ${p.op} 操作，value 必须是数字`
        );
      }
      if (p.op === 'push' && !Array.isArray(p.value)) {
        throw new Error(
          `[SkillVariant] 变体 "${v.id}" 的补丁 "${p.path}" 是 push 操作，value 必须是数组`
        );
      }
    }
  }

  // ==================== 核心 ====================

  /**
   * 应用变体，产出一个新的技能定义
   *
   * **绝不修改传入的 base**——这是本模块最重要的保证。
   */
  apply(
    base: T,
    activeVariantIds: readonly string[],
    ctx: Omit<VariantContext, 'skillId' | 'skillTags'> &
      Partial<Pick<VariantContext, 'skillId' | 'skillTags'>>
  ): { result: T; applied: string[] } {
    const skillId = ctx.skillId ?? (base['id'] as string) ?? '';
    const skillTags = ctx.skillTags ?? (base['tags'] as readonly string[]) ?? [];

    const fullCtx: VariantContext = {
      skillId,
      skillTags,
      data: ctx.data,
    };

    // ① 筛出真正生效的变体
    const effective = this._resolve(activeVariantIds, fullCtx);

    /**
     * ② 【核心：深拷贝】
     *
     * 【⚠️ 这是本模块最容易出事的一行】
     *
     * 不深拷贝的话，`cloned.projectile.count = 3` 改的是**原型**，
     * 于是所有敌人、所有玩家的火球术都变成 3 发——
     * 而且**不报错**，只是"数值莫名其妙不对"。
     *
     * 更糟的是它会累积：玩家拿一次遗物，全局 +3；
     * 拿两次，全局 +6。表现是"越玩越强，强得离谱"。
     *
     * 【为什么用结构化深拷贝而不是 JSON.parse(JSON.stringify())】
     * JSON 会丢掉 undefined、Date、Map/Set，还会把 NaN 变成 null。
     * 技能定义里如果有函数（比如自定义判定回调）也会被吞掉。
     */
    const cloned = deepClone(base) as T;

    // ③ 按顺序应用补丁
    for (const v of effective) {
      this._applyPatches(cloned, v);
      this._onApply?.(v.id, skillId);
    }

    return { result: cloned, applied: effective.map((v) => v.id) };
  }

  /**
   * 筛选出真正生效的变体（处理目标筛选、条件、互斥、优先级）
   */
  private _resolve(ids: readonly string[], ctx: VariantContext): VariantDef[] {
    const picked: VariantDef[] = [];

    for (const id of ids) {
      const v = this._variants.get(id);
      // 未注册的变体静默跳过：可能来自旧存档，不该让整个技能系统崩掉
      if (!v) continue;

      // ① 目标筛选
      if (!this._targetMatches(v, ctx)) continue;

      // ② 条件
      if (!this._conditionsMet(v, ctx)) continue;

      picked.push(v);
    }

    // ③ 互斥：同组只留优先级最高的
    const final: VariantDef[] = [];
    for (const v of picked) {
      const blockedBy = final.find(
        (f) => (f.excludes?.includes(v.id) ?? false) || (v.excludes?.includes(f.id) ?? false)
      );
      if (!blockedBy) {
        final.push(v);
        continue;
      }
      if (this._onConflict === 'error') {
        throw new Error(
          `[SkillVariant] 变体 "${v.id}" 与 "${blockedBy.id}" 互斥，但都被激活了`
        );
      }
      if (this._onConflict === 'first') continue;

      // priority：优先级高的胜出，替换掉低的
      const pv = v.priority ?? 0;
      const pb = blockedBy.priority ?? 0;
      if (pv > pb) final[final.indexOf(blockedBy)] = v;
    }

    // ④ 按优先级排序（稳定：同优先级保持注册顺序）
    return final
      .map((v, i) => ({ v, i }))
      .sort((a, b) => ((a.v.priority ?? 0) - (b.v.priority ?? 0)) || (a.i - b.i))
      .map((x) => x.v);
  }

  private _targetMatches(v: VariantDef, ctx: VariantContext): boolean {
    const t = v.targets;
    if (!t) return true;

    let ok = true;
    if (t.skills && t.skills.length > 0) ok = ok && t.skills.includes(ctx.skillId);
    if (t.tags && t.tags.length > 0) {
      ok = ok && ctx.skillTags.some((tag) => t.tags!.includes(tag));
    }
    return ok;
  }

  private _conditionsMet(v: VariantDef, ctx: VariantContext): boolean {
    if (!v.conditions || v.conditions.length === 0) return true;
    /**
     * 【没有求值器时的行为】抛错（fail-closed），**不再视为已满足**
     *
     * 【⚠️ 旧注释说"视为已满足，因为静默失效更难查"——这个论证是错的】
     *
     * 它只比较了两种**静默**方案（fail-open 生效 / fail-closed 失效），
     * 却漏掉了第三种：**响亮抛错**。抛错既不静默生效也不静默失效，
     * 恰好消掉了原注释的顾虑。
     *
     * 而 fail-open 的代价远不止"效果可见"：
     * 条件在变体系统里扮演的是**门禁**角色——
     * "持有某遗物才生效""难度 ≥ 3 才生效"。
     * 门禁失效意味着玩家没有遗物也能吃遗物加成、
     * 高难变体被应用到普通局。
     *
     * 实测（修复前）：注册带 `conditions:[{id:'need-relic'}]` 的变体、
     * 不注入 `evaluator`，`apply(...)` 返回 `applied:["v"]`、
     * 结果 `dmg: 101`——**变体被无条件应用了**。
     *
     * 因为代码"看起来检查了条件"，review 时几乎不可能发现，
     * 属于门槛类静默错误，危害高于普通数值错误。
     */
    if (!this._evaluator) {
      throw new Error(
        `[SkillVariant] 变体 "${v.id}" 声明了 conditions，但构造时未注入 evaluator。` +
        `变体条件无法求值——为避免门禁失效（fail-open），这里直接抛错。`
      );
    }
    return v.conditions.every((c) => this._evaluator!(c, ctx));
  }

  // ==================== 补丁应用 ====================

  private _applyPatches(target: Record<string, unknown>, v: VariantDef): void {
    for (const p of v.patches) {
      try {
        applyPatch(target, p);
      } catch (e) {
        throw new Error(
          `[SkillVariant] 变体 "${v.id}" 的补丁 "${p.path}" 应用失败：${(e as Error).message}`
        );
      }
    }
  }

  // ==================== 调试 ====================

  /** 预览某组变体的效果（不真正应用） */
  preview(
    base: T,
    activeVariantIds: readonly string[],
    ctx: Omit<VariantContext, 'skillId' | 'skillTags'> &
      Partial<Pick<VariantContext, 'skillId' | 'skillTags'>>
  ): string {
    const { result, applied } = this.apply(base, activeVariantIds, ctx);
    const names = applied.map((id) => this._variants.get(id)?.name ?? id);
    const lines = [`技能「${ctx.skillId ?? base['id'] ?? '?'}」`];
    lines.push(`  应用了 ${applied.length} 个变体：${names.join('、') || '（无）'}`);
    lines.push(`  结果：${JSON.stringify(result)}`);
    return lines.join('\n');
  }
}

// ==================== 补丁函数（独立导出，便于单测） ====================

/**
 * 在对象上应用一条补丁
 *
 * 【路径规则】
 * `'a.b.c'` → `obj.a.b.c`
 * 数组索引用数字：`'tags.0'`
 *
 * 【⚠️ 中间的层不存在时怎么办】
 * 对 `set` / `push`：自动创建（{} 或 []）。
 * 对 `add` / `mul`：抛错——给一个不存在的值做加法，
 *   几乎一定是路径写错了，静默当 0 处理会掩盖错误。
 */
export function applyPatch(target: Record<string, unknown>, p: Patch): void {
  const parts = p.path.split('.').filter((s) => s !== '');
  if (parts.length === 0) {
    throw new Error('path 为空');
  }

  /**
   * 【⚠️ 必须在写入前拦下原型污染路径】
   *
   * 实测：
   * ```js
   * applyPatch({}, { op: 'set', path: '__proto__.skillPolluted', value: true });
   * ({}).skillPolluted // → true
   * ```
   * 这不是"改坏了 target"，而是**整个进程的所有对象都被污染**——
   * 之后任何 `if (obj.skillPolluted)` 都会为真，
   * 且污染不可逆、无报错、排查时没人会想到源头在一个补丁路径字符串里。
   *
   * 补丁路径来自遗物/词条配置表，属于**外部输入**，必须守。
   */
  assertSafePath(parts, p.path);

  const last = parts[parts.length - 1];
  let cur: Record<string, unknown> = target;

  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = cur[k];

    if (next === null || typeof next !== 'object') {
      if (p.op === 'add' || p.op === 'mul' || p.op === 'max' || p.op === 'min' || p.op === 'remove') {
        throw new Error(`路径 "${p.path}" 上 "${parts.slice(0, i + 1).join('.')}" 不存在`);
      }
      // set / push：创建中间层
      // 下一层是数字则建数组，否则建对象
      const nextKey = parts[i + 1];
      const created = (/^\d+$/.test(nextKey) ? [] : {}) as Record<string, unknown>;
      cur[k] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  }

  const oldVal = cur[last];

  switch (p.op) {
    case 'set':
      cur[last] = p.value;
      break;

    case 'add':
      assertNumber(oldVal, p, 'add');
      assertOperand(p, 'add');
      cur[last] = (oldVal as number) + (p.value as number);
      break;

    case 'mul':
      assertNumber(oldVal, p, 'mul');
      assertOperand(p, 'mul');
      cur[last] = (oldVal as number) * (p.value as number);
      break;

    case 'max':
      assertNumber(oldVal, p, 'max');
      assertOperand(p, 'max');
      cur[last] = Math.max(oldVal as number, p.value as number);
      break;

    case 'min':
      assertNumber(oldVal, p, 'min');
      assertOperand(p, 'min');
      cur[last] = Math.min(oldVal as number, p.value as number);
      break;

    case 'push': {
      if (oldVal === undefined) {
        cur[last] = [...(p.value as unknown[])];
      } else if (Array.isArray(oldVal)) {
        cur[last] = [...oldVal, ...(p.value as unknown[])];
      } else {
        throw new Error(`push 要求目标是数组，"${p.path}" 当前是 ${typeof oldVal}`);
      }
      break;
    }

    case 'remove': {
      if (Array.isArray(cur)) {
        const idx = Number(last);
        if (Number.isInteger(idx)) cur.splice(idx, 1);
        else delete (cur as unknown as Record<string, unknown>)[last];
      } else {
        delete cur[last];
      }
      break;
    }
  }
}

/**
 * 校验**操作数**（`p.value`）是有限数字
 *
 * 【⚠️ 为什么需要它：`assertNumber` 只校验了目标字段】
 *
 * 老实现只对 `oldVal`（路径指向的现有值）做校验，
 * 操作数 `p.value` 直接 `as number` 强转后参与运算。实测：
 * ```js
 * applyPatch({ dmg: 10 }, { op: 'add', path: 'dmg', value: NaN })       // → NaN
 * applyPatch({ dmg: 10 }, { op: 'mul', path: 'dmg', value: Infinity })  // → Infinity
 * applyPatch({ dmg: 10 }, { op: 'add', path: 'dmg', value: 'abc' })     // → "10abc" !!
 * ```
 *
 * 前两条把伤害变成不可用的非有限值；
 * 第三条更隐蔽——`number + string` 在 JS 里是**字符串拼接**，
 * 字段类型从 number 悄悄变成了 string，
 * 后续 `dmg * 2` 得 NaN（`"10abc" * 2`），
 * 而错误现场离这条补丁已经很远了。
 *
 * 补丁值来自遗物/词条配置表，属于外部输入，必须守。
 */
function assertOperand(p: Patch, op: string): void {
  const v = p.value;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(
      `${op} 要求 value 是有限数字，"${p.path}" 的 value 实际是 ` +
        `${JSON.stringify(v)}（${typeof v}）`
    );
  }
}

function assertNumber(v: unknown, p: Patch, op: string): void {
  /**
   * 【为什么区分"不存在"和"不是数字"】
   *
   * 两者都会让运算失败，但排查方向完全相反：
   * - 不存在 → 你写错了路径，去查 schema
   * - 不是数字 → 路径对，但那个字段的类型不对，去查传进来的值
   *
   * 统一报"要求有限数字"的话，路径拼错的人会盯着值看半天。
   */
  if (v === undefined) {
    throw new Error(`路径 "${p.path}" 不存在`);
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${op} 要求目标是有限数字，"${p.path}" 当前是 ${typeof v}`);
  }
}

/**
 * 结构化深拷贝
 *
 * 【支持】普通对象、数组、Date、Map、Set、原始值
 * 【不复制】函数（保持引用——技能定义里的回调就该共享）
 * 【循环引用】用 WeakMap 记忆，不会栈溢出
 */
export function deepClone<T>(v: T, seen = new WeakMap<object, unknown>()): T {
  if (v === null || typeof v !== 'object') return v;

  const existing = seen.get(v as unknown as object);
  if (existing !== undefined) return existing as T;

  if (v instanceof Date) return new Date(v.getTime()) as unknown as T;

  if (Array.isArray(v)) {
    const arr: unknown[] = [];
    seen.set(v, arr);
    for (const x of v) arr.push(deepClone(x, seen));
    return arr as unknown as T;
  }

  if (v instanceof Map) {
    const m = new Map();
    seen.set(v, m);
    for (const [k, val] of v) m.set(deepClone(k, seen), deepClone(val, seen));
    return m as unknown as T;
  }

  if (v instanceof Set) {
    const s = new Set();
    seen.set(v, s);
    for (const x of v) s.add(deepClone(x, seen));
    return s as unknown as T;
  }

  // 普通对象：保留原型
  const out = Object.create(Object.getPrototypeOf(v));
  seen.set(v as unknown as object, out);
  for (const k of Object.keys(v as Record<string, unknown>)) {
    out[k] = deepClone((v as Record<string, unknown>)[k], seen);
  }
  return out as T;
}
