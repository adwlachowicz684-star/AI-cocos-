# -*- coding: utf-8 -*-
"""
生成 cocos-kit 插件脑图（Markdown 缩进列表）

结构规则：
  1. 依赖前置：被依赖者为父节点，依赖它的单元挂在它下面
  2. 相互组合的多组合并为「功能模块」大节点
  3. 每个单元下：作用 / 功能 / 前置依赖 / 接口（接口再分方法子节点）
"""
import json, os, re, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP = {'.build','node_modules','tests','examples','scripts','typings','.git'}
MAXM = 10   # 每个 class 最多列的方法数
MAXT = 8    # 每个单元最多列的类型数

meta = json.load(open(os.path.join(ROOT,'_kitmeta.json'), encoding='utf-8'))
plugins = meta['plugins']


# ==================== 0. 源码扫描（自包含，不依赖外部产出） ====================
def strip_c(s):
    return re.sub(r'/\*[\s\S]*?\*/', '', re.sub(r'(^|\s)//[^\n]*', r'\1', s))


def class_body(src, at):
    """从 at 处向后找 { ，返回 (体起始, 体结束)；找不到返回 (None,None)"""
    i = src.find('{', at)
    if i < 0: return (None, None)
    d, j = 0, i
    while j < len(src):
        if src[j] == '{': d += 1
        elif src[j] == '}':
            d -= 1
            if d == 0: return (i + 1, j)
        j += 1
    return (None, None)


def methods_of(body):
    out = []
    re_m = re.compile(
        r'^\s{0,4}(?:(public|private|protected)\s+)?'
        r'(?:static\s+|async\s+|override\s+)*?(?:get\s+|set\s+)?'
        r'([a-zA-Z_][\w$]*)\s*(?:<[^>]*>)?\s*\(', re.M)
    for m in re_m.finditer(body):
        if m.group(1) in ('private', 'protected'): continue
        n = m.group(2)
        if n in ('if','for','while','switch','catch','return','typeof','new',
                 'function','constructor','super'): continue
        if n not in out: out.append(n)
    return out


def scan_api():
    res = {}
    for d in sorted(os.listdir(ROOT)):
        dp = os.path.join(ROOT, d)
        if d in SKIP or d.startswith('.') or not os.path.isdir(dp): continue
        info = {'classes': [], 'functions': [], 'types': [], 'consts': []}
        for f in sorted(os.listdir(dp)):
            if not f.endswith('.ts') or f.endswith('.d.ts'): continue
            s = strip_c(open(os.path.join(dp, f), encoding='utf-8').read())
            for m in re.finditer(
                r'export\s+(?:abstract\s+|declare\s+)?'
                r'(class|interface|type|function|const|enum)\s+([A-Za-z_][\w$]*)', s):
                kind, name, at = m.group(1), m.group(2), m.end()
                if kind == 'class':
                    b, e = class_body(s, at)
                    info['classes'].append(
                        {'name': name, 'methods': methods_of(s[b:e]) if b else []})
                elif kind == 'function': info['functions'].append(name)
                elif kind in ('const', 'enum'): info['consts'].append(name)
                else: info['types'].append(name)
        res[d] = info
    return res


api = scan_api()
dirs = {u['dir'] for u in plugins}

# ==================== 1. 实际依赖（扫描 import） ====================
def imports_of(dirname):
    deps=set()
    dp=os.path.join(ROOT, dirname)
    if not os.path.isdir(dp): return deps
    for f in os.listdir(dp):
        if not f.endswith('.ts'): continue
        src=open(os.path.join(dp,f),encoding='utf-8').read()
        src=re.sub(r'/\*[\s\S]*?\*/','',src)
        src=re.sub(r'(^|\s)//[^\n]*','',src)
        for m in re.finditer(r"""from\s+['"](\.[^'"]+)['"]""", src):
            p=m.group(1)
            parts=p.split('/')
            if p.startswith('../'):
                top=parts[1] if len(parts)>1 else None
            elif p.startswith('./'):
                top=None                      # 同目录 = 实现细节
                if len(parts)>2: top=parts[1]
            else:
                continue
            if top and top!=dirname and os.path.isdir(os.path.join(ROOT,top)):
                deps.add(top)
    return deps

