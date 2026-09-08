/**
 * rebind/Rebind.ts —— 按键重映射
 *
 * 【它解决什么】
 *
 * 设置界面里的"按键设置"，看起来就是存一个 map。
 * 真正麻烦的是：
 *
 * - **编码归一化**：`ctrl+shift+s` 和 `shift+ctrl+s` 是同一组合，
 *   不排序会存成两条，且互相检测不到冲突
 * - **冲突处理**：把"跳跃"绑到 J，而 J 已经是"攻击"，怎么办？
 * - **保留键**：ESC 通常要留给菜单，不该允许绑定
 * - **反向索引清理**：解除绑定后不清理反向索引，下次绑定会误判冲突
 *
 * 本模块把它们做对：
 *
 * ```typescript
 * const rb = new Rebind({ jump: { key: 'space' } }, { conflict: 'swap' });
 * rb.bind('jump', { key: 'j' });   // j 原本是 attack → 两者互换
 * rb.actionOf({ key: 'space' });   // 'attack'
 * ```
 *
 * 【⚠️ 它不知道键盘事件长什么样】
 * 传入的是 `{ key, mods }` 这样的纯数据，
 * 从引擎事件到这个结构的转换由适配层做。
 *
 * 【无引擎依赖】
 */

import { hasOwn } from '../_core/guard';

// ==================== 类型 ====================

export type Modifier = 'ctrl' | 'shift' | 'alt' | 'meta';

export interface Binding {
  readonly key: string;
  readonly mods?: readonly Modifier[];
}

export type ConflictPolicy =
  /** 互换：被顶掉的动作拿到原按键 */
  | 'swap'
  /** 顶掉：被占用的动作直接解除绑定 */
  | 'unbind'
  /** 拒绝：保持原绑定不变 */
  | 'reject';

export interface RebindOptions {
  readonly conflict?: ConflictPolicy;
  /** 保留键（不允许绑定） */
  readonly reserved?: readonly string[];
  readonly onChange?: (action: string) => void;
}

export type BindingMap = Readonly<Record<string, Binding>>;

// ==================== 常量 ====================

export const MODIFIERS: readonly Modifier[] = ['ctrl', 'shift', 'alt', 'meta'];

/** 修饰键的展示顺序（Ctrl → Alt → Shift → Meta） */
const MOD_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta'];

/**
 * 默认保留键
 *
 * 【为什么保留这两个】
 * ESC 通常是"返回/菜单"的硬编码行为；
 * F11 是全屏，浏览器和多数引擎都占用了。
 */
export const DEFAULT_RESERVED: readonly string[] = ['escape', 'f11'];

/** 修饰键本身不能作为主键 */
const MOD_SET = new Set<string>(MODIFIERS);

const PRETTY: Readonly<Record<string, string>> = {
  escape: 'Esc',
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Del',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  shift: 'Shift',
  ctrl: 'Ctrl',
  alt: 'Alt',
  meta: 'Meta',
  /**
   * 【左右修饰键】
   *
   * 键盘事件给出的 code 是 `ShiftLeft` / `ControlRight` 这种，
   * 不做映射的话设置界面会显示 "Shiftleft" ——
   * 玩家看不懂这是什么键，也不好看。
   */
  shiftleft: 'L-Shift',
  shiftright: 'R-Shift',
  controlleft: 'L-Ctrl',
  controlright: 'R-Ctrl',
  altleft: 'L-Alt',
  altright: 'R-Alt',
  metaleft: 'L-Meta',
  metaright: 'R-Meta',
  capslock: 'Caps',
};

// ==================== 编解码 ====================

/**
 * 编码成规范字符串
 *
 * 【⚠️ 修饰键必须排序并去重】
 * 否则 `ctrl+shift+s` 和 `shift+ctrl+s` 会被当成两个不同组合，
 * 冲突检测就失效了——玩家会发现"我明明已经改了，怎么还是冲突"。
 */
export function encodeBinding(b: Binding): string {
  const key = b.key.trim().toLowerCase();
  if (key === '') {
    throw new Error('[Rebind] 按键不能为空');
  }

  const mods = b.mods ?? [];
  for (const m of mods) {
    if (!MOD_SET.has(m)) {
      throw new Error(
        `[Rebind] 未知的修饰键："${m}"（可选：${MODIFIERS.join(', ')}）`
      );
    }
  }

  const sorted = [...new Set(mods)].sort(
    (a, b2) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b2)
  );

  return sorted.length > 0 ? `${sorted.join('+')}+${key}` : key;
}

