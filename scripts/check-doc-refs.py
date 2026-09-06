# -*- coding: utf-8 -*-
"""
文档反查：README 里提到的符号，源码里是否真的存在？

【与 audit-units.py 的关系】
  audit-units.py   源码导出 → 文档是否提到（查"漏写"）
  本脚本           文档提到 → 源码是否存在（查"编造"）

  两个方向都要有。漏写会被人发现（去看源码），
  **编造不会** —— 用户会照着文档写，然后静默算错。

【为什么叫"编造"】
历史上本库批量补文档时编过 5 处：
  - 实例方法写成静态
  - 字段名写成不存在的（p.name 实际是 p.setName）
  - 必填参数写成可选（quantity?）
  - 不存在的默认值
  - 从 1 计数写成从 0 计数（导致第一名显示成第 2 名）
这些都编译期查不出来。

【检查项】
  A. 反引号里的 `xxx(` / `.xxx(` —— 源码里完全找不到这个名字
  B. 反引号里的 `Xxx.yyy(` —— Xxx 存在但 yyy 不是它的成员

【已知误报（脚本已尽力过滤，但仍需人工判断）】
  - 业务侧回调名：createEnemy / showToast / loseLevel（用户自己实现的）
  - 示例里的虚构类：Bullet / Player
  - 跨模块合法引用：别的单元的方法
  - 内置方法：map / filter / push / forEach
  - **否定语境**：文档写「本模块没有 `xxx()`」时，xxx 当然不在源码里。
    脚本已检测否定语境（见 NEGATIVE 常量）并跳过。

用法：
  python3 scripts/check-doc-refs.py            全库
  python3 scripts/check-doc-refs.py collision   单单元
"""
import re, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 内置 & 常见业务回调（这些在文档里出现是合理的，源码里当然没有）
BUILTIN = {
    # JS/TS 内置
    'map','filter','forEach','push','pop','slice','splice','sort','find','findIndex',
    'some','every','includes','indexOf','join','split','concat','reduce','reverse',
    'keys','values','entries','has','get','set','delete','clear','add','size',
    'toFixed','toString','toJSON','parse','stringify','floor','ceil','round','abs',
    'min','max','sqrt','pow','random','now','log','warn','error','from','of',
    'then','catch','finally','next','bind','call','apply',
    # 典型业务回调（文档里常说"你实现这些"）
    'createEnemy','spawnEnemy','showToast','loseLevel','winLevel','onDeath','onHit',
    'onUpdate','onDamage','playSound','showDamage','makeEnemy','buildEnemy',
    'fireballAt','enemyHp','takeDamage','heal','die','respawn',
}

def strip_code_comments(s):
    s = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), s, flags=re.S)
    return re.sub(r'//[^\n]*', '', s)

def unit_dirs():
    out = []
    for d in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, d)
        if not os.path.isdir(p) or d.startswith('.'): continue
        if d in ('node_modules','scripts','tests','examples','typings'): continue
        if not any(f.endswith('.ts') for f in os.listdir(p)): continue
        out.append(d)
    return out

def source_text(unit):
    """该单元全部 .ts 源码（剥注释）"""
    buf = []
    d = os.path.join(ROOT, unit)
    for f in sorted(os.listdir(d)):
        if f.endswith('.ts'):
            buf.append(strip_code_comments(open(os.path.join(d,f), encoding='utf-8').read()))
    return '\n'.join(buf)

def doc_text(unit):
    d = os.path.join(ROOT, unit)
    return '\n'.join(
        open(os.path.join(d,f), encoding='utf-8').read()
        for f in sorted(os.listdir(d)) if f.endswith('.md')
    )

# 反引号内、形如 xxx( 或 .xxx( 或 Xxx.yyy(
CALL = re.compile(r'`([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\(')

# 否定语境：文档明确说"这个不存在"时，名字当然搜不到
#
# 【为什么需要】
# 本脚本第一次跑完，我们给每个编造项都补了警告，如：
#     > ⚠️ 本模块没有 `updateGlicko()` / `batchUpdate()`
# 结果复扫时它们**又全部被报出来**——脚本分不清
# "文档说有" 和 "文档说没有"。
# 这跟第 4 次踩的"两个口径打架"同源：只看符号出现，不看语境。
NEGATIVE = re.compile(
    r'(没有|不存在|未实现|从未|早期文档|曾经|旧版|已移除|不是|别用|不要用|'
    r'源码无|实际叫|真正叫|改为|改名|'
    # 反面示例语境：引用别人的 API 来说明"不这么做"
    r'手写的|手写 |Cocos 的|引擎|乱用|误用|别调|不要调)'
)

