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
  opts: { readonly maxDepth?: number; readonly indent?: number } = {}
): string {
  const maxDepth = opts.maxDepth ?? 8;
  const seen = new WeakSet<object>();

  const replacer = (_key: string, v: unknown): unknown => {
    return v;
  };

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

      if (Array.isArray(v)) {
        return v.map((x) => walk(x, depth + 1));
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) {
        out[k] = walk(val, depth + 1);
      }
      return out;
    }

    return String(v);
  }

  try {
    return JSON.stringify(walk(value, 0), replacer, opts.indent ?? 0);
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
export function redact(
  json: string,
  rules: readonly RedactRule[] = DEFAULT_REDACTIONS
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
        // 匹配 "key": value 形式
        const src = r.keyPattern.source;
        const re = new RegExp(`"[^"]*(?:${src})[^"]*"\\s*:\\s*(?:"[^"]*"|[^,}\\]]+)`, 'gi');
        out = out.replace(re, (m) => {
          const colon = m.indexOf(':');
          const keyPart = m.slice(0, colon + 1);
          return `${keyPart} ${rep.startsWith('[') ? `"${rep}"` : rep}`;
        });
      }
    } catch {
      // 单条规则失败不影响其他规则
    }
  }
  return out;
}

// ==================== 收集器 ====================

export class DiagCollector {
  private readonly _cfg: Required<Omit<DiagPackConfig, 'extraRedactions'>>;
  private readonly _rules: readonly RedactRule[];
  private readonly _providers = new Map<SectionName, SectionProvider>();

  constructor(cfg: DiagPackConfig) {
    this._cfg = {
      appId: cfg.appId,
      version: cfg.version,
      maxSectionChars: cfg.maxSectionChars ?? 20_000,
      maxTotalChars: cfg.maxTotalChars ?? 200_000,
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
        safe = redact(json, this._rules);
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
export function collectEnvironment(env: {
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
}): Record<string, unknown> {
  return {
    ...env,
    collectedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    /**
     * 时区偏移（分钟）
     *
     * 【为什么单独记】
     * 玩家的"每天 0 点刷新"问题，八成是时区理解不一致。
     * 有了 offset 就能直接判断是客户端错了还是服务端错了。
     */
    timezoneOffsetMin: new Date().getTimezoneOffset(),
  };
}
