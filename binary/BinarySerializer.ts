/**
 * BinarySerializer —— 位级二进制序列化
 *
 * 【它解决什么】
 *
 * JSON 存档的三个问题：
 * 1. **体积大**：`{"hp":100,"mp":50}` 是 21 字节，二进制只要 2~3 字节
 * 2. **能被人改**：玩家用记事本打开存档改金币，虽然单机无所谓，
 *    但排行榜一旦接入服务器，造假数据会污染整个榜
 * 3. **浮点精度**：`0.1 + 0.2` 在 JSON 里是 `0.30000000000000004`，
 *    往返后种子复现可能对不上
 *
 * 二进制格式解决这三个。代价是**不可读**（调试时看不到内容），
 * 所以本模块同时提供 `toHex()` 用于日志。
 *
 * 【设计：schema 驱动 + 位打包】
 *
 * ```typescript
 * const hero = schema({
 *   hp:    uint(10),      // 0~1023，占 10 bit
 *   level: uint(6),       // 0~63
 *   alive: bool(),        // 1 bit
 *   x:     float(-1000, 1000, 0.01),   // 量化到 0.01
 * });
 * ```
 *
 * 上面这条记录占 **10 + 6 + 1 + 18 = 35 bit ≈ 5 字节**，
 * 而 JSON 版本是 45 字节。
 *
 * 【⚠️ 位打包的代价】
 * 位级打包省空间，但**改字段宽度会让所有旧存档失效**。
 * 所以要么一开始就留足余量，要么加版本号做迁移。
 * 本模块的 `schemaVersion` 就是为此存在。
 *
 * 【无引擎依赖】
 */

// ==================== 字段类型 ====================

/** 字段定义 */
export interface FieldDef<T = unknown> {
  readonly kind: 'uint' | 'int' | 'bool' | 'float' | 'enum' | 'string' | 'raw';
  /** 位宽（uint/int/float/enum 用） */
  readonly bits: number;
  /** 编码 */
  write(w: BitWriter, v: T): void;
  /** 解码 */
  read(r: BitReader): T;
  /** 默认值（字段缺失时用） */
  readonly default: T;
  /** 人类可读描述（用于 debugSchema） */
  readonly describe: string;
}

/** 无符号整数：0 ~ (2^bits - 1) */
export function uint(bits: number, def = 0): FieldDef<number> {
  /**
   * 【⚠️ `1 << bits` 在 bits ≥ 31 时是错的】
   *
   * JS 的位移量按 5 位掩码：`1 << 31` 不是 2^31 而是 **-2147483648**，
   * `1 << 32` 绕回 `1 << 0` = 1。
   *
   * 实测（修复前）：
   *   uint(31).describe → `uint31[0..-2147483649]`（上界是负数）
   *   uint(32).describe → `uint32[0..0]`
   *   uint(31).write(1) → THROW: uint31 越界：1（范围 0..-2147483649）
   *
   * 而 README §6① 明确写"位宽上限 32，schema 构造时就校验"、
   * §8 声称测试覆盖"32 位边界（0xffffffff）"——
   * 按文档去定义一个 32 位 ID / 哈希字段，运行期必然抛错。
   *
   * 修法：用乘方语义 `2 ** bits`，它在 31/32 位上仍是精确的（2^32 可精确表示）。
   */
  const max = Math.pow(2, bits) - 1;
  return {
    kind: 'uint',
    bits,
    default: def,
    describe: `uint${bits}[0..${max}]`,
    write: (w, v) => {
      /**
       * 【为什么分两种报错】
       * 原来统一报"越界"，于是 `1.5` 的提示是
       * "uint4 越界：1.5（范围 0..15）"——
       * 但 1.5 **在范围内**，玩家看到这条会以为范围写错了，
       * 去检查 schema 而不是检查自己传的值。
       *
       * "类型不对" 和 "数值超限" 是两种问题，
       * 报错信息必须能区分，否则排查方向会跑偏。
       */
      if (!Number.isInteger(v)) {
        throw new Error(`[Binary] uint${bits} 需要整数，收到 ${v}`);
      }
      if (v < 0 || v > max) {
        throw new Error(`[Binary] uint${bits} 越界：${v}（范围 0..${max}）`);
      }
      w.writeBits(v, bits);
    },
    read: (r) => r.readBits(bits) >>> 0,
  };
}

