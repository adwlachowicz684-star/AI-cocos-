/**
 * wave-spawner/WaveSpawner.ts —— 波次刷怪
 *
 * 【它解决什么】
 *
 * 进入房间 → 刷第一波怪 → 打完 → 刷第二波 → 打完 → 开门。
 *
 * 听起来简单，实际是一堆琐事：
 * - 一波几个、间隔多久、什么时候开始下一波
 * - 一帧里生成 20 个会不会卡
 * - **怪卡在地图外了，永远清不完，门打不开怎么办**
 *
 * 最后一条是**每个动作游戏都会遇到的 bug**，
 * 而且它在开发期很难复现（要怪正好卡在墙缝里），
 * 上线后一定会被玩家撞到，然后卡死在一个房间里。
 *
 * 【本模块的核心承诺：永远不会卡住】
 *
 * 三重兜底：
 * 1. **波次超时**：一波开始 N 秒还没清完 → 强制推进
 * 2. **单体超时**：某个实体存活超过 N 秒 → 单独清除
 * 3. **总超时**：整场战斗超过 N 秒 → 强制结束
 *
 * 任一触发都会让流程继续，玩家永远不会卡死。
 *
 * 【零业务依赖】
 *
 * 它不认识「敌人」「怪物」。生成的只是 `entryId`（字符串），
 * 由业务决定这个 id 对应什么。
 * 生成动作、存活判定全部通过 `ISpawnSink` 接口注入。
 */

import { IRandomSource, MathRandomSource } from '../_core/types';
import { clampNum, safeDt } from '../_core/math';
import { needCount } from '../_core/guard';

// ============================================================
// 数据结构
// ============================================================

/**
 * 生成的实体句柄
 *
 * 【alive 由谁维护】
 * 业务创建实体后在 `dead()` 时把 `alive` 置 false，
 * 或调用 `spawner.notifyDead(id)`。
 *
 * **两种方式都支持**，因为：
 * - 只靠通知：业务某处忘了调就永远清不掉（这是最经典的卡关来源）
 * - 只靠轮询：要额外维护 alive 标志
 *
 * 双保险下任意一种生效即可。
 */
export interface SpawnHandle {
  /** 唯一 id */
  readonly id: number;
  /** 是否存活 */
  alive: boolean;
  /** 已存活时长（秒，由 spawner 维护） */
  age: number;
  /** 所属波次序号 */
  readonly waveIndex: number;
  /** 业务数据（原样透传，例如实体引用） */
  data?: unknown;
}

/** 一波的生成条目 */
export interface WaveEntry {
  /** 生成什么（业务定义的 id） */
  readonly id: string;
  /** 生成几个 */
  readonly count: number;
  /**
   * 本条目的生成延迟（相对波次开始）
   *
   * 【用途】远程兵晚一点出，给玩家反应时间
   */
  readonly delay?: number;
  /**
   * 同一条目内每个之间的间隔
   *
   * 【用途】一次性涌出 10 个近战会瞬间围死玩家。
   * 给 0.15s 间隔，玩家能逐个应对。
   */
  readonly interval?: number;
  /** 业务数据（透传给 spawn 回调） */
  readonly data?: unknown;
}

/** 波次定义 */
export interface WaveDef {
  /** 波次 id（用于事件与调试） */
  readonly id: string;
  readonly entries: readonly WaveEntry[];
  /**
   * 进入下一波的条件
   *
   * - `'cleared'`（默认）：当前波全灭才进下一波
   * - `'timeout'`：固定时间后进入（不等清完）
   * - `'cleared-or-timeout'`：先满足哪个算哪个 ← **最稳**
   */
  readonly nextOn?: 'cleared' | 'timeout' | 'cleared-or-timeout';
  /**
   * 波次超时（秒）
   *
   * 【nextOn 含 timeout 时必填】否则退化成 cleared
   */
  readonly timeout?: number;
  /**
   * 本波开始前的延迟（秒）
   *
   * 【用途】玩家刚进房间时给 0.5s 看清场地再刷怪，
   * 不然一进门就被贴脸，非常劝退。
   */
  readonly preDelay?: number;
}

// ============================================================
// 生成接口（注入）
// ============================================================

