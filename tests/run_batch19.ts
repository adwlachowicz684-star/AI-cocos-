/**
 * tests/run_batch19.ts —— 第十八批测试：表现与运维层
 *
 * 本批八个模块：
 * 1. AudioManager · 音效（并发/去重/优先级/音量混合）
 * 2. BGMStack    · 分层音乐（等功率交叉淡变/状态机）
 * 3. Cutscene    · 演出编排（时间轴/seek 重放/跳过）
 * 4. Transition  · 场景转场（三段式/超时/重入保护）
 * 5. Minimap     · 小地图（坐标变换/钳制/迷雾）
 * 6. Builder     · 建造（原子性/旋转/返还/升级）
 * 7. AutoQuality · 自动降级（中位数/迟滞/冷却）
 * 8. DiagPack    · 诊断包（安全序列化/脱敏/配额）
 */

import { test, describe, assert, eq, near, throws } from './_framework';
import {
  AudioManager, PRIORITY,
} from '../audio/AudioManager';
import { BgmStack } from '../audio/BGMStack';
import { Cutscene, Timeline, type CutsceneStep } from '../cutscene/Cutscene';
import { Transition, overlayStyle } from '../transition/Transition';
import { Minimap, FogMap } from '../minimap/Minimap';
import {
  Builder, rotateCell, blueprintCells,
  type Blueprint, type ResourceWallet,
} from '../builder/Builder';
import { AutoQuality, FpsMeter, type AutoQualityConfig } from '../autoquality/AutoQuality';
import {
  DiagCollector, safeStringify, redact, collectEnvironment,
} from '../diagpack/DiagPack';

// ==================== 测试辅助 ====================

/** 测试用钱包：不抛错，spend 成功才扣 */
class TestWallet implements ResourceWallet {
  private readonly _bal = new Map<string, number>();

  constructor(init: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(init)) this._bal.set(k, v);
  }

  get(id: string): number {
    return this._bal.get(id) ?? 0;
  }

  spend(costs: Record<string, number>): boolean {
    // 先全额校验
    for (const [k, v] of Object.entries(costs)) {
      if (this.get(k) < v) return false;
    }
    for (const [k, v] of Object.entries(costs)) {
      this._bal.set(k, this.get(k) - v);
    }
    return true;
  }

  gain(gains: Record<string, number>): void {
    for (const [k, v] of Object.entries(gains)) {
      this._bal.set(k, this.get(k) + v);
    }
  }
}

// ==================== 1. AudioManager ====================

export function runBatch19AudioTests(): void {
  describe('AudioManager · 播放与并发', () => {
    test('基础播放返回 handle', () => {
      const a = new AudioManager({ maxVoices: 10 });
      a.update(0);
      const h = a.play('hit');
      assert(h !== null, '应返回 handle');
      eq(h!.soundId, 'hit');
      eq(a.activeCount, 1);
    });

    test('⚠️ 并发上限：超出后拒绝', () => {
      const a = new AudioManager({ maxVoices: 3 });
      a.update(0);
      // 每次 tick 推进一帧，避免同帧去重
      for (let i = 0; i < 3; i++) { a.play(`s${i}`); a.tick(100); }
      eq(a.activeCount, 3);
      const h = a.play('s4');
      assert(h === null, '第 4 个应被拒绝（无可抢占）');
      eq(a.stats.rejected, 1);
    });

    test('⚠️ 优先级：高优先级能抢占低优先级', () => {
      const a = new AudioManager({ maxVoices: 2 });
      a.update(0);
      a.play('footstep', { priority: PRIORITY.AMBIENT });
      a.tick(100);
      a.play('footstep2', { priority: PRIORITY.AMBIENT });
      a.tick(100);
      eq(a.activeCount, 2);

      // 预警音进来，应该抢占脚步声
      const h = a.play('warning', { priority: PRIORITY.CRITICAL });
      assert(h !== null, '预警音必须能抢占');
      eq(a.stats.evicted, 1, '应抢占 1 个');
      eq(a.activeCount, 2);
      assert(a.isPlaying('warning'), '预警音应在播');
    });

    test('⚠️ 同级不抢占（避免抖动）', () => {
      const a = new AudioManager({ maxVoices: 2 });
      a.update(0);
      a.play('a', { priority: 5 });
      a.tick(100);
      a.play('b', { priority: 5 });
      a.tick(100);
      const h = a.play('c', { priority: 5 });
      assert(h === null, '同级不应抢占');
      eq(a.stats.rejected, 1);
      eq(a.stats.evicted, 0);
    });

    test('⚠️ 循环音效不被抢占', () => {
      const a = new AudioManager({ maxVoices: 1 });
      a.update(0);
      a.play('bgm', { loop: true, priority: PRIORITY.AMBIENT });
      a.tick(100);
      // 循环音效占满唯一通道，且不可抢占
      const h = a.play('hit', { priority: PRIORITY.CRITICAL });
      assert(h === null, '循环音效不可抢占，应拒绝');
    });

    test('⚠️ 去重窗口：密集触发被合并', () => {
      const a = new AudioManager({ maxVoices: 100 });
      a.update(0);
      a.play('hit', { dedupeMs: 80 });
      a.tick(10);   // 只过了 10ms
      const h = a.play('hit', { dedupeMs: 80 });
      assert(h === null, '80ms 窗口内的重复应被丢弃');
      eq(a.stats.deduped, 1);
    });

    test('去重窗口外可正常播放', () => {
      const a = new AudioManager({ maxVoices: 100 });
      a.update(0);
      a.play('hit', { dedupeMs: 80 });
      a.tick(100);  // 过了 100ms > 80ms
      const h = a.play('hit', { dedupeMs: 80 });
      assert(h !== null, '窗口外应能正常播放');
    });

    test('⚠️ 同帧同名上限（防爆音）', () => {
      const a = new AudioManager({ maxVoices: 100, maxSameSoundPerFrame: 3 });
      a.update(0);
      // 同一帧内播 5 次（不 tick）
      let ok = 0;
      for (let i = 0; i < 5; i++) {
        if (a.play('hit') !== null) ok++;
      }
      eq(ok, 3, '同帧最多 3 个');
      eq(a.stats.deduped, 2);
    });

    test('⚠️ 帧计数每帧清零（否则后续永远播不出）', () => {
      const a = new AudioManager({ maxVoices: 100, maxSameSoundPerFrame: 2 });
      a.update(0);
      a.play('hit'); a.play('hit');
      assert(a.play('hit') === null, '第 3 个被拦');
      a.tick(16);   // 新的一帧
      assert(a.play('hit') !== null, '新帧应恢复');
    });

    test('⚠️ tick 必须推进帧计数', () => {
      const a = new AudioManager();
      const f0 = a.frame;
      a.tick(16);
      assert(a.frame > f0, 'tick 应推进帧号');
    });
  });

  describe('AudioManager · 音量混合', () => {
    test('三层音量相乘', () => {
      const a = new AudioManager({
        masterVolume: 0.5,
        categoryVolumes: { sfx: 0.8 },
      });
      a.update(0);
      const h = a.play('x', { volume: 0.5, category: 'sfx' })!;
      near(a.effectiveVolume(h.id), 0.5 * 0.5 * 0.8, 1e-6);
    });

    test('⚠️ 改分类音量后，正在播的音效跟着变', () => {
      const a = new AudioManager({ categoryVolumes: { sfx: 1 } });
      a.update(0);
      const h = a.play('x', { category: 'sfx' })!;
      near(a.effectiveVolume(h.id), 1, 1e-6);
      a.setCategoryVolume('sfx', 0.3);
      near(a.effectiveVolume(h.id), 0.3, 1e-6, '拖动滑块后应立即生效');
    });

    test('改主音量后同样立即生效', () => {
      const a = new AudioManager();
      a.update(0);
      const h = a.play('x')!;
      a.setMasterVolume(0);
      near(a.effectiveVolume(h.id), 0, 1e-6);
    });

    test('音量被 clamp 到 0~1', () => {
      const a = new AudioManager();
      a.setMasterVolume(5);
      near(a.masterVolume, 1, 1e-9);
      a.setMasterVolume(-5);
      near(a.masterVolume, 0, 1e-9);
    });

    test('不存在实例返回 0', () => {
      const a = new AudioManager();
      eq(a.effectiveVolume(999), 0);
    });
  });

  describe('AudioManager · 停止与延迟', () => {
    test('stop 单个', () => {
      const a = new AudioManager();
      a.update(0);
      const h = a.play('x')!;
      eq(a.stop(h.id), true);
      eq(a.stop(h.id), false, '重复停止返回 false');
      eq(a.activeCount, 0);
    });

    test('stopSound 批量', () => {
      const a = new AudioManager({ maxVoices: 100 });
      a.update(0);
      for (let i = 0; i < 3; i++) { a.play('hit'); a.tick(100); }
      a.play('boom'); a.tick(100);
      eq(a.stopSound('hit'), 3);
      eq(a.activeCount, 1);
    });

    test('stopCategory', () => {
      const a = new AudioManager({ maxVoices: 100 });
      a.update(0);
      a.play('ui1', { category: 'ui' }); a.tick(100);
      a.play('sfx1', { category: 'sfx' }); a.tick(100);
      eq(a.stopCategory('ui'), 1);
      assert(!a.isPlaying('ui1'));
      assert(a.isPlaying('sfx1'));
    });

    test('stopAll 清空延迟队列', () => {
      const a = new AudioManager();
      a.update(0);
      a.play('late', { delayMs: 5000 });
      eq(a.pendingCount, 1);
      a.stopAll();
      eq(a.pendingCount, 0);
      eq(a.activeCount, 0);
    });

    test('⚠️ 延迟播放不返回 handle（它还不存在）', () => {
      const a = new AudioManager();
      a.update(0);
      const h = a.play('x', { delayMs: 1000 });
      assert(h === null, '延迟播放返回 null');
      eq(a.pendingCount, 1);
    });

    test('⚠️ 延迟到点后自动播放', () => {
      const a = new AudioManager();
      a.update(0);
      a.play('x', { delayMs: 1000 });
      a.update(999);
      eq(a.activeCount, 0, '未到点不播');
      a.update(1000);
      eq(a.activeCount, 1, '到点应播');
      eq(a.pendingCount, 0);
    });

    test('⚠️ 停止的实例 stopAll 后仍标记 stopped', () => {
      const a = new AudioManager();
      a.update(0);
      const h = a.play('x')!;
      a.stopAll();
      eq(h.stopped, true, 'handle 应被标记 stopped（调用方可能持有引用）');
    });
  });

  describe('AudioManager · 统计与诊断', () => {
    test('describe 输出可读', () => {
      const a = new AudioManager({ maxVoices: 2 });
      a.update(0);
      a.play('a'); a.tick(100);
      a.play('b'); a.tick(100);
      a.play('c');  // 被拒
      const s = a.describe();
      assert(s.includes('活跃'), '应包含活跃数');
      assert(s.includes('被拒'), '应包含被拒数');
    });

    test('countByCategory', () => {
      const a = new AudioManager({ maxVoices: 100 });
      a.update(0);
      a.play('a', { category: 'ui' }); a.tick(100);
      a.play('b', { category: 'ui' }); a.tick(100);
      a.play('c', { category: 'sfx' }); a.tick(100);
      const m = a.countByCategory();
      eq(m.get('ui'), 2);
      eq(m.get('sfx'), 1);
    });

    test('resetStats', () => {
      const a = new AudioManager({ maxVoices: 0 });
      a.update(0);
      a.play('x');
      assert(a.stats.rejected > 0);
      a.resetStats();
      eq(a.stats.rejected, 0);
    });
  });
}

