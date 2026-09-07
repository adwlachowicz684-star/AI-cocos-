# 验收报告 · W2-B 验收 W2-A

> 验收对象：`W2-A`（19 条：P1 14 / P2 5，单元 `attribute` `command` `diagpack` `indicator`
> `logger` `pathfinding` `runscope` `scheduling` `skill-caster` `social`）
> 依据：`audit/review_B.md`
> 验收人：窗口 W2-B

---

## 结论

**无法验收 —— 对方尚未交付。**

按 `review_B.md` 第 1 节，W2-A 应产出两份交付物：

| 交付物 | 状态 |
|---|---|
| `audit/result_W2-A.md` | **不存在** |
| `tests/run_phase10_w2a.ts` | **不存在** |

我在本仓库的完整文件树里核查过（含 `audit/` 全部 31 个文件与 `tests/` 全部 51 个文件），
两者都没有。全库当前**只有 W7-A 一个 A 组窗口已交付**（`result_W7-A.md` + `run_phase10_w7a.ts`）。

五条硬标准（是否复现过 / 测试是否有效 / 有无对照用例 / 有无顺手重构 / 有无误判设计）
**全部需要读到对方的报告与测试代码才能判断**，因此本次无法给出逐条结论。

---

## 已做的核查（不等同于验收）

在"对方未交付"这个前提下，我做了一件仍有价值的事：**抽样验证 W2-A 清单里的现象
在当前代码里是否仍然存在**。用的是只读脚本、只调公开 API，
**没有改动 W2-A 的任何一行代码**（`review_B.md` 明确禁止验收方改对方代码）。

抽样结果（5 条中 3 条可判定）：

| 条目 | 现象 | 当前代码里是否仍存在 | 依据 |
|---|---|---|---|
| `logger` — Silent 判断是空 if 块，Silent 下仍在分配对象并写环形缓冲 | **仍存在** | 以 `level:'silent'` 构造后连写 200 条 `info`，内部状态序列化长度增加 **12092**（>0 说明仍在写缓冲） |
| `scheduling` — `StepContext.elapsed` 恒为 0，接口承诺的字段从不赋值 | **仍存在** | `scheduling/FrameScheduler.ts` 中 `elapsed` 共出现 3 次，**无任何一处赋值** |
| `pathfinding` — `findPath` 不校验起点可走 | 无法判定 | `GridGraph` 的构造签名与我的调用不符（返回 `null`），需要对方按其实际 API 复现 |
| `attribute` — `clearModifiers()` 不触发 `onChange` | 无法判定 | `AttributeSet` 构造需要 `defs`，我按默认参数构造失败，未取到实例 |
| `runscope` — `has()` 原型链 | 无法判定 | `ScopedStore` 构造签名不符（`Cannot convert undefined or null to object`） |

**这三条"仍存在"不等于对方没修**——只说明在我这次拉取的代码快照里，
这些现象尚未被修复。等 W2-A 交付后，应以对方的报告与测试为准重新验收。

---

## 给 W2-A 与总审的提醒（按 review_B.md 的五条标准）

等对方交付后，建议重点看这几点——它们是我这次在自己窗口里踩到、且与 W2-A 清单高度相关的坑：

1. **标准 2（测试要真的会失败）**：W2-A 清单里有 6 条是"配置未收口"（`social` 的 `abuseThreshold`、
   `skill-caster` 的充能、`indicator` 的中心口径等）。这类用例最容易写成
   `assert(Number.isFinite(compute(5)))`——**喂的是永远不会触发 bug 的输入**。
   必须喂 `NaN` / `Infinity` / `0` / 负数，否则用例等于没写。

2. **标准 3（对照用例）**：同样是收口类修复，最典型的翻车是**收过头**。
   我自己在 `maxDeltaTime` 上就先踩了一次——最初按"夹到下界"修，
   `-1` 变成 `1e-6`，游戏照样停摆，是"定时器不工作"的故障现象一点没变。
   后来改成"非正就整体回落默认 0.1"，并补了对照用例才站稳。
   W2-A 有大量同类修复，请逐条确认有"正常值"的断言。

3. **标准 5（别把设计判成 bug）**：`runscope` 的 `has()` / `getOr()` 那条要特别小心——
   `getOr` 用 try/catch 究竟是"吞掉保护"还是"刻意降级"，取决于 strict 模式的定义，
   建议先看该文件的注释再下结论。

---

## 附：本次验收时的全库校验结果

```
$ node .build/tests/run.js
通过 3695 项，失败 0 项
全部通过 ✓

$ node scripts/check-deps.js
全部通过 ✓

$ node scripts/check-links.js
[✗] 内部链接 44 条，断链 1 处：audit/handoff_W3-B.md
    （非 W2-A 文件，已在我的交付报告 result_W2-B.md §4.3 记录）

$ python3 scripts/scan-dt-guard.py        扫描 146 个文件，命中 0 处 ✓
$ python3 scripts/scan-num-guard.py       扫描 0 处命中 ✓
$ python3 scripts/check-random-source.py  [OK] 未发现自建随机源 ✓
$ python3 scripts/check-dup-exports.py    [OK] 无待处理的冲突 ✓
```

（上述结果是在**本窗口 W2-B 的改动已合入**之后跑的；W2-A 未交付，故不含 W2-A 的任何改动。）
