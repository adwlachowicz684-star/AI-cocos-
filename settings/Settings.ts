/**
 * settings/Settings.ts —— 游戏设置
 *
 * 【它解决什么】
 *
 * 设置面板看起来就是一个键值表。真正麻烦的是五件事：
 *
 * 1. **默认值迁移**
 *    新版本加了一个设置项，老玩家的存档里没有它。
 *    读档时直接 `undefined` 会让整个音频系统静音。
 *
 * 2. **变更要能监听**
 *    改了音量，AudioManager 要立刻响应；
 *    改了画质，渲染管线要重建。
 *    手写是每处保存后手动调一遍 `applyAll()`。
 *
 * 3. **范围约束要在数据层**
 *    `volume = 2.5` 只有在播放时才会出问题，而且听起来只是"有点吵"。
 *
 * 4. **分类**
 *    设置面板要分页签（音频/画面/操作），
 *    不分类的话 UI 要自己维护一份"哪个键属于哪一页"的映射。
 *
 * 5. **重置**
 *    "恢复默认"要区分"全部重置"和"只重置这一页"。
 *
 * 【零业务依赖】
 * 它不知道"音量"是什么，只知道有一堆带类型和范围的键值。
 *
 * 【使用示例】
 * ```typescript
 * const s = new Settings({
 *   defs: [
 *     { key: 'bgm', kind: 'number', default: 80, min: 0, max: 100 },
 *     { key: 'lang', kind: 'enum', default: 'zh', options: ['zh', 'en'] },
 *   ],
 *   onChange: (k, v, old) => saveToDisk(k, v),
 * });
 *
 * s.num('bgm');            // 80
 * s.set('bgm', 120);        // 返回错误文案（超 max），值不变
 * s.set('bgm', 50);         // 返回 null（成功）
 * s.str('lang');            // 'zh'
 * ```
 *
 * 【为什么不抛错而是返回错误文案】
 * 设置值来自存档和玩家输入，非法值是常态而非异常。
 * 返回文案可以直接显示在设置界面上；抛错则会让读档失败整个崩掉。
 */

// ==================== 类型 ====================

export type SettingValue = number | string | boolean;

export type SettingKind = 'number' | 'bool' | 'enum' | 'string';

export interface SettingDef {
  readonly key: string;
  readonly kind: SettingKind;
  readonly default: SettingValue;
  /** 分类（用于面板分页） */
  readonly group?: string;
  /** 显示名 */
  readonly label?: string;
  /** number：范围与步进 */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** enum：可选值 */
  readonly options?: readonly (string | number)[];
  /** string：最大长度 */
  readonly maxLength?: number;
  /**
   * 变更是否需要重启才生效
   *
   * 【用途】UI 上标一个"需要重启"的角标，
   * 而不是让玩家困惑"我改了怎么没反应"。
   */
  readonly needRestart?: boolean;
  /** 自定义校验。返回 null 表示通过，否则返回错误说明 */
  readonly validate?: (v: SettingValue) => string | null;
}

export interface SettingsOptions {
  readonly defs: readonly SettingDef[];
  readonly onChange?: (key: string, value: SettingValue, old: SettingValue) => void;
  /** 未知 key 是否直接忽略（存档兼容）。默认 true */
  readonly ignoreUnknown?: boolean;
  /**
   * `importState` 遇到非法值时的回调
   *
   * 【为什么需要它】见 {@link Settings.importState} 的注释：
   * 非法值此前是"既不写入、也不记录、也不报错"，
   * 调用方**没有任何渠道**知道玩家的设置被丢了。
   */
  readonly onReject?: (key: string, value: SettingValue, reason: string) => void;
}

/** 一条被拒绝的导入值（UI 提示 / 上报用） */
export interface RejectedSetting {
  readonly key: string;
  readonly value: SettingValue;
  /** `_validate` 已经算好的原因文案，直接显示即可 */
  readonly reason: string;
}

