# i18n — 本地化

## 它解决什么

硬编码中文后要出英文版，得全局搜索几百处。更麻烦的是：

- **复数**：英文有 "1 item" / "2 items"，中文没有
- **插值**：`"剩余 {n} 次"` 里 n 在不同语言位置可能不同
- **回退**：缺翻译时显示原文而不是空白
- **热重载**：调文本不用重启

## 用法

```typescript
const i18n = new I18N({ fallback: 'zh-CN' });

i18n.addLocale('zh-CN', {
  'ui.start': '开始游戏',
  'item.count': '{n} 个',
  'msg.kill': '你击败了 {name}，获得 {exp} 经验',
});

i18n.addLocale('en-US', {
  'ui.start': 'Start Game',
  'item.count_one': '{n} item',      // ← 英文复数
  'item.count_other': '{n} items',
  'msg.kill': 'You defeated {name} and gained {exp} EXP',
});

i18n.setLocale('en-US');

i18n.t('ui.start');                      // 'Start Game'
i18n.t('item.count', { n: 1 });          // '1 item'
i18n.t('item.count', { n: 5 });          // '5 items'
i18n.t('msg.kill', { name: '骷髅兵', exp: 120 });

i18n.t('缺失的key');                      // '缺失的key'（回退，不是空白）
```

**`n` 是保留变量名**，用于选择复数形式。

## 回退链

```
当前语言 → 回退语言 → key 本身
```

> 为什么最后回退到 key 而不是空字符串？
> 空字符串会让按钮变成一片空白，玩家完全不知道那是什么；
> 显示 key 至少能看出"这里缺翻译"，而且不阻塞开发。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 硬编码字符串 | 出第二语言时要全局搜索 | 一开始就用 key |
| 切换语言后 UI 不变 | 玩家以为没生效 | 订阅 `onChange` 手动刷新所有文本 |
| 插值变量拼错 | 显示成 `undefined` | 已处理：保留原占位符 |
| 用模板字符串写文案 | 运行时加载的 JSON 不支持 | 用 `{name}` 占位符 |
| 覆盖率检查报"未翻译" | 复数形式 `key_one` 被误判 | 已处理：coverage 认复数变体 |

## API

| 成员 | 说明 |
|---|---|
| `addLocale(locale, table, opts?)` | 添加（**合并**到已有同语言包） |
| `setLocaleTable(locale, table)` | 替换整个包（**热重载**） |
| `setLocale(locale)` | 切换（不存在则保持，返回 false） |
| `t(key, vars?)` | 翻译 |
| `has(key, vars?)` | 能否翻出来（**与 `t()` 同一条查找路径**：含回退语言与复数变体） |
| `coverage(locale)` | 覆盖率 `{total, translated, missing}` |
| `missingKeys` | 运行时缺失过的 key |
| `onChange(fn)` | 语言切换回调（**UI 要自己刷新**） |
| `onChange(fn)` 返回值 | 取消订阅（**可多播**：多个组件可同时订阅） |

**未在上面列出的**：

| 成员 | 说明 |
|---|---|
| `hasLocale(locale)` | 该语言包是否已添加 |
| `locales()` | 已添加的全部语言 |
| `locale()` | 当前语言 |
| `clearMissing()` | 清空"缺失过的 key"记录 |
| `destroy()` | 释放 |

> ⚠️ **`setLocale()` 切到不存在的语言时返回 `false` 且保持原语言。**
> 不看返回值的话，玩家在语言列表里点了没反应——
> 而你会以为切换成功了。
> 先用 `hasLocale()` 判断，或依据返回值给提示。

> ⚠️ **`addLocale()` 是"合并"，`setLocaleTable()` 是"替换"。**
> 热重载语言包（开发期改了 JSON 重新加载）必须用后者——
> 用 `addLocale()` 的话，删掉的 key 还在，
> 表现为"我明明删了这条文案怎么还显示"。

> ⚠️ **`has()` 的口径必须与 `t()` 一致，别自己只查当前语言。**
> 此前 `has()` 只查"当前语言的 key 本身"，于是
> `has('ui.start') === false` 但 `t('ui.start') === '开始'`（来自回退语言）、
> `has('item') === false` 但 `t('item', {n:3}) === '3 items'`（来自 `item_other`）。
> 用 `has()` 决定"显示翻译还是显示 key"会得到大量假阴性——
> 明明翻得出来却走了未翻译分支。
> 现在两者共用同一条查找路径。

> ⚠️ **覆盖率只认运行时能命中的复数形式（`_one` / `_other`）。**
> CLDR 有六种复数形式，但本模块的 `_pluralKeyOf` 只实现 one/other。
> 语言包只写 `item_few` / `item_many` 时：
> 覆盖率曾报 100%，而 `t('item', {n:3})` 实际回落中文——**报告说谎比没有报告更糟**。
> 现在这类 key 会被正确计入 missing。

> ⚠️ **`destroy()` 之后 `onChange` 回调不再触发。**
> 换场景时如果只切语言不 `destroy()`，
> 旧场景的刷新回调还挂着——会去刷新已经销毁的节点。

> **`missingKeys` + `coverage()` 是上线前检查翻译完整度的组合。**
> `coverage()` 查配表缺哪些（静态），
> `missingKeys` 查运行时实际用到但缺的（动态）。
> 只看前者的话，那些"配表里有但代码里拼错 key"的情况发现不了。

### 类型

```typescript
interface I18NOptions {
  locale?: string;         // 初始语言
  fallback?: string;       // 回退语言（找不到翻译时用）
  warnOnMissing?: boolean; // 缺 key 时是否打警告
}
```

**`PluralForm`**：

```typescript
'zero' | 'one' | 'two' | 'few' | 'many' | 'other'
```

> ⚠️ **中文只用 `other`，英文用 `one` / `other`。**
> 俄语这类有 6 种形式的语言要全配。
> 配表时按目标语言的实际规则来，别照抄英文的两套——
> 少了 `_many` 的话，俄语下 `n=5` 会显示成 key 本身。

> ⚠️ **`fallback` 强烈建议设置。**
> 不设的话，切到某个语言后缺的 key 会显示成 key 本身，
> 玩家看到满屏 `'ui.start'` 这样的原始键名。
> 设了 fallback 至少能显示另一种语言的正常文案。

**复数**：英文需要 `_one` / `_other` 后缀（见用法示例），
中文不需要——模块按语言的复数规则自动选择。
`coverage()` 已处理复数变体，不会把 `key_one` 误判成未翻译的独立 key。
