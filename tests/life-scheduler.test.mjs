// 生活管家调度：熔断/退避、认证停用、静默时段、补跑、抖动、并发、限流、超时。
// 复用内存 SQLite 与假 port.scheduler，不接触真实 jobs 表与网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../runtime/kernel/db.js';
import { normalizeLifeConfig } from '../services/social/life/config.js';
import { createPipeline } from '../services/social/life/kernel/pipeline.js';
import { createHealth } from '../services/social/life/kernel/health.js';
import { createScheduler } from '../services/social/life/kernel/scheduler.js';
import { LifeAuthError } from '../services/social/life/kernel/fetch-guard.js';
import { nextCronAt, nextDailyAt, dayKey } from '../services/social/life/kernel/time.js';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 1, 2, 0, 0); // 2026-11-01 10:00 Asia/Shanghai
const MINUTE = 60 * 1000;

function makeAdapter(id, { sync, manifest = {}, enabled = true } = {}) {
  const schedule = { sync: '*/5 * * * *', jitterSec: 0, timeoutMs: 2000, catchUp: 'once', ...(manifest.schedule ?? {}) };
  const rateLimit = { perMinute: 30, perDay: 1000, ...(manifest.rateLimit ?? {}) };
  const health = { failuresToOpen: 3, openMs: 30 * MINUTE, authErrorStops: true, ...(manifest.health ?? {}) };
  return {
    id,
    enabled,
    config: {},
    guard: {},
    impl: { sync: sync ?? (async () => ({ items: [], cursor: null })) },
    manifest: { name: id, ...manifest, schedule, rateLimit, health }
  };
}

function makeEnv({ config: raw = {}, adapters = [], random = () => 0.5 } = {}) {
  const db = openDatabase({ file: ':memory:' });
  const config = normalizeLifeConfig({
    enabled: true,
    digest: { enabled: false },
    quietHours: { enabled: false },
    ...raw
  });
  let nowMs = NOW;
  const clock = { now: () => nowMs };
  const health = createHealth({ db, clock, logger: () => {} });
  const pipeline = createPipeline({ db, config, clock, logger: () => {} });
  const enqueued = [];
  const seen = new Set();
  const notified = [];
  const port = {
    config: () => ({ lifeButler: config }),
    log: () => {},
    clock,
    db,
    scheduler: {
      register() {},
      enqueue(input) {
        const existed = seen.has(input.dedupeKey);
        if (!existed) { seen.add(input.dedupeKey); enqueued.push(input); }
        return { id: enqueued.length, existed };
      },
      cancel() { return 0; }
    },
    notify: async (text, meta) => { notified.push({ text, meta }); return { ok: true }; },
    http: { fetch: async () => { throw new Error('端口 http 不应被直接调用'); } }
  };
  const scheduler = createScheduler({ port, config, clock, health, pipeline, adapters, random });
  return {
    db, config, health, pipeline, scheduler, port, enqueued, notified,
    advance(ms) { nowMs += ms; },
    setNow(ms) { nowMs = ms; },
    now: () => nowMs
  };
}

test('熔断：失败 3 次开放 30 分钟，半开后一次失败继续开放，成功即恢复', async () => {
  const adapter = makeAdapter('rss', { sync: async () => { throw new Error('boom'); } });
  const env = makeEnv({ adapters: [adapter] });

  const first = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(first.state, 'degraded');
  assert.equal(first.failures, 1);
  assert.equal(first.nextAllowed, env.now() + 60 * 1000);

  const backoff = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(backoff.skipped, 'backoff');
  assert.ok(env.enqueued.some((job) => job.dedupeKey === `life:sync:rss:retry:${first.nextAllowed}`));

  env.advance(60 * 1000);
  const second = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(second.failures, 2);
  assert.equal(second.nextAllowed, env.now() + 5 * 60 * 1000);

  env.advance(5 * 60 * 1000);
  const third = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(third.state, 'open');
  assert.equal(third.openUntil, env.now() + 30 * 60 * 1000);

  const opened = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(opened.skipped, 'open');
  assert.equal(env.health.snapshot('rss').state, 'open');

  env.advance(30 * 60 * 1000);
  assert.equal(env.health.canRun('rss', adapter.manifest).halfOpen, true);
  const halfOpen = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(halfOpen.state, 'open');
  assert.equal(halfOpen.failures, 4);

  env.advance(30 * 60 * 1000);
  adapter.impl.sync = async () => ({ items: [], cursor: null });
  const recovered = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(recovered.inserted, 0);
  const snapshot = env.health.snapshot('rss');
  assert.equal(snapshot.state, 'ok');
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.equal(snapshot.lastSuccess, env.now());
});

