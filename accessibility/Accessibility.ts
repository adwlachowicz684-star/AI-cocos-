/**
 * accessibility/Accessibility.ts —— 可访问性设置
 *
 * 【它解决什么】
 *
 * 可访问性（a11y）常被当成"发布前再说"的事，
 * 但它实际上是**一组会同时影响 UI、音频、输入、渲染的全局开关**。
 *
 * 不做成统一模块，这些开关就会散落各处，
 * 改了一处忘了另一处——比如开了"减少动效"但震屏还在。
 *
 * 本模块把常见可访问性需求归成几类，
 * 并提供"某个表现要不要做"的统一查询入口。
 *
 * | 需求 | 影响 |
 * |---|---|
 * 减少动效 | 震屏、闪白、转场、粒子、相机抖动全部关闭或减弱 |
 * 色盲模式 | 红绿对比的元素改用形状/文字辅助区分 |
 * 字号缩放 | UI 整体放大（还会影响布局溢出） |
 * 高对比 | 文字加描边、背景加深 |
 * 字幕 | 始终显示、显示说话人、背景板 |
 * 单手模式 | 触控热区左右手切换 |
 * 长按阈值 | 手抖玩家按不住 |
 *
 * 【零业务依赖】
 * 它只维护开关与缩放系数，不认识任何具体表现。
 *
 * 【使用示例】
 * ```typescript
 * const a11y = new Accessibility();
 *
 * // 设置项通常直接来自设置界面
 * a11y.setReduceMotion(true);          // 关闭镜头震动/闪白
 * a11y.setColorBlind('deuteranopia');  // 红绿色盲校正
 * a11y.setFontScale(1.25);             // 字号缩放
 * a11y.setSubtitles(true);             // 开启字幕
 *
 * // 渲染/表现层读当前状态
 * a11y.reduceMotion;   // true
 * a11y.fontScale;      // 1.25
 * ```
 *
 * 【为什么要读状态而不是各自存一份】
 * 多个系统（UI、镜头、战斗表现）都要响应这些开关，
 * 集中在一处才能避免"改了设置但某个系统没跟着变"。
 */

import { clampNum } from '../_core/math';

// ==================== 类型 ====================

export type ColorBlindMode = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';

export interface AccessibilityOptions {
  readonly reduceMotion?: boolean;
  readonly colorBlind?: ColorBlindMode;
  /** 字号缩放系数。1 = 标准 */
  readonly fontScale?: number;
  readonly highContrast?: boolean;
  readonly subtitles?: boolean;
  readonly subtitleSpeaker?: boolean;
  /** 单手模式：'right' | 'left' | 'off' */
  readonly oneHanded?: 'off' | 'left' | 'right';
  /** 长按判定阈值（毫秒）。默认 600 */
  readonly longPressMs?: number;
  /** 震屏强度倍率（0 = 完全关闭）。默认 1 */
  readonly shakeScale?: number;
  readonly onChange?: (key: string, value: unknown) => void;
}

/** 可访问性影响的"表现类别" */
export type EffectKind =
  /** 震屏 / 相机抖动 */
  | 'shake'
  /** 闪白 / 闪红 / 全屏闪光 */
  | 'flash'
  /** 转场动画 */
  | 'transition'
  /** 粒子 / 拖尾等装饰表现 */
  | 'particle'
  /** 自动镜头移动（过场） */
  | 'autoCamera'
  /** 循环动画（待机呼吸、UI 循环特效） */
  | 'loopAnim'
  /** 屏幕震动之外的持续性画面晃动 */
  | 'sway';

// ==================== 实现 ====================

export class Accessibility {
  private _reduceMotion: boolean;
  private _colorBlind: ColorBlindMode;
  private _fontScale: number;
  private _highContrast: boolean;
  private _subtitles: boolean;
  private _subtitleSpeaker: boolean;
  private _oneHanded: 'off' | 'left' | 'right';
  private _longPressMs: number;
  private _shakeScale: number;
  /**
   * 不再用 readonly：destroy() 要能断开它（见文末 destroy 的注释）。
   */
  private _onChange?: (key: string, value: unknown) => void;

