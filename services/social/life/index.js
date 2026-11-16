// 生活管家唯一入口。
//
//   const butler = createLifeButler(port, options);
//   await butler.start();     // 桥接启动时调用（注册 jobs handler + 排程）
//   await butler.init();      // 只读进程（MCP）只初始化注册表，不排程
//   butler.status() / brief() / query() / watch() / unwatch() / promptSection()
//   butler.dispose();         // kill switch：立即停止调度
//
// 总开关（lifeButler.enabled）默认关闭：关闭时所有方法返回 disabled，
// 不读取数据库、不注册任务、不写任何表。

import {
  normalizeLifeConfig, lifeEnabled, adapterEnabled, moduleEnabled,
  LIFE_MODULE_IDS, LIFE_MODULE_ADAPTERS
} from './config.js';
import { assertLifePort, registerJobHandler, portLog } from './ports/life-port.js';
import { loadAdapters, defaultAdaptersDir } from './kernel/registry.js';
import { createAudit } from './kernel/audit.js';
import { createHealth } from './kernel/health.js';
import { createPipeline } from './kernel/pipeline.js';
import { createWatches } from './kernel/watches.js';
import { createRetention } from './kernel/retention.js';
import { createActions } from './kernel/actions.js';
import { createApprovals } from './kernel/approvals.js';
import { createScheduler } from './kernel/scheduler.js';
import { buildBrief, buildPromptSection, BRIEF_MAX_TOKENS } from './kernel/brief.js';
import { buildCalendarMorning, buildRssDigest, buildWeeklyReview } from './kernel/modules.js';

const DAY = 24 * 60 * 60 * 1000;

export const DISABLED_REASON = 'simulation.lifeButler.enabled=false';

function disabledResult(extra = {}) {
  return { ok: false, disabled: true, reason: DISABLED_REASON, ...extra };
}

function readConfig(port, options) {
  if (options.config) return options.config;
  let snapshot = {};
  try { snapshot = port?.config?.() ?? {}; } catch { snapshot = {}; }
  return snapshot?.simulation?.lifeButler ?? snapshot?.lifeButler ?? snapshot;
}

function createDisabledButler(config, port) {
  return {
    enabled: false,
    ready: false,
    config,
    async init() { return { enabled: false }; },
    async start() { return { started: false, disabled: true, reason: DISABLED_REASON }; },
    dispose() {},
    status() { return { ok: true, enabled: false, disabled: true, reason: DISABLED_REASON, adapters: [] }; },
    brief() { return disabledResult({ text: '' }); },
    query() { return disabledResult({ items: [] }); },
    watch() { return disabledResult(); },
    unwatch() { return disabledResult(); },
    promptSection() { return { text: '', tokens: 0, disabled: true, reason: DISABLED_REASON }; },
    async syncAdapter() { return { ok: false, disabled: true, reason: DISABLED_REASON }; },
    async previewModule() { return { ok: false, disabled: true, reason: DISABLED_REASON }; },
    moduleStatus() {
      return Object.fromEntries(LIFE_MODULE_IDS.map((id) => [id, { enabled: false }]));
    },
    async handleJob() { return { skipped: 'disabled' }; },
    listWatches() { return { ok: true, disabled: true, watches: [] }; },
    actions: createActions({ config }),
    approvals: createApprovals({ port, config }),
    _port: port
  };
}

/**
 * @param {import('./ports/life-port.js').LifePort} port
 * @param {{config?:object, adaptersDir?:string, fetchImpl?:Function, resolve?:Function,
 *          random?:Function, clock?:{now:Function}, now?:Function, schedule?:boolean,
 *          summarizer?:Function, reminders?:object}} [options]
 */
