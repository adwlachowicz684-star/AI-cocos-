import { clampNum } from '../_core/math';
/**
 * Expression —— 表达式求值器
 *
 * 【它解决什么】
 *
 * 配置表里写死数值很快就不管用了：
 * ```
 * damage: 100                // 第 10 层还是 100？
 * damage: 100 + level * 15   // ← 想要这个
 * ```
 *
 * 于是你会开始在每个读取配置的地方 if-else 拼公式，
 * 最后公式散落在几十个文件里，策划改一个数要找程序员。
 *
 * 表达式求值器让公式变成**配置的一部分**：
 * - 策划能直接在表里写公式
 * - 热重载后立刻生效（不用重新编译）
 * - 公式集中管理，能统一检查
 *
 * 【安全边界：这不是通用的 JS 求值器】
 *
 * **绝对不要用 `eval()` 或 `new Function()`**，因为：
 * - 配置可能来自网络/玩家（RCE 风险）
 * - 无法控制它能访问什么
 * - 出错时堆栈完全看不懂
 *
 * 本实现是自己写的词法+语法分析，**只能做数学和变量查找**，
 * 不能调用函数、不能访问对象、不能有任何副作用。
 *
 * 【支持的语法】
 * ```
 * 数字      100, 3.14, -5
 * 变量      level, player.atk, $hp
 * 运算      + - * / % ^
 * 比较      > >= < <= == !=
 * 逻辑      && || !
 * 括号      (a + b) * c
 * 三元      cond ? a : b
 * 函数      min() max() abs() floor() ceil() round() sqrt() clamp() lerp()
 * ```
 *
 * 【使用示例】
 * ```typescript
 * const expr = new Expression('100 + level * 15');
 * expr.evaluate({ level: 10 });        // 250
 *
 * // 点号路径
 * const e2 = new Expression('player.atk * (1 + buff.str)');
 * e2.evaluate({ player: { atk: 50 }, buff: { str: 0.3 } });   // 65
 *
 * // 复用（编译一次，多次求值）
 * for (const enemy of enemies) {
 *   enemy.hp = expr.evaluate({ level: enemy.level });
 * }
 *
 * // 语法错误在构造时抛出
 * new Expression('1 +');        // 抛错：表达式不完整
 * new Expression('foo(');       // 抛错：缺少右括号
 * ```
 *
 * 【无引擎依赖】
 */

type TokenType = 'num' | 'var' | 'op' | 'lparen' | 'rparen' | 'comma' | 'question' | 'colon';

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly pos: number;
}

/** AST 节点 */
type Node =
  | { kind: 'num'; value: number }
  | { kind: 'var'; path: string[] }
  | { kind: 'unary'; op: string; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'cond'; test: Node; consequent: Node; alternate: Node }
  | { kind: 'call'; name: string; args: Node[] };

/** 默认的 AST 深度上限，见 `ExpressionOptions.maxDepth` */
export const DEFAULT_MAX_DEPTH = 1000;

/**
 * 计算 AST 深度
 *
 * 【为什么不用递归】
 * 这里本身就是为了防止递归过深而存在的，
 * 如果它自己也用递归，那深到一定程度它自己先炸了——
 * 防护逻辑不能和被防护的对象有同样的失效模式。
 */
function astDepth(root: Node): number {
  let max = 0;
  // 显式栈：(节点, 当前深度)
  const stack: Array<{ node: Node; d: number }> = [{ node: root, d: 1 }];
  while (stack.length > 0) {
    const { node, d } = stack.pop()!;
    if (d > max) max = d;
    switch (node.kind) {
      case 'unary':
        stack.push({ node: node.operand, d: d + 1 });
        break;
      case 'binary':
        stack.push({ node: node.left, d: d + 1 });
        stack.push({ node: node.right, d: d + 1 });
        break;
      case 'cond':
        stack.push({ node: node.test, d: d + 1 });
        stack.push({ node: node.consequent, d: d + 1 });
        stack.push({ node: node.alternate, d: d + 1 });
        break;
      case 'call':
        for (const a of node.args) stack.push({ node: a, d: d + 1 });
        break;
    }
  }
  return max;
}

