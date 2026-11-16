// 调度：复用桥接的 jobs 表（dedupe_key / run_after / attempts / locked_until）。
//
// 特性：
//   · 抖动：每次排程在 cron 时间点 ±jitterSec 内随机；
//   · 静默时段：同步照常，通知顺延到静默结束（不消耗重试次数）；
//   · 补跑：进程重启后每个适配器当天最多补一次；
//   · 并发：单适配器并发 1，全局默认 3；
//   · 超时：单次同步硬超时，记为失败并按健康策略退避；
//   · 模块（论文推送 / GitHub 监控）：按用户频率排程，同步后单独推送；
//     首次 GitHub 只建基线不刷历史；论文首次照常推送。
// 内核不直接操作 jobs 表：只通过 port.scheduler 入队/注册。

import { isQuietNow, quietEndAt } from '../../../persona/quiet-hours.js';
import {
  nextCronAt, nextDailyAt, nextModuleRun, jitterMs, dayKey, startOfDay
} from './time.js';
import { LifeAuthError, LifeQuotaError } from './fetch-guard.js';
import { buildBrief, buildPromptSection } from './brief.js';
import {
  LIFE_MODULE_IDS, LIFE_MODULE_ADAPTERS, moduleEnabled, moduleIdForAdapter
} from '../config.js';
import { buildCalendarMorning, buildRssDigest, buildWeeklyReview } from './modules.js';

const SYNC_TYPE = 'life.sync';
const BRIEF_TYPE = 'life.brief';
const PUSH_TYPE = 'life.push';
const MODULE_IDS = new Set(LIFE_MODULE_IDS);
const ADAPTER_OF_MODULE = LIFE_MODULE_ADAPTERS;
// 首次开启时立刻推一次：论文/GitHub 给首轮状态，日历晨报给「今天没有日程」这类明确状态；
// RSS 摘要首次只建基线，不推历史；每周回顾等到下一个固定时间。
const INITIAL_PUSH_MODULES = new Set(['paper', 'github', 'calendarMorning']);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MAX_PUSH_CHARS = 3600;
const MAX_PUSH_ATTEMPTS = 3;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isAuthError(error) {
  return error instanceof LifeAuthError || Number(error?.status) === 401;
}

function clipMessage(text) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= MAX_PUSH_CHARS) return chars.join('');
  return `${chars.slice(0, MAX_PUSH_CHARS - 1).join('')}…`;
}

function formatNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : '—';
}

function deltaText(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '';
  return `（${n > 0 ? '+' : ''}${Math.round(n)}）`;
}

function paperMessage(items, module) {
  const count = Math.max(1, Math.min(20, Number(module.count) || 5));
  const list = items.slice(0, count);
  const topics = Array.isArray(module.topics) && module.topics.length ? module.topics.join('、') : '默认主题';
  const windowDays = Math.max(1, Number(module.windowDays) || 7);
  const lines = [`论文推送 · 近 ${windowDays} 天 · ${topics}`];
  list.forEach((item, index) => {
    const payload = item.payload || {};
    const url = String(payload.url || payload.htmlUrl || '');
    const title = String(item.title || '');
    lines.push(`${index + 1}. ${url ? `[${title}](${url})` : title}`);
    const institutions = Array.isArray(payload.institutions) && payload.institutions.length
      ? payload.institutions.slice(0, 2).join('、')
      : '—';
    const venue = [payload.venue, payload.year].filter(Boolean).join(' · ') || '—';
    lines.push(`   ${institutions}｜${venue}｜${payload.publicationDate || '—'}`);
    const tldr = payload.tldrSource === 'title-only'
      ? '仅标题'
      : payload.tldrSource === 'abstract-compress'
        ? `摘要压缩：${item.summary || '仅标题'}`
        : (item.summary || '仅标题');
    lines.push(`   TLDR：${tldr}`);
  });
  if (items.length > list.length) lines.push(`其余 ${items.length - list.length} 篇可在生活库查看`);
  lines.push('参考：');
  list.forEach((item, index) => {
    const url = String(item.payload?.url || item.payload?.htmlUrl || '');
    lines.push(`[${index + 1}] ${url || item.title || ''}`);
  });
  return clipMessage(lines.join('\n'));
}