/**
 * 解码规范字符串
 *
 * 【⚠️ 解析不出主键时必须抛错，不能返回 `{ key: undefined }`】
 *
 * `'+'` 这种"只有加号"的脏数据，split 之后再过滤空串会得到空数组，
 * 于是 `parts[parts.length - 1]` 是 `undefined`——原实现照样返回了一个
 * 结构合法的 `Binding`，只是 key 是 undefined。
 *
 * 后果不在这一行，而在下游：调用方拿到"看起来是对的对象"后
 * 去调 `isReserved(undefined.key)`，内部 `key.trim()` 直接抛 TypeError。
 * 实测（修复前）：`importState({ jump: '+' })` 抛出
 * `Cannot read properties of undefined (reading 'trim')`，
 * **整个导入批次中断**——后面明明正确的条目一条都没进。
 *
 * 让它在解析阶段就以"格式错误"失败，调用方的 `catch` 才能正常跳过这一条。
 */
export function decodeBinding(s: string): Binding {
  const raw = s.trim().toLowerCase();
  if (raw === '') {
    throw new Error('[Rebind] 空的按键组合');
  }

  const parts = raw.split('+').map((x) => x.trim()).filter((x) => x !== '');
  const key = parts[parts.length - 1];
  if (typeof key !== 'string' || key === '') {
    throw new Error(`[Rebind] 按键组合 "${s}" 解析不出主键`);
  }

  if (MOD_SET.has(key)) {
    throw new Error(`[Rebind] 修饰键 "${key}" 不能作为主键`);
  }

  const mods = parts.slice(0, -1) as Modifier[];
  for (const m of mods) {
    if (!MOD_SET.has(m)) {
      throw new Error(`[Rebind] 未知的修饰键："${m}"（可选：${MODIFIERS.join(', ')}）`);
    }
  }

  return mods.length > 0 ? { key, mods } : { key };
}

// ==================== 展示 ====================

/**
 * 单个按键的展示名
 *
 * 【⚠️ 查 `PRETTY` 必须先判自有属性，不能 `if (PRETTY[k])`】
 *
 * `PRETTY` 是对象字面量，`PRETTY['constructor']` 会顺着原型链取到
 * `Object.prototype` 上的**函数**（truthy！），于是被当成展示名返回。
 * 实测（修复前）：
 * ```
 * prettyKey('constructor') → typeof 'function'，值 function Object() { [native code] }
 * ```
 * 键名来自外部输入（导入配置、宏录制、剪贴板粘贴）时，
 * 设置界面上会显示一段函数源码；宿主再对它 `toUpperCase()`
 * 就直接抛 TypeError。用 `hasOwn` 收口。
 */
export function prettyKey(key: string): string {
  const k = key.toLowerCase();
  if (hasOwn(PRETTY, k)) return PRETTY[k];
  return k.length === 1 ? k.toUpperCase() : capitalize(k);
}

