// 分享模块状态：群级预算、模块/facet 计数、验证状态、旧 ai-tips 迁移。
// 纯文件读写 + 纯计算，不涉及网络。

import fs from 'node:fs';
import { atomicWriteJson } from '../kernel/state-file.js';
import { SHARE_LIMITS_DEFAULTS, normalizeShareWindows } from './share-modules.js';

export function localDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hourOf(now) {
  return new Date(now).getHours();
}

function emptyState() {
  return { version: 1, groups: {}, modules: {} };
}

export function loadShareState(file, { now = Date.now(), moduleIds = [] } = {}) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  const state = raw && typeof raw === 'object' ? { ...emptyState(), ...raw } : emptyState();
  state.groups = state.groups && typeof state.groups === 'object' ? state.groups : {};
  state.modules = state.modules && typeof state.modules === 'object' ? state.modules : {};
  const day = localDayKey(now);
  const hour = hourOf(now);
  for (const [key, group] of Object.entries(state.groups)) {
    const g = group && typeof group === 'object' ? group : {};
    state.groups[key] = {
      day: String(g.day || day),
      sentToday: Number(g.sentToday) || 0,
      hour: Number.isFinite(Number(g.hour)) ? Number(g.hour) : hour,
      hourCount: Number(g.hourCount) || 0,
      lastAt: Number(g.lastAt) || 0
    };
    if (state.groups[key].day !== day) {
      state.groups[key].day = day;
      state.groups[key].sentToday = 0;
    }
    if (state.groups[key].hour !== hour) {
      state.groups[key].hour = hour;
      state.groups[key].hourCount = 0;
    }
  }
  for (const id of moduleIds) {
    const cur = state.modules[id] && typeof state.modules[id] === 'object' ? state.modules[id] : {};
    const m = {
      day: String(cur.day || day),
      sentToday: Number(cur.sentToday) || 0,
      dailyTarget: Number(cur.dailyTarget) || 0,
      lastSentAt: Number(cur.lastSentAt) || 0,
      nextAt: Number(cur.nextAt) || 0,
      paused: cur.paused === true,
      verification: cur.verification && typeof cur.verification === 'object'
        ? { status: String(cur.verification.status || 'pending'), approvedAt: Number(cur.verification.approvedAt) || 0, approvedBy: String(cur.verification.approvedBy || '') }
        : { status: 'pending', approvedAt: 0, approvedBy: '' },
      facets: cur.facets && typeof cur.facets === 'object' ? cur.facets : {},
      history: Array.isArray(cur.history) ? cur.history.slice(0, 500) : [],
      lastPreview: cur.lastPreview && typeof cur.lastPreview === 'object' ? cur.lastPreview : null,
      pending: cur.pending && typeof cur.pending === 'object' ? cur.pending : null,
      _migrated: cur._migrated === true,
      _verificationSet: cur._verificationSet === true,
      stats: cur.stats && typeof cur.stats === 'object' ? cur.stats : { sent: 0, failed: 0 },
      lastError: String(cur.lastError || ''),
      lastErrorAt: Number(cur.lastErrorAt) || 0
    };
    if (m.day !== day) {
      m.day = day;
      m.sentToday = 0;
      m.dailyTarget = 0;
    }
    for (const [facetId, facet] of Object.entries(m.facets)) {
      const f = facet && typeof facet === 'object' ? facet : {};
      m.facets[facetId] = {
        day: String(f.day || day),
        count: Number(f.count) || 0,
        lastAt: Number(f.lastAt) || 0,
        lastError: String(f.lastError || '')
      };
      if (m.facets[facetId].day !== day) {
        m.facets[facetId].day = day;
        m.facets[facetId].count = 0;
      }
    }
    state.modules[id] = m;
  }
  const dailyRaw = state.daily && typeof state.daily === 'object' ? state.daily : {};
  const dailyWindows = {};
  if (dailyRaw.windows && typeof dailyRaw.windows === 'object') {
    for (const [key, value] of Object.entries(dailyRaw.windows)) {
      const count = Number(value);
      if (Number.isFinite(count) && count > 0) dailyWindows[String(key)] = Math.floor(count);
    }
  }
  state.daily = {
    day: String(dailyRaw.day || day),
    sent: Number.isFinite(Number(dailyRaw.sent)) ? Math.max(0, Math.floor(Number(dailyRaw.sent))) : 0,
    windows: dailyWindows
  };
  if (state.daily.day !== day) {
    state.daily = { day, sent: 0, windows: {} };
  }
  return state;
}

export function saveShareState(file, state) {
  atomicWriteJson(file, state);
}

