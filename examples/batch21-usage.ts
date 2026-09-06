/**
 * 第二十二批示例：技能排队与 CD 补发
 *
 * 【演示什么】
 * 技能 CD 还剩 0.1 秒，玩家点了 —— 这一下能不能在 CD 结束时自动放出来？
 */

import { SkillQueue, suggestWindow, type IQueuedCaster } from '../skill-queue/SkillQueue';
import { SkillCaster, type CastContext, type SkillDef } from '../skill-caster/SkillCaster';
import { InputBuffer } from '../input/InputBuffer';

const DT = 1 / 60;

function hr(t: string): void {
  console.log(`\n${'─'.repeat(52)}\n${t}\n${'─'.repeat(52)}`);
}

function cdSkill(id: string, cooldown: number, extra: Partial<SkillDef> = {}): SkillDef {
  return { id, cooldown, windup: 0, recover: 0, mask: 1, ...extra } as SkillDef;
}

/** 包装 SkillCaster，只为统计释放次数 */
function rig(skill: SkillDef) {
  const caster = new SkillCaster();
  caster.learn(skill);
  let casts = 0;
  const wrapped: IQueuedCaster = {
    get busy() {
      return caster.busy;
    },
    tryCast(id, ctx) {
      const r = caster.tryCast(id, ctx);
      if (r.ok) casts++;
      return r;
    },
    cooldownLeft: (id) => caster.cooldownLeft(id),
  };
  return { caster, wrapped, casts: () => casts };
}

/** 推进到 CD 剩 lead 秒 */
function advanceTo(r: ReturnType<typeof rig>, q: SkillQueue | null, lead: number): void {
  let guard = 0;
  while (r.caster.cooldownLeft(r.caster.skillIds()[0]) > lead && guard++ < 10000) {
    r.caster.tick(DT);
    q?.tick(DT);
  }
}

