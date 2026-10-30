// 好奇候选池：B 站热门（需要先拿一次访客 cookie）+ RSS。
//
// 设计原则：
//   - 只做“公开、无需登录”的源；抖音/小红书这类登录墙 + 反爬平台不在首期。
//   - 所有源都归一化成同一种 item，后面排序/去重/注入提示词都只认这个结构。
//   - 抓取失败不抛大异常：某个源挂了，其它源照常出候选。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BILI_HOME = 'https://www.bilibili.com/';
const BILI_POPULAR = 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1';

function decodeEntities(input) {
  return String(input ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
}

function stripHtml(input) {
  return decodeEntities(String(input ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value, maxChars = 400) {
  return stripHtml(value).slice(0, maxChars);
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]).trim() : '';
}

function extractAtomLink(block) {
  const m = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

function absoluteUrl(raw, base) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}

function parseCookieHeader(setCookies) {
  const out = [];
  for (const header of setCookies) {
    const first = String(header).split(';')[0].trim();
    if (first && first.includes('=')) out.push(first);
  }
  return out;
}

async function fetchBilibiliCookies(timeoutMs = 15000) {
  const res = await fetch(BILI_HOME, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`B 站首页 HTTP ${res.status}`);
  let setCookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    setCookies = res.headers.getSetCookie();
  } else {
    const single = res.headers.get('set-cookie');
    if (single) setCookies = [single];
  }
  const cookies = parseCookieHeader(setCookies);
  if (!cookies.some((c) => c.startsWith('buvid3='))) {
    // 有些网络环境下首页会把 buvid3 放在重定向后的响应里；再请求一次 API 时也可能拿到。
    // 这里不直接失败，让调用方用现有 cookie 试一次。
  }
  return cookies;
}

/**
 * 取 B 站热门。cookies 为空时会自动先访问一次首页拿访客 cookie。
 * 返回 { items, cookies, refreshed }。
 */
