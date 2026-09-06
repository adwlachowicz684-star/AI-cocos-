import { clampNum } from '../_core/math';
import { assertSafePath } from '../_core/guard';
/**
 * Snapshot —— 状态快照 + 差异比对 + 回滚
 *
 * 【它解决什么】
 *
 * 三件事都要用到"记录某个时刻的状态"：
 *
 * **① 撤销/重做**（建造模式、捏脸、技能树加点）
 * 玩家点错了要能撤回，而且只撤那一步，不是全部重来。
 *
 * **② 存档的增量更新**
 * 大型存档（几百个对象）每次全量序列化很慢。
 * 只存变化的部分能快一个数量级。
 *
 * **③ 状态同步**（联机、回放）
 * 只发送变化的部分，而不是整个世界状态。
 *
 * 【设计：本类只做"值的快照"，不做序列化】
 * 快照 = 深拷贝的值树。怎么存（JSON / 二进制 / 网络）由调用方决定。
 *
 * 【使用示例】
 * ```typescript
 * // ① 撤销栈
 * const undo = new UndoStack<GameState>({ limit: 50 });
 * undo.push(currentState);          // 改动前记录
 * doSomething(currentState);
 * undo.push(currentState);
 *
 * const prev = undo.undo(currentState);   // 返回上一步的快照
 * applyState(prev);
 * const next = undo.redo(currentState);
 *
 * // ② 差异比对
 * const diff = diffSnapshots(oldState, newState);
 * // { changed: [{path:'player.hp', from:100, to:80}], added: [], removed: [] }
 *
 * // ③ 只存变化
 * const patch = createPatch(oldState, newState);
 * saveToDisk(patch);                     // 体积小得多
 * const restored = applyPatch(oldState, patch);
 * ```
 *
 * 【无引擎依赖】
 */

// ============================================================
// 深拷贝
// ============================================================

/**
 * 结构化深拷贝
 *
 * 【为什么不用 JSON.parse(JSON.stringify())】
 * - 丢失 undefined
 * - Date 变成字符串
 * - Map / Set 变成 {}
 * - **遇到循环引用直接抛异常**（游戏对象互相引用很常见）
 *
 * 【为什么不用 structuredClone】
 * 老环境没有。而且我们的快照只需要处理纯数据。
 */
export function deepClone<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;

  const asObj = value as unknown as object;
  if (seen.has(asObj)) return seen.get(asObj) as T;

  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(asObj, out);
    for (let i = 0; i < value.length; i++) out[i] = deepClone(value[i], seen);
    return out as unknown as T;
  }

  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    seen.set(asObj, out);
    for (const [k, v] of value) out.set(k, deepClone(v, seen));
    return out as unknown as T;
  }

  if (value instanceof Set) {
    const out = new Set<unknown>();
    seen.set(asObj, out);
    for (const v of value) out.add(deepClone(v, seen));
    return out as unknown as T;
  }

  const out: Record<string, unknown> = {};
  seen.set(asObj, out);
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out[k] = deepClone((value as Record<string, unknown>)[k], seen);
  }
  return out as T;
}

// ============================================================
// 差异比对
// ============================================================

export interface DiffEntry {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
}

export interface DiffResult {
  /** 值变了的字段 */
  readonly changed: readonly DiffEntry[];
  /** 新增的字段 */
  readonly added: readonly DiffEntry[];
  /** 删除的字段 */
  readonly removed: readonly DiffEntry[];
  readonly hasChanges: boolean;
}

/**
 * 比对两个快照
 *
 * @param maxDepth 最大递归深度（默认 10）
 *
 * 【为什么要限制深度】
 * 深层嵌套的树比对很慢，而且游戏状态通常不需要精确到
 * "第 8 层的某个数变了"——知道"这个对象变了"就够了。
 */
export function diffSnapshots<T>(before: T, after: T, maxDepth = 10): DiffResult {
  const changed: DiffEntry[] = [];
  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];

  walk(before, after, '', 0, maxDepth, changed, added, removed);

  return {
    changed,
    added,
    removed,
    hasChanges: changed.length > 0 || added.length > 0 || removed.length > 0,
  };
}

