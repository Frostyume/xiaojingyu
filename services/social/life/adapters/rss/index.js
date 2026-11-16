// 只读 RSS/Atom 订阅适配器：支持多源 feeds；只保留标题、时间、链接与 1–2 句摘要，
// 不抓全文、不下载音频。白名单汇总全部订阅源域名 + 可选的 allowedHosts；
// 重定向到其它域名会被抓取守卫拒绝。
//
// 去重：guid（或 id/link/title）作为条目标识，dedupeKey 只含源域名与标识，
// 不再拼接发布时间；同一篇更新时是更新而不是重复入库。
// 基线：首次同步（或新加源）只记录 seen，不把历史条目一次性推给主人。

import { blocks, firstTag, linkOf, isoToMs, hostList, decodeXml } from '../xml.js';
import { sanitizeTitle } from '../../kernel/redact.js';

const MAX_ITEMS = 60;
const MAX_SEEN_IDS = 300;
const MAX_FEEDS = 12;
const CURSOR_VERSION = 2;

/** 条目稳定标识：guid > id > link > title。 */
function feedIdOf(block) {
  return firstTag(block, 'guid') || firstTag(block, 'id') || linkOf(block) || firstTag(block, 'title');
}

/** 1–2 句摘要：只取 description/summary/content，不抓全文；firstTag 已去标签与实体。 */
export function summaryOf(block) {
  const raw = firstTag(block, 'description')
    || firstTag(block, 'summary')
    || firstTag(block, 'content:encoded')
    || firstTag(block, 'content');
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const sentences = text.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [text];
  const picked = sentences.slice(0, 2).join('').trim();
  return picked ? Array.from(picked).slice(0, 240).join('') : null;
}

/** 播客时长：秒数或 HH:MM:SS / MM:SS，统一成秒。 */
export function parseDuration(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) || null;
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const first = Number(m[1]);
  const second = Number(m[2]);
  if (m[3] == null) return first * 60 + second;
  return first * 3600 + second * 60 + Number(m[3]);
}

export function parseRss(xml, { nowMs = Date.now(), feedHost = 'feed', feedName = '', perFeedLimit = 10 } = {}) {
  const text = String(xml ?? '');
  if (!text.trim()) throw new Error('RSS 响应为空');
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(text)) throw new Error('不是有效的 RSS/Atom');
  const limit = Math.max(1, Math.min(20, Number(perFeedLimit) || 10));
  const entries = [...blocks(text, 'item'), ...blocks(text, 'entry')].slice(0, limit * 4);
  if (!entries.length) return []; // 合法但暂时没有条目：不是故障
  const items = [];
  for (const entry of entries) {
    if (items.length >= limit) break;
    const title = sanitizeTitle(decodeXml(firstTag(entry, 'title')), 140);
    if (!title) continue;
    const link = linkOf(entry);
    const id = String(feedIdOf(entry) || title).slice(0, 160);
    const published = isoToMs(firstTag(entry, 'pubDate'))
      ?? isoToMs(firstTag(entry, 'published'))
      ?? isoToMs(firstTag(entry, 'updated'))
      ?? firstTag(entry, 'dc:date')
      ?? nowMs;
    const publishedMs = typeof published === 'number' ? published : isoToMs(published) ?? nowMs;
    const duration = parseDuration(firstTag(entry, 'duration'));
    const meta = { url: link ? String(link).slice(0, 400) : null, feed: feedName || feedHost };
    if (duration) meta.duration = duration;
    items.push({
      kind: 'feed',
      externalId: id,
      title,
      summary: summaryOf(entry),
      startsAt: publishedMs,
      status: 'open',
      dedupeKey: `rss:${feedHost}:${id}`.slice(0, 200),
      sourceRef: link ? String(link).slice(0, 200) : 'rss',
      source: 'rss',
      meta
    });
  }
  if (!items.length) throw new Error('RSS 条目全部缺少标题');
  return items;
}

