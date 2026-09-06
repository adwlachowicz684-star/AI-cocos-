/**
 * tests/run_batch7.ts —— 第六批插件的测试
 *
 * 覆盖：attribute、hitbox、projectile、indicator、telegraph、
 *       skill-caster、input/InputBuffer、dash、camera
 *
 * 【这批的测试重点：组合与时序】
 *
 * 前五批测的多是"单个算法的正确性"，
 * 这批 8 个模块全都是**编排型**：它们把别的能力串起来。
 * 所以 bug 的形态变了：
 *
 * - 时序错：`hitDelay` 是相对按下还是相对蓄力结束？差一个 windup
 * - 状态泄漏：缓冲消费了没清、充能恢复了没记账
 * - 精度漂移：冲刺总距离不等于配置值、震屏叠加后飞出屏幕
 * - 边界吞噬：零向量方向变 NaN、跨格判定框查不到
 *
 * 【预期会抓到的 bug】
 * 写代码时已经修掉的（保留测试防止回归）：
 * 1. Projectile 的排除集曾被所有弹丸共享 → A 打过的目标 B 打不到
 * 2. sine 弹道从当前速度反推角度 → 轨迹螺旋漂走
 * 3. SkillCaster 充能恢复只恢复一层 → 两层技能第二次永远是空的
 * 4. 判定计时用 totalTime 而非 phaseTime → hitDelay 语义偏了一个 windup
 * 5. Telegraph 用 if 而非 while 推进阶段 → 低帧率时整个 active 窗口被跳过
 */

import { describe, test, assert, eq, near } from './_framework';

import { AttributeSet, summarizeModifiers } from '../attribute/AttributeSet';
import {
  HitboxWorld,
  circle as hbCircle,
  shapesOverlap,
  containsPoint,
  samplePoints,
  hitboxCenter,
  boundingRadius,
  circle,
  rect,
  sector,
  capsule,
  type Shape,
  type Hitbox,
} from '../hitbox/Hitbox';
import {
  ProjectileSystem,
  createHitboxSweepProvider,
  type ICollisionProvider,
} from '../projectile/Projectile';
import {
  SkillIndicator,
  inRing,
  snapAngle,
  type ISnapTarget,
} from '../indicator/SkillIndicator';
import {
  TelegraphSystem,
  telegraphProgress,
  phaseDuration,
  isDangerous,
} from '../telegraph/Telegraph';
import {
  SkillCaster,
  type IHitboxProvider,
  type IProjectileProvider,
  type IDamageProvider,
  type IResourceProvider,
} from '../skill-caster/SkillCaster';
import { InputBuffer, CoyoteTimer } from '../input/InputBuffer';
import { DashController, shouldSpawnGhost } from '../dash/DashController';
import { CameraShake, SHAKE_PRESETS, applyShakePreset } from '../camera/CameraShake';

const LAYER_ENEMY = 1 << 0;
const LAYER_WALL = 1 << 2;

