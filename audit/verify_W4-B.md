# 验收报告 · W4-B 验收 W4-A

> 被验收：`audit/result_W4-A.md`（173 行）+ `tests/run_phase10_w4a.ts`（1146 行 / 71 项）
> 提交：`9b7225bc`（6 单元 / 15 条：已修 12 · 不成立 2 · 不修 1 · 存疑 1）
> 验收依据：`audit/review_B.md` 的五条硬标准

## 结论

**通过。**

五条硬标准逐条核过，15 条条目**全部达标**，无"标红"级问题。
另有 1 处命名小问题、1 处需总审留意的语义变更、1 处**全库级并发问题**（见第四节）。

W4-A 有三处做得比要求更好，值得其他窗口照抄：

1. **两条"不成立"都给了实测证据，且都拒绝了照着改**。
   `W4A-03` 若照审查意见把 `needCount` 换成 `numOr(spec.count, 1)`，
   会把"抛错"改成"静默变 1 发"——**正好是该条意见自己要消灭的静默行为**。
   W4-A 顶住了，还写了测试把守卫固化下来。
2. **`W4A-11②` 存疑项不自己拍板**。DDA 的 `currencyGain` 方向确实反了，
   但任改一个方向都动线上经济曲线，W4-A 只补注释 + 加测试固定现状，交总审裁决。
3. **`W4A-12③` 判"不修"给了契约层面的理由**：`forEach` 的"回调里可改集合"
   依赖"先复制再遍历"，改惰性迭代器会同时破坏两条既有契约。

---

## 一、逐条验收

✅ 达标 · ⚠️ 小问题（建议补，不阻塞）· ❌ 实质问题（需返工）· N/A 不适用

| 条目 | 标准1<br>复现 | 标准2<br>测试有效 | 标准3<br>对照用例 | 标准4<br>无顺手重构 | 标准5<br>未误判设计 | 备注 |
|---|---|---|---|---|---|---|
| W4A-01 `bullet-pattern` ShapeFn 速度 | ✅ | ✅ | ✅ | ✅ | ✅ | 新增 `opts.speed` 可选字段，`ShapeSpec` 优先，向后兼容 |
| W4A-02 `bullet-pattern` interval NaN | ✅ | ✅ | ⚠️ | ✅ | ✅ | 见"小问题 1" |
| W4A-03 `bullet-pattern` count 收口 | ✅ | N/A | ✅ | ✅ | ✅ | **判不成立，附实测**；未改一行代码 |
| W4A-04 `entity` 派发中自注销 | ✅ | ✅ | ✅ | ✅ | ✅ | 五处派发统一走 `_dispatch()`，非顺手重构 |
| W4A-05 `entity` destroy 无效 id | ✅ | ✅ | ✅ | ✅ | ✅ | 两种上下文统一为 `false` |
| W4A-06 `gameflow` historyLimit | ✅ | ✅ | ✅ | ✅ | ✅ | 改 `clampNum` + 正数起点裁剪 |
| W4A-07 `i18n` onChange 多播 | ✅ | ✅ | ✅ | ✅ | ✅ | 改 `Set`，原返回取消函数的契约保留 |
| W4A-08 `i18n` has()/t() 口径 | ✅ | ✅ | ✅ | ✅ | ⚠️ | 见"需留意 1"（语义变更，方向正确） |
| W4A-09 `i18n` 覆盖率复数口径 | ✅ | ✅ | ✅ | ✅ | ✅ | **只收窄统计侧，未动 `_pluralKeyOf` 的两形式设计** |
| W4A-10 `bullet-pattern` P2 四项 | ✅ | ✅ | ✅ | ✅ | ✅ | 含 1 条分拆；`destroy()` 补齐 |
| W4A-11 `difficulty` P2 | ✅ | ✅ | ✅ | ✅ | ✅ | 存疑项交总审，行为未改 |
| W4A-12 `entity` P2 | ✅ | ✅ | ✅ | ✅ | ✅ | ①不成立（附实测）②补无参 destroy ③不修（附契约理由） |
| W4A-13 `gameflow` P2 | ✅ | N/A | ✅ | ✅ | ✅ | 见"说明 1" |
| W4A-14 `i18n` 原型污染 | ✅ | ✅ | ✅ | ✅ | ✅ | 与已修的 `easing()` 同类，是新实例 |
| W4A-15 `matchmaking` P2 | ✅ | ✅ | ✅ | ✅ | ✅ | 见"说明 2"（非公开 API，无 breaking） |

