// 社会上下文片段：把人物画像、关系边、最近 episode、边界拼成 ≤700 字的提示词块。
//
// 只读；所有内容先过可见性过滤，再进 prompt：
//   public → 任意会话
//   group  → 群聊或主人私聊
//   owner  → 只在主人私聊
// 任何字段都不带原始消息、绝对路径或凭据；episode 只展示已有摘要。
//
// 调用方负责决定“当前在场的人”（presentPersonIds）；这里不会把整库灌给模型。

import { canViewSocial, makeSocialViewer } from './social-graph.js';
import { buildContextTiers } from '../../runtime/persona/cognition/context-tiers.js';

export const SOCIAL_CONTEXT_DEFAULTS = Object.freeze({
  maxChars: 700,
  maxPeople: 3,
  maxEpisodes: 3,
  maxEdges: 6,
  maxPrefs: 3,
  maxBoundaries: 2,
  maxStyle: 2,
  maxItemChars: 60,
  maxEpisodeChars: 90,
  staleStateMs: 30 * 24 * 3600 * 1000
});

const DAY_MS = 24 * 3600 * 1000;

function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 结构化脱敏：路径、常见令牌、password=... 一律省略，不把疑似秘密带进 prompt。 */
export function redactSensitiveText(value) {
  return String(value ?? '')
    .replace(/[A-Za-z]:[\\/][^\s，。；;]+/g, '［路径已省略］')
    .replace(/\/(?:home|root|Users)\/[^\s，。；;]+/g, '［路径已省略］')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, '［已省略］')
    .replace(/\b(token|api[_-]?key|password|passwd|secret)\s*[:=]\s*[^\s，。；;]+/gi, '$1=［已省略］')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer ［已省略］');
}