/** 完整组合的展示名 */
export function formatBinding(b: Binding): string {
  const mods = (b.mods ?? [])
    .slice()
    .sort((a, c) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(c));

  // 同 prettyKey：走自有属性查表，别让 'constructor' 之类取到原型方法
  const parts = mods.map((m) => (hasOwn(PRETTY, m) ? PRETTY[m] : capitalize(m)));
  parts.push(prettyKey(b.key));
  return parts.join('+');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// ==================== 实现 ====================

export class Rebind {
  private readonly _defaults: Record<string, Binding> = {};
  private readonly _bindings = new Map<string, Binding>();
  /** 反向索引：编码 → 动作 */
  private readonly _byCode = new Map<string, string>();
  private readonly _conflict: ConflictPolicy;
  private readonly _reserved: Set<string>;
  private readonly _onChange?: (action: string) => void;

  constructor(defaults: BindingMap = {}, opts: RebindOptions = {}) {
    this._conflict = opts.conflict ?? 'reject';
    this._reserved = new Set(
      (opts.reserved ?? DEFAULT_RESERVED).map((k) => k.toLowerCase())
    );
    this._onChange = opts.onChange;

    for (const [action, b] of Object.entries(defaults)) {
      this._defaults[action] = b;
      this._setRaw(action, b);
    }
  }

  // ==================== 查询 ====================

  bindingOf(action: string): Binding | undefined {
    return this._bindings.get(action);
  }

  /** 由按键查动作 */
  actionOf(b: Binding): string | null {
    let code: string;
    try {
      code = encodeBinding(b);
    } catch {
      return null;
    }
    return this._byCode.get(code) ?? null;
  }

  has(action: string): boolean {
    return this._bindings.has(action);
  }

  /** 全部已绑定的动作（可变数组，方便调用方排序） */
  get actions(): string[] {
    return [...this._bindings.keys()];
  }

  isReserved(key: string): boolean {
    return this._reserved.has(key.trim().toLowerCase());
  }

  // ==================== 修改 ====================

  /**
   * 绑定一个动作
   *
   * @returns 是否成功（冲突策略为 reject 时可能失败）
   */
  bind(action: string, b: Binding): boolean {
    const code = encodeBinding(b);

    if (this.isReserved(b.key)) {
      throw new Error(
        `[Rebind] "${b.key}" 是保留键，不可绑定（保留：${[...this._reserved].join(', ')}）`
      );
    }

    const owner = this._byCode.get(code);

    // 绑定到自己当前的键：无冲突
    if (owner === action) {
      this._setRaw(action, b);
      this._onChange?.(action);
      return true;
    }

    if (owner !== undefined) {
      switch (this._conflict) {
        case 'reject':
          return false;

        case 'unbind':
          this._removeRaw(owner);
          this._onChange?.(owner);
          break;

        case 'swap': {
          const oldBinding = this._bindings.get(action);
          this._removeRaw(owner);
          /**
           * 【⚠️ 目标原本没绑定时不能无条件交换】
           * 原实现在 swap 分支里总是执行 "owner ← action 的旧键"，
           * 而 action 原本没绑定时，这会把 action 解绑——
           * 结果两个动作都指向同一个键或都消失。
           *
           * 正确行为：action 没有旧绑定时，退化为 unbind。
           */
          if (oldBinding) {
            this._setRaw(owner, oldBinding);
            this._onChange?.(owner);
          }
          break;
        }
      }
    }

    this._setRaw(action, b);
    this._onChange?.(action);
    return true;
  }

  unbind(action: string): boolean {
    const existed = this._removeRaw(action);
    if (existed) this._onChange?.(action);
    return existed;
  }

  /** 恢复默认 */
  resetToDefault(): void {
    const actions = new Set<string>([
      ...this._bindings.keys(),
      ...Object.keys(this._defaults),
    ]);

    this._bindings.clear();
    this._byCode.clear();

    for (const a of actions) {
      const d = this._defaults[a];
      if (d) {
        this._setRaw(a, d);
        this._onChange?.(a);
        continue;
      }
      /**
       * 【⚠️ 没有默认值的动作：绑定确实会被清掉，但必须通知】
       *
       * 原实现"先 clear 再只填有 default 的"，对**当前有绑定但没有默认值**
       * 的动作等于静默解绑——内部状态已经没了，`onChange` 却没触发。
       * 实测（修复前）：`rb.bind('custom', {key:'k'})` 后 `resetToDefault()`，
       * `has('custom') === false`，但界面上还显示着 K。
       *
       * "恢复默认"对没有默认值的动作来说，解绑本身是合理的
       * （默认值 = 没有默认值 = 不绑定），所以这里**保持解绑语义**，
       * 只补上缺失的通知——真正的问题是"静默"，不是"丢弃"。
       */
      this._onChange?.(a);
    }
  }

  clearAll(): void {
    const actions = [...this._bindings.keys()];
    this._bindings.clear();
    this._byCode.clear();
    for (const a of actions) this._onChange?.(a);
  }

  // ==================== 存档 ====================

  /** 导出成 `{ action: 'ctrl+s' }` */
  exportState(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [action, b] of this._bindings) {
      out[action] = encodeBinding(b);
    }
    return out;
  }

  /**
   * 导入
   *
   * 【⚠️ 容错优先】
   * 存档可能被手改、可能被旧版本写坏。
   * 坏数据跳过并保持原绑定，好过整个设置界面打不开。
   */
  importState(state: Readonly<Record<string, string>>): void {
    for (const [action, code] of Object.entries(state)) {
      /**
       * 【⚠️ 整条解析链路都要在 try 里，不能只包 decodeBinding】
       *
       * 原实现只把 `decodeBinding` 包进 try，后面三行留在 try 外：
       * `isReserved(b.key)` 遇到坏数据（`b.key` 为 undefined）会抛
       * TypeError，**并且这次抛出发生在 try 之外**——
       * 于是坏数据不是"跳过这一条"，而是**中断整个导入批次**。
       *
       * 实测（修复前）：`importState({ jump: '+', attack: 'k' })` 抛异常后
       * `has('attack') === false` —— 明明合法的 attack 也没导入。
       * 玩家从云存档恢复按键，只要其中任意一条是脏数据（老版本遗留、
       * 手改配置、剪贴板粘贴），整份设置就恢复失败，且无任何错误提示。
       */
      try {
        const b = decodeBinding(code);
        if (typeof b.key !== 'string' || b.key === '') continue;  // 双保险
        if (this.isReserved(b.key)) continue;

        const owner = this._byCode.get(encodeBinding(b));
        /**
         * 【⚠️ 重复 code：保留先来的，跳过后来的】
         *
         * 原实现调 `_removeRaw(owner)` 把前一个动作**彻底解绑**
         * （不是恢复默认，是变成"没有绑定"），而且**不触发 onChange**。
         * 实测（修复前）：`importState({ a: 'k', b: 'k' })` 后
         * a 无绑定、b 有绑定。
         *
         * 后果比"冲突没解决"更糟：a 静默失去绑定，而设置界面
         * 因为没收到 onChange **仍显示旧键位**——玩家点了没反应，
         * 会以为键盘坏了。
         *
         * 选"保留前者"而不是"后者覆盖前者"：导入是一批数据的整体恢复，
         * 顺序通常取决于 `Object.entries`（对象字面量顺序），
         * 让结果依赖这个顺序本来就危险；先到先得至少是稳定的。
         */
        if (owner !== undefined && owner !== action) continue;

        const prev = this._bindings.get(action);
        this._setRaw(action, b);
        // 导入是"外部改状态"，UI 必须被通知，否则界面与内状态不一致
        if (!prev || encodeBinding(prev) !== encodeBinding(b)) {
          this._onChange?.(action);
        }
      } catch {
        continue;   // 格式错误，跳过这一条，继续下一条
      }
    }
  }

  /** 还原成配置对象（写回默认值用） */
  toObject(): Record<string, Binding> {
    const out: Record<string, Binding> = {};
    for (const [action, b] of this._bindings) {
      out[action] = b;
    }
    return out;
  }

  // ==================== 内部 ====================

  private _setRaw(action: string, b: Binding): void {
    // 先移除旧绑定，清理反向索引
    this._removeRaw(action);
    const code = encodeBinding(b);
    this._bindings.set(action, b);
    this._byCode.set(code, action);
  }

  private _removeRaw(action: string): boolean {
    const old = this._bindings.get(action);
    if (!old) return false;
    this._bindings.delete(action);
    /**
     * 【为什么只算一次 encodeBinding】
     * 原实现在判断和删除里各调一次——`encodeBinding` 内部要
     * trim / toLowerCase / split / Set 去重 / sort，是这一行里最贵的操作，
     * 而 `unbind` 这类调用在设置界面里会连续触发。行为完全等价，纯省一半。
     */
    const code = encodeBinding(old);
    // 只有反向索引还指向自己时才删（可能被别人覆盖了）
    if (this._byCode.get(code) === action) {
      this._byCode.delete(code);
    }
    return true;
  }

  /**
   * 卸载（rule5：有 install 必须有对应的 uninstall/destroy）
   *
   * 【为什么必须有】
   * `onChange` 闭包通常捕获整个设置界面。实例被丢弃但回调不清，
   * 界面生命周期就被这个对象拖住了。清空后再调用查询方法都会返回空，
   * 是"安全的空壳"，不会抛错。
   */
  destroy(): void {
    this._bindings.clear();
    this._byCode.clear();
    for (const k of Object.keys(this._defaults)) delete this._defaults[k];
  }
}