### 小问题 1 · W4A-02 有一条用例命名与性质不符

`run_phase10_w4a.ts:166`「对照：interval = 0 / 负数 / 非数字都仍被拒」——
它标的是"对照"，但**修复前会失败**：

```
✗ 对照：interval = 0 / 负数 / 非数字都仍被拒（不是只挡了 NaN）
    : interval=x 应抛错： 期望抛出异常，但没有
```

原因是它测的第三项 `interval: 'x'`（字符串）在原代码里 `'x' <= 0` 为 false → 不抛错，
新代码 `!(opts.interval > 0)` 才拦得住。

**这条用例本身是对的**（它拦住的是真实加固项），只是"对照"这个名字容易让人
误以为它修复前后都该通过。建议在用例名或注释里点明"含非数字类型的加固"。

### 说明 1 · W4A-13 只有对照用例，没有回归用例 —— 这是对的

删 `_findTransition` 的冗余首循环是**行为不变**的清理，
按定义不可能存在"修复前失败"的断言。W4-A 配了两条对照固化行为不变
（转换判定结果不变、`when()` 不再被多求值一次），方向正确。
标准 2 对这一条不适用（N/A），不算缺漏。

### 说明 2 · W4A-15 移除未使用参数不是 breaking

`packResult` / `fixRoles` 都是 `TeamBalancer.ts` 的**模块内函数**（未 `export`），
不是公开 API。已确认 `matchmaking/TeamBalancer.ts` 的导出面只有
`balanceTeams` / `splitIntoTwoTeams` / `validateTeamAssignment` 等，
移除这两个内部函数的未使用参数对下游无影响。

### 需留意 1 · W4A-08 的 `has()` 语义变更（方向正确，但需知道代价）

`has()` 从"只查当前语言的 key 本身"改成"与 `t()` 同一条查找路径（含回退语言与复数变体）"。
**这个改法是对的**，修掉了"明明翻得出来却走未翻译分支"的假阴性。

代价：`has()` 不再能用来判断"**当前语言包是否缺这条**"。
有 fallback 时它恒为 true，本地化验收中"这份 en-US 还差几条"这类用法会失效。

W4-A 已在 `i18n/README.md:70/96` 写明新口径，我认为**说明到位，无需返工**。
但如果总审知道有下游在用 `has()` 做覆盖率自检，需要另行提供
"只查当前语言"的查询入口——**提请注意，不阻塞本条验收**。

---

## 二、标准 2 的验证方法（测试是否真的会失败）

不采用"改回旧代码跑一遍"的方式（会损坏 `.build/`）。改法：

1. 取 W4-A 的父提交 `d2801644`（它的开工基线）完整 tarball → `/data/workspace/w4a_before`
2. 只把 W4-A 的 `tests/run_phase10_w4a.ts` 拷进去
3. 编译到**独立目录** `/tmp/w4a_bb`，不碰任何 `.build/`
4. 跑同一份测试

```
通过 41 项，失败 30 项
```

**30 条失败全部是 ⚠️ 回归用例；41 条对照用例修复前后都通过。**
（上面"小问题 1"那条是唯一的例外，且它拦的是真实加固项。）

放到当前 `main` 上：

```
W4-A + W4-B 独立跑：通过 142 项，失败 0 项
```

结论：**没有空转用例，也没有把合法输入一起拦掉的矫枉过正。**

## 三、标准 1 的独立复核

上一轮我在自己开工的基线 `7c425d8` 上跑过 W4-A 全部 9 条 P1 的只读复现脚本，
结果与 W4-A 报告的"复现输出（修复前）"列**逐条吻合**：

```
A1 自定义 ShapeFn speed= [0,0,0]      对照 ring → [10,10,10]      ✓ 与报告一致
A2 interval=NaN 构造 → no-throw；600 帧产出 0；对照 → 9          ✓ 与报告一致
A3 count=NaN/null → 抛 TypeError                                 ✓ 与报告"不成立"一致
A4 onSpawn 序列 ["A","C"]（B 未执行）；onDeath ["D"]（E 被吞）    ✓ 现象一致
A5 destroy(999999)：非遍历 false / 遍历 true                     ✓ 与报告一致
A6 historyLimit 32→32 / 1→401 / 0→201                           ✓ 与报告一致
A7 两个订阅者触发 0 / 1                                          ✓ 与报告一致
A8 has('ui.start')=false 但 t()='开始'                           ✓ 与报告一致
A9 coverage 报 100%，t('item',{n:3}) 回落中文                    ✓ 与报告一致
```

