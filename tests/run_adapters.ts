/**
 * adapters 测试
 *
 * 【测试重点】
 * 适配器做的是"格式翻译"，而翻译错误**不会抛异常**——
 * 只会让下游拿到 undefined 或错误的数字。
 * 所以这里的断言大多不是"能不能跑"，而是"值对不对"。
 */

import { describe, test, eq, near } from './_framework';
import {
  toGrid2D, toFlatGrid, wallTestFrom2D,
  toCasterHits, nearestCasterHits, uniqueEntityHits,
  flattenDrops, applyDropsToInventory,
  type ITileSource, type IHitLike, type ILootDropLike,
} from '../adapters/Adapters';

export function runAdapterTests(): void {
  // ============================================================
  describe('Adapters · 地牢 → 二维数组', () => {
    test('toGrid2D 行列顺序正确', () => {
      /**
       * 【⚠️ 为什么要测这个】
       * 一维索引是 `y * w + x`，转成二维时写成 `out[x][y]` 是极常见的错误。
       * 地图是正方形时**完全看不出问题**（41×41 转置后仍是 41×41），
       * 只有长宽不等时才暴露——而那时症状是"寻路在竖直方向错乱"，
       * 很容易被误判成 A* 的 bug。
       */
      const src: ITileSource = {
        width: 3,
        height: 2,
        tileAt: (x, y) => y * 10 + x,
      };
      const g = toGrid2D(src);
      eq(g.length, 2, '行数 = height');
      eq(g[0].length, 3, '列数 = width');
      eq(g[0][0], 0, '[0][0]');
      eq(g[0][2], 2, '[0][2] 应为 x=2');
      eq(g[1][0], 10, '[1][0] 应为 y=1,x=0 → 10');
      eq(g[1][2], 12, '[1][2]');
    });

    test('⚠️ 非正方形地图能区分转置错误', () => {
      // 宽 5 高 2：转置后尺寸就不对，一测即出
      const src: ITileSource = { width: 5, height: 2, tileAt: (_x, y) => (y === 0 ? 1 : 2) };
      const g = toGrid2D(src);
      eq(g.length, 2, '行数必须是 height=2');
      eq(g[0].length, 5, '列数必须是 width=5');
      eq(g[1][4], 2, '右下角');
    });

    test('toFlatGrid 索引顺序与 tileAt 一致', () => {
      const src: ITileSource = { width: 4, height: 3, tileAt: (x, y) => y * 4 + x };
      const flat = toFlatGrid(src);
      eq(flat.length, 12, '长度 = w*h');
      eq(flat[0], 0, '[0]');
      eq(flat[5], 5, '[5] = y1x1 = 1*4+1');
      eq(flat[11], 11, '[11] = y2x3');
    });

    test('⚠️ wallTestFrom2D 越界算墙（最容易漏的一条）', () => {
      /**
       * 【为什么必须测】
       * 自己写 wall test 时，越界这一句最常被漏掉。
       * 漏了的表现是"视野/寻路从地图边缘漏出去"——
       * 只在边缘发生，且看起来像渲染问题。
       */
      const grid = [[1, 1], [1, 1]];
      const isWall = wallTestFrom2D(grid, [0]);
      eq(isWall(0, 0), false, '地板不是墙');
      eq(isWall(-1, 0), true, '左越界 → 墙');
      eq(isWall(0, -1), true, '上越界 → 墙');
      eq(isWall(2, 0), true, '右越界 → 墙');
      eq(isWall(0, 2), true, '下越界 → 墙');
    });

    test('wallTestFrom2D 行长不齐时也算墙（不能崩）', () => {
      const grid: number[][] = [[1, 1, 1], [1]];
      const isWall = wallTestFrom2D(grid, [0]);
      eq(isWall(0, 1), false, '第 1 行第 0 列存在');
      eq(isWall(1, 1), true, '第 1 行第 1 列不存在 → 墙');
    });

    test('⚠️ 一维源与二维结果的一致性', () => {
      // 同一份数据，两条路径必须给出相同答案
      const w = 7;
      const h = 4;
      const data = new Uint8Array(w * h);
      for (let i = 0; i < data.length; i++) data[i] = i % 3 === 0 ? 0 : 1;

      const src: ITileSource = {
        width: w,
        height: h,
        tileAt: (x, y) => {
          if (x < 0 || y < 0 || x >= w || y >= h) return 0;
          return data[y * w + x];
        },
      };

      const g2 = toGrid2D(src);
      const flat = toFlatGrid(src);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          eq(g2[y][x], flat[y * w + x], `(${x},${y}) 两条路径应一致`);
        }
      }
    });
  });

  // ============================================================
  describe('Adapters · HitResult → CasterHit', () => {
    function mkHit(
      id: string, x: number, y: number, distance: number, data?: unknown,
    ): IHitLike {
      return { hitbox: { id, x, y, data }, distance };
    }

    test('toCasterHits 字段映射正确', () => {
      const hits = [mkHit('a', 1, 2, 5, { tag: 'x' })];
      const out = toCasterHits(hits);
      eq(out.length, 1, '数量');
      eq(out[0].id, 'a', 'id 取自 hitbox.id');
      eq(out[0].x, 1, 'x');
      eq(out[0].y, 2, 'y');
      eq((out[0].data as { tag: string }).tag, 'x', 'data 原样透传');
    });

    test('⚠️ 不转换会怎样：字段名不同 + 嵌套一层', () => {
      /**
       * 【这条测试锁的是"为什么必须有这个适配器"】
       * 如果把 HitResult 直接当 CasterHit 用：
       *   - hit.id 是 undefined
       *   - hit.x 是 undefined
       * 然后一路传到伤害结算，表现为"技能打中了但没伤害"，不报错。
       */
      const raw = mkHit('a', 1, 2, 5);
      const wrong = raw as unknown as { id: string; x: number };
      eq(wrong.id, undefined, '直接当 CasterHit 用 → id 是 undefined');
      eq(wrong.x, undefined, 'x 也是 undefined');

      const correct = toCasterHits([raw]);
      eq(correct[0].id, 'a', '经过适配器 → id 正确');
    });

    test('toCasterHits 默认按距离升序', () => {
      const hits = [mkHit('far', 0, 0, 10), mkHit('near', 0, 0, 2), mkHit('mid', 0, 0, 5)];
      const out = toCasterHits(hits);
      eq(out[0].id, 'near', '最近');
      eq(out[1].id, 'mid', '中间');
      eq(out[2].id, 'far', '最远');
    });

    test('sortByDistance=false 时保持原顺序', () => {
      const hits = [mkHit('far', 0, 0, 10), mkHit('near', 0, 0, 2)];
      const out = toCasterHits(hits, { sortByDistance: false });
      eq(out[0].id, 'far', '不排序 → 保持输入顺序');
    });

    test('⚠️ 排序不修改原数组（副作用）', () => {
      const hits = [mkHit('b', 0, 0, 10), mkHit('a', 0, 0, 1)];
      toCasterHits(hits);
      eq(hits[0].hitbox.id, 'b', '原数组顺序不应被改变');
      eq(hits[1].hitbox.id, 'a', '原数组顺序不应被改变');
    });

    test('toCasterHits 复用 out 数组（不累积）', () => {
      const buf: Array<{ id: string; x: number; y: number; data?: unknown }> = [];
      const r1 = toCasterHits([mkHit('a', 0, 0, 1)], { out: buf });
      eq(r1 === buf, true, '应返回传入的数组');
      toCasterHits([mkHit('b', 0, 0, 1)], { out: buf });
      eq(buf.length, 1, '复用时应先清空（否则会累积）');
      eq(buf[0].id, 'b', '只剩新的');
    });

    test('nearestCasterHits 只取 N 个', () => {
      const hits = [mkHit('c', 0, 0, 9), mkHit('a', 0, 0, 1), mkHit('b', 0, 0, 5)];
      const out = nearestCasterHits(hits, 2);
      eq(out.length, 2, '取 2 个');
      eq(out[0].id, 'a', '最近');
      eq(out[1].id, 'b', '第二近');
    });

    test('⚠️ N 大于命中数时不越界', () => {
      const hits = [mkHit('a', 0, 0, 1)];
      const out = nearestCasterHits(hits, 50);
      eq(out.length, 1, '只能返回实际存在的数量');
    });

    test('nearestCasterHits n<=0 返回空（不崩）', () => {
      eq(nearestCasterHits([mkHit('a', 0, 0, 1)], 0).length, 0, 'n=0 → 空');
      eq(nearestCasterHits([mkHit('a', 0, 0, 1)], -1).length, 0, 'n<0 → 空');
    });

    test('⚠️ uniqueEntityHits：同一实体多个框只算一次', () => {
      /**
       * 【真实链路跑出来的问题】
       * 骨王有 'boss-body' 和 'boss-weak' 两个判定框。
       * 一次挥砍同时命中两个，不去重就扣两次血：
       *   hp = 100 - 60 - 60 = -20
       * 症状是"大范围技能伤害莫名翻倍"，框越多翻倍越狠。
       */
      const entityOf = (boxId: string): number =>
        boxId.startsWith('boss') ? 1 : (boxId.startsWith('mob') ? 2 : 0);

      const hits = [
        mkHit('boss-weak', 5.8, 5, 0.5),
        mkHit('boss-body', 5, 5, 1.2),
        mkHit('mob-1', 2, 2, 2.0),
      ];
      const uniq = uniqueEntityHits(hits, entityOf);
      eq(uniq.length, 2, '3 个命中 → 2 个实体');
      eq(uniq[0].hitbox.id, 'boss-weak', '保留距离更近的弱点框');
      eq(uniq[1].hitbox.id, 'mob-1', '小怪');
    });

    test('⚠️ uniqueEntityHits：反解失败的命中单独保留', () => {
      // 箱子类物体没有对应实体（entityOf 返回 0），不能被合并掉
      const entityOf = (boxId: string): number => (boxId.startsWith('e') ? 1 : 0);
      const hits = [mkHit('e1-body', 0, 0, 3), mkHit('barrel', 1, 1, 1), mkHit('crate', 2, 2, 2)];
      const uniq = uniqueEntityHits(hits, entityOf);
      eq(uniq.length, 3, '2 个无法反解的 + 1 个实体');
    });

    test('uniqueEntityHits：空输入与复用 out', () => {
      eq(uniqueEntityHits([], () => 1).length, 0, '空输入');
      const buf: IHitLike[] = [];
      const r = uniqueEntityHits([mkHit('a', 0, 0, 1)], () => 7, buf);
      eq(r === buf, true, '复用传入数组');
      uniqueEntityHits([], () => 7, buf);
      eq(buf.length, 0, '复用时先清空');
    });

    test('⚠️ uniqueEntityHits 与伤害结算配合（不重复扣血）', () => {
      const entityOf = (boxId: string): number => (boxId.startsWith('boss') ? 1 : 0);
      const boss = { hp: 100 };

      const hits = [mkHit('boss-body', 0, 0, 1.0), mkHit('boss-weak', 0, 0, 0.5)];

      // 不去重
      let hpNoDedup = boss.hp;
      for (const _h of hits) hpNoDedup -= 60;

      // 去重后
      let hpDedup = boss.hp;
      for (const _h of uniqueEntityHits(hits, entityOf)) hpDedup -= 60;

      eq(hpNoDedup, -20, '不去重 → 扣了两次（-20）');
      eq(hpDedup, 40, '去重后只扣一次（40）');
    });
  });

  // ============================================================
  describe('Adapters · LootDrop → 物品', () => {
    test('flattenDrops 简单掉落', () => {
      const drops: ILootDropLike[] = [{ id: 'gold', count: 15 }];
      const out = flattenDrops(drops);
      eq(out.length, 1, '1 项');
      eq(out[0].id, 'gold', 'id');
      eq(out[0].count, 15, '数量');
      eq(out[0].fromPity, false, '非保底');
    });

    test('⚠️ 嵌套子表：父项与子项都要产出（最容易漏）', () => {
      /**
       * 【为什么必须测】
       * 手写递归时，十个有九个会漏掉"父项本身也是物品"。
       * 表现是：开宝箱拿到了箱子，却没拿到里面的剑。
       * 而且不报错——玩家只觉得"这箱子怎么是空的"。
       */
      const drops: ILootDropLike[] = [
        { id: 'chest', count: 1, children: [{ id: 'sword', count: 1 }] },
      ];
      const out = flattenDrops(drops);
      eq(out.length, 2, '父项和子项都要有');
      eq(out[0].id, 'chest', '父项');
      eq(out[1].id, 'sword', '子项');
    });

    test('⚠️ 多层嵌套 + 来源路径', () => {
      const drops: ILootDropLike[] = [
        {
          id: 'boss', count: 1,
          children: [{ id: 'chest', count: 1, children: [{ id: 'sword', count: 1 }] }],
        },
      ];
      const out = flattenDrops(drops);
      eq(out.length, 3, '三层都要摊平');
      eq(out[2].path.join('/'), 'boss/chest/sword', '路径记录完整来源');
    });

    test('flattenDrops 同 id 自动合并', () => {
      const drops: ILootDropLike[] = [
        { id: 'gold', count: 10 },
        { id: 'gold', count: 5 },
        { id: 'potion', count: 1 },
      ];
      const out = flattenDrops(drops);
      eq(out.length, 2, '两堆金币合并成一堆');
      const gold = out.find((d) => d.id === 'gold');
      eq(gold?.count, 15, '10 + 5');
    });

    test('mergeSameId=false 时不合并', () => {
      const drops: ILootDropLike[] = [{ id: 'gold', count: 10 }, { id: 'gold', count: 5 }];
      const out = flattenDrops(drops, { mergeSameId: false });
      eq(out.length, 2, '保持两项');
    });

    test('⚠️ 保底标记是"或"关系', () => {
      const drops: ILootDropLike[] = [
        { id: 'sword', count: 1, fromPity: false },
        { id: 'sword', count: 1, fromPity: true },
      ];
      const out = flattenDrops(drops);
      eq(out.length, 1, '合并成一项');
      eq(out[0].fromPity, true, '任一来自保底 → 结果标为保底');
    });

    test('count=0 的项不产出（容器标记）', () => {
      /**
       * 【用途】
       * 有些掉落表用 `{ id:'container', count:0, children:[...] }` 表示
       * "这只是个分组，本身不是物品"。count=0 时不该产出空物品。
       */
      const drops: ILootDropLike[] = [
        { id: 'container', count: 0, children: [{ id: 'sword', count: 1 }] },
      ];
      const out = flattenDrops(drops);
      eq(out.length, 1, '只产出子项');
      eq(out[0].id, 'sword', '不是 container');
    });

    test('空掉落返回空数组', () => {
      eq(flattenDrops([]).length, 0, '空输入');
    });
  });

  // ============================================================
  describe('Adapters · 掉落 → 入包', () => {
    test('applyDropsToInventory 返回实际放入量', () => {
      const drops = flattenDrops([{ id: 'gold', count: 15 }]);
      const report = applyDropsToInventory(drops, () => 15);
      eq(report.length, 1, '1 条记录');
      eq(report[0].wanted, 15, '想要 15');
      eq(report[0].added, 15, '放入 15');
    });

    test('⚠️ 背包满时报告丢弃量（玩家最在意）', () => {
      /**
       * 【为什么必须返回 added】
       * 背包满了会丢弃一部分。
       * 不返回实际放入量的话，UI 没法提示"背包已满，获得 8/15"——
       * 而玩家会认为自己被吞了 7 个。
       */
      const drops = flattenDrops([{ id: 'gold', count: 15 }]);
      const report = applyDropsToInventory(drops, () => 8);   // 只放得下 8
      eq(report[0].wanted, 15, '想要 15');
      eq(report[0].added, 8, '实际放入 8');
      eq(report[0].wanted - report[0].added, 7, '丢了 7 个');
    });

    test('applyDropsToInventory 空输入', () => {
      eq(applyDropsToInventory([], () => 0).length, 0, '空');
    });
  });

  // ============================================================
  describe('Adapters · 完整链路', () => {
    test('地牢 → 墙判定 → 地板计数', () => {
      const w = 9;
      const h = 7;
      const src: ITileSource = {
        width: w,
        height: h,
        tileAt: (x, y) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 0 : 1),
      };
      const grid = toGrid2D(src);
      const isWall = wallTestFrom2D(grid, [0]);

      eq(isWall(0, 0), true, '角上是墙');
      eq(isWall(4, 3), false, '中心是地板');
      eq(isWall(-1, 3), true, '越界是墙');

      let floor = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) if (!isWall(x, y)) floor++;
      }
      eq(floor, (w - 2) * (h - 2), '地板格数');
    });

    test('掉落 → 摊平 → 入包', () => {
      const drops: ILootDropLike[] = [
        { id: 'gold', count: 100 },
        { id: 'chest', count: 1, children: [{ id: 'sword', count: 1 }, { id: 'gold', count: 20 }] },
        { id: 'potion', count: 3 },
      ];
      const flat = flattenDrops(drops);

      // gold 应合并成 120
      const gold = flat.find((d) => d.id === 'gold');
      eq(gold?.count, 120, '两处金币合并');

      // ⚠️ 是 4 种不是 3 种：
      //   gold(120) / chest(1) / sword(1) / potion(3)
      // 宝箱本身也会进背包——这正是"父项也是物品"的体现。
      // 我第一版断言写了 3，是漏算了 chest。
      eq(flat.length, 4, '摊平后 4 种物品（含宝箱本身）');

      const bag = new Map<string, number>();
      const report = applyDropsToInventory(flat, (id, amount) => {
        const cur = bag.get(id) ?? 0;
        bag.set(id, cur + amount);
        return amount;
      });
      eq(report.length, 4, '4 条记录');
      eq(bag.get('gold'), 120, '金币入包（两处合并）');
      eq(bag.get('sword'), 1, '剑入包（来自宝箱）');
      eq(bag.get('chest'), 1, '宝箱本身也入包');
      eq(bag.get('potion'), 3, '药水入包');
      near(report.reduce((s, r) => s + r.added, 0), 125, 0.001, '总数 120+1+1+3');
    });

    test('⚠️ 命中 → 适配器 → 只打最近的一个', () => {
      // 近战单体技能：命中 3 个，只应结算最近那个
      const hits: IHitLike[] = [
        { hitbox: { id: 'e3', x: 5, y: 0, data: { hp: 30 } }, distance: 5 },
        { hitbox: { id: 'e1', x: 1, y: 0, data: { hp: 30 } }, distance: 1 },
        { hitbox: { id: 'e2', x: 3, y: 0, data: { hp: 30 } }, distance: 3 },
      ];
      const target = nearestCasterHits(hits, 1);
      eq(target.length, 1, '只取 1 个');
      eq(target[0].id, 'e1', '最近的目标');

      // 且能拿到业务实体（这是必须能做到的，否则没法扣血）
      const entity = target[0].data as { hp: number };
      entity.hp -= 10;
      eq(entity.hp, 20, '能直接操作业务实体');
    });
  });
}