  constructor(opts: AccessibilityOptions = {}) {
    /**
     * 【⚠️ 构造必须与 setter 同口径（P1）】
     *
     * 修复前这里只写 `if (this._fontScale <= 0) throw`，
     * 而 `NaN <= 0` 恒为 false —— **NaN 直接穿透校验**。
     * 后果不是"报错没报对"，而是 `fontSize(base) = base * NaN = NaN`：
     * 全 UI 字号变成 NaN，文本渲染异常或整块消失，且不抛任何错。
     * NaN 一旦进了布局，要回溯很久才能定位到"是构造参数带了 NaN"。
     *
     * 同一处还有第二个口径问题：`shakeScale` 构造时原样收下任意值
     * （`new Accessibility({ shakeScale: 5 })` 得到 5），
     * 但 `setShakeScale(5)` 会夹到 1。于是"构造传 5 生效、重设被压到 1"，
     * 行为随调用路径变化——这类不一致比单纯的越界更难查。
     *
     * 修法：三个数值字段统一走 `clampNum`（与 setter 完全一致的区间），
     * 只对 fontScale 保留"非正数直接抛错"的既有契约。
     *
     * 【为什么 fontScale 的判定写成 `!(v > 0)` 而不是 `v <= 0`】
     * `v <= 0` 对 NaN 为 false（穿透），`!(v > 0)` 对 NaN 为 true（拦住）。
     * 见全库共享模式 A：否定式条件天然漏掉 NaN。
     */
    if (opts.fontScale !== undefined && !(opts.fontScale > 0)) {
      throw new Error(`[A11y] 字号缩放必须为正，收到 ${opts.fontScale}`);
    }

    this._reduceMotion = opts.reduceMotion ?? false;
    this._colorBlind = opts.colorBlind ?? 'none';
    this._fontScale = clampNum(opts.fontScale, 0.8, 2, 1);
    this._highContrast = opts.highContrast ?? false;
    this._subtitles = opts.subtitles ?? false;
    this._subtitleSpeaker = opts.subtitleSpeaker ?? true;
    this._oneHanded = opts.oneHanded ?? 'off';
    this._longPressMs = clampNum(opts.longPressMs, 200, 3000, 600);
    this._shakeScale = clampNum(opts.shakeScale, 0, 1, 1);
    this._onChange = opts.onChange;
  }

  // ==================== 读取 ====================

  get reduceMotion(): boolean {
    return this._reduceMotion;
  }

  get colorBlind(): ColorBlindMode {
    return this._colorBlind;
  }

  get fontScale(): number {
    return this._fontScale;
  }

  get highContrast(): boolean {
    return this._highContrast;
  }

  get subtitles(): boolean {
    return this._subtitles;
  }

  get subtitleSpeaker(): boolean {
    return this._subtitleSpeaker;
  }

  get oneHanded(): 'off' | 'left' | 'right' {
    return this._oneHanded;
  }

  get longPressMs(): number {
    return this._longPressMs;
  }

  get shakeScale(): number {
    return this._shakeScale;
  }

  // ==================== 修改 ====================

  private _set(key: string, apply: () => void, value: unknown): void {
    apply();
    this._onChange?.(key, value);
  }

  setReduceMotion(v: boolean): void {
    this._set('reduceMotion', () => { this._reduceMotion = v; }, v);
  }

  setColorBlind(v: ColorBlindMode): void {
    this._set('colorBlind', () => { this._colorBlind = v; }, v);
  }

  /**
   * 设置字号缩放
   *
   * 【⚠️ 范围约束】
   * 太小的字号等于没有无障碍，
   * 太大会让布局彻底溢出（文字跑出按钮外）。
   * 这里夹到 [0.8, 2.0]。
   */
  setFontScale(v: number): void {
    const c = Math.min(2, Math.max(0.8, v));
    this._set('fontScale', () => { this._fontScale = c; }, c);
  }

  setHighContrast(v: boolean): void {
    this._set('highContrast', () => { this._highContrast = v; }, v);
  }

  setSubtitles(v: boolean): void {
    this._set('subtitles', () => { this._subtitles = v; }, v);
  }

  setSubtitleSpeaker(v: boolean): void {
    this._set('subtitleSpeaker', () => { this._subtitleSpeaker = v; }, v);
  }

  setOneHanded(v: 'off' | 'left' | 'right'): void {
    this._set('oneHanded', () => { this._oneHanded = v; }, v);
  }

  /** 长按阈值，夹到 [200, 3000] */
  setLongPressMs(v: number): void {
    const c = Math.min(3000, Math.max(200, v));
    this._set('longPressMs', () => { this._longPressMs = c; }, c);
  }

  /** 震屏倍率，夹到 [0, 1] */
  setShakeScale(v: number): void {
    const c = Math.min(1, Math.max(0, v));
    this._set('shakeScale', () => { this._shakeScale = c; }, c);
  }

  // ==================== 核心查询 ====================

  /**
   * 某个表现是否应该播放
   *
   * 【⚠️ 这是本模块最重要的方法】
   * "减少动效"不只是关掉震屏——
   * 闪白、转场、粒子、自动镜头全都要一起关。
   * 只关其中一项，玩家会认为"这个设置没生效"。
   */
  shouldPlay(kind: EffectKind): boolean {
    if (!this._reduceMotion) return true;
    /**
     * 【P2：两支都返回 false，合并成一句】
     *
     * 修复前 switch 里 `shake/sway/flash` 与 `transition/autoCamera`
     * 是两个独立的 case 组，但**返回值完全相同**。
     * 这种写法会让人误以为"这两组的开关策略将来会分开"，
     * 于是改动时只敢动其中一组——事实上它们现在就是同一条规则：
     * 只要开了减少动效，**所有会引起前庭不适的画面运动都要停**。
     *
     * 反过来写（保留 particle / loopAnim）也有好处：
     * 新增 EffectKind 时，默认是"关掉"而不是"播放"——
     * 未知表现放行，等于让一个没被评估过的动效在前庭敏感玩家面前播出来。
     */
    return kind === 'particle' || kind === 'loopAnim';
  }

