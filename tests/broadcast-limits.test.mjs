import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shanghaiDayKey,
  dayStatsFromAudit,
  decideBroadcast,
  pruneAuditLines,
  resultMatchKey,
  createSkipAuditThrottle
} from '../services/social/broadcast-limits.js';

const DAY = '2026-11-08';
const AT = Date.parse('2026-11-08T04:00:00Z');
const KEY = 'group:10001:s16';
const line = (entry) => JSON.stringify(entry);
const broadcast = (at, key = KEY, extra = {}) => line({ at, key, decision: 'broadcast', ...extra });

test('每日上限：第 3 条拒绝，未达上限放行', () => {
  const audit = [broadcast(AT - 3600000), broadcast(AT - 1800000)];
  const stats = dayStatsFromAudit(audit, { key: KEY, day: DAY });
  assert.equal(stats.count, 2);
  assert.equal(decideBroadcast({
    count: stats.count, lastAt: stats.lastAt, now: AT, maxPerDay: 2, minGapMs: 60000
  }).allow, false);
  assert.equal(decideBroadcast({ count: 1, lastAt: 0, now: AT, maxPerDay: 2 }).allow, true);
});

test('同场去重：交换主客得到同一 key，已播过的对局拒绝', () => {
  const a = resultMatchKey({ day: DAY, teams: ['T1', 'BLG'] });
  const b = resultMatchKey({ day: DAY, teams: ['BLG', 't1'] });
  assert.equal(a, b);
  const verdict = decideBroadcast({
    count: 1, lastAt: 0, now: AT, maxPerDay: 2, matchKey: a, seenMatchKeys: [b]
  });
  assert.equal(verdict.allow, false);
  assert.match(verdict.reason, /同一场/);
  assert.equal(resultMatchKey({ day: DAY, teams: ['TES'] }), '');
});

test('最小间隔：不足拒绝，正好等于放行，lastAt=0 不拦', () => {
  assert.equal(decideBroadcast({
    count: 0, lastAt: AT - 10 * 60000, now: AT, maxPerDay: 2, minGapMs: 30 * 60000
  }).allow, false);
  assert.equal(decideBroadcast({
    count: 0, lastAt: AT - 30 * 60000, now: AT, maxPerDay: 2, minGapMs: 30 * 60000
  }).allow, true);
  assert.equal(decideBroadcast({ count: 0, lastAt: 0, now: AT, maxPerDay: 2 }).allow, true);
});

test('审计统计：跨日重置、损坏行跳过、其它会话互不影响', () => {
  const audit = [
    broadcast(Date.parse('2026-11-07T04:00:00Z')),
    'not-json',
    line({ at: AT, key: 'group:20002:s16', decision: 'broadcast' }),
    line({ at: AT, key: KEY, decision: 'skip', reason: 'x' })
  ];
  const stats = dayStatsFromAudit(audit, { key: KEY, day: DAY });
  assert.deepEqual(stats, { count: 0, lastAt: 0, matchKeys: [] });
  assert.equal(dayStatsFromAudit(audit, { key: KEY }).count, 1, '不传 day 时统计全部历史');
});

test('裁剪：去掉损坏行与 30 天前的行，最多保留 5000 行', () => {
  const rows = Array.from({ length: 5005 }, (_, i) => broadcast(AT + i));
  rows.push('{bad', broadcast(AT - 31 * 86400000));
  const kept = pruneAuditLines(rows, { now: AT, maxAgeDays: 30, maxLines: 5000 });
  assert.equal(kept.length, 5000);
  assert.ok(kept.every((row) => row.startsWith('{') && row.includes('"at"')));
});

test('skip 审计节流：同 key 一小时内只写一次', () => {
  const shouldLog = createSkipAuditThrottle({ windowMs: 60 * 60 * 1000 });
  const id = `${KEY}|今日已达 2 条上限`;
  assert.equal(shouldLog(id, AT), true);
  assert.equal(shouldLog(id, AT + 60000), false);
  assert.equal(shouldLog(`${KEY}|同一场赛果已播报`, AT + 1), true);
  assert.equal(shouldLog(id, AT + 60 * 60 * 1000), true);
});

test('上海日键按北京时间切日', () => {
  assert.equal(shanghaiDayKey(Date.parse('2026-11-07T16:30:00Z')), '2026-11-08');
  assert.equal(shanghaiDayKey(Date.parse('2026-11-07T15:30:00Z')), '2026-11-07');
});

