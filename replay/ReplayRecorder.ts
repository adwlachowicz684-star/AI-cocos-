/**
 * ReplayRecorder —— 输入录制与回放
 *
 * 【它解决什么】
 *
 * 回放有两个完全不同的用途，容易混淆：
 *
 * **① 玩家向的回放**（精彩时刻、死亡回放、分享）
 * 录制输入 + 种子，能完整重现一局。
 * **优点：体积极小**（一局 10 分钟只录几百个输入事件）。
 *
 * **② 调试向的回放**（复现 bug）
 * 玩家报"我在第三层打 Boss 时闪退了"，
 * 有了输入序列你就能在本地精确重现。
 *
 * 【为什么录输入而不是录状态】
 * - 录状态：每帧几十 KB，10 分钟几百 MB
 * - 录输入：只有玩家操作时才有数据，一局可能就几千字节
 *
 * 【前提条件（重要）】
 * 回放要能重现，游戏必须是**确定性**的：
 * - 所有随机走带种子的 RNG（见 `rng/`）
 * - 不用 `Math.random()`、`Date.now()` 影响逻辑
 * - 帧率不影响逻辑（固定步长，见 `scheduler/`）
 *
 * 三者缺一，回放就会"漂移"——前 30 秒一致，之后越走越偏。
 *
 * 【使用示例】
 * ```typescript
 * // 录制
 * const rec = new ReplayRecorder({ seed: 12345 });
 * rec.start();
 *
 * // 游戏主循环（固定步长！）
 * for (let f = 0; f < 3600; f++) {
 *   const input = rec.playback(f) ?? pollRealInput();  // 回放优先
 *   world.step(input, FIXED_DT);
 *   rec.record(f, input);
 * }
 *
 * const data = rec.export();      // 可序列化，几 KB
 *
 * // 回放
 * const player = new ReplayRecorder({ seed: 12345 });
 * player.load(data);
 * for (let f = 0; f < data.frameCount; f++) {
 *   const input = player.playback(f)!;
 *   world.step(input, FIXED_DT);
 * }
 * ```
 *
 * 【无引擎依赖】
 */

/** 一帧的输入（由调用方定义具体内容） */
import { clampNum } from '../_core/math';
export type InputFrame = Record<string, number | boolean>;

export interface ReplayOptions {
  /** 世界种子（必须与录制时一致） */
  readonly seed?: number;
  /**
   * 输入变化才记录（默认 true）
   *
   * 【为什么】
   * 玩家按住前进键 300 帧，如果每帧都记，就是 300 条重复数据。
   * 只在输入**变化**时记一条，能省掉 95% 的体积。
   */
  readonly deltaOnly?: boolean;
  /** 最大帧数上限（防止无限录制撑爆内存） */
  readonly maxFrames?: number;
  /** 版本号（用于回放数据兼容性检查） */
  readonly version?: number;
}

export interface ReplayData {
  readonly version: number;
  readonly seed: number;
  /** 总帧数 */
  readonly frameCount: number;
  /** 关键帧：{ frame, input } */
  readonly keyframes: ReadonlyArray<{ frame: number; input: InputFrame }>;
  /** 附加元数据（角色、难度、地图……由调用方填） */
  readonly meta?: Record<string, unknown>;
}

const EMPTY_INPUT: InputFrame = {};

export class ReplayRecorder {
  private readonly _seed: number;
  private readonly _deltaOnly: boolean;
  private readonly _maxFrames: number;
  private readonly _version: number;

  private _keyframes: Array<{ frame: number; input: InputFrame }> = [];
  private _frame = 0;
  private _recording = false;
  private _lastInput: InputFrame = EMPTY_INPUT;

  /** 回放模式的数据 */
  private _data: ReplayData | null = null;
  private _keyIndex = 0;

  constructor(opts: ReplayOptions = {}) {
    this._seed = opts.seed ?? 0;
    this._deltaOnly = opts.deltaOnly ?? true;
    // 【为什么要 clampNum】
    //
    // 原写法 `opts.maxFrames ?? 200_000` 连 Math.max 都没有，
    // NaN / Infinity 会直接穿过。而停止录制的判定是
    // `length >= this._maxFrames`——NaN 参与 >= 比较恒为 false，
    // 于是**永不停止录制**，直到 OOM。
    //
    // 实测 record 30 次：maxFrames=10 → 停在 10；maxFrames=NaN → 30（未受限）。
    this._maxFrames = clampNum(opts.maxFrames, 1, 1e7, 200_000); // 约 55 分钟 @60fps
    this._version = opts.version ?? 1;
  }

  get seed(): number {
    return this._seed;
  }

  get frame(): number {
    return this._frame;
  }

  get isRecording(): boolean {
    return this._recording;
  }

  get isPlaying(): boolean {
    return this._data !== null;
  }

  /** 关键帧数量（体积的直接指标） */
  get keyframeCount(): number {
    return this._keyframes.length;
  }

  get recordedFrames(): number {
    return this._frame;
  }

  // ==================== 录制 ====================

