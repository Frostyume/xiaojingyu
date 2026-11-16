// 生活管家配置归一化（纯函数，无 IO）。
//
// 默认值以 docs/LIFE_BUTLER.md 1.6 为准；这里只做「缺省补齐 + 类型校正」，
// 不读文件、不碰数据库，便于测试与桥接/MCP 两边共用同一套语义。

export const LIFE_ADAPTER_IDS = Object.freeze(['calendar-ics', 'github', 'arxiv', 'rss', 'paper']);

/**
 * 带独立推送/监控排期的模块。
 * 适配器与模块不一定同名：日历晨报复用 calendar-ics，RSS 摘要复用 rss，
 * 每周回顾不依赖适配器（只读本地库）。
 */
export const LIFE_MODULE_IDS = Object.freeze(['paper', 'github', 'calendarMorning', 'rssDigest', 'weeklyReview']);

export const LIFE_MODULE_ADAPTERS = Object.freeze({
  paper: 'paper',
  github: 'github',
  calendarMorning: 'calendar-ics',
  rssDigest: 'rss',
  weeklyReview: null
});

/** 适配器完全由同名模块接管：只认模块开关，避免绕过模块单独跑。 */
const MODULE_OWNED_ADAPTERS = Object.freeze(['paper', 'github']);

export const PAPER_TOPIC_DEFAULTS = Object.freeze(['cs.AI', 'cs.CL', 'cs.CV', 'cs.LG']);
export const PAPER_SOURCES = Object.freeze(['openalex', 'arxiv']);
export const MODULE_FREQUENCIES = Object.freeze(['daily', 'weekly', 'interval']);
export const RSS_MAX_FEEDS = 12;

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (min != null && rounded < min) return min;
  if (max != null && rounded > max) return max;
  return rounded;
}

function hhmm(value, fallback) {
  const text = String(value ?? '').trim();
  return HHMM.test(text) ? text.padStart(5, '0') : fallback;
}

function str(value, fallback = '', max = 240) {
  if (typeof value !== 'string') return fallback;
  return value.slice(0, max);
}

function stringList(value, { max = 12, maxChars = 60, fallback = [] } = {}) {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = String(item ?? '').trim().slice(0, maxChars);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out.length ? out : [...fallback];
}

function frequency(value, fallback = 'daily') {
  const text = String(value ?? '').trim();
  return MODULE_FREQUENCIES.includes(text) ? text : fallback;
}

function weekday(value, fallback = 1) {
  return int(value, fallback, 1, 7);
}

function normalizePaperModule(raw) {
  const src = asObject(raw);
  return {
    enabled: src.enabled === true,
    topics: stringList(src.topics, { max: 8, maxChars: 40, fallback: PAPER_TOPIC_DEFAULTS }),
    keywords: stringList(src.keywords, { max: 10, maxChars: 60, fallback: [] }),
    frequency: frequency(src.frequency, 'daily'),
    time: hhmm(src.time, '09:00'),
    weekday: weekday(src.weekday, 1),
    intervalDays: int(src.intervalDays, 3, 1, 30),
    count: int(src.count, 5, 1, 20),
    source: PAPER_SOURCES.includes(String(src.source ?? '')) ? String(src.source) : 'openalex',
    windowDays: int(src.windowDays, 7, 1, 30)
  };
}

function normalizeGithubModule(raw) {
  const src = asObject(raw);
  const seen = new Set();
  const repos = [];
  for (const item of (Array.isArray(src.repos) ? src.repos : [])) {
    const repo = String(item ?? '').trim().slice(0, 140);
    const key = repo.toLowerCase();
    if (!REPO_RE.test(repo) || seen.has(key)) continue;
    seen.add(key);
    repos.push(repo);
    if (repos.length >= 20) break;
  }
  const metrics = asObject(src.metrics);
  return {
    enabled: src.enabled === true,
    repos,
    metrics: {
      stars: bool(metrics.stars, true),
      forks: bool(metrics.forks, true),
      issues: bool(metrics.issues, true),
      pulls: bool(metrics.pulls, true),
      releases: bool(metrics.releases, true)
    },
    frequency: frequency(src.frequency, 'daily'),
    time: hhmm(src.time, '09:00'),
    weekday: weekday(src.weekday, 1),
    intervalDays: int(src.intervalDays, 1, 1, 30),
    notifyNoChanges: src.notifyNoChanges === true,
    // 只由桥接在运行时从 state/life-secrets.json 注入；不写入 config.json。
    token: typeof src.token === 'string' ? src.token.trim().slice(0, 255) : ''
  };
}

