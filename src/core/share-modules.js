// 通用分享模块：模板注册表、模块/facet 规范化、抽样、输出校验。
// 纯逻辑，不碰文件/网络，方便单测。

import { nextSlotAt, topicSimilarity } from './ai-tips.js';

export const SHARE_LIMITS_DEFAULTS = {
  perGroupPerDay: 8,
  perGroupPerHour: 3,
  crossModuleGapMs: 15 * 60 * 1000,
  moduleMaxPerDay: 3
};

const TEMPLATE_BASE = {
  textMin: 20,
  textMax: 400,
  titleMax: 20,
  links: true,
  maxLinks: 3,
  media: 'auto',
  maxImages: 2,
  approvalFirst: 0
};

export const SHARE_TEMPLATES = {
  knowledge: {
    ...TEMPLATE_BASE,
    label: '概念科普',
    fields: ['title', 'text', 'terms'],
    required: ['title', 'text', 'terms'],
    textMin: 180,
    textMax: 320,
    titleMax: 16,
    termsMin: 2,
    requireTechName: true,
    card: true
  },
  news: {
    ...TEMPLATE_BASE,
    label: '资讯/赛果',
    fields: ['title', 'text', 'time', 'sourceUrl'],
    required: ['title', 'text', 'time', 'sourceUrl'],
    textMin: 40,
    textMax: 600,
    titleMax: 60,
    links: true,
    card: false
  },
  fun: {
    ...TEMPLATE_BASE,
    label: '趣闻/轶事',
    fields: ['text'],
    required: ['text'],
    textMin: 15,
    textMax: 160,
    titleMax: 0,
    links: false,
    card: false
  },
  finance: {
    ...TEMPLATE_BASE,
    label: '金融常识',
    fields: ['title', 'text', 'terms', 'riskNote'],
    required: ['title', 'text', 'terms', 'riskNote'],
    textMin: 180,
    textMax: 360,
    titleMax: 20,
    termsMin: 2,
    requireTechName: false,
    card: true
  },
  story: {
    ...TEMPLATE_BASE,
    label: '历史/人物',
    fields: ['title', 'text', 'sourceUrl'],
    required: ['title', 'text', 'sourceUrl'],
    textMin: 80,
    textMax: 600,
    titleMax: 30,
    card: true
  },
  practical: {
    ...TEMPLATE_BASE,
    label: '实用技巧',
    fields: ['title', 'text', 'caveat'],
    required: ['title', 'text'],
    textMin: 60,
    textMax: 500,
    titleMax: 30,
    card: false
  },
  data: {
    ...TEMPLATE_BASE,
    label: '数据/趋势',
    fields: ['title', 'text', 'sourceUrl'],
    required: ['title', 'text', 'sourceUrl'],
    textMin: 60,
    textMax: 500,
    titleMax: 30,
    card: true
  },
  curated: {
    ...TEMPLATE_BASE,
    label: '文章推荐',
    fields: ['title', 'text', 'url'],
    required: ['title', 'text', 'url'],
    textMin: 30,
    textMax: 240,
    titleMax: 50,
    card: false
  },
  custom: {
    ...TEMPLATE_BASE,
    label: '自定义',
    fields: ['title', 'text'],
    required: ['text'],
    textMin: 40,
    textMax: 500,
    titleMax: 30,
    card: true
  }
};

export function templateFor(id) {
  return SHARE_TEMPLATES[String(id || '')] || SHARE_TEMPLATES.custom;
}

function clampText(input, max) {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalTargets(raw) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return [...new Set(list.map((k) => String(k || '').trim()).filter(Boolean))];
}

function merge(base, value) {
  return { ...base, ...(value && typeof value === 'object' ? value : {}) };
}

