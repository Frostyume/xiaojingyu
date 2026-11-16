// 脱敏：简报、查询、审计只允许出现「标题/时间/状态」。
//
// 这里的目标不是完美识别所有敏感信息，而是**默认最小暴露**：
// 单号、手机号、邮箱、链接、卡号片段一律替换为占位词；宁可少显示，不可多泄露。

const REPLACERS = [
  // URL（含 markdown 链接）先整体替换，避免后面的数字规则把 URL 拆碎。
  [/https?:\/\/\S+/gi, '[链接]'],
  [/www\.\S+/gi, '[链接]'],
  [/<[^>]+>/g, ' '],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi, '[邮箱]'],
  [/\b1[3-9]\d{9}\b/g, '[手机]'],
  [/\b\d{17}[\dXx]\b/g, '[证件]'],
  [/\b\d{16,}\b/g, '[单号]'],
  [/\b(?:[A-Z]{2,4}\d{8,}|[A-Z0-9]{12,})\b/gi, '[单号]'],
  // 中文地址的强特征：省市区 + 街道/路/号；只截掉后半段，保留「某地」提示。
  [/(?:[\u4e00-\u9fa5]{2,}(?:省|市|区|县))[\u4e00-\u9fa5\dA-Za-z\-]{4,}(?:路|街|道|巷|号|栋|室)[\u4e00-\u9fa5\dA-Za-z\-]*/g, '[地址]']
];

const MAX_TITLE_CHARS = 80;

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16) || 32));
}

export function redactText(text) {
  let out = decodeEntities(text);
  for (const [re, replacement] of REPLACERS) out = out.replace(re, replacement);
  return out.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 标题：去 HTML、脱敏、截断；空标题返回空串（调用方跳过该条目）。 */
export function sanitizeTitle(title, maxChars = MAX_TITLE_CHARS) {
  const clean = redactText(title);
  if (!clean) return '';
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

export { MAX_TITLE_CHARS, decodeEntities };
