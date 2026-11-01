"""Display saved and unfinished project snapshots without human approval; never serve raw files.

The preview is STATIC: no JavaScript, navigation, forms, media or external URLs.
Sanitized markup is confined to an opaque-origin sandbox iframe with no flags.
"""
import hashlib, html, json, re, sqlite3
from html.parser import HTMLParser
from pathlib import Path

UUID=re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
PREVIEW_CSP="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
INNER_CSP="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

def connect(path):
    path=Path(path).absolute()
    for part in [path,*path.parents]:
        if part.is_symlink() or (hasattr(part,'is_junction') and part.is_junction()):
            raise ValueError('Workroom links refused')
    if path.stat().st_nlink>1:raise ValueError('Workroom hardlinks refused')
    return sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=1)

def has_table(db,name):return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(name,)).fetchone() is not None

def shown_project(db,project):
    if not UUID.fullmatch(project):raise LookupError('Unavailable')
    row=db.execute('SELECT title,head,origin,updated FROM wr_projects WHERE id=? AND deleted=0',(project,)).fetchone()
    if not row or has_table(db,'wr_hidden') and db.execute('SELECT 1 FROM wr_hidden WHERE project=?',(project,)).fetchone():raise LookupError('Unavailable')
    return row

def execution_label(job,version=None,draft=False):
    if draft:
        try:
            evidence=json.loads(job.get('result') or '{}').get('evidence',{})
            if any(t.get('status')=='completed' for t in evidence.get('tool_results',[])):return '部分步骤有受限运行回执，当前草稿未验证'
        except (ValueError,AttributeError,TypeError):pass
        return '半成品，当前草稿未验证运行'
    if job:
        try:
            result=json.loads(job['result'] or '{}')
            if result.get('version')==version and job['state'] in ['completed','awaiting_review'] and any(t.get('status')=='completed' for t in result.get('evidence',{}).get('tool_results',[])):return '有实际受限运行回执'
        except (ValueError,AttributeError,TypeError):pass
    return None

def project_jobs(path):
    jobs={};drafts=[];path=Path(path).with_name('workshop.sqlite3')
    if not path.exists():return jobs,drafts
    db=connect(path);db.row_factory=sqlite3.Row
    try:
        if not has_table(db,'workshop_jobs'):return jobs,drafts
        for row in db.execute('SELECT id,project,base_version,state,result,updated FROM workshop_jobs ORDER BY updated DESC LIMIT 200'):
            value=dict(row);jobs.setdefault(row['project'],value)
            try:result=json.loads(row['result'] or '{}')
            except ValueError:continue
            if isinstance(result.get('draft_artifacts'),dict) or isinstance(result.get('artifacts'),dict):drafts.append(value)
    finally:db.close()
    return jobs,drafts

def public_projects(path):
    if not Path(path).exists():return []
    jobs,drafts=project_jobs(path);db=connect(path);result=[];visible={}
    try:
        for project,title,version,origin,at in db.execute('SELECT id,title,head,origin,updated FROM wr_projects WHERE deleted=0 ORDER BY updated DESC LIMIT 200'):
            try:shown_project(db,project)
            except LookupError:continue
            validation=execution_label(jobs.get(project),version)
            if not validation:
                check=db.execute('SELECT result FROM wr_checks WHERE project=? AND version=?',(project,version)).fetchone() if has_table(db,'wr_checks') else None
                if not check and has_table(db,'wr_submissions'):check=db.execute('SELECT checks FROM wr_submissions WHERE project=? AND version=? ORDER BY at DESC LIMIT 1',(project,version)).fetchone()
                validation=('仅静态检查' if json.loads(check[0]).get('ok') else '静态检查有问题，仍可预览') if check else '未验证运行'
                if check and json.loads(check[0]).get('browser_preview',{}).get('actual_browser'):validation+='；浏览器预览已核对'
            label='开发验收合成作品 · 非汐自创' if origin=='development-acceptance' else '作品与半成品直接展示'
            item=dict(id=project,title=title[:100],version=version,at=at,label=label,validation=validation,progress=jobs.get(project,{}).get('state','saved'),url='/workroom/'+project,review_required=False)
            result.append(item);visible[project]=item
        for job in drafts:
            base=visible.get(job['project'])
            if base and UUID.fullmatch(job['id']):result.append(dict(base,title=base['title']+' · 进行中草稿',at=job['updated'],snapshot_kind='draft',version=job['base_version'],job_id=job['id'],validation=execution_label(job,draft=True),progress=job['state'],url='/workroom/'+job['project']+'?draft='+job['id']))
    finally:db.close()
    return result

def verified_files(serialized,digest=None):
    if not isinstance(serialized,str) or len(serialized)>600000 or digest and hashlib.sha256(serialized.encode()).hexdigest()!=digest:raise ValueError('Snapshot integrity failed')
    files=json.loads(serialized)
    if not isinstance(files,dict) or len(files)>80 or any(not isinstance(k,str) or not isinstance(v,str) for k,v in files.items()):raise ValueError('Invalid snapshot')
    return files

def released_files(path,project,version=None,draft=None):
    db=connect(path)
    try:
        title,head,origin,at=shown_project(db,project)
        if draft:
            if not UUID.fullmatch(draft):raise LookupError('Unavailable')
            other=connect(Path(path).with_name('workshop.sqlite3'))
            try:row=other.execute('SELECT result,base_version FROM workshop_jobs WHERE id=? AND project=?',(draft,project)).fetchone()
            finally:other.close()
            if not row:raise LookupError('Unavailable')
            saved=json.loads(row[0] or '{}');value=saved.get('draft_artifacts',saved.get('artifacts'))
            files=verified_files(json.dumps(value,ensure_ascii=False));return title[:100],str(row[1])+' 的独立草稿，未覆盖当前版本，运行证据另列',origin,files
        if version is not None and (not isinstance(version,int) or version<1):raise LookupError('Unavailable')
        selected=version or head
        row=db.execute('SELECT files,digest FROM wr_versions WHERE project=? AND version=?',(project,selected)).fetchone()
    finally:db.close()
    if not row:raise LookupError('Unavailable')
    return title[:100],selected,origin,verified_files(*row)

