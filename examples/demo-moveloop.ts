/**
 * demo-moveloop.ts —— 移动闭环纯逻辑 Demo（无引擎）
 *
 * 【这个 Demo 存在的理由】
 *
 * 库里有 3034 项测试，但它们验证的是"每个模块各自对不对"。
 * 把模块拼起来能不能跑通，是另一回事——
 *
 *   单测证明 A 对、B 对；不证明 A 的输出 B 吃得下。
 *
 * 本文件把「移动 → 碰撞 → 冲刺 → 技能排队」串成一局可运行的
 * 无头游戏（headless），用固定步长跑若干帧，打印状态。
 * 全程不 import 任何引擎，纯 Node 可跑。
 *
 * 【如何运行】
 *   npm run demo
 *
 * 【相关文档】
 *   顶层：[轮子清单.md](../%E8%BD%AE%E5%AD%90%E6%B8%85%E5%8D%95.md) · [README.md](../README.md)
 *   模块：joystick-mover · mover · collision · dash · skill-caster · skill-queue · input
 *
 * 【验证的是什么】
 *   ① 接口对得上（JoystickCore 的 dir 能否直接喂给 CharacterMover）
 *   ② 时序对得上（谁先 tick、谁后 tick）
 *   ③ 组合行为合理（撞墙不穿模、冲刺不被卡、CD 补发真的补上了）
 *
 * 【⚠️ 本文件不替代单测】
 * 它不断言，只打印。作用是"让人一眼看出接错了"，
 * 而不是"CI 里自动拦截"。
 */

import {
  JoystickCore,
  JoystickOutput,
} from '../joystick-mover/JoystickCore';

import { CharacterMover, MoverConfig, IMoveSolver, MoveOutcome } from '../mover/CharacterMover';

import {
  CollisionGrid,
  Collider,
  LAYER,
  makeCollider,
  aabb,
  moveAndSlide,
} from '../collision/Collision';

import { DashController, DashOptions } from '../dash/DashController';

import { SkillCaster, SkillDef, CastContext } from '../skill-caster/SkillCaster';
import { SkillQueue } from '../skill-queue/SkillQueue';
import { InputBuffer } from '../input/InputBuffer';

// ============================================================
// 0. 固定步长主循环
// ============================================================

const DT = 1 / 60;

/** 简单的日志 */
function log(s: string): void {
  console.log(s);
}