// ==================== 2. BGMStack ====================

export function runBatch19BgmTests(): void {
  const makeStack = () => new BgmStack({
    layers: [
      { name: 'drums' },
      { name: 'bass' },
      { name: 'melody' },
      { name: 'tension', baseVolume: 0.4, alwaysOn: false },
    ],
    states: {
      explore: { drums: 0.6, bass: 0.3, melody: 1, tension: 0 },
      battle: { drums: 1, bass: 1, melody: 0.5, tension: 0.3 },
      boss: { drums: 1, bass: 1, melody: 0.3, tension: 1 },
    },
    initialState: 'explore',
    transitionMs: 1000,
  });

  describe('BGMStack · 基础', () => {
    test('初始状态音量正确', () => {
      const b = makeStack();
      eq(b.state, 'explore');
      near(b.layerVolume('melody'), 1, 1e-6);
      near(b.layerVolume('tension'), 0, 1e-6);
    });

    test('baseVolume 参与计算', () => {
      const b = makeStack();
      b.setState('boss');
      b.update(2000);   // 完成过渡
      // tension 目标 1，baseVolume 0.4 → 0.4
      near(b.layerVolume('tension'), 0.4, 1e-6);
    });

    test('⚠️ 未知状态抛错（配表错误早暴露）', () => {
      const b = makeStack();
      throws(() => b.setState('unknown-state'), '未知状态');
    });

    test('⚠️ 构造时校验 initialState', () => {
      throws(
        () => new BgmStack({
          layers: [{ name: 'a' }],
          states: { x: { a: 1 } },
          initialState: 'nope',
        }),
        'nope'
      );
    });

    test('空层抛错', () => {
      throws(() => new BgmStack({
        layers: [], states: {}, initialState: 'x',
      }), '至少');
    });
  });

  describe('BGMStack · 过渡', () => {
    test('过渡中音量渐变', () => {
      const b = makeStack();
      b.setState('battle');
      b.update(500);   // 一半
      assert(b.inTransition, '应在过渡中');
      near(b.transitionProgress, 0.5, 1e-6);
      const mid = b.layerVolume('bass');
      assert(mid > 0.3 && mid < 1, `bass 应在 0.3~1 之间，实际 ${mid}`);
    });

    test('过渡结束到达目标', () => {
      const b = makeStack();
      b.setState('battle');
      b.update(1000);
      assert(!b.inTransition);
      near(b.layerVolume('bass'), 1, 1e-6);
      near(b.layerVolume('melody'), 0.5, 1e-6);
    });

    test('⚠️ 同状态重复调用不重启过渡', () => {
      const b = makeStack();
      b.setState('battle');
      b.update(500);
      const v1 = b.layerVolume('bass');
      const again = b.setState('battle');
      eq(again, false, '同状态应返回 false');
      b.update(100);
      const v2 = b.layerVolume('bass');
      assert(v2 > v1, `过渡应继续推进，${v1} → ${v2}`);
    });

    test('⚠️ 过渡中途切回，从当前值继续', () => {
      const b = makeStack();
      b.setState('battle');
      b.update(500);
      const mid = b.layerVolume('bass');
      b.setState('explore');   // 切回去
      b.update(0);
      // from 应该是当前值，不是 0
      near(b.layerVolume('bass'), mid, 1e-6, '应从当前值继续，不跳变');
    });

    test('previousState 记录', () => {
      const b = makeStack();
      b.setState('battle');
      eq(b.previousState, 'explore');
      eq(b.state, 'battle');
    });
  });

  describe('BGMStack · 等功率曲线', () => {
    test('⚠️ equal-power 与 linear 结果不同', () => {
      const mk = (curve: 'linear' | 'equal-power') => {
        const b = new BgmStack({
          layers: [{ name: 'a' }, { name: 'b' }],
          states: { s1: { a: 1, b: 0 }, s2: { a: 0, b: 1 } },
          initialState: 's1',
          transitionMs: 1000,
          curve,
        });
        b.setState('s2');
        b.update(500);
        return b;
      };
      const lin = mk('linear');
      const eqp = mk('equal-power');
      const la = lin.layerVolume('a');
      const ea = eqp.layerVolume('a');
      assert(Math.abs(la - ea) > 0.01,
        `两种曲线中途应有差异：linear=${la.toFixed(3)} equal-power=${ea.toFixed(3)}`);
    });

    test('⚠️ equal-power 总能量更平稳', () => {
      const mk = (curve: 'linear' | 'equal-power') => {
        const b = new BgmStack({
          layers: [{ name: 'a' }, { name: 'b' }],
          states: { s1: { a: 1, b: 0 }, s2: { a: 0, b: 1 } },
          initialState: 's1',
          transitionMs: 1000,
          curve,
        });
        b.setState('s2');
        // 采样中途的总能量
        let minLevel = Infinity;
        for (let i = 0; i < 10; i++) {
          b.update(100);
          minLevel = Math.min(minLevel, b.outputLevel);
        }
        return minLevel;
      };
      const lin = mk('linear');
      const eqp = mk('equal-power');
      assert(eqp > lin,
        `equal-power 的最低能量应更高：${eqp.toFixed(3)} vs ${lin.toFixed(3)}`);
    });
  });

  describe('BGMStack · playing 与校验', () => {
    test('⚠️ alwaysOn=false 的层在音量为 0 时停止', () => {
      const b = makeStack();
      eq(b.playingLayers().includes('tension'), false, 'explore 下 tension 不播');
      b.setState('boss');
      b.update(2000);
      assert(b.playingLayers().includes('tension'), 'boss 下应播');
      b.setState('explore');
      b.update(2000);
      assert(!b.playingLayers().includes('tension'), '切回后应停止');
    });

    test('alwaysOn=true 的层即使音量为 0 也在播', () => {
      const b = new BgmStack({
        layers: [{ name: 'a' }],
        states: { s: { a: 0 } },
        initialState: 's',
      });
      b.update(100);
      assert(b.playingLayers().includes('a'), 'alwaysOn 层应始终播放');
    });

    test('⚠️ 过渡中不会提前停止层', () => {
      const b = makeStack();
      b.setState('explore');
      b.update(2000);
      assert(!b.playingLayers().includes('tension'));
      b.setState('boss');
      b.update(100);
      // 过渡刚开始，tension 音量还很低，但不该被停
      assert(b.playingLayers().includes('tension'),
        '过渡中应保持播放（可能还要回升）');
    });

    test('validate 检测缺层', () => {
      const b = new BgmStack({
        layers: [{ name: 'a' }, { name: 'b' }],
        states: {
          s1: { a: 1 },          // 缺 b
          s2: { a: 1, b: 1, c: 1 },  // 多出 c
        },
        initialState: 's1',
      });
      const issues = b.validate();
      assert(issues.length === 2, `应有 2 个问题，实际 ${issues.length}: ${issues}`);
      assert(issues.some((i) => i.includes('缺少层 "b"')));
      assert(issues.some((i) => i.includes('不存在的层 "c"')));
    });

    test('describeMatrix 输出表格', () => {
      const b = makeStack();
      const s = b.describeMatrix();
      assert(s.includes('explore'));
      assert(s.includes('drums'));
    });

    test('setVolume 生效', () => {
      const b = makeStack();
      b.setVolume(0.5);
      near(b.layerVolume('melody'), 0.5, 1e-6);
      b.setVolume(2);
      near(b.volume, 1, 1e-9, '应被 clamp');
    });
  });
}

// ==================== 3. Cutscene ====================