export function normalizeFacet(raw, module, index = 0) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const template = String(value.template || module.template || 'custom');
  const tpl = templateFor(template);
  const content = merge(module.content || {}, value.content);
  const facet = {
    id: String(value.id || (index === 0 ? 'default' : `facet${index + 1}`)),
    label: String(value.label || module.label || tpl.label),
    enabled: value.enabled !== false,
    template,
    // runtime=engine 走通用引擎；legacy-* 只登记/展示，仍由旧链路发送。
    runtime: String(value.runtime || ''),
    weight: Math.max(0.1, Math.min(10, Number(value.weight) || 1)),
    trigger: merge({ type: 'schedule' }, value.trigger),
    source: merge(module.source || { mode: 'model+web' }, value.source),
    delivery: merge(module.delivery || { mode: 'direct' }, value.delivery),
    content,
    limits: merge(module.limits || {}, value.limits),
    links: merge(module.links || { enabled: tpl.links, max: tpl.maxLinks }, value.links),
    media: merge(module.media || { mode: tpl.media, maxImages: tpl.maxImages, card: tpl.card }, value.media),
    dedupe: merge(module.dedupe || {}, value.dedupe),
    prompt: String(value.prompt || ''),
    categories: Array.isArray(value.categories && value.categories.length ? value.categories : module.categories)
      ? (value.categories && value.categories.length ? value.categories : module.categories)
      : []
  };
  const shared = {
    windowStartHour: module.trigger?.windowStartHour ?? 9,
    windowEndHour: module.trigger?.windowEndHour ?? 22,
    minGapMs: module.trigger?.minGapMs ?? 75 * 60 * 1000
  };
  facet.trigger = merge(shared, facet.trigger);
  if (!['schedule', 'feed-event'].includes(String(facet.trigger.type))) facet.trigger.type = 'schedule';
  return facet;
}

/** facet 实际运行时：facet 显式声明优先，其次模块默认，最后 engine。 */
export function facetRuntime(facet, module) {
  const value = String(facet?.runtime || module?.runtime || 'engine');
  return value || 'engine';
}

export function isEngineFacet(facet, module) {
  const runtime = facetRuntime(facet, module);
  if (runtime !== 'engine') return false;
  return String(facet?.trigger?.type || 'schedule') === 'schedule';
}

export function engineFacets(module) {
  return moduleFacets(module).filter((facet) => facet.enabled !== false && isEngineFacet(facet, module));
}

export function hasEngineFacets(module) {
  return engineFacets(module).length > 0;
}

export function normalizeShareModule(raw, id) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const moduleId = String(value.id || id || '').trim();
  const template = String(value.template || 'custom');
  const tpl = templateFor(template);
  const base = {
    id: moduleId,
    label: String(value.label || moduleId || tpl.label),
    enabled: value.enabled !== false,
    runtime: String(value.runtime || 'engine'),
    template,
    targets: normalTargets(value.targets ?? value.target),
    rotateTargets: value.rotateTargets !== false,
    trigger: merge({ type: 'schedule', windowStartHour: 9, windowEndHour: 22, minGapMs: 75 * 60 * 1000 }, value.trigger),
    limits: merge({ minPerDay: 1, maxPerDay: SHARE_LIMITS_DEFAULTS.moduleMaxPerDay }, value.limits),
    content: merge({
      audience: '完全不懂这个领域的长辈',
      tone: '通俗、自然、不夸大',
      minChars: tpl.textMin,
      maxChars: tpl.textMax,
      requireTechName: Boolean(tpl.requireTechName),
      titleRule: '',
      disclaimer: '',
      customInstruction: ''
    }, value.content),
    source: merge({ mode: 'model+web', queryTemplate: '', feeds: [], freshnessHours: 48 }, value.source),
    links: merge({ enabled: Boolean(tpl.links), max: tpl.maxLinks || 3 }, value.links),
    media: merge({ mode: tpl.media || 'auto', maxImages: tpl.maxImages || 2, card: Boolean(tpl.card) }, value.media),
    dedupe: merge({ recent: 30, topicThreshold: 0.65, textThreshold: 0.78 }, value.dedupe),
    delivery: merge({ mode: 'approval', approvalFirst: 0 }, value.delivery),
    verification: merge({ status: 'pending', approvedAt: 0, approvedBy: '' }, value.verification),
    paused: value.paused === true,
    categories: Array.isArray(value.categories) ? value.categories : [],
    facets: []
  };
  const rawFacets = Array.isArray(value.facets) && value.facets.length ? value.facets : [{}];
  base.facets = rawFacets.map((facet, index) => normalizeFacet(facet, base, index));
  // 模块级上限兜底：至少覆盖所有 facet 的每日上限之和。
  const facetMax = base.facets.reduce((sum, facet) => sum + Math.max(0, Number(facet.limits.maxPerDay) || 0), 0);
  base.limits.maxPerDay = Math.max(1, Math.min(10, Number(base.limits.maxPerDay) || facetMax || 3));
  return base;
}

