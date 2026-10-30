// Stage 4 回归：事件总线、feature loader、传输适配器、预算与隐私契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '../src/core/event-bus.js';
import { loadFeatures, FeatureHost } from '../src/core/feature-loader.js';
import { createTransport, parseTargetKey } from '../src/core/transport.js';
import { openDatabase } from '../src/core/db.js';
import { BudgetStore, shanghaiDayKey, dayStartMs } from '../src/core/budget.js';

test('event-bus: 优先级、通配、错误隔离与超时', async () => {
  const logs = [];
  const bus = new EventBus({ logger: (m) => logs.push(m), defaultTimeoutMs: 200 });
  const order = [];
  bus.on('demo', () => order.push('low'), { priority: 1 });
  bus.on('demo', async () => { order.push('high'); }, { priority: 10 });
  bus.on('*', () => order.push('wild'));
  bus.on('demo', () => { throw new Error('boom'); }, { id: 'bad', priority: 5 });
  bus.on('demo', async () => new Promise(() => {}), { id: 'slow', priority: 4 });
  const result = await bus.emit('demo', {});
  assert.equal(order[0], 'high');
  assert.ok(order.includes('low'));
  assert.ok(order.includes('wild'));
  assert.equal(result.errors.length, 2, '抛错与超时都被隔离并记录');
  assert.ok(logs.some((l) => l.includes('boom')));

  const prefix = [];
  bus.on('turn.*', () => prefix.push('turn'));
  await bus.emit('turn/end', {});
  assert.deepEqual(prefix, ['turn']);
});

test('feature-loader: manifest 校验、禁用、setup 隔离、formatSegment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-features-'));
  const write = (id, code) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'index.js'), code);
  };
  write('good', `export default { id:'good', name:'Good', version:1, permissions:['state:read'], setup(ctx){ ctx.seen = true; }, hooks:{ formatSegment(seg){ return seg.type === 'x' ? '[X]' : null; } } };`);
  write('bad-id', `export default { id:'wrong', name:'Bad', hooks:{} };`);
  write('bad-perm', `export default { id:'bad-perm', name:'BadPerm', permissions:['root:all'], hooks:{} };`);
  write('boom', `export default { id:'boom', name:'Boom', hooks:{}, setup(){ throw new Error('setup failed'); } };`);
  write('off', `export default { id:'off', name:'Off', hooks:{} };`);

  const logs = [];
  const host = await loadFeatures({
    dir,
    disabled: ['off'],
    logger: (m) => logs.push(m),
    ctx: { cfg: {}, log: () => {}, getState: () => ({ ok: true }) }
  });
  assert.equal(host.has('good'), true);
  assert.equal(host.has('off'), false);
  assert.equal(host.has('bad-id'), false);
  assert.equal(host.has('bad-perm'), false);
  assert.equal(host.has('boom'), false, 'setup 抛错应禁用该 feature');
  assert.equal(host.formatSegment({ type: 'x' }), '[X]');
  assert.equal(host.formatSegment({ type: 'y' }), null);
  assert.ok(logs.some((l) => l.includes('setup failed')));

  await host.start();
  const stats = host.stats();
  assert.ok(stats.features.some((f) => f.id === 'good' && f.enabled));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('feature-loader: 仓库内真实 feature 可加载（日报/卡片）', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const host = await loadFeatures({
    dir: path.join(root, 'src', 'features'),
    logger: () => {},
    ctx: {
      cfg: { simulation: { dailyReport: { enabled: false } } },
      log: () => {},
      getState: () => ({}),
      jobs: { register: () => {} },
      send: async () => true,
      dailyReport: { run: async () => ({}), sync: () => 0 }
    }
  });
  const ids = host.list().filter((f) => f.enabled).map((f) => f.id);
  assert.ok(ids.includes('daily-report'), `应加载日报 feature，实际：${ids.join(',')}`);
  assert.ok(ids.includes('rich-cards'), `应加载卡片 feature，实际：${ids.join(',')}`);
  const card = host.formatSegment({ type: 'json', data: { data: JSON.stringify({ meta: { news: { title: '标题', jumpUrl: 'https://example.com' } } }) } });
  assert.match(card, /卡片消息/);
  assert.ok(!card.includes('meta'), '不能把原始 JSON 透传');
});

test('transport: SnowLuma 纯文本走 WS、引用/@ 走 HTTP；OneBot 全走 HTTP；能力矩阵拒绝不支持', async () => {
  const calls = { ws: [], http: [] };
  const snow = createTransport({
    kind: 'snowluma',
    sendWs: async (p) => { calls.ws.push(p); return { message_id: 1 }; },
    sendHttp: async (p) => { calls.http.push(p); return { message_id: 2 }; }
  });
  assert.deepEqual(parseTargetKey('group:123'), { kind: 'group', id: 123 });
  assert.throws(() => parseTargetKey('bad'));
  await snow.sendText({ key: 'group:123', text: 'hi' });
  assert.equal(calls.ws.length, 1);
  assert.equal(calls.http.length, 0);
  await snow.sendText({ key: 'group:123', text: 'hi', replyToMessageId: 9 });
  assert.equal(calls.http.length, 1, '引用必须走 HTTP action');
  await snow.sendText({ key: 'private:123', text: 'hi', via: 'http' });
  assert.equal(calls.http.length, 2);
  assert.equal(snow.supports('voice'), true);
  assert.equal(snow.supports('nope'), false);

  const one = createTransport({
    kind: 'onebot',
    sendWs: async () => { throw new Error('不应走 WS'); },
    sendHttp: async (p) => { calls.http.push(p); return { message_id: 3 }; }
  });
  await one.sendText({ key: 'group:123', text: 'hi' });
  assert.equal(one.kind, 'onebot');
  assert.equal(one.supports('voice'), false);
  assert.throws(() => one.require('voice'), /不支持 voice/);
  const media = await one.sendMedia({ key: 'group:123', media: [{ type: 'image' }] });
  assert.equal(media.message_id, 3);
  assert.equal(one.describe().kind, 'onebot');
});

test('budget: 按天/按会话记账、幂等、限额判定', () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const now = Date.UTC(2026, 9, 26, 6, 0); // 上海 14:00
  const store = new BudgetStore({ db, now: () => now, logger: () => {} });
  assert.equal(shanghaiDayKey(now), '2026-10-26');
  assert.equal(dayStartMs(now), Date.UTC(2026, 9, 25, 16, 0));

  assert.equal(store.record({ key: 'group:1', sessionId: 's1', turn: 1, step: 1, tokensIn: 1000, tokensOut: 100, cost: 0.01 }), true);
  assert.equal(store.record({ key: 'group:1', sessionId: 's1', turn: 1, step: 1, tokensIn: 1000, tokensOut: 100, cost: 0.01 }), false, '同一 turn/step 幂等');
  store.record({ key: 'group:2', sessionId: 's2', turn: 1, step: 1, tokensIn: 500, tokensOut: 50 });
  const own = store.dayUsage({ key: 'group:1' });
  assert.equal(own.tokens, 1100);
  const global = store.dayUsage();
  assert.equal(global.tokens, 1650);
  assert.equal(store.check('group:1', { dailyTokensPerKey: 2000 }).allowed, true);
  assert.equal(store.check('group:1', { dailyTokensPerKey: 1000 }).allowed, false);
  assert.equal(store.check('group:1', { dailyTokensPerKey: 1000 }).scope, 'key');
  assert.equal(store.check('group:1', { dailyTokensGlobal: 1000 }).scope, 'global');
  assert.equal(store.stats().turns, 2);
  assert.equal(store.recent({ limit: 5 }).length, 2);
  db.close();
});
