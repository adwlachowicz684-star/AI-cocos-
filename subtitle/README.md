# subtitle · 字幕系统

> ⚠️ **写完代码必须同时完成三件事**：① 测试 ② README ③ 登记进 `_kitmeta.json`

---

## 它解决什么

字幕不是"按时间显示一行字"。真正麻烦的是：

- 同一时刻可能有多条（画外音 + 对话），不做区分会互相覆盖
- 玩家点跳过，当前这条要立刻结束并进入下一条
- 字幕必须跟着"播放到第几毫秒"走，自己维护计时器会在暂停/变速后漂移

## 用法

```typescript
const track = new SubtitleTrack({
  lines: [
    { start: 0,    end: 2000, text: '出发吧', speaker: 'hero' },
    { start: 2000, end: 4000, text: '小心',   speaker: 'npc' },
    { start: 3000, end: 5000, text: '（远处传来雷声）' },   // 旁白，与上一句重叠
  ],
  speakers: {
    hero: { name: '勇者', color: '#4CAF50' },
    npc:  { name: '村民', color: '#2196F3' },
  },
});

// 纯查询：给定时间，返回该显示什么
const active = track.at(audioTimeMs);
// → [{ line, speakerLabel: '勇者', speakerColor: '#4CAF50', progress: 0.5 }]

track.speakersAt(3500);   // ['npc'] —— 用于立绘高亮
track.skipToNext(3500);   // 5000（跳到下一条开始，跳过空档）
```

## SRT

```typescript
const lines = parseSRT(srtText);   // 自动提取【角色名】/ 角色名：
const text  = toSRT(lines);        // 导给配音或本地化
```

## ⚠️ 坑

| 坑 | 说明 |
|---|---|
| **可能同时有多条** | `at()` 返回数组，画外音和对话重叠是常态 |
| **结束边界是开区间** | `end` 那一刻不再显示，否则相邻两条会同时出现 |
| **skipToNext 跳到"开始"而非"结束"** | 有空档时直接跳过去，玩家不用等空白 |
| **SRT 毫秒位数不足要补位** | `,5` 是 500ms 不是 5ms |
| **构造时自动排序** | 配置里的顺序不该影响正确性 |
| **结束早于开始抛错** | 配表笔误，早失败 |

## 完整接口

| 成员 | 说明 |
|---|---|
| `at(time)` | 该时刻应显示的字幕（**返回数组**，见坑表格） |
| `speakersAt(time)` | 该时刻的说话人列表（**立绘高亮用**） |
| `nextIndex(time)` | 下一条的下标（`-1` = 后面没有了） |
| `skipToNext(time)` | 下一条的**开始时间**（跳过空档） |
| `advance(time)` | 同上，返回下一个时间点 |
| `lines()` | 全部字幕行（**已排序**） |
| `duration()` | 最后一条的结束时间 |
| `allSpeakers()` | 全部说话人 id |
| `lineCountOf(speaker)` | 某说话人有几句 |

> ⚠️ **`nextIndex()` 返回 `-1` 表示后面没有了**，不是 `null`。
> 当布尔用的话 `-1` 是**真值**——
> `if (track.nextIndex(t))` 在播完时反而走进分支。
> 必须显式判 `>= 0`。

> ⚠️ **`skipToNext()` 返回的是"下一条的开始时间"，不是"当前条的结束时间"。**
> 两条之间有空档时，用"当前结束时间"会让玩家干等空白——
> 这正是坑表格里那条的含义。

> ⚠️ **`duration()` 是最后一条的 `end`，不是"总时长"。**
> 如果第一条不从 0 开始，用 `duration()` 做进度条分母
> 会让进度条和实际播放对不上。

> **`speakersAt()` 与 `at()` 是两个查询**，
> 前者只返回说话人 id（去重后），适合驱动立绘高亮；
> 后者返回完整的显示信息（含文本、颜色、进度）。

### 类型

```typescript
interface SubtitleLine {
  start: number;          // 毫秒
  end: number;            // 毫秒（**开区间**，见坑表格）
  text: string;
  speaker?: string;       // 说话人 id，省略 = 旁白
}

interface ActiveSubtitle {
  line: SubtitleLine;
  speakerLabel?: string;  // 显示名（来自 speakers 配置）
  speakerColor?: string;
  progress: number;       // 这条播了百分之多少
}
```

> ⚠️ **`speaker` 省略表示旁白，不是"未知说话人"。**
> 旁白不参与 `speakersAt()` 的结果——
> 想让旁白也高亮某个立绘，得显式给 `speaker`。

**`SubtitleTrackOptions`**：

| 字段 | 说明 |
|---|---|
| `lines` | 字幕行（**构造时自动排序**，配置顺序不影响正确性） |
| `speakers` | 说话人配置：`{ [id]: { name, color } }` |

> ⚠️ **`speakers` 里没配的说话人不会报错。**
> `speakerLabel` 和 `speakerColor` 会是 `undefined`，
> 表现为"这条字幕没有名字/颜色"。
> 用 `allSpeakers()` 核对配表是否齐全。

## 设计：为什么不持有播放状态

字幕是**纯查询**（给定时间 → 返回内容），不维护"当前播到哪"。

这样它天然支持 seek、快进、倒退——因为倒退只是把 `time` 传小一点。
自己维护计时器的实现在变速播放时会和音频漂移，而且无法跳转。

## 测试

**31 项**，覆盖重叠、progress、边界、SRT 解析（点号/补位/说话人提取）与往返。
