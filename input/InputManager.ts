/**
 * InputManager —— 统一输入抽象
 *
 * 【它解决什么】
 *
 * 直接监听按键的写法：
 * ```typescript
 * if (keyboard.isDown('W')) moveUp();
 * ```
 * 问题：① 玩家无法改键 ② 加手柄支持要重写所有逻辑 ③ 触摸端怎么办
 *
 * 抽象成「动作名」后：
 * ```typescript
 * input.getAxis('move');        // { x, y } 不管来自 WASD、摇杆还是手柄
 * input.isPressed('attack');
 * input.wasJustPressed('dash');
 * ```
 * 换设备、改键位、加触摸——**游戏逻辑一行不用改**。
 *
 * 【三个必须理解的时间概念】
 * - `pressed`       ：当前是否按住
 * - `justPressed`   ：**这一帧**刚按下（用于跳跃、攻击这类"触发一次"的动作）
 * - `justReleased`  ：**这一帧**刚松开
 *
 * 【坑：justPressed 必须在帧末清除】
 * 这是输入系统最经典的 bug：忘了清除 justPressed，
 * 玩家按一次攻击会连放好几次（每帧都满足 justPressed）。
 * 所以必须调用 `endFrame()`——建议放在主循环最后，
 * 或者由 Scheduler 的最后一个 everyFrame 调用。
 *
 * 【使用示例】
 * ```typescript
 * const input = new InputManager();
 *
 * // 绑定：动作名 ← 物理键
 * input.bindAxis('move', {
 *   negativeX: [Key.A], positiveX: [Key.D],
 *   negativeY: [Key.S], positiveY: [Key.W],
 * });
 * input.bindButton('attack', [Key.Space, Mouse.Left]);
 * input.bindButton('dash', [Key.Shift]);
 *
 * // 每帧（在读取输入之前）
 * input.beginFrame();
 * // ... 游戏逻辑读输入 ...
 * // 帧末
 * input.endFrame();
 *
 * // 改键
 * input.rebind('dash', [Key.Q], 0);
 * const saved = input.exportBindings();   // 存档
 * ```
 *
 * 【无引擎依赖】物理输入由外部通过 `setKeyState` / `setAxis` 注入。
 * Cocos 侧只需一个薄组件把引擎事件转成这些调用。
 */

import { IVec2, normalize2 } from '../_core/types';
import { clamp01 } from '../_core/math';

/**
 * 物理键标识
 *
 * 【为什么用数字枚举而不是字符串】
 * 字符串每次比较要遍历字符，数字是 O(1)。
 * 输入是每帧高频路径，这个优化值得做。
 *
 * 这里只列出常用键，扩展时继续往后加即可。
 * 引擎侧负责把引擎的 keyCode 映射到这些值。
 */
export const Key = {
  None: 0,
  // 字母
  A: 4, B: 5, C: 6, D: 7, E: 8, F: 9, G: 10, H: 11, I: 12, J: 13,
  K: 14, L: 15, M: 16, N: 17, O: 18, P: 19, Q: 20, R: 21, S: 22, T: 23,
  U: 24, V: 25, W: 26, X: 27, Y: 28, Z: 29,
  // 数字
  Digit0: 30, Digit1: 31, Digit2: 32, Digit3: 33, Digit4: 34,
  Digit5: 35, Digit6: 36, Digit7: 37, Digit8: 38, Digit9: 39,
  // 功能
  Space: 44, Enter: 40, Escape: 41, Tab: 43, Backspace: 42,
  ShiftLeft: 50, ShiftRight: 51, CtrlLeft: 52, CtrlRight: 53,
  AltLeft: 54, AltRight: 55,
  // 方向
  ArrowUp: 60, ArrowDown: 61, ArrowLeft: 62, ArrowRight: 63,
  // 鼠标
  MouseLeft: 70, MouseRight: 71, MouseMiddle: 72,
  // 手柄
  GamepadA: 80, GamepadB: 81, GamepadX: 82, GamepadY: 83,
  GamepadL1: 84, GamepadR1: 85, GamepadL2: 86, GamepadR2: 87,
  GamepadSelect: 88, GamepadStart: 89,
  GamepadLStick: 90, GamepadRStick: 91,
  GamepadDPadUp: 92, GamepadDPadDown: 93, GamepadDPadLeft: 94, GamepadDPadRight: 95,
} as const;

export type KeyCode = (typeof Key)[keyof typeof Key];

/** 轴绑定：四个方向各绑一组键 */
export interface AxisBinding {
  readonly negativeX?: readonly KeyCode[];
  readonly positiveX?: readonly KeyCode[];
  readonly negativeY?: readonly KeyCode[];
  readonly positiveY?: readonly KeyCode[];
}

/** 轴的状态 */
interface AxisState {
  x: number;
  y: number;
}

export interface InputManagerOptions {
  /**
   * 轴输出的死区
   *
   * 【为什么在管理器再设一次】
   * 手柄摇杆有物理回中误差，即使松手也可能输出 0.05 的偏移。
   * 没有死区角色会自己慢慢漂移。
   */
  readonly axisDeadZone?: number;

