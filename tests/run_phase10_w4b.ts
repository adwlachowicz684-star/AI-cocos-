/**
 * tests/run_phase10_w4b.ts —— 精审返工 · 窗口 W4-B（第 B 组）修复回归
 *
 * 【本批 7 个单元】dialogue / fov / joystick-mover / mover / rebind / reddot / shop
 * 【条目】15 条（P1 12 条 + P2 3 组）
 *
 * 【每条修复两条用例的约定】
 * - `⚠️` 开头的是**回归用例**：修复前确实会失败（失败原因写在注释里）
 * - `✓` 开头的是**对照用例**：证明正常输入没被矫枉过正
 *
 * 【复现环境】所有"修复前"输出都是在本机 `node /tmp/repro.js`
 * 跑真实编译产物（`.build/`）得到的，不是照抄报告。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { DialogueGraph } from '../dialogue/DialogueGraph';
import { Shadowcasting, Raycasting } from '../fov/FOV';
import { JoystickCore } from '../joystick-mover/JoystickCore';
import { CharacterMover, stoppingTime } from '../mover/CharacterMover';
import { Rebind, prettyKey, formatBinding, decodeBinding } from '../rebind/Rebind';
import { RedDot } from '../reddot/RedDot';
import { Shop } from '../shop/Shop';

export function runPhase10W4BTests(): void {
  // ================================================================
  describe('W4-B · [dialogue] 所有选项条件都不满足时的死锁', () => {
    /** 两个选项的 condition 都是 false —— 条件对话的标配场景 */
    function deadlocked() {
      const g = new DialogueGraph();
      g.node('n1', {
        text: '你想做什么？',
        choices: [
          { text: '需要钥匙', next: 'a', condition: () => false },
          { text: '需要好感度 80', next: 'b', condition: () => false },
        ],
      });
      g.node('a', { text: 'A', next: null });
      g.node('b', { text: 'B', next: null });
      return g.start('n1', {});
    }

    test('⚠️ 全禁用时 hasEnabledChoice() 能报出死局（修复前：方法不存在）', () => {
      const r = deadlocked();
      // 修复前：hasEnabledChoice 未定义 → 调用即 TypeError
      eq(r.hasEnabledChoice(), false, '两个选项都不可选，应报 false');
      // 死锁三件套：advance 失败、choose 失败、isDone 仍为 false
      eq(r.choose(0), false);
      eq(r.choose(1), false);
      eq(r.advance(), false);
      eq(r.isDone, false);
    });

    test('⚠️ 自动推进把"无可用选项"当终态（修复前：返回 true 且卡死）', () => {
      const r = deadlocked();
      // 修复前：advanceToChoice() 返回 true（"到选项节点了"），isDone 仍是 false
      // → 调用方在此等待输入，而 choose 永远失败 = 死锁
      eq(r.advanceToChoice(), false, '无路可走应是终态');
      eq(r.isDone, true, '必须能正常收尾');
      eq(r.current, null);
    });

    test('✓ 有可用选项时行为完全不变（防止矫枉过正）', () => {
      const g = new DialogueGraph();
      g.node('n1', {
        text: '选一个',
        choices: [
          { text: '要', next: 'a', condition: () => true },
          { text: '不要', next: 'b', condition: () => false },
        ],
      });
      g.node('a', { text: 'A', next: null });
      g.node('b', { text: 'B', next: null });

      const r = g.start('n1', {});
      // 【对照用例只用既有 API】这样它在修复前后都会通过，
      // 才真能证明"正常路径没被改坏"
      eq(r.advanceToChoice(), true, '有得选就该停下来等输入');
      eq(r.currentNodeId, 'n1');
      eq(r.isDone, false);
      eq(r.choose(0), true);
      eq(r.currentNodeId, 'a');
    });

    test('✓ 无选项节点不影响 advance 推进（防止矫枉过正）', () => {
      const g = new DialogueGraph();
      g.node('a', { text: '第一句', next: 'b' });
      g.node('b', { text: '第二句', next: null });
      const r = g.start('a', {});
      eq(r.advanceToChoice(), false, '一路播到底，没有选项可停');
      eq(r.isDone, true);

      // 逐步 advance 的路径同样不受影响
      const r2 = g.start('a', {});
      eq(r2.advance(), true);
      eq(r2.currentNodeId, 'b');
      eq(r2.advance(), true);
      eq(r2.isDone, true);
    });
  });

  // ================================================================
  describe('W4-B · [fov] isSymmetric 把 B 的视野永久写进 explored', () => {
    /** 30×30 全空地图 */
    function empty() {
      return new Shadowcasting(30, 30, () => false);
    }

    test('⚠️ 对称性检查后 explored 不增长（修复前：113 → 148）', () => {
      const f = empty();
      f.compute(10, 10, 6);
      const before = f.explored.count;
      assert(before === 113, `基线 explored 应为 113，实际 ${before}`);
      f.isSymmetric(10, 10, 13, 10, 6);
      eq(f.explored.count, before, '纯查询不该点亮任何新格子');
    });

    test('⚠️ 对称性检查后 visible 仍是调用方的 A 视野（修复前：停在 B 上）', () => {
      const f = empty();
      f.compute(10, 10, 6);
      // (10,10) 在 A 的视野里，(20,10) 只在 B 附近、不在 A 的视野里
      eq(f.visible.has(10, 10), true);
      const aOnly = f.visible.has(20, 10);
      f.isSymmetric(10, 10, 13, 10, 6);
      eq(f.visible.has(10, 10), true, 'A 的视野必须被还原');
      eq(f.visible.has(20, 10), aOnly, '不该混入 B 的视野');
    });

    test('✓ 对称性判定的结果本身不变（防止矫枉过正）', () => {
      const f = empty();
      // 空地图上互相可见 → 对称
      eq(f.isSymmetric(10, 10, 13, 10, 6), true);

      // 造一堵墙挡住，破坏对称性
      const g = new Shadowcasting(30, 30, (x) => x === 18);
      const sym = g.isSymmetric(10, 10, 25, 10, 12);
      assert(typeof sym === 'boolean', '应返回布尔值');
      // 有墙时两处视野都受限，仍应给出确定答案
      const g2 = new Shadowcasting(30, 30, (x) => x === 18);
      eq(g2.isSymmetric(10, 10, 13, 10, 6), true, '近距离无遮挡仍对称');
    });

    test('✓ 正常 compute 仍会累积 explored（防止矫枉过正）', () => {
      const f = empty();
      f.compute(5, 5, 4);
      const first = f.explored.count;
      f.compute(20, 20, 4);
      assert(
        f.explored.count > first,
        `换位置后 explored 应继续增长：${first} → ${f.explored.count}`
      );
      f.resetExplored();
      eq(f.explored.count, 0, 'resetExplored 仍可全清');
    });
  });

  // ================================================================
  describe('W4-B · [fov] Raycasting 的 _castRay 在 NaN 坐标下永不退出', () => {
    test('⚠️ NaN 起点不卡死（移除守卫后实测：5 秒超时退出码 124）', () => {
      const rc = new Raycasting(20, 20, () => false);
      const t0 = Date.now();
      const n = rc.compute(NaN, NaN, 4);
      const ms = Date.now() - t0;
      assert(ms < 500, `compute 必须在 500ms 内返回，实际 ${ms}ms`);
      eq(n, 0, 'NaN 起点应直接返回 0 格');
    });

    test('⚠️ 半径 NaN 由 needFinite 直接拒绝（不进入循环）', () => {
      const rc = new Raycasting(20, 20, () => false);
      // 半径非有限值时应当场抛错，而不是算出一个"空视野"继续跑
      throws(() => rc.compute(5, 5, NaN), 'radius 必须是有限数值');
      throws(() => rc.compute(5, 5, Infinity), 'radius 必须是有限数值');
    });

    test('⚠️ 非有限坐标进 _castRay 也不卡死（Infinity 路径）', () => {
      const rc = new Raycasting(20, 20, () => false);
      const t0 = Date.now();
      const n = rc.compute(Infinity, 5, 4);
      assert(Date.now() - t0 < 500);
      eq(n, 0);
    });

    test('✓ 合法坐标的视野结果不变（防止矫枉过正）', () => {
      const rc = new Raycasting(11, 11, () => false);
      const n = rc.compute(5, 5, 4);
      assert(n === 17, `半径 4 的空房间应看到 17 格，实际 ${n}`);
      eq(rc.canSee(5, 5), true, '原点自己可见');
    });

    test('✓ 有墙时墙可见、墙后不可见（防止矫枉过正）', () => {
      const isWall = (_x: number, y: number) => y === 6;
      const rc = new Raycasting(11, 11, isWall);
      rc.compute(5, 5, 6);
      eq(rc.canSee(5, 6), true, '墙本身可见');
      eq(rc.canSee(5, 7), false, '墙后不可见');
    });
  });

  // ================================================================
  describe('W4-B · [fov] P2 · Raycasting 构造尺寸校验与周长分配', () => {
    test('⚠️ 尺寸为 0 抛错（修复前：静默成功，视野恒为 0）', () => {
      throws(() => new Raycasting(0, 10, () => false), '尺寸必须为正');
    });

    test('⚠️ 负尺寸抛错且信息带单元名（修复前：Uint8Array 抛 Invalid typed array length）', () => {
      throws(() => new Raycasting(-5, 10, () => false), '[Raycasting]');
      throws(() => new Raycasting(10, 0, () => false), '[Raycasting]');
    });

    test('✓ 合法尺寸正常构造（防止矫枉过正）', () => {
      const rc = new Raycasting(11, 11, () => false);
      eq(rc.compute(5, 5, 5) > 0, true);
    });

    /**
     * 【⚠️ 这一条被验收方 W4-A 判为"恒通过"，已重写】
     *
     * 原写法是拿**两个新实现的实例**互相逐格对拍：
     *
     * ```typescript
     * const rc  = new Raycasting(11, 11, isWall);  rc.compute(5, 5, 6);
     * const ref = new Raycasting(11, 11, isWall);  ref.compute(5, 5, 6);
     * eq(rc.canSee(x, y), ref.canSee(x, y));       // ← 两边都是新代码
     * ```
     *
     * 两个实例跑的是同一份实现，这个对拍**永远一致**，
     * 测不出"重构是否改变了遍历顺序"——名字写着"防止矫枉过正"，实际什么也没防。
     *
     * 现在改成与**写死的期望格表**比对。表是重构后跑出来的，
     * 并且已经和重构前的实现（父提交 `7c425d8` 的 `FOV.ts`）逐格对拍确认一致：
     * 两个场景 × 全格比对，**差异 0 处**。所以这张表同时代表重构前后的行为。
     *
     * 表里 `#` = 可见、`.` = 不可见。y=5 整行可见是光源所在行；
     * y=6 的墙（x<6）挡住了下方，于是 y≥7 全部落在阴影里——
     * **阴影的形状对遍历顺序很敏感**，所以这张表能真正守住"重构没改变结果"。
     */
    test('⚠️ 去掉 perimeter 中间数组后，逐格结果与写死的期望表一致（防矫枉过正）', () => {
      const isWall = (x: number, y: number) => y === 6 && x < 6;
      const expected = [
        '.....#.....', // y=0
        '.....#.....', // y=1
        '.....#.....', // y=2
        '.....#.....', // y=3
        '.....#.....', // y=4
        '###########', // y=5  光源所在行（5,5），整行可见
        '.....#.....', // y=6  墙行：x<6 是墙，只有墙格被点亮
        '...........', // y=7  墙的阴影
        '...........', // y=8
        '...........', // y=9
        '...........', // y=10
      ];

      const rc = new Raycasting(11, 11, isWall);
      rc.compute(5, 5, 6);

      for (let y = 0; y < expected.length; y++) {
        let row = '';
        for (let x = 0; x < expected[y].length; x++) {
          row += rc.canSee(x, y) ? '#' : '.';
        }
        eq(row, expected[y], `第 ${y} 行的可见性应与期望表逐格一致：`);
      }

      // 顺带把"整张表的形状"也锁住：任何遍历顺序/裁剪条件的变化都会改它
      eq(rc.canSee(5, 8), false, '墙后的格子必须落在阴影里');
      eq(rc.canSee(5, 5), true, '光源自身必须可见');
    });
  });

  // ================================================================
  describe('W4-B · [joystick-mover] evaluate 返回复用对象被下一帧改写', () => {
    function pushed() {
      const j = new JoystickCore({ mode: 'fixed', radius: 100 });
      j.onDown(0, 0, 0);
      j.onMove(0, 40, 0);
      return j;
    }

    test('⚠️ snapshot() 存下来不被后续帧改写（修复前：方法不存在）', () => {
      const j = pushed();
      const a = j.snapshot();          // magnitude 0.5
      near(a.magnitude, 0.4, 1e-6, '40/100');
      j.onMove(0, 100, 0);             // 推满
      const b = j.snapshot();
      near(b.magnitude, 1, 1e-6);
      near(a.magnitude, 0.4, 1e-6, '快照必须停在前一帧的值上');
      assert(a !== b, '每次 snapshot 都应是新对象');
    });

    test('⚠️ evaluateInto() 把结果写进调用方自己的结构（修复前：方法不存在）', () => {
      const j = pushed();
      const mine = { dir: { x: 0, y: 0 }, magnitude: 0, angle: 0, active: false };
      j.evaluateInto(mine);
      near(mine.magnitude, 0.4, 1e-6);
      j.onMove(0, 100, 0);
      j.evaluateInto(mine);
      near(mine.magnitude, 1, 1e-6, '就地覆盖');
    });

    test('✓ evaluate 仍是零分配、数值正确（防止矫枉过正）', () => {
      const j = pushed();
      const a = j.evaluate();
      const b = j.evaluate();
      assert(a === b, 'evaluate 保持复用语义（热路径零分配）');
      near(a.magnitude, 0.4, 1e-6);
      near(a.dir.x, 1, 1e-6);
      near(a.dir.y, 0, 1e-6);
      eq(a.active, true);
    });

    test('✓ 死区内输出归零且快照同样归零（防止矫枉过正）', () => {
      const j = new JoystickCore({ mode: 'fixed', radius: 100, deadZone: 0.15 });
      j.onDown(0, 0, 0);
      j.onMove(0, 5, 0);   // 5/100 = 0.05 < 死区
      // 对照用例只用既有 API：修复前后都应通过
      const o = j.evaluate();
      eq(o.magnitude, 0);
      eq(o.active, false);
      near(o.dir.x, 0, 1e-9);
    });
  });

  // ================================================================
  describe('W4-B · [mover] addImpulse 默认 maxExternal = Infinity', () => {
    test('⚠️ 默认上限生效：4 次冲量被限制在 maxSpeed×5（修复前：40）', () => {
      const m = new CharacterMover({ maxSpeed: 6 });   // 默认上限 = 30
      for (let i = 0; i < 4; i++) m.addImpulse(10, 0);
      near(m.externalSpeed, 30, 1e-6, '应被限幅到 30，而不是累加到 40');
    });

    test('⚠️ 更大倍数的连击也不会叠成火箭（修复前：10 次 = 100）', () => {
      const m = new CharacterMover({ maxSpeed: 6 });
      for (let i = 0; i < 10; i++) m.addImpulse(10, 0);
      near(m.externalSpeed, 30, 1e-6);
    });

    test('⚠️ 配表里传 NaN 上限也回落到默认值（修复前：NaN 让判定恒 false）', () => {
      const m = new CharacterMover({ maxSpeed: 6 });
      for (let i = 0; i < 10; i++) m.addImpulse(10, 0, NaN);
      near(m.externalSpeed, 30, 1e-6, 'NaN 上限必须回落到默认，而不是"不设限"');
    });

    test('✓ 显式传 Infinity 仍可要求不设限（防止矫枉过正）', () => {
      const m = new CharacterMover({ maxSpeed: 6 });
      for (let i = 0; i < 4; i++) m.addImpulse(10, 0, Infinity);
      near(m.externalSpeed, 40, 1e-6, '显式要求不限幅时应保留原行为');
    });

    test('✓ 单次冲量与显式上限不受影响（防止矫枉过正）', () => {
      const m = new CharacterMover({ maxSpeed: 10 });
      m.addImpulse(10, 0);
      near(m.externalSpeed, 10, 1e-6, '低于上限时不裁剪');
      const m2 = new CharacterMover({ maxSpeed: 10 });
      for (let i = 0; i < 20; i++) m2.addImpulse(30, 0, 40);
      assert(m2.externalSpeed <= 40.001, `显式上限 40 应生效，实际 ${m2.externalSpeed}`);
    });
  });

  // ================================================================
  describe('W4-B · [mover] moveBy 缺少 safeDt 守卫', () => {
    test('⚠️ moveBy(NaN dt) 不污染坐标（修复前：位置变 NaN）', () => {
      const m = new CharacterMover();
      m.moveBy(5, 0, NaN);
      eq(Number.isFinite(m.x), true, 'X 必须仍是有限数');
      eq(Number.isFinite(m.y), true);
      eq(m.x, 0);
      eq(m.y, 0);
    });

    test('⚠️ moveBy(负 dt) 不让角色倒着走（修复前：位置 -5）', () => {
      const m = new CharacterMover();
      m.moveBy(5, 0, -1);
      eq(m.x, 0, '负 dt 应被拒绝');
      const m2 = new CharacterMover();
      m2.moveBy(5, 0, 0);
      eq(m2.x, 0, 'dt=0 同样被拒绝');
    });

    test('⚠️ moveBy(Infinity dt) 不爆掉坐标', () => {
      const m = new CharacterMover();
      m.moveBy(5, 0, Infinity);
      eq(Number.isFinite(m.x), true);
      eq(m.x, 0);
    });

    test('✓ 冲刺超速仍不被 maxSpeed 限制（防止矫枉过正）', () => {
      const m = new CharacterMover({ maxSpeed: 5 });
      m.moveBy(100, 0, 1 / 60);
      near(m.x, 100 / 60, 1e-6, '冲刺必须能超过 maxSpeed');
      near(m.vx, 100, 1e-6);
    });
  });

  // ================================================================
  describe('W4-B · [mover] externalDamping / turnBoost 未收口', () => {
    test('⚠️ externalDamping = NaN 不再让外力与坐标变 NaN（修复前：NaN）', () => {
      const m = new CharacterMover({ externalDamping: NaN });
      m.addImpulse(10, 0);
      m.update(0.016, 0, 0);
      assert(Number.isFinite(m.externalSpeed), `外力应有限，实际 ${m.externalSpeed}`);
      assert(Number.isFinite(m.x), `坐标应有限，实际 ${m.x}`);
    });

    test('⚠️ turnBoost = NaN 不再让速度变 NaN（修复前：vx = NaN）', () => {
      const m = new CharacterMover({ turnBoost: NaN, maxSpeed: 6 });
      for (let i = 0; i < 5; i++) m.update(0.1, 1, 0);
      m.update(0.1, -1, 0);   // 掉头：走 turnBoost 分支
      assert(Number.isFinite(m.vx), `vx 应有限，实际 ${m.vx}`);
      assert(Number.isFinite(m.vy), `vy 应有限，实际 ${m.vy}`);
      assert(m.vx < 0, `掉头后应朝反方向，实际 ${m.vx}`);
    });

    test('✓ 默认配置下掉头行为完全不变（防止矫枉过正）', () => {
      const m = new CharacterMover({ maxSpeed: 6 });
      for (let i = 0; i < 5; i++) m.update(0.1, 1, 0);
      m.update(0.1, -1, 0);
      near(m.vx, -6, 1e-4, '默认 turnBoost 下应精确掉头到 -maxSpeed');
      near(m.vy, 0, 1e-9);
    });

    test('✓ 显式合法配置不被改写（防止矫枉过正）', () => {
      const m = new CharacterMover({ turnBoost: 5, externalDamping: 2, friction: 1.5 });
      for (let i = 0; i < 50; i++) m.update(0.016, 1, 0);
      near(m.vx, 6, 0.05, '仍能加速到 maxSpeed');
    });
  });

  // ================================================================
  describe('W4-B · [mover] P2 · knocked 判据与阈值语义', () => {
    test('⚠️ 多个小击退合成后应判定为击退（修复前：knocked = false）', () => {
      const m = new CharacterMover({ maxSpeed: 6 });   // 阈值 = 3
      m.addImpulse(2.5, 0);
      m.addImpulse(2.5, 0);
      m.addImpulse(2.5, 0);
      near(m.externalSpeed, 7.5, 1e-6, '合成外力明显在推开角色');
      eq(m.knocked, true, '合成后超过阈值就该进入击退态');
    });

    test('✓ 单个小外力不误判为击退（防止矫枉过正：传送带）', () => {
      const m = new CharacterMover({ maxSpeed: 6 });
      m.addImpulse(1, 0);
      eq(m.knocked, false, '持续小外力不该让角色永远处于击退态');
    });

    /**
     * 【⚠️ 这一组是验收方 W4-A 标红后补的】
     *
     * 第一版修法把判据改成"跨帧合成后的总外力"，修好了漏判，
     * 却踩中了源码注释**明确警告要防**的传送带场景：
     *
     * ```
     * 每帧 addImpulse(0.5) × 600 帧 → 稳态外力 3.51 > 阈值 3 → knocked 590/600 帧
     * 每帧 addImpulse(1.0)          → 稳态  7.01            → knocked 597/600 帧
     * 每帧 addImpulse(2.0)          → 稳态 14.02            → knocked 599/600 帧
     * ```
     *
     * 而 `update` 里 `control = knocked ? knockbackControl : 1`、默认 0.3，
     * 于是"玩家一踏上传送带，操作权从 100% 掉到 30%，且一直不恢复"。
     *
     * 上面那条 `addImpulse(1, 0)` 只测了**单次**，抓不到这个
     * ——单次的合成外力才 1，两种实现都判 false。
     * 真正会翻脸的是"**持续多帧累加**"，必须单独有一条守着。
     */
    test('⚠️ 持续多帧小外力不得进入击退态（传送带：修复前 590/600 帧误判）', () => {
      // 阈值 = maxSpeed × 0.5 = 3
      for (const per of [0.5, 1.0, 2.0]) {
        const m = new CharacterMover({ maxSpeed: 6 });
        let knockedFrames = 0;
        for (let i = 0; i < 600; i++) {
          m.addImpulse(per, 0);
          m.update(1 / 60, 0, 0);
          if (m.knocked) knockedFrames++;
        }
        // 外力稳态确实超过阈值（3.51 / 7.01 / 14.02），说明"看总外力"会误判
        assert(
          m.externalSpeed > 3,
          `每帧 ${per}：稳态外力应超过阈值 3（否则这条用例测不到东西），实际 ${m.externalSpeed.toFixed(2)}`
        );
        eq(
          knockedFrames,
          0,
          `每帧 ${per}：传送带形态不该判击退，实际 knocked ${knockedFrames}/600 帧：`
        );
      }
    });

    test('⚠️ 同样的多段推力，分帧施加不算击退、同帧施加才算（固化"同帧"语义）', () => {
      // 分 3 帧各推 2.5 —— 传送带/风力形态
      const spread = new CharacterMover({ maxSpeed: 6 });
      for (let i = 0; i < 3; i++) {
        spread.addImpulse(2.5, 0);
        spread.update(1 / 60, 0, 0);
      }
      eq(spread.knocked, false, '跨帧的持续推力不该合成：');

      // 同一帧内推 3 次 —— 连击/多重爆炸形态
      const burst = new CharacterMover({ maxSpeed: 6 });
      burst.addImpulse(2.5, 0);
      burst.addImpulse(2.5, 0);
      burst.addImpulse(2.5, 0);
      eq(burst.knocked, true, '同帧的多段击退必须合成：');
    });

    test('⚠️ 显式 knockbackThreshold = 0 不被改写成 25%（修复前：被静默改写）', () => {
      // 显式 0 = 只有外力衰减到 stopEpsilon 才解除击退
      const m = new CharacterMover({ maxSpeed: 6, knockbackThreshold: 0, externalDamping: 8 });
      m.addImpulse(6, 0);
      let i = 0;
      while (m.externalSpeed > 1.0 && i < 5000) { m.update(1 / 60, 0, 0); i++; }
      // 外力剩 1.0（< 25% 阈值 1.5）但 > stopEpsilon
      eq(m.knocked, true, '显式 0 表示不提前解除');

      const d = new CharacterMover({ maxSpeed: 6, externalDamping: 8 });   // 未指定
      d.addImpulse(6, 0);
      let j = 0;
      while (d.externalSpeed > 1.0 && j < 5000) { d.update(1 / 60, 0, 0); j++; }
      eq(d.knocked, false, '未指定时按 25% 提前解除');
    });

    test('✓ 未指定阈值时仍是 maxSpeed×25%（防止矫枉过正）', () => {
      const m = new CharacterMover({ maxSpeed: 10, externalDamping: 6 });
      m.addImpulse(30, 0);
      let frames = 0;
      while (m.knocked && frames < 600) { m.update(1 / 60, 0, 0); frames++; }
      assert(frames / 60 < 0.5, `击退态应在 0.5s 内解除，实际 ${(frames / 60).toFixed(2)}s`);
      assert(m.externalSpeed > 1, `解除时外力应仍可感知，实际 ${m.externalSpeed}`);
    });

    test('⚠️ stoppingTime 不再被 1e6 截断（修复前：1e9 秒被报成 1e6）', () => {
      eq(stoppingTime(1e9, 1), 1e9);
    });

    test('✓ stoppingTime 常规值与非法输入（防止矫枉过正）', () => {
      near(stoppingTime(10, 5), 2, 1e-9);
      eq(stoppingTime(10, 0), Infinity, 'decel=0 表示永远停不下来');
      eq(stoppingTime(10, -1), Infinity);
      eq(Number.isNaN(stoppingTime(NaN, 1)), true, '坏输入保持 NaN 可见');
    });

    test('⚠️ destroy 清空状态（修复前：方法不存在）', () => {
      const m = new CharacterMover({ maxSpeed: 6 });
      m.addImpulse(20, 0);
      for (let i = 0; i < 10; i++) m.update(1 / 60, 1, 0);
      m.destroy();
      eq(m.x, 0);
      eq(m.y, 0);
      eq(m.vx, 0);
      eq(m.vy, 0);
      eq(m.externalSpeed, 0);
      eq(m.knocked, false);
      m.update(1 / 60, 1, 0);   // 销毁后仍可安全调用
      assert(Number.isFinite(m.x));
    });
  });

  // ================================================================
  describe('W4-B · [rebind] importState 坏数据中断整批导入', () => {
    test('⚠️ 一条脏数据不影响后面的合法条目（修复前：抛错且 attack 没导入）', () => {
      const rb = new Rebind({ jump: { key: 'space' } });
      rb.importState({ jump: '+', attack: 'k' });
      eq(rb.has('attack'), true, '合法条目必须照常导入');
      eq(rb.bindingOf('jump')!.key, 'space', '脏数据跳过，保持原绑定');
    });

    test('⚠️ 整批导入不再抛出（修复前：TypeError reading trim）', () => {
      const rb = new Rebind();
      rb.importState({ a: '+', b: '++', c: 'ctrl+', d: '' });
      eq(rb.actions.length, 0, '全部是脏数据 → 全部跳过，不抛错');
    });

    test('⚠️ decodeBinding 解析不出主键时抛错（修复前：返回 {key: undefined}）', () => {
      throws(() => decodeBinding('+'), '解析不出主键');
    });

    test('✓ 合法导入与保留键过滤不变（防止矫枉过正）', () => {
      const rb = new Rebind({ jump: { key: 'space' } });
      rb.importState({ jump: 'w', save: 'ctrl+s' });
      eq(rb.bindingOf('jump')!.key, 'w');
      eq((rb.bindingOf('save')!.mods ?? []).join(','), 'ctrl');

      const rb2 = new Rebind();
      rb2.importState({ menu: 'escape' });
      eq(rb2.has('menu'), false, '保留键仍被跳过');
    });
  });

  // ================================================================
  describe('W4-B · [rebind] 重复 code 导入导致静默解绑', () => {
    test('⚠️ 重复时保留前者、跳过后进（修复前：a 被彻底解绑）', () => {
      const rb = new Rebind();
      rb.importState({ a: 'k', b: 'k' });
      eq(rb.bindingOf('a')!.key, 'k', '先来的保留');
      eq(rb.has('b'), false, '后来的冲突项跳过，不抢别人的键');
    });

    test('⚠️ 导入会触发 onChange（修复前：界面仍显示旧键位）', () => {
      const seen: string[] = [];
      const rb = new Rebind({}, { onChange: (a) => seen.push(a) });
      rb.importState({ a: 'k', b: 'j' });
      eq(seen.sort().join(','), 'a,b', '每条生效的导入都要通知 UI');
    });

    test('✓ 不重复时全部导入且索引一致（防止矫枉过正）', () => {
      const rb = new Rebind();
      rb.importState({ a: 'k', b: 'j' });
      eq(rb.actionOf({ key: 'k' }), 'a');
      eq(rb.actionOf({ key: 'j' }), 'b');
    });

    test('✓ 重复导入自身同一键不报错（防止矫枉过正）', () => {
      const rb = new Rebind();
      rb.importState({ a: 'k' });
      rb.importState({ a: 'k' });   // 同一动作同一键，owner 就是自己
      eq(rb.bindingOf('a')!.key, 'k');
    });
  });

  // ================================================================
  describe('W4-B · [rebind] prettyKey 原型链污染', () => {
    test('⚠️ prettyKey 不返回原型上的函数（修复前：typeof function）', () => {
      eq(typeof prettyKey('constructor'), 'string');
      eq(prettyKey('constructor'), 'Constructor', '回落到首字母大写');
      eq(typeof prettyKey('toString'), 'string');
      eq(typeof prettyKey('valueOf'), 'string');
      eq(typeof prettyKey('__proto__'), 'string');
    });

    test('⚠️ formatBinding 也不含原型方法（修复前：拼出函数源码）', () => {
      const s = formatBinding({ key: 'a', mods: [] });
      eq(s.includes('function'), false, `展示串不该含函数源码：${s}`);
    });

    test('✓ 正常键名展示不变（防止矫枉过正）', () => {
      eq(prettyKey('escape'), 'Esc');
      eq(prettyKey('arrowup'), '↑');
      eq(prettyKey('space'), 'Space');
      eq(prettyKey('shiftleft'), 'L-Shift');
      eq(prettyKey('controlright'), 'R-Ctrl');
      eq(prettyKey('k'), 'K');
      eq(formatBinding({ key: 's', mods: ['ctrl', 'shift'] }), 'Ctrl+Shift+S');
    });
  });

  // ================================================================
  describe('W4-B · [rebind] P2 · 恢复默认静默丢弃 / destroy / 重复编码', () => {
    test('⚠️ 无默认值的动作被清掉时也会通知（修复前：静默）', () => {
      const seen: string[] = [];
      const rb = new Rebind({ jump: { key: 'space' } }, { onChange: (a) => seen.push(a) });
      rb.bind('custom', { key: 'k' });
      seen.length = 0;
      rb.resetToDefault();
      eq(rb.has('custom'), false, '没有默认值的动作仍是解绑语义');
      assert(seen.includes('custom'), `必须通知被清掉的动作，实际 ${JSON.stringify(seen)}`);
      eq(rb.bindingOf('jump')!.key, 'space');
    });

    test('✓ 有默认值的动作正常恢复（防止矫枉过正）', () => {
      const rb = new Rebind({ jump: { key: 'space' }, attack: { key: 'j' } });
      rb.bind('jump', { key: 'w' });
      rb.bind('attack', { key: 'e' });
      rb.resetToDefault();
      eq(rb.bindingOf('jump')!.key, 'space');
      eq(rb.bindingOf('attack')!.key, 'j');
    });

    test('⚠️ destroy 清空全部绑定（修复前：方法不存在，rule5）', () => {
      const rb = new Rebind({ jump: { key: 'space' } });
      rb.bind('attack', { key: 'j' });
      rb.destroy();
      eq(rb.actions.length, 0);
      eq(rb.bindingOf('jump'), undefined);
      eq(rb.actionOf({ key: 'space' }), null, '反向索引也要清干净');
      rb.bind('jump', { key: 'w' });   // 销毁后仍可继续使用
      eq(rb.bindingOf('jump')!.key, 'w');
    });

    test('✓ _removeRaw 去重 encodeBinding 后反向索引仍正确（防止矫枉过正）', () => {
      const rb = new Rebind({ attack: { key: 'j' } });
      rb.unbind('attack');
      eq(rb.bind('jump', { key: 'j' }), true, '旧索引必须已清理，否则会误判冲突');
      eq(rb.actionOf({ key: 'j' }), 'jump');
    });
  });

  // ================================================================
  describe('W4-B · [reddot] activePaths 是 O(n²)', () => {
    test('⚠️ 4000 个叶子时全量刷新不超时（修复前：147ms）', () => {
      const rd = new RedDot();
      for (let i = 0; i < 4000; i++) rd.set(`mail/item${i}`, 1);
      const t0 = Date.now();
      const paths = rd.activePaths();
      const ms = Date.now() - t0;
      assert(ms < 50, `单次全量刷新应 < 50ms，实际 ${ms}ms`);
      eq(paths.length, 4000);
    });

    test('⚠️ 耗时随规模线性增长而非平方增长（修复前：翻倍≈3~5 倍）', () => {
      function bench(n: number): number {
        const rd = new RedDot();
        for (let i = 0; i < n; i++) rd.set(`mail/item${i}`, 1);
        const t0 = Date.now();
        rd.activePaths();
        return Date.now() - t0;
      }
      bench(1000);   // 预热
      const small = bench(1000);
      const large = bench(4000);
      // 平方复杂度会是 ~16 倍；线性是 ~4 倍。留足余量按 10 倍卡
      assert(
        large < Math.max(20, small * 10),
        `n 翻两倍的耗时应远小于平方增长：${small}ms → ${large}ms`
      );
    });

    test('✓ 结果与 get() 完全一致（防止矫枉过正）', () => {
      const rd = new RedDot();
      rd.set('mail/system', 3);
      rd.set('mail/team', 0);
      rd.set('bag', 1);
      const paths = rd.activePaths().sort();
      eq(paths.join(','), 'bag,mail/system', '只返回大于 0 的叶子');

      // 覆盖值口径：override 优先于聚合值
      rd.override('mail', 0);
      eq(rd.activePaths().includes('mail/system'), true, '叶子自身仍按自身值判断');
      eq(rd.get('mail'), 0, '父节点按覆盖值');
    });

    test('✓ 自定义分隔符下也正确（防止矫枉过正）', () => {
      const rd = new RedDot({ separator: '.' });
      rd.set('mail.system', 2);
      rd.set('shop', 1);
      eq(rd.activePaths().sort().join(','), 'mail.system,shop');
      eq(rd.get(''), 3, '根节点仍聚合全部');
      eq(rd.get('mail'), 2);
    });
  });

  // ================================================================
  describe('W4-B · [shop] _log 无容量上限', () => {
    function shop(): Shop {
      const s = new Shop();
      s.defineItem({ id: 'potion', name: '药水', basePrice: 1 });
      s.stock('potion', -1);   // 无限库存
      return s;
    }

    test('⚠️ 流水不再无限增长（修复前：5000 次后 length = 5000）', () => {
      const s = shop();
      const wallet = { gold: 1e9 };
      for (let i = 0; i < 5000; i++) s.buy('potion', 1, wallet);
      eq(s.log.length, 200, '默认上限 200，与 currency 对齐');
    });

    test('⚠️ 保留的是最近的流水（丢最老的）', () => {
      const s = shop();
      const wallet = { gold: 1e9 };
      for (let i = 0; i < 500; i++) s.buy('potion', 1, wallet);
      eq(s.log.length, 200);
      const last = s.log[s.log.length - 1];
      eq(last.qty, 1);
      eq(last.currency, 'gold');
    });

    test('✓ 小额流水不被误裁（防止矫枉过正）', () => {
      const s = shop();
      const wallet = { gold: 1e9 };
      for (let i = 0; i < 10; i++) s.buy('potion', 1, wallet);
      eq(s.log.length, 10);
      eq(s.netSpent('gold'), 10);
      eq(s.countLog('gold'), 10);
    });

    test('⚠️ NaN 上限回落到默认（修复前语义：NaN 让裁剪判定恒 false）', () => {
      const s = new Shop({ logLimit: NaN });
      s.defineItem({ id: 'potion', name: '药水', basePrice: 1 });
      s.stock('potion', -1);
      const wallet = { gold: 1e9 };
      for (let i = 0; i < 500; i++) s.buy('potion', 1, wallet);
      eq(s.log.length, 200, 'NaN 应回落到 200，而不是变成"无上限"');
    });

    test('⚠️ 上限可配置（修复前：构造器不接收任何选项）', () => {
      const s = new Shop({ logLimit: 5 });
      s.defineItem({ id: 'potion', name: '药水', basePrice: 1 });
      s.stock('potion', -1);
      const wallet = { gold: 1e9 };
      for (let i = 0; i < 50; i++) s.buy('potion', 1, wallet);
      eq(s.log.length, 5);
      s.clearLog();
      eq(s.log.length, 0);
    });

    test('⚠️ 卖出侧同样受上限约束（不能只裁 buy）', () => {
      const s = new Shop({ logLimit: 20 });
      s.defineItem({ id: 'potion', name: '药水', basePrice: 10 });
      s.stock('potion', -1);
      const wallet = { gold: 1e9 };
      for (let i = 0; i < 100; i++) s.sell('potion', 1, wallet);
      eq(s.log.length, 20);
    });
  });

  // ================================================================
  describe('W4-B · [shop] P2 · restock 区间未校验 min > max', () => {
    function shop(): Shop {
      const s = new Shop();
      s.defineItem({ id: 'a', name: 'A', basePrice: 10 });
      s.defineItem({ id: 'b', name: 'B', basePrice: 10 });
      return s;
    }
    const rng = { next: () => 0.9 };

    test('⚠️ 反序区间不再产出负数库存（修复前：[5,1] → 2；负数=无限）', () => {
      const s = shop();
      s.restock(rng, 1, ['a'], { stockRange: [5, 1] });
      assert(s.stockOf('a') >= 0, `库存不能为负，实际 ${s.stockOf('a')}`);
      eq(s.stockOf('a'), 5, '上下界写反时应交换后使用');
    });

    test('⚠️ 下界为负时也不会变成"无限库存"（修复前：[0,-5] → -4）', () => {
      const s = shop();
      s.restock(rng, 1, ['b'], { stockRange: [0, -5] });
      assert(s.stockOf('b') >= 0, `库存不能为负，实际 ${s.stockOf('b')}`);
      assert(s.stockOf('b') !== -1, '不得静默变成"无限库存"');
    });

    test('⚠️ 反序倍率区间不产出负倍率', () => {
      const s = shop();
      s.restock(rng, 1, ['a'], { markupRange: [2, 1] });
      assert(s.priceOf('a', 'buy') > 0, `价格必须为正，实际 ${s.priceOf('a', 'buy')}`);
    });

    test('✓ 正常区间结果落在区间内（防止矫枉过正）', () => {
      const s = shop();
      s.restock(rng, 1, ['a'], { stockRange: [2, 5], markupRange: [1, 2] });
      const n = s.stockOf('a');
      assert(n >= 2 && n <= 5, `库存应落在 [2,5]，实际 ${n}`);
      assert(s.priceOf('a', 'buy') >= 10, '倍率 ≥ 1 时价格不低于基准');
    });

    test('✓ 默认区间与可复现性不变（防止矫枉过正）', () => {
      const s1 = shop();
      const s2 = shop();
      const picked1 = s1.restock({ next: () => 0.5 }, 2, ['a', 'b']);
      const picked2 = s2.restock({ next: () => 0.5 }, 2, ['a', 'b']);
      eq(picked1.join(','), picked2.join(','), '同种子结果必须一致');
      eq(s1.stockOf(picked1[0]), 1, '默认 stockRange [1,1]');
    });
  });
}
