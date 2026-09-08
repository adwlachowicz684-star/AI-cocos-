/**
 * JoystickMover —— 轮盘移动（纯逻辑层）
 *
 * 【为什么要拆成 Core + Cocos 两层】
 *
 * 如果你把逻辑写进 Cocos 组件里：
 * - 无法单测（构造函数里就要 new Node）
 * - 换个引擎要重写
 * - 换个 UI 方案要重写
 *
 * 拆开后：
 * - **JoystickCore**：纯 TS，只做「触摸点 → 方向向量」，可完整单测
 * - **JoystickMover**（Cocos 组件）：薄薄一层，只负责接事件 + 画 UI
 *
 * 【这就是你问的"像 function 一样能用"的落地方式】
 * 它不认识「角色」，只认识「方向」。所以能用在：
 * 角色移动、炮台瞄准、镜头控制、菜单光标、载具方向……
 *
 * 【无引擎依赖】本文件不 import 任何 cc 模块。
 */

import { IVec2, normalize2 } from '../_core/types';
import { clamp, clamp01, numOr } from '../_core/math';

export type JoystickMode = 'fixed' | 'dynamic';

/**
 * 哨兵值：表示"当前由外部（键盘/手柄）驱动，而非触摸"
 *
 * 【为什么需要一个常量而不是直接写 -1】
 * 这个 -1 会被 setAxis() 写入、被 onDown() 判断，
 * 散落的魔法数字迟早会在某次改动里漏掉一处。
 *
 * 注意与 reset() 区分：reset() 置为 **null**（真的没有驱动源），
 * 而 -1 表示"有驱动源，但来自键盘/手柄而非触摸"。
 * 两者在 evaluate() 的死区判断里行为不同。
 *
 * 【为什么是 -1】Cocos 的真实触点 id 从 0 开始，不会是负数，
 * 所以用负数作哨兵不会和真实触点冲突。
 */
const EXTERNAL_DRIVE_ID = -1;

export interface JoystickOptions {
  /** 摇杆半径（像素） */
  readonly radius?: number;
  /**
   * 死区：小于此比例的偏移视为 0（0..1）
   *
   * 【为什么必须有】没有死区，手指的微动会让角色持续抖动。
   */
  readonly deadZone?: number;
  readonly mode?: JoystickMode;

  /**
   * 方向吸附：null = 自由方向，4 = 四向，8 = 八向
   * 用于格子移动或简化操作
   */
  readonly snapDirections?: number | null;

  /**
   * 摇杆头是否限制在底盘内
   * false = 允许拖出底盘（手指跑远了也跟着），体验更宽松
   */
  readonly clampKnob?: boolean;

  /**
   * 输出是否归一化
   *
   * 【坑】不归一化的话，斜向移动的速度是直线的 1.41 倍
   * （因为 x、y 都是 1）。这会让玩家沿对角线跑得更快。
   */
  readonly normalizeOutput?: boolean;
}

export interface JoystickOutput {
  /** 方向向量，长度 0..1（死区内为 0,0） */
  readonly dir: IVec2;
  /** 原始偏移量占半径的比例 0..1（UI 画摇杆头用） */
  readonly magnitude: number;
  /** 角度（度，0 = 右，逆时针为正） */
  readonly angle: number;
  /** 是否处于激活状态（有触点且超过死区） */
  readonly active: boolean;
}

export class JoystickCore {
  readonly radius: number;
  readonly deadZone: number;
  readonly mode: JoystickMode;
  readonly snapDirections: number | null;
  readonly clampKnob: boolean;
  readonly normalizeOutput: boolean;

  /** 底盘中心（在父节点局部坐标系中） */
  private _center: IVec2 = { x: 0, y: 0 };
  /** 摇杆头当前位置（相对底盘中心的偏移） */
  private _knob: IVec2 = { x: 0, y: 0 };

  /** 当前追踪的触点 id（多点触摸时只响应第一个） */
  private _touchId: number | null = null;

  private readonly _out: { dir: IVec2; magnitude: number; angle: number; active: boolean };

  constructor(opts: JoystickOptions = {}) {
    this.radius = Math.max(1, numOr(opts.radius, 80));
    this.deadZone = clamp01(opts.deadZone ?? 0.15);
    this.mode = opts.mode ?? 'dynamic';
    this.snapDirections = opts.snapDirections ?? null;
    this.clampKnob = opts.clampKnob ?? true;
    this.normalizeOutput = opts.normalizeOutput ?? true;

    this._out = { dir: { x: 0, y: 0 }, magnitude: 0, angle: 0, active: false };
  }