function normalizeFeeds(value) {
  const out = [];
  const seen = new Set();
  for (const item of (Array.isArray(value) ? value : [])) {
    let name = '';
    let url = '';
    if (typeof item === 'string') {
      const bar = item.indexOf('|');
      if (bar > 0) {
        name = item.slice(0, bar);
        url = item.slice(bar + 1);
      } else {
        url = item;
      }
    } else if (item && typeof item === 'object') {
      name = String(item.name ?? '');
      url = String(item.url ?? '');
    }
    url = url.trim().slice(0, 500);
    if (!url) continue;
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (!/^https?:$/.test(parsed.protocol)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: (name.trim() || parsed.hostname).slice(0, 40), url });
    if (out.length >= RSS_MAX_FEEDS) break;
  }
  return out;
}

function normalizeCalendarMorningModule(raw) {
  const src = asObject(raw);
  return {
    enabled: src.enabled === true,
    time: hhmm(src.time, '07:30'),
    weekdaysOnly: bool(src.weekdaysOnly, false),
    lookaheadDays: int(src.lookaheadDays, 1, 1, 7),
    showConflicts: bool(src.showConflicts, true),
    tomorrowPreview: bool(src.tomorrowPreview, true)
  };
}

function normalizeRssDigestModule(raw) {
  const src = asObject(raw);
  return {
    enabled: src.enabled === true,
    feeds: normalizeFeeds(src.feeds),
    frequency: frequency(src.frequency, 'daily'),
    time: hhmm(src.time, '08:00'),
    weekday: weekday(src.weekday, 1),
    intervalDays: int(src.intervalDays, 3, 1, 30),
    count: int(src.count, 8, 1, 30),
    perFeedLimit: int(src.perFeedLimit, 3, 1, 10),
    showSummary: bool(src.showSummary, true)
  };
}

function normalizeWeeklyReviewModule(raw) {
  const src = asObject(raw);
  const sections = asObject(src.sections);
  return {
    enabled: src.enabled === true,
    weekday: weekday(src.weekday, 7),
    time: hhmm(src.time, '20:00'),
    sections: {
      paper: bool(sections.paper, true),
      github: bool(sections.github, true),
      reminders: bool(sections.reminders, true),
      digest: bool(sections.digest, true)
    }
  };
}

export function normalizeLifeModules(raw) {
  const src = asObject(raw);
  return {
    paper: normalizePaperModule(src.paper),
    github: normalizeGithubModule(src.github),
    calendarMorning: normalizeCalendarMorningModule(src.calendarMorning),
    rssDigest: normalizeRssDigestModule(src.rssDigest),
    weeklyReview: normalizeWeeklyReviewModule(src.weeklyReview)
  };
}

/** 适配器对应的模块 id（calendar-ics → calendarMorning，rss → rssDigest）。 */
export function moduleIdForAdapter(adapterId) {
  for (const id of LIFE_MODULE_IDS) {
    if (LIFE_MODULE_ADAPTERS[id] === adapterId) return id;
  }
  return null;
}

export function defaultLifeConfig() {
  return {
    enabled: false,
    digest: {
      enabled: false,
      morning: '08:00',
      evening: '22:30',
      timezone: 'Asia/Shanghai',
      sections: { calendar: true, reminders: true, paper: false, github: false }
    },
    quietHours: { enabled: true, start: '23:30', end: '08:30' },
    notify: { channel: 'owner-private', coalesceMs: 600000, maxPerHour: 6 },
    promptSection: { enabled: false },
    actions: {
      l2Enabled: false,
      l3Enabled: false,
      approvalTtlMs: 600000,
      dryRunDefault: true,
      monthlyBudgetCny: 0
    },
    retention: { rawDays: 0, itemDays: 90, actionDays: 180, healthDays: 30 },
    adapters: Object.fromEntries(LIFE_ADAPTER_IDS.map((id) => [id, { enabled: false }])),
    modules: normalizeLifeModules({}),
    concurrency: { perAdapter: 1, global: 3 }
  };
}

