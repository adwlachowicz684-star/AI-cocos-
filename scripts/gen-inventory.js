/**
 * scripts/gen-inventory.js —— 从 _kitmeta.json 生成清单片段
 *
 * ============================================================
 * 【为什么需要它】
 * ============================================================
 *
 * 轮子清单.md 里的「全景图」和「速查表」是手写的。
 * 手写的后果是：插件涨到 118 个时，全景图只收录了 68 个——
 * **漏了 50 个，占总数 42%**。
 *
 * 而且漏得毫无规律：新加的批次整批没进图，
 * 因为加插件时改的是 _kitmeta.json 和插件自己的 README，
 * 没人想起改全景图。
 *
 * 所以改成**生成**：`_kitmeta.json` 是唯一数据源，
 * 全景图由它渲染。以后加插件只要登记 kitmeta，图自然就全。
 *
 * 【运行】
 * ```bash
 * node scripts/gen-inventory.js          # 打印到 stdout
 * node scripts/gen-inventory.js --write  # 直接写回轮子清单.md
 * ```
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const META = JSON.parse(fs.readFileSync(path.join(ROOT, '_kitmeta.json'), 'utf-8'));

// ==================== 领域顺序与说明 ====================

/**
 * 领域展示顺序，以及每个领域的一句话说明
 *
 * 【顺序的讲究】
 * 从"不装就会歪"到"没有也能跑"，
 * 越靠前越基础。新人从上往下读，知道该先装什么。
 */
const DOMAIN_ORDER = [
  { id: '基础设施', note: '零依赖。其余一切的地基，复制任何插件都要带上' },
  { id: '地基', note: '不装这些，后面的一切都会歪' },
  { id: '通用工具', note: '通用小件，按需取用' },
  { id: '算法与地图', note: '不认识你的游戏，只认数字和坐标 —— 最易复用' },
  { id: '数值与战斗', note: '打得到、打得中、打得疼' },
  { id: '移动与碰撞', note: '从「方向」到「角色真的动起来」' },
  { id: 'AI与感知', note: '敌人怎么发现你、怎么决策' },
  { id: '内容与掉落', note: '打完之后掉什么、掉多少' },
  { id: '玩法框架', note: '具体玩法的骨架' },
  { id: '进度与统计', note: '跨局的东西：存档、成就、评分' },
  { id: '表现与外壳', note: '玩家能感知、但说不清的「感觉」' },
  { id: '评分与匹配', note: '多人对战：分数、撮合、对局运维' },
  { id: '工程与运维', note: '开发期与线上：调试、埋点、崩溃、反作弊' },
  { id: '适配与实体', note: '轮子之间的轴，以及「这个 id 是谁」' },
];

// ==================== 收集 ====================

/** 读取目录下所有 .ts 的行数 */
function countLines(plugin) {
  const files = plugin.path.split(',').map((s) => s.trim()).filter(Boolean);
  let n = 0;
  for (const f of files) {
    let p = path.join(ROOT, f);
    try {
      if (fs.statSync(p).isDirectory()) {
        for (const x of fs.readdirSync(p)) {
          if (x.endsWith('.ts')) n += countFile(path.join(p, x));
        }
      } else {
        n += countFile(p);
      }
    } catch { /* 文件不存在就跳过 */ }
  }
  return n;
}

function countFile(p) {
  try {
    return fs.readFileSync(p, 'utf-8').split('\n').length;
  } catch {
    return 0;
  }
}

/** 从 tests/ 统计某插件的测试项数（按 describe 块名匹配） */
function testCountOf(plugin) {
  // 缓存：所有测试文件只读一次
  if (!testCountOf._cache) {
    const cache = {};
    const dir = path.join(ROOT, 'tests');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf-8');
      // 匹配 describe('X · Y') 块内 ✓ 的数量
      const blocks = src.split(/\n\s*describe\(/).slice(1);
      for (const b of blocks) {
        const head = b.slice(0, b.indexOf('\n'));
        const m = head.match(/'([^']+)'/);
        if (!m) continue;
        const n = (b.match(/^\s*test\(/gm) || []).length;
        cache[m[1]] = (cache[m[1]] || 0) + n;
      }
    }
    testCountOf._cache = cache;
  }
  return testCountOf._cache;
}

