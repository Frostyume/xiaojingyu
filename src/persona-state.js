// 小鲸鱼的「可变人格状态」：心情、精力、兴趣、最近学到的、口癖。
//
// 这不是人格卡。人格卡（roles/*.md）是“她是谁”，不可自动改；
// 这里只保存可以在反思中缓慢漂移的状态，并且**每一次变化都有上限**。
//
// v2（mood v3）核心：
//   - 心情按真实时间半衰期衰减，而不是按反思次数衰减；
//   - valence 有慢速设定点（setPoint），好/坏日子会留余温；
//   - arousal 半衰期 6h，energy 按北京昼夜目标；
//   - 反思给“强度 1–5 的事件”，代码负责幅度映射、每小时/每天上限；
//   - 旧 v1 字段保留，关闭 v3 时 applyReflection 仍按旧逻辑工作。

import { beijingParts } from './core/time-awareness.js';

const BASELINE = Object.freeze({ valence: 0.15, arousal: 0.45, energy: 0.6 });
const MAX_INTERESTS = 5;
const MAX_LEARNINGS = 12;
const MAX_QUIRKS = 3;
const MAX_CHANGELOG = 100;
const MAX_LEARNING_CHARS = 90;
const MAX_QUIRK_CHARS = 24;
const MAX_LABEL_CHARS = 24;
const LEARNINGS_TTL_MS = 30 * 24 * 3600 * 1000;

const HOUR_MS = 3600 * 1000;
const DEFAULT_SETPOINT = 0.08;

const VALENCE_DELTA = [0.05, 0.10, 0.16, 0.23, 0.30];
const AROUSAL_DELTA = [0.04, 0.08, 0.12, 0.18, 0.24];
const ENERGY_DELTA = [0.04, 0.06, 0.09, 0.13, 0.18];

export const MOOD_V3_DEFAULTS = Object.freeze({
  enabled: true,
  includeOwnerPrivate: true,
  maxReflectionDelta: 0.30,
  maxEventsPerReflection: 3,
  decay: {
    valencePositiveHalfLifeH: 30,
    valenceNegativeHalfLifeH: 20,
    arousalHalfLifeH: 6,
    energyHalfLifeH: 10
  },
  setPoint: { enabled: true, alpha: 0.02, min: 0, max: 0.30 },
  circadian: { enabled: true },
  budgets: { maxHour: 0.35, maxDay: 0.60 },
  eventNudge: { enabled: false, minIntensity: 3, maxPerHour: 2, maxPerDay: 6, maxDelta: 0.20 },
  history: { enabled: true, keepDays: 180 }
});

export const PERSONA_LIMITS = Object.freeze({
  maxInterests: MAX_INTERESTS,
  maxLearnings: MAX_LEARNINGS,
  maxQuirks: MAX_QUIRKS,
  maxDelta: 0.15,
  maxInterestDelta: 0.2,
  learningsTtlMs: LEARNINGS_TTL_MS
});

function clamp(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, maxChars) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function cleanTopic(value) {
  return cleanText(value, 24).replace(/^[#＃\s]+/, '');
}

function normalizeLearnings(raw, now) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = cleanText(typeof item === 'string' ? item : item?.text, MAX_LEARNING_CHARS);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const at = Number(typeof item === 'object' ? item?.at : now) || now;
    if (now - at > LEARNINGS_TTL_MS) continue;
    out.push({ text, at });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, MAX_LEARNINGS);
}

function normalizeInterests(raw, now) {
  const map = new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const topic = cleanTopic(typeof item === 'string' ? item : item?.topic);
    if (!topic) continue;
    const key = topic.toLowerCase();
    const weight = clamp(item?.weight, 0.05, 1, 0.4);
    const lastMentioned = Number(item?.lastMentioned) || now;
    const prev = map.get(key);
    if (prev) {
      prev.weight = Math.max(prev.weight, weight);
      prev.lastMentioned = Math.max(prev.lastMentioned, lastMentioned);
    } else {
      map.set(key, { topic, weight, lastMentioned });
    }
  }
  const list = [...map.values()].sort((a, b) => b.weight - a.weight);
  if (list.length === 0) return defaultPersonaState(now).interests;
  return list.slice(0, MAX_INTERESTS);
}