const BUILTIN: Record<string, (...a: number[]) => number> = {
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  abs: (a) => Math.abs(a),
  floor: (a) => Math.floor(a),
  ceil: (a) => Math.ceil(a),
  round: (a) => Math.round(a),
  sqrt: (a) => Math.sqrt(a),
  pow: (a, b) => Math.pow(a, b),
  clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
  lerp: (a, b, t) => a + (b - a) * t,
  sign: (a) => Math.sign(a),
  // 游戏常用
  pct: (v, p) => v * (p / 100),
};

/**
 * 非 strict 模式下的"静默降级"告警出口
 *
 * 【为什么需要它】
 * `evaluate()` 是宽松入口：未定义变量、null、`[]` 一律当 0。
 * 这是刻意的（配置里常常引用"现在还没设置"的变量，抛错会让整张表加载失败），
 * 但代价是**拼错变量名 = 算出一个偏小的数字，且不报错**——
 * 伤害公式、掉落权重静默偏低，属于最难查的那类错误。
 *
 * `evaluateStrict()` 能查出来，但默认入口是宽松的那个，
 * 于是多数的配置错误走的是"永远没人知道"的路径。
 * 这里给一个出口，让宿主接上自己的 Logger：
 *
 * ```typescript
 * setExpressionWarningHandler((m) => logger.warn(m));
 * // 卸载（铁律：有 install 必有 uninstall）
 * setExpressionWarningHandler(null);
 * ```
 *
 * 【为什么默认静默，不直接 console.warn】
 * 表达式是**每帧**求值的，默认打印会在一秒内刷满日志，
 * 结果就是没人看日志。宿主主动接才输出，且每个表达式每个键只报一次（见 `_warned`）。
 *
 * 【为什么只告警不改返回值】
 * 把"未定义变量"改成抛错会让既有配置全线加载失败，属于 breaking；
 * 宽松语义本身是有意的设计，这里只补上"留痕"，不改变数值。
 */
export type ExpressionWarnHandler = (message: string) => void;

let _warnHandler: ExpressionWarnHandler | null = null;

/**
 * 设置（或卸载）告警处理器
 *
 * @param h 处理函数；传 `null` 恢复默认（静默）
 */
export function setExpressionWarningHandler(h: ExpressionWarnHandler | null): void {
  _warnHandler = h;
}

/** 求值上下文（递归时透传，避免每层重建） */
interface EvalContext {
  readonly vars: Record<string, unknown>;
  readonly strict: boolean;
  /** 已告警过的键（去重：同名问题只报一次） */
  readonly warned: Set<string>;
}

function warnOnce(ctx: EvalContext, detail: string): void {
  if (!_warnHandler) return;
  if (ctx.warned.has(detail)) return;
  ctx.warned.add(detail);
  _warnHandler(`[Expression] ${detail}`);
}

/** 运算符优先级（数字大的先结合） */
const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '>': 4, '>=': 4, '<': 4, '<=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
  '^': 7,
};

/**
 * 表达式构造选项
 */
export interface ExpressionOptions {
  /**
   * 最大嵌套深度（默认 **1000**）
   *
   * 【为什么要有这个限制】
   * 解析与求值都是递归实现，超深表达式会抛
   * `RangeError: Maximum call stack size exceeded`。
   * 那个错误**看不出是什么导致的**，也**不告诉你超了多少**，
   * 排查起来毫无抓手。这里改成主动检查并给出明确报错。
   *
   * 【为什么是 1000，而不是实测上限】
   * 实测上限会漂：嵌套括号在两次测量里分别卡在 **2147** 和 **4561**
   * （取决于 JIT 状态与调用上下文），**差 2 倍**。
   * 所以任何"N 项以下安全"的文档结论都不可靠——
   * 只能自己设一条远低于运行时极限的线。
   *
   * 1000 的取值依据：配置表通常 < 50 项，留了 20 倍余量，
   * 且低于实测最低值 2147 的一半。
   *
   * 【什么时候要调大】
   * 表达式来自 UGC / mod / 关卡编辑器自动生成时，
   * 长度可能失控。这时应该**在源头限制**，而不是把这里调大——
   * 调大只是把崩溃点往后推，迟早还是会撞上。
   */
  readonly maxDepth?: number;
}

export class Expression {
  private readonly _source: string;
  private readonly _ast: Node;
  private readonly _maxDepth: number;
  /** 已告警过的键（每个实例一份，保证"同一个问题只报一次"） */
  private readonly _warned = new Set<string>();

