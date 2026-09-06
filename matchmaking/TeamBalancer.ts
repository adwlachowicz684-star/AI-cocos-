/**
 * matchmaking/TeamBalancer.ts —— 分队平衡
 *
 * 【它解决什么】
 *
 * 撮合器负责"挑人"，分队器负责"怎么分"。
 * 10 个人选出来了，怎么分成两队才是决定体验的最后一环。
 *
 * 看起来简单（排序后蛇形分配），但有三个坑：
 *
 * 1. **蛇形不最优**
 *    分数 [2000, 1500, 1500, 1000]：
 *    - 蛇形 → (2000,1500) vs (1500,1000)，两队差 500
 *    - 最优 → (2000,1000) vs (1500,1500)，两队差 0
 *    蛇形只在"分数均匀递减"时最优，现实分布常常不是。
 *
 * 2. **黑店不能拆**
 *    五连坐必须进同一队。拆了就不是黑店了，
 *    而且玩家会觉得"系统针对我们"。
 *
 * 3. **只比平均分不够**
 *    A 队 (2500, 500) 和 B 队 (1500, 1500) 平均分都是 1500，
 *    但 A 队是"一个人 carry 四个拖油瓶"，体验完全不同。
 *    MOBA 里这叫"分数方差"，必须单独考虑。
 *
 * 【零业务依赖】
 */

import { clamp, maxOf, minOf } from '../_core/math';

// ==================== 类型 ====================

export interface BalancePlayer {
  readonly id: string;
  readonly rating: number;
  /** 同 partyId 的人**必定同队** */
  readonly partyId?: string;
  /** 角色（坦克/输出/辅助…），用于满足配额 */
  readonly role?: string;
  readonly meta?: unknown;
}

export interface BalanceOptions {
  /** 分成几队 */
  readonly teamCount: number;
  /**
   * 角色配额，如 `{ tank: 1, dps: 2, support: 2 }`
   *
   * 【注意】
   * 配额总和建议等于队内人数。不填则不考虑角色。
   */
  readonly roleQuota?: Readonly<Record<string, number>>;
  /** 局部搜索迭代上限（防御性） */
  readonly maxIterations?: number;
  /**
   * 评价口径
   *
   * - `'sum'`（默认）：比较各队**总分**，最常用
   * - `'top'`：比较各队**最强者**，避免"一队有个大哥"
   * - `'both'`：两者都要（各占一半权重）
   */
  readonly metric?: 'sum' | 'top' | 'both';
  /** 是否允许局部搜索（默认 true）。关掉则只做贪心，更快但更差 */
  readonly optimize?: boolean;
}

export interface BalancedTeam {
  readonly players: readonly BalancePlayer[];
  /** 平均分（用于展示与比较） */
  readonly rating: number;
  /** 总分 */
  readonly total: number;
  /** 队内最强者 */
  readonly top: number;
}

export interface BalanceResult {
  readonly teams: readonly BalancedTeam[];
  /** 平均分最大差距 */
  readonly spread: number;
  /** 总分最大差距 */
  readonly totalSpread: number;
  /** 公平度 0~1，1 = 完全均衡 */
  readonly fairness: number;
  /** 实际迭代次数（调试用） */
  readonly iterations: number;
}

// ==================== 实现 ====================

/**
 * 把玩家分成若干实力接近的队
 *
 * @throws 人数除不尽、或某个队伍人数超过上限时抛错
 */
export function balanceTeams(
  players: readonly BalancePlayer[],
  opts: BalanceOptions
): BalanceResult {
  const teamCount = opts.teamCount;
  const metric = opts.metric ?? 'sum';
  const optimize = opts.optimize ?? true;
  const maxIter = opts.maxIterations ?? 500;

  if (!Number.isInteger(teamCount) || teamCount < 1) {
    throw new Error(`[TeamBalancer] teamCount 必须是正整数，收到 ${teamCount}`);
  }
  if (players.length === 0) {
    throw new Error('[TeamBalancer] 玩家列表为空');
  }
  if (players.length % teamCount !== 0) {
    throw new Error(
      `[TeamBalancer] ${players.length} 人无法均分成 ${teamCount} 队`
    );
  }
  const teamSize = players.length / teamCount;

  // ① 把黑店打包成原子单位
  const units = packParties(players);

  // ② 检查有没有队伍大过队容量
  for (const u of units) {
    if (u.members.length > teamSize) {
      throw new Error(
        `[TeamBalancer] 队伍 ${u.members.length} 人超过每队容量 ${teamSize}`
      );
    }
  }

  // ③ 单位降序（大队伍优先放，否则最后会塞不下）
  units.sort((a, b) => b.members.length - a.members.length || b.total - a.total);

  // ④ 贪心：每个单位放进当前"最弱"的队
  const teams: BalancePlayer[][] = Array.from({ length: teamCount }, () => []);
  const sizes = new Array(teamCount).fill(0);
  const totals = new Array(teamCount).fill(0);

  for (const u of units) {
    let best = 0;
    for (let t = 1; t < teamCount; t++) {
      if (sizes[t] + u.members.length > teamSize) continue;
      if (sizes[best] + u.members.length > teamSize || totals[t] < totals[best]) {
        best = t;
      }
    }
    teams[best].push(...u.members);
    sizes[best] += u.members.length;
    totals[best] += u.total;
  }

  // ⑤ 角色配额修正
  if (opts.roleQuota) {
    fixRoles(teams, opts.roleQuota, teamSize);
  }

  // ⑥ 局部搜索：交换单位以缩小差距
  let iterations = 0;
  if (optimize) {
    iterations = localSearch(teams, units, metric, maxIter);
  }

  return packResult(teams, metric, iterations);
}