function walk(
  before: unknown,
  after: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  changed: DiffEntry[],
  added: DiffEntry[],
  removed: DiffEntry[]
): void {
  if (before === after) return;

  const bIsObj = before !== null && typeof before === 'object';
  const aIsObj = after !== null && typeof after === 'object';

  if (!bIsObj || !aIsObj) {
    changed.push({ path, from: before, to: after });
    return;
  }

  // 深度到了，整体算一个变化
  if (depth >= maxDepth) {
    changed.push({ path, from: before, to: after });
    return;
  }

  // 数组
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) {
      changed.push({ path, from: before, to: after });
      return;
    }
    const maxLen = Math.max(before.length, after.length);
    for (let i = 0; i < maxLen; i++) {
      const p = `${path}[${i}]`;
      if (i >= before.length) added.push({ path: p, from: undefined, to: after[i] });
      else if (i >= after.length) removed.push({ path: p, from: before[i], to: undefined });
      else walk(before[i], after[i], p, depth + 1, maxDepth, changed, added, removed);
    }
    return;
  }

  const bObj = before as Record<string, unknown>;
  const aObj = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(bObj), ...Object.keys(aObj)]);

  for (const k of keys) {
    const p = path ? `${path}.${k}` : k;
    const hasB = k in bObj;
    const hasA = k in aObj;

    if (!hasB && hasA) added.push({ path: p, from: undefined, to: aObj[k] });
    else if (hasB && !hasA) removed.push({ path: p, from: bObj[k], to: undefined });
    else walk(bObj[k], aObj[k], p, depth + 1, maxDepth, changed, added, removed);
  }
}

// ============================================================
// 补丁（增量存档）
// ============================================================

export interface Patch {
  /** 路径 → 新值 */
  readonly set: Record<string, unknown>;
  /** 被删除的路径 */
  readonly remove: readonly string[];
}

export function createPatch<T>(before: T, after: T, maxDepth = 10): Patch {
  const d = diffSnapshots(before, after, maxDepth);
  const set: Record<string, unknown> = {};

  for (const e of d.changed) set[e.path] = e.to;
  for (const e of d.added) set[e.path] = e.to;

  return { set, remove: d.removed.map((e) => e.path) };
}

/**
 * 应用补丁
 *
 * 【坑】路径里带数组下标（`items[3].hp`），
 * 而且**处理顺序会影响结果**——父路径必须先被创建出来。
 * 所以设置时按深度从浅到深，删除时从深到浅（避免删了父再删子出错）。
 */
export function applyPatch<T>(base: T, patch: Patch): T {
  const out = deepClone(base) as unknown as Record<string, unknown>;

  /**
   * 【⚠️ 同层删除必须按"下标从大到小"，只按深度排序是不够的】
   *
   * 老实现只按 `depthOf` 降序排。数组下标 `arr[1]` 和 `arr[2]` 深度相同，
   * `Array.sort` 又是稳定的，于是保持原顺序 → 先删下标 1，
   * 后面的元素左移，再删下标 2 时删掉的已经是**原来的下标 3**。
   *
   * 实测：
   * ```js
   * applyPatch({ arr: ['a','b','c'] }, { set: {}, remove: ['arr[1]','arr[2]'] });
   * // 老实现 → ['a','c']（期望 ['a']）
   * ```
   * 顺序敏感、无报错、结果看起来"像删了一部分"——
   * 撤销栈、状态同步这类场景会静默丢数据。
   */
  const removes = [...patch.remove].sort(compareRemoveOrder);
  for (const path of removes) setAtPath(out, path, undefined, true);

  const sets = Object.keys(patch.set).sort((a, b) => depthOf(a) - depthOf(b));
  for (const path of sets) setAtPath(out, path, patch.set[path], false);

  return out as unknown as T;
}

function depthOf(path: string): number {
  return (path.match(/[.[\]]/g) ?? []).length;
}

