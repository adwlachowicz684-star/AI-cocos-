/**
 * I18N —— 本地化（多语言）
 *
 * 【它解决什么】
 *
 * 硬编码中文字符串后要出英文版，你得全局搜索几百处。
 * 更麻烦的是这几件事，硬编码全都做不到：
 *
 * - **复数**：英文有 "1 item" / "2 items"，中文没有，日文也没有
 * - **插值**：`"剩余 {n} 次机会"` 里的 n 在不同语言位置可能不同
 * - **回退**：缺翻译时显示原文而不是空白（否则玩家看到一堆空按钮）
 * - **热重载**：调文本时不用重启游戏
 *
 * 【设计：文本用 key，不放内容】
 * 代码里只写 `i18n.t('ui.start')`，内容全在语言包里。
 *
 * 【使用示例】
 * ```typescript
 * const i18n = new I18N({ fallback: 'zh-CN' });
 *
 * i18n.addLocale('zh-CN', {
 *   'ui.start': '开始游戏',
 *   'item.count': '{n} 个',
 *   'msg.kill': '你击败了 {name}，获得 {exp} 经验',
 * });
 *
 * i18n.addLocale('en-US', {
 *   'ui.start': 'Start Game',
 *   'item.count': '{n} item',
 *   'item.count_plural': '{n} items',      // ← 英文复数
 *   'msg.kill': 'You defeated {name} and gained {exp} EXP',
 * });
 *
 * i18n.setLocale('en-US');
 *
 * i18n.t('ui.start');                                     // 'Start Game'
 * i18n.t('item.count', { n: 1 });                         // '1 item'
 * i18n.t('item.count', { n: 5 });                         // '5 items'
 * i18n.t('msg.kill', { name: '骷髅兵', exp: 120 });
 *
 * i18n.t('缺失的key');                                     // '缺失的key'（回退，不是空白）
 * ```
 *
 * 【无引擎依赖】
 */

export type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** 所有复数形式（用于覆盖率检查时枚举变体） */
const PLURAL_FORMS: readonly PluralForm[] = ['zero', 'one', 'two', 'few', 'many', 'other'];

export type LocaleTable = Record<string, string>;

export interface I18NOptions {
  /** 默认语言 */
  readonly locale?: string;
  /**
   * 回退语言链的最后一项
   * 【典型】'zh-CN'（开发时写的原文）
   */
  readonly fallback?: string;
  /** 缺翻译时是否告警（开发期开，发布期关） */
  readonly warnOnMissing?: boolean;
}

export class I18N {
  private readonly _locales = new Map<string, LocaleTable>();
  private readonly _fallback: string;
  private readonly _warnOnMissing: boolean;

  private _locale: string;
  private _onChange: ((locale: string) => void) | null = null;

  /** 缺失 key 的统计（用于检查翻译覆盖率） */
  private readonly _missing = new Set<string>();

  constructor(opts: I18NOptions = {}) {
    this._fallback = opts.fallback ?? 'zh-CN';
    this._locale = opts.locale ?? this._fallback;
    this._warnOnMissing = opts.warnOnMissing ?? false;
  }

  // ==================== 语言包 ====================

  /** 添加语言包（合并到已有的同语言包上） */
  addLocale(locale: string, table: LocaleTable, opts: { override?: boolean } = {}): this {
    const exist = this._locales.get(locale);
    if (exist && !opts.override) {
      Object.assign(exist, table);
      this._locales.set(locale, exist);
    } else {
      this._locales.set(locale, { ...table });
    }
    return this;
  }

  /** 替换整个语言包（热重载用） */
  setLocaleTable(locale: string, table: LocaleTable): this {
    this._locales.set(locale, { ...table });
    return this;
  }

  hasLocale(locale: string): boolean {
    return this._locales.has(locale);
  }

  get locales(): string[] {
    return Array.from(this._locales.keys());
  }

  // ==================== 当前语言 ====================

  /**
   * 切换语言
   *
   * 【坑】切换后 UI 不会自动刷新。
   * 你需要订阅 `onChange` 然后手动刷新所有可见文本
   * （或者让每个文本组件自己订阅）。
   */
  setLocale(locale: string): boolean {
    if (!this._locales.has(locale)) {
      console.warn(`[I18N] 语言 "${locale}" 不存在，保持 "${this._locale}"`);
      return false;
    }
    if (this._locale === locale) return false;
    this._locale = locale;
    this._onChange?.(locale);
    return true;
  }

  get locale(): string {
    return this._locale;
  }

  onChange(fn: (locale: string) => void): () => void {
    this._onChange = fn;
    return () => {
      if (this._onChange === fn) this._onChange = null;
    };
  }

