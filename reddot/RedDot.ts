/**
 * reddot/RedDot.ts —— 红点系统
 *
 * 【它解决什么】
 *
 * "邮件有新的"、"任务能领了"、"商店上新了"——
 * 这些小红点散落在几十个 UI 入口上。
 *
 * 手写的做法是在每个界面 `if (hasNewMail) showDot()`，
 * 然后你会遇到：
 *
 * 1. **父子联动漏算**
 *    "背包"页签下的"装备"有红点，背包页签自己也该亮。
 *    忘了算就会出现"进去了但入口没提示"的割裂感。
 *
 * 2. **计数对不上**
 *    子项显示 3，父项显示 1——玩家会觉得"还有 2 个在哪"。
 *
 * 3. **清除时机混乱**
 *    点开邮件算已读，但红点没重新计算，要重进界面才消失。
 *
 * 【核心设计】
 *
 * 红点是一棵树。叶子节点由业务设置，
 * **父节点数量 = 所有子节点之和（自动计算）**。
 *
 * 这样父子永远一致，业务只需要管好叶子。
 *
 * 【零业务依赖】
 *
 * 【使用示例】
 * ```typescript
 * const rd = new RedDot();
 *
 * // 叶子节点：直接设数量
 * rd.set('mail/unread', 3);
 * rd.add('mail/unread', 1);   // 4
 *
 * // 父节点自动聚合：own 只看自己，get 含子节点
 * rd.own('mail');    // 0 —— mail 自身没有红点
 * rd.get('mail');    // 4 —— 聚合了 mail/unread
 * rd.has('mail');    // true
 * rd.any('mail');    // 自身或任一子节点有红点
 *
 * rd.clear('mail/unread');
 * rd.get('mail');    // 0 —— 子节点清空后父节点也归零
 * ```
 *
 * 【路径是树形的】用 `/` 分隔，设置子节点会自动向上聚合，
 * 所以 UI 只需绑父节点路径即可。
 */

// ==================== 类型 ====================

export interface RedDotOptions {
  /** 节点路径分隔符。默认 '/' */
  readonly separator?: string;
  readonly onChange?: (path: string, count: number) => void;
}

// ==================== 实现 ====================

export class RedDot {
  private readonly _sep: string;
  private readonly _onChange?: (path: string, count: number) => void;

  /** 叶子节点：path → 数量 */
  private readonly _leaf = new Map<string, number>();
  /** 显式设置的父节点覆盖值（用于"父节点显示自定义数字"） */
  private readonly _override = new Map<string, number>();
  /** 计算缓存 */
  private _cache = new Map<string, number>();

  constructor(opts: RedDotOptions = {}) {
    this._sep = opts.separator ?? '/';
    this._onChange = opts.onChange;
  }

  // ==================== 叶子节点 ====================

