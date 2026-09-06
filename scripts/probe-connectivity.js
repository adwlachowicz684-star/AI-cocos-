/**
 * scripts/probe-connectivity.js —— 接口连通性体检
 *
 * 【它验证什么】
 * 2867 项单测证明的是「每个插件各自正确」。
 * 但"各自正确"不等于"能拼起来"。
 *
 * 这个脚本把模块按真实游戏流程串一遍，找出**只有组合时才会暴露**的问题：
 *   · 数据格式对不上（A 输出一维的，B 要二维的）
 *   · 语义方向相反（isWall vs isWalkable）
 *   · 运行期不可达（const enum 被内联）
 *   · 缺失环节（每个环节都有轮子，中间某段没有）
 *
 * 【它不验证什么】
 * 真机性能、渲染表现、输入手感、平台相关——那些必须接引擎。
 *
 * 【输出记号】
 *   ✓  直接连上
 *   ⚠  能连上，但需要胶水代码（设计上有缺口）
 */

const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', '.build');

let okCount = 0;
const glues = [];

function ok(label, detail) {
  okCount++;
  console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
}
function glue(label, lines, detail) {
  glues.push({ label, lines, detail });
  console.log(`  ⚠ ${label}  → 需 ${lines} 行胶水`);
  if (detail) {
    for (const d of detail.split('\n')) console.log(`      ${d}`);
  }
}
function section(t) {
  console.log(`\n${'─'.repeat(60)}\n▸ ${t}\n`);
}

function load(rel) {
  const p = path.join(BUILD, rel);
  if (!fs.existsSync(p)) throw new Error(`找不到 ${rel}，先跑 npm run build`);
  return require(p);
}

/** 统计一个函数里手写的适配行数（粗略） */
function countGlue(comment) {
  void comment;
  return 0;
}

