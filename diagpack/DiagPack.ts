/**
 * diagpack/DiagPack.ts —— 诊断包生成
 *
 * 【它解决什么】
 *
 * 玩家反馈"游戏卡住了"，你在复现不了的时候，唯一能依靠的就是诊断包。
 * 但手写的诊断收集有三个典型缺陷：
 *
 * 1. **信息不全，且每次都缺不同的东西**
 *    第一次收到反馈，发现没记日志；加上日志，下次又发现没记设备信息；
 *    再补上，又发现没记配置版本……
 *    **每次都是在最需要的时候才发现少收集了东西。**
 *
 * 2. **没脱敏**
 *    日志里有玩家的手机号、邮箱、登录 token。
 *    诊断包被发到群里、贴到工单系统里——**这是一次数据泄露事故**。
 *    而且它发生得很安静，没人会注意到。
 *
 * 3. **收集过程本身会崩**
 *    遍历一个带循环引用的对象，`JSON.stringify` 直接抛错。
 *    于是"生成诊断包"这个操作自己成了新的崩溃源——
 *    玩家点了"发送诊断"，游戏崩了。
 *
 * 【设计】
 * 本模块是一个**收集器**：
 * - 分区（section）收集，每区独立 try/catch，一区失败不影响其他区
 * - 自动脱敏（可配置规则）
 * - 体积配额，超出部分裁剪并标记
 * - 安全序列化（循环引用、BigInt、函数都能处理）
 */

import { numOr } from '../_core/math';

// ==================== 类型 ====================

/** 诊断分区名 */
export type SectionName = string;

/** 分区提供者：返回任意可序列化的数据 */
export type SectionProvider = () => unknown;

/** 脱敏规则 */
export interface RedactRule {
  readonly name: string;
  /** 匹配 key 的正则（对对象的 key 生效） */
  readonly keyPattern?: RegExp;
  /** 匹配字符串值的正则（对字符串 value 生效） */
  readonly valuePattern?: RegExp;
  /** 替换成什么（默认 '[REDACTED]'） */
  readonly replacement?: string;
}

export interface DiagPackConfig {
  /** 应用标识 */
  readonly appId: string;
  /** 版本号 */
  readonly version: string;
  /**
   * 单分区最大字符数（默认 20000）
   *
   * 超出会被截断并标记 `[truncated]`。
   */
  readonly maxSectionChars?: number;
  /** 全包最大字符数（默认 200000，约 200KB） */
  readonly maxTotalChars?: number;
  /** 额外脱敏规则 */
  readonly extraRedactions?: readonly RedactRule[];
  /** 是否包含时间戳（默认 true） */
  readonly includeTimestamp?: boolean;
}

export interface DiagSection {
  readonly name: SectionName;
  readonly data: unknown;
  /** 收集是否失败 */
  readonly error?: string;
  /** 是否被截断 */
  readonly truncated?: boolean;
  /** 序列化后的字符数 */
  readonly chars: number;
}

export interface DiagnosticReport {
  readonly schema: 'cocos-kit-diag/1';
  readonly appId: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly generatedAtMs: number;
  readonly sections: readonly DiagSection[];
  readonly warnings: readonly string[];
  readonly totalChars: number;
}

// ==================== 默认脱敏规则 ====================

/**
 * 默认脱敏规则
 *
 * 【⚠️ 这些是最低限度，不是全部】
 * 每个项目的数据都不一样，务必补充 extraRedactions。
 */