function normalizeQuirks(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = cleanText(item, MAX_QUIRK_CHARS);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.slice(-MAX_QUIRKS);
}

export function moodTierLabel(valence, arousal) {
  const v = clamp(valence, -1, 1, 0);
  const a = clamp(arousal, 0, 1, 0.4);
  if (v >= 0.50) return a >= 0.60 ? '很开心，有点兴奋' : '心情很好，懒洋洋的';
  if (v >= 0.30) return a >= 0.60 ? '开心且有精神' : '心情不错，松弛';
  if (v >= 0.12) return a >= 0.60 ? '挺有精神' : '轻快 / 平静偏开心';
  if (v > -0.08) return a >= 0.60 ? '有点躁，静不下来' : '平平的，没什么起伏';
  if (v > -0.30) return a >= 0.60 ? '有点烦，但压得住' : '有点闷 / 低落';
  return '不太开心，想安静一会儿';
}

function labelConflicts(candidate, tier, valence) {
  const text = String(candidate || '');
  if (!text) return true;
  if (valence >= 0.30 && /(低落|难过|烦|闷|丧|沮丧|不想说话|累)/.test(text)) return true;
  if (valence <= -0.08 && /(开心|兴奋|雀跃|元气|飘|得意|超棒)/.test(text)) return true;
  if (valence > -0.08 && valence < 0.12 && /(兴奋|超级|难过|很低落|崩溃)/.test(text)) return true;
  return false;
}

export function chooseMoodLabel(valence, arousal, candidate = '') {
  const tier = moodTierLabel(valence, arousal);
  const raw = cleanText(candidate, MAX_LABEL_CHARS);
  if (!raw || labelConflicts(raw, tier, valence)) return { label: tier, labelRaw: raw };
  return { label: raw, labelRaw: raw };
}

export function defaultPersonaState(now = Date.now()) {
  return {
    version: 2,
    mood: {
      valence: DEFAULT_SETPOINT,
      arousal: 0.44,
      label: moodTierLabel(DEFAULT_SETPOINT, 0.44),
      cause: '',
      setPoint: DEFAULT_SETPOINT,
      lastEventAt: 0,
      lastDecayAt: now,
      budget: { hourKey: '', hourNet: 0, dayKey: '', dayNet: 0 },
      nudgeSeen: [],
      nudgeTimes: []
    },
    energy: 0.58,
    interests: [
      { topic: '猫', weight: 0.6, lastMentioned: now },
      { topic: '独立游戏', weight: 0.5, lastMentioned: now },
      { topic: '音乐', weight: 0.45, lastMentioned: now }
    ],
    learnings: [],
    quirks: [],
    updatedAt: now,
    changelog: []
  };
}

function normalizeBudget(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    hourKey: String(b.hourKey || ''),
    hourNet: clamp(b.hourNet, -0.6, 0.6, 0),
    dayKey: String(b.dayKey || ''),
    dayNet: clamp(b.dayNet, -1, 1, 0)
  };
}

export function normalizePersonaState(raw, now = Date.now()) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const mood = base.mood && typeof base.mood === 'object' ? base.mood : {};
  const valence = clamp(mood.valence, -1, 1, DEFAULT_SETPOINT);
  const arousal = clamp(mood.arousal, 0, 1, 0.44);
  const version = Number(base.version) || 1;
  // v1 没有 setPoint：按旧 valence 推一个温和起点，之后由真实事件缓慢漂移。
  const setPoint = Number.isFinite(Number(mood.setPoint))
    ? clamp(mood.setPoint, 0, 0.30, DEFAULT_SETPOINT)
    : clamp(0.08 + 0.3 * (valence - 0.15), 0, 0.30, DEFAULT_SETPOINT);
  const lastDecayAt = Number(mood.lastDecayAt) || Number(base.updatedAt) || now;
  return {
    version: Math.max(2, version),
    mood: {
      valence,
      arousal,
      label: cleanText(mood.label, MAX_LABEL_CHARS) || moodTierLabel(valence, arousal),
      cause: cleanText(mood.cause, 20),
      setPoint,
      lastEventAt: Number(mood.lastEventAt) || 0,
      lastDecayAt,
      budget: normalizeBudget(mood.budget),
      nudgeSeen: Array.isArray(mood.nudgeSeen) ? mood.nudgeSeen.slice(-50) : [],
      nudgeTimes: Array.isArray(mood.nudgeTimes) ? mood.nudgeTimes.slice(-100) : []
    },
    energy: clamp(base.energy, 0, 1, 0.58),
    interests: normalizeInterests(base.interests, now),
    learnings: normalizeLearnings(base.learnings, now),
    quirks: normalizeQuirks(base.quirks),
    updatedAt: Number(base.updatedAt) || now,
    changelog: Array.isArray(base.changelog) ? base.changelog.slice(-MAX_CHANGELOG) : []
  };
}

