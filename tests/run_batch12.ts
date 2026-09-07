/**
 * tests/run_batch12.ts —— 第十一批测试：孤儿插件收尾
 *
 * 背景：
 * `skill-variant` / `blessing` / `curse` / `interact` 四个目录里的代码
 * 已经写完（文档头、注释、坑说明齐全），
 * 但**从来没被测试覆盖过、也没登记进 _kitmeta.json**。
 *
 * 这是一个值得记下来的教训：
 * 代码写完了 ≠ 交付了。没有测试的插件，
 * 和"我以为我做过"没什么区别——
 * 下一次改动它时，你没有任何东西告诉你改坏了。
 *
 * 本文件为这四个模块补齐测试，并顺带检查
 * 它们与已有插件的重复实现（applyPatch / deepClone）。
 */

import { test, describe, assert, eq, near, throws } from './_framework';
import {
  SkillVariantSystem,
  applyPatch,
  deepClone,
  type VariantDef,
} from '../skill-variant/SkillVariant';
import {
  BlessingSystem,
  type BlessingDef,
  type BlessingSystemOptions,
} from '../blessing/Blessing';
import {
  CurseSystem,
  type CurseDef,
} from '../curse/Curse';
import {
  InteractSystem,
  defaultDistance,
  alignmentTo,
  type Interactable,
  type InteractSystemOptions,
} from '../interact/Interact';
import {
  applyPatch as snapApplyPatch,
  createPatch as snapCreatePatch,
  deepClone as snapDeepClone,
} from '../snapshot/Snapshot';
import { RNG } from '../rng/RNG';
import {
  ScoreSystem,
  StarRating,
  Metrics,
  DEFAULT_GRADES,
  type MetricDef,
  type ScoreSystemOptions,
} from '../score/ScoreSystem';

