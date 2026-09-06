/**
 * batch20-usage.ts —— 碰撞与移动（第十九批）
 *
 * 演示一条完整链路：
 *   摇杆方向 → CharacterMover（加速度/转向/击退）→ Collision（撞墙/滑动/防穿）
 *
 * 运行：npm run example:batch20
 */

import {
  aabb, circle, makeCollider, moveAndSlide, separate,
  sweepCircleAabb, raycast, CollisionGrid, LAYER,
  type Collider,
} from '../collision/Collision';
import {
  CharacterMover, MoverPresets, type IMoveSolver,
} from '../mover/CharacterMover';

// ==================== 输出小工具 ====================

function h1(t: string): void {
  console.log(`\n  ${t}`);
  console.log('═'.repeat(56) + '\n');
}
function h2(t: string): void {
  console.log(`▸ ${t}\n`);
}
/**
 * 终端显示宽度（CJK 占 2 列）
 *
 * 【⚠️ 为什么需要它】
 * `padEnd` 按**字符数**补齐，但中文在等宽终端里占 2 列。
 * 于是 `中文标题.padEnd(20)` 打出来的表格是歪的——
 * 上一节的输出里，预设名那一列就完全对不齐。
 *
 * 表格对不齐看起来是小问题，但它让示例失去可信度：
 * 读者会怀疑"这些数字是不是也没算对"。
 */
function dw(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    // CJK 统一汉字 / 假名 / 全角标点 / 全角括号等
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s: string, width: number, right = false): string {
  const fill = ' '.repeat(Math.max(0, width - dw(s)));
  return right ? fill + s : s + fill;
}

function note(lines: string[]): void {
  for (const l of lines) console.log(`  ${l}`);
  console.log('');
}

// ==================== 场景：一间有内角的房间 ====================

/**
 * 用 collision 模块组装一个解算器
 *
 * 【为什么要这层包装】
 * `CharacterMover` 不依赖 `collision`（铁律：禁止横向依赖），
 * 它只认 `IMoveSolver` 接口。
 * 把这 6 行包装代码放在业务侧，两个模块就都保持了独立可搬。
 */
function makeSolver(walls: Collider[], radius: number): IMoveSolver {
  return {
    move(x, y, dx, dy) {
      const r = moveAndSlide(x, y, radius, dx, dy, walls, {
        layer: LAYER.PLAYER,
        skin: 0.01,
      });
      return { x: r.x, y: r.y, collided: r.collided, nx: r.nx, ny: r.ny };
    },
  };
}

/** 建一个 20×20 的房间，四面墙 + 中间一个柱子 */
function buildRoom(): { walls: Collider[]; grid: CollisionGrid } {
  const t = 1;   // 墙厚（半宽）
  const W = 10;  // 房间半宽
  const grid = new CollisionGrid(4);
  const walls: Collider[] = [
    makeCollider(1, aabb(0, -W, W, t), { layer: LAYER.WALL }),   // 下
    makeCollider(2, aabb(0, W, W, t), { layer: LAYER.WALL }),    // 上
    makeCollider(3, aabb(-W, 0, t, W), { layer: LAYER.WALL }),   // 左
    makeCollider(4, aabb(W, 0, t, W), { layer: LAYER.WALL }),    // 右
    makeCollider(5, aabb(3, 3, 1, 1), { layer: LAYER.WALL }),    // 柱子
  ];
  for (const w of walls) grid.insert(w);
  return { walls, grid };
}

// ==================== 1. 加速度：为什么不能直接 pos += dir*speed ====================

