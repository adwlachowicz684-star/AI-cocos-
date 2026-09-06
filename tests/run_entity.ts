/**
 * entity 测试（46 项）
 *
 * 【测试重点】
 * 注册表最危险的不是"加不进去"，而是：
 *   ① id 复用导致打到错误的实体（ABA 问题）
 *   ② 死亡结算重复触发（掉落翻倍）
 *   ③ 遍历中删除导致跳过或越界（连锁死亡）
 *
 * 这三类都**不抛异常**，只能靠测试锁住。
 */

import { describe, test, assert, eq, throws } from './_framework';
import {
  EntityRegistry, EntityIndex,
  idIndex, idGeneration, makeId, isValidId,
  INVALID_ID, SLOT_CAPACITY,
} from '../entity/EntityRegistry';

interface Enemy {
  name: string;
  hp: number;
}

export function runEntityTests(): void {
  // ============================================================
  describe('EntityRegistry · id 编码', () => {
    test('makeId / idIndex / idGeneration 往返', () => {
      const id = makeId(7, 3);
      eq(idIndex(id), 7, 'index');
      eq(idGeneration(id), 3, 'generation');
    });

    test('⚠️ 用乘法而不是位移（32 位溢出）', () => {
      /**
       * 【为什么必须测】
       * 第一版写成 `(gen << 20) | index`。
       * JS 位运算是 32 位有符号：`2048 << 20` 溢出成负数。
       * 后果：槽位复用 2048 次后实体凭空消失——
       * 长会话游戏跑几小时就会撞上。
       */
      const bigGen = 2048;
      const id = makeId(1, bigGen);
      assert(id > 0, `id 必须为正，实际 ${id}`);
      eq(idGeneration(id), bigGen, '大版本号仍能正确解出');
      eq(idIndex(id), 1, 'index 不受影响');
      eq(isValidId(id), true, '仍判定为合法');
    });

    test('⚠️ 极大版本号仍正确', () => {
      const id = makeId(SLOT_CAPACITY - 1, 100000);
      eq(idIndex(id), SLOT_CAPACITY - 1, 'index 取最大');
      eq(idGeneration(id), 100000, 'gen');
      assert(Number.isSafeInteger(id), '必须是安全整数');
    });

    test('isValidId 排除非法值', () => {
      eq(isValidId(INVALID_ID), false, 'INVALID_ID=0');
      eq(isValidId(-1), false, '负数');
      eq(isValidId(1.5), false, '非整数');
      eq(isValidId(makeId(0, 1)), false, 'index=0 被 INVALID_ID 占用');
      eq(isValidId(makeId(1, 0)), true, '正常 id');
    });
  });

  // ============================================================
  describe('EntityRegistry · 生成与查询', () => {
    test('spawn 返回合法 id', () => {
      const r = new EntityRegistry<Enemy>();
      const id = r.spawn({ name: 'a', hp: 10 });
      assert(isValidId(id), 'id 合法');
      assert(id > 0, '正数');
    });

    test('get 取回记录，entity 是同一引用', () => {
      const r = new EntityRegistry<Enemy>();
      const e = { name: '骷髅兵', hp: 30 };
      const id = r.spawn(e);
      eq(r.get(id)?.entity === e, true, '同一引用（不是拷贝）');
    });

    test('⚠️ 不存在的 id 返回 null（不是抛错）', () => {
      const r = new EntityRegistry<Enemy>();
      eq(r.get(99999), null, '越界');
      eq(r.get(INVALID_ID), null, 'INVALID_ID');
      eq(r.get(-5), null, '负数');
      eq(r.getEntity<Enemy>(99999), null, 'getEntity 同样');
      /**
       * 【为什么不能抛错】
       * "技能打空"变成"游戏崩溃"，玩家体验极差。
       */
    });

    test('exists / isAlive 区分尸体', () => {
      const r = new EntityRegistry<Enemy>();
      const id = r.spawn({ name: 'a', hp: 1 });
      eq(r.exists(id), true, '存在');
      eq(r.isAlive(id), true, '存活');
      r.kill(id);
      eq(r.exists(id), true, '尸体仍存在');
      eq(r.isAlive(id), false, '但不存活');
      r.destroy(id);
      eq(r.exists(id), false, '销毁后不存在');
    });

    test('liveCount / slotCount', () => {
      const r = new EntityRegistry<Enemy>();
      eq(r.liveCount, 0, '初始');
      const a = r.spawn({ name: 'a', hp: 1 });
      r.spawn({ name: 'b', hp: 1 });
      eq(r.liveCount, 2, '2 个活的');
      eq(r.slotCount, 2, '2 个槽位');
      r.kill(a);
      eq(r.liveCount, 1, '活着的少一个');
      eq(r.slotCount, 2, '尸体仍占槽位');
      r.destroy(a);
      eq(r.slotCount, 1, '销毁后槽位释放');
    });
  });

  // ============================================================
  describe('EntityRegistry · ⚠️ id 版本号（ABA 防护）', () => {
    test('销毁后旧 id 永久失效', () => {
      const r = new EntityRegistry<Enemy>();
      const a = r.spawn({ name: '旧', hp: 1 });
      r.destroy(a);
      const b = r.spawn({ name: '新', hp: 1 });

      assert(a !== b, '新 id 必须与旧 id 不同');
      eq(r.get(a), null, '旧引用查不到（而不是打到新实体）');
      eq(r.getEntity<Enemy>(a)?.name, undefined, '这是"打错人"的解药');
      eq(r.getEntity<Enemy>(b)?.name, '新', '新 id 正常');
    });

    test('⚠️ 槽位复用多次后旧 id 仍失效', () => {
      const r = new EntityRegistry<Enemy>();
      const ids: number[] = [];
      for (let i = 0; i < 100; i++) {
        const id = r.spawn({ name: `e${i}`, hp: 1 });
        ids.push(id);
        r.destroy(id);
      }
      // 所有旧 id 都必须查不到
      for (const id of ids) {
        eq(r.get(id), null, `旧 id ${id} 应失效`);
      }
    });

    test('⚠️ clear 后旧 id 不能复活（换关卡）', () => {
      /**
       * 【这条最隐蔽】
       * 第一版 clear() 重置版本号，结果：
       *   exists(上一关的 id) === true
       * 残留的技能引用会打在新关卡的怪身上。
       * 只在换关时发生，极难复现。
       */
      const r = new EntityRegistry<Enemy>();
      const oldId = r.spawn({ name: '上一关的怪', hp: 1 });
      r.clear();

      eq(r.exists(oldId), false, '上一关的 id 必须失效');
      eq(r.get(oldId), null, '取不到记录');

      // 新关卡生成
      const newId = r.spawn({ name: '这一关的怪', hp: 1 });
      assert(newId !== oldId, '新实体不能复用旧 id');
      eq(r.get(newId)?.entity.name, '这一关的怪', '新实体正常');
    });

    test('⚠️ clear 后仍用旧槽位也不复活（gen 递增而非重置）', () => {
      const r = new EntityRegistry<Enemy>();
      const a = r.spawn({ name: 'a', hp: 1 });
      r.clear();
      const b = r.spawn({ name: 'b', hp: 1 });

      // clear 后槽位从头分配，index 可能与 a 相同，但 gen 不同
      eq(idIndex(a), idIndex(b), 'index 会复用');
      assert(idGeneration(b) > idGeneration(a), '版本号必须递增');
      assert(b !== a, '完整 id 不同');
      eq(r.get(a), null, '旧 id 失效');
    });
  });

  // ============================================================
  describe('EntityRegistry · 别名与碰撞体映射', () => {
    test('判定框 id → 实体', () => {
      const r = new EntityRegistry<Enemy>();
      const boss = { name: '骨王', hp: 999 };
      const id = r.spawn(boss, { hitboxIds: ['boss-body', 'boss-weak'] });

      eq(r.fromAlias('boss-body'), id, '身体框');
      eq(r.fromAlias('boss-weak'), id, '弱点框（同一实体）');
      eq(r.entityFromAlias<Enemy>('boss-weak') === boss, true, '取回业务对象');
    });

    test('⚠️ 多个判定框命中同一实体（多对一）', () => {
      const r = new EntityRegistry<Enemy>();
      const a = r.spawn({ name: 'A', hp: 10 }, { hitboxIds: ['a-body', 'a-weak'] });
      const b = r.spawn({ name: 'B', hp: 10 }, { hitboxIds: ['b-body'] });

      eq(r.fromAlias('a-body'), a, 'A 的身体');
      eq(r.fromAlias('a-weak'), a, 'A 的弱点 → 还是 A');
      eq(r.fromAlias('b-body'), b, 'B');
      assert(r.fromAlias('a-weak') !== r.fromAlias('b-body'), '不同实体');
    });

    test('不存在的别名返回 INVALID_ID', () => {
      const r = new EntityRegistry<Enemy>();
      eq(r.fromAlias('nope'), INVALID_ID, '别名');
      eq(r.entityFromAlias('nope'), null, '取对象');
    });

    test('碰撞体 id → 实体', () => {
      const r = new EntityRegistry<Enemy>();
      const id = r.spawn({ name: 'a', hp: 1 }, { colliderId: 1001 });
      eq(r.fromCollider(1001), id, '映射');
      eq(r.fromCollider(9999), INVALID_ID, '不存在');
    });

    test('⚠️ 销毁后别名与碰撞体映射被清理', () => {
      const r = new EntityRegistry<Enemy>();
      const id = r.spawn({ name: 'a', hp: 1 }, { hitboxIds: ['a-body'], colliderId: 1001 });
      r.destroy(id);
      eq(r.fromAlias('a-body'), INVALID_ID, '别名清理');
      eq(r.fromCollider(1001), INVALID_ID, '碰撞体清理');
    });
  });

  // ============================================================
  describe('EntityRegistry · 死亡与销毁', () => {
    test('kill 保留记录（尸体还在）', () => {
      const r = new EntityRegistry<Enemy>();
      const id = r.spawn({ name: '尸体', hp: 0 });
      r.kill(id);
      eq(r.exists(id), true, '尸体仍可查询');
      eq(r.get(id)?.entity.name, '尸体', '还能拿到数据');
      eq(r.get(id)?.deathReason, 'killed', '死因');
      assert(r.get(id)!.deadFrame >= 0, '记录了死亡帧');
    });

    test('⚠️ kill 重复调用时回调只触发一次', () => {
      /**
       * 【为什么关键】
       * "一帧内被两发子弹打死"会掉两份装备——
       * 而这是玩家会主动利用的漏洞。
       */
      const r = new EntityRegistry<Enemy>();
      let drops = 0;
      r.onDeath(() => { drops++; });

      const id = r.spawn({ name: 'a', hp: 1 });
      eq(r.kill(id), true, '第一次成功');
      eq(r.kill(id), false, '第二次返回 false');
      eq(drops, 1, '掉落只有 1 份');
    });

    test('⚠️ destroy 活着的实体也触发死亡回调', () => {
      /**
       * 【为什么】
       * 换关卡时直接 destroy 全场，如果不触发死亡回调，
       * "击杀计数"类成就就会**只在换关时**漏——极难发现。
       */
      const r = new EntityRegistry<Enemy>();
      const reasons: string[] = [];
      r.onDeath((_id, _e, reason) => { reasons.push(reason); });

      const id = r.spawn({ name: 'a', hp: 1 });
      r.destroy(id);
      eq(reasons.length, 1, '触发了');
      eq(reasons[0], 'destroyed', 'reason 是 destroyed');
    });

    test('kill 的自定义 reason', () => {
      const r = new EntityRegistry<Enemy>();
      const reasons: string[] = [];
      r.onDeath((_i, _e, reason) => { reasons.push(reason); });
      const id = r.spawn({ name: 'a', hp: 1 });
      r.kill(id, 'fall');
      eq(reasons[0], 'fall', '自定义死因');
    });

    test('死亡回调能拿到实体（用于掉落）', () => {
      const r = new EntityRegistry<Enemy>();
      const loot: string[] = [];
      r.onDeath((_id, entity) => { loot.push(`${entity.name}的掉落`); });
      const id = r.spawn({ name: '哥布林', hp: 1 });
      r.kill(id);
      eq(loot[0], '哥布林的掉落', '回调收到实体');
    });

    test('onDeath 可取消', () => {
      const r = new EntityRegistry<Enemy>();
      let n = 0;
      const off = r.onDeath(() => { n++; });
      const a = r.spawn({ name: 'a', hp: 1 });
      r.kill(a);
      eq(n, 1, '生效');
      off();
      const b = r.spawn({ name: 'b', hp: 1 });
      r.kill(b);
      eq(n, 1, '取消后不再触发');
    });

    test('onSpawn / onDestroy', () => {
      const r = new EntityRegistry<Enemy>();
      const log: string[] = [];
      r.onSpawn((_id, e) => { log.push(`spawn:${e.name}`); });
      r.onDestroy((id) => { log.push(`destroy:${idIndex(id)}`); });

      const a = r.spawn({ name: 'a', hp: 1 });
      r.destroy(a);
      eq(log.length, 2, '两个回调');
      assert(log[0].startsWith('spawn:'), '先 spawn');
      assert(log[1].startsWith('destroy:'), '后 destroy');
    });

    test('销毁不存在的 id 返回 false', () => {
      const r = new EntityRegistry<Enemy>();
      eq(r.destroy(99999), false, '越界');
      eq(r.destroy(INVALID_ID), false, 'INVALID_ID');
      eq(r.kill(99999), false, 'kill 同样');
    });
  });

  // ============================================================
  describe('EntityRegistry · ⚠️ 遍历安全（连锁死亡）', () => {
    test('遍历中 destroy 不崩溃且被推迟', () => {
      /**
       * 【为什么关键】
       * "爆炸桶炸死一片"——回调里销毁其他实体，
       * 就地删除会导致跳过或越界。
       */
      const r = new EntityRegistry<Enemy>();
      for (let i = 0; i < 5; i++) r.spawn({ name: `e${i}`, hp: 1 });

      const seen: string[] = [];
      let exploded = false;
      r.forEach((rec) => {
        seen.push(rec.entity.name);
        if (rec.entity.name === 'e2' && !exploded) {
          exploded = true;
          // 炸死后面所有
          for (const other of r.snapshot()) {
            if (other.entity.name !== 'e2') r.destroy(other.id);
          }
        }
      });

      eq(seen.length, 5, '本次遍历看到全部 5 个（没被跳过）');
    });

    test('⚠️ 推迟的 destroy 在遍历结束后执行', () => {
      const r = new EntityRegistry<Enemy>();
      const a = r.spawn({ name: 'a', hp: 1 });
      r.spawn({ name: 'b', hp: 1 });

      r.forEach(() => { r.destroy(a); });
      // 遍历结束后才真正销毁
      eq(r.exists(a), false, '遍历结束后已销毁');
    });

    test('⚠️ 回调里 spawn 不会让遍历无限延长', () => {
      const r = new EntityRegistry<Enemy>();
      r.spawn({ name: 'a', hp: 1 });

      let count = 0;
      r.forEach(() => {
        count++;
        if (count < 10) r.spawn({ name: 'new', hp: 1 });   // 疯狂生成
      });
      eq(count, 1, '只遍历了快照里的 1 个（用快照长度）');
    });

    test('嵌套遍历安全', () => {
      const r = new EntityRegistry<Enemy>();
      r.spawn({ name: 'a', hp: 1 });
      r.spawn({ name: 'b', hp: 1 });

      let outer = 0;
      let inner = 0;
      r.forEach(() => {
        outer++;
        r.forEach(() => { inner++; });
      });
      eq(outer, 2, '外层 2 次');
      eq(inner, 4, '内层 2×2');
    });

    test('snapshot 默认只要活的', () => {
      const r = new EntityRegistry<Enemy>();
      const a = r.spawn({ name: 'a', hp: 1 });
      const b = r.spawn({ name: 'b', hp: 1 });
      r.kill(a);
      eq(r.snapshot().length, 1, '默认排除尸体');
      eq(r.snapshot(false).length, 2, '含尸体');
      void b;
    });

    test('⚠️ forEach 跳过遍历期间已死亡的实体', () => {
      const r = new EntityRegistry<Enemy>();
      const a = r.spawn({ name: 'a', hp: 1 });
      const b = r.spawn({ name: 'b', hp: 1 });
      r.spawn({ name: 'c', hp: 1 });

      const seen: string[] = [];
      r.forEach((rec) => {
        seen.push(rec.entity.name);
        if (rec.entity.name === 'a') r.kill(b);   // 遍历中杀死 b
      });
      eq(seen.includes('b'), false, 'b 已被跳过');
      eq(seen.includes('c'), true, 'c 仍被遍历');
      void a;
    });
  });

  // ============================================================
  describe('EntityRegistry · 标签', () => {
    test('addTag / hasTag / removeTag', () => {
      const r = new EntityRegistry<Enemy>();
      const id = r.spawn({ name: 'a', hp: 1 }, { tags: ['enemy'] });
      eq(r.hasTag(id, 'enemy'), true, '初始标签');
      r.addTag(id, 'boss');
      eq(r.hasTag(id, 'boss'), true, '新增');
      r.removeTag(id, 'enemy');
      eq(r.hasTag(id, 'enemy'), false, '移除');
    });

    test('query 默认排除尸体', () => {
      const r = new EntityRegistry<Enemy>();
      const a = r.spawn({ name: 'a', hp: 1 }, { tags: ['enemy'] });
      r.spawn({ name: 'b', hp: 1 }, { tags: ['enemy'] });
      eq(r.query('enemy').length, 2, '2 个');
      r.kill(a);
      eq(r.query('enemy').length, 1, '尸体被排除（AOE 不该打到尸体）');
      eq(r.query('enemy', false).length, 2, '显式包含');
      /**
       * 【为什么默认排除】
       * AOE 打到尸体 → 尸体又掉一次物品。
       */
    });

    test('queryAll 同时满足多个标签', () => {
      const r = new EntityRegistry<Enemy>();
      const boss = r.spawn({ name: 'boss', hp: 1 }, { tags: ['enemy', 'boss'] });
      r.spawn({ name: 'mob', hp: 1 }, { tags: ['enemy'] });
      eq(r.queryAll(['enemy', 'boss']).length, 1, '只有 boss');
      eq(r.queryAll(['enemy', 'boss'])[0], boss, 'id 正确');
    });

    test('对不存在的 id 操作标签返回 false', () => {
      const r = new EntityRegistry<Enemy>();
      eq(r.addTag(99999, 'x'), false, 'addTag');
      eq(r.removeTag(99999, 'x'), false, 'removeTag');
      eq(r.hasTag(99999, 'x'), false, 'hasTag');
    });
  });

  // ============================================================
  describe('EntityRegistry · 帧与统计', () => {
    test('tick 推进帧', () => {
      const r = new EntityRegistry<Enemy>();
      eq(r.frame, 0, '初始');
      r.tick();
      r.tick();
      eq(r.frame, 2, '推进 2 帧');
    });

    test('bornFrame / deadFrame 记录正确', () => {
      const r = new EntityRegistry<Enemy>();
      r.tick();
      r.tick();
      const id = r.spawn({ name: 'a', hp: 1 });
      eq(r.get(id)?.bornFrame, 2, '生成帧');
      r.tick();
      r.kill(id);
      eq(r.get(id)?.deadFrame, 3, '死亡帧');
    });

    test('clear 后统计归零', () => {
      const r = new EntityRegistry<Enemy>();
      r.spawn({ name: 'a', hp: 1 }, { tags: ['enemy'] });
      r.spawn({ name: 'b', hp: 1 });
      r.clear();
      eq(r.liveCount, 0, '存活 0');
      eq(r.slotCount, 0, '槽位 0');
      eq(r.query('enemy').length, 0, '查不到');
    });

    test('describe 可读', () => {
      const r = new EntityRegistry<Enemy>();
      r.spawn({ name: 'a', hp: 1 });
      const s = r.describe();
      assert(s.includes('EntityRegistry'), '含类名');
      assert(s.includes('存活 1'), '含存活数');
    });
  });

  // ============================================================
  describe('EntityIndex · 对象 → id 反向索引', () => {
    test('bind / idOf', () => {
      const idx = new EntityIndex();
      const e = { name: 'a', hp: 1 };
      idx.bind(e, 42);
      eq(idx.idOf(e), 42, '取回 id');
    });

    test('未绑定返回 INVALID_ID', () => {
      const idx = new EntityIndex();
      eq(idx.idOf({ name: 'x', hp: 1 }), INVALID_ID, '未绑定');
    });

    test('unbind / has', () => {
      const idx = new EntityIndex();
      const e = { name: 'a', hp: 1 };
      eq(idx.has(e), false, '未绑定');
      idx.bind(e, 1);
      eq(idx.has(e), true, '已绑定');
      eq(idx.unbind(e), true, '解绑成功');
      eq(idx.unbind(e), false, '重复解绑返回 false');
      eq(idx.has(e), false, '已解绑');
    });
  });

  // ============================================================
  describe('EntityRegistry · 完整链路', () => {
    test('一场战斗：生成 → 命中判定框 → 死亡 → 掉落 → 清理', () => {
      const r = new EntityRegistry<Enemy>();
      const dropped: string[] = [];
      const hitboxes = new Set(['boss-body', 'boss-weak']);

      r.onDeath((id, entity) => {
        dropped.push(`${entity.name}掉落`);
        // 移除判定框（模拟 hitbox 子系统清理）
        for (const hb of ['boss-body', 'boss-weak']) hitboxes.delete(hb);
        void id;
      });

      const bossId = r.spawn({ name: '骨王', hp: 100 }, {
        tags: ['enemy', 'boss'],
        hitboxIds: ['boss-body', 'boss-weak'],
      });

      // ① 命中弱点框 → 反查实体
      const hitBoxId = 'boss-weak';
      const targetId = r.fromAlias(hitBoxId);
      eq(targetId, bossId, '判定框 → 实体 id');

      const boss = r.getEntity<Enemy>(targetId)!;
      boss.hp -= 150;

      // ② 业务侧判断死亡
      if (boss.hp <= 0) r.kill(targetId);

      eq(dropped.length, 1, '掉了一份');
      eq(hitboxes.size, 0, '判定框已移除');
      eq(r.isAlive(bossId), false, '已死');
      eq(r.query('boss').length, 0, '查询不到（已死）');

      // ③ 尸体消失
      r.destroy(bossId);
      eq(r.exists(bossId), false, '彻底移除');
      eq(r.fromAlias('boss-weak'), INVALID_ID, '别名也清理了');
    });

    test('⚠️ 换关卡：残留引用不会打到新关卡的怪', () => {
      const r = new EntityRegistry<Enemy>();

      // 第一关
      const oldBoss = r.spawn({ name: '第一关Boss', hp: 1 });
      const staleRef = oldBoss;              // 某个技能还持有这个 id

      r.clear();

      // 第二关
      r.spawn({ name: '第二关小怪', hp: 1 });

      // 残留的技能引用打空，而不是打中小怪
      eq(r.getEntity<Enemy>(staleRef), null, '残留引用取不到实体');
      eq(r.isAlive(staleRef), false, '不存活');
    });

    test('爆炸桶连锁：遍历中安全销毁一片', () => {
      const r = new EntityRegistry<Enemy>();
      const barrel = r.spawn({ name: '桶', hp: 1 }, { tags: ['barrel'] });
      for (let i = 0; i < 4; i++) r.spawn({ name: `怪${i}`, hp: 1 }, { tags: ['enemy'] });

      const killed: string[] = [];
      r.onDeath((_id, e) => { killed.push(e.name); });

      // 桶爆炸，炸死所有 enemy
      r.forEach((rec) => {
        if (rec.id === barrel) {
          for (const e of r.query('enemy')) r.kill(e);
        }
      });

      eq(killed.length, 4, '炸死 4 个');
      eq(r.query('enemy').length, 0, '敌人全灭');
      eq(r.liveCount, 1, '只剩桶（遍历安全）');
    });

    test('onSpawn 里能立刻查到实体', () => {
      const r = new EntityRegistry<Enemy>();
      let found = false;
      r.onSpawn((id) => { found = r.isAlive(id); });
      r.spawn({ name: 'a', hp: 1 });
      eq(found, true, 'spawn 回调里已可查询');
    });

    test('大量生成销毁后统计仍正确', () => {
      const r = new EntityRegistry<Enemy>();
      for (let i = 0; i < 500; i++) {
        const id = r.spawn({ name: `e${i}`, hp: 1 });
        if (i % 2 === 0) r.destroy(id);
      }
      eq(r.liveCount, 250, '存活 250');
      eq(r.slotCount, 250, '槽位 250');
    });
  });

  // 保留 throws 的引用（用于未来的错误路径测试）
  void (throws as unknown);
}
