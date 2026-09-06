/**
 * _core/string.ts —— 字符串工具（纯函数、零依赖）
 *
 * 【为什么要有这个文件】
 * 编辑距离算法在库里曾经有三份实现：
 *
 * | 模块 | 函数 | 返回值语义 |
 * |---|---|---|
 * | `cheatcode` | `levenshtein(a, b)` | **距离**，整数，越小越像 |
 * | `debug-console` | `similarity(a, b)` | **相似度**，0~1，越大越像 |
 * | `di` | `editDistance(a, b)` | **距离**，整数，越小越像 |
 *
 * 三份算法主体完全一样（都是滚动数组的 Levenshtein），
 * 但**返回值方向相反**——拿距离当相似度用，结果会完全颠倒。
 * 而且 `di` 那份是私有的，另两份是公开的，修 bug 只能修到一半。
 *
 * 现在统一到这里，三个模块改为委托调用，对外函数名保持不变。
 *
 * 【⚠️ 距离和相似度是相反的方向，别搞混】
 *
 * ```
 * "setgold" vs "setgld"  →  editDistance = 1   similarity = 0.857
 * "godmode" vs "godmod"  →  editDistance = 1   similarity = 0.857
 * "abc"     vs "abc"     →  editDistance = 0   similarity = 1.000
 * ```
 */

/**
 * 编辑距离（Levenshtein）
 *
 * @returns 距离，整数，**越小越像**。0 = 完全相同。
 *
 * 【实现】滚动数组，空间 O(min(len))；短的字符串放内层，进一步省空间。
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // 让 b 是较短的那个，减少空间占用
  if (b.length > a.length) {
    const t = a;
    a = b;
    b = t;
  }

  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        prev[j] + 1, // 删除
        cur[j - 1] + 1, // 插入
        prev[j - 1] + cost // 替换
      );
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length];
}

/**
 * 相似度（基于编辑距离归一化）
 *
 * @returns 0~1 的浮点数，**越大越像**。1 = 完全相同。
 *
 * 【为什么不是 `1 - dist / Math.max(la, lb)` 直接算】
 * 长度差太大时没必要跑 O(n×m) 的动态规划——
 * 差超过 60% 直接判 0，这是 debug-console 那版就有的优化，保留了下来。
 *
 * 【⚠️ 有这个提前返回，所以 similarity 和 editDistance 不是简单互转】
 * 长度差大的串：`similarity` 返回 0，但用 `1 - dist/max` 手算会是个小数。
 * 要距离就用 `editDistance`，要相似度就用 `similarity`，别自己换算。
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a === '' || b === '') return 0;

  const la = a.length;
  const lb = b.length;
  // 长度差太大直接判不相似，省一次 O(n*m)
  if (Math.abs(la - lb) > Math.max(la, lb) * 0.6) return 0;

  return 1 - editDistance(a, b) / Math.max(la, lb);
}

/**
 * 命令行分词：按空白切分，支持引号包裹与空参数
 *
 * 【语义（下沉时统一，原两份实现有分歧）】
 *
 * | 行为 | 说明 |
 * |---|---|
 * | 空白判定 | `\s`（含 `\n` `\r` `\f` `\v`、NBSP `\u00a0`、全角空格 `\u3000`） |
 * | 引号 | 单引号等价于双引号 |
 * | 空参数 | `give "" 1` → `['give', '', '1']`，**空串保留** |
 * | 未闭合引号 | 抛错（由 `onUnclosedQuote` 定制，各模块错误类型不同） |
 *
 * 【为什么统一用 `\s` 而不是只认空格/Tab】
 * 下沉前 `cheatcode` 只把 `' '` 和 `'\t'` 当分隔符，
 * `debug-console` 用 `/\s/`。实测分歧 6/10 用例：
 *
 * | 输入 | cheatcode（旧） | console（= 现在的统一行为） |
 * |---|---|---|
 * | `a\nb` | `['a\nb']` | `['a','b']` |
 * | `a\u00a0b` | `['a\u00a0b']` | `['a','b']` |
 * | `a\u3000b` | `['a\u3000b']` | `['a','b']` |
 *
 * 取 `\s` 的理由是**玩家会复制粘贴**：
 * 从网页 / Word 复制的文本常带 NBSP（不换行空格），
 * 只认空格的话 `god\u00a0mode` 会被当成一个 token，
 * 命令永远匹配不上，而且没有任何报错提示。
 *
 * 【破例】参数里真的需要空白符时用引号包起来：`say "a b"` → `['say','a b']`。
 */
export function tokenize(
  input: string,
  opts: { onUnclosedQuote?: (input: string) => Error } = {}
): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote: '"' | "'" | null = null;
  /** 当前 token 是否"存在"（用于区分空参数 `""` 和连续空白） */
  let hasContent = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      // 哪怕引号里是空的，这个 token 也算存在
      hasContent = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasContent || cur !== '') {
        out.push(cur);
        cur = '';
        hasContent = false;
      }
      continue;
    }

    cur += ch;
  }

  if (inQuote) {
    throw opts.onUnclosedQuote
      ? opts.onUnclosedQuote(input)
      : new Error(`[_core/string] 引号未闭合：${input}`);
  }

  if (hasContent || cur !== '') out.push(cur);
  return out;
}