DEP={}
for u in plugins:
    DEP[u['dir']]=sorted(imports_of(u['dir']))

# ==================== 2. 从 README 的 API 表格抽方法说明 ====================
def doc_from_readme(dirname):
    """返回 {方法名: 说明}"""
    rd=os.path.join(ROOT, dirname, 'README.md')
    out={}
    if not os.path.exists(rd): return out
    txt=open(rd,encoding='utf-8').read()
    for line in txt.split('\n'):
        if not line.startswith('|'): continue
        cells=[c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells)<2: continue
        sig, desc = cells[0], cells[1]
        if desc in ('说明','作用','描述','—','-',''): continue
        if '`' not in sig: continue
        # 一个单元格里可能有 `a()` / `b()` / `c()` 多个
        names=re.findall(r'`([A-Za-z_][\w$]*)\s*(?:<[^>]*>)?\s*(?:\(|`)', sig+'`')
        # 一行多个方法时，说明里的"前者/后者/两者"只对第一个成立
        rel=('前者' in desc or '后者' in desc or '两者' in desc) and len(names)>1
        for i,name in enumerate(names):
            if name in out: continue
            out[name]=desc if (i==0 or not rel) else ''
    return out

# ==================== 3. 源码 JSDoc ====================
def doc_from_source(dirname):
    """JSDoc + 方法上方紧邻的 // 单行注释"""
    out={}
    dp=os.path.join(ROOT, dirname)
    if not os.path.isdir(dp): return out
    for f in os.listdir(dp):
        if not f.endswith('.ts'): continue
        src=open(os.path.join(dp,f),encoding='utf-8').read()
        for m in re.finditer(r'/\*\*([\s\S]*?)\*/\s*(?:public\s+|static\s+|async\s+|override\s+)*?(?:get\s+|set\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(', src):
            name=m.group(2)
            if name in out: continue
            lines=[l.strip().lstrip('*').strip() for l in m.group(1).split('\n')]
            lines=[l for l in lines if l and not l.startswith('@')]
            if lines: out[name]=lines[0]
    # 补充：方法上方紧邻的 // 单行注释（覆盖率比 JSDoc 高）
    for f2 in os.listdir(dp):
        if not f2.endswith('.ts'): continue
        lines=open(os.path.join(dp,f2),encoding='utf-8').read().split('\n')
        for i,l in enumerate(lines):
            mm=re.match(r'^\s{2,4}//\s*(.+)$', l)
            if not mm: continue
            nxt=re.match(r'^\s{2,4}(?:public\s+|static\s+|async\s+)*?(?:get\s+|set\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(', lines[i+1] if i+1<len(lines) else '')
            if nxt and nxt.group(1) not in out:
                t=mm.group(1).strip()
                if 2<len(t)<50: out[nxt.group(1)]=t
    return out

# ==================== 4. 命名推断（兜底，不编造具体功能） ====================
def infer(name):
    n=name.lower()
    if re.match(r'^(get|find|query|idof|peek|at|of|lookup|search|fetch)', n): return '查询'
    if re.match(r'^(set|assign|apply|bind|put)', n): return '设置'
    if re.match(r'^(is|has|can|should|valid|exists|contains)', n): return '判断'
    if re.match(r'^(add|push|enqueue|spawn|create|insert|register|append|grant)', n): return '添加'
    if re.match(r'^(remove|delete|pop|unbind|clear|reset|destroy|kill|drop|revoke)', n): return '移除'
    if re.match(r'^(on|subscribe|emit|dispatch|notify)', n): return '事件'
    if re.match(r'^(tick|update|step|advance|flush|run|play|pause|resume|seek)', n): return '推进/控制'
    if re.match(r'^(to|from|parse|format|encode|decode|serial|deserial|convert|stringify)', n): return '转换'
    if re.match(r'^(calc|compute|evaluate|evaluate|roll|simulate|measure|count|sum)', n): return '计算'
    if re.match(r'^(sort|filter|map|reduce|merge|split|clone|copy)', n): return '集合操作'
    return '操作'