export function groupBudgetCheck(state, key, now, limits = {}) {
  const day = localDayKey(now);
  const hour = hourOf(now);
  const group = state.groups?.[key] && typeof state.groups[key] === 'object' ? state.groups[key] : {};
  const sentToday = String(group.day || day) === day ? Number(group.sentToday) || 0 : 0;
  const hourCount = Number(group.hour) === hour ? Number(group.hourCount) || 0 : 0;
  const lastAt = Number(group.lastAt) || 0;
  const perDay = Math.max(1, Number(limits.perGroupPerDay) || 8);
  const perHour = Math.max(1, Number(limits.perGroupPerHour) || 3);
  const gap = Math.max(0, Number(limits.crossModuleGapMs) || 15 * 60 * 1000);
  if (sentToday >= perDay) return { ok: false, reason: 'group-daily-limit', sentToday, perDay };
  if (hourCount >= perHour) return { ok: false, reason: 'group-hourly-limit', hourCount, perHour };
  if (lastAt && now - lastAt < gap) return { ok: false, reason: 'group-gap', retryAt: lastAt + gap };
  return { ok: true, sentToday, hourCount };
}

export function recordGroupSend(state, key, now) {
  const day = localDayKey(now);
  const hour = hourOf(now);
  const cur = state.groups?.[key] && typeof state.groups[key] === 'object' ? state.groups[key] : {};
  const sentToday = String(cur.day || day) === day ? Number(cur.sentToday) || 0 : 0;
  const hourCount = Number(cur.hour) === hour ? Number(cur.hourCount) || 0 : 0;
  state.groups[key] = { day, sentToday: sentToday + 1, hour, hourCount: hourCount + 1, lastAt: now };
}

function globalLimits(limits = {}) {
  const configured = Number(limits?.globalMaxPerDay);
  const maxPerDay = Number.isFinite(configured)
    ? Math.max(0, Math.min(10, Math.floor(configured)))
    : SHARE_LIMITS_DEFAULTS.globalMaxPerDay;
  return { maxPerDay, windows: normalizeShareWindows(limits?.windows) };
}

function windowAt(now, windows) {
  const d = new Date(now);
  const hour = d.getHours() + d.getMinutes() / 60;
  return windows.find((item) => hour >= item.start && hour < item.end) || null;
}

function nextWindowStartMs(now, windows, { afterDay = false } = {}) {
  const startOf = (date, window) => {
    const d = new Date(date);
    d.setHours(window.start, 0, 0, 0);
    return d.getTime();
  };
  const d = new Date(now);
  if (afterDay) {
    d.setDate(d.getDate() + 1);
    return startOf(d, windows[0]);
  }
  for (const window of windows) {
    const at = startOf(d, window);
    if (at > now) return at;
  }
  d.setDate(d.getDate() + 1);
  return startOf(d, windows[0]);
}

/** 下一个可用窗口的开始时间；afterDay=true 时直接给次日首个窗口（每日总闸已满）。 */
export function nextGlobalWindowAt(now, limits = {}, options = {}) {
  const { windows } = globalLimits(limits);
  return nextWindowStartMs(now, windows, options);
}

/**
 * 所有分享模块共用的每日总闸：全天最多 globalMaxPerDay 条，
 * 每个时间窗最多 1 条（默认上午 7–12、下午 12–21），窗口外不发。
 */
export function globalBudgetCheck(state, now, limits = {}) {
  const { maxPerDay, windows } = globalLimits(limits);
  const day = localDayKey(now);
  const daily = state?.daily && typeof state.daily === 'object' ? state.daily : {};
  const sameDay = String(daily.day || '') === day;
  const sentToday = sameDay ? Math.max(0, Number(daily.sent) || 0) : 0;
  const counts = sameDay && daily.windows && typeof daily.windows === 'object' ? daily.windows : {};
  const window = windowAt(now, windows);
  if (sentToday >= maxPerDay) {
    return {
      ok: false,
      reason: 'global-daily-limit',
      sentToday,
      window: window ? window.start : null,
      nextAt: nextWindowStartMs(now, windows, { afterDay: true })
    };
  }
  if (!window) {
    return {
      ok: false,
      reason: 'global-outside-window',
      sentToday,
      window: null,
      nextAt: nextWindowStartMs(now, windows)
    };
  }
  const windowSent = Math.max(0, Number(counts[String(window.start)]) || 0);
  if (windowSent >= 1) {
    return {
      ok: false,
      reason: 'global-window-limit',
      sentToday,
      window: window.start,
      nextAt: nextWindowStartMs(now, windows)
    };
  }
  return { ok: true, reason: '', sentToday, window: window.start, nextAt: 0 };
}

/** 只有确认发送成功后才调用：全局 +1，并给当时所在窗口 +1。 */
export function recordGlobalSend(state, now = Date.now(), limits = {}) {
  if (!state || typeof state !== 'object') return null;
  const { windows } = globalLimits(limits);
  const day = localDayKey(now);
  const daily = state.daily && typeof state.daily === 'object' ? state.daily : {};
  if (String(daily.day || '') !== day) {
    daily.day = day;
    daily.sent = 0;
    daily.windows = {};
  }
  daily.sent = Math.max(0, Number(daily.sent) || 0) + 1;
  if (!daily.windows || typeof daily.windows !== 'object') daily.windows = {};
  const window = windowAt(now, windows);
  if (window) daily.windows[String(window.start)] = Math.max(0, Number(daily.windows[String(window.start)]) || 0) + 1;
  state.daily = daily;
  return daily;
}

