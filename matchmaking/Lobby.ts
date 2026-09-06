/**
 * matchmaking/Lobby.ts —— 房间与组队
 *
 * 【它解决什么】
 *
 * 撮合器负责把陌生人凑一起，房间负责把朋友凑一起。
 * 手写的房间是一个 `players[]`，然后你会遇到：
 *
 * 1. **房主走了没人能开局**
 *    房主断线或者退出，剩下的人对着"开始游戏"按钮点了半天没反应。
 *    → 必须有房主迁移。
 *
 * 2. **有人没准备也能开局**
 *    5 个人只有 4 个点了准备，房主手滑点了开始。
 *    → 必须显式检查全员准备。
 *
 * 3. **人数不足也能开局**
 *    3v3 的模式里 2 个人就开了，进去发现对不上。
 *    → 必须检查最低人数。
 *
 * 4. **踢人后状态残留**
 *    踢掉的人还在 ready 集合里，导致"全员已准备"判断一直为假。
 *
 * 【零业务依赖】
 */

// ==================== 类型 ====================

export interface LobbyPlayer {
  readonly id: string;
  readonly name?: string;
  /** 附加数据（等级、头像、角色…） */
  readonly meta?: unknown;
}

export interface LobbyConfig {
  /** 房间容量 */
  readonly capacity: number;
  /** 开局所需的最少人数（默认等于 capacity） */
  readonly minPlayers?: number;
  /** 是否需要全员准备才能开局（默认 true） */
  readonly requireAllReady?: boolean;
  /** 房间密码。留空表示无密码 */
  readonly password?: string;
}

export type LobbyState = 'open' | 'starting' | 'closed';

export interface LobbySlot {
  readonly player: LobbyPlayer;
  readonly ready: boolean;
  readonly isHost: boolean;
  readonly joinedAt: number;
}

export type LobbyJoinError =
  | 'full'
  | 'duplicate'
  | 'closed'
  | 'wrong-password'
  | 'started';

export interface LobbyJoinResult {
  readonly ok: boolean;
  readonly error?: LobbyJoinError;
}

// ==================== 实现 ====================

export class Lobby {
  private readonly _capacity: number;
  private readonly _minPlayers: number;
  private readonly _requireAllReady: boolean;

  private _players: LobbyPlayer[] = [];
  private readonly _ready = new Set<string>();
  private readonly _joinedAt = new Map<string, number>();
  private _hostId: string | null = null;
  private _password: string | undefined;
  private _state: LobbyState = 'open';
  private _revision = 0;

  constructor(cfg: LobbyConfig) {
    if (!Number.isInteger(cfg.capacity) || cfg.capacity < 1) {
      throw new Error(`[Lobby] capacity 必须是正整数，收到 ${cfg.capacity}`);
    }
    this._capacity = cfg.capacity;
    this._minPlayers = cfg.minPlayers ?? cfg.capacity;
    this._requireAllReady = cfg.requireAllReady ?? true;
    this._password = cfg.password;

    if (this._minPlayers > this._capacity) {
      throw new Error(
        `[Lobby] 最低人数 ${this._minPlayers} 超过容量 ${this._capacity}`
      );
    }
  }

  // ==================== 查询 ====================

  get capacity(): number {
    return this._capacity;
  }

  get size(): number {
    return this._players.length;
  }

  get isFull(): boolean {
    return this._players.length >= this._capacity;
  }

  get isEmpty(): boolean {
    return this._players.length === 0;
  }

  get hostId(): string | null {
    return this._hostId;
  }

  get state(): LobbyState {
    return this._state;
  }

  /**
   * 版本号，每次房间状态变化 +1
   *
   * 【用途】客户端做脏检查：版本号没变就不用重绘 UI。
   */
  get revision(): number {
    return this._revision;
  }

  get players(): readonly LobbyPlayer[] {
    return [...this._players];
  }

  /** 带状态的槽位列表（UI 直接遍历这个） */
  get slots(): readonly LobbySlot[] {
    return this._players.map((p) => ({
      player: p,
      ready: this._ready.has(p.id),
      isHost: p.id === this._hostId,
      joinedAt: this._joinedAt.get(p.id) ?? 0,
    }));
  }

  has(id: string): boolean {
    return this._players.some((p) => p.id === id);
  }

  isReady(id: string): boolean {
    return this._ready.has(id);
  }

  isHost(id: string): boolean {
    return id === this._hostId;
  }

  get readyCount(): number {
    return this._ready.size;
  }

  // ==================== 加入 / 离开 ====================

  join(player: LobbyPlayer, password?: string, now = 0): LobbyJoinResult {
    if (this._state !== 'open') {
      return { ok: false, error: this._state === 'starting' ? 'started' : 'closed' };
    }
    if (this.has(player.id)) {
      return { ok: false, error: 'duplicate' };
    }
    if (this.isFull) {
      return { ok: false, error: 'full' };
    }
    if (this._password !== undefined && this._password !== password) {
      return { ok: false, error: 'wrong-password' };
    }

    this._players.push(player);
    this._joinedAt.set(player.id, now);

    // 第一个进来的人是房主
    if (this._hostId === null) this._hostId = player.id;

    this._revision++;
    return { ok: true };
  }

