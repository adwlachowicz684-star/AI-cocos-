# scheduling — 分帧调度器

## 它解决什么

有些活一次性做完会卡住一帧：生成 200×200 地图、实例化 500 个敌人、
读档反序列化、启动时校验 30 张配置表。

60fps 下每帧只有 16.6ms。这类活干了 200ms 就是明显卡顿，
画面定住，玩家以为游戏崩了。

分帧调度的做法：**每帧只干 N 毫秒，剩下的留到下一帧**。

## 为什么按时间预算而不是按数量

常见的错误做法是"每帧处理 10 个"。问题在于每个的耗时不同
（有的 0.1ms，有的 5ms），结果帧时间忽长忽短。
按**时间预算**切分才稳定。

## 用法

```typescript
const fs = new FrameScheduler({ budgetMs: 4 });

// ① 批量处理摊到多帧
fs.scheduleBatch(enemyIds, (id) => spawnEnemy(id), {
  onDone: () => console.log('刷怪完成'),
  onProgress: (done, total) => updateLoadingBar(done / total),
});

// ② 自定义长任务
fs.schedule((ctx) => {
  while (ctx.hasTimeLeft() && !mapGen.done) mapGen.step();
  return mapGen.done;
});

// ③ 优先级
fs.schedule(task, { priority: 10 });   // 数字大的先执行

// ④ 每帧驱动
fs.update();

// ⑤ 同步跑完（测试、加载界面跳过动画）
fs.flush();
```

**预算建议 2–5ms**。`hardLimitMs` 默认取 `max(budget*2, 8)`，
保证即使单个任务项很慢，帧率也不会跌太狠。

## 与 scheduler/Scheduler 的区别

| | Scheduler | FrameScheduler |
|---|---|---|
| 管什么 | **什么时候**执行（延时、重复、暂停） | **一帧之内干多少** |

两者互补，不是替代关系。

## 坑

| 坑 | 后果 | 解法 |
|---|---|---|
| `flush()` 忘了移出队列 | 卡住好几秒（靠 guard 撑到 100 万次） | 已修复 |
| 完成回调放在遍历内 | 回调里注册新任务会破坏遍历 | 已修复：回调在循环之后 |
| 任务抛异常 | 每帧都报错 | 已处理：出错即完成，不重试 |
| 硬上限检查放在任务之前 | 第一项永远拦不住 | 已处理：检查在任务之后 |
| 在 flush 里处理 10 万项 | 主线程卡死 | flush 只用于测试/启动时 |

## API

| 成员 | 说明 |
|---|---|
| `schedule(step, opts?)` | 注册分步任务，返回 id。`step` 返回 true = 完成 |
| `scheduleBatch(items, process, opts?)` | 批量处理（最常用） |
| `destroy()` | 清空所有待处理任务 |
| `cancel(id)` / `cancelAll()` | 取消 |
| `update()` | 每帧驱动 |
| `flush()` | 同步跑完（**会阻塞**） |
| `isBusy` / `pendingCount` | 状态查询 |
| `lastFrameMs` | **本帧已用时间（毫秒）**（性能面板用） |

> **`lastFrameMs` 是分帧调度的"预算表"。**
> 它记录上一帧分帧任务实际占用了多少毫秒，
> 配合 `budgetMs` 配置可以观察"是否每帧都在超支"。
>
> 典型用法：性能面板显示 `分帧调度 ${sched.lastFrameMs.toFixed(1)}ms / 预算 ${budgetMs}ms`。
> 长期贴着预算跑说明分帧粒度太粗，会拖慢主逻辑帧率。
