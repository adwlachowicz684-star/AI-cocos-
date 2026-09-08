# 验收报告 · W3-A 验收 W3-B

**验收对象**：`audit/result_W3-B.md` + `tests/run_phase10_w3b.ts`（9 单元 / 18 条：P1 14 / P2 4 组）
**验收代码基线**：远程 `main` 最新（含 W3-B 提交 `f56fd9d` 与后续合并）
**结论**：**通过**（附 3 条需总审裁决 + 1 处共享脚本改动需总审追认）

---

## 0. 验收方法（先说清楚我是怎么验的）

任务书标准 2 要求"判断这条断言回退修复后会不会红"，同时明令**不要改回旧代码跑**——
因为那会动 `.build/`，已真实发生过产物被覆盖的事故（**这次事故的肇事方就是我，见 §4**）。

我的做法：**把 `.build/` 复制一份到 `/tmp/rollback`，在副本上回退，跑出"修复前"数值，
仓库里真正的 `.build/` 全程没碰。** 这样既能拿到真实输出，又不产生任何污染风险。

回退验证结果 —— **8 条，与对方报告的数值逐字吻合**：

| 条目 | 我在副本上回退后跑出的"修复前" | 对方报告写的 | 是否一致 |
|---|---|---|---|
| cheatcode `historyLimit=NaN` | `history.length = 2000` | `2000` | ✓ |
| currency `logOf(id,0)` | `.length = 5` | `5` | ✓ |
| currency `netChange` | 余额 `200` / netChange `50` | `200` / `50` | ✓ |
| inventory `remainingSpaceFor` | `= 9`，`add(5)` → leftover `5`、count `1` | 同 | ✓ |
| ranking 分布顺序 | 宗师在前 `gm,bronze`；青铜在前 `bronze,gm` | 同 | ✓ |
| room-graph `findBestPath` | `truncated=true total=NaN path.length=6` | 同 | ✓ |
| wave-spawner cleared+timeout | 兜底 `null` / `state=fighting` | 同 | ✓ |
| snapshot `deepClone` TypedArray | 克隆后构造器变 `Object`（**我在做本窗口现状核验时独立测过，早于本次验收**） | 同 | ✓ |

一条都没对不上。**对方报告里的"复现输出"是自己真跑出来的，不是抄原报告、也不是脑补。**

---

## 1. 逐条验收（18 条）

图例：✓ 通过 / ✗ 不通过 / — 不适用 / 待裁决

