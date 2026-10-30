// 唤醒价值评分：在「便宜、无需模型」的信号上决定这条消息值不值得唤醒 DSH。
//
// 硬规则：@、引用机器人、私聊、明确提问、关键词命中 —— 这些是「被叫」，**必须直达唤醒**，
// 评分只作用于泛监听（anyMessage / 概率 / 指定成员）与主动机会。
//
// 分数范围 0~1：
//   ≥ wakeThreshold  → wake
//   ≥ deferThreshold → defer（本轮不唤醒，留给下一批/下一次机会）
//   <  deferThreshold → ignore（只记录）

export const VALUE_SCORE_DEFAULTS = Object.freeze({
  enabled: true,
  wakeThreshold: 0.55,
  deferThreshold: 0.32,
  recentSelfPenalty: 0.05,
  recentSelfWindowMs: 10 * 60 * 1000,
  duplicateWindowMs: 10 * 60 * 1000,
  nightPenalty: 0.25,
  duplicatePenalty: 0.3,
  shortTextPenalty: 0.12,
  minTextChars: 3
});

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
}

/** 话题相关度：当前消息与进行中话题的 2-gram 重合度（0~1，便宜且对中文有效）。 */
export function topicOverlapScore(text, topics = []) {
  const norm = normalizeText(text);
  if (norm.length < 2) return 0;
  const grams = new Set();
  for (let i = 0; i < norm.length - 1; i += 1) {
    const g = norm.slice(i, i + 2);
    if (g.trim().length === 2) grams.add(g);
  }
  if (!grams.size) return 0;
  const topicGrams = new Set();
  for (const t of topics) {
    const s = normalizeText(typeof t === 'string' ? t : (t?.text ?? t?.topic ?? ''));
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      if (g.trim().length === 2) topicGrams.add(g);
    }
  }
  if (!topicGrams.size) return 0;
  let shared = 0;
  for (const g of grams) if (topicGrams.has(g)) shared += 1;
  return clamp01(shared / Math.min(12, grams.size + 2));
}

/** 从会话状态里提取评分输入需要的统计量。 */
export function scoreInputsFromState(st, { sender = '', text = '', now = Date.now(), cfg = VALUE_SCORE_DEFAULTS } = {}) {
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const windowMs = Number(cfg.recentSelfWindowMs) || VALUE_SCORE_DEFAULTS.recentSelfWindowMs;
  const duplicateWindowMs = Number(cfg.duplicateWindowMs) || VALUE_SCORE_DEFAULTS.duplicateWindowMs;
  const norm = normalizeText(text);
  const recentSelfCount = recent.filter((m) => m && m.isSelf && now - Number(m.time || 0) < windowMs).length;
  const duplicateCount = norm
    ? recent.filter((m) => m && !m.isSelf && now - Number(m.time || 0) < duplicateWindowMs
      && normalizeText(m.plain ?? m.text) === norm).length
    : 0;
  const impression = st?.memberImpressions && typeof st.memberImpressions === 'object'
    ? st.memberImpressions[sender] : null;
  const familiarity = clamp01((Number(impression?.interactionCount) || 0) / 20);
  return {
    recentSelfCount,
    duplicateCount,
    familiarity,
    topicOverlap: topicOverlapScore(text, st?.activeTopics ?? [])
  };
}

/**
 * @param {object} input
 * @param {string} input.text
 * @param {boolean} input.isAt / isQuoteSelf / isPrivate / isQuestion / isKeyword / isPoke
 * @param {boolean} input.night
 * @param {number} input.recentSelfCount
 * @param {number} input.duplicateCount
 * @param {number} input.topicOverlap 0~1
 * @param {number} input.familiarity 0~1
 * @param {boolean} input.hasMedia
 * @param {object} input.config
 * @returns {{score:number, action:'wake'|'defer'|'ignore', explicit:boolean, reasons:string[]}}
 */
export function scoreMessage(input = {}) {
  const cfg = { ...VALUE_SCORE_DEFAULTS, ...(input.config ?? {}) };
  const explicit = Boolean(input.isAt || input.isQuoteSelf || input.isPrivate || input.isQuestion);
  const reasons = [];
  if (explicit) {
    if (input.isPrivate) reasons.push('private');
    if (input.isAt) reasons.push('at');
    if (input.isQuoteSelf) reasons.push('quote-self');
    if (input.isQuestion) reasons.push('question');
    return { score: 1, action: 'wake', explicit: true, reasons };
  }
  const text = String(input.text ?? '');
  let score = 0.3;
  reasons.push('base');
  if (input.isKeyword) { score += 0.35; reasons.push('keyword'); }
  if (input.isPoke) { score += 0.2; reasons.push('poke'); }
  const overlap = clamp01(input.topicOverlap);
  if (overlap > 0) { score += overlap * 0.25; reasons.push(`topic:${overlap.toFixed(2)}`); }
  const familiarity = clamp01(input.familiarity);
  if (familiarity > 0) { score += familiarity * 0.15; reasons.push(`familiar:${familiarity.toFixed(2)}`); }
  if (input.hasMedia) { score += 0.05; reasons.push('media'); }
  if (!input.night) score += 0.05;

  const selfCount = Math.max(0, Number(input.recentSelfCount) || 0);
  if (selfCount > 0) {
    const penalty = Math.min(0.25, selfCount * (Number(cfg.recentSelfPenalty) || 0));
    score -= penalty;
    reasons.push(`self-penalty:${penalty.toFixed(2)}`);
  }
  if (Number(input.duplicateCount) > 0) {
    score -= Number(cfg.duplicatePenalty) || 0;
    reasons.push('duplicate');
  }
  if (input.night) { score -= Number(cfg.nightPenalty) || 0; reasons.push('night'); }
  const normalized = normalizeText(text);
  if (!normalized || normalized.length < (Number(cfg.minTextChars) || 3)) {
    score -= Number(cfg.shortTextPenalty) || 0;
    reasons.push('short');
  }
  score = clamp01(score);
  const action = score >= (Number(cfg.wakeThreshold) || 0.55)
    ? 'wake'
    : (score >= (Number(cfg.deferThreshold) || 0.32) ? 'defer' : 'ignore');
  return { score, action, explicit: false, reasons };
}