export function normalizeShareConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const modulesRaw = value.modules && typeof value.modules === 'object' ? value.modules : {};
  const modules = {};
  for (const [id, item] of Object.entries(modulesRaw)) {
    const normalized = normalizeShareModule(item, id);
    if (normalized.id) modules[normalized.id] = normalized;
  }
  return {
    enabled: value.enabled !== false,
    limits: merge(SHARE_LIMITS_DEFAULTS, value.limits),
    modules
  };
}

export function moduleFacets(module) {
  return Array.isArray(module?.facets) && module.facets.length ? module.facets : normalizeShareModule(module, module?.id).facets;
}

export function facetStateKey(moduleId, facetId) {
  return `${moduleId}:${facetId}`;
}

export function inWindowAt(now, startHour, endHour) {
  const d = new Date(Number(now) || Date.now());
  const h = d.getHours() + d.getMinutes() / 60;
  const start = Math.max(0, Math.min(23, Number(startHour) || 0));
  const end = Math.max(1, Math.min(24, Number(endHour) || 24));
  if (end > start) return h >= start && h < end;
  return h >= start || h < end;
}

export function nextFacetAt(facet, lastAt = 0, now = Date.now(), rng = Math.random) {
  const schedule = facet.trigger || {};
  return nextSlotAt({
    now,
    lastSentAt: lastAt,
    minGapMs: Math.max(10 * 60 * 1000, Number(schedule.minGapMs) || 75 * 60 * 1000),
    jitterMs: 90 * 60 * 1000,
    startHour: Number(schedule.windowStartHour) || 9,
    endHour: Number(schedule.windowEndHour) || 22
  }, rng);
}

/**
 * 在可用 facet 里按权重抽一个；facet 的窗口/每日上限/暂停状态不满足就跳过。
 * moduleState.facets = { [facetId]: { day, count, lastAt } }
 */
export function pickShareFacet(module, moduleState, now = Date.now(), rng = Math.random) {
  const day = new Date(now).toISOString().slice(0, 10);
  const facets = engineFacets(module);
  const candidates = [];
  for (const facet of facets) {
    if (facet.trigger?.type !== 'schedule') continue;
    if (!inWindowAt(now, facet.trigger.windowStartHour, facet.trigger.windowEndHour)) continue;
    const st = moduleState?.facets?.[facet.id] || {};
    const count = st.day === day ? Number(st.count) || 0 : 0;
    const max = Math.max(0, Number(facet.limits?.maxPerDay) || 0);
    if (max > 0 && count >= max) continue;
    const lastAt = Number(st.lastAt) || 0;
    const gap = Math.max(0, Number(facet.trigger.minGapMs) || 0);
    if (lastAt && now - lastAt < gap) continue;
    candidates.push({ facet, weight: Math.max(0.1, Number(facet.weight) || 1) });
  }
  if (!candidates.length) return null;
  const total = candidates.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of candidates) {
    roll -= item.weight;
    if (roll <= 0) return item.facet;
  }
  return candidates[candidates.length - 1].facet;
}