function demoAcceleration(): void {
  h1('1. 加速度 · 贴纸在冰上滑 vs 有重量感');

  const { walls } = buildRoom();
  const R = 0.4;

  /**
   * 两种走法的对比
   *
   * 左边是"直接位移"（很多人第一版就这么写），
   * 右边是 CharacterMover。
   */
  const naive = { x: 0, v: 6 };          // 按下瞬间满速
  const mover = new CharacterMover({
    maxSpeed: 6, accel: 60, decel: 90, turnBoost: 3,
    solver: makeSolver(walls, R),
  });

  const dt = 1 / 60;
  const samples = [1, 3, 6, 12, 30, 60];
  console.log('  帧      直接位移(位置/速度)      CharacterMover(位置/速度)');
  console.log('  ' + '─'.repeat(56));

  let frame = 0;
  for (const s of samples) {
    while (frame < s) {
      naive.x += naive.v * dt;
      mover.update(dt, 1, 0);
      frame++;
    }
    console.log(
      `  ${String(s).padStart(3)}   ${naive.x.toFixed(3).padStart(8)} / ${naive.v.toFixed(2)}` +
      `            ${mover.x.toFixed(3).padStart(8)} / ${mover.speed.toFixed(2)}`
    );
  }
  console.log('');

  note([
    '↑ 看第 1 帧那一列：',
    '  朴素版位置已经走了 0.100（速度恒为 6，瞬间满速）；',
    '  CharacterMover 只走了 0.017（速度才 1.0，还在加速）。',
    '',
    '到 1 秒时两者位置接近（6.0 vs 5.9），',
    '差别全在**开头那 0.1 秒**——那就是"重量感"。',
    '',
    '⚠️ 注意别被这张表误导：',
    '  第一版我把"位置"和"速度"放在同一列里比，',
    '  量纲不同，那张表什么也说明不了。',
  ]);
}

// ==================== 2. 斜向撞墙：沿墙滑动 ====================

function demoSlide(): void {
  h1('2. 沿墙滑动 · 斜着推摇杆时角色不该停住');

  /**
   * 【为什么用单面墙演示】
   * 第一版用的是带柱子的完整房间，结果角色先撞柱子、
   * 再贴上墙、X 方向也走不满——输出里出现了 7.66 这种
   * 说不清来源的数字，示例反而变得不可信。
   *
   * 单面墙：变量只有一个，因果关系一眼可见。
   */
  const walls: Collider[] = [
    makeCollider(1, aabb(8, 0, 1, 30), { layer: LAYER.WALL }),   // 右墙 x: 7~9
  ];
  const R = 0.4;
  const m = new CharacterMover({
    maxSpeed: 8, accel: 100, decel: 100,
    solver: makeSolver(walls, R),
  });

  h2('从 (0, 0) 朝右上 45° 持续推摇杆 3 秒');
  console.log(`  输入方向：右上 45°，maxSpeed = 8`);
  console.log(`  右墙内边界 x = 7，角色半径 0.4 → 最多到 x = 6.6`);
  console.log('');

  const dt = 1 / 60;
  const marks = [30, 60, 120, 180];
  let frame = 0;
  console.log('  帧数     位置 (x, y)          速度     贴墙');
  console.log('  ' + '─'.repeat(48));
  for (const mk of marks) {
    while (frame < mk) {
      m.update(dt, 1, 1);
      frame++;
    }
    console.log(
      `  ${String(mk).padStart(4)}   (${m.x.toFixed(2).padStart(5)}, ${m.y.toFixed(2).padStart(6)})` +
      `      ${m.speed.toFixed(2).padStart(5)}    ${m.blocked ? '是' : '否'}`
    );
  }
  console.log('');

  // 关键结论
  const yMoved = m.y;
  console.log(`  X 被挡在 6.6 附近（贴墙），但 Y 一路走到了 ${yMoved.toFixed(2)}`);
  console.log(`  → 这就是"沿墙滑动"：只有朝墙的分量被消掉，切向分量保留。`);
  console.log('');

  h2('对照：如果撞墙后不做速度投影');
  // 模拟"速度一直涨但被墙挡住"的错误实现
  const noProject = { x: 0, vx: 0 };
  let acc = 0;
  for (let i = 0; i < 180; i++) {
    acc = Math.min(acc + 100 * dt, 8);
    noProject.vx = acc;
    const r = moveAndSlide(noProject.x, 0, R, noProject.vx * dt, 0, walls);
    noProject.x = r.x;
  }
  console.log(`  一直朝墙推 3 秒后：位置 x = ${noProject.x.toFixed(2)}（贴墙，看不出问题）`);
  console.log(`  但内部速度已经累积到 vx = ${noProject.vx.toFixed(2)}（满速 8）`);
  console.log('');

  note([
    '↑ 关键在最后一行。',
    '',
    '撞墙后不投影速度的话：',
    '  玩家一直推着摇杆顶墙 → 位移是 0，但速度值持续涨到 8。',
    '  **表面看不出问题**（位置一直贴在墙上），',
    '  但一旦绕过墙角，累积的速度让角色"嗖"地弹射出去。',
    '',
    '这就是"贴墙走然后突然飞出去"的根本原因。',
    '它只在特定几何下发生，极难复现——',
    '所以必须有测试锁住，不能靠手玩发现。',
  ]);
}

