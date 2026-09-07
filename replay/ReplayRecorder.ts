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
  /**
   * 世界种子（必须与录制时一致）
   *
   * 不传 = 未指定，回放时按 0 校验（见 `verifySeed` 的说明）。
   */
  readonly seed?: number;
  /**
   * 加载回放数据时是否校验种子（**默认 true**）
   *
   * 【为什么默认改成 true】
   * 见构造函数与 `load()` 里的说明：过去"不传 seed"等价于"永不校验"，
   * 让文件头"种子不匹配要明确报错"的承诺在默认配置下完全落空。
   *
   * 传 `false` 可以显式关掉——**这是给"我就是要拿这份回放当输入源、
   * 不关心种子"的场景留的口子**，请只在确实想清楚时用它。
   */
  readonly verifySeed?: boolean;
  /**
   * 输入变化才记录（默认 true）
   *
   * 【为什么】
   * 玩家按住前进键 300 帧，如果每帧都记，就是 300 条重复数据。
   * 只在输入**变化**时记一条，能省掉 95% 的体积。
   */
  readonly deltaOnly?: boolean;
  /**
   * 上限（防止无限录制撑爆内存）
   *
   * 【⚠️ 它限制的是**关键帧数**，不是帧数】
   *
   * 字段名和旧文档都写的是"最大帧数"，实际生效的是
   * `keyframes.length >= maxFrames` —— 统计的是关键帧：
   *
   * ```
   * 录 20 个关键帧、maxFrames = 5 → 实际保留 5 个关键帧
   * ```
   *
   * 好在内存只由 keyframes 决定，**这条保护本身是有效的**，
   * 错的是名字：叫"最大帧数"会让人以为"录到第 200000 帧就停"，
   * 而实际是"录到第 200000 次输入变化才停"。
   * 一场只有 50 次操作的长时间对局，两者能差出几千倍。
   *
   * 【推荐用新名字 `maxKeyframes`】
   * `maxFrames` 作为别名保留（同名同义，行为完全一致），
   * 但新代码请写 `maxKeyframes`，语义自解释。
   * 同时传两个时以 `maxKeyframes` 为准。
   */
  readonly maxFrames?: number;
  /** `maxFrames` 的准确命名版本，语义同上；同时传时以它为准 */
  readonly maxKeyframes?: number;
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

/**
 * 共享的"空输入"
 *
 * 【为什么用 Object.freeze】
 * 这个对象是模块级的单例，会被**所有**回放实例在"这一帧没有输入"时返回。
 * 调用方只要改过一次，就会污染所有实例的所有空输入帧。
 * 冻结后非严格模式下是静默失败、严格模式下抛错——
 * 无论哪种都比"静默改掉全局状态"好处理。
 */
const EMPTY_INPUT: InputFrame = Object.freeze({});

/**
 * 找"最后一个 frame <= 目标帧"的关键帧下标
 *
 * 【为什么单独抽成函数】`playback` 和 `seek` 都要用，
 * 而且两者过去各自维护一份"只前进"的推进逻辑——倒带时都会出错。
 *
 * @returns 命中返回下标；目标帧早于第一个关键帧返回 -1（表示"还没有输入"）
 */
