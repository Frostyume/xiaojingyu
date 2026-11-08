// 出门见闻：小说类来源（古登堡 / 维基文库 / 普通单页）。
// 只做规范化与章节读取，抓取函数由调用方注入，模块本身不读网。

import { createHash } from 'node:crypto';

const TYPES = new Set(['gutenberg', 'wikisource', 'url']);
const MIN_BODY_CHARS = 200;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function inferType(raw, url) {
  const type = clean(raw?.type).toLowerCase();
  if (TYPES.has(type)) return type;
  if (/gutenberg\.org/i.test(url)) return 'gutenberg';
  if (/wikisource\.org/i.test(url)) return 'wikisource';
  return 'url';
}

/** 把配置里的原始对象整理成统一结构；没有可用地址时返回 null。 */
export function normalizeNovelSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = clean(raw.url);
  const title = clean(raw.title);
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters
        .map((ch) => (typeof ch === 'string'
          ? { title: '', url: clean(ch) }
          : { title: clean(ch?.title), url: clean(ch?.url) }))
        .filter((ch) => ch.url)
    : [];
  if (!url && chapters.length === 0) return null;
  const id = clean(raw.id)
    || createHash('sha1').update(`${title}\n${url}\n${chapters.map((ch) => ch.url).join('\n')}`).digest('hex').slice(0, 16);
  return {
    id,
    type: inferType(raw, url || chapters[0].url),
    title: title || id,
    url,
    chapters,
  };
}

function stripTags(input) {
  return String(input ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 读取当前章节；单页源用 source.url，多章源按 progress.chapterIndex 推进。 */
export async function readChapter({ source, progress = null, fetchText = null } = {}) {
  if (!source || typeof source !== 'object') return { ok: false, reason: '缺少来源' };
  const chapters = Array.isArray(source.chapters) ? source.chapters : [];
  const rawIndex = Number(progress?.chapterIndex);
  const chapterIndex = Number.isFinite(rawIndex) && rawIndex >= 0 ? Math.floor(rawIndex) : 0;
  let url;
  let title;
  if (chapters.length > 0) {
    if (chapterIndex >= chapters.length) return { ok: false, reason: '已完结' };
    url = chapters[chapterIndex]?.url;
    title = chapters[chapterIndex]?.title || source.title;
  } else {
    url = source.url;
    title = source.title;
  }
  if (!url) return { ok: false, reason: '缺少章节地址' };
  if (typeof fetchText !== 'function') return { ok: false, reason: '空正文' };
  let raw;
  try {
    raw = await fetchText(url);
  } catch {
    return { ok: false, reason: '抓取失败' };
  }
  const text = stripTags(raw);
  if (!text) return { ok: false, reason: '空正文' };
  if (text.length < MIN_BODY_CHARS) return { ok: false, reason: '正文过短' };
  return {
    ok: true,
    sourceId: source.id,
    chapterIndex,
    title,
    url,
    text,
    nextProgress: { chapterIndex: chapterIndex + 1, lastReadAt: Date.now() },
  };
}
