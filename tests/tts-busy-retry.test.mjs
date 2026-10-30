// BreezeTTS2 单并发槽位的忙时重试：409/503 指数退避，非忙状态立刻返回。
import http from 'node:http';
import { fetchWithBusyRetry, TtsBusyError } from '../runtime/persona/tts-busy-retry.js';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
};

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const readBody = (req) => new Promise((resolve) => {
  let size = 0;
  req.on('data', (chunk) => { size += chunk.length; });
  req.on('end', () => resolve(size));
});

// 1) 409, 409, 200
{
  let attempts = 0;
  const { server, port } = await startServer(async (req, res) => {
    attempts += 1;
    await readBody(req);
    if (attempts < 3) { res.writeHead(409); res.end('busy'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const res = await fetchWithBusyRetry(`http://127.0.0.1:${port}/x`, { method: 'POST', body: 'hello' }, {
    totalMs: 2000, baseDelayMs: 10, maxDelayMs: 20, jitterMs: 0
  });
  ok(res.status === 200 && (await res.text()) === 'ok', '409 两次后成功');
  ok(attempts === 3, '重试次数正确（3 次）');
  server.close();
}

// 2) FormData 可以重复发送
{
  let attempts = 0;
  let firstBody = 0;
  let secondBody = 0;
  const { server, port } = await startServer(async (req, res) => {
    attempts += 1;
    const size = await readBody(req);
    if (attempts === 1) firstBody = size;
    else secondBody = size;
    if (attempts === 1) { res.writeHead(409); res.end('busy'); return; }
    res.writeHead(200); res.end('ok');
  });
  const fd = new FormData();
  fd.append('text', '测试');
  fd.append('instruction', '自然');
  const res = await fetchWithBusyRetry(`http://127.0.0.1:${port}/x`, { method: 'POST', body: fd }, {
    totalMs: 2000, baseDelayMs: 10, maxDelayMs: 20, jitterMs: 0
  });
  ok(res.status === 200, 'FormData 重试后成功');
  ok(attempts === 2 && firstBody > 0 && secondBody > 0, '重试时 FormData 仍被完整发送');
  server.close();
}

// 3) 一直忙 → TtsBusyError
{
  let attempts = 0;
  const { server, port } = await startServer(async (req, res) => {
    attempts += 1;
    await readBody(req);
    res.writeHead(409); res.end('busy');
  });
  let error = null;
  try {
    await fetchWithBusyRetry(`http://127.0.0.1:${port}/x`, { method: 'POST', body: 'x' }, {
      totalMs: 120, baseDelayMs: 20, maxDelayMs: 40, jitterMs: 0, label: '测试通道'
    });
  } catch (e) { error = e; }
  ok(error instanceof TtsBusyError && error.code === 'TTS_BUSY', '预算耗尽抛出 TtsBusyError');
  ok(attempts >= 2, '预算耗尽前确实重试过');
  ok(/测试通道/.test(error?.message || ''), '错误信息带通道名');
  server.close();
}

// 4) 非忙错误不重试
{
  let attempts = 0;
  const { server, port } = await startServer(async (req, res) => {
    attempts += 1;
    await readBody(req);
    res.writeHead(400); res.end('bad');
  });
  const res = await fetchWithBusyRetry(`http://127.0.0.1:${port}/x`, { method: 'POST', body: 'x' }, {
    totalMs: 500, baseDelayMs: 10, maxDelayMs: 20, jitterMs: 0
  });
  ok(res.status === 400 && attempts === 1, '400 立即返回、不重试');
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
