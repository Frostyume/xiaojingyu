// 播报限频的纯函数：以 append-only 审计为事实来源，快照只做展示缓存。
const shanghaiDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function shanghaiDayKey(ms = Date.now()) {
  const parts = shanghaiDateFmt.formatToParts(new Date(Number(ms) || Date.now()));
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function parseAuditLine(raw) {
  try {
    const row = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

/** 同一场赛果的稳定标识：日期 + 两队（不分主客）。队名不足两支时返回 ''。 */
export function resultMatchKey({ day = '', teams = [] } = {}) {
  const list = (Array.isArray(teams) ? teams : []).map((t) => String(t || '').toUpperCase()).filter(Boolean);
  if (list.length < 2) return '';
  return `${String(day || '')}|${list.slice(0, 2).sort().join('|')}`;
}

/** 审计行 → 当日、同 key 的真实播报次数、最近一次时间（毫秒）与已播对局 key。损坏行跳过。 */
export function dayStatsFromAudit(lines = [], { key = '', day = '' } = {}) {
  let count = 0;
  let lastAt = 0;
  const matchKeys = new Set();
  for (const raw of Array.isArray(lines) ? lines : []) {
    const row = parseAuditLine(raw);
    if (!row || row.decision !== 'broadcast') continue;
    if (String(row.key ?? '') !== String(key ?? '')) continue;
    const at = Number(row.at) || 0;
    if (!at) continue;
    if (day && shanghaiDayKey(at) !== String(day)) continue;
    count += 1;
    if (at > lastAt) lastAt = at;
    const matchKey = String(row.matchKey ?? '');
    if (matchKey) matchKeys.add(matchKey);
  }
  return { count, lastAt, matchKeys: [...matchKeys] };
}

/** skip 审计降噪：同一个 key 在窗口内只允许写一次（内存 Map）。返回 shouldLog(key, now) 判定函数。 */
export function createSkipAuditThrottle({ windowMs = 60 * 60 * 1000 } = {}) {
  const lastAt = new Map();
  const win = Math.max(0, Number(windowMs) || 0);
  return function shouldLog(key, now = Date.now()) {
    const id = String(key ?? '');
    const at = Number(now) || Date.now();
    const prev = Number(lastAt.get(id)) || 0;
    if (prev && at - prev < win) return false;
    lastAt.set(id, at);
    return true;
  };
}

/** 每日上限、同场去重与最小间隔判定；正好等于上限时不允许，lastAt=0 不拦。 */
export function decideBroadcast({ count = 0, lastAt = 0, now = Date.now(), maxPerDay = 2, minGapMs = 30 * 60 * 1000, matchKey = '', seenMatchKeys = [] } = {}) {
  const cap = Math.max(1, Number(maxPerDay) || 2);
  const gap = Math.max(60000, Number(minGapMs) || 30 * 60 * 1000);
  const used = Math.max(0, Number(count) || 0);
  if (used >= cap) return { allow: false, reason: `今日已达 ${cap} 条上限` };
  const mk = String(matchKey || '');
  if (mk && (Array.isArray(seenMatchKeys) ? seenMatchKeys : []).map(String).includes(mk)) {
    return { allow: false, reason: '同一场赛果已播报' };
  }
  const last = Number(lastAt) || 0;
  const at = Number(now) || Date.now();
  if (last > 0 && at - last < gap) {
    return { allow: false, reason: `距离上次播报不足最小间隔（${Math.round(gap / 60000)} 分钟）` };
  }
  return { allow: true, reason: '' };
}

/** 裁剪审计：丢掉 30 天前的行与损坏行，只保留最近 maxLines 行。返回原始字符串行。 */
export function pruneAuditLines(lines = [], { now = Date.now(), maxAgeDays = 30, maxLines = 5000 } = {}) {
  const cutoff = (Number(now) || Date.now()) - Math.max(1, Number(maxAgeDays) || 30) * 24 * 3600 * 1000;
  const limit = Math.max(1, Number(maxLines) || 5000);
  const kept = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    if (typeof raw === 'string' && !raw.trim()) continue;
    const row = parseAuditLine(raw);
    const at = Number(row?.at) || 0;
    if (!at || at < cutoff) continue;
    kept.push(typeof raw === 'string' ? raw : JSON.stringify(row));
  }
  return kept.length > limit ? kept.slice(-limit) : kept;
}
