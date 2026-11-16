#!/usr/bin/env node
// Phase A 接线：默认关无表无提示；开启后记录/注入；跨群隔离；清空可用。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './bridge-harness.mjs';

function request(port, pathname, { method = 'GET', token = '', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
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

function append(h, key, userId, name, text, messageId, directed = false) {
  return h.appendSimulationMessage(key, name, text, text, false, false, messageId, [], userId, [], { text, directed });
}

console.log('## 默认关闭：不建 social_* 表、提示词无新增段');
{
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456', '789'] } } });
  try {
    assert.equal(h.cfg.simulation.socialMemory.enabled, false);
    const dbFile = path.join(h.temp, 'state', 'db', 'bridge.db');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    db.close();
    assert.equal(names.includes('persons'), false);
    assert.equal(names.includes('episodes'), false);
    append(h, 'group:789', '20001', '甲', '在吗', 'off-1');
    const prompt = h.buildWakePrompt('group:789', 'timeout');
    for (const marker of ['【人物档案】', '【当前线程】', '【收件人观测】', '【语域】']) {
      assert.ok(!prompt.includes(marker), `关闭时不得出现 ${marker}`);
    }
  } finally { await h.close(); }
}
console.log('OK 默认关闭');

console.log('## 开启：记录经历、注入人物/线程/收件人/语域');
{
  const h = await bridgeHarness({
    config: {
      allow: { private: ['123'], groups: ['456', '789'] },
      simulation: {
        socialMemory: { enabled: true },
        attention: { enabled: true },
        addressing: { enabled: true },
        register: { enabled: true }
      }
    }
  });
  const server = h.startConsoleServer();
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const token = String(h.cfg.consoleToken);
  try {
    append(h, 'group:789', '20001', '甲', '今天一起看比赛吧', 'on-1', true);
    append(h, 'group:789', '20002', '乙', '好啊，我来', 'on-2');
    append(h, 'group:789', '20001', '甲', '几点开始', 'on-3', true);
    const sm = h.getSocialMemory();
    assert.ok(sm && sm.enabled, '开启后应有 SocialMemory');
    const ctx = sm.buildContextLine('group:789', h.getSimulationState('group:789'), { triggerUserId: '20001' });
    assert.match(ctx, /甲|乙/, '社会上下文应包含人物称呼');
    assert.ok(!/\b2000[12]\b/.test(ctx), '上下文不得包含原始 QQ 号');

    const prompt = h.buildWakePrompt('group:789', 'timeout');
    assert.match(prompt, /【当前线程】/);
    assert.match(prompt, /【收件人观测】/);
    assert.match(prompt, /【语域】/);
    assert.match(prompt, /【人物档案】|【认识的人】/);

    const status = await request(port, '/api/social-memory', { token });
    assert.equal(status.status, 200);
    assert.equal(status.json.enabled, true);
    assert.ok(Number(status.json.counts.episodes) >= 1, '应记录至少一段经历');
    assert.ok(Number(status.json.counts.identities) >= 2, '应有稳定身份');

    const cleared = await request(port, '/api/social-memory', {
      token, method: 'POST', body: { action: 'clear', confirm: 'clear' }
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.ok(Number(cleared.json.status.counts.episodes) === 0);
    assert.ok(Number(cleared.json.status.counts.identities) === 0);
  } finally {
    server.close();
    await h.close();
  }
}
console.log('OK 开启接线');

console.log('## 跨群隔离：别的群的共同经历不进来');
{
  const h = await bridgeHarness({
    config: {
      allow: { private: ['123'], groups: ['456', '789'] },
      simulation: { socialMemory: { enabled: true } }
    }
  });
  try {
    append(h, 'group:456', '30001', '丙', '只属于456群的暗号经历', 'iso-1', true);
    append(h, 'group:456', '30002', '丁', '收到', 'iso-2');
    append(h, 'group:789', '20001', '甲', '789群在聊别的', 'iso-3', true);
    append(h, 'group:789', '20002', '乙', '嗯', 'iso-4');
    const sm = h.getSocialMemory();
    const ctx = sm.buildContextLine('group:789', h.getSimulationState('group:789'), { triggerUserId: '20001' });
    assert.ok(!ctx.includes('暗号经历'), '不得把 456 群的经历带进 789 群');
  } finally { await h.close(); }
}
console.log('OK 跨群隔离');

console.log('OK Phase A 接线');