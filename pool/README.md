# Pool\<T\>

通用对象池。这是「解耦 vs 可复用」最好的例子。

## 为什么泛型这么重要

```typescript
// ❌ 不可复用：写死了「子弹」
class BulletPool { get(): Bullet { ... } }

// ✅ 可复用：不知道自己装的是什么
const pool = new Pool<T>(create, onGet, onPut);
```

`Pool<T>` 能装子弹、敌人、飘字、粒子、网络包——**换来换去不用改一行代码**。

## 用法

```typescript
import { Pool } from './pool/Pool';

class Bullet {
  x = 0; y = 0; vx = 0; vy = 0; alive = false;
  reset() { this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.alive = true; }
  sleep() { this.alive = false; }
}

const pool = new Pool<Bullet>(
  () => new Bullet(),      // create：怎么造
  (b) => b.reset(),        // onGet：取出前怎么重置
  (b) => b.sleep(),        // onPut：归还前怎么休眠
  { maxSize: 200, trackLeaks: true }
);

pool.prewarm(50);          // 预热，避免运行中创建造成卡顿尖峰

const b = pool.get();
// ... 使用 ...
pool.put(b);

pool.dump();               // 泄漏报告
```

## 三个钩子为什么都要有

| 钩子 | 作用 | 不做会怎样 |
|---|---|---|
| `create` | 造新对象 | — |
| `onGet` | **重置状态** | 新子弹带着上一颗的位置和速度（最经典的池 bug） |
| `onPut` | **断开引用、休眠** | 归还的对象还被别处引用，出现「幽灵对象」 |

## 坑

- **忘记 reset**：复用对象带着上一次的状态。表现为「新子弹从奇怪的位置飞出来」
- **只 get 不 put**：池子无限创建新对象。开 `trackLeaks` 用 `dump()` 查
- **`maxSize` 没设**：池子只增不减，切几次场景内存就上去了
- **归还后仍被外部引用**：出现「幽灵对象」——看起来死了但还在动
- **预热数量拍脑袋**：`created` 远大于 `maxSize` 说明池没起作用

## 性能提示

- `get()` / `put()` 都是 O(1)，适合高频路径
- `prewarm()` 要在加载阶段做，不要在战斗中做（会造成卡顿尖峰）
- `trackLeaks` 有明显开销，**只在开发期开启**

## API

| 成员 | 说明 |
|---|---|
| `get()` | 取出（自动调用 onGet） |
| `put(obj)` / `putAll(arr)` | 归还（自动调用 onPut） |
| `prewarm(n)` | 预热 n 个 |
| `clear()` | 清空空闲对象 |
| `dump(thresholdMs)` | 泄漏报告（需 trackLeaks） |
| `created` / `active` / `idle` | 统计 |
| `destroy()` | 清空 |