# ==================== 5. 功能要点（从 README「它解决什么」抽首句） ====================
def features_of(u, purpose):
    rd=os.path.join(ROOT,u['dir'],'README.md')
    feats=[]
    if os.path.exists(rd):
        txt=open(rd,encoding='utf-8').read()
        # 「## 它解决什么」下的要点列表
        m=re.search(r'^#+\s*(?:\d+\.\s*)?它解决什么[^\n]*\n([\s\S]*?)(?=\n#|\Z)', txt, re.M)
        if m:
            for line in m.group(1).split('\n'):
                mm=re.match(r'^\s*[-*]\s+\*\*(.+?)\*\*', line)
                if mm: feats.append(mm.group(1))
                elif re.match(r'^\s*[-*]\s+\S', line) and len(feats)<6:
                    t=re.sub(r'^\s*[-*]\s+','',line).strip()
                    if 4<len(t)<40: feats.append(t)
    if not feats:
        # 用主要接口名归纳
        a=api.get(u['dir'],{})
        names=[c['name'] for c in a.get('classes',[])]+a.get('functions',[])[:3]
        if names: feats=['提供 ' + '、'.join(f'`{n}`' for n in names[:4])]
        else: feats=[purpose]
    return feats[:5]

# ==================== 6. 渲染 ====================
def esc(s):
    return re.sub(r'\s+',' ', str(s)).replace('|','/').strip()

def render_unit(u, depth):
    """渲染一个单元节点，返回行列表"""
    d=u['dir']; pad='  '*depth
    nm = d if u['name']==d else '%s（单元名 %s）' % (d, u['name'])
    L=[f'{pad}- **{nm}**']
    p=depth+1; pp='  '*p
    L.append(f'{pp}- 作用：{esc(u["purpose"])}')
    for f in features_of(u, u['purpose']):
        L.append(f'{pp}- 功能：{esc(f)}')
    dep=DEP.get(d,[])
    L.append(f'{pp}- 前置依赖：{("、".join(dep) if dep else "无")}  · 分层 {u["layer"]}')
    # 接口
    a=api.get(d,{})
    rdoc=doc_from_readme(d); sdoc=doc_from_source(d)
    items=[]
    for c in a.get('classes',[]):
        items.append(('class', c['name'], c['methods']))
    if a.get('functions'): items.append(('function', None, a['functions']))
    if items or a.get('types') or a.get('consts'):
        nm_all=sum(len(i[2]) for i in items)
        L.append(f'{pp}- 接口：{len(a.get("classes",[]))} 个类 / {nm_all} 个方法'
                 + (f' / {len(a.get("types") or [])} 个类型' if a.get('types') else '')
                 + (f' / {len(a.get("consts") or [])} 个常量' if a.get('consts') else ''))
        q='  '*(p+1)
        for kind, cname, ms in items:
            head = f'{q}- class `{cname}`' if kind=='class' else f'{q}- 导出函数'
            L.append(head)
            shown=ms[:MAXM]
            for mn in shown:
                doc = rdoc.get(mn) or sdoc.get(mn) or infer(mn)
                if not doc: doc = infer(mn)
                L.append(f'{q}  - `{mn}()` — {esc(doc)[:58]}')
            if len(ms)>MAXM:
                L.append(f'{q}  - … 另有 {len(ms)-MAXM} 个方法')
        rdoc2 = doc_from_readme(d)   # 含所有表格，不只 API 章节
        for t in (a.get('types') or [])[:MAXT]:
            doc = rdoc.get(t) or rdoc2.get(t) or sdoc.get(t) or '类型定义'
            L.append(f'{q}- type `{t}` — {esc(doc)[:42]}')
        if len(a.get('types') or [])>MAXT:
            L.append(f'{q}- … 另有 {len(a["types"])-MAXT} 个类型')
        for k in (a.get('consts') or []):
            L.append(f'{q}- const `{k}`')
    return L