export function runBatch19CutsceneTests(): void {
  const makeCutscene = () => {
    const steps: CutsceneStep[] = [
      { id: 'cam', kind: 'camera', start: 0, duration: 1000 },
      { id: 'dlg', kind: 'dialogue', start: 1000, duration: 2000 },
      { id: 'sfx', kind: 'sfx', start: 1500, duration: 500 },  // 与 dlg 并行
    ];
    return new Cutscene({ id: 'intro', steps, duration: 3000 });
  };

  describe('Cutscene · 时间轴', () => {
    test('总时长取 step 结束时刻最大值', () => {
      const c = new Cutscene({
        id: 'x',
        steps: [{ id: 'a', kind: 'a', duration: 1000 }],
      });
      eq(c.duration, 1000);
    });

    test('未指定 start 时串行排列', () => {
      const c = new Cutscene({
        id: 'x',
        steps: [
          { id: 'a', kind: 'a', duration: 500 },
          { id: 'b', kind: 'b', duration: 300 },
        ],
      });
      eq(c.duration, 800);
    });

    test('⚠️ 并行 step 时长取 max 不是 sum', () => {
      const c = new Cutscene({
        id: 'x',
        steps: [
          { id: 'a', kind: 'a', start: 0, duration: 1000 },
          { id: 'b', kind: 'b', start: 0, duration: 3000 },  // 并行，更长
        ],
      });
      eq(c.duration, 3000, '应取 max，不是 4000');
    });

    test('play 后进入 playing', () => {
      const c = makeCutscene();
      c.play();
      eq(c.state, 'playing');
      eq(c.time, 0);
    });

    test('update 推进时间', () => {
      const c = makeCutscene();
      c.play();
      c.update(500);
      eq(c.time, 500);
      near(c.progress, 500 / 3000, 1e-6);
    });

    test('⚠️ 非 playing 状态 update 返回空', () => {
      const c = makeCutscene();
      const r = c.update(500);
      eq(r.length, 0, '未 play 时不应有变化');
      eq(c.time, 0);
    });

    test('播完进入 finished', () => {
      const c = makeCutscene();
      c.play();
      c.update(3000);
      eq(c.state, 'finished');
      assert(c.finished);
    });
  });

  describe('Cutscene · 回调', () => {
    test('进入 step 时调用 handler', () => {
      const c = makeCutscene();
      const seen: string[] = [];
      c.on('camera', (s) => seen.push(s.id));
      c.on('dialogue', (s) => seen.push(s.id));
      c.play();
      c.update(1100);   // 越过 dlg 开始
      assert(seen.includes('cam'), 'cam 应被调用');
      assert(seen.includes('dlg'), 'dlg 应被调用');
    });

    test('⚠️ localT 正确（step 内进度）', () => {
      const c = makeCutscene();
      let t = -1;
      c.on('camera', (_s, localT) => { t = localT; });
      c.play();
      c.update(500);   // cam 是 0~1000，现在是 500
      near(t, 0.5, 1e-6);
    });

    test('⚠️ 每个 step 只触发一次 enter', () => {
      const c = makeCutscene();
      let n = 0;
      c.on('camera', () => { n++; });
      c.play();
      c.update(100);
      c.update(100);
      c.update(100);
      // update 内部每帧都会调 handler（active 状态），
      // 但 entered 标记只置一次
      eq(c.activeSteps().length, 1);
    });

    test('未注册 kind 不报错', () => {
      const c = makeCutscene();
      c.play();
      c.update(100);   // 没有任何 handler
      eq(c.time, 100);
    });
  });

  describe('Cutscene · seek 与 skip', () => {
    test('⚠️ seek 必须重放之前的 step（不能只应用当前）', () => {
      const c = makeCutscene();
      const seen: string[] = [];
      c.on('camera', (s, _t, isSeek) => { if (isSeek) seen.push(s.id); });
      c.on('dialogue', (s, _t, isSeek) => { if (isSeek) seen.push(s.id); });
      c.play();
      c.seek(1500);
      // 跳到 1500 时，cam 和 dlg 都已经开始过，必须被补上
      assert(seen.includes('cam'), '之前的 camera step 必须被重放');
      assert(seen.includes('dlg'), '之前的 dialogue step 必须被重放');
    });

    test('seek 传 isSeek=true', () => {
      const c = makeCutscene();
      let flag = false;
      c.on('camera', (_s, _t, isSeek) => { flag = isSeek; });
      c.play();
      c.update(500);
      assert(!flag, '正常推进 isSeek 应为 false');
      c.seek(0);
      c.seek(600);
      assert(flag, 'seek 时 isSeek 应为 true');
    });

    test('⚠️ skip 应用最终状态（不是停止播放）', () => {
      const c = makeCutscene();
      let finalT = -1;
      c.on('camera', (_s, localT) => { finalT = localT; });
      c.play();
      c.skip();
      eq(c.state, 'finished');
      near(finalT, 1, 1e-6, 'skip 后 camera 应到达终点，不是停在半路');
    });

    test('skip 后所有 step 都应用了终态', () => {
      const c = makeCutscene();
      const finals = new Map<string, number>();
      c.on('camera', (s, t) => finals.set(s.id, t));
      c.on('dialogue', (s, t) => finals.set(s.id, t));
      c.on('sfx', (s, t) => finals.set(s.id, t));
      c.play();
      c.skip();
      eq(finals.get('cam'), 1);
      eq(finals.get('dlg'), 1);
      eq(finals.get('sfx'), 1);
    });

    test('seek 到结尾进入 finished', () => {
      const c = makeCutscene();
      c.play();
      c.seek(3000);
      eq(c.state, 'finished');
    });

    test('seek 被 clamp 到 [0, duration]', () => {
      const c = makeCutscene();
      c.play();
      c.seek(-100);
      eq(c.time, 0);
      c.seek(99999);
      eq(c.time, 3000);
    });

    test('⚠️ seek 回退后能重新触发', () => {
      const c = makeCutscene();
      let n = 0;
      c.on('camera', () => { n++; });
      c.play();
      c.update(1200);
      c.seek(0);      // 回到开头
      c.update(100);  // 重新进入 camera
      assert(n > 0, '回退后应能重新触发');
    });

    test('stop 不应用终态', () => {
      const c = makeCutscene();
      c.play();
      c.update(500);
      c.stop();
      eq(c.state, 'idle');
      eq(c.time, 0);
    });
  });

  describe('Cutscene · 阻塞', () => {
    test('waitFor 返回 false 时阻塞', () => {
      let ready = false;
      const c = new Cutscene({
        id: 'x',
        steps: [
          { id: 'a', kind: 'a', duration: 100 },
          { id: 'wait', kind: 'wait', duration: 0, waitFor: () => ready, timeoutMs: 5000 },
          { id: 'b', kind: 'b', duration: 100 },
        ],
      });
      c.play();
      c.update(150);   // a 结束，进入 wait
      eq(c.state, 'blocked');
      const t1 = c.time;
      c.update(1000);  // 被阻塞，时间不推进
      eq(c.time, t1, '阻塞时时间不应推进');
    });

    test('waitFor 返回 true 后继续', () => {
      let ready = false;
      const c = new Cutscene({
        id: 'x',
        steps: [
          { id: 'wait', kind: 'wait', duration: 0, waitFor: () => ready, timeoutMs: 5000 },
          { id: 'b', kind: 'b', duration: 100 },
        ],
      });
      c.play();
      c.update(10);
      eq(c.state, 'blocked');
      ready = true;
      c.update(10);
      eq(c.state, 'playing');
    });

    test('⚠️ 阻塞超时后强制继续（不能死等）', () => {
      const c = new Cutscene({
        id: 'x',
        steps: [
          { id: 'wait', kind: 'wait', duration: 0, waitFor: () => false, timeoutMs: 1000 },
          // 时长要够长，否则超时的那一帧会顺带把后面播完，看不出"继续"
          { id: 'b', kind: 'b', duration: 5000 },
        ],
      });
      c.play();
      c.update(10);
      eq(c.state, 'blocked');
      for (let i = 0; i < 6; i++) c.update(200);   // 累计 1210 > 1000
      assert(c.timedOut, '应标记 timedOut');
      eq(c.state, 'playing', '超时后应继续，而不是永远卡住');
    });

    test('⚠️ 门控期间时间不越过门的起点', () => {
      let ready = false;
      const c = new Cutscene({
        id: 'x',
        steps: [
          { id: 'a', kind: 'a', duration: 100 },
          { id: 'wait', kind: 'wait', duration: 0, waitFor: () => ready, timeoutMs: 99999 },
          { id: 'b', kind: 'b', duration: 1000 },
        ],
      });
      c.play();
      c.update(150);   // 越过 a（100），应停在门的位置
      eq(c.state, 'blocked');
      near(c.time, 100, 1e-6, '时间应停在门的起点，不能越过去');
      ready = true;
      c.update(150);
      eq(c.state, 'playing');
      assert(c.time > 100, '解除后应继续推进');
    });

    test('blockingStep 返回当前阻塞项', () => {
      const c = new Cutscene({
        id: 'x',
        steps: [{ id: 'w', kind: 'w', duration: 0, waitFor: () => false, timeoutMs: 99999 }],
      });
      c.play();
      c.update(10);
      const b = c.blockingStep();
      assert(b !== null);
      eq(b!.id, 'w');
    });
  });

  describe('Cutscene · Timeline 构建器', () => {
    test('add 串行', () => {
      const d = new Timeline('t').add('a', 1000).add('b', 500).build();
      eq(d.duration, 1500);
      eq(d.steps[0]!.start, 0);
      eq(d.steps[1]!.start, 1000);
    });

    /**
     * 【⚠️ 这里改了断言，理由记下来】
     *
     * 原来的断言是 `start === 1000`（串行），注释还写着
     * "b 与 a 同时开始？不——应接在 cursor 后"——
     * 测试名叫"with 并行"，断言却是串行，
     * 是当年发现行为与预期不符后**把错误行为固化进了断言**。
     *
     * 但 README 第 136 行明确写「`with(id, dur, data)` 并行添加
     * （与上一个同时开始，总时长取 max）」，第 141-142 行还专门强调过。
     * 按 README 编排"音效与动画同时起"的演出，实际会变成串行的两段，
     * 整个演出时长翻倍、节奏全错——而调用方不会去验证 start 值。
     *
     * 修的是 `with()` 的 start（改用上一条的**起点**而非 cursor），
     * 修完 README 才成立。
     */
    test('with 并行（与上一个同时开始，时长取 max）', () => {
      const d = new Timeline('t')
        .add('a', 1000)
        .with('b', 3000)
        .build();
      eq(d.steps[1]!.start, 0, 'b 应与 a 同时开始（README 的语义）');
      eq(d.duration, 3000, '总时长取 max(1000, 3000)，不是 4000');
    });

    test('gap 增加空档', () => {
      const d = new Timeline('t').add('a', 1000).gap(500).add('b', 100).build();
      eq(d.duration, 1600);
    });

    test('wait 生成阻塞 step', () => {
      const d = new Timeline('t')
        .add('a', 100)
        .wait('press', () => true, 20000)
        .build();
      eq(d.steps[1]!.timeoutMs, 20000);
      eq(d.steps[1]!.duration, 0);
    });

    test('构建出的 def 可被 Cutscene 播放', () => {
      const d = new Timeline('t').add('a', 100).add('b', 100).build();
      const c = new Cutscene(d);
      c.play();
      c.update(200);
      eq(c.state, 'finished');
    });
  });
}

// ==================== 4. Transition ====================