标准 1 通过：报告里的数字是 W4-A 自己跑出来的，不是抄原报告的证据。

---

## 四、全库级问题（需总审处理，非 W4-A 的锅）

### ⚠️ `_kitmeta.json` 存在并发覆盖，各窗口的 `depends` 登记互相冲掉

当前 `main` 上 `node scripts/check-deps.js` 报 **6 条**未登记：

```
i18n / gameflow → _core   （W4-A 引入）
rebind          → _core   （W4-B 即本窗口引入，提交时已登记，现被覆盖回 []）
curse / rarity / accessibility → _core   （其它窗口引入）
```

已确认这些 import 都是真实存在的（`i18n/I18N.ts:47` `isSafeKey`、
`rebind/Rebind.ts:30` `hasOwn` 等）。

**根因**：16 个窗口并行提交，每个都整份写回 `_kitmeta.json`，后提交的覆盖先提交的。
我（W4-B）在 `c8c1c0f` 里已把 `rebind.depends` 改成 `["_core"]`，
但被后续窗口的提交覆盖回了 `[]`。

**这条判断已被实测证实**：本窗口推送时未登记只有 `rebind` 1 条，
到我写这份报告时涨到 5 条，再到推送后复核时涨到 **6 条** ——
**每多一个窗口交付就多几条**。所以"各窗口各自 --fix"是无效的，
后提交的必然覆盖先提交的。

**建议总审**：全部窗口交付完成后，**统一跑一次 `node scripts/check-deps.js --fix`**。
这不需要任何人返工，也不应计入任何窗口的验收结论。

### check-links 的断链 —— 已闭环 ✅

我上一轮提交本报告时，报的是 `audit/handoff_W3-B.md` 一处断链；
到 W4-A 报告里变成了 `audit/verify_W3-B.md`（文件未变，报的位置在变），
W4-A 因此判断这是 `check-links.js` 的**误报**——脚本把代码块里形如 `](`
的内容当成了 markdown 链接。

**该判断已由 W3-B 证实并修复**：W3-B 在 `87b2a889` 修掉了脚本对行内代码的误判。
现在 `node scripts/check-links.js` 输出：

```
[OK] 内部链接 42 条，断链 0 处（扫描 178 个 .md 文件）
```

本条已闭环，无需任何窗口返工。

---

## 附：全库校验结果

**验收时**（`main` HEAD = `81f05b0a`，W4-A 交付后、其它窗口继续合入前）：

```
./node_modules/typescript/bin/tsc -p tsconfig.json      → exit 0
node .build/tests/run.js                                 → 通过 3696 项，失败 0 项 ✓
node -e "…runPhase10W4ATests + runPhase10W4BTests…"      → 通过 142 项，失败 0 项 ✓

node scripts/check-deps.js          → 5 条未登记（见第四节，非 W4-A 独有）
node scripts/check-links.js         → 断链 1 处（W4-A 判断为误报，已由 W3-B 修复）
python3 scripts/scan-dt-guard.py    → 146 个文件，命中 0 处 ✓
python3 scripts/scan-num-guard.py   → 命中 0 处 ✓
python3 scripts/check-random-source.py → [OK] 未发现自建随机源 ✓
python3 scripts/check-dup-exports.py → [OK] 无待处理的冲突 ✓
```

**推送后复核**（重新拉取最新的 `main`，含 W5-B / W2-B / W7-B / W3-B 等后续改动）：

```
node .build/tests/run.js                                 → 通过 3696 项，失败 0 项 ✓
node -e "…runPhase10W4BTests…"                           → 通过 71 项，失败 0 项 ✓
                                                          （W4-A 的 71 项同样未受影响）
node scripts/check-links.js         → [OK] 断链 0 处（W3-B 已修脚本误判）✓
node scripts/check-deps.js          → 6 条未登记（数量仍在涨，见第四节）
其余四项校验脚本                     → 全过 ✓
```

W4-A 的 6 个单元在复核时同样未被后续提交触碰，其 71 项测试仍全绿，
**本报告的「通过」结论在合入后的真实仓库里依然成立**。

**验收方未改动 W4-A 的任何代码**（`review_B.md` 第 0 节纪律）。
本窗口两轮提交只新增/重写 `audit/verify_W4-B.md` 与 `audit/result_W4-B.md` 两个文件。
