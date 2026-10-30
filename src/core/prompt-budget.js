// Prompt 分层与 token 预算。
//
// 为什么不用字符数：中英混排 + emoji 下 1 字符 ≠ 1 token，按字符裁剪要么裁不够（爆上下文），
// 要么裁过头（丢关键信息）。这里用保守估算，只在**超出预算**时按优先级丢可选段。
//
// 设计原则：
//   · 静态/行为关键段（人格内核、工具协议、安全边界）永远不丢；
//   · 可选段按 dropOrder 丢，最后才对长段做截断；
//   · 输出保持原顺序，未超预算时**逐字不变**（避免无谓的行为漂移）。

/** 保守 token 估算：CJK ≈1.5 字符/token，ASCII ≈4 字符/token，emoji ≈1 token。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  let emoji = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x3040 && cp <= 0x30ff)) cjk += 1;
    else if (cp >= 0x1f000) emoji += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4 + emoji);
}

/** 按 token 预算截断文本（保留开头），末尾加省略号。 */
export function truncateToTokens(text, maxTokens) {
  const s = String(text ?? '');
  const budget = Math.max(0, Number(maxTokens) || 0);
  if (budget <= 0) return '';
  if (estimateTokens(s) <= budget) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(s.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const cut = Math.max(1, lo);
  let out = s.slice(0, cut);
  // 尽量在段落/句子边界收尾
  const boundary = Math.max(out.lastIndexOf('\n'), out.lastIndexOf('。'), out.lastIndexOf('；'));
  if (boundary > cut * 0.6) out = out.slice(0, boundary + 1);
  let result = `${out.trimEnd()}…`;
  // 省略号本身也占 token；保证最终结果不超预算。
  while (result.length > 1 && estimateTokens(result) > budget) result = `${result.slice(0, -2)}…`;
  return result;
}

/**
 * 组装修剪后的 prompt。
 *
 * @param {Array<{id:string,text:string,priority?:number,trim?:boolean}>} sections 顺序即输出顺序
 * @param {{maxTokens?:number, dropOrder?:string[], minSectionTokens?:number}} options
 * @returns {{text:string,tokens:number,budget:number,dropped:string[],trimmed:string[]}}
 */
export function assembleSections(sections, { maxTokens = 5000, dropOrder = [], minSectionTokens = 80 } = {}) {
  const active = (Array.isArray(sections) ? sections : [])
    .filter((s) => s && s.text)
    .map((s) => ({ ...s, text: String(s.text), priority: Number.isFinite(s.priority) ? s.priority : 50, trim: s.trim === true }));
  let total = active.reduce((sum, s) => sum + estimateTokens(s.text), 0);
  const dropped = [];
  const trimmed = [];
  const budget = Math.max(50, Number(maxTokens) || 5000);
  if (total <= budget) return { text: active.map((s) => s.text).join(''), tokens: total, budget, dropped, trimmed };

  const dropByName = new Set();
  for (const id of dropOrder) {
    if (total <= budget) break;
    const idx = active.findIndex((s) => s.id === id);
    if (idx < 0) continue;
    total -= estimateTokens(active[idx].text);
    active[idx].text = '';
    dropByName.add(id);
    dropped.push(id);
  }

  if (total > budget) {
    // 长段截断：优先级低的先截；单段至少留 minSectionTokens，避免截成无意义碎片。
    const trimmable = active
      .filter((s) => s.text && s.trim)
      .sort((a, b) => a.priority - b.priority);
    for (const s of trimmable) {
      if (total <= budget) break;
      const current = estimateTokens(s.text);
      const keep = Math.max(minSectionTokens, current - (total - budget));
      if (keep >= current) continue;
      const next = truncateToTokens(s.text, keep);
      if (next === s.text) continue;
      total = total - current + estimateTokens(next);
      s.text = next;
      trimmed.push(s.id);
    }
  }

  // 兜底：仍然超预算（全部是不可截断的静态段）时，按尾部硬截，宁可少几段提示也不要爆上下文。
  let text = active.map((s) => s.text).join('');
  if (estimateTokens(text) > budget) {
    text = truncateToTokens(text, budget);
    total = estimateTokens(text);
  }
  return { text, tokens: total, budget, dropped, trimmed };
}