export async function fetchBilibiliPopular({ limit = 15, cookies = [], timeoutMs = 20000, forceRefresh = false } = {}) {
  let jar = Array.isArray(cookies) ? cookies.filter(Boolean) : [];
  let refreshed = false;
  if (forceRefresh || jar.length === 0) {
    try {
      const fresh = await fetchBilibiliCookies(timeoutMs);
      if (fresh.length) {
        jar = fresh;
        refreshed = true;
      }
    } catch {
      // 首页失败也继续试 API；只是可能被风控。
    }
  }

  const request = async () => {
    const res = await fetch(BILI_POPULAR, {
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        referer: BILI_HOME,
        ...(jar.length ? { cookie: jar.join('; ') } : {})
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`B 站热门 HTTP ${res.status}`);
    return res.json();
  };

  let body = await request();
  if (Number(body?.code) !== 0 && !refreshed) {
    try {
      const fresh = await fetchBilibiliCookies(timeoutMs);
      if (fresh.length) {
        jar = fresh;
        refreshed = true;
        body = await request();
      }
    } catch {
      // 保留原始错误
    }
  }
  if (Number(body?.code) !== 0) throw new Error(`B 站热门被拒：code=${body?.code ?? '?'} ${body?.message ?? ''}`);

  const list = Array.isArray(body?.data?.list) ? body.data.list : [];
  const items = list.slice(0, Math.max(1, Math.min(limit, 30))).map((video) => {
    const bvid = String(video?.bvid ?? '').trim();
    const url = bvid ? `https://www.bilibili.com/video/${bvid}` : absoluteUrl(video?.short_link_v2, BILI_HOME);
    if (!url) return null;
    return {
      source: 'bilibili',
      sourceLabel: 'B站',
      id: bvid || url,
      title: cleanText(video?.title, 120),
      url,
      summary: cleanText(video?.desc, 300),
      author: cleanText(video?.owner?.name, 40),
      hot: Number(video?.stat?.view) || 0,
      image: String(video?.pic || '').trim(),
      publishedAt: Number(video?.pubdate) ? Number(video.pubdate) * 1000 : 0
    };
  }).filter(Boolean);
  return { items, cookies: jar, refreshed };
}

/** 解析一个 RSS 2.0 / Atom feed。返回归一化 item 数组。 */
export async function fetchRssItems(url, { limit = 12, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}: ${url}`);
  const xml = await res.text();
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}

  const blocks = [];
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) && blocks.length < limit * 3) blocks.push(m[1]);
  if (blocks.length === 0) {
    const entryRe = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
    while ((m = entryRe.exec(xml)) && blocks.length < limit * 3) blocks.push(m[1]);
  }

  const items = [];
  for (const block of blocks) {
    const title = cleanText(extractTag(block, 'title'), 120);
    const link = absoluteUrl(extractTag(block, 'link') || extractAtomLink(block), url);
    if (!title || !link) continue;
    const summaryRaw = extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content');
    const dateRaw = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated');
    const publishedAt = dateRaw ? Date.parse(dateRaw) : 0;
    items.push({
      source: host || 'rss',
      sourceLabel: host || 'RSS',
      id: link,
      title,
      url: link,
      summary: cleanText(summaryRaw, 300),
      author: cleanText(extractTag(block, 'author') || extractTag(block, 'dc:creator'), 40),
      hot: 0,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : 0
    });
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * 并行抓取配置里的源。返回 { items, biliCookies, errors }。
 * sources: { bilibili: boolean, rss: string[] }
 */
export async function collectCandidates({ sources = {}, biliCookies = [], timeoutMs = 20000 } = {}) {
  const errors = [];
  const items = [];
  let cookies = Array.isArray(biliCookies) ? biliCookies : [];
  const tasks = [];
  if (sources.bilibili) {
    tasks.push(
      fetchBilibiliPopular({ limit: 15, cookies, timeoutMs })
        .then((result) => {
          cookies = result.cookies;
          if (result.refreshed) errors.push('B站：已刷新访客 cookie');
          items.push(...result.items);
        })
        .catch((error) => errors.push(`B站：${error?.message ?? error}`))
    );
  }
  for (const feedUrl of Array.isArray(sources.rss) ? sources.rss : []) {
    tasks.push(
      fetchRssItems(feedUrl, { limit: 12, timeoutMs })
        .then((feedItems) => items.push(...feedItems))
        .catch((error) => errors.push(`${feedUrl}：${error?.message ?? error}`))
    );
  }
  await Promise.all(tasks);
  return { items, biliCookies: cookies, errors };
}

export function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw ?? '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

export function candidateUrlKey(item) {
  const u = normalizeUrl(item?.url);
  if (!u) return '';
  try {
    const parsed = new URL(u);
    // 去掉常见追踪参数，但保留 B 站 bvid 等路径信息。
    for (const key of ['spm_id_from', 'vd_source', 'share_source', 'share_medium', 'from_source']) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return u;
  }
}

export function titleKey(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 60);
}

function bigrams(text) {
  const s = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

export function titleSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const token of A) if (B.has(token)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

function tasteScore(item) {
  const text = `${item?.title ?? ''} ${item?.summary ?? ''}`;
  let score = 0;
  if (/(离谱|竟然|居然|没想到|笑死|翻车|破防|逆天|抽象|整活|爆冷|逆转|绝杀|淘汰|夺冠|冠军|纪录|争议|吵架|失败|为什么|怎么|第一次|最后一个|最贵|最便宜|猫|狗|鱼|白饭)/i.test(text)) score += 0.12;
  if (/(安全|漏洞|公告|财报|融资|发布会|版本更新|排名|统计|分析|报告|白皮书|教程|指南|政策|监管|专利|论文|研究|后端|API|数据库|服务器)/i.test(text)) score -= 0.12;
  return score;
}

function interestScore(item, persona) {
  const hay = `${item?.title ?? ''} ${item?.summary ?? ''}`.toLowerCase();
  if (!hay) return 0;
  let score = 0;
  for (const entry of Array.isArray(persona?.interests) ? persona.interests : []) {
    const topic = String(entry?.topic ?? '').toLowerCase().trim();
    if (topic.length < 2) continue;
    if (hay.includes(topic)) {
      score += 0.28 * Math.max(0.2, Number(entry?.weight) || 0.4);
      continue;
    }
    // 中文没有词边界：用 2 字窗口做粗匹配，避免“独立游戏”匹配不到只写“游戏”的标题。
    let best = 0;
    for (let i = 0; i < topic.length - 1; i += 1) {
      if (hay.includes(topic.slice(i, i + 2))) best = 0.12;
    }
    score += best;
  }
  return Math.min(0.7, score);
}

/**
 * 过滤已看过的、按兴趣/新鲜度/热度排序。
 * seen: [{ url, title, at }]
 */
export function rankCandidates({ items = [], persona = null, seen = [], max = 12, now = Date.now() } = {}) {
  const seenUrls = new Set();
  const seenTitles = [];
  for (const entry of Array.isArray(seen) ? seen : []) {
    const u = candidateUrlKey(entry);
    if (u) seenUrls.add(u);
    if (entry?.title) seenTitles.push(entry.title);
  }

  const accepted = [];
  const acceptedTitles = [];
  for (const item of items) {
    const urlKey = candidateUrlKey(item);
    if (!urlKey || seenUrls.has(urlKey)) continue;
    const title = String(item?.title ?? '').trim();
    if (!title) continue;
    if (seenTitles.some((t) => titleSimilarity(t, title) >= 0.82)) continue;
    if (acceptedTitles.some((t) => titleSimilarity(t, title) >= 0.9)) continue;
    acceptedTitles.push(title);
    const ageMs = item?.publishedAt ? Math.max(0, now - Number(item.publishedAt)) : Infinity;
    let score = 0.15;
    score += interestScore(item, persona);
    score += tasteScore(item);
    if (ageMs <= 24 * 3600 * 1000) score += 0.25;
    else if (ageMs <= 72 * 3600 * 1000) score += 0.12;
    else score += 0.04;
    if (item?.source === 'bilibili') score += 0.08;
    // S16 赛果/赛程有时效性，给一点固定加成，避免总被娱乐内容挤下去。
    if (item?.source === 's16') score += 0.12;
    // 搜索结果是按她的兴趣主动查的，相关度通常比泛热门更高；但没有发布时间，不能给新鲜度加分。
    if (item?.source === 'web') score += 0.10;
    if (item?.hot > 0) score += Math.min(0.1, Math.log10(item.hot + 1) * 0.02);
    score += Math.random() * 0.08;
    accepted.push({ ...item, score: Number(score.toFixed(3)) });
  }

  accepted.sort((a, b) => b.score - a.score);
  return accepted.slice(0, Math.max(1, max));
}

import { beijingParts } from './core/time-awareness.js';

export function formatCandidatesForPrompt(items, max = 8) {
  const list = (Array.isArray(items) ? items : []).slice(0, Math.max(1, max));
  return list.map((item, index) => {
    const label = item.source === 'bilibili' ? 'B站' : (item.sourceLabel || 'RSS');
    const hot = item.hot > 0 ? `，播放 ${Math.round(item.hot / 1000)}k` : '';
    let when = '';
    if (Number(item.publishedAt) > 0) {
      const p = beijingParts(Number(item.publishedAt));
      when = `，发布于 ${p.month}月${p.day}日 ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    }
    const summary = String(item.summary || '').slice(0, 110);
    return `${index + 1}. [${label}] ${item.title}${hot}${when}\n   ${summary ? `${summary}\n   ` : ''}${item.url}`;
  }).join('\n');
}

export function extractUrls(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>"'，。；、）)】]+/gi;
  let m;
  while ((m = re.exec(String(text ?? ''))) && out.length < 10) {
    const u = normalizeUrl(m[0].replace(/[.,!?;:]+$/, ''));
    if (u) out.push(u);
  }
  return [...new Set(out)];
}
