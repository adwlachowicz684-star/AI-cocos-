# binary · 位级二进制序列化

> 存档小一个数量级，且玩家打记事本改不了。

## 1. 它解决什么

JSON 存档的三个问题：

| 问题 | 说明 |
|---|---|
| **体积大** | `{"hp":100,"mp":50}` 是 21 字节，二进制只要 2~3 字节 |
| **能被人改** | 单机无所谓，但排行榜一旦接服务器，造假数据会污染整个榜 |
| **浮点精度** | `0.1 + 0.2` 在 JSON 里是 `0.30000000000000004`，种子复现可能对不上 |

代价是**不可读**（调试看不到内容），所以提供 `toHex()` 与 `describe()`。

## 2. 五分钟上手

```typescript
import { schema, uint, int, bool, float, enumeration, string, RecordArray }
  from './binary/BinarySerializer';

const hero = schema<{ hp: number; lv: number; alive: boolean; x: number }>(
  {
    hp:    uint(10),                    // 0..1023
    lv:    uint(6),                     // 0..63
    alive: bool(),                      // 1 bit
    x:     float(-1000, 1000, 0.01),    // 量化到 0.01
  },
  { name: 'Hero', version: 1 }
);

const bytes = hero.encode({ hp: 999, lv: 60, alive: true, x: 12.5 });
const back  = hero.decode(bytes);       // 完全还原（x 有 ≤0.01 误差）
```

上面这条记录占 **10 + 6 + 1 + 18 = 35 bit ≈ 5 字节**，JSON 版本 45 字节。

## 3. 实测：200 个单位

```
JSON     15682 字节
二进制    1327 字节
节省     91.5%
```

往返校验：id / alive 完全一致，坐标最大误差 0.0249（量化步长 0.05）。

## 4. 字段类型

| 类型 | 用法 | 说明 |
|---|---|---|
| `uint(bits)` | `uint(12)` | 0 ~ 2^n-1 |
| `int(bits)` | `int(9)` | 偏移编码，-2^(n-1) ~ 2^(n-1)-1 |
| `bool()` | `bool()` | 1 bit |
| `float(min,max,step)` | `float(-500,500,0.05)` | 量化，自动算位宽 |
| `enumeration(values,def)` | `enumeration(['a','b'],'a')` | 按索引编码 |
| `string(maxBytes)` | `string(64)` | 变长，UTF-8，长度前缀 |
| `raw(maxBytes)` | `raw(16)` | 变长字节 |

`RecordArray` 用于「很多条结构相同的数据」——200 个敌人、1000 个地形格子。

## 5. API

### `schema(fields, opts?)` → `Schema`

`schema()` 是 `new Schema()` 的语法糖，推荐用前者。

| 成员 | 说明 |
|---|---|
| `encode(obj)` | 对象 → `Uint8Array`。**缺的字段用 `def` 填**，不报错 |
| `decode(bytes)` | `Uint8Array` → 对象 |
| `describe()` | 人类可读的位布局（调试时看每个字段占几位） |
| `fixedBits` | 定长部分的总位宽（**不含** `string` / `raw` 的变长部分） |
| `minBytes` | 最少占用字节数 |
| `order` / `version` / `name` | 字段顺序 / 版本号 / 名字 |

```typescript
const hero = schema<{ hp: number }>({ hp: uint(10) }, { name: 'Hero', version: 1 });
console.log(hero.describe());   // Hero v1  hp: uint10 @0  ...
```

> **改字段顺序等于改格式。** 旧存档会解出垃圾数据，
> 所以要靠 `version` 做迁移，不要靠"我记得顺序没变过"。

### `RecordArray(schema, maxCount?)`

**很多条结构相同的数据**——200 个敌人、1000 个地形格子。
它比"把 Schema 塞进数组再 JSON"省得多，因为长度前缀只占几位。

```typescript
const army = new RecordArray(hero, 200);   // maxCount 决定长度前缀位宽，默认 65535
const bytes = army.encode(enemies);
const back  = army.decode(bytes);
```

| 方法 | 说明 |
|---|---|
| `encode(items)` | 数组 → `Uint8Array`；超过 `maxCount` **抛错**（不是静默截断） |
| `decode(bytes)` | `Uint8Array` → 数组 |

### `BitWriter` / `BitReader`

自定义字段类型时才用得上。库里已有的 7 种字段够用的话，不用碰这两层。

| `BitWriter` | `BitReader` | 说明 |
|---|---|---|
| `writeBits(value, bits)` | `readBits(bits)` | 按位读写 |
| `toBytes()` | — | 取出结果 |
| `bitLength` | `position` / `remainingBits` | 当前位偏移 / 剩余位数 |

### 工具函数

| 函数 | 说明 |
|---|---|
| `utf8Encode(s)` / `utf8Decode(bytes)` | UTF-8 编解码（`string()` 字段内部用） |
| `toHex(bytes, limit?)` | 十六进制预览，**调试用**。默认只显示前 64 字节 |


## 6. 三条设计约定

**① 位宽上限 32。**
`writeBits` 用 JS 的 32 位位运算，超过会**静默溢出**（`(1<<33) === 1<<1`）。
这种错误极难发现——值写进去了，读出来是错的。所以 schema 构造时就校验。

**② 越界与类型错误分开报。**

```
uint12 需要整数，收到 1.5     ← 类型错，你去检查传进来的值
uint12 越界：5000（范围 0..4095）  ← 数值错，你去检查 schema
```

混在一起报"越界"，1.5 会让人以为范围写错了，排查方向跑偏。

**③ 越界值绝不静默截断。**
存进去 300，读出来 44 —— 这种 bug 能查一天。

## 7. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| **改字段宽度让旧存档全错位** | 读出来的所有字段都是乱码 | schema 必须带 `version`，读取时判断要不要迁移 |
| 单个字段超过 32 位 | 静默溢出 | 构造时校验，拆成多个字段 |
| 量化精度越高越好 | 坐标 0.001 + 1km 范围 = 31 位，和 float32 一样了 | 判据：**量化误差 < 游戏里能感知的最小距离** |
| enum 索引越界 | 返回 undefined，后续崩溃 | 退化为默认值 |
| 字符串超长 | 静默截断，玩家名字变半截 | 抛错 |
| emoji 是代理对 | 按 charCode 逐个编码会出乱码 | 已处理，实测 4 字节正确往返 |

## 8. 测试覆盖

43 项。重点覆盖：
- 跨字节边界的位读写
- 32 位边界（0xffffffff）
- 各类越界与类型错误
- emoji 与中文的 UTF-8 往返
- 体积对比（200 单位，二进制至少比 JSON 小 5 倍）

## 9. 依赖

零依赖，纯逻辑。