export const DEFAULT_REDACTIONS: readonly RedactRule[] = [
  { name: 'password', keyPattern: /pass(word|wd)?|pwd|secret/i },
  { name: 'token', keyPattern: /token|access[-_]?key|api[-_]?key|auth/i },
  { name: 'email', valuePattern: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  /**
   * 中国大陆手机号
   *
   * 【⚠️ 这个正则会误伤长数字串】
   * 比如 11 位的订单号、ID。
   * 但宁可误伤——诊断包里少一个数字不影响排查，
   * 漏掉一个手机号是一次事故。
   */
  { name: 'phone-cn', valuePattern: /1[3-9]\d{9}/ },
  { name: 'id-card', valuePattern: /\b\d{17}[\dXx]\b/ },
  { name: 'credit-card', valuePattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/ },
  { name: 'ip', valuePattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'jwt', valuePattern: /eyJ[\w-]*\.eyJ[\w-]*\.[\w-]*/ },
];

// ==================== 安全序列化 ====================

/**
 * 安全 JSON 序列化
 *
 * 【处理四种会让 JSON.stringify 抛错或丢数据的情况】
 * 1. 循环引用 → 抛 TypeError
 * 2. BigInt → 抛 TypeError
 * 3. 函数 / Symbol / undefined → 被静默丢弃（排查时才发现少了字段）
 * 4. 超深嵌套 → 爆栈
 */
export function safeStringify(
  value: unknown,
  opts: {
    readonly maxDepth?: number;
    readonly indent?: number;
    /**
     * 传给 `JSON.stringify` 的 replacer（一般不需要）
     *
     * 【为什么这里原来有一个"恒等 replacer"】
     * 老代码写死了 `(_key, v) => v` 再传给 `JSON.stringify`——
     * 这是一个占位没写完的东西：它什么都没做，
     * 却让人以为"脱敏/过滤可以挂在这里"，进而把逻辑写进去然后发现不生效。
     * 现在改成由调用方显式传入；不传时行为与恒等 replacer 完全一致。
     */
    readonly replacer?: (key: string, value: unknown) => unknown;
  } = {}
): string {
  const maxDepth = opts.maxDepth ?? 8;
  /**
   * 【⚠️ seen 必须是"路径栈"，不能是"访问过的集合"】
   *
   * 老写法只 `add` 从不 `delete`，于是 `seen` 的语义是"本次序列化**曾经**见过的对象"。
   * 后果：同一个对象被两个字段引用（游戏中极常见——全局配置表被多个系统持有），
   * 第二个字段会被判成循环引用：
   *
   * ```
   * safeStringify({ a: shared, b: shared })
   *   → {"a":{"hp":100},"b":"[Circular]"}     ← b 的数据被静默丢掉
   * ```
   *
   * 诊断包丢的恰恰是最关键的那份上下文，而且看起来像"数据结构有问题"，
   * 实际是序列化器的问题——排查方向直接被带偏。
   *
   * 正确语义是"当前递归路径上是否出现过"：进入时 add，**递归返回时 delete**。
   * 真正的环（a.b → a）在返回前一定会再次撞上 seen，仍会被拦下。
   */
  const seen = new WeakSet<object>();

  function walk(v: unknown, depth: number): unknown {
    if (v === null || v === undefined) return null;
    const t = typeof v;

    if (t === 'number') {
      return Number.isFinite(v) ? v : String(v);
    }
    if (t === 'boolean' || t === 'string') return v;
    if (t === 'bigint') return `${v}n`;
    if (t === 'function') return '[Function]';
    if (t === 'symbol') return String(v);

    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: v.stack };
    }
    if (v instanceof RegExp) return v.toString();
    if (v instanceof Map) {
      return { '[Map]': [...v.entries()].map(([k, val]) => [walk(k, depth + 1), walk(val, depth + 1)]) };
    }
    if (v instanceof Set) return { '[Set]': [...v].map((x) => walk(x, depth + 1)) };
    if (ArrayBuffer.isView(v)) {
      /**
       * 【⚠️ ArrayBufferView 类型上没有 length】
       * TS 的 ArrayBufferView 是 DataView | TypedArray 的联合，
       * 不同成员的 length 声明位置不同。
       * 这里只需读个长度用于展示，用可选属性安全取即可。
       */
      const len = (v as { length?: number }).length ?? (v as { byteLength?: number }).byteLength ?? 0;
      return `[${v.constructor.name}(${len})]`;
    }

    if (depth >= maxDepth) return '[DeepObject]';

    if (t === 'object') {
      const o = v as Record<string, unknown>;
      if (seen.has(o)) return '[Circular]';
      seen.add(o);
      // 【为什么用 try/finally 而不是在函数末尾 delete】
      // 下面两个 return 分支（数组 / 对象）以及更深层递归都可能抛错
      // （getter 抛错、Proxy 拒绝访问）。忘记回溯会让"曾经见过"污染后续分支，
      // 把一堆无辜的共享对象标成 [Circular]。用 finally 保证任何出口都回溯。
      try {
        if (Array.isArray(v)) {
          return v.map((x) => walk(x, depth + 1));
        }
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(o)) {
          out[k] = walk(val, depth + 1);
        }
        return out;
      } finally {
        seen.delete(o);
      }
    }

    return String(v);
  }

  try {
    return JSON.stringify(walk(value, 0), opts.replacer, opts.indent ?? 0);
  } catch (e) {
    // 兜底：连安全序列化都失败了，至少返回原因
    return JSON.stringify({
      '[unserializable]': e instanceof Error ? e.message : String(e),
    });
  }
}

