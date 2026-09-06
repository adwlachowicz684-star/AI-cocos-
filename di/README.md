# di — 轻量依赖注入容器

## 它解决什么

随着项目变大，你会写出这样的构造链：

```typescript
const bus = new EventBus();
const rng = new RNG(seed);
const loot = new LootTable(rng);
const drops = new DropService(loot, rng);
const combat = new CombatService(bus, drops, new DamagePipeline());
const game = new Game(bus, combat, ai, ...);
```

每加一个依赖，就要改一遍所有下游的构造调用。更糟的是测试：
为了给 combat 换一个假的 rng，你得把整条链重造一遍。

## 用法

```typescript
const c = new DIContainer();

c.register('seed', () => 12345);
c.register('rng', (c) => new RNG(c.get<number>('seed')), { singleton: true });
c.register('bus', () => new EventBus(), { singleton: true });
c.register('loot', (c) => makeLootTable(c.get('rng')));

const loot = c.get<LootTable>('loot');

// 测试：换掉 rng 就行，下游全部自动跟上
const testC = c.fork();
testC.register('rng', () => new FixedRandomSource([0.5]), { override: true });
```

## 什么时候不该用

| 情况 | 建议 |
|---|---|
| 依赖只有一两层 | 直接 `new` 更清楚 |
| 依赖关系不会变 | 手写构造 |
| 性能敏感的热路径 | 直接持有引用，别每次 `get()` |

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| 服务定位器（到处 `Services.get()`） | 依赖关系被隐藏，看构造函数看不出依赖什么 | **只在组合根（main.ts）解析一次**，然后构造函数传下去 |
| 循环依赖 | 不检测的话是 `RangeError: Maximum call stack`，完全看不出是 DI 的问题 | 已检测，报出依赖链 `a → b → a` |
| 覆盖注册后拿到旧实例 | 缓存没失效 | 已处理：覆盖时清除单例 |
| 忘了注册销毁 | 事件监听、定时器残留 | 用 `disposable()` |

## API

| 成员 | 说明 |
|---|---|
| `register(key, factory, opts?)` | 注册工厂。`opts.lifetime`: `singleton`(默认) / `transient` / `override` |
| `value(key, v)` / `instance(key, v)` | 注册常量 |
| `disposable(key, factory, opts?)` | 注册带 `destroy()` 的单例 |
| `get<T>(key)` | 解析（**循环依赖会报错**；未注册会报错并给出"你是不是想找 xxx"） |
| `tryGet<T>(key)` | 解析，未注册返回 `undefined` 而不是抛错 |
| `has(key)` | 是否已注册（**不会触发工厂**） |
| `unregister(key)` | 反注册，返回是否真的删掉了。**会连带清掉单例缓存** |
| `fork(name?)` | 派生子容器（**测试换依赖的标准做法**） |
| `validate()` | 检查所有注册能否解析完（启动期跑一次） |
| `clearSingletons()` | 只清缓存，保留注册 |
| `destroy()` | 倒序调用 disposer 后清空 |
| `keys` | 已注册的 key 列表 |
| `size` | 注册项数量 |

> ⚠️ **`size` 数的是"注册项"，不是"已创建的实例"。**
> `singleton` 是懒创建的——注册了但还没 `get()` 过，实例就不存在。
> 想查"当前有几个活着的单例"没有现成 API，
> 排查内存泄漏要看你自己的 disposer 有没有被调用。

> **`keys` 是诊断"key 拼错"的入口。**
> `get('playerServcie')` 抛错时，错误信息里已经带了"你是不是想找 xxx"的提示
> （基于编辑距离），但排查看 `keys` 更直接。

### `createContainer(name?)`

`new DIContainer(name)` 的语法糖，两者等价。

```typescript
const c = createContainer('game');
```

> **⚠️ `fork()` 是测试里换依赖的正确姿势。**
> 直接改原容器会污染其他测试；`fork()` 出来的子容器
> 用 `{ override: true }` 覆盖某个注册，下游全部自动跟上：
>
> ```typescript
> const testC = c.fork('test');
> testC.register('rng', () => new FixedRandomSource([0.5]), { override: true });
> ```

> **⚠️ `unregister` 会清掉单例。**
> 反注册后再注册同名 key，工厂会**重新执行**一次——
> 这正是想要的行为（否则拿到的是旧实例），但要知道它同时丢了缓存。
| `tryGet<T>(key)` | 不存在返回 undefined（可选依赖） |
| `fork(name?)` | 派生子容器（**测试换依赖用**） |
| `validate()` | 校验所有注册项能否解析（**启动体检**） |
| `clearSingletons()` | 清单例缓存，保留注册 |
| `destroy()` | 倒序调用所有 disposer |