  constructor(source: string, opts: ExpressionOptions = {}) {
    this._source = source;
    this._maxDepth = clampNum(opts.maxDepth, 1, 1e4, DEFAULT_MAX_DEPTH);
    const tokens = tokenize(source);
    if (tokens.length === 0) throw new Error('[Expression] 表达式为空');
    const parser = new Parser(tokens, source, this._maxDepth);
    this._ast = parser.parse();
    // 【为什么解析后还要再测一次 AST 深度】
    // 扁平长式（1+1+1+...）在解析阶段是循环，不会递归，
    // 于是解析能过；但它生成的 AST 是左深的，求值时会一路递归到左叶子，
    // 在 ~4330 项时栈溢出。这一行把拦截点提前到构造时。
    const depth = astDepth(this._ast);
    if (depth > this._maxDepth) {
      throw new Error(
        `[Expression] 表达式过深：AST 深度 ${depth} 超过上限 ${this._maxDepth}。` +
        `长式请拆成多个变量，或检查是否由程序生成了失控的拼接。`
      );
    }
  }

  /** 实际生效的深度上限（排查时用） */
  get maxDepth(): number {
    return this._maxDepth;
  }

  get source(): string {
    return this._source;
  }

  /**
   * 求值
   *
   * @param vars 变量表。支持点号路径（`player.atk` → vars.player.atk）
   * @returns 数值
   *
   * 【坑：未定义变量】
   * 默认当作 0，而不是抛错。理由：配置里经常会引用"当前还没设置"的变量
   * （比如 buff 还没加上的加成），抛错会让整张表加载失败。
   *
   * 如果你希望严格模式，用 `evaluateStrict()`。
   */
  evaluate(vars: Record<string, unknown> = {}): number {
    return evalNode(this._ast, { vars, strict: false, warned: this._warned });
  }

  /** 严格求值：遇到未定义变量抛错（用于校验配置） */
  evaluateStrict(vars: Record<string, unknown> = {}): number {
    return evalNode(this._ast, { vars, strict: true, warned: this._warned });
  }

  /**
   * 列出表达式用到的所有变量名
   *
   * 【用途】
   * 启动时检查："这个公式用了变量 `critRate`，但没有任何地方设置过它"——
   * 否则它会永远是 0，而且没有任何报错。
   */
  variables(): string[] {
    const out = new Set<string>();
    collectVars(this._ast, out);
    return Array.from(out);
  }

  toString(): string {
    return this._source;
  }
}

// ============================================================
// 词法分析
// ============================================================

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    // 空白
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // 数字
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      // 科学计数法
      if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] ?? '')) {
        j += 2;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      out.push({ type: 'num', value: src.substring(i, j), pos: i });
      i = j;
      continue;
    }

    // 变量 / 函数名：字母、下划线、$、点
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_$.]/.test(src[j])) j++;
      out.push({ type: 'var', value: src.substring(i, j), pos: i });
      i = j;
      continue;
    }

    // 多字符运算符
    const two = src.substring(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
      out.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }

    // 单字符
    if ('+-*/%^<>!'.includes(ch)) {
      // 区分一元负号：前面是运算符/左括号/逗号/三元符号/开头时是一元
      const prev = out[out.length - 1];
      /**
       * 【⚠️ `?` 和 `:` 后面也必须允许一元负号】
       *
       * 前导集合里漏了 `question` / `colon` 两种 token 时，
       * `hp > 0 ? -dmg : 0` 里的 `-` 被当成**二元**运算符，
       * 走到 `parsePrimary()` 抛 `意外的符号 "-"（位置 9）`。
       *
       * 这个错误信息的杀伤力在于：
       * 它指向 `-` 的位置，与"三元"毫无字面关联；
       * 而 `1 ? 5 : 7`（正数分支）完全正常，
       * 于是现象变成"只有带负号的公式才解析失败"，
       * 很容易被误判成"负号不支持"而不是"三元里的负号不支持"。
       *
       * 配置驱动的场景下必然踩到：扣血、减速、反向修正——全是负值，
       * 而抛错发生在 `new Expression()`，
       * 表层现象是"配了一张表，模块初始化直接失败"。
       */
      const isUnary =
        ch === '-' &&
        (prev === undefined ||
          prev.type === 'op' ||
          prev.type === 'lparen' ||
          prev.type === 'comma' ||
          prev.type === 'question' ||
          prev.type === 'colon');

      out.push({ type: 'op', value: isUnary ? 'neg' : ch, pos: i });
      i++;
      continue;
    }

    if (ch === '(') { out.push({ type: 'lparen', value: ch, pos: i }); i++; continue; }
    if (ch === ')') { out.push({ type: 'rparen', value: ch, pos: i }); i++; continue; }
    if (ch === ',') { out.push({ type: 'comma', value: ch, pos: i }); i++; continue; }
    if (ch === '?') { out.push({ type: 'question', value: ch, pos: i }); i++; continue; }
    if (ch === ':') { out.push({ type: 'colon', value: ch, pos: i }); i++; continue; }

    throw new Error(`[Expression] 无法识别的字符 "${ch}"（位置 ${i}）`);
  }

  return out;
}

