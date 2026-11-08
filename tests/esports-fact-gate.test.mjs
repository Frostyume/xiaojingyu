import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isResultHeadline,
  hasScoreEvidence,
  extractLolTeams,
  buildEsportsFeedFromSearch
} from '../services/social/esports-feed.js';
import {
  buildScheduleLines,
  shouldSkipResultBroadcast
} from '../services/social/esports-schedule.js';

const NEWS_HEADLINES = [
  'S16淘汰赛第四日宣传片：我会让你见识 全球总决赛的T1有多厉害',
  'Oner自出道后从未缺席世界赛四强，连续6年晋级四强及以上',
  'Chovy：我没进过世界决赛，希望Rookie选手能送我进决赛',
  'BLG对阵T1交手记录：总交手记录T1以16-14领先，S赛全胜',
  '调查下马头！TES超话幸灾乐祸：恭喜内战幻神0:3！太爽啦 ！舒服',
  'KC告别本届世界赛：感谢大家的支持，我们会回来的'
];

const RESULT_HEADLINES = [
  'GEN以3比0击败iG',
  'BLG 3-0 DK 横扫晋级',
  'T1三比零KC，零封送走'
];

test('赛果判定：只有比分/胜负证据且点名两队才算 result', () => {
  for (const title of NEWS_HEADLINES) {
    assert.equal(isResultHeadline(title), false, `宣传/评论稿不能当赛果：${title}`);
  }
  for (const title of RESULT_HEADLINES) {
    assert.equal(isResultHeadline(title), true, `有比分的赛果标题应识别：${title}`);
  }
});

test('比分证据：16-14 这类交手总比分不算本场赛果', () => {
  assert.equal(hasScoreEvidence('BLG对阵T1交手记录：总交手记录T1以16-14领先'), false);
  assert.equal(hasScoreEvidence('GEN以3比0击败iG'), true);
  assert.equal(hasScoreEvidence('T1三比零KC'), true);
  assert.equal(hasScoreEvidence('16-14'), false);
});

test('队名提取：标题只点一支队时不足以配对局', () => {
  assert.deepEqual(extractLolTeams('调查下马头！TES超话幸灾乐祸').sort(), ['TES']);
  assert.equal(extractLolTeams('GEN以3比0击败iG').length, 2);
});

test('搜索兜底恒为资讯，不触发赛果播报', () => {
  const feed = buildEsportsFeedFromSearch([
    { title: 'GEN 3-0 iG 晋级四强', url: 'https://example.com/a', snippet: '2026-11-08 赛果' }
  ], { query: 'S16 最新赛果' });
  assert.equal(feed.source, 'search');
  assert.equal(feed.summaryKind, 'news');
});

test('播报闸门：官方赛程未结束（status=2）就跳过赛果播报', () => {
  const matches = [{ date: '2026-11-08', teamA: 'GEN', teamB: 'IG', status: '2', scoreA: 1, scoreB: 0 }];
  const gate = shouldSkipResultBroadcast({
    feed: { summaryKind: 'result', summaryTitle: 'GEN 1-0 iG 手感正热', summaryDate: '2026-11-08' },
    matches,
    now: Date.UTC(2026, 10, 8, 4, 0, 0)
  });
  assert.equal(gate.skip, true);
  assert.match(gate.reason, /status=2/);
  assert.deepEqual(gate.teams.sort(), ['GEN', 'IG']);
});

test('播报闸门：status=3 放行并带官方比分，队名不分主客', () => {
  const matches = [{ date: '2026-11-08', teamA: 'T1', teamB: 'BLG', status: '3', scoreA: 1, scoreB: 3 }];
  const gate = shouldSkipResultBroadcast({
    feed: { summaryKind: 'result', summaryTitle: 'BLG 3-1 T1 晋级四强', summaryDate: '2026-11-08' },
    matches,
    now: Date.UTC(2026, 10, 8, 4, 0, 0)
  });
  assert.equal(gate.skip, false);
  assert.equal(gate.officialScore, '1-3');
  assert.equal(gate.match.teamB, 'BLG');
});

test('播报闸门：标题不足两队时不配对局，评论稿不会误触发', () => {
  const matches = [{ date: '2026-11-08', teamA: 'TES', teamB: 'BLG', status: '2' }];
  const gate = shouldSkipResultBroadcast({
    feed: { summaryKind: 'result', summaryTitle: 'TES 0-3 告负，群友热议', summaryDate: '2026-11-08' },
    matches,
    now: Date.UTC(2026, 10, 8, 4, 0, 0)
  });
  assert.equal(gate.skip, false);
  assert.equal(gate.match, null);
  assert.match(gate.reason, /标题未点名双方/);
});

test('赛程展示：官方 MatchStatus 三态、缺 status 才回退时钟', () => {
  const now = Date.UTC(2026, 10, 8, 0, 0, 0);
  const matches = [
    { date: '2026-11-08', time: '01:00', teamA: 'GEN', teamB: 'IG', status: '1' },
    { date: '2026-11-08', time: '02:00', teamA: 'BLG', teamB: 'DK', status: '2', scoreA: 1, scoreB: 0 },
    { date: '2026-11-08', time: '03:00', teamA: 'T1', teamB: 'KC', status: '3', scoreA: 3, scoreB: 1 },
    { date: '2026-11-08', time: '04:00', teamA: 'HLE', teamB: 'FLY' },
    { date: '2026-11-08', time: '12:00', teamA: 'WBG', teamB: 'C9' }
  ];
  const { lines } = buildScheduleLines({ matches, now, days: 0, stageSchedule: [] });
  assert.equal(lines.length, 1);
  const parts = lines[0].split('：')[1].split('；');
  assert.match(parts[0], /01:00 GEN vs IG$/);
  assert.match(parts[1], /进行中$/);
  assert.match(parts[2], /已结束 3-1$/);
  assert.match(parts[3], /已结束$/);
  assert.match(parts[4], /下一场$/);
});