# 占位符写法（log.xxx 里的 xxx）——不是真实方法名，跳过
PLACEHOLDER = re.compile(r'(^|\.)(xxx|yyy|foo|bar|baz)$', re.I)

# 引擎/宿主 API —— 本库源码里当然没有
ENGINE = re.compile(r'^(director|cc|wx|window|document|console)\.' )

_ALL_SRC_CACHE = {}

def all_source():
    """全库源码（用于判断"是不是别的单元的方法"）"""
    if not _ALL_SRC_CACHE:
        for u in unit_dirs():
            _ALL_SRC_CACHE[u] = source_text(u)
    return _ALL_SRC_CACHE

def check_unit(unit):
    src = source_text(unit)
    doc = doc_text(unit)
    # 源码里所有出现过的标识符（宽松：只要名字出现过就算存在）
    defined = set(re.findall(r'[A-Za-z_][A-Za-z0-9_]*', src))

    rows = []
    seen = set()
    for m in CALL.finditer(doc):
        full = m.group(1)
        parts = full.split('.')
        leaf = parts[-1]
        owner = parts[-2] if len(parts) >= 2 else None

        if leaf in BUILTIN: continue
        if len(leaf) < 3: continue
        if PLACEHOLDER.search(leaf): continue
        if ENGINE.match(full): continue

        # 否定语境：这段话在说"这个东西不存在"，跳过
        ln_start = doc.rfind('\n', 0, m.start()) + 1
        ln_end = doc.find('\n', m.end())
        ctx = doc[max(0, m.start() - 200):m.start()] + doc[ln_start:ln_end if ln_end > 0 else len(doc)]
        if NEGATIVE.search(ctx):
            continue
        key = full
        if key in seen: continue
        seen.add(key)

        # A. 叶子名字在源码里完全不存在
        if leaf not in defined:
            # 是不是别的单元的方法？（跨模块引用是合法的）
            others = sorted(u for u, t in all_source().items()
                            if re.search(r'\b%s\b' % re.escape(leaf), t))
            others = [o for o in others if o != unit]
            if others:
                rows.append((unit, full, 'C-跨模块(需确认目标单元存在)', ','.join(others[:3])))
            else:
                rows.append((unit, full, 'A-名字不存在', owner or ''))
            continue
        # B. 有属主，且属主在源码里存在 —— 检查是不是真成员（宽松判断：属主名附近 2000 字符内有无叶子）
        if owner and owner in defined:
            idxs = [mm.start() for mm in re.finditer(r'\b%s\b' % re.escape(owner), src)]
            near = any(leaf in src[i:i+3000] for i in idxs) if idxs else False
            if not near:
                rows.append((unit, full, 'B-非该属主成员', owner))
    return rows

def main():
    args = sys.argv[1:]
    units = args if args else unit_dirs()
    allrows = []
    for u in units:
        if not os.path.isdir(os.path.join(ROOT,u)):
            print('  [跳过] 无此单元: %s' % u); continue
        allrows += check_unit(u)

    print('核对 %d 个单元\n' % len(units))
    if not allrows:
        print('[OK] 未发现文档引用了源码中不存在的符号')
        return 0

    byk = {}
    for r in allrows: byk.setdefault(r[2], []).append(r)
    for k in sorted(byk):
        print('=== %s（%d 处）===' % (k, len(byk[k])))
        for unit, full, kind, owner in byk[k]:
            print('  %-18s %s%s' % (unit, full, ('  [属主 %s]' % owner) if owner else ''))
        print()
    na = len(byk.get('A-名字不存在', []))
    print('合计 %d 处待人工确认（含已知误报类型，见文件头注释）' % len(allrows))
    print()
    if na:
        print('[FAIL] A 类 %d 处：文档引用了全库都找不到的符号。' % na)
        print('       这些最可能是"补文档时编造的 API"——照着写会直接报错，')
        print('       而用户会信以为真。请逐条核实后修正文档。')
        return 1
    print('[OK] 无 A 类问题（B/C 类为跨模块引用与静态成员，需人工确认）')
    return 0

if __name__ == '__main__':
    sys.exit(main())
