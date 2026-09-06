# runscope · 局内 / 局外 / 会话三域隔离

> 把「靠命名约定防串档」换成「状态机 + 越界抛错」。

## 1. 它解决什么

肉鸽有三类数据，生命周期完全不同：

| 域 | 例子 | 生命周期 |
|---|---|---|
| **run** 局内 | 本局金币、已获遗物、当前层数 | 死亡/通关即清空 |
| **meta** 局外 | 永久货币、解锁项、统计 | 跨局永久保留 |
| **session** 会话 | 帧率、调试开关、UI 状态 | 不进存档 |

串档的典型 bug：
- 局内金币被当成永久货币花掉
- 死亡后没清干净，下一局带着上局的遗物开局
- 存档时把整局数据写进了永久槽
- 玩家中途退出，永久货币丢了

## 2. 五分钟上手

```typescript
const store = new ScopedStore({
  schema: {
    ...keys('run',  { gold: 0, floor: 1, relics: [] as string[] }),
    ...keys('meta', { souls: 0, totalRuns: 0 }),
    fps: key('session', 60, '当前帧率'),
  },
});

store.beginRun();          // outOfRun → inRun
store.set('gold', 500);
store.set('souls', 180);   // 局内获得的永久货币，立刻记账
store.endRun();            // 清空 run 域，meta 保留

store.get('gold');         // ✗ 抛错：局外不得访问局内数据
```

## 3. 核心机制：越界抛错

```
outOfRun ──beginRun()──> inRun ──endRun()──> outOfRun
   │                       │                    │
   │ 访问 run 域 → 抛错     │ 全部可访问          │ 访问 run 域 → 抛错
```

**为什么必须抛错而不是返回 undefined：**

| | 脏数据 | 抛错 |
|---|---|---|
| 发现时机 | 玩家玩到第 3 层发现金币不对 | 开发时第一次跑就崩 |
| 排查成本 | 三小时 | 堆栈直接指到那一行 |

命名约定（`run_gold` / `meta_souls`）防不住串档——
你总会有一天忘记前缀。

## 4. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| `endRun` 用删除而不是重置 | 下一局 `get('gold')` 是 undefined，`gold + 10` 变 NaN | 必须重置为初始值 |
| 未声明的键静默返回 undefined | 拼写错误 `golld` 一路传下去，最后表现为"金币显示异常" | 抛错（这是本模块存在的意义） |
| `souls` 在 endRun 时被清掉 | 局内赚的永久货币丢了 | meta 域不参与重置 |
| 跨日/跨局时成绩记错 | 玩家 23:59 开始、00:01 提交 | 成绩绑定开始时的状态，见 `daily` |

## 4.5 抛错之后怎么安全查询

本模块的核心设计是「越界抛错」（见第 3 节），
那就必须给**不想被抛错打扰**的场景留出口。三个：

| 成员 | 说明 |
|---|---|
| `has(key)` | 键是否已声明 |
| `getOr<T>(key, fallback)` | 取值，拿不到就用兜底（**不抛错**） |
| `scopeOf(key)` | 这个键属于哪个域（`'run'` / `'meta'` / `'session'` / `null`） |

```typescript
// 不该写：用 try/catch 包 get
let gold = 0;
try { gold = store.get('gold'); } catch {}   // ❌ 啰嗦且掩盖真错误

// 该写：
const gold = store.getOr('gold', 0);
```

### ⚠️ 但 `getOr` 是逃生舱，不是默认用法

```typescript
getOr<T>(key, fallback): T {
  try {
    const v = this.get<T>(key);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;      // ← 【未声明的键】和【越权】都掉进这里
  }
}
```

**它 catch 的是 `get()` 的全部异常**，包括这个模块最想暴露的那两类：

| 情况 | `get()` | `getOr()` |
|---|---|---|
| 键没声明（拼写错误 `golld`） | **抛错** | 静默返回 `fallback` |
| 越权（在 outOfRun 读 run 域） | **抛错** | 静默返回 `fallback` |
| 键已声明但没值 | 抛错 | 静默返回 `fallback` |

回到第 4 节坑表第二行——"未声明的键静默返回 undefined，
拼写错误一路传下去""**抛错（这是本模块存在的意义）**"。

**`getOr` 把这条意义抵消了。**

```typescript
const gold = store.getOr('golld', 0);   // 拼错了
// → 得到 0，不报错。和"真的有 0 金币"完全无法区分。
// 于是第 4 节说的那个"三小时排查"的问题，用 getOr 就原样回来了。
```

**怎么用它才不踩坑**：

- ✅ **查询类代码**用 `getOr`（显示 UI、算总览）——拿不到就显示默认值是合理的
- ❌ **写入/累加路径**别用（`store.set('gold', store.getOr('gold',0) + 10)`）——
  拼错了会安静地在错误的键上累加
- ❌ **别把它当"安全版 get"到处用**——那等于把整个模块的抛错设计关掉

**排查越权时**：临时把 `getOr` 换回 `get`，让异常抛出来，
看清楚到底是"没这个键"还是"没权限"，再决定怎么处理。

> ⚠️ **`getOr` 会吞掉"未声明的键"这类错误。**
> 它适合"可选的、可能不存在的键"，
> 不适合用来逃避 `get` 的越界检查——
> 那正是本模块存在的意义（第 3 节）。
>
> 判断依据：这个键**有可能合法地不存在**吗？
> 是 → `getOr`；否（说明是拼写错误）→ 用 `get` 让它崩。

### 其余方法

| 成员 | 说明 |
|---|---|
| `add(key, delta)` | 数值累加，返回新值（比 `set(k, get(k) + n)` 省事且原子） |
| `exportMeta()` | **只导出 meta 域**（存档到永久槽用这个） |
| `describe()` | 诊断输出（列出全部键、当前域、是否局内） |
| `reset()` | 清回初始状态 |

### `SCOPES` 常量

```typescript
SCOPES   // ['run', 'meta', 'session']
```

需要遍历全部域时用它，别手写字符串数组。

## 5. 存档

```typescript
const snap = store.exportSave();   // { meta, run, inRun }
store.importSave(snap);
```

- 局外时 `run` 为空（避免把上局数据存进永久槽）
- `session` **永不进存档**
- 读档容错：多余的键忽略、缺失的键取初始值——玩家不该因为一次版本更新就丢存档

## 6. 测试覆盖

27 项。重点覆盖：三域隔离、越界抛错、endRun 重置、存档往返、容错。

### `ScopedSnapshot`

```typescript
interface ScopedSnapshot {
  meta:  Record<string, unknown>;   // 跨局持久
  run:   Record<string, unknown>;   // 本局有效
  inRun: boolean;                   // 当前是否在一局中
}
```

> ⚠️ **`run` 域在 `endRun()` 时清空，`meta` 域不清。**
> 这是三域隔离的核心（详见上文）。
> 存档时两个域要分开存——
> 存到一起的话，读档后"上一局的临时数据"会污染新一局。

## 7. 依赖

零依赖，纯逻辑。
