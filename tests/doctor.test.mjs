// doctor 纯函数与探测 helper 的离线回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  parseNetstatListens, parseProcessList, isDshProcess, isSnowLumaProcess,
  listeningPortsOf, probeDshPorts, checkTcp, classifyLogLines, deepMerge,
  freeDiskSpace, tailLines, pidAlive
} from '../runtime/kernel/health.js';

test('parseNetstatListens: 只取 LISTENING 且解析 pid', () => {
  const text = [
    '  TCP    127.0.0.1:3100         0.0.0.0:0              LISTENING       42448',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       976',
    '  TCP    127.0.0.1:5000         127.0.0.1:6000         ESTABLISHED     1234',
    '  UDP    0.0.0.0:500             *:*                                    999'
  ].join('\r\n');
  const rows = parseNetstatListens(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { addr: '127.0.0.1', port: 3100, pid: 42448 });
});

test('parseProcessList / 进程分类', () => {
  const json = JSON.stringify([
    { ProcessId: 1, Name: 'DeepSeek Harness.exe', Cmd: 'x --expose-internals' },
    { ProcessId: 2, Name: 'snowluma.exe', Cmd: 'snowluma' },
    { ProcessId: 3, Name: 'node.exe', Cmd: 'bridge.js' }
  ]);
  const procs = parseProcessList(json);
  assert.equal(procs.length, 3);
  assert.equal(procs.filter(isDshProcess).length, 1);
  assert.equal(procs.filter(isSnowLumaProcess).length, 1);
  const listens = parseNetstatListens([
    '  TCP    127.0.0.1:49983        0.0.0.0:0              LISTENING       1',
    '  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       2'
  ].join('\n'));
  assert.deepEqual(listeningPortsOf(procs, listens), [3001, 49983]);
});

test('probeDshPorts: 401 + dsh 响应体才算 DSH；超时不误判', async () => {
  const fakeFetch = async (url) => {
    if (url.includes(':49983')) {
      return { status: 401, text: async () => 'dsh unauthorized', headers: new Map() };
    }
    if (url.includes(':5173')) {
      return { status: 200, text: async () => '<html>vite</html>', headers: new Map() };
    }
    throw new Error('ECONNREFUSED');
  };
  const results = await probeDshPorts([49983, 5173, 6000], { fetchImpl: fakeFetch });
  assert.equal(results.find((r) => r.port === 49983).looksDsh, true);
  assert.equal(results.find((r) => r.port === 5173).looksDsh, false);
  assert.equal(results.find((r) => r.port === 6000).looksDsh, false);
});

test('checkTcp: 本机监听可连、未监听报错', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const ok = await checkTcp('127.0.0.1', port, 1000);
  assert.equal(ok.ok, true);
  await new Promise((resolve) => server.close(resolve));
  const bad = await checkTcp('127.0.0.1', port, 500);
  assert.equal(bad.ok, false);
});

test('classifyLogLines: 只留可疑行且脱敏', () => {
  const lines = [
    '正常一行',
    'QQ 发送失败 (group:1): timeout',
    'token=abcdef123456 错误',
    '⚠️ DSH 端口不可达',
    'error: Bearer abcdefghijklmnop failed',
    '自愈完成：账号 123456789（error {}）'
  ];
  const out = classifyLogLines(lines);
  assert.ok(out.some((l) => l.includes('QQ 发送失败')));
  assert.ok(out.every((l) => !l.includes('abcdef123456')));
  assert.ok(out.every((l) => !l.includes('abcdefghijklmnop')));
  assert.ok(out.every((l) => !l.includes('123456789')), 'QQ 号必须脱敏');
  assert.ok(!out.some((l) => l.includes('自愈完成')), '成功完成的自愈不应算作错误');
});

test('deepMerge: 对象深合并、数组/标量覆盖', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2], flag: true };
  const out = deepMerge(base, { a: { c: 3 }, list: [9], flag: false });
  assert.deepEqual(out, { a: { b: 1, c: 3 }, list: [9], flag: false });
});

test('tailLines / freeDiskSpace / pidAlive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-doctor-'));
  const file = path.join(dir, 'log.txt');
  fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n'));
  const lines = tailLines(file, 3);
  assert.deepEqual(lines.slice(-2), ['line-8', 'line-9']);
  assert.equal(tailLines(path.join(dir, 'nope.txt'), 3).length, 0);

  const disk = freeDiskSpace(dir);
  assert.ok(disk === null || (disk.total > 0 && disk.free >= 0));
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
