/**
 * SaveManager —— 存档读写（版本迁移 + 原子写 + 多槽位）
 *
 * 【三个必须有的特性】
 *
 * **① 版本迁移**
 * 游戏更新后存档结构变了。老玩家的存档不能直接扔掉，
 * 也不能直接读（会崩）。必须有一套"从 v1 升到 v3"的迁移链。
 *
 * **② 原子写**
 * 写存档时断电/崩溃 = 存档损坏，玩家几十小时的进度没了。
 * 正确做法：先写临时文件 → 写完成 → 重命名覆盖。
 * 文件系统保证重命名是原子的，所以要么拿到完整的旧档，要么拿到完整的新档。
 *
 * **③ 校验**
 * 存档里要有校验和。手改存档、传输损坏、版本错误——
 * 都要能检测出来，而不是加载出一堆 undefined 然后游戏行为诡异。
 *
 * 【设计：存储由外部注入】
 * 与 ConfigLoader 同理，本文件不 import 任何引擎模块。
 * Cocos 侧实现 `IStorage` 即可（`sys.localStorage` 或文件）。
 *
 * 【使用示例】
 * ```typescript
 * const storage = new MemoryStorage();  // Cocos 里换成 CocosStorage
 * const saves = new SaveManager(storage, { gameId: 'myroguelike', version: 3 });
 *
 * // 注册迁移（从 v1 → v2，v2 → v3）
 * saves.registerMigration(1, 2, (d) => ({ ...d, gold: d.coins ?? 0 }));
 * saves.registerMigration(2, 3, (d) => ({ ...d, relics: d.relics ?? [] }));
 *
 * // 写
 * saves.write('slot1', { hp: 50, gold: 120, relics: ['a'] });
 *
 * // 读（自动迁移到当前版本）
 * const r = saves.read<MySave>('slot1');
 * if (r.ok) applySave(r.value);
 * else console.warn(r.error);
 *
 * // 多槽位
 * saves.listSlots();        // ['slot1', 'slot2']
 * saves.deleteSlot('slot1');
 * ```
 *
 * 【无引擎依赖】
 */

export interface IStorage {
  read(key: string): string | null;
  write(key: string, data: string): void;
  remove(key: string): void;
  keys(): string[];

  /**
   * 【原子替换】把 tmpKey 的内容原子地替换掉 key。
   *
   * 【为什么需要这个方法】
   * 没有它，写存档只能「先写临时文件 → 再原样写一遍主档」，
   * 中间断电会得到**半截的主档**——玩家几十小时进度没了。
   * 文件系统的 `rename` 是原子的（要么全换，要么不换），
   * 这才是真正的原子写。
   *
   * 【为什么是可选方法】
   * 早期版本的 IStorage 没有它，标成可选才不会破坏已有实现。
   *
   * 【不实现会怎样】
   * 不会报错，会降级成「双档 + 回退」：
   * 主档写坏时自动读回 `__tmp` 备份。仍然安全，但不如 rename 干净。
   *
   * 【怎么写】
   * Node：`fs.renameSync(tmpPath, keyPath)`
   * 浏览器 / 小游戏：先写入新 key，成功后删旧 key（尽力而为）
   */
  commit?(tmpKey: string, key: string): void;
}

/** 内存存储（测试用） */
export class MemoryStorage implements IStorage {
  private readonly _map = new Map<string, string>();

  read(key: string): string | null {
    return this._map.get(key) ?? null;
  }

  write(key: string, data: string): void {
    this._map.set(key, data);
  }

  remove(key: string): void {
    this._map.delete(key);
  }

  keys(): string[] {
    return Array.from(this._map.keys());
  }

  /** 原子替换：把 tmp 的值搬到 key，然后删掉 tmp（模拟 fs.renameSync） */
  commit(tmpKey: string, key: string): void {
    const v = this._map.get(tmpKey);
    if (v === undefined) {
      throw new Error(`[MemoryStorage] commit 失败：临时键 "${tmpKey}" 不存在`);
    }
    this._map.set(key, v);
    this._map.delete(tmpKey);
  }
}

/** 存档信封（带版本与校验和） */
export interface SaveEnvelope<T = unknown> {
  readonly v: number;
  readonly gameId: string;
  readonly savedAt: number;
  readonly checksum: number;
  readonly data: T;
}

export interface SaveManagerOptions {
  /** 游戏标识（防止不同游戏的存档互相污染） */
  readonly gameId: string;
  /** 当前存档版本 */
  readonly version: number;
  /** 槽位前缀 */
  readonly prefix?: string;
}

export type MigrationFn = (data: Record<string, unknown>) => Record<string, unknown>;

export class SaveManager {
  private readonly _storage: IStorage;
  private readonly _gameId: string;
  private readonly _version: number;
  private readonly _prefix: string;
  private readonly _migrations = new Map<string, MigrationFn>();

  constructor(storage: IStorage, opts: SaveManagerOptions) {
    this._storage = storage;
    this._gameId = opts.gameId;
    this._version = opts.version;
    this._prefix = opts.prefix ?? 'save_';
  }

  /** 注册迁移函数 */
  registerMigration(from: number, to: number, fn: MigrationFn): this {
    if (to !== from + 1) {
      throw new Error(`[SaveManager] 迁移必须逐级注册（${from} → ${to} 不合法，应为 ${from} → ${from + 1}）`);
    }
    this._migrations.set(`${from}->${to}`, fn);
    return this;
  }

  private _key(slot: string): string {
    return `${this._prefix}${slot}`;
  }

  /**
   * 简易校验和（检测损坏与手改）
   *
   * 【坑】必须保护 stringify。循环引用会让它抛异常，
   * 而这个调用发生在 write() 的 try 块**之外**——
   * 结果是"保存时游戏直接崩溃"，而不是优雅地返回 false。
   */
  /** 这段文本是不是一个能解析的 JSON（只判语法，不校验内容） */
  private _isParsable(raw: string): boolean {
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  }