  /**
   * 按下
   * @param id 触点 id。**必须传**——用于多点触摸时只追踪第一个
   * @param x,y 局部坐标
   * @returns 是否接受了这个触点
   */
  onDown(id: number, x: number, y: number): boolean {
    // 【坑】多点触摸：第二个手指落下时不应抢占摇杆，
    // 否则玩家一边移动一边点技能会导致角色突然转向。
    //
    // 【为什么排除 EXTERNAL_DRIVE_ID】
    // setAxis()（键盘/手柄驱动）会把 _touchId 置为 -1 作为哨兵。
    // 如果这里一刀切地拒绝所有非 null 状态，玩家用键盘玩到一半
    // 想改用触摸就摸不动了，除非调用方记得先 reset()——
    // **要求调用方记得调某个方法，等于把内部状态泄漏了出去**。
    // 真实触点的 id 不会是负数，所以放行 -1 是安全的。
    if (this._touchId !== null && this._touchId !== EXTERNAL_DRIVE_ID) return false;

    if (this.mode === 'dynamic') {
      // 动态模式：底盘生成在按下的位置
      this._center.x = x;
      this._center.y = y;
    }
    this._touchId = id;
    this._knob.x = 0;
    this._knob.y = 0;
    return true;
  }

  /** 移动 */
  onMove(id: number, x: number, y: number): void {
    if (this._touchId !== id) return;

    let dx = x - this._center.x;
    let dy = y - this._center.y;

    const dist = Math.sqrt(dx * dx + dy * dy);

    if (this.clampKnob && dist > this.radius) {
      // 限制在圆内：保持方向，截断长度
      const k = this.radius / dist;
      dx *= k;
      dy *= k;
    }

    this._knob.x = dx;
    this._knob.y = dy;
  }

  /**
   * 抬起
   *
   * @returns 是否**真的结束了**本次摇杆操作
   *
   * 【为什么必须返回 boolean】
   * 只有驱动中的那个手指抬起才算"松手"。但 Cocos 的触摸事件是广播的：
   * 玩家点技能按钮的那根手指抬起时，摇杆节点同样会收到 TOUCH_END。
   *
   * 如果调用方不看返回值、一律做复位，就会出现：
   *   指1 按住摇杆移动 → 指2 点技能 → **指2 抬起** → 摇杆视觉消失、
   *   输出被清零、onEnd 误报，而指1 还按着。
   * 表现是"点一下技能，角色就顿一下"。
   *
   * 【返回值语义】
   *   true  = 驱动手指抬起了，调用方该复位 UI 并触发 onEnd
   *   false = 抬起的是别人（非驱动手指），**调用方什么都不该做**
   */
  onUp(id: number): boolean {
    if (this._touchId !== id) return false;
    this.reset();
    return true;
  }

  /**
   * 重置
   *
   * 【坑】松开触摸后方向必须归零，否则角色会一直朝一个方向走。
   * 这个 bug 非常常见，且很容易在测试中漏掉（因为测试时手指不会"松开"）。
   */
  reset(): void {
    this._touchId = null;
    this._knob.x = 0;
    this._knob.y = 0;
    if (this.mode === 'dynamic') {
      this._center.x = 0;
      this._center.y = 0;
    }
  }

  /**
   * 计算输出
   *
   * 【返回的是复用对象】高频调用不产生 GC。
   * 如果你要保存结果，请自行拷贝。
   */
  evaluate(): JoystickOutput {
    const o = this._out;

    const rawDist = Math.sqrt(this._knob.x * this._knob.x + this._knob.y * this._knob.y);
    const ratio = clamp(rawDist / this.radius, 0, 1);

    // 死区处理：低于阈值直接归零（而不是缩放，否则边界处会跳变）
    if (ratio < this.deadZone || this._touchId === null) {
      o.dir.x = 0;
      o.dir.y = 0;
      o.magnitude = 0;
      o.angle = 0;
      o.active = false;
      return o;
    }

    let dx = this._knob.x / this.radius;
    let dy = this._knob.y / this.radius;

    // 归一化：让最大输出恒为 1，斜向不加速
    if (this.normalizeOutput) {
      const n = normalize2({ x: dx, y: dy });
      dx = n.x;
      dy = n.y;
    }

    // 方向吸附
    if (this.snapDirections && this.snapDirections > 0) {
      const { x, y } = this._snap(dx, dy, this.snapDirections);
      dx = x;
      dy = y;
    }

    o.dir.x = dx;
    o.dir.y = dy;
    o.magnitude = ratio;
    o.angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    o.active = true;
    return o;
  }

  private _snap(x: number, y: number, n: number): IVec2 {
    const a = Math.atan2(y, x);
    const step = (Math.PI * 2) / n;
    const snapped = Math.round(a / step) * step;
    return { x: Math.cos(snapped), y: Math.sin(snapped) };
  }

  /** 底盘中心（UI 定位用） */
  get center(): Readonly<IVec2> {
    return this._center;
  }

  /** 摇杆头偏移（UI 画摇杆头用） */
  get knob(): Readonly<IVec2> {
    return this._knob;
  }

  get isActive(): boolean {
    return this._touchId !== null;
  }

  /**
   * 供外部驱动（键盘/手柄复用同一套输出）
   *
   * 【触摸可以接管】驱动期间玩家直接触摸屏幕会被接受（见 onDown 的注释），
   * 不需要调用方先 reset()。
   */
  setAxis(x: number, y: number): void {
    this._touchId = EXTERNAL_DRIVE_ID;
    this._knob.x = x * this.radius;
    this._knob.y = y * this.radius;
  }

  destroy(): void {
    this.reset();
  }
}