export function runBatch7Tests(): void {
  // ══════════════════════════════════════════════════════════
  describe('AttributeSet · 属性容器', () => {
    test('基础计算：(base + Σadd) × (1 + Σmul)', () => {
      const a = new AttributeSet([{ id: 'atk', base: 20 }]);
      a.add({ attr: 'atk', type: 'add', value: 5 });
      a.add({ attr: 'atk', type: 'mul', value: 0.3 });
      near(a.get('atk'), 32.5, 1e-9, '(20+5)×1.3 = 32.5');
    });

    test('多个 mul 相加而不是连乘', () => {
      const a = new AttributeSet([{ id: 'atk', base: 100 }]);
      a.add({ attr: 'atk', type: 'mul', value: 0.5 });
      a.add({ attr: 'atk', type: 'mul', value: 0.5 });
      // 连乘会得到 225，相加才是 200
      near(a.get('atk'), 200, 1e-9, '两个 +50% 应是 2.0x 不是 2.25x');
    });

    test('override 取最后一个，add/mul 仍生效', () => {
      const a = new AttributeSet([{ id: 'hp', base: 10 }]);
      a.add({ attr: 'hp', type: 'override', value: 100 });
      a.add({ attr: 'hp', type: 'override', value: 200 });
      near(a.get('hp'), 200, 1e-9, '应取最后一个 override');
      a.add({ attr: 'hp', type: 'add', value: 50 });
      a.add({ attr: 'hp', type: 'mul', value: 0.1 });
      near(a.get('hp'), 275, 1e-9, '(200+50)×1.1 = 275');
    });

    test('clamp 作用在修正之后', () => {
      const a = new AttributeSet([{ id: 'crit', base: 0.5, min: 0, max: 1 }]);
      a.add({ attr: 'crit', type: 'add', value: 2 });
      eq(a.get('crit'), 1, '应被 max 钳到 1');
      a.clearModifiers();
      a.add({ attr: 'crit', type: 'add', value: -2 });
      eq(a.get('crit'), 0, '应被 min 钳到 0');
    });

    test('removeBySource 精确移除（同值不同源）', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      a.add({ attr: 'atk', type: 'add', value: 5, source: 'sword' });
      a.add({ attr: 'atk', type: 'add', value: 5, source: 'ring' });
      near(a.get('atk'), 20, 1e-9, '两个 +5');

      const n = a.removeBySource('sword');
      eq(n, 1, '应移除 1 个');
      near(a.get('atk'), 15, 1e-9, '只剩戒指的 +5');
    });

    test('倒序删除不漏元素（连续同 source）', () => {
      const a = new AttributeSet([{ id: 'atk', base: 0 }]);
      // 三个同 source 的修正器，正序遍历删除会漏掉后面的
      a.add({ attr: 'atk', type: 'add', value: 1, source: 'x' });
      a.add({ attr: 'atk', type: 'add', value: 1, source: 'x' });
      a.add({ attr: 'atk', type: 'add', value: 1, source: 'x' });
      eq(a.removeBySource('x'), 3, '三个应全部移除');
      eq(a.get('atk'), 0, '回到基础值');
    });

    test('clearByTag 批量清理', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      a.add({ attr: 'atk', type: 'add', value: 5, tag: 'buff' });
      a.add({ attr: 'atk', type: 'add', value: 3, tag: 'buff' });
      a.add({ attr: 'atk', type: 'add', value: 2, tag: 'equip' });
      a.clearByTag('buff');
      near(a.get('atk'), 12, 1e-9, '只保留装备的 +2');
    });

    test('add 返回的移除函数可精确取消', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      const off = a.add({ attr: 'atk', type: 'add', value: 7 });
      near(a.get('atk'), 17, 1e-9);
      off();
      near(a.get('atk'), 10, 1e-9, '取消后回到基础值');
    });

    test('缓存必须随修改失效（最容易出的 bug）', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      eq(a.get('atk'), 10, '首次查询（写入缓存）');
      a.add({ attr: 'atk', type: 'add', value: 5 });
      eq(a.get('atk'), 15, '修改后缓存必须失效');
      a.setBase('atk', 100);
      eq(a.get('atk'), 105, '改基础值后也要失效');
    });

    test('条件修正动态生效', () => {
      let enabled = false;
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      a.add({ attr: 'atk', type: 'add', value: 100, condition: () => enabled });

      eq(a.get('atk'), 10, '条件为 false 时不生效');
      enabled = true;
      eq(a.get('atk'), 110, '条件变 true 后立即生效（不能被缓存挡住）');
      enabled = false;
      eq(a.get('atk'), 10, '条件回到 false 也要立即生效');
    });

    test('移除条件修正后重算 hasConditional', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      const off = a.add({ attr: 'atk', type: 'add', value: 5, condition: () => true });
      eq(a.get('atk'), 15);
      off();
      eq(a.get('atk'), 10, '移除后应关闭条件模式并恢复缓存');
    });

    test('变化通知与批量挂起', () => {
      const a = new AttributeSet([{ id: 'atk', base: 10 }]);
      const seen: number[] = [];
      a.onChange((c) => seen.push(c.newValue));

      a.add({ attr: 'atk', type: 'add', value: 1 });
      eq(seen.length, 1, '单次修改应通知一次');

      a.suspendNotify();
      a.add({ attr: 'atk', type: 'add', value: 1 });
      a.add({ attr: 'atk', type: 'add', value: 1 });
      a.add({ attr: 'atk', type: 'add', value: 1 });
      eq(seen.length, 1, '挂起期间不通知');
      a.resumeNotify();
      eq(seen.length, 2, '恢复后合并成一次通知');
      eq(seen[1], 14, '通知的是最终值（10 + 1 + 3）');
    });

    test('summarizeModifiers 分组统计', () => {
      const s = summarizeModifiers([
        { attr: 'atk', type: 'add', value: 5 },
        { attr: 'atk', type: 'add', value: 3 },
        { attr: 'atk', type: 'mul', value: 0.2 },
        { attr: 'def', type: 'override', value: 99 },
      ]);
      eq(s['atk'].add, 8, '攻击加算合计');
      near(s['atk'].mul, 0.2, 1e-9, '攻击乘算合计');
      eq(s['def'].override, 99, '防御覆盖');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('Hitbox · 判定形状', () => {
    test('circle vs circle 基础重叠', () => {
      assert(shapesOverlap(circle(1), 0, 0, 0, circle(1), 1.5, 0, 0), '距离1.5 < 半径和2');
      assert(!shapesOverlap(circle(1), 0, 0, 0, circle(1), 2.5, 0, 0), '距离2.5 > 2');
    });

    test('circle vs rect：未旋转', () => {
      assert(shapesOverlap(circle(0.5), 1.2, 0, 0, rect(1, 1), 0, 0, 0), '圆贴着矩形右边');
      assert(!shapesOverlap(circle(0.5), 1.6, 0, 0, rect(1, 1), 0, 0, 0), '圆在矩形外');
    });

    test('circle vs rect：细长矩形只沿长边命中', () => {
      // 一个很扁的矩形（4×0.4）
      const r = rect(2, 0.2);
      assert(shapesOverlap(circle(0.3), 1.5, 0, 0, r, 0, 0, 0), '未旋转：正右方命中（长边沿 X）');
      assert(!shapesOverlap(circle(0.3), 0, 1.5, 0, r, 0, 0, 0), '未旋转：正上方不命中（短边只有 0.4）');
    });

    test('circle vs rect：旋转 90° 后长边朝 Y', () => {
      const r = rect(2, 0.2);
      // 旋转 90°，长边（halfW=2）转到 Y 轴
      assert(shapesOverlap(circle(0.3), 0, 1.5, 0, r, 0, 0, 90), '旋转后 Y 方向命中');
      assert(!shapesOverlap(circle(0.3), 1.5, 0, 0, r, 0, 0, 90), '旋转后 X 方向不该命中');
    });

    test('sector 扇形：角度范围内命中', () => {
      const s = sector(3, 90);   // 半径3，张角90（左右各45）
      assert(containsPoint(s, 0, 0, 0, 2, 0), '正前方（0°）命中');
      assert(containsPoint(s, 0, 0, 0, 1.4, 1.4), '45° 边缘内命中');
      assert(!containsPoint(s, 0, 0, 0, 0, 2), '正上方（90°）超出张角');
      assert(!containsPoint(s, 0, 0, 0, -2, 0), '背后不命中');
    });

    test('sector 朝向旋转后跟随', () => {
      const s = sector(3, 90);
      assert(containsPoint(s, 0, 0, 90, 0, 2), '朝向转90°后正上方命中');
      assert(!containsPoint(s, 0, 0, 90, 2, 0), '朝向转90°后正前方不命中');
    });

    test('offset 必须跟随 rotation 一起旋转', () => {
      const b: Hitbox = {
        id: 'x', shape: { kind: 'circle', radius: 0.5, offsetX: 2, offsetY: 0 },
        x: 0, y: 0, rotation: 0, layer: 1, mask: 1,
      };
      const c0 = hitboxCenter(b);
      near(c0.x, 2, 1e-9, '未旋转时偏移在 +X');

      b.rotation = 90;
      const c90 = hitboxCenter(b);
      near(c90.x, 0, 1e-9, '旋转90°后偏移应转到 +Y');
      near(c90.y, 2, 1e-9, '');
    });

    test('layer / mask 单向匹配', () => {
      const w = new HitboxWorld({ cellSize: 4 });
      w.add({ id: 'enemy', shape: circle(0.5), x: 0, y: 0, rotation: 0, layer: LAYER_ENEMY, mask: 0 });
      w.add({ id: 'wall', shape: circle(0.5), x: 0, y: 0, rotation: 0, layer: LAYER_WALL, mask: 0 });

      const hits = w.query(circle(2), 0, 0, 0, LAYER_ENEMY);
      eq(hits.length, 1, '只应命中 enemy');
      eq(hits[0].hitbox.id, 'enemy');
    });

    test('禁用的判定框不参与检测', () => {
      const w = new HitboxWorld({ cellSize: 4 });
      const b: Hitbox = { id: 'e', shape: circle(0.5), x: 0, y: 0, rotation: 0, layer: LAYER_ENEMY, mask: 0 };
      w.add(b);
      eq(w.query(circle(2), 0, 0, 0, LAYER_ENEMY).length, 1);
      w.setEnabled('e', false);
      eq(w.query(circle(2), 0, 0, 0, LAYER_ENEMY).length, 0, '禁用后应查不到');
    });

    test('跨格移动后仍能查到（update 必须重算格子）', () => {
      const w = new HitboxWorld({ cellSize: 1 });
      w.add({ id: 'e', shape: circle(0.3), x: 0, y: 0, rotation: 0, layer: LAYER_ENEMY, mask: 0 });

      // 移动到 10 格外
      w.update('e', 10, 0);
      eq(w.query(circle(1), 10, 0, 0, LAYER_ENEMY).length, 1, '新位置应能查到');
      eq(w.query(circle(1), 0, 0, 0, LAYER_ENEMY).length, 0, '旧位置不该还在');
    });

    test('跨格的判定框只返回一次（去重）', () => {
      const w = new HitboxWorld({ cellSize: 1 });
      // 放在格子边界上，会同时落在多个格子里
      w.add({ id: 'e', shape: circle(0.5), x: 1, y: 1, rotation: 0, layer: LAYER_ENEMY, mask: 0 });
      const hits = w.query(circle(3), 1, 1, 0, LAYER_ENEMY);
      eq(hits.length, 1, '跨格不该重复返回');
    });

    test('负坐标不出错', () => {
      const w = new HitboxWorld({ cellSize: 2 });
      w.add({ id: 'a', shape: circle(0.5), x: -5, y: -5, rotation: 0, layer: LAYER_ENEMY, mask: 0 });
      w.add({ id: 'b', shape: circle(0.5), x: 5, y: 5, rotation: 0, layer: LAYER_ENEMY, mask: 0 });
      eq(w.query(circle(1), -5, -5, 0, LAYER_ENEMY).length, 1, '负坐标应能查到 a');
      eq(w.query(circle(1), 5, 5, 0, LAYER_ENEMY).length, 1, '正坐标应能查到 b');
    });

    test('包围圆快速排除不能误杀', () => {
      // 一个"十字"形：采样点集中在轴上，包围圆很大但实际面积很小
      const thin: Shape = { kind: 'rect', halfW: 5, halfH: 0.05 };
      // 点在正上方 0.5 米：包围圆内（5.0），但实际不该命中
      assert(!containsPoint(thin, 0, 0, 0, 0, 0.5), '细长矩形上方不该命中');
      assert(containsPoint(thin, 0, 0, 0, 4, 0), '细长矩形沿 X 应命中');
    });

    test('samplePoints 覆盖形状边界', () => {
      const pts = samplePoints(sector(2, 90), 0, 0, 0);
      assert(pts.length > 5, `扇形采样点应足够密，实际 ${pts.length}`);
      const maxR = Math.max(...pts.map((p) => Math.hypot(p.x, p.y)));
      near(maxR, 2, 1e-6, '最远采样点应在半径上');
    });

    test('boundingRadius 各形状', () => {
      near(boundingRadius(circle(2)), 2, 1e-9);
      near(boundingRadius(rect(3, 4)), 5, 1e-9, '矩形是半对角线');
      near(boundingRadius(capsule(1, 2)), 2, 1e-9, '胶囊 = 半高 + 半径');
    });

    test('⚠️ boundingRadius 必须包含 offset', () => {
      const withOffset: Shape = { kind: 'circle', radius: 1, offsetX: 3, offsetY: 4 };
      near(boundingRadius(withOffset), 6, 1e-9, '1 + hypot(3,4) = 6');
      // 不算 offset 的话，快速排除会把这个形状判成半径 1，漏掉远距离目标
    });

    test('⚠️ 查询形状的 offset 必须生效', () => {
      const w = new HitboxWorld({ cellSize: 4 });
      // 敌人在正前方 3 米
      w.add({ id: 'e', shape: circle(0.5), x: 3, y: 0, rotation: 0, layer: LAYER_ENEMY, mask: 0 });

      // 剑气：矩形半长 1，用 offsetX 前移 2 米 → 覆盖 1~3 米
      const swordSlash: Shape = { kind: 'rect', halfW: 1, halfH: 0.3, offsetX: 2 };
      const hits = w.query(swordSlash, 0, 0, 0, LAYER_ENEMY);
      eq(hits.length, 1, 'offsetX 生效时应命中 3 米处的敌人');

      // 反向验证：没有 offset 的话覆盖 -1~1 米，打不到
      const tooShort: Shape = { kind: 'rect', halfW: 1, halfH: 0.3 };
      eq(w.query(tooShort, 0, 0, 0, LAYER_ENEMY).length, 0, '不带 offset 时应打不到 3 米处');
    });

    test('查询形状 offset 跟随朝向旋转', () => {
      const w = new HitboxWorld({ cellSize: 4 });
      w.add({ id: 'up', shape: circle(0.4), x: 0, y: 3, rotation: 0, layer: LAYER_ENEMY, mask: 0 });
      w.add({ id: 'right', shape: circle(0.4), x: 3, y: 0, rotation: 0, layer: LAYER_ENEMY, mask: 0 });

      const jab: Shape = { kind: 'rect', halfW: 1, halfH: 0.3, offsetX: 2 };

      const hitsRight = w.query(jab, 0, 0, 0, LAYER_ENEMY);
      eq(hitsRight.length, 1, '朝右时应命中 right');
      eq(hitsRight[0].hitbox.id, 'right');

      const hitsUp = w.query(jab, 0, 0, 90, LAYER_ENEMY);
      eq(hitsUp.length, 1, '朝上时应命中 up');
      eq(hitsUp[0].hitbox.id, 'up', 'offset 必须跟着转，不能永远朝 X');
    });

    test('lineOfSightBlocked 检测遮挡', () => {
      const w = new HitboxWorld({ cellSize: 4 });
      w.add({ id: 'wall', shape: rect(0.2, 2), x: 5, y: 0, rotation: 0, layer: LAYER_WALL, mask: 0 });
      assert(w.lineOfSightBlocked(0, 0, 10, 0, LAYER_WALL), '中间有墙应被挡');
      assert(!w.lineOfSightBlocked(0, 5, 10, 5, LAYER_WALL), '绕过墙不该被挡');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('Projectile · 弹道', () => {
    /** 简单的墙：一条竖线 x = wallX */
    function wallProvider(wallX: number, thickness = 0.2): ICollisionProvider {
      return {
        sweep(fx, _fy, tx, _ty, _mask, _exclude) {
          // 只检测从左到右穿过 wallX
          const half = thickness / 2;
          if (fx < wallX - half && tx >= wallX - half) {
            return { id: 'wall', x: wallX - half, y: 0, nx: -1, ny: 0, t: 0.5 };
          }
          return null;
        },
      };
    }

    test('直线飞行位置正确', () => {
      const sys = new ProjectileSystem({ collision: { sweep: () => null } });
      const p = sys.spawn({ x: 0, y: 0, dirX: 1, dirY: 0, speed: 10, lifetime: 5, mask: 0 });
      for (let i = 0; i < 10; i++) sys.tick(1 / 60);
      near(p.x, 10 * (10 / 60), 0.01, '10 帧 × 1/60 秒 × 速度10');
    });

    test('方向未归一化也能正确飞行', () => {
      const sys = new ProjectileSystem({ collision: { sweep: () => null } });
      const p = sys.spawn({ x: 0, y: 0, dirX: 3, dirY: 4, speed: 10, lifetime: 5, mask: 0 });
      sys.tick(0.5);
      near(p.x, 3, 0.01, '(3,4) 归一化后 X 分量 0.6 × 10 × 0.5 = 3');
      near(p.y, 4, 0.01, '');
    });

    test('零向量不产生 NaN', () => {
      const sys = new ProjectileSystem({ collision: { sweep: () => null } });
      const p = sys.spawn({ x: 0, y: 0, dirX: 0, dirY: 0, speed: 10, lifetime: 1, mask: 0 });
      sys.tick(1 / 60);
      assert(Number.isFinite(p.x) && Number.isFinite(p.y), `坐标不能是 NaN：(${p.x}, ${p.y})`);
    });

    test('高速弹丸不穿墙（maxStep 切分）', () => {
      // 墙在 x=5，厚 0.2。速度 1000 m/s，一帧 1/60 秒 = 16.7 米
      // 不切分的话一帧就从 0 飞到 16.7，直接跨过墙
      const sys = new ProjectileSystem({
        collision: wallProvider(5),
        maxStep: 0.5,
      });
      let hitWall = false;
      sys.spawn({
        x: 0, y: 0, dirX: 1, dirY: 0, speed: 1000, lifetime: 1, mask: LAYER_WALL,
        onHit: (h) => { if (h.id === 'wall') hitWall = true; },
      });
      sys.tick(1 / 60);
      assert(hitWall, '高速弹丸必须被墙挡住，不能穿过去');
    });

    test('超时必须销毁', () => {
      const sys = new ProjectileSystem({ collision: { sweep: () => null } });
      sys.spawn({ x: 0, y: 0, dirX: 1, dirY: 0, speed: 1, lifetime: 0.5, mask: 0 });
      eq(sys.count, 1);
      for (let i = 0; i < 40; i++) sys.tick(1 / 60);
      eq(sys.count, 0, '0.67 秒后应已销毁');
    });

    test('穿透：命中后继续飞且目标不重复', () => {
      // 两个目标在 x=2 和 x=4
      const targets = [
        { id: 'a', x: 2, r: 0.5 },
        { id: 'b', x: 4, r: 0.5 },
      ];
      const provider: ICollisionProvider = {
        sweep(fx, fy, tx, _ty, _mask, exclude) {
          for (const t of targets) {
            if (exclude.has(t.id)) continue;
            // 简单判定：路径是否经过目标圆
            if (fx < t.x && tx >= t.x && Math.abs(fy) < t.r) {
              return { id: t.id, x: t.x, y: 0, t: 0.5 };
            }
          }
          return null;
        },
      };
      const sys = new ProjectileSystem({ collision: provider, maxStep: 0.3 });
      const hitIds: string[] = [];
      sys.spawn({
        x: 0, y: 0, dirX: 1, dirY: 0, speed: 10, lifetime: 2, mask: 1,
        pierce: 2,
        onHit: (h) => hitIds.push(h.id),
      });
      for (let i = 0; i < 60; i++) sys.tick(1 / 60);

      eq(hitIds.length, 2, '应命中两个目标');
      eq(hitIds[0], 'a');
      eq(hitIds[1], 'b');
      eq(new Set(hitIds).size, 2, '同一目标不该被命中两次');
    });

    test('穿透的排除集不能被其他弹丸共享', () => {
      // 曾经的实现把排除集做成实例字段，A 打过的目标 B 也打不到
      const provider: ICollisionProvider = {
        sweep(fx, _fy, tx, _ty, _mask, exclude) {
          if (!exclude.has('a') && fx < 2 && tx >= 2) return { id: 'a', x: 2, y: 0, t: 0.5 };
          return null;
        },
      };
      const sys = new ProjectileSystem({ collision: provider, maxStep: 0.3 });
      let hits1 = 0, hits2 = 0;
      sys.spawn({ x: 0, y: 0, dirX: 1, dirY: 0, speed: 10, lifetime: 1, mask: 1, pierce: 1, onHit: () => hits1++ });
      sys.spawn({ x: 0, y: 0.1, dirX: 1, dirY: 0, speed: 10, lifetime: 1, mask: 1, pierce: 1, onHit: () => hits2++ });
      for (let i = 0; i < 30; i++) sys.tick(1 / 60);

      assert(hits1 > 0, '第一发应命中');
      assert(hits2 > 0, '第二发也应命中（排除集不能共享）');
    });

    test('抛物线命中落点', () => {
      const sys = new ProjectileSystem({ collision: { sweep: () => null } });
      const p = sys.spawn({
        x: 0, y: 0, dirX: 1, dirY: 0, speed: 10, lifetime: 5, mask: 0,
        mode: 'parabola', targetX: 10, targetY: 0, gravity: 20,
      });
      // 飞行时间 = 10 / 10 = 1 秒
      let steps = 0;
      while (p.age < 1 && steps++ < 200) sys.tick(1 / 120);
      near(p.x, 10, 0.3, '水平应到达目标点');
      near(p.y, 0, 0.3, '竖直应回到目标高度');
    });

    test('抛物线中途确实在上升（有弧线）', () => {
      const sys = new ProjectileSystem({ collision: { sweep: () => null } });
      const p = sys.spawn({
        x: 0, y: 0, dirX: 1, dirY: 0, speed: 10, lifetime: 5, mask: 0,
        mode: 'parabola', targetX: 10, targetY: 0, gravity: 20,
      });
      for (let i = 0; i < 60; i++) sys.tick(1 / 120);   // 半程
      assert(p.y > 1, `半程时应在空中，实际 y=${p.y.toFixed(2)}`);
    });

    test('追踪弹能收敛（不振荡）', () => {
      const target = { x: 10, y: 0 };
      const sys = new ProjectileSystem({ collision: { sweep: () => null } });
      const p = sys.spawn({
        x: 0, y: 0, dirX: 1, dirY: 0.5, speed: 8, lifetime: 5, mask: 0,
        mode: 'homing', homingTarget: target, turnRate: 120,
      });
      let minDist = Infinity;
      for (let i = 0; i < 200; i++) {
        sys.tick(1 / 60);
        minDist = Math.min(minDist, Math.hypot(p.x - target.x, p.y - target.y));
      }
      assert(minDist < 0.5, `追踪弹应能接近目标，最近距离 ${minDist.toFixed(3)}`);
    });

    test('追踪弹转向率受限（不会瞬间转向）', () => {
      const target = { x: 0, y: 10 };   // 目标在正上方，弹丸朝右飞
      const sys = new ProjectileSystem({ collision: { sweep: () => null } });
      const p = sys.spawn({
        x: 0, y: 0, dirX: 1, dirY: 0, speed: 5, lifetime: 1, mask: 0,
        mode: 'homing', homingTarget: target, turnRate: 90,
      });
      sys.tick(1 / 60);
      // 1/60 秒最多转 90/60 = 1.5 度
      const angle = (Math.atan2(p.vy, p.vx) * 180) / Math.PI;
      assert(angle < 2, `一帧最多转 1.5 度，实际 ${angle.toFixed(2)}`);
    });

    test('弹跳反射方向正确', () => {
      const sys = new ProjectileSystem({
        collision: wallProvider(5),
        maxStep: 0.3,
      });
      // 墙在 x=5。速度 10 需要 0.5 秒才到，跑 60 帧（1 秒）确保撞上
      const p = sys.spawn({
        x: 0, y: 0, dirX: 1, dirY: 0, speed: 10, lifetime: 3, mask: LAYER_WALL,
        bounce: 1,
      });
      for (let i = 0; i < 60; i++) sys.tick(1 / 60);
      assert(p.vx < 0, `撞墙后应反向，实际 vx=${p.vx.toFixed(2)}`);
      assert(p.x < 5, `反弹后应在墙左侧，实际 x=${p.x.toFixed(2)}`);
    });

    test('sine 弹道沿主轴不漂移', () => {
      const sys = new ProjectileSystem({ collision: { sweep: () => null } });
      const p = sys.spawn({
        x: 0, y: 0, dirX: 1, dirY: 0, speed: 10, lifetime: 2, mask: 0,
        mode: 'sine', amplitude: 0.5, frequency: 2,
      });
      // 主轴方向应该稳定前进
      let prevY = 0;
      let maxDeviation = 0;
      for (let i = 0; i < 60; i++) {
        sys.tick(1 / 60);
        maxDeviation = Math.max(maxDeviation, Math.abs(p.y));
        void prevY;
      }
      near(p.x, 10, 0.2, '主轴方向应匀速前进到 10');
      assert(maxDeviation <= 0.6, `摆动幅度不应超过 amplitude，实际 ${maxDeviation.toFixed(3)}`);
    });

    test('accel 模式加减速', () => {
      const sys = new ProjectileSystem({ collision: { sweep: () => null } });
      const p = sys.spawn({
        x: 0, y: 0, dirX: 1, dirY: 0, speed: 10, lifetime: 5, mask: 0,
        mode: 'accel', accel: 20, maxSpeed: 100,
      });
      sys.tick(1);
      near(Math.hypot(p.vx, p.vy), 30, 0.1, '1 秒后 10 + 20 = 30');
    });

    test('边界外销毁', () => {
      const sys = new ProjectileSystem({
        collision: { sweep: () => null },
        bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
      });
      // 边界 ±10，一帧必须飞出去：60 帧/秒下需要 speed > 600
      sys.spawn({ x: 0, y: 0, dirX: 1, dirY: 0, speed: 1000, lifetime: 10, mask: 0 });
      sys.tick(1 / 60);
      eq(sys.count, 0, '飞出边界应销毁（不等 lifetime）');
    });

    test('createHitboxSweepProvider 能接上 HitboxWorld', () => {
      const world = new HitboxWorld({ cellSize: 2 });
      world.add({ id: 'e', shape: circle(0.5), x: 3, y: 0, rotation: 0, layer: LAYER_ENEMY, mask: 0 });
      const provider = createHitboxSweepProvider(world, { segmentRadius: 0.1 });
      const sys = new ProjectileSystem({ collision: provider, maxStep: 0.5 });

      let hit = false;
      sys.spawn({ x: 0, y: 0, dirX: 1, dirY: 0, speed: 10, lifetime: 1, mask: LAYER_ENEMY, onHit: () => { hit = true; } });
      for (let i = 0; i < 30; i++) sys.tick(1 / 60);
      assert(hit, '应命中敌人');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('SkillIndicator · 技能指示器', () => {
    test('超出射程要钳制而不是失败', () => {
      const ind = new SkillIndicator({ kind: 'circle', radius: 2, range: 5, aimed: true });
      const r = ind.compute(0, 0, 0, 100, 0);   // 瞄准 100 米外
      assert(r.clamped, '应标记为已钳制');
      near(r.x, 5, 1e-6, '应钳到射程边缘 5 米');
      near(r.y, 0, 1e-6);
    });

    test('射程内不钳制', () => {
      const ind = new SkillIndicator({ kind: 'circle', radius: 2, range: 10, aimed: true });
      const r = ind.compute(0, 0, 0, 3, 4);
      assert(!r.clamped, '5 米在 10 米射程内');
      near(r.x, 3, 1e-6);
      near(r.y, 4, 1e-6);
    });

    test('aimed=false 时以自身为中心', () => {
      const ind = new SkillIndicator({ kind: 'sector', radius: 3, angleDeg: 90, range: 5, aimed: false });
      const r = ind.compute(7, 8, 45, 100, 100);
      near(r.x, 7, 1e-6, '中心应是施法者位置');
      near(r.y, 8, 1e-6);
    });

    test('扇形朝向跟随瞄准点', () => {
      const ind = new SkillIndicator({ kind: 'sector', radius: 3, angleDeg: 90, range: 10, aimed: true });
      const r = ind.compute(0, 0, 0, 0, 5);   // 瞄准正上方
      near(r.rotation, 90, 1e-6, '应朝 90 度');
    });

    test('瞄准点在脚下时保持朝向', () => {
      const ind = new SkillIndicator({ kind: 'sector', radius: 3, angleDeg: 90, range: 10, aimed: true });
      const r = ind.compute(0, 0, 37, 0, 0);
      near(r.rotation, 37, 1e-6, '摇杆没推时应保持角色朝向');
    });

    test('line 类型：中心要前移半个长度', () => {
      const ind = new SkillIndicator({ kind: 'line', length: 4, width: 1, range: 10, aimed: false });
      const c = ind.centerFor(0, 0, 0);
      near(c.x, 2, 1e-6, '中心应在前方 2 米（半长）');
      near(c.y, 0, 1e-6);
    });

    test('line 朝向 90 度时中心在 Y 方向', () => {
      const ind = new SkillIndicator({ kind: 'line', length: 4, width: 1, range: 10, aimed: false });
      const c = ind.centerFor(0, 0, 90);
      near(c.x, 0, 1e-6);
      near(c.y, 2, 1e-6);
    });

    test('minRange 过近时无效', () => {
      const ind = new SkillIndicator({ kind: 'circle', radius: 2, range: 10, aimed: true, minRange: 3 });
      const near1 = ind.compute(0, 0, 0, 1, 0);
      assert(!near1.valid, '1 米小于 minRange 3 应无效');
      eq(near1.invalidReason, 'too-close');

      const far = ind.compute(0, 0, 0, 5, 0);
      assert(far.valid, '5 米应有效');
    });

    test('落点校验器可拒绝非法位置', () => {
      const ind = new SkillIndicator(
        { kind: 'circle', radius: 2, range: 10, aimed: true },
        { placement: { isValid: (x) => x >= 0 } },
      );
      assert(ind.compute(0, 0, 0, 5, 0).valid, 'x=5 合法');
      const bad = ind.compute(0, 0, 0, -5, 0);
      assert(!bad.valid, 'x=-5 应被拒绝');
      eq(bad.invalidReason, 'blocked');
    });

    test('目标吸附', () => {
      const targets: ISnapTarget[] = [{ id: 'boss', x: 4.2, y: 0.1, radius: 1 }];
      const ind = new SkillIndicator(
        { kind: 'circle', radius: 2, range: 10, aimed: true, snapToTarget: true, snapRadius: 1 },
        { targets: { findNearest: (x, y) => targets.find((t) => Math.hypot(t.x - x, t.y - y) < 1.5) ?? null } },
      );
      const r = ind.compute(0, 0, 0, 4, 0);
      eq(r.snappedTo, 'boss', '应吸附到 boss');
      near(r.x, 4.2, 1e-6, '中心应移动到目标位置');
    });

    test('ring 类型返回外圆（配合 inRing 过滤）', () => {
      const ind = new SkillIndicator({ kind: 'ring', radius: 5, innerRadius: 2, range: 10, aimed: false });
      const r = ind.compute(0, 0, 0, 0, 0);
      eq(r.shape.kind, 'circle');
      eq(r.shape.radius, 5);

      assert(inRing(3, 0, 0, 0, 2, 5), '半径3在环内');
      assert(!inRing(1, 0, 0, 0, 2, 5), '半径1在内圈空洞');
      assert(!inRing(6, 0, 0, 0, 2, 5), '半径6在外圈外');
    });

    test('snapAngle 限制偏离', () => {
      near(snapAngle(90, 0, 15), 15, 1e-9, '偏离 90 度应被限到 15');
      near(snapAngle(-90, 0, 15), -15, 1e-9);
      near(snapAngle(5, 0, 15), 5, 1e-9, '小偏离保持原样');
    });

    test('snapAngle 处理角度环绕', () => {
      // 期望 350 度，当前 10 度：差值应算作 -20 度而不是 340 度
      near(snapAngle(350, 10, 15), -5, 1e-9, '应走短边（350 等价于 -10）');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('Telegraph · 攻击预警', () => {
    test('三阶段按时序推进', () => {
      const sys = new TelegraphSystem();
      const t = sys.spawn({ shape: circle(2), x: 0, y: 0, windup: 0.5, active: 0.2, recover: 0.3 });

      eq(t.phase, 'windup');
      sys.tick(0.4);
      eq(t.phase, 'windup', '0.4 < 0.5 仍在蓄力');
      sys.tick(0.2);
      eq(t.phase, 'active', '超过 0.5 应进入判定');
      sys.tick(0.05);
      eq(t.phase, 'active', '累计 0.65，仍在 active（0.5~0.7）内');
      sys.tick(0.1);
      eq(t.phase, 'recover', '累计 0.75，已过 active 窗口');
      sys.tick(0.4);
      eq(t.phase, 'done');
    });

    test('onActivate 只触发一次', () => {
      const sys = new TelegraphSystem();
      let n = 0;
      sys.spawn({ shape: circle(2), x: 0, y: 0, windup: 0.5, active: 0.2, onActivate: () => n++ });
      for (let i = 0; i < 60; i++) sys.tick(1 / 60);
      eq(n, 1, '判定回调应只触发一次');
    });

    test('低帧率下 active 不会被整个跳过', () => {
      // 20fps：dt = 0.05。windup 0.5，active 0.02（极短窗口）
      // 用 if 推进的话，跨过 windup 的那一帧会直接落到 recover，active 被跳过
      const sys = new TelegraphSystem();
      let activated = false;
      sys.spawn({
        shape: circle(2), x: 0, y: 0,
        windup: 0.5, active: 0.02, recover: 0.3,
        onActivate: () => { activated = true; },
      });
      for (let i = 0; i < 20; i++) sys.tick(0.05);
      assert(activated, '极短判定窗口也必须被触发');
    });

    test('⚠️ active 开始后位置必须冻结（铁律）', () => {
      const sys = new TelegraphSystem();
      const caster = { x: 0, y: 0 };
      const t = sys.spawn({
        shape: circle(2), x: 0, y: 0,
        windup: 0.5, active: 0.3, recover: 0,
        followCaster: true, caster,
      });

      sys.tick(0.3);
      caster.x = 10;              // Boss 移动了
      sys.tick(0.1);
      near(t.x, 10, 1e-6, '蓄力期间应跟随施法者');

      sys.tick(0.2);              // 越过 windup 进入 active
      eq(t.phase, 'active');
      const frozen = t.x;

      caster.x = 999;             // Boss 继续移动
      sys.tick(0.1);
      near(t.x, frozen, 1e-6, 'active 后位置必须冻结，否则玩家躲开了也会被判中');
    });

    test('cancel 不触发判定回调', () => {
      const sys = new TelegraphSystem();
      let activated = false;
      let completed = false;
      const t = sys.spawn({
        shape: circle(2), x: 0, y: 0, windup: 0.5, active: 0.2,
        onActivate: () => { activated = true; },
        onComplete: () => { completed = true; },
      });
      sys.tick(0.3);
      sys.cancel(t.id);
      sys.tick(0.5);
      assert(!activated, '取消后不应判定');
      assert(completed, '但应触发完成回调（带 cancelled 标记）');
    });

    test('cancelAll 清空所有', () => {
      const sys = new TelegraphSystem();
      for (let i = 0; i < 5; i++) {
        sys.spawn({ shape: circle(1), x: i, y: 0, windup: 1, active: 0.1 });
      }
      eq(sys.count, 5);
      eq(sys.cancelAll(), 5);
      eq(sys.count, 0);
    });

    test('dt=0 时不推进（暂停生效）', () => {
      const sys = new TelegraphSystem();
      const t = sys.spawn({ shape: circle(2), x: 0, y: 0, windup: 0.5, active: 0.2 });
      for (let i = 0; i < 100; i++) sys.tick(0);
      eq(t.phase, 'windup', '暂停期间不应推进');
      near(t.age, 0, 1e-9);
    });

    test('phaseDuration 与 progress', () => {
      const sys = new TelegraphSystem();
      const t = sys.spawn({ shape: circle(2), x: 0, y: 0, windup: 0.5, active: 0.2, recover: 0.3 });
      eq(phaseDuration(t), 0.5);
      sys.tick(0.25);
      near(telegraphProgress(t), 0.5, 1e-6, '蓄力过半');
      assert(!isDangerous(t), '刚过半还不算危险');
      sys.tick(0.15);
      assert(isDangerous(t), '进展 80% 应标记为危险');
    });

    test('recover 为 0 时直接结束', () => {
      const sys = new TelegraphSystem();
      const t = sys.spawn({ shape: circle(2), x: 0, y: 0, windup: 0.1, active: 0.1, recover: 0 });
      sys.tick(0.25);
      eq(t.phase, 'done');
      eq(sys.count, 0, '结束后应移出列表');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('SkillCaster · 技能释放', () => {
    function makeCaster(opts: {
      targets?: Array<{ id: string; x: number; y: number }>;
      resources?: Record<string, number>;
    } = {}) {
      const hits: string[] = [];
      const applied: Array<{ target: unknown; raw: number; hitId: string }> = [];
      const spawned: Array<{ dirX: number; dirY: number; x: number; y: number }> = [];

      // 【用真实的 HitboxWorld 而不是无条件返回的 mock】
      // 曾经这里写成 `query: () => targets.map(...)`，
      // 导致形状、朝向、距离全部被忽略——"打不到远处"这类测试根本无法成立。
      // 测试双如果比真实实现还宽松，就是在测空气。
      const world = new HitboxWorld({ cellSize: 4 });
      for (const t of opts.targets ?? []) {
        world.add({
          id: t.id, shape: hbCircle(0.5),
          x: t.x, y: t.y, rotation: 0,
          layer: LAYER_ENEMY, mask: 0, data: t,
        });
      }
      const hitboxes: IHitboxProvider = {
        query: (shape, x, y, rot, mask) =>
          world.query(shape, x, y, rot, mask).map((h) => ({
            id: h.hitbox.id, x: h.hitbox.x, y: h.hitbox.y, data: h.hitbox.data,
          })),
      };
      const projectiles: IProjectileProvider = {
        spawn: (p) => { spawned.push({ dirX: p.dirX, dirY: p.dirY, x: p.x, y: p.y }); return p; },
      };
      const damage: IDamageProvider = {
        apply: (target, dmg, hitId) => {
          applied.push({ target, raw: dmg.raw, hitId });
          hits.push(hitId);
        },
      };
      const purse: Record<string, number> = { ...(opts.resources ?? { mp: 100 }) };
      const resources: IResourceProvider = {
        canAfford: (cost) => Object.entries(cost).every(([k, v]) => (purse[k] ?? 0) >= v),
        pay: (cost) => { for (const [k, v] of Object.entries(cost)) purse[k] = (purse[k] ?? 0) - v; },
        refund: (cost) => { for (const [k, v] of Object.entries(cost)) purse[k] = (purse[k] ?? 0) + v; },
      };

      const caster = new SkillCaster({ hitboxes, projectiles, damage, resources });
      return { caster, hits, applied, spawned, purse };
    }

    test('基本施放：走完整个流程', () => {
      const { caster, applied } = makeCaster({ targets: [{ id: 'e1', x: 1, y: 0 }] });
      caster.learn({
        id: 'slash', cooldown: 1, mask: LAYER_ENEMY,
        windup: 0.1, hitDelay: 0.05, hitWindow: 0, recover: 0.2,
        hitShape: { kind: 'sector', radius: 2, angleDeg: 90 },
        damage: { raw: 20 },
      });

      const r = caster.tryCast('slash', { x: 0, y: 0, facingDeg: 0 });
      assert(r.ok, '应施放成功');

      for (let i = 0; i < 30; i++) caster.tick(1 / 60);
      eq(applied.length, 1, '应造成一次伤害');
      assert(!caster.busy, '施放结束后应回到空闲');
    });

    test('hitDelay 是相对蓄力结束（不是相对按下）', () => {
      const { caster, applied } = makeCaster({ targets: [{ id: 'e', x: 1, y: 0 }] });
      caster.learn({
        id: 's', cooldown: 0, mask: LAYER_ENEMY,
        windup: 0.3, hitDelay: 0.1, hitWindow: 0,
        hitShape: { kind: 'circle', radius: 1 },
        damage: { raw: 10 },
      });
      caster.tryCast('s', { x: 0, y: 0, facingDeg: 0 });

      // 蓄力 0.3 + 判定延迟 0.1 = 0.4 秒时判定
      for (let i = 0; i < 20; i++) caster.tick(1 / 60);   // 0.333 秒
      eq(applied.length, 0, '0.33 秒时还没到判定点（0.4）');
      for (let i = 0; i < 6; i++) caster.tick(1 / 60);    // 0.433 秒
      eq(applied.length, 1, '0.43 秒应已判定');
    });

    test('冷却期间不能施放', () => {
      const { caster } = makeCaster({ targets: [] });
      caster.learn({ id: 's', cooldown: 1, mask: 0, hitWindow: 0 });

      assert(caster.tryCast('s', { x: 0, y: 0, facingDeg: 0 }).ok, '第一次应成功');
      for (let i = 0; i < 30; i++) caster.tick(1 / 60);   // 0.5 秒，冷却 1 秒只走一半

      const r2 = caster.tryCast('s', { x: 0, y: 0, facingDeg: 0 });
      assert(!r2.ok, '冷却中应失败');
      eq(r2.reason, 'cooldown');
    });

    test('冷却结束后恢复充能（两层技能要恢复两层）', () => {
      const { caster } = makeCaster({ targets: [] });
      caster.learn({ id: 's', cooldown: 0.5, charges: 2, mask: 0, hitWindow: 0 });

      eq(caster.chargesLeft('s'), 2);
      caster.tryCast('s', { x: 0, y: 0, facingDeg: 0 });
      eq(caster.chargesLeft('s'), 1, '用掉一层');
      caster.tick(0.01);
      caster.tryCast('s', { x: 0, y: 0, facingDeg: 0 });   // 需要打断上一次
      caster.cancel();
      eq(caster.chargesLeft('s'), 0, '用完两层');

      // 冷却 0.5 秒后应恢复 1 层，再 0.5 秒恢复第 2 层
      for (let i = 0; i < 40; i++) caster.tick(1 / 60);
      assert(caster.chargesLeft('s') >= 1, `应恢复至少 1 层，实际 ${caster.chargesLeft('s')}`);
      for (let i = 0; i < 40; i++) caster.tick(1 / 60);
      eq(caster.chargesLeft('s'), 2, '最终应恢复到 2 层');
    });

    test('资源不足时失败且不施放', () => {
      const { caster, purse, applied } = makeCaster({
        targets: [{ id: 'e', x: 1, y: 0 }],
        resources: { mp: 5 },
      });
      caster.learn({
        id: 'big', cooldown: 0, mask: LAYER_ENEMY, cost: { mp: 50 },
        hitWindow: 0, hitShape: { kind: 'circle', radius: 1 }, damage: { raw: 99 },
      });

      const r = caster.tryCast('big', { x: 0, y: 0, facingDeg: 0 });
      assert(!r.ok);
      eq(r.reason, 'resource');
      eq(purse.mp, 5, '失败时不应扣费');
      eq(applied.length, 0);
    });

    test('成功施放要扣费', () => {
      const { caster, purse } = makeCaster({ targets: [], resources: { mp: 100 } });
      caster.learn({ id: 's', cooldown: 0, mask: 0, hitWindow: 0, cost: { mp: 30 } });
      caster.tryCast('s', { x: 0, y: 0, facingDeg: 0 });
      eq(purse.mp, 70, '应扣除 30');
    });

    test('busy 时不能施放', () => {
      const { caster } = makeCaster({ targets: [] });
      caster.learn({ id: 'a', cooldown: 0, mask: 0, hitWindow: 0, windup: 0.5 });
      caster.learn({ id: 'b', cooldown: 0, mask: 0, hitWindow: 0 });

      caster.tryCast('a', { x: 0, y: 0, facingDeg: 0 });
      const r = caster.tryCast('b', { x: 0, y: 0, facingDeg: 0 });
      assert(!r.ok);
      eq(r.reason, 'busy');
    });

    test('判定窗口内同一目标只命中一次', () => {
      const { caster, applied } = makeCaster({ targets: [{ id: 'e', x: 1, y: 0 }] });
      caster.learn({
        id: 'spin', cooldown: 0, mask: LAYER_ENEMY,
        windup: 0.05, hitDelay: 0.05, hitWindow: 0.5,
        hitShape: { kind: 'circle', radius: 3 },
        damage: { raw: 5 },
      });
      caster.tryCast('spin', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 40; i++) caster.tick(1 / 60);

      eq(applied.length, 1, '窗口期内每帧检测，但同一目标只应命中一次');
    });

    test('hitId 唯一（多段技能去重的基础）', () => {
      const { caster, applied } = makeCaster({
        targets: [{ id: 'a', x: 1, y: 0 }, { id: 'b', x: 2, y: 0 }],
      });
      caster.learn({
        id: 'aoe', cooldown: 0, mask: LAYER_ENEMY, hitWindow: 0,
        hitShape: { kind: 'circle', radius: 5 }, damage: { raw: 10 },
      });
      caster.tryCast('aoe', { x: 0, y: 0, facingDeg: 0 });
      caster.tick(0.01);

      eq(applied.length, 2, '两个目标各一次');
      const ids = applied.map((a) => a.hitId);
      eq(new Set(ids).size, 2, 'hitId 必须互不相同');
    });

    test('⚠️ 判定中心默认为施法者（origin=caster）', () => {
      // 敌人在身前 1.5 米。扇形以施法者为中心才能打到
      const { caster, applied } = makeCaster({ targets: [{ id: 'e', x: 1.5, y: 0 }] });
      caster.learn({
        id: 'slash', cooldown: 0, mask: LAYER_ENEMY,
        windup: 0.1, hitDelay: 0.05, hitWindow: 0,
        hitShape: { kind: 'sector', radius: 2.5, angleDeg: 100 },
        damage: { raw: 20 },
      });
      // 瞄准 2 米外（模拟摇杆推满）
      caster.tryCast('slash', { x: 0, y: 0, facingDeg: 0, aimX: 2, aimY: 0 });
      for (let i = 0; i < 30; i++) caster.tick(1 / 60);
      eq(applied.length, 1, '默认应以施法者为中心，身前的敌人在扇形内');
    });

    test('origin=aim 时以落点为中心', () => {
      // 敌人在 8 米外。扇形以施法者为中心（半径 2.5）打不到，
      // 但以落点为中心就能打到
      const { caster, applied } = makeCaster({ targets: [{ id: 'far', x: 8, y: 0 }] });
      caster.learn({
        id: 'meteor', cooldown: 0, mask: LAYER_ENEMY,
        origin: 'aim',
        windup: 0.2, hitDelay: 0, hitWindow: 0,
        hitShape: { kind: 'circle', radius: 3 },
        damage: { raw: 50 },
      });
      caster.tryCast('meteor', { x: 0, y: 0, facingDeg: 0, aimX: 8, aimY: 0 });
      for (let i = 0; i < 30; i++) caster.tick(1 / 60);
      eq(applied.length, 1, '以落点为中心时应命中 8 米外的目标');
    });

    test('origin=caster 时打不到远处（对照组）', () => {
      const { caster, applied } = makeCaster({ targets: [{ id: 'far', x: 8, y: 0 }] });
      caster.learn({
        id: 'meteor', cooldown: 0, mask: LAYER_ENEMY,
        windup: 0.2, hitDelay: 0, hitWindow: 0,
        hitShape: { kind: 'circle', radius: 3 },
        damage: { raw: 50 },
      });
      caster.tryCast('meteor', { x: 0, y: 0, facingDeg: 0, aimX: 8, aimY: 0 });
      for (let i = 0; i < 30; i++) caster.tick(1 / 60);
      eq(applied.length, 0, '以自身为中心、半径 3 打不到 8 米外');
    });

    test('弹道从施法者发射（即使 origin=aim）', () => {
      const { caster, spawned } = makeCaster({ targets: [] });
      caster.learn({
        id: 'arrow', cooldown: 0, mask: LAYER_ENEMY, hitWindow: 0,
        origin: 'aim',
        projectile: { speed: 20, lifetime: 2 },
      });
      caster.tryCast('arrow', { x: 1, y: 2, facingDeg: 0, aimX: 9, aimY: 2 });
      for (let i = 0; i < 5; i++) caster.tick(1 / 60);

      eq(spawned.length, 1);
      // 方向应沿 +X（从施法者指向瞄准点）
      near(spawned[0].dirX, 1, 1e-6, '方向应是从施法者指向瞄准点');
    });

    test('弹道按朝向发射', () => {
      const { caster, spawned } = makeCaster({ targets: [] });
      caster.learn({
        id: 'arrow', cooldown: 0, mask: LAYER_ENEMY, hitWindow: 0,
        projectile: { speed: 20, lifetime: 2 },
      });
      caster.tryCast('arrow', { x: 0, y: 0, facingDeg: 0, aimX: 0, aimY: 5 });
      for (let i = 0; i < 5; i++) caster.tick(1 / 60);

      eq(spawned.length, 1, '应发射一发');
      near(spawned[0].dirY, 1, 1e-6, '瞄准正上方，方向应是 +Y');
      near(spawned[0].dirX, 0, 1e-6);
    });

    test('超出射程失败', () => {
      const { caster } = makeCaster({ targets: [] });
      caster.learn({ id: 's', cooldown: 0, mask: 0, hitWindow: 0, maxRange: 3 });
      const r = caster.tryCast('s', { x: 0, y: 0, facingDeg: 0, aimX: 10, aimY: 0 });
      assert(!r.ok);
      eq(r.reason, 'out-of-range');
    });

    test('未学会的技能返回 unknown-skill', () => {
      const { caster } = makeCaster({ targets: [] });
      const r = caster.tryCast('nope', { x: 0, y: 0, facingDeg: 0 });
      assert(!r.ok);
      eq(r.reason, 'unknown-skill');
    });

    test('cancel 打断施法并可退费', () => {
      const { caster, purse } = makeCaster({ targets: [], resources: { mp: 100 } });
      caster.learn({ id: 's', cooldown: 0, mask: 0, hitWindow: 0, windup: 1, cost: { mp: 40 } });
      caster.tryCast('s', { x: 0, y: 0, facingDeg: 0 });
      eq(purse.mp, 60);

      assert(caster.cancel(true), '应能打断');
      eq(purse.mp, 100, '退费后应还原');
      assert(!caster.busy);
    });

    test('cooldownRatio 用于 UI 转圈', () => {
      const { caster } = makeCaster({ targets: [] });
      caster.learn({ id: 's', cooldown: 1, mask: 0, hitWindow: 0 });
      near(caster.cooldownRatio('s'), 0, 1e-9, '未使用时进度 0');
      caster.tryCast('s', { x: 0, y: 0, facingDeg: 0 });
      near(caster.cooldownRatio('s'), 1, 1e-9, '刚用完是 1');
      for (let i = 0; i < 30; i++) caster.tick(1 / 60);
      near(caster.cooldownRatio('s'), 0.5, 0.02, '半秒后约 0.5');
    });

    test('dt=0 时冷却不推进（暂停生效）', () => {
      const { caster } = makeCaster({ targets: [] });
      caster.learn({ id: 's', cooldown: 1, mask: 0, hitWindow: 0 });
      caster.tryCast('s', { x: 0, y: 0, facingDeg: 0 });
      for (let i = 0; i < 100; i++) caster.tick(0);
      near(caster.cooldownLeft('s'), 1, 1e-9, '暂停期间冷却不应减少');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('InputBuffer · 输入缓冲', () => {
    test('窗口内可消费', () => {
      const buf = new InputBuffer({ window: 0.15 });
      buf.press('attack');
      buf.tick(0.1);
      assert(buf.consume('attack'), '0.1 < 0.15 应可消费');
    });

    test('超窗不可消费', () => {
      const buf = new InputBuffer({ window: 0.15 });
      buf.press('attack');
      buf.tick(0.2);
      assert(!buf.consume('attack'), '0.2 > 0.15 应过期');
    });

    test('消费后不能重复消费', () => {
      const buf = new InputBuffer({ window: 0.15 });
      buf.press('attack');
      assert(buf.consume('attack'));
      assert(!buf.consume('attack'), '同一次输入只能消费一次');
    });

    test('peek 不消费', () => {
      const buf = new InputBuffer({ window: 0.15 });
      buf.press('attack');
      assert(buf.peek('attack'));
      assert(buf.peek('attack'), 'peek 不应清除');
      assert(buf.consume('attack'), '之后仍可消费');
    });

    test('consumeAny 取最早按下的', () => {
      const buf = new InputBuffer({ window: 0.5 });
      buf.tick(0);
      buf.press('b');
      buf.tick(0.05);
      buf.press('a');

      eq(buf.consumeAny(['a', 'b']), 'b', 'b 先按下，应优先消费');
      eq(buf.consumeAny(['a', 'b']), 'a', '然后是 a');
      eq(buf.consumeAny(['a', 'b']), null, '没有了');
    });

    test('consumeAny 跳过已过期的', () => {
      const buf = new InputBuffer({ window: 0.1 });
      buf.press('old');
      buf.tick(0.3);              // old 过期
      buf.press('new');
      eq(buf.consumeAny(['old', 'new']), 'new', '应跳过过期的 old');
    });

    test('pendingCount 反映有效缓冲', () => {
      const buf = new InputBuffer({ window: 0.1 });
      buf.press('a');
      eq(buf.pendingCount, 1);
      buf.tick(0.2);
      eq(buf.pendingCount, 0, '过期后应自动清理');
    });

    test('搓招：连续输入匹配', () => {
      const buf = new InputBuffer({ window: 0.3, maxQueue: 10 });
      buf.press('down');
      buf.tick(0.05);
      buf.press('right');
      buf.tick(0.05);
      buf.press('attack');

      assert(buf.matchSequence(['down', 'right', 'attack']), '应匹配升龙拳指令');
    });

    test('搓招：允许中间有多余输入', () => {
      const buf = new InputBuffer({ window: 0.3, maxQueue: 10 });
      buf.press('down');
      buf.tick(0.03);
      buf.press('down-right');    // 摇杆划过中间方向
      buf.tick(0.03);
      buf.press('right');
      buf.tick(0.03);
      buf.press('attack');

      assert(
        buf.matchSequence(['down', 'right', 'attack']),
        '中间方向不应打断匹配（否则搓招几乎不可能）',
      );
    });

    test('搓招：顺序错误不匹配', () => {
      const buf = new InputBuffer({ window: 0.3, maxQueue: 10 });
      buf.press('attack');
      buf.tick(0.05);
      buf.press('down');
      assert(!buf.matchSequence(['down', 'attack']), '顺序反了不该匹配');
    });

    test('consumeSequence 后清空队列', () => {
      const buf = new InputBuffer({ window: 0.3, maxQueue: 10 });
      buf.press('down');
      buf.press('right');
      buf.press('attack');
      assert(buf.consumeSequence(['down', 'right', 'attack']));
      eq(buf.queue.length, 0, '消费后应清空，避免后续招式被误触发');
    });

    test('注入时间源：时钟不走就不老化（暂停生效）', () => {
      let now = 0;
      const buf = new InputBuffer({ window: 0.15, now: () => now });
      buf.press('attack');

      // 外部时钟没推进 —— 相当于游戏暂停中
      assert(buf.peek('attack'), '暂停期间不应过期');
      assert(buf.consume('attack'), '暂停期间的输入仍应可消费');

      // 时钟推进后才会老化
      buf.press('attack');
      now = 1;
      assert(!buf.consume('attack'), '时钟推进 1 秒后应过期');
    });

    test('CoyoteTimer：离地后短暂仍可跳', () => {
      const c = new CoyoteTimer(0.1);
      c.setGrounded(true);
      c.tick(1 / 60);
      c.setGrounded(false);        // 走出平台
      c.tick(0.05);
      assert(c.canJump(), '离地 0.05 秒内应仍可跳');
    });

    test('CoyoteTimer：超时后不能跳', () => {
      const c = new CoyoteTimer(0.1);
      c.setGrounded(true);
      c.setGrounded(false);
      c.tick(0.2);
      assert(!c.canJump(), '超过 0.1 秒应不能跳');
    });

    test('CoyoteTimer：一次离地只能跳一次', () => {
      const c = new CoyoteTimer(0.1);
      c.setGrounded(true);
      c.setGrounded(false);
      assert(c.consumeJump(), '第一次应成功');
      assert(!c.consumeJump(), '土狼时间只能消费一次，否则能二段跳');
    });

    test('CoyoteTimer：着地后重置', () => {
      const c = new CoyoteTimer(0.1);
      c.setGrounded(true);
      c.setGrounded(false);
      c.consumeJump();
      c.setGrounded(true);         // 落地
      assert(c.canJump(), '落地后应重新可跳');
      assert(c.consumeJump(), '落地后可再跳一次');
      assert(!c.canJump(), '消费后本次跳跃机会用完（防二段跳）');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('DashController · 冲刺', () => {
    test('总距离精确等于配置值', () => {
      const dash = new DashController({ distance: 4, duration: 0.25, cooldown: 0 });
      dash.tryStart(1, 0, 0, 0, 0);
      let x = 0;
      let guard = 0;
      while (dash.active && guard++ < 1000) {
        dash.tick(1 / 60);
        x += dash.deltaX;
      }
      near(x, 4, 1e-6, `总位移应严格等于 4，实际 ${x}`);
    });

    test('任意帧率下总距离一致', () => {
      for (const step of [1 / 30, 1 / 60, 1 / 144]) {
        const dash = new DashController({ distance: 5, duration: 0.25, cooldown: 0 });
        dash.tryStart(1, 0, 0, 0, 0);
        let x = 0;
        let guard = 0;
        while (dash.active && guard++ < 5000) {
          dash.tick(step);
          x += dash.deltaX;
        }
        near(x, 5, 1e-6, `帧步长 ${step.toFixed(4)} 时总距离应仍是 5`);
      }
    });

    test('⚠️ 位移单调递增，不能回缩', () => {
      // 曾经用"末段对位移打折"实现 endBrake，
      // 结果位移先冲到 4.26m 又退回 4.03m —— 终点处抖一下。
      const dash = new DashController({
        distance: 4, duration: 0.25, cooldown: 0, falloff: 2, endBrake: 0.15,
      });
      dash.tryStart(1, 0, 0, 0, 0);
      let x = 0;
      let prev = -Infinity;
      let guard = 0;
      while (guard++ < 500) {
        dash.tick(1 / 240);              // 高频率采样，不放过任何回缩
        if (!dash.active) break;
        x += dash.deltaX;
        assert(x >= prev - 1e-9, `位移不应回缩：${x.toFixed(5)} < ${prev.toFixed(5)}`);
        prev = x;
      }
      near(x, 4, 1e-6, `最终位置应精确等于 4，实际 ${x}`);
    });

    test('前段快后段慢（爆发感）', () => {
      const dash = new DashController({ distance: 4, duration: 0.25, cooldown: 0, falloff: 2 });
      dash.tryStart(1, 0, 0, 0, 0);
      let firstHalf = 0;
      let secondHalf = 0;
      const halfFrames = Math.ceil(0.125 * 60);
      for (let i = 0; i < halfFrames; i++) { dash.tick(1 / 60); firstHalf += dash.deltaX; }
      let guard = 0;
      while (dash.active && guard++ < 100) { dash.tick(1 / 60); secondHalf += dash.deltaX; }

      assert(firstHalf > secondHalf, `前半段应比后半段走得远：${firstHalf.toFixed(2)} vs ${secondHalf.toFixed(2)}`);
    });

    test('无敌帧占比正确', () => {
      const dash = new DashController({ distance: 4, duration: 0.2, invulnerableRatio: 0.7, cooldown: 0 });
      dash.tryStart(1, 0, 0, 0, 0);

      dash.tick(0.05);            // 25%
      assert(dash.invulnerable, '25% 时应无敌');
      dash.tick(0.08);            // 65%
      assert(dash.invulnerable, '65% 时应无敌');
      dash.tick(0.04);            // 85%
      assert(!dash.invulnerable, '85% 时不应无敌（末尾留破绽）');
    });

    test('冷却期间不能冲刺', () => {
      const dash = new DashController({ duration: 0.1, cooldown: 0.5 });
      assert(dash.tryStart(1, 0, 0, 0, 0), '第一次应成功');
      let guard = 0;
      while (dash.active && guard++ < 100) dash.tick(1 / 60);
      assert(!dash.tryStart(1, 0, 0, 0, 0), '冷却中应失败');
    });

    test('双层充能可连冲两次', () => {
      const dash = new DashController({ duration: 0.05, cooldown: 1, charges: 2 });
      assert(dash.tryStart(1, 0, 0, 0, 0));
      let guard = 0;
      while (dash.active && guard++ < 100) dash.tick(1 / 60);
      assert(dash.tryStart(1, 0, 0, 0, 0), '第二层应可用');
      eq(dash.chargesLeft, 0);
    });

    test('零向量方向用 fallbackDeg', () => {
      const dash = new DashController({ duration: 0.1, cooldown: 0 });
      dash.tryStart(0, 0, 90, 0, 0);      // 摇杆没推，角色朝上
      near(dash.dirX, 0, 1e-6, '应朝 +Y');
      near(dash.dirY, 1, 1e-6);
    });

    test('零向量不产生 NaN 位移', () => {
      const dash = new DashController({ duration: 0.1, cooldown: 0 });
      dash.tryStart(0, 0, 0, 0, 0);
      dash.tick(1 / 60);
      assert(Number.isFinite(dash.deltaX) && Number.isFinite(dash.deltaY), '位移不能是 NaN');
    });

    test('冲刺中不能再冲刺', () => {
      const dash = new DashController({ duration: 0.3, cooldown: 0, charges: 5 });
      dash.tryStart(1, 0, 0, 0, 0);
      assert(!dash.tryStart(1, 0, 0, 0, 0), '冲刺中应拒绝');
    });

    test('cancel 中断冲刺', () => {
      const dash = new DashController({ duration: 0.3, cooldown: 0 });
      dash.tryStart(1, 0, 0, 0, 0);
      dash.tick(1 / 60);
      assert(dash.cancel());
      assert(!dash.active);
      eq(dash.deltaX, 0, '中断后不再产生位移');
    });

    test('canCancel 反映是否可打断', () => {
      const dash = new DashController({ duration: 0.3, cooldown: 0 });
      assert(dash.canCancel(), '空闲且有充能时可打断');
      dash.tryStart(1, 0, 0, 0, 0);
      assert(!dash.canCancel(), '冲刺中不能再次打断');
    });

    test('exitVelocity 惯性', () => {
      const d1 = new DashController({ distance: 4, duration: 0.2, exitMomentum: 0.5 });
      d1.tryStart(1, 0, 0, 0, 0);
      near(d1.exitVelocity().x, 10, 1e-6, '(4/0.2)×0.5 = 10');

      const d2 = new DashController({ distance: 4, duration: 0.2, exitMomentum: 0 });
      d2.tryStart(1, 0, 0, 0, 0);
      eq(d2.exitVelocity().x, 0, '急停时无惯性');
    });

    test('progress 单调递增到 1', () => {
      const dash = new DashController({ duration: 0.2, cooldown: 0 });
      dash.tryStart(1, 0, 0, 0, 0);
      let prev = -1;
      let guard = 0;
      while (guard++ < 100) {
        dash.tick(1 / 60);
        if (!dash.active) break;      // 结束后 progress 归 0，不能参与比较
        assert(dash.progress >= prev, '进度不应回退');
        prev = dash.progress;
      }
      assert(prev > 0.8, `冲刺过程中进度应接近 1，实际 ${prev.toFixed(3)}`);
    });

    test('shouldSpawnGhost 按间隔采样', () => {
      assert(!shouldSpawnGhost(0.1, 0, 0.15), '间隔未到');
      assert(shouldSpawnGhost(0.16, 0, 0.15), '间隔已到');
      assert(!shouldSpawnGhost(0.17, 0.16, 0.15), '刚生成过');
    });
  });

  // ══════════════════════════════════════════════════════════
  describe('CameraShake · 震屏', () => {
    test('震动后回到静止', () => {
      const shake = new CameraShake();
      shake.punch({ amplitude: 0.5, duration: 0.3 });
      assert(shake.active);
      for (let i = 0; i < 30; i++) shake.tick(1 / 60);
      assert(!shake.active, '0.5 秒后应已停止');
    });

    test('末尾振幅趋近 0（衰减）', () => {
      const shake = new CameraShake({ decay: 'exp' });
      shake.punch({ amplitude: 1, duration: 0.4 });

      shake.tick(0.05);
      const early = Math.abs(shake.offsetX);
      shake.tick(0.3);
      const late = Math.abs(shake.offsetX);
      assert(late < early, `末尾振幅应更小：${late.toFixed(4)} < ${early.toFixed(4)}`);
    });

    test('strengthScale=0 时完全不震（可访问性）', () => {
      const shake = new CameraShake({ strengthScale: 0 });
      shake.punch({ amplitude: 1, duration: 0.3 });
      shake.tick(1 / 60);
      eq(shake.offsetX, 0, '关闭时偏移必须为 0');
      eq(shake.offsetY, 0);
      assert(!shake.active);
    });

    test('strengthScale 缩放振幅', () => {
      const full = new CameraShake({ strengthScale: 1 });
      const half = new CameraShake({ strengthScale: 0.5 });
      full.punch({ amplitude: 1, duration: 0.3 });
      half.punch({ amplitude: 1, duration: 0.3 });
      full.tick(0.05);
      half.tick(0.05);
      near(Math.abs(half.offsetX), Math.abs(full.offsetX) * 0.5, 1e-6, '应线性缩放');
    });

    test('多震源叠加不失控（受 maxOffset 约束）', () => {
      // 【为什么这样测】
      // 两个震源的噪声 seed 不同，向量相加**可能相互抵消**，
      // 所以"叠加后一定更大"是不成立的。
      // 真正要保证的性质是：叠加再多也不会突破 maxOffset。
      const shake = new CameraShake({ maxOffset: 1 });
      eq(shake.sourceCount, 0);
      shake.punch({ amplitude: 0.6, duration: 0.3 });
      shake.punch({ amplitude: 0.6, duration: 0.3 });
      shake.punch({ amplitude: 0.6, duration: 0.3 });
      eq(shake.sourceCount, 3, '三个震源应都在');

      let maxMag = 0;
      for (let i = 0; i < 20; i++) {
        shake.tick(1 / 60);
        maxMag = Math.max(maxMag, Math.hypot(shake.offsetX, shake.offsetY));
      }
      assert(maxMag <= 1 + 1e-9, `三源叠加不应超过 maxOffset，实际 ${maxMag.toFixed(3)}`);
    });

    test('maxOffset 上限防相机飞出屏幕', () => {
      const shake = new CameraShake({ maxOffset: 1 });
      for (let i = 0; i < 20; i++) shake.punch({ amplitude: 5, duration: 0.5 });
      shake.tick(1 / 60);
      const mag = Math.hypot(shake.offsetX, shake.offsetY);
      assert(mag <= 1 + 1e-9, `偏移不应超过 maxOffset，实际 ${mag.toFixed(3)}`);
    });

    test('确定性：同样输入产出同样轨迹', () => {
      const run = () => {
        const s = new CameraShake();
        s.punch({ amplitude: 0.5, duration: 0.3 });
        const out: number[] = [];
        for (let i = 0; i < 10; i++) { s.tick(1 / 60); out.push(s.offsetX); }
        return out;
      };
      const a = run();
      const b = run();
      for (let i = 0; i < a.length; i++) {
        near(a[i], b[i], 1e-12, `第 ${i} 帧应完全一致`);
      }
    });

    test('方向性震动沿指定方向', () => {
      const shake = new CameraShake();
      shake.punch({ amplitude: 1, duration: 0.3, dirX: 1, dirY: 0 });
      // 采样几帧，主偏移应在 X 方向
      let sumX = 0;
      let sumY = 0;
      for (let i = 0; i < 10; i++) {
        shake.tick(1 / 60);
        sumX += Math.abs(shake.offsetX);
        sumY += Math.abs(shake.offsetY);
      }
      assert(sumX > sumY, `方向性震动应以 X 为主：${sumX.toFixed(3)} vs ${sumY.toFixed(3)}`);
    });

    test('stop 立即归零', () => {
      const shake = new CameraShake();
      shake.punch({ amplitude: 1, duration: 1 });
      shake.tick(1 / 60);
      shake.stop();
      eq(shake.offsetX, 0);
      eq(shake.offsetY, 0);
      eq(shake.sourceCount, 0);
    });

    test('dt=0 时不推进', () => {
      const shake = new CameraShake();
      shake.punch({ amplitude: 1, duration: 0.3 });
      for (let i = 0; i < 100; i++) shake.tick(0);
      eq(shake.sourceCount, 1, '震源不应消失');
    });

    test('预设可用且量级递增', () => {
      const shake = new CameraShake();
      applyShakePreset(shake, 'lightHit');
      applyShakePreset(shake, 'crit');
      applyShakePreset(shake, 'explosion');
      eq(shake.sourceCount, 3, '三个预设都应生效');
      assert(SHAKE_PRESETS.explosion.amplitude > SHAKE_PRESETS.lightHit.amplitude, '爆炸应比轻击强');
    });
  });
}
