/**
 * scripts/check-deps.js —— 依赖规则自动检测
 *
 * 【检测三项】
 * 1. 环检测：A → B → C → A 是架构腐化的开始
 * 2. 层违规：依赖了更高层（箭头只能向上）
 * 3. L0 纯净度：基础设施里混进业务概念
 *
 * 【运行】
 * ```bash
 * node scripts/check-deps.js
 * ```
 *
 * 【为什么单独做成脚本】
 * 依赖规则写在文档里，就只有写文档那天是遵守的。
 * 能跑的检查才会在每次改动后被想起来。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 功能模块划分（与 _kitmeta.json 的 modules 字段同步） */
let MODULE_OF = new Map();
try {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, '_kitmeta.json'), 'utf-8'));
  for (const m of meta.modules ?? []) {
    for (const p of m.plugins) MODULE_OF.set(p, m.id);
  }
} catch {
  // 读不到就当作没有模块划分
}

/** 两个插件是否属于同一功能模块 */
function sameModule(a, b) {
  const ma = MODULE_OF.get(a);
  return ma !== undefined && ma === MODULE_OF.get(b);
}

/** 按名字精确排除的目录 */
const SKIP = new Set([
  '.build', 'node_modules', 'lib', 'typings', 'scripts',
  'tests', 'examples', '.git',
]);

/**
 * 按前缀排除的目录
 *
 * 【为什么需要】
 * build.sh 为了绕开"rm -rf 是异步的"这个坑，
 * 改用「构建到 .build.new.<stamp> → 原子换名 → 旧产物改名 .build.old.<stamp>」。
 *
 * 于是项目里可能出现这类目录。若只精确匹配 `.build`，
 * 它们会被当成插件目录扫进去，然后 stat 一个**已被后台删掉**的路径：
 *
 *   ENOENT: no such file or directory, stat '.build.old.3821-.../analytics'
 *
 * 报错指向库内部、完全不提构建脚本，极难定位。
 *
 * 【什么时候会残留】build 被 SIGKILL（超时、Ctrl-C 两次）时，
 * 清理用的 trap 不会执行。所以除了这里排除，build.sh 开头也要清理。
 */
const SKIP_PREFIX = ['.build.'];

/** 分层定义（越低越基础） */
const LAYERS = {
  _core: 0,
  ds: 0,
  // L1 原子件
  rng: 1, 'event-bus': 1, pool: 1, logger: 1, scheduler: 1, config: 1,
  input: 1, curve: 1, result: 1, signal: 1, expression: 1, binary: 1,
  grid: 1, noise: 1, fov: 1, di: 1, scheduling: 1, snapshot: 1,
  i18n: 1, save: 1, tween: 1, condition: 1, 'number-roller': 1,
  // L2 复合件
  'damage-pipeline': 2, fsm: 2, 'behavior-tree': 2, buff: 2,
  // 第十八批：表现与运维层（⚠️ 这里用**目录名**，不是 _kitmeta 里的单元名）
  autoquality: 2, diagpack: 2, minimap: 2, builder: 2,
  // 第十九批：碰撞与移动
  collision: 1, mover: 2,
  // 第二十批：模块间适配器
  adapters: 2,
  // 第二十一批：统一实体注册表
  entity: 1,
  cutscene: 2, transition: 2, audio: 2,
  // 第十二~十三批补登（此前漏了，导致它们的分层从未被检测）
  observable: 1, telemetry: 1, timeutil: 1, uinav: 1, rarity: 1,
  stats: 1, achievement: 1, gesture: 1, rebind: 1, cheatcode: 1,
  gameflow: 2,
  pathfind: 2, dungeon: 2, steering: 2, inventory: 2, card: 2,
  'room-graph': 2, 'wave-spawner': 2, meta: 2, affix: 2, attribute: 2,
  hitbox: 2, projectile: 2, indicator: 2, telegraph: 2,
  'skill-player': 2, 'skill-caster': 2, targeting: 2, combo: 2,
  'attack-token': 2, perception: 2, 'bullet-pattern': 2, element: 2,
  objective: 2, difficulty: 2, gacha: 2, scoring: 2, loot: 2,
  turn: 2, quest: 2, shop: 2, craft: 2, dialogue: 2, replay: 2,
  dash: 2, pathfinding: 2, spatial: 2,
  camera: 2, score: 2, 'debug-console': 3, crash: 3, command: 3,
  runscope: 2, setbonus: 2, daily: 2, leaderboard: 2,
  'skill-variant': 2, blessing: 2, curse: 2, interact: 2,
  // 第十四/十五批新增
  feedback: 2, progressbar: 2, subtitle: 2,
  tutorial: 2, settings: 1, reddot: 1, 'scenerouter': 2,
  accessibility: 1, currency: 1,
  // 第十六批：评分与匹配
  elo: 2, matchmaking: 2, ranking: 2,
  // 第十七批：对局生命周期
  mmr: 2, matchops: 2, social: 2, anticheat: 2, analytics: 2,
  // 第十八批：表现与运维层
  // 音效与分层 BGM：复合件，依赖调度与曲线语义
  // 时间轴播放，依赖 _core
  // 场景转场编排
  // 坐标变换 + 迷雾位图
  // 建造：依赖注入的资源/地形接口
  // 帧率监测：纯统计，无外部依赖
  // 诊断包：零依赖
  // L3 域件
  'joystick-mover': 3,
  // 第二十二批：技能排队（SkillCaster 的上层封装，前置依赖，允许 L3→L2）
  'skill-queue': 3,
};

