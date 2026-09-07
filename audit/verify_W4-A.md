# 验收报告 · W4-A 验收 W4-B

## 结论

**无法验收 —— 对方尚未交付。**

按 `review_A.md` 第 1 节，W4-B 应产出：

- `audit/result_W4-B.md`
- `tests/run_phase10_w4b.ts`（导出 `runPhase10W4BTests()`）

本窗口落盘时，这两份文件**在仓库里都不存在**：

```
$ ls audit/result_W4-B.md tests/run_phase10_w4b.ts
ls: cannot access 'audit/result_W4-B.md': No such file or directory
ls: cannot access 'tests/run_phase10_w4b.ts': No such file or directory
```

整个 `audit/` 下没有任何 `result_*.md` 或 `verify_*.md`，全库 `tests/` 下也只有本窗口的
`run_phase10_w4a.ts`——即**第 B 组 8 个窗口整体尚未开始交付**，不是 W4-B 单独落后。

因此五条硬标准**逐条无从判断**：没有对方的复现输出（标准 1）、没有测试代码可读（标准 2/3）、
没有改动范围可比对（标准 4/5）。按 `review_A.md` 第 0 节
"验收不是看一遍觉得对，是逐条独立验证"，本窗口不做任何形式的"预估通过"。

---

## 二、替代动作：W4-B 15 条的**只读基线核验**

为了不让这次验收变成一张空表，本窗口在**不修改任何代码**的前提下，
对 W4-B 的 15 条在当前基线（= W4-A 修复后、`main` 之前）上做了一次存在性核验。
用途有两个：

1. 对方开工时可直接拿它当"复现前基线"，省一轮重复劳动
2. 总审合并时可用它判断"W4-B 的修复是否真的改变了行为"

方法：只读脚本 + 源码定位，全部走公开 API 或读文件，**未改任何一行**。

| 条目 | 单元 | 核验方式 | 当前基线结论 |
|---|---|---|---|
| 所有选项条件都不满足时对话死锁 | dialogue | 查 `DialogueGraph` 实例成员 | **仍存在**：`hasEnabledChoice` 为 `undefined`（建议的 API 尚未提供） |
| `isSymmetric()` 污染 `explored` | fov | 导出符号核对 | **未修**：`fov/FOV` 导出 `VisibilityMap / Shadowcasting / Raycasting / makeWallTest`，`isSymmetric` 在 `Raycasting` 上 |
| `_castRay` 在 NaN 坐标下死循环 | fov | **源码定位（不敢实跑）** | **未修**：`FOV.ts:492-509` 越界检查仍是 `x < 0 \|\| y < 0 \|\| x >= w \|\| y >= h`（否定不了 NaN）。**本窗口刻意没有实跑**——死循环会冻死沙盒进程，与"验收不得破坏构建"冲突 |
| `evaluate()` 返回复用对象 | joystick-mover | 实跑 | **仍存在**：`a === b` → `true`（第二次 `evaluate` 改写了第一次持有的引用） |
| `addImpulse` 默认 `maxExternal = Infinity` | mover | 读源码 | **仍存在**：签名 `addImpulse(ix, iy, maxExternal = Infinity)` |
| `moveBy` 无 `safeDt` 守卫 | mover | 读源码 | **仍存在**：`moveBy` 前 400 字符内无 `safeDt`（而 `update` 有） |
| `externalDamping`/`turnBoost` 未收口 | mover | 读源码 | **仍存在**：构造校验只有 `maxSpeed/accel/decel` 三条 `!(x > 0)` |
| `importState` 坏数据中断整批 | rebind | 源码定位 | **未修**（需在对方交付后复现） |
| 重复 code 导入导致前一动作被解绑 | rebind | 源码定位 | **未修** |
| `prettyKey` 原型链污染 | rebind | 实跑 | **仍存在**：`prettyKey('constructor')` 的 `typeof` 是 **`function`** |
| `activePaths()` 是 O(n²) | reddot | 读源码 | **仍存在**：`[...this._leaf.keys()].filter((p) => this.get(p) > 0)`，而 `get` 内部全表扫描 |
| `_log` 无容量上限 | shop | 读源码 | **仍存在**：`Shop.ts:426` / `:459` 两处 `this._log.push`，无裁剪 |
| P2 三条（fov / mover / rebind，见正文） | — | — | 未逐条展开（P2 可选，等对方交付后按取舍再验） |

**结论一致性**：12 条 P1 全部"仍存在/未修"，与"W4-B 尚未交付"互相印证——
不存在"对方偷偷改了但没写报告"的情况。

---

## 三、给 W4-B 窗口的三点提醒（提前说，减少返工）

这三点来自本窗口自己踩过的坑，不是对未交付内容的评判。

1. **`fov._castRay` 的 NaN 死循环，复现时别在沙盒里直接跑。**
   它会冻死进程（无异常、无日志，`try/catch` 无效）。
   建议要么按源码逐步模拟（就像原报告 `b1_v2` [17] 做的那样），
   要么在子进程里跑并加超时。`review_A.md` 第 2 节也明令禁止
   "改回旧代码跑一遍"的破坏性验证。

2. **`mover` 的 `addImpulse` 是"模式 F：缺省配置与 JSDoc 承诺相反"的实例。**
   改法二选一（改默认值 / 改文档），**不要只改一个又不动另一个**——
   本窗口在 `bullet-pattern` 的 `aimAtTarget` 上就是按这条处理的：
   以 JSDoc 为准改了实现，缺省固定角度取 0，并在 README 写明。

3. **`joystick-mover` 的"每帧零分配"是**有意为之的热路径优化**，不是 bug。**
   原报告也承认了这个意图。建议按"补文档 / 提供 `evaluateInto(out)` 与 `snapshot()`"的方向处理，
   而不是直接改成每次 `return { ... }`——那会让热路径重新产生每帧分配。
   这是标准 5「别把设计如此误判成 bug」的典型场景。

---

## 附：本窗口（W4-A）交付时的全库校验结果

供总审比对——下面这份输出是 W4-A 自己交付时的状态，与 W4-B 无关。

```
bash build.sh                          → TSC OK（产物校验通过：211 个 .js）
node .build/tests/run.js               → 通过 3695 项，失败 0 项
W4-A 独立测试（runPhase10W4ATests）     → 通过 71 项，失败 0 项
node scripts/check-deps.js             → 全部通过 ✓
node scripts/check-links.js            → ✗ 1 处误报（见 W4-A 报告第五节）
python3 scripts/scan-dt-guard.py       → 命中 0 处 ✓
python3 scripts/scan-num-guard.py      → 命中 0 处 ✓
python3 scripts/check-random-source.py → [OK] ✓
python3 scripts/check-dup-exports.py   → [OK] ✓
```

⚠️ 提醒总审：`check-links.js` 那处失败是 `audit/handoff_W3-B.md` 代码块里
一段形如 `this._derived[id](省略号)` 的调用被误判成 markdown 链接，
属**校验脚本的误报**（代码里的 `](` 不是链接），且该文件属 W3-B 窗口，本窗口未触碰。
建议让 `check-links.js` 跳过反引号内的内容，
否则 16 个窗口交付时它会一直红着，掩盖真正的断链。