  /**
   * 离开
   *
   * @returns 是否成功
   */
  leave(id: string): boolean {
    const i = this._players.findIndex((p) => p.id === id);
    if (i < 0) return false;

    this._players.splice(i, 1);
    this._ready.delete(id);
    this._joinedAt.delete(id);

    // ⚠️ 房主走了必须迁移，否则没人能开局
    if (this._hostId === id) {
      this._hostId = this._players.length > 0 ? this._players[0].id : null;
    }

    this._revision++;
    return true;
  }

  /** 房主踢人 */
  kick(operatorId: string, targetId: string): boolean {
    if (!this.isHost(operatorId)) return false;
    if (operatorId === targetId) return false;
    return this.leave(targetId);
  }

  /** 转移房主 */
  transferHost(operatorId: string, targetId: string): boolean {
    if (!this.isHost(operatorId)) return false;
    if (!this.has(targetId)) return false;
    this._hostId = targetId;
    this._revision++;
    return true;
  }

  // ==================== 准备 ====================

  setReady(id: string, ready: boolean): boolean {
    if (!this.has(id)) return false;
    if (this._state !== 'open') return false;

    /**
     * 【⚠️ 用 Set 而不是数组】
     * 数组的话重复设置会 push 两次，
     * 表现为"我取消准备再准备，系统说还有人没准备"。
     */
    if (ready) this._ready.add(id);
    else this._ready.delete(id);

    this._revision++;
    return true;
  }

  toggleReady(id: string): boolean {
    return this.setReady(id, !this._ready.has(id));
  }

  /** 全部取消准备（换模式/换图时用） */
  resetReady(): void {
    this._ready.clear();
    this._revision++;
  }

  // ==================== 开局 ====================

  /**
   * 能否开局
   *
   * 【三个条件缺一不可】
   * 1. 人数够
   * 2. 全员已准备（若 requireAllReady）
   * 3. 房间还在 open 状态（防止重复开局）
   */
  canStart():
    | { ok: true }
    | { ok: false; reason: 'too-few' | 'not-all-ready' | 'already-started' } {
    if (this._state !== 'open') return { ok: false, reason: 'already-started' };
    if (this._players.length < this._minPlayers) {
      return { ok: false, reason: 'too-few' };
    }
    if (this._requireAllReady && this._ready.size < this._players.length) {
      return { ok: false, reason: 'not-all-ready' };
    }
    return { ok: true };
  }

  /** 开局失败的具体原因（UI 提示用） */
  startBlockReason(): string | null {
    const r = this.canStart();
    if (r.ok) return null;
    switch (r.reason) {
      case 'too-few':
        return `还需要 ${this._minPlayers - this._players.length} 人`;
      case 'not-all-ready':
        return `还有 ${this._players.length - this._ready.size} 人未准备`;
      case 'already-started':
        return '游戏已开始';
      default: {
        //
        // 【为什么必须有 default】
        // 函数声明返回 `string | null`，而 switch 没有兜底分支时，
        // 一旦 canStart() 将来新增一种 reason，这里会**静默返回 undefined**
        // —— 违反自己声明的返回类型，且 TS 在部分版本下不报错。
        // UI 拿到 undefined 会显示空白，玩家不知道为什么开不了局。
        //
        // 用穷尽检查把"漏处理新分支"变成编译期错误。
        const never: never = r.reason;
        return `无法开局（${String(never)}）`;
      }
    }
  }

  /**
   * 标记为开始中
   *
   * 【⚠️ 进入 starting 后不再接受加入/准备】
   * 否则会有玩家在加载界面时挤进来，
   * 表现为"进游戏后队伍里多了个陌生人"。
   */
  beginStart(): boolean {
    if (!this.canStart().ok) return false;
    this._state = 'starting';
    this._revision++;
    return true;
  }

  /** 加载完成，真正开局 */
  finishStart(): void {
    this._state = 'closed';
    this._revision++;
  }

  /** 解散房间 */
  close(): void {
    this._state = 'closed';
    this._revision++;
  }

  /** 重新开始（回到可加入状态，保留玩家但清空准备） */
  reopen(): void {
    this._state = 'open';
    this._ready.clear();
    this._revision++;
  }

  // ==================== 设置 ====================

  setPassword(operatorId: string, password: string | undefined): boolean {
    if (!this.isHost(operatorId)) return false;
    this._password = password;
    this._revision++;
    return true;
  }

  get hasPassword(): boolean {
    return this._password !== undefined;
  }

  // ==================== 快照 ====================

  snapshot(): {
    state: LobbyState;
    hostId: string | null;
    players: readonly LobbyPlayer[];
    ready: readonly string[];
    capacity: number;
    minPlayers: number;
    revision: number;
  } {
    return {
      state: this._state,
      hostId: this._hostId,
      players: this.players,
      ready: [...this._ready],
      capacity: this._capacity,
      minPlayers: this._minPlayers,
      revision: this._revision,
    };
  }
}