  start(): void {
    this._keyframes = [];
    this._frame = 0;
    this._lastInput = EMPTY_INPUT;
    this._recording = true;
    this._data = null;
  }

  stop(): void {
    this._recording = false;
  }

  /**
   * 记录一帧
   *
   * @param frame 帧号（必须是固定步长的逻辑帧，不是渲染帧）
   * @param input 这一帧的输入
   */
  record(frame: number, input: InputFrame): void {
    if (!this._recording) return;

    this._frame = frame;

    if (this._deltaOnly) {
      if (sameInput(this._lastInput, input)) return; // 没变化，不记
      this._lastInput = { ...input };
    }

    if (this._keyframes.length >= this._maxFrames) {
      console.warn('[Replay] 达到最大帧数，停止录制');
      this._recording = false;
      return;
    }

    this._keyframes.push({ frame, input: { ...input } });
  }

  /**
   * 导出
   *
   * 【坑】必须存 `frameCount`。
   * 只存关键帧的话，最后一帧之后的部分会丢失——
   * 玩家最后 5 秒没操作（比如在看结算画面），回放就提前结束了。
   */
  export(meta?: Record<string, unknown>): ReplayData {
    const data: ReplayData = {
      version: this._version,
      seed: this._seed,
      frameCount: this._frame + 1,
      keyframes: this._keyframes.map((k) => ({ frame: k.frame, input: { ...k.input } })),
      ...(meta ? { meta: { ...meta } } : {}),
    };
    return data;
  }

  /** 序列化为 JSON 字符串 */
  exportJSON(meta?: Record<string, unknown>): string {
    return JSON.stringify(this.export(meta));
  }

  // ==================== 回放 ====================

  /**
   * 加载回放数据
   *
   * 【校验】版本和种子不匹配要明确报错。
   * 否则回放会"能播但结果不一样"——这是最难排查的一类问题，
   * 因为你以为回放是对的，实际是错的。
   */
  load(data: ReplayData): void {
    if (data.version !== this._version) {
      throw new Error(
        `[Replay] 版本不匹配：数据是 v${data.version}，当前播放器是 v${this._version}`
      );
    }
    if (this._seed !== 0 && data.seed !== this._seed) {
      throw new Error(
        `[Replay] 种子不匹配：数据是 ${data.seed}，当前是 ${this._seed}（回放会漂移）`
      );
    }
    this._data = data;
    this._keyIndex = 0;
    this._frame = 0;
    this._recording = false;
  }

  loadJSON(json: string): void {
    this.load(JSON.parse(json) as ReplayData);
  }

  /**
   * 取某一帧的输入
   *
   * @returns 该帧的输入。未开始回放或超出范围返回 undefined
   *
   * 【录制时同时回放】
   * 录制中调用这个方法会返回 undefined（表示"用真实输入"），
   * 这样你的主循环可以统一写 `rec.playback(f) ?? pollInput()`。
   */
  playback(frame: number): InputFrame | undefined {
    const data = this._data;
    if (!data) return undefined;
    if (frame < 0 || frame >= data.frameCount) return undefined;

    this._frame = frame;

    // 推进到 frame 所在的关键帧
    while (
      this._keyIndex + 1 < data.keyframes.length &&
      data.keyframes[this._keyIndex + 1].frame <= frame
    ) {
      this._keyIndex++;
    }
    // frame 落在第一个关键帧之前 → 还没有输入
    if (data.keyframes.length === 0) return EMPTY_INPUT;
    if (data.keyframes[this._keyIndex].frame > frame) return EMPTY_INPUT;

    return data.keyframes[this._keyIndex].input;
  }

  /** 回放是否结束 */
  get playbackDone(): boolean {
    return this._data !== null && this._frame >= this._data.frameCount - 1;
  }

  get totalFrames(): number {
    return this._data?.frameCount ?? 0;
  }

  /**
   * 跳转到指定帧
   *
   * 【坑】只能往前跳到关键帧，**无法任意 seek**。
   * 要精确跳到第 N 帧，必须从头模拟到第 N 帧。
   * 这是"只录输入"的固有代价——想要任意 seek 就得录状态快照。
   *
   * 折中方案：每 N 帧额外存一个状态快照（关键帧），
   * seek 时先恢复到最近的关键帧，再模拟几帧。
   */
  seek(frame: number): void {
    if (!this._data) return;
    this._frame = Math.max(0, Math.min(frame, this._data.frameCount - 1));
    this._keyIndex = 0;
    while (
      this._keyIndex + 1 < this._data.keyframes.length &&
      this._data.keyframes[this._keyIndex + 1].frame <= this._frame
    ) {
      this._keyIndex++;
    }
  }

  /** 估算体积（字节，JSON 近似） */
  estimateSize(): number {
    return JSON.stringify(this.export()).length;
  }

  reset(): void {
    this._keyframes = [];
    this._frame = 0;
    this._keyIndex = 0;
    this._data = null;
    this._recording = false;
    this._lastInput = EMPTY_INPUT;
  }

  destroy(): void {
    this.reset();
  }
}

function sameInput(a: InputFrame, b: InputFrame): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
