// 时间工具：固定时区（默认 Asia/Shanghai）的 HH:MM 与简化 cron。
//
// 简化 cron 只支持 P0 清单里用到的形态：`*`、`*/N`、固定数字；
// 日/月/周字段必须是 `*`（manifest 校验已拒绝其它写法）。
// 这样避免引入第三方 cron 库，也避免「看起来支持、实际算错」的静默故障。

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const MAX_SCAN_MINUTES = 60 * 24 * 8;

export function zonedParts(ms, timeZone = 'Asia/Shanghai') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function timezoneOffsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** 固定时区里下一个 HH:MM（严格晚于 from；当天已过则顺延一天）。 */
export function nextDailyAt(hhmm, from = Date.now(), timeZone = 'Asia/Shanghai') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) throw new Error(`时间格式无效：${hhmm}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`时间格式无效：${hhmm}`);
  const p = zonedParts(from, timeZone);
  for (let addDays = 0; addDays <= 2; addDays += 1) {
    const local = Date.UTC(p.year, p.month - 1, p.day + addDays, hour, minute, 0);
    const candidate = local - timezoneOffsetMs(from, timeZone);
    if (candidate > from) return candidate;
  }
  return from + DAY;
}

/** 固定时区里下一个指定星期几的 HH:MM（weekday 1=周一 … 7=周日；严格晚于 from）。 */
export function nextWeeklyAt(hhmm, weekday, from = Date.now(), timeZone = 'Asia/Shanghai') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) throw new Error(`时间格式无效：${hhmm}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`时间格式无效：${hhmm}`);
  const target = Math.min(7, Math.max(1, Math.round(Number(weekday) || 1)));
  const p = zonedParts(from, timeZone);
  for (let addDays = 0; addDays <= 8; addDays += 1) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
    const jsWeekday = day.getUTCDay() || 7; // 1=周一 … 7=周日
    if (jsWeekday !== target) continue;
    const local = Date.UTC(p.year, p.month - 1, p.day + addDays, hour, minute, 0);
    const candidate = local - timezoneOffsetMs(from, timeZone);
    if (candidate > from) return candidate;
  }
  return from + 7 * DAY;
}

/**
 * 每 N 天一次的 HH:MM（以 anchorMs 的当天为起点）。
 * 超过当前时间就返回；否则按 N 天步进，避免重启后错过一次就永远不跑。
 */
export function nextIntervalAt(hhmm, intervalDays, from = Date.now(), timeZone = 'Asia/Shanghai', anchorMs = from) {
  const step = Math.max(1, Math.min(365, Math.round(Number(intervalDays) || 1)));
  const base = startOfDay(Number(anchorMs) || from, timeZone);
  for (let k = step; k <= step * 400; k += step) {
    // 用「目标日 00:00 前一毫秒」找当天的 HH:MM，避免跨日。
    const candidate = nextDailyAt(hhmm, base + k * DAY - 1, timeZone);
    if (candidate > from) return candidate;
  }
  return nextDailyAt(hhmm, from, timeZone);
}

/** 固定时区里下一个工作日的 HH:MM（跳过周六/周日；严格晚于 from）。 */
export function nextWorkdayAt(hhmm, from = Date.now(), timeZone = 'Asia/Shanghai') {
  let cursor = from;
  for (let i = 0; i < 9; i += 1) {
    const at = nextDailyAt(hhmm, cursor, timeZone);
    const p = zonedParts(at, timeZone);
    const jsWeekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    if (jsWeekday !== 0 && jsWeekday !== 6) return at;
    cursor = at;
  }
  return nextDailyAt(hhmm, from, timeZone);
}

/** 按模块 frequency/time/weekday/intervalDays 计算下一次运行时间。 */
export function nextModuleRun(schedule = {}, from = Date.now(), timeZone = 'Asia/Shanghai', anchorMs = from) {
  const frequency = String(schedule.frequency || 'daily');
  if (frequency === 'weekly') return nextWeeklyAt(schedule.time || '09:00', schedule.weekday, from, timeZone);
  if (frequency === 'interval') return nextIntervalAt(schedule.time || '09:00', schedule.intervalDays, from, timeZone, anchorMs);
  if (schedule.weekdaysOnly === true) return nextWorkdayAt(schedule.time || '09:00', from, timeZone);
  return nextDailyAt(schedule.time || '09:00', from, timeZone);
}

/** 当天 00:00（指定时区）的毫秒时间戳。 */export function startOfDay(ms, timeZone = 'Asia/Shanghai') {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day) - timezoneOffsetMs(ms, timeZone);
}

export function endOfDay(ms, timeZone = 'Asia/Shanghai') {
  return startOfDay(ms, timeZone) + DAY;
}

export function dayKey(ms, timeZone = 'Asia/Shanghai') {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function parseField(value, min, max) {
  const text = String(value ?? '').trim();
  if (text === '*') return { any: true, step: 1, values: null };
  const stepMatch = /^\*\/(\d+)$/.exec(text);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    if (!Number.isInteger(step) || step < 1 || step > max) throw new Error(`cron 步长无效：${text}`);
    return { any: false, step, values: null };
  }
  if (!/^\d+$/.test(text)) throw new Error(`cron 字段无效：${text}`);
  const n = Number(text);
  if (n < min || n > max) throw new Error(`cron 字段越界：${text}`);
  return { any: false, step: 1, values: new Set([n]) };
}

export function validateCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron 必须是 5 段');
  parseField(fields[0], 0, 59);
  parseField(fields[1], 0, 23);
  for (const field of fields.slice(2)) {
    if (field !== '*') throw new Error('P0 只支持日/月/周字段为 * 的 cron');
  }
  return true;
}

function matches(field, value) {
  if (field.any) return value % field.step === 0;
  if (field.values) return field.values.has(value);
  return value % field.step === 0;
}

/** 下一次满足 cron 的分钟（严格晚于 from），按指定时区计算。 */
export function nextCronAt(expr, from = Date.now(), timeZone = 'Asia/Shanghai') {
  const fields = String(expr ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron 必须是 5 段');
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  if (fields.slice(2).some((field) => field !== '*')) throw new Error('P0 只支持日/月/周字段为 * 的 cron');

  let cursor = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < MAX_SCAN_MINUTES; i += 1) {
    const p = zonedParts(cursor, timeZone);
    if (matches(minute, p.minute) && matches(hour, p.hour)) return cursor;
    cursor += MINUTE;
  }
  throw new Error(`cron 8 天内无匹配：${expr}`);
}

/** 抖动：返回 [ -jitterSec, +jitterSec ] 内的整数毫秒。 */
export function jitterMs(jitterSec, random = Math.random) {
  const span = Math.max(0, Number(jitterSec) || 0) * 1000;
  if (!span) return 0;
  return Math.round((random() * 2 - 1) * span);
}