/** 有符号整数：-2^(bits-1) ~ 2^(bits-1)-1 */
export function int(bits: number, def = 0): FieldDef<number> {
  /**
   * 【⚠️ 同 uint：`1 << (bits-1)` 在 bits=32 时是 `1 << 31` = -2147483648】
   *
   * 实测（修复前）：`int(32).describe → int32[2147483648..-2147483649]`
   * ——下界是正的、上界是负的，区间整个反过来，
   * 于是 `int(32).write(0)` 都抛"越界：0（范围 2147483648..-2147483649）"。
   */
  const half = Math.pow(2, bits - 1);
  return {
    kind: 'int',
    bits,
    default: def,
    describe: `int${bits}[${-half}..${half - 1}]`,
    write: (w, v) => {
      if (!Number.isInteger(v)) {
        throw new Error(`[Binary] int${bits} 需要整数，收到 ${v}`);
      }
      if (v < -half || v > half - 1) {
        throw new Error(`[Binary] int${bits} 越界：${v}（范围 ${-half}..${half - 1}）`);
      }
      // 偏移编码：把有符号映射到无符号
      w.writeBits((v + half) >>> 0, bits);
    },
    read: (r) => r.readBits(bits) - half,
  };
}

/** 布尔 */
export function bool(def = false): FieldDef<boolean> {
  return {
    kind: 'bool',
    bits: 1,
    default: def,
    describe: 'bool',
    write: (w, v) => w.writeBits(v ? 1 : 0, 1),
    read: (r) => r.readBits(1) === 1,
  };
}

/**
 * 量化浮点
 *
 * 【为什么量化】
 * float32 占 32 位。但血量 0~1000 精确到 0.1 就够了：
 * 需要 log2(10000) ≈ 14 位，省了一半多。
 *
 * 【⚠️ 精度不是越高越好】
 * 坐标用 0.001 量化时，1 公里范围需要 31 位——
 * 和 float32 一样了，还失去了 NaN/Infinity 的表示能力。
 * 判据：**量化误差要小于游戏里能感知的最小距离**。
 */
