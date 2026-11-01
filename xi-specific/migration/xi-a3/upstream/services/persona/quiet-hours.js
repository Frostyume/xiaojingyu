// 夜间静默窗口：群聊主动冒泡与内心生活共用，避免两套时间表互相打架。
export const DEFAULT_QUIET_HOURS = Object.freeze({ enabled: true, start: '23:30', end: '08:30' });

function hhmm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function normalizeQuietHours(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const start = hhmm(raw.start);
  const end = hhmm(raw.end);
  return {
    enabled: raw.enabled !== false && start != null && end != null,
    start: start == null ? DEFAULT_QUIET_HOURS.start : String(raw.start).trim(),
    end: end == null ? DEFAULT_QUIET_HOURS.end : String(raw.end).trim()
  };
}

export function isQuietNow(value, date = new Date()) {
  const quiet = normalizeQuietHours(value);
  if (!quiet.enabled) return false;
  const start = hhmm(quiet.start);
  const end = hhmm(quiet.end);
  const cur = date.getHours() * 60 + date.getMinutes();
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

/** 从 from 起，下一次静默结束的时间戳（不含随机延迟，调用方按需要加抖动）。 */
export function quietEndAt(value, from = Date.now()) {
  const quiet = normalizeQuietHours(value);
  if (!quiet.enabled) return from;
  const end = hhmm(quiet.end);
  if (end == null) return from;
  const d = new Date(from);
  d.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}