/**
 * 生成回调
 *
 * 【为什么注入而不是内置】
 * 生成意味着"创建实体、摆位置、播特效"——
 * 这些全是引擎和业务相关的。
 * 注入之后，同一套波次逻辑能用于：
 * 地牢刷怪、塔防出兵、弹幕发射、甚至是"生成掉落物"。
 */
export interface ISpawnSink {
  /**
   * 生成一个实体
   *
   * @param entryId 生成什么
   * @param indexInEntry 本条目内的第几个（0 开始，用于选生成点）
   * @param waveIndex 第几波
   * @param data 条目携带的业务数据
   * @returns 句柄；返回 null 表示生成失败（spawner 会跳过它，不会卡住）
   */
  spawn(entryId: string, indexInEntry: number, waveIndex: number, data?: unknown): SpawnHandle | null;

  /**
   * 强制清除（超时兜底时调用）
   *
   * 【为什么需要】
   * 怪卡在地图外时，玩家打不到它。
   * 必须有一种方式让它消失——这就是。
   *
   * 常见实现：淡出 + 销毁，或对卡住的怪直接传送到场地中央。
   */
  forceKill?(handle: SpawnHandle, reason: RemoveReason): void;
}

/** 清除原因 */
export type RemoveReason = 'dead' | 'wave-timeout' | 'stuck' | 'total-timeout' | 'abort';

// ============================================================
// 配置
// ============================================================

export interface WaveSpawnerOptions {
  readonly waves: readonly WaveDef[];
  readonly spawn: ISpawnSink;
  rng?: IRandomSource;

  /**
   * 全局波次超时（秒）。默认 60
   *
   * 【怎么设】
   * 取"正常打完这波需要的时间"的 2~3 倍。
   * 太短：玩家打得慢就被强制推进，像被赶着走
   * 太长：卡住时玩家要等很久
   *
   * 一波普通怪通常 20~40 秒，所以 60 是合理默认。
   */
  waveTimeout?: number;

  /**
   * 单体存活超时（秒）。默认 0（关闭）
   *
   * 【为什么需要单独一个】
   * 波次超时只解决"整波卡住"。
   * 如果一波 10 个里只有 1 个卡住，
   * 玩家会追着它满地图跑——体验更差。
   *
   * 建议设为波次超时的 1/2（例如 30 秒）。
   */
  entityTimeout?: number;

  /**
   * 整场总超时（秒）。默认 0（关闭）
   *
   * 所有波打完的硬上限。用于"限时挑战"类玩法。
   */
  totalTimeout?: number;

  /**
   * 每帧最多生成几个。默认 0（不限）
   *
   * 【什么时候要限】
   * 一波 20 个怪同时生成：
   * - 实体创建、组件初始化、寻路计算全挤在一帧
   * - 表现为"进房间时卡一下"
   *
   * 设 3~5 个/帧，玩家看到的是"陆续冒出来"，反而更有压迫感。
   */
  maxSpawnsPerFrame?: number;

  // ---- 事件 ----
  onWaveStart?: (waveIndex: number, wave: WaveDef) => void;
  onWaveClear?: (waveIndex: number, timeUsed: number) => void;
  onAllClear?: (totalTime: number) => void;
  /** 触发了任意兜底（**这是需要报警的信号**） */
  onFallback?: (info: FallbackInfo) => void;
  /** 某个波次的所有实体已生成完毕 */
  onWaveSpawned?: (waveIndex: number) => void;
}

export interface FallbackInfo {
  readonly type: 'wave-timeout' | 'stuck' | 'total-timeout';
  readonly waveIndex: number;
  readonly aliveCount: number;
  readonly elapsed: number;
  /** 被强制清除的实体 id */
  readonly killed: readonly number[];
}

// ============================================================
// 状态
// ============================================================

export type WaveState = 'idle' | 'pre-delay' | 'spawning' | 'fighting' | 'cleared' | 'aborted';

// ============================================================
// 实现
// ============================================================

interface PendingSpawn {
  readonly entryId: string;
  readonly waveIndex: number;
  readonly data: unknown | undefined;
  readonly indexInEntry: number;
  at: number;
}


export class WaveSpawner {
  private readonly _waves: readonly WaveDef[];
  private readonly _sink: ISpawnSink;
  private readonly _rng: IRandomSource;
  private readonly _waveTimeout: number;
  private readonly _entityTimeout: number;
  private readonly _totalTimeout: number;
  private readonly _maxPerFrame: number;