export function float(
  min: number,
  max: number,
  step: number,
  def = 0,
  /**
   * 【`clamp`：显式声明"我就是想要截断"】
   *
   * 默认 **关闭**，越界抛错——与 uint / int 一致，也符合 README §6③
   * "越界值绝不静默截断"。
   *
   * 坐标 / 血量这类字段一旦静默截断，调用方以为写成功了，
   * 表现是"位置飘移"，能查一整天。
   * 但确实存在"越界就取边界"的合法需求（比如网络包里的容错），
   * 那种场景下请**显式打开**这个开关，让"这里会截断"写进代码里，
   * 而不是让下一个读代码的人去猜。
   */
  opts?: { readonly clamp?: boolean },
): FieldDef<number> {
  if (!(max > min)) throw new Error('[Binary] float 的 max 必须大于 min');
  if (!(step > 0)) throw new Error('[Binary] float 的 step 必须为正');
  const clamp = opts?.clamp ?? false;

  /**
   * 【⚠️ 浮点误差让 levels 少算一档】
   *
   * `(max - min) / step` 在十进制下是整数，二进制浮点里常常不是：
   * `(0.3 - 0) / 0.1 = 2.9999999999999996` → floor 之后少了一档。
   * 加 1e-9 的相对容错再取整，只影响"差一点点就到整数"的情形。
   */
  const levels = Math.floor((max - min) / step + 1e-9) + 1;
  const bits = Math.max(1, Math.ceil(Math.log2(levels)));
  /**
   * 【可表示的档位上界 ≠ 位宽上界】
   *
   * `levels` 通常不是 2 的幂，于是 `2^bits - 1` 会大于实际档位数：
   * 例 `float(0, 5, 2)` → levels=3（0/2/4）、bits=2 → 位宽能表示到 3 → **6 > max**。
   * 修复前读端 `read()` 就这样能读出超出 `max` 的值，与写端不对称。
   * 读写两端统一按 `maxLevel = levels - 1` 收口。
   */
  const maxLevel = levels - 1;

  return {
    kind: 'float',
    bits,
    default: def,
    describe: `float[${min}..${max}/${step}] (${bits}bit)`,
    write: (w, v) => {
      if (!Number.isFinite(v)) {
        throw new Error(`[Binary] float 收到非有限值：${v}`);
      }
      /**
       * 【⚠️ 曾经静默 clamp：写 999 读回 10，没有任何报错】
       *
       * README §6③ 写的是"越界值绝不静默截断——存进去 300，读出来 44，
       * 这种 bug 能查一天"，而 float 是本库最可能承载坐标 / 血量的类型：
       * 写超范围值被悄悄改小，调用方以为写成功了，
       * 表现就是"位置飘移"，且极难定位。
       * 与 uint / int 对齐：越界即抛。
       */
      if (v < min || v > max) {
        if (!clamp) {
          throw new Error(`[Binary] float 越界：${v}（范围 ${min}..${max}）`);
        }
        // clamp 显式开启：调用方知情，落到这里是预期行为
      }
      const clamped = Math.min(max, Math.max(min, v));
      /**
       * 【⚠️ 边界内的值也要收口：写 max 曾经抛错】
       *
       * `(max-min)/step` 不是整数时，max 本身无法由整数个 step 表示：
       * 实测（修复前）`float(0, 1.8, 0.5)` 是 2 bit（q ∈ 0..3 → 0/0.5/1.0/1.5），
       * `write(1.8)` 算出 q=4 → THROW "值 4 需要超过 2 位表示"。
       * **配置的上界自己写不进去**，这是量化定义内部的矛盾，不该由调用方承担。
       *
       * 收口到 maxLevel：读端能表示的最大值 `min + maxLevel*step` 因此恒 ≤ max，
       * 写读两端对称（修复前读端能表示到 2.0，超出 max）。
       * 注意这是**量化误差**（量化的固有属性），不是越界截断——
       * 越界在上面的分支已经抛错了。
       */
      const q = Math.min(maxLevel, Math.max(0, Math.round((clamped - min) / step)));
      w.writeBits(q, bits);
    },
    read: (r) => min + Math.min(maxLevel, r.readBits(bits)) * step,
  };
}

/** 枚举（按索引编码） */
export function enumeration<T extends string>(values: readonly T[], def: T): FieldDef<T> {
  if (values.length === 0) throw new Error('[Binary] enum 的候选值不能为空');
  if (!values.includes(def)) throw new Error(`[Binary] enum 默认值 ${def} 不在候选里`);

  const bits = Math.max(1, Math.ceil(Math.log2(values.length)));

  return {
    kind: 'enum',
    bits,
    default: def,
    describe: `enum[${values.join('|')}] (${bits}bit)`,
    write: (w, v) => {
      const i = values.indexOf(v);
      if (i < 0) throw new Error(`[Binary] enum 收到未知值：${v}`);
      w.writeBits(i, bits);
    },
    read: (r) => {
      const i = r.readBits(bits);
      // 【容错】索引越界时返回默认值，而不是 undefined
      // 旧存档遇到新枚举值时，宁可退化也不能崩
      return values[i] ?? def;
    },
  };
}

/**
 * 变长字符串（长度前缀 + UTF-8）
 *
 * 【不用固定长度的原因】
 * 玩家昵称、遗物 id 长度差异极大。
 * 固定 32 字节的话，短名字浪费 30 字节。
 *
 * 【变长的代价】编码后长度不确定，
 * 所以 `byteSize()` 只能给下界，精确值要编码后才知道。
 */
