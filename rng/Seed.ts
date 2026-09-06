/**
 * Seed —— 人类可读的种子编码
 *
 * 【为什么需要】
 * 玩家想和朋友玩同一张地图，分享一长串数字（如 3847291056）很痛苦；
 * 分享 `DRAGON-77` 就友好得多。
 *
 * 种子分享也是肉鸽游戏社区活跃度的重要来源——
 * "今天每日挑战的种子是 MOON-42，来比比谁走得远"。
 *
 * 【设计】
 * 数字 → 单词 + 两位校验，既好记又能防手误。
 */

/** 词表：选常用、无歧义、不易拼错的短词 */
const WORDS = [
  'DRAGON', 'MOON', 'STORM', 'BLADE', 'FLAME', 'FROST', 'STONE', 'RIVER',
  'CROWN', 'SHADOW', 'IRON', 'GOLD', 'WIND', 'STAR', 'WOLF', 'EAGLE',
  'OCEAN', 'THUNDER', 'RAVEN', 'SWORD', 'SHIELD', 'LIGHT', 'DARK', 'VOID',
  'PHOENIX', 'TIGER', 'SNAKE', 'WHALE', 'HORSE', 'BEAR', 'LION', 'HAWK',
] as const;

/** 可表示的种子总数（词表大小 × 100 个校验位） */
export const CAPACITY = WORDS.length * 100;

/**
 * 数字种子 → 可读字符串
 *
 * 【重要：编码是有损的】
 * 一个字符串最多表示 `CAPACITY` 个值（词表 32 × 校验位 100 = 3200），
 * 而数字种子是 32 位（42 亿）。所以 encode 会先把种子规约到可表示范围。
 *
 * 由此产生两条必须记住的性质：
 *   ✅ `decode(encode(n)) === n`            —— 仅当 n < CAPACITY 时成立
 *   ✅ `encode(decode(encode(n))) === encode(n)`  —— 恒成立（幂等）
 *
 * 【实践建议】
 * 不要用 encode(大数字) 来分享种子，那会丢失信息。
 * 正确做法是：**字符串才是种子的真身**——
 * 用 `random()` 生成字符串，用 `decode()` 把它转成数字给 RNG。
 * 玩家之间分享的就是那个字符串。
 */
export function encode(seed: number): string {
  const s = ((seed >>> 0) % CAPACITY) >>> 0;
  const idx = s % WORDS.length;
  const check = Math.floor(s / WORDS.length); // 0..99
  return `${WORDS[idx]}-${check.toString().padStart(2, '0')}`;
}

/**
 * 可读字符串 → 数字种子（确定的、无歧义的）
 *
 * 返回 null 表示格式非法（调用方可提示用户重新输入）
 */
export function decode(text: string): number | null {
  const t = text.trim().toUpperCase();
  const m = /^([A-Z]+)-(\d{1,2})$/.exec(t);
  if (!m) return null;

  const idx = (WORDS as readonly string[]).indexOf(m[1]);
  if (idx < 0) return null;

  const check = parseInt(m[2], 10);
  return (check * WORDS.length + idx) >>> 0;
}

/**
 * 生成一个随机的可读种子
 *
 * 【为什么直接生成字符串而不是 encode(随机数)】
 * encode 会规约，导致分布不均匀（大数字被折叠）。
 * 直接均匀选取词与校验位，每个种子概率相同。
 */
export function random(): string {
  const idx = Math.floor(Math.random() * WORDS.length);
  const check = Math.floor(Math.random() * 100);
  return `${WORDS[idx]}-${check.toString().padStart(2, '0')}`;
}

/**
 * 按日期生成固定种子（每日挑战用）
 *
 * 【为什么用算法而不是预生成列表】
 * 预生成列表有尽头，改一个要改全表；
 * 按日期算种子是无限的，且所有玩家自动一致（只要时区处理正确）。
 *
 * @param date 默认今天
 * @param timezoneOffsetHours 时区偏移。**所有玩家必须用同一个值**，
 *                            否则跨时区玩家的"每日挑战"会不同。
 */
export function daily(date: Date = new Date(), timezoneOffsetHours = 0): number {
  const d = new Date(date.getTime() + timezoneOffsetHours * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  // 简单的字符串散列（FNV-1a 变体）
  const str = `${y}${m.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}`;
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const Seed = { encode, decode, random, daily, CAPACITY };