  private _state: WaveState = 'idle';
  private _waveIndex = -1;
  private _waveTime = 0;
  private _preDelay = 0;
  private _totalTime = 0;
  private _nextHandleId = 1;

  /** 当前波已生成的实体 */
  private readonly _alive = new Map<number, SpawnHandle>();
  /** 待生成队列（按时间排序插入） */
  private readonly _pending: PendingSpawn[] = [];
  /** 本波是否已全部生成完毕 */
  private _spawnDone = false;
  /** 本波计划生成总数 */
  private _plannedCount = 0;
  /** 本波实际生成数 */
  private _spawnedCount = 0;
  private _aborted = false;

  constructor(opts: WaveSpawnerOptions) {
    this._waves = opts.waves;
    this._sink = opts.spawn;
    this._rng = opts.rng ?? MathRandomSource;
    /**
     * 【⚠️ 三重兜底，开箱只启用一重】
     *
     * 文档写的是「三重兜底：① 波次超时 ② 单体超时 ③ 总超时」，
     * 但 ② ③ 的默认值是 0 = **关闭**，需要调用方显式开启。
     *
     * 保持 0 是刻意的（避免打扰正常玩法），
     * 但生产环境建议至少开 ②——单体超时能兜住"怪卡在墙缝里"这类情况。
     */
    this._waveTimeout = opts.waveTimeout ?? 60;
    this._entityTimeout = opts.entityTimeout ?? 0;
    this._totalTimeout = opts.totalTimeout ?? 0;
    this._maxPerFrame = clampNum(opts.maxSpawnsPerFrame, 0, 1e5, 0);

    this.onWaveStart = opts.onWaveStart;
    this.onWaveClear = opts.onWaveClear;
    this.onAllClear = opts.onAllClear;
    this.onFallback = opts.onFallback;
    this.onWaveSpawned = opts.onWaveSpawned;
  }

  // 事件（公开可重新赋值，方便先构造再挂监听）
  onWaveStart?: (waveIndex: number, wave: WaveDef) => void;
  onWaveClear?: (waveIndex: number, timeUsed: number) => void;
  onAllClear?: (totalTime: number) => void;
  onFallback?: (info: FallbackInfo) => void;
  onWaveSpawned?: (waveIndex: number) => void;

  // ---- 查询 ----

  get state(): WaveState {
    return this._state;
  }

  get currentWaveIndex(): number {
    return this._waveIndex;
  }

  /** 当前波存活的实体数 */
  get aliveCount(): number {
    return this._alive.size;
  }

  /** 本波还剩几个没生成 */
  get pendingCount(): number {
    return this._pending.length;
  }

  get totalTime(): number {
    return this._totalTime;
  }

  get waveTime(): number {
    return this._waveTime;
  }

  /** 是否已全部完成（不论正常清完还是兜底） */
  get finished(): boolean {
    return this._state === 'cleared' || this._state === 'aborted';
  }

  /** 存活实体（只读视图，调试用） */
  aliveHandles(): readonly SpawnHandle[] {
    return [...this._alive.values()];
  }

  // ---- 控制 ----

  /** 开始（从头） */
  start(): void {
    this.reset();
    this._state = 'pre-delay';
    this._waveIndex = 0;
    this._waveTime = 0;
    this._preDelay = this._waves[0]?.preDelay ?? 0;
    if (this._preDelay <= 0) this._beginWave();
  }

  /** 重置到未开始 */
  reset(): void {
    for (const h of this._alive.values()) {
      this._sink.forceKill?.(h, 'abort');
    }
    this._alive.clear();
    this._pending.length = 0;
    this._state = 'idle';
    this._waveIndex = -1;
    this._waveTime = 0;
    this._preDelay = 0;
    this._totalTime = 0;
    this._spawnDone = false;
    this._plannedCount = 0;
    this._spawnedCount = 0;
    this._aborted = false;
  }

  /**
   * 放弃（玩家死亡、离开房间）
   *
   * 【为什么单独一个方法而不是 reset】
   * reset 会清状态但不触发事件；
   * abort 会强制清除所有实体并置为 aborted，
   * 让外部知道"这次没打完"。
   */
  abort(): void {
    for (const h of this._alive.values()) {
      this._sink.forceKill?.(h, 'abort');
    }
    this._alive.clear();
    this._pending.length = 0;
    this._state = 'aborted';
    this._aborted = true;
  }