// ==================== 脱敏 ====================

/**
 * 对已序列化的数据做脱敏
 *
 * 【⚠️ 先序列化再脱敏，而不是先脱敏再序列化】
 *
 * 原因：脱敏要在**最终文本**上做。
 * 如果在对象上做，那些被 `String(v)` 转成的字符串（比如 Error 的 stack）
 * 里的手机号就漏掉了。而 stack 恰好是最容易带敏感信息的地方
 * （比如 `POST /api/user/13800138000`）。
 */
/** JSON 文本里的空白字符 */
function isJsonWs(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/**
 * 从 `pos` 起跳过一个**完整**的 JSON 值，返回结束后一位的下标
 *
 * 【为什么必须"扫"而不是"正则匹配"】
 * 老实现用 `(?:"[^"]*"|[^,}\]]+)` 去匹配"值"这一段。
 * 值一旦是对象或数组，这个片段就会在第一个 `,` / `}` 处提前收尾，
 * 剩下的尾巴留在原地——**脱敏后的文本不再是合法 JSON**：
 *
 * ```
 * redact('{"password": {"a":1},"nested":1}')
 *   → {"password": "[REDACTED]"},"nested":1}     ← 多出一个 }
 * ```
 *
 * 服务端 `JSON.parse` 直接失败 → 整个诊断包作废。
 * 更糟的是这条路径**永不抛错**，所以"永不抛错"的承诺保住了，
 * 上报内容却不可用了——失败被推迟到了看不见的地方。
 *
 * 括号/引号配对只有"扫"才数得清（正则不擅数嵌套），所以用状态机：
 * 字符串内部整体跳过、容器按深度配对、标量吃到分隔符为止。
 */
function skipJsonValue(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && isJsonWs(text[i])) i++;
  const c = text[i];

  if (c === '"') {
    i++;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2; // 跳过转义字符（\" 不是字符串结尾）
        continue;
      }
      if (text[i] === '"') return i + 1;
      i++;
    }
    return text.length;
  }

  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      // 【为什么容器里也要跳过字符串】
      // `{"a":"}"}` 里的 `}` 不是结构字符，按括号计数会被带偏。
      if (ch === '"') {
        i = skipJsonValue(text, i);
        continue;
      }
      if (ch === c) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return text.length;
  }

  // 数字 / true / false / null：一直吃到空白或 JSON 分隔符
  while (i < text.length && !isJsonWs(text[i]) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i++;
  return i;
}

/**
 * 把文本中所有"命中 keyPattern 的 key"对应的**完整值**替换掉
 *
 * 【为什么不用 `String.replace(re, fn)`】
 * `replace` 只会删掉**正则匹配到的那一段**（这里是 key 本身），
 * 回调返回多长的内容都改变不了这一点——值那部分原文会原封不动地接在后面。
 * 实测：`{"token": [1,2,3],"ok":1}` 用 replace 会得到
 * `{"token": "[REDACTED]": [1,2,3],"ok":1}`——多出一个冒号和整个原值。
 *
 * 所以这里自己走一遍匹配循环，按"上一段末尾 → 本次值结束"切片拼接，
 * 才能把值真正替换掉。
 */
function replaceKeysByPattern(text: string, re: RegExp, replacement: string): string {
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++; // 防御：空匹配会让 exec 原地打转
      continue;
    }
    const start = m.index;
    let p = start + m[0].length;
    while (p < text.length && isJsonWs(text[p])) p++;
    // 命中 keyPattern 的引号串也可能只是**值**（如 `"note": "my password is x"`），
    // 后面没有冒号就不是 key——误替换会连正常内容一起吃掉。
    if (text[p] !== ':') continue;
    p++; // 吃掉冒号
    const end = skipJsonValue(text, p);
    if (end <= p) continue;

    out += text.slice(last, start) + text.slice(start, p) + ' ' + replacement;
    last = end;
    // 【为什么要把 lastIndex 推到值结束】
    // 被替换掉的值不需要再脱敏（它已经是 [REDACTED] 了），
    // 继续在里面匹配只会白白消耗时间，还可能命中值内部的冒号结构。
    re.lastIndex = end;
  }

  out += text.slice(last);
  return out;
}