export function string(maxBytes = 255, def = ''): FieldDef<string> {
  const lenBits = Math.max(1, Math.ceil(Math.log2(maxBytes + 1)));
  return {
    kind: 'string',
    bits: 0,   // 变长
    default: def,
    describe: `string[<=${maxBytes}B] (${lenBits}bit 长度前缀)`,
    write: (w, v) => {
      const bytes = utf8Encode(v);
      if (bytes.length > maxBytes) {
        throw new Error(`[Binary] 字符串 "${v}" 编码后 ${bytes.length} 字节，超过上限 ${maxBytes}`);
      }
      w.writeBits(bytes.length, lenBits);
      for (const b of bytes) w.writeBits(b, 8);
    },
    read: (r) => {
      const len = r.readBits(lenBits);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = r.readBits(8);
      return utf8Decode(bytes);
    },
  };
}

/** 原始字节（变长） */
export function raw(maxBytes = 1024): FieldDef<Uint8Array> {
  const lenBits = Math.max(1, Math.ceil(Math.log2(maxBytes + 1)));
  return {
    kind: 'raw',
    bits: 0,
    default: new Uint8Array(0),
    describe: `raw[<=${maxBytes}B]`,
    write: (w, v) => {
      if (v.length > maxBytes) {
        throw new Error(`[Binary] raw 长度 ${v.length} 超过上限 ${maxBytes}`);
      }
      w.writeBits(v.length, lenBits);
      for (let i = 0; i < v.length; i++) w.writeBits(v[i], 8);
    },
    read: (r) => {
      const len = r.readBits(lenBits);
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = r.readBits(8);
      return out;
    },
  };
}

// ==================== Schema ====================

export type SchemaFields = Readonly<Record<string, FieldDef<never> | FieldDef<any>>>;

export interface SchemaOptions {
  /**
   * 结构版本号
   *
   * 【必须有】改字段宽度会让旧存档读出乱码，
   * 有版本号才能在读取时判断「要不要走迁移逻辑」。
   */
  readonly version?: number;
  readonly name?: string;
}

export class Schema<T extends Record<string, unknown>> {
  /** 字段顺序 = 定义顺序（写入和读取都按这个顺序） */
  readonly order: readonly string[];
  readonly version: number;
  readonly name: string;

  constructor(readonly fields: SchemaFields, opts: SchemaOptions = {}) {
    this.order = Object.keys(fields);
    this.version = opts.version ?? 0;
    this.name = opts.name ?? 'anon';

    /**
     * 【构造时校验：位宽上限】
     * `writeBits` 用 JS 的 32 位位运算，
     * 超过 32 位会静默溢出（(1<<33) === 1<<1）。
     * 这种错误极难发现——值写进去了，读出来是错的。
     */
    for (const k of this.order) {
      const f = fields[k] as FieldDef<unknown>;
      if (f.bits > 32) {
        throw new Error(`[Binary] 字段 ${k} 的位宽 ${f.bits} 超过 32，需拆成多个字段`);
      }
      if (f.bits < 0) throw new Error(`[Binary] 字段 ${k} 的位宽为负`);
    }
  }

  /** 定长部分的总位数（不含 string/raw） */
  get fixedBits(): number {
    let n = 0;
    for (const k of this.order) n += (this.fields[k] as FieldDef<unknown>).bits;
    return n;
  }

  /** 最少占用字节数（变长字段按下界 0 算） */
  get minBytes(): number {
    return Math.ceil(this.fixedBits / 8);
  }

  encode(obj: Partial<T>): Uint8Array {
    const w = new BitWriter();
    for (const k of this.order) {
      const f = this.fields[k] as FieldDef<unknown>;
      const v = obj[k as keyof T];
      f.write(w, v === undefined ? (f.default as unknown) : v);
    }
    return w.toBytes();
  }

  decode(bytes: Uint8Array): T {
    const r = new BitReader(bytes);
    const out: Record<string, unknown> = {};
    for (const k of this.order) {
      const f = this.fields[k] as FieldDef<unknown>;
      out[k] = f.read(r);
    }
    return out as T;
  }

