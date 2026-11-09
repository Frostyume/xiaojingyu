#!/usr/bin/env node
/**
 * 见闻排程热更新回归：只改见闻的开/关（控制台子键、主人白名单总开关）也必须立刻重排 outerWorld.run。
 *
 * 全部离线：桥接跑在临时 ROOT 的 VM 里，QQ 网关是假 sendToQQ，控制台只监听 127.0.0.1 的随机端口，
 * 不连真实 QQ、不发消息、不访问外网。高危确认闸门用 controlTiers.enabled=false 关掉，
 * 只为把「写配置 → 重排」这一段单独跑通；闸门本身由 tests/control-tiers.test.mjs 覆盖。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './bridge-harness.mjs';

const OWNER_KEY = 'private:123';
const OUTER_JOB = 'outerWorld.run';

function request(port, pathname, { method = 'GET', token = '', agentToken = '', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}` };
    if (token) headers['x-console-token'] = token;
    if (agentToken) {
      headers['x-agent-token'] = agentToken;
      headers['x-agent-call'] = '1';
    }
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers.origin = `http://127.0.0.1:${port}`;
    }
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function listen(server) {
  if (server.listening) return server.address().port;
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server.address().port;
}

const h = await bridgeHarness({
  config: {
    features: { outerWorld: true },
    simulation: {
      nightQuiet: { enabled: false },
      controlTiers: { enabled: false },
      outerWorld: {
        schedule: { minGapMs: 7200000, window: { start: '09:00', end: '23:00' } },
        leisure: { enabled: false, sources: [{ id: 'ow-sched', title: '排程读物', url: 'https://example.invalid/book' }] }
      }
    }
  }
});

let server = null;
try {
  const job = () => h.getJobQueue()?.findByDedupe(OUTER_JOB) ?? null;
  const jobState = () => job()?.state ?? 'none';
  const sent = () => h.calls?.sent?.length ?? 0;
  assert.equal(jobState(), 'none', '关闭态启动不应留下见闻待办');

  await h.setMode('simulation');
  await h.ensureSession(OWNER_KEY);
  const ownerToken = String(h.getSimulationState(OWNER_KEY).agentToken ?? '');
  assert.ok(ownerToken, '主人会话应拿到 agent token');

  server = h.startConsoleServer();
  const port = await listen(server);
  const call = (pathname, opts) => request(port, pathname, { token: String(h.cfg.consoleToken), ...opts });
  const applyValues = async (values) => (await call('/api/config/apply', { method: 'POST', body: { patch: values } })).json;
  const ownerSet = async (configKey, value) => (await call('/api/simulation/owner-config', {
    method: 'POST',
    agentToken: ownerToken,
    body: { key: OWNER_KEY, token: ownerToken, action: 'set', configKey, value, confirm: true }
  })).json;
  const sentBefore = sent();

  // ── 1. 控制台只改见闻子开关：早退守卫必须放行 simulation.outerWorld.* ──────
  const on = await applyValues({ 'simulation.outerWorld.leisure.enabled': true });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(h.cfg.simulation.outerWorld.leisure.enabled, true, '子开关应热更新进运行期 cfg');
  assert.equal(jobState(), 'pending', '只改见闻子开关也必须把 outerWorld.run 排上队');
  const firstRunAfter = Number(job()?.runAfter) || 0;
  assert.ok(firstRunAfter >= Date.now() - 5000, `排程时间应按改动后的配置重算，实际 ${new Date(firstRunAfter).toISOString()}`);

  // ── 2. 关掉子开关：不留待办 ─────────────────────────────────────────────
  assert.equal((await applyValues({ 'simulation.outerWorld.leisure.enabled': false })).ok, true);
  assert.notEqual(jobState(), 'pending', '关闭子开关后不该留下待办任务');

  // ── 3. 子开关重开：立刻续上，且排程时间按新配置重算 ─────────────────────
  // 上一条见闻设在 1 小时前：minGap 5h → 下一条约在 +4h；改成 8h → 约在 +7h。
  const notesFile = path.join(h.temp, 'state', 'outer-world-notes.jsonl');
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.writeFileSync(notesFile, `${JSON.stringify({ id: 'fixture-note', title: '排程读物', at: Date.now() - 3600 * 1000 })}\n`, 'utf8');
  h.cfg.simulation.outerWorld.schedule.window = { start: '00:00', end: '23:59' };
  assert.equal((await applyValues({ 'simulation.outerWorld.leisure.enabled': true, 'simulation.outerWorld.schedule.minGapMs': 5 * 3600 * 1000 })).ok, true);
  assert.equal(jobState(), 'pending', '重新打开子开关必须立刻续上排程，而不是等一次重启');
  const atWithShortGap = Number(job()?.runAfter) || 0;
  assert.notEqual(atWithShortGap, firstRunAfter, '排程时间要按改动后的配置重算，不能沿用旧值');

  assert.equal((await applyValues({ 'simulation.outerWorld.leisure.enabled': false })).ok, true);
  assert.equal((await applyValues({ 'simulation.outerWorld.leisure.enabled': true, 'simulation.outerWorld.schedule.minGapMs': 8 * 3600 * 1000 })).ok, true);
  assert.equal(jobState(), 'pending', '关一次再开也要立刻续上');
  const atWithLongGap = Number(job()?.runAfter) || 0;
  assert.ok(Math.abs((atWithLongGap - atWithShortGap) - 3 * 3600 * 1000) < 60 * 1000,
    `minGap 从 5h 改到 8h，下次时间应推后约 3h，实际差 ${Math.round((atWithLongGap - atWithShortGap) / 60000)} 分钟`);

  // ── 4. 主人白名单总开关：写入后同样要重排（否则重开得靠重启） ────────────
  const offFeature = await ownerSet('feature.outerWorld', false);
  assert.equal(offFeature.ok, true, JSON.stringify(offFeature));
  assert.equal(h.cfg.features.outerWorld, false, '总开关应热更新进运行期 cfg');
  assert.notEqual(jobState(), 'pending', '主人关掉总开关后不该留下待办任务');
  assert.equal((await ownerSet('feature.outerWorld', true)).ok, true);
  assert.equal(h.cfg.features.outerWorld, true);
  assert.equal(jobState(), 'pending', '主人重新打开总开关必须立刻续上排程，而不是等一次重启');

  // ── 5. 全程零副作用：没有真实出站消息 ──────────────────────────────────
  assert.equal(sent(), sentBefore, '本用例不得发出任何 QQ 消息');
  console.log('OK 见闻排程热更新：子键与白名单总开关都能立刻重排，关闭不留待办');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await h.close();
}
