"""Owned loopback HTTP seam around the unchanged original static renderer."""
import argparse, hashlib, html, importlib.util, json, os, re, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

p=argparse.ArgumentParser();p.add_argument('--db',required=True);p.add_argument('--renderer',required=True);p.add_argument('--port',type=int,required=True);args=p.parse_args()
renderer=Path(args.renderer)
if hashlib.sha256(renderer.read_bytes()).hexdigest()!='3b4e0b0443e53a0bd45053e447a2cfea41b8531c389cb6c43f41e611113f0d36':raise RuntimeError('RENDERER_SOURCE_CHANGED')
spec=importlib.util.spec_from_file_location('xi_original_workroom_view',renderer);view=importlib.util.module_from_spec(spec);spec.loader.exec_module(view)
db_path=Path(args.db)

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_GET(self):
        if self.headers.get('Host') not in [f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}']:
            self.send_error(403);return
        url=urlsplit(self.path)
        try:
            if url.path in ['/','/api/workroom']:
                if url.query:raise LookupError()
                db=view.connect(db_path)
                try:
                    projects=[]
                    for project,title,head,origin in db.execute('SELECT id,title,head,origin FROM wr_projects WHERE deleted=0 ORDER BY updated DESC LIMIT 200'):
                        try:view.shown_project(db,project)
                        except LookupError:continue
                        projects.append(dict(id=project,title=title,version=head,origin=origin,url='/workroom/'+project,review_required=False))
                finally:db.close()
                if url.path=='/api/workroom':
                    data=json.dumps(dict(projects=projects,mode='original-static-renderer',read_only=True),ensure_ascii=False).encode();mime='application/json; charset=utf-8'
                else:
                    cards=''.join('<a class="card" href="'+html.escape(item['url'],quote=True)+'"><h2>'+html.escape(item['title'])+'</h2><p>第 '+str(item['version'])+' 版 · 打开看看 →</p></a>' for item in projects)
                    if not cards:cards='<p class="empty">这里会放小汐想展示的作品，没做完的小点子也可以来。</p>'
                    data=('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>汐的小工作间</title>
<style>body{margin:0;background:#f4f9ff;color:#17375e;font:16px/1.6 system-ui,sans-serif}main{max-width:1000px;margin:64px auto;padding:0 24px}h1{font-size:36px;margin:0}header p{color:#5c7590;margin:8px 0 36px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}.card{display:block;background:white;border:1px solid #dceafb;border-radius:18px;padding:22px;color:inherit;text-decoration:none}.card:hover{border-color:#6ba5ec}.card h2{font-size:20px;margin:0 0 16px}.card p,.empty{color:#627e9b}footer{margin-top:40px;color:#73869a;font-size:13px}</style>
<main><header><h1>汐的小工作间</h1><p>一些小作品，一些还在长大的点子。</p></header><section class="grid">'''+cards+'''</section><footer>本机作品预览 · 当前页面展示静态内容，交互效果以实际运行结果为准。</footer></main></html>''').encode('utf8');mime='text/html; charset=utf-8'
            else:
                match=re.fullmatch(r'/workroom(?:-static)?/([0-9a-f-]{36})',url.path)
                if not match:raise LookupError()
                query=parse_qs(url.query,strict_parsing=True)
                if set(query)-{'version'} or any(len(values)!=1 for values in query.values()):raise LookupError()
                version=int(query['version'][0]) if 'version' in query else None
                data=view.public_preview(db_path,match[1],version);mime='text/html; charset=utf-8'
            self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)))
            self.send_header('Content-Security-Policy',view.PREVIEW_CSP);self.send_header('X-Frame-Options','DENY');self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer');self.end_headers();self.wfile.write(data)
        except (LookupError,FileNotFoundError,ValueError):self.send_error(404)
        except Exception:self.send_error(503,'Original preview unavailable')

server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler);server.daemon_threads=True
def monitor():
    for line in sys.stdin:
        if line.strip()=='stop':break
    server.shutdown()
threading.Thread(target=monitor,daemon=True).start()
print(json.dumps(dict(ready=True,pid=os.getpid(),port=server.server_port)),flush=True)
try:server.serve_forever(poll_interval=0.1)
finally:server.server_close()
