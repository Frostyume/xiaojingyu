#!/usr/bin/env node
// B3 桥接接线：默认关闭不建/不排；开启但未配源时安全跳过；面板与 /api/life 权限。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './bridge-harness.mjs';

function request(port, pathname, { method = 'GET', token = '', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(token ? { 'x-console-token': token } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

console.log('## 默认关闭：不建生活表、不排任务');
{
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456'] } } });
  try {
    assert.equal(h.cfg.simulation.lifeButler.enabled, false);
    // 数据库里不应出现 life_* 表（关闭态不初始化生活管家）。
    const dbFile = path.join(h.temp, 'state', 'db', 'bridge.db');
    assert.ok(fs.existsSync(dbFile), 'SQLite 应已初始化');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'life_%'").all().map((r) => r.name);
    db.close();
    assert.deepEqual(tables, [], '关闭时不建 life 表');
    const queue = h.getJobQueue();
    const jobs = typeof queue?.list === 'function' ? queue.list() : [];
    assert.equal(jobs.some((job) => String(job.type || '').startsWith('life.')), false, '关闭时不排生活任务');
  } finally { await h.close(); }
}
console.log('OK 默认关闭');

console.log('## 面板：关闭态可读可改配置，但不伪造运行状态');
{
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456'] } } });
  const server = h.startConsoleServer();
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const token = String(h.cfg.consoleToken);
  try {
    const panel = await request(port, '/api/features/life-panel', { token });
    assert.equal(panel.status, 200, JSON.stringify(panel.json));
    assert.equal(panel.json.ok, true);
    assert.equal(panel.json.enabled, false);
    assert.equal(panel.json.paper.enabled, false);
    assert.equal(panel.json.status.paper.enabled, false, '关闭态不得伪造运行中');

    const saved = await request(port, '/api/features/life-panel', {
      token,
      method: 'POST',
      body: { action: 'save', values: { 'lifeButler.modules.paper.time': '10:15' } }
    });
    assert.equal(saved.status, 200, saved.json?.error);
    assert.ok(saved.json.applied.includes('simulation.lifeButler.modules.paper.time'));
    assert.equal(h.cfg.simulation.lifeButler.modules.paper.time, '10:15');

    const bad = await request(port, '/api/features/life-panel', {
      token,
      method: 'POST',
      body: { action: 'save', values: { 'lifeButler.modules.paper.time': '25:00' } }
    });
    assert.equal(bad.status, 400, '非法时间必须拒绝');
  } finally {
    server.close();
    await h.close();
  }
}
console.log('OK 面板');

console.log('## 开启但未配源：安全启动、只读接口可用');
{
  const h = await bridgeHarness({
    config: {
      ownerQQ: 123,
      allow: { private: ['123'], groups: ['456'] },
      simulation: { lifeButler: { enabled: true } }
    }
  });
  await h.syncLifeButler();
  const server = h.startConsoleServer();
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const token = String(h.cfg.consoleToken);
  const agentToken = h.getSimulationState('private:123').agentToken;
  try {
    const panel = await request(port, '/api/features/life-panel', { token });
    assert.equal(panel.json.enabled, true);
    assert.equal(panel.json.status.paper.enabled, false, '未开启子模块');

    const status = await request(port, '/api/life/status', {
      token,
      method: 'POST',
      body: { key: 'private:123', token: agentToken }
    });
    assert.equal(status.status, 200, status.json?.error);
    assert.equal(status.json.ok, true, JSON.stringify(status.json));
    assert.equal(status.json.enabled, true);
    assert.equal(Array.isArray(status.json.adapters), true);

    const wrongKey = await request(port, '/api/life/status', {
      token,
      method: 'POST',
      body: { key: 'group:456', token: agentToken }
    });
    assert.equal(wrongKey.status, 403, '只允许主人私聊');
  } finally {
    server.close();
    await h.close();
  }
}
console.log('OK 未配源安全启动');

console.log('OK B3 生活管家接线');