| # | 条目 | 标准1 复现 | 标准2 测试有效 | 标准3 对照 | 标准4 无顺手重构 | 标准5 未误判 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | cheatcode `historyLimit` | ✓ | ✓ 喂 NaN | ✓ 默认 50 / 显式 5 | ✓ +21/-1 | ✓ | 报告"0/-5 碰巧安全、唯独 NaN 穿透"，判断准确 |
| 2 | currency `logOf(0)` | ✓ | ✓ 喂 0 | ✓ 取 2 条/不传 | ✓ | ✓ | `slice(-0)` 陷阱确认 |
| 3 | currency `netChange` | ✓ | ✓ logLimit=5 | ✓ clearLog/trackLog | ✓ | ✓ | 改独立累加器，未动日志裁剪本身 |
| 4 | currency `precision` | ✓ | ✓ 喂 400 | ✓ 小数精度 | ✓ +47/-3 | ✓ | |
| 5 | daily 种子空间 | ✓ | ✓ 400 天 | ✓ 分享回填 | — | — | **自选方案，需总审知悉**，见 §3① |
| 6 | inventory `remainingSpaceFor` | ✓ | ✓ 喂 data=0 | ✓ 正常堆叠 | ✓ +51/-3 | ✓ | 改查询对齐写入，方向正确 |
| 7 | inventory `compact` 丢弃 | ✓ | ✓ 构造超额 | ✓ 正常整理 | ✓ | ✓ | **只补返回值未改行为**，见 §3② |
| 8 | ranking 分布顺序 | ✓ | ✓ 两种顺序 | ✓ 升降段 | ✓ +70/-9 | ✓ | 改 `tierDistribution` 排序（根因层） |
| 9 | ranking 进度条陈旧 | ✓ | ✓ 1450→1490 | ✓ 升降段保护 | ✓ +31/-1 | ✓ | |
| 10 | room-graph 截断 NaN | ✓ | ✓ 触发截断 | ✓ 不截断时 | ✓ +85/-9 | ✓ | 让 `total` 自洽于 `path` |
| 11 | snapshot TypedArray | ✓ | ✓ Uint8Array/类实例 | ✓ Date/Map/Set | ✓ +79/-4 | ✓ | |
| 12 | stats 原型链查表 | ✓ 现象不存在 | ✓ 守护用例 | ✓ 派生指标 | **未改代码** ✓ | ✓ | **判"不成立"正确**，见 §2 |
| 13 | stats `record(NaN)` | ✓ 现象不存在 | ✓ 守护用例 | ✓ 正常聚合 | **未改代码** ✓ | ✓ | **判"不成立"正确**，见 §2 |
| 14 | wave cleared 下 timeout | ✓ | ✓ cleared+timeout | ✓ timeout/全局/关闭 | ✓ +55/-8 | ✓ | |
| P2-D3 | daily `submit(NaN)` | ✓ | ✓ 喂 NaN | ✓ 正常成绩 | ✓ | ✓ | |
| P2-D4 | daily `importState` 坏档 | ✓ | ✓ 4 条坏数据 | ✓ 往返 | ✓ | ✓ | |
| P2-D5 | daily 种子 0 退化 | ✓ | ✓ seed=0 | ✓ 其余 seed 逐位不变 | ✓ | ✓ | 加盐会 breaking，判断正确 |
| P2-D6 | daily 时间源未注入 | — | — | — | — | — | **待裁决**（对方未改并已上交）✓ |
| P2-D7 | daily `_attempts` 只增 | — | — | — | **未改** ✓ | ✓ | 我查过 `prune` 确实同时清两个 Map，**判断正确** |
| P2-R2 | room-graph 空 if 块 | ✓ | ✓ untyped 计数 | ✓ assignTypes 后 | ✓ | ✓ | **未盲补 `issues.push`**，见 §3③ |
| P2-R3/R5 | crossings O(E²) | — | — | — | **未改** ✓ | ✓ | 纯性能，不修合理 |
| P2-R4 | fixed 被兜底覆盖 | ✓ | ✓ fixed 指定层 | ✓ 未设 fixed | ✓ | ✓ | |
| P2-R6 | 无重试/降级 | — | — | — | **未改** ✓ | — | **待裁决** ✓ |
| P2-Sn3 | `depthOf` 计数 | — | — | — | **未改** ✓ | ✓ | P0-2 已由 `compareRemoveOrder` 修掉，不动 |
| P2-Sn4 | 递归无深度上限 | — | — | — | **未改** ✓ | ✓ | 加上限会截断合法深层数据，理由成立 |
| P2-Sn5 | `maxDepth` 未收口 | ✓ | ✓ 0/-1/NaN | ✓ | ✓ | ✓ | |
| P2-Sn6 | 存原对象引用 | ✓ | ✓ 改副本验原对象 | ✓ | ✓ | ✓ | |
| P2-Sn7 | 数组 diff 按下标 | — | — | — | **未改** ✓ | ✓ | "语义正确只是噪声大"→ 不是缺陷，判断正确 |
| P2-W2 | 注释归因错误 | ✓ | — | — | 只改注释 ✓ | ✓ | 指出"结论对但归因错"，诚实 |
| P2-W3 | `shift()` O(n²) | — | — | — | **未改** ✓ | ✓ | 纯性能 |
| P2-W4 | rng 注入后未用 | — | — | — | **未改** ✓ | ✓ | 源码有注释说明是有意保留的扩展点 |
| P2-W5 | `aliveCount` 名实不符 | — | — | — | **未改** ✓ | — | **待裁决** ✓ |
| P2-W6 | 无 `destroy()` | — | — | — | **未改** ✓ | ✓ | 纯逻辑无监听，"文档声明 N/A"比硬凑空方法好 |

