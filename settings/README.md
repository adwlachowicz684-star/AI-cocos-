# settings · 游戏设置

> ⚠️ **写完代码必须同时完成三件事**：① 测试 ② README ③ 登记进 `_kitmeta.json`

---

## 它解决什么

设置面板看起来就是个键值表。真正麻烦的是五件事：

1. **默认值迁移** — 新版本加了设置项，老存档里没有，读进来是 undefined
2. **变更要能监听** — 改了音量 AudioManager 要立刻响应
3. **范围约束在数据层** — `volume = 2.5` 只有播放时才有问题
4. **分类** — 面板要分页签，不分类的话 UI 得自己维护映射
5. **重置** — "恢复默认"要区分全部重置和只重置这一页

## 用法

```typescript
const s = new Settings({
  defs: [
    { key: 'bgm', kind: 'number', default: 0.8, min: 0, max: 1, step: 0.1, group: 'audio' },
    { key: 'quality', kind: 'enum', default: 'high',
      options: ['low', 'mid', 'high'], group: 'video', needRestart: true },
    { key: 'fullscreen', kind: 'bool', default: true, group: 'video' },
  ],
  onChange: (key, value) => applySetting(key, value),
});

s.set('bgm', 0.5);        // 返回 null 表示成功，否则是错误说明
s.num('bgm');             // 0.5（类型化读取，少写断言）
s.cycle('quality');       // enum 循环切换
s.keysOfGroup('audio');   // 面板分页
```

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **导入存档时新项用默认值** | 这是默认值迁移的核心场景。不处理的话老玩家读档后静音/黑屏 |
| **未知键忽略并返回列表** | 返回被忽略的键，便于记录日志而不是无声丢弃 |
| **单个键非法只影响它自己** | 一个坏值不该让整个设置读不进来 |
| **步进以 min 为基准** | `min:0, step:0.1` 时 0.3 合法，不是"以 0 为基准的任意值" |
| **`set` 相同值不触发 onChange** | 否则拖动滑块会疯狂触发 |
| **enum 的 default 必须在 options 中** | 构造即校验 |
| **needRestart 单独列出** | UI 上标角标，而不是让玩家困惑"改了怎么没反应" |

## 完整接口

**查询**：

| 成员 | 说明 |
|---|---|
| `has(key)` | 是否有这个设置项 |
| `keys()` | 全部键 |
| `def(key)` | 取定义（`undefined` = 不存在） |
| `get(key)` | 取值（泛型） |
| `num(key)` / `bool(key)` / `str(key)` | **类型化读取**，省掉断言 |
| `keysOfGroup(group)` / `groups()` | 按分组取键 / 全部分组名 |

**修改**：

| 成员 | 说明 |
|---|---|
| `set(key, value)` | 设置。**返回 `null` 表示成功**，否则是错误说明字符串 |
| `validate(key, value)` | 只校验不改值，返回规则同 `set` |
| `cycle(key)` | enum 循环切到下一项 |
| `reset(key)` | 重置单项，返回是否真的改了 |
| `resetGroup(group)` / `resetAll()` | 按组重置 / 全部重置 |

**存档**：

| 成员 | 说明 |
|---|---|
| `exportState()` | 导出全部值 |
| `importState(s)` | 导入，返回**被忽略的键**列表；非法值见 `rejected` |
| `rejected` | 最近一次导入里**值非法**的项（`{ key, value, reason }`） |
| `markRestartApplied()` | 标记当前值已生效（重启后调用，清掉 `pendingRestart`） |
| `snapshot()` | 含 `pendingRestart` 的快照 |
| `destroy()` | 卸载：摘掉 `onChange` / `onReject` 回调 |

> ⚠️ **`set()` 返回 `null` 是成功，返回字符串才是失败原因。**
> 当布尔用的话 `if (s.set(...))` 逻辑完全反了——
> 成功时是 falsy。

