/**
 * 第十九批测试：collision + mover
 */
import {
  describe, test, assert, eq, near, throws,
} from './_framework';
import {
  circle, aabb, obb, capsule,
  circleCircle, circleAabb, aabbAabb, circleCapsule, intersects,
  satOverlap, sweepCircleAabb, moveAndSlide, separate,
  raycastAabb, raycastCircle, raycast,
  makeCollider, canCollide, CollisionGrid, LAYER,
  closestPointOnSegment, distSqPointSegment, boundingRadius,
  type Collider, type AabbShape,
} from '../collision/Collision';
import {
  CharacterMover, MoverPresets, clampSpeed,
  type IMoveSolver,
} from '../mover/CharacterMover';

export function runBatch20Tests(): void {
  describe('Collision · 基础几何', () => {
    test('点到线段最近点：垂足在段内', () => {
      const out = { x: 0, y: 0 };
      closestPointOnSegment(5, 10, 0, 0, 10, 0, out);
      near(out.x, 5, 1e-9); near(out.y, 0, 1e-9);
    });

    test('点到线段最近点：垂足在段外（夹到端点）', () => {
      const out = { x: 0, y: 0 };
      closestPointOnSegment(-5, 3, 0, 0, 10, 0, out);
      near(out.x, 0, 1e-9); near(out.y, 0, 1e-9);
    });

    test('⚠️ 退化线段（长度为 0）不能产生 NaN', () => {
      const out = { x: 0, y: 0 };
      closestPointOnSegment(3, 4, 1, 1, 1, 1, out);
      assert(Number.isFinite(out.x) && Number.isFinite(out.y), '不能是 NaN');
      near(out.x, 1, 1e-9); near(out.y, 1, 1e-9);
    });

    test('点到线段距离平方', () => {
      near(distSqPointSegment(5, 5, 0, 0, 10, 0), 25, 1e-9);
    });

    test('包围圆半径', () => {
      near(boundingRadius(circle(0, 0, 5)), 5, 1e-9);
      near(boundingRadius(aabb(0, 0, 3, 4)), 5, 1e-9);
    });
  });

  describe('Collision · 相交测试', () => {
    test('圆 vs 圆：相交与分离', () => {
      assert(circleCircle(circle(0, 0, 5), circle(8, 0, 5)));
      assert(!circleCircle(circle(0, 0, 5), circle(11, 0, 5)));
    });

    test('圆 vs 圆：刚好相切算相交（<= 不是 <）', () => {
      assert(circleCircle(circle(0, 0, 5), circle(10, 0, 5)),
        '边界接触应算相交，否则角色能站进墙里');
    });

    test('AABB vs AABB', () => {
      assert(aabbAabb(aabb(0, 0, 5, 5), aabb(8, 0, 5, 5)));
      assert(!aabbAabb(aabb(0, 0, 5, 5), aabb(11, 0, 5, 5)));
    });

    test('AABB vs AABB：边贴边算相交', () => {
      assert(aabbAabb(aabb(0, 0, 5, 5), aabb(10, 0, 5, 5)));
    });

    test('圆 vs AABB：圆心在矩形内', () => {
      assert(circleAabb(circle(0, 0, 1), aabb(0, 0, 10, 10)));
    });

    test('圆 vs AABB：角落外侧（只判边会漏）', () => {
      // 圆心在 (11, 11)，矩形半宽 10 → 最近角是 (10,10)，距离 √2 ≈ 1.414
      assert(circleAabb(circle(11, 11, 2), aabb(0, 0, 10, 10)), '半径 2 > 1.414，应相交');
      assert(!circleAabb(circle(11, 11, 1), aabb(0, 0, 10, 10)), '半径 1 < 1.414，不相交');
    });

    test('圆 vs 胶囊', () => {
      const cap = capsule(0, 0, 0, 10, 2);
      assert(circleCapsule(circle(0, 5, 3), cap), '贴着线段中段');
      assert(circleCapsule(circle(0, 12, 3), cap), '超出端点但靠近端点圆');
      assert(!circleCapsule(circle(10, 5, 3), cap));
    });

    test('通用分派：obb vs circle 走 SAT', () => {
      assert(intersects(obb(0, 0, 5, 1, 0), circle(0, 0, 1)));
      assert(!intersects(obb(0, 0, 5, 1, 0), circle(0, 10, 1)));
    });
  });

  describe('Collision · SAT 与 MTV', () => {
    test('分离的两个矩形', () => {
      const r = satOverlap([-1, -1, 1, -1, 1, 1, -1, 1], [5, -1, 7, -1, 7, 1, 5, 1]);
      eq(r.overlap, false);
    });

    test('重叠的两个矩形：MTV 指向正确', () => {
      // A 在原点 2×2，B 在 (1.5, 0) 2×2 → 沿 +X 重叠 0.5
      const r = satOverlap(
        [-1, -1, 1, -1, 1, 1, -1, 1],
        [0.5, -1, 2.5, -1, 2.5, 1, 0.5, 1]
      );
      assert(r.overlap);
      near(r.depth, 0.5, 1e-6);
      // 把 A 推离 B，应该往 -X
      near(r.mtvX, -1, 1e-6);
      near(Math.abs(r.mtvY), 0, 1e-6);
    });

    test('⚠️ MTV 取最小重叠轴，不是最大', () => {
      // 一个很扁的矩形横穿一个高矩形：X 方向重叠 10，Y 方向重叠 0.2
      // 最小重叠是 Y（0.2），应该沿 Y 推开——沿 X 推会把物体弹到另一边
      const a = [-5, -0.1, 5, -0.1, 5, 0.1, -5, 0.1];
      const b = [-1, -2, 1, -2, 1, 2, -1, 2];
      const r = satOverlap(a, b);
      assert(r.overlap);
      assert(Math.abs(r.mtvX) < 1e-6, `应沿 Y 推开，实际 mtvX=${r.mtvX}`);
      near(Math.abs(r.mtvY), 1, 1e-6);
    });

    test('⚠️ 边贴边算重叠（用 <= 不是 <）', () => {
      const r = satOverlap(
        [-1, -1, 1, -1, 1, 1, -1, 1],
        [1, -1, 3, -1, 3, 1, 1, 1]
      );
      eq(r.overlap, true, '刚好接触必须是真，否则能穿墙');
    });

    test('轴去重：矩形只有 2 条独立轴', () => {
      const r = satOverlap([-1, -1, 1, -1, 1, 1, -1, 1], [0, 0, 2, 0, 2, 2, 0, 2]);
      assert(r.overlap);
      assert(r.depth > 0);
    });
  });

  describe('Collision · 扫掠（防穿墙）', () => {
    const wall: AabbShape = aabb(100, 0, 5, 50);   // x: 95~105

    test('慢速命中', () => {
      const r = sweepCircleAabb(0, 0, 1, 200, 0, wall);
      assert(r.hit);
      near(r.t, 94 / 200, 1e-6);
      near(r.nx, -1, 1e-9, '法线应指向 -X（往回退）');
    });

    test('⚠️ 高速穿墙：一帧跨过整面墙也能命中', () => {
      // 从 x=0 一帧跳到 x=1000，墙在 95~105
      // 逐帧点检测会完全漏掉（起点终点都在墙外）
      const r = sweepCircleAabb(0, 0, 1, 1000, 0, wall);
      assert(r.hit, 'sweep 必须能捕获高速穿越');
      near(r.t, 94 / 1000, 1e-6);
    });

    test('不命中：平行方向', () => {
      const r = sweepCircleAabb(0, 0, 1, 0, 1000, wall);
      eq(r.hit, false);
    });

    test('起点已在内部：t=0，法线取最浅的面', () => {
      const r = sweepCircleAabb(96, 0, 1, 10, 0, wall);
      assert(r.hit);
      near(r.t, 0, 1e-9);
      near(r.nx, -1, 1e-9, '离左边界更近，应往 -X 推');
    });

    test('位移为零且不重叠', () => {
      const r = sweepCircleAabb(0, 0, 1, 0, 0, wall);
      eq(r.hit, false);
    });
  });

  describe('Collision · moveAndSlide', () => {
    const walls: Collider[] = [
      makeCollider(1, aabb(100, 0, 5, 50), { layer: LAYER.WALL }),
    ];

    test('无碰撞时走完整个位移', () => {
      const r = moveAndSlide(0, 0, 1, 10, 0, walls);
      eq(r.collided, false);
      near(r.x, 10, 1e-6);
    });

    test('正面撞墙：停在墙前', () => {
      const r = moveAndSlide(0, 0, 1, 200, 0, walls);
      eq(r.collided, true);
      assert(r.x < 95, `应停在墙前，实际 x=${r.x}`);
      assert(r.x > 90, '不该停在离墙很远的地方');
    });

    test('⚠️ 斜向撞墙要沿墙滑动，不能停住', () => {
      // 朝右上方 45° 移动，右侧有墙
      // 正确行为：X 被挡住，但 Y 分量应该保留 → 沿墙向上滑
      const r = moveAndSlide(80, 0, 1, 100, 100, walls);
      eq(r.collided, true);
      assert(r.y > 50, `Y 分量应保留（沿墙滑动），实际 y=${r.y}`);
      // X 应被限制在墙附近
      assert(r.x < 95, `X 应被挡住，实际 x=${r.x}`);
    });

    test('⚠️ 内角不卡死（迭代上限生效）', () => {
      // 右墙 x:70~80 (y: 0~100)，上墙 y:70~80 (x: 0~100)
      // 两墙在 (70~80, 70~80) 形成一个内角
      const corner: Collider[] = [
        makeCollider(1, aabb(75, 50, 5, 50), { layer: LAYER.WALL }),
        makeCollider(2, aabb(50, 75, 50, 5), { layer: LAYER.WALL }),
      ];
      // 从 (60, 60) 朝内角猛冲：会被两面墙同时挡住
      const r = moveAndSlide(60, 60, 1, 100, 100, corner);
      assert(Number.isFinite(r.x) && Number.isFinite(r.y), '不能产生 NaN');
      eq(r.collided, true, '应撞到内角');
      assert(r.x < 70, `X 应被右墙挡住，实际 ${r.x}`);
      assert(r.y < 70, `Y 应被上墙挡住，实际 ${r.y}`);
      // 关键：不能因为反复投影而退化到原地（卡死的表现）
      assert(r.x > 60 && r.y > 60, `内角应该能滑进去一些，而不是停在起点：(${r.x}, ${r.y})`);
    });

    test('trigger 不阻挡', () => {
      const trig: Collider[] = [
        makeCollider(1, aabb(50, 0, 5, 50), { layer: LAYER.WALL, trigger: true }),
      ];
      const r = moveAndSlide(0, 0, 1, 200, 0, trig);
      eq(r.collided, false, 'trigger 应被跳过');
      near(r.x, 200, 1e-6);
    });

    test('层过滤：mask 不认就不撞', () => {
      const r = moveAndSlide(0, 0, 1, 200, 0, walls, {
        mask: LAYER.PLAYER,   // 墙的 layer 是 WALL，不匹配
      });
      eq(r.collided, false);
    });

    test('⚠️ 极高速也不穿墙（sweep 的价值）', () => {
      const r = moveAndSlide(0, 0, 1, 10000, 0, walls);
      eq(r.collided, true);
      assert(r.x < 95, `10 倍墙厚的高速也不能穿过，实际 x=${r.x}`);
    });

    test('接触法线正确', () => {
      const r = moveAndSlide(0, 0, 1, 200, 0, walls);
      near(r.nx, -1, 1e-6);
      near(r.ny, 0, 1e-6);
      eq(r.hits.length, 1);
      eq(r.hits[0]!, 1);
    });
  });

  describe('Collision · 静态分离', () => {
    test('把陷在墙里的角色挤出来', () => {
      const walls: Collider[] = [makeCollider(1, aabb(0, 0, 50, 50))];
      const r = separate(49, 0, 1, walls);
      eq(r.moved, true);
      // 应该被推到 x >= 51（矩形右边界 50 + 半径 1 + skin）
      assert(r.x > 50, `应被推出墙外，实际 x=${r.x}`);
    });

    test('没重叠时不移动', () => {
      const walls: Collider[] = [makeCollider(1, aabb(0, 0, 5, 5))];
      const r = separate(100, 100, 1, walls);
      eq(r.moved, false);
      near(r.x, 100, 1e-9);
    });

    test('⚠️ 同时贴两面墙时取最深的推，不累加', () => {
      const walls: Collider[] = [
        makeCollider(1, aabb(0, 0, 10, 10)),
        makeCollider(2, aabb(15, 0, 10, 10)),
      ];
      // 角色在两墙之间且同时嵌入两边
      const r = separate(7, 0, 3, walls);
      eq(r.moved, true);
      assert(Number.isFinite(r.x), '不能是 NaN');
      // 累加的话会被推两倍距离弹飞，这里验证没有被推到荒谬的位置
      assert(Math.abs(r.x) < 100, `不该被弹飞，实际 x=${r.x}`);
    });

    test('圆心正好在矩形内时也能推出', () => {
      const walls: Collider[] = [makeCollider(1, aabb(0, 0, 10, 10))];
      const r = separate(0, 0, 1, walls);   // 正中心
      eq(r.moved, true);
      assert(Number.isFinite(r.x) && Number.isFinite(r.y));
    });
  });

  describe('Collision · 射线投射', () => {
    test('射线命中 AABB', () => {
      const h = raycastAabb(0, 0, 1, 0, aabb(50, 0, 5, 50));
      assert(h.hit);
      near(h.t, 45, 1e-6);
      near(h.nx, -1, 1e-9);
    });

    test('射线未命中（平行）', () => {
      const h = raycastAabb(-100, 0, 1, 0, aabb(0, 100, 5, 5));
      eq(h.hit, false);
    });

    test('射线命中圆', () => {
      const h = raycastCircle(0, 0, 1, 0, circle(50, 0, 5));
      assert(h.hit);
      near(h.t, 45, 1e-6);
    });

    test('⚠️ 射线未命中圆时判别式为负，不能抛异常', () => {
      let threw = false;
      try {
        raycastCircle(0, 0, 1, 0, circle(0, 100, 5));
      } catch {
        threw = true;
      }
      eq(threw, false, '打不中只是"没打中"，不是错误');
    });

    test('起点在圆内：返回第二个交点', () => {
      const h = raycastCircle(50, 0, 1, 0, circle(50, 0, 5));
      assert(h.hit);
      near(h.t, 5, 1e-6);
    });

    test('多目标取最近', () => {
      const solids: Collider[] = [
        makeCollider(1, circle(100, 0, 5)),
        makeCollider(2, circle(50, 0, 5)),
      ];
      const h = raycast(0, 0, 1, 0, solids);
      eq(h.colliderId, 2, '应命中更近的那个');
      near(h.t, 45, 1e-6);
    });

    test('maxDist 限制', () => {
      const solids: Collider[] = [makeCollider(1, circle(100, 0, 5))];
      eq(raycast(0, 0, 1, 0, solids, 10).hit, false);
      assert(raycast(0, 0, 1, 0, solids, 200).hit);
    });
  });

  describe('Collision · 碰撞体与网格', () => {
    test('层掩码双向匹配', () => {
      const player = makeCollider(1, circle(0, 0, 1), {
        layer: LAYER.PLAYER, mask: LAYER.WALL | LAYER.ENEMY,
      });
      const wall = makeCollider(2, aabb(0, 0, 1, 1), { layer: LAYER.WALL });
      const pickup = makeCollider(3, circle(0, 0, 1), { layer: LAYER.PICKUP });
      assert(canCollide(player, wall));
      assert(!canCollide(player, pickup), '玩家的 mask 不认 PICKUP');
    });

    test('网格插入与查询', () => {
      const g = new CollisionGrid(64);
      g.insert(makeCollider(1, circle(10, 10, 5)));
      g.insert(makeCollider(2, circle(500, 500, 5)));
      const found = g.query(10, 10, 20);
      eq(found.some((c) => c.id === 1), true);
      eq(found.some((c) => c.id === 2), false, '远处的对象不该被返回');
    });

    test('⚠️ 跨格子的碰撞体在查询中只出现一次', () => {
      const g = new CollisionGrid(10);
      // 半径 25 的圆必然跨越多个格子
      g.insert(makeCollider(1, circle(50, 50, 25)));
      const found = g.query(50, 50, 30);
      eq(found.filter((c) => c.id === 1).length, 1, '去重失败会导致分离力翻倍 → 抖动');
    });

    test('⚠️ cellSize 必须为正', () => {
      throws(() => new CollisionGrid(0), '必须为正');
      throws(() => new CollisionGrid(-1), '必须为正');
    });
  });

  describe('Mover · 基础移动', () => {
    test('朝一个方向移动', () => {
      const m = new CharacterMover({ maxSpeed: 10, accel: 100, decel: 100 });
      for (let i = 0; i < 60; i++) m.update(1 / 60, 1, 0);
      assert(m.x > 5, `一秒后应移动约 10，实际 ${m.x}`);
      near(m.speed, 10, 0.5);
    });

    test('⚠️ 斜向输入不能比直行快（归一化）', () => {
      const straight = new CharacterMover({ maxSpeed: 10, accel: 100 });
      const diagonal = new CharacterMover({ maxSpeed: 10, accel: 100 });
      for (let i = 0; i < 120; i++) {
        straight.update(1 / 60, 1, 0);
        diagonal.update(1 / 60, 1, 1);   // 未归一化！
      }
      const ratio = diagonal.speed / straight.speed;
      assert(ratio < 1.05, `斜向不该更快，比例 ${ratio.toFixed(3)}（1.414 就是没归一化）`);
    });

    test('松开输入后减速到完全静止', () => {
      const m = new CharacterMover({ maxSpeed: 10, accel: 100, decel: 100 });
      for (let i = 0; i < 60; i++) m.update(1 / 60, 1, 0);
      assert(m.speed > 5);
      for (let i = 0; i < 120; i++) m.update(1 / 60, 0, 0);
      eq(m.speed, 0, '必须精确归零，否则角色会永远微微漂移');
    });

    test('⚠️ 减速比加速快（decel > accel 的效果）', () => {
      const m = new CharacterMover({ maxSpeed: 10, accel: 20, decel: 100 });
      // 加速到最高速
      for (let i = 0; i < 300; i++) m.update(1 / 60, 1, 0);
      near(m.speed, 10, 0.1);
      // 刹车
      let frames = 0;
      while (m.speed > 0.01 && frames < 600) { m.update(1 / 60, 0, 0); frames++; }
      assert(frames < 60, `刹车应明显快于起步，用了 ${frames} 帧`);
    });

    test('转身比起步快（turnBoost）', () => {
      const withBoost = new CharacterMover({ maxSpeed: 10, accel: 40, turnBoost: 5 });
      const without = new CharacterMover({ maxSpeed: 10, accel: 40, turnBoost: 1 });
      for (const m of [withBoost, without]) {
        for (let i = 0; i < 200; i++) m.update(1 / 60, 1, 0);
      }
      near(withBoost.speed, 10, 0.1);
      // 开始掉头，各跑 10 帧看谁更快反向
      for (let i = 0; i < 10; i++) { withBoost.update(1 / 60, -1, 0); without.update(1 / 60, -1, 0); }
      assert(withBoost.vx < without.vx, `有 turnBoost 应掉头更快：${withBoost.vx} vs ${without.vx}`);
    });

    test('dt=0 不推进', () => {
      const m = new CharacterMover();
      m.update(0, 1, 0);
      eq(m.x, 0);
      eq(m.speed, 0);
    });

    test('朝向跟随移动方向', () => {
      const m = new CharacterMover({ maxSpeed: 10, accel: 100 });
      for (let i = 0; i < 60; i++) m.update(1 / 60, 0, 1);
      near(m.facing, Math.PI / 2, 0.1);
    });
  });

  describe('Mover · 外力与击退', () => {
    test('击退会推动角色', () => {
      const m = new CharacterMover({ maxSpeed: 10 });
      m.addImpulse(50, 0);
      const x0 = m.x;
      for (let i = 0; i < 30; i++) m.update(1 / 60, 0, 0);
      assert(m.x > x0 + 5, `应被明显推开，位移 ${m.x - x0}`);
    });

    test('⚠️ 外力会衰减到 0（不衰减会永远漂）', () => {
      const m = new CharacterMover({ maxSpeed: 10, externalDamping: 8 });
      m.addImpulse(50, 0);
      for (let i = 0; i < 300; i++) m.update(1 / 60, 0, 0);
      eq(m.externalSpeed, 0, '外力必须衰减干净');
      eq(m.knocked, false, '击退态应自动解除');
    });

    test('⚠️ 连续击退不会叠成火箭（强度上限）', () => {
      const m = new CharacterMover({ maxSpeed: 10 });
      for (let i = 0; i < 20; i++) m.addImpulse(30, 0, 40);   // 上限 40
      assert(m.externalSpeed <= 40.001, `应被限制在 40，实际 ${m.externalSpeed}`);
    });

    test('击退期间输入权重降低', () => {
      const m = new CharacterMover({ maxSpeed: 10, accel: 200, knockbackControl: 0 });
      m.addImpulse(0, 50);   // 向上击退
      // 同时全力向右输入
      for (let i = 0; i < 10; i++) m.update(1 / 60, 1, 0);
      assert(Math.abs(m.vx) < 1, `knockbackControl=0 时输入应无效，实际 vx=${m.vx}`);
    });

    test('击退结束后恢复控制', () => {
      const m = new CharacterMover({ maxSpeed: 10, accel: 200, knockbackControl: 0 });
      m.addImpulse(0, 20);
      for (let i = 0; i < 300; i++) m.update(1 / 60, 1, 0);
      eq(m.knocked, false);
      for (let i = 0; i < 60; i++) m.update(1 / 60, 1, 0);
      near(m.vx, 10, 0.5, '解除击退后应能正常加速');
    });

    test('⚠️ 击退态解除用体感阈值，不是数值归零', () => {
      /**
       * externalDamping=6 时，冲量 30 衰减到 0.01 需要约 1.33 秒。
       * 但外力剩 0.07 时角色每秒只移动 0.07 像素，已完全不可感知——
       * 如果那时还锁着控制权，玩家会觉得"被打之后有 1 秒操作不灵"。
       *
       * 所以解除击退的阈值是 maxSpeed 的 25%（这里 = 2.5），
       * 而不是 stopEpsilon（0.01）。
       */
      const m = new CharacterMover({
        maxSpeed: 10, externalDamping: 6, stopEpsilon: 0.01,
      });
      m.addImpulse(30, 0);

      // 找到击退态解除的那一刻
      let frames = 0;
      while (m.knocked && frames < 600) { m.update(1 / 60, 0, 0); frames++; }

      const tRelease = frames / 60;
      assert(tRelease < 0.5, `击退态应在 0.5 秒内解除，实际 ${tRelease.toFixed(2)}s`);

      // 解除时外力应还明显大于 0（说明没等到数值归零才解除）
      const exAtRelease = m.externalSpeed;
      assert(exAtRelease > 1,
        `解除时外力应仍可感知（>1），实际 ${exAtRelease.toFixed(3)}——` +
        `若接近 0 说明还在用 stopEpsilon 判解除`);

      // 外力最终仍要归零
      while (m.externalSpeed > 0 && frames < 900) { m.update(1 / 60, 0, 0); frames++; }
      eq(m.externalSpeed, 0, '外力最终必须精确归零');
    });

    test('clearImpulse 立即清空', () => {
      const m = new CharacterMover();
      m.addImpulse(100, 0);
      assert(m.hasExternal);
      m.clearImpulse();
      eq(m.externalSpeed, 0);
      eq(m.knocked, false);
    });
  });

  describe('Mover · 碰撞配合', () => {
    /** 一堵在 x=10 的墙 */
    const wallSolver: IMoveSolver = {
      move(x, y, dx, dy) {
        const nx = x + dx;
        if (nx > 10) return { x: 10, y: y + dy, collided: true, nx: -1, ny: 0 };
        return { x: nx, y: y + dy, collided: false, nx: 0, ny: 0 };
      },
    };

    test('撞墙后停止', () => {
      const m = new CharacterMover({ maxSpeed: 10, accel: 100, solver: wallSolver });
      for (let i = 0; i < 300; i++) m.update(1 / 60, 1, 0);
      assert(m.x <= 10.001, `不该穿过 x=10，实际 ${m.x}`);
      eq(m.blocked, true);
    });

    test('⚠️ 撞墙后速度必须投影掉，否则离开墙时会弹射', () => {
      const m = new CharacterMover({ maxSpeed: 10, accel: 100, solver: wallSolver });
      // 一直顶着墙推 5 秒
      for (let i = 0; i < 300; i++) m.update(1 / 60, 1, 0);
      // 若不投影，此时 vx 已经累积到很大（速度一直涨但位移是 0）
      assert(Math.abs(m.vx) < 1, `贴墙时速度应被投影掉，实际 vx=${m.vx}`);
    });

    test('沿墙滑动：斜向推墙时 Y 方向仍能动', () => {
      const m = new CharacterMover({ maxSpeed: 10, accel: 100, solver: wallSolver });
      // 先贴到墙上
      for (let i = 0; i < 200; i++) m.update(1 / 60, 1, 0);
      const xAtWall = m.x;
      // 再朝右上推
      for (let i = 0; i < 120; i++) m.update(1 / 60, 1, 1);
      assert(m.y > 5, `应能沿墙向上滑，实际 y=${m.y}`);
      near(m.x, xAtWall, 0.1, 'X 应仍被挡住');
    });

    test('外力也会被墙投影（不会被按在墙上持续施力）', () => {
      const m = new CharacterMover({ solver: wallSolver });
      m.addImpulse(100, 0);   // 朝墙的方向猛推
      for (let i = 0; i < 60; i++) m.update(1 / 60, 0, 0);
      assert(m.x <= 10.001);
      assert(m.externalSpeed < 50, `朝墙的外力分量应被削掉，实际 ${m.externalSpeed}`);
    });
  });

  describe('Mover · 与 Dash 配合', () => {
    test('moveBy 绕过加速度限制（冲刺可超速）', () => {
      const m = new CharacterMover({ maxSpeed: 5 });
      m.moveBy(100, 0, 1 / 60);
      near(m.x, 100 / 60, 1e-6, '不应被 maxSpeed 限制');
    });

    test('冲刺撞墙时速度被投影', () => {
      const solver: IMoveSolver = {
        move(x, y, dx) {
          if (x + dx > 10) return { x: 10, y, collided: true, nx: -1, ny: 0 };
          return { x: x + dx, y, collided: false, nx: 0, ny: 0 };
        },
      };
      const m = new CharacterMover({ solver });
      // 【⚠️ 必须先靠近墙】
      // 一帧的位移是 100/60 ≈ 1.67，从 x=0 出发根本够不到 x=10 的墙。
      // 第一版测试就是这么写的，于是"撞墙"从未发生，
      // 断言 `blocked === true` 失败时才暴露出来。
      m.teleport(9.5, 0);
      m.moveBy(100, 0, 1 / 60);
      eq(m.blocked, true);
      assert(m.vx <= 0.001, `正朝墙的分量应清零，实际 vx=${m.vx}`);
      near(m.x, 10, 1e-6, '应停在墙面上');
    });

    test('clampSpeed 按比例缩放，不变方形', () => {
      const [x, y] = clampSpeed(10, 10, 5);
      near(Math.sqrt(x * x + y * y), 5, 1e-6, '长度应等于上限');
      near(x, y, 1e-9, '方向应保持 45°（分别 clamp 会得到 (5,5)，长度 7.07）');
    });
  });

  describe('Mover · 配置校验与预设', () => {
    test('⚠️ 非法参数在构造时抛错（不是静默失效）', () => {
      throws(() => new CharacterMover({ maxSpeed: 0 }), '必须为正');
      throws(() => new CharacterMover({ accel: 0 }), '必须为正');
      throws(() => new CharacterMover({ decel: -1 }), '必须为正');
    });

    test('四种预设都能跑', () => {
      for (const [name, make] of Object.entries(MoverPresets)) {
        const m = new CharacterMover({ ...(make as () => object)(), maxSpeed: 6 });
        for (let i = 0; i < 60; i++) m.update(1 / 60, 1, 0);
        assert(Number.isFinite(m.x) && m.x > 0, `预设 ${name} 应能移动`);
      }
    });

    test('瞬移会清空速度', () => {
      const m = new CharacterMover();
      for (let i = 0; i < 60; i++) m.update(1 / 60, 1, 0);
      m.teleport(100, 100);
      eq(m.x, 100); eq(m.y, 100);
      eq(m.speed, 0);
      eq(m.externalSpeed, 0);
    });

    test('stop 只清速度不清位置', () => {
      const m = new CharacterMover();
      for (let i = 0; i < 60; i++) m.update(1 / 60, 1, 0);
      const x = m.x;
      m.stop();
      eq(m.x, x);
      eq(m.speed, 0);
    });

    test('describe 可读', () => {
      const m = new CharacterMover();
      const s = m.describe();
      assert(s.includes('位置') && s.includes('速度'));
    });
  });
}