test('认证失效：立即停用、不再入队、后续同步直接跳过', async () => {
  const adapter = makeAdapter('github', { sync: async () => { throw new LifeAuthError('401 Unauthorized', { status: 401 }); } });
  const env = makeEnv({ adapters: [adapter] });

  const result = await env.scheduler.syncOnce('github', 'manual');
  assert.equal(result.state, 'disabled');
  assert.equal(env.health.snapshot('github').state, 'disabled');
  assert.equal(env.enqueued.length, 0, '认证失败不应排下次同步或重试');

  const again = await env.scheduler.syncOnce('github', 'manual');
  assert.equal(again.skipped, 'auth');
  assert.equal(env.enqueued.length, 0);
});

test('静默时段：同步照常、简报只生成不发送；关闭静默后才投递', async () => {
  const adapter = makeAdapter('rss', {
    sync: async () => ({
      items: [{ kind: 'feed', title: '静默期条目', dedupeKey: 'quiet:1', startsAt: NOW }],
      cursor: null
    })
  });
  const env = makeEnv({
    adapters: [adapter],
    config: { quietHours: { enabled: true, start: '00:00', end: '23:59' } }
  });

  const synced = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(synced.inserted, 1, '静默时段同步仍应继续');

  const suppressed = await env.scheduler.runBrief('morning');
  assert.equal(suppressed.quiet, true);
  assert.equal(suppressed.delivered, false);
  assert.equal(env.notified.length, 0);
  assert.match(suppressed.text, /静默期条目/);

  env.config.quietHours.enabled = false;
  const delivered = await env.scheduler.runBrief('morning');
  assert.equal(delivered.quiet, false);
  assert.equal(delivered.delivered, true);
  assert.equal(env.notified.length, 1);
  assert.equal(env.notified[0].meta.channel, 'owner-private');
  assert.equal(env.notified[0].meta.kind, 'life-brief-morning');
  assert.match(env.notified[0].text, /静默期条目/);
  assert.ok(delivered.tokens <= 300);
});

test('补跑：每个适配器每天最多一次；重启后由去重键拦住重复补跑', () => {
  const adapter = makeAdapter('arxiv');
  const env = makeEnv({ adapters: [adapter] });
  const today = dayKey(NOW, TZ);
  const catchupKey = `life:catchup:arxiv:${today}`;

  env.health.recordSuccess('arxiv', {});
  env.db.run('UPDATE life_sync_state SET last_success = ? WHERE adapter = ?', NOW - 24 * 60 * 60 * 1000, 'arxiv');

  const first = env.scheduler.start();
  assert.equal(first.adapters, 1);
  assert.equal(env.enqueued.filter((job) => job.dedupeKey === catchupKey).length, 1);
  const catchup = env.enqueued.find((job) => job.dedupeKey === catchupKey);
  assert.equal(catchup.payload.reason, 'catchup');
  assert.ok(catchup.runAfter >= NOW + 5000);
  const syncKey = env.enqueued.find((job) => job.dedupeKey.startsWith('life:sync:arxiv:')).dedupeKey;
  assert.equal(syncKey, `life:sync:arxiv:${nextCronAt('*/5 * * * *', NOW, TZ)}`);

  const again = env.scheduler.start();
  assert.equal(again.adapters, 0, '同一实例重复 start 不应重复排程');
  assert.equal(env.enqueued.filter((job) => job.dedupeKey === catchupKey).length, 1);

  // 模拟进程重启：新建 scheduler，同步状态保留。当天已成功则不再补跑。
  const restarted = createScheduler({
    port: env.port, config: env.config, clock: env.port.clock, health: env.health,
    pipeline: env.pipeline, adapters: [adapter], random: () => 0.5
  });
  env.health.recordSuccess('arxiv', {});
  const afterRestart = restarted.start();
  assert.equal(afterRestart.adapters, 1);
  assert.equal(env.enqueued.filter((job) => job.dedupeKey === catchupKey).length, 1, '当天已成功不补跑');
});

