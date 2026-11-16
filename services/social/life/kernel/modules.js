// 三个生活模块的纯文本构建：日历晨报、RSS 摘要、每周回顾。
//
// 纯函数：不读配置、不碰数据库，输入条目/设置，输出可直接推送的文本。
// 条目既可能是 pipeline 落库后的 normalized item（payload），
// 也可能是 preview 时适配器返回的 draft（meta）；两者都按同一套字段读取。

import { startOfDay, endOfDay, zonedParts } from './time.js';

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MAX_SECTION_LINES = 3;

function payloadOf(item) {
  if (item?.payload && typeof item.payload === 'object') return item.payload;
  if (item?.meta && typeof item.meta === 'object') return item.meta;
  return {};
}

function toMs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function weekdayOf(ms, tz) {
  const p = zonedParts(ms, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

function monthDay(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.month}月${p.day}日`;
}

function dateWithWeekday(ms, tz) {
  return `${monthDay(ms, tz)} ${WEEKDAY_ZH[weekdayOf(ms, tz)] ?? ''}`.trim();
}

function clock(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function shortDate(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function activeItems(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && item.status !== 'dismissed' && item.status !== 'expired');
}

function calendarLine(item, tz) {
  const payload = payloadOf(item);
  const start = toMs(item.startsAt);
  const end = toMs(item.endsAt);
  if (start == null) return null;
  const title = String(item.title || '').trim() || '未命名日程';
  const bits = [`${clock(start, tz)}–${end != null ? clock(end, tz) : '—'} ${title}`];
  const detail = payload.location || payload.description || '';
  if (detail) bits.push(`（${detail}）`);
  return `• ${bits.join('')}`;
}

function eventWindow(item, tz) {
  const payload = payloadOf(item);
  const start = toMs(item.startsAt);
  if (start == null) return null;
  const allDay = payload.allDay === true;
  const end = toMs(item.endsAt) ?? (allDay ? start + DAY : start);
  return { start, end: Math.max(start, end), allDay };
}

/** 日历晨报：今天按时间排序；全天/跨天单列；冲突成对指出；可选明日预告。 */
export function buildCalendarMorning({ items = [], module = {}, nowMs = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const tz = timeZone;
  const todayStart = startOfDay(nowMs, tz);
  const todayEnd = endOfDay(nowMs, tz);
  const tomorrowEnd = todayEnd + DAY;
  const timed = [];
  const allDay = [];
  const spanning = [];
  for (const item of activeItems(items)) {
    const win = eventWindow(item, tz);
    if (!win) continue;
    if (win.start >= todayEnd || win.end <= todayStart) continue;
    if (win.allDay) allDay.push({ item, win });
    else if (win.start < todayStart) spanning.push({ item, win });
    else timed.push({ item, win });
  }
  const byStart = (a, b) => a.win.start - b.win.start || a.win.end - b.win.end;
  timed.sort(byStart);
  allDay.sort(byStart);
  spanning.sort(byStart);

  const lines = [`日历晨报 · ${dateWithWeekday(nowMs, tz)}`];
  const todayCount = timed.length + allDay.length + spanning.length;
  if (!todayCount) {
    lines.push('今天没有日程。');
  } else {
    lines.push(`今天 ${todayCount} 项日程`);
    for (const { item } of timed) {
      const line = calendarLine(item, tz);
      if (line) lines.push(line);
    }
    for (const { item } of allDay) {
      lines.push(`• 全天：${String(item.title || '未命名日程')}`);
    }
    for (const { item, win } of spanning) {
      const detail = payloadOf(item).location || payloadOf(item).description || '';
      lines.push(`• 跨天：${String(item.title || '未命名日程')}（${shortDate(win.start, tz)} – ${shortDate(win.end, tz)}）${detail ? ` ${detail}` : ''}`);
    }
  }

  if (module.showConflicts !== false) {
    const conflicts = [];
    for (let i = 0; i < timed.length; i += 1) {
      for (let j = i + 1; j < timed.length; j += 1) {
        const a = timed[i];
        const b = timed[j];
        if (a.win.start < b.win.end && b.win.start < a.win.end) {
          conflicts.push(`冲突：${clock(a.win.start, tz)} ${a.item.title} 与 ${clock(b.win.start, tz)} ${b.item.title}`);
          if (conflicts.length >= 5) break;
        }
      }
      if (conflicts.length >= 5) break;
    }
    lines.push(...conflicts);
  }

  if (module.tomorrowPreview !== false) {
    const tomorrow = [];
    for (const item of activeItems(items)) {
      const win = eventWindow(item, tz);
      if (!win || win.start < todayEnd || win.start >= tomorrowEnd) continue;
      tomorrow.push({ item, win });
    }
    tomorrow.sort(byStart);
    const label = `明日预告（${dateWithWeekday(todayEnd + 1, tz)}）`;
    if (!tomorrow.length) {
      lines.push(`${label}：暂无日程。`);
    } else {
      const names = tomorrow.slice(0, MAX_SECTION_LINES).map(({ item, win }) => (
        payloadOf(item).allDay === true ? `全天 ${item.title}` : `${clock(win.start, tz)} ${item.title}`
      ));
      const more = tomorrow.length > names.length ? ` 等 ${tomorrow.length} 项` : '';
      lines.push(`${label}：${names.join('、')}${more}`);
    }
  }

  return { text: lines.join('\n'), count: todayCount };
}

function rssItemLine(item, tz, showSummary) {
  const payload = payloadOf(item);
  const url = String(payload.url || item.sourceRef || '').trim();
  const title = String(item.title || '').trim() || '（无标题）';
  const lines = [`• ${url ? `[${title}](${url})` : title}`];
  const stamp = toMs(item.startsAt);
  const metaBits = [];
  if (stamp != null) metaBits.push(shortDate(stamp, tz) + ' ' + clock(stamp, tz));
  const duration = formatDuration(payload.duration);
  if (duration) metaBits.push(`时长 ${duration}`);
  if (metaBits.length) lines.push(`  ${metaBits.join(' · ')}`);
  if (showSummary !== false && item.summary) {
    lines.push(`  摘要：${String(item.summary).replace(/\s+/g, ' ').trim()}`);
  }
  return lines;
}

/** 多源 RSS/播客摘要：按来源分组，总条数受 count 限制，每源再受 perFeedLimit 限制。 */
export function buildRssDigest({ items = [], module = {}, meta = {}, nowMs = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const tz = timeZone;
  const total = Math.max(1, Math.min(30, Number(module.count) || 8));
  const perFeed = Math.max(1, Math.min(10, Number(module.perFeedLimit) || 3));
  const list = activeItems(items);
  const globalMeta = meta && typeof meta === 'object' ? meta : {};
  const header = `RSS 摘要 · ${dateWithWeekday(nowMs, tz)}`;
  if (globalMeta.baseline && !list.length) {
    const feeds = Array.isArray(globalMeta.feeds) ? globalMeta.feeds : [];
    const names = feeds.map((feed) => feed?.feed).filter(Boolean).slice(0, 6);
    const suffix = names.length ? `（${names.join('、')}）` : '';
    return {
      text: [`${header}`, `首次基线已建立${suffix}：已记录历史条目，之后只推送新内容。`].join('\n'),
      count: 0,
      baseline: true
    };
  }
  if (!list.length) {
    return { text: [`${header}`, '本轮没有新条目。'].join('\n'), count: 0 };
  }
  const groups = new Map();
  for (const item of list) {
    const payload = payloadOf(item);
    const name = String(payload.feed || payload.sourceLabel || '订阅源');
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  const lines = [header];
  let used = 0;
  let groupsShown = 0;
  for (const [name, group] of groups) {
    if (used >= total) break;
    const take = Math.min(perFeed, total - used, group.length);
    if (!take) continue;
    const sorted = [...group].sort((a, b) => (toMs(b.startsAt) ?? 0) - (toMs(a.startsAt) ?? 0));
    lines.push(`【${name}】`);
    for (const item of sorted.slice(0, take)) {
      lines.push(...rssItemLine(item, tz, module.showSummary));
      used += 1;
    }
    groupsShown += 1;
  }
  if (!groupsShown) lines.push('本轮没有新条目。');
  if (Array.isArray(globalMeta.failedFeeds) && globalMeta.failedFeeds.length) {
    lines.push(`（${globalMeta.failedFeeds.length} 个源拉取失败：${globalMeta.failedFeeds.slice(0, 5).join('、')}）`);
  }
  return { text: lines.join('\n'), count: used };
}

function sectionHeader(title, total, unit) {
  return total > 0 ? `${title}：本周 ${total} ${unit}` : `${title}：本周无新增`;
}

function reminderStats(items, nowMs) {
  const since = nowMs - 7 * DAY;
  const relevant = (Array.isArray(items) ? items : []).filter((item) => {
    const stamp = Number(item?.lastAttemptAt) || Number(item?.createdAt) || Number(item?.dueAt) || 0;
    return stamp >= since;
  });
  const byStatus = (status) => relevant.filter((item) => item?.status === status);
  return {
    total: relevant.length,
    sent: byStatus('sent').length,
    failed: byStatus('failed').length,
    cancelled: byStatus('cancelled').length,
    pending: byStatus('pending').length,
    failedItems: byStatus('failed')
  };
}

function paperLine(item) {
  const payload = payloadOf(item);
  const venue = [payload.venue, payload.year].filter(Boolean).join(' · ');
  return `${String(item.title || '未命名论文')}${venue ? `（${venue}）` : ''}`;
}

function githubLine(item) {
  const payload = payloadOf(item);
  const repo = payload.repo ? `${payload.repo} ` : '';
  const number = payload.number ? `#${payload.number} ` : '';
  return `${repo}${number}${String(item.title || '变更')}`;
}

function digestLine(item) {
  const stamp = toMs(item.startsAt);
  const date = stamp != null ? `${shortDate(stamp, 'Asia/Shanghai')} ` : '';
  return `${date}${String(item.title || '动态')}`;
}

function reminderLine(item) {
  const title = String(item?.title || item?.text || item?.content || '').trim();
  if (!title) return null;
  const stamp = toMs(item?.dueAt ?? item?.remindAt ?? item?.at ?? item?.time);
  const when = stamp != null ? `（${shortDate(stamp, 'Asia/Shanghai')}）` : '';
  return `${title}${when}`;
}

/**
 * 每周回顾：只汇总过去 7 天；四个分节可分别关闭，每节最多 3 条。
 * paperTotal/githubTotal/digestTotal 是窗口内的真实总数（列表本身会被截断），
 * 不传时退回列表长度，避免调用方漏传时报错。
 */
export function buildWeeklyReview({
  paperItems = [],
  paperTotal = null,
  githubItems = [],
  githubTotal = null,
  reminderItems = [],
  digestItems = [],
  digestTotal = null,
  module = {},
  nowMs = Date.now(),
  timeZone = 'Asia/Shanghai'
} = {}) {
  const tz = timeZone;
  const sections = module.sections && typeof module.sections === 'object' ? module.sections : {};
  const since = nowMs - 7 * DAY;
  const weekStart = startOfDay(nowMs - 6 * DAY, tz);
  const lines = [`每周回顾 · ${monthDay(weekStart, tz)}–${monthDay(nowMs, tz)}`];
  const totalOf = (list, total) => (
    total === null || total === undefined || total === ''
      ? list.length
      : Math.max(0, Number(total) || 0)
  );
  let count = 0;

  if (sections.paper !== false) {
    const total = totalOf(paperItems, paperTotal);
    const entries = paperItems.slice(0, MAX_SECTION_LINES).map(paperLine);
    count += entries.length;
    lines.push(sectionHeader('论文', total, '篇'));
    lines.push(...entries.map((line) => `  · ${line}`));
  }
  if (sections.github !== false) {
    const total = totalOf(githubItems, githubTotal);
    const entries = githubItems.slice(0, MAX_SECTION_LINES).map(githubLine);
    count += entries.length;
    lines.push(sectionHeader('GitHub', total, '项变化'));
    lines.push(...entries.map((line) => `  · ${line}`));
  }
  if (sections.reminders !== false) {
    const stats = reminderStats(reminderItems, nowMs);
    count += stats.total;
    if (!stats.total) {
      lines.push('提醒：本周无新增');
    } else {
      lines.push(`提醒：送达 ${stats.sent} 条，错过 ${stats.failed} 条，待触发 ${stats.pending} 条`);
      lines.push(...stats.failedItems.slice(0, MAX_SECTION_LINES).map(reminderLine).filter(Boolean).map((line) => `  · 错过：${line}`));
    }
  }
  if (sections.digest !== false) {
    const total = totalOf(digestItems, digestTotal);
    const entries = digestItems.slice(0, MAX_SECTION_LINES).map(digestLine);
    count += entries.length;
    lines.push(sectionHeader('生活动态', total, '条'));
    lines.push(...entries.map((line) => `  · ${line}`));
  }
  if (count === 0) lines.push(`（${monthDay(since, tz)} 起过去 7 天没有新增内容）`);
  return { text: lines.join('\n'), count };
}