  /**
   * 是否归一化轴输出
   * 关掉的话，斜向移动速度是直线的 1.41 倍
   * （与 JoystickCore 的 normalizeOutput 同理）
   */
  readonly normalizeAxis?: boolean;

  /**
   * 是否启用输入缓冲
   * 开启后，即使这一帧没读到按下，短时间内（bufferWindow）的按下仍可被消费。
   * 详见主项目的 InputBuffer 设计。
   */
  readonly enableBuffer?: boolean;
  readonly bufferWindow?: number;
}

export class InputManager {
  private readonly _axisDeadZone: number;
  private readonly _normalizeAxis: boolean;

  /** 当前帧的物理键状态 */
  private readonly _keyDown = new Set<KeyCode>();
  private readonly _keyJustDown = new Set<KeyCode>();
  private readonly _keyJustUp = new Set<KeyCode>();

  /** 动作绑定 */
  private readonly _buttonBindings = new Map<string, KeyCode[]>();
  private readonly _axisBindings = new Map<string, AxisBinding>();

  /** 轴状态（含外部注入的虚拟摇杆） */
  private readonly _axes = new Map<string, AxisState>();

  /** 启用输入 */
  private _enabled = true;

  constructor(opts: InputManagerOptions = {}) {
    this._axisDeadZone = clamp01(opts.axisDeadZone ?? 0.15);
    this._normalizeAxis = opts.normalizeAxis ?? true;
  }

  // ==================== 绑定 ====================

  /** 绑定一个按钮动作到物理键 */
  bindButton(action: string, keys: readonly KeyCode[]): void {
    this._buttonBindings.set(action, keys.slice());
  }

  /** 绑定一个轴动作 */
  bindAxis(action: string, binding: AxisBinding): void {
    this._axisBindings.set(action, binding);
    if (!this._axes.has(action)) this._axes.set(action, { x: 0, y: 0 });
  }

  /**
   * 重新绑定某个动作
   *
   * @param slotIndex 对按钮：替换第几个键（一个动作可绑多个键）
   *                  对轴：忽略
   */
  rebind(action: string, keys: readonly KeyCode[], slotIndex = 0): void {
    if (this._axisBindings.has(action)) {
      throw new Error(`[InputManager] "${action}" 是轴动作，请用 rebindAxis`);
    }
    const list = this._buttonBindings.get(action) ?? [];
    if (slotIndex < list.length) {
      list[slotIndex] = keys[0];
    } else {
      list.push(keys[0]);
    }
  }

  /** 获取某动作当前的绑定 */
  getBinding(action: string): readonly KeyCode[] {
    return this._buttonBindings.get(action) ?? [];
  }