export function recordModuleSend(state, moduleId, facetId, now, entry) {
  const day = localDayKey(now);
  const m = state.modules[moduleId];
  if (!m) return;
  m.day = day;
  m.sentToday = (Number(m.sentToday) || 0) + 1;
  m.lastSentAt = now;
  m.history.unshift({
    at: now,
    facetId,
    category: String(entry.category || ''),
    topic: String(entry.topic || entry.title || '').slice(0, 60),
    title: String(entry.title || '').slice(0, 60),
    text: String(entry.text || '').slice(0, 800),
    terms: Array.isArray(entry.terms) ? entry.terms.slice(0, 3) : [],
    links: Array.isArray(entry.links) ? entry.links.slice(0, 3) : [],
    imageSource: String(entry.imageSource || ''),
    imageHosts: String(entry.imageHosts || ''),
    time: String(entry.time || ''),
    sourceUrl: String(entry.sourceUrl || ''),
    url: String(entry.url || entry.sourceUrl || ''),
    source: String(entry.source || '')
  });
  m.history = m.history.slice(0, 500);
  const facet = m.facets[facetId] && typeof m.facets[facetId] === 'object' ? m.facets[facetId] : { day, count: 0, lastAt: 0 };
  m.facets[facetId] = {
    day,
    count: (String(facet.day || day) === day ? Number(facet.count) || 0 : 0) + 1,
    lastAt: now,
    lastError: ''
  };
  m.stats = m.stats && typeof m.stats === 'object' ? m.stats : { sent: 0, failed: 0 };
  m.stats.sent = (Number(m.stats.sent) || 0) + 1;
}

export function recordModuleFailure(state, moduleId, facetId, now, error) {
  const m = state.modules[moduleId];
  if (!m) return;
  m.lastError = String(error || '').slice(0, 200);
  m.lastErrorAt = now;
  m.stats = m.stats && typeof m.stats === 'object' ? m.stats : { sent: 0, failed: 0 };
  m.stats.failed = (Number(m.stats.failed) || 0) + 1;
  if (facetId && m.facets[facetId]) m.facets[facetId].lastError = String(error || '').slice(0, 200);
}

export function setVerification(state, moduleId, status, now = Date.now(), by = 'owner') {
  const m = state.modules[moduleId];
  if (!m) return null;
  m.verification = {
    status: status === 'approved' ? 'approved' : 'pending',
    approvedAt: status === 'approved' ? now : 0,
    approvedBy: status === 'approved' ? String(by || 'owner') : ''
  };
  return m.verification;
}

/** 旧 ai-tips.json → 通用模块状态；保留历史、预览和当日计数。 */
export function migrateAiTipsState(aiRaw, { moduleId = 'ai_tips', now = Date.now(), nextAt = 0 } = {}) {
  const raw = aiRaw && typeof aiRaw === 'object' ? aiRaw : {};
  const day = localDayKey(now);
  const history = (Array.isArray(raw.history) ? raw.history : []).map((item) => ({
    at: Number(item?.at) || 0,
    facetId: 'default',
    topic: String(item?.topic || item?.title || '').slice(0, 60),
    title: String(item?.title || '').slice(0, 60),
    text: String(item?.text || '').slice(0, 800),
    terms: Array.isArray(item?.terms) ? item.terms.slice(0, 3) : [],
    links: Array.isArray(item?.links) ? item.links.slice(0, 3) : [],
    imageSource: String(item?.imageSource || ''),
    imageHosts: String(item?.imageHosts || ''),
    time: '',
    sourceUrl: ''
  }));
  return {
    day: String(raw.day || day),
    sentToday: String(raw.day || day) === day ? Number(raw.sentToday) || 0 : 0,
    dailyTarget: String(raw.day || day) === day ? Number(raw.dailyTarget) || 0 : 0,
    lastSentAt: Number(raw.lastSentAt) || 0,
    nextAt: Number(nextAt) || 0,
    paused: raw.paused === true,
    verification: { status: 'approved', approvedAt: now, approvedBy: 'owner' },
    facets: {
      default: {
        day: String(raw.day || day),
        count: String(raw.day || day) === day ? Number(raw.sentToday) || 0 : 0,
        lastAt: Number(raw.lastSentAt) || 0,
        lastError: ''
      }
    },
    history,
    lastPreview: raw.lastPreview && typeof raw.lastPreview === 'object' ? raw.lastPreview : null,
    stats: { sent: history.length, failed: 0 },
    lastError: '',
    lastErrorAt: 0
  };
}
