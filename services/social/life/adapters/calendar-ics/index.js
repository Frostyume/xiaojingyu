// 只读 ICS 日历适配器。
// 支持 VEVENT 的 UID/SUMMARY/DTSTART/DTEND/STATUS/LOCATION/DESCRIPTION；
// 全天事件（VALUE=DATE 或 8 位日期）标 allDay；按 lookaheadDays 截取未来窗口。
// 畸形日历抛错（由熔断记录），单个缺字段的事件跳过；合法的空日历返回 []。

import { zonedParts } from '../../kernel/time.js';
import { sanitizeTitle } from '../../kernel/redact.js';

const DAY = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 200;

function unfold(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeIcs(text) {
  return String(text ?? '')
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rawParams] = head.split(';');
  const params = {};
  for (const item of rawParams) {
    const eq = item.indexOf('=');
    if (eq > 0) params[item.slice(0, eq).toUpperCase()] = item.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.trim().toUpperCase(), params, value };
}

function wallToMs(y, mo, d, h, mi, s, timeZone) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const p = zonedParts(naive, timeZone);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - naive;
  return naive - offset;
}

export function parseIcsDate(value, params = {}, timeZone = 'Asia/Shanghai') {
  const text = String(value ?? '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(text);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    if (z) return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    return wallToMs(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), timeZone);
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (m) {
    const [, y, mo, d] = m;
    return wallToMs(Number(y), Number(mo), Number(d), 0, 0, 0, timeZone);
  }
  return null;
}

/** 返回归一化草稿；解析失败抛错。 */
export function parseIcs(text, { timeZone = 'Asia/Shanghai', nowMs = Date.now(), lookaheadDays = 14 } = {}) {
  const body = unfold(text);
  if (!body.trim()) throw new Error('ICS 内容为空');
  if (!/BEGIN:VCALENDAR/i.test(body)) throw new Error('不是有效的 ICS（缺少 BEGIN:VCALENDAR）');
  const rawEvents = body.split(/BEGIN:VEVENT/i).slice(1);
  if (!rawEvents.length) return []; // 合法但暂时没有事件：不是故障
  const since = nowMs - DAY;
  const until = nowMs + Math.max(1, Math.min(60, Number(lookaheadDays) || 14)) * DAY;
  const items = [];
  let invalidEvents = 0;
  for (const chunk of rawEvents.slice(0, MAX_EVENTS * 2)) {
    const block = chunk.split(/END:VEVENT/i)[0];
    const fields = {};
    for (const line of block.split('\n')) {
      const parsed = parseLine(line.trim());
      if (parsed) fields[parsed.name] = parsed;
    }
    if (!fields.DTSTART) { invalidEvents += 1; continue; }
    const start = parseIcsDate(fields.DTSTART.value, fields.DTSTART.params, timeZone);
    if (!start) { invalidEvents += 1; continue; }
    const end = fields.DTEND ? parseIcsDate(fields.DTEND.value, fields.DTEND.params, timeZone) : null;
    if (end != null && end < since) continue;
    if (start > until) continue;
    if (start < since && !(end && end > since)) continue;
    const summary = sanitizeTitle(unescapeIcs(fields.SUMMARY?.value ?? ''), 120);
    if (!summary) continue;
    const uid = unescapeIcs(fields.UID?.value ?? '').trim() || `${summary}:${start}`;
    const cancelled = /CANCELLED/i.test(fields.STATUS?.value ?? '');
    const allDay = /^DATE$/i.test(fields.DTSTART.params?.VALUE ?? '')
      || /^\d{8}$/.test(String(fields.DTSTART.value ?? '').trim());
    const location = sanitizeTitle(unescapeIcs(fields.LOCATION?.value ?? ''), 120);
    const description = sanitizeTitle(unescapeIcs(fields.DESCRIPTION?.value ?? ''), 200);
    const meta = {};
    if (location) meta.location = location;
    if (description) meta.description = description;
    if (allDay) meta.allDay = true;
    items.push({
      kind: 'calendar',
      externalId: uid.slice(0, 200),
      title: summary,
      startsAt: start,
      endsAt: end,
      status: cancelled ? 'dismissed' : 'open',
      dedupeKey: `ics:${uid}:${start}`,
      sourceRef: 'ics',
      source: 'calendar',
      ...(Object.keys(meta).length ? { meta } : {})
    });
    if (items.length >= MAX_EVENTS) break;
  }
  if (!items.length && invalidEvents) throw new Error(`ICS 事件全部无法解析（${invalidEvents} 条）`);
  return items;
}

export function allowedHosts(config = {}) {
  const hosts = [];
  try {
    const url = new URL(String(config.url ?? ''));
    if (url.hostname) hosts.push(url.hostname.toLowerCase());
  } catch { /* 未配置或非法 URL：白名单保持为空，同步时会明确报错 */ }
  for (const host of Array.isArray(config.allowedHosts) ? config.allowedHosts : []) {
    const clean = String(host ?? '').trim().toLowerCase();
    if (clean) hosts.push(clean);
  }
  return [...new Set(hosts)];
}

export default {
  id: 'calendar-ics',
  maxBytes: 256 * 1024,
  allowedHosts,
  async sync({ config, http, now }) {
    const url = String(config?.url ?? '').trim();
    if (!url) throw new Error('未配置 ICS 地址（simulation.lifeButler.adapters.calendar-ics.url）');
    const response = await http.fetch(url, { headers: { accept: 'text/calendar, text/plain;q=0.5' } });
    return {
      items: parseIcs(response.body, {
        timeZone: config?.timezone || 'Asia/Shanghai',
        nowMs: now(),
        lookaheadDays: config?.lookaheadDays
      }),
      cursor: response.url
    };
  }
};