  /** 通知某个实体已死亡（业务主动调用） */
  notifyDead(id: number): boolean {
    return this._alive.delete(id);
  }

  /**
   * 强制清完当前波（调试指令 / 应急）
   *
   * 【用途】
   * 开发期绑定到一个快捷键，测试关卡流程时不用真的打完。
   */
  forceClearWave(): void {
    const killed: number[] = [];
    for (const h of this._alive.values()) {
      this._sink.forceKill?.(h, 'dead');
      killed.push(h.id);
    }
    this._alive.clear();
    this._pending.length = 0;
    this._advanceWave();
  }

  // ---- 主循环 ----

  tick(dt: number): void {
    if (this._state === 'idle' || this._state === 'cleared' || this._state === 'aborted') return;
    if (!safeDt(dt)) return;      // dt=0（暂停）不推进；NaN/Infinity/负数全部拦掉

    this._totalTime += dt;

    // ① 总超时（最高优先级）
    if (this._totalTimeout > 0 && this._totalTime >= this._totalTimeout) {
      this._fireFallback('total-timeout');
      return;
    }

    // ② 进入延迟
    if (this._state === 'pre-delay') {
      this._preDelay -= dt;
      if (this._preDelay <= 0) this._beginWave();
      return;
    }

    if (this._waveIndex < 0 || this._waveIndex >= this._waves.length) return;

    this._waveTime += dt;

    // ③ 生成队列
    this._processPending();
    if (this.finished || this._waveIndex >= this._waves.length) return;

    // ④ 更新存活时长 + 单体超时
    //
    // 【⚠️ 曾经的 bug：这里会推进波次，之后又去读 this._waves[_waveIndex]】
    // 单体超时清掉最后一个卡住的怪 → _finishWave → _advanceWave
    // → waveIndex 已经 +1（可能越界）→ 下面读 wave 得到 undefined
    // → "Cannot read properties of undefined (reading 'nextOn')"
    //
    // 症状：清完最后一波的瞬间崩溃，且只在"有怪卡住"时复现——
    // 开发期几乎碰不到，上线后必然出现。
    //
    // 所以每一步可能改变 waveIndex 的操作之后，都要重新检查边界。
    this._ageEntities(dt);
    if (this.finished || this._waveIndex >= this._waves.length) return;

    // ⑤ 清理已死的（双保险：业务可能只置了 alive=false 没通知）
    for (const [id, h] of this._alive) {
      if (!h.alive) this._alive.delete(id);
    }

    // ⑥ 波次超时兜底
    const wave = this._waves[this._waveIndex];
    /**
     * 【`wave.nextOn` 不再参与超时判定】
     * 修复前它在这里被用来分出两个分支，导致 cleared 模式忽略波次自带的
     * `timeout`（详见下面 `waveTimeout` 的注释）。
     * 现在三种模式共用同一条超时规则，"清完才进 / 到点就进"的差异
     * 由下面的 `_finishWave` 与 `_fireFallback` 各自表达。
     */
    /**
     * 【⚠️ waveTimeout 必须 > 0 才生效，否则传 0 语义会反转】
     *
     * 三个超时参数对 0 的处理早期不一致：
     *   totalTimeout  → `> 0 &&`  传 0 = 关闭 ✅
     *   entityTimeout → `<= 0 return` 传 0 = 关闭 ✅
     *   waveTimeout   → 直接 `>=`，传 0 = **每帧都满足** ❌
     *
     * 调用方传 0 的意图通常是「关闭超时」，
     * 结果波次被瞬间推进/清空。实测一次 tick 就跳波。
     */
    /**
     * 【⚠️ 为什么两个分支合并，且 cleared 模式也用 `waveTimeout`】
     *
     * 老代码是两个互斥分支：
     * - 非 cleared 模式用 `waveTimeout`（波次自带 `timeout` 优先，回退全局）
     * - cleared 模式用 **`this._waveTimeout`（只认全局值）**
     *
     * 于是波次自带的 `timeout` 在 `nextOn: 'cleared'` 下**完全失效**：
     *
     * 实测（修复前）：
     * ```
     * wave.timeout = 5，全局 waveTimeout = 60，nextOn = 'cleared'
     *   跑 20 秒后是否触发兜底 = false    state = fighting
     * 同一配置改成 nextOn = 'timeout' → 兜底类型 = wave-timeout（正常）
     * ```
     *
     * 后果：README 明确写 `cleared` = "全灭才进（**最常见**，配合 `timeout` 兜底）"，
     * 且本文件 §131 也写"cleared 模式也有 waveTimeout 兜底"。
     * 实际却只有全局值生效——波次卡住时要等 **60 秒**（默认值）才推进，
     * 玩家表现为"打完怪但门不开"，而这恰恰是本单元要根除的问题。
     * `cleared` 是最常用模式，所以影响面最大。
     *
     * 【为什么合并成一个条件而不是改 L484 那一行】
     * 两个分支的条件在修复后完全一致（`waveTimeout > 0 && _waveTime >= waveTimeout`），
     * 分成两只会让"到底哪个生效"再次变成一个需要推理的问题。
     * `mode` 在兜底判定里已经不再有区分作用——
     * 区分"清完才进 / 到点就进"的是下面的 `_finishWave` 逻辑，不是超时。
     */
    const waveTimeout = wave.timeout ?? this._waveTimeout;
    if (waveTimeout > 0 && this._waveTime >= waveTimeout) {
      this._fireFallback('wave-timeout');
      return;
    }

    // ⑦ 判定清完
    if (this._spawnDone && this._alive.size === 0 && this._pending.length === 0) {
      this._finishWave();
    }
  }

