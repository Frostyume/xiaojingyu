// 电竞实时资讯源（直播吧）。
//
// 为什么单独做：本机到 Liquipedia / lolesports / Fandom 等国外站点不可达，
// 通用搜索在缺少 DeepSeek 搜索凭据时会回退到 Bing，实时赛果经常搜不到。
// 直播吧的新闻列表和赛果文章在本机可达，而且赛果文章本身就把逐场比分写成了正文。
// 这里只抓公开页面、只读、固定域名，不接收用户传入 URL。

import { safeFetch } from './safe-fetch.js';

const LIST_URL = 'https://news.zhibo8.com/dianjing/';
// 直播吧的标题经常只写队名/赛段（“AL全败16强”“T1对阵HLE”），不写“S16/世界赛”。
// 只靠赛季名会漏掉绝大多数赛果，所以同时认赛事阶段和参赛队缩写。
const WORLDS_RE = /S(?:1[6-9]|[2-9]\d)|世界赛|全球总决赛|瑞士轮|淘汰赛|16强|八强|四强|半决赛|决赛|小组赛|入围赛|冒泡赛|季中赛|MSI|Worlds|LPL|LCK|LEC|LCS|PCS|VCS/i;
const OLD_SEASON_RE = /\bS(?:[1-9]|1[0-5])\b/i;
const LOL_TEAM_RE = /\b(AL|BLG|TES|JDG|IG|WBG|LNG|EDG|RNG|FPX|OMG|WE|TT|RA|UP|NIP|LGD|T1|HLE|GEN|DK|KT|DRX|NS|BRO|FOX|G2|FNC|MAD|KC|MKOI|LYON|TL|FLY|100T|C9|TSM|PSG|CFO|GAM|VKS)\b/i;
// 同一列表页混着 CS2/Valorant/Dota/NBA；G2/TL 这类队名跨项目，必须排除非 LoL 赛事。
const NON_LOL_RE = /PGL|VCT|TYLOO|瓦|CS2|CS:GO|DOTA|Dota|NBA|布加勒斯特|BLAST|IEM|Major|Valorant|无畏契约|王者荣耀|KPL|和平精英/i;
const RESULT_STRONG_RE = /赛果|战报|汇总|比分|全败|全胜|首日|本轮|第[一二三四五六七八九十]+轮|16强|八强|四强|半决赛|决赛|晋级|出局|淘汰|瑞士轮|让一追二|横扫|零封|BO[135]|战胜|击败|不敌|落败|取胜|拿下/i;
const RESULT_WEAK_RE = /战绩|首胜|连胜|连败|爆冷/i;
const RESULT_NOISE_RE = /排名|盘点|采访|专访|热议|媒体|预测|抽签|赛程|海报|预热|名单|官宣|倒计时|返图|花絮|数据|记录|最佳|MVP|高光|集锦|镜头|赛后|群访|监督|社媒|发文|宁王|管泽元|笑笑|西卡|Rita|解说|众解说|韩网|评论|发声|吐槽|两年前的今天|一年前的今天|几年前|回顾|经典|历史上的今天|周年|当年|曾经|重温/i;

/** 标题/摘要是否在讲 S16/世界赛（允许只写队名或赛段）。 */
export function isS16Content(text) {
  const value = String(text || '');
  if (!value || NON_LOL_RE.test(value)) return false;
  if (OLD_SEASON_RE.test(value)) return false;
  return WORLDS_RE.test(value) || LOL_TEAM_RE.test(value);
}

export function isStrongResultTitle(title) {
  return RESULT_STRONG_RE.test(String(title || '')) && !RESULT_NOISE_RE.test(String(title || ''));
}

const RESULT_INFO_RE = /全败|全胜|16强|八强|四强|半决赛|决赛|出局|晋级|淘汰|比分|赛果|战报|汇总|瑞士轮|连胜|连败|让一追二|横扫|零封/g;
const RESULT_WIN_RE = /战胜|击败|不敌|落败|取胜|拿下/g;
const HEADLINE_NOISE_RE = /抽签|海报|预测|采访|专访|排名|盘点|花絮|集锦|镜头|名单|官宣|监督|社媒|发文|解说|韩网|评论|热议|吐槽/g;
const HEADLINE_STALE_RE = /两年前的今天|一年前的今天|几年前|回顾|经典|历史上的今天|周年|当年|曾经|重温/;