function repoChangeCount(repo, metrics = {}) {
  let n = 0;
  n += Array.isArray(repo.issues) ? repo.issues.length : 0;
  n += Array.isArray(repo.pulls) ? repo.pulls.length : 0;
  n += Array.isArray(repo.releases) ? repo.releases.length : 0;
  if (metrics.stars !== false) n += Math.abs(Number(repo.starDelta) || 0);
  if (metrics.forks !== false) n += Math.abs(Number(repo.forkDelta) || 0);
  return n;
}

function githubMessage(meta, module, items) {
  const metrics = module.metrics || {};
  const repos = Array.isArray(meta?.repos) ? meta.repos : [];
  const lines = ['GitHub 监控'];
  if (repos.length) {
    for (const repo of repos.slice(0, 10)) {
      const bits = [];
      if (metrics.stars !== false) bits.push(`★ ${formatNum(repo.stars)}${deltaText(repo.starDelta)}`);
      if (metrics.forks !== false) bits.push(`Fork ${formatNum(repo.forks)}${deltaText(repo.forkDelta)}`);
      if (metrics.issues !== false) bits.push(`Issue ${formatNum(repo.openIssues)}`);
      if (metrics.pulls !== false) bits.push(`PR ${formatNum(repo.openPulls)}`);
      lines.push(`${repo.repo || '未知仓库'}${bits.length ? ` · ${bits.join(' · ')}` : ''}`);
      for (const item of (repo.issues || []).slice(0, 5)) {
        lines.push(`  · Issue #${item.number ?? '—'} ${item.title || ''}（@${item.author || '—'}，${item.state || 'open'}）${item.url ? ` ${item.url}` : ''}`);
      }
      for (const item of (repo.pulls || []).slice(0, 5)) {
        lines.push(`  · PR #${item.number ?? '—'} ${item.title || ''}（@${item.author || '—'}，${item.state || 'open'}）${item.url ? ` ${item.url}` : ''}`);
      }
      for (const item of (repo.releases || []).slice(0, 3)) {
        const label = item.tag || item.name || '新版本';
        const when = Number.isFinite(Number(item.publishedAt)) ? new Date(Number(item.publishedAt)).toISOString().slice(0, 10) : '';
        lines.push(`  · 新版本 ${label}${item.name && item.name !== item.tag ? ` ${item.name}` : ''}${when ? `（${when}）` : ''}${item.url ? ` ${item.url}` : ''}`);
      }
    }
  } else if (items.length) {
    for (const item of items.slice(0, 20)) {
      const payload = item.payload || {};
      lines.push(`· ${payload.repo ? `${payload.repo} ` : ''}${payload.number ? `#${payload.number} ` : ''}${item.title}`);
    }
  } else {
    lines.push('本轮无新变化');
  }
  return clipMessage(lines.join('\n'));
}

export function createScheduler({
  port,
  config,
  clock,
  logger = () => {},
  audit = null,
  health,
  pipeline,
  adapters,
  random = Math.random,
  onBrief = null,
  reminders = null
}) {
  const now = () => Number(clock.now());
  const tz = config?.digest?.timezone || 'Asia/Shanghai';
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const inFlight = new Set();
  const notifyLog = [];
  let globalInFlight = 0;
  let running = false;
  const rate = new Map(); // adapterId -> {minute:[], day:[]}

  function enqueue(input) {
    return port.scheduler.enqueue(input);
  }

  function moduleSchedule(moduleId) {
    return config?.modules?.[moduleId] && typeof config.modules[moduleId] === 'object'
      ? config.modules[moduleId]
      : {};
  }

  function moduleAdapterId(moduleId) {
    return ADAPTER_OF_MODULE[moduleId] ?? null;
  }

  /** 适配器当前由哪个已启用模块接管；没有则返回 null（独立同步）。 */
  function activeModuleForAdapter(adapterId) {
    const moduleId = moduleIdForAdapter(adapterId);
    return moduleId && moduleEnabled(config, moduleId) ? moduleId : null;
  }

  function moduleReady(moduleId) {
    if (!moduleEnabled(config, moduleId)) return false;
    const adapterId = moduleAdapterId(moduleId);
    if (!adapterId) return true;
    return Boolean(byId.get(adapterId)?.enabled);
  }

  /** 模块的健康/游标行：有适配器的落在适配器 id 上，周报落在模块 id 上。 */
  function healthIdFor(moduleId) {
    return moduleAdapterId(moduleId) ?? moduleId;
  }

  function nextModuleAt(moduleId, fromMs = now()) {
    const from = Math.max(now(), Number(fromMs) || now());
    const schedule = moduleSchedule(moduleId);
    if (moduleId === 'weeklyReview') {
      return nextModuleRun({ frequency: 'weekly', time: schedule.time || '20:00', weekday: schedule.weekday }, from, tz);
    }
    if (moduleId === 'calendarMorning') {
      return nextModuleRun({
        frequency: 'daily',
        time: schedule.time || '07:30',
        weekdaysOnly: schedule.weekdaysOnly === true
      }, from, tz);
    }
    const snapshot = health.snapshot(healthIdFor(moduleId));
    const anchor = schedule.frequency === 'interval' && Number(snapshot.lastSuccess)
      ? Number(snapshot.lastSuccess)
      : from;
    return nextModuleRun(schedule, from, tz, anchor);
  }

  function nextAtFor(id, fromMs = now()) {
    if (MODULE_IDS.has(id)) {
      if (!moduleReady(id)) return null;
      return nextModuleAt(id, fromMs);
    }
    const moduleId = activeModuleForAdapter(id);
    if (moduleId) return nextModuleAt(moduleId, fromMs);
    const adapter = byId.get(id);
    if (!adapter || !adapter.enabled) return null;
    const from = Math.max(now(), Number(fromMs) || now());
    return nextCronAt(adapter.manifest.schedule.sync, from, tz);
  }

  function scheduleModule(moduleId, fromMs = now()) {
    if (!moduleReady(moduleId)) return null;
    const next = nextModuleAt(moduleId, fromMs);
    if (!next) return null;
    const adapterId = moduleAdapterId(moduleId);
    return enqueue({
      type: PUSH_TYPE,
      payload: {
        module: moduleId,
        ...(adapterId ? { adapter: adapterId } : {}),
        reason: 'schedule',
        slot: dayKey(next, tz)
      },
      dedupeKey: `life:push:${moduleId}:${next}`,
      runAfter: Math.max(now() + 1000, next),
      maxAttempts: 1
    });
  }

  function scheduleNext(adapterId, fromMs = now()) {
    const adapter = byId.get(adapterId);
    if (!adapter || !adapter.enabled) return null;
    const moduleId = activeModuleForAdapter(adapterId);
    if (moduleId) return scheduleModule(moduleId, fromMs);
    const next = nextAtFor(adapterId, fromMs);
    if (!next) return null;
    const jitter = jitterMs(adapter.manifest.schedule.jitterSec, random);
    const at = Math.max(now() + 1000, next + jitter);
    const slot = dayKey(next, tz);
    return enqueue({
      type: SYNC_TYPE,
      payload: { adapter: adapterId, reason: 'schedule', slot },
      dedupeKey: `life:sync:${adapterId}:${next}`,
      runAfter: at,
      maxAttempts: 1
    });
  }

  function scheduleRetry(adapterId, delayMs, reason) {
    const adapter = byId.get(adapterId);
    if (!adapter || !adapter.enabled) return null;
    const moduleId = activeModuleForAdapter(adapterId);
    const at = Math.max(now() + 1000, now() + Math.max(1000, Number(delayMs) || 60000));
    return enqueue({
      type: moduleId ? PUSH_TYPE : SYNC_TYPE,
      payload: moduleId
        ? { module: moduleId, adapter: adapterId, reason }
        : { adapter: adapterId, reason },
      dedupeKey: `${moduleId ? 'life:push' : 'life:sync'}:${moduleId || adapterId}:retry:${at}`,
      runAfter: at,
      maxAttempts: 1
    });
  }

  function schedulePushDelivery(moduleId, text, { count = 0, cursor = null, latencyMs = 0, attempts = 0, at = null } = {}) {
    const runAfter = Math.max(now() + 1000, Number(at) || now() + 1000);
    return enqueue({
      type: PUSH_TYPE,
      payload: { module: moduleId, text, count, cursor, latencyMs, attempts },
      dedupeKey: `life:push:deliver:${moduleId}:${runAfter}`,
      runAfter,
      maxAttempts: 1
    });
  }

  function scheduleBrief(kind, fromMs = now(), { deferred = false } = {}) {
    if (!config.digest?.enabled) return null;
    const time = kind === 'evening' ? config.digest.evening : config.digest.morning;
    const at = deferred
      ? Math.max(now() + 1000, Number(fromMs) || now())
      : nextDailyAt(time, Math.max(now(), fromMs), tz);
    return enqueue({
      type: BRIEF_TYPE,
      payload: { kind, slot: dayKey(at, tz), deferred },
      dedupeKey: deferred
        ? `life:brief:defer:${kind}:${at}`
        : `life:brief:${kind}:${dayKey(at, tz)}`,
      runAfter: at,
      maxAttempts: 1
    });
  }

  function rateLimited(adapterId) {
    const adapter = byId.get(adapterId);
    if (!adapter) return true;
    const at = now();
    const bucket = rate.get(adapterId) ?? { minute: [], day: [] };
    bucket.minute = bucket.minute.filter((t) => at - t < 60000);
    bucket.day = bucket.day.filter((t) => at - t < 24 * HOUR);
    const limited = bucket.minute.length >= adapter.manifest.rateLimit.perMinute
      || bucket.day.length >= adapter.manifest.rateLimit.perDay;
    rate.set(adapterId, bucket);
    return limited;
  }

  function markUsed(adapterId) {
    const at = now();
    const bucket = rate.get(adapterId) ?? { minute: [], day: [] };
    bucket.minute.push(at);
    bucket.day.push(at);
    rate.set(adapterId, bucket);
  }

  function canNotify() {
    const cap = Math.max(0, Number(config.notify?.maxPerHour) || 0);
    if (!cap) return true;
    const at = now();
    while (notifyLog.length && at - notifyLog[0] >= HOUR) notifyLog.shift();
    return notifyLog.length < cap;
  }

  function noteNotify() {
    notifyLog.push(now());
    if (notifyLog.length > 240) notifyLog.splice(0, notifyLog.length - 240);
  }

  function reminderList() {
    try {
      if (typeof reminders === 'function') return reminders() || [];
      if (Array.isArray(reminders)) return reminders;
      if (typeof reminders?.list === 'function') return reminders.list() || [];
    } catch (error) {
      logger('warn', `读取提醒失败：${error?.message ?? error}`);
    }
    return [];
  }

  async function syncOnce(adapterId, reason) {
    const adapter = byId.get(adapterId);
    if (!adapter || !adapter.enabled) return { skipped: 'disabled' };
    if (inFlight.has(adapterId)) return { skipped: 'adapter-busy', retryAfterMs: 5000 };
    if (globalInFlight >= Math.max(1, config.concurrency?.global ?? 3)) return { skipped: 'global-busy', retryAfterMs: 5000 };
    const gate = health.canRun(adapterId, adapter.manifest);
    if (!gate.allowed) {
      if (gate.reason === 'auth') return { skipped: 'auth' };
      if (gate.retryAfterMs) scheduleRetry(adapterId, gate.retryAfterMs, `health:${gate.reason}`);
      return { skipped: gate.reason };
    }
    if (rateLimited(adapterId)) {
      scheduleRetry(adapterId, 60000, 'rate-limit');
      return { skipped: 'rate-limit' };
    }

    inFlight.add(adapterId);
    globalInFlight += 1;
    markUsed(adapterId);
    try {
      const summary = await withTimeout(
        pipeline.syncAdapter(adapter, { reason }),
        adapter.manifest.schedule.timeoutMs,
        `同步 ${adapterId}`
      );
      health.recordSuccess(adapterId, { latencyMs: summary.latencyMs, items: summary.inserted + summary.updated, cursor: summary.cursor });
      scheduleNext(adapterId, now());
      return summary;
    } catch (error) {
      const auth = isAuthError(error);
      const quota = error instanceof LifeQuotaError;
      const result = health.recordFailure(adapterId, error, { auth, manifest: adapter.manifest });
      if (!auth) scheduleNext(adapterId, now() + (quota ? 6 * HOUR : 0));
      return { error: String(error?.message ?? error), ...result };
    } finally {
      inFlight.delete(adapterId);
      globalInFlight = Math.max(0, globalInFlight - 1);
    }
  }

  function buildPush(moduleId, summary) {
    const module = moduleSchedule(moduleId);
    const meta = summary?.meta && typeof summary.meta === 'object' ? summary.meta : {};
    if (meta.baseline && moduleId !== 'github') return { baseline: true, count: 0, text: '' };
    if (moduleId === 'github') {
      if (meta.baseline) return { baseline: true, count: 0, text: '' };
      const repos = Array.isArray(meta.repos) ? meta.repos : [];
      const changes = repos.reduce((sum, repo) => sum + repoChangeCount(repo, module.metrics), 0);
      if (!changes && module.notifyNoChanges !== true) return { noChange: true, count: 0, text: '' };
      return { count: changes, text: githubMessage(meta, module, summary.items || []), data: meta };
    }
    if (moduleId === 'paper') {
      const items = Array.isArray(summary?.items) ? summary.items : [];
      if (!items.length) return { noChange: true, count: 0, text: '' };
      return { count: items.length, text: paperMessage(items, module), data: null };
    }
    if (moduleId === 'calendarMorning') {
      const built = buildCalendarMorning({
        items: Array.isArray(summary?.items) ? summary.items : [],
        module,
        nowMs: now(),
        timeZone: tz
      });
      return { count: built.count, text: built.text, data: null };
    }
    if (moduleId === 'rssDigest') {
      const items = Array.isArray(summary?.items) ? summary.items : [];
      if (!items.length) return { noChange: true, count: 0, text: '' };
      const built = buildRssDigest({ items, module, meta, nowMs: now(), timeZone: tz });
      return { count: built.count, text: built.text, data: null };
    }
    return { noChange: true, count: 0, text: '' };
  }

  async function deliverStoredPush(payload = {}) {
    const moduleId = String(payload.module || payload.adapter || '');
    if (!moduleReady(moduleId)) return { skipped: 'disabled' };
    const text = String(payload.text || '').trim();
    if (!text) return { skipped: 'empty' };
    const quiet = isQuietNow(config.quietHours, new Date(now()));
    if (quiet) {
      schedulePushDelivery(moduleId, text, {
        count: payload.count, cursor: payload.cursor, latencyMs: payload.latencyMs,
        attempts: payload.attempts, at: quietEndAt(config.quietHours, now()) + 1000
      });
      if (audit) audit.record({ actor: 'scheduler', action: 'push.deferred', decision: 'suppressed', result: { module: moduleId, reason: 'quiet-hours' } });
      return { deferred: true, quiet: true };
    }
    if (!canNotify()) {
      schedulePushDelivery(moduleId, text, {
        count: payload.count, cursor: payload.cursor, latencyMs: payload.latencyMs,
        attempts: payload.attempts, at: now() + HOUR
      });
      if (audit) audit.record({ actor: 'scheduler', action: 'push.deferred', decision: 'suppressed', result: { module: moduleId, reason: 'maxPerHour' } });
      return { deferred: true, rateLimited: true };
    }
    try {
      await port.notify(text, { channel: config.notify?.channel ?? 'owner-private', kind: `life-push-${moduleId}` });
      noteNotify();
      if (payload.cursor !== undefined) {
        health.recordSuccess(healthIdFor(moduleId), { items: payload.count || 0, latencyMs: payload.latencyMs || 0, cursor: payload.cursor });
      }
      if (audit) audit.record({ actor: 'scheduler', action: 'push.sent', decision: 'executed', result: { module: moduleId, count: payload.count || 0 } });
      return { delivered: true, count: payload.count || 0 };
    } catch (error) {
      const attempts = (Number(payload.attempts) || 0) + 1;
      logger('warn', `${moduleId} 推送发送失败（第 ${attempts} 次）：${error?.message ?? error}`);
      if (audit) audit.record({ actor: 'scheduler', action: 'push.failed', decision: 'failed', result: { module: moduleId, attempts, error: String(error?.message ?? error) } });
      if (attempts < MAX_PUSH_ATTEMPTS) {
        schedulePushDelivery(moduleId, text, {
          count: payload.count, cursor: payload.cursor, latencyMs: payload.latencyMs,
          attempts, at: now() + 5 * 60 * 1000
        });
      }
      return { error: String(error?.message ?? error), attempts };
    }
  }

  /** 无适配器的模块（每周回顾）：只读本地库，构建文本后走同一套投递。 */
  async function runLocalPush(moduleId, reason = 'schedule') {
    if (!moduleReady(moduleId)) return { skipped: 'disabled' };
    const module = moduleSchedule(moduleId);
    const since = now() - 7 * DAY;
    const sections = module.sections && typeof module.sections === 'object' ? module.sections : {};
    const paperItems = sections.paper === false ? [] : pipeline.moduleFeed({ adapter: 'paper', since, limit: 10 });
    const githubItems = sections.github === false ? [] : pipeline.moduleFeed({ adapter: 'github', since, limit: 10 });
    const reminderItems = sections.reminders === false ? [] : reminderList();
    const digestItems = sections.digest === false
      ? []
      : pipeline.moduleFeed({ since, limit: 40 })
        .filter((item) => item.adapter !== 'paper' && item.adapter !== 'github')
        .slice(0, 10);
    const built = buildWeeklyReview({
      paperItems,
      paperTotal: sections.paper === false ? 0 : pipeline.countSince('paper', since),
      githubItems,
      githubTotal: sections.github === false ? 0 : pipeline.countSince('github', since),
      reminderItems,
      digestItems,
      digestTotal: digestItems.length,
      module,
      nowMs: now(),
      timeZone: tz
    });
    const delivery = await deliverStoredPush({ module: moduleId, text: built.text, count: built.count });
    health.recordSuccess(moduleId, { latencyMs: 0, items: built.count });
    scheduleModule(moduleId, now());
    if (audit) audit.record({ actor: 'scheduler', action: 'push.local', decision: 'executed', result: { module: moduleId, reason, count: built.count } });
    return { ...delivery, text: built.text, count: built.count };
  }

  async function runPush(moduleId, reason = 'schedule') {
    if (!moduleReady(moduleId)) return { skipped: 'disabled' };
    const adapterId = moduleAdapterId(moduleId);
    if (!adapterId) return runLocalPush(moduleId, reason);
    const adapter = byId.get(adapterId);
    if (inFlight.has(adapterId)) return { skipped: 'adapter-busy', retryAfterMs: 5000 };
    if (globalInFlight >= Math.max(1, config.concurrency?.global ?? 3)) return { skipped: 'global-busy', retryAfterMs: 5000 };
    const gate = health.canRun(adapterId, adapter.manifest);
    if (!gate.allowed) {
      if (gate.reason === 'auth') return { skipped: 'auth' };
      if (gate.retryAfterMs) scheduleRetry(adapterId, gate.retryAfterMs, `health:${gate.reason}`);
      return { skipped: gate.reason };
    }
    if (rateLimited(adapterId)) {
      scheduleRetry(adapterId, 60000, 'rate-limit');
      return { skipped: 'rate-limit' };
    }

    inFlight.add(adapterId);
    globalInFlight += 1;
    markUsed(adapterId);
    let summary;
    try {
      summary = await withTimeout(
        pipeline.syncAdapter(adapter, { reason }),
        adapter.manifest.schedule.timeoutMs,
        `同步 ${adapterId}`
      );
    } catch (error) {
      const auth = isAuthError(error);
      const quota = error instanceof LifeQuotaError;
      const result = health.recordFailure(adapterId, error, { auth, manifest: adapter.manifest });
      if (!auth) scheduleNext(adapterId, now() + (quota ? 6 * HOUR : 0));
      return { error: String(error?.message ?? error), ...result };
    } finally {
      inFlight.delete(adapterId);
      globalInFlight = Math.max(0, globalInFlight - 1);
    }

    const built = buildPush(moduleId, summary);
    const items = summary.inserted + summary.updated;
    if (built.baseline) {
      health.recordSuccess(adapterId, { latencyMs: summary.latencyMs, items, cursor: summary.cursor });
      scheduleNext(adapterId, now());
      if (audit) audit.record({ actor: 'scheduler', action: 'push.baseline', decision: 'executed', result: { module: moduleId } });
      return { baseline: true, sent: false, inserted: summary.inserted, updated: summary.updated };
    }
    if (built.noChange && moduleSchedule(moduleId).notifyNoChanges !== true) {
      health.recordSuccess(adapterId, { latencyMs: summary.latencyMs, items, cursor: summary.cursor });
      scheduleNext(adapterId, now());
      return { noChange: true, sent: false, inserted: summary.inserted, updated: summary.updated };
    }

    const delivery = await deliverStoredPush({
      module: moduleId,
      text: built.text,
      count: built.count,
      cursor: summary.cursor,
      latencyMs: summary.latencyMs
    });
    health.recordSuccess(adapterId, { latencyMs: summary.latencyMs, items, cursor: summary.cursor });
    scheduleNext(adapterId, now());
    return {
      ...delivery,
      text: built.text,
      count: built.count,
      inserted: summary.inserted,
      updated: summary.updated
    };
  }

  async function runBrief(kind) {
    const sections = config.digest?.sections ?? {};
    const dayStart = startOfDay(now(), tz);
    const items = sections.calendar === false
      ? []
      : pipeline.briefCandidates({ nowMs: now() }).filter((item) => !MODULE_IDS.has(item.adapter));
    const paperItems = sections.paper
      ? pipeline.moduleFeed({ adapter: 'paper', since: dayStart, limit: 5 })
      : [];
    const githubItems = sections.github
      ? pipeline.moduleFeed({ adapter: 'github', since: dayStart, limit: 10 })
      : [];
    const reminderItems = sections.reminders ? reminderList() : [];
    const brief = buildBrief({
      items,
      reminders: reminderItems,
      paperItems,
      githubItems,
      sections,
      paperWindowDays: Math.max(1, Number(moduleSchedule('paper')?.windowDays) || 7),
      nowMs: now(),
      timeZone: tz,
      kind
    });
    const quiet = isQuietNow(config.quietHours, new Date(now()));
    let delivered = false;
    if (quiet) {
      scheduleBrief(kind, quietEndAt(config.quietHours, now()) + 1000, { deferred: true });
      if (audit) audit.record({ actor: 'scheduler', action: `brief.${kind}`, decision: 'suppressed', result: { reason: 'quiet-hours', count: brief.count } });
    } else if (!canNotify()) {
      scheduleBrief(kind, now() + HOUR, { deferred: true });
      if (audit) audit.record({ actor: 'scheduler', action: `brief.${kind}`, decision: 'suppressed', result: { reason: 'maxPerHour', count: brief.count } });
    } else {
      try {
        await port.notify(brief.text, { channel: config.notify?.channel ?? 'owner-private', kind: `life-brief-${kind}`, brief });
        noteNotify();
        delivered = true;
        if (audit) audit.record({ actor: 'scheduler', action: `brief.${kind}`, decision: 'executed', result: { count: brief.count, tokens: brief.tokens } });
      } catch (error) {
        logger('warn', `生活简报发送失败：${error?.message ?? error}`);
        if (audit) audit.record({ actor: 'scheduler', action: `brief.${kind}`, decision: 'failed', result: { error: String(error?.message ?? error) } });
        scheduleBrief(kind, now() + 5 * 60 * 1000, { deferred: true });
      }
    }
    if (typeof onBrief === 'function') {
      try { onBrief({ kind, brief, delivered, quiet }); } catch { /* 观察者失败不影响调度 */ }
    }
    return { ...brief, delivered, quiet };
  }

  async function handleJob(job) {
    if (!running) return { skipped: 'stopped' };
    if (!job || !job.type) return { skipped: 'bad-job' };
    if (job.type === SYNC_TYPE) {
      const adapterId = String(job.payload?.adapter ?? '');
      if (!byId.has(adapterId)) return { skipped: 'unknown-adapter' };
      const reason = String(job.payload?.reason ?? 'schedule');
      const moduleId = activeModuleForAdapter(adapterId);
      if (moduleId) return runPush(moduleId, reason);
      return syncOnce(adapterId, reason);
    }
    if (job.type === PUSH_TYPE) {
      const moduleId = String(job.payload?.module || job.payload?.adapter || '');
      if (!job.payload?.text) {
        if (!MODULE_IDS.has(moduleId) && !byId.has(moduleId)) return { skipped: 'unknown-adapter' };
        const target = MODULE_IDS.has(moduleId) ? moduleId : (activeModuleForAdapter(moduleId) ?? moduleId);
        return runPush(target, String(job.payload?.reason ?? 'schedule'));
      }
      return deliverStoredPush(job.payload);
    }
    if (job.type === BRIEF_TYPE) {
      // 简报开关可能在排程后被关掉；已入队的简报只跳过这一次，不再续排。
      if (!config.digest?.enabled) return { skipped: 'brief-disabled' };
      const kind = job.payload?.kind === 'evening' ? 'evening' : 'morning';
      const result = await runBrief(kind);
      scheduleBrief(kind, now());
      return { count: result.count, delivered: result.delivered, quiet: result.quiet };
    }
    return { skipped: 'unknown-type' };
  }

  function start() {
    if (running) return { adapters: 0, briefs: 0 };
    running = true;
    let count = 0;
    const moduleDriven = new Set();
    for (const moduleId of LIFE_MODULE_IDS) {
      if (!moduleReady(moduleId)) continue;
      const adapterId = moduleAdapterId(moduleId);
      if (adapterId) moduleDriven.add(adapterId);
      count += 1;
      const healthId = healthIdFor(moduleId);
      health.ensure(healthId);
      const snapshot = health.snapshot(healthId);
      if (!snapshot.lastSuccess && INITIAL_PUSH_MODULES.has(moduleId)) {
        enqueue({
          type: PUSH_TYPE,
          payload: { module: moduleId, ...(adapterId ? { adapter: adapterId } : {}), reason: 'initial', slot: dayKey(now(), tz) },
          dedupeKey: `life:push:initial:${moduleId}:${dayKey(now(), tz)}`,
          runAfter: now() + 5000,
          maxAttempts: 1
        });
      }
      scheduleModule(moduleId, now());
    }
    for (const adapter of adapters) {
      if (!adapter.enabled || moduleDriven.has(adapter.id)) continue;
      count += 1;
      health.ensure(adapter.id);
      const snapshot = health.snapshot(adapter.id);
      const todayStart = startOfDay(now(), tz);
      const caughtUp = Number(snapshot.lastSuccess) > todayStart;
      if (adapter.manifest.schedule.catchUp === 'once' && !caughtUp) {
        const at = Math.max(now() + 5000, now() + jitterMs(adapter.manifest.schedule.jitterSec, random));
        enqueue({
          type: SYNC_TYPE,
          payload: { adapter: adapter.id, reason: 'catchup', slot: dayKey(now(), tz) },
          dedupeKey: `life:catchup:${adapter.id}:${dayKey(now(), tz)}`,
          runAfter: at,
          maxAttempts: 1
        });
      }
      scheduleNext(adapter.id, now());
    }
    if (config.digest?.enabled) {
      scheduleBrief('morning', now());
      scheduleBrief('evening', now());
    }
    logger('info', `生活管家调度已启动：${count} 个任务${config.digest?.enabled ? '，简报开启' : ''}`);
    return { adapters: count, briefs: config.digest?.enabled ? 2 : 0 };
  }

  function stop() {
    running = false;
  }

  function nextRunFor(id) {
    try {
      const at = nextAtFor(id, now());
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }

  function status() {
    return {
      running,
      inFlight: [...inFlight],
      globalInFlight,
      adapters: adapters.map((adapter) => ({
        id: adapter.id,
        enabled: adapter.enabled,
        nextRun: nextRunFor(adapter.id),
        ...health.snapshot(adapter.id)
      }))
    };
  }

  return {
    start, stop, handleJob, status, nextRunFor,
    syncOnce, scheduleNext, scheduleBrief, runBrief, runPush,
    SYNC_TYPE, BRIEF_TYPE, PUSH_TYPE,
    promptSection: ({ maxTokens = 300 } = {}) => buildPromptSection({
      brief: buildBrief({ items: pipeline.briefCandidates({ nowMs: now() }), nowMs: now(), timeZone: tz }),
      maxTokens
    })
  };
}