---

## 2. 标准 5 重点复核：stats 两条判"不成立"

这是本项目最容易复发的一类错误（把已修好的当成缺陷重复修，或反过来）。我独立验了：

```
stats/Stats.ts:229  →  if (hasOwn(this._derived, id))        ← 已经是 hasOwn，不是 `in`
stats/Stats.ts:273  →  derived() 同样用了 hasOwn
stats/Stats.ts:188  →  record() 已用 needFinite(...)
stats/Stats.ts:206  →  set() 已用 needFinite(...)
```

实测（我自己跑的，不是抄对方的）：

```
get('toString')        → throw: [Stats] 未定义的指标：toString
record('score', NaN)   → throw: [guard] Stats.record(score).value 必须是有限数值
```

**现象确实不存在。** 对方没有改这两处代码，只补了守护用例——**这是对的处理方式**。
如果照原报告去"修"，要么引入重复守卫，要么把别人的修复改坏。判"不成立"正确。

---

## 3. 需总审裁决 / 知悉的 4 件事

### ① P1-5 daily：对方**没有采用**审查建议，自选了方案

- 审查建议：`seed` 直接用 `hashDateKey(date)`，只在展示时用 `seedToText`
- 对方理由：这会破坏 `fromText(entryFor(d).seedText).seed === entryFor(d).seed`
  （`daily/README.md` §4 + `run_batch11.ts` 的既有回归用例），
  玩家分享出去的码会还原不出同一张图——**用一个静默不一致换另一个**
- 实际改法：让 `seedToText` 无损覆盖 32 位（4bit+4bit+24bit），成为单射

**我的判断**：对方的理由成立，自选方案**优于**审查建议。已验证"分享回填"用例仍通过。
**但这是"窗口不采纳审查建议"的情形，按纪律必须报总审知悉**，请总审确认。
代价是数字段从固定 2 位变 2~8 位（旧短码仍合法且映射同一种子）——UI 若硬编码了宽度需要适配。

### ② P1-7 `compact()` 只补出口、没改丢弃行为

`compact()` 现在返回被丢弃数量，但**仍然会丢**。
理由（"整理不丢东西要重新设计容量语义"）我认为成立，但**调用方必须检查返回值**，
否则等于没修。建议总审在合并时确认没有既有的 `compact()` 调用点被漏掉。

### ③ P2-R2 没有盲补 `issues.push`

原代码是空 if 块，直觉修法是补一句 `issues.push(...)`。
**对方实测发现那会让 `generateRoomGraph` 100% 抛错**（它自己生成的图就全空类型，
而它在 `diagnose().ok === false` 时直接抛错）。
改成新增 `untyped` 字段暴露数量，由调用方判断。

**这个判断救了一个必崩 bug，值得记一笔。** 同类"空 if 块"在其他窗口可能也有，建议总审提醒别盲补。

### ④ 对方改了共享脚本 `scripts/check-links.js`

原脚本用正则在全文匹配 `](...)`，没有排除 markdown 行内代码与围栏代码块，
导致报告里引用含 `](...)` 的源码就被误判成断链（我自己的 `result_W3-A.md` 也中过）。

各窗口为让它变绿去改自己报告的写法是治标不治本。对方新增 `stripCode()` 修了**根因**，
断链 8 → 0，并做了注入测试确认没削弱检测能力（真断链仍能报出）。

**方向我认可，但 `scripts/` 是跨窗口共享文件，改它需要总审追认。** 请总审确认这处修改的归属。

---