  /** 人类可读的结构描述（调试用） */
  describe(): string {
    const lines = [`${this.name} v${this.version}（${this.minBytes}+ 字节）`];
    let bit = 0;
    for (const k of this.order) {
      const f = this.fields[k] as FieldDef<unknown>;
      const span = f.bits === 0 ? '变长' : `bit ${bit}..${bit + f.bits - 1}`;
      lines.push(`  ${k.padEnd(12)} ${f.describe.padEnd(28)} ${span}`);
      bit += f.bits;
    }
    return lines.join('\n');
  }
}

export function schema<T extends Record<string, unknown>>(
  fields: SchemaFields,
  opts?: SchemaOptions
): Schema<T> {
  return new Schema<T>(fields, opts);
}

// ==================== 位读写 ====================

export class BitWriter {
  private _bytes: number[] = [];
  private _cur = 0;      // 当前累积的位
  private _nbits = 0;    // _cur 里已有几位
  /** 已写入的总位数（调试用） */
  totalBits = 0;

  writeBits(value: number, bits: number): void {
    if (bits <= 0) return;
    if (bits > 32) {
      throw new Error(`[Binary] 单次写入 ${bits} 位超过 32，请先拆分`);
    }
    /**
     * 【⚠️ 无符号右移】
     * `value >>> 0` 把负数转成 32 位无符号。
     * 直接用 `value` 的话，-1 会写成 0xFFFFFFFF 的低 bits 位，
     * 语义上"应该是最大值"却变成了 1（当 bits=1 时）。
     * 调用方应该自己做好偏移（见 int() 的实现），
     * 这里的 >>> 0 是最后一道保险。
     */
    /**
     * 【⚠️ 超出 32 位的值必须拒绝，不能靠 `>>> 0` 静默截断】
     *
     * `>>> 0` 会把 `0x1_FFFF_FFFF` 变成 `0xFFFF_FFFF`——
     * 存进去一个值，读出来另一个，且不报错。
     * 与上面"存 300 读出 44"是同一类灾难，只是位数更大。
     *
     * 实测（加校验前）：`writeBits(0x1FFFFFFFF, 32)` 不抛错，
     * 而读出来是 0xFFFFFFFF。
     *
     * 【为什么只校验原值，不校验 `>>> 0` 的结果】
     * 负数走 `>>> 0` 是**有意**的（见下方注释：把有符号映射到无符号），
     * `-1` 应当合法地写成全 1。所以这里拦的是"本来就不该出现的值"，
     * 不是"`>>> 0` 之后越界的值"。
     */
    if (!Number.isFinite(value)) {
      throw new Error(`[Binary] writeBits 的值必须是有限数，收到 ${value}`);
    }
    if (value < 0 && Number.isFinite(value) && Math.floor(value) === value) {
      // 负整数合法（由 >>> 0 映射为无符号），放行
    } else if (value > 0xffffffff || value < -0x100000000) {
      throw new Error(`[Binary] 值 ${value} 超出 32 位可表示范围`);
    }

    let v = value >>> 0;

    /**
     * 【区间校验】越界值静默截断是灾难——存进去 300，读出来 44
     *
     * 【⚠️ 为什么 32 位要单独处理】
     * `1 << 32` 在 JS 里**等于 `1 << 0` = 1**（位移量按 5 位掩码），
     * 于是原判断退化成 `v >= 1`，对任何 ≥1 的值都抛错——
     * 这是"该通过的全被拒"。
     * 而 bits=32 时任何 uint32 都是合法的，本来就不该校验。
     */
    /**
     * 【⚠️ 阈值本身也要用乘方：`1 << 31` 是负数】
     *
     * 修复前 `v >= 1 << bits` 在 bits=31 时等价于 `v >= -2147483648` ——
     * 对任何 ≥ -2147483648 的值都成立，于是 **bits=31 写任何值都抛错**
     * （实测：`BitWriter.writeBits(1, 31)` → "值 1 需要超过 31 位表示"）。
     * 这正是 uint(31)/int(31) 即使修好了上界也仍然写不进去的第二道锁。
     */
    if (bits < 32 && v >= Math.pow(2, bits)) {
      throw new Error(`[Binary] 值 ${value} 需要超过 ${bits} 位表示`);
    }

    /**
     * 【⚠️ bits === 32 必须拆成两次 16 位写入】
     *
     * 原实现 `this._cur = ((this._cur << bits) | v) >>> 0`：
     * **`_cur << 32` 在 JS 里等于 `_cur << 0`，即 `_cur` 本身**
     * （位移量被按 5 位掩码，`32 & 31 === 0`）。
     * 于是 32 位写入不是"左移 32 位后或上 v"，
     * 而是"把 v **直接或进**当前的 _cur"。
     *
     * 字节对齐时 `_cur` 恰好为 0，结果碰巧正确——
     * 这就是它长期没被发现的原因。
     * 非对齐时 `_cur` 里有残留位，两者被 OR 到一起 → **数据静默损坏**。
     *
     * 实测（修复前）：先写 1 位制造非对齐，再写 `0x12345678`（32 位）
     * → 读回 `0x12345679`；字节对齐时同样的值读回正确。
     *
     * 后果是存档/网络包在特定字段组合下**随机损坏**：
     * 是否出错取决于前面字段的总位数是否为 8 的倍数，
     * 改一个字段的长度就会让另一个字段开始出错。
     *
     * 【为什么拆成两个 16 位而不是用乘法】
     * `_cur * 2**32` 会超出 32 位整数范围（进入双精度浮点），
     * 与这里"全程 32 位整数运算"的假设冲突。
     * 拆成 16+16 每次位移都 < 32，安全且语义不变。
     */
    if (bits === 32) {
      this.writeBits(v >>> 16, 16);
      this.writeBits(v & 0xffff, 16);
      return;
    }

    this._cur = ((this._cur << bits) | v) >>> 0;
    this._nbits += bits;
    this.totalBits += bits;

    while (this._nbits >= 8) {
      this._nbits -= 8;
      this._bytes.push((this._cur >>> this._nbits) & 0xff);
      // 只保留剩余有效位，避免 _cur 无限增长
      if (this._nbits === 0) this._cur = 0;
      else this._cur = this._cur & ((1 << this._nbits) - 1);
    }
  }