export function createLifeButler(port, options = {}) {
  const config = normalizeLifeConfig(readConfig(port, options));
  if (!lifeEnabled(config)) return createDisabledButler(config, port);

  assertLifePort(port, { enabled: true });
  const clock = options.clock ?? port.clock ?? { now: () => Date.now() };
  const logger = (level, message, meta) => portLog(port, level, message, meta);
  const audit = createAudit({ clock, logger });
  const health = createHealth({ db: port.db, clock, logger, audit });
  const pipeline = createPipeline({
    db: port.db,
    config,
    clock,
    logger,
    audit,
    emit: typeof port.emit === 'function' ? port.emit : null
  });
  const actions = createActions({ config, audit });
  const approvals = createApprovals({ port, config, audit });
  const retention = createRetention({ db: port.db, config, clock, logger, audit });
  const schedules = options.schedule !== false;

  let adapters = [];
  let invalid = [];
  let scheduler = null;
  let initPromise = null;
  let started = false;
  let disposed = false;
  let watches = null;

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const loaded = await loadAdapters({
        dir: options.adaptersDir ?? defaultAdaptersDir(),
        config,
        logger,
        resolve: options.resolve,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        summarizer: options.summarizer ?? null
      });
      adapters = loaded.adapters;
      invalid = loaded.invalid;
      const knownIds = adapters.map((adapter) => adapter.id);
      watches = createWatches({ db: port.db, clock, adapterIds: knownIds, audit });
      for (const meta of adapters) {
        health.ensure(meta.id);
        portLog(port, 'info', `生活适配器已加载：${meta.id}（${meta.enabled ? '开启' : '关闭'}）`);
      }
      return { adapters: adapters.map((adapter) => adapter.id), invalid: invalid.length };
    })();
    return initPromise;
  }

  async function start() {
    if (disposed) return { started: false, disposed: true };
    if (started) return { started: true, already: true };
    await init();
    if (disposed) return { started: false, disposed: true };
    if (!schedules) {
      started = true;
      return { started: true, scheduled: false };
    }
    scheduler = createScheduler({
      port,
      config,
      clock,
      logger,
      audit,
      health,
      pipeline,
      adapters,
      random: options.random ?? Math.random,
      onBrief: options.onBrief,
      reminders: options.reminders ?? port.reminders ?? null
    });
    registerJobHandler(port, 'life.sync', (job) => handleJob(job));
    registerJobHandler(port, 'life.brief', (job) => handleJob(job));
    registerJobHandler(port, 'life.push', (job) => handleJob(job));
    try {
      retention.run(Number(clock.now()), { adapterIds: adapters.map((adapter) => adapter.id) });
    } catch (error) {
      portLog(port, 'warn', `生活管家初始清理失败（忽略）：${error?.message ?? error}`);
    }
    const result = scheduler.start();
    started = true;
    return { started: true, scheduled: true, ...result };
  }

  function dispose() {
    disposed = true;
    started = false;
    if (scheduler) scheduler.stop();
  }

  async function handleJob(job) {
    if (disposed) return { skipped: 'disposed' };
    if (!scheduler) {
      await init();
      if (!scheduler) return { skipped: 'not-started' };
    }
    return scheduler.handleJob(job);
  }

  function enabledAdapters() {
    return adapters.filter((adapter) => adapterEnabled(config, adapter.id));
  }

  function moduleStatus() {
    const state = (id) => {
      const adapterId = LIFE_MODULE_ADAPTERS[id] ?? null;
      const enabled = moduleEnabled(config, id);
      const healthId = adapterId ?? id;
      const snapshot = enabled ? health.snapshot(healthId) : {};
      let cursor = null;
      try {
        cursor = snapshot.cursor ? JSON.parse(snapshot.cursor) : null;
      } catch { cursor = null; }
      const module = config.modules?.[id] ?? {};
      return {
        enabled,
        config: { ...module },
        adapter: adapterId,
        state: snapshot.state ?? (enabled ? 'ok' : 'off'),
        lastSuccess: snapshot.lastSuccess ?? null,
        lastError: snapshot.lastError ?? null,
        nextRun: scheduler?.nextRunFor?.(id) ?? null,
        itemsLast: snapshot.itemsLast ?? null,
        cursor
      };
    };
    return Object.fromEntries(LIFE_MODULE_IDS.map((id) => [id, state(id)]));
  }

  function reminderList() {
    try {
      const source = port.reminders;
      if (typeof source === 'function') return source() ?? [];
      if (Array.isArray(source)) return source;
      if (typeof source?.list === 'function') return source.list() ?? [];
    } catch { /* 提醒不可用时周报只少一节 */ }
    return [];
  }

  function weeklyPreview(module) {
    const nowMs = Number(clock.now());
    const since = nowMs - 7 * DAY;
    const sections = module?.sections && typeof module.sections === 'object' ? module.sections : {};
    const paperItems = sections.paper === false ? [] : pipeline.moduleFeed({ adapter: 'paper', since, limit: 10 });
    const githubItems = sections.github === false ? [] : pipeline.moduleFeed({ adapter: 'github', since, limit: 10 });
    const reminderItems = sections.reminders === false ? [] : reminderList();
    const digestItems = sections.digest === false
      ? []
      : pipeline.moduleFeed({ since, limit: 40 })
        .filter((item) => item.adapter !== 'paper' && item.adapter !== 'github')
        .slice(0, 10);
    return buildWeeklyReview({
      paperItems,
      paperTotal: sections.paper === false ? 0 : pipeline.countSince('paper', since),
      githubItems,
      githubTotal: sections.github === false ? 0 : pipeline.countSince('github', since),
      reminderItems,
      digestItems,
      digestTotal: digestItems.length,
      module,
      nowMs,
      timeZone: config.digest.timezone
    });
  }

  async function previewModule(moduleId) {
    await init();
    const id = String(moduleId ?? '');
    if (!LIFE_MODULE_IDS.includes(id)) return { ok: false, error: `未知模块：${moduleId}` };
    const module = config.modules?.[id] ?? {};
    if (id === 'github') {
      return { ok: true, adapter: 'github', message: 'GitHub 预览需要实时对比历史快照，请在面板里查看状态行；不会发送消息。' };
    }
    if (id === 'weeklyReview') {
      const built = weeklyPreview(module);
      return { ok: true, module: id, text: built.text, count: built.count };
    }
    const adapterId = LIFE_MODULE_ADAPTERS[id];
    const adapter = adapters.find((item) => item.id === adapterId);
    if (!adapter) return { ok: false, error: `模块 ${id} 的适配器未加载（${adapterId ?? '无'}）` };
    const result = await pipeline.syncAdapter(adapter, { reason: 'preview', preview: true });
    const nowMs = Number(clock.now());
    const tz = config.digest.timezone;
    if (id === 'calendarMorning') {
      const built = buildCalendarMorning({ items: result.items, module, nowMs, timeZone: tz });
      return { ok: true, adapter: adapter.id, text: built.text, count: built.count, ...result };
    }
    if (id === 'rssDigest') {
      const built = buildRssDigest({ items: result.items, module, meta: result.meta, nowMs, timeZone: tz });
      return { ok: true, adapter: adapter.id, text: built.text, count: built.count, ...result };
    }
    return { ok: true, adapter: adapter.id, ...result };
  }

  function status() {
    const list = adapters.map((adapter) => ({
      id: adapter.id,
      name: adapter.manifest.name,
      enabled: adapterEnabled(config, adapter.id),
      capabilities: adapter.manifest.capabilities,
      risk: adapter.manifest.risk,
      schedule: adapter.manifest.schedule.sync,
      ...health.snapshot(adapter.id)
    }));
    return {
      ok: true,
      enabled: true,
      ready: started || Boolean(initPromise),
      started,
      disposed,
      digest: { ...config.digest },
      quietHours: { ...config.quietHours },
      adapters: list,
      invalidAdapters: invalid.map((entry) => ({ dir: entry.dir, errors: entry.errors })),
      counts: pipeline.counts(),
      watchCount: watches ? watches.list({ limit: 100 }).length : 0
    };
  }

  function brief({ kind = 'morning', maxTokens = BRIEF_MAX_TOKENS } = {}) {
    if (!initPromise) {
      return { ok: false, pending: true, reason: '尚未初始化', text: '' };
    }
    const b = buildBrief({
      items: pipeline.briefCandidates({ nowMs: Number(clock.now()) }),
      nowMs: Number(clock.now()),
      timeZone: config.digest.timezone,
      kind,
      maxTokens
    });
    return { ok: true, ...b };
  }

  function promptSection({ maxTokens = BRIEF_MAX_TOKENS } = {}) {
    if (!config.promptSection?.enabled) return { text: '', tokens: 0, disabled: true, reason: 'simulation.lifeButler.promptSection.enabled=false' };
    if (!initPromise) return { text: '', tokens: 0, pending: true };
    const b = buildBrief({
      items: pipeline.briefCandidates({ nowMs: Number(clock.now()) }),
      nowMs: Number(clock.now()),
      timeZone: config.digest.timezone
    });
    return buildPromptSection({ brief: b, maxTokens });
  }

  function query(params = {}) {
    if (!initPromise) return { ok: false, pending: true, items: [] };
    const items = pipeline.query(params);
    return { ok: true, items, count: items.length };
  }

  function watch(input = {}) {
    if (!initPromise) return { ok: false, pending: true, reason: '尚未初始化' };
    return watches.add(input);
  }

  function unwatch(input = {}) {
    if (!initPromise) return { ok: false, pending: true, reason: '尚未初始化' };
    return watches.remove(input);
  }

  function listWatches(params = {}) {
    if (!initPromise) return { ok: true, watches: [] };
    return { ok: true, watches: watches.list(params) };
  }

  async function syncAdapter(adapterId, reason = 'manual') {
    await init();
    if (!scheduler) {
      return { ok: false, reason: '调度未启动' };
    }
    return scheduler.syncOnce(String(adapterId), reason);
  }

  return {
    enabled: true,
    config,
    init,
    start,
    dispose,
    handleJob,
    status,
    brief,
    query,
    watch,
    unwatch,
    listWatches,
    promptSection,
    syncAdapter,
    previewModule,
    moduleStatus,
    actions,
    approvals,
    retention,
    health,
    pipeline,
    get scheduler() { return scheduler; },
    get adapters() { return adapters; },
    get invalidAdapters() { return invalid; },
    get started() { return started; },
    enabledAdapters
  };
}

export { normalizeLifeConfig, lifeEnabled, adapterEnabled, BRIEF_MAX_TOKENS };
export { defaultAdaptersDir } from './kernel/registry.js';