/** L0 里不应该出现的业务词汇 */
const L0_FORBIDDEN = [
  'player', 'enemy', 'boss', 'skill', 'damage', 'hp', 'mana',
  'relic', 'loot', 'room', 'wave', 'quest', 'shop', 'inventory',
  '玩家', '敌人', '技能', '伤害', '血量', '遗物', '关卡', '波次',
];

// ==================== 收集 ====================

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    if (SKIP_PREFIX.some((pfx) => name.startsWith(pfx))) continue;
    const p = path.join(dir, name);
    // 目录可能正被后台的 rm 删除，stat 会抛 ENOENT
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 去掉注释，避免注释里的示例 import 被算进去 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function pluginOf(file) {
  const rel = path.relative(ROOT, file);
  const parts = rel.split(path.sep);
  return parts.length > 1 ? parts[0] : '(root)';
}

function buildGraph() {
  const graph = new Map();
  for (const file of walk(ROOT)) {
    const from = pluginOf(file);
    if (from === '(root)') continue;

    const src = stripComments(fs.readFileSync(file, 'utf-8'));
    const re = /from\s+['"](\.\.?\/[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const target = path.resolve(path.dirname(file), m[1]);
      let to;
      if (fs.existsSync(target + '.ts')) to = pluginOf(target + '.ts');
      else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) to = pluginOf(path.join(target, 'x.ts'));
      else continue;

      if (to === from || to === '(root)') continue;
      if (!graph.has(from)) graph.set(from, new Set());
      graph.get(from).add(to);
    }
  }
  return graph;
}

// ==================== 检查 ====================

function detectCycles(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const cycles = [];
  const stack = [];

  function dfs(n) {
    color.set(n, GRAY);
    stack.push(n);
    for (const m of [...(graph.get(n) ?? [])].sort()) {
      const c = color.get(m) ?? WHITE;
      if (c === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(m)), m].join(' → '));
      } else if (c === WHITE) {
        dfs(m);
      }
    }
    stack.pop();
    color.set(n, BLACK);
  }

  const nodes = new Set([...graph.keys(), ...[...graph.values()].flatMap((s) => [...s])]);
  for (const n of [...nodes].sort()) {
    if ((color.get(n) ?? WHITE) === WHITE) dfs(n);
  }
  return cycles;
}

/**
 * 层违规检测
 *
 * 【v3 新增：同功能模块豁免】
 * 模块内是实现细节，可以互相依赖——
 * 就像 HashMap 依赖 Hasher，那是实现，不是耦合。
 *
 * 只豁免"同层依赖"这一项。
 * 向上的违规（依赖了更高层）不豁免，那说明方向搞反了。
 */