export interface SettingsSnapshot {
  readonly values: Readonly<Record<string, SettingValue>>;
  /** 需要重启才能生效的键（当前值与存档值不同） */
  readonly pendingRestart: readonly string[];
}

// ==================== 实现 ====================

export class Settings {
  private readonly _defs = new Map<string, SettingDef>();
  private readonly _values = new Map<string, SettingValue>();
  private readonly _order: string[] = [];
  // 【为什么这两个不是 readonly】destroy() 要能把它们摘掉
  private _onChange?: (key: string, value: SettingValue, old: SettingValue) => void;
  private readonly _ignoreUnknown: boolean;
  private _onReject?: (key: string, value: SettingValue, reason: string) => void;
  /** 最近一次 importState 被拒绝的值（空数组 = 全都导入成功） */
  private _rejected: RejectedSetting[] = [];
  /**
   * 「已生效」的值：上一次读档 / 构造 / {@link markRestartApplied} 时的值
   *
   * 【为什么需要它】
   * `snapshot().pendingRestart` 判断的是"当前值 ≠ 正在跑的值"。
   * 旧实现没有这个概念，于是把所有 `needRestart` 的键**无条件**列出来——
   * 实测：一个刚构造、什么都没改的 Settings，
   * `snapshot().pendingRestart` 仍然返回 `['quality']`。
   * UI 照着它渲染，玩家一进设置页就看到"以下 3 项需重启后生效"，
   * 而自己一项都没动过。
   */
  private readonly _applied = new Map<string, SettingValue>();

  constructor(opts: SettingsOptions) {
    this._onChange = opts.onChange;
    this._ignoreUnknown = opts.ignoreUnknown ?? true;
    this._onReject = opts.onReject;

    for (const d of opts.defs) {
      if (this._defs.has(d.key)) {
        throw new Error(`[Settings] 设置项重复：${d.key}`);
      }
      const err = this._checkDef(d);
      if (err) throw new Error(`[Settings] 设置项 "${d.key}" 定义非法：${err}`);

      this._defs.set(d.key, d);
      this._order.push(d.key);
      this._values.set(d.key, d.default);
      // 刚构造时"正在跑的值"就是默认值本身
      this._applied.set(d.key, d.default);
    }
  }

  // ==================== 查询 ====================

  has(key: string): boolean {
    return this._defs.has(key);
  }

  get keys(): readonly string[] {
    return [...this._order];
  }

  def(key: string): SettingDef | undefined {
    return this._defs.get(key);
  }

  /** 按分类取键（面板分页用） */
  keysOfGroup(group: string): string[] {
    return this._order.filter((k) => (this._defs.get(k)!.group ?? '') === group);
  }

  /** 全部分类 */
  get groups(): string[] {
    const s = new Set<string>();
    for (const k of this._order) s.add(this._defs.get(k)!.group ?? '');
    return [...s];
  }

  get<T extends SettingValue>(key: string): T {
    const d = this._defs.get(key);
    if (!d) {
      throw new Error(
        `[Settings] 未定义的设置项："${key}"（已定义：${this._order.join(', ')}）`
      );
    }
    return this._values.get(key) as T;
  }

  /** 分组取值，减少类型断言噪音 */
  num(key: string): number {
    return this.get<number>(key);
  }

  bool(key: string): boolean {
    return this.get<boolean>(key);
  }

  str(key: string): string {
    return this.get<string>(key);
  }

  // ==================== 修改 ====================

  /**
   * 设置值
   *
   * @returns 错误信息，null 表示成功
   */
  set(key: string, value: SettingValue): string | null {
    const d = this._defs.get(key);
    if (!d) {
      if (this._ignoreUnknown) return null;
      return `未定义的设置项：${key}`;
    }

    const err = this._validate(d, value);
    if (err) return err;

    const old = this._values.get(key)!;
    if (old === value) return null;

    this._values.set(key, value);
    this._onChange?.(key, value, old);
    return null;
  }

  /** 只校验不写入（输入框实时校验） */
  validate(key: string, value: SettingValue): string | null {
    const d = this._defs.get(key);
    if (!d) return `未定义的设置项：${key}`;
    return this._validate(d, value);
  }

