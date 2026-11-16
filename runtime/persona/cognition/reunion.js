// 重逢唤醒：久别后第一次开口时，给模型一条“提一句共同经历”的提示。
// 只生成提示词，不自动发消息；开关关闭时调用方拿到空串，行为与改动前一致。
//
// 为什么要在入站时记一笔：关系记账会立刻把 lastInteractionAt 改成当前消息时间，
// 等拼提示词时再读就已经看不到“这次隔了几天”。所以 noteReunionInteraction()
// 在 observe 之前捕获旧值，只在 ≥gapDays 的回归时刷新锚点；
// 同一轮重逢期间后续消息不会覆盖锚点，planReunion() 再保证只提示一次。

import { effectiveExperienceStrength } from './experience.js';

export const REUNION_DAY_MS = 24 * 3600 * 1000;
export const REUNION_HOUR_MS = 3600 * 1000;
export const REUNION_DEFAULTS = Object.freeze({
  gapDays: 7,
  cooldownHours: 72
});

// 负面冲突类不进重逢提示：valence=negative 已排除，这里兜底摘要里的冲突语义。
const CONFLICT_RE = /冲突|吵架|争执|闹翻|冷战|翻脸/;
const CYCLE_TTL_MS = 90 * REUNION_DAY_MS;

export function reunionId(key, userId) {
  const k = String(key ?? '').trim();
  const u = String(userId ?? '').trim();
  return k && u ? `${k}\u0000${u}` : '';
}

/** 一条经历能否用来破冰：有摘要、非负面、且发生在这次久别之前。 */
export function isReunionEpisode(episode, { before = Infinity } = {}) {
  if (!episode || !String(episode.summary ?? '').trim()) return false;
  if (String(episode.valence ?? '').toLowerCase() === 'negative') return false;
  if (CONFLICT_RE.test(`${episode.topic ?? ''} ${episode.summary ?? ''}`)) return false;
  const occurredAt = Number(episode.occurredAt ?? episode.occurred_at);
  if (!Number.isFinite(occurredAt)) return false;
  return occurredAt <= Number(before);
}

/** 在关系记账之前捕获回归间隔；同一轮只刷新一次锚点。 */
export function noteReunionInteraction(store, {
  key,
  userId,
  priorLastInteractionAt,
  now = Date.now(),
  gapDays = REUNION_DEFAULTS.gapDays
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') return null;
  const id = reunionId(key, userId);
  const last = Number(priorLastInteractionAt);
  const at = Number(now);
  if (!id || !Number.isFinite(last) || last <= 0 || !Number.isFinite(at)) return null;
  if (at - last < Number(gapDays) * REUNION_DAY_MS) return null;
  const prev = store.get(id);
  if (prev && Number(prev.anchor) >= last) return prev;
  if (store.size > 500) {
    for (const [entryId, entry] of store) {
      if (at - Number(entry?.returnedAt || 0) > CYCLE_TTL_MS) store.delete(entryId);
    }
  }
  const cycle = { anchor: last, returnedAt: at };
  store.set(id, cycle);
  return cycle;
}

/**
 * 纯判定：够久别、没过限频、这一轮还没提示过，才从经历里挑最强的一条。
 * lastReunionAt >= lastInteractionAt 表示同一轮已经破过冰。
 */
export function planReunion({
  lastInteractionAt,
  now = Date.now(),
  episodes = [],
  gapDays = REUNION_DEFAULTS.gapDays,
  cooldownHours = REUNION_DEFAULTS.cooldownHours,
  lastReunionAt = 0
} = {}) {
  const at = Number(now);
  const last = Number(lastInteractionAt);
  if (!Number.isFinite(at) || !Number.isFinite(last) || last <= 0) return null;
  const gapMs = at - last;
  if (gapMs < Number(gapDays) * REUNION_DAY_MS) return null;
  const fired = Number(lastReunionAt) || 0;
  if (fired > 0 && at - fired < Number(cooldownHours) * REUNION_HOUR_MS) return null;
  if (fired > 0 && fired >= last) return null;

  const candidates = (Array.isArray(episodes) ? episodes : [])
    .filter((episode) => isReunionEpisode(episode, { before: last }));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const sa = Number.isFinite(a.effectiveStrength) ? a.effectiveStrength : effectiveExperienceStrength(a, { now: at });
    const sb = Number.isFinite(b.effectiveStrength) ? b.effectiveStrength : effectiveExperienceStrength(b, { now: at });
    return (sb - sa) || (Number(b.occurredAt) || 0) - (Number(a.occurredAt) || 0);
  });
  const episode = candidates[0];
  const days = Math.max(1, Math.floor(gapMs / REUNION_DAY_MS));
  const snippet = String(episode.summary).replace(/\s+/g, ' ').trim().slice(0, 80);
  const hint = `【重逢】上次聊到「${snippet}」——隔了 ${days} 天，可以顺口提一句，像刚想起来那样，不用郑重其事。`;
  return { episode, hint, gapDays: days };
}

/**
 * 拼提示词的单点：关闭时直接返回空串，且不触发经历查询。
 * 提示成功后把 firedAt 写回 cycle，保证同一轮只提示一次。
 */
export function reunionPromptLine({
  enabled = false,
  cycle = null,
  now = Date.now(),
  episodes = null,
  loadEpisodes = null,
  gapDays = REUNION_DEFAULTS.gapDays,
  cooldownHours = REUNION_DEFAULTS.cooldownHours
} = {}) {
  if (enabled !== true || !cycle) return '';
  const list = Array.isArray(episodes)
    ? episodes
    : (typeof loadEpisodes === 'function' ? (loadEpisodes() || []) : []);
  const result = planReunion({
    lastInteractionAt: cycle.anchor,
    now,
    episodes: list,
    gapDays,
    cooldownHours,
    lastReunionAt: cycle.firedAt || 0
  });
  if (!result) return '';
  cycle.firedAt = Number(now) || Date.now();
  return `${result.hint}\n\n`;
}