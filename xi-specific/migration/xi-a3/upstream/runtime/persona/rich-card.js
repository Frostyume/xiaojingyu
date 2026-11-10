// OneBot 富媒体卡片解析：JSON 卡片 / XML 卡片 / 音乐 / 分享。
//
// 目标：模型看到的是「标题 + 摘要 + 链接」，而不是几百字符的原始 JSON/XML。
// 安全：只解析字段，不抓取 URL；URL 只接受 http/https 并去掉凭据；文本压掉控制字符并限长
// （防止卡片摘要里塞换行伪造新的提示词段落）。

const MAX_TITLE = 120;
const MAX_SUMMARY = 220;
const MAX_URL = 500;

function cleanText(value, max) {
  const s = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function safeCardUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > MAX_URL) return '';
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return '';
    if (u.username || u.password) return '';
    return u.toString();
  } catch {
    return '';
  }
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    for (const part of path.split('.')) {
      if (!cur || typeof cur !== 'object') { cur = null; break; }
      cur = cur[part];
    }
    if (cur !== null && cur !== undefined && String(cur).trim()) return cur;
  }
  return '';
}

/** 解析 OneBot json 段里的卡片对象（QQ 结构化消息）。 */
export function parseJsonCard(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    let text = raw.trim();
    if (!text) return null;
    // 有些实现会再包一层 JSON 字符串
    for (let i = 0; i < 2 && typeof text === 'string'; i += 1) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'string') { text = parsed; continue; }
        obj = parsed;
        break;
      } catch {
        return null;
      }
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const meta = obj.meta ?? {};
  const title = cleanText(firstNonEmpty(
    pick(meta, ['news.title', 'detail_1.title', 'music.title', 'music.song', 'video.title', 'mini_app.title']),
    obj.prompt,
    obj.desc,
    pick(obj, ['extra.title'])
  ), MAX_TITLE);
  const summary = cleanText(firstNonEmpty(
    pick(meta, ['news.desc', 'detail_1.desc', 'music.desc', 'video.desc', 'mini_app.desc']),
    obj.desc,
    obj.prompt
  ), MAX_SUMMARY);
  const url = safeCardUrl(firstNonEmpty(
    pick(meta, ['news.jumpUrl', 'detail_1.qqdocurl', 'music.jumpUrl', 'video.jumpUrl', 'mini_app.jumpUrl']),
    pick(obj, ['extra.url', 'url'])
  ));
  const source = cleanText(firstNonEmpty(
    pick(meta, ['news.tag', 'news.source', 'detail_1.tag']),
    obj.app ? String(obj.app).split('.').pop() : ''
  ), 40);
  if (!title && !summary && !url) return null;
  return { kind: 'json', title, summary, url, source };
}

/** 解析 XML 卡片（<msg brief> / <item><title>…）。 */
export function parseXmlCard(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return null;
  const attr = (name) => {
    const m = new RegExp(`${name}="([^"]*)"`, 'i').exec(text);
    return m ? m[1] : '';
  };
  const tag = (name) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(text);
    return m ? m[1] : '';
  };
  const title = cleanText(firstNonEmpty(tag('title'), attr('brief').replace(/^\[[^\]]*\]\s*/, '')), MAX_TITLE);
  const summary = cleanText(firstNonEmpty(tag('summary'), tag('desc')), MAX_SUMMARY);
  const url = safeCardUrl(firstNonEmpty(attr('url'), tag('url')));
  if (!title && !summary && !url) return null;
  return { kind: 'xml', title, summary, url, source: 'xml' };
}

/** 音乐/分享段（部分网关直接给出扁平字段）。 */
export function parseFlatCard(segment) {
  const d = segment?.data ?? {};
  const title = cleanText(firstNonEmpty(d.title, d.song, d.name), MAX_TITLE);
  const summary = cleanText(firstNonEmpty(d.content, d.summary, d.desc, d.singer), MAX_SUMMARY);
  const url = safeCardUrl(firstNonEmpty(d.url, d.jumpUrl, d.musicUrl));
  if (!title && !summary && !url) return null;
  const kind = segment?.type === 'music' ? 'music' : 'share';
  return { kind, title, summary, url, source: cleanText(firstNonEmpty(d.source, d.platform), 30) };
}

/**
 * 把任意富媒体段变成一行可读文本。永不返回原始 JSON/XML。
 * @returns {string}
 */
export function formatRichSegment(segment, { maxChars = 260 } = {}) {
  const type = String(segment?.type ?? '');
  const d = segment?.data ?? {};
  let card = null;
  if (type === 'json') card = parseJsonCard(d.data ?? d.content ?? d);
  else if (type === 'xml') card = parseXmlCard(d.data ?? d.content ?? d);
  else if (type === 'card') {
    card = parseJsonCard(d.data ?? d.content ?? d) ?? parseXmlCard(d.data ?? d.content ?? d) ?? parseFlatCard(segment);
  } else if (type === 'music' || type === 'share') {
    card = parseFlatCard(segment);
  }
  if (!card) {
    const label = type === 'json' || type === 'card' ? '卡片消息' : (type === 'xml' ? '链接卡片' : type);
    return `[${label}]`;
  }
  const label = card.kind === 'music' ? '音乐' : (card.kind === 'xml' ? '链接卡片' : '卡片消息');
  const bits = [];
  if (card.title) bits.push(card.title);
  if (card.summary && card.summary !== card.title) bits.push(card.summary);
  if (card.source) bits.push(`来源:${card.source}`);
  if (card.url) bits.push(card.url);
  const body = bits.join(' · ');
  const out = `[${label}] ${body}`;
  if (out.length > maxChars && card.url) {
    // Keep share targets usable when the title/summary consumes the text budget.
    const prefix = `[${label}] `;
    const words = bits.slice(0, -1).join(' · ');
    const room = maxChars - prefix.length - card.url.length;
    if (room >= 0) {
      const snippet = room >= 5 && words ? words.slice(0, room - 4) + '… · ' : '';
      return prefix + snippet + card.url;
    }
    if (card.url.length <= maxChars) return card.url;
    // Avoid presenting a truncated URL as the source of another resource.
    const unavailable = words ? prefix + words + '（链接过长）' : prefix + '（链接过长）';
    return unavailable.length <= maxChars ? unavailable : unavailable.slice(0, Math.max(0, maxChars - 1)) + '…';
  }
  return out.length > maxChars ? `${out.slice(0, Math.max(0, maxChars - 1))}…` : out;
}