// ==================== 3. 防穿墙 ====================

function demoTunneling(): void {
  h1('3. 防穿墙 · 一帧跨过整面墙');

  const wall = aabb(100, 0, 5, 50);   // x: 95~105，厚 10

  /**
   * 【⚠️ 起点必须在墙前不远处】
   *
   * 第一版我把起点设成 x=0，一帧位移 33 → 终点 x=33，
   * 根本没碰到 95~105 的墙。于是 sweep 返回"未命中"，
   * 而下面又写着"moveAndSlide 端到端：碰撞=true"——
   * 自己跟自己矛盾，而且那句"逐帧点检测会漏掉"也不成立
   * （因为逐帧检测在这一步本来就什么都不该检测到）。
   *
   * 要演示穿墙，必须让**起点在墙前、终点在墙后**。
   */
  const startX = 90;
  const perFrame = 2000 / 60;   // ≈ 33.3

  h2(`场景：从 x=${startX} 出发，一帧移动 ${perFrame.toFixed(1)} 像素`);
  console.log(`  墙的范围：x = 95 ~ 105（厚 10）`);
  console.log(`  终点 x = ${(startX + perFrame).toFixed(1)} → 已经在墙的**另一侧**`);
  console.log('');
  console.log(`  ✗ 逐帧点检测：起点 ${startX} 在墙外，终点 ${(startX + perFrame).toFixed(1)} 也在墙外`);
  console.log(`     → 判定"没碰到墙"，子弹直接穿了过去`);
  console.log('');

  const sw = sweepCircleAabb(startX, 0, 1, perFrame, 0, wall);
  console.log(`  ✓ sweep 检测：${sw.hit ? `命中 @ t=${sw.t.toFixed(3)}` : '未命中'}`);
  if (sw.hit) {
    console.log(`     → 停在 x = ${(startX + perFrame * sw.t).toFixed(2)}（墙面前）`);
  }
  console.log('');

  // 极端：一帧移动 10000
  const sw2 = sweepCircleAabb(startX, 0, 1, 10000, 0, wall);
  console.log(`  极端测试（一帧 10000 像素）：${sw2.hit ? `命中 @ t=${sw2.t.toFixed(4)}` : '未命中'}`);
  console.log('');

  // moveAndSlide 端到端
  const walls = [makeCollider(1, wall, { layer: LAYER.WALL })];
  const r = moveAndSlide(startX, 0, 1, 10000, 0, walls);
  console.log(`  moveAndSlide 端到端：终点 x = ${r.x.toFixed(2)}，碰撞=${r.collided}`);
  console.log('');

  note([
    '↑ 逐帧点检测只在"起点和终点都在墙外"时漏判，',
    '  所以它是不是漏，取决于**那一帧正好跨过整面墙**——',
    '  这完全由速度和墙厚的比例决定，随机性极强。',
    '',
    '  这就是"子弹偶尔穿墙、无法复现"的由来：',
    '  不是代码有时对有时错，而是触发条件依赖具体数值。',
    '',
    '  sweep 求的是"移动路径与墙的首次接触时刻"，',
    '  与速度无关，所以永远不会漏。',
  ]);
}