function detectLayerViolations(graph) {
  const bad = [];
  const exempted = [];
  for (const [from, deps] of graph) {
    const lf = LAYERS[from];
    if (lf === undefined) continue;
    for (const to of deps) {
      const lt = LAYERS[to];
      if (lt === undefined) continue;

      if (lt > lf) {
        bad.push(`${from}(L${lf}) → ${to}(L${lt})`);
      } else if (lt === lf && lf > 0) {
        if (sameModule(from, to)) exempted.push(`${from} → ${to}  [${MODULE_OF.get(from)}]`);
        else bad.push(`${from}(L${lf}) → ${to}(L${lt}) 同层依赖`);
      }
    }
  }
  return { bad, exempted };
}

/**
 * 跨模块依赖检测（v3）
 *
 * 【为什么单独查】
 * 模块的意义在于"对外表现为一个功能"。
 * 如果外部绕过 Facade 直接依赖模块内部的插件，
 * 那模块边界就形同虚设了——内部一改，外部全崩。
 */
function detectCrossModule(graph) {
  const cross = [];
  for (const [from, deps] of graph) {
    const mf = MODULE_OF.get(from);
    if (mf === undefined) continue;
    for (const to of deps) {
      const mt = MODULE_OF.get(to);
      // 目标不属于任何模块（L0/L1 基础设施、独立插件）→ 正常
      if (mt === undefined) continue;
      if (mt === mf) continue;
      // 跨模块：只允许依赖 L0/L1
      const lt = LAYERS[to];
      if (lt !== undefined && lt >= 2) {
        cross.push(`${from}[${mf}] → ${to}[${mt}]  ← 应改为依赖 ${mt} 的 Facade`);
      }
    }
  }
  return cross;
}

/**
 * 内聚性提示（CCP）：模块里的插件，有没有一起变化的迹象
 *
 * 【这只是提示，不是错误】
 * 一个模块里的插件彼此零依赖，有两种可能：
 *   ① 它们是并列关系（如目标释放 / 弹道释放）——正常
 *   ② 它们其实没关系，被硬撮合到一起 —— 模块划分错了
 *
 * 脚本无法区分这两种，所以只列出供人工确认。
 */
function detectModuleCohesion(graph) {
  const byMod = new Map();
  for (const [p, m] of MODULE_OF) {
    if (!byMod.has(m)) byMod.set(m, []);
    byMod.get(m).push(p);
  }
  const rows = [];
  for (const [m, plugins] of [...byMod].sort()) {
    const inner = [];
    for (const [from, deps] of graph) {
      if (MODULE_OF.get(from) !== m) continue;
      for (const to of deps) if (MODULE_OF.get(to) === m) inner.push(`${from}→${to}`);
    }
    rows.push({ m, size: plugins.length, inner: inner.length, links: inner });
  }
  return rows;
}

function detectUnknownLayers(graph) {
  const known = new Set(Object.keys(LAYERS));
  const unknown = new Set();
  for (const n of new Set([...graph.keys(), ...[...graph.values()].flatMap((s) => [...s])])) {
    if (!known.has(n)) unknown.add(n);
  }
  return [...unknown].sort();
}

/**
 * 扫出所有插件目录里不在 LAYERS 中的
 *
 * 【为什么要单独检测】
 * LAYERS 是硬编码的。新增一个目录如果忘了登记，
 * 它的依赖**永远不会被检查**——
 * 检查工具会给人一种虚假的安全感，而这比不检查更危险。
 */
function detectUncoveredDirs() {
  const out = [];
  for (const name of fs.readdirSync(ROOT)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    if (!fs.statSync(path.join(ROOT, name)).isDirectory()) continue;
    if (!(name in LAYERS)) out.push(name);
  }
  return out.sort();
}

