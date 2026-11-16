// 只读 arXiv Atom 适配器：只保留论文标题、发布时间与链接标识，不搬运全文。

import { blocks, firstTag, linkOf, isoToMs } from '../xml.js';
import { sanitizeTitle } from '../../kernel/redact.js';

const DEFAULT_URL = 'https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=10';
const MAX_ITEMS = 20;

export function allowedHosts() {
  return ['export.arxiv.org'];
}

export function parseArxiv(xml, { nowMs = Date.now() } = {}) {
  const text = String(xml ?? '');
  if (!text.trim()) throw new Error('arXiv 响应为空');
  if (!/<(?:[\w.-]+:)?feed\b/i.test(text)) throw new Error('不是有效的 Atom feed');
  const entries = blocks(text, 'entry').slice(0, MAX_ITEMS);
  const items = [];
  for (const entry of entries) {
    const id = linkOf(entry) || firstTag(entry, 'id');
    const title = sanitizeTitle(firstTag(entry, 'title'), 140);
    if (!id || !title) continue;
    const published = isoToMs(firstTag(entry, 'published')) ?? isoToMs(firstTag(entry, 'updated')) ?? nowMs;
    const arxivId = String(id).split('/abs/').pop() || String(id);
    items.push({
      kind: 'paper',
      externalId: arxivId.slice(0, 120),
      title,
      startsAt: published,
      status: 'open',
      dedupeKey: `arxiv:${arxivId}`,
      sourceRef: 'arxiv',
      source: 'arxiv'
    });
  }
  if (entries.length && !items.length) throw new Error('arXiv 条目全部缺少标题或 id');
  return items;
}

export default {
  id: 'arxiv',
  maxBytes: 512 * 1024,
  allowedHosts,
  async sync({ config, http, now }) {
    const url = String(config?.url ?? '').trim() || DEFAULT_URL;
    const response = await http.fetch(url, { headers: { accept: 'application/atom+xml' } });
    return { items: parseArxiv(response.body, { nowMs: now() }), cursor: null };
  }
};
