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

import { isSafeKey } from '../_core/guard';

export type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * **运行时真正会去查**的复数后缀
 *
 * 【⚠️ 为什么这里只有 2 个，而 `PluralForm` 有 6 个】
 *
 * `PluralForm` 列的是 CLDR 的完整六形式（zero/one/two/few/many/other），
 * 那是**语言学的分类**；而 `_pluralKeyOf` 只实现了 `n === 1 ? 'one' : 'other'`
 * 这一条最朴素的规则——也就是说运行时**只会去查 `_one` 和 `_other` 两个 key**。
 *
 * 覆盖率曾经枚举全部 6 个形式，于是：
 *
 * ```
 * 俄文包只写 item_few / item_many
 *   coverage('ru')        → translated = 1/1（100%）
 *   t('item', { n: 3 })   → "3 个"（回落中文，item_few/item_many 永不命中）
 * ```
 *
 * 本地化看板全绿、验收通过，上线后俄语等复杂复数语言的复数全部显示错误。
 * 这是"报告说谎导致决策错误"的典型——**比没有报告更糟**。
 *
 * 【修法的选择】
 * 有两个方向：① 让覆盖率只认运行时能命中的形式（本报告采用的）；
 * ② 让 `_pluralKeyOf` 支持 CLDR 六形式（需要每种语言一张规则表）。
 * 选 ① 是因为它立刻消除"报告与实际不一致"，
 * 而 ② 是功能扩展，属于另一个议题。
 * 真要支持复杂复数语言时，**这两个常量必须一起改**——
 * 把覆盖率口径和 `_pluralKeyOf` 放在同一个文件里就是为了让这种改动无处可躲。
 */