// ==================== 渲染 ====================

/** 渲染全景图（目录树） */
function renderTree() {
  const byDomain = new Map();
  for (const d of DOMAIN_ORDER) byDomain.set(d.id, []);
  for (const p of META.plugins) {
    const list = byDomain.get(p.domain);
    if (list) list.push(p);
    else console.error(`⚠️ 未知领域：${p.domain}（${p.name}）`);
  }

  const lines = [];
  lines.push('```');
  lines.push('cocos-kit/');

  for (const dom of DOMAIN_ORDER) {
    const list = (byDomain.get(dom.id) || [])
      .slice()
      .sort((a, b) => a.dir.localeCompare(b.dir));
    if (list.length === 0) continue;

    lines.push('│');
    lines.push(`├── 【${dom.id}】${dom.note}`);
    list.forEach((p, i) => {
      const last = i === list.length - 1;
      const branch = last ? '└──' : '├──';
      // 单元名与目录名不同时标注出来
      const nameTag = p.name === p.dir ? '' : `（${p.name}）`;
      lines.push(`│   ${branch} ${p.dir}/${nameTag}`);
    });
  }

  lines.push('│');
  lines.push('├── examples/              19 个可运行示例');
  lines.push('├── tests/                 2948 项测试，零依赖迷你框架');
  lines.push('├── scripts/               依赖检查 / 接口体检 / 清单生成');
  lines.push('└── typings/               ⚠️ 真实 Cocos 项目要删掉');
  lines.push('```');
  return lines.join('\n');
}

/**
 * 渲染领域概览（README 用）
 *
 * 【为什么 README 不直接放完整目录树】
 * 118 个目录全列出来，README 就有 130 行纯目录——
 * 那是轮子清单的活。README 应该一眼看清"有哪些类、每类大概是什么"，
 * 想看全的去轮子清单。
 *
 * 而且完整树手写的下场已经验证过了：
 * 轮子清单漏 50 个（42%），README 漏 66 个（56%）。
 */
function renderOverview() {
  const byDomain = new Map();
  for (const d of DOMAIN_ORDER) byDomain.set(d.id, []);
  for (const p of META.plugins) {
    const list = byDomain.get(p.domain);
    if (list) list.push(p);
  }

  const lines = [];
  lines.push('```');
  lines.push('cocos-kit/');
  for (const dom of DOMAIN_ORDER) {
    const list = (byDomain.get(dom.id) || [])
      .slice().sort((a, b) => a.dir.localeCompare(b.dir));
    if (list.length === 0) continue;

    lines.push('│');
    lines.push(`├── 【${dom.id}】${list.length} 个 —— ${dom.note}`);
    // 小领域全列，大领域列代表 + 省略号
    const shown = list.length <= 5 ? list : list.slice(0, 4);
    shown.forEach((p) => {
      lines.push(`│   ├── ${p.dir}/`);
    });
    if (list.length > 5) {
      lines.push(`│   └── … 另有 ${list.length - 4} 个，见轮子清单 §1`);
    }
  }
  lines.push('│');
  lines.push('├── examples/              19 个可运行示例');
  lines.push('├── tests/                 2948 项测试，零依赖迷你框架');
  lines.push('├── scripts/               依赖检查 / 接口体检 / 清单生成');
  lines.push('└── typings/               ⚠️ 真实 Cocos 项目要删掉');
  lines.push('```');
  return lines.join('\n');
}