  /**
   * 设置叶子节点的数量
   *
   * 【⚠️ 路径必须唯一确定层级】
   * `mail/system` 表示 mail 下的 system 节点。
   */
  set(path: string, count: number): void {
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`[RedDot] 数量必须是非负有限数，收到 ${count}`);
    }
    const prev = this._leaf.get(path) ?? 0;
    if (prev === count) return;

    if (count === 0) this._leaf.delete(path);
    else this._leaf.set(path, count);

    this._invalidate();
    this._notify(path);
  }

  add(path: string, delta: number): void {
    /**
     * 【⚠️ 先相加再夹，不是先夹再加】
     *
     * 写成 `max(0, cur) + delta` 的话，cur=3、delta=-10 会得到 -7，
     * 然后被 set() 的校验拒绝并抛错——
     * "扣减到一个负数"是合法意图（表示扣到 0），不该崩溃。
     */
    this.set(path, Math.max(0, (this._leaf.get(path) ?? 0) + delta));
  }

  clear(path: string): void {
    this.set(path, 0);
  }

  clearAll(): void {
    const paths = [...this._leaf.keys(), ...this._override.keys()];
    this._leaf.clear();
    this._override.clear();
    this._invalidate();
    for (const p of paths) this._notify(p);
  }

  /** 叶子节点自身的数量（不含子节点） */
  own(path: string): number {
    return this._leaf.get(path) ?? 0;
  }

  // ==================== 查询 ====================

  /**
   * 节点总量（自身 + 所有后代）
   *
   * 【自动聚合】父节点不需要手动维护。
   */
  get(path: string): number {
    if (this._override.has(path)) return this._override.get(path)!;

    const cached = this._cache.get(path);
    if (cached !== undefined) return cached;

    let sum = this._leaf.get(path) ?? 0;
    /**
     * 【⚠️ 根节点的 prefix 是空串，不是分隔符】
     *
     * 写成 `path + sep` 的话，根路径 '' 会变成 '/'，
     * 于是任何 'mail/system' 都不以 '/' 开头 —— 根永远显示 0。
     * 表现为"子项都亮着，总入口没有红点"。
     */
    const prefix = path === '' ? '' : path + this._sep;
    for (const [p, n] of this._leaf) {
      if (p.startsWith(prefix)) sum += n;
    }
    this._cache.set(path, sum);
    return sum;
  }

  /** 只要有（数量 ≥ 1） */
  has(path: string): boolean {
    return this.get(path) > 0;
  }

  /** 只判断有没有，不关心数量（省一次全量聚合） */
  any(path: string): boolean {
    if (this._override.has(path)) return this._override.get(path)! > 0;
    if ((this._leaf.get(path) ?? 0) > 0) return true;
    const prefix = path === '' ? '' : path + this._sep;
    for (const [p, n] of this._leaf) {
      if (n > 0 && p.startsWith(prefix)) return true;
    }
    return false;
  }

  /** 直接子节点列表 */
  children(path: string): string[] {
    const prefix = path === '' ? '' : path + this._sep;
    const out = new Set<string>();
    for (const p of this._leaf.keys()) {
      if (prefix && !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const i = rest.indexOf(this._sep);
      out.add(i === -1 ? rest : rest.slice(0, i));
    }
    return [...out];
  }

  /** 所有有红点的路径（调试用） */
  activePaths(): string[] {
    return [...this._leaf.keys()].filter((p) => this.get(p) > 0);
  }

  // ==================== 覆盖 ====================

  /**
   * 覆盖某个节点的显示数量
   *
   * 【用途】"任务"页签想显示"可领取数"而不是"所有子项总数"
   * 时，用它指定一个业务口径的数字。
   *
   * 传 null 取消覆盖，回到自动聚合。
   */
  override(path: string, count: number | null): void {
    if (count === null) {
      if (!this._override.delete(path)) return;
    } else {
      if (!Number.isFinite(count) || count < 0) {
        throw new Error(`[RedDot] 覆盖值必须是非负有限数，收到 ${count}`);
      }
      this._override.set(path, count);
    }
    this._invalidate();
    this._notify(path);
  }

  // ==================== 存档 ====================

  exportState(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this._leaf) out[k] = v;
    return out;
  }

  importState(state: Readonly<Record<string, number>>): void {
    this._leaf.clear();
    for (const [k, v] of Object.entries(state)) {
      if (Number.isFinite(v) && v > 0) this._leaf.set(k, v);
    }
    this._invalidate();
  }

  // ==================== 内部 ====================

  private _invalidate(): void {
    this._cache.clear();
  }

  /**
   * 通知变化
   *
   * 【⚠️ 要通知所有祖先】
   * 只通知叶子的话，父节点的红点不会刷新——
   * 表现为"子项亮了，入口没亮"。
   */
  private _notify(path: string): void {
    const parts = path.split(this._sep);
    for (let i = parts.length; i > 0; i--) {
      const p = parts.slice(0, i).join(this._sep);
      this._onChange?.(p, this.get(p));
    }
    this._onChange?.('', this.get(''));
  }
}
