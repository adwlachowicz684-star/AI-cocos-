# -*- coding: utf-8 -*-
"""
检测「同一目录多个 .ts 文件导出同名符号」

【为什么要这个】
currency 目录里 Currency.ts 和 CurrencyWallet.ts 都导出 CurrencyDef，
字段完全不同（cap/floor/precision vs max/premium/trackLog）。
elo 目录里 Elo.ts 和 Glicko2.ts 都导出 expectedScore，
参数类型完全不同（两个 number vs 两个玩家对象）。

两处都是**静默失败**——编译能过、运行不报错、结果全错。
而人工审查很难发现：它们在不同文件里，各自看都合理。

【用法】
    python3 scripts/check-dup-exports.py

退出码 0 = 无冲突，1 = 有冲突。
"""
import os
import re
import sys
import collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP = {'node_modules', '.build', '.git', 'tests', 'examples', 'scripts', 'typings'}

# 只在「同目录多文件」时才有意义：
# 单文件内重名是重复声明，TypeScript 会直接报错，不需要这个脚本管。
PAT = re.compile(
    r'^export\s+(?:declare\s+)?(?:abstract\s+)?'
    r'(class|function|interface|type|const|enum|let|var)\s+(\w+)',
    re.M
)

NOTE = (
    "\n"
    "同名导出本身不违法，但必须满足其一：\n"
    "  ① 两份的字段 / 参数完全一致，或\n"
    "  ② 在文件头 + README 里写明差异与选择判据\n"
    "\n"
    "否则调用方 import 错了不会报错 —— 静默得到 undefined 或 NaN。\n"
)


def count_multi_file_dirs():
    n = 0
    for d in sorted(os.listdir(ROOT)):
        full = os.path.join(ROOT, d)
        if not os.path.isdir(full) or d in SKIP or d.startswith('.'):
            continue
        ts = [f for f in os.listdir(full) if f.endswith('.ts')]
        if len(ts) >= 2:
            n += 1
    return n


def main():
    found = []
    for d in sorted(os.listdir(ROOT)):
        full = os.path.join(ROOT, d)
        if not os.path.isdir(full) or d in SKIP or d.startswith('.'):
            continue
        ts = [f for f in sorted(os.listdir(full)) if f.endswith('.ts')]
        if len(ts) < 2:
            continue
        exports = collections.defaultdict(list)
        heads = {}
        for f in ts:
            src = open(os.path.join(full, f), encoding='utf-8').read()
            # 文件头：取到第一个非注释内容为止，避免正文里提到同名符号造成误判
            heads[f] = src[:src.find('*/') + 2] if '*/' in src[:4000] else src[:2000]
            for m in PAT.finditer(src):
                exports[m.group(2)].append((f, m.group(1)))
        for name, where in sorted(exports.items()):
            if len(where) > 1:
                kinds = {k for _, k in where}
                # 已处理 = 每个文件的头部都提到了这个符号名（即写了对照说明）
                documented = all(name in heads[f] for f, _ in where)
                found.append((d, name, kinds, where, documented))

    pending = [x for x in found if not x[4]]
    done = [x for x in found if x[4]]

    print('=== 同目录多文件导出同名符号 ===')
    print('已检查 %d 个多文件目录' % count_multi_file_dirs())

    if done:
        print('\n--- 已写对照说明（%d 处）---' % len(done))
        for d, name, kinds, where, _ in done:
            print('  [OK] %-14s %-20s %s' % (d, name, ' / '.join(f for f, _ in where)))

    if not pending:
        print('\n[OK] 无待处理的冲突')
        return 0

    print('\n--- 待处理（%d 处）---' % len(pending))
    for d, name, kinds, where, _ in pending:
        flag = '[!] 不同类型' if len(kinds) > 1 else '[.] 同类型'
        print('\n  %-14s %-20s %s' % (d, name, flag))
        for f, k in where:
            print('      %-24s (%s)' % (f, k))
    print(NOTE)
    return 1


if __name__ == '__main__':
    sys.exit(main())
