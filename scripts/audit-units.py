#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
119 个单元全量体检（只读扫描，不改任何文件）

用法：
    python3 scripts/audit-units.py            # 打印摘要
    python3 scripts/audit-units.py --md       # 输出 Markdown 报告到 审查报告.md
    python3 scripts/audit-units.py --json     # 输出 JSON（供后续脚本消费）

【它查什么】
    ① 完整性   —— 有实现没测试？没 README？没登记？
    ② 一致性   —— kitmeta 登记的 depends / layer 与源码实际 import 对不对得上
    ③ 文档对齐 —— README 里写的类名、方法名，源码里真的有吗（反过来也算）
    ④ 代码信号 —— TODO / as any / 空 catch / console.log / 未实现占位
    ⑤ 覆盖     —— 在 tests/ 与 examples/ 里是否被真正用到

【它不做什么】
    不做判断，只报事实。可疑项要人去看。
    —— 自动扫描给出的"可疑"里一定有误报，误报也要一条条过，
       否则这个报告的信用就完了。
"""

import os
import re
import json
import sys
import collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXCLUDE = {'.build', 'node_modules', '.git', 'scripts', 'examples', 'tests', 'typings'}
EXCLUDE_PFX = ('.build.',)

# ==================== 收集 ====================


def load_kitmeta():
    with open(os.path.join(ROOT, '_kitmeta.json'), encoding='utf-8') as f:
        return json.load(f)


def scan_unit_files(d):
    """目录下所有 .ts（排除测试/示例）"""
    out = []
    base = os.path.join(ROOT, d)
    for r, dn, fn in os.walk(base):
        dn[:] = [x for x in dn if x not in {'.git', 'node_modules'}]
        for x in fn:
            if x.endswith('.ts') and not x.endswith('.d.ts'):
                out.append(os.path.join(r, x))
    return out


def read(p):
    try:
        with open(p, encoding='utf-8') as f:
            return f.read()
    except Exception:
        return ''


# ---- 源码里导出的公开符号 ----
RE_EXPORT = re.compile(
    r'^\s*export\s+(?:declare\s+)?'
    r'(?:abstract\s+|default\s+)?'
    r'(class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)',
    re.M)

# ---- 类里的公开方法 ----
#
# 【⚠️ 踩过的坑：泛型方法匹配不上】
# 原正则 `\(\) 前面直接跟方法名`，而 TS 的泛型方法长这样：
#
#     map<U>(fn: (v: T) => U): Result<U, E> {
#     mapErr<F>(_fn: (e: E) => F): Result<T, F> {
#
# 方法名和 `(` 之间多了 `<U>`，于是全部匹配失败。
# 后果：`result` 单元报"README 提到 mapErr/flatMap 但源码找不到"——
# 实际上两个方法都在，是脚本瞎了。
#
# **误报会摧毁报告的信用**，一条条核实才发现。
#
# 【⚠️ 踩过的坑之三：private 方法也被当成公开 API】
#
# 第六批核对时 `loot` 报「removeZeroWeights 未文档化」，
# 查下去才发现它是 `private removeZeroWeights()` —— **用户根本调不到**。
#
# 私有方法不写进文档是对的，把它们算进来，
# 会让"未文档化"这项永远清不干净——而清不干净的检查会被人忽略。
#
# 【⚠️ 坑之二：非导出类的方法也算公开 API】
# `dungeon` 的 `class Rng`（不带 export）、`collision` 的 `pushAxes`（file-scope）
# 同理，它们本就不该出现在文档里。
#
# 修法同审计脚本：只看**导出类**行范围内、且**不带 private** 的方法。
RE_METHOD = re.compile(r'^\s{2,4}(?:public\s+)?'
                       r'(?:static\s+)?'
                       r'(?:get\s+|set\s+)?'
                       r'([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\([^;]*?\)'
                       r'\s*(?::\s*[^{]+)?\{',
                       re.M)

RE_PRIVATE = re.compile(r'^\s{2,4}private\s+(?:static\s+)?(?:get\s+|set\s+)?'
                        r'([A-Za-z_$][\w$]*)', re.M)

# ---- 源码里的 import ----
RE_IMPORT = re.compile(r"from\s+['\"](\.\.?/[^'\"]+)['\"]")

# ---- 可疑信号 ----
SIGNALS = [
    ('TODO/FIXME', re.compile(r'(TODO|FIXME|XXX|HACK)\b'), 'warn'),
    ('as any', re.compile(r'\bas\s+any\b'), 'warn'),
    ('@ts-ignore', re.compile(r'@ts-ignore'), 'warn'),
    ('空 catch', re.compile(r'catch\s*\([^)]*\)\s*\{\s*\}'), 'error'),
    ('console.log', re.compile(r'console\.(log|warn|error|debug)\s*\('), 'info'),
    ('未实现占位', re.compile(r'(throw\s+new\s+Error\(\s*[\'"`]'
                              r'(?:未实现|not implemented|Not implemented))'), 'error'),
    ('空方法体', re.compile(r'\)\s*:\s*[\w<>\[\]| ]+\s*\{\s*\}\s*$', re.M), 'info'),
]


def plugin_of_import(unit_dir, src_file, spec):
    """import 相对路径 → 插件名（跨目录才算依赖）"""
    abs_dir = os.path.dirname(src_file)
    target = os.path.normpath(os.path.join(abs_dir, spec))
    rel = os.path.relpath(target, ROOT)
    parts = rel.split(os.sep)
    if len(parts) < 2:
        return None              # 目录内/根目录
    top = parts[0]
    if top in ('typings',):
        return None
    return None if top == unit_dir else top


def analyze(unit, all_names):
    d = unit['dir']
    files = scan_unit_files(d)
    srcs = [(p, read(p)) for p in files]
    code = '\n'.join(s for _, s in srcs)
    nline = sum(s.count('\n') + 1 for _, s in srcs)

    # README
    #
    # 【⚠️ 一个目录可能有多份文档】
    # 已知两例：`input/` 有 `README_InputBuffer.md`，
    #          `camera/` 有 `CameraFollow.md`。
    # 只扫 README.md 的话，另一半内容等于不存在——
    # 于是报出"CoyoteTimer 未文档化"这种假信号。
    #
    # 顺便这也是个真问题的探针：**多文档目录必须互相索引**，
    # 否则读者只看主 README 会以为那部分功能没有文档。
    readme_p = os.path.join(ROOT, d, 'README.md')
    has_readme = os.path.exists(readme_p)
    readme = read(readme_p) if has_readme else ''
    extra_docs = []
    if os.path.isdir(os.path.join(ROOT, d)):
        for x in sorted(os.listdir(os.path.join(ROOT, d))):
            if x.endswith('.md') and x != 'README.md':
                extra_docs.append(x)
                readme += '\n' + read(os.path.join(ROOT, d, x))
    # 多文档互相索引
    mutual_link = True
    if extra_docs:
        main = read(readme_p)
        main_links = any(x in main for x in extra_docs)
        sub_links = all('README.md' in read(os.path.join(ROOT, d, x))
                        for x in extra_docs)
        mutual_link = main_links and sub_links
    nline_readme = readme.count('\n') + 1 if readme else 0

    # 导出的公开符号
    exported = set()
    for m in RE_EXPORT.finditer(code):
        exported.add(m.group(2))

    # 源码里的公开方法
    #
    # 【⚠️ 踩过的坑：非导出的类/函数也被当成公开 API】
    # 第三批核对时发现 `dungeon` 报"next/int/pick/shuffle 四项未文档化"，
    # 查下去才发现它们属于 `class Rng`（**不带 export**，module 内部私有）；
    # `collision` 的 `pushAxes` 同样是 file-scope 的私有函数。
    #
    # 它们本来就不该出现在文档里。把它们算进来，
    # 会让"未文档化"这项永远清不干净——**而清不干净的报告会被人忽略**。
    #
    # 修法：先求出导出类的行范围，只统计落在范围内的缩进方法。
    lines = code.split('\n')
    exported_classes = set(re.findall(
        r'^export (?:abstract )?class\s+([A-Za-z_$][\w$]*)', code, re.M))
    exported_funcs = set(re.findall(
        r'^export function\s+([A-Za-z_$][\w$]*)', code, re.M))
    # 导出类的行区间 [start, end)
    spans = []
    cur = None
    for i, ln in enumerate(lines):
        m = re.match(r'^export (?:abstract )?class\s+([A-Za-z_$][\w$]*)', ln)
        if m:
            cur = (i, m.group(1))
            continue
        if cur is not None and re.match(r'^}\s*$', ln):
            spans.append((cur[0], i + 1, cur[1]))
            cur = None
    def in_exported_class(idx):
        return any(a <= idx < b for a, b, _ in spans)
    privates = set(RE_PRIVATE.findall(code))
    methods = set()
    for m in RE_METHOD.finditer(code):
        ln_no = code[:m.start()].count('\n')
        if in_exported_class(ln_no) and m.group(1) not in privates:
            methods.add(m.group(1))

    # README 里提到的标识符（反引号包裹的 + 裸词）
    readme_ids = set(re.findall(r'`([A-Za-z_$][\w$]*)`', readme))
    readme_ids |= set(re.findall(r'\b([A-Za-z_$][\w$]*)\s*\(', readme))

    # README 写了但源码没有（排除常见非标识符误命中）
    NOISE = {'ts', 'js', 'md', 'json', 'npm', 'node', 'bash', 'sh', 'cc',
             'true', 'false', 'null', 'undefined', 'new', 'if', 'for',
             'return', 'const', 'let', 'var', 'function', 'class', 'import',
             'export', 'from', 'type', 'interface', 'enum', 'extends',
             'implements', 'of', 'in', 'as', 'is', 'it', 'this', 'dt',
             'number', 'string', 'boolean', 'void', 'any', 'Array', 'Map',
             'Set', 'Promise', 'Error', 'Math', 'Object', 'JSON', 'Date'}
    missing_in_src = sorted(
        x for x in readme_ids
        if x not in exported and x not in methods
        and x not in NOISE and len(x) > 2
        and not x.islower()          # 全小写多半是参数名/变量名
    )

    # 源码导出但 README 没提
    #
    # 【为什么分级】type / interface / enum / const 里有大量内部类型
    #    （如 `ICastContext`、`EasingFn`），README 不提是正常的。
    #    真正必须出现在文档里的是 class 和 function——那是用户要 new / 要调的东西。
    kinds = {}
    for m in RE_EXPORT.finditer(code):
        kinds[m.group(2)] = m.group(1)
    un_documented = sorted(
        x for x in exported
        if x not in readme and len(x) > 2 and kinds.get(x) in ('class', 'function')
    )

    # 【⚠️ 曾经的盲点：只查导出的 class/function，不查类的方法】
    #
    # 这导致"全库 API 缺口 0"的结论是错的——
    # 它只说明"要 new 的类、要直接调的函数"都提到了，
    # 而 `new Foo().bar()` 里的 `bar` 一个都没查。
    #
    # 发现经过：第十九批审查时单独跑 audit-one.py，
    # 看到 reddot 报 `clear` / `clearAll` / `own` 未文档化，
    # 而 audit-units.py 说 reddot 缺口 0。
    #
    # 实测全库类方法缺口 208 项 / 49 个单元——
    # **是已统计口径的 10 倍量级**。
    #
    # 方法名的提取与 audit-one.py【B 节】保持一致：
    # 缩进两格（类内）、非 private、非 _ 开头。
    _METHOD_NOISE = {'for','if','switch','return','while','constructor','get','set'}

    # 【⚠️ 踩过的坑之五：方法提取口径与 audit-one.py 不一致】
    #
    # 初版只扫"缩进两格 + 带括号"，不判断该方法属于哪个类，
    # 于是 dungeon 内部 `class Rng`（**非 export**）的 next/pick/shuffle、
    # attack-token 的 `DefaultRandom`、affix 的同名类，全被算成公开 API。
    #
    # 症状：audit-one.py 说 dungeon 缺口 0，audit-units.py 说 3。
    # 两个脚本打架 —— 和当初 elo 那次是同一类问题。
    #
    # 修法：与 audit-one.py 对齐，只统计【export class 体内】的方法。
    def _export_class_spans(src):
        spans = []
        cur = None
        for i, ln in enumerate(src.split('\n')):
            if re.match(r'^export (?:abstract )?class\s+[A-Za-z_$]', ln):
                cur = i
                continue
            if cur is not None and re.match(r'^\}\s*$', ln):
                spans.append((cur, i + 1))
                cur = None
        return spans

    _spans = _export_class_spans(code)
    all_methods = set()
    # 【⚠️ 踩过的坑之七：protected 也算进来了】
    # 正则里写了 `(?:protected\s+)?` 这个可选分支，
    # 但那只是"允许匹配"，并没有"匹配到就跳过"。
    # 于是 attack-token 的 `protected get rng()`、
    # wave-spawner 的 `rng` 被当成公开 API 报出来 ——
    # 而 audit-one.py 的正则根本不含 protected 分支，压根不会匹配。
    # 又一次两脚本口径不一致。
    #
    # protected 是给子类用的，不是给用户用的，不该要求文档化。
    for _m in re.finditer(
            r'^  (?:public\s+|protected\s+)?(?:get\s+|set\s+)?'
            r'([a-zA-Z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\([^)]*\)', code, re.M):
        _n = _m.group(1)
        if _n in _METHOD_NOISE or _n.startswith('_'):
            continue
        # 取该行原文，判断修饰符
        _raw = code.split('\n')[code[:_m.start()].count('\n')]
        if re.search(r'\bprotected\b', _raw):
            continue
        # 与 audit-one.py 的 in_ec 同口径：只算 export class 内的
        #
        # 【⚠️ 踩过的坑之六：行号与字符偏移混用】
        # 初版写成 `_a <= _m.start() < _b`，
        # 而 _spans 存的是**行号**、_m.start() 是**字符偏移** —— 两个量纲不同。
        # 结果所有方法都被判为"不在 export class 内"，缺口直接变成 0，
        # 看上去像"全部补齐了"，实际是检查彻底失效。
        # 这种"越修数字越漂亮"的失败最危险，所以必须额外核对总数。
        _ln = code[:_m.start()].count('\n')
        if not any(_a <= _ln < _b for _a, _b in _spans):
            continue
        # @internal 标注的方法跳过（实现非导出接口的，用户不需要知道）
        _head = '\n'.join(code.split('\n')[max(0, _ln - 12):_ln])
        if '@internal' in _head:
            continue
        all_methods.add(_n)
    un_documented_methods = sorted(
        m for m in all_methods if m not in readme and len(m) > 2
    )
    un_documented_types = sorted(
        x for x in exported
        if x not in readme and len(x) > 2 and kinds.get(x) not in ('class', 'function')
    )

    # 实际 import 出的插件依赖
    actual_deps = set()
    for p, s in srcs:
        s2 = re.sub(r'/\*[\s\S]*?\*/', '', s)          # 去块注释
        s2 = re.sub(r'(^|\s)//[^\n]*', '$1', s2)       # 去行注释
        for m in RE_IMPORT.finditer(s2):
            pl = plugin_of_import(d, p, m.group(1))
            if pl:
                actual_deps.add(pl)

    declared = set(unit.get('depends') or [])
    # L0 基础设施（_core / ds 及其子路径）单独归一类。
    #
    # 【为什么拆开】全库 72 个单元的 depends 是空的，而它们实际都 import 了 _core。
    #    混在一起统计的话，46 个单元会同时命中"依赖不符"，
    #    真正重要的信号（非 L0 的前置模块没登记）就被淹没了。
    L0 = {'_core', 'ds'}
    def is_l0(x):
        return x.split('/')[0] in L0
    dep_missing_l0 = sorted(x for x in actual_deps - declared if is_l0(x))
    dep_missing_key = sorted(x for x in actual_deps - declared if not is_l0(x))
    dep_ghost = sorted(x for x in declared - actual_deps)   # 登记了但源码没有

    # 可疑信号
    sig = []
    for label, rx, sev in SIGNALS:
        hits = []
        for p, s in srcs:
            s2 = re.sub(r'/\*[\s\S]*?\*/', '', s)
            s2 = re.sub(r'(^|\s)//[^\n]*', '$1', s2)
            for i, line in enumerate(s2.split('\n'), 1):
                if rx.search(line):
                    hits.append((os.path.relpath(p, ROOT), i))
        if hits:
            sig.append({'label': label, 'severity': sev, 'count': len(hits),
                        'where': hits[:5]})

    return {
        'name': unit['name'],
        'dir': d,
        'layer': unit.get('layer', '?'),
        'domain': unit.get('domain', '?'),
        'purpose': unit.get('purpose', ''),
        'maturity': unit.get('maturity', '?'),
        'files': len(files),
        'lines': nline,
        'readme': has_readme,
        'readme_lines': nline_readme,
        'extra_docs': extra_docs,
        'mutual_link': mutual_link,
        'exported': sorted(exported),
        'methods': len(methods),
        'missing_in_src': missing_in_src[:12],
        'undocumented': un_documented[:12],
        'undocumented_methods': un_documented_methods,
        'method_count': len(all_methods),
        'undocumented_types': un_documented_types[:12],
        'declared_deps': sorted(declared),
        'actual_deps': sorted(actual_deps),
        'dep_missing_l0': dep_missing_l0,
        'dep_missing_key': dep_missing_key,
        'dep_ghost': dep_ghost,
        'dep_delta': dep_missing_key + dep_ghost,
        'signals': sig,
        'hasTest': unit.get('hasTest'),
        'hasDemo': unit.get('hasDemo'),
    }


# ==================== 覆盖率 ====================

def coverage(all_names):
    """tests/ 与 examples/ 里各单元被 import 的次数"""
    tests, examples = collections.Counter(), collections.Counter()
    for sub, ctr in (('tests', tests), ('examples', examples)):
        base = os.path.join(ROOT, sub)
        if not os.path.isdir(base):
            continue
        for fn in os.listdir(base):
            if not fn.endswith('.ts'):
                continue
            s = read(os.path.join(base, fn))
            s = re.sub(r'/\*[\s\S]*?\*/', '', s)
            s = re.sub(r'(^|\s)//[^\n]*', '$1', s)
            for m in re.finditer(r"from\s+['\"](\.\.?/[^'\"]+)['\"]", s):
                parts = os.path.normpath(m.group(1)).split(os.sep)
                # ../xx/YY or ./xx
                for seg in parts:
                    if seg in all_names or seg in all_names:
                        ctr[seg] += 1
    return tests, examples


# ==================== 主流程 ====================

def main():
    meta = load_kitmeta()
    units = meta['plugins']
    all_names = {u['dir'] for u in units} | {u['name'] for u in units}

    rows = []
    for u in units:
        try:
            rows.append(analyze(u, all_names))
        except Exception as e:                       # 不让一个单元拖垮全局
            rows.append({'name': u['name'], 'dir': u['dir'], 'error': str(e)})

    tests_ctr, ex_ctr = coverage(all_names)
    for r in rows:
        r['test_refs'] = tests_ctr.get(r['dir'], 0) + tests_ctr.get(r['name'], 0)
        r['example_refs'] = ex_ctr.get(r['dir'], 0) + ex_ctr.get(r['name'], 0)

    # ---- 风险分级 ----
    for r in rows:
        if 'error' in r:
            r['risk'] = 'ERROR'
            r['issues'] = ['扫描异常: ' + r['error']]
            continue
        iss = []
        if not r['readme']:
            iss.append('无 README')
        if r['extra_docs'] and not r['mutual_link']:
            iss.append('★多份文档未互相索引: ' + ', '.join(r['extra_docs']))
        elif r['readme_lines'] < 30:
            iss.append(f'README 仅 {r["readme_lines"]} 行')
        if not r['test_refs']:
            iss.append('测试未引用')
        if r['dep_missing_key']:
            iss.append('★前置依赖未登记: ' + ', '.join(r['dep_missing_key']))
        if r['dep_ghost']:
            iss.append('登记了但源码没 import: ' + ', '.join(r['dep_ghost']))
        if r['dep_missing_l0']:
            iss.append('依赖 _core 未登记（全库普遍，低优先级）')
        if r['missing_in_src']:
            iss.append(f'README 提到但源码找不到 {len(r["missing_in_src"])} 项')
        if r['undocumented']:
            iss.append(f'★{len(r["undocumented"])} 个 class/function README 未提')
        if r['lines'] < 60:
            iss.append(f'源码仅 {r["lines"]} 行（可能是占位）')
        for s in r['signals']:
            if s['severity'] == 'error':
                iss.append(f"{s['label']} ×{s['count']}")
        r['issues'] = iss
        # 分级：★ 项 / 硬缺失（无 README、无测试）算数，
        #       "依赖 _core 未登记"这种全库普遍的不计入
        hard = sum(1 for i in iss if i.startswith('★') or
                   i in ('无 README', '测试未引用') or
                   i.startswith('README 仅') or i.startswith('源码仅') or
                   i.startswith('★'))
        soft = sum(1 for i in iss if not (i.startswith('★') or
                   i in ('无 README', '测试未引用') or
                   i.startswith('README 仅') or i.startswith('源码仅') or
                   '全库普遍' in i))
        r['risk'] = ('高' if hard >= 2 else
                     '中' if hard == 1 or soft >= 2 else '低')

    if '--json' in sys.argv:
        # 中间产物放 .build/ 下（已被 .gitignore 覆盖），不污染仓库根目录
        _out = os.path.join(ROOT, '.build', 'audit.json')
        os.makedirs(os.path.dirname(_out), exist_ok=True)
        with open(_out, 'w', encoding='utf-8') as f:
            json.dump(rows, f, ensure_ascii=False, indent=1)
        print('已写出 ' + os.path.relpath(_out, ROOT))
        return

    order = {'高': 0, '中': 1, '低': 2, 'ERROR': -1}
    rows.sort(key=lambda r: (order.get(r['risk'], 9), r['dir']))

    if '--md' in sys.argv:
        emit_md(rows, meta)
        return

    # 终端摘要
    cnt = collections.Counter(r['risk'] for r in rows)
    print('=' * 60)
    print('单元体检：%d 个' % len(rows))
    for k in ('ERROR', '高', '中', '低'):
        if cnt.get(k):
            print('  %-5s %d 个' % (k, cnt[k]))
    print('=' * 60)
    print()
    for r in rows:
        if r['risk'] in ('ERROR', '高', '中'):
            print('[%s] %-16s %-3s %s 行 · 测试引用 %d · 示例引用 %d'
                  % (r['risk'], r['dir'], r.get('layer', '?'),
                     r.get('lines', 0), r.get('test_refs', 0),
                     r.get('example_refs', 0)))
            for i in r['issues']:
                print('        - ' + i)
    print()
    print('（--md 输出完整报告；--json 输出结构化数据）')


def emit_md(rows, meta):
    out = []
    out.append('# 单元体检报告')
    out.append('')
    out.append('> 由 `python3 scripts/audit-units.py --md` 生成，**只读扫描，不改任何文件**。')
    out.append('>')
    out.append('> ⚠️ **自动扫描一定有误差。** "README 提到但源码找不到"这类')
    out.append('> 常把参数名、示例里的虚构类名算进去；"导出符号 README 未提"')
    out.append('> 也可能只是内部类型。可疑项必须人去看，不能直接当结论。')
    out.append('')
    cnt = collections.Counter(r['risk'] for r in rows)
    out.append('| 风险 | 数量 |')
    out.append('|---|---|')
    for k in ('ERROR', '高', '中', '低'):
        if cnt.get(k):
            out.append('| %s | %d |' % (k, cnt[k]))
    out.append('')
    out.append('**审查进度**：见文末「逐个审查记录」。')
    out.append('')
    out.append('---')
    out.append('')

    out.append('## 需要人看的（高 + 中 + ERROR）')
    out.append('')
    out.append('| 单元 | 层 | 域 | 源码行 | 测试引用 | 示例引用 | 问题 |')
    out.append('|---|---|---|---|---|---|---|')
    for r in rows:
        if r['risk'] in ('高', '中', 'ERROR'):
            out.append('| `%s` | %s | %s | %s | %s | %s | %s |' % (
                r['dir'], r.get('layer', '?'), r.get('domain', '?'),
                r.get('lines', '?'), r.get('test_refs', '?'),
                r.get('example_refs', '?'),
                '<br>'.join(r['issues']) or '—'))
    out.append('')
    out.append('---')
    out.append('')

    out.append('## 全部单元一览')
    out.append('')
    out.append('| # | 单元 | 层 | 域 | 文件 | 源码行 | README 行 | 导出 | 测试 | 示例 | 风险 |')
    out.append('|---|---|---|---|---|---|---|---|---|---|---|')
    for i, r in enumerate(rows, 1):
        if 'error' in r:
            out.append('| %d | `%s` | | | | | | | | | ERROR |' % (i, r['dir']))
            continue
        out.append('| %d | `%s` | %s | %s | %d | %d | %s | %d | %s | %s | %s |' % (
            i, r['dir'], r['layer'], r['domain'], r['files'], r['lines'],
            r['readme_lines'] if r['readme'] else '—',
            len(r['exported']),
            r['test_refs'] or '—', r['example_refs'] or '—', r['risk']))
    out.append('')
    out.append('---')
    out.append('')
    #
    # 【⚠️ 踩过的坑：--md 曾把人工记录整段清空】
    # 第五批时重新生成，把前几批人工填写的审查记录覆盖成了空表格。
    # 代码改动还在，记录没了——等于白审。
    #
    # 原则：**生成的文件不能手写，手写的文件不能被生成覆盖。**
    # 所以人工记录移到了 `审查记录.md`，这里只放索引。
    out.append('## 逐个审查记录')
    out.append('')
    out.append('> **人工记录在 [`审查记录.md`](./审查记录.md)，不在本文件。**')
    out.append('>')
    out.append('> 本文件由 `scripts/audit-units.py --md` **自动生成**，')
    out.append('> 重跑会覆盖全部内容——**不要在这里手写任何东西**。')
    out.append('')

    p = os.path.join(ROOT, '审查报告.md')
    with open(p, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))
    print('已写出 %s（%d 行）' % (p, len(out)))


if __name__ == '__main__':
    main()