function section(title: string): void {
  console.log(`\n${'='.repeat(56)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(56));
}

/**
 * 自检：Demo 不断言、不参与 CI，但会打 ✓ / ✗
 *
 * 【为什么要有】
 * "不断言"是为了不让它变成第二个测试套件，
 * 但完全没有判据的话，接错了你也看不出来——
 * 比如我第一版把场景 A 写成了"撞右墙"，
 * 实际角色停在中间那堵墙前，日志却说"应停在 362"。
 * 数字对不上，但因为没标 ✓/✗，我把它当正常输出读过去了。
 */
let _checks = { pass: 0, fail: 0 };

function check(label: string, ok: boolean, detail: string): void {
  _checks[ok ? 'pass' : 'fail']++;
  console.log(`  ${ok ? '✓' : '✗'} ${label} —— ${detail}`);
}

// ============================================================
// 1. 场景：几堵墙 + 一个角色
// ============================================================

/**
 * 碰撞解算器：把 collision 的 moveAndSlide 适配成
 * CharacterMover 需要的 IMoveSolver 形状。
 *
 * 【这是"适配器"的意义】
 * CharacterMover 只要求 `move(x,y,dx,dy) → {x,y,collided,nx,ny}`，
 * 它不关心底层是 sweep、是网格、还是什么都没有。
 * 所以换碰撞方案时，只改这一处。
 */
class GridSolver implements IMoveSolver {
  private readonly _grid: CollisionGrid;
  private readonly _radius: number;

  constructor(grid: CollisionGrid, radius: number) {
    this._grid = grid;
    this._radius = radius;
  }

  move(x: number, y: number, dx: number, dy: number): MoveOutcome {
    // 只查附近的墙（宽阶段），再交给 moveAndSlide 精算
    const near = this._grid.query(x + dx, y + dy, this._radius + Math.hypot(dx, dy) + 8);
    const r = moveAndSlide(x, y, this._radius, dx, dy, near, { mask: LAYER.WALL });
    // 【类型桥接】collision 的 MoveResult 多了 hits 字段，
    // 而 mover 的 MoveOutcome 只要前四个。结构兼容，直接映射。
    return { x: r.x, y: r.y, collided: r.collided, nx: r.nx, ny: r.ny };
  }
}

function buildScene(): { grid: CollisionGrid; walls: Collider[] } {
  const grid = new CollisionGrid(64);
  const walls: Collider[] = [];

  const add = (x: number, y: number, hw: number, hh: number) => {
    const c = makeCollider(grid.nextId(), aabb(x, y, hw, hh), {
      layer: LAYER.WALL,
      mask: LAYER.ALL,
    });
    walls.push(c);
    grid.insert(c);
  };

  // 房间四壁
  add(0, -260, 400, 20); // 上
  add(0, 260, 400, 20); // 下
  add(-400, 0, 20, 260); // 左
  add(400, 0, 20, 260); // 右

  // 中间一堵墙（测试滑动）
  add(60, -60, 15, 120);

  return { grid, walls };
}

// ============================================================
// 2. 输入：摇杆 + 按键缓冲
// ============================================================

/**
 * 模拟玩家的虚拟手柄
 *
 * 【为什么要模拟而不是真输入】
 * 无引擎环境下没有触摸事件。但 JoystickCore 是纯逻辑的——
 * 它的 onDown/onMove/onUp 接受的是**坐标数字**，
 * 所以我们可以用脚本喂坐标，等价于手指在拖。
 */
class VirtualPad {
  readonly stick = new JoystickCore({
    radius: 80,
    deadZone: 0.15,
    mode: 'dynamic',
    normalizeOutput: true,
  });

  readonly buffer = new InputBuffer({ window: 0.2 });

  /** 当前帧的摇杆输出（复用对象，不要存引用） */
  private _out: JoystickOutput | null = null;

  /** 按下摇杆（dynamic 模式：底盘生成在按下点） */
  touchDown(x: number, y: number): void {
    this.stick.onDown(1, x, y);
  }

  touchMove(x: number, y: number): void {
    this.stick.onMove(1, x, y);
  }

  touchUp(): void {
    this.stick.onUp(1);
  }

  /** 按一下技能键 */
  press(action: string): void {
    this.buffer.press(action);
  }

  tick(dt: number): void {
    this.buffer.tick(dt);
    this._out = this.stick.evaluate();
  }

  /** 摇杆方向（每帧新取，不缓存引用） */
  get dir(): { x: number; y: number } {
    return this._out ? this._out.dir : { x: 0, y: 0 };
  }

  get magnitude(): number {
    return this._out ? this._out.magnitude : 0;
  }
}

// ============================================================
// 3. 角色：移动 + 冲刺 + 技能
// ============================================================

interface DemoState {
  mover: CharacterMover;
  dash: DashController;
  facingDeg: number;
  dashCount: number;
}

function makeMover(cfg: MoverConfig, solver: IMoveSolver): CharacterMover {
  return new CharacterMover({ ...cfg, solver, x: 0, y: 0 });
}

// ============================================================
// 4. 技能：一个近战挥砍 + 一个冲刺
// ============================================================

function buildSkills(caster: SkillCaster): void {
  const slash: SkillDef = {
    id: 'slash',
    name: '挥砍',
    cooldown: 1.0,
    windup: 0.08,
    hitDelay: 0.05,
    hitWindow: 0.1,
    recover: 0.15,
    hitShape: { kind: 'circle', radius: 60, offsetX: 40 },
    damage: { raw: 25, type: 'physical', canCrit: true },
    mask: LAYER.ENEMY,
    origin: 'caster',
    lockFacing: true,
  };

  const heavy: SkillDef = {
    id: 'heavy',
    name: '重击',
    cooldown: 2.5,
    windup: 0.3,
    hitDelay: 0.1,
    hitWindow: 0.15,
    recover: 0.4,
    hitShape: { kind: 'circle', radius: 90, offsetX: 60 },
    damage: { raw: 60, type: 'physical', canCrit: true },
    mask: LAYER.ENEMY,
    origin: 'caster',
    lockFacing: true,
  };

  caster.learn(slash).learn(heavy);
}

// ============================================================
// 5. 主流程
// ============================================================

function main(): void {
  console.log('\n' + '█'.repeat(56));
  console.log('  移动闭环 Demo —— 无引擎，纯逻辑');
  console.log('█'.repeat(56));

  // ---------- 5.1 建场景 ----------
  const { grid, walls } = buildScene();
  const RADIUS = 18;
  const solver: IMoveSolver = new GridSolver(grid, RADIUS);

  section('5.1 场景');
  log(`  墙 ${walls.length} 堵，碰撞格子 ${grid.bucketCount} 个`);
  log(`  角色半径 ${RADIUS}，起始位置 (0, 0)`);

  // ---------- 5.2 建角色 ----------
  const mover = makeMover(
    {
      maxSpeed: 240,
      accel: 1600,
      decel: 2400, // ≈ accel × 1.5
      turnBoost: 4,
      friction: 0,
      stopEpsilon: 1,
      knockbackControl: 0.3,
    },
    solver,
  );

  const dash = new DashController({
    speed: 900,
    duration: 0.16,
    cooldown: 1.2,
    charges: 1,
    invulnerable: true,
  } as DashOptions);

  const st: DemoState = {
    mover,
    dash,
    facingDeg: 0,
    dashCount: 0,
  };

  // ---------- 5.3 建技能 ----------
  const caster = new SkillCaster({
    onCast: (def) => log(`      [施法] ${def.name}（CD ${def.cooldown}s）`),
    onFail: (def, reason) => log(`      [失败] ${def.name} → ${reason}`),
  });
  buildSkills(caster);

  // 【关键接线】SkillQueue 是 caster 与输入之间的编排层
  const queue = new SkillQueue(caster, {
    window: 0.25, // 必须 > 想容忍的提前量
    capacity: 1,
    onCast: (id, _ctx, waited) =>
      log(`      [补发] ${id} 等待 ${(waited * 1000).toFixed(0)}ms 后放出`),
    onReject: (id, reason) => log(`      [丢弃] ${id} → ${reason}`),
  });

  const pad = new VirtualPad();

  // 动作名 → 技能 id
  const MAPPING: Record<string, string> = {
    attack: 'slash',
  };

  // ---------- 5.4 帧循环 ----------
  /**
   * 【每帧的顺序很重要】
   *
   *   ① 输入 tick（缓冲老化）
   *   ② 队列 poll（把缓冲里的意图转成队列请求）
   *   ③ 队列 tick（尝试释放 / 清理过期）
   *   ④ 施法器 tick（推进 windup→active→recover）
   *   ⑤ 冲刺 tick
   *   ⑥ 移动 update
   *
   * 顺序错了会怎样：
   * - ② 在 ① 之前：缓冲还没老化，过期输入也会被消费
   * - ③ 在 ② 之前：本帧新按的技能要等一帧才入队
   * - ⑥ 在 ④ 之前：施法用的是上一帧的位置
   */
  function frame(n: number): void {
    // ① 输入
    pad.tick(DT);
    const dir = pad.dir;

    // ② 队列取输入
    const ctx = (): CastContext => ({
      x: mover.x,
      y: mover.y,
      facingDeg: st.facingDeg,
      source: 'player',
    });
    queue.poll(pad.buffer, MAPPING, ctx);

    // ③ 队列推进
    queue.tick(DT);

    // ④ 施法器推进
    caster.tick(DT);

    // ⑤ 冲刺
    const dashStateBefore = dash.state;
    dash.tick(DT);
    if (dashStateBefore === 'dashing' && dash.state !== 'dashing') {
      st.dashCount++;
    }

    // ⑥ 移动（冲刺期间用冲刺位移，否则用摇杆）
    if (dash.active) {
      // 【坑】冲刺期间直接 teleport 会穿墙。
      // 正确做法：把冲刺位移也交给 solver，让它做 sweep。
      st.mover.moveBy(dash.deltaX / DT, dash.deltaY / DT, DT);
    } else {
      st.mover.update(DT, dir.x, dir.y);
    }

    // 朝向：有输入就更新（施法锁定由 caster 内部处理）
    if (dir.x !== 0 || dir.y !== 0) {
      st.facingDeg = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
    }

    void n;
  }

  // ---------- 5.5 场景 A：摇杆推向右，撞墙滑动 ----------
  section('5.5 场景 A —— 摇杆右推 2 秒，撞右墙后停住');
  /**
   * 【为什么从 y=150 出发】
   * 中间那堵墙跨 y ∈ [-180, 60]。若从 (0,0) 向右推，
   * 角色会先撞上它停在 x=27 —— 那就不是"右墙"测试了。
   * 我第一版正是这么写的，日志却标"应停在 362"，
   * 数字对不上却没报错，差点当成正常输出读过去。
   */
  mover.teleport(0, 150);
  pad.touchDown(0, 150);
  pad.touchMove(80, 150); // 满舵向右

  for (let i = 0; i < 120; i++) frame(i);

  log(`  位置 (${mover.x.toFixed(1)}, ${mover.y.toFixed(1)})`);
  const EXPECT_X = 380 - 18; // 右墙内边 380，角色半径 18
  check(
    '撞右墙后停在墙面外',
    Math.abs(mover.x - EXPECT_X) < 2,
    `x=${mover.x.toFixed(1)}，期望 ≈${EXPECT_X}`,
  );
  check('撞墙后速度归零', mover.speed < 1, `speed=${mover.speed.toFixed(2)}`);
  check('朝向保持 0°（向右）', Math.abs(st.facingDeg) < 1, `${st.facingDeg.toFixed(1)}°`);

  // ---------- 5.6 场景 B：斜向撞中间那堵墙，测试滑动 ----------
  section('5.6 场景 B —— 斜向推，测试贴墙滑动');

  /**
   * ⚠️【这个 Demo 自己踩到的坑，值得单独记】
   *
   * 第一版我只写了：
   *     mover.teleport(0, -60);
   *     pad.touchMove(80, 80);
   *
   * 没有重新 touchDown。而 JoystickCore 是 **dynamic 模式**——
   * 上一次 touchDown(0, 150) 时底盘中心被记在 (0, 150)，
   * **onUp 之前它不会变**。
   *
   * 于是 touchMove(80, 80) 被算成"从 (0,150) 移到 (80,80)"，
   * 方向是 **右上**，而不是我以为的"右下"。
   * 角色一路滑到顶部墙根，而日志还写着"沿 y 向下滑动"。
   *
   * 【教训】
   * 传送角色 ≠ 重置输入。摇杆中心是**输入侧的状态**，
   * 角色位置是**表现侧的状态**，两者不同步。
   * 过场动画、传送门、重生后，记得 `stick.onUp()` 再重新按下。
   */
  pad.touchUp();
  mover.teleport(0, 0);
  pad.touchDown(0, 0);       // 重新按下 → 底盘中心回到 (0,0)
  pad.touchMove(60, 60);     // 右下 45°（从中心 (0,0) 出发）

  const beforeX = mover.x;
  const beforeY = mover.y;
  for (let i = 0; i < 90; i++) frame(i);
  const movedX = mover.x - beforeX;
  const movedY = mover.y - beforeY;

  log(`  位置 (${mover.x.toFixed(1)}, ${mover.y.toFixed(1)})`);
  log(`  位移 (${movedX.toFixed(1)}, ${movedY.toFixed(1)})`);
  /**
   * 中间墙跨 x ∈ [45, 75]，y ∈ [-180, 60]。角色从 (0,0) 向右下推：
   *  ① 先撞到墙左侧，停在 x ≈ 27
   *  ② 沿墙滑动，直到脱离墙体（y > 60+18 或 y < -180-18）
   *  ③ 之后自由移动
   */
  check(
    '输入方向正确（右下，不是右上）',
    movedX > 0 && movedY > 0,
    `位移 (${movedX.toFixed(1)}, ${movedY.toFixed(1)})，两者都应为正`,
  );
  check(
    '贴墙滑动（没被完全卡死）',
    Math.abs(movedY) > 100,
    `y 位移 ${movedY.toFixed(1)}（若被卡死会停在原地）`,
  );
  check(
    '滑动后继续前进',
    movedX > 60,
    `x 位移 ${movedX.toFixed(1)}（若被卡死会停在 27）`,
  );

  // ---------- 5.7 场景 C：CD 剩 0.1s 时提前点击 ----------
  section('5.7 场景 C —— CD 剩 0.1s 提前点击（SkillQueue 的核心承诺）');

  // 先放一次进入 CD
  caster.tryCast('slash', { x: mover.x, y: mover.y, facingDeg: 0 });
  log(`  已放 1 次，剩余 CD ${caster.cooldownLeft('slash').toFixed(3)}s`);

  // 快进到只剩 0.1s
  let guard = 0;
  while (caster.cooldownLeft('slash') > 0.1 && guard++ < 600) {
    caster.tick(DT);
  }
  log(`  快进后剩余 CD ${caster.cooldownLeft('slash').toFixed(3)}s`);

  const castsBefore = queue.stats.cast;
  pad.press('attack'); // ← 提前 0.1s 点击
  log(`  玩家点击（此时 CD 还有 ${caster.cooldownLeft('slash').toFixed(3)}s）`);

  // 跑 0.5 秒
  for (let i = 0; i < 30; i++) frame(i);

  const got = queue.stats.cast - castsBefore;
  check('CD 剩 0.1s 提前点击能补发', got === 1, `补发 ${got} 次，期望 1`);
  log(`  队列统计：请求 ${queue.stats.requested} / 释放 ${queue.stats.cast} / 丢弃 ${queue.stats.rejected}`);

  // ---------- 5.8 场景 D：冲刺穿墙测试 ----------
  section('5.8 场景 D —— 朝墙冲刺（测试是否会穿模）');
  mover.teleport(300, 0); // 靠近右墙 x=380
  st.facingDeg = 0; // 朝右

  dash.tryStart(1, 0); // 朝右冲
  log(`  冲刺开始：state=${dash.state} invuln=${dash.invulnerable}`);

  for (let i = 0; i < 30; i++) frame(i);

  check(
    '朝墙冲刺不穿模',
    mover.x <= 380 - RADIUS + 1,
    `x=${mover.x.toFixed(1)}，墙内边 380，角色半径 ${RADIUS}`,
  );

  // ---------- 5.9 场景 E：连点（测试 replaceSame） ----------
  section('5.9 场景 E —— 连点 5 次（capacity=1）');
  caster.resetCooldown('slash');
  const before2 = queue.stats.rejected;
  for (let i = 0; i < 5; i++) {
    pad.press('attack');
    frame(i);
  }
  for (let i = 0; i < 40; i++) frame(i);
  check(
    '连点不堆积（无回放）',
    queue.count <= 1,
    `队列残留 ${queue.count} 个，capacity=1`,
  );
  log(`  丢弃次数 ${queue.stats.rejected - before2}`);

  // ---------- 5.10 汇总 ----------
  section('汇总');
  log(`  自检：${_checks.pass} 项通过，${_checks.fail} 项失败`);
  if (_checks.fail > 0) {
    log('');
    log('  ⚠️ 有自检没过。先怀疑接线顺序和 solver 是否被绕过，');
    log('     再怀疑模块本身 —— 拼装层的 bug 比模块 bug 常见得多。');
  }
  log(`  冲刺次数 ${st.dashCount}`);
  log(`  技能队列统计：${JSON.stringify(queue.stats)}`);
  log(`  最终位置 (${mover.x.toFixed(1)}, ${mover.y.toFixed(1)})`);
  log('');
  log('  这个 Demo 不断言、不参与 CI。它的作用是：');
  log('  把六个模块接起来跑一遍，让"接口对不上"和"时序错了"');
  log('  在打印里直接现形，而不是等你在引擎里调一整天。');
  log('');
  log('  接错时最容易看到的三类症状：');
  log('   · 位置 NaN / 停在原地 → 输入没接上（dir 一直是 0,0）');
  log('   · 穿墙 → 冲刺或移动绕过了 solver');
  log('   · 补发 0 次 → SkillQueue 与 caster 的 tick 顺序反了');
  log('');
  console.log('========== Demo 结束 ==========\n');
}

// 【为什么要 declare 而不装 @types/node】
// 这是示例文件，不应该为了一个 require 就让整个库依赖 node 类型。
declare const require: { main?: unknown };
declare const module: unknown;

if (require.main === module) {
  main();
}

export { main };