/**
 * 【⚠️ 踩过的坑：depend 登记口径不统一】
 *
 * `_kitmeta.json` 的 depends 里混着两种写法：
 *   `"_core"`        —— 目录名
 *   `"_core/math"`   —— 文件路径
 *
 * 而 buildGraph 得到的永远是**目录名**。
 * 不归一化的话，`_core/math` 永远匹配不上，会被误报成幽灵依赖。
 */
function normalizeDep(dep) {
  return String(dep).replace(/^\.\.?\//, '').split('/')[0];
}

/**
 * 登记 vs 实际 import 的对账。
 *
 * 两个方向都要查，但危害不同：
 *
 * - 漏登记（import 了没写）：用户照着 depends 复制会**少文件**，编译失败。
 *   报错是好事，立刻能发现。
 * - 幽灵（写了没 import）：多复制文件，能跑，但**数据不可信**——
 *   一旦你发现 depends 不准，下次就得自己 grep 源码核对，
 *   这个字段本来是帮你省这一步的。
 */
function detectDependsDrift(graph) {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, '_kitmeta.json'), 'utf-8'));
  const ghost = [];    // 登记了但没 import
  const missing = [];  // import 了但没登记

  for (const u of meta.plugins) {
    const declared = new Set((u.depends || []).map(normalizeDep));
    const actual = new Set([...(graph.get(u.dir) || [])]);

    for (const d of declared) {
      if (!actual.has(d)) ghost.push({ dir: u.dir, name: u.name, dep: d });
    }
    for (const a of actual) {
      if (!declared.has(a)) missing.push({ from: u.dir, name: u.name, to: a });
    }
  }
  return { ghost, missing };
}

/** 按源码实际 import 重写 depends 字段（保持原顺序，追加缺失的） */
function fixDepends() {
  const graph = buildGraph();
  const metaPath = path.join(ROOT, '_kitmeta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  let changed = 0;

  for (const u of meta.plugins) {
    const actual = [...(graph.get(u.dir) || [])].sort();
    const old = (u.depends || []).slice();
    // 保留原本就写对的（可能是更精确的 `_core/math` 形式），追加真正缺的
    const declaredTop = new Set(old.map(normalizeDep));
    const next = old.filter((d) => {
      const top = normalizeDep(d);
      // 幽灵：源码里没有 → 丢掉
      return (graph.get(u.dir) || new Set()).has(top);
    });
    for (const a of actual) {
      if (!declaredTop.has(a)) next.push(a);
    }
    if (JSON.stringify(next) !== JSON.stringify(old)) {
      u.depends = next;
      changed++;
      console.log(`  ${u.dir.padEnd(16)} ${JSON.stringify(old)} → ${JSON.stringify(next)}`);
    }
  }

  if (changed > 0) {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
    console.log(`\n✓ 已修正 ${changed} 个单元的 depends，写回 _kitmeta.json`);
  } else {
    console.log('\n✓ 无需修正，登记与实际已一致');
  }
}

function detectL0Pollution() {
  const bad = [];
  for (const p of ['_core', 'ds']) {
    const dir = path.join(ROOT, p);
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) {
      const src = stripComments(fs.readFileSync(f, 'utf-8')).toLowerCase();
      for (const word of L0_FORBIDDEN) {
        // 只查标识符与注释外的文字，这里用宽松匹配 + 人工确认
        const re = new RegExp(`\\b${word.toLowerCase()}\\b`);
        if (re.test(src)) {
          bad.push(`${path.relative(ROOT, f)} 出现业务词 "${word}"`);
        }
      }
    }
  }
  return [...new Set(bad)];
}

// ==================== 主流程 ====================