export function redact(
  json: string,
  rules: readonly RedactRule[] = DEFAULT_REDACTIONS,
  opts: { readonly onRuleError?: (rule: RedactRule, error: unknown) => void } = {}
): string {
  let out = json;
  for (const r of rules) {
    const rep = r.replacement ?? '[REDACTED]';
    try {
      if (r.valuePattern) {
        // ⚠️ 必须是全局正则，否则只替换第一个
        const re = new RegExp(r.valuePattern.source, r.valuePattern.flags.includes('g')
          ? r.valuePattern.flags
          : r.valuePattern.flags + 'g');
        out = out.replace(re, rep);
      }
      if (r.keyPattern) {
        const src = r.keyPattern.source;
        // 【为什么只匹配 key，值交给 skipJsonValue 扫】
        // 见 skipJsonValue 的说明：值的边界只能用扫描确定，正则无法确定。
        //
        // 【⚠️ 为什么 key 部分用 `[^":]` 而不是 `[^"]`】
        // JSON 的 key 里不会出现引号，但 `[^"]*` 会**跨过冒号和逗号**继续吃：
        // 在 `{"token": [1,2,3],"ok":1}` 上它会一路匹配到 `"token": [1,2,3],`
        // （在下一个 `"` 前才停），于是整段被当成 key 名，
        // 后面判断冒号自然失败 → 脱敏不生效，或者更糟：把一段结构当成 key 替换掉。
        const re = new RegExp(`"[^":]*(?:${src})[^":]*"`, 'gi');
        out = replaceKeysByPattern(out, re, rep.startsWith('[') ? `"${rep}"` : rep);
      }
    } catch (e) {
      // 【为什么不能空 catch】
      // 老实现在这里写了 `catch { }`，注释说"单条规则失败不影响其他规则"。
      // 不中断是对的，但**完全无声**是错的：
      // 任何一条规则炸了，脱敏就被静默跳过，
      // 而 README 承诺"序列化后脱敏"——这是一条能把明文密码 / token 报上去的路径。
      // 敏感信息泄露必须吵，不能静。
      if (opts.onRuleError) opts.onRuleError(r, e);
      else console.error(`[diagpack] 脱敏规则「${r.name}」执行失败，该规则已被跳过`, e);
    }
  }
  return out;
}

// ==================== 收集器 ====================

/** 单分区字符配额默认值 */
const DEFAULT_MAX_SECTION_CHARS = 20_000;
/** 全包字符配额默认值 */
const DEFAULT_MAX_TOTAL_CHARS = 200_000;
/**
 * 字符数硬上界（约 100MB 文本）
 *
 * 【为什么需要上界】没有上界时 `maxTotalChars: Infinity` 会让配额形同虚设，
 * 一个持有超大对象的分区能把内存吃干。
 */
const MAX_CHARS_HARD_CAP = 100_000_000;

/**
 * 配额收口：非有限值 / 非正数一律回落到默认值，正常值再夹到硬上界
 *
 * 【为什么"非正数"要回落而不是夹到 1】
 * 夹到 1 等于"每个分区截成 1 个字符"——配置看起来生效了，内容其实是空的，
 * 这正是本单元要防的那种"静默失效"。非正数没有合理语义，按没配处理更诚实。
 */
function positiveCapOr(v: number | undefined, fallback: number, cap: number): number {
  const n = numOr(v, fallback);
  // 肯定式写法：NaN 已经在上一步被 numOr 挡掉，这里只处理 0 / 负数
  return n > 0 ? Math.min(n, cap) : fallback;
}

export class DiagCollector {
  private readonly _cfg: Required<Omit<DiagPackConfig, 'extraRedactions'>>;
  private readonly _rules: readonly RedactRule[];
  private readonly _providers = new Map<SectionName, SectionProvider>();

