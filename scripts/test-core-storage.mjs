// Stage 1 可靠性底座回归：SQLite 适配层 / outbox / jobs / inbox / 配置 schema / 结构化日志。
// 全部离线，不碰生产 state、不发 QQ、不需要 DSH。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, pruneDatabase, SCHEMA_VERSION } from '../src/core/db.js';
import { Outbox } from '../src/core/outbox.js';
import { JobQueue } from '../src/core/jobs.js';
import { Inbox, inboundDedupeKey } from '../src/core/inbox.js';
import {
  CONFIG_VERSION, buildConfigSchema, validateConfigPatch, validateConfigObject,
  migrateConfigObject, applyConfigPatch, validateField
} from '../src/core/config-schema.js';
import { createJsonlLogger, readRecentLogs, redactLogText } from '../src/core/logger.js';

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqb-${label}-`));
}

test('db: 迁移建表、幂等、WAL、事务回滚', () => {
  const dir = tmpDir('db');
  const file = path.join(dir, 'bridge.db');
  const db = openDatabase({ file, logger: () => {} });
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  for (const name of ['events', 'outbox', 'jobs', 'memory_facts', 'member_relationships', 'usage_ledger', 'schema_migrations']) {
    assert.ok(tables.includes(name), `缺少表 ${name}`);
  }
  assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal');
  const version = db.get('SELECT MAX(version) AS v FROM schema_migrations').v;
  assert.equal(version, SCHEMA_VERSION);

  // 重开：不应重复应用迁移
  db.close();
  const db2 = openDatabase({ file, logger: () => {} });
  assert.equal(db2.all('SELECT * FROM schema_migrations').length, SCHEMA_VERSION);
  // 事务回滚
  assert.throws(() => db2.transaction(() => {
    db2.run('INSERT INTO meta(key, value) VALUES (?, ?)', 'a', '1');
    throw new Error('boom');
  }));
  assert.equal(db2.get('SELECT COUNT(*) AS n FROM meta').n, 0);
  db2.run('INSERT INTO meta(key, value) VALUES (?, ?)', 'a', '1');
  assert.equal(db2.get('SELECT value FROM meta WHERE key = ?', 'a').value, '1');
  const stat = db2.stats();
  assert.ok(stat.bytes > 0);
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('db: 迁移前自动备份并清理旧备份', () => {
  const dir = tmpDir('dbbackup');
  const file = path.join(dir, 'bridge.db');
  const backupDir = path.join(dir, 'backups');
  const db = openDatabase({ file, logger: () => {} });
  // 模拟已有旧库 + 旧备份
  fs.mkdirSync(backupDir, { recursive: true });
  const old = path.join(backupDir, 'bridge-old.db');
  fs.writeFileSync(old, 'x');
  const oldTime = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(old, oldTime, oldTime);
  // 删掉迁移记录，模拟升级（保留一条 v0，触发「库已存在」的备份分支）
  db.run('DELETE FROM schema_migrations');
  db.run('INSERT INTO schema_migrations(version, applied_at, note) VALUES (0, ?, ?)', Date.now(), 'legacy');
  db.close();
  const db2 = openDatabase({ file, backupDir, backupKeepDays: 7, logger: () => {} });
  assert.ok(db2.get('SELECT COUNT(*) AS n FROM schema_migrations').n >= 1);
  assert.equal(fs.existsSync(old), false, '超过保留期的备份应被清理');
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('outbox: 落盘、去重、成功后不再重发', async () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const sent = [];
  const box = new Outbox({ db, deliver: async (payload) => { sent.push(payload.text); return { message_id: 'm1' }; }, logger: () => {} });
  const first = await box.sendNow({ key: 'group:1', payload: { text: '你好' }, dedupeKey: 'k1' });
  assert.equal(first.ok, true);
  assert.equal(first.state, 'sent');
  assert.deepEqual(sent, ['你好']);
  const second = await box.sendNow({ key: 'group:1', payload: { text: '你好' }, dedupeKey: 'k1' });
  assert.equal(second.duplicate, true);
  assert.equal(second.ok, true);
  assert.deepEqual(sent, ['你好'], '同一 dedupeKey 不得重复投递');
  assert.equal(box.stats().byState.sent, 1);
  db.close();
});

test('outbox: 失败留 pending 并退避重试，最终 dead', async () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  let attempts = 0;
  const box = new Outbox({
    db,
    maxAttempts: 3,
    retryBaseMs: 1000,
    deliver: async () => { attempts += 1; throw new Error('network down'); },
    logger: () => {}
  });
  const result = await box.sendNow({ key: 'group:1', payload: { text: 'x' }, dedupeKey: 'k2' });
  assert.equal(result.ok, false);
  assert.equal(result.queued, true);
  assert.equal(result.state, 'pending');
  assert.equal(attempts, 1);
  const row = box.list({ state: 'pending' })[0];
  assert.match(row.lastError, /network down/);
  assert.ok(row.nextAttemptAt > Date.now());
  db.close();
});

test('outbox: sending 崩溃恢复为 uncertain，且不自动重发', async () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  let sent = 0;
  const box = new Outbox({ db, deliver: async () => { sent += 1; }, logger: () => {} });
  box.enqueue({ key: 'group:1', payload: { text: 'mid-flight' }, dedupeKey: 'k3' });
  db.run('UPDATE outbox SET state = \'sending\', locked_until = ? WHERE dedupe_key = ?', Date.now() - 1, 'k3');
  const rec = box.recover();
  assert.equal(rec.uncertain, 1);
  assert.equal(box.list({ state: 'uncertain' }).length, 1);
  await box.drain();
  assert.equal(sent, 0, 'uncertain 行不得自动重发');
  assert.equal(box.retry(box.list({ state: 'uncertain' })[0].id), true);
  await box.drain();
  assert.equal(sent, 1, '人工 retry 后才发送');
  db.close();
});

test('outbox: pending 启动重放', async () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const sent = [];
  const box = new Outbox({ db, deliver: async (p) => sent.push(p.text), logger: () => {} });
  box.enqueue({ key: 'private:1', payload: { text: 'replay-me' }, dedupeKey: 'k4' });
  const rec = box.recover();
  assert.equal(rec.pending, 1);
  await box.drain();
  assert.deepEqual(sent, ['replay-me']);
  db.close();
});

test('outbox: 永久错误一次即 dead；holdMs 不消耗重试次数', async () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  let attempts = 0;
  const box = new Outbox({
    db,
    maxAttempts: 5,
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) { const e = new Error('静默模式'); e.holdMs = 60000; throw e; }
      const e = new Error('目标不在白名单'); e.permanent = true; throw e;
    },
    logger: () => {}
  });
  const first = await box.sendNow({ key: 'group:1', payload: { text: 'hold' }, dedupeKey: 'hold-1' });
  assert.equal(first.state, 'pending');
  const row = box.list({ state: 'pending' })[0];
  assert.equal(row.attempts, 0, 'holdMs 不消耗 attempts');
  assert.match(row.lastError, /静默模式/);

  // 让挂起到期后再次尝试 → 永久错误直接 dead
  db.run('UPDATE outbox SET next_attempt_at = ? WHERE id = ?', Date.now() - 1, row.id);
  const outcome = await box.drainOnce();
  assert.equal(outcome, 'dead');
  assert.equal(box.list({ state: 'dead' }).length, 1);
  db.close();
});

test('jobs: 去重、成功、失败重试与 dead', async () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  let runs = 0;
  const q = new JobQueue({ db, tickMs: 60000, retryBaseMs: 1000, logger: () => {} });
  q.register('demo', async () => { runs += 1; return { ok: true }; });
  const a = q.enqueue({ type: 'demo', dedupeKey: 'demo:1', runAfter: 0 });
  const b = q.enqueue({ type: 'demo', dedupeKey: 'demo:1', runAfter: 0 });
  assert.equal(a.id, b.id);
  assert.equal(await q.runDueOnce(), 'done');
  assert.equal(runs, 1);
  assert.equal(q.stats().byState.done, 1);

  q.register('boom', async () => { throw new Error('bad'); });
  q.enqueue({ type: 'boom', dedupeKey: 'boom:1', runAfter: 0, maxAttempts: 1 });
  assert.equal(await q.runDueOnce(), 'dead');
  assert.equal(q.stats().dead, 1);
  assert.ok(q.list({ state: 'dead' })[0].lastError.includes('bad'));
  assert.equal(q.retry(q.list({ state: 'dead' })[0].id), true);
  db.close();
});

test('jobs: 执行中崩溃 → 启动后重新排队', async () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const q = new JobQueue({ db, logger: () => {} });
  q.enqueue({ type: 'x', dedupeKey: 'x:1', runAfter: 0 });
  db.run('UPDATE jobs SET state = \'running\', locked_until = ? WHERE dedupe_key = ?', Date.now() - 1, 'x:1');
  const rec = q.recover();
  assert.equal(rec.stale, 1);
  assert.equal(q.list({ state: 'pending' }).length, 1);
  db.close();
});

test('jobs: clearPending / cancel 记为 cancelled，不污染 dead', () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const q = new JobQueue({ db, logger: () => {} });
  q.enqueue({ type: 'tick', runAfter: 0 });
  assert.equal(q.clearPending('tick'), 1);
  assert.equal(q.list({ state: 'cancelled' }).length, 1);
  assert.equal(q.stats().dead ?? 0, 0);
  q.enqueue({ type: 'reminder.due', dedupeKey: 'r:1', runAfter: 0 });
  assert.equal(q.cancel('r:1'), 1);
  assert.equal(q.list({ state: 'cancelled' }).length, 2);
  db.close();
});

test('inbox: 去重、未处理统计、标记 processed', () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const inbox = new Inbox({ db, logger: () => {} });
  const key = inboundDedupeKey('group', 1, { message_id: 42 });
  assert.equal(key, 'group:1:msg:42');
  const a = inbox.record({ key: 'group:1', kind: 'group', messageId: '42', payload: { message_id: 42 }, dedupeKey: key });
  const b = inbox.record({ key: 'group:1', kind: 'group', messageId: '42', payload: { message_id: 42 }, dedupeKey: key });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(inbox.stats().unprocessed, 1);
  const pending = inbox.pending({ maxAgeMs: 60000 });
  assert.equal(pending.length, 1);
  inbox.markProcessed(pending[0].id);
  assert.equal(inbox.stats().unprocessed, 0);
  db.close();
});

test('inbox: 过旧未处理消息不进入重放', () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const inbox = new Inbox({ db, logger: () => {} });
  inbox.record({ key: 'group:1', messageId: '1', payload: {}, dedupeKey: 'a', createdAt: Date.now() - 3600_000 });
  const pending = inbox.pending({ maxAgeMs: 60000 });
  assert.equal(pending.length, 0);
  db.close();
});

test('config-schema: 覆盖现有开关、密钥脱敏、非法值拒绝', () => {
  const sample = {
    dsh: { baseUrl: 'http://127.0.0.1:1', authToken: 'secret-token-value', reasoningEffort: 'max' },
    snowluma: { wsUrl: 'ws://127.0.0.1:2', accessToken: 'abc' },
    role: { maxInjectChars: 6000 },
    consoleToken: 'console-secret',
    allow: { private: [], groups: [] },
    socialV2: {
      enabled: true,
      tools: { sendGroup: true, sendVoice: false },
      voice: { enabled: true, maxPerMinute: 2 },
      send: { maxMessageChars: 500 },
      innerLife: { enabled: true }
    },
    webSearch: { provider: 'auto', apiKey: 'k' },
    tts: { enabled: true }
  };
  const schema = buildConfigSchema(sample);
  const keys = new Set(schema.fields.map((f) => f.key));
  for (const key of ['dsh.authToken', 'socialV2.tools.sendVoice', 'socialV2.voice.enabled', 'tts.enabled', 'webSearch.apiKey', 'role.maxInjectChars', 'consoleToken']) {
    assert.ok(keys.has(key), `schema 缺少 ${key}`);
  }
  const tokenField = schema.fields.find((f) => f.key === 'dsh.authToken');
  assert.equal(tokenField.secret, true);
  assert.equal(tokenField.value, '已配置');

  const ok = validateConfigPatch(sample, { 'socialV2.voice.maxPerMinute': 3, 'socialV2.enabled': false });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values, { 'socialV2.voice.maxPerMinute': 3, 'socialV2.enabled': false });

  const badType = validateConfigPatch(sample, { 'socialV2.enabled': 'yes' });
  assert.equal(badType.ok, false);
  assert.match(badType.errors[0], /布尔/);

  const badRange = validateConfigPatch(sample, { 'role.maxInjectChars': 999999 });
  assert.equal(badRange.ok, false);
  assert.match(badRange.errors[0], /不能大于/);

  const unknown = validateConfigPatch(sample, { 'socialV2.voice.enabld': true });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors[0], /未知配置项/);

  const fileCheck = validateConfigObject(sample, { ...sample, role: { maxInjectChars: 'big' } });
  assert.equal(fileCheck.ok, false);
  assert.match(fileCheck.errors[0], /必须是数字/);
});

test('config-schema: v1 → v2 迁移与补丁应用', () => {
  const migrated = migrateConfigObject({ allow: { privates: [1] }, social: { enabled: true } });
  assert.equal(migrated.to, CONFIG_VERSION);
  assert.equal(migrated.config.configVersion, 2);
  assert.deepEqual(migrated.config.allow.private, [1]);
  assert.equal(migrated.config.allow.privates, undefined);
  assert.equal(migrated.config.storage.enabled, true);

  const next = applyConfigPatch({ socialV2: { send: { maxMessageChars: 500 } } }, { 'socialV2.send.maxMessageChars': 300 });
  assert.equal(next.socialV2.send.maxMessageChars, 300);

  const field = { key: 'x', type: 'number', min: 1, max: 2 };
  assert.equal(validateField(field, 3).ok, false);
  assert.equal(validateField(field, 2).ok, true);
});

test('logger: JSONL 写入、脱敏、读取', () => {
  const dir = tmpDir('logs');
  const logger = createJsonlLogger({ dir, extraSecrets: ['my-secret-token'] });
  logger.info('hello', { token: 'abc', note: 'Bearer abcdefghijklmnop' });
  logger.warn('使用 my-secret-token 调用');
  const rows = readRecentLogs(dir, { limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].level, 'info');
  assert.equal(rows[0].token, '***');
  assert.equal(rows[1].msg.includes('my-secret-token'), false);
  assert.match(redactLogText('https://x?a=1&token=abcdef'), /token=\*\*\*/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('db: 保留期清理只删已结束记录', () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const old = Date.now() - 90 * 24 * 3600 * 1000;
  db.run('INSERT INTO outbox(key, kind, payload_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'group:1', 'text', '{}', 'sent', old, old);
  db.run('INSERT INTO outbox(key, kind, payload_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'group:1', 'text', '{}', 'pending', old, old);
  const removed = pruneDatabase(db, { retentionDays: 30 });
  assert.equal(removed.outbox, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM outbox').n, 1);
  db.close();
});
