#!/usr/bin/env node
/**
 * 局域网访问（consoleLanAccess）安全不变量：
 *   · 纯函数判定表：hostHeaderAllowed / originAllowed / lanHostsFromInterfaces，
 *     含「不传 lanHosts 时与旧行为逐字一致」的向后兼容锚点；
 *   · 真起夹具控制台（bridgeHarness，consolePort:0 系统分配端口，假网关）验证：
 *     默认 bind 127.0.0.1；开启后 bind 0.0.0.0 且强制令牌（即使 consoleAuth.enabled=false）；
 *     Host=本机 LAN IP 放行、evil 域名仍 403、无令牌数据/SSE 401（静态外壳除外）。
 * 网卡名单用夹具注入（globals.os），不依赖跑测试那台机器的真实网卡；绝不绑现网端口、不发真实 QQ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { evaluateConsoleGate } from '../console/auth.js';
import { hostHeaderAllowed, originAllowed, lanHostsFromInterfaces } from '../console/policy.js';
import { bridgeHarness } from './bridge-harness.mjs';

const TOKEN = 'fixture-token-0123456789';
const PORT = 3100;
// 夹具 LAN IP：文档用私有网段占位，与任何真实机器无关。
const LAN_IP = '192.168.50.10';
const LAN_HOST = `${LAN_IP}:${PORT}`;
const fixtureInterfaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [
    { address: LAN_IP, family: 'IPv4', internal: false },
    { address: 'fe80::abcd', family: 'IPv6', internal: false }
  ],
  virtual: [{ address: '10.99.99.99', family: 'IPv4', internal: true }]
};
const fixtureOs = { ...os, networkInterfaces: () => fixtureInterfaces };

// ── 纯函数：网卡名单 ────────────────────────────────────────────────────────
test('lanHostsFromInterfaces：只取非内部 IPv4，拼端口，去重', () => {
  assert.deepEqual(lanHostsFromInterfaces(PORT, fixtureInterfaces), [LAN_HOST]);
  assert.deepEqual(lanHostsFromInterfaces(PORT, {}), []);
  assert.deepEqual(lanHostsFromInterfaces(PORT, null), []);
  assert.deepEqual(lanHostsFromInterfaces(PORT, { bad: [null, { address: 'not-an-ip', family: 'IPv4', internal: false }] }), []);
  const dup = { a: [{ address: LAN_IP, family: 'IPv4', internal: false }], b: [{ address: LAN_IP, family: 'IPv4', internal: false }] };
  assert.deepEqual(lanHostsFromInterfaces(PORT, dup), [LAN_HOST], '同一 IP 多网卡只出现一次');
  assert.deepEqual(lanHostsFromInterfaces(4173, fixtureInterfaces), [`${LAN_IP}:4173`], '端口跟随实际绑定端口');
  // family 数字形态（Node 旧版返回 4/6）也要认。
  assert.deepEqual(lanHostsFromInterfaces(PORT, { e: [{ address: LAN_IP, family: 4, internal: false }] }), [LAN_HOST]);
});

// ── 纯函数：Host/Origin 判定（向后兼容锚点 + LAN 扩展） ─────────────────────
test('hostHeaderAllowed：不传 lanHosts 时与旧行为逐字一致（锚点）', () => {
  for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `LOCALHOST:${PORT}`]) {
    assert.equal(hostHeaderAllowed(host, PORT), true, host);
  }
  assert.equal(hostHeaderAllowed(LAN_HOST, PORT), false, '旧行为：LAN IP 不在回环名单里');
  assert.equal(hostHeaderAllowed(`evil.example:${PORT}`, PORT), false);
  assert.equal(hostHeaderAllowed(`127.0.0.1:${PORT + 1}`, PORT), false, '端口不符拒绝');
  assert.equal(hostHeaderAllowed('', PORT), false);
  assert.equal(hostHeaderAllowed(undefined, PORT), false);
});

test('hostHeaderAllowed：传入 lanHosts 只额外放行名单内的 IP:port', () => {
  const opts = { lanHosts: [LAN_HOST] };
  assert.equal(hostHeaderAllowed(LAN_HOST, PORT, opts), true);
  assert.equal(hostHeaderAllowed(`127.0.0.1:${PORT}`, PORT, opts), true, '回环仍放行');
  assert.equal(hostHeaderAllowed(`LOCALHOST:${PORT}`, PORT, opts), true);
  assert.equal(hostHeaderAllowed(`evil.example:${PORT}`, PORT, opts), false, 'DNS-rebinding 域名仍拒绝');
  assert.equal(hostHeaderAllowed(`${LAN_IP}:${PORT + 1}`, PORT, opts), false, 'LAN IP 端口不符拒绝');
  assert.equal(hostHeaderAllowed(`192.168.50.11:${PORT}`, PORT, opts), false, '名单外的其它 LAN IP 拒绝');
  assert.equal(hostHeaderAllowed(LAN_HOST.toUpperCase(), PORT, { lanHosts: [LAN_HOST.toUpperCase()] }), true, '大小写归一');
  assert.equal(hostHeaderAllowed(LAN_HOST, PORT, { lanHosts: [] }), false, '空名单等同旧行为');
  assert.equal(hostHeaderAllowed(LAN_HOST, PORT, {}), false, '缺省 opts 等同旧行为');
});

test('originAllowed：回环基线不变，lanHosts 只放行名单内来源', () => {
  assert.equal(originAllowed(`http://127.0.0.1:${PORT}`, PORT), true);
  assert.equal(originAllowed(`http://localhost:${PORT}`, PORT), true);
  assert.equal(originAllowed(`http://${LAN_IP}:${PORT}`, PORT), false, '旧行为：LAN 来源拒绝');
  assert.equal(originAllowed('https://evil.example', PORT), false);
  const opts = { lanHosts: [LAN_HOST] };
  assert.equal(originAllowed(`http://${LAN_IP}:${PORT}`, PORT, opts), true);
  assert.equal(originAllowed(`http://127.0.0.1:${PORT}`, PORT, opts), true);
  assert.equal(originAllowed('https://evil.example', PORT, opts), false);
  assert.equal(originAllowed(`http://${LAN_IP}:${PORT + 1}`, PORT, opts), false, '端口不符拒绝');
  assert.equal(originAllowed('not a url', PORT, opts), false);
  assert.equal(originAllowed('', PORT, opts), false);
});

test('红自测（空操作守卫）：判定必须真的区分 evil 与放行名单', () => {
  // 若判定退化成「一律放行」，下面的不等式必须不成立——证明上面的断言不是恒真。
  const allowAll = () => true;
  assert.equal(allowAll(`evil.example:${PORT}`, PORT), true);
  assert.notEqual(hostHeaderAllowed(`evil.example:${PORT}`, PORT, { lanHosts: [LAN_HOST] }), allowAll(`evil.example:${PORT}`, PORT));
  assert.notEqual(originAllowed('https://evil.example', PORT, { lanHosts: [LAN_HOST] }), allowAll('https://evil.example', PORT));
  // 锚点本身也要能抓「默认就放行 LAN」的退化：不传 opts 时 LAN 必须仍被拒。
  assert.equal(hostHeaderAllowed(LAN_HOST, PORT), false);
});

// ── 纯函数：闸门透传 ────────────────────────────────────────────────────────
const gateBase = (over = {}) => ({
  method: 'GET',
  headers: { host: `127.0.0.1:${PORT}` },
  pathname: '/api/live/snapshot',
  searchParams: new URLSearchParams(),
  boundPort: PORT,
  consoleToken: TOKEN,
  authRequired: true,
  isLiveAgentToken: () => false,
  ...over
});

test('evaluateConsoleGate：lanHosts 透传给 Host 与 Origin 判定', () => {
  const lan = { lanHosts: [LAN_HOST] };
  assert.equal(evaluateConsoleGate(gateBase({ headers: { host: LAN_HOST, 'x-console-token': TOKEN }, ...lan })).action, 'continue');
  assert.equal(evaluateConsoleGate(gateBase({ headers: { host: LAN_HOST }, ...lan })).status, 401, 'LAN 无令牌仍要鉴权');
  assert.equal(evaluateConsoleGate(gateBase({ headers: { host: `evil.example:${PORT}`, 'x-console-token': TOKEN }, ...lan })).status, 403);
  assert.equal(evaluateConsoleGate(gateBase({ headers: { host: LAN_HOST, 'x-console-token': TOKEN } })).status, 403, '不传 lanHosts 时 LAN Host 仍拒（旧行为）');
  const write = { method: 'POST', headers: { host: LAN_HOST, 'x-console-token': TOKEN, 'content-type': 'application/json', origin: `http://${LAN_IP}:${PORT}` }, ...lan };
  assert.equal(evaluateConsoleGate(gateBase(write)).action, 'continue', 'LAN 来源的写请求 CSRF 放行');
  const evilWrite = { ...write, headers: { ...write.headers, origin: 'https://evil.example' } };
  assert.equal(evaluateConsoleGate(gateBase(evilWrite)).status, 403);
});

// ── 接线：真起夹具控制台 ────────────────────────────────────────────────────
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

// SSE：攒够一个完整事件（data 行 + 空行）就断开；快照较大，首帧可能跨多个 chunk。
function sseFirstFrame(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        const start = data.indexOf('data: ');
        const end = data.indexOf('\n\n', start);
        if (start >= 0 && end > start) {
          const frame = data.slice(start + 6, end);
          res.destroy();
          resolve({ status: res.statusCode, headers: res.headers, frame });
        }
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
    req.end();
  });
}

async function startHarness(config, globals) {
  const h = await bridgeHarness({ config, ...(globals ? { globals } : {}) });
  const server = h.startConsoleServer();
  await new Promise((resolve, reject) => {
    if (server.listening) { resolve(); return; }
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { h, server, port: server.address().port };
}
async function stopHarness({ h, server }) {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
}

test('默认（缺省 consoleLanAccess）：bind 127.0.0.1，LAN Host 拒，回环照常', async () => {
  const ctx = await startHarness({ consoleToken: TOKEN });
  try {
    assert.equal(ctx.server.address().address, '127.0.0.1', '绑定锚点：默认只监听回环');
    const port = ctx.port;
    const ok = await request(port, '/api/status', { headers: { 'x-console-token': TOKEN } });
    assert.equal(ok.status, 200);
    const lanHost = await request(port, '/api/status', { headers: { host: `${LAN_IP}:${port}`, 'x-console-token': TOKEN } });
    assert.equal(lanHost.status, 403, '默认配置下 LAN Host 一律拒');
    assert.match(lanHost.body, /Host 头不被允许/);
    const noToken = await request(port, '/api/live/snapshot');
    assert.equal(noToken.status, 401);
  } finally { await stopHarness(ctx); }
});

test('默认 + 关闭鉴权（现网形态）：回环匿名可读，LAN Host 仍拒', async () => {
  const ctx = await startHarness({ consoleToken: TOKEN, consoleAuth: { enabled: false } });
  try {
    assert.equal(ctx.server.address().address, '127.0.0.1');
    const port = ctx.port;
    const anon = await request(port, '/api/live/snapshot');
    assert.equal(anon.status, 200, '向后兼容：仅回环时关鉴权仍匿名可读');
    const lanHost = await request(port, '/api/live/snapshot', { headers: { host: `${LAN_IP}:${port}` } });
    assert.equal(lanHost.status, 403);
    const evil = await request(port, '/api/live/snapshot', { headers: { host: `evil.example:${port}` } });
    assert.equal(evil.status, 403);
  } finally { await stopHarness(ctx); }
});

test('开启局域网：bind 0.0.0.0，强制令牌，LAN Host 放行，evil 仍拒', async () => {
  const ctx = await startHarness(
    { consoleToken: TOKEN, consoleLanAccess: true, consoleAuth: { enabled: false } },
    { os: fixtureOs }
  );
  try {
    assert.equal(ctx.server.address().address, '0.0.0.0', '绑定锚点：开启后监听所有网卡');
    const port = ctx.port;
    const lanHost = `${LAN_IP}:${port}`;
    const auth = { 'x-console-token': TOKEN };

    // 强制鉴权：consoleAuth.enabled=false 也不能匿名读数据/SSE。
    for (const path of ['/api/live/snapshot', '/api/status']) {
      const res = await request(port, path, { headers: { host: lanHost } });
      assert.equal(res.status, 401, `${path} 无令牌必须 401`);
    }
    const sseNoToken = await request(port, '/api/live/stream', { headers: { host: lanHost } });
    assert.equal(sseNoToken.status, 401, 'SSE 无令牌必须 401');
    const loopbackNoToken = await request(port, '/api/live/snapshot');
    assert.equal(loopbackNoToken.status, 401, '强制鉴权对回环同样生效');

    // 静态外壳与角色图不含数据，可先加载。
    const shell = await request(port, '/live', { headers: { host: lanHost } });
    assert.equal(shell.status, 200, '/live 外壳可先加载');
    const asset = await request(port, '/live-assets/whale-pixel-idle.png', { headers: { host: lanHost } });
    assert.equal(asset.status, 200, '角色图可先加载');

    // 有效令牌 + LAN Host：数据与 SSE 放行。
    const snap = await request(port, '/api/live/snapshot', { headers: { host: lanHost, ...auth } });
    assert.equal(snap.status, 200);
    const snapJson = JSON.parse(snap.body);
    assert.equal(snapJson.ok, true);
    assert.equal(snapJson.console.lanAccess, true, '快照暴露局域网状态');
    assert.equal(snapJson.console.authRequired, true, '快照暴露强制鉴权状态');
    const sse = await sseFirstFrame(port, `/api/live/stream?token=${TOKEN}`, { host: lanHost });
    assert.equal(sse.status, 200);
    assert.match(sse.headers['content-type'], /text\/event-stream/);
    const sseFrame = JSON.parse(sse.frame);
    assert.equal(typeof sseFrame.ts, 'number', 'SSE 首帧是完整快照');
    assert.equal(sseFrame.console.lanAccess, true, 'SSE 快照同样暴露局域网状态');

    // DNS-rebinding：evil 域名带令牌也拒。
    const evil = await request(port, '/api/live/snapshot', { headers: { host: `evil.example:${port}`, ...auth } });
    assert.equal(evil.status, 403);
    assert.match(evil.body, /Host 头不被允许/);

    // 回环仍可用（带令牌）。
    const loopback = await request(port, '/api/live/snapshot', { headers: auth });
    assert.equal(loopback.status, 200);

    // CSRF：LAN 来源的写请求放行到业务层（404=过了闸门），evil 来源仍 403。
    const lanWrite = await request(port, '/api/no-such-endpoint', {
      method: 'POST',
      headers: { host: lanHost, ...auth, 'content-type': 'application/json', origin: `http://${LAN_IP}:${port}` },
      body: '{}'
    });
    assert.equal(lanWrite.status, 404, 'LAN Origin 写请求应过闸门落到业务 404');
    const evilWrite = await request(port, '/api/no-such-endpoint', {
      method: 'POST',
      headers: { host: lanHost, ...auth, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}'
    });
    assert.equal(evilWrite.status, 403);
  } finally { await stopHarness(ctx); }
});

test('开启局域网 + 鉴权本就开启：行为一致，快照状态正确', async () => {
  const ctx = await startHarness(
    { consoleToken: TOKEN, consoleLanAccess: true, consoleAuth: { enabled: true } },
    { os: fixtureOs }
  );
  try {
    assert.equal(ctx.server.address().address, '0.0.0.0');
    const port = ctx.port;
    const snap = await request(port, '/api/live/snapshot', { headers: { host: `${LAN_IP}:${port}`, 'x-console-token': TOKEN } });
    assert.equal(snap.status, 200);
    assert.equal(JSON.parse(snap.body).console.authRequired, true);
    const noToken = await request(port, '/api/live/snapshot', { headers: { host: `${LAN_IP}:${port}` } });
    assert.equal(noToken.status, 401);
  } finally { await stopHarness(ctx); }
});