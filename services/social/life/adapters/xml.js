// 极简 XML/HTML 文本工具：P0 只解析 Atom/RSS 的标题、链接、时间。
// 不引入第三方 XML 库；解析失败一律抛错，由适配器健康策略记为失败。

import { decodeEntities } from '../kernel/redact.js';

export function decodeXml(text) {
  return decodeEntities(String(text ?? ''));
}

export function stripTags(text) {
  return String(text ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ');
}

export function cleanText(text) {
  return decodeXml(stripTags(text)).replace(/\s+/g, ' ').trim();
}

function tagPattern(tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${escaped}>`, 'i');
}

export function firstTag(block, tag) {
  const match = tagPattern(tag).exec(String(block ?? ''));
  return match ? cleanText(match[1]) : '';
}

export function blocks(xml, tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>[\\s\\S]*?</(?:[\\w.-]+:)?${escaped}>`, 'gi');
  return String(xml ?? '').match(re) ?? [];
}

/** Atom `<link href="..."/>` 或 RSS `<link>...</link>`。 */
export function linkOf(block) {
  const selfClosing = /<(?:[\w.-]+:)?link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/i.exec(String(block ?? ''));
  if (selfClosing) return decodeXml(selfClosing[1]).trim();
  const text = firstTag(block, 'link');
  return text;
}

export function isoToMs(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** 通用布尔/数组配置清洗。 */
export function hostList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim().toLowerCase()).filter(Boolean).slice(0, 20);
}