export async function runBatch12Tests(): Promise<void> {
  // ============================================================
  describe('SkillVariant · 技能变体（遗物改造技能）', () => {
    // ============================================================

    /** 一个基础火球 */
    function fireball() {
      return {
        id: 'fireball',
        tags: ['fire', 'projectile'],
        damage: 20,
        cooldown: 2,
        projectile: { count: 1, speed: 10, pierce: 0 },
      };
    }

    const multi: VariantDef = {
      id: 'multi', name: '多重投射',
      patches: [{ op: 'set', path: 'projectile.count', value: 3 }],
    };
    const pierce: VariantDef = {
      id: 'pierce', name: '穿透',
      patches: [{ op: 'add', path: 'projectile.pierce', value: 2 }],
    };
    const empower: VariantDef = {
      id: 'empower', name: '强化',
      patches: [{ op: 'mul', path: 'damage', value: 1.5 }],
    };

    function make(opts = {}) {
      const s = new SkillVariantSystem<ReturnType<typeof fireball>>(opts);
      s.registerAll([multi, pierce, empower]);
      return s;
    }

    test('基本：应用一个变体', () => {
      const s = make();
      const { result, applied } = s.apply(fireball(), ['multi'], { data: {} });
      eq(applied.length, 1);
      eq(result.projectile.count, 3);
    });

    test('⚠️ 绝不修改传入的 base（深拷贝）', () => {
      /**
       * 这是本模块最重要的保证，也是最容易出事的地方。
       *
       * 不深拷贝的话，改的是原型——
       * 所有敌人、所有玩家的火球都变 3 发，而且**不报错**。
       *
       * 更阴险的是它会累积：拿一次遗物全局 +3，拿两次全局 +6，
       * 表现为"越玩越强，强得离谱"。
       */
      const s = make();
      const base = fireball();
      s.apply(base, ['multi'], { data: {} });
      eq(base.projectile.count, 1, 'base 必须原封不动');

      // 再应用一次，结果不该翻倍
      const r1 = s.apply(base, ['multi'], { data: {} });
      const r2 = s.apply(base, ['multi'], { data: {} });
      eq(r1.result.projectile.count, 3);
      eq(r2.result.projectile.count, 3, '重复应用不应累积');
    });

    test('⚠️ 深拷贝保留嵌套对象（不是浅拷贝）', () => {
      const s = make();
      const base = fireball();
      const { result } = s.apply(base, ['pierce'], { data: {} });
      eq(result.projectile.pierce, 2);
      eq(base.projectile.pierce, 0, '嵌套对象也必须是独立的');
    });

    test('多个变体按优先级顺序应用', () => {
      const s = make();
      const { result, applied } = s.apply(fireball(), ['multi', 'pierce', 'empower'], { data: {} });
      eq(applied.length, 3);
      eq(result.projectile.count, 3);
      eq(result.projectile.pierce, 2);
      eq(result.damage, 30, '20 × 1.5');
    });

    test('⚠️ 冲突时优先级高的胜出', () => {
      const weak: VariantDef = {
        id: 'weak', name: '弱强化',
        patches: [{ op: 'mul', path: 'damage', value: 1.1 }],
        priority: 1,
      };
      const strong: VariantDef = {
        id: 'strong', name: '强强化',
        patches: [{ op: 'mul', path: 'damage', value: 3 }],
        priority: 10,
        excludes: ['weak'],
      };
      const s = new SkillVariantSystem<ReturnType<typeof fireball>>();
      s.registerAll([weak, strong]);

      // 注意：excludes 是单向声明也生效（strong.excludes 含 weak）
      const { result, applied } = s.apply(fireball(), ['weak', 'strong'], { data: {} });
      eq(applied.length, 1, '互斥的两个只应生效一个');
      eq(applied[0], 'strong', '优先级高的胜出');
      eq(result.damage, 60, '20 × 3');
    });

    test('onConflict=first：保留先出现的', () => {
      const weak: VariantDef = {
        id: 'weak', name: '弱强化',
        patches: [{ op: 'mul', path: 'damage', value: 1.1 }],
        excludes: ['strong'],
      };
      const strong: VariantDef = {
        id: 'strong', name: '强强化',
        patches: [{ op: 'mul', path: 'damage', value: 3 }],
      };
      const s = new SkillVariantSystem<ReturnType<typeof fireball>>({ onConflict: 'first' });
      s.registerAll([weak, strong]);
      const { applied } = s.apply(fireball(), ['weak', 'strong'], { data: {} });
      eq(applied[0], 'weak');
    });

    test('onConflict=error：互斥时抛错', () => {
      const a: VariantDef = { id: 'a', name: 'a', patches: [{ op: 'add', path: 'damage', value: 1 }], excludes: ['b'] };
      const b: VariantDef = { id: 'b', name: 'b', patches: [{ op: 'add', path: 'damage', value: 2 }] };
      const s = new SkillVariantSystem<ReturnType<typeof fireball>>({ onConflict: 'error' });
      s.registerAll([a, b]);
      throws(() => s.apply(fireball(), ['a', 'b'], { data: {} }), '互斥');
    });

    test('⚠️ 目标筛选：只对指定技能生效', () => {
      const onlyIce: VariantDef = {
        id: 'ice_only', name: '冰霜专属',
        targets: { skills: ['icebolt'] },
        patches: [{ op: 'mul', path: 'damage', value: 2 }],
      };
      const s = new SkillVariantSystem<ReturnType<typeof fireball>>();
      s.register(onlyIce);

      // 对火球无效
      const r1 = s.apply(fireball(), ['ice_only'], { data: {} });
      eq(r1.applied.length, 0, '不该对 fireball 生效');

      // 对冰锥生效
      const ice = { ...fireball(), id: 'icebolt' };
      const r2 = s.apply(ice, ['ice_only'], { data: {} });
      eq(r2.applied.length, 1);
      eq(r2.result.damage, 40);
    });

    test('⚠️ 目标筛选：按标签生效', () => {
      const onlyFire: VariantDef = {
        id: 'fire_tag', name: '火系专属',
        targets: { tags: ['fire'] },
        patches: [{ op: 'add', path: 'damage', value: 5 }],
      };
      const s = new SkillVariantSystem<ReturnType<typeof fireball>>();
      s.register(onlyFire);
      const r = s.apply(fireball(), ['fire_tag'], { data: {} });
      eq(r.applied.length, 1, 'fireball 带 fire 标签');
    });

    test('⚠️ 条件变体：没有求值器时抛错（fail-closed，不再是 fail-open）', () => {
      /**
       * 【行为已变更（第二批精审 P0-19）】
       *
       * 旧实现 `if (!this._evaluator) return true` —— 门禁失效：
       * 声明了 conditions 的变体**无条件生效**，
       * 玩家没有遗物也能吃遗物加成、高难变体被应用到普通局。
       *
       * 旧注释的论证是"视为不满足会导致静默失效，更难查"——
       * 但它只比较了两种**静默**方案，漏掉了第三种：**抛错**。
       * 抛错既不静默生效也不静默失效，恰好消掉那个顾虑。
       *
       * 所以这里改为 fail-closed：声明了 conditions 却没注入 evaluator
       * 属于接入错误，抛错让它立刻暴露，而不是悄悄放行。
       *
       * 未声明 conditions 的变体不受影响（见下一条用例）。
       */
      const cond: VariantDef = {
        id: 'cond', name: '残血强化',
        conditions: [{ id: 'hpBelow', params: { threshold: 0.3 } }],
        patches: [{ op: 'mul', path: 'damage', value: 2 }],
      };
      const s = new SkillVariantSystem<ReturnType<typeof fireball>>();
      s.register(cond);
      throws(() => s.apply(fireball(), ['cond'], { data: {} }), 'evaluator');
    });

    test('条件变体：未声明 conditions 时无需求值器（不误伤）', () => {
      /**
       * fail-closed 只针对"声明了 conditions"的变体。
       * 无条件变体本就不需要求值器，必须能正常生效。
       */
      const plain: VariantDef = {
        id: 'plain', name: '无条件强化',
        patches: [{ op: 'mul', path: 'damage', value: 2 }],
      };
      const s = new SkillVariantSystem<ReturnType<typeof fireball>>();
      s.register(plain);
      const r = s.apply(fireball(), ['plain'], { data: {} });
      eq(r.applied.length, 1, '无条件变体应正常生效');
    });

    test('条件变体：注入求值器后按条件生效', () => {
      const cond: VariantDef = {
        id: 'cond', name: '残血强化',
        conditions: [{ id: 'hpBelow', params: { threshold: 0.3 } }],
        patches: [{ op: 'mul', path: 'damage', value: 2 }],
      };
      let hp = 1.0;
      const s = new SkillVariantSystem<ReturnType<typeof fireball>>({
        evaluator: (c) => c.id === 'hpBelow' && hp < ((c.params?.threshold as number) ?? 1),
      });
      s.register(cond);

      hp = 1.0;
      eq(s.apply(fireball(), ['cond'], { data: {} }).applied.length, 0, '满血不生效');
      hp = 0.2;
      eq(s.apply(fireball(), ['cond'], { data: {} }).applied.length, 1, '残血生效');
    });

    test('⚠️ 未注册的变体 id 静默跳过（兼容旧存档）', () => {
      const s = make();
      const { applied } = s.apply(fireball(), ['multi', '已删除的遗物'], { data: {} });
      eq(applied.length, 1, '未注册的应被忽略，不该让整个技能系统崩掉');
    });

    test('⚠️ 构造时校验：空补丁', () => {
      const s = new SkillVariantSystem();
      throws(() => s.register({ id: 'x', name: 'x', patches: [] }), '没有任何补丁');
    });

    test('⚠️ 构造时校验：空路径', () => {
      const s = new SkillVariantSystem();
      throws(() => s.register({
        id: 'x', name: 'x', patches: [{ op: 'set', path: '', value: 1 }],
      }), 'path 为空');
    });

    test('⚠️ 构造时校验：add/mul 的 value 必须是数字', () => {
      const s = new SkillVariantSystem();
      throws(() => s.register({
        id: 'x', name: 'x', patches: [{ op: 'add', path: 'damage', value: 'abc' as never }],
      }), 'value 必须是数字');
    });

    test('⚠️ 构造时校验：push 的 value 必须是数组', () => {
      const s = new SkillVariantSystem();
      throws(() => s.register({
        id: 'x', name: 'x', patches: [{ op: 'push', path: 'tags', value: 'fire' as never }],
      }), 'value 必须是数组');
    });

    test('重复 id 抛错', () => {
      const s = new SkillVariantSystem();
      s.register(multi);
      throws(() => s.register(multi), '重复');
    });

    test('unregister / get / all', () => {
      const s = make();
      eq(s.all.length, 3);
      eq(s.get('multi')?.name, '多重投射');
      eq(s.unregister('multi'), true);
      eq(s.unregister('multi'), false);
      eq(s.all.length, 2);
    });

    test('preview 输出可读预览', () => {
      const s = make();
      const p = s.preview(fireball(), ['multi'], { data: {} });
      assert(p.includes('多重投射'), '应含变体名');
      assert(p.includes('fireball'), '应含技能名');
    });

    test('onApply 回调', () => {
      const seen: string[] = [];
      const s = new SkillVariantSystem<ReturnType<typeof fireball>>({
        onApply: (vid) => seen.push(vid),
      });
      s.registerAll([multi, pierce]);
      s.apply(fireball(), ['multi', 'pierce'], { data: {} });
      eq(seen.join(','), 'multi,pierce');
    });

    // ---------- applyPatch 单测 ----------

    test('applyPatch：set 创建中间层', () => {
      const o: Record<string, unknown> = {};
      applyPatch(o, { op: 'set', path: 'a.b.c', value: 1 });
      const b = (o['a'] as Record<string, unknown>)['b'] as Record<string, unknown>;
      eq(b['c'], 1, '中间层应自动创建');

      // 下一层是数字则建数组
      const o2: Record<string, unknown> = {};
      applyPatch(o2, { op: 'set', path: 'list.0', value: 'x' });
      eq(Array.isArray(o2['list']), true, '数字索引应创建数组');
      eq((o2['list'] as string[])[0], 'x');
    });

    test('applyPatch：add 对不存在的路径抛错（不静默当 0）', () => {
      const o: Record<string, unknown> = {};
      throws(() => applyPatch(o, { op: 'add', path: 'nope.value', value: 1 }), '不存在');
    });

    test('applyPatch：数组索引', () => {
      const o = { tags: ['a', 'b'] };
      applyPatch(o as unknown as Record<string, unknown>, { op: 'set', path: 'tags.0', value: 'z' });
      eq(o.tags[0], 'z');
    });

    test('applyPatch：max / min', () => {
      const o = { v: 5 };
      applyPatch(o as unknown as Record<string, unknown>, { op: 'max', path: 'v', value: 10 });
      eq(o.v, 10);
      applyPatch(o as unknown as Record<string, unknown>, { op: 'min', path: 'v', value: 3 });
      eq(o.v, 3);
    });

    test('applyPatch：push 追加到数组', () => {
      const o = { tags: ['a'] };
      applyPatch(o as unknown as Record<string, unknown>, { op: 'push', path: 'tags', value: 'b' });
      eq(o.tags.join(','), 'a,b');
    });

    test('applyPatch：remove 删除键', () => {
      const o = { a: 1, b: 2 };
      applyPatch(o as unknown as Record<string, unknown>, { op: 'remove', path: 'a' });
      eq('a' in o, false);
    });

    test('⚠️ deepClone：循环引用不爆栈', () => {
      const o: Record<string, unknown> = { name: 'root' };
      o['self'] = o;
      const c = deepClone(o) as Record<string, unknown>;
      eq(c['name'], 'root');
      eq(c['self'], c, '循环引用应指向克隆体自身');
    });

    test('deepClone：保留 Date 与嵌套结构', () => {
      const d = new Date(1700000000000);
      const o: { d: Date; arr: Array<number | { x: number }> } = { d, arr: [1, { x: 2 }] };
      const c = deepClone(o);
      eq(c.d.getTime(), d.getTime());
      eq(c.d instanceof Date, true, 'Date 不应被退化成字符串');
      eq((c.arr[1] as { x: number }).x, 2);
    });

    // ---------- 与 snapshot 的重复实现 ----------

    test('⚠️ 与 snapshot.applyPatch 的重复（文档化差异）', () => {
      /**
       * skill-variant 与 snapshot 各有一份 applyPatch / deepClone。
       *
       * 这是 v1「禁止一切横向依赖」造成的复制，
       * 正好印证了依赖规则 v2 里写的：
       * "第 2 条比横向依赖危险得多——复制出去的代码会各自演化、各自出 bug。"
       *
       * 这里不断言两者行为完全一致（它们的设计目标不同：
       * snapshot 的 patch 用于状态回滚，variant 的用于配置改造），
       * 但至少要保证基本 set 语义一致。
       */
      /**
       * 【注意语义差异】
       * skill-variant.applyPatch(target, patch) —— **原地修改**
       * snapshot.applyPatch(base, patch)        —— **返回新对象**
       *
       * 差异是合理的（一个改配置、一个回滚状态），
       * 但调用方必须知道，否则会出现"改了没生效"或"意外的共享引用"。
       */
      const a: Record<string, unknown> = { x: 1 };
      applyPatch(a, { op: 'set', path: 'x', value: 9 });
      eq(a['x'], 9, 'skill-variant 是原地修改');

      const before = { x: 1 };
      const patched = snapApplyPatch(before, snapCreatePatch(before, { x: 9 }));
      eq(patched['x'], 9, 'snapshot 返回新对象');
      eq(before['x'], 1, 'snapshot 不修改原对象');
      // 两者共享的 deepClone 至少在基础结构上是等价的
      eq(JSON.stringify(snapDeepClone({ a: [1, 2] })), JSON.stringify(deepClone({ a: [1, 2] })));

      const src = { deep: { n: 1 } };
      const c1 = deepClone(src);
      const c2 = snapDeepClone(src);
      eq(c1.deep.n, c2.deep.n, '两者的深拷贝都应复制嵌套层');
    });
  });

  // ============================================================
  describe('Blessing · 祝福系统', () => {
    // ============================================================

    const defs: BlessingDef[] = [
      { id: 'atk', name: '力量', effects: [{ stat: 'atk', op: 'add', perStack: 5 }] },
      { id: 'crit', name: '精准', effects: [{ stat: 'crit', op: 'add', perStack: 0.02 }], maxStacks: 5 },
      {
        id: 'haste', name: '疾风',
        effects: [{ stat: 'spd', op: 'add', perStack: 3 }],
        softCap: 5, falloff: 0.5,
      },
      { id: 'a', name: '互斥A', effects: [{ stat: 'x', op: 'add', perStack: 1 }], excludes: ['b'], priority: 1 },
      { id: 'b', name: '互斥B', effects: [{ stat: 'y', op: 'add', perStack: 1 }], priority: 5 },
    ];

    function make(opts: Omit<BlessingSystemOptions, 'defs'> = {}) {
      return new BlessingSystem({ defs, ...opts });
    }

    test('基本：添加与层数', () => {
      const s = make();
      s.add('atk', 3);
      eq(s.stacks('atk'), 3);
      eq(s.has('atk'), true);
      eq(s.count, 1);
    });

    test('效果按层数乘算', () => {
      const s = make();
      s.add('atk', 3);
      const e = s.effects();
      eq(e.length, 1);
      eq(e[0].value, 15, '5 × 3 层');
    });

    test('⚠️ 堆叠上限', () => {
      const s = make();
      s.add('crit', 10);
      eq(s.stacks('crit'), 5, 'maxStacks=5 应夹紧');
    });

    test('⚠️ 递减：超过 softCap 的部分打折', () => {
      const s = make();
      s.add('haste', 8);
      eq(s.stacks('haste'), 8, '实际层数仍是 8');
      near(s.effectiveStacks('haste'), 6.5, 1e-9, '5 + (8-5)×0.5 = 6.5');
      // 效果按有效层数算
      const e = s.effectsOf('haste');
      eq(e[0].value, 19.5, '3 × 6.5');
    });

    test('⚠️ 递减不是去掉超出部分（是打折不是截断）', () => {
      const s = make();
      s.add('haste', 8);
      assert(s.effectiveStacks('haste') > 5, '8 层的有效层数应大于 softCap');
      assert(s.effectiveStacks('haste') < 8, '但应小于实际层数');
    });

    test('不超过 softCap 时无递减', () => {
      const s = make();
      s.add('haste', 3);
      eq(s.effectiveStacks('haste'), 3);
    });

    test('⚠️ 互斥：默认 reject', () => {
      const s = make();
      s.add('a');
      const ok = s.add('b');
      eq(ok, 0, '互斥时应被拒绝');
      eq(s.has('b'), false);
    });

    test('⚠️ 互斥是双向的（不依赖添加顺序）', () => {
      /**
       * 【修过的 bug】
       * 原实现有 early return，导致：
       *   a.excludes = ['b']，先 add('a') 再 add('b') → 共存（错）
       *   a.excludes = ['b']，先 add('b') 再 add('a') → 拒绝（对）
       *
       * 同一份配置，换个添加顺序结果就不同。
       * 配表的人写的是"a 和 b 互斥"，他想不到这还取决于玩家先拿到哪个。
       */
      const forward = make();
      forward.add('a');
      eq(forward.add('b'), 0, '先 a 后 b 也应拒绝（b 是被排斥方）');

      const backward = make();
      backward.add('b');
      eq(backward.add('a'), 0, '先 b 后 a 应拒绝（a 是声明方）');

      // wouldConflict 也应双向
      eq(forward.wouldConflict('b'), 'a');
      eq(backward.wouldConflict('a'), 'b');
    });

    test('互斥：coexist 允许共存', () => {
      const s = make({ onConflict: 'coexist' });
      s.add('a');
      s.add('b');
      eq(s.count, 2);
    });

    test('互斥：replace 替换掉旧的', () => {
      const s = make({ onConflict: 'replace' });
      s.add('a');
      s.add('b');
      eq(s.has('a'), false, 'a 应被移除');
      eq(s.has('b'), true);
      eq(s.count, 1);
    });

    test('remove 减少层数，归零则移除', () => {
      const s = make();
      s.add('atk', 5);
      eq(s.remove('atk', 2), 2, '返回的是移除的层数，不是剩余的');
      eq(s.stacks('atk'), 3);
      s.remove('atk');   // 默认全清
      eq(s.has('atk'), false);
    });

    test('⚠️ 移除不存在的祝福无害', () => {
      const s = make();
      eq(s.remove('不存在'), 0);
    });

    test('clear 清空', () => {
      const s = make();
      s.add('atk', 2);
      s.add('crit', 2);
      s.clear();
      eq(s.count, 0);
      eq(s.effects().length, 0);
    });

    test('effects 汇总所有祝福', () => {
      const s = make();
      s.add('atk', 2);      // atk +10
      s.add('crit', 3);     // crit +0.06
      const e = s.effects();
      eq(e.length, 2);
      const atk = e.find((x) => x.stat === 'atk');
      const crit = e.find((x) => x.stat === 'crit');
      eq(atk?.value, 10);
      near(crit?.value ?? 0, 0.06, 1e-9);
    });

    test('⚠️ 未知 id 抛错（防拼写错误）', () => {
      const s = make();
      throws(() => s.add('atkk'), '未定义');
    });

    test('all 列出定义', () => {
      const s = make();
      eq(s.all.length, 5);
    });

    test('onChange 回调', () => {
      const seen: string[] = [];
      const s = make({ onChange: (id) => seen.push(id) });
      s.add('atk', 2);
      s.remove('atk', 1);
      eq(seen.join(','), 'atk,atk');
    });

    test('存档往返', () => {
      const a = make();
      a.add('atk', 3);
      a.add('crit', 2);
      const state = a.exportState();

      const b = make();
      b.importState(state);
      eq(b.stacks('atk'), 3);
      eq(b.stacks('crit'), 2);
    });

    test('⚠️ 导入未知 id 不崩溃（旧存档兼容）', () => {
      const s = make();
      s.importState({ atk: 2, 已删除的祝福: 5 });
      eq(s.stacks('atk'), 2);
    });

    test('describe 输出可读信息', () => {
      const s = make();
      s.add('haste', 8);
      const d = s.describe();
      assert(d.includes('疾风'), '应含祝福名');
      assert(d.includes('8'), '应含层数');
    });
  });

  // ============================================================
  describe('Curse · 诅咒系统', () => {
    // ============================================================

    const defs: CurseDef[] = [
      {
        id: 'frail', name: '虚弱', desc: '生命上限 -20%',
        effects: [{ stat: 'hp', op: 'mul', value: 0.8 }],
        costs: [{ trigger: 'onAcquire', payload: { type: 'hp', amount: 10 } }],
        removeCondition: { id: 'payGold', params: { amount: 100 }, desc: '支付 100 金币' },
      },
      {
        id: 'eternal', name: '永恒诅咒', desc: '防御 -5，无法移除',
        effects: [{ stat: 'def', op: 'add', value: -5 }],
        costs: [{ trigger: 'onFloorEnd', payload: { type: 'hp', amount: 2 } }],
        // 没有 removeCondition → 设计上就该跟到死
      },
    ];

    function make(opts = {}) {
      return new CurseSystem({ defs, ...opts });
    }

    test('基本：添加诅咒', () => {
      const s = make();
      eq(s.add('frail'), true);
      eq(s.has('frail'), true);
    });

    test('⚠️ 不可移除的诅咒无法被移除', () => {
      const s = make();
      s.add('eternal');
      eq(s.canRemove('eternal'), false);
      eq(s.remove('eternal'), false, 'removable=false 不该被移除');
      eq(s.has('eternal'), true);
    });

    test('可移除的满足条件时能移除', () => {
      const s = new CurseSystem({
        defs,
        checker: (c) => c.id === 'payGold',   // 总是满足
      });
      s.add('frail');
      eq(s.canRemove('frail'), true);
      eq(s.remove('frail'), true);
      eq(s.has('frail'), false);
    });

    test('⚠️ canRemove 与 remove 必须一致（不能一个说不行一个却删掉）', () => {
      /**
       * 【修过的 bug】
       * 原 remove() 只在"有 removeCondition"时检查，
       * 于是「设计上不可移除」的诅咒（没有 removeCondition）
       * 反而被直接删掉了。
       *
       * 表现：
       *   canRemove('eternal') → false   UI 显示"无法移除"
       *   remove('eternal')    → true    代码一调用就删了
       *
       * 这条测试锁住"两者必须一致"这个契约。
       */
      const s = make();
      s.add('eternal');
      s.add('frail');

      for (const id of ['eternal', 'frail']) {
        const can = s.canRemove(id);
        const did = s.remove(id);
        eq(did, false, `${id}：没有注入 checker 时不应被移除`);
        eq(can, did, `${id}：canRemove 与 remove 的结论必须一致`);
      }
    });

    test('注入 checker 后按条件移除', () => {
      let gold = 0;
      const s = new CurseSystem({
        defs,
        checker: (c) => c.id === 'payGold' && gold >= ((c.params?.amount as number) ?? 0),
      });
      s.add('frail');

      gold = 50;
      eq(s.canRemove('frail'), false, '钱不够');
      eq(s.remove('frail'), false);

      gold = 100;
      eq(s.canRemove('frail'), true);
      eq(s.remove('frail'), true);
    });

    test('⚠️ 没有 checker 时，有条件移除的也不能删（拒绝而不是放行）', () => {
      const s = make();   // 未注入 checker
      s.add('frail');     // frail 有 removeCondition
      eq(s.remove('frail'), false, '无法验证条件时应拒绝，而不是放行');
    });

    test('⚠️ force 可强行移除（调试/剧情用）', () => {
      const s = make();
      s.add('eternal');
      eq(s.remove('eternal', true), true, 'force=true 应能移除');
    });

    test('移除不存在的诅咒返回 false', () => {
      const s = make();
      eq(s.remove('不存在'), false);
    });

    test('⚠️ 未知 id 添加时报错', () => {
      const s = make();
      throws(() => s.add('未知诅咒'), '未定义');
    });

    test('effects 汇总负面效果', () => {
      const s = make();
      s.add('frail');
      s.add('eternal');
      const e = s.effects();
      eq(e.length, 2);
      eq(s.summary()['hp.mul'], 0.8);
      eq(s.summary()['def.add'], -5);
    });

    test('stacks 与 costCount', () => {
      const s = make();
      s.add('frail');
      eq(s.stacks('frail'), 1);
      eq(s.costCount('frail'), 1, 'onAcquire 的代价在获得时就已结算');
    });

    test('⚠️ tick 推进时间（不抛错）', () => {
      const s = make();
      s.add('frail');
      const n = s.tick();
      assert(n >= 0, 'tick 返回触发数');
    });

    test('trigger 触发事件', () => {
      const s = make();
      s.add('frail');
      const n = s.trigger('onHit');
      assert(n >= 0);
    });

    test('onFloorEnd / onRunEnd', () => {
      const s = make();
      s.add('frail');
      assert(s.onFloorEnd() >= 0);
      assert(s.onRunEnd() >= 0);
    });

    test('⚠️ pick 抽取不重复且可过滤', () => {
      const many: CurseDef[] = [
        { id: 'c1', name: '诅1', desc: '', effects: [{ stat: 'hp', op: 'mul', value: 0.9 }], costs: [{ trigger: 'onAcquire', payload: {} }], weight: 3 },
        { id: 'c2', name: '诅2', desc: '', effects: [{ stat: 'hp', op: 'mul', value: 0.9 }], costs: [{ trigger: 'onAcquire', payload: {} }], weight: 2 },
        { id: 'c3', name: '诅3', desc: '', effects: [{ stat: 'hp', op: 'mul', value: 0.9 }], costs: [{ trigger: 'onAcquire', payload: {} }], weight: 1 },
        { id: 'c4', name: '诅4', desc: '', effects: [{ stat: 'hp', op: 'mul', value: 0.9 }], costs: [{ trigger: 'onAcquire', payload: {} }], weight: 1 },
      ];
      const s = new CurseSystem({ defs: many });
      const picked = s.pick(new RNG(42), 3);
      eq(picked.length, 3);
      eq(new Set(picked.map((p) => p.id)).size, 3, '不应重复');

      const filtered = s.pick(new RNG(42), 2, (d) => d.id !== 'c1');
      assert(!filtered.some((p) => p.id === 'c1'), 'filter 应生效');
    });

    test('⚠️ pick 数量超过池子时不崩', () => {
      const s = make();
      const picked = s.pick(new RNG(1), 10);
      assert(picked.length <= 2, '最多只能给出池子里的数量');
    });

    test('clear 清空', () => {
      const s = make();
      s.add('frail');
      s.add('eternal');
      s.clear();
      eq(s.effects().length, 0);
    });

    test('存档往返', () => {
      const a = make();
      a.add('frail');
      a.add('eternal');
      const state = a.exportState();

      const b = make();
      b.importState(state);
      eq(b.has('frail'), true);
      eq(b.has('eternal'), true);
    });

    test('⚠️ 导入未知 id 不崩溃', () => {
      const s = make();
      s.importState([{ id: '已删除的诅咒', since: 0, stacks: 1 }]);
      eq(s.effects().length, 0);
    });

    test('def 查询定义', () => {
      const s = make();
      eq(s.def('frail')?.name, '虚弱');
      eq(s.def('不存在'), undefined);
    });

    test('describe 输出可读信息', () => {
      const s = make();
      s.add('frail');
      const d = s.describe();
      assert(d.includes('虚弱'), '应含诅咒名');
    });
  });

  // ============================================================
  describe('Interact · 环境互动', () => {
    // ============================================================

    interface ChestData { loot: string }

    /** 造一个可交互物件。位置用 pos 字段（实现会读它） */
    function chest(id: string, x: number, y: number, extra: object = {}): Interactable<ChestData> {
      return {
        id,
        data: { loot: id },
        radius: 3,
        pos: { x, y },
        ...extra,
      } as Interactable<ChestData> & { pos: { x: number; y: number } };
    }

    function make(
      items: Interactable<ChestData>[] = [],
      opts: InteractSystemOptions<ChestData> = {}
    ): InteractSystem<ChestData> {
      const s = new InteractSystem<ChestData>(opts);
      s.registerAll(items);
      return s;
    }

    /** 玩家在原点，面朝 +X */
    const ctx = {
      pos: { x: 0, y: 0 },
      facing: { x: 1, y: 0 },
      inventory: [] as string[],
      data: {},
    };

    test('⚠️ 焦点选择：最近的优先（同朝向下）', () => {
      const s = make([chest('far', 2.5, 0), chest('near', 1, 0)]);
      const f = s.findFocus(ctx);
      eq(f?.item.id, 'near');
    });

    test('没有候选时返回 null', () => {
      const s = make([chest('far', 100, 0)]);
      eq(s.findFocus(ctx), null);
    });

    test('空系统返回 null', () => {
      const s = make();
      eq(s.findFocus(ctx), null);
    });

    test('⚠️ 朝向分档：正对的优先于背后更近的', () => {
      /**
       * 玩家面朝 +X。
       *   back  在 (-1, 0)：距离 1，但背对
       *   front 在 ( 2, 0)：距离 2，正对
       *
       * 纯距离会选 back（更近）。
       * 但玩家按交互键时显然想开面前的箱子——
       * 所以排序是「朝向档位 → 优先级 → 距离」。
       */
      const s = make([chest('back', -1, 0), chest('front', 2, 0)]);
      const f = s.findFocus(ctx);
      eq(f?.item.id, 'front', '正对面的应优先于背后更近的');
    });

    test('⚠️ 优先级高于距离', () => {
      const s = make([
        chest('普通', 1, 0, { priority: 0 }),
        chest('重要', 2.5, 0, { priority: 10 }),
      ]);
      const f = s.findFocus(ctx);
      eq(f?.item.id, '重要', '同朝向档位时优先级优先');
    });

    test('⚠️ 超出半径不可交互（inRange 独立于 valid）', () => {
      /**
       * 【修过的 bug】
       * 原实现把"不在范围内"和"满足条件"都返回 reason=null，
       * 而 valid = (reason === null)。
       * 于是 10 米外的箱子也算有效目标——
       * 玩家站着就能开远处的箱子，或者身边什么都没有 UI 却提示"按 E"。
       */
      const s = make([chest('far', 10, 0)]);
      const c = s.evaluate(s.get('far')!, ctx);
      eq(c.inRange, false, 'inRange 应独立表示够不够得着');
      eq(c.valid, false);
      eq(s.findFocus(ctx), null);
    });

    test('⚠️ 禁用项不参与焦点', () => {
      const s = make([chest('a', 1, 0), chest('b', 2, 0)]);
      s.setDisabled('a', true);
      eq(s.findFocus(ctx)?.item.id, 'b');
    });

    test('disable 后可再次启用', () => {
      const s = make([chest('a', 1, 0)]);
      s.setDisabled('a', true);
      eq(s.findFocus(ctx), null);
      s.setDisabled('a', false);
      eq(s.findFocus(ctx)?.item.id, 'a');
    });

    test('⚠️ 用过一次后自动禁用（默认 maxUses=1）', () => {
      const s = make([chest('once', 1, 0)]);
      eq(s.interact(ctx), true, '第一次应成功');
      eq(s.interact(ctx), false, '不能重复开同一个箱子');
      eq(s.usedCount('once'), 1);
      eq(s.get('once')?.disabled, true, '用完应自动禁用');
    });

    test('maxUses=Infinity 可重复交互', () => {
      const s = make([chest('many', 1, 0, { maxUses: Infinity })]);
      eq(s.interact(ctx), true);
      eq(s.interact(ctx), true);
      eq(s.usedCount('many'), 2);
    });

    test('maxUses=3 用完即禁', () => {
      const s = make([chest('thrice', 1, 0, { maxUses: 3 })]);
      s.interact(ctx); s.interact(ctx); s.interact(ctx);
      eq(s.interact(ctx), false, '第 4 次应失败');
      eq(s.usedCount('thrice'), 3);
    });

    test('⚠️ 指定 id 交互时仍检查有效性', () => {
      const s = make([chest('far', 50, 0)]);
      eq(s.interact(ctx, 'far'), false, '够不着就是够不着，指定 id 也不行');
    });

    test('interact 对不存在的 id 返回 false', () => {
      const s = make();
      eq(s.interact(ctx, '不存在'), false);
    });

    test('reset 重置次数并解除禁用', () => {
      const s = make([chest('once', 1, 0)]);
      s.interact(ctx);
      eq(s.usedCount('once'), 1);
      s.reset('once');
      eq(s.usedCount('once'), 0);
      eq(s.interact(ctx), true, '重置后又能开');
    });

    test('resetAll 重置全部', () => {
      const s = make([chest('a', 1, 0), chest('b', 2, 0)]);
      s.interact(ctx);
      s.interact(ctx);
      s.resetAll();
      eq(s.usedCount('a'), 0);
      eq(s.usedCount('b'), 0);
    });

    test('candidates 只返回有效项且按优劣排序', () => {
      const s = make([chest('c', 2.5, 0), chest('a', 1, 0), chest('b', 2, 0)]);
      const cs = s.candidates(ctx);
      eq(cs.length, 3);
      eq(cs[0].item.id, 'a', '应按距离排序');
    });

    test('candidates 排除超出范围的', () => {
      const s = make([chest('near', 1, 0), chest('far', 100, 0)]);
      eq(s.candidates(ctx).length, 1);
    });

    test('⚠️ requires：缺少道具时给出原因', () => {
      const s = make([chest('locked', 1, 0, { requires: ['铁钥匙'] })]);
      const c = s.evaluate(s.get('locked')!, ctx);
      eq(c.valid, false);
      assert(c.reason?.includes('铁钥匙') ?? false, `应提示缺少什么，实际 "${c.reason}"`);
    });

    test('requires 满足时可交互', () => {
      const s = make([chest('locked', 1, 0, { requires: ['铁钥匙'] })]);
      const withKey = { ...ctx, inventory: ['铁钥匙'] };
      eq(s.findFocus(withKey)?.item.id, 'locked');
    });

    test('⚠️ requireFacing=false 时背对也能交互', () => {
      const s = make([chest('behind', -1, 0, { requireFacing: false })]);
      eq(s.findFocus(ctx)?.item.id, 'behind', '关掉朝向后应能交互');
    });

    test('⚠️ facingTolerance 收紧朝向要求', () => {
      // 侧面（90°）默认 75° 容差内吗？acos(0)=90° > 75° → 不满足
      const s = make([chest('side', 0, 1)]);
      const c = s.evaluate(s.get('side')!, ctx);
      assert(!c.valid, '侧对 90° 超出默认 75° 容差');

      const loose = make([chest('side', 0, 1, { facingTolerance: Math.PI })]);
      eq(loose.findFocus(ctx)?.item.id, 'side', '放宽后可交互');
    });

    test('⚠️ canInteract 注入业务条件', () => {
      let night = false;
      const s = make([chest('moonwell', 1, 0)], {
        canInteract: () => night,
      });
      eq(s.findFocus(ctx), null, '白天不可用');
      night = true;
      eq(s.findFocus(ctx)?.item.id, 'moonwell');
    });

    test('onInteract 回调触发', () => {
      const seen: string[] = [];
      const s = make([chest('a', 1, 0)], { onInteract: (it) => seen.push(it.id) });
      s.interact(ctx);
      eq(seen.join(','), 'a');
    });

    test('onFocusChange 在焦点变化时触发', () => {
      const seen: Array<string | null> = [];
      const s = make([chest('a', 1, 0)], { onFocusChange: (it) => seen.push(it?.id ?? null) });
      s.findFocus(ctx);
      s.findFocus({ ...ctx, pos: { x: 100, y: 100 } });
      eq(seen.length, 2, '焦点从 a 变 null，应通知两次');
      eq(seen[0], 'a');
      eq(seen[1], null);
    });

    test('focused 返回当前焦点（不重算）', () => {
      const s = make([chest('a', 1, 0)]);
      s.findFocus(ctx);
      eq(s.focused?.id, 'a');
    });

    test('register / unregister / get', () => {
      const s = make();
      s.register(chest('a', 1, 0));
      eq(s.get('a')?.id, 'a');
      eq(s.unregister('a'), true);
      eq(s.unregister('a'), false);
      eq(s.get('a'), undefined);
    });

    test('重复注册抛错', () => {
      const s = make([chest('a', 1, 0)]);
      throws(() => s.register(chest('a', 1, 0)), '重复');
    });

    test('clear 清空', () => {
      const s = make([chest('a', 1, 0)]);
      s.clear();
      eq(s.candidates(ctx).length, 0);
    });

    test('⚠️ defaultDistance 支持 2D 与 3D', () => {
      near(defaultDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5, 1e-9);
      near(defaultDistance({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 2 }), 3, 1e-9, '1+4+4=9 → 3');
    });

    test('⚠️ alignmentTo：正对 1 / 背对 -1 / 侧面 0', () => {
      near(alignmentTo({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }), 1, 1e-9);
      near(alignmentTo({ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 1, y: 0 }), -1, 1e-9);
      near(alignmentTo({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }), 0, 1e-9);
    });

    test('⚠️ alignmentTo 对重合位置返回 1（不产生 NaN）', () => {
      /**
       * 玩家正好站在物件上时，归一化会得到 0/0 = NaN，
       * 评分变 NaN → 排序全乱 → 焦点永远选不出来。
       */
      const v = alignmentTo({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
      eq(v, 1, '重合视为正对');
      assert(Number.isFinite(v));
    });

    test('⚠️ alignmentTo 对零朝向返回 1（不卡住交互）', () => {
      const v = alignmentTo({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 });
      eq(v, 1, '朝向无效时放行，而不是返回 0 让玩家开不了门');
    });

    test('⚠️ 站在物件上时不崩（零距离）', () => {
      const s = make([chest('here', 0, 0)]);
      const f = s.findFocus(ctx);
      assert(f !== null, '零距离时仍应能选中');
      eq(f?.item.id, 'here');
      eq(f?.distance, 0);
    });

    test('⚠️ 自定义 distance 生效', () => {
      // 曼哈顿距离：斜方向的"距离"变大
      const s = make(
        [chest('diag', 2.2, 2.2), chest('straight', 2.5, 0)],
        { distance: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) }
      );
      /**
       * 欧氏距离下 diag=3.11 > radius 3（不可达），straight=2.5（可达）
       * 曼哈顿下 diag=4.4（不可达），straight=2.5（可达）
       * 这个用例重点验证 distance 注入生效：
       * 换用"只看 x"的距离函数后，diag 会变成可达且更近。
       */
      eq(s.findFocus(ctx)?.item.id, 'straight', '默认口径下 straight 可达');

      const onlyX = make(
        [chest('diag', 2.2, 2.2), chest('straight', 2.5, 0)],
        { distance: (a, b) => Math.abs(a.x - b.x) }
      );
      eq(onlyX.findFocus(ctx)?.item.id, 'diag', '只看 x 时 diag(2.2) < straight(2.5)');
    });

    test('无 pos 的物件（非空间交互）也能用', () => {
      /**
       * 有些交互不需要位置：比如 UI 上的选项、全局快捷键。
       * 实现里对没有 pos 的物件走 _checkNonPositional 分支。
       */
      const s = new InteractSystem<ChestData>();
      s.register({ id: 'global', data: { loot: 'g' }, radius: 0 } as Interactable<ChestData>);
      eq(s.interact(ctx, 'global'), true);
    });
  });

  // ============================================================
  describe('Score · 有状态评分追踪器', () => {
    // ============================================================

    /**
     * 【它和 scoring 的分工】
     *
     * | | scoring（无状态） | score（有状态） |
     * |---|---|---|
     * | 用法 | `evaluate(values)` 一次性 | `set/add/tick` 累积后 `settle()` |
     * | 适合 | 批量模拟、离线平衡分析 | 实时追踪、边玩边记 |
     *
     * 两者不是重复实现，是同一问题的两种范式。
     * 选择判据见各自 README 的对比表。
     */

    const time: MetricDef = { id: 'time', direction: 'lower-better', weight: 1, par: 60, zero: 180 };
    const damage: MetricDef = { id: 'damage', direction: 'lower-better', weight: 1.5, par: 0, zero: 5 };
    const combo: MetricDef = { id: 'combo', direction: 'higher-better', weight: 1, par: 20, zero: 0 };

    function make(opts: Partial<ScoreSystemOptions> = {}) {
      return new ScoreSystem({
        metrics: [time, damage, combo],
        grades: DEFAULT_GRADES,
        ...opts,
      });
    }

    test('基本：录入与总分', () => {
      const s = make();
      s.set('time', 60);      // par → 100 分
      s.set('damage', 0);     // par → 100 分
      s.set('combo', 20);     // par → 100 分
      eq(s.total(), 100, '全部达标应为 100');
    });

    test('⚠️ lower-better：越小越好', () => {
      const s = make();
      s.set('time', 60);
      s.set('damage', 0);
      s.set('combo', 0);
      const bd = s.breakdown();
      const t = bd.find((x) => x.id === 'time');
      eq(t?.score, 100, '时间达到 par 满分');

      s.set('time', 180);
      eq(s.breakdown().find((x) => x.id === 'time')?.score, 0, '时间到 zero 零分');
    });

    test('⚠️ higher-better：零值默认 0 分', () => {
      const s = make();
      s.set('combo', 0);
      eq(s.breakdown().find((x) => x.id === 'combo')?.score, 0);
    });

    test('中间值线性插值', () => {
      const s = make();
      s.set('time', 120);   // par=60, zero=180 → 正中间
      eq(s.breakdown().find((x) => x.id === 'time')?.score, 50);
    });

    test('⚠️ 超额奖励：优于 par 可超过 100', () => {
      const s = make();
      s.set('time', 30);    // 比 par 快一倍
      s.set('damage', 0);
      s.set('combo', 20);
      assert(s.total() > 100, `超额应加分，实际 ${s.total()}`);
    });

    test('allowOvershoot=false 时封顶 100', () => {
      const fast: MetricDef = {
        id: 'time', direction: 'lower-better', weight: 1,
        par: 60, zero: 180, allowOvershoot: false,
      };
      const s = new ScoreSystem({
        metrics: [fast], grades: DEFAULT_GRADES,
      });
      s.set('time', 10);
      eq(s.total(), 100, '关闭超额后封顶 100');
    });

    test('⚠️ 评级表按 minScore 降序校验', () => {
      throws(
        () => new ScoreSystem({
          metrics: [time],
          grades: [{ id: 'B', minScore: 50 }, { id: 'S', minScore: 90 }],
        }),
        '降序'
      );
    });

    test('评级：按总分落在对应档', () => {
      const s = make();
      s.set('time', 60); s.set('damage', 0); s.set('combo', 20);
      eq(s.grade().id, 'S', '满分应 S');

      s.set('combo', 0);   // 拉低
      const g = s.grade().id;
      assert(g !== 'S', `拉低后不该还是 S，实际 ${g}`);
    });

    test('⚠️ mode=minimum：木桶效应取最低', () => {
      const s = make({ mode: 'minimum' });
      s.set('time', 60);      // 100
      s.set('damage', 0);     // 100
      s.set('combo', 0);      // 0  ← 短板
      eq(s.total(), 0, '取最低分，而不是加权平均');
    });

    test('⚠️ mode=weighted-with-floor：短板触发降级', () => {
      const s = make({ mode: 'weighted-with-floor', floor: 20 });
      s.set('time', 60);      // 100
      s.set('damage', 0);     // 100
      s.set('combo', 0);      // 0，低于 floor=20
      const lowest = DEFAULT_GRADES[DEFAULT_GRADES.length - 1].minScore;
      assert(s.total() <= lowest, `触发地板应封顶到最低档，实际 ${s.total()}`);
      eq(s.grade().id, 'D');
    });

    test('weighted-with-floor：无短板时正常加权', () => {
      const s = make({ mode: 'weighted-with-floor', floor: 20 });
      s.set('time', 60); s.set('damage', 0); s.set('combo', 20);
      eq(s.total(), 100, '无短板不该被地板影响');
    });

    test('add 累加', () => {
      const s = make();
      s.add('combo', 5);
      s.add('combo', 5);
      eq(s.get('combo'), 10);
    });

    test('⚠️ set 未知指标抛错（防拼写）', () => {
      const s = make();
      throws(() => s.set('combos', 1), '未定义');
    });

    test('reset 回到初始值（lower-better 归 zero）', () => {
      const s = make();
      s.set('time', 100);
      s.set('combo', 15);
      s.reset();
      eq(s.get('time'), 180, 'lower-better 重置为 zero');
      eq(s.get('combo'), 0, 'higher-better 重置为 0');
    });

    test('计时器：startTimer / tick / elapsed', () => {
      const s = make();
      s.startTimer();
      eq(s.elapsed, 0);
      s.tick(0.5);
      s.tick(0.5);
      near(s.elapsed, 1, 1e-9);
      s.startTimer();
      eq(s.elapsed, 0, 'startTimer 应重置');
    });

    test('⚠️ tick 忽略负 dt', () => {
      const s = make();
      s.startTimer();
      s.tick(1);
      s.tick(-5);
      near(s.elapsed, 1, 1e-9, '负 dt 不应倒扣时间');
    });

    test('settle 触发 onGrade 并返回明细', () => {
      let gotId = '';
      let gotScore = -1;
      const s = make({ onGrade: (g, sc) => { gotId = g.id; gotScore = sc; } });
      s.set('time', 60); s.set('damage', 0); s.set('combo', 20);
      const r = s.settle();
      eq(r.score, 100);
      eq(r.breakdown.length, 3);
      eq(gotId, 'S');
      eq(gotScore, 100);
    });

    test('⚠️ toNextGrade：最高级返回 null', () => {
      const s = make();
      s.set('time', 60); s.set('damage', 0); s.set('combo', 20);
      eq(s.toNextGrade(), null, '已是 S（最高）应返回 null');
    });

    test('toNextGrade：给出还差多少', () => {
      const s = make();
      s.set('time', 180);   // 0 分
      s.set('damage', 5);   // 0 分
      s.set('combo', 0);    // 0 分
      const n = s.toNextGrade();
      assert(n !== null, 'D 级应有下一级');
      eq(n?.next.id, 'C');
      eq(n?.need, 40, 'C 需要 40 分');
    });

    test('⚠️ 构造校验：指标 id 重复', () => {
      throws(() => new ScoreSystem({
        metrics: [time, { ...time }], grades: DEFAULT_GRADES,
      }), '重复');
    });

    test('⚠️ 构造校验：负权重', () => {
      throws(() => new ScoreSystem({
        metrics: [{ ...time, weight: -1 }], grades: DEFAULT_GRADES,
      }), '不能为负');
    });

    test('⚠️ 构造校验：lower-better 的 zero 必须大于 par', () => {
      throws(() => new ScoreSystem({
        metrics: [{ id: 'x', direction: 'lower-better', weight: 1, par: 100, zero: 50 }],
        grades: DEFAULT_GRADES,
      }), '必须大于');
    });

    test('⚠️ 构造校验：higher-better 的 zero 必须小于 par', () => {
      throws(() => new ScoreSystem({
        metrics: [{ id: 'x', direction: 'higher-better', weight: 1, par: 10, zero: 50 }],
        grades: DEFAULT_GRADES,
      }), '必须小于');
    });

    test('构造校验：评级表不能为空', () => {
      throws(() => new ScoreSystem({ metrics: [time], grades: [] }), '至少需要一个评级');
    });

    test('Metrics 预设：time / damage / combo / kills / hpLeft / exploration', () => {
      const s = new ScoreSystem({
        metrics: [
          Metrics.time(60, 180),
          Metrics.damage(5),
          Metrics.combo(20),
          Metrics.kills(30),
          Metrics.hpLeft(),
          Metrics.exploration(),
        ],
        grades: DEFAULT_GRADES,
      });
      eq(s.breakdown().length, 6);
      s.set('time', 60); s.set('damage', 0); s.set('combo', 20);
      s.set('kills', 30); s.set('hpLeft', 1); s.set('exploration', 1);
      eq(s.total(), 100, '全部达标应 100');
    });

    // ---------- StarRating ----------

    test('StarRating：按达成条件数计星', () => {
      const r = new StarRating(3);
      r.addCondition((c) => (c as { a: boolean }).a)
       .addCondition((c) => (c as { b: boolean }).b)
       .addCondition(() => true);
      eq(r.max, 3);
      eq(r.evaluate({ a: true, b: false }), 2);
      eq(r.evaluate({ a: true, b: true }), 3);
    });

    test('⚠️ StarRating：条件数不得超过星级数', () => {
      const r = new StarRating(2);
      r.addCondition(() => true).addCondition(() => true);
      throws(() => r.addCondition(() => true), '最多');
    });

    test('⚠️ StarRating：构造时星级至少为 1', () => {
      const r = new StarRating(0);
      eq(r.max, 1, '0 星应夹紧为 1');
    });

    test('StarRating：addCondition 可链式调用', () => {
      const r = new StarRating(2);
      const ret = r.addCondition(() => true);
      eq(ret, r, '应返回 this 以支持链式');
    });
  });
}
