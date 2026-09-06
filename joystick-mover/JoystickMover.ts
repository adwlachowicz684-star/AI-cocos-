/**
 * JoystickMover —— Cocos Creator 3.8 适配层（薄）
 *
 * 【这一层应该有多薄？】
 * 判据：**这里不应该出现任何"逻辑判断"**，只做三件事：
 *   ① 把引擎事件转成 Core 的方法调用
 *   ② 把 Core 的输出画到 UI 上
 *   ③ 把方向交给外部（回调）
 *
 * 所有逻辑（死区、归一化、吸附、多点触摸）都在 JoystickCore 里，
 * 那部分可以脱离引擎单测。
 *
 * 【用法】
 * 1. 在 Canvas 下建一个节点（如 "JoystickArea"），尺寸覆盖触摸区域
 * 2. 挂上本组件
 * 3. 拖入底盘（bg）与摇杆头（knob）两个子节点
 * 4. 在业务代码里监听 onMove 回调，或者直接读 joystick.output
 *
 * 【关键：它不认识"角色"】
 * 组件只输出方向。谁用这个方向、怎么移动，是调用方的事。
 * 所以同一个组件能给角色用、给炮台用、给镜头用。
 */

import {
  _decorator,
  Component,
  Node,
  UITransform,
  EventTouch,
  Vec2,
  Vec3,
} from 'cc';
import { JoystickCore, JoystickOptions, JoystickOutput } from './JoystickCore';

const { ccclass, property } = _decorator;

@ccclass('JoystickMover')
export class JoystickMover extends Component {
  // ==================== 可配置属性 ====================

  @property({ tooltip: '摇杆半径（像素）' })
  radius = 80;

  @property({ tooltip: '死区 0~1，小于此比例的偏移视为 0（防手抖）' })
  deadZone = 0.15;

  @property({ tooltip: 'fixed = 固定位置；dynamic = 在按下的位置生成' })
  isDynamic = true;

  @property({ tooltip: '方向吸附：0 = 不吸附，4 = 四向，8 = 八向' })
  snapDirections = 0;

  @property({ tooltip: '摇杆头是否限制在底盘内' })
  clampKnob = true;

  @property({ type: Node, tooltip: '底盘节点' })
  bgNode: Node | null = null;

  @property({ type: Node, tooltip: '摇杆头节点' })
  knobNode: Node | null = null;

  /** 触摸区域节点（默认为本节点） */
  @property({ type: Node, tooltip: '触摸区域，留空则用本节点' })
  touchArea: Node | null = null;

  // ==================== 运行时 ====================

  private _core: JoystickCore | null = null;
  private _tmpVec = new Vec3();

  /**
   * 方向变化回调
   *
   * 【为什么用回调而不是让外部每帧读】
   * 回调只在变化时触发（减少无谓调用）；
   * 但如果你需要每帧读（如物理移动），直接读 output 即可。
   */
  onDirectionChange: ((dir: { x: number; y: number }, magnitude: number) => void) | null = null;
  onStart: (() => void) | null = null;
  onEnd: (() => void) | null = null;

  /** 当前输出（外部可直接每帧读取） */
  get output(): JoystickOutput | null {
    return this._core?.evaluate() ?? null;
  }

  get direction(): { x: number; y: number } {
    const o = this.output;
    return o ? o.dir : { x: 0, y: 0 };
  }

  onLoad(): void {
    const opts: JoystickOptions = {
      radius: this.radius,
      deadZone: this.deadZone,
      mode: this.isDynamic ? 'dynamic' : 'fixed',
      snapDirections: this.snapDirections > 0 ? this.snapDirections : null,
      clampKnob: this.clampKnob,
      normalizeOutput: true,
    };
    this._core = new JoystickCore(opts);

    const area = this.touchArea ?? this.node;

    /**
     * 【坑】Cocos 3.x 用 node.on 监听触摸事件，不是 TouchStart/TouchMove 常量。
     * 且事件对象类型是 EventTouch。
     */
    area.on(Node.EventType.TOUCH_START, this._onTouchStart, this);
    area.on(Node.EventType.TOUCH_MOVE, this._onTouchMove, this);
    area.on(Node.EventType.TOUCH_END, this._onTouchEnd, this);
    area.on(Node.EventType.TOUCH_CANCEL, this._onTouchEnd, this);

    if (!this.isDynamic && this.bgNode) {
      // 固定模式：底盘停在初始位置
      this.bgNode.setPosition(0, 0, 0);
    } else if (this.bgNode) {
      this.bgNode.active = false;
    }
  }