  /**
   * 震屏实际强度
   *
   * 【设计】
   * 不是简单的开/关——玩家可以选"减弱到 50%"而不是完全关掉。
   * 完全关掉会让一部分玩家觉得打击感没了。
   */
  shake(amount: number): number {
    if (!this.shouldPlay('shake')) return 0;
    return amount * this._shakeScale;
  }

  /**
   * 颜色是否需要在 UI 上做辅助区分
   *
   * 【用途】
   * 红绿色盲模式下，"血量低"不能只靠变红表示，
   * 要额外加图标或数字。
   */
  needsColorAid(): boolean {
    return this._colorBlind !== 'none';
  }

  /**
   * 需要避免的色相对（用于自动替换配色）
   *
   * - protanopia / deuteranopia：红绿难分
   * - tritanopia：蓝黄难分
   */
  avoidHuePair(): 'red-green' | 'blue-yellow' | null {
    switch (this._colorBlind) {
      case 'protanopia':
      case 'deuteranopia':
        return 'red-green';
      case 'tritanopia':
        return 'blue-yellow';
      default:
        return null;
    }
  }

  /** 字号实际像素（传入设计稿基准值） */
  fontSize(base: number): number {
    return base * this._fontScale;
  }

  /**
   * 触控热区是否需要镜像到另一侧
   *
   * 【用途】单手模式
   */
  mirrored(): boolean {
    return this._oneHanded === 'left';
  }

  // ==================== 预设 ====================

  /** 标准（全部关闭） */
  static standard(): Accessibility {
    return new Accessibility();
  }

  /**
   * 前庭敏感预设
   *
   * 【这是"减少动效"的真实用途】
   * 不是"画面朴素一点"，而是防止晕动症。
   */
  static motionSensitive(): Accessibility {
    return new Accessibility({ reduceMotion: true, shakeScale: 0 });
  }

  /** 色觉障碍预设（红绿色盲） */
  static colorBlindRed(): Accessibility {
    return new Accessibility({ colorBlind: 'deuteranopia' });
  }

  /** 大字号预设 */
  static largeText(): Accessibility {
    return new Accessibility({ fontScale: 1.5, highContrast: true });
  }

  // ==================== 存档 ====================

  exportState(): Record<string, unknown> {
    return {
      reduceMotion: this._reduceMotion,
      colorBlind: this._colorBlind,
      fontScale: this._fontScale,
      highContrast: this._highContrast,
      subtitles: this._subtitles,
      subtitleSpeaker: this._subtitleSpeaker,
      oneHanded: this._oneHanded,
      longPressMs: this._longPressMs,
      shakeScale: this._shakeScale,
    };
  }

  /**
   * 导入存档
   *
   * 【⚠️ 未知/非法值全部忽略并保留默认】
   * 手改存档、旧版本残留都会遇到，
   * 抛错会让玩家进不去游戏。
   */
  importState(s: Readonly<Record<string, unknown>>): void {
    const blind: ColorBlindMode[] = ['none', 'protanopia', 'deuteranopia', 'tritanopia'];
    const hand = ['off', 'left', 'right'];

    if (typeof s.reduceMotion === 'boolean') this._reduceMotion = s.reduceMotion;
    if (typeof s.colorBlind === 'string' && blind.includes(s.colorBlind as ColorBlindMode)) {
      this._colorBlind = s.colorBlind as ColorBlindMode;
    }
    if (typeof s.fontScale === 'number' && Number.isFinite(s.fontScale)) {
      this.setFontScale(s.fontScale);
    }
    if (typeof s.highContrast === 'boolean') this._highContrast = s.highContrast;
    if (typeof s.subtitles === 'boolean') this._subtitles = s.subtitles;
    if (typeof s.subtitleSpeaker === 'boolean') this._subtitleSpeaker = s.subtitleSpeaker;
    if (typeof s.oneHanded === 'string' && hand.includes(s.oneHanded)) {
      this._oneHanded = s.oneHanded as 'off' | 'left' | 'right';
    }
    if (typeof s.longPressMs === 'number' && Number.isFinite(s.longPressMs)) {
      this.setLongPressMs(s.longPressMs);
    }
    if (typeof s.shakeScale === 'number' && Number.isFinite(s.shakeScale)) {
      this.setShakeScale(s.shakeScale);
    }
  }

  // ==================== 卸载 ====================

  /**
   * 卸载（P2）
   *
   * 【为什么需要有 destroy】
   * 本单元持有 `onChange` 回调。这个回调通常指向 UI 层的闭包，
   * 闭包又持有 UI 节点/组件。设置界面销毁后，如果不主动断开，
   * 实例还活着 → 闭包还活着 → 整棵 UI 子树无法被回收。
   * 表现是"切几次设置界面就涨几 MB"，且不报任何错。
   *
   * 【为什么不断开就不行】
   * 没有 install / 没有定时器，看起来"没什么可清理的"，
   * 于是很容易认为 destroy 是空方法而省略它——
   * 真正要清的就是这一个引用。
   */
  destroy(): void {
    this._onChange = undefined;
  }
}
