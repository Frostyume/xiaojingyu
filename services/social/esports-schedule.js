// S16 / 世界赛赛程：把“日期 + 开赛时间 + 对阵”变成可注入 prompt 的结构化数据。
//
// 数据源分工：
//   · 官方比赛日/开赛时间：赛前公布的赛程（北京时间），作为兜底静态表；
//   · 每日对阵：赛程公布后由联网搜索/新闻正文解析，缓存进 state/esports-schedule.json。
//
// 时间基准统一为北京时间（UTC+8）。所有展示都必须带日期，不能只说“今晚”。

import { extractLolTeams } from './esports-feed.js';

export const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

/** S16 官方赛程数据（腾讯 LPL 赛事官网的 JSON，含最新抽签结果）。 */
export const OFFICIAL_SCHEDULE_URL = 'https://lpl.qq.com/web201612/data/LOL_MATCH2_MATCH_HOMEPAGE_BMATCH_LIST_246.js';

export const STAGE_SCHEDULE = Object.freeze([
  { date: '2026-10-16', time: '02:00', stage: '入围赛' },
  { date: '2026-10-17', time: '02:00', stage: '入围赛' },
  { date: '2026-10-18', time: '02:00', stage: '入围赛' },
  { date: '2026-10-19', time: '02:00', stage: '入围赛' },
  { date: '2026-10-24', time: '01:00', stage: '瑞士轮第1日' },
  { date: '2026-10-25', time: '01:00', stage: '瑞士轮第2日' },
  { date: '2026-10-26', time: '01:00', stage: '瑞士轮第3日' },
  { date: '2026-10-27', time: '01:00', stage: '瑞士轮第4日' },
  { date: '2026-10-29', time: '04:00', stage: '瑞士轮第5日' },
  { date: '2026-10-30', time: '04:00', stage: '瑞士轮第6日' },
  { date: '2026-10-31', time: '04:00', stage: '瑞士轮第7日' },
  { date: '2026-11-01', time: '01:00', stage: '瑞士轮第8日' },
  { date: '2026-11-04', time: '06:00', stage: '四分之一决赛' },
  { date: '2026-11-05', time: '06:00', stage: '四分之一决赛' },
  { date: '2026-11-06', time: '06:00', stage: '四分之一决赛' },
  { date: '2026-11-07', time: '06:00', stage: '四分之一决赛' },
  { date: '2026-11-08', time: '06:00', stage: '半决赛' },
  { date: '2026-11-09', time: '06:00', stage: '半决赛' },
  { date: '2026-11-15', time: '03:00', stage: '冠亚军决赛' }
]);

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MATCH_RE = /(?:(\d{1,2})月(\d{1,2})日)?(?:\s*[（(][^)）]{1,8}[)）])?\s*(?:约)?\s*(\d{1,2}):(\d{2})\s*[#＃]?\s*([A-Za-z][A-Za-z0-9]{1,15})\s*(?:对战|vs\.?|VS)\s*([A-Za-z][A-Za-z0-9]{1,15})\s*[#＃]?\s*(?:[（(]?\s*(BO[135])\s*[)）]?)?/g;

export function shanghaiDateKey(ms = Date.now()) {
  return new Date(Number(ms) + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function shanghaiHourMinute(ms = Date.now()) {
  const d = new Date(Number(ms) + SHANGHAI_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function dateKeyOf(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function weekdayOf(dateKey) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  return WEEKDAYS[d.getUTCDay()] || '';
}

function relativeLabel(dateKey, todayKey) {
  const a = Date.parse(`${dateKey}T00:00:00Z`);
  const b = Date.parse(`${todayKey}T00:00:00Z`);
  const diff = Math.round((a - b) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return '';
}

export function addDaysKey(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/** 从新闻/赛程正文里解析“10月27日 约2:00 BLG对战KC（BO1）”这类行。 */
export function parseScheduleMatches(text, { year = 2026, defaultDate = '' } = {}) {
  const out = [];
  const seen = new Set();
  const raw = String(text ?? '');
  let currentDate = defaultDate;
  for (const m of raw.matchAll(MATCH_RE)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month > 0 && day > 0) currentDate = dateKeyOf(year, month, day);
    const date = currentDate;
    if (!date) continue;
    const time = `${String(Number(m[3])).padStart(2, '0')}:${m[4]}`;
    const teamA = String(m[5] || '').toUpperCase();
    const teamB = String(m[6] || '').toUpperCase();
    if (!teamA || !teamB || teamA === teamB) continue;
    const format = m[7] ? String(m[7]).toUpperCase() : '';
    const key = `${date}|${time}|${teamA}|${teamB}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, teamA, teamB, format });
  }
  return out;
}

/**
 * 解析 LPL 官方赛程 JSON（bMatchName 里已有完整对阵）。
 * MatchDate 是北京时间；未抽签的占位场次（D8G1 等）不写入 matches。
 */
export function parseOfficialSchedule(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return []; }
  }
  const list = Array.isArray(data?.msg) ? data.msg : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const name = String(item?.bMatchName || '').trim();
    if (!name || /^D\d+G\d+$/i.test(name)) continue;
    const parts = name.split(/\s+vs\.?\s+/i);
    let teamA = String(parts[0] || '').trim().toUpperCase();
    let teamB = String(parts[1] || '').trim().toUpperCase();
    if (!teamA) teamA = String(item?.TeamShortNameA || '').trim().toUpperCase();
    if (!teamB) teamB = String(item?.TeamShortNameB || '').trim().toUpperCase();
    if (!teamA || !teamB) continue;
    const date = String(item?.MatchDate || '').slice(0, 10);
    const time = String(item?.MatchDate || '').slice(11, 16);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) continue;
    const key = `${date}|${time}|${teamA}|${teamB}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time,
      teamA,
      teamB,
      format: String(item?.GameModeName || '').toUpperCase(),
      stage: `${String(item?.GameTypeName || '').trim()}${String(item?.GameProcName || '').trim()}`,
      status: String(item?.MatchStatus || ''),
      scoreA: Number(item?.ScoreA) || 0,
      scoreB: Number(item?.ScoreB) || 0
    });
  }
  return out.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

export function mergeScheduleMatches(existing = [], incoming = [], { keepBefore = '' } = {}) {
  const map = new Map();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!item?.date || !item?.teamA || !item?.teamB) continue;
    if (keepBefore && item.date < keepBefore) continue;
    map.set(`${item.date}|${item.time || ''}|${item.teamA}|${item.teamB}`, item);
  }
  return [...map.values()].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

/** 生成给 prompt / 页面用的赛程块；只展示今天起 days 天。 */
export function buildScheduleLines({ matches = [], now = Date.now(), days = 7, stageSchedule = STAGE_SCHEDULE } = {}) {
  const today = shanghaiDateKey(now);
  const nowTime = shanghaiHourMinute(now);
  const end = addDaysKey(today, Math.max(0, Number(days) || 7));
  const stageByDate = new Map((stageSchedule || []).map((item) => [item.date, item]));
  const next = nextScheduleMatch(matches, now);
  const byDate = new Map();
  for (const match of matches) {
    if (!match?.date || match.date < today || match.date > end) continue;
    if (!byDate.has(match.date)) byDate.set(match.date, []);
    byDate.get(match.date).push(match);
  }
  const lines = [];
  for (let i = 0; i <= Math.max(0, Number(days) || 7); i += 1) {
    const date = addDaysKey(today, i);
    const stage = stageByDate.get(date);
    const list = (byDate.get(date) || []).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (!stage && !list.length) continue;
    const label = relativeLabel(date, today);
    const head = `${label ? `${label} ` : ''}${date.slice(5).replace('-', '/')} ${weekdayOf(date)}`;
    if (list.length) {
      const parts = list.map((m) => {
        const isNext = next && next.date === m.date && next.time === m.time && next.teamA === m.teamA && next.teamB === m.teamB;
        // 以官方 MatchStatus 为准：1 未开始 / 2 进行中 / 3 已结束。
        // 只有完全没有 status 的旧缓存才回退时钟判断。
        const status = String(m.status ?? '').trim();
        const isPastByClock = date === today && m.time && m.time < nowTime;
        const tag = isNext
          ? '下一场'
          : status === '3'
            ? '已结束'
            : status === '2'
              ? '进行中'
              : (!status && isPastByClock ? '已结束' : '');
        const score = status === '3' ? ` ${Number(m.scoreA) || 0}-${Number(m.scoreB) || 0}` : '';
        return `${m.time || '时间待定'} ${m.teamA} vs ${m.teamB}${m.format ? `（${m.format}）` : ''}${tag ? ` ${tag}` : ''}${score}`;
      });
      lines.push(`${head}${stage ? ` · ${stage.stage} ${stage.time} 开赛` : ''}：${parts.join('；')}`);
    } else {
      lines.push(`${head}${stage ? ` · ${stage.stage} ${stage.time} 开赛（对阵待抽签/官方更新）` : ''}`);
    }
  }
  return {
    lines,
    text: lines.length ? `【S16 赛程（北京时间 UTC+8）】\n${lines.join('\n')}` : ''
  };
}

/** 查同一天同一对阵（不区分主客顺序）的赛程记录。 */
export function scheduleStatusOf(matches = [], { date = '', teamA = '', teamB = '' } = {}) {
  const a = String(teamA || '').toUpperCase();
  const b = String(teamB || '').toUpperCase();
  if (!date || !a || !b) return null;
  return (Array.isArray(matches) ? matches : []).find((m) => m
    && m.date === date
    && ((String(m.teamA || '').toUpperCase() === a && String(m.teamB || '').toUpperCase() === b)
      || (String(m.teamA || '').toUpperCase() === b && String(m.teamB || '').toUpperCase() === a))) || null;
}

/**
 * 赛果播报闸门：官方赛程显示该对局还没结束时，禁止按“赛果”播报。
 * 只有 summaryKind === 'result' 才校验；找不到对局或状态缺失时不拦截（少发不误拦）。
 */
export function shouldSkipResultBroadcast({ feed, matches = [], now = Date.now(), date = '' } = {}) {
  if (String(feed?.summaryKind || '') !== 'result') return { skip: false, reason: '不是赛果', match: null, teams: [] };
  // 只按标题判定“对应哪场”：正文常提别的队，拼进来会把评论稿误配到真实对局。
  const titleTeams = extractLolTeams(String(feed?.summaryTitle || ''));
  if (titleTeams.length < 2) return { skip: false, reason: '标题未点名双方', match: null, teams: [] };
  const teams = new Set(titleTeams);
  const day = String(date || feed?.summaryDate || shanghaiDateKey(now)).slice(0, 10);
  const match = (Array.isArray(matches) ? matches : []).find((m) => m
    && String(m.date || '').slice(0, 10) === day
    && teams.has(String(m.teamA || '').toUpperCase())
    && teams.has(String(m.teamB || '').toUpperCase()));
  if (!match) return { skip: false, reason: '当日赛程里没有该对局', match: null, teams: titleTeams };
  const status = String(match.status ?? '').trim();
  if (status && status !== '3') {
    return { skip: true, reason: `比赛尚未结束（官方赛程 status=${status}）`, match, scheduleStatus: status, teams: titleTeams };
  }
  return {
    skip: false,
    reason: status === '3' ? '官方赛程已结束' : '官方赛程状态缺失',
    match,
    scheduleStatus: status,
    teams: titleTeams,
    officialScore: status === '3' ? `${Number(match.scoreA) || 0}-${Number(match.scoreB) || 0}` : ''
  };
}

export function nextScheduleMatch(matches = [], now = Date.now()) {
  const today = shanghaiDateKey(now);
  const nowTime = shanghaiHourMinute(now);
  return (Array.isArray(matches) ? matches : [])
    .filter((m) => m?.date && m?.teamA && m?.teamB)
    .filter((m) => m.date > today || (m.date === today && (!m.time || m.time >= nowTime)))
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))[0] || null;
}
