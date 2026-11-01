// 分享文案排版：纯函数，无 IO。inner-life.js 只负责取数与发送。
//
// 版式约定：
//   - 标题单独一行，后面恰好一个空行；
//   - 正文每段段首两个全角空格（U+3000），段间恰好一个空行；
//   - 延伸阅读标题单独一行、其后空一行，条目之间空一行；
//   - 条目本身不缩进——URL 前的空格会让复制变麻烦。

const INDENT = '\u3000\u3000';

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

/** 段首两个全角空格。已带缩进的先剥掉再加，保证重复格式化不叠加。 */
export function indentParagraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((item) => item.replace(/^[\s\u3000]+/, '').trim())
    .filter(Boolean)
    .map((item) => `${INDENT}${item}`)
    .join('\n\n');
}

export function formatShareCaption(parsed = {}, template = '') {
  const title = cleanLine(parsed.title, 60);
  const body = indentParagraphs(paragraphizeShareText(parsed.text, template));
  const risk = String(parsed.riskNote ?? '').trim();
  // 不要对整段结果 trim：U+3000 也算空白，会把首段缩进吃掉；各段在生成时已 trim
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

/** 小知识预览/旧发送路径的正文：标题一行 + 空行 + 缩进正文。 */
export function formatTipCaption(item = {}) {
  const title = String(item.title ?? '').trim();
  const body = indentParagraphs(paragraphizeShareText(item.text, item.template || 'knowledge'));
  return [title, body].filter(Boolean).join('\n\n');
}