  /**
   * 把触点转成"本节点的局部坐标"
   *
   * 【坑】Cocos 的坐标转换必须用 UITransform.convertToNodeSpaceAR，
   * 直接用 event.getLocation() 得到的是屏幕坐标，
   * 在有缩放/偏移的 Canvas 下会完全错位。
   */
  private _toLocal(e: EventTouch, out: Vec2): Vec2 {
    const ui = (this.touchArea ?? this.node).getComponent(UITransform);
    const p = e.getUILocation();
    if (ui) {
      this._tmpVec.set(p.x, p.y, 0);
      ui.convertToNodeSpaceAR(this._tmpVec, this._tmpVec);
      out.set(this._tmpVec.x, this._tmpVec.y);
    } else {
      out.set(p.x, p.y);
    }
    return out;
  }

  private _tmpPos = new Vec2();
  private _lastX = 0;
  private _lastY = 0;
  private _wasActive = false;

  private _onTouchStart(e: EventTouch): void {
    if (!this._core) return;
    const p = this._toLocal(e, this._tmpPos);
    const id = e.getID();

    /**
     * 【坑】多点触摸：第二个手指落下时 Core 会拒绝，
     * 但**不要**在这里调用 e.propagationStopped()，
     * 否则会阻断其他 UI（如技能按钮）的触摸。
     */
    if (!this._core.onDown(id, p.x, p.y)) return;

    if (this.bgNode) {
      if (this.isDynamic) {
        this.bgNode.setPosition(this._core.center.x, this._core.center.y, 0);
        this.bgNode.active = true;
      }
      this.bgNode.active = true;
    }
    if (this.knobNode) this.knobNode.active = true;

    this._updateVisual();
    this._wasActive = false;
    this.onStart?.();
  }

  private _onTouchMove(e: EventTouch): void {
    if (!this._core) return;
    const p = this._toLocal(e, this._tmpPos);
    this._core.onMove(e.getID(), p.x, p.y);
    this._updateVisual();
  }

  private _onTouchEnd(e: EventTouch): void {
    if (!this._core) return;

    /**
     * 【坑】必须看 onUp 的返回值，不能无条件复位。
     *
     * 背景：本组件在 _onTouchStart 里刻意不调用 e.propagationStopped()，
     * 为的是不阻断技能按钮等其他 UI 的触摸。
     * 但**触摸是广播的**：技能按钮那根手指抬起时，
     * 摇杆节点同样会收到 TOUCH_END。
     *
     * 如果这里不看返回值一律复位，就会发生：
     *   指1 按住摇杆移动
     *   指2 点技能按钮（tap）
     *   指2 抬起  → 摇杆视觉消失、输出清零、onEnd 误报
     *   而指1 还按着，角色在玩家没有松手的情况下停下
     *
     * 表现是"点一下技能，角色就顿一下"——
     * 这正是我们想让玩家"边移动边放技能"时最不能接受的手感。
     *
     * 【防住了按下，没防住抬起】是这类 bug 的典型成因。
     */
    if (!this._core.onUp(e.getID())) return;

    if (this.isDynamic && this.bgNode) this.bgNode.active = false;
    if (this.knobNode) {
      this.knobNode.active = false;
      this.knobNode.setPosition(0, 0, 0);
    }

    this._lastX = 0;
    this._lastY = 0;
    this._wasActive = false;
    this.onDirectionChange?.({ x: 0, y: 0 }, 0);
    this.onEnd?.();
  }

  private _updateVisual(): void {
    if (!this._core) return;
    const core = this._core;

    if (this.knobNode) {
      this.knobNode.setPosition(core.knob.x, core.knob.y, 0);
    }

    const o = core.evaluate();

    // 只在变化时回调，避免每帧无谓调用
    if (o.dir.x !== this._lastX || o.dir.y !== this._lastY || o.active !== this._wasActive) {
      this._lastX = o.dir.x;
      this._lastY = o.dir.y;
      this._wasActive = o.active;
      this.onDirectionChange?.(o.dir, o.magnitude);
    }
  }

  /**
   * 【铁律 5】可卸载：必须移除所有监听
   *
   * 【坑】Cocos 里忘记 off 会导致组件销毁后回调仍然触发，
   * 表现为"切场景后报 null 错误"。这是最常见的内存泄漏源头之一。
   */
  onDestroy(): void {
    const area = this.touchArea ?? this.node;
    area.off(Node.EventType.TOUCH_START, this._onTouchStart, this);
    area.off(Node.EventType.TOUCH_MOVE, this._onTouchMove, this);
    area.off(Node.EventType.TOUCH_END, this._onTouchEnd, this);
    area.off(Node.EventType.TOUCH_CANCEL, this._onTouchEnd, this);

    this.onDirectionChange = null;
    this.onStart = null;
    this.onEnd = null;
    this._core?.destroy();
    this._core = null;
  }
}
