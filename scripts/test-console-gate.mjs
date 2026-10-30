#!/usr/bin/env node
/** 控制台闸门：Host/令牌/智能体隔离/CSRF 的判定表 + 真起一个回环服务验证接线。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { evaluateConsoleGate, evaluateAgentAccess } from '../src/console/auth.js';
import { LIVE_ASSET_NAMES, validConsoleTokenShape, readonlyStoreFor } from '../src/console/policy.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const TOKEN = 'fixture-token-0123456789';
const PORT = 3100;
const base = (over = {}) => ({
  method: 'GET',
  headers: { host: `127.0.0.1:${PORT}` },
  pathname: '/api/status',
  searchParams: new URLSearchParams(),
  boundPort: PORT,
  consoleToken: TOKEN,
  authRequired: true,
  isLiveAgentToken: () => false,
  ...over
});
const gate = (over = {}) => evaluateConsoleGate(base(over));
const access = (over = {}) => evaluateAgentAccess({
  method: 'GET',
  headers: {},
  pathname: '/api/status',
  socialV2Paused: false,
  socialV2Enabled: true,
  mode: 'reserved2',
  slangStoreWritable: true,
  stickerStoreWritable: true,
  ...over
});

test('Host：只接受回环的三种拼写', () => {
  for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `LOCALHOST:${PORT}`]) {
    assert.equal(gate({ headers: { host, 'x-console-token': TOKEN } }).action, 'continue', host);
  }
  const bad = gate({ headers: { host: `evil.example:${PORT}`, 'x-console-token': TOKEN } });
  assert.equal(bad.status, 403);
  assert.match(bad.json.error, /Host 头不被允许/);
  assert.match(gate({ headers: { 'x-console-token': TOKEN } }).json.error, /缺失/);
});

test('Host 先于令牌：坏 Host 不会退回 401 提示', () => {
  const decision = gate({ headers: { host: 'evil.example:3100' } });
  assert.equal(decision.status, 403);
});

test('令牌：缺/错都 401，query 与头等价', () => {
  assert.equal(gate({ headers: { host: `127.0.0.1:${PORT}` } }).status, 401);
  assert.equal(gate({ headers: { host: `127.0.0.1:${PORT}`, 'x-console-token': 'wrong' } }).status, 401);
  assert.equal(gate({ headers: { host: `127.0.0.1:${PORT}`, 'x-console-token': TOKEN } }).action, 'continue');
  assert.equal(gate({ searchParams: new URLSearchParams({ token: TOKEN }) }).action, 'continue');
  assert.equal(gate({ searchParams: new URLSearchParams({ token: 'nope' }) }).status, 401);
});

test('未带令牌打开 / 回提示页，/live 外壳先放行', () => {
  const html = gate({ pathname: '/' });
  assert.equal(html.status, 401);
  assert.match(html.html, /请输入控制台访问令牌/);
  assert.equal(gate({ pathname: '/live' }).action, 'continue');
  assert.equal(gate({ pathname: '/live-assets/whale-pixel-idle.png' }).action, 'continue');
  assert.equal(gate({ pathname: '/api/live/snapshot' }).status, 401, '数据接口仍要令牌');
});

test('关闭鉴权后不再要求令牌（Host/CSRF 仍在）', () => {
  assert.equal(gate({ authRequired: false, headers: { host: `127.0.0.1:${PORT}` } }).action, 'continue');
  assert.equal(gate({ authRequired: false, headers: { host: 'evil.example:3100' } }).status, 403);
});

test('智能体调用隔离：有效令牌才放行，无令牌只放行非 v2 会话面', () => {
  const host = `127.0.0.1:${PORT}`;
  const call = { host, 'x-console-token': TOKEN, 'x-agent-call': '1' };
  assert.equal(gate({ headers: { ...call, 'x-agent-token': 'live' }, isLiveAgentToken: () => true }).action, 'continue');
  assert.equal(gate({ headers: { ...call, 'x-agent-token': 'stale' } }).status, 403, '令牌无效一律拒绝');
  assert.equal(gate({ headers: call, pathname: '/api/status' }).action, 'continue', 'closed-agent 的无令牌调用可读状态');
  assert.equal(gate({ headers: call, pathname: '/api/send/group' }).action, 'continue');
  assert.equal(gate({ headers: call, pathname: '/api/socialV2/states' }).status, 403);
  assert.equal(gate({ headers: { host, 'x-console-token': TOKEN }, pathname: '/api/socialV2/states' }).action, 'continue', '管理端无 x-agent-call 不受此闸门影响');
});

test('CSRF：写操作要 JSON，Origin 必须是本机', () => {
  const host = `127.0.0.1:${PORT}`;
  const headers = { host, 'x-console-token': TOKEN };
  assert.equal(gate({ method: 'POST', headers }).status, 415);
  assert.equal(gate({ method: 'POST', headers: { ...headers, 'content-type': 'text/plain' } }).status, 415);
  assert.equal(gate({ method: 'POST', headers: { ...headers, 'content-type': 'application/json', origin: 'https://evil.example' } }).status, 403);
  assert.equal(gate({ method: 'POST', headers: { ...headers, 'content-type': 'application/json', origin: `http://127.0.0.1:${PORT}` } }).action, 'continue');
  assert.equal(gate({ method: 'GET', headers: { ...headers, origin: 'https://evil.example' } }).action, 'continue');
});

test('智能体权限：暂停/关闭/模式/仅控制台/白名单', () => {
  const agent = { 'x-agent-token': 'live' };
  assert.equal(access({ headers: { 'x-agent-token': '' } }).status, 403);
  assert.equal(access({ headers: agent, pathname: '/api/socialV2/states', socialV2Paused: true }).status, 403);
  assert.equal(access({ headers: agent, pathname: '/api/status', socialV2Paused: true }).action, 'continue');
  assert.equal(access({ headers: agent, pathname: '/api/images/list', socialV2Enabled: false }).status, 403);
  assert.equal(access({ headers: agent, pathname: '/api/socialV2/states', mode: 'closed-agent' }).status, 403);
  assert.equal(access({ headers: agent, pathname: '/api/socialV2/config' }).status, 403);
  assert.equal(access({ headers: agent, pathname: '/api/socialV2/feedback', method: 'GET' }).status, 403);
  assert.equal(access({ headers: agent, pathname: '/api/socialV2/feedback', method: 'POST' }).action, 'continue');
  assert.equal(access({ headers: agent, pathname: '/api/stickers/sync' }).status, 403);
  assert.equal(access({ headers: agent, pathname: '/api/whitelist' }).status, 403);
  assert.equal(access({ headers: agent, pathname: '/api/authorize/read' }).action, 'continue');
  assert.equal(access({ pathname: '/api/whitelist' }).action, 'continue', '控制台管理端不受智能体白名单影响');
});

test('只读降级只拦写、且要明确 503', () => {
  assert.equal(access({ method: 'POST', pathname: '/api/slang', slangStoreWritable: false }).status, 503);
  assert.match(access({ method: 'POST', pathname: '/api/slang', slangStoreWritable: false }).json.error, /黑话库/);
  assert.equal(access({ method: 'GET', pathname: '/api/slang', slangStoreWritable: false }).action, 'continue');
  assert.equal(access({ method: 'POST', pathname: '/api/stickers/note', stickerStoreWritable: false }).status, 503);
  assert.equal(access({ method: 'POST', pathname: '/api/stickers/note', stickerStoreWritable: true }).action, 'continue');
  assert.equal(readonlyStoreFor('/api/slang/batch-add', 'POST', { slangStoreWritable: false, stickerStoreWritable: true }), '黑话库');
});

test('令牌形状与静态资源名单', () => {
  assert.equal(validConsoleTokenShape('a'.repeat(16)), true);
  assert.equal(validConsoleTokenShape('a'.repeat(128)), true);
  assert.equal(validConsoleTokenShape('a'.repeat(15)), false);
  assert.equal(validConsoleTokenShape('a'.repeat(129)), false);
  assert.equal(validConsoleTokenShape('has space in token'), false);
  assert.equal(LIVE_ASSET_NAMES.has('whale-pixel-idle.png'), true);
  assert.equal(LIVE_ASSET_NAMES.has('../state/sessions.json'), false);
});

function request(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('接线：真起控制台后四道闸门按序生效', async () => {
  const h = await bridgeHarness();
  let server;
  try {
    server = h.startConsoleServer();
    await new Promise((resolve, reject) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const port = server.address().port;
    const token = String(h.cfg.consoleToken);

    const unauth = await request(port, '/api/status');
    assert.equal(unauth.status, 401);
    assert.match(unauth.body, /未授权/);

    const auth = await request(port, '/api/status', { headers: { 'x-console-token': token } });
    assert.equal(auth.status, 200);
    assert.equal(auth.headers['x-frame-options'], 'DENY');

    const live = await request(port, '/live');
    assert.equal(live.status, 200, '静态外壳不带令牌可加载');

    const asset404 = await request(port, '/live-assets/..%2Fstate%2Fsessions.json');
    assert.equal(asset404.status, 404, '资源白名单挡住路径逃逸');
    const snap = await request(port, '/api/live/snapshot', { headers: { 'x-console-token': token } });
    assert.equal(snap.status, 200);
    assert.match(snap.body, /"ok": true/);

    const badJson = await request(port, '/api/status', {
      method: 'POST', headers: { 'x-console-token': token, 'content-type': 'text/plain' }, body: 'x'
    });
    assert.equal(badJson.status, 415);

    const confused = await request(port, '/api/socialV2/states', {
      headers: { 'x-console-token': token, 'x-agent-call': '1' }
    });
    assert.equal(confused.status, 403);
    assert.match(confused.body, /必须携带有效的会话令牌/);

    const badHost = await request(port, '/api/status', { headers: { 'x-console-token': token, host: `evil.example:${port}` } });
    assert.equal(badHost.status, 403);
    assert.match(badHost.body, /Host 头不被允许/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});