export function run(): void {
  console.log('════════════════════════════════════════════════');
  console.log('  第二十二批：技能排队与 CD 补发（skill-queue）');
  console.log('════════════════════════════════════════════════');

  // ========== 1. 问题复现 ==========
  hr('1. 问题：CD 剩 0.1s 时提前点击，朴素接法会丢输入');

  {
    const r = rig(cdSkill('fire', 1.0));
    const buf = new InputBuffer({ window: 0.2 });
    let clock = 0;

    // ⚠️ 必须走 wrapped，否则计数器记不到这一次，
    //    下面会显示"释放 0 次"——演示的是丢输入，不是一次都没放
    r.wrapped.tryCast('fire', { x: 0, y: 0, facingDeg: 0 }); // 第一次释放，进入 CD 1s
    advanceTo(r, null, 0.1);
    console.log(`\n  技能 CD 1.0s，已推进到剩 ${r.caster.cooldownLeft('fire').toFixed(3)}s，玩家点击`);

    buf.press('fire');

    // ❌ 朴素接法：先 consume 再 tryCast
    let lost = false;
    for (let i = 0; i < 30; i++) {
      clock += DT;
      buf.tick(DT);
      r.caster.tick(DT);
      if (!r.caster.busy && buf.consume('fire')) {
        const res = r.wrapped.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
        if (!res.ok) {
          console.log(`  [t=${clock.toFixed(2)}] 输入已被消费，但 tryCast 失败：${res.reason}`);
          lost = true;
        }
      }
    }
    console.log(`  → 释放总次数 ${r.casts()}  ${lost ? '✗ 输入丢了（玩家点了没反应）' : '✓'}`);
  }

  // ========== 2. SkillQueue 解决 ==========
  hr('2. 解决：SkillQueue 把输入接住，CD 一到自动放');

  {
    const r = rig(cdSkill('fire', 1.0));
    const q = new SkillQueue(r.wrapped, { window: 0.25 });
    const ctx: CastContext = { x: 0, y: 0, facingDeg: 0 };

    r.wrapped.tryCast('fire', ctx);
    advanceTo(r, q, 0.1);
    console.log(`\n  CD 剩 ${r.caster.cooldownLeft('fire').toFixed(3)}s，玩家点击`);

    q.request('fire', ctx);
    console.log(`  点击瞬间：释放 ${r.casts()} 次，队列里 ${q.count} 个请求（输入被接住，没丢）`);

    for (let i = 0; i < 20; i++) {
      r.caster.tick(DT);
      q.tick(DT);
    }
    console.log(`  → 释放总次数 ${r.casts()}  ✓ CD 一归零就自动放出去了`);
    console.log(`  ${q.describe()}`);
  }

  // ========== 3. 延迟求值：位置 ==========
  hr('3. 坑：延迟释放必须用「释放时」的位置，不是按下时的');

  {
    const r = rig(cdSkill('fire', 1.0));
    let castAtX = -1;
    const q = new SkillQueue(r.wrapped, {
      window: 0.25,
      onCast: (_id, ctx) => {
        castAtX = ctx.x;
      },
    });

    let playerX = 0;
    const live = (): CastContext => ({ x: playerX, y: 0, facingDeg: 0 });

    r.wrapped.tryCast('fire', live());
    advanceTo(r, q, 0.1);

    q.request('fire', live); // ← 传函数，不是快照
    for (let i = 0; i < 20; i++) {
      playerX += 0.4;
      r.caster.tick(DT);
      q.tick(DT);
    }
    console.log(`\n  玩家在等待的 0.1s 里从 x=0 移动到了 x≈${(castAtX).toFixed(1)}`);
    console.log(`  技能实际释放位置：x = ${castAtX.toFixed(2)}`);
    console.log(`  ✓ 传函数 → 取释放那一刻的位置`);
    console.log(`  ✗ 若传快照 → 会在 x=0 放出来，人已经走了技能还在原地`);
  }

  // ========== 4. 失败分类 ==========
  hr('4. 失败分类：暂时失败等一等，永久失败立刻丢');

  {
    const caster = new SkillCaster({
      resources: {
        canAfford: () => false,
        pay: () => {},
      },
    });
    caster.learn(cdSkill('ult', 2, { cost: { mp: 50 } }));

    const log: string[] = [];
    const q = new SkillQueue(caster, {
      onReject: (id, reason, detail) => log.push(`${id} → ${reason}${detail ? `(${detail})` : ''}`),
    });

    q.request('ult', { x: 0, y: 0, facingDeg: 0 });
    q.tick(DT);
    console.log(`\n  蓝不够时请求大招：${log.join(' / ')}`);
    console.log(`  队列剩余 ${q.count} —— 立刻丢弃，不占着位置`);
    console.log(`  （蓝不会自己涨回来，让玩家看到"蓝不够"的提示才是对的）`);
  }

  // ========== 5. 窗口自检 ==========
  hr('5. 窗口自检：配短了会明确告诉你，而不是"偶尔没反应"');

  {
    // CD 0.05 很快就绪，但后摇 0.15 很久；窗口 0.08 卡在中间
    const caster = new SkillCaster();
    caster.learn(cdSkill('fire', 0.05, { recover: 0.15 }));

    const near: string[] = [];
    const q = new SkillQueue(caster, {
      window: 0.08,
      onNearMiss: (id, w) => near.push(`${id} 等了 ${w.toFixed(3)}s`),
      onReject: () => {},
    });

    caster.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
    q.request('fire', { x: 0, y: 0, facingDeg: 0 });
    for (let i = 0; i < 20; i++) {
      caster.tick(DT);
      q.tick(DT);
    }

    console.log(`\n  CD 0.05s / 后摇 0.15s / 窗口 0.08s：`);
    if (near.length > 0) {
      console.log(`  ⚠️ nearMiss ×${near.length} —— ${near[0]}`);
      console.log(`     意思是「CD 其实早就好了，只是窗口不够等到后摇结束」`);
      console.log(`     建议窗口：${suggestWindow(0.15).toFixed(2)}s（覆盖后摇时长）`);
    } else {
      console.log(`  ✓ 无 nearMiss`);
    }
  }

  // ========== 6. 与 InputBuffer 配合 ==========
  hr('6. 与 InputBuffer 配合：poll 固化了正确的三步');

  {
    const r = rig(cdSkill('fire', 0.5));
    const q = new SkillQueue(r.wrapped, { window: 0.25 });
    const buf = new InputBuffer({ window: 0.2 });

    r.wrapped.tryCast('fire', { x: 0, y: 0, facingDeg: 0 });
    advanceTo(r, q, 0.1);

    console.log(`\n  CD 剩 ${r.caster.cooldownLeft('fire').toFixed(3)}s，按下技能键`);
    buf.press('fire');

    // peek → request → 成功后 consume，顺序由 poll 内部保证
    q.poll(buf, { fire: 'fire' }, () => ({ x: 0, y: 0, facingDeg: 0 }));
    console.log(`  队列 ${q.count} 个，缓冲剩余待消费 ${buf.pendingCount} 个（已被接走）`);

    for (let i = 0; i < 20; i++) {
      r.caster.tick(DT);
      buf.tick(DT);
      q.tick(DT);
    }
    console.log(`  → 释放总次数 ${r.casts()}  ✓`);
  }

  // ========== 7. 优先级 ==========
  hr('7. 多技能排队：优先级高的先放');

  {
    const caster = new SkillCaster();
    caster.learn(cdSkill('slash', 0));
    caster.learn(cdSkill('ultimate', 0));

    const order: string[] = [];
    const q = new SkillQueue(caster, {
      capacity: 3,
      onCast: (id) => order.push(id),
    });

    caster.tryCast('slash', { x: 0, y: 0, facingDeg: 0 }); // 让 caster 进入 busy
    q.request('slash', { x: 0, y: 0, facingDeg: 0 }, 0);
    q.request('ultimate', { x: 0, y: 0, facingDeg: 0 }, 10);

    for (let i = 0; i < 5; i++) {
      caster.tick(DT);
      q.tick(DT);
    }
    console.log(`\n  同时按下 普攻(优先级0) 和 大招(优先级10)`);
    console.log(`  释放顺序：${order.join(' → ')}  ✓ 大招不会被普攻挡住`);
  }

  // ========== 8. 完整一局 ==========
  hr('8. 完整一局：乱按 5 秒，看最终释放了几次');

  {
    const r = rig(cdSkill('fire', 1.0));
    const q = new SkillQueue(r.wrapped, { window: 0.25 });
    const ctx: CastContext = { x: 0, y: 0, facingDeg: 0 };

    for (let step = 0; step < 20; step++) {
      q.request('fire', ctx); // 每 0.25s 点一次（模拟玩家乱按）
      for (let i = 0; i < 15; i++) {
        r.caster.tick(DT);
        q.tick(DT);
      }
    }
    console.log(`\n  CD 1.0s，玩家每 0.25s 点一次，共 5 秒`);
    console.log(`  ${q.describe()}`);
    console.log(`  nearMiss ${q.stats.nearMiss} 次（窗口充足应为 0）`);
  }

  console.log('\n' + '═'.repeat(52));
  console.log('  要点回顾');
  console.log('═'.repeat(52));
  console.log(`
  ① 失败时不要清缓冲 —— consume 之后才 tryCast，输入必丢
  ② 区分暂时失败（CD / busy / 超距）与永久失败（蓝不够 / 技能不存在）
  ③ 延迟释放要传 ctx 工厂函数，否则技能在按下时的位置放出来
  ④ 窗口要覆盖「CD + 后摇」，配短了 nearMiss 会报出来
  ⑤ 一次 tick 只放一个技能，否则攒的点击会在同一帧全打出去
`);
}

run();
