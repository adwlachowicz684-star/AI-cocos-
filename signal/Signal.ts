/**
 * Signal —— 轻量信号（Observable / Delegate）
 *
 * 【与 EventBus 的区别】
 *
 * | | EventBus | Signal |
 * |---|---|---|
 * | 作用域 | 全局，按字符串名 | 局部，是一个对象 |
 * | 类型安全 | 弱（字符串 key） | **强**（每个 Signal 有固定签名） |
 * | 典型用途 | "玩家升级了"这种全局广播 | "这个按钮被点了"这种一对一 |
 * | 发现性 | 需查字符串常量 | 是对象属性，`btn.onClick.add(fn)` 一目了然 |
 *
 * **经验法则**：
 * - 跨模块、不知道谁会监听 → EventBus
 * - 明确的所有者（一个按钮、一个角色、一个技能）→ **Signal**
 *
 * Signal 的好处是**类型安全**且**可被持有**：
 * ```typescript
 * class Button {
 *   readonly onClick = new Signal<() => void>();   // 签名固定，写错编译不过
 * }
 * btn.onClick.add(() => ...);
 * ```
 *
 * 【使用示例】
 * ```typescript
 * const onDeath = new Signal<(killer: string) => void>();
 *
 * const off = onDeath.add((killer) => console.log(`被 ${killer} 杀`));
 * onDeath.emit('骷髅兵');
 * off();                       // 取消
 *
 * // 一次性
 * onDeath.once(() => console.log('只触发一次'));
 *
 * // 计数（调试泄漏）
 * onDeath.listenerCount;
 * ```
 *
 * 【无引擎依赖】
 */

export type Listener<T> = T extends (...args: infer A) => unknown ? (...args: A) => void : never;

export class Signal<F extends (...args: never[]) => void> {
  /**
   * 【⚠️ 为什么每条注册都要带一个唯一 id，而不是按函数值来认】
   *
   * 老实现里"移除"是 `findIndex((l) => l.fn === fn)`（只删第一个），
   * 但 emit 收尾的清理是 `filter((l) => !_pendingRemoval.has(l.fn))`——
   * `_pendingRemoval` 是 **Set<函数>**，按函数值去重。
   *
   * 于是同一个函数注册两次时（一个 `once` + 一个 `add`，或两个模块各注册一次同一个
   * 具名回调），任何一次取消都会让收尾的 filter 把**所有** fn 相同的条目一起删掉：
   *
   *     listenerCount 2 → emit() → n=1, listenerCount=0   ← add 的那条被连坐删除
   *
   * 这是 EventBus 那次"旧取消函数误删同名新监听器"的同类实例，只不过发生在 Signal 上。
   * 表现是"某个 UI 突然不刷新了"，而代码里看不到任何错误。
   *
   * 修法：注册即分配自增 id，取消函数闭包捕获**自己的** id，
   * `_pendingRemoval` 存 id 而不是函数值 → 一次取消只影响一条注册。
   */
  private _listeners: Array<{ id: number; fn: F; once: boolean }> = [];
  private _emitting = false;
  private _pendingRemoval = new Set<number>();
  private _nextId = 1;

  /**
   * 添加监听
   * @returns 取消函数
   *
   * 【为什么返回取消函数而不是提供 off(fn)】
   * 同 EventBus 的设计：`off(fn)` 需要调用方保存 fn 的引用，
   * 而返回的函数可以随手丢给生命周期管理（比如 push 到一个 dispose 数组）。
   */
  add(fn: F): () => void {
    let removed = false;
    const id = this._nextId++;
    this._listeners.push({ id, fn, once: false });
    return () => {
      if (removed) return;
      removed = true;
      this._remove(id);
    };
  }

  /** 添加一次性监听 */
  once(fn: F): () => void {
    let removed = false;
    const id = this._nextId++;
    this._listeners.push({ id, fn, once: true });
    return () => {
      if (removed) return;
      removed = true;
      this._remove(id);
    };
  }

  private _remove(id: number): void {
    /**
     * 【坑】正在 emit 时移除会破坏遍历。
     * 经典场景：监听者在回调里把自己取消掉（"只处理第一次命中"）。
     * 这里标记为待移除，emit 结束后统一清理。
     */
    if (this._emitting) {
      this._pendingRemoval.add(id);
      return;
    }
    const i = this._listeners.findIndex((l) => l.id === id);
    if (i >= 0) this._listeners.splice(i, 1);
  }

  /**
   * 触发
   *
   * 【坑】某个监听者抛异常不应中断其他监听者。
   * 一个 UI 回调写错了，不应该导致伤害逻辑收不到事件。
   */
  emit(...args: Parameters<F>): void {
    if (this._emitting) {
      console.warn('[Signal] 递归 emit 被忽略（回调里不要再 emit 同一个信号）');
      return;
    }

    this._emitting = true;
    const snapshot = this._listeners.slice();

    try {
      for (const l of snapshot) {
        if (this._pendingRemoval.has(l.id)) continue;
        try {
          (l.fn as unknown as (...a: unknown[]) => void)(...args);
        } catch (e) {
          console.error('[Signal] 监听者抛异常：', e);
        }
        if (l.once) this._pendingRemoval.add(l.id);
      }
    } finally {
      this._emitting = false;
      if (this._pendingRemoval.size > 0) {
        this._listeners = this._listeners.filter((l) => !this._pendingRemoval.has(l.id));
        this._pendingRemoval.clear();
      }
    }
  }

  /** 监听者数量（**只增不减 = 泄漏**） */
  get listenerCount(): number {
    return this._listeners.length;
  }

  /** 移除所有监听 */
  clear(): void {
    if (this._emitting) {
      for (const l of this._listeners) this._pendingRemoval.add(l.id);
      return;
    }
    this._listeners.length = 0;
  }

  destroy(): void {
    this.clear();
  }
}