# ---- 领域顺序 ----
DOMAIN_ORDER=['基础设施','地基','通用工具','算法与地图','数值与战斗','移动与碰撞',
  'AI与感知','内容与掉落','玩法框架','进度与统计','表现与外壳','评分与匹配',
  '工程与运维','适配与实体']
DOMAIN_NOTE={'基础设施':'零依赖。其余一切的地基',
 '地基':'不装这些，后面的一切都会歪',
 '通用工具':'通用小件，按需取用',
 '算法与地图':'不认识你的游戏，只认数字和坐标',
 '数值与战斗':'打得到、打得中、打得疼',
 '移动与碰撞':'从「方向」到「角色真的动起来」',
 'AI与感知':'敌人怎么发现你、怎么决策',
 '内容与掉落':'打完之后掉什么、掉多少',
 '玩法框架':'具体玩法的骨架',
 '进度与统计':'跨局的东西：存档、成就、评分',
 '表现与外壳':'玩家能感知、但说不清的「感觉」',
 '评分与匹配':'多人对战：分数、撮合、对局运维',
 '工程与运维':'开发期与线上：调试、埋点、崩溃',
 '适配与实体':'轮子之间的轴，以及「这个 id 是谁」'}

# ---- 功能模块 ----
MOD2P=collections.defaultdict(list); P2MOD={}
for m in meta.get('modules',[]):
    for p in m['plugins']:
        MOD2P[m['id']].append(p)
for mid,ps in MOD2P.items():
    for p in ps: P2MOD[p]=mid
MOD_CN={'skill':'技能','roguelike':'肉鸽','combat':'战斗','ai':'AI 与地图',
 'content':'内容与经济','tooling':'开发工具','audio':'音频','presentation':'演出',
 'ops':'运维'}

by_dom=collections.defaultdict(list)
for u in plugins: by_dom[u['domain']].append(u)

out=[]
out.append('# cocos-kit 插件脑图')
out.append('')
out.append('> 由 `_kitmeta.json` + 源码扫描**自动生成**，不要手改。')
out.append('> 重新生成：`python3 scripts/gen-mindmap.py`（数据源为 `_kitmeta.json` 与源码扫描）。')
out.append('>')
out.append('> **读法**')
out.append('>')
out.append('> - 缩进层级 = 从属关系，可直接被 XMind / 幕布 / markmap 导入')
out.append('> - **加粗**的是插件单元；其下依次是 作用 / 功能 / 前置依赖 / 接口')
out.append('> - 接口下的缩进项是**方法**，破折号后是说明')
out.append('>')
out.append('> **说明的来源优先级**（保证不编造）：')
out.append('>')
out.append('> 1. 该插件 `README.md` 的 API 表格（人工写的准确说明）')
out.append('> 2. 源码里的 JSDoc 首行')
out.append('> 3. 方法名前缀推断的类别（查询 / 设置 / 判断 / 添加 / 移除…）')
out.append('>')
out.append('> ⚠️ 只写"查询""设置"这类**类别词**的，说明该方法既无文档注释、')
out.append('> 名字也不在 README 的 API 表里——类别是可靠的，具体语义请读源码。')
out.append('>')
out.append('> **文档导航**')
out.append('> - [`README.md`](./README.md) —— 入口、理念、快速开始')
out.append('> - [`轮子清单.md`](./轮子清单.md) —— 找某个功能')
out.append('> - 本文档 —— 看整体结构')
out.append('> - 119/119 单元已全部交付（开发进度类文档已随收口移除）')
out.append('> - [`依赖规则v2`](./依赖规则v2_前置模块与分层.md) / [`v3`](./依赖规则v3_功能模块.md)')
out.append('')
out.append('---')
out.append('')