  constructor(cfg: DiagPackConfig) {
    this._cfg = {
      appId: cfg.appId,
      version: cfg.version,
      /**
       * 【为什么这两个配额必须收口】
       * 老写法是 `?? 20_000`：只挡了 undefined，
       * 于是 `maxSectionChars: 0` → 每个分区被截成 0 字符（内容全丢，还记着 chars=12），
       * `maxTotalChars: -1` → `total + safe.length > -1` 恒真，
       * **第一个分区就被判定超配额而丢弃**，整个诊断包是空的。
       * 两个方向都不报错，运营看到的是"玩家发了诊断包，里面什么都没有"。
       *
       * NaN 同理：`x > NaN` 恒为 false → 配额**完全失效**（永不截断，包体无限大）。
       *
       * 非正数没有合理语义（"配额为 0"等价于"什么都不收集"），
       * 所以一律视为没配，回落到默认值；上界用于挡住 `Infinity` 导致的 OOM。
       */
      maxSectionChars: positiveCapOr(cfg.maxSectionChars, DEFAULT_MAX_SECTION_CHARS, MAX_CHARS_HARD_CAP),
      maxTotalChars: positiveCapOr(cfg.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS, MAX_CHARS_HARD_CAP),
      includeTimestamp: cfg.includeTimestamp ?? true,
    };
    this._rules = [...DEFAULT_REDACTIONS, ...(cfg.extraRedactions ?? [])];
  }

  /**
   * 注册一个分区
   *
   * @param name 分区名
   * @param provider 数据提供者（调用时才执行）
   *
   * 【为什么用 provider 而不是直接传值】
   * 诊断包只在出问题时生成。
   * 如果注册时就取值，等于每帧都在为"可能永远用不到"的东西付费。
   */
  section(name: SectionName, provider: SectionProvider): this {
    this._providers.set(name, provider);
    return this;
  }

  /** 移除分区 */
  removeSection(name: SectionName): boolean {
    return this._providers.delete(name);
  }

  get sectionNames(): readonly SectionName[] {
    return [...this._providers.keys()];
  }

  /**
   * 释放资源
   *
   * 【为什么必须有 destroy】
   * `section(name, provider)` 收进来的 provider 是闭包——
   * 而它通常捕获了组件 / 场景对象 / 玩家数据（这正是要诊断的东西）。
   * 这些引用挂在收集器上，收集器又常被做成单例，
   * 于是一整棵 Cocos 节点树在场景销毁后仍无法回收。
   *
   * 本单元没有 install，但持有外部闭包就是持有外部生命周期，
   * 与"有 install 必须有 uninstall"是同一条规则，所以这里补 destroy。
   */
  destroy(): void {
    this._providers.clear();
  }

