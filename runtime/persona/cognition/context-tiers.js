// 水层召回：表层 / 温跃层 / 深海，L0 摘要 → L1 要点 → L2 原文。
// 纯函数、无 IO；调用方在开关关闭时不使用本模块，旧路径逐字不变。
//
//   surface     最近 24 小时的消息（按条数/字数配额保留最新）
//   thermocline 30 天内的共同经历摘要（按有效强度排序）
//   deep        已巩固的观察（睡眠期整理产物），只给摘要

const DAY_MS = 24 * 3600 * 1000;

export const CONTEXT_TIER_DEFAULTS = Object.freeze({
  surfaceWindowMs: DAY_MS,
  thermoclineWindowMs: 30 * DAY_MS,
  surfaceMaxChars: 900,
  thermoclineMaxChars: 900,
  deepMaxChars: 600,
  surfaceLineChars: 120,
  thermoclineLineChars: 120,
  surfaceMaxItems: 40,
  thermoclineMaxItems: 2,
  deepSummaryChars: 80
});

const TIER_TITLES = Object.freeze({
  surface: '【表层｜近24小时】',
  thermocline: '【温跃层｜30天内】',
  deep: '【深海｜已巩固】'
});

function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cut(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function redact(value) {
  return String(value ?? '')
    .replace(/[A-Za-z]:[\\/][^\s，。；;]+/g, '［路径已省略］')
    .replace(/\/[^/\s]+\/[^\s，。；;]+/g, '［路径已省略］')
    .replace(/\b(?:sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, '［已省略］')
    .replace(/\b(token|api[_-]?key|password|secret)\s*[:=]\s*[^\s，。；;]+/gi, '$1=［已省略］');
}

function dayLabel(at, now) {
  const then = new Date(Number(at) || 0);
  if (Number.isNaN(then.getTime())) return '';
  const a = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(Number(now) || Date.now());
  const days = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - a) / DAY_MS);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  return `${then.getMonth() + 1}月${then.getDate()}日`;
}

function numOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 24h 内=表层，30 天内=温跃层，更早视为已巩固的深海素材。 */
export function classifyTier(at, now = Date.now()) {
  const ts = Number(at);
  if (!Number.isFinite(ts) || ts <= 0) return 'deep';
  const age = Number(now) - ts;
  if (age <= DAY_MS) return 'surface';
  if (age <= 30 * DAY_MS) return 'thermocline';
  return 'deep';
}

function keepFromNewest(lines, maxChars) {
  const out = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = lines[i].length + (out.length ? 1 : 0);
    if (used + cost > maxChars) break;
    out.unshift(lines[i]);
    used += cost;
  }
  return out;
}

function buildSurface(messages, now, b) {
  const items = (Array.isArray(messages) ? messages : [])
    .map((m, index) => ({ m, index, at: numOr(m?.time ?? m?.at) }))
    .filter(({ m, at }) => m && at > 0 && now - at >= 0 && now - at <= b.surfaceWindowMs)
    .sort((x, y) => x.at - y.at || x.index - y.index)
    .slice(-Math.max(1, b.surfaceMaxItems))
    .map(({ m }) => ({ who: m.isSelf === true ? '我' : '对方', text: clean(m.plain ?? m.text ?? '', 4000) }))
    .filter((item) => item.text);
  const l1 = keepFromNewest(items.map((item) => cut(`· ${item.who}：${item.text}`, b.surfaceLineChars)), b.surfaceMaxChars);
  const l2 = keepFromNewest(items.map((item) => `· ${item.who}：${redact(item.text)}`), b.surfaceMaxChars);
  const last = items[items.length - 1];
  const l0 = last ? cut(`最近 ${items.length} 条消息，最后一句：${clean(last.text, 60)}`, b.surfaceLineChars) : '';
  return { count: items.length, L0: l0, L1: l1, L2: l2 };
}