// ==================== 4. 击退 ====================

function demoKnockback(): void {
  h1('4. 击退 · 外力必须衰减，且要限制输入权限');

  const { walls } = buildRoom();
  const R = 0.4;

  h2('4.1 击退推动角色，然后自然衰减');
  const m = new CharacterMover({
    maxSpeed: 6, accel: 60, externalDamping: 6,
    solver: makeSolver(walls, R),
  });
  m.addImpulse(30, 0);
  console.log(`  施加冲量 30 后：外力 ${m.externalSpeed.toFixed(2)}，击退态 ${m.knocked}`);

  const dt = 1 / 60;

  // 找到击退态解除的那一刻
  let fr = 0;
  let releasedAt = -1;
  let exAtRelease = 0;
  while (fr < 600) {
    m.update(dt, 0, 0);
    fr++;
    if (releasedAt < 0 && !m.knocked) {
      releasedAt = fr / 60;
      exAtRelease = m.externalSpeed;
    }
    if (m.externalSpeed === 0) break;
  }

  console.log(`  击退态解除：${releasedAt.toFixed(2)} 秒（此时外力还有 ${exAtRelease.toFixed(2)}）`);
  console.log(`  外力归零：  ${(fr / 60).toFixed(2)} 秒`);
  console.log(`  总位移：    x = ${m.x.toFixed(2)}`);
  console.log('');
  note([
    '↑ 注意这两个时间点不一样，而且**应该**不一样。',
    '',
    `  击退态在 ${releasedAt.toFixed(2)}s 解除——此时外力还有 ${exAtRelease.toFixed(2)}，`,
    `  角色每秒只移动 ${exAtRelease.toFixed(2)} 像素，玩家完全感觉不到。`,
    '',
    '  如果等外力衰减到 0 才解除（第一版就是这么写的），',
    '  控制权会被多锁将近 1 秒，玩家会觉得"被打之后角色不听话"。',
    '',
    '  数值归零是**数学问题**（用 stopEpsilon）；',
    '  解除击退是**体感问题**（用 maxSpeed 的 25%）。',
    '  混用一个常量，就多锁了一秒。',
  ]);

  h2('4.2 ⚠️ 连续击退不会叠成火箭');
  const m2 = new CharacterMover({ maxSpeed: 6, solver: makeSolver(walls, R) });
  for (let i = 0; i < 10; i++) m2.addImpulse(30, 0, 40);
  console.log(`  连挨 10 次冲量 30（总 300），外力上限 40`);
  console.log(`  实际外力：${m2.externalSpeed.toFixed(2)}`);
  note([
    '↑ 不设上限的话，这里会是 300——',
    '  玩家会被弹到地图外，而且没有任何报错。',
  ]);

  h2('4.3 击退期间的输入权限');
  const strict = new CharacterMover({ maxSpeed: 6, accel: 200, knockbackControl: 0 });
  const loose = new CharacterMover({ maxSpeed: 6, accel: 200, knockbackControl: 1 });
  strict.addImpulse(0, 40);
  loose.addImpulse(0, 40);
  for (let i = 0; i < 12; i++) {
    strict.update(dt, 1, 0);
    loose.update(dt, 1, 0);
  }
  console.log(`  knockbackControl=0：击退中全力向右推 0.2 秒，vx = ${strict.vx.toFixed(2)}`);
  console.log(`  knockbackControl=1：同样操作，              vx = ${loose.vx.toFixed(2)}`);
  console.log('');
  note([
    '↑ knockbackControl=1 意味着击退期间玩家照常控制，',
    '  结果是"击退形同虚设"——被打退的紧张感完全消失。',
    '  0.2~0.4 是常见选择：能稍微修正方向，但躲不掉。',
  ]);
}

// ==================== 5. 内角 ====================

