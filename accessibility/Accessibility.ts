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
  private readonly _onChange?: (key: string, value: unknown) => void;

  constructor(opts: AccessibilityOptions = {}) {
    this._reduceMotion = opts.reduceMotion ?? false;
    this._colorBlind = opts.colorBlind ?? 'none';
    this._fontScale = opts.fontScale ?? 1;
    this._highContrast = opts.highContrast ?? false;
    this._subtitles = opts.subtitles ?? false;
    this._subtitleSpeaker = opts.subtitleSpeaker ?? true;
    this._oneHanded = opts.oneHanded ?? 'off';
    this._longPressMs = opts.longPressMs ?? 600;
    this._shakeScale = opts.shakeScale ?? 1;
    this._onChange = opts.onChange;

    if (this._fontScale <= 0) {
      throw new Error(`[A11y] 字号缩放必须为正，收到 ${this._fontScale}`);
    }
    if (this._longPressMs < 0) {
      throw new Error(`[A11y] 长按阈值不能为负，收到 ${this._longPressMs}`);
    }
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
    switch (kind) {
      case 'shake':
      case 'sway':
      case 'flash':
        // 这三类是"减少动效"最核心要关掉的（前庭不适主要来源）
        return false;
      case 'transition':
      case 'autoCamera':
        return false;
      case 'particle':
      case 'loopAnim':
        // 装饰性表现可以保留（不引起不适），但由调用方决定是否减弱
        return true;
      default:
        return true;
    }
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
}
