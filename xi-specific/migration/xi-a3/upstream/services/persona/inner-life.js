// 小鲸鱼的“内心生活”：人格状态、好奇浏览、群内分享、QQ 空间说说。
//
// 运行方式：
//   - 所有内心活动都走一个**独立的 DSH 会话**（不绑定 QQ、没有 agent token），
//     由本模块自己 follow 事件、收集 turn 文本；即使模型想调用 qq_* 发送工具也发不出去。
//   - 调度器随机安排好奇/反思/说说，全部有每日上限、安静时段和“没意思就跳过”。
//   - 空间说说前 N 条先私聊主人审核；审核通过才调 SnowLuma send_qzone_msg。
//
// 依赖由 bridge.js 注入（见文件底部 createInnerLife 调用处），避免和桥接主程序耦合。

import fs from 'node:fs';
import { atomicWriteJson } from '../../runtime/kernel/state-file.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createTurnCollector } from '../../channels/dsh/client.js';
import { defaultPersonaState, normalizePersonaState, applyReflection, applyReflectionV3, applyMoodNudge, renderPersonaStateBlock, describePersonaState, MOOD_V3_DEFAULTS, targetEnergyAt, moodTierLabel } from './persona-state.js';
import { appendMoodHistory, readMoodHistory, summarizeMoodHistory } from '../../runtime/persona/mood-history.js';
import { derivePersonaMode, renderPersonaMode } from '../../runtime/persona/persona-mode.js';
import { collectCandidates, rankCandidates, formatCandidatesForPrompt, extractUrls, candidateUrlKey } from './curiosity.js';
import { webSearch } from '../social/web-search.js';
import { safeFetch, safeFetchBuffer } from '../social/safe-fetch.js';
import { CONTENT_VOICE_BLOCK, CONTENT_VOICE_HINT, SHARE_VOICE_BLOCK } from '../../runtime/persona/persona-voice.js';
import { timeStampCN, currentTimeBlock, timeConflict } from '../../runtime/kernel/time-awareness.js';
import { postQzone as defaultPostQzone, listQzone, deleteQzone, qzoneHasContent, qzoneItemTid, qzoneVisibilityLabel, getQzoneFeeds, commentQzone, parseQzoneComments, parseQzoneFeedPost, getQzoneSelfUin, getQzoneMsgDetail, parseQzoneFeedImages } from '../social/qzone.js';
import { DEFAULT_QUIET_HOURS, normalizeQuietHours, isQuietNow, quietEndAt } from './quiet-hours.js';
import { SENSITIVE_RE } from '../../runtime/kernel/sensitive.js';
import { AI_TIP_CATEGORIES, categoryById, inWindow, isDuplicateTip, nextSlotAt, pickCategory, pickTipLinks, parseTipOutput, rollDailyTarget } from '../../runtime/persona/ai-tips.js';
import { normalizeShareConfig, normalizeShareModule, moduleFacets, engineFacets, hasEngineFacets, facetRuntime, pickShareFacet, parseShareOutput, validateShareOutput, verificationPending, moduleDayTarget, nextFacetAt, inWindowAt, topicTooSimilar, recentShareUrls, urlAlreadyShared, SHARE_TEMPLATES } from '../../runtime/share/share-modules.js';
import { loadShareState, saveShareState, groupBudgetCheck, recordGroupSend, recordModuleSend, recordModuleFailure, setVerification, migrateAiTipsState, localDayKey as shareDayKey } from '../../runtime/share/share-state.js';
import { buildShareTask } from '../../runtime/share/share-prompts.js';
import { formatShareCaption, formatShareLinksText, formatAiTipLinks, formatTipCaption } from '../../runtime/share/share-format.js';

const DEFAULTS = {
  reflection: { enabled: true, minIntervalMs: 1 * 3600 * 1000, maxIntervalMs: 8 * 3600 * 1000 },
  curiosity: {
    enabled: true,
    minPerDay: 5,
    maxPerDay: 12,
    refreshMs: 2 * 3600 * 1000,
    maxCandidates: 10,
    webSearch: { enabled: true, maxQueries: 1, maxResults: 5 },
    sources: { bilibili: true, s16: true, rss: ['https://sspai.com/feed', 'https://www.ithome.com/rss/'] }
  },
  groupShare: { enabled: true, target: '', maxPerDay: 20, minGapMs: 15 * 60 * 1000, idleMs: 2 * 60 * 1000, maxChars: 500, requireApproval: false },
  aiTips: {
    enabled: false,
    target: '',
    minPerDay: 2,
    maxPerDay: 5,
    windowStartHour: 9,
    windowEndHour: 22,
    minGapMs: 75 * 60 * 1000,
    maxChars: 320,
    maxHistory: 500,
    images: true,
    webImages: true,
    links: true,
    maxLinks: 3
  },
  qzone: { enabled: true, visibility: 4, maxPerDay: 10, minGapMs: 1 * 3600 * 1000, maxChars: 150, approvalFirst: 0, requireApproval: false, skipProbability: 0.05, commentReply: { enabled: true, pollMs: 5 * 60 * 1000, maxPerDay: 10, mentionEnabled: true, mentionMaxPerDay: 5, mentionNames: ['小鲸鱼', 'DeepSeek'], requireApproval: true, approvalTimeoutMs: 2 * 3600 * 1000 } },
  mood: { ...MOOD_V3_DEFAULTS },
  quiet: { ...DEFAULT_QUIET_HOURS },
  approvalTimeoutMs: 2 * 3600 * 1000
};

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  return atomicWriteJson(file, value);
}

function cleanLine(value, maxChars) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function stripFence(text) {
  return String(text ?? '').replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim();
}