/** 渲染速查表（按领域分组的紧凑表格） */
function renderTable() {
  const byDomain = new Map();
  for (const d of DOMAIN_ORDER) byDomain.set(d.id, []);
  for (const p of META.plugins) {
    const list = byDomain.get(p.domain);
    if (list) list.push(p);
  }

  const out = [];
  const tc = testCountOf();
  for (const dom of DOMAIN_ORDER) {
    const list = (byDomain.get(dom.id) || [])
      .slice()
      .sort((a, b) => a.dir.localeCompare(b.dir));
    if (list.length === 0) continue;
    out.push(`### ${dom.id}（${list.length} 个）`);
    out.push('');
    out.push('| 目录 | 作用 | 依赖 | 引擎耦合 | 测试 |');
    out.push('|---|---|---|---|---|');
    let sum = 0;
    for (const p of list) {
      const dep = (p.depends || []).length === 0 ? '无' : p.depends.join(', ');
      // 该目录下所有 describe 块的测试数之和
      const n = Object.entries(tc)
        .filter(([k]) => k.startsWith(p.dir + ' ') || k === p.dir)
        .reduce((s, [, v]) => s + v, 0);
      sum += n;
      out.push(
        `| \`${p.dir}/\` | ${p.purpose} | ${dep} | ❌ | ${n} |`
      );
    }
    out.push('');
    out.push(`> 小计 **${sum}** 项测试`);
    out.push('');
  }
  return out.join('\n');
}

// ==================== 主流程 ====================

const args = process.argv.slice(2);
const mode = args[0] || 'tree';

if (mode === 'tree') {
  console.log(renderTree());
} else if (mode === 'table') {
  console.log(renderTable());
} else if (mode === '--write') {
  const target = path.join(ROOT, '轮子清单.md');
  let doc = fs.readFileSync(target, 'utf-8');
  const tree = renderTree();

  // 替换「## 1. 全景图」与「## 2. 速查表」之间的代码块
  const startIdx = doc.indexOf('## 1. 全景图');
  const endIdx = doc.indexOf('## 2. 速查表');
  if (startIdx < 0 || endIdx < 0) {
    console.error('✗ 找不到锚点：## 1. 全景图 / ## 2. 速查表');
    process.exit(1);
  }
  const before = doc.slice(0, startIdx);
  const after = doc.slice(endIdx);
  doc = `${before}## 1. 全景图\n\n${tree}\n\n---\n\n${after}`;
  fs.writeFileSync(target, doc, 'utf-8');
  console.log(`✓ 已写回 ${path.relative(ROOT, target)}`);
  console.log(`  收录 ${META.plugins.length} 个插件单元`);
} else if (mode === 'overview') {
  console.log(renderOverview());
} else if (mode === '--write-readme') {
  const target = path.join(ROOT, 'README.md');
  let doc = fs.readFileSync(target, 'utf-8');
  const startIdx = doc.indexOf('## 三、目录结构');
  const endIdx = doc.indexOf('\n## ', startIdx + 10);
  if (startIdx < 0 || endIdx < 0) {
    console.error('✗ 找不到锚点：## 三、目录结构');
    process.exit(1);
  }
  const head = '## 三、目录结构\n\n' +
    '> **这张图是生成的，不要手改。**\n' +
    '> 数据源 `_kitmeta.json`，改完运行 `npm run gen:inventory`。\n' +
    '>\n' +
    '> 完整清单（118 个逐个列出）见 [`轮子清单.md` §1](./轮子清单.md#1-全景图)。\n' +
    '> 这里只给领域概览——README 不该有 130 行纯目录。\n\n';
  doc = doc.slice(0, startIdx) + head + renderOverview() + '\n' + doc.slice(endIdx + 1);
  fs.writeFileSync(target, doc, 'utf-8');
  console.log(`✓ 已写回 ${path.relative(ROOT, target)}`);
} else if (mode === '--check') {
  // 检查全景图是否收录完整
  const doc = fs.readFileSync(path.join(ROOT, '轮子清单.md'), 'utf-8');
  const seg = doc.slice(doc.indexOf('## 1. 全景图'), doc.indexOf('## 2. 速查表'));
  const missing = META.plugins.filter((p) => !seg.includes(`${p.dir}/`));
  if (missing.length === 0) {
    console.log(`✓ 全景图收录完整（${META.plugins.length}/${META.plugins.length}）`);
  } else {
    console.log(`✗ 全景图漏收录 ${missing.length} 个：`);
    for (const p of missing) console.log(`   ${p.dir}/`);
    process.exit(1);
  }
} else {
  console.log('用法：node scripts/gen-inventory.js [tree|table|overview|--write|--write-readme|--check]');
}