  /**
   * enum 类型循环切换到下一个（下拉框/"点击切换"用）
   *
   * 【⚠️ 当前值不在 options 里时会静默跳到 `opts[0]`】
   * `indexOf` 得 -1，`(-1 + 1) % len === 0` → 取第一个选项。
   * 这个降级是**有意的**：老存档里存了一个已被删除的枚举值时，
   * 总得落到某个合法值上，抛错会让设置面板直接打不开。
   * 但它是静默的，所以在这里写明：
   * 发现"画质莫名其妙变回第一档"时，先查是不是枚举值被改过名。
   */
  cycle(key: string): string | null {
    const d = this._defs.get(key);
    if (!d || d.kind !== 'enum' || !d.options) return `不是枚举项：${key}`;
    const opts = d.options;
    const i = opts.indexOf(this._values.get(key) as string | number);
    const next = opts[(i + 1) % opts.length];
    return this.set(key, next);
  }

  // ==================== 重置 ====================

  reset(key: string): boolean {
    const d = this._defs.get(key);
    if (!d) return false;
    return this.set(key, d.default) === null;
  }

  resetGroup(group: string): void {
    for (const k of this.keysOfGroup(group)) this.reset(k);
  }

  resetAll(): void {
    for (const k of this._order) this.reset(k);
  }

  // ==================== 存档 ====================

