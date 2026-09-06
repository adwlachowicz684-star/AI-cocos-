# -*- coding: utf-8 -*-
"""审查单个单元：输出源码真实 API vs 文档的完整对照

用法：python3 scripts/audit-one.py <目录名>
输出：事实清单（供人工/子代理判断，不代替判断）
"""
import re, os, sys

NOISE = {'for','if','switch','return','while','constructor','get','set'}

def api_of(d):
    src = ''
    for fn in sorted(os.listdir(d)):
        if fn.endswith('.ts'):
            src += open(os.path.join(d, fn), encoding='utf-8').read() + '\n'
    # 导出类的行范围（不含非 export 的私有类）
    lines = src.split('\n')
    spans, cur = [], None
    for i, ln in enumerate(lines):
        m = re.match(r'^export (?:abstract )?class\s+([A-Za-z_$][\w$]*)', ln)
        if m:
            cur = i; continue
        if cur is not None and re.match(r'^\}\s*$', ln):
            spans.append((cur, i + 1)); cur = None
    def in_ec(idx):
        return any(a <= idx < b for a, b in spans)
    # private / protected 不是公开 API，不能算进来
    # （踩过：loot 的 `removeZeroWeights` 是 private，却一直报"未文档化"）
    RE = re.compile(r'^  (?:public )?(?:get |set )?([a-zA-Z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\(', re.M)
    # 【⚠️ 踩过的坑之四：实现内部接口的公开方法也算进来了】
    # `observable/Computed.onRead` 实现的是**非导出**的 `Collector` 接口，
    # 语法上是 public，但用户根本不需要知道它是怎么收集依赖的。
    #
    # 约定：这类方法在 JSDoc 里写 `@internal`，脚本跳过。
    # 比在脚本里硬编码"排除 onRead"通用——下一个类似方法不用再改脚本。
    methods = []
    for m in RE.finditer(src):
        ln_no = src[:m.start()].count('\n')
        if not in_ec(ln_no):
            continue
        # 往上找最近的 JSDoc 块，看有没有 @internal
        head = '\n'.join(src.split('\n')[max(0, ln_no - 12):ln_no])
        if '@internal' in head:
            continue
        methods.append(m.group(1))
    return {
        'classes':  re.findall(r'^export (?:abstract )?class\s+([A-Za-z_$][\w$]*)', src, re.M),
        'funcs':    re.findall(r'^export function\s+([A-Za-z_$][\w$]*)', src, re.M),
        'types':    re.findall(r'^export (?:interface|type|enum)\s+([A-Za-z_$][\w$]*)', src, re.M),
        'consts':   re.findall(r'^export const\s+([A-Za-z_$][\w$]*)', src, re.M),
        'methods':  [m for m in dict.fromkeys(methods)],
        'src':      src,
    }

def docs_of(d):
    out = []
    for fn in sorted(os.listdir(d)):
        if fn.endswith('.md'):
            out.append((fn, open(os.path.join(d, fn), encoding='utf-8').read()))
    return out

d = sys.argv[1]
a = api_of(d)
docs = docs_of(d)
doc = '\n'.join(t for _, t in docs)
src = a['src']

print('=' * 62)
print('单元：%s' % d)
print('文档文件：%s' % ', '.join(f for f, _ in docs))
print('=' * 62)

print('\n【A. 顶层导出 —— 用户直接 import 的，最优先核对】')
for kind, key in [('class','classes'), ('function','funcs'),
                  ('type/interface/enum','types'), ('const','consts')]:
    items = a[key]
    if not items: continue
    print('\n  %s (%d):' % (kind, len(items)))
    for n in items:
        print('    %-26s %s' % (n, '✓ 文档有' if n in doc else '✗ 文档无'))

print('\n【B. 导出类的公开方法】')
miss = [m for m in a['methods'] if m not in NOISE and m not in doc and not m.startswith('_')]
print('  共 %d 个，其中 %d 个文档未提' % (len(a['methods']), len(miss)))
if miss:
    for m in miss:
        g = re.search(r'^  (?:public )?(?:get )?(?:set )?' + re.escape(m) +
                      r'\s*(?:<[^<>]*>)?\s*(\([^)]*\))?\s*(?::\s*([^{]+))?\{', src, re.M)
        print('    ✗ %-22s %s' % (m, (g.group(0).strip()[:56] if g else '')))

print('\n【C. 文档提到但源码找不到 —— 可能是文档漂移】')
names = set(re.findall(r'`([A-Za-z_$][\w$]{2,})`', doc))
names |= set(re.findall(r'\b([a-z][A-Z][A-Za-z]{3,})\b', doc))
NOISE2 = NOISE | {'true','false','null','undefined','number','string','boolean',
                  'readonly','export','import','class','function','interface',
                  'const','let','var','return','typeof','new','this','void',
                  'Math','JSON','Object','Array','Map','Set','Promise','Error'}
fake = sorted(n for n in names
              if n not in src and n not in NOISE2 and '_' not in n[:1])
print('  %d 项：' % len(fake))
for n in fake:
    hit = next((ln.strip()[:74] for ln in doc.split('\n') if '`%s' % n in ln), '')
    print('    %-24s | %s' % (n, hit))

print('\n【D. 目录内文档互相索引】')
if len(docs) > 1:
    for f, _ in docs:
        refs = [g for g, _ in docs if g != f and g in open(os.path.join(d, f), encoding='utf-8').read()]
        print('  %-24s → %s' % (f, refs or '（无）'))
else:
    print('  （单文档）')
print()