// ==================== 内部 ====================

interface Unit {
  readonly key: string;
  readonly members: BalancePlayer[];
  readonly total: number;
  readonly partyId: string | undefined;
}

/**
 * 打包黑店
 *
 * 【⚠️ 相同 partyId 的人必须同队】
 * 这是硬约束，任何时候都不能违背——
 * 包括后面的局部搜索也只能在"单位"之间交换，不能拆开单位。
 */
function packParties(players: readonly BalancePlayer[]): Unit[] {
  const byParty = new Map<string, BalancePlayer[]>();
  for (const p of players) {
    const key = p.partyId ?? `#solo:${p.id}`;
    const arr = byParty.get(key);
    if (arr) arr.push(p);
    else byParty.set(key, [p]);
  }

  const out: Unit[] = [];
  for (const [key, members] of byParty) {
    let total = 0;
    for (const m of members) total += m.rating;
    out.push({
      key,
      members,
      total,
      partyId: members[0]?.partyId,
    });
  }
  return out;
}

/**
 * 局部搜索：不断交换两个队之间的单位，直到无法改善
 *
 * 【为什么用局部搜索而不是穷举】
 * 10 人分两队有 126 种分法，可以穷举。
 * 但 30 人分 6 队是天文数字。
 * 局部搜索在毫秒级给出一个"足够好"的解——
 * 玩家感知不到 500 分差和 480 分差的区别。
 */
function localSearch(
  teams: BalancePlayer[][],
  units: readonly Unit[],
  metric: 'sum' | 'top' | 'both',
  maxIter: number
): number {
  const teamOf = new Map<string, number>();
  for (let t = 0; t < teams.length; t++) {
    for (const p of teams[t]) teamOf.set(p.id, t);
  }

  let iterations = 0;
  let improved = true;

  while (improved && iterations < maxIter) {
    improved = false;

    for (const u of units) {
      const from = teamOf.get(u.members[0].id);
      if (from === undefined) continue;

      for (let to = 0; to < teams.length; to++) {
        if (to === from) continue;

        // 单位里所有人必须都在同一队（防御：理论上总是成立）
        if (!u.members.every((m) => teamOf.get(m.id) === from)) continue;

        const before = imbalance(teams, metric);

        // 试交换：需要两边各出相同人数
        const candidates = teams[to].filter((p) => p.partyId === undefined);
        if (candidates.length < u.members.length) continue;

        // 简化：只与"单飞玩家"交换，保证人数守恒
        const moved: BalancePlayer[] = [];
        for (let k = 0; k < u.members.length; k++) {
          const c = candidates[k];
          if (!c) break;
          moved.push(c);
        }
        if (moved.length !== u.members.length) continue;

        // 执行
        for (const m of u.members) {
          teams[from] = teams[from].filter((p) => p.id !== m.id);
        }
        for (const m of moved) {
          teams[to] = teams[to].filter((p) => p.id !== m.id);
        }
        for (const m of u.members) {
          teams[to].push(m);
          teamOf.set(m.id, to);
        }
        for (const m of moved) {
          teams[from].push(m);
          teamOf.set(m.id, from);
        }

        const after = imbalance(teams, metric);
        if (after < before - 1e-9) {
          improved = true;
          iterations++;
          break;   // 有改善就重新扫
        } else {
          // 回滚
          for (const m of u.members) {
            teams[to] = teams[to].filter((p) => p.id !== m.id);
          }
          for (const m of moved) {
            teams[from] = teams[from].filter((p) => p.id !== m.id);
          }
          for (const m of u.members) {
            teams[from].push(m);
            teamOf.set(m.id, from);
          }
          for (const m of moved) {
            teams[to].push(m);
            teamOf.set(m.id, to);
          }
        }
      }
      if (improved) break;
    }
  }

  return iterations;
}

/** 不平衡度（越小越好） */
function imbalance(teams: readonly BalancePlayer[][], metric: 'sum' | 'top' | 'both'): number {
  const sums = teams.map((t) => t.reduce((a, p) => a + p.rating, 0));
  const tops = teams.map((t) => maxOf(t.map((p) => p.rating), 0));

  // 【为什么必须换】teams 为空时 xs 为空，
  // Math.max(...[]) - Math.min(...[]) = -Infinity - Infinity = **-Infinity**，
  // "不平衡度"变成负无穷 → 任何"如果不平衡就重排"的判定全部失效。
  const spreadOf = (xs: readonly number[]): number => maxOf(xs, 0) - minOf(xs, 0);

  const s = spreadOf(sums);
  const tp = spreadOf(tops);

  switch (metric) {
    case 'sum': return s;
    case 'top': return tp;
    case 'both': return s * 0.5 + tp * 0.5;
  }
}

