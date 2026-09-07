# 验收报告 · W1-B 验收 W1-A

> 验收对象：`W1-A`（20 条：P1 17 / P2 3，单元 `builder` `craft` `crash` `cutscene`
> `debug-console` `gesture` `matchops` `skill-variant`）
> 依据：`audit/review_B.md`
> 验收人：窗口 W1-B
> 核实基准：远程 `main`（含 W1-B / W2-B / W3-A / W3-B / W4-A / W4-B / W7-B / W8-B 的最新改动）

---

## 结论

**无法给出验收结论 —— 对方尚未交付。**

| 交付物 | 状态 |
|---|---|
| `audit/result_W1-A.md` | **不存在** |
| `tests/run_phase10_w1a.ts` | **不存在** |

`review_B.md` 的五条硬标准全都建立在"读到对方的报告与测试代码"之上：
标准 1 要看对方的复现输出、标准 2 要读测试断言、标准 3 找对照用例、
标准 4 比对改动范围、标准 5 看对方有没有推翻原注释的论证。
**没有交付物，五条都无从判定**，因此不填"通过/不通过"。

> 参照 `verify_W2-B.md` 的口径：这不是"验收不通过"，是**没有可验收的对象**。

### 进度背景

| 窗口 | `result` 报告 | `tests/run_phase10_*.ts` |
|---|---|---|
| **W1-A（我的验收对象）** | **✗** | **✗** |
| W2-A | ✗ | ✗ |
| W3-A | ✓ | ✓ |
| W4-A | ✓ | ✓ |
| W5-A | ✗ | ✗ |
| W6-A | ✗ | ✗ |
| W7-A | ✓ | ✗ |
| W8-A | ✗ | ✗ |

A 组 8 个窗口里只有 W3-A、W4-A 完整交付。**W1-A 与 W2-A 均未交付**，请总审留意。

---

## 已做的核查（不等同于验收）

在"对方未交付"的前提下，我对 **W1-A 清单的全部 20 条逐条写了复现脚本**
（只读、只调公开 API，**没有改动 W1-A 的任何一行代码** —— `review_B.md` 明确禁止验收方改对方代码）。

已用文件 SHA 比对确认：W1-A 的 8 个单元在远程 `main` 上与本地快照**完全一致**，
即 W1-A 尚未开始改动，以下复现结果对当前远程代码有效。

### 结果总览：20 条中 **17 条现象仍在、1 条不成立、2 条需 W1-A 自行确认语义**

| # | 单元 | 严重度 | 条目 | 判定 | 实测输出 / 依据 |
|---|---|---|---|---|---|
| 1 | builder | P1 | `PlaceResult.missing` 从未被填充 | ⚠ 仍在 | 代码检视：`:133` 声明，`:356-359` 只做 `requires.filter(...)`，全文无 `missing:` 赋值 |
| 2 | builder | P1 | `rotateCell` 非法角度静默返回原值 | ⚠ 仍在（**语义待确认**） | `rotateCell(c,1)` / `(c,99)` / `(c,NaN)` 返回值**完全相同**，连合法旋转也没生效 |
| 3 | craft | P1 | `totalMaterials` 忽略子配方产出倍率 | ⚠ 仍在 | 子配方产 2 个、需 2 个 → 期望 `{iron_ore:1}`，实测 **`{iron_ore:2}`**（高估 2 倍） |
| 4 | craft | P1 | 副产物被背包丢弃时静默消失 | ⚠ 仍在 | 代码检视 `:354-357`：`got = count - leftover`，`got > 0` 才 push；背包满时 got=0 → 直接不记录 |
| 5 | craft | P1 | 全 `consume:false` 时 ok:true / maxCount:0 | ⚠ 仍在 | 实测 `canCraft` = **`{"ok":true,"missing":[],"maxCount":0}`** |
| 6 | crash | P1 | `_seen` 只增不减 | ⚠ 仍在 | 代码检视：`:303`/`:308` 只 `set`，全文件唯一清理是 `:453` 的 `_seen.clear()`（reset 路径） |
| 7 | crash | P1 | 采样用裸 `Math.random` | ⚠ 仍在 | `:312` `if (Math.random() > this._sampleRate) return false;` |
| 8 | cutscene | P1 | `Timeline.with()` 与 JSDoc 不符 | ⚠ 仍在 | `add('a',1000).with('b',3000)` → **`b.start = 1000`**（紧接播放），JSDoc 写"与上一个同时开始"应为 0 |
| 9 | cutscene | P1 | `update(dtMs)` 无 dt 守卫 | ⚠ 部分成立 | `update(100)`→100；`update(NaN)`→**仍 100**；`update(-50)`→**仍 100**。非法 dt 被静默丢弃，**但未污染 `_time`** |
| 10 | debug-console | P1 | `execute()` 把异常 rethrow | ⚠ 仍在 | 代码检视：`:399` 裸 `throw e;` |
| 11 | debug-console | P1 | `_coerce` 的 int 把空串当 0 | ⚠ 仍在 | `execute('setn ""')` → 收到 **n = 0**（`Number('')===0` 且 `Number.isInteger(0)===true`） |
| 12 | gesture | P1 | `maxPoints` 裁剪丢弃起点 | ⚠ 仍在 | 代码检视 `:357-358`：`this._pts.shift()` 丢的是**头部**（起点） |
| 13 | matchops | P1 | `graceMs` NaN → 宽限期永不过期 | ⚠ 仍在 | `graceFor=NaN`、`remainingMs=NaN`；推进 100 秒后**仍是 NaN**、`stateOf` 停在 `disconnected`（对照 `graceMs:5000` → 0） |
| 14 | matchops | P1 | `Surrender.vote` 掉线者 ok:true 但票不计入 | ⚠ 仍在 | `vote('p3','yes')` → **`{ok:true}`**，`_votes` 有 `[["p1","yes"],["p3","yes"]]`，但 `_tally()` = **`{yes:1}`** |
| 15 | skill-variant | P1 | `applyPatch` 未知 op 静默无操作 | ⚠ 仍在 | `applyPatch({speed:10},{op:'no_such_op',...})` 不抛错，`speed` 仍 10 |
| 16 | skill-variant | P1 | 数值 op 未校验，`mul:NaN` 污染 | ✗ **不成立** | `applyPatch(...,{op:'mul',value:NaN})` **抛错** `mul 要求 value 是有限数字…`；`:521` 的 `assertOperand` 已在 `add`/`mul`/`max`/`min` 四分支前调用 |
| 17 | skill-variant | P1 | 互斥检查只处理第一个冲突者 | ⚠ 仍在 | `_resolve(['X','Y','v'])` → **`["v","Y"]`**；v.excludes 含 Y，两者却同时保留 |
| 18 | cutscene | P2 | `update` 的 `guard < 64` 魔法数 | ⚠ 仍在 | 代码检视 `:222`：`for (let guard = 0; guard < 64; guard++)` |
| 19 | debug-console | P2 | `_history` 去重只看上一条 | ⚠ 仍在 | 代码检视：`if (this._history[this._history.length - 1] !== body)` |
| 20 | debug-console | P2 | `list()` 每次 sort、无 alias 索引 | ⚠ 仍在（**纯性能**） | `list()` 两次调用结果一致（顺序无错），只是每次重排 |