const RESOLVABLE_PLURAL_FORMS: readonly PluralForm[] = ['one', 'other'];

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
  /**
   * 语言变更订阅者
   *
   * 【⚠️ 为什么是 Set 而不是单个回调】
   *
   * 原实现是 `this._onChange = fn`（**赋值**），
   * 于是第二个订阅者会静默顶掉第一个。实测：
   *
   * ```
   * i18n.onChange(cb1); i18n.onChange(cb2);
   * i18n.setLocale('en');
   *   → cb1 触发 0 次，cb2 触发 1 次
   * ```
   *
   * 而"多个 UI 组件各自订阅语言变更来刷新文本"是这个 API 最常见的用法
   * ——结果只有最后注册的那个刷新，其余组件停留在旧语言。
   * 玩家看到的是"一半界面换了语言"，开发侧没有任何报错。
   *
   * 用 Set 还有两个附带好处：同一个 fn 重复注册只生效一次，
   * 以及取消订阅是幂等的（重复调用 delete 无害）。
   */
  private readonly _onChange = new Set<(locale: string) => void>();

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
    /**
     * 【⚠️ 为什么非 override 分支不能用 `Object.assign(exist, table)`】
     *
     * `Object.assign` 走的是**赋值语义**，会触发目标对象上的 setter——
     * 包括 `__proto__` 的 setter。而语言包通常来自
     * `JSON.parse(读进来的文本文件)`，`JSON.parse` 会保留 `__proto__` 作为
     * **自有属性**，于是：
     *
     * ```
     * i18n.addLocale('zh', JSON.parse('{"__proto__":{"polluted":"yes"},"b":"B"}'));
     * i18n.t('polluted')  → 'yes'      ← 本该返回 'polluted' 本身（未翻译）
     * ```
     *
     * 这不是"多了一个 key"：`exist` 的**原型被整体换掉**了，
     * 之后这个语言包会命中任何没写过的 key，
     * 表现为"某些按钮突然显示出奇怪的文本"，且只在这一个语言包上复现。
     *
     * override 分支用 `{ ...table }` 是安全的——
     * 对象展开走的是 CreateDataProperty（定义自有属性），不触发 setter。
     * 所以这里同样改成逐键写入，并跳过 `_core/guard` 认定的三个危险键。
     *
     * 【为什么用 Object.keys 而不是 for...in】
     * for...in 会遍历原型链，把 table 原型上的东西也并进来，
     * 等于自己给自己开一个后门。
     */
    const exist = this._locales.get(locale);
    if (exist && !opts.override) {
      for (const k of Object.keys(table)) {
        if (!isSafeKey(k)) continue;
        exist[k] = table[k];
      }
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
    /**
     * 【为什么遍历副本】
     * 订阅者完全可能在回调里注销自己（"只关心第一次切换"的一次性监听）。
     * 直接遍历 Set 时，JS 的 Set 迭代器会反映删除——
     * 虽然 Set 不像数组那样"下标前移"，但"本次派发名单应该在派发开始时确定"
     * 这个语义必须和全库其它派发点（entity 的 on*）保持一致，
     * 否则又是一处"取决于注册顺序"的隐性差异。
     */
    for (const fn of [...this._onChange]) fn(locale);
    return true;
  }

  get locale(): string {
    return this._locale;
  }

  /**
   * 订阅语言变更
   *
   * @returns 取消订阅函数（幂等，可重复调用）
   */
  onChange(fn: (locale: string) => void): () => void {
    this._onChange.add(fn);
    return () => {
      this._onChange.delete(fn);
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
    const raw = this._resolve(key, vars);

    if (raw === undefined) {
      this._missing.add(key);
      if (this._warnOnMissing) console.warn(`[I18N] 缺少翻译：${key}`);
      return key;
    }

    return vars ? interpolate(raw, vars) : raw;
  }

  /**
   * 走完整回退链解析（**不含**缺失统计）
   *
   * 【为什么要单独抽出来】
   * `t()` 和 `has()` 必须用**同一条**查找路径。
   * 分成两处写，迟早有一处漏掉 fallback 或复数变体——那就是本条缺陷的成因。
   * 抽成一个函数后，"has 和 t 口径不一致"在结构上就不可能再发生。
   */
  private _resolve(key: string, vars?: Record<string, unknown>): string | undefined {
    const pluralKey = this._pluralKeyOf(key, vars);

    return (
      this._lookup(this._locale, pluralKey) ??
      this._lookup(this._locale, key) ??
      this._lookup(this._fallback, pluralKey) ??
      this._lookup(this._fallback, key)
    );
  }

  /**
   * 这个 key **能不能翻出来**（不触发缺失统计）
   *
   * 【⚠️ 为什么不能只查"当前语言的 key 本身"】
   *
   * 原实现是 `this._lookup(this._locale, key) !== undefined`：
   * 既不查回退语言，也不查复数变体——而 `t()` 两者都查。
   * 于是同一个 key 会给出两个相反的答案：
   *
   * ```
   * has('ui.start')       → false    但 t('ui.start')      → '开始'（来自 fallback）
   * has('item')           → false    但 t('item', {n:3})   → '3 items'（来自 item_other）
   * ```
   *
   * `has()` 的典型用法是"有翻译就显示翻译，没有就显示 key / 走兜底样式"，
   * 假阴性意味着**明明翻得出来却走了未翻译分支**——
   * 本地化验收时表现为"翻译明明有却不生效"，而且查语言包查不到原因。
   *
   * 【为什么不直接调 `t(key) !== key`】
   * 那样既会污染 `_missing` 统计（`has` 的契约是"不触发缺失统计"），
   * 也会在"翻译内容恰好等于 key 文本"时误判为未翻译。
   */
  has(key: string, vars?: Record<string, unknown>): boolean {
    return this._resolve(key, vars) !== undefined;
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

  /**
   * 检查 key 本身或它的**运行时可解析**复数变体是否存在
   *
   * 【为什么这里必须和 `_pluralKeyOf` 用同一份清单】
   * 写死 CLDR 六形式时，覆盖率会把"运行时永远查不到的 key"算成已翻译，
   * 详见 `RESOLVABLE_PLURAL_FORMS` 的注释。
   */
  private _hasAnyForm(table: LocaleTable, key: string): boolean {
    if (typeof table[key] === 'string') return true;
    for (const form of RESOLVABLE_PLURAL_FORMS) {
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
    this._onChange.clear();
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