  // ---- 内部 ----

  private _beginWave(): void {
    const wave = this._waves[this._waveIndex];
    if (!wave) {
      this._state = 'cleared';
      return;
    }

    this._state = 'spawning';
    this._waveTime = 0;
    this._spawnDone = false;
    this._plannedCount = 0;
    this._spawnedCount = 0;

    // 展开生成队列
    for (const entry of wave.entries) {
      const delay = Math.max(0, entry.delay ?? 0);
      const interval = Math.max(0, entry.interval ?? 0);
      /**
       * 【⚠️ count 必须有上界】
       *
       * 它直接就是下面这个 push 循环的次數，且每个元素都会常驻
       * `_pending` 队列直到生成。实测 `count: Infinity`：
       * 退出码 124（卡死），且在卡死前会先吃光内存——
       * 因为每次 push 都往数组里塞一个对象。
       *
       * 波次配置常来自关卡编辑器或配置表，属于外部输入。
       */
      const count = needCount(entry.count, `wave[${wave.id}].entry[${entry.id}].count`);
      for (let i = 0; i < count; i++) {
        this._pending.push({
          entryId: entry.id,
          waveIndex: this._waveIndex,
          data: entry.data,
          indexInEntry: i,
          at: delay + i * interval,
        });
        this._plannedCount++;
      }
    }
    // 按时间排序（O(n log n)，一次性的，不必用堆）
    this._pending.sort((a, b) => a.at - b.at);

    this.onWaveStart?.(this._waveIndex, wave);
  }