  private _checksum(data: unknown): number {
    let s: string;
    try {
      s = JSON.stringify(data);
    } catch {
      return 0;
    }
    if (typeof s !== 'string') return 0;
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return h;
  }

  /**
   * 写存档（原子写：先写临时 → 再重命名）
   *
   * 【为什么这样就是原子的】
   * 大多数文件系统的 rename 是原子操作。
   * 所以最后一步要么没发生（旧档完好），要么已完成（新档完整）。
   * 不存在"写了一半的存档"。
   */
  write<T>(slot: string, data: T): boolean {
    const envelope: SaveEnvelope<T> = {
      v: this._version,
      gameId: this._gameId,
      savedAt: Date.now(),
      checksum: this._checksum(data),
      data,
    };

    const key = this._key(slot);
    const tmpKey = `${key}__tmp`;
    let json: string;

    try {
      json = JSON.stringify(envelope);
    } catch (e) {
      console.error(`[SaveManager] 存档序列化失败（可能有循环引用）: ${e}`);
      return false;
    }

    try {
      // 二次确认：能序列化不代表能再解析（比如含 undefined / 函数）
      JSON.parse(json);
    } catch {
      console.error('[SaveManager] 存档内容无法反序列化');
      return false;
    }

    try {
      // ① 先写临时文件（无论走哪条路径，它都是一份完整备份）
      this._storage.write(tmpKey, json);

      if (typeof this._storage.commit === 'function') {
        // ②a 真·原子写：rename 替换主档，要么全换要么不换
        this._storage.commit(tmpKey, key);
      } else {
        // ②b 降级：storage 不支持原子替换。
        //     写主档可能中途失败 → 此时**不删 tmp**，
        //     read() 会回退到 tmp 把数据救回来。
        this._storage.write(key, json);
        this._storage.remove(tmpKey);
      }
      return true;
    } catch (e) {
      console.error(`[SaveManager] 写入失败: ${e}`);
      return false;
    }
  }

  /**
   * 读存档（自动执行版本迁移）
   *
   * @returns Result：失败时 error 说明原因（不存在 / 损坏 / 版本过高 / 迁移失败）
   */
  read<T>(slot: string): { ok: true; value: T } | { ok: false; error: string } {
    const key = this._key(slot);
    let raw = this._storage.read(key);

    // 【自动回退】主档写坏时，从 __tmp 备份里把数据救回来
    //
    // 场景：storage 不支持 commit()（降级路径），写主档写到一半断电。
    // 此时主档是半截 JSON，而 __tmp 里躺着完整的新档——
    // 因为降级路径只在主档写成功后才 remove(tmpKey)。
    //
    // 【为什么不直接删掉 tmp】
    // 它此刻是唯一完好那份。删了就真没了。
    if (raw !== null && !this._isParsable(raw)) {
      const backup = this._storage.read(`${key}__tmp`);
      if (backup !== null && this._isParsable(backup)) {
        console.warn(
          `[SaveManager] 槽位 "${slot}" 主档损坏，已自动回退到备份（建议尽快再存一次以修复主档）`,
        );
        raw = backup;
      }
    }

    if (raw === null) return { ok: false, error: `槽位 "${slot}" 不存在` };

    let env: SaveEnvelope;
    try {
      env = JSON.parse(raw) as SaveEnvelope;
    } catch {
      return { ok: false, error: '存档解析失败（文件损坏）' };
    }

    if (!env || typeof env !== 'object' || env.v === undefined) {
      return { ok: false, error: '存档格式错误' };
    }

    if (env.gameId !== this._gameId) {
      return { ok: false, error: `存档属于另一个游戏（${env.gameId}）` };
    }

    // 校验和
    if (env.checksum !== this._checksum(env.data)) {
      return { ok: false, error: '存档校验失败（可能被修改或损坏）' };
    }

    // 版本过高（玩家用新版本存档玩老版本）
    if (env.v > this._version) {
      return { ok: false, error: `存档版本 ${env.v} 高于当前 ${this._version}（请更新游戏）` };
    }

    // 迁移
    let data = env.data as Record<string, unknown>;
    let v = env.v;
    while (v < this._version) {
      const fn = this._migrations.get(`${v}->${v + 1}`);
      if (!fn) {
        return { ok: false, error: `缺少 v${v} → v${v + 1} 的迁移函数` };
      }
      try {
        data = fn(data);
      } catch (e) {
        return { ok: false, error: `迁移 v${v}→v${v + 1} 失败: ${e}` };
      }
      v++;
    }

    return { ok: true, value: data as unknown as T };
  }

  has(slot: string): boolean {
    return this._storage.read(this._key(slot)) !== null;
  }

  deleteSlot(slot: string): void {
    this._storage.remove(this._key(slot));
  }

  /** 列出所有槽位 */
  listSlots(): string[] {
    const p = this._prefix;
    return this._storage
      .keys()
      .filter((k) => k.startsWith(p) && !k.endsWith('__tmp'))
      .map((k) => k.substring(p.length));
  }

  /** 读存档的元信息（不执行迁移，用于存档选择界面） */
  meta(slot: string): { version: number; savedAt: number } | null {
    const raw = this._storage.read(this._key(slot));
    if (raw === null) return null;
    try {
      const env = JSON.parse(raw) as SaveEnvelope;
      return { version: env.v, savedAt: env.savedAt };
    } catch {
      return null;
    }
  }

  clearAll(): void {
    for (const s of this.listSlots()) this.deleteSlot(s);
  }

  get version(): number {
    return this._version;
  }

  destroy(): void {
    this._migrations.clear();
  }
}