/** 归一化订阅源列表：支持 "名称|URL"、纯 URL、{name,url}；最多 12 个。 */
export function feedListOf(config = {}) {
  const feeds = [];
  const seen = new Set();
  const push = (name, url) => {
    const text = String(url ?? '').trim().slice(0, 500);
    if (!text) return;
    let parsed;
    try { parsed = new URL(text); } catch { return; }
    if (!/^https?:$/.test(parsed.protocol)) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    feeds.push({ name: String(name ?? '').trim().slice(0, 40) || parsed.hostname, url: text });
  };
  for (const feed of (Array.isArray(config?.feeds) ? config.feeds : [])) {
    if (typeof feed === 'string') {
      const bar = feed.indexOf('|');
      if (bar > 0) push(feed.slice(0, bar), feed.slice(bar + 1));
      else push('', feed);
    } else if (feed && typeof feed === 'object') {
      push(feed.name, feed.url);
    }
  }
  // 兼容旧的单地址配置：feeds 为空时回落到 url。
  if (!feeds.length && config?.url) push('', config.url);
  return feeds.slice(0, MAX_FEEDS);
}

export function allowedHosts(config = {}) {
  const hosts = [];
  for (const feed of feedListOf(config)) {
    try {
      const url = new URL(feed.url);
      if (url.hostname) hosts.push(url.hostname.toLowerCase());
    } catch { /* 已在前面过滤 */ }
  }
  hosts.push(...hostList(config.allowedHosts));
  return [...new Set(hosts)];
}

function readCursorState(raw) {
  if (!raw) return null;
  let parsed = null;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !parsed.feeds || typeof parsed.feeds !== 'object') return null;
  return parsed;
}

function cursorOf(seenByFeed) {
  const feeds = {};
  for (const [url, seen] of Object.entries(seenByFeed)) {
    if (!seen || !seen.size) continue;
    feeds[url] = { seen: [...seen].slice(-MAX_SEEN_IDS) };
  }
  return JSON.stringify({ v: CURSOR_VERSION, feeds });
}

export default {
  id: 'rss',
  maxBytes: 512 * 1024,
  allowedHosts,
  async sync({ config, http, now, cursor: rawCursor, preview = false }) {
    const feeds = feedListOf(config);
    if (!feeds.length) throw new Error('未配置 RSS 地址（simulation.lifeButler.modules.rssDigest.feeds 或 simulation.life.adapters.rss.url）');
    const state = readCursorState(rawCursor);
    const firstRun = !state && !preview;
    const seenByFeed = {};
    if (state) {
      for (const [url, entry] of Object.entries(state.feeds)) {
        seenByFeed[url] = new Set(Array.isArray(entry?.seen) ? entry.seen.map(String) : []);
      }
    }
    const perFeedLimit = Math.max(1, Math.min(20, Number(config?.perFeedLimit) || 10));
    const items = [];
    const feedMeta = [];
    const failures = [];
    for (const feed of feeds) {
      let feedHost = feed.url;
      try { feedHost = new URL(feed.url).hostname.toLowerCase(); } catch { /* 保持原值 */ }
      let entries;
      try {
        const response = await http.fetch(feed.url, {
          headers: { accept: 'application/rss+xml, application/atom+xml, text/xml' }
        });
        entries = parseRss(response.body, {
          nowMs: now(),
          feedHost,
          feedName: feed.name,
          perFeedLimit
        });
      } catch (error) {
        failures.push({ feed: feed.name, url: feed.url, error: String(error?.message ?? error) });
        feedMeta.push({ feed: feed.name, url: feed.url, fetched: 0, new: 0, failed: true });
        continue;
      }
      let seen = seenByFeed[feed.url];
      const isNewFeed = !seen;
      if (!seen) {
        seen = new Set();
        seenByFeed[feed.url] = seen;
      }
      if (preview) {
        items.push(...entries);
        feedMeta.push({ feed: feed.name, url: feed.url, fetched: entries.length, new: entries.length });
        continue;
      }
      const fresh = isNewFeed || firstRun
        ? []
        : entries.filter((item) => !seen.has(item.externalId || item.dedupeKey));
      items.push(...fresh);
      feedMeta.push({
        feed: feed.name,
        url: feed.url,
        fetched: entries.length,
        new: fresh.length,
        ...(isNewFeed ? { baseline: true } : {})
      });
      for (const item of entries) seen.add(item.externalId || item.dedupeKey);
    }
    if (failures.length === feeds.length) {
      throw new Error(`RSS 全部订阅源拉取失败：${failures[0].error}`);
    }
    return {
      items: items.slice(0, MAX_ITEMS),
      cursor: preview ? null : cursorOf(seenByFeed),
      meta: {
        baseline: firstRun,
        firstRun,
        feeds: feedMeta,
        failures: failures.length,
        ...(failures.length ? { failedFeeds: failures.map((entry) => entry.feed).slice(0, 12) } : {})
      }
    };
  }
};