export function parseShareOutput(output) {
  const raw = String(output ?? '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  const fenced = raw.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'not-json' };
  try {
    const obj = JSON.parse(fenced.slice(start, end + 1));
    return obj && typeof obj === 'object' ? { ok: true, value: obj } : { ok: false, error: 'not-object' };
  } catch {
    return { ok: false, error: 'bad-json' };
  }
}

export function validateShareOutput(templateId, obj, module, facet) {
  const tpl = templateFor(templateId || facet?.template || module?.template);
  const content = merge(module?.content || {}, facet?.content);
  const text = clampText(obj?.text || obj?.content || '', Number(content.maxChars) || tpl.textMax);
  const title = clampText(obj?.title || obj?.headline || '', Number(content.titleMax) || tpl.titleMax || 0);
  const min = Math.max(0, Number(content.minChars) || tpl.textMin);
  const max = Math.max(min, Number(content.maxChars) || tpl.textMax);
  if (!text) return { ok: false, error: 'empty-text' };
  if (text.length < min) return { ok: false, error: 'too-short' };
  if (text.length > max) return { ok: false, error: 'too-long' };
  if (tpl.titleMax > 0 && title.length > tpl.titleMax) return { ok: false, error: 'title-too-long' };
  if (tpl.required?.includes('title') && !title) return { ok: false, error: 'missing-title' };

  const terms = Array.isArray(obj?.terms)
    ? obj.terms.map((item) => ({ name: clampText(item?.name, 20), plain: clampText(item?.plain || item?.meaning, 60) })).filter((item) => item.name && item.plain).slice(0, 3)
    : [];
  if ((tpl.termsMin || 0) > terms.length) return { ok: false, error: 'missing-terms' };

  const techName = clampText(obj?.techName || '', 20);
  if (tpl.requireTechName && content.requireTechName !== false) {
    if (!techName) return { ok: false, error: 'missing-tech-name' };
    if (!text.toLowerCase().includes(techName.toLowerCase())) return { ok: false, error: 'tech-name-not-in-text' };
  }

  const time = clampText(obj?.time || '', 40);
  const sourceUrl = String(obj?.sourceUrl || obj?.url || '').trim();
  if (tpl.required?.includes('time') && !time) return { ok: false, error: 'missing-time' };
  if ((tpl.required?.includes('sourceUrl') || tpl.required?.includes('url')) && !/^https?:\/\//i.test(sourceUrl)) {
    return { ok: false, error: 'missing-source-url' };
  }
  const riskNote = clampText(obj?.riskNote || '', 120);
  if (tpl.required?.includes('riskNote') && !riskNote) return { ok: false, error: 'missing-risk-note' };
  const caveat = clampText(obj?.caveat || '', 120);

  return {
    ok: true,
    value: {
      template: templateId || facet?.template || module?.template,
      title,
      text,
      terms,
      techName,
      riskNote,
      caveat,
      time,
      sourceUrl,
      keyTerm: clampText(obj?.keyTerm || '', 40),
      searchQuery: clampText(obj?.searchQuery || '', 100),
      phenomenon: clampText(obj?.phenomenon || '', 40),
      tech: clampText(obj?.tech || '', 60),
      how: clampText(obj?.how || '', 80)
    }
  };
}

export function verificationPending(module, moduleState) {
  const status = String(moduleState?.verification?.status || module?.verification?.status || 'pending');
  return status !== 'approved';
}

export function moduleDayTarget(module, rng = Math.random) {
  const min = Math.max(0, Math.min(10, Number(module?.limits?.minPerDay) || 0));
  const max = Math.max(min, Math.min(10, Number(module?.limits?.maxPerDay) || min));
  return min + Math.floor(rng() * (max - min + 1));
}

export function topicTooSimilar(topic, history, opts = {}) {
  const list = Array.isArray(history) ? history.slice(0, Math.max(1, Number(opts.recent) || 30)) : [];
  const key = String(topic || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  for (const item of list) {
    const other = String(item?.topic || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (key && other && key === other) return true;
    if (topic && item?.topic && topicSimilarity(topic, item.topic) >= (Number(opts.threshold) || 0.65)) return true;
  }
  return false;
}

function urlKey(url) {
  return String(url || '').trim().split('#')[0].replace(/\/+$/, '').toLowerCase();
}

/** 跨模块/跨期去重：同一链接只发一次。history 可传多个模块的 history 合并数组。 */
export function recentShareUrls(history, limit = 200) {
  const set = new Set();
  for (const item of (Array.isArray(history) ? history : []).slice(0, limit)) {
    if (item?.sourceUrl) set.add(urlKey(item.sourceUrl));
    for (const link of Array.isArray(item?.links) ? item.links : []) {
      if (link?.url) set.add(urlKey(link.url));
    }
    if (item?.url) set.add(urlKey(item.url));
  }
  return set;
}

export function urlAlreadyShared(url, historyOrSet, limit = 200) {
  const key = urlKey(url);
  if (!key) return false;
  const set = historyOrSet instanceof Set ? historyOrSet : recentShareUrls(historyOrSet, limit);
  return set.has(key);
}
