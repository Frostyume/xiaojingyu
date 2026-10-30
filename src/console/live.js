// 实时状态页（只读）：/live 静态页、/live-assets/*、快照与 SSE。
//
// 以前这四个分支夹在 170 多个路由中间，文件读取、资源白名单和 SSE 定时器都只能
// 靠通读 bridge 才能确认。这里只做请求分发，数据仍由桥接注入（snapshot）。
//
// 返回 true 表示已处理（调用方直接 return），false 表示不是 live 面。
import fs from 'node:fs';
import path from 'node:path';
import { LIVE_ASSET_NAMES } from './policy.js';

export function handleLiveRequest({ req, res, url, root, headers, snapshot, sendJson }) {
  if (req.method !== 'GET') return false;
  const { pathname } = url;
  if (pathname === '/live') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
    try {
      res.end(fs.readFileSync(path.join(root, 'public', 'live.html'), 'utf8'));
    } catch {
      res.end('实时状态页缺失：qq-bridge/public/live.html');
    }
    return true;
  }
  if (pathname.startsWith('/live-assets/')) {
    const name = path.basename(pathname);
    if (!LIVE_ASSET_NAMES.has(name)) {
      sendJson({ ok: false, error: 'not found' }, 404);
      return true;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', ...headers });
    try { res.end(fs.readFileSync(path.join(root, 'public', 'assets', name))); } catch { res.end(); }
    return true;
  }
  if (pathname === '/api/live/snapshot') {
    sendJson({ ok: true, ...snapshot() });
    return true;
  }
  if (pathname === '/api/live/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...headers
    });
    res.write('retry: 3000\n\n');
    const send = () => {
      try { res.write(`data: ${JSON.stringify(snapshot())}\n\n`); } catch {}
    };
    send();
    const dataTimer = setInterval(send, 1000);
    const heartbeatTimer = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15000);
    const cleanup = () => { clearInterval(dataTimer); clearInterval(heartbeatTimer); };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return true;
  }
  return false;
}