export function decayValue(value, base, halfLifeMs, elapsedMs) {
  const v = Number(value);
  const b = Number(base);
  const hl = Math.max(1, Number(halfLifeMs) || 1);
  const dt = Math.max(0, Number(elapsedMs) || 0);
  if (!Number.isFinite(v) || !Number.isFinite(b)) return b;
  return b + (v - b) * (2 ** (-dt / hl));
}

// 北京时间的精力锚点：上午高、午后小降、夜里低。线性插值，比单一余弦更像人。
const ENERGY_ANCHORS = [
  [0, 0.42], [3, 0.36], [6, 0.42], [9, 0.62], [12, 0.58],
  [15, 0.55], [18, 0.60], [21, 0.52], [24, 0.42]
];

export function targetEnergyAt(now = Date.now()) {
  const p = beijingParts(now);
  const hour = p.hour + (p.minute || 0) / 60;
  let lo = ENERGY_ANCHORS[0];
  let hi = ENERGY_ANCHORS[ENERGY_ANCHORS.length - 1];
  for (let i = 0; i < ENERGY_ANCHORS.length - 1; i += 1) {
    if (hour >= ENERGY_ANCHORS[i][0] && hour <= ENERGY_ANCHORS[i + 1][0]) {
      lo = ENERGY_ANCHORS[i];
      hi = ENERGY_ANCHORS[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const t = Math.min(1, Math.max(0, (hour - lo[0]) / span));
  const value = lo[1] + (hi[1] - lo[1]) * t;
  return clamp(value, 0.30, 0.75, 0.55);
}

export function targetArousalAt(now = Date.now()) {
  const p = beijingParts(now);
  const hour = p.hour + (p.minute || 0) / 60;
  return clamp(0.45 + 0.05 * Math.cos((2 * Math.PI * (hour - 15)) / 24), 0.35, 0.55, 0.45);
}

function mapIntensity(intensity, direction, table) {
  const i = Math.max(1, Math.min(5, Math.round(Number(intensity) || 1)));
  const sign = direction === 'negative' || direction === 'down' ? -1 : 1;
  return sign * table[i - 1];
}

function normalizeEvents(reflection) {
  const list = Array.isArray(reflection?.events) ? reflection.events : [];
  return list.slice(0, 3).map((item) => {
    const intensity = Math.max(1, Math.min(5, Math.round(Number(item?.intensity) || 1)));
    const valence = String(item?.valence || 'positive').toLowerCase() === 'negative' ? 'negative' : 'positive';
    const arousalRaw = String(item?.arousal || 'none').toLowerCase();
    const arousal = ['up', 'down', 'none'].includes(arousalRaw) ? arousalRaw : 'none';
    return {
      what: cleanText(item?.what, 30),
      intensity,
      valence,
      arousal,
      cause: cleanText(item?.cause, 12),
      sourceMessageId: item?.sourceMessageId ?? null
    };
  }).filter((item) => item.what || item.cause);
}

function normalizeEnergyInput(input) {
  if (input && typeof input === 'object') {
    const intensity = Math.max(1, Math.min(5, Math.round(Number(input.intensity) || 1)));
    const direction = String(input.direction || 'up').toLowerCase() === 'down' ? 'down' : 'up';
    return mapIntensity(intensity, direction, ENERGY_DELTA);
  }
  return clamp(input, -PERSONA_LIMITS.maxDelta, PERSONA_LIMITS.maxDelta, 0);
}

function budgetKeys(now) {
  const p = beijingParts(now);
  return {
    hourKey: `${p.dateKey}-${String(p.hour).padStart(2, '0')}`,
    dayKey: p.dateKey
  };
}

function ensureBudget(state, now, cfg = {}) {
  const keys = budgetKeys(now);
  const b = state.mood.budget;
  if (b.hourKey !== keys.hourKey) {
    b.hourKey = keys.hourKey;
    b.hourNet = 0;
  }
  if (b.dayKey !== keys.dayKey) {
    b.dayKey = keys.dayKey;
    b.dayNet = 0;
  }
  return {
    maxHour: Number(cfg?.budgets?.maxHour) > 0 ? Number(cfg.budgets.maxHour) : MOOD_V3_DEFAULTS.budgets.maxHour,
    maxDay: Number(cfg?.budgets?.maxDay) > 0 ? Number(cfg.budgets.maxDay) : MOOD_V3_DEFAULTS.budgets.maxDay
  };
}

function applyValenceBudget(state, delta, cfg, now) {
  const limits = ensureBudget(state, now, cfg);
  const b = state.mood.budget;
  const usedHour = Math.abs(Number(b.hourNet) || 0);
  const usedDay = Math.abs(Number(b.dayNet) || 0);
  const cap = Math.max(0, Math.min(limits.maxHour - usedHour, limits.maxDay - usedDay));
  const applied = Math.max(-cap, Math.min(cap, Number(delta) || 0));
  b.hourNet = clamp((Number(b.hourNet) || 0) + applied, -1, 1, 0);
  b.dayNet = clamp((Number(b.dayNet) || 0) + applied, -1, 1, 0);
  return applied;
}

/**
 * v2/v3 反思：先按真实时间衰减，再叠加强度事件/旧格式增量，最后更新设定点。
 * @param {object} previous 旧状态
 * @param {object} reflection 反思 JSON
 * @param {{now?:number, cfg?:object, rested?:boolean}} [options]
 */
export function applyReflectionV3(previous, reflection, { now = Date.now(), cfg = {}, rested = false } = {}) {
  const state = normalizePersonaState(previous, now);
  const input = reflection && typeof reflection === 'object' ? reflection : {};
  const before = { v: state.mood.valence, a: state.mood.arousal, e: state.energy };
  const oldLabel = state.mood.label;
  const changes = [];

  const moodCfg = { ...MOOD_V3_DEFAULTS, ...(cfg || {}) };
  const decayCfg = { ...MOOD_V3_DEFAULTS.decay, ...(cfg?.decay || {}) };
  const decayMs = Math.max(0, Math.min(7 * 24 * HOUR_MS, now - state.mood.lastDecayAt));

  const positive = state.mood.valence >= state.mood.setPoint;
  const vHalf = (positive ? decayCfg.valencePositiveHalfLifeH : decayCfg.valenceNegativeHalfLifeH) * HOUR_MS;
  let v = decayValue(state.mood.valence, state.mood.setPoint, vHalf, decayMs);
  let a = decayValue(state.mood.arousal, targetArousalAt(now), decayCfg.arousalHalfLifeH * HOUR_MS, decayMs);
  let e = decayValue(state.energy, targetEnergyAt(now), decayCfg.energyHalfLifeH * HOUR_MS, decayMs);

  const events = normalizeEvents(input);
  let source = events.length ? 'events' : 'empty';
  let vDelta = 0;
  let aDelta = 0;
  let cause = cleanText(input.moodCause, 20) || state.mood.cause;

  if (events.length) {
    const eventV = events.slice(0, MOOD_V3_DEFAULTS.maxEventsPerReflection).map((event) => {
      const base = mapIntensity(event.intensity, event.valence, VALENCE_DELTA);
      return event.valence === 'negative' ? Math.max(-MOOD_V3_DEFAULTS.maxReflectionDelta, base * 1.1) : Math.min(MOOD_V3_DEFAULTS.maxReflectionDelta, base);
    });
    vDelta = applyValenceBudget(state, eventV.reduce((sum, x) => sum + x, 0), moodCfg, now);
    for (const event of events.slice(0, MOOD_V3_DEFAULTS.maxEventsPerReflection)) {
      if (event.arousal === 'none') continue;
      aDelta += mapIntensity(event.intensity, event.arousal === 'down' ? 'down' : 'positive', AROUSAL_DELTA);
    }
    const lastWithCause = [...events].reverse().find((event) => event.cause);
    if (lastWithCause?.cause) cause = lastWithCause.cause;
  } else if (input.mood && typeof input.mood === 'object') {
    // 旧格式：仍接受小数增量，但套用同样的每小时/每天上限。
    const rawV = clamp(input.mood.valence, -PERSONA_LIMITS.maxDelta, PERSONA_LIMITS.maxDelta, 0);
    const rawA = clamp(input.mood.arousal, -PERSONA_LIMITS.maxDelta, PERSONA_LIMITS.maxDelta, 0);
    vDelta = applyValenceBudget(state, rawV, moodCfg, now);
    aDelta = rawA;
    source = 'legacy';
  }

  v = clamp(v + vDelta, -1, 1, v);
  a = clamp(a + aDelta, 0, 1, a);
  const energyDelta = normalizeEnergyInput(input.energy);
  e = clamp(e + energyDelta + (rested ? 0.06 : 0), 0, 1, e);

  if (moodCfg.setPoint?.enabled !== false) {
    const alpha = clamp(moodCfg.setPoint?.alpha, 0, 0.2, 0.02);
    const min = clamp(moodCfg.setPoint?.min, 0, 0.3, 0);
    const max = clamp(moodCfg.setPoint?.max, min, 0.3, 0.3);
    state.mood.setPoint = clamp(state.mood.setPoint + alpha * (v - state.mood.setPoint), min, max, state.mood.setPoint);
  }

  const labelInfo = chooseMoodLabel(v, a, input.moodCause || input.mood?.label || '');
  state.mood.valence = v;
  state.mood.arousal = a;
  state.energy = e;
  state.mood.label = labelInfo.label;
  state.mood.cause = cause;
  state.mood.lastDecayAt = now;
  if (events.length || vDelta !== 0 || aDelta !== 0 || energyDelta !== 0) state.mood.lastEventAt = now;
  state.updatedAt = now;

  if (Math.abs(v - before.v) >= 0.01 || Math.abs(a - before.a) >= 0.01 || Math.abs(e - before.e) >= 0.01) {
    changes.push(`心情 → ${state.mood.label}`);
  }
  if (Math.abs(e - before.e) >= 0.01) changes.push(`精力 ${e >= before.e ? '+' : ''}${(e - before.e).toFixed(2)}`);
  for (const event of events) {
    if (event.what) changes.push(`事件「${event.what}」强度 ${event.intensity}`);
  }

  // 兴趣/学习/口癖沿用 v1 的稳定处理，避免心情改造顺手改坏长期记忆。
  const interestInputs = Array.isArray(input.interests) ? input.interests : [];
  for (const item of interestInputs.slice(0, 8)) {
    const change = bumpInterest(state, item?.topic, item?.delta ?? 0.1, now);
    if (change) changes.push(change);
  }
  state.interests = state.interests
    .filter((item) => item.weight >= 0.12)
    .sort((a, b) => b.weight - a.weight);
  if (state.interests.length === 0) state.interests = defaultPersonaState(now).interests;
  state.interests = state.interests.slice(0, MAX_INTERESTS);

  const learningInputs = Array.isArray(input.learnings) ? input.learnings : [];
  const existingLearnings = new Set(state.learnings.map((item) => item.text.toLowerCase()));
  for (const raw of learningInputs.slice(0, 5)) {
    const text = cleanText(raw, MAX_LEARNING_CHARS);
    if (!text || existingLearnings.has(text.toLowerCase())) continue;
    existingLearnings.add(text.toLowerCase());
    state.learnings.unshift({ text, at: now });
    changes.push(`学到「${text}」`);
  }
  state.learnings = state.learnings.filter((item) => now - Number(item.at || now) <= LEARNINGS_TTL_MS).slice(0, MAX_LEARNINGS);

  const quirkInputs = Array.isArray(input.quirks) ? input.quirks : [];
  for (const raw of quirkInputs.slice(0, 3)) {
    const text = cleanText(raw, MAX_QUIRK_CHARS);
    if (!text || state.quirks.includes(text)) continue;
    state.quirks.push(text);
    changes.push(`口癖「${text}」`);
  }
  state.quirks = state.quirks.slice(-MAX_QUIRKS);

  if (changes.length > 0) {
    state.changelog.push({ at: now, changes: changes.slice(0, 12) });
    state.changelog = state.changelog.slice(-MAX_CHANGELOG);
  }

  return {
    state,
    changes,
    meta: {
      source,
      events,
      before,
      after: { v, a, e },
      delta: { v: v - before.v, a: a - before.a, e: e - before.e },
      label: state.mood.label,
      labelRaw: labelInfo.labelRaw || oldLabel
    }
  };
}

function bumpInterest(state, topicRaw, deltaRaw, now) {
  const topic = cleanTopic(topicRaw);
  if (!topic) return null;
  const delta = clamp(deltaRaw, -PERSONA_LIMITS.maxInterestDelta, PERSONA_LIMITS.maxInterestDelta, 0.1);
  const key = topic.toLowerCase();
  const existing = state.interests.find((item) => item.topic.toLowerCase() === key);
  if (existing) {
    existing.weight = clamp(existing.weight + delta, 0.05, 1, existing.weight);
    existing.lastMentioned = now;
    return `${delta >= 0 ? '更迷' : '淡了'}「${existing.topic}」(${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`;
  }
  if (delta <= 0) return null;
  state.interests.push({ topic, weight: clamp(0.4 + delta, 0.05, 1, 0.4), lastMentioned: now });
  return `新兴趣「${topic}」`;
}

/**
 * v1 兼容路径：关闭 mood v3 时仍按旧逻辑（每次反思向 0.15/0.45 衰减 20%）。
 */
export function applyReflection(previous, reflection, now = Date.now()) {
  const state = normalizePersonaState(previous, now);
  const input = reflection && typeof reflection === 'object' ? reflection : {};
  const changes = [];
  const oldMood = { ...state.mood };
  const oldEnergy = state.energy;
  state.mood.valence += (BASELINE.valence - state.mood.valence) * 0.2;
  state.mood.arousal += (BASELINE.arousal - state.mood.arousal) * 0.2;
  state.energy += (0.55 - state.energy) * 0.15;
  for (const item of state.interests) item.weight = clamp(item.weight * 0.97, 0.05, 1, item.weight);

  if (input.mood && typeof input.mood === 'object') {
    const dv = clamp(input.mood.valence, -PERSONA_LIMITS.maxDelta, PERSONA_LIMITS.maxDelta, 0);
    const da = clamp(input.mood.arousal, -PERSONA_LIMITS.maxDelta, PERSONA_LIMITS.maxDelta, 0);
    if (dv !== 0) state.mood.valence = clamp(state.mood.valence + dv, -1, 1, state.mood.valence);
    if (da !== 0) state.mood.arousal = clamp(state.mood.arousal + da, 0, 1, state.mood.arousal);
    state.mood.label = cleanText(input.mood.label, MAX_LABEL_CHARS) || moodTierLabel(state.mood.valence, state.mood.arousal);
    if (Math.abs(state.mood.valence - oldMood.valence) >= 0.01 || Math.abs(state.mood.arousal - oldMood.arousal) >= 0.01) {
      changes.push(`心情 → ${state.mood.label}`);
    }
  } else {
    state.mood.label = moodTierLabel(state.mood.valence, state.mood.arousal);
  }

  const de = clamp(input.energy, -PERSONA_LIMITS.maxDelta, PERSONA_LIMITS.maxDelta, 0);
  if (de !== 0) {
    state.energy = clamp(state.energy + de, 0, 1, state.energy);
    if (Math.abs(state.energy - oldEnergy) >= 0.01) changes.push(`精力 ${de >= 0 ? '+' : ''}${de.toFixed(2)}`);
  }

  for (const item of (Array.isArray(input.interests) ? input.interests : []).slice(0, 8)) {
    const change = bumpInterest(state, item?.topic, item?.delta ?? 0.1, now);
    if (change) changes.push(change);
  }
  state.interests = state.interests.filter((item) => item.weight >= 0.12).sort((a, b) => b.weight - a.weight);
  if (state.interests.length === 0) state.interests = defaultPersonaState(now).interests;
  state.interests = state.interests.slice(0, MAX_INTERESTS);

  const existingLearnings = new Set(state.learnings.map((item) => item.text.toLowerCase()));
  for (const raw of (Array.isArray(input.learnings) ? input.learnings : []).slice(0, 5)) {
    const text = cleanText(raw, MAX_LEARNING_CHARS);
    if (!text || existingLearnings.has(text.toLowerCase())) continue;
    existingLearnings.add(text.toLowerCase());
    state.learnings.unshift({ text, at: now });
    changes.push(`学到「${text}」`);
  }
  state.learnings = state.learnings.filter((item) => now - Number(item.at || now) <= LEARNINGS_TTL_MS).slice(0, MAX_LEARNINGS);

  for (const raw of (Array.isArray(input.quirks) ? input.quirks : []).slice(0, 3)) {
    const text = cleanText(raw, MAX_QUIRK_CHARS);
    if (!text || state.quirks.includes(text)) continue;
    state.quirks.push(text);
    changes.push(`口癖「${text}」`);
  }
  state.quirks = state.quirks.slice(-MAX_QUIRKS);

  state.mood.lastDecayAt = now;
  if (changes.length > 0) {
    state.changelog.push({ at: now, changes: changes.slice(0, 12) });
    state.changelog = state.changelog.slice(-MAX_CHANGELOG);
    state.updatedAt = now;
  }
  return { state, changes, meta: { source: 'legacy-v1', before: oldMood, after: { ...state.mood }, delta: {} } };
}

export function applyMoodNudge(previous, event, { now = Date.now(), cfg = {}, dryRun = false } = {}) {
  const state = normalizePersonaState(previous, now);
  const moodCfg = { ...MOOD_V3_DEFAULTS, ...(cfg || {}) };
  const nudgeCfg = { ...MOOD_V3_DEFAULTS.eventNudge, ...(cfg?.eventNudge || {}) };
  const input = normalizeEvents({ events: [event] })[0];
  if (!input) return { status: 'invalid', error: '缺少事件内容' };
  if (input.intensity < (Number(nudgeCfg.minIntensity) || 3)) {
    return { status: 'weak', error: `强度需 ≥ ${Number(nudgeCfg.minIntensity) || 3}` };
  }
  const key = `${input.cause || input.what}|${input.sourceMessageId ?? ''}`;
  const seen = (state.mood.nudgeSeen || []).filter((item) => now - Number(item.at || 0) < 24 * HOUR_MS);
  if (seen.some((item) => item.key === key)) return { status: 'duplicate', error: '同一事件已经记过' };
  const times = (state.mood.nudgeTimes || []).filter((t) => now - Number(t) < 24 * HOUR_MS);
  const hourCount = times.filter((t) => now - Number(t) < HOUR_MS).length;
  if (hourCount >= (Number(nudgeCfg.maxPerHour) || 2)) return { status: 'limited', error: '本小时即时心情事件已达上限' };
  if (times.length >= (Number(nudgeCfg.maxPerDay) || 6)) return { status: 'limited', error: '今天即时心情事件已达上限' };

  const before = { v: state.mood.valence, a: state.mood.arousal, e: state.energy };
  const decayCfg = { ...MOOD_V3_DEFAULTS.decay, ...(cfg?.decay || {}) };
  const decayMs = Math.max(0, Math.min(7 * 24 * HOUR_MS, now - state.mood.lastDecayAt));
  const positive = state.mood.valence >= state.mood.setPoint;
  const vHalf = (positive ? decayCfg.valencePositiveHalfLifeH : decayCfg.valenceNegativeHalfLifeH) * HOUR_MS;
  let v = decayValue(state.mood.valence, state.mood.setPoint, vHalf, decayMs);
  let a = decayValue(state.mood.arousal, targetArousalAt(now), decayCfg.arousalHalfLifeH * HOUR_MS, decayMs);
  const e = decayValue(state.energy, targetEnergyAt(now), decayCfg.energyHalfLifeH * HOUR_MS, decayMs);

  const maxDelta = Number(nudgeCfg.maxDelta) > 0 ? Number(nudgeCfg.maxDelta) : 0.2;
  let eventV = mapIntensity(input.intensity, input.valence, VALENCE_DELTA);
  if (input.valence === 'negative') eventV *= 1.1;
  eventV = Math.max(-maxDelta, Math.min(maxDelta, eventV));
  const vDelta = applyValenceBudget(state, eventV, moodCfg, now);
  const aDelta = input.arousal === 'none' ? 0 : mapIntensity(input.intensity, input.arousal === 'down' ? 'down' : 'positive', AROUSAL_DELTA);
  v = clamp(v + vDelta, -1, 1, v);
  a = clamp(a + aDelta, 0, 1, a);

  const labelInfo = chooseMoodLabel(v, a, input.cause || input.what);
  state.mood.valence = v;
  state.mood.arousal = a;
  state.energy = e;
  state.mood.label = labelInfo.label;
  state.mood.cause = input.cause || input.what;
  state.mood.lastEventAt = now;
  state.mood.lastDecayAt = now;
  state.updatedAt = now;
  if (!dryRun) {
    state.mood.nudgeSeen = [...seen, { key, at: now }].slice(-50);
    state.mood.nudgeTimes = [...times, now].slice(-100);
  }
  return {
    status: 'ok',
    state,
    changes: [`即时心情 → ${state.mood.label}`, `事件「${input.what || input.cause}」强度 ${input.intensity}`],
    meta: {
      source: 'nudge',
      events: [input],
      before,
      after: { v, a, e },
      delta: { v: v - before.v, a: a - before.a, e: e - before.e },
      label: state.mood.label,
      labelRaw: labelInfo.labelRaw || ''
    }
  };
}

export function renderPersonaStateBlock(state) {
  const s = normalizePersonaState(state);
  const moods = s.mood.label || '说不上来';
  const cause = String(s.mood.cause || '').trim();
  const interests = s.interests.slice(0, 3).map((item) => item.topic).join('、') || '还没什么特别迷的';
  const learnings = s.learnings.slice(0, 2).map((item) => item.text).join('；');
  const quirk = s.quirks.length ? s.quirks[s.quirks.length - 1] : '';
  let line = `【你现在的状态】心情：${moods}${cause ? `（因为${cause}）` : ''}（精力 ${Math.round(s.energy * 100)}%）；最近在迷：${interests}`;
  if (learnings) line += `；最近学到：${learnings}`;
  if (quirk) line += `；口癖：${quirk}`;
  return line.length > 300 ? `${line.slice(0, 297)}…` : line;
}

export function describePersonaState(state) {
  const s = normalizePersonaState(state);
  const interests = s.interests.map((item) => `${item.topic}(${item.weight.toFixed(2)})`).join('、') || '无';
  const learnings = s.learnings.map((item) => item.text).join('；') || '无';
  const quirks = s.quirks.join('；') || '无';
  return [
    `心情：${s.mood.label}（valence ${s.mood.valence.toFixed(2)} / arousal ${s.mood.arousal.toFixed(2)}）`,
    `设定点：${Number(s.mood.setPoint).toFixed(2)}${s.mood.cause ? ` · 最近原因：${s.mood.cause}` : ''}`,
    `精力：${Math.round(s.energy * 100)}%`,
    `兴趣：${interests}`,
    `最近学到：${learnings}`,
    `口癖：${quirks}`
  ].join('\n');
}
