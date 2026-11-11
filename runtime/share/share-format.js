// 分享文案排版：纯函数，无 IO。inner-life.js 只负责取数与发送。
//
// 版式约定：
//   - 标题单独一行，后面恰好一个空行；
//   - 正文段首不缩进（不再加全角空格），段间恰好一个空行；
//   - 延伸阅读标题单独一行、其后空一行，条目之间空一行；
//   - 条目本身不缩进——URL 前的空格会让复制变麻烦。

export function cleanLine(value, maxChars) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

export function paragraphizeShareText(text, template = '') {
  const raw = String(text || '').trim();
  if (!['knowledge', 'finance', 'story', 'data'].includes(String(template))) return raw;
  const sentences = raw.split(/(?<=[。！？!?])\s*/).filter(Boolean);
  if (sentences.length < 4) return raw;
  const paragraphs = sentences.length >= 7 ? 3 : 2;
  const size = Math.ceil(sentences.length / paragraphs);
  const groups = [];
  for (let i = 0; i < sentences.length; i += size) {
    groups.push(sentences.slice(i, i + size).join(''));
  }
  return groups.join('\n\n');
}

/** 段首不缩进：剥掉已有缩进/空白再按空行分段，保证重复格式化幂等。 */
export function normalizeParagraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((item) => item.replace(/^[\s　]+/, '').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function formatShareCaption(parsed = {}, template = '') {
  const title = cleanLine(parsed.title, 60);
  const body = normalizeParagraphs(paragraphizeShareText(parsed.text, template));
  const risk = String(parsed.riskNote ?? '').trim();
  return [title, body, risk].filter(Boolean).join('\n\n');
}

function linksSection(links) {
  const list = (Array.isArray(links) ? links : []).slice(0, 3);
  if (!list.length) return '';
  const items = list
    .map((link, index) => `${index + 1}. ${cleanLine(link?.title, 60)}\n${link?.url ?? ''}`)
    .join('\n\n');
  return `延伸阅读：\n\n${items}`;
}

export function formatShareLinksText(links, { imageHosts = '', sourceUrl = '' } = {}) {
  const list = (Array.isArray(links) ? links : []).slice(0, 3);
  const blocks = [];
  if (list.length) blocks.push(linksSection(list));
  if (sourceUrl && !list.some((link) => link?.url === sourceUrl)) blocks.push(`来源：${sourceUrl}`);
  if (imageHosts) blocks.push(`配图来源：${imageHosts}`);
  return blocks.join('\n\n').trim();
}

export function formatAiTipLinks(links, sourceHost = '') {
  const list = (Array.isArray(links) ? links : []).slice(0, 3);
  const blocks = [];
  if (list.length) blocks.push(linksSection(list));
  if (sourceHost) blocks.push(`配图来源：${sourceHost}`);
  return blocks.join('\n\n').trim();
}

/** 小知识预览/旧发送路径的正文：标题一行 + 空行 + 不缩进正文。 */
export function formatTipCaption(item = {}) {
  const title = String(item.title ?? '').trim();
  const body = normalizeParagraphs(paragraphizeShareText(item.text, item.template || 'knowledge'));
  return [title, body].filter(Boolean).join('\n\n');
}

const SHARE_URL_RE = /https?:\/\/[^\s<>"'，。；、）)】]+/gi;

/** 去掉正文里的链接（候选匹配会把 URL 追加到正文末尾），只留下点评文字。 */
export function stripShareUrls(text) {
  return String(text ?? '')
    .replace(SHARE_URL_RE, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * 把一段正文拆成 1–maxComments 条“短点评”，供非科普分享逐条发送。
 * 按句子边界均衡分桶，保持原顺序；绝不截断或丢字（长文也只是分成更多/更长的几条）。
 * 单句或空文本不再硬切，避免把一句话拆得支离破碎。
 */
export function splitShareComments(text, { maxComments = 3, maxChars = 50 } = {}) {
  const raw = String(text ?? '').replace(/　/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!raw) return [];
  const sentences = raw.split(/(?<=[。！？!?…])\s*/).map((item) => item.trim()).filter(Boolean);
  if (sentences.length <= 1) return [raw];
  const cap = Math.max(1, Math.min(10, Number(maxComments) || 3));
  const width = Math.max(20, Number(maxChars) || 50);
  const n = Math.max(1, Math.min(cap, sentences.length, Math.ceil(raw.length / width)));
  if (n === 1) return [raw];
  const target = raw.length / n;
  const buckets = [];
  let cur = '';
  for (let i = 0; i < sentences.length; i += 1) {
    const remainingBuckets = n - buckets.length;
    const remainingSentences = sentences.length - i;
    if (cur && remainingBuckets > 1 && cur.length >= target && remainingSentences >= remainingBuckets - 1) {
      buckets.push(cur);
      cur = '';
    }
    cur += sentences[i];
  }
  if (cur) buckets.push(cur);
  return buckets;
}