  /** 导出所有绑定（存档用） */
  exportBindings(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [k, v] of this._buttonBindings) out[k] = v.slice();
    return out;
  }

  /** 导入绑定（读档用） */
  importBindings(data: Readonly<Record<string, number[]>>): void {
    for (const [k, v] of Object.entries(data)) {
      this._buttonBindings.set(k, v.slice() as KeyCode[]);
    }
  }

  /** 恢复默认绑定（传空对象即可清空，调用方传入默认值重新 bind） */
  resetBindings(defaults: Readonly<Record<string, KeyCode[]>>): void {
    this._buttonBindings.clear();
    for (const [k, v] of Object.entries(defaults)) this._buttonBindings.set(k, v.slice());
  }

  // ==================== 帧循环 ====================

  /**
   * 帧开始：重置轴状态，并从当前按下的键推导数字轴
   *
   * 【调用顺序】（很重要，搞反了模拟量会失效）
   * ```
   * input.beginFrame();                    // ① 重置 + 从按键推导
   * input.setAxisAnalog('move', lx, ly);   // ② 注入模拟量（手柄/虚拟摇杆）
   * const dir = input.getAxis('move');     // ③ 读取
   * // ... 帧末
   * input.endFrame();                      // ④ 清除 just 状态
   * ```
   *
   * 为什么模拟量必须在 beginFrame **之后**注入：
   * beginFrame 会重置所有轴（因为数字键状态每帧都要重算）。
   * 如果先注入再 beginFrame，模拟量会被清掉——
   * 表现为「手柄摇杆完全没反应」，而且很难看出原因。
   */
  beginFrame(): void {
    // 轴状态每帧重算（由当前按下的键推导）
    for (const [name, binding] of this._axisBindings) {
      let x = 0;
      let y = 0;
      if (binding.negativeX?.some((k) => this._keyDown.has(k))) x -= 1;
      if (binding.positiveX?.some((k) => this._keyDown.has(k))) x += 1;
      if (binding.negativeY?.some((k) => this._keyDown.has(k))) y -= 1;
      if (binding.positiveY?.some((k) => this._keyDown.has(k))) y += 1;

      // 死区
      const mag = Math.sqrt(x * x + y * y);
      if (mag < this._axisDeadZone) {
        x = 0;
        y = 0;
      } else if (this._normalizeAxis && mag > 1) {
        // 键盘斜向是 (1,1)，长度 1.41 → 归一化到 1
        const n = normalize2({ x, y });
        x = n.x;
        y = n.y;
      }

      const state = this._axes.get(name)!;
      state.x = x;
      state.y = y;
    }
  }

  /**
   * 帧结束：清除 justPressed / justReleased
   *
   * 【铁律】必须调用。忘了会让"按一次"变成"每帧都触发"。
   */
  endFrame(): void {
    this._keyJustDown.clear();
    this._keyJustUp.clear();
  }

  // ==================== 注入物理输入 ====================

  /** 由引擎侧调用：某个键按下 */
  setKeyDown(code: KeyCode): void {
    if (!this._enabled) return;
    if (!this._keyDown.has(code)) {
      this._keyJustDown.add(code);
    }
    this._keyDown.add(code);
  }

  /** 由引擎侧调用：某个键松开 */
  setKeyUp(code: KeyCode): void {
    if (!this._enabled) return;
    if (this._keyDown.has(code)) {
      this._keyJustUp.add(code);
    }
    this._keyDown.delete(code);
  }

  /**
   * 由外部注入一个轴的模拟量（手柄摇杆 / 虚拟摇杆）
   *
   * 【与 JoystickCore 的配合】
   * ```typescript
   * // 虚拟摇杆的输出喂给 InputManager
   * const o = joystick.evaluate();
   * input.setAxisAnalog('move', o.dir.x, o.dir.y);
   * ```
   * 这样键盘、手柄、触屏三条路径共用同一套死区与归一化，
   * 行为完全一致。
   *
   * 【注意】模拟量与数字键会合并：取绝对值较大者。
   * 这样"手柄推着走的同时按 WASD"不会互相抵消。
   */
  setAxisAnalog(action: string, x: number, y: number): void {
    const state = this._axes.get(action);
    if (!state) {
      this._axes.set(action, { x, y });
      return;
    }

    // 死区
    const mag = Math.sqrt(x * x + y * y);
    let nx = 0;
    let ny = 0;
    if (mag >= this._axisDeadZone) {
      if (this._normalizeAxis) {
        const n = normalize2({ x, y });
        const scale = Math.min(mag, 1); // 保留摇杆的模拟量（轻推 = 慢走）
        nx = n.x * scale;
        ny = n.y * scale;
      } else {
        nx = x;
        ny = y;
      }
    }

    // 与数字键合并：取绝对值较大的（这样键盘和摇杆不会互相抵消）
    if (Math.abs(nx) > Math.abs(state.x)) state.x = nx;
    if (Math.abs(ny) > Math.abs(state.y)) state.y = ny;
  }

  /** 清空所有按键状态（切场景、失焦时用） */
  clearKeys(): void {
    this._keyDown.clear();
    this._keyJustDown.clear();
    this._keyJustUp.clear();
    for (const a of this._axes.values()) {
      a.x = 0;
      a.y = 0;
    }
  }

  // ==================== 查询 ====================

  /** 动作当前是否按住 */
  isPressed(action: string): boolean {
    if (!this._enabled) return false;
    const keys = this._buttonBindings.get(action);
    if (!keys) return false;
    for (const k of keys) if (this._keyDown.has(k)) return true;
    return false;
  }

  /** 动作是否在这一帧刚按下 */
  wasJustPressed(action: string): boolean {
    if (!this._enabled) return false;
    const keys = this._buttonBindings.get(action);
    if (!keys) return false;
    for (const k of keys) if (this._keyJustDown.has(k)) return true;
    return false;
  }

  /** 动作是否在这一帧刚松开 */
  wasJustReleased(action: string): boolean {
    if (!this._enabled) return false;
    const keys = this._buttonBindings.get(action);
    if (!keys) return false;
    for (const k of keys) if (this._keyJustUp.has(k)) return true;
    return false;
  }

  /**
   * 取轴值
   *
   * 【返回的是复用对象】高频调用不产生 GC。
   * 要保存请自行拷贝。
   */
  getAxis(action: string): IVec2 {
    if (!this._enabled) return ZERO;
    return this._axes.get(action) ?? ZERO;
  }

  /** 取轴值（拷贝到 out，零分配） */
  getAxisTo(action: string, out: IVec2): IVec2 {
    const a = this._enabled ? this._axes.get(action) : undefined;
    out.x = a?.x ?? 0;
    out.y = a?.y ?? 0;
    return out;
  }

  /** 原始键查询（调试用） */
  isKeyDown(code: KeyCode): boolean {
    return this._keyDown.has(code);
  }

  // ==================== 控制 ====================

  setEnabled(v: boolean): void {
    if (this._enabled === v) return;
    this._enabled = v;
    if (!v) this.clearKeys();
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** 当前按下的键数（调试用） */
  get pressedCount(): number {
    return this._keyDown.size;
  }

  /** 【铁律 5】可卸载 */
  destroy(): void {
    this._keyDown.clear();
    this._keyJustDown.clear();
    this._keyJustUp.clear();
    this._buttonBindings.clear();
    this._axisBindings.clear();
    this._axes.clear();
  }
}

/** 零向量常量（禁用或未绑定时返回，避免每次 new） */
const ZERO: IVec2 = { x: 0, y: 0 };
