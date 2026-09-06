#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
检查：文档里的"实测"数字是否标注了样本量

============================================================
【为什么要这个脚本】
============================================================

`noise` 的数值域曾经写成 [-1.279, 1.208]，说"约 0.10% 超域"。
那个数字是**小样本**测出来的，极值偏低约 8%，
而且**没写样本量**，后来被当成精确值用进了文档。

外部审查用 5 种子 × 10 万次重测，得到 [-1.3735, 1.2773] / 0.157%。

后果很具体：谁按 [-1.279, 1.208] 做归一化，
仍有 0.157% 的值会溢出——文档给了一个**错误的安全边界**。

同一轮还发现 `steering` 写着"最近间距保持在 1.77"，
实测稳态是 **17.64**（差 10 倍，小数点写错）。
同样是因为没标样本量，无法复现、无法发现它是错的。

**根因不是"测错了"，是"写了数字但没写它是怎么测出来的"。**
没写样本量的数字 = 不可复现 = 无法证伪 = 会一直错下去。

============================================================
【设计选择：宁可漏报，不可误报】
============================================================

第一版试图把所有带小数点的数字都扫一遍，报出 **42 处**。
逐条看下来 **35 处是误报**：

  - 版本号（0.30.0、3.8.8）
  - CSS / 配置默认值（0.5 秒、1.15 倍率）
  - 文件路径、行号
  - 场景参数（"CD 1.0s，剩 0.1s 时点击"——这是输入，不是测量结果）
  - 纯描述性文字

误报比漏报更糟：报 42 处而 35 处是噪音，
人看两次就会开始跳过它——**检查失效**。

所以这一版只扫**明确有"实测/采样/抽样/统计"语境**的行，
并且要求数字确实像测量值（有小数、不是版本号）。

============================================================
【已知漏检（不假装能扫全）】
============================================================

1. 样本量写在别的段落（如表格标题在上一行）
2. 样本量用"跑了很久""大量测试"这类模糊表述
   —— 这本来也不合格，但脚本识别不了
3. 数字在代码块里（本脚本跳过代码块）

这些只能靠人工。脚本的定位是"拦住最明显的那批"。
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 只有出现这些词，才认为该行可能在讲实测结果
MEASURE_WORDS = ('实测', '采样', '抽样', '统计', '测量', '扫描了', '跑了')

# 出现这些词，认为已经标了样本量
#
# 【⚠️ 不要往这里放裸 `*` 或裸 `x`】
#
# 第一版放了 `'*'`，结果匹配上 Markdown 的加粗符号——
# `**实测**` 里有两个 `*`，于是任何加粗的行都被判为"已标样本量"。
# 检查几乎完全失效：注入故障后仍然报 0。
#
# 这正是"永远返回 0 的检查等于没有检查"——
# 我在本文件上面的注释里刚强调过这个教训，转头就犯。
#
# 乘法/除法要用下面的正则精确匹配数字之间的运算符。
SAMPLE_WORDS = (
    '次', '样本', '种子', '万', '亿', '组', '轮', '帧', '个',
)

# 形如 "5 × 10万" / "8 x 3秒" / "787/500000" 的运算式
SAMPLE_EXPR_RE = re.compile(r'\d+\s*[×x*]\s*\d|\d+\s*/\s*\d+')

# 这些不是测量值，跳过
SKIP_PATTERNS = (
    r'\d+\.\d+\.\d+',      # 版本号 3.8.8 / 0.30.0
    r'typescript', r'node', r'npm',
)

# 小数点数字
NUM_RE = re.compile(r'(?<![\w.])\d+\.\d{1,6}(?![\w.])')

# 检测前先从行里剔除的内容
#
# 【为什么剔除反引号内容】
# 误报案例：`审查记录.md` 的
#   "它们用 `i * 0.13, i * 0.29` 采样"
# 反引号里的是**采样步长配置**（测试怎么跑的），
# 不是"测出来的结果"。
#
# 这比逐个加黑名单干净：反引号内的东西在 Markdown 里
# 按约定就是代码/字面量，不构成文档对读者的数值承诺。
BACKTICK_RE = re.compile(r'`[^`]*`')

# 【为什么要剥掉标题编号】
# `### 1.1 六条核心缺陷实测坐实` 里的 `1.1` 是章节号，不是实测值。
# 不剥掉的话，任何"标题编号 + 标题里带'实测'二字"的行都会被误报，
# 而这种误报的修法只能是给标题编号硬凑样本量——把文档改坏。
HEADING_NUM_RE = re.compile(r'^\s{0,3}#{1,6}\s+\d+(?:\.\d+)*[.、]?\s*')


def has_sample_context(line: str) -> bool:
    """该行是否标了样本量"""
    if any(w in line for w in SAMPLE_WORDS):
        return True
    return bool(SAMPLE_EXPR_RE.search(line))


def is_in_code_block(lines: list, idx: int) -> bool:
    """该行是否在 ``` 代码块内（简单判断：往前数 fence 的奇偶）"""
    fences = 0
    for i in range(idx):
        if lines[i].strip().startswith('```'):
            fences += 1
    return fences % 2 == 1


def scan_file(path: Path) -> list:
    """返回 [(行号, 行内容)]"""
    try:
        text = path.read_text(encoding='utf-8')
    except Exception:
        return []

    lines = text.split('\n')
    out = []

    for i, line in enumerate(lines):
        if not any(w in line for w in MEASURE_WORDS):
            continue
        if is_in_code_block(lines, i):
            continue

        # 排除版本号之类的
        if any(re.search(p, line, re.I) for p in SKIP_PATTERNS):
            continue

        # 剔除反引号内容，剩下的才是文档向读者承诺的数值
        probe = BACKTICK_RE.sub(' ', line)

        # 剔除标题编号（`### 1.1 xxx` 里的 1.1 是章节号）
        probe = HEADING_NUM_RE.sub('', probe)

        nums = NUM_RE.findall(probe)
        if not nums:
            continue

        # 已经标了样本量 → 通过
        if has_sample_context(line):
            continue

        out.append((i + 1, line.strip()))

    return out


def main() -> int:
    md_files = [
        p for p in ROOT.rglob('*.md')
        if 'node_modules' not in str(p) and '.build' not in str(p)
    ]

    total = 0
    findings = []

    for p in sorted(md_files):
        rel = p.relative_to(ROOT)
        for lineno, content in scan_file(p):
            total += 1
            findings.append((rel, lineno, content))

    if total == 0:
        print('[OK] 所有"实测"数字均已标注样本量'
              f'（扫描 {len(md_files)} 个 .md 文件）')
        return 0

    print(f'[!] {total} 处"实测"数字未标注样本量：\n')
    for rel, lineno, content in findings:
        print(f'  {rel}:{lineno}')
        print(f'    {content[:150]}')
        print()
    print('修法：在数字旁写明样本量，如')
    print('  "实测 5 种子 × 10 万次：[-1.3735, 1.2773]"')
    return 1


if __name__ == '__main__':
    sys.exit(main())