  /**
   * 生成诊断报告
   *
   * 【⚠️ 这个方法永不抛错】
   * 收集诊断信息的代码如果自己崩了，
   * 玩家会陷入"点发送 → 崩溃 → 再点 → 再崩"的循环。
   * 所有异常都被捕获并记录为 section 的 error 字段。
   */
  generate(now = Date.now()): DiagnosticReport {
    const sections: DiagSection[] = [];
    const warnings: string[] = [];
    let total = 0;

    for (const [name, provider] of this._providers) {
      let raw: unknown;
      try {
        raw = provider();
      } catch (e) {
        sections.push({
          name,
          data: null,
          error: e instanceof Error ? e.message : String(e),
          chars: 0,
        });
        warnings.push(`分区 "${name}" 收集失败：${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      let json: string;
      try {
        json = safeStringify(raw);
      } catch (e) {
        sections.push({
          name,
          data: null,
          error: `序列化失败：${e instanceof Error ? e.message : String(e)}`,
          chars: 0,
        });
        continue;
      }

      // 脱敏（在最终文本上做）
      let safe: string;
      try {
        safe = redact(json, this._rules, {
          // 【为什么把规则失败写进 warnings】
          // 脱敏失败 = 敏感信息可能原样上报，这是要有人在工单里看见的事，
          // 不能只留在控制台里。
          onRuleError: (rule, err) => {
            warnings.push(
              `分区 "${name}" 的脱敏规则「${rule.name}」执行失败，该规则已跳过：${
                err instanceof Error ? err.message : String(err)
              }`
            );
          },
        });
      } catch (e) {
        safe = json;
        warnings.push(`分区 "${name}" 脱敏失败，已保留原文：${e instanceof Error ? e.message : String(e)}`);
      }

      // 分区配额
      let truncated = false;
      if (safe.length > this._cfg.maxSectionChars) {
        safe = safe.slice(0, this._cfg.maxSectionChars) + '…[truncated]';
        truncated = true;
        warnings.push(`分区 "${name}" 超出 ${this._cfg.maxSectionChars} 字符，已截断`);
      }

      // 全包配额
      if (total + safe.length > this._cfg.maxTotalChars) {
        const room = Math.max(0, this._cfg.maxTotalChars - total);
        if (room < 100) {
          warnings.push(`已达总配额 ${this._cfg.maxTotalChars}，分区 "${name}" 及之后被丢弃`);
          break;
        }
        safe = safe.slice(0, room) + '…[truncated]';
        truncated = true;
        warnings.push(`分区 "${name}" 因总配额被截断`);
      }

      let data: unknown = safe;
      try {
        data = JSON.parse(safe.endsWith('…[truncated]') ? safe.slice(0, -13) : safe);
      } catch {
        // 解析不回来就保留字符串
        data = safe;
      }

      total += safe.length;
      sections.push({ name, data, chars: safe.length, truncated });
    }

    return {
      schema: 'cocos-kit-diag/1',
      appId: this._cfg.appId,
      version: this._cfg.version,
      generatedAt: new Date(now).toISOString(),
      generatedAtMs: now,
      sections,
      warnings,
      totalChars: total,
    };
  }

  /**
   * 生成并序列化为 JSON 文本
   *
   * @param pretty 是否格式化（默认 true，便于人看；上传时建议 false）
   */
  generateJson(now?: number, pretty = true): string {
    const report = this.generate(now);
    return safeStringify(report, { indent: pretty ? 2 : 0 });
  }

  /**
   * 生成人类可读的摘要
   *
   * 【用途】
   * 贴到工单里时，不需要把整个 JSON 都贴上去。
   * 摘要给出"发生了什么"的关键信息。
   */
  summarize(now?: number): string {
    const r = this.generate(now);
    const lines = [
      `诊断包 · ${r.appId} v${r.version}`,
      `生成时间：${r.generatedAt}`,
      `分区数：${r.sections.length}  总字符：${r.totalChars}`,
      '',
    ];

    for (const s of r.sections) {
      if (s.error) {
        lines.push(`  ✗ ${s.name}：收集失败（${s.error}）`);
      } else {
        const flag = s.truncated ? ' [截断]' : '';
        lines.push(`  ✓ ${s.name}：${s.chars} 字符${flag}`);
      }
    }

    if (r.warnings.length > 0) {
      lines.push('', '警告：');
      for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
    }

    return lines.join('\n');
  }
}

// ==================== 便捷：环境信息 ====================

/**
 * 收集环境信息
 *
 * 【⚠️ 它接受一个 env 对象而不是直接访问全局】
 *
 * 浏览器 / Cocos 原生 / Node 的环境 API 完全不同，
 * 直接访问会让这个模块无法在 Node 里测试。
 * 由调用方传进来，测试时传假的即可。
 */
export function collectEnvironment(
  env: {
    readonly platform?: string;
    readonly os?: string;
    readonly osVersion?: string;
    readonly deviceModel?: string;
    readonly language?: string;
    readonly screenWidth?: number;
    readonly screenHeight?: number;
    readonly pixelRatio?: number;
    readonly memoryMB?: number;
    readonly networkType?: string;
    readonly [k: string]: unknown;
  },
  /**
   * 可注入的时间 / 时区（测试用，不传则走真实环境）
   *
   * 【为什么要开这个口子】
   * 原实现在函数内部直连 `new Date()` 与 `Intl`。
   * 环境采集本身读全局是合理的（不像随机源那样影响可复现性），
   * 但后果是**这个函数的输出无法被断言**：
   * 同一份输入在成都和纽约跑出两个结果，测试只能写"字段存在"这种弱断言。
   * 时区恰好又是"每天 0 点刷新"类问题的核心线索——最需要被精确断言的字段，
   * 偏偏是不可控的。所以把它变成可注入，默认行为完全不变。
   */
  inject: {
    readonly now?: number;
    readonly timezone?: string;
    readonly timezoneOffsetMin?: number;
  } = {}
): Record<string, unknown> {
  const d = new Date(inject.now ?? Date.now());
  return {
    ...env,
    collectedAt: d.toISOString(),
    timezone: inject.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    /**
     * 时区偏移（分钟）
     *
     * 【为什么单独记】
     * 玩家的"每天 0 点刷新"问题，八成是时区理解不一致。
     * 有了 offset 就能直接判断是客户端错了还是服务端错了。
     */
    timezoneOffsetMin: inject.timezoneOffsetMin ?? d.getTimezoneOffset(),
  };
}
