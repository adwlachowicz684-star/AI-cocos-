#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check-random-source.py —— 禁止绕过 _core.MathRandomSource 自己造随机源

【为什么需要这条检查】
《架构》与《逻辑与边界》两份报告都指出同一件事：
`_core/types.ts` 导出了 `MathRandomSource`，但 4 个模块各写了一份
`class DefaultRandom { next() { return Math.random(); } }`，零复用。

问题不只是重复代码——**可复现性是静默丢失的**：
忘记注入 rng 时，词条生成 / 攻击令牌 / 刷怪波次会退化成不可复现，
而没有任何警告。`rng/RNG.ts` 自己写的铁律是：

    所以任何地方都不能偷偷用 Math.random()——包括洗牌、包括 AI 抖动。

【检查什么】
  1. 生产代码里出现 `class Xxx implements IRandomSource` 且方法体直接
     `return Math.random()`  → 报错（应改用 MathRandomSource）
  2. 生产代码里 `next()` 方法体直接 `return Math.random()`  → 同上

【不检查什么】
  - `rng/RNG.ts` 自身（它就是这个能力的提供者）
  - `_core/types.ts`（MathRandomSource 的定义处）
  - tests/ 和 examples/（测试里用 Math.random 造数据是可以的）

【退出码】 0 = 通过，1 = 发现问题
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {'node_modules', '.build', 'tests', 'examples', 'scripts',
             'typings', '.git', '__pycache__'}
ALLOW_FILES = {
    os.path.join('_core', 'types.ts'),   # MathRandomSource 的定义处
    os.path.join('rng', 'RNG.ts'),       # 可复现随机源的提供者
}

# next() 后面 200 字符内出现 return Math.random()
PAT_NEXT = re.compile(
    r'next\s*\(\s*\)\s*(?::\s*number\s*)?\{[^}]{0,200}?return\s+Math\.random\s*\(',
    re.S,
)
# class X implements IRandomSource
PAT_CLASS = re.compile(
    r'class\s+\w+[^{]*\bimplements\b[^{]*\bIRandomSource\b[^{]*\{',
    re.S,
)


def main() -> int:
    hits = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if not fn.endswith('.ts'):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT)
            if rel in ALLOW_FILES:
                continue
            try:
                src = open(full, encoding='utf-8').read()
            except OSError:
                continue
            # 剥注释，避免示例注释里的 import 被当成真实引用
            src = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), src, flags=re.S)
            src = re.sub(r'//[^\n]*', '', src)
            for m in PAT_NEXT.finditer(src):
                line = src[:m.start()].count('\n') + 1
                hits.append((rel, line, 'next() 直接 return Math.random()'))
            for m in PAT_CLASS.finditer(src):
                line = src[:m.start()].count('\n') + 1
                hits.append((rel, line, '自定义 class implements IRandomSource'))

    print('=' * 58)
    print('检查：随机源是否绕过 _core.MathRandomSource')
    print('=' * 58)
    if hits:
        print(f'\n发现 {len(hits)} 处（应改用 MathRandomSource）：\n')
        for rel, line, why in sorted(hits):
            print(f'  {rel}:{line}  {why}')
        print('\n修法：删掉自定义类，改为')
        print("  import { MathRandomSource } from '../_core/types';")
        print('  this._rng = opts.rng ?? MathRandomSource;')
        return 1
    print('\n[OK] 未发现自建随机源，全部复用 _core.MathRandomSource')
    return 0


if __name__ == '__main__':
    sys.exit(main())