test('排程：抖动落在 ±jitterSec 内，简报固定在 08:00 / 22:30', () => {
  const adapter = makeAdapter('rss', { manifest: { schedule: { sync: '0 9 * * *', jitterSec: 60 } } });
  const env = makeEnv({ adapters: [adapter], random: () => 1 });
  const next = nextCronAt('0 9 * * *', NOW, TZ);

  env.scheduler.scheduleNext('rss', NOW);
  const syncJob = env.enqueued.find((job) => job.dedupeKey === `life:sync:rss:${next}`);
  assert.ok(syncJob, '排程去重键应包含 cron 时间点');
  assert.equal(syncJob.runAfter, next + 60 * 1000);
  assert.equal(syncJob.payload.slot, dayKey(next, TZ));
  assert.equal(syncJob.maxAttempts, 1);

  const briefEnv = makeEnv({ adapters: [adapter], config: { digest: { enabled: true } } });
  briefEnv.scheduler.scheduleBrief('morning', NOW);
  briefEnv.scheduler.scheduleBrief('evening', NOW);
  const morning = briefEnv.enqueued.find((job) => job.type === 'life.brief' && job.payload.kind === 'morning');
  const evening = briefEnv.enqueued.find((job) => job.type === 'life.brief' && job.payload.kind === 'evening');
  assert.equal(morning.runAfter, nextDailyAt('08:00', NOW, TZ));
  assert.equal(evening.runAfter, nextDailyAt('22:30', NOW, TZ));
  assert.equal(morning.dedupeKey, `life:brief:morning:${dayKey(morning.runAfter, TZ)}`);
  assert.equal(evening.dedupeKey, `life:brief:evening:${dayKey(evening.runAfter, TZ)}`);

  briefEnv.scheduler.start();
  const queuedBriefs = briefEnv.enqueued.filter((job) => job.type === 'life.brief');
  assert.equal(queuedBriefs.length, 2, '启动时只排下一次早/晚简报');
});

test('并发：同一适配器只跑 1 个，全局默认不超过 3（此处收紧为 1 验证）', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = makeAdapter('rss', { sync: async () => { await gate; return { items: [] }; } });
  const other = makeAdapter('arxiv');
  const env = makeEnv({ adapters: [slow, other], config: { concurrency: { global: 1 } } });

  const running = env.scheduler.syncOnce('rss', 'manual');
  const sameAdapter = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(sameAdapter.skipped, 'adapter-busy');

  const otherAdapter = await env.scheduler.syncOnce('arxiv', 'manual');
  assert.equal(otherAdapter.skipped, 'global-busy');

  release();
  const done = await running;
  assert.equal(done.inserted, 0);
  assert.equal(env.scheduler.status().globalInFlight, 0);

  const after = await env.scheduler.syncOnce('arxiv', 'manual');
  assert.equal(after.inserted, 0);
  assert.equal(after.error, undefined);
});

test('限流与超时：同分钟超限改排重试；单次同步硬超时记为失败', async () => {
  const adapter = makeAdapter('rss', { manifest: { rateLimit: { perMinute: 1, perDay: 100 } } });
  const env = makeEnv({ adapters: [adapter] });

  const first = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(first.inserted, 0);
  const limited = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(limited.skipped, 'rate-limit');
  assert.ok(env.enqueued.some((job) => job.dedupeKey.startsWith('life:sync:rss:retry:')));

  env.advance(61 * 1000);
  const recovered = await env.scheduler.syncOnce('rss', 'manual');
  assert.equal(recovered.inserted, 0);
  assert.equal(recovered.error, undefined);

  const hang = makeAdapter('github', {
    sync: () => new Promise((resolve) => { setTimeout(() => resolve({ items: [] }), 400); }),
    manifest: { schedule: { timeoutMs: 20 } }
  });
  const slowEnv = makeEnv({ adapters: [hang] });
  const timedOut = await slowEnv.scheduler.syncOnce('github', 'manual');
  assert.match(timedOut.error, /超时/);
  assert.equal(slowEnv.health.snapshot('github').state, 'degraded');
});

test('stop 之后不再处理任务；未知类型/未知适配器安全跳过', async () => {
  const env = makeEnv({ adapters: [makeAdapter('rss')] });
  env.scheduler.start();
  assert.equal((await env.scheduler.handleJob({ type: 'life.sync', payload: { adapter: 'nope' } })).skipped, 'unknown-adapter');
  assert.equal((await env.scheduler.handleJob({ type: 'other' })).skipped, 'unknown-type');
  assert.equal((await env.scheduler.handleJob(null)).skipped, 'bad-job');

  env.scheduler.stop();
  assert.equal((await env.scheduler.handleJob({ type: 'life.sync', payload: { adapter: 'rss' } })).skipped, 'stopped');
});