function rankExperiences(experiences, now, b) {
  return (Array.isArray(experiences) ? experiences : [])
    .map((experience) => ({ experience, at: numOr(experience?.occurredAt ?? experience?.createdAt) }))
    .filter(({ at }) => at > 0 && now - at >= 0 && now - at <= b.thermoclineWindowMs)
    .sort((x, y) => {
      const xe = Number(x.experience?.effectiveStrength);
      const ye = Number(y.experience?.effectiveStrength);
      if (Number.isFinite(xe) && Number.isFinite(ye)) return (ye - xe) || (y.at - x.at);
      if (Number.isFinite(xe)) return -1;
      if (Number.isFinite(ye)) return 1;
      return (y.at - x.at) || (numOr(y.experience?.importance) - numOr(x.experience?.importance));
    });
}

function buildThermocline(experiences, now, b) {
  const items = rankExperiences(experiences, now, b).slice(0, Math.max(0, b.thermoclineMaxItems));
  const raw = items
    .map(({ experience, at }) => `· ${dayLabel(at, now)}：${redact(clean(experience?.summary ?? experience?.text ?? '', 2000))}`)
    .filter((line) => line.length > 4);
  const l1 = keepFromNewest(raw.map((line) => cut(line, b.thermoclineLineChars)), b.thermoclineMaxChars);
  const l2 = keepFromNewest(raw, b.thermoclineMaxChars);
  const l0 = raw.length ? cut(raw.map((line) => line.slice(2)).join('；'), b.thermoclineLineChars) : '';
  return { count: items.length, L0: l0, L1: l1, L2: l2 };
}

function buildDeep(deep, deepRaw, b) {
  const text = redact(clean(typeof deep === 'object' && deep ? deep.text : deep, b.deepMaxChars));
  if (!text) return { count: 0, L0: '', L1: [], L2: [] };
  const rawText = redact(clean(typeof deepRaw === 'string' && deepRaw ? deepRaw : text, b.deepMaxChars * 2));
  const first = text.split(/[。！？!?\n]/).map((s) => s.trim()).find(Boolean) || text;
  return {
    count: 1,
    L0: cut(first, b.deepSummaryChars),
    L1: [text],
    L2: keepFromNewest(rawText.split('\n').filter(Boolean), b.deepMaxChars)
  };
}

function sectionsFor(levels, level) {
  const out = [];
  for (const key of ['surface', 'thermocline', 'deep']) {
    const value = levels[key]?.[level];
    const lines = Array.isArray(value) ? value : (value ? [value] : []);
    if (lines.length) out.push({ key, title: TIER_TITLES[key], lines: [...lines] });
  }
  return out;
}

/** 按指定层级渲染；L2 原文必须在调用方显式传入 level='L2' 时才出现。 */
export function renderTieredContext(result, level = 'L1') {
  const chosen = ['L0', 'L1', 'L2'].includes(level) ? level : 'L1';
  return sectionsFor(result?.levels ?? {}, chosen)
    .map((section) => `${section.title}\n${section.lines.join('\n')}`)
    .join('\n');
}

export function buildContextTiers({
  recentMessages = [],
  experiences = null,
  episodes = null,
  deep = '',
  deepRaw = '',
  now = Date.now(),
  budgets = null,
  level = 'L1'
} = {}) {
  const b = { ...CONTEXT_TIER_DEFAULTS, ...(budgets && typeof budgets === 'object' ? budgets : {}) };
  const list = Array.isArray(experiences) ? experiences : (Array.isArray(episodes) ? episodes : []);
  const levels = {
    surface: buildSurface(recentMessages, Number(now) || Date.now(), b),
    thermocline: buildThermocline(list, Number(now) || Date.now(), b),
    deep: buildDeep(deep, deepRaw, b)
  };
  const chosen = ['L0', 'L1', 'L2'].includes(level) ? level : 'L1';
  return {
    level: chosen,
    budgets: b,
    levels,
    sections: sectionsFor(levels, chosen),
    text: renderTieredContext({ levels }, chosen),
    counts: {
      surface: levels.surface.count,
      thermocline: levels.thermocline.count,
      deep: levels.deep.count
    }
  };
}