export function runBatch19TransitionTests(): void {
  const makeOk = () =>
    new Transition(
      () => Promise.resolve(),
      { outMs: 300, inMs: 300, loadTimeoutMs: 5000 }
    );

  describe('Transition · 三段式', () => {
    test('start 进入 out', () => {
      const t = makeOk();
      eq(t.start('scene-a'), true);
      eq(t.phase, 'out');
      assert(t.busy);
    });

    test('⚠️ 重入保护：转场中再次 start 返回 false', () => {
      const t = makeOk();
      t.start('a');
      eq(t.start('b'), false, '转场中不应叠加第二个');
      eq(t.state.target, 'a', '目标不应被改');
    });

    test('out → load → in → done', () => {
      const t = makeOk();
      t.start('a');
      t.update(300);
      eq(t.phase, 'load');
      // 异步加载在 microtask 完成，需要让出一次
      return;
    });

    test('加载完成后进入 in', async () => {
      const t = new Transition(
        () => Promise.resolve(),
        { outMs: 100, inMs: 100, loadTimeoutMs: 5000 }
      );
      t.start('a');
      t.update(100);
      eq(t.phase, 'load');
      await Promise.resolve();  // 让 loader 的 then 执行
      await Promise.resolve();
      t.update(1);
      eq(t.phase, 'in');
      t.update(100);
      eq(t.phase, 'done');
    });

    test('done 后不 busy', () => {
      const t = makeOk();
      t.start('a');
      t.forceComplete();
      assert(!t.busy);
    });
  });

  describe('Transition · 进度与遮罩', () => {
    test('out 阶段 overlay 从 0 到 1', () => {
      const t = makeOk();
      t.start('a');
      near(t.state.overlay, 0, 1e-6);
      t.update(150);
      near(t.state.overlay, 0.5, 1e-6);
      t.update(150);
      near(t.state.overlay, 1, 1e-6);
    });

    test('in 阶段 overlay 从 1 到 0', () => {
      const t = new Transition(() => Promise.resolve(), { outMs: 0, inMs: 100 });
      t.start('a');
      t.update(1);
      t.update(100);
      // 跳过 load（异步）
      return;
    });

    test('⚠️ out 阶段进度最多到 outProgressCap', () => {
      const t = new Transition(() => Promise.resolve(), {
        outMs: 100, outProgressCap: 0.9,
      });
      t.start('a');
      t.update(100);
      assert(t.state.progress <= 0.9 + 1e-6,
        `淡出结束时应停在 90%，实际 ${t.state.progress}`);
    });

    test('⚠️ 加载阶段进度不超过 1（避免假死观感）', () => {
      const t = new Transition(
        () => new Promise<void>(() => { /* 永不 resolve */ }),
        { outMs: 0, loadTimeoutMs: 10000, outProgressCap: 0.9 }
      );
      t.start('a');
      t.update(1);
      t.update(9000);
      eq(t.phase, 'load');
      assert(t.state.progress < 1, `加载中进度不应到 1，实际 ${t.state.progress}`);
    });

    test('done 时 progress=1 overlay=0', () => {
      const t = makeOk();
      t.start('a');
      t.forceComplete();
      near(t.state.progress, 1, 1e-6);
      near(t.state.overlay, 0, 1e-6);
    });
  });

  describe('Transition · 失败与超时', () => {
    test('加载失败进入 failed', async () => {
      const t = new Transition(
        () => Promise.reject(new Error('资源 404')),
        { outMs: 0, loadTimeoutMs: 5000 }
      );
      t.start('a');
      t.update(1);
      await Promise.resolve();
      await Promise.resolve();
      t.update(1);
      eq(t.phase, 'failed');
      assert(t.error !== null && t.error.includes('404'), `error 应包含原因，实际 ${t.error}`);
    });

    test('⚠️ 加载超时进入 failed（不是强行继续）', () => {
      const t = new Transition(
        () => new Promise<void>(() => { /* 永不 */ }),
        { outMs: 0, loadTimeoutMs: 1000 }
      );
      t.start('a');
      t.update(1);
      t.update(2000);
      eq(t.phase, 'failed');
      assert(t.error !== null && t.error.includes('超时'), `应报超时，实际 ${t.error}`);
    });

    test('失败时保持遮罩（上层决定重试或退回）', async () => {
      const t = new Transition(() => Promise.reject(new Error('x')), { outMs: 0 });
      t.start('a');
      t.update(1);
      await Promise.resolve();
      await Promise.resolve();
      t.update(1);
      near(t.state.overlay, 1, 1e-6, '失败时应保持全遮罩');
    });

    test('⚠️ 失败时 shouldLockInput 为 true', async () => {
      const t = new Transition(() => Promise.reject(new Error('x')), { outMs: 0 });
      t.start('a');
      t.update(1);
      await Promise.resolve();
      await Promise.resolve();
      t.update(1);
      assert(t.shouldLockInput, '失败时应锁输入');
    });

    test('retry 只在 failed 有效', async () => {
      const t = new Transition(() => Promise.reject(new Error('x')), { outMs: 0 });
      eq(t.retry(), false, '非 failed 状态无效');
      t.start('a');
      t.update(1);
      await Promise.resolve();
      await Promise.resolve();
      t.update(1);
      eq(t.retry(), true);
      eq(t.phase, 'load');
    });

    test('reset 回到 idle', () => {
      const t = makeOk();
      t.start('a');
      t.forceComplete();
      t.reset();
      eq(t.phase, 'idle');
      eq(t.state.target, null);
    });
  });

  describe('Transition · overlayStyle', () => {
    test('⚠️ overlay=0 时 visible=false（否则吃掉触摸）', () => {
      const s = overlayStyle(0);
      eq(s.visible, false);
      eq(s.opacity, 0);
    });

    test('overlay>0 时可见', () => {
      const s = overlayStyle(0.5);
      eq(s.visible, true);
      near(s.opacity, 0.5, 1e-6);
    });

    test('overlay 被 clamp', () => {
      eq(overlayStyle(5).opacity, 1);
      eq(overlayStyle(-1).opacity, 0);
    });
  });
}

// ==================== 5. Minimap ====================

export function runBatch19MinimapTests(): void {
  describe('Minimap · 坐标变换', () => {
    test('follow 模式：观察者居中', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow',
        scale: 1,
      });
      const p = m.worldToMinimap({ x: 100, y: 100 }, { x: 100, y: 100 });
      near(p.x, 0, 1e-6);
      near(p.y, 0, 1e-6);
    });

    test('⚠️ Y 轴翻转（世界 Y 向上，屏幕 Y 向下）', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow',
        scale: 1,
      });
      const north = m.worldToMinimap({ x: 100, y: 200 }, { x: 100, y: 100 });
      assert(north.y < 0, `北方的点应在小地图上方（y 为负），实际 ${north.y}`);
    });

    test('东方的点在右侧', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1,
      });
      const east = m.worldToMinimap({ x: 200, y: 100 }, { x: 100, y: 100 });
      assert(east.x > 0, '东方的点应在右侧');
      near(east.y, 0, 1e-6);
    });

    test('scale 影响距离', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 0.5,
      });
      const p = m.worldToMinimap({ x: 200, y: 100 }, { x: 100, y: 100 });
      near(p.x, 50, 1e-6, '100 世界单位 × 0.5 = 50 像素');
    });

    test('⚠️ 往返变换保持一致（旋转模式）', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1, rotateWithView: true,
      });
      const world = { x: 300, y: 700 };
      const viewer = { x: 100, y: 200 };
      const rot = Math.PI / 4;
      const mm = m.worldToMinimap(world, viewer, rot);
      const back = m.minimapToWorld(mm, viewer, rot);
      near(back.x, world.x, 1e-6);
      near(back.y, world.y, 1e-6);
    });

    test('往返变换（不旋转）', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1,
      });
      const world = { x: 333, y: 777 };
      const mm = m.worldToMinimap(world, { x: 0, y: 0 });
      const back = m.minimapToWorld(mm, { x: 0, y: 0 });
      near(back.x, world.x, 1e-6);
      near(back.y, world.y, 1e-6);
    });

    test('⚠️ 旋转模式下：正前方的点始终在小地图正上方', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1, rotateWithView: true,
      });
      const viewer = { x: 0, y: 0 };
      // 朝向 90°（+Y 方向）时，正前方是 (0, 100)
      const p = m.worldToMinimap({ x: 0, y: 100 }, viewer, Math.PI / 2);
      near(p.x, 0, 1e-6, '正前方不应有横向偏移');
      assert(p.y < 0, `正前方应在上方（y 负），实际 ${p.y}`);
    });
  });

  describe('Minimap · 边界与钳制', () => {
    const mk = (shape: 'rect' | 'circle', clamp = true) => new Minimap({
      worldSize: { x: 1000, y: 1000 },
      viewSize: { x: 200, y: 200 },
      mode: 'follow', scale: 1, shape, clampToEdge: clamp,
    });

    test('矩形：范围内 inView', () => {
      const m = mk('rect');
      assert(m.isInView({ x: 50, y: 50 }));
      assert(m.isInView({ x: 100, y: 0 }));
      assert(!m.isInView({ x: 101, y: 0 }));
    });

    test('圆形：按半径判定', () => {
      const m = mk('circle');
      // circle 的 limitX 是 viewSize.x（当半径）
      assert(m.isInView({ x: 100, y: 0 }));
      assert(m.isInView({ x: 0, y: 100 }));
      assert(!m.isInView({ x: 150, y: 0 }));
    });

    test('范围内不钳制', () => {
      const m = mk('rect');
      const r = m.clampToEdge({ x: 50, y: 50 });
      eq(r.clamped, false);
      near(r.pos.x, 50, 1e-6);
    });

    test('⚠️ 矩形钳制：分别 clamp x/y', () => {
      const m = mk('rect');
      const r = m.clampToEdge({ x: 500, y: 20 });
      eq(r.clamped, true);
      assert(r.pos.x < 100, `x 应被钳制到 100 以内，实际 ${r.pos.x}`);
      near(r.pos.y, 20, 1e-6, 'y 在范围内不动');
    });

    test('⚠️ 圆形钳制：等比例缩放到半径（不是分别 clamp）', () => {
      const m = mk('circle');
      const r = m.clampToEdge({ x: 300, y: 400 });  // 距离 500
      eq(r.clamped, true);
      const len = Math.sqrt(r.pos.x ** 2 + r.pos.y ** 2);
      assert(len <= 100, `长度应等于半径，实际 ${len}`);
      // 方向应保持（x:y = 3:4）
      near(r.pos.x / r.pos.y, 300 / 400, 1e-6, '方向应保持');
    });

    test('⚠️ 圆形钳制不产生方形边界', () => {
      const m = mk('circle');
      // 角落方向的点，钳制后不应停在 (±r, ±r)
      const r = m.clampToEdge({ x: 1000, y: 1000 });
      const len = Math.sqrt(r.pos.x ** 2 + r.pos.y ** 2);
      near(len, 100 - 4, 1e-6, '应落在半径上（含 padding），不是方形角');
    });

    test('edgePadding 生效', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1, shape: 'rect', edgePadding: 10,
      });
      const r = m.clampToEdge({ x: 500, y: 0 });
      near(r.pos.x, 90, 1e-6, '100 - 10 = 90');
    });

    test('clampToEdge=false 时不钳制', () => {
      const m = mk('rect', false);
      const r = m.clampToEdge({ x: 500, y: 0 });
      eq(r.clamped, false, '关闭后不钳制');
      near(r.pos.x, 500, 1e-6);
    });
  });

  describe('Minimap · 布局', () => {
    test('输出每个实体的图标', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1,
      });
      const icons = m.layout(
        [
          { id: 'p', kind: 'player', pos: { x: 0, y: 0 } },
          { id: 'e', kind: 'enemy', pos: { x: 50, y: 0 } },
        ],
        { x: 0, y: 0 }
      );
      eq(icons.length, 2);
      eq(icons[1]!.id, 'e');
      near(icons[1]!.distance, 50, 1e-6);
    });

    test('⚠️ 边界外的实体被钳制且标记', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1,
      });
      const icons = m.layout(
        [{ id: 'far', kind: 'enemy', pos: { x: 500, y: 0 } }],
        { x: 0, y: 0 }
      );
      eq(icons[0]!.clamped, true);
      eq(icons[0]!.inView, false);
      eq(icons[0]!.visible, true, '钳制后仍应可见（否则玩家看不到威胁）');
    });

    test('⚠️ alwaysShow 的实体在范围外也显示', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1, clampToEdge: false,
      });
      const icons = m.layout(
        [
          { id: 'obj', kind: 'objective', pos: { x: 900, y: 0 }, alwaysShow: true },
          { id: 'e', kind: 'enemy', pos: { x: 900, y: 0 } },
        ],
        { x: 0, y: 0 }
      );
      eq(icons[0]!.visible, true, '任务目标应始终显示');
      eq(icons[1]!.visible, false, '普通敌人范围外隐藏');
    });

    test('迷雾未探索区域不显示', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1,
      });
      const fog = new FogMap({ x: 1000, y: 1000 }, 32);
      fog.reveal({ x: 10, y: 10 }, 100);
      const icons = m.layout(
        [
          { id: 'near', kind: 'enemy', pos: { x: 20, y: 20 } },
          { id: 'far', kind: 'enemy', pos: { x: 900, y: 900 } },
        ],
        { x: 0, y: 0 }, 0, (w) => fog.isRevealed(w)
      );
      eq(icons[0]!.visible, true, '已探索区域可见');
      eq(icons[1]!.visible, false, '未探索区域不可见');
    });

    test('⚠️ 旋转模式：与观察者同向的实体图标朝上（0）', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1, rotateWithView: true,
      });
      const icons = m.layout(
        [{ id: 'e', kind: 'enemy', pos: { x: 10, y: 0 }, rotation: 1.2 }],
        { x: 0, y: 0 }, 1.2
      );
      near(icons[0]!.rotation, 0, 1e-6, '同向 = 朝上');
    });

    test('⚠️ 旋转模式：相对观察者偏 90° 时图标朝左', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1, rotateWithView: true,
      });
      // 实体朝向 = 观察者 + 90°，在"上为 0、顺时针为正"下应为 -90°（左）
      const icons = m.layout(
        [{ id: 'e', kind: 'enemy', pos: { x: 10, y: 0 }, rotation: 1.2 + Math.PI / 2 }],
        { x: 0, y: 0 }, 1.2
      );
      near(icons[0]!.rotation, -Math.PI / 2, 1e-6);
    });

    test('⚠️ 非旋转模式：朝北的实体图标朝上，朝东的朝右', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1,
      });
      const at = (rot: number) => m.layout(
        [{ id: 'e', kind: 'enemy', pos: { x: 10, y: 0 }, rotation: rot }],
        { x: 0, y: 0 }
      )[0]!.rotation;
      near(at(Math.PI / 2), 0, 1e-6, '北 = 上');
      near(at(0), Math.PI / 2, 1e-6, '东 = 右');
      near(at(Math.PI), -Math.PI / 2, 1e-6, '西 = 左');
    });

    test('⚠️ 两种模式下"朝上"都应该是 0（约定一致）', () => {
      const mk = (rot: boolean) => new Minimap({
        worldSize: { x: 1000, y: 1000 },
        viewSize: { x: 200, y: 200 },
        mode: 'follow', scale: 1, rotateWithView: rot,
      });
      // 旋转模式：实体与观察者同向
      const a = mk(true).layout(
        [{ id: 'e', kind: 'enemy', pos: { x: 0, y: 10 }, rotation: 0 }],
        { x: 0, y: 0 }, 0
      )[0]!.rotation;
      // 非旋转模式：实体朝北
      const b = mk(false).layout(
        [{ id: 'e', kind: 'enemy', pos: { x: 0, y: 10 }, rotation: Math.PI / 2 }],
        { x: 0, y: 0 }
      )[0]!.rotation;
      near(a, 0, 1e-6);
      near(b, 0, 1e-6);
    });

    test('fixed 模式自动计算缩放', () => {
      const m = new Minimap({
        worldSize: { x: 1000, y: 2000 },
        viewSize: { x: 200, y: 200 },
        mode: 'fixed',
      });
      // 1000→200 是 0.2；2000→200 是 0.1；取 min
      near(m.scale, 0.1, 1e-6);
    });
  });

  describe('Minimap · FogMap', () => {
    test('初始覆盖率为 0', () => {
      const f = new FogMap({ x: 1000, y: 1000 }, 32);
      near(f.coverage, 0, 1e-9);
    });

    test('reveal 增加覆盖', () => {
      const f = new FogMap({ x: 1000, y: 1000 }, 32);
      f.reveal({ x: 500, y: 500 }, 0);
      assert(f.coverage > 0);
      assert(f.isRevealed({ x: 500, y: 500 }));
    });

    test('reveal 带半径', () => {
      const f = new FogMap({ x: 1000, y: 1000 }, 32);
      f.reveal({ x: 500, y: 500 }, 300);
      assert(f.isRevealed({ x: 600, y: 500 }), '半径内应揭开');
    });

    test('⚠️ 越界坐标不崩', () => {
      const f = new FogMap({ x: 1000, y: 1000 }, 32);
      f.reveal({ x: -100, y: -100 }, 0);
      f.reveal({ x: 99999, y: 99999 }, 0);
      eq(f.isRevealed({ x: -100, y: -100 }), false);
    });

    test('序列化往返', () => {
      const f = new FogMap({ x: 1000, y: 1000 }, 32);
      f.reveal({ x: 100, y: 100 }, 200);
      const bytes = f.toBytes();
      const f2 = FogMap.fromBytes({ x: 1000, y: 1000 }, 32, bytes);
      near(f2.coverage, f.coverage, 1e-9);
      assert(f2.isRevealed({ x: 100, y: 100 }));
    });

    test('clear 重置', () => {
      const f = new FogMap({ x: 1000, y: 1000 }, 32);
      f.reveal({ x: 100, y: 100 }, 300);
      f.clear();
      near(f.coverage, 0, 1e-9);
    });

    test('⚠️ 长度不匹配的字节被忽略而非崩溃', () => {
      const f = FogMap.fromBytes({ x: 1000, y: 1000 }, 32, new Uint8Array(3));
      near(f.coverage, 0, 1e-9);
    });
  });
}

