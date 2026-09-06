# result — 显式错误处理

## 什么时候用 Result，什么时候用异常

| | 用 Result | 用异常（Assert） |
|---|---|---|
| 场景 | **预期内的失败**：文件不存在、网络超时、解析失败、钱不够 | **程序 bug**：数组越界、null 解引用 |
| 判断标准 | 调用方能合理地恢复 → Result | 不能恢复 → 让它在开发期炸掉 |

## 用法

```typescript
import { ok, err, attempt, all, fromNullable } from './result/Result';

function loadSave(path: string): Result<SaveData, string> {
  try {
    const obj = JSON.parse(readFile(path));
    if (!obj.version) return err('缺少 version 字段');
    return ok(obj as SaveData);
  } catch (e) {
    return err(`解析失败: ${e}`);
  }
}

const r = loadSave('slot1');
if (r.ok) use(r.value);
else showError(r.error);      // 不处理就取不到 value，编译器会拦

// 链式
const roomCount = loadSave('s').map(d => d.rooms.length).unwrapOr(0);

// 组合：全部成功才算成功
const both = all([loadSave('a'), loadSave('b')]);

// 包装异常
const parsed = attempt(() => JSON.parse(text), (e) => `解析失败: ${e}`);
```

## 为什么比异常好

从函数签名就能看出失败的可能性：

```typescript
function f(): SaveData              // 会抛吗？抛什么？不知道
function f(): Result<SaveData, string>   // 一眼看全
```

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 用 `catch (e) {}` 全吞掉 | 隐藏 bug | 用 Result 强制处理 |
| 对 Err 调 `unwrap()` | 抛异常 | 先 `isOk()` 判断，或用 `unwrapOr` |
| 把程序 bug 也包成 Result | 开发期发现不了 | 程序 bug 用 Assert 让它炸 |

## API

| 函数 / 方法 | 说明 |
|---|---|
| `ok(v)` / `err(e)` | 构造 |
| `isOk()` / `isErr()` | 判断（兼类型收窄） |
| `map` / `flatMap` / `mapErr` | 变换 |
| `unwrapOr(fallback)` | 安全取值 |
| `unwrap()` | 取值（Err 时抛错） |
| `match(onOk, onErr)` | 分支处理 |
| `attempt(fn, onError)` | 包装抛异常的函数 |
| `all(results)` / `any(results)` | 组合 |
| `fromNullable(v, error)` | 从可空值构造 |