  /**
   * 处理待生成队列
   *
   * 【为什么不需要 dt】
   * `PendingSpawn.at` 存的是"相对波次开始的**绝对时刻**"，
   * 直接和 `_waveTime` 比较即可，不用逐帧递减。
   *
   * 这样即使一帧 dt 很大（掉帧），也不会漏掉任何一次生成。
   */
  private _processPending(): void {
    let budget = this._maxPerFrame > 0 ? this._maxPerFrame : Infinity;

    // 【为什么用 while 而不是 for】
    // 多个 pending 可能在同一时刻到期（interval = 0），
    // 用 for 会漏掉后面那些。
    while (this._pending.length > 0 && budget > 0) {
      const p = this._pending[0];
      if (p.at > this._waveTime) break;

      this._pending.shift();
      budget--;

      const h = this._sink.spawn(p.entryId, p.indexInEntry, p.waveIndex, p.data);
      if (h) {
        // 【alive 初值保护】
        // 业务可能返回一个 alive=false 的句柄（例如生成点被占用），
        // 直接丢弃，不进入存活表。
        if (h.alive !== false) this._alive.set(h.id, h);
      }
      /**
       * 【⚠️ 为什么"生成失败也计数"是对的，但老注释的**理由**是错的】
       *
       * 老注释写："返回 null 也要计数，否则生成失败会让 `_spawnDone` 永远不成立"。
       *
       * 这个因果不成立：`_spawnDone` 的判定是 `this._pending.length === 0`
       * （见下面 ⑥ 之后的分支），走的是 pending 队列，**从不读 `_spawnedCount`**。
       * 把计数去掉，`_spawnDone` 照样会正常置位。
       *
       * 所以"必须计数"这个结论**不能靠那条理由支撑**——
       * 这正是本库反复强调的"注释前提是假的"：结论对，归因错。
       * 下次有人看到 `_spawnedCount` 与 `_plannedCount` 对不上
       * （生成失败时前者偏大）而"顺手修正"它，就会把一个无害的计数器
       * 改成一个**语义混乱的计数器**。
       *
       * 真正的口径：`_spawnedCount` 记的是"已**处理**的 pending 数"
       * （含生成失败），`_plannedCount` 记的是"计划生成的总数"。
       * 两者之差 = 生成失败的数量，这本身就是有意义的信息。
       */
      this._spawnedCount++;
    }

    if (this._pending.length === 0 && !this._spawnDone) {
      this._spawnDone = true;
      this.onWaveSpawned?.(this._waveIndex);
      if (this._alive.size === 0) {
        this._finishWave();
        return;
      }
      this._state = 'fighting';
    } else if (this._state === 'spawning' && this._pending.length > 0) {
      // 还在生成
    } else if (this._spawnDone && this._alive.size > 0) {
      this._state = 'fighting';
    }
    void this._spawnedCount;
    void this._plannedCount;
  }

  private _ageEntities(dt: number): void {
    if (this._entityTimeout <= 0) {
      for (const h of this._alive.values()) h.age += dt;
      return;
    }

    const stuck: SpawnHandle[] = [];
    for (const h of this._alive.values()) {
      h.age += dt;
      if (h.age >= this._entityTimeout) stuck.push(h);
    }

    if (stuck.length > 0) {
      for (const h of stuck) {
        this._sink.forceKill?.(h, 'stuck');
        this._alive.delete(h.id);
      }
      this._fireFallback('stuck', stuck.map((h) => h.id));
    }
  }

  private _finishWave(): void {
    const used = this._waveTime;
    this.onWaveClear?.(this._waveIndex, used);
    this._advanceWave();
  }

  private _advanceWave(): void {
    this._waveIndex++;
    if (this._waveIndex >= this._waves.length) {
      this._state = 'cleared';
      this.onAllClear?.(this._totalTime);
      return;
    }
    this._preDelay = this._waves[this._waveIndex].preDelay ?? 0;
    if (this._preDelay > 0) {
      this._state = 'pre-delay';
    } else {
      this._beginWave();
    }
  }

  private _fireFallback(type: FallbackInfo['type'], killedIds?: number[]): void {
    const killed: number[] = killedIds ? [...killedIds] : [];

    if (type !== 'stuck') {
      for (const h of this._alive.values()) {
        this._sink.forceKill?.(h, type === 'total-timeout' ? 'total-timeout' : 'wave-timeout');
        killed.push(h.id);
      }
      this._alive.clear();
      this._pending.length = 0;
    }

    const info: FallbackInfo = {
      type,
      waveIndex: this._waveIndex,
      aliveCount: killed.length,
      elapsed: this._waveTime,
      killed,
    };
    this.onFallback?.(info);

    if (type === 'total-timeout') {
      // 总超时：整场结束
      this._pending.length = 0;
      this._alive.clear();
      this._state = 'cleared';
      this._aborted = true;
      return;
    }

    // stuck 之后仍要检查是否清完（可能这就是最后一个卡住的）
    if (this._spawnDone && this._alive.size === 0 && this._pending.length === 0) {
      this._finishWave();
      return;
    }
    if (type === 'wave-timeout') {
      this._advanceWave();
    }
  }

  /** 内部：生成序号（业务可在 spawn 回调里用它当 id） */
  nextHandleId(): number {
    return this._nextHandleId++;
  }

  get aborted(): boolean {
    return this._aborted;
  }

  /** 未使用的 rng 保留给未来的随机波次特性 */
  protected get rng(): IRandomSource {
    return this._rng;
  }
}