  /** 补齐最后一个字节 */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this._bytes.length + (this._nbits > 0 ? 1 : 0));
    out.set(this._bytes, 0);
    if (this._nbits > 0) {
      // 剩余位左对齐到字节高位
      out[this._bytes.length] = (this._cur << (8 - this._nbits)) & 0xff;
    }
    return out;
  }

  get bitLength(): number {
    return this.totalBits;
  }
}

export class BitReader {
  private _pos = 0;   // 当前位偏移

  constructor(private readonly _bytes: Uint8Array) {}

  get position(): number {
    return this._pos;
  }

  get remainingBits(): number {
    return this._bytes.length * 8 - this._pos;
  }

  readBits(bits: number): number {
    if (bits <= 0) return 0;
    if (bits > 32) throw new Error(`[Binary] 单次读取 ${bits} 位超过 32`);
    if (this._pos + bits > this._bytes.length * 8) {
      throw new Error(
        `[Binary] 数据不足：需要 ${bits} 位，只剩 ${this.remainingBits} 位`
      );
    }

    let out = 0;
    for (let i = 0; i < bits; i++) {
      const p = this._pos + i;
      const byte = this._bytes[p >> 3] ?? 0;
      const bit = (byte >>> (7 - (p & 7))) & 1;
      out = (out << 1) | bit;
    }
    this._pos += bits;
    return out >>> 0;
  }
}

// ==================== 数组 / 记录集 ====================

/**
 * 定长记录数组
 *
 * 【用途】200 个敌人的状态、1000 个格子的地形——
 * 这类"很多条结构相同的数据"是存档体积的大头。
 */
export class RecordArray<T extends Record<string, unknown>> {
  constructor(
    private readonly _schema: Schema<T>,
    /** 条数上限（决定长度前缀的位宽） */
    private readonly _maxCount = 65535
  ) {}

