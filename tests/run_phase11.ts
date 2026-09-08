/**
 * tests/run_phase11.ts —— `mover.turnRate`（平滑转向）新增能力
 *
 * 【这不是精审条目，是新增功能】
 * 第二次精审的 30 个 P0 与此无关；这一批测的是新加的 `turnRate` 配置项。
 * 放在独立文件里，避免与 16 个返工窗口的 `run_phase10_w*.ts` 冲突。
 *
 * 【最核心的一条断言是"默认行为不变"】
 * `turnRate` 默认 `undefined` → 内部收口为 0 → 瞬时。
 * 这意味着**老代码一行不改、行为完全不变**（第 1 组用例在守这个）。
 * 新增能力绝不能打断既有行为，这是全库最容易被违反的一条。
 *
 * 【一个必须理解的前提】
 * `facing` 跟随的是**实际速度方向**，不是输入方向。
 * 掉头那一帧速度还没反向，所以朝向不会变——这是正确的物理行为，
 * 我最初写的断言就错在这里（以为一帧就该转过去）。
 * 对照组因此一律用"facing 与速度方向的差"来判定，而不是与输入方向比。
 */

import { describe, test, assert, eq, near } from './_framework';
import { CharacterMover } from '../mover/CharacterMover';

/** 两角最短差（度） */
function angGapDeg(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs((d * 180) / Math.PI);
}

/**
 * 跑一段标准操作：先向右跑稳，再掉头 N 帧
 * @returns mover、每帧朝向快照、当前速度方向
 */
function runTurn(turnRate: number | undefined, frames: number) {
  const m = new CharacterMover({ x: 0, y: 0, turnRate });
  for (let i = 0; i < 30; i++) m.update(1 / 60, 1, 0);   // 向右跑稳
  const snaps: number[] = [];
  for (let i = 0; i < frames; i++) {
    m.update(1 / 60, -1, 0);
    snaps.push(m.facing);
  }
  // 速度方向（含外力）
  const inner = m as unknown as { _exX: number; _exY: number };
  return { m, snaps, velAng: Math.atan2(m.vy + inner._exY, m.vx + inner._exX) };
}

