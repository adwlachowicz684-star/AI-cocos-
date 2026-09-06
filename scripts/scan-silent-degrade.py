# -*- coding: utf-8 -*-
"""
静默降级扫描器 —— 扫两类问题：

 A. 静默降级：if (有某物) 正确路径; else 用「错误的值」继续跑，且不报错
    典型：_toLocal() 里 if (ui) 坐标转换 else 用屏幕坐标

 B. 错误与空同值：catch 返回 X，正常路径的「未找到/空」也返回 X
    后果：调用方无法区分「没有数据」和「出错了」

【⚠️ 本项目踩过的坑，改这个脚本前请先读】
------------------------------------------------------------
 1. **剥注释必须保留换行**：
    `re.sub(r'/\*.*?\*/', '', s)` 会把多行注释压成一行，
    之后用它算出的行号全是错的。正确写法：
        re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), s)

 2. **匹配文本与算行号的文本必须是同一份**：
    用剥注释后的文本匹配、却用原始文本算行号（或反之），
    位置必然偏移。本项目已因此报错 3 次。

 3. **别用 `[^}]*` 提取代码块**：
    块内只要有一个 `}`（嵌套 if / 对象字面量）就被截断。
    要用大括号配平函数 block()。

 4. **返回类型是对象联合时函数头正则会失效**：
    `meta(slot): { v: number } | null {` 里的 `{` 会被
    `(?::\s*[^{]+?)?\{` 提前吃掉。已知漏检：save/meta()。

用法：
    python3 scripts/scan-silent-degrade.py
"""
import re, os, sys

def strip_comments(s):
    """删注释但【保留行数】——否则行号全错"""
    s = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), s, flags=re.S)
    s = re.sub(r'//[^\n]*', '', s)
    return s

def block(src, i):
    """从 '{' 开始配平提取块内容，返回 (内容, 结束位置)"""
    depth, j = 0, i
    while j < len(src):
        if src[j] == '{': depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0: return src[i+1:j], j
        j += 1
    return src[i+1:], len(src)

def sources(root='.'):
    out = []
    for d in sorted(os.listdir(root)):
        if d.startswith('.') or d in ('node_modules','scripts','tests','examples','typings'): continue
        if not os.path.isdir(d): continue
        for f in sorted(os.listdir(d)):
            if f.endswith('.ts'): out.append(os.path.join(d, f))
    return out

# ---------------- A. 错误与空同值 ----------------
EMPTY = re.compile(r'\breturn\s+(null|undefined|0|false|\[\]|\{\}|-1|""|\'\'|fallback)\s*;')

def scan_same_value(paths):
    rows = []
    for path in paths:
        raw = open(path, encoding='utf-8').read()
        src = strip_comments(raw)
        for fm in re.finditer(
            r'(?:async\s+)?(?:(?:private|public|protected)\s+)?(?:get\s+|set\s+)?'
            r'(\w+)\s*(?:<[^>]*>)?\s*\([^)]{0,140}\)\s*(?::\s*[^{]+?)?\{', src):
            name = fm.group(1)
            if name in ('if','for','while','switch','catch','constructor','function'): continue
            body, _ = block(src, fm.end()-1)
            if len(body) > 8000: continue
            cv = set()
            for cm in re.finditer(r'catch\s*(?:\(\s*\w+\s*\))?\s*\{', body):
                cb, _ = block(body, cm.end()-1)
                for mm in EMPTY.finditer(cb): cv.add(mm.group(1))
            if not cv: continue
            nb = re.sub(r'try\s*\{', '', body)
            nb = re.sub(r'\}\s*catch\s*(?:\(\s*\w+\s*\))?\s*\{[^{}]*\}', '', nb)
            nv = set(mm.group(1) for mm in EMPTY.finditer(nb))
            hit = sorted(cv & nv)
            if hit:
                rows.append((path, name, src[:fm.start()].count('\n')+1, hit))
    return rows

def main():
    paths = sources()
    print('扫描 %d 个源文件\n' % len(paths))
    rows = scan_same_value(paths)
    print('=== 「错误」与「空」返回同一个值（%d 处）===\n' % len(rows))
    for p, n, ln, v in rows:
        print('  %-36s %-16s 行%-5d 同值: %s' % (p, n+'()', ln, ', '.join(v)))
    print('\n【已知漏检】返回类型是对象联合的函数（如 save/meta()）')
    print('  原因见文件头注释第 4 条 —— 需人工核对')

if __name__ == '__main__':
    main()
