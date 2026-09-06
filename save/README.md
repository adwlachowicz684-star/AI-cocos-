# save — 存档（版本迁移 + 原子写 + 多槽位）

## 三个必须有的特性

**① 版本迁移**：游戏更新后存档结构变了。老玩家的存档不能直接扔掉，也不能直接读（会崩）。

**② 原子写**：写存档时断电/崩溃 = 存档损坏，玩家几十小时进度没了。
做法是 先写临时 → 写完成 → 覆盖。要么拿到完整旧档，要么拿到完整新档。

**③ 校验**：传输损坏、版本错误要能检测出来，而不是加载出一堆 undefined。

---

## ⚠️ 安全边界：这个模块**不防篡改**

这是全篇最重要的一条。**校验和不是安全机制。**

`checksum` 是一个**无密钥的 32 位滚动哈希**（`h = h * 31 + charCodeAt(i)`），
算法就写在 `_checksum()` 里，任何会写 5 行代码的人都能重算。

**实测（伪造脚本，见 tests/run_fixregress.ts）：**

| 操作 | 结果 |
|---|---|
| 改数据，**不重算**校验和 | ✅ 被拦截（报"存档校验失败"） |
| 改数据 **+ 自行重算**校验和 | ❌ **伪造成功**（`gold: 100 → 999999`） |
| 改 `gameId` 且重算校验和 | ✅ 被拦截（报"存档属于另一个游戏"） |

**所以：**

- ✅ **能防**：传输损坏、写了一半、版本错、不同游戏存档串味
- ❌ **不能防**：玩家主动改档

**唯一有效的防线是 `gameId`**——它是字符串比较，不依赖哈希，
改了就通不过。但它只防"别的游戏的存档"，防不了"改自己游戏的存档"。

**实践建议：**

```
本地存档 = 不可信输入

  ❌ 把金币数、抽卡次数、通关记录放本地存档后当成真的
  ✅ 这些数值要么服务端校验，要么接受"玩家能改"这个事实
  ✅ 防不住，但可以让改动变麻烦（混淆 / 服务端校验 / 关键数值不落本地）
```

> 这条曾经写反过。原文是"**手改存档**……要能检测出来"——
> 那是错的，改数据 + 重算校验和就绕过去了。
> 外部安全审查（S1-1）指出后按实测重写。


## 用法

```typescript
import { SaveManager, MemoryStorage } from './save/SaveManager';

const saves = new SaveManager(storage, { gameId: 'myroguelike', version: 3 });

// 注册迁移（必须逐级：1→2，2→3）
saves.registerMigration(1, 2, (d) => ({ ...d, gold: d.coins ?? 0 }));
saves.registerMigration(2, 3, (d) => ({ ...d, relics: d.relics ?? [] }));

saves.write('slot1', { hp: 50, gold: 120, relics: ['a'] });

const r = saves.read<MySave>('slot1');
if (r.ok) applySave(r.value);
else console.warn(r.error);      // 不存在的槽位 / 损坏 / 版本过高 / 缺迁移

saves.listSlots();               // ['slot1', 'slot2']
saves.meta('slot1');             // { version, savedAt }（不执行迁移，存档界面用）
```

## 在 Cocos 中实现 IStorage

```typescript
import { sys } from 'cc';
import { IStorage } from './save/SaveManager';

export class CocosStorage implements IStorage {
  read(key: string): string | null { return sys.localStorage.getItem(key); }
  write(key: string, data: string): void { sys.localStorage.setItem(key, data); }
  remove(key: string): void { sys.localStorage.removeItem(key); }
  keys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < sys.localStorage.length; i++) {
      const k = sys.localStorage.key(i);
      if (k) out.push(k);
    }
    return out;
  }
}
```

> 存档较大（>1MB）时应改用文件存储而非 localStorage。

## ⚠️ `meta()` 返回 `null` 有两种含义，存档界面必须区分