---

## 三条需要 W1-A 特别留意的

### ① #16 建议直接标"不成立"，别照着原报告加校验

实测 `mul: NaN` **已经会抛错**：

```
applyPatch({speed:10}, {op:'mul', path:'speed', value:NaN})
→ 抛错：mul 要求 value 是有限数字，"speed" 的 value 实际是 null（number）
```

`assertOperand` 在 `:454/460/466/472` 四个分支前都已调用。
如果 W1-A 也复现出抛错，正确做法是标"不成立"并贴这段输出，
而不是再加一道重复校验——那属于"顺手改了没必要改的地方"（标准 4）。

### ② #2 的现象比报告描述的更宽，先确认 `rot` 语义再动手

我实测连**合法**的 `rotateCell(c, 1)` 返回值的 `rot` 也是 0：

```
rotateCell(c, 1)   → {"x":1,"y":2,"rot":0,"level":1}
rotateCell(c, 99)  → {"x":1,"y":2,"rot":0,"level":1}
rotateCell(c, NaN) → {"x":1,"y":2,"rot":0,"level":1}
```

三次完全相同。如果"本就返回新对象、rot 由调用方填"是设计，
那报告描述的"非法角度静默返回原值"就不成立，
按报告去加"非法角度抛错"会误判设计（标准 5 的典型风险）。**请先复现再定修法。**

### ③ #14 我发现了一个报告没写的延伸现象：票会"复活"

掉线者的票不是被删除，只是被 `_tally()` 临时跳过。实测：

```
p3 掉线时投 yes → yes = 1（票被隐藏）
p3 重连         → yes = 2（票"复活"了）
```

同一机制的两面。报告只写了"票不计入"，
但"重连后投票数突然跳变"才是玩家真正会看到的现象（可能触发"人数没变但投降突然通过了"）。
建议 W1-A 修的时候一并考虑：**要么掉线即清票，要么明确文档化"暂不计数、重连恢复"**。

---

## 复现方法（便于总审自行复核）

脚本未入库（放 `verify/` 会触发 `check-deps.js` 的目录登记检查），
均为只读、只调公开 API、不改动仓库、不回退代码。

```js
// #3 craft 产出倍率
c.define({ id:'r_ingot', inputs:[{itemId:'iron_ore',count:1}],
           output:{itemId:'iron_ingot',count:2} });      // ← 一次产 2 个
c.define({ id:'r_sword', inputs:[{itemId:'iron_ingot',count:2}],
           output:{itemId:'sword',count:1} });
c.totalMaterials('r_sword', 1);   // → {iron_ore:2}（应为 1）

// #8 cutscene with()
new Timeline('t').add('a',1000).with('b',3000).build();
// → steps: [{a,start:0},{b,start:1000}]   with 的 start 应为 0

// #11 debug-console int 空串
c.register({ name:'setn', args:[{name:'n',type:'int'}], run:(a)=>{...} });
c.execute('setn ""');             // → n = 0

// #17 skill-variant 三变体互斥
sv.register({id:'X',priority:1,...});
sv.register({id:'Y',priority:5,...});
sv.register({id:'v',priority:3,excludes:['X','Y'],...});
sv._resolve(['X','Y','v'], ctx);  // → ["v","Y"]  ← v 与 Y 互斥却同时保留
```

（字段名是 `excludes`，不是 `exclusive`——原报告正文里写的是"互斥检查"，
按字段名 grep 才能定位到 `_resolve` 的 ③ 段。）

---

## 待办

- [ ] W1-A 交付 `result_W1-A.md` + `tests/run_phase10_w1a.ts` 后，**重做本次验收**（五条硬标准逐条给判断）
- [ ] 总审确认 #16 是否从清单移除
- [ ] 总审关注 A 组整体进度（8 个窗口仅 2 个完整交付）