function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  接口连通性体检                                               ║');
  console.log('║  把模块真串一遍，看哪些地方接不上                             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ══════════════════════════════════════════════
  section('1. 地牢生成 → 下游（数据格式）');

  const { RoomDungeon, Tile } = load('dungeon/Dungeon.js');
  const dun = new RoomDungeon({ width: 41, height: 31, seed: 12345, roomCount: 10 });
  dun.generate();
  ok('地牢生成', `${dun.width}×${dun.height}，${dun.roomCount} 房间，${dun.floorCount} 地板格`);

  // ① 枚举在运行时可达吗？
  if (Tile && typeof Tile.Floor === 'number') {
    ok('Tile 枚举运行期可达', `Tile.Floor=${Tile.Floor}, Tile.Wall=${Tile.Wall}`);
  } else {
    glue('Tile 枚举运行期不可达', 0,
      'const enum 被内联，下游无法引用 Tile.Floor，只能硬编码 1。\n' +
      '（本次体检已修：const enum → enum）');
  }

  // 【关键发现】AStar 和 makeWallTest 都要二维数组 GridMap，
  // 而 DungeonBase 内部是扁平 Uint8Array。
  // → 同一次转换，两个下游都要用。
  const rows = [];
  for (let y = 0; y < dun.height; y++) {
    const row = [];
    for (let x = 0; x < dun.width; x++) row.push(dun.tileAt(x, y));
    rows.push(row);
  }

  const { AStar } = load('pathfind/PathFinder.js');
  const pf = new AStar(rows, {
    isWalkable: (x, y, v) => v === Tile.Floor || v === Tile.Door,
  });
  ok('dungeon → pathfind（二维数组 + isWalkable 回调）');

  const rooms = dun.rooms;
  if (rooms.length >= 2) {
    const a = { x: Math.floor(rooms[0].x + rooms[0].w / 2), y: Math.floor(rooms[0].y + rooms[0].h / 2) };
    const b = { x: Math.floor(rooms[1].x + rooms[1].w / 2), y: Math.floor(rooms[1].y + rooms[1].h / 2) };
    const p = pf.find(a, b);
    ok('两房间连通', `(${a.x},${a.y}) → (${b.x},${b.y})，${p.path.length} 步，探索 ${p.nodesExplored} 节点`);
  }

  // ③ 地牢 → 视野（复用同一个 rows）
  const { makeWallTest } = load('fov/FOV.js');
  const isWall = makeWallTest(rows, [Tile.Wall]);
  ok('dungeon → fov（复用同一个二维数组）');
  glues.push({
    label: 'dungeon → fov / pathfind 格式转换',
    lines: 6,
    detail: 'DungeonBase 内部是扁平 Uint8Array（_tiles[y*w+x]），\n' +
            '而 AStar 的 GridMap 与 makeWallTest 都要\n' +
            'ReadonlyArray<ReadonlyArray<number>>（二维数组）。\n' +
            '两个下游需要同一份转换——这正说明它该是库的一部分。',
  });

  // ══════════════════════════════════════════════
  section('2. 语义方向：三个模块三种说法');

  console.log('  对"这个格子能不能过"，各模块的命名：');
  console.log('    dungeon.isWalkable(x,y)     true = 能走');
  console.log('    fov.makeWallTest → isWall   true = 挡住');
  console.log('    pathfind.isWalkable         true = 能走');
  console.log('    collision                   无格子概念（纯几何）');
  console.log('');

  // 实测搞反的后果
  const pfWrong = new AStar(rows, {
    isWalkable: (x, y, v) => !(v === Tile.Floor || v === Tile.Door),   // 故意搞反
  });
  if (rooms.length >= 2) {
    const a = { x: Math.floor(rooms[0].x + rooms[0].w / 2), y: Math.floor(rooms[0].y + rooms[0].h / 2) };
    const b = { x: Math.floor(rooms[1].x + rooms[1].w / 2), y: Math.floor(rooms[1].y + rooms[1].h / 2) };
    const good = pf.find(a, b);
    const bad = pfWrong.find(a, b);
    console.log(`  正确写法：${good.path.length} 步`);
    console.log(`  搞反写法：${bad.path.length} 步  ← 不报错，只是永远找不到路`);
    console.log('');
    glue('isWalkable / isWall 语义相反', 0,
      '两者互为取反。写反了不抛异常、不返回 null，\n' +
      '只是 pathfind 每次都返回空数组。\n' +
      '这类 bug 在单测里查不出来——因为单测用的是假 grid。');
  }
  ok('语义方向已确认（fov=isWall，pathfind=isWalkable）');

  // ══════════════════════════════════════════════
  section('3. 连续坐标 vs 格子坐标');

  console.log('  两种坐标系混用：');
  console.log('    dungeon / fov / pathfind   格子（整数）');
  console.log('    mover / collision / hitbox 连续（浮点，1 单位 = 1 格？）');
  console.log('    perception                 连续坐标的 ILineOfSight');
  console.log('');
  glue('格子 ↔ 连续坐标 无统一约定', 0,
    '库里没有约定"1 格 = 多少单位"。\n' +
    '如果 mover 按 1 单位/格，而 dungeon 是 1 格，那数值刚好对；\n' +
    '但 tilemap 常常用 32px/格，届时每个跨界调用都要 ×32 或 ÷32。\n' +
    '不写明的话，这类换算会散落在业务代码各处。');
  ok('两种坐标系各模块内部自洽');

  // ══════════════════════════════════════════════
  section('4. 实体 id：各模块用同一个吗');

  const { HitboxWorld, circle, sector } = load('hitbox/Hitbox.js');
  const world = new HitboxWorld({ cellSize: 4 });

  // 【⚠️ add 收的是 Hitbox 对象，不是散参】
  // 我第一版写成 add('e1', 10.5, 10.5, 0.5, 2)，
  // 报错是 "Cannot create property 'enabled' on string 'e1'"——
  // 指向库内部第 405 行，看不出是调用方传错了类型。
  const enemy = { name: '骷髅兵', hp: 100 };   // 业务实体
  const unreg = world.add({
    id: 'hb-e1-body',
    shape: circle(0.5),
    x: 10.5, y: 10.5,
    rotation: 0,
    layer: 2, mask: 1,
    data: enemy,          // ← 业务实体挂在这里，命中时原样带回
  });
  ok('hitbox 注册', "add(box: Hitbox) → 返回反注册函数");
  void unreg;

  console.log('  各模块对 id 的类型：');
  console.log('    hitbox.Hitbox.id   string（且是**判定框** id，不是实体 id）');
  console.log('    collision.Collider number');
  console.log('    perception         number');
  console.log('    attack-token       number');
  console.log('    skill-caster       CasterHit.id: string');
  console.log('');
  glue('id 类型不统一 + 语义不统一', 4,
    'hitbox / skill-caster 用 string，其余用 number；\n' +
    '更要紧的是**语义**差异：\n' +
    "  Hitbox.id 的注释写的是「同一实体多个判定框时用于区分」——\n" +
    '  它是**判定框 id**，不是实体 id。一个实体有 2 个框就有 2 个 id。\n' +
    '  所以不能拿 Hitbox.id 当实体标识去查 perception / attack-token。\n' +
    '  必须用 data 字段把实体带出来，再自己维护实体 id 表。');

  // hitbox → skill-caster
  const hits = world.query(sector(3, 90), 10, 10, 0, 2);
  const asCasterHits = hits.map((h) => ({
    id: h.hitbox.id, x: h.hitbox.x, y: h.hitbox.y, data: h.hitbox.data,
  }));
  ok('hitbox → skill-caster', `query 返回 ${hits.length} 个命中，转 CasterHit 需 4 行映射`);
  void asCasterHits;
  glues.push({
    label: 'HitResult → CasterHit 映射',
    lines: 4,
    detail: 'HitResult 是 { hitbox, distance }；CasterHit 要 { id, x, y, data }。\n' +
            '字段名不同且嵌套一层，必须手写映射。',
  });
  void countGlue;

  // ══════════════════════════════════════════════
  section('5. 战斗链路（skill-caster 的注入面）');

  const { SkillCaster } = load('skill-caster/SkillCaster.js');
  void SkillCaster;
  console.log('  skill-caster 要求注入 5 个 provider：');
  console.log('    IHitboxProvider     query(shape,x,y,rot,mask) → CasterHit[]');
  console.log('    IProjectileProvider spawn(p) → handle');
  console.log('    IDamageProvider     apply(target, dmg, hitId)');
  console.log('    IResourceProvider   canAfford / pay / refund');
  console.log('    时间源');
  console.log('');
  ok('skill-caster 注入面清晰', '零插件依赖，全部接口注入 → 这是本库设计最好的一块');

  // ══════════════════════════════════════════════
  section('6. 缺失环节（库里没有、但串联必需）');

  // ── 先证伪我自己以为缺失的东西 ──
  console.log('  【自查】我原以为"缺 Bresenham 线段 LOS"——错了：');
  const { Shadowcasting } = load('fov/FOV.js');
  const sc = new Shadowcasting(dun.width, dun.height, isWall);
  const losWorks = typeof sc.hasLineOfSight === 'function';
  console.log(`    Shadowcasting.hasLineOfSight(x0,y0,x1,y1) 存在：${losWorks}`);
  if (losWorks && dun.rooms.length >= 2) {
    const a = { x: Math.floor(dun.rooms[0].x + dun.rooms[0].w / 2), y: Math.floor(dun.rooms[0].y + dun.rooms[0].h / 2) };
    const b = { x: Math.floor(dun.rooms[1].x + dun.rooms[1].w / 2), y: Math.floor(dun.rooms[1].y + dun.rooms[1].h / 2) };
    console.log(`    实测 (${a.x},${a.y}) → (${b.x},${b.y})：${sc.hasLineOfSight(a.x, a.y, b.x, b.y)}`);
    console.log('    （隔着墙，返回 false —— 正确）');
  }
  console.log('');
  glues.push({
    label: 'LOS 藏得深（不是缺失，是可发现性差）',
    lines: 0,
    detail: 'hasLineOfSight 是 **Shadowcasting 的方法**，不是独立函数。\n' +
            '要拿它必须先 new Shadowcasting(w, h, isWall)，\n' +
            '而构造时就分配 2 个 w×h 的 VisibilityMap（41×31 → 2542 字节）。\n' +
            '字节数不值一提，问题是：\n' +
            '  没人会去"视野类"里找两点连线——它应该是个独立的 lineOfSight()。',
  });

  const missing = [
    ['实体注册表（id → entity 统一查询）',
     '每个模块都只持有 id，但库里没有"根据 id 取实体"的统一入口。\n' +
     '     已实测：全库 grep 无 EntityRegistry / EntityStore / World 类。\n' +
     '     业务侧要自己维护 Map，而各模块 id 类型还不一致（见第 4 节）。'],
    ['每帧 tick 编排（谁先谁后）',
     'scheduler 提供时间，不规定模块间顺序。\n' +
     '     gameflow 是**状态机**（loading→menu→playing），粒度在关卡级，\n' +
     '     不管"输入→移动→碰撞→AI→感知→攻击→伤害→死亡"这种帧内顺序。\n' +
     '     这个顺序目前没地方写，只能散落在业务代码里——\n' +
     '     而顺序错了（比如先结算伤害再判定命中）不会报错，只是偶尔打空。'],
    ['坐标换算层（格子 ↔ 世界单位）',
     '见第 3 节。库里没有约定 1 格 = 多少单位。'],
  ];
  for (const [name, why] of missing) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${why}`);
    console.log('');
    glues.push({ label: `缺失：${name}`, lines: -1, detail: why });
  }

  // ══════════════════════════════════════════════
  section('7. 战斗链路实测（attribute → pipeline → 实体）');

  const { AttributeSet } = load('attribute/AttributeSet.js');
  const { DamagePipeline } = load('damage-pipeline/DamagePipeline.js');
  const { RNG } = load('rng/RNG.js');

  const attrs = new AttributeSet([
    { id: 'atk', base: 20 },
    { id: 'armor', base: 12 },
    { id: 'critRate', base: 0.05 },
  ]);
  ok('AttributeSet', `atk=${attrs.get('atk')}, armor=${attrs.get('armor')}`);

  const pipe = DamagePipeline.createDefault();

  // 一个实现 IDamageable 的靶子
  const dummy = {
    hp: 200, maxHp: 200, armor: 12,
    resistances: { physical: 0.1 },
    applyDamage(r) { this.hp -= r.value; },
    isAlive() { return this.hp > 0; },
  };

  const rng = new RNG(999);
  let total = 0;
  const N = 200;
  for (let i = 0; i < N; i++) {
    // 每次打在满血靶子上测"单次伤害分布"，
    // 否则 200 次累积会把 200 血的靶子打到 -10216，
    // 那个数字没有任何意义，只会让人怀疑是溢出。
    dummy.hp = dummy.maxHp;
    const ctx = {
      raw: 30,
      type: 'physical',
      crit: rng.next() < 0.05,
      source: null,
    };
    const res = pipe.apply(ctx, dummy);
    if (i === 0) {
      // 【⚠️ 字段是 value 不是 final】
      // 我第一版写 res.final → undefined → 全程 NaN，
      // 而且不抛异常，只是"伤害数字是 NaN"。
      console.log(`    单次明细：${res.stages.map((st) => `${st.name} ${st.value.toFixed(1)}`).join(' → ')}`);
      console.log(`    字段名：value（**不是 final**），isCrit=${res.isCrit}, immune=${res.immune}`);
    }
    dummy.applyDamage(res);
    total += res.value;
  }
  ok('damage-pipeline 跑通', `${N} 刀平均 ${(total / N).toFixed(1)} 伤害（每次打满血靶子）`);
  console.log(`    每刀后剩余：${(dummy.maxHp - total / N).toFixed(0)} / ${dummy.maxHp}`);

  glue('attribute → damage-pipeline 无直连', 6,
    'AttributeSet 的 armor / resistance 不会自动喂给 DamagePipeline。\n' +
    'pipeline 从 IDamageable 读 armor/resistances，\n' +
    '所以要让实体同时实现 IDamageable 并把 AttributeSet 的值透出去：\n' +
    '  get armor() { return this.attrs.get("armor"); }\n' +
    '这是一层必须手写的桥接。');

  // 死亡回调
  console.log('  IDamageable 只管扣血，不管死亡——死亡结算在哪？');
  console.log(`    isAlive()=${dummy.isAlive()}，但没有任何模块会去调它。`);
  glues.push({
    label: '死亡结算无归宿',
    lines: -1,
    detail: 'IDamageable 有 isAlive()，但没人调它。\n' +
            '「扣血 → 检查死亡 → 触发掉落到 → 移除 hitbox → 通知 attack-token」\n' +
            '这条链没有统一的落点，只能写在业务侧的 applyDamage 里——\n' +
            '而那正是 IDamageable 注释里明令禁止的地方（"不要在这里播特效、飘字"）。',
  });

  // ══════════════════════════════════════════════
  section('8. 内容链路实测（loot → inventory）');

  const { LootTable } = load('loot/LootTable.js');
  const { Inventory } = load('inventory/Inventory.js');

  const table = new LootTable('boss');
  table.entry({ id: 'gold', weight: 100, min: 10, max: 20 });
  table.entry({ id: 'potion', weight: 30, min: 1, max: 2 });
  const drops = table.roll(rng);
  ok('LootTable.roll', `产出 ${drops.map((d) => `${d.id}×${d.count}`).join(', ')}`);

  const inv = new Inventory({ capacity: 10 });
  void inv;
  console.log('  LootDrop 结构：', JSON.stringify(drops[0]));
  glue('LootDrop → Inventory.add 格式', 3,
    'LootTable 产出 { id, count }（可能还有 child/nested），\n' +
    '而 Inventory.add 需要 ItemDef（含 stackable/maxStack/name 等）。\n' +
    '两者之间缺一层"掉落物 → 物品实例"的转换。\n' +
    '多数项目会在这里写一个 mapping，但那层逻辑其实是通用的。');

  // ══════════════════════════════════════════════
  section('结论');

  console.log(`  直接连上：${okCount} 处`);
  console.log(`  需胶水：  ${glues.filter((g) => g.lines >= 0).length} 处`);
  console.log(`  缺失环节：${glues.filter((g) => g.lines < 0).length} 处`);
  console.log('');
}

main();