  exportState(): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    for (const k of this._order) out[k] = this._values.get(k)!;
    return out;
  }

  /**
   * 导入存档
   *
   * 【⚠️ 这是默认值迁移发生的地方】
   * 存档里没有的键 → 保持默认值（新版本新增设置项）。
   * 存档里有但已删除的键 → 忽略（旧版本残留）。
   *
   * 不这么做的话，加一个新设置项会让所有老玩家的存档读不进来，
   * 或者读进来了但新项是 undefined。
   *
   * 【⚠️ 两个曾经静默失败的地方，2026-09-07 修正】
   *
   * ① **非法值既不写入也不上报**：
   *    ```typescript
   *    s.importState({ volume: 9999, quality: 'ultra' });   // 返回 [] ← 空数组
   *    // 实际 volume = 50（默认），quality = high（默认）
   *    ```
   *    返回值类型是 `string[]`（**未知**键列表），非法值根本不在返回结构里，
   *    调用方拿到空数组以为一切正常。玩家改了音量、存盘、读档后被悄悄还原，
   *    表现为"设置存不住"——而排查方向通常被引向存档系统。
   *    现在非法值会：回退到 `default`、计入 {@link Settings.rejected}、
   *    并触发 `onReject`。
   *
   * ② **绕过 `set()`，不触发 `onChange`**：
   *    读档后音量数值已经变成 20，音频系统却没收到通知 → 实际音量还是 80。
   *    这是"值对了但通知没发"，比"通知发了值没改"更难查。
   *    现在每个真正发生变化的键都会走一次 `_onChange`。
   *
   * @returns 被忽略的**未知**键（可用于日志）。非法值见 `rejected` / `onReject`
   */
  importState(state: Readonly<Record<string, SettingValue>>): string[] {
    const unknown: string[] = [];
    const rejected: RejectedSetting[] = [];

    for (const [k, v] of Object.entries(state)) {
      const d = this._defs.get(k);
      if (!d) {
        unknown.push(k);
        continue;
      }
      const err = this._validate(d, v);
      if (err !== null) {
        // `_validate` 已经算出了原因文案，丢掉太可惜——交给调用方显示
        rejected.push({ key: k, value: v, reason: err });
        this._onReject?.(k, v, err);
        // 坏存档不该污染当前会话：回退到默认值（走 set()，所以也会通知）
        this.set(k, d.default);
        continue;
      }
      this.set(k, v);
    }

    this._rejected = rejected;
    // 读档之后"正在跑的值"就是存档值，不该有一堆莫名的待重启项
    this.markRestartApplied();
    return unknown;
  }

  /**
   * 把当前值标记为"已生效"（游戏重启 / 设置被应用后调用）
   *
   * 【为什么必须显式提供】
   * 本模块是纯逻辑层，不知道游戏什么时候真正重启了。
   * 没有这个入口，`pendingRestart` 一旦非空就**永远清不掉**——
   * 玩家重启完游戏，UI 上那个角标还在。
   */
  markRestartApplied(): void {
    for (const k of this._order) this._applied.set(k, this._values.get(k)!);
  }

  /**
   * 最近一次 `importState` 中被拒绝的值
   *
   * 【为什么不直接改 `importState` 的返回值】
   * 返回 `string[]` 是既有契约，`tests/run_batch16.ts` 里就有一条
   * `unknown.join(',')` 的断言，改成 `{ unknown, rejected }` 属于 breaking。
   * 所以新增通道，旧行为保持不变。
   */
  get rejected(): readonly RejectedSetting[] {
    return this._rejected;
  }

  snapshot(): SettingsSnapshot {
    const values: Record<string, SettingValue> = {};
    const pending: string[] = [];
    for (const k of this._order) {
      values[k] = this._values.get(k)!;
      /**
       * 【只列**真的改过**的 needRestart 项】
       * 两个条件缺一不可：该项需要重启，且当前值 ≠ 已生效的值。
       * 只判前一个（旧实现）会把"根本没动过"的项也列出来。
       */
      if (this._defs.get(k)!.needRestart && this._values.get(k) !== this._applied.get(k)) {
        pending.push(k);
      }
    }
    return { values, pendingRestart: pending };
  }

  /**
   * 卸载（rule5）
   *
   * 【为什么不留着 `onChange`】
   * 回调是外部闭包，只要还挂着，它捕获的作用域链
   * （通常是整个音频/渲染子系统）就不会被回收。
   * 换场景时 `Settings` 对象即使没人引用了，也会因为这个字段滞留。
   */
  destroy(): void {
    this._onChange = undefined;
    this._onReject = undefined;
    this._rejected = [];
  }

  // ==================== 内部 ====================

  private _checkDef(d: SettingDef): string | null {
    if (d.kind === 'number' && typeof d.default !== 'number') {
      return "kind 是 number 但 default 不是数字";
    }
    if (d.kind === 'bool' && typeof d.default !== 'boolean') {
      return "kind 是 bool 但 default 不是布尔";
    }
    if (d.kind === 'enum') {
      if (!d.options || d.options.length === 0) return 'enum 必须提供 options';
      if (!d.options.includes(d.default as string | number)) {
        return `default 不在 options 中`;
      }
    }
    if (d.kind === 'number' && d.min !== undefined && d.max !== undefined && d.min > d.max) {
      return `min ${d.min} 大于 max ${d.max}`;
    }
    return null;
  }

  private _validate(d: SettingDef, v: SettingValue): string | null {
    switch (d.kind) {
      case 'number': {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '必须是有限数字';
        if (d.min !== undefined && v < d.min) return `不能小于 ${d.min}`;
        if (d.max !== undefined && v > d.max) return `不能大于 ${d.max}`;
        if (d.step !== undefined && d.step > 0) {
          const base = d.min ?? 0;
          const steps = (v - base) / d.step;
          if (Math.abs(steps - Math.round(steps)) > 1e-9) {
            return `必须是 ${base} + ${d.step} 的整数倍`;
          }
        }
        break;
      }
      case 'bool':
        if (typeof v !== 'boolean') return '必须是布尔值';
        break;
      case 'enum':
        if (!d.options!.includes(v as string | number)) {
          return `必须是其中之一：${d.options!.join(' / ')}`;
        }
        break;
      case 'string':
        if (typeof v !== 'string') return '必须是字符串';
        if (d.maxLength !== undefined && v.length > d.maxLength) {
          return `长度不能超过 ${d.maxLength}`;
        }
        break;
    }
    return d.validate ? d.validate(v) : null;
  }
}
