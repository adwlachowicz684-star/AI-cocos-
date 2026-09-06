# -*- coding: utf-8 -*-
"""
统计各批测试数（数据源：npm test 的实际输出，不是数源码）

用法：
    node .build/tests/run.js > /tmp/all.log 2>&1
    python3 scripts/count-suites.py /tmp/all.log

【为什么要这个脚本】
文档里"各批测试分布"那张表，曾经用数源码里 `test(` 出现次数来填，
结果静态数出 2552、运行时通过 2576 —— 24 项对不上，查了几轮没找到来源。

【⚠️ 踩过的坑：setSuite 打印的是四行】
    console.log(`\n${'='.repeat(50)}\n${name}\n${'='.repeat(50)}`);

即：空行 / ==== / name / ==== / 空行。

第一版解析只吞掉一个 `====`，于是遇到第二道分界线时
把 cur 覆盖成了它后面的空行 —— 结果每一项都统计成 0，
而"✓ 行数 2977"是对的（合计数反而正确）。

**合计对、分项全 0，说明分组逻辑错了，不是计数逻辑错了。**

所以必须一次吞掉两个 `====` 行。
"""
import sys
lines = open(sys.argv[1], encoding='utf-8').read().split('\n')
c = {}; order = []; cur = None
i = 0
while i < len(lines):
    st = lines[i].strip()
    if len(st) > 10 and set(st) == {'='}:
        j = i + 1
        # 吞掉这一组里所有连续的 ==== 行，取出夹在中间的 name
        name = None
        while j < len(lines):
            s2 = lines[j].strip()
            if len(s2) > 10 and set(s2) == {'='}:
                j += 1
                if name is not None:
                    break
                continue
            if name is None and s2:
                name = s2
                j += 1
                continue
            if name is not None:
                break
            j += 1
        if name:
            if name not in c:
                c[name] = 0; order.append(name)
            cur = name
        i = j
        continue
    if lines[i].startswith('  \u2713') and cur in c:
        c[cur] += 1
    i += 1
tot = 0
for k in order:
    print('%5d  %s' % (c[k], k[:52])); tot += c[k]
print('-' * 60)
print('%5d  合计' % tot)
