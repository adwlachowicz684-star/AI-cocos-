/**
 * tests/run_batch5.ts —— 第四批插件的测试
 *
 * 覆盖：turn、grid、quest、shop、craft
 *
 * 【这批的 bug 特点：都是"看起来对但实际错"】
 *
 * - 回合制里死了的单位还被轮到 → 崩溃或跳过一轮
 * - 网格越界 → undefined 混入导致后续 NaN
 * - 任务完成但还能继续计数 → 显示 7/5
 * - 商店先扣钱后发现没库存 → 钱没了东西没到
 * - 合成先扣材料后产出失败 → **材料凭空消失**（头号事故）
 *
 * 这些都不会抛异常，只会安静地错。所以必须测。
 */

import { describe, test, assert, eq, near, throws } from './_framework';

import { TurnSystem } from '../turn/TurnSystem';
import { Grid, GridPlacement, hexDistance, hexNeighbors, hexToPixel, pixelToHex, hexRing, hexSpiral, hexRound } from '../grid/Grid';
import { QuestSystem } from '../quest/QuestSystem';
import { Shop } from '../shop/Shop';
import { CraftSystem, IInventory } from '../craft/CraftSystem';
import { RNG } from '../rng/RNG';

/** 测试用的简易背包（实现 CraftSystem 需要的 IInventory） */
class TestBag implements IInventory {
  private readonly _items = new Map<string, number>();
  /** 容量上限（用于测试"背包满"的回滚） */
  capacity: number = Infinity;

  set(id: string, n: number): void {
    this._items.set(id, n);
  }

  count(id: string): number {
    return this._items.get(id) ?? 0;
  }

  get total(): number {
    let n = 0;
    for (const v of this._items.values()) n += v;
    return n;
  }

  remove(id: string, amount: number): number {
    const have = this._items.get(id) ?? 0;
    const take = Math.min(have, amount);
    this._items.set(id, have - take);
    return take;
  }

  add(id: string, amount: number): number {
    const have = this._items.get(id) ?? 0;
    const roomForThis = Math.max(0, this.capacity - this.total);
    const put = Math.min(amount, roomForThis);
    this._items.set(id, have + put);
    return amount - put; // 返回放不下的
  }
}