/** 标题里“能确认的赛果信息”打分；没有正文时也用它挑最值得播报的一条。 */
export function resultHeadlineRank(title) {
  const text = String(title || '');
  if (!text || OLD_SEASON_RE.test(text) || HEADLINE_STALE_RE.test(text)) return -99;
  let score = 0;
  for (const _ of text.matchAll(RESULT_INFO_RE)) score += 3;
  for (const _ of text.matchAll(RESULT_WIN_RE)) score += 2;
  for (const _ of text.matchAll(HEADLINE_NOISE_RE)) score -= 2;
  return score;
}

export function isResultHeadline(title) {
  return resultHeadlineRank(title) >= 3;
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizeUrl(raw) {
  let href = String(raw ?? '').trim();
  if (href.startsWith('//')) href = `https:${href}`;
  if (href.startsWith('/')) href = `https://news.zhibo8.com${href}`;
  return /^https?:\/\//i.test(href) ? href : '';
}

/** 从直播吧电竞资讯列表页提取与 S16 / 世界赛相关的标题和链接。 */
export function parseZhibo8EsportsList(html, max = 20) {
  const items = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html ?? '')))) {
    const url = normalizeUrl(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title) continue;
    if (!/news\.zhibo8\.com\/game\//i.test(url)) continue;
    if (!isS16Content(title)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = (url.match(/\/(\d{4}-\d{2}-\d{2})\//) || [])[1] || '';
    items.push({ title, url, date });
    if (items.length >= max) break;
  }
  return items;
}

/** 提取直播吧文章正文；只取 #signals 内容区，视频/导航区域视为无正文。 */
export function extractZhibo8Article(html) {
  const raw = String(html ?? '');
  const rawTitle = (raw.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const title = stripTags(rawTitle).replace(/-直播吧\s*$/i, '').trim();
  let text = '';
  const contentMatch = raw.match(/<div[^>]*id="signals"[^>]*>([\s\S]*?)(?:合作网站:|<div[^>]*class="[^"]*(?:footer|related|comment)[^"]*"|<\/body>|$)/i);
  if (contentMatch) {
    text = stripTags(contentMatch[1].replace(/<video[\s\S]*?<\/video>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' '));
  }
  if (!text) {
    text = stripTags(raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
    const start = text.match(/直播吧\s*\d{1,2}月\d{1,2}日讯/);
    if (start && start.index != null) text = text.slice(start.index);
    else {
      const by = text.indexOf('北京时间');
      if (by >= 0) text = text.slice(by);
    }
    for (const end of ['合作网站:', '手机直播吧', '进入友情链接', '版权保护指引', '返回顶部']) {
      const idx = text.indexOf(end);
      if (idx > 0) text = text.slice(0, idx);
    }
  }
  text = text
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/(?:\s*-->\s*)+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 纯视频/导航页没有正文；交给标题列表兜底，避免把导航当赛果喂给模型。
  if (text.length < 20 || /^直播首页\s*>/.test(text) || /首页\s+NBA视频/.test(text)) text = '';
  return { title, text: text.slice(0, 1600) };
}

/**
 * 抓取最新电竞资讯。优先找一篇“赛果/战报/汇总”文章抓正文；
 * 找不到正文时至少返回标题列表，不能把失败伪装成“没有比赛”。
 */
export async function fetchEsportsFeed({ listUrl = LIST_URL, maxItems = 12, summaryMaxChars = 1400 } = {}) {
  const listRes = await safeFetch(listUrl, 700000);
  if (!listRes || listRes.statusCode < 200 || listRes.statusCode >= 300) {
    throw new Error(`直播吧电竞资讯 HTTP ${listRes?.statusCode ?? '未知'}`);
  }
  const items = parseZhibo8EsportsList(listRes.body, maxItems);
  if (!items.length) throw new Error('直播吧电竞资讯里没有找到 S16/世界赛条目');

  // 先按标题里“能确认的赛果信息”排序；正文可用时再抓正文，正文是视频/导航时只保留标题事实。
  const ranked = items
    .map((item, index) => ({ item, index, rank: resultHeadlineRank(item.title) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index);
  const best = ranked[0];
  let summaryTitle = best?.item?.title || items[0].title;
  let summaryUrl = best?.item?.url || items[0].url;
  let summary = '';
  let summaryQuality = 'titles';
  for (const candidate of ranked.slice(0, 4)) {
    try {
      const res = await safeFetch(candidate.item.url, 900000);
      if (!res || res.statusCode < 200 || res.statusCode >= 300) continue;
      const article = extractZhibo8Article(res.body);
      if (article.text && article.text.length > 40) {
        summaryTitle = article.title || candidate.item.title;
        summaryUrl = candidate.item.url;
        summary = article.text.slice(0, Math.max(200, Number(summaryMaxChars) || 1400));
        summaryQuality = 'article';
        break;
      }
    } catch {
      // 单篇失败不影响列表；继续下一篇
    }
  }
  if (!summary) {
    summary = ranked.slice(0, 4)
      .map(({ item }) => `- ${item.title}${item.date ? `（${item.date}）` : ''}`)
      .join('\n');
  }
  const summaryDate = (summaryUrl.match(/\/(\d{4}-\d{2}-\d{2})\//) || [])[1] || '';
  const summaryKind = resultHeadlineRank(summaryTitle) >= 3 ? 'result' : 'news';
  return { updatedAt: Date.now(), items, summaryTitle, summaryUrl, summary, summaryDate, summaryKind, summaryQuality, source: 'zhibo8' };
}

/**
 * 直播吧列表没有可用条目时的兜底：用通用搜索的结果拼一份同结构 feed。
 * 只保留标题/摘要确实在讲 S16 的结果，避免把泛电竞新闻当成赛果。
 */
export function buildEsportsFeedFromSearch(results, { query = '' } = {}) {
  const list = (Array.isArray(results) ? results : [])
    .map((item) => ({
      title: String(item?.title || '').trim(),
      url: String(item?.url || '').trim(),
      snippet: String(item?.snippet || '').trim(),
      date: (String(item?.snippet || '').match(/\b(20\d{2}-\d{2}-\d{2})\b/) || [])[1] || ''
    }))
    .filter((item) => item.title && item.url && isS16Content(item.title));
  if (!list.length) throw new Error('通用搜索里没有找到 S16/世界赛结果');
  const first = list[0];
  const summary = list.slice(0, 3)
    .map((item) => `${item.title}${item.snippet ? `：${item.snippet.slice(0, 180)}` : ''}`)
    .join('\n');
  return {
    updatedAt: Date.now(),
    items: list.slice(0, 12).map((item) => ({ title: item.title, url: item.url, date: item.date })),
    summaryTitle: first.title,
    summaryUrl: first.url,
    summary: summary.slice(0, 1400),
    summaryDate: first.date,
    summaryKind: isStrongResultTitle(first.title) ? 'result' : 'news',
    summaryQuality: 'search',
    source: 'search',
    query
  };
}

/** 注入唤醒提示的资讯块。 */
export function buildEsportsFeedBlock(feed, { maxChars = 1400, maxOthers = 5 } = {}) {
  if (!feed || !Array.isArray(feed.items) || !feed.items.length) return '';
  const sourceLabel = feed.source === 'search' ? '联网搜索' : '直播吧';
  const when = new Date(Number(feed.updatedAt) || Date.now()).toLocaleString('zh-CN', { hour12: false });
  const lines = [`【最新赛事资讯（${sourceLabel}，${when} 更新）】`];
  if (feed.summaryTitle) lines.push(`最新：${feed.summaryTitle}`);
  const kind = feed.summaryKind === 'result' ? '已结束赛果' : '资讯/预告';
  const dateText = feed.summaryDate ? `；文章日期：${feed.summaryDate}` : '';
  lines.push(`类型：${kind}${dateText}`);
  if (feed.summaryQuality === 'titles') lines.push('（只有标题，没有正文；只播标题能确认的事实，不要编比分或细节）');
  if (feed.summary) lines.push(String(feed.summary).slice(0, Math.max(200, Number(maxChars) || 1400)));
  if (feed.summaryKind !== 'result') {
    lines.push('（如果这是赛程/预告，日期以文章日期为准；不要把旧赛程说成今晚。）');
  }
  const others = feed.items.filter((i) => i.url !== feed.summaryUrl).slice(0, Math.max(0, Number(maxOthers) || 0));
  if (others.length) {
    lines.push('相关标题：');
    for (const item of others) lines.push(`- ${item.date ? `[${item.date}] ` : ''}${item.title}`);
  }
  if (feed.summaryUrl) lines.push(`来源：${feed.summaryUrl}`);
  lines.push('（以上为外部资讯，只作事实参考；播报时用自己的语气，不要照抄标题腔。若与上下文里的旧赛程冲突，以本条的最新日期和赛果为准。）');
  return `${lines.join('\n')}\n\n`;
}