# ================= 视图一：按领域 + 功能模块 =================
out.append('## 视图一：按领域与功能模块（主视图）')
out.append('')
out.append('```text')
out.append('cocos-kit（%d 个单元 / %d 个目录，一一对应）' % (len(plugins), len(dirs)))
out.append('│')
for dom in DOMAIN_ORDER:
    us=sorted(by_dom.get(dom,[]), key=lambda x:x['dir'])
    if not us: continue
    out.append('├─【%s】%d 个 —— %s' % (dom, len(us), DOMAIN_NOTE.get(dom,'')))
    # 模块内聚的先出
    grouped=collections.defaultdict(list); plain=[]
    for u in us:
        mid=P2MOD.get(u['name']) or P2MOD.get(u['dir'])
        if mid: grouped[mid].append(u)
        else: plain.append(u)
    for mid, g in sorted(grouped.items(), key=lambda kv:-len(kv[1])):
        out.append('│   ├─ 〔功能模块·%s〕%d 个组合而成' % (MOD_CN.get(mid,mid), len(g)))
        for u in sorted(g,key=lambda x:x['dir']):
            out.append('│   │   ├─ %s' % u['dir'])
    for u in plain:
        out.append('│   ├─ %s' % u['dir'])
    out.append('│')
out.append('└─ 共 14 个领域')
out.append('```')
out.append('')
out.append('---')
out.append('')

# 详细节点
for dom in DOMAIN_ORDER:
    us=sorted(by_dom.get(dom,[]), key=lambda x:x['dir'])
    if not us: continue
    out.append('## %s（%d 个）' % (dom, len(us)))
    out.append('')
    out.append('> %s' % DOMAIN_NOTE.get(dom,''))
    out.append('')
    grouped=collections.defaultdict(list); plain=[]
    for u in us:
        mid=P2MOD.get(u['name']) or P2MOD.get(u['dir'])
        if mid: grouped[mid].append(u)
        else: plain.append(u)
    for mid, g in sorted(grouped.items(), key=lambda kv:-len(kv[1])):
        out.append('- 〔功能模块·%s〕%d 个单元组合' % (MOD_CN.get(mid,mid), len(g)))
        for u in sorted(g,key=lambda x:x['dir']):
            out += render_unit(u, 1)
    for u in plain:
        out += render_unit(u, 0)
    out.append('')
    out.append('---')
    out.append('')

# ================= 视图二：按依赖前置 =================
out.append('## 视图二：按依赖前置（被依赖者为父，依赖者为子）')
out.append('')
out.append('> 这一视图回答：**改了某个模块，会波及谁**。')
out.append('> 依赖数据由扫描源码 `import` 得出，不是 `_kitmeta.json` 的 `depends` 字段——')
out.append('> 后者有 72 个单元登记为空，与实际不符。')
out.append('')
rev=collections.defaultdict(list)
for d,ds in DEP.items():
    for x in ds: rev[x].append(d)
roots=[x for x in sorted(rev) if x in {u['dir'] for u in plugins}]
out.append('```text')
out.append('依赖树（共 %d 条依赖边，%d 个单元无前置依赖）'
           % (sum(len(v) for v in DEP.values()),
              sum(1 for v in DEP.values() if not v)))
out.append('')
for r in sorted(roots, key=lambda x:-len(rev[x])):
    out.append('%s（被 %d 个单元依赖）' % (r, len(rev[r])))
    kids=sorted(rev[r])
    for i,k in enumerate(kids):
        br='└─' if i==len(kids)-1 else '├─'
        out.append('   %s %s' % (br, k))
    out.append('')
out.append('无前置依赖的单元（%d 个）：'
           % sum(1 for v in DEP.values() if not v))
zero=sorted(d for d,v in DEP.items() if not v)
for i in range(0,len(zero),6):
    out.append('  '+'、'.join(zero[i:i+6]))
out.append('```')
out.append('')

txt='\n'.join(out)
open(os.path.join(ROOT,'插件脑图.md'),'w',encoding='utf-8').write(txt)
print('生成 %d 行 / %d 字符' % (txt.count('\n')+1, len(txt)))
print('依赖边 %d 条' % sum(len(v) for v in DEP.values()))
print('无依赖单元 %d 个' % sum(1 for v in DEP.values() if not v))
