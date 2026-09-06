#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scan-dt-guard.py —— 扫描「dt 参与算术但无守卫」

## 为什么需要它

`dt` 是每帧从调用方传进来的一个数。它可能来自：
- 引擎的 deltaTime（正常）
- 暂停逻辑（`0`，正常）
- **某个 NaN 计算的下游**（`NaN`，异常）
- **除零或溢出**（`Infinity`，异常）

一旦异常 dt 进入状态累加，后果不是"这一帧错了"，而是**永久污染**：
`NaN + 任何数 === NaN`，角色坐标变 NaN 后再正常几百帧也回不来。

这个模式在全库独立出现过 20+ 次，靠人工 review 杜绝不了。

## 三条判定（宁可漏报，不可误报）

1. 只看方法体内的 `dt` 算术行，且该行**不在**守卫之后
2. 已用 `safeDt(dt)` / `Number.isFinite(dt)` 的方法**整体跳过**
3. `dt` 只是被转发（如 `child.tick(ctx, bb, dt)`）**不算**

## 已知漏报（不假装能扫全）

- 守卫写在别的方法里，靠调用顺序保证
- `dt` 被改名（如 `d`、`delta`）
- 跨行表达式：算术在下一行

## 用法

    python3 scripts/scan-dt-guard.py            # 检查（命中则退出码 1）
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {'.build', 'node_modules', 'tests', 'examples', 'typings', 'scripts', '.git'}

# 守卫写法：命中即认为该方法已防护
GUARD_RE = re.compile(
    r'safeDt\s*\(\s*dt\s*\)'
    r'|Number\.isFinite\s*\(\s*dt\s*\)'
    r'|isFinite\s*\(\s*dt\s*\)'
)

# dt 参与算术
ARITH_RE = re.compile(
    r'\bdt\b\s*[-+*/]\s*\d'
    r'|\bdt\b\s*[-+*/]\s*[A-Za-z_(]'
    r'|[A-Za-z_)\]]\s*[-+*/]\s*\bdt\b'
    r'|\bdt\b\s*[-+*/]='
    r'|[-+*/]=\s*\bdt\b'
)

# 纯转发：不做算术，只是传下去
FORWARD_RE = re.compile(r'tick\s*\([^)]*\bdt\b\s*\)|\.update\s*\([^)]*\bdt\b\s*\)')

# tick/update 方法开始
METHOD_RE = re.compile(
    r'^\s*(?:public\s+|private\s+|protected\s+)?'
    r'(?:tick|update|advance|step)\s*\([^)]*\bdt\s*:\s*number[^)]*\)\s*(?::\s*[^{]+)?\{'
)

# 方法内出现守卫之后的行，视为已受保护
def strip_comments_keep_lines(src: str) -> str:
    """剥注释但保留行号（删内容不删换行）"""
    out = []
    for line in src.split('\n'):
        s = line
        # 整行注释
        if s.strip().startswith('//') or s.strip().startswith('*') or s.strip().startswith('/*'):
            out.append('')
            continue
        # 行尾注释
        idx = s.find('//')
        if idx >= 0:
            # 排除 URL 里的 //
            if 'http' not in s[:idx]:
                s = s[:idx]
        out.append(s)
    return '\n'.join(out)


def scan_file(path: str):
    """返回 [(line_no, code)]"""
    raw = open(path, encoding='utf-8').read()
    src = strip_comments_keep_lines(raw)
    lines = src.split('\n')

    hits = []
    i = 0
    n = len(lines)
    while i < n:
        if METHOD_RE.match(lines[i]):
            # 找方法体范围：简单大括号配平
            depth = 0
            start = i
            body = []
            while i < n:
                depth += lines[i].count('{') - lines[i].count('}')
                body.append((i + 1, lines[i]))
                i += 1
                if depth <= 0:
                    break
            text = '\n'.join(l for _, l in body)
            if GUARD_RE.search(text):
                continue  # 已有守卫，跳过整个方法
            for ln, code in body:
                if ARITH_RE.search(code) and 'dt' in code:
                    if FORWARD_RE.search(code):
                        continue
                    hits.append((ln, code.strip()))
            continue
        i += 1
    return hits


def main() -> int:
    total = 0
    files = 0
    for entry in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, entry)
        if not os.path.isdir(p) or entry in SKIP_DIRS or entry.startswith('.'):
            continue
        for fn in sorted(os.listdir(p)):
            if not fn.endswith('.ts'):
                continue
            f = os.path.join(p, fn)
            files += 1
            hits = scan_file(f)
            for ln, code in hits:
                total += 1
                rel = os.path.relpath(f, ROOT)
                print(f'  {rel}:{ln}  {code[:88]}')
    print(f'\n扫描 {files} 个文件，命中 {total} 处')
    if total:
        print('\n【怎么办】在函数开头加：')
        print("  if (!safeDt(dt)) return;")
        print("\n注意：守卫必须在**任何** dt 算术之前——")
        print("  skill-caster 的旧代码把守卫写在冷却递减之后，")
        print("  一个 NaN 帧就让全部技能冷却归零。")
        return 1
    print('✓ 未发现无守卫的 dt 算术')
    return 0


if __name__ == '__main__':
    sys.exit(main())