// ============================================================
// 语法分析（递归下降）
// ============================================================

class Parser {
  private _pos = 0;
  private _depth = 0;

  constructor(
    private readonly _tokens: readonly Token[],
    private readonly _src: string,
    private readonly _maxDepth: number
  ) {}

  /**
   * 进入一层递归
   *
   * 【为什么要手动计数，而不依赖栈溢出】
   * 递归下降在遇到 `((((...))))` 时会一直嵌套，
   * 直到 V8 抛 `RangeError: Maximum call stack size exceeded`。
   * 那个错**不告诉你超了多少、也不告诉你在哪一层**，
   * 而且阈值本身会随 JIT 状态漂移（实测 2147 ~ 4561）。
   * 主动计数能把崩溃换成一句能看懂的报错。
   */
  private enter(): void {
    if (++this._depth > this._maxDepth) {
      throw new Error(
        `[Expression] 表达式嵌套过深（超过 ${this._maxDepth} 层）。` +
        `递归下降解析在 "${this._src.slice(0, 40)}${this._src.length > 40 ? '...' : ''}" 处放弃。`
      );
    }
  }

  private leave(): void {
    this._depth--;
  }

  private peek(): Token | undefined {
    return this._tokens[this._pos];
  }

  private next(): Token | undefined {
    return this._tokens[this._pos++];
  }

  private expect(type: TokenType, what: string): Token {
    const t = this.next();
    if (!t || t.type !== type) {
      throw new Error(`[Expression] 缺少${what}（在 "${this._src}" 位置 ${t?.pos ?? this._src.length}）`);
    }
    return t;
  }

  parse(): Node {
    const node = this.parseTernary();
    const rest = this.peek();
    if (rest) {
      throw new Error(`[Expression] 多余的内容 "${rest.value}"（位置 ${rest.pos}）`);
    }
    return node;
  }

  /** 三元：cond ? a : b */
  private parseTernary(): Node {
    this.enter();
    try {
      const test = this.parseBinary(0);
      const t = this.peek();
      if (t?.type === 'question') {
        this.next();
        const consequent = this.parseTernary();
        this.expect('colon', '":"');
        const alternate = this.parseTernary();
        return { kind: 'cond', test, consequent, alternate };
      }
      return test;
    } finally {
      this.leave();
    }
  }

  /** 二元运算（优先级爬升） */
  private parseBinary(minPrec: number): Node {
    // 【为什么这里也要计数】
    // 左结合运算符（+ - * / 等）走 `for(;;)` 循环，确实不递归，
    // 所以扁平长式 `1+1+1+...` 在这里深度恒为 1，不会被误伤。
    // 但 **`^` 是右结合的**：`2^2^2^2...` 会在这里一路递归调用自身，
    // 且**不经过 parseTernary**。只给 parseTernary 计数会漏掉这条路径。
    this.enter();
    try {
    let left = this.parseUnary();

    for (;;) {
      const t = this.peek();
      if (!t || t.type !== 'op') break;
      const prec = PRECEDENCE[t.value];
      if (prec === undefined || prec < minPrec) break;

      this.next();
      // ^ 右结合，其余左结合
      const nextMin = t.value === '^' ? prec : prec + 1;
      const right = this.parseBinary(nextMin);
      left = { kind: 'binary', op: t.value, left, right };
    }

    return left;
    } finally {
      this.leave();
    }
  }

