# skill-variant · 技能变体（遗物改造技能）

> 肉鸽深度的富矿：同一个技能被遗物改造成完全不同的东西。

## 1. 它解决什么

```
火球术（基础）
  + 遗物「多重投射」 → 一次发 3 发
  + 遗物「穿透」     → 弹道穿透 +2
  + 遗物「爆裂」     → 命中时爆炸
  = 一次发 3 发、穿透、会爆炸的火球
```

手写的典型做法是搜遍代码找 `if (hasRelic('multi'))`——
三件遗物还能忍，三十件之后就是灾难。

本模块用**补丁（Patch）**描述改造，技能定义保持纯净。

## 2. 五分钟上手

```typescript
const sys = new SkillVariantSystem<SkillDef>({ onConflict: 'priority' });

sys.register({
  id: 'multi', name: '多重投射',
  patches: [{ op: 'set', path: 'projectile.count', value: 3 }],
});

sys.register({
  id: 'empower', name: '强化',
  patches: [{ op: 'mul', path: 'damage', value: 1.5 }],
});

const { result, applied } = sys.apply(baseFireball, ['multi', 'empower'], { data: {} });
// result.damage = 30, result.projectile.count = 3
// baseFireball 完全没变
```

## 3. 补丁运算

| op | 行为 | 路径不存在时 |
|---|---|---|
| `set` | 设置值 | 自动创建（数字索引建数组） |
| `add` / `mul` | 数值加减乘 | **抛错** |
| `max` / `min` | 取大/取小 | **抛错** |
| `push` | 数组追加 | 自动创建 |
| `remove` | 删除字段 | **抛错** |

`add` 对不存在的路径抛错是刻意的：给不存在的值做加法，
几乎一定是路径写错了，静默当 0 处理会掩盖错误。

## 4. 三个关键设计

### ① 深拷贝是最重要的一行

**不深拷贝，改的就是原型。**

表现为：所有敌人、所有玩家的火球都变 3 发，**而且不报错**。
更要命的是它会累积——拿一次遗物全局 +3，拿两次全局 +6，
玩家感觉"越玩越强，强得离谱"，你排查三小时找不到原因。

用结构化深拷贝而非 `JSON.parse(JSON.stringify())`：
后者会丢掉 undefined / Date / Map / Set，NaN 变 null，函数被吞掉。

### ② 条件变体：没有求值器时视为**已满足**

不是"不满足"——不满足的话，忘了注入求值器
所有条件变体都会静默失效，排查起来像见鬼。
视为满足至少效果可见（虽然可能不该生效）。

### ③ 互斥是双向的

`a.excludes = ['b']` 意味着无论先拿到哪个都互斥。
（Blessing 曾在这里出过 bug，见该模块 README。）

## 5. 坑与注意事项

| 坑 | 现象 | 对策 |
|---|---|---|
| 忘了深拷贝 | 全局技能被改，且累积 | `apply()` 内部已深拷贝，别绕过它 |
| 未注册的变体 id | 旧存档里的遗物 | 静默跳过，不崩 |
| 路径写错 | add/mul 对不存在路径 | 抛错，不静默 |
| 冲突策略选错 | 两个遗物改同一字段 | `onConflict: 'priority'`（默认） |

## 6. ⚠️ 与 snapshot 的重复实现

`applyPatch` / `deepClone` 在 `skill-variant` 和 `snapshot` 里各有一份。

这是 v1「禁止一切横向依赖」造成的复制，
正好印证了依赖规则 v2 里的判断：
**复制出去的代码会各自演化、各自出 bug，比横向依赖危险得多。**

**语义差异（调用方必须知道）：**

| | 修改方式 |
|---|---|
| `skill-variant.applyPatch(target, patch)` | **原地修改** |
| `snapshot.applyPatch(base, patch)` | **返回新对象** |

差异是合理的（一个改配置、一个回滚状态），
但搞混会出现"改了没生效"或"意外的共享引用"。

## 6.5 API

| 成员 | 说明 |
|---|---|
| `register(def)` / `registerAll(defs)` | 注册变体定义 |
| `unregister(id)` | 反注册，返回是否真的删掉了 |
| `apply(base, activeIds)` | 应用变体，返回新对象（**深拷贝，不改原配置**） |
| `preview(base, activeIds)` | **预览**效果，不真正应用（调试/GM 指令用） |
| `ids()` | 全部变体 id |

> **`preview` 存在的理由**：改遗物组合时想看"这套变体叠出来是什么样"，
> 走 `apply` 会真的改掉配置——
> 而配置一旦被改，同一局里其他技能也跟着变了，且**没有任何报错**。
> 调试面板上只用 `preview`。

## 7. 测试覆盖

45 项。重点覆盖：深拷贝隔离（含重复应用不累积）、优先级排序、互斥、目标筛选、条件求值与无求值器行为、七种补丁运算、中间层自动创建、循环引用/Date/Map、与 snapshot 的语义差异。

## 8. 依赖

零依赖，纯逻辑。