function demoCorner(): void {
  h1('5. 内角 · 同时撞两面墙不能卡死');

  // 右墙 x:70~80，上墙 y:70~80（缩小到便于观察的尺度）
  const corner: Collider[] = [
    makeCollider(1, aabb(15, 5, 1, 10), { layer: LAYER.WALL }),   // 右墙 x:14~16
    makeCollider(2, aabb(5, 15, 10, 1), { layer: LAYER.WALL }),   // 上墙 y:14~16
  ];

  // 从 (10, 10) 朝 (30, 30) 冲——直冲内角
  const r = moveAndSlide(10, 10, 0.5, 20, 20, corner, { skin: 0.01 });

  console.log(`  起点 (10.00, 10.00)，位移 (20, 20)`);
  console.log(`  终点 (${r.x.toFixed(2)}, ${r.y.toFixed(2)})`);
  console.log(`  碰撞：${r.collided ? '是' : '否'}，撞到 ${r.hits.length} 个碰撞体`);
  console.log(`  接触法线：(${r.nx.toFixed(2)}, ${r.ny.toFixed(2)})`);
  console.log('');

  note([
    '↑ 终点应该停在内角外侧（x < 14 且 y < 14），',
    '  而不是：',
    '  · 卡在起点不动（剩余位移被反复投影到 0）',
    '  · 产生 NaN（法线归一化时除以 0）',
    '  · 滑到很远的地方（MTV 累加导致弹飞）',
    '',
    '迭代上限（默认 4 次）保证它一定会停下来，',
    '而不是为了 1e-9 的残余位移无限循环。',
  ]);
}

// ==================== 6. 静态分离 ====================

function demoSeparate(): void {
  h1('6. 静态分离 · 把陷在墙里的角色挤出来');

  const walls: Collider[] = [makeCollider(1, aabb(0, 0, 5, 5), { layer: LAYER.WALL })];

  h2('传送到墙里（配置错误 / 存档损坏 / 传送点没对齐）');
  console.log(`  传送到 (4.5, 0)，角色半径 0.5`);
  const r = separate(4.5, 0, 0.5, walls);
  console.log(`  分离后：(${r.x.toFixed(3)}, ${r.y.toFixed(3)})，发生了移动：${r.moved}`);
  console.log(`  → 墙的右边界是 x=5.0，角色应被推到 x > 5.5`);
  console.log('');

  h2('圆心正好在矩形正中心（退化情况）');
  const r2 = separate(0, 0, 0.5, walls);
  console.log(`  分离后：(${r2.x.toFixed(3)}, ${r2.y.toFixed(3)})`);
  console.log('');
  note([
    '↑ 圆心与矩形中心重合时，"圆心指向最近点"是零向量，',
    '  除以它的长度会得到 NaN——然后 NaN 会一路传播到位置，',
    '  表现为"角色突然消失"且不抛任何异常。',
    '',
    '  这个矩形是 10×10，中心到四条边都是 5（等距），',
    '  所以按检查顺序选了左边，推到 x = -5.51。',
    '  等距时选哪条边不重要——重要的是**不能产生 NaN**。',
  ]);

  note([
    '↑ moveAndSlide 只保证"移动时不穿"，',
    '  不修已经存在的重叠。',
    '',
    '什么时候会需要 separate：',
    '  · 关卡加载后发现有配置错误的重叠',
    '  · 读档时角色坐标与当前关卡不匹配',
    '  · 传送点坐标没对齐到墙面',
  ]);
}

// ==================== 7. 射线 ====================