/**
 * 删除路径的排序：深的先删，同层按下标从大到小删
 *
 * 【为什么同层要逆序】
 * 数组 `splice(i, 1)` 会让 i 之后的元素左移。
 * 先删大下标，已删除的位置就不会再影响未删的下标。
 *
 * @returns 负数表示 a 排在 b 前面
 */
function compareRemoveOrder(a: string, b: string): number {
  const d = depthOf(b) - depthOf(a);
  if (d !== 0) return d;

  const pa = parsePath(a);
  const pb = parsePath(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;

    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return y - x; // 大下标先删
    } else if (x !== y) {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) return sx < sy ? 1 : -1; // 降序，保证稳定可预期
    }
  }
  return 0;
}

function setAtPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
  isRemove: boolean
): void {
  const parts = parsePath(path);
  if (parts.length === 0) return;

  /**
   * 【⚠️ 必须在写入前拦下原型污染路径】
   *
   * 实测：
   * ```js
   * applyPatch({}, { set: { '__proto__.snapshotPolluted': true }, remove: [] });
   * ({}).snapshotPolluted // → true
   * ```
   * 这是**进程级污染**：之后任何 `if (obj.snapshotPolluted)` 都为真，
   * 不可逆、无报错。patch 常来自网络包或存档，属于外部输入。
   */
  assertSafePath(parts.map(String), path);

  let cur: Record<string, unknown> | unknown[] = root;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const nextKey = parts[i + 1];

    let child: unknown;
    if (typeof key === 'number') child = (cur as unknown[])[key];
    else child = (cur as Record<string, unknown>)[key];

    if (child === null || typeof child !== 'object') {
      child = typeof nextKey === 'number' ? [] : {};
      if (typeof key === 'number') (cur as unknown[])[key] = child;
      else (cur as Record<string, unknown>)[key] = child;
    }

    cur = child as Record<string, unknown> | unknown[];
  }

  const last = parts[parts.length - 1];
  if (isRemove) {
    if (typeof last === 'number') {
      if (Array.isArray(cur)) cur.splice(last, 1);
    } else {
      delete (cur as Record<string, unknown>)[last];
    }
  } else if (typeof last === 'number') {
    (cur as unknown[])[last] = value;
  } else {
    (cur as Record<string, unknown>)[last] = value;
  }
}

/** 'a.b[3].c' → ['a', 'b', 3, 'c'] */
function parsePath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
  }
  return out;
}

// ============================================================
// 撤销栈
// ============================================================

export interface UndoStackOptions {
  /** 最多保留多少步（默认 50） */
  readonly limit?: number;
}

export class UndoStack<T> {
  private readonly _undo: T[] = [];
  private readonly _redo: T[] = [];
  private readonly _limit: number;

  constructor(opts: UndoStackOptions = {}) {
    this._limit = clampNum(opts.limit, 1, 1e6, 50);
  }

  /**
   * 记录一个状态
   *
   * 【为什么 redo 栈要清空】
   * 撤销后再做新操作，之前的"未来"就作废了——
   * 这是所有撤销系统的标准行为（否则 redo 出来的状态是矛盾的）。
   */
  push(state: T): void {
    this._undo.push(deepClone(state));
    if (this._undo.length > this._limit) this._undo.shift();
    this._redo.length = 0;
  }

  /** 撤销。返回上一步的快照，栈空时返回 undefined */
  undo(current: T): T | undefined {
    const prev = this._undo.pop();
    if (prev === undefined) return undefined;
    this._redo.push(deepClone(current));
    return prev;
  }

  /** 重做 */
  redo(current: T): T | undefined {
    const next = this._redo.pop();
    if (next === undefined) return undefined;
    this._undo.push(deepClone(current));
    return next;
  }

  get canUndo(): boolean {
    return this._undo.length > 0;
  }

  get canRedo(): boolean {
    return this._redo.length > 0;
  }

  get undoDepth(): number {
    return this._undo.length;
  }

  get redoDepth(): number {
    return this._redo.length;
  }

  clear(): void {
    this._undo.length = 0;
    this._redo.length = 0;
  }

  destroy(): void {
    this.clear();
  }
}