  private parseUnary(): Node {
    // 【为什么这里也要计数】
    // `!!!!...x` 或 `----x` 会在 parseUnary 里自我递归，
    // 同样不经过 parseTernary。
    this.enter();
    try {
    const t = this.peek();

    if (t?.type === 'op' && (t.value === 'neg' || t.value === '!')) {
      this.next();
      return { kind: 'unary', op: t.value, operand: this.parseUnary() };
    }

    return this.parsePrimary();
    } finally {
      this.leave();
    }
  }

  private parsePrimary(): Node {
    const t = this.next();
    if (!t) throw new Error(`[Expression] 表达式不完整："${this._src}"`);

    if (t.type === 'num') {
      const v = Number(t.value);
      if (!Number.isFinite(v)) throw new Error(`[Expression] 无效数字 "${t.value}"`);
      return { kind: 'num', value: v };
    }

    if (t.type === 'var') {
      // 函数调用
      if (this.peek()?.type === 'lparen') {
        this.next();
        const args: Node[] = [];
        if (this.peek()?.type !== 'rparen') {
          for (;;) {
            args.push(this.parseTernary());
            if (this.peek()?.type === 'comma') {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expect('rparen', '右括号")"');
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'var', path: t.value.split('.') };
    }

    if (t.type === 'lparen') {
      const inner = this.parseTernary();
      this.expect('rparen', '右括号")"');
      return inner;
    }

    throw new Error(`[Expression] 意外的符号 "${t.value}"（位置 ${t.pos}）`);
  }
}

// ============================================================
// 求值
// ============================================================

function evalNode(node: Node, ctx: EvalContext): number {
  switch (node.kind) {
    case 'num':
      return node.value;

    case 'var': {
      let cur: unknown = ctx.vars;
      for (const key of node.path) {
        if (cur === null || cur === undefined || typeof cur !== 'object') {
          cur = undefined;
          break;
        }
        cur = (cur as Record<string, unknown>)[key];
      }

      if (cur === undefined) {
        if (ctx.strict) {
          throw new Error(`[Expression] 未定义的变量：${node.path.join('.')}`);
        }
        /**
         * 【⚠️ 非 strict 下"未定义变量"不能和"值确实是 0"混为一谈】
         *
         * 二者返回值都是 0，但含义完全相反：
         * 一个是"配置里拼错了名字"，一个是"这个加成现在确实是 0"。
         * 不区分的话，拼错变量名表现为"算出一个偏小的数字"，
         * 伤害公式、掉落权重静默偏低，且没有任何报错。
         *
         * 返回值仍是 0（宽松语义是刻意设计，改成抛错会 breaking），
         * 但至少让宿主能接到一条告警——见 `setExpressionWarningHandler`。
         */
        warnOnce(ctx, `未定义的变量：${node.path.join('.')}（非 strict 模式下当作 0）`);
        return 0;
      }

      const n = typeof cur === 'number' ? cur : Number(cur);

      /**
       * 【⚠️ null / [] / 布尔 也要留痕】
       * `Number(null) === 0`、`Number([]) === 0`、`Number('') === 0`——
       * 这三个恰好是"配置缺失"最常见的形态，走 `Number()` 之后
       * 和真的填了 0 **完全无法区分**（`Number(true) === 1` 同理）。
       * 值仍然返回 0，只补一条告警。
       */
      if (typeof cur !== 'number' && typeof cur !== 'string') {
        warnOnce(
          ctx,
          `变量 ${node.path.join('.')} 不是数字（${JSON.stringify(cur) ?? typeof cur}），当作 ${n} 参与运算`
        );
      }

      if (!Number.isFinite(n)) {
        if (ctx.strict) {
          throw new Error(`[Expression] 变量 ${node.path.join('.')} 不是有效数字`);
        }
        warnOnce(ctx, `变量 ${node.path.join('.')} 的值不是有限数（${String(cur)}），当作 0`);
        return 0;
      }
      return n;
    }

    case 'unary': {
      const v = evalNode(node.operand, ctx);
      return node.op === 'neg' ? -v : v === 0 ? 1 : 0;
    }

    case 'binary':
      return evalBinary(node.op, evalNode(node.left, ctx), evalNode(node.right, ctx));

    case 'cond':
      return evalNode(node.test, ctx) !== 0
        ? evalNode(node.consequent, ctx)
        : evalNode(node.alternate, ctx);

    case 'call': {
      /**
       * 【⚠️ 查表必须只认自有属性】
       *
       * `BUILTIN[node.name]` 会命中 `Object.prototype`：
       * `BUILTIN['toString']` 取到 `Object.prototype.toString`——它确实是个函数，
       * `!fn` 判定通过，于是"成功调用"了它。
       *
       * 实测：`new Expression('toString()').evaluate({})` 抛
       * `函数 toString() 的结果不是有限数：[object Undefined]`
       * ——错误信息指向"结果不是数字"，而真正的错误是"这个函数压根不存在"，
       * 排查方向被彻底带偏。（`[object Undefined]` 正是
       * `Object.prototype.toString.call(undefined)` 的产物。）
       *
       * 表达式名字来自配置（外部输入），`constructor` / `valueOf` / `hasOwnProperty`
       * 都在可写范围内；命中 `hasOwnProperty` 时甚至抛的是
       * `Cannot convert undefined or null to object`——一句与表达式毫无关系的话。
       *
       * 这是"裸 Record 查表"原型链污染的典型实例，与 `easing()` 那次同源。
       */
      const fn = Object.prototype.hasOwnProperty.call(BUILTIN, node.name)
        ? BUILTIN[node.name]
        : undefined;
      if (!fn) {
        throw new Error(
          `[Expression] 未知函数 "${node.name}"。可用：${Object.keys(BUILTIN).join(', ')}`
        );
      }
      const args = node.args.map((a) => evalNode(a, ctx));
      const out = fn(...args);

      /**
       * 【为什么函数结果必须校验有限性】
       *
       * `Math.max()` 无参数时返回 **`-Infinity`**，`Math.min()` 返回 **`Infinity`**，
       * 而 `abs()` / `sqrt()` 等缺参数时返回 **NaN**。
       *
       * 这些值一旦流进配置（比如 `max() * 0` → NaN、`max() > 100` → 恒 false），
       * 症状是"某个分支永远不走"，而排查时没人会想到源头是配置表里少写了个参数。
       *
       * 这里统一在出口拦掉：非有限数直接抛错，把问题钉在**写错的表达式**上，
       * 而不是让它变成一小时后某个莫名其妙的现象。
       *
       * 【为什么不静默返回 0】返回 0 是"看起来正常但值错了"，比抛错更难查。
       */
      if (!Number.isFinite(out)) {
        throw new Error(
          `[Expression] 函数 ${node.name}(${args.join(', ')}) 的结果不是有限数：${out}` +
            `（常见原因：参数缺失或参数为 NaN/Infinity。` +
            `${node.name === 'max' || node.name === 'min' ? '注意 Math.' + node.name + '() 无参数会返回 ±Infinity。' : ''}）`
        );
      }
      return out;
    }
  }
}

function evalBinary(op: string, a: number, b: number): number {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/':
      /**
       * 【为什么除零返回 0 而不是 Infinity/NaN】
       * 配置里的公式可能除以一个还没初始化的变量。
       * NaN 会沿着伤害管线传播，最后表现为"打怪没伤害"——
       * 排查起来要顺着管线追十几层。返回 0 至少是可预测的。
       *
       * 需要严格检查时用 evaluateStrict + 显式校验。
       */
      return b === 0 ? 0 : a / b;
    case '%': return b === 0 ? 0 : a % b;
    case '^': return Math.pow(a, b);
    case '>': return a > b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    case '<': return a < b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '==': return a === b ? 1 : 0;
    case '!=': return a !== b ? 1 : 0;
    case '&&': return a !== 0 && b !== 0 ? 1 : 0;
    case '||': return a !== 0 || b !== 0 ? 1 : 0;
    default:
      throw new Error(`[Expression] 未知运算符 "${op}"`);
  }
}

function collectVars(node: Node, out: Set<string>): void {
  switch (node.kind) {
    case 'var':
      out.add(node.path.join('.'));
      break;
    case 'unary':
      collectVars(node.operand, out);
      break;
    case 'binary':
      collectVars(node.left, out);
      collectVars(node.right, out);
      break;
    case 'cond':
      collectVars(node.test, out);
      collectVars(node.consequent, out);
      collectVars(node.alternate, out);
      break;
    case 'call':
      for (const a of node.args) collectVars(a, out);
      break;
    case 'num':
      break;
  }
}