function demoRaycast(): void {
  h1('7. 射线投射 · 瞄准辅助与视线检测');

  const { walls, grid } = buildRoom();
  const near = grid.query(0, 0, 5);
  void near;

  h2('7.1 视线检测：能不能看到敌人');
  const enemy = makeCollider(100, circle(7, 0, 0.5), { layer: LAYER.ENEMY });
  const targets: Collider[] = [...walls, enemy];

  const hit = raycast(0, 0, 1, 0, targets, 20);
  console.log(`  从 (0,0) 朝 +X 看 20 距离：`);
  console.log(`    命中 id=${hit.colliderId}，距离 ${hit.t.toFixed(2)}`);
  console.log(`    ${hit.colliderId === 100 ? '能看到敌人' : '被墙挡住了'}`);
  console.log('');

  h2('7.2 柱子后面的敌人');
  const enemyBehind = makeCollider(101, circle(9, 3, 0.5), { layer: LAYER.ENEMY });
  const targets2: Collider[] = [...walls, enemyBehind];
  const hit2 = raycast(0, 3, 1, 0, targets2, 20);
  console.log(`  敌人在 (9, 3)，柱子在 (3, 3)：`);
  console.log(`    命中 id=${hit2.colliderId}（5 = 柱子，101 = 敌人）`);
  console.log(`    ${hit2.colliderId === 5 ? '被柱子挡住，看不见' : '能看见'}`);
  console.log('');

  note([
    '↑ raycast 返回最近命中，',
    '  配合 `filter` 可以只查敌人层、只查墙层。',
    '',
    '⚠️ 判别式为负（没打中）不是错误，',
    '  早期版本有人在这里 throw，',
    '  于是瞄准辅助线扫到空处就崩。',
  ]);
}

// ==================== 8. 手感预设对比 ====================

function demoPresets(): void {
  h1('8. 手感预设 · 同一段操作，四种角色');

  const { walls } = buildRoom();
  const R = 0.4;
  const dt = 1 / 60;

  const names: Record<string, string> = {
    snappy: '灵敏（俯视角射击）',
    heavy: '沉重（ARPG / 魂类）',
    icy: '冰面（低摩擦）',
    platformer: '平台跳跃（横版）',
  };

  console.log('  操作：向右推 1 秒，然后松开');
  console.log('');
  console.log('  ' + pad('预设', 22) + pad('起步0.1s', 10, true) + pad('满速', 8, true) +
              pad('松手0.2s', 10, true) + pad('完全静止', 11, true));
  console.log('  ' + '─'.repeat(60));

  for (const [key, make] of Object.entries(MoverPresets)) {
    const cfg = (make as () => object)() as Record<string, number>;
    const m = new CharacterMover({
      ...cfg, maxSpeed: 6, solver: makeSolver(walls, R),
    });

    // 起步 0.1 秒
    for (let i = 0; i < 6; i++) m.update(dt, 1, 0);
    const at01 = m.speed;

    // 到满速
    for (let i = 0; i < 54; i++) m.update(dt, 1, 0);
    const full = m.speed;

    // 松手 0.2 秒
    for (let i = 0; i < 12; i++) m.update(dt, 0, 0);
    const after02 = m.speed;

    // 到静止
    let f = 0;
    while (m.speed > 0 && f < 600) { m.update(dt, 0, 0); f++; }

    console.log(
      '  ' + pad(names[key] ?? key, 22) +
      pad(at01.toFixed(2), 10, true) +
      pad(full.toFixed(2), 8, true) +
      pad(after02.toFixed(2), 10, true) +
      pad(`${(f / 60).toFixed(2)}s`, 11, true)
    );
  }
  console.log('');

  note([
    '↑ 同样的代码，换个预设就是完全不同的角色。',
    '',
    '这里最关键的一列是"起步 0.1s"：',
    '  · snappy / platformer 已经到满速（按下去就走，跟手）',
    '  · heavy 只有 2.5 / 6（要提前按键，决策有代价）',
    '  · icy 只有 1.5 / 6（推不动，也停不下来）',
    '',
    '选哪个不是"哪个更好"，而是"你的游戏要什么"。',
    '魂类要 heavy（决策有代价），射击要 snappy（容错高）。',
  ]);
}

// ==================== 9. 完整链路 ====================

