// 群日报：把过去 24 小时的群聊压成一条可回顾的摘要。
//
// 设计取舍：
//   · **不调用模型**：只用已存储的 recentMessages/activeTopics/链接，零 token 成本；
//   · 默认关闭，按群开启（陌生群不刷屏）；
//   · 只输出统计与少量原文摘录，不做价值判断；
//   · 发送走桥接的 auditAndSend → outbox，和其他消息一样可重试。

import { safeCardUrl } from './rich-card.js';

const TZ_OFFSET_MS = 8 * 3600 * 1000; // Asia/Shanghai（无夏令时）

function pad(n) {
  return String(n).padStart(2, '0');
}

export function localDateKey(at = Date.now()) {
  const d = new Date(at + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 下一个 HH:MM（上海时间）的毫秒时间戳；已过则顺延到明天。 */
export function nextDailyAt(hhmm = '21:30', now = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  const hour = m ? Math.min(23, Math.max(0, Number(m[1]))) : 21;
  const minute = m ? Math.min(59, Math.max(0, Number(m[2]))) : 30;
  const local = new Date(now + TZ_OFFSET_MS);
  const targetLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, 0);
  let target = targetLocal - TZ_OFFSET_MS;
  if (target <= now) target += 24 * 3600 * 1000;
  return target;
}

function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function extractUrls(text) {
  const out = [];
  const re = /https?:\/\/[^\s，。；、）)\]}>"']+/gi;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const url = safeCardUrl(m[0]);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * @param {object} input
 * @param {string} input.key
 * @param {Array} input.messages recentMessages（会按 24h 过滤）
 * @param {Array} [input.topics] activeTopics
 * @param {string} [input.mood] persona mood
 * @param {number} [input.now]
 * @param {number} [input.maxItems]
 * @returns {{text:string, stats:object}}
 */
export function buildDailyReport({ key = '', messages = [], topics = [], mood = '', now = Date.now(), maxItems = 8 } = {}) {
  const since = now - 24 * 3600 * 1000;
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && Number(m.time) >= since)
    .sort((a, b) => Number(a.time) - Number(b.time));
  const selfMessages = list.filter((m) => m.isSelf);
  const human = list.filter((m) => !m.isSelf);
  const speakers = new Map();
  for (const msg of human) {
    const name = String(msg.sender || '群友').slice(0, 30);
    speakers.set(name, (speakers.get(name) || 0) + 1);
  }
  const topSpeakers = [...speakers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const links = [];
  for (const msg of human) {
    for (const url of extractUrls(msg.text || msg.plain)) {
      if (!links.includes(url)) links.push(url);
      if (links.length >= 5) break;
    }
    if (links.length >= 5) break;
  }
  const topicTexts = (Array.isArray(topics) ? topics : [])
    .slice(-6)
    .map((t) => String(t?.text ?? '').trim())
    .filter(Boolean);
  const highlights = human
    .filter((m) => String(m.plain || m.text || '').trim().length >= 6)
    .slice(-Math.max(1, Math.min(8, Number(maxItems) || 6)))
    .map((m) => `${String(m.sender || '群友').slice(0, 20)}：${truncate(m.plain || m.text, 60)}`);

  const date = localDateKey(now);
  const lines = [`【群日报 ${date}】`];
  lines.push(`消息 ${human.length} 条，你参与 ${selfMessages.length} 条${human.length ? `，${speakers.size} 位群友说话` : ''}`);
  if (topSpeakers.length) lines.push(`活跃：${topSpeakers.map(([name, count]) => `${name}(${count})`).join('、')}`);
  if (topicTexts.length) lines.push(`在聊：${topicTexts.join('；')}`);
  if (links.length) lines.push(`链接：\n${links.slice(0, 3).join('\n')}`);
  if (highlights.length) lines.push(`摘录：\n${highlights.map((l) => `· ${l}`).join('\n')}`);
  if (mood) lines.push(`你当时的心情：${truncate(mood, 30)}`);
  if (!human.length && !selfMessages.length) lines.push('过去 24 小时群里很安静');

  return {
    text: lines.join('\n'),
    stats: {
      date,
      key,
      human: human.length,
      self: selfMessages.length,
      speakers: speakers.size,
      links: links.length,
      topics: topicTexts.length
    }
  };
}

export function dailyReportEnabled(cfg, key) {
  const dr = cfg?.simulation?.dailyReport;
  if (!dr || dr.enabled !== true) return false;
  const groups = Array.isArray(dr.groups) ? dr.groups.map(String) : [];
  if (groups.includes(String(key))) return true;
  const profile = cfg?.simulation?.groupProfiles?.[key];
  return profile?.dailyReport === true;
}