// ==================== 6. Builder ====================

export function runBatch19BuilderTests(): void {
  const w1: Blueprint = {
    id: 'wall',
    cells: [{ x: 0, y: 0 }],
    cost: { wood: 10 },
  };
  const house: Blueprint = {
    id: 'house',
    name: '房子',
    cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],   // 2×1
    cost: { wood: 50, stone: 20 },
  };
  const stable: Blueprint = {
    id: 'stable',
    name: '马厩',
    cells: [{ x: 0, y: 0 }],
    cost: { wood: 80 },
    requires: ['house'],
    maxCount: 2,
  };
  const wallUp: Blueprint = {
    id: 'wall2',
    name: '加固墙',
    cells: [{ x: 0, y: 0 }],
    cost: { stone: 30 },
    refundRate: 0.75,
  };

  describe('Builder · 旋转', () => {
    test('rotateCell 0 度不变', () => {
      const r = rotateCell({ x: 3, y: 5 }, 0);
      eq(r.x, 3); eq(r.y, 5);
    });

    test('rotateCell 90 度', () => {
      const r = rotateCell({ x: 1, y: 0 }, 90);
      eq(r.x, 0); eq(r.y, 1);
    });

    test('rotateCell 180 度', () => {
      const r = rotateCell({ x: 1, y: 2 }, 180);
      eq(r.x, -1); eq(r.y, -2);
    });

    test('⚠️ 旋转 4 次回到原位', () => {
      const c = { x: 3, y: 7 };
      let r = c;
      for (const d of [90, 90, 90, 90] as const) r = rotateCell(r, d);
      eq(r.x, c.x); eq(r.y, c.y);
    });

    test('⚠️ 2×1 旋转 90 度变成 1×2', () => {
      const cells0 = blueprintCells(house, { x: 0, y: 0 }, 0);
      const cells90 = blueprintCells(house, { x: 0, y: 0 }, 90);
      const w0 = Math.max(...cells0.map((c) => c.x)) - Math.min(...cells0.map((c) => c.x)) + 1;
      const h0 = Math.max(...cells0.map((c) => c.y)) - Math.min(...cells0.map((c) => c.y)) + 1;
      const w90 = Math.max(...cells90.map((c) => c.x)) - Math.min(...cells90.map((c) => c.x)) + 1;
      const h90 = Math.max(...cells90.map((c) => c.y)) - Math.min(...cells90.map((c) => c.y)) + 1;
      eq(w0, 2); eq(h0, 1);
      eq(w90, 1); eq(h90, 2, '旋转后宽高应互换');
    });
  });

  describe('Builder · 放置', () => {
    test('基础放置', () => {
      const w = new TestWallet({ wood: 100 });
      const b = new Builder({
        blueprints: [w1], wallet: w, bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall', { x: 1, y: 1 });
      eq(r.ok, true);
      eq(w.get('wood'), 90);
      eq(b.buildingCount, 1);
    });

    test('⚠️ 资源不足时不扣钱', () => {
      const w = new TestWallet({ wood: 5 });
      const b = new Builder({
        blueprints: [w1], wallet: w, bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall', { x: 1, y: 1 });
      eq(r.ok, false);
      eq(r.error, 'insufficient-resources');
      eq(w.get('wood'), 5, '失败时不应扣资源');
      eq(b.buildingCount, 0);
    });

    test('⚠️ 占位冲突时也不扣钱', () => {
      const w = new TestWallet({ wood: 100 });
      const b = new Builder({
        blueprints: [w1], wallet: w, bounds: { w: 10, h: 10 },
      });
      b.place('wall', { x: 1, y: 1 });
      const r = b.place('wall', { x: 1, y: 1 });
      eq(r.ok, false);
      eq(r.error, 'occupied');
      eq(w.get('wood'), 90, '只应扣一次');
    });

    test('越界被拒', () => {
      const w = new TestWallet({ wood: 100 });
      const b = new Builder({
        blueprints: [w1], wallet: w, bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall', { x: 20, y: 20 });
      eq(r.ok, false);
      eq(r.error, 'out-of-bounds');
    });

    test('⚠️ 2×1 建筑占两格', () => {
      const w = new TestWallet({ wood: 100, stone: 100 });
      const b = new Builder({
        blueprints: [house], wallet: w, bounds: { w: 10, h: 10 },
      });
      b.place('house', { x: 2, y: 2 });
      assert(b.buildingAt({ x: 2, y: 2 }) !== undefined);
      assert(b.buildingAt({ x: 3, y: 2 }) !== undefined, '第二格也应被占');
      assert(b.buildingAt({ x: 4, y: 2 }) === undefined);
    });

    test('未知蓝图', () => {
      const b = new Builder({
        blueprints: [w1], wallet: new TestWallet(), bounds: { w: 10, h: 10 },
      });
      const r = b.place('nope', { x: 0, y: 0 });
      eq(r.ok, false);
      eq(r.error, 'unknown-blueprint');
    });
  });

  describe('Builder · 前置与上限', () => {
    test('⚠️ 前置未满足时拒绝，且给出缺什么', () => {
      const w = new TestWallet({ wood: 1000 });
      const b = new Builder({
        blueprints: [house, stable], wallet: w, bounds: { w: 10, h: 10 },
      });
      const r = b.place('stable', { x: 0, y: 0 });
      eq(r.ok, false);
      eq(r.error, 'missing-requirement');
      assert(r.detail !== undefined && r.detail.includes('房子'),
        `detail 应说明缺什么，实际 ${r.detail}`);
    });

    test('满足前置后可建', () => {
      const w = new TestWallet({ wood: 1000, stone: 1000 });
      const b = new Builder({
        blueprints: [house, stable], wallet: w, bounds: { w: 10, h: 10 },
      });
      b.place('house', { x: 0, y: 0 });
      const r = b.place('stable', { x: 5, y: 5 });
      eq(r.ok, true);
    });

    test('⚠️ 数量上限', () => {
      const w = new TestWallet({ wood: 10000, stone: 10000 });
      const b = new Builder({
        blueprints: [house, stable], wallet: w, bounds: { w: 10, h: 10 },
      });
      b.place('house', { x: 0, y: 0 });
      b.place('stable', { x: 2, y: 0 });
      b.place('stable', { x: 4, y: 0 });
      const r = b.place('stable', { x: 6, y: 0 });
      eq(r.ok, false);
      eq(r.error, 'max-count-reached');
    });
  });

  describe('Builder · 预览', () => {
    test('预览不改动状态', () => {
      const w = new TestWallet({ wood: 100 });
      const b = new Builder({
        blueprints: [w1], wallet: w, bounds: { w: 10, h: 10 },
      });
      b.preview('wall', { x: 1, y: 1 });
      eq(b.buildingCount, 0);
      eq(w.get('wood'), 100);
    });

    test('预览返回会占用的格子', () => {
      const b = new Builder({
        blueprints: [house], wallet: new TestWallet({ wood: 100, stone: 100 }),
        bounds: { w: 10, h: 10 },
      });
      const p = b.preview('house', { x: 2, y: 2 });
      eq(p.ok, true);
      eq(p.cells.length, 2);
    });

    test('⚠️ 预览给出冲突对象', () => {
      const w = new TestWallet({ wood: 100 });
      const b = new Builder({
        blueprints: [w1], wallet: w, bounds: { w: 10, h: 10 },
      });
      const first = b.place('wall', { x: 1, y: 1 });
      const p = b.preview('wall', { x: 1, y: 1 });
      eq(p.ok, false);
      eq(p.error, 'occupied');
      assert(p.conflicts !== undefined && p.conflicts.includes(first.building!.id),
        '应指出与哪个建筑冲突');
    });

    test('地形阻挡', () => {
      const b = new Builder({
        blueprints: [w1],
        wallet: new TestWallet({ wood: 100 }),
        bounds: { w: 10, h: 10 },
        terrain: { isBuildable: (c) => c.x !== 5 },
      });
      const p = b.preview('wall', { x: 5, y: 1 });
      eq(p.ok, false);
      eq(p.error, 'terrain-blocked');
      assert(p.detail !== undefined && p.detail.includes('5'),
        `detail 应指出是哪一格，实际 ${p.detail}`);
    });
  });

  describe('Builder · 拆除与升级', () => {
    test('⚠️ 未完成建筑 100% 返还', () => {
      const w = new TestWallet({ wood: 100 });
      const bp: Blueprint = { ...w1, buildTimeMs: 5000 };
      const b = new Builder({
        blueprints: [bp], wallet: w, bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall', { x: 0, y: 0 });
      eq(r.ok, true);
      eq(r.building!.completed, false, '有建造时间，应未完成');
      eq(w.get('wood'), 90);

      const rm = b.remove(r.building!.id);
      eq(rm.ok, true);
      eq(w.get('wood'), 100, '取消建造应 100% 返还');
    });

    test('⚠️ 已完成建筑按比例返还（默认 50%）', () => {
      const w = new TestWallet({ wood: 100 });
      const b = new Builder({
        blueprints: [w1], wallet: w, bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall', { x: 0, y: 0 });
      eq(r.building!.completed, true, '无建造时间，应直接完成');
      b.remove(r.building!.id);
      eq(w.get('wood'), 95, '返还 50% = 5');
    });

    test('refundRate 可配置（向下取整）', () => {
      const w = new TestWallet({ stone: 100 });
      const b = new Builder({
        blueprints: [wallUp], wallet: w, bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall2', { x: 0, y: 0 });
      b.remove(r.building!.id);
      eq(w.get('stone'), 70 + 22, '30 × 0.75 = 22.5 → 22');
    });

    test('removable=false 不可拆', () => {
      const bp: Blueprint = { ...w1, removable: false };
      const b = new Builder({
        blueprints: [bp], wallet: new TestWallet({ wood: 100 }),
        bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall', { x: 0, y: 0 });
      const rm = b.remove(r.building!.id);
      eq(rm.ok, false);
      eq(rm.error, 'not-removable');
    });

    test('拆除后格子被释放', () => {
      const b = new Builder({
        blueprints: [w1], wallet: new TestWallet({ wood: 100 }),
        bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall', { x: 3, y: 3 });
      assert(b.buildingAt({ x: 3, y: 3 }) !== undefined);
      b.remove(r.building!.id);
      assert(b.buildingAt({ x: 3, y: 3 }) === undefined, '拆除后应释放格子');
      eq(b.countOf('wall'), 0);
    });

    test('⚠️ 升级保留 id 与位置', () => {
      const w = new TestWallet({ wood: 200, stone: 200 });
      const wallWithUp: Blueprint = { ...w1, upgradeTo: 'wall2' };
      const b = new Builder({
        blueprints: [wallWithUp, wallUp], wallet: w, bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall', { x: 4, y: 4 });
      const id = r.building!.id;
      const up = b.upgrade(id);
      eq(up.ok, true);
      const after = b.getBuilding(id)!;
      eq(after.blueprintId, 'wall2');
      eq(after.anchor.x, 4, '位置应保留');
      eq(after.id, id, 'id 应保留（引用不断）');
    });

    test('无升级目标时报错', () => {
      const b = new Builder({
        blueprints: [w1], wallet: new TestWallet({ wood: 100 }),
        bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall', { x: 0, y: 0 });
      const up = b.upgrade(r.building!.id);
      eq(up.ok, false);
      assert(up.detail !== undefined && up.detail.includes('没有升级目标'));
    });

    test('⚠️ 升级时自身占的格子不算冲突', () => {
      const w = new TestWallet({ wood: 200, stone: 200 });
      const small: Blueprint = {
        id: 'small', cells: [{ x: 0, y: 0 }], cost: { wood: 10 }, upgradeTo: 'big',
      };
      const big: Blueprint = {
        id: 'big', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }], cost: { stone: 10 },
      };
      const b = new Builder({
        blueprints: [small, big], wallet: w, bounds: { w: 10, h: 10 },
      });
      const r = b.place('small', { x: 1, y: 1 });
      const up = b.upgrade(r.building!.id);
      eq(up.ok, true, '升级到更大的占位不应与自身冲突');
    });

    test('升级到其他建筑占的格子时失败', () => {
      const w = new TestWallet({ wood: 200, stone: 200 });
      const small: Blueprint = {
        id: 'small', cells: [{ x: 0, y: 0 }], cost: { wood: 10 }, upgradeTo: 'big',
      };
      const big: Blueprint = {
        id: 'big', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }], cost: { stone: 10 },
      };
      const b = new Builder({
        blueprints: [small, big, w1], wallet: w, bounds: { w: 10, h: 10 },
      });
      const r = b.place('small', { x: 1, y: 1 });
      b.place('wall', { x: 2, y: 1 });   // 占了升级后的第二格
      const up = b.upgrade(r.building!.id);
      eq(up.ok, false);
      eq(up.error, 'occupied');
      eq(w.get('stone'), 200, '失败不应扣资源');
    });
  });

  describe('Builder · 校验与清理', () => {
    test('validate 检测无效的前置引用', () => {
      const b = new Builder({
        blueprints: [{ ...stable }],
        wallet: new TestWallet(), bounds: { w: 10, h: 10 },
      });
      const issues = b.validate();
      assert(issues.some((i) => i.includes('house')), `应报缺 house，实际 ${issues}`);
    });

    test('validate 检测无效升级目标', () => {
      const b = new Builder({
        blueprints: [{ ...w1, upgradeTo: 'ghost' }],
        wallet: new TestWallet(), bounds: { w: 10, h: 10 },
      });
      assert(b.validate().some((i) => i.includes('ghost')));
    });

    test('validate 检测空占位', () => {
      const b = new Builder({
        blueprints: [{ id: 'x', cells: [], cost: {} }],
        wallet: new TestWallet(), bounds: { w: 10, h: 10 },
      });
      assert(b.validate().some((i) => i.includes('占位为空')));
    });

    test('validate 检测越界返还比例', () => {
      const b = new Builder({
        blueprints: [{ ...w1, refundRate: 1.5 }],
        wallet: new TestWallet(), bounds: { w: 10, h: 10 },
      });
      assert(b.validate().some((i) => i.includes('返还比例')));
    });

    test('clear 重置全部', () => {
      const b = new Builder({
        blueprints: [w1], wallet: new TestWallet({ wood: 1000 }),
        bounds: { w: 10, h: 10 },
      });
      b.place('wall', { x: 1, y: 1 });
      b.clear();
      eq(b.buildingCount, 0);
      eq(b.countOf('wall'), 0);
      assert(b.buildingAt({ x: 1, y: 1 }) === undefined);
    });

    test('update 推进建造时间', () => {
      const b = new Builder({
        blueprints: [w1], wallet: new TestWallet({ wood: 100 }),
        bounds: { w: 10, h: 10 },
      });
      b.update(1000);
      eq(b.now, 1000);
    });

    test('complete 标记完成', () => {
      const bp: Blueprint = { ...w1, buildTimeMs: 5000 };
      const b = new Builder({
        blueprints: [bp], wallet: new TestWallet({ wood: 100 }),
        bounds: { w: 10, h: 10 },
      });
      const r = b.place('wall', { x: 0, y: 0 });
      b.update(6000);
      eq(b.complete(r.building!.id), true);
      eq(b.getBuilding(r.building!.id)!.completed, true);
      eq(b.complete(r.building!.id), false, '重复完成返回 false');
    });
  });
}

// ==================== 7. AutoQuality ====================

export function runBatch19AutoQualityTests(): void {
  /** 简易时钟：把"帧数"换算成推进的时间 */
  class Clock {
    t = 0;
    adv(dt: number): number {
      this.t += dt;
      return this.t;
    }
  }

  /** 连续喂 n 帧，每帧 dt 毫秒 */
  const run = (a: AutoQuality, dt: number, n: number, c = new Clock()): Clock => {
    for (let i = 0; i < n; i++) a.update(dt, c.adv(dt));
    return c;
  };

  const mk = (over: Partial<AutoQualityConfig> = {}) =>
    new AutoQuality({
      tiers: AutoQuality.defaultTiers(),
      downgradeFps: 50,
      upgradeFps: 58,
      windowSize: 10,
      cooldownMs: 1000,
      consecutiveSamples: 2,
      initialLevel: 2,
      ...over,
    });

  describe('AutoQuality · 帧率统计', () => {
    test('⚠️ 中位数抗离群（均值会被污染）', () => {
      const m = new FpsMeter(60);
      // 59 帧 16.7ms + 1 帧 500ms（模拟一次 GC 停顿）
      for (let i = 0; i < 59; i++) m.tick(16.7);
      m.tick(500);
      assert(m.median > 55, `中位数应接近 60，实际 ${m.median.toFixed(1)}`);
      assert(m.average < 45, `平均应被明显拉低，实际 ${m.average.toFixed(1)}`);
    });

    test('稳定 60fps', () => {
      const m = new FpsMeter(10);
      for (let i = 0; i < 10; i++) m.tick(16.67);
      near(m.median, 60, 0.5);
    });

    test('稳定 30fps', () => {
      const m = new FpsMeter(10);
      for (let i = 0; i < 10; i++) m.tick(33.3);
      near(m.median, 30, 0.5);
    });

    test('采样未满时 settled=false', () => {
      const m = new FpsMeter(10);
      m.tick(16.7);
      assert(!m.settled);
      for (let i = 0; i < 9; i++) m.tick(16.7);
      assert(m.settled);
    });

    test('lowFps1Percent 反映最差帧', () => {
      const m = new FpsMeter(100);
      for (let i = 0; i < 100; i++) m.tick(16.7);
      const good = m.median;
      for (let i = 0; i < 100; i++) m.tick(i === 0 ? 200 : 16.7);
      assert(m.lowFps1Percent < good,
        `1% low 应更差：${m.lowFps1Percent.toFixed(1)} vs ${good.toFixed(1)}`);
    });
  });

  describe('AutoQuality · 降级', () => {
    test('⚠️ 持续低帧触发降级', () => {
      const a = mk();
      run(a, 33, 30);   // 30fps 持续约 1 秒
      assert(a.level < 2, `应降级，实际 level=${a.level}`);
    });

    test('⚠️ 单帧卡顿不触发降级', () => {
      const a = mk();
      const c = run(a, 16.7, 20);
      a.update(500, c.adv(500));      // 一次 GC 停顿
      run(a, 16.7, 20, c);
      eq(a.level, 2, '单帧卡顿不应触发降级');
    });

    test('⚠️ 连续不达标次数达标才降级', () => {
      const strict = mk({ consecutiveSamples: 100 });
      const loose = mk({ consecutiveSamples: 2 });
      run(strict, 33, 30);
      run(loose, 33, 30);
      eq(strict.level, 2, '阈值 100：30 帧远不够，不应降级');
      assert(strict.state.strikes > 0, `但应在累计次数，实际 ${strict.state.strikes}`);
      assert(loose.level < 2, '阈值 2：应已降级');
    });

    test('⚠️ 降级后进入冷却（不会连降三级）', () => {
      const a = mk();
      const c = new Clock();
      let changedAt = -1;
      for (let i = 1; i <= 30; i++) {
        a.update(33, c.adv(33));
        if (changedAt < 0 && a.level < 2) { changedAt = i; break; }
      }
      assert(changedAt > 0, '应在 30 帧内发生降级');
      assert(a.state.coolingDown, '降级后应进入冷却');
      assert(a.level === 1, `冷却期内不应继续降，实际 level=${a.level}`);
    });

    test('已在最低档不再降', () => {
      const a = mk({ initialLevel: 0 });
      run(a, 100, 60);
      eq(a.level, 0);
    });
  });

  describe('AutoQuality · 升级', () => {
    test('⚠️ 持续高帧触发升级', () => {
      const a = mk({ initialLevel: 0 });
      run(a, 8, 300);   // 125fps 持续 2.4 秒（含冷却）
      assert(a.level > 0, `应升级，实际 level=${a.level}`);
    });

    test('⚠️ 升级比降级更保守（需要更多次采样）', () => {
      /**
       * 【为什么用"首次变化所需帧数"来比较】
       * 直接比较"某固定帧数后有没有升级"会被冷却期干扰——
       * 1000ms 冷却在 8ms/帧下是 125 帧，
       * 喂少了连一次升级都等不到，测不出保守程度。
       */
      const framesToChange = (startLevel: number, dt: number): number => {
        const a = mk({ initialLevel: startLevel, consecutiveSamples: 2 });
        const c = new Clock();
        // 用 55fps 预热：落在 50~58 的稳定区间，不累计任何方向的计数
        run(a, 18.2, 12, c);
        for (let i = 1; i <= 80; i++) {
          a.update(dt, c.adv(dt));
          if (a.level !== startLevel) return i;
        }
        return -1;
      };
      const downFrames = framesToChange(2, 33);   // 灌慢帧 → 降
      const upFrames = framesToChange(0, 8);      // 灌快帧 → 升
      assert(downFrames > 0 && upFrames > 0,
        `两边都应发生变化：降 ${downFrames} 帧，升 ${upFrames} 帧`);
      assert(upFrames > downFrames,
        `升级应需要更多帧：升 ${upFrames} 帧 vs 降 ${downFrames} 帧`);
    });

    test('⚠️ 稳定区间清零计数（避免缓慢累积误触发）', () => {
      const a = mk({ consecutiveSamples: 100 });
      const c = run(a, 33, 12);
      assert(a.state.strikes > 0, `慢帧应累计次数，实际 ${a.state.strikes}`);
      run(a, 18.2, 12, c);   // 55fps，落在 50~58 之间
      eq(a.state.strikes, 0, '进入稳定区间应清零');
    });

    test('allowUpgrade=false 时只降不升', () => {
      const a = mk({ initialLevel: 0, allowUpgrade: false });
      run(a, 8, 300);
      eq(a.level, 0, '不应升级');
    });
  });

  describe('AutoQuality · 迟滞与配置', () => {
    test('⚠️ 升级阈值必须高于降级阈值（否则构造抛错）', () => {
      throws(
        () => new AutoQuality({
          tiers: AutoQuality.defaultTiers(),
          downgradeFps: 55,
          upgradeFps: 55,
        }),
        '横跳'
      );
    });

    test('⚠️ 迟滞阻止边界横跳', () => {
      // 阈值 50 / 58，帧率在 54 附近抖动（落在两者之间）
      const a = mk();
      const c = new Clock();
      for (let i = 0; i < 200; i++) {
        const dt = 17 + (i % 2) * 3;   // 17ms(58.8fps) 与 20ms(50fps) 交替
        a.update(dt, c.adv(dt));
      }
      eq(a.level, 2, '边界抖动不应触发任何切换');
      eq(a.history.length, 0, `不应有任何切换记录，实际 ${a.history.length} 条`);
    });

    test('初始档位不在 tiers 里抛错', () => {
      throws(
        () => new AutoQuality({ tiers: AutoQuality.defaultTiers(), initialLevel: 99 }),
        '99'
      );
    });

    test('空档位抛错', () => {
      throws(() => new AutoQuality({ tiers: [] }), '至少');
    });

    test('默认从最高档开始', () => {
      const a = new AutoQuality({ tiers: AutoQuality.defaultTiers() });
      eq(a.level, 2);
    });
  });

  describe('AutoQuality · 手动控制', () => {
    test('⚠️ 手动设置后锁定自动调节', () => {
      const a = mk();
      a.setManualLevel(0);
      eq(a.level, 0);
      assert(a.locked, '应锁定');
      run(a, 8, 300);   // 持续高帧也不该自动升回
      eq(a.level, 0, '手动设置后不应自动升档');
    });

    test('unlock 恢复自动', () => {
      const a = mk();
      a.setManualLevel(0);
      a.unlock();
      assert(!a.locked);
      // 冷却 1000ms ÷ 8ms ≈ 125 帧，之后还要重新填满窗口并累计 2×2 次
      run(a, 8, 400);
      assert(a.level > 0, `解锁后应能自动升级，实际 level=${a.level}`);
    });

    test('⚠️ 解锁后从当前档开始，不跳到最高', () => {
      const a = mk();
      a.setManualLevel(0);
      a.unlock();
      eq(a.level, 0, '解锁瞬间不应跳档');
    });

    test('手动设置无效档位返回 false', () => {
      const a = mk();
      eq(a.setManualLevel(99), false);
    });

    test('历史记录包含原因', () => {
      const a = mk();
      run(a, 33, 30);
      assert(a.history.length > 0);
      assert(a.history[0]!.reason.includes('帧率'),
        `应记录原因，实际 ${a.history[0]!.reason}`);
    });
  });

  describe('AutoQuality · 诊断', () => {
    test('describe 输出包含关键信息', () => {
      const a = mk();
      run(a, 33, 30);
      const s = a.describe();
      assert(s.includes('当前档位'));
      assert(s.includes('阈值'));
      assert(s.includes('切换记录'));
    });

    test('⚠️ 冷却期内的 fps 读数必须标记为不可信', () => {
      /**
       * 【为什么需要 fpsValid】
       * 切换档位会清空采样窗口，缓冲区里残留的是**上一档位**的帧时间。
       * 直接读 medianFps 会得出"已降到低画质，但帧率显示 60"
       * 这种自相矛盾的输出——调试面板上看到会让人怀疑人生。
       */
      const a = mk();
      const c = new Clock();
      run(a, 16.7, 20, c);
      assert(a.state.fpsValid, '稳定采样后应可信');

      // 灌慢帧直到降级
      for (let i = 0; i < 30; i++) {
        a.update(33, c.adv(33));
        if (a.history.length > 0) break;
      }
      eq(a.history.length, 1, '应已降级');
      eq(a.state.fpsValid, false, '降级后处于冷却，读数不可信');

      /**
       * 【⚠️ 恢复阶段要喂"稳定区间"的帧率】
       * 继续喂 33ms（30fps）会一路降到最低档，
       * 每次降级都重新进入冷却，读数永远不会变回可信。
       * 用 18.2ms（55fps）：落在 50~58 的死区，不会再触发任何切换。
       */
      run(a, 18.2, 80, c);
      eq(a.state.fpsValid, true, '重新采样满后应恢复可信');
      eq(a.history.length, 1, '稳定区间不应再触发切换');
    });

    test('settings 返回当前档参数', () => {
      const a = mk({ initialLevel: 0 });
      eq(a.settings.shadow, false);
      a.setManualLevel(2);
      eq(a.settings.shadow, true);
    });

    test('tier 返回档位对象', () => {
      const a = mk({ initialLevel: 1 });
      eq(a.tier.name, '中');
    });

    test('⚠️ 冷却期内 fpsValid=false（避免显示自相矛盾的读数）', () => {
      const a = mk();
      run(a, 16.7, 20);
      eq(a.state.fpsValid, true, '稳定后应可信');
      run(a, 33, 30);
      assert(a.state.coolingDown, '应进入冷却');
      eq(a.state.fpsValid, false, '冷却期读数不可信');
    });

    test('⚠️ 采样未满时 fpsValid=false', () => {
      const a = mk();
      a.update(16.7, 16.7);
      eq(a.state.fpsValid, false);
    });

    test('⚠️ describe 在冷却期不输出误导性帧率', () => {
      const a = mk();
      run(a, 33, 30);
      assert(a.state.coolingDown);
      const s = a.describe();
      assert(!s.includes('中位'), `冷却期不应输出帧率读数，实际：${s.split('\n')[1]}`);
      assert(s.includes('测量中'));
    });
  });
}

// ==================== 8. DiagPack ====================

export function runBatch19DiagPackTests(): void {
  describe('DiagPack · 安全序列化', () => {
    test('基础类型', () => {
      eq(safeStringify({ a: 1, b: 'x', c: true }), '{"a":1,"b":"x","c":true}');
    });

    test('⚠️ 循环引用不抛错', () => {
      const o: Record<string, unknown> = { a: 1 };
      o.self = o;
      const s = safeStringify(o);
      assert(s.includes('Circular'), `应标记循环，实际 ${s}`);
    });

    test('⚠️ BigInt 不抛错', () => {
      /**
       * 【为什么写得这么绕】
       * tsconfig 的 target 是 ES2019（与 Cocos 保持一致），
       * 而 BigInt 字面量语法需要 ES2020。
       * 运行时（Node 20）是支持的，所以从全局取构造函数。
       * 拿不到就跳过——这条测试保护的是"不崩"，不是语法。
       */
      const BigIntCtor = (globalThis as { BigInt?: (v: number) => unknown }).BigInt;
      if (BigIntCtor === undefined) return;
      const s = safeStringify({ big: BigIntCtor(123) });
      assert(s.includes('123n'), `实际 ${s}`);
    });

    test('⚠️ NaN / Infinity 转成字符串（JSON 会变 null 丢信息）', () => {
      const s = safeStringify({ a: NaN, b: Infinity });
      assert(s.includes('NaN'), `实际 ${s}`);
      assert(s.includes('Infinity'));
    });

    test('函数标记而非丢弃', () => {
      const s = safeStringify({ fn: () => 1 });
      assert(s.includes('Function'), `实际 ${s}`);
    });

    test('Error 展开为 name/message/stack', () => {
      const s = safeStringify({ e: new Error('boom') });
      assert(s.includes('boom'));
      assert(s.includes('stack') || s.includes('name'));
    });

    test('⚠️ 超深嵌套不爆栈', () => {
      let o: Record<string, unknown> = {};
      let cur = o;
      for (let i = 0; i < 50; i++) {
        cur.next = {};
        cur = cur.next as Record<string, unknown>;
      }
      const s = safeStringify(o, { maxDepth: 4 });
      assert(s.includes('DeepObject'), `应标记超深，实际 ${s.slice(0, 100)}`);
    });

    test('Map / Set 可序列化', () => {
      const s = safeStringify({ m: new Map([['a', 1]]), s: new Set([1, 2]) });
      assert(s.includes('Map'));
      assert(s.includes('Set'));
    });

    test('Date 转 ISO', () => {
      const s = safeStringify({ d: new Date(0) });
      assert(s.includes('1970-01-01'), `实际 ${s}`);
    });

    test('undefined 转为 null（而非消失）', () => {
      const s = safeStringify({ a: undefined });
      assert(s.includes('null'), `实际 ${s}`);
    });
  });

  describe('DiagPack · 脱敏', () => {
    test('⚠️ 手机号被替换', () => {
      const r = redact('{"phone":"13800138000"}');
      assert(!r.includes('13800138000'), `手机号应被脱敏，实际 ${r}`);
      assert(r.includes('REDACTED'));
    });

    test('⚠️ 邮箱被替换', () => {
      const r = redact('{"mail":"a.b@example.com"}');
      assert(!r.includes('a.b@example.com'), `邮箱应被脱敏，实际 ${r}`);
    });

    test('⚠️ token 类 key 被替换', () => {
      const r = redact('{"accessToken":"abc123"}');
      assert(!r.includes('abc123'), `token 应被脱敏，实际 ${r}`);
    });

    test('⚠️ password key 被替换', () => {
      const r = redact('{"password":"secret123"}');
      assert(!r.includes('secret123'));
    });

    test('JWT 被替换', () => {
      const r = redact('{"auth":"eyJhbGciOi.eyJzdWIiOi.SflKxwRJ"}');
      assert(!r.includes('eyJhbGciOi'), `JWT 应被脱敏，实际 ${r}`);
    });

    test('⚠️ 替换全部而非只有第一个（需要 g 标志）', () => {
      const r = redact('{"a":"13800138000","b":"13900139000"}');
      assert(!r.includes('13800138000') && !r.includes('13900139000'),
        `两个手机号都应被替换，实际 ${r}`);
    });

    test('⚠️ 自定义规则生效', () => {
      const r = redact('{"playerId":"PID-9988"}', [
        { name: 'pid', valuePattern: /PID-\d+/g, replacement: '[PID]' },
      ]);
      assert(r.includes('[PID]'));
      assert(!r.includes('9988'));
    });

    test('⚠️ 正常数据不被误伤', () => {
      const r = redact('{"level":42,"name":"player1"}');
      assert(r.includes('42'));
      assert(r.includes('player1'));
    });

    test('⚠️ 正则带 g 标志时不重复追加', () => {
      const r = redact('{"a":"13800138000","b":"13900139000"}', [
        { name: 'phone', valuePattern: /1[3-9]\d{9}/g },
      ]);
      assert(!r.includes('13800138000') && !r.includes('13900139000'));
    });
  });

  describe('DiagPack · 收集器', () => {
    const mkCollector = (over: Partial<{ maxSectionChars: number; maxTotalChars: number }> = {}) =>
      new DiagCollector({
        appId: 'test-app',
        version: '1.2.3',
        maxSectionChars: over.maxSectionChars ?? 20000,
        maxTotalChars: over.maxTotalChars ?? 200000,
      });

    test('生成报告含基本信息', () => {
      const c = mkCollector();
      c.section('env', () => ({ os: 'iOS' }));
      const r = c.generate(1000);
      eq(r.appId, 'test-app');
      eq(r.version, '1.2.3');
      eq(r.generatedAtMs, 1000);
      eq(r.schema, 'cocos-kit-diag/1');
    });

    test('⚠️ 单个分区失败不影响其他分区', () => {
      const c = mkCollector();
      c.section('bad', () => { throw new Error('boom'); });
      c.section('good', () => ({ ok: 1 }));
      const r = c.generate();
      eq(r.sections.length, 2);
      eq(r.sections[0]!.error, 'boom');
      eq(r.sections[1]!.error, undefined);
      assert(r.warnings.some((w) => w.includes('bad')));
    });

    test('⚠️ generate 永不抛错（收集过程自身不能崩）', () => {
      const c = mkCollector();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      c.section('circular', () => circular);
      c.section('throw', () => { throw new Error('x'); });
      let r: ReturnType<typeof c.generate> | null = null;
      try {
        r = c.generate();
      } catch {
        /* 不应到这里 */
      }
      assert(r !== null, 'generate 不应抛错');
    });

    test('⚠️ provider 在 generate 时才执行（不是注册时）', () => {
      const c = mkCollector();
      let n = 0;
      c.section('lazy', () => { n++; return 1; });
      eq(n, 0, '注册时不应执行');
      c.generate();
      eq(n, 1);
    });

    test('⚠️ 分区超出配额被截断', () => {
      const c = mkCollector({ maxSectionChars: 50 });
      c.section('big', () => ({ data: 'x'.repeat(500) }));
      const r = c.generate();
      eq(r.sections[0]!.truncated, true);
      assert(r.warnings.some((w) => w.includes('截断')));
    });

    test('⚠️ 总配额生效（超出部分被丢弃）', () => {
      const c = mkCollector({ maxTotalChars: 300 });
      for (let i = 0; i < 5; i++) {
        c.section(`s${i}`, () => ({ data: 'y'.repeat(200) }));
      }
      const r = c.generate();
      assert(r.totalChars <= 300 + 50, `总字符应受限，实际 ${r.totalChars}`);
      assert(r.warnings.some((w) => w.includes('总配额')));
    });

    test('⚠️ 收集的数据被脱敏', () => {
      const c = mkCollector();
      c.section('user', () => ({ phone: '13800138000' }));
      const json = c.generateJson();
      assert(!json.includes('13800138000'), `诊断包不应含手机号，实际 ${json}`);
    });

    test('removeSection', () => {
      const c = mkCollector();
      c.section('a', () => 1);
      eq(c.removeSection('a'), true);
      eq(c.removeSection('a'), false);
      eq(c.generate().sections.length, 0);
    });

    test('sectionNames 列出分区', () => {
      const c = mkCollector();
      c.section('a', () => 1).section('b', () => 2);
      eq(c.sectionNames.length, 2);
    });

    test('⚠️ 自定义脱敏规则生效', () => {
      const c = new DiagCollector({
        appId: 'x', version: '1',
        extraRedactions: [{ name: 'pid', valuePattern: /PID-\d+/g, replacement: '[PID]' }],
      });
      c.section('u', () => ({ id: 'PID-1234' }));
      const json = c.generateJson();
      assert(json.includes('[PID]'));
      assert(!json.includes('1234'));
    });
  });

  describe('DiagPack · 摘要与环境', () => {
    test('summarize 输出可读摘要', () => {
      const c = new DiagCollector({ appId: 'a', version: '1' });
      c.section('env', () => ({ os: 'iOS' }));
      c.section('bad', () => { throw new Error('x'); });
      const s = c.summarize();
      assert(s.includes('诊断包'));
      assert(s.includes('env'));
      assert(s.includes('✗'), '失败的分区应标记');
    });

    test('⚠️ collectEnvironment 记录时区偏移', () => {
      const e = collectEnvironment({ platform: 'web' });
      assert('timezoneOffsetMin' in e);
      assert('timezone' in e);
      eq(e.platform, 'web');
    });

    test('collectEnvironment 透传额外字段', () => {
      const e = collectEnvironment({ customField: 42 } as never);
      eq((e as { customField: number }).customField, 42);
    });
  });
}

// ==================== 汇总入口 ====================

export function runBatch19Tests(): void {
  runBatch19AudioTests();
  runBatch19BgmTests();
  runBatch19CutsceneTests();
  runBatch19TransitionTests();
  runBatch19MinimapTests();
  runBatch19BuilderTests();
  runBatch19AutoQualityTests();
  runBatch19DiagPackTests();
}