function main() {
  if (process.argv.includes('--fix')) {
    fixDepends();
    return;
  }
  const graph = buildGraph();
  const nodes = new Set([...graph.keys(), ...[...graph.values()].flatMap((s) => [...s])]);

  console.log('依赖规则检测');
  console.log('='.repeat(60));
  console.log(`插件节点：${nodes.size}`);

  // 依赖出度
  const withDeps = [...graph.entries()].filter(([, d]) => d.size > 0);
  console.log(`有依赖的：${withDeps.length}`);
  for (const [from, deps] of withDeps.sort()) {
    const lf = LAYERS[from] ?? '?';
    const lt = [...deps].map((d) => `${d}(L${LAYERS[d] ?? '?'})`).join(', ');
    console.log(`  ${from}(L${lf}) → ${lt}`);
  }

  let failed = 0;

  console.log('\n[1] 环检测');
  const cycles = detectCycles(graph);
  if (cycles.length === 0) console.log('  ✓ 无环');
  else { cycles.forEach((c) => console.log(`  ✗ ${c}`)); failed++; }

  console.log('\n[2] 层违规（同模块豁免）');
  const { bad: viol, exempted } = detectLayerViolations(graph);
  if (viol.length === 0) console.log('  ✓ 无违规');
  else { viol.forEach((v) => console.log(`  ✗ ${v}`)); failed++; }
  if (exempted.length > 0) {
    console.log(`  ○ ${exempted.length} 条同模块依赖已豁免：`);
    exempted.forEach((e) => console.log(`      ${e}`));
  }

  console.log('\n[2b] 跨模块依赖（应走 Facade）');
  const cross = detectCrossModule(graph);
  if (cross.length === 0) console.log('  ✓ 无越界');
  else { cross.forEach((c) => console.log(`  ✗ ${c}`)); failed++; }

  console.log('\n[2c] 模块内聚性（CCP 提示，非错误）');
  for (const r of detectModuleCohesion(graph)) {
    console.log(`  ${r.m.padEnd(11)} ${String(r.size).padStart(2)} 个插件，模块内依赖 ${r.inner} 条`);
  }

  // [2d] 分层表覆盖面：反向核对，防止"新增目录忘了登记导致漏检"
  console.log('\n[2d] 分层表覆盖面（漏检比不检查更危险）');
  const uncovered = detectUncoveredDirs();
  if (uncovered.length === 0) console.log('  ✓ 所有插件目录都已纳入 LAYERS');
  else {
    console.log('  ⚠️ 以下目录不在 LAYERS 里，它们的依赖**永远不会被检查**：');
    uncovered.forEach((d) => console.log(`      ${d}`));
    failed++;
  }

  console.log('\n[3] 未标注分层的插件');
  const unknown = detectUnknownLayers(graph);
  if (unknown.length === 0) console.log('  ✓ 全部已标注');
  else { console.log(`  ⚠ 需在 LAYERS 里补：${unknown.join(', ')}`); failed++; }

  console.log('\n[4] L0 纯净度（基础设施不得含业务概念）');
  const pollution = detectL0Pollution();
  if (pollution.length === 0) console.log('  ✓ 干净');
  else {
    console.log(`  ⚠ ${pollution.length} 处疑似（需人工确认，可能是合法标识符）:`);
    pollution.slice(0, 10).forEach((p) => console.log(`      ${p}`));
  }

  console.log('\n[5] 登记与源码一致性（_kitmeta.depends vs 真实 import）');
  const drift = detectDependsDrift(graph);
  if (drift.ghost.length === 0 && drift.missing.length === 0) {
    console.log('  ✓ 登记与实际一致');
  } else {
    if (drift.ghost.length > 0) {
      console.log(`  ✗ 登记了但没 import（幽灵依赖）${drift.ghost.length} 条：`);
      drift.ghost.forEach((g) => console.log(`      ${g.dir} 登记了 ${g.dep}`));
    }
    if (drift.missing.length > 0) {
      console.log(`  ✗ import 了但没登记（复制时会漏文件）${drift.missing.length} 条：`);
      drift.missing.forEach((m) => console.log(`      ${m.from} → ${m.to}`));
    }
    console.log('  → 修法：node scripts/check-deps.js --fix');
    failed++;
  }

  console.log('\n' + '='.repeat(60));
  if (failed === 0) console.log('全部通过 ✓');
  else console.log(`有 ${failed} 项需要处理`);

  if (typeof process !== 'undefined' && failed > 0) process.exit(1);
}

main();