export function runPhase11Tests(): void {
  // ============================================================
  // 第 1 组：默认行为必须完全不变（向后兼容）
  // ============================================================

  describe('turnRate · 默认不配置时必须保持瞬时（向后兼容）', () => {
    test('⚠️ 不配 turnRate 时 facing 应完全等于速度方向', () => {
      /**
       * 【这条是全部用例里最重要的一条】
       * 老代码依赖"facing 立刻等于移动方向"。
       * 新增配置项如果改了默认值，会让所有既有集成悄悄变形。
       * 所以默认必须是"瞬时"，且这里断言差值 < 0.01°。
       */
      const { m, velAng } = runTurn(undefined, 10);
      const gap = angGapDeg(m.facing, velAng);
      assert(gap < 0.01, `facing 应完全跟随速度方向，实际差 ${gap.toFixed(4)}°`);
    });

    test('⚠️ turnRate=0 与不配置行为一致', () => {
      const a = runTurn(undefined, 10);
      const b = runTurn(0, 10);
      near(a.m.facing, b.m.facing, 1e-9, 'turnRate=0 应与默认完全一致');
    });
  });

  // ============================================================
  // 第 2 组：配了 turnRate 之后确实限速
  // ============================================================

  describe('turnRate · 限速生效', () => {
    test('⚠️ 配 turnRate 后 facing 应明显滞后于速度方向', () => {
      const { m, velAng } = runTurn(Math.PI, 10);
      const gap = angGapDeg(m.facing, velAng);
      assert(gap > 30, `应明显滞后，实际差 ${gap.toFixed(1)}°`);
    });

    test('⚠️ 每帧转动量应恒等于 turnRate × dt', () => {
      /**
       * turnRate = π rad/s，60fps → 每帧 π/60 rad = 3°。
       * 断言"恒定"比断言"转了"更重要：
       * 若实现用 lerp 逼近，转量会逐帧衰减（永远转不到位）；
       * 用恒定角速度才是"转速"的正确语义。
       */
      const { snaps } = runTurn(Math.PI, 10);
      const steps: number[] = [];
      for (let i = 1; i < snaps.length; i++) {
        const s = angGapDeg(snaps[i - 1], snaps[i]);
        if (s > 0.01) steps.push(s);
      }
      assert(steps.length > 0, '应该有转动发生');
      for (const s of steps) {
        near(s, 3, 0.01, `每帧应恒定 3°，实际 ${s.toFixed(3)}°`);
      }
    });

    test('⚠️ 给足时间必须收敛到目标（不能永久滞后）', () => {
      const { m, velAng } = runTurn(Math.PI, 120);
      const gap = angGapDeg(m.facing, velAng);
      assert(gap < 0.5, `2 秒后应收敛，实际差 ${gap.toFixed(3)}°`);
    });

    test('⚠️ 走最短路径，不能绕一大圈', () => {
      /**
       * 从 170° 转到 -170°：绕远路是 340°，最短只有 20°。
       * 直接对角度线性插值会走 340°——玩家看到角色自己转了一大圈。
       */
      const m = new CharacterMover({ x: 0, y: 0, turnRate: Math.PI * 0.5 });
      m.facing = (170 * Math.PI) / 180;
      const target = (-170 * Math.PI) / 180;
      let total = 0;
      let prev = m.facing;
      for (let i = 0; i < 40; i++) {
        m.update(1 / 60, Math.cos(target), Math.sin(target));
        total += angGapDeg(prev, m.facing);
        prev = m.facing;
      }
      assert(total < 40, `应走最短路径（≈20°），实际累计转过 ${total.toFixed(1)}°`);
    });
  });

  // ============================================================
  // 第 3 组：防止矫枉过正 —— 转向不能影响移动本身
  // ============================================================

  describe('turnRate · 只改朝向，不改移动（防止矫枉过正）', () => {
    test('⚠️ 相同输入下，有无 turnRate 的位置与速度必须完全一致', () => {
      /**
       * 【为什么这条必须存在】
       * 最危险的误改是"顺手让移动方向也平滑"——
       * 那会毁掉 `turnBoost` 建立的操作手感，且影响所有既有集成。
       * 这条断言锁死：turnRate 的唯一作用是 facing 的转速。
       */
      const a = new CharacterMover({ x: 0, y: 0 });                  // 瞬时
      const b = new CharacterMover({ x: 0, y: 0, turnRate: Math.PI }); // 限速
      for (let i = 0; i < 30; i++) { a.update(1/60, 1, 0); b.update(1/60, 1, 0); }
      for (let i = 0; i < 20; i++) { a.update(1/60, -1, 0); b.update(1/60, -1, 0); }

      near(b.x, a.x, 1e-9, '位置 x 不得因 turnRate 改变');
      near(b.y, a.y, 1e-9, '位置 y 不得因 turnRate 改变');
      near(b.vx, a.vx, 1e-9, '速度 vx 不得因 turnRate 改变');
      near(b.vy, a.vy, 1e-9, '速度 vy 不得因 turnRate 改变');

      // 而 facing 必须不同——否则说明限速根本没生效
      assert(
        angGapDeg(a.facing, b.facing) > 1,
        'facing 必须不同（否则限速未生效）'
      );
    });
  });

  // ============================================================
  // 第 4 组：数值收口
  // ============================================================

  describe('turnRate · 数值收口（NaN 不得静默失效）', () => {
    test('⚠️ turnRate = NaN 应退化成瞬时，而不是"配了却不生效"', () => {
      /**
       * 【为什么用 clampNum 而不是 `?? 0`】
       * `??` 只挡 null/undefined，挡不住 NaN。
       * turnRate 为 NaN 时 `rate > 0` 恒 false → 静默退化成瞬时，
       * 表现是"配了转向速度却完全没生效"，且看起来像配过了。
       *
       * 这里断言的方向很关键：不是"NaN 不报错"，
       * 而是"NaN 必须等价于显式配 0"（行为可预期、可解释）。
       */
      const nan = runTurn(NaN, 10);
      const zero = runTurn(0, 10);
      near(nan.m.facing, zero.m.facing, 1e-9, 'turnRate=NaN 应等价于 turnRate=0');
      assert(angGapDeg(nan.m.facing, nan.velAng) < 0.01, '且应是瞬时跟随');
    });

    test('⚠️ 非有限 dt 不得毒化 facing', () => {
      /**
       * `rate * NaN` = NaN，写回 _facing 会让它**永久变 NaN**，
       * 下游 `Math.cos(facing)` 之类全部失效且不报错。
       * 宁可这一帧不转，也不能把朝向毒化。
       */
      const m = new CharacterMover({ x: 0, y: 0, turnRate: Math.PI });
      for (let i = 0; i < 30; i++) m.update(1 / 60, 1, 0);
      const before = m.facing;
      m.update(NaN, 1, 0);
      m.update(Infinity, 1, 0);
      m.update(-1, 1, 0);
      m.update(0, 1, 0);
      eq(m.facing, before, '坏 dt 后 facing 必须保持不变');
    });

    test('⚠️ 极大 turnRate 等价瞬时（上界不误伤）', () => {
      const { m, velAng } = runTurn(1e4, 10);
      assert(angGapDeg(m.facing, velAng) < 0.01, '极大值应等价于瞬时');
    });
  });

  // ============================================================
  // 第 5 组：facing setter
  // ============================================================

  describe('facing · setter（设置初始朝向）', () => {
    test('⚠️ setter 应立即生效，不受 turnRate 限速', () => {
      /**
       * 【为什么需要 setter】
       * 开局 `_facing` 是 0（朝右）。角色第一次往左走时，
       * 配了 turnRate 会从 0 慢慢转过去——玩家看到"出生时莫名转身"。
       * 用它在出生/切场景/进入对话时把朝向一次设对。
       */
      const m = new CharacterMover({ x: 0, y: 0, turnRate: Math.PI });
      m.facing = Math.PI / 2;
      near((m.facing * 180) / Math.PI, 90, 1e-6, '应立即对齐 90°');
    });

    test('⚠️ 超范围值应归一化到 ±π', () => {
      const m = new CharacterMover({ x: 0, y: 0, turnRate: Math.PI });
      m.facing = 999;
      assert(Math.abs(m.facing) <= Math.PI + 1e-9, `应归一化，实际 ${m.facing}`);
    });

    test('⚠️ NaN 应归一到 0（确定可解释，而非毒化）', () => {
      const m = new CharacterMover({ x: 0, y: 0, turnRate: Math.PI });
      m.facing = NaN;
      eq(m.facing, 0, 'NaN 应归一到 0');
    });
  });

  // ============================================================
  // 第 6 组：moveBy（冲刺路径）同样受限速
  // ============================================================

  describe('turnRate · moveBy 冲刺路径', () => {
    test('⚠️ moveBy 也应受 turnRate 限速', () => {
      /**
       * `moveBy` 是给 DashController 用的路径：速度一步到位。
       * 若它绕过限速，冲刺时会瞬间转身，与常规移动的手感割裂。
       */
      const m = new CharacterMover({ x: 0, y: 0, turnRate: Math.PI });
      for (let i = 0; i < 30; i++) m.update(1 / 60, 1, 0);   // facing = 0
      const before = m.facing;
      m.moveBy(-10, 0, 1 / 60);   // 速度立刻反向
      const step = angGapDeg(before, m.facing);
      near(step, 3, 0.01, `应只转 3° 而非瞬移到 180°，实际 ${step.toFixed(3)}°`);
    });
  });
}
