#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描「配置项兜底写法的非有限值穿透」。

【为什么需要这个脚本】

全库曾经有 63 处这样的写法：

```typescript
this._capacity = Math.max(1, opts.capacity ?? 100);
```

它看起来是"给了兜底值"，其实有两处洞：

    Math.max(1, NaN)       === NaN       # `??` 只挡 nullish，挡不住 NaN
    Math.max(1, Infinity)  === Infinity  # 没有上界

对"容量/上限"类字段（limit / capacity / bufferSize），
NaN 或 Infinity 会让裁剪判定 `length > NaN` 恒为 false，
于是**集合永不裁剪，内存随操作次数无限增长**。

修法统一收口到 `_core/math.ts` 的两个函数：

    clampNum(v, min, max, fallback)   # 容量类：有上界
    numOr(v, fallback)                # 普通配置：只兜非有限值，不定上界

【为什么两种写法都要允许】

给普通配置定上界会**误伤合法值**
（`transitionMs: 600_000` 是合法配置，被裁成 1e4 就是悄悄改掉用户意图）。
所以本脚本只要求"必须用 numOr 或 clampNum 包住"，
**不强制用哪一个**——选哪个需要理解字段语义，机器判断不了。

【误报与漏报的取舍】

- 只扫 `Math.max/min(A, 外部来源 ?? B)` 这一形式（存量 0）
- 不扫不含 `??` 的（必填字段，需人工判断该用什么 fallback）
- 宁可漏报，不可误报：误报多了就没人看了

【已知盲区：不含 `??` 的兜底写法扫不到】

`gesture/Gesture.ts` 曾有一处漏网（批次 5 时承诺处理但漏了，
靠人工回头核对才发现）：

```typescript
const dt = Math.max(1, last.t - first.t);   // 扫不到
```

它没有 `??`，所以本脚本不报。但它同样挡不住 NaN：

    Math.max(1, NaN) === NaN → speed = path / NaN → 所有速度比较恒 false

**为什么没有把规则放宽到"任何 Math.max"**：

全库有 238 处 `Math.max/min`，其中大量是 `Math.max(0, x - y)` 这类
纯内部运算——它们的值来自局部变量，不来自外部输入，
加 numOr/clampNum 纯属噪音。放宽规则的直接后果是**误报暴涨**，
而误报多了就没人看了——那比漏报更糟，因为它会让检查整体失去可信度。

**所以这类写法靠人工判断**，判据是：

> 参与 `Math.max/min` 的值，是否可能来自外部（存档 / 配置表 / 输入事件 /
> 网络包）？如果是，非有限值会不会让它参与的**比较**恒为 false？

最典型的信号是**它后面紧跟着除法**（`speed = path / dt`）——
除零和 NaN 都会把小问题放大成"整个分支失效"。

用法：
    python3 scripts/scan-num-guard.py            # 检查，有命中则退出码 1
"""

import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 外部来源的变量前缀：这些值可能来自存档 / 配置表 / 调用方
EXT_PREFIX = re.compile(
    r'\b(opts|options|cfg|config|def|data|input|json|saved|state|raw|params?)\s*[.[]',
    re.I,
)

# Math.max(1, opts.x ?? 100) —— 第二参数是「外部来源 ?? 兜底」
# 限定 A 与 B 内不含括号，避免把复杂表达式误判进来
UNGUARDED = re.compile(
    r'Math\.(?:max|min)\(\s*'
    r'([^,()]+?)\s*,\s*'                     # 第一参数（下界/上界）
    r'([A-Za-z_$][\w.$?\[\]]*)\s*\?\?\s*'    # 外部来源 + ??
    r'([^,()]+?)\s*\)'                       # 兜底值
)

SKIP_DIRS = {'node_modules', '.build', 'typings', 'tests', 'examples'}


def iter_source_files():
    for p in sorted(ROOT.rglob('*.ts')):
        rel = p.relative_to(ROOT)
        if rel.parts[0] in SKIP_DIRS:
            continue
        yield p, rel


def strip_comment_line(line: str) -> str:
    """去掉整行注释。块注释由调用方维护状态。"""
    return '' if line.strip().startswith('//') else line


def scan() -> list[tuple[str, int, str]]:
    hits: list[tuple[str, int, str]] = []
    for path, rel in iter_source_files():
        try:
            text = path.read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError):
            continue

        in_block = False
        for lineno, raw in enumerate(text.split('\n'), start=1):
            stripped = raw.strip()
            if stripped.startswith('/*'):
                in_block = True
            if in_block:
                if '*/' in stripped:
                    in_block = False
                continue
            if stripped.startswith('*') or stripped.startswith('//'):
                continue

            for m in UNGUARDED.finditer(raw):
                source = m.group(2)
                if not EXT_PREFIX.search(source):
                    continue
                hits.append((str(rel), lineno, raw.strip()))

    return hits


def main() -> int:
    hits = scan()

    print('配置项非有限值穿透扫描')
    print('=' * 60)
    print('规则：Math.max/min(A, 外部来源 ?? B) 必须改成')
    print('      numOr(x, B)      （普通配置，不定上界）')
    print('      或 clampNum(...)  （容量类，需要上界）')
    print()

    if not hits:
        print('扫描 0 处命中 ✓ 未发现未收口的兜底写法')
        return 0

    print(f'发现 {len(hits)} 处未收口：\n')
    for rel, lineno, line in hits:
        print(f'  {rel}:{lineno}')
        print(f'      {line[:100]}')
    print()
    print('→ 修法：按字段语义选 numOr 或 clampNum（容量类必须用后者）')
    return 1


if __name__ == '__main__':
    sys.exit(main())