  // ==================== 翻译 ====================

  /**
   * 翻译
   *
   * @param key 键
   * @param vars 插值变量。**`n` 有特殊含义**：用于复数选择
   *
   * 【回退链】当前语言 → 回退语言 → key 本身
   *
   * 【为什么最后回退到 key 而不是空字符串】
   * 空字符串会让按钮变成一片空白，玩家完全不知道那是什么；
   * 显示 key（如 `ui.start`）至少能看出"这里缺翻译"，而且不阻塞开发。
   */
  t(key: string, vars?: Record<string, unknown>): string {
    const pluralKey = this._pluralKeyOf(key, vars);

    let raw =
      this._lookup(this._locale, pluralKey) ??
      this._lookup(this._locale, key) ??
      this._lookup(this._fallback, pluralKey) ??
      this._lookup(this._fallback, key);

    if (raw === undefined) {
      this._missing.add(key);
      if (this._warnOnMissing) console.warn(`[I18N] 缺少翻译：${key}`);
      return key;
    }

    return vars ? interpolate(raw, vars) : raw;
  }

  /** 是否有这个 key 的翻译（不触发缺失统计） */
  has(key: string): boolean {
    return this._lookup(this._locale, key) !== undefined;
  }

  /**
   * 复数形式选择
   *
   * 【规则】
   * 优先查 `{key}_{form}`，查不到就退回 `{key}`。
   * 中文没有复数变化，所以中文包不需要写 `_plural`。
   *
   * 【为什么不用完整的 CLDR 复数规则】
   * 那需要每种语言一套规则表（俄语有 4 种形式），
   * 对独立游戏是过度设计。这里支持最常见的：one / other。
   * 需要更复杂的可以自己扩展 `_pluralFormOf`。
   */
  private _pluralKeyOf(key: string, vars?: Record<string, unknown>): string {
    if (!vars || vars.n === undefined) return key;
    const n = Number(vars.n);
    if (!Number.isFinite(n)) return key;
    return `${key}_${n === 1 ? 'one' : 'other'}`;
  }

  /** 检查 key 本身或它的任意复数变体是否存在 */
  private _hasAnyForm(table: LocaleTable, key: string): boolean {
    if (typeof table[key] === 'string') return true;
    for (const form of PLURAL_FORMS) {
      if (typeof table[`${key}_${form}`] === 'string') return true;
    }
    return false;
  }

  private _lookup(locale: string, key: string): string | undefined {
    const table = this._locales.get(locale);
    if (!table) return undefined;
    const v = table[key];
    return typeof v === 'string' ? v : undefined;
  }

  // ==================== 校验 ====================

  /**
   * 翻译覆盖率检查
   *
   * 【用途】构建时跑一次："英文版还差 37 条没翻译"
   */
  coverage(locale: string): { total: number; translated: number; missing: string[] } {
    const base = this._locales.get(this._fallback);
    const target = this._locales.get(locale);

    if (!base) return { total: 0, translated: 0, missing: [] };
    if (!target) return { total: Object.keys(base).length, translated: 0, missing: Object.keys(base) };

    const keys = Object.keys(base);
    /**
     * 【坑】复数形式会让覆盖率误报。
     * 中文包写 `item.count`，英文包写 `item.count_one` / `item.count_other`——
     * 直接查 `item.count` 会判定为"未翻译"，实际是翻了的。
     *
     * 所以判断时要一并检查 `{key}_{form}` 变体。
     */
    const missing = keys.filter((k) => !this._hasAnyForm(target, k));
    return {
      total: keys.length,
      translated: keys.length - missing.length,
      missing,
    };
  }

  /** 运行时缺失过的 key（玩家实际碰到过的） */
  get missingKeys(): string[] {
    return Array.from(this._missing);
  }

  clearMissing(): void {
    this._missing.clear();
  }

  destroy(): void {
    this._locales.clear();
    this._missing.clear();
    this._onChange = null;
  }
}

/**
 * 插值：`"剩余 {n} 次"` + `{n: 3}` → `"剩余 3 次"`
 *
 * 【为什么自己写而不是用模板字符串】
 * 翻译文本来自运行时加载的 JSON，不能用 JS 模板字符串。
 *
 * 【支持点号路径】`{player.name}` → vars.player.name
 */
function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_$.]+)\}/g, (match, path: string) => {
    let cur: unknown = vars;
    for (const k of path.split('.')) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return match;
      cur = (cur as Record<string, unknown>)[k];
    }
    if (cur === undefined || cur === null) return match;
    return String(cur);
  });
}
