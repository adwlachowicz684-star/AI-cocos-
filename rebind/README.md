# rebind · 按键重映射

**设置界面里的"按键设置"**

---

## 它解决什么

看起来就是存一个 map。真正麻烦的是：

- **编码归一化**：`ctrl+shift+s` 和 `shift+ctrl+s` 是同一组合
- **冲突处理**：把"跳跃"绑到 J，而 J 已经是"攻击"，怎么办？
- **保留键**：ESC 通常要留给菜单
- **反向索引清理**：解除绑定后不清理，下次绑定会误判冲突

## 用法

```typescript
const rb = new Rebind(
  { jump: { key: 'space' }, attack: { key: 'j' } },
  { conflict: 'swap' }
);

rb.bind('jump', { key: 'j' });
rb.bindingOf('jump');        // { key: 'j' }
rb.bindingOf('attack');      // { key: 'space' }   ← 互换了

rb.actionOf({ key: 'space' });   // 'attack'
rb.resetToDefault();
```

**其余方法**：

| 成员 | 说明 |
|---|---|
| `has(action)` / `actions` | 是否已有绑定 / 全部动作名 |
| `isReserved(key)` | 该键是否被保留 |
| `unbind(action)` | 解除绑定 |
| `clearAll()` | 清空**全部**绑定 |
| `exportState()` / `importState(state)` | 存档（**字符串形式**） |
| `toObject()` | 导出为 `Record<string, Binding>` |
| `destroy()` | 卸载：清空全部绑定与订阅（rule5） |

> ⚠️ **`clearAll()` 会清空所有绑定，包括默认的。**
> 之后玩家没有任何可用按键——
> "重置"应该用 `resetToDefault()` 而不是 `clearAll()`。

> ⚠️ **`importState` 对损坏数据静默跳过，不抛错。**
> 坏数据对应的绑定**保持原样**，好过整个设置界面打不开。
> 但副作用是"导入了却没生效"不会有任何提示——
> 调试时先 `exportState()` 看看实际存了什么。
>
> ⚠️ **同一个按键出现在多个动作上时，保留先出现的、跳过后面的。**
> 修复前的行为是"后者绑定成功、前者被彻底解绑"——
> 于是 `{a:'k', b:'k'}` 会让 `a` 变成**无绑定**，
> 玩家存完档发现某个键失灵了。现在 `a` 保留 `k`，`b` 保持原绑定，
> 并触发一次 `onChange('a')`。

> ⚠️ **`resetToDefault()` 会补发无默认值动作的 `onChange`。**
> 修复前：清掉一个**没有默认值**的自定义动作时，
> 绑定确实没了，但 `onChange` 一个都没触发——UI 停留在旧值，
> 表现为"设置里还显示着这个键，但按下去没反应"。

**`ConflictPolicy`**：

| 值 | 行为 |
|---|---|
| `'swap'` | 互换：被顶掉的动作拿到原按键 |
| `'unbind'` | 顶掉：被占用的动作直接解除绑定 |
| `'reject'` | 拒绝：保持原绑定不变 |

> ⚠️ **`swap` 在目标没有绑定时会退化为 `unbind`。**
> 无条件交换会把 action 自己解绑，
> 结果两个动作指向同一个键或双双消失。

## 三种冲突策略

| 策略 | 行为 |
|---|---|
| `swap`   | 互换：被顶掉的动作拿到原按键 |
| `unbind` | 顶掉：被占用的动作直接解除绑定 |
| `reject`（默认） | 拒绝：保持原绑定不变 |

## ⚠️ `actionOf()` 返回 `null` 有两种含义

```typescript
actionOf(b): string | null {
  try { code = encodeBinding(b); }
  catch { return null; }                     // ① 绑定格式非法
  return this._byCode.get(code) ?? null;     // ② 这个按键没绑定
}
```

**「数据坏了」和「没绑定」返回同一个 `null`。**

后果：玩家改键后按键无反应，你分不清是
"这个键本来就没绑定"（正常，该提示"未绑定"）还是
"存档里的绑定数据写坏了"（异常，该重置为默认）。

想区分就自己先编码一次：

```typescript
let ok = true;
try { encodeBinding(b); } catch { ok = false; }

if (!ok) resetToDefault();                          // 数据坏了 → 重置
else if (rebind.actionOf(b) === null) showUnbound(); // 只是没绑定
```

---

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **修饰键必须排序去重** | 否则 `ctrl+shift+s` 和 `shift+ctrl+s` 是两条，冲突检测失效 |
| **swap 时目标没绑定要退化为 unbind** | 无条件交换会把 action 自己解绑，结果两个动作都指向同一键或都消失 |
| **反向索引必须清理** | 否则解除后再绑定会误判冲突 |
| **保留键默认 escape / f11** | ESC 是"返回/菜单"硬编码，F11 是全屏 |
| **导入损坏数据不崩** | 坏数据跳过并保持原绑定，好过整个设置界面打不开 |

## 展示

```typescript
formatBinding({ key: 's', mods: ['ctrl'] });   // 'Ctrl+S'
prettyKey('arrowup');                          // '↑'
```

## API

### 编码 / 解码

| 函数 | 说明 |
|---|---|
| `encodeBinding(binding)` | 编码成**规范字符串** |
| `decodeBinding(str)` | 解码 |
| `formatBinding(binding)` | 展示用：`'Ctrl+S'` |
| `prettyKey(key)` | 单键展示：`'arrowup'` → `'↑'` |

> ⚠️ **`encodeBinding` 会排序并去重修饰键，这是冲突检测能工作的前提。**
>
> 否则 `ctrl+shift+s` 和 `shift+ctrl+s` 被当成两个不同组合——
> 玩家的体验是"我明明已经改了，怎么还提示冲突"。
> 想比较两条绑定是否相同，**比较 encode 后的字符串**，别直接比对象。

### 类型与常量

| 导出 | 说明 |
|---|---|
| `Modifier` | `'ctrl'` / `'shift'` / `'alt'` / `'meta'` |
| `Binding` | `{ key, mods? }` |
| `BindingMap` | `Record<string, Binding>` |
| `MODIFIERS` | 修饰键数组（**展示顺序**：Ctrl → Alt → Shift → Meta） |
| `DEFAULT_RESERVED` | 默认保留键 |

> ⚠️ **`MODIFIERS` 的顺序是"展示顺序"，不是字母序。**
> `Ctrl → Alt → Shift → Meta` 是行业惯例（和 `encodeBinding` 的排序一致）。
> 自己拼展示串的话按这个顺序，写成 `Shift+Ctrl` 会很违和。

> **默认保留 `escape` 和 `f11`**：
> ESC 通常是"返回 / 菜单"的硬编码行为，
> F11 是全屏（浏览器和多数引擎都占用了）。
> 允许绑定它们会让玩家把自己锁死在菜单里。

**`RebindOptions`**：

| 字段 | 说明 |
|---|---|
| `conflict` | 冲突策略（见"三种冲突策略"一节） |
| `reserved` | 保留键 |
| `onChange(action)` | 变更回调 |

## 测试

**44 项**，覆盖编码归一化、三种冲突策略、保留键、反向索引清理、导入容错。