## 4. ⚠️ 一件必须记录的事：我（W3-A）造成过一次 P0 事故

**事故**：我的提交 `63c0bee` 在合入自己改动的同时，**把 W7-A 的全部成果删掉了**。

```
removed audit/result_W7-A.md        -86
removed audit/verify_W7-A.md        -96
removed tests/run_phase10_w7a.ts    -710
removed 旧版本迁移说明.md            -227
modified dash/DashController.ts     +9/-90     ← W7-A 的修复被回退
modified grid/Grid.ts               +13/-104
modified objective/ObjectiveSystem.ts +1/-73
modified progressbar/ProgressBar.ts +11/-73
```

**根因**：我用 GitHub Git Data API 推送时，**硬编码了 `base_tree`**（我最初拉仓库时的 tree sha），
而推送时远程 `main` 已经前进到 `70b6134`（W7-A 已合入）。
于是新 tree = 旧 tree + 我的改动，**W7-A 的文件在 diff 里全变成了删除**。
这是典型的"用过期快照覆盖了别人的提交"。

**修复**：由 W3-B 在提交 `8c0b3b55` 中抢救恢复（"P0事故抢救：恢复被 W3-A 提交误删的 W7-A 全部成果"）。
我已复核恢复结果：

```
W7-A 4 个文件全部在位；run_phase10_w7a.ts 独立运行 44 项全绿
我的 W3-A 62 项也仍全绿，未受影响
```

**教训**：用 API 建 tree 必须实时取远程 `main` 的 tree sha，不能用缓存值。
我第二次推送（`d280164`）已改为实时获取，未再出问题。

---

## 5. 附：全库校验结果（我在远程最新代码上跑的）

```
bash build.sh                  → TSC OK（227 个 .js）
node .build/tests/run.js       → 通过 3696 项，失败 1 项
                                  ✗ binary · float 会 clamp 而不是溢出回绕
                                    （属 W8-B 窗口，与 W3-B 无关）
tests/run_phase10_w3b.ts       → 通过 40 项，失败 0 项  ✓
tests/run_phase10_w7a.ts       → 通过 44 项，失败 0 项（W7-A 恢复确认）
tests/run_phase10_w3a.ts       → 通过 62 项，失败 0 项（我自己的）

node scripts/check-deps.js     → ✗ 1 项：6 个单元 import 了 _core 但没登记
                                  i18n / curse / achievement / rebind / gameflow / accessibility
                                  ← 我逐个核对过，**没有一个属于 W3-B**，其 9 个单元登记干净
                                    （对方报告时是 5 条，现已涨到 6 条，说明还在持续恶化，
                                      建议总审跑 --fix 统一处理）
node scripts/check-links.js    → ✓ 断链 0 处（对方修了根因后已从 8 → 0）
python3 scan-dt-guard.py       → ✓ 命中 0 处
python3 scan-num-guard.py      → ✓ 命中 0 处
python3 check-random-source.py → ✓ 未发现自建随机源
python3 check-dup-exports.py   → ✓ 无待处理冲突
```

---

## 6. 结论

**通过。**

- 标准 1（复现）：8 条独立回退验证，数值与对方报告**逐字吻合**
- 标准 2（测试有效）：所有 `⚠️` 用例喂的都是会触发 bug 的输入，回退后必然变红
- 标准 3（对照用例）：每个 describe 都有"防止矫枉过正"用例
- 标准 4（无顺手重构）：13 文件 +1816/-51，删除仅 51 行，纯新增为主；9 单元中 stats 未动（判不成立的没硬改）
- 标准 5（未误判设计）：stats 两条、D7、Sn7、W4 等"不修"判断我逐条核过源码，全部成立

需总审处理：§3 的 4 件事（daily 自选方案追认、`compact()` 返回值调用点排查、R2 同类问题提醒、共享脚本改动追认）
+ §5 中 `check-deps.js` 的 6 条未登记（非 W3-B 引入，但建议统一 `--fix`）。
