# 验收报告 · W5-A 验收 W5-B

## 结论

**无法验收 —— W5-B 尚未交付。**

按 `audit/review_A.md` §1，W5-B 应产出两个交付物，在本次验收时**均不存在**：

| 应交付 | 路径 | 实际 |
|---|---|---|
| 修复报告 | `audit/result_W5-B.md` | ❌ 不存在（整个 `audit/` 下没有任何 `result_*` 文件） |
| 回归测试 | `tests/run_phase10_w5b.ts` | ❌ 不存在（`tests/` 下只有本窗口的 `run_phase10_w5a.ts`） |

因此 §2 的五条硬标准（复现 / 测试有效 / 对照用例 / 无顺手重构 / 未误判设计）
**无法逐条给出判断**——它们全部是针对"对方的交付物"的，没有对象可验。

按验收纪律，"验收方不直接改对方代码"，所以我没有替 W5-B 修任何一条。

---

## 二、我做了什么替代工作

为了让 W5-B 开工时不用从零复现，我用**独立只读脚本**（放在仓库外，未修改任何 W5-B
单元代码，未改 `tests/run.ts`）对清单里的 7 条 P1 做了现状核查，确认现象在当前代码上
是否真实成立。以下输出都是我实际跑出来的：

| 条目 | 核查结论 | 实测输出 |
|---|---|---|
| `accessibility` — `fontScale` 构造校验挡不住 NaN | ✅ **现象成立** | `new Accessibility({ fontScale: NaN }).fontScale` → `NaN`。构造里是 `opts.fontScale ?? 1` 后再 `if (this._fontScale <= 0) throw`——`NaN <= 0` 为 false，直接穿透 |
| `analytics` — `variance` 灾难性消去 | ✅ **现象成立**（且比原报告更严重） | `variance(1e9+1..1e9+4)` → **0**（数学期望 1.667）；`variance(1e12+1..1e12+4)` → **0**；对照 `variance(1,2,3,4)` → `1.6666666666666667`。注意 `Math.max(0, v)` 会把消去后的负值也一并抹成 0，不是"轻微为负"那么温和 |
| `feedback` — `update` 的 dt 守卫挡不住 Infinity | ✅ **现象成立** | `update(Infinity)` → `timeScale = 1`、`activeCount = 0`（一帧内被推完，反馈完全看不到）；对照 `update(1/60)` → `timeScale = 0.1`、`activeCount = 1`。守卫是 `!(realDt > 0)`，`Infinity > 0` 为 true，不进分支 |
| `mmr` — `baseRating` 的 switch 无 default | ✅ **现象成立** | 2 人队伍：`strategy='avg'` → `base=1100`；`'max'` → `1200`；**`'min'` → `base=undefined`**；**`'garbage'` → `base=undefined, effective=NaN`**。非法 strategy 静默返回 undefined 并污染 `effective` |
| `mmr` — `MmrPlayer.rating` 无有限性校验 | ✅ **现象成立** | `teamMmr([{rating:NaN},{rating:1200}], {strategy:'avg'})` → `base = null`（NaN）、`effective = null`、`spread = null`。一个 NaN 传染整局匹配分 |
| `rarity` — `order` 只查重复不查有限性 | ⚠️ **未实测**（脚本未覆盖，留给 W5-B 自己复现） | — |
| `scenerouter` — 时间单位与全库不一致（毫秒 vs 秒） | ⚠️ **未实测**（需对比 README 与 `tick` 签名，留给 W5-B 自己复现） | — |

（上面用到的只读脚本放在仓库外的 `verify/` 目录，没有进仓库，也不会触发
`check-deps.js` 的未登记目录报错。）

---

## 三、给 W5-B 的提醒（开工前看一眼）

1. **`analytics.variance` 的修法要小心**：`Math.max(0, v)` 现在把灾难性消去的结果
   （一个巨大的负数）也抹成 0。改成两遍遍历（Welford 或先算 mean 再算 Σ(x−m)²）之后，
   要确认 `Math.max(0, …)` 还需要保留——它是为了挡浮点误差，但也会掩盖真实错误。
2. **`mmr.baseRating` 的 `'min'` 分支也返回 undefined**：这不只是"非法 strategy"的问题，
   连一个**合法**策略都不通。修 default 时顺手确认 `'min'` 是不是漏了分支，
   别只加 `default` 就了事。
3. **`feedback` 的守卫别写成 `!(realDt > 0)` 的变体**：要挡的是"非有限值"，
   直接 `Number.isFinite(realDt) && realDt > 0` 最清楚。
4. **`accessibility` 的 `shakeScale`**：原报告说"构造不 clamp 而 setter clamp"，
   统一口径时先确认 setter 的 clamp 范围——别把合法的 `0`（关闭震动）夹成 1，
   这是全库已经踩过一次的坑（`maxVoices` 把"静音配置 0"夹成 1）。

---

## 四、附：全库校验结果（本窗口交付后）

```bash
bash build.sh                       # TSC OK（产物校验通过：211 个 .js）
node .build/tests/run.js            # 通过 3695 项，失败 0 项
node scripts/check-deps.js          # 全部通过 ✓
node scripts/check-links.js         # 44 条内部链接，断链 1 处（audit/handoff_W3-B.md，非本窗口引入）
python3 scripts/scan-dt-guard.py    # 扫描 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py   # 扫描 0 处命中 ✓
python3 scripts/check-random-source.py  # [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py    # [OK] 无待处理的冲突 ✓
```

> `tests/run.js` 的 3695 项里**不含**本窗口新增的 52 项——`tests/run.ts` 按任务书 §6
> 由总审统一合并注册，我没有改它。W5-B 交付后同样如此，请总审一并合并。
