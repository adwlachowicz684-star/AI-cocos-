# ConfigLoader · Validator

配置表加载、索引、校验、热重载。

## 热重载

```typescript
loader.clearIssues();    // ⚠️ 必须先清，否则热重载后旧错误会累积
await loader.loadAll();
```

> **不清 `clearIssues()` 的后果**：改一次表，错误列表就叠一层。
> 你会看到"同一个字段报了 5 遍"，然后去查那个字段——
> 实际是前 4 次热重载留下的。


## 为什么需要它

直接 `JSON.parse` 的问题：

| 问题 | 后果 |
|---|---|
| 每次 `table.find(r => r.id === id)` | O(n)，高频路径掉帧 |
| 拼错 id 返回 undefined | 在很远处以奇怪的方式崩溃 |
| 没有校验 | 配置错误要到运行时才发现 |
| 改配置要重启 | 调数值的反馈循环极慢 |

ConfigLoader 解决这四点：**id 索引 O(1)、缺失即报错、启动时全量校验、热重载**。

## 用法

```typescript
import { ConfigLoader, MemoryTableSource } from './config/ConfigLoader';
import { Validator } from './config/Validator';

// 1. 定义 schema
const schemas = {
  enemies: {
    id:     { type: 'string', required: true },
    hp:     { type: 'number', min: 1, max: 9999 },
    rarity: { type: 'string', enum: ['common', 'rare', 'legendary'] },
    drop:   { type: 'ref', table: 'loot', nullable: true },
    tags:   { type: 'array', item: 'string' },
  },
  loot: { id: { type: 'string', required: true } },
};

// 2. 注入数据源（Cocos 侧实现 ITableSource 即可）
const loader = new ConfigLoader(new CocosTableSource(), { tables: schemas });
await loader.loadAll();

// 3. 读取
const enemy = loader.get<EnemyCfg>('enemies', 'slime');  // 找不到抛错
const maybe = loader.find('enemies', 'boss');            // 找不到返回 undefined
const all   = loader.all<EnemyCfg>('enemies');
const bigs  = loader.where<EnemyCfg>('enemies', e => e.hp > 100);

// 4. 热重载
loader.onReload((table) => ui.refresh(table));
await loader.reload('enemies');
```

## 校验器是省钱的关键

配置表里拼错一个 id，如果没有校验，会表现成：

> 「第 47 层的某个敌人不掉东西」
> 然后你花三小时查掉落逻辑、查概率、查战斗代码……
> 最后发现是 `drop_table` 写成了 `boss_loot` 而表里叫 `boss_loot_01`。

有了校验器：**启动那一刻就报错**，三分钟改完。

### 设计：一次报全

校验器如果 throw 第一个错误，你就要"改一个→重启→再改一个"循环几十次。
一次列出全部错误，十分钟改完。

```typescript
const issues = Validator.validateTable('enemies', rows, schema);
console.log(Validator.format(issues));
// 配置校验发现 3 个问题：
//   enemies[1] (id=bad): hp: 小于最小值 0（实际 -5）
//   enemies[2] (id=a): id: id 重复（与第 0 行相同）
//   enemies[3] (id=c): drop: 引用了 loot 中不存在的 id "nope"
```

## 热重载的坑：旧引用失效

如果你在别处保存了：

```typescript
const cfg = loader.get('enemies', 'slime');   // ❌ 保存了引用
```

重载后这个 `cfg` 指向**旧对象**，改配置的数值不会生效——
表现为「我明明改了配置，游戏里没变」。

正确做法：每次要用时重新 `get()`，或者订阅 `onReload` 刷新缓存。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 校验遇到第一个错误就停 | 改一个重启一次 | 一次报全（已实现） |
| 不做引用完整性检查 | 掉落表引用了不存在的 id | `checkReferences`（全部表加载完后） |
| 保存了配置引用 | 热重载后不生效 | 每次重新 `get()` |
| 中文 CSV 乱码 | 配置内容全乱 | 用 **UTF-8 with BOM** |
| 数值范围没校验 | 攻击力填了负数 | schema 里写 `min` / `max` |
| NaN 混进配置 | 一路传播，极难查 | 已自动检测 |

## 在 Cocos 中实现 ITableSource

```typescript
import { resources, JsonAsset } from 'cc';
import { ITableSource } from './config/ConfigLoader';

export class CocosTableSource implements ITableSource {
  load(tableName: string): Promise<readonly unknown[]> {
    return new Promise((resolve, reject) => {
      resources.load(`config/${tableName}`, JsonAsset, (err, asset) => {
        if (err) return reject(err);
        resolve((asset.json as { rows: unknown[] }).rows);
      });
    });
  }
}
```

## API

### ConfigLoader
| 成员 | 说明 |
|---|---|
| `loadAll()` | 加载所有表 + 跨表引用检查 |
| `load(name)` | 加载单张表 |
| `get<T>(table, id)` | 按 id 取，**找不到抛错** |
| `find<T>(table, id)` | 找不到返回 undefined |
| `all<T>(table)` | 整表（只读） |
| `where<T>(table, pred)` | 过滤 |
| `count(table)` / `has(table, id)` | 查询 |
| `reload(table)` | **热重载**，触发 onReload |
| `onReload(fn)` | 订阅重载 |
| `issues` | 校验问题列表 |
| `destroy()` | 清空 |
| `loadedTables` | **已加载的表名列表**（调试用） |

> **`loadedTables` 是排查"表没加载"的第一现场。**
> `get()` 抛"表不存在"时，先看这个列表里有没有那张表——
> 常见原因是表名拼错或 `loadAll()` 没跑到。
> 它返回的是**表名数组**，不是表数据。

### Validator
| 方法 | 说明 |
|---|---|
| `validateTable(name, rows, schema)` | 校验一张表，返回全部问题 |
| `validateRow(row, schema)` | 校验单行（编辑器即时校验用） |
| `checkReferences(tables, schemas)` | **跨表引用完整性** |
| `format(issues)` | 格式化为可读文本 |

### FieldSchema 支持的规则
`type` / `required` / `nullable` / `min` / `max` / `minLength` /
`notBlank` / `enum` / `item`（数组元素类型）/ `table`（ref 指向）/ `custom`（自定义函数）