/**
 * 归一化 lifeButler 配置。
 *
 * 适配器段保留用户额外字段（url、token、lookaheadDays 等），只校正 enabled；
 * 未登记的适配器 id 原样保留但不参与内核调度（registry 只加载 manifest 存在的目录）。
 */
export function normalizeLifeConfig(raw) {
  const src = asObject(raw);
  const defaults = defaultLifeConfig();
  const adapters = {};
  for (const id of LIFE_ADAPTER_IDS) adapters[id] = { ...defaults.adapters[id] };
  for (const [id, value] of Object.entries(asObject(src.adapters))) {
    const item = asObject(value);
    adapters[id] = { ...(adapters[id] ?? {}), ...item, enabled: item.enabled === true };
  }
  return {
    enabled: src.enabled === true,
    digest: {
      enabled: asObject(src.digest).enabled === true,
      morning: hhmm(asObject(src.digest).morning, defaults.digest.morning),
      evening: hhmm(asObject(src.digest).evening, defaults.digest.evening),
      timezone: str(asObject(src.digest).timezone, defaults.digest.timezone, 64),
      sections: {
        calendar: bool(asObject(asObject(src.digest).sections).calendar, true),
        reminders: bool(asObject(asObject(src.digest).sections).reminders, true),
        paper: bool(asObject(asObject(src.digest).sections).paper, false),
        github: bool(asObject(asObject(src.digest).sections).github, false)
      }
    },
    quietHours: {
      enabled: bool(asObject(src.quietHours).enabled, defaults.quietHours.enabled),
      start: hhmm(asObject(src.quietHours).start, defaults.quietHours.start),
      end: hhmm(asObject(src.quietHours).end, defaults.quietHours.end)
    },
    notify: {
      channel: str(asObject(src.notify).channel, defaults.notify.channel, 40),
      coalesceMs: int(asObject(src.notify).coalesceMs, defaults.notify.coalesceMs, 0, 86400000),
      maxPerHour: int(asObject(src.notify).maxPerHour, defaults.notify.maxPerHour, 0, 60)
    },
    promptSection: { enabled: asObject(src.promptSection).enabled === true },
    actions: {
      l2Enabled: asObject(src.actions).l2Enabled === true,
      l3Enabled: false,
      approvalTtlMs: int(asObject(src.actions).approvalTtlMs, defaults.actions.approvalTtlMs, 60000, 3600000),
      dryRunDefault: bool(asObject(src.actions).dryRunDefault, true),
      monthlyBudgetCny: int(asObject(src.actions).monthlyBudgetCny, 0, 0, 1000000)
    },
    retention: {
      rawDays: 0,
      itemDays: int(asObject(src.retention).itemDays, defaults.retention.itemDays, 1, 3650),
      actionDays: int(asObject(src.retention).actionDays, defaults.retention.actionDays, 1, 3650),
      healthDays: int(asObject(src.retention).healthDays, defaults.retention.healthDays, 1, 3650)
    },
    adapters,
    modules: normalizeLifeModules(src.modules),
    concurrency: {
      perAdapter: 1,
      global: int(asObject(src.concurrency).global, defaults.concurrency.global, 1, 8)
    }
  };
}

/**
 * 适配器是否启用：总开关关掉时一律视为关闭（kill switch 先于单适配器开关）。
 * paper/github 由同名模块接管；calendar-ics/rss 既可被模块接管，也可单独开启（供日报用）。
 */
export function adapterEnabled(config, id) {
  if (config?.enabled !== true) return false;
  if (MODULE_OWNED_ADAPTERS.includes(id)) return config?.modules?.[id]?.enabled === true;
  const moduleId = moduleIdForAdapter(id);
  if (moduleId && config?.modules?.[moduleId]?.enabled === true) return true;
  return config?.adapters?.[id]?.enabled === true;
}

/** 模块（论文 / GitHub / 日历晨报 / RSS 摘要 / 每周回顾）是否启用；总开关关闭时同样视为关闭。 */
export function moduleEnabled(config, id) {
  return config?.enabled === true && config?.modules?.[id]?.enabled === true;
}

/** 供提示词/MCP 判断「生活管家是否可用」。 */
export function lifeEnabled(config) {
  return config?.enabled === true;
}