function uniqueTexts(list, { maxItems, maxChars }) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const text = clean(item?.text ?? item, maxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function dayStart(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function relativeDayLabel(at, now = Date.now()) {
  const then = new Date(Number(at) || 0);
  const current = new Date(Number(now) || Date.now());
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.round((dayStart(current) - dayStart(then)) / DAY_MS);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  return `${then.getMonth() + 1}月${then.getDate()}日`;
}

export function degreeLabel(weight) {
  const value = Number(weight) || 0;
  if (value >= 0.75) return '很熟';
  if (value >= 0.55) return '常聊';
  if (value >= 0.35) return '认识';
  return '刚认识';
}

function pushUnique(list, line, seen) {
  if (!line || seen.has(line)) return;
  seen.add(line);
  list.push(line);
}

function personName(graph, personId) {
  return clean(graph.getDisplayName(personId), 40) || '某位群友';
}

function edgeLine(edge, graph, groupKey) {
  const fromPerson = edge.from.kind === 'person' ? personName(graph, edge.from.id) : '';
  const toPerson = edge.to.kind === 'person' ? personName(graph, edge.to.id) : '';
  if (edge.kind === 'person_person') {
    if (!fromPerson || !toPerson || edge.from.id === edge.to.id) return '';
    return `${fromPerson} 和 ${toPerson} ${degreeLabel(edge.weight)}`;
  }
  if (edge.kind === 'person_group') {
    // 只展示当前群，避免把“他还在别的群”这类信息带出去。
    if (!String(groupKey).startsWith('group:') || edge.to.id !== groupKey || !fromPerson) return '';
    return `${fromPerson} 在这个群比较活跃`;
  }
  if (edge.kind === 'person_topic') {
    const topic = clean(edge.to.id, 20);
    if (!fromPerson || !topic) return '';
    return `${fromPerson} 常聊「${topic}」`;
  }
  if (edge.kind === 'self_person') {
    if (!toPerson) return '';
    return `你对${toPerson}：${degreeLabel(edge.weight)}`;
  }
  return '';
}

function trimToLimit(sections, maxChars) {
  const work = sections.map((section) => ({ title: section.title, lines: [...section.lines] }));
  const total = () => work.reduce((sum, section) => sum + section.lines.reduce((n, line) => n + line.length + 1, section.lines.length ? 2 : 0), 0);
  // 从最低优先级（episode）往回收，保留人物与边界。
  while (total() > maxChars && work.some((section) => section.lines.length)) {
    let removed = false;
    for (let i = work.length - 1; i >= 0; i -= 1) {
      if (!work[i].lines.length) continue;
      work[i].lines.pop();
      removed = true;
      break;
    }
    if (!removed) break;
  }
  return work.filter((section) => section.lines.length);
}

/**
 * @param {object} input
 * @param {import('./social-graph.js').SocialGraph} input.graph
 * @param {import('./episodes.js').EpisodeStore} [input.episodes]
 * @param {Array<string>} [input.personIds] 当前在场/被提到的人
 * @param {object} [input.viewer] memory-policy / social-graph viewer
 * @param {string} [input.chatKey]
 * @param {string} [input.groupKey]
 * @param {string} [input.topic]
 * @param {number} [input.now]
 */
export function buildSocialContext({
  graph,
  episodes = null,
  personIds = [],
  viewer = undefined,
  chatKey = '',
  audience = 'public',
  ownerQQ = '',
  groupKey = '',
  topic = '',
  personNotes = null,
  now = Date.now(),
  maxChars = SOCIAL_CONTEXT_DEFAULTS.maxChars,
  maxPeople = SOCIAL_CONTEXT_DEFAULTS.maxPeople,
  maxEpisodes = SOCIAL_CONTEXT_DEFAULTS.maxEpisodes,
  maxEdges = SOCIAL_CONTEXT_DEFAULTS.maxEdges,
  tiers = null
} = {}) {
  if (!graph) throw new Error('buildSocialContext 需要 graph');
  const tiersOn = Boolean(tiers && typeof tiers === 'object' && tiers.enabled !== false);
  const ctx = viewer && typeof viewer === 'object'
    ? viewer
    : makeSocialViewer({ chatKey, audience, ownerQQ });
  const ids = [...new Set(
    (Array.isArray(personIds) ? personIds : [personIds])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean)
  )].slice(0, Math.max(1, Number(maxPeople) || SOCIAL_CONTEXT_DEFAULTS.maxPeople));
  const currentGroupKey = String(
    groupKey || (/(?:group|private):\d+/.test(String(ctx.sessionKey ?? chatKey)) ? (ctx.sessionKey ?? chatKey) : '')
  );

  const people = [];
  const boundaries = [];
  const relations = [];
  const episodeLines = [];
  const peopleSeen = new Set();
  const boundarySeen = new Set();
  const relationSeen = new Set();
  const episodeSeen = new Set();
  const usedPersonIds = [];

  for (const personId of ids) {
    const profile = graph.getProfile(personId, { viewer: ctx, now });
    if (!profile) continue;
    const name = clean(profile.displayName, 40) || personName(graph, personId);
    usedPersonIds.push(personId);
    const parts = [];
    const prefs = uniqueTexts(profile.preferences, {
      maxItems: SOCIAL_CONTEXT_DEFAULTS.maxPrefs,
      maxChars: SOCIAL_CONTEXT_DEFAULTS.maxItemChars
    });
    if (prefs.length) parts.push(`偏好 ${prefs.join('、')}`);
    const styles = uniqueTexts(profile.style, {
      maxItems: SOCIAL_CONTEXT_DEFAULTS.maxStyle,
      maxChars: SOCIAL_CONTEXT_DEFAULTS.maxItemChars
    });
    if (styles.length) parts.push(`说话风格 ${styles.join('、')}`);
    if (profile.recentState?.text
      && (!profile.recentState.at || Number(now) - Number(profile.recentState.at) <= SOCIAL_CONTEXT_DEFAULTS.staleStateMs)) {
      parts.push(`近况 ${clean(profile.recentState.text, 40)}`);
    }
    const note = personNotes && typeof personNotes === 'object' ? clean(personNotes[personId], 30) : '';
    if (note) parts.push(note);
    if (parts.length) pushUnique(people, `· ${name}：${redactSensitiveText(parts.join('；'))}`, peopleSeen);
    else if (profile.displayName) pushUnique(people, `· ${name}`, peopleSeen);

    const boundaryTexts = uniqueTexts(profile.boundaries, {
      maxItems: SOCIAL_CONTEXT_DEFAULTS.maxBoundaries,
      maxChars: SOCIAL_CONTEXT_DEFAULTS.maxItemChars
    });
    for (const text of boundaryTexts) {
      pushUnique(boundaries, `· ${name}：${redactSensitiveText(text)}`, boundarySeen);
    }
  }

  const edges = graph.queryEdges({
    personIds: usedPersonIds.length ? usedPersonIds : ids,
    viewer: ctx,
    limit: Math.max(1, Number(maxEdges) || SOCIAL_CONTEXT_DEFAULTS.maxEdges) * 2,
    now
  });
  for (const edge of edges) {
    if (!canViewSocial(edge.visibility, ctx)) continue;
    const line = edgeLine(edge, graph, currentGroupKey);
    if (line) pushUnique(relations, `· ${redactSensitiveText(line)}`, relationSeen);
    if (relations.length >= Math.max(1, Number(maxEdges) || SOCIAL_CONTEXT_DEFAULTS.maxEdges)) break;
  }

  if (!tiersOn && episodes && (usedPersonIds.length || currentGroupKey)) {
    const recent = episodes.list({
      personIds: usedPersonIds.length ? usedPersonIds : null,
      // 群/私聊都按当前会话过滤：别的群、别人的私聊 episode 不能被带进来。
      groupKey: currentGroupKey || null,
      // 当前话题只做提示，不硬过滤最近经历（否则刚聊过的事会被新话题挤掉）。
      topic: null,
      viewer: ctx,
      now,
      limit: Math.max(1, Number(maxEpisodes) || SOCIAL_CONTEXT_DEFAULTS.maxEpisodes)
    });
    for (const episode of recent) {
      const summary = redactSensitiveText(clean(episode.summary, SOCIAL_CONTEXT_DEFAULTS.maxEpisodeChars));
      if (!summary) continue;
      pushUnique(episodeLines, `· ${relativeDayLabel(episode.occurredAt, now)}：${summary}`, episodeSeen);
    }
    if (episodeLines.length && topic) {
      episodeLines.unshift(`· 当前在聊：${redactSensitiveText(clean(topic, 24))}`);
    }
  }

  let tiered = null;
  if (tiersOn) {
    let tierEpisodes = Array.isArray(tiers.episodes) ? tiers.episodes : [];
    if (!Array.isArray(tiers.episodes) && episodes && (usedPersonIds.length || currentGroupKey)) {
      try {
        tierEpisodes = episodes.list({
          personIds: usedPersonIds.length ? usedPersonIds : null,
          groupKey: currentGroupKey || null,
          viewer: ctx,
          now,
          since: Number(now) - 30 * DAY_MS,
          limit: 20
        });
      } catch {
        tierEpisodes = [];
      }
    }
    tiered = buildContextTiers({
      recentMessages: tiers.recentMessages,
      episodes: tierEpisodes,
      deep: tiers.deep,
      deepRaw: tiers.deepRaw,
      now,
      budgets: tiers.budgets,
      level: tiers.level
    });
  }

  const sections = [];
  if (people.length) sections.push({ title: '【认识的人】', lines: people });
  if (boundaries.length) sections.push({ title: '【边界】', lines: boundaries });
  if (relations.length) sections.push({ title: '【关系】', lines: relations });
  if (episodeLines.length) sections.push({ title: '【最近一起经历】', lines: episodeLines });
  if (tiered) for (const section of tiered.sections) sections.push({ title: section.title, lines: section.lines });

  const trimmed = trimToLimit(sections, Math.max(120, Number(maxChars) || SOCIAL_CONTEXT_DEFAULTS.maxChars));
  const text = trimmed
    .map((section) => `${section.title}\n${section.lines.join('\n')}`)
    .join('\n');
  const limited = text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;

  return {
    text: limited,
    chars: limited.length,
    sections: {
      people: people.slice(0, trimmed.find((s) => s.title === '【认识的人】')?.lines.length ?? 0),
      boundaries: boundaries.slice(0, trimmed.find((s) => s.title === '【边界】')?.lines.length ?? 0),
      relations: relations.slice(0, trimmed.find((s) => s.title === '【关系】')?.lines.length ?? 0),
      episodes: episodeLines.slice(0, trimmed.find((s) => s.title === '【最近一起经历】')?.lines.length ?? 0)
    },
    counts: {
      people: people.length,
      boundaries: boundaries.length,
      edges: relations.length,
      episodes: episodeLines.length
    },
    ...(tiered ? { tiers: tiered } : {})
  };
}