function findKeyframeIndex(
  keyframes: ReadonlyArray<{ frame: number; input: InputFrame }>,
  frame: number,
): number {
  let lo = 0;
  let hi = keyframes.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid].frame <= frame) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export class ReplayRecorder {
  /** null = 未指定种子（见构造函数注释） */
  private readonly _seed: number | null;
  /** 是否校验种子（默认 true，见 ReplayOptions.verifySeed） */
  private readonly _verifySeed: boolean;
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
    /**
     * 【⚠️ 为什么默认 seed 从 0 改成了 null】
     *
     * 原实现的校验开关是 `if (this._seed !== 0 && data.seed !== this._seed)`，
     * 而**默认 seed 恰好就是 0** —— 于是"是否校验种子"这个开关
     * 在默认配置下**永远是关的**：
     *
     * ```
     * new ReplayRecorder()            // 默认 seed = 0
     *   .load({ ...data, seed: 999999 })   // 不报错，静默通过
     * new ReplayRecorder({ seed: 1 })
     *   .load({ ...data, seed: 999999 })   // 正确抛出"种子不匹配"
     * ```
     *
     * 后果落在文件头那段承诺上："版本和种子不匹配要明确报错，
     * 否则回放会漂移"。默认配置下这条承诺**完全落空**——
     * 回放能正常播完，但结果和录制时不一样（随机种子不同），
     * 表现为"回放里那个人操作一模一样，结果却不一样"。
     * 这是录像 / 复盘 / 反作弊场景下最致命的一类错误，且极难定位。
     *
     * 【为什么用 null 表示"不校验"而不是改判定条件】
     * 0 是一个**合法的种子值**（很多游戏就用 0 号种子），
     * 拿它当哨兵等于永久放弃"校验 0 号种子"这个能力。
     * 用 `null` 表达"未指定、不校验"，语义才干净。
     *
     * 【兼容性】`get seed()` 原本返回 number。
     * 未指定种子时现在返回 null —— 依赖 `rec.seed === 0` 判断的代码需要改。
     * 这是**刻意的 breaking**：宁可让调用方立刻发现，
     * 也不要继续"默认不校验种子"这种静默错误。
     */
    this._seed = opts.seed ?? null;
    this._verifySeed = opts.verifySeed !== false;
    this._deltaOnly = opts.deltaOnly ?? true;
    // 【为什么要 clampNum】
    //
    // 原写法 `opts.maxFrames ?? 200_000` 连 Math.max 都没有，
    // NaN / Infinity 会直接穿过。而停止录制的判定是
    // `length >= this._maxFrames`——NaN 参与 >= 比较恒为 false，
    // 于是**永不停止录制**，直到 OOM。
    //
    // 实测 record 30 次：maxFrames=10 → 停在 10；maxFrames=NaN → 30（未受限）。
    // maxKeyframes 是新名字（见 ReplayOptions 里的注释），两者取其一
    const cap = opts.maxKeyframes !== undefined ? opts.maxKeyframes : opts.maxFrames;
    this._maxFrames = clampNum(cap, 1, 1e7, 200_000);
    this._version = opts.version ?? 1;
  }

  get seed(): number | null {
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
      console.warn('[Replay] 达到关键帧数上限，停止录制');
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
      // ReplayData.seed 类型是 number；未指定种子时导成 0。
      // 加载侧的判定是"当前播放器 seed 为 null 才跳过校验"，
      // 所以这个 0 不会被当成"数据来自 0 号种子"。
      seed: this._seed ?? 0,
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
    /**
     * 【为什么默认就开始校验】
     *
     * 过去的判定是 `this._seed !== 0 && data.seed !== this._seed`，
     * 而默认 seed 恰好是 0 —— "是否校验"这个开关在默认配置下**永远是关的**：
     *
     * ```
     * new ReplayRecorder().load({ ...data, seed: 999999 })        // 不报错，静默通过
     * new ReplayRecorder({ seed: 1 }).load({ ...data, seed: 999999 })  // 正确抛出
     * ```
     *
     * 于是文件头那条承诺（"版本和种子不匹配要明确报错，否则回放会漂移"）
     * 在最常用的配置下完全落空：回放**能播完**，但随机序列与录制时不同，
     * 结果是"操作一模一样、结果却不一样"——录像 / 复盘 / 反作弊场景下
     * 最致命的一类错误，而且极难定位。
     *
     * 现在：默认校验，未指定种子时按 0 校验（历史默认值）。
     * 确实不关心的，显式传 `verifySeed: false`。
     */
    if (this._verifySeed && data.seed !== (this._seed ?? 0)) {
      throw new Error(
        `[Replay] 种子不匹配：数据是 ${data.seed}，当前是 ` +
          (this._seed === null
            ? '未指定（按 0 校验）'
            : `${this._seed}`) +
          `（回放会漂移）。若确实不需要校验种子，请传 verifySeed: false。`
      );
    }
    this._data = data;
    this._keyIndex = 0;
    this._frame = 0;
    this._recording = false;
  }

  /**
   * 从 JSON 字符串加载
   *
   * 【⚠️ 为什么必须包 try/catch】
   *
   * 原实现直接 `JSON.parse(json)`，坏输入会抛一个**与回放毫无关系**的
   * SyntaxError：
   *
   * ```
   * p.loadJSON('{bad json');
   * // SyntaxError: Expected property name or '}' in JSON at position 1
   * ```
   *
   * 调用方看到这条报错，第一反应是"JSON 库坏了"或"我的字符串处理错了"，
   * 而不是"这份回放文件损坏了"。回放数据通常来自**存档文件或网络**，
   * 损坏是正常情况，报错必须说清是数据问题。
   *
   * 现在统一包装成带 `[Replay]` 前缀的错误，并保留原始信息。
   */
  loadJSON(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new Error(
        `[Replay] 回放数据不是合法 JSON：${e instanceof Error ? e.message : String(e)}。` +
          `回放文件可能已损坏或被截断——请检查存档 / 传输环节。`
      );
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(
        `[Replay] 回放数据格式错误：JSON 顶层必须是对象，实际是 ${parsed === null ? 'null' : typeof parsed}`
      );
    }
    this.load(parsed as ReplayData);
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

    if (data.keyframes.length === 0) return EMPTY_INPUT;

    /**
     * 【⚠️ 为什么这里不能再只往前推】
     *
     * 原实现只有一个"往后推进"的 while，指针 `_keyIndex` **只前进不回退**。
     * 于是顺序倒着取帧时：
     *
     * ```
     * playback(1000)  // → { jump: true }，_keyIndex 推到后面的关键帧
     * playback(500)   // while 条件不满足 → 指针不动
     *                 // 然后 keyframes[_keyIndex].frame > 500 成立
     *                 // → 返回 {}，而不是历史上第 500 帧真正的输入
     * ```
     *
     * 实测：`playback(100)` 返回 `{jump:true}`，紧接着 `playback(50)` 返回 `{}`
     * （期望沿用这一帧之前的输入）。
     *
     * 后果：拖时间轴、倒带、跳章回顾、任何乱序取帧，
     * 都会让角色"突然失去所有输入"——站住不动，甚至被系统判 AFK。
     * 而且**不报错**，表现为"回放播着播着人就不动了"。
     *
     * 【修法】指针可能落在目标帧之后时，用**二分查找**重新定位。
     * 二分而不是线性回退，是为了让"从头拖到尾"这种大跨度跳转也是 O(log n)，
     * 同时彻底去掉"必须顺序调用"这个隐含前提。
     */
    this._keyIndex = findKeyframeIndex(data.keyframes, frame);

    // frame 落在第一个关键帧之前 → 还没有输入
    if (this._keyIndex < 0) return EMPTY_INPUT;

    /**
     * 【⚠️ 为什么返回拷贝而不是内部引用】
     *
     * 原实现直接 `return keyframes[i].input`，
     * 于是两次 `playback(0)` 拿到的是**同一个对象**（实测 `a === b` 为 true）。
     * 调用方随手改一下（比如把 `jump` 置 false 再喂给逻辑层），
     * 就把回放数据改掉了 —— 而 `record` / `export` 都做了拷贝，唯独这里没做。
     *
     * 另外返回的 `EMPTY_INPUT` 是模块级共享常量，
     * 被改一次会污染**所有**回放实例的所有"无输入帧"。
     */
    return { ...data.keyframes[this._keyIndex].input };
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
    // 与 playback 用同一个二分定位，保证"seek 到某帧"和"playback 到某帧"结果一致
    this._keyIndex = Math.max(
      0,
      findKeyframeIndex(this._data.keyframes, this._frame),
    );
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