export async function runBatch5Tests(): Promise<void> {
  // ============================================================
  // TurnSystem
  // ============================================================

  describe('TurnSystem · 回合制', () => {
    function make(): TurnSystem {
      const t = new TurnSystem();
      t.addUnit({ id: 'hero', initiative: 15 });
      t.addUnit({ id: 'goblin', initiative: 8 });
      t.addUnit({ id: 'boss', initiative: 20 });
      return t;
    }

    test('按先攻排序（大的先动）', () => {
      const t = make();
      t.start();
      eq(t.currentUnitId, 'boss');
      t.endTurn();
      eq(t.currentUnitId, 'hero');
      t.endTurn();
      eq(t.currentUnitId, 'goblin');
    });

    test('轮完一圈进入下一轮', () => {
      const t = make();
      t.start();
      eq(t.round, 1);
      t.endTurn(); t.endTurn(); t.endTurn();
      eq(t.round, 2);
      eq(t.currentUnitId, 'boss');
    });

    test('先攻相同时用 id 保证确定性', () => {
      const a = new TurnSystem();
      a.addUnit({ id: 'z', initiative: 10 });
      a.addUnit({ id: 'a', initiative: 10 });
      a.start();

      const b = new TurnSystem();
      b.addUnit({ id: 'a', initiative: 10 });   // 添加顺序不同
      b.addUnit({ id: 'z', initiative: 10 });
      b.start();

      eq(a.currentUnitId, b.currentUnitId, '添加顺序不应影响结果');
      eq(a.currentUnitId, 'a', '同先攻按 id 排');
    });

    test('死亡单位被跳过（不是崩溃）', () => {
      const t = make();
      t.start();                    // boss
      t.killUnit('hero');           // 在轮到它之前杀掉
      t.endTurn();                  // → 应跳过 hero 到 goblin
      eq(t.currentUnitId, 'goblin', '不应停在已死的 hero 上');
    });

    test('在回调里杀单位不会导致跳过（惰性清理）', () => {
      // b 的回合开始时杀死 c（正在遍历中）
      const events: string[] = [];
      const t2 = new TurnSystem({
        onUnitStart: (id) => {
          events.push(id);
          if (id === 'b') t2.killUnit('c');   // 遍历中删除
        },
      });
      t2.addUnit({ id: 'a', initiative: 30 });
      t2.addUnit({ id: 'b', initiative: 20 });
      t2.addUnit({ id: 'c', initiative: 10 });

      t2.start();
      t2.endTurn();   // a → b（b 的 start 里杀了 c）
      t2.endTurn();   // b → ? c 已死，应该回到 a（新一轮）

      eq(events.join(','), 'a,b,a', 'c 被跳过，且 a 没有被跳过');
    });

    test('所有单位死光后停止（不是死循环）', () => {
      const t = make();
      t.start();
      t.killUnit('boss');
      t.killUnit('hero');
      t.killUnit('goblin');
      t.endTurn();
      eq(t.isRunning, false, '没人了应该停下');
      eq(t.currentUnitId, null);
    });

    test('跳过单位只生效一次（眩晕一回合）', () => {
      const t = make();
      t.start();                    // boss
      t.skipUnit('hero');
      t.endTurn();                  // → goblin（跳过 hero）
      eq(t.currentUnitId, 'goblin');

      t.endTurn();                  // → 新一轮，hero 应该能动了
      eq(t.round, 2);
      // boss → hero（不再被跳过）
      t.endTurn();
      eq(t.currentUnitId, 'hero', '眩晕只应持续一回合');
    });

    test('额外回合（连击）', () => {
      const t = make();
      t.start();                    // boss
      t.grantExtraTurn('boss');
      t.endTurn();                  // 应该还是 boss
      eq(t.currentUnitId, 'boss', '连击应该让同一单位连续行动');
      t.endTurn();
      eq(t.currentUnitId, 'hero', '连击结束后正常轮转');
    });

    test('战斗中新增单位不会让已行动的重来', () => {
      const t = make();
      t.start();                    // boss
      t.endTurn();                  // hero
      t.addUnit({ id: 'summon', initiative: 99 });  // 先攻很高

      t.endTurn();                  // 应该到 goblin，不是 summon
      eq(t.currentUnitId, 'goblin', '战斗中加人不该重新排序');
    });

    test('行动点：花费与不足', () => {
      const t = new TurnSystem();
      t.addUnit({ id: 'hero', initiative: 10, actionPoints: 4 });
      t.addUnit({ id: 'foe', initiative: 5 });
      t.start();

      eq(t.currentAP, 4);
      eq(t.spendAP(2), true);
      eq(t.currentAP, 2);
      eq(t.spendAP(5), false, '不够时不该扣');
      eq(t.currentAP, 2, '失败的 spend 不应扣点');
      eq(t.canAfford(2), true);
      eq(t.canAfford(3), false);
    });

    test('行动点每回合重置', () => {
      const t = new TurnSystem();
      t.addUnit({ id: 'a', initiative: 10, actionPoints: 2 });
      t.addUnit({ id: 'b', initiative: 5, actionPoints: 2 });
      t.start();

      t.spendAP(2);
      eq(t.currentAP, 0);
      t.endTurn();                  // → b
      t.endTurn();                  // → a（新一轮）
      eq(t.currentAP, 2, 'AP 应回满');
    });

    test('未开始时 endTurn 无害', () => {
      const t = make();
      eq(t.endTurn(), false);
    });

    test('没有单位时 start 抛错', () => {
      throws(() => new TurnSystem().start());
    });

    test('重复添加返回 false', () => {
      const t = new TurnSystem();
      eq(t.addUnit({ id: 'a', initiative: 1 }), true);
      eq(t.addUnit({ id: 'a', initiative: 2 }), false);
    });

    test('orderPreview 显示行动条', () => {
      const t = make();
      t.start();
      eq(t.orderPreview.join(','), 'boss,hero,goblin');
      t.endTurn();
      eq(t.orderPreview.join(','), 'hero,goblin,boss');
    });

    test('事件回调触发顺序', () => {
      const events: string[] = [];
      const t = new TurnSystem({
        onRoundStart: (r) => events.push(`round${r}`),
        onUnitStart: (id) => events.push(`start:${id}`),
        onUnitEnd: (id) => events.push(`end:${id}`),
      });
      t.addUnit({ id: 'a', initiative: 10 });
      t.addUnit({ id: 'b', initiative: 5 });
      t.start();
      t.endTurn();
      t.endTurn();

      eq(events.join(' '), 'round1 start:a end:a start:b end:b round2 start:a');
    });
  });

  // ============================================================
  // Grid
  // ============================================================

  describe('Grid · 二维网格', () => {
    test('基本读写', () => {
      const g = new Grid<string>(5, 4);
      eq(g.set(2, 3, '树'), true);
      eq(g.get(2, 3), '树');
      eq(g.get(0, 0), undefined);
    });

    test('越界读返回 undefined（不崩）', () => {
      const g = new Grid<string>(3, 3);
      eq(g.get(-1, 0), undefined);
      eq(g.get(0, -1), undefined);
      eq(g.get(3, 0), undefined);
      eq(g.get(0, 3), undefined);
      eq(g.get(99, 99), undefined);
    });

    test('越界写返回 false（不崩）', () => {
      const g = new Grid<string>(3, 3);
      eq(g.set(-1, 0, 'x'), false);
      eq(g.set(0, 99, 'x'), false);
    });

    test('setStrict 越界抛错（用于发现逻辑错误）', () => {
      const g = new Grid<string>(3, 3);
      throws(() => g.setStrict(5, 5, 'x'));
    });

    test('inBounds', () => {
      const g = new Grid<string>(3, 4);
      eq(g.inBounds(0, 0), true);
      eq(g.inBounds(2, 3), true);
      eq(g.inBounds(3, 0), false);
      eq(g.inBounds(0, 4), false);
      eq(g.inBounds(-1, 0), false);
    });

    test('index 换算', () => {
      const g = new Grid<string>(5, 3);
      eq(g.index(0, 0), 0);
      eq(g.index(4, 0), 4);
      eq(g.index(0, 1), 5);
      eq(g.index(2, 2), 12);
      eq(g.index(-1, 0), -1);
    });

    test('四邻居：中心有 4 个', () => {
      const g = new Grid<string>(5, 5);
      eq(g.neighbors4(2, 2).length, 4);
    });

    test('四邻居：边角自动裁剪', () => {
      const g = new Grid<string>(5, 5);
      eq(g.neighbors4(0, 0).length, 2, '左上角只有右和下');
      eq(g.neighbors4(4, 4).length, 2);
      eq(g.neighbors4(0, 2).length, 3);
    });

    test('八邻居：中心有 8 个，角上只有 3 个', () => {
      const g = new Grid<string>(5, 5);
      eq(g.neighbors8(2, 2).length, 8);
      eq(g.neighbors8(0, 0).length, 3);
    });

    test('填充矩形', () => {
      const g = new Grid<string>(5, 5);
      g.fill(1, 1, 3, 2, '水');
      eq(g.get(1, 1), '水');
      eq(g.get(3, 2), '水');
      eq(g.get(4, 2), undefined, '超出填充范围');
      eq(g.get(1, 3), undefined);
    });

    test('fillAll 与 clear', () => {
      const g = new Grid<string>(3, 3);
      g.fillAll('x');
      eq(g.count((v) => v === 'x'), 9);
      g.clear();
      eq(g.count((v) => v === 'x'), 0);
    });

    test('find 查找', () => {
      const g = new Grid<string>(4, 4);
      g.set(1, 1, '树');
      g.set(3, 2, '树');
      g.set(0, 3, '石头');
      const trees = g.find((v) => v === '树');
      eq(trees.length, 2);
      eq(trees[0].x, 1);
      eq(trees[0].y, 1);
    });

    test('可迭代', () => {
      const g = new Grid<number>(3, 2);
      g.fillAll(7);
      let n = 0;
      for (const c of g) {
        eq(c.value, 7);
        n++;
      }
      eq(n, 6);
    });

    test('forEach 遍历全部', () => {
      const g = new Grid<number>(3, 3);
      let n = 0;
      g.forEach(() => n++);
      eq(n, 9);
    });

    test('toRows / fromRows 往返', () => {
      const g = new Grid<string>(3, 2);
      g.set(0, 0, 'a');
      g.set(2, 1, 'b');
      const rows = g.toRows();
      eq(rows.length, 2);
      eq(rows[0].length, 3);
      eq(rows[1][2], 'b');

      const g2 = Grid.fromRows(rows);
      eq(g2.width, 3);
      eq(g2.get(2, 1), 'b');
    });

    test('尺寸非法时抛错', () => {
      throws(() => new Grid<string>(0, 5));
      throws(() => new Grid<string>(5, -1));
    });
  });

  describe('GridPlacement · 建造放置', () => {
    function make(): GridPlacement {
      const p = new GridPlacement(10, 10);
      p.define({ id: 'house', w: 2, h: 2, rotatable: true });
      p.define({ id: 'road', w: 1, h: 1 });
      return p;
    }

    test('放置占多格', () => {
      const p = make();
      const id = p.place('house', 2, 3);
      assert(id !== null);
      eq(p.at(2, 3), id);
      eq(p.at(3, 3), id, '右邻格也被占');
      eq(p.at(2, 4), id, '下邻格也被占');
      eq(p.at(3, 4), id);
    });

    test('已占用的格子不能再放', () => {
      const p = make();
      p.place('house', 2, 3);
      eq(p.canPlace('road', 2, 3), false, '房子占的格子不能修路');
      eq(p.canPlace('road', 3, 4), false);
      eq(p.place('road', 2, 3), null);
    });

    test('空地可以放', () => {
      const p = make();
      p.place('house', 0, 0);
      eq(p.canPlace('road', 5, 5), true);
      eq(p.isFree(5, 5), true);
    });

    test('越界不能放', () => {
      const p = make();
      eq(p.canPlace('house', 9, 9), false, '2×2 的建筑放不下（会超出右边界）');
      eq(p.canPlace('house', 8, 8), true);
      eq(p.canPlace('house', -1, 0), false);
    });

    test('旋转后尺寸互换', () => {
      const p = new GridPlacement(10, 10);
      p.define({ id: 'hall', w: 4, h: 1, rotatable: true });

      const id = p.place('hall', 0, 0, true);
      const placed = p.get(id!);
      eq(placed?.w, 1, '旋转后宽变 1');
      eq(placed?.h, 4, '旋转后高变 4');
      eq(p.at(0, 3), id);
      eq(p.at(1, 0), undefined, '横向不应被占');
    });

    test('不可旋转的建筑拒绝旋转', () => {
      const p = new GridPlacement(10, 10);
      p.define({ id: 'fixed', w: 2, h: 1 });   // 没有 rotatable
      eq(p.canPlace('fixed', 0, 0, true), false);
    });

    test('拆除释放所有格子', () => {
      const p = make();
      const id = p.place('house', 2, 3)!;
      eq(p.placedCount, 1);

      eq(p.remove(id), true);
      eq(p.placedCount, 0);
      eq(p.at(2, 3), undefined);
      eq(p.at(3, 4), undefined, '所有格子都应释放');
      eq(p.canPlace('road', 2, 3), true, '拆完可以再建');
    });

    test('移动已放置的建筑', () => {
      const p = make();
      const id = p.place('house', 0, 0)!;
      eq(p.move(id, 5, 5), true);
      eq(p.at(0, 0), undefined, '原位释放');
      eq(p.at(5, 5), id);
      eq(p.at(6, 6), id);
    });

    test('移动失败时回滚（不会两个位置都占）', () => {
      const p = make();
      const a = p.place('house', 0, 0)!;
      p.place('house', 4, 4);          // 占住目标区域

      eq(p.move(a, 4, 4), false, '目标被占，移动失败');
      eq(p.at(0, 0), a, '原位应保留（回滚成功）');
      eq(p.placedCount, 2);
    });

    test('findSpots 找可放位置', () => {
      const p = new GridPlacement(3, 3);
      p.define({ id: 'big', w: 2, h: 2 });
      // 3×3 网格里 2×2 的建筑有 4 个位置：(0,0)(1,0)(0,1)(1,1)
      eq(p.findSpots('big').length, 4);

      p.place('big', 0, 0);
      // 占了左上 2×2，剩下 (2,0) (2,1) (0,2) (1,2) (2,2) 中
      // 能放下 2×2 的只有 (1,1)? 不，(1,1) 与 (0,0) 重叠
      const after = p.findSpots('big');
      eq(after.length, 0, '3×3 放一个 2×2 后放不下第二个');
    });

    test('freeCount 统计空格', () => {
      const p = make();
      eq(p.freeCount, 100);
      p.place('house', 0, 0);
      eq(p.freeCount, 96);
    });

    test('未定义的建筑不能放', () => {
      const p = make();
      eq(p.canPlace('不存在', 0, 0), false);
      eq(p.place('不存在', 0, 0), null);
    });

    test('clear 清空', () => {
      const p = make();
      p.place('house', 0, 0);
      p.clear();
      eq(p.placedCount, 0);
      eq(p.freeCount, 100);
    });

    test('尺寸非法时抛错', () => {
      throws(() => new GridPlacement(0, 5));
    });
  });

  describe('Hex · 六边形坐标', () => {
    test('距离为 0（自己）', () => {
      eq(hexDistance({ q: 3, r: -1 }, { q: 3, r: -1 }), 0);
    });

    test('相邻距离为 1', () => {
      const ns = hexNeighbors({ q: 0, r: 0 });
      eq(ns.length, 6);
      for (const n of ns) eq(hexDistance({ q: 0, r: 0 }, n), 1);
    });

    test('距离计算', () => {
      eq(hexDistance({ q: 0, r: 0 }, { q: 3, r: 0 }), 3);
      eq(hexDistance({ q: 0, r: 0 }, { q: 0, r: 3 }), 3);
      eq(hexDistance({ q: 0, r: 0 }, { q: 2, r: -1 }), 2);
    });

    test('六个邻居互不相同', () => {
      const ns = hexNeighbors({ q: 5, r: -2 });
      const keys = new Set(ns.map((h) => `${h.q},${h.r}`));
      eq(keys.size, 6);
    });

    test('hexRing 半径 1 有 6 个', () => {
      eq(hexRing({ q: 0, r: 0 }, 1).length, 6);
    });

    test('hexRing 半径 2 有 12 个', () => {
      eq(hexRing({ q: 0, r: 0 }, 2).length, 12);
    });

    test('hexSpiral 数量符合公式 3r²+3r+1', () => {
      eq(hexSpiral({ q: 0, r: 0 }, 0).length, 1);
      eq(hexSpiral({ q: 0, r: 0 }, 1).length, 7);
      eq(hexSpiral({ q: 0, r: 0 }, 2).length, 19);
      eq(hexSpiral({ q: 0, r: 0 }, 3).length, 37);
    });

    test('hexToPixel / pixelToHex 往返', () => {
      for (const h of [{ q: 0, r: 0 }, { q: 2, r: -1 }, { q: -3, r: 2 }]) {
        const px = hexToPixel(h, 10);
        const back = pixelToHex(px.x, px.y, 10);
        eq(back.q, h.q, `q 往返失败：${JSON.stringify(h)}`);
        eq(back.r, h.r, `r 往返失败：${JSON.stringify(h)}`);
      }
    });

    test('hexRound 保证 q+r+s=0', () => {
      for (let i = 0; i < 20; i++) {
        const qf = (Math.random() - 0.5) * 10;
        const rf = (Math.random() - 0.5) * 10;
        const r = hexRound(qf, rf);
        eq(Number.isInteger(r.q), true);
        eq(Number.isInteger(r.r), true);
      }
    });
  });

  // ============================================================
  // QuestSystem
  // ============================================================

  describe('QuestSystem · 任务系统', () => {
    function make(): QuestSystem {
      const q = new QuestSystem();
      q.define({
        id: 'kill_slimes',
        name: '清理史莱姆',
        objectives: [{ type: 'kill', target: 'slime', count: 5 }],
        rewards: { exp: 100, gold: 50 },
      });
      return q;
    }

    test('初始状态', () => {
      const q = make();
      eq(q.status('kill_slimes'), 'available');
      eq(q.available.includes('kill_slimes'), true);
    });

    test('接取后变 active', () => {
      const q = make();
      eq(q.accept('kill_slimes'), true);
      eq(q.status('kill_slimes'), 'active');
      eq(q.accept('kill_slimes'), false, '不能重复接');
    });

    test('进度累加', () => {
      const q = make();
      q.accept('kill_slimes');
      q.report({ type: 'kill', target: 'slime' });
      eq(q.objectiveProgress('kill_slimes', 0)?.current, 1);
      q.report({ type: 'kill', target: 'slime', n: 2 });
      eq(q.objectiveProgress('kill_slimes', 0)?.current, 3);
    });

    test('不相关的事件不计入', () => {
      const q = make();
      q.accept('kill_slimes');
      q.report({ type: 'kill', target: 'goblin' });
      eq(q.objectiveProgress('kill_slimes', 0)?.current, 0, '杀哥布林不算史莱姆');
      q.report({ type: 'collect', target: 'slime' });
      eq(q.objectiveProgress('kill_slimes', 0)?.current, 0, '收集事件不算击杀');
    });

    test('完成后自动变 completed', () => {
      const q = make();
      q.accept('kill_slimes');
      q.report({ type: 'kill', target: 'slime', n: 5 });
      eq(q.status('kill_slimes'), 'completed');
    });

    test('完成后不再累加（不会显示 7/5）', () => {
      const q = make();
      q.accept('kill_slimes');
      q.report({ type: 'kill', target: 'slime', n: 5 });
      q.report({ type: 'kill', target: 'slime', n: 2 });
      eq(q.objectiveProgress('kill_slimes', 0)?.current, 5, '应封顶在 5');
    });

    test('奖励只能领一次（防重复发奖）', () => {
      const q = make();
      q.accept('kill_slimes');
      q.report({ type: 'kill', target: 'slime', n: 5 });

      const r1 = q.claim('kill_slimes');
      eq(r1?.exp, 100);
      eq(q.isClaimed('kill_slimes'), true);

      const r2 = q.claim('kill_slimes');
      eq(r2, null, '第二次应返回 null');
    });

    test('未完成不能领奖', () => {
      const q = make();
      q.accept('kill_slimes');
      q.report({ type: 'kill', target: 'slime', n: 3 });
      eq(q.claim('kill_slimes'), null);
    });

    test('前置任务链', () => {
      const q = new QuestSystem();
      q.define({
        id: 'a',
        name: '第一步',
        objectives: [{ type: 'kill', target: 'rat', count: 1 }],
      });
      q.define({
        id: 'b',
        name: '第二步',
        requires: ['a'],
        objectives: [{ type: 'kill', target: 'boss', count: 1 }],
      });

      eq(q.status('b'), 'locked');
      eq(q.available.includes('b'), false, '前置未完成不该可接');

      q.accept('a');
      q.report({ type: 'kill', target: 'rat' });

      eq(q.status('b'), 'available', 'a 完成后 b 解锁');
      eq(q.available.includes('b'), true);
    });

    test('autoAccept 自动接取', () => {
      const q = new QuestSystem();
      q.define({
        id: 'auto',
        name: '自动任务',
        objectives: [{ type: 'reach', target: 'village' }],
        autoAccept: true,
      });
      eq(q.status('auto'), 'active');

      q.report({ type: 'reach', target: 'village' });
      eq(q.status('auto'), 'completed');
    });

    test('多目标：全部完成才算完成', () => {
      const q = new QuestSystem();
      q.define({
        id: 'multi',
        name: '多目标',
        objectives: [
          { type: 'kill', target: 'slime', count: 3 },
          { type: 'collect', target: 'herb', count: 2 },
        ],
      });
      q.accept('multi');

      q.report({ type: 'kill', target: 'slime', n: 3 });
      eq(q.status('multi'), 'active', '只完成一个不该算完成');

      q.report({ type: 'collect', target: 'herb', n: 2 });
      eq(q.status('multi'), 'completed');
    });

    test('完成度比例', () => {
      const q = make();
      q.accept('kill_slimes');
      near(q.completionRatio('kill_slimes'), 0);
      q.report({ type: 'kill', target: 'slime', n: 2 });
      near(q.completionRatio('kill_slimes'), 0.4);
      q.report({ type: 'kill', target: 'slime', n: 3 });
      near(q.completionRatio('kill_slimes'), 1);
    });

    test('自定义判定', () => {
      const q = new QuestSystem();
      q.define({
        id: 'custom',
        name: '自定义',
        objectives: [
          { type: 'custom', target: '', test: (e) => e.type === 'levelup' && (e.n ?? 0) >= 10 },
        ],
      });
      q.accept('custom');

      q.report({ type: 'levelup', n: 5 });
      eq(q.status('custom'), 'active');

      q.report({ type: 'levelup', n: 10 });
      eq(q.status('custom'), 'completed');
    });

    test('放弃任务清零进度', () => {
      const q = make();
      q.accept('kill_slimes');
      q.report({ type: 'kill', target: 'slime', n: 3 });
      eq(q.abandon('kill_slimes'), true);
      eq(q.status('kill_slimes'), 'available');
      eq(q.objectiveProgress('kill_slimes', 0)?.current, 0);
    });

    test('失败任务', () => {
      const q = make();
      q.accept('kill_slimes');
      eq(q.fail('kill_slimes'), true);
      eq(q.status('kill_slimes'), 'failed');
      eq(q.fail('kill_slimes'), false, '不能重复失败');
    });

    test('可重复任务：领奖后回到可接', () => {
      const q = new QuestSystem();
      q.define({
        id: 'daily',
        name: '日常',
        objectives: [{ type: 'kill', target: 'rat', count: 2 }],
        rewards: { gold: 10 },
        repeatable: true,
      });
      q.accept('daily');
      q.report({ type: 'kill', target: 'rat', n: 2 });

      const r = q.claim('daily');
      eq(r?.gold, 10);
      eq(q.status('daily'), 'available', '可重复任务应回到可接状态');

      q.accept('daily');
      q.report({ type: 'kill', target: 'rat', n: 2 });
      eq(q.claim('daily')?.gold, 10, '可以再领一次');
    });

    test('完成回调带奖励', () => {
      const q = make();
      let got: Record<string, number> | undefined;
      q.onComplete((_id, rewards) => {
        got = rewards;
      });
      q.accept('kill_slimes');
      q.report({ type: 'kill', target: 'slime', n: 5 });
      eq(got?.exp, 100);
    });

    test('导出导入往返', () => {
      const q = make();
      q.accept('kill_slimes');
      q.report({ type: 'kill', target: 'slime', n: 3 });

      const data = q.export();
      const q2 = make();
      const skipped = q2.import(data);

      eq(skipped, 0);
      eq(q2.status('kill_slimes'), 'active');
      eq(q2.objectiveProgress('kill_slimes', 0)?.current, 3);
    });

    test('导入未知任务跳过（不崩）', () => {
      const q = make();
      const skipped = q.import([{ id: '已删除的任务', status: 'active' }]);
      eq(skipped, 1);
    });

    test('导入时目标数量变化自动补齐', () => {
      const q = new QuestSystem();
      q.define({
        id: 'x',
        name: 'X',
        objectives: [
          { type: 'kill', target: 'a', count: 1 },
          { type: 'kill', target: 'b', count: 1 },
          { type: 'kill', target: 'c', count: 1 },
        ],
      });
      // 存档里只有 1 个目标的进度（旧版本）
      q.import([{ id: 'x', status: 'active', progress: [5] }]);
      const p = q.get('x');
      eq(p?.progress.length, 3, '应补齐到 3 个');
      eq(p?.progress[0], 5);
      eq(p?.progress[2], 0);
    });

    test('重复定义抛错', () => {
      const q = make();
      throws(() =>
        q.define({ id: 'kill_slimes', name: '重复', objectives: [{ type: 'kill', target: 'x' }] })
      );
    });

    test('空目标列表抛错', () => {
      throws(() => new QuestSystem().define({ id: 'x', name: 'X', objectives: [] }));
    });

    test('defineAll 校验前置存在', () => {
      const q = new QuestSystem();
      const errors = q.defineAll([
        { id: 'a', name: 'A', objectives: [{ type: 'kill', target: 'x' }], requires: ['不存在'] },
      ]);
      eq(errors.length, 1);
      assert(errors[0].includes('不存在'), errors[0]);
    });

    test('reset 清空所有进度', () => {
      const q = make();
      q.accept('kill_slimes');
      q.report({ type: 'kill', target: 'slime', n: 5 });
      q.reset();
      eq(q.status('kill_slimes'), 'available');
      eq(q.objectiveProgress('kill_slimes', 0)?.current, 0);
    });

    test('一个事件同时推进多个任务', () => {
      const q = new QuestSystem();
      q.define({ id: 'q1', name: 'Q1', objectives: [{ type: 'kill', target: 'slime', count: 2 }] });
      q.define({ id: 'q2', name: 'Q2', objectives: [{ type: 'kill', target: 'slime', count: 3 }] });
      q.accept('q1');
      q.accept('q2');

      const changed = q.report({ type: 'kill', target: 'slime' });
      eq(changed, 2, '两个任务都应被推进');
      eq(q.objectiveProgress('q1', 0)?.current, 1);
      eq(q.objectiveProgress('q2', 0)?.current, 1);
    });
  });

  // ============================================================
  // Shop
  // ============================================================

  describe('Shop · 商店与经济', () => {
    function make(): Shop {
      const s = new Shop();
      s.defineItem({ id: 'potion', name: '药水', basePrice: 50, sellRatio: 0.5 });
      s.defineItem({ id: 'sword', name: '铁剑', basePrice: 300 });
      s.defineItem({ id: 'quest_item', name: '任务物品', basePrice: 100, sellable: false });
      return s;
    }

    test('买入价与卖出价', () => {
      const s = make();
      s.stock('potion', 10);
      eq(s.priceOf('potion', 'buy'), 50);
      eq(s.priceOf('potion', 'sell'), 25, '卖出价默认 50%');
    });

    test('购买成功', () => {
      const s = make();
      s.stock('potion', 10);
      const wallet = { gold: 200 };
      const r = s.buy('potion', 2, wallet);
      eq(r.ok, true);
      eq(r.total, 100);
      eq(wallet.gold, 100);
    });

    test('钱不够：返回差额且**不扣钱**', () => {
      const s = make();
      s.stock('sword', 1);
      const wallet = { gold: 10 };
      const r = s.buy('sword', 1, wallet);
      eq(r.ok, false);
      eq(r.reason, 'insufficient_funds');
      eq(r.need, 300);
      eq(r.have, 10);
      eq(wallet.gold, 10, '失败的购买不应扣钱');
    });

    test('库存不足：不扣钱', () => {
      const s = make();
      s.stock('potion', 3);
      const wallet = { gold: 99999 };
      const r = s.buy('potion', 5, wallet);
      eq(r.ok, false);
      eq(r.reason, 'out_of_stock');
      eq(r.available, 3);
      eq(wallet.gold, 99999, '不该扣钱');
    });

    test('库存扣减', () => {
      const s = make();
      s.stock('potion', 10);
      s.buy('potion', 3, { gold: 9999 });
      eq(s.stockOf('potion'), 7);
    });

    test('卖完变成 0', () => {
      const s = make();
      s.stock('potion', 2);
      s.buy('potion', 2, { gold: 9999 });
      eq(s.stockOf('potion'), 0);
      eq(s.isStocked('potion'), true, '还在货架上，只是数量为 0');
      eq(s.stockedItems.includes('potion'), false, '但不在"有货"列表里了');
    });

    test('无限库存（count = -1）', () => {
      const s = make();
      s.stock('potion', -1);
      eq(s.buy('potion', 999, { gold: 999999 }).ok, true);
      eq(s.stockOf('potion'), -1, '无限库存不减少');
    });

    test('出售：加钱', () => {
      const s = make();
      const wallet = { gold: 0 };
      const r = s.sell('potion', 2, wallet);
      eq(r.ok, true);
      eq(r.total, 50);   // 25 × 2
      eq(wallet.gold, 50);
    });

    test('不可出售的物品被拒', () => {
      const s = make();
      const r = s.sell('quest_item', 1, { gold: 0 });
      eq(r.ok, false);
      eq(r.reason, 'cannot_sell');
    });

    test('卖出的东西进库存（可买回）', () => {
      const s = make();
      s.stock('potion', 0);
      s.sell('potion', 3, { gold: 0 });
      eq(s.stockOf('potion'), 3, '卖出的应上架');
    });

    test('markup 商店个性倍率', () => {
      const s = make();
      s.stock('potion', 10, 1.5);
      eq(s.priceOf('potion', 'buy'), 75, '50 × 1.5');
    });

    test('定价钩子（会员折扣）', () => {
      const s = make();
      s.stock('sword', 1);
      s.setPricing((base, ctx) => {
        if (ctx.side === 'buy') return Math.round(base * 0.9);
        return base;
      });
      eq(s.priceOf('sword', 'buy'), 270, '300 × 0.9');
      eq(s.priceOf('sword', 'sell'), 150, '卖出不打折');
    });

    test('定价钩子能拿到 quantity（批量折扣）', () => {
      const s = make();
      s.stock('potion', 100);
      s.setPricing((base, ctx) => (ctx.quantity >= 10 ? Math.round(base * 0.8) : base));
      eq(s.priceOf('potion', 'buy', 1), 50);
      eq(s.priceOf('potion', 'buy', 10), 40);
    });

    test('价格不会为负', () => {
      const s = make();
      s.stock('potion', 10);
      s.setPricing(() => -100);
      eq(s.priceOf('potion', 'buy'), 0, '负价格被夹到 0');
    });

    test('preview 不改变状态', () => {
      const s = make();
      s.stock('potion', 10);
      const wallet = { gold: 100 };
      s.preview('potion', 'buy', 1, wallet);
      eq(wallet.gold, 100, '预览不该扣钱');
      eq(s.stockOf('potion'), 10, '预览不该扣库存');
    });

    test('canAfford', () => {
      const s = make();
      s.stock('sword', 1);
      eq(s.canAfford('sword', 1, { gold: 100 }), false);
      eq(s.canAfford('sword', 1, { gold: 300 }), true);
    });

    test('未知商品', () => {
      const s = make();
      eq(s.buy('不存在', 1, { gold: 999 }).reason, 'unknown_item');
      eq(s.sell('不存在', 1, { gold: 0 }).reason, 'unknown_item');
    });

    test('未上架不能买', () => {
      const s = make();
      const r = s.buy('potion', 1, { gold: 999 });
      eq(r.ok, false);
      eq(r.reason, 'out_of_stock');
    });

    test('多货币：各算各的账', () => {
      const s = make();
      s.stock('potion', 100);

      // 注意：药水 50 金币，gem 也要给够，否则是"钱不够"而不是"货币分账"的问题
      const w1 = { gold: 1000, gem: 1000 };
      s.buy('potion', 1, w1, 'gold');
      s.buy('potion', 1, w1, 'gem');

      eq(w1.gold, 950);
      eq(w1.gem, 950);

      eq(s.netSpent('gold'), 50, '金币账只算金币');
      eq(s.netSpent('gem'), 50, '钻石账只算钻石');
      eq(s.countLog('gold'), 1);
      eq(s.countLog('gem'), 1);
      eq(s.countLog(), 2, '总流水 2 条');
    });

    test('净支出计算（买为正，卖为负）', () => {
      const s = make();
      s.stock('potion', 100);
      const w = { gold: 1000 };
      s.buy('potion', 4, w);      // 花 200
      s.sell('potion', 2, w);     // 赚 50
      eq(s.netSpent('gold'), 150);
    });

    test('restock 随机补货可复现', () => {
      const s1 = make();
      s1.stock('potion', 0); s1.stock('sword', 0); s1.stock('quest_item', 0);
      const picked1 = s1.restock(new RNG(42), 3);

      const s2 = make();
      s2.stock('potion', 0); s2.stock('sword', 0); s2.stock('quest_item', 0);
      const picked2 = s2.restock(new RNG(42), 3);

      eq(picked1.join(','), picked2.join(','), '同种子应得到相同结果');
    });

    test('restock 不重复选同一商品', () => {
      const s = make();
      s.stock('potion', 0); s.stock('sword', 0); s.stock('quest_item', 0);
      const picked = s.restock(new RNG(1), 3);
      eq(new Set(picked).size, 3, '不应重复');
    });

    test('clearStock 清空货架', () => {
      const s = make();
      s.stock('potion', 10);
      s.clearStock();
      eq(s.stockOf('potion'), 0);
      eq(s.isStocked('potion'), false);
    });

    test('负价格定义抛错', () => {
      throws(() => new Shop().defineItem({ id: 'x', name: 'X', basePrice: -1 }));
    });
  });

  // ============================================================
  // CraftSystem
  // ============================================================

  describe('CraftSystem · 合成系统', () => {
    function make(): { craft: CraftSystem; bag: TestBag } {
      const bag = new TestBag();
      const craft = new CraftSystem(new RNG(1));
      craft.define({
        id: 'iron_ingot',
        name: '铁锭',
        inputs: [{ itemId: 'iron_ore', count: 2 }],
        output: { itemId: 'iron_ingot', count: 1 },
      });
      craft.define({
        id: 'iron_sword',
        name: '铁剑',
        inputs: [
          { itemId: 'iron_ingot', count: 3 },
          { itemId: 'wood', count: 1 },
        ],
        output: { itemId: 'iron_sword', count: 1 },
      });
      return { craft, bag };
    }

    test('材料足够时合成成功', () => {
      const { craft, bag } = make();
      bag.set('iron_ore', 4);
      const r = craft.craft('iron_ingot', bag);
      eq(r.ok, true);
      eq(bag.count('iron_ore'), 2, '消耗 2 个矿石');
      eq(bag.count('iron_ingot'), 1);
    });

    test('材料不足：不消耗任何材料（原子性）', () => {
      const { craft, bag } = make();
      bag.set('iron_ore', 1);      // 需要 2 个
      const r = craft.craft('iron_ingot', bag);
      eq(r.ok, false);
      eq(r.reason, 'missing_materials');
      eq(bag.count('iron_ore'), 1, '材料必须分毫未动');
      eq(r.missing?.[0].itemId, 'iron_ore');
      eq(r.missing?.[0].need, 2);
      eq(r.missing?.[0].have, 1);
    });

    test('背包满时回滚：材料不消失（头号事故防护）', () => {
      const { craft, bag } = make();
      bag.set('iron_ore', 10);
      bag.capacity = 10;            // 背包容量 10，已有 10 个矿石 → 满了

      const r = craft.craft('iron_ingot', bag);
      eq(r.ok, false);
      eq(r.reason, 'output_failed');
      eq(bag.count('iron_ore'), 10, '**材料必须还在**——这是最关键的断言');
      eq(bag.count('iron_ingot'), 0);
    });

    test('多材料：部分不足时全部不动', () => {
      const { craft, bag } = make();
      bag.set('iron_ingot', 3);
      bag.set('wood', 0);           // 缺木头

      const r = craft.craft('iron_sword', bag);
      eq(r.ok, false);
      eq(bag.count('iron_ingot'), 3, '够的材料也不能扣');
    });

    test('maxCount 计算产能', () => {
      const { craft, bag } = make();
      bag.set('iron_ore', 7);
      eq(craft.canCraft('iron_ingot', bag).maxCount, 3, '7 / 2 = 3');
    });

    test('maxCount 取最小值（木桶效应）', () => {
      const { craft, bag } = make();
      bag.set('iron_ingot', 30);    // 够做 10 把
      bag.set('wood', 2);           // 只够做 2 把
      eq(craft.canCraft('iron_sword', bag).maxCount, 2);
    });

    test('消耗型 vs 检查型材料', () => {
      const bag = new TestBag();
      const craft = new CraftSystem();
      craft.define({
        id: 'forge',
        name: '锻造',
        inputs: [
          { itemId: 'iron_ore', count: 2 },
          { itemId: 'anvil', count: 1, consume: false },   // 铁砧不消耗
        ],
        output: { itemId: 'sword', count: 1 },
      });

      bag.set('iron_ore', 2);
      bag.set('anvil', 1);

      const r = craft.craft('forge', bag);
      eq(r.ok, true);
      eq(bag.count('iron_ore'), 0, '矿石被消耗');
      eq(bag.count('anvil'), 1, '铁砧不该被消耗');
    });

    test('检查型材料不限制产能', () => {
      const bag = new TestBag();
      const craft = new CraftSystem();
      craft.define({
        id: 'forge',
        name: '锻造',
        inputs: [
          { itemId: 'ore', count: 1 },
          { itemId: 'anvil', count: 1, consume: false },
        ],
        output: { itemId: 'sword', count: 1 },
      });
      bag.set('ore', 5);
      bag.set('anvil', 1);
      eq(craft.canCraft('forge', bag).maxCount, 5, '铁砧只有 1 个但不限制产量');
    });

    test('嵌套合成树展开', () => {
      const { craft } = make();
      // 铁剑 = 3 铁锭 + 1 木头；铁锭 = 2 矿石
      // 所以铁剑 = 6 矿石 + 1 木头
      const total = craft.totalMaterials('iron_sword', 1);
      eq(total['iron_ore'], 6);
      eq(total['wood'], 1);
    });

    test('合成树抵扣已有中间产物', () => {
      const { craft, bag } = make();
      bag.set('iron_ingot', 1);     // 已有 1 个铁锭
      // 需要 3 个铁锭，已有 1 → 还缺 2 个 → 2 × 2 = 4 个矿石
      const total = craft.totalMaterials('iron_sword', 1, bag);
      eq(total['iron_ore'], 4, '应抵扣已有的 1 个铁锭');
    });

    test('合成树防循环', () => {
      const craft = new CraftSystem();
      // 故意造一个环：A 需要 B，B 需要 A
      craft.define({
        id: 'a', name: 'A',
        inputs: [{ itemId: 'b', count: 1 }],
        output: { itemId: 'a', count: 1 },
      });
      craft.define({
        id: 'b', name: 'B',
        inputs: [{ itemId: 'a', count: 1 }],
        output: { itemId: 'b', count: 1 },
      });
      // 不应栈溢出
      const total = craft.totalMaterials('a', 1);
      assert(total !== undefined, '应正常返回而不是崩溃');
    });

    test('品质随机（变体）', () => {
      const bag = new TestBag();
      bag.set('ore', 1000);
      const craft = new CraftSystem(new RNG(7));
      craft.define({
        id: 'forge',
        name: '锻造',
        inputs: [{ itemId: 'ore', count: 1 }],
        output: {
          itemId: 'sword_common',
          count: 1,
          variants: [
            { itemId: 'sword_common', weight: 70 },
            { itemId: 'sword_rare', weight: 25 },
            { itemId: 'sword_epic', weight: 5 },
          ],
        },
      });

      // 做 200 次，应该出过稀有和史诗
      const got = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const r = craft.craft('forge', bag);
        if (r.ok && r.produced) for (const p of r.produced) got.add(p.itemId);
      }
      assert(got.size > 1, `应该出过多种品质，实际：${Array.from(got).join(',')}`);
    });

    test('无随机源时取第一个变体（确定性）', () => {
      const bag = new TestBag();
      bag.set('ore', 10);
      const craft = new CraftSystem();   // 不传 rng
      craft.define({
        id: 'forge', name: '锻造',
        inputs: [{ itemId: 'ore', count: 1 }],
        output: {
          itemId: 'x', count: 1,
          variants: [
            { itemId: 'common', weight: 1 },
            { itemId: 'epic', weight: 99 },
          ],
        },
      });
      const r = craft.craft('forge', bag);
      eq(r.produced?.[0].itemId, 'common', '无 rng 时取第一个，不是权重最大的');
    });

    test('副产物', () => {
      const bag = new TestBag();
      bag.set('ore', 100);
      const craft = new CraftSystem(new RNG(1));
      craft.define({
        id: 'smelt', name: '冶炼',
        inputs: [{ itemId: 'ore', count: 1 }],
        output: { itemId: 'ingot', count: 1 },
        byproducts: [{ itemId: 'slag', count: 1 }],
      });

      const r = craft.craft('smelt', bag);
      eq(r.ok, true);
      eq(bag.count('ingot'), 1);
      eq(bag.count('slag'), 1, '副产物应进背包');
    });

    test('解锁图纸', () => {
      const bag = new TestBag();
      bag.set('ore', 10);
      const craft = new CraftSystem();
      craft.define({
        id: 'secret', name: '秘方',
        inputs: [{ itemId: 'ore', count: 1 }],
        output: { itemId: 'artifact', count: 1 },
        requiresUnlock: true,
      });

      eq(craft.isUnlocked('secret'), false);
      eq(craft.craft('secret', bag).reason, 'locked');
      eq(bag.count('ore'), 10, '锁着的配方不该消耗材料');

      craft.unlock('secret');
      eq(craft.craft('secret', bag).ok, true);
    });

    test('findCraftable 反向查询', () => {
      const { craft, bag } = make();
      bag.set('iron_ore', 4);       // 只够做铁锭
      const list = craft.findCraftable(bag);
      eq(list.includes('iron_ingot'), true);
      eq(list.includes('iron_sword'), false, '材料不够不该列出来');
    });

    test('byStation 按工作台筛选', () => {
      const craft = new CraftSystem();
      craft.define({ id: 'a', name: 'A', station: 'forge', inputs: [{ itemId: 'x', count: 1 }], output: { itemId: 'y', count: 1 } });
      craft.define({ id: 'b', name: 'B', station: 'alchemy', inputs: [{ itemId: 'x', count: 1 }], output: { itemId: 'z', count: 1 } });

      eq(craft.byStation('forge').join(','), 'a');
      eq(craft.byStation('alchemy').join(','), 'b');
    });

    test('批量合成', () => {
      const { craft, bag } = make();
      bag.set('iron_ore', 10);
      const r = craft.craft('iron_ingot', bag, 5);
      eq(r.ok, true);
      eq(bag.count('iron_ore'), 0, '5 × 2 = 10 全消耗');
      eq(bag.count('iron_ingot'), 5);
    });

    test('未知配方', () => {
      const { craft, bag } = make();
      eq(craft.craft('不存在', bag).reason, 'unknown_recipe');
    });

    test('数量为 0 时失败', () => {
      const { craft, bag } = make();
      bag.set('iron_ore', 10);
      const r = craft.craft('iron_ingot', bag, 0);
      eq(r.ok, false);
      eq(bag.count('iron_ore'), 10, '不该消耗');
    });

    test('重复定义抛错', () => {
      const { craft } = make();
      throws(() =>
        craft.define({ id: 'iron_ingot', name: '重复', inputs: [{ itemId: 'x', count: 1 }], output: { itemId: 'y', count: 1 } })
      );
    });

    test('空输入抛错', () => {
      throws(() =>
        new CraftSystem().define({ id: 'x', name: 'X', inputs: [], output: { itemId: 'y', count: 1 } })
      );
    });
  });
}