def safe_css(text):
    # Reject escaped tokens, markup breaks and executable/remote resource syntax.
    if len(text)>131072 or re.search(r'[\\<>]|@\s*import|expression\s*\(|behavior\s*:|-moz-binding|https?:|data:|//|image-set\s*\(',text,re.I):return ''
    without_internal=re.sub(r'url\(\s*#[a-zA-Z][\w-]*\s*\)','',text,flags=re.I)
    if re.search(r'url\s*\(',without_internal,re.I):return ''
    return text

TAGS=set('main section article header footer div span p h1 h2 h3 h4 h5 h6 strong em b i u small br hr ul ol li pre code blockquote table tr td th thead tbody tfoot caption button label svg g path rect circle ellipse line polyline polygon text tspan defs lineargradient radialgradient stop clippath'.split())
ATTRS=set('id class title role aria-label width height viewbox preserveaspectratio x y x1 x2 y1 y2 cx cy r rx ry d points fill stroke stroke-width stroke-linecap stroke-linejoin opacity fill-opacity stroke-opacity transform text-anchor dominant-baseline font-size font-family offset stop-color stop-opacity clip-path colspan rowspan'.split())
CASE={'lineargradient':'linearGradient','radialgradient':'radialGradient','clippath':'clipPath','viewbox':'viewBox','preserveaspectratio':'preserveAspectRatio'}
SKIP=set('script iframe object embed template math foreignobject form textarea title'.split())
VOID={'br','hr'}

class StaticMarkup(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True);self.out=[];self.skip=[];self.styles=[];self.in_style=False;self.style_text=[];self.nodes=0
    def handle_starttag(self,tag,attrs):
        self.nodes+=1
        if self.nodes>4000:raise ValueError('Markup complexity limit')
        if self.skip:
            if tag in SKIP:self.skip.append(tag)
            return
        if tag in SKIP:self.skip.append(tag);return
        if tag=='style':self.in_style=True;self.style_text=[];return
        if tag not in TAGS:return
        clean=[]
        for key,value in attrs:
            if value is None:continue
            if len(value)>4096:continue
            if key=='style':
                value=safe_css(value)
                if value:clean.append('style="'+html.escape(value,quote=True)+'"')
            elif key in ATTRS:
                if re.search(r'url\s*\(',value,re.I) and not re.fullmatch(r'url\(\s*#[a-zA-Z][\w-]*\s*\)',value,re.I):continue
                if '\\' in value or re.search(r'javascript:|https?:|data:',value,re.I):continue
                clean.append(CASE.get(key,key)+'="'+html.escape(value,quote=True)+'"')
        if tag=='button':clean.append('disabled')
        self.out.append('<'+CASE.get(tag,tag)+(' '+' '.join(clean) if clean else '')+'>')
    def handle_startendtag(self,tag,attrs):
        self.handle_starttag(tag,attrs)
        if tag not in VOID:self.handle_endtag(tag)
    def handle_endtag(self,tag):
        if self.skip:
            if tag==self.skip[-1]:self.skip.pop()
            return
        if tag=='style':
            self.in_style=False;css=safe_css(''.join(self.style_text))
            if css:self.styles.append(css)
            return
        if tag in TAGS and tag not in VOID:self.out.append('</'+CASE.get(tag,tag)+'>')
    def handle_data(self,text):
        if self.skip:return
        if self.in_style:self.style_text.append(text)
        else:self.out.append(html.escape(text))

def preview_document(title,version,origin,files):
    markup=StaticMarkup();markup.feed(files.get('index.html',files.get('index.svg','<p>缺少预览入口</p>')));markup.close()
    css='\n'.join(filter(None,[safe_css(value) for name,value in sorted(files.items()) if name.endswith('.css')]+markup.styles))
    inner='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+html.escape(INNER_CSP,quote=True)+'"><style>'+css+'</style></head><body>'+''.join(markup.out)+'</body></html>'
    label='开发验收合成作品 · 非汐自创' if origin=='development-acceptance' else '可直接展示的作品／半成品'
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+html.escape(title)+' · 汐的工作间</title><style>body{margin:0;background:#f5f8f5;color:#193d45;font:16px/1.6 system-ui,sans-serif}header{padding:20px 5vw;border-bottom:1px solid #dce8e5}h1{font-size:23px;margin:8px 0}p{margin:6px 0;color:#607b7f}a{color:#237c83}iframe{display:block;width:90vw;height:72vh;margin:20px auto;border:1px solid #dce8e5;border-radius:16px;background:white}small{font-size:12px}</style></head><body><header><a href="/">回到小窝</a><h1>'+html.escape(title)+'</h1><p>'+label+' · 版本 '+str(version)+'</p><small>隔离预览：允许 HTML/CSS/SVG 画面与 CSS 动效，脚本不执行，外部资源已移除。展示不代表运行过宿主程序。</small></header><iframe title="作品静态隔离预览" sandbox="" referrerpolicy="no-referrer" srcdoc="'+html.escape(inner,quote=True)+'"></iframe></body></html>').encode('utf-8')

def public_preview(path,project,version=None,draft=None):return preview_document(*released_files(path,project,version,draft))
