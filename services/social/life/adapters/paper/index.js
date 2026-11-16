// 只读论文适配器：OpenAlex（默认）/ arXiv 两条来源，只保留标题、机构、会议、
// 发布时间、摘要压缩与中文速读；不搬运全文、不落原始响应。
//
// 中文速读（TLDR）由外部注入的 summarizer 生成；没有模型时退回「摘要第一句」
// 并标注 abstract-compress；没有摘要时标注 title-only。任何情况下都不编造。

import crypto from 'node:crypto';
import { sanitizeTitle, redactText } from '../../kernel/redact.js';
import { blocks, firstTag, linkOf, isoToMs } from '../xml.js';

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TOPICS = Object.freeze(['cs.AI', 'cs.CL', 'cs.CV', 'cs.LG']);
const MAX_TOPICS = 8;
const MAX_KEYWORDS = 10;
const MAX_RESULTS = 50;

const TOPIC_PHRASES = Object.freeze({
  'cs.ai': 'artificial intelligence',
  'cs.cl': 'computational linguistics',
  'cs.cv': 'computer vision',
  'cs.lg': 'machine learning'
});

export function allowedHosts(config = {}) {
  return String(config?.source ?? '') === 'arxiv' ? ['export.arxiv.org'] : ['api.openalex.org'];
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function stringList(value, max, maxChars) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = String(item ?? '').trim().slice(0, maxChars);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function topicPhrase(topic) {
  const raw = String(topic ?? '').trim();
  if (!raw) return '';
  const mapped = TOPIC_PHRASES[raw.toLowerCase()];
  if (mapped) return mapped;
  return raw;
}

function arxivQuery(topics, keywords) {
  const parts = [];
  for (const topic of topics) {
    const text = String(topic ?? '').trim();
    if (/^[a-z-]+\.[A-Z]{2}$/i.test(text)) parts.push(`cat:${text}`);
    else if (text) parts.push(`all:"${text.replace(/"/g, '')}"`);
  }
  for (const keyword of keywords) {
    const text = String(keyword ?? '').trim();
    if (text) parts.push(`all:"${text.replace(/"/g, '')}"`);
  }
  return parts.length ? parts.join(' OR ') : 'cat:cs.AI';
}

function windowDates(nowMs, windowDays) {
  const days = Math.max(1, Number(windowDays) || 7);
  const to = new Date(nowMs).toISOString().slice(0, 10);
  const from = new Date(nowMs - days * DAY).toISOString().slice(0, 10);
  return { from, to };
}

function openAlexUrl({ phrase, from, to, perPage }) {
  const params = new URLSearchParams();
  params.set('filter', `from_publication_date:${from},to_publication_date:${to},type:article`);
  if (phrase) params.set('search', phrase);
  params.set('sort', 'publication_date:desc');
  params.set('per-page', String(perPage));
  return `https://api.openalex.org/works?${params.toString()}`;
}

function normalizeDoi(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = /(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/.exec(text);
  return match ? match[1].replace(/[.,;]+$/, '') : '';
}

function arxivIdOf(work) {
  const urls = [];
  for (const location of Array.isArray(work?.locations) ? work.locations : []) {
    if (location?.landing_page_url) urls.push(String(location.landing_page_url));
    if (location?.pdf_url) urls.push(String(location.pdf_url));
  }
  if (work?.primary_location?.landing_page_url) urls.push(String(work.primary_location.landing_page_url));
  const match = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:\.pdf)?(?:[?#]|$)/i.exec(urls.join(' '));
  return match ? decodeURIComponent(match[1]) : '';
}

export function reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object' || Array.isArray(inverted)) return '';
  const pairs = [];
  for (const [word, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      const index = Number(position);
      if (Number.isFinite(index)) pairs.push([index, word]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map(([, word]) => word).join(' ').replace(/\s+/g, ' ').trim().slice(0, 2400);
}

export function firstSentence(abstract) {
  const text = String(abstract ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const match = /^(.{20,220}?[。！？.!?])(?:\s|$)/.exec(text);
  const sentence = match ? match[1] : text;
  const chars = Array.from(sentence);
  return chars.length > 180 ? `${chars.slice(0, 179).join('')}…` : sentence;
}

export function parseOpenAlexWork(work, { nowMs = Date.now() } = {}) {
  if (!work || typeof work !== 'object') return null;
  const title = sanitizeTitle(work.title || work.display_name || '', 140);
  if (!title) return null;
  const doi = normalizeDoi(work.doi);
  const arxivId = arxivIdOf(work);
  const publicationDate = String(work.publication_date ?? '').slice(0, 10);
  const parsed = Date.parse(publicationDate);
  const published = Number.isFinite(parsed) ? parsed : nowMs;
  const venueName = String(work.primary_location?.source?.display_name ?? '').trim();
  const venue = venueName || (arxivId ? 'arXiv' : '');
  const year = Number(work.publication_year) || (publicationDate ? Number(publicationDate.slice(0, 4)) : null);
  const institutions = [];
  for (const authorship of Array.isArray(work.authorships) ? work.authorships : []) {
    for (const institution of Array.isArray(authorship?.institutions) ? authorship.institutions : []) {
      const name = String(institution?.display_name ?? '').replace(/\s+/g, ' ').trim();
      if (name && !institutions.includes(name)) institutions.push(name);
    }
  }
  const authors = (Array.isArray(work.authorships) ? work.authorships : [])
    .map((item) => String(item?.author?.display_name ?? '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const abstract = reconstructAbstract(work.abstract_inverted_index);
  const landing = String(work.primary_location?.landing_page_url ?? '').trim()
    || (doi ? `https://doi.org/${doi}` : '')
    || String(work.id ?? '');
  return {
    title,
    doi,
    arxivId,
    publicationDate,
    published,
    venue,
    year,
    institutions: institutions.slice(0, 2),
    authors,
    abstract,
    url: landing
  };
}

function sameTitle(a, b) {
  const left = String(a ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const right = String(b ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return Boolean(left) && left === right;
}

function preferPaper(candidate, current) {
  if (!current) return candidate;
  const candidatePublished = Boolean(candidate.doi) || !/arxiv/i.test(candidate.venue || '');
  const currentPublished = Boolean(current.doi) || !/arxiv/i.test(current.venue || '');
  if (candidatePublished && !currentPublished) return candidate;
  return current;
}

/** 去重顺序：DOI > arXiv id > 标题+年份；优先正式发表版本，摘要取更完整的一份。 */
export function dedupePapers(list) {
  const groups = [];
  for (const paper of Array.isArray(list) ? list : []) {
    if (!paper || !paper.title) continue;
    const group = groups.find((item) => (
      (paper.doi && item.doi && paper.doi.toLowerCase() === item.doi.toLowerCase())
      || (paper.arxivId && item.arxivId && paper.arxivId.toLowerCase() === item.arxivId.toLowerCase())
      || (sameTitle(paper.title, item.title) && Number(paper.year || 0) === Number(item.year || 0))
    ));
    if (!group) {
      groups.push({ ...paper, institutions: [...(paper.institutions || [])] });
      continue;
    }
    const winner = preferPaper(paper, group);
    const loser = winner === paper ? group : paper;
    Object.assign(group, winner);
    group.doi = group.doi || loser.doi || '';
    group.arxivId = group.arxivId || loser.arxivId || '';
    group.venue = group.venue || loser.venue || '';
    group.year = group.year || loser.year || null;
    group.publicationDate = group.publicationDate || loser.publicationDate || '';
    group.url = group.url || loser.url || '';
    if (String(loser.abstract || '').length > String(group.abstract || '').length) group.abstract = loser.abstract;
    const institutions = [...(group.institutions || [])];
    for (const name of loser.institutions || []) if (!institutions.includes(name)) institutions.push(name);
    group.institutions = institutions.slice(0, 2);
    if (!group.authors?.length) group.authors = loser.authors || [];
  }
  return groups;
}

function paperKey(paper) {
  if (paper.doi) return `doi:${paper.doi.toLowerCase()}`;
  if (paper.arxivId) return `arxiv:${paper.arxivId.toLowerCase()}`;
  const digest = crypto.createHash('sha1').update(`${paper.title}\u0000${paper.year ?? ''}`).digest('hex').slice(0, 20);
  return `title:${digest}`;
}

function paperDraft(paper, { tldr = null, tldrSource = 'title-only' } = {}) {
  return {
    kind: 'paper',
    externalId: paper.doi || paper.arxivId || null,
    title: paper.title,
    summary: tldr,
    startsAt: paper.published,
    status: 'open',
    dedupeKey: paperKey(paper),
    sourceRef: paper.arxivId || paper.doi || '',
    source: 'paper',
    meta: {
      url: paper.url,
      doi: paper.doi || null,
      arxivId: paper.arxivId || null,
      venue: paper.venue || null,
      year: paper.year || null,
      publicationDate: paper.publicationDate || null,
      authors: paper.authors || [],
      institutions: paper.institutions || [],
      tldr: tldr || null,
      tldrSource
    }
  };
}

function fallbackSummary(paper) {
  if (!paper.abstract) return { text: null, source: 'title-only' };
  const sentence = firstSentence(paper.abstract);
  return sentence ? { text: sentence, source: 'abstract-compress' } : { text: null, source: 'title-only' };
}

async function summarizePaper(paper, summarizer, logger) {
  const fallback = fallbackSummary(paper);
  if (fallback.source === 'title-only' || typeof summarizer !== 'function') return fallback;
  try {
    const result = await summarizer({
      title: paper.title,
      abstract: paper.abstract,
      venue: paper.venue,
      year: paper.year
    });
    const text = typeof result === 'string' ? result : result?.text;
    const clean = redactText(String(text ?? '')).replace(/\s+/g, ' ').trim();
    if (clean) return { text: Array.from(clean).slice(0, 300).join(''), source: 'model' };
  } catch (error) {
    logger?.('warn', `论文速读生成失败，改用摘要压缩：${error?.message ?? error}`);
  }
  return fallback;
}

export function parseArxivEntry(entry, { nowMs = Date.now() } = {}) {
  const link = linkOf(entry) || firstTag(entry, 'id');
  const title = sanitizeTitle(firstTag(entry, 'title'), 140);
  const arxivId = String(link || '').split('/abs/').pop() || String(link || '');
  if (!title || !arxivId) return null;
  const published = isoToMs(firstTag(entry, 'published')) ?? isoToMs(firstTag(entry, 'updated')) ?? nowMs;
  const abstract = redactText(firstTag(entry, 'summary'));
  const doi = normalizeDoi(firstTag(entry, 'doi') || firstTag(entry, 'journal_ref'));
  const journalRef = String(firstTag(entry, 'journal_ref') ?? '').slice(0, 80);
  const authors = blocks(entry, 'author')
    .map((block) => firstTag(block, 'name'))
    .filter(Boolean)
    .slice(0, 8);
  return {
    title,
    doi,
    arxivId: decodeURIComponent(arxivId.replace(/\.pdf$/i, '')),
    publicationDate: new Date(published).toISOString().slice(0, 10),
    published,
    venue: journalRef || 'arXiv',
    year: new Date(published).getUTCFullYear(),
    institutions: [],
    authors,
    abstract,
    url: `https://arxiv.org/abs/${encodeURIComponent(arxivId.replace(/\.pdf$/i, ''))}`
  };
}

async function fetchOpenAlex({ topics, keywords, count, windowDays, http, nowMs }) {
  const phrases = [...new Set([...topics.map(topicPhrase), keywords.join(' ')].map((item) => String(item).trim()).filter(Boolean))];
  const perPage = Math.max(10, Math.min(MAX_RESULTS, count * 3));
  const { from, to } = windowDates(nowMs, windowDays);
  const papers = [];
  for (const phrase of phrases) {
    const response = await http.fetch(openAlexUrl({ phrase, from, to, perPage }), { headers: { accept: 'application/json' } });
    let payload;
    try { payload = JSON.parse(response.body); } catch (error) { throw new Error(`OpenAlex 响应不是合法 JSON：${error?.message ?? error}`); }
    for (const work of Array.isArray(payload?.results) ? payload.results : []) {
      const paper = parseOpenAlexWork(work, { nowMs });
      if (paper) papers.push(paper);
    }
  }
  return papers;
}

async function fetchArxiv({ topics, keywords, count, http, nowMs }) {
  const query = arxivQuery(topics, keywords);
  const maxResults = Math.max(10, Math.min(MAX_RESULTS, count * 3));
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
  const response = await http.fetch(url, { headers: { accept: 'application/atom+xml' } });
  const body = String(response.body ?? '');
  if (!body.trim()) throw new Error('arXiv 响应为空');
  const entries = blocks(body, 'entry');
  if (!entries.length && !/<(?:[\w.-]+:)?feed\b/i.test(body)) throw new Error('不是有效的 Atom feed');
  return entries.map((entry) => parseArxivEntry(entry, { nowMs })).filter(Boolean);
}

export default {
  id: 'paper',
  maxBytes: 2 * 1024 * 1024,
  allowedHosts,
  async sync({ config, http, now, limit = 20, summarizer = null, log = null, preview = false }) {
    const nowMs = now();
    const source = String(config?.source ?? '') === 'arxiv' ? 'arxiv' : 'openalex';
    const topics = stringList(config?.topics, MAX_TOPICS, 40);
    const keywords = stringList(config?.keywords, MAX_KEYWORDS, 60);
    const effectiveTopics = topics.length ? topics : [...DEFAULT_TOPICS];
    const count = clamp(config?.count, 1, 20, 5);
    const windowDays = clamp(config?.windowDays, 1, 30, 7);
    const maxItems = Math.min(count, Math.max(1, Number(limit) || 20));
    const raw = source === 'arxiv'
      ? await fetchArxiv({ topics: effectiveTopics, keywords, count, http, nowMs })
      : await fetchOpenAlex({ topics: effectiveTopics, keywords, count: Math.max(count, 5), windowDays, http, nowMs });
    const since = nowMs - windowDays * DAY;
    const papers = dedupePapers(raw.filter((paper) => paper.published >= since))
      .sort((a, b) => b.published - a.published)
      .slice(0, maxItems);
    const items = [];
    for (const paper of papers) {
      const tldr = await summarizePaper(paper, summarizer, log);
      items.push(paperDraft(paper, { tldr: tldr.text, tldrSource: tldr.source }));
    }
    return {
      items,
      cursor: null,
      meta: {
        source,
        topics: effectiveTopics,
        keywords,
        windowDays,
        fetched: raw.length,
        shown: items.length,
        preview: preview === true
      }
    };
  }
};