  encode(items: readonly Partial<T>[]): Uint8Array {
    if (items.length > this._maxCount) {
      throw new Error(`[Binary] 数组长度 ${items.length} 超过上限 ${this._maxCount}`);
    }
    const lenBits = Math.max(1, Math.ceil(Math.log2(this._maxCount + 1)));

    const w = new BitWriter();
    w.writeBits(items.length, lenBits);
    for (const it of items) {
      for (const k of this._schema.order) {
        const f = this._schema.fields[k] as FieldDef<unknown>;
        const v = (it as Record<string, unknown>)[k];
        f.write(w, v === undefined ? f.default : v);
      }
    }
    return w.toBytes();
  }

  decode(bytes: Uint8Array): T[] {
    const lenBits = Math.max(1, Math.ceil(Math.log2(this._maxCount + 1)));
    const r = new BitReader(bytes);
    const n = r.readBits(lenBits);
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      const rec: Record<string, unknown> = {};
      for (const k of this._schema.order) {
        const f = this._schema.fields[k] as FieldDef<unknown>;
        rec[k] = f.read(r);
      }
      out.push(rec as T);
    }
    return out;
  }
}

// ==================== 工具 ====================

/** UTF-8 编码（不依赖 TextEncoder，便于在纯 JS 环境跑） */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);

    // 代理对：合成真正的码点
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }

    /**
     * 【⚠️ 孤立代理项会输出 WTF-8（不被任何标准 UTF-8 解码器接受）】
     *
     * 上面的合成只在"高代理 + 紧跟低代理"时成功。
     * 字符串里只剩半个代理对时（字符串被截断、`s[i]` 单取一个 char、
     * 外部数据拼错），`c` 仍落在 0xd800..0xdfff，
     * 修复前会走 `c < 0x10000` 分支输出三字节 **ed a0 80**——
     * 这是 WTF-8，标准解码器会判为非法序列直接拒绝整段数据。
     *
     * 改成输出 U+FFFD（ef bf bd）：**同样是 3 字节**，
     * 所以 `string(maxBytes)` 的字节数预算不变，但产出的是合法 UTF-8。
     */
    if (c >= 0xd800 && c <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd);
      continue;
    }

    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(
      0xf0 | (c >> 18),
      0x80 | ((c >> 12) & 0x3f),
      0x80 | ((c >> 6) & 0x3f),
      0x80 | (c & 0x3f)
    );
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let cp: number;
    let len: number;

    if (b0 < 0x80) { cp = b0; len = 1; }
    else if ((b0 & 0xe0) === 0xc0) { cp = b0 & 0x1f; len = 2; }
    else if ((b0 & 0xf0) === 0xe0) { cp = b0 & 0x0f; len = 3; }
    else if ((b0 & 0xf8) === 0xf0) { cp = b0 & 0x07; len = 4; }
    /**
     * 【⚠️ 曾经静默跳过：`i++; continue;` 把一个字节丢了还不吭声】
     *
     * 实测（修复前）：`utf8Decode([0x41, 0xff, 0x42])` → `"AB"`。
     * 0xff 被无声丢弃，调用方拿到一段"看起来正常"的短字符串——
     * 存档里的乱码昵称、被截断的道具 id 就都长这样，
     * 而且**没有任何痕迹**可以查（长度差 1 谁也不会注意）。
     *
     * 改成产出 U+FFFD 替换字符：字节数对得上，肉眼可见"这里坏过"。
     */
    else { out += '\ufffd'; i++; continue; }

    if (i + len > bytes.length) {
      // 数据被截断：同样要留痕，不能静默结束
      out += '\ufffd';
      break;
    }

    for (let k = 1; k < len; k++) {
      cp = (cp << 6) | (bytes[i + k] & 0x3f);
    }
    i += len;

    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

/** 转成十六进制（调试 / 日志用） */
export function toHex(bytes: Uint8Array, limit = 64): string {
  const n = Math.min(bytes.length, limit);
  let s = '';
  for (let i = 0; i < n; i++) {
    s += bytes[i].toString(16).padStart(2, '0') + ' ';
  }
  if (bytes.length > n) s += `… (+${bytes.length - n}B)`;
  return s.trim();
}