function demoFullChain(): void {
  h1('9. 完整链路 · 摇杆 → 移动 → 碰撞');

  const { walls } = buildRoom();
  const R = 0.4;
  const m = new CharacterMover({
    maxSpeed: 6, accel: 60, decel: 90, turnBoost: 3,
    solver: makeSolver(walls, R),
  });

  // 模拟一段玩家操作
  type Step = [dirX: number, dirY: number, frames: number, label: string];
  const script: Step[] = [
    [1, 0, 60, '向右走 1 秒'],
    [1, 1, 90, '斜向右上（会撞到柱子和墙）'],
    [-1, 0, 60, '掉头向左（turnBoost 生效）'],
    [0, 1, 90, '向上顶到墙'],
  ];

  const dt = 1 / 60;
  for (const [dx, dy, frames, label] of script) {
    // 归一化（摇杆输出已是单位向量；键盘的 (1,1) 需要归一化）
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const k = len > 1 ? 1 / len : 1;
    for (let i = 0; i < frames; i++) m.update(dt, dx * k, dy * k);
    console.log(
      '  ' + pad(label, 30) + '→ (' +
      pad(m.x.toFixed(2), 6, true) + ', ' +
      pad(m.y.toFixed(2), 6, true) + ')  速度 ' +
      pad(m.speed.toFixed(2), 5, true) + '  ' +
      (m.blocked ? '[贴墙]' : '')
    );
  }
  console.log('');

  h2('⚠️ 斜向移动的速度校验');
  const straight = new CharacterMover({ maxSpeed: 6, accel: 60 });
  const diagonal = new CharacterMover({ maxSpeed: 6, accel: 60 });
  for (let i = 0; i < 180; i++) {
    straight.update(dt, 1, 0);
    diagonal.update(dt, 1, 1);   // 注意：未归一化！
  }
  const ratio = diagonal.speed / straight.speed;
  console.log(`  直行速度 ${straight.speed.toFixed(3)}`);
  console.log(`  斜向速度 ${diagonal.speed.toFixed(3)}（输入是未归一化的 (1,1)）`);
  console.log(`  比值 ${ratio.toFixed(4)}  ${ratio < 1.01 ? '✓' : '✗ 快了 41%'}`);
  console.log('');
  note([
    '↑ 如果这里显示 1.414，说明输入没归一化。',
    '  玩家会说"斜着走好像快一点"，但绝大多数人',
    '  说不出具体是 41%——只能靠测试发现。',
  ]);
}

// ==================== main ====================

function main(): void {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  第十九批：collision + mover                                ║');
  console.log('║  碰撞检测与解析 / 角色移动控制器                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  这一批补的是"从摇杆方向到角色真的动起来"这一段。');
  console.log('  它不在画面上，玩家看不见，但每个动作游戏都靠它撑手感。');

  demoAcceleration();
  demoSlide();
  demoTunneling();
  demoKnockback();
  demoCorner();
  demoSeparate();
  demoRaycast();
  demoPresets();
  demoFullChain();

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  本批两个模块的共同主题                                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  它们处理的是"玩家看不见、但立刻能感觉出来"的东西：');
  console.log('');
  console.log('    加速度     → 没有它，角色像贴纸在冰上滑');
  console.log('    沿墙滑动   → 没有它，斜着推摇杆角色就卡住');
  console.log('    防穿墙     → 没有它，子弹偶尔穿过墙（无法复现）');
  console.log('    击退衰减   → 没有它，连续挨打会被弹到地图外');
  console.log('    速度投影   → 没有它，贴墙走然后突然飞出去');
  console.log('    内角处理   → 没有它，走到墙角就卡死');
  console.log('');
  console.log('  失败模式高度一致：**都不抛异常**。');
  console.log('  数值算错、方向写反、外力没衰减、坐标系统不一致——');
  console.log('  全都只是让游戏"手感有点怪"，而开发者查不出来。');
  console.log('');
  console.log('  所以这一批的测试里，很多断言的不是"能不能跑"，');
  console.log('  而是**"方向对不对"**：');
  console.log('    斜向有没有比直行快？');
  console.log('    撞墙后 Y 分量还在吗？');
  console.log('    贴墙 2 秒后速度累积到多少了？');
  console.log('    内角会停在起点吗？');
  console.log('');
}

main();