```typescript
meta(slot): { version, savedAt } | null {
  const raw = this._storage.read(this._key(slot));
  if (raw === null) return null;      // ① 这个槽位根本没有存档
  try {
    return { version: env.v, savedAt: env.savedAt };
  } catch {
    return null;                      // ② 存档存在但 JSON 坏了
  }
}
```

**① 和 ② 都返回 `null`。** 如果存档界面直接这么写：

```typescript
const m = saves.meta(slot);
if (m === null) showEmptySlot();      // ❌ 两种情况都显示"空存档位"
```

那么**玩家的存档还在，只是坏了，界面却告诉他这里没有存档**。
他会以为进度丢了，而实际上数据还在存储里——只是界面不给他任何提示，
连"是否损坏、能否修复"的线索都没有。

### 变通：用 `has()` 区分

```typescript
if (!saves.has(slot)) {
  showEmptySlot();                    // ① 真的没有
} else {
  const m = saves.meta(slot);
  if (m === null) {
    showCorrupted(slot);              // ② 有数据但坏了 → 提示"存档损坏"
  } else {
    showSlot(m);
  }
}
```

> `has()` 只判断 key 是否存在，不解析内容，所以**不会**因为损坏而返回 false。
> 想拿到损坏原因，用 `read(slot)`——它返回 `{ ok:false, error }` 带具体信息。

### 这是个通用陷阱，不只是 meta()

同一类问题在库里还有几处（已用 `scripts/scan-silent-degrade.py` 扫出）：

| 位置 | 「空」 | 「错」 | 后果 |
|---|---|---|---|
| `rebind.actionOf()` | 没找到这个按键 → `null` | 绑定格式非法 → `null` | 无法区分"没绑定"和"绑定坏了" |
| `runscope.getOr()` | 键不存在 → `fallback` | **越权访问** → `fallback` | 权限错误被当成"没数据" |
| `crash.capture()` | 被去重/采样拦下 → `false` | 发送失败 → `false` | 无法区分"主动丢弃"和"上报故障" |

**判据**：如果一个函数既能"体面地返回空"，又能"因为出错返回同样的值"，
那调用方永远分不清。要么让错误走别的通道（返回 `{ok,error}` / 抛异常），
要么至少在文档里写明"这个值有两种含义"。

---

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 迁移跳级注册（1→3） | 中间版本无法升级 | 强制逐级，构造时抛错 |
| 循环引用 | **保存时崩溃** | 已保护，返回 false |
| 存档里存了函数 / undefined | 能写不能读 | 写入前二次校验 |
| 不同游戏用同一个 key | 存档互相污染 | `gameId` 隔离 |
| 忘了注册迁移 | 老玩家一进游戏就崩 | read 返回明确的错误信息 |

## API

| 成员 | 说明 |
|---|---|
| `registerMigration(from, to, fn)` | 注册迁移（**必须 to === from+1**） |
| `write(slot, data)` | 原子写，返回是否成功 |
| `read<T>(slot)` | 读 + 自动迁移，返回 `{ok,value}` 或 `{ok:false,error}` |
| `has(slot)` / `deleteSlot(slot)` | 槽位管理 |
| `listSlots()` | 列出所有槽位 |
| `meta(slot)` | 元信息（不迁移，存档界面用）。**`null` 有两种含义，见下** |
| `clearAll()` | **清空全部槽位**（登出、换账号、测试清理） |
| `destroy()` | 释放迁移表（**换存档体系时调**） |

> ⚠️ **`clearAll()` 会删掉所有槽位，没有确认、没有撤销。**
> 登出时如果还有"本地进度未上传"的槽，调它就没了。
> 稳妥做法是先 `listSlots()` 打印一遍再清。

> **`destroy()` 只清迁移表，不删存档数据。**
> 名字听着像"销毁一切"，实际它只释放 `registerMigration` 注册的函数——
> 存档文件还在。想删数据用 `clearAll()`。