/**
 * 角色配额修正
 *
 * 【做法】
 * 在各队之间交换**同分差最小**的同角色玩家，直到配额满足。
 * 优先交换那些"对实力平衡影响最小"的人。
 */
function fixRoles(
  teams: BalancePlayer[][],
  quota: Readonly<Record<string, number>>,
  teamSize: number
): void {
  const need = (t: readonly BalancePlayer[], role: string): number =>
    (quota[role] ?? 0) - t.filter((p) => p.role === role).length;

  for (let guard = 0; guard < 200; guard++) {
    let done = true;

    for (const role of Object.keys(quota)) {
      for (let a = 0; a < teams.length; a++) {
        if (need(teams[a], role) <= 0) continue;

        // 找一个该角色富余的队来换
        for (let b = 0; b < teams.length; b++) {
          if (a === b) continue;
          if (need(teams[b], role) >= 0) continue;

          const surplusInB = teams[b].filter((p) => p.role === role);
          if (surplusInB.length === 0) continue;

          // A 队出一个"多余"的别的角色去换
          const spareInA = teams[a].filter(
            (p) => p.role !== role && need(teams[a], p.role ?? '') < 0
          );
          if (spareInA.length === 0) continue;

          // 挑分差最小的一对，尽量不破坏平衡
          let bestPair: { x: BalancePlayer; y: BalancePlayer; diff: number } | null = null;
          for (const y of surplusInB) {
            for (const x of spareInA) {
              const diff = Math.abs(x.rating - y.rating);
              if (!bestPair || diff < bestPair.diff) bestPair = { x, y, diff };
            }
          }
          if (!bestPair) continue;

          teams[a] = teams[a].filter((p) => p.id !== bestPair!.x.id);
          teams[b] = teams[b].filter((p) => p.id !== bestPair!.y.id);
          teams[a].push(bestPair.y);
          teams[b].push(bestPair.x);
          done = false;
          break;
        }
      }
    }

    if (done) break;
  }
  void teamSize;
}

function packResult(
  teams: BalancePlayer[][],
  metric: 'sum' | 'top' | 'both',
  iterations: number
): BalanceResult {
  const built: BalancedTeam[] = teams.map((t) => {
    const total = t.reduce((a, p) => a + p.rating, 0);
    return {
      players: [...t],
      rating: t.length ? total / t.length : 0,
      total,
      top: maxOf(t.map((p) => p.rating), 0),
    };
  });

  const ratings = built.map((t) => t.rating);
  const totals = built.map((t) => t.total);
  const spread = maxOf(ratings, 0) - minOf(ratings, 0);
  const totalSpread = maxOf(totals, 0) - minOf(totals, 0);

  /**
   * 公平度：把分差映射到 0~1
   *
   * 分差 0 → 1；分差 ≥ 每队 100 分（如 5 人队 500 总分）→ 0。
   *
   * 这个尺度是经验值：分差达到人均 100 分时，
   * 弱队胜率已跌到 30% 以下，玩家能明显感觉到不公平。
   */
  const scale = 100;
  const fairness = clamp(1 - spread / scale, 0, 1);

  void metric;
  return { teams: built, spread, totalSpread, fairness, iterations };
}

// ==================== 便捷入口 ====================

/**
 * 1v1 式分队（两队各一人）
 *
 * 【它存在的理由】
 * 最常见的场景，值得一个不用传 teamCount 的入口。
 */
export function splitIntoTwoTeams(
  players: readonly BalancePlayer[]
): BalanceResult {
  return balanceTeams(players, { teamCount: 2 });
}

/**
 * 检查一组分队是否满足硬约束（黑店未拆、人数均等）
 *
 * 【用途】
 * 自己实现了分队算法时，用它做断言。
 * 或者在对局开始前做最后一次校验。
 */
export function validateTeamAssignment(teams: readonly (readonly BalancePlayer[])[]): {
  ok: boolean;
  reason?: string;
} {
  if (teams.length === 0) return { ok: false, reason: '没有队伍' };

  const size = teams[0].length;
  for (const t of teams) {
    if (t.length !== size) {
      return { ok: false, reason: `队伍人数不均：${teams.map((x) => x.length).join('/')}` };
    }
  }

  const seen = new Map<string, number>();
  for (let i = 0; i < teams.length; i++) {
    for (const p of teams[i]) {
      if (!p.partyId) continue;
      const prev = seen.get(p.partyId);
      if (prev !== undefined && prev !== i) {
        return { ok: false, reason: `黑店 ${p.partyId} 被拆到了不同队伍` };
      }
      seen.set(p.partyId, i);
    }
  }

  const allIds = teams.flat().map((p) => p.id);
  if (new Set(allIds).size !== allIds.length) {
    return { ok: false, reason: '有人被分到了多个队伍' };
  }

  return { ok: true };
}