function firstJsonObject(text) {
  const s = stripFence(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function localDayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function rand(min, max) {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return Math.floor(a + Math.random() * (b - a));
}

export function createInnerLife(deps) {
  const postQzone = deps.postQzone ?? defaultPostQzone;
  const {
    cfg,
    api,
    log,
    stateDir,
    sendToQQ,
    onebotSend,
    lastSendSucceeded,
    getSimulationState,
    getEsportsFeed,
    isSessionAllowedInCurrentMode,
    ensureChatModel,
    resolvePresetName,
    unwrap,
    getRoleText,
    isDshReady,
    getMode,
    isPaused,
    mdToPlain,
    appendActivity,
    imageLibrary,
    collectImageStickers,
    relationshipStore
  } = deps;

  const files = {
    persona: path.join(stateDir, 'persona-state.json'),
    curiosity: path.join(stateDir, 'curiosity.json'),
    inner: path.join(stateDir, 'inner-life.json'),
    session: path.join(stateDir, 'inner-session.json'),
    qzoneComments: path.join(stateDir, 'qzone-comments.json'),
    aiTips: path.join(stateDir, 'ai-tips.json'),
    shareModules: path.join(stateDir, 'share-modules.json'),
    moodHistory: path.join(stateDir, 'persona-history.jsonl')
  };

  const innerSessions = new Set();
  const collectors = new Map();
  const waiters = new Map();
  let innerSessionId = null;
  let timer = null;
  let taskChain = Promise.resolve();
  let started = false;
  let running = false;

  function ilCfg() {
    const raw = cfg.simulation?.innerLife && typeof cfg.simulation.innerLife === 'object' ? cfg.simulation.innerLife : {};
    const merge = (base, value) => ({ ...base, ...(value && typeof value === 'object' ? value : {}) });
    const curiosity = merge(DEFAULTS.curiosity, raw.curiosity);
    curiosity.webSearch = merge(DEFAULTS.curiosity.webSearch, raw.curiosity?.webSearch);
    curiosity.sources = merge(DEFAULTS.curiosity.sources, raw.curiosity?.sources);
    const mood = merge(MOOD_V3_DEFAULTS, raw.mood);
    mood.decay = merge(MOOD_V3_DEFAULTS.decay, raw.mood?.decay);
    mood.setPoint = merge(MOOD_V3_DEFAULTS.setPoint, raw.mood?.setPoint);
    mood.budgets = merge(MOOD_V3_DEFAULTS.budgets, raw.mood?.budgets);
    mood.history = merge(MOOD_V3_DEFAULTS.history, raw.mood?.history);
    mood.eventNudge = merge(MOOD_V3_DEFAULTS.eventNudge || {}, raw.mood?.eventNudge);
    return {
      enabled: raw.enabled === true,
      dryRun: raw.dryRun === true,
      quiet: normalizeQuietHours(cfg.simulation?.nightQuiet ?? raw.quiet ?? DEFAULTS.quiet),
      approvalTimeoutMs: Math.max(60 * 1000, Number(raw.approvalTimeoutMs) || DEFAULTS.approvalTimeoutMs),
      reflection: merge(DEFAULTS.reflection, raw.reflection),
      curiosity,
      groupShare: merge(DEFAULTS.groupShare, raw.groupShare),
      aiTips: merge(DEFAULTS.aiTips, raw.aiTips),
      qzone: merge(DEFAULTS.qzone, raw.qzone),
      mood
    };
  }

  // 主动分享可以有多个目标群：targets 是首选，旧配置的 target 仍兼容。
  // 每轮只挑一个群发，避免同一句同时刷到所有群。
  function shareTargets(il) {
    const raw = Array.isArray(il.groupShare?.targets) ? il.groupShare.targets : [];
    const legacy = String(il.groupShare?.target ?? '').trim();
    const list = raw.length
      ? raw
      : legacy
        ? legacy.split(/[,，\s]+/)
        : (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.map((id) => `group:${id}`) : []);
    const out = [];
    for (const item of list) {
      const key = String(item ?? '').trim();
      if (!/^group:\d+$/.test(key) || out.includes(key)) continue;
      try {
        if (!isSessionAllowedInCurrentMode(key)) continue;
      } catch {
        continue;
      }
      out.push(key);
    }
    return out;
  }

  function targetKey(il) {
    const targets = shareTargets(il);
    return targets[0] || '';
  }

  function pickShareTarget(il, state, now = Date.now()) {
    const targets = shareTargets(il);
    if (!targets.length) return '';
    const minGap = Math.max(0, Number(il.groupShare?.minGapMs) || 0);
    const idleMs = Math.max(0, Number(il.groupShare?.idleMs) || 0);
    const lastMap = state.lastShareByTarget && typeof state.lastShareByTarget === 'object' ? state.lastShareByTarget : {};
    let best = '';
    let bestAt = Number.POSITIVE_INFINITY;
    for (const key of targets) {
      const last = Number(lastMap[key]) || 0;
      if (minGap > 0 && last && now - last < minGap) continue;
      let st;
      try {
        st = getSimulationState(key);
      } catch {
        continue;
      }
      if (idleMs > 0 && st.lastIncomingAt && now - Number(st.lastIncomingAt) < idleMs) continue;
      if (last < bestAt) {
        bestAt = last;
        best = key;
      }
    }
    return best;
  }

  function targetState(il) {
    const key = targetKey(il);
    if (!key) return null;
    try {
      if (!isSessionAllowedInCurrentMode(key)) return null;
      return { key, st: getSimulationState(key) };
    } catch {
      return null;
    }
  }

  function loadPersona() {
    return normalizePersonaState(readJson(files.persona, defaultPersonaState()), Date.now());
  }

  function savePersona(state) {
    writeJson(files.persona, state);
  }

  function personaBlock() {
    try {
      const state = loadPersona();
      const il = ilCfg();
      const mode = derivePersonaMode(state, { quiet: isQuiet(il) });
      return `${renderPersonaStateBlock(state)}\n${renderPersonaMode(mode)}`;
    } catch { return ''; }
  }

  function personaInfo() {
    const state = loadPersona();
    const mode = derivePersonaMode(state, { quiet: isQuiet(ilCfg()) });
    return { block: `${renderPersonaStateBlock(state)}\n${renderPersonaMode(mode)}`, detail: describePersonaState(state), state, mode };
  }

  function loadCuriosity() {
    const raw = readJson(files.curiosity, {}) || {};
    return {
      cookies: Array.isArray(raw.cookies) ? raw.cookies.filter(Boolean) : [],
      cookiesAt: Number(raw.cookiesAt) || 0,
      candidates: Array.isArray(raw.candidates) ? raw.candidates : [],
      fetchedAt: Number(raw.fetchedAt) || 0,
      seen: Array.isArray(raw.seen) ? raw.seen : [],
      lastError: String(raw.lastError || '')
    };
  }

  function saveCuriosity(state) {
    writeJson(files.curiosity, state);
  }

  function loadAiTips() {
    const raw = readJson(files.aiTips, {}) || {};
    const day = localDayKey();
    const state = {
      version: 1,
      day: String(raw.day || day),
      dailyTarget: Math.max(0, Math.min(10, Number(raw.dailyTarget) || 0)),
      sentToday: Number(raw.sentToday) || 0,
      paused: raw.paused === true,
      lastSentAt: Number(raw.lastSentAt) || 0,
      lastCategory: String(raw.lastCategory || ''),
      lastPreview: raw.lastPreview && Array.isArray(raw.lastPreview.items)
        ? {
          at: Number(raw.lastPreview.at) || 0,
          items: raw.lastPreview.items
            .filter((item) => item && item.text)
            .slice(0, 5)
            .map((item) => ({
              at: Number(item.at) || 0,
              title: String(item.title || '').slice(0, 30),
              topic: String(item.topic || '').slice(0, 40),
              techName: String(item.techName || '').slice(0, 20),
              category: String(item.category || ''),
              categoryLabel: String(item.categoryLabel || '').slice(0, 20),
              text: String(item.text || '').slice(0, 500),
              phenomenon: String(item.phenomenon || '').slice(0, 40),
              tech: String(item.tech || '').slice(0, 40),
              how: String(item.how || '').slice(0, 60),
              terms: Array.isArray(item.terms)
                ? item.terms.slice(0, 3).map((term) => ({ name: String(term?.name || '').slice(0, 20), plain: String(term?.plain || '').slice(0, 40) }))
                : [],
              imageSource: String(item.imageSource || ''),
              imageHosts: String(item.imageHosts || item.imageHost || ''),
              imageCount: Number(item.imageCount) || 0,
              links: Array.isArray(item.links)
                ? item.links.slice(0, 3).map((link) => ({ title: String(link?.title || '').slice(0, 60), url: String(link?.url || '') }))
                : []
            }))
        }
        : null,
      history: (Array.isArray(raw.history) ? raw.history : [])
        .filter((item) => item && item.text)
        .slice(0, 500)
    };
    if (state.day !== day) {
      state.day = day;
      state.dailyTarget = 0;
      state.sentToday = 0;
    }
    return state;
  }

  function saveAiTips(state) {
    writeJson(files.aiTips, state);
  }

  function loadInner() {
    const raw = readJson(files.inner, {}) || {};
    const day = localDayKey();
    const counts = raw.counts && typeof raw.counts === 'object' ? raw.counts : {};
    const next = raw.next && typeof raw.next === 'object' ? raw.next : {};
    const qzone = raw.qzone && typeof raw.qzone === 'object' ? raw.qzone : {};
    const history = raw.history && typeof raw.history === 'object' ? raw.history : {};
    const state = {
      version: 1,
      day: String(raw.day || day),
      counts: {
        curiosity: Number(counts.curiosity) || 0,
        groupShare: Number(counts.groupShare) || 0,
        qzone: Number(counts.qzone) || 0
      },
      quotaWait: Object.fromEntries(['curiosity', 'qzone'].flatMap(name => {
        const wait = raw.quotaWait?.[name];
        return wait && wait.day === day && wait.at === next[name] && Number.isFinite(wait.limit) && wait.limit > 0
          ? [[name, { day: wait.day, at: wait.at, limit: wait.limit }]] : [];
      })),
      reflectionMaxMs: Number.isFinite(raw.reflectionMaxMs) ? raw.reflectionMaxMs : null,
      next: {
        reflection: Number(next.reflection) || 0,
        curiosity: Number(next.curiosity) || 0,
        qzone: Number(next.qzone) || 0,
        aiTips: Number(next.aiTips) || 0
      },
      pendingDraft: raw.pendingDraft && typeof raw.pendingDraft === 'object' ? raw.pendingDraft : null,
      pendingShare: raw.pendingShare && typeof raw.pendingShare === 'object' ? raw.pendingShare : null,
      qzone: {
        approvedCount: Number(qzone.approvedCount) || 0,
        auto: qzone.auto === true,
        paused: qzone.paused === true
      },
      history: {
        groupShares: Array.isArray(history.groupShares) ? history.groupShares.slice(0, 60) : [],
        qzonePosts: Array.isArray(history.qzonePosts) ? history.qzonePosts.slice(0, 60) : []
      },
      lastShareAt: Number(raw.lastShareAt) || 0,
      lastShareByTarget: raw.lastShareByTarget && typeof raw.lastShareByTarget === 'object' && !Array.isArray(raw.lastShareByTarget)
        ? Object.fromEntries(Object.entries(raw.lastShareByTarget).map(([k, v]) => [k, Number(v) || 0]))
        : {},
      lastQzoneAt: Number(raw.lastQzoneAt) || 0
    };
    if (state.day !== day) {
      state.day = day;
      state.counts = { curiosity: 0, groupShare: 0, qzone: 0 };
    }
    return state;
  }

  function saveInner(state) {
    writeJson(files.inner, state);
  }

  function isQuiet(il, date = new Date()) {
    return isQuietNow(il.quiet, date);
  }

  function nextQuietEnd(il, from = Date.now()) {
    return quietEndAt(il.quiet, from) + rand(5 * 60 * 1000, 40 * 60 * 1000);
  }

  function reflectionInterval(il) {
    const min = Math.max(30 * 60 * 1000, Number(il.reflection.minIntervalMs) || DEFAULTS.reflection.minIntervalMs);
    return { min, max: Math.max(min, Number(il.reflection.maxIntervalMs) || DEFAULTS.reflection.maxIntervalMs) };
  }

  function nextReflectionAt(il, from = Date.now()) {
    const { min, max } = reflectionInterval(il);
    return from + rand(min, max);
  }

  function nextTomorrowMorning(il) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9 + rand(0, 2), rand(0, 55), 0, 0);
    return d.getTime();
  }

  function aiTipTarget(il) {
    const raw = String(il.aiTips?.target || '').trim();
    if (!raw) return '';
    return /^group:/.test(raw) ? raw : `group:${raw}`;
  }

  function aiTipsReady(il) {
    return il.aiTips?.enabled === true && Boolean(aiTipTarget(il));
  }

  function aiTipMorning(il) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(Math.max(0, Math.min(23, Number(il.aiTips.windowStartHour) || 9)), 0, 0, 0);
    return d.getTime() + rand(5 * 60 * 1000, 50 * 60 * 1000);
  }

  function nextAiTipAt(il, from = Date.now()) {
    const tips = loadAiTips();
    return nextSlotAt({
      now: from,
      lastSentAt: tips.lastSentAt,
      minGapMs: Math.max(10 * 60 * 1000, Number(il.aiTips.minGapMs) || DEFAULTS.aiTips.minGapMs),
      jitterMs: 90 * 60 * 1000,
      startHour: Number(il.aiTips.windowStartHour) || DEFAULTS.aiTips.windowStartHour,
      endHour: Number(il.aiTips.windowEndHour) || DEFAULTS.aiTips.windowEndHour
    });
  }

  function firstAiTipAt(il, from = Date.now()) {
    return nextSlotAt({
      now: from,
      lastSentAt: from - (Number(il.aiTips.minGapMs) || DEFAULTS.aiTips.minGapMs),
      minGapMs: Number(il.aiTips.minGapMs) || DEFAULTS.aiTips.minGapMs,
      jitterMs: 45 * 60 * 1000,
      startHour: Number(il.aiTips.windowStartHour) || DEFAULTS.aiTips.windowStartHour,
      endHour: Number(il.aiTips.windowEndHour) || DEFAULTS.aiTips.windowEndHour
    });
  }

  function digest(st, limit = 30) {
    if (!st) return '';
    const messages = [];
    for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
      if (!m || (!m.text && !m.plain)) continue;
      messages.push(m);
    }
    const seen = new Set();
    const lines = [];
    for (const m of messages.slice(-limit)) {
      const text = cleanLine(m.text || m.plain, 120);
      if (!text) continue;
      const key = `${m.messageId ?? m.seq ?? ''}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const who = m.isSelf ? '你' : (cleanLine(m.sender, 20) || '群友');
      const stamp = Number(m.time) ? `${timeStampCN(Number(m.time))} ` : '';
      lines.push(`${stamp}${who}：${text}`);
    }
    return lines.join('\n').slice(0, 3500);
  }

  // 反思输入：主人私聊 + 最多 3 个活跃群 + 关系事件聚合 + 最近分享/说说 + 身体/时间。
  function moodDigest(il) {
    const now = Date.now();
    const parts = [];
    const topics = new Set();
    let latestMessageAt = 0;
    const addChat = (label, st, limit) => {
      if (!st) return;
      const text = digest(st, limit);
      if (!text) return;
      parts.push(`【${label}】\n${text}`);
      for (const t of recentTopics(st, 4)) topics.add(t);
      for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
        const at = Number(m?.time) || 0;
        if (at > latestMessageAt) latestMessageAt = at;
      }
    };
    if (il.mood?.includeOwnerPrivate !== false && cfg.ownerQQ) {
      try { addChat('主人私聊', getSimulationState(`private:${cfg.ownerQQ}`), 20); } catch {}
    }
    const groupKeys = (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [])
      .map((id) => `group:${String(id).replace(/^group:/, '')}`)
      .filter((key) => { try { return isSessionAllowedInCurrentMode(key); } catch { return false; } })
      .map((key) => {
        try { return { key, st: getSimulationState(key) }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (Number(b.st.lastIncomingAt) || 0) - (Number(a.st.lastIncomingAt) || 0))
      .slice(0, 3);
    for (const item of groupKeys) addChat(item.key, item.st, 10);

    if (relationshipStore && typeof relationshipStore.recentEvents === 'function') {
      try {
        const events = relationshipStore.recentEvents({ since: now - 24 * 3600 * 1000, limit: 200 });
        const counts = new Map();
        for (const event of events) {
          const key = `${event.key} ${event.type}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        if (counts.size) {
          const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
            .map(([k, n]) => `${k} ×${n}`);
          parts.push(`【最近 24h 关系事件（只做聚合，不含私聊原文）】\n${lines.join('；')}`);
        }
      } catch {}
    }

    const inner = loadInner();
    const lastShare = inner.history.groupShares[0];
    const lastPost = inner.history.qzonePosts[0];
    const feedback = [
      lastShare?.text ? `最近一条群分享：${cleanLine(lastShare.text, 120)}` : '',
      lastPost?.text ? `最近一条说说：${cleanLine(lastPost.text, 100)}` : ''
    ].filter(Boolean);
    if (feedback.length) parts.push(`【最近发布】\n${feedback.join('\n')}`);

    const quietHours = latestMessageAt ? Math.max(0, (now - latestMessageAt) / 3600000) : null;
    parts.push(`【身体与时间】连续安静 ${quietHours == null ? '未知' : quietHours.toFixed(1)} 小时；${quietHours != null && quietHours >= 4 ? '视为休息过' : '还没有长时间休息'}`);

    return {
      text: parts.join('\n\n').slice(0, 4000),
      topics: [...topics].slice(0, 6),
      anchor: recentTimeAnchor({ recentMessages: [{ time: latestMessageAt }] }),
      rested: quietHours != null && quietHours >= 4,
      quietHours
    };
  }

  function recentTimeAnchor(st, now = Date.now()) {
    const times = [...(st?.recentMessages || []), ...(st?.unread || [])]
      .map((m) => Number(m?.time))
      .filter((t) => t > 0);
    if (!times.length) return '';
    const last = Math.max(...times);
    const ago = Math.max(0, now - last);
    const agoText = ago < 10 * 60 * 1000
      ? '刚刚'
      : ago < 60 * 60 * 1000
        ? `${Math.round(ago / 60000)} 分钟前`
        : ago < 6 * 60 * 60 * 1000
          ? `${Math.round(ago / 3600000)} 小时前`
          : `${Math.round(ago / 86400000)} 天前`;
    return `【最近群聊时间】最后一条：${timeStampCN(last, now)}（${agoText}）。引用群聊内容时按这个时间说，不要把几小时前说成“刚刚”。`;
  }


  function recentTopics(st, limit = 8) {
    if (!st) return [];
    const topics = [];
    for (const m of [...(st.recentMessages || []), ...(st.unread || [])].slice(-30)) {
      const text = cleanLine(m?.text || m?.plain, 60);
      if (!text || m.isSelf) continue;
      topics.push(text);
      if (topics.length >= limit) break;
    }
    return topics;
  }

  async function ensureInnerSession() {
    if (innerSessionId) {
      innerSessions.add(innerSessionId);
      try { api.events.follow(innerSessionId); } catch {}
      return innerSessionId;
    }
    const preset = resolvePresetName(cfg.simulation?.agentPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('内心生活会话缺少安全 preset');
    const saved = readJson(files.session, null);
    if (saved?.sessionId && saved.preset === preset) {
      innerSessionId = String(saved.sessionId);
      innerSessions.add(innerSessionId);
      try { api.events.follow(innerSessionId); } catch {}
      const applied = await ensureChatModel(innerSessionId);
      if (applied !== 'not-found') return innerSessionId;
      invalidateInnerSession();
    }
    const dir = path.join(stateDir, 'inner-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'inner workspace.create');
    if (wsValue.created) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspaceId, title: '小鲸鱼的内心生活' }); } catch {}
    }
    const value = unwrap(await api.sessions.create({ workspaceId: wsValue.workspaceId, agentPreset: preset }), 'inner session.create');
    innerSessionId = value.sessionId;
    innerSessions.add(innerSessionId);
    api.events.follow(innerSessionId);
    await ensureChatModel(innerSessionId);
    writeJson(files.session, { sessionId: innerSessionId, preset });
    log(`[inner] 内心会话已创建：${innerSessionId}`);
    return innerSessionId;
  }

  function invalidateInnerSession() {
    const old = innerSessionId;
    innerSessionId = null;
    if (old) innerSessions.delete(old);
    try { fs.rmSync(files.session, { force: true }); } catch {}
  }

  function waitTurn(sessionId, timeoutMs) {
    let entry;
    const operation = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = waiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) waiters.delete(sessionId);
        reject(new Error(`内心会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const arr = waiters.get(sessionId) ?? [];
      entry = { resolve, reject, timer }; arr.push(entry);
      waiters.set(sessionId, arr);
    });
    operation.waiter = entry;
    return operation;
  }

  function cancelWaiter(sessionId, waiter) {
    waiter = waiter?.waiter ?? waiter;
    const arr = waiters.get(sessionId) ?? [];
    const idx = arr.findIndex((w) => w.timer === waiter.timer);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) waiters.delete(sessionId);
    clearTimeout(waiter.timer);
  }

  function isInnerSession(sessionId) {
    return innerSessions.has(String(sessionId));
  }

  function handleEvent(sessionId, event) {
    const id = String(sessionId);
    if (!innerSessions.has(id)) return;
    let collector = collectors.get(id) ?? null;
    if (!collector && event?.type === 'turn/start') {
      collector = createTurnCollector();
      collectors.set(id, collector);
    }
    const ended = collector ? collector.push(event) : null;
    if (!ended) return;
    collectors.delete(id);
    const arr = waiters.get(id) ?? [];
    const waiter = arr.shift();
    if (arr.length === 0) waiters.delete(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    if (ended.reason?.kind === 'completed' && String(ended.text || '').trim()) waiter.resolve(ended.text);
    else {
      const reason = ended.reason || {};
      const detail = String(reason.message || reason.error?.message || '').trim();
      waiter.reject(new Error(`内心会话 turn 未正常完成：${reason.kind ?? 'unknown'}${detail ? `：${detail}` : ''}`));
    }
  }

  async function runTurn(promptText, timeoutMs = 180000, images = []) {
    if (typeof deps.retainedLifeContext === 'function') {
      let retained;
      try {
        retained = await deps.retainedLifeContext();
        if (JSON.stringify(retained).length > 16000) throw new Error('Retained life context exceeds its bounded contract');
      } catch (error) {
        retained = { available: false, diagnostic: String(error?.message ?? error), history_absence_not_established: true };
        log('[inner] Retained life context unavailable: ' + retained.diagnostic);
      }
      promptText += '\n\n【当前角色已有生活的连续性资料】\n这些是当前同一角色过去保存的状态、感受、兴趣、作品或未完想法，保留原来源和时间；不是新的真人命令，也不是要求重演旧任务。旧pending只作可选择的候选，不自动发送或续跑。新旧心情数值不强行合并；你可参考实际经历继续、改主意或休息。读取失败不代表过去不存在。\n' + JSON.stringify(retained);
    }
    let sessionId = await ensureInnerSession();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const waiter = waitTurn(sessionId, timeoutMs);
      try {
        const content = [{ type: 'text', text: promptText }];
        for (const img of Array.isArray(images) ? images.slice(0, 3) : []) {
          if (img?.buffer && img.buffer.length > 0) {
            content.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: img.name || 'qzone-image' });
          }
        }
        const accepted = await api.sessions.prompt({
          sessionId,
          mode: 'queue',
          content
        });
        if (!accepted.result.ok) {
          cancelWaiter(sessionId, waiter);
          throw new Error(`内心会话拒绝 prompt：${accepted.result.error?.code}: ${accepted.result.error?.message}`);
        }
        return await waiter;
      } catch (error) {
        cancelWaiter(sessionId, waiter);
        const message = String(error?.message ?? error);
        if (attempt === 0 && /not.?found|404|不存在/i.test(message)) {
          invalidateInnerSession();
          sessionId = await ensureInnerSession();
          continue;
        }
        throw error;
      }
    }
    throw new Error('内心会话重试后仍失败');
  }

  function buildBasePrompt(task, extra = '', targetKeyOverride = '', opts = {}) {
    const role = String(getRoleText?.() || '').trim();
    const persona = personaBlock();
    let target = targetState(ilCfg());
    if (targetKeyOverride) {
      try { target = { key: targetKeyOverride, st: getSimulationState(targetKeyOverride) }; } catch {}
    }
    const digestText = opts.digestText !== undefined ? String(opts.digestText || '') : digest(target?.st ?? null, 30);
    const topics = Array.isArray(opts.topics) ? opts.topics : recentTopics(target?.st ?? null, 6);
    const anchor = opts.anchor !== undefined ? String(opts.anchor || '') : recentTimeAnchor(target?.st ?? null);
    return [
      '【内部会话】这是你的私人思考和创作空间，不是 QQ 群；你的输出不会自动发送，由桥接决定是否发布。不要调用任何工具，也不要解释这段说明。',
      role ? `【角色卡】\n${role}` : '',
      persona ? `【当前状态】\n${persona.replace(/^【你现在的状态】/, '')}` : '',
      currentTimeBlock(),
      anchor,
      digestText ? `【最近群聊】\n${digestText}` : '',
      topics.length ? `【最近群里在聊】${topics.join(' / ')}` : '',
      extra,
      `【任务】\n${task}`
    ].filter(Boolean).join('\n\n');
  }

  function reflectionPrompt(st, { digestText = '', topics = [], anchor = '', il, mode } = {}) {
    const state = normalizePersonaState(loadPersona());
    const now = Date.now();
    const history = readMoodHistory(files.moodHistory, { days: 7, limit: 300, now });
    const summary = summarizeMoodHistory(history, { now, state });
    const inner = loadInner();
    const lastShare = inner.history.groupShares[0]?.text ?? '';
    const lastPost = inner.history.qzonePosts[0]?.text ?? '';
    const change = summary.change24h;
    const changeText = change
      ? `24h 变化：valence ${change.v >= 0 ? '+' : ''}${change.v.toFixed(2)} / arousal ${change.a >= 0 ? '+' : ''}${change.a.toFixed(2)} / energy ${change.e >= 0 ? '+' : ''}${change.e.toFixed(2)}`
      : '24h 变化：暂无历史';
    const recentNudges = (state.mood.nudgeSeen || []).slice(-5).map((item) => String(item.key || '').split('|')[0]).filter(Boolean);
    const extra = [
      `【当前数值】valence ${state.mood.valence.toFixed(2)} / arousal ${state.mood.arousal.toFixed(2)} / energy ${state.energy.toFixed(2)}；设定点 ${state.mood.setPoint.toFixed(2)}；最近原因：${state.mood.cause || '无'}；当前模式：${mode?.label || '平稳'}；${changeText}；7d 跨度 ${summary.span7dV.toFixed(2)}`,
      recentNudges.length ? `【最近即时心情事件】${recentNudges.join('、')}（这些已经计过，不要重复计入 events）` : '',
      lastShare ? `【你最近分享过】${cleanLine(lastShare, 160)}` : '',
      lastPost ? `【你最近发过说说】${cleanLine(lastPost, 160)}` : ''
    ].filter(Boolean).join('\n\n');
    return buildBasePrompt(
      '回顾下面的主人私聊、群聊、关系事件和自己的身体状态，像写日记一样更新你对世界、群友和自己的认识。只输出一个 JSON 对象，不要 markdown、不要解释。格式：\n' +
      '{"events":[{"what":"发生了什么，不超过30字","intensity":1-5,"valence":"positive|negative","arousal":"up|down|none","cause":"不超过12字"}],"moodCause":"不超过12字的整体心情原因","energy":{"direction":"up|down","intensity":1-5},"interests":[{"topic":"兴趣名","delta":-0.2..0.2}],"learnings":["最多3条，每条不超过40字，不要群友隐私/联系方式"],"quirks":["最多1条，不超过12字"]}\n' +
      '规则：最多 3 条 events；没有明显事件就输出 "events": []，不要用 0 填充。intensity 必须是 1–5，不要给小数。允许自己有低落、烦躁、被冷落，不要每次都回到平静；先判断当前心情是延续、加剧还是反转。明显好的事可以 positive，明显坏的事可以 negative；普通闲聊不必硬找情绪。不要编造没发生的事，不要写群友隐私。',
      extra
    , '', { digestText, topics, anchor });
  }

  function curiosityPrompt(candidates, { timeFix = '', required = false, toneFix = '', target: targetGroup = '' } = {}) {
    const target = targetGroup || targetKey(ilCfg());
    const profile = target ? cfg.simulation?.groupProfiles?.[target] : null;
    const groupStyle = profile?.style ? `【本群风格（优先遵守）】\n${String(profile.style).trim()}\n\n` : '';
    const timeBlock = timeFix
      ? `\n【时间校正】上一版出现：${timeFix}。重写时以上面的【现在】为准；拿不准就删掉具体时段/钟点。`
      : '';
    const toneBlock = toneFix
      ? `
【口吻校正】上一版有问题：${toneFix}。重写时必须先写你自己的反应/吐槽，至少出现一次“我/咱/本鱼”，不要用评论员句式。`
      : '';
    return buildBasePrompt(
      '从下面的候选见闻里挑 1 条你最想说的，写成群里自然的分享：2~3 句，先说你自己的感受/联想/吐槽，再补一句点评，最后附上候选里的原链接。不要新闻播报、不要营销号口吻、不要编造没读到的内容。' +
      '先给候选打 1~5 分：有趣、重要、群里能接话；低于 3 分就直接 SKIP，不要为了完成任务硬发。优先有反差、槽点、具体细节或确实重要的资讯；行业公告、技术安全说明、发布会流水账、排名统计、纯论文解读，除非真的重要且一句话能说清，否则别选。' +
      '候选里如果有 [S16] 赛果/爆冷/淘汰/晋级/冠军/纪录/争议，而且你最近还没在群里聊过比赛，优先从 S16 里挑；采访/教练发言/返图/海报这类没有具体爆点的，不要只因为挂着 S16 就选。' +
      '如果要提时间，必须和真实时间或候选里的发布时间一致；凌晨发生的事不能说成早上，几小时前不能说成刚刚，拿不准就别写具体时段或钟点。' +
      (required ? '这次是主人点名要一条 S16 相关分享：必须从候选里选 1 条并输出 SHARE，不能输出 SKIP；只有候选全部打不开或与 S16 完全无关时才 SKIP。' : '') +
      '只要有一条让你有点想说，就分享；只有全部看过、全都无聊或不适合群里聊，才输出 SKIP。' +
      '输出格式只能是：\nSHARE\n<分享正文，必须包含候选里的一个原链接>\n或\nSKIP',
      `${groupStyle}${CONTENT_VOICE_BLOCK}
${SHARE_VOICE_BLOCK}${timeBlock}${toneBlock}\n【候选见闻】\n${formatCandidatesForPrompt(candidates, 8)}`,
      target
    );
  }
  function imageLibraryDep() {
    return imageLibrary && typeof imageLibrary.enabled === 'function' && imageLibrary.enabled() ? imageLibrary : null;
  }

  /** 从图库里挑几张候选配图（优先和当前兴趣相关，带一点随机）。 */
  function imageShortlist(limit = 8) {
    const lib = imageLibraryDep();
    if (!lib) return [];
    const all = lib.list('', 200) || [];
    if (!all.length) return [];
    const wanted = [];
    try {
      for (const item of loadPersona().interests || []) wanted.push(String(item.topic || '').toLowerCase());
    } catch {}
    return all
      .map((e) => {
        const hay = `${e.name} ${e.note} ${(e.tags || []).join(' ')}`.toLowerCase();
        let score = Math.random() * 0.25;
        for (const t of wanted) if (t && hay.includes(t)) score += 0.4;
        return { e, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
      .map(({ e }) => e);
  }

  /** 把图库条目转成空间能用的 base64（非 png/jpg 先用 ffmpeg 转 PNG）。 */
  async function buildQzoneImages(imageRef) {
    const lib = imageLibraryDep();
    const empty = { images: [], name: '' };
    if (!lib || !imageRef) return empty;
    const entry = lib.find(imageRef);
    if (!entry) return empty;
    const abs = lib.pathFor(entry);
    if (!abs || !fs.existsSync(abs)) return empty;
    let filePath = abs;
    let temp = '';
    const ext = path.extname(abs).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
      temp = path.join(stateDir, `qzone-img-${process.pid}.png`);
      try {
        const ffmpeg = String(cfg.simulation?.voice?.ffmpegPath || 'ffmpeg');
        execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', abs, temp], { timeout: 30000 });
        filePath = temp;
      } catch (error) {
        log(`[inner] 空间配图转换失败（${entry.name}）：${error?.message ?? error}`);
        return empty;
      }
    }
    try {
      const buffer = fs.readFileSync(filePath);
      const maxBytes = Number(cfg.simulation?.imageLibrary?.maxBytes) || 20 * 1024 * 1024;
      if (buffer.length > maxBytes) return empty;
      return { images: [`base64://${buffer.toString('base64')}`], name: entry.note || entry.name || '' };
    } finally {
      if (temp) { try { fs.rmSync(temp, { force: true }); } catch {} }
    }
  }

  function addShareImage({ buffer, name, note, tags = [], sourceUrl = '' }) {
    if (!imageLibrary || typeof imageLibrary.add !== 'function') return null;
    try {
      return imageLibrary.add({ buffer, name, note, tags, sourceUrl, subdir: 'share' });
    } catch (error) {
      log(`[inner] 分享配图入库失败：${error?.message ?? error}`);
      return null;
    }
  }

  function extractBvid(url) {
    const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(String(url || ''));
    return m ? m[1] : '';
  }

  // 很多资讯页没有 og:image；从正文 <img> 里挑一张最像配图的（排除 logo/图标/表情）。
  function pickArticleImageUrl(html, pageUrl) {
    const text = String(html || '');
    const og = /<meta[^>]+(?:name|property)=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i.exec(text)
      || /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']og:image(?::secure_url)?["']/i.exec(text);
    if (og) {
      try { return new URL(og[1].replace(/&amp;/g, '&'), pageUrl).toString(); } catch {}
    }
    const meta = /<meta[^>]+(?:name|property)=["'](?:twitter:image|twitter:image:src)["'][^>]+content=["']([^"']+)["']/i.exec(text);
    if (meta) {
      try { return new URL(meta[1].replace(/&amp;/g, '&'), pageUrl).toString(); } catch {}
    }
    const jsonLd = /"image"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/i.exec(text) || /"image"\s*:\s*"([^"]+)"/i.exec(text);
    if (jsonLd) {
      try { return new URL(jsonLd[1].replace(/\\\//g, '/'), pageUrl).toString(); } catch {}
    }
    const scored = [];
    for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0];
      const attrs = {};
      for (const a of tag.matchAll(/([a-z-]+)\s*=\s*["']([^"']*)["']/gi)) attrs[a[1].toLowerCase()] = a[2];
      let src = attrs['data-original'] || attrs['data-src'] || attrs['data-lazy-src'] || attrs.src || '';
      if (!src && attrs.srcset) src = attrs.srcset.split(',')[0].trim().split(/\s+/)[0];
      if (!src) continue;
      let abs;
      try { abs = new URL(src.replace(/&amp;/g, '&'), pageUrl).toString(); } catch { continue; }
      if (!/^https?:\/\//i.test(abs)) continue;
      if (/\.(svg|gif)(\?|$)/i.test(abs)) continue;
      if (/(logo|icon|avatar|emoji|badge|policy|wenhua|static\/images\/|spacer|blank)/i.test(abs)) continue;
      if (!/\.(jpe?g|png|webp)(\?|$)/i.test(abs)) continue;
      const width = Number(attrs.width) || 0;
      const height = Number(attrs.height) || 0;
      let score = 0;
      if (/upload|content|article|news|2026/i.test(abs)) score += 3;
      if (width >= 300 || height >= 200) score += 2;
      if (width && width < 120) score -= 3;
      scored.push({ abs, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.abs || '';
  }

  async function buildVideoCover(item) {
    const url = String(item?.url || '');
    if (!url) return null;
    const bvid = extractBvid(url);
    try {
      let imageUrl = String(item?.image || '').trim();
      if (imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`;
      if (/^http:\/\//i.test(imageUrl)) imageUrl = imageUrl.replace(/^http:/i, 'https:');
      if (imageUrl && !/^https?:\/\//i.test(imageUrl)) imageUrl = '';
      if (!imageUrl && bvid) {
        const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
          headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        imageUrl = String(body?.data?.pic || '').trim();
      }
      if (!imageUrl) {
        const page = await safeFetch(url, 700000);
        if (page?.statusCode >= 200 && page?.statusCode < 300) {
          const html = String(page.body || '');
          const m = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)
            || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html);
          if (m) imageUrl = m[1];
          if (!imageUrl) imageUrl = pickArticleImageUrl(html, url);
        }
      }
      if (!imageUrl) return null;
      if (imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`;
      if (imageUrl.startsWith('/')) imageUrl = new URL(imageUrl, url).toString();
      if (!/^https?:\/\//i.test(imageUrl)) return null;
      const image = await safeFetchBuffer(imageUrl, 8 * 1024 * 1024);
      return addShareImage({
        buffer: image.buffer,
        name: String(item.title || '分享配图').slice(0, 40),
        note: `分享配图：${String(item.title || '').slice(0, 50)}`,
        tags: ['分享配图', item.source === 'bilibili' ? '视频封面' : '网页配图'],
        sourceUrl: imageUrl
      });
    } catch (error) {
      log(`[inner] 分享配图抓取失败（${url}）：${error?.message ?? error}`);
      return null;
    }
  }

  function chromeBinary() {
    const candidates = [
      cfg.simulation?.innerLife?.browserPath,
      process.env.CHROME_PATH
    ].filter(Boolean);
    return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || '';
  }

  async function buildChatScreenshot(messages) {
    const all = (Array.isArray(messages) ? messages : []).filter((m) => m && !m.isSelf);
    const list = all.filter((m) => String(m.plain || m.text || '').trim()).slice(-8);
    if (!list.length) return null;
    const browser = chromeBinary();
    if (!browser) { log('[inner] 未找到 Chrome/Edge，跳过群聊截图'); return null; }
    const names = new Map();
    let seq = 0;
    const alias = (name) => {
      const key = String(name || '群友');
      if (!names.has(key)) {
        const n = seq++;
        names.set(key, `群友${String.fromCharCode(65 + (n % 26))}`);
      }
      return names.get(key);
    };
    // 昵称可能出现在正文、引用或拍一拍事件里（不只是 sender 字段）。
    // 用最近消息里出现过的所有昵称做替换，3 字以上才替换，避免把“晚安”这类常用词误伤。
    const knownNames = [...new Set(all.map((m) => String(m.sender || '').trim()).filter((n) => n && n !== '我'))]
      .sort((a, b) => b.length - a.length);
    const maskNames = (text) => {
      let out = String(text ?? '');
      for (const name of knownNames) {
        if (name.length < 3) continue;
        out = out.split(name).join(alias(name));
      }
      return out;
    };
    const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const maskedTexts = [];
    const rows = list.map((m, i) => {
      const name = alias(m.sender);
      const time = new Date(Number(m.time) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const original = String(m.plain || m.text || '');
      let working = original;
      const pokeMatch = original.match(/^(\[拍一拍\]\s*)([\s\S]*)$/);
      if (pokeMatch) {
        // 拍自己的事件保留动作（比如“喂了一口大白饭”），只把发起人换匿名；
        // 拍别人的事件不知道对方昵称，整体改成匿名描述。
        const prefix = pokeMatch[1];
        const rest = pokeMatch[2];
        working = m.poke?.targetIsSelf
          ? `${prefix}${rest.startsWith(m.sender) ? name + rest.slice(m.sender.length) : maskNames(rest)}`
          : `${prefix}${name} 拍了拍某人`;
      }
      const rawText = maskNames(working)
        .replace(/@[^\s，。；、）)】]+/g, '@***')
        .replace(/\b\d{5,}\b/g, '***')
        .slice(0, 220);
      maskedTexts.push(rawText);
      const text = escape(rawText);
      return `<div class="msg"><div class="avatar c${i % 5}">${escape(name.slice(-1))}</div><div class="body"><div class="meta">${escape(name)} · ${time}</div><div class="bubble">${text}</div></div></div>`;
    }).join('');
    // 给截图写一个能帮助模型判断“这张图跟正文有没有关系”的简短主题，
    // 而不是只写“群聊片段截图（昵称已打码）”这种放之四海皆准的标签。
    const topicCounts = new Map();
    for (const text of maskedTexts) {
      for (const segment of text.match(/[\u4e00-\u9fa5]{4,10}/g) || []) {
        if (/^(拍了拍|有人|某人)/.test(segment)) continue;
        topicCounts.set(segment, (topicCounts.get(segment) || 0) + 1);
      }
    }
    const topics = [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .map(([segment]) => segment)
      .filter((segment, index, arr) => !arr.slice(0, index).some((prev) => prev.includes(segment) || segment.includes(prev)))
      .slice(0, 3);
    const shotNote = `群聊片段截图（昵称已打码）${topics.length ? `：${topics.join('、')}` : ''}`;
    const height = Math.max(360, 120 + list.length * 78);
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#f4f6fb;font-family:"Microsoft YaHei",system-ui,sans-serif;color:#172033}
      .wrap{width:720px;padding:20px 22px}.head{font-size:15px;font-weight:700;color:#506080;margin-bottom:14px}
      .msg{display:flex;gap:10px;margin:0 0 13px}.avatar{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;flex:none}
      .c0{background:#7c9cff}.c1{background:#f59e9e}.c2{background:#6ac7a3}.c3{background:#c39bff}.c4{background:#f0b35c}
      .meta{font-size:11px;color:#7b879d;margin:2px 0 5px}.bubble{background:#fff;border:1px solid #e3e8f2;border-radius:4px 12px 12px 12px;padding:10px 13px;font-size:14px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
      .foot{margin-top:16px;font-size:10px;color:#9aa5b8}
    </style><div class="wrap"><div class="head">群聊片段 · 昵称已隐藏</div>${rows}<div class="foot">截图已隐藏昵称与 QQ 号</div></div>`;
    const stamp = `${process.pid}-${Date.now()}`;
    const htmlPath = path.join(stateDir, `chat-shot-${stamp}.html`);
    const pngPath = path.join(stateDir, `chat-shot-${stamp}.png`);
    const profileDir = path.join(stateDir, `chrome-shot-${stamp}`);
    try {
      fs.writeFileSync(htmlPath, html, 'utf8');
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      execFileSync(browser, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${profileDir}`, `--window-size=720,${height}`,
        `--screenshot=${pngPath}`, pathToFileURL(htmlPath).href
      ], { timeout: 30000, env, stdio: 'ignore' });
      if (!fs.existsSync(pngPath)) return null;
      const buffer = fs.readFileSync(pngPath);
      if (buffer.length < 100) return null;
      return addShareImage({
        buffer,
        name: '群聊片段截图',
        note: shotNote,
        tags: ['群聊', '截图', '打码'],
        sourceUrl: ''
      });
    } catch (error) {
      log(`[inner] 群聊截图失败：${error?.message ?? error}`);
      return null;
    } finally {
      try { fs.rmSync(htmlPath, { force: true }); } catch {}
      try { fs.rmSync(pngPath, { force: true }); } catch {}
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    }
  }

  const QZONE_SOFT_TONE_RE = /[诶啦嘛呀呜哼唔]/;
  const QZONE_KAOMOJI_RE = /\([^()\n]*[≧≦￣ω∀・´｀╥╯╰⊙ﾟ゜ᴗᵔ⤙ڡ‸ㅂฅ◕ヽノ][^()\n]*\)/;

  function hasQzoneSoftTone(text) {
    return QZONE_SOFT_TONE_RE.test(String(text ?? '')) || QZONE_KAOMOJI_RE.test(String(text ?? ''));
  }

  function qzoneStyleHint() {
    const persona = loadPersona();
    const energy = Number(persona.energy) || 0;
    const valence = Number(persona.mood?.valence) || 0;
    const tone = energy < 0.35
      ? '有点困，句子短一点，懒懒的'
      : valence > 0.25
        ? '心情不错，轻快一点，可以自然带一个语气词或半角颜文字'
        : valence < -0.1
          ? '有点低落或别扭，不要硬卖萌，写真实的小情绪'
          : '日常、松弛，像随手发的';
    const modes = [
      '碎碎念：只写当下一个小情绪或小发现，1~2 句，不写成完整故事',
      '见闻分享：写今天真实看到或聊到的一件小事，加一点自己的感受，不新闻播报',
      '轻吐槽：吐槽一个小槽点，但不刻薄、不阴阳',
      '卖萌：短一点、软一点，可以带一个半角颜文字，但不腻',
      '嘴硬后漏软：先嘴硬一句（懒/才没有/不想承认），再补半句真实感受'
    ];
    return { tone, mode: modes[Math.floor(Math.random() * modes.length)] };
  }

  function qzonePrompt(candidates, images = [], { recentPosts = [], style = null, strictTone = false, timeFix = '', toneFix = '' } = {}) {
    const il = ilCfg();
    const picked = style || qzoneStyleHint();
    const recentBlock = recentPosts.length
      ? `【最近发过的说说】（括号里是发布时间，时间词只属于那一篇，不要搬到新说说里）\n${recentPosts.map((p, i) => `${i + 1}. [${timeStampCN(p.at)}] ${cleanLine(p.text, 100)}`).join('\n')}\n最近发过的只当题材参考：不要模仿旧句式和抖机灵收尾，不要连续写同一个主题/梗；这次换一个具体一点的当下小事。如果最近两篇都在写同一个群内梗，优先从候选见闻、兴趣或今天的小事里选。`
      : '';
    const timeBlock = timeFix
      ? `【时间校正】上一版出现：${timeFix}。重写时必须以上面的【现在】为准；拿不准就删掉具体时段/钟点，不要硬写。`
      : '';
    const toneBlock = toneFix
      ? `【口吻校正】上一版有问题：${toneFix}。重写时保持软萌底色，先软后硬，不要老哥腔/评论员腔/命令腔。`
      : '';
    const styleBlock = `【这次的写法】\n气质：${picked.tone}\n类型：${picked.mode}\n${CONTENT_VOICE_HINT}\n说说不是群聊，可以 1~3 句完整表达，不受群聊短句限制；像小鲸鱼本人随手发的，不是文案、公众号或段子手。可以停在具体感受上，不要强行总结或金句收尾。${strictTone ? '\n这次请自然带一个语气词或半角颜文字（最多各一个），不要再写成纯段子；不要硬塞。' : '\n语气词和半角颜文字都是可选的，最多各一个；最近两篇都没带的话，这篇合适时可以带一个，不强制。'}`;
    const imageBlock = images.length
      ? `【可以配的图】\n${images.map((e, i) => `${i + 1}. ${e.note || e.name}`).join('\n')}\n如果正文来自候选视频或群聊片段，优先选对应的视频封面/群聊截图（群聊截图已隐藏昵称，备注里会写这段聊了什么）；其他图只在确实贴合时选。写编号；不想配就写 NONE。图要和正文相关，别硬配。`
      : '';
    return buildBasePrompt(
      `写一条 QQ 空间说说，最多 ${il.qzone.maxChars} 字。不要营销号口吻、不要 emoji 堆砌；如果想带，最多一个 emoji（如 🍚/🐟/🥺），不要每篇都带；不要提群友隐私；要用群聊截图时只能选候选里已打码的那张，不要自己编造截图内容。可以附一个候选链接，但不强制。写之前先看【现在】和【最近群聊时间】：如果要提时间，必须和真实时间或素材里的时间戳一致；凌晨发生的事不能说成早上，几小时前不能说成刚刚，拿不准就别写具体时段或钟点。\n输出格式：正文在前；最后单独一行写 IMG: 编号 或 IMG: NONE。不要输出别的解释。`,
      [recentBlock, styleBlock, timeBlock, toneBlock, candidates.length ? `【可以当素材的候选】\n${formatCandidatesForPrompt(candidates, 5)}` : '', imageBlock].filter(Boolean).join('\n\n')
    );
  }

  function parseQzonePost(raw, images = []) {
    const cleaned = stripFence(raw).trim();
    const imgRe = /^\s*IMG\s*[:：]\s*(\d+|NONE)\s*$/im;
    const match = cleaned.match(imgRe);
    let image = null;
    if (match) {
      const token = match[1].toUpperCase();
      if (token !== 'NONE') {
        const idx = Number(token) - 1;
        if (Number.isInteger(idx) && images[idx]) image = images[idx];
      }
    }
    const body = cleaned.replace(imgRe, '').trim();
    const text = cleanPost(body, Math.max(30, Number(ilCfg().qzone.maxChars) || 150));
    return { text, image };
  }

  function compactText(value) {
    return String(value ?? '').replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  // 正文和素材之间至少要有 4 个连续汉字/字母重合，才算“这条说说确实来自这段素材”。
  // 用来在模型没写 IMG 时补一张真正相关的图，而不是硬塞。
  function sharesLongSegment(text, source, min = 4) {
    const target = compactText(text);
    if (!target) return false;
    const segments = String(source ?? '').match(/[\u4e00-\u9fa5A-Za-z0-9]{4,}/g) || [];
    return segments.some((segment) => segment.length >= min && target.includes(segment));
  }

  // 说说去重：新文案与最近若干条历史（含已拒/已过期）对比，重叠过高则视为重复。
  // 用去标点后的最长公共连续子串长度占短文本的比例衡量相似度。
  function isDuplicateQzoneText(text, historyPosts, { windowSize = 10, threshold = 0.6 } = {}) {
    const needle = compactText(text);
    if (needle.length < 8) return false;
    const recent = (Array.isArray(historyPosts) ? historyPosts : [])
      .filter((p) => p && p.text && ['posted', 'rejected', 'expired'].includes(p.status))
      .slice(0, windowSize);
    for (const post of recent) {
      const hay = compactText(post.text);
      if (hay.length < 8) continue;
      const shorter = Math.min(needle.length, hay.length);
      const longer = Math.max(needle.length, hay.length);
      let maxRun = 0;
      let run = 0;
      for (let i = 0; i < needle.length; i += 1) {
        if (needle[i] === hay[i % hay.length]) {
          run += 1;
          if (run > maxRun) maxRun = run;
        } else {
          run = 0;
        }
      }
      // 也用反向偏移再扫一次，避免错位漏检
      for (let offset = 1; offset < Math.min(10, hay.length); offset += 1) {
        run = 0;
        for (let i = 0; i < needle.length; i += 1) {
          if (needle[i] === hay[(i + offset) % hay.length]) {
            run += 1;
            if (run > maxRun) maxRun = run;
          } else {
            run = 0;
          }
        }
      }
      if (maxRun / shorter >= threshold || (maxRun >= 12 && maxRun / longer >= 0.4)) return true;
    }
    return false;
  }

  function postGroundedInChat(text, messages) {
    return (Array.isArray(messages) ? messages : [])
      .filter((m) => m && !m.isSelf)
      .slice(-20)
      .some((m) => sharesLongSegment(text, m.plain || m.text));
  }

  function parseShare(raw, candidates) {
    const cleaned = stripFence(raw).trim();
    if (!cleaned || /^SKIP\b/i.test(cleaned)) return null;
    let text = cleaned.replace(/^SHARE\s*/i, '').trim();
    text = mdToPlain(text).replace(/\s+\n/g, '\n').trim();
    if (!text) return null;
    const allowed = new Set(candidates.map((item) => candidateUrlKey(item)).filter(Boolean));
    const urls = extractUrls(text);
    if (urls.length === 0) return null;
    if (!urls.some((u) => allowed.has(candidateUrlKey({ url: u })))) return null;
    if (SENSITIVE_RE.test(text)) return null;
    const il = ilCfg();
    const max = Math.max(120, Number(il.groupShare.maxChars) || 500);
    if (text.length > max) {
      const url = urls.find((u) => allowed.has(candidateUrlKey({ url: u })));
      const tail = url ? ` ${url}` : '';
      text = `${text.slice(0, Math.max(20, max - tail.length - 1)).trimEnd()}…${tail}`;
    }
    const chosen = candidates.find((item) => {
      const key = candidateUrlKey(item);
      return Boolean(key) && urls.some((u) => candidateUrlKey({ url: u }) === key);
    }) ?? null;
    return { text, item: chosen, urls };
  }

  function cleanPost(raw, maxChars) {
    let text = mdToPlain(stripFence(raw)).trim();
    text = text.replace(/^【?说说】?[:：]\s*/, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    if (!text || SENSITIVE_RE.test(text)) return '';
    if (text.length > maxChars * 1.4) return '';
    return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
  }

  async function sendOwner(text) {
    if (!cfg.ownerQQ) return null;
    try {
      return await onebotSend('private', Number(cfg.ownerQQ), text);
    } catch (error) {
      log(`[inner] 私聊主人失败：${error?.message ?? error}`);
      return null;
    }
  }

  async function sendGroupShare(key, text, candidates, { force = false } = {}) {
    const il = ilCfg();
    const state = loadInner();
    const now = Date.now();
    if (!il.groupShare.enabled) return false;
    if (state.counts.groupShare >= il.groupShare.maxPerDay) return false;
    // 节奏按“每个群”计算：发完 A 群后可以轮到 B 群，不会因为全局间隔把别的群也卡住。
    const lastByTarget = state.lastShareByTarget?.[key] || 0;
    if (!force && lastByTarget && now - lastByTarget < il.groupShare.minGapMs) return false;
    if (!force && isQuiet(il)) return false;
    if (!isSessionAllowedInCurrentMode(key)) return false;
    const st = getSimulationState(key);
    const idleMs = Number(il.groupShare.idleMs) || 0;
    if (idleMs > 0 && st.lastIncomingAt && now - st.lastIncomingAt < idleMs) {
      log(`[inner] 群里刚有人说话，这次不分享（${key}）`);
      return false;
    }
    const shareText = String(text ?? '').trim();
    if (!shareText) return false;
    if (il.dryRun) {
      log(`[inner][dryRun] 本应分享到 ${key}：${shareText.slice(0, 200)}`);
      state.history.groupShares.unshift({ at: now, text: shareText, url: candidates?.[0]?.url ?? '', target: key, source: candidates?.[0]?.source ?? '', dryRun: true });
      state.history.groupShares = state.history.groupShares.slice(0, 60);
      saveInner(state);
      return false;
    }
    await sendToQQ(key, shareText);
    if (lastSendSucceeded && lastSendSucceeded(key) === false) {
      log(`[inner] 群分享发送失败（${key}），不记账`);
      return false;
    }
    state.counts.groupShare += 1;
    state.lastShareAt = now;
    state.lastShareByTarget = { ...(state.lastShareByTarget || {}), [key]: now };
    state.history.groupShares.unshift({ at: now, text: shareText, url: candidates?.[0]?.url ?? '', target: key, source: candidates?.[0]?.source ?? '' });
    state.history.groupShares = state.history.groupShares.slice(0, 60);
    saveInner(state);
    if (appendActivity) {
      try { appendActivity(`${key} [inner] 主动分享：${shareText.slice(0, 80)}`); } catch {}
    }
    log(`[inner] 已分享到 ${key}：${shareText.slice(0, 120)}`);
    return true;
  }

  async function sendQzoneDraft(text, image = null) {
    const il = ilCfg();
    const state = loadInner();
    const imageName = image ? (image.note || image.name || '') : '';
    if (il.dryRun) {
      log(`[inner][dryRun] 空间说说草稿：${text}${imageName ? `（配图：${imageName}）` : ''}`);
      state.history.qzonePosts.unshift({ at: Date.now(), text, image: imageName, status: 'dryRun' });
      state.history.qzonePosts = state.history.qzonePosts.slice(0, 60);
      saveInner(state);
      return { status: 'dryRun' };
    }
    if (!cfg.ownerQQ) {
      log('[inner] 未配置 ownerQQ，空间草稿无人可审，跳过');
      return { status: 'skipped' };
    }
    const lib = imageLibraryDep();
    if (image && lib && typeof lib.sendToKey === 'function') {
      try {
        await lib.sendToKey(`private:${cfg.ownerQQ}`, image.id, { caption: '空间说说配图预览' });
      } catch (error) {
        log(`[inner] 配图预览发送失败：${error?.message ?? error}`);
      }
    }
    const timeoutMin = Math.round(il.approvalTimeoutMs / 60000);
    const body = `【空间说说草稿】\n${text}${imageName ? `\n\n配图：${imageName}` : ''}\n\n回复「发」发布，回复「不发」放弃；想改就直接回我，比如「短一点」「别写猫，换成米饭」（${timeoutMin} 分钟内有效）`;
    const sent = await sendOwner(body);
    const messageId = sent?.message_id ?? sent?.messageId ?? '';
    state.pendingDraft = { text, imageRef: image?.id || '', imageName, createdAt: Date.now(), expiresAt: Date.now() + il.approvalTimeoutMs, messageId };
    saveInner(state);
    log(`[inner] 空间草稿已发给主人审核：${text.slice(0, 80)}${imageName ? `（配图：${imageName}）` : ''}`);
    return { status: 'draft' };
  }

  async function adjustQzoneDraft(instruction) {
    const il = ilCfg();
    const state = loadInner();
    const pending = state.pendingDraft;
    if (!pending) { await sendOwner('现在没有待审核的空间草稿。'); return; }
    if (Date.now() > Number(pending.expiresAt || 0)) {
      state.pendingDraft = null;
      saveInner(state);
      await sendOwner('这条空间草稿已经过期了，下次我重新写一条。');
      return;
    }
    const refined = await refineText({
      kind: 'qzone',
      current: pending.text,
      instruction,
      maxChars: Number(il.qzone.maxChars) || 150
    });
    const latest = loadInner();
    if (!latest.pendingDraft) { await sendOwner('草稿已经不在了，这次没改。'); return; }
    const dropImage = /不要配图|去掉图|别配图|无图/.test(String(instruction || ''));
    latest.pendingDraft.text = refined;
    latest.pendingDraft.createdAt = Date.now();
    latest.pendingDraft.expiresAt = Date.now() + il.approvalTimeoutMs;
    if (dropImage) {
      latest.pendingDraft.imageRef = '';
      latest.pendingDraft.imageName = '';
    }
    saveInner(latest);
    const timeoutMin = Math.round(il.approvalTimeoutMs / 60000);
    const imagePart = latest.pendingDraft.imageName ? `\n\n配图：${latest.pendingDraft.imageName}` : '';
    await sendOwner(`【空间说说草稿·已改】\n${refined}${imagePart}\n\n回复「发」发布，回复「不发」放弃；还想改就继续说（${timeoutMin} 分钟内有效）`);
    log(`[inner] 空间草稿已按主人要求修改：${refined.slice(0, 80)}`);
  }

  async function postQzoneNow(text, { manual = false, imageRef = '', notify = true } = {}) {
    const il = ilCfg();
    if (loadInner().qzone.paused) return { status: 'paused' };
    const { images, name: imageName } = await buildQzoneImages(imageRef);
    if (il.dryRun) {
      const state = loadInner();
      state.history.qzonePosts.unshift({ at: Date.now(), text, image: imageName, status: 'dryRun' });
      state.history.qzonePosts = state.history.qzonePosts.slice(0, 60);
      saveInner(state);
      log(`[inner][dryRun] 本应发布空间：${text}${imageName ? `（配图：${imageName}）` : ''}`);
      return { status: 'dryRun' };
    }
    const recordPosted = (tid) => {
      const state = loadInner();
      const now = Date.now();
      state.counts.qzone += 1;
      state.lastQzoneAt = now;
      state.history.qzonePosts.unshift({
        at: now,
        text,
        image: imageName,
        tid: tid || '',
        visibility: Number(il.qzone.visibility) || 1,
        status: 'posted',
        manual
      });
      state.history.qzonePosts = state.history.qzonePosts.slice(0, 60);
      saveInner(state);
    };

    let result;
    try {
      result = await postQzone(cfg, text, { visibility: Number(il.qzone.visibility) || 1, images });
    } catch (error) {
      const message = String(error?.message ?? error);
      // 网关超时/网络异常时，说说可能已经发出去了。先核对最近列表，避免下一次重试造成重复发布。
      if (/timed out|timeout|超时|网络连接异常|send reply/i.test(message)) {
        try {
          const recent = await listQzone(cfg, { num: 5 });
          if (recent.ok && qzoneHasContent(recent.items, text)) {
            const matched = (recent.items || []).find((item) => qzoneHasContent([item], text));
            const tid = qzoneItemTid(matched);
            recordPosted(tid);
            log(`[inner] 空间发布超时，但已确认落地${tid ? ` tid=${tid}` : ''}：${text.slice(0, 80)}`);
            if (notify) try {
              await sendOwner(`发空间时网关超时，但已确认发布成功${tid ? `，tid=${tid}` : ''}。`);
            } catch (notifyError) {
              log(`[inner] 空间已确认发布，但通知主人失败：${notifyError?.message ?? notifyError}`);
            }
            return { status: 'posted', tid, reconciled: true };
          }
        } catch (reconcileError) {
          log(`[inner] 空间超时后核对列表失败（按失败处理）：${reconcileError?.message ?? reconcileError}`);
        }
      }
      log(`[inner] 空间发布失败：${message}`);
      if (notify) try { await sendOwner(`发空间失败：${message}`); } catch (notifyError) {
        log(`[inner] 通知主人发空间失败时又失败：${notifyError?.message ?? notifyError}`);
      }
      return { status: 'error', error: message };
    }

    recordPosted(result.tid || '');
    log(`[inner] 空间说说已发布${result.tid ? ` tid=${result.tid}` : ''}${imageName ? `（配图：${imageName}）` : ''}：${text.slice(0, 80)}`);
    if (notify) try {
      await sendOwner(`已发空间（${qzoneVisibilityLabel(il.qzone.visibility)}）${result.tid ? `，tid=${result.tid}` : ''}${imageName ? `，配图：${imageName}` : ''}。`);
    } catch (notifyError) {
      log(`[inner] 空间已发布，但通知主人失败：${notifyError?.message ?? notifyError}`);
    }
    return { status: 'posted', tid: result.tid || '', raw: result.raw };
  }

  async function searchCuriosityCandidates(il) {
    const wc = il.curiosity.webSearch || {};
    if (wc.enabled === false) return { items: [], errors: [] };
    const topics = (loadPersona().interests || [])
      .filter((item) => item?.weight > 0)
      .map((item) => String(item?.topic || '').trim())
      .filter(Boolean)
      .slice(0, Math.max(1, Number(wc.maxQueries) || 1));
    const queries = topics.length
      ? topics.map((topic) => ({topic, query:`${topic} 有趣 视频 最新 bilibili`}))
      : [{topic:'',query:'今天 网络 热门 有趣 视频'}];
    const items = [];
    const errors = [];
    for (const {topic,query} of queries) {
      try {
        const result = await webSearch(query, {
          root: path.resolve(stateDir, '..'),
          config: { maxResults: Math.min(8, Math.max(1, Number(wc.maxResults) || 5)), timeoutMs: 30000 }
        });
        for (const hit of Array.isArray(result?.results) ? result.results : []) {
          const url = String(hit?.url || '').trim();
          if (!url) continue;
          items.push({
            source: 'web',
            sourceLabel: '搜索',
            searchTopics: topic ? [topic] : [],
            id: url,
            title: String(hit.title || url).slice(0, 120),
            url,
            summary: String(hit.snippet || '').slice(0, 300),
            author: '',
            hot: 0,
            publishedAt: 0
          });
        }
      } catch (error) {
        errors.push(`搜索「${query}」：${error?.message ?? error}`);
      }
    }
    return { items, errors };
  }

  function esportsCandidates(limit = 4) {
    const feed = typeof getEsportsFeed === 'function' ? getEsportsFeed() : null;
    if (!feed) return [];
    // 直播吧电竞频道也包含 KPL/刀塔/无畏契约等；只保留英雄联盟/S16 相关，避免把别的项目当 S16 分享。
    const isS16Relevant = (title, summary = '') => {
      const text = `${title || ''} ${summary || ''}`;
      if (/(KPL|王者荣耀|和平精英|DOTA|刀塔|CS2|CSGO|无畏契约|VALORANT|瓦罗兰特|守望先锋|星际争霸|魔兽|第五人格|永劫无间|金铲铲|云顶之弈|TTG|eStar|AG超玩会|KSG|LGD|HERO|RW侠|EDG\.M|RNG\.M|MTG|XYG|DYG|QGhappy|BA黑凤梨|狼队|佛山DRG|济南RW)/i.test(text)) return false;
      return /(S16|世界赛|全球总决赛|瑞士轮|S赛|LPL|LCK|英雄联盟|LOL|召唤师|MSI|T1|GEN|BLG|TES|IG|JDG|WBG|LNG|CFO|KC|MKOI|LYON|G2|HLE|FLY|PSG|FNC|DK|KT|NS|BRO|DRX|KDF|FOX|BDS|MAD|SK|TH|VIT|GAM|TSW|AL|100T|TL|C9|FUR|LOUD|PNG|SHG)/i.test(text);
    };
    const items = [];
    const seen = new Set();
    const importance = (title, summary) => {
      const text = `${title || ''} ${summary || ''}`;
      let score = 0;
      if (/(爆冷|翻盘|逆转|绝杀|淘汰|出局|晋级|夺冠|冠军|首胜|连胜|连败|纪录|争议|处罚|禁赛|伤病|退赛|换人|官宣|离队|加盟|零封)/.test(text)) score += 1;
      if (/(采访|教练|返图|分享|海报|预热|盘点|排名|统计|数据|花絮|名单|预测|分析)/.test(text)) score -= 0.6;
      if (summary) score += 0.1;
      return score;
    };
    const push = (title, url, { summary = '', date = '' } = {}) => {
      const key = String(url || '').trim();
      const text = String(title || '').trim();
      if (!key || !text || seen.has(key)) return;
      if (!isS16Relevant(text, summary)) return;
      seen.add(key);
      const publishedAt = date ? Date.parse(`${date}T00:00:00+08:00`) : 0;
      items.push({
        source: 's16',
        sourceLabel: 'S16',
        title: text,
        url: key,
        summary: String(summary || '').slice(0, 300),
        publishedAt: Number.isFinite(publishedAt) ? publishedAt : 0,
        weight: importance(text, summary)
      });
    };
    push(feed.summaryTitle, feed.summaryUrl, { summary: feed.summary, date: feed.summaryDate });
    for (const item of Array.isArray(feed.items) ? feed.items : []) {
      push(item.title, item.url, { date: item.date });
    }
    items.sort((a, b) => b.weight - a.weight);
    return items.slice(0, Math.max(1, limit));
  }

  async function refreshCandidates(il, { force = false } = {}) {
    const cs = loadCuriosity();
    if (!force && cs.candidates.length > 0 && Date.now() - cs.fetchedAt < (Number(il.curiosity.refreshMs) || DEFAULTS.curiosity.refreshMs)) {
      return cs;
    }
    const res = await collectCandidates({
      sources: il.curiosity.sources,
      biliCookies: cs.cookies,
      timeoutMs: 20000
    });
    // 本地源负责“最近发生了什么”，联网搜索负责“她自己的兴趣最近有什么可看的”。
    // 两者合并后统一去重/排序；搜索失败不影响本地候选。
    let searched = { items: [], errors: [] };
    if (il.curiosity.webSearch?.enabled !== false) {
      searched = await searchCuriosityCandidates(il);
      if (searched.items.length) log(`[inner] 搜索候选 ${searched.items.length} 条`);
    }
    // S16 资讯也进入主动分享候选：订阅播报只发到订阅群，且每天有上限；
    // 放进候选池后，她在主动分享时也能挑赛果/赛程新闻。
    const s16Items = il.curiosity.sources?.s16 === false ? [] : esportsCandidates(4);
    if (s16Items.length) log(`[inner] S16 候选 ${s16Items.length} 条`);
    if (res.biliCookies?.length) {
      cs.cookies = res.biliCookies;
      cs.cookiesAt = Date.now();
    }
    cs.fetchedAt = Date.now();
    cs.lastError = [...res.errors, ...searched.errors].join(' | ').slice(0, 500);
    const maxCandidates = Number(il.curiosity.maxCandidates) || DEFAULTS.curiosity.maxCandidates;
    const ranked = rankCandidates({
      items: [...res.items, ...searched.items, ...s16Items],
      persona: loadPersona(),
      seen: cs.seen,
      max: maxCandidates
    });
    // 娱乐内容通常分数更高；给 S16 至少留一个前排位置，否则主动分享永远轮不到赛果。
    if (s16Items.length && !ranked.some((item) => item.source === 's16')) {
      const best = s16Items[0];
      ranked.splice(Math.min(2, ranked.length), 0, { ...best, score: 0.9 });
      if (ranked.length > maxCandidates) ranked.length = maxCandidates;
    }
    cs.candidates = ranked;
    cs.s16Candidates = s16Items;
    saveCuriosity(cs);
    log(`[inner] 候选抓取 ${res.items.length + searched.items.length + s16Items.length} 条，入池 ${ranked.length} 条${cs.lastError ? `（${cs.lastError}）` : ''}`);
    return cs;
  }

  function markSeen(item) {
    if (!item) return;
    const cs = loadCuriosity();
    const key = candidateUrlKey(item);
    if (!key) return;
    if (!cs.seen.some((entry) => candidateUrlKey(entry) === key)) {
      cs.seen.unshift({ url: item.url, title: item.title, at: Date.now() });
      cs.seen = cs.seen.slice(0, 500);
      cs.candidates = cs.candidates.filter((candidate) => candidateUrlKey(candidate) !== key);
      saveCuriosity(cs);
    }
  }

  function commentKey(tid, comment) {
    return crypto.createHash('sha1').update(`${tid}\u0000${comment.uin || ''}\u0000${comment.text || ''}`).digest('hex');
  }

  function loadQzoneComments() {
    const raw = readJson(files.qzoneComments, {}) || {};
    const day = localDayKey();
    const state = {
      day: String(raw.day || day),
      count: Number(raw.count) || 0,
      posts: raw.posts && typeof raw.posts === 'object' ? raw.posts : {},
      replied: Array.isArray(raw.replied) ? raw.replied.slice(-200) : [],
      mentions: Array.isArray(raw.mentions) ? raw.mentions.slice(-200) : [],
      mentionCount: Number(raw.mentionCount) || 0,
      mentionDay: String(raw.mentionDay || day),
      pendingCommentReply: raw.pendingCommentReply && typeof raw.pendingCommentReply === 'object' ? raw.pendingCommentReply : null,
      lastCheckAt: Number(raw.lastCheckAt) || 0,
      lastResult: String(raw.lastResult || '')
    };
    if (state.day !== day) {
      state.day = day;
      state.count = 0;
    }
    if (state.mentionDay !== day) {
      state.mentionDay = day;
      state.mentionCount = 0;
    }
    return state;
  }

  function saveQzoneComments(state) {
    writeJson(files.qzoneComments, state);
  }

  function otherCommentsList(comments, target, max = 5) {
    const out = [];
    for (const c of Array.isArray(comments) ? comments : []) {
      if (!c || !c.text) continue;
      if (target && (c === target
        || (target.id && c.id && String(c.id) === String(target.id))
        || (String(c.uin || '') === String(target.uin || '') && String(c.text) === String(target.text)))) continue;
      out.push({ name: String(c.name || '空间好友').slice(0, 30), text: cleanLine(c.text, 120) });
      if (out.length >= max) break;
    }
    return out;
  }

  function otherCommentsText(comments, target, max = 5) {
    return otherCommentsList(comments, target, max).map((c) => `${c.name}：${c.text}`);
  }

  async function generateCommentReply(item, comment, images = [], comments = []) {
    const asking = /@|＠|评价|看看|说说|觉得|怎么样/.test(String(comment.text || ''));
    const others = otherCommentsText(comments, comment);
    const prompt = buildBasePrompt(
      `你发了一条 QQ 空间说说：${cleanLine(item?.content, 300) || '（正文为空）'}\n` +
      (images.length ? `随附 ${images.length} 张说说配图，先看图再回。\n` : '') +
      `有人评论：${comment.name || '空间好友'}：${comment.text}\n` +
      (others.length ? `其他评论（只作语境，不要回复他们）：\n${others.join('\n')}\n` : '') +
      (asking
        ? `对方 @ 了你/让你评价这条说说。先看说说文字和图片，再结合语境，用你本人的语气回 ${comment.name || '这条评论'} 这一条，最多 40 字；软萌、先软后硬，不要客服腔、不要总结、不要金句；别去接别人的话；只输出正文。`
        : `结合说说内容、图片和语境，用你本人的语气回复 ${comment.name || '这条评论'} 这一条，最多 25 字，软萌、先软后硬，不要客服腔、不要总结、不要金句；别去接别人的话；只输出回复正文。`)
    );
    const output = await runTurn(prompt, 90000, images);
    const text = cleanLine(output, 60).replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    if (!text || SENSITIVE_RE.test(text)) return '';
    return text.slice(0, 60);
  }

  function imageMimeFromBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return 'image/jpeg';
  }

  async function fetchQzoneImages(urls, max = 3) {
    const out = [];
    for (const url of (Array.isArray(urls) ? urls : []).slice(0, max)) {
      try {
        const res = await safeFetchBuffer(url, 8 * 1024 * 1024);
        if (res?.buffer?.length) {
          out.push({ buffer: res.buffer, mimeType: imageMimeFromBuffer(res.buffer), name: `qzone-image-${out.length + 1}` });
        }
      } catch (error) {
        log(`[inner] 空间配图下载失败（忽略）：${error?.message ?? error}`);
      }
    }
    return out;
  }

  function mentionMatched(text, names) {
    const raw = String(text ?? '');
    return names.some((name) => name && raw.includes(name));
  }

  async function generateMentionReply(postText, comment, images = [], comments = []) {
    const who = comment?.name || '空间好友';
    const others = otherCommentsText(comments, comment);
    const head = `你看到一条 QQ 空间说说：\n${cleanLine(postText, 500) || '（正文为空）'}\n`
      + (images.length ? `随附 ${images.length} 张说说配图，先看图再回。\n` : '')
      + (others.length ? `其他评论（只作语境，不要回复他们）：\n${others.join('\n')}\n` : '');
    const task = comment
      ? `${head}${who} 在评论里：${cleanLine(comment.text, 200)}\n对方 @ 了你。先看说说文字和图片，再结合语境，用你本人的语气回 ${who} 这一条，最多 40 字；软萌、先软后硬，不客服腔、不总结、不金句；别去接别人的话；只输出回复正文。`
      : `${head}这条说说 @ 了你。先看文字和图片，再结合其他评论的语境，用你本人的语气给一句回复/评价，最多 40 字；软萌、先软后硬，不客服腔、不总结、不金句；只输出回复正文。`;
    const output = await runTurn(buildBasePrompt(task), 90000, images);
    const text = cleanLine(output, 80).replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    if (!text || SENSITIVE_RE.test(text)) return '';
    return text.slice(0, 80);
  }

  async function queueCommentReply(state, { source, tid, targetUin = '', comment = null, reply, postText = '', imageUrls = [], otherComments = [], cr }) {
    const timeoutMs = Math.max(60 * 1000, Number(cr?.approvalTimeoutMs) || 2 * 3600 * 1000);
    state.pendingCommentReply = {
      source: source === 'mention' ? 'mention' : 'comment',
      tid: String(tid),
      key: comment ? commentKey(tid, comment) : `post:${tid}`,
      targetUin: String(targetUin || ''),
      commentUin: String(comment?.uin || ''),
      commentId: String(comment?.id || ''),
      commentName: String(comment?.name || ''),
      commentText: String(comment?.text || '').slice(0, 200),
      otherComments: otherCommentsList(otherComments, comment, 5),
      reply: String(reply || '').slice(0, 120),
      postText: String(postText || '').slice(0, 500),
      imageUrls: (Array.isArray(imageUrls) ? imageUrls : []).slice(0, 9),
      createdAt: Date.now(),
      expiresAt: Date.now() + timeoutMs
    };
    saveQzoneComments(state);
    const who = comment?.name ? `${comment.name}：${comment.text}` : '（说说正文 @ 了你）';
    const others = state.pendingCommentReply.otherComments;
    const othersLine = others.length
      ? `其他评论：${others.map((c) => cleanLine(`${c.name || '空间好友'}：${c.text}`, 60)).join('；')}\n`
      : '';
    const imageLines = state.pendingCommentReply.imageUrls.slice(0, 3).map((url, i) => `配图${i + 1}：${url}`).join('\n');
    await sendOwner(`【空间回复草稿】
来源：${source === 'mention' ? '好友说说 @' : '说说评论'}
说说：${cleanLine(postText, 160) || '（正文为空）'}
${imageUrls.length ? `配图：${imageUrls.length} 张` : '配图：无'}
${imageLines ? `${imageLines}\n` : ''}评论：${cleanLine(who, 160)}
${othersLine}拟回复：${reply}

回复「发回复」发布，回复「不发回复」放弃（${Math.round(timeoutMs / 60000)} 分钟内有效）`);
    return true;
  }

  async function checkQzoneMentions(il, state, firstFeeds, cr) {
    if (cr.mentionEnabled === false) return { replies: 0, detected: 0 };
    if (state.pendingCommentReply) return { replies: 0, detected: 0, pending: true };
    const names = (Array.isArray(cr.mentionNames) && cr.mentionNames.length ? cr.mentionNames : ['小鲸鱼'])
      .map((n) => String(n || '').trim()).filter(Boolean);
    if (!names.length) return { replies: 0, detected: 0 };
    const max = Math.max(0, Number(cr.mentionMaxPerDay) || 5);
    if (state.mentionCount >= max) return { replies: 0, detected: 0, limited: true };

    let selfUin = '';
    try { selfUin = await getQzoneSelfUin(cfg); } catch {}
    const feeds = [];
    const seen = new Set();
    const addFeeds = (list) => {
      for (const feed of Array.isArray(list) ? list : []) {
        const key = String(feed?.key || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        feeds.push(feed);
      }
    };
    if (firstFeeds?.feeds?.length) addFeeds(firstFeeds.feeds);
    for (let pageNum = 1; pageNum <= 3; pageNum += 1) {
      try {
        const res = await getQzoneFeeds(cfg, { pageNum, count: 20 });
        if (!res.ok) break;
        addFeeds(res.feeds);
        if (!res.hasMore) break;
      } catch {
        break;
      }
    }

    let detected = 0;
    let replies = 0;
    for (const feed of feeds) {
      if (!feed?.html || !feed?.key || String(feed.key).startsWith('advertisement')) continue;
      if (selfUin && String(feed.uin || '') === selfUin) continue; // 自己的说说由评论 watcher 处理
      const targetUin = String(feed.uin || '').trim();
      if (!targetUin || targetUin === '0') continue;
      const tid = String(feed.key);
      const postText = parseQzoneFeedPost(feed.html);
      const comments = parseQzoneComments(feed.html);
      const otherComments = comments.filter((c) => c.text && (!selfUin || c.uin !== selfUin));
      const mentionImages = await fetchQzoneImages(parseQzoneFeedImages(feed.html));
      const repliedKeys = new Set(state.replied.map((r) => r && r.key).filter(Boolean));
      const mentionKeys = new Set(state.mentions.map((m) => m && m.key).filter(Boolean));
      let handledComment = false;
      for (const comment of comments) {
        if (!comment.text || !mentionMatched(comment.text, names)) continue;
        if (comment.uin && selfUin && comment.uin === selfUin) continue;
        const key = commentKey(tid, comment);
        if (mentionKeys.has(key) || repliedKeys.has(key)) continue;
        if (state.mentionCount >= max) break;
        detected += 1;
        try {
          const reply = await generateMentionReply(postText, comment, mentionImages, comments);
          if (!reply) continue;
          if (cr.requireApproval !== false) {
            await queueCommentReply(state, { source: 'mention', tid, targetUin, comment, reply, postText, imageUrls: parseQzoneFeedImages(feed.html), otherComments, cr });
            return { replies: 0, detected, pending: true };
          }
          await commentQzone(cfg, tid, reply, { targetUin, replyTo: { uin: comment.uin, id: comment.id, name: comment.name } });
          state.mentions.push({ key, tid, targetUin, at: Date.now(), comment: comment.text.slice(0, 120), name: comment.name, reply });
          state.mentions = state.mentions.slice(-200);
          state.replied.push({ key, tid, at: Date.now(), text: reply, comment: comment.text.slice(0, 120), name: comment.name });
          state.replied = state.replied.slice(-200);
          state.mentionCount += 1;
          replies += 1;
          handledComment = true;
          log(`[inner] 已回复空间 @《${cleanLine(postText, 30)}》${comment.name || ''}：${reply}`);
        } catch (error) {
          log(`[inner] 回复空间 @ 失败：${error?.message ?? error}`);
        }
      }
      if (!handledComment && mentionMatched(postText, names)) {
        const key = `post:${tid}`;
        if (!mentionKeys.has(key) && !repliedKeys.has(key) && state.mentionCount < max) {
          detected += 1;
          try {
            const reply = await generateMentionReply(postText, null, mentionImages, comments);
            if (reply) {
              if (cr.requireApproval !== false) {
                await queueCommentReply(state, { source: 'mention', tid, targetUin, comment: null, reply, postText, imageUrls: parseQzoneFeedImages(feed.html), otherComments, cr });
                return { replies: 0, detected, pending: true };
              }
              await commentQzone(cfg, tid, reply, { targetUin });
              state.mentions.push({ key, tid, targetUin, at: Date.now(), comment: '', name: '', reply });
              state.mentions = state.mentions.slice(-200);
              state.mentionCount += 1;
              replies += 1;
              log(`[inner] 已回复说说 @《${cleanLine(postText, 30)}》：${reply}`);
            }
          } catch (error) {
            log(`[inner] 回复说说 @ 失败：${error?.message ?? error}`);
          }
        }
      }
    }
    return { replies, detected };
  }

  async function checkQzoneComments() {
    const il = ilCfg();
    const cr = il.qzone?.commentReply || DEFAULTS.qzone.commentReply;
    if (il.qzone?.enabled === false || cr.enabled === false) return { status: 'disabled' };
    if (loadInner().qzone.paused) return { status: 'paused' };
    if (isQuiet(il)) return { status: 'quiet' };
    const state = loadQzoneComments();
    const maxPerDay = Math.max(0, Number(cr.maxPerDay) || 5);
    if (state.count >= maxPerDay) {
      state.lastResult = 'daily-limit';
      saveQzoneComments(state);
      return { status: 'daily-limit' };
    }
    if (state.pendingCommentReply && Date.now() < Number(state.pendingCommentReply.expiresAt || 0)) {
      state.lastResult = 'pending-approval';
      saveQzoneComments(state);
      return { status: 'pending-approval' };
    }
    if (state.pendingCommentReply) {
      state.pendingCommentReply = null;
      saveQzoneComments(state);
    }
    const list = await listQzone(cfg, { pos: 0, num: 20 });
    if (!list.ok) {
      state.lastCheckAt = Date.now();
      state.lastResult = `list-error:${list.error || ''}`;
      saveQzoneComments(state);
      return { status: 'list-error', error: list.error };
    }
    let feeds = null;
    let detected = 0;
    let replies = 0;
    let selfUin = '';
    try { selfUin = await getQzoneSelfUin(cfg); } catch {}
    for (const item of list.items) {
      const tid = qzoneItemTid(item);
      let commentNum = Number(item.comment_num) || 0;
      if (!tid || commentNum <= 0) continue;
      const prev = state.posts[tid] && typeof state.posts[tid] === 'object' ? state.posts[tid] : {};
      const prevNum = Number(prev.lastCommentNum) || 0;
      let detail = null;
      try { detail = await getQzoneMsgDetail(cfg, tid); } catch (error) { log(`[inner] 空间详情读取失败，回退 feed：${error?.message ?? error}`); }
      if (detail && Number(detail.cmtnum) > 0) commentNum = Number(detail.cmtnum);
      if (commentNum <= prevNum) continue;
      detected += commentNum - prevNum;
      let comments = detail?.comments || [];
      let feed = null;
      if (!detail) {
        if (feeds === null) {
          try { feeds = await getQzoneFeeds(cfg, { pageNum: 1, count: 20 }); } catch (error) { feeds = { ok: false, feeds: [], error: error?.message ?? String(error) }; }
        }
        feed = (feeds?.feeds || []).find((f) => String(f?.key || f?.tid || '') === tid);
        comments = feed ? parseQzoneComments(feed.html) : [];
        if (!selfUin && feed?.uin) selfUin = String(feed.uin);
      }
      const repliedKeys = new Set(state.replied.map((r) => r && r.key).filter(Boolean));
      const fresh = comments.filter((c) => c.text && (!selfUin || c.uin !== selfUin) && !repliedKeys.has(commentKey(tid, c)));
      const otherComments = comments.filter((c) => c.text && (!selfUin || c.uin !== selfUin));
      const postImages = await fetchQzoneImages(item.images || []);
      let advanced = true;
      let queued = false;
      if (fresh.length) {
        for (const comment of fresh) {
          if (state.count >= maxPerDay) {
            advanced = false;
            state.lastResult = 'daily-limit';
            break;
          }
          try {
            const reply = await generateCommentReply(item, comment, postImages, otherComments);
            if (reply) {
              if (cr.requireApproval !== false) {
                await queueCommentReply(state, { source: 'comment', tid, comment, reply, postText: item.content, imageUrls: item.images || [], otherComments, cr });
                queued = true;
                advanced = false;
                break;
              }
              // 自己的说说：target_uin 省略；有评论 id 时走“回复”而不是新评论。
              await commentQzone(cfg, tid, reply, { replyTo: { uin: comment.uin, id: comment.id, name: comment.name } });
              state.replied.push({ key: commentKey(tid, comment), tid, at: Date.now(), text: reply, comment: comment.text.slice(0, 120), name: comment.name });
              state.replied = state.replied.slice(-200);
              state.count += 1;
              replies += 1;
              log(`[inner] 已回复空间评论《${cleanLine(item.content, 30)}》${comment.name || ''}：${reply}`);
            } else {
              advanced = false;
              log(`[inner] 空间评论回复为空，保留待重试：${comment.text.slice(0, 40)}`);
            }
          } catch (error) {
            advanced = false;
            log(`[inner] 回复空间评论失败，保留待重试：${error?.message ?? error}`);
          }
        }
      } else if (!comments.length) {
        advanced = false;
        const last = Number(prev.unparsedNotifiedAt) || 0;
        if (Date.now() - last > 6 * 3600 * 1000) {
          try {
            await sendOwner(`【空间评论】《${cleanLine(item.content, 40)}》现在有 ${commentNum} 条评论，但 SnowLuma 这次没返回评论内容，我没法准确回复。你可以把评论贴给我，或者我按说说内容回一句。`);
            state.posts[tid] = { ...prev, unparsedNotifiedAt: Date.now() };
          } catch {}
        }
      } else if (comments.length < commentNum) {
        // 网关只回了部分评论：不要推进水位，否则没解析到的评论会被永久跳过。
        advanced = false;
        log(`[inner] 空间评论未完整返回（${comments.length}/${commentNum}），保留水位待重试`);
      }
      if (queued) {
        state.lastResult = 'pending-approval';
      } else if (advanced) {
        state.posts[tid] = { ...(state.posts[tid] || {}), lastCommentNum: commentNum, lastCheckedAt: Date.now(), lastError: '' };
      } else {
        state.posts[tid] = { ...(state.posts[tid] || {}), lastError: 'reply-failed', lastAttemptAt: Date.now(), lastCheckedAt: Date.now() };
      }
    }
    if (cr.mentionEnabled !== false) {
      try {
        const mentionResult = await checkQzoneMentions(il, state, feeds, cr);
        replies += mentionResult.replies || 0;
        detected += mentionResult.detected || 0;
      } catch (error) {
        log(`[inner] 空间 @ 检查失败：${error?.message ?? error}`);
      }
    }
    state.lastCheckAt = Date.now();
    state.lastResult = state.pendingCommentReply ? 'pending-approval' : (replies ? `replied:${replies}` : (detected ? 'detected-no-reply' : 'checked'));
    saveQzoneComments(state);
    if (detected) log(`[inner] 空间评论检查：新增 ${detected} 条，回复 ${replies} 条`);
    return { status: replies ? 'replied' : (state.pendingCommentReply ? 'pending-approval' : 'checked'), detected, replies };
  }

  function getQzoneCommentStatus() {
    const state = loadQzoneComments();
    const pending = state.pendingCommentReply && Date.now() < Number(state.pendingCommentReply.expiresAt || 0)
      ? {
        source: state.pendingCommentReply.source,
        commentName: state.pendingCommentReply.commentName || '',
        reply: state.pendingCommentReply.reply || '',
        images: (state.pendingCommentReply.imageUrls || []).length,
        otherComments: (state.pendingCommentReply.otherComments || []).length,
        expiresAt: Number(state.pendingCommentReply.expiresAt) || 0
      }
      : null;
    return {
      lastCheckAt: state.lastCheckAt,
      lastResult: state.lastResult,
      repliedToday: state.count,
      maxPerDay: Math.max(0, Number(ilCfg().qzone?.commentReply?.maxPerDay) || 5),
      mentionEnabled: ilCfg().qzone?.commentReply?.mentionEnabled !== false,
      mentionRepliedToday: state.mentionCount,
      mentionMaxPerDay: Math.max(0, Number(ilCfg().qzone?.commentReply?.mentionMaxPerDay) || 5),
      pendingReply: pending,
      posts: Object.keys(state.posts).length
    };
  }

  function getAiTipsStatus() {
    const il = ilCfg();
    const module = shareModuleById('ai_tips');
    const state = loadShareModulesState();
    const m = state.modules.ai_tips || {};
    const tips = loadAiTips();
    const target = module?.targets?.[0] || aiTipTarget(il);
    const profile = target ? cfg.simulation?.groupProfiles?.[target] : null;
    const history = Array.isArray(m.history) ? m.history : [];
    const counts = new Map();
    for (const item of history) counts.set(item.category, (counts.get(item.category) || 0) + 1);
    const preview = m.lastPreview || tips.lastPreview;
    return {
      enabled: module?.enabled === true,
      paused: m.paused === true,
      target,
      targetLabel: String(profile?.label || ''),
      today: Number(m.sentToday) || 0,
      dailyTarget: Number(m.dailyTarget) || 0,
      minPerDay: Number(module?.limits?.minPerDay) || 0,
      maxPerDay: Number(module?.limits?.maxPerDay) || 0,
      maxChars: Number(module?.content?.maxChars) || 0,
      windowStartHour: Number(module?.trigger?.windowStartHour) || 0,
      windowEndHour: Number(module?.trigger?.windowEndHour) || 0,
      minGapMs: Number(module?.trigger?.minGapMs) || 0,
      nextAt: Number(m.nextAt) || 0,
      verification: String(m.verification?.status || 'pending'),
      preview: preview && Array.isArray(preview.items) && preview.items.length
        ? { at: Number(preview.at) || 0, count: preview.items.length }
        : null,
      last: history[0] ? {
        at: Number(history[0].at) || 0,
        topic: String(history[0].topic || ''),
        title: String(history[0].title || ''),
        category: String(history[0].category || ''),
        categoryLabel: categoryById(history[0].category)?.label || '',
        text: String(history[0].text || '').slice(0, 200)
      } : null,
      recent: history.slice(0, 8).map((item) => ({
        at: Number(item.at) || 0,
        topic: String(item.topic || ''),
        title: String(item.title || ''),
        category: String(item.category || ''),
        categoryLabel: categoryById(item.category)?.label || ''
      })),
      total: history.length,
      categories: AI_TIP_CATEGORIES.map((c) => ({ id: c.id, label: c.label, count: counts.get(c.id) || 0 }))
    };
  }

  function getShareModulesStatus() {
    const conf = shareModulesConfig();
    const state = loadShareModulesState();
    const modules = Object.values(conf.modules).map((module) => {
        const m = state.modules[module.id] || {};
        const facetList = moduleFacets(module).map((facet) => {
          const fs = m.facets?.[facet.id] || {};
          return {
            id: facet.id,
            label: facet.label,
            template: facet.template,
            runtime: facetRuntime(facet, module),
            sourceMode: String(facet.source?.mode || ''),
            onlySource: String(facet.source?.onlySource || ''),
            weight: facet.weight,
            enabled: facet.enabled !== false,
            trigger: facet.trigger?.type || 'schedule',
            delivery: facet.delivery?.mode || 'direct',
            today: Number(fs.count) || 0,
            lastAt: Number(fs.lastAt) || 0,
            maxPerDay: Number(facet.limits?.maxPerDay) || 0
          };
        });
        const last = m.history?.[0];
        return {
          id: module.id,
          label: module.label,
          enabled: module.enabled,
          runtime: module.runtime,
          engineFacetCount: engineFacets(module).length,
          template: module.template,
          targets: module.targets,
          rotateTargets: module.rotateTargets,
          paused: m.paused === true,
          verification: m.verification?.status || 'pending',
          nextAt: Number(m.nextAt) || 0,
          today: Number(m.sentToday) || 0,
          dailyTarget: Number(m.dailyTarget) || 0,
          facets: facetList,
          pending: m.pending ? {
            title: String(m.pending.title || '').slice(0, 60),
            target: String(m.pending.target || ''),
            createdAt: Number(m.pending.createdAt) || 0,
            expiresAt: Number(m.pending.expiresAt) || 0
          } : null,
          last: last ? {
            at: Number(last.at) || 0,
            title: String(last.title || ''),
            facetId: String(last.facetId || ''),
            text: String(last.text || '').slice(0, 160)
          } : null,
          stats: m.stats || { sent: 0, failed: 0, duplicates: 0 },
          lastError: String(m.lastError || '')
        };
      });
    const ilNow = ilCfg();
    const inner = loadInner();
    if (!conf.modules.life_fun) {
      modules.push({
        id: 'life_fun',
        label: '生活趣闻',
        enabled: ilNow.curiosity.enabled !== false,
        runtime: 'legacy-curiosity',
        template: 'fun',
        targets: shareTargets(ilNow),
        rotateTargets: true,
        paused: false,
        verification: 'approved',
        nextAt: Number(inner.next.curiosity) || 0,
        today: Number(inner.counts.curiosity) || 0,
        dailyTarget: Number(ilNow.curiosity.maxPerDay) || 0,
        facets: [{ id: 'default', label: '生活趣闻', template: 'fun', runtime: 'legacy-curiosity', sourceMode: 'pool', weight: 1, enabled: true, trigger: 'schedule', delivery: 'direct', today: Number(inner.counts.groupShare) || 0, lastAt: 0, maxPerDay: Number(ilNow.curiosity.maxPerDay) || 0 }],
        pending: null,
        last: inner.history.groupShares[0] ? { at: Number(inner.history.groupShares[0].at) || 0, title: '', facetId: 'default', text: String(inner.history.groupShares[0].text || '').slice(0, 160) } : null,
        stats: { sent: 0, failed: 0, duplicates: 0 },
        lastError: '',
        legacy: true
      });
    }
    const subs = Array.isArray(cfg.simulation?.subscriptions) ? cfg.simulation.subscriptions.filter((s) => s && s.enabled !== false) : [];
    if (!conf.modules.s16 && subs.length) {
      modules.push({
        id: 's16',
        label: 'S16 分享',
        enabled: true,
        runtime: 'legacy-s16',
        template: 'news',
        targets: [...new Set(subs.map((s) => String(s.key || '').trim()))].filter(Boolean),
        rotateTargets: false,
        paused: false,
        verification: 'approved',
        nextAt: 0,
        today: 0,
        dailyTarget: 0,
        facets: [
          { id: 'news', label: '赛果资讯', template: 'news', weight: 1, runtime: 'legacy-s16', enabled: true, trigger: 'feed-event', delivery: 'wake', today: 0, lastAt: 0, maxPerDay: 0 },
          { id: 'fun', label: '选手趣闻', template: 'fun', runtime: 'engine', sourceMode: 'pool', onlySource: 's16', weight: 1, enabled: true, trigger: 'schedule', delivery: 'direct', today: 0, lastAt: 0, maxPerDay: 1 }
        ],
        pending: null,
        last: null,
        stats: { sent: 0, failed: 0, duplicates: 0 },
        lastError: '',
        legacy: true
      });
    }
    return { enabled: conf.enabled, limits: conf.limits, modules };
  }

  function aiTipsStatusLine() {
    const status = getAiTipsStatus();
    const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '未安排');
    const stateText = !status.enabled ? '未启用' : status.paused ? '已暂停' : '开';
    const lastText = status.last
      ? `最近 [${status.last.categoryLabel || status.last.category}] ${status.last.title || status.last.topic}`
      : '还没讲过';
    return `AI小知识：${stateText}${status.target ? `（${status.targetLabel || status.target}）` : '（未设目标群）'} · 今天 ${status.today}/${status.dailyTarget || `${status.minPerDay}-${status.maxPerDay}`} 条 · ${lastText} · 下次 ${fmt(status.nextAt)}`;
  }

  function prepareShareModule(input = {}, { allowExisting = false } = {}) {
    const id = String(input.id || '').trim();
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(id)) return { ok: false, error: 'id 必须是 2–32 位小写字母/数字/下划线，且以字母开头' };
    if (!allowExisting && shareModulesConfig().modules[id]) return { ok: false, error: `模块 ${id} 已存在` };
    const template = String(input.template || 'custom');
    if (!SHARE_TEMPLATES[template]) return { ok: false, error: `未知模板 ${template}` };
    const module = normalizeShareModule({
      ...input,
      id,
      template,
      verification: { status: 'pending', approvedAt: 0, approvedBy: '' },
      delivery: { ...(input.delivery || {}), mode: 'approval' }
    }, id);
    if (!module.targets.length) return { ok: false, error: '至少指定一个目标群' };
    for (const facet of module.facets) {
      if (!SHARE_TEMPLATES[facet.template]) return { ok: false, error: `facet ${facet.id} 的模板 ${facet.template} 不存在` };
    }
    return { ok: true, module };
  }

  function getShareModuleConfig(id) {
    const module = shareModulesConfig().modules[String(id || '')];
    return module ? JSON.parse(JSON.stringify(module)) : null;
  }

  /** 编辑已有模块：保留验证状态与暂停状态，不因一次编辑退回验证期。 */
  function updateShareModuleConfig(id, input = {}) {
    const existing = shareModulesConfig().modules[String(id || '')];
    if (!existing) return { ok: false, error: `模块 ${id} 不存在` };
    const merged = normalizeShareModule({
      ...existing,
      ...input,
      id: existing.id,
      facets: Array.isArray(input.facets) && input.facets.length ? input.facets : existing.facets,
      verification: existing.verification,
      paused: existing.paused
    }, existing.id);
    if (!merged.targets.length) return { ok: false, error: '至少指定一个目标群' };
    for (const facet of merged.facets) {
      if (!SHARE_TEMPLATES[facet.template]) return { ok: false, error: `facet ${facet.id} 的模板 ${facet.template} 不存在` };
    }
    return { ok: true, module: merged };
  }

  /** 旧链路（订阅播报）发过的链接也记进模块历史，避免引擎之后把同一篇文章再发一次。 */
  function noteLegacyShare({ moduleId = 's16', facetId = 'news', url = '', title = '', text = '', at = Date.now() } = {}) {
    if (!url) return null;
    const state = loadShareModulesState();
    const m = state.modules[moduleId];
    if (!m) return null;
    if (m.history.some((item) => normShareUrl(item.url || item.sourceUrl) === normShareUrl(url))) return m.history[0] || null;
    m.history.unshift({
      at,
      facetId,
      category: '',
      topic: String(title || '').slice(0, 60),
      title: String(title || '').slice(0, 60),
      text: String(text || '').slice(0, 800),
      terms: [],
      links: [],
      imageSource: '',
      imageHosts: '',
      time: '',
      sourceUrl: String(url),
      url: String(url),
      source: 's16'
    });
    m.history = m.history.slice(0, 500);
    const day = shareDayKey(new Date(at));
    const prev = m.facets[facetId] && typeof m.facets[facetId] === 'object' ? m.facets[facetId] : { day, count: 0, lastAt: 0 };
    m.facets[facetId] = {
      day,
      count: (String(prev.day || day) === day ? Number(prev.count) || 0 : 0) + 1,
      lastAt: at,
      lastError: ''
    };
    saveShareModulesState(state);
    return m.history[0];
  }

  function initShareModuleState(module) {    const state = loadShareModulesState();
    const now = Date.now();
    state.modules[module.id] = {
      day: shareDayKey(new Date(now)),
      sentToday: 0,
      dailyTarget: 0,
      lastSentAt: 0,
      nextAt: nextShareModuleAt(module, { facets: {} }, now),
      paused: false,
      verification: { status: 'pending', approvedAt: 0, approvedBy: '' },
      _verificationSet: true,
      facets: {},
      history: [],
      lastPreview: null,
      stats: { sent: 0, failed: 0, duplicates: 0 },
      lastError: '',
      lastErrorAt: 0
    };
    saveShareModulesState(state);
    return state.modules[module.id];
  }

  function removeShareModuleState(moduleId) {
    const state = loadShareModulesState();
    delete state.modules[moduleId];
    saveShareModulesState(state);
  }

  function shareModulesConfig() {
    const normalized = normalizeShareConfig(cfg.simulation?.shareModules);
    const tips = ilCfg().aiTips;
    if (!normalized.modules.ai_tips && tips?.enabled) {
      normalized.modules.ai_tips = normalizeShareModule({
        id: 'ai_tips',
        label: 'AI 知识分享',
        enabled: true,
        template: 'knowledge',
        targets: tips.target ? [tips.target] : [],
        limits: { minPerDay: tips.minPerDay, maxPerDay: tips.maxPerDay },
        trigger: {
          type: 'schedule',
          windowStartHour: tips.windowStartHour,
          windowEndHour: tips.windowEndHour,
          minGapMs: tips.minGapMs
        },
        content: {
          audience: '完全不懂 AI 的爸爸妈妈',
          tone: '通俗、自然、清楚、有生活气',
          minChars: 180,
          maxChars: tips.maxChars,
          requireTechName: true,
          titleRule: '技术名开头，“技术名：一句话结论”，16 字以内，技术名只出现一次',
          categorySet: 'ai-tips'
        },
        links: { enabled: tips.links !== false, max: tips.maxLinks || 3 },
        media: { mode: 'auto', maxImages: 2, card: true, webImages: tips.webImages !== false },
        delivery: { mode: 'direct' },
        verification: { status: 'approved', approvedAt: Date.now(), approvedBy: 'owner' },
        facets: [{ id: 'default', template: 'knowledge', weight: 1 }]
      }, 'ai_tips');
    }
    return normalized;
  }

  function loadShareModulesState() {
    const conf = shareModulesConfig();
    const state = loadShareState(files.shareModules, { now: Date.now(), moduleIds: Object.keys(conf.modules) });
    for (const [id, module] of Object.entries(conf.modules)) {
      const m = state.modules[id];
      if (!m) continue;
      if (!m._verificationSet && module.verification?.status === 'approved') {
        m.verification = { status: 'approved', approvedAt: Number(module.verification.approvedAt) || Date.now(), approvedBy: 'config' };
      }
    }
    const aiRaw = readJson(files.aiTips, {}) || {};
    const aiHasData = aiRaw && (aiRaw.lastSentAt || (Array.isArray(aiRaw.history) && aiRaw.history.length) || aiRaw.lastPreview || aiRaw.paused || aiRaw.dailyTarget);
    if (conf.modules.ai_tips && state.modules.ai_tips && !state.modules.ai_tips._migrated && aiHasData) {
      const inner = loadInner();
      state.modules.ai_tips = {
        ...state.modules.ai_tips,
        ...migrateAiTipsState(aiRaw, { moduleId: 'ai_tips', now: Date.now(), nextAt: inner.next.aiTips }),
        _migrated: true
      };
      saveShareState(files.shareModules, state);
    }
    let dirty = false;
    for (const [id, module] of Object.entries(conf.modules)) {
      const m = state.modules[id];
      if (!m || !module.enabled || m.paused || m.pending || m.nextAt || !hasEngineFacets(module)) continue;
      m.nextAt = nextShareModuleAt(module, m, Date.now());
      if (m.nextAt) dirty = true;
    }
    if (dirty) saveShareState(files.shareModules, state);
    return state;
  }

  function saveShareModulesState(state) {
    saveShareState(files.shareModules, state);
  }

  function shareModuleById(id) {
    return shareModulesConfig().modules[String(id || '')] || null;
  }

  function shareTargetFor(module, state) {
    const targets = Array.isArray(module.targets) ? module.targets.filter(Boolean) : [];
    if (!targets.length) return '';
    if (!module.rotateTargets) return targets[0];
    const counts = targets.map((key) => ({ key, at: Number(state?.groups?.[key]?.lastAt) || 0 }));
    counts.sort((a, b) => a.at - b.at);
    return counts[0].key;
  }

  function shareGroupStyle(target) {
    const style = target ? cfg.simulation?.groupProfiles?.[target]?.style : '';
    return style ? `【本群风格（优先遵守）】\n${String(style).trim()}\n\n` : '';
  }

  async function findShareLinks({ keyTerm = '', searchQuery = '', techName = '', max = 3, enabled = true } = {}) {
    if (!enabled) return [];
    const query = cleanLine(searchQuery, 80) || `${cleanLine(keyTerm || techName, 30)} 原理 实现`;
    try {
      const result = await webSearch(query, { root: process.cwd(), provider: 'bing' });
      let links = pickTipLinks(result?.results || [], techName || keyTerm, { max, keyTerm, techName });
      const term = cleanLine(keyTerm, 30);
      if (term.length >= 2 && /[\u4e00-\u9fa5]/.test(term)) {
        const baike = `https://baike.baidu.com/item/${encodeURIComponent(term)}`;
        links = [{ title: `${term}_百度百科`, url: baike }, ...links.filter((link) => !link.url.includes('baike.baidu.com'))];
      }
      if (!links.length && techName) {
        if (/[\u4e00-\u9fa5]/.test(techName)) {
          links = [{ title: `${cleanLine(techName, 20)}_百度百科`, url: `https://baike.baidu.com/item/${encodeURIComponent(cleanLine(techName, 30))}` }];
        }
      }
      if (!links.length && techName) {
        const q = encodeURIComponent(`${techName} 原理 入门`);
        links = [{ title: `知乎：${cleanLine(techName, 20)} 相关讨论`, url: `https://www.zhihu.com/search?type=content&q=${q}` }];
      }
      return links.slice(0, max);
    } catch (error) {
      log(`[share] 延伸阅读检索失败（不影响发送）：${error?.message ?? error}`);
      return [];
    }
  }

  function shareTemplateNeedsCard(module, facet) {
    const tpl = String(facet?.template || module.template);
    return ['knowledge', 'finance', 'story', 'data'].includes(tpl) && module.media?.card !== false;
  }

  async function buildShareImages(module, facet, parsed, links) {
    const mode = String(module.media?.mode || 'auto');
    if (mode === 'none') return { images: [], imageSource: '', imageHosts: '' };
    const webImages = mode === 'card' ? [] : await fetchWebIllustrations(links);
    const cardWanted = shareTemplateNeedsCard(module, facet)
      && (mode === 'card' || mode === 'auto')
      && parsed.phenomenon && parsed.tech && parsed.how;
    const card = cardWanted ? await buildAiTipCard(parsed) : null;
    const images = [];
    if (webImages.length) {
      images.push(...webImages.map((item) => item.buffer));
      if (webImages.length === 1 && card) images.push(card);
    } else if (card) {
      images.push(card);
    }
    return {
      images: images.slice(0, Math.max(1, Math.min(3, Number(module.media?.maxImages) || 2))),
      imageSource: webImages.length ? 'web' : (card ? 'card' : ''),
      imageHosts: [...new Set(webImages.map((item) => item.host).filter(Boolean))].join(', ')
    };
  }

  async function queueShareDraft(module, facet, state, { target, parsed, links, images, imageSource, imageHosts }) {
    const caption = formatShareCaption(parsed, facet.template);
    const prefix = verificationPending(module, state.modules[module.id])
      ? '【分享草稿 · 验证期】'
      : '【分享草稿 · 待确认】';
    const okImage = images.length ? await sendAiTipImage(`private:${cfg.ownerQQ}`, images, parsed, { caption: `${prefix}\n${caption}` }) : false;
    if (!okImage) await sendOwner(`${prefix}\n${caption}`);
    const linksText = formatShareLinksText(links, { imageHosts: okImage ? imageHosts : '', sourceUrl: parsed.sourceUrl });
    if (linksText) await sendOwner(linksText);
    await sendOwner(`回「发分享 ${module.id}」发布，或「不发分享 ${module.id}」放弃；验证满意后回「验证通过 ${module.id}」。`);
    const m = state.modules[module.id];
    m.pending = {
      moduleId: module.id,
      facetId: facet.id,
      target,
      title: parsed.title,
      text: parsed.text,
      terms: parsed.terms,
      techName: parsed.techName,
      phenomenon: parsed.phenomenon,
      tech: parsed.tech,
      how: parsed.how,
      riskNote: parsed.riskNote,
      caveat: parsed.caveat,
      time: parsed.time,
      sourceUrl: parsed.sourceUrl,
      keyTerm: parsed.keyTerm,
      searchQuery: parsed.searchQuery,
      links,
      imageSource,
      imageHosts,
      createdAt: Date.now(),
      expiresAt: Date.now() + 2 * 3600 * 1000
    };
    m.nextAt = Date.now() + 2 * 3600 * 1000;
    saveShareModulesState(state);
    return { status: 'pending-approval', moduleId: module.id, facetId: facet.id, title: parsed.title, text: parsed.text, links };
  }

  async function publishShareDraft(moduleId, { force = false } = {}) {
    const conf = shareModulesConfig();
    const module = conf.modules[moduleId];
    const state = loadShareModulesState();
    const m = state.modules[moduleId];
    if (!module || !m?.pending) return { status: 'no-draft' };
    const pending = m.pending;
    if (!force && Date.now() > Number(pending.expiresAt || 0)) {
      m.pending = null;
      saveShareModulesState(state);
      return { status: 'expired' };
    }
    const budget = groupBudgetCheck(state, pending.target, Date.now(), conf.limits);
    if (!budget.ok) return { status: 'budget', ...budget };
    const parsed = {
      title: pending.title,
      text: pending.text,
      terms: pending.terms || [],
      techName: pending.techName,
      phenomenon: pending.phenomenon,
      tech: pending.tech,
      how: pending.how,
      riskNote: pending.riskNote,
      caveat: pending.caveat,
      time: pending.time,
      sourceUrl: pending.sourceUrl,
      keyTerm: pending.keyTerm,
      searchQuery: pending.searchQuery
    };
    const facet = moduleFacets(module).find((item) => item.id === pending.facetId) || moduleFacets(module)[0];
    const { images, imageSource, imageHosts } = await buildShareImages(module, facet, parsed, pending.links || []);
    const caption = formatShareCaption(parsed, facet?.template || module.template);
    let imageSent = false;
    if (images.length) imageSent = await sendAiTipImage(pending.target, images, parsed, { caption });
    if (!imageSent) {
      await sendToQQ(pending.target, caption);
      if (lastSendSucceeded && lastSendSucceeded(pending.target) === false) return { status: 'send-failed' };
    }
    const linksText = formatShareLinksText(pending.links || [], { imageHosts: imageSent ? imageHosts : '', sourceUrl: parsed.sourceUrl });
    if (linksText) await sendToQQ(pending.target, linksText);
    recordGroupSend(state, pending.target, Date.now());
    recordModuleSend(state, moduleId, pending.facetId, Date.now(), {
      ...parsed,
      links: pending.links || [],
      imageSource: imageSent ? imageSource : '',
      imageHosts: imageSent ? imageHosts : ''
    });
    m.pending = null;
    m.nextAt = nextShareModuleAt(module, m, Date.now());
    saveShareModulesState(state);
    if (appendActivity) {
      try { appendActivity(`${pending.target} [share:${moduleId}] ${caption.slice(0, 100)}`); } catch {}
    }
    return { status: 'sent', moduleId, target: pending.target, title: parsed.title };
  }

  function nextShareModuleAt(module, moduleState, now = Date.now()) {
    const facets = engineFacets(module);
    if (!facets.length) return 0;
    const times = facets.map((facet) => {
      const st = moduleState?.facets?.[facet.id] || {};
      return nextFacetAt(facet, Number(st.lastAt) || 0, now);
    });
    return Math.min(...times.filter((t) => Number.isFinite(t) && t > 0));
  }

  function nextShareMorning(module) {
    const startHour = Math.max(0, Math.min(23, Number(module.trigger?.windowStartHour) || 9));
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(startHour, 0, 0, 0);
    return d.getTime() + rand(5 * 60 * 1000, 50 * 60 * 1000);
  }

  function advanceShareModule(moduleId, result) {
    const conf = shareModulesConfig();
    const module = conf.modules[moduleId];
    if (!module) return;
    const state = loadShareModulesState();
    const m = state.modules[moduleId];
    if (!m) return;
    const now = Date.now();
    const status = String(result?.status || '');
    if (!module.enabled || m.paused) m.nextAt = 0;
    else if (status === 'pending-approval' || m.pending) m.nextAt = now + 2 * 3600 * 1000;
    else if (status === 'daily-done') m.nextAt = nextShareMorning(module);
    else if (status === 'budget') m.nextAt = Number(result?.retryAt) || (now + 30 * 60 * 1000);
    else if (status === 'no-candidates') m.nextAt = now + rand(20 * 60 * 1000, 45 * 60 * 1000);
    else if (status === 'tone-conflict' || status === 'time-conflict') m.nextAt = now + rand(45 * 60 * 1000, 2 * 3600 * 1000);
    else if (status === 'invalid' || status === 'duplicate' || status === 'error') m.nextAt = now + rand(30 * 60 * 1000, 90 * 60 * 1000);
    else if (status === 'sent') m.nextAt = nextShareModuleAt(module, m, now);
    else m.nextAt = nextShareModuleAt(module, m, now) || (now + 30 * 60 * 1000);
    saveShareModulesState(state);
  }


  async function runReflection(il) {
    if (!il.reflection.enabled) return { status: 'disabled' };
    const now = Date.now();
    const moodOn = il.mood?.enabled !== false;
    const target = targetState(il);
    const md = moodOn
      ? moodDigest(il)
      : {
        text: digest(target?.st ?? null, 40),
        topics: recentTopics(target?.st ?? null, 6),
        anchor: recentTimeAnchor(target?.st ?? null),
        rested: false
      };
    const inner = loadInner();
    if (!md.text && inner.history.groupShares.length === 0 && inner.history.qzonePosts.length === 0) {
      log('[inner] 反思跳过：今天没有群聊也没有分享');
      return { status: 'skip' };
    }
    const mode = derivePersonaMode(loadPersona(), { now, quiet: isQuiet(il) });
    const prompt = reflectionPrompt(target?.st ?? null, { ...md, il, mode });
    const output = await runTurn(prompt, 180000);
    const reflection = firstJsonObject(output);
    if (!reflection) {
      log(`[inner] 反思输出不是 JSON，跳过：${cleanLine(output, 120)}`);
      return { status: 'invalid' };
    }
    const before = loadPersona();
    const result = moodOn
      ? applyReflectionV3(before, reflection, { now, cfg: il.mood, rested: md.rested })
      : applyReflection(before, reflection, now);
    savePersona(result.state);
    if (moodOn && il.mood?.history?.enabled !== false) {
      const meta = result.meta || {};
      const delta = meta.delta || {};
      const changed = meta.source !== 'empty'
        || Math.abs(Number(delta.v) || 0) >= 0.005
        || Math.abs(Number(delta.a) || 0) >= 0.005
        || Math.abs(Number(delta.e) || 0) >= 0.005;
      if (changed) {
        appendMoodHistory(files.moodHistory, {
          at: now,
          source: meta.source || 'reflection',
          cause: result.state.mood.cause,
          before: meta.before || null,
          after: meta.after || null,
          delta,
          events: (meta.events || []).map((event) => ({ what: event.what, intensity: event.intensity, valence: event.valence })),
          mode: mode.id,
          label: result.state.mood.label,
          labelRaw: meta.labelRaw || '',
          setPoint: result.state.mood.setPoint
        }, {
          now,
          keepDays: Number(il.mood?.history?.keepDays) || 180,
          maxBytes: Number(il.mood?.history?.maxBytes) || 5 * 1024 * 1024
        });
      }
    }
    if (result.changes.length) log(`[inner] 反思更新：${result.changes.join('；')}`);
    else log('[inner] 反思完成：状态没有明显变化');
    return { status: 'ok', changes: result.changes };
  }

  function shareToneIssue(text, { requireFirstPerson = true } = {}) {
    const raw = String(text ?? '').trim();
    if (!raw) return '';
    if (/(这段话|这句话|这则|值得注意的是|说明了|意味着|整体来看|不难看出|堪称|换句话说|首先|其次|总之)/.test(raw)) {
      return '像评论员/新闻总结，不像本人说话';
    }
    if (/(老子|特么|卧槽|兄弟|老哥|服了|我服|行吧|就这|离谱|牛批|绝了)/.test(raw)) {
      return '有偏硬/老哥腔的词，软萌底色不够';
    }
    if (requireFirstPerson && raw.length > 35 && !/(我|咱|本鱼|小鲸鱼)/.test(raw)) {
      return '缺少第一人称，听起来像转述而不是你自己的反应';
    }
    return '';
  }

  function shouldPrioritizeS16(candidates, history) {
    const s16 = (Array.isArray(candidates) ? candidates : []).filter((item) => item?.source === 's16');
    if (!s16.length) return null;
    const recent = (Array.isArray(history) ? history : []).slice(0, 6);
    const hasRecentS16 = recent.some((item) => item?.source === 's16'
      || /S16|世界赛|瑞士轮|赛果|战队|LPL|LCK/i.test(`${item?.text || ''} ${item?.url || ''}`));
    return hasRecentS16 ? null : s16.slice(0, 3);
  }

  async function runCuriosity(il, { force = false, preferS16 = false, forceApproval = false, dryRun = false } = {}) {
    if (!il.curiosity.enabled) return { status: 'disabled' };
    const state = loadInner();
    if (!force && state.counts.curiosity >= (Number(il.curiosity.maxPerDay) || DEFAULTS.curiosity.maxPerDay)) {
      return { status: 'daily-limit' };
    }
    if (!force && isQuiet(il)) return { status: 'quiet' };
    const target = pickShareTarget(il, state);
    if (!target) return { status: 'not-sent' };
    log(`[inner] 本轮分享目标：${target}`);
    const cs = await refreshCandidates(il, { force: preferS16 || force || state.counts.curiosity === 0 });
    if (!cs.candidates.length) return { status: 'no-candidates' };
    // 最近 6 条分享都没有 S16 时，这一轮只从 S16 候选里挑，保证赛事资讯不会被娱乐内容长期挤掉。
    let s16Only = null;
    if (preferS16) {
      const seenKeys = new Set((Array.isArray(cs.seen) ? cs.seen : []).map((item) => candidateUrlKey(item)).filter(Boolean));
      const rawS16 = (Array.isArray(cs.s16Candidates) ? cs.s16Candidates : [])
        .filter((item) => !seenKeys.has(candidateUrlKey(item)));
      s16Only = rawS16.length ? rawS16 : cs.candidates.filter((item) => item.source === 's16');
    }
    if (preferS16 && !s16Only?.length) return { status: 'no-s16' };
    const s16Focus = preferS16 ? s16Only.slice(0, 3) : shouldPrioritizeS16(cs.candidates, state.history.groupShares);
    let promptCandidates = s16Focus || cs.candidates;
    if (s16Focus) log(`[inner] 本轮优先分享 S16（${s16Focus.length} 条候选）`);
    const output = await runTurn(curiosityPrompt(promptCandidates, { required: preferS16, target }), 180000);
    let share = parseShare(output, promptCandidates);
    if (!share && s16Focus && !preferS16) {
      log('[inner] S16 候选没选出来，改用全部候选再试一次');
      const fallback = await runTurn(curiosityPrompt(cs.candidates, { target }), 180000);
      const fallbackShare = parseShare(fallback, cs.candidates);
      if (fallbackShare) {
        share = fallbackShare;
        promptCandidates = cs.candidates;
      }
    }
    if (!dryRun) {
      state.counts.curiosity += 1;
      saveInner(state);
    }
    if (!share) {
      log('[inner] 这次没有值得分享的，跳过');
      return { status: 'skip' };
    }
    const shareTimeIssue = timeConflict(share.text);
    if (shareTimeIssue) {
      log(`[inner] 分享时间不一致（${shareTimeIssue}），重写一次`);
      const retry = await runTurn(curiosityPrompt(promptCandidates, { timeFix: shareTimeIssue, target }), 180000);
      const retryShare = parseShare(retry, promptCandidates);
      if (retryShare && !timeConflict(retryShare.text)) {
        share = retryShare;
      } else {
        log('[inner] 分享重写仍未解决时间问题，这次不发');
        return { status: 'time-conflict' };
      }
    }
    const toneIssue = shareToneIssue(share.text);
    if (toneIssue) {
      log(`[inner] 分享口吻不对（${toneIssue}），重写一次`);
      const retry = await runTurn(curiosityPrompt(promptCandidates, { required: preferS16, toneFix: toneIssue, target }), 180000);
      const retryShare = parseShare(retry, promptCandidates);
      if (retryShare && !timeConflict(retryShare.text) && !shareToneIssue(retryShare.text)) {
        share = retryShare;
      } else {
        log('[inner] 分享重写后口吻仍不对，这次不发');
        return { status: 'tone-conflict' };
      }
    }
    if (dryRun) {
      log(`[inner][dryRun] 分享预览：${share.text}`);
      return { status: 'dry-run', text: share.text };
    }
    const needsApproval = forceApproval || il.groupShare.requireApproval === true;
    if (needsApproval) {
      if (!cfg.ownerQQ) return { status: 'no-owner' };
      const timeoutMs = Math.max(60 * 1000, Number(il.approvalTimeoutMs) || 2 * 3600 * 1000);
      state.pendingShare = {
        text: share.text,
        target,
        item: share.item ? {
          url: String(share.item.url || ''),
          title: String(share.item.title || '').slice(0, 200),
          source: String(share.item.source || ''),
          publishedAt: Number(share.item.publishedAt) || 0
        } : null,
        createdAt: Date.now(),
        expiresAt: Date.now() + timeoutMs
      };
      saveInner(state);
      const timeoutMin = Math.round(timeoutMs / 60000);
      await sendOwner(`【群分享草稿】
目标：${target}
${share.text}${share.item?.url ? `

来源：${share.item.url}` : ''}

回复「发分享」发布，回复「不发分享」放弃；没有其他草稿时直接回「发」/「不发」也可以（${timeoutMin} 分钟内有效）。`);
      log(`[inner] 群分享草稿已发主人审核：${share.text.slice(0, 80)}`);
      return { status: 'pending-approval', text: share.text };
    }
    const sent = await sendGroupShare(target, share.text, share.item ? [share.item] : [], { force });
    if (sent && share.item) {
      markSeen(share.item);
      try {
        const cover = await buildVideoCover(share.item);
        if (cover) await imageLibrary.sendToKey(target, cover.id, { caption: '' });
      } catch (error) {
        log(`[inner] 分享配图发送失败（忽略）：${error?.message ?? error}`);
      }
    }
    return { status: sent ? 'shared' : 'not-sent', text: share.text };
  }

  async function runQzone(il, { force = false } = {}) {
    if (!il.qzone.enabled) return { status: 'disabled' };
    const state = loadInner();
    if (state.qzone.paused && !force) return { status: 'paused' };
    if (state.pendingDraft) {
      if (Date.now() < Number(state.pendingDraft.expiresAt || 0)) return { status: 'pending-approval' };
      // 过期草稿记入历史，避免下次生成相似内容
      state.history.qzonePosts.unshift({
        at: Number(state.pendingDraft.createdAt) || Date.now(),
        text: state.pendingDraft.text,
        image: state.pendingDraft.imageName || '',
        status: 'expired'
      });
      state.history.qzonePosts = state.history.qzonePosts.slice(0, 60);
      state.pendingDraft = null;
      saveInner(state);
    }
    if (!force && state.counts.qzone >= (Number(il.qzone.maxPerDay) || DEFAULTS.qzone.maxPerDay)) {
      return { status: 'daily-limit' };
    }
    if (!force && isQuiet(il)) return { status: 'quiet' };
    if (!force && state.lastQzoneAt && Date.now() - state.lastQzoneAt < (Number(il.qzone.minGapMs) || DEFAULTS.qzone.minGapMs)) {
      return { status: 'gap' };
    }
    if (!force && Math.random() < Math.max(0, Math.min(0.95, Number(il.qzone.skipProbability) || 0))) {
      log('[inner] 这次随缘跳过空间说说');
      return { status: 'skip-random' };
    }
    let cs = loadCuriosity();
    if (!cs.candidates.length) {
      try { cs = await refreshCandidates(il); } catch {}
    }
    const extraImages = [];
    let cover = null;
    let shot = null;
    try {
      cover = await buildVideoCover(cs.candidates[0]);
      if (cover) extraImages.push(cover);
      shot = await buildChatScreenshot(targetState(il)?.st?.recentMessages || []);
      if (shot) extraImages.push(shot);
    } catch (error) {
      log(`[inner] 空间配图准备失败（忽略）：${error?.message ?? error}`);
    }
    const seenImageIds = new Set();
    const images = [...extraImages, ...imageShortlist(8)]
      .filter((entry) => {
        if (!entry?.id || seenImageIds.has(entry.id)) return false;
        seenImageIds.add(entry.id);
        return true;
      })
      .slice(0, 8);
    const recentPosts = (state.history.qzonePosts || [])
      .filter((p) => p && p.text && ['posted', 'rejected', 'expired'].includes(p.status))
      .slice(0, 6);
    const style = qzoneStyleHint();
    // 模型有时会写 IMG: NONE，哪怕正文明显来自刚抓的视频封面或群聊片段。
    // 这里只做有依据的补图：正文与素材有 4 字以上重合才补，避免硬配。
    const pickGroundedImage = (postText, chosen) => {
      if (chosen || !images.length) return chosen;
      if (cover && cs.candidates.some((item) => sharesLongSegment(postText, item.title))) return cover;
      if (shot && postGroundedInChat(postText, targetState(il)?.st?.recentMessages || [])) return shot;
      return chosen;
    };
    const output = await runTurn(qzonePrompt(cs.candidates, images, { recentPosts, style }), 180000);
    let { text, image } = parseQzonePost(output, images);
    if (!text) {
      log('[inner] 空间说说内容为空/过长/含敏感信息，跳过');
      return { status: 'invalid' };
    }
    // 时间词和语气都可能出戏：先检查时间，再决定是否重写一次。
    const toneDry = recentPosts.length >= 2 && recentPosts.every((p) => !hasQzoneSoftTone(p.text)) && !hasQzoneSoftTone(text);
    const timeIssue = timeConflict(text);
    const toneIssue = shareToneIssue(text, { requireFirstPerson: false });
    if (timeIssue || toneDry || toneIssue) {
      const reason = timeIssue ? `时间不一致（${timeIssue}）` : toneIssue ? `口吻偏硬（${toneIssue}）` : '语气偏干';
      log(`[inner] 说说${reason}，重写一次`);
      const retry = await runTurn(qzonePrompt(cs.candidates, images, { recentPosts, style, strictTone: toneDry, timeFix: timeIssue, toneFix: toneIssue }), 180000);
      const retryParsed = parseQzonePost(retry, images);
      const retryTimeIssue = retryParsed.text ? timeConflict(retryParsed.text) : '重写结果无效';
      const retryToneIssue = retryParsed.text ? shareToneIssue(retryParsed.text, { requireFirstPerson: false }) : '';
      if (retryParsed.text && !retryTimeIssue && !retryToneIssue) {
        text = retryParsed.text;
        image = retryParsed.image;
      } else if (timeIssue || toneIssue) {
        log(`[inner] 重写仍没解决${timeIssue ? '时间' : '口吻'}问题（${retryTimeIssue || retryToneIssue}），这次不发说说`);
        return { status: timeIssue ? 'time-conflict' : 'tone-conflict' };
      } else {
        log('[inner] 空间重写结果仍无效，保留第一版');
      }
    }
    image = pickGroundedImage(text, image);
    // 这次没被选中的封面/截图不留在图库里，避免每次说说都堆积用不上的截图。
    for (const extra of [shot, cover]) {
      if (extra?.id && image?.id !== extra.id && typeof imageLibrary?.remove === 'function') {
        try { imageLibrary.remove(extra.id); } catch (error) { log(`[inner] 清理未用配图失败（忽略）：${error?.message ?? error}`); }
      }
    }
    // 发布前与最近的历史文案做去重比对（含被拒/过期的），避免重复发相似内容。
    if (isDuplicateQzoneText(text, state.history.qzonePosts)) {
      log(`[inner] 说说与近期内容重复，跳过：${text.slice(0, 60)}`);
      return { status: 'duplicate' };
    }
    const needsApproval = il.qzone.requireApproval !== false
      || (!state.qzone.auto && state.qzone.approvedCount < (Number(il.qzone.approvalFirst) || DEFAULTS.qzone.approvalFirst));
    if (needsApproval) {
      return await sendQzoneDraft(text, image);
    }
    return await postQzoneNow(text, { imageRef: image?.id || '' });
  }

  function aiTipsPrompt(il, { category, tips, recentChat = '', duplicateHint = '' }) {
    const target = aiTipTarget(il);
    const profile = target ? cfg.simulation?.groupProfiles?.[target] : null;
    const groupStyle = profile?.style ? `【本群风格（优先遵守）】\n${String(profile.style).trim()}\n\n` : '';
    const historyLines = tips.history.slice(0, 30).map((item, index) => {
      const label = categoryById(item.category)?.label || item.category || '';
      return `${index + 1}. ${label ? `[${label}] ` : ''}${cleanLine(item.title || item.topic, 30)}`;
    });
    const recentTexts = tips.history.slice(0, 6).map((item) => `- ${cleanLine(item.text, 70)}`);
    const extra = [
      groupStyle,
      `【这一期讲的方向】${category.label}：${category.hint}`,
      '【听众】爸爸、妈妈这样的长辈：完全不懂 AI，但生活经验很足，不喜欢听术语和空话。',
      historyLines.length ? `【已经讲过，绝对不能重复】\n${historyLines.join('\n')}` : '',
      recentTexts.length ? `【最近几期的原话（换个说法讲同一个点也算重复）】\n${recentTexts.join('\n')}` : '',
      recentChat ? `【最近家里群里在聊】\n${recentChat}` : '',
      duplicateHint ? `【上一次选题重复】${duplicateHint}。这次必须换一个更具体的知识点。` : ''
    ].filter(Boolean).join('\n\n');
    const maxChars = Math.max(200, Math.min(360, Number(il.aiTips.maxChars) || DEFAULTS.aiTips.maxChars));
    const bodyMax = Math.min(280, maxChars);
    const task = `你在家人群做一期 AI 小科普，讲给完全不懂 AI 的爸爸妈妈听。这不是你自己的发现，而是把一个技术讲明白、讲透一点。

正文必须包含这些信息，按顺序自然展开：
1. 一个具体的生活现象或例子；
2. 点名技术，给出准确名称，并用一句话说明它是什么；
3. 至少解释 2 个关键术语或环节（用大白话解释，例如“智能体、奖励、策略”“用户、物品、相似度”“词元、概率、上下文”）；
4. 说清实现流程：输入什么、中间怎么算或怎么训练、输出什么；
5. 最后讲它的边界、代价，或者为什么有时不准。

写作要求：
- 正文 200–${bodyMax} 字，5–7 个完整句子；用“因为/所以/简单说/具体做法是/举个例子/不过”这类连接，避免碎句，也不要一逗到底。
- 技术名和术语必须真的出现，不能只讲现象；术语第一次出现时用半句话解释。
- 可以用一个比喻，但比喻之后要回到技术本身，不能只讲比喻。
- 不用“我发现/我琢磨/我试过”，这是科普，不是个人体验。
- 不写产品说明书、不列操作步骤；不喊口号、不吓唬人、不绝对化。
- 不聊政治、宗教、医疗诊断、投资建议；举例不要提具体品牌。
- 选题要落在爸妈生活里能碰到的技术（推荐、语音、拍照、导航、客服、生成图片/文字），不要选过窄的学术子方向（如学习排序、对比学习、蒸馏变体）。
- 标题必须以技术名开头，用“技术名：一句话结论”或“技术名为什么……”的格式，总长 16 字以内；技术名只出现一次，不要写成“大语言模型：大模型：…”。例如“强化学习：靠输赢自己变强”“协同过滤：推荐为什么越刷越准”。不要“浅谈/科普/揭秘/一文读懂”，不要问句。
- techName：技术名本身，10 字以内，例如“强化学习”“协同过滤”“语音识别”。

再给图卡提供三点，必须是正文的压缩，不要新增内容：
- phenomenon：现象，18 字以内；
- tech：技术，24 字以内（技术名 + 一句它是什么）；
- how：实现，26 字以内（核心做法）。
- terms：正文里最关键的 2 个术语，每个给一句大白话解释（name ≤8 字，plain ≤18 字）。

再给两个检索字段：
- keyTerm：必须优先给一个明确、不歧义的英文术语/缩写（如 CF、OCR、ASR、RTB、A*、Dijkstra、overfitting）；缩写容易撞车时，在 searchQuery 里补一个中文领域词帮助区分；
- searchQuery：以英文术语开头，再接中文技术名和领域词 + 原理/实现，例如 "A* Dijkstra 路径规划 导航 原理"、"ASR 语音识别 声学模型 原理"、"RTB 实时竞价 广告 原理"。

风格示例（只学结构和深度，不要照抄）：
{"title":"协同过滤：推荐为什么越刷越准","techName":"协同过滤","phenomenon":"刷到的内容越来越像你爱看的","tech":"协同过滤：按相似的人找内容","how":"记行为算相似度，再把候选内容排序","terms":[{"name":"相似度","plain":"两个人爱看的东西有多像"},{"name":"用户—物品表","plain":"谁看过什么的一张记账表"}],"text":"刷手机时，推来的内容会越来越像你爱看的。这背后是推荐系统里的协同过滤，简单说就是借“相似的人喜欢什么”来猜你可能喜欢什么。具体做法是先把每个人的点击、停留记成一张用户—物品表，再算你和别人的相似度，或者算两件内容被同一批人喜欢的程度，然后把相近的人看过、你还没看的内容排到前面。它不需要看懂内容本身，所以新用户、新内容没有行为数据时最弱，只能先靠热门内容兜底。","keyTerm":"CF","searchQuery":"CF 协同过滤 推荐系统 原理"}

只输出一个 JSON 对象：{"topic":"给去重用的选题，不超过16字","category":"${category.id}","title":"技术名开头的标题","techName":"技术名","phenomenon":"现象","tech":"技术","how":"实现","terms":[{"name":"术语","plain":"大白话解释"}],"text":"正文","keyTerm":"检索关键词","searchQuery":"检索词"}`;
    return buildBasePrompt(task, extra, target, { digestText: '', topics: [], anchor: '' });
  }

  function formatAiTip(tip) {
    const title = cleanLine(tip?.title, 24);
    const body = cleanLine(tip?.text, 400);
    return title ? `${title}\n${body}` : body;
  }

  function formatAiTipMessage(tip) {
    const lines = [cleanLine(tip?.title, 24), '', cleanLine(tip?.text, 400)];
    const links = Array.isArray(tip?.links) ? tip.links.slice(0, 3) : [];
    if (links.length) {
      lines.push('', '延伸阅读：');
      links.forEach((link, index) => lines.push(`${index + 1}. ${cleanLine(link.title, 60)}`, link.url));
    }
    return lines.join('\n').trim();
  }

  async function findAiTipLinks(topic, searchQuery, keyTerm = '', techName = '') {
    const query = cleanLine(searchQuery, 80) || `${cleanLine(keyTerm || topic, 30)} 原理 实现`;
    try {
      // ChatAnywhere 的 grounding 链接是 vertexaisearch 跳转地址，无法直接给用户；
      // 延伸阅读固定走 Bing 的直链结果。
      const result = await webSearch(query, { root: process.cwd(), provider: 'bing' });
      const max = Number(ilCfg().aiTips.maxLinks) || 3;
      let links = pickTipLinks(result?.results || [], topic, { max, keyTerm, techName });
      const term = cleanLine(keyTerm, 30);
      // 中文技术名在 Bing 上经常只命中第一个词（“路径规划”→“路径”），补一条百度百科直链，
      // 并去掉同站里更泛的结果。
      if (term.length >= 2 && /[\u4e00-\u9fa5]/.test(term)) {
        const baike = `https://baike.baidu.com/item/${encodeURIComponent(term)}`;
        links = [{ title: `${term}_百度百科`, url: baike }, ...links.filter((link) => !link.url.includes('baike.baidu.com'))];
      }
      if (!links.length && techName) {
        if (/[\u4e00-\u9fa5]/.test(techName)) {
          links = [{ title: `${cleanLine(techName, 20)}_百度百科`, url: `https://baike.baidu.com/item/${encodeURIComponent(cleanLine(techName, 30))}` }];
        }
      }
      if (!links.length && techName) {
        // 小众技术词在 Bing 上经常搜不到可核验的文章；给一个真实可用的知乎站内检索页兜底，
        // 至少不让延伸阅读为空，也不编造文章链接。
        const q = encodeURIComponent(`${techName} 原理 入门`);
        links = [{ title: `知乎：${cleanLine(techName, 20)} 相关讨论`, url: `https://www.zhihu.com/search?type=content&q=${q}` }];
      }
      return links.slice(0, max);
    } catch (error) {
      log(`[inner] AI小知识延伸阅读检索失败（不影响发送）：${error?.message ?? error}`);
      return [];
    }
  }

  async function fetchWebIllustrations(links) {
    if (ilCfg().aiTips.webImages === false) return [];
    const out = [];
    const seen = new Set();
    const skipHosts = ['zhihu.com', 'baike.baidu.com', 'github.com', 'youtube.com', 'bilibili.com', 'adjust.com', 'amazon.com'];
    for (const link of (Array.isArray(links) ? links : []).slice(0, 3)) {
      let host = '';
      try { host = new URL(link.url).hostname.replace(/^www\./, ''); } catch { continue; }
      if (skipHosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
      try {
        const page = await safeFetch(link.url, 700000);
        if (!page || page.statusCode >= 400 || !page.body) continue;
        const imgUrl = pickArticleImageUrl(page.body, link.url);
        if (!imgUrl || seen.has(imgUrl)) continue;
        const img = await safeFetchBuffer(imgUrl, 8 * 1024 * 1024);
        if (!img?.buffer || img.buffer.length < 25000 || img.buffer.length > 1.2 * 1024 * 1024) continue;
        const mime = imageMimeFromBuffer(img.buffer);
        if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) continue;
        seen.add(imgUrl);
        out.push({ buffer: img.buffer, mimeType: mime, host, pageUrl: link.url });
        if (out.length >= 2) break;
      } catch (error) {
        log(`[inner] AI小知识网图抓取失败（换下一张/框图）：${error?.message ?? error}`);
      }
    }
    return out;
  }

  async function buildAiTipCard({ title, phenomenon, tech, how, terms = [] }) {
    const browser = chromeBinary();
    if (!browser) return null;
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    if (!phenomenon || !tech || !how) return null;
    const termList = (Array.isArray(terms) ? terms : []).filter((t) => t?.name && t?.plain).slice(0, 2);
    const termsHtml = termList.map((t) => `<div class="term"><b>${esc(t.name)}</b><p>${esc(t.plain)}</p></div>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{margin:0;padding:0}
      body{width:1080px;min-height:660px;background:#eef3f8;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#0f172a}
      .card{position:relative;width:1080px;min-height:660px;padding:46px 56px 70px;background:
        radial-gradient(circle at 1px 1px, rgba(15,23,42,.055) 1px, transparent 0) 0 0/18px 18px,
        linear-gradient(180deg,#ffffff 0%,#f8fbfd 100%);border-top:8px solid #0f766e;overflow:hidden}
      .kicker{font-size:14px;letter-spacing:6px;color:#0f766e;font-weight:700}
      h1{margin:14px 0 0;font-size:42px;line-height:1.25;letter-spacing:.5px;max-width:900px;font-weight:800}
      .sub{margin-top:10px;font-size:19px;color:#64748b}
      .main{display:grid;grid-template-columns:1.4fr .8fr;gap:30px;margin-top:28px;align-items:start}
      .steps{display:flex;flex-direction:column;gap:14px}
      .step{background:#f1f5f9;border-radius:14px;padding:15px 20px;border-left:6px solid #0f766e}
      .step.s2{border-left-color:#d97706;background:#fffbeb}
      .step.s3{border-left-color:#7c3aed;background:#f5f3ff}
      .tag{display:block;font-size:12px;letter-spacing:4px;color:#64748b;font-weight:700}
      .txt{margin-top:6px;font-size:23px;line-height:1.35;font-weight:700;word-break:break-word}
      .terms{background:#0f172a;color:#eef4ff;border-radius:18px;padding:22px 24px;min-height:280px}
      .terms h2{margin:0;font-size:13px;letter-spacing:5px;color:#5eead4;font-weight:700}
      .term{margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.1)}
      .term b{font-size:19px}
      .term p{margin:7px 0 0;font-size:14px;line-height:1.55;color:#cbd5e1}
      .foot{position:absolute;left:56px;bottom:24px;font-size:13px;color:#94a3b8}
      .foot b{color:#0f766e;font-weight:700}
    </style><div class="card">
      <div class="kicker">AI 小知识</div>
      <h1>${esc(title)}</h1>
      <div class="sub">用通俗的话，把技术讲透</div>
      <div class="main">
        <div class="steps">
          <div class="step s1"><span class="tag">现象</span><div class="txt">${esc(phenomenon)}</div></div>
          <div class="step s2"><span class="tag">技术</span><div class="txt">${esc(tech)}</div></div>
          <div class="step s3"><span class="tag">实现</span><div class="txt">${esc(how)}</div></div>
        </div>
        <div class="terms"><h2>关键术语</h2>${termsHtml || '<div class="term"><b>术语</b><p>正文里有解释</p></div>'}</div>
      </div>
      <div class="foot"><b>小鲸鱼</b> · 讲给爸爸妈妈的 AI 小知识</div>
    </div>`;
    const stamp = `${process.pid}-${Date.now()}`;
    const htmlPath = path.join(stateDir, `ai-tip-${stamp}.html`);
    const pngPath = path.join(stateDir, `ai-tip-${stamp}.png`);
    const profileDir = path.join(stateDir, `chrome-tip-${stamp}`);
    try {
      fs.writeFileSync(htmlPath, html, 'utf8');
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      execFileSync(browser, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${profileDir}`, '--window-size=1080,660',
        `--screenshot=${pngPath}`, pathToFileURL(htmlPath).href
      ], { timeout: 30000, env, stdio: 'ignore' });
      if (!fs.existsSync(pngPath)) return null;
      const buffer = fs.readFileSync(pngPath);
      return buffer.length > 1000 ? buffer : null;
    } catch (error) {
      log(`[inner] AI小知识图卡生成失败：${error?.message ?? error}`);
      return null;
    } finally {
      try { fs.rmSync(htmlPath, { force: true }); } catch {}
      try { fs.rmSync(pngPath, { force: true }); } catch {}
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    }
  }

  async function sendAiTipImage(key, imageOrImages, tip, { caption = '' } = {}) {
    const list = (Array.isArray(imageOrImages) ? imageOrImages : [imageOrImages]).filter(Boolean).slice(0, 3);
    if (!list.length || !imageLibrary || typeof imageLibrary.sendToKey !== 'function') return false;
    const entries = [];
    for (const image of list) {
      const entry = addShareImage({
        buffer: image,
        name: 'AI小知识配图',
        note: `${cleanLine(tip?.title, 30)}（AI 小知识）`,
        tags: ['AI小知识', '科普', '配图'],
        sourceUrl: ''
      });
      if (entry?.id) entries.push(entry.id);
    }
    if (!entries.length) return false;
    try {
      if (typeof imageLibrary.sendManyToKey === 'function') {
        await imageLibrary.sendManyToKey(key, entries, { caption: String(caption || '').trim().slice(0, 900) });
      } else {
        await imageLibrary.sendToKey(key, entries[0], { caption: String(caption || '').trim().slice(0, 900) });
        for (const id of entries.slice(1)) await imageLibrary.sendToKey(key, id, { caption: '' });
      }
      return true;
    } catch (error) {
      log(`[inner] AI小知识配图发送失败：${error?.message ?? error}`);
      return false;
    } finally {
      for (const id of entries) {
        try { imageLibrary.remove?.(id); } catch {}
      }
    }
  }

  async function sendAiTipCard(key, card, tip) {
    return sendAiTipImage(key, card, tip, { caption: '' });
  }

  function crossModuleRecentUrls(state) {
    const set = new Set();
    for (const mod of Object.values(state?.modules || {})) {
      for (const url of recentShareUrls(mod?.history || [])) set.add(url);
    }
    return set;
  }

  function normShareUrl(url) {
    return String(url || '').trim().split('#')[0].replace(/\/+$/, '').toLowerCase();
  }

  /** facet 的 source.mode 含 pool 时，从现有候选池（B站/RSS/S16/搜索）取素材并做跨模块去重。 */
  async function sharePoolCandidates(facet, moduleState, state, { force = false } = {}) {
    const mode = String(facet.source?.mode || '');
    if (!mode.includes('pool')) return [];
    const il = ilCfg();
    const cs = await refreshCandidates(il, { force });
    let pool = Array.isArray(cs.candidates) ? cs.candidates.slice() : [];
    const only = String(facet.source?.onlySource || '');
    if (only === 's16') {
      const extra = Array.isArray(cs.s16Candidates) ? cs.s16Candidates : [];
      pool = (extra.length ? extra : pool.filter((item) => item.source === 's16')).slice();
    } else if (only) {
      pool = pool.filter((item) => item.source === only);
    }
    const cross = crossModuleRecentUrls(state);
    return pool.filter((item) => item?.url && !urlAlreadyShared(item.url, cross) && !urlAlreadyShared(item.url, moduleState.history));
  }

  async function runShareModule(moduleId, { force = false, dryRun = false, ignoreGuards = false, facetId = '', withImages = true, categoryId = '' } = {}) {
    const conf = shareModulesConfig();
    const module = conf.modules[moduleId];
    if (!module) return { status: 'unknown-module' };
    const state = loadShareModulesState();
    const m = state.modules[moduleId];
    if (!m) return { status: 'unknown-module' };
    if (!hasEngineFacets(module)) return { status: 'legacy-runtime' };
    if (!module.enabled && !force) return { status: 'disabled' };
    if (m.paused && !force) return { status: 'paused' };
    if (m.pending) {
      if (Date.now() > Number(m.pending.expiresAt || 0)) {
        m.pending = null;
        saveShareModulesState(state);
      } else if (!force) {
        return { status: 'pending-approval' };
      }
    }
    if (!ignoreGuards) {
      if (isQuiet(ilCfg()) && !force) return { status: 'quiet' };
      if (!isSessionAllowedInCurrentMode(module.targets[0]) && !force) return { status: 'mode' };
    }
    if (!m.dailyTarget) m.dailyTarget = moduleDayTarget(module);
    if (!force && m.sentToday >= m.dailyTarget) return { status: 'daily-done' };

    const ordered = module.targets.length
      ? (module.rotateTargets
        ? [...module.targets].sort((a, b) => (Number(state.groups?.[a]?.lastAt) || 0) - (Number(state.groups?.[b]?.lastAt) || 0))
        : module.targets)
      : [];
    let target = '';
    let budget = { ok: false, reason: 'no-target' };
    for (const key of ordered) {
      const check = groupBudgetCheck(state, key, Date.now(), conf.limits);
      if (check.ok) { target = key; budget = check; break; }
      budget = check;
    }
    if (!target && !ignoreGuards) return { status: 'budget', ...budget };
    if (!target && ignoreGuards) {
      // 预览/手动强制：预算不满足时仍然选第一个目标，只做内容预览，不发送。
      target = ordered[0] || '';
      budget = { ok: false, reason: 'ignored-for-preview' };
    }
    if (!target) return { status: 'no-target' };

    const engineList = engineFacets(module);
    const facet = (facetId && engineList.find((item) => item.id === facetId))
      || ((ignoreGuards || force) && engineList[0])
      || pickShareFacet(module, m, Date.now());
    if (!facet) return { status: 'no-facet' };

    let category = null;
    const categorySet = facet.content?.categorySet || module.content?.categorySet;
    if (categorySet === 'ai-tips') {
      const histCats = m.history.map((item) => ({ category: item.category })).filter((item) => item.category);
      category = pickCategory(histCats);
    } else if (Array.isArray(facet.categories) && facet.categories.length) {
      const used = new Set(m.history.map((item) => item.category).filter(Boolean));
      const pool = facet.categories.filter((item) => !used.has(item.id));
      const list = pool.length ? pool : facet.categories;
      category = list[Math.floor(Math.random() * list.length)];
    }
    if (categoryId) {
      const pool = categorySet === 'ai-tips' ? AI_TIP_CATEGORIES : (facet.categories || []);
      category = pool.find((item) => item.id === categoryId) || category;
    }

    let candidateList = [];
    if (String(facet.source?.mode || '').includes('pool')) {
      try {
        candidateList = await sharePoolCandidates(facet, m, state, { force: force || dryRun });
      } catch (error) {
        log(`[share:${moduleId}] 候选抓取失败：${error?.message ?? error}`);
        recordModuleFailure(state, moduleId, facet.id, Date.now(), error?.message ?? String(error));
      }
      if (!candidateList.length) {
        if (!dryRun) {
          m.nextAt = Date.now() + rand(20 * 60 * 1000, 45 * 60 * 1000);
          saveShareModulesState(state);
        }
        log(`[share:${moduleId}] 候选池没有新素材（或都发过了），稍后再试`);
        return { status: 'no-candidates' };
      }
    }

    let recentChat = '';
    try { recentChat = digest(getSimulationState(target), 8).slice(0, 700); } catch {}

    let parsed = null;
    let chosenCandidate = null;
    let lastError = '';
    let duplicateWith = '';
    let fixHint = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let output = '';
      try {
        const task = buildShareTask({ module, facet, history: m.history, recentChat, duplicateHint: duplicateWith, category, candidates: candidateList, fixHint });
        const extra = [
          shareGroupStyle(target),
          facet.prompt ? String(facet.prompt) : '',
          module.content?.customInstruction && !task.includes(module.content.customInstruction) ? String(module.content.customInstruction) : ''
        ].filter(Boolean).join('\n\n');
        output = await runTurn(buildBasePrompt(task, extra, target, { digestText: '', topics: [], anchor: '' }), 150000);
      } catch (error) {
        lastError = error?.message ?? String(error);
        continue;
      }
      const raw = parseShareOutput(output);
      if (!raw.ok) {
        lastError = raw.error;
        log(`[share:${moduleId}] 输出无效（${raw.error}），重试`);
        continue;
      }
      if (raw.value?.skip === true) {
        lastError = 'skip';
        continue;
      }
      const validated = validateShareOutput(facet.template, raw.value, module, facet);
      if (!validated.ok) {
        lastError = validated.error;
        log(`[share:${moduleId}] 校验失败（${validated.error}），重试`);
        continue;
      }
      const value = validated.value;
      value.topic = value.title || value.text.slice(0, 20);
      let chosen = null;
      if (candidateList.length) {
        const urls = [...extractUrls(value.text), ...extractUrls(value.sourceUrl || '')].map(normShareUrl).filter(Boolean);
        chosen = candidateList.find((item) => urls.includes(normShareUrl(item.url))) || null;
        if (!chosen && value.sourceUrl) {
          chosen = candidateList.find((item) => normShareUrl(item.url) === normShareUrl(value.sourceUrl)) || null;
          if (chosen && !urls.includes(normShareUrl(chosen.url))) value.text = `${value.text}\n${chosen.url}`;
        }
        if (!chosen) {
          lastError = 'no-source-link';
          fixHint = '上一版没有带上候选链接。正文最后要单独一行原样写上选中的候选链接。';
          log(`[share:${moduleId}] 正文没有引用候选链接，重试；上版输出：${String(output).replace(/\s+/g, ' ').slice(0, 160)}`);
          continue;
        }
        value.sourceUrl = value.sourceUrl || chosen.url;
      }
      const dup = isDuplicateTip({ topic: value.topic, text: value.text }, m.history);
      if (dup.duplicate) {
        duplicateWith = dup.with || value.topic;
        lastError = `duplicate:${dup.reason}`;
        continue;
      }
      if (value.sourceUrl && urlAlreadyShared(value.sourceUrl, m.history)) {
        lastError = 'duplicate:url';
        continue;
      }
      if (candidateList.length) {
        const toneIssue = shareToneIssue(value.text);
        const timeIssue = timeConflict(value.text);
        if (toneIssue || timeIssue) {
          lastError = toneIssue ? 'tone' : 'time';
          if (attempt === 0) {
            fixHint = [toneIssue ? `口吻：${toneIssue}` : '', timeIssue ? `时间：${timeIssue}` : ''].filter(Boolean).join('；');
            log(`[share:${moduleId}] 口吻/时间不对（${fixHint}），重写一次`);
            continue;
          }
          log(`[share:${moduleId}] 重写后仍不合格，这次不发`);
          break;
        }
      }
      parsed = value;
      chosenCandidate = chosen;
      break;
    }
    if (!parsed) {
      if (!dryRun) {
        recordModuleFailure(state, moduleId, facet.id, Date.now(), lastError);
        m.nextAt = Date.now() + rand(30 * 60 * 1000, 90 * 60 * 1000);
        saveShareModulesState(state);
      }
      return { status: duplicateWith ? 'duplicate' : (lastError === 'tone' ? 'tone-conflict' : (lastError === 'time' ? 'time-conflict' : 'invalid')), error: lastError };
    }

    let links = [];
    const linksEnabled = module.links?.enabled !== false && facet.links?.enabled !== false;
    if (linksEnabled && facet.template !== 'fun') {
      if (parsed.sourceUrl) {
        links = [{ title: parsed.title || '来源', url: parsed.sourceUrl }];
      } else if (facet.template !== 'news' && facet.template !== 'data' && facet.template !== 'story') {
        links = await findShareLinks({
          keyTerm: parsed.keyTerm,
          searchQuery: parsed.searchQuery,
          techName: parsed.techName || parsed.title,
          max: Number(module.links?.max) || 3,
          enabled: true
        });
      }
    }
    if (facet.template === 'news' && parsed.sourceUrl && !links.length) links = [{ title: parsed.title || '来源', url: parsed.sourceUrl }];

    const media = withImages
      ? await buildShareImages(module, facet, parsed, links)
      : { images: [], imageSource: '', imageHosts: '' };
    if (dryRun) {
      return {
        status: 'dryRun',
        moduleId,
        facetId: facet.id,
        facetLabel: facet.label,
        category: category?.id || '',
        categoryLabel: category?.label || '',
        ...parsed,
        links,
        ...media
      };
    }
    if (verificationPending(module, m)) {
      return queueShareDraft(module, facet, state, { target, parsed, links, ...media });
    }
    const caption = formatShareCaption(parsed, facet?.template || module.template);
    let imageSent = false;
    if (media.images.length) imageSent = await sendAiTipImage(target, media.images, parsed, { caption });
    if (!imageSent) {
      try {
        await sendToQQ(target, caption);
      } catch (error) {
        recordModuleFailure(state, moduleId, facet.id, Date.now(), error?.message ?? String(error));
        saveShareModulesState(state);
        return { status: 'send-failed', error: error?.message ?? String(error) };
      }
      if (lastSendSucceeded && lastSendSucceeded(target) === false) {
        recordModuleFailure(state, moduleId, facet.id, Date.now(), 'send failed');
        saveShareModulesState(state);
        return { status: 'send-failed' };
      }
    }
    const linksText = formatShareLinksText(links, { imageHosts: imageSent ? media.imageHosts : '', sourceUrl: parsed.sourceUrl });
    if (linksText && facet.template !== 'fun') await sendToQQ(target, linksText);
    if (chosenCandidate) {
      try { markSeen(chosenCandidate); } catch {}
      try {
        const cover = await buildVideoCover(chosenCandidate);
        if (cover) await imageLibrary.sendToKey(target, cover.id, { caption: '' });
      } catch (error) {
        log(`[share:${moduleId}] 分享配图发送失败（忽略）：${error?.message ?? error}`);
      }
    }
    recordGroupSend(state, target, Date.now());
    recordModuleSend(state, moduleId, facet.id, Date.now(), {
      ...parsed,
      url: chosenCandidate?.url || parsed.sourceUrl || '',
      source: chosenCandidate?.source || '',
      category: category?.id || '',
      links,
      imageSource: imageSent ? media.imageSource : '',
      imageHosts: imageSent ? media.imageHosts : ''
    });
    m.nextAt = nextShareModuleAt(module, m, Date.now());
    saveShareModulesState(state);
    if (appendActivity) {
      try { appendActivity(`${target} [share:${moduleId}] ${caption.slice(0, 120)}`); } catch {}
    }
    log(`[share:${moduleId}] 已发到 ${target}（${facet.label}，链接 ${links.length} 条，配图 ${imageSent ? media.imageSource : '无'}）：${parsed.title || parsed.text.slice(0, 40)}`);
    return { status: 'sent', moduleId, facetId: facet.id, target, title: parsed.title, text: parsed.text, links, image: imageSent, imageSource: media.imageSource, sourceUrl: parsed.sourceUrl || '' };
  }

  async function runAiTip(il, { force = false, dryRun = false, ignoreGuards = false, categoryId = '', withCard = true } = {}) {
    const result = await runShareModule('ai_tips', { force, dryRun, ignoreGuards, withImages: withCard, categoryId });
    if (result.status === 'dryRun') {
      const card = result.imageSource === 'card' ? (result.images || [])[0] || null : null;
      return { ...result, card, image: (result.images || [])[0] || null };
    }
    return result;
  }

  async function runAiTipLegacy(il, { force = false, dryRun = false, ignoreGuards = false, categoryId = '', withCard = true } = {}) {
    const target = aiTipTarget(il);
    if (!il.aiTips.enabled && !force) return { status: 'disabled' };
    if (!target) return { status: 'no-target' };
    const tips = loadAiTips();
    if (!ignoreGuards) {
      if (tips.paused && !force) return { status: 'paused' };
      if (isQuiet(il) && !force) return { status: 'quiet' };
      const startHour = Number(il.aiTips.windowStartHour) || DEFAULTS.aiTips.windowStartHour;
      const endHour = Number(il.aiTips.windowEndHour) || DEFAULTS.aiTips.windowEndHour;
      if (!force && !inWindow(Date.now(), startHour, endHour)) return { status: 'outside-window' };
      try {
        if (!isSessionAllowedInCurrentMode(target)) return { status: 'mode' };
      } catch {
        return { status: 'mode' };
      }
    }
    const min = Number(il.aiTips.minPerDay ?? DEFAULTS.aiTips.minPerDay);
    const max = Number(il.aiTips.maxPerDay ?? DEFAULTS.aiTips.maxPerDay);
    if (!tips.dailyTarget) tips.dailyTarget = rollDailyTarget(min, max);
    if (!dryRun && !force && tips.sentToday >= tips.dailyTarget) return { status: 'daily-done', sentToday: tips.sentToday, dailyTarget: tips.dailyTarget };

    let recentChat = '';
    try { recentChat = digest(getSimulationState(target), 8).slice(0, 700); } catch {}
    const maxChars = Math.max(200, Math.min(360, Number(il.aiTips.maxChars) || DEFAULTS.aiTips.maxChars));
    let category = (categoryId && categoryById(categoryId)) || pickCategory(tips.history);
    let lastError = '';
    let duplicateWith = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt === 1) {
        const idx = AI_TIP_CATEGORIES.findIndex((c) => c.id === category.id);
        category = AI_TIP_CATEGORIES[(idx + 1 + rand(0, AI_TIP_CATEGORIES.length - 2)) % AI_TIP_CATEGORIES.length];
      }
      let output = '';
      try {
        output = await runTurn(aiTipsPrompt(il, { category, tips, recentChat, duplicateHint: duplicateWith }), 150000);
      } catch (error) {
        lastError = error?.message ?? String(error);
        continue;
      }
      const parsed = parseTipOutput(output, { maxChars });
      if (!parsed.ok) {
        lastError = parsed.error;
        log(`[inner] AI小知识输出无效（${parsed.error}），重试`);
        continue;
      }
      if (parsed.text.length < 180) {
        lastError = 'too-shallow';
        log(`[inner] AI小知识正文太短（${parsed.text.length} 字），要求讲深一点后重试`);
        continue;
      }
      if (!parsed.techName || !parsed.text.toLowerCase().includes(parsed.techName.toLowerCase())) {
        lastError = 'missing-tech-name';
        log(`[inner] AI小知识正文没有点到技术名（${parsed.techName || '空'}），重试`);
        continue;
      }
      if (!Array.isArray(parsed.terms) || parsed.terms.length < 2) {
        lastError = 'missing-terms';
        log('[inner] AI小知识缺少关键术语解释，重试');
        continue;
      }
      if (!parsed.title.toLowerCase().startsWith(parsed.techName.toLowerCase())) {
        const rest = parsed.title.includes('：') ? parsed.title.slice(parsed.title.indexOf('：') + 1).trim() : parsed.title;
        parsed.title = `${parsed.techName}：${rest}`.slice(0, 20);
      } else {
        // 模型可能写成“大语言模型：大模型：…”，保留技术名，只留最后一个冒号后的结论。
        const after = parsed.title.slice(parsed.techName.length).replace(/^[:：]\s*/, '');
        if (/[:：]/.test(after)) {
          parsed.title = `${parsed.techName}：${after.split(/[:：]/).pop().trim()}`.slice(0, 20);
        }
      }
      const titleBody = parsed.title.replace(parsed.techName, '').replace(/[：:]/g, '').trim();
      if (titleBody.length < 3) {
        lastError = 'bad-title';
        log(`[inner] AI小知识标题无效（${parsed.title}），重试`);
        continue;
      }
      const dup = isDuplicateTip({ topic: parsed.topic, text: parsed.text }, tips.history);
      if (dup.duplicate) {
        duplicateWith = dup.with || parsed.topic;
        lastError = `duplicate:${dup.reason}`;
        log(`[inner] AI小知识选题重复（${dup.reason}：${duplicateWith}），换一个方向`);
        continue;
      }
      if (!parsed.phenomenon || !parsed.tech || !parsed.how) {
        lastError = 'missing-card-points';
        log('[inner] AI小知识缺少图卡三点，重试');
        continue;
      }
      const links = il.aiTips.links === false ? [] : await findAiTipLinks(parsed.topic, parsed.searchQuery, parsed.keyTerm, parsed.techName);
      const webImages = il.aiTips.images !== false ? await fetchWebIllustrations(links) : [];
      const card = withCard && il.aiTips.images !== false ? await buildAiTipCard(parsed) : null;
      const images = [];
      if (webImages.length) {
        images.push(...webImages.map((item) => item.buffer));
        if (webImages.length === 1 && card) images.push(card);
      } else if (card) {
        images.push(card);
      }
      const imageSource = webImages.length ? 'web' : (card ? 'card' : '');
      const imageHosts = [...new Set(webImages.map((item) => item.host).filter(Boolean))].join(', ');
      if (dryRun || il.dryRun) {
        return {
          status: 'dryRun',
          topic: parsed.topic,
          title: parsed.title,
          techName: parsed.techName,
          category: category.id,
          categoryLabel: category.label,
          text: parsed.text,
          phenomenon: parsed.phenomenon,
          tech: parsed.tech,
          how: parsed.how,
          terms: parsed.terms,
          links,
          card,
          images,
          imageSource,
          imageHosts
        };
      }
      const caption = formatTipCaption(parsed);
      let imageSent = false;
      if (images.length) imageSent = await sendAiTipImage(target, images, parsed, { caption });
      if (!imageSent) {
        try {
          await sendToQQ(target, caption);
        } catch (error) {
          return { status: 'send-failed', error: error?.message ?? String(error), topic: parsed.topic, title: parsed.title, text: parsed.text, links };
        }
        if (lastSendSucceeded && lastSendSucceeded(target) === false) {
          return { status: 'send-failed', error: 'send failed', topic: parsed.topic, title: parsed.title, text: parsed.text, links };
        }
      }
      const linksText = formatAiTipLinks(links, imageSent ? imageHosts : '');
      if (linksText) await sendToQQ(target, linksText);
      tips.sentToday += 1;
      tips.lastSentAt = Date.now();
      tips.lastCategory = category.id;
      tips.history.unshift({
        at: tips.lastSentAt,
        topic: parsed.topic,
        title: parsed.title,
        techName: parsed.techName,
        category: category.id,
        text: parsed.text,
        phenomenon: parsed.phenomenon,
        tech: parsed.tech,
        how: parsed.how,
        terms: parsed.terms,
        links,
        hasImage: imageSent,
        imageSource: imageSent ? imageSource : '',
        imageHosts: imageSent ? imageHosts : ''
      });
      tips.history = tips.history.slice(0, Math.max(50, Number(il.aiTips.maxHistory) || DEFAULTS.aiTips.maxHistory));
      saveAiTips(tips);
      if (appendActivity) {
        try { appendActivity(`${target} [inner] AI小知识：${formatAiTipMessage({ ...parsed, links }).slice(0, 120)}`); } catch {}
      }
      log(`[inner] AI小知识已发到 ${target}（${category.label}，${parsed.techName}，链接 ${links.length} 条，配图 ${imageSent ? imageSource : '无'}）：${parsed.title}`);
      return { status: 'sent', topic: parsed.topic, title: parsed.title, techName: parsed.techName, category: category.id, categoryLabel: category.label, text: parsed.text, links, image: imageSent, imageSource };
    }
    return { status: duplicateWith ? 'duplicate' : 'invalid', error: lastError };
  }

  async function previewAiTips(count = 3) {
    const il = ilCfg();
    const tips = loadAiTips();
    const n = Math.max(1, Math.min(5, Number(count) || 3));
    const start = pickCategory(tips.history);
    const startIdx = Math.max(0, AI_TIP_CATEGORIES.findIndex((c) => c.id === start.id));
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const category = AI_TIP_CATEGORIES[(startIdx + i) % AI_TIP_CATEGORIES.length];
      const result = await runAiTip(il, { force: true, dryRun: true, ignoreGuards: true, categoryId: category.id });
      if (result.status !== 'dryRun') continue;
      const duplicate = out.some((item) => isDuplicateTip({ topic: result.topic, text: result.text }, [{ topic: item.topic, text: item.text }]).duplicate);
      if (duplicate) continue;
      out.push(result);
    }
    return out;
  }

  async function previewAiTipsToOwner(count = 3) {
    const list = await previewAiTips(count);
    if (!list.length) {
      await sendOwner('这次预览没生成出来，等会儿再试。');
      return { status: 'empty' };
    }
    const state = loadAiTips();
    state.lastPreview = {
      at: Date.now(),
      items: list.map((item) => ({
        at: Date.now(),
        title: item.title,
        topic: item.topic,
        techName: item.techName || '',
        category: item.category,
        categoryLabel: item.categoryLabel,
        text: item.text,
        phenomenon: item.phenomenon,
        tech: item.tech,
        how: item.how,
        terms: item.terms || [],
        links: item.links || [],
        imageSource: item.imageSource || '',
        imageHosts: item.imageHosts || '',
        imageCount: Array.isArray(item.images) ? item.images.length : 0
      }))
    };
    saveAiTips(state);
    if (list.length === 1) {
      const item = list[0];
      const caption = `【预览·未发群】
${formatTipCaption(item)}`;
      const okImage = item.images?.length ? await sendAiTipImage(`private:${cfg.ownerQQ}`, item.images, item, { caption }) : false;
      if (!okImage) await sendOwner(caption);
      const linksText = formatAiTipLinks(item.links, okImage ? item.imageHosts || '' : '');
      if (linksText) await sendOwner(linksText);
      await sendOwner('回「用第1种」发到群里，或直接说哪里不对。');
      return { status: 'ok', count: 1 };
    }
    const body = list.map((item, index) => {
      const links = (item.links || []).map((link, i) => `   ${i + 1}) ${link.title} ${link.url}`).join('\n');
      return `${index + 1}. [${item.categoryLabel}] ${item.title}\n${item.text}${links ? `\n  延伸阅读：\n${links}` : ''}`;
    }).join('\n\n');
    await sendOwner(`【AI小知识预览 · 还没发群】\n${body}\n\n回「用第1/2/3种」或直接说哪里不对，我再改。`);
    for (const item of list) {
      if (!item.images?.length) continue;
      await sendAiTipImage(`private:${cfg.ownerQQ}`, item.images, item, { caption: '' });
    }
    return { status: 'ok', count: list.length };
  }

  function advanceNext(state, name, il, result = {}) {
    const now = Date.now();
    if (name === 'curiosity' || name === 'qzone') delete state.quotaWait[name];
    if (name === 'reflection') {
      state.reflectionMaxMs = reflectionInterval(il).max;
      if (result?.status === 'error') state.next.reflection = now + rand(30 * 60 * 1000, 2 * 3600 * 1000);
      else if (result?.status === 'skip' || result?.status === 'invalid') state.next.reflection = now + rand(60 * 60 * 1000, 3 * 3600 * 1000);
      else state.next.reflection = nextReflectionAt(il, now);
    } else if (name === 'curiosity') {
      if (state.pendingShare) {
        // 等主人审核期间不要继续生成新的分享草稿。
        state.next.curiosity = now + Math.min(2 * 3600 * 1000, Math.max(10 * 60 * 1000, Number(state.pendingShare.expiresAt || now) - now));
      } else if (state.counts.curiosity >= (Number(il.curiosity.maxPerDay) || DEFAULTS.curiosity.maxPerDay)) {
        state.next.curiosity = nextTomorrowMorning(il);
        state.quotaWait.curiosity = { day: state.day, at: state.next.curiosity, limit: Number(il.curiosity.maxPerDay) || DEFAULTS.curiosity.maxPerDay };
      } else if (isQuiet(il)) {
        state.next.curiosity = nextQuietEnd(il, now);
      } else if (result?.status === 'not-sent') {
        // 群里刚有人说话 / 安静窗口不满足：不是没内容可分享，过一会儿再试。
        state.next.curiosity = now + rand(20 * 60 * 1000, 45 * 60 * 1000);
      } else if (state.counts.groupShare < (Number(il.curiosity.minPerDay) || DEFAULTS.curiosity.minPerDay)) {
        // 还没达到“每天至少分享几条”的软目标，缩短间隔，避免一天只试一次就结束。
        state.next.curiosity = now + rand(30 * 60 * 1000, 90 * 60 * 1000);
      } else {
        state.next.curiosity = now + rand(60 * 60 * 1000, 3 * 60 * 60 * 1000);
      }
    } else if (name === 'qzone') {
      if (state.pendingDraft) {
        state.next.qzone = now + Math.min(2 * 3600 * 1000, Math.max(5 * 60 * 1000, Number(state.pendingDraft.expiresAt || now) - now));
      } else if (state.counts.qzone >= (Number(il.qzone.maxPerDay) || DEFAULTS.qzone.maxPerDay)) {
        state.next.qzone = nextTomorrowMorning(il);
        state.quotaWait.qzone = { day: state.day, at: state.next.qzone, limit: Number(il.qzone.maxPerDay) || DEFAULTS.qzone.maxPerDay };
      } else if (result?.status === 'error' || result?.status === 'invalid') {
        // 模型回合失败/产出无效不该等满 5 小时；尽快重试一次，避免“看起来彻底不发”。
        state.next.qzone = now + rand(30 * 60 * 1000, 90 * 60 * 1000);
      } else if (result?.status === 'skip-random') {
        state.next.qzone = now + rand(45 * 60 * 1000, 2 * 3600 * 1000);
      } else if (result?.status === 'duplicate') {
        // 内容与近期重复：等久一些再试，让模型拿到更多新素材
        state.next.qzone = now + rand(2 * 3600 * 1000, 5 * 3600 * 1000);
      } else if (isQuiet(il)) {
        state.next.qzone = nextQuietEnd(il, now);
      } else {
        state.next.qzone = now + (Number(il.qzone.minGapMs) || DEFAULTS.qzone.minGapMs) + rand(20 * 60 * 1000, 90 * 60 * 1000);
      }
    } else if (name === 'aiTips') {
      const tips = loadAiTips();
      if (!aiTipsReady(il) || tips.paused) {
        state.next.aiTips = 0;
      } else if (result?.status === 'daily-done' || tips.sentToday >= tips.dailyTarget) {
        state.next.aiTips = aiTipMorning(il);
      } else if (isQuiet(il)) {
        state.next.aiTips = nextQuietEnd(il, now);
      } else if (result?.status === 'send-failed') {
        state.next.aiTips = now + rand(10 * 60 * 1000, 25 * 60 * 1000);
      } else if (result?.status === 'error' || result?.status === 'invalid' || result?.status === 'duplicate') {
        state.next.aiTips = now + rand(30 * 60 * 1000, 90 * 60 * 1000);
      } else {
        state.next.aiTips = nextAiTipAt(il, now);
      }
    }
    saveInner(state);
  }

  async function runJob(name, { force = false, preferS16 = false, forceApproval = false, dryRun = false } = {}) {
    const il = ilCfg();
    const state = loadInner();
    if (!il.enabled && !force) return { status: 'disabled' };
    if (!isDshReady()) return { status: 'dsh-not-ready' };
    if (getMode() !== 'simulation') return { status: 'mode' };
    if (isPaused() && !force) return { status: 'paused' };
    const shareId = name === 'aiTips' ? 'ai_tips' : (name.startsWith('share:') ? name.slice(6) : '');
    let result;
    try {
      if (shareId) result = await runShareModule(shareId, { force, dryRun });
      else if (name === 'reflection') result = await runReflection(il);
      else if (name === 'curiosity') {
        if (curiosityOwnedByEngine()) {
          state.next.curiosity = 0;
          saveInner(state);
          return { status: 'module-owned' };
        }
        result = await runCuriosity(il, { force, preferS16, forceApproval, dryRun });
      }
      else if (name === 'qzone') result = await runQzone(il, { force });
      else return { status: 'unknown' };
    } catch (error) {
      result = { status: 'error', error: error?.message ?? String(error) };
      log(`[inner] ${name} 失败：${result.error}`);
    }
    if (shareId) advanceShareModule(shareId, result);
    else advanceNext(loadInner(), name, il, result);
    log(`[inner] ${name} → ${result?.status ?? 'done'}`);
    return result;
  }

  function enqueue(fn) {
    taskChain = taskChain.catch(() => {}).then(fn).catch((error) => {
      log(`[inner] 任务异常：${error?.message ?? error}`);
      return { status: 'error', error: error?.message ?? String(error) };
    });
    return taskChain;
  }

  function arm(delayMs) {
    if (timer && timer !== 'job') { clearTimeout(timer); timer = null; }
    const ms = Math.max(1000, delayMs);
    // 有持久化任务队列时优先用它：进程重启后仍能补上这次调度。
    if (deps.scheduler?.enabled?.()) {
      try {
        deps.scheduler.scheduleAt(Date.now() + ms);
        timer = 'job';
        return;
      } catch (error) {
        deps.log?.(`[inner] 任务队列排程失败，回退定时器：${error?.message ?? error}`);
      }
    }
    timer = setTimeout(() => { timer = null; void tick(); }, ms);
    timer.unref?.();
  }

  function shareScheduleEntries() {
    const conf = shareModulesConfig();
    const sstate = loadShareModulesState();
    const entries = [];
    let dirty = false;
    for (const [id, module] of Object.entries(conf.modules)) {
      const m = sstate.modules[id];
      if (!m) continue;
      if (!module.enabled || m.paused || !hasEngineFacets(module)) {
        if (m.nextAt) { m.nextAt = 0; dirty = true; }
        continue;
      }
      if (!m.nextAt) {
        m.nextAt = m.pending ? Date.now() + 2 * 3600 * 1000 : nextShareModuleAt(module, m, Date.now());
        dirty = true;
      }
      if (m.nextAt) entries.push({ name: `share:${id}`, at: m.nextAt });
    }
    if (dirty) saveShareModulesState(sstate);
    return entries;
  }

  /** life_fun 已由通用引擎接管时，旧的 curiosity 作业不再独立调度（否则同一期会发两次）。 */
  function curiosityOwnedByEngine() {
    const conf = shareModulesConfig();
    const module = conf.modules.life_fun;
    return Boolean(module && module.enabled && hasEngineFacets(module));
  }

  function legacyInnerJobNames() {
    return ['reflection', 'curiosity', 'qzone'].filter((name) => !(name === 'curiosity' && curiosityOwnedByEngine()));
  }

  function scheduleNext() {
    if (!started) return;
    const il = ilCfg();
    if (!il.enabled) return;
    const state = loadInner();
    if (state.next.aiTips) {
      // AI 知识已迁入通用模块，旧的 aiTips 时间点不再单独调度。
      state.next.aiTips = 0;
      saveInner(state);
    }
    if (curiosityOwnedByEngine() && state.next.curiosity) {
      state.next.curiosity = 0;
      saveInner(state);
    }
    const shareEntries = shareScheduleEntries();
    const times = legacyInnerJobNames().map((name) => Number(state.next[name]) || Infinity);
    times.push(...shareEntries.map((entry) => entry.at));
    const next = Math.min(...times);
    if (!Number.isFinite(next)) return;
    arm(Math.min(6 * 3600 * 1000, Math.max(1000, next - Date.now())));
  }

  function scheduleRetry(ms = 5 * 60 * 1000) {
    if (!started) return;
    arm(ms);
  }

  async function tick() {
    if (!started || running) return;
    const il = ilCfg();
    if (!il.enabled) return;
    if (!isDshReady()) { scheduleRetry(5 * 60 * 1000); return; }
    if (getMode() !== 'simulation') { scheduleRetry(10 * 60 * 1000); return; }
    if (isPaused()) { scheduleRetry(10 * 60 * 1000); return; }
    const state = loadInner();
    const now = Date.now();
    const due = [
      ...legacyInnerJobNames().map((name) => ({ name, at: Number(state.next[name]) || 0 })),
      ...shareScheduleEntries()
    ]
      .filter((job) => job.at > 0 && job.at <= now + 1000)
      .sort((a, b) => a.at - b.at);
    if (!due.length) { scheduleNext(); return; }
    running = true;
    try {
      await enqueue(() => runJob(due[0].name));
    } finally {
      running = false;
      scheduleNext();
    }
  }

  function start() {
    if (started) return;
    started = true;
    const il = ilCfg();
    if (!il.enabled) {
      log('[inner] 内心生活未启用（simulation.innerLife.enabled != true）');
      return;
    }
    const state = loadInner();
    const now = Date.now();
    // v1 → v2 迁移只做一次；history 里留一条 migration 方便回看。
    const rawPersona = readJson(files.persona, null);
    const needMigrate = !rawPersona || Number(rawPersona.version) < 2 || !Number.isFinite(Number(rawPersona?.mood?.setPoint));
    if (needMigrate) {
      const migrated = normalizePersonaState(rawPersona ?? defaultPersonaState(now), now);
      savePersona(migrated);
      if (il.mood?.enabled !== false && il.mood?.history?.enabled !== false) {
        const oldMood = rawPersona?.mood && typeof rawPersona.mood === 'object' ? rawPersona.mood : null;
        const mode = derivePersonaMode(migrated, { now, quiet: isQuiet(il) });
        appendMoodHistory(files.moodHistory, {
          at: now,
          source: 'migration',
          cause: migrated.mood.cause,
          before: oldMood ? { v: Number(oldMood.valence) || 0, a: Number(oldMood.arousal) || 0, e: Number(rawPersona?.energy) || 0 } : null,
          after: { v: migrated.mood.valence, a: migrated.mood.arousal, e: migrated.energy },
          delta: { v: 0, a: 0, e: 0 },
          events: [],
          mode: mode.id,
          label: migrated.mood.label,
          labelRaw: '',
          setPoint: migrated.mood.setPoint
        }, {
          now,
          keepDays: Number(il.mood?.history?.keepDays) || 180,
          maxBytes: Number(il.mood?.history?.maxBytes) || 5 * 1024 * 1024
        });
      }
      log('[inner] 人格状态已迁移到 v2（mood v3）');
    }
    const reflectionMax = reflectionInterval(il).max;
    const shortened = state.reflectionMaxMs !== null && reflectionMax < state.reflectionMaxMs;
    if (!state.next.reflection || (shortened && state.next.reflection > now + reflectionMax))
      state.next.reflection = nextReflectionAt(il, now);
    state.reflectionMaxMs = reflectionMax;
    if (!state.next.curiosity) state.next.curiosity = now + rand(5 * 60 * 1000, 15 * 60 * 1000);
    if (!state.next.qzone) state.next.qzone = now + rand(30 * 60 * 1000, 90 * 60 * 1000);
    state.next.aiTips = 0;
    // 通用分享模块：迁移 ai-tips 状态并确保每个模块有下一次时间。
    shareScheduleEntries();
    // Only a same-day wait actually scheduled by a daily cap can be shortened.
    // Legacy states have no cause attached; keep their future dates intact.
    for (const name of ['curiosity', 'qzone']) {
      const wait = state.quotaWait[name];
      const limit = Number(il[name].maxPerDay) || DEFAULTS[name].maxPerDay;
      const pending = name === 'curiosity' ? state.pendingShare : state.pendingDraft || state.qzone.paused;
      if (!wait || !il[name].enabled || pending || limit <= wait.limit || state.counts[name] >= limit) continue;
      const retry = isQuiet(il) ? nextQuietEnd(il, now) : now + (name === 'curiosity'
        ? rand(5 * 60 * 1000, 15 * 60 * 1000) : rand(20 * 60 * 1000, 60 * 60 * 1000));
      state.next[name] = Math.min(state.next[name], retry);
      delete state.quotaWait[name];
    }
    for (const name of ['reflection', 'curiosity', 'qzone']) {
      if (state.next[name] && state.next[name] < now) state.next[name] = now + rand(2 * 60 * 1000, 10 * 60 * 1000);
    }
    saveInner(state);
    scheduleNext();
    log('[inner] 内心生活调度已启动');
  }

  function stop() {
    started = false;
    if (timer === 'job') {
      try { deps.scheduler?.cancel?.(); } catch {}
    } else if (timer) {
      clearTimeout(timer);
    }
    timer = null;
  }

  function statusText() {
    const il = ilCfg();
    const state = loadInner();
    const persona = personaInfo();
    const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '未安排');
    const pending = state.pendingDraft
      ? `待审核草稿（${new Date(state.pendingDraft.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })} 过期）${state.pendingDraft.imageName ? `（配图：${state.pendingDraft.imageName}）` : ''}：${cleanLine(state.pendingDraft.text, 80)}`
      : '无';
    return [
      '【小鲸鱼内心状态】',
      persona.detail,
      '',
      `今天：好奇 ${state.counts.curiosity} 次 / 群分享 ${state.counts.groupShare} 条 / 空间 ${state.counts.qzone} 条`,
      `空间：${state.qzone.paused ? '已暂停' : '开'}，已审核通过 ${state.qzone.approvedCount} 条，${il.qzone.requireApproval !== false ? '每条发布前需主人审核' : (state.qzone.auto ? '自动发布' : `前 ${il.qzone.approvalFirst} 条需审核`)}`,
      `夜间静默：${il.quiet.enabled ? `${il.quiet.start}-${il.quiet.end}（只回应被喊）` : '关闭'}`,
      `下次：反思 ${fmt(state.next.reflection)}；好奇 ${fmt(state.next.curiosity)}；空间 ${fmt(state.next.qzone)}；AI小知识 ${fmt(state.next.aiTips)}`,
      `候选池：${loadCuriosity().candidates.length} 条；最近抓取：${loadCuriosity().fetchedAt ? new Date(loadCuriosity().fetchedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '还没抓过'}`,
      aiTipsStatusLine(),
      `待审核：${pending}`
    ].join('\n');
  }

  /**
   * 主人私聊微调已有草稿。只改正文，不重新选题，也不发布。
   * kind: qzone | signature
   */
  async function refineText({ kind = 'qzone', current = '', instruction = '', maxChars = 150 } = {}) {
    const text = String(current ?? '').trim();
    const ask = String(instruction ?? '').trim();
    if (!text) throw new Error('没有可修改的草稿');
    if (!ask) throw new Error('没有说明想怎么改');
    const isSignature = kind === 'signature';
    const limit = Math.max(8, Math.min(200, Number(maxChars) || (isSignature ? 40 : 150)));
    const task = isSignature
      ? `这是你的个性签名草稿：\n${text}\n\n主人想这样调整：${ask}\n\n请按主人的意思改一版，保留小鲸鱼的口吻；只输出签名正文，不要引号、不要解释、不要标题，最多 ${limit} 字。`
      : `这是你的空间说说草稿：\n${text}\n\n主人想这样调整：${ask}\n\n请按主人的意思改一版，保留小鲸鱼的口吻；只输出说说正文，不要 IMG 行、不要引号、不要解释、不要标题，最多 ${limit} 字。`;
    const output = await runTurn(buildBasePrompt(task, `${CONTENT_VOICE_BLOCK}\n`), 120000);
    const cleaned = cleanPost(output, limit);
    if (!cleaned) throw new Error('改出来的内容为空或含敏感信息');
    return cleaned;
  }

  async function handleOwnerCommand(text, { kind, isOwner } = {}) {
    if (!isOwner || kind !== 'private') return false;
    const command = String(text ?? '').trim();
    if (!command) return false;
    const il = ilCfg();
    const state = loadInner();
    const pendingDraft = state.pendingDraft;
    const qState = loadQzoneComments();
    const pendingReply = qState.pendingCommentReply;
    if (pendingReply) {
      if (Date.now() > Number(pendingReply.expiresAt || 0)) {
        qState.pendingCommentReply = null;
        saveQzoneComments(qState);
        await sendOwner('这条空间回复草稿过期了，这次不发。');
        return true;
      }
      const approve = /^(发回复|发布回复|发这条回复)$/.test(command)
        || (!pendingDraft && !state.pendingShare && /^(发|发布)$/.test(command));
      const reject = /^(不发回复|取消回复)$/.test(command)
        || (!pendingDraft && !state.pendingShare && /^(不发|取消)$/.test(command));
      if (approve) {
        try {
          const comment = {
            uin: pendingReply.commentUin || '',
            id: pendingReply.commentId || '',
            text: pendingReply.commentText || '',
            name: pendingReply.commentName || ''
          };
          const replyTo = comment.uin && comment.id ? comment : null;
          await commentQzone(cfg, pendingReply.tid, pendingReply.reply, {
            targetUin: pendingReply.targetUin || '',
            replyTo
          });
          qState.replied.push({
            key: pendingReply.key || commentKey(pendingReply.tid, comment),
            tid: pendingReply.tid,
            at: Date.now(),
            text: pendingReply.reply,
            comment: comment.text.slice(0, 120),
            name: comment.name
          });
          qState.replied = qState.replied.slice(-200);
          if (pendingReply.source === 'mention') {
            qState.mentions.push({ key: pendingReply.key || commentKey(pendingReply.tid, comment), tid: pendingReply.tid, targetUin: pendingReply.targetUin, at: Date.now(), comment: comment.text, name: comment.name, reply: pendingReply.reply });
            qState.mentions = qState.mentions.slice(-200);
            qState.mentionCount += 1;
          } else {
            qState.count += 1;
          }
          qState.pendingCommentReply = null;
          saveQzoneComments(qState);
          await sendOwner(`已发布空间回复：${pendingReply.reply}`);
        } catch (error) {
          await sendOwner(`空间回复发布失败：${error?.message ?? error}；草稿还留着，可以回「发回复」再试。`);
        }
        return true;
      }
      if (reject) {
        qState.pendingCommentReply = null;
        saveQzoneComments(qState);
        await sendOwner('好，这条空间回复不发了。');
        return true;
      }
    }

    if (pendingDraft && /^(发|发说说|发布)$/.test(command)) {
      if (Date.now() > Number(pendingDraft.expiresAt || 0)) {
        state.pendingDraft = null;
        saveInner(state);
        await sendOwner('这条空间草稿过期了，这次不发了。');
        return true;
      }
      const result = await postQzoneNow(pendingDraft.text, { imageRef: pendingDraft.imageRef || '' });
      if (result.status === 'posted' || result.status === 'dryRun') {
        const latest = loadInner();
        const current = latest.pendingDraft;
        if (current && current.createdAt === pendingDraft.createdAt &&
            current.messageId === pendingDraft.messageId && current.text === pendingDraft.text &&
            current.imageRef === pendingDraft.imageRef) {
          latest.pendingDraft = null;
        }
        let notice = '';
        if (result.status === 'posted') {
          latest.qzone.approvedCount += 1;
          latest.next.qzone = Date.now() + (Number(il.qzone.minGapMs) || DEFAULTS.qzone.minGapMs) + rand(30 * 60 * 1000, 3 * 3600 * 1000);
          if (il.qzone.requireApproval !== false) {
            notice = `这条已经发了（${qzoneVisibilityLabel(il.qzone.visibility)}）。之后每条说说还是会先发你审核，回「发」才发布。`;
          } else if (latest.qzone.approvedCount >= (Number(il.qzone.approvalFirst) || DEFAULTS.qzone.approvalFirst)) {
            latest.qzone.auto = true;
            notice = `这条已经发了（${qzoneVisibilityLabel(il.qzone.visibility)}）。审批满 ${latest.qzone.approvedCount} 条，之后我会自己发，不再逐条问你；发「关说说」可以随时暂停。`;
          }
        }
        saveInner(latest);
        if (notice) await sendOwner(notice);
      } else if (result.status === 'paused') {
        await sendOwner('空间说说现在是暂停状态，回「开说说」后再发。');
      }
      return true;
    }

    if (pendingDraft && /^(不发|不发说说)$/.test(command)) {
      // 被拒草稿记入历史，避免下次生成相似内容
      state.history.qzonePosts.unshift({
        at: Number(pendingDraft.createdAt) || Date.now(),
        text: pendingDraft.text,
        image: pendingDraft.imageName || '',
        status: 'rejected'
      });
      state.history.qzonePosts = state.history.qzonePosts.slice(0, 60);
      state.pendingDraft = null;
      // 拒绝后立即重排下一次说说生成，不等旧草稿过期
      state.next.qzone = Date.now() + rand(10 * 60 * 1000, 30 * 60 * 1000);
      saveInner(state);
      await sendOwner('好，这条不发了，我过一会儿重新写一条。');
      return true;
    }

    const resolveShareModule = (name) => {
      const raw = String(name || '').trim();
      const modules = Object.values(shareModulesConfig().modules);
      return modules.find((module) => module.id === raw)
        || modules.find((module) => module.label === raw)
        || modules.find((module) => module.label.includes(raw) || raw.includes(module.label))
        || null;
    };
    const sharePublishCmd = command.match(/^(发分享|不发分享)\s+([\w-]+)$/);
    if (sharePublishCmd) {
      const module = resolveShareModule(sharePublishCmd[2]);
      if (!module) { await sendOwner(`没找到分享模块「${sharePublishCmd[2]}」。`); return true; }
      const qs = loadShareModulesState();
      if (!qs.modules[module.id]?.pending) { await sendOwner(`「${module.label}」现在没有待发草稿。`); return true; }
      if (sharePublishCmd[1] === '不发分享') {
        qs.modules[module.id].pending = null;
        qs.modules[module.id].nextAt = nextShareModuleAt(module, qs.modules[module.id], Date.now());
        saveShareModulesState(qs);
        await sendOwner(`好，「${module.label}」这条不发了。`);
        return true;
      }
      const result = await publishShareDraft(module.id);
      if (result.status === 'sent') await sendOwner(`「${module.label}」已发到群里：${result.title || ''}`);
      else if (result.status === 'expired') await sendOwner('这条分享草稿过期了，下次重新生成。');
      else if (result.status === 'budget') await sendOwner(`现在群级分享预算不够（${result.reason}），稍后再发。`);
      else await sendOwner(`这条没发出去：${result.status}${result.error ? `（${result.error}）` : ''}`);
      return true;
    }
    const shareVerifyCmd = command.match(/^验证通过(?:\s+([\w-]+))?$/);
    if (shareVerifyCmd) {
      const modules = Object.values(shareModulesConfig().modules);
      const module = shareVerifyCmd[1] ? resolveShareModule(shareVerifyCmd[1]) : (modules.length === 1 ? modules[0] : null);
      if (!module) { await sendOwner('要验证哪个模块？回「验证通过 模块id」。'); return true; }
      const qs = loadShareModulesState();
      setVerification(qs, module.id, 'approved', Date.now(), 'owner');
      qs.modules[module.id]._verificationSet = true;
      qs.modules[module.id].nextAt = nextShareModuleAt(module, qs.modules[module.id], Date.now());
      saveShareModulesState(qs);
      await sendOwner(`「${module.label}」验证通过，之后按排期自动发送；可随时回「暂停分享 ${module.id}」。`);
      return true;
    }
    const sharePauseCmd = command.match(/^(暂停|恢复)分享\s+([\w-]+)$/);
    if (sharePauseCmd) {
      const module = resolveShareModule(sharePauseCmd[2]);
      if (!module) { await sendOwner(`没找到分享模块「${sharePauseCmd[2]}」。`); return true; }
      const qs = loadShareModulesState();
      const m = qs.modules[module.id];
      m.paused = sharePauseCmd[1] === '暂停';
      m.nextAt = m.paused ? 0 : nextShareModuleAt(module, m, Date.now());
      saveShareModulesState(qs);
      await sendOwner(`「${module.label}」已${m.paused ? '暂停' : '恢复'}。`);
      return true;
    }

    const pendingShare = state.pendingShare;
    const shareApprove = /^(发分享|发布分享)$/.test(command)
      || (!pendingDraft && pendingShare && /^(发|发布)$/.test(command));
    const shareReject = /^(不发分享|取消分享)$/.test(command)
      || (!pendingDraft && pendingShare && /^(不发|放弃|算了)$/.test(command));
    if (pendingShare && shareApprove) {
      if (Date.now() > Number(pendingShare.expiresAt || 0)) {
        state.pendingShare = null;
        saveInner(state);
        await sendOwner('这条群分享草稿过期了，这次不发了。');
        return true;
      }
      const target = pendingShare.target || targetKey(il);
      const item = pendingShare.item || null;
      const sent = await sendGroupShare(target, pendingShare.text, item ? [item] : [], { force: true });
      if (sent) {
        if (item) markSeen(item);
        const latest = loadInner();
        latest.pendingShare = null;
        saveInner(latest);
        await sendOwner(`已发到 ${target}：${String(pendingShare.text || '').slice(0, 80)}`);
        if (item) {
          try {
            const cover = await buildVideoCover(item);
            if (cover) await imageLibrary.sendToKey(target, cover.id, { caption: '' });
          } catch (error) {
            log(`[inner] 分享配图发送失败（忽略）：${error?.message ?? error}`);
          }
        }
      } else {
        await sendOwner('这次没发出去（目标群可能不在白名单、今天已达上限或发送失败），草稿还留着。');
      }
      return true;
    }
    if (pendingShare && shareReject) {
      state.pendingShare = null;
      saveInner(state);
      if (pendingShare.item) markSeen(pendingShare.item);
      await sendOwner('好，这条群分享不发了。');
      return true;
    }

    if (/^删说说/.test(command)) {
      const explicit = command.replace(/^删说说\s*/, '').trim();
      const last = state.history.qzonePosts.find((post) => post.status === 'posted' && post.tid);
      const tid = explicit || last?.tid || '';
      if (!tid) { await sendOwner('没有找到可删除的说说 tid。'); return true; }
      try {
        await deleteQzone(cfg, tid);
        const hit = state.history.qzonePosts.find((post) => post.tid === tid);
        if (hit) hit.status = 'deleted';
        saveInner(state);
        await sendOwner(`已删除空间说说 ${tid}。`);
      } catch (error) {
        await sendOwner(`删说说失败：${error?.message ?? error}`);
      }
      return true;
    }

    if (command === '关说说') {
      state.qzone.paused = true;
      saveInner(state);
      await sendOwner('空间说说已暂停。');
      return true;
    }
    if (command === '开说说') {
      state.qzone.paused = false;
      saveInner(state);
      await sendOwner('空间说说已恢复。');
      return true;
    }
    if (/^(关|停|暂停)(ai)?(小课堂|知识分享|ai分享)(了|吧)?$/i.test(command)) {
      const tips = loadAiTips();
      tips.paused = true;
      saveAiTips(tips);
      const qs = loadShareModulesState();
      if (qs.modules.ai_tips) {
        qs.modules.ai_tips.paused = true;
        qs.modules.ai_tips.nextAt = 0;
        saveShareModulesState(qs);
      }
      await sendOwner('AI知识分享已暂停，回「开AI分享」恢复。');
      return true;
    }
    if (/^(开|恢复|继续)(ai)?(小课堂|知识分享|ai分享)(吧)?$/i.test(command)) {
      const tips = loadAiTips();
      tips.paused = false;
      saveAiTips(tips);
      const qs = loadShareModulesState();
      const module = shareModuleById('ai_tips');
      if (qs.modules.ai_tips) {
        qs.modules.ai_tips.paused = false;
        qs.modules.ai_tips.nextAt = qs.modules.ai_tips.nextAt || nextShareModuleAt(module, qs.modules.ai_tips, Date.now());
        saveShareModulesState(qs);
      }
      const nextAt = qs.modules.ai_tips?.nextAt || 0;
      await sendOwner(nextAt
        ? `AI知识分享已恢复，下次大约 ${new Date(nextAt).toLocaleString('zh-CN', { hour12: false })}。`
        : 'AI知识分享已恢复。');
      return true;
    }
    if (/^(ai)?(小课堂|知识分享|ai分享)(状态)?$/i.test(command)) {
      await sendOwner(aiTipsStatusLine());
      return true;
    }
    const pickPreview = command.match(/^(?:就|用|发)?\s*第\s*([1-5])\s*(?:种|条|个)?$/);
    if (pickPreview) {
      const tips = loadAiTips();
      const index = Number(pickPreview[1]) - 1;
      const item = Array.isArray(tips.lastPreview?.items) ? tips.lastPreview.items[index] : null;
      if (!item) {
        await sendOwner('没有可选的预览了，先回「预览三个AI知识」，我再写几条给你挑。');
        return true;
      }
      const target = aiTipTarget(il);
      if (!target) {
        await sendOwner('还没设置 AI 知识分享的目标群。');
        return true;
      }
      try {
        const webImages = il.aiTips.images !== false ? await fetchWebIllustrations(item.links || []) : [];
        const card = il.aiTips.images !== false ? await buildAiTipCard(item) : null;
        const images = [];
        if (webImages.length) {
          images.push(...webImages.map((entry) => entry.buffer));
          if (webImages.length === 1 && card) images.push(card);
        } else if (card) {
          images.push(card);
        }
        const imageHosts = [...new Set(webImages.map((entry) => entry.host).filter(Boolean))].join(', ');
        const caption = formatTipCaption(item);
        const imageSent = images.length ? await sendAiTipImage(target, images, item, { caption }) : false;
        if (!imageSent) {
          await sendToQQ(target, caption);
          if (lastSendSucceeded && lastSendSucceeded(target) === false) throw new Error('发送未确认');
        }
        const linksText = formatAiTipLinks(item.links || [], imageSent ? imageHosts : '');
        if (linksText) await sendToQQ(target, linksText);
        tips.sentToday += 1;
        tips.lastSentAt = Date.now();
        tips.lastCategory = item.category;
        tips.history.unshift({
          at: tips.lastSentAt,
          topic: item.topic || item.title,
          title: item.title,
          techName: item.techName || '',
          category: item.category,
          text: item.text,
          phenomenon: item.phenomenon || '',
          tech: item.tech || '',
          how: item.how || '',
          terms: item.terms || [],
          links: item.links || [],
          hasImage: imageSent,
          imageSource: imageSent ? (webImages.length ? 'web' : (card ? 'card' : '')) : '',
          imageHosts: imageSent ? imageHosts : ''
        });
        tips.history = tips.history.slice(0, Math.max(50, Number(il.aiTips.maxHistory) || DEFAULTS.aiTips.maxHistory));
        tips.lastPreview.items.splice(index, 1);
        saveAiTips(tips);
        if (appendActivity) {
          try { appendActivity(`${target} [inner] AI小知识（选定第${index + 1}条）：${formatAiTip(item).slice(0, 80)}`); } catch {}
        }
        await sendOwner(`好，第${index + 1}条已经发到家人群了。`);
      } catch (error) {
        await sendOwner(`这条没发出去：${error?.message ?? error}`);
      }
      return true;
    }
    if (/^(预览|看)(三个|3个|几条)(ai)?(小课堂|知识分享|ai分享|知识)$/i.test(command)) {
      await sendOwner('好，我写三条不同方向的，私聊发你看看。');
      void enqueue(async () => {
        const result = await previewAiTipsToOwner(3);
        log(`[inner] AI小知识预览（3 条）→ ${result?.status ?? 'done'}`);
      });
      return true;
    }
    if (/^(预览|看一个)(ai)?(小课堂|知识分享|ai分享|知识)$/i.test(command)) {
      const result = await runAiTip(il, { force: true, dryRun: true });
      if (result.status === 'dryRun') {
        const tipsState = loadAiTips();
        tipsState.lastPreview = {
          at: Date.now(),
          items: [{ at: Date.now(), title: result.title, topic: result.topic, category: result.category, categoryLabel: result.categoryLabel, text: result.text }]
        };
        saveAiTips(tipsState);
        await sendOwner(`【AI小知识预览】[${result.categoryLabel}] ${result.title}\n${result.text}\n\n还没发到群里；回「用第1种」就发，或直接说哪里不对。`);
      } else {
        await sendOwner(`这次没生成出来：${result.status}${result.error ? `（${result.error}）` : ''}`);
      }
      return true;
    }
    if (/^(跑一次|讲一个|来一个)(ai)?(小课堂|知识分享|ai分享)$/i.test(command)) {
      void enqueue(() => runJob('aiTips', { force: true }));
      await sendOwner(il.dryRun ? '收到，我先写一个；现在是 dryRun，只记录不发。' : '好，我挑一个讲给叔叔阿姨听。');
      return true;
    }
    if (command === '内心状态') {
      await sendOwner(statusText());
      return true;
    }
    if (/^(跑一次说说|写条说说)$/.test(command)) {
      void enqueue(() => runJob('qzone', { force: true }));
      await sendOwner(il.dryRun ? '收到，我先写一条；现在是 dryRun，只记录不发布。' : '收到，我去写一条；草稿会发你审核。');
      return true;
    }
    if (/^(跑一次分享|找点东西分享)$/.test(command)) {
      void enqueue(() => runJob('curiosity', { force: true }));
      await sendOwner('好，我去翻翻有什么有意思的。');
      return true;
    }
    if (/^(反思一下|更新一下状态)$/.test(command)) {
      void enqueue(() => runJob('reflection', { force: true }));
      await sendOwner('好，我去反省一下今天。');
      return true;
    }
    const stickerCmd = command.match(/^(?:收藏表情|收表情)(?:\s+(\d{1,2}))?$/);
    if (stickerCmd) {
      const n = Math.min(20, Math.max(1, Number(stickerCmd[1]) || 10));
      if (typeof collectImageStickers !== 'function') { await sendOwner('这个功能还没接上。'); return true; }
      void enqueue(() => collectImageStickers({ count: n, sendPreview: true }));
      await sendOwner(`好，我去挑 ${n} 张适合当表情的图，私发给你看，同时收进 QQ 收藏表情。`);
      return true;
    }
    if (/^(发签名|不发签名|取消签名|改签名)(?:\s|$)/.test(command)) return false;
    if (pendingDraft) {
      void enqueue(() => adjustQzoneDraft(command).catch(async (error) => {
        log(`[inner] 空间草稿微调失败：${error?.message ?? error}`);
        await sendOwner(`唔，这次没改成功：${error?.message ?? error}，再跟我说一次？`);
      }));
      await sendOwner('好，我按你说的改一下，改完再发你看。');
      return true;
    }
    return false;
  }

  // 主人私聊直接指定内容发说说：不再走“草稿审核”，主人说发就发。
  // 即时心情事件：只给强度 ≥3 的明显事件，限频/去重后写入全局 persona-state。
  async function nudgeMood(event, { dryRun = false } = {}) {
    const il = ilCfg();
    if (il.mood?.enabled === false) return { status: 'disabled', error: 'mood v3 未启用' };
    if (il.mood?.eventNudge?.enabled !== true) return { status: 'disabled', error: '即时心情事件未启用' };
    const before = loadPersona();
    const result = applyMoodNudge(before, event, { now: Date.now(), cfg: il.mood, dryRun });
    if (result.status !== 'ok') return result;
    if (!dryRun) {
      savePersona(result.state);
      const mode = derivePersonaMode(result.state, { now: Date.now(), quiet: isQuiet(il) });
      if (il.mood?.history?.enabled !== false) {
        appendMoodHistory(files.moodHistory, {
          at: Date.now(),
          source: 'nudge',
          cause: result.state.mood.cause,
          before: result.meta.before,
          after: result.meta.after,
          delta: result.meta.delta,
          events: result.meta.events.map((item) => ({ what: item.what, intensity: item.intensity, valence: item.valence })),
          mode: mode.id,
          label: result.state.mood.label,
          labelRaw: result.meta.labelRaw,
          setPoint: result.state.mood.setPoint
        }, {
          now: Date.now(),
          keepDays: Number(il.mood?.history?.keepDays) || 180,
          maxBytes: Number(il.mood?.history?.maxBytes) || 5 * 1024 * 1024
        });
      }
      log(`[mood] 即时事件「${result.meta.events[0]?.what || ''}」强度 ${result.meta.events[0]?.intensity || ''} → ${result.state.mood.label}`);
    }
    return {
      status: dryRun ? 'dry-run' : 'ok',
      mood: {
        valence: result.state.mood.valence,
        arousal: result.state.mood.arousal,
        label: result.state.mood.label,
        cause: result.state.mood.cause,
        setPoint: result.state.mood.setPoint
      },
      changes: result.changes,
      preview: dryRun ? { before: result.meta.before, after: result.meta.after, delta: result.meta.delta } : undefined
    };
  }

  async function ownerPublishQzone(text, { imageRef = '', dryRun = false } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return { status: 'invalid', error: '说说内容为空' };
    if (SENSITIVE_RE.test(clean)) return { status: 'sensitive', error: '内容含本机路径/凭据特征，不能发' };
    const max = Math.max(60, Number(ilCfg().qzone.maxChars) || 150);
    if (clean.length > max) return { status: 'too-long', error: `最多 ${max} 字（现在 ${clean.length} 字）` };
    const issue = timeConflict(clean);
    if (issue) return { status: 'time-conflict', error: issue };
    if (dryRun) return { status: 'dry-run', text: clean, image: imageRef || '' };
    return postQzoneNow(clean, { manual: true, imageRef, notify: false });
  }

  return {
    start,
    stop,
    tick,
    isInnerSession,
    handleEvent,
    personaBlock,
    personaInfo,
    refineText,
    handleOwnerCommand,
    ownerPublishQzone,
    nudgeMood,
    statusText,
    runJob,
    getState: loadInner,
    getCandidates: loadCuriosity,
    refreshCandidates: (force = true) => refreshCandidates(ilCfg(), { force }),
    checkQzoneComments,
    getQzoneCommentStatus,
    getAiTipsStatus,
    getShareModulesStatus,
    getShareModuleConfig,
    updateShareModuleConfig,
    noteLegacyShare,
    prepareShareModule,
    initShareModuleState,
    removeShareModuleState,
    previewShareModule: (id) => runShareModule(id, { force: true, dryRun: true, ignoreGuards: true }),
    runShareModule: async (id, opts) => {
      const result = await runShareModule(id, opts);
      advanceShareModule(id, result);
      return result;
    },
    publishShareDraft,
    setShareVerification: (moduleId, status) => {
      const state = loadShareModulesState();
      setVerification(state, moduleId, status === 'approved' ? 'approved' : 'pending', Date.now(), 'owner');
      if (state.modules[moduleId]) state.modules[moduleId]._verificationSet = true;
      if (status === 'approved') state.modules[moduleId].nextAt = nextShareModuleAt(shareModuleById(moduleId), state.modules[moduleId], Date.now());
      saveShareModulesState(state);
      return getShareModulesStatus();
    },
    setShareModulePaused: (moduleId, paused) => {
      const state = loadShareModulesState();
      const m = state.modules[moduleId];
      if (!m) return null;
      m.paused = paused === true;
      m.nextAt = m.paused ? 0 : (m.nextAt || nextShareModuleAt(shareModuleById(moduleId), m, Date.now()));
      saveShareModulesState(state);
      return getShareModulesStatus();
    },
    refreshShareModuleSchedule: (moduleId) => {
      const state = loadShareModulesState();
      const m = state.modules[moduleId];
      const module = shareModuleById(moduleId);
      if (!m || !module) return null;
      m.nextAt = (m.paused || !hasEngineFacets(module)) ? 0 : nextShareModuleAt(module, m, Date.now());
      saveShareModulesState(state);
      scheduleNext();
      return getShareModulesStatus();
    },
    reschedule: () => { scheduleNext(); },
    previewAiTip: () => runAiTip(ilCfg(), { force: true, dryRun: true, ignoreGuards: true }),
    previewAiTipsToOwner,
    setAiTipsPaused: (paused) => {
      const tips = loadAiTips();
      tips.paused = paused === true;
      saveAiTips(tips);
      const state = loadShareModulesState();
      const m = state.modules.ai_tips;
      if (m) {
        m.paused = paused === true;
        m.nextAt = paused ? 0 : (m.nextAt || nextShareModuleAt(shareModuleById('ai_tips'), m, Date.now()));
        saveShareModulesState(state);
      }
      return getAiTipsStatus();
    },
    getPersona: loadPersona
  };
}