> ⚠️ **`importState()` 返回的是被忽略的键，不是成功与否。**
> 空数组 = 全部导入成功。
> 不看返回值的话，老存档里那些已经删掉的设置项会被**无声丢弃**。

> ⚠️ **返回值里没有"值非法"这一项，要看 `rejected`。**
> `importState({ volume: 9999 })` 返回 `[]`（没发生未知键），
> 但 `volume` 其实被拒了——玩家改的音量被悄悄还原成默认，
> 表现为"设置存不住"，排查方向却会被引向存档系统。
> 被拒的值会回退到 `default`，并同时进 `rejected` 和 `onReject` 回调。

> ⚠️ **`importState()` 会触发 `onChange`。**
> 读档等于批量改值，音频/渲染子系统必须收到通知，
> 否则就是"值对了但没生效"。

> ⚠️ **`reset(key)` 返回的是"是否真的改了"**，不是布尔式的成功标记。
> 值本来就是默认值时返回 `false`——
> 不代表失败，只是没变化。

> **`num()` / `bool()` / `str()` 存在的意义是省掉类型断言。**
> `s.get('bgm') as number` 每次都要写，
> 而且写错了（比如实际是 string）不报错。

### 类型

```typescript
type SettingKind = 'number' | 'bool' | 'enum' | 'string';
```

**`SettingDef`**：

| 字段 | 说明 |
|---|---|
| `key` / `kind` / `default` | 键名 / 类型 / 默认值（**必填**） |
| `group` | 分组（设置面板分页用） |
| `label` | 显示名 |
| `min` / `max` / `step` | number 专用。**步进以 `min` 为基准** |
| `options` | enum 专用。**`default` 必须在其中**，构造即校验 |
| `maxLength` | string 专用 |
| `needRestart` | 是否需要重启生效 |

> ⚠️ **`min`/`max`/`step` 只对 `number` 有效**，`options` 只对 `enum` 有效。
> 写错类型上的字段不报错——**直接被忽略**，
> 表现为"设了 min/max 但滑块没有范围"。

> ⚠️ **`step` 的基准是 `min` 不是 0。**
> `min: 0, step: 0.1` 时 0.3 合法；
> `min: 0.05, step: 0.1` 时 0.25 合法而 0.3 不合法。
> 详见坑表格。

**`SettingsOptions`**：

| 字段 | 说明 |
|---|---|
| `defs` | 设置项定义列表（**必填**） |
| `onChange(key, value, old)` | 值变化回调（**相同值不触发**，见坑表格） |
| `ignoreUnknown` | 导入时是否忽略未知键（默认忽略并记录） |

> **`onChange` 的第三个参数是旧值**，
> 做"撤销上一次修改"或"变更后对比"时不用自己缓存。

## 设计：校验返回值 vs 抛错

`set()` 返回错误字符串而不是抛异常，因为**设置面板的输入框会频繁产生非法值**
（用户正在输入 "0." 的那一刻）。抛异常会让输入过程充满 try/catch。

构造时的配置错误才抛错——那是开发者写错了，不是用户输入错了。

### 存档：`SettingsSnapshot`

```typescript
interface SettingsSnapshot {
  values:         Readonly<Record<string, SettingValue>>;   // 全部设置值
  pendingRestart: readonly string[];                         // 改了但需要重启才生效的项
}
```

> ⚠️ **`pendingRestart` 里的项要提示玩家"重启后生效"。**
> 静默不生效的话，玩家会以为设置坏了——
> 表现为"我明明关了阴影怎么还有"。
>
> 这是本模块"设置项是否 `requiresRestart`"的直接产物，
> 别自己维护这个列表，从 `snapshot()` 里读。
>
> 只列**当前值与已生效值不同**的项：
> 什么都没改过时它是空的。重启/应用之后调 `markRestartApplied()` 清空。

## 测试

**37 项**，覆盖四类 kind 的校验、步进语义、默认值迁移、分组重置、存档容错。
